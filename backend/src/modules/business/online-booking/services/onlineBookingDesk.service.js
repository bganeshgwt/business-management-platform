const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const consents = require('../../../personal-data/services/consents');
const v = require('../../../../utils/validate');
const engine = require('./onlineBookingEngine');
const rules = require('./onlineBookingRules');
const writes = require('./onlineBookingWrites');
const links = require('./onlineBookingLinks.service');
const { expireDue } = require('./onlineBookingExpiry');
const common = require('./onlineBookingCommon');

// The desk's side of online booking (the Online booking screen):
//   waiting(business)            the requests to answer, soonest first, and those
//                                not answered in time (to call), each with the
//                                mobile's no-shows in 90 days
//   list(business, query)        every online booking, by the time booked for
//   accept / decline             a request answered; accepting may give another
//                                time or person agreed with the guest by phone,
//                                and a salon's deposit (a UPI advance with its UTR)
//   tomorrow / reminderSent      tomorrow's online bookings with the prepared
//                                WhatsApp reminder for those who agreed to reminders
//   bell(business, base)         requests waiting, new online bookings today, and
//                                requests not answered in time

const { fail } = common;
const id = (value, name = 'Online booking') => v.requiredId(value, name);

// The overall status of a booking from its appointments, with a request past
// its time read as expired (whether or not it has been marked yet).
const STATUS_SQL = `CASE WHEN bool_or(x.status='requested' AND x.request_expires_at>now()) THEN 'requested' WHEN bool_or(x.status='booked') THEN 'booked'
  WHEN bool_or(x.status='completed') THEN 'completed' WHEN bool_or(x.status='no_show') THEN 'no_show' WHEN bool_or(x.status='declined') THEN 'declined'
  WHEN bool_or(x.status IN ('expired','requested')) THEN 'expired' ELSE 'cancelled' END`;
// A mobile's no-shows at the business in the last 90 days, under any of its customers with that number.
const NO_SHOWS_SQL = `(SELECT count(*)::int FROM business_appointments n JOIN business_contacts nc ON nc.business_id=n.business_id AND nc.id=n.contact_id
  WHERE n.business_id=ob.business_id AND n.status='no_show' AND n.starts_at>now()-interval '90 days' AND ob.mobile IS NOT NULL
  AND right(regexp_replace(COALESCE(nc.phone,''),'\\D','','g'),10)=ob.mobile)`;
const BOOKINGS_SQL = `SELECT y.* FROM (SELECT ob.id,ob.location_id,l.name AS location_name,ob.created_at,ob.booker_name,ob.mobile,ob.contact_id,c.name AS contact_name,
    ob.for_whom,ob.person_name,ob.person_age,ob.person_sex,ob.visit_kind,ob.reason,ob.note,ob.vehicle_no,ob.vehicle_make,ob.vehicle_model,ob.vehicle_id,ob.lead_id,
    ob.request_reason,ob.advance_amount,ob.advance_utr,ob.advance_collection_id,k.collection_no AS advance_receipt_no,ob.decline_reason,ob.answered_at,u.name AS answered_by_name,
    ob.changes,ob.cancelled_by_guest_at,ob.reminder_sent_at,ob.consents,
    a.starts_at,a.ends_at,a.resource_id,a.resource_name,a.services,a.appointment_ids,a.request_expires_at,a.status,
    (a.starts_at AT TIME ZONE b.timezone)::date::text AS day,${NO_SHOWS_SQL} AS no_shows,
    EXISTS (SELECT 1 FROM business_consents q WHERE q.business_id=ob.business_id AND q.contact_id=ob.contact_id AND q.purpose='reminders' AND q.withdrawn_at IS NULL) AS reminders_ok
  FROM business_online_bookings ob JOIN businesses b ON b.id=ob.business_id
  JOIN business_locations l ON l.business_id=ob.business_id AND l.id=ob.location_id
  JOIN business_contacts c ON c.business_id=ob.business_id AND c.id=ob.contact_id
  LEFT JOIN users u ON u.id=ob.answered_by
  LEFT JOIN business_collections k ON k.business_id=ob.business_id AND k.id=ob.advance_collection_id
  JOIN LATERAL (SELECT min(x.starts_at) AS starts_at,max(x.ends_at) AS ends_at,(array_agg(x.resource_id ORDER BY x.starts_at))[1] AS resource_id,
      (array_agg(r.name ORDER BY x.starts_at))[1] AS resource_name,string_agg(s.label,' + ' ORDER BY x.starts_at) AS services,
      json_agg(x.id ORDER BY x.starts_at) AS appointment_ids,min(x.request_expires_at) AS request_expires_at,${STATUS_SQL} AS status
    FROM business_appointments x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
    JOIN business_resources r ON r.business_id=x.business_id AND r.id=x.resource_id
    WHERE x.business_id=ob.business_id AND x.online_booking_id=ob.id) a ON TRUE
  WHERE ob.business_id=$1) y`;

