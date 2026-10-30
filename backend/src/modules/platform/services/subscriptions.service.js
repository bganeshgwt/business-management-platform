const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const { STATES, gstinProblem } = require('../../../utils/gstin');
const math = require('./planMath');
const settings = require('./planSettings.service');
const catalogue = require('./planCatalogue.service');
const invoices = require('./planInvoices.service');

// Paid plans for one business: its state and what it may use, its selection
// for the next order, orders with GST, payments entered by reference and
// confirmed by the super admin, given time and given add-ons. The money rules
// live here; the database keeps the state and the guards (migration
// paid-plans).
//
// Every change locks the business row first, then the order, then (issuing an
// invoice) the invoice series, so two people at once queue up: two confirms of
// one payment, or a confirm and a reject, leave one decision, one invoice and
// one period. applyPayment() is the one way a payment takes effect; the online
// gateway will call it too.

// The switch-off checks a renewal that drops a module must pass (loaded when
// first needed: they bring the restaurant's services).
const setup = () => require('../../business/core/services/businessSetup.service');

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const ORDER_VALID_DAYS = 7;
const METHODS = ['upi', 'bank', 'cash', 'cheque'];
const PERIOD_WORDS = { month: 'a month', year: 'a year' };

const businessToday = async (db, businessId) => (await repo.one(db, 'SELECT business_local_today($1)::text AS today', [businessId])).today;
// The company's own date (India), for its invoices.
const companyToday = async (db) => (await repo.one(db, "SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today")).today;

async function lockBusiness(db, businessId) {
  const row = await repo.one(db, 'SELECT * FROM businesses WHERE id=$1 FOR UPDATE', [v.requiredId(businessId, 'Business')]);
  if (!row) fail('Business not found', 404);
  return row;
}

function dateText(value, name) {
  const text = v.requiredString(value, name, 10);
  try { math.addDays(text, 0); } catch { fail(`${name} must be a date (YYYY-MM-DD)`); }
  return text;
}

// --- The state ------------------------------------------------------------------------

// business_plan_state() as the screens use it, with the days left of the
// time the business is in: the trial, paid or given time, grace, or the
// payment being checked.
function toPlan(row) {
  const end = { trial: row.trial_ends_on, paid: row.access_ends_on, given: row.access_ends_on, grace: row.grace_ends_on, checking: row.checking_until }[row.state];
  return {
    state: row.state, accessEndsOn: row.access_ends_on, trialEndsOn: row.trial_ends_on, graceEndsOn: row.grace_ends_on, checkingUntil: row.checking_until,
    periodKind: row.period_kind, everything: row.everything, daysLeft: end ? Math.max(0, math.daysBetweenInclusive(row.today, end)) : null,
  };
}
async function planOf(businessId, db = repo.pool) {
  const row = await repo.one(db, 'SELECT s.*,business_local_today($1)::text AS today FROM business_plan_state($1) s', [businessId]);
  return row ? toPlan(row) : null;
}
// The same for every member of a business, without prices: the banner's.
const bannerOf = (plan) => (plan ? {
  state: plan.state, accessEndsOn: plan.accessEndsOn, trialEndsOn: plan.trialEndsOn, graceEndsOn: plan.graceEndsOn, daysLeft: plan.daysLeft,
} : null);

const entitledOf = async (db, businessId) => (await repo.one(db, 'SELECT business_entitled_modules($1) AS m', [businessId])).m;

// "Your access is arranged by <brand>": an owner on given time asks the company.
async function givenTimeRefusal(db) {
  const company = await settings.get(db);
  const contact = [company.support_phone || company.phone, company.support_email || company.email].filter(Boolean).join(', ');
  return new AppError(409, `Your access is arranged by ${company.brand_name}. Contact us to change it${contact ? ` (${contact})` : ''}.`, { reason: 'given_time' });
}

// --- The selection ---------------------------------------------------------------------

async function selectionOf(db, businessId) {
  const sub = await repo.one(db, `SELECT s.plan_code,s.billing_period,p.name AS plan_name,p.active AS plan_active,p.monthly_price,p.yearly_price,s.updated_at
    FROM business_subscriptions s LEFT JOIN platform_plans p ON p.code=s.plan_code WHERE s.business_id=$1`, [businessId]);
  if (!sub) return null;
  const addons = await repo.all(db, `SELECT a.module_code AS code,m.name,pr.sold_as,pr.monthly_price,pr.yearly_price FROM business_subscription_addons a
    JOIN platform_modules m ON m.code=a.module_code LEFT JOIN platform_module_prices pr ON pr.module_code=a.module_code
    WHERE a.business_id=$1 ORDER BY m.sort_order`, [businessId]);
  return {
    planCode: sub.plan_code, planName: sub.plan_name, planOffered: sub.plan_active, billingPeriod: sub.billing_period,
    monthly: sub.monthly_price, yearly: sub.yearly_price, updatedAt: sub.updated_at,
    addons: addons.map((a) => ({ code: a.code, name: a.name, soldAs: a.sold_as, monthly: a.monthly_price, yearly: a.yearly_price })),
  };
}

