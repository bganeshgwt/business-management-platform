const bcrypt = require('bcrypt');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const config = require('../../../../config/env');
const access = require('../../core/services/businessAccess.service');
const userRepository = require('../../../access/repositories/user.repository');
const receivables = require('./businessReceivables.service');
const core = require('../../core/services/business.service');

// Wholesale credit control and customer details (pro pass D-07, D-16).
//
//   Credit hold   Business setting "hold new orders when a bill is more than N
//                 days past its due date". A held customer's order is refused
//                 (409, reason credit_hold) unless someone with credit control
//                 (receivables.approve) lets it through with a reason: the
//                 person taking the order if they hold it, otherwise a
//                 manager who types their own PIN (the PIN they set under My
//                 profile; five wrong tries lock it). Each release is kept
//                 with the order and in the activity log. A customer can be
//                 marked "never hold".
//   Customer      price group, contact person, state and PIN code (place of
//   details       supply when there is no GSTIN), PAN, FSSAI, trade or
//                 walk-in (walk-ins stay out of order and collection lists).

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));

// --- Settings ---------------------------------------------------------------------

// Defaults when nothing is saved yet: no overdue hold; a bounced cheque
// costs the customer Rs 500 and 2 bounces in 90 days hold new orders.
const DEFAULTS = { hold_overdue_days: null, bounce_charge: '500.00', bounce_hold_count: 2, bounce_hold_days: 90 };
async function settings(business, db = repo.pool) {
  const row = await repo.one(db, 'SELECT * FROM wholesale_settings WHERE business_id=$1', [business.id]);
  return row || { business_id: business.id, ...DEFAULTS };
}
// body: { holdOverdueDays?, bounceCharge?, bounceHoldCount?, bounceHoldDays? } —
// a field left out keeps what is saved.
async function saveSettings(business, user, body) {
  await access.require(business, 'settings.edit');
  const blank = (x) => x === null || x === '';
  return repo.transaction(async (db) => {
    const current = await settings(business, db);
    const days = body.holdOverdueDays === undefined ? current.hold_overdue_days : blank(body.holdOverdueDays) ? null : Number(body.holdOverdueDays);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) fail('Hold after must be a whole number of days from 1 to 365, or empty for no hold');
    const charge = body.bounceCharge === undefined ? Number(current.bounce_charge) : core.decimal(body.bounceCharge, 'Bounced cheque charge', 2, 0, 100000);
    const count = body.bounceHoldCount === undefined ? current.bounce_hold_count : blank(body.bounceHoldCount) ? null : Number(body.bounceHoldCount);
    if (count !== null && (!Number.isInteger(count) || count < 1 || count > 20)) fail('Hold after bounced cheques must be a whole number from 1 to 20, or empty for never');
    const window = body.bounceHoldDays === undefined ? current.bounce_hold_days : Number(body.bounceHoldDays);
    if (!Number.isInteger(window) || window < 7 || window > 365) fail('The bounce window must be whole days from 7 to 365');
    const row = await repo.one(db, `INSERT INTO wholesale_settings(business_id,hold_overdue_days,bounce_charge,bounce_hold_count,bounce_hold_days,updated_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(business_id) DO UPDATE SET hold_overdue_days=EXCLUDED.hold_overdue_days,bounce_charge=EXCLUDED.bounce_charge,bounce_hold_count=EXCLUDED.bounce_hold_count,
      bounce_hold_days=EXCLUDED.bounce_hold_days,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [business.id, days, charge.toFixed(2), count, window, user.id]);
    await repo.audit(db, business.id, user.id, 'wholesale.settings_updated', business.id, { holdOverdueDays: days, bounceCharge: charge.toFixed(2), bounceHoldCount: count, bounceHoldDays: window });
    return row;
  });
}

// --- Customer details ------------------------------------------------------------------

async function profile(business, contactId, db = repo.pool) {
  const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  const row = await repo.one(db, `SELECT p.*,g.name AS price_group_name FROM wholesale_customer_profiles p
    LEFT JOIN wholesale_price_groups g ON g.business_id=p.business_id AND g.id=p.price_group_id WHERE p.business_id=$1 AND p.contact_id=$2`, [business.id, contact.id]);
  const beat = await repo.one(db, `SELECT cb.beat_id,b.name AS beat_name,b.route_id,r.name AS route_name,b.salesperson_id,s.name AS salesperson_name,b.visit_day
    FROM wholesale_customer_beats cb JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
    JOIN wholesale_routes r ON r.business_id=b.business_id AND r.id=b.route_id
    LEFT JOIN wholesale_salespeople s ON s.business_id=b.business_id AND s.id=b.salesperson_id WHERE cb.business_id=$1 AND cb.contact_id=$2`, [business.id, contact.id]);
  return { contact_id: contact.id, price_group_id: null, contact_person: null, state_code: null, pin_code: null, pan: null, fssai: null,
    trade_type: 'trade', hold_exempt: false, ...(row || {}), beat: beat || null };
}
async function readProfile(body) {
  const state = v.optionalString(body.stateCode, 'State', 2);
  if (state && !/^[0-9]{2}$/.test(state)) fail('State must be the two-digit GST state code');
  const pin = v.optionalString(body.pinCode, 'PIN code', 10);
  if (pin && !/^[1-9][0-9]{5}$/.test(pin)) fail('PIN code must be six digits');
  const pan = v.optionalString(body.pan, 'PAN', 10)?.toUpperCase() || null;
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fail('PAN must look like ABCDE1234F');
  const fssai = v.optionalString(body.fssai, 'FSSAI licence', 20);
  if (fssai && !/^[0-9]{14}$/.test(fssai)) fail('FSSAI licence number has 14 digits');
  return {
    priceGroupId: optionalId(body.priceGroupId, 'Price group'), contactPerson: v.optionalString(body.contactPerson, 'Contact person', 100),
    stateCode: state, pinCode: pin, pan, fssai,
    tradeType: v.optionalEnum(body.tradeType, 'Customer type', ['trade', 'walk_in'], 'trade'),
    holdExempt: v.requiredBoolean(body.holdExempt, 'Never hold', false),
  };
}
// Saves the details; a beat (beatId, null to take them off) goes through Routes' own rule.
async function saveProfile(business, user, contactId, body) {
  await access.require(business, 'contacts.edit');
  const p = await readProfile(body);
  if (p.holdExempt) await access.require(business, 'receivables.approve');
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' FOR UPDATE", [business.id, id(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    if (p.priceGroupId && !(await repo.one(db, 'SELECT id FROM wholesale_price_groups WHERE business_id=$1 AND id=$2 AND active', [business.id, p.priceGroupId]))) fail('Price group not found', 404);
    const before = await repo.one(db, 'SELECT hold_exempt FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]);
    // Switching "never hold" off is also credit control's call.
    if (before?.hold_exempt && !p.holdExempt) await access.require(business, 'receivables.approve');
    await repo.one(db, `INSERT INTO wholesale_customer_profiles(business_id,contact_id,price_group_id,contact_person,state_code,pin_code,pan,fssai,trade_type,hold_exempt,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(business_id,contact_id) DO UPDATE SET price_group_id=EXCLUDED.price_group_id,
      contact_person=EXCLUDED.contact_person,state_code=EXCLUDED.state_code,pin_code=EXCLUDED.pin_code,pan=EXCLUDED.pan,fssai=EXCLUDED.fssai,
      trade_type=EXCLUDED.trade_type,hold_exempt=EXCLUDED.hold_exempt,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, contact.id, p.priceGroupId, p.contactPerson, p.stateCode, p.pinCode, p.pan, p.fssai, p.tradeType, p.holdExempt, user.id]);
    if (body.beatId !== undefined) {
      await access.require(business, 'sales_orders.edit');
      const beatId = optionalId(body.beatId, 'Beat');
      if (beatId) {
        if (!(await repo.one(db, 'SELECT id FROM wholesale_beats WHERE business_id=$1 AND id=$2 AND active', [business.id, beatId]))) fail('Beat not found', 404);
        await db.query(`INSERT INTO wholesale_customer_beats(business_id,contact_id,beat_id,updated_by) VALUES($1,$2,$3,$4)
          ON CONFLICT(business_id,contact_id) DO UPDATE SET beat_id=EXCLUDED.beat_id,updated_by=EXCLUDED.updated_by,updated_at=now()`, [business.id, contact.id, beatId, user.id]);
      } else await db.query('DELETE FROM wholesale_customer_beats WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]);
    }
    await repo.audit(db, business.id, user.id, 'customer.trade_details_saved', contact.id, { ...p, ...(body.beatId !== undefined ? { beatId: body.beatId || null } : {}) });
    return profile(business, contact.id, db);
  });
}

