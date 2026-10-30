const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const sheet = require('../../../../utils/sheetImport');
const core = require('./business.service');
const setup = require('./businessSetup.service');
const { attempt, plainAmount, tidy, nameKey, moneyWords, samePaise, plainNumber, dayWords } = require('./businessImportCells');

// Products from a spreadsheet: a shop's catalogue with its prices, GST slabs,
// HSN codes, MRPs, opening stock, styles with their variants and pack sizes,
// planned row by row against the items already here (businessImports.service.js
// runs the check and the import).
//
//   * An item is found by its code (SKU), then by its barcode. A row that
//     finds none is a new item; one that finds an item leaves it as it is,
//     or changes it where the person chose to update matching records.
//   * Only what the file gives counts: a column left out, or an empty cell,
//     keeps what the item has. An item's kind, unit and stock tracking never
//     change, so a row that says otherwise is refused.
//   * Each value is read by the core's own reader, with its words: units and
//     GST slabs are the business's own, an HSN code has 4, 6 or 8 digits, a
//     barcode is on one item only, nothing sells above its MRP.
//   * Opening stock goes in through the core's opening-stock path (a lot at
//     the purchase price, "Opening stock" in the stock movements), and only
//     for an item with no stock on record: one that has some keeps it, and a
//     stock count corrects it.
//   * What a business type keeps its own details for (a jewellery piece and
//     its purity, a fuel, a rental item, a laundry service, a room type, a
//     membership plan) is made on the type's own screen: a row of one is
//     refused with the screen to use, and such an item already here is never
//     changed from a file. A pharmacy's medicines come in as items, batch by
//     batch: their drug details are added in the Drug master.
//   * A category the file names that does not exist yet is made, top level or
//     under the path written (Staples › Rice). Someone tied to a department
//     imports the items of that department only.
//   * With Variants on, a Style column makes the rows of one style one product
//     with its variants, as the item form's "Variant of" makes them: each row
//     an item of its own (code, barcode, price, size, colour, opening stock).
//     A style already here (a product of that name) gains the new rows. A
//     style's rows share one kind, unit, stock tracking, GST rate, HSN code and
//     category: a row that leaves one empty takes the style's, and a style
//     whose rows disagree is refused, every row of it, naming the rows.
//   * A pack size (a pack unit and how many of the item's own unit it holds)
//     is made as Settings › Units & pack sizes makes it, for a new item or one
//     already here; it needs the permission that changes items.

// The products a type keeps its own details for. `table` finds those already
// here (their item's sku id); `kinds` are words a file's Kind column may use
// for one; `units`, a unit only they are counted in; `made`, where one is made.
const OWN = {
  jewellery: { what: 'a jewellery piece', many: 'Jewellery pieces', made: 'on Pieces & tags, with its purity and weight',
    sql: 'SELECT sku_id FROM jewellery_items WHERE business_id=$1', kinds: ['jewellery', 'jewelry', 'jewelleryitem', 'ornament', 'ornaments', 'piece', 'pieces'] },
  fuel_station: { what: 'a fuel', many: 'Fuels', made: 'in Settings › Pumps & nozzles, with its price at each outlet',
    sql: 'SELECT sku_id FROM fuel_products WHERE business_id=$1', kinds: ['fuel', 'fuels', 'petrol', 'diesel', 'cng', 'hsd'] },
  rentals: { what: 'a rental item', many: 'Rental items', made: 'in Rental items, with its rates, units and deposit',
    sql: 'SELECT sku_id FROM rental_items WHERE business_id=$1', kinds: ['rental', 'rentals', 'rentalitem', 'hire', 'forhire', 'hireitem'], units: ['day'] },
  laundry: { what: 'a laundry service', many: 'Laundry services', made: 'in Services & items › Price list, with its price for each garment',
    sql: 'SELECT sku_id FROM laundry_services WHERE business_id=$1', kinds: ['laundry', 'laundryservice', 'drycleaning'] },
  lodging: { what: 'a room type', many: 'Room types', made: 'in Settings › Room types & rates, with its rates and rooms',
    sql: 'SELECT sku_id FROM lodging_room_types WHERE business_id=$1', kinds: ['room', 'rooms', 'roomtype', 'roomnight'], units: ['night'] },
  memberships: { what: 'a membership plan', many: 'Membership plans', made: 'in Settings › Membership plans',
    sql: `SELECT price_sku_id AS sku_id FROM member_plan_types WHERE business_id=$1
      UNION SELECT joining_sku_id FROM member_plan_types WHERE business_id=$1 AND joining_sku_id IS NOT NULL`, kinds: ['plan', 'plans', 'membership', 'memberships', 'membershipplan'] },
};

