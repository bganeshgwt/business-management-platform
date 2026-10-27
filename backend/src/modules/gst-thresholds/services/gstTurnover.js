const repo = require('../../business/core/repositories/business.repository');
const { toPaise } = require('./gstThresholdsRules');

// What each business's own records say, read only: who owns it, what decides
// its PAN, its own date, what it sold less what came back, and its HSN / SAC
// codes. A shop reads the shared core; a restaurant its own bills, through its
// business row (businesses.legacy_restaurant_id).

// The figures as the platform keeps them (platform_gst_thresholds).
const thresholds = (db = repo.pool) => repo.all(db, `SELECT id, code, name, applies, turnover::text AS turnover, comparison, hsn_digits,
  report_within_days, applies_from::text AS applies_from, source
  FROM platform_gst_thresholds ORDER BY platform_gst_thresholds.turnover, code, applies_from NULLS FIRST`);

// The owners of a business: its people with the Owner role (full access), still active.
const owners = async (businessId, db = repo.pool) => (await repo.all(db, `SELECT m.user_id::text AS id FROM business_memberships m
  JOIN business_roles r ON r.business_id = m.business_id AND r.id = m.role_id AND r.full_access AND r.active
  WHERE m.business_id = $1 AND m.active ORDER BY m.user_id`, [businessId])).map((row) => row.id);

// The businesses these people own (the Owner role in an active business; a
// restaurant's only while the restaurant is active), one row per owner and
// business, with:
//   today       the business's own date (a restaurant's trading date, business_tax_change_today)
//   started_on  the day it came onto the platform, on its own clock
//   gstins      its GSTIN and its locations' (a restaurant: its GST number and its outlets')
//   recorded_pan, recorded_at   the PAN its owner recorded while it has no GSTIN
// `businessId`: that business only (its row for each of these owners).
const ownedBusinesses = (ownerIds, businessId = null) => repo.all(repo.pool, `SELECT m.user_id::text AS owner_id, b.id::text AS id, b.name, b.code,
  b.business_type, b.legacy_restaurant_id::text AS legacy_restaurant_id,
  CASE rf.format WHEN 'cafe' THEN 'Café' WHEN 'bakery' THEN 'Bakery' WHEN 'cloud_kitchen' THEN 'Cloud kitchen' ELSE t.name END AS type_name,
  business_tax_change_today(b.id)::text AS today,
  (COALESCE(rf.created_at, b.created_at) AT TIME ZONE COALESCE(rs.timezone, b.timezone))::date::text AS started_on,
  CASE WHEN b.legacy_restaurant_id IS NULL
    THEN array_remove(ARRAY[s.gstin::text] || ARRAY(SELECT l.gstin::text FROM business_locations l
      WHERE l.business_id = b.id AND l.active AND l.gstin IS NOT NULL ORDER BY l.id), NULL)
    ELSE array_remove(ARRAY[NULLIF(btrim(rs.gst_number), '')] || ARRAY(SELECT o.gst_number::text FROM outlets o
      WHERE o.restaurant_id = b.legacy_restaurant_id AND o.status = 'active' AND o.gst_number IS NOT NULL ORDER BY o.id), NULL)
  END AS gstins,
  p.pan AS recorded_pan, p.recorded_at
  FROM business_memberships m
  JOIN business_roles r ON r.business_id = m.business_id AND r.id = m.role_id AND r.full_access AND r.active
  JOIN businesses b ON b.id = m.business_id AND b.status = 'active'
  JOIN business_types t ON t.code = b.business_type
  LEFT JOIN restaurants rf ON rf.id = b.legacy_restaurant_id
  LEFT JOIN restaurant_settings rs ON rs.restaurant_id = b.legacy_restaurant_id
  LEFT JOIN business_settings s ON s.business_id = b.id
  LEFT JOIN business_gst_pans p ON p.business_id = b.id
  WHERE m.user_id = ANY($1::bigint[]) AND m.active AND (rf.id IS NULL OR rf.status = 'active') AND ($2::bigint IS NULL OR b.id = $2)
  ORDER BY b.name, b.id, m.user_id`, [ownerIds, businessId]);

// Each owner's warning level, where they set one.
const warnLevels = async (ownerIds, db = repo.pool) => new Map((await repo.all(db,
  'SELECT user_id::text AS id, warn_percent FROM owner_gst_settings WHERE user_id = ANY($1::bigint[])', [ownerIds])).map((row) => [row.id, Number(row.warn_percent)]));

