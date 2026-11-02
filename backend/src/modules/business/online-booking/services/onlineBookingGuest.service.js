const repo = require('../../core/repositories/business.repository');
const guests = require('../../guests');
const engine = require('./onlineBookingEngine');
const rules = require('./onlineBookingRules');
const writes = require('./onlineBookingWrites');
const { expireDue } = require('./onlineBookingExpiry');
const common = require('./onlineBookingCommon');

// The guest's side of online booking (/api/public/appointments, the guests'
// site's /appointments/<token> and /appointments/status/<guest token>).
// Nobody is signed in: a request carries the link's token or the guest's own
// booking token and nothing else. What a guest reads is the business card,
// what the link offers and free times; never another guest, a count of
// bookings, or a person's diary.
//
//   page(token)                        the business, what it offers, what the page asks
//   days(token, query)                 each day of the window: open, the first free time
//   times(token, query)                a day's free times, by morning, afternoon and evening
//   book(token, body)                  a booking (or a request), idempotent by clientKey
//   follow(guestToken)                 the guest's booking and its live key
//   cancel(guestToken)                 cancelled by the guest, while the link allows it
//   changeDays / changeTimes / move    a new time for it, while the link allows it
//   calendar(guestToken)               an .ics file of it

const { fail } = common;
const PURPOSES = ['reminders', 'offers'];
const SEX = ['female', 'male', 'other'];

// Who may book what, and what the page asks for each kind of business.
function asks(business, shown, link) {
  const type = business.business_type;
  return {
    multi: shown.kind === 'salon' ? 3 : 1,
    someoneElse: true,
    clinic: shown.kind === 'clinic',
    vehicle: type === 'garage',
    adult: type === 'salon',
    trial: type === 'memberships',
    any: shown.kind !== 'clinic' && Boolean(link.allow_any_staff) && shown.people.length > 1,
  };
}

// A salon that takes deposits: online bookings come as requests (no payment
// gateway); with the UPI advance on, the guest pays it and types the UTR.
function advanceOf(shown, link) {
  if (shown.kind !== 'salon' || !(shown.salon.depositPercent > 0)) return null;
  return link.upi_advance && link.upi_id ? { percent: shown.salon.depositPercent, upiId: link.upi_id, payee: link.upi_payee || null } : { percent: shown.salon.depositPercent, upiId: null };
}
// The advance on a choice, in whole rupees up from the services' prices.
const advanceAmount = (plan, percent) => Math.ceil(plan.reduce((sum, s) => sum + Number(s.price || 0), 0) * percent / 100);

async function page(token) {
  const { link, business, card } = await common.resolveLink(token);
  const shown = await engine.offer(repo.pool, business, link);
  const clock = rules.clockOf(business.timezone);
  const advance = advanceOf(shown, link);
  const memberClasses = business.business_type === 'memberships'
    ? Boolean(await repo.one(repo.pool, 'SELECT 1 FROM member_class_slots WHERE business_id=$1 LIMIT 1', [business.id]).catch(() => null)) : false;
  return {
    card, type: business.business_type, kind: shown.kind, today: clock.date,
    link: { daysAhead: Number(link.days_ahead), minNoticeMinutes: Number(link.min_notice_minutes), stepMinutes: Number(link.slot_step_minutes), confirm: link.confirm_mode === 'confirm',
      showPrices: link.show_prices, guestNote: link.guest_note || null, cancelHours: Number(link.cancel_hours), maxChanges: Number(link.max_changes),
      expiryHours: Number(link.request_expiry_hours) },
    services: shown.services.map((s) => ({ id: s.id, label: s.label, category: s.category, minutes: s.minutes, price: link.show_prices ? s.price : null })),
    people: shown.people.map((p) => ({ id: p.id, name: p.name, role: p.role, skills: p.skills && p.skills.length ? p.skills : null,
      ...(shown.kind === 'clinic' ? { speciality: p.speciality, qualifications: p.qualifications, registrationNo: p.registrationNo, council: p.council,
        fee: p.fee, feeLabel: p.feeLabel, followUpDays: p.followUpDays, followUpFee: p.followUpFee, slotMinutes: p.slotMinutes } : {}) })),
    asks: asks(business, shown, link),
    consents: card.privacy ? PURPOSES : [],
    advance: advance ? { ...advance, deposits: !advance.upiId } : null,
    memberClasses,
  };
}

