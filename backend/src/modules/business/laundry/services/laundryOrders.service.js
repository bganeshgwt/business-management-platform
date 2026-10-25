const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./laundryCommon');
const money = require('./laundryMoney');

// Garment orders (module "laundry", laundries and dry cleaners).
//
//   take in   a customer (one of the customers, or a new one typed at the
//             counter) and the garments, each with its service from the price
//             list: so many of a garment, or a bundle by the kilo with its
//             pieces counted; its tag (the next number, or the tag already on
//             it), colour and brand, the defects noted, the customer's
//             instructions, what the customer was told about the risk to it
//             and whether they acknowledged it, and a value they declared;
//             express or not (the surcharge as it is set then); the promised
//             day. Each garment is priced from the price list with GST as the
//             core works it out, and keeps that price. Billed at intake (the
//             business's rule when the order is taken in): the bill is posted
//             now, one line a garment, paid now or later. Billed at delivery:
//             an advance may be taken, a numbered collection receipt (the
//             customer's money on account) that pays the bill first.
//   work      a garment goes from received into the work and to ready on a
//             rack (or straight to ready, a quick press); back into the work
//             from ready, saying why; re-tagged or moved to another rack while
//             it is in the shop.
//   status    the order's, worked out from its garments: received, in
//             process, partly ready, ready, partly delivered, delivered, or
//             cancelled (every garment cancelled).
// Handovers, cancellations and damage claims have files of their own. Money
// is integer paise; someone who does not see sales sees orders without money.

const { fail, id } = c;
const MAX_ITEMS = 200;
const MAX_PROMISED_DAYS = 90;
const ADVANCE_KINDS = ['cash', 'card', 'upi', 'bank'];
const MONEY_FIELDS = ['total', 'subtotal', 'tax', 'round_off', 'billed', 'due', 'unbilled', 'advance', 'advance_left', 'balance', 'bill', 'bills', 'paid'];
const ITEM_MONEY = ['rate', 'base', 'surcharge', 'amount', 'net', 'tax', 'declared_value', 'credited'];

const whole = (value, name, min, max) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return Number(text);
};

// --- Lists -----------------------------------------------------------------------------------------

