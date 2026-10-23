const purchaseRepository = require("../repositories/purchase.repository");
const supplierRepository = require("../repositories/supplier.repository");
const inventoryRepository = require("../../inventory/repositories/inventory.repository");
const stockSettingsService = require("../../inventory/services/stockSettings.service");
const { openDayOf } = require("../../business-day/services/tradingDay");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { MAX_AMOUNT, amountOf, checkAmount, checkPackQuantity, checkStockValue, rupees } = require("../../../../utils/amountLimit");

const round3 = (value) => Math.round(Number(value) * 1000) / 1000;
// Per-unit prices and costs keep eight decimals: 15,000 ml at ₹2,150 is
// ₹0.14333333 a ml, and 15,000 of those come back to ₹2,150.00 exactly.
const round8 = (value) => Math.round(Number(value) * 1e8) / 1e8;

// One rounding rule for the price a line is typed at, on an order, a bill and
// a delivery alike, so an order and the bill it becomes agree to the paisa.
// A price per tin, tray or case is what the supplier charges for it — money,
// kept to the paisa (₹2,150.125 a tin is ₹2,150.13). A price per unit of the
// item keeps eight decimals (₹0.14333333 a ml). Bills used to keep the tin
// price unrounded, so 3 tins came to ₹6,450.38 on the bill and ₹6,450.39 on
// the order.
const buyingPrice = (price, inPacks) => (inPacks ? round2(price) : round8(price));

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

const toReceiptSummary = (row) => ({
  id: row.id,
  receiptNumber: row.receipt_number,
  billNumber: row.bill_number,
  billDate: row.bill_date,
  receivedDate: row.received_date,
  totalAmount: Number(row.total_amount),
  status: row.receipt_status,
  paymentMode: row.payment_mode,
});

const toOrder = (row) => ({
  id: row.id,
  poNumber: row.po_number,
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  supplierMobile: row.supplier_mobile ?? null,
  supplierEmail: row.supplier_email ?? null,
  supplierGstin: row.supplier_gstin ?? null,
  supplierAddress: row.supplier_address ?? null,
  supplierContact: row.supplier_contact ?? null,
  outletId: row.outlet_id ?? null,
  storeName: row.outlet_id ? row.outlet_name : "Main store",
  // The outlet it was raised for has closed since: a delivery against it now
  // goes into the main store (see purchaseRepository.receive).
  outletClosed: Boolean(row.outlet_id) && row.outlet_status !== undefined && row.outlet_status !== "active",
  orderDate: row.order_date,
  expectedDate: row.expected_date,
  totalAmount: Number(row.total_amount),
  billedAmount: row.billed_amount === undefined ? undefined : Number(row.billed_amount),
  receiptCount: row.receipt_count,
  poStatus: row.po_status,
  closedReason: row.closed_reason ?? null,
  notes: row.notes,
  createdByName: row.created_by_name,
  // Over the approval limit: who asked, who approved (and the total they
  // saw), or who sent it back and why. Printed on the order.
  approval: {
    requestedAt: row.approval_requested_at ?? null,
    requestedByName: row.approval_requested_by_name ?? null,
    approvedAt: row.approved_at ?? null,
    approvedByName: row.approved_by_name ?? null,
    approvedAmount: row.approved_amount === null || row.approved_amount === undefined ? null : Number(row.approved_amount),
    note: row.approval_note ?? null,
    rejectedAt: row.rejected_at ?? null,
    rejectedByName: row.rejected_by_name ?? null,
    rejectionNote: row.rejection_note ?? null,
  },
  itemCount: row.item_count ?? (row.items ? row.items.length : undefined),
  items: (row.items || []).map((item) => ({
    id: item.id,
    inventoryItemId: item.inventory_item_id,
    itemName: item.item_name,
    unitShortName: item.unit_short_name,
    quantity: Number(item.quantity),
    receivedQuantity: Number(item.received_quantity),
    outstandingQuantity: round3(Number(item.quantity) - Number(item.received_quantity)),
    unitPrice: Number(item.unit_price),
    amount: Number(item.amount),
    // Ordered in packs: "2 tins at ₹2,150" — the base quantity above is 30 L.
    packId: item.pack_id ?? null,
    packName: item.pack_name ?? null,
    packSize: numberOrNull(item.pack_size),
    packQuantity: numberOrNull(item.pack_quantity),
    packPrice: numberOrNull(item.pack_price),
  })),
  receipts: (row.receipts || []).map(toReceiptSummary),
});

