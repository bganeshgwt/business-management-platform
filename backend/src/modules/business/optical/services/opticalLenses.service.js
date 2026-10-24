const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./opticalCommon');

// Contact lenses (module "optical", with Variants switched on): a lens
// product's powers made as its items in one go. Each power of the ranges
// given (-0.50 to -6.00 in steps of 0.25, +0.50 to +4.00, …) becomes an item
// of the product, at one price, its label and code naming the power, and its
// power, base curve and diameter kept with its details (catalog_skus
// attributes). More powers can be added to the product later; a power it
// already has is left as it is. Stock comes in through purchases, by batch
// and expiry where batches are on.

const { fail } = c;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
// The most items one lens product may have, and the most powers one request makes.
const MAX_POWERS = 300;
const MAX_NEW = 200;
const codePart = (text, length) => String(text).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length);
// -2.50 -> "-2.50", 1.25 -> "+1.25", 0 -> "0.00" (hundredths in, text out).
const powerText = (hundredths) => `${hundredths > 0 ? '+' : ''}${(hundredths / 100).toFixed(2)}`;
// -2.50 -> "M250", +1.25 -> "P125", 0 -> "000".
const powerCode = (hundredths) => (hundredths === 0 ? '000' : `${hundredths < 0 ? 'M' : 'P'}${String(Math.abs(hundredths)).padStart(3, '0')}`);

function requireVariants(business) {
  if (!business.modules.includes('variants')) fail('Variants are not switched on for this business. An owner can turn them on in Settings › Business tools.', 403);
}

