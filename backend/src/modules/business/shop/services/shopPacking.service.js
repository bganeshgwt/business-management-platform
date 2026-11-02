const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const settingsService = require('./shopSettings.service');
const catalog = require('./shopCatalog.service');
const orders = require('./shopOrders.service');
const money = require('./shopMoney');

// Packing, billing and handing over an online order (ADMIN_GUIDE.md, the
// online shop: packing, billing, delivery and payment).
//
// Packing (the order accepted, not billed): each line ticked as packed, or
// marked short or not available; a weighed item's weight typed; an item
// replaced (per the guest's choice) or added (the guest asked on the phone);
// a line's price lowered with the discount permission, within the business's
// bill discount limit. A change that would make the guest pay more than they
// agreed to (a dearer replacement, an added item, weighing more than 10% over)
// is asked of them (their page shows Accept and Reject), or agreed on the
// phone; a lower total applies at once.
//
// Billing posts the sale through the core (postDocument, `fixed` lines): the
// packed quantities at the order's prices, batches first-expiring among those
// with 45 days or more left (FSSAI's shelf life for food sold online), and the
// delivery charge as one "Delivery charge" line per GST rate of the goods,
// shared by their value. Stock leaves at billing as for every sale; the bill
// stays unpaid until the order is handed over.
//
// Handing over: ready for pickup, or out for delivery with the delivery
// person's name; then completed with the payment recorded on the bill (or on
// the customer's account), or refused at the door / not collected: the bill
// taken back through the core's returns, the stock back on the shelf.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const SHELF_DAYS = 45;
const methods = ['cash', 'card', 'upi', 'bank', 'cheque'];
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const words = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (quantity) => String(Number(Number(quantity).toFixed(3)));

const linkOf = (db, order) => repo.one(db, `SELECT x.*,b.timezone,b.name AS business_name,s.tax_mode,s.rounding,s.max_bill_discount_percent
  FROM shop_settings x JOIN businesses b ON b.id=x.business_id LEFT JOIN business_settings s ON s.business_id=x.business_id WHERE x.id=$1`, [order.settings_id]);

// Before billing, the order is being packed: its first change starts packing,
// and any change takes back a question waiting for the guest (the shop asks again).
async function packingStep(db, business, user, order) {
  if (order.status !== 'accepted') {
    fail(order.status === 'placed' ? 'Accept the order before packing it.' : `This order is ${order.status.replace(/_/g, ' ')}: its lines are no longer changed.`, 409, { reason: 'not_packing' });
  }
  await db.query("UPDATE shop_order_changes SET status='withdrawn',answered_at=now(),answered_by=$2 WHERE order_id=$1 AND status='waiting'", [order.id, user.id]);
  await db.query('UPDATE shop_orders SET packing_at=COALESCE(packing_at,now()),revision=revision+1,updated_at=now() WHERE id=$1', [order.id]);
}

const readQuantity = (value, name, weighed) => {
  const quantity = core.decimal(value, name, weighed ? 3 : 0, 0, 100000);
  return quantity;
};

