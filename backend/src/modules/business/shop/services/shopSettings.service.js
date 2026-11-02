const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const { guestPageUrl } = require('../../../../utils/guestLinks');
const { readSlots } = require('./shopSlots');
const { NEVER_ONLINE } = require('./shopRules');

// The online shop's settings: one shop link per location, the location whose
// stock it sells (ADMIN_GUIDE.md, the online shop: setting it up).
//
//   ensure(db, business)            a settings row for every open location (off, with
//                                   the starting policy and the owner as grievance officer)
//   list(business)                  each location's link, settings, today's figures and
//                                   how ready its items are
//   update(business, user, locationId, body)    only the fields sent change
//   newLink(business, user, locationId)         a new token: the old link and QR stop working
//   deliveryItem(db, business, userId, settings) the "Delivery charge" service item
//   byToken(db, token)              the link behind a guest's address, with its business
//                                   (and tax_changes_due: a GST rate change has come due)

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const newToken = () => crypto.randomBytes(24).toString('hex');
const PIN = /^[1-9][0-9]{5}$/;

// The return, refund, exchange, warranty and delivery terms a shop starts
// with (E-Commerce Rules r.7(1)); the owner edits them under Settings › Online shop.
function starterPolicy(type) {
  const trade = {
    grocery: 'Fresh produce, milk, bread, eggs, meat and fish: check them at the door. They are taken back later only if they were spoiled when they reached you.',
    supermarket: 'Fresh produce, milk, bread, eggs, meat and fish: check them at the door. They are taken back later only if they were spoiled when they reached you.',
    meat: 'Meat and fish are cut to order: check them at the door. They are taken back later only if they were spoiled when they reached you.',
    weight_retail: 'Loose goods are weighed for you: the bill says what was packed. Check them at the door.',
    pharmacy: 'Medicines are not taken back once delivered, unless they were wrong, damaged or past their expiry. Prescription medicines are not sold online.',
    fashion: 'Clothes and footwear are exchanged within 7 days of delivery, unused, with their tags on and the bill. Innerwear, socks and items on sale are exchanged only when faulty.',
    electronics: 'Electronics carry the maker\'s warranty, with the bill as proof. Check that the item works when it is delivered: one that does not is replaced.',
    books: 'Books and stationery are exchanged within 7 days, unused and with the bill.',
    hardware: 'Paints tinted to order and goods cut to size are not taken back unless faulty.',
    agri_inputs: 'Seeds, fertilisers and pesticides are taken back only sealed, unused, within their date, and with the bill.',
    optical: 'Frames and sunglasses are exchanged within 7 days, unused and with the bill. Lenses made to a prescription are not taken back unless faulty.',
    general_retail: 'Unused items are exchanged within 7 days with the bill.',
  }[type] || 'Unused items are exchanged within 7 days with the bill.';
  return [
    'Returns and refunds: check your order when it reaches you or when you collect it. An item that is damaged, defective, wrong, past its expiry or not as described, or that came late, is taken back, and its money refunded or the item replaced. Tell us at the door, or within 2 days by calling customer care or with "Report a problem" on your order\'s page.',
    trade,
    'Cancelling: cancel free of charge from your order\'s page until the shop starts packing it. An item the shop cannot supply is left out, and you pay nothing for it.',
    'Delivery: within the area shown, as soon as possible or in the slot you choose. The delivery charge, if any, is shown before you order. Return delivery of an item taken back costs you nothing.',
    'Payment: pay at the shop when you collect, or in cash or by UPI on delivery. No money is taken online. A refund is made the same day, by the way you paid or in cash.',
  ].join('\n\n');
}

// The business's owner, as its grievance officer until the owner names another.
async function ownerOf(db, businessId) {
  return repo.one(db, `SELECT u.name,u.email FROM business_memberships m JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
    JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND m.active AND r.full_access ORDER BY m.created_at,m.user_id LIMIT 1`, [businessId]);
}

