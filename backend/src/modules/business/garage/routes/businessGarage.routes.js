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
const parts = require('../services/garageParts.service');
const files = require('../services/garageFiles.service');
const work = require('../services/garageWork.service');
const claims = require('../services/garageClaims.service');
const commission = require('../services/garageCommission.service');
const plans = require('../services/garagePlans.service');

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
//                                          the inspection, notes, the road test, parts
//                                          issued and brought back, the claim's
//                                          progress, the insurer's payments and its
//                                          short payment, the gate pass, a quotation
//                                          as the estimate
//   /:businessId/garage/bookings           service bookings a job card may be opened from
//   /:businessId/garage/part-fitments…     the makes and models each part fits (and a CSV import)
//   /:businessId/garage/parts…             newer numbers, interchangeable groups, substitutes
//   /:businessId/garage/service-due        vehicles due for a service, insurance or PUC
//   /:businessId/garage/settings           the months and km to the next service, the claim-share item,
//                                          issuing parts and the road test
//   /:businessId/garage/plans…             service plans by model or engine
//   /:businessId/garage/commission…        mechanics' commission: rates, the report, payouts
// (Photos are uploaded and opened through garageUploads.routes.js, mounted
// before this router: it takes files.)
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
  // Who reads parts' fitment and substitutes: whoever sells or works on job cards.
  const PART_READERS = ['garage.view', 'garage.edit', 'sales.create', 'catalog.view'];
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
  // The parts that fit a vehicle (in stock first, with substitutes for those out of stock).
  router.get(b('/garage/vehicles/:id/parts'), context(PART_READERS), async (req, res) => send(res, await parts.fits(req.business, req.params.id, req.query)));
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
  router.get(b('/garage/job-cards/:id/quotations'), context('quotations.view'), async (req, res) => send(res, await estimates.quotationsFor(req.business, req.params.id)));
  router.post(b('/garage/job-cards/:id/estimate/quotation'), context('garage.edit'), async (req, res) => send(res, await estimates.fromQuotation(req.business, req.user, req.params.id, req.body)));
  // The inspection, a mechanic's notes, the road test, parts issued and brought back, the vehicle leaving.
  router.post(b('/garage/job-cards/:id/inspection'), context('garage.edit'), async (req, res) => send(res, await files.addItem(req.business, req.user, req.params.id, req.body), 201));
  router.delete(b('/garage/job-cards/:id/inspection/:itemId'), context('garage.edit'), async (req, res) => send(res, await files.removeItem(req.business, req.user, req.params.id, req.params.itemId)));
  router.post(b('/garage/job-cards/:id/notes'), context('garage.edit'), async (req, res) => send(res, await work.note(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/job-cards/:id/road-tests'), context('garage.edit'), async (req, res) => send(res, await work.roadTest(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/job-cards/:id/issues'), context('inventory.edit'), async (req, res) => send(res, await work.issue(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/job-cards/:id/issues/back'), context('inventory.edit'), async (req, res) => send(res, await work.bringBack(req.business, req.user, req.params.id, req.body), 201));
  router.put(b('/garage/job-cards/:id/old-parts'), context('garage.edit'), async (req, res) => send(res, await work.oldParts(req.business, req.user, req.params.id, req.body)));
  router.post(b('/garage/job-cards/:id/gate-pass/left'), context(['garage.view', 'garage.edit']), async (req, res) => send(res, await work.vehicleLeft(req.business, req.user, req.params.id, req.body)));
  // The claim's progress, the insurer's payments, and what it did not pay.
  router.post(b('/garage/job-cards/:id/claim/steps'), context('garage.edit'), async (req, res) => send(res, await claims.step(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/job-cards/:id/claim/payments'), context('sales.edit'), async (req, res) => send(res, await claims.insurerPayment(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/garage/job-cards/:id/claim/settle'), context('garage.view'), async (req, res) => send(res, await claims.settleShort(req.business, req.user, req.params.id, req.body), 201));
  router.get(b('/garage/bookings'), context('garage.create'), async (req, res) => send(res, await jobs.openBookings(req.business)));

  // Parts: fitment (typed or imported), newer numbers, interchangeable groups and substitutes.
  list('/garage/part-fitments', 'garage-part-fitments', PART_READERS);
  router.get(b('/garage/part-fitments/import-guide'), context('catalog.edit'), async (req, res) => { parts.listCheck(req.business); send(res, parts.importGuide()); });
  router.post(b('/garage/part-fitments/import'), context('catalog.edit'), async (req, res) => send(res, await parts.importFitments(req.business, req.user, req.body)));
  router.post(b('/garage/part-fitments'), context('catalog.edit'), async (req, res) => send(res, await parts.addFitment(req.business, req.user, req.body), 201));
  router.delete(b('/garage/part-fitments/:id'), context('catalog.edit'), async (req, res) => send(res, await parts.removeFitment(req.business, req.user, req.params.id)));
  list('/garage/part-links', 'garage-part-links', PART_READERS);
  router.get(b('/garage/part-groups'), context(PART_READERS), async (req, res) => send(res, await parts.groups(req.business)));
  router.put(b('/garage/parts/:skuId'), context('catalog.edit'), async (req, res) => send(res, await parts.setPart(req.business, req.user, req.params.skuId, req.body)));
  router.get(b('/garage/parts/:skuId/substitutes'), context(PART_READERS), async (req, res) => send(res, await parts.substitutes(req.business, req.params.skuId, req.query)));

  // Vehicles due for a service, insurance or PUC; the garage's settings.
  list('/garage/service-due', 'garage-service-due', 'garage.view');
  router.get(b('/garage/settings'), context('garage.view'), async (req, res) => send(res, await reminders.settings(req.business)));
  router.put(b('/garage/settings'), context('settings.edit'), async (req, res) => send(res, await reminders.saveSettings(req.business, req.user, req.body)));
  // Service plans by model or engine.
  router.get(b('/garage/plans'), context('garage.view'), async (req, res) => send(res, await plans.list(req.business)));
  router.post(b('/garage/plans'), context('settings.edit'), async (req, res) => send(res, await plans.save(req.business, req.user, req.body), 201));
  router.patch(b('/garage/plans/:id'), context('settings.edit'), async (req, res) => send(res, await plans.save(req.business, req.user, req.body, req.params.id)));
  // Mechanics' commission on labour: rates, the report, a mechanic's lines and payouts.
  router.get(b('/garage/commission/rates'), context(['settings.view', 'reports.view', 'garage.approve']), async (req, res) => send(res, await commission.rates(req.business)));
  router.put(b('/garage/commission/rates'), context('settings.edit'), async (req, res) => send(res, await commission.setRate(req.business, req.user, req.body)));
  router.get(b('/garage/commission'), context('reports.view'), async (req, res) => send(res, await commission.report(req.business, req.query)));
  router.get(b('/garage/commission/:userId'), context('reports.view'), async (req, res) => send(res, await commission.lines(req.business, req.params.userId, req.query)));
  router.post(b('/garage/commission/:userId/payouts'), context('garage.approve'), async (req, res) => send(res, await commission.payout(req.business, req.user, req.params.userId, req.body), 201));
};