// Serial numbers for a serial-numbered line: one per unit, each in usable stock at the location.
async function readSerials(db, business, order, line, value, quantity) {
  const list = v.requiredArray(value, 'Serial numbers').map((serial) => v.requiredString(serial, 'Serial number', 100));
  if (new Set(list).size !== list.length) fail('Each serial number is given once');
  if (list.length !== quantity) fail(`Give ${quantity} serial ${quantity === 1 ? 'number' : 'numbers'} for ${line.name}`);
  const found = await repo.all(db, `SELECT lot_code FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=ANY($4::text[]) AND quantity>=1`,
    [business.id, order.location_id, line.sku_id, list]);
  const missing = list.filter((serial) => !found.some((row) => row.lot_code === serial));
  if (missing.length) fail(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in stock here for ${line.name}`, 409);
  return list;
}

// One line as packed: ticked, short, not available, weighed, a lower price, serial numbers, a note.
async function editLine(business, user, orderId, lineId, body = {}) {
  await access.require(business, 'online_shop.edit');
  const lowering = body.billPrice !== undefined;
  if (lowering && body.billPrice !== null && body.billPrice !== '') await access.require(business, 'sales.discount');
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    orders.sameRevision(order, body);
    const line = await repo.one(db, `SELECT l.*,s.tracking FROM shop_order_lines l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      WHERE l.business_id=$1 AND l.order_id=$2 AND l.id=$3 FOR UPDATE OF l`, [business.id, order.id, v.requiredId(lineId, 'Line')]);
    if (!line) fail('That line is not on this order', 404);
    await packingStep(db, business, user, order);
    const sets = {};
    if (body.state !== undefined) {
      const state = v.requiredEnum(body.state, 'Packed as', ['pending', 'ok', 'short', 'unavailable']);
      if (line.state === 'replaced') fail('This line was replaced: remove its replacement first to pack it again.', 409);
      sets.state = state;
      if (state === 'pending') { sets.packed_quantity = null; sets.picked = false; sets.serials = []; }
      if (state === 'unavailable') { sets.packed_quantity = 0; sets.picked = false; sets.serials = []; }
      if (state === 'ok' && !line.weighed) sets.packed_quantity = Number(line.quantity);
      if (state === 'ok' && line.weighed && (body.packedQuantity === undefined || body.packedQuantity === null || body.packedQuantity === '')) {
        fail(`Weigh ${line.name} and enter what was packed`, 400, { field: 'packedQuantity' });
      }
      if (state === 'ok') sets.picked = true;
    }
    if (body.packedQuantity !== undefined && body.packedQuantity !== null && body.packedQuantity !== '') {
      const packed = readQuantity(body.packedQuantity, 'Packed quantity', line.weighed);
      const state = sets.state || line.state;
      if (!line.weighed && state === 'short' && !(packed > 0 && packed < Number(line.quantity))) fail(`Short means fewer than the ${qtyText(line.quantity)} ordered, and more than none`);
      if (!line.weighed && state === 'ok' && packed !== Number(line.quantity)) fail('Mark the line short when fewer were packed');
      if (line.weighed && !(packed > 0)) fail('Enter the weight packed, or mark the item not available');
      if (line.weighed && packed > 100000) fail('That weight is too large');
      sets.packed_quantity = packed;
      if (line.weighed && !sets.state) { sets.state = 'ok'; sets.picked = true; }
    }
    if ((sets.state || line.state) === 'short' && (sets.packed_quantity ?? line.packed_quantity) === null) fail('Enter how many were packed', 400, { field: 'packedQuantity' });
    if (body.picked !== undefined) sets.picked = v.requiredBoolean(body.picked, 'Picked');
    if (body.serials !== undefined) {
      const state = sets.state || line.state;
      const quantity = Number(sets.packed_quantity ?? line.packed_quantity ?? line.quantity);
      if (line.tracking !== 'serial') fail(`${line.name} has no serial numbers`);
      sets.serials = ['ok', 'short'].includes(state) ? await readSerials(db, business, order, line, body.serials, quantity) : [];
    }
    if (lowering) {
      if (body.billPrice === null || body.billPrice === '') { sets.bill_price = null; sets.discount_reason = null; } else {
        const price = core.decimal(body.billPrice, 'Price', 2, 0, 100000000);
        if (price >= Number(line.price)) fail(`A lower price is below the ${words(money.paise(line.price))} the customer saw`);
        sets.bill_price = price.toFixed(2);
        sets.discount_reason = v.requiredString(body.discountReason, 'Reason for the lower price', 200);
      }
    }
    if (body.note !== undefined) sets.note = v.optionalString(body.note, 'Note', 200);
    const names = Object.keys(sets);
    if (!names.length) fail('Nothing to change');
    await db.query(`UPDATE shop_order_lines SET ${names.map((name, index) => `${name}=$${index + 3}`).join(',')} WHERE business_id=$1 AND id=$2`,
      [business.id, line.id, ...names.map((name) => sets[name])]);
    if (lowering) await checkDiscount(db, business, order);
    await repo.audit(db, business.id, user.id, 'online_order.packing', order.id, { orderNo: order.order_no, line: line.name, changed: names });
    return orders.detailIn(db, business, order.id);
  });
}

// Lower prices stay within the business's bill discount limit (Business settings › Rules).
async function checkDiscount(db, business, order) {
  const link = await linkOf(db, order);
  const lines = await orders.linesOf(db, order);
  const kept = lines.filter((line) => !['unavailable', 'replaced'].includes(line.state));
  const atPrices = kept.reduce((sum, line) => sum + money.lineAmount(money.paise(line.price), line.packed_quantity === null ? Number(line.quantity) : Number(line.packed_quantity)), 0);
  const billed = kept.reduce((sum, line) => sum + orders.packedAmount(line), 0);
  if (money.discountRoom({ goodsAmount: atPrices, takenOff: 0, limitPercent: link.max_bill_discount_percent }) < atPrices - billed) {
    fail(`Lower prices on this order come to ${words(atPrices - billed)}, more than the ${Number(link.max_bill_discount_percent || 0)}% a bill may be given (Business settings).`, 409, { reason: 'discount_limit' });
  }
}

// An item shown online now at the order's location, priced for it: a replacement or an added item.
async function itemForOrder(db, order, skuId, quantity) {
  const link = await repo.one(db, `SELECT x.*,b.timezone,s.tax_mode,s.rounding FROM shop_settings x JOIN businesses b ON b.id=x.business_id
    LEFT JOIN business_settings s ON s.business_id=x.business_id WHERE x.id=$1`, [order.settings_id]);
  const { lines } = await catalog.priceLines(db, { ...link, hide_out_of_stock: true }, [{ skuId, quantity }]);
  const [line] = lines;
  if (line.problem === 'gone') fail('That item is not sold in the online shop', 409, { reason: 'not_online' });
  if (line.problem === 'out') fail(`${line.name} is out of stock here`, 409, { reason: 'out_of_stock' });
  if (line.problem === 'less') fail(`Only ${qtyText(line.max)} of ${line.name} is in stock here`, 409, { reason: 'out_of_stock' });
  if (line.problem === 'quantity') fail(`${line.name} is sold in steps of ${qtyText(line.step)} ${line.unit}`);
  return line;
}

async function addLine(db, business, order, line, { replaces = null, note = null }) {
  const next = await repo.one(db, 'SELECT COALESCE(max(position),0)+1 AS position FROM shop_order_lines WHERE business_id=$1 AND order_id=$2', [business.id, order.id]);
  return repo.one(db, `INSERT INTO shop_order_lines(business_id,order_id,position,sku_id,name,unit,quantity,price,mrp,tax_rate,weighed,state,packed_quantity,picked,added,replaces_line_id,note)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,$15,$16) RETURNING *`,
  [business.id, order.id, next.position, line.skuId, line.name.slice(0, 200), line.unit, line.quantity, line.price.toFixed(2),
    line.mrpValue === null ? null : line.mrpValue.toFixed(2), line.taxRate.toFixed(2), line.weighed, line.weighed ? 'pending' : 'ok', line.weighed ? null : line.quantity,
    !line.weighed, replaces, note]);
}

// A line replaced by another item (the guest chose "Replace with something
// similar", or agreed on the phone), at that item's online price.
async function replace(business, user, orderId, lineId, body = {}) {
  await access.require(business, 'online_shop.edit');
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    orders.sameRevision(order, body);
    const line = await repo.one(db, 'SELECT * FROM shop_order_lines WHERE business_id=$1 AND order_id=$2 AND id=$3 FOR UPDATE', [business.id, order.id, v.requiredId(lineId, 'Line')]);
    if (!line) fail('That line is not on this order', 404);
    if (line.added) fail('Replace an item the customer ordered; remove an added one instead');
    if (line.state === 'replaced') fail('This line is already replaced: remove its replacement first', 409);
    await packingStep(db, business, user, order);
    const skuId = v.requiredId(body.skuId, 'Replacement');
    if (Number(skuId) === Number(line.sku_id)) fail('Choose another item as the replacement');
    const item = await itemForOrder(db, order, skuId, body.quantity ?? line.quantity);
    await db.query("UPDATE shop_order_lines SET state='replaced',packed_quantity=0,picked=FALSE,serials='{}' WHERE id=$1", [line.id]);
    await addLine(db, business, order, item, { replaces: line.id, note: v.optionalString(body.note, 'Note', 200) });
    await repo.audit(db, business.id, user.id, 'online_order.replaced', order.id, { orderNo: order.order_no, from: line.name, to: item.name });
    return orders.detailIn(db, business, order.id);
  });
}

// An item added to the order (the guest asked for it on the phone).
async function add(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.edit');
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    orders.sameRevision(order, body);
    await packingStep(db, business, user, order);
    const skuId = v.requiredId(body.skuId, 'Item');
    const taken = await repo.one(db, "SELECT id FROM shop_order_lines WHERE business_id=$1 AND order_id=$2 AND sku_id=$3 AND state<>'replaced'", [business.id, order.id, skuId]);
    if (taken) fail('That item is already on the order: change its line instead', 409);
    const item = await itemForOrder(db, order, skuId, body.quantity ?? 1);
    await addLine(db, business, order, item, { note: v.optionalString(body.note, 'Note', 200) || 'Asked for by the customer' });
    await repo.audit(db, business.id, user.id, 'online_order.item_added', order.id, { orderNo: order.order_no, item: item.name });
    return orders.detailIn(db, business, order.id);
  });
}

// An added line taken off again (a replacement's line goes back to be packed).
async function removeLine(business, user, orderId, lineId, body = {}) {
  await access.require(business, 'online_shop.edit');
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    orders.sameRevision(order, body);
    const line = await repo.one(db, 'SELECT * FROM shop_order_lines WHERE business_id=$1 AND order_id=$2 AND id=$3 FOR UPDATE', [business.id, order.id, v.requiredId(lineId, 'Line')]);
    if (!line) fail('That line is not on this order', 404);
    if (!line.added) fail('Only an added item or a replacement is removed: mark an ordered item not available instead', 409);
    await packingStep(db, business, user, order);
    await db.query('DELETE FROM shop_order_lines WHERE id=$1', [line.id]);
    if (line.replaces_line_id) await db.query("UPDATE shop_order_lines SET state='pending',packed_quantity=NULL WHERE id=$1", [line.replaces_line_id]);
    await repo.audit(db, business.id, user.id, 'online_order.item_removed', order.id, { orderNo: order.order_no, item: line.name });
    return orders.detailIn(db, business, order.id);
  });
}

// --- Asking the guest's OK ------------------------------------------------------------------------

// What changed, in the guest's words: each line that now costs more than as ordered, each replacement and each added item.
function changedLines(lines) {
  const out = [];
  for (const line of lines) {
    const before = line.added ? 0 : money.lineAmount(money.paise(line.price), Number(line.quantity));
    const after = orders.packedAmount(line);
    if (line.replaces_line_id) {
      const was = lines.find((other) => Number(other.id) === Number(line.replaces_line_id));
      const wasAmount = was ? money.lineAmount(money.paise(was.price), Number(was.quantity)) : 0;
      out.push({ name: line.name, was: was ? `${was.name} × ${qtyText(was.quantity)}` : null, now: `${line.name} × ${qtyText(line.packed_quantity ?? line.quantity)}`,
        amountBefore: wasAmount / 100, amountAfter: after / 100, kind: 'replaced' });
    } else if (line.added) {
      out.push({ name: line.name, was: null, now: `${line.name} × ${qtyText(line.packed_quantity ?? line.quantity)}`, amountBefore: 0, amountAfter: after / 100, kind: 'added' });
    } else if (after > before) {
      out.push({ name: line.name, was: `about ${qtyText(line.quantity)} ${line.unit}`, now: `${qtyText(line.packed_quantity)} ${line.unit}`, amountBefore: before / 100, amountAfter: after / 100,
        kind: line.weighed ? 'weighed' : 'more' });
    }
  }
  return out;
}

// Asks the guest to agree to a higher total (their page shows it at once).
async function ask(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.edit');
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    orders.sameRevision(order, body);
    if (order.status !== 'accepted') fail('Only an order being packed is changed', 409);
    const link = await linkOf(db, order);
    const lines = await orders.linesOf(db, order);
    const raised = await repo.one(db, "SELECT 1 FROM shop_order_changes WHERE order_id=$1 AND status='accepted' LIMIT 1", [order.id]);
    const figures = orders.figuresOf(order, lines, { rounding: link.rounding, raised: Boolean(raised) });
    if (figures.over <= 0) fail(`No need to ask: the order comes to ${words(figures.total)}, within the ${words(figures.ceiling)} the customer agreed to.`, 409, { reason: 'within_agreed' });
    await db.query("UPDATE shop_order_changes SET status='withdrawn',answered_at=now(),answered_by=$2 WHERE order_id=$1 AND status='waiting'", [order.id, user.id]);
    const change = await repo.one(db, `INSERT INTO shop_order_changes(business_id,order_id,total_before,total_after,lines,note,asked_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [business.id, order.id, order.agreed_total, (figures.total / 100).toFixed(2), JSON.stringify(changedLines(lines)), v.optionalString(body.note, 'Note for the customer', 300), user.id]);
    await db.query('UPDATE shop_orders SET packing_at=COALESCE(packing_at,now()),revision=revision+1,updated_at=now() WHERE id=$1', [order.id]);
    await repo.audit(db, business.id, user.id, 'online_order.change_asked', order.id, { orderNo: order.order_no, changeId: change.id, from: order.agreed_total, to: (figures.total / 100).toFixed(2) });
    return orders.detailIn(db, business, order.id);
  });
}