const planModules = async (db, planCode) => (await repo.all(db, 'SELECT module_code FROM platform_plan_modules WHERE plan_code=$1', [planCode])).map((r) => r.module_code);
const nameOf = async (db, code) => (await repo.one(db, 'SELECT name FROM platform_modules WHERE code=$1', [code]))?.name || code;

// Every module bought needs what it depends on: in the plan, among the
// modules bought with it, or (an add-on mid-period) already unlocked.
async function checkNeeds(db, codes, have) {
  const needs = await repo.all(db, `SELECT d.module_code,d.requires_module_code FROM platform_module_dependencies d
    WHERE d.module_code=ANY($1::text[]) AND d.requires_module_code<>'restaurant' ORDER BY d.module_code,d.requires_module_code`, [codes]);
  for (const need of needs) {
    if (!have.has(need.requires_module_code)) {
      const [name, needed] = [await nameOf(db, need.module_code), await nameOf(db, need.requires_module_code)];
      fail(`${name} needs ${needed}. Add ${needed} too.`);
    }
  }
}

// The plan, month or year, and add-ons the next order is made of. It never
// changes what the business may use today. An owner on given time asks the
// company instead.
async function setSelection(business, user, body = {}, { by = 'owner' } = {}) {
  const planCode = v.requiredString(body.planCode, 'Plan', 40);
  const billingPeriod = v.requiredEnum(body.billingPeriod, 'Billing period', ['month', 'year']);
  const wanted = [...new Set(v.requiredArray(body.addons ?? [], 'Add-ons').map((code) => String(code)))];
  return repo.transaction(async (db) => {
    const row = await lockBusiness(db, business.id);
    if (by === 'owner' && (await planOf(row.id, db)).state === 'given') throw await givenTimeRefusal(db);
    const plan = await repo.one(db, 'SELECT * FROM platform_plans WHERE code=$1 AND business_type=$2', [planCode, row.business_type]);
    if (!plan) fail('That plan is not offered for this type of business');
    if (!plan.active) fail(`${plan.name} is no longer offered. Choose another plan.`);
    const included = await planModules(db, plan.code);
    const offered = await repo.all(db, `SELECT m.code,m.name,pr.available FROM platform_module_business_types t
      JOIN platform_modules m ON m.code=t.module_code AND m.kind='optional' JOIN platform_module_prices pr ON pr.module_code=m.code
      WHERE t.business_type=$1 AND m.code<>'restaurant'`, [row.business_type]);
    // A module the plan already includes needs no add-on.
    const addons = wanted.filter((code) => !included.includes(code));
    for (const code of addons) {
      const module = offered.find((m) => m.code === code);
      if (!module) fail(`${code} cannot be added to this type of business`);
      if (by === 'owner' && !module.available) fail(`${module.name} is not offered as an add-on. Contact us to add it.`);
    }
    await checkNeeds(db, addons, new Set([...included, ...addons]));
    await db.query('UPDATE business_subscriptions SET plan_code=$2,billing_period=$3,updated_by=$4,updated_at=now() WHERE business_id=$1',
      [row.id, plan.code, billingPeriod, user.id]);
    await db.query('DELETE FROM business_subscription_addons WHERE business_id=$1', [row.id]);
    if (addons.length) {
      await db.query('INSERT INTO business_subscription_addons(business_id,module_code,added_by) SELECT $1,unnest($2::text[]),$3', [row.id, addons, user.id]);
    }
    await repo.audit(db, row.id, user.id, 'plan.selection_changed', row.id, { planCode: plan.code, billingPeriod, addons, by });
    return selectionOf(db, row.id);
  });
}

// --- Orders ------------------------------------------------------------------------------

// The buyer as billed, and the place of supply: the state of the business's
// GSTIN when it has one, else its state in Business settings. A restaurant
// keeps its GSTIN in its own settings; an order may bring the state when the
// business has none yet (the restaurant's has no screen for it).
async function buyerOf(db, business, stateCode, user) {
  const s = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const r = business.legacy_restaurant_id
    ? await repo.one(db, `SELECT r.name,r.address,rs.gst_number FROM restaurants r LEFT JOIN restaurant_settings rs ON rs.restaurant_id=r.id WHERE r.id=$1`, [business.legacy_restaurant_id])
    : null;
  const ownGstin = r && r.gst_number && !gstinProblem(r.gst_number) ? String(r.gst_number).replace(/[\s-]/g, '').toUpperCase() : null;
  const gstin = (s && s.gstin) || ownGstin;
  let state = gstin ? gstin.slice(0, 2) : s && s.state_code;
  if (!state && stateCode) {
    await db.query('UPDATE business_settings SET state_code=$2,updated_by=$3,updated_at=now() WHERE business_id=$1', [business.id, stateCode, user.id]);
    await repo.audit(db, business.id, user.id, 'settings.state_set', business.id, { stateCode });
    state = stateCode;
  }
  if (!state) fail("Add your business's state (for GST) first: it is the place of supply on the invoice.", 409, { reason: 'state_required' });
  return {
    name: (s && (s.legal_name || s.display_name)) || (r && r.name) || business.name, gstin: gstin || null,
    addressLine1: (s && s.address_line1) || (r && r.address) || null, addressLine2: (s && s.address_line2) || null,
    city: (s && s.city) || null, postalCode: (s && s.postal_code) || null, stateCode: state, stateName: STATES[state] || null,
  };
}

