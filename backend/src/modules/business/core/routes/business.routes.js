const express = require('express');
const authenticate = require('../../../../middlewares/authenticate');
const service = require('../services/business.service');
const access = require('../services/businessAccess.service');
const returns = require('../services/businessReturns.service');
const stock = require('../services/businessStock.service');
const setup = require('../services/businessSetup.service');
const takings = require('../services/businessTakings.service');
const payables = require('../services/businessPayables.service');
const notifications = require('../services/businessNotifications.service');
const branches = require('../services/businessBranches.service');
const onboarding = require('../services/businessOnboarding.service');
const paymentMethods = require('../services/businessPaymentMethods.service');
const expenses = require('../services/businessExpenses.service');
const cashChecks = require('../services/businessCashChecks.service');
const branchPrices = require('../services/businessLocationPrices.service');
const departments = require('../services/businessDepartments.service');
const shifts = require('../services/businessShifts.service');
const overviewData = require('../services/businessOverview.service');
const counter = require('../services/businessCounter.service');
const imports = require('../services/businessImports.service');
const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');

// Business Admin API. Every route under /:businessId first loads the
// caller's membership (404 when there is none), then checks the module is
// switched on and the role holds the permission (403 otherwise). Services
// repeat the permission check for actions that depend on the record (a sale
// versus a purchase), so the rule holds whichever way a service is called.

const router = express.Router();
router.use(authenticate);
router.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return next(new AppError(400, 'A JSON object is required'));
  }
  next();
});
const send = (res, data, status = 200) => res.status(status).json({ success: true, data });
router.get('/', async (req, res) => send(res, await service.list(req.user)));
// An owner adds another business of their own (any type but restaurant).
router.post('/', async (req, res) => send(res, await onboarding.ownerCreate(req.user, req.body), 201));
router.post('/link-restaurant', async (req, res) => send(res, await service.linkRestaurant(req.user)));
// An owner's GST thresholds across their businesses (modules/gst-thresholds): the owner's view and its warning level.
require('../../../gst-thresholds/routes/gstThresholds.routes').ownerRoutes(router, { send });

// permission: one code, a list (any of them), or none (any member).
// Opening the business lets GST rate changes whose date has come take effect first.
const context = (permission) => async (req, res, next) => {
  req.business = await access.open(req.user, req.params.businessId);
  // A person tied to one location works there only; a branch picked in the top bar fills in the location a request leaves out.
  access.scope(req, req.business);
  if (Array.isArray(permission)) await access.requireAny(req.business, permission);
  else if (permission) await access.require(req.business, permission);
  next();
};
const b = (path) => `/:businessId${path}`;

