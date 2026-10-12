const express = require("express");
const purchaseReturnController = require("../controllers/purchaseReturn.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");

const router = express.Router();

router.use(authenticate);
router.use(requireFeature("stock_recipes"));
// A return not tied to a bill leaves from the store of the outlet in use.
router.use(resolveOutlet);

// Supplier money first, so "payments", "outstanding" and "statement" are not
// read as ids. Paying is its own right, apart from raising orders and
// receiving goods.
// What the restaurant owes its suppliers, what it paid and the statements are
// money pages: for someone who pays suppliers or reads the reports (owner,
// manager, accountant), not for a store keeper who orders and receives.
const seesSupplierMoney = authorize.any("purchasing.pay", "reports.view");

router.get("/payments", authorize("purchasing.view"), seesSupplierMoney, purchaseReturnController.listPayments);
router.post("/payments", authorize("purchasing.pay"), purchaseReturnController.createPayment);
router.put("/payments/:paymentId", authorize("purchasing.pay"), purchaseReturnController.updatePayment);
router.post("/payments/:paymentId/void", authorize("purchasing.pay"), purchaseReturnController.voidPayment);
router.get("/outstanding", authorize("purchasing.view"), seesSupplierMoney, purchaseReturnController.outstanding);
router.get("/statement", authorize("purchasing.view"), seesSupplierMoney, purchaseReturnController.statement);
router.get("/credit-limit", authorize("purchasing.returns"), purchaseReturnController.creditLimit);

router.get("/", authorize("purchasing.view"), purchaseReturnController.list);
router.get("/:id", authorize("purchasing.view"), purchaseReturnController.getById);
router.post("/", authorize("purchasing.returns"), purchaseReturnController.create);
router.put("/:id", authorize("purchasing.returns"), purchaseReturnController.update);
router.post("/:id/void", authorize("purchasing.returns"), purchaseReturnController.voidReturn);

module.exports = router;
