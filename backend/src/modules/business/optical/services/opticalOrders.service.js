const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./opticalCommon');
const { ROWS_SQL } = require('./opticalPrescriptions.service');
// The core's pricing of lines as a sale, its stock picking, and a quotation's checks (quotations).
const quotes = () => require('../../quotations/services/businessQuotations.service');
// Advance refunds and the manager's PIN (shared with the salon and repairs).
const refunds = () => require('../../salon-weight/services/businessAdvanceRefunds');
const pins = () => require('../../salon-weight/services/businessManagerPin');
// The shop's warranty months and its rule for a remake under warranty.
const settingsOf = (db, business) => require('./opticalRecall.service').readSettings(db, business);
// Frames held in stock for an order, more advances and the workshop's steps.
const work = () => require('./opticalOrderWork.service');

// Spectacle orders (module "optical", optical shops): the job card.
//
//   book      a customer's spectacle prescription (copied onto the order as it
//             is), the frame (from stock, or the customer's own; held in stock
//             for the order when asked), the right and left lens (a lens item,
//             whose index, material, coatings, design and tint the order
//             takes from the item, or described and billed on another line),
//             other items, each eye's fitting PD and height, the frame's size
//             (A, B, DBL), where it is made (in-house or at a lab), the
//             promised day and the doctor who referred the customer. The item
//             lines are priced by the core exactly as a sale of them would be
//             now (customer and slab prices, offers, the discount, GST,
//             round-off) and the prices are kept; or, booked from a quotation,
//             they are the quotation's lines at its prices, and the quotation
//             is closed as booked. An advance is a numbered collection
//             receipt: the customer's money on account, taken off the bill.
//             More advances may be taken while the order is open.
//   work      booked → at the lab / in the workshop (cutting, edging,
//             fitting) → quality check → ready; the quality check is passed or
//             failed by someone who may approve it, and a fail (or spectacles
//             found wrong once ready) goes back to the lab or the workshop
//             with what was wrong. From the workshop the quality check needs
//             the fitting done.
//   change    while booked (before the lab or the workshop), its frame,
//             lenses and prices can be changed by someone who may manage
//             orders (opticalOrderWork.service.js).
//   deliver   the item lines become a sale bill posted by the core at the
//             booked prices, with GST at each item's rate on the day (a price
//             that includes GST keeps its total; one before GST keeps its
//             taxable value); the frame and other goods leave stock only now
//             (a held frame from its hold), so an item not in usable stock at
//             the order's location stops the delivery until it is received.
//             The advances pay first; the rest is paid now or left on the
//             customer's dues. Each lens's warranty (and its coatings') is
//             dated from the delivery by the shop's months.
//   cancel    with a reason; a held frame goes back to stock; the advances
//             stay the customer's, handed back from the order (a manager's
//             PIN) or used on a later bill.
//   remake    a new order linked to a delivered one, with the reason and who
//             bears the cost; the customer pays nothing unless it is them. A
//             remake under the lens's (or the coating's) warranty is free when
//             the shop's rule says so.
// Money is integer paise; quantities integer thousandths. Someone who does not
// see sales sees an order without its money.