router.get(b('/context'), context(), async (req, res) => send(res, await access.context(req.business)));
// The switcher records the business a person last opened, so they return to it.
router.post(b('/open'), context(), async (req, res) => { await repo.markOpened(req.business.id, req.user.id); send(res, { opened: req.business.id }); });
// Each overview figure is sent only to someone allowed to see what it adds up.
const SUMMARY_FIGURES = {
  skus: 'catalog.view', contacts: 'contacts.view', locations: null,
  sales_today: 'sales.view', sales_month: 'sales.view', sales: 'sales.view', receivables: 'sales.view', receivables_owed: 'sales.view', receivables_advances: 'sales.view', receivables_walk_in: 'sales.view', payables: 'purchasing.view',
  low_stock: 'inventory.view', expiring_soon: 'inventory.view', transfers_in_transit: 'stock_transfers.view', counts_open: 'stock_counts.view',
  appointments_today: 'appointments.view', appointments_upcoming: 'appointments.view',
};
router.get(b('/summary'), context(), async (req, res) => {
  const [all, today] = await Promise.all([repo.summary(req.business.id, req.business.location_scope), takings.today(req.business)]);
  const figures = { ...SUMMARY_FIGURES, ...takings.TODAY_FIGURES };
  const values = { ...all, ...today };
  send(res, Object.fromEntries(Object.entries(figures)
    .filter(([key, permission]) => key in values && (!permission || access.can(req.business, permission))).map(([key]) => [key, values[key]])));
});
// The Overview's picture of the day (each part only for those allowed to see it).
router.get(b('/overview'), context(), async (req, res) => send(res, await overviewData.overview(req.business)));
// The bell: alerts worked out from live data, each only to those allowed to see it.
router.get(b('/notifications'), context(), async (req, res) => send(res, await notifications.feed(req.business)));
router.get(b('/reports'), context('reports.view'), async (req, res) => send(res, await service.reports(req.business, req.query)));
// Branch comparison: every location side by side for a period.
router.get(b('/reports/locations'), context('reports.view'), async (req, res) => send(res, await branches.compare(req.business, req.query)));
// Day close: takings by payment method, person and counter (read-only).
router.get(b('/reports/takings'), context(['reports.view', 'sales.view']), async (req, res) => send(res, await takings.takings(req.business, req.query)));
router.get(b('/expenses'), context('expenses.view'), async (req,res) => send(res,await expenses.list(req.business,req.query)));
router.post(b('/expenses'), context('expenses.create'), async (req,res) => send(res,await expenses.create(req.business,req.user,req.body),201));
router.post(b('/expenses/:expenseId/reverse'), context('expenses.approve'), async (req,res) => send(res,await expenses.reverse(req.business,req.user,req.params.expenseId,req.body)));
router.get(b('/cash-checks'),context(['reports.view','sales.view']),async(req,res)=>send(res,await cashChecks.list(req.business,req.query)));
router.post(b('/cash-checks'),context('reports.edit'),async(req,res)=>send(res,await cashChecks.create(req.business,req.user,req.body),201));

// Retail completion: a price per branch, departments, cashier shifts.
router.get(b('/catalog/:id/branch-prices'), context('catalog.view'), async (req, res) => send(res, await branchPrices.forItem(req.business, req.params.id)));
router.put(b('/catalog/:id/branch-prices'), context('catalog.edit'), async (req, res) => send(res, await branchPrices.save(req.business, req.user, req.params.id, req.body)));
router.get(b('/branch-prices'), context(['sales.create', 'catalog.view']), async (req, res) => send(res, await branchPrices.forLocation(req.business, req.query)));
router.get(b('/departments'), context('catalog.view'), async (req, res) => send(res, await departments.list(req.business)));
router.post(b('/departments'), context('settings.edit'), async (req, res) => send(res, await departments.create(req.business, req.user, req.body), 201));
router.patch(b('/departments/:id'), context('settings.edit'), async (req, res) => send(res, await departments.update(req.business, req.user, req.params.id, req.body)));
router.get(b('/reports/departments'), context('reports.view'), async (req, res) => send(res, await departments.report(req.business, req.query)));
router.get(b('/shifts'), context('sales.create'), async (req, res) => send(res, await shifts.list(req.business, req.user, req.query)));
router.get(b('/shifts/current'), context('sales.create'), async (req, res) => send(res, await shifts.current(req.business, req.user, req.query)));
router.post(b('/shifts'), context('sales.create'), async (req, res) => send(res, await shifts.open(req.business, req.user, req.body), 201));
router.post(b('/shifts/:id/close'), context('sales.create'), async (req, res) => send(res, await shifts.close(req.business, req.user, req.params.id, req.body)));

