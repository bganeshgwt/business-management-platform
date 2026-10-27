const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./jewelleryCommon');
const money = require('./jewelleryMoney');
const rates = require('./jewelleryRates.service');
const pieces = require('./jewelleryPieces.service');

// Custom orders (module "jewellery"): a customer orders a piece to be made
// (CO/2627/0001): what it is, the design (a catalogue reference or design code,
// and a photo), the metal and purity, the weight range, the size, the stones
// and the day promised. Its path: booked → issued to a karigar → received →
// at the hallmarking centre → hallmarked → ready → delivered (or cancelled);
// the karigar's issue challan, their receipt and the hallmarking consignment
// move it along, and a piece already in the shop can be made its own.
// Advances are the customer's money taken as core collection receipts, or
// their old gold (an old gold voucher with all its value), held for the
// order's own bill while it is open (no other bill takes them, and they are
// not handed back). The rate can be fixed on an advance (bhav cut): the day's
// latest selling rate for the purity, for the grams the advance buys; the
// order keeps it. The order is delivered on a jewellery bill: its pieces at
// the fixed rate for the grams fixed and the day's rate for the rest, its
// advances paying first. Cancelled, its advances are the customer's again.
// Money is for those who see sales. Money is integer paise in this file.

const { fail, id } = c;
const STATUS_WORDS = { booked: 'Booked', issued: 'With the karigar', received: 'Received', at_centre: 'At the hallmarking centre', hallmarked: 'Hallmarked', ready: 'Ready',
  delivered: 'Delivered', cancelled: 'Cancelled' };
const OPEN = ['booked', 'issued', 'received', 'at_centre', 'hallmarked', 'ready'];
const ADVANCE_KINDS = ['cash', 'upi', 'card', 'bank'];

const ORDERS_SQL = `SELECT o.id,o.order_no,o.location_id,l.name AS location_name,o.contact_id,ct.name AS customer_name,ct.phone AS customer_phone,o.sku_id,s.label AS item_label,
    o.description,o.design_ref,o.metal,o.purity,o.weight_from,o.weight_to,o.size,o.stones,o.promised_on::text AS promised_on,o.status,o.fixed_sheet_id,o.fixed_rate,
    o.fixed_weight,o.fixed_at,o.document_id,d.document_no,o.delivered_at,o.cancel_reason,o.cancelled_at,cu.name AS cancelled_by_name,o.notes,o.created_at,u.name AS by_name,
    (o.status NOT IN ('delivered','cancelled')) AS open,
    (o.status NOT IN ('delivered','cancelled') AND o.promised_on IS NOT NULL AND o.promised_on<(now() AT TIME ZONE b.timezone)::date) AS late,
    COALESCE((SELECT sum(a.amount) FROM jewellery_order_advances a WHERE a.business_id=o.business_id AND a.order_id=o.id),0) AS advances,
    (SELECT count(*)::int FROM jewellery_order_pieces op WHERE op.business_id=o.business_id AND op.order_id=o.id) AS pieces,
    (SELECT f.id FROM jewellery_files f WHERE f.business_id=o.business_id AND f.order_id=o.id AND f.removed_at IS NULL ORDER BY f.id DESC LIMIT 1) AS design_photo_id
  FROM jewellery_orders o JOIN businesses b ON b.id=o.business_id JOIN business_contacts ct ON ct.business_id=o.business_id AND ct.id=o.contact_id
  JOIN business_locations l ON l.business_id=o.business_id AND l.id=o.location_id JOIN users u ON u.id=o.created_by LEFT JOIN users cu ON cu.id=o.cancelled_by
  LEFT JOIN catalog_skus s ON s.business_id=o.business_id AND s.id=o.sku_id LEFT JOIN business_documents d ON d.business_id=o.business_id AND d.id=o.document_id
  WHERE o.business_id=$1`;

repo.addLists({
  // Orders newest first; open ones (not delivered or cancelled), and those past the day promised.
  'jewellery-orders': { sql: ORDERS_SQL, search: ['order_no', 'customer_name', 'customer_phone', 'description', 'design_ref'], date: 'created_at',
    filters: { status: 'status', open: 'open', late: 'late', contact: 'contact_id', location: 'location_id' }, order: 'id DESC' },
});
const shapeRow = (business, row) => (c.seesMoney(business) ? row : { ...row, advances: null, fixed_rate: null });
const listShape = (business, page) => (c.seesMoney(business) ? page : { ...page, items: page.items.map((row) => shapeRow(business, row)) });

