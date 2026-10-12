const express = require("express");
const reportController = require("../controllers/report.controller");
const recipeController = require("../../menu/controllers/recipe.controller");
const dashboardLiveController = require("../controllers/dashboardLive.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const reportOutlet = require("../../../../middlewares/reportOutlet");

const router = express.Router();

router.use(authenticate);

// The outlet switcher in the top bar narrows every report and the dashboard
// to one outlet (X-Outlet-Id, checked against this restaurant). Staff pinned
// to an outlet only ever see their own. Unlike the screens that record
// things, a report may read a closed outlet: its history stays in the books.
router.use(reportOutlet);

// Which day "today" is for the reports: the business day being traded (not
// the calendar date once service runs past midnight), on the restaurant's
// own clock. Anyone who may open a report may ask — the business-day screen
// itself needs a permission a store clerk reading stock reports has not got.
router.get("/trading-day", authorize("reports.view"), reportController.tradingDay);

// The dashboard is the one screen every signed-in person may open. What it
// answers depends on who asks: takings, the month, the drawer and money owed
// only reach someone holding sales.view (checked in the controller).
authorize.noteEnforced("sales.view");
router.get("/dashboard", reportController.dashboard);

// Every live block of the dashboard in one answer (the floor, kitchen,
// bookings, requests, deliveries, time clock, stock, guests and the bell).
// Each block runs its own route's permission and outlet rules; a block the
// person may not read is left out, never refused as a whole.
router.get("/dashboard/live", dashboardLiveController.live);

// The kitchen block on the dashboard: tickets at each stage, late now, the
// oldest wait and today's average ticket time — counts, not the tickets. The
// same right as the kitchen display itself.
router.get("/live/kitchen", requireFeature("kitchen_display"), authorize("kds.view"), reportController.kitchenLive);

// Sales figures need both: reports.view opens the reports, sales.view is the
// right to see takings at all. An owner can take takings away from a role
// without closing its stock reports.
router.get("/sales", authorize("reports.view"), authorize("sales.view"), reportController.sales);
router.get("/items", authorize("reports.view"), authorize("sales.view"), reportController.items);
// What each dish earns after its ingredients: takings and costs together, so
// it needs the right to see stock costs as well (inventory.view).
router.get(
  "/profitability",
  authorize("reports.view"),
  authorize("sales.view"),
  authorize("inventory.view"),
  requireFeature("stock_recipes"),
  reportController.profitability
);
router.get("/tax", authorize("reports.view"), authorize("sales.view"), reportController.tax);
router.get("/gst", authorize("reports.view"), authorize("sales.view"), reportController.gstPack);
router.get("/discounts", authorize("reports.view"), authorize("sales.view"), reportController.discounts);
router.get("/staff", authorize("reports.view"), authorize("sales.view"), reportController.staff);
router.get("/waiters", authorize("reports.view"), authorize("sales.view"), reportController.waiters);
router.get("/outlets", authorize("reports.view"), authorize("sales.view"), reportController.outlets);
router.get("/cancellations", authorize("reports.view"), authorize("sales.view"), reportController.cancellations);
router.get("/day-end", authorize("reports.view"), authorize("sales.view"), reportController.dayEnd);

// The books: profit & loss and the accountant's day book show what was spent
// as well as what was taken — rent, supplier bills, what the kitchen cost.
// Takings alone (a cashier's sales.view) are not enough; they are for whoever
// may also see expenses.
router.get(
  "/profit-loss",
  authorize("reports.view"),
  authorize("sales.view"),
  authorize("expenses.view"),
  reportController.profitLoss
);
router.get(
  "/day-book",
  authorize("reports.view"),
  authorize("sales.view"),
  authorize("expenses.view"),
  reportController.dayBook
);

// Writing the buyer's GSTIN on a bill is a change to an invoice: the person
// who bills, or a manager preparing the return.
router.put(
  "/gst/bills/:id/recipient",
  authorize("billing.manage"),
  authorize("reports.view"),
  authorize("sales.view"),
  reportController.setBillRecipient
);
router.delete(
  "/gst/bills/:id/recipient",
  authorize("billing.manage"),
  authorize("reports.view"),
  authorize("sales.view"),
  reportController.clearBillRecipient
);

// Stock in money terms: a stock report, not takings.
router.get("/consumption", requireFeature("stock_recipes"), authorize("reports.view"), reportController.consumption);

// Where the money went: for whoever may see expenses.
router.get("/expenses", authorize("reports.view"), authorize("expenses.view"), reportController.expenses);

// Voids, refunds, large discounts, reprints, dishes taken off after the
// kitchen had them, and cash short at close — by the person who did them. For
// the people who read the activity log, never for the cashier being checked.
router.get("/theft", authorize("audit.view"), authorize("reports.view"), reportController.theft);

// Who changed what: kept with reports because it is read-only history. Read
// with the activity log's own permission, as the Activity log screen is.
router.get("/audit-log", authorize("audit.view"), recipeController.auditLog);

module.exports = router;