// What is still to pay on a bill: its total less returns and payments, plus refunds.
const DUE_SQL = (d) => `(${d}.total
  -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
  -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
  +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;
// What is left of a receipt: less bills it paid and earlier refunds.
const FREE_SQL = (k) => `${k}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${k}.business_id AND p.collection_id=${k}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${k}.business_id AND f.collection_id=${k}.id),0)`;

// Every order with its garments counted, its status worked out from them, the
// day's flags (on the business's date) and its money: the bills posted for it,
// what is still due on them, what is not billed yet, and the advance left.
const ORDERS_SQL = `SELECT y.*,
    CASE WHEN y.items=y.cancelled_items THEN 'cancelled' WHEN y.open_items=0 THEN 'delivered' WHEN y.delivered_items>0 THEN 'part_delivered'
      WHEN y.ready_items=y.open_items THEN 'ready' WHEN y.ready_items>0 THEN 'part_ready' WHEN y.process_items>0 THEN 'in_process' ELSE 'received' END AS status,
    CASE WHEN y.open_items>0 THEN 'open' ELSE 'closed' END AS stage,
    (y.open_items>y.ready_items AND y.promised_on<y.today) AS overdue,
    (y.open_items>y.ready_items AND y.promised_on=y.today) AS due_today,
    (y.ready_items>0 AND y.open_items=y.ready_items AND y.days_ready>=y.unclaimed_days) AS unclaimed,
    GREATEST(0,y.due+y.unbilled-COALESCE(y.advance_left,0)) AS balance
  FROM (
  SELECT o.id,o.order_no,o.location_id,l.name AS location_name,o.contact_id,o.customer_name,o.customer_phone,o.promised_on,o.express,o.bill_at,o.part_delivery,
    o.total,o.created_at,o.updated_at,o.document_id,t.today,COALESCE(ls.unclaimed_days,30) AS unclaimed_days,
    g.items,g.pieces,g.open_items,g.process_items,g.ready_items,g.delivered_items,g.cancelled_items,g.ready_pieces,g.ready_since,g.racks,g.tags,g.garments,g.unbilled,
    CASE WHEN g.ready_since IS NULL THEN NULL ELSE t.today-(g.ready_since AT TIME ZONE b.timezone)::date END AS days_ready,
    COALESCE(m.billed,0) AS billed,COALESCE(m.due,0) AS due,
    k.amount AS advance,CASE WHEN k.id IS NULL THEN NULL ELSE ${FREE_SQL('k')} END AS advance_left,
    (SELECT count(*)::int FROM laundry_notices n WHERE n.business_id=o.business_id AND n.order_id=o.id AND n.kind='reminder') AS reminders,
    (SELECT max(n.created_at) FROM laundry_notices n WHERE n.business_id=o.business_id AND n.order_id=o.id) AS last_notice_at,
    EXISTS (SELECT 1 FROM laundry_claims cl WHERE cl.business_id=o.business_id AND cl.order_id=o.id AND cl.decision IS NULL) AS claim_open
  FROM laundry_orders o JOIN businesses b ON b.id=o.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.timezone)::date AS today) t
  JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
  LEFT JOIN laundry_settings ls ON ls.business_id=o.business_id
  LEFT JOIN business_collections k ON k.business_id=o.business_id AND k.id=o.advance_collection_id
  CROSS JOIN LATERAL (SELECT count(*)::int AS items,COALESCE(sum(i.pieces),0)::int AS pieces,
      count(*) FILTER (WHERE i.status IN ('received','in_process','ready'))::int AS open_items,
      count(*) FILTER (WHERE i.status='in_process')::int AS process_items,
      count(*) FILTER (WHERE i.status='ready')::int AS ready_items,
      count(*) FILTER (WHERE i.status='delivered')::int AS delivered_items,
      count(*) FILTER (WHERE i.status='cancelled')::int AS cancelled_items,
      COALESCE(sum(i.pieces) FILTER (WHERE i.status='ready'),0)::int AS ready_pieces,
      max(i.ready_at) FILTER (WHERE i.status='ready') AS ready_since,
      string_agg(DISTINCT i.rack,', ') FILTER (WHERE i.status='ready') AS racks,
      string_agg(i.tag_no,' ' ORDER BY i.seq) AS tags,
      string_agg(DISTINCT i.garment_name,', ') AS garments,
      COALESCE(sum(i.net+i.tax) FILTER (WHERE i.status IN ('received','in_process','ready') AND i.line_id IS NULL),0) AS unbilled
    FROM laundry_order_items i WHERE i.business_id=o.business_id AND i.order_id=o.id) g
  LEFT JOIN LATERAL (SELECT sum(d.total) AS billed,sum(${DUE_SQL('d')}) AS due FROM business_documents d
    WHERE d.business_id=o.business_id AND d.id IN (SELECT i.document_id FROM laundry_order_items i WHERE i.business_id=o.business_id AND i.order_id=o.id AND i.document_id IS NOT NULL)) m ON TRUE
  WHERE o.business_id=$1) y`;
const ORDER_LIST = {
  sql: ORDERS_SQL,
  search: ['order_no', 'customer_name', 'customer_phone', 'tags', 'garments', 'racks'], date: 'created_at',
  filters: { status: 'status', stage: 'stage', location: 'location_id', contact: 'contact_id', overdue: 'overdue', due_today: 'due_today', unclaimed: 'unclaimed',
    express: 'express', claim_open: 'claim_open', bill_at: 'bill_at' },
};

// Every garment with its order and customer, for the search by tag, phone or
// order number and for the racks.
const ITEMS_SQL = `SELECT i.id,i.order_id,o.order_no,i.seq,i.tag_no,i.garment_name,i.service_name,i.counted_as,i.colour,i.brand,i.per,i.quantity,i.pieces,i.status,i.rack,
    i.ready_at,i.delivered_at,i.defects,i.risk_note,i.acknowledged,o.customer_name,o.customer_phone,o.contact_id,o.location_id,o.promised_on,o.express,o.created_at,
    CASE WHEN i.status='ready' THEN t.today-(i.ready_at AT TIME ZONE b.timezone)::date END AS days_ready,
    (i.status IN ('received','in_process','ready')) AS in_shop
  FROM laundry_order_items i JOIN laundry_orders o ON o.business_id=i.business_id AND o.id=i.order_id
  JOIN businesses b ON b.id=i.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.timezone)::date AS today) t
  WHERE i.business_id=$1`;
const ITEM_SEARCH = ['tag_no', 'order_no', 'customer_name', 'customer_phone', 'rack', 'garment_name'];

repo.addLists({
  // Every order, newest first (with dates); the open ones by promised day; the unclaimed ones, waiting longest first.
  'laundry-orders': { ...ORDER_LIST, order: 'id DESC' },
  'laundry-orders-open': { ...ORDER_LIST, sql: `SELECT * FROM (${ORDERS_SQL}) z WHERE z.stage='open'`, order: 'promised_on,id' },
  'laundry-unclaimed': { ...ORDER_LIST, sql: `SELECT * FROM (${ORDERS_SQL}) z WHERE z.unclaimed`, order: 'ready_since,id' },
  // Garments: found by tag, phone or order (in the shop first), and those ready on the racks.
  'laundry-items': { sql: ITEMS_SQL, search: ITEM_SEARCH, date: 'created_at',
    filters: { status: 'status', rack: 'rack', order: 'order_id', contact: 'contact_id', location: 'location_id', in_shop: 'in_shop', express: 'express' }, order: 'in_shop DESC, id DESC' },
  'laundry-racks': { sql: `SELECT * FROM (${ITEMS_SQL}) r WHERE r.status='ready'`, search: ITEM_SEARCH,
    filters: { rack: 'rack', location: 'location_id', express: 'express' }, order: 'rack NULLS LAST, ready_at, id' },
});

// What someone who does not see sales sees of an order: no money.
function withoutMoney(row) {
  const out = { ...row };
  for (const key of MONEY_FIELDS) if (key in out) out[key] = null;
  if (Array.isArray(out.items)) out.items = out.items.map((i) => Object.fromEntries(Object.entries(i).map(([k, value]) => [k, ITEM_MONEY.includes(k) ? null : value])));
  if (Array.isArray(out.claims)) out.claims = out.claims.map((x) => ({ ...x, amount: null, asked_amount: null, refunded: null }));
  if (Array.isArray(out.deliveries)) out.deliveries = out.deliveries.map((d) => ({ ...d, total: null }));
  return out;
}
const shape = (business, order) => (c.seesMoney(business) ? { ...order, money: true } : { ...withoutMoney(order), money: false });
const listShape = (business, page) => (c.seesMoney(business) ? page : { ...page, items: page.items.map(withoutMoney) });

// --- Reading a request -----------------------------------------------------------------------------

function readItem(raw, index) {
  const name = `Garment ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  const defects = raw.defects === undefined || raw.defects === null ? [] : v.requiredArray(raw.defects, `${name}: defects`);
  for (const defect of defects) v.requiredEnum(defect, `${name}: defect`, c.DEFECTS);
  if (new Set(defects).size !== defects.length) fail(`${name}: each defect is noted once`);
  const item = {
    garmentTypeId: id(raw.garmentTypeId, `${name}: garment`), serviceId: id(raw.serviceId, `${name}: service`),
    // How many (or how many kilos) and the pieces: read with the price, which says whether it is by the kilo.
    quantity: raw.quantity, pieces: raw.pieces,
    tagNo: c.readTag(raw.tagNo, `${name}: tag`),
    colour: c.optionalText(raw.colour, `${name}: colour`, 40), brand: c.optionalText(raw.brand, `${name}: brand`, 60),
    defects: [...defects].sort(), defectNote: c.optionalText(raw.defectNote, `${name}: note on its defects`, 300),
    instructions: c.optionalText(raw.instructions, `${name}: instructions`, 300),
    riskNote: c.optionalText(raw.riskNote, `${name}: what the customer was told about the risk`, 300),
    acknowledged: v.requiredBoolean(raw.acknowledged, `${name}: acknowledged by the customer`, false),
    declaredValue: c.given(raw.declaredValue) ? core.decimal(raw.declaredValue, `${name}: value declared by the customer`, 2, 0.01, 100000000) : null,
  };
  if (item.acknowledged && !item.defects.length && !item.defectNote && !item.riskNote) {
    fail(`${name}: the customer acknowledges the defects or the risk noted on a garment: note them, or untick it`);
  }
  return item;
}

