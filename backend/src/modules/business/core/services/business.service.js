const crypto = require('node:crypto');
const repo = require('../repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const { readGstin } = require('../../../../utils/gstin');
const access = require('./businessAccess.service');
const numbering = require('./businessNumbering');
const { attributes, figures } = require('./businessModules');
const pricing = require('./businessPricing');
const retailOffers = require('../../retail/services/businessOffers');
const books = require('../../retail/services/businessBooks');
// Salon packages, memberships and staff on a bill.
const salonSales = require('../../salon-weight/services/businessSalonSales');
const paymentMethods = require('./businessPaymentMethods.service');

const fail = (message, status = 400) => { throw new AppError(status, message); };
function decimal(value, name, places = 2, min = 0, max = 100000000) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' ||
      !/^\d+(\.\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) fail(`${name} must be a non-negative number`);
  const number = Number(value);
  if (number < min || number > max || (String(value).split('.')[1] || '').length > places) {
    fail(`${name} must be between ${min} and ${max}, with at most ${places} decimal places`);
  }
  return number;
}
// A signed amount (an opening balance can be owed either way).
function signedDecimal(value, name, places = 2, max = 100000000) {
  const text = String(value ?? '').trim();
  const negative = text.startsWith('-');
  return decimal(negative ? text.slice(1) : text, name, places, 0, max) * (negative ? -1 : 1);
}
const id = (value, name = 'Record ID') => v.requiredId(value, name);
function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail('A valid request key is required');
  return value;
}
function dateText(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const money = (paise) => (paise / 100).toFixed(2);
const milli = (number) => Math.round(number * 1000);
const paise = (number) => Math.round(number * 100);
// Integer arithmetic including weighted quantities; no repeated float rounding.
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const lineNet = (price, quantity) => roundedDivide(BigInt(paise(price)) * BigInt(milli(quantity)), 1000n);
const lineTax = (net, rate) => roundedDivide(BigInt(net) * BigInt(paise(rate)), 10000n);
// Tax worked out of a tax-inclusive amount: net = gross × 100 / (100 + rate).
const inclusiveNet = (gross, rate) => roundedDivide(BigInt(gross) * 10000n, 10000n + BigInt(paise(rate)));
const methods = ['cash', 'card', 'upi', 'bank', 'cheque'];
// Goods shops: a walk-in pays the whole bill (businessTypes.js).
const { GOODS_TYPES } = require('./businessTypes');

// --- Shelf prices: HSN and MRP ---------------------------------------------------

// An HSN (goods) or SAC (services) code: 4, 6 or 8 digits. Empty clears it.
function readHsn(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).replace(/\s/g, '');
  if (!/^\d{4}(\d{2}){0,2}$/.test(text)) fail('HSN / SAC code must be 4, 6 or 8 digits');
  return text;
}
function readMrp(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return decimal(value, 'MRP', 2, 0.01);
}
// What a customer pays for one unit at this price, GST included (paise).
const shelfPaise = (price, rate, taxMode) => {
  const p = paise(Number(price));
  return taxMode === 'inclusive' ? p : p + lineTax(p, Number(rate));
};
// Nothing is priced or billed above its MRP (the MRP includes every tax).
function checkMrp(label, price, rate, taxMode, mrp) {
  if (mrp === null || mrp === undefined || mrp === '') return;
  const shelf = shelfPaise(price, rate, taxMode);
  if (shelf > paise(Number(mrp))) {
    fail(`${label} would sell at ${money(shelf)}${taxMode === 'inclusive' ? '' : ' with GST'}, above its MRP of ${Number(mrp).toFixed(2)}. Lower the price or correct the MRP.`, 409);
  }
}
async function saleTaxMode(db, businessId) {
  return (await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [businessId]))?.tax_mode || 'exclusive';
}
// A line's rate as stored: two places, or (for a share of a wholesale order,
// `fixed` lines) up to four when two would not match the line's value.
const rateText = (price, fourPlaces) => {
  const four = Number(price).toFixed(4);
  return fourPlaces && !four.endsWith('00') ? four : Number(price).toFixed(2);
};

// --- Directory and set-up ------------------------------------------------

async function list(user) {
  const businesses = await repo.list(user.id);
  const { modules } = await repo.platformCatalogue();
  const types = Object.fromEntries((await repo.all(repo.pool, 'SELECT code,name FROM business_types ORDER BY name')).map((t) => [t.code, { name: t.name }]));
  return { types, modules: modules.map(({ code, name, kind }) => ({ code, name, kind })),
    businesses: businesses.map((b) => ({ ...b, is_signed_in_restaurant: Boolean(b.legacy_restaurant_id) && Number(b.legacy_restaurant_id) === Number(user.restaurantId) })) };
}
async function linkRestaurant(user) {
  if (!user.restaurantId || !user.roles.includes('RESTAURANT_ADMIN')) fail('A restaurant administrator is required', 403);
  await repo.transaction(async (db) => {
    const source = await repo.one(db, 'SELECT * FROM restaurants WHERE id=$1 AND status=\'active\' FOR UPDATE', [user.restaurantId]);
    if (!source) fail('Restaurant not found', 404);
    // A new business row receives its roles, settings and default modules
    // from the provisioning trigger (migration 1791300000005).
    const business = await repo.one(db, `INSERT INTO businesses(name,code,business_type,legacy_restaurant_id)
      VALUES($1,$2,'restaurant',$3) ON CONFLICT(legacy_restaurant_id) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [source.name, source.code, source.id]);
    await db.query(`INSERT INTO business_memberships(business_id,user_id,role_id,created_by,updated_by)
      SELECT $1,$2,id,$2,$2 FROM business_roles WHERE business_id=$1 AND full_access ON CONFLICT DO NOTHING`, [business.id, user.id]);
    await db.query("INSERT INTO business_capabilities(business_id,capability) VALUES($1,'restaurant') ON CONFLICT DO NOTHING", [business.id]);
  });
  return list(user);
}

// --- Locations and contacts ----------------------------------------------

// A location's own address, state and GSTIN (a separately registered
// branch). They print on the bills it raises; an empty field falls back to
// Business settings. null when the client sent none of them.
const LOCATION_ADDRESS_KEYS = ['addressLine1', 'addressLine2', 'city', 'postalCode', 'stateCode', 'gstin', 'phone'];
function locationFields(body) {
  if (!LOCATION_ADDRESS_KEYS.some((key) => body[key] !== undefined)) return null;
  const gstin = readGstin(body.gstin);
  const stateText = v.optionalString(body.stateCode, 'State code', 2);
  if (stateText && !/^\d{2}$/.test(stateText)) fail('State code must be the two-digit GST state code');
  const stateCode = stateText || (gstin ? gstin.slice(0, 2) : null);
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) fail('The state code must match the first two digits of the GSTIN');
  const postal = v.optionalString(body.postalCode, 'PIN code', 10);
  if (postal && !/^\d{6}$/.test(postal)) fail('PIN code must be six digits');
  return [v.optionalString(body.addressLine1, 'Address line 1', 200), v.optionalString(body.addressLine2, 'Address line 2', 200),
    v.optionalString(body.city, 'City', 100), postal, stateCode, gstin, v.optionalString(body.phone, 'Phone', 30)];
}

// Opening hours: { mon: { open: "09:00", close: "21:00" }, … }; a day left
// out (or null) is closed. A close before the open runs past midnight.
// undefined: not sent (kept); null or {}: not given.
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function readOpeningHours(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('Opening hours must be given per day');
  const hours = {};
  for (const [day, slot] of Object.entries(value)) {
    if (!DAYS.includes(day)) fail(`Unknown day "${day}" in opening hours`);
    if (slot === null || slot === false) continue;
    const time = (text, what) => {
      const t = String(text ?? '').trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) fail(`${day.toUpperCase()} ${what} must be a time like 09:00`);
      return t;
    };
    const open = time(slot?.open, 'opening'), close = time(slot?.close, 'closing');
    if (open === close) fail(`${day.toUpperCase()}: opening and closing times are the same`);
    hours[day] = { open, close };
  }
  return Object.keys(hours).length ? hours : null;
}

async function createLocation(business, user, body) {
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    const f = locationFields(body);
    const hours = readOpeningHours(body.openingHours);
    const row = await repo.one(db, `INSERT INTO business_locations(business_id,name,code,sells_at_counter,address_line1,address_line2,city,postal_code,state_code,gstin,phone,opening_hours)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [business.id, v.requiredString(body.name, 'Location name', 150), v.requiredString(body.code, 'Location code', 30).toUpperCase(),
        v.requiredBoolean(body.sellsAtCounter, 'Sells at the counter', true), ...(f || [null, null, null, null, null, null, null]), hours ? JSON.stringify(hours) : null]);
    await repo.audit(db, business.id, user.id, 'location.created', row.id);
    return row;
  });
}
async function updateLocation(business, user, locationId, body) {
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    const active = v.requiredBoolean(body.active, 'Active', true);
    if (!active) {
      const open = await repo.one(db, `SELECT
        (SELECT count(*)::int FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND quantity>0) AS stock,
        (SELECT count(*)::int FROM business_stock_transfers WHERE business_id=$1 AND status='in_transit' AND (from_location_id=$2 OR to_location_id=$2)) AS transfers`,
      [business.id, id(locationId)]);
      if (open.stock || open.transfers) fail('This location still holds stock or has transfers in transit. Move or correct them before closing it.', 409);
    }
    // Older clients send no counter flag: the location keeps what it has.
    const counter = body.sellsAtCounter === undefined ? null : v.requiredBoolean(body.sellsAtCounter, 'Sells at the counter');
    // Address and GSTIN: older clients send none of them and the location keeps what it has.
    const f = locationFields(body);
    // Opening hours: older clients send none and the location keeps its own.
    const hours = readOpeningHours(body.openingHours);
    const row = await repo.one(db, `UPDATE business_locations SET name=$3,active=$4,sells_at_counter=COALESCE($5,sells_at_counter),
      opening_hours=CASE WHEN $14 THEN $15::jsonb ELSE opening_hours END,
      address_line1=CASE WHEN $6 THEN $7 ELSE address_line1 END,address_line2=CASE WHEN $6 THEN $8 ELSE address_line2 END,
      city=CASE WHEN $6 THEN $9 ELSE city END,postal_code=CASE WHEN $6 THEN $10 ELSE postal_code END,
      state_code=CASE WHEN $6 THEN $11 ELSE state_code END,gstin=CASE WHEN $6 THEN $12 ELSE gstin END,phone=CASE WHEN $6 THEN $13 ELSE phone END
      WHERE business_id=$1 AND id=$2 RETURNING *`,
      [business.id, id(locationId), v.requiredString(body.name, 'Location name', 150), active, counter, Boolean(f), ...(f || [null, null, null, null, null, null, null]),
        hours !== undefined, hours ? JSON.stringify(hours) : null]);
    if (!row) fail('Location not found', 404);
    await repo.audit(db, business.id, user.id, 'location.updated', row.id, { active });
    return row;
  });
}
// A PAN as printed on the card (any case typed): five letters, four digits, a letter. Empty clears it.
function readPan(value, name = 'PAN') {
  const text = v.optionalString(value, name, 10);
  if (!text) return null;
  const pan = text.toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fail(`${name} must look like ABCDE1234F: five letters, four digits and a letter`);
  return pan;
}
function contactFields(body, kind) {
  const creditLimit = body.creditLimit === undefined || body.creditLimit === null || body.creditLimit === '' ? null : decimal(body.creditLimit, 'Credit limit');
  const opening = body.openingBalance === undefined || body.openingBalance === null || body.openingBalance === '' ? 0 : signedDecimal(body.openingBalance, 'Opening balance');
  const openingOn = opening ? dateText(body.openingBalanceOn, 'Opening balance date') : null;
  const creditDays = body.creditDays === undefined || body.creditDays === null || body.creditDays === '' ? 0 : decimal(body.creditDays, 'Credit days', 0, 0, 365);
  if (kind === 'supplier' && creditLimit !== null) fail('A credit limit applies to customers; for suppliers record their credit days instead');
  return {
    name: v.requiredString(body.name, 'Name', 150), phone: v.optionalString(body.phone, 'Phone', 30),
    email: v.optionalString(body.email, 'Email', 150), address: v.optionalString(body.address, 'Address', 500),
    gstin: readGstin(body.gstin), pan: readPan(body.pan), creditLimit, creditDays, opening, openingOn,
  };
}
// `inTransaction`: the caller's own transaction (a farm-input shop adds a farmer and their customer record together).
async function createContact(business, user, body, inTransaction = null) {
  await access.require(business, 'contacts.create');
  const kind = v.requiredEnum(body.kind, 'Contact type', ['customer', 'supplier']);
  const f = contactFields(body, kind);
  const run = inTransaction ? (work) => work(inTransaction) : repo.transaction;
  return run(async (db) => {
    const contact = await repo.one(db, `INSERT INTO business_contacts(business_id,kind,name,phone,email,address,gstin,credit_limit,credit_days,opening_balance,opening_balance_on,pan)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [business.id, kind, f.name, f.phone, f.email, f.address, f.gstin, f.creditLimit, f.creditDays, f.opening, f.openingOn, f.pan]);
    await repo.audit(db, business.id, user.id, 'contact.created', contact.id);
    return contact;
  });
}
async function updateContact(business, user, contactId, body) {
  await access.require(business, 'contacts.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(contactId)]);
    if (!current) fail('Contact not found', 404);
    // Older clients send only name/phone/email/address/active: keep the credit terms then.
    const merged = { creditLimit: current.credit_limit, creditDays: current.credit_days, openingBalance: current.opening_balance,
      openingBalanceOn: current.opening_balance_on, gstin: current.gstin, pan: current.pan, ...body };
    const f = contactFields(merged, current.kind);
    const row = await repo.one(db, `UPDATE business_contacts SET name=$3,phone=$4,email=$5,address=$6,active=$7,gstin=$8,credit_limit=$9,
      credit_days=$10,opening_balance=$11,opening_balance_on=$12,pan=$13,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,
    [business.id, current.id, f.name, f.phone, f.email, f.address, v.requiredBoolean(body.active, 'Active', true), f.gstin, f.creditLimit, f.creditDays, f.opening, f.openingOn, f.pan]);
    await repo.audit(db, business.id, user.id, 'contact.updated', row.id);
    return row;
  });
}

