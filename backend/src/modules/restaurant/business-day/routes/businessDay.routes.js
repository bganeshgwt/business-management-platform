const express = require("express");
const businessDayController = require("../controllers/businessDay.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");
const businessDayRepository = require("../repositories/businessDay.repository");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");

const router = express.Router();

router.use(authenticate);
router.use(resolveOutlet);

router.get("/", authorize("business_day.view"), businessDayController.getStatus);
// Past days between two dates, a page at a time (the screen's "Past days").
router.get("/days", authorize("business_day.view"), businessDayController.listDays);
router.post("/open", authorize("business_day.manage"), businessDayController.open);

// The rules for opening and counting: the morning cut-off for last night's
// day, the over/short that needs a reason, and blind counting.
router.get("/rules", authorize("business_day.view"), businessDayController.getRules);
router.put("/rules", authorize("restaurant.settings.manage"), businessDayController.updateRules);

// What the close dialog shows, and the close checked before a manager's PIN.
router.get("/close-preview", authorize("business_day.manage"), businessDayController.closePreview);
router.post("/close/check", authorize("business_day.manage"), businessDayController.checkClose);

// Closing the day locks the takings, so it is its own permission; a cashier
// who opens and runs the day closes it with a manager's PIN.
//
// [access step] That PIN is tied to what the prompt showed the manager: this
// day, the cash counted in the drawer, and whether unpaid bills are carried
// over as dues. A different count or choice needs a new approval. Read the
// same way the handler reads them; a cash count is required before approval.
const closeScope = async (req) => {
  const body = req.body || {};
  const open = await businessDayRepository.findOpen(req.user.restaurantId, req.outletId);
  const counted = body.closingCash;

  return {
    businessDayId: open ? open.id : null,
    closingCash: counted,
    carryUnpaid: body.carryUnpaid === true,
  };
};

router.post(
  "/close",
  authorize("business_day.manage"),
  businessDayController.validateClose,
  // Everything else that would refuse the close is checked before
  // an approval is spent on it.
  businessDayController.precheckClose,
  authorizeOrApprove("business_day.close", { scope: closeScope }),
  businessDayController.close
);

// A day closed by mistake is opened again by someone who may close it, with
// a reason (no PIN: the prompt would read "close the business day").
router.post("/:id/reopen", authorize("business_day.close"), businessDayController.reopen);

// Cash drawers per shift, the X report, and cash in or out of a drawer.
router.use(require("./cashDrawer.routes"));

module.exports = router;