const priceFor = (row, billingPeriod) => (billingPeriod === 'month' ? row.monthly_price : row.yearly_price);
const itemKind = (soldAs) => (soldAs === 'application' ? 'application' : 'module');

// A renewal starts the day after the current trial, paid or given time ends,
// so no day is lost; in grace, the day after the old end; once ended, today.
async function renewalStart(db, businessId, today) {
  const row = await repo.one(db, `SELECT max(ends_on)::text AS last_end,bool_or(ends_on IS NULL) AS no_end FROM business_access_periods
    WHERE business_id=$1 AND cancelled_at IS NULL`, [businessId]);
  const state = await repo.one(db, 'SELECT grace_ends_on::text FROM business_plan_state($1)', [businessId]);
  if (row.no_end) return null;
  if (!row.last_end) return today;
  if (row.last_end >= today || (state.grace_ends_on && today <= state.grace_ends_on)) return math.addDays(row.last_end, 1);
  return today;
}

// Plan and add-ons for one period at their full prices, from the selection.
// A module switched on now that the order leaves out must pass its switch-off
// checks (money still held, expenses recorded), or the order is refused.
async function subscriptionDraft(db, business, today, by) {
  const sub = await repo.one(db, 'SELECT * FROM business_subscriptions WHERE business_id=$1', [business.id]);
  if (!sub || !sub.plan_code) fail('Choose a plan first', 409);
  const plan = await repo.one(db, 'SELECT * FROM platform_plans WHERE code=$1', [sub.plan_code]);
  if (!plan.active) fail(`${plan.name} is no longer offered. Choose another plan in Your plan.`, 409);
  const startsOn = await renewalStart(db, business.id, today);
  if (!startsOn) {
    if (by === 'owner') throw await givenTimeRefusal(db);
    fail('This business has given time with no end. Give it an end date first, then make the order.', 409);
  }
  const endsOn = math.periodEnd(startsOn, sub.billing_period);
  const days = math.daysBetweenInclusive(startsOn, endsOn);
  const included = await planModules(db, plan.code);
  const addons = (await repo.all(db, `SELECT a.module_code,m.name,pr.* FROM business_subscription_addons a JOIN platform_modules m ON m.code=a.module_code
    LEFT JOIN platform_module_prices pr ON pr.module_code=a.module_code WHERE a.business_id=$1 ORDER BY m.sort_order`, [business.id]))
    .filter((a) => !included.includes(a.module_code));
  const planPrice = priceFor(plan, sub.billing_period);
  if (planPrice === null) fail(`Price not set yet for ${plan.name} for ${PERIOD_WORDS[sub.billing_period]}. Contact us.`, 409, { reason: 'price_not_set' });
  const lines = [{ itemKind: 'plan', itemCode: plan.code, name: `${plan.name} plan`, fullPrice: planPrice, chargedDays: days, periodDays: days, amount: planPrice }];
  for (const addon of addons) {
    const price = priceFor(addon, sub.billing_period);
    if (price === null || price === undefined) fail(`Price not set yet for ${addon.name} for ${PERIOD_WORDS[sub.billing_period]}. Contact us.`, 409, { reason: 'price_not_set' });
    lines.push({ itemKind: itemKind(addon.sold_as), itemCode: addon.module_code, name: addon.name, fullPrice: price, chargedDays: days, periodDays: days, amount: price });
  }
  const modules = [...new Set([...included, ...addons.map((a) => a.module_code)])].sort();
  const active = (await repo.one(db, 'SELECT business_active_capabilities($1) AS m', [business.id])).m;
  for (const code of active.filter((c) => c !== 'restaurant' && !modules.includes(c))) {
    const blockers = await setup().switchOffBlockers(db, business, code);
    if (blockers.length) {
      fail(`${await nameOf(db, code)} cannot be left out of the next order yet: ${blockers[0]}`, 409, { reason: 'module_in_use', module: code, blockers });
    }
  }
  return { kind: 'subscription', planCode: plan.code, billingPeriod: sub.billing_period, startsOn, endsOn, modules, lines };
}