// The services and person asked for (query or body), as the engine's choice.
async function choiceOf(db, business, link, query) {
  const shown = await engine.offer(db, business, link);
  const choice = engine.choose(link, shown, { serviceIds: common.readIds(query.services, 'services'), personId: common.readPerson(query.person) });
  return { shown, choice };
}

const dayRow = (day, clock) => {
  const at = new Date(Date.UTC(...day.date.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))));
  const first = day.times[0];
  return { date: day.date, label: rules.dateLabel(day.date), weekday: rules.WEEKDAYS[at.getUTCDay()], day: at.getUTCDate(), month: rules.MONTHS[at.getUTCMonth()],
    today: day.date === clock.date, open: day.open && day.times.length > 0, closed: !day.open, reason: day.open ? (day.times.length ? null : day.reason || 'full') : day.reason,
    first: first ? rules.timeText(first.minutes) : null, firstLabel: first ? rules.timeLabel(first.minutes) : null, free: day.times.length };
};
const grouped = (times) => {
  const groups = [];
  for (const t of times) {
    const part = rules.partOfDay(t.minutes);
    let group = groups.find((g) => g.part === part);
    if (!group) groups.push(group = { part, times: [] });
    group.times.push({ time: rules.timeText(t.minutes), label: rules.timeLabel(t.minutes) });
  }
  return groups;
};

async function days(token, query) {
  const { link, business } = await common.resolveLink(token);
  await expireDue(business.id);
  const { shown, choice } = await choiceOf(repo.pool, business, link, query);
  const clock = rules.clockOf(business.timezone);
  const list = await engine.daysFor(repo.pool, business, link, shown, choice, { from: clock.date, to: rules.addDays(clock.date, Number(link.days_ahead) - 1) }, clock);
  return { days: list.map((day) => dayRow(day, clock)) };
}

function inWindow(link, clock, date) {
  const last = rules.addDays(clock.date, Number(link.days_ahead) - 1);
  if (date < clock.date) fail('That day has passed. Please pick another day.', 400, { field: 'date', reason: 'past' });
  if (date > last) fail(`Online bookings open ${link.days_ahead} days ahead. Please pick an earlier day.`, 400, { field: 'date', reason: 'too_far' });
}

async function times(token, query) {
  const { link, business } = await common.resolveLink(token);
  await expireDue(business.id);
  const { shown, choice } = await choiceOf(repo.pool, business, link, query);
  const clock = rules.clockOf(business.timezone);
  const date = common.readDate(query.date);
  inWindow(link, clock, date);
  const [day] = await engine.daysFor(repo.pool, business, link, shown, choice, { from: date, to: date }, clock);
  return { date, label: rules.dateLabel(date), open: day.open, reason: day.open ? (day.times.length ? null : day.reason || 'full') : day.reason, groups: grouped(day.times) };
}

// --- Booking -----------------------------------------------------------------------------------------

const text = (value, max, field, label) => {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'string') fail(`${label} must be text`, 400, { field });
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length > max) fail(`${label} must be ${max} characters or less`, 400, { field });
  return clean;
};