const COLUMNS = [
  { key: 'name', label: 'Name', need: 'new', aliases: ['name', 'itemname', 'productname', 'item', 'product'],
    help: 'The item as its bill prints it. A new item needs one; for an item already here, a new name renames it.', example: 'Toor dal 1 kg' },
  { key: 'code', label: 'Code', need: 'new', aliases: ['code', 'sku', 'skucode', 'itemcode', 'productcode', 'shortcode', 'partno', 'partnumber'],
    help: 'Your own code for the item (its SKU), kept in capitals. It finds an item already here; a new item needs one.', example: 'TOOR-1KG' },
  { key: 'barcode', label: 'Barcode', need: 'optional', aliases: ['barcode', 'barcodeno', 'ean', 'eancode', 'upc', 'gtin'],
    help: 'The code printed on the pack: letters and digits. It finds an item already here when the code does not; two items never share one.', example: '8901234567894' },
  { key: 'category', label: 'Category', need: 'optional', aliases: ['category', 'categoryname', 'group', 'itemgroup', 'productgroup', 'stockgroup'],
    help: 'A category by its name, or by its path (Staples › Rice). One that does not exist yet is made.', example: 'Pulses' },
  { key: 'kind', label: 'Kind', need: 'optional', aliases: ['kind', 'type', 'itemtype', 'goodsorservice', 'goodsservice'],
    help: 'Goods or Service. Empty: a service when its unit is hours or a service, goods otherwise.', example: 'Goods' },
  { key: 'unit', label: 'Unit', need: 'new', aliases: ['unit', 'units', 'uom', 'unitofmeasure', 'stockunit', 'measure'],
    help: 'The unit its stock and bills count in: one of your units.', example: 'each' },
  { key: 'tracking', label: 'Stock tracking', need: 'optional', aliases: ['stocktracking', 'tracking', 'trackby', 'trackstock', 'stockkeptby'],
    help: 'Quantity, Batch (with Batches & expiry on) or Serial (with Serial / IMEI numbers on). Empty: by batch when the row gives a batch or expiry, by quantity otherwise.', example: 'Quantity' },
  { key: 'hsn', label: 'HSN / SAC', need: 'optional', aliases: ['hsnsac', 'hsn', 'hsncode', 'sac', 'saccode', 'hsnorsac', 'hsnsaccode'],
    help: 'The HSN code of goods or the SAC of a service: 4, 6 or 8 digits.', example: '0713' },
  { key: 'gst', label: 'GST rate', need: 'optional', aliases: ['gstrate', 'gst', 'gst%', 'gstrate%', 'gstslab', 'tax', 'tax%', 'taxrate', 'taxrate%', 'taxslab', 'igst', 'igstrate', 'igst%'],
    help: 'One of your GST slabs, by its name or its rate (5%, 18, Nil). Empty: a new item takes your default slab; an item already here keeps its own.', example: '5%' },
  { key: 'mrp', label: 'MRP', need: 'optional', aliases: ['mrp', 'mrprs', 'maximumretailprice'],
    help: 'The price printed on the pack, GST included. The item is never sold above it.', example: '175' },
  { key: 'price', label: 'Sale price', need: 'new', aliases: ['saleprice', 'sellingprice', 'salesprice', 'salerate', 'sellingrate', 'salesrate', 'price', 'rate', 'retailprice'],
    help: 'What one unit sells at: GST included when your prices include it. 1,200, ₹1,200.50 and Rs. 250 all work.', example: '160' },
  { key: 'cost', label: 'Purchase price', need: 'optional', aliases: ['purchaseprice', 'purchaserate', 'costprice', 'cost', 'costrate', 'buyingprice', 'landingcost', 'unitcost'],
    help: 'What one unit cost you: it values the opening stock.', example: '130' },
  { key: 'reorderLevel', label: 'Reorder level', need: 'optional', aliases: ['reorderlevel', 'reorder', 'reorderqty', 'minstock', 'minimumstock', 'minqty', 'minlevel', 'lowstock'],
    help: 'Shown as low on stock at or below this, in its unit.', example: '10' },
  { key: 'openingStock', label: 'Opening stock', need: 'optional', aliases: ['openingstock', 'openingqty', 'openingquantity', 'openingbalanceqty', 'stock', 'qty', 'quantity', 'currentstock', 'stockinhand', 'closingstock', 'instock'],
    help: 'What is on the shelf now, in its unit. Brought in once, for an item with no stock on record yet.', example: '24' },
  { key: 'location', label: 'Location', need: 'optional', aliases: ['location', 'locationname', 'branch', 'store', 'storename', 'godown', 'warehouse', 'outlet'],
    help: 'Where the opening stock is: one of your locations, by its name or code.', example: '' },
  { key: 'batch', label: 'Batch', need: 'optional', aliases: ['batch', 'batchno', 'batchnumber', 'lot', 'lotno', 'lotnumber'],
    help: 'The opening stock\'s batch or lot number, for an item kept by batch.', example: '' },
  { key: 'expiry', label: 'Expiry', need: 'optional', aliases: ['expiry', 'expirydate', 'exp', 'expdate', 'expiresOn', 'bestbefore', 'useby'],
    help: 'The opening stock\'s expiry date: 25-12-2027.', example: '' },
];
// A pack the item also comes in (goods): its unit and how many of the item's
// own unit it holds, as Settings › Units & pack sizes makes one.
const PACK_COLUMNS = [
  { key: 'packUnit', label: 'Pack unit', need: 'optional', aliases: ['packunit', 'packname', 'packtype', 'outerunit', 'outerpack', 'caseunit', 'bulkunit'],
    help: 'A pack the item is also bought and sold in: one of your units (box, case, dozen…), with how many of the item\'s own unit it holds. A pack is billed at the price of what it holds.', example: 'box' },
  { key: 'packQuantity', label: 'Units in pack', need: 'optional', aliases: ['unitsinpack', 'qtyinpack', 'quantityinpack', 'packqty', 'packquantity', 'unitsperpack', 'packcontains', 'conversionfactor'],
    help: 'How many of the item\'s own unit one pack holds: 12 for a box of 12.', example: '12' },
];
// A style and its variants (Variants on): the rows of one style are one product.
const VARIANT_COLUMNS = [
  { key: 'style', label: 'Style', need: 'optional', aliases: ['style', 'stylename', 'styleno', 'stylenumber', 'stylecode', 'design', 'designname', 'designno', 'parentitem', 'parentproduct', 'variantof'],
    help: 'The product a row is a variant of. Rows of one style become one product, each row a variant with its own code, barcode, price and stock; a style already here gains the new rows. A style\'s rows share one kind, unit, stock tracking, GST rate, HSN code and category: a row that leaves one empty takes the style\'s. Empty: the row is an item of its own.', example: '' },
  { key: 'size', label: 'Size', need: 'optional', aliases: ['size', 'sizes', 'sizename'], help: 'The variant\'s size (M, 32, 7-8Y), up to 20 characters.', example: '' },
  { key: 'color', label: 'Colour', need: 'optional', aliases: ['colour', 'color', 'colours', 'colors', 'colourname', 'colorname'], help: 'The variant\'s colour, up to 40 characters.', example: '' },
  { key: 'fabric', label: 'Fabric', need: 'optional', aliases: ['fabric', 'material'], help: 'The variant\'s fabric or material, up to 40 characters.', example: '' },
];
// A jeweller's file may carry each piece's purity: such a row is a piece.
const PURITY = { key: 'purity', label: 'Purity', need: 'optional', aliases: ['purity', 'karat', 'karats', 'carat', 'kt', 'touch', 'fineness'],
  help: 'A gold or silver piece with its purity is tagged on Pieces & tags, with its weight: a row that gives a purity is refused here.', example: '' };
const variantsOn = (business) => business.capabilities.includes('variants');
const columnsOf = (business) => [...COLUMNS, ...(business.capabilities.includes('inventory') ? PACK_COLUMNS : []), ...(variantsOn(business) ? VARIANT_COLUMNS : []),
  ...(business.business_type === 'jewellery' ? [PURITY] : [])];
// What a variant's size, colour and fabric may hold (as the size × colour grid keeps them).
const VARIANT_LIMITS = { size: 20, color: 40, fabric: 40 };
const VARIANT_WORDS = { size: 'size', color: 'colour', fabric: 'fabric' };
// What a style's rows share, and the words for two that differ.
const SHARED = ['kind', 'unit', 'tracking', 'gst', 'hsn', 'category'];
const SHARED_WORDS = { kind: 'kinds', unit: 'units', tracking: 'ways of keeping stock', gst: 'GST rates', hsn: 'HSN / SAC codes', category: 'categories' };
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
// "row 3", "rows 3 and 5", "rows 3, 5 and 6".
const rowsWords = (lines) => (lines.length === 1 ? `row ${lines[0]}` : `rows ${lines.slice(0, -1).join(', ')} and ${lines.at(-1)}`);
// A variant's name on the bill, as the size × colour grid names it: "Oxford shirt · Blue / M".
const variantLabel = (style, size, color, fabric) => `${style} · ${[color, size, fabric].filter(Boolean).join(' / ')}`.slice(0, 150);
const comboWords = (size, color, fabric) => [color, size, fabric].filter(Boolean).join(' / ');

// Ways people write a unit, each family found by any of its words.
const UNIT_WORDS = [
  ['each', 'pc', 'pcs', 'piece', 'pieces', 'nos', 'no', 'number', 'numbers', 'unit', 'units', 'ea'],
  ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kgm'],
  ['g', 'gm', 'gms', 'gram', 'grams', 'gr', 'grm'],
  ['litre', 'litres', 'liter', 'liters', 'l', 'lt', 'ltr', 'ltrs'],
  ['ml', 'mls', 'millilitre', 'millilitres', 'milliliter', 'milliliters'],
  ['metre', 'metres', 'meter', 'meters', 'm', 'mtr', 'mtrs'],
  ['hour', 'hours', 'hr', 'hrs'],
  ['service', 'services', 'svc'],
  ['pack', 'packs', 'pk'], ['packet', 'packets', 'pkt', 'pkts'], ['box', 'boxes', 'bx'], ['case', 'cases'],
  ['dozen', 'dozens', 'dz', 'doz'], ['strip', 'strips'], ['tablet', 'tablets', 'tab', 'tabs'], ['bottle', 'bottles', 'btl', 'btls'],
  ['pair', 'pairs', 'pr'], ['bag', 'bags'], ['set', 'sets'], ['roll', 'rolls'], ['sheet', 'sheets'], ['coil', 'coils'],
  ['foot', 'feet', 'ft'], ['quintal', 'quintals', 'qtl'], ['tonne', 'tonnes', 'ton', 'tons'], ['carat', 'carats', 'ct', 'cts'],
  ['day', 'days'], ['night', 'nights', 'roomnight', 'roomnights'],
];
const KIND_WORDS = Object.fromEntries([
  ...['goods', 'good', 'product', 'products', 'item', 'items', 'stock', 'stocked', 'stockitem', 'inventory'].map((w) => [w, 'goods']),
  ...['service', 'services', 'labour', 'labor', 'nonstock', 'nonstockitem'].map((w) => [w, 'service']),
]);
const TRACKING_WORDS = Object.fromEntries([
  ...['quantity', 'qty', 'byquantity', 'count', 'normal'].map((w) => [w, 'quantity']),
  ...['batch', 'batches', 'batchexpiry', 'batchandexpiry', 'bybatch', 'lot', 'lots'].map((w) => [w, 'batch']),
  ...['serial', 'serials', 'serialno', 'serialnumber', 'serialnumbers', 'imei', 'serialimei', 'serialimeinumbers', 'byserial'].map((w) => [w, 'serial']),
  ...['none', 'notstocked', 'nostock', 'notkept'].map((w) => [w, 'none']),
]);
const TRACKING_NAMES = { quantity: 'quantity', batch: 'batch and expiry', serial: 'serial number', none: 'no stock (a service)' };
const NIL_WORDS = ['nil', 'nilrated', 'exempt', 'exempted', 'zero', 'nilexempt', 'nongst', 'outsidegst'];
// A path of categories, written with ›, > or ».
const PATH = /\s*[›>»]\s*/;

