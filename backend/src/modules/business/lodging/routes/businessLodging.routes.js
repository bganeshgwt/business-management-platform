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

// Hotels, lodges and guest houses, added to the Business Admin router so they
// share its login, membership, module and permission checks (context) and its
// database-error translation:
//   /:businessId/lodging/setup|settings              room types with their rooms, the GST slabs of a room night, the weekend nights, the terms
//   /:businessId/lodging/room-types|rooms            room types and their rate plans; rooms; housekeeping status and its history
//   /:businessId/lodging/desk|calendar|free          the front desk's day, the reservations calendar, the rooms free over some nights
//   /:businessId/lodging/night-audit                 the room nights up to tonight, posted
//   /:businessId/lodging/stays…                      reservations (with a preview), changes and moves, advances and deposits, the check-in with
//                                                    every occupant, extras on the folio and voids, the check-out (with a preview) and its bill,
//                                                    cancelling and no-shows, the money held handed back, occupants' details corrected
//   /:businessId/lodging/form-iii|guests/:id/form-iii foreign guests' Form-III reports and marking one made
//   /:businessId/lodging/register                    the guest register
//   /:businessId/lodging/approvers                   who may approve a change, or hand money back
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
  router.get(b('/lodging/rooms/board'), context('lodging.view'), async (req, res) => send(res, await setup.board(req.business)));
  router.patch(b('/lodging/rooms/:id'), context('catalog.edit'), async (req, res) => send(res, await setup.updateRoom(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lodging/rooms/:id/status'), context('lodging.edit'), async (req, res) => send(res, await setup.setRoomStatus(req.business, req.user, req.params.id, req.body)));
  router.get(b('/lodging/rooms/:id/history'), context('lodging.view'), async (req, res) => send(res, await setup.history(req.business, req.params.id)));

  // The front desk's day, the calendar, what is free, and the night audit.
  router.get(b('/lodging/desk'), context('lodging.view'), async (req, res) => send(res, await desk.desk(req.business)));
  router.get(b('/lodging/calendar'), context('lodging.view'), async (req, res) => send(res, await desk.calendar(req.business, req.query)));
  router.get(b('/lodging/free'), context('lodging.view'), async (req, res) => send(res, await desk.free(req.business, req.query)));
  router.post(b('/lodging/night-audit'), context('lodging.create'), async (req, res) => send(res, await folio.nightAudit(req.business, req.user)));

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

  // Foreign guests' Form-III reports, and the guest register.
  router.get(b('/lodging/form-iii'), context('lodging.create'), async (req, res) => send(res, await guests.formIII(req.business, req.query)));
  router.post(b('/lodging/guests/:id/form-iii'), context('lodging.create'), async (req, res) => send(res, await guests.markReported(req.business, req.user, req.params.id, req.body)));
  router.get(b('/lodging/register'), context('lodging.print'), async (req, res) => send(res, await guests.register(req.business, req.query)));

  // Who may approve a change for a guest in the house (lodging.approve) or hand money back (lodging.refund).
  router.get(b('/lodging/approvers'), context(['lodging.create', 'lodging.cancel', 'lodging.refund', 'lodging.approve']),
    async (req, res) => send(res, await stays.approvers(req.business, req.query)));
};
