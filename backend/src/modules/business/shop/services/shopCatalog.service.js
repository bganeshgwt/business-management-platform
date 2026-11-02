const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const { neverOnlineSql, NEVER_ONLINE } = require('./shopRules');
const money = require('./shopMoney');

// What a shop shows online, and at what price (BUSINESS_RULES.md, the online
// shop: what shows online, prices).
//
// An item shows at the link's location when it is active goods with a price,
// neither it nor its category (or a parent) is hidden online, no rule keeps
// it off (shopRules.js), and, with "Hide items out of stock" on, it has
// usable stock there (unexpired lots). Its price is the walk-in price at that
// location (its branch price, else its list price), GST included, never above
// its MRP; there are no member prices, offers or coupons online. Nothing is
// reserved: stock is what is on the shelf when the guest looks, and the cart
// is checked again when they order.
//
// Guests (by the link): shopPage, items, item, priceLines.
// Staff: staffItems, itemDetails, saveItem, setCategory.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const PAGE = 24;
// The most of one item on a line: what is on the shelf, and at most 99 (25 kg or litres, 100 metres loose).
const MAX_COUNT = 99;
const MAX_LOOSE = { weight: 25, volume: 25, length: 100 };
// Loose goods are ordered in steps: a quarter kilo, half a litre, half a metre.
const STEP = { kg: 0.25, g: 250, litre: 0.5, ml: 250, metre: 0.5 };
const LOOSE = ['weight', 'volume', 'length'];

// The categories with their path as text and whether they (or a parent) are hidden online.
const TREE_SQL = `tree AS (
  SELECT c.id,c.parent_id,c.name::text AS words,(h.category_id IS NOT NULL) AS hidden FROM catalog_categories c
    LEFT JOIN shop_hidden_categories h ON h.business_id=c.business_id AND h.category_id=c.id WHERE c.business_id=$1 AND c.parent_id IS NULL
  UNION ALL
  SELECT c.id,c.parent_id,tree.words||' '||c.name,tree.hidden OR (h.category_id IS NOT NULL) FROM catalog_categories c JOIN tree ON c.parent_id=tree.id
    LEFT JOIN shop_hidden_categories h ON h.business_id=c.business_id AND h.category_id=c.id WHERE c.business_id=$1)`;

// Every item of the business with what the shop needs to show it at a
// location ($1 business, $2 location, $3 the business's today).
const ROWS_SQL = `WITH RECURSIVE ${TREE_SQL},
  rows AS (SELECT s.id AS sku_id,s.product_id,s.label,s.code,s.unit,s.price AS list_price,COALESCE(bp.price,s.price) AS price,s.mrp,s.tax_rate,s.hsn_code,
      s.tracking,s.attributes,s.shelf_location,p.name AS product_name,p.brand,p.kind,p.category_id,COALESCE(cat.name,p.category) AS category_name,
      u.kind AS unit_kind,u.name AS unit_name,u.decimals AS unit_decimals,
      COALESCE(d.hidden,FALSE) AS item_hidden,COALESCE(tree.hidden,FALSE) AS category_hidden,
      d.photo_path,d.thumb_path,d.description,d.maker_kind,d.maker_name,d.maker_address,d.country_of_origin,d.generic_name,d.net_quantity,d.consumer_care,d.best_before,
      ${neverOnlineSql({ sku: 's', product: 'p', words: 'tree.words' })} AS never,
      COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id AND l.location_id=$2
        AND (l.expires_on IS NULL OR l.expires_on>=$3::date)),0) AS stock
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
    LEFT JOIN tree ON tree.id=p.category_id
    LEFT JOIN shop_item_details d ON d.business_id=p.business_id AND d.product_id=p.id
    LEFT JOIN business_sku_location_prices bp ON bp.business_id=s.business_id AND bp.sku_id=s.id AND bp.location_id=$2
    WHERE s.business_id=$1 AND s.active AND p.active)`;

// Shown to guests (the stock rule is the link's own: $4 hide out of stock).
const SHOWN = 'never IS NULL AND NOT item_hidden AND NOT category_hidden AND price>0 AND (NOT $4::boolean OR stock>0)';

