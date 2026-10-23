// Guest-facing QR ordering. NO login: every route is scoped by a table's QR
// token and rate limited twice — per network address and per table.
//
// Why two limits. Per address alone does not work in a restaurant: every guest
// on the house Wi-Fi, and thousands of phones behind one mobile carrier's
// gateway, share an address, so it has to be generous or it would lock out a
// full dining room. Per table is the real control — one table has no business
// sending more than a handful of orders in ten minutes — and it is keyed on
// the QR token, which is the only identity a guest has.
//
// Limits are counted per server process (express-rate-limit's memory store).
// Behind more than one API process each keeps its own count, which only makes
// them more lenient; the per-table "3 orders waiting" rule in the service is
// kept in the database and holds regardless.
//
// The address is the connection's. Behind a hosting proxy that is the proxy's
// own address — every guest on the platform in one bucket — unless the app
// trusts the proxy (TRUST_PROXY in config/env.js, applied with
// app.set("trust proxy") in app.js), so Express reads the real client.
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const publicMenuController = require("../controllers/publicMenu.controller");

const router = express.Router();

const MINUTE = 60 * 1000;

const refuse = (message) => ({ success: false, message });

const TABLE_BUSY =
  "This table has sent a lot of requests in a short time. Please wait a few minutes, or ask a member of staff.";

const byAddress = (windowMs, limit) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: refuse("Too many requests from this network. Please wait a minute and try again."),
  });

// Keyed on the token as sent, before it is checked: a stream of made-up tokens
// is capped by the address limit instead.
const byTable = (windowMs, limit) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => `table:${String(req.params.token || "").slice(0, 64)}`,
    message: refuse(TABLE_BUSY),
  });

// Reading: the menu once a visit, then a status poll per phone — every 6 s
// while an order waits for staff, every 20 s while it is being cooked. One
// mobile carrier's gateway can put hundreds of phones, in every restaurant on
// the platform, behind one address, so this is set for that crowd (a hundred
// phones waiting at once is 1,000 a minute) with room to spare. It is not
// what stops a table flooding the inbox — the per-table limits are — and QR
// tokens are 128 bits, so no rate makes guessing them worthwhile.
const readsPerAddress = byAddress(MINUTE, 3000);
// Writing: orders, calls, cancellations and feedback together.
const writesPerAddress = byAddress(10 * MINUTE, 600);

const menuPerTable = byTable(MINUTE, 40);
const statusPerTable = byTable(MINUTE, 150);
const ordersPerTable = byTable(10 * MINUTE, 8);
const callsPerTable = byTable(10 * MINUTE, 15);
const cancelsPerTable = byTable(10 * MINUTE, 10);
const feedbackPerTable = byTable(60 * MINUTE, 5);

router.get(
  "/tables/:token/menu",
  readsPerAddress,
  menuPerTable,
  publicMenuController.menu
);

router.post(
  "/tables/:token/orders",
  writesPerAddress,
  ordersPerTable,
  publicMenuController.placeOrder
);

// ?ids=12,15 — the requests this phone is following. Only those belonging to
// the table behind the token come back.
router.get(
  "/tables/:token/requests",
  readsPerAddress,
  statusPerTable,
  publicMenuController.requests
);

router.get(
  "/tables/:token/requests/:id",
  readsPerAddress,
  statusPerTable,
  publicMenuController.request
);

router.post(
  "/tables/:token/requests/:id/cancel",
  writesPerAddress,
  cancelsPerTable,
  publicMenuController.cancel
);

router.post(
  "/tables/:token/calls",
  writesPerAddress,
  callsPerTable,
  publicMenuController.call
);

router.post(
  "/tables/:token/feedback",
  writesPerAddress,
  feedbackPerTable,
  publicMenuController.feedback
);

// Online table booking: a restaurant's booking link and each
// guest's own status link, with limits of their own.
router.use("/booking", require("../../reservations/routes/publicBooking.routes"));

// The restaurant's own online ordering page: takeaway and delivery
// from a public link, with limits per address and per mobile of their own.
router.use("/online", require("../../online/routes/publicOnline.routes"));

module.exports = router;