// --- Reading an order --------------------------------------------------------------------------------

async function view(db, business, orderId) {
  const row = await repo.one(db, `SELECT * FROM (${ORDERS_SQL}) x WHERE x.id=$2`, [business.id, orderId]);
  if (!row) fail('Custom order not found', 404);
  const [advances, made, issues, receipts] = await c.inTurn(
    () => repo.all(db, `SELECT a.id,a.amount,a.fixes_rate,a.created_at,u.name AS by_name,a.collection_id,k.collection_no,k.method,k.method_name,k.reference,
        a.old_gold_id,g.voucher_no FROM jewellery_order_advances a JOIN users u ON u.id=a.created_by
      LEFT JOIN business_collections k ON k.business_id=a.business_id AND k.id=a.collection_id LEFT JOIN jewellery_old_gold g ON g.business_id=a.business_id AND g.id=a.old_gold_id
      WHERE a.business_id=$1 AND a.order_id=$2 ORDER BY a.id`, [business.id, row.id]),
    () => repo.all(db, `SELECT * FROM (${pieces.PIECES_SQL}) x WHERE x.order_id=$2 ORDER BY x.id`, [business.id, row.id]),
    () => repo.all(db, `SELECT i.id,i.issue_no,i.created_at,ct.name AS karigar_name FROM jewellery_karigar_issues i JOIN business_contacts ct ON ct.business_id=i.business_id AND ct.id=i.contact_id
      WHERE i.business_id=$1 AND i.order_id=$2 ORDER BY i.id`, [business.id, row.id]),
    () => repo.all(db, `SELECT DISTINCT r.id,r.receipt_no,r.created_at FROM jewellery_karigar_receipt_lines l JOIN jewellery_karigar_receipts r ON r.business_id=l.business_id AND r.id=l.receipt_id
      WHERE l.business_id=$1 AND l.order_id=$2 ORDER BY r.id`, [business.id, row.id]),
  );
  const order = { ...row, status_words: STATUS_WORDS[row.status], mark: c.purityMark(row.metal, row.purity), purity_words: c.purityWords(row.metal, row.purity),
    advance_list: advances.map((a) => ({ ...a, kind: a.collection_id ? 'money' : 'old_gold' })), made: made.map((p) => pieces.withoutMoney(p)), issues, receipts };
  return c.seesMoney(business) ? order : { ...shapeRow(business, order), advance_list: [] };
}

async function detail(business, orderId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const order = await view(repo.pool, business, id(orderId, 'Custom order'));
  access.requireLocation(business, order.location_id);
  return order;
}

async function lockOrder(db, business, orderId) {
  const row = await repo.one(db, 'SELECT * FROM jewellery_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Custom order')]);
  if (!row) fail('Custom order not found', 404);
  access.requireLocation(business, row.location_id);
  return row;
}

// --- Booking -----------------------------------------------------------------------------------------

function readOrder(body) {
  const { metal, purity } = c.readPurity(body.metal, body.purity);
  const weightFrom = c.given(body.weightFrom) ? c.readWeight(body.weightFrom, 'Weight from (g)') : null;
  const weightTo = c.given(body.weightTo) ? c.readWeight(body.weightTo, 'Weight up to (g)') : null;
  if (weightFrom !== null && weightTo !== null && c.mg(weightTo) < c.mg(weightFrom)) fail('The weight it comes up to is not below the weight it starts from');
  return { metal, purity, weightFrom, weightTo, skuId: c.given(body.skuId) ? id(body.skuId, 'Item') : null,
    description: pieces.plainWords(v.requiredString(body.description, 'What to make', 300), 'What to make'),
    designRef: pieces.plainWords(c.optionalText(body.designRef, 'Design', 80), 'Design'), size: c.optionalText(body.size, 'Size', 40),
    stones: pieces.plainWords(c.optionalText(body.stones, 'Stones', 300), 'Stones'), promisedOn: c.given(body.promisedOn) ? c.readDate(body.promisedOn, 'Promised for') : null,
    notes: c.optionalText(body.notes, 'Notes', 500) };
}

