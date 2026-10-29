const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const { requireFuel } = require('../services/fuelCommon');
const setup = require('../services/fuelSetup.service');
const shifts = require('../services/fuelShifts.service');
const tanks = require('../services/fuelTanks.service');
const fleet = require('../services/fuelFleet.service');
const attendants = require('../services/fuelAttendants.service');
const records = require('../services/fuelRecords.service');

// Fuel stations, added to the Business Admin router so they share its login,
// membership, module and permission checks (context) and its database-error
// translation:
//   /:businessId/fuel/setup|products|tanks|dispensers|nozzles|measures   the forecourt's set-up: fuels on the GST nil slab, tanks,
//                                                                        dispensing units with their stamping, nozzles, meter changes,
//                                                                        the stamped measures
//   /:businessId/fuel/prices|settings                                    the price in force at each outlet; the tolerances
//   /:businessId/fuel/attendants|shifts…                                 the day's board, opening a shift, its nozzles, the close (with a
//                                                                        preview) posting the fuel bills, a manager's reopening
//   /:businessId/fuel/dips|receipts…|register|density                    the morning dips, tanker receipts with the density check, the
//                                                                        stock register and the density register
//   /:businessId/fuel/vehicles|fleet…|indent-books                       fleet customers' vehicles, the month's fills, statements, terms
//                                                                        (billed per shift or by the month), the month's invoice,
//                                                                        interest on overdue credit, slip books by serial
//   /:businessId/fuel/attendant-accounts…                                shorts due from attendants, excess held; payments, deductions,
//                                                                        excess taken to income
//   /:businessId/fuel/samples|tanks/:id/chart|register/corrections       retention samples, dip charts, a register day posted to the stock
//   /:businessId/fuel/inspections|sales-register|outlets                 the inspection log, the daily sales register, every outlet
// Another type of business never has the module, so `context` refuses it (the
// set-up behind the catalogue and settings permissions: the service, after
// `context` checks those); the services repeat every check and answer 404 for
// another type. Readings, dips and densities are typed in: nothing here talks
// to a dispenser, a forecourt controller or a tank gauge.