const { fail } = c;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const derivedKey = (key, part) => {
  const h = crypto.createHash('sha256').update(`${key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
// What is left of a receipt: less bills it paid and earlier refunds.
const FREE_SQL = (k) => `${k}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${k}.business_id AND p.collection_id=${k}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${k}.business_id AND f.collection_id=${k}.id),0)`;
// The usual next steps (the first is the screen's main button). Ready and
// delivered go through the quality check and delivery below.
const MOVES = {
  booked: ['at_lab', 'in_workshop'],
  at_lab: ['in_workshop', 'quality_check'],
  in_workshop: ['quality_check', 'at_lab'],
  quality_check: ['ready', 'in_workshop', 'at_lab'],
  ready: ['in_workshop', 'at_lab'],
};
// How far ahead an order may be promised.
const MAX_PROMISED_DAYS = 365;
const ADVANCE_KINDS = ['cash', 'card', 'upi', 'bank'];
// A remake for one of these reasons is a warranty matter: the coating's warranty, or the lens's.
const WARRANTY_FIELD = { coating: 'coating_warranty_until', lab_defect: 'warranty_until', breakage: 'warranty_until' };
const MONEY_FIELDS = ['subtotal', 'tax', 'round_off', 'total', 'savings', 'discount_amount', 'discount_percent', 'bill_total', 'advance', 'advances', 'advance_left', 'balance'];
const LINE_MONEY = ['unit_price', 'amount', 'discount', 'net', 'tax', 'entered_unit_price', 'mrp', 'offers'];

// --- Lists ----------------------------------------------------------------------------------

const ORDERS_SQL = `SELECT x.*,CASE WHEN x.status IN ('delivered','cancelled') THEN 'closed' ELSE 'open' END AS stage FROM (
  SELECT o.id,o.order_no,o.location_id,o.contact_id,o.customer_name,o.customer_phone,o.prescription_id,o.made_at,o.lab_name,o.lab_order_no,o.promised_on,
    o.status,o.remake_of,o.remake_reason,o.remake_cost_by,o.remake_under_warranty,o.total,o.document_id,o.delivered_at,o.created_at,o.updated_at,o.checked_at,
    o.referred_by,o.quotation_id,
    l.name AS location_name,d.document_no,r.order_no AS remake_of_no,
    (SELECT COALESCE(f.label,f.description) FROM optical_order_lines f WHERE f.business_id=o.business_id AND f.order_id=o.id AND f.part='frame') AS frame,
    (SELECT string_agg(DISTINCT replace(n.lens_type,'_',' '),' / ') FROM optical_order_lines n WHERE n.business_id=o.business_id AND n.order_id=o.id AND n.part='lens') AS lenses,
    adv.amount AS advance,adv.free AS advance_left,adv.receipts AS advances_taken,
    CASE WHEN o.status IN ('delivered','cancelled') THEN NULL ELSE o.total-COALESCE(adv.amount,0) END AS balance,
    (o.status NOT IN ('ready','delivered','cancelled') AND o.promised_on = (now() AT TIME ZONE b.timezone)::date) AS due_today,
    (o.status NOT IN ('ready','delivered','cancelled') AND o.promised_on < (now() AT TIME ZONE b.timezone)::date) AS overdue,
    (o.status='ready') AS ready,
    (o.status='cancelled' AND COALESCE(adv.free,0) > 0) AS advance_to_refund,
    EXISTS (SELECT 1 FROM optical_frame_holds h WHERE h.business_id=o.business_id AND h.order_id=o.id AND h.status='held') AS frame_held,
    (SELECT max(e.created_at) FROM optical_order_events e WHERE e.business_id=o.business_id AND e.order_id=o.id AND e.to_status=o.status
      AND e.from_status IS DISTINCT FROM e.to_status) AS status_since
  FROM optical_orders o JOIN businesses b ON b.id=o.business_id
  JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
  LEFT JOIN LATERAL (SELECT sum(k.amount) AS amount,sum(${FREE_SQL('k')}) AS free,count(*)::int AS receipts FROM optical_order_advances a
    JOIN business_collections k ON k.business_id=a.business_id AND k.id=a.collection_id WHERE a.business_id=o.business_id AND a.order_id=o.id) adv ON adv.receipts > 0
  LEFT JOIN business_documents d ON d.business_id=o.business_id AND d.id=o.document_id
  LEFT JOIN optical_orders r ON r.business_id=o.business_id AND r.id=o.remake_of
  WHERE o.business_id=$1) x`;
const ORDER_LIST = {
  sql: ORDERS_SQL,
  search: ['order_no', 'customer_name', 'customer_phone', 'lab_name', 'lab_order_no', 'frame', 'document_no', 'referred_by'], date: 'created_at',
  filters: { status: 'status', stage: 'stage', location: 'location_id', contact: 'contact_id', due_today: 'due_today', overdue: 'overdue', ready: 'ready',
    made_at: 'made_at', prescription: 'prescription_id', advance_to_refund: 'advance_to_refund', frame_held: 'frame_held', quotation: 'quotation_id' },
};
repo.addLists({
  // Every order, newest first (with dates), and the open ones by promised day.
  'optical-orders': { ...ORDER_LIST, order: 'id DESC' },
  'optical-orders-open': { ...ORDER_LIST, sql: `SELECT * FROM (${ORDERS_SQL}) y WHERE y.stage='open'`, order: 'promised_on,id' },
});

// What someone who does not see sales sees of an order: no money.
const seesMoney = (business) => access.can(business, 'sales.view');
function withoutMoney(row) {
  const out = { ...row };
  for (const key of MONEY_FIELDS) if (key in out) out[key] = null;
  if (Array.isArray(out.lines)) out.lines = out.lines.map((l) => Object.fromEntries(Object.entries(l).map(([key, value]) => [key, LINE_MONEY.includes(key) ? null : value])));
  if ('bill' in out) out.bill = null;
  return { ...out, money: false };
}
const shape = (business, order) => (seesMoney(business) ? { ...order, money: true } : withoutMoney(order));
function listShape(business, page) {
  return seesMoney(business) ? page : { ...page, items: page.items.map((row) => { const out = withoutMoney(row); delete out.money; return out; }) };
}

// --- Reading a request ---------------------------------------------------------------------

// The frame: { skuId } from stock, { ownFrame: true, description }, or (booked
// from a quotation) { quotationLineId }.
function readFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Choose the frame: one from stock, or the customer\'s own');
  if (value.ownFrame === true) {
    return { own: true, skuId: null, description: v.requiredString(typeof value.description === 'string' ? value.description : '', 'What the customer\'s own frame is', 200) };
  }
  if (c.given(value.quotationLineId)) return { own: false, skuId: null, quotationLineId: id(value.quotationLineId, 'Frame'), description: c.optionalText(value.description, 'Frame notes', 200) };
  return { own: false, skuId: id(value.skuId, 'Frame'), description: c.optionalText(value.description, 'Frame notes', 200) };
}

// One lens: { eye, lensType?, skuId? | quotationLineId?, index?, material?, coatings?, tint?, brand?, description? }.
// A lens item's own details fill what is left out (applyLensItems).
function readLens(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each lens must be an object');
  const eye = v.requiredEnum(raw.eye, 'Lens for', c.EYES);
  const name = capital(`${c.EYE_WORDS[eye]} lens`);
  return {
    eye, name, lensType: c.given(raw.lensType) ? v.requiredEnum(raw.lensType, `${name}: type`, c.LENS_TYPES) : null,
    skuId: c.given(raw.skuId) ? id(raw.skuId, `${name}: item`) : null, quotationLineId: c.given(raw.quotationLineId) ? id(raw.quotationLineId, `${name}: quotation line`) : null,
    index: c.readIndex(raw.index, `${name}: index`), material: v.optionalEnum(raw.material, `${name}: material`, c.MATERIALS, null),
    coatings: c.readCoatings(raw.coatings, `${name}: coatings`), tint: c.optionalText(raw.tint, `${name}: tint`, 60), brand: c.optionalText(raw.brand, `${name}: brand`, 100),
    description: c.optionalText(raw.description, `${name}: description`, 200),
  };
}
function readLenses(value) {
  const list = v.requiredArray(value, 'Lenses');
  if (!list.length) fail('Give the right lens, the left lens or both');
  if (list.length > 2) fail('A pair of spectacles has two lenses');
  const lenses = list.map(readLens);
  if (new Set(lenses.map((l) => l.eye)).size !== lenses.length) fail('Each eye has one lens');
  return lenses.sort((a, b) => c.EYES.indexOf(a.eye) - c.EYES.indexOf(b.eye));
}
// Other items billed with the spectacles (a case, a fitting charge, the lab's lens charge).
function readItems(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Other items');
  if (list.length > 20) fail('Add at most 20 other items to an order');
  return list.map((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) fail('Each item must be an object');
    return { skuId: id(line.skuId, 'Item'), quantity: line.quantity ?? 1, ...(line.unit ? { unit: String(line.unit).slice(0, 20) } : {}) };
  });
}
// Each eye's fitting PD and fitting height, and the frame's size, in mm.
function readFitting(value) {
  const m = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    pdRight: c.readMillimetres(m.pdRight, 'Fitting PD of the right eye', 20, 45), pdLeft: c.readMillimetres(m.pdLeft, 'Fitting PD of the left eye', 20, 45),
    heightRight: c.readMillimetres(m.fittingHeightRight, 'Fitting height of the right eye', 5, 45),
    heightLeft: c.readMillimetres(m.fittingHeightLeft, 'Fitting height of the left eye', 5, 45),
    frameA: c.readMillimetres(m.frameA, 'Frame size A (lens width)', 20, 80), frameB: c.readMillimetres(m.frameB, 'Frame size B (lens height)', 10, 70),
    frameDbl: c.readMillimetres(m.frameDbl, 'Frame size DBL (bridge)', 10, 30),
  };
}
// Where it is made: in the shop's workshop, or at a lab (its name, and its order number when known).
function readMadeAt(body) {
  const madeAt = v.requiredEnum(body.madeAt, 'Made', ['in_house', 'lab']);
  if (madeAt === 'in_house') {
    if (c.given(body.labName) || c.given(body.labOrderNo)) fail('A lab\'s name and order number go with spectacles made at a lab');
    return { madeAt, labName: null, labOrderNo: null };
  }
  return { madeAt, labName: v.requiredString(typeof body.labName === 'string' ? body.labName : '', 'The lab\'s name', 150), labOrderNo: c.optionalText(body.labOrderNo, 'The lab\'s order number', 60) };
}
// A remake: { orderId, reason, costBy, note? }.
function readRemake(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('A remake names the order it makes again');
  return { orderId: id(value.orderId, 'Order to remake'), reason: v.requiredEnum(value.reason, 'Why it is made again', c.REMAKE_REASONS),
    costBy: v.requiredEnum(value.costBy, 'Who bears the cost', c.COST_BEARERS), note: c.optionalText(value.note, 'Note on the remake', 300) };
}
// An advance: { amount, method or methodId, reference? } (no cheques). Needs sales.edit.
async function readAdvance(business, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('The advance must be an amount and how it was paid');
  const amount = core.decimal(value.amount ?? 0, 'Advance');
  if (amount <= 0) return null;
  await access.require(business, 'sales.edit');
  return { amount, ...await paymentMethods.pick(repo.pool, business.id, value, 'Advance paid by', ADVANCE_KINDS), reference: c.optionalText(value.reference, 'Reference', 100) };
}

// The order's frame, lenses and items as asked: what the preview prices, the booking keeps and a change replaces.
function readOrder(body) {
  return {
    locationId: id(body.locationId, 'Location'), prescriptionId: id(body.prescriptionId, 'Prescription'),
    frame: readFrame(body.frame), lenses: readLenses(body.lenses), items: readItems(body.items), remake: readRemake(body.remake),
    discount: quotes().readDiscount(body), quotationId: c.given(body.quotationId) ? id(body.quotationId, 'Quotation') : null,
  };
}

// --- Pricing ----------------------------------------------------------------------------------

// The item lines in the order the core prices them: frame, right lens, left lens, other items.
function pricedInputs({ frame, lenses, items }) {
  const list = [];
  if (frame.skuId) list.push({ part: 'frame', input: { skuId: frame.skuId, quantity: 1 } });
  for (const lens of lenses) if (lens.skuId) list.push({ part: 'lens', eye: lens.eye, input: { skuId: lens.skuId, quantity: 1 } });
  for (const item of items) list.push({ part: 'item', input: item });
  return list;
}

// The items exist and are sold; the frame is goods; a kit goes as its parts.
async function checkItems(db, business, priced) {
  const ids = [...new Set(priced.map((p) => p.input.skuId))];
  if (!ids.length) return;
  const found = await repo.all(db, `SELECT s.id,s.label,s.is_kit,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.id=ANY($2::bigint[]) AND s.active AND p.active`, [business.id, ids]);
  for (const p of priced) {
    const sku = found.find((s) => Number(s.id) === Number(p.input.skuId));
    if (!sku) fail('Item not found', 404);
    if (sku.is_kit) fail(`${sku.label} is a kit: put its parts on the order instead`);
    if (p.part === 'frame' && sku.kind !== 'goods') fail(`${sku.label} is a service: the frame is an item from stock, or the customer's own`);
  }
}

// A lens billed as a lens item takes the item's own details (its design,
// index, material, coatings and tint), so they are picked, not typed; one
// typed that differs from the item's is refused. A lens with no item needs
// its type.
async function applyLensItems(db, business, lenses) {
  const ids = lenses.filter((l) => l.skuId).map((l) => l.skuId);
  const items = ids.length ? await repo.all(db, 'SELECT id,label,attributes FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, ids]) : [];
  for (const lens of lenses) {
    const item = items.find((s) => Number(s.id) === Number(lens.skuId));
    const kept = item?.attributes || {};
    const take = (field, key, words, normal = (x) => String(x)) => {
      if (kept[key] === undefined || kept[key] === null || kept[key] === '') return;
      if (lens[field] === null || lens[field] === undefined) lens[field] = kept[key];
      else if (normal(lens[field]) !== normal(kept[key])) fail(`${lens.name}: ${item.label} is ${words(kept[key])}; the order takes the item's own`);
    };
    if (item) {
      take('lensType', 'lensDesign', (x) => `a ${c.LENS_WORDS[x] || x} lens`);
      take('index', 'lensIndex', (x) => `of index ${Number(x).toFixed(2)}`, (x) => Number(x).toFixed(2));
      take('material', 'lensMaterial', (x) => `of ${x}`);
      take('tint', 'tint', (x) => `tinted ${x}`);
      if (Array.isArray(kept.coatings) && kept.coatings.length) {
        const own = [...kept.coatings].sort();
        if (!lens.coatings.length) lens.coatings = own;
        else if (JSON.stringify(lens.coatings) !== JSON.stringify(own)) fail(`${lens.name}: ${item.label} is coated ${c.listWords(own.map((x) => x.replace(/_/g, ' ')))}; the order takes the item's own`);
      }
      if (lens.index !== null) lens.index = Number(lens.index).toFixed(2);
    }
    if (!lens.lensType) fail(`${lens.name}: choose its type (single vision, bifocal or progressive)`);
  }
}

// What the lines come to, worked out by the core as a sale of them would be
// now and not saved; a remake the shop or the lab bears costs nothing.
async function price(db, business, user, { locationId, contact, priced, discount, free }) {
  if (!priced.length) {
    const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
    return { taxMode: settings?.tax_mode || 'exclusive', lines: [], subtotal: '0.00', tax: '0.00', roundOff: '0.00', total: '0.00', savings: '0.00' };
  }
  const quoted = await quotes().priceIn(db, business, user, { locationId, contact, lines: priced.map((p) => p.input), discount: free ? null : discount });
  const lines = quoted.lines.map((line, index) => ({ ...line, part: priced[index].part, eye: priced[index].eye || null }));
  if (!free) return { ...quoted, lines };
  return { ...quoted, lines: lines.map((l) => ({ ...l, unitPrice: '0.00', amount: '0.00', discount: '0.00', net: '0.00', tax: '0.00', enteredUnitPrice: l.enteredUnit ? '0.00' : null, offers: [] })),
    subtotal: '0.00', tax: '0.00', roundOff: '0.00', total: '0.00', savings: '0.00' };
}

// The prescription of the order, locked, with its powers: a spectacle one.
async function prescriptionOf(db, business, prescriptionId) {
  const p = await repo.one(db, `SELECT p.*,${ROWS_SQL('p')} AS rows FROM optical_prescriptions p
    WHERE p.business_id=$1 AND p.id=$2 FOR UPDATE OF p`, [business.id, prescriptionId]);
  if (!p) fail('Prescription not found', 404);
  if (p.kind !== 'spectacles') fail('That is a contact-lens prescription: spectacles are made from a spectacle prescription', 409);
  const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, p.contact_id]);
  if (!contact) fail('The customer of this prescription is switched off: switch them on again first', 409);
  return { p, contact };
}

