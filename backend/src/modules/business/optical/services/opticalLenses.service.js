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
// attributes). A toric lens's items are each power with each CYL and AXIS
// given, a multifocal's each power with each ADD, and a coloured lens's each
// power in each colour (these combine). How often the lens is replaced and
// how many lenses one unit holds go with every item too (the replacement
// reminders count them). More powers can be added to the product later; one
// it already has is left as it is. Stock comes in through purchases, by batch
// and expiry where batches are on; the stock view shows each power held.

const { fail } = c;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
// The most items one lens product may have, and the most one request makes.
const MAX_POWERS = 2400;
const MAX_NEW = 600;
const codePart = (text, length) => String(text).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length);
// -2.50 -> "-2.50", 1.25 -> "+1.25", 0 -> "0.00" (hundredths in, text out).
const powerText = (hundredths) => `${hundredths > 0 ? '+' : ''}${(hundredths / 100).toFixed(2)}`;
// -2.50 -> "M250", +1.25 -> "P125", 0 -> "000".
const powerCode = (hundredths) => (hundredths === 0 ? '000' : `${hundredths < 0 ? 'M' : 'P'}${String(Math.abs(hundredths)).padStart(3, '0')}`);
const hundredths = (text) => Math.round(Number(text) * 100);

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
    const low = Math.min(hundredths(from), hundredths(to));
    const high = Math.max(hundredths(from), hundredths(to));
    if ((high - low) % step !== 0) fail(`${name}: from ${powerText(low)} to ${powerText(high)} does not go in steps of ${(step / 100).toFixed(2)}`);
    for (let p = low; p <= high; p += step) powers.add(p);
  }
  return [...powers].sort((a, b) => a - b);
}
// A list of values given once each, read by `read`: a toric's cylinders and
// axes, a multifocal's ADDs, a coloured lens's colours. [] when none.
function readList(value, name, read, max) {
  if (value === undefined || value === null || value === '') return [];
  const list = v.requiredArray(value, name);
  if (list.length > max) fail(`${name}: at most ${max}`);
  const out = [];
  for (const item of list) {
    const read1 = read(item);
    if (read1 === null) continue;
    if (out.some((x) => String(x).toLowerCase() === String(read1).toLowerCase())) fail(`${name}: ${read1} is given twice`);
    out.push(read1);
  }
  return out;
}
// The variants of each power: [{ cyl, axis, add, colour }] (one with none of them for a plain spherical lens).
function readVariants(body) {
  const cylinders = readList(body.cylinders, 'Cylinders', (x) => {
    const cyl = c.readPower(x, 'Cylinder', { min: -10, max: 10 });
    if (cyl !== null && Number(cyl) === 0) fail('Cylinders: a CYL of 0.00 is not toric');
    return cyl;
  }, 12);
  const axes = readList(body.axes, 'Axes', (x) => c.readAxis(x, 'Axis'), 36);
  if ((cylinders.length > 0) !== (axes.length > 0)) fail('A toric lens has its cylinders and its axes: give both, or neither');
  const adds = readList(body.adds, 'ADDs', (x) => c.readPower(x, 'ADD', { min: 0.25, max: 4 }), 8);
  const colours = readList(body.colours, 'Colours', (x) => c.optionalText(x, 'Colour', 40), 12);
  const list = [];
  for (const cyl of cylinders.length ? cylinders : [null]) {
    for (const axis of axes.length ? axes : [null]) {
      for (const add of adds.length ? adds : [null]) {
        for (const colour of colours.length ? colours : [null]) list.push({ cyl, axis, add, colour });
      }
    }
  }
  return { list, toric: cylinders.length > 0, multifocal: adds.length > 0, coloured: colours.length > 0 };
}
// How often the lens is replaced, and how many lenses one unit holds.
function readWear(body) {
  const modality = v.optionalEnum(body.modality, 'Replaced', c.MODALITIES, null);
  let perPack = null;
  if (c.given(body.lensesPerPack)) {
    const text = String(body.lensesPerPack).trim();
    if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > 1000) fail('Lenses in one unit must be a whole number from 1 to 1000');
    perPack = text;
  }
  return { modality, perPack };
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

// One item's place in the grid, the same whichever way its details were written.
const keyOf = (a) => [hundredths(a.power), a.cyl ? hundredths(a.cyl) : '', a.axis ? Number(a.axis) : '', a.add ? hundredths(a.add) : '', String(a.colour || '').toLowerCase()].join('|');

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

