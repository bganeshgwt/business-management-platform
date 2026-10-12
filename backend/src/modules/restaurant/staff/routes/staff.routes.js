const express = require("express");
const staffController = require("../controllers/staff.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const tipRoutes = require("./tip.routes");
const logbookRoutes = require("../../logbook/routes/logbook.routes");

const router = express.Router();

router.use(authenticate);

// Tips: collected, shared out, paid with salary (see tip.routes.js).
router.use("/tips", tipRoutes);

// The shift log book: what one shift tells the next (see logbook.routes.js).
router.use("/logbook", logbookRoutes);

// Staff records, shifts, attendance, leave and payroll: Staff & payroll.
router.use(requireFeature("staff_payroll"));

// Fixed paths come before "/:id" style ones so they are not read as ids.
router.get("/shifts", authorize("staff.view"), staffController.listShifts);
router.post("/shifts", authorize("staff.manage"), staffController.createShift);
router.put("/shifts/:id", authorize("staff.manage"), staffController.updateShift);
router.delete("/shifts/:id", authorize("staff.manage"), staffController.removeShift);

router.get("/roster", authorize("staff.view"), staffController.getRoster);
router.post("/roster", authorize("staff.manage"), staffController.saveAssignment);
// Fill a week from the one before, in one step.
router.post("/roster/copy-week", authorize("staff.manage"), staffController.copyWeek);
router.delete("/roster/:id", authorize("staff.manage"), staffController.removeAssignment);

router.get("/attendance", authorize("staff.view"), staffController.getAttendance);
// The month's register (muster roll): one row per person, one column per day.
router.get("/attendance/month", authorize("staff.view"), staffController.musterRoll);
router.post("/attendance", authorize("staff.manage"), staffController.saveAttendance);
router.post("/attendance/mark-remaining", authorize("staff.manage"), staffController.markRemaining);

// Leave types (Casual, Sick, Unpaid ...) and what each person has left.
router.get("/leave/types", authorize("staff.view"), staffController.listLeaveTypes);
router.post("/leave/types", authorize("staff.manage"), staffController.saveLeaveType);
router.put("/leave/types/:id", authorize("staff.manage"), staffController.saveLeaveType);
router.delete("/leave/types/:id", authorize("staff.manage"), staffController.removeLeaveType);
router.get("/leave/balances", authorize("staff.view"), staffController.leaveBalances);
router.get("/leave/register", authorize("staff.view"), staffController.leaveRegister);

// Payroll is money: managing staff is not enough, the salaries permission is
// needed as well (each route checks staff.manage first, then staff.salaries).
router.get("/payroll", authorize("staff.manage"), authorize("staff.salaries"), staffController.payroll);
router.get("/payroll/settings", authorize("staff.manage"), authorize("staff.salaries"), staffController.getPayrollSettings);
router.put("/payroll/settings", authorize("staff.manage"), authorize("staff.salaries"), staffController.savePayrollSettings);
// PF, ESI and professional tax: the settings, and what a month owes.
router.get("/payroll/statutory/settings", authorize("staff.manage"), authorize("staff.salaries"), staffController.getStatutorySettings);
router.put("/payroll/statutory/settings", authorize("staff.manage"), authorize("staff.salaries"), staffController.saveStatutorySettings);
router.get("/payroll/statutory", authorize("staff.manage"), authorize("staff.salaries"), staffController.statutorySummary);
router.get("/payroll/adjustments", authorize("staff.manage"), authorize("staff.salaries"), staffController.listAdjustments);
router.post("/payroll/adjustments", authorize("staff.manage"), authorize("staff.salaries"), staffController.addAdjustment);
router.delete("/payroll/adjustments/:id", authorize("staff.manage"), authorize("staff.salaries"), staffController.removeAdjustment);
router.get("/payroll/payments", authorize("staff.manage"), authorize("staff.salaries"), staffController.listPayments);
router.post("/payroll/payments", authorize("staff.manage"), authorize("staff.salaries"), staffController.recordPayment);
// "Mark all paid": several people, one period, one transaction.
router.post("/payroll/payments/bulk", authorize("staff.manage"), authorize("staff.salaries"), staffController.recordPaymentsBulk);
router.delete("/payroll/payments/:id", authorize("staff.manage"), authorize("staff.salaries"), staffController.removePayment);

router.get("/", authorize("staff.view"), staffController.listEmployees);
router.get("/:id/salary-history", authorize("staff.view"), authorize("staff.salaries"), staffController.salaryHistory);
router.post("/", authorize("staff.manage"), staffController.createEmployee);
router.put("/:id", authorize("staff.manage"), staffController.updateEmployee);
router.delete("/:id", authorize("staff.manage"), staffController.removeEmployee);

module.exports = router;