const today = async (db, timezone) => (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [timezone || 'Asia/Kolkata'])).day;

// A search's words: each must be found in the item's names, brand, category or generic name.
function searchWords(q) {
  const text = typeof q === 'string' ? q.trim().slice(0, 80) : '';
  return text ? text.split(/\s+/).filter(Boolean).slice(0, 5).map((word) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : [];
}

const loose = (row) => LOOSE.includes(row.unit_kind);
const stepOf = (row) => (loose(row) ? STEP[row.unit] || (row.unit_decimals > 0 ? 0.5 : 1) : 1);
const maxOf = (row) => {
  const stock = Number(row.stock);
  const cap = loose(row) ? (MAX_LOOSE[row.unit_kind] || 25) * (['g', 'ml'].includes(row.unit) ? 1000 : 1) : MAX_COUNT;
  return Math.max(0, Math.min(cap, loose(row) ? Math.floor(stock / stepOf(row)) * stepOf(row) : Math.floor(stock)));
};
const qty = (value) => Number(Number(value).toFixed(3));

// The photo's addresses, served from the public uploads (product pictures, not personal data).
const photoOf = (row) => (row.photo_path ? { large: row.photo_path, small: row.thumb_path || row.photo_path } : null);

// One item (a SKU) as the guest sees it.
function variantOf(row, link) {
  const pricePaise = money.shelfPaise(row.price, row.tax_rate, link.tax_mode, row.mrp);
  const mrpPaise = row.mrp ? money.paise(row.mrp) : null;
  const stock = Number(row.stock);
  const low = Number(link.low_stock_below);
  const state = stock <= 0 ? 'out' : low > 0 && stock < low ? 'low' : 'in';
  const net = money.readNetQuantity(row.net_quantity) || (loose(row) ? null : money.readNetQuantity(row.label));
  const perUnit = loose(row) ? null : money.unitSalePrice(pricePaise, net);
  const attributes = row.attributes || {};
  return {
    skuId: Number(row.sku_id),
    label: row.label,
    size: attributes.size || null,
    colour: attributes.color || null,
    unit: row.unit,
    unitName: row.unit_name,
    weighed: loose(row),
    step: stepOf(row),
    max: maxOf(row),
    price: pricePaise / 100,
    mrp: mrpPaise && mrpPaise > pricePaise ? mrpPaise / 100 : null,
    stock: state,
    left: state === 'low' ? qty(stock) : null,
    unitSalePrice: perUnit ? { amount: perUnit.amount / 100, per: perUnit.per } : null,
    netQuantity: row.net_quantity || null,
  };
}

// Products as cards: each with its variants that show, the cheapest first.
function cardsOf(rows, link) {
  const cards = new Map();
  for (const row of rows) {
    const id = Number(row.product_id);
    if (!cards.has(id)) {
      cards.set(id, { productId: id, name: row.product_name, brand: row.brand || null, category: row.category_name || null, photo: photoOf(row),
        countryOfOrigin: row.country_of_origin || null, variants: [] });
    }
    cards.get(id).variants.push(variantOf(row, link));
  }
  return [...cards.values()].map((card) => {
    const prices = card.variants.map((variant) => variant.price);
    card.variants.sort((a, b) => a.price - b.price || a.label.localeCompare(b.label));
    return { ...card, fromPrice: Math.min(...prices), samePrice: prices.every((price) => price === prices[0]) };
  });
}

const SORTS = {
  name: 'name,product_id',
  price_low: 'low,name,product_id',
  price_high: 'low DESC,name,product_id',
  country: 'country NULLS LAST,name,product_id',
};

// A page of the shop's items: { items, total, page, pages }.
async function items(db, link, { q, category, country, sort, page } = {}) {
  const day = await today(db, link.timezone);
  const values = [link.business_id, link.location_id, day, link.hide_out_of_stock];
  const where = [SHOWN];
  for (const word of searchWords(q)) {
    values.push(word);
    where.push(`concat_ws(' ',product_name,label,brand,category_name,generic_name) ILIKE $${values.length}`);
  }
  if (category !== undefined && category !== null && category !== '') {
    values.push(v.requiredId(category, 'Category'));
    // A category takes in its sub-categories.
    where.push(`category_id IN (WITH RECURSIVE under AS (SELECT id FROM catalog_categories WHERE business_id=$1 AND id=$${values.length}
      UNION ALL SELECT c.id FROM catalog_categories c JOIN under ON c.parent_id=under.id WHERE c.business_id=$1) SELECT id FROM under)`);
  }
  if (country) {
    values.push(v.requiredString(country, 'Country of origin', 60));
    where.push(`lower(country_of_origin)=lower($${values.length})`);
  }
  const order = SORTS[sort] || SORTS.name;
  const number = Math.max(1, Math.min(500, Number.parseInt(page, 10) || 1));
  values.push(PAGE, (number - 1) * PAGE);
  const result = await repo.one(db, `${ROWS_SQL},
    shown AS (SELECT * FROM rows WHERE ${where.join(' AND ')}),
    products AS (SELECT product_id,min(product_name) AS name,min(price) AS low,min(country_of_origin) AS country FROM shown GROUP BY product_id),
    paged AS (SELECT products.*,row_number() OVER (ORDER BY ${order}) AS ordinal FROM products ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length})
    SELECT (SELECT count(*)::int FROM products) AS total,
      COALESCE((SELECT json_agg(s ORDER BY p.ordinal,s.label) FROM paged p JOIN shown s ON s.product_id=p.product_id),'[]') AS rows`, values);
  return { items: cardsOf(result.rows, link), total: result.total, page: number, pages: Math.max(1, Math.ceil(result.total / PAGE)) };
}

// The categories that hold something shown, with how many items each, and
// the countries of the imported items (r.6(10A): guests may filter by them).
async function categoriesOf(db, link) {
  const day = await today(db, link.timezone);
  const rows = await repo.all(db, `${ROWS_SQL},
    shown AS (SELECT * FROM rows WHERE ${SHOWN})
    SELECT 'category' AS kind,c.id,c.name,c.parent_id,(SELECT count(DISTINCT product_id)::int FROM shown WHERE shown.category_id=c.id) AS n
      FROM catalog_categories c WHERE c.business_id=$1 AND EXISTS (SELECT 1 FROM shown WHERE shown.category_id=c.id)
    UNION ALL SELECT 'country',NULL,min(country_of_origin),NULL,count(DISTINCT product_id)::int FROM shown
      WHERE country_of_origin IS NOT NULL AND lower(country_of_origin) NOT IN ('india','bharat') GROUP BY lower(country_of_origin)`,
  [link.business_id, link.location_id, day, link.hide_out_of_stock]);
  return {
    categories: rows.filter((row) => row.kind === 'category').map((row) => ({ id: Number(row.id), name: row.name, count: row.n })).sort((a, b) => a.name.localeCompare(b.name)),
    countries: rows.filter((row) => row.kind === 'country').map((row) => ({ name: row.name, count: row.n })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const MAKER_WORDS = { manufacturer: 'Manufactured by', packer: 'Packed by', importer: 'Imported by' };

// One product's page: its variants, photo and every declaration filled in.
async function item(db, link, productId) {
  const day = await today(db, link.timezone);
  const rows = await repo.all(db, `${ROWS_SQL} SELECT * FROM rows WHERE product_id=$5 AND never IS NULL AND NOT item_hidden AND NOT category_hidden AND price>0
    AND (NOT $4::boolean OR stock>0) ORDER BY label`, [link.business_id, link.location_id, day, link.hide_out_of_stock, v.requiredId(productId, 'Item')]);
  if (!rows.length) fail('This item is not in the online shop any more.', 404, { reason: 'item_gone' });
  const [card] = cardsOf(rows, link);
  const first = rows[0];
  const declarations = [
    first.maker_name && { label: MAKER_WORDS[first.maker_kind] || 'Made by', value: [first.maker_name, first.maker_address].filter(Boolean).join(', ') },
    first.generic_name && { label: 'Generic name', value: first.generic_name },
    first.net_quantity && { label: 'Net quantity', value: first.net_quantity },
    first.country_of_origin && { label: 'Country of origin', value: first.country_of_origin },
    first.best_before && { label: 'Best before', value: first.best_before },
    first.consumer_care && { label: 'Consumer care', value: first.consumer_care },
  ].filter(Boolean);
  return { ...card, description: first.description || null, declarations };
}

// --- Pricing a cart -----------------------------------------------------------------------------

// The lines a guest asks for, priced now: [{ skuId, quantity, price? }] →
// { lines: [{ …variant, quantity, amount, seenPrice, problem }], problems }
// where a line's problem is 'gone' (no longer sold online), 'out' (out of
// stock), 'less' (less in stock than asked: cut to what there is), 'price'
// (its price changed since the guest saw it) or 'quantity' (not a quantity
// it is sold in). Nothing is changed for the guest: they see the problems
// and accept them.
async function priceLines(db, link, wanted, { strict = false } = {}) {
  if (!Array.isArray(wanted) || !wanted.length) fail('Your cart is empty: add something first.');
  if (wanted.length > 60) fail('That is a very large order: please call the shop to place it.');
  const ids = wanted.map((line) => {
    if (!line || typeof line !== 'object') fail('Each cart line names an item and how many');
    return v.requiredId(line.skuId, 'Item');
  });
  if (new Set(ids).size !== ids.length) fail('Each item appears once in the cart');
  const day = await today(db, link.timezone);
  const rows = await repo.all(db, `${ROWS_SQL} SELECT * FROM rows WHERE sku_id=ANY($4::bigint[])`, [link.business_id, link.location_id, day, ids]);
  const byId = new Map(rows.map((row) => [Number(row.sku_id), row]));
  const lines = [];
  for (const [index, line] of wanted.entries()) {
    const row = byId.get(ids[index]);
    const asked = Number(line.quantity);
    const shown = row && row.never === null && !row.item_hidden && !row.category_hidden && Number(row.price) > 0;
    if (!shown) {
      lines.push({ skuId: ids[index], name: line.name || 'An item', quantity: 0, amount: 0, problem: 'gone' });
      continue;
    }
    const variant = variantOf(row, link);
    const seen = line.price === undefined || line.price === null || line.price === '' ? null : Math.round(Number(line.price) * 100);
    let quantity = Number.isFinite(asked) && asked > 0 ? qty(asked) : 0;
    let problem = null;
    const steps = quantity / variant.step;
    if (!quantity || (!variant.weighed && !Number.isInteger(quantity)) || (variant.weighed && Math.abs(steps - Math.round(steps)) > 1e-9)) {
      problem = 'quantity';
      quantity = variant.weighed ? Math.max(variant.step, Math.round(steps) * variant.step) : Math.max(1, Math.floor(quantity) || 1);
    }
    if (variant.max <= 0) { problem = 'out'; quantity = 0; } else if (quantity > variant.max) { problem = problem || 'less'; quantity = variant.max; }
    const pricePaise = Math.round(variant.price * 100);
    if (!problem && seen !== null && seen !== pricePaise) problem = 'price';
    lines.push({ ...variant, name: `${row.product_name}${row.label && row.label !== row.product_name ? ` · ${row.label}` : ''}`, productId: Number(row.product_id),
      photo: photoOf(row), quantity, amount: money.lineAmount(pricePaise, quantity) / 100, seenPrice: seen === null ? null : seen / 100, problem,
      taxRate: Number(row.tax_rate), mrpValue: row.mrp === null ? null : Number(row.mrp) });
  }
  const problems = lines.filter((line) => line.problem);
  if (strict && problems.length) fail('Your cart has changed: check it and place the order again.', 409, { reason: 'cart_changed', lines });
  return { lines, problems };
}

// --- Staff: what shows online ---------------------------------------------------------------

// The items as staff see them for the online shop: shown, hidden by staff, or
// kept off by a rule (with why), with their photo and details.
async function staffItems(business, { location, q, state, category, page } = {}) {
  await access.requireAny(business, ['online_shop.view', 'catalog.view']);
  const locationId = location ? v.requiredId(location, 'Location') : (await repo.one(repo.pool, 'SELECT id FROM business_locations WHERE business_id=$1 AND active ORDER BY id LIMIT 1', [business.id]))?.id;
  if (!locationId) fail('Add a location first', 409);
  const day = await today(repo.pool, business.timezone);
  const values = [business.id, locationId, day];
  const where = ["kind='goods'"];
  for (const word of searchWords(q)) {
    values.push(word);
    where.push(`concat_ws(' ',product_name,label,brand,category_name,code) ILIKE $${values.length}`);
  }
  if (state === 'shown') where.push('never IS NULL AND NOT item_hidden AND NOT category_hidden');
  if (state === 'hidden') where.push('never IS NULL AND (item_hidden OR category_hidden)');
  if (state === 'never') where.push('never IS NOT NULL');
  if (state === 'no_photo') where.push('never IS NULL AND photo_path IS NULL');
  if (state === 'no_maker') where.push('never IS NULL AND maker_name IS NULL');
  if (category) {
    values.push(v.requiredId(category, 'Category'));
    where.push(`category_id=$${values.length}`);
  }
  const number = Math.max(1, Number.parseInt(page, 10) || 1);
  values.push(50, (number - 1) * 50);
  const result = await repo.one(repo.pool, `${ROWS_SQL}, picked AS (SELECT * FROM rows WHERE ${where.map((w) => `(${w})`).join(' AND ')})
    SELECT (SELECT count(*)::int FROM picked) AS total,
      COALESCE((SELECT json_agg(x) FROM (SELECT * FROM picked ORDER BY product_name,label LIMIT $${values.length - 1} OFFSET $${values.length}) x),'[]') AS rows`, values);
  return {
    total: result.total, page: number,
    items: result.rows.map((row) => ({
      skuId: Number(row.sku_id), productId: Number(row.product_id), name: row.product_name, label: row.label, code: row.code, category: row.category_name,
      price: Number(row.price), stock: Number(row.stock), unit: row.unit, hsnCode: row.hsn_code, photo: photoOf(row),
      shown: row.never === null && !row.item_hidden && !row.category_hidden, hidden: row.item_hidden, categoryHidden: row.category_hidden,
      never: row.never, neverWords: row.never ? NEVER_ONLINE[row.never] : null, hasMaker: Boolean(row.maker_name),
    })),
  };
}

const DETAIL_FIELDS = {
  description: ['description', 500, 'Short description'],
  makerName: ['maker_name', 150, 'Maker, packer or importer'],
  makerAddress: ['maker_address', 300, 'Their address'],
  countryOfOrigin: ['country_of_origin', 60, 'Country of origin'],
  genericName: ['generic_name', 150, 'Generic name'],
  netQuantity: ['net_quantity', 40, 'Net quantity'],
  consumerCare: ['consumer_care', 200, 'Consumer care'],
  bestBefore: ['best_before', 100, 'Best before'],
};

// One product's online details, and why it is not online if a rule keeps it off.
async function itemDetails(business, productId) {
  await access.requireAny(business, ['online_shop.view', 'catalog.view']);
  const product = await repo.one(repo.pool, 'SELECT id,name,kind FROM catalog_products WHERE business_id=$1 AND id=$2', [business.id, v.requiredId(productId, 'Item')]);
  if (!product) fail('Item not found', 404);
  const row = await repo.one(repo.pool, 'SELECT * FROM shop_item_details WHERE business_id=$1 AND product_id=$2', [business.id, product.id]);
  const rules = await repo.all(repo.pool, `WITH RECURSIVE ${TREE_SQL}
    SELECT s.id,s.label,${neverOnlineSql({ sku: 's', product: 'p', words: 'tree.words' })} AS never,COALESCE(tree.hidden,FALSE) AS category_hidden
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id LEFT JOIN tree ON tree.id=p.category_id
    WHERE s.business_id=$1 AND s.product_id=$2 ORDER BY s.label`, [business.id, product.id]);
  return {
    productId: Number(product.id), name: product.name, hidden: Boolean(row?.hidden), photo: row?.photo_path ? { large: row.photo_path, small: row.thumb_path } : null,
    makerKind: row?.maker_kind || null,
    ...Object.fromEntries(Object.entries(DETAIL_FIELDS).map(([key, [column]]) => [key, row?.[column] || null])),
    categoryHidden: rules.some((rule) => rule.category_hidden),
    never: rules.filter((rule) => rule.never).map((rule) => ({ skuId: Number(rule.id), label: rule.label, code: rule.never, words: NEVER_ONLINE[rule.never] })),
  };
}

// "Show in online shop" and the online details of a product (only the fields sent change).
async function saveItem(business, user, productId, body) {
  await access.requireAny(business, ['catalog.edit', 'online_shop.manage']);
  const sets = {};
  if (body.hidden !== undefined) sets.hidden = v.requiredBoolean(body.hidden, 'Hidden online');
  if (body.makerKind !== undefined) {
    sets.maker_kind = body.makerKind === null || body.makerKind === '' ? null : v.requiredEnum(body.makerKind, 'Made, packed or imported', Object.keys(MAKER_WORDS));
  }
  for (const [key, [column, max, name]] of Object.entries(DETAIL_FIELDS)) {
    if (body[key] !== undefined) sets[column] = v.optionalString(body[key], name, max);
  }
  if (!Object.keys(sets).length) fail('Nothing to change');
  const saved = await repo.transaction(async (db) => {
    const product = await repo.one(db, 'SELECT id,name FROM catalog_products WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, v.requiredId(productId, 'Item')]);
    if (!product) fail('Item not found', 404);
    await require('../../core/services/business.service').requireDepartmentItem(db, business,
      { skuId: (await repo.one(db, 'SELECT id FROM catalog_skus WHERE business_id=$1 AND product_id=$2 ORDER BY id LIMIT 1', [business.id, product.id]))?.id });
    const names = Object.keys(sets);
    await db.query(`INSERT INTO shop_item_details(business_id,product_id,${names.join(',')},updated_by,updated_at) VALUES($1,$2,${names.map((_, index) => `$${index + 3}`).join(',')},$${names.length + 3},now())
      ON CONFLICT (business_id,product_id) DO UPDATE SET ${names.map((name) => `${name}=EXCLUDED.${name}`).join(',')},updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, product.id, ...names.map((name) => sets[name]), user.id]);
    await repo.audit(db, business.id, user.id, 'online_shop.item_updated', product.id, { name: product.name, changed: names });
    return product.id;
  });
  return itemDetails(business, saved);
}

// A category kept off the online shop (with its sub-categories), or shown again.
async function setCategory(business, user, categoryId, body) {
  await access.requireAny(business, ['catalog.edit', 'online_shop.manage']);
  const hidden = v.requiredBoolean(body.hidden, 'Hidden online');
  return repo.transaction(async (db) => {
    const category = await repo.one(db, 'SELECT id,name FROM catalog_categories WHERE business_id=$1 AND id=$2', [business.id, v.requiredId(categoryId, 'Category')]);
    if (!category) fail('Category not found', 404);
    if (hidden) {
      await db.query('INSERT INTO shop_hidden_categories(business_id,category_id,hidden_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [business.id, category.id, user.id]);
    } else {
      await db.query('DELETE FROM shop_hidden_categories WHERE business_id=$1 AND category_id=$2', [business.id, category.id]);
    }
    await repo.audit(db, business.id, user.id, hidden ? 'online_shop.category_hidden' : 'online_shop.category_shown', category.id, { name: category.name });
    return { categoryId: Number(category.id), hidden };
  });
}

// Every category with whether it is hidden online (for the category screen and the shop's settings).
async function categoryFlags(business) {
  await access.requireAny(business, ['online_shop.view', 'catalog.view']);
  const rows = await repo.all(repo.pool, 'SELECT category_id FROM shop_hidden_categories WHERE business_id=$1', [business.id]);
  return { hidden: rows.map((row) => Number(row.category_id)) };
}

module.exports = { items, item, categoriesOf, priceLines, staffItems, itemDetails, saveItem, setCategory, categoryFlags, variantOf, ROWS_SQL, TREE_SQL, today, MAKER_WORDS };