// A lens is made from the prescription's powers for its eye; a bifocal or
// progressive lens needs that eye's near power (the ADD). Each lens needs its
// eye's fitting PD, and a bifocal or progressive one its fitting height.
function checkLenses(rx, lenses, fitting) {
  for (const lens of lenses) {
    const eye = c.EYE_WORDS[lens.eye];
    const rows = rx.rows.filter((r) => r.eye === lens.eye);
    if (!rows.length) fail(`The prescription has no powers for the ${eye}: leave out that lens, or record a prescription with them`);
    if (lens.lensType !== 'single_vision' && !rows.some((r) => r.zone !== 'distance' && (r.add !== null || r.sph !== null))) {
      fail(`A ${c.LENS_WORDS[lens.lensType]} lens for the ${eye} needs its near power (the ADD) on the prescription`);
    }
    if ((lens.eye === 'right' ? fitting.pdRight : fitting.pdLeft) === null) fail(`Give the fitting PD of the ${eye} (from the prescription, or measured)`);
    if (lens.lensType !== 'single_vision' && (lens.eye === 'right' ? fitting.heightRight : fitting.heightLeft) === null) {
      fail(`A ${c.LENS_WORDS[lens.lensType]} lens needs the fitting height of the ${eye}`);
    }
  }
}

// The prescription as it is copied onto the order.
const rxCopy = (p) => ({
  id: Number(p.id), examinedOn: String(p.examined_on).slice(0, 10), examinerKind: p.examiner_kind, examinerName: p.examiner_name, registrationNo: p.registration_no,
  registrationCouncil: p.registration_council, pdBinocular: p.pd_binocular, pdRight: p.pd_right, pdLeft: p.pd_left, vertexDistance: p.vertex_distance,
  validUntil: String(p.valid_until).slice(0, 10), notes: p.notes, rows: p.rows,
});

// A quotation booked as this order: open, valid, of this location and of the
// prescription's customer. Its lines are the order's at its prices: the frame
// and each lens name the line they are (one unit each), and every other line
// goes on the order as an item. Fills the order's skus and items, and answers
// the figures as `price` does.
async function fromQuotation(db, business, order, { location, contact }) {
  if (order.remake || order.discount || order.items.length) fail('An order booked from a quotation takes its items, prices and discount: leave out other items, a discount and a remake');
  const q = await repo.one(db, 'SELECT * FROM business_quotations WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, order.quotationId]);
  if (!q) fail('Quotation not found', 404);
  access.requireLocation(business, q.location_id);
  await quotes().readyToClose(db, business, q, 'a spectacle order');
  // A quotation billed in part is booked whole or not at all.
  const billed = await repo.one(db, 'SELECT count(*)::int AS n FROM business_quotation_billed WHERE business_id=$1 AND quotation_id=$2', [business.id, q.id]);
  if (billed.n) fail(`Quotation ${q.quotation_no} is part billed: bill what is left, or cancel it and book the spectacle order on its own`, 409);
  if (Number(q.location_id) !== Number(location.id)) fail(`Quotation ${q.quotation_no} is from another location: book the order there`, 409);
  if (!q.contact_id) fail(`Quotation ${q.quotation_no} is for ${q.customer_name}, not a saved customer: save them and revise the quotation for them first`, 409);
  if (Number(q.contact_id) !== Number(contact.id)) fail(`Quotation ${q.quotation_no} is another customer's: book the order on its customer's prescription`, 409);
  const lines = await quotes().checkedLines(db, business, q,
    await repo.all(db, 'SELECT * FROM business_quotation_lines WHERE business_id=$1 AND quotation_id=$2 ORDER BY id', [business.id, q.id]));
  const used = new Set();
  const take = (lineId, what) => {
    const line = lines.find((l) => Number(l.id) === lineId);
    if (!line) fail(`That line is not on quotation ${q.quotation_no}`, 404);
    if (used.has(lineId)) fail(`A line of quotation ${q.quotation_no} goes on the order once`);
    if (milli(line.quantity) !== 1000) fail(`${line.label} is ${Number(line.quantity)} ${line.unit} on the quotation: ${what} is one unit, so it goes on the order as another item`);
    used.add(lineId);
    return line;
  };
  if (!order.frame.own) {
    if (!order.frame.quotationLineId) fail('Choose the quotation\'s line that is the frame, or the customer\'s own frame');
    order.frame.skuId = Number(take(order.frame.quotationLineId, 'the frame').sku_id);
  }
  for (const lens of order.lenses) {
    if (lens.skuId) fail(`${lens.name}: an order from a quotation bills its lenses on the quotation's lines`);
    if (lens.quotationLineId) lens.skuId = Number(take(lens.quotationLineId, 'a lens').sku_id);
  }
  const chosen = [...used];
  const rest = lines.filter((l) => !used.has(Number(l.id)));
  order.items = rest.map((l) => ({ skuId: Number(l.sku_id), quantity: l.quantity, ...(l.entered_unit ? { unit: l.entered_unit } : {}) }));
  const figures = (l) => ({ skuId: Number(l.sku_id), label: l.label, unit: l.unit, quantity: l.quantity, unitPrice: l.unit_price, amount: l.amount, discount: l.discount,
    taxRate: l.tax_rate, net: l.net, tax: l.tax, priceRuleId: l.price_rule_id, enteredUnit: l.entered_unit, enteredQuantity: l.entered_quantity,
    enteredUnitPrice: l.entered_unit_price, unitFactor: l.unit_factor, hsnCode: l.hsn_code, mrp: l.mrp, offers: l.offers || [] });
  const byId = (lineId) => lines.find((l) => Number(l.id) === lineId);
  const ordered = [order.frame.quotationLineId && !order.frame.own ? byId(order.frame.quotationLineId) : null,
    ...order.lenses.filter((l) => l.quotationLineId).map((l) => byId(l.quotationLineId)), ...rest].filter(Boolean);
  if (!ordered.length) fail(`Quotation ${q.quotation_no} has no lines`);
  return {
    quotation: q, chosen,
    quoted: { taxMode: q.tax_mode, lines: ordered.map(figures), subtotal: q.subtotal, tax: q.tax, roundOff: q.round_off, total: q.total, savings: q.savings },
    discount: q.discount_amount || q.discount_percent ? { amount: q.discount_amount, percent: q.discount_percent, reason: q.discount_reason } : null,
  };
}

// The figures for an order being typed (the booking dialog), nothing saved.
async function preview(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.create');
  const order = readOrder(body);
  access.requireLocation(business, order.locationId);
  if (order.quotationId) await access.require(business, 'quotations.view');
  return repo.transaction(async (db) => {
    const { contact } = await prescriptionOf(db, business, order.prescriptionId);
    if (order.quotationId) {
      const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, order.locationId]);
      if (!location) fail('Location not found', 404);
      const quoted = await fromQuotation(db, business, order, { location, contact });
      await applyLensItems(db, business, order.lenses);
      // The quotation's lines in the order's parts: frame, right lens, left lens, other items.
      const parts = pricedInputs(order);
      return { ...quoted.quoted, lines: quoted.quoted.lines.map((l, index) => ({ ...l, part: parts[index]?.part || 'item', eye: parts[index]?.eye || null })) };
    }
    await applyLensItems(db, business, order.lenses);
    const priced = pricedInputs(order);
    await checkItems(db, business, priced);
    const free = Boolean(order.remake && order.remake.costBy !== 'customer');
    return price(db, business, user, { locationId: order.locationId, contact, priced, discount: order.discount, free });
  });
}

