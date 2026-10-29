const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./memberCommon');
const plans = require('./memberPlans.service');
const fees = require('./memberFees.service');

// Classes (module "member_plans"): rooms, the weekly timetable and the
// classes made from it on the business's calendar.
//
//   timetable  a class on a weekday at a time, in a room, with its instructor
//              (a trainer of Trainers & studios), its places, when booking
//              opens (hours before), the cancel cut-off (hours before) and the
//              waitlist. Each day's classes are made from it as they are read,
//              up to four weeks ahead, keeping the terms they were made with;
//              a change makes again those nobody has booked.
//   booking    a member books a class on a membership that runs that day,
//              lets them in at its branch and hours, books that class (its
//              plan's classes), is not frozen, and on a pack has a session
//              left beyond those already booked. A full class puts them on its
//              waitlist (while it has room); a place that frees promotes the
//              first on the waitlist. The class is locked first, so two asking
//              for the last place at once are one in and one waitlisted.
//   cancel     before the cut-off, free; after it (until the class begins) a
//              late cancel, with the shop's penalty: a session off the pack or
//              a fee (Settings › Membership plans).
//   attendance marked at check-in (a class starting within the hour or begun
//              up to half an hour ago) or on the class list; a pack loses a
//              session per class attended. A no-show (marked once the class
//              has begun) takes the shop's penalty too.
//   call off   a class nobody will take: its bookings are cancelled, no penalty.

const { fail, id } = c;
const AHEAD_DAYS = 27;
const HELD = ['booked', 'promoted', 'attended', 'no_show'];
const STATUS_WORDS = { booked: 'booked', waitlisted: 'on the waitlist', promoted: 'promoted from the waitlist', attended: 'attended', no_show: 'a no-show',
  cancelled: 'cancelled', late_cancel: 'a late cancel' };

const whole = (value, name, min, max) => Number(core.decimal(value, name, 0, min, max));
function readTime(value, name) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) fail(`${name} must be a time of day such as 07:00 or 18:30`);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

// --- Rooms -----------------------------------------------------------------------------------------------

async function rooms(business) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  return repo.all(repo.pool, `SELECT r.id,r.location_id,l.name AS location_name,r.name,r.capacity,r.active FROM member_rooms r
    JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id WHERE r.business_id=$1 ORDER BY r.active DESC,l.name,lower(r.name)`, [business.id]);
}

// body: { locationId, name, capacity, active? }
async function saveRoom(business, user, roomId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const name = v.requiredString(typeof body.name === 'string' ? body.name : '', 'Room', 80);
  const capacity = whole(body.capacity, 'Places in the room', 1, 500);
  const active = v.requiredBoolean(body.active, 'In use', true);
  return repo.transaction(async (db) => {
    if (roomId) {
      const old = await repo.one(db, 'SELECT * FROM member_rooms WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(roomId, 'Room')]);
      if (!old) fail('Room not found', 404);
      access.requireLocation(business, old.location_id);
      const row = await repo.one(db, 'UPDATE member_rooms SET name=$3,capacity=$4,active=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
        [business.id, old.id, name, capacity, active, user.id]);
      await repo.audit(db, business.id, user.id, 'member_room.updated', row.id, { name, capacity, active });
      return row;
    }
    const locationId = id(body.locationId, 'Location');
    access.requireLocation(business, locationId);
    if (!await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId])) fail('Location not found', 404);
    const row = await repo.one(db, 'INSERT INTO member_rooms(business_id,location_id,name,capacity,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *',
      [business.id, locationId, name, capacity, active, user.id]);
    await repo.audit(db, business.id, user.id, 'member_room.created', row.id, { name, capacity, locationId });
    return row;
  });
}

// --- The timetable -------------------------------------------------------------------------------------

const SLOTS_SQL = `SELECT s.id,s.location_id,l.name AS location_name,s.room_id,r.name AS room_name,s.class_name,s.weekday,to_char(s.starts_at,'HH24:MI') AS starts_at,s.minutes,
    s.trainer_id,t.name AS trainer_name,s.capacity,s.book_hours,s.cancel_hours,s.waitlist_size,s.active
  FROM member_class_slots s JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id
  JOIN member_rooms r ON r.business_id=s.business_id AND r.id=s.room_id LEFT JOIN business_resources t ON t.business_id=s.business_id AND t.id=s.trainer_id
  WHERE s.business_id=$1`;