// Lists: paging, search, period and the filters each list allows.
const listPermissions = {
  catalog: 'catalog.view', categories: 'catalog.view', units: 'catalog.view', 'pack-sizes': 'catalog.view',
  contacts: 'contacts.view', pricing: 'wholesale.view', locations: null, 'tax-rates': null, 'number-series': 'settings.view',
  resources: 'appointments.view', stock: 'inventory.view', movements: 'inventory.view', documents: ['sales.view', 'purchasing.view'],
  appointments: 'appointments.view', audit: 'audit.view', members: 'access.view', roles: 'access.view',
  transfers: 'stock_transfers.view', counts: 'stock_counts.view', 'supplier-payments': 'purchasing.view',
};
const readDate = (value, name) => (value === undefined || value === '' ? null : service.dateText(value, name));
for (const [name, permission] of Object.entries(listPermissions)) {
  router.get(b(`/${name}`), context(permission), async (req, res) => {
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    // The staff list shows everyone (people working at every location too)
    // unless a location is asked for, or the person is tied to one.
    const unscoped = name === 'members' && !req.business.location_tied ? new Set(req.locationFilledIn || []) : new Set();
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '' && !unscoped.has(key)) filters[key] = String(req.query[key]).slice(0, 60);
    // A person tied to a department sees that department's products and stock.
    if (req.business.member_department_id && ['catalog', 'stock'].includes(name)) filters.department = String(req.business.member_department_id);
    // A document list shows only the kinds this person may see.
    if (name === 'documents') {
      const kinds = ['sale', 'purchase'].filter((kind) => access.can(req.business, service.kindPermission(kind, 'view')));
      if (filters.kind && !kinds.includes(filters.kind)) await access.require(req.business, service.kindPermission(filters.kind, 'view'));
      filters.kind = filters.kind || kinds;
    }
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const from = readDate(req.query.from, 'From date'), to = readDate(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    const result = await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters });
    // Each person on the staff list says whether the caller manages them (Change and Password).
    if (name === 'members') await access.markManaged(req.business, result.items);
    send(res, result);
  });
}

// Settings, modules, tax rates, number series and locations.
router.get(b('/settings'), context('settings.view'), async (req, res) => send(res, await setup.getSettings(req.business)));
router.put(b('/settings'), context('settings.edit'), async (req, res) => send(res, await setup.updateSettings(req.business, req.user, req.body)));
router.get(b('/modules'), context(), async (req, res) => send(res, await setup.modules(req.business)));
router.put(b('/modules/:code'), context('settings.edit'), async (req, res) => send(res, await setup.setModule(req.business, req.user, req.params.code, req.body)));
router.post(b('/tax-rates'), context('settings.edit'), async (req, res) => send(res, await setup.createTaxRate(req.business, req.user, req.body), 201));
router.patch(b('/tax-rates/:id'), context('settings.edit'), async (req, res) => send(res, await setup.updateTaxRate(req.business, req.user, req.params.id, req.body)));
router.post(b('/number-series'), context('settings.edit'), async (req, res) => send(res, await setup.createSeries(req.business, req.user, req.body), 201));
router.patch(b('/number-series/:id'), context('settings.edit'), async (req, res) => send(res, await setup.updateSeries(req.business, req.user, req.params.id, req.body)));
// Payment methods the owner names (PhonePe, Sodexo…), each of a fixed kind. Any
// member lists those switched on (the counter offers them); ?all=true adds the
// switched-off ones for those who look after the settings.
router.get(b('/payment-methods'), context(), async (req, res) => send(res, await paymentMethods.list(req.business, req.query)));
router.post(b('/payment-methods'), context('settings.edit'), async (req, res) => send(res, await paymentMethods.create(req.business, req.user, req.body), 201));
router.patch(b('/payment-methods/:methodId'), context('settings.edit'), async (req, res) => send(res, await paymentMethods.update(req.business, req.user, req.params.methodId, req.body)));
router.post(b('/locations'), context('settings.edit'), async (req, res) => send(res, await service.createLocation(req.business, req.user, req.body), 201));
router.patch(b('/locations/:id'), context('settings.edit'), async (req, res) => send(res, await service.updateLocation(req.business, req.user, req.params.id, req.body)));

