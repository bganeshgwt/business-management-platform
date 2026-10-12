const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const service = require('../../core/services/business.service');
const retail = require('../services/businessRetail.service');
const customers = require('../services/businessRetailCustomers.service');
const offers = require('../services/businessRetailOffers.service');
const reports = require('../services/businessRetailReports.service');
const pro = require('../services/businessRetailPro.service');

// Retail routes (grocery / kirana, supermarket, books & stationery), added to
// the Business Admin router so they share its membership, module and
// permission checks (context) and its error handling:
//   /:businessId/retail/…   counter quote, scan, barcodes, scale codes, reports
//   /:businessId/udhaar/…   customer credit on the shared receivables module
//   /:businessId/offers/…   offers & discounts
//   /:businessId/loyalty/…  loyalty rules, points, corrections
//   /:businessId/books/…    book details
module.exports = function retailRoutes(router, { context, send, b }) {
  // Paged lists in the same shape as every other business list.
  const list = (path, name, permission, check) => router.get(b(path), context(permission), async (req, res) => {
    if (check) check(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : service.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    send(res, await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters }));
  });

  // The counter.
  router.post(b('/retail/quote'), context('sales.create'), async (req, res) => send(res, await retail.quote(req.business, req.user, req.body)));
  router.get(b('/retail/scan'), context(['sales.create', 'catalog.view']), async (req, res) => send(res, await retail.scan(req.business, req.query)));

  // Labels, barcodes and scale codes.
  router.post(b('/retail/barcodes'), context('catalog.edit'), async (req, res) => send(res, await retail.assignBarcodes(req.business, req.user, req.body)));
  list('/retail/scale-items', 'scale-items', 'catalog.view', retail.requireWeight);
  router.put(b('/retail/scale-items/:skuId'), context('catalog.edit'), async (req, res) => send(res, await retail.setScaleCode(req.business, req.user, req.params.skuId, req.body)));
  router.delete(b('/retail/scale-items/:skuId'), context('catalog.edit'), async (req, res) => send(res, await retail.removeScaleCode(req.business, req.user, req.params.skuId)));

  // Reports.
  router.get(b('/retail/reports/top-sellers'), context('reports.view'), async (req, res) => send(res, await reports.topSellers(req.business, req.query)));
  router.get(b('/retail/reports/slow-movers'), context('reports.view'), async (req, res) => send(res, await reports.slowMovers(req.business, req.query)));
  router.get(b('/retail/reports/category-margin'), context('reports.view'), async (req, res) => send(res, await reports.categoryMargin(req.business, req.query)));
  router.get(b('/retail/reports/stock-value'), context('reports.view'), async (req, res) => send(res, await reports.stockValue(req.business, req.query)));

  // Udhaar.
  router.get(b('/udhaar'), context('receivables.view'), async (req, res) => send(res, await customers.udhaarBook(req.business, req.query)));
  router.get(b('/udhaar/reminders'), context('receivables.view'), async (req, res) => send(res, await customers.reminderList(req.business, req.query)));
  list('/udhaar/reminder-log', 'udhaar-reminders', 'receivables.view');
  router.get(b('/udhaar/:contactId'), context('receivables.view'), async (req, res) => send(res, await customers.customer(req.business, req.params.contactId)));
  router.get(b('/udhaar/:contactId/statement'), context('receivables.view'), async (req, res) => send(res, await customers.statement(req.business, req.params.contactId, req.query)));
  router.post(b('/udhaar/:contactId/collections'), context('receivables.create'), async (req, res) => send(res, await customers.collect(req.business, req.user, req.params.contactId, req.body), 201));
  router.post(b('/udhaar/:contactId/reminders'), context('receivables.create'), async (req, res) => send(res, await customers.remind(req.business, req.user, req.params.contactId, req.body), 201));

  // Offers.
  list('/offers', 'offers', 'offers.view');
  router.get(b('/offers/given'), context('offers.view'), async (req, res) => send(res, await offers.givenAway(req.business, req.query)));
  router.post(b('/offers'), context('offers.create'), async (req, res) => send(res, await offers.createOffer(req.business, req.user, req.body), 201));
  router.patch(b('/offers/:offerId'), context('offers.edit'), async (req, res) => send(res, await offers.updateOffer(req.business, req.user, req.params.offerId, req.body)));

  // Loyalty.
  router.get(b('/loyalty/rules'), context('loyalty.view'), async (req, res) => send(res, await customers.loyaltyRules(req.business)));
  router.put(b('/loyalty/rules'), context('loyalty.edit'), async (req, res) => send(res, await customers.saveLoyaltyRules(req.business, req.user, req.body)));
  list('/loyalty/members', 'loyalty-members', 'loyalty.view');
  list('/loyalty/entries', 'loyalty-entries', 'loyalty.view');
  router.get(b('/loyalty/:contactId'), context('loyalty.view'), async (req, res) => send(res, await customers.customerPoints(req.business, req.params.contactId)));
  router.post(b('/loyalty/:contactId/adjustments'), context('loyalty.edit'), async (req, res) => send(res, await customers.adjustPoints(req.business, req.user, req.params.contactId, req.body), 201));

  // Book details.
  list('/books', 'books', 'catalog.view', retail.requireBooks);
  router.post(b('/books'), context('catalog.create'), async (req, res) => send(res, await retail.createBook(req.business, req.user, req.body), 201));
  router.put(b('/books/:skuId'), context('catalog.edit'), async (req, res) => send(res, await retail.updateBook(req.business, req.user, req.params.skuId, req.body)));

  // Pro pass C: batches near expiry, school sets and customer orders for books.
  router.get(b('/retail/near-expiry'), context('inventory.view'), async (req, res) => send(res, await pro.nearExpiry(req.business, req.query)));
  list('/books/sets', 'book-sets', 'catalog.view', retail.requireBooks);
  router.post(b('/books/sets'), context('catalog.create'), async (req, res) => send(res, await pro.createSet(req.business, req.user, req.body), 201));
  router.get(b('/books/sets/:setId'), context('catalog.view'), async (req, res) => send(res, await pro.getSet(req.business, req.params.setId)));
  router.put(b('/books/sets/:setId'), context('catalog.edit'), async (req, res) => send(res, await pro.updateSet(req.business, req.user, req.params.setId, req.body)));
  list('/books/orders', 'book-orders', 'sales.view', retail.requireBooks);
  router.post(b('/books/orders'), context('sales.create'), async (req, res) => send(res, await pro.createOrder(req.business, req.user, req.body), 201));
  router.post(b('/books/orders/:orderId/status'), context(['sales.create', 'sales.edit']), async (req, res) => send(res, await pro.setOrderStatus(req.business, req.user, req.params.orderId, req.body)));

  return router;
};