async function slots(business) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  return repo.all(repo.pool, `${SLOTS_SQL} ORDER BY s.active DESC,s.weekday,s.starts_at,s.id`, [business.id]);
}

// body: { roomId, className, weekday (1 Monday … 7 Sunday), startsAt (HH:MM), minutes, trainerId?, capacity?, bookHours?, cancelHours?, waitlistSize?, active? }
async function saveSlot(business, user, slotId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const input = {
    roomId: id(body.roomId, 'Room'), className: v.requiredString(typeof body.className === 'string' ? body.className : '', 'Class', 80).trim(),
    weekday: whole(body.weekday, 'Weekday', 1, 7), startsAt: readTime(body.startsAt, 'Starts at'), minutes: whole(body.minutes, 'Minutes', 5, 600),
    trainerId: c.given(body.trainerId) ? id(body.trainerId, 'Instructor') : null, bookHours: c.given(body.bookHours) ? whole(body.bookHours, 'Booking opens (hours before)', 1, 720) : 168,
    cancelHours: c.given(body.cancelHours) ? whole(body.cancelHours, 'Cancel cut-off (hours before)', 0, 168) : 2,
    waitlistSize: c.given(body.waitlistSize) ? whole(body.waitlistSize, 'Waitlist', 0, 100) : 0, active: v.requiredBoolean(body.active, 'On the timetable', true),
  };
  if (input.cancelHours >= input.bookHours) fail('The cancel cut-off comes after booking opens');
  return repo.transaction(async (db) => {
    const room = await repo.one(db, 'SELECT * FROM member_rooms WHERE business_id=$1 AND id=$2 AND active', [business.id, input.roomId]);
    if (!room) fail('Room not found', 404);
    access.requireLocation(business, room.location_id);
    const capacity = c.given(body.capacity) ? whole(body.capacity, 'Places', 1, 500) : Number(room.capacity);
    if (capacity > Number(room.capacity)) fail(`${room.name} holds ${room.capacity}`);
    if (input.trainerId && !await repo.one(db, 'SELECT 1 FROM business_resources WHERE business_id=$1 AND id=$2 AND active', [business.id, input.trainerId])) fail('Instructor not found', 404);
    const values = [room.location_id, room.id, input.className, input.weekday, input.startsAt, input.minutes, input.trainerId, capacity, input.bookHours, input.cancelHours,
      input.waitlistSize, input.active, user.id];
    let row;
    if (slotId) {
      const old = await repo.one(db, 'SELECT * FROM member_class_slots WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(slotId, 'Class')]);
      if (!old) fail('Class not found', 404);
      access.requireLocation(business, old.location_id);
      row = await repo.one(db, `UPDATE member_class_slots SET location_id=$3,room_id=$4,class_name=$5,weekday=$6,starts_at=$7,minutes=$8,trainer_id=$9,capacity=$10,book_hours=$11,
        cancel_hours=$12,waitlist_size=$13,active=$14,updated_by=$15,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING id`, [business.id, old.id, ...values]);
      // Classes to come that nobody has booked are made again with the new terms.
      await db.query(`DELETE FROM member_class_sessions s WHERE s.business_id=$1 AND s.slot_id=$2 AND s.starts_at>now() AND s.cancelled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM member_class_bookings b WHERE b.business_id=s.business_id AND b.session_id=s.id)`, [business.id, old.id]);
      await repo.audit(db, business.id, user.id, 'member_class.updated', row.id, { className: input.className, weekday: input.weekday, startsAt: input.startsAt, active: input.active });
    } else {
      row = await repo.one(db, `INSERT INTO member_class_slots(business_id,location_id,room_id,class_name,weekday,starts_at,minutes,trainer_id,capacity,book_hours,cancel_hours,
        waitlist_size,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`, [business.id, ...values]);
      await repo.audit(db, business.id, user.id, 'member_class.created', row.id, { className: input.className, weekday: input.weekday, startsAt: input.startsAt });
    }
    return repo.one(db, `${SLOTS_SQL} AND s.id=$2`, [business.id, row.id]);
  });
}

// --- Classes on the calendar --------------------------------------------------------------------------------

// Makes the timetable's classes from `from` to `to` (today or later, within
// four weeks), each once, with the terms of its entry now.
async function makeSessions(db, business, from, to) {
  const day = await c.today(db, business);
  const first = from > day ? from : day;
  const last = to < c.addDays(day, AHEAD_DAYS) ? to : c.addDays(day, AHEAD_DAYS);
  if (last < first) return;
  await db.query(`INSERT INTO member_class_sessions(business_id,slot_id,location_id,room_id,trainer_id,class_name,day,starts_at,ends_at,capacity,book_from,cancel_until,waitlist_size)
    SELECT s.business_id,s.id,s.location_id,s.room_id,s.trainer_id,s.class_name,d.day,(d.day+s.starts_at) AT TIME ZONE $4,
      ((d.day+s.starts_at) AT TIME ZONE $4)+make_interval(mins => s.minutes),s.capacity,((d.day+s.starts_at) AT TIME ZONE $4)-make_interval(hours => s.book_hours),
      ((d.day+s.starts_at) AT TIME ZONE $4)-make_interval(hours => s.cancel_hours),s.waitlist_size
    FROM member_class_slots s CROSS JOIN LATERAL (SELECT g::date AS day FROM generate_series($2::date,$3::date,interval '1 day') g) d
    WHERE s.business_id=$1 AND s.active AND extract(isodow FROM d.day)=s.weekday
    ON CONFLICT (business_id,slot_id,day) DO NOTHING`, [business.id, first, last, business.timezone || 'Asia/Kolkata']);
}

const SESSIONS_SQL = `SELECT s.id,s.slot_id,s.location_id,l.name AS location_name,s.room_id,r.name AS room_name,s.trainer_id,t.name AS trainer_name,s.class_name,s.day::text AS day,
    s.starts_at,s.ends_at,to_char(s.starts_at AT TIME ZONE b.timezone,'HH24:MI') AS time,s.capacity,s.book_from,s.cancel_until,s.waitlist_size,s.cancelled_at,s.cancel_reason,
    (SELECT count(*)::int FROM member_class_bookings k WHERE k.business_id=s.business_id AND k.session_id=s.id AND k.status IN ('booked','promoted','attended','no_show')) AS held,
    (SELECT count(*)::int FROM member_class_bookings k WHERE k.business_id=s.business_id AND k.session_id=s.id AND k.status='waitlisted') AS waiting,
    (SELECT count(*)::int FROM member_class_bookings k WHERE k.business_id=s.business_id AND k.session_id=s.id AND k.status='attended') AS attended,
    (now()>=s.starts_at) AS begun,(now()>=s.book_from AND now()<s.starts_at) AS open,(now()>=s.cancel_until) AS past_cutoff
  FROM member_class_sessions s JOIN businesses b ON b.id=s.business_id JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id
  JOIN member_rooms r ON r.business_id=s.business_id AND r.id=s.room_id LEFT JOIN business_resources t ON t.business_id=s.business_id AND t.id=s.trainer_id
  WHERE s.business_id=$1`;

// The classes of some days (a week from `from`, today by default), made from the timetable first.
async function week(business, query) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  const day = await c.today(repo.pool, business);
  const from = c.given(query.from) ? c.readDate(query.from, 'From') : day;
  const days = c.given(query.days) ? whole(query.days, 'Days', 1, 14) : 7;
  const to = c.addDays(from, days - 1);
  const locationId = c.given(query.location) ? id(query.location, 'Location') : null;
  await repo.transaction((db) => makeSessions(db, business, from, to));
  const sessions = await repo.all(repo.pool, `${SESSIONS_SQL} AND s.day BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR s.location_id=$4) ORDER BY s.starts_at,s.id`,
    [business.id, from, to, locationId]);
  return { from, to, today: day, sessions };
}