repo.addLists({
  'online-bookings': {
    sql: BOOKINGS_SQL,
    search: ['booker_name', 'mobile', 'contact_name', 'person_name', 'services', 'resource_name', 'vehicle_no', 'advance_utr', 'note'], date: 'starts_at',
    filters: { status: 'status', location: 'location_id', reason: 'request_reason', day: 'day' }, order: 'starts_at DESC,id DESC',
  },
});

const scopeOf = (business) => business.location_scope || business.member_location_id || null;

// The requests to answer (soonest first) and those not answered in time in the
// last two days, for the desk to call.
async function waiting(business) {
  links.requireBooking(business);
  await access.require(business, 'online_appointments.view');
  await expireDue(business.id);
  const rows = await repo.all(repo.pool, `${BOOKINGS_SQL} WHERE (y.status='requested' OR (y.status='expired' AND y.answered_at IS NULL AND y.starts_at>now()-interval '2 days'))
    AND ($2::bigint IS NULL OR y.location_id=$2) ORDER BY (y.status='requested') DESC,y.starts_at,y.id LIMIT 200`, [business.id, scopeOf(business)]);
  return { requests: rows.filter((r) => r.status === 'requested'), unanswered: rows.filter((r) => r.status === 'expired'), serverTime: new Date().toISOString() };
}

// Every online booking, paged as the business's lists are.
async function list(business, query) {
  links.requireBooking(business);
  await access.require(business, 'online_appointments.view');
  await expireDue(business.id);
  const limit = query.limit === undefined ? 25 : v.requiredId(query.limit, 'Page size');
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) fail('Invalid pagination');
  const filters = {};
  for (const key of ['status', 'reason', 'day']) if (typeof query[key] === 'string' && query[key]) filters[key] = query[key].slice(0, 30);
  if (query.location || scopeOf(business)) filters.location = String(query.location || scopeOf(business));
  const date = (value, name) => (value === undefined || value === '' ? null : core.dateText(value, name));
  const from = date(query.from, 'From date'), to = date(query.to, 'To date');
  if (from && to && to < from) fail('The end date is before the start date');
  const search = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : null;
  return repo.page(business.id, 'online-bookings', limit, offset, { search, from, to, timezone: business.timezone, filters });
}

async function rowOf(db, business, bookingId) {
  return repo.one(db, `${BOOKINGS_SQL} WHERE y.id=$2`, [business.id, bookingId]);
}

// Loads a booking for the desk to act on, locked; refuses what is not its to act on.
async function lockBooking(db, business, bookingId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  await expireDue(business.id, db);
  const loaded = await common.loadBooking(db, 'ob.business_id=$1 AND ob.id=$2', [business.id, id(bookingId)], { lock: true });
  if (!loaded) fail('Online booking not found', 404);
  access.requireLocation(business, loaded.booking.location_id);
  return loaded;
}
const notWaiting = (status) => fail(status === 'expired' ? 'This request was not answered in time and has expired. Call the guest to book them again.'
  : status === 'cancelled' ? 'The guest cancelled this request.' : `This booking is ${status.replace('_', '-')} already.`, 409, { reason: 'not_waiting', status });

