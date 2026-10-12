// Sales reports: sales summary, outlet comparison, discounts, cancellations.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const { DISCOUNT_REASONS } = require("../../../billing/services/bill.service");
const { round2 } = require("../../../../../utils/money");
const { coverFigures, num } = require("./common");
const { describe, scopeFor } = require("./scope");

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

const salesSummary = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const { scope } = context;

  const [summary, byDay, byHour, byType, byMode, coverRows, byPayType] = await Promise.all([
    reportRepository.salesSummary(scope),
    reportRepository.salesByDay(scope),
    reportRepository.salesByHour(scope),
    reportRepository.orderTypes(scope),
    reportRepository.paymentModes(scope),
    reportRepository.covers(scope),
    reportRepository.paymentTypes(scope),
  ]);

  const coverInfo = coverFigures(coverRows[0]);

  return {
    ...describe(context),
    summary: {
      billCount: summary.bill_count,
      grossSales: num(summary.gross_sales),
      discounts: num(summary.discounts),
      tax: num(summary.tax),
      serviceCharge: num(summary.service_charge),
      roundOff: num(summary.round_off),
      netSales: num(summary.net_sales),
      collected: num(summary.collected),
      refunded: num(summary.refunded),
      averageBill: round2(num(summary.average_bill)),
      // Delivery charges billed, already inside the sales above, and their GST.
      deliveryCharges: round2(num(summary.delivery_charges)),
      deliveryChargeTax: round2(num(summary.delivery_charge_tax)),
      deliveryChargeBills: summary.delivery_charge_bills || 0,
      // Tips given with the payments: on top of the sales, never in them.
      tips: round2(byMode.reduce((total, row) => total + num(row.tips), 0)),
      ...coverInfo,
      // The names this figure had before, for anything still reading them.
      // Same definition as above: dine-in covers and dine-in spend per head.
      guests: coverInfo.covers,
      perGuest: coverInfo.perHead,
    },
    // Every day of the range, the ones with no sales included.
    byDay: byDay.map((row) => ({
      businessDate: row.business_date,
      billCount: row.bill_count,
      netSales: round2(num(row.net_sales)),
      discounts: round2(num(row.discounts)),
      averageBill: round2(num(row.average_bill)),
    })),
    daysTraded: byDay.filter((row) => row.bill_count > 0).length,
    byHour: byHour.map((row) => ({
      hour: row.hour,
      billCount: row.bill_count,
      netSales: num(row.net_sales),
    })),
    byOrderType: byType.map((row) => ({
      orderType: row.order_type,
      billCount: row.bill_count,
      netSales: num(row.net_sales),
      averageBill: round2(num(row.average_bill)),
    })),
    // The owner's named payment types, each under its method.
    byPaymentType: byPayType.map((row) => ({
      paymentMethod: row.payment_method,
      paymentTypeId: row.payment_type_id,
      paymentTypeName: row.payment_type_name,
      paymentCount: row.payment_count,
      amount: round2(num(row.amount)),
    })),
    byPaymentMode: byMode.map((row) => ({
      tips: round2(num(row.tips)),
      paymentMethod: row.payment_method,
      paymentCount: row.payment_count,
      amount: num(row.amount),
    })),
  };
};

// ---------------------------------------------------------------------------
// Outlets
// ---------------------------------------------------------------------------

// Outlet against outlet, for the same dates. Always the whole chain.
const outletComparison = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const whole = { ...context.scope, outletId: null };

  const [rows, coverRows] = await Promise.all([
    reportRepository.outletComparison(whole),
    reportRepository.covers(whole, "b.outlet_id"),
  ]);

  const coversByOutlet = new Map(coverRows.map((row) => [row.group_key, row]));
  const total = rows.reduce((sum, row) => sum + num(row.net_sales), 0);

  return {
    ...describe(context),
    // Said plainly, because the switcher narrows every other report.
    comparesAllOutlets: true,
    total: round2(total),
    outlets: rows.map((row) => {
      const coverInfo = coverFigures(coversByOutlet.get(row.outlet_id));

      return {
        outletId: row.outlet_id,
        outletName: row.outlet_name,
        outletCode: row.outlet_code,
        billCount: row.bill_count,
        guests: coverInfo.covers,
        perHead: coverInfo.perHead,
        grossSales: round2(num(row.gross_sales)),
        netSales: round2(num(row.net_sales)),
        tax: round2(num(row.tax)),
        discounts: round2(num(row.discounts)),
        averageBill: round2(num(row.average_bill)),
        // Share of the chain, which is the number a head office actually reads.
        share: total > 0 ? round2((num(row.net_sales) / total) * 100) : 0,
      };
    }),
  };
};

