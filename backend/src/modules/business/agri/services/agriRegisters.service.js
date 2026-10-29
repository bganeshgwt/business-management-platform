const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// The statutory outputs of a farm-input shop, each worked out from its bills,
// receipts and stock movements (nothing is typed twice):
//   board               the daily stock and price board of one location: the
//                       opening stock of each fertiliser and seed on a day
//                       (its closing stock too, for a day gone by) and its
//                       price and MRP that day (business_price_history keeps
//                       every price an item and a branch had), to print for display
//   seed return         the seed stock return of a month (Form D): for each
//                       seed, the stock on the first, what was bought and sold
//                       (net of goods returned), other changes and the closing
//                       stock, in quintals where its weight is known; due by the 5th
//   insecticide register  every pesticide sold: date, bill, farmer, product,
//                       batch, manufacturer, quantity, expiry and crop
//   Form XIII           insecticides sold to dealers (a buyer with a GSTIN) and
//                       bulk consumers (tagged), insecticide by insecticide
//                       (Insecticides Rules 1971, rule 15(2))
//   Form XIV            the monthly return of insecticides at a location: each
//                       one's opening stock, receipts, sales (those to dealers
//                       and bulk consumers apart), other changes and closing
//                       stock; due within 15 days of the month's end
//   sulphur buyers      every sale of sulphur with its buyer's name, address
//                       and quantity (rule 10B)
// A return is marked as sent (agri_returns_filed); the bell reminds until it is.
// Stock on a day is the stock now less every movement since that day began
// (business_stock_movements, on the business's own clock).

const { fail, requireAgri } = common;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const FORMS = { form_xiv: { name: 'Form XIV', dueDay: 15 }, form_d: { name: 'Form D', dueDay: 5 } };

