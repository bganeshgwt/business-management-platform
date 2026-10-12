const purchaseService = require("../services/purchase.service");
const inventoryService = require("../../inventory/services/inventory.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { readDate } = require("../../../../utils/calendarDate");

const todayText = () => new Date().toLocaleDateString("en-CA");

// GST slabs a supplier bill can carry. 0 covers fresh produce, milk and
// anything bought from an unregistered vendor.
const TAX_RATES = [0, 0.25, 3, 5, 12, 18, 28];

const readTaxRate = (value) => {
  const rate = v.optionalNumber(value, "GST rate", { min: 0, max: 28 });

  if (rate === null) {
    return null;
  }

  if (!TAX_RATES.includes(rate)) {
    throw new AppError(400, `GST rate must be one of ${TAX_RATES.join(", ")}%`);
  }

  return rate;
};

const PAYMENT_METHODS = ["cash", "card", "upi", "bank", "cheque", "other"];

// Paid on delivery or on credit, and — when paid — how, and whether the cash
// came out of the till (so the day-end count can allow for it).
const readSettlement = (req, body) => {
  const paymentMode = v.optionalEnum(body.paymentMode, "Payment", ["credit", "paid"], "credit");
  const paymentMethod = v.optionalEnum(body.paymentMethod, "Payment method", PAYMENT_METHODS, "cash");
  const paidFromTill = v.requiredBoolean(body.paidFromTill, "Paid from the till", false);

  if (paymentMode === "paid" && !(req.user.permissions || []).includes("purchasing.pay")) {
    throw new AppError(
      403,
      "Recording a payment needs the 'Pay suppliers' permission. Save the bill on credit instead."
    );
  }

  if (paymentMode === "paid" && paidFromTill && paymentMethod !== "cash") {
    throw new AppError(400, "Only cash can come out of the till");
  }

  return {
    paymentMode,
    paymentMethod,
    paidFromTill: paymentMode === "paid" && paidFromTill,
    // Cash from the till comes out of the drawer where this person works.
    tillOutletId: paymentMode === "paid" && paidFromTill ? req.outletId || null : null,
    paymentReference: v.optionalString(body.paymentReference, "Payment reference", 50),
  };
};

const readBillHeader = (body) => {
  const billDate = readDate(body.billDate, "Bill date", todayText());
  const receivedDate = readDate(body.receivedDate, "Received date", billDate);

  if (billDate > todayText() || receivedDate > todayText()) {
    throw new AppError(400, "A bill cannot be dated in the future");
  }

  if (receivedDate < billDate) {
    throw new AppError(400, "Goods cannot arrive before the bill date");
  }

  return {
    billNumber: v.optionalString(body.billNumber, "Bill number", 50),
    billDate,
    receivedDate,
    pricesIncludeTax: v.requiredBoolean(body.pricesIncludeTax, "Prices include GST", false),
    billTotal: v.optionalNumber(body.billTotal, "Bill total", { min: 0, max: 99999999 }),
    notes: v.optionalString(body.notes, "Notes", 500),
  };
};

const list = async (req, res) => {
  const filters = {
    status: v.enumList(req.query.status, "Status", [
      "draft",
      "pending_approval",
      "ordered",
      "partial",
      "received",
      "closed",
      "cancelled",
    ]),
    supplierId: v.optionalNumber(req.query.supplierId, "Supplier", { min: 1 }),
    search: v.optionalString(req.query.search, "Search", 60),
    // Order dates, both ends included. The screen opens on this month's
    // orders; a status or a search looks across every date.
    from: readDate(req.query.from, "From date"),
    to: readDate(req.query.to, "To date"),
  };

  if (filters.from && filters.to && filters.from > filters.to) {
    throw new AppError(400, "Pick a start date on or before the end date");
  }

  // Someone tied to one outlet sees the orders of the store they work with
  // (its own store, or the main store when the outlet sells from it), not
  // the whole chain's 800 orders and dues.
  if (req.outletPinned) {
    const store = await inventoryService.pinnedStore(req.user.restaurantId, req.outletId);

    if (store) {
      filters.store = store.mode === "outlet" ? { outletId: store.storeId } : { main: true };
    }
  }

  res.json({ success: true, data: await purchaseService.list(req.user.restaurantId, filters) });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "Purchase order id");

  res.json({ success: true, data: await purchaseService.getById(req.user.restaurantId, id) });
};

