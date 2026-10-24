const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const { requireGarage, plateOf } = require('../services/garageCommon');
const vehicles = require('../services/garageVehicles.service');
const jobs = require('../services/garageJobCards.service');
const estimates = require('../services/garageEstimates.service');
const billing = require('../services/garageBilling.service');
const reminders = require('../services/garageReminders.service');

// Garages, added to the Business Admin router so they share its login,
// membership, module and permission checks (context) and its database-error
// translation:
//   /:businessId/garage/vehicles…          vehicles: add, change, owners, odometer
//   /:businessId/garage/customers/:id/…    a customer's statement of jobs per vehicle
//   /:businessId/garage/job-cards…         job cards: open, the board, details,
//                                          mechanics, the estimate and its versions,
//                                          parts used, work done, the owner's
//                                          approval, the claim, the advance, the
//                                          bill, cancel
//   /:businessId/garage/service-due        vehicles due for a service, insurance or PUC
//   /:businessId/garage/settings           the months and km to the next service, the claim-share item
// Another type of business never has the module, so `context` refuses it (the
// board and a job card take any member, so a mechanic sees their own: the
// service checks the module and answers 404 for another type); the services
// repeat every check.

module.exports = function garageRoutes(router, { context, send, b }) {
  // A registration typed with spaces or dashes finds the plate ("ts 09 ab 1234").
  const searchOf = (q) => {
    const text = q.trim().slice(0, 100);
    return /\d/.test(text) && /^[A-Za-z0-9\s-]+$/.test(text) && /\s|-/.test(text) ? plateOf(text) : text;
  };
  // shape: what the caller's role sees of the page.
  const list = (path, name, permission, shape) => router.get(b(path), context(permission), async (req, res) => {
    requireGarage(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? searchOf(req.query.q) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    const page = await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters });
    send(res, shape ? shape(req.business, page) : page);
  });

  // Vehicles, their owners and odometer readings, and a customer's statement.
  list('/garage/vehicles', 'garage-vehicles', 'garage.view');
  router.get(b('/garage/vehicles/find'), context(['garage.view', 'garage.create']), async (req, res) => send(res, await vehicles.find(req.business, req.query)));
  router.post(b('/garage/vehicles'), context('garage.create'), async (req, res) => send(res, await vehicles.create(req.business, req.user, req.body), 201));
  router.get(b('/garage/vehicles/:id'), context('garage.view'), async (req, res) => send(res, await vehicles.detail(req.business, req.params.id)));
  router.patch(b('/garage/vehicles/:id'), context('garage.edit'), async (req, res) => send(res, await vehicles.update(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/vehicles/:id/owner'), context('garage.edit'), async (req, res) => send(res, await vehicles.changeOwner(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/vehicles/:id/odometer'), context('garage.edit'), async (req, res) => send(res, await vehicles.recordOdometer(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/vehicles/:id/reminders'), context('garage.view'), async (req, res) => send(res, await reminders.remind(req.business, req.user, req.params.id, req.body), 201));
  router.get(b('/garage/customers/:contactId/statement'), context('garage.view'), async (req, res) => send(res, await vehicles.statement(req.business, req.params.contactId, req.query)));
  // Who may approve a lower odometer reading or an advance handed back; who may be named a mechanic.
  router.get(b('/garage/approvers'), context(['garage.create', 'garage.edit', 'sales.edit']), async (req, res) => send(res, await vehicles.approvers(req.business, req.query)));
  router.get(b('/garage/mechanics'), context('garage.view'), async (req, res) => send(res, await jobs.mechanicList(req.business)));

  // Job cards.
  list('/garage/job-cards', 'garage-job-cards', 'garage.view', jobs.listShape);
  router.get(b('/garage/job-cards/board'), context(), async (req, res) => send(res, await jobs.board(req.business)));
  router.post(b('/garage/job-cards'), context('garage.create'), async (req, res) => send(res, await jobs.open(req.business, req.user, req.body), 201));
  router.get(b('/garage/job-cards/:id'), context(), async (req, res) => send(res, await jobs.detail(req.business, req.params.id)));
  router.patch(b('/garage/job-cards/:id'), context('garage.edit'), async (req, res) => send(res, await jobs.updateDetails(req.business, req.user, req.params.id, req.body)));
  router.put(b('/garage/job-cards/:id/mechanics'), context('garage.edit'), async (req, res) => send(res, await jobs.setMechanics(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/job-cards/:id/estimate/preview'), context('garage.edit'), async (req, res) => send(res, await estimates.preview(req.business, req.user, req.params.id, req.body)));
  router.put(b('/garage/job-cards/:id/estimate'), context('garage.edit'), async (req, res) => send(res, await estimates.save(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/job-cards/:id/parts'), context('garage.edit'), async (req, res) => send(res, await estimates.addParts(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/job-cards/:id/work'), context('garage.edit'), async (req, res) => send(res, await estimates.recordWork(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/job-cards/:id/status'), context('garage.edit'), async (req, res) => send(res, await jobs.setStatus(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/job-cards/:id/approvals'), context('garage.edit'), async (req, res) => send(res, await jobs.approve(req.business, req.user, req.params.id, req.body), 201));
  router.put(b('/garage/job-cards/:id/claim'), context('garage.edit'), async (req, res) => send(res, await estimates.saveClaim(req.business, req.user, req.params.id, req.body)));
  router.delete(b('/garage/job-cards/:id/claim'), context('garage.edit'), async (req, res) => send(res, await estimates.removeClaim(req.business, req.user, req.params.id)));
  router.post(b('/garage/job-cards/:id/advance'), context('garage.edit'), async (req, res) => send(res, await jobs.takeAdvance(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/job-cards/:id/bill'), context('garage.edit'), async (req, res) => send(res, await billing.bill(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/job-cards/:id/cancel'), context('garage.cancel'), async (req, res) => send(res, await jobs.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/job-cards/:id/advance-refund'), context('sales.edit'), async (req, res) => send(res, await jobs.refundAdvance(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/job-cards/:id/messages'), context('garage.view'), async (req, res) => send(res, await jobs.logMessage(req.business, req.user, req.params.id, req.body), 201));

  // Vehicles due for a service, insurance or PUC; the garage's settings.
  list('/garage/service-due', 'garage-service-due', 'garage.view');
  router.get(b('/garage/settings'), context('garage.view'), async (req, res) => send(res, await reminders.settings(req.business)));
  router.put(b('/garage/settings'), context('settings.edit'), async (req, res) => send(res, await reminders.saveSettings(req.business, req.user, req.body)));
};