function readBooking(body, shown, business, link) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Something went wrong sending your booking. Please try again.');
  // A field no person sees: a form-filling bot fills it in.
  if (body.website) fail('Something went wrong sending your booking. Please refresh the page and try again.');
  const clientKey = typeof body.clientKey === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.clientKey) ? body.clientKey : fail('Please refresh the page and try again.', 400, { field: 'clientKey' });
  const kind = shown.kind;
  const input = {
    clientKey,
    serviceIds: common.readIds(body.services, 'services'),
    person: common.readPerson(body.person),
    date: common.readDate(body.date),
    minutes: common.readTime(body.time),
    name: guests.readGuestName(body.name),
    mobile: guests.readGuestMobile(body.mobile),
    forWhom: body.forWhom === 'someone_else' ? 'someone_else' : 'self',
    note: text(body.note, 300, 'note', 'Your note'),
    consents: guests.readGuestChoices(body.consents).filter((purpose) => PURPOSES.includes(purpose)),
    noticeId: body.noticeId ?? null,
  };
  if (input.forWhom === 'someone_else') {
    input.personName = text(body.personName, 150, 'personName', 'Their name');
    if (!input.personName || input.personName.length < 2 || !/\p{L}/u.test(input.personName)) fail('Please enter the name of the person the booking is for', 400, { field: 'personName' });
  }
  if (kind === 'clinic') {
    const age = typeof body.personAge === 'string' && body.personAge.trim() !== '' ? Number(body.personAge) : body.personAge;
    if (!Number.isInteger(age) || age < 0 || age > 120) fail('Please enter the patient\'s age in years', 400, { field: 'personAge' });
    if (!SEX.includes(body.personSex)) fail('Please choose the patient\'s sex', 400, { field: 'personSex' });
    if (!['new', 'follow_up'].includes(body.visitKind)) fail('Please say whether the patient has visited before', 400, { field: 'visitKind' });
    Object.assign(input, { personAge: age, personSex: body.personSex, visitKind: body.visitKind, reason: text(body.reason, 200, 'reason', 'The reason') });
  }
  if (business.business_type === 'salon' && body.adultDeclared !== true) {
    fail('Please tick the declaration: you are 18 or over, or booking for your child as their parent or guardian', 400, { field: 'adult' });
  }
  if (business.business_type === 'garage') {
    const plate = String(body.vehicleNo ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{4,15}$/.test(plate) || !/[A-Z]/.test(plate) || !/[0-9]/.test(plate)) fail('Please enter the vehicle number as on its plate, like TS09EA4521', 400, { field: 'vehicleNo' });
    input.vehicleNo = plate;
    input.vehicleMake = text(body.vehicleMake, 60, 'vehicleMake', 'The make');
    input.vehicleModel = text(body.vehicleModel, 60, 'vehicleModel', 'The model');
    if (!input.vehicleMake) fail('Please enter the make, like Maruti or Honda', 400, { field: 'vehicleMake' });
    if (!input.vehicleModel) fail('Please enter the model, like Swift or Activa', 400, { field: 'vehicleModel' });
  }
  const advance = advanceOf(shown, link);
  if (advance && advance.upiId) {
    const utr = String(body.advanceUtr ?? '').replace(/\s/g, '');
    if (!/^\d{12}$/.test(utr)) fail('Please type the 12-digit UTR of your UPI payment (in your UPI app, under the payment\'s details)', 400, { field: 'advanceUtr' });
    input.advanceUtr = utr;
  }
  return input;
}

// What a guest asked for, as the hash a repeat is checked against.
const requestOf = (input) => ({ ...input, clientKey: undefined });

// The mobile's no-shows at this business in the last 90 days (any of its customers with that number).
const noShowsOf = (db, businessId, mobile) => repo.one(db, `SELECT count(*)::int AS n FROM business_appointments a JOIN business_contacts c ON c.business_id=a.business_id AND c.id=a.contact_id
  WHERE a.business_id=$1 AND a.status='no_show' AND a.starts_at > now() - interval '90 days' AND right(regexp_replace(COALESCE(c.phone,''),'\\D','','g'),10)=$2`, [businessId, mobile]);

// The mobile's online bookings still to come here, that hold their time.
const openOf = (db, businessId, mobile) => repo.one(db, `SELECT count(DISTINCT ob.id)::int AS n FROM business_online_bookings ob
  JOIN business_appointments a ON a.business_id=ob.business_id AND a.online_booking_id=ob.id
  WHERE ob.business_id=$1 AND ob.mobile=$2 AND business_appointment_holds(a.status,a.request_expires_at) AND a.ends_at > now()`, [businessId, mobile]);

async function view(db, token, link, card) {
  const loaded = await common.byGuestToken(db, token);
  const status = common.stateOf(loaded.appointments);
  return { booking: common.bookingView(loaded, { card, link, linkToken: link && link.enabled ? link.token : null }), live: common.liveFor(loaded.booking, loaded.appointments, status) };
}

