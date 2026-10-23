const crypto = require('node:crypto');
const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('./businessAccess.service');
const numbering = require('./businessNumbering');
const { decimal, uuid, dateText, recordPayment } = require('./business.service');
const paymentMethods = require('./businessPaymentMethods.service');

// What the business owes its suppliers: the payables list
// with what is overdue by each supplier's credit days, one supplier's open
// receipts, paying a supplier against several receipts at once (oldest due
// first, or the receipts chosen; any extra stays as an advance with the
// supplier), and the supplier statement. The mirror of a customer
// collection (businessReceivables.service.js): a payment is one voucher; the
// part that settles a receipt is an ordinary business_payments row
// (supplier_payment_id set), so every balance the core shows stays right.
// Money is integer paise throughout.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const METHODS = ['cash', 'upi', 'bank', 'cheque', 'card'];
// A settlement's own request key, derived from the request that made it.
const derivedKey = (base, n) => {
  const hex = crypto.createHash('sha256').update(`${base}:supplier:${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const allocatedSql = 'COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.supplier_payment_id=k.id),0)';
const outstandingSql = `d.total
    -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
    -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
    +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0)`;

// Every open item of every supplier (or one): the opening balance and each
// receipt still to pay. Advances and credit left on receipts are applied to
// the oldest first, so what is left open is what ages.
const openItemsSql = `WITH b AS (SELECT timezone, (now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1),
 items AS (
  SELECT d.contact_id, d.id AS document_id, d.document_no AS reference, d.supplier_bill_no, (d.created_at AT TIME ZONE b.timezone)::date AS bill_date, d.due_on,
    ${outstandingSql} AS amount
  FROM business_documents d, b WHERE d.business_id=$1 AND d.kind='purchase' AND ($2::bigint IS NULL OR d.contact_id=$2)
  UNION ALL
  SELECT c.id, NULL, 'Opening balance', NULL, c.opening_balance_on, c.opening_balance_on, c.opening_balance
  FROM business_contacts c WHERE c.business_id=$1 AND c.kind='supplier' AND c.opening_balance<>0 AND ($2::bigint IS NULL OR c.id=$2)
 ),
 credits AS (
  SELECT contact_id, sum(credit) AS credit FROM (
    SELECT contact_id, -amount AS credit FROM items WHERE amount<0
    UNION ALL SELECT k.contact_id, k.amount-${allocatedSql} FROM business_supplier_payments k WHERE k.business_id=$1 AND ($2::bigint IS NULL OR k.contact_id=$2)
  ) x GROUP BY contact_id
 ),
 debts AS (
  SELECT items.*, sum(amount) OVER (PARTITION BY contact_id ORDER BY bill_date, document_id NULLS FIRST ROWS UNBOUNDED PRECEDING) AS running
  FROM items WHERE amount>0
 )
 SELECT debts.contact_id, debts.document_id, debts.reference, debts.supplier_bill_no, debts.bill_date::text AS bill_date, debts.due_on::text AS due_on, debts.amount,
   GREATEST(0, LEAST(debts.amount, debts.running-COALESCE(cr.credit,0))) AS open_amount,
   (b.today-debts.bill_date) AS age_days, (debts.due_on IS NOT NULL AND debts.due_on<b.today) AS overdue
 FROM debts CROSS JOIN b LEFT JOIN credits cr ON cr.contact_id=debts.contact_id`;

const perSupplierSql = `WITH oi AS (${openItemsSql}),
 per AS (SELECT contact_id, sum(open_amount) AS outstanding, sum(open_amount) FILTER (WHERE overdue) AS overdue,
   count(*) FILTER (WHERE open_amount>0)::int AS open_bills, min(bill_date) FILTER (WHERE open_amount>0) AS oldest_bill,
   min(due_on) FILTER (WHERE open_amount>0) AS next_due FROM oi GROUP BY contact_id)
 SELECT c.id AS contact_id, c.name, c.phone, c.gstin, c.credit_days, ${repo.contactBalanceSql('c')} AS balance,
   COALESCE(per.outstanding,0) AS outstanding, COALESCE(per.overdue,0) AS overdue, COALESCE(per.open_bills,0) AS open_bills,
   per.oldest_bill::text AS oldest_bill, per.next_due::text AS next_due,
   (SELECT max(k.created_at) FROM business_supplier_payments k WHERE k.business_id=c.business_id AND k.contact_id=c.id) AS last_paid_at
 FROM business_contacts c LEFT JOIN per ON per.contact_id=c.id
 WHERE c.business_id=$1 AND c.kind='supplier' AND ($2::bigint IS NULL OR c.id=$2)`;

const SORTS = { outstanding: 'outstanding DESC, name', overdue: 'overdue DESC, outstanding DESC, name', name: 'name', oldest: 'oldest_bill NULLS LAST, name' };

// The payables list: suppliers the business owes (or holds an advance with).
async function payables(business, query) {
  await access.require(business, 'purchasing.view');
  const limit = query.limit === undefined ? 25 : id(query.limit, 'Page size');
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('Invalid pagination');
  const search = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const show = v.optionalEnum(query.show, 'Show', ['owing', 'overdue', 'advance', 'all'], 'owing');
  const order = SORTS[v.optionalEnum(query.sort, 'Sort', Object.keys(SORTS), 'outstanding')];
  const where = { owing: 'balance>0', overdue: 'overdue>0', advance: 'balance<0', all: 'TRUE' }[show];
  return repo.one(repo.pool, `WITH a AS (${perSupplierSql}), m AS (SELECT * FROM a WHERE ${where} AND ($3::text IS NULL OR concat_ws(' ',name,phone,gstin) ILIKE $3))
    SELECT (SELECT count(*)::int FROM m) AS total,
      (SELECT json_build_object('balance',COALESCE(sum(balance),0),'outstanding',COALESCE(sum(outstanding),0),'overdue',COALESCE(sum(overdue),0)) FROM m) AS totals,
      COALESCE((SELECT json_agg(p) FROM (SELECT * FROM m ORDER BY ${order} LIMIT $4 OFFSET $5) p),'[]') AS items`,
  [business.id, null, search, limit, offset]);
}

// One supplier: balance, open receipts oldest first, and unapplied advances.
async function account(business, contactId) {
  await access.require(business, 'purchasing.view');
  const contact = await repo.one(repo.pool, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, id(contactId, 'Supplier')]);
  if (!contact) fail('Supplier not found', 404);
  const [summary, items, advances] = await Promise.all([
    repo.one(repo.pool, perSupplierSql, [business.id, contact.id]),
    repo.all(repo.pool, `${openItemsSql} ORDER BY bill_date, document_id NULLS FIRST`, [business.id, contact.id]),
    repo.all(repo.pool, `SELECT k.id,k.payment_no,k.created_at,k.amount,k.amount-${allocatedSql} AS unallocated
      FROM business_supplier_payments k WHERE k.business_id=$1 AND k.contact_id=$2 AND k.amount>${allocatedSql} ORDER BY k.id`, [business.id, contact.id]),
  ]);
  return { contact, summary, items: items.filter((i) => paise(i.open_amount) > 0), advances };
}

// Receipts of a supplier still to pay, oldest due first: the order automatic settling uses.
const openReceipts = (db, businessId, contactId) => repo.all(db, `SELECT d.id,d.document_no,d.supplier_bill_no,d.created_at,d.due_on,d.total,${outstandingSql} AS outstanding
  FROM business_documents d WHERE d.business_id=$1 AND d.kind='purchase' AND d.contact_id=$2
  ORDER BY d.due_on NULLS FIRST, d.created_at, d.id`, [businessId, contactId]);

async function allocate(db, business, user, voucher, available, plan, keyBase, startAt = 0) {
  const made = [];
  let left = available, n = startAt;
  const pay = async (doc, amount) => {
    made.push(await recordPayment(db, business, user, doc, { amount: rupees(amount), method: voucher.method, reference: voucher.payment_no, key: derivedKey(keyBase, n), supplierPaymentId: voucher.id, methodName: voucher.method_name }));
    n += 1; left -= amount;
  };
  if (plan === 'auto') {
    for (const bill of await openReceipts(db, business.id, voucher.contact_id)) {
      if (left <= 0) break;
      const due = paise(bill.outstanding);
      if (due <= 0) continue;
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, bill.id]);
      await pay(doc, Math.min(due, left));
    }
    return made;
  }
  for (const entry of plan) {
    const doc = await repo.one(db, "SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 AND kind='purchase' FOR UPDATE", [business.id, entry.documentId]);
    if (!doc || doc.contact_id !== voucher.contact_id) fail('That receipt is not one of this supplier\'s purchases', 404);
    if (entry.amount > left) fail('The receipts chosen add up to more than the amount paid');
    await pay(doc, entry.amount);
  }
  return made;
}

// body: { locationId, amount, method, reference?, notes?, requestKey,
//   allocations?: [{ documentId, amount }] (omit: oldest due first; []: keep it all as an advance) }
async function pay(business, user, contactId, body) {
  await access.require(business, 'purchasing.edit');
  const requestKey = uuid(body.requestKey);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ ...body, contactId: String(contactId) })).digest('hex');
  const amount = paise(decimal(body.amount, 'Amount paid', 2, 0.01));
  // `methodId`: one of the business's own payment methods (its kind is checked below).
  const choice = paymentMethods.readChoice(body, 'Paid by', METHODS);
  const reference = v.optionalString(body.reference, 'Reference', 100);
  if (choice.method === 'cheque' && !reference) fail('Enter the cheque number as the reference');
  let plan = 'auto';
  if (body.allocations !== undefined && body.allocations !== null) {
    const list = v.requiredArray(body.allocations, 'Receipts to settle');
    if (list.length > 200) fail('Settle at most 200 receipts at once');
    plan = list.map((entry) => ({ documentId: id(entry?.documentId, 'Receipt'), amount: paise(decimal(entry?.amount, 'Amount for a receipt', 2, 0.01)) }));
    if (new Set(plan.map((p) => p.documentId)).size !== plan.length) fail('A receipt may only appear once');
    if (plan.reduce((s, p) => s + p.amount, 0) > amount) fail('The receipts chosen add up to more than the amount paid');
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM business_supplier_payments WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const { method, methodName } = await paymentMethods.settle(db, business.id, choice, 'Paid by', METHODS);
    if (method === 'cheque' && !reference) fail('Enter the cheque number as the reference');
    const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier' FOR UPDATE", [business.id, id(contactId, 'Supplier')]);
    if (!contact) fail('Supplier not found', 404);
    // Oldest first: an opening balance not yet covered by earlier advances is
    // older than any receipt, so that much stays on account against it.
    const free = await repo.one(db, `SELECT COALESCE(sum(k.amount-${allocatedSql}),0) AS free FROM business_supplier_payments k WHERE k.business_id=$1 AND k.contact_id=$2`, [business.id, contact.id]);
    const reserve = plan === 'auto' ? Math.min(amount, Math.max(0, paise(contact.opening_balance) - paise(free.free))) : 0;
    const number = await numbering.nextNumber(db, business.id, location.id, 'supplier_payment', user.id);
    const voucher = await repo.one(db, `INSERT INTO business_supplier_payments(business_id,location_id,payment_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, rupees(amount), method, reference,
      v.optionalString(body.notes, 'Notes', 500), requestKey, hash, user.id, methodName]);
    const payments = await allocate(db, business, user, voucher, amount - reserve, plan, requestKey);
    const allocated = payments.reduce((s, p) => s + paise(p.amount), 0);
    await repo.audit(db, business.id, user.id, 'supplier.paid', voucher.id, { paymentNo: voucher.payment_no, supplier: contact.name, amount: voucher.amount, allocated: rupees(allocated) });
    await repo.event(db, business.id, user.id, 'supplier_payment.recorded', 'supplier_payment', voucher.id, {
      paymentNo: voucher.payment_no, contactId: contact.id, amount: voucher.amount, method,
      allocations: payments.map((p) => ({ documentId: p.document_id, amount: p.amount })), unallocated: rupees(amount - allocated),
    });
    return { ...voucher, allocated: rupees(allocated), unallocated: rupees(amount - allocated), settled: payments.map((p) => ({ documentId: p.document_id, amount: p.amount })) };
  });
}

