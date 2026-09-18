const express = require("express");

const healthRoutes = require("./health.routes");
const authRoutes = require("./auth.routes");
const restaurantRoutes = require("./restaurant.routes");

const router = express.Router();

router.use("/", healthRoutes);
router.use("/auth", authRoutes);
router.use("/restaurants", restaurantRoutes);

module.exports = router;
