// Online table booking for guests (SW-A-21), mounted under /api/public/booking.
// No login: a request is scoped by the restaurant's booking-link token or by
// a guest's own status token.
//
// Three limits on asking for a table, because each alone has a hole:
//   per network address — but one mobile carrier's gateway puts thousands of
//     phones behind one address, so it is generous;
//   per mobile number — the person asking, whatever network they are on;
//   per link — a flood from many addresses at one restaurant's link.
// The real rule, "a mobile may hold N open bookings at once", is kept in the
// database by the service and holds whatever these counters say. Counters are
// per API process (express-rate-limit's memory store), which only makes them
// more lenient behind several processes.
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const publicBookingController = require("../controllers/publicBooking.controller");

const router = express.Router();

const MINUTE = 60 * 1000;
const refuse = (message) => ({ success: false, message });

const limiter = (windowMs, limit, message, keyGenerator) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: refuse(message),
    ...(keyGenerator ? { keyGenerator } : {}),
  });

const NETWORK_BUSY = "Too many requests from this network. Please wait a minute and try again.";

// Reading the page and its times: a guest flicks through dates and party
// sizes, and many guests share a carrier's address.
const readsPerAddress = limiter(MINUTE, 600, NETWORK_BUSY);
const requestsPerAddress = limiter(10 * MINUTE, 30, NETWORK_BUSY);
const cancelsPerAddress = limiter(10 * MINUTE, 30, NETWORK_BUSY);

// The last ten digits, so "+91 98765 43210" and "9876543210" share a count.
// Requests with no readable number share one bucket; the controller refuses
// them anyway.
const requestsPerMobile = limiter(
  60 * MINUTE,
  5,
  "This mobile number has sent several booking requests in a short time. Please wait a while, or call the restaurant.",
  (req) => `mobile:${String(req.body?.guestMobile || "").replace(/\D/g, "").slice(-10) || "none"}`
);

const requestsPerLink = limiter(
  10 * MINUTE,
  40,
  "This restaurant is receiving a lot of booking requests right now. Please try again in a few minutes, or call them.",
  (req) => `link:${String(req.params.token || "").slice(0, 64)}`
);

// The guest's own link. Status tokens are 192 random bits, so no rate makes
// guessing one worthwhile; the address limit is for load.
router.get("/status/:guestToken", readsPerAddress, publicBookingController.status);
router.post("/status/:guestToken/cancel", cancelsPerAddress, publicBookingController.cancel);

router.get("/:token", readsPerAddress, publicBookingController.info);
router.get("/:token/times", readsPerAddress, publicBookingController.times);
router.post(
  "/:token/requests",
  requestsPerAddress,
  requestsPerLink,
  requestsPerMobile,
  publicBookingController.request
);

module.exports = router;
