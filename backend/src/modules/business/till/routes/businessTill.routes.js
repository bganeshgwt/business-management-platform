const devices = require('../services/tillDevices.service');
const snapshots = require('../services/tillSnapshot.service');
const bills = require('../services/tillBills.service');
const review = require('../services/tillReview.service');

// The offline till (docs/API.md › Offline till), under /:businessId/till/…:
//   the till itself (a cashier signed in on it, with its secret in X-Till-Token):
//     its snapshot, its reports, its bills and voids;
//   Settings › Tills: setting up, renaming and retiring tills, the limits;
//   Daily money › Offline bills: the review, the numbers for GSTR-1.
// Mounted by business.routes.js with its context() (membership → module →
// permission) and send(); the services check the till and the application.
module.exports = (router, { context, send, b }) => {
  const token = (req) => req.get('x-till-token');

  router.get(b('/till/snapshot'), context('sales.create'), async (req, res) => send(res, await snapshots.snapshot(req.business, req.user, req.query, token(req))));
  router.post(b('/till/heartbeat'), context('sales.create'), async (req, res) => send(res, await devices.heartbeat(req.business, req.user, req.body, token(req))));
  router.post(b('/till/bills'), context('sales.create'), async (req, res) => send(res, await bills.receive(req.business, req.user, req.body, token(req)), 201));

  router.get(b('/till/devices'), context('offline_till.view'), async (req, res) => send(res, await devices.list(req.business, req.query)));
  router.post(b('/till/devices'), context('offline_till.manage'), async (req, res) => send(res, await devices.register(req.business, req.user, req.body), 201));
  router.patch(b('/till/devices/:id'), context('offline_till.manage'), async (req, res) => send(res, await devices.rename(req.business, req.user, req.params.id, req.body)));
  router.post(b('/till/devices/:id/retire'), context('offline_till.manage'), async (req, res) => send(res, await devices.retire(req.business, req.user, req.params.id, req.body)));
  router.get(b('/till/settings'), context('offline_till.view'), async (req, res) => send(res, await devices.readSettings(req.business)));
  router.put(b('/till/settings'), context('offline_till.manage'), async (req, res) => send(res, await devices.saveSettings(req.business, req.user, req.body)));

  router.get(b('/till/review'), context('offline_till.view'), async (req, res) => send(res, await review.summary(req.business, req.query)));
  router.get(b('/till/review/:list'), context('offline_till.view'), async (req, res) => send(res, await review.list(req.business, req.params.list, req.query)));
  router.get(b('/till/numbers'), context('offline_till.view'), async (req, res) => send(res, await review.numbers(req.business, req.query)));
  router.post(b('/till/flags/:id/acknowledge'), context('offline_till.review'), async (req, res) => send(res, await review.acknowledge(req.business, req.user, req.params.id, req.body)));
  router.post(b('/till/shortfalls/:id/resolve'), context('offline_till.review'), async (req, res) => send(res, await review.resolveShortfall(req.business, req.user, req.params.id, req.body)));
  router.post(b('/till/gaps/:id/note'), context('offline_till.review'), async (req, res) => send(res, await review.noteGap(req.business, req.user, req.params.id, req.body)));
};