// body: { requestKey, startsAt?, resourceId?, deposit?: { amount, method | methodId, reference? }, advanceReceived?: true }
// startsAt / resourceId: the time or person agreed with the guest by phone.
// A salon's deposit (the UPI advance the guest paid, or one the desk takes now)
// is recorded as the salon's deposit for the booking: a receipt in the
// customer's name, kept for the booking, with the UTR as its reference.
async function accept(business, user, bookingId, body) {
  links.requireBooking(business);
  await access.require(business, 'online_appointments.approve');
  const requestKey = core.uuid(body.requestKey);
  const result = await repo.transaction(async (db) => {
    const { booking, appointments } = await lockBooking(db, business, bookingId);
    const status = common.stateOf(appointments);
    if (status === 'booked' && booking.answered_by) return booking.id;
    if (status !== 'requested') notWaiting(status);
    const link = await repo.one(db, 'SELECT * FROM business_booking_links WHERE business_id=$1 AND id=$2', [business.id, booking.link_id]);
    // Another time or person, agreed with the guest by phone: the same rules
    // as the guest's own booking, without the notice and the window.
    const moving = (body.startsAt !== undefined && body.startsAt !== null && body.startsAt !== '') || (body.resourceId !== undefined && body.resourceId !== null && body.resourceId !== '');
    if (moving) {
      const starts = body.startsAt ? new Date(body.startsAt) : new Date(appointments[0].starts_at);
      if (!Number.isFinite(starts.getTime())) fail('Choose the new time');
      const clock = rules.clockOf(business.timezone);
      const at = rules.clockOf(business.timezone, starts.getTime());
      const deskLink = { ...link, min_notice_minutes: 0, days_ahead: 90 };
      const shown = await engine.offer(db, business, deskLink);
      const choice = await writes.choiceFor(db, business, deskLink, shown, appointments, { personId: body.resourceId ? v.requiredId(body.resourceId, 'Person') : Number(appointments[0].resource_id), everyone: true });
      const pick = await writes.pickTime(db, business, deskLink, shown, choice, { date: at.date, minutes: at.minutes, except: appointments.map((a) => Number(a.id)) }, clock);
      await writes.moveAppointments(db, business, shown, booking, appointments, pick, user);
    }
    let deposit = null;
    if (body.advanceReceived === true && booking.advance_amount) {
      deposit = { amount: booking.advance_amount, method: 'upi', reference: booking.advance_utr };
    } else if (body.deposit !== undefined && body.deposit !== null) {
      if (typeof body.deposit !== 'object' || Array.isArray(body.deposit)) fail('The deposit must be an object');
      deposit = body.deposit;
    }
    if (deposit) {
      if (business.business_type !== 'salon') fail('A deposit is taken on a salon\'s online booking only');
      await access.require(business, 'sales.edit');
      const amount = Math.round(core.decimal(deposit.amount, 'Deposit', 2, 1, 1000000) * 100);
      const { method, methodName } = await paymentMethods.pick(db, business.id, deposit, 'Deposit paid by', ['cash', 'card', 'upi', 'bank', 'cheque']);
      const reference = v.optionalString(deposit.reference, 'Reference', 100) || null;
      if (method === 'cheque' && !reference) fail('Enter the cheque number as the reference');
      const salon = require('../../salon-weight/services/businessSalon.service');
      const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, booking.location_id]);
      const contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, booking.contact_id]);
      const first = appointments[0];
      const collection = await salon.takeDeposit(db, business, user, { location, contact, amount, method, methodName, reference, requestKey,
        note: `Deposit for online booking ${String(booking.id).padStart(4, '0')}: ${appointments.map((a) => a.service_name).join(', ')} on ${rules.clockOf(business.timezone, new Date(first.starts_at).getTime()).date}` });
      await db.query('UPDATE salon_appointment_details SET deposit_collection_id=$3 WHERE business_id=$1 AND appointment_id=$2', [business.id, first.id, collection.id]);
      await db.query('UPDATE business_online_bookings SET advance_collection_id=$3 WHERE business_id=$1 AND id=$2', [business.id, booking.id, collection.id]);
    }
    const accepted = await repo.all(db, `UPDATE business_appointments a SET status='booked',request_expires_at=NULL WHERE a.business_id=$1 AND a.online_booking_id=$2 AND a.status='requested'
      RETURNING a.id,(SELECT r.location_id FROM business_resources r WHERE r.business_id=a.business_id AND r.id=a.resource_id) AS location_id`, [business.id, booking.id]);
    for (const a of accepted) {
      await repo.audit(db, business.id, user.id, 'appointment.accepted', a.id, { onlineBookingId: Number(booking.id), moved: moving || undefined });
      await repo.event(db, business.id, user.id, 'appointment.accepted', 'appointment', a.id, { status: 'booked', onlineBookingId: Number(booking.id), locationId: Number(a.location_id), source: 'guests_site' });
    }
    await db.query('UPDATE business_online_bookings SET answered_by=$3,answered_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, booking.id, user.id]);
    return booking.id;
  });
  return rowOf(repo.pool, business, result);
}

