const express = require("express");
const discountController = require("../controllers/discount.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const reportOutlet = require("../../../../middlewares/reportOutlet");

const router = express.Router();

router.use(authenticate);

// The loyalty programme's rules and figures, before "/:id" so "loyalty" is
// never read as an offer id.
router.use("/loyalty", require("../../crm/routes/loyalty.routes"));

router.get("/", authorize("discounts.view"), requireFeature("coupons"), discountController.list);
// What was given away at the till: money figures, so sales.view as well.
// Read for the outlet in the top bar (or ?outletId=); staff tied to one
// outlet see that outlet's bills only, like the bills list.
router.get("/given", authorize("discounts.view"), authorize("sales.view"), reportOutlet, discountController.given);
router.post("/", authorize("discounts.manage"), requireFeature("coupons"), discountController.create);
router.put("/:id", authorize("discounts.manage"), requireFeature("coupons"), discountController.update);
router.delete("/:id", authorize("discounts.manage"), requireFeature("coupons"), discountController.remove);

module.exports = router;
