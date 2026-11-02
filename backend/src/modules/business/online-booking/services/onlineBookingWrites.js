const repo = require('../../core/repositories/business.repository');
const core = require('../../core/services/business.service');
const engine = require('./onlineBookingEngine');
const rules = require('./onlineBookingRules');
const { fail, derivedKey, hashOf } = require('./onlineBookingCommon');

// Writing an online booking's appointments, always inside the caller's
// transaction after it took the business's lock: a guest's booking, a guest's
// change of time, and the desk accepting a request at another time or with
// another person. Each kind books through its own rules:
//   salon   businessSalon.service.js bookIn (skills, the salon's hours, the
//           stylist's week, leave and holidays, rooms, clashes), and for a
//           change, the same checks the calendar's Move makes
//   clinic  the doctor's OPD sessions and leave (availabilityProblem) and the
//           core's clash check
//   hours   the location's opening hours (worked out when the time was picked)
//           and the core's clash check
// so no path can book a person twice.

const salon = () => require('../../salon-weight/services/businessSalon.service');
const clinicDesk = () => require('../../health/services/businessClinicDesk.service');
const lengthOf = (a) => Math.round((new Date(a.ends_at) - new Date(a.starts_at)) / 60000);
const taken = (message) => fail(message, 409, { reason: 'slot_taken', next: [] });

// The time and person asked for, checked again now: { personId, rooms, startsMs },
// or 409 slot_taken with the next free times.
async function pickTime(db, business, link, shown, choice, { date, minutes, except = [] }, clock) {
  const held = await engine.taken(db, business, link, shown, choice.people, { from: date, to: date, except });
  const day = engine.dayTimes(business, link, shown, choice, held, date, clock);
  const found = day.times.find((t) => t.minutes === minutes);
  const pick = found ? (choice.person ? found.people.find((p) => p.id === choice.person) : rules.pickAny(found.people, day.people || [])) : null;
  if (!pick) {
    const lastDate = rules.addDays(clock.date, Number(link.days_ahead) - 1);
    const next = date > lastDate ? [] : await engine.nextFree(db, business, link, shown, choice, { fromDate: date, afterMinutes: minutes, lastDate, except }, clock);
    fail(`Sorry, ${rules.timeLabel(minutes)} on ${rules.dateLabel(date)} is no longer free. ${next.length ? 'Here are the next free times.' : 'Please pick another day.'}`,
      409, { reason: 'slot_taken', next });
  }
  return { personId: pick.id, rooms: pick.rooms, startsMs: found.startsMs };
}

// A booking's new appointments, one per service back to back.
//   at: { personId, rooms, startsMs }, status: booked | requested, expiresAt
async function createAppointments(db, business, shown, choice, booking, at, { status, expiresAt, note }) {
  if (shown.kind === 'salon') {
    const made = [];
    let startMs = at.startsMs;
    for (const [i, step] of choice.plan.entries()) {
      const starts = new Date(startMs);
      const body = { contactId: booking.contact_id, skuId: step.skuId, resourceId: at.personId, roomId: at.rooms[i] || null, startsAt: starts.toISOString() };
      const key = derivedKey(booking.guest_token, `service-${i}`);
      made.push(await salon().bookIn(db, business, null, body, { requestKey: key, hash: hashOf({ key, body }), starts, deposit: null, notes: i === 0 ? note : null, override: null },
        { guest: { onlineBookingId: Number(booking.id), status, expiresAt } }));
      startMs += step.block * 60000;
    }
    return made;
  }
  const step = choice.plan[0];
  const staff = await repo.one(db, 'SELECT * FROM business_resources WHERE business_id=$1 AND id=$2 AND active FOR UPDATE', [business.id, at.personId]);
  if (!staff) taken('That person is not taking bookings now. Please pick another.');
  const starts = new Date(at.startsMs), ends = new Date(at.startsMs + step.block * 60000);
  if (shown.kind === 'clinic') {
    const problem = await clinicDesk().availabilityProblem(db, business, staff.id, starts, ends);
    if (problem) taken(`${problem}. Please pick another time.`);
  }
  if (await core.appointmentClash(db, business.id, staff.id, starts, ends)) taken('Sorry, that time has just been taken. Please pick another.');
  const row = await repo.one(db, `INSERT INTO business_appointments(business_id,resource_id,contact_id,sku_id,starts_at,ends_at,created_by,source,online_booking_id,status,request_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,NULL,'guests_site',$7,$8,$9) RETURNING *`,
  [business.id, staff.id, booking.contact_id, step.skuId, starts, ends, booking.id, status, status === 'requested' ? expiresAt : null]);
  await repo.guestAudit(db, business.id, `appointment.${status}`, row.id, { onlineBookingId: Number(booking.id) });
  await repo.event(db, business.id, null, `appointment.${status}`, 'appointment', row.id, { resourceId: Number(staff.id), contactId: Number(booking.contact_id), skuId: step.skuId,
    startsAt: row.starts_at, endsAt: row.ends_at, locationId: Number(staff.location_id), source: 'guests_site', onlineBookingId: Number(booking.id) });
  return [row];
}

