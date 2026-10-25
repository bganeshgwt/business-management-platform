const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./laundryCommon');
const money = require('./laundryMoney');
const orders = require('./laundryOrders.service');

// Handing garments over (module "laundry"): the ready garments chosen (every
// ready one unless some are named), with their bill and the money the
// order's rule asks for before they leave.
//
//   the bill    billed at delivery: the garments this handover bills (every
//               garment still in the shop and not billed when the whole order
//               is paid before any garment leaves; the garments handed over
//               when each handover pays for its own), posted by the core at
//               their prices with GST at each item's rate of the day, one line
//               a garment; the advance pays it first. Billed at intake: the
//               bill made then.
//   the money   paid now (cash, UPI, card or bank, in one or several parts):
//               on the bill posted now, or on the order's bills still owed.
//   held        the garments leave only once paid as the order's rule says:
//               the whole order, or the garments handed over. A customer with
//               an account with the shop (credit days or a credit limit on
//               their customer record) may take them with money still owed,
//               on the account: a bailee who has done work on goods may keep
//               them until paid (Indian Contract Act, section 170), and credit
//               agreed with the customer sets that aside.
//   the record  a handover with its garments, its bill, who collected and a
//               note; each garment delivered.
// Money is integer paise.

const { fail } = c;

// What is paid now goes on the order's bills still owed, oldest first; "full"
// is all that is owed. Returns what was paid (paise).
async function payOnBills(db, business, user, order, parts, key) {
  const bills = (await orders.billsOf(db, business, order)).filter((b) => c.paise(b.due) > 0);
  const owed = bills.reduce((sum, b) => sum + c.paise(b.due), 0);
  if (!owed) fail(`Nothing is owed on order ${order.order_no}: there is nothing to pay`);
  const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((sum, p) => sum + c.paise(p.amount), 0);
  if (fixedPaid > owed) fail(`Only ${money.rupees(owed)} is owed on order ${order.order_no}`);
  const settled = await paymentMethods.settleParts(db, business.id, parts);
  const left = bills.map((b) => ({ id: b.id, due: c.paise(b.due) }));
  let paid = 0;
  for (const [index, part] of settled.entries()) {
    let amount = part.amount === 'full' ? owed - fixedPaid : c.paise(part.amount);
    for (const bill of left) {
      if (amount <= 0) break;
      const take = Math.min(amount, bill.due);
      if (take <= 0) continue;
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, bill.id]);
      await core.recordPayment(db, business, user, doc, { amount: money.rupees(take), method: part.method, methodName: part.methodName, reference: part.reference,
        key: c.derivedKey(key, `pay:${index}:${bill.id}`) });
      bill.due -= take; amount -= take; paid += take;
    }
  }
  return paid;
}

