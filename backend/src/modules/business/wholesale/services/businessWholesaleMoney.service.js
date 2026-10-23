const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const receivables = require('./businessReceivables.service');
const wholesale = require('./businessWholesale.service');

// The distributor's money and day.
//
//   Evening settlement  what one salesperson collected on a day, by method,
//                       against the cash they hand over; a shortage or an
//                       excess needs a note. Each receipt is settled once.
//   Today               the overview's wholesale figures: orders to dispatch,
//                       back-orders, collected today by salesperson, overdue,
//                       cheques to deposit, vans out, today's beats.
//   Beat sheet          a salesperson's shops for a day: last order, dues.
//   Claims              what the distributor claims back from a company
//                       (schemes, damage, expiry, rate difference, shortage).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const today = async (db, business) => (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;

repo.addLists({
  settlements: { sql: `SELECT t.*,s.name AS salesperson_name,u.name AS created_by_name FROM wholesale_settlements t
      JOIN wholesale_salespeople s ON s.business_id=t.business_id AND s.id=t.salesperson_id JOIN users u ON u.id=t.created_by WHERE t.business_id=$1`,
  search: ['salesperson_name', 'notes'], date: 'created_at', filters: { salesperson: 'salesperson_id' }, order: 'day DESC,id DESC' },
  claims: { sql: `SELECT k.*,c.name AS supplier_name,d.document_no,u.name AS created_by_name FROM wholesale_claims k
      JOIN business_contacts c ON c.business_id=k.business_id AND c.id=k.contact_id
      LEFT JOIN business_documents d ON d.business_id=k.business_id AND d.id=k.document_id JOIN users u ON u.id=k.created_by WHERE k.business_id=$1`,
  search: ['supplier_name', 'credit_note_no', 'notes', 'document_no'], date: 'created_at', filters: { status: 'status', supplier: 'contact_id', kind: 'kind' }, order: 'id DESC' },
});

// --- Evening settlement --------------------------------------------------------

// A salesperson's receipts on a day that are not settled yet, by method.
async function receiptsToSettle(db, business, salespersonId, day) {
  return repo.all(db, `SELECT k.id,k.collection_no,k.contact_name,k.amount,k.method,k.reference,k.created_at,q.cheque_date,q.bank,q.status AS cheque_status
    FROM business_collections k JOIN wholesale_collection_details wd ON wd.business_id=k.business_id AND wd.collection_id=k.id
    LEFT JOIN business_collection_cheques q ON q.business_id=k.business_id AND q.collection_id=k.id
    WHERE k.business_id=$1 AND wd.salesperson_id=$2 AND (k.created_at AT TIME ZONE $3)::date=$4::date
    AND NOT EXISTS (SELECT 1 FROM wholesale_settlement_receipts sr WHERE sr.business_id=k.business_id AND sr.collection_id=k.id)
    AND ${receivables.liveSql('k')} ORDER BY k.id`, [business.id, salespersonId, business.timezone, day]);
}
const totalsOf = (receipts) => {
  const t = { receipts: receipts.length, cash: 0, upi: 0, cheques: 0, cheque_count: 0, other: 0 };
  for (const r of receipts) {
    const a = paise(r.amount);
    if (r.method === 'cash') t.cash += a;
    else if (r.method === 'upi') t.upi += a;
    else if (r.method === 'cheque') { t.cheques += a; t.cheque_count += 1; } else t.other += a;
  }
  return t;
};

async function settlementPreview(business, query) {
  await access.require(business, 'receivables.view');
  const salespersonId = id(query.salesperson, 'Salesperson');
  const salesperson = await repo.one(repo.pool, 'SELECT id,name,phone FROM wholesale_salespeople WHERE business_id=$1 AND id=$2', [business.id, salespersonId]);
  if (!salesperson) fail('Salesperson not found', 404);
  const day = query.day ? core.dateText(query.day, 'Day') : await today(repo.pool, business);
  const [receipts, earlier] = await Promise.all([
    receiptsToSettle(repo.pool, business, salespersonId, day),
    repo.all(repo.pool, `SELECT t.*,u.name AS created_by_name FROM wholesale_settlements t JOIN users u ON u.id=t.created_by
      WHERE t.business_id=$1 AND t.salesperson_id=$2 AND t.day=$3 ORDER BY t.id`, [business.id, salespersonId, day]),
  ]);
  const t = totalsOf(receipts);
  return { salesperson, day, receipts, earlier, totals: Object.fromEntries(Object.entries(t).map(([k, x]) => [k, ['receipts', 'cheque_count'].includes(k) ? x : rupees(x)])) };
}

