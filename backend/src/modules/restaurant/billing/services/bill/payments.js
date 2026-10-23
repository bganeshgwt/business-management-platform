// Payments on a bill and corrections to a payment's method.
// Part of bill.service.js, which re-exports these for its callers.

const billRepository = require("../../repositories/bill.repository");
const restaurantRepository = require("../../../setup/repositories/restaurant.repository");
const loyaltyService = require("../../../crm/services/loyalty.service");
const paymentTypeService = require("../../../setup/services/paymentType.service");
const AppError = require("../../../../../utils/AppError");
const { round2 } = require("../../../../../utils/money");
const { n, requireRestaurantId } = require("./shape");
const { businessDateOf, outletOf, rupeesText } = require("./rules");
const { findInScope, getById } = require("./raise");

// ------------------------------------------------------------------ money

// data: { paymentMethod, amount, tenderedAmount, transactionRef, tipAmount,
//         paymentTypeId, advanceId }
//
// A tip is on top of the amount: it never counts toward the bill, its GST,
// the sales, the discount base or the points. A cash tip is part of the cash
// handed over, so the change is what is left after the bill and the tip.
// Paying from an advance ("advance", naming the guest's advance) uses money
// received earlier; it carries no tip and gives no change.
const addPayment = async (restaurantId, billId, data, userId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const bill = await findInScope(restaurantId, billId, ctx);
  const settings = await restaurantRepository.findSettings(restaurantId);
  const tip = round2(n(data.tipAmount));
  const advance = data.paymentMethod === "advance";

  if (advance && !data.advanceId) {
    throw new AppError(400, "Pick the advance this is paid from");
  }

  if (advance && tip > 0) {
    throw new AppError(400, "A tip is given in cash, by card or by UPI, not from an advance");
  }

  // A cash tip comes out of the cash handed over: there must be enough of it.
  if (tip > 0 && data.paymentMethod === "cash" && n(data.tenderedAmount) > 0 && n(data.tenderedAmount) + 0.009 < data.amount + tip) {
    throw new AppError(
      400,
      `The cash given (${rupeesText(data.tenderedAmount)}) is less than the payment and the tip (${rupeesText(data.amount + tip)})`
    );
  }

  const type = advance
    ? null
    : await paymentTypeService.forPayment(restaurantId, data.paymentMethod, data.paymentTypeId, data.transactionRef);

  // Points are earned on what the guest pays for this bill, under the
  // restaurant's rule: the bill total, or the food before tax (Discounts &
  // offers → Loyalty points). The ledger write applies the same rule, to the
  // guest the order names when the bill is locked (billRepository).
  const earnPoints = bill.customer_id ? loyaltyService.pointsForBill(settings, bill) : 0;

  const payment = {
    customerId: bill.customer_id,
    earnPoints,
    paymentMethod: data.paymentMethod,
    amount: data.amount,
    tenderedAmount: advance ? null : data.tenderedAmount ?? null,
    // Change is only ever given in cash, and never more than what was handed
    // over beyond the payment and the tip.
    changeAmount:
      data.paymentMethod === "cash" && data.tenderedAmount
        ? round2(Math.max(0, data.tenderedAmount - data.amount - tip))
        : 0,
    transactionRef: data.transactionRef ?? null,
    tipAmount: tip,
    paymentTypeId: type ? type.id : null,
    advanceId: advance ? data.advanceId : null,
  };

  const result = await billRepository.addPayment(restaurantId, billId, outletOf(ctx), payment, userId);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Bill not found");
  }

  if (result.error === "VOID") {
    throw new AppError(409, "This bill has been voided");
  }

  if (result.error === "ALREADY_PAID") {
    throw new AppError(409, "This bill is already paid in full");
  }

  if (result.error === "NO_DAY") {
    throw new AppError(
      409,
      "Open the business day first. Money taken goes into the day's drawer, and no day is open."
    );
  }

  if (result.error === "TOO_MUCH") {
    throw new AppError(
      400,
      `Only ${result.due} is still due on this bill${tip > 0 ? "" : ". Anything the guest gives on top is a tip: put it in the tip box."}`
    );
  }

  if (result.error === "ADVANCE_NOT_FOUND") {
    throw new AppError(404, "That advance was not found");
  }

  if (result.error === "ADVANCE_SHORT") {
    throw new AppError(400, `That advance has only ${rupeesText(result.left)} left`);
  }

  return getById(restaurantId, billId, ctx);
};

