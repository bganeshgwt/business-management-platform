// Loyalty history, the day's bill summary, credit-note list and till options.
// Part of bill.service.js, which re-exports these for its callers.

const billRepository = require("../../repositories/bill.repository");
const restaurantRepository = require("../../../setup/repositories/restaurant.repository");
const businessDayRepository = require("../../../business-day/repositories/businessDay.repository");
const loyaltyRepository = require("../../../crm/repositories/loyalty.repository");
const AppError = require("../../../../../utils/AppError");
const { round2 } = require("../../../../../utils/money");
const { COMPLIMENTARY_REASONS, DISCOUNT_REASONS, n, requireRestaurantId } = require("./shape");
const { outletOf } = require("./rules");

// A guest's points history.
const loyaltyHistory = async (restaurantId, customerId) => {
  requireRestaurantId(restaurantId);

  const rows = await loyaltyRepository.findForCustomer(restaurantId, customerId);

  return rows.map((row) => ({
    id: row.id,
    points: row.points,
    balanceAfter: row.balance_after,
    entryType: row.entry_type,
    amount: row.amount === null ? null : Number(row.amount),
    notes: row.notes,
    billNumber: row.bill_number,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
  }));
};

// The day's figures for the outlet the person is looking at. Each outlet
// trades its own business day, so:
//
//   - an outlet chosen in the top bar, or staff pinned to one: that outlet's
//     own open day (its bills and its money, nobody else's);
//   - "All outlets": every day open in the restaurant — the main counter's
//     and each outlet's — added up, and listed in `days`;
//   - scope "counter" with "All outlets": the main counter's day alone, the
//     one the Business day screen opens and closes;
//   - a business day by id: that day.
//
// With no day open (early morning, or after the close) it says so and shows
// nothing, rather than adding up every bill there has ever been.
const daySummary = async (restaurantId, businessDayId, ctx = {}, { scope = "restaurant" } = {}) => {
  requireRestaurantId(restaurantId);

  const outletId = ctx.outletId || null;
  let days = [];

  if (businessDayId) {
    const day = await businessDayRepository.findById(restaurantId, businessDayId);

    // A day of another outlet is not found for staff pinned to theirs.
    if (!day || (ctx.outletPinned && Number(day.outlet_id) !== Number(outletId))) {
      throw new AppError(404, "Business day not found");
    }

    days = [day];
  } else if (outletId || scope === "counter") {
    const day = await businessDayRepository.findOpen(restaurantId, outletId);
    days = day ? [day] : [];
  } else {
    days = await billRepository.findOpenDays(restaurantId);
  }

  // Each day with its outlet's name: one outlet's own day is named for the
  // outlet, never taken for the main counter's.
  if (days.length > 0 && days.some((day) => day.outlet_id && !day.outlet_name)) {
    days = await billRepository.findDays(restaurantId, days.map((day) => day.id));
  }

  if (days.length === 0) {
    return {
      businessDayId: null,
      businessDate: null,
      dayOpen: false,
      days: [],
      billCount: 0,
      salesTotal: 0,
      collected: 0,
      duesCollected: 0,
      refunded: 0,
      cashRefunded: 0,
      discounts: 0,
      serviceCharge: 0,
      tax: 0,
      complimentaryCount: 0,
      voidCount: 0,
      dueNow: 0,
      onAccount: 0,
      tips: 0,
      advancesTaken: 0,
      cashAdvances: 0,
      advancesReturned: 0,
      cashAdvancesReturned: 0,
      byMethod: [],
      byType: [],
    };
  }

  // A day holds its own outlet's bills and money; the outlet filter only
  // matters for staff pinned to an outlet reading a day by id.
  const summary = await billRepository.daySummary(
    restaurantId,
    days.map((day) => day.id),
    ctx.outletPinned ? outletId : null
  );
  const one = days.length === 1 ? days[0] : null;
  const dates = [...new Set(days.map((day) => day.business_date))];

  return {
    // One day: its id. Several (All outlets): no single day, see `days`.
    businessDayId: one ? one.id : null,
    businessDate: dates.length === 1 ? dates[0] : null,
    dayOpen: days.some((day) => day.day_status === "open"),
    days: days.map((day) => ({
      businessDayId: day.id,
      businessDate: day.business_date,
      outletId: day.outlet_id || null,
      outletName: day.outlet_name || null,
    })),
    billCount: summary.bill_count,
    salesTotal: n(summary.sales_total),
    collected: n(summary.collected),
    duesCollected: n(summary.dues_collected),
    refunded: n(summary.refunded),
    cashRefunded: n(summary.cash_refunded),
    discounts: n(summary.discounts),
    serviceCharge: n(summary.service_charge),
    tax: n(summary.tax),
    complimentaryCount: summary.complimentary_count,
    voidCount: summary.void_count,
    dueNow: n(summary.due_now),
    // Put on guests' and companies' accounts today: owed there, not at the till.
    onAccount: n(summary.on_account),
    // Tips taken with the payments: money for the staff, not takings.
    tips: round2(summary.byMethod.reduce((sum, row) => sum + n(row.tips), 0)),
    // Advances taken and handed back in the days: money held for guests.
    advancesTaken: n(summary.advances_taken),
    cashAdvances: n(summary.cash_advances),
    advancesReturned: n(summary.advances_returned),
    cashAdvancesReturned: n(summary.cash_advances_returned),
    byMethod: summary.byMethod.map((row) => ({
      paymentMethod: row.payment_method,
      amount: n(row.amount),
      tips: n(row.tips),
    })),
    // The owner's named payment types, each apart (meal cards, cheques…).
    byType: summary.byType.map((row) => ({
      paymentMethod: row.payment_method,
      paymentTypeId: row.payment_type_id,
      paymentTypeName: row.payment_type_name,
      amount: n(row.amount),
      count: row.count,
    })),
  };
};

