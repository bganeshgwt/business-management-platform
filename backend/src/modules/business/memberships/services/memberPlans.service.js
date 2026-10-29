const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./memberCommon');

// Plans (module "member_plans", gyms, studios and coaching centres).
//
//   A plan is sold as a service item of the catalogue, its own: made with
//   the plan (the price, the GST slab and the SAC code typed with it) or an
//   existing service chosen. Its GST, SAC and slab come from the item, so a
//   gym, yoga, fitness or personal-training plan carries 5% (without input
//   tax credit) and coaching, tuition or a dance, music or art class 18%, as
//   the owner sets the item. A joining fee
//   is another service item, billed with a member's first membership.
//   A plan is by days or months, a pack of sessions, or a pack to use within
//   a time; it says how many days it may be frozen in how many freezes, the
//   grace days after it runs out, whether it can be passed to another member,
//   and its refund policy. A changed policy is a new version; a membership
//   keeps the version it was sold with, as it keeps the plan's other terms.
//   Plans are switched off, never deleted.
//   A plan may also limit visits (a day, a week, a month or in all), let a
//   member in only at some branches or between some hours, have seats for a
//   couple, a family or a company, book only some classes, be a personal-
//   training plan, take a fee for a freeze (with days of notice) and for a
//   transfer, a late fee on an instalment overdue by some days (disclosed when
//   it is sold), and give back a part of the joining fee on a cancellation.
//   A membership keeps all of these as sold.
// The settings: how many days overdue fees turn a member away at check-in,
// the penalties for a class's late cancel and no-show, and when a pack's
// sessions run low.

const { fail, id, given } = c;
const MAX_POLICY = 4000;
const PENALTIES = ['none', 'session', 'fee'];
const money = (value, name) => (given(value) ? core.decimal(value, name, 2, 0, 1000000) : 0);
// A time of day typed as HH:MM (24 hours).
function readTime(value, name) {
  const text = String(value ?? '').trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) fail(`${name} must be a time of day such as 06:00 or 21:30`);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

const PLANS_SQL = `SELECT p.*,s.label AS item_label,s.code AS item_code,s.price,s.tax_rate,s.tax_rate_id,s.hsn_code,s.active AS item_active,
    j.label AS joining_label,j.code AS joining_code,j.price AS joining_price,j.tax_rate AS joining_tax_rate,pol.policy,
    (SELECT count(*)::int FROM member_memberships m WHERE m.business_id=p.business_id AND m.plan_id=p.id AND m.closed IS NULL
      AND (m.end_on >= (now() AT TIME ZONE b.timezone)::date OR (m.end_on IS NULL AND m.sessions_used < m.sessions_total))) AS running
  FROM member_plan_types p JOIN businesses b ON b.id=p.business_id
  JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.price_sku_id
  LEFT JOIN catalog_skus j ON j.business_id=p.business_id AND j.id=p.joining_sku_id
  JOIN member_plan_policies pol ON pol.business_id=p.business_id AND pol.plan_id=p.id AND pol.version=p.policy_version
  WHERE p.business_id=$1`;
repo.addLists({
  // Plans being sold first, by name.
  'member-plans': { sql: PLANS_SQL, search: ['name', 'item_label', 'item_code', 'joining_label'], filters: { active: 'active', kind: 'kind' }, order: 'active DESC, lower(name), id' },
});

// --- Reading a plan ---------------------------------------------------------------------------------

