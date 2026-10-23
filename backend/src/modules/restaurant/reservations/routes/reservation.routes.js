// Reservations and the walk-in waitlist.
//
// Seating also needs orders.create, because it opens the table's order: a
// role that may take bookings but not orders can hold a table, not fill it.
const express = require("express");
const reservationController = require("../controllers/reservation.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");

const router = express.Router();

router.use(authenticate);
router.use(requireFeature("reservations"));
// The outlet a booking and its order belong to comes from the user or the
// switcher, never from the request body.
router.use(resolveOutlet);

// Named paths first, so they are never read as a booking id.
router.get("/day", authorize("reservations.view"), reservationController.board);
router.get("/availability", authorize("reservations.view"), reservationController.availability);
router.get("/guest", authorize("reservations.view"), reservationController.lookupGuest);

// Online booking: the requests inbox, and the public booking link
// of the counter or outlet being worked in. Answering a request is the host
// stand's job; opening the channel and its limits is a manager's.
router.get("/requests", authorize("reservations.view"), reservationController.requests);
router.get("/online-settings", authorize("reservations.view"), reservationController.onlineSettings);
router.put("/online-settings", authorize("reservations.online"), reservationController.updateOnlineSettings);
router.post("/online-settings/new-link", authorize("reservations.online"), reservationController.replaceOnlineLink);

// Walk-in waitlist
router.post("/waitlist", authorize("reservations.manage"), reservationController.addToWaitlist);
router.put("/waitlist/:id", authorize("reservations.manage"), reservationController.updateWaitlist);
router.patch("/waitlist/:id/notify", authorize("reservations.manage"), reservationController.notifyWaitlist);
router.patch("/waitlist/:id/left", authorize("reservations.manage"), reservationController.markLeft);
router.patch("/waitlist/:id/remove", authorize("reservations.manage"), reservationController.removeFromWaitlist);
router.post(
  "/waitlist/:id/seat",
  authorize("reservations.manage", "orders.create"),
  reservationController.seatWaitlist
);

// Bookings
router.get("/", authorize("reservations.view"), reservationController.list);
router.post("/", authorize("reservations.manage"), reservationController.create);
router.get("/:id", authorize("reservations.view"), reservationController.getById);
router.put("/:id", authorize("reservations.manage"), reservationController.update);
router.patch("/:id/confirm", authorize("reservations.manage"), reservationController.confirm);
router.patch("/:id/accept", authorize("reservations.manage"), reservationController.accept);
router.patch("/:id/decline", authorize("reservations.manage"), reservationController.decline);
router.patch("/:id/cancel", authorize("reservations.manage"), reservationController.cancel);
router.patch("/:id/no-show", authorize("reservations.manage"), reservationController.markNoShow);
router.patch("/:id/complete", authorize("reservations.manage"), reservationController.complete);
router.post("/:id/seat", authorize("reservations.manage", "orders.create"), reservationController.seat);

module.exports = router;
