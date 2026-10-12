const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const { requireVariants } = require('./businessFashion.service');

// Fashion, pro pass (builder E, 7 Oct 2026):
//   barcodes    the maker's EAN typed on one variant, or pasted for a style (E-07);
//   markdowns   end-of-season % off a whole style, with an end date: a
//               'product_percent' offer of the Offers module, so the shelf
//               price is never rewritten and it ends (reverts) by itself (E-04);
//   GST slab    apparel at 5 % up to ₹2,500 a piece and 18 % above, decided
//               on each sale line after discounts (E-12);
//   reports     per style: the size curve, broken size runs, stock ageing (E-09).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const money = (p) => (p / 100).toFixed(2);

// --- Barcodes ---------------------------------------------------------------------------

function readBarcode(value) {
  const text = v.requiredString(String(value ?? ''), 'Barcode', 80).trim();
  if (!/^[0-9A-Za-z-]{4,80}$/.test(text)) fail(`Barcode ${text.slice(0, 20)} may only hold letters, digits and hyphens (4 or more)`);
  return text;
}

// { skuId: barcode, … } for variants of one product (or one variant), all or nothing.
async function setBarcodes(business, user, productId, body) {
  await access.require(business, 'catalog.edit');
  requireVariants(business);
  const input = body?.barcodes;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Send barcodes as { variant: barcode }');
  const entries = Object.entries(input).filter(([, code]) => code !== '' && code !== null && code !== undefined)
    .map(([skuId, code]) => [id(skuId, 'Variant'), readBarcode(code)]);
  if (!entries.length) fail('Type at least one barcode');
  if (entries.length > 300) fail('At most 300 barcodes at a time');
  const codes = entries.map(([, code]) => code);
  if (new Set(codes).size !== codes.length) fail('The same barcode was typed for two variants');
  return repo.transaction(async (db) => {
    const variants = await repo.all(db, `SELECT s.id,s.label,s.barcode FROM fashion_variants v JOIN catalog_skus s ON s.business_id=v.business_id AND s.id=v.sku_id
      WHERE v.business_id=$1 AND v.product_id=$2 AND s.id=ANY($3::bigint[]) FOR UPDATE OF s`, [business.id, id(productId, 'Product'), entries.map(([skuId]) => skuId)]);
    if (variants.length !== entries.length) fail('A variant is not part of this product', 404);
    const clash = await repo.one(db, 'SELECT barcode,label FROM catalog_skus WHERE business_id=$1 AND barcode=ANY($2::text[]) AND NOT (id=ANY($3::bigint[])) LIMIT 1',
      [business.id, codes, entries.map(([skuId]) => skuId)]);
    if (clash) fail(`Barcode ${clash.barcode} is already on ${clash.label}`, 409);
    // Two steps so swapping codes between two variants never trips the unique index.
    await db.query('UPDATE catalog_skus SET barcode=NULL WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, entries.map(([skuId]) => skuId)]);
    for (const [skuId, code] of entries) await db.query('UPDATE catalog_skus SET barcode=$3 WHERE business_id=$1 AND id=$2', [business.id, skuId, code]);
    await repo.audit(db, business.id, user.id, 'catalog.barcodes_set', id(productId, 'Product'),
      { changes: entries.map(([skuId, code]) => ({ skuId, from: variants.find((x) => Number(x.id) === skuId)?.barcode || null, to: code })) });
    return { updated: entries.length };
  });
}

// --- Markdowns ----------------------------------------------------------------------------

const markdownSql = `SELECT o.id,o.name,o.product_id,o.value,o.starts_on::text,o.ends_on::text,o.active,p.name AS product_name,
    CASE WHEN NOT o.active THEN 'off' WHEN o.starts_on > (now() AT TIME ZONE b.timezone)::date THEN 'scheduled'
      WHEN o.ends_on IS NOT NULL AND o.ends_on < (now() AT TIME ZONE b.timezone)::date THEN 'ended' ELSE 'running' END AS status,
    COALESCE((SELECT sum(x.amount) FROM retail_sale_discounts x WHERE x.business_id=o.business_id AND x.offer_id=o.id),0) AS given
  FROM retail_offers o JOIN businesses b ON b.id=o.business_id
  JOIN catalog_products p ON p.business_id=o.business_id AND p.id=o.product_id
  WHERE o.business_id=$1 AND o.kind='product_percent'`;

function requireOffers(business) {
  if (!business.modules.includes('offers')) fail('Offers & discounts is not switched on for this business. An owner can turn it on in Settings › Modules.', 403);
}

// % off each chosen style until a date; one offer per style.
async function createMarkdowns(business, user, body) {
  await access.require(business, 'offers.create');
  requireVariants(business);
  requireOffers(business);
  const productIds = [...new Set(v.requiredArray(body.productIds, 'Styles').map((x) => id(x, 'Style')))];
  if (!productIds.length || productIds.length > 100) fail('Choose between 1 and 100 styles');
  const percent = core.decimal(body.percent, 'Markdown %', 2, 1, 90);
  const today = await repo.one(repo.pool, 'SELECT ((now() AT TIME ZONE $1)::date)::text AS day', [business.timezone]);
  const startsOn = body.startsOn ? core.dateText(body.startsOn, 'Start date') : today.day;
  const endsOn = core.dateText(body.endsOn, 'End date');
  if (endsOn < startsOn) fail('The markdown ends before it starts');
  if (endsOn < today.day) fail('The end date has already passed');
  const label = v.optionalString(body.name, 'Name', 80) || 'End of season';
  return repo.transaction(async (db) => {
    const products = await repo.all(db, `SELECT p.id,p.name FROM catalog_products p WHERE p.business_id=$1 AND p.id=ANY($2::bigint[])
      AND EXISTS (SELECT 1 FROM fashion_variants v WHERE v.business_id=p.business_id AND v.product_id=p.id)`, [business.id, productIds]);
    if (products.length !== productIds.length) fail('A chosen style was not found', 404);
    // A style already marked down over these dates keeps one markdown: end the old one first.
    const overlap = await repo.one(db, `SELECT p.name FROM retail_offers o JOIN catalog_products p ON p.business_id=o.business_id AND p.id=o.product_id
      WHERE o.business_id=$1 AND o.kind='product_percent' AND o.active AND o.product_id=ANY($2::bigint[])
        AND o.starts_on <= $4::date AND (o.ends_on IS NULL OR o.ends_on >= $3::date) LIMIT 1`, [business.id, productIds, startsOn, endsOn]);
    if (overlap) fail(`${overlap.name} already has a markdown on those dates. End it first, then mark it down again.`, 409);
    const created = [];
    for (const product of products) {
      const row = await repo.one(db, `INSERT INTO retail_offers(business_id,name,kind,product_id,value,starts_on,ends_on,active,created_by,updated_by)
        VALUES($1,$2,'product_percent',$3,$4,$5,$6,TRUE,$7,$7) RETURNING *`,
      [business.id, `${label}: ${product.name} ${percent}% off`.slice(0, 120), product.id, percent.toFixed(2), startsOn, endsOn, user.id]);
      await repo.audit(db, business.id, user.id, 'offer.created', row.id, { name: row.name, kind: row.kind, value: row.value, productId: product.id, endsOn });
      created.push(row);
    }
    return { created: created.length, offers: created };
  });
}

// Ends a markdown today (the shelf price was never changed: nothing to put back).
async function endMarkdown(business, user, offerId) {
  await access.require(business, 'offers.edit');
  requireOffers(business);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `UPDATE retail_offers SET active=FALSE,updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2 AND kind='product_percent' RETURNING *`,
      [business.id, id(offerId, 'Markdown'), user.id]);
    if (!row) fail('Markdown not found', 404);
    await repo.audit(db, business.id, user.id, 'offer.updated', row.id, { name: row.name, active: false, markdownEnded: true });
    return row;
  });
}

