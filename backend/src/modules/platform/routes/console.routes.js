// The platform console's operations, mounted inside the platform router
// (platform.routes.js), which lets in only the platform's own super admin:
// the company's settings and the price list, a business's plan and its time,
// payments to confirm and the invoice register.
const express = require("express");

const router = express.Router();

module.exports = router;