const readOrderBody = (body) => {
  const data = {
    supplierId: v.requiredId(body.supplierId, "Supplier"),
    orderDate: readDate(body.orderDate, "Order date", todayText()),
    expectedDate: readDate(body.expectedDate, "Expected date"),
    notes: v.optionalString(body.notes, "Notes", 500),
    // In packs when a pack is chosen: quantity is packs, price is per pack.
    items: v.requiredArray(body.items, "Items").map((item) => ({
      inventoryItemId: v.requiredId(item.inventoryItemId, "Item"),
      packId: v.optionalNumber(item.packId, "Pack", { min: 1 }),
      quantity: v.requiredNumber(item.quantity, "Quantity", { min: 0.001, max: 9999999 }),
      unitPrice: v.requiredNumber(item.unitPrice, "Unit price", { min: 0, max: 9999999 }),
    })),
  };

  if (data.expectedDate && data.expectedDate < data.orderDate) {
    throw new AppError(400, "The expected date cannot be before the order date");
  }

  return data;
};

const create = async (req, res) => {
  const body = req.body || {};

  const data = {
    ...readOrderBody(body),
    poStatus: v.optionalEnum(body.poStatus, "Status", ["draft", "ordered"], "draft"),
    // Goods for this order go to the store of the outlet it was raised in.
    outletId: req.outletId || null,
  };

  const order = await purchaseService.create(req.user.restaurantId, data, req.user.id, {
    canApprove: canApprove(req),
  });

  logAction(req, "create", "purchase_order", { id: order.id, label: order.poNumber });
  logApprovalStep(req, order);

  res.status(201).json({
    success: true,
    message:
      order.approvalStep === "requested"
        ? `${order.poNumber} is over the approval limit, so it is waiting for approval`
        : "Purchase order created",
    data: order,
  });
};

// Whether this person may approve orders over the limit themselves.
const canApprove = (req) => (req.user.permissions || []).includes("purchasing.approve");

// Ordering over the limit: the request for approval, or the person's own
// approval, goes on the activity log beside the status change.
const logApprovalStep = (req, order) => {
  if (order.approvalStep === "requested") {
    logAction(req, "approval_requested", "purchase_order", {
      id: order.id,
      label: order.poNumber,
      details: { total: order.totalAmount, limit: order.approvalLimit, supplier: order.supplierName },
    });
  } else if (order.approvalStep === "self") {
    logAction(req, "approve", "purchase_order", {
      id: order.id,
      label: order.poNumber,
      details: { total: order.totalAmount, supplier: order.supplierName, how: "Approved by the person ordering" },
    });
  }
};

// Someone tied to one outlet may change, cancel or delete only the orders
// raised for the store they work with — the same rule as receiving one. An
// order raised with no outlet is the main store's. The order list is that
// store's too (see list).
const requireOwnOrder = async (req, id) => {
  if (!req.outletPinned) {
    return;
  }

  const order = await purchaseService.getById(req.user.restaurantId, id);

  try {
    await inventoryService.requirePinnedStore(req.user.restaurantId, req.outletId, order.outletId || null);
  } catch (error) {
    if (error.statusCode === 403 && String(error.message).startsWith("You are set up to work at one outlet only")) {
      throw new AppError(
        403,
        `${order.poNumber} is for ${order.storeName}. You are set up to work at one outlet only, so you can change only its own orders. Ask your manager if this one needs changing.`
      );
    }

    throw error;
  }
};