const whole = (value, name, min, max) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return Number(text);
};
// The plan's terms as asked: { name, kind, durationUnit?, duration?, sessions?, maxFreezeDays?, maxFreezes?, graceDays?, transferable?, policy }.
function readTerms(body) {
  const kind = v.requiredEnum(body.kind, 'Kind of plan', c.KINDS);
  const terms = {
    name: v.requiredString(typeof body.name === 'string' ? body.name : '', 'Plan name', 100),
    kind, durationUnit: null, duration: null, sessions: null,
    maxFreezeDays: c.given(body.maxFreezeDays) ? whole(body.maxFreezeDays, 'Days it may be frozen', 0, 365) : 0,
    maxFreezes: c.given(body.maxFreezes) ? whole(body.maxFreezes, 'Freezes allowed', 0, 12) : 0,
    graceDays: c.given(body.graceDays) ? whole(body.graceDays, 'Grace days', 0, 90) : 0,
    transferable: v.requiredBoolean(body.transferable, 'Can be transferred', false),
    policy: v.requiredString(typeof body.policy === 'string' ? body.policy : '', 'Refund policy', MAX_POLICY),
  };
  if (kind !== 'sessions') {
    terms.durationUnit = v.requiredEnum(body.durationUnit, 'Days or months', c.UNITS);
    terms.duration = terms.durationUnit === 'months' ? whole(body.duration, 'Months', 1, 120) : whole(body.duration, 'Days', 1, 3660);
  }
  if (kind !== 'duration') terms.sessions = whole(body.sessions, 'Sessions', 1, 1000);
  if (kind === 'sessions' && (terms.maxFreezeDays || terms.maxFreezes)) fail('A pack of sessions with no end date is not frozen: leave its freezes at 0');
  if ((terms.maxFreezeDays === 0) !== (terms.maxFreezes === 0)) fail('Give both how many freezes a member may take and how many days in all, or neither');
  // Visits, branches, hours, seats, classes and fees.
  terms.visitLimit = given(body.visitLimit) ? whole(body.visitLimit, 'Visits allowed', 1, 1000) : null;
  terms.visitPeriod = terms.visitLimit ? v.requiredEnum(body.visitPeriod, 'Visits counted', c.VISIT_PERIODS) : null;
  const locations = body.accessLocations === undefined || body.accessLocations === null ? null : v.requiredArray(body.accessLocations, 'Branches');
  terms.accessLocations = locations && locations.length ? [...new Set(locations.map((x) => Number(id(x, 'Branch'))))] : null;
  if (terms.accessLocations && terms.accessLocations.length > 50) fail('Choose at most 50 branches');
  terms.accessFrom = given(body.accessFrom) || given(body.accessTo) ? readTime(body.accessFrom, 'Let in from') : null;
  terms.accessTo = terms.accessFrom ? readTime(body.accessTo, 'Let in until') : null;
  if (terms.accessFrom && terms.accessFrom >= terms.accessTo) fail('A plan\'s hours end after they begin, on the same day');
  terms.seats = given(body.seats) ? whole(body.seats, 'Seats', 1, 50) : 1;
  const classes = body.classNames === undefined || body.classNames === null ? null : v.requiredArray(body.classNames, 'Classes');
  terms.classNames = classes ? [...new Set(classes.map((x) => v.requiredString(typeof x === 'string' ? x : '', 'Class', 80).trim()))] : null;
  if (terms.classNames && terms.classNames.length > 50) fail('Choose at most 50 classes');
  terms.personalTraining = v.requiredBoolean(body.personalTraining, 'Personal training', false);
  terms.freezeFee = money(body.freezeFee, 'Freeze fee');
  terms.freezeNoticeDays = given(body.freezeNoticeDays) ? whole(body.freezeNoticeDays, 'Days of notice for a freeze', 0, 60) : 0;
  terms.transferFee = money(body.transferFee, 'Transfer fee');
  terms.lateFee = money(body.lateFee, 'Late fee');
  terms.lateFeeAfterDays = given(body.lateFeeAfterDays) ? whole(body.lateFeeAfterDays, 'Days overdue before the late fee', 0, 90) : 0;
  terms.joiningRefundPercent = given(body.joiningRefundPercent) ? whole(body.joiningRefundPercent, 'Part of the joining fee given back (%)', 0, 100) : 100;
  if (terms.freezeFee && !terms.maxFreezes) fail('A plan that is not frozen takes no freeze fee');
  if (terms.freezeNoticeDays && !terms.maxFreezes) fail('A plan that is not frozen needs no notice for a freeze');
  if (terms.transferFee && !terms.transferable) fail('A plan that is not passed on takes no transfer fee');
  return terms;
}

// The branches a plan names are this business's own.
async function checkLocations(db, business, terms) {
  if (!terms.accessLocations) return;
  const found = await repo.all(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, terms.accessLocations]);
  if (found.length !== terms.accessLocations.length) fail('Branch not found', 404);
}
// The terms as the database's columns take them.
const termValues = (t) => [t.visitLimit, t.visitPeriod, t.accessLocations, t.accessFrom, t.accessTo, t.seats, t.classNames, t.personalTraining, t.freezeFee.toFixed(2),
  t.freezeNoticeDays, t.transferFee.toFixed(2), t.lateFee.toFixed(2), t.lateFeeAfterDays, t.joiningRefundPercent];

