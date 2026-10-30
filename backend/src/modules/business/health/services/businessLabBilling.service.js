const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const h = require('./healthCommon');
const rules = require('./labBilling');

// Billing a lab order's tests: as they are ordered (by someone who bills),
// later from the order (Bill these tests), or with the visit's bill, at the
// front desk. Every bill is a sale posted through the core at the tests'
// prices, and each test billed is linked to its line (a profile's tests to
// the profile's line), so the order says what is billed, on which bill, and
// what is left; a test is never billed twice (the database keeps a test's
// line once set). A part may be billed now and the rest later; a test
// cancelled before it is billed needs no credit note, and one billed is
// returned on its bill (Sales), as any line is.

const { fail, id, text } = h;
const requireLab = (business) => {
  h.requireType(business, ['healthcare'], 'Lab screens');
  if (!business.modules.includes('lab')) fail('Laboratory is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
};

// An order's tests with what each is billed as (its service, or its
// profile's) and the bill it is on, in the order's order. A service switched
// off is no service to bill.
const ROWS = `SELECT ot.id,ot.order_id,ot.test_id,ot.profile_id,ot.document_line_id,(ot.cancelled_at IS NOT NULL) AS cancelled,
    t.code,t.name,s.id AS sku_id,s.price,p.code AS profile_code,p.name AS profile_name,ps.id AS profile_sku_id,ps.price AS profile_price,
    l.document_id AS billed_document_id,d.document_no AS billed_document_no
  FROM lab_order_tests ot JOIN lab_tests t ON t.business_id=ot.business_id AND t.id=ot.test_id
  LEFT JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id AND s.active
  LEFT JOIN lab_tests p ON p.business_id=ot.business_id AND p.id=ot.profile_id
  LEFT JOIN catalog_skus ps ON ps.business_id=p.business_id AND ps.id=p.sku_id AND ps.active
  LEFT JOIN business_document_lines l ON l.business_id=ot.business_id AND l.id=ot.document_line_id
  LEFT JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id
  WHERE ot.business_id=$1 AND ot.order_id=ANY($2::bigint[]) ORDER BY ot.order_id,ot.id`;
const rowsOf = (db, business, orderIds) => (orderIds.length ? repo.all(db, ROWS, [business.id, orderIds]) : []);

// What the screens show of an order's billing: { state (none, part,
// billed), bills [{ id, document_no }], to_bill [units], no_service [test ids] }.
function summaryOf(rows) {
  const bills = new Map();
  for (const row of rows) if (row.billed_document_id) bills.set(String(row.billed_document_id), { id: row.billed_document_id, document_no: row.billed_document_no });
  const { units, noService } = rules.billingUnits(rows);
  return { state: rules.billingState(rows), bills: [...bills.values()], to_bill: units, no_service: noService };
}

// The money taken now with a bill, as the clinic's other bills take it
// (sales.edit); null when nothing is paid now.
async function paymentOf(business, payment) {
  if (!payment) return null;
  await access.require(business, 'sales.edit');
  const amount = payment.amount === 'full' ? 'full' : core.decimal(payment.amount, 'Amount paid now', 2, 0, 100000000);
  return amount === 'full' || amount > 0 ? { amount, ...paymentMethods.readChoice(payment, 'Payment method'), reference: text(payment.reference, 'Payment reference', 100) } : null;
}

// Why a test asked for cannot be billed now, said for people.
function refuse(refused, missing) {
  const first = refused[0];
  if (!first) return;
  if (first.why === 'missing') fail(missing, 404);
  const name = first.row.name;
  if (first.why === 'cancelled') fail(`${name} was cancelled: it is not billed`, 409);
  if (first.why === 'billed') fail(`${name} is billed already (${first.row.billed_document_no})`, 409);
  fail(`${name} has no service to bill it as: choose one under Lab orders › Tests & panels (Billed as)`, 409);
}

// The units to bill: those holding the tests asked for, else every unbilled test.
function pick(rows, wanted, missing) {
  if (wanted) {
    const { units, refused } = rules.unitsFor(rows, wanted);
    refuse(refused, missing);
    return units;
  }
  const { units, noService } = rules.billingUnits(rows);
  if (!units.length) {
    fail(noService.length ? 'No test left to bill has a service to bill it as: choose one under Lab orders › Tests & panels (Billed as)' : 'Every test on this order is billed already', 409);
  }
  return units;
}

// Each unit on its line of the bill: a line of its service, in the bill's
// order (a test's service is no other test's).
async function link(db, business, documentId, units) {
  const lines = await repo.all(db, 'SELECT id,sku_id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, documentId]);
  const used = new Set();
  for (const unit of units) {
    const line = lines.find((l) => !used.has(String(l.id)) && String(l.sku_id) === String(unit.sku_id));
    if (!line) fail(`The bill has no line for ${unit.label}`, 409);
    used.add(String(line.id));
    await db.query('UPDATE lab_order_tests SET document_line_id=$3 WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, unit.order_test_ids, line.id]);
  }
}

// After a bill: each order keeps its first bill, and its billing is audited
// and evented (with the order's id: its screens read it again).
async function settle(db, business, user, orders, units, document, extra = {}) {
  for (const order of orders) {
    const mine = units.filter((unit) => String(unit.order_id) === String(order.id));
    if (!mine.length) continue;
    await db.query('UPDATE lab_orders SET document_id=COALESCE(document_id,$3),updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, order.id, document.id]);
    const tests = mine.map((unit) => unit.code);
    await repo.audit(db, business.id, user.id, 'lab.tests_billed', order.id, { orderNo: order.order_no, documentNo: document.document_no, tests, ...extra });
    await repo.event(db, business.id, user.id, 'lab.tests_billed', 'lab_order', order.id,
      { orderNo: order.order_no, documentId: document.id, documentNo: document.document_no, tests, locationId: order.location_id });
  }
}

// Posts a bill of these units for the order's patient and links each test.
async function postUnits(db, business, user, order, units, { requestKey, hash, payment, paidNow, locationId, notes }) {
  const lines = units.map((unit) => ({ skuId: Number(unit.sku_id), quantity: '1' }));
  const input = { kind: 'sale', locationId, contactId: Number(order.contact_id), lines, payment, notes };
  const document = await core.postDocument(db, business, user, input, { kind: 'sale', requestKey, hash, lines, paidNow });
  await link(db, business, document.id, units);
  await settle(db, business, user, [order], units.map((unit) => ({ ...unit, order_id: order.id })), document);
  return document;
}

// An order created with a bill the desk raised before: each of its tests is
// linked to a line of that bill for its service that no test holds yet.
async function linkExisting(db, business, user, order, documentId) {
  const { units } = rules.billingUnits(await rowsOf(db, business, [order.id]));
  const lines = await repo.all(db, `SELECT l.id,l.sku_id FROM business_document_lines l WHERE l.business_id=$1 AND l.document_id=$2
    AND NOT EXISTS (SELECT 1 FROM lab_order_tests x WHERE x.business_id=l.business_id AND x.document_line_id=l.id) ORDER BY l.id`, [business.id, documentId]);
  const used = new Set();
  const linked = [];
  for (const unit of units) {
    const line = lines.find((l) => !used.has(String(l.id)) && String(l.sku_id) === String(unit.sku_id));
    if (!line) continue;
    used.add(String(line.id));
    linked.push({ ...unit, order_id: order.id });
    await db.query('UPDATE lab_order_tests SET document_line_id=$3 WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, unit.order_test_ids, line.id]);
  }
  if (!linked.length) fail('That bill has none of these tests on it', 409);
  const document = await repo.one(db, 'SELECT id,document_no FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, documentId]);
  await settle(db, business, user, [order], linked, document, { linked: true });
}

// Bill these tests: the order's unbilled tests (or those asked for: a
// profile's test brings its profile) on a bill of their own, at their prices.
// body: { requestKey, orderTestIds?, payment?, locationId? (the order's) }.
async function billOrder(business, user, orderId, body) {
  requireLab(business);
  await access.require(business, 'sales.create');
  const key = h.requestKey(body.requestKey);
  const wanted = body.orderTestIds === undefined ? null : [...new Set(v.requiredArray(body.orderTestIds, 'Tests').map((t) => id(t, 'Test')))];
  if (wanted && (!wanted.length || wanted.length > 40)) fail('Choose between 1 and 40 tests');
  const paidNow = await paymentOf(business, body.payment);
  const locationId = body.locationId === undefined || body.locationId === null || body.locationId === '' ? null : id(body.locationId, 'Location');
  const orderKey = id(orderId, 'Lab order');
  const hash = h.hashOf({ orderId: orderKey, orderTestIds: wanted ? [...wanted].sort((a, b) => a - b) : null, payment: body.payment ?? null, locationId });
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const order = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, orderKey]);
    if (!order) fail('Lab order not found', 404);
    access.requireLocation(business, order.location_id);
    const old = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [business.id, key]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return { order_id: order.id, document: old, billing: summaryOf(await rowsOf(db, business, [order.id])), repeated: true };
    }
    if (order.status === 'cancelled') fail('This order is cancelled: nothing on it is billed', 409);
    const units = pick(await rowsOf(db, business, [order.id]), wanted, 'That test is not on this order');
    const document = await postUnits(db, business, user, order, units, { requestKey: key, hash, payment: body.payment, paidNow,
      locationId: locationId || order.location_id, notes: `Lab tests ${order.order_no}` });
    return { order_id: order.id, document, billing: summaryOf(await rowsOf(db, business, [order.id])) };
  });
}

// The visit's open lab orders (not cancelled), locked, with their tests.
async function visitOrders(db, business, visitId, { lock = false } = {}) {
  const orders = await repo.all(db, `SELECT * FROM lab_orders WHERE business_id=$1 AND visit_id=$2 AND status<>'cancelled' ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [business.id, visitId]);
  return { orders, rows: await rowsOf(db, business, orders.map((o) => o.id)) };
}

// With the visit's bill: the units holding the tests asked for, among the
// visit's orders; each unit names its order.
async function unitsForVisit(db, business, visit, wanted) {
  const { orders, rows } = await visitOrders(db, business, visit.id, { lock: true });
  const units = pick(rows, wanted, 'That test was not ordered for this visit');
  return units.map((unit) => ({ ...unit, order: orders.find((o) => String(o.id) === String(unit.order_id)) }));
}
// Once the visit's bill is posted: each test on its line, and each order settled.
async function linkVisitBill(db, business, user, document, units) {
  if (!units.length) return;
  await link(db, business, document.id, units);
  const orders = [...new Map(units.map((unit) => [String(unit.order.id), unit.order])).values()];
  await settle(db, business, user, orders, units, document, { withVisitBill: true });
}

// What a visit's front desk sees of its lab orders' billing: each order's
// state and bills, and every test still to bill, each naming its order.
async function visitBilling(db, business, visitId) {
  const { orders, rows } = await visitOrders(db, business, visitId);
  const byOrder = Object.fromEntries(orders.map((o) => [String(o.id), summaryOf(rows.filter((r) => String(r.order_id) === String(o.id)))]));
  const toBill = rules.billingUnits(rows).units.map((unit) => ({ ...unit, order_no: orders.find((o) => String(o.id) === String(unit.order_id))?.order_no || null }));
  return { byOrder, toBill };
}

module.exports = { requireLab, rowsOf, summaryOf, paymentOf, postUnits, linkExisting, billOrder, unitsForVisit, linkVisitBill, visitBilling };