// The choice behind a booking already made, for picking it a new time: its
// own services at their own lengths, with the same person or (personId null)
// anyone who does them. `everyone`: the desk may give it anyone active at
// the location, not only those shown online.
async function choiceFor(db, business, link, shown, appointments, { personId, everyone = false }) {
  let people = shown.people;
  if (everyone) people = (await engine.offer(db, business, link, { all: true })).people.filter((p) => shown.kind !== 'clinic' || p.ready);
  const own = Number(appointments[0].resource_id);
  if (!people.some((p) => p.id === own)) {
    const all = (await engine.offer(db, business, link, { all: true })).people;
    const mine = all.find((p) => p.id === own);
    if (mine) people = [...people, mine];
  }
  const plan = appointments.map((a) => ({ skuId: Number(a.sku_id), label: a.service_name, minutes: lengthOf(a), block: lengthOf(a),
    room: shown.kind === 'salon' && (Boolean(a.room_id) || Boolean((shown.services.find((s) => s.id === Number(a.sku_id)) || {}).room)) }));
  if (shown.kind === 'clinic') {
    const doctor = people.find((p) => p.id === (personId || own));
    if (!doctor) fail('That doctor is not taking bookings now', 409, { reason: 'person_not_offered' });
    return { plan, people: [doctor], person: doctor.id };
  }
  const able = people.filter((p) => !p.skills || !p.skills.length || plan.every((step) => p.skills.includes(step.skuId)));
  if (personId) {
    const person = able.find((p) => p.id === Number(personId));
    if (!person) fail('That person does not do this booking\'s services, or is not taking bookings now', 409, { reason: 'person_cannot' });
    return { plan, people: [person], person: person.id };
  }
  return { plan, people: able.length ? able : people.filter((p) => p.id === own), person: null };
}

// Moves a booking's appointments to a new start (and person), back to back,
// each keeping its length. actor: the member of staff, or null for the guest.
async function moveAppointments(db, business, shown, booking, appointments, at, actor) {
  const except = appointments.map((a) => Number(a.id));
  const settings = shown.kind === 'salon' ? await salon().settingsRow(db, business.id) : null;
  let startMs = at.startsMs;
  for (const [i, a] of appointments.entries()) {
    const starts = new Date(startMs), ends = new Date(startMs + lengthOf(a) * 60000);
    let roomId = null;
    let staff;
    if (shown.kind === 'salon') {
      staff = await salon().lockResource(db, business, at.personId, 'staff', 'Stylist');
      const skills = await repo.all(db, 'SELECT sku_id FROM salon_staff_skills WHERE business_id=$1 AND resource_id=$2', [business.id, staff.id]);
      if (skills.length && !skills.some((k) => Number(k.sku_id) === Number(a.sku_id))) fail(`${staff.name} does not do ${a.service_name}`, 409, { reason: 'person_cannot' });
      const local = await repo.one(db, `SELECT ($2::timestamptz AT TIME ZONE b.timezone)::time AS starts,($3::timestamptz AT TIME ZONE b.timezone)::time AS ends,
        ($2::timestamptz AT TIME ZONE b.timezone)::date=($3::timestamptz AT TIME ZONE b.timezone)::date AS same_day FROM businesses b WHERE b.id=$1`, [business.id, starts, ends]);
      if (!local.same_day || local.starts < settings.opens_at || local.ends > settings.closes_at) taken('That time is outside the salon\'s hours. Please pick another.');
      await salon().staffAvailable(db, business, staff, starts, ends, null);
      if (await salon().clash(db, business, 'staff', staff.id, starts, ends, except)) taken(`Sorry, ${staff.name} is no longer free then. Please pick another time.`);
      roomId = at.rooms[i] || null;
      if (roomId) {
        const room = await salon().lockResource(db, business, roomId, 'room', 'Room');
        if (await salon().clash(db, business, 'room', room.id, starts, ends, except)) taken('Sorry, that time has just been taken. Please pick another.');
      }
    } else {
      staff = await repo.one(db, 'SELECT * FROM business_resources WHERE business_id=$1 AND id=$2 AND active FOR UPDATE', [business.id, at.personId]);
      if (!staff) taken('That person is not taking bookings now. Please pick another.');
      if (shown.kind === 'clinic') {
        const problem = await clinicDesk().availabilityProblem(db, business, staff.id, starts, ends);
        if (problem) taken(`${problem}. Please pick another time.`);
      }
      if (await core.appointmentClash(db, business.id, staff.id, starts, ends, except)) taken('Sorry, that time has just been taken. Please pick another.');
    }
    const updated = await repo.one(db, 'UPDATE business_appointments SET resource_id=$3,starts_at=$4,ends_at=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, a.id, staff.id, starts, ends]);
    if (shown.kind === 'salon') {
      // A moved booking is confirmed again (the old message names the old time).
      await db.query(`UPDATE salon_appointment_details SET room_id=$3,moved_count=moved_count+1,confirmation_sent_at=NULL,reminder_sent_at=NULL
        WHERE business_id=$1 AND appointment_id=$2`, [business.id, a.id, roomId]);
    }
    const details = { from: { startsAt: a.starts_at, resourceId: Number(a.resource_id) }, to: { startsAt: updated.starts_at, resourceId: Number(staff.id) },
      onlineBookingId: Number(booking.id), by: actor ? 'staff' : 'guest' };
    if (actor) await repo.audit(db, business.id, actor.id, 'appointment.moved', a.id, details);
    else await repo.guestAudit(db, business.id, 'appointment.moved', a.id, details);
    await repo.event(db, business.id, actor ? actor.id : null, 'appointment.moved', 'appointment', a.id, { ...details, endsAt: updated.ends_at, locationId: Number(staff.location_id) });
    startMs += lengthOf(a) * 60000;
  }
}

module.exports = { pickTime, createAppointments, choiceFor, moveAppointments };
