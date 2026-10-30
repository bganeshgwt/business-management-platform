// Pre-orders: cakes and party orders for a later day (feature "preorders").
// Seeing them is part of taking orders (orders.view); booking and handing them
// over is taking an order (orders.create); moving them to In production and
// Ready is its own permission (preorders.produce), which the owner gives to
// the roles that make them, a kitchen's among them; taking the advance is a
// payment (payments.manage), and needs the feature "advances" too (the
// service refuses it, on booking or later, when that is off); cancelling is
// orders.manage. The bake list is also the kitchen's, which bakes from it:
// the kitchen display's own permission (kds.view) reads it.
//
// Staff tied to one outlet see and act on that outlet's pre-orders only: any
// other answers 404, as another outlet's bill or advance does (ctxOf).
const express = require("express");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const preorders = require("../services/preorder.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const router = express.Router();
router.use(authenticate);
router.use(resolveOutlet);
router.use(requireFeature("preorders"));

const ctxOf = (req) => ({ outletId: req.outletId || null, outletPinned: Boolean(req.outletPinned) });
const isoDay = (value, field) => {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(400, `${field} must be a date (YYYY-MM-DD)`);
  }

  return value;
};
const METHODS = ["cash", "card", "upi", "online", "wallet", "other"];
const readAdvance = (body) => {
  if (!body || body.amount === undefined || body.amount === null || body.amount === "" || Number(body.amount) === 0) {
    return null;
  }

  return {
    amount: v.requiredNumber(Number(body.amount), "Advance", { min: 1, max: 10000000 }),
    paymentMethod: v.requiredEnum(body.paymentMethod, "Advance paid by", METHODS),
    paymentTypeId: body.paymentTypeId ? v.requiredId(body.paymentTypeId, "Payment type") : null,
    transactionRef: v.optionalString(body.transactionRef, "Reference", 100),
  };
};
const send = (res, data, status = 200, message) => res.status(status).json({ success: true, ...(message ? { message } : {}), data });
const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);

router.get("/", authorize("orders.view"), wrap(async (req, res) => {
  const status = v.optionalEnum(req.query.status, "Status", ["open", "all", "booked", "in_production", "ready", "collected", "cancelled"], "open");
  send(res, await preorders.list(req.user.restaurantId, {
    status, from: isoDay(req.query.from, "From"), to: isoDay(req.query.to, "To"), search: v.optionalString(req.query.search, "Search", 100),
  }, ctxOf(req)));
}));

// Whose bake list: an outlet's id, or "main" for the main counter's (the
// pre-orders booked with no outlet). Not given: the outlet this request works
// in (resolveOutlet), else the main counter.
const readCounter = (value) => {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (value === "main") {
    return null;
  }

  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) {
    throw new AppError(400, "Choose an outlet, or the main counter");
  }

  return Number(value);
};

router.get("/bake-list", authorize.any("orders.view", "kds.view"), wrap(async (req, res) => {
  // One till's list: an outlet's pre-orders, or the main counter's. Staff
  // tied to an outlet read their own; anyone else picks whose (outletId). No
  // day asked for: the day that till is trading on (see the service).
  send(res, await preorders.bakeList(req.user.restaurantId, isoDay(req.query.day, "Day"), {
    ...ctxOf(req),
    asked: readCounter(req.query.outletId),
  }));
}));