async function ensure(db, business) {
  const missing = await repo.all(db, `SELECT l.id,COALESCE(l.phone,s.phone) AS phone,s.email FROM business_locations l
    LEFT JOIN business_settings s ON s.business_id=l.business_id
    WHERE l.business_id=$1 AND l.active AND NOT EXISTS (SELECT 1 FROM shop_settings x WHERE x.business_id=l.business_id AND x.location_id=l.id)`, [business.id]);
  if (!missing.length) return;
  const owner = await ownerOf(db, business.id);
  for (const location of missing) {
    await db.query(`INSERT INTO shop_settings(business_id,location_id,token,policy,grievance_name,grievance_designation,grievance_phone,grievance_email,care_phone,care_email)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (business_id,location_id) DO NOTHING`,
    [business.id, location.id, newToken(), starterPolicy(business.business_type), owner?.name || null, owner ? 'Owner' : null,
      location.phone || null, location.email || null, location.phone || null, location.email || null]);
  }
}

const money = (value) => (value === null || value === undefined ? null : Number(value));

// What a settings row looks like to staff.
function view(row) {
  const path = `/shop/${row.token}`;
  return {
    id: Number(row.id), locationId: Number(row.location_id), locationName: row.location_name, locationActive: row.location_active,
    token: row.token, path, url: guestPageUrl(path),
    enabled: row.enabled, paused: row.paused,
    pickupEnabled: row.pickup_enabled, pickupMinutes: row.pickup_minutes,
    deliveryEnabled: row.delivery_enabled, deliveryPins: row.delivery_pins, deliveryAreaNote: row.delivery_area_note,
    deliveryFee: money(row.delivery_fee), freeDeliveryAbove: money(row.free_delivery_above), minOrder: money(row.min_order), deliveryMinutes: row.delivery_minutes,
    slotsEnabled: row.slots_enabled, slots: row.slots, slotCutoffMinutes: row.slot_cutoff_minutes,
    takeOrdersWhenClosed: row.take_orders_when_closed, hideOutOfStock: row.hide_out_of_stock, lowStockBelow: row.low_stock_below,
    maxOpenPerMobile: row.max_open_per_mobile, autoDeclineMinutes: row.auto_decline_minutes,
    payAtShop: row.pay_at_shop, cashOnDelivery: row.cash_on_delivery, upiOnDelivery: row.upi_on_delivery, upiId: row.upi_id, upiPayee: row.upi_payee,
    guestNote: row.guest_note,
    carePhone: row.care_phone, careEmail: row.care_email,
    grievanceName: row.grievance_name, grievanceDesignation: row.grievance_designation, grievancePhone: row.grievance_phone, grievanceEmail: row.grievance_email,
    fssaiLicence: row.fssai_licence, policy: row.policy,
    deliveryItemId: row.delivery_sku_id ? Number(row.delivery_sku_id) : null,
    updatedAt: row.updated_at,
  };
}

const ROWS_SQL = `SELECT x.*,l.name AS location_name,l.active AS location_active FROM shop_settings x
  JOIN business_locations l ON l.business_id=x.business_id AND l.id=x.location_id WHERE x.business_id=$1`;

// How ready the shop's items are: how many show, what keeps the others off,
// and the details still missing on those shown (photo, maker, HSN code).
async function readiness(db, business, locationId, hideOutOfStock) {
  const catalog = require('./shopCatalog.service');
  const day = await catalog.today(db, business.timezone);
  // Shown: what a guest sees now (the shop's own stock rule included).
  const shown = 'never IS NULL AND NOT item_hidden AND NOT category_hidden AND price>0 AND (NOT $4::boolean OR stock>0)';
  const row = await repo.one(db, `${catalog.ROWS_SQL}
    SELECT count(*) FILTER (WHERE ${shown})::int AS shown,
      count(*) FILTER (WHERE never IS NULL AND NOT item_hidden AND NOT category_hidden AND price>0 AND stock<=0)::int AS out_of_stock,
      count(*) FILTER (WHERE never IS NULL AND (item_hidden OR category_hidden))::int AS hidden,
      count(DISTINCT product_id) FILTER (WHERE ${shown} AND photo_path IS NULL)::int AS without_photo,
      count(*) FILTER (WHERE ${shown} AND maker_name IS NULL)::int AS without_maker,
      count(*) FILTER (WHERE ${shown} AND hsn_code IS NULL)::int AS without_hsn,
      (SELECT COALESCE(json_object_agg(g.never,g.n),'{}') FROM (SELECT never,count(*)::int AS n FROM rows WHERE never IS NOT NULL GROUP BY never) g) AS never
    FROM rows`, [business.id, locationId, day, hideOutOfStock]);
  return {
    shown: row.shown, outOfStock: row.out_of_stock, hidden: row.hidden, withoutPhoto: row.without_photo, withoutMaker: row.without_maker, withoutHsn: row.without_hsn,
    neverOnline: Object.entries(row.never || {}).map(([code, count]) => ({ code, count, words: NEVER_ONLINE[code] })),
  };
}

