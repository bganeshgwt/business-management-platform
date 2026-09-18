const express = require("express");
const restaurantController = require("../controllers/restaurant.controller");
const authenticate = require("../middlewares/authenticate");
const authorize = require("../middlewares/authorize");

const router = express.Router();

router.get("/current", authenticate, authorize("restaurant.settings.view"), restaurantController.getCurrent);

module.exports = router;