// --- Booking --------------------------------------------------------------------------------------

// A delivered order to make again: the customer's own, and whether its lens
// (or its coating) is under warranty for the reason given. Under warranty,
// the shop's rule may make the remake free.
async function remakeOf(db, business, order, contact, today) {
  const original = await repo.one(db, 'SELECT id,order_no,status,contact_id FROM optical_orders WHERE business_id=$1 AND id=$2', [business.id, order.remake.orderId]);
  if (!original) fail('The order to remake was not found', 404);
  if (original.status !== 'delivered') fail(`Spectacle order ${original.order_no} is ${c.STATUS_WORDS[original.status]}: only a delivered order is made again`, 409);
  if (Number(original.contact_id) !== Number(contact.id)) fail(`Spectacle order ${original.order_no} is another customer's: a remake uses its own customer's prescription`, 409);
  const field = WARRANTY_FIELD[order.remake.reason];
  const until = field ? (await repo.one(db, `SELECT max(${field})::text AS day FROM optical_order_lines WHERE business_id=$1 AND order_id=$2 AND part='lens'`,
    [business.id, original.id]))?.day : null;
  const underWarranty = Boolean(until && until >= today);
  if (underWarranty && order.remake.costBy === 'customer' && (await settingsOf(db, business)).warranty_remakes === 'free') {
    fail(`The ${field === 'coating_warranty_until' ? 'coating' : 'lens'} warranty of ${original.order_no} runs to ${c.dateWords(until)}: by the shop's rule a remake under warranty costs the customer nothing. Choose the shop or the lab to bear it.`, 409);
  }
  return { ...original, underWarranty, warrantyUntil: underWarranty ? until : null };
}

// A collection receipt for an advance on an order (inside the caller's
// transaction): written before a new order (which names its first receipt),
// then kept with the order as one of its advances (linkAdvance).
async function newReceipt(db, business, user, { locationId, orderNo, contact, advance, key, hash }) {
  const receipt = await numbering.nextNumber(db, business.id, locationId, 'collection', user.id);
  const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, locationId, receipt.number, receipt.seriesId, contact.id, contact.name,
    advance.amount.toFixed(2), advance.method, advance.reference, `Advance on spectacle order ${orderNo}`, key, hash, user.id, advance.methodName]);
  await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, spectacleOrder: orderNo });
  await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
    collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method: collection.method });
  return collection;
}
const linkAdvance = (db, business, user, order, collection) => db.query('INSERT INTO optical_order_advances(business_id,order_id,collection_id,created_by) VALUES($1,$2,$3,$4)',
  [business.id, order.id, collection.id, user.id]);

// body: { requestKey, locationId, prescriptionId (a spectacle one), frame: { skuId } | { ownFrame: true, description } | { quotationLineId },
//   lenses: [{ eye, lensType?, skuId? | quotationLineId?, index?, material?, coatings?, tint?, brand?, description? }],
//   items?: [{ skuId, quantity, unit? }], measurements: { pdRight?, pdLeft?, fittingHeightRight?, fittingHeightLeft?, frameA?, frameB?, frameDbl? },
//   madeAt: in_house | lab, labName?, labOrderNo?, promisedOn, discount?: { amount | percent, reason }, notes?, referredBy?,
//   advance?: { amount, method | methodId, reference? }, remake?: { orderId, reason, costBy, note? }, quotationId?, holdFrame?, frameLot? }
async function book(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const order = readOrder(body);
  const fitting = readFitting(body.measurements);
  const made = readMadeAt(body);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  const referredBy = c.optionalText(body.referredBy, 'Referred by', 150);
  const holdFrame = v.requiredBoolean(body.holdFrame, 'Hold the frame', false);
  const advance = await readAdvance(business, body.advance);
  if (order.quotationId) await access.require(business, 'quotations.edit');
  access.requireLocation(business, order.locationId);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM optical_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, old.id));
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, order.locationId]);
    if (!location) fail('Location not found', 404);
    const { p, contact } = await prescriptionOf(db, business, order.prescriptionId);
    const rx = rxCopy(p);
    const today = await c.today(db, business);
    const fromQuote = order.quotationId ? await fromQuotation(db, business, order, { location, contact }) : null;
    const original = order.remake ? await remakeOf(db, business, order, contact, today) : null;
    await applyLensItems(db, business, order.lenses);
    checkLenses(rx, order.lenses, fitting);
    const free = Boolean(order.remake && order.remake.costBy !== 'customer');
    if (free && order.discount) fail('A remake the shop or the lab bears costs the customer nothing: it takes no discount');
    if (free && advance) fail('A remake the shop or the lab bears costs the customer nothing: it takes no advance');
    const priced = pricedInputs(order);
    if (!priced.length && !free) fail('Put the price on the order: a frame from stock, a lens item, or another item such as the lab\'s lens charge');
    if (holdFrame && !order.frame.skuId) fail('Only a frame from stock is held for an order');
    await checkItems(db, business, priced);
    const promisedOn = c.readDate(body.promisedOn, 'Promised for');
    if (promisedOn < today) fail('The promised day cannot be one that has passed');
    if (promisedOn > c.addDays(today, MAX_PROMISED_DAYS)) fail('Promise the spectacles within a year');
    const quoted = fromQuote ? fromQuote.quoted : await price(db, business, user, { locationId: location.id, contact, priced, discount: order.discount, free });
    if (advance && paise(advance.amount) > paise(quoted.total)) fail(`The advance is part of the order's total: at most ${quoted.total}`);
    const number = await numbering.nextNumber(db, business.id, location.id, 'spectacle_order', user.id);
    // The advance taken at booking: the order's first receipt.
    const collection = advance ? await newReceipt(db, business, user, { locationId: location.id, orderNo: number.number, contact, advance,
      key: derivedKey(requestKey, 'advance'), hash }) : null;
    const discount = fromQuote ? fromQuote.discount : order.discount;
    const saved = await repo.one(db, `INSERT INTO optical_orders(business_id,location_id,order_no,series_id,contact_id,customer_name,customer_phone,prescription_id,rx,
        pd_right,pd_left,fitting_height_right,fitting_height_left,made_at,lab_name,lab_order_no,promised_on,remake_of,remake_reason,remake_cost_by,remake_note,
        tax_mode,subtotal,tax,round_off,total,savings,discount_amount,discount_percent,discount_reason,notes,request_key,request_hash,created_by,updated_by,
        frame_a,frame_b,frame_dbl,referred_by,quotation_id,remake_under_warranty,advance_collection_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$34,$35,$36,$37,$38,$39,$40,$41) RETURNING *`,
    [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, contact.phone || null, p.id, JSON.stringify(rx),
      fitting.pdRight, fitting.pdLeft, fitting.heightRight, fitting.heightLeft, made.madeAt, made.labName, made.labOrderNo, promisedOn,
      original?.id || null, order.remake?.reason || null, order.remake?.costBy || null, order.remake?.note || null,
      quoted.taxMode, quoted.subtotal, quoted.tax, quoted.roundOff, quoted.total, quoted.savings,
      discount?.amount ?? null, discount?.percent ?? null, discount ? discount.reason : null, notes, requestKey, hash, user.id,
      fitting.frameA, fitting.frameB, fitting.frameDbl, referredBy || p.referred_by || null, fromQuote?.quotation.id || null, Boolean(original?.underWarranty),
      collection?.id || null]);
    await insertLines(db, business, saved.id, order, quoted);
    if (collection) await linkAdvance(db, business, user, saved, collection);
    if (fromQuote) {
      await db.query("UPDATE business_quotations SET status='booked',closed_by=$3,closed_at=now() WHERE business_id=$1 AND id=$2", [business.id, fromQuote.quotation.id, user.id]);
      await repo.audit(db, business.id, user.id, 'quotation.booked', fromQuote.quotation.id, { quotationNo: fromQuote.quotation.quotation_no, orderNo: saved.order_no, total: saved.total });
      await repo.event(db, business.id, user.id, 'quotation.booked', 'quotation', fromQuote.quotation.id, { quotationNo: fromQuote.quotation.quotation_no, orderId: saved.id,
        orderNo: saved.order_no, total: saved.total });
    }
    const held = holdFrame ? await work().holdInside(db, business, user, saved, { lotCode: body.frameLot }) : null;
    // The history names the receipt, not the amounts: someone who does not see sales reads it too.
    const said = [original ? `Remake of ${original.order_no}${original.underWarranty ? ' under warranty' : ''}` : 'Booked',
      fromQuote ? `from quotation ${fromQuote.quotation.quotation_no}` : null, collection ? `advance taken (${collection.collection_no})` : null,
      held ? 'frame held in stock' : null].filter(Boolean).join(' · ');
    await history(db, business, user, saved, null, 'booked', said);
    await repo.audit(db, business.id, user.id, 'spectacle_order.booked', saved.id, { orderNo: saved.order_no, customer: contact.name, total: saved.total, promisedOn,
      madeAt: made.madeAt, ...(made.labName ? { lab: made.labName } : {}), ...(saved.referred_by ? { referredBy: saved.referred_by } : {}),
      ...(fromQuote ? { quotationNo: fromQuote.quotation.quotation_no } : {}),
      ...(original ? { remakeOf: original.order_no, reason: order.remake.reason, costBy: order.remake.costBy, underWarranty: original.underWarranty } : {}) });
    await repo.event(db, business.id, user.id, 'spectacle_order.booked', 'spectacle_order', saved.id, {
      orderNo: saved.order_no, locationId: location.id, contactId: contact.id, prescriptionId: Number(p.id), total: saved.total, promisedOn, advanceCollectionId: collection?.id || null,
      remakeOf: original?.id || null, quotationId: fromQuote?.quotation.id || null, lines: quoted.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, unit: l.enteredUnit || l.unit })),
    });
    return shape(business, await load(db, business, saved.id));
  });
}

