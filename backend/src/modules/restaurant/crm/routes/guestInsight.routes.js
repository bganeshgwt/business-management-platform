// Guest segments: regulars, lapsed, birthdays, big spenders.
//
// Read-only views over the guest book, the orders linked to it and the bills
// on those orders. Anyone who may see customers may see these; taking a list
// out of the building (CSV, copied mobiles) needs customers.export as well.
const express = require("express");
const guestInsightController = require("../controllers/guestInsight.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");

const router = express.Router();

router.use(authenticate);
router.use(requireFeature("guests"));

router.get("/", authorize("customers.view"), guestInsightController.summary);
router.get("/guests", authorize("customers.view"), guestInsightController.guest);
router.get("/segments/:key", authorize("customers.view"), guestInsightController.segment);
router.post(
  "/segments/:key/export",
  authorize("customers.view", "customers.export"),
  guestInsightController.exportSegment
);

module.exports = router;