// A lens product's powers in the grid's shape: lowest power first, then CYL, AXIS, ADD and colour.
function gridOf(product, powered) {
  const first = powered[0]?.attributes || {};
  const powers = powered.map((s) => ({ sku_id: s.id, code: s.code, label: s.label, power: s.attributes.power, cyl: s.attributes.cyl || null, axis: s.attributes.axis || null,
    add: s.attributes.add || null, colour: s.attributes.colour || null, price: s.price, active: s.active, stock: s.stock }))
    .sort((a, b) => Number(a.power) - Number(b.power) || Number(a.cyl || 0) - Number(b.cyl || 0) || Number(a.axis || 0) - Number(b.axis || 0)
      || Number(a.add || 0) - Number(b.add || 0) || String(a.colour || '').localeCompare(String(b.colour || '')));
  return { product, base_curve: first.baseCurve || null, diameter: first.diameter || null, modality: first.modality || null, lenses_per_pack: first.lensesPerPack || null,
    toric: powered.some((s) => s.attributes.cyl), multifocal: powered.some((s) => s.attributes.add), coloured: powered.some((s) => s.attributes.colour), powers };
}

// The powers a lens product has (the item form's power grid, adding more).
async function grid(business, productId, query = {}) {
  c.requireOptical(business);
  await access.require(business, 'catalog.view');
  requireVariants(business);
  const { product, powered } = await powersOf(repo.pool, business, id(productId, 'Product'), c.given(query.locationId) ? id(query.locationId, 'Location') : null);
  return gridOf(product, powered);
}

// The contact-lens products and the stock of each (at one location, or every
// location): the stock view's choices.
async function lensProducts(business, query = {}) {
  c.requireOptical(business);
  await access.require(business, 'inventory.view');
  const locationId = c.given(query.locationId) ? id(query.locationId, 'Location') : business.location_scope || null;
  if (locationId) access.requireLocation(business, locationId);
  return repo.all(repo.pool, `SELECT p.id,p.name,p.brand,p.active,count(s.id)::int AS items,min(s.attributes->>'baseCurve') AS base_curve,min(s.attributes->>'diameter') AS diameter,
      min(s.attributes->>'modality') AS modality,bool_or(s.attributes->>'cyl' IS NOT NULL) AS toric,bool_or(s.attributes->>'add' IS NOT NULL) AS multifocal,
      bool_or(s.attributes->>'colour' IS NOT NULL) AS coloured,COALESCE(sum(st.quantity),0) AS stock,count(*) FILTER (WHERE st.quantity > 0)::int AS powers_in_stock
    FROM catalog_products p JOIN catalog_skus s ON s.business_id=p.business_id AND s.product_id=p.id
    LEFT JOIN LATERAL (SELECT sum(l.quantity) AS quantity FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id AND ($2::bigint IS NULL OR l.location_id=$2)) st ON TRUE
    WHERE p.business_id=$1 AND s.attributes->>'baseCurve' IS NOT NULL GROUP BY p.id ORDER BY p.active DESC,p.name`, [business.id, locationId]);
}

// One lens product's stock, power by power (the stock view).
async function lensStock(business, productId, query = {}) {
  c.requireOptical(business);
  await access.require(business, 'inventory.view');
  const locationId = c.given(query.locationId) ? id(query.locationId, 'Location') : business.location_scope || null;
  if (locationId) access.requireLocation(business, locationId);
  const { product, powered } = await powersOf(repo.pool, business, id(productId, 'Product'), locationId);
  if (!powered.length) fail(`${product.name} is not a contact lens made by powers`, 404);
  return { ...gridOf(product, powered), location_id: locationId };
}