// The frame, the lenses and the other items, each item line with the core's figures.
async function insertLines(db, business, orderId, order, quoted) {
  let at = 0;
  const figuresFor = (skuId) => (skuId ? quoted.lines[at++] : null);
  const insert = async (row) => {
    const f = row.figures;
    await db.query(`INSERT INTO optical_order_lines(business_id,order_id,part,eye,sku_id,own_frame,description,lens_type,lens_index,material,coatings,tint,brand,
        label,unit,quantity,unit_price,amount,discount,tax_rate,net,tax,price_rule_id,entered_unit,entered_quantity,entered_unit_price,unit_factor,hsn_code,mrp,offers)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
    [business.id, orderId, row.part, row.eye || null, row.skuId || null, Boolean(row.own), row.description || null, row.lensType || null, row.index || null,
      row.material || null, row.coatings || [], row.tint || null, row.brand || null,
      f?.label ?? null, f?.unit ?? null, f?.quantity ?? null, f?.unitPrice ?? null, f?.amount ?? null, f?.discount ?? null, f?.taxRate ?? null, f?.net ?? null, f?.tax ?? null,
      f?.priceRuleId ?? null, f?.enteredUnit ?? null, f?.enteredQuantity ?? null, f?.enteredUnitPrice ?? null, f?.unitFactor ?? null, f?.hsnCode ?? null, f?.mrp ?? null,
      JSON.stringify((f?.offers || []).map((o) => ({ label: o.label, source: o.source, amount: o.amount })))]);
  };
  await insert({ part: 'frame', skuId: order.frame.skuId, own: order.frame.own, description: order.frame.description, figures: figuresFor(order.frame.skuId) });
  for (const lens of order.lenses) await insert({ part: 'lens', ...lens, figures: figuresFor(lens.skuId) });
  for (const item of order.items) await insert({ part: 'item', skuId: item.skuId, figures: figuresFor(item.skuId) });
}

// A line of the order's history: a change of status, or a note with none
// (a workshop step names its step).
async function history(db, business, user, order, from, to, note, step = null) {
  await db.query('INSERT INTO optical_order_events(business_id,order_id,from_status,to_status,note,created_by,step) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [business.id, order.id, from, to, note ? String(note).slice(0, 500) : null, user.id, step]);
}

// --- Reading an order -------------------------------------------------------------------------------

// What the bill comes to if delivered now: each item line's agreed value with
// GST at the item's rate today (a price that includes GST keeps its total;
// one before GST keeps its taxable value), and the round-off as the business
// rounds now. Lines need tax_rate_now (the item's rate today).
function billLines(order, lines) {
  return lines.filter((l) => l.sku_id).map((l) => {
    const net = paise(l.net), tax = paise(l.tax), rate = Number(l.tax_rate_now ?? l.tax_rate);
    if (rate === Number(l.tax_rate)) return { line: l, net, tax };
    if (order.tax_mode === 'inclusive') {
      const gross = net + tax;
      const newNet = core.inclusiveNet(gross, rate);
      return { line: l, net: newNet, tax: gross - newNet };
    }
    return { line: l, net, tax: core.lineTax(net, rate) };
  });
}
function billFigures(values, rounding) {
  const subtotal = values.reduce((s, x) => s + x.net, 0), tax = values.reduce((s, x) => s + x.tax, 0);
  const raw = subtotal + tax;
  const total = rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw;
  return { subtotal, tax, roundOff: total - raw, total };
}

// Usable stock at the order's location, less what other orders hold of it.
async function linesOf(db, business, order) {
  return repo.all(db, `SELECT x.*,s.code AS sku_code,s.tracking,s.active AS sku_active,s.internal_use,s.tax_rate AS tax_rate_now,s.mrp AS mrp_now,s.label AS sku_label,
      p.kind AS sku_kind,p.active AS product_active,
      CASE WHEN x.sku_id IS NULL OR p.kind<>'goods' THEN NULL ELSE COALESCE((SELECT sum(l.quantity) FROM business_stock_lots l WHERE l.business_id=x.business_id AND l.sku_id=x.sku_id
        AND l.location_id=$3 AND (l.expires_on IS NULL OR l.expires_on >= (now() AT TIME ZONE $4)::date)),0)
        - COALESCE((SELECT sum(h.quantity) FROM optical_frame_holds h JOIN business_stock_lots l ON l.business_id=h.business_id AND l.id=h.lot_id
          WHERE h.business_id=x.business_id AND h.status='held' AND h.order_id<>x.order_id AND l.sku_id=x.sku_id AND l.location_id=$3),0) END AS in_stock
    FROM optical_order_lines x LEFT JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
    LEFT JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE x.business_id=$1 AND x.order_id=$2 ORDER BY CASE x.part WHEN 'frame' THEN 0 WHEN 'lens' THEN 1 ELSE 2 END, CASE x.eye WHEN 'right' THEN 0 ELSE 1 END, x.id`,
  [business.id, order.id, order.location_id, business.timezone || 'Asia/Kolkata']);
}

// The order's advances, oldest first, each with what is left of it.
async function advancesOf(db, business, orderId, { lock = false } = {}) {
  return repo.all(db, `SELECT k.id,k.collection_no,k.amount,k.method,k.method_name,k.reference,k.created_at,${FREE_SQL('k')} AS free,
      COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0) AS used,
      COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),0) AS refunded,
      COALESCE((SELECT json_agg(json_build_object('id',f.id,'refund_no',f.refund_no,'collection_no',k.collection_no,'amount',f.amount,'method',f.method,'method_name',f.method_name,
        'reference',f.reference,'reason',f.reason,'created_at',f.created_at,'approved_by_name',ap.name) ORDER BY f.id) FROM business_collection_refunds f JOIN users ap ON ap.id=f.approved_by
        WHERE f.business_id=k.business_id AND f.collection_id=k.id),'[]') AS refunds
    FROM optical_order_advances a JOIN business_collections k ON k.business_id=a.business_id AND k.id=a.collection_id
    WHERE a.business_id=$1 AND a.order_id=$2 ORDER BY a.created_at,k.id${lock ? ' FOR UPDATE OF k' : ''}`, [business.id, orderId]);
}
// The order's advances together, as one figure (null with none).
function advanceSummary(advances) {
  if (!advances.length) return null;
  const sum = (key) => rupees(advances.reduce((s, a) => s + paise(a[key]), 0));
  return { amount: sum('amount'), free: sum('free'), used: sum('used'), refunded: sum('refunded'), collection_no: advances.map((a) => a.collection_no).join(', '),
    method: advances[0].method, method_name: advances[0].method_name, created_at: advances[0].created_at, refunds: advances.flatMap((a) => a.refunds) };
}

// The workshop's steps on this visit (since the order last went into the workshop).
async function visitSteps(db, business, orderId) {
  return repo.all(db, `SELECT e.step,e.note,e.created_at,u.name AS by_name FROM optical_order_events e JOIN users u ON u.id=e.created_by
    WHERE e.business_id=$1 AND e.order_id=$2 AND e.step IS NOT NULL AND e.id > COALESCE((SELECT max(x.id) FROM optical_order_events x WHERE x.business_id=$1 AND x.order_id=$2
      AND x.to_status='in_workshop' AND x.from_status IS DISTINCT FROM 'in_workshop'),0) ORDER BY e.id`, [business.id, orderId]);
}

async function load(db, business, orderId) {
  const o = await repo.one(db, `SELECT o.*,l.name AS location_name,to_jsonb(l) AS location,cu.name AS created_by_name,ch.name AS checked_by_name,
      dl.name AS delivered_by_name,cn.name AS cancelled_by_name,d.document_no,d.total AS bill_total,r.order_no AS remake_of_no,q.quotation_no,
      (o.status NOT IN ('ready','delivered','cancelled') AND o.promised_on < (now() AT TIME ZONE b.timezone)::date) AS overdue
    FROM optical_orders o JOIN businesses b ON b.id=o.business_id
    JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id
    JOIN users cu ON cu.id=o.created_by LEFT JOIN users ch ON ch.id=o.checked_by LEFT JOIN users dl ON dl.id=o.delivered_by LEFT JOIN users cn ON cn.id=o.cancelled_by
    LEFT JOIN business_documents d ON d.business_id=o.business_id AND d.id=o.document_id
    LEFT JOIN optical_orders r ON r.business_id=o.business_id AND r.id=o.remake_of
    LEFT JOIN business_quotations q ON q.business_id=o.business_id AND q.id=o.quotation_id
    WHERE o.business_id=$1 AND o.id=$2`, [business.id, orderId]);
  if (!o) fail('Spectacle order not found', 404);
  access.requireLocation(business, o.location_id);
  // One query at a time: `db` may be a transaction's own client.
  const lines = await linesOf(db, business, o);
  const events = await repo.all(db, `SELECT e.id,e.from_status,e.to_status,e.note,e.step,e.created_at,u.name AS by_name FROM optical_order_events e JOIN users u ON u.id=e.created_by
    WHERE e.business_id=$1 AND e.order_id=$2 ORDER BY e.id`, [business.id, o.id]);
  const advances = await advancesOf(db, business, o.id);
  const advance = advanceSummary(advances);
  const remakes = await repo.all(db, `SELECT id,order_no,status,remake_reason,remake_cost_by,remake_under_warranty,created_at FROM optical_orders WHERE business_id=$1 AND remake_of=$2 ORDER BY id`,
    [business.id, o.id]);
  const hold = await repo.one(db, `SELECT h.id,h.status,h.quantity,h.held_at,h.closed_at,h.close_reason,l.lot_code,u.name AS held_by_name FROM optical_frame_holds h
    JOIN business_stock_lots l ON l.business_id=h.business_id AND l.id=h.lot_id JOIN users u ON u.id=h.held_by
    WHERE h.business_id=$1 AND h.order_id=$2 ORDER BY (h.status='held') DESC,h.id DESC LIMIT 1`, [business.id, o.id]);
  const steps = o.status === 'in_workshop' ? await visitSteps(db, business, o.id) : [];
  const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const open = c.OPEN.includes(o.status);
  let bill = null;
  if (open && lines.some((l) => l.sku_id)) {
    const figures = billFigures(billLines(o, lines), settings?.rounding);
    const left = advances.reduce((s, a) => s + Math.max(0, paise(a.free)), 0);
    bill = { subtotal: rupees(figures.subtotal), tax: rupees(figures.tax), round_off: rupees(figures.roundOff), total: rupees(figures.total),
      advance: rupees(Math.min(left, figures.total)), due: rupees(Math.max(0, figures.total - left)),
      rate_changed: lines.some((l) => l.sku_id && Number(l.tax_rate_now) !== Number(l.tax_rate)) };
  }
  const statusSince = [...events].reverse().find((e) => e.to_status === o.status && e.from_status !== e.to_status)?.created_at || o.created_at;
  // In the workshop: this visit's steps, and the next one in order (none once fitted).
  const last = Math.max(-1, ...steps.map((s) => c.WORKSHOP_STEPS.indexOf(s.step)));
  const workshop = o.status === 'in_workshop' ? { steps, next: c.WORKSHOP_STEPS[last + 1] || null, fitted: steps.some((s) => s.step === 'fitting') } : null;
  const { request_hash: _hash, location, ...rest } = o;
  return { ...rest, lines, events, advance, advances, remakes, bill, hold: hold || null, workshop, seller: core.branchSeller(settings, location),
    next: open ? MOVES[o.status] : [], status_since: statusSince };
}

async function detail(business, orderId) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  return shape(business, await load(repo.pool, business, id(orderId, 'Spectacle order')));
}

async function lockOrder(db, business, orderId) {
  // Same lock order as every posting: the business, then the record.
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const order = await repo.one(db, 'SELECT * FROM optical_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Spectacle order')]);
  if (!order) fail('Spectacle order not found', 404);
  access.requireLocation(business, order.location_id);
  return order;
}
const requireOpen = (order) => { if (!c.OPEN.includes(order.status)) fail(`Spectacle order ${order.order_no} is ${c.STATUS_WORDS[order.status]} and no longer changes`, 409); };

// --- The work: lab, workshop, quality check ----------------------------------------------------

// body: { status: at_lab | in_workshop | quality_check | ready, note?, labName?, labOrderNo? }
// Passing the quality check (to ready) or failing it (back to the lab or the
// workshop, with what failed) needs optical.approve, and only that (an
// optometrist checks finished spectacles); every other step needs
// optical.edit. Spectacles sent back once ready say why. From the workshop,
// the quality check needs the fitting done on this visit.
async function setStatus(business, user, orderId, body) {
  c.requireOptical(business);
  await access.requireAny(business, ['optical.edit', 'optical.approve']);
  const status = v.requiredEnum(body.status, 'Status', ['at_lab', 'in_workshop', 'quality_check', 'ready']);
  const note = c.optionalText(body.note, 'Note', 500);
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    requireOpen(order);
    const checking = order.status === 'quality_check';
    await access.require(business, checking ? 'optical.approve' : 'optical.edit');
    if (!MOVES[order.status].includes(status)) {
      fail(`Spectacle order ${order.order_no} is ${c.STATUS_WORDS[order.status]}: it cannot go ${status === 'ready' ? 'to ready before the quality check' : `to ${c.STATUS_WORDS[status]}`}`, 409);
    }
    if (checking && status !== 'ready' && !note) fail('Say what failed the quality check');
    if (order.status === 'ready' && !note) fail('Say why the spectacles go back');
    if (order.status === 'in_workshop' && status === 'quality_check' && !(await visitSteps(db, business, order.id)).some((s) => s.step === 'fitting')) {
      fail(`Spectacle order ${order.order_no} is in the workshop: record its fitting before the quality check`, 409);
    }
    let { made_at: madeAt, lab_name: labName, lab_order_no: labOrderNo } = order;
    if (status === 'at_lab') {
      labName = c.optionalText(body.labName, 'The lab\'s name', 150) || labName;
      if (!labName) fail('Give the lab\'s name');
      labOrderNo = c.optionalText(body.labOrderNo, 'The lab\'s order number', 60) || labOrderNo;
      madeAt = 'lab';
    } else if (c.given(body.labName) || c.given(body.labOrderNo)) fail('A lab\'s name and order number go with sending the order to the lab');
    const passed = checking && status === 'ready';
    await db.query(`UPDATE optical_orders SET status=$3,made_at=$4,lab_name=$5,lab_order_no=$6,checked_by=CASE WHEN $7 THEN $8::bigint ELSE checked_by END,
      checked_at=CASE WHEN $7 THEN now() ELSE checked_at END,updated_by=$8,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, order.id, status, madeAt, labName, labOrderNo, passed, user.id]);
    const words = passed ? `Quality check passed${note ? `: ${note}` : ''}` : checking ? `Quality check failed: ${note}`
      : status === 'at_lab' ? [`Sent to ${labName}`, labOrderNo ? `lab order ${labOrderNo}` : null, note].filter(Boolean).join(' · ') : note;
    await history(db, business, user, order, order.status, status, words);
    await repo.audit(db, business.id, user.id, 'spectacle_order.status_changed', order.id, { orderNo: order.order_no, from: order.status, to: status,
      ...(checking ? { qualityCheck: passed ? 'passed' : 'failed' } : {}), ...(note ? { note } : {}) });
    await repo.event(db, business.id, user.id, 'spectacle_order.status_changed', 'spectacle_order', order.id, { orderNo: order.order_no, from: order.status, to: status,
      ...(checking ? { qualityCheck: passed ? 'passed' : 'failed' } : {}) });
    return shape(business, await load(db, business, order.id));
  });
}