const list = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  const rows = await purchaseRepository.findAll(restaurantId, filters);
  return rows.map(toOrder);
};

const getById = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const row = await purchaseRepository.findById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Purchase order not found");
  }

  return toOrder(row);
};

// The supplier, every item and every pack must belong to this restaurant,
// otherwise a purchase order could point at another tenant's data. Lines come
// back priced: a line in packs keeps what was typed (2 tins at ₹2,150) and
// also carries the item's own unit (30,000 ml at ₹0.14333333), which is what
// stock, receiving and reorder figures read.
const priceOrderLines = async (restaurantId, items) => {
  if (items.length === 0) {
    throw new AppError(400, "Add at least one item");
  }

  const seen = new Set();
  const priced = [];

  for (const item of items) {
    const key = `${item.inventoryItemId}`;

    if (seen.has(key)) {
      throw new AppError(400, "The same item is listed twice");
    }

    seen.add(key);

    const inventoryItem = await inventoryRepository.findItemById(restaurantId, item.inventoryItemId);

    if (!inventoryItem) {
      throw new AppError(400, "One of the selected items does not exist");
    }

    if (item.packId) {
      const pack = await inventoryRepository.findPackById(restaurantId, item.packId);

      if (!pack || Number(pack.inventory_item_id) !== Number(item.inventoryItemId)) {
        throw new AppError(400, `That pack is not one of ${inventoryItem.name}'s packs`);
      }

      // A price per tin or per tray is what the supplier charges for it: money,
      // kept to the paisa (see buyingPrice).
      const packPrice = buyingPrice(item.unitPrice, true);
      const amount = checkAmount(round2(Number(item.quantity) * packPrice), inventoryItem.name);
      const base = round3(
        checkPackQuantity(item.quantity, pack, inventoryItem.name, inventoryItem.unit_short_name)
      );

      priced.push({
        inventoryItemId: item.inventoryItemId,
        quantity: base,
        unitPrice: base > 0 ? round8(amount / base) : 0,
        amount,
        packId: pack.id,
        packName: pack.name,
        packSize: Number(pack.size),
        packQuantity: Number(item.quantity),
        packPrice,
      });
    } else {
      const unitPrice = buyingPrice(item.unitPrice, false);

      priced.push({
        inventoryItemId: item.inventoryItemId,
        quantity: Number(item.quantity),
        unitPrice,
        amount: checkAmount(round2(Number(item.quantity) * unitPrice), inventoryItem.name),
      });
    }
  }

  checkAmount(round2(priced.reduce((sum, line) => sum + line.amount, 0)), "This order");

  return priced;
};

const requireSupplier = async (restaurantId, supplierId) => {
  const supplier = await supplierRepository.findById(restaurantId, supplierId);

  if (!supplier) {
    throw new AppError(400, "Selected supplier does not exist");
  }

  return supplier;
};

// Used by the Purchase orders screen and by Waste & reorder's "make draft PO".
// Both call it the same way: { supplierId, orderDate, expectedDate, poStatus,
// notes, items: [{ inventoryItemId, quantity, unitPrice, packId? }] }.
//
// An order raised straight as "ordered" goes through the same approval rule
// as marking a draft ordered: over the limit, it waits for an approver.
// options.canApprove: the person may approve orders over the limit.
const create = async (restaurantId, data, userId, options = {}) => {
  requireRestaurantId(restaurantId);
  await requireSupplier(restaurantId, data.supplierId);

  const items = await priceOrderLines(restaurantId, data.items || []);
  const order = await purchaseRepository.create(
    restaurantId,
    { ...data, poStatus: data.poStatus === "ordered" ? "draft" : data.poStatus, items },
    userId
  );

  if (data.poStatus === "ordered") {
    return changeStatus(restaurantId, order.id, "ordered", userId, null, options);
  }

  return toOrder(order);
};

// A draft can be changed freely: nothing has been sent to the supplier yet.
const updateDraft = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  // An order that is not this restaurant's is not found, whatever the body says.
  if (!(await purchaseRepository.findById(restaurantId, id))) {
    throw new AppError(404, "Purchase order not found");
  }

  await requireSupplier(restaurantId, data.supplierId);

  const items = await priceOrderLines(restaurantId, data.items || []);
  const result = await purchaseRepository.updateDraft(restaurantId, id, { ...data, items }, userId);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Purchase order not found");
  }

  if (result.error === "NOT_DRAFT") {
    throw new AppError(
      409,
      `Only a draft can be edited — this order is ${result.status}. Cancel it and raise a new one if it has to change.`
    );
  }

  return toOrder(result.order);
};

