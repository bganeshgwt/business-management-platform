const express = require("express");
const crmController = require("../controllers/crm.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");

const router = express.Router();

router.use(authenticate);
// The guest book, feedback and complaints: the Guests feature.
router.use(requireFeature("guests"));

// Customers
// The till's quick search: a plain list (the count is in X-Total-Count).
router.get("/customers", authorize("customers.view"), crmController.listCustomers);
router.post("/customers", authorize("customers.manage"), crmController.createCustomer);
// The guest book, a page at a time; the export needs customers.export too.
router.get("/guest-book", authorize("customers.view"), crmController.guestBook);
router.get(
  "/guest-book/export",
  authorize("customers.view"),
  authorize("customers.export"),
  crmController.exportGuestBook
);
// Bringing a guest list (and its points) over from a spreadsheet: adding and
// changing guests, and handling the whole list's numbers, so both rights.
const sheetImport = require("../../imports/controllers/sheetImport.controller");
router.get("/guest-book/import-guide", authorize("customers.manage"), authorize("customers.export"), sheetImport.guestGuide);
router.post("/guest-book/import", authorize("customers.manage"), authorize("customers.export"), sheetImport.importGuests);
router.get("/duplicates", authorize("customers.view"), crmController.listDuplicates);
router.get("/customers/:id/history", authorize("customers.view"), crmController.customerHistory);
// Opening one guest's full number on purpose (staff who see them masked):
// logged, and limited per day. A POST because it writes to the activity log.
router.post("/customers/:id/contact", authorize("customers.manage"), crmController.revealContact);
// Points by hand are loyalty.adjust. A cashier can still give goodwill points
// when a manager standing there approves this guest and this many points
// with their PIN; the activity log then names both. The approval is tied to
// the direction too: "add 20" never pays for "take 20 away".
const pointsScope = (req) => {
  const points = Math.round(Number(req.body?.points));

  return {
    customerId: req.params.id,
    points: points > 0 ? points : undefined,
    pointsOff: points < 0 ? -points : undefined,
  };
};
router.post(
  "/customers/:id/points",
  authorize("customers.manage"),
  authorizeOrApprove("loyalty.adjust", { scope: pointsScope }),
  crmController.adjustPoints
);
// Folding a duplicate into the record that stays, and "not the same person".
router.post("/customers/:id/merge", authorize("customers.merge"), crmController.mergeCustomer);
router.post("/customers/:id/not-duplicate", authorize("customers.merge"), crmController.dismissDuplicate);
// A guest's request to have their data deleted: the bills stay, who they were goes.
router.post("/customers/:id/erase", authorize("customers.erase"), crmController.eraseCustomer);
router.put("/customers/:id", authorize("customers.manage"), crmController.updateCustomer);
// Only a record with no history (added by mistake) can be deleted outright.
router.delete("/customers/:id", authorize("customers.manage"), crmController.removeCustomer);

// Guest reports: points owed and how they moved, and sales by guest.
router.get("/reports/loyalty", authorize("customers.view"), authorize("reports.view"), requireFeature("guest_loyalty"), crmController.loyaltyReport);
router.get(
  "/reports/customer-sales",
  authorize("customers.view"),
  authorize("sales.view"),
  crmController.customerSalesReport
);

// Feedback
router.get("/feedback", authorize("feedback.view"), crmController.listFeedback);
router.post("/feedback", authorize("feedback.manage"), crmController.createFeedback);
router.patch("/feedback/:id/status", authorize("feedback.manage"), crmController.setFeedbackStatus);

// Complaints
router.get("/complaints", authorize("feedback.view"), crmController.listComplaints);
// Who a complaint can go to, and which bill it is about, for the form.
router.get("/complaints/assignees", authorize("feedback.manage"), crmController.listAssignees);
router.get("/complaints/lookup", authorize("feedback.manage"), crmController.lookupReference);
router.post("/complaints", authorize("feedback.manage"), crmController.createComplaint);
router.put("/complaints/:id", authorize("feedback.manage"), crmController.updateComplaint);

module.exports = router;