// body: { promisedOn?, notes?, measurements?, madeAt?, labName?, labOrderNo?, referredBy? } — what is left out stays.
async function updateDetails(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.edit');
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    requireOpen(order);
    const today = await c.today(db, business);
    let promisedOn = String(order.promised_on).slice(0, 10);
    if (body.promisedOn !== undefined) {
      promisedOn = c.readDate(body.promisedOn, 'Promised for');
      if (promisedOn < today && promisedOn !== String(order.promised_on).slice(0, 10)) fail('The promised day cannot be one that has passed');
      if (promisedOn > c.addDays(today, MAX_PROMISED_DAYS)) fail('Promise the spectacles within a year');
    }
    const notes = body.notes === undefined ? order.notes : c.optionalText(body.notes, 'Notes', 500);
    const referredBy = body.referredBy === undefined ? order.referred_by : c.optionalText(body.referredBy, 'Referred by', 150);
    const was = { pdRight: order.pd_right, pdLeft: order.pd_left, heightRight: order.fitting_height_right, heightLeft: order.fitting_height_left,
      frameA: order.frame_a, frameB: order.frame_b, frameDbl: order.frame_dbl };
    const fitting = body.measurements === undefined ? was : readFitting(body.measurements);
    const made = body.madeAt === undefined ? { madeAt: order.made_at, labName: body.labName === undefined ? order.lab_name : c.optionalText(body.labName, 'The lab\'s name', 150),
      labOrderNo: body.labOrderNo === undefined ? order.lab_order_no : c.optionalText(body.labOrderNo, 'The lab\'s order number', 60) } : readMadeAt(body);
    if (made.madeAt === 'lab' && !made.labName) fail('Give the lab\'s name');
    if (made.madeAt !== 'lab' && (made.labName || made.labOrderNo)) fail('A lab\'s name and order number go with spectacles made at a lab');
    const lenses = (await repo.all(db, "SELECT eye,lens_type FROM optical_order_lines WHERE business_id=$1 AND order_id=$2 AND part='lens'", [business.id, order.id]))
      .map((l) => ({ eye: l.eye, lensType: l.lens_type }));
    checkLenses({ rows: order.rx.rows }, lenses, fitting);
    await db.query(`UPDATE optical_orders SET promised_on=$3,notes=$4,pd_right=$5,pd_left=$6,fitting_height_right=$7,fitting_height_left=$8,made_at=$9,lab_name=$10,lab_order_no=$11,
      updated_by=$12,updated_at=now(),frame_a=$13,frame_b=$14,frame_dbl=$15,referred_by=$16 WHERE business_id=$1 AND id=$2`, [business.id, order.id, promisedOn, notes,
      fitting.pdRight, fitting.pdLeft, fitting.heightRight, fitting.heightLeft, made.madeAt, made.labName, made.labOrderNo, user.id, fitting.frameA, fitting.frameB, fitting.frameDbl,
      referredBy]);
    const text = (x) => (x === null || x === undefined ? null : String(x));
    const before = { promisedOn: String(order.promised_on).slice(0, 10), notes: order.notes, pdRight: text(order.pd_right), pdLeft: text(order.pd_left),
      heightRight: text(order.fitting_height_right), heightLeft: text(order.fitting_height_left), frameA: text(order.frame_a), frameB: text(order.frame_b), frameDbl: text(order.frame_dbl),
      madeAt: order.made_at, lab: order.lab_name, labOrderNo: order.lab_order_no, referredBy: order.referred_by };
    const after = { promisedOn, notes, pdRight: text(fitting.pdRight), pdLeft: text(fitting.pdLeft), heightRight: text(fitting.heightRight), heightLeft: text(fitting.heightLeft),
      frameA: text(fitting.frameA), frameB: text(fitting.frameB), frameDbl: text(fitting.frameDbl), madeAt: made.madeAt, lab: made.labName, labOrderNo: made.labOrderNo, referredBy };
    const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'spectacle_order.updated', order.id, { orderNo: order.order_no,
        from: Object.fromEntries(changed.map((key) => [key, before[key]])), to: Object.fromEntries(changed.map((key) => [key, after[key]])) });
      const words = { promisedOn: 'promised day', notes: 'notes', pdRight: 'fitting', pdLeft: 'fitting', heightRight: 'fitting', heightLeft: 'fitting', frameA: 'frame size',
        frameB: 'frame size', frameDbl: 'frame size', madeAt: 'where it is made', lab: 'lab', labOrderNo: 'lab order number', referredBy: 'referring doctor' };
      const said = [...new Set(changed.map((key) => words[key]))];
      await history(db, business, user, order, order.status, order.status, `Changed: ${c.listWords(said)}${changed.includes('promisedOn') ? ` (now ${c.dateWords(promisedOn)})` : ''}`);
    }
    return shape(business, await load(db, business, order.id));
  });
}

