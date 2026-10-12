const express = require("express");
const healthController = require("../controllers/health.controller");

const router = express.Router();

router.get("/health", healthController.getHealth);
router.get("/db-health", healthController.getDbHealth);

module.exports = router;
