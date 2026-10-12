// QR orders and service requests, as staff see them.
//
// Reading the inbox and answering a call (acknowledge, done) is orders.view:
// anyone who can see the floor's orders can walk a glass of water over.
// Accepting or rejecting an order request creates or changes an order, so it
// takes orders.create, the same as ringing one up at the POS. Switching QR
// ordering on or off for the whole restaurant is a manager's call: orders.manage.
const express = require("express");
const tableRequestController = require("../controllers/tableRequest.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");

const router = express.Router();

router.use(authenticate);
// Guests' requests from a table's QR code and from the online ordering page.
router.use(requireFeature.any("qr_ordering", "online_ordering"));
// The outlet the user is working in scopes the inbox: staff tied to one branch
// (or a manager switched to one) see and answer only that branch's tables and
// those that belong to no branch. An accepted request opens its order in the
// table's own outlet; the user's outlet is only the fallback for a table that
// has none.
router.use(resolveOutlet);

// Fixed paths before "/:id", so they are never read as an id.
router.get("/", authorize("orders.view"), tableRequestController.list);
router.get("/summary", authorize("orders.view"), tableRequestController.summary);
router.get("/settings", authorize("orders.view"), tableRequestController.getSettings);
router.put("/settings", authorize("orders.manage"), tableRequestController.updateSettings);

router.post("/close-earlier", authorize("orders.manage"), tableRequestController.closeEarlier);
router.get("/:id", authorize("orders.view"), tableRequestController.getById);
router.post("/:id/accept", authorize("orders.create"), tableRequestController.accept);
router.post("/:id/reject", authorize("orders.create"), tableRequestController.reject);
router.post("/:id/acknowledge", authorize("orders.view"), tableRequestController.acknowledge);
router.post("/:id/done", authorize("orders.view"), tableRequestController.done);

module.exports = router;