async function paymentDetail(business, paymentId) {
  await access.require(business, 'purchasing.view');
  const voucher = await repo.one(repo.pool, `SELECT k.*,l.name AS location_name,u.name AS created_by_name,c.phone AS contact_phone,c.gstin AS contact_gstin,c.address AS contact_address
    FROM business_supplier_payments k JOIN business_locations l ON l.business_id=k.business_id AND l.id=k.location_id
    JOIN users u ON u.id=k.created_by JOIN business_contacts c ON c.business_id=k.business_id AND c.id=k.contact_id
    WHERE k.business_id=$1 AND k.id=$2`, [business.id, id(paymentId)]);
  if (!voucher) fail('Supplier payment not found', 404);
  const [allocations, seller] = await Promise.all([
    repo.all(repo.pool, `SELECT p.id,p.amount,d.id AS document_id,d.document_no,d.supplier_bill_no,d.total,d.created_at AS bill_at
      FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
      WHERE p.business_id=$1 AND p.supplier_payment_id=$2 ORDER BY p.id`, [business.id, voucher.id]),
    repo.one(repo.pool, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]),
  ]);
  const allocated = allocations.reduce((s, a) => s + paise(a.amount), 0);
  return { ...voucher, allocations, allocated: rupees(allocated), unallocated: rupees(paise(voucher.amount) - allocated), seller };
}

