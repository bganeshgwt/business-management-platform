const crypto = require("node:crypto");
const express = require("express");
const { ipKeyGenerator } = require("express-rate-limit");
const AppError = require("../../../utils/AppError");
const clientIp = require("../../../utils/clientIp");
const guestKeys = require("../services/guestKeys");
const hub = require("../services/liveHub");
const { guestLimiter, MINUTE } = require("../../business/guests/services/guestLimiter");

// A guest page's live updates (ARCHITECTURE.md §3.5, API.md › Guests' live
// updates):
//
//   GET /api/public/live?key=<guest live key>
//
// Mounted in routes/index.js before the rest of /api/public, so it answers
// any web address as they do. A guest sends no headers of its own (the page
// reads the stream with the browser's EventSource), so the key travels in
// the address; it names what the page may watch and nothing else, lasts two
// hours, and is never written to the request log (app.js prints the address
// with it hidden). The stream is the hub's (services/liveHub.js), beside the
// staff's streams and on the same listening connection.
const router = express.Router();

// Opening a stream: a page opens one when it shows, and again after a drop or
// when its key is renewed, so this is for load only.
const opens = guestLimiter({ windowMs: MINUTE, max: 120 });

// The key's own count of streams is kept by a digest, never the key itself.
const digestOf = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);

router.get("/", opens, async (req, res) => {
  const key = typeof req.query.key === "string" ? req.query.key : "";
  const { payload, problem } = guestKeys.read(key);

  if (!payload) {
    throw new AppError(
      403,
      problem === "expired"
        ? "This page's live updates need a fresh key. It reads its status again and carries on."
        : "This is not a live updates key of this server.",
      { reason: problem === "expired" ? "key_expired" : "invalid_key" }
    );
  }

  const { kind, tenant } = guestKeys.scopeOf(payload);

  await hub.openGuest(req, res, {
    kind,
    tenant,
    watch: payload.watch,
    expiresAt: payload.exp * 1000,
    // One phone, or one home's or one restaurant's network, as one address.
    address: ipKeyGenerator(clientIp(req), 64),
    keyDigest: digestOf(key),
  });
});

module.exports = router;
