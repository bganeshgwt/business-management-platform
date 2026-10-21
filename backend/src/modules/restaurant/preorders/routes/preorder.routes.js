// Pre-orders: cakes and party orders for a later day (feature "preorders").
// Seeing them is part of taking orders (orders.view); booking, moving them
// along and handing them over is taking an order (orders.create); taking the
// advance is a payment (payments.manage); cancelling is orders.manage.
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
  }));
}));

router.get("/bake-list", authorize("orders.view"), wrap(async (req, res) => {
  send(res, await preorders.bakeList(req.user.restaurantId, isoDay(req.query.day, "Day") || new Date().toISOString().slice(0, 10)));
}));

router.get("/:id", authorize("orders.view"), wrap(async (req, res) => {
  send(res, await preorders.findOne(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order")));
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
  send(res, created, 201, `${created.number} booked for ${created.customerName}`);
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

router.post("/:id/status", authorize("orders.create"), wrap(async (req, res) => {
  const status = v.requiredEnum((req.body || {}).status, "Status", ["in_production", "ready"]);
  const updated = await preorders.setStatus(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order"), status, req.user.id);
  logAction(req, "status", "preorder", { id: updated.id, label: updated.number, details: { status } });
  send(res, updated);
}));

router.post("/:id/cancel", authorize("orders.manage"), wrap(async (req, res) => {
  const reason = v.requiredString((req.body || {}).reason, "Reason", 300);
  const updated = await preorders.cancel(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order"), reason, req.user.id);
  logAction(req, "cancel", "preorder", { id: updated.id, label: updated.number, details: { reason } });
  send(res, updated, 200, updated.advanceHeld > 0 ? `${updated.number} cancelled. Its advance (${updated.advanceReceipt}) is still held: refund it from Dues › Advances.` : `${updated.number} cancelled`);
}));

router.post("/:id/collect", authorize("orders.create"), wrap(async (req, res) => {
  const result = await preorders.collect(req.user.restaurantId, v.requiredId(req.params.id, "Pre-order"), req.user.id, ctxOf(req));
  logAction(req, "collect", "preorder", { id: result.preorder.id, label: result.preorder.number, details: { order: result.orderNumber } });
  send(res, result, 201, `${result.preorder.number} handed over: bill order ${result.orderNumber || ""}`.trim());
}));

module.exports = router;
