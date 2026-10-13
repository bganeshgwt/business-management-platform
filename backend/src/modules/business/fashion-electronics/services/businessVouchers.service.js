const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// Exchange credit vouchers (pro pass E-06). When an exchange leaves the
// customer with credit (what came back is worth more than what went out),
// the credit can be printed as a numbered voucher (CV000123) instead of
// cash back — walk-ins included. The credit leaves the original sale as a
// credit-note refund (no money moves), and the voucher is spent later as a
// credit-note payment on a new bill (Quick bill or New sale: body.voucher).
// A voucher is valid for the business's voucher_valid_days (Business settings ›
// Rules, 90 by default); what is left after that lapses.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const cents = (value) => Math.round(Number(value) * 100);
const money = (p) => (p / 100).toFixed(2);
// Kept for older callers; the business's own setting wins.
const VALID_DAYS = 90;

const voucherSql = `SELECT x.*,(x.amount - x.used) AS balance,c.name AS contact_name,c.phone AS contact_phone,l.name AS location_name,
    d.document_no AS source_no,u.name AS created_by_name,
    CASE WHEN x.used >= x.amount THEN 'used' WHEN x.expires_on < (now() AT TIME ZONE b.timezone)::date THEN 'expired' ELSE 'open' END AS state
  FROM business_exchange_vouchers x JOIN businesses b ON b.id=x.business_id
  JOIN business_locations l ON l.business_id=x.business_id AND l.id=x.location_id
  JOIN business_documents d ON d.business_id=x.business_id AND d.id=x.source_document_id
  JOIN users u ON u.id=x.created_by
  LEFT JOIN business_contacts c ON c.business_id=x.business_id AND c.id=x.contact_id
  WHERE x.business_id=$1`;

const readCode = (value) => {
  const text = v.requiredString(String(value ?? ''), 'Voucher number', 30).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^CV\d{6,10}$/.test(text)) fail('A voucher number looks like CV000123');
  return text;
};

