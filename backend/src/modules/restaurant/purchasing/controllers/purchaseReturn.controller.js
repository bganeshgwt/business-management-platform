const purchaseReturnService = require("../services/purchaseReturn.service");
const purchaseReturnRepository = require("../repositories/purchaseReturn.repository");
const purchaseRepository = require("../repositories/purchase.repository");
const inventoryService = require("../../inventory/services/inventory.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { readDate } = require("../../../../utils/calendarDate");

const todayText = () => new Date().toLocaleDateString("en-CA");

const notFuture = (date, field) => {
  if (date && date > todayText()) {
    throw new AppError(400, `${field} cannot be in the future`);
  }

  return date;
};

const PAYMENT_METHODS = ["cash", "card", "upi", "bank", "cheque", "other"];

// The GST slabs a supplier bill can carry, as on a purchase bill: a debit
// note is credited at the rate the goods were bought at.
// 12 % and 28 % stay for supplier bills dated before the September 2025 GST change.
const TAX_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

const readTaxRate = (value) => {
  const rate = v.optionalNumber(value, "GST rate", { min: 0, max: 28 });

  if (rate !== null && !TAX_RATES.includes(rate)) {
    throw new AppError(400, `GST rate must be one of ${TAX_RATES.join(", ")}%`);
  }

  return rate;
};

// ?from=&to=&limit=&offset= ask for one page and how many match in all; a
// request without them gets the plain list, as before.
const readPage = (query) => {
  const paged = ["from", "to", "limit", "offset"].some((key) => query[key] !== undefined && query[key] !== "");

  if (!paged) {
    return {};
  }

  const from = readDate(query.from, "From");
  const to = readDate(query.to, "To");

  if (from && to && from > to) {
    throw new AppError(400, "The start date must be on or before the end date");
  }

  return {
    paged: true,
    from,
    to,
    limit: v.optionalNumber(query.limit, "Limit", { min: 1, max: 500 }) ?? 25,
    offset: v.optionalNumber(query.offset, "Offset", { min: 0, max: 1000000 }) ?? 0,
  };
};

const list = async (req, res) => {
  const filters = {
    supplierId: v.optionalNumber(req.query.supplierId, "Supplier", { min: 1 }),
    status: v.optionalEnum(req.query.status, "Status", ["posted", "void"], null),
    ...readPage(req.query),
  };

  res.json({ success: true, data: await purchaseReturnService.list(req.user.restaurantId, filters) });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "Return id");

  res.json({ success: true, data: await purchaseReturnService.getById(req.user.restaurantId, id) });
};

// The most a return not tied to a bill may credit for one item from one
// supplier, and the GST rates it may carry, for the form to show up front.
const creditLimit = async (req, res) => {
  res.json({
    success: true,
    data: await purchaseReturnService.creditLimit(req.user.restaurantId, {
      supplierId: v.requiredId(req.query.supplierId, "Supplier"),
      itemId: v.requiredId(req.query.itemId, "Item"),
    }),
  });
};

