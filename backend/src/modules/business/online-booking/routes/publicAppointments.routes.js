const express = require('express');
const { guestLimiter, MINUTE } = require('../../guests');
const service = require('../services/onlineBookingGuest.service');

// Online booking for guests, mounted at /api/public/appointments (API.md ›
// Public guest pages › Online booking). No login: a request carries the
// booking link's token or the guest's own booking token, and nothing else.
// Every answer is Cache-Control: no-store ("Requested" shown after the desk
// said yes is worse than nothing).
//
// Three limits on booking, because each alone has a hole: per client address
// (generous: a carrier puts thousands of phones behind one), per link (a flood
// at one business from many addresses) and per mobile (one person's repeats,
// whatever network). The rule that must hold, open bookings per mobile, is
// kept in the database by the service.
const router = express.Router();

// Every answer, refusals and the busy 429 included.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const reads = guestLimiter({ windowMs: MINUTE, max: 600 });
const bookingsPerAddress = guestLimiter({ windowMs: 10 * MINUTE, max: 30 });
const bookingsPerLink = guestLimiter({ windowMs: 10 * MINUTE, max: 60, key: (req) => `link:${String(req.params.token || '').slice(0, 64)}`,
  message: 'This business is receiving a lot of bookings right now. Please try again in a few minutes, or call them.' });
const bookingsPerMobile = guestLimiter({ windowMs: 60 * MINUTE, max: 8, key: (req) => {
  const digits = String((req.body && req.body.mobile) || '').replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? `mobile:${digits}` : null;
}, message: 'This mobile number has made several bookings in a short time. Please wait a while, or call the business.' });
const changesPerAddress = guestLimiter({ windowMs: 10 * MINUTE, max: 30 });
const changesPerBooking = guestLimiter({ windowMs: 10 * MINUTE, max: 15, key: (req) => `booking:${String(req.params.guestToken || '').slice(0, 64)}`,
  message: 'This booking has been changed several times just now. Please wait a few minutes, or call the business.' });

const noStore = (res) => res.set('Cache-Control', 'no-store');
const answer = (res, { booking, live }, status = 200, message = undefined) => {
  noStore(res);
  res.status(status).json({ success: true, ...(message ? { message } : {}), data: booking, live });
};

// The guest's own booking: its page, cancelling, a new time, a calendar file.
router.get('/status/:guestToken', reads, async (req, res) => answer(res, await service.follow(req.params.guestToken)));
router.post('/status/:guestToken/cancel', changesPerAddress, changesPerBooking, async (req, res) =>
  answer(res, await service.cancel(req.params.guestToken), 200, 'Your booking is cancelled. Thank you for letting us know.'));
router.get('/status/:guestToken/days', reads, async (req, res) => { noStore(res); res.json({ success: true, data: await service.changeDays(req.params.guestToken, req.query) }); });
router.get('/status/:guestToken/times', reads, async (req, res) => { noStore(res); res.json({ success: true, data: await service.changeTimes(req.params.guestToken, req.query) }); });
router.post('/status/:guestToken/move', changesPerAddress, changesPerBooking, async (req, res) =>
  answer(res, await service.move(req.params.guestToken, req.body || {}), 200, 'Your booking has its new time.'));
router.get('/status/:guestToken/calendar.ics', reads, async (req, res) => {
  const { name, ics } = await service.calendar(req.params.guestToken);
  noStore(res);
  res.set('Content-Type', 'text/calendar; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(ics);
});

// The booking link: the page, the days and times free, and booking.
router.get('/:token', reads, async (req, res) => { noStore(res); res.json({ success: true, data: await service.page(req.params.token) }); });
router.get('/:token/days', reads, async (req, res) => { noStore(res); res.json({ success: true, data: await service.days(req.params.token, req.query) }); });
router.get('/:token/times', reads, async (req, res) => { noStore(res); res.json({ success: true, data: await service.times(req.params.token, req.query) }); });
router.post('/:token/bookings', bookingsPerAddress, bookingsPerLink, bookingsPerMobile, async (req, res) => {
  const result = await service.book(req.params.token, req.body);
  answer(res, result, result.repeated ? 200 : 201, result.booking.status === 'requested'
    ? 'Request sent. The business confirms it soon: keep this page to see their answer.' : 'You are booked.');
});

module.exports = router;