// Inside the exchange's transaction (the business row is locked): the
// credit leaves the original sale and becomes a voucher.
async function issue(db, business, user, { doc, amount, locationId, key, name, phone, exchangeId = null }) {
  if (amount <= 0) fail('Nothing to put on a voucher');
  const out = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by)
    VALUES($1,$2,$3,'credit_note',$4,$5,$6) RETURNING *`, [business.id, doc.id, money(amount), 'Exchange credit given as a credit voucher', key('voucher-out'), user.id]);
  await repo.audit(db, business.id, user.id, 'sale.refunded', out.id, { documentId: doc.id, amount: out.amount, method: 'credit_note' });
  await repo.event(db, business.id, user.id, 'sale.refunded', 'refund', out.id, { documentId: doc.id, documentNo: doc.document_no, amount: out.amount, method: 'credit_note' });
  const next = await repo.one(db, 'SELECT count(*)::int + 1 AS n FROM business_exchange_vouchers WHERE business_id=$1', [business.id]);
  const voucherNo = `CV${String(next.n).padStart(6, '0')}`;
  const contact = doc.contact_id ? await repo.one(db, 'SELECT name,phone FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, doc.contact_id]) : null;
  const row = await repo.one(db, `INSERT INTO business_exchange_vouchers(business_id,location_id,voucher_no,contact_id,customer_name,customer_phone,amount,expires_on,
      source_document_id,request_key,created_by,exchange_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,((now() AT TIME ZONE $8)::date + COALESCE((SELECT voucher_valid_days FROM business_settings WHERE business_id=$1),$9::int)),$10,$11,$12,$13) RETURNING *`,
  [business.id, locationId, voucherNo, doc.contact_id || null, name || contact?.name || null, phone || contact?.phone || null, money(amount),
    business.timezone, VALID_DAYS, doc.id, key('voucher'), user.id, exchangeId]);
  await repo.audit(db, business.id, user.id, 'voucher.issued', row.id, { voucherNo, amount: row.amount, documentId: doc.id });
  await repo.event(db, business.id, user.id, 'voucher.issued', 'voucher', row.id, { voucherNo, amount: row.amount, documentId: doc.id, documentNo: doc.document_no });
  return row;
}

async function find(business, code) {
  await access.requireAny(business, ['sales.create', 'exchanges.view']);
  const row = await repo.one(repo.pool, `${voucherSql} AND x.voucher_no=$2`, [business.id, readCode(code)]);
  if (!row) fail('No credit voucher has that number', 404);
  const uses = await repo.all(repo.pool, `SELECT u.amount,u.created_at,d.document_no FROM business_exchange_voucher_uses u
    JOIN business_documents d ON d.business_id=u.business_id AND d.id=u.document_id WHERE u.business_id=$1 AND u.voucher_id=$2 ORDER BY u.id`, [business.id, row.id]);
  return { ...row, uses };
}

async function detail(business, voucherId) {
  await access.require(business, 'exchanges.view');
  const row = await repo.one(repo.pool, `${voucherSql} AND x.id=$2`, [business.id, id(voucherId, 'Voucher')]);
  if (!row) fail('Voucher not found', 404);
  const seller = await repo.one(repo.pool, 'SELECT display_name,legal_name,gstin,address_line1,city,postal_code,phone,date_format FROM business_settings WHERE business_id=$1', [business.id]);
  return { ...row, seller };
}

// For a sale being posted (business.service.js › document): the voucher is
// read and locked; postDocument decides how much of it the bill takes.
function readInput(value) {
  if (value === undefined || value === null || value === '') return null;
  return { code: readCode(typeof value === 'object' ? value.code : value) };
}
async function prepare(db, business, input, totalPaise) {
  const row = await repo.one(db, `SELECT x.*,(x.expires_on < (now() AT TIME ZONE $3)::date) AS lapsed FROM business_exchange_vouchers x
    WHERE x.business_id=$1 AND x.voucher_no=$2 FOR UPDATE`, [business.id, input.code, business.timezone]);
  if (!row) fail(`No credit voucher has the number ${input.code}`, 404);
  if (row.lapsed) fail(`Voucher ${row.voucher_no} expired on ${String(row.expires_on).slice(0, 10)}`, 409);
  const balance = cents(row.amount) - cents(row.used);
  if (balance <= 0) fail(`Voucher ${row.voucher_no} has been used up`, 409);
  return { row, amount: Math.min(balance, totalPaise) };
}
async function spend(db, business, user, saved, use, recordPayment) {
  if (!use || use.amount <= 0) return null;
  const key = crypto.createHash('sha256').update(`${saved.request_key}:voucher`).digest('hex');
  const requestKey = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
  const payment = await recordPayment(db, business, user, saved, { amount: money(use.amount), method: 'credit_note', reference: use.row.voucher_no, key: requestKey });
  await db.query('UPDATE business_exchange_vouchers SET used=used+$3 WHERE business_id=$1 AND id=$2', [business.id, use.row.id, money(use.amount)]);
  await db.query(`INSERT INTO business_exchange_voucher_uses(business_id,voucher_id,document_id,payment_id,amount,created_by) VALUES($1,$2,$3,$4,$5,$6)`,
    [business.id, use.row.id, saved.id, payment.id, money(use.amount), user.id]);
  await repo.audit(db, business.id, user.id, 'voucher.used', use.row.id, { voucherNo: use.row.voucher_no, amount: money(use.amount), documentId: saved.id });
  return payment;
}

const lists = {
  'exchange-vouchers': { sql: voucherSql, search: ['voucher_no', 'customer_name', 'customer_phone', 'contact_name', 'source_no'], date: 'created_at',
    filters: { state: 'state' }, order: 'id DESC' },
};

module.exports = { issue, find, detail, readInput, prepare, spend, lists, VALID_DAYS };