async function readJoining(db, business, value, priceSkuId) {
  if (!c.given(value)) return null;
  const sku = await repo.one(db, `SELECT s.id,s.label,s.is_kit,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(value, 'Joining fee item')]);
  if (!sku) fail('Joining fee item not found', 404);
  if (sku.kind !== 'service' || sku.is_kit) fail(`${sku.label} is not a service: a joining fee is a service item`);
  if (Number(sku.id) === Number(priceSkuId)) fail('The joining fee is an item of its own, not the plan\'s');
  return sku.id;
}

// A free item code for a new plan's item: PLAN-001, PLAN-002 ….
async function freeCode(db, businessId) {
  const count = await repo.one(db, 'SELECT count(*)::int AS n FROM member_plan_types WHERE business_id=$1', [businessId]);
  for (let n = count.n + 1; ; n += 1) {
    const code = `PLAN-${String(n).padStart(3, '0')}`;
    if (!await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [businessId, code])) return code;
  }
}

async function insertPlan(db, business, user, terms, priceSkuId, joiningSkuId) {
  await checkLocations(db, business, terms);
  const plan = await repo.one(db, `INSERT INTO member_plan_types(business_id,name,kind,duration_unit,duration,sessions,price_sku_id,joining_sku_id,max_freeze_days,max_freezes,
      grace_days,transferable,created_by,updated_by,visit_limit,visit_period,access_locations,access_from,access_to,seats,class_names,personal_training,freeze_fee,
      freeze_notice_days,transfer_fee,late_fee,late_fee_after_days,joining_refund_percent)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
  [business.id, terms.name, terms.kind, terms.durationUnit, terms.duration, terms.sessions, priceSkuId, joiningSkuId, terms.maxFreezeDays, terms.maxFreezes, terms.graceDays,
    terms.transferable, user.id, ...termValues(terms)]);
  await db.query('INSERT INTO member_plan_policies(business_id,plan_id,version,policy,created_by) VALUES($1,$2,1,$3,$4)', [business.id, plan.id, terms.policy, user.id]);
  await repo.audit(db, business.id, user.id, 'member_plan.created', plan.id, { name: plan.name, kind: plan.kind, term: c.termWords(plan), priceSkuId, joiningSkuId });
  return plan;
}

// --- Plans ---------------------------------------------------------------------------------------

async function load(db, business, planId) {
  const plan = await repo.one(db, `SELECT * FROM (${PLANS_SQL}) x WHERE x.id=$2`, [business.id, planId]);
  if (!plan) fail('Plan not found', 404);
  const policies = await repo.all(db, `SELECT pol.version,pol.policy,pol.created_at,u.name AS created_by_name FROM member_plan_policies pol JOIN users u ON u.id=pol.created_by
    WHERE pol.business_id=$1 AND pol.plan_id=$2 ORDER BY pol.version DESC`, [business.id, plan.id]);
  return { ...plan, term: c.termWords(plan), policies };
}

async function detail(business, planId) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  return load(repo.pool, business, id(planId, 'Plan'));
}

// body: terms (readTerms), and the item: { skuId } an existing service, or
// { price, taxRateId, hsnCode? } for a new one named as the plan; joiningSkuId?
async function create(business, user, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const terms = readTerms(body);
  const item = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? body.item : null;
  if (!item) fail('Give the plan\'s item: a new one with its price and GST, or an existing service');
  if (c.given(item.skuId)) {
    return repo.transaction(async (db) => {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.is_kit,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(item.skuId, 'Plan item')]);
      if (!sku) fail('Plan item not found', 404);
      if (sku.kind !== 'service' || sku.is_kit) fail(`${sku.label} is not a service: a plan is sold as a service item`);
      const taken = await repo.one(db, 'SELECT name FROM member_plan_types WHERE business_id=$1 AND (price_sku_id=$2 OR joining_sku_id=$2)', [business.id, sku.id]);
      if (taken) fail(`${sku.label} is already used by the plan ${taken.name}`, 409);
      const plan = await insertPlan(db, business, user, terms, sku.id, await readJoining(db, business, body.joiningSkuId, sku.id));
      return load(db, business, plan.id);
    });
  }
  // A new service item named as the plan; its price, GST slab and SAC come from what was typed.
  const code = await freeCode(repo.pool, business.id);
  let planId = null;
  await core.createCatalog(business, user, { kind: 'service', unit: 'service', name: terms.name, label: terms.name, code, price: item.price, taxRateId: item.taxRateId,
    hsnCode: item.hsnCode }, async (db, sku) => {
    const plan = await insertPlan(db, business, user, terms, sku.id, await readJoining(db, business, body.joiningSkuId, sku.id));
    planId = plan.id;
  });
  return load(repo.pool, business, planId);
}

