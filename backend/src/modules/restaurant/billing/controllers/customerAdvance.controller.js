const customerAdvanceService = require("../services/customerAdvance.service");
const { logAction } = require("../../../../utils/audit");
const { readDate } = require("../../../../utils/calendarDate");
const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");

const METHODS = ["cash", "card", "upi", "online", "wallet", "other"];

// Staff pinned to one outlet see that outlet's advances; full mobiles are
// for customers.contact.
const ctxOf = (req) => ({
  outletId: req.outletId || null,
  outletPinned: Boolean(req.outletPinned),
  reveal: (req.user.permissions || []).includes("customers.contact"),
});

const rupees = (value) => `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// ?status=held|all&customerId=&from=&to=&search=&page=&pageSize=
const list = async (req, res) => {
  const from = readDate(req.query.from, "From");
  const to = readDate(req.query.to, "To");

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  const filters = {
    status: v.optionalEnum(req.query.status, "Status", ["held", "all"], from || to ? "all" : "held"),
    customerId: req.query.customerId ? v.requiredId(req.query.customerId, "Guest") : null,
    search: v.optionalString(req.query.search, "Search", 60),
    from,
    to,
    page: req.query.page ? v.requiredId(req.query.page, "Page") : 1,
    pageSize: req.query.pageSize ? Number(v.requiredEnum(String(req.query.pageSize), "Page size", ["25", "50", "100"])) : 25,
  };

  res.json({ success: true, data: await customerAdvanceService.list(req.user.restaurantId, filters, ctxOf(req)) });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "Advance");

  res.json({ success: true, data: await customerAdvanceService.getById(req.user.restaurantId, id, ctxOf(req)) });
};

// A guest's advances that still hold money, for "Pay from advance".
const heldFor = async (req, res) => {
  const customerId = v.requiredId(req.params.customerId, "Guest");
  const orderId = req.query.orderId ? v.requiredId(req.query.orderId, "Order") : null;

  res.json({ success: true, data: await customerAdvanceService.heldFor(req.user.restaurantId, customerId, ctxOf(req), orderId) });
};

// The advances taken on one pickup order.
const forOrder = async (req, res) => {
  const orderId = v.requiredId(req.params.orderId, "Order");

  res.json({ success: true, data: await customerAdvanceService.forOrder(req.user.restaurantId, orderId, ctxOf(req)) });
};

const create = async (req, res) => {
  const body = req.body || {};
  const data = {
    customerId: v.requiredId(body.customerId, "Guest or company"),
    amount: v.requiredNumber(body.amount, "Amount", { min: 1, max: 9999999 }),
    paymentMethod: v.requiredEnum(body.paymentMethod, "Paid by", METHODS),
    paymentTypeId: body.paymentTypeId ? v.requiredId(body.paymentTypeId, "Payment type") : null,
    transactionRef: v.optionalString(body.transactionRef, "Reference", 100),
    purpose: v.optionalString(body.purpose, "What it is for", 200),
    reservationId: body.reservationId ? v.requiredId(body.reservationId, "Booking") : null,
    orderId: body.orderId ? v.requiredId(body.orderId, "Order") : null,
  };

  if (data.orderId && data.reservationId) {
    throw new AppError(400, "An advance is for a booking or for a pickup order, not both");
  }

  const advance = await customerAdvanceService.create(req.user.restaurantId, data, req.user.id, ctxOf(req));

  await logAction(req, "advance_taken", "advance", {
    id: advance.id,
    label: advance.receiptNumber,
    details: {
      guest: advance.customerName,
      amount: advance.amount,
      method: advance.paymentMethod,
      type: advance.paymentTypeName || undefined,
      purpose: advance.purpose || undefined,
      order: advance.orderNumber || undefined,
    },
  });

  res.status(201).json({
    success: true,
    message: `Advance ${advance.receiptNumber} of ${rupees(advance.amount)} taken from ${advance.customerName}`,
    data: advance,
  });
};

const readRefund = (body = {}) => ({
  amount: v.requiredNumber(body.amount, "Amount", { min: 0.01, max: 9999999 }),
  refundMethod: v.requiredEnum(body.refundMethod, "Paid back by", METHODS),
  paymentTypeId: body.paymentTypeId ? v.requiredId(body.paymentTypeId, "Payment type") : null,
  transactionRef: v.optionalString(body.transactionRef, "Reference", 100),
  reason: v.requiredString(body.reason, "Reason", 200),
});

// Runs before the manager is asked: the advance must hold this much, and the
// reason is given, so no approval is spent on a refund that would be refused.
const checkRefund = async (req, res, next) => {
  const id = v.requiredId(req.params.id, "Advance");
  req.advanceCheck = await customerAdvanceService.checkRefund(req.user.restaurantId, id, readRefund(req.body || {}), ctxOf(req));
  next();
};

const refundScope = (req) => ({ advanceId: req.advanceCheck.advanceId, amount: req.advanceCheck.amount });

const refund = async (req, res) => {
  const id = v.requiredId(req.params.id, "Advance");
  const data = readRefund(req.body || {});
  const advance = await customerAdvanceService.refund(
    req.user.restaurantId,
    id,
    data,
    { userId: req.user.id, approverId: req.approval ? req.approval.approverId : null },
    ctxOf(req)
  );

  await logAction(req, "advance_refunded", "advance", {
    id: advance.id,
    label: advance.receiptNumber,
    details: {
      guest: advance.customerName,
      amount: data.amount,
      method: data.refundMethod,
      reason: data.reason,
      stillHeld: advance.heldAmount,
    },
  });

  res.status(201).json({
    success: true,
    message: `${rupees(data.amount)} handed back from ${advance.receiptNumber}`,
    data: advance,
  });
};

// ?from=&to= (business dates); left out, this month so far.
const gst = async (req, res) => {
  const from = readDate(req.query.from, "From");
  const to = readDate(req.query.to, "To");

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  res.json({ success: true, data: await customerAdvanceService.gstSummary(req.user.restaurantId, { from, to }) });
};

module.exports = { list, getById, heldFor, forOrder, create, checkRefund, refundScope, refund, gst };
