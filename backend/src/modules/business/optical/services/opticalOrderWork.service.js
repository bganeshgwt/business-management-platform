const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./opticalCommon');
const o = require('./opticalOrders.service');

// What happens to a spectacle order between booking and delivery, beside its
// steps (module "optical", optical shops):
//
//   change    while it is booked (before the lab or the workshop), its frame,
//             lenses, other items and discount are changed by someone who may
//             manage orders (optical.manage): the lines are priced again by
//             the core as a sale of them would be now, and the change is kept
//             in the activity log with what was and what is. The advances
//             taken never come to more than the new total.
//   hold      the frame from stock held for the order: its stock lot never
//             goes below what is held (a database trigger), so no bill,
//             transfer, count or adjustment takes it; released by hand, when
//             the frame is changed or the order cancelled, or delivered.
//   advance   another advance on an open order: a numbered collection receipt
//             in the customer's name; together they never pass the total.
//   workshop  the workshop's steps in order, each kept with who did it and
//             when: cutting, edging, fitting (a step may be skipped when the
//             lab did it, never done out of order). The quality check after
//             the workshop needs the fitting.

const { fail } = c;
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// --- Changing a booked order -------------------------------------------------------------------

// The lines in words, for the activity log: "frame: Titan …", "right lens: progressive (Essilor …)".
async function lineWords(db, business, orderId) {
  const lines = await repo.all(db, `SELECT part,eye,label,description,lens_type,quantity FROM optical_order_lines WHERE business_id=$1 AND order_id=$2
    ORDER BY CASE part WHEN 'frame' THEN 0 WHEN 'lens' THEN 1 ELSE 2 END, CASE eye WHEN 'right' THEN 0 ELSE 1 END, id`, [business.id, orderId]);
  return lines.map((l) => {
    const what = l.part === 'lens' ? [c.LENS_WORDS[l.lens_type], l.label ? `(${l.label})` : null].filter(Boolean).join(' ') : l.label || l.description;
    return `${l.part === 'lens' ? `${l.eye} lens` : l.part}: ${what}${l.part === 'item' && Number(l.quantity) !== 1 ? ` × ${Number(l.quantity)}` : ''}`;
  });
}