// body: { salespersonId, day, cashHanded, notes?, requestKey }: settles every
// receipt of theirs that day not settled yet. Needs credit control.
async function settle(business, user, body) {
  await access.require(business, 'receivables.approve');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const salespersonId = id(body.salespersonId, 'Salesperson');
  const day = core.dateText(body.day, 'Day');
  const handed = paise(core.decimal(body.cashHanded, 'Cash handed over', 2, 0, 100000000));
  const notes = v.optionalString(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM wholesale_settlements WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const salesperson = await repo.one(db, 'SELECT id,name FROM wholesale_salespeople WHERE business_id=$1 AND id=$2', [business.id, salespersonId]);
    if (!salesperson) fail('Salesperson not found', 404);
    if (day > await today(db, business)) fail('A day can be settled once it has started');
    const receipts = await receiptsToSettle(db, business, salespersonId, day);
    if (!receipts.length && !handed) fail(`${salesperson.name} has no receipts to settle on ${day}`, 409);
    const t = totalsOf(receipts);
    const difference = handed - t.cash;
    if (difference !== 0 && !notes) fail(difference < 0 ? `Cash is ${rupees(-difference)} short. Add a note saying why.` : `Cash is ${rupees(difference)} more than collected. Add a note saying why.`);
    const saved = await repo.one(db, `INSERT INTO wholesale_settlements(business_id,salesperson_id,day,receipts,cash,upi,cheques,cheque_count,other,cash_handed,difference,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [business.id, salesperson.id, day, t.receipts, rupees(t.cash), rupees(t.upi),
      rupees(t.cheques), t.cheque_count, rupees(t.other), rupees(handed), rupees(difference), notes, requestKey, hash, user.id]);
    for (const r of receipts) {
      await db.query('INSERT INTO wholesale_settlement_receipts(business_id,settlement_id,collection_id) VALUES($1,$2,$3)', [business.id, saved.id, r.id]);
    }
    await repo.audit(db, business.id, user.id, 'salesperson.settled', saved.id, { salesperson: salesperson.name, day, cash: saved.cash, handed: saved.cash_handed,
      difference: saved.difference, receipts: receipts.map((r) => r.collection_no) });
    await repo.event(db, business.id, user.id, 'salesperson.settled', 'settlement', saved.id, { salespersonId: salesperson.id, day, cash: saved.cash, handed: saved.cash_handed, difference: saved.difference });
    return { ...saved, salesperson_name: salesperson.name };
  });
}

// --- The wholesale overview ------------------------------------------------------

async function summary(business) {
  await access.require(business, 'sales_orders.view');
  const money = access.can(business, 'receivables.view');
  const [orders, backOrders, out, beats, collected, cheques, overdue, unsettled, held] = await Promise.all([
    repo.one(repo.pool, `SELECT count(*)::int AS count,COALESCE(sum((SELECT COALESCE(sum(${wholesale.remainingValueSql('x')}),0) FROM wholesale_order_lines x
      WHERE x.business_id=o.business_id AND x.order_id=o.id)),0) AS value,
      count(*) FILTER (WHERE o.expected_on IS NOT NULL AND o.expected_on<=(now() AT TIME ZONE $2)::date)::int AS due_today
      FROM wholesale_orders o WHERE o.business_id=$1 AND o.status IN ('open','part_dispatched')`, [business.id, business.timezone]),
    repo.one(repo.pool, `SELECT count(*)::int AS lines,COALESCE(sum(${wholesale.remainingValueSql('x')}),0) AS value FROM wholesale_order_lines x
      JOIN wholesale_orders o ON o.business_id=x.business_id AND o.id=x.order_id WHERE x.business_id=$1 AND o.status='part_dispatched' AND ${wholesale.remainingSql('x')}>0`, [business.id]),
    repo.one(repo.pool, `SELECT count(*)::int AS count,COALESCE(sum(doc.total),0) AS value FROM wholesale_dispatches d
      JOIN business_documents doc ON doc.business_id=d.business_id AND doc.id=d.document_id WHERE d.business_id=$1 AND d.delivery_status='out_for_delivery'`, [business.id]),
    repo.all(repo.pool, `SELECT b.id,b.name,r.name AS route_name,s.name AS salesperson_name,
      (SELECT count(*)::int FROM wholesale_customer_beats cb WHERE cb.business_id=b.business_id AND cb.beat_id=b.id) AS shops,
      (SELECT count(*)::int FROM wholesale_orders o WHERE o.business_id=b.business_id AND o.beat_id=b.id
        AND (o.created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date) AS orders_today
      FROM wholesale_beats b JOIN wholesale_routes r ON r.business_id=b.business_id AND r.id=b.route_id
      LEFT JOIN wholesale_salespeople s ON s.business_id=b.business_id AND s.id=b.salesperson_id
      WHERE b.business_id=$1 AND b.active AND b.visit_day=EXTRACT(ISODOW FROM now() AT TIME ZONE $2) ORDER BY r.name,b.name`, [business.id, business.timezone]),
    money ? repo.all(repo.pool, `SELECT COALESCE(s.name,'Office / not set') AS name,wd.salesperson_id,count(*)::int AS receipts,sum(k.amount) AS amount,
      sum(k.amount) FILTER (WHERE k.method='cash') AS cash
      FROM business_collections k LEFT JOIN wholesale_collection_details wd ON wd.business_id=k.business_id AND wd.collection_id=k.id
      LEFT JOIN wholesale_salespeople s ON s.business_id=wd.business_id AND s.id=wd.salesperson_id
      WHERE k.business_id=$1 AND (k.created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date AND ${receivables.liveSql('k')}
      GROUP BY 1,2 ORDER BY amount DESC`, [business.id, business.timezone]) : null,
    money ? repo.one(repo.pool, `SELECT count(*) FILTER (WHERE q.status='received' AND q.cheque_date<=(now() AT TIME ZONE $2)::date)::int AS to_deposit,
      COALESCE(sum(k.amount) FILTER (WHERE q.status='received' AND q.cheque_date<=(now() AT TIME ZONE $2)::date),0) AS to_deposit_value,
      count(*) FILTER (WHERE q.status='received' AND q.cheque_date>(now() AT TIME ZONE $2)::date)::int AS post_dated,
      COALESCE(sum(k.amount) FILTER (WHERE q.status='received' AND q.cheque_date>(now() AT TIME ZONE $2)::date),0) AS post_dated_value,
      count(*) FILTER (WHERE q.status='deposited')::int AS in_clearing,
      count(*) FILTER (WHERE q.status='bounced' AND q.bounced_at>now()-interval '30 days')::int AS bounced_30_days
      FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id WHERE q.business_id=$1`, [business.id, business.timezone]) : null,
    money ? repo.one(repo.pool, `WITH a AS (${receivables.ageingSql}) SELECT COALESCE(sum(overdue),0) AS amount,count(*) FILTER (WHERE overdue>0)::int AS customers,
      COALESCE(sum(days_over_90),0) AS over_90 FROM a`, [business.id, null]) : null,
    money ? repo.all(repo.pool, `SELECT s.id,s.name,count(*)::int AS receipts,sum(k.amount) FILTER (WHERE k.method='cash') AS cash
      FROM business_collections k JOIN wholesale_collection_details wd ON wd.business_id=k.business_id AND wd.collection_id=k.id
      JOIN wholesale_salespeople s ON s.business_id=wd.business_id AND s.id=wd.salesperson_id
      WHERE k.business_id=$1 AND (k.created_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date AND ${receivables.liveSql('k')}
      AND NOT EXISTS (SELECT 1 FROM wholesale_settlement_receipts sr WHERE sr.business_id=k.business_id AND sr.collection_id=k.id)
      GROUP BY s.id,s.name ORDER BY s.name`, [business.id, business.timezone]) : null,
    repo.one(repo.pool, 'SELECT hold_overdue_days FROM wholesale_settings WHERE business_id=$1', [business.id]),
  ]);
  return {
    orders_to_dispatch: orders, back_orders: backOrders, out_for_delivery: out, beats_today: beats,
    collected_today: collected, cheques, overdue, unsettled_today: unsettled, hold_overdue_days: held?.hold_overdue_days ?? null,
  };
}

// --- A salesperson's beat sheet ---------------------------------------------------

// The shops on a salesperson's beats for a weekday (today by default): what
// they owe, how late, their last order — to print or open on the phone.
async function beatSheet(business, salespersonId, query) {
  await access.require(business, 'sales_orders.view');
  const salesperson = await repo.one(repo.pool, `SELECT s.*,u.name AS user_name FROM wholesale_salespeople s LEFT JOIN users u ON u.id=s.user_id
    WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(salespersonId, 'Salesperson')]);
  if (!salesperson) fail('Salesperson not found', 404);
  const weekday = query.day === undefined || query.day === '' ? Number((await repo.one(repo.pool, 'SELECT EXTRACT(ISODOW FROM now() AT TIME ZONE $1)::int AS d', [business.timezone])).d) : Number(query.day);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) fail('Day must be 1 (Monday) to 7 (Sunday)');
  const money = access.can(business, 'receivables.view');
  const shops = await repo.all(repo.pool, `WITH a AS (${receivables.ageingSql})
    SELECT c.id AS contact_id,c.name,c.phone,c.address,b.name AS beat_name,r.name AS route_name,
      ${money ? 'a.balance,a.overdue,a.most_days_overdue,a.oldest_bill,a.promised_on,' : ''}
      (SELECT o.created_at FROM wholesale_orders o WHERE o.business_id=c.business_id AND o.contact_id=c.id ORDER BY o.id DESC LIMIT 1) AS last_order_at,
      (SELECT o.total FROM wholesale_orders o WHERE o.business_id=c.business_id AND o.contact_id=c.id ORDER BY o.id DESC LIMIT 1) AS last_order_total,
      (SELECT count(*)::int FROM wholesale_orders o WHERE o.business_id=c.business_id AND o.contact_id=c.id AND o.status IN ('open','part_dispatched')) AS open_orders
    FROM wholesale_beats b JOIN wholesale_routes r ON r.business_id=b.business_id AND r.id=b.route_id
    JOIN wholesale_customer_beats cb ON cb.business_id=b.business_id AND cb.beat_id=b.id
    JOIN business_contacts c ON c.business_id=cb.business_id AND c.id=cb.contact_id AND c.active
    LEFT JOIN a ON a.contact_id=c.id
    WHERE b.business_id=$1 AND b.salesperson_id=$3 AND b.active AND (b.visit_day=$4 OR b.visit_day IS NULL)
    ORDER BY b.name,c.name`, [business.id, null, salesperson.id, weekday]);
  return { salesperson, weekday, shops };
}

// --- Claims against suppliers -------------------------------------------------------

const CLAIM_KINDS = ['scheme', 'damage', 'expiry', 'rate_difference', 'shortage', 'other'];
async function createClaim(business, user, body) {
  await access.require(business, 'purchasing.edit');
  const kind = v.requiredEnum(body.kind, 'Claim type', CLAIM_KINDS);
  const amount = core.decimal(body.amount, 'Claim amount', 2, 0.01);
  const from = body.periodFrom ? core.dateText(body.periodFrom, 'From') : null;
  const to = body.periodTo ? core.dateText(body.periodTo, 'To') : null;
  if (from && to && to < from) fail('The end date is before the start date');
  return repo.transaction(async (db) => {
    const supplier = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, id(body.supplierId, 'Supplier')]);
    if (!supplier) fail('Supplier not found', 404);
    const documentId = optionalId(body.documentId, 'Purchase');
    if (documentId && !(await repo.one(db, "SELECT id FROM business_documents WHERE business_id=$1 AND id=$2 AND kind='purchase' AND contact_id=$3", [business.id, documentId, supplier.id]))) {
      fail('That purchase is not from this supplier', 404);
    }
    const saved = await repo.one(db, `INSERT INTO wholesale_claims(business_id,contact_id,kind,amount,document_id,period_from,period_to,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [business.id, supplier.id, kind, amount, documentId, from, to, v.optionalString(body.notes, 'Notes', 500), user.id]);
    await repo.audit(db, business.id, user.id, 'claim.created', saved.id, { supplier: supplier.name, kind, amount: saved.amount });
    return saved;
  });
}
// body: { status: 'submitted' | 'settled' | 'rejected', settledAmount?, creditNoteNo?, notes? }
async function updateClaim(business, user, claimId, body) {
  await access.require(business, 'purchasing.edit');
  const status = v.requiredEnum(body.status, 'Status', ['submitted', 'settled', 'rejected']);
  return repo.transaction(async (db) => {
    const claim = await repo.one(db, 'SELECT * FROM wholesale_claims WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(claimId)]);
    if (!claim) fail('Claim not found', 404);
    const allowed = { open: ['submitted', 'settled', 'rejected'], submitted: ['settled', 'rejected'] }[claim.status] || [];
    if (!allowed.includes(status)) fail(`A ${claim.status} claim cannot be marked ${status}`, 409);
    let settled = null;
    if (status === 'settled') {
      settled = core.decimal(body.settledAmount, 'Amount the company gave', 2, 0, 100000000);
      if (!v.optionalString(body.creditNoteNo, 'Credit note number', 60)) fail('Enter the company\'s credit note number');
    }
    const notes = body.notes === undefined ? claim.notes : v.optionalString(body.notes, 'Notes', 500);
    const saved = await repo.one(db, `UPDATE wholesale_claims SET status=$3,submitted_at=CASE WHEN $3='submitted' THEN now() ELSE submitted_at END,
      settled_amount=$4,credit_note_no=$5,closed_at=CASE WHEN $3 IN ('settled','rejected') THEN now() ELSE NULL END,notes=$6,updated_by=$7,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, claim.id, status, settled, status === 'settled' ? body.creditNoteNo.trim() : claim.credit_note_no, notes, user.id]);
    await repo.audit(db, business.id, user.id, `claim.${status}`, claim.id, { settled, creditNoteNo: saved.credit_note_no });
    return saved;
  });
}

module.exports = { settlementPreview, settle, summary, beatSheet, createClaim, updateClaim };