const VALID_TRANSITIONS = {
  draft: ["ordered", "cancelled"],
  // Waiting for an approver: the buyer can take it back to change it, or
  // cancel it. Approving and sending back have their own steps.
  pending_approval: ["draft", "cancelled"],
  ordered: ["cancelled"],
  // Part received: the rest either comes (receive) or it does not (close).
  partial: ["closed"],
};

const STATUS_WORDS = {
  draft: "a draft",
  pending_approval: "a waiting",
  ordered: "an ordered",
  partial: "a part-received",
  received: "a received",
  closed: "a closed",
  cancelled: "a cancelled",
};

// Status moves one way only. Received and closed orders are final because
// stock has already changed; an order with goods on the shelf is closed short
// rather than cancelled, so what did arrive stays on record.
// options.canApprove: the person holds "Approve purchase orders over the
// limit". The answer carries `approvalStep`: "requested" when the order went
// to wait for an approver instead of being marked ordered, "self" when the
// person's own right approved it, null when no approval was needed.
const changeStatus = async (restaurantId, id, status, userId, reason = null, options = {}) => {
  requireRestaurantId(restaurantId);

  const order = await purchaseRepository.findById(restaurantId, id);

  if (!order) {
    throw new AppError(404, "Purchase order not found");
  }

  if (status === "cancelled" && order.po_status === "partial") {
    throw new AppError(
      409,
      "Some goods have already been received on this order. Close it short instead, so the rest is no longer expected."
    );
  }

  const allowed = VALID_TRANSITIONS[order.po_status] || [];

  if (!allowed.includes(status)) {
    const words =
      order.po_status === "pending_approval" && status === "ordered"
        ? `${order.po_number} is waiting for approval. An approver approves it (or sends it back) from the order.`
        : `${STATUS_WORDS[order.po_status] || "This"} order cannot be changed to ${status}`.replace(/^a/, "A");

    throw new AppError(409, words);
  }

  // Marking a draft ordered: over the approval limit it waits for an
  // approver, unless the person may approve it themselves.
  if (status === "ordered") {
    const settings = await stockSettingsService.get(restaurantId);
    const over = stockSettingsService.overLimit(settings.poApprovalLimit, Number(order.total_amount));

    if (over && !options.canApprove) {
      if (!(await purchaseRepository.requestApproval(restaurantId, id, userId))) {
        throw new AppError(409, `${order.po_number} has just been changed by someone else. Open it again.`);
      }

      return { ...(await getById(restaurantId, id)), approvalStep: "requested", approvalLimit: settings.poApprovalLimit };
    }

    const moved = await purchaseRepository.markOrdered(
      restaurantId,
      id,
      userId,
      over ? { approvedBy: userId, note: "Approved when ordering", fromWaiting: false } : null
    );

    if (!moved) {
      throw new AppError(409, `${order.po_number} has just been changed by someone else. Open it again.`);
    }

    return { ...(await getById(restaurantId, id)), approvalStep: over ? "self" : null };
  }

  if (status === "draft") {
    if (!(await purchaseRepository.returnToDraft(restaurantId, id, userId, null))) {
      throw new AppError(409, `${order.po_number} is no longer waiting for approval. Open it again.`);
    }

    return getById(restaurantId, id);
  }

  await purchaseRepository.updateStatus(
    restaurantId,
    id,
    status,
    userId,
    status === "closed" ? reason || "The supplier will not send the rest" : null
  );

  return getById(restaurantId, id);
};

const PO_WORDS = {
  draft: "a draft",
  pending_approval: "waiting for approval",
  ordered: "ordered",
  partial: "part received",
  received: "received",
  closed: "closed short",
  cancelled: "cancelled",
};

// An order waiting for approval, as the approve and send-back steps need it:
// found in this restaurant, and still waiting. Checked before a manager is
// asked for a PIN, so an approval is never spent on an order that cannot be
// approved.
const requireWaiting = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const order = await purchaseRepository.findById(restaurantId, id);

  if (!order) {
    throw new AppError(404, "Purchase order not found");
  }

  if (order.po_status !== "pending_approval") {
    throw new AppError(
      409,
      `${order.po_number} is not waiting for approval — it is ${PO_WORDS[order.po_status] || order.po_status}.`
    );
  }

  return toOrder(order);
};