// --- Catalogue -------------------------------------------------------------

// A barcode as printed or typed: letters, digits and - . / only. Empty clears it.
function readBarcode(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^[0-9A-Za-z./-]{1,80}$/.test(text)) fail('A barcode is letters and digits only (up to 80)');
  return text;
}
// Two items never share a barcode: say which item already has it.
async function barcodeFree(db, businessId, barcode, skuId = null) {
  if (!barcode) return;
  const clash = await repo.one(db, 'SELECT label FROM catalog_skus WHERE business_id=$1 AND barcode=$2 AND ($3::bigint IS NULL OR id<>$3) LIMIT 1', [businessId, barcode, skuId]);
  if (clash) fail(`Barcode ${barcode} is already on ${clash.label}`, 409);
}
// Opening stock typed with a new item: which location, how
// many, at what cost, and the batch for batch-tracked items.
function readOpeningStock(body, tracking) {
  const raw = body.openingStock;
  if (raw === undefined || raw === null || raw === '' || (typeof raw === 'object' && !raw.quantity)) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('Opening stock must be an object');
  if (tracking === 'serial') fail('Serial-numbered stock comes in through a purchase, one number at a time');
  if (tracking === 'none') fail('A service has no stock');
  const quantity = decimal(raw.quantity, 'Opening stock', 3, 0.001, 10000000);
  const lotCode = v.optionalString(raw.lotCode, 'Batch number', 100) || '';
  if (tracking === 'batch' && !lotCode) fail('Give the batch number of the opening stock');
  const expiresOn = raw.expiresOn ? dateText(raw.expiresOn, 'Expiry date') : null;
  return { locationId: id(raw.locationId, 'Location'), quantity, unitCost: decimal(raw.unitCost ?? 0, 'Cost price', 4), lotCode, expiresOn };
}

async function readUnit(db, businessId, code) {
  const unit = await repo.one(db, 'SELECT * FROM business_units WHERE business_id=$1 AND code=$2 AND active', [businessId, String(code ?? '')]);
  if (!unit) fail('Choose one of this business\'s units');
  return unit;
}
// A tax slab chosen by id, or (older clients) a bare rate.
async function readTax(db, business, body, fallbackRate) {
  if (body.taxRateId !== undefined && body.taxRateId !== null && body.taxRateId !== '') {
    const slab = await repo.one(db, 'SELECT * FROM business_tax_rates WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.taxRateId, 'Tax rate')]);
    if (!slab) fail('Tax rate not found', 404);
    return { taxRateId: slab.id, rate: Number(slab.rate) };
  }
  const rate = decimal(body.taxRate ?? fallbackRate ?? 0, 'Tax rate', 2, 0, 100);
  const slab = await repo.one(db, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=$2 AND active ORDER BY is_default DESC,id LIMIT 1', [business.id, rate]);
  return { taxRateId: slab?.id || null, rate };
}
// An attribute that holds a figure (businessModules.js › figures): more than
// 0, up to two decimals; empty is none.
const readFigure = (value, name) => (value === undefined || value === null || value === '' ? null : String(decimal(value, name, 2, 0.01, 100000)));
// The figures of an item that may change after it is made (the calculators'
// coverage): those its business's modules allow; an empty one is removed.
async function updateFigures(db, business, current, given) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) fail('Attributes must be an object');
  const allowed = business.capabilities.flatMap((cap) => attributes[cap] || []).filter((key) => figures[key]);
  // A farm-input shop's classification is changed by its own service (updateCatalog).
  const classified = business.capabilities.includes('agri') ? attributes.agri : [];
  const next = { ...(current.attributes || {}) };
  for (const [key, value] of Object.entries(given)) {
    if (classified.includes(key)) continue;
    if (!allowed.includes(key)) fail(`Unsupported attribute: ${key}`);
    const figure = readFigure(value, figures[key]);
    if (figure === null) delete next[key];
    else next[key] = figure;
  }
  await db.query('UPDATE catalog_skus SET attributes=$3 WHERE business_id=$1 AND id=$2', [business.id, current.id, JSON.stringify(next)]);
  return next;
}
async function readCategory(db, businessId, value) {
  if (value === undefined || value === null || value === '') return null;
  const category = await repo.one(db, 'SELECT id FROM catalog_categories WHERE business_id=$1 AND id=$2 AND active', [businessId, id(value, 'Category')]);
  if (!category) fail('Category not found', 404);
  return category.id;
}
// A person tied to a department (Staff & access) changes its items only:
// an item is in the department of its category.
async function requireDepartmentItem(db, business, { categoryId = null, skuId = null }) {
  if (!business.member_department_id) return;
  const row = skuId
    ? await repo.one(db, `SELECT c.department_id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id WHERE s.business_id=$1 AND s.id=$2`, [business.id, skuId])
    : categoryId ? await repo.one(db, 'SELECT department_id FROM catalog_categories WHERE business_id=$1 AND id=$2', [business.id, categoryId]) : null;
  if (String(row?.department_id ?? '') !== String(business.member_department_id)) {
    fail(`You work in ${business.member_department_name || 'one department'}: this item is outside it`, 403);
  }
}

// Where an item sits in the shop ("Aisle 3 · Shelf B"); empty clears it.
const readShelf = (value) => v.optionalString(value, 'Shelf location', 40) || null;
// The price a loyalty customer pays: below the item's price, never above its
// MRP; empty clears it.
function readMemberPrice(value, price, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const member = decimal(value, 'Member price');
  if (member <= 0) fail('The member price must be more than zero');
  if (member >= price) fail(`The member price of ${label} must be below its price (${price.toFixed(2)})`);
  return member;
}

