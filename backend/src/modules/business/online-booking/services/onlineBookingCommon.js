const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const guests = require('../../guests');
const guestKeys = require('../../../live/services/guestKeys');
const { maskMobile } = require('../../../../utils/phone');
const rules = require('./onlineBookingRules');

// What the guest side and the desk side of online booking share: a booking
// link resolved with the refusals every guest page gives, a booking with its
// appointments, and what a guest reads about it.

const LINK = /^[A-Za-z0-9_-]{32,64}$/;
const GUEST = /^[A-Za-z0-9_-]{32,64}$/;
const NOT_AVAILABLE = 'This booking link is not in use any more. Please contact the business to book.';
const BOOKING_GONE = 'We couldn\'t find that booking. Please check the link, or contact the business.';

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const newToken = () => crypto.randomBytes(24).toString('base64url');
const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A request key made from another, so a repeated booking never repeats its parts (a salon's services).
const derivedKey = (base, part) => {
  const hex = crypto.createHash('sha256').update(`${base}:${part}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const callWords = (card) => (card && card.location && card.location.phone ? `call them on ${card.location.phone}` : 'call them');

// --- A link, as a guest reaches it -----------------------------------------------------------------

// The link behind a token, its business and the business card, or a refusal
// the guest's page shows calmly with the business's phone (data: { reason, card }):
//   404 not_available       no such link
//   409 not_taking_orders   the plan has ended, the business is switched off or the location closed
//   403 feature_off         online booking (or appointments) is not switched on, or not in the plan
//   409 booking_off         the link is switched off
// A GST rate change due on the business's date takes effect first, as a staff
// request's gate (businessAccess.open) does, so the prices a guest sees are
// those in force today.
async function resolveLink(token, db = repo.pool) {
  if (typeof token !== 'string' || !LINK.test(token)) fail(NOT_AVAILABLE, 404, { reason: 'not_available' });
  const row = await repo.one(db, `SELECT l.*,b.business_type,b.timezone,b.status AS business_status,b.name AS business_name,s.state AS plan_state,loc.active AS location_active,
      'online_appointments'=ANY(business_active_capabilities(b.id)) AS module_on,'appointments'=ANY(business_active_capabilities(b.id)) AS appointments_on,
      (EXISTS (SELECT 1 FROM business_tax_change_items x WHERE x.business_id=b.id AND x.status='scheduled' AND x.sku_id IS NOT NULL
        AND x.starts_on <= (now() AT TIME ZONE b.timezone)::date)
       OR EXISTS (SELECT 1 FROM business_tax_setting_changes x WHERE x.business_id=b.id AND x.status='scheduled' AND x.setting<>'restaurant_default'
        AND x.starts_on <= (now() AT TIME ZONE b.timezone)::date)) AS tax_changes_due
    FROM business_booking_links l JOIN businesses b ON b.id=l.business_id JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
    CROSS JOIN LATERAL business_plan_state(b.id) s WHERE l.token=$1`, [token]);
  if (!row) fail(NOT_AVAILABLE, 404, { reason: 'not_available' });
  const business = { id: Number(row.business_id), business_type: row.business_type, timezone: row.timezone || 'Asia/Kolkata', name: row.business_name, modules: [] };
  const card = await guests.guestBusinessCard(db, business.id, row.location_id);
  const refuse = (status, reason, message) => fail(message, status, { reason, card });
  const words = `${card.name} isn't taking online bookings right now. Please ${callWords(card)} to book.`;
  if (['ended', 'off'].includes(row.plan_state) || row.business_status !== 'active') refuse(409, 'not_taking_orders', words);
  if (!row.module_on || !row.appointments_on) refuse(403, 'feature_off', words);
  if (!row.enabled) refuse(409, 'booking_off', words);
  if (!row.location_active) refuse(409, 'not_taking_orders', words);
  await require('../../../tax-changes/services/taxChangesShop').onOpen({ id: business.id, tax_changes_due: row.tax_changes_due });
  return { link: row, business, card };
}

// --- A booking ---------------------------------------------------------------------------------------

// The booking with its appointments (in time order), each with its service, person and room.
async function loadBooking(db, where, values, { lock = false } = {}) {
  const booking = await repo.one(db, `SELECT ob.*,b.business_type,b.timezone,b.name AS business_name FROM business_online_bookings ob JOIN businesses b ON b.id=ob.business_id
    WHERE ${where}${lock ? ' FOR UPDATE OF ob' : ''}`, values);
  if (!booking) return null;
  const appointments = await repo.all(db, `SELECT a.*,s.label AS service_name,r.name AS resource_name,r.location_id,d.room_id,
      COALESCE(ss.duration_minutes,NULL) AS duration_minutes,d.deposit_collection_id
    FROM business_appointments a JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
    JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
    LEFT JOIN salon_appointment_details d ON d.business_id=a.business_id AND d.appointment_id=a.id
    LEFT JOIN salon_services ss ON ss.business_id=a.business_id AND ss.sku_id=a.sku_id
    WHERE a.business_id=$1 AND a.online_booking_id=$2 ORDER BY a.starts_at,a.id${lock ? ' FOR UPDATE OF a' : ''}`, [booking.business_id, booking.id]);
  return { booking, appointments };
}

const byGuestToken = (db, token, options) => {
  if (typeof token !== 'string' || !GUEST.test(token)) fail(BOOKING_GONE, 404, { reason: 'not_found' });
  return loadBooking(db, 'ob.guest_token=$1', [token], options);
};

// Its status as one, worked out on read: a request past its expiry is expired
// for the guest and the desk alike, whether or not it has been marked yet.
function stateOf(appointments, nowMs = Date.now()) {
  const statuses = appointments.map((a) => (a.status === 'requested' && new Date(a.request_expires_at).getTime() <= nowMs ? 'expired' : a.status));
  return rules.overallStatus(statuses);
}

// The guest live key while something can still happen to it (an answer, a
// change, a cancellation, the visit), watching its appointments and the booking.
function liveFor(booking, appointments, status) {
  if (!['requested', 'booked'].includes(status)) return null;
  return guestKeys.issue({ business: Number(booking.business_id), watch: [
    ...appointments.map((a) => ({ area: 'appointment', id: Number(a.id) })), { area: 'online_booking', id: Number(booking.id) }] });
}

// What a guest's status page shows.
function bookingView({ booking, appointments }, { card, link, nowMs = Date.now(), linkToken = null }) {
  const tz = booking.timezone || 'Asia/Kolkata';
  const status = stateOf(appointments, nowMs);
  const first = appointments[0];
  const last = appointments[appointments.length - 1];
  const startsMs = new Date(first.starts_at).getTime();
  const endsMs = new Date(last.ends_at).getTime();
  const at = rules.clockOf(tz, startsMs), end = rules.clockOf(tz, endsMs);
  const words = rules.GUEST_WORDS[status] || { label: status, tone: 'done' };
  const deposit = appointments.some((a) => a.deposit_collection_id) || Boolean(booking.advance_collection_id);
  const may = rules.guestMay({ status, startsMs, nowMs, cancelHours: Number(link?.cancel_hours ?? 3), changes: Number(booking.changes),
    maxChanges: Number(link?.max_changes ?? 0), deposit });
  const showPrices = link ? link.show_prices : true;
  const salon = booking.business_type === 'salon';
  const clinic = booking.business_type === 'healthcare';
  const name = card ? card.name : booking.business_name;
  const call = callWords(card);
  const next = {
    requested: booking.request_reason === 'advance'
      ? `${name} will check your advance of ${money(booking.advance_amount)} (UTR ${booking.advance_utr}) and confirm your booking. This page changes by itself when they do.`
      : booking.request_reason === 'deposit'
        ? `${name} will call you to take an advance and confirm your booking. This page changes by itself when they do.`
        : `${name} will confirm your booking soon. This page changes by itself when they do.`,
    booked: clinic ? 'You are booked. At the clinic, tell the desk your name: they give you your token for the doctor.'
      : `You are booked. Please arrive a few minutes early.${may.cancel ? '' : ` To cancel or change it now, please ${call}.`}`,
    completed: 'Thank you for visiting.',
    no_show: `This booking was marked missed. To book again, use the booking link, or ${call}.`,
    declined: `${name} could not take this booking${booking.decline_reason ? `: ${booking.decline_reason}` : ''}. Please book another time, or ${call}.`
      + (booking.advance_amount && !booking.advance_collection_id ? ` If you paid an advance, ${name} returns it to you.` : ''),
    expired: `${name} did not confirm this booking in time, so it is not booked. Please book another time, or ${call}.`
      + (booking.advance_amount && !booking.advance_collection_id ? ` If you paid an advance, ${name} returns it to you.` : ''),
    cancelled: booking.cancelled_by_guest_at ? 'You cancelled this booking.' : `${name} cancelled this booking. Please book another time, or ${call}.`,
  }[status] || null;
  const services = appointments.map((a) => ({ label: a.service_name, minutes: Math.round((new Date(a.ends_at) - new Date(a.starts_at)) / 60000) }));
  return {
    ref: String(booking.id).padStart(4, '0'),
    guestToken: booking.guest_token,
    status, statusLabel: words.label, tone: words.tone, next,
    type: booking.business_type,
    services, person: first.resource_name,
    date: at.date, dateLabel: rules.dateLabel(at.date), time: rules.timeText(at.minutes), timeLabel: rules.timeLabel(at.minutes),
    endTimeLabel: rules.timeLabel(end.minutes), startsAt: new Date(startsMs).toISOString(), endsAt: new Date(endsMs).toISOString(),
    name: booking.booker_name, mobile: booking.mobile ? maskMobile(booking.mobile) : null,
    forWhom: booking.for_whom, personName: booking.person_name, note: booking.note, reason: booking.reason, visitKind: booking.visit_kind,
    vehicle: booking.vehicle_no ? { number: booking.vehicle_no, make: booking.vehicle_make, model: booking.vehicle_model } : null,
    requestReason: status === 'requested' ? booking.request_reason : null,
    expiresAt: status === 'requested' && first.request_expires_at ? new Date(first.request_expires_at).toISOString() : null,
    declineReason: status === 'declined' ? booking.decline_reason : null,
    advance: booking.advance_amount ? { amount: Number(booking.advance_amount).toFixed(2), utr: booking.advance_utr, received: Boolean(booking.advance_collection_id) } : null,
    may, changesLeft: Math.max(0, Number(link?.max_changes ?? 0) - Number(booking.changes)), cancelHours: Number(link?.cancel_hours ?? 3),
    salon, clinic, showPrices,
    madeAt: booking.created_at, answeredAt: booking.answered_at,
    card,
    bookAgain: linkToken,
  };
}

// --- Readers ---------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function readDate(value, field = 'date') {
  const text = String(value ?? '');
  if (!DATE.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail('Please pick a day', 400, { field });
  return text;
}
function readTime(value, field = 'time') {
  const minutes = rules.minutesOf(value);
  if (minutes === null) fail('Please pick a time', 400, { field });
  return minutes;
}
// "3,7" or [3, 7] → [3, 7]
function readIds(value, field) {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : String(value).split(',');
  const ids = list.map((item) => Number(String(item).trim()));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || ids.length > 5) fail('Please choose again', 400, { field });
  return ids;
}
function readPerson(value) {
  if (value === undefined || value === null || value === '' || value === 'any') return 'any';
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail('Please choose who you would like', 400, { field: 'person' });
  return id;
}

module.exports = {
  LINK, GUEST, NOT_AVAILABLE, BOOKING_GONE, fail, newToken, hashOf, derivedKey, money, callWords, resolveLink, loadBooking, byGuestToken, stateOf, liveFor,
  bookingView, readDate, readTime, readIds, readPerson,
};