async function settle(db, order, change, accepted, { via, userId }) {
  await db.query('UPDATE shop_order_changes SET status=$2,answered_via=$3,answered_at=now(),answered_by=$4 WHERE id=$1', [change.id, accepted ? 'accepted' : 'rejected', via, userId]);
  if (accepted) await db.query('UPDATE shop_orders SET agreed_total=$2,revision=revision+1,updated_at=now() WHERE id=$1', [order.id, change.total_after]);
  else await db.query('UPDATE shop_orders SET revision=revision+1,updated_at=now() WHERE id=$1', [order.id]);
}

// The guest's answer on their status page.
async function answerByGuest(guestToken, changeId, body = {}) {
  const accepted = v.requiredBoolean(body.accept, 'Your answer');
  return repo.transaction(async (db) => {
    const order = await orders.loadByGuestToken(db, guestToken, { lock: true });
    const change = await repo.one(db, 'SELECT * FROM shop_order_changes WHERE business_id=$1 AND order_id=$2 AND id=$3 FOR UPDATE', [order.business_id, order.id, v.requiredId(changeId, 'Change')]);
    if (!change) fail('That change is not on this order', 404);
    if (change.status !== 'waiting') {
      if ((change.status === 'accepted') === accepted && change.answered_via === 'guest') return orders.guestAnswer(db, guestToken);
      fail(change.status === 'withdrawn' ? 'The shop has changed the order again since: look at it once more.' : 'This change was already answered.', 409, { reason: 'answered' });
    }
    await settle(db, order, change, accepted, { via: 'guest', userId: null });
    await repo.guestAudit(db, order.business_id, accepted ? 'online_order.change_accepted' : 'online_order.change_rejected', order.id,
      { orderNo: order.order_no, changeId: change.id, total: change.total_after });
    return orders.guestAnswer(db, guestToken);
  });
}

