const express = require("express");
const loyaltyController = require("../controllers/loyalty.controller");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");

// Mounted by discount.routes.js at /api/discounts/loyalty (after its
// authenticate): the loyalty programme sits with the offers it competes with.
const router = express.Router();

// The points guests hold are a promise in rupees, so seeing them is for
// people who may see takings too.
router.get("/", authorize("discounts.view"), authorize("sales.view"), requireFeature("guest_loyalty"), loyaltyController.getProgramme);
// The rules are the restaurant's settings (the same permission as the
// earn rate and point value on the Settings screen).
router.put("/", authorize("restaurant.settings.manage"), loyaltyController.updateRules);

module.exports = router;