// A message or call to the customer, kept in the order's history. The
// message itself goes from the person's own WhatsApp (a wa.me link).
async function logMessage(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  const channel = v.requiredEnum(body.channel ?? 'whatsapp', 'How', ['whatsapp', 'call', 'sms']);
  const stage = v.requiredEnum(body.stage ?? 'update', 'Message', ['booked', 'ready', 'delayed', 'reminder', 'update']);
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    const how = { whatsapp: 'WhatsApp sent', call: 'Called the customer', sms: 'SMS sent' };
    const what = { booked: 'order booked', ready: 'ready to collect', delayed: 'running late', reminder: 'collection reminder', update: 'update' };
    const note = `${how[channel]}: ${what[stage]}${body.note ? ` · ${c.optionalText(body.note, 'Note', 300)}` : ''}`;
    await history(db, business, user, order, order.status, order.status, note);
    await repo.audit(db, business.id, user.id, 'spectacle_order.customer_told', order.id, { orderNo: order.order_no, channel, stage });
    return { logged: true, note };
  });
}

// --- Delivery -----------------------------------------------------------------------------------------

// Each item line as it is now in the catalogue: still sold, in the same pack,
// and not above its MRP at the value the bill charges for it today.
function checkDeliverable(order, values) {
  for (const { line, net, tax } of values) {
    if (!line.sku_active || !line.product_active) fail(`${line.label} is switched off in the catalogue: switch it on again to deliver this order`, 409);
    if (line.internal_use) fail(`${line.label} is kept for use in services only: untick that on the item to deliver this order`, 409);
    if (line.mrp_now !== null && line.mrp_now !== undefined) {
      const each = roundedDivide(BigInt(net + tax) * 1000n, BigInt(milli(line.quantity)));
      if (each > paise(line.mrp_now)) {
        fail(`${line.label} was booked at ${rupees(each)} a ${line.unit} with GST, above its MRP of ${Number(line.mrp_now).toFixed(2)} now. Correct the MRP, or cancel the order and book it again.`, 409);
      }
    }
  }
}

// Each lens's warranty from the day of delivery, by the shop's months (its
// coatings' too, when it has any). Written while the order is still ready.
async function dateWarranties(db, business, order, today) {
  const s = await settingsOf(db, business);
  if (!s.lens_warranty_months && !s.coating_warranty_months) return;
  const lens = s.lens_warranty_months ? c.addMonths(today, s.lens_warranty_months) : null;
  const coating = s.coating_warranty_months ? c.addMonths(today, s.coating_warranty_months) : null;
  await db.query(`UPDATE optical_order_lines SET warranty_until=$3,coating_warranty_until=CASE WHEN coatings <> '{}' THEN $4::date END
    WHERE business_id=$1 AND order_id=$2 AND part='lens'`, [business.id, order.id, lens, coating]);
}

