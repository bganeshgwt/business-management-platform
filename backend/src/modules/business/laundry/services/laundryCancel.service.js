const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const c = require('./laundryCommon');
const orders = require('./laundryOrders.service');
// Advance refunds and the manager's PIN (shared with the salon, repairs, opticians and garages).
const refunds = () => require('../../salon-weight/services/businessAdvanceRefunds');
const pins = () => require('../../salon-weight/services/businessManagerPin');

// Cancelling garments (module "laundry"): some of an order's garments still
// in the shop, or all of them (the whole order), with a reason.
//
//   not billed  the garments are cancelled; an advance stays the customer's,
//               handed back from the order once nothing is left on it to bill
//               (a manager's PIN), or kept on their account.
//   billed      each garment's bill line is credited in full, one credit note
//               a bill (a line a package paid for in full charged nothing and
//               needs none; the core's credit note, GST in the line's own
//               proportion). What the customer paid beyond what is then due on
//               the bill goes back when asked, through the core's refund, with
//               a manager's approval and PIN; otherwise it stays to their
//               credit on the bill.
// What a package paid for a cancelled garment goes back into the package. The
// order's figures then follow the garments left.
// Money is integer paise.

const { fail } = c;

// body: { requestKey, reason, itemIds? (every garment still in the shop), refund?: { method | methodId, reference? },
//   approval?: { approverId?, pin? } (with a refund) }
async function cancel(business, user, orderId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.cancel');
  const requestKey = core.uuid(body.requestKey);
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  const ids = orders.readItemIds(body.itemIds);
  const how = body.refund && typeof body.refund === 'object' && !Array.isArray(body.refund) ? body.refund : null;
  if (how) await access.require(business, 'laundry.refund');
  // A manager's PIN is checked before the transaction (a PIN check holds no locks).
  const approval = how ? await pins().readApproval(business, user, { ...(body.approval || {}), reason }, 'laundry.refund', { reasonLabel: 'Reason' }) : null;
  const hash = c.hashOf({ ...body, approval: undefined, orderId: String(orderId) });
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    const items = await orders.itemsOf(db, business, order, { lock: true });
    // Asking again is the same cancellation; the same key with other data is refused.
    const again = items.filter((i) => i.cancel_key === requestKey);
    if (again.length) {
      const named = ids ? [...ids].sort((a, b) => a - b).join(',') : null;
      if ((named && again.map((i) => Number(i.id)).sort((a, b) => a - b).join(',') !== named) || again.some((i) => i.cancel_reason !== reason)) {
        fail('This request key was already used for different data', 409);
      }
      return orders.shape(business, await orders.load(db, business, order.id));
    }
    const cancelling = ids ? orders.pick(items, ids, order) : items.filter((i) => c.OPEN.includes(i.status));
    if (!cancelling.length) fail(`Nothing on order ${order.order_no} is left in the shop to cancel`, 409);
    for (const item of cancelling) {
      if (!c.OPEN.includes(item.status)) fail(`Garment ${item.tag_no} is ${c.STATUS_WORDS[item.status]}: only a garment still in the shop is cancelled`, 409);
      if (item.claim_open) fail(`Garment ${item.tag_no} has a damage claim waiting: decide it first`, 409);
      if (item.line_id && c.paise(item.credited) > 0) fail(`Garment ${item.tag_no} was credited on a damage claim, so its charge is settled: it is not cancelled`, 409);
      if (Number(item.pieces_delivered) > 0) fail(`Garment ${item.tag_no} has pieces handed over already: hand over the rest`, 409);
    }
    // Billed garments: each bill's lines credited in full on one credit note.
    const byBill = new Map();
    for (const item of cancelling.filter((i) => i.line_id && c.paise(i.net) + c.paise(i.tax) > 0)) byBill.set(Number(item.document_id), [...(byBill.get(Number(item.document_id)) || []), item]);
    const settled = [];
    for (const [documentId, list] of byBill) {
      const creditKey = c.derivedKey(requestKey, `credit:${documentId}`);
      for (const item of list) await db.query('UPDATE laundry_order_items SET credit_key=$3 WHERE business_id=$1 AND id=$2', [business.id, item.id, creditKey]);
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, documentId]);
      const lines = await repo.all(db, 'SELECT id,net,tax FROM business_document_lines WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, list.map((i) => i.line_id)]);
      const tags = list.map((i) => i.tag_no).join(', ');
      const words = `Laundry order ${order.order_no}: garment${list.length === 1 ? '' : 's'} ${tags} cancelled. ${reason}`.slice(0, 300);
      const returnBody = { reason: words, lines: lines.map((l) => ({ lineId: l.id })), hash };
      const creditNote = await returns.postReturn(db, business, user, doc, { reason: words, requestKey: creditKey, hash: c.hashOf(returnBody), lines: returnBody.lines,
        values: new Map(lines.map((l) => [Number(l.id), c.paise(l.net) + c.paise(l.tax)])) });
      // What the customer paid beyond what is now due on the bill goes back, when asked.
      let refund = null;
      if (how) {
        const [bill] = (await orders.billsOf(db, business, order)).filter((b) => Number(b.id) === documentId);
        const back = Math.max(0, Math.min(-c.paise(bill.due), c.paise(creditNote.total)));
        if (back > 0) {
          const input = returns.readRefund({ amount: c.rupees(back), method: how.method, methodId: how.methodId, reason: words, requestKey: c.derivedKey(requestKey, `refund:${documentId}`) });
          refund = await returns.postRefund(db, business, user, doc, input);
        }
      }
      settled.push({ documentNo: doc.document_no, returnNo: creditNote.return_no, credit: creditNote.total, refund: refund ? refund.amount : null, refundMethod: refund?.method || null });
    }
    for (const item of cancelling) {
      await db.query(`UPDATE laundry_order_items SET status='cancelled',rack=NULL,cancel_reason=$3,cancelled_by=$4,cancelled_at=now(),cancel_key=$5 WHERE business_id=$1 AND id=$2`,
        [business.id, item.id, reason, user.id, requestKey]);
      await orders.history(db, business, user, order, item, item.status, 'cancelled', reason);
    }
    await orders.refigure(db, business, user, order);
    const tags = cancelling.map((i) => i.tag_no);
    await orders.history(db, business, user, order, null, null, null, [`Cancelled: ${c.plural(cancelling.length, 'garment')} (tag ${tags.join(', ')})`,
      ...settled.map((s) => `credit note ${s.returnNo} on ${s.documentNo}${s.refund ? ', the money refunded' : ''}`)].join(' · '));
    const details = { orderNo: order.order_no, tags, reason, credits: settled, ...(approval ? { approvedBy: approval.approver.name, requestedBy: user.id } : {}) };
    await repo.audit(db, business.id, approval?.approver.id || user.id, 'laundry_order.cancelled', order.id, details);
    await repo.event(db, business.id, user.id, 'laundry_order.cancelled', 'laundry_order', order.id, { orderNo: order.order_no, itemIds: cancelling.map((i) => i.id), credits: settled,
      approvedBy: approval?.approver.id || null });
    return orders.shape(business, await orders.load(db, business, order.id));
  });
}