const create = async (req, res) => {
  const body = req.body || {};

  const data = {
    supplierId: v.requiredId(body.supplierId, "Supplier"),
    purchaseOrderId: v.optionalNumber(body.purchaseOrderId, "Purchase order", { min: 1 }),
    goodsReceiptId: v.optionalNumber(body.goodsReceiptId, "Purchase bill", { min: 1 }),
    returnDate: notFuture(readDate(body.returnDate, "Return date", todayText()), "Return date"),
    reason: v.requiredString(body.reason, "Reason", 200),
    notes: v.optionalString(body.notes, "Notes", 500),
    // The store the goods leave from, when the return is not tied to a bill.
    outletId: req.outletId || null,
    items: v.requiredArray(body.items, "Items").map((item) => ({
      inventoryItemId: v.requiredId(item.inventoryItemId, "Item"),
      quantity: v.requiredNumber(item.quantity, "Quantity", { min: 0.001, max: 9999999 }),
      // What the supplier credits per unit, before GST. 0 is allowed: goods
      // sent back for replacement, or with no credit given.
      unitPrice: v.requiredNumber(item.unitPrice, "Credit price", { min: 0, max: 9999999 }),
      taxRate: readTaxRate(item.taxRate),
    })),
  };

  // Someone tied to one outlet sends back only goods from their own store:
  // a return against a bill (or order) takes stock off the shelf that bill's
  // goods went to.
  if (req.outletPinned && (data.goodsReceiptId || data.purchaseOrderId)) {
    if (data.goodsReceiptId) {
      const bill = await purchaseRepository.findReceiptById(req.user.restaurantId, data.goodsReceiptId);

      if (bill) {
        await inventoryService.requirePinnedStoreId(req.user.restaurantId, req.outletId, bill.outlet_id);
      }
    } else {
      const order = await purchaseRepository.findById(req.user.restaurantId, data.purchaseOrderId);

      if (order) {
        await inventoryService.requirePinnedStore(req.user.restaurantId, req.outletId, order.outlet_id);
      }
    }
  }

  const purchaseReturn = await purchaseReturnService.create(
    req.user.restaurantId,
    data,
    req.user.id
  );

  logAction(req, "create", "purchase_return", {
    id: purchaseReturn.id,
    label: purchaseReturn.returnNumber,
    details: { supplier: purchaseReturn.supplierName, amount: purchaseReturn.totalAmount },
  });

  res.status(201).json({ success: true, message: "Return recorded and stock reduced", data: purchaseReturn });
};

// Someone tied to one outlet may correct or void only the returns that left
// their own store; another outlet's return answers as voiding it does.
const requireOwnReturn = async (req, id) => {
  if (!req.outletPinned) {
    return;
  }

  const storeId = await purchaseReturnRepository.findReturnStore(req.user.restaurantId, id);

  if (storeId !== undefined) {
    await inventoryService.requirePinnedStoreId(req.user.restaurantId, req.outletId, storeId);
  }
};

// Corrects the credit given (price per line, date, reason). Quantities are
// not editable: stock already left — void the return and enter it again.
const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Return id");
  const body = req.body || {};

  await requireOwnReturn(req, id);

  const data = {
    returnDate: notFuture(readDate(body.returnDate, "Return date"), "Return date"),
    reason: v.optionalString(body.reason, "Reason", 200),
    notes: body.notes === undefined ? undefined : v.optionalString(body.notes, "Notes", 500),
    lines: (body.lines === undefined ? [] : v.requiredArray(body.lines, "Lines")).map((line) => ({
      id: v.requiredId(line?.id, "Line"),
      unitPrice: v.requiredNumber(line?.unitPrice, "Credit price", { min: 0, max: 9999999 }),
    })),
  };
  const changeReason = v.requiredString(body.changeReason, "Why it is being changed", 200);

  const { before, after } = await purchaseReturnService.update(req.user.restaurantId, id, data, req.user.id);

  logAction(req, "update", "purchase_return", {
    id,
    label: after.returnNumber,
    details: {
      reason: changeReason,
      before: { total: before.totalAmount, date: before.returnDate },
      after: { total: after.totalAmount, date: after.returnDate },
    },
  });

  res.json({ success: true, message: `${after.returnNumber} corrected`, data: after });
};

const voidReturn = async (req, res) => {
  const id = v.requiredId(req.params.id, "Return id");
  const reason = v.requiredString(req.body?.reason, "Reason", 200);

  // Voiding puts the goods back on the shelf they left: someone tied to one
  // outlet may do that for their own store's returns only.
  await requireOwnReturn(req, id);

  const purchaseReturn = await purchaseReturnService.voidReturn(req.user.restaurantId, id, reason, req.user.id);

  logAction(req, "void", "purchase_return", {
    id,
    label: purchaseReturn.returnNumber,
    details: { reason, amount: purchaseReturn.totalAmount, supplier: purchaseReturn.supplierName },
  });

  res.json({
    success: true,
    message: `${purchaseReturn.returnNumber} voided and the goods put back in stock`,
    data: purchaseReturn,
  });
};

// --- Supplier payments ---

const listPayments = async (req, res) => {
  const filters = {
    supplierId: v.optionalNumber(req.query.supplierId, "Supplier", { min: 1 }),
    status: v.optionalEnum(req.query.status, "Status", ["posted", "void"], null),
    ...readPage(req.query),
  };

  res.json({
    success: true,
    data: await purchaseReturnService.listPayments(req.user.restaurantId, filters),
  });
};

