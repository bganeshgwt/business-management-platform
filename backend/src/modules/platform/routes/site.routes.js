// The platform's public site, mounted at /api/site (routes/index.js): what its
// home page, pricing, sign-up and contact pages read and send. No login is in
// front of it, so each route here is rate limited by address, as the guests'
// routes are: reading generously, for load only; each form five times an hour
// (rateLimiters.siteFormLimiter).
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { siteFormLimiter } = require("../../../middlewares/rateLimiters");
const clientIp = require("../../../utils/clientIp");
const AppError = require("../../../utils/AppError");
const site = require("../services/site.service");

const router = express.Router();

const send = (res, data, status = 200) => res.status(status).json({ success: true, data });

const jsonOnly = (req, res, next) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return next(new AppError(400, "A JSON object is required"));
  }

  next();
};

const readsPerAddress = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many requests from this network. Please wait a minute and try again." },
});

// The company's name, contact and grievance officer, and the trial, grace and
// GST the policies state.
router.get("/info", readsPerAddress, async (req, res) => send(res, await site.info()));

// Every business type's plans and add-ons with their prices before GST.
router.get("/pricing", readsPerAddress, async (req, res) => send(res, await site.pricing()));

// The owner's login and business on a free trial; the answer is a session,
// as the sign-in's.
router.post("/signup", siteFormLimiter, jsonOnly, async (req, res) =>
  send(res, await site.signup(req.body, { ip: clientIp(req), userAgent: req.get("user-agent") || null }), 201)
);

// A request to be called back.
router.post("/enquiries", siteFormLimiter, jsonOnly, async (req, res) => send(res, await site.enquire(req.body), 201));

module.exports = router;
