const app = require('../services/salespersonApp.service');
const office = require('../services/salespersonAppOffice.service');

// The salesperson app (wholesale), mounted inside business.routes.js (its
// login check, database-error translation and `context`, which loads the
// membership, then the module and permission). Every route is under
// /api/businesses/:businessId/sales; the services check again, and tie each
// write to the login's own salesperson.
//
//   The phone           me, the day's pack, one day, a customer looked up off
//                       the beat, a new shop's duplicate check; the day's
//                       start and end, check-in and check-out, an order, a
//                       collection, a new shop
//   The office          the day report, shops to approve, an order refused on
//                       arrival let through, a beat's visit order, a shop's
//                       saved place cleared, the settings, a salesperson's
//                       places erased
module.exports = (router, { context, send, b }) => {
  const field = ['salesperson_app.create', 'salesperson_app.view'];
  router.get(b('/sales/me'), context(field), async (req, res) => send(res, await app.me(req.business, req.user)));
  router.get(b('/sales/pack'), context(field), async (req, res) => send(res, await app.pack(req.business, req.user, req.query)));
  router.get(b('/sales/day'), context(field), async (req, res) => send(res, await app.day(req.business, req.user, req.query)));
  router.get(b('/sales/customers'), context(field), async (req, res) => send(res, await app.searchCustomers(req.business, req.user, req.query)));
  router.get(b('/sales/customers/:id'), context(field), async (req, res) => send(res, await app.customer(req.business, req.user, req.params.id)));
  router.get(b('/sales/shops/check'), context('salesperson_app.create'), async (req, res) => send(res, await app.checkShop(req.business, req.user, req.query)));

  router.post(b('/sales/days/start'), context('salesperson_app.create'), async (req, res) => send(res, await app.startDay(req.business, req.user, req.body), 201));
  router.post(b('/sales/days/end'), context('salesperson_app.create'), async (req, res) => send(res, await app.endDay(req.business, req.user, req.body)));
  router.post(b('/sales/visits'), context('salesperson_app.create'), async (req, res) => send(res, await app.checkIn(req.business, req.user, req.body), 201));
  router.post(b('/sales/visits/:visitKey/check-out'), context('salesperson_app.create'), async (req, res) =>
    send(res, await app.checkOut(req.business, req.user, req.params.visitKey, req.body)));
  router.post(b('/sales/orders'), context('salesperson_app.create'), async (req, res) => send(res, await app.takeOrder(req.business, req.user, req.body), 201));
  router.post(b('/sales/collections'), context('salesperson_app.create'), async (req, res) => send(res, await app.collect(req.business, req.user, req.body), 201));
  router.post(b('/sales/shops'), context('salesperson_app.create'), async (req, res) => send(res, await app.addShop(req.business, req.user, req.body), 201));

  router.get(b('/sales/report'), context('salesperson_app.view'), async (req, res) => send(res, await office.report(req.business, req.user, req.query)));
  router.get(b('/sales/new-shops'), context('salesperson_app.view'), async (req, res) => send(res, await office.pendingShops(req.business)));
  router.post(b('/sales/new-shops/:contactId/approve'), context('salesperson_app.approve'), async (req, res) =>
    send(res, await office.approveShop(req.business, req.user, req.params.contactId, req.body)));
  router.post(b('/sales/refusals/:id/release'), context('receivables.approve'), async (req, res) => send(res, await office.releaseRefusal(req.business, req.user, req.params.id, req.body)));
  router.get(b('/sales/beats/:beatId/shops'), context('sales_orders.view'), async (req, res) => send(res, await office.beatShops(req.business, req.params.beatId)));
  router.put(b('/sales/beats/:beatId/order'), context('sales_orders.edit'), async (req, res) => send(res, await office.setVisitOrder(req.business, req.user, req.params.beatId, req.body)));
  router.post(b('/sales/places/:contactId/clear'), context('salesperson_app.edit'), async (req, res) => send(res, await office.clearPlace(req.business, req.user, req.params.contactId)));
  router.get(b('/sales/settings'), context(['salesperson_app.view', 'salesperson_app.create', 'salesperson_app.edit']), async (req, res) => send(res, await office.settings(req.business)));
  router.put(b('/sales/settings'), context('salesperson_app.edit'), async (req, res) => send(res, await office.saveSettings(req.business, req.user, req.body)));
  router.post(b('/sales/salespeople/:id/erase-places'), context('privacy.manage'), async (req, res) =>
    send(res, await office.erasePlaces(req.business, req.user, req.params.id, req.body)));
};
