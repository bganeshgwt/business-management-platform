const express = require("express");
const authenticate = require("../../../middlewares/authenticate");
const resolveOutlet = require("../../../middlewares/resolveOutlet");
const AppError = require("../../../utils/AppError");
const authService = require("../../access/services/auth.service");
const access = require("../../business/core/services/businessAccess.service");
const hub = require("../services/liveHub");

// Live updates: a screen's stream of changes, for one restaurant or one
// business, through two front doors (ARCHITECTURE.md §3.5, API.md › Live
// updates):
//
//   GET /api/live                          the signed-in person's restaurant
//                                          (the outlet picked, as X-Outlet-Id)
//   GET /api/businesses/:businessId/live   a business they are a member of
//
// Mounted in routes/index.js before the /businesses router. The token comes in
// the Authorization header as for every other request, never in the address,
// where logs and the browser's history would keep it. While a stream is open
// it is checked again (services/liveHub.js) with what it was opened with.
const router = express.Router();

// The token the request was signed in with; authenticate has checked it.
const tokenOf = (req) => String(req.headers.authorization || "").split(" ")[1];

// What a stream's person must still be for as long as it is open: signed in
// with this token (its version, their login and their restaurant still on),
// and not waiting to choose a password, or a PIN, of their own.
const signedIn = async (token) => {
  const user = await authService.getUserFromToken(token);

  if (user.passwordChangeRequired) {
    throw new AppError(403, "Choose a password of your own before you carry on.", { reason: "password_change_required" });
  }

  if (user.pinChangeRequired) {
    throw new AppError(403, "Choose a PIN of your own before you carry on.", { reason: "pin_change_required" });
  }

  return user;
};

router.get("/live", authenticate, resolveOutlet, async (req, res) => {
  const restaurantId = Number(req.user.restaurantId);

  if (!restaurantId) {
    throw new AppError(404, "These live updates are for a restaurant's screens, and this login has no restaurant.");
  }

  const token = tokenOf(req);
  const pinned = req.outletPinned ? Number(req.outletId) : null;

  await hub.open(req, res, {
    kind: "restaurant",
    tenant: restaurantId,
    branch: req.outletId,
    user: req.user,
    token,
    check: async () => {
      const user = await signedIn(token);

      if (Number(user.restaurantId) !== restaurantId) {
        throw new AppError(403, "This login no longer works at this restaurant.");
      }

      // Tied to an outlet, moved to another or no longer tied to one: the
      // screen opens a new stream, for where they work now.
      if (Number(user.outletId || 0) !== Number(pinned || 0)) {
        throw new AppError(409, "The outlet you work at changed.");
      }
    },
  });
});

router.get("/businesses/:businessId/live", authenticate, async (req, res) => {
  const business = await access.open(req.user, req.params.businessId);
  const businessId = Number(business.id);
  const tied = business.member_location_id ? Number(business.member_location_id) : null;
  const token = tokenOf(req);

  await hub.open(req, res, {
    kind: "business",
    tenant: businessId,
    branch: tied,
    user: req.user,
    token,
    check: async () => {
      const again = await access.load(await signedIn(token), businessId);

      if (Number(again.member_location_id || 0) !== Number(tied || 0)) {
        throw new AppError(409, "The location you work at changed.");
      }
    },
  });
});

module.exports = router;
