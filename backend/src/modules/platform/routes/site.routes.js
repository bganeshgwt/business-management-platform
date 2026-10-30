// The platform's public site, mounted at /api/site (routes/index.js): what its
// home page, pricing, sign-up and contact pages read and send. No login is in
// front of it, so each route here is rate limited by address, as the guests'
// routes are.
const express = require("express");

const router = express.Router();

module.exports = router;
