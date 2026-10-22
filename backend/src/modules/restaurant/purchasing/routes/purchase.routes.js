const express = require("express");
const purchaseController = require("../controllers/purchase.controller");
const purchaseRepository = require("../repositories/purchase.repository");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const AppError = require("../../../../utils/AppError");

const router = express.Router();

// Voiding a bill nobody has paid yet is the receiver's own correction. A bill
// that was paid on delivery (or has a payment against it) is different: the
// void also voids that payment — till cash handed to the vendor disappears
// from the books — so it needs the right to pay suppliers, or a manager's
// PIN. Only the database's word counts: the bill is looked up in the signed-in
// person's restaurant, and a bill that is not found gets no waiver.
const unpaidBill = async (req) => {
  const id = Number(req.params.receiptId);

  if (!Number.isInteger(id) || id < 1 || !req.user?.restaurantId) {
    return null;
  }

  const found = await purchaseRepository.findReceiptById(req.user.restaurantId, id);

  if (!found) {
    // Let the controller answer 404, as for any bill that does not exist.
    return "not_found";
  }

  return (await purchaseRepository.hasPostedPayment(req.user.restaurantId, id)) ? null : "unpaid_bill";
};

// Someone tied to one outlet may only void a bill whose goods went into their
// own store: voiding takes that stock back out. Checked before the manager
// PIN is asked for, so an approval is never spent on a void that is refused.
const pinnedBillStore = async (req, res, next) => {
  if (req.outletPinned) {
    const id = Number(req.params.receiptId);
    const found =
      Number.isInteger(id) && id > 0 ? await purchaseRepository.findReceiptById(req.user.restaurantId, id) : null;

    if (found) {
      await require("../../inventory/services/inventory.service").requirePinnedStoreId(
        req.user.restaurantId,
        req.outletId,
        found.outlet_id
      );
    }
  }

  next();
};

router.use(authenticate);
router.use(requireFeature("stock_recipes"));
// Which outlet's store the goods go into, from the user or the switcher.
router.use(resolveOutlet);

// Purchase bills: every delivery, with or without an order. Listed before
// "/:id" so "receipts" and "register" are not read as an order id.
router.get("/receipts", authorize("purchasing.view"), purchaseController.listReceipts);
router.post("/receipts", authorize("purchasing.receive"), purchaseController.createReceipt);
router.get("/receipts/:receiptId", authorize("purchasing.view"), purchaseController.getReceipt);
// The supplier's paper bill (SW-B-09): photos or PDFs, at most five, served
// only through here. A voided bill keeps its files.
const billFiles = require("../../expenses/controllers/attachment.controller").purchaseBill;
const { uploadOne } = require("../../expenses/services/attachment.service");
router.get("/receipts/:receiptId/attachments", authorize("purchasing.view"), billFiles.list);
router.post("/receipts/:receiptId/attachments", authorize("purchasing.receive"), uploadOne, billFiles.add);
router.get("/receipts/:receiptId/attachments/:attachmentId", authorize("purchasing.view"), billFiles.download);
router.delete("/receipts/:receiptId/attachments/:attachmentId", authorize("purchasing.receive"), billFiles.remove);
router.post(
  "/receipts/:receiptId/void",
  authorize("purchasing.receive"),
  pinnedBillStore,
  authorizeOrApprove("purchasing.pay", { waiveWhen: unpaidBill }),
  purchaseController.voidReceipt
);

// The accountant's purchase register (bills with GSTIN, taxable value, GST).
router.get("/register", authorize("purchasing.view"), purchaseController.register);

// Raising and changing orders is buying; receiving the goods is a separate
// right, so the person who orders is not the only one who says it arrived.
router.get("/", authorize("purchasing.view"), purchaseController.list);
router.get("/:id", authorize("purchasing.view"), purchaseController.getById);
router.post("/", authorize("purchasing.manage"), purchaseController.create);
router.put("/:id", authorize("purchasing.manage"), purchaseController.update);
router.patch("/:id/status", authorize("purchasing.manage"), purchaseController.changeStatus);

// An order over the approval limit (Stock → Stock & purchasing settings) waits for
// an approver: someone with "Approve purchase orders over the limit", or the
// buyer with a manager's PIN, tied to this order and no more than its total.
// Every other check comes first, so a PIN is never spent on a refused step.
const approvalOf = authorizeOrApprove("purchasing.approve", {
  scope: (req) => ({
    purchaseOrderId: req.waitingOrder ? req.waitingOrder.id : undefined,
    amount: req.waitingOrder ? req.waitingOrder.totalAmount : undefined,
  }),
});
const raisesOrApproves = (req, res, next) => {
  const granted = req.user?.permissions || [];

  if (!granted.includes("purchasing.manage") && !granted.includes("purchasing.approve")) {
    throw new AppError(403, "You do not have permission to perform this action");
  }

  next();
};
router.post("/:id/approve", raisesOrApproves, purchaseController.checkApprovalStep, approvalOf, purchaseController.approve);
router.post("/:id/reject", raisesOrApproves, purchaseController.checkApprovalStep, approvalOf, purchaseController.reject);
router.post("/:id/receive", authorize("purchasing.receive"), purchaseController.receive);
router.delete("/:id", authorize("purchasing.manage"), purchaseController.remove);

module.exports = router;
