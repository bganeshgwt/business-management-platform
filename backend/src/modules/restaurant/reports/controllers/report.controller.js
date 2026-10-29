const reportService = require("../services/report.service");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { isCalendarDate } = require("../../../../utils/calendarDate");
const { logAction } = require("../../../../utils/audit");
const dashboardCache = require("../../../../utils/dashboardCache");

// Two years is the longest range any report reads at once: enough to set this
// year beside last, short of reading the whole database on a stray click.
const MAX_DAYS = 731;

// A date from the query string: missing is fine (the report then reads the
// trading day), anything else must be a real calendar date. "31 Feb" passed
// the old shape check and then failed inside PostgreSQL as "Internal server
// error"; it is now refused with a sentence.
const readDate = (value, label) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (!isCalendarDate(value)) {
    throw new AppError(400, `${label} must be a real date like 2026-09-19`);
  }

  return value;
};

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// Reports default to the day the restaurant is trading on, so a screen with no
// dates chosen still works (the service fills them in).
const readRange = (query = {}) => {
  const from = readDate(query.from, "The start date");
  const to = readDate(query.to, "The end date");

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  if (from && to && daysBetween(from, to) > MAX_DAYS) {
    throw new AppError(400, "Pick a range of at most two years at a time");
  }

  return { from, to };
};

const can = (req, permission) => (req.user.permissions || []).includes(permission);

// Every range report answers the same way: the dates and outlet it covers,
// then its own figures.
const rangeReport = (run) => async (req, res) => {
  const data = await run(req.user.restaurantId, readRange(req.query), req.outletId || null, req);

  res.json({ success: true, data });
};

const sales = rangeReport((restaurantId, range, outletId) =>
  reportService.salesSummary(restaurantId, range, outletId)
);

const items = rangeReport((restaurantId, range, outletId) =>
  reportService.itemSales(restaurantId, range, outletId)
);

const tax = rangeReport((restaurantId, range, outletId) =>
  reportService.taxReport(restaurantId, range, outletId)
);

// One GST registration's pack: the one asked for (?gstin=, "none" for bills
// issued with no GSTIN), else the outlet's or the restaurant's own.
const gstPack = rangeReport((restaurantId, range, outletId, req) =>
  reportService.gstPack(restaurantId, range, outletId, {
    gstin: v.optionalString(req.query.gstin, "GST registration", 20),
  })
);

const discounts = rangeReport((restaurantId, range, outletId) =>
  reportService.discountReport(restaurantId, range, outletId)
);

const staff = rangeReport((restaurantId, range, outletId) =>
  reportService.staffReport(restaurantId, range, outletId)
);

const waiters = rangeReport((restaurantId, range, outletId) =>
  reportService.waiterReport(restaurantId, range, outletId)
);

// ?voidPage=&cancelPage=&pageSize= page the two lists on the server ("26–50
// of 2,319"); without them each list is its most recent 1,000 as before.
const pageOf = (value, name) =>
  value === undefined || value === "" ? null : Math.floor(v.requiredNumber(value, name, { min: 1, max: 100000 }));

const cancellations = rangeReport((restaurantId, range, outletId, req) =>
  reportService.cancellationReport(restaurantId, range, outletId, {
    voidPage: pageOf(req.query.voidPage, "Voided bills page"),
    cancelPage: pageOf(req.query.cancelPage, "Cancelled orders page"),
    pageSize: req.query.pageSize === undefined || req.query.pageSize === "" ? null : Math.floor(v.requiredNumber(req.query.pageSize, "Rows per page", { min: 1, max: 200 })),
  })
);

const consumption = rangeReport((restaurantId, range, outletId) =>
  reportService.consumptionReport(restaurantId, range, outletId)
);

const outlets = rangeReport((restaurantId, range, outletId) =>
  reportService.outletComparison(restaurantId, range, outletId)
);

const BASES = ["consumption", "purchases"];

const profitLoss = rangeReport((restaurantId, range, outletId, req) =>
  reportService.profitAndLoss(restaurantId, range, {
    outletId,
    basis: v.optionalEnum(req.query.basis, "Food cost basis", BASES, "consumption"),
    // Salaries are someone's pay: the P&L shows them only to a person who may
    // see salaries, and otherwise stops at profit before salaries.
    canSeePayroll: can(req, "staff.salaries"),
  })
);

const expenses = rangeReport((restaurantId, range, outletId) =>
  reportService.expenseReport(restaurantId, range, outletId)
);

// Each kitchen station's tickets, dishes and times over the range.
const kitchenStations = rangeReport((restaurantId, range, outletId) =>
  reportService.kitchenStationReport(restaurantId, range, outletId)
);

// Supplier bills, returns and payments are the purchasing module's money:
// they go into the day book only for someone who may see purchasing, the way
// salaries go in only for someone who may see salaries. Left out, the screen
// says so, so a partial book is never taken for the whole one.
const dayBook = rangeReport((restaurantId, range, outletId, req) =>
  reportService.dayBook(restaurantId, range, {
    outletId,
    canSeePayroll: can(req, "staff.salaries"),
    canSeePurchases: can(req, "purchasing.view"),
  })
);

// "Today" for the Reports screen: the business day being traded and the
// restaurant's own calendar date — the outlet's own day with one chosen in
// the top bar, or for staff tied to one.
const tradingDay = async (req, res) => {
  res.json({ success: true, data: await reportService.tradingDay(req.user.restaurantId, req.outletId || null) });
};