// The order as asked: what the preview prices and the intake keeps.
function readOrder(body) {
  const items = v.requiredArray(body.items, 'Garments');
  if (!items.length) fail('Add the garments taken in');
  if (items.length > MAX_ITEMS) fail(`An order takes at most ${MAX_ITEMS} garments: take in the rest on another order`);
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : null;
  const newCustomer = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer)
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone } : null;
  return {
    locationId: id(body.locationId, 'Location'), contactId, newCustomer,
    express: v.requiredBoolean(body.express, 'Express', false), notes: c.optionalText(body.notes, 'Notes', 500),
    items: items.map(readItem),
  };
}

// The advance (billed at delivery): { amount, method | methodId, reference? } (no cheques). Needs sales.edit.
async function readAdvance(db, business, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('The advance must be an amount and how it was paid');
  const amount = core.decimal(value.amount ?? 0, 'Advance');
  if (amount <= 0) return null;
  await access.require(business, 'sales.edit');
  return { amount, ...await paymentMethods.pick(db, business.id, value, 'Advance paid by', ADVANCE_KINDS), reference: c.optionalText(value.reference, 'Reference', 100) };
}

// --- Pricing ---------------------------------------------------------------------------------------

// Each garment priced from the price list, as a bill of it would be now: the
// garment and its service in use, the price for each one or by the kilo, the
// express surcharge and GST at the service item's rate.
async function priceOrder(db, business, items, expressPercent) {
  const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const taxMode = settings?.tax_mode || 'exclusive';
  const garments = await repo.all(db, 'SELECT * FROM laundry_garment_types WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, [...new Set(items.map((i) => i.garmentTypeId))]]);
  const services = await repo.all(db, `SELECT ls.*,s.label,s.tax_rate,s.hsn_code,s.internal_use,(s.active AND p.active) AS item_active FROM laundry_services ls
    JOIN catalog_skus s ON s.business_id=ls.business_id AND s.id=ls.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE ls.business_id=$1 AND ls.id=ANY($2::bigint[])`, [business.id, [...new Set(items.map((i) => i.serviceId))]]);
  const prices = await repo.all(db, 'SELECT * FROM laundry_prices WHERE business_id=$1 AND garment_type_id=ANY($2::bigint[]) AND service_id=ANY($3::bigint[])',
    [business.id, garments.map((g) => g.id), services.map((s) => s.id)]);
  const priced = items.map((item, index) => {
    const garment = garments.find((g) => Number(g.id) === item.garmentTypeId);
    const service = services.find((s) => Number(s.id) === item.serviceId);
    if (!garment) fail('Garment not found', 404);
    if (!service) fail('Service not found', 404);
    if (!garment.active) fail(`${garment.name} is switched off on the price list: switch it on to take it in`, 409);
    if (!service.active) fail(`${service.label} is not offered now: switch it on in the price list`, 409);
    if (!service.item_active) fail(`${service.label}, the item it is billed as, is switched off in the catalogue`, 409);
    if (service.internal_use) fail(`${service.label} is kept for use in services only and is not billed`, 409);
    const row = prices.find((p) => Number(p.garment_type_id) === item.garmentTypeId && Number(p.service_id) === item.serviceId);
    if (!row) fail(`${garment.name} has no price for ${service.label} on the price list: add one first`, 409);
    const name = `Garment ${index + 1} (${garment.name})`;
    let quantity, pieces;
    if (row.per === 'kg') {
      if (!c.given(item.quantity)) fail(`${name} is priced by the kilo: give its weight`);
      quantity = core.decimal(item.quantity, `${name}: kilos`, 3, 0.001, 999.999);
      if (!c.given(item.pieces)) fail(`${name}: count the pieces in the bundle as well as weighing it`);
      pieces = whole(item.pieces, `${name}: pieces in the bundle`, 1, 999);
    } else {
      quantity = c.given(item.quantity) ? whole(item.quantity, `${name}: how many`, 1, 999) : 1;
      pieces = c.given(item.pieces) ? whole(item.pieces, `${name}: pieces`, 1, 999) : Math.min(999, quantity * Number(garment.pieces));
    }
    const figures = money.garmentFigures({ per: row.per, rate: row.price, quantity, expressPercent, taxRate: service.tax_rate, taxMode });
    return { ...item, garment, service, per: row.per, rate: row.price, quantity, pieces, figures };
  });
  return { taxMode, rounding: settings?.rounding || 'none', items: priced, figures: money.billFigures(priced.map((p) => p.figures), settings?.rounding) };
}

const pricedText = (p, index) => ({
  index, garmentTypeId: p.garmentTypeId, serviceId: p.serviceId, garmentName: p.garment.name, serviceName: p.service.label, countedAs: p.garment.counted_as,
  per: p.per, rate: Number(p.rate).toFixed(2), quantity: p.per === 'kg' ? p.quantity.toFixed(3) : String(p.quantity), pieces: p.pieces, taxRate: p.service.tax_rate,
  base: money.rupees(p.figures.base), surcharge: money.rupees(p.figures.surcharge), amount: money.rupees(p.figures.amount),
  net: money.rupees(p.figures.net), tax: money.rupees(p.figures.tax),
});

// The figures for an order being typed (the intake screen), nothing saved,
// with the rules it would be taken in under and the promised day suggested.
async function preview(business, user, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.create');
  const input = readOrder(body);
  access.requireLocation(business, input.locationId);
  return repo.transaction(async (db) => {
    const settings = await c.settingsOf(db, business.id);
    const expressPercent = input.express ? Number(settings.express_percent) : 0;
    const priced = await priceOrder(db, business, input.items, expressPercent);
    const day = await c.today(db, business);
    return { taxMode: priced.taxMode, billAt: settings.bill_at, partDelivery: settings.part_delivery, expressPercent: expressPercent.toFixed(2),
      promisedOn: c.addDays(day, input.express ? Number(settings.express_days) : Number(settings.ready_days)), today: day,
      items: priced.items.map(pricedText), ...money.figuresText(priced.figures), pieces: priced.items.reduce((s, p) => s + p.pieces, 0) };
  });
}

// --- Taking in -------------------------------------------------------------------------------------

// The tags of the order's garments: as typed (each free: no garment in the
// shop holds it), and the next numbers for the rest, skipping any in use.
async function assignTags(db, business, items) {
  const typed = items.map((i) => i.tagNo).filter(Boolean);
  const twice = typed.find((tag, index) => typed.indexOf(tag) !== index);
  if (twice) fail(`Tag ${twice} is on two garments of this order`);
  const inUse = async (tags) => repo.all(db, `SELECT i.tag_no,o.order_no FROM laundry_order_items i JOIN laundry_orders o ON o.business_id=i.business_id AND o.id=i.order_id
    WHERE i.business_id=$1 AND i.tag_no=ANY($2::text[]) AND i.status IN ('received','in_process','ready')`, [business.id, tags]);
  const taken = typed.length ? await inUse(typed) : [];
  if (taken.length) fail(`Tag ${taken[0].tag_no} is on a garment of order ${taken[0].order_no} still in the shop: give this one another tag`, 409);
  const tags = [];
  for (const item of items) {
    if (item.tagNo) { tags.push(item.tagNo); continue; }
    for (;;) {
      const counter = await repo.one(db, `INSERT INTO laundry_settings(business_id,last_tag_no) VALUES($1,1)
        ON CONFLICT (business_id) DO UPDATE SET last_tag_no=laundry_settings.last_tag_no+1 RETURNING last_tag_no`, [business.id]);
      const tag = String(counter.last_tag_no);
      if (typed.includes(tag) || tags.includes(tag) || (await inUse([tag])).length) continue;
      tags.push(tag);
      break;
    }
  }
  return tags;
}

// body: { requestKey, locationId, contactId | customer: { name, phone? }, promisedOn, express?, notes?,
//   items: [{ garmentTypeId, serviceId, quantity?, pieces?, tagNo?, colour?, brand?, defects?, defectNote?, instructions?, riskNote?, acknowledged?, declaredValue? }],
//   advance?: { amount, method | methodId, reference? } (billed at delivery), payment? | payments? (billed at intake: paid now), buyer?: { pan?, panDeclaration? } }
async function takeIn(business, user, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const input = readOrder(body);
  if (!input.contactId && !input.newCustomer) fail('Choose the customer, or type the new customer\'s name and phone');
  if (input.contactId && input.newCustomer) fail('Choose the customer or type a new one, not both');
  if (input.newCustomer) await access.require(business, 'contacts.create');
  const parts = core.readPayments(body);
  access.requireLocation(business, input.locationId);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM laundry_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, old.id));
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, input.locationId]);
    if (!location) fail('Location not found', 404);
    const day = await c.today(db, business);
    const promisedOn = c.readDate(body.promisedOn, 'Promised for');
    if (promisedOn < day) fail('The promised day cannot be one that has passed');
    if (promisedOn > c.addDays(day, MAX_PROMISED_DAYS)) fail(`Promise the garments within ${MAX_PROMISED_DAYS} days`);
    const settings = await c.settingsOf(db, business.id);
    const intake = settings.bill_at === 'intake';
    if (intake) await access.require(business, 'sales.create');
    if (parts.length) {
      if (!intake) fail('This laundry bills orders at delivery: take an advance instead of a payment');
      await access.require(business, 'sales.edit');
    }
    const advance = intake ? null : await readAdvance(db, business, body.advance);
    if (intake && c.given(body.advance?.amount) && Number(body.advance.amount) > 0) fail('This laundry bills orders at intake: take the payment on the bill instead of an advance');
    let contact;
    if (input.contactId) {
      contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, input.contactId]);
      if (!contact) fail('Customer not found', 404);
      if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
    } else {
      contact = await core.createContact(business, user, input.newCustomer, db);
    }
    const expressPercent = input.express ? Number(settings.express_percent) : 0;
    const priced = await priceOrder(db, business, input.items, expressPercent);
    const tags = await assignTags(db, business, priced.items);
    if (advance && c.paise(advance.amount) > priced.figures.total) fail(`The advance is part of the order's total: at most ${money.rupees(priced.figures.total)}`);
    const number = await numbering.nextNumber(db, business.id, location.id, 'laundry_order', user.id);
    // Billed at intake: the bill now, one line a garment at its own price.
    let document = null, lineIds = [];
    if (intake) {
      const values = priced.items.map((p, index) => ({
        item: { sku_id: p.service.sku_id, per: p.per, quantity: p.quantity, pieces: p.pieces, garment_name: p.garment.name, service_name: p.service.label,
          surcharge: money.rupees(p.figures.surcharge), tag_no: tags[index] },
        net: p.figures.net, tax: p.figures.tax,
      }));
      const lines = money.billLines(values, priced.taxMode);
      const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
      const documentBody = { kind: 'sale', locationId: location.id, contactId: contact.id, lines: lines.map((l) => l.input),
        notes: [`Laundry order ${number.number}`, input.express ? 'express' : null].filter(Boolean).join(' · '), buyer: { pan: buyer.pan, panDeclaration: buyer.panDeclaration } };
      document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'bill'), hash: c.hashOf(documentBody),
        lines: documentBody.lines, paidNow: parts, fixed: lines.map((l) => l.fixed) });
      if (c.paise(document.total) !== priced.figures.total) fail(`The bill would come to ${document.total}, not the ${money.rupees(priced.figures.total)} worked out for the order. Try again.`, 409);
      lineIds = (await repo.all(db, 'SELECT id,sku_id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id])).map((l) => l.id);
      if (lineIds.length !== priced.items.length) fail('The bill does not have a line for each garment. Try again.', 409);
    }
    // Billed at delivery: the advance, a numbered receipt of the customer's money on account.
    let collection = null;
    if (advance) {
      const receipt = await numbering.nextNumber(db, business.id, location.id, 'collection', user.id);
      collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, location.id, receipt.number, receipt.seriesId, contact.id, contact.name,
        advance.amount.toFixed(2), advance.method, advance.reference, `Advance on laundry order ${number.number}`, c.derivedKey(requestKey, 'advance'), hash, user.id, advance.methodName]);
      await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, laundryOrder: number.number });
      await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
        collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method: collection.method });
    }
    const f = priced.figures;
    const saved = await repo.one(db, `INSERT INTO laundry_orders(business_id,location_id,order_no,series_id,contact_id,customer_name,customer_phone,promised_on,express,express_percent,
        bill_at,part_delivery,tax_mode,subtotal,tax,round_off,total,terms,notes,advance_collection_id,document_id,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24) RETURNING *`,
    [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, contact.phone || null, promisedOn, input.express, expressPercent.toFixed(2),
      settings.bill_at, settings.part_delivery, priced.taxMode, money.rupees(f.subtotal), money.rupees(f.tax), money.rupees(f.roundOff), money.rupees(f.total),
      settings.receipt_terms || null, input.notes, collection?.id || null, document?.id || null, requestKey, hash, user.id]);
    for (const [index, p] of priced.items.entries()) {
      await db.query(`INSERT INTO laundry_order_items(business_id,order_id,seq,tag_no,garment_type_id,service_id,garment_name,service_name,sku_id,counted_as,per,quantity,pieces,
          rate,base,surcharge,amount,tax_rate,net,tax,colour,brand,defects,defect_note,instructions,risk_note,acknowledged,declared_value,document_id,line_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
      [business.id, saved.id, index + 1, tags[index], p.garment.id, p.service.id, p.garment.name, p.service.label, p.service.sku_id, p.garment.counted_as, p.per,
        p.per === 'kg' ? p.quantity.toFixed(3) : p.quantity, p.pieces, Number(p.rate).toFixed(2), money.rupees(p.figures.base), money.rupees(p.figures.surcharge),
        money.rupees(p.figures.amount), p.service.tax_rate, money.rupees(p.figures.net), money.rupees(p.figures.tax), p.colour, p.brand, p.defects, p.defectNote,
        p.instructions, p.riskNote, p.acknowledged, p.declaredValue === null ? null : p.declaredValue.toFixed(2), document?.id || null, lineIds[index] || null]);
    }
    const pieces = priced.items.reduce((s, p) => s + p.pieces, 0);
    // The history names the bill or the receipt, not the amounts: someone who does not see sales reads it too.
    await history(db, business, user, saved, null, null, null, [`Taken in: ${c.plural(priced.items.length, 'garment')} (${c.plural(pieces, 'piece')})`,
      input.express ? 'express' : null, document ? `bill ${document.document_no}` : null, collection ? `advance taken (${collection.collection_no})` : null].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'laundry_order.taken_in', saved.id, { orderNo: saved.order_no, customer: contact.name, garments: priced.items.length, pieces,
      total: saved.total, promisedOn, express: input.express, billAt: settings.bill_at, ...(document ? { documentNo: document.document_no } : {}) });
    await repo.event(db, business.id, user.id, 'laundry_order.taken_in', 'laundry_order', saved.id, {
      orderNo: saved.order_no, locationId: location.id, contactId: contact.id, total: saved.total, promisedOn, express: input.express, billAt: settings.bill_at,
      documentId: document?.id || null, advanceCollectionId: collection?.id || null,
      garments: priced.items.map((p, index) => ({ tag: tags[index], garmentTypeId: p.garment.id, serviceId: p.service.id, per: p.per, quantity: String(p.quantity), pieces: p.pieces })),
    });
    return shape(business, await load(db, business, saved.id));
  });
}

async function history(db, business, user, order, item, from, to, note) {
  await db.query('INSERT INTO laundry_order_events(business_id,order_id,item_id,from_status,to_status,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [business.id, order.id, item?.id || null, from, to, note ? String(note).slice(0, 500) : null, user.id]);
}

// --- Reading an order ------------------------------------------------------------------------------

// The order's status from its garments (as ORDERS_SQL works it out).
function orderStatus(items) {
  const count = (s) => items.filter((i) => i.status === s).length;
  const open = items.filter((i) => c.OPEN.includes(i.status)).length;
  if (items.length && count('cancelled') === items.length) return 'cancelled';
  if (!open) return 'delivered';
  if (count('delivered')) return 'part_delivered';
  if (count('ready') === open) return 'ready';
  if (count('ready')) return 'part_ready';
  if (count('in_process')) return 'in_process';
  return 'received';
}

// The garments of an order (locked when asked) with their item as it is now and what was credited on their bill line.
async function itemsOf(db, business, order, { lock = false } = {}) {
  return repo.all(db, `SELECT i.*,s.tax_rate AS tax_rate_now,(s.active AND p.active) AS sku_active,s.internal_use,d.document_no,
      rb.name AS ready_by_name,dv.name AS delivered_by_name,cb.name AS cancelled_by_name,
      CASE WHEN i.line_id IS NULL THEN NULL ELSE COALESCE((SELECT sum(rl.net+rl.tax) FROM business_return_lines rl WHERE rl.business_id=i.business_id AND rl.line_id=i.line_id),0) END AS credited,
      (SELECT count(*)::int FROM laundry_claims cl WHERE cl.business_id=i.business_id AND cl.item_id=i.id) AS claims,
      EXISTS (SELECT 1 FROM laundry_claims cl WHERE cl.business_id=i.business_id AND cl.item_id=i.id AND cl.decision IS NULL) AS claim_open
    FROM laundry_order_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN business_documents d ON d.business_id=i.business_id AND d.id=i.document_id
    LEFT JOIN users rb ON rb.id=i.ready_by LEFT JOIN users dv ON dv.id=i.delivered_by LEFT JOIN users cb ON cb.id=i.cancelled_by
    WHERE i.business_id=$1 AND i.order_id=$2 ORDER BY i.seq${lock ? ' FOR UPDATE OF i' : ''}`, [business.id, order.id]);
}

// The order's bills, each with what was returned, paid, refunded and is still due.
async function billsOf(db, business, order) {
  return repo.all(db, `SELECT d.id,d.document_no,d.total,d.created_at,d.due_on::text AS due_on,
      COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned,
      COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0) AS paid,
      COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS refunded,
      ${DUE_SQL('d')} AS due
    FROM business_documents d WHERE d.business_id=$1 AND d.id IN (SELECT document_id FROM laundry_order_items WHERE business_id=$1 AND order_id=$2 AND document_id IS NOT NULL)
    ORDER BY d.id`, [business.id, order.id]);
}

async function load(db, business, orderId) {
  const o = await repo.one(db, `SELECT o.*,l.name AS location_name,to_jsonb(l) AS location,cu.name AS created_by_name,
      ct.credit_days,ct.credit_limit,(ct.credit_days>0 OR COALESCE(ct.credit_limit,0)>0) AS has_account,(now() AT TIME ZONE b.timezone)::date::text AS today
    FROM laundry_orders o JOIN businesses b ON b.id=o.business_id JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
    JOIN users cu ON cu.id=o.created_by JOIN business_contacts ct ON ct.business_id=o.business_id AND ct.id=o.contact_id
    WHERE o.business_id=$1 AND o.id=$2`, [business.id, orderId]);
  if (!o) fail('Garment order not found', 404);
  access.requireLocation(business, o.location_id);
  // One query at a time: `db` may be a transaction's own client.
  const items = await itemsOf(db, business, o);
  const events = await repo.all(db, `SELECT e.id,e.item_id,i.tag_no,e.from_status,e.to_status,e.note,e.created_at,u.name AS by_name FROM laundry_order_events e
    JOIN users u ON u.id=e.created_by LEFT JOIN laundry_order_items i ON i.business_id=e.business_id AND i.id=e.item_id
    WHERE e.business_id=$1 AND e.order_id=$2 ORDER BY e.id`, [business.id, o.id]);
  const deliveries = await repo.all(db, `SELECT dv.id,dv.document_id,d.document_no,d.total,dv.on_account,dv.collected_by,dv.note,dv.created_at,u.name AS by_name,
      (SELECT array_agg(i.tag_no ORDER BY i.seq) FROM laundry_delivery_items di JOIN laundry_order_items i ON i.business_id=di.business_id AND i.id=di.item_id
        WHERE di.business_id=dv.business_id AND di.delivery_id=dv.id) AS tags
    FROM laundry_deliveries dv JOIN users u ON u.id=dv.created_by LEFT JOIN business_documents d ON d.business_id=dv.business_id AND d.id=dv.document_id
    WHERE dv.business_id=$1 AND dv.order_id=$2 ORDER BY dv.id`, [business.id, o.id]);
  const claims = await repo.all(db, `SELECT cl.*,i.tag_no,i.garment_name,i.service_name,rp.name AS reported_by_name,dc.name AS decided_by_name,rt.return_no,rt.total AS credit_total,
      f.method AS refund_method,f.method_name AS refund_method_name
    FROM laundry_claims cl JOIN laundry_order_items i ON i.business_id=cl.business_id AND i.id=cl.item_id JOIN users rp ON rp.id=cl.reported_by
    LEFT JOIN users dc ON dc.id=cl.decided_by LEFT JOIN business_returns rt ON rt.business_id=cl.business_id AND rt.id=cl.return_id
    LEFT JOIN business_refunds f ON f.id=cl.refund_id
    WHERE cl.business_id=$1 AND cl.order_id=$2 ORDER BY cl.id`, [business.id, o.id]);
  const notices = await repo.all(db, `SELECT n.kind,n.channel,n.created_at,u.name AS by_name FROM laundry_notices n JOIN users u ON u.id=n.created_by
    WHERE n.business_id=$1 AND n.order_id=$2 ORDER BY n.id DESC LIMIT 20`, [business.id, o.id]);
  const bills = await billsOf(db, business, o);
  const advance = o.advance_collection_id ? await repo.one(db, `SELECT k.id,k.collection_no,k.amount,k.method,k.method_name,k.created_at,${FREE_SQL('k')} AS free,
      COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0) AS used,
      COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),0) AS refunded,
      COALESCE((SELECT json_agg(json_build_object('id',f.id,'refund_no',f.refund_no,'amount',f.amount,'method',f.method,'method_name',f.method_name,'reference',f.reference,
        'reason',f.reason,'created_at',f.created_at,'approved_by_name',a.name) ORDER BY f.id) FROM business_collection_refunds f JOIN users a ON a.id=f.approved_by
        WHERE f.business_id=k.business_id AND f.collection_id=k.id),'[]') AS refunds
    FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, o.advance_collection_id]) : null;
  const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const laundry = await c.settingsOf(db, business.id);
  // What a bill of the garments not billed yet would come to today (billed at delivery).
  const unbilled = items.filter((i) => c.OPEN.includes(i.status) && !i.line_id);
  const due = bills.reduce((s, b) => s + Math.max(0, c.paise(b.due)), 0);
  let bill = null;
  if (o.bill_at === 'delivery' && unbilled.length) {
    const figures = money.billFigures(money.todayValues(o, unbilled), settings?.rounding);
    const left = advance ? Math.max(0, c.paise(advance.free)) : 0;
    bill = { ...money.figuresText(figures), advance: money.rupees(Math.min(left, figures.total)), due: money.rupees(Math.max(0, figures.total - left)),
      rate_changed: unbilled.some((i) => Number(i.tax_rate_now) !== Number(i.tax_rate)) };
  }
  const status = orderStatus(items);
  const ready = items.filter((i) => i.status === 'ready');
  const { request_hash: _hash, location, ...rest } = o;
  return {
    ...rest, status, items, events, deliveries, claims, notices, bills, advance, bill, paid: money.rupees(bills.reduce((s, b) => s + c.paise(b.paid) - c.paise(b.refunded), 0)),
    due: money.rupees(due), counts: { garments: items.length, pieces: items.reduce((s, i) => s + Number(i.pieces), 0), open: items.filter((i) => c.OPEN.includes(i.status)).length,
      ready: ready.length, delivered: items.filter((i) => i.status === 'delivered').length, cancelled: items.filter((i) => i.status === 'cancelled').length },
    unclaimed_days: Number(laundry.unclaimed_days), seller: core.branchSeller(settings, location),
  };
}