// Modules for the rest of the current paid period: each its full price for
// that period times the days left over the days in the period.
async function addOnDraft(db, business, today, body, by) {
  const plan = await planOf(business.id, db);
  if (plan.state === 'given' && by === 'owner') throw await givenTimeRefusal(db);
  if (plan.state === 'trial') fail('During the trial everything is unlocked. Add it to your plan for after the trial instead.', 409, { reason: 'trial' });
  if (plan.state !== 'paid') fail('Add-ons are bought for the rest of paid time. Renew your plan first.', 409, { reason: 'not_paid_time' });
  const period = await repo.one(db, `SELECT p.*,p.starts_on::text AS starts,p.ends_on::text AS ends,o.billing_period FROM business_plan_state($1) s
    JOIN business_access_periods p ON p.id=s.period_id JOIN platform_orders o ON o.id=p.order_id`, [business.id]);
  const codes = [...new Set(v.requiredArray(body.modules, 'Modules').map((code) => String(code)))];
  if (!codes.length) fail('Choose the modules to add');
  const entitled = await entitledOf(db, business.id);
  const lines = [];
  // From today, or from the period's first day while it has not begun by the
  // business's own date (its time zone moved back).
  const from = today < period.starts ? period.starts : today;
  const periodDays = math.daysBetweenInclusive(period.starts, period.ends);
  const daysLeft = math.daysBetweenInclusive(from, period.ends);
  for (const code of codes) {
    const module = await repo.one(db, `SELECT m.code,m.name,pr.* FROM platform_module_business_types t JOIN platform_modules m ON m.code=t.module_code AND m.kind='optional'
      JOIN platform_module_prices pr ON pr.module_code=m.code WHERE t.business_type=$1 AND m.code=$2 AND m.code<>'restaurant'`, [business.business_type, code]);
    if (!module) fail(`${code} cannot be added to this type of business`);
    if (by === 'owner' && !module.available) fail(`${module.name} is not offered as an add-on. Contact us to add it.`);
    if (entitled.includes(code)) fail(`${module.name} is already in your plan`, 409);
    const price = priceFor(module, period.billing_period);
    if (price === null) fail(`Price not set yet for ${module.name} for ${PERIOD_WORDS[period.billing_period]}. Contact us.`, 409, { reason: 'price_not_set' });
    const amount = math.toRupees(math.addOnCharge(math.toPaise(price), daysLeft, periodDays));
    lines.push({ itemKind: itemKind(module.sold_as), itemCode: code, name: module.name, fullPrice: price, chargedDays: daysLeft, periodDays, amount });
  }
  await checkNeeds(db, codes, new Set([...entitled, ...codes]));
  return { kind: 'add_on', planCode: null, billingPeriod: period.billing_period, startsOn: from, endsOn: period.ends, modules: codes.sort(), lines };
}

function readState(value) {
  if (value === undefined || value === null || value === '') return null;
  const code = String(value).trim().padStart(2, '0');
  if (!STATES[code]) fail('State must be a GST state code, like 29 for Karnataka');
  return code;
}

// What a paid order unlocks: a paid period after the current end, so it never
// overlaps (the order's dates unless time was added since it was made), for a
// subscription; paid add-on grants to the period's end for add-ons, which join
// the selection so the next order includes them.
async function unlock(db, businessId, paid, actor) {
  if (paid.kind === 'subscription') {
    const ends = await repo.one(db, `SELECT max(ends_on)::text AS last_end,bool_or(ends_on IS NULL) AS no_end FROM business_access_periods
      WHERE business_id=$1 AND cancelled_at IS NULL`, [businessId]);
    if (ends.no_end) fail('This business has given time with no end. Give it an end date first, then confirm the payment.', 409);
    let startsOn = paid.starts_on;
    let endsOn = paid.ends_on;
    if (ends.last_end && ends.last_end >= startsOn) {
      startsOn = math.addDays(ends.last_end, 1);
      endsOn = math.periodEnd(startsOn, paid.billing_period);
    }
    await db.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,plan_code,modules,order_id,created_by)
      VALUES($1,'paid',$2,$3,$4,$5,$6,$7)`, [businessId, startsOn, endsOn, paid.plan_code, paid.modules, paid.id, actor]);
    return;
  }
  for (const code of paid.modules) {
    await db.query(`INSERT INTO business_access_addons(business_id,module_code,kind,starts_on,ends_on,order_id,created_by) VALUES($1,$2,'paid',$3,$4,$5,$6)`,
      [businessId, code, paid.starts_on, paid.ends_on, paid.id, actor]);
  }
  await db.query(`INSERT INTO business_subscription_addons(business_id,module_code,added_by)
    SELECT $1,m,$3 FROM unnest($2::text[]) AS m WHERE NOT EXISTS (SELECT 1 FROM business_subscriptions s JOIN platform_plan_modules pm ON pm.plan_code=s.plan_code
      WHERE s.business_id=$1 AND pm.module_code=m) ON CONFLICT DO NOTHING`, [businessId, paid.modules, actor]);
}

// Makes the order: its lines and GST, valid for 7 days. One open order per
// business: a new one cancels the old, unless a payment of it is being
// checked. An order with nothing to pay (add-ons priced at nothing) is paid
// as it is made and unlocks at once, with no payment and no invoice, and
// leaves an open order as it was.
async function createOrder(business, user, body = {}, { by = 'owner' } = {}) {
  const kind = v.requiredEnum(body.kind, 'Order', ['subscription', 'add_on']);
  const stateCode = readState(body.stateCode);
  return repo.transaction(async (db) => {
    const row = await lockBusiness(db, business.id);
    if (by === 'owner' && (await planOf(row.id, db)).state === 'given') throw await givenTimeRefusal(db);
    const today = await businessToday(db, row.id);
    const open = await repo.one(db, `SELECT o.id,EXISTS (SELECT 1 FROM platform_payments p WHERE p.order_id=o.id AND p.status='pending') AS checking
      FROM platform_orders o WHERE o.business_id=$1 AND o.status='open' FOR UPDATE`, [row.id]);
    const draft = kind === 'subscription' ? await subscriptionDraft(db, row, today, by) : await addOnDraft(db, row, today, body, by);
    const buyer = await buyerOf(db, row, stateCode, user);
    const company = await settings.get(db);
    const taxable = draft.lines.reduce((sum, line) => sum + math.toPaise(line.amount), 0n);
    const tax = math.gstSplit(taxable, company.gst_rate, company.gstin.slice(0, 2), buyer.stateCode);
    const total = taxable + tax.cgst + tax.sgst + tax.igst;
    const free = total === 0n;
    if (open && !free) {
      if (open.checking) {
        fail('A payment for the open order is being checked. Wait until it is confirmed or rejected.', 409, { reason: 'payment_being_checked', orderId: open.id });
      }
      await db.query("UPDATE platform_orders SET status='cancelled',cancelled_at=now() WHERE id=$1", [open.id]);
    }
    const order = await repo.one(db, `INSERT INTO platform_orders(business_id,kind,plan_code,billing_period,starts_on,ends_on,modules,valid_until,buyer,
        supplier_state_code,place_of_supply_code,gst_rate,taxable_amount,cgst_amount,sgst_amount,igst_amount,total_amount,status,paid_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,CASE WHEN $18='paid' THEN now() END,$19) RETURNING *`,
    [row.id, draft.kind, draft.planCode, draft.billingPeriod, draft.startsOn, draft.endsOn, draft.modules, math.addDays(today, ORDER_VALID_DAYS),
      JSON.stringify(buyer), company.gstin.slice(0, 2), buyer.stateCode, company.gst_rate, math.toRupees(taxable), math.toRupees(tax.cgst),
      math.toRupees(tax.sgst), math.toRupees(tax.igst), math.toRupees(total), free ? 'paid' : 'open', user.id]);
    for (const [index, line] of draft.lines.entries()) {
      await db.query(`INSERT INTO platform_order_lines(order_id,line_no,item_kind,item_code,name,full_price,charged_days,period_days,amount)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [order.id, index + 1, line.itemKind, line.itemCode, line.name, line.fullPrice, line.chargedDays, line.periodDays, line.amount]);
    }
    await repo.audit(db, row.id, user.id, 'plan.order_created', order.id, { kind, total: order.total_amount, startsOn: draft.startsOn, endsOn: draft.endsOn,
      by, ...(open && !free ? { cancelledOrder: open.id } : {}) });
    if (free) {
      await unlock(db, row.id, order, user.id);
      await repo.audit(db, row.id, user.id, 'plan.order_granted', order.id, { kind, modules: order.modules });
    }
    return orderView(db, order);
  });
}