// ---------------------------------------------------------------------------
// Discounts, staff, cancellations, stock
// ---------------------------------------------------------------------------

const discountReport = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const rows = await reportRepository.discountReport(context.scope);
  const labelOf = (row) => {
    switch (row.kind) {
      case "coupon":
        return `Coupon ${row.discount_code}`;
      case "till":
        return row.reason ? DISCOUNT_REASONS[row.reason] || row.reason : "No reason recorded";
      case "points":
        return "Points redeemed by guests";
      case "complimentary":
        return "No-charge bills";
      default:
        return row.discount_code;
    }
  };

  return {
    ...describe(context),
    // One row per kind of discount (and coupon code, and till reason). A
    // bill with a coupon and points on it is under both, so "bills" can add
    // up to more than the bills that had a discount.
    rows: rows.map((row) => ({
      kind: row.kind,
      discountCode: row.kind === "coupon" ? row.discount_code : labelOf(row),
      label: labelOf(row),
      reason: row.reason || null,
      timesUsed: row.times_used,
      points: row.points || 0,
      discountTotal: num(row.discount_total),
      netSales: num(row.net_sales),
    })),
    totals: {
      discountTotal: round2(rows.reduce((sum, row) => sum + num(row.discount_total), 0)),
      // What staff gave away, apart from what guests paid with their points.
      given: round2(rows.filter((row) => row.kind !== "points").reduce((sum, row) => sum + num(row.discount_total), 0)),
      points: round2(rows.filter((row) => row.kind === "points").reduce((sum, row) => sum + num(row.discount_total), 0)),
    },
  };
};

const CANCELLATION_LIMIT = 1000;

const cancellationReport = async (restaurantId, range, outletId = null, { voidPage = null, cancelPage = null, pageSize = null } = {}) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const paged = Boolean(voidPage || cancelPage || pageSize);
  const size = paged ? pageSize || 25 : CANCELLATION_LIMIT;
  const voidOffset = paged ? ((voidPage || 1) - 1) * size : 0;
  const cancelOffset = paged ? ((cancelPage || 1) - 1) * size : 0;
  const data = await reportRepository.cancellationReport(context.scope, size, { voidOffset, cancelOffset });
  // A page past the end carries no totals: read them from the first row.
  const totalsOf = async (rows, offset, key) =>
    rows.length === 0 && offset > 0 ? (await reportRepository.cancellationReport(context.scope, 1))[key] : rows;
  const cancelHead = await totalsOf(data.cancelledOrders, cancelOffset, "cancelledOrders");
  const voidHead = await totalsOf(data.voidedBills, voidOffset, "voidedBills");
  const head = (rows) => ({
    count: rows.length ? rows[0].total_count : 0,
    value: rows.length ? round2(num(rows[0].total_value)) : 0,
    shown: rows.length,
  });

  return {
    ...describe(context),
    paging: paged ? { pageSize: size, voidPage: voidPage || 1, cancelPage: cancelPage || 1 } : null,
    cancelledTotals: { ...head(cancelHead), shown: data.cancelledOrders.length },
    voidedTotals: { ...head(voidHead), shown: data.voidedBills.length },
    cancelledOrders: data.cancelledOrders.map((row) => ({
      orderNumber: row.order_number,
      orderType: row.order_type,
      amount: num(row.total_amount),
      reason: row.cancel_reason,
      placedAt: row.placed_at,
      cancelledAt: row.cancelled_at,
      businessDate: row.business_date,
      byName: row.cancelled_by,
      approvedBy: row.approved_by,
    })),
    voidedBills: data.voidedBills.map((row) => ({
      billNumber: row.bill_number,
      orderNumber: row.order_number,
      amount: num(row.total_amount),
      reason: row.void_reason,
      billedAt: row.billed_at,
      voidedAt: row.voided_at,
      businessDate: row.business_date,
      byName: row.voided_by,
      approvedBy: row.approved_by,
    })),
  };
};

module.exports = {
  salesSummary,
  outletComparison,
  discountReport,
  cancellationReport,
};