async function book(token, body) {
  const resolved = await common.resolveLink(token);
  const { link, business, card } = resolved;
  const result = await repo.transaction(async (db) => {
    // One booking at a time per business: two guests (or a guest and the
    // salon's desk) reaching for the last 4:30 are answered one after the other.
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const shown = await engine.offer(db, business, link);
    const input = readBooking(body, shown, business, link);
    const hash = common.hashOf(requestOf(input));
    const old = await repo.one(db, 'SELECT guest_token,request_hash FROM business_online_bookings WHERE link_id=$1 AND client_key=$2', [link.id, input.clientKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This booking was already sent with other details. Please refresh the page and book again.', 409, { reason: 'client_key_reused' });
      return { token: old.guest_token, repeated: true };
    }
    await guests.assertBusinessTakingOrders(db, business.id, { locationId: link.location_id,
      message: `${card.name} isn't taking online bookings right now. Please ${common.callWords(card)} to book.` });
    await expireDue(business.id, db);
    const choice = engine.choose(link, shown, { serviceIds: input.serviceIds, personId: input.person });
    const clock = rules.clockOf(business.timezone);
    inWindow(link, clock, input.date);
    const at = await writes.pickTime(db, business, link, shown, choice, { date: input.date, minutes: input.minutes }, clock);
    // One person, a few open bookings: nobody holds every Saturday "just in case".
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`online-booking:${business.id}:${input.mobile}`]);
    const open = await openOf(db, business.id, input.mobile);
    if (open.n >= Number(link.max_open_per_mobile)) {
      fail(`This mobile number already has ${open.n} ${open.n === 1 ? 'booking' : 'bookings'} coming up with ${card.name}. Cancel one from its link before booking another, or ${common.callWords(card)}.`,
        409, { reason: 'mobile_limit' });
    }
    const { contact } = await guests.findOrCreateGuestContact(db, business, { name: input.name, mobile: input.mobile });
    if (business.business_type === 'memberships') {
      const held = await repo.one(db, 'SELECT membership_no,origin FROM member_memberships WHERE business_id=$1 AND contact_id=$2 ORDER BY id LIMIT 1', [business.id, contact.id]);
      if (held) fail(`A free trial is for someone new, and this mobile number has ${held.origin === 'trial' ? 'had a trial' : 'a membership'} with ${card.name}. Please ${common.callWords(card)} to book a session.`,
        409, { reason: 'not_new' });
    }
    // Why it waits for the desk, if it does.
    const noShows = (await noShowsOf(db, business.id, input.mobile)).n;
    const advance = advanceOf(shown, link);
    let reason = null;
    if (advance) reason = advance.upiId ? 'advance' : 'deposit';
    else if (link.confirm_mode === 'confirm') reason = 'confirm';
    else if (Number(link.confirm_after_no_shows) > 0 && noShows >= Number(link.confirm_after_no_shows)) reason = 'no_shows';
    const status = reason ? 'requested' : 'booked';
    const expiresAt = reason ? new Date(rules.expiryOf(Date.now(), at.startsMs, Number(link.request_expiry_hours))) : null;
    const plan = choice.plan;
    const lead = business.business_type === 'memberships'
      ? await require('../../memberships/services/memberPeople.service').addWebsiteLead(db, business, { locationId: link.location_id, name: input.forWhom === 'someone_else' ? input.personName : input.name,
        phone: input.mobile, contactId: contact.id, interest: `Free trial: ${plan.map((s) => s.label).join(', ')}, ${rules.dateLabel(input.date)} ${rules.timeLabel(input.minutes)}`, followUpOn: input.date })
      : null;
    const vehicle = input.vehicleNo
      ? await repo.one(db, 'SELECT id FROM garage_vehicles WHERE business_id=$1 AND registration_no=$2 AND active', [business.id, input.vehicleNo]).catch(() => null) : null;
    const guestToken = common.newToken();
    const booking = await repo.one(db, `INSERT INTO business_online_bookings(business_id,link_id,location_id,guest_token,client_key,request_hash,contact_id,booker_name,mobile,
        for_whom,person_name,person_age,person_sex,visit_kind,reason,note,vehicle_no,vehicle_make,vehicle_model,vehicle_id,lead_id,adult_declared_at,consents,privacy_notice_id,
        request_reason,advance_amount,advance_utr)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
    [business.id, link.id, link.location_id, guestToken, input.clientKey, hash, contact.id, input.name, input.mobile, input.forWhom, input.personName || null,
      input.personAge ?? null, input.personSex || null, input.visitKind || null, input.reason || null, input.note, input.vehicleNo || null, input.vehicleMake || null,
      input.vehicleModel || null, vehicle ? vehicle.id : null, lead ? lead.id : null, business.business_type === 'salon' ? new Date() : null, input.consents,
      input.consents.length && card.privacy ? card.privacy.id : null, reason, reason === 'advance' ? advanceAmount(plan, advance.percent).toFixed(2) : null,
      reason === 'advance' ? input.advanceUtr : null]);
    const note = [input.forWhom === 'someone_else' ? `For ${input.personName}` : null, input.note].filter(Boolean).join(' · ') || null;
    await writes.createAppointments(db, business, shown, choice, booking, at, { status, expiresAt, note });
    if (input.consents.length) await guests.recordGuestConsents(db, business, contact.id, input.consents, input.noticeId);
    await repo.guestAudit(db, business.id, status === 'requested' ? 'online_booking.requested' : 'online_booking.made', booking.id,
      { reason, services: plan.map((s) => s.label), startsAt: new Date(at.startsMs).toISOString() });
    return { token: guestToken, repeated: false };
  });
  const answer = await view(repo.pool, result.token, link, card);
  return { ...answer, repeated: result.repeated };
}

// --- The guest's own link ----------------------------------------------------------------------------

// The booking behind a guest token, with its link and the business card (the
// link may since be switched off: the booking still shows).
async function own(guestToken) {
  const loaded = await common.byGuestToken(repo.pool, guestToken);
  if (!loaded) fail(common.BOOKING_GONE, 404, { reason: 'not_found' });
  await expireDue(Number(loaded.booking.business_id));
  const link = await repo.one(repo.pool, 'SELECT * FROM business_booking_links WHERE business_id=$1 AND id=$2', [loaded.booking.business_id, loaded.booking.link_id]);
  const card = await guests.guestBusinessCard(repo.pool, Number(loaded.booking.business_id), loaded.booking.location_id);
  return { link, card, business: { id: Number(loaded.booking.business_id), business_type: loaded.booking.business_type, timezone: loaded.booking.timezone || 'Asia/Kolkata',
    name: loaded.booking.business_name, modules: [] } };
}

async function follow(guestToken) {
  const { link, card } = await own(guestToken);
  return view(repo.pool, guestToken, link, card);
}

async function cancel(guestToken) {
  const { link, card, business } = await own(guestToken);
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const loaded = await common.byGuestToken(db, guestToken, { lock: true });
    const { booking, appointments } = loaded;
    const status = common.stateOf(appointments);
    const shown = common.bookingView(loaded, { card, link });
    if (status === 'cancelled' && booking.cancelled_by_guest_at) return;
    if (!shown.may.cancel) {
      fail(shown.may.cutOffPassed
        ? `Your booking is less than ${link.cancel_hours} hours away, so it can't be cancelled online. Please ${common.callWords(card)}.`
        : status === 'booked' || status === 'requested'
          ? `This booking can't be cancelled online. Please ${common.callWords(card)}.`
          : `This booking is ${shown.statusLabel.toLowerCase()} already.`, 409, { reason: 'cannot_cancel' });
    }
    for (const a of appointments.filter((x) => ['requested', 'booked'].includes(x.status))) {
      await db.query("UPDATE business_appointments SET status='cancelled' WHERE business_id=$1 AND id=$2", [business.id, a.id]);
      await repo.guestAudit(db, business.id, 'appointment.cancelled', a.id, { onlineBookingId: Number(booking.id), by: 'guest' });
      await repo.event(db, business.id, null, 'appointment.cancelled', 'appointment', a.id, { status: 'cancelled', by: 'guest', onlineBookingId: Number(booking.id),
        locationId: Number(a.location_id), source: 'guests_site' });
    }
    await db.query('UPDATE business_online_bookings SET cancelled_by_guest_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, booking.id]);
  });
  return view(repo.pool, guestToken, link, card);
}