async function locationOf(business, value) {
  const locationId = id(value, 'Location');
  access.requireLocation(business, locationId);
  const location = await repo.one(repo.pool, 'SELECT id,name,code FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId]);
  if (!location) fail('Location not found', 404);
  return location;
}
// A month as typed (YYYY-MM) that has begun: its first day and the next month's.
async function monthOf(business, value, what) {
  const month = String(value ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Month must look like 2026-10');
  const first = `${month}-01`;
  const today = await common.today(repo.pool, business);
  if (first > today) fail(`The ${what} is for this month or one gone by`);
  return { month, first, next: common.addDays(`${month}-28`, 4).slice(0, 7), today };
}
// A period of dates (up to 367 days).
function periodOf(query) {
  const from = common.readDate(query.from, 'From date'), to = common.readDate(query.to, 'To date');
  if (to < from) fail('The end date is before the start date');
  if (common.daysBetween(from, to) > 366) fail('Choose up to 367 days');
  return { from, to };
}
const filedOf = async (business, form, locationId, first) => (await repo.one(repo.pool, `SELECT f.filed_on,f.reference,f.notes,f.created_at,u.name AS created_by_name FROM agri_returns_filed f
  JOIN users u ON u.id=f.created_by WHERE f.business_id=$1 AND f.form=$2 AND f.location_id=$3 AND f.month_start=$4::date`, [business.id, form, locationId, first])) || null;

// query: { locationId, on? (today) } — no day after today. A day gone by
// shows that day's prices (as they stood at its end, and at its start where
// they changed during it); today shows the prices now.
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
      CASE WHEN $4 THEN COALESCE(lp.price,s.price) ELSE COALESCE(be.price,ie.price,fi.price,s.price) END AS price,
      CASE WHEN $4 THEN s.mrp WHEN ie.price IS NOT NULL THEN ie.mrp ELSE COALESCE(fi.mrp,s.mrp) END AS mrp,
      COALESCE(bs.price,isp.price,fi.price,s.price) AS opening_price,
      COALESCE(st.now,0)-COALESCE(mv.since_start,0) AS opening,COALESCE(st.now,0)-COALESCE(mv.since_end,0) AS closing
    FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit CROSS JOIN bounds
    LEFT JOIN business_sku_location_prices lp ON lp.business_id=s.business_id AND lp.location_id=$3 AND lp.sku_id=s.id
    LEFT JOIN LATERAL (SELECT h.price,h.mrp FROM business_price_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id AND h.location_id IS NULL
      AND h.changed_at < bounds.ends ORDER BY h.changed_at DESC,h.id DESC LIMIT 1) ie ON TRUE
    LEFT JOIN LATERAL (SELECT h.price FROM business_price_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id AND h.location_id=$3
      AND h.changed_at < bounds.ends ORDER BY h.changed_at DESC,h.id DESC LIMIT 1) be ON TRUE
    LEFT JOIN LATERAL (SELECT h.price FROM business_price_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id AND h.location_id IS NULL
      AND h.changed_at < bounds.starts ORDER BY h.changed_at DESC,h.id DESC LIMIT 1) isp ON TRUE
    LEFT JOIN LATERAL (SELECT h.price FROM business_price_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id AND h.location_id=$3
      AND h.changed_at < bounds.starts ORDER BY h.changed_at DESC,h.id DESC LIMIT 1) bs ON TRUE
    LEFT JOIN LATERAL (SELECT h.price,h.mrp FROM business_price_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id AND h.location_id IS NULL
      ORDER BY h.changed_at,h.id LIMIT 1) fi ON TRUE
    LEFT JOIN stock st ON st.sku_id=s.id LEFT JOIN moved mv ON mv.sku_id=s.id
    WHERE s.business_id=$1 AND s.attributes->>'inputKind' IN ('fertiliser','seed') AND (s.active OR COALESCE(st.now,0)<>0 OR mv.sku_id IS NOT NULL)
    ORDER BY (s.attributes->>'inputKind')='seed',s.label`, [business.id, on, location.id, on === today]);
  const settings = await repo.one(repo.pool, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  // A price that changed during the day shows what it opened at too.
  const shown = rows.map((r) => ({ ...r, price_changed: Number(r.opening_price) !== Number(r.price) }));
  return { location, on, today, closed: on < today, taxMode: settings?.tax_mode || 'exclusive', rows: shown };
}

// The weight of one stock unit in kg, where known: a unit of weight, or a
// count unit with the item's weight of one (agri › netKg). null: unknown.
const KG_PER_UNIT = `CASE WHEN u.kind='weight' THEN CASE WHEN u.base_unit_code IS NULL THEN 1 ELSE u.factor_to_base END
  WHEN u.kind='count' AND (s.attributes->>'netKg') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (s.attributes->>'netKg')::numeric END`;
const quintals = (column) => `CASE WHEN x.kg_per_unit IS NULL THEN NULL ELSE round(${column} * x.kg_per_unit / 100, 4) END`;

// A month's movement of each item of a kind at a location: the stock on the
// first, what was bought and sold (net of goods returned), other changes
// (corrections, counts, stock kept apart, transfers) and the closing stock.
// extra: more columns from the items (the seed return's quintals).
const monthSql = (kind, extra = '') => `WITH bounds AS (SELECT ($2::date::timestamp AT TIME ZONE timezone) AS starts,($3::date::timestamp AT TIME ZONE timezone) AS ends
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
        s.attributes->>'seedClass' AS seed_class,s.attributes->'molecules' AS molecules,s.attributes->>'formulation' AS formulation,${KG_PER_UNIT} AS kg_per_unit,
        COALESCE(st.now,0)-COALESCE(mv.since_start,0) AS opening,COALESCE(mv.purchased,0) AS purchased,COALESCE(mv.sold,0) AS sold,
        COALESCE(mv.other,0) AS other,COALESCE(st.now,0)-COALESCE(mv.since_end,0) AS closing
      FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      LEFT JOIN stock st ON st.sku_id=s.id LEFT JOIN moved mv ON mv.sku_id=s.id
      WHERE s.business_id=$1 AND s.attributes->>'inputKind'='${kind}' AND (s.active OR COALESCE(st.now,0)<>0 OR mv.sku_id IS NOT NULL))
    SELECT x.*${extra} FROM x`;

// query: { locationId, month: YYYY-MM } — a month that has begun.
async function seedReturn(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = await locationOf(business, query.locationId ?? query.location);
  const { month, first, next, today } = await monthOf(business, query.month, 'return');
  const rows = await repo.all(repo.pool, `${monthSql('seed', `,${quintals('x.opening')} AS opening_q,${quintals('x.purchased')} AS purchased_q,${quintals('x.sold')} AS sold_q,
      ${quintals('x.other')} AS other_q,${quintals('x.closing')} AS closing_q`)} ORDER BY x.crop NULLS LAST,x.variety NULLS LAST,x.label`, [business.id, first, `${next}-01`, location.id]);
  return { location, month, dueOn: `${next}-05`, closed: `${next}-01` <= today, filed: await filedOf(business, 'form_d', location.id, first), rows };
}

// query: { locationId, month: YYYY-MM } — the monthly Form XIV return of the
// location's insecticides, with what went to dealers and bulk consumers (Form XIII).
async function formXiv(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = await locationOf(business, query.locationId ?? query.location);
  const { month, first, next, today } = await monthOf(business, query.month, 'return');
  const rows = await repo.all(repo.pool, `${monthSql('pesticide', `,COALESCE((SELECT sum(dl.quantity-COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl
        WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id),0)) FROM agri_sale_lines a JOIN business_document_lines dl ON dl.business_id=a.business_id AND dl.id=a.line_id
      JOIN business_documents d ON d.business_id=a.business_id AND d.id=a.document_id LEFT JOIN agri_bills ab ON ab.business_id=d.business_id AND ab.document_id=d.id CROSS JOIN bounds
      WHERE a.business_id=$1 AND a.sku_id=x.id AND d.location_id=$4 AND d.created_at >= bounds.starts AND d.created_at < bounds.ends
        AND (d.buyer_gstin IS NOT NULL OR 'bulk_consumer'=ANY(COALESCE(ab.buyer_tags,'{}')))),0) AS to_trade`)} ORDER BY x.label`,
  [business.id, first, `${next}-01`, location.id]);
  return { location, month, dueOn: `${next}-${String(FORMS.form_xiv.dueDay).padStart(2, '0')}`, closed: `${next}-01` <= today,
    filed: await filedOf(business, 'form_xiv', location.id, first), rows: rows.map((r) => ({ ...r, molecules: Array.isArray(r.molecules) ? r.molecules : [] })) };
}

// query: { locationId? (every location), from, to } (up to 367 days).
async function insecticideRegister(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = query.locationId || query.location ? await locationOf(business, query.locationId ?? query.location) : null;
  const { from, to } = periodOf(query);
  const rows = await repo.all(repo.pool, `SELECT d.created_at,(d.created_at AT TIME ZONE $5)::date::text AS day,d.id AS document_id,d.document_no,loc.name AS location_name,
      COALESCE(d.contact_name,ab.buyer_name) AS farmer,COALESCE(f.village,ab.village) AS village,f.relative_name,
      dl.id AS line_id,dl.label AS product,dl.lot_code AS batch,COALESCE(s.attributes->>'manufacturer',p.brand) AS manufacturer,
      dl.quantity,dl.unit,lot.expires_on,a.crop,a.molecules,a.off_label,a.restricted_by,
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

// query: { locationId?, from, to } — Form XIII: insecticides sold to dealers
// (a B2B invoice to a GSTIN) and to bulk consumers (tagged when billed),
// insecticide by insecticide, with each buyer's GSTIN or tag reference and address.
async function formXiii(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = query.locationId || query.location ? await locationOf(business, query.locationId ?? query.location) : null;
  const { from, to } = periodOf(query);
  const rows = await repo.all(repo.pool, `SELECT (d.created_at AT TIME ZONE $5)::date::text AS day,d.id AS document_id,d.document_no,loc.name AS location_name,
      COALESCE(d.contact_name,ab.buyer_name) AS buyer,d.buyer_gstin,COALESCE(NULLIF(d.buyer_address,''),c.address) AS address,
      CASE WHEN d.buyer_gstin IS NOT NULL THEN 'dealer' ELSE 'bulk_consumer' END AS buyer_kind,
      (SELECT t.reference FROM agri_buyer_tags t WHERE t.business_id=d.business_id AND t.contact_id=d.contact_id AND t.tag='bulk_consumer') AS reference,
      dl.id AS line_id,dl.sku_id,dl.label AS insecticide,a.molecules,dl.lot_code AS batch,COALESCE(s.attributes->>'manufacturer',p.brand) AS manufacturer,
      dl.quantity,dl.unit,COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=a.business_id AND rl.line_id=a.line_id),0) AS returned
    FROM agri_sale_lines a JOIN business_documents d ON d.business_id=a.business_id AND d.id=a.document_id
    JOIN business_document_lines dl ON dl.business_id=a.business_id AND dl.id=a.line_id
    JOIN catalog_skus s ON s.business_id=dl.business_id AND s.id=dl.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_locations loc ON loc.business_id=d.business_id AND loc.id=d.location_id
    LEFT JOIN business_contacts c ON c.business_id=d.business_id AND c.id=d.contact_id
    LEFT JOIN agri_bills ab ON ab.business_id=d.business_id AND ab.document_id=d.id
    WHERE a.business_id=$1 AND a.input_kind='pesticide' AND ($2::bigint IS NULL OR d.location_id=$2)
      AND (d.buyer_gstin IS NOT NULL OR 'bulk_consumer'=ANY(COALESCE(ab.buyer_tags,'{}')))
      AND (d.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
    ORDER BY dl.label,d.created_at,dl.id`, [business.id, location?.id || null, from, to, business.timezone]);
  return { location, from, to, rows };
}

// query: { locationId?, from, to } — the sulphur buyers' register: every sale of
// an item made of sulphur, with the buyer's name, address and quantity.
async function sulphurRegister(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = query.locationId || query.location ? await locationOf(business, query.locationId ?? query.location) : null;
  const { from, to } = periodOf(query);
  const rows = await repo.all(repo.pool, `SELECT (d.created_at AT TIME ZONE $5)::date::text AS day,d.id AS document_id,d.document_no,loc.name AS location_name,
      COALESCE(d.contact_name,ab.buyer_name) AS buyer,COALESCE(NULLIF(d.buyer_address,''),c.address,f.village,ab.village) AS address,
      dl.id AS line_id,dl.label AS product,dl.quantity,dl.unit,
      COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=a.business_id AND rl.line_id=a.line_id),0) AS returned
    FROM agri_sale_lines a JOIN business_documents d ON d.business_id=a.business_id AND d.id=a.document_id
    JOIN business_document_lines dl ON dl.business_id=a.business_id AND dl.id=a.line_id
    JOIN business_locations loc ON loc.business_id=d.business_id AND loc.id=d.location_id
    LEFT JOIN business_contacts c ON c.business_id=d.business_id AND c.id=d.contact_id
    LEFT JOIN agri_farmers f ON f.business_id=d.business_id AND f.contact_id=d.contact_id
    LEFT JOIN agri_bills ab ON ab.business_id=d.business_id AND ab.document_id=d.id
    WHERE a.business_id=$1 AND EXISTS (SELECT 1 FROM unnest(a.molecules) m WHERE lower(btrim(m)) = ANY($6::text[]))
      AND ($2::bigint IS NULL OR d.location_id=$2) AND (d.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
    ORDER BY d.created_at,dl.id`, [business.id, location?.id || null, from, to, business.timezone, common.SULPHUR]);
  return { location, from, to, rows };
}

// body: { form: form_xiv | form_d, locationId, month: YYYY-MM, filedOn, reference?, notes? } — a
// month's return marked as sent to the licensing authority, once.
async function markFiled(business, user, body) {
  requireAgri(business);
  await access.require(business, 'agri.edit');
  const form = v.requiredEnum(body.form, 'Return', Object.keys(FORMS));
  const location = await locationOf(business, body.locationId);
  const { month, first, next, today } = await monthOf(business, body.month, 'return');
  if (`${next}-01` > today) fail(`The ${FORMS[form].name} return for ${month} is sent once the month is over`);
  const filedOn = common.readDate(body.filedOn, 'Sent on');
  if (filedOn > today || filedOn < `${next}-01`) fail('It is sent after the month is over, and today or earlier');
  const reference = v.optionalString(body.reference, 'Reference or acknowledgement', 80);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  await repo.transaction(async (db) => {
    const done = await repo.one(db, 'SELECT filed_on FROM agri_returns_filed WHERE business_id=$1 AND form=$2 AND location_id=$3 AND month_start=$4::date',
      [business.id, form, location.id, first]);
    if (done) fail(`The ${FORMS[form].name} return of ${location.name} for ${month} was marked sent on ${common.dateWords(done.filed_on)}`, 409);
    await db.query('INSERT INTO agri_returns_filed(business_id,form,location_id,month_start,filed_on,reference,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [business.id, form, location.id, first, filedOn, reference, notes, user.id]);
    await repo.audit(db, business.id, user.id, 'agri.return_filed', location.id, { form, location: location.name, month, filedOn, reference });
  });
  return { form, location, month, filed: await filedOf(business, form, location.id, first) };
}

module.exports = { board, seedReturn, formXiv, insecticideRegister, formXiii, sulphurRegister, markFiled, FORMS };