// The approver's yes: the order goes to the supplier ("ordered"), with who
// approved it and the total they approved, printed on the order.
const approve = async (restaurantId, id, approverId, note, actorId) => {
  const order = await requireWaiting(restaurantId, id);
  const moved = await purchaseRepository.markOrdered(restaurantId, id, actorId, {
    approvedBy: approverId,
    note: note || null,
    fromWaiting: true,
  });

  if (!moved) {
    throw new AppError(409, `${order.poNumber} has just been approved or sent back by someone else. Open it again.`);
  }

  return getById(restaurantId, id);
};

// The approver's no, with why: the order goes back to the buyer as a draft,
// the note on it, to change and send again (or cancel).
const sendBack = async (restaurantId, id, rejectedBy, note, actorId) => {
  const order = await requireWaiting(restaurantId, id);
  const moved = await purchaseRepository.returnToDraft(restaurantId, id, actorId, { rejectedBy, note });

  if (!moved) {
    throw new AppError(409, `${order.poNumber} has just been approved or sent back by someone else. Open it again.`);
  }

  return getById(restaurantId, id);
};

// --- Pricing a delivery ---

// One line of a supplier's bill. The price is per buying unit (a tin, a kg)
// as printed; `pricesIncludeTax` says whether that price already has GST in
// it. What goes on the shelf is costed at the full amount paid, GST included:
// a restaurant on 5% GST cannot take the input credit back, so the tax is
// part of what the food costs. `inPacks` says the line is bought in packs, so
// its price is a pack price and is kept to the paisa, as on the order.
const priceBillLine = ({ billQuantity, rejectedQuantity, unitPrice: typedPrice, taxRate, packSize, inPacks = false }, pricesIncludeTax) => {
  const unitPrice = buyingPrice(typedPrice, inPacks);
  const quantityBilled = round3(billQuantity);
  const gross = round2(quantityBilled * unitPrice);
  let taxable;
  let tax;
  let amount;

  if (pricesIncludeTax) {
    amount = gross;
    taxable = round2(gross / (1 + taxRate / 100));
    tax = round2(amount - taxable);
  } else {
    taxable = gross;
    tax = round2((taxable * taxRate) / 100);
    amount = round2(taxable + tax);
  }

  const quantity = round3(quantityBilled * (packSize || 1));

  return {
    billQuantity: quantityBilled,
    rejectedQuantity: round3(rejectedQuantity || 0),
    quantity,
    unitPrice,
    taxRate,
    taxableAmount: taxable,
    taxAmount: tax,
    amount,
    unitCost: quantity > 0 ? round8(amount / quantity) : 0,
  };
};

// The bill's totals from its lines. When the person types the total printed
// on the paper bill, the paise it was rounded by are recorded as round off —
// and anything bigger than a rupee means a line was typed wrong.
const billTotals = (lines, billTotal) => {
  const taxableAmount = round2(lines.reduce((sum, line) => sum + line.taxableAmount, 0));
  const taxAmount = round2(lines.reduce((sum, line) => sum + line.taxAmount, 0));
  const computed = round2(taxableAmount + taxAmount);
  const roundOff = billTotal === null || billTotal === undefined ? 0 : round2(billTotal - computed);

  if (Math.abs(roundOff) > 1) {
    return { error: "BILL_MISMATCH", computed, billTotal };
  }

  return { taxableAmount, taxAmount, roundOff, totalAmount: round2(computed + roundOff) };
};

const addDays = (date, days) => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

// How a bill is settled: on credit (due after the supplier's credit days) or
// paid on delivery, which writes the payment at the same time.
const settlement = async (restaurantId, supplier, data) => {
  if (data.paymentMode === "paid") {
    // The day open at the till that paid: a branch with days of its own
    // trades on its own day, any other till on the main counter's.
    const day = data.paidFromTill ? await openDayOf(restaurantId, data.tillOutletId || null) : null;

    if (data.paidFromTill && !day) {
      throw new AppError(
        400,
        "Cash from the till needs an open business day. Open the day first, or mark it paid from the office."
      );
    }

    return {
      dueDate: null,
      businessDate: day ? day.business_date : null,
    };
  }

  return {
    dueDate: addDays(data.billDate, Number(supplier.credit_days || 0)),
    businessDate: null,
  };
};

// A bill whose lines add up past the limit is refused as a whole, even when
// each line alone is under it.
const checkBillTotal = (totals) => {
  if (!totals.error) {
    checkAmount(totals.totalAmount, "This bill");
  }

  return totals;
};

