// The notifications centre behind the topbar bell.
//
// No authorize() here on purpose: every signed-in person has a bell. What is
// in it is filtered per provider by the permission of the module each alert
// comes from (see notifications/index.js), and read marks are only ever the
// caller's own.
const express = require("express");
const authenticate = require("../../../../middlewares/authenticate");
const notificationController = require("../controllers/notification.controller");

const router = express.Router();

router.use(authenticate);

router.get("/", notificationController.list);
router.post("/read", notificationController.markRead);
router.post("/unread", notificationController.markUnread);
router.post("/read-all", notificationController.markAllRead);

module.exports = router;
