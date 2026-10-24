const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// Subsidised fertiliser against the government's PoS device. Every
// subsidised fertiliser sold carries the PoS receipt number (agri_sale_lines);
// there is no link to the PoS or iFMS, so the shop mirrors each PoS sale and
// reconciles:
//   report  per day and product at one location: what the bills sold (in the
//           item's stock unit, bags), how many bills and PoS receipts, what
//           came back, and the last stock typed in from the PoS device that
//           day against the shop's own stock then
//   check   the PoS device's stock for each subsidised fertiliser, typed in,
//           kept with the shop's own stock at that moment (agri_pos_checks)

const { fail, requireAgri } = common;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const milli = (value) => Math.round(Number(value) * 1000);
const qty = (m) => (m / 1000).toFixed(3);
// A subsidised fertiliser, as its item's details say.
const SUBSIDISED = "s.attributes->>'inputKind'='fertiliser' AND s.attributes->>'subsidised'='yes'";

async function locationOf(db, business, value) {
  const locationId = id(value, 'Location');
  access.requireLocation(business, locationId);
  const location = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId]);
  if (!location) fail('Location not found', 404);
  return location;
}

// query: { locationId, from, to } (up to 92 days).
async function report(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = await locationOf(repo.pool, business, query.locationId ?? query.location);
  const from = common.readDate(query.from, 'From date'), to = common.readDate(query.to, 'To date');
  if (to < from) fail('The end date is before the start date');
  if (common.daysBetween(from, to) > 91) fail('Choose up to 92 days');
  const rows = await repo.all(repo.pool, `WITH sold AS (
      SELECT (d.created_at AT TIME ZONE $5)::date AS day,a.sku_id,sum(dl.quantity) AS sold,count(DISTINCT d.id)::int AS bills,count(DISTINCT a.pos_receipt)::int AS receipts
      FROM agri_sale_lines a JOIN business_documents d ON d.business_id=a.business_id AND d.id=a.document_id
      JOIN business_document_lines dl ON dl.business_id=a.business_id AND dl.id=a.line_id
      WHERE a.business_id=$1 AND a.subsidised AND d.location_id=$2 AND (d.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
      GROUP BY 1,2),
    returned AS (
      SELECT (r.created_at AT TIME ZONE $5)::date AS day,a.sku_id,sum(rl.quantity) AS returned
      FROM business_return_lines rl JOIN business_returns r ON r.business_id=rl.business_id AND r.id=rl.return_id
      JOIN agri_sale_lines a ON a.business_id=rl.business_id AND a.line_id=rl.line_id
      JOIN business_documents d ON d.business_id=a.business_id AND d.id=a.document_id
      WHERE rl.business_id=$1 AND a.subsidised AND d.location_id=$2 AND (r.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
      GROUP BY 1,2),
    checked AS (
      SELECT DISTINCT ON (c.checked_on,cl.sku_id) c.checked_on AS day,cl.sku_id,cl.pos_stock,cl.app_stock,c.created_at AS checked_at
      FROM agri_pos_checks c JOIN agri_pos_check_lines cl ON cl.business_id=c.business_id AND cl.check_id=c.id
      WHERE c.business_id=$1 AND c.location_id=$2 AND c.checked_on BETWEEN $3::date AND $4::date
      ORDER BY c.checked_on,cl.sku_id,c.created_at DESC,c.id DESC),
    keys AS (SELECT day,sku_id FROM sold UNION SELECT day,sku_id FROM returned UNION SELECT day,sku_id FROM checked)
    SELECT k.day::text AS day,k.sku_id,s.label,s.unit,COALESCE(so.sold,0) AS sold,COALESCE(so.bills,0) AS bills,COALESCE(so.receipts,0) AS receipts,
      COALESCE(re.returned,0) AS returned,ch.pos_stock,ch.app_stock,(ch.app_stock-ch.pos_stock) AS difference,ch.checked_at
    FROM keys k JOIN catalog_skus s ON s.business_id=$1 AND s.id=k.sku_id
    LEFT JOIN sold so ON so.day=k.day AND so.sku_id=k.sku_id
    LEFT JOIN returned re ON re.day=k.day AND re.sku_id=k.sku_id
    LEFT JOIN checked ch ON ch.day=k.day AND ch.sku_id=k.sku_id
    ORDER BY k.day DESC,s.label`, [business.id, location.id, from, to, business.timezone]);
  const totals = {
    sold: qty(rows.reduce((n, r) => n + milli(r.sold), 0)), returned: qty(rows.reduce((n, r) => n + milli(r.returned), 0)),
    bills: rows.reduce((n, r) => n + r.bills, 0), receipts: rows.reduce((n, r) => n + r.receipts, 0),
    differences: rows.filter((r) => r.difference !== null && milli(r.difference) !== 0).length,
  };
  return { location, from, to, rows, totals };
}