async function detail(business, orderId) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  return shape(business, await load(repo.pool, business, id(orderId, 'Garment order')));
}

async function lockOrder(db, business, orderId) {
  // Same lock order as every posting: the business, then the record.
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const order = await repo.one(db, 'SELECT * FROM laundry_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Garment order')]);
  if (!order) fail('Garment order not found', 404);
  access.requireLocation(business, order.location_id);
  return order;
}

// Garment ids as asked ([1, 2]) for this order's garments; null when none are named.
function readItemIds(value) {
  if (value === undefined || value === null) return null;
  const list = v.requiredArray(value, 'Garments');
  if (!list.length) fail('Choose the garments');
  const ids = list.map((x) => id(x, 'Garment'));
  if (new Set(ids).size !== ids.length) fail('Each garment is named once');
  return ids;
}
function pick(items, ids, order) {
  return ids.map((x) => {
    const item = items.find((i) => Number(i.id) === x);
    if (!item) fail(`That garment is not on order ${order.order_no}`, 404);
    return item;
  });
}

// --- The work --------------------------------------------------------------------------------------

// body: { status: in_process | ready, itemIds? (the garments that can take the step), rack?, note? }.
// Into the work: received garments, or ready ones sent back (saying why). Ready:
// received or in process ones, onto the rack given.
async function setStatus(business, user, orderId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.edit');
  const status = v.requiredEnum(body.status, 'Status', ['in_process', 'ready']);
  const ids = readItemIds(body.itemIds);
  const rack = c.readRack(body.rack, 'Rack');
  const note = c.optionalText(body.note, 'Note', 500);
  if (rack && status !== 'ready') fail('A rack is given when garments are ready');
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    const items = await itemsOf(db, business, order, { lock: true });
    const from = status === 'ready' ? ['received', 'in_process'] : ['received', 'ready'];
    const moving = ids ? pick(items, ids, order) : items.filter((i) => (status === 'ready' ? from.includes(i.status) : i.status === 'received'));
    if (!moving.length) fail(`No garment of order ${order.order_no} can go ${status === 'ready' ? 'to ready' : 'into the work'} now`, 409);
    for (const item of moving) {
      if (item.status === status) continue;
      if (!from.includes(item.status)) fail(`Garment ${item.tag_no} is ${c.STATUS_WORDS[item.status]}: it cannot go ${status === 'ready' ? 'to ready' : 'into the work'}`, 409);
      if (item.status === 'ready' && !note) fail(`Say why garment ${item.tag_no} goes back into the work`);
    }
    const changing = moving.filter((i) => i.status !== status);
    for (const item of changing) {
      if (status === 'ready') {
        await db.query("UPDATE laundry_order_items SET status='ready',rack=$3,ready_at=now(),ready_by=$4 WHERE business_id=$1 AND id=$2", [business.id, item.id, rack, user.id]);
      } else {
        await db.query("UPDATE laundry_order_items SET status='in_process',rack=NULL,ready_at=NULL,ready_by=NULL WHERE business_id=$1 AND id=$2", [business.id, item.id]);
      }
      await history(db, business, user, order, item, item.status, status, [status === 'ready' && rack ? `On rack ${rack}` : null, note].filter(Boolean).join(' · ') || null);
    }
    if (changing.length) {
      const tags = changing.map((i) => i.tag_no);
      await repo.audit(db, business.id, user.id, 'laundry_order.garments_moved', order.id, { orderNo: order.order_no, to: status, tags, ...(rack ? { rack } : {}), ...(note ? { note } : {}) });
      await repo.event(db, business.id, user.id, 'laundry_order.garments_moved', 'laundry_order', order.id, { orderNo: order.order_no, to: status, itemIds: changing.map((i) => i.id), rack });
    }
    return shape(business, await load(db, business, order.id));
  });
}

