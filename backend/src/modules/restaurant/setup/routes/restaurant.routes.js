const express = require("express");
const restaurantController = require("../controllers/restaurant.controller");
const paymentTypeController = require("../controllers/paymentType.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");

const router = express.Router();

// Every route below needs a logged-in user.
router.use(authenticate);

router.get("/current", authorize("restaurant.settings.view"), restaurantController.getCurrent);
router.put("/current", authorize("restaurant.settings.manage"), restaurantController.updateCurrent);

// Any logged-in user may READ settings: the POS, bills and reports all need the
// currency symbol, tax mode and bill header. Changing them still needs the
// manage permission.
router.get("/current/settings", restaurantController.getSettings);
router.put(
  "/current/settings",
  authorize("restaurant.settings.manage"),
  restaurantController.updateSettings
);

// Owner-named payment types (meal cards, cheques, PhonePe…). Every till
// reads them; changing them is a settings change.
// Settings -> Features: the parts of the restaurant switched on or off.
// Anyone who may read the settings sees the list; only the owner
// (restaurant.settings.manage) switches, and the service checks that again.
const featuresController = require("../controllers/restaurantFeatures.controller");
router.get("/current/features", authorize("restaurant.settings.view"), featuresController.list);
router.post("/current/features/:code/preview", authorize("restaurant.settings.manage"), featuresController.preview);
router.put("/current/features/:code", authorize("restaurant.settings.manage"), featuresController.set);
// The format (restaurant, café, bakery, cloud kitchen) and its starting setup.
router.get("/current/format", authorize("restaurant.settings.view"), featuresController.getFormat);
router.put("/current/format", authorize("restaurant.settings.manage"), featuresController.setFormat);

router.get("/current/payment-types", authorize("orders.view"), paymentTypeController.list);
router.post("/current/payment-types", authorize("restaurant.settings.manage"), paymentTypeController.create);
router.put("/current/payment-types/:id", authorize("restaurant.settings.manage"), paymentTypeController.update);
router.delete("/current/payment-types/:id", authorize("restaurant.settings.manage"), paymentTypeController.remove);

// What the bill numbers of the main counter and each outlet look like.
router.get("/current/invoice-series", authorize("restaurant.settings.view"), restaurantController.getInvoiceSeries);

// The places a timezone may be set to, for the picker on the settings screen.
router.get("/current/timezones", authorize("restaurant.settings.view"), restaurantController.listTimezones);

// How much each role may take off a bill at the till on its own.
router.get(
  "/current/discount-limits",
  authorize("restaurant.settings.view"),
  restaurantController.getDiscountLimits
);
router.put(
  "/current/discount-limits",
  authorize("restaurant.settings.manage"),
  restaurantController.saveDiscountLimits
);

router.get(
  "/current/business-hours",
  authorize("restaurant.settings.view"),
  restaurantController.getBusinessHours
);
router.put(
  "/current/business-hours",
  authorize("restaurant.settings.manage"),
  restaurantController.updateBusinessHours
);

module.exports = router;
