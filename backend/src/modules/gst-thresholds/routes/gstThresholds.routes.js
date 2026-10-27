const express = require('express');
const authenticate = require('../../../middlewares/authenticate');
const authorize = require('../../../middlewares/authorize');
const service = require('../services/gstThresholds.service');

// An owner's GST thresholds: one module, three doors (services/gstThresholds.service.js).
//
//   /api/businesses/gst-thresholds…                 the owner's view across their businesses (no business in
//                                                   the address: each answer is the signed-in person's own),
//                                                   mounted from business.routes.js before its /:businessId routes
//   /api/businesses/:businessId/gst-pan, …/gst-thresholds/hsn…
//                                                   one business: the PAN its owner records, the HSN / SAC codes
//                                                   to fix, mounted from business.routes.js
//   /api/gst-thresholds/…                           the signed-in restaurant's HSN / SAC codes to fix, mounted in
//                                                   routes/index.js
//
// The bells take their lines from the service: businessNotifications.service.js
// and notifications/providers/gstThresholds.js.

// --- The owner's view ------------------------------------------------------------------------
function ownerRoutes(router, { send }) {
  router.get('/gst-thresholds', async (req, res) => send(res, await service.ownerView(req.user)));
  router.put('/gst-thresholds/warning-level', async (req, res) => send(res, await service.setWarnLevel(req.user, req.body)));
}

// --- One business ------------------------------------------------------------------------------
function businessRoutes(router, { context, send, b }) {
  // Any member reaches it; the service lets only the business's owners record a PAN.
  router.put(b('/gst-pan'), context(), async (req, res) => send(res, await service.recordPan(req.business, req.user, req.body)));
  router.get(b('/gst-thresholds/hsn'), context('catalog.view'), async (req, res) => send(res, await service.hsnSummary(req.business)));
  router.get(b('/gst-thresholds/hsn-items'), context('catalog.view'), async (req, res) => send(res, await service.hsnItems(req.business, req.query)));
}

// --- The signed-in restaurant ---------------------------------------------------------------------
const restaurantRouter = express.Router();
restaurantRouter.use(authenticate);
restaurantRouter.get('/hsn', authorize('menu.view'), async (req, res) => res.json({ success: true, data: await service.restaurantHsn(req.user) }));

module.exports = { ownerRoutes, businessRoutes, restaurantRouter };