// The powers asked for, in hundredths of a dioptre: [{ from, to, step }] with
// powers from -20.00 to +20.00 and a step of 0.25 or 0.50.
function readRanges(value) {
  const list = v.requiredArray(value, 'Powers');
  if (!list.length || list.length > 4) fail('Give one to four ranges of powers');
  const powers = new Set();
  for (const [index, range] of list.entries()) {
    if (!range || typeof range !== 'object' || Array.isArray(range)) fail('Each range of powers must be an object');
    const name = list.length > 1 ? `Range ${index + 1}` : 'The range';
    const from = c.readPower(range.from, `${name}: from`, { min: -20, max: 20 });
    const to = c.readPower(range.to, `${name}: to`, { min: -20, max: 20 });
    if (from === null || to === null) fail(`${name}: give the first and the last power`);
    const step = Math.round(Number(v.requiredEnum(String(range.step ?? '0.25'), `${name}: step`, ['0.25', '0.5', '0.50'])) * 100);
    const low = Math.min(Math.round(Number(from) * 100), Math.round(Number(to) * 100));
    const high = Math.max(Math.round(Number(from) * 100), Math.round(Number(to) * 100));
    if ((high - low) % step !== 0) fail(`${name}: from ${powerText(low)} to ${powerText(high)} does not go in steps of ${(step / 100).toFixed(2)}`);
    for (let p = low; p <= high; p += step) powers.add(p);
  }
  if (powers.size > MAX_NEW) fail(`Make at most ${MAX_NEW} powers at a time`);
  return [...powers].sort((a, b) => a - b);
}
// Base curve and diameter in mm, up to two decimals.
function readMm(value, name, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be from ${min} to ${max} mm, with at most two decimal places`);
  return Number(text).toFixed(2).replace(/0$/, '');
}
// A GST slab chosen by id, or the default slab of a bare rate.
async function readSlab(db, business, body) {
  if (c.given(body.taxRateId)) {
    const slab = await repo.one(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.taxRateId, 'GST slab')]);
    if (!slab) fail('GST slab not found', 404);
    return { taxRateId: slab.id, rate: Number(slab.rate) };
  }
  const rate = core.decimal(body.taxRate ?? 0, 'GST rate', 2, 0, 100);
  const slab = await repo.one(db, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=$2 AND active ORDER BY is_default DESC,id LIMIT 1', [business.id, rate]);
  return { taxRateId: slab?.id || null, rate };
}

// A lens product with the powers it has, each with its stock (at one location or all).
async function powersOf(db, business, productId, locationId = null) {
  const product = await repo.one(db, 'SELECT * FROM catalog_products WHERE business_id=$1 AND id=$2', [business.id, productId]);
  if (!product) fail('Product not found', 404);
  const skus = await repo.all(db, `SELECT s.id,s.code,s.label,s.price,s.mrp,s.unit,s.tracking,s.tax_rate,s.tax_rate_id,s.reorder_level,s.hsn_code,s.active,s.attributes,
      COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id AND ($3::bigint IS NULL OR l.location_id=$3)),0) AS stock
    FROM catalog_skus s WHERE s.business_id=$1 AND s.product_id=$2 ORDER BY s.id`, [business.id, product.id, locationId]);
  const powered = skus.filter((s) => s.attributes && s.attributes.power !== undefined);
  return { product, skus, powered };
}

// The powers a lens product has (the item form's power grid, adding more).
async function grid(business, productId, query = {}) {
  c.requireOptical(business);
  await access.require(business, 'catalog.view');
  requireVariants(business);
  const { product, powered } = await powersOf(repo.pool, business, id(productId, 'Product'), c.given(query.locationId) ? id(query.locationId, 'Location') : null);
  const first = powered[0]?.attributes || {};
  return { product, base_curve: first.baseCurve || null, diameter: first.diameter || null,
    powers: powered.map((s) => ({ sku_id: s.id, code: s.code, label: s.label, power: s.attributes.power, price: s.price, active: s.active, stock: s.stock }))
      .sort((a, b) => Number(a.power) - Number(b.power)) };
}

// A new lens product with its powers, or more powers for one made here before.
// body: { productId? | name, brand?, categoryId?, unit, tracking?, price, taxRateId? | taxRate, mrp?, hsnCode?, reorderLevel?,
//   codePrefix?, baseCurve, diameter, ranges: [{ from, to, step }] }
async function createGrid(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'catalog.create');
  requireVariants(business);
  const powers = readRanges(body.ranges);
  const baseCurve = readMm(body.baseCurve, 'Base curve', 7, 10);
  const diameter = readMm(body.diameter, 'Diameter', 12, 16);
  const mrp = core.readMrp(body.mrp);
  return repo.transaction(async (db) => {
    let product, base, created = [];
    if (c.given(body.productId)) {
      product = await repo.one(db, 'SELECT * FROM catalog_products WHERE business_id=$1 AND id=$2 AND active FOR UPDATE', [business.id, id(body.productId, 'Product')]);
      if (!product) fail('Product not found', 404);
      const { skus, powered } = await powersOf(db, business, product.id);
      if (!powered.length) fail(`${product.name} has no lens powers yet: make its powers as a new lens product`, 409);
      const first = powered[0];
      if (first.attributes.baseCurve !== baseCurve || first.attributes.diameter !== diameter) {
        fail(`${product.name} has base curve ${first.attributes.baseCurve} and diameter ${first.attributes.diameter}: another base curve or diameter is another lens product`, 409);
      }
      await core.requireDepartmentItem(db, business, { categoryId: product.category_id });
      const price = c.given(body.price) ? core.decimal(body.price, 'Price') : Number(first.price);
      base = { unit: first.unit, tracking: first.tracking, taxRate: Number(first.tax_rate), taxRateId: first.tax_rate_id, reorderLevel: first.reorder_level,
        hsn: first.hsn_code, mrp: c.given(body.mrp) ? mrp : first.mrp, price, prefix: String(first.code).split('-')[0] };
      const have = new Set(powered.map((s) => Math.round(Number(s.attributes.power) * 100)));
      const fresh = powers.filter((p) => !have.has(p));
      if (!fresh.length) fail(`${product.name} already has every one of these powers`, 409);
      if (skus.length + fresh.length > MAX_POWERS) fail(`A lens product can have at most ${MAX_POWERS} powers`);
      created = await insertPowers(db, business, product, base, fresh, { baseCurve, diameter });
    } else {
      const name = v.requiredString(typeof body.name === 'string' ? body.name : '', 'Lens name', 120);
      if (!business.capabilities.includes('inventory')) fail('This business has no goods inventory capability');
      const tracking = v.optionalEnum(body.tracking, 'Stock tracking', ['quantity', 'batch'], 'quantity');
      if (tracking === 'batch' && !business.capabilities.includes('batches')) fail('Batch tracking is not enabled');
      const unit = await core.readUnit(db, business.id, body.unit || 'box');
      if (unit.kind !== 'count') fail('Contact lenses are counted: choose a unit such as box, pack or each');
      const tax = await readSlab(db, business, body);
      let categoryId = null;
      if (c.given(body.categoryId)) {
        const category = await repo.one(db, 'SELECT id FROM catalog_categories WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.categoryId, 'Category')]);
        if (!category) fail('Category not found', 404);
        categoryId = category.id;
      }
      await core.requireDepartmentItem(db, business, { categoryId });
      const prefix = codePart(c.optionalText(body.codePrefix, 'Code prefix', 20) || name.split(/\s+/).map((w) => w[0]).join('') || name, 20) || 'CL';
      const used = await repo.one(db, 'SELECT code FROM catalog_skus WHERE business_id=$1 AND (code=$2 OR code LIKE $3) LIMIT 1', [business.id, prefix, `${prefix}-%`]);
      if (used) fail(`Code prefix ${prefix} is already used (${used.code}). Choose another code prefix.`, 409);
      product = await repo.one(db, "INSERT INTO catalog_products(business_id,name,category_id,brand,kind) VALUES($1,$2,$3,$4,'goods') RETURNING *",
        [business.id, name, categoryId, c.optionalText(body.brand, 'Brand', 100)]);
      base = { unit: unit.code, tracking, taxRate: tax.rate, taxRateId: tax.taxRateId, reorderLevel: core.decimal(body.reorderLevel ?? 0, 'Reorder level', 3),
        hsn: hsnOf(body.hsnCode), mrp, price: core.decimal(body.price, 'Price'), prefix };
      created = await insertPowers(db, business, product, base, powers, { baseCurve, diameter });
    }
    await repo.audit(db, business.id, user.id, 'catalog.lens_powers_created', product.id, { product: product.name, powers: created.length,
      from: powerText(Math.round(Number(created[0].attributes.power) * 100)), to: powerText(Math.round(Number(created.at(-1).attributes.power) * 100)), baseCurve, diameter });
    return { product, created: created.length, items: created.map((s) => ({ id: s.id, code: s.code, label: s.label, power: s.attributes.power })) };
  });
}

// An HSN code as typed: 4, 6 or 8 digits; empty is none.
function hsnOf(value) {
  if (!c.given(value)) return null;
  const text = String(value).replace(/\s/g, '');
  if (!/^\d{4}(\d{2}){0,2}$/.test(text)) fail('HSN code must be 4, 6 or 8 digits');
  return text;
}

async function insertPowers(db, business, product, base, powers, { baseCurve, diameter }) {
  const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  const created = [];
  for (const power of powers) {
    const label = `${product.name} · ${powerText(power)}`.slice(0, 150);
    core.checkMrp(label, base.price, base.taxRate, settings?.tax_mode || 'exclusive', base.mrp);
    let code = `${base.prefix}-${powerCode(power)}`;
    for (let n = 2; await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [business.id, code]); n += 1) code = `${base.prefix}-${powerCode(power)}-${n}`;
    if (code.length > 60) fail('The item codes would be longer than 60 characters: use a shorter code prefix');
    const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,label,unit,price,tax_rate,tax_rate_id,tracking,reorder_level,attributes,hsn_code,mrp)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [business.id, product.id, code, label, base.unit, Number(base.price).toFixed(2), base.taxRate, base.taxRateId, base.tracking, base.reorderLevel,
      JSON.stringify({ power: (power / 100).toFixed(2), baseCurve, diameter }), base.hsn, base.mrp ?? null]);
    created.push(sku);
  }
  return created;
}

module.exports = { grid, createGrid, readRanges };
