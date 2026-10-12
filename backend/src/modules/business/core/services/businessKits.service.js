const repo = require('../repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const access = require('./businessAccess.service');
const pricing = require('./businessPricing');

// Accessory kits and bundles (round 2, R2-CORE): "Mobile + cover + screen
// guard" sold at one kit price. The kit is a catalogue item of its own
// (is_kit, no stock of its own); its components are ordinary items.
//
// On a sale a kit line becomes one line per component:
//   - stock comes off each component (a serial-numbered part names its serial,
//     a batch part takes the batch that expires first unless one is named);
//   - the kit's price (with any customer price) is split over the components
//     in proportion to their own list prices, to the paisa, so GST is worked
//     out at each component's own rate and the invoice shows each HSN;
//   - every component line remembers the kit (kit_sku_id, kit_label,
//     kit_group: the components of one kit line share a group number).
// A kit is never bought or received as a kit: purchases take the components.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (number) => Math.round(Number(number) * 100);
const milli = (number) => Math.round(Number(number) * 1000);
const core = () => require('./business.service');

// total split over weights in proportion; the rounding carried forward so the
// parts add up exactly to the total.
function split(total, weights) {
  const whole = weights.reduce((s, w) => s + w, 0);
  if (!whole) return split(total, weights.map(() => 1));
  let given = 0, running = 0;
  return weights.map((weight) => {
    running += weight;
    const upto = Number((BigInt(total) * BigInt(running) * 2n + BigInt(whole)) / (BigInt(whole) * 2n));
    const part = upto - given;
    given = upto;
    return part;
  });
}

const componentsOf = (db, businessId, kitIds) => repo.all(db, `SELECT k.kit_sku_id,k.quantity AS kit_quantity,k.sort_order,s.id,s.label,s.code,s.unit,s.price,s.mrp,s.tax_rate,s.hsn_code,s.tracking,s.active,
    p.kind,u.decimals AS unit_decimals
  FROM catalog_kit_components k
  JOIN catalog_skus s ON s.business_id=k.business_id AND s.id=k.component_sku_id
  JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
  WHERE k.business_id=$1 AND k.kit_sku_id=ANY($2::bigint[]) ORDER BY k.kit_sku_id,k.sort_order,k.id`, [businessId, kitIds]);

// Turns the kit lines of a sale into component lines (inside the posting
// transaction, after the business is locked). Returns { lines, kitOf } where
// kitOf[i] is null for a plain line or { skuId, label, group, share (paise,
// the document's price terms), inputIndex } for a kit's component, and
// kitOf.inputIndexes[i] the line of the request each line came from.
async function expand(db, business, inputLines, { kind, contact, taxMode, locationId, fixed }) {
  const skuIds = [...new Set(inputLines.map((line) => Number(line?.skuId)).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const kitRows = skuIds.length ? await repo.all(db, 'SELECT id FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[]) AND is_kit', [business.id, skuIds]) : [];
  if (!kitRows.length) return { lines: inputLines, kitOf: [] };
  if (kind !== 'sale') fail('A kit is bought as its parts: receive each component instead', 409);
  if (fixed) fail('A kit cannot be on a dispatched order line', 409);
  const kitIds = new Set(kitRows.map((r) => Number(r.id)));
  const components = await componentsOf(db, business.id, [...kitIds]);
  const lines = [], kitOf = [], inputIndexes = [];
  let group = 0;
  for (const [inputIndex, input] of inputLines.entries()) {
    if (!kitIds.has(Number(input?.skuId))) { lines.push(input); kitOf.push(null); inputIndexes.push(inputIndex); continue; }
    const kit = await repo.one(db, `SELECT s.* FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, Number(input.skuId)]);
    if (!kit) fail('Item not found', 404);
    if (input.unit && input.unit !== kit.unit) fail(`${kit.label} is sold in whole kits`);
    const quantity = core().decimal(input.quantity, 'Quantity', 0, 1, 1000);
    const parts = components.filter((c) => Number(c.kit_sku_id) === Number(kit.id));
    if (!parts.length) fail(`${kit.label} has no components yet. Add them under Products › Kits & bundles.`, 409);
    const stopped = parts.find((c) => !c.active);
    if (stopped) fail(`${stopped.label}, a part of ${kit.label}, is no longer sold. Change the kit first.`, 409);
    if (parts.some((c) => c.tracking === 'serial') && quantity !== 1) fail(`${kit.label} has a serial-numbered part: bill one kit per line`);
    // The kit's price for this customer and quantity, and its MRP.
    const priced = await pricing.salePrice(db, business, kit, contact?.id, quantity, null);
    core().checkMrp(kit.label, priced.stockPrice, kit.tax_rate, taxMode, kit.mrp);
    const weights = parts.map((c) => paise(c.price) * milli(c.kit_quantity));
    const shares = split(priced.net, weights);
    group += 1;
    const named = Array.isArray(input.components) ? input.components : [];
    for (const [index, part] of parts.entries()) {
      const need = Number((quantity * Number(part.kit_quantity)).toFixed(3));
      const given = named.find((x) => Number(x?.skuId) === Number(part.id));
      let lotCode = given?.lotCode ? String(given.lotCode).trim() : '';
      if (part.tracking === 'serial' && !lotCode) fail(`Scan or choose the serial number of ${part.label} in ${kit.label}`);
      if (part.tracking === 'batch' && !lotCode) {
        // The batch that expires first and still covers the line.
        const lot = await repo.one(db, `SELECT l.lot_code FROM business_stock_lots l JOIN businesses b ON b.id=l.business_id
          WHERE l.business_id=$1 AND l.location_id=$2 AND l.sku_id=$3 AND l.quantity>=$4
          AND (l.expires_on IS NULL OR l.expires_on >= (now() AT TIME ZONE b.timezone)::date) ORDER BY l.expires_on NULLS LAST,l.id LIMIT 1`,
        [business.id, locationId, part.id, need]);
        if (!lot) fail(`Not enough usable stock for ${part.label} (in ${kit.label})`, 409);
        lotCode = lot.lot_code;
      }
      lines.push({ skuId: part.id, quantity: String(need), ...(lotCode ? { lotCode } : {}) });
      kitOf.push({ skuId: Number(kit.id), label: kit.label, group, share: shares[index], inputIndex });
      inputIndexes.push(inputIndex);
    }
  }
  kitOf.inputIndexes = inputIndexes;
  return { lines, kitOf };
}
const inputIndexOf = (kitOf, lineIndex) => (kitOf.inputIndexes ? kitOf.inputIndexes[lineIndex] : lineIndex);

// --- Keeping kits ------------------------------------------------------------------

function readComponents(value) {
  const list = v.requiredArray(value, 'Components');
  if (!list.length || list.length > 20) fail('A kit has between 1 and 20 components');
  const seen = new Set();
  return list.map((c) => {
    if (!c || typeof c !== 'object') fail('Each component must be an object');
    const skuId = id(c.skuId, 'Component');
    if (seen.has(skuId)) fail('An item can be in a kit only once (raise its quantity instead)');
    seen.add(skuId);
    return { skuId, quantity: core().decimal(c.quantity ?? 1, 'Component quantity', 3, 0.001, 1000) };
  });
}
async function checkComponents(db, business, kitId, components) {
  const rows = await repo.all(db, `SELECT s.id,s.label,s.tracking,s.is_kit,s.active,p.kind,p.active AS product_active,u.decimals FROM catalog_skus s
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    WHERE s.business_id=$1 AND s.id=ANY($2::bigint[])`, [business.id, components.map((c) => c.skuId)]);
  if (rows.length !== components.length) fail('A component was not found', 404);
  for (const c of components) {
    const row = rows.find((r) => Number(r.id) === c.skuId);
    if (kitId && Number(row.id) === Number(kitId)) fail('A kit cannot contain itself');
    if (row.is_kit) fail(`${row.label} is a kit; a kit is made of ordinary items`);
    if (row.kind !== 'goods' || row.tracking === 'none') fail(`${row.label} is a service; a kit is made of goods`);
    if (!row.active || !row.product_active) fail(`${row.label} is not sold any more`);
    if (row.tracking === 'serial' && c.quantity !== 1) fail(`${row.label} is serial-numbered: one per kit`);
    if (Number(row.decimals) === 0 && !Number.isInteger(c.quantity)) fail(`${row.label} is counted in whole units`);
  }
  const units = components.reduce((s, c) => s + c.quantity, 0);
  if (components.length === 1 && units <= 1) fail('A kit needs at least two pieces (two items, or more than one of an item)');
}
async function saveComponents(db, businessId, kitId, components) {
  await db.query('DELETE FROM catalog_kit_components WHERE business_id=$1 AND kit_sku_id=$2', [businessId, kitId]);
  for (const [index, c] of components.entries()) {
    await db.query('INSERT INTO catalog_kit_components(business_id,kit_sku_id,component_sku_id,quantity,sort_order) VALUES($1,$2,$3,$4,$5)',
      [businessId, kitId, c.skuId, c.quantity, index]);
  }
}

async function list(business, query = {}) {
  await access.require(business, 'catalog.view');
  const limit = query.limit === undefined ? 25 : Math.min(100, id(query.limit, 'Page size'));
  const offset = query.offset === undefined ? 0 : Math.max(0, Math.min(10000000, Number(query.offset) || 0));
  const search = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().slice(0, 100)}%` : null;
  const where = `s.business_id=$1 AND s.is_kit AND ($2::text IS NULL OR s.label ILIKE $2 OR s.code ILIKE $2 OR s.barcode ILIKE $2)`;
  const [rows, total] = await Promise.all([
    repo.all(repo.pool, `SELECT s.id,s.code,s.barcode,s.label,s.price,s.mrp,s.tax_rate,s.active,s.created_at,
        COALESCE((SELECT json_agg(json_build_object('skuId',c.component_sku_id,'label',x.label,'code',x.code,'quantity',c.quantity,'price',x.price,
          'taxRate',x.tax_rate,'hsnCode',x.hsn_code,'tracking',x.tracking,
          'stock',COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=x.business_id AND l.sku_id=x.id),0)) ORDER BY c.sort_order,c.id)
          FROM catalog_kit_components c JOIN catalog_skus x ON x.business_id=c.business_id AND x.id=c.component_sku_id
          WHERE c.business_id=s.business_id AND c.kit_sku_id=s.id),'[]') AS components
      FROM catalog_skus s WHERE ${where} ORDER BY s.active DESC,s.label LIMIT $3 OFFSET $4`, [business.id, search, limit, offset]),
    repo.one(repo.pool, `SELECT count(*)::int AS total FROM catalog_skus s WHERE ${where}`, [business.id, search]),
  ]);
  const items = rows.map((kit) => {
    const value = kit.components.reduce((s, c) => s + paise(c.price) * milli(c.quantity), 0) / 1000;
    const canMake = kit.components.length ? Math.min(...kit.components.map((c) => Math.floor(Number(c.stock) / Number(c.quantity)))) : 0;
    return { ...kit, parts_value: (value / 100).toFixed(2), available: Math.max(0, canMake) };
  });
  return { items, total: total.total, limit, offset };
}

async function create(business, user, body) {
  await access.require(business, 'catalog.create');
  if (!business.capabilities.includes('inventory')) fail('This business has no goods inventory capability');
  const components = readComponents(body.components);
  return repo.transaction(async (db) => {
    await checkComponents(db, business, null, components);
    const unit = await repo.one(db, "SELECT code FROM business_units WHERE business_id=$1 AND active AND kind='count' ORDER BY (code='each') DESC,(code='pcs') DESC,id LIMIT 1", [business.id]);
    if (!unit) fail('Add a count unit (each / piece) under Units first');
    // GST on a kit is its components'; the kit's own rate only matters for an
    // MRP check when prices are before GST: the highest of its parts.
    const top = await repo.one(db, 'SELECT max(tax_rate) AS rate FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, components.map((c) => c.skuId)]);
    const rate = Number(top?.rate || 0);
    const slab = await repo.one(db, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=$2 AND active ORDER BY is_default DESC,id LIMIT 1', [business.id, rate]);
    const name = v.requiredString(body.name, 'Kit name', 150);
    const price = core().decimal(body.price, 'Kit price');
    const mrp = core().readMrp(body.mrp);
    const taxMode = (await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]))?.tax_mode || 'exclusive';
    core().checkMrp(name, price, rate, taxMode, mrp);
    const barcode = body.barcode ? v.requiredString(body.barcode, 'Barcode', 80) : null;
    if (barcode) {
      if (!/^[0-9A-Za-z./-]{1,80}$/.test(barcode)) fail('A barcode is letters and digits only (up to 80)');
      const clash = await repo.one(db, 'SELECT label FROM catalog_skus WHERE business_id=$1 AND barcode=$2 LIMIT 1', [business.id, barcode]);
      if (clash) fail(`Barcode ${barcode} is already on ${clash.label}`, 409);
    }
    const product = await repo.one(db, 'INSERT INTO catalog_products(business_id,name,kind,brand) VALUES($1,$2,\'goods\',$3) RETURNING *',
      [business.id, name, v.optionalString(body.brand, 'Brand', 100)]);
    const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,barcode,label,unit,price,tax_rate,tax_rate_id,tracking,attributes,mrp,is_kit)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'none','{}',$10,true) RETURNING *`,
    [business.id, product.id, v.requiredString(body.code, 'Kit code', 60).toUpperCase(), barcode, name, unit.code, price, rate, slab?.id || null, mrp]);
    await saveComponents(db, business.id, sku.id, components);
    await repo.audit(db, business.id, user.id, 'kit.created', sku.id, { label: name, price: sku.price, components });
    return sku;
  });
}

async function update(business, user, kitId, body) {
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const kit = await repo.one(db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND id=$2 AND is_kit FOR UPDATE', [business.id, id(kitId)]);
    if (!kit) fail('Kit not found', 404);
    const label = body.name === undefined ? kit.label : v.requiredString(body.name, 'Kit name', 150);
    const price = body.price === undefined ? Number(kit.price) : core().decimal(body.price, 'Kit price');
    const mrp = body.mrp === undefined ? kit.mrp : core().readMrp(body.mrp);
    const active = body.active === undefined ? kit.active : v.requiredBoolean(body.active, 'Active');
    const taxMode = (await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]))?.tax_mode || 'exclusive';
    let rate = Number(kit.tax_rate);
    if (body.components !== undefined) {
      const components = readComponents(body.components);
      await checkComponents(db, business, kit.id, components);
      await saveComponents(db, business.id, kit.id, components);
      rate = Number((await repo.one(db, 'SELECT max(tax_rate) AS rate FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, components.map((c) => c.skuId)]))?.rate || 0);
    }
    core().checkMrp(label, price, rate, taxMode, mrp);
    const saved = await repo.one(db, 'UPDATE catalog_skus SET label=$3,price=$4,mrp=$5,active=$6,tax_rate=$7 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, kit.id, label, price, mrp, active, rate]);
    await db.query('UPDATE catalog_products SET name=$3 WHERE business_id=$1 AND id=$2', [business.id, kit.product_id, label]);
    await repo.audit(db, business.id, user.id, 'kit.updated', kit.id, { label, price: saved.price, active, components: body.components === undefined ? undefined : 'changed' });
    return saved;
  });
}

// What the counter needs to add a scanned kit: its parts, and for serial or
// batch parts the units / batches in stock at this location.
async function forCounter(db, business, kit, locationId) {
  const parts = await componentsOf(db, business.id, [kit.id]);
  const out = [];
  for (const part of parts) {
    const lots = !['batch', 'serial'].includes(part.tracking) ? [] : await repo.all(db, `SELECT l.id,l.lot_code,l.expires_on,l.quantity FROM business_stock_lots l JOIN businesses b ON b.id=l.business_id
      WHERE l.business_id=$1 AND l.sku_id=$2 AND l.quantity>0 AND ($3::bigint IS NULL OR l.location_id=$3)
      AND (l.expires_on IS NULL OR l.expires_on >= (now() AT TIME ZONE b.timezone)::date) ORDER BY l.expires_on NULLS LAST,l.id LIMIT 200`, [business.id, part.id, locationId]);
    const stock = await repo.one(db, 'SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND ($3::bigint IS NULL OR location_id=$3)', [business.id, part.id, locationId]);
    out.push({ skuId: part.id, label: part.label, code: part.code, unit: part.unit, quantity: part.kit_quantity, tracking: part.tracking, hsnCode: part.hsn_code, taxRate: part.tax_rate, stock: stock.q, lots });
  }
  return out;
}

module.exports = { expand, inputIndexOf, list, create, update, forCounter, split };
