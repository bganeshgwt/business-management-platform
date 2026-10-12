const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const config = require("../config/env");
const clientIp = require("../utils/clientIp");

// Every limiter counts per real client address (utils/clientIp.js): behind a
// hosting proxy that means the address TRUST_PROXY says to read, not the
// proxy's own, even if the app itself is not told to trust the proxy. IPv6
// addresses are grouped by network, as the library recommends, so one phone
// cannot dodge the limit by hopping addresses. The library's own "you are
// behind a proxy" warning is left on unless TRUST_PROXY is set, when the
// header is being read on purpose.
const shared = {
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  ...(config.trustProxy ? { validate: { xForwardedForHeader: false } } : {}),
};

// Slows down password guessing from one internet address.
//
// Only FAILED attempts count. A restaurant's staff all sign in from the same
// Wi-Fi, so counting good sign-ins would lock the whole shift out at the 11th
// person to arrive. Guessing one person's password is stopped separately, by
// the per-account lockout in auth.service (five wrong in fifteen minutes);
// this limit is the net for someone spraying guesses across many accounts.
//
// The address is the connection's, unless TRUST_PROXY says how many proxies
// sit in front of the API (see config/env.js), in which case the real client
// is read from X-Forwarded-For.
const loginLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: config.loginAttemptsPerQuarterHour,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many failed sign-ins from this network. Please try again after 15 minutes.",
  },
});

// Changing a password needs the current one, so this is the same guessing
// problem as login and gets the same treatment.
const passwordChangeLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: config.loginAttemptsPerQuarterHour,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again after 15 minutes.",
  },
});

// PIN checks (manager approval, unlocking or switching user on a shared till)
// happen on a till that is already signed in, and each PIN locks itself after
// five misses. This caps how fast one till can try PINs across many people.
const pinLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: Math.max(30, config.loginAttemptsPerQuarterHour),
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many wrong PINs from this till. Please wait 15 minutes.",
  },
});

module.exports = {
  loginLimiter,
  passwordChangeLimiter,
  pinLimiter,
};
