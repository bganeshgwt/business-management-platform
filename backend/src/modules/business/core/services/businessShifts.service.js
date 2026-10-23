const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');

// A cashier's shift at one counter location (business_counter_shifts): the
// float they start with, then the cash they count at the end against what
// their own cash movements there say the drawer should hold. Many cashiers
// bill at once in a supermarket; each one's count is checked against only
// what they took and paid out. A closed shift is a permanent record.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const paise = (value) => Math.round(Number(value) * 100);
const money = (value) => (value / 100).toFixed(2);

function amount(value, name) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) fail(`${name} must be an amount like 1500 or 1500.50`);
  if (Number(text) > 100000000) fail(`${name} is too large`);
  return paise(text);
}

// Cash in (+) and out (-) by one person at one location between two moments,
// in paise: their cash sale payments and collections and supplier refunds;
// cash refunds, payments to suppliers and expenses they paid out (an expense
// reversed in the window comes back).
async function cashMovement(db, business, { locationId, userId, from, to }) {
  const row = await repo.one(db, `SELECT COALESCE(sum(amount),0) AS total FROM (
      SELECT p.amount FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
        WHERE p.business_id=$1 AND d.kind='sale' AND p.method='cash' AND p.collection_id IS NULL AND d.location_id=$2 AND p.created_by=$3 AND p.created_at>=$4 AND p.created_at<$5
      UNION ALL SELECT k.amount FROM business_collections k
        WHERE k.business_id=$1 AND k.method='cash' AND k.location_id=$2 AND k.created_by=$3 AND k.created_at>=$4 AND k.created_at<$5
      UNION ALL SELECT f.amount FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
        WHERE f.business_id=$1 AND d.kind='purchase' AND f.method='cash' AND d.location_id=$2 AND f.created_by=$3 AND f.created_at>=$4 AND f.created_at<$5
      UNION ALL SELECT -f.amount FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
        WHERE f.business_id=$1 AND d.kind='sale' AND f.method='cash' AND d.location_id=$2 AND f.created_by=$3 AND f.created_at>=$4 AND f.created_at<$5
      UNION ALL SELECT -f.amount FROM business_collection_refunds f JOIN business_collections k ON k.business_id=f.business_id AND k.id=f.collection_id
        WHERE f.business_id=$1 AND f.method='cash' AND k.location_id=$2 AND f.created_by=$3 AND f.created_at>=$4 AND f.created_at<$5
      UNION ALL SELECT -p.amount FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
        WHERE p.business_id=$1 AND d.kind='purchase' AND p.method='cash' AND p.supplier_payment_id IS NULL AND d.location_id=$2 AND p.created_by=$3 AND p.created_at>=$4 AND p.created_at<$5
      UNION ALL SELECT -k.amount FROM business_supplier_payments k
        WHERE k.business_id=$1 AND k.method='cash' AND k.location_id=$2 AND k.created_by=$3 AND k.created_at>=$4 AND k.created_at<$5
      UNION ALL SELECT -e.amount FROM business_expenses e
        WHERE e.business_id=$1 AND e.method='cash' AND e.location_id=$2 AND e.created_by=$3 AND e.created_at>=$4 AND e.created_at<$5
      UNION ALL SELECT e.amount FROM business_expenses e
        WHERE e.business_id=$1 AND e.method='cash' AND e.location_id=$2 AND e.voided_by=$3 AND e.voided_at>=$4 AND e.voided_at<$5
    ) moves`, [business.id, locationId, userId, from, to]);
  return paise(row.total);
}

async function withFigures(db, business, shift) {
  if (shift.closed_at) return shift;
  const now = await repo.one(db, 'SELECT now() AS at');
  const movement = await cashMovement(db, business, { locationId: shift.location_id, userId: shift.user_id, from: shift.opened_at, to: now.at });
  return { ...shift, movement_so_far: money(movement), expected_so_far: money(paise(shift.opening_cash) + movement) };
}

const SELECT = `SELECT s.*,u.name AS cashier_name,c.name AS closed_by_name,l.name AS location_name FROM business_counter_shifts s
  JOIN users u ON u.id=s.user_id LEFT JOIN users c ON c.id=s.closed_by
  JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id`;