// A class with its bookings, in the order they were made.
async function session(business, sessionId) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  return sessionOf(repo.pool, business, id(sessionId, 'Class'));
}
async function sessionOf(db, business, sessionId) {
  const s = await repo.one(db, `${SESSIONS_SQL} AND s.id=$2`, [business.id, sessionId]);
  if (!s) fail('Class not found', 404);
  const bookings = await repo.all(db, `SELECT k.id,k.contact_id,ct.name AS member_name,ct.phone AS member_phone,pr.member_code,k.membership_id,m.membership_no,m.plan_name,k.status,
      k.promoted_at,k.session_used,k.penalty,k.created_at,k.marked_at,u.name AS by_name
    FROM member_class_bookings k JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id
    LEFT JOIN member_profiles pr ON pr.business_id=k.business_id AND pr.contact_id=k.contact_id
    JOIN member_memberships m ON m.business_id=k.business_id AND m.id=k.membership_id JOIN users u ON u.id=k.created_by
    WHERE k.business_id=$1 AND k.session_id=$2 ORDER BY CASE WHEN k.status IN ('cancelled','late_cancel') THEN 1 ELSE 0 END,k.id`, [business.id, sessionId]);
  return { ...s, bookings };
}

// --- Booking -----------------------------------------------------------------------------------------------

