// The restaurant's own online ordering page (SW-A-22), under
// /api/public/online. NO login: the menu and the order form are reached by a
// link's token, a guest's own order by the 192-bit token it was given.
//
// Limits, counted per server process like the QR ones (public.routes):
//   - per network address: generous, because a mobile carrier's gateway puts
//     thousands of phones behind one address, but enough to stop one machine
//     flooding the page;
//   - per mobile number: the real control on orders. A guest has no business
//     sending more than a few orders in half an hour, and the number is what
//     identifies them. Kept in the database as well: a mobile may have only
//     the link's "open orders per mobile" waiting or in progress at once
//     (onlineOrder.repository), which holds across server processes;
//   - per guest order: its status poll and its cancel button.
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const publicMenuController = require("../../orders/controllers/publicMenu.controller");
const { normaliseMobile } = require("../../../../utils/phone");

const router = express.Router();

const MINUTE = 60 * 1000;

const refuse = (message) => ({ success: false, message });

const byAddress = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: refuse(message || "Too many requests from this network. Please wait a minute and try again."),
  });

const byKey = (windowMs, limit, keyOf, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: keyOf,
    message: refuse(message),
  });

// The number as it will be stored, so "98200 11201" and "+91 9820011201"
// are one guest. A body with no readable number is counted under its link,
// and is refused by the controller anyway.
const mobileKey = (req) => {
  const body = req.body || {};
  const mobile = normaliseMobile(typeof body.guestMobile === "string" ? body.guestMobile : "");

  return mobile ? `online-mobile:${mobile}` : `online-link:${String(req.params.token || "").slice(0, 64)}`;
};

const guestKey = (req) => `online-order:${String(req.params.guestToken || "").slice(0, 64)}`;

// Reading the menu (switching takeaway/delivery reloads it) and following an
// order: one phone polls every 15 seconds while it waits.
const readsPerAddress = byAddress(MINUTE, 3000);
// Orders from one address: a family on one Wi-Fi, an office ordering lunch.
const ordersPerAddress = byAddress(
  10 * MINUTE,
  30,
  "Too many orders from this network in a short time. Please wait a few minutes, or call the restaurant."
);
const ordersPerMobile = byKey(
  30 * MINUTE,
  5,
  mobileKey,
  "This mobile number has sent several orders in a short time. Please wait a little, or call the restaurant."
);
const cancelsPerAddress = byAddress(10 * MINUTE, 200);
const pollsPerOrder = byKey(MINUTE, 60, guestKey, "Please wait a moment before checking again.");
const cancelsPerOrder = byKey(10 * MINUTE, 10, guestKey, "Please wait a moment and try again.");

router.get("/:token/menu", readsPerAddress, publicMenuController.onlineMenu);

router.post("/:token/orders", ordersPerAddress, ordersPerMobile, publicMenuController.placeOnlineOrder);

router.get("/:token/orders/:guestToken", readsPerAddress, pollsPerOrder, publicMenuController.onlineOrder);

router.post(
  "/:token/orders/:guestToken/cancel",
  cancelsPerAddress,
  cancelsPerOrder,
  publicMenuController.cancelOnlineOrder
);

module.exports = router;
