const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
const money = require('./lodgingMoney');

// Rate plans, the rate calendar, day-use rates and policies (module "lodging").
//
//   rate plans   a room type's plans: the meal plan (EP room only, CP with
//                breakfast, MAP half board, AP full board) with the meals'
//                price a night for each adult and child, billed as their own
//                lines as the food service item the property names (at its
//                slab), so a room night's value and slab are the room's alone;
//                the plan's own room rates if not the room type's; refundable
//                or not; its policy. Switched off, never deleted.
//   seasons      a date range's weekday and weekend rates (and extra persons'
//                rates and a minimum stay) for a room type or one of its plans;
//                two of the same never cover the same night.
//   the calendar a date's own rates and its restrictions (minimum stay, closed
//                to arrival, stop-sell), set for a range of dates at once.
//   day use      a room type's price for a block of hours on one day.
//   policies     early check-in and late check-out charges, the cancellation
//                window and charge, the no-show charge and the deposit, for a
//                property or for the business; a plan may name its own. A stay
//                keeps the policy it was booked under.
// The rates of a stay's nights are worked out here (lodgingMoney.resolveNights).

const { fail, id } = c;
const MEAL_PLANS = ['EP', 'CP', 'MAP', 'AP'];
const MEAL_WORDS = { EP: 'Room only (EP)', CP: 'With breakfast (CP)', MAP: 'Half board (MAP)', AP: 'Full board (AP)' };
const rateText = (p) => (p === null || p === undefined ? null : c.rupees(p));
const paiseOf = (value) => (value === null || value === undefined ? null : c.paise(value));
const MAX_DAYS = 366;

async function typeOf(db, business, typeId) {
  const type = await repo.one(db, `SELECT t.*,s.label AS name FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
    WHERE t.business_id=$1 AND t.id=$2`, [business.id, id(typeId, 'Room type')]);
  if (!type) fail('Room type not found', 404);
  return type;
}
// A rate plan of this business (of the room type, when given).
async function planOf(db, business, planId, type = null) {
  const plan = await repo.one(db, `SELECT p.*,k.tax_rate AS meal_tax_rate,k.label AS meal_item FROM lodging_rate_plans p LEFT JOIN catalog_skus k ON k.business_id=p.business_id AND k.id=p.meal_sku_id
    WHERE p.business_id=$1 AND p.id=$2`, [business.id, id(planId, 'Rate plan')]);
  if (!plan) fail('Rate plan not found', 404);
  if (type && Number(plan.room_type_id) !== Number(type.id)) fail(`${plan.name} is a plan of another room type`, 409);
  return plan;
}

// --- The rates of a stay's nights --------------------------------------------------------------------

const typePaise = (type) => ({ rack: c.paise(type.rack_rate), weekend: paiseOf(type.weekend_rate), extraAdult: paiseOf(type.extra_adult_rate), child: paiseOf(type.child_rate),
  extraBed: paiseOf(type.extra_bed_rate) });
const planPaise = (plan) => (plan ? { id: plan.id, room: paiseOf(plan.room_rate), weekend: paiseOf(plan.weekend_rate), mealSkuId: plan.meal_sku_id,
  mealAdult: paiseOf(plan.meal_adult_rate), mealChild: paiseOf(plan.meal_child_rate) } : null);

// Each night from the arrival to the night before the departure, with its rates and restrictions (paise).
// type: a room type row; plan: a plan row or null; agreed: paise or null.
async function nightsFor(db, business, { type, plan = null, arrival, departure, agreed = null }) {
  const settings = await c.settingsOf(db, business.id);
  const seasons = await repo.all(db, `SELECT rate_plan_id,starts_on::text,ends_on::text,weekday_rate,weekend_rate,extra_adult_rate,child_rate,extra_bed_rate,min_stay FROM lodging_seasons
    WHERE business_id=$1 AND room_type_id=$2 AND active AND starts_on<$4::date AND ends_on>=$3::date AND (rate_plan_id IS NULL OR rate_plan_id=$5)`,
  [business.id, type.id, arrival, departure, plan?.id || null]);
  const days = await repo.all(db, `SELECT rate_plan_id,day::text,room_rate,extra_adult_rate,child_rate,extra_bed_rate,min_stay,closed_to_arrival,stop_sell FROM lodging_rate_days
    WHERE business_id=$1 AND room_type_id=$2 AND day>=$3::date AND day<$4::date AND (rate_plan_id IS NULL OR rate_plan_id=$5)`, [business.id, type.id, arrival, departure, plan?.id || null]);
  return money.resolveNights(arrival, departure, {
    type: typePaise(type), plan: planPaise(plan), weekendNights: settings.weekend_nights, agreed,
    seasons: seasons.map((s) => ({ planId: s.rate_plan_id, startsOn: s.starts_on, endsOn: s.ends_on, weekday: c.paise(s.weekday_rate), weekend: paiseOf(s.weekend_rate),
      extraAdult: paiseOf(s.extra_adult_rate), child: paiseOf(s.child_rate), extraBed: paiseOf(s.extra_bed_rate), minStay: s.min_stay })),
    days: days.map((d) => ({ planId: d.rate_plan_id, day: d.day, room: paiseOf(d.room_rate), extraAdult: paiseOf(d.extra_adult_rate), child: paiseOf(d.child_rate),
      extraBed: paiseOf(d.extra_bed_rate), minStay: d.min_stay, closedToArrival: d.closed_to_arrival, stopSell: d.stop_sell })),
  });
}

