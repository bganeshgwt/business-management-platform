// Item and menu reports: item sales, dish profitability.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const { round2 } = require("../../../../../utils/money");
const { num } = require("./common");
const { describe, scopeFor } = require("./scope");
const { stockCostBreakdown } = require("../../repositories/report/profitLoss");
const { foodCostParts } = require("./profitLoss");

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

// Dish profitability (SW-B-15): each dish and size sold in the range, what it
// sold before GST, what its ingredients cost (the stock its bills really took,
// at the cost of the day: see reportRepository.dishProfitability), the food
// cost % and what is left per plate and in all. Nothing of it is on the
// dashboard.
const dishProfitability = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const [rows, breakdown] = await Promise.all([
    reportRepository.dishProfitability(context.scope),
    stockCostBreakdown(context.scope),
  ]);
  const unmatchedRow = rows.find((row) => row.item_name === null);
  const dishes = rows
    .filter((row) => row.item_name !== null)
    .map((row) => {
      const quantity = num(row.quantity);
      const sales = round2(num(row.sales));
      const cost = round2(num(row.cost));

      return {
        productId: row.product_id || null,
        variantId: row.product_variant_id || null,
        itemName: row.item_name,
        variantName: row.variant_name || null,
        hasRecipe: Boolean(row.has_recipe),
        quantity,
        sales,
        costPerPortion: quantity > 0 ? round2(cost / quantity) : 0,
        foodCost: cost,
        // No recipe: no food cost % to speak of (it would read 0%).
        foodCostPercent: row.has_recipe && sales > 0 ? round2((cost / sales) * 100) : null,
        contributionPerPortion: quantity > 0 ? round2((sales - cost) / quantity) : 0,
        contribution: round2(sales - cost),
      };
    })
    .sort((a, b) => b.contribution - a.contribution);
  const unmatched = unmatchedRow ? round2(num(unmatchedRow.cost)) : 0;
  const sales = round2(dishes.reduce((sum, row) => sum + row.sales, 0));
  const foodCost = round2(dishes.reduce((sum, row) => sum + row.foodCost, 0) + unmatched);

  return {
    ...describe(context),
    dishes,
    totals: {
      sales,
      foodCost,
      foodCostPercent: sales > 0 ? round2((foodCost / sales) * 100) : null,
      contribution: round2(sales - foodCost),
      withoutRecipe: dishes.filter((row) => !row.hasRecipe).length,
      // Stock bills took that no line's recipe could account for.
      unmatched,
    },
    // How this food cost (stock the bills took) sits inside the P&L's food
    // cost for the same dates, which also counts production, kitchen issues,
    // stock out by hand and wastage.
    foodCostBreakdown: foodCostParts(breakdown),
  };
};

const itemSales = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const { scope } = context;

  const [items, categories, menu, addons] = await Promise.all([
    reportRepository.itemSales(scope),
    reportRepository.categorySales(scope),
    reportRepository.menuPerformance(scope),
    reportRepository.addonSales(scope),
  ]);

  // Days since the dish last sold, counted from the end of the window rather
  // than from today, so reading last month's report does not report every
  // dish as a month stale.
  const endOfWindow = new Date(`${scope.to}T00:00:00`);
  const daysSince = (value) => {
    if (!value) {
      return null;
    }

    const then = new Date(`${String(value).slice(0, 10)}T00:00:00`);

    return Math.max(0, Math.round((endOfWindow - then) / 86400000));
  };

  const itemRows = items.map((row) => ({
    itemName: row.variant_name ? `${row.item_name} (${row.variant_name})` : row.item_name,
    categoryName: row.category_name || "Uncategorised",
    quantity: num(row.quantity),
    netSales: round2(num(row.net_sales)),
    tax: round2(num(row.tax)),
    grossSales: round2(num(row.gross_sales)),
  }));

  return {
    ...describe(context),
    // Every dish and size sold — the whole list, with its totals, so it ties
    // back to the sales it came from.
    items: itemRows,
    itemTotals: {
      lines: itemRows.length,
      quantity: round2(itemRows.reduce((sum, row) => sum + row.quantity, 0)),
      netSales: round2(itemRows.reduce((sum, row) => sum + row.netSales, 0)),
      tax: round2(itemRows.reduce((sum, row) => sum + row.tax, 0)),
      grossSales: round2(itemRows.reduce((sum, row) => sum + row.grossSales, 0)),
    },
    categories: categories.map((row) => ({
      categoryName: row.category_name,
      quantity: num(row.quantity),
      grossSales: round2(num(row.gross_sales)),
    })),
    // Add-ons sold in the range (SW-B-16): plates that carried each one and
    // what it added (menu price, before any bill discount). Free ones count.
    addons: addons.map((row) => ({
      modifierId: row.modifier_id || null,
      addonName: row.addon_name,
      quantity: num(row.quantity),
      value: round2(num(row.value)),
      billCount: row.bill_count,
      free: num(row.value) === 0,
    })),
    // The whole menu, best to worst, zeroes included.
    menu: menu.map((row) => ({
      productId: row.id,
      itemName: row.name,
      categoryName: row.category_name,
      price: num(row.price),
      foodType: row.food_type,
      isAvailable: row.is_available,
      quantity: num(row.quantity),
      grossSales: round2(num(row.gross_sales)),
      orderCount: num(row.order_count),
      lastSold: row.last_sold ? String(row.last_sold).slice(0, 10) : null,
      daysSinceSold: daysSince(row.last_sold),
    })),
  };
};

module.exports = {
  dishProfitability,
  itemSales,
};