// --- Credit hold -----------------------------------------------------------------------------

// Whether a customer is on hold now: { held, reason, days, overdue, limitDays,
// oldestDue, bounces, bounceLimit, bounceDays }. Two reasons: a bill past the
// overdue limit, or (round 2) the bounced-cheque limit reached in the window
// (it lifts by itself once the oldest of those bounces is out of the window).
async function holdOf(db, business, contactId) {
  const setting = await settings(business, db);
  const exempt = await repo.one(db, 'SELECT hold_exempt FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, contactId]);
  let overdue = { days: 0, overdue: '0', oldest_due: null };
  if (setting.hold_overdue_days) {
    overdue = await repo.one(db, `SELECT COALESCE(max(days_overdue),0)::int AS days,
        COALESCE(sum(open_amount) FILTER (WHERE days_overdue>$3),0) AS overdue, min(due_on) FILTER (WHERE days_overdue>$3) AS oldest_due
      FROM (${receivables.openItemsSql}) oi WHERE open_amount>0`, [business.id, contactId, setting.hold_overdue_days]);
  }
  const bounces = setting.bounce_hold_count ? await receivables.recentBounces(db, business.id, contactId, setting.bounce_hold_days) : { bounces: 0 };
  const byOverdue = Boolean(setting.hold_overdue_days) && overdue.days > setting.hold_overdue_days;
  const byBounces = Boolean(setting.bounce_hold_count) && bounces.bounces >= setting.bounce_hold_count;
  const held = !exempt?.hold_exempt && (byOverdue || byBounces);
  return { held, reason: byOverdue ? 'overdue' : byBounces ? 'bounced_cheques' : null, exempt: Boolean(exempt?.hold_exempt),
    days: overdue.days, overdue: overdue.overdue, oldestDue: overdue.oldest_due, limitDays: setting.hold_overdue_days,
    bounces: bounces.bounces, bounceLimit: setting.bounce_hold_count, bounceDays: setting.bounce_hold_days };
}

// Reads a release ({ reason, approverId?, pin? }) BEFORE the order's
// transaction (a PIN check holds no locks of the order): returns
// { reason, approver: { id, name } } or null. The person taking the order
// releases it themselves when they hold credit control; anyone else needs a
// manager's PIN.
async function readRelease(business, user, body) {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) fail('Release must be an object');
  const reason = v.requiredString(body.reason, 'Reason for letting the order through', 300);
  if (access.can(business, 'receivables.approve') && (body.approverId === undefined || body.approverId === null || Number(body.approverId) === Number(user.id))) {
    return { reason, approver: { id: user.id, name: user.name } };
  }
  const approverId = id(body.approverId, 'Manager');
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!/^\d{4,8}$/.test(pin)) fail('Enter the manager\'s PIN (4 to 8 digits)');
  let approverBusiness;
  try {
    approverBusiness = await access.load({ id: approverId }, business.id);
  } catch {
    fail('That person is not a member of this business', 400, { reason: 'not_an_approver' });
  }
  if (!access.can(approverBusiness, 'receivables.approve')) fail('That person cannot let orders through a credit hold', 403, { reason: 'not_an_approver' });
  const person = await repo.one(repo.pool, "SELECT id,name,pin_hash,pin_locked_until FROM users WHERE id=$1 AND status='active'", [approverId]);
  if (!person?.pin_hash) fail(`${person?.name || 'That person'} has not set a PIN yet (My profile › Personal PIN).`, 409, { reason: 'no_pin' });
  const slot = await userRepository.reservePinAttempt(person.id, config.accountLock);
  if (!slot.allowed) fail(`${person.name}'s PIN is locked after too many wrong tries. Try again later.`, 423, { reason: 'pin_locked' });
  if (!(await bcrypt.compare(pin, person.pin_hash))) {
    const miss = await userRepository.recordPinMiss(person.id, slot.place, config.accountLock);
    fail(miss.justLocked ? `${person.name}'s PIN is now locked after too many wrong tries.` : `That PIN is not right. ${miss.attemptsLeft} tr${miss.attemptsLeft === 1 ? 'y' : 'ies'} left.`,
      miss.justLocked ? 423 : 400, { reason: miss.justLocked ? 'pin_locked' : 'wrong_pin' });
  }
  await userRepository.recordPinHit(person.id);
  return { reason, approver: { id: person.id, name: person.name } };
}

