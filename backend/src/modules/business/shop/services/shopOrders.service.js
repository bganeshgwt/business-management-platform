const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const guests = require('../../guests');
const guestKeys = require('../../../live/services/guestKeys');
const settingsService = require('./shopSettings.service');
const catalog = require('./shopCatalog.service');
const money = require('./shopMoney');
const status = require('./shopStatus');
const slotRules = require('./shopSlots');

// A guest's online order, from the shop link to the staff's board
// (BUSINESS_RULES.md › Online shop; ADMIN_GUIDE.md › Online shop).
//
// Guests (no login, by the link's token or the order's own guest token):
//   shopPage, shopItems, shopItem, checkCart, place, guestOrder, cancelByGuest,
//   changeByGuest
// Staff (Online orders, in Business Admin): board, detail, accept, decline, cancel.
//
// An order not accepted in time is declined by the shop's own rule: worked
// out whenever anyone reads (the board, the order, the guest's page, the
// bell) or writes, with an audit row of no actor (Automatic), so both sides
// always say the same. The customer record is found or made at acceptance,
// never at placing: a declined order leaves no customer behind. Personal
// details of an order that never became a customer's (declined, or cancelled
// before acceptance) are cleared 30 days after it ended.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const CLIENT_KEY = /^[A-Za-z0-9-]{8,64}$/;
const GUEST_TOKEN = /^[a-f0-9]{48}$/;
const ORDER_NOT_FOUND = 'We could not find this order. Please check the link, or call the shop.';
const NOT_TAKING = 'This shop is not taking online orders right now. Please call them to order.';
const MAX_UNITS = 300;
const KEEP_DAYS = 30;
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rupees = (amount) => Number((amount / 100).toFixed(2));
const words = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

// --- The business's clock -----------------------------------------------------------------------

async function clockNow(db, timezone) {
  return repo.one(db, `SELECT (now() AT TIME ZONE $1)::date::text AS day,lower(to_char(now() AT TIME ZONE $1,'dy')) AS weekday,
    (EXTRACT(HOUR FROM now() AT TIME ZONE $1)*60+EXTRACT(MINUTE FROM now() AT TIME ZONE $1))::int AS minutes`, [timezone || 'Asia/Kolkata']);
}

// "7:42 pm", or "Tue 3 Nov, 9:30 am" when not today, on the business's clock.
function clockOf(timezone) {
  const zone = timezone || 'Asia/Kolkata';
  const dayOf = (at) => new Date(at).toLocaleDateString('en-CA', { timeZone: zone });
  return (at) => {
    if (!at) return null;
    const time = new Date(at).toLocaleTimeString('en-IN', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])\.?m\.?$/i, ' $1m').toLowerCase();
    if (dayOf(at) === dayOf(Date.now())) return time;
    const date = new Date(at).toLocaleDateString('en-IN', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' });
    return `${date}, ${time}`;
  };
}

// --- Numbers ------------------------------------------------------------------------------------

async function nextNumber(db, businessId, kind) {
  const row = await repo.one(db, `INSERT INTO shop_counters(business_id,kind,next_number) VALUES($1,$2,2)
    ON CONFLICT (business_id,kind) DO UPDATE SET next_number=shop_counters.next_number+1 RETURNING next_number-1 AS number`, [businessId, kind]);
  return `${kind === 'order' ? 'ON' : 'TK'}-${String(row.number).padStart(4, '0')}`;
}

// --- Orders the shop's own rule declines, and details it clears ---------------------------------

const AUTO_REASON = 'The shop did not respond in time.';

// Declines every order of the business still placed past its time, with an
// audit row of no actor (Automatic) and its event. Inside the caller's
// transaction when it has one.
async function expireDue(db, businessId) {
  const rows = await repo.all(db, `UPDATE shop_orders SET status='declined',declined_auto=TRUE,declined_at=now(),decline_reason=$2,revision=revision+1,updated_at=now()
    WHERE business_id=$1 AND status='placed' AND auto_decline_at<=now() RETURNING id,location_id,order_no,total`, [businessId, AUTO_REASON]);
  for (const row of rows) {
    await repo.automaticAudit(db, businessId, 'online_order.declined', row.id, { orderNo: row.order_no, reason: 'not_accepted_in_time' });
    await repo.event(db, businessId, null, 'online_order.declined', 'online_order', row.id, { locationId: Number(row.location_id), orderNo: row.order_no, auto: true });
  }
  return rows.length;
}
const expire = (businessId) => repo.transaction((db) => expireDue(db, businessId));

// An order that never became a customer's keeps the guest's details for 30
// days after it ended (a call back about it), then they are cleared.
async function clearOld(db, businessId) {
  await db.query(`UPDATE shop_orders SET guest_name='Guest',guest_mobile=NULL,address=NULL,landmark=NULL,pin_code=NULL,guest_note=NULL,updated_at=now()
    WHERE business_id=$1 AND contact_id IS NULL AND status IN ('declined','cancelled') AND guest_mobile IS NOT NULL
      AND COALESCE(declined_at,cancelled_at)<now()-make_interval(days=>$2)`, [businessId, KEEP_DAYS]);
  await db.query(`UPDATE shop_complaints c SET details='Cleared: the order never became a customer''s'
    FROM shop_orders o WHERE c.business_id=$1 AND o.business_id=c.business_id AND o.id=c.order_id AND c.contact_id IS NULL AND c.status='resolved'
      AND o.guest_mobile IS NULL AND c.resolved_at<now()-make_interval(days=>$2) AND c.details NOT LIKE 'Cleared:%'`, [businessId, KEEP_DAYS]);
}

// --- Whether the link takes orders now ----------------------------------------------------------