// Everything a row is checked against, read once.
async function context(db, business) {
  const skus = await repo.all(db, `SELECT s.id,s.code,s.barcode,s.label,s.unit,s.price,s.mrp,s.tax_rate,s.tax_rate_id,s.hsn_code,s.reorder_level,s.tracking,
      s.active,s.is_kit,s.member_price,s.product_id,s.attributes,p.name AS product_name,p.kind,p.category_id,c.department_id,u.decimals AS unit_decimals,u.name AS unit_name
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
    WHERE s.business_id=$1 ORDER BY s.id`, [business.id]);
  // The products a Style column may name (a style already here), and the pack sizes items have.
  const products = await repo.all(db, 'SELECT id,name,kind,active,category_id FROM catalog_products WHERE business_id=$1 ORDER BY id', [business.id]);
  const packRows = await repo.all(db, 'SELECT sku_id,unit_code,quantity_in_base,active FROM catalog_sku_units WHERE business_id=$1', [business.id]);
  const packs = new Map();
  for (const pack of packRows) {
    if (!packs.has(String(pack.sku_id))) packs.set(String(pack.sku_id), new Map());
    packs.get(String(pack.sku_id)).set(pack.unit_code, { quantity: Number(pack.quantity_in_base), active: pack.active });
  }
  const skusByProduct = new Map();
  for (const sku of skus) {
    if (!skusByProduct.has(String(sku.product_id))) skusByProduct.set(String(sku.product_id), []);
    skusByProduct.get(String(sku.product_id)).push(sku);
  }
  const productsByName = new Map();
  for (const product of products) {
    const key = nameKey(product.name);
    if (!productsByName.has(key)) productsByName.set(key, []);
    productsByName.get(key).push(product);
  }
  const categories = await repo.all(db, 'SELECT id,parent_id,name,active,department_id FROM catalog_categories WHERE business_id=$1 ORDER BY id', [business.id]);
  const units = await repo.all(db, 'SELECT code,name,kind,decimals,active FROM business_units WHERE business_id=$1 ORDER BY code', [business.id]);
  const slabs = await repo.all(db, 'SELECT id,name,rate,is_default,active FROM business_tax_rates WHERE business_id=$1 ORDER BY is_default DESC,id', [business.id]);
  const locations = await repo.all(db, 'SELECT id,name,code,active FROM business_locations WHERE business_id=$1 ORDER BY id', [business.id]);
  const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  const day = await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS today', [business.timezone]);
  const stocked = new Set((await repo.all(db, 'SELECT DISTINCT sku_id FROM business_stock_lots WHERE business_id=$1', [business.id])).map((r) => String(r.sku_id)));
  const own = OWN[business.business_type];
  const owned = new Set(own ? (await repo.all(db, own.sql, [business.id])).map((r) => String(r.sku_id)) : []);
  const departments = business.member_department_id
    ? await repo.all(db, 'SELECT id,name FROM business_departments WHERE business_id=$1', [business.id]) : [];
  const byId = new Map(categories.map((c) => [String(c.id), c]));
  const pathOf = (category) => {
    const names = [];
    for (let at = category, depth = 0; at && depth < 10; at = at.parent_id ? byId.get(String(at.parent_id)) : null, depth += 1) names.unshift(at.name);
    return names.join(' › ');
  };
  for (const category of categories) category.path = pathOf(category);
  return {
    skus, units, slabs, locations, owned, today: day.today, taxMode: settings?.tax_mode || 'exclusive',
    byCode: new Map(skus.map((s) => [String(s.code).toUpperCase(), s])),
    byBarcode: new Map(skus.filter((s) => s.barcode).map((s) => [s.barcode, s])),
    categories, categoryById: byId, stocked, productsByName, skusByProduct, packs,
    departmentName: departments.find((d) => String(d.id) === String(business.member_department_id))?.name || business.member_department_name || 'one department',
  };
}

function findUnit(units, text) {
  const typed = sheet.normalise(text);
  if (!typed) return null;
  const active = units.filter((u) => u.active);
  const exact = active.find((u) => sheet.normalise(u.code) === typed || sheet.normalise(u.name) === typed);
  if (exact) return exact;
  const family = UNIT_WORDS.find((words) => words.includes(typed));
  return family ? active.find((u) => family.includes(sheet.normalise(u.code))) || null : null;
}

// A GST slab by its name (GST 18%) or its rate (18, 18%, 5.00, Nil); among
// slabs of one rate, the default first, then the oldest, as the core picks.
function findSlab(slabs, text) {
  const active = slabs.filter((s) => s.active);
  const typed = tidy(text).toLowerCase();
  const named = active.find((s) => s.name.toLowerCase() === typed);
  if (named) return named;
  let rate = NIL_WORDS.includes(sheet.normalise(text)) ? 0 : null;
  const match = /^(?:i?gst\s*@?\s*)?(\d{1,2}(?:\.\d{1,2})?)\s*%?$/i.exec(typed);
  if (match) rate = Number(match[1]);
  return rate === null ? null : active.find((s) => Number(s.rate) === rate) || null;
}

// A category by its path or its name: { category }, { create: [...names] }
// for one to make, or { error }.
function findCategory(ctx, text) {
  const names = String(text).split(PATH).map(tidy).filter(Boolean);
  if (!names.length) return { error: 'The category is empty' };
  if (names.length > 5) return { error: 'A category is at most 5 levels deep' };
  const long = names.find((name) => name.length > 100);
  if (long) return { error: `"${long}" is longer than a category's 100 characters` };
  if (names.length === 1) {
    const same = ctx.categories.filter((c) => nameKey(c.name) === nameKey(names[0]));
    const active = same.filter((c) => c.active);
    if (active.length === 1) return { category: active[0] };
    if (active.length > 1) return { error: `${active.length} categories are called ${names[0]}: write its path, like ${active[0].path}` };
    if (same.some((c) => !c.parent_id)) return { error: `The category ${names[0]} is switched off: switch it on in Categories, or name another` };
    return { create: names };
  }
  // A path: the longest part of it already here, then what to make below it.
  let parent = null;
  for (let depth = 0; depth < names.length; depth += 1) {
    const found = ctx.categories.find((c) => nameKey(c.name) === nameKey(names[depth]) && String(c.parent_id ?? '') === String(parent?.id ?? ''));
    if (!found) return { create: names.slice(depth), parent };
    if (!found.active) return { error: `The category ${found.path} is switched off: switch it on in Categories, or name another` };
    parent = found;
  }
  return { category: parent };
}