// Staff access and roles.
router.get(b('/permissions'), context('access.view'), async (req, res) => send(res, await access.permissionCatalogue(req.business)));
router.post(b('/roles'), context('access.edit'), async (req, res) => send(res, await access.createRole(req.business, req.user, req.body), 201));
router.patch(b('/roles/:id'), context('access.edit'), async (req, res) => send(res, await access.updateRole(req.business, req.user, req.params.id, req.body)));
router.get(b('/member-candidates'), context('access.edit'), async (req, res) => send(res, await access.memberCandidates(req.business, req.user)));
router.post(b('/members'), context('access.edit'), async (req, res) => send(res, await access.setMember(req.business, req.user, req.body), 201));
// A login of their own for a member of staff, and a new password for one.
router.post(b('/staff-accounts'), context('access.edit'), async (req, res) => send(res, await onboarding.createStaffAccount(req.business, req.user, req.body), 201));
router.post(b('/staff-accounts/:userId/password'), context('access.edit'), async (req, res) =>
  send(res, await onboarding.resetStaffPassword(req.business, req.user, req.params.userId, req.body)));

// Catalogue.
router.post(b('/catalog'), context('catalog.create'), async (req, res) => send(res, await service.createCatalog(req.business, req.user, req.body), 201));
router.patch(b('/catalog/:id'), context('catalog.edit'), async (req, res) => send(res, await service.updateCatalog(req.business, req.user, req.params.id, req.body)));
router.post(b('/categories'), context('catalog.create'), async (req, res) => send(res, await setup.createCategory(req.business, req.user, req.body), 201));
router.patch(b('/categories/:id'), context('catalog.edit'), async (req, res) => send(res, await setup.updateCategory(req.business, req.user, req.params.id, req.body)));
router.post(b('/units'), context('catalog.create'), async (req, res) => send(res, await setup.createUnit(req.business, req.user, req.body), 201));
router.patch(b('/units/:id'), context('catalog.edit'), async (req, res) => send(res, await setup.updateUnit(req.business, req.user, req.params.id, req.body)));
router.post(b('/pack-sizes'), context('catalog.edit'), async (req, res) => send(res, await setup.createPackSize(req.business, req.user, req.body), 201));
router.patch(b('/pack-sizes/:id'), context('catalog.edit'), async (req, res) => send(res, await setup.updatePackSize(req.business, req.user, req.params.id, req.body)));
router.post(b('/pricing'), context('wholesale.edit'), async (req, res) => send(res, await service.createPriceRule(req.business, req.user, req.body), 201));
router.delete(b('/pricing/:id'), context('wholesale.edit'), async (req, res) => send(res, await service.disablePriceRule(req.business, req.user, req.params.id)));
// Products from a CSV file: the columns and a template, then the check (dryRun) and the import (businessImports.service.js).
const answer = (res, { message, data }) => res.json({ success: true, message, data });
router.get(b('/catalog/import-guide'), context('catalog.create'), async (req, res) => send(res, await imports.guide(req.business, 'products')));
router.post(b('/catalog/import'), context('catalog.create'), async (req, res) => answer(res, await imports.importFile(req.business, req.user, 'products', req.body)));

// Contacts.
router.post(b('/contacts'), context('contacts.create'), async (req, res) => send(res, await service.createContact(req.business, req.user, req.body), 201));
router.patch(b('/contacts/:id'), context('contacts.edit'), async (req, res) => send(res, await service.updateContact(req.business, req.user, req.params.id, req.body)));
// Customers or suppliers (kind) from a CSV file, as products are.
router.get(b('/contacts/import-guide'), context('contacts.create'), async (req, res) => send(res, await imports.guide(req.business, imports.contactKind(req.query.kind))));
router.post(b('/contacts/import'), context('contacts.create'), async (req, res) =>
  answer(res, await imports.importFile(req.business, req.user, imports.contactKind(req.body.kind), req.body)));

// Sales and purchases (the service checks sales.* or purchasing.* by kind). A
// counter bill may carry its till switch's proof, good only in its own session.
router.post(b('/documents'), context(['sales.create', 'purchasing.create']), async (req, res) =>
  send(res, await service.document(req.business, req.user, req.body, { session: counter.sessionOf(req.get('authorization')) }), 201));