// extend(db, sku): a type module's own rows for the new item (book details),
// written in the same transaction.
async function createCatalog(business, user, body, extend) {
  await access.require(business, 'catalog.create');
  const caps = business.capabilities;
  const kind = v.requiredEnum(body.kind, 'Item kind', ['goods', 'service']);
  if (kind === 'goods' && !caps.includes('inventory')) fail('This business has no goods inventory capability');
  const tracking = kind === 'service' ? 'none' : v.requiredEnum(body.tracking, 'Stock tracking', ['quantity', 'batch', 'serial']);
  if (tracking === 'batch' && !caps.includes('batches')) fail('Batch tracking is not enabled');
  if (tracking === 'serial' && !caps.includes('serials')) fail('Serial tracking is not enabled');
  const allowed = caps.flatMap((cap) => attributes[cap] || []);
  if (body.attributes && (typeof body.attributes !== 'object' || Array.isArray(body.attributes))) fail('Attributes must be an object');
  const extra = {};
  for (const [key, value] of Object.entries(body.attributes || {})) {
    if (!allowed.includes(key)) fail(`Unsupported attribute: ${key}`);
    // A farm-input shop's classification is read by its own service (below).
    if (attributes.agri.includes(key)) continue;
    const text = figures[key] ? readFigure(value, figures[key]) : v.optionalString(value, key, 150);
    if (text) extra[key] = text;
  }
  const opening = readOpeningStock(body, tracking);
  if (opening) await access.require(business, 'inventory.edit');
  const barcode = readBarcode(body.barcode);
  return repo.transaction(async (db) => {
    // What kind of farm input it is (seeds, fertilisers & pesticides): checked against the molecule master.
    if (caps.includes('agri')) Object.assign(extra, await agriItems().classify(db, business, body.attributes || {}, { kind, tracking, opening, creating: true }));
    const unit = await readUnit(db, business.id, body.unit);
    const serviceUnit = ['time', 'service'].includes(unit.kind);
    if (tracking === 'serial' && unit.kind !== 'count') fail('Serialized items must be counted in whole units');
    if (kind === 'goods' && serviceUnit) fail('Goods require a stock unit');
    if (kind === 'service' && !serviceUnit) fail('Services require hour or service units');
    const tax = await readTax(db, business, body);
    const categoryId = await readCategory(db, business.id, body.categoryId);
    await requireDepartmentItem(db, business, { categoryId });
    let product;
    if (body.productId) {
      product = await repo.one(db, 'SELECT * FROM catalog_products WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.productId)]);
      if (!product || product.kind !== kind) fail('Matching product not found', 404);
      if (!caps.includes('variants')) fail('Product variants are not enabled');
    } else {
      // The legacy free-text category is still accepted from older clients.
      product = await repo.one(db, `INSERT INTO catalog_products(business_id,name,category,category_id,brand,kind) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [business.id, v.requiredString(body.name, 'Product name', 150), categoryId ? null : v.optionalString(body.category, 'Category', 100), categoryId, v.optionalString(body.brand, 'Brand', 100), kind]);
    }
    const label = v.requiredString(body.label || body.name, 'Sellable item name', 150);
    const price = decimal(body.price, 'Price');
    const mrp = readMrp(body.mrp);
    checkMrp(label, price, tax.rate, await saleTaxMode(db, business.id), mrp);
    const memberPrice = readMemberPrice(body.memberPrice, price, label);
    await barcodeFree(db, business.id, barcode);
    const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,barcode,label,unit,price,tax_rate,tax_rate_id,tracking,reorder_level,attributes,hsn_code,mrp,shelf_location,member_price,internal_use)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [business.id, product.id, v.requiredString(body.code, 'SKU code', 60).toUpperCase(), barcode,
      label, unit.code, price, tax.rate, tax.taxRateId,
      tracking, decimal(body.reorderLevel ?? 0, 'Reorder level', 3), JSON.stringify(extra), readHsn(body.hsnCode), mrp,
      readShelf(body.shelfLocation), memberPrice, kind === 'goods' && v.requiredBoolean(body.internalUse, 'For use in services only', false)]);
    if (extend) await extend(db, sku);
    else await books.fromAttributes(db, business, sku, extra);
    await repo.audit(db, business.id, user.id, 'catalog.created', sku.id);
    if (opening) {
      if (kind !== 'goods') fail('A service has no stock');
      const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, opening.locationId]);
      if (!location) fail('Location not found', 404);
      // The opening quantity is a correction with its own reason, on a new
      // lot at the cost typed: the ledger shows where the stock came from.
      const lot = await repo.one(db, `INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,expires_on,quantity,unit_cost)
        VALUES($1,$2,$3,$4,$5,0,$6) RETURNING *`, [business.id, location.id, sku.id, opening.lotCode, opening.expiresOn, opening.unitCost]);
      // Loaded here: the returns service needs this module first.
      const { applyAdjustment } = require('./businessReturns.service');
      const adjustment = await applyAdjustment(db, business, user, { ...lot, tracking, unit_decimals: unit.decimals, label }, opening.quantity, 'Opening stock', crypto.randomUUID());
      await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason: 'Opening stock', quantity: opening.quantity, label });
      await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id,
        { lotId: lot.id, skuId: sku.id, locationId: location.id, quantity: opening.quantity, reason: 'Opening stock' });
    }
    return sku;
  });
}
async function updateCatalog(business, user, skuId, body, inTransaction = null) {
  await access.require(business, 'catalog.edit');
  // `inTransaction`: the caller's own transaction (a hardware shop's rate board saves many items at once).
  const run = inTransaction ? (work) => work(inTransaction) : repo.transaction;
  return run(async (db) => {
    const current = await repo.one(db, 'SELECT s.*,p.category_id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id WHERE s.business_id=$1 AND s.id=$2 FOR UPDATE OF s',
      [business.id, id(skuId)]);
    if (!current) fail('Item not found', 404);
    await requireDepartmentItem(db, business, { skuId: current.id });
    if (body.categoryId !== undefined && body.categoryId) await requireDepartmentItem(db, business, { categoryId: id(body.categoryId) });
    const tax = await readTax(db, business, body, current.tax_rate);
    const label = v.requiredString(body.label, 'Name', 150);
    const price = decimal(body.price, 'Price');
    // Older clients send no HSN or MRP: those keep what the item has.
    const mrp = body.mrp === undefined ? current.mrp : readMrp(body.mrp);
    const hsn = body.hsnCode === undefined ? current.hsn_code : readHsn(body.hsnCode);
    // The barcode can be changed (or cleared); older clients send none.
    const barcode = body.barcode === undefined ? current.barcode : readBarcode(body.barcode);
    if (barcode !== current.barcode) await barcodeFree(db, business.id, barcode, current.id);
    checkMrp(label, price, tax.rate, await saleTaxMode(db, business.id), mrp);
    // Older clients send neither: the item keeps its shelf and member price
    // (a member price no longer below a lowered price is cleared).
    const shelf = body.shelfLocation === undefined ? current.shelf_location : readShelf(body.shelfLocation);
    const memberPrice = body.memberPrice === undefined
      ? (current.member_price !== null && Number(current.member_price) < price ? current.member_price : null)
      : readMemberPrice(body.memberPrice, price, label);
    const sku = await repo.one(db, `UPDATE catalog_skus SET label=$3,price=$4,tax_rate=$5,tax_rate_id=$6,active=$7,reorder_level=$8,hsn_code=$9,mrp=$10,barcode=$11,
      shelf_location=$12,member_price=$13,internal_use=$14
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, current.id, label,
      price, tax.rate, tax.taxRateId, v.requiredBoolean(body.active, 'Active', true),
      decimal(body.reorderLevel ?? current.reorder_level, 'Reorder level', 3), hsn, mrp, barcode, shelf, memberPrice,
      body.internalUse === undefined ? current.internal_use : v.requiredBoolean(body.internalUse, 'For use in services only')]);
    if (barcode !== current.barcode) await repo.audit(db, business.id, user.id, 'catalog.barcode_changed', current.id, { label, barcodeFrom: current.barcode || 'none', barcodeTo: barcode || 'none' });
    const memberText = (x) => (x === null || x === undefined ? null : Number(x).toFixed(2));
    if (Number(current.price) !== price || String(current.mrp ?? '') !== String(mrp ?? '') || memberText(current.member_price) !== memberText(memberPrice)) {
      await repo.audit(db, business.id, user.id, 'catalog.price_changed', current.id, { label, from: current.price, to: price.toFixed(2), mrpFrom: current.mrp, mrpTo: mrp === null ? null : Number(mrp).toFixed(2),
        memberFrom: memberText(current.member_price), memberTo: memberText(memberPrice) });
    }
    if (body.categoryId !== undefined) {
      await db.query('UPDATE catalog_products SET category_id=$3 WHERE business_id=$1 AND id=$2', [business.id, current.product_id, await readCategory(db, business.id, body.categoryId)]);
    }
    // Only figures change after an item is made (a hardware shop's coverage for the calculators),
    // and a farm-input shop's classification (agriItems.service.js keeps the change in the activity log).
    if (body.attributes !== undefined) sku.attributes = await updateFigures(db, business, current, body.attributes);
    if (body.attributes && business.capabilities.includes('agri') && attributes.agri.some((key) => key in body.attributes)) {
      sku.attributes = await agriItems().reclassify(db, business, user, { ...current, label: sku.label }, sku.attributes, body.attributes);
    }
    await repo.audit(db, business.id, user.id, 'catalog.updated', sku.id);
    return sku;
  });
}
async function createPriceRule(business, user, body) {
  await access.require(business, 'wholesale.edit');
  return repo.transaction(async (db) => {
    const sku = await repo.one(db, 'SELECT id FROM catalog_skus WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.skuId)]);
    if (!sku) fail('Item not found', 404);
    let contact = null;
    if (body.contactId) {
      contact = await repo.one(db, "SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, id(body.contactId)]);
      if (!contact) fail('Customer not found', 404);
    }
    // A slab may be set per pack ("5 cases or more"): minimum and price then count packs.
    let unitCode = null;
    if (body.unitCode !== undefined && body.unitCode !== null && body.unitCode !== '') {
      const pack = await repo.one(db, 'SELECT unit_code FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3 AND active', [business.id, sku.id, String(body.unitCode)]);
      if (!pack) fail('This item has no such pack size. Add it under Settings › Units & pack sizes first.', 404);
      unitCode = pack.unit_code;
    }
    const minimum = decimal(body.minimumQuantity, 'Minimum quantity', 3, 0.001, 100000);
    if (unitCode && !Number.isInteger(minimum)) fail('A pack slab starts at a whole number of packs');
    const rule = await repo.one(db, `INSERT INTO business_price_rules(business_id,sku_id,contact_id,minimum_quantity,unit_price,created_by,unit_code)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [business.id, sku.id, contact?.id || null,
      minimum, decimal(body.unitPrice, 'Unit price'), user.id, unitCode]);
    await repo.audit(db, business.id, user.id, 'price_rule.created', rule.id);
    return rule;
  });
}
async function disablePriceRule(business, user, ruleId) {
  await access.require(business, 'wholesale.edit');
  return repo.transaction(async (db) => {
    const rule = await repo.one(db, 'UPDATE business_price_rules SET active=false WHERE business_id=$1 AND id=$2 AND active RETURNING *', [business.id, id(ruleId)]);
    if (!rule) fail('Active price rule not found', 404);
    await repo.audit(db, business.id, user.id, 'price_rule.disabled', rule.id);
    return rule;
  });
}

// --- Sales and purchases ---------------------------------------------------

const kindPermission = (kind, action) => `${kind === 'sale' ? 'sales' : 'purchasing'}.${action}`;
const requiredDecimals = (quantity, unit, name) => {
  const places = (String(quantity).split('.')[1] || '').length;
  if (unit.decimals === 0 && !Number.isInteger(Number(quantity))) fail(`${name} must be a whole number of ${unit.name.toLowerCase()}`);
  if (places > unit.decimals) fail(`${name} can have at most ${unit.decimals} decimal places in ${unit.name.toLowerCase()}`);
};

// A line typed in another unit (2 boxes, 3 strips, 500 g) becomes a
// quantity in the SKU's stock unit. Returns the factor (stock units per
// entered unit) in millionths so the arithmetic stays exact.
async function conversion(db, businessId, sku, entered) {
  const pack = await repo.one(db, 'SELECT quantity_in_base FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3 AND active',
    [businessId, sku.id, entered.code]);
  if (pack) return Math.round(Number(pack.quantity_in_base) * 1e6);
  const base = await repo.one(db, 'SELECT * FROM business_units WHERE business_id=$1 AND code=$2', [businessId, sku.unit]);
  // Same kind, related through base units: g -> kg is 0.001, kg -> g is 1000.
  const root = (u) => u.base_unit_code || u.code;
  const toRoot = (u) => (u.base_unit_code ? Number(u.factor_to_base) : 1);
  if (base && entered.kind === base.kind && root(entered) === root(base)) return Math.round((toRoot(entered) / toRoot(base)) * 1e6);
  fail(`${sku.label} has no pack size in ${entered.name.toLowerCase()}. Add one under Settings › Units & pack sizes.`);
}

// Several payments on one bill (cash + UPI + card, the
// rest on udhaar). Each part is { method, amount, reference?, tendered? };
// "full" on one part means "the rest of the bill". Only cash can be handed
// over in excess (`tendered`): change is given back from cash alone.
// A part may name one of the business's payment methods (`methodId`): its
// kind and name are filled in when the bill is posted (settleParts).
const MAX_PAYMENT_PARTS = 8;
function readPaymentPart(part, name = 'Payment') {
  if (!part || typeof part !== 'object' || Array.isArray(part)) fail(`${name} must be an object`);
  const { methodId, method } = paymentMethods.readChoice(part, 'Payment method', methods);
  const amount = part.amount === 'full' ? 'full' : decimal(part.amount, 'Amount paid now', 2, 0, 100000000);
  let tendered = null;
  if (part.tendered !== undefined && part.tendered !== null && part.tendered !== '') {
    if (method !== 'cash' && !methodId) fail('Only cash is handed over in notes: change is given back from cash only');
    tendered = decimal(part.tendered, 'Cash handed over', 2, 0.01, 100000000);
    if (amount !== 'full' && paise(tendered) < paise(amount)) fail('The cash handed over is less than the cash part of the bill');
  }
  return { amount, method, methodId, reference: v.optionalString(part.reference, 'Payment reference', 100), tendered };
}
function readPayments(body) {
  const one = body.payment !== undefined && body.payment !== null;
  const many = body.payments !== undefined && body.payments !== null;
  if (one && many) fail('Send the payment or the list of payments, not both');
  if (one) {
    const part = readPaymentPart(body.payment);
    return part.amount === 'full' || part.amount > 0 ? [part] : [];
  }
  if (!many) return [];
  const parts = v.requiredArray(body.payments, 'Payments');
  if (parts.length > MAX_PAYMENT_PARTS) fail(`A bill takes at most ${MAX_PAYMENT_PARTS} payments`);
  const read = parts.map((part) => readPaymentPart(part)).filter((part) => part.amount === 'full' || part.amount > 0);
  if (read.filter((part) => part.amount === 'full').length > 1) fail('Only one payment can be "the rest of the bill"');
  return read;
}

async function document(business, user, body) {
  const kind = v.requiredEnum(body.kind, 'Document type', ['sale', 'purchase']);
  await access.require(business, kindPermission(kind, 'create'));
  const requestKey = uuid(body.requestKey);
  // The biller's PIN (counter) is checked, never stored, not even in the hash.
  const { counterPin, ...hashed } = body;
  const hash = crypto.createHash('sha256').update(JSON.stringify(hashed)).digest('hex');
  const lines = v.requiredArray(body.lines, 'Lines');
  if (!lines.length || lines.length > 100) fail('Add between 1 and 100 lines');
  const parts = readPayments(body);
  if (parts.length) await access.require(business, kindPermission(kind, 'edit'));
  // Sites and fitters are a hardware shop's; its own service checks them with the bill.
  if ((named(body.siteId) || named(body.fitterId)) && (kind !== 'sale' || business.business_type !== 'hardware')) fail('Sites and fitters belong to a hardware shop\'s sales');
  // A goods shop's walk-in pays the whole bill now: udhaar needs a named customer.
  const walkInPays = kind === 'sale' && GOODS_TYPES.includes(business.business_type);
  // An exchange credit voucher spent on this sale (fashion / electronics).
  const voucher = kind === 'sale' ? exchangeVouchers().readInput(body.voucher) : null;
  if (voucher) await access.require(business, kindPermission(kind, 'edit'));
  // EMI through a financier (electronics).
  const finance = kind === 'sale' ? financeSales().readInput(body.finance) : null;
  if (finance) {
    await access.require(business, 'finance.create');
    await access.require(business, kindPermission(kind, 'edit'));
  }
  // Quick bill on a shared till: the biller's PIN for every bill, when the
  // business asks for it (per-staff PIN).
  if (kind === 'sale' && body.channel === 'counter') await counterPins().checkBill(business, user, counterPin);
  return repo.transaction((db) => postDocument(db, business, user, body, { kind, requestKey, hash, lines, paidNow: parts, walkInPays, voucher, finance }));
}
// Optional on a purchase: the supplier's own bill number and date.
function supplierBill(body, kind, today) {
  const number = v.optionalString(body.supplierBillNo, 'Supplier bill number', 60);
  const date = body.supplierBillDate ? dateText(body.supplierBillDate, 'Supplier bill date') : null;
  if (kind !== 'purchase') {
    if (number || date) fail('A supplier bill number belongs on a purchase');
    return { number: null, date: null };
  }
  if (date && !number) fail('Enter the supplier bill number with its date');
  if (date && date > today) fail('The supplier bill date cannot be in the future');
  return { number, date };
}
// Optional on a sale: the name and phone of a walk-in who is not saved as a
// customer (used for a warranty).
function readBuyer(body) {
  if (body.buyer === undefined || body.buyer === null) return null;
  if (typeof body.buyer !== 'object' || Array.isArray(body.buyer)) fail('Buyer must be an object');
  const name = v.optionalString(body.buyer.name, 'Buyer name', 150);
  const phone = v.optionalString(body.buyer.phone, 'Buyer phone', 30);
  return name || phone ? { name, phone } : null;
}
// The buyer's PAN typed on a bill, or that they have none and made a declaration (Form 97).
function readBuyerPan(body) {
  const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
  const pan = readPan(buyer.pan, 'Buyer PAN');
  const declaration = v.requiredBoolean(buyer.panDeclaration, 'PAN declaration', false);
  if (pan && declaration) fail('Give the buyer\'s PAN or record their declaration, not both');
  return { pan, declaration };
}
// A sale over ₹2,00,000 records the buyer's PAN (income-tax rules on quoting PAN).
const PAN_ABOVE_PAISE = 20000000;
// Electronics: a sold serial unit's warranty is registered with the sale.
const electronicsWarranties = () => require('../../fashion-electronics/services/businessElectronics.service');
// Wholesale invoice extras (loaded when first needed: it requires this file).
const wholesaleDelivery = () => require('../../wholesale/services/businessWholesaleDelivery.service');
// Fashion / electronics: credit vouchers and apparel GST by price per piece.
const exchangeVouchers = () => require('../../fashion-electronics/services/businessVouchers.service');
const fashionPricing = () => require('../../fashion-electronics/services/businessFashionMerchandising.service');
// EMI sales, kits, and the counter's per-staff PIN.
const financeSales = () => require('../../fashion-electronics/services/businessFinance.service');
const kits = () => require('./businessKits.service');
const counterPins = () => require('./businessCounter.service');
// A hardware shop's bill: the site it goes to and the fitter who brought it.
const hardwareSales = () => require('../../hardware/services/hardwareSales.service');
// A seeds, fertilisers & pesticides shop's items and bills: classification,
// the licence, molecule, crop and seed-lot checks, PoS receipts and season credit.
const agriItems = () => require('../../agri/services/agriItems.service');
const agriSales = () => require('../../agri/services/agriSales.service');
const named = (value) => value !== undefined && value !== null && value !== '';
// Posts a sale or purchase inside the caller's transaction. Permissions and
// the request are checked by the caller. `fixed` (used by wholesale
// dispatch) gives each line's prices already worked out: { price (stock unit,
// rupees), net, tax, enteredPrice (paise), priceRuleId } — the order's prices.
// `quote` (retail counter): work out the bill exactly as posting would —
// prices, offers, points, tax, round-off — and return it without saving.
// `quote: 'estimate'` (a quotation) does the same before any batch or serial
// is chosen: batch and serial items need none, and a serial item may be
// several units on one line.
// `paidNow`: null, one payment { amount, method, reference } or a list of them
// (split payment). `finance`: an EMI sale's financier part.
// Free units and trade discount on a purchase line, in the line's own unit
// (packs when it is entered in packs). null when neither is given.
function readScheme(input) {
  const given = (value) => value !== undefined && value !== null && String(value).trim() !== '' && Number(value) !== 0;
  if (!given(input?.freeQuantity) && !given(input?.discountPercent)) return null;
  const paid = decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
  const free = given(input.freeQuantity) ? decimal(input.freeQuantity, 'Free quantity', 3, 0, 100000) : 0;
  const discount = given(input.discountPercent) ? decimal(input.discountPercent, 'Discount %', 2, 0, 99.99) : 0;
  const paidMilli = milli(paid), totalMilli = milli(paid) + milli(free);
  return { free: free > 0, freeEntered: free, discount, discountBasis: Math.round(discount * 100), paidMilli, totalMilli, totalText: String(totalMilli / 1000) };
}

async function postDocument(db, business, user, body, { kind, requestKey, hash, lines: inputLines, paidNow, fixed = null, quote = false, walkInPays = false, voucher = null, finance = null }) {
  {
    // Serializes document posting within a business: one lock order for every
    // posting (business, then document, then stock lots).
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = quote ? null : await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const settings = await repo.one(db, 'SELECT tax_mode,rounding,state_code,walk_in_credit FROM business_settings WHERE business_id=$1', [business.id]);
    // Purchase costs are always entered before tax; the setting is about selling prices.
    const taxMode = kind === 'sale' ? settings?.tax_mode || 'exclusive' : 'exclusive';
    const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId)]);
    if (!location) fail('Location not found', 404);
    let contact = null;
    if (body.contactId) {
      contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND active FOR UPDATE', [business.id, id(body.contactId)]);
      if (!contact || contact.kind !== (kind === 'sale' ? 'customer' : 'supplier')) fail('Matching contact not found', 404);
    }
    if (kind === 'purchase' && !contact) fail('Select a supplier');
    const buyer = kind === 'sale' ? readBuyer(body) : null;
    const estimate = quote === 'estimate';
    // A kit sells as its components: each takes its share of the kit's price.
    // `lines` are then the component lines; `kitOf[i]` says which.
    const { lines, kitOf } = await kits().expand(db, business, inputLines, { kind, contact, taxMode, locationId: location.id, fixed });
    let subtotal = 0, tax = 0;
    // Purchase lines may also set the item's new selling price and MRP.
    const priceUpdates = [];
    const prepared = [];
    for (const [lineIndex, rawInput] of lines.entries()) {
      // A supplier's bill line: free units on a scheme ("10 + 1 free") and a
      // trade discount on the rate. The line takes in paid + free units and
      // is charged for the paid ones, less the discount.
      const scheme = kind === 'purchase' ? readScheme(rawInput) : null;
      if (kind !== 'purchase' && (Number(rawInput?.freeQuantity || 0) || Number(rawInput?.discountPercent || 0))) fail('Free quantity and trade discount are for purchases');
      const input = scheme?.free ? { ...rawInput, quantity: scheme.totalText } : rawInput;
      const sku = await repo.one(db, `SELECT s.*,p.kind,u.decimals AS unit_decimals,u.name AS unit_name FROM catalog_skus s
       JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
       JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
       WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(input.skuId)]);
      if (!sku) fail('Item not found', 404);
      if (kind === 'purchase' && sku.kind === 'service') fail('Services cannot be received into stock');
      if (kind === 'sale' && sku.internal_use) fail(`${sku.label} is kept for use in services only and is not sold. Untick "For use in services only" on the item to sell it.`, 409);
      const baseUnit = { decimals: sku.unit_decimals, name: sku.unit_name };
      let quantity, entered = null, factorMicro = 1000000;
      if (input.unit && input.unit !== sku.unit) {
        const enteredUnit = await readUnit(db, business.id, input.unit);
        const enteredQuantity = decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
        requiredDecimals(input.quantity, enteredUnit, 'Quantity');
        factorMicro = await conversion(db, business.id, sku, enteredUnit);
        const baseMilli = BigInt(milli(enteredQuantity)) * BigInt(factorMicro);
        if (baseMilli % 1000000n !== 0n) fail(`${input.quantity} ${enteredUnit.name.toLowerCase()} does not make an exact quantity in ${sku.unit_name.toLowerCase()}`);
        quantity = Number(baseMilli / 1000000n) / 1000;
        if (quantity <= 0 || quantity > 100000) fail('Quantity must be between 0.001 and 100000 in the stock unit');
        entered = { unit: enteredUnit.code, quantity: enteredQuantity };
      } else {
        quantity = decimal(input.quantity, 'Quantity', 3, 0.001, 100000);
      }
      requiredDecimals(quantity, baseUnit, 'Quantity');
      if (sku.tracking === 'serial' && quantity !== 1 && !estimate) fail('Enter each serial number on its own line');
      const preset = fixed?.[lineIndex] || null;
      const kit = kitOf[lineIndex] || null;
      let priceRule = null, priceKind = null;
      let price, net, enteredPrice = null;
      if (kit) {
        // A component's share of the kit's price, in the document's price terms.
        net = kit.share; price = kit.share / 100 / quantity;
      } else if (preset) {
        price = preset.price; net = preset.net; enteredPrice = entered ? preset.enteredPrice : null;
        priceRule = preset.priceRuleId ? { id: preset.priceRuleId } : null;
      } else if (kind === 'sale') {
        // Customer, slab and pack prices (services/businessPricing.js).
        const priced = await pricing.salePrice(db, business, sku, contact?.id, quantity, entered && { ...entered, factorMicro },
          { locationId: location.id, member: Boolean(contact) && business.capabilities.includes('loyalty') });
        priceRule = priced.rule; price = priced.stockPrice; net = priced.net; enteredPrice = priced.enteredPrice; priceKind = priced.priceKind;
      } else if (entered) {
        // A purchase in packs is costed per pack; the stock cost per unit follows from it.
        enteredPrice = paise(decimal(input.unitPrice, 'Purchase unit cost'));
        net = roundedDivide(BigInt(enteredPrice) * BigInt(milli(entered.quantity)), 1000n);
        price = roundedDivide(BigInt(enteredPrice) * 1000000n, BigInt(factorMicro)) / 100;
      } else {
        price = decimal(input.unitPrice, 'Purchase unit cost');
        net = lineNet(price, quantity);
      }
      // Charged for the paid units only, less the trade discount.
      if (scheme && (scheme.free || scheme.discountBasis)) {
        if (scheme.free && (sku.tracking === 'serial')) fail('Free serial-numbered units are received on their own lines at no cost');
        net = roundedDivide(BigInt(net) * BigInt(scheme.paidMilli) * BigInt(10000 - scheme.discountBasis), BigInt(scheme.totalMilli) * 10000n);
      }
      // Nothing is billed above its MRP (a wholesale dispatch keeps its order's prices).
      if (kind === 'sale' && !preset && !kit) checkMrp(sku.label, price, sku.tax_rate, taxMode, sku.mrp);
      if (kind === 'purchase' && ((input.sellingPrice ?? '') !== '' || (input.mrp ?? '') !== '')) {
        const newPrice = (input.sellingPrice ?? '') === '' ? Number(sku.price) : decimal(input.sellingPrice, 'New selling price');
        const newMrp = (input.mrp ?? '') === '' ? sku.mrp : readMrp(input.mrp);
        priceUpdates.push({ sku, price: newPrice, mrp: newMrp });
      }
      // Cost of one stock unit on this line, to four places (exact for packs).
      const stockCost = kind !== 'purchase' ? null : entered || scheme?.free || scheme?.discountBasis ? (net / 100) / quantity : price;
      const lotCode = (sku.tracking === 'batch' || sku.tracking === 'serial') && !estimate ? v.requiredString(input.lotCode, 'Batch / serial number', 100) : '';
      let expiresOn = null;
      if (input.expiresOn) expiresOn = dateText(input.expiresOn, 'Expiry date');
      if (kind === 'purchase' && business.business_type === 'pharmacy' && sku.tracking !== 'batch') fail('Pharmacy goods must use batch tracking');
      if (kind === 'purchase' && business.business_type === 'pharmacy' && !expiresOn) fail('Pharmacy receipts require an expiry date');
      // `amount`: the line at its price, in the document's price terms. Net
      // and tax are split below, once offers have been applied.
      prepared.push({ sku, quantity, price, priceKind, amount: net, freeQuantity: scheme?.freeEntered || 0, discountPercent: scheme?.discount || 0, preset, kit, inputIndex: kit ? kit.inputIndex : kits().inputIndexOf(kitOf, lineIndex), lotCode, expiresOn, priceRule, entered, enteredPrice, factorMicro, stockCost });
    }
    // Offers and redeemed loyalty points (retail modules, businessOffers.js)
    // come off sale lines before GST is worked out on what is left. Lines
    // with fixed prices (a dispatched order) keep theirs.
    const offers = kind === 'sale' ? await retailOffers.priceSale(db, business, { contact, lines: prepared, body, taxMode }) : null;
    if (offers) await salonSales.priceSale(db, business, { contact, lines: prepared, body, pricing: offers });
    // Apparel GST by the value of each piece after discounts (fashion).
    if (kind === 'sale' && business.business_type === 'fashion') await fashionPricing().applyPriceSlabs(db, business, prepared, offers?.perLine, taxMode);
    for (const [index, line] of prepared.entries()) {
      if (line.preset) {
        line.net = line.amount; line.tax = line.preset.tax;
      } else {
        const amount = line.amount - (offers?.perLine[index] || 0);
        if (taxMode === 'inclusive') {
          line.net = inclusiveNet(amount, Number(line.sku.tax_rate));
          line.tax = amount - line.net;
        } else {
          line.net = amount; line.tax = lineTax(amount, Number(line.sku.tax_rate));
        }
      }
      subtotal += line.net; tax += line.tax;
      if (!Number.isSafeInteger(subtotal + tax) || subtotal + tax > 100000000000) fail('Document total exceeds the supported limit');
    }
    const raw = subtotal + tax;
    const rounded = kind === 'sale' && settings?.rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw;
    const roundOff = rounded - raw;
    if (quote) return retailOffers.quoteOf({ prepared, offers, subtotal, tax, roundOff, rounded, taxMode, contact });
    // A farm-input shop's sale: every fertiliser, seed and pesticide line is
    // checked before anything is saved (licence, molecules, crop, seed lot,
    // PoS receipt); its receipts bring seed lots in with their validity.
    const agri = kind === 'sale' && agriSales().applies(business) ? await agriSales().checkSale(db, business, { prepared, body, location, contact }) : null;
    if (!agri && agriSales().given(body)) fail('Crops, PoS receipts and season credit go on the sales of a seeds, fertilisers & pesticides shop with its tools switched on');
    if (kind === 'purchase' && agriSales().applies(business)) agriSales().checkPurchase(prepared);
    // A credit voucher pays first; "full" is then what is left.
    const voucherUse = voucher ? await exchangeVouchers().prepare(db, business, voucher, rounded) : null;
    const prepaid = voucherUse?.amount || 0;
    // The payments taken now (one or several), and an EMI's financed part.
    let parts = (Array.isArray(paidNow) ? paidNow : paidNow ? [paidNow] : []).map((part) => ({ ...part }));
    parts = await paymentMethods.settleParts(db, business.id, parts);
    const fixedPaid = parts.filter((part) => part.amount !== 'full').reduce((sum, part) => sum + paise(part.amount), 0);
    const financeUse = finance ? await financeSales().prepare(db, business, finance, { contact, buyer, left: rounded - prepaid - fixedPaid, hasFull: parts.some((part) => part.amount === 'full') }) : null;
    const financed = financeUse?.amount || 0;
    const rest = rounded - prepaid - fixedPaid - financed;
    parts = parts.map((part) => (part.amount === 'full' ? { ...part, amount: rest > 0 ? Number(money(rest)) : 0 } : part)).filter((part) => paise(part.amount) > 0);
    for (const part of parts) {
      if (part.tendered !== null && part.tendered !== undefined && paise(part.tendered) < paise(part.amount)) fail('The cash handed over is less than the cash part of the bill');
    }
    const paidPaise = parts.reduce((sum, part) => sum + paise(part.amount), 0);
    if (paidPaise + prepaid + financed > rounded) fail(parts.length > 1 ? 'The payments add up to more than the total' : 'The amount paid now is more than the total');
    if (walkInPays && !settings?.walk_in_credit && !contact && rounded > 0 && paidPaise + prepaid + financed < rounded) {
      fail('A walk-in customer pays the whole bill now. To give udhaar, choose the customer first.', 409);
    }
    // Season credit (a farm-input shop): a named customer's bill left on credit.
    if (agri) agriSales().checkCredit(agri, { contact, unpaid: rounded - paidPaise - prepaid - financed });
    // Credit limit: what this customer would owe after this sale, less what they pay now.
    if (kind === 'sale' && contact?.credit_limit !== null && contact?.credit_limit !== undefined) {
      const owed = await repo.one(db, `SELECT ${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, contact.id]);
      const after = paise(Number(owed.balance)) + rounded - paidPaise - prepaid - financed;
      if (after > paise(Number(contact.credit_limit))) {
        fail(`This sale would take ${contact.name} to ${money(after)} owed, over their credit limit of ${Number(contact.credit_limit).toFixed(2)}. Take a payment now or raise the limit.`, 409);
      }
    }
    const today = await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date AS day', [business.timezone]);
    // A season credit bill falls due at the harvest date given on it.
    const dueOn = agri?.dueOn ? { day: agri.dueOn }
      : contact?.credit_days ? await repo.one(db, 'SELECT ($1::date + $2::int)::text AS day', [today.day, contact.credit_days]) : today;
    const bill = supplierBill(body, kind, today.day);
    if (bill.number) {
      const same = await repo.one(db, 'SELECT document_no FROM business_documents WHERE business_id=$1 AND contact_id=$2 AND upper(supplier_bill_no)=upper($3)', [business.id, contact.id, bill.number]);
      if (same) fail(`Bill ${bill.number} from ${contact.name} was already received as ${same.document_no}`, 409);
    }
    if (priceUpdates.length) await access.require(business, 'catalog.edit');
    // GST: the buyer as they were when billed, and where the supply is made
    // (the buyer's GSTIN state, otherwise the selling location's own state,
    // otherwise the business's: a branch in another state supplies from there).
    const buyerGstin = kind === 'sale' ? contact?.gstin || null : null;
    const placeOfSupply = kind === 'sale' ? (buyerGstin ? buyerGstin.slice(0, 2) : location.state_code || settings?.state_code || null) : null;
    // The buyer's PAN: typed on the bill or saved with the customer. A sale
    // over ₹2,00,000 must have one (or the PAN inside the customer's GSTIN, or
    // on their wholesale profile), or the buyer's declaration that they have none.
    let buyerPan = null, panDeclaration = false;
    if (kind === 'sale') {
      const typed = readBuyerPan(body);
      buyerPan = typed.pan || contact?.pan || null;
      if (rounded > PAN_ABOVE_PAISE && !buyerPan) {
        const inGstin = buyerGstin ? buyerGstin.slice(2, 12) : null;
        buyerPan = inGstin && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(inGstin) ? inGstin : null;
        if (!buyerPan && contact) buyerPan = (await repo.one(db, 'SELECT pan FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]))?.pan || null;
      }
      panDeclaration = !buyerPan && typed.declaration;
      if (rounded > PAN_ABOVE_PAISE && !buyerPan && !panDeclaration) {
        fail('A bill over ₹2,00,000 needs the buyer\'s PAN: type it on the bill, or choose the customer with their PAN or GSTIN saved. A buyer who has no PAN signs a declaration (Form 97): record it on the bill instead.');
      }
    }
    const number = await numbering.nextNumber(db, business.id, location.id, kind, user.id);
    const saved = await repo.one(db, `INSERT INTO business_documents(business_id,location_id,kind,document_no,series_id,contact_id,contact_name,subtotal,tax,round_off,total,tax_mode,due_on,request_key,request_hash,notes,created_by,
      place_of_supply,buyer_gstin,buyer_address,supplier_bill_no,supplier_bill_date,buyer_pan,pan_declaration)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    [business.id, location.id, kind, number.number, number.seriesId, contact?.id || null, contact?.name || null,
      money(subtotal), money(tax), money(roundOff), money(rounded), taxMode, dueOn.day, requestKey, hash, v.optionalString(body.notes, 'Notes', 500), user.id,
      placeOfSupply, buyerGstin, kind === 'sale' ? contact?.address || null : null, bill.number, bill.date, buyerPan, panDeclaration]);
    for (const line of prepared) {
      const savedLine = await repo.one(db, `INSERT INTO business_document_lines(business_id,document_id,sku_id,label,unit,quantity,unit_price,tax_rate,net,tax,lot_code,price_rule_id,
        entered_unit,entered_quantity,entered_unit_price,unit_factor,hsn_code,mrp,kit_sku_id,kit_label,kit_group,free_quantity,discount_percent)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`, [business.id, saved.id, line.sku.id, line.sku.label, line.sku.unit,
        line.quantity, rateText(line.price, Boolean(line.preset || line.kit)), line.sku.tax_rate, money(line.net), money(line.tax), line.lotCode, line.priceRule?.id || null,
        line.entered?.unit || null, line.entered?.quantity ?? null, line.entered ? money(line.enteredPrice) : null, line.entered ? (line.factorMicro / 1e6).toFixed(6) : null,
        line.sku.hsn_code || null, line.kit ? null : line.sku.mrp ?? null, line.kit?.skuId || null, line.kit?.label || null, line.kit?.group || null,
        line.freeQuantity || 0, line.discountPercent || 0]);
      line.id = savedLine.id;
      if (line.sku.tracking === 'none') continue;
      if (kind === 'purchase') {
        if (line.sku.tracking === 'serial') {
          const exists = await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [business.id, line.sku.id, line.lotCode]);
          if (exists) fail('This serial number has already been received', 409);
        }
        const lot = await repo.one(db, `SELECT * FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4 FOR UPDATE`,
          [business.id, location.id, line.sku.id, line.lotCode]);
        if (lot && (lot.expires_on || null) !== line.expiresOn) fail('A batch cannot have conflicting expiry dates', 409);
        const updated = await repo.one(db, `INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,expires_on,quantity,unit_cost)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(business_id,location_id,sku_id,lot_code) DO UPDATE SET
         unit_cost=(business_stock_lots.quantity*business_stock_lots.unit_cost+EXCLUDED.quantity*EXCLUDED.unit_cost)/(business_stock_lots.quantity+EXCLUDED.quantity),
         quantity=business_stock_lots.quantity+EXCLUDED.quantity RETURNING *`,
        [business.id, location.id, line.sku.id, line.lotCode, line.expiresOn, line.quantity, line.stockCost.toFixed(4)]);
        await movement(db, business.id, updated.id, saved.id, line.quantity, updated.quantity);
        await db.query('UPDATE business_document_lines SET stock_unit_cost=$3 WHERE business_id=$1 AND id=$2', [business.id, savedLine.id, line.stockCost.toFixed(4)]);
      } else {
        const lot = await repo.one(db, `SELECT * FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4
         AND (expires_on IS NULL OR expires_on >= (now() AT TIME ZONE $5)::date) FOR UPDATE`,
        [business.id, location.id, line.sku.id, line.lotCode, business.timezone]);
        if (!lot || milli(Number(lot.quantity)) < milli(line.quantity)) fail(`Not enough usable stock for ${line.sku.label}`, 409);
        const updated = await repo.one(db, 'UPDATE business_stock_lots SET quantity=quantity-$3 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, lot.id, line.quantity]);
        await movement(db, business.id, lot.id, saved.id, -line.quantity, updated.quantity);
        await db.query('UPDATE business_document_lines SET stock_unit_cost=$3 WHERE business_id=$1 AND id=$2', [business.id, savedLine.id, lot.unit_cost]);
      }
    }
    if (offers) await retailOffers.recordSale(db, business, user, saved, prepared, offers);
    if (offers) await salonSales.recordSale(db, business, user, saved, prepared, offers);
    if (kind === 'sale' && (named(body.siteId) || named(body.fitterId))) await hardwareSales().recordSale(db, business, user, saved, prepared, body);
    // A farm-input shop's lines as billed (input, PoS receipt, crop) and its season or walk-in farmer.
    if (agri) await agriSales().recordSale(db, business, user, saved, agri);
    // New shelf prices from this receipt (the person may change the catalogue).
    if (priceUpdates.length) {
      const saleMode = settings?.tax_mode || 'exclusive';
      for (const update of priceUpdates) {
        checkMrp(update.sku.label, update.price, update.sku.tax_rate, saleMode, update.mrp);
        await db.query('UPDATE catalog_skus SET price=$3,mrp=$4 WHERE business_id=$1 AND id=$2', [business.id, update.sku.id, update.price.toFixed(2), update.mrp ?? null]);
        await repo.audit(db, business.id, user.id, 'catalog.price_changed', update.sku.id, { label: update.sku.label, from: update.sku.price, to: update.price.toFixed(2),
          mrpFrom: update.sku.mrp, mrpTo: update.mrp === null || update.mrp === undefined ? null : Number(update.mrp).toFixed(2), documentNo: saved.document_no });
      }
    }
    await repo.audit(db, business.id, user.id, `${kind}.posted`, saved.id, { total: saved.total, documentNo: saved.document_no });
    await repo.event(db, business.id, user.id, `${kind}.posted`, 'document', saved.id, {
      documentNo: saved.document_no, locationId: location.id, contactId: contact?.id || null, total: saved.total,
      lines: prepared.map((l) => ({ skuId: l.sku.id, quantity: l.quantity, lotCode: l.lotCode || null })),
    });
    if (voucherUse) await exchangeVouchers().spend(db, business, user, saved, voucherUse, recordPayment);
    let change = 0;
    for (const part of parts) {
      await recordPayment(db, business, user, saved, { ...part, key: crypto.randomUUID() });
      if (part.tendered !== null && part.tendered !== undefined) change += paise(part.tendered) - paise(part.amount);
    }
    const financeCase = financeUse ? await financeSales().record(db, business, user, saved, financeUse, { downPayment: paidPaise + prepaid, recordPayment }) : null;
    const extras = { ...(change > 0 ? { change: money(change) } : {}), ...(financeCase ? { financeCase } : {}) };
    if (kind === 'sale' && business.modules.includes('warranties') && prepared.some((l) => l.sku.tracking === 'serial')) {
      const warranties = await electronicsWarranties().registerOnSale(db, business, user, saved, prepared, { contact, buyer });
      return { ...saved, ...extras, warranties };
    }
    return { ...saved, ...extras };
  }
}
async function movement(db, businessId, lotId, documentId, quantity, balance) {
  await db.query('INSERT INTO business_stock_movements(business_id,lot_id,document_id,quantity,balance_after) VALUES($1,$2,$3,$4,$5)', [businessId, lotId, documentId, quantity, balance]);
}
async function detail(business, documentId) {
  const doc = await repo.one(repo.pool, `SELECT d.*,l.name AS location_name,l.code AS location_code,c.gstin AS contact_gstin,c.phone AS contact_phone,c.address AS contact_address,
    to_jsonb(l) AS location
    FROM business_documents d JOIN business_locations l ON l.business_id=d.business_id AND l.id=d.location_id
    LEFT JOIN business_contacts c ON c.business_id=d.business_id AND c.id=d.contact_id WHERE d.business_id=$1 AND d.id=$2`, [business.id, id(documentId)]);
  if (!doc) fail('Document not found', 404);
  await access.require(business, kindPermission(doc.kind, 'view'));
  access.requireLocation(business, doc.location_id);
  const [lines, payments, returns, refunds, returnedLines, settings, retail, wholesale] = await Promise.all([
    repo.all(repo.pool, 'SELECT * FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]),
    repo.all(repo.pool, 'SELECT * FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]),
    repo.all(repo.pool, 'SELECT * FROM business_returns WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]),
    repo.all(repo.pool, 'SELECT * FROM business_refunds WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]),
    repo.all(repo.pool, `SELECT rl.line_id,sum(rl.quantity) AS quantity FROM business_return_lines rl
      JOIN business_returns r ON r.business_id=rl.business_id AND r.id=rl.return_id WHERE r.business_id=$1 AND r.document_id=$2 GROUP BY rl.line_id`, [business.id, doc.id]),
    repo.one(repo.pool, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]),
    // Offers and points on a retail sale (what each line was given).
    doc.kind === 'sale' ? retailOffers.saleExtras(repo.pool, business.id, doc.id) : null,
    // A dispatched sales order: order, transport, e-way bill, line discounts and free goods.
    doc.kind === 'sale' && business.modules.includes('sales_orders') ? wholesaleDelivery().invoiceExtras(repo.pool, business.id, doc.id) : null,
  ]);
  // The buyer as billed (older documents have no snapshot: the contact as it is now).
  const buyer = { contact_gstin: doc.buyer_gstin || doc.contact_gstin, contact_address: doc.buyer_address || doc.contact_address };
  // An EMI bill's finance case.
  const finance = doc.kind === 'sale' && payments.some((p) => p.method === 'finance') ? await financeSales().ofDocument(repo.pool, business.id, doc.id) : [];
  // A pharmacy bill also prints its drug licences, the pharmacist and the prescription (health module).
  const pharmacy = doc.kind === 'sale' && business.business_type === 'pharmacy' ? await require('../../health/services/businessPharmacy.service').invoiceExtras(repo.pool, business, doc.id) : null;
  // A hardware bill shows its site and its fitter; the invoice prints the site.
  const hardware = doc.kind === 'sale' && business.business_type === 'hardware' ? await hardwareSales().invoiceExtras(repo.pool, business, doc.id) : null;
  // A farm-input shop's bill: PoS receipts, crops, the season, the farmer and the licences it prints.
  const agri = doc.kind === 'sale' && business.business_type === 'agri_inputs' ? await agriSales().invoiceExtras(repo.pool, business, doc) : null;
  return { ...doc, ...buyer, finance, pharmacy, hardware, agri, lines: lines.map((line) => ({ ...line, returned_quantity: returnedLines.find((r) => r.line_id === line.id)?.quantity || '0' })), payments, returns, refunds, seller: branchSeller(settings, doc.location), retail, wholesale };
}
// The seller as a bill prints it: Business settings, with the selling
// location's own address, phone, state and GSTIN where it has them (a
// separately registered branch). `branch_name` names the branch on the bill
// when it has its own address or GSTIN.
function branchSeller(settings, location) {
  const seller = { ...settings };
  if (!location) return seller;
  const ownAddress = [location.address_line1, location.address_line2, location.city, location.postal_code].some(Boolean);
  if (ownAddress) Object.assign(seller, { address_line1: location.address_line1, address_line2: location.address_line2, city: location.city, postal_code: location.postal_code });
  if (location.state_code) seller.state_code = location.state_code;
  if (location.gstin) seller.gstin = location.gstin;
  if (location.phone) seller.phone = location.phone;
  if (ownAddress || location.gstin) seller.branch_name = location.name;
  return seller;
}
// Inside a posting transaction: the document is already locked.
// collectionId: the shared collection receipt this money came from (receivables).
// supplierPaymentId: the supplier payment voucher it came from (payables).
// methodName: the business's own name for the method (NULL from older screens).
// Money from a collection receipt carries the receipt's method name.
async function recordPayment(db, business, user, doc, { amount, method, methodName, reference, key, collectionId = null, supplierPaymentId = null, tendered = null }) {
  if (methodName === undefined && collectionId) {
    const receipt = await repo.one(db, 'SELECT method,method_name FROM business_collections WHERE business_id=$1 AND id=$2', [business.id, collectionId]);
    methodName = receipt?.method === method ? receipt.method_name : null;
  }
  const sums = await repo.one(db, `SELECT
    COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
    COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
    COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded`, [business.id, doc.id]);
  if (paise(amount) + paise(sums.paid) - paise(sums.refunded) > paise(doc.total) - paise(sums.returned)) fail('Payment exceeds the outstanding amount', 409);
  const result = await repo.one(db, `INSERT INTO business_payments(business_id,document_id,amount,method,reference,request_key,created_by,collection_id,supplier_payment_id,tendered,method_name)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [business.id, doc.id, amount, method, reference, key, user.id, collectionId, supplierPaymentId, tendered ?? null, methodName ?? null]);
  await repo.audit(db, business.id, user.id, 'payment.recorded', result.id, { documentId: doc.id, amount, ...(methodName ? { method, methodName } : {}), ...(collectionId ? { collectionId } : {}), ...(supplierPaymentId ? { supplierPaymentId } : {}) });
  await repo.event(db, business.id, user.id, 'payment.recorded', 'payment', result.id, { documentId: doc.id, documentNo: doc.document_no, kind: doc.kind, amount: result.amount, method, ...(methodName ? { methodName } : {}) });
  return result;
}
async function payment(business, user, documentId, body) {
  const amount = decimal(body.amount, 'Payment amount', 2, 0.01);
  const choice = paymentMethods.readChoice(body, 'Payment method', methods);
  const key = uuid(body.requestKey);
  const reference = v.optionalString(body.reference, 'Reference', 100);
  return repo.transaction(async (db) => {
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(documentId)]);
    if (!doc) fail('Document not found', 404);
    await access.require(business, kindPermission(doc.kind, 'edit'));
    access.requireLocation(business, doc.location_id);
    const old = await repo.one(db, 'SELECT * FROM business_payments WHERE business_id=$1 AND request_key=$2', [business.id, key]);
    if (old) {
      // A retry is the same payment (a named method sent alone has no kind to compare yet).
      const sameMethod = !choice.method || old.method === choice.method;
      if (old.document_id !== doc.id || Number(old.amount) !== amount || !sameMethod || old.reference !== reference) fail('Payment request key already used', 409);
      return old;
    }
    const { method, methodName } = await paymentMethods.settle(db, business.id, choice, 'Payment method', methods);
    return recordPayment(db, business, user, doc, { amount, method, methodName, reference, key });
  });
}

// --- Appointments ----------------------------------------------------------

async function resource(business, user, body) {
  await access.require(business, 'appointments.create');
  return repo.transaction(async (db) => {
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId)]);
    if (!location) fail('Location not found', 404);
    const result = await repo.one(db, `INSERT INTO business_resources(business_id,location_id,name,role_label) VALUES($1,$2,$3,$4) RETURNING *`,
      [business.id, location.id, v.requiredString(body.name, 'Staff / resource name', 150), v.optionalString(body.roleLabel, 'Role', 100)]);
    await repo.audit(db, business.id, user.id, 'resource.created', result.id);
    return result;
  });
}
// A salon books through its own rules (service time + clean-up, opening
// hours, stylist skills, rooms, deposits): businessSalon.service.js. Required
// here lazily, because that service requires this one.
const salonRules = (business) => (business.business_type === 'salon' ? require('../../salon-weight/services/businessSalon.service') : null);
async function appointment(business, user, body) {
  await access.require(business, 'appointments.create');
  if (salonRules(business)) {
    return salonRules(business).book(business, user, { ...body, endsAt: undefined, requestKey: body.requestKey || crypto.randomUUID() });
  }
  const starts = new Date(body.startsAt), ends = new Date(body.endsAt);
  if (!Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts || ends - starts > 86400000) fail('Provide a valid appointment of up to 24 hours');
  return repo.transaction(async (db) => {
    const staff = await repo.one(db, 'SELECT * FROM business_resources WHERE business_id=$1 AND id=$2 AND active FOR UPDATE', [business.id, id(body.resourceId)]);
    if (!staff) fail('Staff / resource not found', 404);
    access.requireLocation(business, staff.location_id);
    const contact = await repo.one(db, 'SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind=\'customer\' AND active', [business.id, id(body.contactId)]);
    const sku = await repo.one(db, `SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active AND p.kind='service'`, [business.id, id(body.skuId)]);
    if (!contact || !sku) fail('Customer or service not found', 404);
    // A clinic doctor is booked within their OPD sessions and not on leave.
    if (business.business_type === 'healthcare') {
      const problem = await require('../../health/services/businessClinicDesk.service').availabilityProblem(db, business, staff.id, starts, ends);
      if (problem) fail(problem, 409, { reason: 'doctor_unavailable' });
    }
    const overlap = await repo.one(db, `SELECT id FROM business_appointments WHERE business_id=$1 AND resource_id=$2
      AND status='booked' AND starts_at<$4 AND ends_at>$3`, [business.id, staff.id, starts, ends]);
    if (overlap) fail('This staff member already has an appointment at that time', 409);
    const result = await repo.one(db, `INSERT INTO business_appointments(business_id,resource_id,contact_id,sku_id,starts_at,ends_at,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [business.id, staff.id, contact.id, sku.id, starts, ends, user.id]);
    await repo.audit(db, business.id, user.id, 'appointment.booked', result.id);
    await repo.event(db, business.id, user.id, 'appointment.booked', 'appointment', result.id, { resourceId: staff.id, contactId: contact.id, skuId: sku.id, startsAt: result.starts_at, endsAt: result.ends_at });
    return result;
  });
}
// A booking can be marked no-show only once its start time has passed, and
// done only on its own day or later (a client may come in early that day).
// A booking still to come is cancelled or moved instead.
async function statusAllowed(db, business, appointment, status) {
  if (status === 'cancelled') return;
  const when = await repo.one(db, `SELECT a.starts_at > now() AS future,
    (a.starts_at AT TIME ZONE b.timezone)::date > (now() AT TIME ZONE b.timezone)::date AS later_day
    FROM business_appointments a JOIN businesses b ON b.id=a.business_id WHERE a.business_id=$1 AND a.id=$2`, [business.id, appointment.id]);
  if (status === 'no_show' && when.future) fail('This booking has not started yet. Mark it no-show after its start time, or cancel it.', 409);
  if (status === 'completed' && when.later_day) fail('This booking is on a later day. It can be marked done on the day, or cancelled.', 409);
}
async function appointmentStatus(business, user, appointmentId, body) {
  const status = v.requiredEnum(body.status, 'Status', ['completed', 'cancelled', 'no_show']);
  await access.require(business, status === 'cancelled' ? 'appointments.cancel' : 'appointments.edit');
  await access.requireAppointmentLocation(repo.pool, business, await repo.one(repo.pool, 'SELECT resource_id FROM business_appointments WHERE business_id=$1 AND id=$2', [business.id, id(appointmentId)]));
  // A salon's no-show and late-cancellation charges come out of the deposit.
  if (salonRules(business)) {
    const result = await salonRules(business).setStatus(business, user, appointmentId, { status, requestKey: body.requestKey || crypto.randomUUID() });
    return { ...result.appointment, fee: result.fee };
  }
  return repo.transaction(async (db) => {
    const current = await repo.one(db, `SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2 AND status='booked' FOR UPDATE`, [business.id, id(appointmentId)]);
    if (current) await statusAllowed(db, business, current, status);
    const result = await repo.one(db, `UPDATE business_appointments SET status=$3 WHERE business_id=$1 AND id=$2 AND status='booked' RETURNING *`, [business.id, id(appointmentId), status]);
    if (!result) fail('Appointment is not booked or does not exist', 409);
    await repo.audit(db, business.id, user.id, `appointment.${status}`, result.id);
    await repo.event(db, business.id, user.id, `appointment.${status}`, 'appointment', result.id, { status });
    return result;
  });
}

// --- Reports -----------------------------------------------------------------

async function reports(business, filters) {
  const from = dateText(filters.from, 'Report start date'), to = dateText(filters.to, 'Report end date');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  // Only the document kinds this person may see are reported.
  const kinds = ['sale', 'purchase'].filter((k) => access.can(business, kindPermission(k, 'view')));
  // One location (asked for, picked in the top bar, or where the person works), or all.
  const location = filters.location ? id(filters.location, 'Location') : null;
  // Each event is reported on its own posting date. A return today does not
  // silently rewrite yesterday's trading; collections have their own dates.
  const rows = (await repo.pool.query(`WITH events AS (
    SELECT (created_at AT TIME ZONE $4)::date AS day,kind,total,subtotal AS net,tax FROM business_documents WHERE business_id=$1 AND kind=ANY($5) AND ($6::bigint IS NULL OR location_id=$6)
    UNION ALL SELECT (r.created_at AT TIME ZONE $4)::date,d.kind||'_return',r.total,
      COALESCE((SELECT sum(net) FROM business_return_lines l WHERE l.business_id=r.business_id AND l.return_id=r.id),0),
      COALESCE((SELECT sum(tax) FROM business_return_lines l WHERE l.business_id=r.business_id AND l.return_id=r.id),0)
      FROM business_returns r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id WHERE r.business_id=$1 AND d.kind=ANY($5) AND ($6::bigint IS NULL OR d.location_id=$6)
    -- Store credit (a credit-note collection) is no money in; it counts when a bill uses it.
    UNION ALL SELECT (p.created_at AT TIME ZONE $4)::date,d.kind||'_payment',p.amount,0,0
      FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id WHERE p.business_id=$1 AND d.kind=ANY($5) AND p.method<>'finance' AND (p.collection_id IS NULL OR p.method='credit_note') AND p.supplier_payment_id IS NULL AND ($6::bigint IS NULL OR d.location_id=$6)
    UNION ALL SELECT (r.created_at AT TIME ZONE $4)::date,d.kind||'_refund',r.amount,0,0
      FROM business_refunds r JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id WHERE r.business_id=$1 AND d.kind=ANY($5) AND r.method<>'finance' AND ($6::bigint IS NULL OR d.location_id=$6)
    UNION ALL SELECT (k.created_at AT TIME ZONE $4)::date,'sale_payment',k.amount,0,0
      FROM business_collections k WHERE k.business_id=$1 AND 'sale'=ANY($5) AND k.method<>'credit_note' AND ($6::bigint IS NULL OR k.location_id=$6)
    UNION ALL SELECT (k.created_at AT TIME ZONE $4)::date,'purchase_payment',k.amount,0,0
      FROM business_supplier_payments k WHERE k.business_id=$1 AND 'purchase'=ANY($5) AND ($6::bigint IS NULL OR k.location_id=$6)
    UNION ALL SELECT (f.created_at AT TIME ZONE $4)::date,'sale_refund',f.amount,0,0
      FROM business_collection_refunds f JOIN business_collections k ON k.business_id=f.business_id AND k.id=f.collection_id
      WHERE f.business_id=$1 AND 'sale'=ANY($5) AND ($6::bigint IS NULL OR k.location_id=$6)
    UNION ALL SELECT (q.bounced_at AT TIME ZONE $4)::date,'collection_bounced',k.amount,0,0
      FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
      WHERE q.business_id=$1 AND q.status='bounced' AND 'sale'=ANY($5) AND ($6::bigint IS NULL OR k.location_id=$6)
    UNION ALL SELECT (s.created_at AT TIME ZONE $4)::date,'finance_payout',s.amount_received,0,0
      FROM electronics_finance_settlements s WHERE s.business_id=$1 AND 'sale'=ANY($5) AND ($6::bigint IS NULL OR s.location_id=$6)
    UNION ALL SELECT e.spent_on,'expense',e.amount,0,0 FROM business_expenses e
      WHERE e.business_id=$1 AND $7::boolean AND ($6::bigint IS NULL OR e.location_id=$6)
    UNION ALL SELECT (e.voided_at AT TIME ZONE $4)::date,'expense_reversal',e.amount,0,0 FROM business_expenses e
      WHERE e.business_id=$1 AND e.voided_at IS NOT NULL AND $7::boolean AND ($6::bigint IS NULL OR e.location_id=$6)
  ) SELECT day::text AS day,kind,count(*)::int AS entries,sum(total) AS total,sum(net) AS net,sum(tax) AS tax
    FROM events WHERE day BETWEEN $2::date AND $3::date GROUP BY day,kind ORDER BY day DESC,kind`, [business.id, from, to, business.timezone, kinds, location, access.can(business,'expenses.view')])).rows;
  return { from, to, timezone: business.timezone, location, rows };
}

module.exports = { statusAllowed, list, linkRestaurant, createLocation, updateLocation, updateContact, reports, createCatalog, updateCatalog, createContact,
  createPriceRule, disablePriceRule, document, detail, payment, resource, appointment, appointmentStatus, decimal, dateText, uuid,
  lineNet, lineTax, inclusiveNet, kindPermission, readUnit, postDocument, recordPayment, conversion, requiredDecimals, readPayments,
  readMrp, checkMrp, branchSeller, requireDepartmentItem };