const mismatchMessage = (totals) =>
  `The lines add up to ₹${totals.computed.toFixed(2)} but the bill total is ₹${Number(totals.billTotal).toFixed(2)}. Check the quantities, prices and GST.`;

const receive = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  if (data.lines.length === 0) {
    throw new AppError(400, "Enter the quantity received for at least one item");
  }

  const order = await purchaseRepository.findById(restaurantId, id);

  if (!order) {
    throw new AppError(404, "Purchase order not found");
  }

  const supplier = await supplierRepository.findById(restaurantId, order.supplier_id);
  const billDate = data.billDate || data.receivedDate;
  const settled = await settlement(restaurantId, supplier, { ...data, billDate });

  const result = await purchaseRepository.receive(
    restaurantId,
    id,
    {
      ...data,
      ...settled,
      billDate,
      outletId: data.outletId,
      // Thrown inside the delivery's transaction, which rolls it back.
      totals: (lines) => checkBillTotal(billTotals(lines, data.billTotal)),
    },
    userId,
    (line, orderLine) => {
      const inPacks = orderLine.pack_size !== null;
      const listed = inPacks && orderLine.pack_price !== null ? orderLine.pack_price : orderLine.unit_price;

      if (inPacks) {
        checkPackQuantity(
          line.quantity,
          { name: orderLine.pack_name, size: orderLine.pack_size },
          orderLine.item_name,
          orderLine.unit_short_name
        );
      }

      const priced = priceBillLine(
        {
          billQuantity: line.quantity,
          rejectedQuantity: line.rejectedQuantity,
          // The price actually billed, or the order's price if the bill
          // matches it.
          unitPrice: line.unitPrice ?? Number(listed),
          taxRate: line.taxRate ?? 0,
          packSize: inPacks ? Number(orderLine.pack_size) : 1,
          inPacks,
        },
        data.pricesIncludeTax
      );

      checkAmount(priced.amount, orderLine.item_name);
      checkStockValue(orderLine.current_stock, priced.quantity, priced.unitCost, orderLine.item_name, orderLine.unit_short_name);

      return {
        inventoryItemId: orderLine.inventory_item_id,
        packId: orderLine.pack_id,
        packName: orderLine.pack_name,
        packSize: inPacks ? Number(orderLine.pack_size) : null,
        rejectionReason: line.rejectionReason,
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate,
        ...priced,
      };
    }
  );

  if (result.error === "NOT_FOUND" || result.error === "LINE_NOT_FOUND") {
    throw new AppError(404, "Purchase order not found");
  }

  if (result.error === "DUPLICATE_LINE") {
    throw new AppError(400, "The same order line is listed twice");
  }

  if (result.error === "BAD_STATUS") {
    const message =
      result.status === "draft"
        ? "Mark the order as ordered before receiving goods"
        : result.status === "pending_approval"
          ? "This order is waiting for approval. Goods can be received once it is approved."
          : `A ${result.status} order cannot receive goods`;

    throw new AppError(409, message);
  }

  if (result.error === "TOO_MUCH") {
    throw new AppError(
      400,
      `Only ${result.outstanding} ${result.unit} of ${result.itemName} is still outstanding on this order. Enter the extra as a separate purchase bill.`
    );
  }

  // Turned away at the door is part of what came for this order, so it can
  // be no more than was still due on the line. 50 kg "turned away" on a 2 kg
  // order was a typing slip, and it sat on the delivery for ever.
  if (result.error === "TOO_MANY_REJECTED") {
    throw new AppError(
      400,
      `${amountOf(result.rejected)} ${result.unit} of ${result.itemName} is entered as turned away, but only ${amountOf(result.outstanding)} ${result.unit} was still due on this order. Enter what was actually turned away.`
    );
  }

  if (result.error === "BILL_MISMATCH") {
    throw new AppError(400, mismatchMessage(result));
  }

  if (result.error === "DUPLICATE_BILL") {
    throw new AppError(409, `Bill ${data.billNumber} from ${supplier.name} is already entered`);
  }

  // receivedInto: where the goods went. storeNote says why, when the order's
  // outlet has closed since and they went into the main store instead.
  return {
    ...toOrder(result.order),
    receiptId: result.receiptId,
    receivedInto: result.closedOutlet ? "Main store" : toOrder(result.order).storeName,
    storeNote: result.storeNote || null,
  };
};

// --- Purchase bills (goods receipts) ---