// Inside the order's transaction: refuses a held customer's order unless it
// was released, and records the release against the order (afterwards, with
// recordRelease, once the order exists).
async function checkHold(db, business, contact, release) {
  const hold = await holdOf(db, business, contact.id);
  if (!hold.held) return null;
  if (!release) {
    const why = hold.reason === 'overdue'
      ? `${Number(hold.overdue).toFixed(2)} is more than ${hold.limitDays} days past due (oldest due ${hold.oldestDue}, ${hold.days} days late)`
      : `${hold.bounces} cheques bounced in the last ${hold.bounceDays} days`;
    fail(`${contact.name} is on credit hold: ${why}. Collect first, or ask a manager to let this order through.`, 409,
      { reason: 'credit_hold', holdReason: hold.reason, overdue: hold.overdue, days: hold.days, limitDays: hold.limitDays, oldestDue: hold.oldestDue, bounces: hold.bounces, bounceDays: hold.bounceDays });
  }
  return hold;
}
async function recordRelease(db, business, user, order, contact, hold, release) {
  await db.query(`INSERT INTO wholesale_hold_releases(business_id,order_id,contact_id,overdue,overdue_days,reason,released_by,requested_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [business.id, order.id, contact.id, hold.overdue, hold.days, release.reason, release.approver.id, user.id]);
  await repo.audit(db, business.id, release.approver.id, 'sales_order.hold_released', order.id, {
    orderNo: order.order_no, customer: contact.name, holdReason: hold.reason, overdue: hold.overdue, days: hold.days, bounces: hold.bounces, reason: release.reason, requestedBy: user.id,
  });
}

// People who may let an order through (for the PIN prompt's list).
async function releasers(business) {
  await access.require(business, 'sales_orders.create');
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code='receivables.approve'))
    ORDER BY u.name`, [business.id]);
}

module.exports = { settings, saveSettings, profile, saveProfile, holdOf, readRelease, checkHold, recordRelease, releasers };
