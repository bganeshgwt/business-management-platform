const restaurantFeatures = require("../modules/restaurant/setup/services/restaurantFeatures.service");

// Refuses a request when a restaurant feature is switched off (Settings ->
// Features), with a 403 that names the feature:
//
//   router.get("/", authorize("reservations.view"), requireFeature("reservations"), controller.list)
//
// Use after authenticate. The list of features switched on comes with the
// signed-in profile (req.user.features, read from restaurant_features() on
// every request), so this costs no query of its own. Several codes: every one
// must be on. requireFeature.any: at least one.
//
// A platform account belongs to no restaurant and has no features; the
// restaurant routes refuse it for that reason already, so it is let through
// here rather than told about a switch it cannot see.
const requireFeature = (...codes) => async (req, res, next) => {
  if (!req.user?.restaurantId) {
    return next();
  }

  for (const code of codes) {
    await restaurantFeatures.assertOn(req.user, code);
  }

  return next();
};

requireFeature.any = (...codes) => async (req, res, next) => {
  if (!req.user?.restaurantId || codes.some((code) => restaurantFeatures.has(req.user, code))) {
    return next();
  }

  return restaurantFeatures.assertOn(req.user, codes[0]);
};

module.exports = requireFeature;