// The shop's state as the page shows it: { taking, reason, message, whenClosed }.
//   off                 the module is off, or the link is switched off
//   not_taking_orders   the plan has ended or the business is switched off, or the location is closed
//   paused              the shop paused online orders for a while
//   closed              closed now, and takes orders only while open
function stateOf(link, card) {
  if (!card || !card.takingOrders || !link.location_active) return { taking: false, reason: 'not_taking_orders', message: NOT_TAKING };
  if (!link.module_on || !link.enabled) return { taking: false, reason: 'off', message: NOT_TAKING };
  const hours = card.hours;
  const closedNow = Boolean(hours && hours.known && !hours.openNow);
  const opens = closedNow && hours.opensAt ? `${hours.opensAt.in === 0 ? '' : hours.opensAt.in === 1 ? 'tomorrow ' : `${hours.opensAt.day} `}at ${clockLabel(hours.opensAt.time)}` : null;
  if (link.paused) return { taking: false, reason: 'paused', message: 'The shop has paused online orders for a little while. Please try again soon, or call them.' };
  if (closedNow && !link.take_orders_when_closed) {
    return { taking: false, reason: 'closed', message: opens ? `The shop is closed now and takes online orders while it is open. It opens ${opens}.` : 'The shop is closed now. Please try again when it is open.' };
  }
  return { taking: true, reason: null, message: null, whenClosed: closedNow ? (opens ? `The shop is closed now. We'll pack it when we open ${opens}.` : 'The shop is closed now. We\'ll pack it when we open.') : null };
}
const clockLabel = (time) => {
  const [hours, minutes] = String(time).split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`;
};

// Reads (the items, an item, the cart) need the module on and the shop open
// for business; placing an order also needs it not paused or closed.
function assertReadable(link, card) {
  if (!link.module_on) fail(NOT_TAKING, 403, { reason: 'feature_off', feature: 'online_shop' });
  const state = stateOf(link, card);
  if (['off', 'not_taking_orders'].includes(state.reason)) fail(NOT_TAKING, 409, { reason: 'not_taking_orders' });
  return state;
}

const sellerOf = (link) => ({
  customerCare: link.care_phone || link.care_email ? { phone: link.care_phone, email: link.care_email } : null,
  grievance: link.grievance_name ? { name: link.grievance_name, designation: link.grievance_designation, phone: link.grievance_phone, email: link.grievance_email } : null,
  fssai: link.fssai_licence || null,
});

// What the page needs to say about pickup, delivery, paying and the shop's terms.
function termsOf(link) {
  return {
    pickup: link.pickup_enabled ? { minutes: link.pickup_minutes } : null,
    delivery: link.delivery_enabled ? {
      fee: Number(link.delivery_fee), freeAbove: link.free_delivery_above === null ? null : Number(link.free_delivery_above), minOrder: Number(link.min_order),
      minutes: link.delivery_minutes, pins: link.delivery_pins, areaNote: link.delivery_area_note, slots: link.slots_enabled,
    } : null,
    payments: { payAtShop: link.pay_at_shop, cashOnDelivery: link.cash_on_delivery, upiOnDelivery: link.upi_on_delivery },
    autoDeclineMinutes: link.auto_decline_minutes,
    maxOpenPerMobile: link.max_open_per_mobile,
    note: link.guest_note || null,
    policy: link.policy,
    seller: sellerOf(link),
    roundsToRupee: link.rounding === 'nearest_rupee',
    weighedAllowancePercent: 10,
  };
}

// --- Guests: the shop -----------------------------------------------------------------------------

// The link behind a guest's address and the shop's card. GST rate changes
// whose date has come take effect first, before anything reads an item's
// rate, as when a staff request opens a business (businessAccess.open).
async function linkAndCard(db, token) {
  const link = await settingsService.byToken(db, token);
  await require('../../../tax-changes/services/taxChangesShop').onOpen({ id: link.business_id, tax_changes_due: link.tax_changes_due });
  const card = await guests.guestBusinessCard(db, link.business_id, link.location_id);
  return { link, card };
}

async function shopPage(token) {
  const { link, card } = await linkAndCard(repo.pool, token);
  const state = stateOf(link, card);
  const answer = { card, shop: { ...state, ...termsOf(link) }, categories: [], countries: [], items: { items: [], total: 0, page: 1, pages: 1 } };
  if (['off', 'not_taking_orders'].includes(state.reason)) return answer;
  const [lists, first] = [await catalog.categoriesOf(repo.pool, link), await catalog.items(repo.pool, link, {})];
  return { ...answer, categories: lists.categories, countries: lists.countries, items: first };
}

async function shopItems(token, query) {
  const { link, card } = await linkAndCard(repo.pool, token);
  assertReadable(link, card);
  return catalog.items(repo.pool, link, query);
}

async function shopItem(token, productId) {
  const { link, card } = await linkAndCard(repo.pool, token);
  assertReadable(link, card);
  return catalog.item(repo.pool, link, productId);
}

// The slots on offer for delivery now, with how many each still takes.
async function slotsOf(db, link, clock) {
  if (!link.slots_enabled) return [];
  const slots = slotRules.readSlots(link.slots);
  const taken = await repo.all(db, `SELECT slot_on::text AS day,to_char(slot_from,'HH24:MI') AS from_time,count(*)::int AS n FROM shop_orders
    WHERE settings_id=$1 AND slot_on>=$2::date AND status NOT IN ('declined','cancelled') GROUP BY slot_on,slot_from`, [link.id, clock.day]);
  return slotRules.offered({ slots, cutoffMinutes: link.slot_cutoff_minutes, today: clock.day, nowMinutes: clock.minutes, weekday: clock.weekday,
    hours: link.opening_hours, taken: new Map(taken.map((row) => [`${row.day} ${row.from_time}`, row.n])) });
}

// The cart priced now: its lines with their problems, the totals, the
// delivery terms and slots, and whether the shop takes the order now.
async function checkCart(token, body) {
  const { link, card } = await linkAndCard(repo.pool, token);
  const state = assertReadable(link, card);
  const service = body.service === 'delivery' ? 'delivery' : 'pickup';
  const priced = await catalog.priceLines(repo.pool, link, body.lines);
  const clock = await clockNow(repo.pool, link.timezone);
  return { ...cartAnswer(link, priced, service), state, slots: service === 'delivery' ? await slotsOf(repo.pool, link, clock) : [] };
}

function cartAnswer(link, priced, service) {
  const usable = priced.lines.filter((line) => line.quantity > 0);
  const totals = money.cartTotals({
    lines: usable.map((line) => ({ pricePaise: Math.round(line.price * 100), quantity: line.quantity, weighed: line.weighed })),
    service, fee: money.paise(link.delivery_fee), freeAbove: link.free_delivery_above === null ? null : money.paise(link.free_delivery_above),
    minOrder: money.paise(link.min_order), rounding: link.rounding,
  });
  return {
    lines: priced.lines,
    changed: priced.problems.length > 0,
    totals: { items: rupees(totals.itemsTotal), delivery: rupees(totals.delivery), roundOff: rupees(totals.roundOff), total: rupees(totals.total),
      allowance: rupees(totals.allowance), upTo: rupees(totals.total + totals.allowance), moreForFree: rupees(totals.moreForFree), moreForMinimum: rupees(totals.moreForMinimum) },
  };
}

// --- Guests: placing an order --------------------------------------------------------------------

function readAddress(value) {
  const given = value && typeof value === 'object' ? value : {};
  const address = typeof given.address === 'string' ? given.address.trim().replace(/\s+/g, ' ') : '';
  if (address.length < 10) fail('Give the full delivery address: house or flat, street and area.', 400, { field: 'address' });
  if (address.length > 500) fail('The address is longer than 500 characters', 400, { field: 'address' });
  const pin = String(given.pinCode ?? '').trim();
  if (!/^[1-9][0-9]{5}$/.test(pin)) fail('Enter the 6-digit PIN code of the delivery address.', 400, { field: 'pinCode' });
  return { address, landmark: v.optionalString(given.landmark, 'Landmark', 200), pinCode: pin };
}

// When the order may be declined by the shop's own rule: so many minutes
// after placing, counted from the next opening when the shop is closed now.
async function autoDeclineAt(db, link, card) {
  const hours = card.hours;
  if (hours && hours.known && !hours.openNow && hours.opensAt) {
    const row = await repo.one(db, `SELECT ((business_local_today($1) + $2::int) + $3::time) AT TIME ZONE business_time_zone($1) + make_interval(mins=>$4) AS at`,
      [link.business_id, hours.opensAt.in, hours.opensAt.time, link.auto_decline_minutes]);
    return row.at;
  }
  return (await repo.one(db, 'SELECT now()+make_interval(mins=>$1) AS at', [link.auto_decline_minutes])).at;
}

async function place(token, body) {
  if (!body || typeof body !== 'object') fail('Send the order');
  if (typeof body.clientKey !== 'string' || !CLIENT_KEY.test(body.clientKey)) fail('This page sent an order it cannot recognise. Reload the page and try again.');
  const name = guests.readGuestName(body.name);
  const mobile = guests.readGuestMobile(body.mobile);
  const service = v.requiredEnum(body.service, 'Pickup or delivery', ['pickup', 'delivery']);
  const paymentMode = v.requiredEnum(body.paymentMode, 'How you pay', ['pay_at_shop', 'cash_on_delivery', 'upi_on_delivery']);
  const substitution = body.substitution === undefined || body.substitution === null ? 'remove' : v.requiredEnum(body.substitution, 'If an item has run out', ['remove', 'similar', 'call']);
  const note = v.optionalString(body.note, 'Note for the shop', 500);
  const consents = guests.readGuestChoices(body.consents);
  const address = service === 'delivery' ? readAddress(body.address) : null;
  const hash = sha256(body);
  const { link, card } = await linkAndCard(repo.pool, token);
  assertReadable(link, card);
  return repo.transaction(async (db) => {
    const locked = await repo.one(db, 'SELECT * FROM shop_settings WHERE id=$1 FOR UPDATE', [link.id]);
    Object.assign(link, locked);
    const old = await repo.one(db, 'SELECT * FROM shop_orders WHERE settings_id=$1 AND client_key=$2', [link.id, body.clientKey]);
    if (old) {
      if (old.client_hash !== hash) fail('This order was already sent with other details. Reload the page to see it.', 409, { reason: 'key_reused' });
      return { ...(await guestAnswer(db, old.guest_token)), duplicate: true };
    }
    await expireDue(db, link.business_id);
    const state = stateOf(link, card);
    if (!state.taking) fail(state.message, 409, { reason: state.reason === 'off' ? 'not_taking_orders' : state.reason });
    if (service === 'pickup' && !link.pickup_enabled) fail('This shop is not taking pickup orders online now: choose delivery.', 400, { reason: 'service_off' });
    if (service === 'delivery' && !link.delivery_enabled) fail('This shop is not delivering online orders now: choose pickup.', 400, { reason: 'service_off' });
    const allowed = service === 'pickup' ? (link.pay_at_shop ? ['pay_at_shop'] : []) : [link.cash_on_delivery && 'cash_on_delivery', link.upi_on_delivery && 'upi_on_delivery'].filter(Boolean);
    if (!allowed.includes(paymentMode)) fail(service === 'pickup' ? 'A pickup order is paid at the shop when you collect it.' : 'Choose cash or UPI on delivery.', 400, { reason: 'payment_mode' });
    if (address && !link.delivery_pins.includes(address.pinCode)) {
      fail(`Sorry, the shop does not deliver to ${address.pinCode}. It delivers to ${link.delivery_pins.join(', ')}${link.delivery_area_note ? ` (${link.delivery_area_note})` : ''}. You can choose pickup instead.`,
        409, { reason: 'outside_area', field: 'pinCode' });
    }
    const blocked = await repo.one(db, 'SELECT id FROM shop_blocked_mobiles WHERE business_id=$1 AND mobile=$2 AND lifted_at IS NULL', [link.business_id, mobile]);
    if (blocked) fail('This mobile number cannot order online from this shop. Please call the shop.', 403, { reason: 'blocked' });
    const open = await repo.one(db, `SELECT count(*)::int AS n FROM shop_orders WHERE business_id=$1 AND guest_mobile=$2 AND status IN ('placed','accepted','packed','ready','out_for_delivery')`,
      [link.business_id, mobile]);
    if (open.n >= link.max_open_per_mobile) {
      fail(`This mobile number already has ${open.n} ${open.n === 1 ? 'order' : 'orders'} in progress with the shop. Please wait until ${open.n === 1 ? 'it is' : 'they are'} with you, or call the shop.`,
        409, { reason: 'too_many_open' });
    }
    // A delivery slot, while the shop offers them: one still taking orders, under its cap.
    const clock = await clockNow(db, link.timezone);
    let slot = null;
    if (service === 'delivery' && link.slots_enabled) {
      const chosen = body.slot && typeof body.slot === 'object' ? body.slot : null;
      if (!chosen) fail('Choose a delivery slot.', 400, { field: 'slot' });
      const offered = await slotsOf(db, link, clock);
      slot = offered.find((one) => one.date === chosen.date && one.from === chosen.from);
      if (!slot || slot.past) fail('That delivery slot has closed. Choose another.', 409, { reason: 'slot_closed', slots: offered });
      if (!slot.open) fail('That delivery slot is full. Choose another.', 409, { reason: 'slot_full', slots: offered });
    }
    const wanted = v.requiredArray(body.lines, 'Your cart');
    const priced = await catalog.priceLines(db, link, wanted, { strict: true });
    if (priced.lines.reduce((sum, line) => sum + (line.weighed ? 1 : line.quantity), 0) > MAX_UNITS) fail('That is a very large order: please call the shop to place it.');
    const answer = cartAnswer(link, priced, service);
    const seenTotal = Math.round(Number(body.total) * 100);
    if (!Number.isFinite(seenTotal) || seenTotal !== Math.round(answer.totals.total * 100)) {
      fail('Your cart has changed: check the total and place the order again.', 409, { reason: 'cart_changed', ...answer });
    }
    if (service === 'delivery' && answer.totals.moreForMinimum > 0) {
      fail(`The minimum order for delivery is ${words(money.paise(link.min_order))}: add ${words(Math.round(answer.totals.moreForMinimum * 100))} more, or choose pickup.`, 409, { reason: 'below_minimum' });
    }
    const notice = consents.length ? await repo.one(db, 'SELECT id FROM business_privacy_notices WHERE business_id=$1 AND id=$2',
      [link.business_id, v.requiredId(body.privacyNoticeId, 'The privacy notice shown')]) : null;
    if (consents.length && !notice) fail('The privacy notice on the page has changed: reload the page and choose again.', 400, { reason: 'notice_changed' });
    const lineLines = priced.lines;
    const orderNo = await nextNumber(db, link.business_id, 'order');
    const order = await repo.one(db, `INSERT INTO shop_orders(business_id,location_id,settings_id,order_no,guest_token,client_key,client_hash,service,guest_name,guest_mobile,
        address,landmark,pin_code,slot_on,slot_from,slot_to,payment_mode,substitution,guest_note,consents,privacy_notice_id,auto_decline_at,items_total,delivery_charge,total,agreed_total)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25) RETURNING *`,
    [link.business_id, link.location_id, link.id, orderNo, crypto.randomBytes(24).toString('hex'), body.clientKey, hash, service, name, mobile,
      address?.address || null, address?.landmark || null, address?.pinCode || null, slot?.date || null, slot?.from || null, slot?.to || null,
      paymentMode, substitution, note, consents, notice?.id || null, await autoDeclineAt(db, link, card),
      answer.totals.items.toFixed(2), answer.totals.delivery.toFixed(2), answer.totals.total.toFixed(2)]);
    for (const [index, line] of lineLines.entries()) {
      const own = wanted[index] && wanted[index].substitution;
      await db.query(`INSERT INTO shop_order_lines(business_id,order_id,position,sku_id,name,unit,quantity,price,mrp,tax_rate,weighed,substitution)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [link.business_id, order.id, index + 1, line.skuId, line.name.slice(0, 200), line.unit, line.quantity,
        line.price.toFixed(2), line.mrpValue === null ? null : line.mrpValue.toFixed(2), line.taxRate.toFixed(2), line.weighed,
        own && ['remove', 'similar', 'call'].includes(own) ? own : null]);
    }
    await repo.guestAudit(db, link.business_id, 'online_order.placed', order.id, { orderNo, total: order.total, service, lines: lineLines.length });
    await repo.event(db, link.business_id, null, 'online_order.placed', 'online_order', order.id, { locationId: Number(link.location_id), orderNo, total: order.total, service });
    return { ...(await guestAnswer(db, order.guest_token)), duplicate: false };
  });
}

