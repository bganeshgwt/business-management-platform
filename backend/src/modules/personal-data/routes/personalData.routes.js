const express = require('express');
const authenticate = require('../../../middlewares/authenticate');
const authorize = require('../../../middlewares/authorize');
const AppError = require('../../../utils/AppError');
const pd = require('../services/personalData.service');
const register = require('../services/privacyRegister.service');
const shop = require('../services/personalDataShop');
const restaurant = require('../services/personalDataRestaurant');

// Personal data: one module, two front doors (services/personalData.service.js).
//
//   /api/businesses/:businessId/privacy/…   a business on the shared core (its customers),
//                                           mounted from business.routes.js
//   /api/privacy/…                          the signed-in restaurant (its guests), mounted in routes/index.js
//
// The same paths under each. privacy.view reads the registers, privacy.manage
// keeps them and erases, privacy.export sees or exports one person's data.
// Recording or withdrawing a consent, and marking a child, is for whoever
// takes a customer (contacts.create or contacts.edit, a clinic's
// patients.create or patients.edit; a restaurant's customers.manage), checked
// in the service. The notice and the consent lookup are read by any member.

// The handlers, given the request's world.
function handlers(worldOf) {
  const send = (res, data, status = 200) => res.status(status).json({ success: true, data });
  const on = (work, status = 200) => async (req, res) => send(res, await work(worldOf(req), req), status);
  return {
    notice: on((world) => pd.notice(world)),
    notices: on((world) => pd.notices(world)),
    publish: on((world, req) => pd.publishNotice(world, req.body), 201),
    lookup: on((world, req) => pd.lookup(world, req.query.people)),
    people: on((world, req) => pd.searchPeople(world, req.query.q)),
    person: on((world, req) => pd.personView(world, req.params.personId)),
    give: on((world, req) => pd.give(world, req.params.personId, req.body), 201),
    withdraw: on((world, req) => pd.withdraw(world, req.params.consentId, req.body)),
    markChild: on((world, req) => pd.markChild(world, req.params.personId, req.body), 201),
    endChild: on((world, req) => pd.endChild(world, req.params.childId, req.body)),
    data: on((world, req) => register.personData(world, req.params.personId, { requestId: req.query.requestId || null })),
    exportData: on((world, req) => register.personData(world, req.params.personId, { requestId: req.query.requestId || null, exported: true })),
    requests: on((world, req) => register.page(world, 'privacy-requests', req.query)),
    logRequest: on((world, req) => register.logRequest(world, req.body), 201),
    request: on((world, req) => register.request(world, req.params.requestId)),
    linkRequest: on((world, req) => register.linkRequest(world, req.params.requestId, req.body)),
    closeRequest: on((world, req) => register.closeRequest(world, req.params.requestId, req.body)),
    erase: on((world, req) => register.erase(world, req.params.requestId, req.body)),
    breaches: on((world, req) => register.page(world, 'privacy-breaches', req.query)),
    recordBreach: on((world, req) => register.recordBreach(world, req.body), 201),
    breach: on((world, req) => register.breach(world, req.params.breachId)),
    updateBreach: on((world, req) => register.updateBreach(world, req.params.breachId, req.body)),
    breachPeople: on((world, req) => register.breachPeople(world, req.params.breachId, req.body)),
    removeBreachPerson: on((world, req) => register.removeBreachPerson(world, req.params.breachId, req.params.personId)),
    recordNotice: on((world, req) => register.recordNotice(world, req.params.breachId, req.body), 201),
    closeBreach: on((world, req) => register.closeBreach(world, req.params.breachId)),
    everyone: on((world, req) => register.everyone(world, req.query)),
  };
}

// The paths, under either front door. `guard(permission)` is the door's own
// check (null: any member; the service checks what depends on the record).
function mount(router, path, guard, h) {
  router.get(path('/notice'), guard(null), h.notice);
  router.get(path('/notices'), guard('privacy.view'), h.notices);
  router.post(path('/notices'), guard('privacy.manage'), h.publish);
  router.get(path('/consents'), guard(null), h.lookup);
  router.post(path('/consents/:consentId/withdraw'), guard(null), h.withdraw);
  router.get(path('/people'), guard('privacy.view'), h.people);
  router.get(path('/people/:personId'), guard(null), h.person);
  router.post(path('/people/:personId/consents'), guard(null), h.give);
  router.post(path('/people/:personId/child'), guard(null), h.markChild);
  router.post(path('/children/:childId/end'), guard(null), h.endChild);
  router.get(path('/people/:personId/data'), guard('privacy.export'), h.data);
  router.get(path('/people/:personId/export'), guard('privacy.export'), h.exportData);
  router.get(path('/requests'), guard('privacy.view'), h.requests);
  router.post(path('/requests'), guard('privacy.manage'), h.logRequest);
  router.get(path('/requests/:requestId'), guard('privacy.view'), h.request);
  router.post(path('/requests/:requestId/person'), guard('privacy.manage'), h.linkRequest);
  router.post(path('/requests/:requestId/close'), guard('privacy.manage'), h.closeRequest);
  router.post(path('/requests/:requestId/erase'), guard('privacy.manage'), h.erase);
  router.get(path('/breaches'), guard('privacy.view'), h.breaches);
  router.post(path('/breaches'), guard('privacy.manage'), h.recordBreach);
  router.get(path('/breaches/:breachId'), guard('privacy.view'), h.breach);
  router.patch(path('/breaches/:breachId'), guard('privacy.manage'), h.updateBreach);
  router.post(path('/breaches/:breachId/people'), guard('privacy.manage'), h.breachPeople);
  router.delete(path('/breaches/:breachId/people/:personId'), guard('privacy.manage'), h.removeBreachPerson);
  router.post(path('/breaches/:breachId/notices'), guard('privacy.manage'), h.recordNotice);
  router.post(path('/breaches/:breachId/close'), guard('privacy.manage'), h.closeBreach);
  router.get(path('/everyone'), guard('privacy.view'), h.everyone);
}

// --- A business on the shared core ----------------------------------------------------------
function businessRoutes(router, { context, b }) {
  mount(router, (path) => b(`/privacy${path}`), (permission) => context(permission || undefined), handlers((req) => shop.world(req.business, req.user)));
}

// --- The signed-in restaurant ---------------------------------------------------------------
['privacy.view', 'privacy.manage', 'privacy.export', 'customers.manage', 'customers.view'].forEach((code) => authorize.noteEnforced(code));
const restaurantRouter = express.Router();
restaurantRouter.use(authenticate);
restaurantRouter.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return next(new AppError(400, 'A JSON object is required'));
  }
  next();
});
mount(restaurantRouter, (path) => path, (permission) => (permission ? authorize(permission) : (req, res, next) => next()),
  handlers((req) => restaurant.world(req.user)));

module.exports = { businessRoutes, restaurantRouter };
