const express = require("express");
const customerAdvanceController = require("../controllers/customerAdvance.controller");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");

// Advances and deposits, under /api/bills/advances. The bills
// router has already signed the person in and settled their outlet
// (authenticate, resolveOutlet).
const router = express.Router();

router.use(requireFeature("advances"));

// Named paths before "/:id".
//
// What is held for guests is money: for people who may see sales.
router.get("/", authorize("sales.view"), customerAdvanceController.list);
router.get("/gst", authorize("sales.view"), customerAdvanceController.gst);
// The till offers a guest's advances when paying their bill.
router.get("/held/:customerId", authorize("payments.manage"), customerAdvanceController.heldFor);
// What was taken ahead on one pickup order.
router.get("/order/:orderId", authorize("payments.manage"), customerAdvanceController.forOrder);
router.get("/:id", authorize("payments.manage"), customerAdvanceController.getById);

// Taking money is the till's job.
router.post("/", authorize("payments.manage"), customerAdvanceController.create);

// Handing an advance back: advances.refund, or a manager's PIN tied to this
// advance and this much. Checked first, so no approval is spent on a refund
// the advance would refuse.
router.post(
  "/:id/refunds",
  authorize("payments.manage"),
  customerAdvanceController.checkRefund,
  authorizeOrApprove("advances.refund", { scope: customerAdvanceController.refundScope }),
  customerAdvanceController.refund
);

module.exports = router;