async function markdowns(business, query = {}) {
  await access.require(business, 'offers.view');
  requireOffers(business);
  const productId = query.productId ? id(query.productId, 'Style') : null;
  return repo.all(repo.pool, `${markdownSql} AND ($2::bigint IS NULL OR o.product_id=$2) ORDER BY (o.active AND (o.ends_on IS NULL OR o.ends_on >= (now() AT TIME ZONE b.timezone)::date)) DESC,o.id DESC LIMIT 200`,
    [business.id, productId]);
}

// --- Apparel GST by price ------------------------------------------------------------------

async function gstRule(business) {
  await access.require(business, 'catalog.view');
  const row = await repo.one(repo.pool, 'SELECT * FROM fashion_gst_price_slabs WHERE business_id=$1', [business.id]);
  return row || { business_id: business.id, active: false, threshold: '2500.00', rate_low: '5.00', rate_high: '18.00', category_ids: [], updated_at: null };
}
async function saveGstRule(business, user, body) {
  await access.require(business, 'settings.edit');
  const active = v.requiredBoolean(body.active, 'On', true);
  const threshold = core.decimal(body.threshold ?? 2500, 'Price per piece', 2, 1, 10000000);
  const low = core.decimal(body.rateLow ?? 5, 'Lower GST rate', 2, 0, 100);
  const high = core.decimal(body.rateHigh ?? 18, 'Higher GST rate', 2, 0, 100);
  if (high < low) fail('The higher rate must be at least the lower rate');
  const categories = body.categoryIds === undefined || body.categoryIds === null ? [] : [...new Set(v.requiredArray(body.categoryIds, 'Categories').map((x) => id(x, 'Category')))];
  return repo.transaction(async (db) => {
    if (categories.length) {
      const found = await repo.one(db, 'SELECT count(*)::int AS n FROM catalog_categories WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, categories]);
      if (found.n !== categories.length) fail('A category was not found', 404);
    }
    const row = await repo.one(db, `INSERT INTO fashion_gst_price_slabs(business_id,active,threshold,rate_low,rate_high,category_ids,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(business_id) DO UPDATE SET active=EXCLUDED.active,threshold=EXCLUDED.threshold,rate_low=EXCLUDED.rate_low,
      rate_high=EXCLUDED.rate_high,category_ids=EXCLUDED.category_ids,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, active, threshold.toFixed(2), low.toFixed(2), high.toFixed(2), categories, user.id]);
    await repo.audit(db, business.id, user.id, 'settings.gst_price_slab_saved', null, { active, threshold, low, high, categories });
    return row;
  });
}

// Inside the sale's posting (business.service.js › postDocument), after offers
// and before GST: each line of a size × colour variant (or of a chosen
// category) that is sold by the piece takes the lower rate when its value per
// piece, after discounts and before GST, is at most the threshold; otherwise
// the higher rate. With prices including GST the piece's value is tested at
// the lower rate (₹2,625 incl. 5 % = ₹2,500: lower rate; ₹2,626: higher).
async function applyPriceSlabs(db, business, lines, perLine, taxMode) {
  const rule = await repo.one(db, 'SELECT * FROM fashion_gst_price_slabs WHERE business_id=$1 AND active', [business.id]);
  if (!rule) return;
  const skuIds = [...new Set(lines.filter((l) => !l.preset).map((l) => Number(l.sku.id)))];
  if (!skuIds.length) return;
  const eligible = new Set((await repo.all(db, `WITH RECURSIVE up AS (
      SELECT s.id AS sku_id,p.category_id,1 AS depth FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=ANY($2::bigint[]) AND p.category_id IS NOT NULL
      UNION ALL SELECT up.sku_id,c.parent_id,up.depth+1 FROM up JOIN catalog_categories c ON c.business_id=$1 AND c.id=up.category_id
      WHERE c.parent_id IS NOT NULL AND up.depth<6)
    SELECT sku_id FROM up WHERE category_id=ANY($3::bigint[])
    UNION SELECT sku_id FROM fashion_variants WHERE business_id=$1 AND sku_id=ANY($2::bigint[])`, [business.id, skuIds, rule.category_ids])).map((r) => Number(r.sku_id)));
  const low = Number(rule.rate_low), high = Number(rule.rate_high), limit = paise(rule.threshold);
  lines.forEach((line, index) => {
    if (line.preset || !eligible.has(Number(line.sku.id)) || Number(line.sku.unit_decimals) !== 0) return;
    const amount = line.amount - (perLine?.[index] || 0);
    const pieces = Number(line.quantity);
    if (!(pieces > 0)) return;
    const each = amount / pieces;
    const value = taxMode === 'inclusive' ? each / (1 + low / 100) : each;
    const rate = Math.round(value) <= limit ? low : high;
    line.sku = { ...line.sku, tax_rate: rate.toFixed(2) };
  });
}

// --- Reports: by style, broken sizes, ageing -------------------------------------------------

const AGE_BUCKETS = [[0, 30], [31, 60], [61, 90], [91, null]];

// Stock on hand split by how long ago it arrived, newest receipts first
// (what is left on the shelf is assumed to be the latest to come in).
async function ageing(db, business, { productId, locationId }) {
  return repo.all(db, `WITH stock AS (
      SELECT l.sku_id,sum(l.quantity) AS qty,sum(l.quantity*l.unit_cost) AS value FROM business_stock_lots l
      JOIN fashion_variants v ON v.business_id=l.business_id AND v.sku_id=l.sku_id
      WHERE l.business_id=$1 AND ($2::bigint IS NULL OR v.product_id=$2) AND ($3::bigint IS NULL OR l.location_id=$3) GROUP BY l.sku_id HAVING sum(l.quantity)>0),
    recv AS (
      SELECT l.sku_id,mv.quantity,((now() AT TIME ZONE $4)::date - (mv.created_at AT TIME ZONE $4)::date) AS age,
        sum(mv.quantity) OVER (PARTITION BY l.sku_id ORDER BY mv.id DESC) AS running
      FROM business_stock_movements mv JOIN business_stock_lots l ON l.business_id=mv.business_id AND l.id=mv.lot_id
      JOIN business_documents d ON d.business_id=mv.business_id AND d.id=mv.document_id AND d.kind='purchase'
      WHERE mv.business_id=$1 AND mv.quantity>0 AND mv.return_id IS NULL AND l.sku_id IN (SELECT sku_id FROM stock) AND ($3::bigint IS NULL OR l.location_id=$3)),
    parts AS (
      SELECT r.sku_id,r.age,GREATEST(0,LEAST(r.quantity,s.qty-(r.running-r.quantity))) AS qty FROM recv r JOIN stock s ON s.sku_id=r.sku_id)
    SELECT s.sku_id,s.qty AS stock_qty,s.value AS stock_value,
      COALESCE(sum(p.qty) FILTER (WHERE p.age<=30),0) AS d0_30,
      COALESCE(sum(p.qty) FILTER (WHERE p.age BETWEEN 31 AND 60),0) AS d31_60,
      COALESCE(sum(p.qty) FILTER (WHERE p.age BETWEEN 61 AND 90),0) AS d61_90,
      s.qty - COALESCE(sum(p.qty) FILTER (WHERE p.age<=90),0) AS d91_plus,
      max(p.age) FILTER (WHERE p.qty>0) AS oldest_days
    FROM stock s LEFT JOIN parts p ON p.sku_id=s.sku_id GROUP BY s.sku_id,s.qty,s.value`, [business.id, productId, locationId, business.timezone]);
}

// The "core" sizes of a run: the middle ones (all but the smallest and
// largest when a run has four or more sizes; the middle one of three).
function coreSizes(sizes) {
  if (sizes.length <= 2) return sizes;
  if (sizes.length === 3) return [sizes[1]];
  return sizes.slice(1, -1);
}

// Per style: sold (net) and stock per size with the size curve (% of the
// style's net sales in each size), broken size runs per colour, and ageing.
async function styleReport(business, query) {
  await access.require(business, 'reports.view');
  requireVariants(business);
  const fashion = require('./businessFashion.service');
  const base = await fashion.variantReport(business, query);
  const locationId = query.locationId ? id(query.locationId, 'Location') : null;
  const productId = query.productId ? id(query.productId, 'Product') : null;
  const ages = await ageing(repo.pool, business, { productId, locationId });
  const ageOf = new Map(ages.map((a) => [Number(a.sku_id), a]));
  const styles = new Map();
  for (const r of base.items) {
    const key = Number(r.product_id);
    const style = styles.get(key) || { product_id: key, product_name: r.product_name, brand: r.brand, category: r.category, sizes: new Map(), colors: new Map(),
      net_qty: 0, stock_qty: 0, net_sales: 0, stock_value: 0, ages: { d0_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0 }, oldest_days: null };
    const sold = Math.round(Number(r.net_qty) * 1000), stock = Math.round(Number(r.stock_qty) * 1000);
    const size = style.sizes.get(r.size.toLowerCase()) || { size: r.size, rank: r.size_rank, net_qty: 0, stock_qty: 0 };
    size.net_qty += sold; size.stock_qty += stock;
    style.sizes.set(r.size.toLowerCase(), size);
    const color = style.colors.get(r.color.toLowerCase()) || { color: r.color, cells: new Map() };
    const cell = color.cells.get(r.size.toLowerCase()) || { size: r.size, rank: r.size_rank, stock: 0, sku_ids: [] };
    cell.stock += stock; cell.sku_ids.push(Number(r.sku_id));
    color.cells.set(r.size.toLowerCase(), cell);
    style.colors.set(r.color.toLowerCase(), color);
    style.net_qty += sold; style.stock_qty += stock; style.net_sales += paise(r.net_sales); style.stock_value += paise(r.stock_value);
    const age = ageOf.get(Number(r.sku_id));
    if (age) {
      for (const bucket of Object.keys(style.ages)) style.ages[bucket] += Math.round(Number(age[bucket]) * 1000);
      if (age.oldest_days !== null && (style.oldest_days === null || Number(age.oldest_days) > style.oldest_days)) style.oldest_days = Number(age.oldest_days);
    }
    styles.set(key, style);
  }
  const qty = (milli) => (milli / 1000).toFixed(3);
  const out = [], broken = [];
  for (const style of styles.values()) {
    const sizes = [...style.sizes.values()].sort((a, b) => a.rank - b.rank || String(a.size).localeCompare(String(b.size)));
    const positive = Math.max(style.net_qty, 0);
    const core = coreSizes(sizes.map((s) => s.size.toLowerCase()));
    for (const color of style.colors.values()) {
      const cells = [...color.cells.values()].sort((a, b) => a.rank - b.rank);
      const empty = cells.filter((c) => c.stock <= 0 && core.includes(c.size.toLowerCase()));
      const left = cells.reduce((s, c) => s + Math.max(c.stock, 0), 0);
      if (empty.length && left > 0) {
        broken.push({ product_id: style.product_id, product_name: style.product_name, color: color.color, missing: empty.map((c) => c.size),
          missing_sku_ids: empty.flatMap((c) => c.sku_ids), in_stock: cells.filter((c) => c.stock > 0).map((c) => ({ size: c.size, stock: qty(c.stock) })), stock_qty: qty(left) });
      }
    }
    out.push({
      product_id: style.product_id, product_name: style.product_name, brand: style.brand, category: style.category,
      net_qty: qty(style.net_qty), stock_qty: qty(style.stock_qty), net_sales: money(style.net_sales), stock_value: money(style.stock_value),
      sell_through: positive + style.stock_qty > 0 ? Math.round((positive / (positive + style.stock_qty)) * 1000) / 10 : null,
      sizes: sizes.map((s) => ({ size: s.size, net_qty: qty(s.net_qty), stock_qty: qty(s.stock_qty), share: positive > 0 ? Math.round((Math.max(s.net_qty, 0) / positive) * 1000) / 10 : null })),
      ages: Object.fromEntries(Object.entries(style.ages).map(([k, m]) => [k, qty(m)])),
      oldest_days: style.oldest_days,
      broken_colors: broken.filter((b) => b.product_id === style.product_id).length,
    });
  }
  return { from: base.from, to: base.to, styles: out, broken, buckets: AGE_BUCKETS, ageing: ages };
}

module.exports = { setBarcodes, createMarkdowns, endMarkdown, markdowns, gstRule, saveGstRule, applyPriceSlabs, styleReport, ageing, coreSizes };