// body: { reason } — what the guest reads on their page.
async function decline(business, user, bookingId, body) {
  links.requireBooking(business);
  await access.require(business, 'online_appointments.approve');
  const reason = v.requiredString(body.reason, 'Reason the guest reads', 300);
  if (reason.trim().length < 3) fail('Write a few words the guest reads, like "Fully booked that evening"');
  const result = await repo.transaction(async (db) => {
    const { booking, appointments } = await lockBooking(db, business, bookingId);
    const status = common.stateOf(appointments);
    if (status === 'declined') return booking.id;
    if (status !== 'requested') notWaiting(status);
    const declined = await repo.all(db, `UPDATE business_appointments a SET status='declined',request_expires_at=NULL WHERE a.business_id=$1 AND a.online_booking_id=$2 AND a.status='requested'
      RETURNING a.id,(SELECT r.location_id FROM business_resources r WHERE r.business_id=a.business_id AND r.id=a.resource_id) AS location_id`, [business.id, booking.id]);
    for (const a of declined) {
      await repo.audit(db, business.id, user.id, 'appointment.declined', a.id, { onlineBookingId: Number(booking.id), reason });
      await repo.event(db, business.id, user.id, 'appointment.declined', 'appointment', a.id, { status: 'declined', onlineBookingId: Number(booking.id), locationId: Number(a.location_id), source: 'guests_site' });
    }
    await db.query('UPDATE business_online_bookings SET decline_reason=$3,answered_by=$4,answered_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, booking.id, reason, user.id]);
    return booking.id;
  });
  return rowOf(repo.pool, business, result);
}

// Tomorrow's online bookings at the location in view, each with whether the
// guest agreed to reminders (the WhatsApp reminder is prepared only for them).
async function tomorrow(business) {
  links.requireBooking(business);
  await access.require(business, 'online_appointments.view');
  await expireDue(business.id);
  const rows = await repo.all(repo.pool, `${BOOKINGS_SQL} WHERE y.status='booked' AND y.day=((now() AT TIME ZONE $3)::date + 1)::text
    AND ($2::bigint IS NULL OR y.location_id=$2) ORDER BY y.starts_at,y.id`, [business.id, scopeOf(business), business.timezone || 'Asia/Kolkata']);
  return { day: rules.addDays(rules.clockOf(business.timezone).date, 1), bookings: rows };
}

// The reminder was sent from the desk's own WhatsApp (wa.me): recorded, for a
// guest who agreed to reminders only.
async function reminderSent(business, user, bookingId) {
  links.requireBooking(business);
  await access.require(business, 'online_appointments.view');
  return repo.transaction(async (db) => {
    const loaded = await common.loadBooking(db, 'ob.business_id=$1 AND ob.id=$2', [business.id, id(bookingId)], { lock: true });
    if (!loaded) fail('Online booking not found', 404);
    access.requireLocation(business, loaded.booking.location_id);
    if (common.stateOf(loaded.appointments) !== 'booked') fail('Only a booking still to come gets a reminder', 409);
    await consents.requireReminder(db, business.id, loaded.booking.contact_id, 'whatsapp', loaded.booking.booker_name);
    const row = await repo.one(db, 'UPDATE business_online_bookings SET reminder_sent_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING reminder_sent_at',
      [business.id, loaded.booking.id]);
    await repo.audit(db, business.id, user.id, 'online_booking.reminder_sent', loaded.booking.id, { channel: 'whatsapp' });
    return { id: Number(loaded.booking.id), reminderSentAt: row.reminder_sent_at };
  });
}

// The bell: requests waiting (the soonest, and by when to answer), new online
// bookings today, and requests nobody answered in time.
async function bell(business, base) {
  await expireDue(business.id);
  if (!links.TYPES.includes(business.business_type) || !business.modules.includes('online_appointments') || !access.can(business, 'online_appointments.view')) return [];
  const scope = scopeOf(business);
  const tz = business.timezone || 'Asia/Kolkata';
  const items = [];
  const waitingRows = await repo.all(repo.pool, `${BOOKINGS_SQL} WHERE y.status='requested' AND ($2::bigint IS NULL OR y.location_id=$2) ORDER BY y.request_expires_at,y.id LIMIT 50`, [business.id, scope]);
  if (waitingRows.length) {
    const soonest = waitingRows[0];
    const latest = Math.max(...waitingRows.map((r) => Number(r.id)));
    const when = (value) => new Date(value).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz });
    items.push({ id: `online-requests:${latest}`, severity: 'warning', category: 'Online booking',
      title: `${waitingRows.length} online booking ${waitingRows.length === 1 ? 'request' : 'requests'} waiting`,
      detail: `${soonest.booker_name} · ${soonest.services}, ${when(soonest.starts_at)} · answer by ${when(soonest.request_expires_at)}`,
      at: new Date(soonest.created_at).toISOString(), link: `${base}/online-booking` });
  }
  const today = await repo.one(repo.pool, `SELECT count(*)::int AS n,max(z.id) AS latest,max(z.created_at) AS at FROM (${BOOKINGS_SQL}) z
    WHERE z.status IN ('booked','completed') AND (z.created_at AT TIME ZONE $3)::date=(now() AT TIME ZONE $3)::date AND ($2::bigint IS NULL OR z.location_id=$2)`,
  [business.id, scope, tz]);
  if (today && today.n > 0) {
    items.push({ id: `online-today:${today.latest}`, severity: 'info', category: 'Online booking',
      title: `${today.n} new online ${today.n === 1 ? 'booking' : 'bookings'} today`, detail: 'Booked by guests from your booking link', at: new Date(today.at).toISOString(),
      link: `${base}/online-booking?tab=bookings` });
  }
  const lapsed = await repo.all(repo.pool, `${BOOKINGS_SQL} WHERE y.status='expired' AND y.answered_at IS NULL AND y.request_expires_at>now()-interval '1 day'
    AND ($2::bigint IS NULL OR y.location_id=$2) ORDER BY y.request_expires_at DESC LIMIT 20`, [business.id, scope]);
  if (lapsed.length) {
    items.push({ id: `online-lapsed:${Math.max(...lapsed.map((r) => Number(r.id)))}`, severity: 'warning', category: 'Online booking',
      title: `${lapsed.length} online ${lapsed.length === 1 ? 'request was' : 'requests were'} not answered in time`,
      detail: `Call ${lapsed.slice(0, 3).map((r) => r.booker_name).join(', ')}${lapsed.length > 3 ? ' and others' : ''} to book again`,
      at: new Date(lapsed[0].request_expires_at).toISOString(), link: `${base}/online-booking` });
  }
  return items;
}

module.exports = { waiting, list, accept, decline, tomorrow, reminderSent, bell, BOOKINGS_SQL };
