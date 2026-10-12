// Profit and loss statement.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const staffService = require("../../../staff/services/staff.service");
const { round2 } = require("../../../../../utils/money");
const gst = require("../../../billing/services/gstBreakdown");
const { rupeeText } = require("./common");
const { describe, scopeFor } = require("./scope");
const { stockCostBreakdown } = require("../../repositories/report/profitLoss");
const { NO_OUTLET, addTo, combine, fallbackNotes, lineOut, monthsIn, plLine, shareBasis, shareOfPool, sumOf } = require("./periods");

// Did we make money? Sales (before GST, after discounts and refunds), less
// what the food cost, less the running expenses and the staff.
//
//   basis "consumption"  food cost = ingredients used by sales and issued to
//                        the kitchen, plus wastage, each at cost. The truer
//                        figure when stock is kept properly.
//   basis "purchases"    food cost = supplier bills, less returns. For a
//                        restaurant that buys daily and keeps little stock.
//
// Salaries only for someone allowed to see them (staff.salaries); without
// it the bottom line is "profit before salaries" and says so.
//
// With one outlet picked: that outlet's own sales, food cost, expenses and
// staff, then its share (by sales) of the costs recorded for the whole
// restaurant — so the outlets' profits add up to the restaurant's.
// The parts of the stock-basis food cost (repositories/report/profitLoss.js
// stockCostBreakdown), in rupees. used = sold + kitchenIssues + manual + other,
// to the paisa; total = used + wastage. `production` (ingredients moved into
// prepared items) is shown beside it, not in it: that stock counts when the
// prepared item is sold or written off.
const foodCostParts = (row) => {
  const paise = (value) => gst.toPaise(value || 0);
  const parts = {
    sold: paise(row.sold),
    production: paise(row.production),
    kitchenIssues: paise(row.kitchen),
    manual: paise(row.manual),
    other: paise(row.other_used),
    wastage: paise(row.wasted),
  };
  const used = parts.sold + parts.kitchenIssues + parts.manual + parts.other;

  return {
    sold: gst.rupees(parts.sold),
    // Of `sold`: stock marked as a bill's that no bill can be found for.
    soldWithoutBill: gst.rupees(paise(row.sold_no_bill)),
    production: gst.rupees(parts.production),
    kitchenIssues: gst.rupees(parts.kitchenIssues),
    manual: gst.rupees(parts.manual),
    other: gst.rupees(parts.other),
    wastage: gst.rupees(parts.wastage),
    used: gst.rupees(used),
    total: gst.rupees(used + parts.wastage),
    usedWithoutCost: Number(row.used_without_cost) || 0,
  };
};