const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Purchase order id");
  await requireOwnOrder(req, id);
  const order = await purchaseService.updateDraft(
    req.user.restaurantId,
    id,
    readOrderBody(req.body || {}),
    req.user.id
  );

  logAction(req, "update", "purchase_order", {
    id: order.id,
    label: order.poNumber,
    details: { total: order.totalAmount, lines: order.items.length },
  });

  res.json({ success: true, message: "Draft updated", data: order });
};

// "draft" is the buyer taking back an order that is waiting for approval,
// to change it.
const changeStatus = async (req, res) => {
  const id = v.requiredId(req.params.id, "Purchase order id");
  const status = v.requiredEnum(req.body?.status, "Status", ["ordered", "cancelled", "closed", "draft"]);
  const reason = v.optionalString(req.body?.reason, "Reason", 200);

  await requireOwnOrder(req, id);

  const order = await purchaseService.changeStatus(req.user.restaurantId, id, status, req.user.id, reason, {
    canApprove: canApprove(req),
  });

  logAction(req, "status_change", "purchase_order", {
    id: order.id,
    label: order.poNumber,
    details: {
      status: order.approvalStep === "requested" ? "pending_approval" : status,
      ...(reason ? { reason } : {}),
    },
  });
  logApprovalStep(req, order);

  const words = { ordered: "marked ordered", cancelled: "cancelled", closed: "closed short", draft: "taken back to change" };

  res.json({
    success: true,
    message:
      order.approvalStep === "requested"
        ? `${order.poNumber} is over the approval limit, so it is waiting for approval`
        : `Order ${words[status]}`,
    data: order,
  });
};

// Approving and sending back an order over the limit. Run before the
// approval check (purchase.routes.js): the order must be this restaurant's,
// the pinned person's own store's, and still waiting — and a send-back must
// say why — so a manager's PIN is never spent on a step that is then refused.
const checkApprovalStep = async (req, res, next) => {
  const id = v.requiredId(req.params.id, "Purchase order id");

  if (req.path.endsWith("/reject")) {
    v.requiredString(req.body?.note, "Why it is being sent back", 300);
  } else {
    v.optionalString(req.body?.note, "Note", 300);
  }

  await requireOwnOrder(req, id);
  req.waitingOrder = await purchaseService.requireWaiting(req.user.restaurantId, id);

  next();
};

// The approver: the person signed in when they hold the right, otherwise the
// manager whose PIN approved this one step.
const approverOf = (req) => (req.approval ? req.approval.approverId : req.user.id);

const approve = async (req, res) => {
  const id = v.requiredId(req.params.id, "Purchase order id");
  const note = v.optionalString(req.body?.note, "Note", 300);
  const order = await purchaseService.approve(req.user.restaurantId, id, approverOf(req), note, req.user.id);

  logAction(req, "approve", "purchase_order", {
    id: order.id,
    label: order.poNumber,
    details: { total: order.totalAmount, supplier: order.supplierName, ...(note ? { note } : {}) },
  });

  res.json({ success: true, message: `${order.poNumber} approved and marked ordered`, data: order });
};

const reject = async (req, res) => {
  const id = v.requiredId(req.params.id, "Purchase order id");
  const note = v.requiredString(req.body?.note, "Why it is being sent back", 300);
  const order = await purchaseService.sendBack(req.user.restaurantId, id, approverOf(req), note, req.user.id);

  logAction(req, "reject", "purchase_order", {
    id: order.id,
    label: order.poNumber,
    details: { total: order.totalAmount, supplier: order.supplierName, note },
  });

  res.json({ success: true, message: `${order.poNumber} sent back to the buyer as a draft`, data: order });
};

