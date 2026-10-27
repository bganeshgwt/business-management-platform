const customerAdvanceRepository = require("../repositories/customerAdvance.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const crmRepository = require("../../crm/repositories/crm.repository");
const paymentTypeService = require("../../setup/services/paymentType.service");
const tradingDay = require("../../business-day/services/tradingDay");
const { ruleRefusal } = require("./cashAndPan");
const AppError = require("../../../../utils/AppError");
const { toPaise, fromPaise, splitGst } = require("../../../../utils/money");
const { formatMobile, maskMobile } = require("../../../../utils/phone");

// Advances and deposits. An advance is money held for a
// guest, not a sale: it becomes a sale on the bill it is used on (a payment
// "from advance"), so sales and GST count it once. What is not used can be
// handed back with a reason and a manager's say-so.

const n = (value) => (value === null || value === undefined ? 0 : Number(value));

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const METHOD_WORDS = paymentTypeService.METHOD_WORDS;

const toAdvance = (row, { reveal = false } = {}) => ({
  id: row.id,
  receiptNumber: row.receipt_number,
  customerId: row.customer_id,
  customerName: row.company_name || row.customer_name,
  guestName: row.customer_name,
  customerMobile: row.customer_mobile ? (reveal ? formatMobile(row.customer_mobile) : maskMobile(row.customer_mobile)) : null,
  amount: n(row.amount),
  usedAmount: n(row.used_amount),
  refundedAmount: n(row.refunded_amount),
  heldAmount: n(row.held),
  status: n(row.held) > 0.009 ? (n(row.used_amount) + n(row.refunded_amount) > 0.009 ? "part_used" : "held") : "closed",
  paymentMethod: row.payment_method,
  methodLabel: METHOD_WORDS[row.payment_method] || row.payment_method,
  paymentTypeId: row.payment_type_id || null,
  paymentTypeName: row.payment_type_name || null,
  transactionRef: row.transaction_ref || null,
  purpose: row.purpose || null,
  reservationId: row.reservation_id || null,
  reservationDate: row.reservation_date || null,
  reservationParty: row.reservation_party || null,
  orderId: row.order_id ? Number(row.order_id) : null,
  orderNumber: row.order_number || null,
  outletId: row.outlet_id || null,
  outletName: row.outlet_name || null,
  businessDate: row.business_date || null,
  receivedAt: row.received_at,
  createdByName: row.created_by_name || null,
});

const outletOf = (ctx) => (ctx && ctx.outletPinned ? ctx.outletId : null);

// The advances list. With no dates it opens on the advances still held
// (every day — money held is never "yesterday's"); with dates, every advance
// received in them.
const list = async (restaurantId, filters, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const pageSize = filters.pageSize || 25;
  const page = Math.max(1, filters.page || 1);
  const { rows, totals } = await customerAdvanceRepository.findAll(restaurantId, {
    ...filters,
    outletId: outletOf(ctx),
    timezone: settings.timezone,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    items: rows.map((row) => toAdvance(row, ctx)),
    total: totals.total,
    page,
    pageSize,
    totals: {
      amount: n(totals.amount),
      used: n(totals.used),
      refunded: n(totals.refunded),
      held: n(totals.held),
    },
  };
};

const findOr404 = async (restaurantId, id, ctx = {}) => {
  const row = await customerAdvanceRepository.findById(restaurantId, id);
  const pinned = outletOf(ctx);

  if (!row || (pinned && Number(row.outlet_id || 0) !== Number(pinned))) {
    throw new AppError(404, "Advance not found");
  }

  return row;
};

// One advance with what happened to it, for its screen and its receipt.
const getById = async (restaurantId, id, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const row = await findOr404(restaurantId, id, ctx);
  const moves = await customerAdvanceRepository.findMovements(restaurantId, id);
  const restaurant = await restaurantRepository.findById(restaurantId);
  const settings = await restaurantRepository.findSettings(restaurantId, row.outlet_id || null);

  return {
    ...toAdvance(row, ctx),
    usedOn: moves.used.map((use) => ({
      paymentId: use.id,
      billId: use.bill_id,
      billNumber: use.bill_number,
      amount: n(use.amount),
      putBack: n(use.put_back),
      paidAt: use.paid_at,
      createdByName: use.created_by_name || null,
    })),
    refunds: moves.refunds.map((back) => ({
      id: back.id,
      amount: n(back.amount),
      refundMethod: back.refund_method,
      methodLabel: METHOD_WORDS[back.refund_method] || back.refund_method,
      paymentTypeName: back.payment_type_name || null,
      transactionRef: back.transaction_ref || null,
      reason: back.reason,
      refundedAt: back.refunded_at,
      createdByName: back.created_by_name || null,
      approvedByName: back.approved_by_name || null,
    })),
    // Who issued the receipt, as the paper prints it, with the line every
    // receipt carries with the privacy contact (Settings › Personal data).
    seller: {
      name: restaurant ? restaurant.name : null,
      address: restaurant ? restaurant.address : null,
      phone: restaurant ? restaurant.contact : null,
      gstin: settings.gst_number || null,
      privacyLine: (await require("../../../personal-data/services/personalData.service").restaurantPrintInfo(restaurantId))?.line || null,
    },
  };
};

// A guest's advances still holding money, for "Pay from advance" on a bill.
// The advance taken on this very order (a pickup order) comes first.
const heldFor = async (restaurantId, customerId, ctx = {}, orderId = null) => {
  requireRestaurantId(restaurantId);

  const rows = await customerAdvanceRepository.findHeldFor(restaurantId, customerId);
  const advances = rows.map((row) => toAdvance(row, ctx));

  return orderId ? [...advances.filter((a) => a.orderId === Number(orderId)), ...advances.filter((a) => a.orderId !== Number(orderId))] : advances;
};

// What is held on one order (the order screen shows it).
const forOrder = async (restaurantId, orderId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const rows = await customerAdvanceRepository.findForOrder(restaurantId, orderId);

  return rows.map((row) => toAdvance(row, ctx));
};

// data: { customerId, amount, paymentMethod, paymentTypeId, transactionRef,
//         purpose, reservationId }
const create = async (restaurantId, data, userId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const guest = await crmRepository.findCustomerById(restaurantId, data.customerId);

  if (!guest) {
    throw new AppError(404, "Guest not found");
  }

  if (guest.erased_at) {
    throw new AppError(400, "This guest's record has been erased; take the advance on a new guest record");
  }

  const type = await paymentTypeService.forPayment(restaurantId, data.paymentMethod, data.paymentTypeId, data.transactionRef);

  // The till taking it: the outlet in the top bar, or the main counter. An
  // advance in cash that would take the guest's cash today to ₹2,00,000 is
  // refused by the database (cashAndPan.js), with a sentence that says so.
  let result;

  try {
    result = await customerAdvanceRepository.create(
      restaurantId,
      { ...data, paymentTypeId: type ? type.id : null, outletId: ctx.outletId || null },
      userId
    );
  } catch (error) {
    throw ruleRefusal(error) || error;
  }

  if (result.error === "NO_DAY") {
    throw new AppError(409, "Open the business day first. An advance goes into the day's drawer, and no day is open.");
  }

  if (result.error === "NO_GUEST") {
    throw new AppError(404, "Guest not found");
  }

  if (result.error === "NO_ORDER") {
    throw new AppError(404, "Order not found");
  }

  if (result.error === "ORDER_NOT_PICKUP") {
    throw new AppError(
      409,
      `An advance on an order is for a pickup order that is still open and not yet billed. ${result.order.order_number} is ` +
        (result.order.order_type !== "takeaway" ? "not a takeaway." : result.order.billed ? "already billed: take the payment on its bill." : `${result.order.order_status}.`)
    );
  }

  if (result.error === "ORDER_OTHER_GUEST") {
    throw new AppError(409, `${result.order.order_number} is for another guest. Take the advance from the guest on the order.`);
  }

  return getById(restaurantId, result.id, ctx);
};

// Checked before a manager is asked for anything: the advance exists for this
// person and still holds this much; the method and type suit each other.
const checkRefund = async (restaurantId, id, data, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const row = await findOr404(restaurantId, id, ctx);

  if (n(row.held) <= 0.009) {
    throw new AppError(409, `${row.receipt_number} has nothing left to hand back`);
  }

  if (data.amount > n(row.held) + 0.009) {
    throw new AppError(400, `${row.receipt_number} holds only ${n(row.held).toLocaleString("en-IN")}. Hand back that much at most.`);
  }

  await paymentTypeService.forPayment(restaurantId, data.refundMethod, data.paymentTypeId, data.transactionRef, {
    requireReference: false,
  });

  return { advanceId: row.id, amount: data.amount };
};

const refund = async (restaurantId, id, data, who, ctx = {}) => {
  requireRestaurantId(restaurantId);

  await findOr404(restaurantId, id, ctx);

  const result = await customerAdvanceRepository.refund(
    restaurantId,
    id,
    { ...data, outletId: ctx.outletId || null },
    who
  );

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Advance not found");
  }

  if (result.error === "TOO_MUCH") {
    throw new AppError(400, `The advance holds only ${result.held.toLocaleString("en-IN")} now`);
  }

  if (result.error === "NO_DAY") {
    throw new AppError(409, "Open the business day first. Money handed back comes out of the day's drawer.");
  }

  return getById(restaurantId, id, ctx);
};

// For the GST return (GSTR-1 tables 11A and 11B), at the restaurant's usual
// GST rate (the rate is not known until the bill: a restaurant's food is
// mostly one rate). 11A: advances received in the period and not invoiced in
// it; 11B: earlier advances invoiced (used on bills) in the period.
const gstSummary = async (restaurantId, { from, to }) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  let start = from;
  let end = to;

  if (!start || !end) {
    // The trading day: last night's until the cut-off hour (tradingDay).
    const today = await tradingDay.currentDateOf(restaurantId, undefined, settings);
    start = start || `${today.slice(0, 7)}-01`;
    end = end || today;
  }

  const figures = await customerAdvanceRepository.gstFigures(restaurantId, { from: start, to: end, timezone: settings.timezone });
  const rate = n(settings.default_tax_percentage);
  const split = (gross) => {
    const grossPaise = toPaise(gross);
    const taxable = Math.round((grossPaise * 100) / (100 + rate));
    const { cgst, sgst } = splitGst(grossPaise - taxable);

    return { gross: fromPaise(grossPaise), taxable: fromPaise(taxable), cgst: fromPaise(cgst), sgst: fromPaise(sgst) };
  };

  return {
    from: start,
    to: end,
    rate,
    receivedCount: figures.received_count,
    received: n(figures.received),
    usedSamePeriod: n(figures.used_same_period),
    table11A: split(Math.max(0, n(figures.received) - n(figures.used_same_period))),
    table11B: split(n(figures.adjusted)),
  };
};

module.exports = { list, getById, heldFor, forOrder, create, checkRefund, refund, gstSummary };