// The subsidised fertilisers a location may sell, with its stock of each now
// and the last PoS stock typed in today: the form the PoS stock is typed into.
async function products(business, query) {
  requireAgri(business);
  await access.require(business, 'agri.view');
  const location = await locationOf(repo.pool, business, query.locationId ?? query.location);
  const today = await common.today(repo.pool, business);
  const items = await repo.all(repo.pool, `SELECT s.id,s.label,s.code,s.unit,u.name AS unit_name,u.decimals AS unit_decimals,
      COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.location_id=$2 AND l.sku_id=s.id),0) AS stock,
      (SELECT json_build_object('pos_stock',cl.pos_stock,'app_stock',cl.app_stock,'checked_at',c.created_at) FROM agri_pos_check_lines cl
        JOIN agri_pos_checks c ON c.business_id=cl.business_id AND c.id=cl.check_id
        WHERE cl.business_id=s.business_id AND cl.sku_id=s.id AND c.location_id=$2 AND c.checked_on=$3::date ORDER BY c.created_at DESC,c.id DESC LIMIT 1) AS today
    FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    WHERE s.business_id=$1 AND s.active AND ${SUBSIDISED} ORDER BY s.label`, [business.id, location.id, today]);
  return { location, today, items };
}

// body: { requestKey, locationId, lines: [{ skuId, posStock }], notes? } — the
// PoS device's stock of each subsidised fertiliser now, in the item's stock
// unit. Kept with the shop's own stock at this moment; a retry gives the same entry.
async function check(business, user, body) {
  requireAgri(business);
  await access.require(business, 'agri.create');
  const core = require('../../core/services/business.service');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const list = v.requiredArray(body.lines, 'Products');
  if (!list.length || list.length > 100) fail('Type the PoS stock of between 1 and 100 products');
  const lines = list.map((line) => {
    if (!line || typeof line !== 'object') fail('Each product must be an object');
    return { skuId: id(line.skuId, 'Product'), posStock: core.decimal(line.posStock, 'PoS stock', 3, 0, 10000000) };
  });
  if (new Set(lines.map((l) => l.skuId)).size !== lines.length) fail('Each product is typed in once');
  const notes = v.optionalString(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT * FROM agri_pos_checks WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return checkOf(db, business, done.id);
    }
    const location = await locationOf(db, business, body.locationId);
    const today = await common.today(db, business);
    const saved = await repo.one(db, `INSERT INTO agri_pos_checks(business_id,location_id,checked_on,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [business.id, location.id, today, notes, requestKey, hash, user.id]);
    const kept = [];
    for (const line of lines) {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.unit,u.decimals,u.name AS unit_name,
          COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.location_id=$3 AND l.sku_id=s.id),0) AS stock
        FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.id=$2 AND ${SUBSIDISED}`,
      [business.id, line.skuId, location.id]);
      if (!sku) fail('Only a subsidised fertiliser is reconciled with the PoS device', 404);
      core.requiredDecimals(line.posStock, { decimals: sku.decimals, name: sku.unit_name }, `PoS stock of ${sku.label}`);
      await db.query('INSERT INTO agri_pos_check_lines(business_id,check_id,sku_id,pos_stock,app_stock) VALUES($1,$2,$3,$4,$5)',
        [business.id, saved.id, sku.id, line.posStock, sku.stock]);
      kept.push({ skuId: sku.id, posStock: qty(milli(line.posStock)), appStock: qty(milli(sku.stock)) });
    }
    const differ = kept.filter((k) => milli(k.posStock) !== milli(k.appStock)).length;
    await repo.audit(db, business.id, user.id, 'pos_stock.checked', saved.id, { location: location.name, checkedOn: today, products: kept.length, differences: differ });
    await repo.event(db, business.id, user.id, 'agri.pos_stock_checked', 'pos_check', saved.id, { locationId: location.id, checkedOn: today, lines: kept });
    return checkOf(db, business, saved.id);
  });
}

async function checkOf(db, business, checkId) {
  const head = await repo.one(db, `SELECT c.*,loc.name AS location_name,u.name AS created_by_name FROM agri_pos_checks c
    JOIN business_locations loc ON loc.business_id=c.business_id AND loc.id=c.location_id LEFT JOIN users u ON u.id=c.created_by
    WHERE c.business_id=$1 AND c.id=$2`, [business.id, checkId]);
  const lines = await repo.all(db, `SELECT cl.sku_id,s.label,s.unit,cl.pos_stock,cl.app_stock,(cl.app_stock-cl.pos_stock) AS difference
    FROM agri_pos_check_lines cl JOIN catalog_skus s ON s.business_id=cl.business_id AND s.id=cl.sku_id
    WHERE cl.business_id=$1 AND cl.check_id=$2 ORDER BY s.label`, [business.id, checkId]);
  const { request_hash: _hash, ...rest } = head;
  return { ...rest, lines };
}

module.exports = { report, products, check };