// Goods arrive line by line, so partial deliveries are normal. Each delivery
// records the supplier's bill, the price actually charged and anything turned
// away at the door.
const receive = async (req, res) => {
  const id = v.requiredId(req.params.id, "Purchase order id");
  const body = req.body || {};

  const lines = v
    .requiredArray(body.lines, "Lines")
    .map((line) => ({
      itemId: v.requiredId(line.itemId, "Line id"),
      batchNumber: v.optionalString(line.batchNumber, "Batch number", 100),
      expiryDate: readDate(line.expiryDate, "Expiry date"),
      quantity: v.requiredNumber(line.quantity ?? 0, "Received quantity", { min: 0, max: 9999999 }),
      rejectedQuantity: v.optionalNumber(line.rejectedQuantity, "Rejected quantity", { min: 0, max: 9999999 }) ?? 0,
      rejectionReason: v.optionalString(line.rejectionReason, "Rejection reason", 150),
      unitPrice: v.optionalNumber(line.unitPrice, "Billed price", { min: 0, max: 9999999 }),
      taxRate: readTaxRate(line.taxRate),
    }))
    .filter((line) => line.quantity > 0 || line.rejectedQuantity > 0);

  for (const line of lines) {
    if (line.rejectedQuantity > 0 && !line.rejectionReason) {
      throw new AppError(400, "Say why goods were turned away (damaged, wrong item, short weight…)");
    }
  }

  const header = readBillHeader(body);

  // Goods for an order go into the store of the outlet it was raised in (or,
  // for an order raised without one, the outlet receiving it). Someone tied
  // to one outlet receives into their own store only.
  if (req.outletPinned) {
    const raised = await purchaseService.getById(req.user.restaurantId, id);

    await inventoryService.requirePinnedStore(req.user.restaurantId, req.outletId, raised.outletId || req.outletId);
  }

  const order = await purchaseService.receive(
    req.user.restaurantId,
    id,
    { ...header, ...readSettlement(req, body), lines, outletId: req.outletId || null },
    req.user.id
  );

  logAction(req, "receive", "purchase_order", {
    id: order.id,
    label: order.poNumber,
    details: {
      bill: header.billNumber,
      receipt: order.receipts.length ? order.receipts[order.receipts.length - 1].receiptNumber : null,
      store: order.receivedInto,
      ...(order.storeNote ? { storeNote: order.storeNote } : {}),
    },
  });

  res.json({
    success: true,
    message: order.storeNote
      ? `Goods received and stock updated. ${order.storeNote}`
      : "Goods received and stock updated",
    data: order,
  });
};

const remove = async (req, res) => {
  const id = v.requiredId(req.params.id, "Purchase order id");

  await requireOwnOrder(req, id);
  await purchaseService.remove(req.user.restaurantId, id);

  logAction(req, "delete", "purchase_order", { id });

  res.json({ success: true, message: "Purchase order deleted" });
};

// --- Purchase bills ---

const listReceipts = async (req, res) => {
  const filters = {
    from: readDate(req.query.from, "From"),
    to: readDate(req.query.to, "To"),
    supplierId: v.optionalNumber(req.query.supplierId, "Supplier", { min: 1 }),
    kind: v.optionalEnum(req.query.kind, "Kind", ["direct", "po"], null),
    status: v.optionalEnum(req.query.status, "Status", ["posted", "void"], null),
    search: v.optionalString(req.query.search, "Search", 60),
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 1000 }) ?? 200,
  };

  res.json({ success: true, data: await purchaseService.listReceipts(req.user.restaurantId, filters) });
};

const getReceipt = async (req, res) => {
  const id = v.requiredId(req.params.receiptId, "Bill id");

  res.json({ success: true, data: await purchaseService.getReceipt(req.user.restaurantId, id) });
};