// --- Guests: their order ---------------------------------------------------------------------------

async function loadByGuestToken(db, guestToken, { lock = false } = {}) {
  if (typeof guestToken !== 'string' || !GUEST_TOKEN.test(guestToken)) fail(ORDER_NOT_FOUND, 404, { reason: 'not_found' });
  const order = await repo.one(db, `SELECT * FROM shop_orders WHERE guest_token=$1${lock ? ' FOR UPDATE' : ''}`, [guestToken]);
  if (!order) fail(ORDER_NOT_FOUND, 404, { reason: 'not_found' });
  return order;
}

const linesOf = (db, order) => repo.all(db, `SELECT l.*,s.shelf_location,s.tracking,s.label AS sku_label,u.kind AS unit_kind,u.name AS unit_name
  FROM shop_order_lines l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
  WHERE l.business_id=$1 AND l.order_id=$2 ORDER BY l.position`, [order.business_id, order.id]);

// A line's amount as packed (paise): what is billed for it.
function packedAmount(line) {
  if (['unavailable', 'replaced'].includes(line.state)) return 0;
  const quantity = line.state === 'pending' || line.packed_quantity === null ? Number(line.quantity) : Number(line.packed_quantity);
  const price = line.bill_price === null || line.bill_price === undefined ? Number(line.price) : Number(line.bill_price);
  return money.lineAmount(money.paise(price), quantity);
}

