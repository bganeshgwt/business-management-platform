// The shift log book, mounted at /api/staff/logbook (see staff.routes.js).
//
// Reading it, and marking entries read, is logbook.view; writing an entry and
// closing a follow-up is logbook.write. Managers and cashiers have both.
// Writing follows the outlet switcher, like the till.
const express = require("express");
const logbookController = require("../controllers/logbook.controller");
const authorize = require("../../../../middlewares/authorize");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");

const router = express.Router();

router.get("/", authorize("logbook.view"), logbookController.list);
// Since you were last here: unread entries and open follow-ups.
router.get("/handover", authorize("logbook.view"), logbookController.handover);
router.post("/read", authorize("logbook.view"), logbookController.markRead);
router.get("/:id", authorize("logbook.view"), logbookController.getOne);
router.post("/", authorize("logbook.write"), resolveOutlet, logbookController.create);
router.post("/:id/close", authorize("logbook.write"), logbookController.close);

module.exports = router;