// A money advance: { amount, method | methodId, reference?, fixRate? }.
function readMoneyAdvance(value, name = 'Advance') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return { kind: 'money', amount: c.paise(c.decimal(value.amount, `${name}: amount`, 2, 1, 100000000)), choice: paymentMethods.readChoice(value, `${name}: paid by`, ADVANCE_KINDS),
    reference: c.optionalText(value.reference, `${name}: reference`, 100), fixRate: v.requiredBoolean(value.fixRate, 'Fix the rate on this advance', false) };
}

// body: { requestKey, locationId, contactId | customer: { name, phone? } (with contacts.create), skuId?, description, designRef?, metal, purity, weightFrom?,
//   weightTo?, size?, stones?, promisedOn?, notes?, advance?: { amount, method | methodId, reference?, fixRate? } (with sales.edit) }
async function book(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const input = readOrder(body);
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : null;
  const typed = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer) && c.given(body.customer.name)
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone, consents: body.customer.consents } : null;
  if (contactId && typed) fail('Choose the customer or type a new one, not both');
  if (!contactId && !typed) fail('An order is for a customer: choose them, or add them');
  if (typed) await access.require(business, 'contacts.create');
  const advance = body.advance === undefined || body.advance === null ? null : readMoneyAdvance(body.advance);
  if (advance) await access.require(business, 'sales.edit');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await c.locationRow(db, business, body.locationId);
    if (input.skuId) {
      const item = await repo.one(db, 'SELECT metal,purity FROM jewellery_items WHERE business_id=$1 AND sku_id=$2', [business.id, input.skuId]);
      if (!item) fail('That item is not a jewellery item', 404);
    }
    const day = await c.today(db, business);
    if (input.promisedOn && input.promisedOn < day) fail('The day promised is today or later');
    const contact = contactId ? await c.contactRow(db, business, contactId, 'customer', 'Customer') : await core.createContact(business, user, typed, db);
    const number = await numbering.nextNumber(db, business.id, location.id, 'custom_order', user.id);
    const row = await repo.one(db, `INSERT INTO jewellery_orders(business_id,location_id,order_no,series_id,contact_id,sku_id,description,design_ref,metal,purity,weight_from,weight_to,
        size,stones,promised_on,notes,request_key,request_hash,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) RETURNING id`,
    [business.id, location.id, number.number, number.seriesId, contact.id, input.skuId, input.description, input.designRef, input.metal, input.purity,
      input.weightFrom === null ? null : input.weightFrom.toFixed(3), input.weightTo === null ? null : input.weightTo.toFixed(3), input.size, input.stones, input.promisedOn,
      input.notes, requestKey, hash, user.id]);
    const figures = { orderNo: number.number, customer: contact.name, description: input.description, purity: c.purityWords(input.metal, input.purity),
      weight: [input.weightFrom, input.weightTo].filter((w) => w !== null).map((w) => w.toFixed(3)).join('-') || null, promisedOn: input.promisedOn };
    await repo.audit(db, business.id, user.id, 'jewellery_order.booked', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_order.booked', 'jewellery_order', row.id, { ...figures, contactId: contact.id, locationId: location.id });
    if (advance) await takeMoney(db, business, user, { ...row, id: row.id, order_no: number.number, contact_id: contact.id, location_id: location.id, metal: input.metal,
      purity: input.purity, fixed_at: null, status: 'booked' }, contact, advance, { locationId: location.id, requestKey, hash });
    return view(db, business, row.id);
  });
}

// body: { promisedOn?, notes? }
async function update(business, user, orderId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    if (!OPEN.includes(order.status)) fail(`Order ${order.order_no} is ${order.status} and keeps what it was`, 409);
    const promisedOn = body.promisedOn === undefined ? order.promised_on : c.given(body.promisedOn) ? c.readDate(body.promisedOn, 'Promised for') : null;
    // A new day promised is today or later (one already past may stay as it is).
    if (promisedOn && promisedOn !== order.promised_on && promisedOn < (await c.today(db, business))) fail('The day promised is today or later');
    const notes = body.notes === undefined ? order.notes : c.optionalText(body.notes, 'Notes', 500);
    const before = { promisedOn: order.promised_on || null, notes: order.notes };
    await db.query('UPDATE jewellery_orders SET promised_on=$3,notes=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, order.id, promisedOn, notes, user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_order.updated', order.id, { orderNo: order.order_no, from: before, to: { promisedOn, notes } });
    return view(db, business, order.id);
  });
}

