// Staff -> Tips, mounted at /api/staff/tips (see staff.routes.js).
//
// Tips are part of people's pay, so every screen here needs "see salaries and
// payroll money" (staff.salaries): the totals, each person's share, sharing
// out and undoing. Entering a tip at payment is the billing screen's, under
// the payment permission.
const express = require("express");
const tipController = require("../controllers/tip.controller");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");

const router = express.Router();

// Sharing tips out to staff: needs Tips and Staff & payroll.
router.use(requireFeature("tips", "staff_payroll"));

router.get("/", authorize("staff.salaries"), tipController.overview);
router.get("/settings", authorize("staff.salaries"), tipController.getSettings);
router.put("/settings", authorize("staff.salaries"), tipController.saveSettings);
router.post("/preview", authorize("staff.salaries"), tipController.preview);
router.post("/shareouts", authorize("staff.salaries"), tipController.confirm);
router.delete("/shareouts/:id", authorize("staff.salaries"), tipController.undo);

module.exports = router;