// This person's open shift at the location (or null), with the cash it
// should hold so far.
async function current(business, user, query) {
  await access.require(business, 'sales.create');
  const locationId = v.requiredId(query.location || query.locationId, 'Counter location');
  access.requireLocation(business, locationId);
  const shift = await repo.one(repo.pool, `${SELECT} WHERE s.business_id=$1 AND s.location_id=$2 AND s.user_id=$3 AND s.closed_at IS NULL`, [business.id, locationId, user.id]);
  return shift ? withFigures(repo.pool, business, shift) : null;
}

async function open(business, user, body) {
  await access.require(business, 'sales.create');
  const locationId = v.requiredId(body.locationId, 'Counter location');
  access.requireLocation(business, locationId);
  const opening = amount(body.openingCash, 'Opening cash');
  return repo.transaction(async (db) => {
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Counter location not found or closed', 404);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${business.id}:shift:${locationId}:${user.id}`]);
    const already = await repo.one(db, 'SELECT id FROM business_counter_shifts WHERE business_id=$1 AND location_id=$2 AND user_id=$3 AND closed_at IS NULL', [business.id, locationId, user.id]);
    if (already) fail('Your shift at this counter is already open. Close it before opening another.', 409);
    const row = await repo.one(db, 'INSERT INTO business_counter_shifts(business_id,location_id,user_id,opening_cash) VALUES($1,$2,$3,$4) RETURNING *',
      [business.id, locationId, user.id, money(opening)]);
    await repo.audit(db, business.id, user.id, 'shift.opened', row.id, { locationId, openingCash: row.opening_cash });
    return withFigures(db, business, { ...row, cashier_name: user.name });
  });
}

// The closing count: counted cash against opening + this cashier's cash
// movements since; a difference needs a reason. The cashier closes their
// own shift; a manager (reports.edit) may close one left open.
async function close(business, user, shiftId, body) {
  await access.require(business, 'sales.create');
  const counted = amount(body.countedCash, 'Cash counted');
  const reason = v.optionalString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const shift = await repo.one(db, 'SELECT * FROM business_counter_shifts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, v.requiredId(shiftId, 'Shift')]);
    if (!shift) fail('Shift not found', 404);
    access.requireLocation(business, shift.location_id);
    if (shift.closed_at) fail('This shift is already closed', 409);
    if (String(shift.user_id) !== String(user.id)) await access.require(business, 'reports.edit');
    const now = await repo.one(db, 'SELECT now() AS at');
    const movement = await cashMovement(db, business, { locationId: shift.location_id, userId: shift.user_id, from: shift.opened_at, to: now.at });
    const expected = paise(shift.opening_cash) + movement;
    const difference = counted - expected;
    if (difference !== 0 && !reason) {
      throw new AppError(400, `The drawer is ${money(Math.abs(difference))} ${difference < 0 ? 'short' : 'over'}. Say why.`,
        { reason: 'difference_reason_required', expected: money(expected), counted: money(counted), difference: money(difference) });
    }
    const row = await repo.one(db, `UPDATE business_counter_shifts SET closed_at=$3,closed_by=$4,movement_cash=$5,expected_cash=$6,counted_cash=$7,difference=$8,reason=$9
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, shift.id, now.at, user.id, money(movement), money(expected), money(counted), money(difference), difference ? reason : null]);
    await repo.audit(db, business.id, user.id, 'shift.closed', row.id, { cashierId: shift.user_id, expected: row.expected_cash, counted: row.counted_cash, difference: row.difference, reason: row.reason });
    return row;
  });
}

// The shifts opened on a day (all cashiers for someone who sees reports or
// sales; a cashier sees their own), open ones with their cash so far.
async function list(business, user, query) {
  await access.require(business, 'sales.create');
  const seesAll = access.can(business, 'reports.view') || access.can(business, 'sales.view');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(new Date());
  const day = query.date ? require('./business.service').dateText(query.date, 'Date') : today;
  const locationId = query.location ? v.requiredId(query.location, 'Location') : (business.location_scope || null);
  if (locationId) access.requireLocation(business, locationId);
  const rows = await repo.all(repo.pool, `${SELECT} WHERE s.business_id=$1 AND (s.opened_at AT TIME ZONE $2)::date=$3::date
    AND ($4::bigint IS NULL OR s.location_id=$4) AND ($5::bigint IS NULL OR s.user_id=$5) ORDER BY s.opened_at DESC`,
  [business.id, business.timezone, day, locationId, seesAll ? null : user.id]);
  return { date: day, items: await Promise.all(rows.map((row) => withFigures(repo.pool, business, row))) };
}

module.exports = { current, open, close, list };
