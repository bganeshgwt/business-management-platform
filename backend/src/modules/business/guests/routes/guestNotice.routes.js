const express = require("express");
const { guestLimiter, MINUTE } = require("../services/guestLimiter");
const { publicNotice } = require("../services/guestNotice");

// A business's privacy notice for its guests (API.md › Public guest pages):
//
//   GET /api/public/privacy/:ref
//
// Mounted in routes/index.js before the rest of /api/public, so it answers any
// web address and needs no login, as they do. :ref is the reference a guest
// page's link carries (services/privacyRef.js), never a business id.
const router = express.Router();

const reads = guestLimiter({ windowMs: MINUTE, max: 300 });

router.get("/:ref", reads, async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, data: await publicNotice(req.params.ref) });
});

module.exports = router;