// What the calendar refuses, in words.
function restrictionWords(type, found) {
  const words = {
    stop_sell: `${type.name} is not sold on the night of ${c.dayWords(found.night)} (stop-sell): choose other dates or another room type`,
    closed_to_arrival: `${type.name} is closed to arrival on ${c.dayWords(found.night)}: a stay of it arrives on another day`,
    min_stay: `${type.name} is sold for at least ${c.plural(found.minStay, 'night')} arriving on ${c.dayWords(found.night)}: book ${c.plural(found.minStay, 'night')} or more`,
  };
  return words[found.reason];
}
// The calendar's refusal of a stay, in words (409 with its reason), or nothing.
function checkRestrictions(type, rows, { arrival, nights, only = null }) {
  const found = money.restriction(rows, { arrival, nights, only });
  if (found) fail(restrictionWords(type, found), 409, { reason: found.reason, night: found.night, ...(found.minStay ? { minStay: found.minStay } : {}) });
}

// The policy a stay is booked under, as it is now (with whether its plan is refundable), or null when none applies.
async function policyFor(db, business, { plan = null, locationId }) {
  let row = plan?.policy_id ? await repo.one(db, 'SELECT * FROM lodging_policies WHERE business_id=$1 AND id=$2', [business.id, plan.policy_id]) : null;
  if (!row) {
    row = await repo.one(db, `SELECT * FROM lodging_policies WHERE business_id=$1 AND is_default AND active AND (location_id=$2 OR location_id IS NULL)
      ORDER BY location_id IS NULL LIMIT 1`, [business.id, locationId]);
  }
  const refundable = plan ? Boolean(plan.refundable) : true;
  if (!row && refundable) return null;
  const num = (x) => (x === null || x === undefined ? null : Number(x));
  return { id: row?.id || null, name: row?.name || null, refundable, earlyKind: row?.early_kind || null, earlyValue: num(row?.early_value), lateKind: row?.late_kind || null,
    lateValue: num(row?.late_value), cancelFreeHours: num(row?.cancel_free_hours), cancelKind: row?.cancel_kind || null, cancelValue: num(row?.cancel_value),
    noShowKind: row?.no_show_kind || null, depositKind: row?.deposit_kind || null, depositValue: num(row?.deposit_value), depositDays: num(row?.deposit_days) };
}

// A room type's price for a block of hours on one day (paise), refused when it has none for those hours.
async function dayUseRate(db, business, type, hours) {
  const row = await repo.one(db, 'SELECT rate FROM lodging_day_use_rates WHERE business_id=$1 AND room_type_id=$2 AND hours=$3', [business.id, type.id, hours]);
  if (!row) fail(`${type.name} has no day-use price for ${c.plural(hours, 'hour')}: set it under Settings › Room types & rates`, 409, { reason: 'no_day_use_rate' });
  return c.paise(row.rate);
}

// --- The rates screen ----------------------------------------------------------------------------------

const PLANS_SQL = `SELECT p.*,k.label AS meal_item,k.tax_rate AS meal_tax_rate,y.name AS policy_name,ts.label AS room_type FROM lodging_rate_plans p
  JOIN lodging_room_types t ON t.business_id=p.business_id AND t.id=p.room_type_id JOIN catalog_skus ts ON ts.business_id=t.business_id AND ts.id=t.sku_id
  LEFT JOIN catalog_skus k ON k.business_id=p.business_id AND k.id=p.meal_sku_id LEFT JOIN lodging_policies y ON y.business_id=p.business_id AND y.id=p.policy_id
  WHERE p.business_id=$1 ORDER BY p.active DESC,p.room_type_id,p.sort_order,lower(p.name),p.id`;

