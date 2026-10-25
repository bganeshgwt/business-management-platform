const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const { requireLaundry } = require('../services/laundryCommon');
const prices = require('../services/laundryPrices.service');
const orders = require('../services/laundryOrders.service');
const delivery = require('../services/laundryDelivery.service');
const cancelling = require('../services/laundryCancel.service');
const claims = require('../services/laundryClaims.service');

// Laundries and dry cleaners, added to the Business Admin router so they
// share its login, membership, module and permission checks (context) and
// its database-error translation:
//   /:businessId/laundry/price-list|services|garments|prices   the price list: services billed as service items,
//                                                            garments, prices for each one or by the kilo
//   /:businessId/laundry/settings                           billing at intake or delivery, part handovers, express, the days
//   /:businessId/laundry/orders…                            take in (with a preview), the work, re-tagging and racks, the
//                                                            promised day, handovers with their bills, cancelling, the
//                                                            advance handed back, messages to the customer, damage claims
//   /:businessId/laundry/items|racks                        garments found by tag, phone or order; garments ready on the racks
//   /:businessId/laundry/unclaimed                          orders ready and not collected, with the reminders sent
//   /:businessId/laundry/claims…                            damage claims, and a manager's decision on one
//   /:businessId/laundry/counts|approvers                   the day's picture; who may approve a refund
// Another type of business never has the module, so `context` refuses it (the
// price list and the settings: the service, after `context` checks the
// catalogue or settings permission); the services repeat every check and
// answer 404 for another type.

module.exports = function laundryRoutes(router, { context, send, b }) {
  // shape: what the caller's role sees of the page.
  const list = (path, name, permission, shape) => router.get(b(path), context(permission), async (req, res) => {
    requireLaundry(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    const page = await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters });
    send(res, shape ? shape(req.business, page) : page);
  });

  // The price list and the settings.
  router.get(b('/laundry/price-list'), context('laundry.view'), async (req, res) => send(res, await prices.priceList(req.business)));
  router.post(b('/laundry/services'), context('catalog.edit'), async (req, res) => send(res, await prices.createService(req.business, req.user, req.body), 201));
  router.put(b('/laundry/services/:id'), context('catalog.edit'), async (req, res) => send(res, await prices.updateService(req.business, req.user, req.params.id, req.body)));
  router.post(b('/laundry/garments'), context('catalog.edit'), async (req, res) => send(res, await prices.createGarment(req.business, req.user, req.body), 201));
  router.put(b('/laundry/garments/:id'), context('catalog.edit'), async (req, res) => send(res, await prices.updateGarment(req.business, req.user, req.params.id, req.body)));
  router.put(b('/laundry/prices'), context('catalog.edit'), async (req, res) => send(res, await prices.setPrices(req.business, req.user, req.body)));
  router.get(b('/laundry/settings'), context('laundry.view'), async (req, res) => send(res, await prices.settings(req.business)));
  router.put(b('/laundry/settings'), context('settings.edit'), async (req, res) => send(res, await prices.saveSettings(req.business, req.user, req.body)));

  // Garment orders.
  list('/laundry/orders', 'laundry-orders', 'laundry.view', orders.listShape);
  list('/laundry/orders/open', 'laundry-orders-open', 'laundry.view', orders.listShape);
  router.get(b('/laundry/orders/counts'), context('laundry.view'), async (req, res) => send(res, await orders.counts(req.business)));
  router.post(b('/laundry/orders/preview'), context('laundry.create'), async (req, res) => send(res, await orders.preview(req.business, req.user, req.body)));
  router.post(b('/laundry/orders'), context('laundry.create'), async (req, res) => send(res, await orders.takeIn(req.business, req.user, req.body), 201));
  router.get(b('/laundry/orders/:id'), context('laundry.view'), async (req, res) => send(res, await orders.detail(req.business, req.params.id)));
  router.patch(b('/laundry/orders/:id'), context('laundry.edit'), async (req, res) => send(res, await orders.updateDetails(req.business, req.user, req.params.id, req.body)));
  router.post(b('/laundry/orders/:id/status'), context('laundry.edit'), async (req, res) => send(res, await orders.setStatus(req.business, req.user, req.params.id, req.body)));
  router.patch(b('/laundry/orders/:id/items/:itemId'), context('laundry.edit'), async (req, res) =>
    send(res, await orders.updateItem(req.business, req.user, req.params.id, req.params.itemId, req.body)));
  router.post(b('/laundry/orders/:id/deliver'), context('laundry.edit'), async (req, res) => send(res, await delivery.deliver(req.business, req.user, req.params.id, req.body)));
  router.post(b('/laundry/orders/:id/cancel'), context('laundry.cancel'), async (req, res) => send(res, await cancelling.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/laundry/orders/:id/advance-refund'), context('sales.edit'), async (req, res) =>
    send(res, await cancelling.refundAdvance(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/laundry/orders/:id/notices'), context('laundry.view'), async (req, res) => send(res, await orders.logNotice(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/laundry/orders/:id/claims'), context('laundry.edit'), async (req, res) => send(res, await claims.record(req.business, req.user, req.params.id, req.body), 201));

  // Garments by tag, phone or order; the racks; orders not collected; damage claims.
  list('/laundry/items', 'laundry-items', 'laundry.view');
  list('/laundry/racks', 'laundry-racks', 'laundry.view');
  list('/laundry/unclaimed', 'laundry-unclaimed', 'laundry.view', orders.listShape);
  list('/laundry/claims', 'laundry-claims', 'laundry.view', claims.listShape);
  router.post(b('/laundry/claims/:id/decide'), context('laundry.refund'), async (req, res) => send(res, await claims.decide(req.business, req.user, req.params.id, req.body)));
  router.get(b('/laundry/approvers'), context(['laundry.cancel', 'laundry.refund', 'sales.edit']), async (req, res) => send(res, await orders.approvers(req.business, req.query)));
};