// Changes apply to memberships sold from now on: those sold keep their terms.
// body: terms, and { price?, taxRateId?, hsnCode? } to change the plan's item,
// joiningSkuId (null: none), active. A changed policy becomes its next version.
async function update(business, user, planId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM member_plan_types WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(planId, 'Plan')]);
    if (!current) fail('Plan not found', 404);
    const onlyActive = Object.keys(body).length === 1 && body.active !== undefined;
    const active = v.requiredBoolean(body.active, 'Sold', current.active);
    if (onlyActive) {
      await db.query('UPDATE member_plan_types SET active=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, current.id, active, user.id]);
      await repo.audit(db, business.id, user.id, 'member_plan.updated', current.id, { name: current.name, active });
      return load(db, business, current.id);
    }
    const terms = readTerms(body);
    const joining = body.joiningSkuId === undefined ? current.joining_sku_id : await readJoining(db, business, body.joiningSkuId, current.price_sku_id);
    const policy = await repo.one(db, 'SELECT policy FROM member_plan_policies WHERE business_id=$1 AND plan_id=$2 AND version=$3', [business.id, current.id, current.policy_version]);
    const version = policy.policy === terms.policy ? current.policy_version : current.policy_version + 1;
    if (version !== current.policy_version) {
      await db.query('INSERT INTO member_plan_policies(business_id,plan_id,version,policy,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, current.id, version, terms.policy, user.id]);
    }
    await checkLocations(db, business, terms);
    await db.query(`UPDATE member_plan_types SET name=$3,kind=$4,duration_unit=$5,duration=$6,sessions=$7,joining_sku_id=$8,max_freeze_days=$9,max_freezes=$10,grace_days=$11,
        transferable=$12,policy_version=$13,active=$14,updated_by=$15,updated_at=now(),visit_limit=$16,visit_period=$17,access_locations=$18,access_from=$19,access_to=$20,
        seats=$21,class_names=$22,personal_training=$23,freeze_fee=$24,freeze_notice_days=$25,transfer_fee=$26,late_fee=$27,late_fee_after_days=$28,joining_refund_percent=$29
      WHERE business_id=$1 AND id=$2`,
    [business.id, current.id, terms.name, terms.kind, terms.durationUnit, terms.duration, terms.sessions, joining, terms.maxFreezeDays, terms.maxFreezes, terms.graceDays,
      terms.transferable, version, active, user.id, ...termValues(terms)]);
    // The item's price, GST slab or SAC, changed on the item itself (the catalogue's rules apply).
    if (c.given(body.price) || c.given(body.taxRateId) || body.hsnCode !== undefined) {
      const sku = await repo.one(db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, current.price_sku_id]);
      await core.updateCatalog(business, user, sku.id, { label: sku.label, price: c.given(body.price) ? body.price : sku.price, active: sku.active,
        ...(c.given(body.taxRateId) ? { taxRateId: body.taxRateId } : { taxRateId: sku.tax_rate_id }), ...(body.hsnCode !== undefined ? { hsnCode: body.hsnCode } : {}) }, db);
    }
    const changed = Object.entries({ name: [current.name, terms.name], kind: [current.kind, terms.kind], duration: [`${current.duration ?? ''} ${current.duration_unit ?? ''}`.trim(),
      `${terms.duration ?? ''} ${terms.durationUnit ?? ''}`.trim()], sessions: [current.sessions, terms.sessions], joiningSkuId: [current.joining_sku_id, joining],
      maxFreezeDays: [current.max_freeze_days, terms.maxFreezeDays], maxFreezes: [current.max_freezes, terms.maxFreezes], graceDays: [current.grace_days, terms.graceDays],
      transferable: [current.transferable, terms.transferable], active: [current.active, active],
      visits: [current.visit_limit ? `${current.visit_limit} ${current.visit_period}` : '', terms.visitLimit ? `${terms.visitLimit} ${terms.visitPeriod}` : ''],
      branches: [(current.access_locations || []).join(','), (terms.accessLocations || []).join(',')],
      hours: [current.access_from ? `${c.hhmm(current.access_from)}-${c.hhmm(current.access_to)}` : '', terms.accessFrom ? `${terms.accessFrom}-${terms.accessTo}` : ''],
      seats: [current.seats, terms.seats], classes: [current.class_names === null ? 'all' : current.class_names.join(','), terms.classNames === null ? 'all' : terms.classNames.join(',')],
      personalTraining: [current.personal_training, terms.personalTraining], freezeFee: [Number(current.freeze_fee).toFixed(2), terms.freezeFee.toFixed(2)],
      freezeNoticeDays: [current.freeze_notice_days, terms.freezeNoticeDays], transferFee: [Number(current.transfer_fee).toFixed(2), terms.transferFee.toFixed(2)],
      lateFee: [Number(current.late_fee).toFixed(2), terms.lateFee.toFixed(2)], lateFeeAfterDays: [current.late_fee_after_days, terms.lateFeeAfterDays],
      joiningRefundPercent: [current.joining_refund_percent, terms.joiningRefundPercent] }).filter(([, [from, to]]) => String(from ?? '') !== String(to ?? ''));
    await repo.audit(db, business.id, user.id, 'member_plan.updated', current.id, { name: terms.name, ...(version !== current.policy_version ? { policyVersion: version } : {}),
      ...Object.fromEntries(changed.map(([key, [from, to]]) => [key, { from, to }])) });
    return load(db, business, current.id);
  });
}

