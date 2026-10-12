const express = require("express");
const customerAccountController = require("../controllers/customerAccount.controller");
const authorize = require("../../../../middlewares/authorize");

// Guest and company accounts (dues), under /api/bills/accounts. The bills
// router has already signed the person in and settled their outlet
// (authenticate, resolveOutlet): staff pinned to an outlet see and collect
// that outlet's bills only.
const router = express.Router();

// What is owed is takings: for people who may see sales.
router.get("/dues", authorize("sales.view"), customerAccountController.dues);
router.get("/:customerId/statement", authorize("sales.view"), customerAccountController.statement);
router.get("/:customerId/open-bills", authorize("sales.view"), customerAccountController.openBills);

// Giving someone credit is the owner's or a manager's decision.
router.put("/:customerId", authorize("customers.credit"), customerAccountController.saveAccount);

// Money received against an account goes into today's business day, like
// any other payment.
router.post("/:customerId/collect", authorize("payments.manage"), customerAccountController.collect);

module.exports = router;
