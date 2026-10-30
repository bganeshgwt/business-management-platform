const bcrypt = require('bcrypt');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const config = require('../../../../config/env');
const access = require('../../core/services/businessAccess.service');
const userRepository = require('../../../access/repositories/user.repository');
const auth = () => require('../../../access/services/auth.service');

// A manager's say-so on the counter, the same way the
// wholesale credit hold is released: { reason, approverId?, pin? }.
//   - The approver must be a member of this business whose role holds the
//     permission (or full access).
//   - Their PIN (My profile › Personal PIN; five wrong tries lock it) is checked.
//     A PIN someone else set for them approves nothing until they choose
//     their own (409 pin_not_own).
//   - With `selfWithoutPin`, a person who holds the permission themselves
//     may approve their own action with only the reason (booking overrides).
//     Money leaving the drawer (refunds) always needs the PIN, the person's
//     own if they are the manager.
// Read BEFORE the caller's transaction: a PIN check holds no locks.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };

async function readApproval(business, user, body, permission, { reasonLabel = 'Reason', selfWithoutPin = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Give the reason and the manager\'s PIN', 400, { reason: 'approval_needed' });
  const reason = v.requiredString(body.reason, reasonLabel, 300);
  const self = body.approverId === undefined || body.approverId === null || body.approverId === '' || Number(body.approverId) === Number(user.id);
  if (self && selfWithoutPin && access.can(business, permission) && (body.pin === undefined || body.pin === null || body.pin === '')) {
    return { reason, approver: { id: Number(user.id), name: user.name } };
  }
  const approverId = self ? Number(user.id) : v.requiredId(body.approverId, 'Manager');
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!/^\d{4,8}$/.test(pin)) fail('Enter the manager\'s PIN (4 to 8 digits)', 400, { reason: 'approval_needed' });
  let approverBusiness;
  try {
    approverBusiness = await access.load({ id: approverId }, business.id);
  } catch {
    fail('That person is not a member of this business', 400, { reason: 'not_an_approver' });
  }
  if (!access.can(approverBusiness, permission)) fail('That person cannot approve this', 403, { reason: 'not_an_approver' });
  const person = await repo.one(repo.pool, "SELECT id,name,pin_hash,pin_must_change FROM users WHERE id=$1 AND status='active'", [approverId]);
  if (!person?.pin_hash) fail(`${person?.name || 'That person'} has not set a PIN yet (My profile › Personal PIN).`, 409, { reason: 'no_pin' });
  // A PIN someone else set approves nothing as its person, theirs included.
  auth().assertOwnPin(person, { self: Number(person.id) === Number(user.id) });
  const slot = await userRepository.reservePinAttempt(person.id, config.accountLock);
  if (!slot.allowed) fail(`${person.name}'s PIN is locked after too many wrong tries. Try again later.`, 423, { reason: 'pin_locked' });
  if (!(await bcrypt.compare(pin, person.pin_hash))) {
    const miss = await userRepository.recordPinMiss(person.id, slot.place, config.accountLock);
    fail(miss.justLocked ? `${person.name}'s PIN is now locked after too many wrong tries.` : `That PIN is not right. ${miss.attemptsLeft} tr${miss.attemptsLeft === 1 ? 'y' : 'ies'} left.`,
      miss.justLocked ? 423 : 400, { reason: miss.justLocked ? 'pin_locked' : 'wrong_pin' });
  }
  await userRepository.recordPinHit(person.id);
  return { reason, approver: { id: Number(person.id), name: person.name } };
}

// Who may approve: members whose role holds the permission, with whether they have a PIN
// and whether someone else set it (pin_given: it approves nothing until they choose their own).
const APPROVALS = ['appointments.approve', 'sales.refund'];
async function approvers(business, permission) {
  if (!APPROVALS.includes(permission)) fail('Unknown approval', 400);
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin,u.pin_must_change AS pin_given FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code=$2))
    ORDER BY u.name`, [business.id, permission]);
}

module.exports = { readApproval, approvers };