// What a cell means, for telling whether two rows of a style agree: a unit by
// its code, a slab by its id, a category by its place, a kind or a way of
// keeping stock by its word. Text nobody knows stays as typed (its own row
// refuses it).
function meaningOf(ctx, field, text) {
  const typed = sheet.normalise(text);
  if (field === 'kind') return KIND_WORDS[typed] || `?${typed}`;
  if (field === 'tracking') return TRACKING_WORDS[typed] || `?${typed}`;
  if (field === 'unit') return findUnit(ctx.units, text)?.code || `?${typed}`;
  if (field === 'gst') {
    const slab = findSlab(ctx.slabs, text);
    return slab ? `slab:${slab.id}` : `?${typed}`;
  }
  if (field === 'hsn') return String(text).replace(/\s/g, '');
  const found = findCategory(ctx, text);
  if (found.category) return `id:${found.category.id}`;
  if (found.create) return `new:${found.parent?.id ?? ''}/${found.create.map(nameKey).join('/')}`;
  return `?${typed}`;
}

// The styles a file names (Variants on), each with its rows, the product of
// that name already here (a style already here) and its items, what its rows
// share (one value of each, where any row gives it), what a new row of a style
// already here takes from its items, and the reasons that refuse every row of
// the style.
function planStyles(rawRows, columns, ctx, business) {
  const styles = new Map();
  if (!variantsOn(business) || !columns.byKey.style) return styles;
  rawRows.forEach((raw, index) => {
    const cells = sheet.cellsOf(raw, columns.byKey);
    const name = tidy(cells.style);
    if (!name) return;
    const key = nameKey(name);
    if (!styles.has(key)) styles.set(key, { key, name, lines: [], cells: [], shared: {}, fallback: {}, mismatch: {}, reasons: [], product: null, items: [], combos: new Map() });
    styles.get(key).lines.push(index + 2);
    styles.get(key).cells.push(cells);
  });
  const own = OWN[business.business_type];
  for (const style of styles.values()) {
    const refuseAll = (column, message) => style.reasons.push({ column, message });
    if (style.name.length > 150) refuseAll('style', 'A style has at most 150 characters');
    const same = ctx.productsByName.get(style.key) || [];
    if (same.length > 1) refuseAll('style', `${capital(NUMBER_WORDS[same.length] || String(same.length))} products here are called ${same[0].name}: rename one of them, so the style finds one`);
    if (same.length === 1) {
      [style.product] = same;
      style.items = ctx.skusByProduct.get(String(style.product.id)) || [];
      if (!style.product.active) refuseAll('style', `${style.product.name} is switched off: switch it on first`);
      if (own && style.items.some((s) => ctx.owned.has(String(s.id)))) refuseAll('style', `${style.product.name} is ${own.what}: it is changed ${own.made.replace(/, with .*$/, '')}, not from a file`);
      if (style.items.some((s) => s.is_kit)) refuseAll('style', `${style.product.name} is a kit: a kit has no variants`);
    }
    for (const field of SHARED) {
      if (!columns.byKey[field]) continue;
      const values = new Map();
      style.cells.forEach((cells, at) => {
        if (cells[field] === '') return;
        const meaning = meaningOf(ctx, field, cells[field]);
        if (!values.has(meaning)) values.set(meaning, { text: cells[field], lines: [] });
        values.get(meaning).lines.push(style.lines[at]);
      });
      if (values.size === 1) style.shared[field] = [...values.values()][0].text;
      if (values.size > 1) {
        refuseAll(field, `Style ${style.name} has ${NUMBER_WORDS[values.size] || values.size} ${SHARED_WORDS[field]}: ${[...values.values()].map((v) => `${tidy(v.text)} (${rowsWords(v.lines)})`).join(', ')}. Its variants share one.`);
      }
    }
    const sample = style.items[0];
    if (!sample) continue;
    // A style already here: a new variant takes its items' own details where its row leaves them empty, and keeps their kind, unit and stock tracking.
    const slab = ctx.slabs.find((s) => String(s.id) === String(sample.tax_rate_id));
    style.fallback = { kind: style.product.kind, unit: sample.unit, tracking: sample.tracking, gst: slab ? slab.name : `${Number(sample.tax_rate)}%`, hsn: sample.hsn_code || '',
      category: style.product.category_id ? ctx.categoryById.get(String(style.product.category_id))?.path || '' : '' };
    const its = { kind: style.product.kind === 'goods' ? 'goods' : 'a service', unit: `counted in ${String(sample.unit_name).toLowerCase()}`, tracking: `kept by ${TRACKING_NAMES[sample.tracking]}` };
    for (const field of ['kind', 'unit', 'tracking']) {
      if (style.shared[field] !== undefined && meaningOf(ctx, field, style.shared[field]) !== meaningOf(ctx, field, style.fallback[field])) {
        style.mismatch[field] = `${style.product.name} is ${its[field]}: its variants are too`;
      }
    }
  }
  return styles;
}