// Why a membership does not book a class, or null when it does. `m`: the
// membership with its frozen days and the sessions already booked on it.
function bookingRefusal(m, s) {
  if (s.day < m.start_on) return `${m.membership_no} starts on ${c.dateWords(m.start_on)}`;
  if (m.end_on && s.day > c.addDays(m.end_on, Number(m.grace_days))) return `${m.membership_no} ends on ${c.dateWords(m.end_on)}`;
  if (m.frozen) return `${m.membership_no} is frozen on ${c.dateWords(s.day)}`;
  if (m.class_names && !m.class_names.some((n) => n.toLowerCase() === s.class_name.toLowerCase())) return `${m.plan_name} does not book ${s.class_name}`;
  if (m.access_locations && !m.access_locations.map(Number).includes(Number(s.location_id))) return `${m.plan_name} is not for ${s.location_name}`;
  if (m.access_from && (s.time < c.hhmm(m.access_from) || s.time >= c.hhmm(m.access_to))) return `${m.plan_name} lets the member in from ${c.hhmm(m.access_from)} to ${c.hhmm(m.access_to)}`;
  if (m.sessions_total && Number(m.sessions_total) - Number(m.sessions_used) - Number(m.booked) <= 0) return `${m.membership_no} has no session left beyond those booked`;
  return null;
}

// The member's memberships that are not closed (theirs or a seat), locked, with what booking needs.
async function membershipsFor(db, business, contactId, s) {
  return repo.all(db, `SELECT m.id,m.membership_no,m.plan_name,m.contact_id,m.start_on::text AS start_on,m.end_on::text AS end_on,m.grace_days,m.sessions_total,m.sessions_used,
      m.class_names,m.access_locations,m.access_from::text AS access_from,m.access_to::text AS access_to,m.origin,m.plan_id,m.location_id,
      EXISTS (SELECT 1 FROM member_freezes f WHERE f.business_id=m.business_id AND f.membership_id=m.id AND f.days>0 AND $3::date BETWEEN f.starts_on AND f.starts_on+f.days-1) AS frozen,
      (SELECT count(*)::int FROM member_class_bookings k WHERE k.business_id=m.business_id AND k.membership_id=m.id AND k.status IN ('booked','promoted')) AS booked
    FROM member_memberships m WHERE m.business_id=$1 AND m.closed IS NULL
      AND ((m.seats=1 AND m.contact_id=$2) OR (m.seats>1 AND EXISTS (SELECT 1 FROM member_seats z WHERE z.business_id=m.business_id AND z.membership_id=m.id AND z.contact_id=$2
        AND z.removed_at IS NULL)))
    ORDER BY (m.sessions_total IS NOT NULL),m.end_on NULLS LAST,m.id FOR UPDATE OF m`, [business.id, contactId, s?.day || '1900-01-01']);
}