// The order's figures as packed now: the goods, the delivery charge as placed,
// the shop's rounding, and the most the guest has agreed to (with the
// weighing allowance until they agreed to a change).
function figuresOf(order, lines, { rounding, raised }) {
  const goods = lines.reduce((sum, line) => sum + packedAmount(line), 0);
  const delivery = money.paise(order.delivery_charge);
  const raw = goods + delivery;
  const total = money.roundBill(raw, rounding);
  const ordered = lines.filter((line) => !line.added);
  const allowance = raised ? 0 : money.weighedAllowance(ordered.map((line) => ({ pricePaise: money.paise(line.price), quantity: Number(line.quantity), weighed: line.weighed })));
  const ceiling = money.paise(order.agreed_total) + allowance;
  return { goods, delivery, roundOff: total - raw, total, allowance, ceiling, over: Math.max(0, total - ceiling) };
}

const lineView = (line, { staff = false } = {}) => ({
  id: Number(line.id), position: line.position, skuId: Number(line.sku_id), name: line.name, unit: line.unit, unitName: line.unit_name || line.unit, weighed: line.weighed,
  quantity: Number(line.quantity), price: Number(line.price), amount: money.lineAmount(money.paise(line.price), Number(line.quantity)) / 100,
  state: line.state, stateWords: status.LINE_WORDS[line.state], packedQuantity: line.packed_quantity === null ? null : Number(line.packed_quantity),
  billPrice: line.bill_price === null ? null : Number(line.bill_price), packedAmount: packedAmount(line) / 100,
  added: line.added, replacesLineId: line.replaces_line_id ? Number(line.replaces_line_id) : null,
  substitution: line.substitution, note: line.note,
  ...(staff ? { shelf: line.shelf_location || null, tracking: line.tracking, picked: line.picked, serials: line.serials, discountReason: line.discount_reason,
    mrp: line.mrp === null ? null : Number(line.mrp), taxRate: Number(line.tax_rate) } : {}),
});