const profitAndLoss = async (restaurantId, range, { outletId = null, basis = "consumption", canSeePayroll = false } = {}) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const { scope } = context;
  const months = monthsIn(scope.from, scope.to);
  const forOutlet = Boolean(scope.outletId);

  const [revenue, refunds, stock, purchases, expenses, employees, breakdown] = await Promise.all([
    reportRepository.revenueByMonth(scope),
    reportRepository.refundsByMonth(scope),
    basis === "consumption" ? reportRepository.stockCostByMonth(scope) : Promise.resolve([]),
    basis === "purchases" ? reportRepository.purchasesByMonth(scope) : Promise.resolve({ receipts: [], returns: [] }),
    reportRepository.expensesByCategory(scope),
    canSeePayroll && forOutlet ? reportRepository.employeeOutlets(restaurantId) : Promise.resolve([]),
    // What the food cost is made of (only on the stock basis).
    basis === "consumption" ? stockCostBreakdown(scope) : Promise.resolve(null),
  ]);

  // --- Revenue --------------------------------------------------------
  const sales = plLine(months, "sales", "Food & beverage sales", { section: "revenue" });
  const discounts = plLine(months, "discounts", "Less discounts", { section: "revenue" });
  const serviceCharge = plLine(months, "serviceCharge", "Service charge", { section: "revenue" });
  const deliveryCharges = plLine(months, "deliveryCharges", "Delivery charges", { section: "revenue" });
  const roundOff = plLine(months, "roundOff", "Round off on bills", { section: "revenue" });
  const refundLine = plLine(months, "refunds", "Less refunds (before GST)", { section: "revenue" });
  let gstCollected = 0;

  for (const row of revenue) {
    addTo(sales, row.month, gst.toPaise(row.gross_sales));
    addTo(discounts, row.month, -gst.toPaise(row.discounts));
    addTo(serviceCharge, row.month, gst.toPaise(row.service_charge));
    addTo(deliveryCharges, row.month, gst.toPaise(row.delivery_charges));
    addTo(roundOff, row.month, gst.toPaise(row.round_off));
    gstCollected += gst.toPaise(row.tax);
  }

  for (const row of refunds) {
    addTo(refundLine, row.month, -(gst.toPaise(row.amount) - gst.toPaise(row.tax_part)));
  }

  const netRevenue = combine(
    months,
    "netRevenue",
    "Net revenue",
    [
      [sales, 1],
      [discounts, 1],
      [serviceCharge, 1],
      [deliveryCharges, 1],
      [roundOff, 1],
      [refundLine, 1],
    ],
    { kind: "subtotal", section: "revenue" }
  );

  // --- Cost of food ---------------------------------------------------
  const costLines = [];

  if (basis === "consumption") {
    const used = plLine(months, "foodUsed", "Ingredients used (at cost)", {
      section: "foodCost",
      hint: forOutlet
        ? "What this outlet's bills and its own store used, net of voided bills, at each item's latest cost"
        : "What sales and kitchen issues took out of stock, net of voided bills, at each item's latest cost. Ingredients made into prepared items count when those are used",
    });
    const wasted = plLine(months, "wastage", "Wastage (at cost)", { section: "foodCost" });

    for (const row of stock) {
      addTo(used, row.month, gst.toPaise(row.used_value));
      addTo(wasted, row.month, gst.toPaise(row.wasted_value));
    }

    costLines.push(used, wasted);
  } else {
    const bought = plLine(months, "purchases", "Supplier bills (including GST)", {
      section: "foodCost",
      hint: "GST on food purchases cannot be claimed back by a restaurant charging 5%, so it is part of the cost",
    });
    const sentBack = plLine(months, "purchaseReturns", "Less goods returned", { section: "foodCost" });

    for (const row of purchases.receipts) {
      addTo(bought, row.month, gst.toPaise(row.amount));
    }

    for (const row of purchases.returns) {
      addTo(sentBack, row.month, -gst.toPaise(row.amount));
    }

    costLines.push(bought, sentBack);
  }

  const foodCost = combine(
    months,
    "foodCost",
    "Cost of food",
    costLines.map((line) => [line, 1]),
    { kind: "subtotal", section: "foodCost" }
  );

  const grossProfit = combine(
    months,
    "grossProfit",
    "Gross profit",
    [
      [netRevenue, 1],
      [foodCost, -1],
    ],
    { kind: "total", section: "grossProfit" }
  );

  // --- Expenses -------------------------------------------------------
  const categories = new Map();
  const pending = { count: 0, amount: 0 };

  for (const row of expenses) {
    if (row.expense_status === "pending") {
      pending.count += row.expense_count;
      pending.amount += gst.toPaise(row.amount);
    }

    if (row.expense_status !== "approved") {
      continue;
    }

    if (!categories.has(row.category_name)) {
      categories.set(
        row.category_name,
        plLine(months, `expense:${row.category_name}`, row.category_name, { section: "expenses" })
      );
    }

    addTo(categories.get(row.category_name), row.month, gst.toPaise(row.amount));
  }

  const lineTotal = (line) => [...line.byMonth.values()].reduce((sum, value) => sum + value, 0);
  const expenseLines = [...categories.values()].sort((a, b) => lineTotal(b) - lineTotal(a));

  const totalExpenses = combine(
    months,
    "totalExpenses",
    forOutlet ? "This outlet's own expenses" : "Total expenses",
    expenseLines.map((line) => [line, 1]),
    { kind: "subtotal", section: "expenses" }
  );

  // --- Payroll --------------------------------------------------------
  // With an outlet picked: its own staff here, and staff tied to no outlet
  // (a manager, the central kitchen) in the shared pool below.
  let payroll = null;
  const sharedPayrollPool = new Map(months.map((month) => [month.key, 0]));

  if (canSeePayroll) {
    payroll = plLine(months, "payroll", forOutlet ? "This outlet's staff salaries" : "Staff salaries", {
      section: "payroll",
      hint: "Pay earned from attendance, plus bonuses and arrears (Staff → Payroll)",
    });

    const outletOf = new Map(employees.map((row) => [row.id, row.outlet_id]));
    const payOf = (rows) =>
      rows.reduce((sum, row) => sum + gst.toPaise(row.estimatedPay) + gst.toPaise(row.bonus), 0);

    for (const month of months) {
      const summary = await staffService.payrollSummary(restaurantId, month.from, month.to);

      if (!forOutlet) {
        addTo(payroll, month.key, payOf(summary.employees));
        continue;
      }

      const outletOfRow = (row) => outletOf.get(row.employeeId);
      addTo(
        payroll,
        month.key,
        payOf(summary.employees.filter((row) => Number(outletOfRow(row)) === Number(scope.outletId)))
      );
      sharedPayrollPool.set(
        month.key,
        payOf(summary.employees.filter((row) => outletOfRow(row) === null || outletOfRow(row) === undefined))
      );
    }
  }

  // --- Shared costs (one outlet picked) --------------------------------
  let shares = null;
  let sharedLines = [];
  let sharedCosts = null;
  let contribution = null;
  const pools = { expenses: 0, payroll: 0, food: 0 };
  // Every pool shared out, and the part of them that went with the sales
  // taken under no outlet (in no outlet's P&L).
  const sharedPools = [];
  let unassignedCosts = 0;
  let unassignedStock = 0;

  if (forOutlet) {
    const [sharedStock, sharedPurchases, sharedExpenses, basisOfShares, looseStock] = await Promise.all([
      basis === "consumption" ? reportRepository.stockCostByMonth(scope, { shared: true }) : Promise.resolve([]),
      basis === "purchases"
        ? reportRepository.purchasesByMonth(scope, { shared: true })
        : Promise.resolve({ receipts: [], returns: [] }),
      reportRepository.expensesByCategory(scope, { shared: true }),
      shareBasis(context, months),
      basis === "consumption" ? reportRepository.stockCostByMonth(scope, { unassigned: true }) : Promise.resolve([]),
    ]);

    shares = basisOfShares;
    // What the sales taken under no outlet used from the main store.
    unassignedStock = looseStock.reduce(
      (sum, row) => sum + gst.toPaise(row.used_value) + gst.toPaise(row.wasted_value),
      0
    );

    // One pool of restaurant-wide money as a line of this outlet's P&L.
    const sharedLine = (pool, key, label) => {
      const line = plLine(months, key, label, { section: "shared" });
      line.byMonth = shareOfPool(months, pool, shares);
      sharedPools.push(pool);
      unassignedCosts += sumOf(shareOfPool(months, pool, shares, NO_OUTLET));
      return line;
    };

    const poolOf = (rows, value) => {
      const pool = new Map(months.map((month) => [month.key, 0]));
      for (const row of rows) {
        if (pool.has(row.month)) {
          pool.set(row.month, pool.get(row.month) + value(row));
        }
      }
      return pool;
    };

    // Restaurant-wide expenses, category by category.
    const expensePools = new Map();

    for (const row of sharedExpenses) {
      // Restaurant-wide money still waiting for approval is not a cost yet,
      // but the owner reading one outlet should hear about it too.
      if (row.expense_status === "pending") {
        pending.count += row.expense_count;
        pending.amount += gst.toPaise(row.amount);
      }

      if (row.expense_status !== "approved") {
        continue;
      }

      if (!expensePools.has(row.category_name)) {
        expensePools.set(row.category_name, new Map(months.map((month) => [month.key, 0])));
      }

      const pool = expensePools.get(row.category_name);

      if (pool.has(row.month)) {
        pool.set(row.month, pool.get(row.month) + gst.toPaise(row.amount));
      }
    }

    for (const [name, pool] of expensePools) {
      pools.expenses += sumOf(pool);
      sharedLines.push(sharedLine(pool, `shared:expense:${name}`, name));
    }

    sharedLines.sort((a, b) => lineTotal(b) - lineTotal(a));

    // The main store's food cost that no bill explains.
    const foodPool =
      basis === "consumption"
        ? poolOf(sharedStock, (row) => gst.toPaise(row.used_value) + gst.toPaise(row.wasted_value))
        : (() => {
            const pool = poolOf(sharedPurchases.receipts, (row) => gst.toPaise(row.amount));
            for (const row of sharedPurchases.returns) {
              if (pool.has(row.month)) {
                pool.set(row.month, pool.get(row.month) - gst.toPaise(row.amount));
              }
            }
            return pool;
          })();
    pools.food = sumOf(foodPool);

    if (pools.food !== 0) {
      sharedLines.push(
        sharedLine(
          foodPool,
          "shared:food",
          basis === "consumption" ? "Main store: kitchen issues and wastage" : "Main store: supplier bills less returns"
        )
      );
    }

    pools.payroll = sumOf(sharedPayrollPool);

    if (payroll && pools.payroll !== 0) {
      sharedLines.push(sharedLine(sharedPayrollPool, "shared:payroll", "Salaries of staff working for the whole restaurant"));
    }

    // What this outlet carries of all of it, as a share of the pools. Not the
    // share of sales quoted in the notes: a month with no sales is shared the
    // way its nearest trading month was, so the two can differ.
    const poolTotal = pools.expenses + pools.food + (payroll ? pools.payroll : 0);
    const carried = sharedLines.reduce((sum, line) => sum + lineTotal(line), 0);
    shares.carriedPercent = poolTotal > 0 ? round2((carried / poolTotal) * 100) : shares.percent;

    if (sharedLines.length > 0) {
      contribution = combine(
        months,
        "contribution",
        payroll ? "Profit before shared costs" : "Profit before shared costs and salaries",
        [
          [grossProfit, 1],
          [totalExpenses, -1],
          ...(payroll ? [[payroll, -1]] : []),
        ],
        { kind: "total", section: "contribution" }
      );
      sharedCosts = combine(
        months,
        "sharedCosts",
        `Share of restaurant-wide costs (${shares.carriedPercent}%)`,
        sharedLines.map((line) => [line, 1]),
        { kind: "subtotal", section: "shared" }
      );
    } else {
      sharedLines = [];
    }
  }

  const bottom = combine(
    months,
    "netProfit",
    payroll ? "Net profit" : "Profit before salaries",
    [
      [grossProfit, 1],
      [totalExpenses, -1],
      ...(payroll ? [[payroll, -1]] : []),
      ...(sharedCosts ? [[sharedCosts, -1]] : []),
    ],
    { kind: "total", section: "netProfit" }
  );

  const lines = [
    sales,
    discounts,
    serviceCharge,
    deliveryCharges,
    roundOff,
    refundLine,
    netRevenue,
    ...costLines,
    foodCost,
    grossProfit,
    ...expenseLines,
    totalExpenses,
    ...(payroll ? [payroll] : []),
    ...(contribution ? [contribution, ...sharedLines, sharedCosts] : []),
    bottom,
  ].map((line) => lineOut(months, line));

  const find = (key) => lines.find((line) => line.key === key);
  const netRevenueAmount = find("netRevenue").amount;
  const percentOf = (amount) => (netRevenueAmount > 0 ? round2((amount / netRevenueAmount) * 100) : null);
  const rupeeWords = (paise) => rupeeText(gst.rupees(paise));

  const notes = [
    `GST collected on sales (${rupeeWords(gstCollected)}) is the government's money and is left out.`,
  ];
  // What the owner must not miss: shown above the statement, not in its
  // footnotes.
  const warnings = [];

  if (pending.count > 0) {
    notes.push(
      `${pending.count} ${pending.count === 1 ? "expense" : "expenses"} (${rupeeWords(pending.amount)}) still waiting for approval ${
        pending.count === 1 ? "is" : "are"
      } not counted.`
    );
  }

  if (!canSeePayroll) {
    notes.push("Salaries are hidden: your role cannot see salaries, so this stops at profit before salaries.");
  }

  if (forOutlet) {
    const outletName = context.outlet.name;

    if (sharedCosts) {
      const parts = [
        pools.expenses !== 0 && `${rupeeWords(pools.expenses)} of expenses`,
        payroll && pools.payroll !== 0 && `${rupeeWords(pools.payroll)} of salaries for staff not tied to an outlet`,
        pools.food !== 0 &&
          `${rupeeWords(pools.food)} of ${basis === "consumption" ? "main-store kitchen issues and wastage" : "main-store supplier bills"}`,
      ].filter(Boolean);

      notes.push(
        shares.wholeRevenue > 0
          ? `Costs recorded for the whole restaurant (${parts.join(", ")}) are shared out by sales, month by month: ${outletName} made ${shares.percent}% of the restaurant's net revenue in this period and carries ${rupeeText(find("sharedCosts").amount)} of them (${shares.carriedPercent}%).`
          : `Costs recorded for the whole restaurant (${parts.join(", ")}) are shared out by sales, month by month. The restaurant made no sales in this period, so they are shared as the note below says: ${outletName} carries ${rupeeText(find("sharedCosts").amount)} of them (${shares.carriedPercent}%).`
      );
      notes.push(
        ...fallbackNotes(months, shares, (key) => sharedPools.some((pool) => (pool.get(key) || 0) !== 0))
      );
    } else {
      notes.push(`No costs were recorded for the whole restaurant in this period, so ${outletName} carries only its own.`);
    }

    // Sales taken with "All outlets" picked belong to no outlet. Said on the
    // P&L itself, because it is why the outlets' P&Ls do not add up to the
    // restaurant's — and at a restaurant that has only just added outlets it
    // can be nearly all of its sales.
    if (shares.untaggedRevenue !== 0) {
      warnings.push(
        `${rupeeWords(shares.untaggedRevenue)} of sales (${shares.untaggedPercent}% of the restaurant's net revenue) were taken at the main counter, which is not an outlet. They${
          unassignedStock !== 0 ? `, the ${rupeeWords(unassignedStock)} of stock they used` : ""
        }${
          unassignedCosts !== 0 ? ` and ${rupeeWords(unassignedCosts)} of the restaurant-wide costs` : ""
        } are in no outlet's P&L, so the outlets add up to the whole restaurant less the main counter.`
      );
    }

    if (payroll) {
      notes.push("Staff assigned to this outlet are its own salaries; staff tied to no outlet are shared out with the other costs.");
    }

    if (basis === "consumption" && context.outlet && !context.outlet.own_store) {
      notes.push(
        `${outletName} draws its stock from the main store: its food cost is what its own bills took from there, valued at cost.`
      );
    }
  }

  if (basis === "consumption") {
    notes.push("Food cost is valued at each ingredient's latest cost. Dishes without a recipe take nothing out of stock.");
  }

  return {
    ...describe(context),
    basis,
    payrollShown: Boolean(payroll),
    months: months.map((month) => ({
      key: month.key,
      label: month.label,
      from: month.from,
      to: month.to,
      partial: month.partial,
    })),
    lines,
    // The P&L's own food cost (Ingredients used + Wastage) split by what took
    // the stock out, so it can be set beside Dish profitability.
    ...(breakdown ? { foodCostBreakdown: foodCostParts(breakdown) } : {}),
    ratios: {
      foodCostPercent: percentOf(find("foodCost").amount),
      grossMarginPercent: percentOf(find("grossProfit").amount),
      expensesPercent: percentOf(find("totalExpenses").amount),
      payrollPercent: payroll ? percentOf(find("payroll").amount) : null,
      sharedPercent: sharedCosts ? percentOf(find("sharedCosts").amount) : null,
      netMarginPercent: percentOf(find("netProfit").amount),
    },
    // With one outlet picked: how the restaurant-wide costs were shared out.
    shared: forOutlet
      ? {
          basis: "sales",
          // Its share of the restaurant's net revenue over the range.
          percent: shares.percent,
          // Its share of the restaurant-wide costs it actually carries.
          carriedPercent: shares.carriedPercent,
          // The share applied each month, and how a month with no sales was
          // shared ("sales", "sameMonth", "nearest" or "equal").
          byMonth: shares.byMonth,
          monthBasis: months.map((month) => ({ key: month.key, ...shares.basis.get(month.key) })),
          wholeRevenue: shares.wholeRevenue,
          pools: {
            expenses: gst.rupees(pools.expenses),
            payroll: payroll ? gst.rupees(pools.payroll) : null,
            food: gst.rupees(pools.food),
          },
          amount: sharedCosts ? find("sharedCosts").amount : 0,
          // Sales taken under no outlet, the stock they used (on the stock
          // basis) and the part of the shared costs that went with them:
          // exactly the gap between the outlets' P&Ls and the restaurant's.
          unassigned: {
            revenue: gst.rupees(shares.untaggedRevenue),
            percent: shares.untaggedPercent,
            stock: gst.rupees(unassignedStock),
            costs: gst.rupees(unassignedCosts),
          },
        }
      : null,
    notes,
    warnings,
  };
};

module.exports = {
  foodCostParts,
  profitAndLoss,
};