// Plans, seasons, day-use rates and policies, and a calendar of each date's rate and restrictions for a room type
// (and plan). query: { roomType?, plan?, from? (today), days? (14, at most 62) }
async function rates(business, query = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const db = repo.pool;
  const plans = await repo.all(db, PLANS_SQL, [business.id]);
  const seasons = await repo.all(db, `SELECT x.*,x.starts_on::text AS starts_on,x.ends_on::text AS ends_on,p.name AS plan_name FROM lodging_seasons x
    LEFT JOIN lodging_rate_plans p ON p.business_id=x.business_id AND p.id=x.rate_plan_id WHERE x.business_id=$1 ORDER BY x.active DESC,x.starts_on DESC,x.id LIMIT 500`, [business.id]);
  const dayUse = await repo.all(db, 'SELECT room_type_id,hours,rate FROM lodging_day_use_rates WHERE business_id=$1 ORDER BY room_type_id,hours', [business.id]);
  const policies = await repo.all(db, `SELECT y.*,l.name AS location_name FROM lodging_policies y LEFT JOIN business_locations l ON l.business_id=y.business_id AND l.id=y.location_id
    WHERE y.business_id=$1 ORDER BY y.active DESC,lower(y.name),y.id`, [business.id]);
  const firstType = await repo.one(db, 'SELECT id FROM lodging_room_types WHERE business_id=$1 AND active ORDER BY sort_order,id LIMIT 1', [business.id]);
  let calendar = null;
  const typeId = c.given(query.roomType) ? id(query.roomType, 'Room type') : firstType?.id;
  if (typeId) {
    const type = await typeOf(db, business, typeId);
    const plan = c.given(query.plan) ? await planOf(db, business, query.plan, type) : null;
    const from = c.given(query.from) ? c.readDate(query.from, 'From') : await c.today(db, business);
    const days = c.given(query.days) ? c.whole(query.days, 'Days', 1, 62) : 14;
    const rows = await nightsFor(db, business, { type, plan, arrival: from, departure: c.addDays(from, days) });
    const own = await repo.all(db, `SELECT id,rate_plan_id,day::text AS day,room_rate,extra_adult_rate,child_rate,extra_bed_rate,min_stay,closed_to_arrival,stop_sell FROM lodging_rate_days
      WHERE business_id=$1 AND room_type_id=$2 AND day>=$3::date AND day<$4::date AND (rate_plan_id IS NULL OR rate_plan_id=$5) ORDER BY day`,
    [business.id, type.id, from, c.addDays(from, days), plan?.id || null]);
    calendar = { roomTypeId: type.id, roomType: type.name, planId: plan?.id || null, plan: plan?.name || null, from, days,
      dates: rows.map((r) => ({ day: r.night, weekend: r.weekend, rateKind: r.rateKind, roomRate: rateText(r.roomRate), extraAdultRate: rateText(r.extraAdult),
        childRate: rateText(r.child), extraBedRate: rateText(r.extraBed), minStay: r.minStay, closedToArrival: r.closedToArrival, stopSell: r.stopSell,
        own: own.filter((o) => o.day === r.night) })) };
  }
  return { plans: plans.map((p) => ({ ...p, meal_plan_words: MEAL_WORDS[p.meal_plan] })), seasons, dayUse, policies, calendar, mealPlans: MEAL_WORDS };
}

// --- Rate plans ------------------------------------------------------------------------------------------