const readPaymentBody = (body, { partial = false } = {}) => ({
  paymentDate: notFuture(readDate(body.paymentDate, "Payment date", partial ? null : todayText()), "Payment date"),
  amount: partial && body.amount === undefined
    ? undefined
    : v.requiredNumber(body.amount, "Amount", { min: 0.01, max: 99999999 }),
  paymentMethod: v.optionalEnum(body.paymentMethod, "Payment method", PAYMENT_METHODS, partial ? null : "cash"),
  referenceNo: partial && body.referenceNo === undefined ? undefined : v.optionalString(body.referenceNo, "Reference", 50),
  notes: partial && body.notes === undefined ? undefined : v.optionalString(body.notes, "Notes", 500),
  paidFromTill: partial && body.paidFromTill === undefined
    ? undefined
    : v.requiredBoolean(body.paidFromTill, "Paid from the till", false),
});

const createPayment = async (req, res) => {
  const body = req.body || {};

  const data = {
    supplierId: v.requiredId(body.supplierId, "Supplier"),
    purchaseOrderId: v.optionalNumber(body.purchaseOrderId, "Purchase order", { min: 1 }),
    goodsReceiptId: v.optionalNumber(body.goodsReceiptId, "Purchase bill", { min: 1 }),
    ...readPaymentBody(body),
    // Cash from the till comes out of the drawer where this person works.
    tillOutletId: req.outletId || null,
  };

  const { id, payments } = await purchaseReturnService.createPayment(
    req.user.restaurantId,
    data,
    req.user.id
  );

  logAction(req, "payment", "supplier", {
    id: data.supplierId,
    label: payments.length ? payments[0].supplierName : null,
    details: {
      amount: data.amount,
      method: data.paymentMethod,
      paymentId: id,
      ...(data.paidFromTill ? { fromTill: true, till: (payments.find((row) => row.id === id) || {}).tillName } : {}),
    },
  });

  res.status(201).json({ success: true, message: "Payment recorded", data: payments, paymentId: id });
};

const updatePayment = async (req, res) => {
  const id = v.requiredId(req.params.paymentId, "Payment id");
  const body = req.body || {};
  const changeReason = v.requiredString(body.changeReason, "Why it is being changed", 200);

  const { before, after } = await purchaseReturnService.updatePayment(
    req.user.restaurantId,
    id,
    { ...readPaymentBody(body, { partial: true }), tillOutletId: req.outletId || null },
    req.user.id
  );

  logAction(req, "update", "supplier_payment", {
    id,
    label: `${after.supplierName} · PAY-${String(id).padStart(4, "0")}`,
    details: {
      reason: changeReason,
      before: { amount: before.amount, date: before.paymentDate, method: before.paymentMethod },
      after: { amount: after.amount, date: after.paymentDate, method: after.paymentMethod },
    },
  });

  res.json({ success: true, message: "Payment corrected", data: after });
};

const voidPayment = async (req, res) => {
  const id = v.requiredId(req.params.paymentId, "Payment id");
  const reason = v.requiredString(req.body?.reason, "Reason", 200);

  const payment = await purchaseReturnService.voidPayment(req.user.restaurantId, id, reason, req.user.id);

  logAction(req, "void", "supplier_payment", {
    id,
    label: `${payment.supplierName} · PAY-${String(id).padStart(4, "0")}`,
    details: { reason, amount: payment.amount },
  });

  res.json({ success: true, message: "Payment voided", data: payment });
};

const outstanding = async (req, res) => {
  res.json({ success: true, data: await purchaseReturnService.outstanding(req.user.restaurantId) });
};

const statement = async (req, res) => {
  const supplierId = v.requiredId(req.query.supplierId, "Supplier");
  const to = readDate(req.query.to, "To", todayText());
  const from = readDate(req.query.from, "From", `${to.slice(0, 8)}01`);

  res.json({
    success: true,
    data: await purchaseReturnService.statement(req.user.restaurantId, { supplierId, from, to }),
  });
};

module.exports = {
  list,
  getById,
  creditLimit,
  create,
  update,
  voidReturn,
  listPayments,
  createPayment,
  updatePayment,
  voidPayment,
  outstanding,
  statement,
};
