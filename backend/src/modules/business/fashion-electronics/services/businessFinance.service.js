const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');

// EMI / consumer-durable finance at an electronics counter (round 2, R2-CORE).
//
// The customer pays a down payment (cash, UPI, card — split payment) and a
// financier (Bajaj Finserv, HDFC Bank, ICICI Bank, Home Credit, or one the
// owner adds) pays the rest to the shop. On the bill the financed part is a
// payment of method 'finance', so the customer owes nothing for it; the
// money is owed by the financier, as an EMI case (electronics_finance_cases)
// until the financier's payout is recorded. The payout comes in net of the
// dealer subvention the financier keeps (its scheme charge to the dealer):
// received + subvention = financed amount for every case it settles.
//
// A case that the financier cancels (goods returned before the payout) is
// reversed with a refund of method 'finance' on the bill, so the bill and the
// customer's account stay right; the customer gets back only what they paid
// themselves (businessReturns.service › refund).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value || 0) * 100);
const money = (p) => (p / 100).toFixed(2);
const core = () => require('../../core/services/business.service');
function key(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) fail('A valid request key is required');
  return value;
}

// --- At the counter ------------------------------------------------------------------

// body.finance on a sale: { financierId, loanNo, doNo?, tenureMonths?, amount: number | 'rest' }.
function readInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('Finance must be an object');
  const amount = value.amount === 'rest' || value.amount === undefined || value.amount === '' ? 'rest' : core().decimal(value.amount, 'Financed amount', 2, 0.01, 100000000);
  const tenure = value.tenureMonths === undefined || value.tenureMonths === null || value.tenureMonths === '' ? null : core().decimal(value.tenureMonths, 'Tenure (months)', 0, 1, 60);
  return {
    financierId: id(value.financierId, 'Financier'),
    loanNo: v.requiredString(value.loanNo, 'Loan / agreement number', 60),
    doNo: v.optionalString(value.doNo, 'DO number', 60),
    tenureMonths: tenure, amount,
  };
}

// Inside the sale's posting, before anything is saved: what the financier pays.
async function prepare(db, business, input, { contact, buyer, left, hasFull }) {
  if (!business.modules.includes('finance')) fail('EMI & finance is not switched on for this business. An owner can turn it on in Settings › Modules.', 403);
  const financier = await repo.one(db, 'SELECT * FROM electronics_financiers WHERE business_id=$1 AND id=$2 AND active', [business.id, input.financierId]);
  if (!financier) fail('Financier not found', 404);
  if (!contact && !(buyer?.name && buyer?.phone)) fail('An EMI sale needs the customer: choose them, or give the buyer\'s name and phone', 409);
  const same = await repo.one(db, 'SELECT d.document_no FROM electronics_finance_cases c JOIN business_documents d ON d.business_id=c.business_id AND d.id=c.document_id WHERE c.business_id=$1 AND c.financier_id=$2 AND lower(c.loan_no)=lower($3)',
    [business.id, financier.id, input.loanNo]);
  if (same) fail(`Loan ${input.loanNo} with ${financier.name} is already on bill ${same.document_no}`, 409);
  if (input.amount === 'rest' && hasFull) fail('Put the rest of the bill on EMI or take it as a payment, not both');
  const amount = input.amount === 'rest' ? left : paise(input.amount);
  if (amount <= 0) fail('Nothing is left for the financier to pay on this bill');
  if (amount > left) fail(`The financed amount is more than what is left to pay (${money(Math.max(0, left))})`);
  return { amount, financier, input, customer: { name: contact?.name || buyer?.name || null, phone: contact?.phone || buyer?.phone || null } };
}