const toReceipt = (row) => ({
  id: row.id,
  receiptNumber: row.receipt_number,
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  supplierGstin: row.supplier_gstin,
  purchaseOrderId: row.purchase_order_id,
  poNumber: row.po_number,
  kind: row.purchase_order_id ? "po" : "direct",
  outletId: row.outlet_id,
  storeName: row.outlet_id ? row.outlet_name : "Main store",
  billNumber: row.bill_number,
  billDate: row.bill_date,
  receivedDate: row.received_date,
  dueDate: row.due_date,
  paymentMode: row.payment_mode,
  pricesIncludeTax: row.prices_include_tax,
  taxableAmount: Number(row.taxable_amount),
  taxAmount: Number(row.tax_amount),
  roundOff: Number(row.round_off),
  totalAmount: Number(row.total_amount),
  status: row.receipt_status,
  voidReason: row.void_reason,
  voidedAt: row.voided_at,
  voidedByName: row.voided_by_name,
  notes: row.notes,
  lineCount: row.line_count ?? (row.lines ? row.lines.length : undefined),
  hasRejections: row.has_rejections ?? (row.lines ? row.lines.some((l) => Number(l.rejected_quantity) > 0) : undefined),
  createdAt: row.created_at,
  createdByName: row.created_by_name,
  // Photos or PDFs of the supplier's paper bill.
  attachmentCount: Number(row.attachment_count || 0),
  lines: (row.lines || []).map((line) => ({
    id: line.id,
    purchaseOrderItemId: line.purchase_order_item_id,
    inventoryItemId: line.inventory_item_id,
    itemName: line.item_name,
    unitShortName: line.unit_short_name,
    packId: line.pack_id,
    packName: line.pack_name,
    packSize: numberOrNull(line.pack_size),
    billQuantity: Number(line.bill_quantity),
    rejectedQuantity: Number(line.rejected_quantity),
    rejectionReason: line.rejection_reason,
    quantity: Number(line.quantity),
    returnedQuantity: Number(line.returned_quantity || 0),
    unitPrice: Number(line.unit_price),
    taxRate: Number(line.tax_rate),
    taxableAmount: Number(line.taxable_amount),
    taxAmount: Number(line.tax_amount),
    amount: Number(line.amount),
    unitCost: Number(line.unit_cost),
    // Price per unit of stock before GST: the most a return can be credited at.
    netUnitPrice: Number(line.quantity) > 0 ? round8(Number(line.taxable_amount) / Number(line.quantity)) : 0,
  })),
  payments: (row.payments || []).map((payment) => ({
    id: payment.id,
    amount: Number(payment.amount),
    paymentMethod: payment.payment_method,
    paymentDate: payment.payment_date,
    status: payment.payment_status,
    voidReason: payment.void_reason ?? null,
    paidFromTill: payment.paid_from_till,
  })),
  returns: (row.returns || []).map((ret) => ({
    id: ret.id,
    returnNumber: ret.return_number,
    returnDate: ret.return_date,
    totalAmount: Number(ret.total_amount),
    status: ret.return_status,
  })),
});

const listReceipts = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  const { rows, total } = await purchaseRepository.findReceipts(restaurantId, filters);

  return { items: rows.map(toReceipt), total, limit: filters.limit || 200 };
};

const getReceipt = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const row = await purchaseRepository.findReceiptById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Purchase bill not found");
  }

  return toReceipt(row);
};