// A new time for a booking: its own services, the same person or anyone.
async function changeChoice(db, business, link, loaded, query) {
  const shown = await engine.offer(db, business, link);
  const person = query.person === undefined ? Number(loaded.appointments[0].resource_id) : common.readPerson(query.person);
  const choice = await writes.choiceFor(db, business, link, shown, loaded.appointments, { personId: person === 'any' ? null : person });
  return { shown, choice };
}
function changeAllowed(loaded, link, card) {
  const view = common.bookingView(loaded, { card, link });
  if (!view.may.change) {
    fail(view.may.cutOffPassed ? `Your booking is less than ${link.cancel_hours} hours away, so it can't be changed online. Please ${common.callWords(card)}.`
      : Number(loaded.booking.changes) >= Number(link.max_changes) && ['requested', 'booked'].includes(view.status)
        ? `This booking has been changed online as often as it can be. Please ${common.callWords(card)}.`
        : `This booking can't be changed online. Please ${common.callWords(card)}.`, 409, { reason: 'cannot_change' });
  }
}

async function changeDays(guestToken, query) {
  const { link, card, business } = await own(guestToken);
  await common.resolveLink(link.token);
  const loaded = await common.byGuestToken(repo.pool, guestToken);
  changeAllowed(loaded, link, card);
  const { shown, choice } = await changeChoice(repo.pool, business, link, loaded, query);
  const clock = rules.clockOf(business.timezone);
  const list = await engine.daysFor(repo.pool, business, link, shown, choice, { from: clock.date, to: rules.addDays(clock.date, Number(link.days_ahead) - 1),
    except: loaded.appointments.map((a) => Number(a.id)) }, clock);
  return { days: list.map((day) => dayRow(day, clock)) };
}