// --- Advances ----------------------------------------------------------------------------------------

// The rate fixed on an advance: the latest selling rate of the day for the order's purity, for the grams the advance buys.
async function fixRateOn(db, business, user, order, amountPaise) {
  const now = await rates.ratesNow(db, business);
  const rate = now.byPurity.get(`${order.metal}:${order.purity}`);
  if (!rate) fail(`${c.purityWords(order.metal, order.purity)} has no rate today: set today's rates before fixing the rate`, 409);
  const fixedMg = money.fixedGrams(amountPaise, c.paise(rate.sell_rate));
  await db.query('UPDATE jewellery_orders SET fixed_sheet_id=$3,fixed_rate=$4,fixed_weight=$5,fixed_at=now(),updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2',
    [business.id, order.id, rate.sheet_id, rate.sell_rate, c.grams(fixedMg), user.id]);
  return { rate: Number(rate.sell_rate).toFixed(2), weight: c.grams(fixedMg), sheetId: rate.sheet_id };
}

// A money advance: the customer's receipt (RC/…), held for the order.
async function takeMoney(db, business, user, order, contact, advance, { locationId, requestKey, hash }) {
  if (advance.fixRate && order.fixed_at) fail(`Order ${order.order_no}'s rate is fixed already`, 409);
  const method = await paymentMethods.settle(db, business.id, advance.choice, 'Paid by', ADVANCE_KINDS);
  const receipt = await numbering.nextNumber(db, business.id, locationId, 'collection', user.id);
  const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,
      request_key,request_hash,created_by,method_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [business.id, locationId, receipt.number, receipt.seriesId, contact.id, contact.name, c.rupees(advance.amount), method.method, advance.reference,
    `Custom order ${order.order_no}: advance`, c.derivedKey(requestKey, 'advance'), hash, user.id, method.methodName]);
  await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, customOrder: order.order_no });
  await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
    collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method: collection.method });
  await db.query('INSERT INTO jewellery_order_advances(business_id,order_id,collection_id,amount,fixes_rate,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [business.id, order.id, collection.id, collection.amount, advance.fixRate, user.id]);
  const fixed = advance.fixRate ? await fixRateOn(db, business, user, order, advance.amount) : null;
  const figures = { orderNo: order.order_no, receipt: collection.collection_no, amount: collection.amount, method: collection.method, ...(fixed ? { fixed } : {}) };
  await repo.audit(db, business.id, user.id, 'jewellery_order.advance', order.id, figures);
  await repo.event(db, business.id, user.id, 'jewellery_order.advance', 'jewellery_order', order.id, { ...figures, collectionId: collection.id, contactId: contact.id });
}