async function complaintsOf(db, order) {
  return repo.all(db, 'SELECT * FROM shop_complaints WHERE business_id=$1 AND order_id=$2 ORDER BY id', [order.business_id, order.id]);
}
const complaintView = (row, clock) => ({
  id: Number(row.id), ticketNo: row.ticket_no, kind: row.kind, details: row.details, status: row.status, createdAt: row.created_at, created: clock(row.created_at),
  acknowledgeBy: row.acknowledge_by, resolveBy: row.resolve_by, acknowledgedAt: row.acknowledged_at, acknowledgement: row.acknowledgement,
  resolvedAt: row.resolved_at, outcome: row.outcome, resolution: row.resolution,
});

const changeView = (row) => (row ? {
  id: Number(row.id), status: row.status, totalBefore: Number(row.total_before), totalAfter: Number(row.total_after), lines: row.lines, note: row.note,
  askedAt: row.asked_at, answeredAt: row.answered_at, answeredVia: row.answered_via,
} : null);

// Everything the guest's status page shows, with the live key while anything can still change.
async function guestAnswer(db, guestToken) {
  const order = await loadByGuestToken(db, guestToken);
  const link = await repo.one(db, `SELECT x.*,b.timezone,s.rounding FROM shop_settings x JOIN businesses b ON b.id=x.business_id
    LEFT JOIN business_settings s ON s.business_id=x.business_id WHERE x.id=$1`, [order.settings_id]);
  const card = await guests.guestBusinessCard(db, order.business_id, order.location_id);
  const lines = await linesOf(db, order);
  const changes = await repo.all(db, 'SELECT * FROM shop_order_changes WHERE business_id=$1 AND order_id=$2 ORDER BY id', [order.business_id, order.id]);
  const complaints = await complaintsOf(db, order);
  const clock = clockOf(link.timezone);
  const raised = changes.some((change) => change.status === 'accepted');
  const figures = figuresOf(order, lines, { rounding: link.rounding, raised });
  const final = status.FINAL.includes(order.status);
  const openComplaints = complaints.filter((row) => row.status !== 'resolved');
  const live = final && !openComplaints.length ? null : guestKeys.issue({
    business: Number(order.business_id),
    watch: [{ area: 'online_order', id: Number(order.id) }, ...complaints.slice(-20).map((row) => ({ area: 'online_complaint', id: Number(row.id) }))],
  });
  return {
    order: {
      orderNo: order.order_no, guestToken: order.guest_token, status: order.status, stage: status.stageOf(order, clock), steps: status.stepsOf(order, clock),
      current: status.currentStep(order), final, service: order.service, paymentMode: order.payment_mode, paymentWords: status.PAYMENT_WORDS[order.payment_mode],
      substitution: order.substitution, substitutionWords: status.SUBSTITUTION_WORDS[order.substitution],
      name: order.guest_name, address: order.service === 'delivery' ? { address: order.address, landmark: order.landmark, pinCode: order.pin_code } : null,
      slot: order.slot_on ? { date: String(order.slot_on instanceof Date ? order.slot_on.toISOString().slice(0, 10) : order.slot_on).slice(0, 10), from: String(order.slot_from).slice(0, 5), to: String(order.slot_to).slice(0, 5) } : null,
      minutes: order.service === 'pickup' ? link.pickup_minutes : link.delivery_minutes,
      placedAt: order.placed_at, placed: clock(order.placed_at), autoDeclineAt: order.status === 'placed' ? order.auto_decline_at : null,
      autoDecline: order.status === 'placed' ? clock(order.auto_decline_at) : null,
      canCancel: status.canCancel(order), canChange: status.canChange(order), note: order.guest_note, riderName: order.rider_name,
      lines: lines.map((line) => lineView(line)),
      totals: { items: Number(order.items_total), delivery: Number(order.delivery_charge), total: Number(order.total), agreed: Number(order.agreed_total),
        allowance: figures.allowance / 100, now: figures.total / 100, final: order.final_total === null ? null : Number(order.final_total) },
      change: changeView(changes.find((change) => change.status === 'waiting')),
      changes: changes.filter((change) => change.status !== 'waiting').map(changeView),
      complaints: complaints.map((row) => complaintView(row, clock)),
      canComplain: complaints.filter((row) => row.status !== 'resolved').length < 3,
    },
    card,
    shop: { name: card?.name, phone: card?.location?.phone || null, policy: link.policy, seller: sellerOf(link), linkPath: `/shop/${link.token}` },
    live,
  };
}

