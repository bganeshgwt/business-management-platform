// Staff reports: staff and waiter performance.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const { round2 } = require("../../../../../utils/money");
const { coverFigures, num } = require("./common");
const { describe, scopeFor } = require("./scope");

const staffReport = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const rows = await reportRepository.staffReport(context.scope);

  return {
    ...describe(context),
    rows: rows.map((row) => ({
      userName: row.user_name,
      billCount: row.bill_count,
      netSales: num(row.net_sales),
      averageBill: round2(num(row.average_bill)),
    })),
  };
};

// Captain / waiter-wise: who took the orders, what they sold, their covers and
// per head, and the dishes taken off their orders after the kitchen had them.
const waiterReport = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const [data, coverRows, sectionRows] = await Promise.all([
    reportRepository.waiterReport(context.scope),
    reportRepository.covers(context.scope, "o.created_by"),
    reportRepository.captainSections(context.scope),
  ]);

  const plates = new Map(data.items.map((row) => [row.user_id, num(row.plates)]));
  const removed = new Map(data.removed.map((row) => [row.user_id, row]));
  const coverMap = new Map(coverRows.map((row) => [row.group_key, row]));
  const sold = new Set(data.sales.map((row) => row.user_id));

  // Someone with dishes taken off after the KOT but nothing billed — every
  // order cancelled once the kitchen had it — is listed too, with no sales.
  // Leaving them out hid the one pattern this column exists to show.
  const people = [
    ...data.sales,
    ...data.removed
      .filter((row) => !sold.has(row.user_id) && (row.removed_count > 0 || row.covered_count > 0))
      .map((row) => ({ user_id: row.user_id, user_name: row.user_name, order_count: 0, dine_in_orders: 0 })),
  ];

  const rows = people.map((row) => {
    const coverInfo = coverFigures(coverMap.get(row.user_id));
    const off = removed.get(row.user_id);

    return {
      userId: row.user_id,
      userName: row.user_name,
      orderCount: row.order_count,
      dineInOrders: row.dine_in_orders,
      netSales: round2(num(row.net_sales)),
      dineInSales: round2(num(row.dine_in_sales)),
      takeawaySales: round2(num(row.takeaway_sales)),
      deliverySales: round2(num(row.delivery_sales)),
      discounts: round2(num(row.discounts)),
      averageOrder: row.order_count > 0 ? round2(num(row.net_sales) / row.order_count) : 0,
      plates: plates.get(row.user_id) || 0,
      covers: coverInfo.covers,
      perHead: coverInfo.perHead,
      // Counted: dishes taken off a live order. Not counted: dishes that
      // only closed out a bill already voided (theft control lists them as
      // "part of void"); the void carries that money.
      removedAfterKot: off ? off.removed_count : 0,
      removedValue: off ? round2(num(off.removed_value)) : 0,
      removedWithVoid: off ? off.covered_count : 0,
    };
  });

  return {
    ...describe(context),
    rows,
    totals: {
      orderCount: rows.reduce((sum, row) => sum + row.orderCount, 0),
      netSales: round2(rows.reduce((sum, row) => sum + row.netSales, 0)),
      covers: rows.reduce((sum, row) => sum + row.covers, 0),
      plates: round2(rows.reduce((sum, row) => sum + row.plates, 0)),
      removedAfterKot: rows.reduce((sum, row) => sum + row.removedAfterKot, 0),
      removedValue: round2(rows.reduce((sum, row) => sum + row.removedValue, 0)),
      removedWithVoid: rows.reduce((sum, row) => sum + row.removedWithVoid, 0),
    },
    // Dine-in sales by captain section (Tables & QR → Captain sections): each bill
    // under the captain who held its table that day; captainId null for
    // tables no captain was given.
    sections: sectionRows.map((row) => ({
      captainId: row.captain_id || null,
      captainName: row.captain_name || null,
      sections: row.sections || null,
      orderCount: row.order_count,
      tableCount: row.table_count,
      guests: row.guests,
      netSales: round2(num(row.net_sales)),
      perHead: row.guests > 0 ? round2(num(row.net_sales) / row.guests) : 0,
    })),
  };
};

module.exports = {
  staffReport,
  waiterReport,
};