// A new lens product with its powers, or more powers for one made here before.
// body: { productId? | name, brand?, categoryId?, unit, tracking?, price, taxRateId? | taxRate, mrp?, hsnCode?, reorderLevel?,
//   codePrefix?, baseCurve, diameter, ranges: [{ from, to, step }], cylinders?, axes?, adds?, colours?, modality?, lensesPerPack? }
async function createGrid(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'catalog.create');
  requireVariants(business);
  const powers = readRanges(body.ranges);
  const variants = readVariants(body);
  if (powers.length * variants.list.length > MAX_NEW) fail(`Make at most ${MAX_NEW} items at a time (these come to ${powers.length * variants.list.length})`);
  const baseCurve = readMm(body.baseCurve, 'Base curve', 7, 10);
  const diameter = readMm(body.diameter, 'Diameter', 12, 16);
  const mrp = core.readMrp(body.mrp);
  const wear = readWear(body);
  return repo.transaction(async (db) => {
    let product, base, created = [];
    const wanted = powers.flatMap((power) => variants.list.map((variant) => ({ power, ...variant })));
    if (c.given(body.productId)) {
      product = await repo.one(db, 'SELECT * FROM catalog_products WHERE business_id=$1 AND id=$2 AND active FOR UPDATE', [business.id, id(body.productId, 'Product')]);
      if (!product) fail('Product not found', 404);
      const { skus, powered } = await powersOf(db, business, product.id);
      if (!powered.length) fail(`${product.name} has no lens powers yet: make its powers as a new lens product`, 409);
      const first = powered[0];
      if (first.attributes.baseCurve !== baseCurve || first.attributes.diameter !== diameter) {
        fail(`${product.name} has base curve ${first.attributes.baseCurve} and diameter ${first.attributes.diameter}: another base curve or diameter is another lens product`, 409);
      }
      // The same kind of lens: toric, multifocal and coloured as its items are.
      const shape = gridOf(product, powered);
      for (const [kind, words, given] of [['toric', 'a toric lens: give its cylinders and axes', variants.toric], ['multifocal', 'a multifocal lens: give its ADDs', variants.multifocal],
        ['coloured', 'a coloured lens: give its colours', variants.coloured]]) {
        if (shape[kind] && !given) fail(`${product.name} is ${words}`, 409);
        if (!shape[kind] && given) fail(`${product.name} is not ${words.split(':')[0].replace(/^an? /, 'a ')}: another kind of lens is another lens product`, 409);
      }
      await core.requireDepartmentItem(db, business, { categoryId: product.category_id });
      const price = c.given(body.price) ? core.decimal(body.price, 'Price') : Number(first.price);
      base = { unit: first.unit, tracking: first.tracking, taxRate: Number(first.tax_rate), taxRateId: first.tax_rate_id, reorderLevel: first.reorder_level,
        hsn: first.hsn_code, mrp: c.given(body.mrp) ? mrp : first.mrp, price, prefix: String(first.code).split('-')[0],
        modality: first.attributes.modality || null, perPack: first.attributes.lensesPerPack || null };
      const have = new Set(powered.map((s) => keyOf(s.attributes)));
      const fresh = wanted.filter((w) => !have.has(keyOf({ ...w, power: (w.power / 100).toFixed(2) })));
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
        hsn: hsnOf(body.hsnCode), mrp, price: core.decimal(body.price, 'Price'), prefix, modality: wear.modality, perPack: wear.perPack };
      created = await insertPowers(db, business, product, base, wanted, { baseCurve, diameter });
    }
    const first = created[0].attributes, last = created.at(-1).attributes;
    await repo.audit(db, business.id, user.id, 'catalog.lens_powers_created', product.id, { product: product.name, powers: created.length,
      from: powerText(hundredths(first.power)), to: powerText(hundredths(last.power)), baseCurve, diameter,
      ...(variants.toric ? { toric: true } : {}), ...(variants.multifocal ? { multifocal: true } : {}), ...(variants.coloured ? { coloured: true } : {}) });
    return { product, created: created.length, items: created.map((s) => ({ id: s.id, code: s.code, label: s.label, power: s.attributes.power, cyl: s.attributes.cyl || null,
      axis: s.attributes.axis || null, add: s.attributes.add || null, colour: s.attributes.colour || null })) };
  });
}

// An HSN code as typed: 4, 6 or 8 digits; empty is none.
function hsnOf(value) {
  if (!c.given(value)) return null;
  const text = String(value).replace(/\s/g, '');
  if (!/^\d{4}(\d{2}){0,2}$/.test(text)) fail('HSN code must be 4, 6 or 8 digits');
  return text;
}

// Each item: its label names the power and its variant ("Air Optix · -2.50 / -0.75 × 180 · ADD +1.50 · Blue"),
// its code the prefix and the same (AO6-M250-C075X180-A150-BLU).
async function insertPowers(db, business, product, base, wanted, { baseCurve, diameter }) {
  const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  const created = [];
  for (const w of wanted) {
    const words = [powerText(w.power), w.cyl ? `/ ${powerText(hundredths(w.cyl))} × ${w.axis}` : null].filter(Boolean).join(' ');
    const label = [`${product.name} · ${words}`, w.add ? `ADD ${powerText(hundredths(w.add))}` : null, w.colour].filter(Boolean).join(' · ').slice(0, 150);
    core.checkMrp(label, base.price, base.taxRate, settings?.tax_mode || 'exclusive', base.mrp);
    const stem = [base.prefix, powerCode(w.power), w.cyl ? `C${String(Math.abs(hundredths(w.cyl))).padStart(3, '0')}X${String(w.axis).padStart(3, '0')}` : null,
      w.add ? `A${String(hundredths(w.add)).padStart(3, '0')}` : null, w.colour ? codePart(w.colour, 3) || null : null].filter(Boolean).join('-');
    let code = stem;
    for (let n = 2; await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [business.id, code]); n += 1) code = `${stem}-${n}`;
    if (code.length > 60) fail('The item codes would be longer than 60 characters: use a shorter code prefix');
    const attributes = { power: (w.power / 100).toFixed(2), baseCurve, diameter, ...(w.cyl ? { cyl: w.cyl, axis: String(w.axis) } : {}), ...(w.add ? { add: w.add } : {}),
      ...(w.colour ? { colour: w.colour } : {}), ...(base.modality ? { modality: base.modality } : {}), ...(base.perPack ? { lensesPerPack: base.perPack } : {}) };
    const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,label,unit,price,tax_rate,tax_rate_id,tracking,reorder_level,attributes,hsn_code,mrp)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [business.id, product.id, code, label, base.unit, Number(base.price).toFixed(2), base.taxRate, base.taxRateId, base.tracking, base.reorderLevel,
      JSON.stringify(attributes), base.hsn, base.mrp ?? null]);
    created.push(sku);
  }
  return created;
}

module.exports = { grid, createGrid, readRanges, lensProducts, lensStock };