async function guestOrder(guestToken) {
  const order = await loadByGuestToken(repo.pool, guestToken);
  if (order.status === 'placed') await expire(order.business_id);
  return guestAnswer(repo.pool, guestToken);
}

// The guest cancels, until the shop starts packing.
async function cancelByGuest(guestToken) {
  return repo.transaction(async (db) => {
    const first = await loadByGuestToken(db, guestToken);
    await expireDue(db, first.business_id);
    const order = await loadByGuestToken(db, guestToken, { lock: true });
    if (order.status === 'cancelled') return guestAnswer(db, guestToken);
    if (!status.canCancel(order)) {
      fail(order.status === 'declined' ? 'This order was declined, so there is nothing to cancel.'
        : 'The shop has started packing this order, so it cannot be cancelled here. Please call the shop.', 409, { reason: 'too_late' });
    }
    await db.query(`UPDATE shop_orders SET status='cancelled',cancelled_by='guest',cancel_reason='Cancelled by the customer',cancelled_at=now(),revision=revision+1,updated_at=now()
      WHERE id=$1`, [order.id]);
    await db.query("UPDATE shop_order_changes SET status='withdrawn',answered_at=now() WHERE order_id=$1 AND status='waiting'", [order.id]);
    await repo.guestAudit(db, order.business_id, 'online_order.cancelled', order.id, { orderNo: order.order_no, by: 'guest' });
    await repo.event(db, order.business_id, null, 'online_order.cancelled', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no, by: 'guest' });
    return guestAnswer(db, guestToken);
  });
}

// "Change this order": before the shop accepts it, the order is cancelled
// and its items go back to the guest's cart, to change and place again.
async function changeByGuest(guestToken) {
  return repo.transaction(async (db) => {
    const first = await loadByGuestToken(db, guestToken);
    await expireDue(db, first.business_id);
    const order = await loadByGuestToken(db, guestToken, { lock: true });
    if (!status.canChange(order)) {
      fail(order.status === 'declined' ? 'This order was declined: start a new one from the shop.' : 'The shop has already accepted this order, so it cannot be changed here. Please call the shop.',
        409, { reason: 'too_late' });
    }
    const lines = await linesOf(db, order);
    await db.query(`UPDATE shop_orders SET status='cancelled',cancelled_by='guest',cancel_reason='Changed by the customer',cancelled_at=now(),revision=revision+1,updated_at=now()
      WHERE id=$1`, [order.id]);
    await repo.guestAudit(db, order.business_id, 'online_order.cancelled', order.id, { orderNo: order.order_no, by: 'guest', toChange: true });
    await repo.event(db, order.business_id, null, 'online_order.cancelled', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no, by: 'guest' });
    const settings = await repo.one(db, 'SELECT token FROM shop_settings WHERE id=$1', [order.settings_id]);
    return {
      ...(await guestAnswer(db, guestToken)),
      cart: { linkPath: `/shop/${settings.token}`, lines: lines.filter((line) => !line.added).map((line) => ({ skuId: Number(line.sku_id), quantity: Number(line.quantity), name: line.name })) },
    };
  });
}

// --- Staff: the board ------------------------------------------------------------------------------

