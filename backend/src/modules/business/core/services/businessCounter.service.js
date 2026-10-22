const repo = require('../repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const access = require('./businessAccess.service');

// Per-staff PIN at a shared counter (round 2, R2-CORE).
//
// A shop's till stays signed in all day. Each cashier switches the till to
// themselves with their own PIN (no sign-out, the bill being built stays),
// and every bill then records who billed it (business_documents.created_by is
// the person the till is switched to). With "Ask the PIN for every bill" on
// (Business settings › Prices, totals and numbering), Quick bill asks the biller's PIN before each
// bill and the server checks it.
//
// Nothing new about PINs: the person's own PIN (My profile, or set by an
// admin under Users), checked by the access module with its five-try lock,
// the account lock and the two-step device rule (auth.service › switchToRow,
// checkPin).

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const auth = () => require('../../../access/services/auth.service');
const users = () => require('../../../access/repositories/user.repository');

// Members who may bill here: active, in an active role that holds sales.create.
const SELLERS = `FROM business_memberships m
  JOIN users u ON u.id=m.user_id AND u.status='active'
  JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
  WHERE m.business_id=$1 AND m.active
    AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code='sales.create'))`;

async function staff(business, user) {
  await access.require(business, 'sales.create');
  const rows = await repo.all(repo.pool, `SELECT u.id,u.name,r.name AS role_name,(u.pin_hash IS NOT NULL) AS has_pin,
      COALESCE(u.pin_locked_until > now(),false) AS locked ${SELLERS} ORDER BY u.name`, [business.id]);
  return { current: Number(user.id), people: rows.map((r) => ({ id: Number(r.id), name: r.name, roleName: r.role_name, hasPin: r.has_pin, locked: r.locked })) };
}

// The till carries on as another member: their PIN, every lock rule. Returns
// a session for that person (token, user), exactly like the restaurant till.
async function switchTo(business, user, body, meta = {}) {
  await access.require(business, 'sales.create');
  const userId = v.requiredId(body.userId, 'Person');
  const member = await repo.one(repo.pool, `SELECT u.id ${SELLERS} AND u.id=$2`, [business.id, userId]);
  if (!member) fail('That person does not bill at this business', 404);
  if (typeof body.pin !== 'string' || !/^\d{4,6}$/.test(body.pin)) fail('Enter the PIN (4 to 6 digits)');
  const row = await users().findPinById(userId);
  const session = await auth().switchToRow(user, row, { pin: body.pin, deviceTokens: body.deviceTokens }, meta);
  await repo.transaction((db) => repo.audit(db, business.id, userId, 'counter.switched', null, { from: Number(user.id), to: userId }));
  return session;
}

// "Ask the PIN for every bill": the PIN of the person the till is switched to.
async function checkBill(business, user, pin) {
  const setting = await repo.one(repo.pool, 'SELECT counter_pin_every_bill FROM business_settings WHERE business_id=$1', [business.id]);
  if (!setting?.counter_pin_every_bill) return;
  if (pin === undefined || pin === null || pin === '') {
    fail('This business asks the biller\'s PIN for every bill. Enter your PIN.', 403, { reason: 'pin_required' });
  }
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) fail('Enter the PIN (4 to 6 digits)', 400, { reason: 'wrong_pin' });
  const row = await users().findPinById(user.id);
  await auth().checkPin(row, pin);
}

module.exports = { staff, switchTo, checkBill };
