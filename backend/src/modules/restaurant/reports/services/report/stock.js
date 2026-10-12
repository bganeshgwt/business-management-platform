// Stock consumption report.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const { round2 } = require("../../../../../utils/money");
const { num } = require("./common");
const { describe, scopeFor } = require("./scope");

// Stock movement in money terms, so purchases and wastage can be compared.
const consumptionReport = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const rows = await reportRepository.consumptionReport(context.scope);

  return {
    ...describe(context),
    rows: rows.map((row) => {
      const lastCost = row.last_cost === null ? 0 : num(row.last_cost);

      return {
        itemName: row.item_name,
        unitShortName: row.unit_short_name,
        purchased: round2(num(row.purchased)),
        purchaseValue: round2(num(row.purchase_value)),
        consumed: Math.round(num(row.consumed) * 1000) / 1000,
        wasted: Math.round(num(row.wasted) * 1000) / 1000,
        currentStock: num(row.current_stock),
        consumedValue: round2(num(row.consumed) * lastCost),
        wastedValue: round2(num(row.wasted) * lastCost),
      };
    }),
  };
};

module.exports = {
  consumptionReport,
};