// The business's own name for the method where one was recorded (PhonePe), else the kind.
const methodSql = (column) => `COALESCE(${column}_name, CASE ${column} WHEN 'upi' THEN 'UPI' WHEN 'bank' THEN 'bank transfer' ELSE ${column} END)`;

// Every money event with one supplier in date order: what they billed
// (receipts), what went back (returns), what was paid (payments, vouchers)
// and refunds received, with the balance brought forward and a running
// balance of what the business owes.
async function statement(business, contactId, query) {
  await access.require(business, 'purchasing.view');
  const from = dateText(query.from, 'Statement start date'), to = dateText(query.to, 'Statement end date');
  if (to < from) fail('The end date is before the start date');
  const contact = await repo.one(repo.pool, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, id(contactId, 'Supplier')]);
  if (!contact) fail('Supplier not found', 404);
  const entries = await repo.all(repo.pool, `WITH b AS (SELECT timezone FROM businesses WHERE id=$1), e AS (
      SELECT d.created_at AS at, 'purchase' AS kind, d.document_no || COALESCE(' · bill ' || d.supplier_bill_no, '') AS reference, d.total AS billed, 0::numeric AS paid, d.id AS document_id
        FROM business_documents d WHERE d.business_id=$1 AND d.kind='purchase' AND d.contact_id=$2
      UNION ALL SELECT r.created_at, 'return', COALESCE(r.return_no, d.document_no), 0, r.total, d.id
        FROM business_returns r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id WHERE r.business_id=$1 AND d.kind='purchase' AND d.contact_id=$2
      UNION ALL SELECT p.created_at, 'payment', d.document_no || ' · ' || ${methodSql('p.method')}, 0, p.amount, d.id
        FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
        WHERE p.business_id=$1 AND d.kind='purchase' AND d.contact_id=$2 AND p.supplier_payment_id IS NULL
      UNION ALL SELECT k.created_at, 'voucher', k.payment_no || ' · ' || ${methodSql('k.method')} || COALESCE(' ' || k.reference, ''), 0, k.amount, NULL
        FROM business_supplier_payments k WHERE k.business_id=$1 AND k.contact_id=$2
      UNION ALL SELECT f.created_at, 'refund', d.document_no || ' · ' || ${methodSql('f.method')}, f.amount, 0, d.id
        FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id WHERE f.business_id=$1 AND d.kind='purchase' AND d.contact_id=$2
    ) SELECT e.*, (e.at AT TIME ZONE b.timezone)::date::text AS day FROM e, b ORDER BY e.at, e.kind`, [business.id, contact.id]);
  let opening = paise(contact.opening_balance || 0);
  const openingOn = contact.opening_balance_on;
  const rows = [];
  if (openingOn && openingOn >= from && openingOn <= to && opening !== 0) {
    rows.push({ day: openingOn, kind: 'opening', reference: 'Opening balance', billed: opening > 0 ? rupees(opening) : '0.00', paid: opening < 0 ? rupees(-opening) : '0.00' });
    opening = 0;
  } else if (openingOn && openingOn > to) opening = 0;
  for (const e of entries) {
    if (e.day < from) opening += paise(e.billed) - paise(e.paid);
    else if (e.day <= to) rows.push({ day: e.day, at: e.at, kind: e.kind, reference: e.reference, billed: e.billed, paid: e.paid, document_id: e.document_id });
  }
  if (rows.length > 5000) fail('Choose a shorter period: more than 5,000 entries');
  let running = opening, billed = 0, paid = 0;
  for (const row of rows) {
    billed += paise(row.billed); paid += paise(row.paid);
    running += paise(row.billed) - paise(row.paid);
    row.balance = rupees(running);
  }
  const seller = await repo.one(repo.pool, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  return { contact, from, to, opening: rupees(opening), billed: rupees(billed), paid: rupees(paid), closing: rupees(running), entries: rows, seller };
}

repo.addLists({
  'supplier-payments': {
    sql: `SELECT k.*,l.name AS location_name,u.name AS created_by_name,${allocatedSql} AS allocated,k.amount-${allocatedSql} AS unallocated
      FROM business_supplier_payments k JOIN business_locations l ON l.business_id=k.business_id AND l.id=k.location_id
      JOIN users u ON u.id=k.created_by WHERE k.business_id=$1`,
    search: ['payment_no', 'contact_name', 'reference', 'notes'], date: 'created_at',
    filters: { contact: 'contact_id', method: 'method', location: 'location_id' }, order: 'id DESC',
  },
});

module.exports = { payables, account, pay, paymentDetail, statement };
