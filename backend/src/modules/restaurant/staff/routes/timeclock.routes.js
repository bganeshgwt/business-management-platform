// Staff PIN time clock and who is on duty.
//
// Three audiences, three permissions:
//   staff.clock   the tablet at the staff entrance (often on a cashier's login):
//                 the board, checking a PIN, and punching
//   staff.view    reading a day's punches and timeline
//   staff.manage  setting PINs, adding a punch after the fact, and taking
//                 back a punch a manager added by mistake
const express = require("express");
const timeclockController = require("../controllers/timeclock.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");

const router = express.Router();

router.use(authenticate);
router.use(requireFeature("staff_payroll"));

router.get("/board", authorize("staff.clock"), timeclockController.board);
router.post("/verify", authorize("staff.clock"), timeclockController.verify);
router.post("/punch", authorize("staff.clock"), timeclockController.punch);

router.get("/day", authorize("staff.view"), timeclockController.day);
router.get("/punches", authorize("staff.view"), timeclockController.listPunches);
router.post("/punches", authorize("staff.manage"), timeclockController.addPunch);
router.delete("/punches/:punchId", authorize("staff.manage"), timeclockController.removePunch);

// Punch photos: the setting (managers), and each photo (whoever reads or
// manages the staff records; the tablet itself never reads them back).
router.get("/settings", authorize.any("staff.clock", "staff.view", "staff.manage"), timeclockController.getSettings);
router.put("/settings", authorize("staff.manage"), timeclockController.saveSettings);
router.get("/punches/:punchId/photo", authorize.any("staff.view", "staff.manage"), timeclockController.photo);

router.get("/pins", authorize("staff.manage"), timeclockController.listPins);
router.put("/pins/:employeeId", authorize("staff.manage"), timeclockController.setPin);
router.delete("/pins/:employeeId", authorize("staff.manage"), timeclockController.removePin);
router.post("/pins/:employeeId/unlock", authorize("staff.manage"), timeclockController.unlockPin);

module.exports = router;