const createReceipt = async (req, res) => {
  const body = req.body || {};

  const lines = v.requiredArray(body.lines, "Lines").map((line) => {
    const quantity = v.requiredNumber(line.quantity ?? 0, "Quantity", { min: 0, max: 9999999 });
    const rejectedQuantity = v.optionalNumber(line.rejectedQuantity, "Rejected quantity", { min: 0, max: 9999999 }) ?? 0;

    if (quantity <= 0 && rejectedQuantity <= 0) {
      throw new AppError(400, "Every line needs a quantity");
    }

    const rejectionReason = v.optionalString(line.rejectionReason, "Rejection reason", 150);

    if (rejectedQuantity > 0 && !rejectionReason) {
      throw new AppError(400, "Say why goods were turned away (damaged, wrong item, short weight…)");
    }

    return {
      inventoryItemId: v.requiredId(line.inventoryItemId, "Item"),
      packId: v.optionalNumber(line.packId, "Pack", { min: 1 }),
      quantity,
      rejectedQuantity,
      rejectionReason,
      batchNumber: v.optionalString(line.batchNumber, "Batch number", 100),
      expiryDate: readDate(line.expiryDate, "Expiry date"),
      unitPrice: v.requiredNumber(line.unitPrice, "Price", { min: 0, max: 9999999 }),
      taxRate: readTaxRate(line.taxRate) ?? 0,
    };
  });

  const data = {
    supplierId: v.requiredId(body.supplierId, "Supplier"),
    ...readBillHeader(body),
    ...readSettlement(req, body),
    lines,
    outletId:
      body.outletId === undefined ? req.outletId || null : v.optionalNumber(body.outletId, "Store", { min: 1 }),
  };

  // Someone tied to one outlet receives goods into their own store only: a
  // store named in the body is a request, checked like any other.
  if (req.outletPinned) {
    await inventoryService.requirePinnedStore(req.user.restaurantId, req.outletId, data.outletId);
  }

  const receipt = await purchaseService.createDirect(req.user.restaurantId, data, req.user.id);

  logAction(req, "create", "purchase_bill", {
    id: receipt.id,
    label: receipt.billNumber ? `${receipt.receiptNumber} · Bill ${receipt.billNumber}` : receipt.receiptNumber,
    details: { supplier: receipt.supplierName, total: receipt.totalAmount, payment: receipt.paymentMode },
  });

  res.status(201).json({
    success: true,
    message: `Purchase bill ${receipt.receiptNumber} saved and stock added`,
    data: receipt,
  });
};

// The payments this void took down with the bill (paid on delivery).
const voidedWithBill = (receipt) =>
  receipt.payments
    .filter((payment) => payment.status === "void" && (payment.voidReason || "").startsWith(`Bill ${receipt.receiptNumber} voided`))
    .map((payment) => ({ amount: payment.amount, method: payment.paymentMethod, fromTill: payment.paidFromTill }));

const voidReceipt = async (req, res) => {
  const id = v.requiredId(req.params.receiptId, "Bill id");
  const reason = v.requiredString(req.body?.reason, "Reason", 200);

  const receipt = await purchaseService.voidReceipt(req.user.restaurantId, id, reason, req.user.id, {
    mayVoidPayments: (req.user.permissions || []).includes("purchasing.pay") || Boolean(req.approval),
  });

  logAction(req, "void", "purchase_bill", {
    id: receipt.id,
    label: receipt.receiptNumber,
    details: {
      reason,
      total: receipt.totalAmount,
      supplier: receipt.supplierName,
      // A payment voided with the bill is named, so the activity log shows
      // that money handed over was taken off the books, and who approved it.
      ...(voidedWithBill(receipt).length > 0 ? { paymentsVoided: voidedWithBill(receipt) } : {}),
    },
  });

  res.json({ success: true, message: `${receipt.receiptNumber} voided and its stock taken back out`, data: receipt });
};

const register = async (req, res) => {
  const to = readDate(req.query.to, "To", todayText());
  const from = readDate(req.query.from, "From", `${to.slice(0, 8)}01`);

  res.json({
    success: true,
    data: await purchaseService.register(req.user.restaurantId, {
      from,
      to,
      supplierId: v.optionalNumber(req.query.supplierId, "Supplier", { min: 1 }),
    }),
  });
};

module.exports = {
  list,
  getById,
  create,
  update,
  changeStatus,
  checkApprovalStep,
  approve,
  reject,
  receive,
  remove,
  listReceipts,
  getReceipt,
  createReceipt,
  voidReceipt,
  register,
};