async function list(business) {
  await access.require(business, 'online_shop.view');
  await repo.transaction((db) => ensure(db, business));
  const rows = await repo.all(repo.pool, `${ROWS_SQL} ORDER BY l.active DESC,x.location_id`, [business.id]);
  const visible = rows.filter((row) => row.location_active || row.enabled);
  const counts = await repo.all(repo.pool, `SELECT o.settings_id,
      count(*) FILTER (WHERE o.status='placed')::int AS waiting,
      count(*) FILTER (WHERE (o.placed_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date)::int AS today
    FROM shop_orders o JOIN businesses b ON b.id=o.business_id WHERE o.business_id=$1 AND o.placed_at>now()-interval '2 days' GROUP BY o.settings_id`, [business.id]);
  const links = [];
  for (const row of visible) {
    const count = counts.find((c) => String(c.settings_id) === String(row.id)) || {};
    links.push({ ...view(row), waiting: count.waiting || 0, today: count.today || 0, readiness: await readiness(repo.pool, business, row.location_id, row.hide_out_of_stock) });
  }
  return { links, words: NEVER_ONLINE };
}

// --- Changing them ------------------------------------------------------------------------------

const bool = (value, name) => v.requiredBoolean(value, name);
const int = (value, name, min, max) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return number;
};
const amount = (value, name, max) => {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) > max) fail(`${name} must be an amount from 0 to ${max}, in rupees and paise`);
  return Number(text).toFixed(2);
};
const phone = (value, name) => {
  const text = v.optionalString(value, name, 20);
  if (text && !/^[+0-9][0-9 -]{5,18}$/.test(text)) fail(`${name}: give a phone number`);
  return text;
};
const email = (value, name) => (value === undefined || value === null || String(value).trim() === '' ? null : v.requiredEmail(value, name));
function pins(value) {
  if (!Array.isArray(value)) fail('Delivery PIN codes must be a list');
  const list = [...new Set(value.map((pin) => String(pin).trim()).filter(Boolean))];
  if (list.length > 100) fail('Give at most 100 delivery PIN codes');
  const wrong = list.find((pin) => !PIN.test(pin));
  if (wrong) fail(`${wrong} is not a PIN code: a PIN code is 6 digits`);
  return list.sort();
}

// Each field: the column it writes and how a value is read.
const FIELDS = {
  enabled: ['enabled', (x) => bool(x, 'Taking orders')],
  paused: ['paused', (x) => bool(x, 'Paused')],
  pickupEnabled: ['pickup_enabled', (x) => bool(x, 'Pickup')],
  pickupMinutes: ['pickup_minutes', (x) => int(x, 'Ready for pickup in (minutes)', 5, 720)],
  deliveryEnabled: ['delivery_enabled', (x) => bool(x, 'Delivery')],
  deliveryPins: ['delivery_pins', pins],
  deliveryAreaNote: ['delivery_area_note', (x) => v.optionalString(x, 'Delivery area note', 300)],
  deliveryFee: ['delivery_fee', (x) => amount(x, 'Delivery charge', 1000)],
  freeDeliveryAbove: ['free_delivery_above', (x) => (x === null || x === '' ? null : amount(x, 'Free delivery above', 100000))],
  minOrder: ['min_order', (x) => amount(x, 'Minimum order for delivery', 100000)],
  deliveryMinutes: ['delivery_minutes', (x) => int(x, 'Delivery in (minutes)', 10, 1440)],
  slotsEnabled: ['slots_enabled', (x) => bool(x, 'Delivery slots')],
  slots: ['slots', (x) => JSON.stringify(readSlots(x))],
  slotCutoffMinutes: ['slot_cutoff_minutes', (x) => int(x, 'Slot cut-off (minutes before it starts)', 0, 720)],
  takeOrdersWhenClosed: ['take_orders_when_closed', (x) => bool(x, 'Take orders while closed')],
  hideOutOfStock: ['hide_out_of_stock', (x) => bool(x, 'Hide items out of stock')],
  lowStockBelow: ['low_stock_below', (x) => int(x, '"Only a few left" below', 0, 1000)],
  maxOpenPerMobile: ['max_open_per_mobile', (x) => int(x, 'Open orders per mobile', 1, 10)],
  autoDeclineMinutes: ['auto_decline_minutes', (x) => int(x, 'Declined if not accepted within (minutes)', 10, 240)],
  payAtShop: ['pay_at_shop', (x) => bool(x, 'Pay at the shop')],
  cashOnDelivery: ['cash_on_delivery', (x) => bool(x, 'Cash on delivery')],
  upiOnDelivery: ['upi_on_delivery', (x) => bool(x, 'UPI on delivery')],
  upiId: ['upi_id', (x) => {
    const text = v.optionalString(x, 'UPI ID', 100);
    if (text && !/^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(text)) fail('A UPI ID looks like shopname@bank');
    return text;
  }],
  upiPayee: ['upi_payee', (x) => v.optionalString(x, 'UPI payee name', 100)],
  guestNote: ['guest_note', (x) => v.optionalString(x, 'Note for customers', 500)],
  carePhone: ['care_phone', (x) => phone(x, 'Customer care phone')],
  careEmail: ['care_email', (x) => email(x, 'Customer care email')],
  grievanceName: ['grievance_name', (x) => v.optionalString(x, 'Grievance officer', 100)],
  grievanceDesignation: ['grievance_designation', (x) => v.optionalString(x, 'Grievance officer\'s designation', 100)],
  grievancePhone: ['grievance_phone', (x) => phone(x, 'Grievance officer\'s phone')],
  grievanceEmail: ['grievance_email', (x) => email(x, 'Grievance officer\'s email')],
  fssaiLicence: ['fssai_licence', (x) => {
    const text = v.optionalString(x, 'FSSAI licence number', 14);
    if (text && !/^[0-9]{14}$/.test(text)) fail('An FSSAI licence number has 14 digits');
    return text;
  }],
  policy: ['policy', (x) => v.requiredString(x, 'Returns, refunds and delivery policy', 4000)],
};

