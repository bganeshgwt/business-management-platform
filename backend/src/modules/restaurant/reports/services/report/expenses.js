// Expense report.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const { round2 } = require("../../../../../utils/money");
const gst = require("../../../billing/services/gstBreakdown");
const { describe, scopeFor } = require("./scope");
const { NO_OUTLET, fallbackNotes, monthsIn, shareBasis, shareOfPool, sumOf } = require("./periods");

// Where the money went, category by category and month by month.
//
// With one outlet picked: that outlet's own expenses, and beside them the
// expenses recorded for the whole restaurant with this outlet's share (by
// sales, as the P&L charges them) — never "no expenses" for a branch that
// pays its part of the rent.
const expenseReport = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const months = monthsIn(context.scope.from, context.scope.to);
  const forOutlet = Boolean(context.scope.outletId);
  const [rows, sharedRows, shares] = await Promise.all([
    reportRepository.expensesByCategory(context.scope),
    forOutlet ? reportRepository.expensesByCategory(context.scope, { shared: true }) : Promise.resolve([]),
    // Shared exactly as the P&L shares them, so the two screens agree.
    forOutlet ? shareBasis(context, months) : Promise.resolve(null),
  ]);

  const categories = new Map();
  const byMode = new Map();
  const status = { approved: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, rejected: { count: 0, amount: 0 } };

  for (const row of rows) {
    const paise = gst.toPaise(row.amount);
    const bucket = status[row.expense_status] || (status[row.expense_status] = { count: 0, amount: 0 });
    bucket.count += row.expense_count;
    bucket.amount += paise;

    if (row.expense_status !== "approved") {
      continue;
    }

    if (!categories.has(row.category_name)) {
      categories.set(row.category_name, {
        categoryName: row.category_name,
        count: 0,
        amount: 0,
        byMonth: new Map(months.map((month) => [month.key, 0])),
      });
    }

    const category = categories.get(row.category_name);
    category.count += row.expense_count;
    category.amount += paise;

    if (category.byMonth.has(row.month)) {
      category.byMonth.set(row.month, category.byMonth.get(row.month) + paise);
    }

    byMode.set(row.payment_mode, (byMode.get(row.payment_mode) || 0) + paise);
  }

  const total = [...categories.values()].reduce((sum, category) => sum + category.amount, 0);

  // Restaurant-wide expenses and this outlet's share of them.
  let shared = null;

  if (forOutlet) {
    const pools = new Map();
    let pendingCount = 0;
    let pendingAmount = 0;

    for (const row of sharedRows) {
      if (row.expense_status === "pending") {
        pendingCount += row.expense_count;
        pendingAmount += gst.toPaise(row.amount);
      }

      if (row.expense_status !== "approved") {
        continue;
      }

      if (!pools.has(row.category_name)) {
        pools.set(row.category_name, {
          count: 0,
          byMonth: new Map(months.map((month) => [month.key, 0])),
        });
      }

      const pool = pools.get(row.category_name);
      pool.count += row.expense_count;

      if (pool.byMonth.has(row.month)) {
        pool.byMonth.set(row.month, pool.byMonth.get(row.month) + gst.toPaise(row.amount));
      }
    }

    const sharedCategories = [...pools.entries()]
      .map(([categoryName, pool]) => ({
        categoryName,
        count: pool.count,
        amount: sumOf(pool.byMonth),
        share: sumOf(shareOfPool(months, pool.byMonth, shares)),
        unassigned: sumOf(shareOfPool(months, pool.byMonth, shares, NO_OUTLET)),
      }))
      .sort((a, b) => b.amount - a.amount);

    const poolTotal = sharedCategories.reduce((sum, row) => sum + row.amount, 0);
    const shareTotal = sharedCategories.reduce((sum, row) => sum + row.share, 0);
    const unassignedTotal = sharedCategories.reduce((sum, row) => sum + row.unassigned, 0);

    shared = {
      // The share of these expenses the outlet carries — share ÷ total, so
      // the percentage on screen is the one the rupees were worked out at.
      percent: poolTotal > 0 ? round2((shareTotal / poolTotal) * 100) : shares.percent,
      // Its share of the restaurant's sales over the range (and whether there
      // were any sales to share by at all).
      salesPercent: shares.percent,
      wholeRevenue: shares.wholeRevenue,
      total: gst.rupees(poolTotal),
      count: sharedCategories.reduce((sum, row) => sum + row.count, 0),
      share: gst.rupees(shareTotal),
      pending: { count: pendingCount, amount: gst.rupees(pendingAmount) },
      categories: sharedCategories.map((row) => ({
        categoryName: row.categoryName,
        count: row.count,
        amount: gst.rupees(row.amount),
        share: gst.rupees(row.share),
      })),
      // What went with sales taken under no outlet.
      unassigned: {
        revenue: gst.rupees(shares.untaggedRevenue),
        percent: shares.untaggedPercent,
        costs: gst.rupees(unassignedTotal),
      },
      notes: fallbackNotes(months, shares, (key) =>
        [...pools.values()].some((pool) => (pool.byMonth.get(key) || 0) !== 0)
      ),
    };
  }

  return {
    ...describe(context),
    months: months.map((month) => ({ key: month.key, label: month.label, partial: month.partial })),
    categories: [...categories.values()]
      .sort((a, b) => b.amount - a.amount)
      .map((category) => ({
        categoryName: category.categoryName,
        count: category.count,
        amount: gst.rupees(category.amount),
        share: total > 0 ? round2((category.amount / total) * 100) : 0,
        byMonth: months.map((month) => gst.rupees(category.byMonth.get(month.key))),
      })),
    byMonth: months.map((month) => ({
      key: month.key,
      label: month.label,
      amount: gst.rupees(
        [...categories.values()].reduce((sum, category) => sum + category.byMonth.get(month.key), 0)
      ),
    })),
    byMode: [...byMode.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([paymentMode, amount]) => ({ paymentMode, amount: gst.rupees(amount) })),
    total: gst.rupees(total),
    approvedCount: status.approved.count,
    pending: { count: status.pending.count, amount: gst.rupees(status.pending.amount) },
    rejected: { count: status.rejected.count, amount: gst.rupees(status.rejected.amount) },
    shared,
  };
};

module.exports = {
  expenseReport,
};
