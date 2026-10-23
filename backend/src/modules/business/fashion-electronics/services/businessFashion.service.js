const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');

// Fashion (garments & textiles): the size × colour (× fabric) matrix.
//
// One product (a style: "Oxford cotton shirt") has one SKU per variant, each
// with its own code, barcode, price and stock — ordinary core SKUs, so the
// counter, purchases, transfers, counts and returns all work at variant
// level. fashion_variants keeps each SKU's size, colour and fabric as typed
// columns for the matrix and the reports by size and colour.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const MAX_VARIANTS = 300;

function requireVariants(business) {
  if (!business.modules.includes('variants')) fail('Variants are not switched on for this business. An owner can turn them on in Settings › Business tools.', 403);
}

// EAN-13 check digit; in-store barcodes are "200" + the SKU number (the same
// scheme as the retail barcode labels, so the two never collide).
function eanCheck(twelve) {
  const total = [...twelve].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0);
  return String((10 - (total % 10)) % 10);
}
const inStoreBarcode = (skuId) => {
  const twelve = `200${String(skuId).padStart(9, '0')}`;
  if (twelve.length !== 12) fail('This item number is too long for an in-store barcode; type a barcode instead', 409);
  return twelve + eanCheck(twelve);
};

// A list of sizes, colours or fabrics: trimmed, no repeats (case-insensitive).
function axis(list, name, { required, max, length }) {
  if (list === undefined || list === null || (Array.isArray(list) && !list.length && !required)) {
    if (required) fail(`Add at least one ${name.toLowerCase()}`);
    return [];
  }
  const values = v.requiredArray(list, name).map((value) => v.requiredString(typeof value === 'number' ? String(value) : value, name, length));
  const seen = new Set();
  const unique = values.filter((value) => (seen.has(value.toLowerCase()) ? false : seen.add(value.toLowerCase())));
  if (required && !unique.length) fail(`Add at least one ${name.toLowerCase()}`);
  if (unique.length > max) fail(`Add at most ${max} ${name.toLowerCase()}s`);
  return unique;
}
const codePart = (text, length) => text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length) || 'X';
const comboKey = (color, size, fabric = '') => `${color}|${size}|${fabric}`.toLowerCase();

// Prices per size ("XXL costs ₹100 more"): { "XXL": "1099" }.
function sizePrices(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('Size prices must be an object of size to price');
  return Object.fromEntries(Object.entries(value).filter(([, price]) => price !== '' && price !== null && price !== undefined)
    .map(([size, price]) => [size.trim().toLowerCase(), core.decimal(price, `Price for size ${size}`)]));
}
function barcodeMap(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('Barcodes must be an object of variant to barcode');
  return Object.fromEntries(Object.entries(value).filter(([, code]) => code).map(([key, code]) => {
    const text = v.requiredString(String(code), 'Barcode', 80);
    if (!/^[0-9A-Za-z-]{4,80}$/.test(text)) fail(`Barcode ${text.slice(0, 20)} may only hold letters, digits and hyphens`);
    return [key.toLowerCase(), text];
  }));
}

// Typed code parts for colours: { "Blush": "BLH" }.
function codeMap(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('Colour codes must be an object of colour to code');
  return Object.fromEntries(Object.entries(value).filter(([, code]) => code).map(([color, code]) => [color.trim().toLowerCase(), v.requiredString(String(code), 'Colour code', 10)]));
}