// The planned rows: { columns, problems, rows, extra }, as the shared sheet
// reader summarises them. options: { update } (change matching items).
function plan(rawRows, ctx, business, { update }) {
  const caps = business.capabilities;
  const columns = sheet.resolveColumns(rawRows, columnsOf(business));
  const problems = [];
  const rows = [];
  const money = moneyWords(business.currency);
  const own = OWN[business.business_type];
  if (!columns.byKey.code && !columns.byKey.barcode) {
    problems.push({ line: 1, column: 'code', message: 'The file needs a Code column: an item is found by its code (SKU), and a new one needs it' });
  }
  const seen = new Map();
  const barcodes = new Map();
  // Categories to make, once each, parents first: { key, name, parentKey, parentId, path }.
  const toMake = new Map();
  const dept = business.member_department_id ? String(business.member_department_id) : null;
  const unitList = ctx.units.filter((u) => u.active).map((u) => u.code).join(', ');
  const slabList = ctx.slabs.filter((s) => s.active).map((s) => s.name).join(', ');
  const defaultSlab = ctx.slabs.find((s) => s.active && s.is_default) || ctx.slabs.find((s) => s.active);
  const activeLocations = ctx.locations.filter((l) => l.active);
  const homeId = business.member_location_id || business.location_scope || activeLocations[0]?.id;
  const home = activeLocations.find((l) => String(l.id) === String(homeId)) || null;
  const styles = planStyles(rawRows, columns, ctx, business);

  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    // What a variant's row leaves empty and its style gives (filled below).
    const filled = new Set();
    const given = (key) => (Boolean(columns.byKey[key]) || filled.has(key)) && cells[key] !== '';
    const reasons = [];
    const refuse = (column, message) => reasons.push({ column, message });
    const notes = [];

    // Which item the row is: its code, else its barcode.
    const code = given('code') ? tidy(cells.code).toUpperCase() : null;
    if (code && code.length > 60) refuse('code', 'A code has at most 60 characters');
    const barcode = given('barcode') ? attempt(() => core.readBarcode(cells.barcode)) : { value: null };
    if (barcode.error) refuse('barcode', barcode.error);
    const byCode = code ? ctx.byCode.get(code) || null : null;
    const byBarcode = barcode.value ? ctx.byBarcode.get(barcode.value) || null : null;
    const existing = byCode || (!code ? byBarcode : null);
    if (byCode && byBarcode && byCode.id !== byBarcode.id) refuse('barcode', `Barcode ${barcode.value} is on ${byBarcode.label} (${byBarcode.code}), not on ${byCode.label}`);
    if (!byCode && code && byBarcode) refuse('code', `Barcode ${barcode.value} is on ${byBarcode.label}, whose code is ${byBarcode.code}: an item's code does not change`);
    // The style a variant's row belongs to (Variants on), and its size, colour
    // and fabric. A new variant takes what its style's rows share (or its items
    // already here) where its own cells are empty.
    const style = given('style') ? styles.get(nameKey(cells.style)) || null : null;
    const variant = {};
    for (const part of ['size', 'color', 'fabric']) {
      if (!given(part)) continue;
      const value = tidy(cells[part]);
      if (value.length > VARIANT_LIMITS[part]) refuse(part, `A ${VARIANT_WORDS[part]} has at most ${VARIANT_LIMITS[part]} characters`);
      else variant[part] = value;
    }
    if (style && !existing) {
      for (const field of SHARED) {
        // A style already here keeps its own category.
        const text = given(field) ? null : field === 'category' && style.product ? style.fallback.category : style.shared[field] ?? style.fallback[field];
        if (text) { cells[field] = text; filled.add(field); }
      }
    }
    // Named for its style as the style is spelt (a style already here: as its product is).
    const label = given('name') ? tidy(cells.name)
      : style && !existing && Object.keys(variant).length ? variantLabel(style.product?.name || style.name, variant.size, variant.color, variant.fabric) : null;
    const display = label || existing?.label || code || barcode.value || `Row ${line}`;
    const key = existing ? `item:${existing.id}` : code ? `code:${code}` : `line:${line}`;
    if (seen.has(key)) refuse(code ? 'code' : 'barcode', `Row ${seen.get(key)} is the same item`);
    else seen.set(key, line);
    if (barcode.value) {
      if (barcodes.has(barcode.value) && barcodes.get(barcode.value).key !== key) refuse('barcode', `Row ${barcodes.get(barcode.value).line} gives another item barcode ${barcode.value}`);
      else if (!barcodes.has(barcode.value)) barcodes.set(barcode.value, { key, line });
    }
    if (style) {
      for (const reason of style.reasons) refuse(reason.column, reason.message);
      if (existing && (!style.product || String(existing.product_id) !== String(style.product.id))) {
        const alone = (ctx.skusByProduct.get(String(existing.product_id)) || []).length < 2;
        refuse('style', `${existing.label} is ${alone ? 'an item of its own' : `a variant of ${existing.product_name}`}: an item's style does not change`);
      }
      if (!existing) for (const [field, message] of Object.entries(style.mismatch)) refuse(field, message);
    }
    // A variant's size, colour and fabric are its own: they never change, and
    // a style has each of its variants once.
    if (existing) {
      for (const [part, value] of Object.entries(variant)) {
        const now = tidy(existing.attributes?.[part] || '');
        if (nameKey(now) !== nameKey(value)) refuse(part, `The ${VARIANT_WORDS[part]} of ${existing.label} is ${now || 'not set'}: it does not change from a file`);
      }
    } else if (style && Object.keys(variant).length) {
      const comboOf = (values) => ['size', 'color', 'fabric'].map((part) => nameKey(values?.[part] || '')).join('|');
      const combo = comboOf(variant);
      const twin = style.items.find((s) => comboOf(s.attributes) === combo);
      if (twin) refuse('style', `${style.product.name} already has ${comboWords(variant.size, variant.color, variant.fabric)}: ${twin.label} (${twin.code})`);
      else if (style.combos.has(combo)) refuse('style', `Row ${style.combos.get(combo)} is the same variant of ${style.name} (${comboWords(variant.size, variant.color, variant.fabric)})`);
      else style.combos.set(combo, line);
    }
    if (!existing) {
      if (!code) refuse('code', barcode.value ? `No item here has barcode ${barcode.value}, and a new item needs its code (SKU)` : 'A new item needs its code (SKU)');
      if (!label) refuse('name', 'A new item needs its name');
      if (!given('unit')) refuse('unit', 'A new item needs its unit');
      if (!given('price')) refuse('price', 'A new item needs its sale price');
    }
    if (label) {
      const named = attempt(() => v.requiredString(label, 'The name', 150));
      if (named.error) refuse('name', named.error);
    }

    // Kind, unit and stock tracking: a new item's, or the same as the item's.
    const ownKind = given('kind') && own?.kinds.includes(sheet.normalise(cells.kind));
    if (ownKind) refuse('kind', `${capital(own.what)} is made ${own.made}, not from a file`);
    let kind = existing ? existing.kind : null;
    if (given('kind') && !ownKind) {
      const typed = KIND_WORDS[sheet.normalise(cells.kind)];
      if (!typed) refuse('kind', `"${cells.kind}" is not a kind: write Goods or Service`);
      else if (existing && typed !== existing.kind) refuse('kind', `${existing.label} is ${existing.kind === 'goods' ? 'goods' : 'a service'}: an item's kind does not change`);
      else kind = typed;
    }
    let unit = existing ? ctx.units.find((u) => u.code === existing.unit) || null : null;
    if (given('unit')) {
      const found = findUnit(ctx.units, cells.unit);
      if (!found) refuse('unit', `"${cells.unit}" is not one of your units (${unitList}). Add it in Settings › Units & pack sizes first`);
      else if (own?.units?.includes(found.code)) refuse('unit', `Counted in ${found.name.toLowerCase()}s, it is ${own.what}: that is made ${own.made}, not from a file`);
      else if (existing && found.code !== existing.unit) refuse('unit', `${existing.label} is counted in ${existing.unit_name.toLowerCase()}: an item's unit does not change`);
      else unit = found;
    }
    const serviceUnit = unit && ['time', 'service'].includes(unit.kind);
    if (!existing && unit && !kind && !ownKind) kind = serviceUnit ? 'service' : 'goods';
    if (!existing && unit && kind) {
      if (kind === 'goods' && serviceUnit) refuse('unit', 'Goods are counted in a stock unit (each, kg, litre…), not in hours or as a service');
      if (kind === 'service' && !serviceUnit) refuse('unit', 'A service is counted in hours or as a service');
      if (kind === 'goods' && !caps.includes('inventory')) refuse('kind', 'This business keeps no stock: it adds services only');
    }
    let tracking = existing ? existing.tracking : null;
    if (given('tracking')) {
      const typed = TRACKING_WORDS[sheet.normalise(cells.tracking)];
      if (!typed) refuse('tracking', `"${cells.tracking}" is not a way of keeping stock: write Quantity, Batch or Serial`);
      else if (existing && typed !== existing.tracking) {
        refuse('tracking', `${existing.label} ${existing.tracking === 'none' ? 'is a service, with no stock' : `is kept by ${TRACKING_NAMES[existing.tracking]}`}: an item's stock tracking does not change`);
      }
      else tracking = typed;
    }
    if (!existing && kind === 'service') {
      if (tracking && tracking !== 'none') refuse('tracking', 'A service has no stock to keep');
      tracking = 'none';
    }
    if (!existing && kind === 'goods') {
      if (tracking === 'none') refuse('tracking', 'Goods are kept by quantity, batch or serial number');
      // Medicines and farm inputs are sold by batch, as the item form starts them.
      if (!tracking) tracking = caps.includes('batches') && (given('batch') || given('expiry') || ['pharmacy', 'agri_inputs'].includes(business.business_type)) ? 'batch' : 'quantity';
      if (tracking === 'batch' && !caps.includes('batches')) refuse('tracking', 'Batch tracking is not switched on: an owner turns on Batches & expiry in Settings › Business tools');
      if (tracking === 'serial' && !caps.includes('serials')) refuse('tracking', 'Serial numbers are not switched on: an owner turns on Serial / IMEI numbers in Settings › Business tools');
      if (tracking === 'serial' && unit && unit.kind !== 'count') refuse('unit', 'An item with serial numbers is counted in whole pieces');
      if (business.business_type === 'pharmacy' && tracking !== 'batch') refuse('tracking', 'A pharmacy keeps its goods by batch and expiry: its purchases need them');
    }
    if (given('purity')) refuse('purity', `${capital(OWN.jewellery.what)} is made ${OWN.jewellery.made}, not from a file`);

    // The category: kept, one of yours, or one to make.
    let categoryId = existing ? existing.category_id : null;
    let categoryKey = null;
    let categoryPath = existing?.category_id ? ctx.categoryById.get(String(existing.category_id))?.path || null : null;
    if (given('category')) {
      const found = findCategory(ctx, cells.category);
      if (found.error) refuse('category', found.error);
      else if (found.category) { categoryId = found.category.id; categoryPath = found.category.path; }
      else {
        // Made in its parent's department, or (at the top) in the department of whoever is tied to one.
        if (dept && found.parent && String(found.parent.department_id ?? '') !== dept) {
          refuse('category', `${found.parent.path} is outside ${ctx.departmentName}, where you work`);
        }
        let parentKey = found.parent ? `id:${found.parent.id}` : '';
        for (const name of found.create) {
          const made = `${parentKey}/${nameKey(name)}`;
          if (!toMake.has(made)) toMake.set(made, { key: made, name, parentKey: parentKey || null, parentId: parentKey.startsWith('id:') ? Number(parentKey.slice(3)) : null,
            path: [found.parent?.path, ...found.create.slice(0, found.create.indexOf(name) + 1)].filter(Boolean).join(' › ') });
          parentKey = made;
        }
        categoryId = null;
        categoryKey = parentKey;
        categoryPath = toMake.get(parentKey).path;
      }
    }
    // A new variant of a style already here is in the style's own category.
    if (style?.product && !existing && given('category') && !filled.has('category')
      && (categoryKey || String(categoryId ?? '') !== String(style.product.category_id ?? ''))) {
      const path = style.product.category_id ? ctx.categoryById.get(String(style.product.category_id))?.path : null;
      refuse('category', `${style.product.name} ${path ? `is in ${path}` : 'has no category'}: its variants are in its category`);
    }
    // Someone tied to a department imports its items only.
    if (dept) {
      if (existing && String(existing.department_id ?? '') !== dept) refuse('category', `${existing.label} is outside ${ctx.departmentName}, where you work`);
      else if (categoryId && String(ctx.categoryById.get(String(categoryId))?.department_id ?? '') !== dept) refuse('category', `${categoryPath} is outside ${ctx.departmentName}, where you work`);
      else if (!categoryId && !categoryKey) refuse('category', `Give a category of ${ctx.departmentName}: you add the items of that department`);
    }

    // Shelf and tax details.
    let hsn;
    if (given('hsn')) {
      const read = attempt(() => core.readHsn(cells.hsn));
      if (read.error) refuse('hsn', read.error); else hsn = read.value;
    }
    let slab;
    if (given('gst')) {
      slab = findSlab(ctx.slabs, cells.gst);
      if (!slab) refuse('gst', `"${cells.gst}" is not one of your GST slabs (${slabList}). Add it in Settings › Tax rates first`);
    } else if (!existing) slab = defaultSlab;
    let mrp;
    if (given('mrp')) {
      const read = attempt(() => core.readMrp(plainAmount(cells.mrp)));
      if (read.error) refuse('mrp', read.error); else mrp = read.value;
    }
    let price;
    if (given('price')) {
      const read = attempt(() => core.decimal(plainAmount(cells.price), 'The sale price'));
      if (read.error) refuse('price', read.error); else price = read.value;
    }
    let reorder;
    if (given('reorderLevel')) {
      const read = attempt(() => core.decimal(plainAmount(cells.reorderLevel), 'The reorder level', 3));
      if (read.error) refuse('reorderLevel', read.error); else reorder = read.value;
    }
    // Nothing sells above its MRP: checked on the item as it would be.
    const rate = slab ? Number(slab.rate) : existing ? Number(existing.tax_rate) : null;
    const sellsAt = price ?? (existing ? Number(existing.price) : null);
    const mrpNow = mrp !== undefined ? mrp : existing?.mrp ?? null;
    if (sellsAt !== null && rate !== null && !reasons.some((r) => ['price', 'mrp', 'gst'].includes(r.column))) {
      const checked = attempt(() => core.checkMrp(display, sellsAt, rate, ctx.taxMode, mrpNow));
      if (checked.error) refuse(given('mrp') ? 'mrp' : 'price', checked.error);
    }

    // Opening stock: through the core's opening-stock path, once.
    let opening = null;
    let cost = null;
    if (given('cost')) {
      const read = attempt(() => core.decimal(plainAmount(cells.cost), 'The purchase price', 4));
      if (read.error) refuse('cost', read.error); else cost = read.value;
    }
    if (given('openingStock')) {
      const quantity = attempt(() => core.decimal(plainAmount(cells.openingStock), 'The opening stock', 3, 0, 10000000));
      if (quantity.error) refuse('openingStock', quantity.error);
      else if (quantity.value > 0) {
        const where = readLocation(cells, given, ctx, business, activeLocations, home);
        if (where.error) refuse('location', where.error);
        let lotCode = '';
        let expiresOn = null;
        if (given('batch')) {
          lotCode = tidy(cells.batch);
          if (lotCode.length > 100) refuse('batch', 'A batch number has at most 100 characters');
        }
        if (given('expiry')) {
          const read = sheet.parseDate(cells.expiry, { minYear: 2000 });
          if (read.error) refuse('expiry', read.error); else expiresOn = read.value;
        }
        if (kind === 'service') refuse('openingStock', 'A service has no stock');
        else if (existing?.is_kit) refuse('openingStock', 'A kit has no stock of its own: its parts do');
        else if (tracking === 'serial') refuse('openingStock', 'Serial-numbered stock comes in through a purchase, one number at a time');
        else if (unit) {
          const places = attempt(() => core.requiredDecimals(plainAmount(cells.openingStock), unit, 'The opening stock'));
          if (places.error) refuse('openingStock', places.error);
        }
        if (tracking === 'batch' && !lotCode) refuse('batch', 'Give the batch number of the opening stock');
        if (tracking !== 'batch' && (lotCode || expiresOn) && tracking !== 'serial' && kind !== 'service') {
          notes.push(caps.includes('batches') ? `It is kept by ${TRACKING_NAMES[tracking]}, so the batch and expiry are not kept.` : 'Batches are not switched on, so the batch and expiry are not kept.');
          lotCode = '';
          expiresOn = null;
        }
        if (expiresOn && expiresOn < ctx.today) notes.push(`The batch's expiry, ${dayWords(expiresOn)}, has passed.`);
        if (existing && ctx.stocked.has(String(existing.id))) {
          notes.push(`${existing.label} already has stock on record, so the opening stock is not added: a stock count corrects it.`);
        } else if (!where.error) {
          opening = { locationId: where.location.id, locationName: where.location.name, quantity: quantity.value, unitCost: cost ?? 0, lotCode, expiresOn };
        }
      }
    }
    if (!given('openingStock') && (cost !== null || given('location') || given('batch') || given('expiry'))) {
      notes.push('A purchase price, location, batch and expiry only count with an opening stock.');
    }

    // A pack size: its unit and how many of the item's own unit it holds, read
    // as Settings › Units & pack sizes reads them.
    let pack = null;
    if (given('packUnit') || given('packQuantity')) {
      const packUnit = given('packUnit') ? findUnit(ctx.units, cells.packUnit) : null;
      const held = given('packQuantity') ? attempt(() => core.decimal(plainAmount(cells.packQuantity), 'Units in pack', 3, 0.001, 1000000)) : null;
      if (!given('packUnit')) refuse('packUnit', 'Give the pack\'s unit with how many it holds');
      else if (!packUnit) refuse('packUnit', `"${cells.packUnit}" is not one of your units (${unitList}). Add it in Settings › Units & pack sizes first`);
      else if (unit && packUnit.code === unit.code) refuse('packUnit', `${display} is already stocked in ${unit.name.toLowerCase()}: a pack is another unit`);
      if (!held) refuse('packQuantity', `Give how many ${unit ? unit.name.toLowerCase() : 'units'} one pack holds`);
      else if (held.error) refuse('packQuantity', held.error);
      else if (unit && unit.decimals === 0 && !Number.isInteger(held.value)) refuse('packQuantity', `${display} is stocked in whole units, so a pack must hold a whole number`);
      if (kind === 'service') refuse('packUnit', 'A service has no pack sizes');
      if (packUnit && held && !held.error) pack = { unitCode: packUnit.code, unitName: packUnit.name, quantity: held.value };
    }
    const packWords = (quantity) => `${pack.unitName} of ${plainNumber(quantity)}`;

    if (reasons.length) {
      rows.push({ line, key, name: display, code: existing?.code || code, action: 'refused', reasons, changes: [], notes: [], state: existing ? stateOf(existing, ctx) : null, write: null });
      return;
    }
    const unitWord = unit ? unit.code : '';
    const openingWords = opening ? `${plainNumber(opening.quantity)} ${unitWord} at ${opening.locationName}${opening.lotCode ? `, batch ${opening.lotCode}` : ''}` : null;

    if (!existing) {
      const parts = Object.keys(variant).length ? variant : null;
      rows.push({
        line, key, name: display, code, action: 'create', changes: [], notes,
        details: { kind: kind === 'goods' ? 'Goods' : 'Service', unit: unit.name, price: money(price), gst: slab.name, mrp: mrp ? money(mrp) : null, hsn: hsn || null,
          category: categoryKey ? `${categoryPath} (new)` : categoryPath, opening: openingWords, cost: opening && cost !== null ? money(cost) : null,
          ...(style ? { style: style.product ? style.product.name : `${style.name} (new)` } : {}), ...(parts ? { variant: comboWords(parts.size, parts.color, parts.fabric) } : {}),
          ...(pack ? { pack: packWords(pack.quantity) } : {}) },
        // A style made or grown since the check gives another fingerprint.
        state: [code, barcode.value, unit.code, slab.id, categoryId, categoryKey, opening?.locationId ?? null,
          ...(style ? [style.product?.id ?? null, style.items.length] : []), ...(pack ? [pack.unitCode, pack.quantity] : [])],
        write: { create: { kind, tracking, unit: unit.code, name: style ? style.name : label, label, code, barcode: barcode.value, categoryId, categoryKey, price: String(price),
          mrp: mrp ?? null, taxRateId: slab.id, hsnCode: hsn || null, reorderLevel: reorder ?? 0, ...(parts ? { attributes: parts } : {}),
          ...(style ? { styleKey: style.key, productId: style.product?.id ?? null } : {}) }, opening, pack },
      });
      return;
    }

    // An item already here: what the file changes.
    const changes = [];
    const change = (field, labelText, from, to) => changes.push({ field, label: labelText, from, to });
    if (label && label !== existing.label) change('name', 'Name', existing.label, label);
    if (barcode.value && barcode.value !== existing.barcode) change('barcode', 'Barcode', existing.barcode || '—', barcode.value);
    if (given('category') && (categoryKey || String(categoryId ?? '') !== String(existing.category_id ?? ''))) {
      change('category', 'Category', existing.category_id ? ctx.categoryById.get(String(existing.category_id))?.path || '—' : '—', categoryPath);
    }
    if (hsn !== undefined && hsn !== existing.hsn_code) change('hsn', 'HSN / SAC', existing.hsn_code || '—', hsn);
    const slabChanged = slab && (existing.tax_rate_id ? String(slab.id) !== String(existing.tax_rate_id) : Number(slab.rate) !== Number(existing.tax_rate));
    if (slabChanged) change('gst', 'GST rate', ctx.slabs.find((s) => String(s.id) === String(existing.tax_rate_id))?.name || `${Number(existing.tax_rate)}%`, slab.name);
    if (mrp !== undefined && !samePaise(mrp, existing.mrp)) change('mrp', 'MRP', money(existing.mrp), money(mrp));
    if (price !== undefined && !samePaise(price, existing.price)) change('price', 'Sale price', money(existing.price), money(price));
    if (reorder !== undefined && Number(reorder) !== Number(existing.reorder_level)) change('reorderLevel', 'Reorder level', plainNumber(existing.reorder_level), plainNumber(reorder));
    if (opening) change('opening', 'Opening stock', '—', openingWords);
    // A pack it has with the same quantity is left as it is.
    const packNow = pack ? ctx.packs.get(String(existing.id))?.get(pack.unitCode) : null;
    if (pack && !(packNow?.active && Number(packNow.quantity) === pack.quantity)) {
      change('pack', 'Pack size', packNow ? `${packWords(packNow.quantity)}${packNow.active ? '' : ' (switched off)'}` : '—', packWords(pack.quantity));
    }
    const ownedItem = ctx.owned.has(String(existing.id));
    if (ownedItem && changes.length) {
      rows.push({ line, key, name: display, code: existing.code, action: 'refused', changes: [], notes: [], state: stateOf(existing, ctx),
        reasons: [{ column: ({ opening: 'openingStock', pack: 'packUnit' })[changes[0].field] || changes[0].field, message: `${existing.label} is ${own.what}: it is changed ${own.made.replace(/, with .*$/, '')}, not from a file` }], write: null });
      return;
    }
    if (price !== undefined && existing.member_price !== null && Number(existing.member_price) >= price && !samePaise(price, existing.price)) {
      notes.push(`Its member price, ${money(existing.member_price)}, is not below the new price, so it is cleared.`);
    }
    if (!existing.active) notes.push('It is switched off, and stays off.');
    let action = changes.length ? 'update' : 'unchanged';
    if (action === 'update' && !update) {
      action = 'skipped';
      notes.unshift('Already here: left as it is (you chose to leave items already here as they are).');
    }
    rows.push({
      line, key, name: display, code: existing.code, action, changes: action === 'skipped' ? [] : changes, notes, state: stateOf(existing, ctx),
      write: action !== 'update' ? null : {
        update: { skuId: existing.id, label: label || existing.label, price: price !== undefined ? String(price) : existing.price, active: existing.active,
          taxRateId: slab ? slab.id : existing.tax_rate_id || undefined, taxRate: slab || existing.tax_rate_id ? undefined : existing.tax_rate,
          reorderLevel: reorder !== undefined ? reorder : existing.reorder_level, mrp: mrp !== undefined ? mrp : existing.mrp, hsnCode: hsn !== undefined ? hsn : existing.hsn_code,
          barcode: barcode.value || existing.barcode, ...(changes.some((c) => c.field === 'category') ? { categoryId, categoryKey } : {}) },
        sku: { id: existing.id, label: label || existing.label, tracking: existing.tracking, unit_decimals: existing.unit_decimals },
        opening, pack: changes.some((c) => c.field === 'pack') ? pack : null,
      },
    });
  });

  const counted = rows.filter((row) => row.write?.opening);
  // The styles going in, with their new variants.
  const variants = rows.filter((row) => row.write?.create?.styleKey);
  const value = counted.reduce((sum, row) => sum + Math.round(row.write.opening.quantity * row.write.opening.unitCost * 100), 0);
  // Only the categories an item going in needs (with the parents they sit under).
  const needs = (key, entry) => Boolean(key) && (key === entry.key || key.startsWith(`${entry.key}/`));
  const made = [...toMake.values()].filter((entry) => rows.some((row) => ['create', 'update'].includes(row.action)
    && needs(row.write?.create?.categoryKey || row.write?.update?.categoryKey, entry)));
  return {
    columns, problems, rows,
    newCategories: made,
    extra: {
      skipped: rows.filter((row) => row.action === 'skipped').length,
      refused: rows.filter((row) => row.action === 'refused').length,
      newCategories: made.map((entry) => entry.path),
      opening: { items: counted.length, value: (value / 100).toFixed(2), valueWords: money(value / 100) },
      styles: { count: new Set(variants.map((row) => row.write.create.styleKey)).size, variants: variants.length },
      packs: rows.filter((row) => row.write?.pack).length,
    },
  };
}