// Today in India, for someone who owns no business yet (the figures' "in force" on the page).
const indiaToday = async (db = repo.pool) => (await repo.one(db, "SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS day")).day;

// What each business sold less what came back, in paise: the financial year
// from its first day to the business's own today, and the whole year before.
//   businesses  [{ id, legacy_restaurant_id, today }]
//   year, lastYear  { from, to } (financialYear)
// A shop: its sales (business_documents of kind sale) at their value before
// GST (subtotal: every line's value, nil-rated and exempt lines included),
// less its sale returns at the value of the lines taken back, each on its
// own posting date in the business's time zone, as Reports count them. A
// restaurant: its bills (all but void ones) at their value of supply before
// GST (taxable_amount: the dishes after discounts, the service and delivery
// charges), less its credit notes at their taxable value, each on its own
// business day (else its date on the restaurant's clock), as the GST pack
// counts them; a refund from before credit notes were written counts at its
// bill's share. Returns Map(business id → { thisYear, lastYear }).
async function turnover(businesses, year, lastYear, db = repo.pool) {
  const sums = new Map(businesses.map((b) => [String(b.id), { thisYear: 0, lastYear: 0 }]));
  const shops = businesses.filter((b) => !b.legacy_restaurant_id);
  const restaurants = businesses.filter((b) => b.legacy_restaurant_id);
  const totals = `COALESCE(sum(m.value) FILTER (WHERE m.day >= $3::date AND m.day <= r.today), 0)::text AS this_year,
    COALESCE(sum(m.value) FILTER (WHERE m.day >= $2::date AND m.day < $3::date), 0)::text AS last_year`;
  if (shops.length) {
    const rows = await repo.all(db, `WITH r AS (SELECT * FROM unnest($1::bigint[], $4::date[]) AS r(id, today)),
      moves AS (
        SELECT d.business_id AS id, (d.created_at AT TIME ZONE b.timezone)::date AS day, d.subtotal AS value
        FROM r JOIN businesses b ON b.id = r.id
        JOIN business_documents d ON d.business_id = r.id AND d.kind = 'sale' AND d.created_at >= ($2::date::timestamp AT TIME ZONE b.timezone)
        UNION ALL
        SELECT x.business_id, (x.created_at AT TIME ZONE b.timezone)::date,
          -COALESCE((SELECT sum(l.net) FROM business_return_lines l WHERE l.business_id = x.business_id AND l.return_id = x.id), 0)
        FROM r JOIN businesses b ON b.id = r.id
        JOIN business_returns x ON x.business_id = r.id AND x.created_at >= ($2::date::timestamp AT TIME ZONE b.timezone)
        JOIN business_documents d ON d.business_id = x.business_id AND d.id = x.document_id AND d.kind = 'sale')
      SELECT r.id::text AS id, ${totals} FROM r LEFT JOIN moves m ON m.id = r.id GROUP BY r.id`,
    [shops.map((b) => b.id), lastYear.from, year.from, shops.map((b) => b.today)]);
    for (const row of rows) sums.set(row.id, { thisYear: toPaise(row.this_year), lastYear: toPaise(row.last_year) });
  }
  if (restaurants.length) {
    // A bill's business day is never after its own date on the restaurant's
    // clock, so bills raised before the earlier year began cannot be in it.
    const rows = await repo.all(db, `WITH r AS (SELECT r.id, r.today, COALESCE(s.timezone, 'Asia/Kolkata') AS zone
        FROM unnest($1::bigint[], $4::date[]) AS r(id, today) LEFT JOIN restaurant_settings s ON s.restaurant_id = r.id),
      moves AS (
        SELECT b.restaurant_id AS id, COALESCE(bd.business_date, (b.billed_at AT TIME ZONE r.zone)::date) AS day,
          COALESCE(b.taxable_amount, b.total_amount - b.tax_amount - b.round_off) AS value
        FROM r JOIN bills b ON b.restaurant_id = r.id AND b.bill_status <> 'void' AND b.billed_at >= ($2::date::timestamp AT TIME ZONE r.zone)
        LEFT JOIN business_days bd ON bd.id = b.business_day_id
        UNION ALL
        SELECT f.restaurant_id, COALESCE(fd.business_date, (COALESCE(cn.issued_at, f.refunded_at) AT TIME ZONE r.zone)::date),
          -COALESCE(cn.taxable_value,
            round(f.amount * COALESCE(b.taxable_amount, b.total_amount - b.tax_amount - b.round_off) / NULLIF(b.total_amount, 0), 2), 0)
        FROM r JOIN refunds f ON f.restaurant_id = r.id AND f.refund_kind = 'credit_note'
          AND f.refunded_at >= ($2::date::timestamp AT TIME ZONE r.zone) - interval '1 day'
        LEFT JOIN credit_notes cn ON cn.refund_id = f.id
        JOIN bills b ON b.id = f.bill_id
        LEFT JOIN business_days fd ON fd.id = COALESCE(cn.business_day_id, f.business_day_id)
        WHERE cn.id IS NOT NULL OR b.bill_status <> 'void')
      SELECT r.id::text AS id, ${totals} FROM r LEFT JOIN moves m ON m.id = r.id GROUP BY r.id`,
    [restaurants.map((b) => b.legacy_restaurant_id), lastYear.from, year.from, restaurants.map((b) => b.today)]);
    const byRestaurant = new Map(restaurants.map((b) => [String(b.legacy_restaurant_id), String(b.id)]));
    for (const row of rows) sums.set(byRestaurant.get(row.id), { thisYear: toPaise(row.this_year), lastYear: toPaise(row.last_year) });
  }
  return sums;
}