router.get("/:id", authorize("orders.view"), wrap(async (req, res) => {
  send(res, await preorders.findOne(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order"), ctxOf(req)));
}));

router.post("/", authorize("orders.create"), wrap(async (req, res) => {
  const body = req.body || {};
  const dueAt = new Date(body.dueAt);

  if (!body.dueAt || Number.isNaN(dueAt.getTime())) {
    throw new AppError(400, "Say when it is due (date and time)");
  }

  const items = v.requiredArray(body.items, "Items");

  if (!items.length || items.length > 30) {
    throw new AppError(400, "A pre-order has between 1 and 30 items");
  }

  const fulfilment = v.optionalEnum(body.fulfilment, "Pickup or delivery", ["pickup", "delivery"], "pickup");
  const advance = readAdvance(body.advance);

  if (advance && !req.user.permissions.includes("payments.manage")) {
    throw new AppError(403, "Taking an advance needs the permission to take payments");
  }

  const created = await preorders.create(req.user.restaurantId, {
    customerId: body.customerId ? v.requiredId(body.customerId, "Guest") : null,
    customerName: v.optionalString(body.customerName, "Guest's name", 150),
    customerMobile: v.optionalString(body.customerMobile, "Guest's mobile", 20),
    dueAt: dueAt.toISOString(),
    fulfilment,
    deliveryAddress: fulfilment === "delivery" ? v.requiredString(body.deliveryAddress, "Delivery address", 300) : null,
    notes: v.optionalString(body.notes, "Notes", 500),
    items: items.map((item, index) => ({
      productId: v.requiredId(item?.productId, `Item ${index + 1}`),
      productVariantId: item.productVariantId ? v.requiredId(item.productVariantId, `Item ${index + 1} size`) : null,
      quantity: v.requiredNumber(Number(item.quantity), `Item ${index + 1} quantity`, { min: 0.01, max: 9999 }),
      notes: v.optionalString(item.notes, `Item ${index + 1} message`, 300),
    })),
    advance,
  }, req.user.id, ctxOf(req));

  logAction(req, "create", "preorder", { id: created.id, label: created.number, details: { due: created.dueAt, total: created.estimatedTotal, advance: created.advanceAmount } });
  // Booked even when the till could not take the advance: say so, and how to finish.
  const refused = created.advanceRefused && created.advanceRefused.replace(/([^.!?])$/, "$1.");
  send(res, created, 201, refused
    ? `${created.number} booked for ${created.customerName}, but the advance was not taken: ${refused} Take it from the pre-order when the till can.`
    : `${created.number} booked for ${created.customerName}`);
}));

router.post("/:id/advance", authorize("payments.manage"), wrap(async (req, res) => {
  const advance = readAdvance(req.body);

  if (!advance) {
    throw new AppError(400, "Type the advance");
  }

  const updated = await preorders.takeAdvance(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order"), advance, req.user.id, ctxOf(req));
  logAction(req, "advance", "preorder", { id: updated.id, label: updated.number, details: { amount: advance.amount, receipt: updated.advanceReceipt } });
  send(res, updated, 201, `Advance ${updated.advanceReceipt} taken`);
}));

router.post("/:id/status", authorize("preorders.produce"), wrap(async (req, res) => {
  const status = v.requiredEnum((req.body || {}).status, "Status", ["in_production", "ready"]);
  const updated = await preorders.setStatus(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order"), status, req.user.id, ctxOf(req));
  logAction(req, "status", "preorder", { id: updated.id, label: updated.number, details: { status } });
  // The kitchen, which reads only the bake list, is told what it changed and
  // no more: not the guest's mobile or the money.
  send(res, req.user.permissions.includes("orders.view") ? updated : { id: updated.id, number: updated.number, status: updated.status });
}));

router.post("/:id/cancel", authorize("orders.manage"), wrap(async (req, res) => {
  const reason = v.requiredString((req.body || {}).reason, "Reason", 300);
  const updated = await preorders.cancel(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order"), reason, req.user.id, ctxOf(req));
  logAction(req, "cancel", "preorder", { id: updated.id, label: updated.number, details: { reason } });
  send(res, updated, 200, updated.advanceHeld > 0 ? `${updated.number} cancelled. Its advance (${updated.advanceReceipt}) is still held: refund it from Dues & accounts › Advances.` : `${updated.number} cancelled`);
}));

router.post("/:id/collect", authorize("orders.create"), wrap(async (req, res) => {
  const result = await preorders.collect(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order"), req.user.id, ctxOf(req));
  logAction(req, "collect", "preorder", { id: result.preorder.id, label: result.preorder.number, details: { order: result.orderNumber } });
  send(res, result, 201, `${result.preorder.number} handed over: bill order ${result.orderNumber || ""}`.trim());
}));

module.exports = router;
