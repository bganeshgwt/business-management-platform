const links = require('../services/onlineBookingLinks.service');
const desk = require('../services/onlineBookingDesk.service');

// The Online booking screen (API.md, Online booking): the booking link of
// each location and its rules, what shows online, the requests to answer and
// every online booking. online_appointments.view to see, .approve to answer
// requests, .manage to change the link and its rules.
module.exports = function onlineBookingRoutes(router, { context, send, b }) {
  router.get(b('/online-booking'), context('online_appointments.view'), async (req, res) => send(res, await links.overview(req.business)));
  router.post(b('/online-booking/links'), context('online_appointments.manage'), async (req, res) => send(res, await links.createLink(req.business, req.user, req.body), 201));
  router.patch(b('/online-booking/links/:linkId'), context('online_appointments.manage'), async (req, res) =>
    send(res, await links.updateLink(req.business, req.user, req.params.linkId, req.body)));
  // A new link: the old one and its printed QR stop working.
  router.post(b('/online-booking/links/:linkId/new-link'), context('online_appointments.manage'), async (req, res) =>
    send(res, await links.replaceToken(req.business, req.user, req.params.linkId)));
  router.put(b('/online-booking/links/:linkId/shown'), context('online_appointments.manage'), async (req, res) =>
    send(res, await links.setShown(req.business, req.user, req.params.linkId, req.body)));
  router.get(b('/online-booking/requests'), context('online_appointments.view'), async (req, res) => send(res, await desk.waiting(req.business)));
  router.get(b('/online-booking/bookings'), context('online_appointments.view'), async (req, res) => send(res, await desk.list(req.business, req.query)));
  router.post(b('/online-booking/bookings/:bookingId/accept'), context('online_appointments.approve'), async (req, res) =>
    send(res, await desk.accept(req.business, req.user, req.params.bookingId, req.body)));
  router.post(b('/online-booking/bookings/:bookingId/decline'), context('online_appointments.approve'), async (req, res) =>
    send(res, await desk.decline(req.business, req.user, req.params.bookingId, req.body)));
  router.get(b('/online-booking/tomorrow'), context('online_appointments.view'), async (req, res) => send(res, await desk.tomorrow(req.business)));
  router.post(b('/online-booking/bookings/:bookingId/reminder-sent'), context('online_appointments.view'), async (req, res) =>
    send(res, await desk.reminderSent(req.business, req.user, req.params.bookingId)));
};
