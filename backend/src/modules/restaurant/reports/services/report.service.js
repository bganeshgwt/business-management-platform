// Restaurant reports. Each family of reports lives in its own file under
// report/ (sales, items, GST, staff, stock, day end, dashboard, P&L,
// expenses, day book, theft; scope.js and common.js are the shared helpers).
// This file only gathers them, so callers keep one require.

const { tradingDay, zoneOf } = require("./report/scope");
const { cancellationReport, discountReport, outletComparison, salesSummary } = require("./report/sales");
const { dishProfitability, itemSales } = require("./report/items");
const { clearBillRecipient, gstPack, setBillRecipient, taxReport } = require("./report/gst");
const { staffReport, waiterReport } = require("./report/staff");
const { consumptionReport } = require("./report/stock");
const { dayEnd } = require("./report/dayEnd");
const { dashboard, kitchenLive } = require("./report/dashboard");
const { monthsIn } = require("./report/periods");
const { profitAndLoss } = require("./report/profitLoss");
const { expenseReport } = require("./report/expenses");
const { dayBook } = require("./report/dayBook");
const { DEFAULT_DISCOUNT_AMOUNT, DEFAULT_DISCOUNT_PERCENT, theftReport } = require("./report/theft");

module.exports = {
  kitchenLive,
  zoneOf,
  monthsIn,
  tradingDay,
  salesSummary,
  itemSales,
  outletComparison,
  taxReport,
  gstPack,
  setBillRecipient,
  clearBillRecipient,
  discountReport,
  staffReport,
  waiterReport,
  cancellationReport,
  consumptionReport,
  dishProfitability,
  dayEnd,
  dashboard,
  profitAndLoss,
  expenseReport,
  dayBook,
  theftReport,
  DEFAULT_DISCOUNT_PERCENT,
  DEFAULT_DISCOUNT_AMOUNT,
};