// A supplier's bill with no purchase order behind it — how most vegetables,
// meat, fish and milk are bought. Stock comes in at the billed price, and
// the supplier is owed for it (or it is paid on the spot).
const createDirect = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const supplier = await requireSupplier(restaurantId, data.supplierId);

  if (supplier.status !== "active") {
    throw new AppError(400, `${supplier.name} is inactive. Set the supplier active to enter a bill.`);
  }

  if (data.lines.length === 0) {
    throw new AppError(400, "Add at least one item to the bill");
  }

  const seen = new Set();
  const lines = [];

  for (const line of data.lines) {
    const key = `${line.inventoryItemId}:${line.packId || 0}`;

    if (seen.has(key)) {
      throw new AppError(400, "The same item is listed twice on this bill");
    }

    seen.add(key);

    const item = await inventoryRepository.findItemById(restaurantId, line.inventoryItemId);

    if (!item) {
      throw new AppError(400, "One of the selected items does not exist");
    }

    let pack = null;

    if (line.packId) {
      pack = await inventoryRepository.findPackById(restaurantId, line.packId);

      if (!pack || Number(pack.inventory_item_id) !== Number(line.inventoryItemId)) {
        throw new AppError(400, `That pack is not one of ${item.name}'s packs`);
      }

      checkPackQuantity(line.quantity, pack, item.name, item.unit_short_name);
    }

    const priced = priceBillLine(
      {
        billQuantity: line.quantity,
        rejectedQuantity: line.rejectedQuantity,
        unitPrice: line.unitPrice,
        taxRate: line.taxRate,
        packSize: pack ? Number(pack.size) : 1,
        inPacks: Boolean(pack),
      },
      data.pricesIncludeTax
    );

    checkAmount(priced.amount, item.name);
    checkStockValue(item.current_stock, priced.quantity, priced.unitCost, item.name, item.unit_short_name);

    lines.push({
      inventoryItemId: line.inventoryItemId,
      packId: pack ? pack.id : null,
      packName: pack ? pack.name : null,
      packSize: pack ? Number(pack.size) : null,
      rejectionReason: line.rejectionReason,
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate,
      ...priced,
    });
  }

  const totals = checkBillTotal(billTotals(lines, data.billTotal));

  if (totals.error) {
    throw new AppError(400, mismatchMessage(totals));
  }

  if (data.outletId) {
    const outlet = await inventoryRepository.findOutlet(restaurantId, data.outletId);

    if (!outlet) {
      throw new AppError(400, "That outlet does not belong to your restaurant");
    }

    // A closed outlet sells nothing, so goods put on its shelf would sit
    // where nothing can use them.
    if (outlet.status !== "active") {
      throw new AppError(400, `${outlet.name} is not active, so goods cannot be received into its store. Receive them at the main store or an open outlet.`);
    }
  }

  const settled = await settlement(restaurantId, supplier, data);

  try {
    const { id } = await purchaseRepository.createDirectReceipt(
      restaurantId,
      {
        ...data,
        ...totals,
        ...settled,
        lines,
        supplierId: supplier.id,
        purchaseOrderId: null,
        storeId: await inventoryRepository.storeFor(inventoryRepository.pool, restaurantId, data.outletId),
      },
      userId
    );

    return getReceipt(restaurantId, id);
  } catch (error) {
    if (error.code === "23505" && /uq_goods_receipts_bill/.test(error.constraint || error.message)) {
      throw new AppError(409, `Bill ${data.billNumber} from ${supplier.name} is already entered`);
    }

    throw error;
  }
};

// options.mayVoidPayments: whether the person may also void a payment made
// with the bill (they can pay suppliers, or a manager approved it).
const voidReceipt = async (restaurantId, id, reason, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const result = await purchaseRepository.voidReceipt(restaurantId, id, reason, userId, options);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Purchase bill not found");
  }

  if (result.error === "ALREADY_VOID") {
    throw new AppError(409, "This bill is already voided");
  }

  if (result.error === "PAID") {
    throw new AppError(
      403,
      "This bill has been paid. Voiding it also voids the payment, which needs the 'Pay suppliers' permission — ask a manager."
    );
  }

  if (result.error === "HAS_RETURNS") {
    throw new AppError(
      409,
      `Goods from this bill were returned (${result.returns.join(", ")}). Void the return first.`
    );
  }

  // Voiding would put the item back on an older price that makes its stock
  // worth more than one item's stock can be (the ceiling Stock in, bills and
  // deliveries already have). Nothing was changed.
  if (result.error === "STOCK_VALUE") {
    const { source } = result;
    const from = source
      ? ` (set by ${source.reference_type === "goods_receipt" ? source.notes || "a purchase bill" : "a Stock in"} on ${new Date(`${source.day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })})`
      : "";

    throw new AppError(
      400,
      `Voiding ${result.receiptNumber} would put ${result.itemName} back on its earlier price of ${rupees(result.cost)} a ${result.unit}${from}, and the ${amountOf(result.stock)} ${result.unit} in stock would then be worth ${rupees(result.value)} — more than one item's stock can be worth (the limit is ${rupees(MAX_AMOUNT)}). Nothing was changed. If that earlier price is a typing slip, record a Stock in of ${result.itemName} at the right cost per ${result.unit} (it sets the price), then void this bill.`,
      { reason: "stock_value_limit" }
    );
  }

  return getReceipt(restaurantId, id);
};

// --- Purchase register ---