async function locked(db, business, locationId) {
  await ensure(db, business);
  const row = await repo.one(db, `${ROWS_SQL} AND x.location_id=$2 FOR UPDATE OF x`, [business.id, v.requiredId(locationId, 'Location')]);
  if (!row) fail('Location not found', 404);
  access.requireLocation(business, row.location_id);
  return row;
}

async function update(business, user, locationId, body) {
  await access.require(business, 'online_shop.manage');
  const sets = {};
  for (const [key, [column, read]] of Object.entries(FIELDS)) {
    if (body[key] !== undefined) sets[column] = read(body[key]);
  }
  return repo.transaction(async (db) => {
    const row = await locked(db, business, locationId);
    const next = { ...row, ...sets, slots: sets.slots ? JSON.parse(sets.slots) : row.slots };
    if (!next.pickup_enabled && !next.delivery_enabled) fail('Offer pickup, delivery or both, or switch the online shop off');
    if (!next.pay_at_shop && !next.cash_on_delivery && !next.upi_on_delivery) fail('Offer at least one way to pay');
    if (next.pickup_enabled && !next.pay_at_shop) fail('Pickup orders are paid at the shop: keep "Pay at the shop" on, or switch pickup off');
    if (next.delivery_enabled && !next.cash_on_delivery && !next.upi_on_delivery) fail('Delivery orders are paid on delivery: offer cash or UPI on delivery, or switch delivery off');
    if (next.delivery_enabled && !next.delivery_pins.length) fail('Delivery needs its area: give the PIN codes you deliver to', 400, { field: 'deliveryPins' });
    if (next.slots_enabled && !next.slots.length) fail('Add a delivery slot, or switch slots off', 400, { field: 'slots' });
    if (next.enabled && !row.location_active) fail(`${row.location_name} is closed, so its shop link cannot be switched on`, 409);
    if (next.enabled && !business.modules.includes('online_shop')) fail('Online shop is not switched on for this business.', 403);
    const names = Object.keys(sets);
    if (names.length) {
      await db.query(`UPDATE shop_settings SET ${names.map((name, index) => `${name}=$${index + 3}`).join(',')},updated_by=$${names.length + 3},updated_at=now()
        WHERE business_id=$1 AND id=$2`, [business.id, row.id, ...names.map((name) => sets[name]), user.id]);
    }
    if (next.delivery_enabled && !row.delivery_sku_id) await deliveryItem(db, business, user.id, { ...row, delivery_fee: next.delivery_fee });
    await repo.audit(db, business.id, user.id, 'online_shop.settings_updated', row.id, { location: row.location_name, changed: Object.keys(body).filter((key) => FIELDS[key]) });
    const saved = await repo.one(db, `${ROWS_SQL} AND x.id=$2`, [business.id, row.id]);
    return view(saved);
  });
}

