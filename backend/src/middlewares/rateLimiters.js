const { rateLimit } = require("express-rate-limit");

// Slows down password guessing: 10 login attempts per IP every 15 minutes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes.",
  },
});

module.exports = {
  loginLimiter,
};
