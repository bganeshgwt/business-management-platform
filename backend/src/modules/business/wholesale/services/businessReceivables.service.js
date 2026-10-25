const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const numbering = require('../../core/services/businessNumbering');
const { decimal, uuid, dateText, recordPayment } = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');

// Shared receivables (retail udhaar and wholesale outstanding are the same
// thing): collections from customers, advances, outstanding balances with
// ageing, and customer statements. See "Shared receivables" in
// docs/BUSINESS_PLATFORM_DATA_MODEL.md.
//
// Money is integer paise throughout. A collection is one receipt; the part of
// it that settles a bill is an ordinary business_payments row (collection_id
// set), so every balance the core already shows stays right; the rest is the
// customer's advance — or, while the customer still has an opening balance
// that no receipt has covered, money against that opening balance.
//
// Cheques: a cheque receipt carries its date, bank and status
// (received → deposited → cleared, or bounced). A bounced cheque no longer
// counts: the bill settlements it made are taken back (kept on the cheque
// row and in the activity log), the receipt stops lowering what the customer
// owes, and the bank's charge, if any, is added to their account.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const METHODS = ['cash', 'upi', 'bank', 'cheque', 'card'];
// A payment's own request key, derived from the request that created it, so
// repeating that request never allocates twice.
const derivedKey = (base, n) => {
  const hex = crypto.createHash('sha256').update(`${base}:${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// A receipt that still counts (not a bounced cheque).
const liveSql = (k) => `NOT EXISTS (SELECT 1 FROM business_collection_cheques q WHERE q.business_id=${k}.business_id AND q.collection_id=${k}.id AND q.status='bounced')`;
// What of a receipt is used up: applied to bills, or handed back to the
// customer (an advance refund, business_collection_refunds).
const collectionAllocatedSql = `(COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0)
  +COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),0))`;

// --- Lists ---------------------------------------------------------------------

// Each receipt with what went against bills, against the opening balance and
// what is a true advance. The opening balance is covered by the
// oldest receipts' unapplied money first, exactly as collecting does it.
repo.addLists({
  collections: {
    sql: `SELECT x.*,
      GREATEST(0, LEAST(x.unapplied, GREATEST(x.opening_balance,0)
        - COALESCE(sum(x.unapplied) OVER (PARTITION BY x.contact_id ORDER BY x.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS opening_applied,
      x.unapplied - GREATEST(0, LEAST(x.unapplied, GREATEST(x.opening_balance,0)
        - COALESCE(sum(x.unapplied) OVER (PARTITION BY x.contact_id ORDER BY x.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) AS unallocated
      FROM (SELECT k.*,l.name AS location_name,u.name AS created_by_name,c.opening_balance,
        ${collectionAllocatedSql} AS allocated,
        CASE WHEN q.status='bounced' THEN 0 ELSE k.amount-${collectionAllocatedSql} END AS unapplied,
        q.cheque_date,q.bank,q.status AS cheque_status,q.bounce_charge,
        wd.salesperson_id,wd.route_id,sp.name AS salesperson_name,r.name AS route_name,
        sr.settlement_id,(sr.settlement_id IS NOT NULL) AS settled
        FROM business_collections k JOIN business_locations l ON l.business_id=k.business_id AND l.id=k.location_id
        JOIN users u ON u.id=k.created_by JOIN business_contacts c ON c.business_id=k.business_id AND c.id=k.contact_id
        LEFT JOIN business_collection_cheques q ON q.business_id=k.business_id AND q.collection_id=k.id
        LEFT JOIN wholesale_collection_details wd ON wd.business_id=k.business_id AND wd.collection_id=k.id
        LEFT JOIN wholesale_salespeople sp ON sp.business_id=wd.business_id AND sp.id=wd.salesperson_id
        LEFT JOIN wholesale_routes r ON r.business_id=wd.business_id AND r.id=wd.route_id
        LEFT JOIN wholesale_settlement_receipts sr ON sr.business_id=k.business_id AND sr.collection_id=k.id
        WHERE k.business_id=$1) x`,
    search: ['collection_no', 'contact_name', 'reference', 'notes', 'bank', 'salesperson_name'], date: 'created_at',
    filters: { contact: 'contact_id', method: 'method', location: 'location_id', salesperson: 'salesperson_id', route: 'route_id', cheque: 'cheque_status', settled: 'settled' },
    order: 'id DESC',
  },
  // Cheques in hand and their state: "due" = received and dated today or earlier.
  cheques: {
    sql: `SELECT q.*,k.collection_no,k.amount,k.created_at,k.contact_name,k.location_id,c.phone AS contact_phone,
      (q.status='received' AND q.cheque_date<=(now() AT TIME ZONE b.timezone)::date) AS due,
      (q.status='received' AND q.cheque_date>(now() AT TIME ZONE b.timezone)::date) AS post_dated,
      sp.name AS salesperson_name
      FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
      JOIN businesses b ON b.id=q.business_id JOIN business_contacts c ON c.business_id=q.business_id AND c.id=q.contact_id
      LEFT JOIN wholesale_collection_details wd ON wd.business_id=k.business_id AND wd.collection_id=k.id
      LEFT JOIN wholesale_salespeople sp ON sp.business_id=wd.business_id AND sp.id=wd.salesperson_id
      WHERE q.business_id=$1`,
    search: ['cheque_no', 'bank', 'contact_name', 'collection_no'], date: 'created_at',
    filters: { status: 'status', contact: 'contact_id', due: 'due', post_dated: 'post_dated', location: 'location_id' }, order: 'cheque_date,collection_id',
  },
});

// --- Open bills and ageing -------------------------------------------------------

// Every open item of every customer (or one): the opening balance on its
// date, each sale's outstanding amount on its date and each bounced
// cheque's bank charge on the day it bounced. The customer's credit
// (unallocated live collections, credit left on bills, an opening balance in
// their favour) is applied to the oldest items first, so what is left open
// is what ages.
const openItemsSql = `WITH b AS (SELECT timezone, (now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1),
 items AS (
  SELECT d.contact_id, d.id AS document_id, d.document_no AS reference, (d.created_at AT TIME ZONE b.timezone)::date AS bill_date, d.due_on,
    d.total
    -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
    -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
    +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS amount
  FROM business_documents d, b WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id IS NOT NULL AND ($2::bigint IS NULL OR d.contact_id=$2)
  UNION ALL
  SELECT c.id, NULL, 'Opening balance', c.opening_balance_on, c.opening_balance_on, c.opening_balance
  FROM business_contacts c WHERE c.business_id=$1 AND c.kind='customer' AND c.opening_balance<>0 AND ($2::bigint IS NULL OR c.id=$2)
  UNION ALL
  SELECT q.contact_id, NULL, 'Cheque bounce charge · ' || k.collection_no, (q.bounced_at AT TIME ZONE b.timezone)::date, (q.bounced_at AT TIME ZONE b.timezone)::date, q.bounce_charge
  FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id CROSS JOIN b
  WHERE q.business_id=$1 AND q.status='bounced' AND q.bounce_charge>0 AND ($2::bigint IS NULL OR q.contact_id=$2)
 ),
 credits AS (
  SELECT contact_id, sum(credit) AS credit FROM (
    SELECT contact_id, -amount AS credit FROM items WHERE amount<0
    UNION ALL
    SELECT k.contact_id, k.amount-${collectionAllocatedSql}
    FROM business_collections k WHERE k.business_id=$1 AND ($2::bigint IS NULL OR k.contact_id=$2) AND ${liveSql('k')}
  ) x GROUP BY contact_id
 ),
 debts AS (
  SELECT items.*, sum(amount) OVER (PARTITION BY contact_id ORDER BY bill_date, document_id NULLS FIRST, reference ROWS UNBOUNDED PRECEDING) AS running
  FROM items WHERE amount>0
 )
 SELECT debts.contact_id, debts.document_id, debts.reference, debts.bill_date::text AS bill_date, debts.due_on::text AS due_on, debts.amount,
   GREATEST(0, LEAST(debts.amount, debts.running-COALESCE(cr.credit,0))) AS open_amount,
   (b.today-debts.bill_date) AS age_days, (debts.due_on IS NOT NULL AND debts.due_on<b.today) AS overdue,
   CASE WHEN debts.due_on IS NOT NULL AND debts.due_on<b.today THEN b.today-debts.due_on ELSE 0 END AS days_overdue
 FROM debts CROSS JOIN b LEFT JOIN credits cr ON cr.contact_id=debts.contact_id`;

// Per customer: the balance and the open amount in each age bucket, plus
// cheques not yet cleared and the last reminder / promise.
// The group edges are the business's ageing_days (30, 60, 90 by default): the
// columns keep their names, days_0_30 being the first group and so on.
const ageingSql = `WITH oi AS (${openItemsSql}),
 edges AS (SELECT COALESCE((SELECT ageing_days FROM business_settings WHERE business_id=$1), '{30,60,90}'::smallint[]) AS d),
 per AS (
  SELECT contact_id,
    sum(open_amount) AS outstanding,
    sum(open_amount) FILTER (WHERE age_days<=edges.d[1]) AS days_0_30,
    sum(open_amount) FILTER (WHERE age_days>edges.d[1] AND age_days<=edges.d[2]) AS days_31_60,
    sum(open_amount) FILTER (WHERE age_days>edges.d[2] AND age_days<=edges.d[3]) AS days_61_90,
    sum(open_amount) FILTER (WHERE age_days>edges.d[3]) AS days_over_90,
    sum(open_amount) FILTER (WHERE overdue) AS overdue,
    max(days_overdue) FILTER (WHERE open_amount>0) AS most_days_overdue,
    count(*) FILTER (WHERE open_amount>0)::int AS open_bills,
    min(bill_date) FILTER (WHERE open_amount>0) AS oldest_bill
  FROM oi CROSS JOIN edges GROUP BY contact_id
 )
 SELECT c.id AS contact_id, c.name, c.phone, c.gstin, c.credit_limit, c.credit_days,
   ${repo.contactBalanceSql('c')} AS balance,
   COALESCE(per.outstanding,0) AS outstanding, COALESCE(per.days_0_30,0) AS days_0_30, COALESCE(per.days_31_60,0) AS days_31_60,
   COALESCE(per.days_61_90,0) AS days_61_90, COALESCE(per.days_over_90,0) AS days_over_90, COALESCE(per.overdue,0) AS overdue,
   COALESCE(per.most_days_overdue,0) AS most_days_overdue,
   COALESCE(per.open_bills,0) AS open_bills, per.oldest_bill,
   (SELECT max(k.created_at) FROM business_collections k WHERE k.business_id=c.business_id AND k.contact_id=c.id AND ${liveSql('k')}) AS last_collection_at,
   COALESCE((SELECT sum(k.amount) FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
     WHERE q.business_id=c.business_id AND q.contact_id=c.id AND q.status IN ('received','deposited')),0) AS uncleared_cheques,
   COALESCE((SELECT sum(k.amount) FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
     JOIN businesses bz ON bz.id=q.business_id
     WHERE q.business_id=c.business_id AND q.contact_id=c.id AND q.status='received' AND q.cheque_date>(now() AT TIME ZONE bz.timezone)::date),0) AS post_dated_cheques,
   (SELECT count(*)::int FROM business_collection_cheques q WHERE q.business_id=c.business_id AND q.contact_id=c.id AND q.status='bounced') AS bounced_cheques,
   (SELECT max(m.created_at) FROM retail_credit_reminders m WHERE m.business_id=c.business_id AND m.contact_id=c.id) AS last_reminder_at,
   (SELECT m.promised_on::text FROM retail_credit_reminders m WHERE m.business_id=c.business_id AND m.contact_id=c.id AND m.promised_on IS NOT NULL ORDER BY m.id DESC LIMIT 1) AS promised_on
 FROM business_contacts c LEFT JOIN per ON per.contact_id=c.id
 WHERE c.business_id=$1 AND c.kind='customer' AND ($2::bigint IS NULL OR c.id=$2)`;

const AGEING_SORTS = { outstanding: 'outstanding DESC, name', overdue: 'overdue DESC, outstanding DESC, name', name: 'name', promised: 'promised_on NULLS LAST, outstanding DESC' };

// The outstanding list: customers who owe something (or hold an advance with
// `include=all`), paged, with the totals of every matching row.
// options.contactIds: limit to these customers (a type module's filter, e.g. one route).
async function outstanding(business, query, { contactIds = null } = {}) {
  await access.require(business, 'receivables.view');
  const limit = query.limit === undefined ? 25 : id(query.limit, 'Page size');
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('Invalid pagination');
  const search = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const show = v.optionalEnum(query.show, 'Show', ['owing', 'overdue', 'advance', 'all'], 'owing');
  const order = AGEING_SORTS[v.optionalEnum(query.sort, 'Sort', Object.keys(AGEING_SORTS), 'outstanding')];
  const where = { owing: 'balance>0', overdue: 'overdue>0', advance: 'balance<0', all: 'TRUE' }[show];
  const extra = contactIds;
  const row = await repo.one(repo.pool, `WITH a AS (${ageingSql}), m AS (SELECT * FROM a WHERE ${where}
      AND ($3::text IS NULL OR concat_ws(' ',name,phone,gstin) ILIKE $3) AND ($6::bigint[] IS NULL OR contact_id=ANY($6)))
    SELECT (SELECT count(*)::int FROM m) AS total,
      (SELECT json_build_object('balance',COALESCE(sum(balance),0),'outstanding',COALESCE(sum(outstanding),0),'days_0_30',COALESCE(sum(days_0_30),0),
        'days_31_60',COALESCE(sum(days_31_60),0),'days_61_90',COALESCE(sum(days_61_90),0),'days_over_90',COALESCE(sum(days_over_90),0),
        'overdue',COALESCE(sum(overdue),0),'uncleared_cheques',COALESCE(sum(uncleared_cheques),0),'post_dated_cheques',COALESCE(sum(post_dated_cheques),0)) FROM m) AS totals,
      COALESCE((SELECT json_agg(p) FROM (SELECT * FROM m ORDER BY ${order} LIMIT $4 OFFSET $5) p),'[]') AS items`,
  [business.id, null, search, limit, offset, extra]);
  return row;
}

// One customer: balance, buckets, each open item with its age, advances,
// cheques not yet cleared and the reminders sent.
async function customerAccount(business, contactId) {
  await access.require(business, 'receivables.view');
  const contact = await repo.one(repo.pool, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  const [summary, items, advances, cheques, reminders] = await Promise.all([
    repo.one(repo.pool, ageingSql, [business.id, contact.id]),
    repo.all(repo.pool, `${openItemsSql} ORDER BY bill_date, document_id NULLS FIRST, reference`, [business.id, contact.id]),
    repo.all(repo.pool, `SELECT k.id,k.collection_no,k.created_at,k.amount,k.amount-${collectionAllocatedSql} AS unallocated
      FROM business_collections k WHERE k.business_id=$1 AND k.contact_id=$2 AND k.amount>${collectionAllocatedSql} AND ${liveSql('k')} ORDER BY k.id`, [business.id, contact.id]),
    repo.all(repo.pool, `SELECT q.collection_id,q.cheque_no,q.cheque_date,q.bank,q.status,q.bounce_charge,q.bounced_at,k.collection_no,k.amount
      FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
      WHERE q.business_id=$1 AND q.contact_id=$2 AND (q.status IN ('received','deposited') OR q.bounced_at > now() - interval '180 days') ORDER BY q.cheque_date`, [business.id, contact.id]),
    repo.all(repo.pool, `SELECT m.id,m.channel,m.balance,m.promised_on,m.note,m.created_at,u.name AS created_by_name FROM retail_credit_reminders m
      JOIN users u ON u.id=m.created_by WHERE m.business_id=$1 AND m.contact_id=$2 ORDER BY m.id DESC LIMIT 10`, [business.id, contact.id]),
  ]);
  return { contact, summary, items: items.filter((i) => paise(i.open_amount) > 0), advances, cheques, reminders };
}

// Sales of a customer that still have something to collect, oldest due first:
// the order automatic allocation uses.
const openBills = (db, businessId, contactId) => repo.all(db, `SELECT d.id,d.document_no,d.created_at,d.due_on,d.total,
   d.total-COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
   -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
   +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS outstanding
  FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id=$2
  ORDER BY d.due_on NULLS FIRST, d.created_at, d.id`, [businessId, contactId]);

async function customerOpenBills(business, contactId) {
  await access.require(business, 'receivables.view');
  const bills = await openBills(repo.pool, business.id, id(contactId, 'Customer'));
  return bills.filter((b) => paise(b.outstanding) > 0);
}

// --- Collections -------------------------------------------------------------------

// Settles bills from a collection inside the caller's transaction. plan:
// [{ documentId, amount }] or 'auto' (oldest due first). Returns the payments.
async function allocate(db, business, user, collection, available, plan, keyBase, startAt = 0) {
  const made = [];
  let left = available;
  let n = startAt;
  if (plan === 'auto') {
    for (const bill of await openBills(db, business.id, collection.contact_id)) {
      if (left <= 0) break;
      const due = paise(bill.outstanding);
      if (due <= 0) continue;
      const take = Math.min(due, left);
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, bill.id]);
      made.push(await recordPayment(db, business, user, doc, { amount: rupees(take), method: collection.method, reference: collection.collection_no, key: derivedKey(keyBase, n), collectionId: collection.id }));
      n += 1; left -= take;
    }
    return made;
  }
  for (const entry of plan) {
    const doc = await repo.one(db, "SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 AND kind='sale' FOR UPDATE", [business.id, entry.documentId]);
    if (!doc || doc.contact_id !== collection.contact_id) fail('That bill is not one of this customer\'s sales', 404);
    if (entry.amount > left) fail('The bills chosen add up to more than the amount collected');
    made.push(await recordPayment(db, business, user, doc, { amount: rupees(entry.amount), method: collection.method, reference: collection.collection_no, key: derivedKey(keyBase, n), collectionId: collection.id }));
    n += 1; left -= entry.amount;
  }
  return made;
}

// A customer's collected money not yet applied to any bill (paise).
async function freeCredit(db, businessId, contactId) {
  const row = await repo.one(db, `SELECT COALESCE(sum(k.amount-${collectionAllocatedSql}),0) AS free FROM business_collections k
    WHERE k.business_id=$1 AND k.contact_id=$2 AND ${liveSql('k')}`, [businessId, contactId]);
  return paise(row.free);
}

// A cheque's own details: its date (post-dated up to 180 days ahead,
// or up to 90 days old) and the bank it is drawn on.
function readCheque(body, today) {
  const chequeDate = body.chequeDate === undefined || body.chequeDate === null || body.chequeDate === '' ? today : dateText(body.chequeDate, 'Cheque date');
  const days = (Date.parse(chequeDate) - Date.parse(today)) / 86400000;
  if (days > 180) fail('A post-dated cheque can be at most 180 days ahead');
  if (days < -90) fail('That cheque is more than three months old; a bank will not take it');
  return { chequeDate, bank: v.optionalString(body.bank, 'Bank', 100) };
}

// body: { locationId, contactId, amount, method, reference?, notes?, requestKey,
//   chequeDate?, bank? (cheques),
//   allocations?: [{ documentId, amount }] (omit for automatic, [] to keep it all as an advance) }
// extend(db, collection): a type module's own extra rows, same transaction.
async function createCollection(business, user, body, { extend } = {}) {
  await access.require(business, 'receivables.create');
  const requestKey = uuid(body.requestKey);
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const amount = paise(decimal(body.amount, 'Amount collected', 2, 0.01));
  // `methodId`: one of the business's own payment methods (its kind is checked below).
  const choice = paymentMethods.readChoice(body, 'Paid by', METHODS);
  const reference = v.optionalString(body.reference, 'Reference', 100);
  if (choice.method === 'cheque' && !reference) fail('Enter the cheque number as the reference');
  if (choice.method && choice.method !== 'cheque' && (body.chequeDate || body.bank)) fail('A cheque date and bank go with a cheque');
  let plan = 'auto';
  if (body.allocations !== undefined && body.allocations !== null) {
    const list = v.requiredArray(body.allocations, 'Bills to settle');
    if (list.length > 200) fail('Settle at most 200 bills at once');
    plan = list.map((entry) => ({ documentId: id(entry?.documentId, 'Bill'), amount: paise(decimal(entry?.amount, 'Amount for a bill', 2, 0.01)) }));
    if (new Set(plan.map((p) => p.documentId)).size !== plan.length) fail('A bill may only appear once');
    if (plan.reduce((s, p) => s + p.amount, 0) > amount) fail('The bills chosen add up to more than the amount collected');
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM business_collections WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const { method, methodName } = await paymentMethods.settle(db, business.id, choice, 'Paid by', METHODS);
    if (method === 'cheque' && !reference) fail('Enter the cheque number as the reference');
    if (method !== 'cheque' && (body.chequeDate || body.bank)) fail('A cheque date and bank go with a cheque');
    const today = (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
    const cheque = method === 'cheque' ? readCheque(body, today) : null;
    const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' FOR UPDATE", [business.id, id(body.contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    // Oldest first: an opening balance not yet covered by earlier advances is
    // older than any bill, so automatic allocation leaves that much on account
    // against it before settling bills.
    const free = await freeCredit(db, business.id, contact.id);
    const reserve = plan === 'auto' ? Math.min(amount, Math.max(0, paise(contact.opening_balance) - free)) : 0;
    const number = await numbering.nextNumber(db, business.id, location.id, 'collection', user.id);
    const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, rupees(amount), method, reference,
      v.optionalString(body.notes, 'Notes', 500), requestKey, hash, user.id, methodName]);
    if (cheque) {
      await db.query(`INSERT INTO business_collection_cheques(business_id,collection_id,contact_id,cheque_no,cheque_date,bank)
        VALUES($1,$2,$3,$4,$5,$6)`, [business.id, collection.id, contact.id, reference, cheque.chequeDate, cheque.bank]);
    }
    const payments = await allocate(db, business, user, collection, amount - reserve, plan, requestKey);
    if (extend) await extend(db, collection);
    const allocated = payments.reduce((s, p) => s + paise(p.amount), 0);
    const openingApplied = Math.min(reserve, amount - allocated);
    await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { collectionNo: collection.collection_no, amount: collection.amount, allocated: rupees(allocated),
      ...(cheque ? { chequeNo: reference, chequeDate: cheque.chequeDate } : {}) });
    await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
      collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method,
      allocations: payments.map((p) => ({ documentId: p.document_id, amount: p.amount })), unallocated: rupees(amount - allocated),
    });
    return { ...collection, allocated: rupees(allocated), opening_applied: rupees(openingApplied), unallocated: rupees(amount - allocated - openingApplied),
      ...(cheque ? { cheque_date: cheque.chequeDate, bank: cheque.bank, cheque_status: 'received' } : {}) };
  });
}

// A customer's unallocated collections (oldest first) applied to their open
// bills (oldest due first). Repeating the same request key does nothing more.
async function applyAdvance(business, user, contactId, body) {
  await access.require(business, 'receivables.create');
  const requestKey = uuid(body.requestKey);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' FOR UPDATE", [business.id, id(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    const done = await repo.one(db, 'SELECT id FROM business_payments WHERE business_id=$1 AND request_key=$2', [business.id, derivedKey(requestKey, 0)]);
    if (done) return { applied: '0.00', repeated: true };
    let receipts = await repo.all(db, `SELECT k.*,k.amount-${collectionAllocatedSql} AS free FROM business_collections k
      WHERE k.business_id=$1 AND k.contact_id=$2 AND k.amount>${collectionAllocatedSql} AND ${liveSql('k')} ORDER BY k.id`, [business.id, contact.id]);
    // A jeweller's gold scheme instalments are held for the jewellery bill that redeems the scheme.
    if (business.modules.includes('jewellery')) {
      const held = await require('../../jewellery/services/jewellerySchemes.service').heldReceipts(db, business, contact.id);
      receipts = receipts.filter((receipt) => !held.has(Number(receipt.id)));
    }
    // A rental booking's advances and deposits pay its own bill, and what is left goes back from the booking.
    if (business.modules.includes('rentals')) {
      const held = await require('../../rentals/services/rentalsBookings.service').heldReceipts(db, business, contact.id);
      receipts = receipts.filter((receipt) => !held.has(Number(receipt.id)));
    }
    let n = 0, applied = 0;
    const payments = [];
    // The part that covers the opening balance stays where it is (on the oldest receipts).
    let reserve = Math.max(0, paise(contact.opening_balance));
    for (const receipt of receipts) {
      const kept = Math.min(reserve, paise(receipt.free));
      reserve -= kept;
      if (paise(receipt.free) - kept <= 0) continue;
      const made = await allocate(db, business, user, receipt, paise(receipt.free) - kept, 'auto', requestKey, n);
      n += made.length;
      applied += made.reduce((s, p) => s + paise(p.amount), 0);
      payments.push(...made);
    }
    if (!payments.length) fail('There is no advance to apply, or no open bill to apply it to', 409);
    await repo.audit(db, business.id, user.id, 'collection.applied', contact.id, { applied: rupees(applied), payments: payments.length });
    await repo.event(db, business.id, user.id, 'collection.applied', 'contact', contact.id, {
      applied: rupees(applied), allocations: payments.map((p) => ({ documentId: p.document_id, collectionId: p.collection_id, amount: p.amount })),
    });
    return { applied: rupees(applied), payments: payments.length };
  });
}

// One receipt: what it settled, what went against the opening balance, what
// is a true advance, its cheque and who collected it.
async function collectionDetail(business, collectionId) {
  await access.require(business, 'receivables.view');
  const collection = await repo.one(repo.pool, `SELECT k.*,l.name AS location_name,u.name AS created_by_name,c.phone AS contact_phone,c.gstin AS contact_gstin,
    c.opening_balance,c.address AS contact_address,sp.name AS salesperson_name,r.name AS route_name,sr.settlement_id
    FROM business_collections k JOIN business_locations l ON l.business_id=k.business_id AND l.id=k.location_id
    JOIN users u ON u.id=k.created_by JOIN business_contacts c ON c.business_id=k.business_id AND c.id=k.contact_id
    LEFT JOIN wholesale_collection_details wd ON wd.business_id=k.business_id AND wd.collection_id=k.id
    LEFT JOIN wholesale_salespeople sp ON sp.business_id=wd.business_id AND sp.id=wd.salesperson_id
    LEFT JOIN wholesale_routes r ON r.business_id=wd.business_id AND r.id=wd.route_id
    LEFT JOIN wholesale_settlement_receipts sr ON sr.business_id=k.business_id AND sr.collection_id=k.id
    WHERE k.business_id=$1 AND k.id=$2`, [business.id, id(collectionId)]);
  if (!collection) fail('Collection not found', 404);
  const [allocations, seller, cheque, earlier] = await Promise.all([
    repo.all(repo.pool, `SELECT p.id,p.amount,p.created_at,d.id AS document_id,d.document_no,d.total,d.created_at AS bill_at
      FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
      WHERE p.business_id=$1 AND p.collection_id=$2 ORDER BY p.id`, [business.id, collection.id]),
    repo.one(repo.pool, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]),
    repo.one(repo.pool, `SELECT q.*,ud.name AS deposited_by_name,uc.name AS cleared_by_name,ub.name AS bounced_by_name FROM business_collection_cheques q
      LEFT JOIN users ud ON ud.id=q.deposited_by LEFT JOIN users uc ON uc.id=q.cleared_by LEFT JOIN users ub ON ub.id=q.bounced_by
      WHERE q.business_id=$1 AND q.collection_id=$2`, [business.id, collection.id]),
    // Unapplied money of this customer's earlier live receipts (they cover the opening balance first).
    repo.one(repo.pool, `SELECT COALESCE(sum(k.amount-${collectionAllocatedSql}),0) AS free FROM business_collections k
      WHERE k.business_id=$1 AND k.contact_id=$2 AND k.id<$3 AND ${liveSql('k')}`, [business.id, collection.contact_id, collection.id]),
  ]);
  const allocated = allocations.reduce((s, a) => s + paise(a.amount), 0);
  const bounced = cheque?.status === 'bounced';
  const unapplied = bounced ? 0 : paise(collection.amount) - allocated;
  const openingApplied = Math.max(0, Math.min(unapplied, Math.max(0, paise(collection.opening_balance)) - paise(earlier.free)));
  return { ...collection, allocations, allocated: rupees(allocated), opening_applied: rupees(openingApplied), unallocated: rupees(unapplied - openingApplied),
    cheque: cheque || null, seller };
}

// --- Cheques ---------------------------------------------------------------------------

// The bounce rules of a business: the bank charge put on
// the customer's account (default Rs 500, editable on each bounce) and the
// credit hold after N bounces in a window (default 2 in 90 days; NULL = never).
async function bounceRules(db, businessId) {
  const row = await repo.one(db, 'SELECT bounce_charge,bounce_hold_count,bounce_hold_days FROM wholesale_settings WHERE business_id=$1', [businessId]);
  return row ? { charge: row.bounce_charge, holdCount: row.bounce_hold_count, holdDays: row.bounce_hold_days } : { charge: '500.00', holdCount: 2, holdDays: 90 };
}
// Bounced cheques of a customer in the window ending now.
async function recentBounces(db, businessId, contactId, days) {
  const row = await repo.one(db, `SELECT count(*)::int AS bounces, max(bounced_at) AS last_at FROM business_collection_cheques
    WHERE business_id=$1 AND contact_id=$2 AND status='bounced' AND bounced_at > now() - make_interval(days => $3::int)`, [businessId, contactId, days]);
  return { bounces: row.bounces, lastAt: row.last_at };
}

// body: { action: 'deposit' | 'clear' | 'bounce', depositedInto?, reason?, charge? }
// Deposit and clear need receivables.create; a bounce needs credit control
// (receivables.approve): the receipt stops counting, exactly the bills it
// settled open again, the bank charge (the business's setting unless one is
// typed) goes on the customer's account, and a customer who reaches the
// bounce limit goes on credit hold for new orders.
async function chequeAction(business, user, collectionId, body) {
  const action = v.requiredEnum(body.action, 'Action', ['deposit', 'clear', 'bounce']);
  await access.require(business, action === 'bounce' ? 'receivables.approve' : 'receivables.create');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const cheque = await repo.one(db, `SELECT q.*,k.collection_no,k.amount FROM business_collection_cheques q
      JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
      WHERE q.business_id=$1 AND q.collection_id=$2 FOR UPDATE OF q`, [business.id, id(collectionId, 'Receipt')]);
    if (!cheque) fail('That receipt is not a cheque on file', 404);
    if (cheque.status === 'bounced' || cheque.status === 'cleared') fail(`This cheque is already ${cheque.status}`, 409);
    const today = (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
    let saved;
    if (action === 'deposit') {
      if (cheque.status !== 'received') fail('This cheque was already deposited', 409);
      if (cheque.cheque_date > today) fail(`This cheque is dated ${cheque.cheque_date}; it cannot be deposited before then`, 409);
      saved = await repo.one(db, `UPDATE business_collection_cheques SET status='deposited',deposited_at=now(),deposited_by=$3,deposited_into=$4
        WHERE business_id=$1 AND collection_id=$2 RETURNING *`, [business.id, cheque.collection_id, user.id, v.optionalString(body.depositedInto, 'Deposited into', 100)]);
      await repo.audit(db, business.id, user.id, 'cheque.deposited', cheque.collection_id, { collectionNo: cheque.collection_no, chequeNo: cheque.cheque_no, amount: cheque.amount });
    } else if (action === 'clear') {
      if (cheque.cheque_date > today) fail(`This cheque is dated ${cheque.cheque_date}; it cannot have cleared yet`, 409);
      saved = await repo.one(db, `UPDATE business_collection_cheques SET status='cleared',cleared_at=now(),cleared_by=$3
        WHERE business_id=$1 AND collection_id=$2 RETURNING *`, [business.id, cheque.collection_id, user.id]);
      await repo.audit(db, business.id, user.id, 'cheque.cleared', cheque.collection_id, { collectionNo: cheque.collection_no, chequeNo: cheque.cheque_no, amount: cheque.amount });
    } else {
      const reason = v.requiredString(body.reason, 'Why it bounced', 300);
      const rules = await bounceRules(db, business.id);
      const charge = body.charge === undefined || body.charge === null || body.charge === '' ? paise(rules.charge) : paise(decimal(body.charge, 'Bounce charge', 2, 0, 100000));
      await db.query('SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, cheque.contact_id]);
      // The bill settlements the cheque made are taken back (kept on the cheque row and in the log).
      const payments = await repo.all(db, `SELECT p.id,p.document_id,p.amount,p.created_at,d.document_no FROM business_payments p
        JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
        WHERE p.business_id=$1 AND p.collection_id=$2 ORDER BY p.id FOR UPDATE OF p`, [business.id, cheque.collection_id]);
      for (const payment of payments) {
        await db.query('SELECT id FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, payment.document_id]);
      }
      if (payments.length) await db.query('DELETE FROM business_payments WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, payments.map((p) => p.id)]);
      const reversed = payments.map((p) => ({ paymentId: p.id, documentId: p.document_id, documentNo: p.document_no, amount: p.amount, at: p.created_at }));
      saved = await repo.one(db, `UPDATE business_collection_cheques SET status='bounced',bounced_at=now(),bounced_by=$3,bounce_reason=$4,bounce_charge=$5,reversed_allocations=$6
        WHERE business_id=$1 AND collection_id=$2 RETURNING *`, [business.id, cheque.collection_id, user.id, reason, rupees(charge), JSON.stringify(reversed)]);
      await repo.audit(db, business.id, user.id, 'cheque.bounced', cheque.collection_id, {
        collectionNo: cheque.collection_no, chequeNo: cheque.cheque_no, amount: cheque.amount, reason, charge: rupees(charge), reversed,
      });
      await repo.event(db, business.id, user.id, 'collection.reversed', 'collection', cheque.collection_id, {
        collectionNo: cheque.collection_no, contactId: cheque.contact_id, amount: cheque.amount, reason, charge: rupees(charge), reversed,
      });
      // The bounce that reaches the limit puts the customer on credit hold.
      if (rules.holdCount) {
        const recent = await recentBounces(db, business.id, cheque.contact_id, rules.holdDays);
        if (recent.bounces === rules.holdCount) {
          const details = { contactId: cheque.contact_id, bounces: recent.bounces, days: rules.holdDays, chequeNo: cheque.cheque_no, collectionNo: cheque.collection_no };
          await repo.audit(db, business.id, user.id, 'customer.credit_hold_bounces', cheque.contact_id, details);
          await repo.event(db, business.id, user.id, 'customer.credit_hold', 'contact', cheque.contact_id, { ...details, reason: 'bounced_cheques' });
        }
        saved.credit_hold = recent.bounces >= rules.holdCount ? { bounces: recent.bounces, days: rules.holdDays, limit: rules.holdCount } : null;
      }
    }
    return { ...saved, collection_no: cheque.collection_no, amount: cheque.amount };
  });
}

// --- Follow-up: reminders and promises ----------------------------------------------

// The same reminder book the udhaar screen keeps (retail_credit_reminders):
// a call, a WhatsApp, a visit, with the date they promised to pay.
async function addFollowUp(business, user, contactId, body) {
  await access.require(business, 'receivables.create');
  const channel = v.requiredEnum(body.channel, 'How', ['whatsapp', 'sms', 'call', 'visit', 'other']);
  const promisedOn = body.promisedOn ? dateText(body.promisedOn, 'Promised date') : null;
  const amount = body.promisedAmount === undefined || body.promisedAmount === null || body.promisedAmount === '' ? null : decimal(body.promisedAmount, 'Promised amount', 2, 0.01);
  const note = [amount !== null && `Promised ${rupees(paise(amount))}`, v.optionalString(body.note, 'Note', 250)].filter(Boolean).join(' · ') || null;
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, `SELECT c.id,c.name,${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2 AND c.kind='customer'`,
      [business.id, id(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    const today = (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
    if (promisedOn && promisedOn < today) fail('The promised date is already past');
    const row = await repo.one(db, `INSERT INTO retail_credit_reminders(business_id,contact_id,channel,balance,promised_on,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [business.id, contact.id, channel, contact.balance, promisedOn, note, user.id]);
    await repo.audit(db, business.id, user.id, 'receivables.follow_up', contact.id, { channel, promisedOn, note });
    return row;
  });
}

// The business's own name for the method where one was recorded (PhonePe), else the kind.
const methodSql = (column) => `COALESCE(${column}_name, CASE ${column} WHEN 'upi' THEN 'UPI' WHEN 'bank' THEN 'bank transfer' ELSE ${column} END)`;

// --- Statement -------------------------------------------------------------------------

// Every money event of one customer in date order, with the balance brought
// forward and a running balance. Payments that came from a collection are
// shown once, as the collection; a bounced cheque shows as the receipt and,
// on the day it bounced, the cheque returned (and any bank charge).
async function statement(business, contactId, query) {
  await access.require(business, 'receivables.view');
  const from = dateText(query.from, 'Statement start date'), to = dateText(query.to, 'Statement end date');
  if (to < from) fail('The end date is before the start date');
  const contact = await repo.one(repo.pool, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  const entries = await repo.all(repo.pool, `WITH b AS (SELECT timezone FROM businesses WHERE id=$1), e AS (
      SELECT d.created_at AS at, 'sale' AS kind, d.document_no AS reference, d.total AS debit, 0::numeric AS credit, d.id AS document_id
        FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id=$2
      UNION ALL SELECT r.created_at, 'return', COALESCE(r.return_no, d.document_no), 0, r.total, d.id
        FROM business_returns r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id WHERE r.business_id=$1 AND d.kind='sale' AND d.contact_id=$2
      UNION ALL SELECT p.created_at, 'payment', d.document_no || ' · ' || ${methodSql('p.method')}, 0, p.amount, d.id
        FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
        WHERE p.business_id=$1 AND d.kind='sale' AND d.contact_id=$2 AND p.collection_id IS NULL
      UNION ALL SELECT k.created_at, 'collection', k.collection_no || ' · ' || ${methodSql('k.method')} || COALESCE(' ' || k.reference, ''), 0, k.amount, NULL
        FROM business_collections k WHERE k.business_id=$1 AND k.contact_id=$2
      UNION ALL SELECT q.bounced_at, 'bounce', 'Cheque ' || q.cheque_no || ' returned unpaid · ' || k.collection_no, k.amount, 0, NULL
        FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
        WHERE q.business_id=$1 AND q.contact_id=$2 AND q.status='bounced'
      UNION ALL SELECT q.bounced_at + interval '1 millisecond', 'bounce_charge', 'Bank charge for cheque ' || q.cheque_no, q.bounce_charge, 0, NULL
        FROM business_collection_cheques q WHERE q.business_id=$1 AND q.contact_id=$2 AND q.status='bounced' AND q.bounce_charge>0
      UNION ALL SELECT f.created_at, 'advance_refund', k.collection_no || ' · advance refunded · ' || ${methodSql('f.method')}, f.amount, 0, NULL
        FROM business_collection_refunds f JOIN business_collections k ON k.business_id=f.business_id AND k.id=f.collection_id WHERE f.business_id=$1 AND f.contact_id=$2
      UNION ALL SELECT f.created_at, 'refund', d.document_no || ' · ' || ${methodSql('f.method')}, f.amount, 0, d.id
        FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id WHERE f.business_id=$1 AND d.kind='sale' AND d.contact_id=$2
    ) SELECT e.*, (e.at AT TIME ZONE b.timezone)::date::text AS day FROM e, b ORDER BY e.at, e.kind`, [business.id, contact.id]);
  let opening = paise(contact.opening_balance || 0);
  const openingOn = contact.opening_balance_on;
  const rows = [];
  if (openingOn && openingOn >= from && openingOn <= to && opening !== 0) {
    rows.push({ day: openingOn, kind: 'opening', reference: 'Opening balance', debit: opening > 0 ? rupees(opening) : '0.00', credit: opening < 0 ? rupees(-opening) : '0.00' });
    opening = 0;
  } else if (openingOn && openingOn > to) opening = 0;
  for (const e of entries) {
    if (e.day < from) opening += paise(e.debit) - paise(e.credit);
    else if (e.day <= to) rows.push({ day: e.day, at: e.at, kind: e.kind, reference: e.reference, debit: e.debit, credit: e.credit, document_id: e.document_id });
  }
  if (rows.length > 5000) fail('Choose a shorter period: more than 5,000 entries');
  let running = opening, debit = 0, credit = 0;
  for (const row of rows) {
    debit += paise(row.debit); credit += paise(row.credit);
    running += paise(row.debit) - paise(row.credit);
    row.balance = rupees(running);
  }
  const seller = await repo.one(repo.pool, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  return { contact, from, to, opening: rupees(opening), debit: rupees(debit), credit: rupees(credit), closing: rupees(running), entries: rows, seller };
}

module.exports = {
  outstanding, customerAccount, customerOpenBills, createCollection, applyAdvance, collectionDetail, statement, chequeAction, addFollowUp,
  ageingSql, openItemsSql, liveSql, recentBounces,
};