async function newLink(business, user, locationId) {
  await access.require(business, 'online_shop.manage');
  return repo.transaction(async (db) => {
    const row = await locked(db, business, locationId);
    await db.query('UPDATE shop_settings SET token=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, row.id, newToken(), user.id]);
    await repo.audit(db, business.id, user.id, 'online_shop.link_replaced', row.id, { location: row.location_name });
    return view(await repo.one(db, `${ROWS_SQL} AND x.id=$2`, [business.id, row.id]));
  });
}

// The "Delivery charge" service item the shop's bills put the delivery charge
// on: made once, at the business's default GST slab (each bill's delivery
// lines carry the goods' rates instead). Inside the caller's transaction.
async function deliveryItem(db, business, userId, settings) {
  if (settings.delivery_sku_id) {
    const sku = await repo.one(db, `SELECT s.id,s.active AND p.active AS active FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2`, [business.id, settings.delivery_sku_id]);
    if (sku) return sku;
  }
  const slab = await repo.one(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active ORDER BY is_default DESC,id LIMIT 1', [business.id]);
  const taken = new Set((await repo.all(db, "SELECT code FROM catalog_skus WHERE business_id=$1 AND code LIKE 'DELIVERY%'", [business.id])).map((row) => row.code));
  const code = ['DELIVERY', ...Array.from({ length: 98 }, (_, index) => `DELIVERY-${index + 2}`)].find((c) => !taken.has(c));
  const product = await repo.one(db, "INSERT INTO catalog_products(business_id,name,kind) VALUES($1,'Delivery charge','service') RETURNING id", [business.id]);
  const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,label,unit,price,tax_rate,tax_rate_id,tracking)
    VALUES($1,$2,$3,'Delivery charge','service',$4,$5,$6,'none') RETURNING id`, [business.id, product.id, code, Number(settings.delivery_fee || 0).toFixed(2), slab ? slab.rate : 0, slab ? slab.id : null]);
  await db.query('UPDATE shop_settings SET delivery_sku_id=$3 WHERE business_id=$1 AND id=$2', [business.id, settings.id, sku.id]);
  await repo.audit(db, business.id, userId, 'catalog.created', sku.id, { label: 'Delivery charge', for: 'online_shop' });
  return { id: sku.id, active: true };
}

// --- The link behind a guest's address ---------------------------------------------------------

const TOKEN = /^[a-f0-9]{48}$/;
const LINK_NOT_FOUND = 'We could not find this shop. The link may have changed: please ask the shop for its current link.';

async function byToken(db, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) fail(LINK_NOT_FOUND, 404, { reason: 'not_found' });
  const row = await repo.one(db, `SELECT x.*,b.status AS business_status,b.business_type,b.timezone,b.name AS business_name,
      (SELECT state FROM business_plan_state(b.id)) AS plan_state,
      ('online_shop' = ANY(business_active_capabilities(b.id))) AS module_on,
      l.active AS location_active,l.opening_hours,
      s.tax_mode,s.rounding,
      (EXISTS (SELECT 1 FROM business_tax_change_items c WHERE c.business_id=b.id AND c.status='scheduled' AND c.sku_id IS NOT NULL
        AND c.starts_on <= (now() AT TIME ZONE b.timezone)::date)
      OR EXISTS (SELECT 1 FROM business_tax_setting_changes c WHERE c.business_id=b.id AND c.status='scheduled' AND c.setting<>'restaurant_default'
        AND c.starts_on <= (now() AT TIME ZONE b.timezone)::date)) AS tax_changes_due
    FROM shop_settings x JOIN businesses b ON b.id=x.business_id
    JOIN business_locations l ON l.business_id=x.business_id AND l.id=x.location_id
    LEFT JOIN business_settings s ON s.business_id=x.business_id
    WHERE x.token=$1`, [token]);
  if (!row || row.business_status !== 'active' || row.business_type === 'restaurant') fail(LINK_NOT_FOUND, 404, { reason: 'not_found' });
  return row;
}

module.exports = { ensure, list, update, newLink, deliveryItem, byToken, view, readiness, starterPolicy, ownerOf, LINK_NOT_FOUND };