// body: { requestKey, contactId | code, membershipId? }
async function book(business, user, sessionId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  const requestKey = core.uuid(body.requestKey);
  return repo.transaction(async (db) => {
    const old = await repo.one(db, 'SELECT id,session_id FROM member_class_bookings WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) return sessionOf(db, business, old.session_id);
    const member = c.given(body.contactId)
      ? await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(body.contactId, 'Member')])
      : await repo.one(db, `SELECT ct.id,ct.name FROM member_profiles pr JOIN business_contacts ct ON ct.business_id=pr.business_id AND ct.id=pr.contact_id
          WHERE pr.business_id=$1 AND pr.member_code=$2`, [business.id, String(body.code ?? '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 20)]);
    if (!member) fail('Member not found', 404);
    const plain = await repo.one(db, `${SESSIONS_SQL} AND s.id=$2`, [business.id, id(sessionId, 'Class')]);
    if (!plain) fail('Class not found', 404);
    access.requireLocation(business, plain.location_id);
    // The member's memberships, then the class: one lock order with check-ins.
    const list = await membershipsFor(db, business, member.id, plain);
    await db.query('SELECT id FROM member_class_sessions WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, plain.id]);
    const s = await repo.one(db, `${SESSIONS_SQL} AND s.id=$2`, [business.id, plain.id]);
    if (s.cancelled_at) fail(`The ${s.class_name} class on ${c.dateWords(s.day)} was called off`, 409);
    if (s.begun) fail(`The ${s.class_name} class on ${c.dateWords(s.day)} has begun`, 409, { reason: 'begun' });
    if (!s.open) {
      const opens = await repo.one(db, "SELECT to_char($2::timestamptz AT TIME ZONE $1,'DD Mon YYYY HH24:MI') AS at", [business.timezone || 'Asia/Kolkata', s.book_from]);
      fail(`Booking for the ${s.class_name} class on ${c.dateWords(s.day)} opens on ${opens.at}`, 409, { reason: 'not_open' });
    }
    if (await repo.one(db, "SELECT 1 FROM member_class_bookings WHERE business_id=$1 AND session_id=$2 AND contact_id=$3 AND status NOT IN ('cancelled','late_cancel')",
      [business.id, s.id, member.id])) fail(`${member.name} is booked in this class already`, 409);
    let chosen;
    if (c.given(body.membershipId)) {
      chosen = list.find((m) => Number(m.id) === Number(body.membershipId));
      if (!chosen) fail('That membership is not this member\'s, or is closed', 404);
      const why = bookingRefusal(chosen, s);
      if (why) fail(`${member.name} cannot book this class: ${why}`, 409, { reason: 'not_eligible' });
    } else {
      chosen = list.find((m) => !bookingRefusal(m, s));
      if (!chosen) fail(`${member.name} cannot book this class: ${list.length ? bookingRefusal(list[0], s) : 'no membership is running'}`, 409, { reason: 'not_eligible' });
    }
    const status = Number(s.held) < Number(s.capacity) ? 'booked' : Number(s.waiting) < Number(s.waitlist_size) ? 'waitlisted' : null;
    if (!status) fail(`The ${s.class_name} class is full${Number(s.waitlist_size) ? ', and so is its waitlist' : ''}`, 409, { reason: 'class_full' });
    const row = await repo.one(db, `INSERT INTO member_class_bookings(business_id,session_id,contact_id,membership_id,status,request_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [business.id, s.id, member.id, chosen.id, status, requestKey, user.id]);
    await repo.audit(db, business.id, user.id, status === 'booked' ? 'member_class.booked' : 'member_class.waitlisted', row.id,
      { member: member.name, className: s.class_name, day: s.day, time: s.time, membershipNo: chosen.membership_no });
    return { ...(await sessionOf(db, business, s.id)), booking: { id: row.id, status } };
  });
}

// The first on the waitlist takes a place that freed, while the class has not begun.
async function promote(db, business, user, s) {
  if (s.begun || s.cancelled_at) return null;
  const counts = await repo.one(db, `SELECT count(*) FILTER (WHERE status IN ('booked','promoted','attended','no_show'))::int AS held FROM member_class_bookings
    WHERE business_id=$1 AND session_id=$2`, [business.id, s.id]);
  if (counts.held >= Number(s.capacity)) return null;
  const next = await repo.one(db, `SELECT k.id,ct.name FROM member_class_bookings k JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id
    WHERE k.business_id=$1 AND k.session_id=$2 AND k.status='waitlisted' ORDER BY k.id LIMIT 1 FOR UPDATE OF k`, [business.id, s.id]);
  if (!next) return null;
  await db.query("UPDATE member_class_bookings SET status='promoted',promoted_at=now() WHERE business_id=$1 AND id=$2", [business.id, next.id]);
  await repo.audit(db, business.id, user.id, 'member_class.promoted', next.id, { member: next.name, className: s.class_name, day: s.day, time: s.time });
  return next;
}

// The shop's penalty for a late cancel or a no-show: a session off the pack (while one is left) or a fee.
async function penalise(db, business, user, booking, s, kind) {
  const settings = await plans.settingsOf(db, business.id);
  const rule = kind === 'late_cancel' ? settings.lateCancelPenalty : settings.noShowPenalty;
  if (rule === 'none') return { penalty: null };
  const m = await repo.one(db, 'SELECT * FROM member_memberships WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, booking.membership_id]);
  if (rule === 'session') {
    if (!m.sessions_total || m.closed || Number(m.sessions_used) >= Number(m.sessions_total)) return { penalty: null };
    await db.query('UPDATE member_memberships SET sessions_used=sessions_used+1,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, m.id]);
    return { penalty: 'session', sessionUsed: true };
  }
  if (m.origin === 'trial') return { penalty: null };
  const label = `${s.class_name} on ${c.dateWords(s.day)} at ${s.time}`;
  const bill = await fees.bill(db, business, user, m, { kind, amount: c.paise(settings.penaltyFee), label, requestKey: c.derivedKey(String(booking.request_key), kind),
    extra: { bookingId: booking.id } });
  return { penalty: 'fee', documentNo: bill.document_no, total: bill.total };
}

// Locks a booking with its member's memberships and its class (one lock order with check-ins).
async function lockBooking(db, business, bookingId) {
  const found = await repo.one(db, 'SELECT id,contact_id,session_id FROM member_class_bookings WHERE business_id=$1 AND id=$2', [business.id, id(bookingId, 'Booking')]);
  if (!found) fail('Booking not found', 404);
  await membershipsFor(db, business, found.contact_id, null);
  await db.query('SELECT id FROM member_class_sessions WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, found.session_id]);
  const booking = await repo.one(db, `SELECT k.*,ct.name AS member_name FROM member_class_bookings k JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id
    WHERE k.business_id=$1 AND k.id=$2 FOR UPDATE OF k`, [business.id, found.id]);
  const s = await repo.one(db, `${SESSIONS_SQL} AND s.id=$2`, [business.id, found.session_id]);
  access.requireLocation(business, s.location_id);
  return { booking, s };
}

// The member (or the desk for them) cancels: free before the cut-off, a late cancel after it.
async function cancelBooking(business, user, bookingId) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  return repo.transaction(async (db) => {
    const { booking, s } = await lockBooking(db, business, bookingId);
    if (['cancelled', 'late_cancel'].includes(booking.status)) return sessionOf(db, business, s.id);
    if (!['booked', 'promoted', 'waitlisted'].includes(booking.status)) fail(`This booking is ${STATUS_WORDS[booking.status]}: it is not cancelled`, 409);
    if (s.begun) fail(`The ${s.class_name} class has begun: mark the member attended or a no-show instead`, 409);
    const late = booking.status !== 'waitlisted' && s.past_cutoff;
    const result = late ? await penalise(db, business, user, booking, s, 'late_cancel') : { penalty: null };
    await db.query('UPDATE member_class_bookings SET status=$3,penalty=$4,session_used=$5,marked_by=$6,marked_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, booking.id, late ? 'late_cancel' : 'cancelled', result.penalty, Boolean(result.sessionUsed), user.id]);
    await repo.audit(db, business.id, user.id, late ? 'member_class.late_cancelled' : 'member_class.cancelled', booking.id, { member: booking.member_name, className: s.class_name,
      day: s.day, time: s.time, ...(result.penalty ? { penalty: result.penalty } : {}), ...(result.documentNo ? { documentNo: result.documentNo } : {}) });
    const promoted = booking.status === 'waitlisted' ? null : await promote(db, business, user, s);
    return { ...(await sessionOf(db, business, s.id)), late, penalty: result.penalty, promoted: promoted ? promoted.name : null };
  });
}

// Attended: a pack loses a session (while one is left).
async function attend(db, business, user, booking, s) {
  const m = await repo.one(db, 'SELECT id,sessions_total,sessions_used,closed FROM member_memberships WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, booking.membership_id]);
  const take = Boolean(m.sessions_total) && !m.closed && Number(m.sessions_used) < Number(m.sessions_total);
  if (take) await db.query('UPDATE member_memberships SET sessions_used=sessions_used+1,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, m.id]);
  await db.query("UPDATE member_class_bookings SET status='attended',session_used=$3,marked_by=$4,marked_at=now() WHERE business_id=$1 AND id=$2", [business.id, booking.id, take, user.id]);
  await repo.audit(db, business.id, user.id, 'member_class.attended', booking.id, { member: booking.member_name, className: s.class_name, day: s.day, time: s.time, sessionUsed: take });
  return take;
}

// body: { status: attended | no_show } — marked on the class list.
async function mark(business, user, bookingId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  const status = v.requiredEnum(body.status, 'Attendance', ['attended', 'no_show']);
  return repo.transaction(async (db) => {
    const { booking, s } = await lockBooking(db, business, bookingId);
    if (booking.status === status) return sessionOf(db, business, s.id);
    if (!['booked', 'promoted'].includes(booking.status)) fail(`This booking is ${STATUS_WORDS[booking.status]}: its attendance is not marked`, 409);
    if (s.cancelled_at) fail(`The ${s.class_name} class was called off`, 409);
    const day = await c.today(db, business);
    if (s.day > day) fail(`The ${s.class_name} class is on ${c.dateWords(s.day)}: attendance is marked on the day`, 409);
    if (status === 'attended') {
      await attend(db, business, user, booking, s);
      return sessionOf(db, business, s.id);
    }
    if (!s.begun) fail(`The ${s.class_name} class has not begun: a no-show is marked once it has`, 409);
    const result = await penalise(db, business, user, booking, s, 'no_show');
    await db.query("UPDATE member_class_bookings SET status='no_show',penalty=$3,session_used=$4,marked_by=$5,marked_at=now() WHERE business_id=$1 AND id=$2",
      [business.id, booking.id, result.penalty, Boolean(result.sessionUsed), user.id]);
    await repo.audit(db, business.id, user.id, 'member_class.no_show', booking.id, { member: booking.member_name, className: s.class_name, day: s.day, time: s.time,
      ...(result.penalty ? { penalty: result.penalty } : {}), ...(result.documentNo ? { documentNo: result.documentNo } : {}) });
    return { ...(await sessionOf(db, business, s.id)), penalty: result.penalty };
  });
}

// At check-in: the member's classes booked now (starting within the hour, or
// begun up to half an hour ago) are attended. Inside the check-in's transaction,
// with the member's memberships locked.
async function attendAtCheckIn(db, business, user, contactId) {
  const due = await repo.all(db, `SELECT k.id FROM member_class_bookings k JOIN member_class_sessions s ON s.business_id=k.business_id AND s.id=k.session_id
    WHERE k.business_id=$1 AND k.contact_id=$2 AND k.status IN ('booked','promoted') AND s.cancelled_at IS NULL
      AND s.starts_at BETWEEN now()-interval '30 minutes' AND now()+interval '60 minutes' ORDER BY s.starts_at`, [business.id, contactId]);
  const done = [];
  for (const row of due) {
    const found = await repo.one(db, 'SELECT session_id FROM member_class_bookings WHERE business_id=$1 AND id=$2', [business.id, row.id]);
    await db.query('SELECT id FROM member_class_sessions WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, found.session_id]);
    const booking = await repo.one(db, `SELECT k.*,ct.name AS member_name FROM member_class_bookings k JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id
      WHERE k.business_id=$1 AND k.id=$2 FOR UPDATE OF k`, [business.id, row.id]);
    const s = await repo.one(db, `${SESSIONS_SQL} AND s.id=$2`, [business.id, found.session_id]);
    const took = await attend(db, business, user, booking, s);
    done.push({ id: booking.id, className: s.class_name, time: s.time, sessionUsed: took });
  }
  return done;
}

// body: { reason } — a class called off before it begins: its bookings cancelled without penalty.
async function callOff(business, user, sessionId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  return repo.transaction(async (db) => {
    const s = await repo.one(db, `${SESSIONS_SQL} AND s.id=$2`, [business.id, id(sessionId, 'Class')]);
    if (!s) fail('Class not found', 404);
    access.requireLocation(business, s.location_id);
    await db.query('SELECT id FROM member_class_sessions WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, s.id]);
    if (s.cancelled_at) return sessionOf(db, business, s.id);
    if (s.begun) fail(`The ${s.class_name} class has begun: it is not called off`, 409);
    await db.query('UPDATE member_class_sessions SET cancelled_at=now(),cancelled_by=$3,cancel_reason=$4 WHERE business_id=$1 AND id=$2', [business.id, s.id, user.id, reason]);
    const cancelled = await db.query(`UPDATE member_class_bookings SET status='cancelled',marked_by=$3,marked_at=now() WHERE business_id=$1 AND session_id=$2
      AND status IN ('booked','promoted','waitlisted')`, [business.id, s.id, user.id]);
    await repo.audit(db, business.id, user.id, 'member_class.called_off', s.id, { className: s.class_name, day: s.day, time: s.time, reason, bookings: cancelled.rowCount });
    return sessionOf(db, business, s.id);
  });
}

module.exports = { rooms, saveRoom, slots, saveSlot, week, session, book, cancelBooking, mark, callOff, attendAtCheckIn, makeSessions, bookingRefusal, STATUS_WORDS, HELD };