// body: { tagNo?, rack? } — a garment re-tagged while in the shop, or a ready one moved to another rack.
async function updateItem(business, user, orderId, itemId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.edit');
  const tag = body.tagNo === undefined ? undefined : c.readTag(body.tagNo, 'Tag number');
  const rack = body.rack === undefined ? undefined : c.readRack(body.rack, 'Rack');
  if (tag === undefined && rack === undefined) fail('Give the new tag or the rack');
  if (tag === null) fail('A garment keeps a tag: give the new one');
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    const item = (await itemsOf(db, business, order, { lock: true })).find((i) => Number(i.id) === Number(id(itemId, 'Garment')));
    if (!item) fail(`That garment is not on order ${order.order_no}`, 404);
    if (!c.OPEN.includes(item.status)) fail(`Garment ${item.tag_no} is ${c.STATUS_WORDS[item.status]}: it is no longer in the shop`, 409);
    const notes = [];
    if (tag !== undefined && tag !== item.tag_no) {
      const taken = await repo.one(db, `SELECT o.order_no FROM laundry_order_items i JOIN laundry_orders o ON o.business_id=i.business_id AND o.id=i.order_id
        WHERE i.business_id=$1 AND i.tag_no=$2 AND i.status IN ('received','in_process','ready') AND i.id<>$3`, [business.id, tag, item.id]);
      if (taken) fail(`Tag ${tag} is on a garment of order ${taken.order_no} still in the shop`, 409);
      await db.query('UPDATE laundry_order_items SET tag_no=$3 WHERE business_id=$1 AND id=$2', [business.id, item.id, tag]);
      notes.push(`Re-tagged from ${item.tag_no} to ${tag}`);
    }
    if (rack !== undefined && rack !== item.rack) {
      if (item.status !== 'ready') fail(`Garment ${item.tag_no} goes on a rack once it is ready`, 409);
      await db.query('UPDATE laundry_order_items SET rack=$3 WHERE business_id=$1 AND id=$2', [business.id, item.id, rack]);
      notes.push(rack ? `Moved to rack ${rack}` : 'Taken off its rack');
    }
    if (notes.length) {
      await history(db, business, user, order, item, null, null, notes.join(' · '));
      await repo.audit(db, business.id, user.id, 'laundry_order.garment_updated', order.id, { orderNo: order.order_no, tag: item.tag_no,
        ...(tag !== undefined && tag !== item.tag_no ? { tagTo: tag } : {}), ...(rack !== undefined && rack !== item.rack ? { rackFrom: item.rack, rackTo: rack } : {}) });
    }
    return shape(business, await load(db, business, order.id));
  });
}

