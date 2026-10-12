const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const fashion = require('../services/businessFashion.service');
const exchanges = require('../services/businessExchanges.service');
const electronics = require('../services/businessElectronics.service');
const repairs = require('../services/businessRepairs.service');
const fashionPro = require('../services/businessFashionPro.service');
const vouchers = require('../services/businessVouchers.service');
const electronicsPro = require('../services/businessElectronicsPro.service');

// Phase 2, T3 — fashion and electronics, added to the Business Admin router
// so they share its login, membership, module and permission checks
// (context) and its database-error translation:
//   /:businessId/fashion/…      size × colour matrix, variant reports
//   /:businessId/exchanges/…    exchanges (return + new sale in one step)
//   /:businessId/electronics/…  models (IMEI or serial, warranty months)
//   /:businessId/serials/…      the serial / IMEI register and a unit's history
//   /:businessId/warranties/…   registration, lookup by IMEI or phone, cards
//   /:businessId/repairs/…      repair jobs
// Services repeat every permission check.

repo.addLists({ ...fashion.lists, ...exchanges.lists, ...electronics.lists, ...repairs.lists, ...vouchers.lists, ...electronicsPro.lists });

module.exports = function fashionElectronicsRoutes(router, { context, send, b }) {
  // Paged lists in the same shape as every other business list. `check`
  // refuses a list whose extra module (variants, serials) is off.
  const list = (path, name, permission, check) => router.get(b(path), context(permission), async (req, res) => {
    if (check) check(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    send(res, await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters }));
  });
  const serials = (business) => electronics.requireModule(business, 'serials', 'Serial / IMEI numbers');

  // Fashion: the size × colour matrix.
  list('/fashion/products', 'fashion-products', 'catalog.view', fashion.requireVariants);
  router.post(b('/fashion/products'), context('catalog.create'), async (req, res) => send(res, await fashion.createProduct(req.business, req.user, req.body), 201));
  router.get(b('/fashion/products/:productId'), context('catalog.view'), async (req, res) => send(res, await fashion.matrix(req.business, req.params.productId, req.query)));
  router.post(b('/fashion/products/:productId/variants'), context('catalog.create'), async (req, res) => send(res, await fashion.addVariants(req.business, req.user, req.params.productId, req.body), 201));
  router.put(b('/fashion/products/:productId/prices'), context('catalog.edit'), async (req, res) => send(res, await fashion.setPrices(req.business, req.user, req.params.productId, req.body)));
  router.get(b('/fashion/reports/variants'), context('reports.view'), async (req, res) => send(res, await fashion.variantReport(req.business, req.query)));
  // Pro pass: barcodes, markdowns, GST by price, reports by style.
  router.put(b('/fashion/products/:productId/barcodes'), context('catalog.edit'), async (req, res) => send(res, await fashionPro.setBarcodes(req.business, req.user, req.params.productId, req.body)));
  router.get(b('/fashion/markdowns'), context('offers.view'), async (req, res) => send(res, await fashionPro.markdowns(req.business, req.query)));
  router.post(b('/fashion/markdowns'), context('offers.create'), async (req, res) => send(res, await fashionPro.createMarkdowns(req.business, req.user, req.body), 201));
  router.post(b('/fashion/markdowns/:offerId/end'), context('offers.edit'), async (req, res) => send(res, await fashionPro.endMarkdown(req.business, req.user, req.params.offerId)));
  router.get(b('/fashion/gst-rule'), context('catalog.view'), async (req, res) => send(res, await fashionPro.gstRule(req.business)));
  router.put(b('/fashion/gst-rule'), context('settings.edit'), async (req, res) => send(res, await fashionPro.saveGstRule(req.business, req.user, req.body)));
  router.get(b('/fashion/reports/styles'), context('reports.view'), async (req, res) => send(res, await fashionPro.styleReport(req.business, req.query)));

  // Exchanges.
  list('/exchanges', 'exchanges', 'exchanges.view');
  router.get(b('/exchanges/policy'), context(['exchanges.view', 'exchanges.create']), async (req, res) => send(res, await exchanges.policy(req.business)));
  router.put(b('/exchanges/policy'), context('settings.edit'), async (req, res) => send(res, await exchanges.savePolicy(req.business, req.user, req.body)));
  router.get(b('/exchanges/credits'), context(['exchanges.view', 'exchanges.create']), async (req, res) => send(res, await exchanges.credits(req.business)));
  router.post(b('/exchanges/credits/:contactId/use'), context('exchanges.create'), async (req, res) => send(res, await exchanges.useCredit(req.business, req.user, req.params.contactId, req.body), 201));
  router.post(b('/exchanges/quote'), context('exchanges.create'), async (req, res) => send(res, await exchanges.quote(req.business, req.user, req.body)));
  router.get(b('/exchanges/find'), context('exchanges.create'), async (req, res) => send(res, await exchanges.findSales(req.business, req.query)));
  // Credit vouchers: looked up at the counter by number, listed on Exchanges.
  list('/vouchers', 'exchange-vouchers', 'exchanges.view');
  router.get(b('/vouchers/by-number/:code'), context(['sales.create', 'exchanges.view']), async (req, res) => send(res, await vouchers.find(req.business, req.params.code)));
  router.get(b('/vouchers/:voucherId'), context('exchanges.view'), async (req, res) => send(res, await vouchers.detail(req.business, req.params.voucherId)));
  router.post(b('/exchanges'), context('exchanges.create'), async (req, res) => send(res, await exchanges.create(req.business, req.user, req.body), 201));
  router.get(b('/exchanges/:exchangeId'), context('exchanges.view'), async (req, res) => send(res, await exchanges.detail(req.business, req.params.exchangeId)));

  // Electronics: models, the serial / IMEI register.
  list('/electronics/models', 'electronics-models', 'catalog.view', serials);
  router.put(b('/electronics/models/:skuId'), context('catalog.edit'), async (req, res) => send(res, await electronics.saveModel(req.business, req.user, req.params.skuId, req.body)));
  list('/serials', 'serials', 'inventory.view', serials);
  router.get(b('/serials/history'), context('inventory.view'), async (req, res) => send(res, await electronics.serialHistory(req.business, req.query)));
  router.put(b('/serials/details'), context('inventory.edit'), async (req, res) => send(res, await electronics.saveSerialDetails(req.business, req.user, req.body)));
  // Pro pass: units scanned in on one receipt; faulty / DOA units.
  router.post(b('/electronics/receipts'), context('purchasing.create'), async (req, res) => send(res, await electronicsPro.receive(req.business, req.user, req.body), 201));
  list('/electronics/faulty', 'faulty-units', 'inventory.view', serials);
  router.post(b('/electronics/faulty'), context('inventory.edit'), async (req, res) => send(res, await electronicsPro.markFaulty(req.business, req.user, req.body), 201));
  router.post(b('/electronics/faulty/:faultyId/send'), context('purchasing.refund'), async (req, res) => send(res, await electronicsPro.sendToSupplier(req.business, req.user, req.params.faultyId, req.body)));
  router.post(b('/electronics/faulty/:faultyId/close'), context('inventory.edit'), async (req, res) => send(res, await electronicsPro.closeFaulty(req.business, req.user, req.params.faultyId, req.body)));

  // Warranties.
  list('/warranties', 'warranties', 'warranties.view');
  router.get(b('/warranties/lookup'), context('warranties.view'), async (req, res) => send(res, await electronics.lookup(req.business, req.query)));
  router.get(b('/warranties/eligible'), context('warranties.create'), async (req, res) => send(res, await electronics.eligible(req.business, req.query)));
  router.post(b('/warranties'), context('warranties.create'), async (req, res) => send(res, await electronics.register(req.business, req.user, req.body), 201));
  router.get(b('/warranties/:warrantyId'), context('warranties.view'), async (req, res) => send(res, await electronics.warrantyDetail(req.business, req.params.warrantyId)));
  router.post(b('/warranties/:warrantyId/cancel'), context('warranties.cancel'), async (req, res) => send(res, await electronics.cancel(req.business, req.user, req.params.warrantyId, req.body)));

  // Repair jobs.
  list('/repairs', 'repair-jobs', 'repairs.view');
  router.get(b('/repairs/counts'), context('repairs.view'), async (req, res) => send(res, await repairs.counts(req.business)));
  list('/warranty-claims', 'warranty-claims', 'repairs.view');
  router.get(b('/warranty-claims/summary'), context('repairs.view'), async (req, res) => send(res, await electronicsPro.claimSummary(req.business)));
  router.patch(b('/warranty-claims/:claimId'), context('repairs.edit'), async (req, res) => send(res, await electronicsPro.updateClaim(req.business, req.user, req.params.claimId, req.body)));
  router.post(b('/repairs'), context('repairs.create'), async (req, res) => send(res, await repairs.intake(req.business, req.user, req.body), 201));
  router.get(b('/repairs/:jobId'), context('repairs.view'), async (req, res) => send(res, await repairs.detail(req.business, req.params.jobId)));
  router.patch(b('/repairs/:jobId'), context('repairs.edit'), async (req, res) => send(res, await repairs.updateDetails(req.business, req.user, req.params.jobId, req.body)));
  router.post(b('/repairs/:jobId/status'), context('repairs.edit'), async (req, res) => send(res, await repairs.setStatus(req.business, req.user, req.params.jobId, req.body)));
  router.post(b('/repairs/:jobId/lines'), context('repairs.edit'), async (req, res) => send(res, await repairs.addLine(req.business, req.user, req.params.jobId, req.body), 201));
  router.delete(b('/repairs/:jobId/lines/:lineId'), context('repairs.edit'), async (req, res) => send(res, await repairs.removeLine(req.business, req.user, req.params.jobId, req.params.lineId)));
  router.post(b('/repairs/:jobId/deliver'), context('repairs.approve'), async (req, res) => send(res, await repairs.deliver(req.business, req.user, req.params.jobId, req.body)));
  router.post(b('/repairs/:jobId/advance-refund'), context('sales.edit'), async (req, res) => send(res, await repairs.refundAdvance(req.business, req.user, req.params.jobId, req.body), 201));
  router.post(b('/repairs/:jobId/cancel'), context('repairs.cancel'), async (req, res) => send(res, await repairs.cancelJob(req.business, req.user, req.params.jobId, req.body)));
  router.post(b('/repairs/:jobId/approval'), context('repairs.edit'), async (req, res) => send(res, await repairs.approval(req.business, req.user, req.params.jobId, req.body)));
  router.post(b('/repairs/:jobId/messages'), context('repairs.view'), async (req, res) => send(res, await repairs.logMessage(req.business, req.user, req.params.jobId, req.body), 201));
  router.post(b('/repairs/:jobId/claims'), context('repairs.edit'), async (req, res) => send(res, await electronicsPro.createClaim(req.business, req.user, req.params.jobId, req.body), 201));

  return router;
};
