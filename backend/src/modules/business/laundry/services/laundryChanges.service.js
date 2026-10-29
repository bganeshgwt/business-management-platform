const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const c = require('./laundryCommon');
const money = require('./laundryMoney');
const pricing = require('./laundryPricing');
const orders = require('./laundryOrders.service');

// An order changed after intake (module "laundry"):
//   garments added   to an order with garments still in the shop, priced as
//                    at intake (the customer's prices, express as the order
//                    was taken in, a package, an offer running now, a
//                    discount), each with its tag; an order billed at intake
//                    bills them on a bill of their own, paid now or later.
//   a garment changed  before its work starts (received), by a manager
//                    (laundry.cancel): its service, its price (one typed, in
//                    place of the list's) or its quantity, with the reason and
//                    what it was and became kept. Billed: its old line is
//                    credited in full on a credit note, the changed garment is
//                    billed on a bill of its own, and what the customer had
//                    paid on the old bill beyond what is due there pays the new
//                    one first (no money moves for it).
// The order's figures then follow its garments. Money is integer paise.

const { fail, id } = c;

// body: { requestKey, items: [as at intake], discount?: { percent | amount, reason }, payment? | payments? (billed at intake), buyer? }
async function addGarments(business, user, orderId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, orderId: String(orderId) });
  const input = pricing.readGarments(body, orders.MAX_ITEMS);
  const parts = core.readPayments(body);
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    const old = await repo.one(db, 'SELECT order_id,request_hash FROM laundry_order_additions WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || Number(old.order_id) !== Number(order.id)) fail('This request key was already used for different data', 409);
      return orders.shape(business, await orders.load(db, business, order.id));
    }
    const items = await orders.itemsOf(db, business, order);
    if (!items.some((i) => c.OPEN.includes(i.status))) fail(`Order ${order.order_no} has no garment left in the shop: take in a new order`, 409);
    if (items.length + input.items.length > orders.MAX_ITEMS) fail(`An order takes at most ${orders.MAX_ITEMS} garments: take in the rest on another order`);
    const intake = order.bill_at === 'intake';
    if (intake) await access.require(business, 'sales.create');
    if (parts.length) {
      if (!intake) fail(`Order ${order.order_no} is billed at delivery: the garments are paid for when they are handed over`);
      await access.require(business, 'sales.edit');
    }
    const contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, order.contact_id]);
    const location = { id: order.location_id };
    const priced = await pricing.priceGarments(db, business, input.items, { contactId: order.contact_id, locationId: order.location_id,
      expressPercent: Number(order.express_percent), discount: input.discount });
    const tags = await orders.assignTags(db, business, priced.items);
    let document = null, lineIds = [];
    if (intake) {
      ({ document, lineIds } = await orders.billGarments(db, business, user, { contact, location, priced, tags, requestKey: c.derivedKey(requestKey, 'bill'), parts,
        buyer: body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {},
        words: [`Laundry order ${order.order_no}: garments added`, order.express ? 'express' : null].filter(Boolean).join(' · ') }));
    }
    const addition = await repo.one(db, `INSERT INTO laundry_order_additions(business_id,order_id,document_id,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [business.id, order.id, document?.id || null, requestKey, hash, user.id]);
    const seq = Math.max(0, ...items.map((i) => Number(i.seq))) + 1;
    await orders.insertGarments(db, business, order, priced, { tags, seqFrom: seq, document, lineIds, addition, user });
    await orders.refigure(db, business, user, order);
    const pieces = priced.items.reduce((s, p) => s + p.pieces, 0);
    await orders.history(db, business, user, order, null, null, null, [`Added: ${c.plural(priced.items.length, 'garment')} (${c.plural(pieces, 'piece')}, tag ${tags.join(', ')})`,
      document ? `bill ${document.document_no}` : null].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'laundry_order.garments_added', order.id, { orderNo: order.order_no, tags, garments: priced.items.length, pieces,
      value: money.rupees(priced.figures.total), ...(document ? { documentNo: document.document_no } : {}) });
    await repo.event(db, business.id, user.id, 'laundry_order.garments_added', 'laundry_order', order.id, { orderNo: order.order_no, additionId: addition.id,
      documentId: document?.id || null, tags });
    return orders.shape(business, await orders.load(db, business, order.id));
  });
}

// body: { requestKey, reason, serviceId?, price? (a manager's price for one, a kilo or a square foot), quantity?, pieces?, length?, width?,
//   packageId? (null: none), discount?: { percent | amount } (the change's reason is its reason), payment? | payments? (its new bill), buyer? }
async function changeGarment(business, user, orderId, itemId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.cancel');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, orderId: String(orderId), itemId: String(itemId) });
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason for the change', 300);
  const rate = c.given(body.price) ? core.decimal(body.price, 'Price', 2, 0.01, 1000000) : null;
  const discount = pricing.readDiscount(body.discount, 'Discount');
  const parts = core.readPayments(body);
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    const done = await repo.one(db, 'SELECT order_id,request_hash FROM laundry_item_changes WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.order_id) !== Number(order.id)) fail('This request key was already used for different data', 409);
      return orders.shape(business, await orders.load(db, business, order.id));
    }
    const item = (await orders.itemsOf(db, business, order, { lock: true })).find((i) => Number(i.id) === Number(id(itemId, 'Garment')));
    if (!item) fail(`That garment is not on order ${order.order_no}`, 404);
    if (item.status !== 'received') fail(`Garment ${item.tag_no} is ${c.STATUS_WORDS[item.status]}: a garment is changed only before its work starts`, 409);
    if (item.claim_open) fail(`Garment ${item.tag_no} has a damage claim waiting: decide it first`, 409);
    if (item.line_id && c.paise(item.credited) > 0) fail(`Garment ${item.tag_no} was credited on a damage claim: it is not changed`, 409);
    const billed = Boolean(item.line_id);
    if (billed) await access.require(business, 'sales.create');
    if (parts.length) {
      if (!billed) fail(`Garment ${item.tag_no} is billed when it is handed over: nothing is paid for the change now`);
      await access.require(business, 'sales.edit');
    }
    const keepPackage = body.packageId === undefined ? (item.package_id ? Number(item.package_id) : null) : c.given(body.packageId) ? id(body.packageId, 'Package') : null;
    const ask = {
      garmentTypeId: Number(item.garment_type_id), serviceId: c.given(body.serviceId) ? id(body.serviceId, 'Service') : Number(item.service_id),
      quantity: body.quantity !== undefined ? body.quantity : item.per === 'item' ? String(Number(item.quantity)) : item.quantity, pieces: body.pieces ?? (body.quantity !== undefined && item.per === 'item' ? undefined : item.pieces),
      length: body.length ?? item.length_ft ?? undefined, width: body.width ?? item.width_ft ?? undefined, packageId: keepPackage, discount,
    };
    // What the garment drew from its package goes back to it first.
    const heldBack = item.package_id ? { [item.package_id]: Number(item.package_quantity) } : {};
    const priced = await pricing.priceGarments(db, business, [ask], { contactId: order.contact_id, locationId: order.location_id,
      expressPercent: Number(order.express_percent), rate, heldBack });
    const p = priced.items[0];
    const row = pricing.garmentRow(p);
    const fields = ['service_id', 'service_name', 'sku_id', 'per', 'quantity', 'pieces', 'length_ft', 'width_ft', 'rate', 'base', 'surcharge', 'amount', 'tax_rate', 'net', 'tax',
      'price_source', 'price_override_id', 'package_id', 'package_quantity', 'package_amount', 'offer_id', 'offer_name', 'offer_percent', 'offer_amount', 'discount_amount'];
    const shown = (x) => ({ service: x.service_name, per: x.per, quantity: String(Number(x.quantity)), pieces: Number(x.pieces), rate: Number(x.rate).toFixed(2),
      charge: money.rupees(c.paise(x.net) + c.paise(x.tax)), ...(x.package_id ? { package: String(Number(x.package_quantity)) } : {}),
      ...(x.length_ft ? { size: `${Number(x.length_ft)} × ${Number(x.width_ft)} ft` } : {}) });
    const was = shown(item);
    const became = shown({ ...row, net: row.net, tax: row.tax });
    const blank = (x) => x === null || x === undefined || x === '';
    const same = (a, b) => (blank(a) || blank(b) ? blank(a) && blank(b) : Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) === Number(b) : String(a) === String(b));
    if (fields.every((f) => same(row[f], item[f]))) fail(`Garment ${item.tag_no} is already priced so: nothing changes`, 409);
    let creditNote = null, document = null, lineIds = [], moved = 0;
    if (billed) {
      // The old line credited in full (a line a package paid for in full charged nothing and needs none), the changed garment billed on its own bill.
      const oldDoc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, item.document_id]);
      const line = await repo.one(db, 'SELECT id,net,tax FROM business_document_lines WHERE business_id=$1 AND id=$2', [business.id, item.line_id]);
      const words = `Laundry order ${order.order_no}, garment ${item.tag_no}: changed. ${reason}`.slice(0, 300);
      if (c.paise(line.net) + c.paise(line.tax) > 0) {
        const creditKey = c.derivedKey(requestKey, 'credit');
        await db.query('UPDATE laundry_order_items SET credit_key=$3 WHERE business_id=$1 AND id=$2', [business.id, item.id, creditKey]);
        const returnBody = { reason: words, lines: [{ lineId: line.id }], hash };
        creditNote = await returns.postReturn(db, business, user, oldDoc, { reason: words, requestKey: creditKey, hash: c.hashOf(returnBody), lines: returnBody.lines,
          values: new Map([[Number(line.id), c.paise(line.net) + c.paise(line.tax)]]) });
      }
      const contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, order.contact_id]);
      ({ document, lineIds } = await orders.billGarments(db, business, user, { contact, location: { id: order.location_id }, priced: { ...priced, items: [p] },
        tags: [item.tag_no], requestKey: c.derivedKey(requestKey, 'bill'), parts, buyer: body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {},
        words: `Laundry order ${order.order_no}: garment ${item.tag_no} changed` }));
      // What the customer paid on the old bill beyond what is due there now pays the new one first.
      const freshOld = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, oldDoc.id]);
      moved = await returns.moveCredit(db, business, user, freshOld, document, { reason: `Garment ${item.tag_no} of laundry order ${order.order_no} changed: paid on ${oldDoc.document_no}`,
        requestKey: c.derivedKey(requestKey, 'move') });
    }
    await db.query(`INSERT INTO laundry_item_changes(business_id,order_id,item_id,was,became,reason,return_id,document_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, order.id, item.id, JSON.stringify(was), JSON.stringify(became), reason, creditNote?.id || null, document?.id || null,
      requestKey, hash, user.id]);
    await db.query(`UPDATE laundry_order_items SET service_id=$3,service_name=$4,sku_id=$5,per=$6,quantity=$7,pieces=$8,length_ft=$9,width_ft=$10,rate=$11,base=$12,surcharge=$13,
        amount=$14,tax_rate=$15,net=$16,tax=$17,price_source=$18,price_override_id=$19,package_id=$20,package_quantity=$21,package_amount=$22,offer_id=$23,offer_name=$24,
        offer_percent=$25,offer_amount=$26,discount_amount=$27,document_id=COALESCE($28,document_id),line_id=COALESCE($29,line_id),credit_key=CASE WHEN $29::bigint IS NULL THEN credit_key END
      WHERE business_id=$1 AND id=$2`,
    [business.id, item.id, ...fields.map((f) => row[f]), document?.id || null, lineIds[0] || null]);
    await orders.refigure(db, business, user, order);
    const said = Object.keys(became).filter((k) => String(became[k]) !== String(was[k])).map((k) => `${k} ${was[k] ?? 'none'} → ${became[k] ?? 'none'}`);
    await orders.history(db, business, user, order, item, null, null, [`Changed: ${said.join(', ')}`, reason, creditNote ? `credit note ${creditNote.return_no}` : null,
      document ? `bill ${document.document_no}` : null].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'laundry_order.garment_changed', order.id, { orderNo: order.order_no, tag: item.tag_no, was, became, reason,
      ...(creditNote ? { returnNo: creditNote.return_no } : {}), ...(document ? { documentNo: document.document_no, creditMoved: money.rupees(moved) } : {}) });
    await repo.event(db, business.id, user.id, 'laundry_order.garment_changed', 'laundry_order', order.id, { orderNo: order.order_no, itemId: item.id,
      returnId: creditNote?.id || null, documentId: document?.id || null });
    return orders.shape(business, await orders.load(db, business, order.id));
  });
}

module.exports = { addGarments, changeGarment };