// Where a row's opening stock is: the location it names, else the person's
// own, the one picked in the top bar, or the first.
function readLocation(cells, given, ctx, business, active, home) {
  if (!given('location')) return home ? { location: home } : { error: 'There is no open location to bring the stock into' };
  const typed = nameKey(cells.location);
  const found = ctx.locations.find((l) => nameKey(l.name) === typed) || ctx.locations.find((l) => nameKey(l.code) === typed);
  if (!found) return { error: `"${cells.location}" is not one of your locations (${active.map((l) => l.name).join(', ')})` };
  if (!found.active) return { error: `${found.name} is closed` };
  if (business.member_location_id && String(found.id) !== String(business.member_location_id)) {
    return { error: `You work at ${business.member_location_name || 'one location'} only: opening stock goes in there` };
  }
  return { location: found };
}

// What was matched, as it stood: an item that moves before the import gives
// another fingerprint.
const stateOf = (sku, ctx) => [sku.label, sku.barcode, sku.category_id, sku.hsn_code, sku.tax_rate_id, String(sku.tax_rate), sku.mrp, String(sku.price),
  String(sku.reorder_level), sku.active, ctx.stocked.has(String(sku.id)), ctx.owned.has(String(sku.id)), String(sku.product_id),
  [...(ctx.packs.get(String(sku.id)) || new Map())].map(([unit, p]) => `${unit}:${p.quantity}:${p.active}`).sort().join(',')];
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The planned rows written through the core, inside the import's transaction:
// new categories first (parents before children), then each item as the
// item form makes or changes it, with its opening stock: a style's first new
// row makes its product and the rest are its variants ("Variant of"), and a
// pack size is made as Settings › Units & pack sizes makes it.
async function apply(db, business, user, planned) {
  const made = new Map();
  for (const entry of planned.newCategories) {
    const parentId = entry.parentId ?? (entry.parentKey ? made.get(entry.parentKey) : null);
    const body = { name: entry.name, parentId };
    if (!parentId && business.member_department_id) body.departmentId = business.member_department_id;
    const category = await setup.createCategory(business, user, body, db);
    made.set(entry.key, category.id);
  }
  const categoryOf = (write) => (write.categoryKey ? made.get(write.categoryKey) : write.categoryId) || null;
  // Each new style's product, made by its first row.
  const products = new Map();
  const packSize = (skuId, pack) => setup.createPackSize(business, user, { skuId, unitCode: pack.unitCode, quantityInBase: String(pack.quantity) }, db);
  for (const row of planned.rows) {
    if (row.action === 'create') {
      const { categoryKey, categoryId, styleKey, productId, ...item } = row.write.create;
      const opening = row.write.opening;
      const product = productId || (styleKey ? products.get(styleKey) : null);
      const sku = await core.createCatalog(business, user, {
        ...item, categoryId: categoryOf({ categoryKey, categoryId }) || undefined, ...(product ? { productId: product } : {}),
        ...(opening ? { openingStock: { locationId: opening.locationId, quantity: String(opening.quantity), unitCost: String(opening.unitCost), lotCode: opening.lotCode,
          expiresOn: opening.expiresOn || undefined } } : {}),
      }, null, db);
      if (styleKey && !product) products.set(styleKey, sku.product_id);
      if (row.write.pack) await packSize(sku.id, row.write.pack);
    } else if (row.action === 'update') {
      const { skuId, categoryKey, ...body } = row.write.update;
      if ('categoryId' in body) body.categoryId = categoryOf({ categoryKey, categoryId: body.categoryId });
      await core.updateCatalog(business, user, skuId, body, db);
      if (row.write.opening) await core.postOpeningStock(db, business, user, row.write.sku, row.write.opening);
      if (row.write.pack) await packSize(skuId, row.write.pack);
    }
  }
}

