const express = require("express");
const cashDrawerController = require("../controllers/cashDrawer.controller");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");

// Cash drawers per shift and cash in or out of a drawer, mounted by
// businessDay.routes.js under /api/business-day (after its authenticate and
// resolveOutlet): /drawers, /x-report and /movements.
const router = express.Router();

// The day's cash in and out is core and comes with this list; with Cash
// drawers switched off the list carries no drawers (see the controller).
router.get("/drawers", authorize("business_day.view"), cashDrawerController.list);
// Opening and ending your own shift is part of running the till; opening or
// ending someone else's is a manager's (checked in the service).
router.post("/drawers", requireFeature("cash_drawers"), authorize("business_day.manage"), cashDrawerController.start);
router.post("/drawers/:id/close", requireFeature("cash_drawers"), authorize("business_day.manage"), cashDrawerController.close);

// Takings by method are sales figures.
router.get("/x-report", authorize("business_day.view"), authorize("sales.view"), cashDrawerController.xReport);

// Cash in or out of a drawer is how a drawer is made to look right, so it is
// a manager's permission; a cashier records one with a manager's PIN tied to
// the day and the amount. Everything that would refuse it is checked first,
// so no approval is spent on an entry the drawer would refuse.
router.post(
  "/movements",
  authorize("business_day.manage"),
  cashDrawerController.validateMovement,
  authorizeOrApprove("cash.movements", { scope: cashDrawerController.movementScope }),
  cashDrawerController.record
);
router.post(
  "/movements/:id/cancel",
  authorize("business_day.manage"),
  cashDrawerController.validateCancel,
  authorizeOrApprove("cash.movements", { scope: cashDrawerController.cancelScope }),
  cashDrawerController.cancel
);

module.exports = router;
