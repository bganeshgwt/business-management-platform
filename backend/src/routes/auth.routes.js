const express = require("express");
const authController = require("../controllers/auth.controller");
const authenticate = require("../middlewares/authenticate");
const { loginLimiter } = require("../middlewares/rateLimiters");

const router = express.Router();

router.post("/login", loginLimiter, authController.login);
router.get("/me", authenticate, authController.me);

module.exports = router;
