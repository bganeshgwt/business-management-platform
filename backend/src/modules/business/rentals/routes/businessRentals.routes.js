const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const access = require('../../core/services/businessAccess.service');
const { requireRentals, seesMoney } = require('../services/rentalsCommon');
const items = require('../services/rentalsItems.service');
const bookings = require('../services/rentalsBookings.service');
const handover = require('../services/rentalsHandover.service');
const availability = require('../services/rentalsAvailability.service');
const deposits = require('../services/rentalsDeposits.service');
const yard = require('../services/rentalsYard.service');
const registers = require('../services/rentalsRegister.service');
const reports = require('../services/rentalsReports.service');

// Rental and hire businesses, added to the Business Admin router so they
// share its login, membership, module and permission checks (context) and
// its database-error translation:
//   /:businessId/rentals/items|units          what is hired out: items (one by one, a pool or a kit) with their rates and rules, and their units
//   /:businessId/rentals/classes              classes of items: their checklist and late fee slabs
//   /:businessId/rentals/settings             a hirer's photo ID at every handover, the terms on the slips, papers' warnings, cancellation slabs
//   /:businessId/rentals/bookings…            quotes and bookings (with a preview), the board, changes and extensions, reserving a quote,
//                                             advances and deposits, the handover, returns (with a preview) and the bill, cancelling
//                                             (with a preview of the charge worked out), the money held handed back, a unit scanned,
//                                             the original document handed back
//   /:businessId/rentals/yard|transfers|downtime  where units and pools are kept, papers and services, moves between locations,
//                                             maintenance booked ahead
//   /:businessId/rentals/register|reports     the hirer register (Forms 5/3 and 6/4); use and earnings for a period
// (Photos and signatures are uploaded by rentalsUploads.routes.js, mounted before this router.)
//   /:businessId/rentals/availability|free    the week by item and unit; what is free over a booking's time
//   /:businessId/rentals/deposits             the deposits held, booking by booking, and in all
//   /:businessId/rentals/approvers            who may agree to less deposit, or hand money back
// Another type of business never has the module, so `context` refuses it (the
// items and the settings: the service, after `context` checks the catalogue or
// settings permission); the services repeat every check and answer 404 for
// another type.