// body: { requestKey, amount, method | methodId, reference?, fixRate? } (money) or { requestKey, oldGoldId, fixRate? } (the customer's old gold, all its value).
async function addAdvance(business, user, orderId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await access.require(business, 'sales.edit');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const oldGoldId = c.given(body.oldGoldId) ? id(body.oldGoldId, 'Old gold voucher') : null;
  const advance = oldGoldId ? null : readMoneyAdvance(body);
  const fixRate = oldGoldId ? v.requiredBoolean(body.fixRate, 'Fix the rate on this advance', false) : advance.fixRate;
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const order = await lockOrder(db, business, orderId);
    // A retry: the receipt made with this key, or the voucher held for this order.
    const done = oldGoldId ? await repo.one(db, 'SELECT order_id FROM jewellery_order_advances WHERE business_id=$1 AND order_id=$2 AND old_gold_id=$3', [business.id, order.id, oldGoldId])
      : await repo.one(db, `SELECT a.order_id,k.request_hash FROM business_collections k JOIN jewellery_order_advances a ON a.business_id=k.business_id AND a.collection_id=k.id
        WHERE k.business_id=$1 AND k.request_key=$2`, [business.id, c.derivedKey(requestKey, 'advance')]);
    if (done) {
      if (Number(done.order_id) !== Number(order.id) || (done.request_hash && done.request_hash !== hash)) fail('This request key was already used for different data', 409);
      return view(db, business, order.id);
    }
    if (!OPEN.includes(order.status)) fail(`Order ${order.order_no} is ${order.status} and takes no advance`, 409);
    if (fixRate && order.fixed_at) fail(`Order ${order.order_no}'s rate is fixed already`, 409);
    const contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, order.contact_id]);
    if (advance) {
      await takeMoney(db, business, user, order, contact, advance, { locationId: order.location_id, requestKey, hash });
      return view(db, business, order.id);
    }
    const voucher = await repo.one(db, `SELECT g.id,g.voucher_no,g.contact_id,g.cancelled_at,g.value
        - COALESCE((SELECT sum(u.amount) FROM jewellery_old_gold_uses u WHERE u.business_id=g.business_id AND u.old_gold_id=g.id),0)
        - COALESCE((SELECT sum(p.amount) FROM jewellery_old_gold_payouts p WHERE p.business_id=g.business_id AND p.old_gold_id=g.id),0) AS balance
      FROM jewellery_old_gold g WHERE g.business_id=$1 AND g.id=$2 FOR UPDATE OF g`, [business.id, oldGoldId]);
    if (!voucher) fail('Old gold voucher not found', 404);
    if (Number(voucher.contact_id) !== Number(order.contact_id)) fail(`Old gold ${voucher.voucher_no} is another customer's`, 409);
    if (voucher.cancelled_at) fail(`Old gold ${voucher.voucher_no} is cancelled`, 409);
    if (c.paise(voucher.balance) <= 0) fail(`Old gold ${voucher.voucher_no} has nothing left on it`, 409);
    const held = await repo.one(db, `SELECT o.order_no FROM jewellery_order_advances a JOIN jewellery_orders o ON o.business_id=a.business_id AND o.id=a.order_id
      WHERE a.business_id=$1 AND a.old_gold_id=$2 AND o.status NOT IN ('delivered','cancelled')`, [business.id, voucher.id]);
    if (held) fail(`Old gold ${voucher.voucher_no} is held for order ${held.order_no}`, 409);
    await db.query('INSERT INTO jewellery_order_advances(business_id,order_id,old_gold_id,amount,fixes_rate,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [business.id, order.id, voucher.id, voucher.balance, fixRate, user.id]);
    const fixed = fixRate ? await fixRateOn(db, business, user, order, c.paise(voucher.balance)) : null;
    const figures = { orderNo: order.order_no, voucherNo: voucher.voucher_no, amount: Number(voucher.balance).toFixed(2), ...(fixed ? { fixed } : {}) };
    await repo.audit(db, business.id, user.id, 'jewellery_order.advance', order.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_order.advance', 'jewellery_order', order.id, { ...figures, oldGoldId: voucher.id, contactId: order.contact_id });
    return view(db, business, order.id);
  });
}

// --- Along its path --------------------------------------------------------------------------------

// body: { pieceId | tag }: a piece in stock (made in the shop, or picked for the customer) made the order's own.
async function attachPiece(business, user, orderId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const order = await lockOrder(db, business, orderId);
    const found = c.given(body.pieceId) ? await repo.one(db, 'SELECT id FROM jewellery_pieces WHERE business_id=$1 AND id=$2', [business.id, id(body.pieceId, 'Piece')])
      : await repo.one(db, 'SELECT id FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, pieces.readTag(body.tag, 'Tag')]);
    if (!found) fail('Piece not found', 404);
    const piece = await pieces.pieceRow(db, business, found.id, { lock: true });
    const already = await repo.one(db, 'SELECT order_id FROM jewellery_order_pieces WHERE business_id=$1 AND piece_id=$2', [business.id, piece.id]);
    if (already) {
      if (Number(already.order_id) === Number(order.id)) return view(db, business, order.id);
      fail(`Piece ${piece.tag_no} was made for another order`, 409);
    }
    if (!['booked', 'issued', 'received', 'hallmarked', 'ready'].includes(order.status)) fail(`Order ${order.order_no} is ${STATUS_WORDS[order.status].toLowerCase()}: no piece joins it now`, 409);
    if (piece.status !== 'in_stock') fail(`Piece ${piece.tag_no} is ${pieces.STATUS_WORDS[piece.status]}: only a piece in stock is made an order's own`, 409);
    if (piece.metal !== order.metal || piece.purity !== order.purity) fail(`Order ${order.order_no} is for ${c.purityWords(order.metal, order.purity)}`, 409);
    await db.query('INSERT INTO jewellery_order_pieces(business_id,order_id,piece_id,created_by) VALUES($1,$2,$3,$4)', [business.id, order.id, piece.id, user.id]);
    if (['booked', 'issued'].includes(order.status)) {
      await db.query("UPDATE jewellery_orders SET status='received',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, order.id, user.id]);
    }
    await pieces.history(db, business, user, piece.id, 'changed', { note: `Made order ${order.order_no}'s own`, details: { orderNo: order.order_no } });
    await repo.audit(db, business.id, user.id, 'jewellery_order.piece_added', order.id, { orderNo: order.order_no, tag: piece.tag_no });
    return view(db, business, order.id);
  });
}