// body: { requestKey, payment? | payments? ({ amount | "full", method | methodId, reference?, tendered? }),
//   lines?: [{ lineId, lots: [{ lotCode, quantity }] }], buyer?: { pan?, panDeclaration? }, note? }
async function deliver(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.edit');
  const deliveryKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, orderId: String(orderId) });
  const parts = core.readPayments(body);
  const choices = quotes().readStockChoices(body);
  const note = c.optionalText(body.note, 'Note', 500);
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    // A retry gives the same delivery; the same key with other data is refused.
    const done = await repo.one(db, 'SELECT id,request_hash FROM business_documents WHERE business_id=$1 AND request_key=$2', [business.id, deliveryKey]);
    if (done) {
      if (done.request_hash !== hash || String(done.id) !== String(order.document_id)) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, order.id));
    }
    if (order.status === 'delivered' && order.delivery_key === deliveryKey) return shape(business, await load(db, business, order.id));
    requireOpen(order);
    if (order.status !== 'ready') fail(`Spectacle order ${order.order_no} is ${c.STATUS_WORDS[order.status]}: it is delivered once it has passed the quality check`, 409);
    const lines = await linesOf(db, business, order);
    for (const lineId of choices.keys()) if (!lines.some((l) => Number(l.id) === lineId && l.sku_id)) fail('That line is not an item on this order', 404);
    const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
    // A frame held for the order comes out of its hold now.
    const hold = await work().closeHold(db, business, user, order, 'delivered', 'Delivered');
    let document = null;
    const uses = [];
    const items = lines.filter((l) => l.sku_id);
    if (items.length) {
      await access.require(business, 'sales.create');
      if (parts.length) await access.require(business, 'sales.edit');
      const values = billLines(order, items);
      checkDeliverable(order, values);
      for (const { line } of values) {
        if (line.entered_unit) {
          const unit = await core.readUnit(db, business.id, line.entered_unit);
          const factor = await core.conversion(db, business.id, { id: line.sku_id, unit: line.unit, label: line.label }, unit);
          if (factor !== Math.round(Number(line.unit_factor) * 1e6)) fail(`The ${unit.name.toLowerCase()} of ${line.label} holds a different quantity now: cancel the order and book it again`, 409);
        }
      }
      // Each line as the bill takes it: from the stock it comes out of (a held frame from its own lot), at its share of today's value.
      const mode = settings?.tax_mode || 'exclusive';
      const pieces = [];
      for (const { line, net, tax } of values) {
        const stockLine = { ...line, sku: { kind: line.sku_kind, tracking: line.tracking } };
        const heldHere = hold && line.part === 'frame' && Number(hold.sku_id) === Number(line.sku_id) ? { lots: [{ lotCode: hold.lot_code, quantityMilli: milli(line.quantity) }] } : undefined;
        const picks = await quotes().stockPieces(db, business, order, stockLine, choices.get(Number(line.id)) || heldHere);
        const value = { ...line, net: rupees(net), tax: rupees(tax) };
        // Priced in the other terms now (GST included or not): the rate per unit follows from the value.
        if (order.tax_mode !== mode) {
          const each = (net + (mode === 'inclusive' ? tax : 0)) / 100;
          value.unit_price = (each / Number(line.quantity)).toFixed(4);
          if (line.entered_unit) value.entered_unit_price = (each / Number(line.entered_quantity)).toFixed(2);
        }
        pieces.push(...quotes().pricePieces({ tax_mode: mode }, value, picks));
      }
      const figures = billFigures(values, settings?.rounding);
      // The advances pay first, oldest first, up to the bill.
      let left = figures.total;
      for (const a of await advancesOf(db, business, order.id, { lock: true })) {
        const take = Math.min(Math.max(0, paise(a.free)), left);
        if (take > 0) { uses.push({ advance: a, take }); left -= take; }
      }
      const advanceUse = figures.total - left;
      // What is paid now, after the advances; "full" is what is left.
      const due = left;
      const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((sum, p) => sum + paise(p.amount), 0);
      if (fixedPaid > due) fail(`Only ${rupees(due)} is left to pay after the advance`);
      const paidNow = parts.map((p) => (p.amount === 'full' ? { ...p, amount: Number(rupees(due - fixedPaid)) } : p)).filter((p) => paise(p.amount) > 0);
      const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
      const documentBody = {
        kind: 'sale', locationId: order.location_id, contactId: order.contact_id, lines: pieces.map((p) => p.input),
        notes: [`Spectacle order ${order.order_no}`, order.remake_of ? 'remake' : null, note].filter(Boolean).join(' · ').slice(0, 500),
        buyer: { pan: buyer.pan, panDeclaration: buyer.panDeclaration },
      };
      document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: deliveryKey, hash, lines: documentBody.lines,
        paidNow, fixed: pieces.map((p) => p.fixed) });
      if (paise(document.total) !== figures.total) fail(`The bill would come to ${document.total}, not the ${rupees(figures.total)} worked out for the order. Try again.`, 409);
      for (const [index, use] of uses.entries()) {
        await core.recordPayment(db, business, user, document, { amount: rupees(use.take), method: use.advance.method, reference: use.advance.collection_no,
          key: derivedKey(deliveryKey, index === 0 ? 'advance' : `advance-${index}`), collectionId: use.advance.id });
      }
      if (advanceUse !== uses.reduce((s, u) => s + u.take, 0)) fail('The advances did not add up: try again', 409);
    } else if (parts.length) {
      fail('Nothing on this order is billed, so there is nothing to pay');
    }
    await dateWarranties(db, business, order, await c.today(db, business));
    await db.query(`UPDATE optical_orders SET status='delivered',document_id=$3,delivery_key=$4,delivered_by=$5,delivered_at=now(),updated_by=$5,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, order.id, document?.id || null, deliveryKey, user.id]);
    const advanceUsed = rupees(uses.reduce((s, u) => s + u.take, 0));
    await history(db, business, user, order, order.status, 'delivered', [document ? `Bill ${document.document_no}` : 'Nothing to bill',
      uses.length ? `the advance${uses.length > 1 ? 's' : ''} taken off` : null, note].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'spectacle_order.delivered', order.id, { orderNo: order.order_no, documentNo: document?.document_no || null,
      total: document?.total || '0.00', advanceUsed });
    await repo.event(db, business.id, user.id, 'spectacle_order.delivered', 'spectacle_order', order.id, { orderNo: order.order_no, documentId: document?.id || null,
      documentNo: document?.document_no || null, total: document?.total || '0.00', advanceUsed });
    return shape(business, await load(db, business, order.id));
  });
}

// --- Cancelling, and the advance handed back ---------------------------------------------------------

async function cancel(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.cancel');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    // Asking again is the same cancellation.
    if (order.status === 'cancelled') return shape(business, await load(db, business, order.id));
    requireOpen(order);
    // A frame held for it goes back to stock.
    await work().closeHold(db, business, user, order, 'released', 'Order cancelled');
    await db.query(`UPDATE optical_orders SET status='cancelled',cancel_reason=$3,cancelled_by=$4,cancelled_at=now(),updated_by=$4,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, order.id, reason, user.id]);
    await history(db, business, user, order, order.status, 'cancelled', reason);
    await repo.audit(db, business.id, user.id, 'spectacle_order.cancelled', order.id, { orderNo: order.order_no, reason });
    await repo.event(db, business.id, user.id, 'spectacle_order.cancelled', 'spectacle_order', order.id, { orderNo: order.order_no, reason,
      advanceCollectionId: order.advance_collection_id || null });
    return shape(business, await load(db, business, order.id));
  });
}

// An advance of a cancelled order (or what is left of it) handed back by
// cash, UPI or bank, with a reason and a manager's PIN (sales.refund); a
// numbered refund with a receipt. The advance named (collectionId), or the
// oldest with money left.
// body: { collectionId?, amount? (all that is left of it), method | methodId, reference?, reason, approverId?, pin?, requestKey }
async function refundAdvance(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  await access.require(business, 'sales.edit');
  const input = refunds().readRefund(body);
  const approval = await pins().readApproval(business, user, body, 'sales.refund', { reasonLabel: 'Reason for the refund' });
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    const advances = await advancesOf(db, business, order.id);
    if (!advances.length) fail(`Spectacle order ${order.order_no} has no advance`, 409);
    if (c.OPEN.includes(order.status)) fail(`Spectacle order ${order.order_no} is still open: the advance comes off the bill at delivery. Cancel the order first to refund it.`, 409);
    // A retry names its refund by the request key, whichever advance it came from.
    const earlier = await repo.one(db, 'SELECT collection_id FROM business_collection_refunds WHERE business_id=$1 AND request_key=$2', [business.id, input.requestKey]);
    const named = c.given(body.collectionId) ? id(body.collectionId, 'Advance') : earlier ? Number(earlier.collection_id) : null;
    const chosen = named ? advances.find((a) => Number(a.id) === named) : advances.find((a) => paise(a.free) > 0) || advances[0];
    if (!chosen) fail(`That receipt is not an advance on spectacle order ${order.order_no}`, 404);
    const { refund, repeated } = await refunds().refundCollection(db, business, user, { collectionId: chosen.id, contactId: order.contact_id, input, approval,
      source: 'optical', label: order.order_no });
    if (!repeated) await history(db, business, user, order, order.status, order.status, `Advance refunded (${refund.refund_no}) — ${approval.reason}`);
    return { ...refund, order_no: order.order_no, repeated };
  });
}

// --- The day's picture and the bell --------------------------------------------------------------

// Open orders by status, due today, overdue and ready, for the screen's chips.
async function counts(business) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  return repo.one(repo.pool, `SELECT count(*) FILTER (WHERE o.status NOT IN ('delivered','cancelled'))::int AS open,
      count(*) FILTER (WHERE o.status='booked')::int AS booked, count(*) FILTER (WHERE o.status='at_lab')::int AS at_lab,
      count(*) FILTER (WHERE o.status='in_workshop')::int AS in_workshop, count(*) FILTER (WHERE o.status='quality_check')::int AS quality_check,
      count(*) FILTER (WHERE o.status='ready')::int AS ready,
      count(*) FILTER (WHERE o.status NOT IN ('ready','delivered','cancelled') AND o.promised_on = (now() AT TIME ZONE b.timezone)::date)::int AS due_today,
      count(*) FILTER (WHERE o.status NOT IN ('ready','delivered','cancelled') AND o.promised_on < (now() AT TIME ZONE b.timezone)::date)::int AS overdue
    FROM optical_orders o JOIN businesses b ON b.id=o.business_id WHERE o.business_id=$1
      AND ($2::bigint IS NULL OR o.location_id=$2)`, [business.id, business.location_scope || null]);
}

// The bell: spectacles ready to collect, and orders past their promised day.
async function bell(business, base, limit) {
  const rows = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1)
    SELECT o.id,o.order_no,o.status,o.customer_name,o.promised_on::text AS promised_on,o.checked_at,o.updated_at,(today.d - o.promised_on) AS late
    FROM optical_orders o CROSS JOIN today
    WHERE o.business_id=$1 AND (o.status='ready' OR (o.status NOT IN ('ready','delivered','cancelled') AND o.promised_on < today.d))
      AND ($3::bigint IS NULL OR o.location_id=$3)
    ORDER BY (o.status='ready') DESC,o.promised_on LIMIT $2`, [business.id, limit, business.location_scope || null]);
  return rows.map((o) => {
    const ready = o.status === 'ready';
    const late = Number(o.late);
    return { id: `spectacles:${o.id}:${ready ? 'ready' : 'late'}`, severity: ready ? 'info' : 'warning', category: 'Spectacle orders',
      title: ready ? `${o.order_no} is ready to collect` : `${o.order_no} is past its promised day`,
      detail: ready ? o.customer_name : `${o.customer_name} · promised ${late === 1 ? 'yesterday' : `${late} days ago`}`,
      at: new Date(o.checked_at || o.updated_at || Date.now()).toISOString(), link: `${base}/spectacle-orders/${o.id}` };
  });
}

module.exports = { preview, book, detail, setStatus, updateDetails, logMessage, deliver, cancel, refundAdvance, counts, bell, listShape, MOVES,
  // For the changes of a booked order, the frame's hold, more advances and the workshop's steps (opticalOrderWork.service.js).
  load, lockOrder, requireOpen, shape, history, readFrame, readLenses, readItems, readFitting, readDiscount: (body) => quotes().readDiscount(body), pricedInputs, checkItems,
  applyLensItems, checkLenses, price, insertLines, advancesOf, newReceipt, linkAdvance, readAdvance, visitSteps, hashOf, paise, rupees };