// body: { frame, lenses, items?, discount?, measurements?, reason? } — the
// frame, lenses and items as at booking (from the catalogue); measurements
// left out stay as they are.
async function change(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.manage');
  await access.require(business, 'sales.create');
  const frame = o.readFrame(body.frame);
  const lenses = o.readLenses(body.lenses);
  const items = o.readItems(body.items);
  const discount = o.readDiscount(body);
  const reason = c.optionalText(body.reason, 'Why it is changed', 300);
  if (frame.quotationLineId || lenses.some((l) => l.quotationLineId)) fail('A change picks its items from the catalogue: the quotation\'s lines went on the order when it was booked');
  return repo.transaction(async (db) => {
    const order = await o.lockOrder(db, business, orderId);
    if (order.status !== 'booked') {
      fail(`Spectacle order ${order.order_no} is ${c.STATUS_WORDS[order.status]}: its frame, lenses and prices change only while it is booked, before it goes to the lab or the workshop`, 409);
    }
    const contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, order.contact_id]);
    const fitting = body.measurements === undefined ? { pdRight: order.pd_right, pdLeft: order.pd_left, heightRight: order.fitting_height_right, heightLeft: order.fitting_height_left,
      frameA: order.frame_a, frameB: order.frame_b, frameDbl: order.frame_dbl } : o.readFitting(body.measurements);
    await o.applyLensItems(db, business, lenses);
    o.checkLenses({ rows: order.rx.rows }, lenses, fitting);
    const free = Boolean(order.remake_of && order.remake_cost_by !== 'customer');
    if (free && discount) fail('A remake the shop or the lab bears costs the customer nothing: it takes no discount');
    const next = { frame, lenses, items };
    const priced = o.pricedInputs(next);
    if (!priced.length && !free) fail('Put the price on the order: a frame from stock, a lens item, or another item such as the lab\'s lens charge');
    await o.checkItems(db, business, priced);
    const quoted = await o.price(db, business, user, { locationId: order.location_id, contact, priced, discount, free });
    const taken = (await o.advancesOf(db, business, order.id)).reduce((sum, a) => sum + o.paise(a.amount), 0);
    if (taken > o.paise(quoted.total)) {
      fail(`The advances taken on ${order.order_no} (${o.rupees(taken)}) come to more than the new total of ${quoted.total}: keep the order as it is, or cancel it and hand the advance back`, 409);
    }
    const before = await lineWords(db, business, order.id);
    await db.query('DELETE FROM optical_order_lines WHERE business_id=$1 AND order_id=$2', [business.id, order.id]);
    await o.insertLines(db, business, order.id, next, quoted);
    // A frame held for the order goes back to stock when the frame changes.
    const held = await repo.one(db, `SELECT l.sku_id FROM optical_frame_holds h JOIN business_stock_lots l ON l.business_id=h.business_id AND l.id=h.lot_id
      WHERE h.business_id=$1 AND h.order_id=$2 AND h.status='held'`, [business.id, order.id]);
    const released = held && Number(held.sku_id) !== Number(frame.skuId) ? await closeHold(db, business, user, order, 'released', 'Frame changed') : null;
    await db.query(`UPDATE optical_orders SET tax_mode=$3,subtotal=$4,tax=$5,round_off=$6,total=$7,savings=$8,discount_amount=$9,discount_percent=$10,discount_reason=$11,
      pd_right=$12,pd_left=$13,fitting_height_right=$14,fitting_height_left=$15,frame_a=$16,frame_b=$17,frame_dbl=$18,updated_by=$19,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, order.id, quoted.taxMode, quoted.subtotal, quoted.tax, quoted.roundOff, quoted.total, quoted.savings, discount?.amount ?? null, discount?.percent ?? null,
      discount ? discount.reason : null, fitting.pdRight, fitting.pdLeft, fitting.heightRight, fitting.heightLeft, fitting.frameA, fitting.frameB, fitting.frameDbl, user.id]);
    const after = await lineWords(db, business, order.id);
    if (JSON.stringify(before) !== JSON.stringify(after) || o.paise(order.total) !== o.paise(quoted.total)) {
      await repo.audit(db, business.id, user.id, 'spectacle_order.changed', order.id, { orderNo: order.order_no, ...(reason ? { reason } : {}),
        from: { lines: before, total: order.total }, to: { lines: after, total: quoted.total } });
      await repo.event(db, business.id, user.id, 'spectacle_order.changed', 'spectacle_order', order.id, { orderNo: order.order_no, from: order.total, to: quoted.total,
        lines: quoted.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, unit: l.enteredUnit || l.unit })) });
      // The history names no amounts: someone who does not see sales reads it too.
      await o.history(db, business, user, order, 'booked', 'booked', [`Frame and lenses changed${reason ? `: ${reason}` : ''}`, released ? 'the frame held for it went back to stock' : null]
        .filter(Boolean).join(' · '));
    }
    return o.shape(business, await o.load(db, business, order.id));
  });
}

// --- The frame held in stock -------------------------------------------------------------------------

// Holds the order's frame in a usable lot at its location with one free (the
// lot named, or the oldest expiry first). Inside the caller's transaction.
async function holdInside(db, business, user, order, { lotCode = null } = {}) {
  const frame = await repo.one(db, `SELECT l.sku_id,s.label FROM optical_order_lines l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    WHERE l.business_id=$1 AND l.order_id=$2 AND l.part='frame'`, [business.id, order.id]);
  if (!frame) fail('Only a frame from stock is held for an order');
  const lot = c.optionalText(lotCode, 'Batch or serial number', 100);
  const today = await c.today(db, business);
  const lots = await repo.all(db, `SELECT l.id,l.lot_code,l.quantity-COALESCE((SELECT sum(h.quantity) FROM optical_frame_holds h WHERE h.lot_id=l.id AND h.status='held'),0) AS free
    FROM business_stock_lots l WHERE l.business_id=$1 AND l.location_id=$2 AND l.sku_id=$3 AND (l.expires_on IS NULL OR l.expires_on >= $4::date)
      AND ($5::text IS NULL OR l.lot_code=$5) ORDER BY l.expires_on NULLS LAST,l.id FOR UPDATE OF l`, [business.id, order.location_id, frame.sku_id, today, lot]);
  const chosen = lots.find((l) => Number(l.free) >= 1);
  if (!chosen) fail(`No ${frame.label}${lot ? ` (${lot})` : ''} is free in stock here to hold for ${order.order_no}: receive one first`, 409);
  return repo.one(db, 'INSERT INTO optical_frame_holds(business_id,order_id,lot_id,quantity,held_by) VALUES($1,$2,$3,1,$4) RETURNING *', [business.id, order.id, chosen.id, user.id]);
}

// Closes the order's hold, if it has one: released (back to stock) or
// delivered (its frame leaves on the bill). Answers the hold, with its lot.
async function closeHold(db, business, user, order, status, reason) {
  const hold = await repo.one(db, `SELECT h.*,l.lot_code,l.sku_id FROM optical_frame_holds h JOIN business_stock_lots l ON l.business_id=h.business_id AND l.id=h.lot_id
    WHERE h.business_id=$1 AND h.order_id=$2 AND h.status='held' FOR UPDATE OF h`, [business.id, order.id]);
  if (!hold) return null;
  await db.query('UPDATE optical_frame_holds SET status=$3,closed_by=$4,closed_at=now(),close_reason=$5 WHERE business_id=$1 AND id=$2', [business.id, hold.id, status, user.id, reason]);
  return hold;
}

// body: { hold: true, lotCode? } | { hold: false, reason? }. Asking again for what is so already answers the order as it is.
async function setHold(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.edit');
  const hold = v.requiredBoolean(body.hold, 'Hold the frame');
  const reason = c.optionalText(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const order = await o.lockOrder(db, business, orderId);
    o.requireOpen(order);
    const active = await repo.one(db, "SELECT id FROM optical_frame_holds WHERE business_id=$1 AND order_id=$2 AND status='held'", [business.id, order.id]);
    if (hold && !active) {
      const made = await holdInside(db, business, user, order, { lotCode: body.lotCode });
      const lot = await repo.one(db, 'SELECT lot_code FROM business_stock_lots WHERE business_id=$1 AND id=$2', [business.id, made.lot_id]);
      await o.history(db, business, user, order, order.status, order.status, `Frame held in stock${lot.lot_code ? ` (${lot.lot_code})` : ''}`);
      await repo.audit(db, business.id, user.id, 'spectacle_order.frame_held', order.id, { orderNo: order.order_no, lotCode: lot.lot_code || null });
    } else if (!hold && active) {
      await closeHold(db, business, user, order, 'released', reason || 'Released by hand');
      await o.history(db, business, user, order, order.status, order.status, `Frame hold released${reason ? `: ${reason}` : ''}`);
      await repo.audit(db, business.id, user.id, 'spectacle_order.frame_released', order.id, { orderNo: order.order_no, ...(reason ? { reason } : {}) });
    }
    return o.shape(business, await o.load(db, business, order.id));
  });
}

// --- More advances ------------------------------------------------------------------------------------

// body: { requestKey, amount, method | methodId, reference? }
async function addAdvance(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.edit');
  await access.require(business, 'sales.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = o.hashOf({ ...body, orderId: String(orderId) });
  const advance = await o.readAdvance(business, body);
  if (!advance) fail('Give the amount of the advance');
  return repo.transaction(async (db) => {
    const order = await o.lockOrder(db, business, orderId);
    // A retry gives the same advance; the same key with other data is refused.
    const old = await repo.one(db, `SELECT k.request_hash,a.order_id FROM business_collections k LEFT JOIN optical_order_advances a ON a.business_id=k.business_id AND a.collection_id=k.id
      WHERE k.business_id=$1 AND k.request_key=$2`, [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || String(old.order_id) !== String(order.id)) fail('This request key was already used for different data', 409);
      return o.shape(business, await o.load(db, business, order.id));
    }
    o.requireOpen(order);
    if (order.remake_of && order.remake_cost_by !== 'customer') fail('A remake the shop or the lab bears costs the customer nothing: it takes no advance');
    const taken = (await o.advancesOf(db, business, order.id)).reduce((sum, a) => sum + o.paise(a.amount), 0);
    if (taken + o.paise(advance.amount) > o.paise(order.total)) fail(`The advances are part of the order's total: at most ${o.rupees(Math.max(0, o.paise(order.total) - taken))} more`);
    const contact = await repo.one(db, 'SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, order.contact_id]);
    const collection = await o.newReceipt(db, business, user, { locationId: order.location_id, orderNo: order.order_no, contact, advance, key: requestKey, hash });
    await o.linkAdvance(db, business, user, order, collection);
    await o.history(db, business, user, order, order.status, order.status, `Advance taken (${collection.collection_no})`);
    await repo.audit(db, business.id, user.id, 'spectacle_order.advance_taken', order.id, { orderNo: order.order_no, collectionNo: collection.collection_no, amount: collection.amount });
    return o.shape(business, await o.load(db, business, order.id));
  });
}

