const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const { requireLodging } = require('../services/lodgingCommon');
const setup = require('../services/lodgingSetup.service');
const stays = require('../services/lodgingStays.service');
const desk = require('../services/lodgingDesk.service');
const folio = require('../services/lodgingFolio.service');
const guests = require('../services/lodgingGuests.service');
const rateCards = require('../services/lodgingRates.service');
const folios = require('../services/lodgingFolios.service');
const occupants = require('../services/lodgingOccupants.service');
const groups = require('../services/lodgingGroups.service');
const housekeeping = require('../services/lodgingHousekeeping.service');
const maintenance = require('../services/lodgingMaintenance.service');
const nightAudit = require('../services/lodgingAudit.service');
const reports = require('../services/lodgingReports.service');
const moves = require('../services/lodgingMoves.service');

// Hotels, lodges and guest houses, added to the Business Admin router so they
// share its login, membership, module and permission checks (context) and its
// database-error translation:
//   /:businessId/lodging/setup|settings              room types with their rooms, the GST slabs of a room night, the weekend nights, the terms
//   /:businessId/lodging/room-types|rooms            room types and their rate plans; rooms; the housekeeping board, cleaning steps, do not disturb and
//                                                    out of service, linen and minibar checks, and a room's history
//   /:businessId/lodging/out-of-order|checklists     out-of-order periods booked ahead and ended; each room type's linen and minibar checklist
//   /:businessId/lodging/tickets…                    maintenance tickets: opened (with an out-of-order period), started, done or cancelled
//   /:businessId/lodging/desk|calendar|free          the front desk's day, the reservations calendar, the rooms free over some nights
//   /:businessId/lodging/night-audit                 the room nights up to tonight posted, the no-shows marked, the day closed
//   /:businessId/lodging/reports                     occupancy, ADR and RevPAR by property, room type, source and plan
//   /:businessId/lodging/stays/:id/move              a guest moved to another property mid-stay
//   /:businessId/lodging/stays…                      reservations (with a preview), changes and moves, advances and deposits, the check-in with
//                                                    every occupant, extras on the folio and voids, the check-out (with a preview) and its bill,
//                                                    cancelling and no-shows, the money held handed back, occupants' details corrected
//   /:businessId/lodging/form-iii|guests/:id/form-iii foreign guests' Form-III reports and marking one made
//   /:businessId/lodging/register                    the guest register
//   /:businessId/lodging/approvers                   who may approve a change, or hand money back
//   /:businessId/lodging/rates|rate-plans|seasons|rate-days|day-use-rates|policies   rate plans with their meal plans, the rate calendar, day-use prices, policies
//   /:businessId/lodging/stays/:id/folios|routing|charges/:chargeId/move           a stay's folios beyond the main one, and where its charges go
//   /:businessId/lodging/stays/:id/guests|guests/:guestId/leave                    an occupant joining or leaving partway
//   /:businessId/lodging/profiles/:contactId         a guest's preferences, notes and past stays
//   /:businessId/lodging/groups…                     group bookings: the block, the rooming list, checking in and out together, the group's folio billed
// Another type of business never has the module, so `context` refuses it (the
// room types and the settings: the service, after `context` checks the
// catalogue or settings permission); the services repeat every check and
// answer 404 for another type.