async function lockOrder(db, business, orderId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  await expireDue(db, business.id);
  const order = await repo.one(db, 'SELECT * FROM shop_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, v.requiredId(orderId, 'Online order')]);
  if (!order) fail('Online order not found', 404);
  access.requireLocation(business, order.location_id);
  return order;
}

// Two people at once: a change sent against an older look at the order is refused.
function sameRevision(order, body) {
  if (body && body.revision !== undefined && body.revision !== null && Number(body.revision) !== Number(order.revision)) {
    fail('This order changed a moment ago. Look at it again before you go on.', 409, { reason: 'changed', revision: order.revision });
  }
}

const BOARD_SQL = `SELECT o.*,l.name AS location_name,
    (SELECT count(*)::int FROM shop_order_lines x WHERE x.business_id=o.business_id AND x.order_id=o.id AND NOT x.added) AS line_count,
    (SELECT count(*)::int FROM shop_order_lines x WHERE x.business_id=o.business_id AND x.order_id=o.id AND x.state<>'pending') AS decided,
    (SELECT status FROM shop_order_changes c WHERE c.business_id=o.business_id AND c.order_id=o.id ORDER BY c.id DESC LIMIT 1) AS change_status,
    (SELECT count(*)::int FROM shop_complaints c WHERE c.business_id=o.business_id AND c.order_id=o.id AND c.status<>'resolved') AS open_complaints,
    u.name AS accepted_by_name
  FROM shop_orders o JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
  LEFT JOIN users u ON u.id=o.accepted_by WHERE o.business_id=$1`;

const cardView = (row, clock) => ({
  id: Number(row.id), orderNo: row.order_no, status: row.status, lane: status.laneOf(row.status), service: row.service, locationId: Number(row.location_id), locationName: row.location_name,
  name: row.guest_name, mobile: row.guest_mobile, pinCode: row.pin_code, paymentMode: row.payment_mode,
  slot: row.slot_on ? { date: String(row.slot_on instanceof Date ? row.slot_on.toISOString() : row.slot_on).slice(0, 10), from: String(row.slot_from).slice(0, 5), to: String(row.slot_to).slice(0, 5) } : null,
  total: Number(row.total), finalTotal: row.final_total === null ? null : Number(row.final_total), lines: row.line_count, decided: row.decided,
  placedAt: row.placed_at, placed: clock(row.placed_at), autoDeclineAt: row.status === 'placed' ? row.auto_decline_at : null,
  packingAt: row.packing_at, packedAt: row.packed_at, outAt: row.out_at, readyAt: row.ready_at, completedAt: row.completed_at,
  declined: row.status === 'declined' ? { auto: row.declined_auto, reason: row.decline_reason } : null,
  cancelled: row.status === 'cancelled' ? { by: row.cancelled_by, reason: row.cancel_reason } : null,
  changeStatus: row.change_status, openComplaints: row.open_complaints, riderName: row.rider_name, acceptedBy: row.accepted_by_name, revision: row.revision,
});

// The board: the orders of one lane (new, packing, out, done), the counts of
// every lane, and the business's own clock (the cards' timers count from it).
async function board(business, { lane = 'new', location, q, from, to } = {}) {
  await access.require(business, 'online_shop.view');
  await repo.transaction(async (db) => { await expireDue(db, business.id); await clearOld(db, business.id); });
  const chosen = status.LANES[lane] ? lane : 'new';
  const values = [business.id];
  const where = [];
  if (location || business.location_scope) {
    values.push(location ? v.requiredId(location, 'Location') : business.location_scope);
    where.push(`o.location_id=$${values.length}`);
  }
  const counts = await repo.all(repo.pool, `SELECT o.status,count(*)::int AS n FROM shop_orders o WHERE o.business_id=$1 ${where.map((w) => `AND ${w}`).join(' ')}
    AND (o.status IN ('placed','accepted','packed','ready','out_for_delivery') OR o.updated_at>now()-interval '1 day') GROUP BY o.status`, values);
  const laneCounts = Object.fromEntries(Object.entries(status.LANES).map(([key, list]) => [key, counts.filter((row) => list.includes(row.status)).reduce((sum, row) => sum + row.n, 0)]));
  const rowValues = [...values, status.LANES[chosen]];
  const filters = [...where, `o.status=ANY($${rowValues.length})`];
  if (chosen === 'done') {
    const tz = business.timezone || 'Asia/Kolkata';
    if (from) { rowValues.push(v.requiredString(from, 'From', 10)); filters.push(`(o.updated_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date>=$${rowValues.length}::date`); }
    if (to) { rowValues.push(v.requiredString(to, 'To', 10)); filters.push(`(o.updated_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date<=$${rowValues.length}::date`); }
    if (!from && !to) filters.push("o.updated_at>now()-interval '1 day'");
  }
  if (q) {
    rowValues.push(`%${String(q).trim().slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    filters.push(`concat_ws(' ',o.order_no,o.guest_name,o.guest_mobile,o.pin_code) ILIKE $${rowValues.length}`);
  }
  const rows = await repo.all(repo.pool, `${BOARD_SQL} AND ${filters.join(' AND ')} ORDER BY ${chosen === 'done' ? 'o.updated_at DESC' : 'o.placed_at'} LIMIT 200`, rowValues);
  const clock = clockOf(business.timezone);
  const now = await repo.one(repo.pool, 'SELECT now() AS at');
  return { lane: chosen, counts: laneCounts, orders: rows.map((row) => cardView(row, clock)), serverTime: now.at };
}

// One order as staff see it: the guest, the lines with their shelves and
// stock, the figures as packed, the changes asked, the complaints and the bill.
async function detailIn(db, business, orderId) {
  const order = await repo.one(db, `${BOARD_SQL} AND o.id=$2`, [business.id, v.requiredId(orderId, 'Online order')]);
  if (!order) fail('Online order not found', 404);
  access.requireLocation(business, order.location_id);
  const link = await repo.one(db, 'SELECT x.*,s.rounding,s.max_bill_discount_percent FROM shop_settings x LEFT JOIN business_settings s ON s.business_id=x.business_id WHERE x.id=$1', [order.settings_id]);
  const lines = await linesOf(db, order);
  const day = await catalog.today(db, business.timezone);
  const stock = await repo.all(db, `SELECT sku_id,sum(quantity) AS quantity,
      json_agg(json_build_object('lotCode',lot_code,'expiresOn',expires_on::text,'quantity',quantity) ORDER BY expires_on NULLS LAST,id) FILTER (WHERE lot_code<>'') AS lots
    FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=ANY($3::bigint[]) AND quantity>0 AND (expires_on IS NULL OR expires_on>=$4::date)
    GROUP BY sku_id`, [business.id, order.location_id, lines.map((line) => line.sku_id), day]);
  const changes = await repo.all(db, 'SELECT * FROM shop_order_changes WHERE business_id=$1 AND order_id=$2 ORDER BY id', [business.id, order.id]);
  const complaints = await complaintsOf(db, order);
  const clock = clockOf(business.timezone);
  const figures = figuresOf(order, lines, { rounding: link.rounding, raised: changes.some((change) => change.status === 'accepted') });
  const goodsAtPrices = lines.filter((line) => !['unavailable', 'replaced'].includes(line.state)).reduce((sum, line) => sum + money.lineAmount(money.paise(line.price),
    line.packed_quantity === null ? Number(line.quantity) : Number(line.packed_quantity)), 0);
  const takenOff = goodsAtPrices - lines.reduce((sum, line) => sum + packedAmount(line), 0);
  const document = order.document_id ? await repo.one(db, `SELECT d.id,d.document_no,d.total,
      COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0) AS paid,
      COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned
    FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, order.document_id]) : null;
  const byStock = new Map(stock.map((row) => [Number(row.sku_id), row]));
  return {
    ...cardView(order, clock),
    address: order.address, landmark: order.landmark, note: order.guest_note, consents: order.consents, substitution: order.substitution,
    contactId: order.contact_id ? Number(order.contact_id) : null, documentId: order.document_id ? Number(order.document_id) : null, returnId: order.return_id ? Number(order.return_id) : null,
    paidBy: order.paid_by,
    lines: lines.map((line) => {
      const held = byStock.get(Number(line.sku_id));
      return { ...lineView(line, { staff: true }), inStock: held ? Number(held.quantity) : 0, lots: held?.lots || [] };
    }),
    figures: { goods: figures.goods / 100, delivery: figures.delivery / 100, roundOff: figures.roundOff / 100, total: figures.total / 100, allowance: figures.allowance / 100,
      ceiling: figures.ceiling / 100, over: figures.over / 100, agreed: Number(order.agreed_total), placedTotal: Number(order.total),
      discountRoom: money.discountRoom({ goodsAmount: goodsAtPrices, takenOff, limitPercent: link.max_bill_discount_percent }) / 100 },
    change: changeView(changes.find((change) => change.status === 'waiting')),
    changes: changes.map(changeView),
    complaints: complaints.map((row) => complaintView(row, clock)),
    document: document ? { id: Number(document.id), number: document.document_no, total: Number(document.total), paid: Number(document.paid), returned: Number(document.returned) } : null,
    upi: link.upi_id ? { id: link.upi_id, payee: link.upi_payee || business.name } : null,
    canCancelGuest: status.canCancel(order),
  };
}