// How many items print an HSN / SAC code shorter than `digits` (none counts as
// shorter): a shop's active items that are billed under their own code (not a
// kit, whose parts are billed, nor an item kept for use in services); a
// restaurant's tax rates (a dish prints its rate's code) that a dish on the
// menu is charged at. Returns Map(business id → count).
async function hsnShort(businesses, digits, db = repo.pool) {
  const counts = new Map(businesses.map((b) => [String(b.id), 0]));
  const shops = businesses.filter((b) => !b.legacy_restaurant_id).map((b) => b.id);
  const restaurants = businesses.filter((b) => b.legacy_restaurant_id);
  if (shops.length) {
    for (const row of await repo.all(db, `SELECT s.business_id::text AS id, count(*)::int AS n FROM catalog_skus s
      WHERE s.business_id = ANY($1::bigint[]) AND s.active AND NOT s.is_kit AND NOT s.internal_use AND COALESCE(length(s.hsn_code), 0) < $2
      GROUP BY s.business_id`, [shops, digits])) counts.set(row.id, row.n);
  }
  if (restaurants.length) {
    const byRestaurant = new Map(restaurants.map((b) => [String(b.legacy_restaurant_id), String(b.id)]));
    for (const row of await repo.all(db, `SELECT t.restaurant_id::text AS id, count(*)::int AS n FROM tax_rates t
      WHERE t.restaurant_id = ANY($1::bigint[]) AND length(regexp_replace(COALESCE(t.hsn_code, ''), '[^0-9]', '', 'g')) < $2
        AND EXISTS (SELECT 1 FROM products p WHERE p.tax_rate_id = t.id AND p.status = 'active')
      GROUP BY t.restaurant_id`, [restaurants.map((b) => b.legacy_restaurant_id), digits])) counts.set(byRestaurant.get(row.id), row.n);
  }
  return counts;
}

// A restaurant's tax rates whose HSN / SAC code is shorter than `digits`, with
// the dishes on the menu charged at each.
const menuRatesShort = (restaurantId, digits, db = repo.pool) => repo.all(db, `SELECT t.id, t.name, t.percentage::text AS percentage, t.hsn_code,
  (SELECT count(*)::int FROM products p WHERE p.tax_rate_id = t.id AND p.status = 'active') AS dishes
  FROM tax_rates t WHERE t.restaurant_id = $1 AND length(regexp_replace(COALESCE(t.hsn_code, ''), '[^0-9]', '', 'g')) < $2
    AND EXISTS (SELECT 1 FROM products p WHERE p.tax_rate_id = t.id AND p.status = 'active')
  ORDER BY t.percentage, t.name`, [restaurantId, digits]);

// Of these businesses, those whose money this person may see: their Owner
// role there, or a role holding reports.view.
const moneySeen = async (userId, businessIds, db = repo.pool) => new Set((await repo.all(db, `SELECT m.business_id::text AS id
  FROM business_memberships m JOIN business_roles r ON r.business_id = m.business_id AND r.id = m.role_id AND r.active
  JOIN businesses b ON b.id = m.business_id AND b.status = 'active'
  WHERE m.user_id = $1 AND m.active AND m.business_id = ANY($2::bigint[])
    AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id = r.business_id AND p.role_id = r.id
      AND p.permission_code = 'reports.view'))`, [userId, businessIds])).map((row) => row.id));

module.exports = { thresholds, owners, ownedBusinesses, warnLevels, indiaToday, turnover, hsnShort, menuRatesShort, moneySeen };