// body: { promisedOn?, notes? } — what is left out stays.
async function updateDetails(business, user, orderId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.edit');
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    const items = await itemsOf(db, business, order);
    if (!items.some((i) => c.OPEN.includes(i.status))) fail(`Order ${order.order_no} has no garment left in the shop and no longer changes`, 409);
    const day = await c.today(db, business);
    const was = String(order.promised_on).slice(0, 10);
    let promisedOn = was;
    if (body.promisedOn !== undefined) {
      promisedOn = c.readDate(body.promisedOn, 'Promised for');
      if (promisedOn !== was && promisedOn < day) fail('The promised day cannot be one that has passed');
      if (promisedOn > c.addDays(day, MAX_PROMISED_DAYS)) fail(`Promise the garments within ${MAX_PROMISED_DAYS} days`);
    }
    const notes = body.notes === undefined ? order.notes : c.optionalText(body.notes, 'Notes', 500);
    if (promisedOn === was && notes === order.notes) return shape(business, await load(db, business, order.id));
    await db.query('UPDATE laundry_orders SET promised_on=$3,notes=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, order.id, promisedOn, notes, user.id]);
    const said = [promisedOn !== was ? `promised day now ${c.dateWords(promisedOn)}` : null, notes !== order.notes ? 'notes changed' : null].filter(Boolean);
    await history(db, business, user, order, null, null, null, `Changed: ${c.listWords(said)}`);
    await repo.audit(db, business.id, user.id, 'laundry_order.updated', order.id, { orderNo: order.order_no,
      ...(promisedOn !== was ? { promisedOn: { from: was, to: promisedOn } } : {}), ...(notes !== order.notes ? { notes: { from: order.notes, to: notes } } : {}) });
    return shape(business, await load(db, business, order.id));
  });
}