// The advance of an order with nothing left on it to bill (or what is left of
// the advance), handed back by cash, UPI or bank, with a reason and a
// manager's PIN (sales.refund); a numbered refund with a receipt.
// body: { amount? (all that is left), method | methodId, reference?, reason, approverId?, pin?, requestKey }
async function refundAdvance(business, user, orderId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  await access.require(business, 'sales.edit');
  const input = refunds().readRefund(body);
  const approval = await pins().readApproval(business, user, body, 'sales.refund', { reasonLabel: 'Reason for the refund' });
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    if (!order.advance_collection_id) fail(`Order ${order.order_no} has no advance`, 409);
    const items = await orders.itemsOf(db, business, order);
    if (items.some((i) => c.OPEN.includes(i.status) && !i.line_id)) {
      fail(`Order ${order.order_no} still has garments to bill: the advance comes off their bill when they are handed over. Cancel them first to hand it back.`, 409);
    }
    const { refund, repeated } = await refunds().refundCollection(db, business, user, { collectionId: order.advance_collection_id, contactId: order.contact_id, input, approval,
      source: 'laundry', label: order.order_no });
    if (!repeated) await orders.history(db, business, user, order, null, null, null, `Advance handed back (${refund.refund_no}) — ${approval.reason}`);
    return { ...refund, order_no: order.order_no, repeated };
  });
}

module.exports = { cancel, refundAdvance };
