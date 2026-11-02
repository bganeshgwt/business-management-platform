const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const authenticate = require('../../../middlewares/authenticate');
const authorize = require('../../../middlewares/authorize');
const requireFeature = require('../../../middlewares/requireFeature');
const resolveOutlet = require('../../../middlewares/resolveOutlet');
const clientIp = require('../../../utils/clientIp');
const push = require('../services/push.service');

// Alerts on a closed phone (API.md › Alerts on a closed phone), mounted at /api/push:
//
//   GET    /key                    the server's public key; 404 push_off when not set up
//   POST   /subscriptions          this phone's subscription, for the person signed in
//   DELETE /subscriptions          this phone's subscription removed (by its endpoint)
//   POST   /subscriptions/renew    a subscription the browser renewed by itself
//   POST   /test                   a test alert to the person's own phone
//
// The captain app's alerts are for whoever may open it: orders.create, with
// the Captain app feature on. The outlet is the one the person works in
// (resolveOutlet: tied to one, or picked on the device). Addresses and keys
// travel in the body, never in an address the logs keep.
const router = express.Router();

const tokenOf = (req) => String(req.headers.authorization || '').split(' ')[1];
const captain = [authenticate, requireFeature('captain_app'), authorize('orders.create'), resolveOutlet];

// A renewal names no person: few, from one address.
const renewLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many renewals from this network. Try again in a few minutes.' },
});

// A test alert at a time is plenty: a few a minute per person.
const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  keyGenerator: (req) => `user:${req.user.id}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'That is enough test alerts for a minute. Try again shortly.' },
});

router.get('/key', (req, res) => {
  res.json({ success: true, data: push.publicKey() });
});

router.post('/subscriptions', ...captain, async (req, res) => {
  const result = await push.subscribe(req.user, {
    body: req.body || {},
    token: tokenOf(req),
    outletId: req.outletId || null,
    userAgent: req.get('User-Agent'),
  });
  res.status(result.created ? 201 : 200).json({
    success: true,
    message: result.created ? 'Alerts are on for this phone.' : 'This phone\'s alerts are up to date.',
    data: result.subscription,
  });
});

router.delete('/subscriptions', authenticate, async (req, res) => {
  const result = await push.unsubscribe(req.user, { endpoint: (req.body || {}).endpoint });
  res.json({ success: true, message: result.removed ? 'Alerts are off for this phone.' : 'This phone had no alerts on.', data: result });
});

router.post('/subscriptions/renew', renewLimiter, async (req, res) => {
  const body = req.body || {};
  const result = await push.renew({ oldEndpoint: body.oldEndpoint, oldAuth: body.oldAuth, subscription: body.subscription });
  res.json({ success: true, message: 'This phone\'s alerts carry on.', data: result });
});

router.post('/test', ...captain, testLimiter, async (req, res) => {
  const result = await push.test(req.user, { endpoint: (req.body || {}).endpoint });
  res.json({ success: true, message: 'A test alert is on its way to this phone.', data: result });
});

module.exports = router;