const theft = rangeReport((restaurantId, range, outletId, req) =>
  reportService.theftReport(restaurantId, range, {
    outletId,
    discountPercent: v.optionalNumber(req.query.discountPercent, "Large discount %", { min: 1, max: 100 }),
    discountAmount: v.optionalNumber(req.query.discountAmount, "Large discount amount", { min: 1 }),
  })
);

const dayEnd = async (req, res) => {
  // An id the database can hold: 1e20 passed a number check and then failed
  // inside PostgreSQL as "Internal server error".
  const businessDayId =
    req.query.businessDayId === undefined || req.query.businessDayId === ""
      ? null
      : v.requiredId(req.query.businessDayId, "Business day");
  // A manager reading yesterday's sheet this morning is the ordinary case, so
  // the day can be asked for by its date and not only by its internal id.
  const businessDate = readDate(req.query.businessDate, "The business date");

  res.json({
    success: true,
    data: await reportService.dayEnd(req.user.restaurantId, {
      businessDayId,
      businessDate,
      outletId: req.outletId || null,
      // The shift log book's entries print with the day only for someone who
      // may read the log book.
      canSeeLogbook: can(req, "logbook.view"),
    }),
  });
};

// Dish profitability: sales, food cost and contribution per dish and size.
const profitability = rangeReport((restaurantId, range, outletId) =>
  reportService.dishProfitability(restaurantId, range, outletId)
);

// Open to everyone signed in. What it answers depends on who asks: without
// sales.view the takings, the month, the drawer and money owed are simply not
// in the answer.
//
// Kept for 15 seconds (utils/dashboardCache.js) and thrown away at once by any
// write for the restaurant. The key is everything the answer depends on: the
// outlet, whether takings may be seen and whether the person is pinned there.
const dashboard = async (req, res) => {
  const options = {
    outletId: req.outletId || null,
    canSeeSales: can(req, "sales.view"),
    outletPinned: Boolean(req.outletPinned),
  };
  const key = `dashboard|${options.outletId || ""}|${options.canSeeSales}|${options.outletPinned}`;

  res.json({
    success: true,
    data: await dashboardCache.remember(req.user.restaurantId, key, () =>
      reportService.dashboard(req.user.restaurantId, options)
    ),
  });
};

// The kitchen's live counts for the dashboard (kds.view, checked in the route).
// The outlet is the one the dashboard is showing.
const kitchenLive = async (req, res) => {
  res.json({
    success: true,
    data: await reportService.kitchenLive(req.user.restaurantId, { outletId: req.outletId || null }),
  });
};

// Staff pinned to one outlet write a buyer only on that outlet's bills, the
// same rule as every other action on a bill (bill.controller). An owner or
// manager with an outlet picked in the top bar is not pinned and may still
// put a buyer on any of the restaurant's bills from the GST pack.
const billOutletOf = (req) => (req.outletPinned ? req.outletId : null);

// A buyer's GSTIN written on one bill, which makes it a B2B invoice: the
// registered name, and the address the tax invoice prints.
const setBillRecipient = async (req, res) => {
  const billId = v.requiredId(req.params.id, "Bill id");
  const legalName = v.requiredString(req.body?.legalName, "The buyer's registered name", 150);
  const address = v.optionalString(req.body?.address, "The buyer's address", 300);
  const bill = await reportService.setBillRecipient(
    req.user.restaurantId,
    billId,
    { gstin: req.body?.gstin, legalName, address },
    req.user.id,
    billOutletOf(req)
  );

  logAction(req, "gst_recipient_set", "bill", {
    id: bill.id,
    label: bill.bill_number,
    details: { gstin: bill.recipient_gstin, legalName: bill.recipient_name, address: bill.recipient_address || null },
  });

  res.json({
    success: true,
    message: `${bill.bill_number} is now a B2B invoice to ${bill.recipient_name}`,
    data: {
      billId: bill.id,
      billNumber: bill.bill_number,
      recipientGstin: bill.recipient_gstin,
      recipientName: bill.recipient_name,
      recipientSource: bill.recipient_source,
    },
  });
};

const clearBillRecipient = async (req, res) => {
  const billId = v.requiredId(req.params.id, "Bill id");
  const bill = await reportService.clearBillRecipient(req.user.restaurantId, billId, billOutletOf(req));

  logAction(req, "gst_recipient_cleared", "bill", { id: bill.id, label: bill.bill_number });

  // The buyer is only ever the one written on the bill, so with it gone the
  // invoice is an ordinary sale again (a guest's GSTIN added later never
  // turns it back into a B2B invoice).
  res.json({
    success: true,
    message: `${bill.bill_number} is back to an ordinary (B2C) sale`,
    data: {
      billId: bill.id,
      billNumber: bill.bill_number,
      recipientGstin: bill.recipient_gstin,
      recipientName: bill.recipient_name,
      recipientSource: bill.recipient_source,
    },
  });
};

module.exports = {
  sales,
  items,
  tax,
  gstPack,
  setBillRecipient,
  clearBillRecipient,
  discounts,
  staff,
  waiters,
  cancellations,
  consumption,
  outlets,
  profitLoss,
  expenses,
  dayBook,
  theft,
  dayEnd,
  dashboard,
  profitability,
  kitchenLive,
  tradingDay,
  kitchenStations,
};
