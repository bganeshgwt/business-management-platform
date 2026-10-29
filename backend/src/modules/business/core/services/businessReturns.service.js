const crypto = require('node:crypto');
const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('./businessAccess.service');
const numbering = require('./businessNumbering');
const { decimal, kindPermission } = require('./business.service');
const retailOffers = require('../../retail/services/businessOffers');
const paymentMethods = require('./businessPaymentMethods.service');

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value) => v.requiredId(value, 'Record ID');
const cents = (value) => Math.round(Number(value) * 100);
// numerator / denominator to the nearest whole number, halves away from zero.
const signedRound = (numerator, denominator) => {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const result = Number((magnitude * 2n + denominator) / (denominator * 2n));
  return negative ? -result : result;
};
const units = (value) => Math.round(Number(value) * 1000);
function key(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) fail('A valid request key is required');
  return value;
}
async function lockDocument(db, business, documentId, action) {
  // Same lock order as sales/purchases: business, then document, then stock.
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(documentId)]);
  if (!doc) fail('Document not found', 404);
  await access.require(business, kindPermission(doc.kind, action));
  // Staff tied to a location take returns and refunds on its own bills.
  access.requireLocation(business, doc.location_id);
  return doc;
}
function readReturn(body) {
  const reason = v.requiredString(body.reason, 'Return reason', 300);
  const requestKey = key(body.requestKey);
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const lines = v.requiredArray(body.lines, 'Return lines');
  if (!lines.length || lines.length > 100) fail('Add between 1 and 100 return lines');
  if (new Set(lines.map((l) => id(l.lineId))).size !== lines.length) fail('A line may only appear once');
  return { reason, requestKey, hash, lines };
}
async function createReturn(business, user, documentId, body) {
  const input = readReturn(body);
  return repo.transaction(async (db) => {
    const doc = await lockDocument(db, business, documentId, 'refund');
    return postReturn(db, business, user, doc, input);
  });
}
// Posts a return against a document already locked inside the caller's
// transaction (exchanges post a return and a new sale together). The caller
// checks permissions. `values` (callers inside the server only): a service
// line credited by value instead of quantity, as lineId → paise with GST
// (a membership cancelled part way through its days or sessions). Such a
// line is credited once, with nothing returned on it before, and is then
// closed: the rest of it was used. `goodsByValue`: goods lines may be credited
// by value too, restocking nothing (a garage's insurer paying less than its
// bill: the credit note follows the bill's lines and their GST).
async function postReturn(db, business, user, doc, { reason, requestKey, hash, lines, values = null, goodsByValue = false }) {
  {
    const previous = await repo.one(db, 'SELECT * FROM business_returns WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (previous) {
      if (previous.document_id !== doc.id || previous.request_hash !== hash) fail('Request key was already used for a different return', 409);
      return previous;
    }
    const prepared = [];
    let total = 0;
    for (const input of lines) {
      const line = await repo.one(db, `SELECT l.*,s.tracking,u.decimals AS unit_decimals,u.name AS unit_name FROM business_document_lines l
       JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
       LEFT JOIN business_units u ON u.business_id=l.business_id AND u.code=l.unit
       WHERE l.business_id=$1 AND l.document_id=$2 AND l.id=$3`, [business.id, doc.id, id(input.lineId)]);
      if (!line) fail('Original document line not found', 404);
      const credit = values?.get(Number(line.id));
      if (credit !== undefined) {
        const gross = cents(line.net) + cents(line.tax);
        // Goods are credited by value only when the caller asks (a garage's insurer paying less than its bill): nothing comes back into stock.
        if (line.tracking !== 'none' && !goodsByValue) fail(`${line.label} is goods: it comes back by quantity`);
        if (!Number.isSafeInteger(credit) || credit <= 0 || credit > gross) fail(`${line.label} can be credited at most ${(gross / 100).toFixed(2)}`);
        const earlier = await repo.one(db, 'SELECT 1 FROM business_return_lines WHERE business_id=$1 AND line_id=$2 LIMIT 1', [business.id, line.id]);
        if (earlier) fail(`${line.label} on ${doc.document_no} has already been credited`, 409);
        // GST in the line's own proportion; the two add up to the credit exactly.
        const net = signedRound(BigInt(cents(line.net)) * BigInt(credit), BigInt(gross));
        prepared.push({ line, quantity: Number(line.quantity), net, tax: credit - net, restock: false }); total += credit;
        continue;
      }
      const quantity = decimal(input.quantity, 'Return quantity', 3, 0.001, 100000);
      // The line's unit decides: whole units (each, tablet, strip, box…) come back whole.
      const decimals = line.unit_decimals ?? (line.unit === 'each' ? 0 : 3);
      if ((decimals === 0 && !Number.isInteger(quantity)) || (String(input.quantity).split('.')[1] || '').replace(/0+$/, '').length > decimals) {
        fail(`${line.label} is returned in whole ${String(line.unit_name || line.unit).toLowerCase()}${decimals ? ` (up to ${decimals} decimal places)` : ''}`);
      }
      const already = await repo.one(db, 'SELECT COALESCE(sum(quantity),0) AS quantity,COALESCE(sum(net),0) AS net,COALESCE(sum(tax),0) AS tax FROM business_return_lines WHERE business_id=$1 AND line_id=$2', [business.id, line.id]);
      const newUnits = units(already.quantity) + units(quantity);
      if (newUnits > units(line.quantity)) fail('Return quantity exceeds the original quantity remaining', 409);
      // Cumulative allocation returns the exact original rounded amount on the final portion.
      const allocated = (amount) => Number((BigInt(cents(amount)) * BigInt(newUnits) + BigInt(units(line.quantity)) / 2n) / BigInt(units(line.quantity)));
      const net = allocated(line.net) - cents(already.net);
      const tax = allocated(line.tax) - cents(already.tax);
      const restock = doc.kind === 'purchase' ? true : v.requiredBoolean(input.restock, 'Restock', true);
      prepared.push({ line, quantity, net, tax, restock }); total += net + tax;
    }
    // The sale's round-off comes back in proportion to the value returned so
    // far (cumulative, so the shares add up exactly to the whole round-off once
    // everything is back). Returns can then never add up to more than the
    // rounded total that was charged.
    const before = await repo.one(db, `SELECT COALESCE(sum(l.net+l.tax),0) AS value,
      COALESCE((SELECT sum(round_off) FROM business_returns r WHERE r.business_id=$1 AND r.document_id=$2),0) AS round_off
      FROM business_return_lines l JOIN business_returns r ON r.business_id=l.business_id AND r.id=l.return_id
      WHERE r.business_id=$1 AND r.document_id=$2`, [business.id, doc.id]);
    const gross = cents(doc.subtotal) + cents(doc.tax);
    const returnedValue = cents(before.value) + total;
    const roundOff = gross === 0 ? 0 : signedRound(BigInt(cents(doc.round_off)) * BigInt(returnedValue), BigInt(gross)) - cents(before.round_off);
    total += roundOff;
    const number = await numbering.nextNumber(db, business.id, doc.location_id, doc.kind === 'sale' ? 'sales_return' : 'purchase_return', user.id);
    const saved = await repo.one(db, `INSERT INTO business_returns(business_id,document_id,return_no,series_id,reason,total,round_off,request_key,request_hash,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [business.id, doc.id, number.number, number.seriesId, reason, (total / 100).toFixed(2), (roundOff / 100).toFixed(2), requestKey, hash, user.id]);
    for (const item of prepared) {
      await db.query(`INSERT INTO business_return_lines(business_id,return_id,line_id,quantity,net,tax,restock) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [business.id, saved.id, item.line.id, item.quantity, (item.net / 100).toFixed(2), (item.tax / 100).toFixed(2), item.restock]);
      if (item.line.tracking === 'none' || !item.restock) continue;
      const lot = await repo.one(db, `SELECT * FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4 FOR UPDATE`,
        [business.id, doc.location_id, item.line.sku_id, item.line.lot_code]);
      if (!lot) fail('Original stock lot not found', 409);
      const direction = doc.kind === 'sale' ? 1 : -1;
      const balance = units(lot.quantity) + direction * units(item.quantity);
      if (balance < 0) fail('Insufficient stock for this supplier return', 409);
      if (item.line.tracking === 'serial' && balance > 1000) fail('This serial is already in stock', 409);
      if (item.line.stock_unit_cost === null) fail('This historical line has no recorded stock cost; review its valuation before returning', 409);
      const updated = await repo.one(db, `UPDATE business_stock_lots SET
        unit_cost=CASE WHEN $3::numeric=0 THEN unit_cost ELSE
        (quantity*unit_cost+$4::numeric*$5::numeric)/$3::numeric END,
        quantity=$3 WHERE business_id=$1 AND id=$2
        AND (quantity*unit_cost+$4::numeric*$5::numeric)>=0 RETURNING quantity`,
        [business.id, lot.id, (balance / 1000).toFixed(3), direction * item.quantity, item.line.stock_unit_cost]);
      if (!updated) fail('Historical return cost exceeds remaining stock value; reconcile valuation first', 409);
      await db.query(`INSERT INTO business_stock_movements(business_id,lot_id,document_id,return_id,quantity,balance_after) VALUES($1,$2,$3,$4,$5,$6)`,
        [business.id, lot.id, doc.id, saved.id, direction * item.quantity, updated.quantity]);
    }
    await repo.audit(db, business.id, user.id, `${doc.kind}.returned`, saved.id, { documentId: doc.id, total: saved.total, returnNo: saved.return_no });
    await repo.event(db, business.id, user.id, `${doc.kind}.returned`, 'return', saved.id, {
      documentId: doc.id, documentNo: doc.document_no, returnNo: saved.return_no, total: saved.total,
      lines: prepared.map((p) => ({ lineId: p.line.id, skuId: p.line.sku_id, quantity: p.quantity, restock: p.restock })),
    });
    // Points the customer spent on this bill come back in proportion
    // (a loyalty setting), then the points the sale earned go back
    // with the goods (retail).
    await retailOffers.restoreForReturn(db, business, user, doc, saved);
    await retailOffers.reverseForReturn(db, business, user, doc, saved);
    return saved;
  }
}
// A refund never goes out by cheque. `methodId`: one of the business's own methods.
const REFUND_KINDS = ['cash', 'card', 'upi', 'bank'];
function readRefund(body) {
  const amount = decimal(body.amount, 'Refund amount', 2, 0.01);
  const choice = paymentMethods.readChoice(body, 'Refund method', REFUND_KINDS);
  const reason = v.requiredString(body.reason, 'Refund reason', 300);
  return { amount, choice, reason, requestKey: key(body.requestKey) };
}
async function refund(business, user, documentId, body) {
  const input = readRefund(body);
  return repo.transaction(async (db) => {
    const doc = await lockDocument(db, business, documentId, 'refund');
    return postRefund(db, business, user, doc, input);
  });
}
// Posts a refund on a document already locked inside the caller's
// transaction (a membership cancelled with its refund). The caller checks
// permissions; `input` is what readRefund makes of a request.
async function postRefund(db, business, user, doc, { amount, choice, reason, requestKey }) {
  const previous = await repo.one(db, 'SELECT * FROM business_refunds WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
  if (previous) {
    if (previous.document_id !== doc.id || cents(previous.amount) !== cents(amount) || (choice.method && previous.method !== choice.method) || previous.reason !== reason) fail('Refund key already used', 409);
    return previous;
  }
  const { method, methodName } = await paymentMethods.settle(db, business.id, choice, 'Refund method', REFUND_KINDS);
  const sums = await repo.one(db, `SELECT
    COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
    COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
    COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded`, [business.id, doc.id]);
  const available = cents(sums.paid) - cents(sums.refunded) - (cents(doc.total) - cents(sums.returned));
  if (cents(amount) > available) fail('Refund exceeds the credit available after returns', 409);
  // Loyalty points from this sale that the customer had already spent are
  // paid for out of the refund (their value was recorded with the return).
  const held = await retailOffers.heldBack(db, business.id, doc.id);
  if (held && cents(amount) > available - held) {
    fail(`${(held / 100).toFixed(2)} is kept back for loyalty points this bill earned that were already spent; at most ${(Math.max(0, available - held) / 100).toFixed(2)} can be refunded`, 409);
  }
  // Never more than was actually paid, less what was already refunded.
  if (cents(amount) > cents(sums.paid) - cents(sums.refunded)) fail('Refund exceeds what was paid on this document, less earlier refunds', 409);
  // An EMI bill: the customer gets back only what they paid
  // themselves; the financed part goes back to the financier when the loan
  // is cancelled (EMI & finance › cancel).
  const own = await repo.one(db, `SELECT
    COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2 AND method='finance'),0) AS financed,
    COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2 AND method='finance'),0) AS reversed`, [business.id, doc.id]);
  if (cents(own.financed) > 0) {
    const customerPaid = cents(sums.paid) - cents(own.financed) - (cents(sums.refunded) - cents(own.reversed));
    if (cents(amount) > customerPaid) {
      fail(`The customer paid ${(Math.max(0, customerPaid) / 100).toFixed(2)} themselves on this EMI bill; the financed part goes back to the financier when the loan is cancelled.`, 409);
    }
  }
  const result = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by,method_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, doc.id, amount, method, reason, requestKey, user.id, methodName]);
  await repo.audit(db, business.id, user.id, `${doc.kind}.refunded`, result.id, { documentId: doc.id, amount, ...(methodName ? { method, methodName } : {}) });
  await repo.event(db, business.id, user.id, `${doc.kind}.refunded`, 'refund', result.id, { documentId: doc.id, documentNo: doc.document_no, amount: result.amount, method });
  return result;
}
// A signed quantity: "-0.200" for a shortage, "1.5" for a surplus.
function signedQuantity(value) {
  const raw = String(value ?? '');
  const negative = raw.startsWith('-');
  return decimal(negative ? raw.slice(1) : value, 'Adjustment quantity', 3, 0.001, 100000) * (negative ? -1 : 1);
}
// One correction, inside the caller's transaction (also used by stock counts).
async function applyAdjustment(db, business, user, lot, quantity, reason, requestKey, countId = null) {
  if (lot.tracking === 'serial' && quantity > 0) fail('Restore a serialized unit through its original sale return');
  if (lot.unit_decimals === 0 && !Number.isInteger(quantity)) fail(`${lot.label} is counted in whole units`);
  const balance = units(lot.quantity) + Math.round(quantity * 1000);
  if (balance < 0) fail('Adjustment would make stock negative', 409);
  const adjustment = await repo.one(db, `INSERT INTO business_stock_adjustments(business_id,lot_id,quantity,reason,request_key,created_by,count_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [business.id, lot.id, quantity, reason, requestKey, user.id, countId]);
  await db.query('UPDATE business_stock_lots SET quantity=$3 WHERE business_id=$1 AND id=$2', [business.id, lot.id, (balance / 1000).toFixed(3)]);
  await db.query(`INSERT INTO business_stock_movements(business_id,lot_id,adjustment_id,quantity,balance_after) VALUES($1,$2,$3,$4,$5)`, [business.id, lot.id, adjustment.id, quantity, (balance / 1000).toFixed(3)]);
  return adjustment;
}
// A serial-numbered unit the business brings into stock without a purchase
// (a jeweller's piece made by its own goldsmith, or one it holds when it
// starts), inside the caller's transaction (the business row locked): a new
// lot at the location with this one unit, at the cost given, as a correction
// with its reason. Never a number this item has had in stock before. The
// caller checks permissions and writes the activity log. Returns { lot, adjustment }.
async function receiveSerial(db, business, user, { skuId, locationId, serial, unitCost = 0, reason, requestKey }) {
  const sku = await repo.one(db, `SELECT s.id,s.label,s.tracking,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(skuId)]);
  if (!sku || sku.kind !== 'goods' || sku.tracking !== 'serial') fail('Only a serial-numbered item takes a unit into stock this way');
  if (await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [business.id, sku.id, serial])) {
    fail(`${sku.label} number ${serial} has been in stock before: give a new number`, 409);
  }
  const lot = await repo.one(db, `INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,quantity,unit_cost) VALUES($1,$2,$3,$4,0,$5) RETURNING *`,
    [business.id, id(locationId), sku.id, serial, Number(unitCost).toFixed(4)]);
  const adjustment = await repo.one(db, `INSERT INTO business_stock_adjustments(business_id,lot_id,quantity,reason,request_key,created_by) VALUES($1,$2,1,$3,$4,$5) RETURNING *`,
    [business.id, lot.id, reason, key(requestKey), user.id]);
  await db.query('UPDATE business_stock_lots SET quantity=1 WHERE business_id=$1 AND id=$2', [business.id, lot.id]);
  await db.query('INSERT INTO business_stock_movements(business_id,lot_id,adjustment_id,quantity,balance_after) VALUES($1,$2,$3,1,1)', [business.id, lot.id, adjustment.id]);
  return { lot: { ...lot, quantity: '1.000' }, adjustment };
}
const lockLot = (db, businessId, lotId) => repo.one(db, `SELECT l.*,s.tracking,s.unit,s.label,u.decimals AS unit_decimals FROM business_stock_lots l
  JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
  JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
  WHERE l.business_id=$1 AND l.id=$2 FOR UPDATE OF l`, [businessId, lotId]);
async function adjust(business, user, lotId, body) {
  await access.require(business, 'inventory.edit');
  const quantity = signedQuantity(body.quantity);
  const reason = v.requiredString(body.reason, 'Adjustment reason', 300);
  const requestKey = key(body.requestKey);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM business_stock_adjustments WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.lot_id !== id(lotId) || Number(old.quantity) !== quantity || old.reason !== reason) fail('Adjustment key already used', 409);
      return old;
    }
    const lot = await lockLot(db, business.id, id(lotId));
    if (!lot) fail('Stock lot not found', 404);
    access.requireLocation(business, lot.location_id);
    await require('./business.service').requireDepartmentItem(db, business, { skuId: lot.sku_id });
    const adjustment = await applyAdjustment(db, business, user, lot, quantity, reason, requestKey);
    await repo.audit(db, business.id, user.id, 'stock.adjusted', adjustment.id, { reason, quantity });
    await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id, { lotId: lot.id, skuId: lot.sku_id, locationId: lot.location_id, quantity, reason });
    return adjustment;
  });
}
module.exports = { createReturn, postReturn, lockDocument, refund, readRefund, postRefund, adjust, applyAdjustment, receiveSerial, lockLot };