// --- Settings and approvers -----------------------------------------------------------------------

const DEFAULT_DUES_DAYS = 7;
async function settingsOf(db, businessId) {
  const row = await repo.one(db, 'SELECT dues_block_days,late_cancel_penalty,no_show_penalty,penalty_fee,low_sessions,updated_at FROM member_settings WHERE business_id=$1', [businessId]);
  return { duesBlockDays: row ? row.dues_block_days : DEFAULT_DUES_DAYS, lateCancelPenalty: row?.late_cancel_penalty || 'none', noShowPenalty: row?.no_show_penalty || 'none',
    penaltyFee: row ? row.penalty_fee : '0.00', lowSessions: row ? row.low_sessions : 2, updatedAt: row?.updated_at || null };
}
async function settings(business) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  return settingsOf(repo.pool, business.id);
}
// body: { duesBlockDays: 0–365, or null: never turn a member away for fees;
//   lateCancelPenalty?, noShowPenalty?: none | session | fee; penaltyFee?; lowSessions? }
// Anything not given keeps its value.
async function saveSettings(business, user, body) {
  c.requireMemberships(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    const before = await settingsOf(db, business.id);
    const days = body.duesBlockDays === undefined ? before.duesBlockDays : body.duesBlockDays === null || body.duesBlockDays === '' ? null : whole(body.duesBlockDays, 'Days overdue', 0, 365);
    const late = body.lateCancelPenalty === undefined ? before.lateCancelPenalty : v.requiredEnum(body.lateCancelPenalty, 'Penalty for a late cancel', PENALTIES);
    const noShow = body.noShowPenalty === undefined ? before.noShowPenalty : v.requiredEnum(body.noShowPenalty, 'Penalty for a no-show', PENALTIES);
    const fee = body.penaltyFee === undefined ? Number(before.penaltyFee) : money(body.penaltyFee, 'Penalty fee');
    const low = body.lowSessions === undefined ? before.lowSessions : whole(body.lowSessions, 'Sessions left that count as running low', 1, 100);
    if ((late === 'fee' || noShow === 'fee') && !(fee > 0)) fail('Give the penalty fee, or choose another penalty');
    await db.query(`INSERT INTO member_settings(business_id,dues_block_days,late_cancel_penalty,no_show_penalty,penalty_fee,low_sessions,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (business_id) DO UPDATE SET dues_block_days=EXCLUDED.dues_block_days,late_cancel_penalty=EXCLUDED.late_cancel_penalty,no_show_penalty=EXCLUDED.no_show_penalty,
        penalty_fee=EXCLUDED.penalty_fee,low_sessions=EXCLUDED.low_sessions,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, days, late, noShow, fee.toFixed(2), low, user.id]);
    const after = { duesBlockDays: days, lateCancelPenalty: late, noShowPenalty: noShow, penaltyFee: fee.toFixed(2), lowSessions: low };
    const changed = Object.entries(after).filter(([key, value]) => (key === 'penaltyFee' ? Number(before[key]) !== Number(value) : String(before[key] ?? '') !== String(value ?? '')));
    await repo.audit(db, business.id, user.id, 'member_settings.updated', null, Object.fromEntries(changed.map(([key, value]) => [key, { from: before[key], to: value }])));
    return settingsOf(db, business.id);
  });
}

// Who may approve what a cancelled membership gives back: members whose role
// holds member_plans.approve (or full access), with whether they have a PIN.
async function approvers(business) {
  c.requireMemberships(business);
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id
      AND p.permission_code='member_plans.approve'))
    ORDER BY u.name`, [business.id]);
}

module.exports = { detail, create, update, settings, saveSettings, settingsOf, approvers, DEFAULT_DUES_DAYS };