// The guest's answer on the phone, typed by staff.
async function answerByPhone(business, user, orderId, changeId, body = {}) {
  await access.require(business, 'online_shop.edit');
  const accepted = v.requiredBoolean(body.accepted, 'The customer\'s answer');
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    const change = await repo.one(db, 'SELECT * FROM shop_order_changes WHERE business_id=$1 AND order_id=$2 AND id=$3 FOR UPDATE', [business.id, order.id, v.requiredId(changeId, 'Change')]);
    if (!change) fail('That change is not on this order', 404);
    if (change.status !== 'waiting') fail('This change was already answered', 409, { reason: 'answered' });
    await settle(db, order, change, accepted, { via: 'phone', userId: user.id });
    await repo.audit(db, business.id, user.id, accepted ? 'online_order.change_accepted' : 'online_order.change_rejected', order.id,
      { orderNo: order.order_no, changeId: change.id, total: change.total_after, via: 'phone' });
    return orders.detailIn(db, business, order.id);
  });
}

// --- Billing ----------------------------------------------------------------------------------------

// The batches a line is packed from: those with 45 days or more to expiry
// first (the earliest of them), then shorter-dated ones, with a warning.
async function lotsFor(db, business, order, line, quantityMilli, day) {
  const lots = await repo.all(db, `SELECT lot_code,expires_on::text AS expires_on,quantity,(expires_on IS NOT NULL AND expires_on<$4::date+$5::int) AS short
    FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND quantity>0 AND (expires_on IS NULL OR expires_on>=$4::date)
    ORDER BY (expires_on IS NOT NULL AND expires_on<$4::date+$5::int),expires_on NULLS LAST,id`, [business.id, order.location_id, line.sku_id, day, SHELF_DAYS]);
  const picks = [];
  const warnings = [];
  let left = quantityMilli;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, money.milli(lot.quantity));
    picks.push({ lotCode: lot.lot_code, quantity: take });
    if (lot.short) warnings.push(`${line.name}: batch ${lot.lot_code} expires on ${lot.expires_on}, less than ${SHELF_DAYS} days away. Food sold online should reach the customer with at least ${SHELF_DAYS} days left.`);
    left -= take;
  }
  if (left > 0) fail(`Only ${qtyText((quantityMilli - left) / 1000)} ${line.unit} of ${line.name} is in usable stock here: mark the line short or not available.`, 409, { reason: 'short_stock' });
  return { picks, warnings };
}