router.get(b('/documents/:id'), context(['sales.view', 'purchasing.view']), async (req, res) => send(res, await service.detail(req.business, req.params.id)));
router.post(b('/documents/:id/payments'), context(['sales.edit', 'purchasing.edit']), async (req, res) => send(res, await service.payment(req.business, req.user, req.params.id, req.body), 201));
router.post(b('/documents/:id/returns'), context(['sales.refund', 'purchasing.refund']), async (req, res) => send(res, await returns.createReturn(req.business, req.user, req.params.id, req.body), 201));
router.post(b('/documents/:id/refunds'), context(['sales.refund', 'purchasing.refund']), async (req, res) => send(res, await returns.refund(req.business, req.user, req.params.id, req.body), 201));

// What is owed to suppliers: the list, one supplier's account and statement,
// paying several receipts at once (oldest due first) and the vouchers.
router.get(b('/payables'), context('purchasing.view'), async (req, res) => send(res, await payables.payables(req.business, req.query)));
router.get(b('/suppliers/:contactId/account'), context('purchasing.view'), async (req, res) => send(res, await payables.account(req.business, req.params.contactId)));
router.get(b('/suppliers/:contactId/statement'), context('purchasing.view'), async (req, res) => send(res, await payables.statement(req.business, req.params.contactId, req.query)));
router.post(b('/suppliers/:contactId/payments'), context('purchasing.edit'), async (req, res) => send(res, await payables.pay(req.business, req.user, req.params.contactId, req.body), 201));
router.get(b('/supplier-payments/:id'), context('purchasing.view'), async (req, res) => send(res, await payables.paymentDetail(req.business, req.params.id)));

// Stock.
router.post(b('/stock/:id/adjustments'), context('inventory.edit'), async (req, res) => send(res, await returns.adjust(req.business, req.user, req.params.id, req.body), 201));
router.post(b('/transfers'), context('stock_transfers.create'), async (req, res) => send(res, await stock.createTransfer(req.business, req.user, req.body), 201));
router.get(b('/transfers/:id'), context('stock_transfers.view'), async (req, res) => send(res, await stock.transferDetail(req.business, req.params.id)));
router.post(b('/transfers/:id/receive'), context('stock_transfers.approve'), async (req, res) => send(res, await stock.receiveTransfer(req.business, req.user, req.params.id)));
router.post(b('/transfers/:id/cancel'), context('stock_transfers.cancel'), async (req, res) => send(res, await stock.cancelTransfer(req.business, req.user, req.params.id, req.body)));
router.post(b('/counts'), context('stock_counts.create'), async (req, res) => send(res, await stock.createCount(req.business, req.user, req.body), 201));
router.get(b('/counts/:id'), context('stock_counts.view'), async (req, res) => send(res, await stock.countDetail(req.business, req.params.id)));
router.patch(b('/counts/:id/lines'), context('stock_counts.create'), async (req, res) => send(res, await stock.enterCounts(req.business, req.user, req.params.id, req.body)));
router.post(b('/counts/:id/post'), context('stock_counts.approve'), async (req, res) => send(res, await stock.postCount(req.business, req.user, req.params.id, req.body)));
router.post(b('/counts/:id/cancel'), context('stock_counts.cancel'), async (req, res) => send(res, await stock.cancelCount(req.business, req.user, req.params.id, req.body)));

// Appointments.
router.post(b('/resources'), context('appointments.create'), async (req, res) => send(res, await service.resource(req.business, req.user, req.body), 201));
router.post(b('/appointments'), context('appointments.create'), async (req, res) => send(res, await service.appointment(req.business, req.user, req.body), 201));
router.patch(b('/appointments/:id'), context(['appointments.edit', 'appointments.cancel']), async (req, res) =>
  send(res, await service.appointmentStatus(req.business, req.user, req.params.id, req.body)));