async function readPlan(db, business, body, current = null) {
  const keep = (key, column) => (body[key] === undefined && current ? current[column] : undefined);
  const name = keep('name', 'name') ?? v.requiredString(typeof body.name === 'string' ? body.name : '', 'Plan name', 80);
  const mealPlan = keep('mealPlan', 'meal_plan') ?? v.requiredEnum(body.mealPlan ?? 'EP', 'Meal plan', MEAL_PLANS);
  let mealSkuId = null, mealAdult = null, mealChild = null;
  if (mealPlan !== 'EP') {
    const skuValue = body.mealSkuId === undefined && current ? current.meal_sku_id : body.mealSkuId;
    if (!c.given(skuValue)) fail(`A plan ${MEAL_WORDS[mealPlan].toLowerCase()} names the food service item its meals are billed as`);
    const sku = await repo.one(db, `SELECT s.id,s.label,s.is_kit,p.kind,(s.active AND p.active) AS in_use FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(skuValue, 'Meal item')]);
    if (!sku) fail('Meal item not found', 404);
    if (sku.kind !== 'service' || sku.is_kit) fail(`${sku.label} is not a service item: a plan's meals are billed as a food service item`);
    if (await repo.one(db, 'SELECT 1 FROM lodging_room_types WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id])) fail(`${sku.label} is a room type's nights, not meals`);
    mealSkuId = sku.id;
    mealAdult = body.mealAdultRate === undefined && current?.meal_adult_rate !== null && current ? c.paise(current.meal_adult_rate)
      : c.readRate(body.mealAdultRate, 'The meals for an adult', { required: true, zero: true });
    mealChild = body.mealChildRate === undefined && current ? paiseOf(current.meal_child_rate) : c.readRate(body.mealChildRate, 'The meals for a child', { zero: true });
  }
  const roomRate = body.roomRate === undefined && current ? paiseOf(current.room_rate) : c.readRate(body.roomRate, 'The plan\'s room rate');
  const weekendRate = body.weekendRate === undefined && current ? paiseOf(current.weekend_rate) : c.readRate(body.weekendRate, 'The plan\'s weekend rate');
  if (weekendRate !== null && roomRate === null) fail('Give the plan\'s room rate with its weekend rate, or neither (the room type\'s rates)');
  const refundable = v.requiredBoolean(body.refundable, 'Refundable', current ? current.refundable : true);
  const policyValue = body.policyId === undefined && current ? current.policy_id : body.policyId;
  let policyId = null;
  if (c.given(policyValue)) {
    const policy = await repo.one(db, 'SELECT id,active,name FROM lodging_policies WHERE business_id=$1 AND id=$2', [business.id, id(policyValue, 'Policy')]);
    if (!policy) fail('Policy not found', 404);
    if (!policy.active && Number(policy.id) !== Number(current?.policy_id)) fail(`${policy.name} is switched off`, 409);
    policyId = policy.id;
  }
  return { name, mealPlan, mealSkuId, mealAdult, mealChild, roomRate, weekendRate, refundable, policyId,
    sortOrder: c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : current ? Number(current.sort_order) : 0,
    active: v.requiredBoolean(body.active, 'In use', current ? current.active : true) };
}
const planValues = (p) => [p.name, p.mealPlan, p.mealSkuId, rateText(p.mealAdult), rateText(p.mealChild), rateText(p.roomRate), rateText(p.weekendRate), p.refundable, p.policyId,
  p.sortOrder, p.active];
const planAudit = (p) => ({ name: p.name, mealPlan: p.mealPlan, mealSkuId: p.mealSkuId, mealAdultRate: rateText(p.mealAdult), mealChildRate: rateText(p.mealChild),
  roomRate: rateText(p.roomRate), weekendRate: rateText(p.weekendRate), refundable: p.refundable, policyId: p.policyId, active: p.active });

// body: { roomTypeId, name, mealPlan: EP | CP | MAP | AP, mealSkuId?, mealAdultRate?, mealChildRate?, roomRate?, weekendRate?, refundable?, policyId?, sortOrder? }
async function createPlan(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const type = await typeOf(db, business, body.roomTypeId);
    if (!type.active) fail(`${type.name} is switched off`, 409);
    const plan = await readPlan(db, business, body);
    if (await repo.one(db, 'SELECT 1 FROM lodging_rate_plans WHERE business_id=$1 AND room_type_id=$2 AND lower(name)=lower($3)', [business.id, type.id, plan.name])) {
      fail(`${type.name} has a plan called ${plan.name} already`, 409);
    }
    const row = await repo.one(db, `INSERT INTO lodging_rate_plans(business_id,room_type_id,name,meal_plan,meal_sku_id,meal_adult_rate,meal_child_rate,room_rate,weekend_rate,refundable,policy_id,
        sort_order,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`, [business.id, type.id, ...planValues(plan), user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_rate_plan.created', row.id, { roomType: type.name, ...planAudit(plan) });
  });
  return rates(business, { roomType: body.roomTypeId });
}

// body: what changes of a plan (its room type stays).
async function updatePlan(business, user, planId, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  let typeId;
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await planOf(db, business, planId);
    typeId = current.room_type_id;
    const plan = await readPlan(db, business, body, current);
    if (plan.name.toLowerCase() !== current.name.toLowerCase()
      && await repo.one(db, 'SELECT 1 FROM lodging_rate_plans WHERE business_id=$1 AND room_type_id=$2 AND lower(name)=lower($3) AND id<>$4', [business.id, typeId, plan.name, current.id])) {
      fail(`The room type has a plan called ${plan.name} already`, 409);
    }
    await db.query(`UPDATE lodging_rate_plans SET name=$3,meal_plan=$4,meal_sku_id=$5,meal_adult_rate=$6,meal_child_rate=$7,room_rate=$8,weekend_rate=$9,refundable=$10,policy_id=$11,
        sort_order=$12,active=$13,updated_by=$14,updated_at=now() WHERE business_id=$1 AND id=$2`, [business.id, current.id, ...planValues(plan), user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_rate_plan.updated', current.id, { name: plan.name, to: planAudit(plan) });
  });
  return rates(business, { roomType: typeId });
}

// --- Seasons -----------------------------------------------------------------------------------------------

async function readSeason(db, business, body, current = null) {
  const type = current ? await typeOf(db, business, current.room_type_id) : await typeOf(db, business, body.roomTypeId);
  const planValue = body.ratePlanId === undefined && current ? current.rate_plan_id : body.ratePlanId;
  const plan = c.given(planValue) ? await planOf(db, business, planValue, type) : null;
  const startsOn = body.startsOn === undefined && current ? current.starts_on : c.readDate(body.startsOn, 'From');
  const endsOn = body.endsOn === undefined && current ? current.ends_on : c.readDate(body.endsOn, 'To');
  if (endsOn < startsOn) fail('The season ends on or after the day it starts');
  if (money.nightCount(startsOn, endsOn) > MAX_DAYS) fail('A season runs at most a year');
  const rate = (key, column, label, options) => (body[key] === undefined && current ? paiseOf(current[column]) : c.readRate(body[key], label, options));
  return {
    type, plan, startsOn, endsOn,
    name: body.name === undefined && current ? current.name : v.requiredString(typeof body.name === 'string' ? body.name : '', 'Season name', 80),
    weekday: rate('weekdayRate', 'weekday_rate', 'The weekday rate', { required: true }), weekend: rate('weekendRate', 'weekend_rate', 'The weekend rate'),
    extraAdult: rate('extraAdultRate', 'extra_adult_rate', 'The rate for an extra adult', { zero: true }), child: rate('childRate', 'child_rate', 'The rate for a child', { zero: true }),
    extraBed: rate('extraBedRate', 'extra_bed_rate', 'The rate for an extra bed', { zero: true }),
    minStay: body.minStay === undefined && current ? current.min_stay : c.given(body.minStay) ? c.whole(body.minStay, 'Minimum stay', 1, 60) : null,
    active: v.requiredBoolean(body.active, 'In use', current ? current.active : true),
  };
}
// The season of the same room type and plan already covering one of these dates, in words, or null.
async function seasonClash(db, business, s, exceptId = null) {
  if (!s.active) return null;
  const other = await repo.one(db, `SELECT name,starts_on::text AS starts_on,ends_on::text AS ends_on FROM lodging_seasons WHERE business_id=$1 AND room_type_id=$2 AND active
    AND COALESCE(rate_plan_id,0)=$3 AND starts_on<=$5::date AND ends_on>=$4::date AND ($6::bigint IS NULL OR id<>$6) LIMIT 1`,
  [business.id, s.type.id, s.plan?.id || 0, s.startsOn, s.endsOn, exceptId]);
  return other ? `${other.name} (${c.dayWords(other.starts_on)} to ${c.dayWords(other.ends_on)}) covers some of these dates already: change its dates or switch it off first` : null;
}
const seasonValues = (s) => [s.name, s.plan?.id || null, s.startsOn, s.endsOn, rateText(s.weekday), rateText(s.weekend), rateText(s.extraAdult), rateText(s.child), rateText(s.extraBed),
  s.minStay, s.active];
const seasonAudit = (s) => ({ name: s.name, roomType: s.type.name, plan: s.plan?.name || null, startsOn: s.startsOn, endsOn: s.endsOn, weekdayRate: rateText(s.weekday),
  weekendRate: rateText(s.weekend), minStay: s.minStay, active: s.active });

// body: { roomTypeId, ratePlanId?, name, startsOn, endsOn, weekdayRate, weekendRate?, extraAdultRate?, childRate?, extraBedRate?, minStay? }
async function createSeason(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  let typeId;
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const season = await readSeason(db, business, body);
    typeId = season.type.id;
    const clash = await seasonClash(db, business, season);
    if (clash) fail(clash, 409);
    const row = await repo.one(db, `INSERT INTO lodging_seasons(business_id,room_type_id,name,rate_plan_id,starts_on,ends_on,weekday_rate,weekend_rate,extra_adult_rate,child_rate,extra_bed_rate,
        min_stay,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`, [business.id, season.type.id, ...seasonValues(season), user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_season.created', row.id, seasonAudit(season));
  });
  return rates(business, { roomType: typeId });
}

async function updateSeason(business, user, seasonId, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  let typeId;
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, 'SELECT *,starts_on::text AS starts_on,ends_on::text AS ends_on FROM lodging_seasons WHERE business_id=$1 AND id=$2 FOR UPDATE',
      [business.id, id(seasonId, 'Season')]);
    if (!current) fail('Season not found', 404);
    const season = await readSeason(db, business, body, current);
    typeId = season.type.id;
    const clash = await seasonClash(db, business, season, current.id);
    if (clash) fail(clash, 409);
    await db.query(`UPDATE lodging_seasons SET name=$3,rate_plan_id=$4,starts_on=$5,ends_on=$6,weekday_rate=$7,weekend_rate=$8,extra_adult_rate=$9,child_rate=$10,extra_bed_rate=$11,
        min_stay=$12,active=$13,updated_by=$14,updated_at=now() WHERE business_id=$1 AND id=$2`, [business.id, current.id, ...seasonValues(season), user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_season.updated', current.id, seasonAudit(season));
  });
  return rates(business, { roomType: typeId });
}

// --- The calendar's dates ------------------------------------------------------------------------------------

// body: { roomTypeId, ratePlanId?, from, to, weekdays?: [1-7] (every day when left out), roomRate?, extraAdultRate?, childRate?, extraBedRate?,
//   minStay?, closedToArrival?, stopSell?, clear?: true } — each date's own rates and restrictions; what is left out stays, null clears it;
// `clear` takes the dates' own settings off.
async function setDays(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  const from = c.readDate(body.from, 'From');
  const to = c.readDate(body.to, 'To');
  if (to < from) fail('The end date is before the start date');
  if (money.nightCount(from, to) >= MAX_DAYS) fail('Set at most a year of dates at once');
  const weekdays = body.weekdays === undefined || body.weekdays === null ? null : v.requiredArray(body.weekdays, 'Days of the week').map((d) => c.whole(d, 'A day of the week', 1, 7));
  const clear = v.requiredBoolean(body.clear, 'Clear', false);
  const rate = (key, label, options) => (body[key] === undefined ? undefined : body[key] === null || body[key] === '' ? null : c.readRate(body[key], label, options));
  const change = clear ? null : {
    room_rate: rate('roomRate', 'The night\'s room rate'), extra_adult_rate: rate('extraAdultRate', 'The rate for an extra adult', { zero: true }),
    child_rate: rate('childRate', 'The rate for a child', { zero: true }), extra_bed_rate: rate('extraBedRate', 'The rate for an extra bed', { zero: true }),
    min_stay: body.minStay === undefined ? undefined : c.given(body.minStay) ? c.whole(body.minStay, 'Minimum stay', 1, 60) : null,
    closed_to_arrival: body.closedToArrival === undefined ? undefined : v.requiredBoolean(body.closedToArrival, 'Closed to arrival'),
    stop_sell: body.stopSell === undefined ? undefined : v.requiredBoolean(body.stopSell, 'Stop-sell'),
  };
  if (change && Object.values(change).every((x) => x === undefined)) fail('Say what the dates change: a rate, the minimum stay, closed to arrival or stop-sell');
  let typeId, count = 0;
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const type = await typeOf(db, business, body.roomTypeId);
    typeId = type.id;
    const plan = c.given(body.ratePlanId) ? await planOf(db, business, body.ratePlanId, type) : null;
    for (let day = from; day <= to; day = c.addDays(day, 1)) {
      if (weekdays && !weekdays.includes(money.isoDay(day))) continue;
      const row = await repo.one(db, 'SELECT * FROM lodging_rate_days WHERE business_id=$1 AND room_type_id=$2 AND COALESCE(rate_plan_id,0)=$3 AND day=$4 FOR UPDATE',
        [business.id, type.id, plan?.id || 0, day]);
      if (clear) {
        if (row) { await db.query('DELETE FROM lodging_rate_days WHERE business_id=$1 AND id=$2', [business.id, row.id]); count += 1; }
        continue;
      }
      const merged = Object.fromEntries(Object.entries(change).map(([k, value]) => [k, value === undefined ? (row ? row[k] : null) : value]));
      const money2 = (p, k) => (change[k] === undefined ? p : rateText(p));
      const values = [money2(merged.room_rate, 'room_rate'), money2(merged.extra_adult_rate, 'extra_adult_rate'), money2(merged.child_rate, 'child_rate'),
        money2(merged.extra_bed_rate, 'extra_bed_rate'), merged.min_stay, Boolean(merged.closed_to_arrival), Boolean(merged.stop_sell)];
      const empty = values.slice(0, 5).every((x) => x === null || x === undefined) && !values[5] && !values[6];
      if (empty) {
        if (row) await db.query('DELETE FROM lodging_rate_days WHERE business_id=$1 AND id=$2', [business.id, row.id]);
      } else if (row) {
        await db.query(`UPDATE lodging_rate_days SET room_rate=$3,extra_adult_rate=$4,child_rate=$5,extra_bed_rate=$6,min_stay=$7,closed_to_arrival=$8,stop_sell=$9,updated_by=$10,updated_at=now()
          WHERE business_id=$1 AND id=$2`, [business.id, row.id, ...values, user.id]);
      } else {
        await db.query(`INSERT INTO lodging_rate_days(business_id,room_type_id,rate_plan_id,day,room_rate,extra_adult_rate,child_rate,extra_bed_rate,min_stay,closed_to_arrival,stop_sell,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [business.id, type.id, plan?.id || null, day, ...values, user.id]);
      }
      count += 1;
    }
    await repo.audit(db, business.id, user.id, clear ? 'lodging_rate_days.cleared' : 'lodging_rate_days.set', type.id, { roomType: type.name, plan: plan?.name || null, from, to,
      weekdays, dates: count, ...(change ? { change: Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined).map(([k, value]) => [k, typeof value === 'number' && k.endsWith('rate') ? rateText(value) : value])) } : {}) });
  });
  return { ...(await rates(business, { roomType: typeId, plan: body.ratePlanId, from, days: Math.min(62, money.nightCount(from, to) + 1) })), dates: count };
}