module.exports = function rentalsRoutes(router, { context, send, b }) {
  // shape: what the caller's role sees of the page.
  const list = (path, name, permission, shape) => router.get(b(path), context(permission), async (req, res) => {
    requireRentals(req.business);
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
    send(res, shape ? await shape(req.business, page) : page);
  });

  // What is hired out, and the settings.
  router.get(b('/rentals/items'), context('rentals.view'), async (req, res) => send(res, await items.list(req.business)));
  router.post(b('/rentals/items'), context('catalog.edit'), async (req, res) => send(res, await items.createItem(req.business, req.user, req.body), 201));
  router.patch(b('/rentals/items/:id'), context('catalog.edit'), async (req, res) => send(res, await items.updateItem(req.business, req.user, req.params.id, req.body)));
  router.post(b('/rentals/items/:id/units'), context('catalog.edit'), async (req, res) => send(res, await items.addUnit(req.business, req.user, req.params.id, req.body), 201));
  router.patch(b('/rentals/units/:id'), context(['catalog.edit', 'rentals.edit']), async (req, res) => send(res, await items.updateUnit(req.business, req.user, req.params.id, req.body)));
  router.post(b('/rentals/classes'), context('catalog.edit'), async (req, res) => send(res, await items.saveClass(req.business, req.user, null, req.body), 201));
  router.patch(b('/rentals/classes/:id'), context('catalog.edit'), async (req, res) => send(res, await items.saveClass(req.business, req.user, req.params.id, req.body)));
  router.get(b('/rentals/settings'), context('rentals.view'), async (req, res) => send(res, await items.settings(req.business)));
  router.put(b('/rentals/settings'), context('settings.edit'), async (req, res) => send(res, await items.saveSettings(req.business, req.user, req.body)));

  // Quotes and bookings.
  list('/rentals/bookings', 'rental-bookings', 'rentals.view', bookings.listShape);
  list('/rentals/bookings/open', 'rental-bookings-open', 'rentals.view', bookings.listShape);
  router.get(b('/rentals/bookings/board'), context('rentals.view'), async (req, res) => send(res, await bookings.board(req.business)));
  router.post(b('/rentals/bookings/preview'), context('rentals.view'), async (req, res) => send(res, await bookings.preview(req.business, req.user, req.body)));
  router.post(b('/rentals/bookings'), context('rentals.create'), async (req, res) => send(res, await bookings.create(req.business, req.user, req.body), 201));
  router.get(b('/rentals/bookings/:id'), context('rentals.view'), async (req, res) => send(res, await bookings.detail(req.business, req.params.id)));
  router.patch(b('/rentals/bookings/:id'), context('rentals.edit'), async (req, res) => send(res, await bookings.update(req.business, req.user, req.params.id, req.body)));
  router.post(b('/rentals/bookings/:id/confirm'), context('rentals.create'), async (req, res) => send(res, await bookings.confirm(req.business, req.user, req.params.id)));
  router.post(b('/rentals/bookings/:id/receipts'), context('rentals.edit'), async (req, res) => send(res, await bookings.receive(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/rentals/bookings/:id/checkout'), context('rentals.edit'), async (req, res) => send(res, await handover.checkout(req.business, req.user, req.params.id, req.body)));
  router.post(b('/rentals/bookings/:id/returns/preview'), context('rentals.edit'), async (req, res) => send(res, await handover.preview(req.business, req.user, req.params.id, req.body)));
  router.post(b('/rentals/bookings/:id/returns'), context('rentals.edit'), async (req, res) => send(res, await handover.takeBack(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/rentals/bookings/:id/cancel'), context('rentals.cancel'), async (req, res) => send(res, await bookings.cancel(req.business, req.user, req.params.id, req.body)));
  router.get(b('/rentals/bookings/:id/cancel/preview'), context('rentals.cancel'), async (req, res) => send(res, await bookings.cancelPreview(req.business, req.params.id)));
  router.post(b('/rentals/bookings/:id/scan'), context('rentals.edit'), async (req, res) => send(res, await bookings.scan(req.business, req.params.id, req.body)));
  router.post(b('/rentals/bookings/:id/original-back'), context('rentals.edit'), async (req, res) => send(res, await bookings.originalBack(req.business, req.user, req.params.id)));
  router.post(b('/rentals/bookings/:id/refund'), context('rentals.refund'), async (req, res) => send(res, await bookings.refundHeld(req.business, req.user, req.params.id, req.body), 201));

  // What is free: the week by item and unit, and over a booking's time.
  router.get(b('/rentals/availability'), context('rentals.view'), async (req, res) => send(res, await availability.calendar(req.business, req.query)));
  router.get(b('/rentals/free'), context('rentals.view'), async (req, res) => send(res, await availability.free(req.business, req.query)));

  // The yard: units and pools by location, papers and services; moves between locations; maintenance booked ahead.
  router.get(b('/rentals/yard'), context('rentals.view'), async (req, res) => send(res, await yard.yard(req.business)));
  router.post(b('/rentals/transfers'), context('rentals.edit'), async (req, res) => send(res, await yard.transfer(req.business, req.user, req.body), 201));
  router.post(b('/rentals/units/:id/downtime'), context('rentals.edit'), async (req, res) => send(res, await yard.addDowntime(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/rentals/downtime/:id/cancel'), context('rentals.edit'), async (req, res) => send(res, await yard.cancelDowntime(req.business, req.user, req.params.id)));
  router.post(b('/rentals/units/:id/services'), context('rentals.edit'), async (req, res) => send(res, await yard.recordService(req.business, req.user, req.params.id, req.body), 201));

  // The hirer register (printed) and use and earnings for a period (money: for those who see sales).
  router.get(b('/rentals/register'), context('rentals.print'), async (req, res) => send(res, await registers.register(req.business, req.query)));
  router.get(b('/rentals/reports'), context('rentals.view'), async (req, res) => send(res, await reports.report(req.business, req.query)));

  // The deposits held (money: for those who see sales).
  const money = async (business, page) => {
    if (!seesMoney(business)) await access.require(business, 'sales.view');
    return page;
  };
  list('/rentals/deposits', 'rental-deposits', 'rentals.view', money);
  router.get(b('/rentals/deposits/totals'), context('rentals.view'), async (req, res) => {
    if (!seesMoney(req.business)) await access.require(req.business, 'sales.view');
    send(res, await deposits.totals(req.business));
  });

  // Who may agree to less deposit (rentals.approve) or hand money back (rentals.refund).
  router.get(b('/rentals/approvers'), context(['rentals.edit', 'rentals.cancel', 'rentals.refund']), async (req, res) => send(res, await bookings.approvers(req.business, req.query)));
};