// Intra-state purchases carry CGST + SGST, inter-state ones IGST. Which one is
// read from the first two digits of each GSTIN (the state code). Without the
// restaurant's own GSTIN it is assumed to be the same state, and the register
// says so.
const splitTax = (tax, supplierGstin, restaurantGstin) => {
  const interState =
    supplierGstin && restaurantGstin && supplierGstin.slice(0, 2) !== restaurantGstin.slice(0, 2);

  if (interState) {
    return { cgst: 0, sgst: 0, igst: round2(tax) };
  }

  const cgst = round2(tax / 2);

  return { cgst, sgst: round2(tax - cgst), igst: 0 };
};

const sumBy = (rows, key) => round2(rows.reduce((sum, row) => sum + row[key], 0));

const register = async (restaurantId, { from, to, supplierId }) => {
  requireRestaurantId(restaurantId);

  if (from > to) {
    throw new AppError(400, "The start date is after the end date");
  }

  const { bills, returns, restaurantGstin } = await purchaseRepository.findRegister(restaurantId, {
    from,
    to,
    supplierId,
  });

  const rows = bills.map((bill) => ({
    id: bill.id,
    receiptNumber: bill.receipt_number,
    billNumber: bill.bill_number,
    billDate: bill.bill_date,
    supplierId: bill.supplier_id,
    supplierName: bill.supplier_name,
    supplierGstin: bill.supplier_gstin,
    poNumber: bill.po_number,
    paymentMode: bill.payment_mode,
    taxable: Number(bill.taxable_amount),
    tax: Number(bill.tax_amount),
    ...splitTax(Number(bill.tax_amount), bill.supplier_gstin, restaurantGstin),
    roundOff: Number(bill.round_off),
    total: Number(bill.total_amount),
    rates: (bill.rates || []).map((rate) => ({
      rate: Number(rate.rate),
      taxable: round2(Number(rate.taxable)),
      tax: round2(Number(rate.tax)),
    })),
  }));

  const debitNotes = returns.map((ret) => ({
    id: ret.id,
    returnNumber: ret.return_number,
    returnDate: ret.return_date,
    supplierId: ret.supplier_id,
    supplierName: ret.supplier_name,
    supplierGstin: ret.supplier_gstin,
    againstBill: ret.bill_number || ret.receipt_number || null,
    reason: ret.reason,
    taxable: Number(ret.taxable_amount),
    tax: Number(ret.tax_amount),
    ...splitTax(Number(ret.tax_amount), ret.supplier_gstin, restaurantGstin),
    total: Number(ret.total_amount),
  }));

  const byRate = new Map();

  for (const row of rows) {
    for (const rate of row.rates) {
      const entry = byRate.get(rate.rate) || { rate: rate.rate, taxable: 0, tax: 0 };

      entry.taxable = round2(entry.taxable + rate.taxable);
      entry.tax = round2(entry.tax + rate.tax);
      byRate.set(rate.rate, entry);
    }
  }

  const totalsOf = (list) => ({
    count: list.length,
    taxable: sumBy(list, "taxable"),
    cgst: sumBy(list, "cgst"),
    sgst: sumBy(list, "sgst"),
    igst: sumBy(list, "igst"),
    tax: sumBy(list, "tax"),
    total: sumBy(list, "total"),
  });

  const billTotalsRow = totalsOf(rows);
  const returnTotalsRow = totalsOf(debitNotes);

  return {
    from,
    to,
    restaurantGstin,
    taxSplitAssumed: !restaurantGstin,
    rows,
    returns: debitNotes,
    byRate: [...byRate.values()].sort((a, b) => a.rate - b.rate),
    totals: billTotalsRow,
    returnTotals: returnTotalsRow,
    net: {
      taxable: round2(billTotalsRow.taxable - returnTotalsRow.taxable),
      tax: round2(billTotalsRow.tax - returnTotalsRow.tax),
      total: round2(billTotalsRow.total - returnTotalsRow.total),
    },
  };
};

// Only a draft can be deleted; anything sent to a supplier stays on record.
const remove = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const order = await purchaseRepository.findById(restaurantId, id);

  if (!order) {
    throw new AppError(404, "Purchase order not found");
  }

  if (order.po_status !== "draft") {
    throw new AppError(409, "Only draft orders can be deleted. Cancel the order instead.");
  }

  await purchaseRepository.remove(restaurantId, id);
};

module.exports = {
  list,
  getById,
  create,
  updateDraft,
  changeStatus,
  requireWaiting,
  approve,
  sendBack,
  receive,
  listReceipts,
  getReceipt,
  createDirect,
  voidReceipt,
  register,
  remove,
};