async function bill(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.edit');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    if (order.document_id) {
      const done = await repo.one(db, 'SELECT request_key FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, order.document_id]);
      if (done.request_key === requestKey) return { order: await orders.detailIn(db, business, order.id), warnings: [] };
      fail('This order is already billed', 409, { reason: 'billed' });
    }
    if (order.status !== 'accepted') fail(`This order is ${order.status.replace(/_/g, ' ')}: it is not billed now.`, 409, { reason: 'not_packing' });
    orders.sameRevision(order, body);
    const link = await linkOf(db, order);
    const lines = await orders.linesOf(db, order);
    const pending = lines.filter((line) => line.state === 'pending');
    if (pending.length) fail(`Pack every line first: ${pending.length} still to pack (${pending.map((line) => line.name).slice(0, 3).join(', ')}).`, 409, { reason: 'not_packed' });
    const waiting = await repo.one(db, "SELECT id FROM shop_order_changes WHERE order_id=$1 AND status='waiting'", [order.id]);
    if (waiting) fail('The customer has not answered the change you asked yet: wait for their answer, or agree it on the phone.', 409, { reason: 'waiting_for_ok' });
    const raised = await repo.one(db, "SELECT 1 FROM shop_order_changes WHERE order_id=$1 AND status='accepted' LIMIT 1", [order.id]);
    const figures = orders.figuresOf(order, lines, { rounding: link.rounding, raised: Boolean(raised) });
    if (figures.over > 0) {
      fail(`This order now comes to ${words(figures.total)}, more than the ${words(figures.ceiling)} the customer agreed to. Ask them first, or take something off.`, 409,
        { reason: 'needs_ok', total: figures.total / 100, ceiling: figures.ceiling / 100 });
    }
    const billed = lines.filter((line) => ['ok', 'short'].includes(line.state) && Number(line.packed_quantity) > 0);
    if (!billed.length) fail('Nothing is packed: cancel the order instead, with a reason the customer sees.', 409, { reason: 'nothing_packed' });
    if (!order.contact_id) throw new Error('An accepted online order has its customer');
    const day = await catalog.today(db, business.timezone);
    const skus = await repo.all(db, `SELECT s.id,s.tax_rate,s.product_id,u.decimals AS unit_decimals FROM catalog_skus s JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      WHERE s.business_id=$1 AND s.id=ANY($2::bigint[])`, [business.id, billed.map((line) => line.sku_id)]);
    // GST at each item's rate on the day of the bill; apparel at the rate its
    // price per piece decides, as the counter charges it (fashion's GST by price).
    const priced = billed.map((line) => ({ sku: { ...skus.find((row) => Number(row.id) === Number(line.sku_id)) }, amount: orders.packedAmount(line), quantity: Number(line.packed_quantity) }));
    if (business.business_type === 'fashion') {
      await require('../../fashion-electronics/services/businessFashionMerchandising.service').applyPriceSlabs(db, business, priced, null, 'inclusive');
    }
    const pieces = [];
    const warnings = [];
    for (const [index, line] of billed.entries()) {
      const quantityMilli = money.milli(line.packed_quantity);
      const gross = orders.packedAmount(line);
      const rate = Number(priced[index].sku.tax_rate);
      let parts;
      if (line.tracking === 'serial') {
        if (line.serials.length !== quantityMilli / 1000) fail(`Choose the serial ${quantityMilli === 1000 ? 'number' : 'numbers'} of ${line.name} packed`, 409, { reason: 'serials' });
        parts = line.serials.map((serial) => ({ lotCode: serial, quantity: 1000 }));
      } else if (line.tracking === 'batch') {
        const found = await lotsFor(db, business, order, line, quantityMilli, day);
        parts = found.picks; warnings.push(...found.warnings);
      } else {
        parts = [{ lotCode: '', quantity: quantityMilli }];
      }
      const shares = money.shareByQuantity(gross, parts.map((part) => part.quantity));
      parts.forEach((part, index) => {
        const { net, tax } = money.inclusiveParts(shares[index], rate);
        pieces.push({ skuId: Number(line.sku_id), lotCode: part.lotCode, quantity: part.quantity, gross: shares[index], net, tax, rate, label: null });
      });
    }
    // The delivery charge, on the goods' GST rates, shared by their value.
    const delivery = money.paise(order.delivery_charge);
    if (delivery > 0) {
      const item = await settingsService.deliveryItem(db, business, user.id, link);
      if (!item.active) fail('The "Delivery charge" item is switched off under Products: switch it on to bill this order\'s delivery charge.', 409, { reason: 'delivery_item_off' });
      const split = money.splitByRate(delivery, pieces.map((piece) => ({ rate: piece.rate, amount: piece.gross })));
      for (const part of split) {
        const { net, tax } = money.inclusiveParts(part.amount, part.rate);
        pieces.push({ skuId: Number(item.id), lotCode: '', quantity: 1000, gross: part.amount, net, tax, rate: part.rate,
          label: split.length > 1 ? `Delivery charge (on goods at ${Number(part.rate)}% GST)` : 'Delivery charge' });
      }
    }
    const documentBody = {
      kind: 'sale', locationId: Number(order.location_id), contactId: Number(order.contact_id), notes: `Online order ${order.order_no}`,
      lines: pieces.map((piece) => ({ skuId: piece.skuId, quantity: qtyText(piece.quantity / 1000), ...(piece.lotCode ? { lotCode: piece.lotCode } : {}) })),
    };
    const fixed = pieces.map((piece) => ({ price: Number(((piece.net / 100) / (piece.quantity / 1000)).toFixed(4)), net: piece.net, tax: piece.tax,
      taxRate: piece.rate.toFixed(2), ...(piece.label ? { label: piece.label } : {}) }));
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey, hash: sha256(documentBody), lines: documentBody.lines, paidNow: null, fixed });
    if (money.paise(document.total) !== figures.total) throw new Error(`The bill of ${order.order_no} came to ${document.total}, not ${figures.total / 100}`);
    await db.query(`UPDATE shop_orders SET status='packed',document_id=$3,final_total=$4,packed_at=now(),packed_by=$5,packing_at=COALESCE(packing_at,now()),revision=revision+1,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, order.id, document.id, document.total, user.id]);
    await repo.audit(db, business.id, user.id, 'online_order.packed', order.id, { orderNo: order.order_no, documentNo: document.document_no, total: document.total, ...(warnings.length ? { warnings } : {}) });
    await repo.event(db, business.id, user.id, 'online_order.packed', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no, documentId: document.id, total: document.total });
    return { order: await orders.detailIn(db, business, order.id), warnings };
  });
}

// --- Handing over ----------------------------------------------------------------------------------

async function ready(business, user, orderId) {
  await access.require(business, 'online_shop.edit');
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    if (order.status === 'ready') return orders.detailIn(db, business, order.id);
    if (order.service !== 'pickup' || order.status !== 'packed') fail(order.service !== 'pickup' ? 'A delivery order goes out for delivery instead' : 'Bill the order before it is ready', 409);
    await db.query("UPDATE shop_orders SET status='ready',ready_at=now(),revision=revision+1,updated_at=now() WHERE id=$1", [order.id]);
    await repo.audit(db, business.id, user.id, 'online_order.ready', order.id, { orderNo: order.order_no });
    await repo.event(db, business.id, user.id, 'online_order.ready', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no });
    return orders.detailIn(db, business, order.id);
  });
}

async function out(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.edit');
  const rider = v.requiredString(body.riderName, 'Who is delivering it', 100);
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    if (order.status === 'out_for_delivery' && order.rider_name === rider) return orders.detailIn(db, business, order.id);
    if (order.service !== 'delivery' || order.status !== 'packed') fail(order.service !== 'delivery' ? 'A pickup order is made ready for pickup instead' : 'Bill the order before it goes out', 409);
    await db.query("UPDATE shop_orders SET status='out_for_delivery',rider_name=$2,out_at=now(),revision=revision+1,updated_at=now() WHERE id=$1", [order.id, rider]);
    await repo.audit(db, business.id, user.id, 'online_order.out_for_delivery', order.id, { orderNo: order.order_no, rider });
    await repo.event(db, business.id, user.id, 'online_order.out_for_delivery', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no });
    return orders.detailIn(db, business, order.id);
  });
}

// Collected or delivered, and paid (the payment recorded on the bill) or put on the customer's account.
async function complete(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.edit');
  await access.require(business, 'sales.edit');
  const requestKey = core.uuid(body.requestKey);
  const onAccount = body.onAccount === true;
  const choice = onAccount ? null : paymentMethods.readChoice(body.payment || {}, 'Paid by', methods);
  const reference = onAccount ? null : v.optionalString(body.payment?.reference, 'Payment reference', 100);
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    if (order.status === 'completed') {
      const same = await repo.one(db, 'SELECT id FROM business_payments WHERE business_id=$1 AND request_key=$2 AND document_id=$3', [business.id, requestKey, order.document_id]);
      if (same || (onAccount && order.paid_by === 'account')) return orders.detailIn(db, business, order.id);
      fail('This order is already completed', 409, { reason: 'completed' });
    }
    if (!['ready', 'out_for_delivery'].includes(order.status)) fail(order.status === 'packed' ? `Mark it ${order.service === 'pickup' ? 'ready for pickup' : 'out for delivery'} first` : 'This order is not with the customer yet', 409);
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, order.document_id]);
    const sums = await repo.one(db, `SELECT COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
      COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
      COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded`, [business.id, doc.id]);
    const due = money.paise(doc.total) - money.paise(sums.returned) - money.paise(sums.paid) + money.paise(sums.refunded);
    let paidBy = 'account';
    if (!onAccount) {
      const { method, methodName } = await paymentMethods.settle(db, business.id, choice, 'Paid by', methods);
      paidBy = method;
      if (due > 0) await core.recordPayment(db, business, user, doc, { amount: (due / 100).toFixed(2), method, methodName, reference, key: requestKey });
    }
    await db.query(`UPDATE shop_orders SET status='completed',paid_by=$2,completed_at=now(),completed_by=$3,revision=revision+1,updated_at=now() WHERE id=$1`, [order.id, paidBy, user.id]);
    await repo.audit(db, business.id, user.id, 'online_order.completed', order.id, { orderNo: order.order_no, paidBy, amount: (due / 100).toFixed(2) });
    await repo.event(db, business.id, user.id, 'online_order.completed', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no, paidBy });
    return orders.detailIn(db, business, order.id);
  });
}

// Refused at the door, or never collected: the bill comes back whole through
// the core's returns (the goods back into stock), and the order is cancelled.
async function refused(business, user, orderId, body = {}) {
  await access.require(business, 'online_shop.cancel');
  await access.require(business, 'sales.refund');
  const reason = v.requiredString(body.reason, 'What happened', 300);
  const requestKey = core.uuid(body.requestKey);
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    if (order.status === 'cancelled' && order.return_id) return orders.detailIn(db, business, order.id);
    if (!['packed', 'ready', 'out_for_delivery'].includes(order.status)) fail('Only a billed order not yet handed over is taken back this way', 409, { reason: 'not_out' });
    const doc = await returns.lockDocument(db, business, order.document_id, 'refund');
    const paid = await repo.one(db, 'SELECT COALESCE(sum(amount),0) AS paid FROM business_payments WHERE business_id=$1 AND document_id=$2', [business.id, doc.id]);
    if (money.paise(paid.paid) > 0) fail('A payment is recorded on this bill: take the goods back from the bill (Sales history), with its refund.', 409, { reason: 'paid' });
    const billLines = await repo.all(db, `SELECT l.id,l.quantity,COALESCE((SELECT sum(r.quantity) FROM business_return_lines r WHERE r.business_id=l.business_id AND r.line_id=l.id),0) AS back
      FROM business_document_lines l WHERE l.business_id=$1 AND l.document_id=$2 ORDER BY l.id`, [business.id, doc.id]);
    const lines = billLines.filter((line) => money.milli(line.quantity) > money.milli(line.back))
      .map((line) => ({ lineId: Number(line.id), quantity: qtyText((money.milli(line.quantity) - money.milli(line.back)) / 1000), restock: true }));
    const input = { reason: `Online order ${order.order_no}: ${reason}`.slice(0, 300), requestKey, lines };
    const saved = await returns.postReturn(db, business, user, doc, { ...input, hash: sha256(input) });
    await db.query(`UPDATE shop_orders SET status='cancelled',cancelled_by='shop',cancel_reason=$2,cancelled_at=now(),cancelled_by_user=$3,return_id=$4,revision=revision+1,updated_at=now()
      WHERE id=$1`, [order.id, reason, user.id, saved.id]);
    await repo.audit(db, business.id, user.id, 'online_order.cancelled', order.id, { orderNo: order.order_no, by: 'shop', reason, returnNo: saved.return_no, refused: true });
    await repo.event(db, business.id, user.id, 'online_order.cancelled', 'online_order', order.id, { locationId: Number(order.location_id), orderNo: order.order_no, by: 'shop', refused: true });
    return orders.detailIn(db, business, order.id);
  });
}

module.exports = { editLine, replace, add, removeLine, ask, answerByGuest, answerByPhone, bill, ready, out, complete, refused, changedLines, SHELF_DAYS };