async function detail(business, orderId) {
  await access.require(business, 'online_shop.view');
  await expire(business.id);
  return detailIn(repo.pool, business, orderId);
}

// --- Staff: accept, decline, cancel ------------------------------------------------------------------

async function accept(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.approve');
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    if (order.status === 'accepted' && Number(order.accepted_by) === Number(user.id)) return detailIn(db, business, order.id);
    if (order.status !== 'placed') {
      fail(order.status === 'declined' && order.declined_auto ? 'This order waited too long and was declined by itself. The customer has been told; call them if you can still supply it.'
        : `This order is already ${order.status.replace(/_/g, ' ')}.`, 409, { reason: 'not_placed', status: order.status });
    }
    sameRevision(order, body);
    // The customer record, found by the guest's mobile or made now, with the consents they ticked.
    const { contact, created } = await guests.findOrCreateGuestContact(db, business, { name: order.guest_name, mobile: order.guest_mobile });
    if (order.consents.length && order.privacy_notice_id) {
      await guests.recordGuestConsents(db, business, contact.id, order.consents, order.privacy_notice_id);
    }
    await db.query(`UPDATE shop_orders SET status='accepted',contact_id=$3,accepted_at=now(),accepted_by=$4,revision=revision+1,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, order.id, contact.id, user.id]);
    await repo.audit(db, business.id, user.id, 'online_order.accepted', order.id, { orderNo: order.order_no, contactId: contact.id, newCustomer: created });
    await repo.event(db, business.id, user.id, 'online_order.accepted', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no, contactId: contact.id });
    return detailIn(db, business, order.id);
  });
}

async function decline(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.approve');
  const reason = v.requiredString(body.reason, 'Reason the customer sees', 300);
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    if (order.status !== 'placed') fail(`This order is already ${order.status.replace(/_/g, ' ')}.`, 409, { reason: 'not_placed', status: order.status });
    await db.query(`UPDATE shop_orders SET status='declined',decline_reason=$3,declined_at=now(),declined_by=$4,revision=revision+1,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, order.id, reason, user.id]);
    await repo.audit(db, business.id, user.id, 'online_order.declined', order.id, { orderNo: order.order_no, reason });
    await repo.event(db, business.id, user.id, 'online_order.declined', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no, auto: false });
    return detailIn(db, business, order.id);
  });
}

// The shop cancels an accepted order not billed yet (a billed one is taken back: refused at the door).
async function cancel(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.cancel');
  const reason = v.requiredString(body.reason, 'Reason the customer sees', 300);
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    if (order.status !== 'accepted') {
      fail(order.document_id ? 'This order is billed: take it back as refused or not collected, which returns the bill.' : `This order is ${order.status.replace(/_/g, ' ')}: it cannot be cancelled.`,
        409, { reason: 'not_cancellable', status: order.status });
    }
    await db.query(`UPDATE shop_orders SET status='cancelled',cancelled_by='shop',cancel_reason=$3,cancelled_at=now(),cancelled_by_user=$4,revision=revision+1,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, order.id, reason, user.id]);
    await db.query("UPDATE shop_order_changes SET status='withdrawn',answered_at=now() WHERE order_id=$1 AND status='waiting'", [order.id]);
    await repo.audit(db, business.id, user.id, 'online_order.cancelled', order.id, { orderNo: order.order_no, by: 'shop', reason });
    await repo.event(db, business.id, user.id, 'online_order.cancelled', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no, by: 'shop' });
    return detailIn(db, business, order.id);
  });
}

module.exports = {
  shopPage, shopItems, shopItem, checkCart, place, guestOrder, guestAnswer, cancelByGuest, changeByGuest, loadByGuestToken,
  board, detail, detailIn, accept, decline, cancel, lockOrder, sameRevision, linesOf, figuresOf, packedAmount, expireDue, expire, clearOld,
  nextNumber, clockOf, clockNow, stateOf, AUTO_REASON, NOT_TAKING,
};