// --- The workshop's steps ------------------------------------------------------------------------------

// body: { step: cutting | edging | fitting, note? } — on an order in the
// workshop. A step done already on this visit is not kept twice.
async function workshopStep(business, user, orderId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.edit');
  const step = v.requiredEnum(body.step, 'Workshop step', c.WORKSHOP_STEPS);
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const order = await o.lockOrder(db, business, orderId);
    o.requireOpen(order);
    if (order.status !== 'in_workshop') fail(`Spectacle order ${order.order_no} is ${c.STATUS_WORDS[order.status]}: the workshop's steps are kept while it is in the workshop`, 409);
    const steps = await o.visitSteps(db, business, order.id);
    if (!steps.some((s) => s.step === step)) {
      const last = Math.max(-1, ...steps.map((s) => c.WORKSHOP_STEPS.indexOf(s.step)));
      if (c.WORKSHOP_STEPS.indexOf(step) < last) fail(`${capital(step)} comes before ${c.WORKSHOP_STEPS[last]}, which is done already on ${order.order_no}`, 409);
      await o.history(db, business, user, order, 'in_workshop', 'in_workshop', `${capital(step)} done${note ? `: ${note}` : ''}`, step);
      await repo.audit(db, business.id, user.id, 'spectacle_order.workshop_step', order.id, { orderNo: order.order_no, step, ...(note ? { note } : {}) });
      await repo.event(db, business.id, user.id, 'spectacle_order.workshop_step', 'spectacle_order', order.id, { orderNo: order.order_no, step });
    }
    return o.shape(business, await o.load(db, business, order.id));
  });
}

module.exports = { change, setHold, holdInside, closeHold, addAdvance, workshopStep };
