// Theft and leakage report.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const { round2 } = require("../../../../../utils/money");
const gst = require("../../../billing/services/gstBreakdown");
const { num } = require("./common");
const { describe, scopeFor } = require("./scope");
const ruleSettings = require("../../../setup/services/ruleSettings.service");

// ---------------------------------------------------------------------------
// Theft control
// ---------------------------------------------------------------------------

// Where a large discount starts, unless the screen asks for another line:
// the restaurant's own line (Settings -> Alerts and timings, the same one the
// bell rings at), which until changed is a fifth of the bill, or ₹1,000 on
// any bill.
const DEFAULT_DISCOUNT_PERCENT = ruleSettings.DEFAULTS.alertLargeDiscountPercent;

const DEFAULT_DISCOUNT_AMOUNT = ruleSettings.DEFAULTS.alertLargeDiscountAmount;

const THEFT_LIMIT = 500;

const theftReport = async (restaurantId, range, { outletId = null, discountPercent, discountAmount } = {}) => {
  const [context, rules] = await Promise.all([scopeFor(restaurantId, range, outletId), ruleSettings.load(restaurantId)]);
  const percent = discountPercent ?? rules.alertLargeDiscountPercent;
  const amount = discountAmount ?? rules.alertLargeDiscountAmount;
  const [data, corrections] = await Promise.all([
    reportRepository.theft(context.scope, {
      discountPercent: percent,
      discountAmount: amount,
      limit: THEFT_LIMIT,
    }),
    reportRepository.paymentCorrections(context.scope, THEFT_LIMIT),
  ]);

  // One row per person, from the full totals (not the capped lists).
  const people = new Map();
  const person = (userId, userName) => {
    const key = userId ? `id:${userId}` : `name:${userName || "Unknown"}`;

    if (!people.has(key)) {
      people.set(key, {
        userId: userId || null,
        userName: userName || "Unknown",
        voids: { count: 0, value: 0 },
        refunds: { count: 0, value: 0 },
        discounts: { count: 0, value: 0 },
        reprints: { bills: 0, prints: 0 },
        removedAfterKot: { count: 0, value: 0, served: 0 },
        cashShort: { days: 0, amount: 0 },
        corrections: { count: 0, value: 0 },
      });
    }

    return people.get(key);
  };

  const overall = {
    voids: { count: 0, value: 0 },
    refunds: { count: 0, value: 0 },
    discounts: { count: 0, value: 0 },
    reprints: { bills: 0, prints: 0 },
    removedAfterKot: { count: 0, value: 0, served: 0, coveredByVoid: 0 },
  };

  const addMoney = (kind, field) => {
    for (const row of data.totals[kind]) {
      const who = person(row.user_id, row.user_name);
      who[field].count += row.count;
      who[field].value += gst.toPaise(row.value);
      overall[field].count += row.count;
      overall[field].value += gst.toPaise(row.value);

      if (kind === "removed") {
        who[field].served += row.served;
        overall[field].served += row.served;
        overall[field].coveredByVoid += row.covered;
      }
    }
  };

  addMoney("voids", "voids");
  addMoney("refunds", "refunds");
  addMoney("discounts", "discounts");
  addMoney("removed", "removedAfterKot");

  for (const row of data.totals.reprints) {
    const who = person(row.user_id, row.user_name);
    who.reprints.bills += row.count;
    who.reprints.prints += num(row.value);
    overall.reprints.bills += row.count;
    overall.reprints.prints += num(row.value);
  }

  const cashShort = data.shortDays
    .map((row) => ({
      businessDayId: row.id,
      businessDate: row.business_date,
      // Whose drawer: the main counter's, or an outlet's own day.
      outletId: row.outlet_id || null,
      outletName: row.outlet_name || null,
      expected: round2(num(row.expected_cash)),
      counted: num(row.closing_cash),
      difference: round2(num(row.closing_cash) - num(row.expected_cash)),
      closedAt: row.happened_at,
      userId: row.user_id,
      byName: row.user_name,
    }))
    .filter((row) => row.difference < 0);

  for (const row of cashShort) {
    const who = person(row.userId, row.byName);
    who.cashShort.days += 1;
    who.cashShort.amount += gst.toPaise(-row.difference);
  }

  // Payment corrections, by the person who made them. The money did not
  // leave, it changed method; so they are counted, not added to the money at
  // stake.
  for (const row of corrections) {
    const who = person(row.user_id, row.user_name);
    who.corrections.count += 1;
    who.corrections.value += gst.toPaise(row.amount);
  }

  const staff = [...people.values()]
    .map((row) => ({
      userId: row.userId,
      userName: row.userName,
      voids: { count: row.voids.count, value: gst.rupees(row.voids.value) },
      refunds: { count: row.refunds.count, value: gst.rupees(row.refunds.value) },
      discounts: { count: row.discounts.count, value: gst.rupees(row.discounts.value) },
      reprints: row.reprints,
      removedAfterKot: {
        count: row.removedAfterKot.count,
        value: gst.rupees(row.removedAfterKot.value),
        served: row.removedAfterKot.served,
      },
      cashShort: { days: row.cashShort.days, amount: gst.rupees(row.cashShort.amount) },
      corrections: { count: row.corrections.count, value: gst.rupees(row.corrections.value) },
      // Money that left the till's reach through this person, in one number
      // to sort by. Reprints carry no money of their own.
      exposure: gst.rupees(
        row.voids.value + row.refunds.value + row.discounts.value + row.removedAfterKot.value + row.cashShort.amount
      ),
    }))
    .sort((a, b) => b.exposure - a.exposure || a.userName.localeCompare(b.userName));

  return {
    ...describe(context),
    thresholds: { discountPercent: percent, discountAmount: amount },
    // Every drawer is listed: the main counter's and each outlet's own day.
    cashShortNote: null,
    summary: {
      voids: { count: overall.voids.count, value: gst.rupees(overall.voids.value) },
      refunds: { count: overall.refunds.count, value: gst.rupees(overall.refunds.value) },
      discounts: { count: overall.discounts.count, value: gst.rupees(overall.discounts.value) },
      reprints: overall.reprints,
      removedAfterKot: {
        count: overall.removedAfterKot.count,
        value: gst.rupees(overall.removedAfterKot.value),
        served: overall.removedAfterKot.served,
        // Dishes taken off an order after its bill was voided: listed, but
        // the money is counted once, under voids.
        coveredByVoid: overall.removedAfterKot.coveredByVoid,
      },
      cashShort: {
        days: cashShort.length,
        amount: round2(cashShort.reduce((total, row) => total - row.difference, 0)),
      },
      corrections: {
        count: corrections.length ? corrections[0].total_count : 0,
        value: corrections.length ? round2(num(corrections[0].total_value)) : 0,
        // Cash written up as something else: the one that matters most.
        fromCash: corrections.filter((row) => row.old_method === "cash" && row.new_method !== "cash").length,
      },
    },
    corrections: corrections.map((row) => ({
      id: row.id,
      billNumber: row.bill_number,
      amount: num(row.amount),
      oldMethod: row.old_method,
      newMethod: row.new_method,
      oldTypeName: row.old_type_name || null,
      newTypeName: row.new_type_name || null,
      oldReference: row.old_reference || null,
      newReference: row.new_reference || null,
      reason: row.reason,
      businessDate: row.business_date,
      correctedAt: row.corrected_at,
      byName: row.user_name || null,
      approvedBy: row.approver_name || null,
    })),
    staff,
    // The latest of each, for reading on screen. The totals above count all.
    voids: data.voids.map((row) => ({
      billId: row.id,
      billNumber: row.bill_number,
      amount: num(row.amount),
      reason: row.reason,
      businessDate: row.business_date,
      billedAt: row.billed_at,
      voidedAt: row.happened_at,
      byName: row.user_name,
      approvedBy: row.approver_name,
      afterClose: row.after_close,
    })),
    refunds: data.refunds.map((row) => ({
      refundId: row.id,
      billNumber: row.bill_number,
      amount: num(row.amount),
      method: row.refund_method,
      reason: row.reason,
      businessDate: row.business_date,
      refundedAt: row.happened_at,
      byName: row.user_name,
      approvedBy: row.approver_name,
    })),
    discounts: data.discounts.map((row) => ({
      billId: row.id,
      billNumber: row.bill_number,
      subtotal: num(row.subtotal),
      amount: round2(num(row.amount)),
      percent: num(row.percent),
      code: row.discount_code || null,
      businessDate: row.business_date,
      billedAt: row.happened_at,
      byName: row.user_name,
    })),
    reprints: data.reprints.map((row) => ({
      billId: row.id,
      billNumber: row.bill_number,
      amount: num(row.amount),
      printCount: row.print_count,
      reprints: row.reprints,
      billStatus: row.bill_status,
      lastPrintedAt: row.happened_at,
      businessDate: row.business_date,
      byName: row.user_name,
      approvedBy: row.approver_name,
    })),
    removed: data.removed.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      itemName: row.variant_name ? `${row.item_name} (${row.variant_name})` : row.item_name,
      quantity: num(row.quantity),
      amount: num(row.amount),
      kitchenStage: row.kitchen_stage,
      reasonCode: row.reason_code,
      reasonNote: row.reason_note,
      businessDate: row.business_date,
      removedAt: row.happened_at,
      byName: row.user_name,
      approvedBy: row.approver_name,
      coveredByVoid: Boolean(row.covered_by_void),
      voidedBill: row.voided_bill || null,
    })),
    cashShort,
    limit: THEFT_LIMIT,
  };
};

module.exports = {
  DEFAULT_DISCOUNT_PERCENT,
  DEFAULT_DISCOUNT_AMOUNT,
  theftReport,
};
