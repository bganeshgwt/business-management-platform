const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./lodgingCommon');
const money = require('./lodgingMoney');

// The house's figures (module "lodging") for dates on the business's calendar,
// for one property or every property (each property's own and in all):
//
//   available   each room in use, a night for each date from the day it was
//               added, less its nights out of order
//   sold        the room nights posted (by the night audit or at check-out) and
//               not voided; a day use is not a room night
//   revenue     those nights' value before GST, after a stay's discount, without
//               meals, extras, early check-in and late check-out
//   occupancy   sold ÷ available; ADR revenue ÷ sold; RevPAR revenue ÷ available
// Each by room type (against that type's rooms), and by source (walk-in, phone,
// each OTA) and by rate plan (each against all the rooms available: its share
// of the house).

const { fail, id } = c;
const MAX_DAYS = 366;

// Rooms by property and type, with their room nights in the dates and those out of order.
const AVAILABLE_SQL = `SELECT x.location_id,x.room_type_id,count(*)::int AS nights,count(*) FILTER (WHERE x.down)::int AS down FROM (
    SELECT r.location_id,r.room_type_id,EXISTS (SELECT 1 FROM lodging_out_of_order o WHERE o.business_id=r.business_id AND o.room_id=r.id AND o.cancelled_at IS NULL
      AND o.starts_on<=n::date AND (o.ends_on IS NULL OR o.ends_on>=n::date)) AS down
    FROM lodging_rooms r JOIN businesses z ON z.id=r.business_id
    CROSS JOIN LATERAL generate_series(GREATEST($2::date,(r.created_at AT TIME ZONE z.timezone)::date)::timestamp,$3::date::timestamp,interval '1 day') n
    WHERE r.business_id=$1 AND r.active AND ($4::bigint IS NULL OR r.location_id=$4)) x
  GROUP BY x.location_id,x.room_type_id`;
// The room nights posted on those dates, by property, type, source (each OTA by its name) and plan.
const SOLD_SQL = `SELECT s.location_id,t.id AS room_type_id,s.source,CASE WHEN s.source='ota' THEN lower(btrim(s.ota_name)) END AS ota_key,max(s.ota_name) AS ota_name,
    s.rate_plan_id,count(*)::int AS sold,COALESCE(sum(ch.amount),0) AS revenue
  FROM lodging_charges ch JOIN lodging_stays s ON s.business_id=ch.business_id AND s.id=ch.stay_id
  JOIN lodging_room_types t ON t.business_id=ch.business_id AND t.sku_id=ch.sku_id
  WHERE ch.business_id=$1 AND ch.kind='room_night' AND ch.voided_at IS NULL AND ch.night BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR s.location_id=$4)
  GROUP BY s.location_id,t.id,s.source,ota_key,s.rate_plan_id`;

// A row's figures: room nights available and sold, the revenue, occupancy, ADR and RevPAR (money as rupees).
function figures(key, label, { available, outOfOrder = null, sold, revenue }, extra = {}) {
  const r = money.ratios({ sold, available, revenue });
  return { key, label, ...extra, available, ...(outOfOrder !== null ? { outOfOrder } : {}), sold, revenue: money.rupees(revenue), occupancy: r.occupancy,
    adr: r.adr === null ? null : money.rupees(r.adr), revpar: r.revpar === null ? null : money.rupees(r.revpar) };
}
const add = (rows, pick) => rows.reduce((sum, r) => sum + pick(r), 0);

// query: { from?, to? (YYYY-MM-DD; this month so far), location? (one property; every property when left out) }
async function report(business, query = {}) {
  c.requireLodging(business);
  await access.require(business, 'reports.view');
  const today = await c.today(repo.pool, business);
  const from = c.given(query.from) ? c.readDate(query.from, 'From') : `${today.slice(0, 8)}01`;
  const to = c.given(query.to) ? c.readDate(query.to, 'To') : today;
  if (to < from) fail('The end date is before the start date');
  if (money.nightCount(from, to) >= MAX_DAYS) fail('Choose up to a year of dates');
  const scope = business.location_scope || (c.given(query.location) ? id(query.location, 'Property') : null);
  const values = [business.id, from, to, scope];
  const available = await repo.all(repo.pool, AVAILABLE_SQL, values);
  const sold = await repo.all(repo.pool, SOLD_SQL, values);
  const locations = await repo.all(repo.pool, 'SELECT id,name FROM business_locations WHERE business_id=$1 ORDER BY name,id', [business.id]);
  const types = await repo.all(repo.pool, `SELECT t.id,s.label AS name,t.sort_order FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
    WHERE t.business_id=$1 ORDER BY t.sort_order,lower(s.label),t.id`, [business.id]);
  const plans = await repo.all(repo.pool, `SELECT p.id,p.name,p.meal_plan,s.label AS room_type FROM lodging_rate_plans p JOIN lodging_room_types t ON t.business_id=p.business_id AND t.id=p.room_type_id
    JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id WHERE p.business_id=$1`, [business.id]);
  const room = (rows) => ({ available: add(rows, (r) => r.nights - r.down), outOfOrder: add(rows, (r) => r.down) });
  const sales = (rows) => ({ sold: add(rows, (r) => r.sold), revenue: add(rows, (r) => c.paise(r.revenue)) });
  const all = { ...room(available), ...sales(sold) };
  const same = (a, b) => Number(a) === Number(b);
  // Each property's own figures, and in all.
  const properties = locations.filter((l) => available.some((r) => same(r.location_id, l.id)) || sold.some((r) => same(r.location_id, l.id)))
    .map((l) => figures(String(l.id), l.name, { ...room(available.filter((r) => same(r.location_id, l.id))), ...sales(sold.filter((r) => same(r.location_id, l.id))) }, { locationId: l.id }));
  const byType = types.filter((t) => available.some((r) => same(r.room_type_id, t.id)) || sold.some((r) => same(r.room_type_id, t.id)))
    .map((t) => figures(String(t.id), t.name, { ...room(available.filter((r) => same(r.room_type_id, t.id))), ...sales(sold.filter((r) => same(r.room_type_id, t.id))) }, { roomTypeId: t.id }));
  // By source and by plan, each against all the rooms available.
  const sourceKeys = [...new Set(sold.map((r) => (r.source === 'ota' ? `ota:${r.ota_key}` : r.source)))];
  const bySource = sourceKeys.map((key) => {
    const rows = sold.filter((r) => (r.source === 'ota' ? `ota:${r.ota_key}` : r.source) === key);
    const label = rows[0].source === 'ota' ? rows[0].ota_name : c.SOURCE_WORDS[rows[0].source];
    return figures(key, label, { available: all.available, ...sales(rows) }, { source: rows[0].source });
  }).sort((a, b) => b.sold - a.sold || a.label.localeCompare(b.label));
  const planKeys = [...new Set(sold.map((r) => String(r.rate_plan_id || '')))];
  const byPlan = planKeys.map((key) => {
    const plan = plans.find((p) => String(p.id) === key);
    const rows = sold.filter((r) => String(r.rate_plan_id || '') === key);
    return figures(key || 'none', plan ? `${plan.name} (${plan.room_type}, ${plan.meal_plan})` : 'No rate plan', { available: all.available, ...sales(rows) }, { ratePlanId: plan?.id || null,
      mealPlan: plan?.meal_plan || null });
  }).sort((a, b) => b.sold - a.sold || a.label.localeCompare(b.label));
  return { from, to, days: money.nightCount(from, to) + 1, locationId: scope, total: figures('all', 'In all', all), properties, byType, bySource, byPlan };
}

module.exports = { report };