// After the sale is saved: the 'finance' payment that settles the customer's
// part, and the case the financier owes.
async function record(db, business, user, saved, use, { downPayment, recordPayment }) {
  const payment = await recordPayment(db, business, user, saved, {
    amount: money(use.amount), method: 'finance', reference: `${use.financier.name} · ${use.input.loanNo}`.slice(0, 100), key: crypto.randomUUID(),
  });
  const row = await repo.one(db, `INSERT INTO electronics_finance_cases(business_id,document_id,payment_id,financier_id,loan_no,do_no,tenure_months,down_payment,financed_amount,created_by,customer_name,customer_phone)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [business.id, saved.id, payment.id, use.financier.id, use.input.loanNo, use.input.doNo, use.input.tenureMonths, money(downPayment), money(use.amount), user.id,
    use.customer.name ? String(use.customer.name).slice(0, 150) : null, use.customer.phone ? String(use.customer.phone).slice(0, 30) : null]);
  await repo.audit(db, business.id, user.id, 'finance.case_opened', row.id, { documentId: saved.id, documentNo: saved.document_no, financier: use.financier.name, loanNo: row.loan_no, financed: row.financed_amount });
  await repo.event(db, business.id, user.id, 'finance.case_opened', 'finance_case', row.id,
    { documentId: saved.id, documentNo: saved.document_no, financierId: use.financier.id, loanNo: row.loan_no, financedAmount: row.financed_amount, downPayment: row.down_payment });
  return { ...row, financier_name: use.financier.name };
}

// --- Financiers -----------------------------------------------------------------------

const OUTSTANDING = `COALESCE((SELECT sum(c.financed_amount) FROM electronics_finance_cases c WHERE c.business_id=f.business_id AND c.financier_id=f.id AND c.status='pending'),0)`;
async function financiers(business) {
  await access.requireAny(business, ['finance.view', 'finance.create']);
  const rows = await repo.all(repo.pool, `SELECT f.*,${OUTSTANDING} AS outstanding,
      (SELECT count(*)::int FROM electronics_finance_cases c WHERE c.business_id=f.business_id AND c.financier_id=f.id AND c.status='pending') AS pending_cases
    FROM electronics_financiers f WHERE f.business_id=$1 ORDER BY f.active DESC,f.name`, [business.id]);
  return { items: rows };
}
function readFinancier(body, current = {}) {
  return {
    name: body.name === undefined ? current.name : v.requiredString(body.name, 'Financier name', 100),
    subvention: body.subventionPercent === undefined || body.subventionPercent === '' ? (current.subvention_percent ?? 0) : core().decimal(body.subventionPercent, 'Dealer subvention %', 2, 0, 30),
    active: body.active === undefined ? (current.active ?? true) : v.requiredBoolean(body.active, 'Active'),
  };
}
async function createFinancier(business, user, body) {
  await access.require(business, 'finance.edit');
  const f = readFinancier(body);
  return repo.transaction(async (db) => {
    const same = await repo.one(db, 'SELECT id FROM electronics_financiers WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, f.name]);
    if (same) fail(`${f.name} is already in the list`, 409);
    const row = await repo.one(db, 'INSERT INTO electronics_financiers(business_id,name,subvention_percent,active,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [business.id, f.name, f.subvention, f.active, user.id]);
    await repo.audit(db, business.id, user.id, 'finance.financier_added', row.id, { name: row.name, subventionPercent: row.subvention_percent });
    return row;
  });
}
async function updateFinancier(business, user, financierId, body) {
  await access.require(business, 'finance.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM electronics_financiers WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(financierId)]);
    if (!current) fail('Financier not found', 404);
    const f = readFinancier(body, current);
    if (f.name.toLowerCase() !== current.name.toLowerCase()) {
      const same = await repo.one(db, 'SELECT id FROM electronics_financiers WHERE business_id=$1 AND lower(name)=lower($2) AND id<>$3', [business.id, f.name, current.id]);
      if (same) fail(`${f.name} is already in the list`, 409);
    }
    const row = await repo.one(db, 'UPDATE electronics_financiers SET name=$3,subvention_percent=$4,active=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, current.id, f.name, f.subvention, f.active]);
    await repo.audit(db, business.id, user.id, 'finance.financier_updated', row.id, { name: row.name, subventionPercent: row.subvention_percent, active: row.active });
    return row;
  });
}

// --- Cases, outstanding and payouts --------------------------------------------------

const CASE_SELECT = `SELECT c.*,f.name AS financier_name,f.subvention_percent,d.document_no,d.total AS bill_total,d.contact_id,d.location_id,
    COALESCE(d.contact_name,c.customer_name) AS customer_name,
    ((now() AT TIME ZONE b.timezone)::date - (c.created_at AT TIME ZONE b.timezone)::date) AS age_days,
    s.received_on,s.reference AS settlement_reference,s.method AS settlement_method
  FROM electronics_finance_cases c
  JOIN electronics_financiers f ON f.business_id=c.business_id AND f.id=c.financier_id
  JOIN business_documents d ON d.business_id=c.business_id AND d.id=c.document_id
  JOIN businesses b ON b.id=c.business_id
  LEFT JOIN electronics_finance_settlements s ON s.business_id=c.business_id AND s.id=c.settlement_id`;
async function cases(business, query = {}) {
  await access.require(business, 'finance.view');
  const limit = query.limit === undefined ? 25 : Math.min(100, id(query.limit, 'Page size'));
  const offset = query.offset === undefined ? 0 : Math.max(0, Math.min(10000000, Number(query.offset) || 0));
  const status = query.status ? v.requiredEnum(query.status, 'Status', ['pending', 'settled', 'cancelled']) : null;
  const financierId = query.financierId ? id(query.financierId, 'Financier') : null;
  const search = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().slice(0, 100)}%` : null;
  const from = query.from ? core().dateText(query.from, 'From date') : null;
  const to = query.to ? core().dateText(query.to, 'To date') : null;
  const where = `c.business_id=$1 AND ($2::text IS NULL OR c.status=$2) AND ($3::bigint IS NULL OR c.financier_id=$3)
    AND ($4::text IS NULL OR c.loan_no ILIKE $4 OR c.do_no ILIKE $4 OR d.document_no ILIKE $4 OR d.contact_name ILIKE $4)
    AND ($5::date IS NULL OR (c.created_at AT TIME ZONE b.timezone)::date >= $5) AND ($6::date IS NULL OR (c.created_at AT TIME ZONE b.timezone)::date <= $6)`;
  const values = [business.id, status, financierId, search, from, to];
  const [items, total] = await Promise.all([
    repo.all(repo.pool, `${CASE_SELECT} WHERE ${where} ORDER BY c.status='pending' DESC,c.created_at DESC,c.id DESC LIMIT $7 OFFSET $8`, [...values, limit, offset]),
    repo.one(repo.pool, `SELECT count(*)::int AS total,COALESCE(sum(c.financed_amount),0) AS financed FROM electronics_finance_cases c
      JOIN business_documents d ON d.business_id=c.business_id AND d.id=c.document_id JOIN businesses b ON b.id=c.business_id WHERE ${where}`, values),
  ]);
  return { items, total: total.total, financed: total.financed, limit, offset };
}

// What each financier owes now, with how old the oldest case is.
async function outstanding(business) {
  await access.require(business, 'finance.view');
  const rows = await repo.all(repo.pool, `SELECT f.id,f.name,f.subvention_percent,f.active,count(c.id)::int AS cases,
      COALESCE(sum(c.financed_amount),0) AS financed,
      COALESCE(sum(round(c.financed_amount*f.subvention_percent/100,2)),0) AS expected_subvention,
      min(c.created_at) AS oldest_at,
      COALESCE(max((now() AT TIME ZONE b.timezone)::date - (c.created_at AT TIME ZONE b.timezone)::date),0) AS oldest_days,
      count(c.id) FILTER (WHERE (now() AT TIME ZONE b.timezone)::date - (c.created_at AT TIME ZONE b.timezone)::date > 15)::int AS over_15_days
    FROM electronics_financiers f JOIN businesses b ON b.id=f.business_id
    LEFT JOIN electronics_finance_cases c ON c.business_id=f.business_id AND c.financier_id=f.id AND c.status='pending'
    WHERE f.business_id=$1 GROUP BY f.id,f.name,f.subvention_percent,f.active,b.timezone
    HAVING count(c.id)>0 OR f.active ORDER BY COALESCE(sum(c.financed_amount),0) DESC,f.name`, [business.id]);
  const total = rows.reduce((s, r) => s + paise(r.financed), 0);
  const subvention = rows.reduce((s, r) => s + paise(r.expected_subvention), 0);
  return { items: rows, total: money(total), expectedSubvention: money(subvention), expectedPayout: money(total - subvention) };
}

// A financier's payout for one or more pending cases. For each case the
// subvention it kept (default: its % of the financed amount); the amount
// received must equal the cases' financed amounts less those subventions,
// exactly, so a short payout is never silently written off.
async function settle(business, user, body) {
  await access.require(business, 'finance.edit');
  const requestKey = key(body.requestKey);
  const financierId = id(body.financierId, 'Financier');
  const locationId = id(body.locationId, 'Location');
  const receivedOn = core().dateText(body.receivedOn, 'Date received');
  const method = v.requiredEnum(body.method, 'Received by', ['bank', 'cheque', 'upi']);
  const reference = v.optionalString(body.reference, 'UTR / cheque number', 100);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  const list = v.requiredArray(body.cases, 'Cases');
  if (!list.length || list.length > 200) fail('Choose between 1 and 200 EMI cases');
  const wanted = list.map((c) => ({ caseId: id(c?.caseId, 'Case'), subvention: c?.subvention === undefined || c?.subvention === null || c?.subvention === '' ? null : core().decimal(c.subvention, 'Subvention', 2, 0, 100000000) }));
  if (new Set(wanted.map((c) => c.caseId)).size !== wanted.length) fail('A case may only appear once');
  const typed = core().decimal(body.amountReceived, 'Amount received', 2, 0, 1000000000);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM electronics_finance_settlements WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) return old;
    const financier = await repo.one(db, 'SELECT * FROM electronics_financiers WHERE business_id=$1 AND id=$2', [business.id, financierId]);
    if (!financier) fail('Financier not found', 404);
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    const rows = await repo.all(db, 'SELECT * FROM electronics_finance_cases WHERE business_id=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE', [business.id, wanted.map((c) => c.caseId)]);
    if (rows.length !== wanted.length) fail('An EMI case was not found', 404);
    let received = 0, kept = 0;
    const lines = rows.map((row) => {
      if (Number(row.financier_id) !== financierId) fail(`Loan ${row.loan_no} is with another financier`, 409);
      if (row.status !== 'pending') fail(`Loan ${row.loan_no} is already ${row.status}`, 409);
      const given = wanted.find((c) => c.caseId === Number(row.id)).subvention;
      const subvention = given === null ? Math.round(paise(row.financed_amount) * paise(financier.subvention_percent) / 10000) : paise(given);
      if (subvention > paise(row.financed_amount)) fail(`The subvention on loan ${row.loan_no} is more than its financed amount`);
      received += paise(row.financed_amount) - subvention; kept += subvention;
      return { row, subvention };
    });
    if (paise(typed) !== received) {
      fail(`These ${lines.length} case${lines.length === 1 ? '' : 's'} come to ${money(received)} after ${money(kept)} subvention, not ${money(paise(typed))}. Check the payout advice and the subvention per case.`, 409);
    }
    const settlement = await repo.one(db, `INSERT INTO electronics_finance_settlements(business_id,financier_id,location_id,received_on,method,reference,amount_received,subvention_total,notes,request_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [business.id, financier.id, location.id, receivedOn, method, reference, money(received), money(kept), notes, requestKey, user.id]);
    for (const { row, subvention } of lines) {
      await db.query("UPDATE electronics_finance_cases SET status='settled',settlement_id=$3,subvention_charged=$4 WHERE business_id=$1 AND id=$2",
        [business.id, row.id, settlement.id, money(subvention)]);
    }
    await repo.audit(db, business.id, user.id, 'finance.payout_received', settlement.id, { financier: financier.name, cases: lines.length, received: settlement.amount_received, subvention: settlement.subvention_total, reference });
    await repo.event(db, business.id, user.id, 'finance.payout_received', 'finance_settlement', settlement.id,
      { financierId: financier.id, caseIds: lines.map((l) => l.row.id), amountReceived: settlement.amount_received, subventionTotal: settlement.subvention_total, method });
    return { ...settlement, financier_name: financier.name, cases: lines.length };
  });
}

// The financier cancelled the loan before paying it out (the goods came back):
// the case is closed and its 'finance' payment reversed on the bill. Needs
// goods returned on the bill worth at least the financed amount, so the
// customer is never left owing what the financier was to pay.
async function cancel(business, user, caseId, body) {
  await access.require(business, 'finance.edit');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  const requestKey = key(body.requestKey);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const row = await repo.one(db, 'SELECT * FROM electronics_finance_cases WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(caseId)]);
    if (!row) fail('EMI case not found', 404);
    if (row.status !== 'pending') fail(`This EMI case is already ${row.status}`, 409);
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, row.document_id]);
    const sums = await repo.one(db, `SELECT
      COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
      COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
      COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded`, [business.id, doc.id]);
    const credit = paise(sums.paid) - paise(sums.refunded) - (paise(doc.total) - paise(sums.returned));
    if (credit < paise(row.financed_amount)) {
      fail(`Take the goods back on ${doc.document_no} first: the returns must cover the financed ${money(paise(row.financed_amount))} before the loan can be cancelled.`, 409);
    }
    const refund = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by)
      VALUES($1,$2,$3,'finance',$4,$5,$6) RETURNING *`, [business.id, doc.id, row.financed_amount, `EMI cancelled (${row.loan_no}): ${reason}`.slice(0, 300), requestKey, user.id]);
    const saved = await repo.one(db, "UPDATE electronics_finance_cases SET status='cancelled',cancelled_reason=$3,cancelled_by=$4,cancelled_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
      [business.id, row.id, reason, user.id]);
    await repo.audit(db, business.id, user.id, 'finance.case_cancelled', row.id, { documentNo: doc.document_no, loanNo: row.loan_no, financed: row.financed_amount, reason });
    await repo.event(db, business.id, user.id, 'finance.case_cancelled', 'finance_case', row.id, { documentId: doc.id, refundId: refund.id, financedAmount: row.financed_amount });
    return saved;
  });
}

// The EMI case of a bill (document detail and receipt).
const ofDocument = (db, businessId, documentId) => repo.all(db, `SELECT c.id,c.loan_no,c.do_no,c.tenure_months,c.down_payment,c.financed_amount,c.status,f.name AS financier_name
  FROM electronics_finance_cases c JOIN electronics_financiers f ON f.business_id=c.business_id AND f.id=c.financier_id
  WHERE c.business_id=$1 AND c.document_id=$2 ORDER BY c.id`, [businessId, documentId]);

module.exports = { readInput, prepare, record, financiers, createFinancier, updateFinancier, cases, outstanding, settle, cancel, ofDocument };