// body: { roomTypeId, rates: [{ hours, rate }] } — the room type's day-use prices, in place of those it had.
async function setDayUseRates(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  const list = v.requiredArray(body.rates, 'Day-use prices');
  if (list.length > 12) fail('At most 12 blocks of hours');
  const blocks = list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Day-use price ${index + 1} must be an object`);
    return { hours: c.whole(raw.hours, 'Hours', 1, 12), rate: c.readRate(raw.rate, `The price for ${raw.hours} hours`, { required: true }) };
  });
  if (new Set(blocks.map((b) => b.hours)).size !== blocks.length) fail('Each block of hours is priced once');
  let typeId;
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const type = await typeOf(db, business, body.roomTypeId);
    typeId = type.id;
    await db.query('DELETE FROM lodging_day_use_rates WHERE business_id=$1 AND room_type_id=$2', [business.id, type.id]);
    for (const b of blocks) {
      await db.query('INSERT INTO lodging_day_use_rates(business_id,room_type_id,hours,rate,updated_by) VALUES($1,$2,$3,$4,$5)', [business.id, type.id, b.hours, rateText(b.rate), user.id]);
    }
    await repo.audit(db, business.id, user.id, 'lodging_day_use_rates.set', type.id, { roomType: type.name, rates: blocks.map((b) => ({ hours: b.hours, rate: rateText(b.rate) })) });
  });
  return rates(business, { roomType: typeId });
}

// --- Policies -----------------------------------------------------------------------------------------------

const TIME_KINDS = ['percent', 'flat', 'night'];
async function readPolicy(db, business, body, current = null) {
  const keep = (key, column) => (body[key] === undefined && current ? current[column] : undefined);
  const name = keep('name', 'name') ?? v.requiredString(typeof body.name === 'string' ? body.name : '', 'Policy name', 80);
  const locationValue = body.locationId === undefined && current ? current.location_id : body.locationId;
  let locationId = null;
  if (c.given(locationValue)) {
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, id(locationValue, 'Property')]);
    if (!location) fail('Property not found', 404);
    locationId = location.id;
  }
  const kind = (key, column, label, list) => {
    const value = body[key] === undefined && current ? current[column] : body[key];
    return c.given(value) ? v.requiredEnum(value, label, list) : null;
  };
  const amount = (key, column, label, needed, most) => {
    if (!needed) return null;
    const value = body[key] === undefined && current ? current[column] : body[key];
    return core.decimal(value, label, 2, 0.01, most);
  };
  const earlyKind = kind('earlyKind', 'early_kind', 'Early check-in charged as', TIME_KINDS);
  const lateKind = kind('lateKind', 'late_kind', 'Late check-out charged as', TIME_KINDS);
  const cancelKind = kind('cancelKind', 'cancel_kind', 'A cancellation charged as', ['nights', 'percent']);
  const depositKind = kind('depositKind', 'deposit_kind', 'Deposit', ['percent', 'first_night']);
  const freeHours = cancelKind ? c.whole(body.cancelFreeHours === undefined && current ? current.cancel_free_hours : body.cancelFreeHours, 'Free until (hours before arrival)', 0, 8760) : null;
  const depositDays = depositKind ? c.whole(body.depositDays === undefined && current ? current.deposit_days : body.depositDays ?? 0, 'Deposit due (days before arrival)', 0, 365) : null;
  return {
    name, locationId,
    isDefault: v.requiredBoolean(body.isDefault, 'The property\'s policy', current ? current.is_default : false),
    earlyKind, earlyValue: amount('earlyValue', 'early_value', 'Early check-in charge', ['percent', 'flat'].includes(earlyKind), earlyKind === 'percent' ? 100 : 1000000),
    lateKind, lateValue: amount('lateValue', 'late_value', 'Late check-out charge', ['percent', 'flat'].includes(lateKind), lateKind === 'percent' ? 100 : 1000000),
    cancelFreeHours: freeHours, cancelKind,
    cancelValue: cancelKind === 'nights' ? c.whole(body.cancelValue === undefined && current ? Number(current.cancel_value) : body.cancelValue, 'Nights charged', 1, 30)
      : amount('cancelValue', 'cancel_value', 'Percentage of the stay charged', cancelKind === 'percent', 100),
    noShowKind: kind('noShowKind', 'no_show_kind', 'A no-show charged', ['first_night', 'full_stay']),
    depositKind, depositValue: amount('depositValue', 'deposit_value', 'Deposit (percentage of the stay)', depositKind === 'percent', 100), depositDays,
    active: v.requiredBoolean(body.active, 'In use', current ? current.active : true),
  };
}
const policyValues = (p) => [p.name, p.locationId, p.isDefault, p.earlyKind, p.earlyValue, p.lateKind, p.lateValue, p.cancelFreeHours, p.cancelKind, p.cancelValue, p.noShowKind,
  p.depositKind, p.depositValue, p.depositDays, p.active];
// One default a property (and one for the business): a new default takes over from the one before.
async function takeDefault(db, business, p, exceptId = null) {
  if (!p.isDefault || !p.active) return;
  await db.query(`UPDATE lodging_policies SET is_default=FALSE,updated_at=now() WHERE business_id=$1 AND is_default AND COALESCE(location_id,0)=$2 AND ($3::bigint IS NULL OR id<>$3)`,
    [business.id, p.locationId || 0, exceptId]);
}

// body: { name, locationId? (none: every property), isDefault?, earlyKind?, earlyValue?, lateKind?, lateValue?, cancelFreeHours?, cancelKind?, cancelValue?,
//   noShowKind?, depositKind?, depositValue?, depositDays? }
async function createPolicy(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'settings.edit');
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const p = await readPolicy(db, business, body);
    if (await repo.one(db, 'SELECT 1 FROM lodging_policies WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, p.name])) fail(`There is a policy called ${p.name} already`, 409);
    await takeDefault(db, business, p);
    const row = await repo.one(db, `INSERT INTO lodging_policies(business_id,name,location_id,is_default,early_kind,early_value,late_kind,late_value,cancel_free_hours,cancel_kind,cancel_value,
        no_show_kind,deposit_kind,deposit_value,deposit_days,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING id`,
    [business.id, ...policyValues(p), user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_policy.created', row.id, p);
  });
  return rates(business, {});
}

async function updatePolicy(business, user, policyId, body) {
  c.requireLodging(business);
  await access.require(business, 'settings.edit');
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, 'SELECT * FROM lodging_policies WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(policyId, 'Policy')]);
    if (!current) fail('Policy not found', 404);
    const p = await readPolicy(db, business, body, current);
    if (p.name.toLowerCase() !== current.name.toLowerCase() && await repo.one(db, 'SELECT 1 FROM lodging_policies WHERE business_id=$1 AND lower(name)=lower($2) AND id<>$3',
      [business.id, p.name, current.id])) fail(`There is a policy called ${p.name} already`, 409);
    await takeDefault(db, business, p, current.id);
    await db.query(`UPDATE lodging_policies SET name=$3,location_id=$4,is_default=$5,early_kind=$6,early_value=$7,late_kind=$8,late_value=$9,cancel_free_hours=$10,cancel_kind=$11,cancel_value=$12,
        no_show_kind=$13,deposit_kind=$14,deposit_value=$15,deposit_days=$16,active=$17,updated_by=$18,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, current.id, ...policyValues(p), user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_policy.updated', current.id, p);
  });
  return rates(business, {});
}

module.exports = { MEAL_PLANS, MEAL_WORDS, typeOf, planOf, nightsFor, restrictionWords, checkRestrictions, policyFor, dayUseRate, rates, createPlan, updatePlan, createSeason, updateSeason, setDays,
  setDayUseRates, createPolicy, updatePolicy };
