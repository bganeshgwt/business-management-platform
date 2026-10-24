const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// The statutory outputs of a farm-input shop, each worked out from its bills,
// receipts and stock movements (nothing is typed twice):
//   board               the daily stock and price board of one location: the
//                       opening stock of each fertiliser and seed on a day
//                       (its closing stock too, for a day gone by) and its
//                       price and MRP now, to print for display
//   seed return         the seed stock return of a month: for each seed, the
//                       stock on the first, what was bought and sold (net of
//                       goods returned), other changes and the closing stock,
//                       in quintals where its weight is known; due by the 5th
//   insecticide register  every pesticide sold: date, bill, farmer, product,
//                       batch, manufacturer, quantity, expiry and crop
// Stock on a day is the stock now less every movement since that day began
// (business_stock_movements, on the business's own clock).

const { fail, requireAgri } = common;
const id = (value, name = 'Record ID') => v.requiredId(value, name);

async function locationOf(business, value) {
  const locationId = id(value, 'Location');
  access.requireLocation(business, locationId);
  const location = await repo.one(repo.pool, 'SELECT id,name,code FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId]);
  if (!location) fail('Location not found', 404);
  return location;
}

// query: { locationId, on? (today) } — no day after today.
async function board(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = await locationOf(business, query.locationId ?? query.location);
  const today = await common.today(repo.pool, business);
  const on = query.on ? common.readDate(query.on, 'Date') : today;
  if (on > today) fail('The board is for today or a day gone by');
  const rows = await repo.all(repo.pool, `WITH bounds AS (SELECT ($2::date::timestamp AT TIME ZONE timezone) AS starts,(($2::date + 1)::timestamp AT TIME ZONE timezone) AS ends
      FROM businesses WHERE id=$1),
    moved AS (SELECT l.sku_id,COALESCE(sum(m.quantity),0) AS since_start,COALESCE(sum(m.quantity) FILTER (WHERE m.created_at >= bounds.ends),0) AS since_end
      FROM business_stock_movements m JOIN business_stock_lots l ON l.business_id=m.business_id AND l.id=m.lot_id CROSS JOIN bounds
      WHERE m.business_id=$1 AND l.location_id=$3 AND m.created_at >= bounds.starts GROUP BY l.sku_id),
    stock AS (SELECT sku_id,sum(quantity) AS now FROM business_stock_lots WHERE business_id=$1 AND location_id=$3 GROUP BY sku_id)
    SELECT s.id,s.label,s.code,s.unit,u.name AS unit_name,s.attributes->>'inputKind' AS input_kind,(s.attributes->>'subsidised')='yes' AS subsidised,
      s.attributes->>'seedClass' AS seed_class,s.attributes->>'seedCrop' AS seed_crop,s.attributes->>'seedVariety' AS seed_variety,
      COALESCE(lp.price,s.price) AS price,s.mrp,
      COALESCE(st.now,0)-COALESCE(mv.since_start,0) AS opening,COALESCE(st.now,0)-COALESCE(mv.since_end,0) AS closing
    FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    LEFT JOIN business_sku_location_prices lp ON lp.business_id=s.business_id AND lp.location_id=$3 AND lp.sku_id=s.id
    LEFT JOIN stock st ON st.sku_id=s.id LEFT JOIN moved mv ON mv.sku_id=s.id
    WHERE s.business_id=$1 AND s.attributes->>'inputKind' IN ('fertiliser','seed') AND (s.active OR COALESCE(st.now,0)<>0 OR mv.sku_id IS NOT NULL)
    ORDER BY (s.attributes->>'inputKind')='seed',s.label`, [business.id, on, location.id]);
  const settings = await repo.one(repo.pool, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  return { location, on, today, closed: on < today, taxMode: settings?.tax_mode || 'exclusive', rows };
}

// The weight of one stock unit in kg, where known: a unit of weight, or a
// count unit with the item's weight of one (agri › netKg). null: unknown.
const KG_PER_UNIT = `CASE WHEN u.kind='weight' THEN CASE WHEN u.base_unit_code IS NULL THEN 1 ELSE u.factor_to_base END
  WHEN u.kind='count' AND (s.attributes->>'netKg') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (s.attributes->>'netKg')::numeric END`;
const quintals = (column) => `CASE WHEN x.kg_per_unit IS NULL THEN NULL ELSE round(${column} * x.kg_per_unit / 100, 4) END`;

// query: { locationId, month: YYYY-MM } — a month that has begun.
async function seedReturn(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = await locationOf(business, query.locationId ?? query.location);
  const month = String(query.month ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Month must look like 2026-10');
  const first = `${month}-01`;
  const today = await common.today(repo.pool, business);
  if (first > today) fail('The return is for this month or one gone by');
  const next = common.addDays(`${month}-28`, 4).slice(0, 7);
  const rows = await repo.all(repo.pool, `WITH bounds AS (SELECT ($2::date::timestamp AT TIME ZONE timezone) AS starts,($3::date::timestamp AT TIME ZONE timezone) AS ends
      FROM businesses WHERE id=$1),
    moved AS (SELECT l.sku_id,COALESCE(sum(m.quantity),0) AS since_start,COALESCE(sum(m.quantity) FILTER (WHERE m.created_at >= bounds.ends),0) AS since_end,
        COALESCE(sum(m.quantity) FILTER (WHERE m.created_at < bounds.ends AND d.kind='purchase'),0) AS purchased,
        COALESCE(-sum(m.quantity) FILTER (WHERE m.created_at < bounds.ends AND d.kind='sale'),0) AS sold,
        COALESCE(sum(m.quantity) FILTER (WHERE m.created_at < bounds.ends AND m.document_id IS NULL),0) AS other
      FROM business_stock_movements m JOIN business_stock_lots l ON l.business_id=m.business_id AND l.id=m.lot_id CROSS JOIN bounds
      LEFT JOIN business_documents d ON d.business_id=m.business_id AND d.id=m.document_id
      WHERE m.business_id=$1 AND l.location_id=$4 AND m.created_at >= bounds.starts GROUP BY l.sku_id),
    stock AS (SELECT sku_id,sum(quantity) AS now FROM business_stock_lots WHERE business_id=$1 AND location_id=$4 GROUP BY sku_id),
    x AS (SELECT s.id,s.label,s.code,s.unit,u.name AS unit_name,s.attributes->>'seedCrop' AS crop,s.attributes->>'seedVariety' AS variety,
        s.attributes->>'seedClass' AS seed_class,${KG_PER_UNIT} AS kg_per_unit,
        COALESCE(st.now,0)-COALESCE(mv.since_start,0) AS opening,COALESCE(mv.purchased,0) AS purchased,COALESCE(mv.sold,0) AS sold,
        COALESCE(mv.other,0) AS other,COALESCE(st.now,0)-COALESCE(mv.since_end,0) AS closing
      FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      LEFT JOIN stock st ON st.sku_id=s.id LEFT JOIN moved mv ON mv.sku_id=s.id
      WHERE s.business_id=$1 AND s.attributes->>'inputKind'='seed' AND (s.active OR COALESCE(st.now,0)<>0 OR mv.sku_id IS NOT NULL))
    SELECT x.*,${quintals('x.opening')} AS opening_q,${quintals('x.purchased')} AS purchased_q,${quintals('x.sold')} AS sold_q,
      ${quintals('x.other')} AS other_q,${quintals('x.closing')} AS closing_q
    FROM x ORDER BY x.crop NULLS LAST,x.variety NULLS LAST,x.label`, [business.id, first, `${next}-01`, location.id]);
  return { location, month, dueOn: `${next}-05`, closed: `${next}-01` <= today, rows };
}

// query: { locationId? (every location), from, to } (up to 367 days).
async function insecticideRegister(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = query.locationId || query.location ? await locationOf(business, query.locationId ?? query.location) : null;
  const from = common.readDate(query.from, 'From date'), to = common.readDate(query.to, 'To date');
  if (to < from) fail('The end date is before the start date');
  if (common.daysBetween(from, to) > 366) fail('Choose up to 367 days');
  const rows = await repo.all(repo.pool, `SELECT d.created_at,(d.created_at AT TIME ZONE $5)::date::text AS day,d.id AS document_id,d.document_no,loc.name AS location_name,
      COALESCE(d.contact_name,ab.buyer_name) AS farmer,COALESCE(f.village,ab.village) AS village,f.relative_name,
      dl.id AS line_id,dl.label AS product,dl.lot_code AS batch,COALESCE(s.attributes->>'manufacturer',p.brand) AS manufacturer,
      dl.quantity,dl.unit,lot.expires_on,a.crop,a.molecules,
      COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=a.business_id AND rl.line_id=a.line_id),0) AS returned
    FROM agri_sale_lines a JOIN business_documents d ON d.business_id=a.business_id AND d.id=a.document_id
    JOIN business_document_lines dl ON dl.business_id=a.business_id AND dl.id=a.line_id
    JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_locations loc ON loc.business_id=d.business_id AND loc.id=d.location_id
    LEFT JOIN agri_bills ab ON ab.business_id=d.business_id AND ab.document_id=d.id
    LEFT JOIN agri_farmers f ON f.business_id=d.business_id AND f.contact_id=d.contact_id
    LEFT JOIN business_stock_lots lot ON lot.business_id=dl.business_id AND lot.location_id=d.location_id AND lot.sku_id=dl.sku_id AND lot.lot_code=dl.lot_code
    WHERE a.business_id=$1 AND a.input_kind='pesticide' AND ($2::bigint IS NULL OR d.location_id=$2)
      AND (d.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
    ORDER BY d.created_at,dl.id`, [business.id, location?.id || null, from, to, business.timezone]);
  return { location, from, to, rows };
}

module.exports = { board, seedReturn, insecticideRegister };