// The order's pieces are back in stock and it waits for its customer.
async function markReady(business, user, orderId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  return repo.transaction(async (db) => {
    const order = await lockOrder(db, business, orderId);
    if (order.status === 'ready') return view(db, business, order.id);
    if (!['received', 'hallmarked'].includes(order.status)) fail(`Order ${order.order_no} is ${STATUS_WORDS[order.status].toLowerCase()}: it is ready once its piece is received`, 409);
    const out = await repo.one(db, `SELECT p.tag_no,p.status FROM jewellery_order_pieces op JOIN jewellery_pieces p ON p.business_id=op.business_id AND p.id=op.piece_id
      WHERE op.business_id=$1 AND op.order_id=$2 AND p.status<>'in_stock' AND p.status IN ('on_approval','at_karigar','at_centre') LIMIT 1`, [business.id, order.id]);
    if (out) fail(`Piece ${out.tag_no} is ${pieces.STATUS_WORDS[out.status]}: the order is ready when its pieces are in stock`, 409);
    await db.query("UPDATE jewellery_orders SET status='ready',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, order.id, user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_order.ready', order.id, { orderNo: order.order_no });
    await repo.event(db, business.id, user.id, 'jewellery_order.ready', 'jewellery_order', order.id, { orderNo: order.order_no, contactId: order.contact_id });
    return view(db, business, order.id);
  });
}

// body: { reason }. Cancelled while nothing of it is at the centre: its advances are the customer's again, and its pieces the shop's stock.
async function cancel(business, user, orderId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.cancel');
  const reason = v.requiredString(body.reason, 'Why the order is cancelled', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const order = await lockOrder(db, business, orderId);
    if (order.status === 'cancelled') return view(db, business, order.id);
    if (order.status === 'delivered') fail(`Order ${order.order_no} was delivered: it is not cancelled`, 409);
    if (order.status === 'at_centre') fail(`Order ${order.order_no} is at the hallmarking centre: cancel it once it is back`, 409);
    await db.query("UPDATE jewellery_orders SET status='cancelled',cancel_reason=$3,cancelled_by=$4,cancelled_at=now(),updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2",
      [business.id, order.id, reason, user.id]);
    const advances = await repo.one(db, 'SELECT COALESCE(sum(amount),0) AS total FROM jewellery_order_advances WHERE business_id=$1 AND order_id=$2', [business.id, order.id]);
    const figures = { orderNo: order.order_no, reason, advances: Number(advances.total).toFixed(2) };
    await repo.audit(db, business.id, user.id, 'jewellery_order.cancelled', order.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_order.cancelled', 'jewellery_order', order.id, { ...figures, contactId: order.contact_id });
    return view(db, business, order.id);
  });
}

// --- An order on its jewellery bill -------------------------------------------------------------------

// The order a bill delivers (locked when posting): ready, with its pieces, its
// receipts and what is free on each, its old gold with what is left, and the
// rate fixed on it.
async function forBill(db, business, orderId, { lock = false } = {}) {
  const order = lock ? await lockOrder(db, business, orderId) : await repo.one(db, 'SELECT * FROM jewellery_orders WHERE business_id=$1 AND id=$2', [business.id, id(orderId, 'Custom order')]);
  if (!order) fail('Custom order not found', 404);
  if (order.status !== 'ready') fail(`Order ${order.order_no} is ${STATUS_WORDS[order.status].toLowerCase()}: it is billed once it is ready`, 409);
  const made = await repo.all(db, `SELECT p.id,p.tag_no FROM jewellery_order_pieces op JOIN jewellery_pieces p ON p.business_id=op.business_id AND p.id=op.piece_id
    WHERE op.business_id=$1 AND op.order_id=$2 AND p.status NOT IN ('melted','split','merged','retagged') ORDER BY p.id`, [business.id, order.id]);
  if (!made.length) fail(`Order ${order.order_no} has no piece to deliver`, 409);
  const receipts = await repo.all(db, `SELECT k.id AS collection_id,k.collection_no,k.method,k.method_name,k.amount,
      k.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0) AS free
    FROM jewellery_order_advances a JOIN business_collections k ON k.business_id=a.business_id AND k.id=a.collection_id
    WHERE a.business_id=$1 AND a.order_id=$2 ORDER BY a.id`, [business.id, order.id]);
  const vouchers = await repo.all(db, 'SELECT old_gold_id FROM jewellery_order_advances WHERE business_id=$1 AND order_id=$2 AND old_gold_id IS NOT NULL ORDER BY id', [business.id, order.id]);
  return { ...order, made, receipts: receipts.map((r) => ({ ...r, freePaise: c.paise(r.free) })).filter((r) => r.freePaise > 0), voucherIds: vouchers.map((x) => x.old_gold_id),
    fixed: order.fixed_at ? { mg: c.mg(order.fixed_weight), rate: Number(order.fixed_rate), sheetId: order.fixed_sheet_id } : null };
}

// After the bill's sale is posted: each receipt pays it as far as it still needs, and the order is delivered on it.
async function deliver(db, business, user, document, order, receiptUses, keyOf) {
  for (const use of receiptUses) {
    await core.recordPayment(db, business, user, document, { amount: c.rupees(use.amount), method: use.receipt.method, reference: use.receipt.collection_no,
      key: keyOf(use.receipt), collectionId: use.receipt.collection_id });
  }
  await db.query("UPDATE jewellery_orders SET status='delivered',document_id=$3,delivered_at=now(),updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2",
    [business.id, order.id, document.id, user.id]);
  const figures = { orderNo: order.order_no, documentNo: document.document_no, advancesUsed: c.rupees(receiptUses.reduce((s, u) => s + u.amount, 0)),
    fixedRate: order.fixed_rate ? Number(order.fixed_rate).toFixed(2) : null, fixedWeight: order.fixed_weight ? Number(order.fixed_weight).toFixed(3) : null };
  await repo.audit(db, business.id, user.id, 'jewellery_order.delivered', order.id, figures);
  await repo.event(db, business.id, user.id, 'jewellery_order.delivered', 'jewellery_order', order.id, { ...figures, documentId: document.id, contactId: order.contact_id });
}

// A customer's receipts held for their open orders (collection ids): the core's receivables leave them out when it applies advances.
async function heldReceipts(db, business, contactId) {
  const rows = await repo.all(db, `SELECT a.collection_id FROM jewellery_order_advances a JOIN jewellery_orders o ON o.business_id=a.business_id AND o.id=a.order_id
    WHERE a.business_id=$1 AND o.contact_id=$2 AND a.collection_id IS NOT NULL AND o.status NOT IN ('delivered','cancelled')`, [business.id, contactId]);
  return new Set(rows.map((r) => Number(r.collection_id)));
}

// The bell: open orders past the day promised.
async function bell(business, base) {
  if (!access.can(business, 'jewellery.view') || !c.seesMoney(business)) return [];
  const row = await repo.one(repo.pool, `SELECT count(*)::int AS n,min(promised_on) AS since FROM (${ORDERS_SQL}) x WHERE x.late AND ($2::bigint IS NULL OR x.location_id=$2)`,
    [business.id, business.location_scope || null]);
  if (!row.n) return [];
  return [{ id: `jewellery-orders-late:${String(row.since).slice(0, 10)}`, severity: 'warning', category: 'Custom orders', title: `${c.plural(row.n, 'custom order')} past the day promised`,
    detail: 'Tell the customer, or make the piece ready', at: `${String(row.since).slice(0, 10)}T00:00:00.000Z`, link: `${base}/custom-orders` }];
}

module.exports = { STATUS_WORDS, OPEN, book, update, detail, view, addAdvance, attachPiece, markReady, cancel, forBill, deliver, heldReceipts, bell, listShape };