// --- Payments ----------------------------------------------------------------------------

const toPayment = (row) => ({
  id: row.id, orderId: row.order_id, amount: row.amount, method: row.method, reference: row.reference, paidOn: row.paid_on, status: row.status,
  submittedAt: row.submitted_at, decidedAt: row.decided_at, decisionNote: row.decision_note,
});

// The owner says they have paid: how, the reference (a UPI or bank
// transaction number, a cheque number) and the date. The super admin checks it.
async function submitPayment(business, user, orderId, body = {}) {
  const method = v.requiredEnum(body.method, 'Paid by', METHODS);
  const reference = v.requiredString(body.reference, 'Payment reference', 100);
  const paidOn = dateText(body.paidOn, 'Date paid');
  return repo.transaction(async (db) => {
    const row = await lockBusiness(db, business.id);
    const order = await repo.one(db, 'SELECT *,valid_until::text AS valid FROM platform_orders WHERE business_id=$1 AND id=$2 FOR UPDATE',
      [row.id, v.requiredId(orderId, 'Order')]);
    if (!order) fail('Order not found', 404);
    if (order.status !== 'open') fail(`This order is already ${order.status}`, 409);
    const today = await businessToday(db, row.id);
    if (order.valid < today) fail("This order has expired. Make it again to see today's prices.", 409, { reason: 'order_expired' });
    if (paidOn > today) fail('The date paid cannot be in the future');
    if (await repo.one(db, "SELECT 1 FROM platform_payments WHERE order_id=$1 AND status='pending'", [order.id])) {
      fail('A payment for this order is already being checked', 409, { reason: 'payment_being_checked' });
    }
    const payment = await repo.one(db, `INSERT INTO platform_payments(business_id,order_id,amount,method,reference,paid_on,submitted_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [row.id, order.id, order.total_amount, method, reference, paidOn, user.id]);
    await repo.audit(db, row.id, user.id, 'plan.payment_submitted', payment.id, { orderId: order.id, amount: payment.amount, method, reference });
    return toPayment(payment);
  });
}

// What a confirmed payment made: its order, its invoice, its period or grants.
async function appliedResult(db, paymentId) {
  const payment = await repo.one(db, 'SELECT * FROM platform_payments WHERE id=$1', [paymentId]);
  const order = await repo.one(db, 'SELECT * FROM platform_orders WHERE id=$1', [payment.order_id]);
  const invoice = await repo.one(db, 'SELECT * FROM platform_invoices WHERE payment_id=$1 ORDER BY sample,id LIMIT 1', [payment.id]);
  const period = await repo.one(db, 'SELECT * FROM business_access_periods WHERE order_id=$1 AND cancelled_at IS NULL', [order.id]);
  const grants = await repo.all(db, 'SELECT * FROM business_access_addons WHERE order_id=$1 ORDER BY module_code', [order.id]);
  return {
    payment: toPayment(payment), order: await orderView(db, order), invoice: invoice ? invoices.toInvoice({ ...invoice, gst_rate: order.gst_rate }) : null,
    period: period || null, grants,
  };
}

// The one routine that makes a payment count, idempotent: the payment
// confirmed, its order paid, a paid period (subscription) after the current
// end, or paid add-on grants to the period's end (add-on), the invoice
// issued, all in one transaction. Applying it again changes nothing.
async function applyPayment(user, paymentId, db = null) {
  const work = async (db) => {
    const id = v.requiredId(paymentId, 'Payment');
    const found = await repo.one(db, 'SELECT business_id FROM platform_payments WHERE id=$1', [id]);
    if (!found) fail('Payment not found', 404);
    const business = await lockBusiness(db, found.business_id);
    const payment = await repo.one(db, 'SELECT * FROM platform_payments WHERE id=$1 FOR UPDATE', [id]);
    const order = await repo.one(db, 'SELECT * FROM platform_orders WHERE id=$1 FOR UPDATE', [payment.order_id]);
    if (payment.status === 'confirmed') return appliedResult(db, payment.id);
    if (payment.status === 'rejected') fail('This payment was rejected, so it cannot be confirmed', 409);
    if (order.status !== 'open') fail(`This order is already ${order.status}`, 409);
    const company = await settings.get(db);
    const problems = settings.companyProblems(company);
    if (problems.length) {
      fail(`Complete the company details in the platform's Settings first: ${problems.join(', ')}`, 409, { reason: 'company_incomplete', problems });
    }
    const actor = user ? user.id : null;
    const confirmed = await repo.one(db, "UPDATE platform_payments SET status='confirmed',decided_by=$2,decided_at=now() WHERE id=$1 RETURNING *", [payment.id, actor]);
    const paid = await repo.one(db, "UPDATE platform_orders SET status='paid',paid_at=now() WHERE id=$1 RETURNING *", [order.id]);
    await unlock(db, business.id, paid, actor);
    const invoice = await invoices.issue(db, { order: paid, payment: confirmed, settings: company, issuedOn: await companyToday(db), user });
    if (actor) {
      await repo.audit(db, business.id, actor, 'plan.payment_confirmed', confirmed.id, { orderId: paid.id, amount: confirmed.amount, invoice: invoice.number });
    }
    return appliedResult(db, confirmed.id);
  };
  return db ? work(db) : repo.transaction(work);
}

// A payment the super admin could not find: the order stays open.
async function rejectPayment(user, paymentId, reason) {
  const note = v.requiredString(reason, 'Reason', 500);
  return repo.transaction(async (db) => {
    const id = v.requiredId(paymentId, 'Payment');
    const found = await repo.one(db, 'SELECT business_id FROM platform_payments WHERE id=$1', [id]);
    if (!found) fail('Payment not found', 404);
    await lockBusiness(db, found.business_id);
    const payment = await repo.one(db, 'SELECT * FROM platform_payments WHERE id=$1 FOR UPDATE', [id]);
    if (payment.status !== 'pending') fail(`This payment is already ${payment.status}`, 409);
    const rejected = await repo.one(db, `UPDATE platform_payments SET status='rejected',decided_by=$2,decided_at=now(),decision_note=$3 WHERE id=$1 RETURNING *`,
      [payment.id, user.id, note]);
    await repo.audit(db, payment.business_id, user.id, 'plan.payment_rejected', payment.id, { orderId: payment.order_id, reason: note });
    return toPayment(rejected);
  });
}

// A payment the super admin received and records: entered and confirmed in
// one transaction.
async function recordPayment(user, businessId, orderId, body = {}) {
  const method = v.requiredEnum(body.method, 'Paid by', METHODS);
  const reference = v.requiredString(body.reference, 'Payment reference', 100);
  const paidOn = dateText(body.paidOn, 'Date paid');
  return repo.transaction(async (db) => {
    const business = await lockBusiness(db, businessId);
    const order = await repo.one(db, 'SELECT * FROM platform_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, v.requiredId(orderId, 'Order')]);
    if (!order) fail('Order not found', 404);
    if (order.status !== 'open') fail(`This order is already ${order.status}`, 409);
    if (paidOn > await companyToday(db)) fail('The date paid cannot be in the future');
    if (await repo.one(db, "SELECT 1 FROM platform_payments WHERE order_id=$1 AND status='pending'", [order.id])) {
      fail('A payment the owner entered for this order is waiting: confirm or reject it instead', 409, { reason: 'payment_being_checked' });
    }
    const payment = await repo.one(db, `INSERT INTO platform_payments(business_id,order_id,amount,method,reference,paid_on,submitted_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [business.id, order.id, order.total_amount, method, reference, paidOn, user.id]);
    return applyPayment(user, payment.id, db);
  });
}

// --- Given time and given add-ons --------------------------------------------------------

// Time the super admin gives, with a reason: until a date or with no end,
// unlocking everything or a plan and modules (copied now). It replaces given
// time that covers today (the old period is cancelled with the reason; the new
// one keeps its start) and, with replaceTrial, a trial; otherwise it starts
// after the time the business already has, or today once that has ended.
async function giveTime(user, businessId, body = {}) {
  const reason = v.requiredString(body.reason, 'Reason', 300);
  const noEnd = body.noEnd === true;
  const endsOn = noEnd ? null : dateText(body.endsOn, 'Given until');
  const everything = body.everything === true;
  return repo.transaction(async (db) => {
    const business = await lockBusiness(db, businessId);
    const today = await businessToday(db, business.id);
    let planCode = null;
    let modules = [];
    if (!everything) {
      const plan = await repo.one(db, 'SELECT * FROM platform_plans WHERE code=$1 AND business_type=$2', [v.requiredString(body.planCode, 'Plan', 40), business.business_type]);
      if (!plan) fail('That plan is not for this type of business');
      planCode = plan.code;
      const extra = [...new Set(v.requiredArray(body.modules ?? [], 'Modules').map((code) => String(code)))];
      modules = [...new Set([...await planModules(db, plan.code), ...extra])].sort();
    }
    const current = await repo.one(db, `SELECT *,starts_on::text AS starts FROM business_access_periods WHERE business_id=$1 AND cancelled_at IS NULL
      AND starts_on<=$2 AND (ends_on IS NULL OR ends_on>=$2) FOR UPDATE`, [business.id, today]);
    const replaces = current && (current.kind === 'given' || (current.kind === 'trial' && body.replaceTrial === true)) ? current : null;
    let startsOn = today;
    if (replaces) {
      await db.query('UPDATE business_access_periods SET cancelled_at=now(),cancelled_by=$2,cancel_reason=$3 WHERE id=$1', [replaces.id, user.id, reason]);
      startsOn = replaces.starts;
    } else if (current) {
      // After the trial or paid time it already has.
      startsOn = (await renewalStart(db, business.id, today)) || fail('This business already has given time with no end', 409);
    }
    if (endsOn && endsOn < (startsOn > today ? startsOn : today)) fail('The given time must end today or later, and not before it starts');
    const period = await repo.one(db, `INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything,plan_code,modules,reason,created_by)
      VALUES($1,'given',$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, startsOn, endsOn, everything, planCode, modules, reason, user.id]);
    await repo.audit(db, business.id, user.id, 'plan.time_given', period.id, { startsOn, endsOn, everything, planCode, modules, reason,
      ...(replaces ? { replaced: replaces.id } : {}) });
    return period;
  });
}

// Modules or applications unlocked at once until a date, with a reason.
async function giveAddons(user, businessId, body = {}) {
  const reason = v.requiredString(body.reason, 'Reason', 300);
  const endsOn = dateText(body.endsOn, 'Given until');
  const codes = [...new Set(v.requiredArray(body.modules, 'Modules').map((code) => String(code)))];
  if (!codes.length) fail('Choose the modules to give');
  return repo.transaction(async (db) => {
    const business = await lockBusiness(db, businessId);
    const today = await businessToday(db, business.id);
    if (endsOn < today) fail('The given time must end today or later');
    const grants = [];
    for (const code of codes) {
      if (!(await repo.one(db, 'SELECT platform_module_sellable($1,$2) AS ok', [code, business.business_type])).ok) fail(`${code} cannot be given to this type of business`);
      grants.push(await repo.one(db, `INSERT INTO business_access_addons(business_id,module_code,kind,starts_on,ends_on,reason,created_by)
        VALUES($1,$2,'given',$3,$4,$5,$6) RETURNING *`, [business.id, code, today, endsOn, reason, user.id]));
    }
    await repo.audit(db, business.id, user.id, 'plan.addons_given', business.id, { modules: codes, endsOn, reason });
    return grants;
  });
}

// --- The tax invoice for an order invoiced in sample mode ----------------------------------

// Once the real GSTIN is saved: the real tax invoice for a paid order whose
// only invoice is a sample, dated the day it is issued and naming the day the
// money came. Once per order.
async function issueTaxInvoice(user, orderId) {
  return repo.transaction(async (db) => {
    const found = await repo.one(db, 'SELECT business_id FROM platform_orders WHERE id=$1', [v.requiredId(orderId, 'Order')]);
    if (!found) fail('Order not found', 404);
    await lockBusiness(db, found.business_id);
    const order = await repo.one(db, 'SELECT * FROM platform_orders WHERE id=$1 FOR UPDATE', [orderId]);
    const company = await settings.get(db);
    if (settings.isSample(company)) fail("Enter the company's real GSTIN in the platform's Settings first", 409, { reason: 'sample_gstin' });
    const problems = settings.companyProblems(company);
    if (problems.length) fail(`Complete the company details in the platform's Settings first: ${problems.join(', ')}`, 409, { reason: 'company_incomplete', problems });
    if (order.status !== 'paid') fail('Only a paid order has a tax invoice', 409);
    const real = await repo.one(db, 'SELECT number FROM platform_invoices WHERE order_id=$1 AND NOT sample', [order.id]);
    if (real) fail(`This order already has its tax invoice, ${real.number}`, 409);
    if (!await repo.one(db, 'SELECT 1 FROM platform_invoices WHERE order_id=$1 AND sample', [order.id])) fail('This order has no sample invoice to replace', 409);
    const payment = await repo.one(db, "SELECT * FROM platform_payments WHERE order_id=$1 AND status='confirmed'", [order.id]);
    const invoice = await invoices.issue(db, { order, payment, settings: company, issuedOn: await companyToday(db), user });
    await repo.audit(db, order.business_id, user.id, 'plan.tax_invoice_issued', invoice.id, { orderId: order.id, number: invoice.number });
    return invoices.toInvoice({ ...invoice, gst_rate: order.gst_rate });
  });
}

// --- What the owner sees -----------------------------------------------------------------

async function orderView(db, row) {
  const lines = await repo.all(db, 'SELECT * FROM platform_order_lines WHERE order_id=$1 ORDER BY line_no', [row.id]);
  const payments = await repo.all(db, 'SELECT * FROM platform_payments WHERE order_id=$1 ORDER BY id', [row.id]);
  return {
    id: row.id, kind: row.kind, planCode: row.plan_code, billingPeriod: row.billing_period, startsOn: row.starts_on, endsOn: row.ends_on, modules: row.modules,
    validUntil: row.valid_until, buyer: row.buyer, supplierStateCode: row.supplier_state_code, placeOfSupplyCode: row.place_of_supply_code,
    placeOfSupply: STATES[row.place_of_supply_code] || null, gstRate: row.gst_rate, taxable: row.taxable_amount, cgst: row.cgst_amount, sgst: row.sgst_amount,
    igst: row.igst_amount, total: row.total_amount, status: row.status, createdAt: row.created_at, paidAt: row.paid_at, cancelledAt: row.cancelled_at,
    lines: lines.map((l) => ({ lineNo: l.line_no, itemKind: l.item_kind, itemCode: l.item_code, name: l.name, fullPrice: l.full_price,
      chargedDays: l.charged_days, periodDays: l.period_days, amount: l.amount })),
    payments: payments.map(toPayment),
  };
}

// The owner's "Your plan": the state and dates, the selection, what is
// unlocked, what can be bought, the open order with its payments, the orders,
// payments and invoices so far, and how to pay the company.
async function ownerView(business) {
  const db = repo.pool;
  const plan = await planOf(business.id, db);
  const selection = await selectionOf(db, business.id);
  const entitled = await entitledOf(db, business.id);
  const offer = await catalogue.forType(business.business_type, db);
  const orders = await repo.all(db, 'SELECT * FROM platform_orders WHERE business_id=$1 ORDER BY id DESC LIMIT 100', [business.id]);
  const open = orders.find((o) => o.status === 'open');
  const openOrder = open ? await orderView(db, open) : null;
  const payments = await repo.all(db, 'SELECT * FROM platform_payments WHERE business_id=$1 ORDER BY id DESC LIMIT 100', [business.id]);
  const invoiceRows = await repo.all(db, `SELECT id,number,issued_on,paid_on,order_id,total_amount,sample FROM platform_invoices WHERE business_id=$1 ORDER BY id DESC LIMIT 100`, [business.id]);
  const company = await settings.get(db);
  const payTo = {
    upiId: company.upi_id, upiPayee: company.upi_payee_name || company.legal_name || company.brand_name, bankName: company.bank_name,
    bankAccountName: company.bank_account_name, bankAccountNumber: company.bank_account_number, bankIfsc: company.bank_ifsc, note: company.payment_note,
    upiLink: openOrder && company.upi_id ? math.upiLink({ upiId: company.upi_id, payee: company.upi_payee_name || company.legal_name || company.brand_name,
      amountPaise: math.toPaise(openOrder.total), note: `Order ${openOrder.id}` }) : null,
  };
  return {
    plan, selection, entitled, catalogue: offer, openOrder,
    orders: orders.map((o) => ({ id: o.id, kind: o.kind, planCode: o.plan_code, billingPeriod: o.billing_period, startsOn: o.starts_on, endsOn: o.ends_on,
      total: o.total_amount, status: o.status, createdAt: o.created_at, paidAt: o.paid_at })),
    payments: payments.map(toPayment),
    invoices: invoiceRows.map((i) => ({ id: i.id, number: i.number, issuedOn: i.issued_on, paidOn: i.paid_on, orderId: i.order_id, total: i.total_amount, sample: i.sample })),
    payTo,
    company: { name: company.brand_name, legalName: company.legal_name, phone: company.support_phone || company.phone, email: company.support_email || company.email },
    gstRate: company.gst_rate,
  };
}

module.exports = {
  planOf, bannerOf, ownerView, selectionOf, setSelection, createOrder, submitPayment, applyPayment, rejectPayment, recordPayment, giveTime, giveAddons,
  issueTaxInvoice, orderView,
};