// Trade routes: shared receivables and wholesale (routes/businessTrade.routes.js).
router.use(require('../../wholesale/routes/businessTrade.routes'));
// Retail: counter, udhaar, offers, loyalty, books, labels and reports.
require('../../retail/routes/businessRetail.routes')(router, { context, send, b });
// Fashion and electronics: size × colour matrix, exchanges, serials, warranties, repairs.
require('../../fashion-electronics/routes/businessFashionElectronics.routes')(router, { context, send, b });
// Salon & spa and weight-based shops: calendar, deposits, packages, memberships, commissions, cutting, wastage.
require('../../salon-weight/routes/businessSalonWeight.routes')(router, { context, send, b });
// Pharmacy, clinic and lab: drug master, prescriptions, registers, patients, consultations, lab.
require('../../health/routes/businessHealth.routes')(router, { context, send, b });
// Quotations (every type but a restaurant): estimates that become bills or sales orders.
require('../../quotations/routes/businessQuotations.routes')(router, { context, send, b });
// Hardware, paints & building materials: sites, today's rates, fitters' commission.
require('../../hardware/routes/businessHardware.routes')(router, { context, send, b });
// Licences & registrations (every type but a restaurant): each location's licences and their dates.
require('../../licences/routes/businessLicences.routes')(router, { context, send, b });
// Seeds, fertilisers & pesticides: molecules, farmers and village dues, the subsidy PoS reconciliation, registers.
require('../../agri/routes/businessAgri.routes')(router, { context, send, b });
// Optical shops: prescriptions, spectacle orders through the lab and the quality check, the recall list, contact-lens power grids.
require('../../optical/routes/businessOptical.routes')(router, { context, send, b });
// Garages: vehicles and their owners, the odometer log, job cards from the estimate to the bills (the insurer's and the owner's), service reminders.
require('../../garage/routes/businessGarage.routes')(router, { context, send, b });
// Gyms, studios and coaching: plans, memberships with their pro-rata credits and refunds, check-ins, instalments, renewals.
require('../../memberships/routes/businessMemberships.routes')(router, { context, send, b });
// Laundries and dry cleaners: the price list, garment orders with a tag on each garment from intake to the racks and the handover, unclaimed orders, damage claims.
require('../../laundry/routes/businessLaundry.routes')(router, { context, send, b });
// Jewellery shops: today's rates with the rate board, tagged pieces, the jewellery bill with the HUID check, old gold, gold schemes, the cash report.
require('../../jewellery/routes/businessJewellery.routes')(router, { context, send, b });
// Rental and hire businesses: items hired one by one or from a pool, bookings checked against what is free, the handover, returns with late fees and charges, deposits held.
require('../../rentals/routes/businessRentals.routes')(router, { context, send, b });
// Fuel stations: fuels under state VAT, tanks, dispensing units and nozzles, the price in force, shifts with their readings and settlement posted as fuel bills, dips, tanker receipts, the stock and density registers, fleet statements.
require('../../fuel/routes/businessFuel.routes')(router, { context, send, b });
// Hotels, lodges and guest houses: room types and rates, rooms and housekeeping, reservations and stays with every occupant, Form-III, the night audit, the folio billed at check-out, the guest register.
require('../../lodging/routes/businessLodging.routes')(router, { context, send, b });

// Per-staff PIN at the counter, kits / bundles, EMI & finance.
require('./businessCounter.routes')(router, { context, send, b });
// GST rate changes by date (every type but a restaurant, whose menu has its own): the yearly change, an item's GST history.
require('../../../tax-changes/routes/taxChanges.routes').businessRoutes(router, { context, send, b });
// Personal data (one module for both engines): the notice, consents, requests and breaches.
require('../../../personal-data/routes/personalData.routes').businessRoutes(router, { context, send, b });
// An owner's GST thresholds (one module for both engines): the PAN an owner records, the HSN / SAC codes to fix.
require('../../../gst-thresholds/routes/gstThresholds.routes').businessRoutes(router, { context, send, b });

// Scoped constraint failures are the person's conflict, not a server fault.
router.use((error, req, res, next) => {
  if (error.code === '23505') return next(new AppError(409, 'This code, name, number or request already exists in this business'));
  if (error.code === '23503') return next(new AppError(400, 'A related record is not available in this business'));
  // Rules raised by the database's own triggers carry a sentence meant for people.
  if (error.code === '23514' && !error.constraint) return next(new AppError(409, error.message));
  if (error.code === '23514') return next(new AppError(400, 'A value is outside what this business allows'));
  next(error);
});
module.exports = router;