const listCreditNotes = async (restaurantId, filters, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const { rows, total } = await billRepository.findCreditNotes(restaurantId, {
    ...filters,
    outletId: outletOf(ctx),
    timezone: settings.timezone,
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      number: row.credit_note_number,
      kind: row.kind,
      reason: row.reason,
      billId: row.bill_id,
      billNumber: row.bill_number,
      refundMethod: row.refund_method,
      taxableValue: n(row.taxable_value),
      serviceChargeValue: n(row.service_charge_value),
      taxAmount: n(row.tax_amount),
      cessAmount: n(row.cess_amount),
      roundOff: n(row.round_off),
      totalAmount: n(row.total_amount),
      pointsReversed: row.points_reversed,
      issuedAt: row.issued_at,
      businessDate: row.business_date,
      createdByName: row.created_by_name,
    })),
    total,
    limit: filters.limit || 200,
    page: filters.page || 1,
    pageSize: filters.pageSize || null,
  };
};

// The discount cap of the person at the till, and the words the screen uses.
const tillOptions = async (restaurantId, userId, permissions = []) => {
  requireRestaurantId(restaurantId);

  const cap = permissions.includes("bills.discount")
    ? await restaurantRepository.findDiscountCapOfUser(restaurantId, userId)
    : 0;

  return {
    discountReasons: Object.entries(DISCOUNT_REASONS).map(([value, label]) => ({ value, label })),
    complimentaryReasons: Object.entries(COMPLIMENTARY_REASONS).map(([value, label]) => ({ value, label })),
    // null: no cap. 0: every discount needs a manager.
    myDiscountLimit: cap,
    canDiscount: permissions.includes("bills.discount"),
    canComplimentary: permissions.includes("bills.complimentary"),
    canReprint: permissions.includes("bills.reprint"),
  };
};

module.exports = {
  loyaltyHistory,
  daySummary,
  listCreditNotes,
  tillOptions,
};