// A message or call to the customer, kept with the order (the reminders count
// on the unclaimed list). The message itself goes from the person's own
// WhatsApp (a wa.me link). body: { kind: received | ready | delayed | reminder, channel? }
async function logNotice(business, user, orderId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  const kind = v.requiredEnum(body.kind, 'Message', c.NOTICES);
  const channel = v.requiredEnum(body.channel ?? 'whatsapp', 'How', c.CHANNELS);
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    await db.query('INSERT INTO laundry_notices(business_id,order_id,kind,channel,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, order.id, kind, channel, user.id]);
    const how = { whatsapp: 'WhatsApp sent', call: 'Called the customer', sms: 'SMS sent' };
    const what = { received: 'order taken in', ready: 'ready to collect', delayed: 'running late', reminder: 'reminder to collect' };
    await history(db, business, user, order, null, null, null, `${how[channel]}: ${what[kind]}`);
    await repo.audit(db, business.id, user.id, 'laundry_order.customer_told', order.id, { orderNo: order.order_no, kind, channel });
    const count = await repo.one(db, "SELECT count(*)::int AS n FROM laundry_notices WHERE business_id=$1 AND order_id=$2 AND kind='reminder'", [business.id, order.id]);
    return { logged: true, kind, channel, reminders: count.n };
  });
}