// body: { requestKey, itemIds? (every ready garment), payment? | payments? ({ amount | "full", method | methodId, reference? }),
//   onAccount? (money still owed goes on the customer's account), collectedBy?, note?, buyer?: { pan?, panDeclaration? } }
async function deliver(business, user, orderId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.edit');
  const deliveryKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, orderId: String(orderId) });
  const ids = orders.readItemIds(body.itemIds);
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const onAccount = v.requiredBoolean(body.onAccount, 'On the customer\'s account', false);
  const collectedBy = c.optionalText(body.collectedBy, 'Collected by', 150);
  const note = c.optionalText(body.note, 'Note', 500);
  const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    // A retry gives the same handover; the same key with other data is refused.
    const done = await repo.one(db, 'SELECT id,order_id,request_hash FROM laundry_deliveries WHERE business_id=$1 AND request_key=$2', [business.id, deliveryKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.order_id) !== Number(order.id)) fail('This request key was already used for different data', 409);
      return orders.shape(business, await orders.load(db, business, order.id));
    }
    const items = await orders.itemsOf(db, business, order, { lock: true });
    const handing = ids ? orders.pick(items, ids, order) : items.filter((i) => i.status === 'ready');
    if (!handing.length) fail(`No garment of order ${order.order_no} is ready to hand over`, 409);
    for (const item of handing) {
      if (item.status !== 'ready') fail(`Garment ${item.tag_no} is ${c.STATUS_WORDS[item.status]}: only a ready garment is handed over`, 409);
    }
    const whole = order.part_delivery === 'whole_order';
    // The garments this handover bills (an order billed at delivery).
    const toBill = order.bill_at !== 'delivery' ? [] : whole ? items.filter((i) => c.OPEN.includes(i.status) && !i.line_id) : handing.filter((i) => !i.line_id);
    let document = null, advanceUse = 0;
    if (toBill.length) {
      await access.require(business, 'sales.create');
      const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
      const values = money.todayValues(order, toBill);
      for (const { item } of values) {
        if (!item.sku_active) fail(`${item.service_name} is switched off in the catalogue: switch it on again to bill this order`, 409);
        if (item.internal_use) fail(`${item.service_name} is kept for use in services only: untick that on the item to bill this order`, 409);
      }
      const lines = money.billLines(values, settings?.tax_mode || 'exclusive');
      const figures = money.billFigures(values, settings?.rounding);
      if (order.advance_collection_id) {
        const free = await repo.one(db, `SELECT ${orders.FREE_SQL('k')} AS free FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, order.advance_collection_id]);
        advanceUse = Math.min(Math.max(0, c.paise(free.free)), figures.total);
      }
      // What is paid now, after the advance; "full" is what is left.
      const due = figures.total - advanceUse;
      const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((sum, p) => sum + c.paise(p.amount), 0);
      if (fixedPaid > due) fail(`Only ${money.rupees(due)} is left to pay on this bill${advanceUse ? ' after the advance' : ''}`);
      const paidNow = parts.map((p) => (p.amount === 'full' ? { ...p, amount: Number(money.rupees(due - fixedPaid)) } : p)).filter((p) => c.paise(p.amount) > 0);
      const documentBody = { kind: 'sale', locationId: order.location_id, contactId: order.contact_id, lines: lines.map((l) => l.input),
        notes: [`Laundry order ${order.order_no}`, order.express ? 'express' : null, note].filter(Boolean).join(' · ').slice(0, 500),
        buyer: { pan: buyer.pan, panDeclaration: buyer.panDeclaration } };
      document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(deliveryKey, 'bill'), hash, lines: documentBody.lines,
        paidNow, fixed: lines.map((l) => l.fixed) });
      if (c.paise(document.total) !== figures.total) fail(`The bill would come to ${document.total}, not the ${money.rupees(figures.total)} worked out for the garments. Try again.`, 409);
      if (advanceUse > 0) {
        const receipt = await repo.one(db, 'SELECT collection_no,method FROM business_collections WHERE business_id=$1 AND id=$2', [business.id, order.advance_collection_id]);
        await core.recordPayment(db, business, user, document, { amount: money.rupees(advanceUse), method: receipt.method, reference: receipt.collection_no,
          key: c.derivedKey(deliveryKey, 'advance'), collectionId: order.advance_collection_id });
      }
      const lineRows = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
      if (lineRows.length !== lines.length) fail('The bill does not have a line for each garment. Try again.', 409);
      for (const [index, line] of lines.entries()) {
        await db.query('UPDATE laundry_order_items SET document_id=$3,line_id=$4 WHERE business_id=$1 AND id=$2', [business.id, line.item.id, document.id, lineRows[index].id]);
      }
    } else if (parts.length) {
      await payOnBills(db, business, user, order, parts, deliveryKey);
    }
    // What is still owed that the order's rule asks for before these garments leave.
    const bills = await orders.billsOf(db, business, order);
    let owed;
    if (whole) {
      owed = bills.reduce((sum, b) => sum + Math.max(0, c.paise(b.due)), 0);
    } else if (order.bill_at === 'delivery') {
      owed = document ? Math.max(0, c.paise(bills.find((b) => Number(b.id) === Number(document.id)).due)) : 0;
    } else {
      // Billed at intake, each handover paying for its garments: the garments
      // delivered so far and these, at their charge less what was credited on
      // them, against what was paid on the bill.
      const bill = bills[0];
      const handed = new Set(handing.map((i) => Number(i.id)));
      const value = items.filter((i) => i.status === 'delivered' || handed.has(Number(i.id)))
        .reduce((sum, i) => sum + c.paise(i.net) + c.paise(i.tax) - c.paise(i.credited || 0), 0);
      const paid = c.paise(bill.paid) - c.paise(bill.refunded);
      owed = Math.min(Math.max(0, c.paise(bill.due)), Math.max(0, value - paid));
    }
    if (owed > 0) {
      const account = await repo.one(db, 'SELECT (credit_days>0 OR COALESCE(credit_limit,0)>0) AS has FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, order.contact_id]);
      if (!onAccount) {
        fail(`${money.rupees(owed)} is still to pay ${whole ? `on order ${order.order_no}` : 'for these garments'}: they are held until it is paid${account.has ? ', or hand them over on the customer\'s account' : ''}`,
          409, { reason: 'unpaid', owed: money.rupees(owed), account: account.has });
      }
      if (!account.has) {
        fail(`${order.customer_name} has no account with the shop (credit days or a credit limit on their customer record): the garments are held until ${money.rupees(owed)} is paid`,
          409, { reason: 'no_account', owed: money.rupees(owed) });
      }
    }
    const delivery = await repo.one(db, `INSERT INTO laundry_deliveries(business_id,order_id,document_id,on_account,collected_by,note,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [business.id, order.id, document?.id || null, owed > 0, collectedBy, note, deliveryKey, hash, user.id]);
    for (const item of handing) {
      await db.query('INSERT INTO laundry_delivery_items(business_id,delivery_id,order_id,item_id) VALUES($1,$2,$3,$4)', [business.id, delivery.id, order.id, item.id]);
      await db.query("UPDATE laundry_order_items SET status='delivered',delivered_at=now(),delivered_by=$3 WHERE business_id=$1 AND id=$2", [business.id, item.id, user.id]);
      await orders.history(db, business, user, order, item, 'ready', 'delivered', null);
    }
    const tags = handing.map((i) => i.tag_no);
    // The history names the bill and the receipt, not the amounts.
    await orders.history(db, business, user, order, null, null, null, [`Handed over: ${c.plural(handing.length, 'garment')} (tag ${tags.join(', ')})`,
      document ? `bill ${document.document_no}` : null, advanceUse > 0 ? 'the advance taken off' : null, owed > 0 ? 'the rest on the customer\'s account' : null,
      collectedBy ? `collected by ${collectedBy}` : null, note].filter(Boolean).join(' · '));
    const figures = { orderNo: order.order_no, deliveryId: delivery.id, tags, documentNo: document?.document_no || null, billTotal: document?.total || null,
      advanceUsed: money.rupees(advanceUse), onAccount: owed > 0, owedOnAccount: money.rupees(owed) };
    await repo.audit(db, business.id, user.id, 'laundry_order.delivered', order.id, figures);
    await repo.event(db, business.id, user.id, 'laundry_order.delivered', 'laundry_order', order.id, { ...figures, documentId: document?.id || null, itemIds: handing.map((i) => i.id) });
    return orders.shape(business, await orders.load(db, business, order.id));
  });
}

module.exports = { deliver };
