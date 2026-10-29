const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const { requireOptical } = require('../services/opticalCommon');
const prescriptions = require('../services/opticalPrescriptions.service');
const orders = require('../services/opticalOrders.service');
const recall = require('../services/opticalRecall.service');
const lenses = require('../services/opticalLenses.service');
const work = require('../services/opticalOrderWork.service');
const lensCare = require('../services/opticalContactLenses.service');
const referrals = require('../services/opticalReferrals.service');

// Optical shops, added to the Business Admin router so they share its login,
// membership, module and permission checks (context) and its database-error
// translation:
//   /:businessId/optical/prescriptions…    prescriptions: record, read, correct
//   /:businessId/optical/customers/:id     a customer's prescriptions and orders
//   /:businessId/optical/examiners         who may be named as examiner
//   /:businessId/optical/orders…           spectacle orders: price, book, change
//                                          while booked, the lab and workshop
//                                          steps, the quality check, the frame
//                                          held, advances, delivery, cancel
//   /:businessId/optical/recall…           customers due for an eye test, and reminders
//   /:businessId/optical/settings          the months after which a customer is
//                                          due (and a group's), warranties
//   /:businessId/optical/power-grid…       a contact-lens product's powers
//   /:businessId/optical/lens-stock…       contact lenses in stock, power by power
//   /:businessId/optical/contact-lenses…   replacements due, and free trials
//   /:businessId/optical/referrals         the referral report by doctor
// Another type of business never has the module, so `context` refuses it (the
// settings and the power grid: the service, after `context` checks the
// settings or catalogue permission); the services repeat every check and
// answer 404 for another type.

module.exports = function opticalRoutes(router, { context, send, b }) {
  // check: refuses before the query; shape: what the caller's role sees of the page.
  const list = (path, name, permission, check, shape) => router.get(b(path), context(permission), async (req, res) => {
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
    const page = await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters });
    send(res, shape ? shape(req.business, page) : page);
  });

  // Prescriptions.
  list('/optical/prescriptions', 'optical-prescriptions', 'optical.view', requireOptical);
  router.post(b('/optical/prescriptions'), context('optical.create'), async (req, res) => send(res, await prescriptions.create(req.business, req.user, req.body), 201));
  router.get(b('/optical/prescriptions/:id'), context('optical.view'), async (req, res) => send(res, await prescriptions.detail(req.business, req.params.id)));
  router.put(b('/optical/prescriptions/:id'), context('optical.create'), async (req, res) => send(res, await prescriptions.update(req.business, req.user, req.params.id, req.body)));
  router.get(b('/optical/customers/:contactId'), context('optical.view'), async (req, res) => send(res, await prescriptions.customerHistory(req.business, req.params.contactId)));
  router.get(b('/optical/examiners'), context('optical.view'), async (req, res) => send(res, await prescriptions.examiners(req.business)));

  // Spectacle orders.
  list('/optical/orders', 'optical-orders', 'optical.view', requireOptical, orders.listShape);
  list('/optical/orders/open', 'optical-orders-open', 'optical.view', requireOptical, orders.listShape);
  router.get(b('/optical/orders/counts'), context('optical.view'), async (req, res) => send(res, await orders.counts(req.business)));
  router.post(b('/optical/orders/preview'), context('optical.create'), async (req, res) => send(res, await orders.preview(req.business, req.user, req.body)));
  router.post(b('/optical/orders'), context('optical.create'), async (req, res) => send(res, await orders.book(req.business, req.user, req.body), 201));
  router.get(b('/optical/orders/:id'), context('optical.view'), async (req, res) => send(res, await orders.detail(req.business, req.params.id)));
  router.patch(b('/optical/orders/:id'), context('optical.edit'), async (req, res) => send(res, await orders.updateDetails(req.business, req.user, req.params.id, req.body)));
  // The quality check needs optical.approve; every other step optical.edit (the service checks which).
  router.post(b('/optical/orders/:id/status'), context(['optical.edit', 'optical.approve']), async (req, res) => send(res, await orders.setStatus(req.business, req.user, req.params.id, req.body)));
  router.post(b('/optical/orders/:id/deliver'), context('optical.edit'), async (req, res) => send(res, await orders.deliver(req.business, req.user, req.params.id, req.body)));
  router.post(b('/optical/orders/:id/cancel'), context('optical.cancel'), async (req, res) => send(res, await orders.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/optical/orders/:id/advance-refund'), context('sales.edit'), async (req, res) => send(res, await orders.refundAdvance(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/optical/orders/:id/messages'), context('optical.view'), async (req, res) => send(res, await orders.logMessage(req.business, req.user, req.params.id, req.body), 201));
  // A booked order changed, the frame held in stock, another advance, a workshop step.
  router.post(b('/optical/orders/:id/change'), context('optical.manage'), async (req, res) => send(res, await work.change(req.business, req.user, req.params.id, req.body)));
  router.post(b('/optical/orders/:id/frame-hold'), context('optical.edit'), async (req, res) => send(res, await work.setHold(req.business, req.user, req.params.id, req.body)));
  router.post(b('/optical/orders/:id/advances'), context('optical.edit'), async (req, res) => send(res, await work.addAdvance(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/optical/orders/:id/workshop'), context('optical.edit'), async (req, res) => send(res, await work.workshopStep(req.business, req.user, req.params.id, req.body)));

  // The recall list and its setting.
  list('/optical/recall', 'optical-recall', 'optical.view', requireOptical);
  router.post(b('/optical/recall/:contactId/reminders'), context('optical.view'), async (req, res) => send(res, await recall.remind(req.business, req.user, req.params.contactId, req.body), 201));
  router.get(b('/optical/settings'), context('optical.view'), async (req, res) => send(res, await recall.settings(req.business)));
  router.put(b('/optical/settings'), context('settings.edit'), async (req, res) => send(res, await recall.saveSettings(req.business, req.user, req.body)));

  // Contact lenses: one product's powers as its items.
  router.post(b('/optical/power-grid'), context('catalog.create'), async (req, res) => send(res, await lenses.createGrid(req.business, req.user, req.body), 201));
  router.get(b('/optical/power-grid/:productId'), context('catalog.view'), async (req, res) => send(res, await lenses.grid(req.business, req.params.productId, req.query)));
  router.get(b('/optical/lens-stock'), context('inventory.view'), async (req, res) => send(res, await lenses.lensProducts(req.business, req.query)));
  router.get(b('/optical/lens-stock/:productId'), context('inventory.view'), async (req, res) => send(res, await lenses.lensStock(req.business, req.params.productId, req.query)));

  // Contact lenses due for replacement and their reminders; free trials.
  list('/optical/contact-lenses/due', 'optical-lens-due', 'optical.view', requireOptical);
  router.post(b('/optical/contact-lenses/:contactId/reminders'), context('optical.view'), async (req, res) => send(res, await lensCare.remind(req.business, req.user, req.params.contactId, req.body), 201));
  list('/optical/contact-lenses/trials', 'optical-lens-trials', 'optical.view', requireOptical);
  router.post(b('/optical/contact-lenses/trials'), context('optical.create'), async (req, res) => send(res, await lensCare.giveTrial(req.business, req.user, req.body), 201));
  router.post(b('/optical/contact-lenses/trials/:id/close'), context('optical.create'), async (req, res) => send(res, await lensCare.closeTrial(req.business, req.user, req.params.id, req.body)));

  // The referral report.
  router.get(b('/optical/referrals'), context('optical.view'), async (req, res) => send(res, await referrals.report(req.business, req.query)));
};
