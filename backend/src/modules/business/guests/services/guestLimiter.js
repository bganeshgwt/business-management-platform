const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// A rate limit for a guest page's route (ARCHITECTURE.md › Build a guest
// page for a business).
//
//   guestLimiter({ windowMs, max, key, message })
//
// Without `key`, each client address has its own count: the address as
// utils/clientIp.js reads it, so behind a hosting proxy (TRUST_PROXY) it is
// the visitor's, not the proxy's, and an IPv6 network counts as one (as the
// sign-in limits do). With `key(req)`, the count is per what it returns (a
// link's token, a mobile number), whatever the address, and per the address
// when it returns nothing (no mobile in the body). A route takes several:
// one per address for load, one per link against a flood at one business,
// one per mobile against one person's repeats. Each counts in its own API
// process (express-rate-limit's memory store), which only makes several
// processes more lenient; a rule that must hold (open bookings per mobile)
// is kept in the database as well.
//
// A request over the limit gets 429 { success: false, message }, with the
// draft-8 RateLimit headers.

const MINUTE = 60 * 1000;
const BUSY = "Too many requests from this network. Please wait a minute and try again.";

// The client's address, as the sign-in limits count it (required on use, so
// this file reads no setting when it is loaded).
const addressOf = (req) => ipKeyGenerator(require("../../../../utils/clientIp")(req));

// What one request is counted by.
const countedBy = (req, key, address = addressOf) => {
  const extra = key ? key(req) : null;
  return extra === null || extra === undefined || extra === "" ? `address:${address(req)}` : `key:${String(extra).slice(0, 200)}`;
};

function guestLimiter({ windowMs = MINUTE, max, key = null, message = BUSY } = {}) {
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(windowMs) || windowMs < 1000) {
    throw new Error("guestLimiter needs a window of a second or more and a count of 1 or more");
  }

  const { trustProxy } = require("../../../../config/env");

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => countedBy(req, key),
    // utils/clientIp reads X-Forwarded-For itself when TRUST_PROXY is set.
    ...(trustProxy ? { validate: { xForwardedForHeader: false } } : {}),
    message: { success: false, message },
  });
}

module.exports = { guestLimiter, countedBy, MINUTE };