module.exports = function fuelRoutes(router, { context, send, b }) {
  // shape: what the caller's role sees of the page.
  const list = (path, name, permission, shape) => router.get(b(path), context(permission), async (req, res) => {
    requireFuel(req.business);
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

  // The forecourt's set-up.
  router.get(b('/fuel/setup'), context('fuel.view'), async (req, res) => send(res, await setup.setup(req.business)));
  router.post(b('/fuel/products'), context('catalog.edit'), async (req, res) => send(res, await setup.createProduct(req.business, req.user, req.body), 201));
  router.patch(b('/fuel/products/:id'), context('catalog.edit'), async (req, res) => send(res, await setup.updateProduct(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/tanks'), context('settings.edit'), async (req, res) => send(res, await setup.createTank(req.business, req.user, req.body), 201));
  router.patch(b('/fuel/tanks/:id'), context('settings.edit'), async (req, res) => send(res, await setup.updateTank(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/dispensers'), context('settings.edit'), async (req, res) => send(res, await setup.createDispenser(req.business, req.user, req.body), 201));
  router.patch(b('/fuel/dispensers/:id'), context('settings.edit'), async (req, res) => send(res, await setup.updateDispenser(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/dispensers/:id/nozzles'), context('settings.edit'), async (req, res) => send(res, await setup.addNozzle(req.business, req.user, req.params.id, req.body), 201));
  router.patch(b('/fuel/nozzles/:id'), context('settings.edit'), async (req, res) => send(res, await setup.updateNozzle(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/nozzles/:id/meter'), context('fuel.approve'), async (req, res) => send(res, await setup.changeMeter(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/fuel/measures'), context('settings.edit'), async (req, res) => send(res, await setup.createMeasure(req.business, req.user, req.body), 201));
  router.patch(b('/fuel/measures/:id'), context('settings.edit'), async (req, res) => send(res, await setup.updateMeasure(req.business, req.user, req.params.id, req.body)));
  router.get(b('/fuel/prices'), context('fuel.view'), async (req, res) => send(res, await setup.prices(req.business, req.query)));
  router.post(b('/fuel/prices'), context('catalog.edit'), async (req, res) => send(res, await setup.setPrices(req.business, req.user, req.body), 201));
  router.get(b('/fuel/settings'), context('fuel.view'), async (req, res) => send(res, await setup.settings(req.business)));
  router.put(b('/fuel/settings'), context('settings.edit'), async (req, res) => send(res, await setup.saveSettings(req.business, req.user, req.body)));

  // Shifts: the day's board, opening, the nozzles, the close and a manager's reopening.
  router.get(b('/fuel/attendants'), context('fuel.view'), async (req, res) => send(res, await shifts.attendants(req.business, req.user)));
  router.get(b('/fuel/shifts'), context('fuel.view'), async (req, res) => send(res, await shifts.list(req.business, req.user, req.query)));
  router.get(b('/fuel/shifts/day'), context('fuel.view'), async (req, res) => send(res, await shifts.day(req.business, req.user, req.query)));
  router.post(b('/fuel/shifts'), context('fuel.create'), async (req, res) => send(res, await shifts.open(req.business, req.user, req.body), 201));
  router.get(b('/fuel/shifts/:id'), context('fuel.view'), async (req, res) => send(res, await shifts.detail(req.business, req.user, req.params.id)));
  router.patch(b('/fuel/shifts/:id'), context('fuel.create'), async (req, res) => send(res, await shifts.updateNotes(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/shifts/:id/nozzles'), context('fuel.create'), async (req, res) => send(res, await shifts.addNozzle(req.business, req.user, req.params.id, req.body), 201));
  router.delete(b('/fuel/shifts/:id/nozzles/:nozzleId'), context('fuel.create'), async (req, res) =>
    send(res, await shifts.removeNozzle(req.business, req.user, req.params.id, req.params.nozzleId)));
  router.post(b('/fuel/shifts/:id/close/preview'), context('fuel.create'), async (req, res) => send(res, await shifts.preview(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/shifts/:id/close'), context('fuel.create'), async (req, res) => send(res, await shifts.close(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/shifts/:id/reopen'), context('fuel.approve'), async (req, res) => send(res, await shifts.reopen(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/shifts/:id/drops'), context('fuel.create'), async (req, res) => send(res, await shifts.addDrop(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/fuel/shifts/:id/drops/:dropId/cancel'), context('fuel.approve'), async (req, res) =>
    send(res, await shifts.cancelDrop(req.business, req.user, req.params.id, req.params.dropId, req.body)));

  // The attendants' accounts: shorts due, excess held, what was recovered and what went to income.
  router.get(b('/fuel/attendant-accounts'), context('fuel.view'), async (req, res) => send(res, await attendants.accounts(req.business, req.query)));
  router.get(b('/fuel/attendant-accounts/:userId'), context('fuel.view'), async (req, res) => send(res, await attendants.account(req.business, req.params.userId, req.query)));
  router.post(b('/fuel/attendant-accounts/:userId/pay'), context('fuel.edit'), async (req, res) => send(res, await attendants.pay(req.business, req.user, req.params.userId, req.body), 201));
  router.post(b('/fuel/attendant-accounts/:userId/deduct'), context('fuel.approve'), async (req, res) =>
    send(res, await attendants.deduct(req.business, req.user, req.params.userId, req.body), 201));
  router.post(b('/fuel/attendant-accounts/:userId/to-income'), context('fuel.approve'), async (req, res) =>
    send(res, await attendants.toIncome(req.business, req.user, req.params.userId, req.body), 201));

  // Tanks: the morning dips, tanker receipts, the stock register and the density register.
  router.get(b('/fuel/dips'), context('fuel.view'), async (req, res) => send(res, await tanks.dips(req.business, req.query)));
  router.post(b('/fuel/dips'), context('fuel.create'), async (req, res) => send(res, await tanks.takeDip(req.business, req.user, req.body), 201));
  router.patch(b('/fuel/dips/:id'), context('fuel.approve'), async (req, res) => send(res, await tanks.correctDip(req.business, req.user, req.params.id, req.body)));
  list('/fuel/receipts', 'fuel-receipts', 'fuel.view', tanks.listShape);
  router.post(b('/fuel/receipts'), context('fuel.create'), async (req, res) => send(res, await tanks.record(req.business, req.user, req.body), 201));
  router.get(b('/fuel/receipts/:id'), context('fuel.view'), async (req, res) => send(res, await tanks.receipt(req.business, req.params.id)));
  router.post(b('/fuel/receipts/:id/decant'), context('fuel.create'), async (req, res) => send(res, await tanks.decant(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/receipts/:id/cancel'), context('fuel.approve'), async (req, res) => send(res, await tanks.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/fuel/receipts/:id/samples'), context('fuel.create'), async (req, res) => send(res, await tanks.addSamples(req.business, req.user, req.params.id, req.body), 201));
  router.get(b('/fuel/samples'), context('fuel.view'), async (req, res) => send(res, await tanks.samples(req.business, req.query)));
  router.post(b('/fuel/samples/:id/dispose'), context('fuel.create'), async (req, res) => send(res, await tanks.disposeSample(req.business, req.user, req.params.id, req.body)));
  router.get(b('/fuel/register'), context('fuel.view'), async (req, res) => send(res, await tanks.register(req.business, req.query)));
  router.post(b('/fuel/register/corrections'), context('fuel.approve'), async (req, res) => send(res, await tanks.correctStock(req.business, req.user, req.body), 201));
  router.get(b('/fuel/density'), context('fuel.view'), async (req, res) => send(res, await tanks.density(req.business, req.query)));
  router.get(b('/fuel/tanks/:id/chart'), context('fuel.view'), async (req, res) => send(res, await tanks.chart(req.business, req.params.id)));
  router.put(b('/fuel/tanks/:id/chart'), context('settings.edit'), async (req, res) => send(res, await tanks.saveChart(req.business, req.user, req.params.id, req.body)));

  // Records: the inspection log, the daily sales register; every outlet at a glance.
  router.get(b('/fuel/inspections'), context('fuel.view'), async (req, res) => send(res, await records.inspections(req.business, req.query)));
  router.post(b('/fuel/inspections'), context('fuel.edit'), async (req, res) => send(res, await records.recordInspection(req.business, req.user, req.body), 201));
  router.get(b('/fuel/sales-register'), context('fuel.view'), async (req, res) => send(res, await records.salesRegister(req.business, req.query)));
  router.get(b('/fuel/outlets'), context('fuel.view'), async (req, res) => send(res, await records.outlets(req.business)));

  // Fleet customers: their vehicles, the month's fills and statements (money: for those who see sales).
  router.get(b('/fuel/vehicles'), context('fuel.view'), async (req, res) => send(res, await fleet.vehicles(req.business, req.query)));
  router.post(b('/fuel/vehicles'), context('fuel.edit'), async (req, res) => send(res, await fleet.createVehicle(req.business, req.user, req.body), 201));
  router.patch(b('/fuel/vehicles/:id'), context('fuel.edit'), async (req, res) => send(res, await fleet.updateVehicle(req.business, req.user, req.params.id, req.body)));
  router.get(b('/fuel/fleet'), context('fuel.view'), async (req, res) => send(res, await fleet.fleet(req.business, req.query)));
  router.get(b('/fuel/fleet/:contactId/statement'), context('fuel.view'), async (req, res) => send(res, await fleet.statement(req.business, req.params.contactId, req.query)));
  router.put(b('/fuel/fleet/:contactId/terms'), context('fuel.edit'), async (req, res) => send(res, await fleet.saveTerms(req.business, req.user, req.params.contactId, req.body)));
  router.post(b('/fuel/fleet/:contactId/invoice'), context('fuel.edit'), async (req, res) => send(res, await fleet.invoiceMonth(req.business, req.user, req.params.contactId, req.body), 201));
  router.get(b('/fuel/fleet/:contactId/interest'), context('fuel.view'), async (req, res) => send(res, await fleet.interest(req.business, req.params.contactId)));
  router.post(b('/fuel/fleet/:contactId/interest'), context('fuel.approve'), async (req, res) => send(res, await fleet.chargeInterest(req.business, req.user, req.params.contactId, req.body), 201));
  router.get(b('/fuel/indent-books'), context('fuel.view'), async (req, res) => send(res, await fleet.books(req.business, req.query)));
  router.post(b('/fuel/indent-books'), context('fuel.edit'), async (req, res) => send(res, await fleet.issueBook(req.business, req.user, req.body), 201));
  router.get(b('/fuel/indent-books/:id'), context('fuel.view'), async (req, res) => send(res, await fleet.book(req.business, req.params.id)));
  router.patch(b('/fuel/indent-books/:id'), context('fuel.edit'), async (req, res) => send(res, await fleet.updateBook(req.business, req.user, req.params.id, req.body)));
};