async function changeTimes(guestToken, query) {
  const { link, card, business } = await own(guestToken);
  await common.resolveLink(link.token);
  const loaded = await common.byGuestToken(repo.pool, guestToken);
  changeAllowed(loaded, link, card);
  const { shown, choice } = await changeChoice(repo.pool, business, link, loaded, query);
  const clock = rules.clockOf(business.timezone);
  const date = common.readDate(query.date);
  inWindow(link, clock, date);
  const [day] = await engine.daysFor(repo.pool, business, link, shown, choice, { from: date, to: date, except: loaded.appointments.map((a) => Number(a.id)) }, clock);
  return { date, label: rules.dateLabel(date), open: day.open, reason: day.open ? (day.times.length ? null : day.reason || 'full') : day.reason, groups: grouped(day.times) };
}

// body: { date, time, person? } — the booking keeps its services; a request
// stays a request (its time to answer starts again), a booking stays booked.
async function move(guestToken, body) {
  const { link, card, business } = await own(guestToken);
  await common.resolveLink(link.token);
  const date = common.readDate(body && body.date);
  const minutes = common.readTime(body && body.time);
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    await guests.assertBusinessTakingOrders(db, business.id, { locationId: link.location_id,
      message: `${card.name} isn't taking online bookings right now. Please ${common.callWords(card)}.` });
    await expireDue(business.id, db);
    const loaded = await common.byGuestToken(db, guestToken, { lock: true });
    changeAllowed(loaded, link, card);
    const first = loaded.appointments[0];
    const clock = rules.clockOf(business.timezone);
    if (rules.clockOf(business.timezone, new Date(first.starts_at).getTime()).date === date && rules.clockOf(business.timezone, new Date(first.starts_at).getTime()).minutes === minutes
      && (body.person === undefined || Number(body.person) === Number(first.resource_id))) return;
    inWindow(link, clock, date);
    const { shown, choice } = await changeChoice(db, business, link, loaded, body || {});
    const at = await writes.pickTime(db, business, link, shown, choice, { date, minutes, except: loaded.appointments.map((a) => Number(a.id)) }, clock);
    const open = loaded.appointments.filter((a) => ['requested', 'booked'].includes(a.status));
    await writes.moveAppointments(db, business, shown, loaded.booking, open, at, null);
    // A request's time to answer starts again from now, never past its new start.
    if (open.some((a) => a.status === 'requested')) {
      await db.query(`UPDATE business_appointments SET request_expires_at=$3 WHERE business_id=$1 AND online_booking_id=$2 AND status='requested'`,
        [business.id, loaded.booking.id, new Date(rules.expiryOf(Date.now(), at.startsMs, Number(link.request_expiry_hours)))]);
    }
    await db.query('UPDATE business_online_bookings SET changes=changes+1,reminder_sent_at=NULL,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, loaded.booking.id]);
  });
  return view(repo.pool, guestToken, link, card);
}

// The booking as a calendar file, for the guest's phone calendar.
async function calendar(guestToken) {
  const { link, card } = await own(guestToken);
  const loaded = await common.byGuestToken(repo.pool, guestToken);
  const shown = common.bookingView(loaded, { card, link });
  if (!['booked', 'requested'].includes(shown.status)) fail('This booking is not coming up any more', 409, { reason: 'not_open' });
  const where = [card.location.address, card.location.city, card.location.postalCode].filter(Boolean).join(', ');
  const ics = rules.icsFile({
    uid: `online-booking-${loaded.booking.id}-${loaded.booking.business_id}@guests`, startsMs: Date.parse(shown.startsAt), endsMs: Date.parse(shown.endsAt),
    title: `${shown.services.map((s) => s.label).join(' + ')} at ${card.name}`, location: [card.name, where].filter(Boolean).join(', '),
    description: [shown.status === 'requested' ? 'Requested: the business confirms it.' : 'Booked.', `With ${shown.person}.`,
      card.location.phone ? `Phone: ${card.location.phone}` : null].filter(Boolean).join(' '),
  });
  return { name: `booking-${shown.ref}.ics`, ics };
}

module.exports = { page, days, times, book, follow, cancel, changeDays, changeTimes, move, calendar, advanceAmount };