// --- The day's picture and the bell ------------------------------------------------------------------

async function counts(business) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  return repo.one(repo.pool, `SELECT count(*) FILTER (WHERE stage='open')::int AS open, count(*) FILTER (WHERE status='received')::int AS received,
      count(*) FILTER (WHERE status='in_process')::int AS in_process, count(*) FILTER (WHERE status='part_ready')::int AS part_ready,
      count(*) FILTER (WHERE status='ready')::int AS ready, count(*) FILTER (WHERE status='part_delivered')::int AS part_delivered,
      count(*) FILTER (WHERE due_today)::int AS due_today, count(*) FILTER (WHERE overdue)::int AS overdue, count(*) FILTER (WHERE unclaimed)::int AS unclaimed,
      count(*) FILTER (WHERE stage='open' AND express)::int AS express, count(*) FILTER (WHERE claim_open)::int AS claim_open,
      COALESCE(sum(ready_pieces) FILTER (WHERE stage='open'),0)::int AS ready_pieces
    FROM (${ORDERS_SQL}) x WHERE ($2::bigint IS NULL OR x.location_id=$2)`, [business.id, business.location_scope || null]);
}

// The bell: orders past their promised day with garments not ready, and the
// orders ready and not collected for the business's days.
async function bell(business, base, limit) {
  const late = await repo.all(repo.pool, `SELECT id,order_no,customer_name,promised_on::text AS promised_on,today-promised_on AS late,updated_at
    FROM (${ORDERS_SQL}) x WHERE x.overdue AND ($3::bigint IS NULL OR x.location_id=$3) ORDER BY x.promised_on,x.id LIMIT $2`, [business.id, limit, business.location_scope || null]);
  const items = late.map((o) => ({ id: `laundry:${o.id}:late:${o.promised_on}`, severity: 'warning', category: 'Garment orders', title: `${o.order_no} is past its promised day`,
    detail: `${o.customer_name} · promised ${Number(o.late) === 1 ? 'yesterday' : `${o.late} days ago`}`, at: new Date(o.updated_at || Date.now()).toISOString(),
    link: `${base}/garment-orders/${o.id}` }));
  const waiting = await repo.one(repo.pool, `SELECT count(*)::int AS n,min(ready_since) AS oldest,max(unclaimed_days)::int AS days FROM (${ORDERS_SQL}) x
    WHERE x.unclaimed AND ($2::bigint IS NULL OR x.location_id=$2)`, [business.id, business.location_scope || null]);
  if (waiting.n > 0) {
    items.push({ id: `laundry:unclaimed:${waiting.n}`, severity: 'info', category: 'Garment orders',
      title: `${c.plural(waiting.n, 'order')} ready and not collected for ${waiting.days} days or more`, detail: 'Send a reminder from Unclaimed',
      at: new Date(waiting.oldest || Date.now()).toISOString(), link: `${base}/unclaimed` });
  }
  return items;
}

// Who may approve: a refund for cancelled garments or a damage claim
// (laundry.refund), or an advance handed back (sales.refund). Members whose
// role holds it, with whether they have a PIN.
const APPROVALS = ['laundry.refund', 'sales.refund'];
async function approvers(business, query = {}) {
  c.requireLaundry(business);
  const permission = query.permission === undefined ? 'laundry.refund' : String(query.permission);
  if (!APPROVALS.includes(permission)) fail('Unknown approval');
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code=$2))
    ORDER BY u.name`, [business.id, permission]);
}

module.exports = { ORDERS_SQL, DUE_SQL, FREE_SQL, shape, listShape, withoutMoney, preview, takeIn, detail, load, lockOrder, itemsOf, billsOf, history, readItemIds, pick,
  setStatus, updateItem, updateDetails, logNotice, counts, bell, approvers, orderStatus };