// Inserts the missing combinations of one product inside the caller's
// transaction. `base` is the SKU settings every new variant takes.
async function insertVariants(db, business, product, { sizes, colors, fabrics, priceFor, prefix, base, barcodes, existing, existingVariants = [], colorCodes = {} }) {
  const combos = [];
  for (const color of colors) for (const size of sizes) for (const fabric of (fabrics.length ? fabrics : [''])) {
    if (!existing.has(comboKey(color, size, fabric))) combos.push({ color, size, fabric });
  }
  if (!combos.length) fail('Every one of these sizes and colours already exists for this product', 409);
  if (existing.size + combos.length > MAX_VARIANTS) fail(`A product can have at most ${MAX_VARIANTS} variants`);
  // Codes: PREFIX-COL-SIZE[-FAB]. Each colour (and fabric) gets one code part
  // for the whole product: the part its existing variants already use, a typed
  // one (colorCodes), or the shortest of its letters (3, 4 … 10) that no other
  // colour of this product uses and that makes no code already taken in the
  // business ("Blue" BLU, then "Blush" BLUS). Worked out in matrix order, so
  // the same request always gives the same codes; a last clash gets -2, -3….
  // The prefix is letters and digits only (codePart), so it needs no LIKE escaping.
  const like = `${prefix}-%`;
  const taken = new Set((await repo.all(db, 'SELECT code FROM catalog_skus WHERE business_id=$1 AND code LIKE $2', [business.id, like])).map((r) => r.code));
  const partsOf = (axisName, segment) => {
    const parts = new Map();
    for (const v of existingVariants) {
      const value = v[axisName];
      const bits = String(v.code || '').split('-');
      if (value && bits[0] === prefix && bits[segment] && !parts.has(value.toLowerCase())) parts.set(value.toLowerCase(), bits[segment]);
    }
    return parts;
  };
  const colorParts = partsOf('color', 1), fabricParts = partsOf('fabric', 3);
  const pick = (parts, value, typed, sizesFor) => {
    if (parts.has(value.toLowerCase())) return parts.get(value.toLowerCase());
    const used = new Set(parts.values());
    const typedPart = typed ? codePart(String(typed), 10) : null;
    if (typedPart) {
      if (used.has(typedPart)) fail(`Code ${typedPart} is already used by another colour or fabric of this product`, 409);
      parts.set(value.toLowerCase(), typedPart);
      return typedPart;
    }
    for (let length = 3; length <= 10; length += 1) {
      const part = codePart(value, length);
      if (!used.has(part) && !sizesFor(part).some((c) => taken.has(c))) { parts.set(value.toLowerCase(), part); return part; }
    }
    const base = codePart(value, 10);
    for (let n = 2; n < 100; n += 1) {
      const part = `${base}${n}`;
      if (!used.has(part) && !sizesFor(part).some((c) => taken.has(c))) { parts.set(value.toLowerCase(), part); return part; }
    }
    return fail(`No free SKU code for ${value}; type a code for it`, 409);
  };
  const join = (colorPart, size, fabricPart) => [prefix, colorPart, codePart(size, 6), ...(fabricPart ? [fabricPart] : [])].join('-');
  for (const fabric of fabrics) pick(fabricParts, fabric, null, () => []);
  for (const color of colors) {
    pick(colorParts, color, colorCodes[color.toLowerCase()],
      (part) => combos.filter((c) => c.color === color).map((c) => join(part, c.size, c.fabric ? fabricParts.get(c.fabric.toLowerCase()) : '')));
  }
  const codes = combos.map((c) => {
    let candidate = join(colorParts.get(c.color.toLowerCase()), c.size, c.fabric ? fabricParts.get(c.fabric.toLowerCase()) : '');
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${join(colorParts.get(c.color.toLowerCase()), c.size, c.fabric ? fabricParts.get(c.fabric.toLowerCase()) : '')}-${n}`;
    taken.add(candidate);
    return candidate;
  });
  if (codes.some((c) => c.length > 60)) fail('The SKU codes would be longer than 60 characters; use a shorter code prefix');
  const typedBarcodes = combos.map((c) => barcodes[comboKey(c.color, c.size, c.fabric)]).filter(Boolean);
  if (new Set(typedBarcodes).size !== typedBarcodes.length) fail('The same barcode was typed for two variants');
  if (typedBarcodes.length) {
    const used = await repo.one(db, 'SELECT barcode FROM catalog_skus WHERE business_id=$1 AND barcode=ANY($2::text[]) LIMIT 1', [business.id, typedBarcodes]);
    if (used) fail(`Barcode ${used.barcode} is already on another item`, 409);
  }
  const created = [];
  for (const [index, combo] of combos.entries()) {
    const label = `${product.name} · ${combo.color} / ${combo.size}${combo.fabric ? ` / ${combo.fabric}` : ''}`.slice(0, 150);
    const attributes = { size: combo.size, color: combo.color, ...(combo.fabric ? { fabric: combo.fabric } : {}) };
    const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,barcode,label,unit,price,tax_rate,tax_rate_id,tracking,reorder_level,attributes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [business.id, product.id, codes[index], barcodes[comboKey(combo.color, combo.size, combo.fabric)] || null, label, base.unit,
      priceFor(combo.size).toFixed(2), base.taxRate, base.taxRateId, base.tracking, base.reorderLevel, JSON.stringify(attributes)]);
    // No barcode typed: give it an in-store EAN-13 so it scans at the counter.
    if (!sku.barcode) {
      sku.barcode = inStoreBarcode(sku.id);
      await db.query('UPDATE catalog_skus SET barcode=$3 WHERE business_id=$1 AND id=$2', [business.id, sku.id, sku.barcode]);
    }
    await db.query('INSERT INTO fashion_variants(business_id,sku_id,product_id,size,color,fabric) VALUES($1,$2,$3,$4,$5,$6)',
      [business.id, sku.id, product.id, combo.size, combo.color, combo.fabric]);
    created.push(sku);
  }
  return created;
}

async function readTaxSlab(db, business, body) {
  if (body.taxRateId !== undefined && body.taxRateId !== null && body.taxRateId !== '') {
    const slab = await repo.one(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.taxRateId, 'GST slab')]);
    if (!slab) fail('GST slab not found', 404);
    return { taxRateId: slab.id, taxRate: slab.rate };
  }
  const rate = core.decimal(body.taxRate ?? 0, 'GST rate', 2, 0, 100);
  const slab = await repo.one(db, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=$2 AND active ORDER BY is_default DESC,id LIMIT 1', [business.id, rate]);
  return { taxRateId: slab?.id || null, taxRate: rate.toFixed(2) };
}

// A new product with its whole matrix, all or nothing.
async function createProduct(business, user, body) {
  await access.require(business, 'catalog.create');
  requireVariants(business);
  if (!business.capabilities.includes('inventory')) fail('This business has no goods inventory capability');
  const name = v.requiredString(body.name, 'Product name', 120);
  const sizes = axis(body.sizes, 'Size', { required: true, max: 30, length: 20 });
  const colors = axis(body.colors, 'Colour', { required: true, max: 30, length: 40 });
  const fabrics = axis(body.fabrics, 'Fabric', { required: false, max: 10, length: 40 });
  const price = core.decimal(body.price, 'Price');
  const perSize = sizePrices(body.sizePrices);
  const barcodes = barcodeMap(body.barcodes);
  const tracking = v.optionalEnum(body.tracking, 'Stock tracking', ['quantity', 'batch', 'serial'], 'quantity');
  if (tracking === 'batch' && !business.capabilities.includes('batches')) fail('Batch tracking is not enabled');
  if (tracking === 'serial' && !business.capabilities.includes('serials')) fail('Serial tracking is not enabled');
  const prefix = codePart(v.optionalString(body.codePrefix, 'Code prefix', 20) || name.split(/\s+/).map((w) => w[0]).join('').slice(0, 4) || name, 20);
  const reorderLevel = core.decimal(body.reorderLevel ?? 0, 'Reorder level', 3);
  return repo.transaction(async (db) => {
    const unit = await core.readUnit(db, business.id, body.unit || 'each');
    if (['time', 'service'].includes(unit.kind)) fail('Variants are goods: choose a stock unit');
    if (tracking === 'serial' && unit.kind !== 'count') fail('Serialized items must be counted in whole units');
    const tax = await readTaxSlab(db, business, body);
    let categoryId = null;
    if (body.categoryId !== undefined && body.categoryId !== null && body.categoryId !== '') {
      const category = await repo.one(db, 'SELECT id FROM catalog_categories WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.categoryId, 'Category')]);
      if (!category) fail('Category not found', 404);
      categoryId = category.id;
    }
    // A new product needs its own prefix: codes of two products never mix.
    const used = await repo.one(db, 'SELECT code FROM catalog_skus WHERE business_id=$1 AND (code=$2 OR code LIKE $3) LIMIT 1', [business.id, prefix, `${prefix}-%`]);
    if (used) fail(`Code prefix ${prefix} is already used (${used.code}). Choose another code prefix.`, 409);
    const product = await repo.one(db, 'INSERT INTO catalog_products(business_id,name,category_id,brand,kind) VALUES($1,$2,$3,$4,\'goods\') RETURNING *',
      [business.id, name, categoryId, v.optionalString(body.brand, 'Brand', 100)]);
    const created = await insertVariants(db, business, product, {
      sizes, colors, fabrics, prefix, barcodes, existing: new Set(), colorCodes: codeMap(body.colorCodes),
      priceFor: (size) => perSize[size.toLowerCase()] ?? price,
      base: { unit: unit.code, taxRate: tax.taxRate, taxRateId: tax.taxRateId, tracking, reorderLevel },
    });
    await repo.audit(db, business.id, user.id, 'catalog.variants_created', product.id, { product: name, variants: created.length, sizes, colors, fabrics });
    return { product, created: created.length };
  });
}

// More sizes, colours or fabrics for a product: the missing combinations of
// (existing ∪ new sizes) × (existing ∪ new colours) × fabrics are created.
async function addVariants(business, user, productId, body) {
  await access.require(business, 'catalog.create');
  requireVariants(business);
  const newSizes = axis(body.sizes, 'Size', { required: false, max: 30, length: 20 });
  const newColors = axis(body.colors, 'Colour', { required: false, max: 30, length: 40 });
  const newFabrics = axis(body.fabrics, 'Fabric', { required: false, max: 10, length: 40 });
  if (!newSizes.length && !newColors.length && !newFabrics.length) fail('Add a size, a colour or a fabric');
  const price = body.price === undefined || body.price === null || body.price === '' ? null : core.decimal(body.price, 'Price');
  const perSize = sizePrices(body.sizePrices);
  const barcodes = barcodeMap(body.barcodes);
  const typedPrefix = body.codePrefix ? codePart(v.requiredString(body.codePrefix, 'Code prefix', 20), 20) : null;
  const colorCodes = codeMap(body.colorCodes);
  return repo.transaction(async (db) => {
    const product = await repo.one(db, 'SELECT * FROM catalog_products WHERE business_id=$1 AND id=$2 AND active FOR UPDATE', [business.id, id(productId, 'Product')]);
    if (!product) fail('Product not found', 404);
    const variants = await repo.all(db, `SELECT v.*,s.price,s.unit,s.tax_rate,s.tax_rate_id,s.tracking,s.reorder_level,s.code FROM fashion_variants v
      JOIN catalog_skus s ON s.business_id=v.business_id AND s.id=v.sku_id WHERE v.business_id=$1 AND v.product_id=$2 ORDER BY v.size_rank,v.sku_id`, [business.id, product.id]);
    if (!variants.length) fail('This product has no size × colour variants yet', 409);
    const merge = (old, extra) => {
      const all = [...old];
      for (const value of extra) if (!all.some((o) => o.toLowerCase() === value.toLowerCase())) all.push(value);
      return all;
    };
    const unique = (values) => [...new Map(values.map((x) => [x.toLowerCase(), x])).values()];
    const sizes = merge(unique(variants.map((x) => x.size)), newSizes);
    const colors = merge(unique(variants.map((x) => x.color)), newColors);
    const oldFabrics = unique(variants.map((x) => x.fabric).filter(Boolean));
    if (newFabrics.length && !oldFabrics.length) fail('This product has no fabric axis; add the fabrics as a new product instead');
    const fabrics = merge(oldFabrics, newFabrics);
    const sample = variants[0];
    // A new variant takes the price of its size where one exists.
    const priceFor = (size) => {
      const typed = perSize[size.toLowerCase()];
      if (typed !== undefined) return typed;
      const sameSize = variants.find((x) => x.size.toLowerCase() === size.toLowerCase());
      if (sameSize) return Number(sameSize.price);
      if (price === null) fail(`Give a price for the new size ${size}`);
      return price;
    };
    const prefix = typedPrefix || sample.code.split('-')[0];
    const created = await insertVariants(db, business, product, {
      sizes, colors, fabrics, priceFor, prefix, barcodes, existingVariants: variants, colorCodes,
      existing: new Set(variants.map((x) => comboKey(x.color, x.size, x.fabric))),
      base: { unit: sample.unit, taxRate: sample.tax_rate, taxRateId: sample.tax_rate_id, tracking: sample.tracking, reorderLevel: sample.reorder_level },
    });
    await repo.audit(db, business.id, user.id, 'catalog.variants_added', product.id, { variants: created.length, sizes: newSizes, colors: newColors, fabrics: newFabrics });
    return { product, created: created.length };
  });
}

// One price for every variant of a size and/or colour (or all of them).
async function setPrices(business, user, productId, body) {
  await access.require(business, 'catalog.edit');
  requireVariants(business);
  const price = core.decimal(body.price, 'Price');
  const sizes = axis(body.sizes, 'Size', { required: false, max: 30, length: 20 }).map((s) => s.toLowerCase());
  const colors = axis(body.colors, 'Colour', { required: false, max: 30, length: 40 }).map((c) => c.toLowerCase());
  return repo.transaction(async (db) => {
    const rows = await repo.all(db, `UPDATE catalog_skus s SET price=$3 FROM fashion_variants v
      WHERE v.business_id=s.business_id AND v.sku_id=s.id AND s.business_id=$1 AND v.product_id=$2
        AND (cardinality($4::text[])=0 OR lower(v.size)=ANY($4::text[])) AND (cardinality($5::text[])=0 OR lower(v.color)=ANY($5::text[]))
      RETURNING s.id`, [business.id, id(productId, 'Product'), price.toFixed(2), sizes, colors]);
    if (!rows.length) fail('No variants of this product match those sizes and colours', 404);
    await repo.audit(db, business.id, user.id, 'catalog.variant_prices_set', id(productId, 'Product'), { price, sizes, colors, variants: rows.length });
    return { updated: rows.length };
  });
}

// The matrix of one product: sizes across, colours (× fabric) down, each
// cell the SKU with its code, barcode, price and stock (at one location or all).
async function matrix(business, productId, query = {}) {
  await access.require(business, 'catalog.view');
  requireVariants(business);
  const locationId = query.locationId ? id(query.locationId, 'Location') : null;
  const product = await repo.one(repo.pool, `SELECT p.*,COALESCE(c.name,p.category) AS category_name FROM catalog_products p
    LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id WHERE p.business_id=$1 AND p.id=$2`, [business.id, id(productId, 'Product')]);
  if (!product) fail('Product not found', 404);
  const variants = await repo.all(repo.pool, `SELECT v.size,v.color,v.fabric,v.size_rank,s.id AS sku_id,s.code,s.barcode,s.label,s.price,s.mrp,s.active,s.unit,s.tracking,s.reorder_level,s.tax_rate,
      COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id AND ($3::bigint IS NULL OR l.location_id=$3)),0) AS stock,
      COALESCE((SELECT json_object_agg(l.location_id, l.quantity) FROM (SELECT location_id,sum(quantity) AS quantity FROM business_stock_lots
        WHERE business_id=s.business_id AND sku_id=s.id GROUP BY location_id HAVING sum(quantity)>0) l),'{}') AS stock_by_location
    FROM fashion_variants v JOIN catalog_skus s ON s.business_id=v.business_id AND s.id=v.sku_id
    WHERE v.business_id=$1 AND v.product_id=$2 ORDER BY v.size_rank,lower(v.size),v.sku_id`, [business.id, product.id, locationId]);
  const unique = (values) => [...new Map(values.map((x) => [x.toLowerCase(), x])).values()];
  return {
    product,
    sizes: unique(variants.map((x) => x.size)),
    colors: unique([...variants].sort((a, b) => a.sku_id - b.sku_id).map((x) => x.color)),
    fabrics: unique(variants.map((x) => x.fabric).filter(Boolean)),
    variants,
  };
}

// --- Reports -------------------------------------------------------------------

function period(query) {
  const from = core.dateText(query.from, 'Report start date'), to = core.dateText(query.to, 'Report end date');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  return { from, to };
}

// Variant-level sales and stock: what sold (less what came back) in the
// period, and what is on the shelf now, per size × colour, with totals by
// size and by colour. Net sales are before GST.
async function variantReport(business, query) {
  await access.require(business, 'reports.view');
  requireVariants(business);
  const { from, to } = period(query);
  const productId = query.productId ? id(query.productId, 'Product') : null;
  const locationId = query.locationId ? id(query.locationId, 'Location') : null;
  const rows = await repo.all(repo.pool, `WITH sold AS (
      SELECT l.sku_id,sum(l.quantity) AS qty,sum(l.net) AS net FROM business_document_lines l
      JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id
      WHERE d.business_id=$1 AND d.kind='sale' AND (d.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ($6::bigint IS NULL OR d.location_id=$6)
      GROUP BY l.sku_id),
    returned AS (
      SELECT dl.sku_id,sum(rl.quantity) AS qty,sum(rl.net) AS net FROM business_return_lines rl
      JOIN business_returns r ON r.business_id=rl.business_id AND r.id=rl.return_id
      JOIN business_document_lines dl ON dl.business_id=rl.business_id AND dl.id=rl.line_id
      JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
      WHERE r.business_id=$1 AND d.kind='sale' AND (r.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ($6::bigint IS NULL OR d.location_id=$6)
      GROUP BY dl.sku_id),
    stock AS (
      SELECT sku_id,sum(quantity) AS qty,sum(quantity*unit_cost) AS value FROM business_stock_lots
      WHERE business_id=$1 AND ($6::bigint IS NULL OR location_id=$6) GROUP BY sku_id)
    SELECT v.sku_id,s.code,s.barcode,s.label,s.price,s.active,p.id AS product_id,p.name AS product_name,p.brand,COALESCE(c.name,p.category) AS category,
      v.size,v.color,v.fabric,v.size_rank,
      COALESCE(sold.qty,0) AS sold_qty,COALESCE(sold.net,0) AS sold_net,COALESCE(returned.qty,0) AS returned_qty,COALESCE(returned.net,0) AS returned_net,
      COALESCE(stock.qty,0) AS stock_qty,COALESCE(stock.value,0)::numeric(16,2) AS stock_value
    FROM fashion_variants v
    JOIN catalog_skus s ON s.business_id=v.business_id AND s.id=v.sku_id
    JOIN catalog_products p ON p.business_id=v.business_id AND p.id=v.product_id
    LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
    LEFT JOIN sold ON sold.sku_id=v.sku_id LEFT JOIN returned ON returned.sku_id=v.sku_id LEFT JOIN stock ON stock.sku_id=v.sku_id
    WHERE v.business_id=$1 AND ($5::bigint IS NULL OR v.product_id=$5)
    ORDER BY p.name,p.id,lower(v.color),v.size_rank,lower(v.size) LIMIT 5001`, [business.id, from, to, business.timezone, productId, locationId]);
  const truncated = rows.length > 5000;
  const items = rows.slice(0, 5000).map((r) => {
    const netQty = Math.round(Number(r.sold_qty) * 1000) - Math.round(Number(r.returned_qty) * 1000);
    const stockQty = Math.round(Number(r.stock_qty) * 1000);
    return { ...r, net_qty: (netQty / 1000).toFixed(3), net_sales: ((paise(r.sold_net) - paise(r.returned_net)) / 100).toFixed(2),
      sell_through: netQty + stockQty > 0 ? Math.round((Math.max(netQty, 0) / (Math.max(netQty, 0) + stockQty)) * 1000) / 10 : null };
  });
  // Totals by size and by colour, worked out in paise and thousandths.
  const group = (keyOf, labelOf, rankOf) => {
    const map = new Map();
    for (const r of items) {
      const key = keyOf(r);
      const g = map.get(key) || { key: labelOf(r), rank: rankOf(r), net_qty: 0, net_sales: 0, stock_qty: 0, stock_value: 0, variants: 0 };
      g.net_qty += Math.round(Number(r.net_qty) * 1000); g.net_sales += paise(r.net_sales);
      g.stock_qty += Math.round(Number(r.stock_qty) * 1000); g.stock_value += paise(r.stock_value); g.variants += 1;
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => a.rank - b.rank || String(a.key).localeCompare(String(b.key)))
      .map((g) => ({ ...g, net_qty: (g.net_qty / 1000).toFixed(3), net_sales: (g.net_sales / 100).toFixed(2), stock_qty: (g.stock_qty / 1000).toFixed(3), stock_value: (g.stock_value / 100).toFixed(2) }));
  };
  return {
    from, to, truncated, items,
    bySize: group((r) => r.size.toLowerCase(), (r) => r.size, (r) => r.size_rank),
    byColor: group((r) => r.color.toLowerCase(), (r) => r.color, () => 0),
  };
}

// The products that have a matrix, for the list screen (core list registry).
const lists = {
  'fashion-products': { sql: `SELECT p.id,p.name,p.brand,p.active,p.created_at,p.category_id,COALESCE(cat.name,p.category) AS category,
      count(v.sku_id)::int AS variant_count,
      (SELECT json_agg(x.size ORDER BY x.rank,x.size) FROM (SELECT DISTINCT ON (lower(size)) size,size_rank AS rank FROM fashion_variants
        WHERE business_id=p.business_id AND product_id=p.id ORDER BY lower(size),size_rank) x) AS sizes,
      (SELECT json_agg(x.color ORDER BY x.first) FROM (SELECT DISTINCT ON (lower(color)) color,sku_id AS first FROM fashion_variants
        WHERE business_id=p.business_id AND product_id=p.id ORDER BY lower(color),sku_id) x) AS colors,
      min(s.price) AS min_price,max(s.price) AS max_price,
      COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l JOIN fashion_variants fv ON fv.business_id=l.business_id AND fv.sku_id=l.sku_id
        WHERE fv.business_id=p.business_id AND fv.product_id=p.id),0) AS stock
    FROM catalog_products p
    JOIN fashion_variants v ON v.business_id=p.business_id AND v.product_id=p.id
    JOIN catalog_skus s ON s.business_id=v.business_id AND s.id=v.sku_id
    LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
    WHERE p.business_id=$1 GROUP BY p.id,cat.name`,
  search: ['name', 'brand', 'category'], filters: { category: 'category_id', active: 'active' }, order: 'name,id' },
};

module.exports = { createProduct, addVariants, setPrices, matrix, variantReport, requireVariants, lists };