// --- Correcting how a payment was taken -----------------------------------------

const CORRECTION_ERRORS = {
  NOT_FOUND: () => new AppError(404, "Bill not found"),
  PAYMENT_NOT_FOUND: () => new AppError(404, "That payment is not on this bill"),
  NOT_SUCCESS: () => new AppError(409, "Only a payment that went through can be corrected"),
  DAY_CLOSED: () =>
    new AppError(
      409,
      "This payment's business day is closed and counted, so how it was taken can no longer be changed. Give the money back with a refund and take it again the right way."
    ),
  ADVANCE: () =>
    new AppError(400, "A payment from an advance cannot be changed into another way of paying (or the other way round)"),
  CHANGE_GIVEN: (result) =>
    new AppError(
      400,
      `Change of ${rupeesText(result.change)} was handed back in cash on this payment, so it can only stay cash. Correct the reference, or refund it and take it again.`
    ),
  NO_CHANGE: () => new AppError(400, "Nothing would change: pick the method it was really paid by"),
};

const correctionError = (result) => (CORRECTION_ERRORS[result.error] || (() => new AppError(400, "That payment could not be corrected")))(result);

// data: { paymentId, method, paymentTypeId, reference, reason }. Everything
// is checked before anyone is asked for a PIN: the payment is on this bill,
// went through, is on a day still open, did not give change if it is to
// leave cash, and the type (with its reference) suits the new method.
// Returns what the manager's approval is tied to.
const checkCorrection = async (restaurantId, bill, data) => {
  if (bill.bill_status === "void") {
    throw new AppError(409, "This bill has been voided");
  }

  const payment = await billRepository.findPayment(restaurantId, bill.id, data.paymentId);

  if (!payment) {
    throw correctionError({ error: "PAYMENT_NOT_FOUND" });
  }

  const problem = billRepository.correctionProblem(payment, { day_status: payment.day_status }, data);

  if (problem) {
    throw correctionError(problem);
  }

  await paymentTypeService.forPayment(restaurantId, data.method, data.paymentTypeId, data.reference);

  return {
    payment,
    scope: {
      billId: bill.id,
      paymentId: payment.id,
      amount: n(payment.amount),
      fromMethod: payment.payment_method,
      toMethod: data.method,
    },
  };
};

// Corrections in a period (no dates: the business day the till is on), a
// page at a time, with the total over the whole period.
const listCorrections = async (restaurantId, { from, to, page = 1, pageSize = 25 }, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const { date } = await businessDateOf(restaurantId, settings);
  const start = from || to || date;
  const end = to || (start > date ? start : date);
  const rows = await billRepository.findCorrections(restaurantId, {
    from: start,
    to: end,
    outletId: ctx.outletId || null,
    timezone: settings.timezone,
    limit: pageSize,
    offset: (Math.max(1, page) - 1) * pageSize,
  });

  return {
    from: start,
    to: end,
    page: Math.max(1, page),
    pageSize,
    total: rows.length ? rows[0].total_count : 0,
    totalAmount: rows.length ? n(rows[0].total_amount) : 0,
    items: rows.map((row) => ({
      id: row.id,
      billId: row.bill_id,
      billNumber: row.bill_number,
      businessDate: row.business_date,
      amount: n(row.amount),
      oldMethod: row.old_method,
      newMethod: row.new_method,
      oldTypeName: row.old_type_name || null,
      newTypeName: row.new_type_name || null,
      oldReference: row.old_reference || null,
      newReference: row.new_reference || null,
      reason: row.reason,
      correctedAt: row.corrected_at,
      correctedBy: row.user_name,
      approvedBy: row.approver_name || null,
      outletName: row.outlet_name || null,
    })),
  };
};

const correctPayment = async (restaurantId, billId, data, who, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const result = await billRepository.correctPayment(restaurantId, billId, outletOf(ctx), data, who);

  if (result.error) {
    throw correctionError(result);
  }

  return { result, bill: await getById(restaurantId, billId, ctx) };
};

module.exports = {
  addPayment,
  checkCorrection,
  listCorrections,
  correctPayment,
};
