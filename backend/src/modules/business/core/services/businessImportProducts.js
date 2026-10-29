const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const sheet = require('../../../../utils/sheetImport');
const core = require('./business.service');
const setup = require('./businessSetup.service');
const { attempt, plainAmount, tidy, nameKey, moneyWords, samePaise, plainNumber, dayWords } = require('./businessImportCells');

// Products from a CSV file: a shop's catalogue with its prices, GST slabs,
// HSN codes, MRPs and opening stock, planned row by row against the items
// already here (businessImports.service.js runs the check and the import).
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
// A jeweller's file may carry each piece's purity: such a row is a piece.
const PURITY = { key: 'purity', label: 'Purity', need: 'optional', aliases: ['purity', 'karat', 'karats', 'carat', 'kt', 'touch', 'fineness'],
  help: 'A gold or silver piece with its purity is tagged on Pieces & tags, with its weight: a row that gives a purity is refused here.', example: '' };
const columnsOf = (business) => (business.business_type === 'jewellery' ? [...COLUMNS, PURITY] : COLUMNS);

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
      s.active,s.is_kit,s.member_price,p.kind,p.category_id,c.department_id,u.decimals AS unit_decimals,u.name AS unit_name
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
    WHERE s.business_id=$1`, [business.id]);
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
    categories, categoryById: byId, stocked,
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

  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const given = (key) => Boolean(columns.byKey[key]) && cells[key] !== '';
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
    const label = given('name') ? tidy(cells.name) : null;
    const display = label || existing?.label || code || barcode.value || `Row ${line}`;
    const key = existing ? `item:${existing.id}` : code ? `code:${code}` : `line:${line}`;
    if (seen.has(key)) refuse(code ? 'code' : 'barcode', `Row ${seen.get(key)} is the same item`);
    else seen.set(key, line);
    if (barcode.value) {
      if (barcodes.has(barcode.value) && barcodes.get(barcode.value).key !== key) refuse('barcode', `Row ${barcodes.get(barcode.value).line} gives another item barcode ${barcode.value}`);
      else if (!barcodes.has(barcode.value)) barcodes.set(barcode.value, { key, line });
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

    if (reasons.length) {
      rows.push({ line, key, name: display, code: existing?.code || code, action: 'refused', reasons, changes: [], notes: [], state: existing ? stateOf(existing, ctx) : null, write: null });
      return;
    }
    const unitWord = unit ? unit.code : '';
    const openingWords = opening ? `${plainNumber(opening.quantity)} ${unitWord} at ${opening.locationName}${opening.lotCode ? `, batch ${opening.lotCode}` : ''}` : null;

    if (!existing) {
      rows.push({
        line, key, name: display, code, action: 'create', changes: [], notes,
        details: { kind: kind === 'goods' ? 'Goods' : 'Service', unit: unit.name, price: money(price), gst: slab.name, mrp: mrp ? money(mrp) : null, hsn: hsn || null,
          category: categoryKey ? `${categoryPath} (new)` : categoryPath, opening: openingWords, cost: opening && cost !== null ? money(cost) : null },
        state: [code, barcode.value, unit.code, slab.id, categoryId, categoryKey, opening?.locationId ?? null],
        write: { create: { kind, tracking, unit: unit.code, name: label, code, barcode: barcode.value, categoryId, categoryKey, price: String(price), mrp: mrp ?? null,
          taxRateId: slab.id, hsnCode: hsn || null, reorderLevel: reorder ?? 0 }, opening },
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
    const ownedItem = ctx.owned.has(String(existing.id));
    if (ownedItem && changes.length) {
      rows.push({ line, key, name: display, code: existing.code, action: 'refused', changes: [], notes: [], state: stateOf(existing, ctx),
        reasons: [{ column: changes[0].field === 'opening' ? 'openingStock' : changes[0].field, message: `${existing.label} is ${own.what}: it is changed ${own.made.replace(/, with .*$/, '')}, not from a file` }], write: null });
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
        opening,
      },
    });
  });

  const counted = rows.filter((row) => row.write?.opening);
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
  String(sku.reorder_level), sku.active, ctx.stocked.has(String(sku.id)), ctx.owned.has(String(sku.id))];
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The planned rows written through the core, inside the import's transaction:
// new categories first (parents before children), then each item as the
// item form makes or changes it, with its opening stock.
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
  for (const row of planned.rows) {
    if (row.action === 'create') {
      const { categoryKey, categoryId, ...item } = row.write.create;
      const opening = row.write.opening;
      await core.createCatalog(business, user, {
        ...item, label: item.name, categoryId: categoryOf({ categoryKey, categoryId }) || undefined,
        ...(opening ? { openingStock: { locationId: opening.locationId, quantity: String(opening.quantity), unitCost: String(opening.unitCost), lotCode: opening.lotCode,
          expiresOn: opening.expiresOn || undefined } } : {}),
      }, null, db);
    } else if (row.action === 'update') {
      const { skuId, categoryKey, ...body } = row.write.update;
      if ('categoryId' in body) body.categoryId = categoryOf({ categoryKey, categoryId: body.categoryId });
      await core.updateCatalog(business, user, skuId, body, db);
      if (row.write.opening) await core.postOpeningStock(db, business, user, row.write.sku, row.write.opening);
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
  const sample = goods
    ? [['Example product one', 'EXAMPLE-1', '8901234567894', 'Example category', 'Goods', units.find((u) => u.code === 'each')?.code || units[0]?.code, batch ? 'Batch' : 'Quantity',
      '0713', slab(5), '175', '160', '130', '10', '24', locations[0]?.name || '', batch ? 'B-1001' : '', batch ? '31-12-2027' : ''],
    ['Example product two', 'EXAMPLE-2', '', 'Example category', 'Goods', units.find((u) => u.code === 'kg')?.code || units[0]?.code, batch ? 'Batch' : 'Quantity',
      '1006', slab(5), '', '90', '75', '5', '50', locations[0]?.name || '', batch ? 'B-1002' : '', batch ? '30-06-2027' : '']]
    : [];
  const service = units.find((u) => u.code === 'service') || units.find((u) => u.kind === 'service');
  if (service) sample.push(['Example service', 'EXAMPLE-S1', '', 'Example category', 'Service', service.code, '', '999799', slab(18), '', '300', '', '', '', '', '', '']);
  const labels = columnsOf(business).filter((c) => c.key !== 'purity').map((c) => c.label);
  return { columns, sample: { columns: labels, rows: sample.map((row) => row.slice(0, labels.length)) }, notes: notesOf(business) };
};

// What the screen says, for this business's type, about the items it keeps
// details of its own for.
function notesOf(business) {
  const own = OWN[business.business_type];
  const notes = [];
  if (own) notes.push(`${own.many} are made ${own.made.replace(/\bits\b/g, 'their')}: a row of one is refused, and one already here is not changed from a file.`);
  if (business.business_type === 'pharmacy') notes.push('Medicines come in as items, kept by batch and expiry: add each one\'s drug details (composition, schedule) in Medicines & products › Drug master.');
  if (business.business_type === 'agri_inputs') notes.push('Seeds, fertilisers and pesticides come in as items, kept by batch: say what kind of farm input each is on its item form, so the counter checks its licence and molecules.');
  return notes;
}

module.exports = { context, plan, apply, guide, columnsOf, OWN };
