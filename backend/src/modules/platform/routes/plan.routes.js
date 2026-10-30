const express = require('express');
const authenticate = require('../../../middlewares/authenticate');
const authorize = require('../../../middlewares/authorize');
const access = require('../../business/core/services/businessAccess.service');
const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const subscriptions = require('../services/subscriptions.service');
const invoices = require('../services/planInvoices.service');

// "Your plan": one service (subscriptions.service.js), two front doors, for
// the owner only.
//
//   /api/businesses/:businessId/plan/…   a business's owner (its full-access
//                                        role); mounted in routes/index.js
//                                        before the /businesses router
//   /api/plan/…                          the signed-in restaurant's owner
//                                        (restaurant.settings.manage), for the
//                                        restaurant's business
//
// The plan's state is shown to everyone else in the business context and the
// restaurant profile, without prices.

const send = (res, data, status = 200) => res.status(status).json({ success: true, data });
const jsonOnly = (req, res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return next(new AppError(400, 'A JSON object is required'));
  }
  next();
};

// The paths under either door. `businessOf(req)` finds the business and
// refuses anyone but its owner.
function mount(router, path, guards, businessOf) {
  const on = (work, status = 200) => async (req, res) => send(res, await work(await businessOf(req), req), status);
  router.get(path(''), ...guards, on((business) => subscriptions.ownerView(business)));
  router.put(path('/selection'), ...guards, on((business, req) => subscriptions.setSelection(business, req.user, req.body)));
  router.post(path('/orders'), ...guards, on((business, req) => subscriptions.createOrder(business, req.user, req.body), 201));
  router.post(path('/orders/:orderId/payments'), ...guards, on((business, req) => subscriptions.submitPayment(business, req.user, req.params.orderId, req.body), 201));
  router.get(path('/invoices/:invoiceId'), ...guards, on((business, req) => invoices.view(req.params.invoiceId, { businessId: business.id })));
}

// --- A business on the shared core ------------------------------------------------------------
const businessRouter = express.Router();
mount(businessRouter, (path) => `/businesses/:businessId/plan${path}`, [authenticate, jsonOnly], async (req) => {
  const business = await access.open(req.user, req.params.businessId);
  if (!business.full_access) throw new AppError(403, "Your plan is the owner's to see and change. Ask the owner.");
  return business;
});

// --- The signed-in restaurant -----------------------------------------------------------------
const restaurantRouter = express.Router();
restaurantRouter.use(authenticate, jsonOnly);
mount(restaurantRouter, (path) => path || '/', [authorize('restaurant.settings.manage')], async (req) => {
  if (!req.user.restaurantId) throw new AppError(403, 'This account is not linked to a restaurant');
  // The restaurant's business, linked now if it was not yet.
  const { id } = await repo.one(repo.pool, 'SELECT restaurant_business_id($1) AS id', [req.user.restaurantId]);
  return repo.one(repo.pool, 'SELECT b.*,t.name AS type_name FROM businesses b JOIN business_types t ON t.code=b.business_type WHERE b.id=$1', [id]);
});

module.exports = { businessRouter, restaurantRouter };
