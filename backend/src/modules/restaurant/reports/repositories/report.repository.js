// SQL for the restaurant reports. Each family of queries lives in its own
// file under report/; sql.js holds the shared fragments (the trading day,
// outlet scope, live bills, bill lines, stock movements, voided bills).
// This file only gathers them, so callers keep one require.

const { VOIDED_BILL_OF_REMOVAL, dayAt, roughWindow } = require("./report/sql");
const { cancellationReport, covers, discountReport, orderTypes, outletComparison, paymentModes, paymentTypes, salesByDay, salesByHour, salesSummary } = require("./report/sales");
const { addonSales, categorySales, dishProfitability, itemSales, menuPerformance } = require("./report/items");
const { billItemTaxRows, billParties, billTaxLines, billTaxRows, billsForBreakdown, clearBillRecipient, creditNoteTaxRows, findBill, gstBills, gstCreditNotes, hsnDescriptions, setBillRecipient } = require("./report/gst");
const { captainSections, staffReport, waiterReport } = require("./report/staff");
const { consumptionReport } = require("./report/stock");
const { DRAWER_EXPECTED, DRAWER_PARTS } = require("./report/drawers");
const { dayEndReport, dayLogbook, daysOfDate, nearestDays, ridersOwed } = require("./report/dayEnd");
const { dashboard, kitchenNow, openDays } = require("./report/dashboard");
const { employeeOutlets, expensesByCategory, purchasesByMonth, refundsByMonth, revenueByMonth, stockCostByMonth } = require("./report/profitLoss");
const { dayBook } = require("./report/dayBook");
const { paymentCorrections, theft } = require("./report/theft");

module.exports = {
  dayAt,
  roughWindow,
  VOIDED_BILL_OF_REMOVAL,
  openDays,
  DRAWER_PARTS,
  dayLogbook,
  paymentTypes,
  paymentCorrections,
  captainSections,
  addonSales,
  dishProfitability,
  ridersOwed,
  DRAWER_EXPECTED,
  daysOfDate,
  nearestDays,
  kitchenNow,
  salesSummary,
  salesByDay,
  salesByHour,
  covers,
  itemSales,
  menuPerformance,
  outletComparison,
  categorySales,
  paymentModes,
  orderTypes,
  gstBills,
  gstCreditNotes,
  creditNoteTaxRows,
  billTaxRows,
  billItemTaxRows,
  billTaxLines,
  billsForBreakdown,
  hsnDescriptions,
  billParties,
  findBill,
  setBillRecipient,
  clearBillRecipient,
  discountReport,
  staffReport,
  waiterReport,
  cancellationReport,
  consumptionReport,
  dayEndReport,
  dashboard,
  revenueByMonth,
  refundsByMonth,
  stockCostByMonth,
  purchasesByMonth,
  expensesByCategory,
  employeeOutlets,
  dayBook,
  theft,
};
