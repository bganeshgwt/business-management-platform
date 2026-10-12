const express = require("express");
const billController = require("../controllers/bill.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");
const customerAccountRoutes = require("./customerAccount.routes");
const customerAdvanceRoutes = require("./customerAdvance.routes");

const router = express.Router();

// Checked inside the bill controller (the change decides which applies); said
// here so the role editor shows them as permissions the app enforces.
authorize.noteEnforced("bills.discount", "bills.complimentary", "bills.reprint");

router.use(authenticate);
// Settles which outlet this request works in, from the user or the switcher.
// Staff pinned to one outlet see and act on that outlet's bills only.
router.use(resolveOutlet);

// Named paths come before "/:id" so they are not read as a bill id.
//
// The day's takings are for people who hand over or check the drawer
// (sales.view), not the floor.
router.get("/day-summary", authorize("sales.view"), billController.daySummary);
router.get("/till-options", authorize("orders.view"), billController.tillOptions);
router.get("/credit-notes", authorize("orders.view"), authorize("sales.view"), billController.creditNotes);
// Payments whose method was corrected (theft control reads them too): who,
// who approved, from which method to which.
router.get("/payment-corrections", authorize("sales.view"), authorize("audit.view"), billController.corrections);

router.get("/billable/:orderId", authorize("billing.manage"), billController.billableItems);

// Guest and company accounts (dues): limits, the dues list, statements,
// money collected against an account.
router.use("/accounts", customerAccountRoutes);

// Advances and deposits taken ahead and used on the final bill.
router.use("/advances", customerAdvanceRoutes);

router.get("/", authorize("orders.view"), billController.list);
router.get("/:id", authorize("orders.view"), billController.getById);
router.post("/", authorize("billing.manage"), billController.create);

// A coupon, points, a till discount, service charge declined or a no-charge
// bill, on a bill not yet settled. What each needs (bills.discount with the
// role's cap, bills.complimentary, a manager for lowering a printed bill) is
// decided in the controller from the change itself.
router.patch("/:id/adjust", authorize("billing.manage"), billController.billInScope, billController.adjust);
// The same change, checked and not made: what it would need (a manager's
// approval, with the facts it is tied to), so the till can ask for the PIN
// before sending it.
router.post("/:id/adjust/check", authorize("billing.manage"), billController.billInScope, billController.checkAdjust);

router.post("/:id/payments", authorize("payments.manage"), billController.billInScope, billController.addPayment);

// Correcting how a payment was taken (keyed as cash, paid by UPI) while its
// day is open: bills.payment_correct, or a manager's PIN tied to this bill,
// this payment, its amount and the two methods. The payment and its day are
// checked first, so no approval is spent on a correction that would be
// refused. Nothing but the method (and its type and reference) changes.
router.patch(
  "/:id/payments/:paymentId",
  authorize("payments.manage"),
  billController.billInScope,
  billController.checkCorrection,
  authorizeOrApprove("bills.payment_correct", { scope: billController.correctionScope }),
  billController.correctPayment
);

// Putting a bill on a guest's or company's account (dues) instead of taking
// the money: customers.credit, or a manager's PIN tied to this bill, this
// guest and this amount. The account, its hold and its credit limit are
// checked first, so no approval is spent on a bill the account would refuse.
// { customerId: null } takes it off the account again (same permission).
const accountScope = (req) => ({
  billId: req.params.id,
  customerId: req.body?.customerId || undefined,
  amount: req.accountCheck ? req.accountCheck.due : undefined,
});

router.patch(
  "/:id/account",
  authorize("billing.manage"),
  billController.billInScope,
  billController.checkAccount,
  authorizeOrApprove("customers.credit", { scope: accountScope }),
  billController.putOnAccount
);

// Refunds and voids are their own permissions. Someone without them (a
// cashier) can still do one when a manager at the till approves it with their
// PIN; the activity log then names both.
//
// Every void needs it, printed or not. The server cannot know whether the
// guest has seen the bill (on paper, on the screen, on the customer display)
// or has already handed over cash, so "not printed yet" is no proof that
// nothing can go missing: print, take the cash, void and cancel the order is
// the classic till theft.
//
// A manager's approval is tied to what the prompt showed them: this bill, and
// for a refund this much at most (authorizeOrApprove's scope option). The bill
// is found first (another outlet's bill is not found at all), and the refund
// or void is checked against it before anyone is asked for a PIN, so an
// approval is never spent on something the bill would refuse.
const voidScope = (req) => ({ billId: req.params.id });
const refundScope = (req) => ({ billId: req.params.id, amount: req.body?.amount });

router.post(
  "/:id/refunds",
  authorize("payments.manage"),
  billController.billInScope,
  billController.checkRefund,
  authorizeOrApprove("bills.refund", { scope: refundScope }),
  billController.addRefund
);
router.patch(
  "/:id/void",
  authorize("billing.manage"),
  billController.billInScope,
  billController.checkVoid,
  authorizeOrApprove("bills.void", { scope: voidScope }),
  billController.voidBill
);

// Every print is counted; a reprint needs bills.reprint or a manager.
router.post("/:id/print", authorize("orders.view"), billController.billInScope, billController.registerPrint);

module.exports = router;