module.exports = function lodgingRoutes(router, { context, send, b }) {
  // shape: what the caller's role sees of the page.
  const list = (path, name, permission, shape) => router.get(b(path), context(permission), async (req, res) => {
    requireLodging(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    if (req.business.location_scope && !filters.location) filters.location = String(req.business.location_scope);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    const page = await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters });
    send(res, shape ? await shape(req.business, page) : page);
  });

  // Room types, rooms and the settings.
  router.get(b('/lodging/setup'), context('lodging.view'), async (req, res) => send(res, await setup.setup(req.business)));
  router.put(b('/lodging/settings'), context('settings.edit'), async (req, res) => send(res, await setup.saveSettings(req.business, req.user, req.body)));
  router.post(b('/lodging/room-types'), context('catalog.edit'), async (req, res) => send(res, await setup.createRoomType(req.business, req.user, req.body), 201));
  router.patch(b('/lodging/room-types/:id'), context('catalog.edit'), async (req, res) => send(res, await setup.updateRoomType(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/rooms'), context('catalog.edit'), async (req, res) => send(res, await setup.addRooms(req.business, req.user, req.body), 201));
  router.get(b('/lodging/rooms/board'), context('lodging.view'), async (req, res) => send(res, await housekeeping.board(req.business)));
  router.patch(b('/lodging/rooms/:id'), context('catalog.edit'), async (req, res) => send(res, await setup.updateRoom(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/rooms/:id/status'), context('lodging.edit'), async (req, res) => send(res, await housekeeping.setCleaning(req.business, req.user, req.params.id, req.body)));
  router.get(b('/lodging/rooms/:id/history'), context('lodging.view'), async (req, res) => send(res, await setup.history(req.business, req.params.id)));

  // Housekeeping: do not disturb and out of service, linen and minibar checks, out-of-order periods, the checklists.
  router.post(b('/lodging/rooms/:id/flags'), context('lodging.edit'), async (req, res) => send(res, await housekeeping.setFlags(req.business, req.user, req.params.id, req.body)));
  router.get(b('/lodging/rooms/:id/checks'), context('lodging.view'), async (req, res) => send(res, await housekeeping.roomChecks(req.business, req.params.id)));
  router.post(b('/lodging/rooms/:id/checks'), context('lodging.edit'), async (req, res) => send(res, await housekeeping.checkRoom(req.business, req.user, req.params.id, req.body), 201));
  router.get(b('/lodging/out-of-order'), context('lodging.view'), async (req, res) => send(res, await housekeeping.periods(req.business)));
  router.post(b('/lodging/out-of-order'), context('lodging.edit'), async (req, res) => send(res, await housekeeping.bookOutOfOrder(req.business, req.user, req.body), 201));
  router.patch(b('/lodging/out-of-order/:id'), context('lodging.edit'), async (req, res) => send(res, await housekeeping.changeOutOfOrder(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/out-of-order/:id/back'), context('lodging.edit'),
    async (req, res) => send(res, await housekeeping.changeOutOfOrder(req.business, req.user, req.params.id, req.body, { back: true })));
  router.get(b('/lodging/checklists'), context('lodging.view'), async (req, res) => send(res, await housekeeping.checklists(req.business)));
  router.put(b('/lodging/checklists'), context('catalog.edit'), async (req, res) => send(res, await housekeeping.setChecklist(req.business, req.user, req.body)));

  // Maintenance tickets.
  list('/lodging/tickets', 'lodging-tickets', 'lodging.view');
  router.get(b('/lodging/tickets/staff'), context('lodging.view'), async (req, res) => send(res, await maintenance.staff(req.business)));
  router.post(b('/lodging/tickets'), context('lodging.edit'), async (req, res) => send(res, await maintenance.create(req.business, req.user, req.body), 201));
  router.patch(b('/lodging/tickets/:id'), context('lodging.edit'), async (req, res) => send(res, await maintenance.update(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/tickets/:id/start'), context('lodging.edit'), async (req, res) => send(res, await maintenance.step(req.business, req.user, req.params.id, 'in_progress', req.body)));
  router.post(b('/lodging/tickets/:id/done'), context('lodging.edit'), async (req, res) => send(res, await maintenance.step(req.business, req.user, req.params.id, 'done', req.body)));
  router.post(b('/lodging/tickets/:id/cancel'), context('lodging.edit'), async (req, res) => send(res, await maintenance.step(req.business, req.user, req.params.id, 'cancelled', req.body)));

  // The front desk's day, the calendar, what is free, and the night audit.
  router.get(b('/lodging/desk'), context('lodging.view'), async (req, res) => send(res, await desk.desk(req.business)));
  router.get(b('/lodging/calendar'), context('lodging.view'), async (req, res) => send(res, await desk.calendar(req.business, req.query)));
  router.get(b('/lodging/free'), context('lodging.view'), async (req, res) => send(res, await desk.free(req.business, req.query)));
  router.post(b('/lodging/night-audit'), context('lodging.create'), async (req, res) => send(res, await nightAudit.run(req.business, req.user, req.body)));
  router.get(b('/lodging/reports'), context('reports.view'), async (req, res) => send(res, await reports.report(req.business, req.query)));

  // Reservations and stays.
  list('/lodging/stays', 'lodging-stays', 'lodging.view', stays.listShape);
  router.post(b('/lodging/stays/preview'), context('lodging.view'), async (req, res) => send(res, await stays.preview(req.business, req.user, req.body)));
  router.post(b('/lodging/stays'), context('lodging.create'), async (req, res) => send(res, await stays.create(req.business, req.user, req.body), 201));
  router.get(b('/lodging/stays/:id'), context('lodging.view'), async (req, res) => send(res, await stays.detail(req.business, req.params.id)));
  router.patch(b('/lodging/stays/:id'), context('lodging.create'), async (req, res) => send(res, await stays.update(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/stays/:id/check-in'), context('lodging.create'), async (req, res) => send(res, await folio.checkIn(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/stays/:id/receipts'), context('lodging.create'), async (req, res) => send(res, await stays.receive(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/lodging/stays/:id/charges'), context('lodging.create'), async (req, res) => send(res, await folio.addCharge(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/lodging/stays/:id/charges/:chargeId/void'), context('lodging.approve'),
    async (req, res) => send(res, await folio.voidCharge(req.business, req.user, req.params.id, req.params.chargeId, req.body)));
  router.patch(b('/lodging/stays/:id/guests/:guestId'), context('lodging.create'),
    async (req, res) => send(res, await guests.updateGuest(req.business, req.user, req.params.id, req.params.guestId, req.body)));
  router.post(b('/lodging/stays/:id/check-out/preview'), context('lodging.create'), async (req, res) => send(res, await folio.checkoutPreview(req.business, req.user, req.params.id)));
  router.post(b('/lodging/stays/:id/check-out'), context('lodging.create'), async (req, res) => send(res, await folio.checkOut(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/stays/:id/cancel'), context('lodging.cancel'), async (req, res) => send(res, await stays.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/stays/:id/refund'), context('lodging.refund'), async (req, res) => send(res, await stays.refundHeld(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/lodging/stays/:id/move'), context('lodging.create'), async (req, res) => send(res, await moves.moveProperty(req.business, req.user, req.params.id, req.body), 201));

  // Foreign guests' Form-III reports, and the guest register.
  router.get(b('/lodging/form-iii'), context('lodging.create'), async (req, res) => send(res, await guests.formIII(req.business, req.query)));
  router.post(b('/lodging/guests/:id/form-iii'), context('lodging.create'), async (req, res) => send(res, await guests.markReported(req.business, req.user, req.params.id, req.body)));
  router.get(b('/lodging/register'), context('lodging.print'), async (req, res) => send(res, await guests.register(req.business, req.query)));

  // Rate plans, the rate calendar, day-use prices and policies.
  router.get(b('/lodging/rates'), context('lodging.view'), async (req, res) => send(res, await rateCards.rates(req.business, req.query)));
  router.post(b('/lodging/rate-plans'), context('catalog.edit'), async (req, res) => send(res, await rateCards.createPlan(req.business, req.user, req.body), 201));
  router.patch(b('/lodging/rate-plans/:id'), context('catalog.edit'), async (req, res) => send(res, await rateCards.updatePlan(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/seasons'), context('catalog.edit'), async (req, res) => send(res, await rateCards.createSeason(req.business, req.user, req.body), 201));
  router.patch(b('/lodging/seasons/:id'), context('catalog.edit'), async (req, res) => send(res, await rateCards.updateSeason(req.business, req.user, req.params.id, req.body)));
  router.put(b('/lodging/rate-days'), context('catalog.edit'), async (req, res) => send(res, await rateCards.setDays(req.business, req.user, req.body)));
  router.put(b('/lodging/day-use-rates'), context('catalog.edit'), async (req, res) => send(res, await rateCards.setDayUseRates(req.business, req.user, req.body)));
  router.post(b('/lodging/policies'), context('settings.edit'), async (req, res) => send(res, await rateCards.createPolicy(req.business, req.user, req.body), 201));
  router.patch(b('/lodging/policies/:id'), context('settings.edit'), async (req, res) => send(res, await rateCards.updatePolicy(req.business, req.user, req.params.id, req.body)));

  // A stay's folios and routing, occupants joining and leaving, and guest profiles.
  router.post(b('/lodging/stays/:id/folios'), context('lodging.create'), async (req, res) => send(res, await folios.createFolio(req.business, req.user, req.params.id, req.body), 201));
  router.patch(b('/lodging/stays/:id/folios/:folioId'), context('lodging.create'),
    async (req, res) => send(res, await folios.updateFolio(req.business, req.user, req.params.id, req.params.folioId, req.body)));
  router.put(b('/lodging/stays/:id/routing'), context('lodging.create'), async (req, res) => send(res, await folios.setRouting(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/stays/:id/charges/:chargeId/move'), context('lodging.create'),
    async (req, res) => send(res, await folios.moveCharge(req.business, req.user, req.params.id, req.params.chargeId, req.body)));
  router.post(b('/lodging/stays/:id/guests'), context('lodging.create'), async (req, res) => send(res, await occupants.join(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/lodging/stays/:id/guests/:guestId/leave'), context('lodging.create'),
    async (req, res) => send(res, await occupants.leave(req.business, req.user, req.params.id, req.params.guestId, req.body)));
  router.get(b('/lodging/profiles/:contactId'), context('lodging.view'), async (req, res) => send(res, await occupants.profile(req.business, req.params.contactId)));
  router.put(b('/lodging/profiles/:contactId'), context('lodging.create'), async (req, res) => send(res, await occupants.saveProfile(req.business, req.user, req.params.contactId, req.body)));

  // Group bookings.
  list('/lodging/groups', 'lodging-groups', 'lodging.view');
  router.post(b('/lodging/groups'), context('lodging.create'), async (req, res) => send(res, await groups.create(req.business, req.user, req.body), 201));
  router.get(b('/lodging/groups/:id'), context('lodging.view'), async (req, res) => send(res, await groups.detail(req.business, req.params.id)));
  router.patch(b('/lodging/groups/:id/rooming'), context('lodging.create'), async (req, res) => send(res, await groups.rooming(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/groups/:id/check-in'), context('lodging.create'), async (req, res) => send(res, await groups.checkIn(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/groups/:id/check-out'), context('lodging.create'), async (req, res) => send(res, await groups.checkOut(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/groups/:id/bill'), context('lodging.create'), async (req, res) => send(res, await groups.bill(req.business, req.user, req.params.id, req.body)));

  // Who may approve a change for a guest in the house (lodging.approve) or hand money back (lodging.refund).
  router.get(b('/lodging/approvers'), context(['lodging.create', 'lodging.cancel', 'lodging.refund', 'lodging.approve']),
    async (req, res) => send(res, await stays.approvers(req.business, req.query)));
};
