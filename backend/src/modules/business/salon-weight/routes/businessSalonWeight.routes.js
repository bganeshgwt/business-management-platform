const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const salon = require('../services/businessSalon.service');
const weight = require('../services/businessWeight.service');
const desk = require('../services/businessSalonDesk.service');
const daily = require('../services/businessWeightDaily.service');
const backOffice = require('../services/businessSalonBackOffice.service');
const pins = require('../services/businessManagerPin');

// Salon & spa and weight-based shop routes, added to the Business
// Admin router so they share its login, membership, module and permission
// checks (context) and its database-error translation:
//   /:businessId/salon/…    booking rules, service times, stylists & rooms, calendar,
//                           bookings with deposits, the salon bill, packages,
//                           memberships and staff commissions
//   /:businessId/weight/…   stock by weight, yield templates, cutting batches,
//                           daily wastage, yield and wastage reports
// Services repeat every permission check.

module.exports = function salonWeightRoutes(router, { context, send, b }) {
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
  const isSalon = (business) => salon.requireSalon(business);
  const packagesOn = (business) => {
    isSalon(business);
    if (!business.modules.includes('packages')) throw new AppError(403, 'Packages & memberships is not switched on for this business. An owner can turn it on in Settings › Business tools.');
  };

  // Salon: rules, services, stylists and rooms.
  router.get(b('/salon/settings'), context(['appointments.view', 'settings.view']), async (req, res) => send(res, await salon.getSettings(req.business)));
  router.put(b('/salon/settings'), context('settings.edit'), async (req, res) => send(res, await salon.saveSettings(req.business, req.user, req.body)));
  list('/salon/services', 'salon-services', 'catalog.view', isSalon);
  router.put(b('/salon/services/:skuId'), context('catalog.edit'), async (req, res) => send(res, await salon.saveService(req.business, req.user, req.params.skuId, req.body)));
  list('/salon/staff', 'salon-staff', 'appointments.view', isSalon);
  router.put(b('/salon/staff/:resourceId'), context('appointments.create'), async (req, res) => send(res, await salon.saveStaff(req.business, req.user, req.params.resourceId, req.body)));

  // Calendar and bookings.
  router.get(b('/salon/calendar'), context('appointments.view'), async (req, res) => send(res, await salon.calendar(req.business, req.query)));
  router.post(b('/salon/appointments'), context('appointments.create'), async (req, res) => send(res, await salon.book(req.business, req.user, req.body), 201));
  router.get(b('/salon/appointments/:appointmentId/fee'), context('appointments.view'), async (req, res) => send(res, await salon.preview(req.business, req.params.appointmentId, req.query.status)));
  router.post(b('/salon/appointments/:appointmentId/status'), context(['appointments.edit', 'appointments.cancel']), async (req, res) =>
    send(res, await salon.setStatus(req.business, req.user, req.params.appointmentId, req.body)));

  // The salon bill.
  router.get(b('/salon/clients/:contactId'), context(['sales.create', 'appointments.view']), async (req, res) => send(res, await salon.client(req.business, req.params.contactId)));
  router.post(b('/salon/quote'), context('sales.create'), async (req, res) => send(res, await salon.quote(req.business, req.user, req.body)));
  router.post(b('/salon/bills'), context('sales.create'), async (req, res) => send(res, await salon.bill(req.business, req.user, req.body), 201));

  // Packages and memberships.
  list('/salon/plans', 'salon-plans', 'packages.view', packagesOn);
  router.post(b('/salon/plans'), context('packages.create'), async (req, res) => send(res, await salon.createPlan(req.business, req.user, req.body), 201));
  router.patch(b('/salon/plans/:planId'), context('packages.edit'), async (req, res) => send(res, await salon.updatePlan(req.business, req.user, req.params.planId, req.body)));
  list('/salon/client-plans', 'salon-client-plans', 'packages.view', packagesOn);
  router.post(b('/salon/client-plans/:clientPlanId/cancel'), context('packages.edit'), async (req, res) => send(res, await salon.cancelClientPlan(req.business, req.user, req.params.clientPlanId, req.body)));

  // Staff commissions.
  list('/salon/commission-rules', 'salon-commission-rules', 'commissions.view', isSalon);
  router.post(b('/salon/commission-rules'), context('commissions.edit'), async (req, res) => send(res, await salon.createRule(req.business, req.user, req.body), 201));
  router.patch(b('/salon/commission-rules/:ruleId'), context('commissions.edit'), async (req, res) => send(res, await salon.updateRule(req.business, req.user, req.params.ruleId, req.body)));
  router.get(b('/salon/commissions'), context('commissions.view'), async (req, res) => send(res, await salon.commissionReport(req.business, req.query)));
  list('/salon/commission-lines', 'salon-commission-lines', 'commissions.view', isSalon);

  // Weight-based shops.
  const weighs = (business) => {
    if (!business.modules.includes('weight')) throw new AppError(403, 'Sold by weight is not switched on for this business. An owner can turn it on in Settings › Business tools.');
  };
  list('/weight/stock', 'weight-stock', 'inventory.view', weighs);
  list('/weight/yield-templates', 'weight-yield-templates', 'processing.view');
  router.post(b('/weight/yield-templates'), context('processing.edit'), async (req, res) => send(res, await weight.createTemplate(req.business, req.user, req.body), 201));
  router.patch(b('/weight/yield-templates/:templateId'), context('processing.edit'), async (req, res) => send(res, await weight.updateTemplate(req.business, req.user, req.params.templateId, req.body)));
  list('/weight/processing', 'weight-processing', 'processing.view');
  router.post(b('/weight/processing'), context('processing.create'), async (req, res) => send(res, await weight.processBatch(req.business, req.user, req.body), 201));
  router.get(b('/weight/processing/:batchId'), context('processing.view'), async (req, res) => send(res, await weight.batchDetail(req.business, req.params.batchId)));
  list('/weight/wastage', 'weight-wastage', 'wastage.view');
  router.get(b('/weight/wastage-today'), context('wastage.view'), async (req, res) => send(res, await weight.wastageToday(req.business)));
  router.post(b('/weight/wastage'), context('wastage.create'), async (req, res) => send(res, await weight.recordWastage(req.business, req.user, req.body), 201));
  router.get(b('/weight/reports/yield'), context('reports.view'), async (req, res) => send(res, await weight.yieldReport(req.business, req.query)));
  router.get(b('/weight/reports/wastage'), context('reports.view'), async (req, res) => send(res, await weight.wastageReport(req.business, req.query)));

  // Salon front desk: move, arrive, messages, walk-ins, the client card,
  // stylist leave, package holders, commission payouts, history.
  router.patch(b('/salon/appointments/:appointmentId'), context('appointments.edit'), async (req, res) => send(res, await desk.move(req.business, req.user, req.params.appointmentId, req.body)));
  router.post(b('/salon/appointments/:appointmentId/arrived'), context('appointments.edit'), async (req, res) => send(res, await desk.arrive(req.business, req.user, req.params.appointmentId)));
  router.post(b('/salon/appointments/:appointmentId/messages'), context(['appointments.create', 'appointments.edit']), async (req, res) =>
    send(res, await desk.messageSent(req.business, req.user, req.params.appointmentId, req.body)));
  list('/salon/appointments', 'salon-appointments', 'appointments.view', isSalon);
  list('/salon/walk-ins', 'salon-walk-ins', 'appointments.view', isSalon);
  router.post(b('/salon/walk-ins'), context('appointments.create'), async (req, res) => send(res, await desk.addWalkIn(req.business, req.user, req.body), 201));
  router.post(b('/salon/walk-ins/:walkInId/seat'), context('appointments.create'), async (req, res) => send(res, await desk.seatWalkIn(req.business, req.user, req.params.walkInId, req.body)));
  router.post(b('/salon/walk-ins/:walkInId/left'), context('appointments.create'), async (req, res) => send(res, await desk.walkInLeft(req.business, req.user, req.params.walkInId)));
  router.put(b('/salon/clients/:contactId/profile'), context('contacts.edit'), async (req, res) => send(res, await desk.saveProfile(req.business, req.user, req.params.contactId, req.body)));
  router.post(b('/salon/clients/:contactId/notes'), context('contacts.edit'), async (req, res) => send(res, await desk.addNote(req.business, req.user, req.params.contactId, req.body), 201));
  router.post(b('/salon/staff/:resourceId/leave'), context('appointments.create'), async (req, res) => send(res, await desk.addLeave(req.business, req.user, req.params.resourceId, req.body), 201));
  router.post(b('/salon/staff/:resourceId/leave/:leaveId/cancel'), context('appointments.create'), async (req, res) =>
    send(res, await desk.cancelLeave(req.business, req.user, req.params.resourceId, req.params.leaveId)));
  router.patch(b('/salon/client-plans/:clientPlanId'), context('packages.edit'), async (req, res) => send(res, await desk.extendClientPlan(req.business, req.user, req.params.clientPlanId, req.body)));
  router.get(b('/salon/client-plans-summary'), context('packages.view'), async (req, res) => send(res, await desk.planTotals(req.business)));
  list('/salon/plan-usage', 'salon-plan-usage', 'packages.view', packagesOn);
  list('/salon/commission-payouts', 'salon-commission-payouts', 'commissions.view', isSalon);
  router.post(b('/salon/commission-payouts'), context('commissions.edit'), async (req, res) => send(res, await salon.payCommission(req.business, req.user, req.body), 201));

  // A weight shop's day: rates, today's stock, the weigh-up, wastage in one
  // go, cutting to order, orders for pickup, today's figures.
  router.get(b('/weight/rates'), context('catalog.view'), async (req, res) => send(res, await daily.rates(req.business)));
  router.put(b('/weight/rates'), context('catalog.edit'), async (req, res) => send(res, await daily.saveRates(req.business, req.user, req.body)));
  list('/weight/rate-history', 'weight-rate-history', 'catalog.view', weighs);
  router.get(b('/weight/stock-today'), context('inventory.view'), async (req, res) => send(res, await daily.stockToday(req.business, req.query)));
  router.post(b('/weight/day-close'), context('inventory.edit'), async (req, res) => send(res, await daily.closeDay(req.business, req.user, req.body), 201));
  list('/weight/day-closes', 'weight-day-closes', 'inventory.view', weighs);
  router.post(b('/weight/wastage/batch'), context('wastage.create'), async (req, res) => send(res, await daily.wastageBatch(req.business, req.user, req.body), 201));
  router.post(b('/weight/cut-to-order'), context(['processing.create', 'sales.create']), async (req, res) => send(res, await daily.cutToOrder(req.business, req.user, req.body), 201));
  list('/weight/pickup-orders', 'weight-pickup-orders', 'sales.view', weighs);
  router.post(b('/weight/pickup-orders'), context('sales.create'), async (req, res) => send(res, await daily.createPickup(req.business, req.user, req.body), 201));
  router.post(b('/weight/pickup-orders/:orderId/status'), context('sales.create'), async (req, res) => send(res, await daily.setPickupStatus(req.business, req.user, req.params.orderId, req.body)));
  // An order's advance (taken later than the order), and what is left of it handed back once the order is closed.
  router.post(b('/weight/pickup-orders/:orderId/advance'), context('sales.edit'), async (req, res) => send(res, await daily.pickupAdvance(req.business, req.user, req.params.orderId, req.body), 201));
  router.post(b('/weight/pickup-orders/:orderId/advance-refund'), context('sales.edit'), async (req, res) =>
    send(res, await daily.refundPickupAdvance(req.business, req.user, req.params.orderId, req.body), 201));
  router.get(b('/weight/today'), context('inventory.view'), async (req, res) => send(res, await daily.today(req.business)));

  // Salon back office: the stylist's week, holidays, back-bar products,
  // service profitability, advance refunds / wallet, slab commission plans.
  router.put(b('/salon/staff/:resourceId/week'), context('appointments.create'), async (req, res) => send(res, await backOffice.saveWeek(req.business, req.user, req.params.resourceId, req.body)));
  list('/salon/holidays', 'salon-holidays', 'appointments.view', isSalon);
  router.post(b('/salon/holidays'), context('settings.edit'), async (req, res) => send(res, await backOffice.addHoliday(req.business, req.user, req.body), 201));
  router.post(b('/salon/holidays/:holidayId/cancel'), context('settings.edit'), async (req, res) => send(res, await backOffice.cancelHoliday(req.business, req.user, req.params.holidayId)));
  // Who may approve: a salon's bookings and refunds, a repair's refund, a weight shop's advance handed back.
  router.get(b('/service-approvers'), context(['appointments.create', 'sales.edit', 'repairs.view']), async (req, res) => {
    if (req.business.business_type !== 'salon' && !req.business.modules.includes('repairs') && !req.business.modules.includes('weight')) throw new AppError(404, 'Not found');
    send(res, await pins.approvers(req.business, String(req.query.permission || '')));
  });
  router.get(b('/salon/services/:skuId/products'), context('catalog.view'), async (req, res) => send(res, await backOffice.recipe(req.business, req.params.skuId)));
  router.put(b('/salon/services/:skuId/products'), context('catalog.edit'), async (req, res) => send(res, await backOffice.saveRecipe(req.business, req.user, req.params.skuId, req.body)));
  list('/salon/backbar-usage', 'salon-backbar-usage', 'reports.view', isSalon);
  router.get(b('/salon/reports/service-profitability'), context('reports.view'), async (req, res) => send(res, await backOffice.serviceProfitability(req.business, req.query)));
  router.post(b('/salon/clients/:contactId/advance-refund'), context('sales.edit'), async (req, res) => send(res, await backOffice.advanceRefund(req.business, req.user, req.params.contactId, req.body), 201));
  list('/salon/advance-refunds', 'salon-advance-refunds', 'sales.view', isSalon);
  list('/salon/commission-plans', 'salon-commission-plans', 'commissions.view', isSalon);
  router.post(b('/salon/commission-plans'), context('commissions.edit'), async (req, res) => send(res, await backOffice.createCommissionPlan(req.business, req.user, req.body), 201));
  router.patch(b('/salon/commission-plans/:planId'), context('commissions.edit'), async (req, res) => send(res, await backOffice.updateCommissionPlan(req.business, req.user, req.params.planId, req.body)));
  router.get(b('/salon/commission-schemes'), context('commissions.view'), async (req, res) => send(res, await backOffice.schemes(req.business)));
  router.put(b('/salon/staff/:resourceId/commission-scheme'), context('commissions.edit'), async (req, res) => send(res, await backOffice.setScheme(req.business, req.user, req.params.resourceId, req.body)));
  router.get(b('/salon/commission-statement'), context('commissions.view'), async (req, res) => send(res, await backOffice.statement(req.business, req.query)));

  return router;
};