const guide = (business, ctx) => {
  const units = ctx.units.filter((u) => u.active);
  const slabs = ctx.slabs.filter((s) => s.active);
  const locations = ctx.locations.filter((l) => l.active);
  const goods = business.capabilities.includes('inventory');
  const columns = columnsOf(business).map((column) => {
    if (column.key === 'unit') return { ...column, help: `${column.help} Yours: ${units.map((u) => u.code).join(', ')}.` };
    if (column.key === 'gst') return { ...column, help: `${column.help} Yours: ${slabs.map((s) => s.name).join(', ')}.` };
    if (column.key === 'location') return { ...column, help: `${column.help} Yours: ${locations.map((l) => l.name).join(', ')}. Empty: ${locations[0]?.name || 'your first location'}.` };
    return column;
  });
  const slab = (rate) => slabs.find((s) => Number(s.rate) === rate)?.name || slabs[0]?.name || '';
  const batch = ['pharmacy', 'agri_inputs'].includes(business.business_type) && business.capabilities.includes('batches');
  const each = units.find((u) => u.code === 'each')?.code || units[0]?.code;
  const place = locations[0]?.name || '';
  // A sample row by column; the template's rows are in its columns' order.
  const sample = [];
  if (goods) {
    const pack = ['box', 'pack', 'case'].map((code) => units.find((u) => u.code === code)).find((u) => u && u.code !== each);
    sample.push({ name: 'Example product one', code: 'EXAMPLE-1', barcode: '8901234567894', category: 'Example category', kind: 'Goods', unit: each, tracking: batch ? 'Batch' : 'Quantity',
      hsn: '0713', gst: slab(5), mrp: '175', price: '160', cost: '130', reorderLevel: '10', openingStock: '24', location: place, batch: batch ? 'B-1001' : '', expiry: batch ? '31-12-2027' : '',
      ...(pack ? { packUnit: pack.code, packQuantity: '12' } : {}) });
    sample.push({ name: 'Example product two', code: 'EXAMPLE-2', category: 'Example category', kind: 'Goods', unit: units.find((u) => u.code === 'kg')?.code || units[0]?.code,
      tracking: batch ? 'Batch' : 'Quantity', hsn: '1006', gst: slab(5), price: '90', cost: '75', reorderLevel: '5', openingStock: '50', location: place,
      batch: batch ? 'B-1002' : '', expiry: batch ? '30-06-2027' : '' });
    // A style with two sizes: one product, each size its own item (named for its style, colour and size).
    if (variantsOn(business)) {
      for (const size of ['S', 'M']) {
        sample.push({ code: `EXAMPLE-3-${size}`, category: 'Example category', kind: 'Goods', unit: each, tracking: 'Quantity', hsn: '6109', gst: slab(5), price: '499', cost: '300',
          openingStock: '5', location: place, style: 'Example style', size, color: 'Blue' });
      }
    }
  }
  const service = units.find((u) => u.code === 'service') || units.find((u) => u.kind === 'service');
  if (service) sample.push({ name: 'Example service', code: 'EXAMPLE-S1', category: 'Example category', kind: 'Service', unit: service.code, hsn: '999799', gst: slab(18), price: '300' });
  const shown = columnsOf(business).filter((c) => c.key !== 'purity');
  return { columns, sample: { columns: shown.map((c) => c.label), rows: sample.map((row) => shown.map((c) => row[c.key] ?? '')) }, notes: notesOf(business) };
};

// What the screen says, for this business's type, about the items it keeps
// details of its own for.
function notesOf(business) {
  const own = OWN[business.business_type];
  const notes = [];
  if (own) notes.push(`${own.many} are made ${own.made.replace(/\bits\b/g, 'their')}: a row of one is refused, and one already here is not changed from a file.`);
  if (business.business_type === 'pharmacy') notes.push('Medicines come in as items, kept by batch and expiry: add each one\'s drug details (composition, schedule) in Medicines & products › Drug master.');
  if (business.business_type === 'agri_inputs') notes.push('Seeds, fertilisers and pesticides come in as items, kept by batch: say what kind of farm input each is on its item form, so the counter checks its licence and molecules.');
  if (variantsOn(business)) notes.push('A style\'s sizes and colours come in as its variants: give each row the style, its size or colour, and its own code.');
  return notes;
}

module.exports = { context, plan, apply, guide, columnsOf, OWN };
