const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { daysFrom, weekdayOf, momentAt } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');
const { publishNotice } = require('./helpers/privacy');

// Online booking (module online_appointments), end to end through the API, on a
// throwaway database with every migration:
//   - the module in the catalogue, sold as an application, off by default, its
//     permissions on the role templates; a link per location with its trade's rules;
//   - a salon: one to three services back to back, "any stylist", skills,
//     leave, holidays, rooms and clean-up times, through the salon's own booking;
//   - a clinic: OPD sessions, the slot length, each session's online share,
//     leave, closing when a session starts; requests accepted or declined; the
//     token at the desk for a contact not yet a patient, and for someone else;
//   - an optical shop, a garage (the vehicle, its record, open bookings) and a
//     gym's free trial (an enquiry from the website);
//   - instant and confirm; a request expiring; the UPI advance; the guest's
//     cancel and change with their limits; open bookings per mobile and the
//     address limit; a repeated clientKey; a time taken meanwhile (409 with the
//     next free times); a mobile's no-shows making a request;
//   - the module off, the link off, the plan ended; consent rows; audit rows
//     with no actor; events and the bell; every reader of appointment statuses
//     holding a request's time; an erased customer; this migration's Down and Up.
test('online appointments', { timeout: 900000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, created = false;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  // Guests are told apart by their address, as behind the hosting proxy.
  process.env.TRUST_PROXY = '1';
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `OnlineBooking-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  async function owner(code) {
    const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', [code]);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,restaurant_id', [restaurant.id, `Owner ${code}`, `${code}@test.invalid`, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
    return person;
  }
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth, headers = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { text }; }
    return { status: response.status, headers: response.headers, body: json };
  }
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const key = () => crypto.randomUUID();

  // A guest: no login, each from an address of their own unless one is given.
  let guestNo = 0;
  const address = () => { guestNo += 1; return `10.${(guestNo >> 16) & 255}.${(guestNo >> 8) & 255}.${guestNo & 255}`; };
  let mobileNo = 0;
  const mobile = () => { mobileNo += 1; return `9${String(810000000 + mobileNo)}`; };
  async function guest(method, route, body, expected = 200, from = address()) {
    const result = await call(method, `/public/appointments${route}`, body, null, { 'X-Forwarded-For': from });
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    return result.body;
  }
  const liveWatch = (live) => JSON.parse(Buffer.from(live.key.split('.')[0], 'base64url').toString('utf8')).watch;

  const ownerA = await owner('online-a');
  await owner('online-b');
  const A = as(await login('online-a@test.invalid'));
  const B = as(await login('online-b@test.invalid'));
  let [salon, clinic, optical, garage, gym, grocery] = await createBusinesses(A, 'ONLINE', ['salon', 'healthcare', 'optical', 'garage', 'memberships', 'grocery']);
  [optical, garage, gym] = await withTools(A, [optical, garage, gym]);
  const [elsewhere] = await createBusinesses(B, 'ELSEWHERE', ['salon']);
  const at = (business) => (suffix) => `/businesses/${business.id}/${suffix}`;
  const S = at(salon), C = at(clinic), O = at(optical), G = at(garage), M = at(gym);
  const mainOf = async (business) => (await A('GET', `/businesses/${business.id}/locations`)).items[0];
  const slab = async (business, rate) => (await A('GET', `/businesses/${business.id}/tax-rates`)).items.find((r) => Number(r.rate) === rate);
  const service = async (business, name, code, price, rate = 18) => A('POST', `/businesses/${business.id}/catalog`,
    { name, code, kind: 'service', unit: 'service', tracking: 'none', price, taxRateId: (await slab(business, rate)).id }, 201);
  const resource = async (business, name, locationId, roleLabel) => A('POST', `/businesses/${business.id}/resources`, { name, locationId, ...(roleLabel ? { roleLabel } : {}) }, 201);
  const roles = async (business) => (await A('GET', `/businesses/${business.id}/roles?limit=100`)).items;
  async function staff(business, email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerA.restaurant_id, email.split('@')[0], email, hash]);
    await A('POST', `/businesses/${business.id}/members`, { userId: user.id, roleId: (await roles(business)).find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), raw: (method, route, body) => call(method, route, body, token) };
  }
  const D = daysFrom(2), D1 = daysFrom(3), D2 = daysFrom(4);
  const allWeek = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, { open: '09:00', close: '20:00' }]));
  const audits = (businessId, action) => all('SELECT entity_id,actor_id,channel,details FROM business_audit WHERE business_id=$1 AND action=$2 ORDER BY id', [businessId, action]);
  const events = (businessId, kind) => all('SELECT entity_id,actor_id,payload FROM business_events WHERE business_id=$1 AND kind=$2 ORDER BY id', [businessId, kind]);
  const appointmentsOf = (bookingId) => all('SELECT * FROM business_appointments WHERE online_booking_id=$1 ORDER BY starts_at,id', [bookingId]);
  const bookingOf = (guestToken) => one('SELECT * FROM business_online_bookings WHERE guest_token=$1', [guestToken]);
  // An appointment brought to today on its business's own clock, at a minute of the local day (never past
  // midnight, whenever the test runs), lasting `length` minutes; a request's time to answer, from now.
  const toToday = (id, minute, length = 10, expiresIn = null) => pool.query(`UPDATE business_appointments a
    SET starts_at=((now() AT TIME ZONE b.timezone)::date + make_interval(mins => $2::int)) AT TIME ZONE b.timezone,
      ends_at=((now() AT TIME ZONE b.timezone)::date + make_interval(mins => $2::int + $3::int)) AT TIME ZONE b.timezone,
      request_expires_at=CASE WHEN $4::int IS NULL THEN a.request_expires_at ELSE now() + make_interval(mins => $4::int) END
    FROM businesses b WHERE b.id=a.business_id AND a.id=$1`, [id, minute, length, expiresIn]);
  const localTime = (iso, tz = 'Asia/Kolkata') => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const linkFor = async (business, locationId, changes = {}) => {
    const link = await A('POST', `/businesses/${business.id}/online-booking/links`, { locationId }, 201);
    return Object.keys(changes).length ? A('PATCH', `/businesses/${business.id}/online-booking/links/${link.id}`, changes) : link;
  };
  const switchOn = (business) => A('PUT', `/businesses/${business.id}/modules/online_appointments`, { enabled: true });

  // --- The module in the catalogue -------------------------------------------------------------------
  await t.test('online booking is an application of its own: its types, price, permissions and role grants, off until switched on', async () => {
    const module = await one("SELECT * FROM platform_modules WHERE code='online_appointments'");
    assert.deepEqual([module.name, module.kind], ['Online booking', 'optional']);
    assert.deepEqual((await all("SELECT requires_module_code FROM platform_module_dependencies WHERE module_code='online_appointments'")).map((r) => r.requires_module_code), ['appointments']);
    const types = await all("SELECT business_type,enabled_by_default,recommended,recommended_note FROM platform_module_business_types WHERE module_code='online_appointments' ORDER BY business_type");
    assert.deepEqual(types.map((r) => r.business_type), ['electronics', 'garage', 'healthcare', 'memberships', 'optical', 'salon']);
    assert.ok(types.every((r) => !r.enabled_by_default));
    assert.ok(types.find((r) => r.business_type === 'healthcare').recommended && types.find((r) => r.business_type === 'healthcare').recommended_note);
    const price = await one("SELECT sold_as,monthly_price,yearly_price FROM platform_module_prices WHERE module_code='online_appointments'");
    assert.deepEqual([price.sold_as, Number(price.monthly_price), Number(price.yearly_price)], ['application', 299, 2999]);
    assert.deepEqual((await all("SELECT action FROM business_permissions WHERE module_code='online_appointments' ORDER BY sort_order")).map((r) => r.action), ['view', 'approve', 'manage']);
    const grants = await all("SELECT template_code,permission_code FROM business_role_template_permissions WHERE permission_code LIKE 'online\\_appointments.%' ORDER BY 1,2");
    const by = (code) => grants.filter((g) => g.template_code === code).map((g) => g.permission_code.split('.')[1]);
    assert.deepEqual(by('manager'), ['approve', 'manage', 'view']);
    assert.deepEqual(by('cashier'), ['approve', 'view']);
    assert.deepEqual(by('doctor'), ['view']);
    // Off by default, and only for the types that book people's time.
    assert.ok(!salon.capabilities.includes('online_appointments'));
    await A('PUT', `/businesses/${grocery.id}/modules/online_appointments`, { enabled: true }, 409);
    for (const business of [salon, clinic, optical, garage, gym]) await switchOn(business);
    // The screens refuse a business that has not switched it on.
    await B('GET', `/businesses/${elsewhere.id}/online-booking`, undefined, 403);
    // The owner's plan shows it with the other applications (Your plan's catalogue).
    const plan = await A('GET', `/businesses/${salon.id}/plan`);
    const shown = JSON.stringify(plan.catalogue);
    assert.match(shown, /online_appointments/);
  });

  // --- Links and settings ------------------------------------------------------------------------------
  const salonMain = await mainOf(salon), clinicMain = await mainOf(clinic), opticalMain = await mainOf(optical), garageMain = await mainOf(garage), gymMain = await mainOf(gym);
  let salonLink, clinicLink;
  await t.test('a booking link per location, on its trade\'s rules; its settings checked; a new link kills the old one', async () => {
    const empty = await A('GET', S('online-booking'));
    assert.equal(empty.locations[0].link, null);
    assert.equal(empty.kind, 'salon');
    salonLink = await linkFor(salon, salonMain.id);
    assert.deepEqual([salonLink.confirmMode, salonLink.daysAhead, salonLink.minNoticeMinutes, salonLink.slotStepMinutes, salonLink.cancelHours, salonLink.maxChanges, salonLink.allowAnyStaff],
      ['instant', 30, 120, 15, 3, 2, true]);
    assert.match(salonLink.token, /^[A-Za-z0-9_-]{32}$/);
    await A('POST', S('online-booking/links'), { locationId: salonMain.id }, 409);
    clinicLink = await linkFor(clinic, clinicMain.id);
    assert.deepEqual([clinicLink.confirmMode, clinicLink.daysAhead, clinicLink.minNoticeMinutes, clinicLink.onlineSharePercent, clinicLink.requestExpiryHours], ['confirm', 7, 0, 50, 12]);
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { slotStepMinutes: 25 }, 400);
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { upiAdvance: true }, 400);
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { upiId: 'not a upi id' }, 400);
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { daysAhead: 91 }, 400);
    const old = salonLink.token;
    salonLink = await A('POST', S(`online-booking/links/${salonLink.id}/new-link`), {});
    assert.notEqual(salonLink.token, old);
    const gone = await guest('GET', `/${old}`, undefined, 404);
    assert.equal(gone.data.reason, 'not_available');
    assert.equal((await audits(salon.id, 'online_booking.link_replaced')).length, 1);
    // The front desk answers requests but does not change the link.
    const desk = await staff(salon, 'salon-desk@test.invalid', 'receptionist');
    await desk.call('PATCH', S(`online-booking/links/${salonLink.id}`), { daysAhead: 10 }, 403);
    await desk.call('GET', S('online-booking'));
  });

  // --- A salon ---------------------------------------------------------------------------------------
  await publishNotice(A, `/businesses/${salon.id}`);
  const haircut = await service(salon, 'Haircut', 'CUT', '400', 5);
  const beard = await service(salon, 'Beard trim', 'BEARD', '150', 5);
  const facial = await service(salon, 'Gold facial', 'FACIAL', '1200', 5);
  await service(salon, 'Product sale fee', 'FEE', '10', 5);
  await A('PUT', S(`salon/services/${haircut.id}`), { durationMinutes: 30, bufferMinutes: 10, needsRoom: false });
  await A('PUT', S(`salon/services/${beard.id}`), { durationMinutes: 15, bufferMinutes: 0, needsRoom: false });
  await A('PUT', S(`salon/services/${facial.id}`), { durationMinutes: 45, bufferMinutes: 15, needsRoom: true });
  const priya = await resource(salon, 'Priya', salonMain.id, 'Senior stylist');
  const arjun = await resource(salon, 'Arjun', salonMain.id);
  const neha = await resource(salon, 'Neha', salonMain.id, 'Beautician');
  const spa = await resource(salon, 'Spa room', salonMain.id);
  await A('PUT', S(`salon/staff/${priya.id}`), { kind: 'staff', skuIds: [haircut.id, beard.id] });
  await A('PUT', S(`salon/staff/${arjun.id}`), { kind: 'staff', skuIds: [] });
  await A('PUT', S(`salon/staff/${neha.id}`), { kind: 'staff', skuIds: [facial.id] });
  await A('PUT', S(`salon/staff/${spa.id}`), { kind: 'room', skuIds: [] });
  const notice = (await A('GET', S('privacy/notice'))).current;
  let haircutBooking;
  const salonBook = (body, expected = 201, from) => guest('POST', `/${salonLink.token}/bookings`, { clientKey: key(), name: 'Asha Rao', mobile: mobile(), adultDeclared: true, date: D, ...body }, expected, from);

  await t.test('a salon: its page, the days and times, services back to back with "any stylist", consents, audit and events with no actor', async () => {
    const page = (await guest('GET', `/${salonLink.token}`)).data;
    assert.equal(page.kind, 'salon');
    assert.deepEqual(page.services.map((s) => [s.label, s.minutes]), [['Beard trim', 15], ['Gold facial', 45], ['Haircut', 30]]);
    assert.equal(page.services.find((s) => s.label === 'Haircut').price, '420.00');
    assert.deepEqual(page.people.map((p) => p.name), ['Arjun', 'Neha', 'Priya']);
    assert.deepEqual([page.asks.adult, page.asks.multi, page.asks.any, page.asks.clinic], [true, 3, true, false]);
    assert.deepEqual(page.consents, ['reminders', 'offers']);
    assert.equal(page.card.name, salon.name);
    assert.equal(page.card.privacy.id, Number(notice.id));
    const days = (await guest('GET', `/${salonLink.token}/days?services=${haircut.id},${beard.id}&person=any`)).data.days;
    assert.equal(days.length, 30);
    assert.deepEqual([days.find((d) => d.date === D).open, days.find((d) => d.date === D).first], [true, '09:00']);
    const times = (await guest('GET', `/${salonLink.token}/times?services=${haircut.id},${beard.id}&person=any&date=${D}`)).data;
    assert.deepEqual(times.groups.map((g) => g.part), ['Morning', 'Afternoon', 'Evening']);
    // 30 + 10 + 15 minutes must end by 21:00: the last start is 20:05, on a 15-minute step 20:00.
    assert.equal(times.groups.at(-1).times.at(-1).time, '20:00');

    const clientKey = key();
    const body = { clientKey, services: [haircut.id, beard.id], person: 'any', time: '10:00', mobile: '9876543210', note: 'Short on the sides',
      consents: ['reminders'], noticeId: notice.id };
    const made = await salonBook(body);
    haircutBooking = made.data;
    assert.deepEqual([made.data.status, made.data.person, made.data.time, made.data.services.map((s) => s.label)], ['booked', 'Arjun', '10:00', ['Haircut', 'Beard trim']]);
    assert.equal(made.message, 'You are booked.');
    assert.match(made.data.guestToken, /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(liveWatch(made.live).map((w) => w.area).sort(), ['appointment', 'appointment', 'online_booking']);
    const booking = await bookingOf(made.data.guestToken);
    const rows = await appointmentsOf(booking.id);
    assert.deepEqual(rows.map((r) => [r.status, r.source, r.created_by, Number(r.resource_id), localTime(r.starts_at), localTime(r.ends_at)]),
      [['booked', 'guests_site', null, Number(arjun.id), '10:00', '10:40'], ['booked', 'guests_site', null, Number(arjun.id), '10:40', '10:55']]);
    assert.ok(booking.adult_declared_at);
    assert.equal((await one('SELECT notes FROM salon_appointment_details WHERE appointment_id=$1', [rows[0].id])).notes, 'Short on the sides');
    // The customer: made for the mobile, as a guest's.
    const contact = await one('SELECT * FROM business_contacts WHERE id=$1', [booking.contact_id]);
    assert.deepEqual([contact.name, contact.phone, contact.source], ['Asha Rao', '9876543210', 'guests_site']);
    // A consent ticked on the guests' site, on the notice shown.
    const consent = await one('SELECT * FROM business_consents WHERE business_id=$1 AND contact_id=$2', [salon.id, contact.id]);
    assert.deepEqual([consent.purpose, consent.channel, consent.recorded_by], ['reminders', 'guests_site', null]);
    // Audit rows of no actor (Guest (online)) and events with no actor.
    const booked = await audits(salon.id, 'appointment.booked');
    assert.deepEqual(booked.map((r) => [Number(r.entity_id), r.actor_id, r.channel]), rows.map((r) => [Number(r.id), null, 'guests_site']));
    assert.equal((await audits(salon.id, 'online_booking.made')).length, 1);
    const happened = await events(salon.id, 'appointment.booked');
    assert.deepEqual(happened.map((e) => [Number(e.entity_id), e.actor_id, e.payload.source]), rows.map((r) => [Number(r.id), null, 'guests_site']));
    const log = await A('GET', S('audit?limit=50'));
    assert.equal(log.items.find((r) => r.action === 'online_booking.made').actor_name, 'Guest (online)');

    // The same submission again: the same booking; the same key with other details: refused.
    const again = await salonBook(body, 200);
    assert.equal(again.data.guestToken, made.data.guestToken);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_online_bookings WHERE business_id=$1', [salon.id])).n, 1);
    const reused = await salonBook({ ...body, time: '11:00' }, 409);
    assert.equal(reused.data.reason, 'client_key_reused');
    // The declaration is required at a salon.
    const undeclared = await salonBook({ services: [haircut.id], person: priya.id, time: '12:00', adultDeclared: false }, 400);
    assert.equal(undeclared.data.field, 'adult');
  });

  await t.test('a salon: skills, rooms and clean-up, a time taken meanwhile, the desk\'s clash, leave and holidays', async () => {
    const cannot = await salonBook({ services: [facial.id], person: priya.id, time: '11:00' }, 409);
    assert.equal(cannot.data.reason, 'person_cannot');
    // A facial needs the spa room: Neha's at 11:00 takes it until 12:00 (45 minutes and 15 to clean up).
    const first = await salonBook({ services: [facial.id], person: neha.id, time: '11:00' });
    const room = await one('SELECT d.room_id FROM salon_appointment_details d JOIN business_appointments a ON a.id=d.appointment_id WHERE a.online_booking_id=$1',
      [(await bookingOf(first.data.guestToken)).id]);
    assert.equal(Number(room.room_id), Number(spa.id));
    // Arjun is free at 11:00, but the room is not: the next free times start when it is.
    const taken = await salonBook({ services: [facial.id], person: arjun.id, time: '11:00' }, 409);
    assert.equal(taken.data.reason, 'slot_taken');
    assert.equal(taken.data.next[0].date, D);
    assert.equal(taken.data.next[0].time, '12:00');
    // Two services back to back cannot overlap Arjun's own 10:00 booking either.
    await salonBook({ services: [haircut.id], person: arjun.id, time: '10:30' }, 409);
    // The desk cannot book over an online booking.
    const guestContact = await one('SELECT contact_id FROM business_online_bookings WHERE guest_token=$1', [haircutBooking.guestToken]);
    const desk = await call('POST', S('salon/appointments'), { contactId: guestContact.contact_id, skuId: haircut.id, resourceId: arjun.id, startsAt: momentAt(D, '10:30'), requestKey: key() },
      (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(desk.status, 409);
    assert.match(desk.body.message, /Arjun already has an appointment at that time/);
    // Arjun's leave, and the salon's holiday, close those days.
    await A('POST', S(`salon/staff/${arjun.id}/leave`), { fromDate: D1, toDate: D1, reason: 'Family function' }, 201);
    await A('POST', S('salon/holidays'), { day: D2, name: 'Diwali' }, 201);
    const days = (await guest('GET', `/${salonLink.token}/days?services=${haircut.id}&person=${arjun.id}`)).data.days;
    assert.deepEqual([days.find((d) => d.date === D1).open, days.find((d) => d.date === D1).reason], [false, 'away']);
    assert.deepEqual([days.find((d) => d.date === D2).open, days.find((d) => d.date === D2).reason], [false, 'closed']);
    const anyone = (await guest('GET', `/${salonLink.token}/days?services=${haircut.id}&person=any`)).data.days;
    assert.equal(anyone.find((d) => d.date === D1).open, true);
    await salonBook({ services: [haircut.id], person: arjun.id, date: D1, time: '12:00' }, 409);
    // The calendar shows the online bookings, as holding their time.
    const calendar = await A('GET', S(`salon/calendar?date=${D}`));
    const online = calendar.appointments.filter((a) => a.source === 'guests_site');
    assert.equal(online.length, 3);
    assert.ok(online.every((a) => a.holds && a.online_booker === 'Asha Rao'));
  });

  await t.test('a salon request holds its time against the desk; the guest\'s page follows it live', async () => {
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { confirmMode: 'confirm' });
    const asked = await salonBook({ services: [haircut.id], person: priya.id, time: '14:00' });
    assert.equal(asked.data.status, 'requested');
    assert.equal(asked.data.requestReason, 'confirm');
    assert.match(asked.message, /Request sent/);
    const row = (await appointmentsOf((await bookingOf(asked.data.guestToken)).id))[0];
    // It waits 12 hours, never past its start.
    const expires = new Date(row.request_expires_at).getTime();
    assert.ok(Math.abs(expires - (Date.now() + 12 * 3600000)) < 120000 || expires === new Date(row.starts_at).getTime());
    const desk = await call('POST', S('salon/appointments'), { contactId: row.contact_id, skuId: beard.id, resourceId: priya.id, startsAt: momentAt(D, '14:10'), requestKey: key() },
      (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(desk.status, 409);
    assert.match(desk.body.message, /online booking request waiting/);
    // The core's status change sends a request to Online booking.
    const status = await call('PATCH', S(`appointments/${row.id}`), { status: 'cancelled' }, (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(status.status, 409);
    assert.match(status.body.message, /accept or decline it in Online booking/);
    // Accepted by the desk: booked, and the page's next words change.
    const accepted = await A('POST', S(`online-booking/bookings/${(await bookingOf(asked.data.guestToken)).id}/accept`), { requestKey: key() });
    assert.equal(accepted.status, 'booked');
    const page = await guest('GET', `/status/${asked.data.guestToken}`);
    assert.deepEqual([page.data.status, page.data.statusLabel], ['booked', 'Booked']);
    assert.ok(page.live);
    assert.equal((await audits(salon.id, 'appointment.accepted')).length, 1);
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { confirmMode: 'instant' });
  });

  await t.test('a guest changes the time (twice at most) and cancels, until the cut-off', async () => {
    const token = haircutBooking.guestToken;
    const status = (await guest('GET', `/status/${token}`)).data;
    assert.deepEqual([status.may.cancel, status.may.change, status.changesLeft], [true, true, 2]);
    const times = (await guest('GET', `/status/${token}/times?date=${D}`)).data;
    // Its own time is free to it.
    assert.ok(times.groups.flatMap((g) => g.times).some((x) => x.time === '10:00'));
    const moved = await guest('POST', `/status/${token}/move`, { date: D, time: '15:00' });
    assert.deepEqual([moved.data.time, moved.data.status, moved.data.changesLeft], ['15:00', 'booked', 1]);
    const rows = await appointmentsOf((await bookingOf(token)).id);
    assert.deepEqual(rows.map((r) => [localTime(r.starts_at), localTime(r.ends_at)]), [['15:00', '15:40'], ['15:40', '15:55']]);
    assert.deepEqual((await audits(salon.id, 'appointment.moved')).map((r) => [r.actor_id, r.channel]), [[null, 'guests_site'], [null, 'guests_site']]);
    await guest('POST', `/status/${token}/move`, { date: D, time: '16:00' });
    const third = await guest('POST', `/status/${token}/move`, { date: D, time: '17:00' }, 409);
    assert.equal(third.data.reason, 'cannot_change');
    // Within the cut-off it is cancelled by calling, not online.
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { cancelHours: 168 });
    const late = await guest('POST', `/status/${token}/cancel`, {}, 409);
    assert.equal(late.data.reason, 'cannot_cancel');
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { cancelHours: 3 });
    const cancelled = await guest('POST', `/status/${token}/cancel`, {});
    assert.deepEqual([cancelled.data.status, cancelled.live], ['cancelled', null]);
    assert.match(cancelled.data.next, /You cancelled this booking/);
    assert.ok((await appointmentsOf((await bookingOf(token)).id)).every((r) => r.status === 'cancelled'));
    assert.equal((await events(salon.id, 'appointment.cancelled')).filter((e) => e.actor_id === null && e.payload.by === 'guest').length, 2);
    // The calendar file of a booking still to come.
    const live = await salonBook({ services: [beard.id], person: priya.id, time: '18:00' });
    const ics = await call('GET', `/public/appointments/status/${live.data.guestToken}/calendar.ics`, undefined, null);
    assert.equal(ics.status, 200);
    assert.match(ics.headers.get('content-type'), /text\/calendar/);
    assert.match(ics.body.text, /SUMMARY:Beard trim at /);
  });

  await t.test('a salon that takes deposits: bookings come as requests; the UPI advance checked and recorded as the deposit, or declined', async () => {
    await A('PUT', S('salon/settings'), { depositPercent: 20, freeCancelHours: 4, lateCancelFeePercent: 50, noShowFeePercent: 100, opensAt: '09:00', closesAt: '21:00' });
    const page = (await guest('GET', `/${salonLink.token}`)).data;
    assert.deepEqual(page.advance, { percent: 20, upiId: null, deposits: true });
    const deposit = await salonBook({ services: [haircut.id], person: priya.id, time: '12:00' });
    assert.deepEqual([deposit.data.status, deposit.data.requestReason], ['requested', 'deposit']);
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { upiAdvance: true, upiId: 'shinesalon@okicici', upiPayee: 'Shine Salon' });
    const noUtr = await salonBook({ services: [haircut.id], person: priya.id, time: '12:45' }, 400);
    assert.equal(noUtr.data.field, 'advanceUtr');
    const paid = await salonBook({ services: [haircut.id], person: priya.id, time: '12:45', advanceUtr: '412345678901' });
    // 20% of ₹420 (₹400 and 5% GST): ₹84.
    assert.deepEqual([paid.data.status, paid.data.requestReason, paid.data.advance], ['requested', 'advance', { amount: '84.00', utr: '412345678901', received: false }]);
    const waiting = await A('GET', S('online-booking/requests'));
    assert.equal(waiting.requests.length, 2);
    const row = waiting.requests.find((r) => r.advance_utr === '412345678901');
    const accepted = await A('POST', S(`online-booking/bookings/${row.id}/accept`), { requestKey: key(), advanceReceived: true });
    assert.equal(accepted.status, 'booked');
    assert.ok(accepted.advance_receipt_no);
    const receipt = await one('SELECT * FROM business_collections WHERE id=$1', [accepted.advance_collection_id]);
    assert.deepEqual([Number(receipt.amount), receipt.method, receipt.reference], [84, 'upi', '412345678901']);
    const first = (await appointmentsOf(row.id))[0];
    assert.equal(Number((await one('SELECT deposit_collection_id FROM salon_appointment_details WHERE appointment_id=$1', [first.id])).deposit_collection_id), Number(receipt.id));
    const view = (await guest('GET', `/status/${paid.data.guestToken}`)).data;
    assert.deepEqual([view.advance.received, view.may.cancel, view.may.change], [true, false, false]);
    // A declined advance: the guest is told it is returned.
    const other = await salonBook({ services: [beard.id], person: priya.id, time: '13:30', advanceUtr: '412345678902' });
    const otherRow = (await A('GET', S('online-booking/requests'))).requests.find((r) => r.advance_utr === '412345678902');
    await A('POST', S(`online-booking/bookings/${otherRow.id}/decline`), { reason: 'x' }, 400);
    const declined = await A('POST', S(`online-booking/bookings/${otherRow.id}/decline`), { reason: 'Priya is fully booked that afternoon' });
    assert.equal(declined.status, 'declined');
    const declinedView = (await guest('GET', `/status/${other.data.guestToken}`)).data;
    assert.equal(declinedView.declineReason, 'Priya is fully booked that afternoon');
    assert.match(declinedView.next, /returns it to you/);
    await A('POST', S(`online-booking/bookings/${otherRow.id}/accept`), { requestKey: key() }, 409);
    // The deposit request answered too, then deposits off for the rest.
    await A('POST', S(`online-booking/bookings/${waiting.requests.find((r) => r.request_reason === 'deposit').id}/decline`), { reason: 'Please call to book this one' });
    await A('PATCH', S(`online-booking/links/${salonLink.id}`), { upiAdvance: false });
    await A('PUT', S('salon/settings'), { depositPercent: 0, freeCancelHours: 4, lateCancelFeePercent: 50, noShowFeePercent: 100, opensAt: '09:00', closesAt: '21:00' });
  });

  // --- A clinic ----------------------------------------------------------------------------------------
  await publishNotice(A, `/businesses/${clinic.id}`);
  const consult = await service(clinic, 'Consultation - Dr Anjali Rao', 'CONSULT-AR', '500', 0);
  const anjali = await resource(clinic, 'Dr Anjali Rao', clinicMain.id, 'General physician');
  const todayDate = daysFrom(0);
  await A('PUT', C(`clinic/doctors/${anjali.id}`), { speciality: 'General medicine', consultationSkuId: consult.id, slotMinutes: 10, followUpDays: 7,
    qualifications: 'MBBS, MD (General Medicine)', registrationNo: 'TSMC/45127', council: 'Telangana State Medical Council',
    sessions: [{ dow: weekdayOf(D), starts: '10:00', ends: '11:00', maxPatients: 4 }, { dow: weekdayOf(todayDate), starts: '00:00', ends: '23:59', maxPatients: 50 }] });
  const clinicBook = (body, expected = 201) => guest('POST', `/${clinicLink.token}/bookings`, { clientKey: key(), name: 'Lakshmi Devi', mobile: mobile(), person: anjali.id,
    date: D, personAge: 34, personSex: 'female', visitKind: 'new', ...body }, expected);
  let clinicFirst;
  await t.test('a clinic: the doctor with fee and registration, OPD sessions and slots, the online share, closing when a session starts', async () => {
    const page = (await guest('GET', `/${clinicLink.token}`)).data;
    assert.equal(page.kind, 'clinic');
    assert.deepEqual(page.people.map((p) => [p.name, p.fee, p.qualifications, p.registrationNo, p.council, p.slotMinutes]),
      [['Dr Anjali Rao', '500.00', 'MBBS, MD (General Medicine)', 'TSMC/45127', 'Telangana State Medical Council', 10]]);
    assert.deepEqual([page.asks.clinic, page.asks.adult, page.link.confirm], [true, false, true]);
    const days = (await guest('GET', `/${clinicLink.token}/days?person=${anjali.id}`)).data.days;
    assert.equal(days.length, 7);
    // Today's session started at midnight: online booking for it has closed.
    assert.deepEqual([days[0].open, days[0].reason], [false, 'started']);
    assert.equal(days.find((d) => d.date === D).first, '10:00');
    const times = (await guest('GET', `/${clinicLink.token}/times?person=${anjali.id}&date=${D}`)).data;
    assert.deepEqual(times.groups.flatMap((g) => g.times).map((x) => x.time), ['10:00', '10:10', '10:20', '10:30', '10:40', '10:50']);
    // The patient's details are asked.
    assert.equal((await clinicBook({ time: '10:00', personAge: undefined }, 400)).data.field, 'personAge');
    assert.equal((await clinicBook({ time: '10:00', visitKind: 'maybe' }, 400)).data.field, 'visitKind');
    clinicFirst = await clinicBook({ time: '10:00', reason: 'Fever for three days', mobile: '9811122233' });
    assert.deepEqual([clinicFirst.data.status, clinicFirst.data.requestReason, clinicFirst.data.reason], ['requested', 'confirm', 'Fever for three days']);
    const forChild = await clinicBook({ time: '10:10', forWhom: 'someone_else', personName: 'Aarav', personAge: 6, personSex: 'male', visitKind: 'follow_up' });
    assert.deepEqual([forChild.data.forWhom, forChild.data.personName], ['someone_else', 'Aarav']);
    // Half of four patients may book online: the session is full online now.
    const full = (await guest('GET', `/${clinicLink.token}/times?person=${anjali.id}&date=${D}`)).data;
    assert.deepEqual([full.groups.length, full.reason], [0, 'full']);
    const third = await clinicBook({ time: '10:20' }, 409);
    assert.equal(third.data.reason, 'slot_taken');
    // The desk's own slots show the requests' slots taken, and the desk cannot book over one.
    const desk = await A('GET', C(`clinic/slots?doctor=${anjali.id}&day=${D}`));
    assert.deepEqual(desk.slots.filter((s) => s.taken).map((s) => localTime(s.starts_at)), ['10:00', '10:10']);
    const contact = (await bookingOf(clinicFirst.data.guestToken)).contact_id;
    const clash = await call('POST', C('appointments'), { contactId: contact, skuId: consult.id, resourceId: anjali.id, startsAt: momentAt(D, '10:00'), endsAt: momentAt(D, '10:10') },
      (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(clash.status, 409);
    assert.match(clash.body.message, /online booking request waiting/);
  });

  await t.test('a clinic: the desk accepts one request and declines another; a request not answered in time expires and frees its slot; the bell', async () => {
    const desk = await staff(clinic, 'clinic-desk@test.invalid', 'receptionist');
    const waiting = await desk.call('GET', C('online-booking/requests'));
    assert.equal(waiting.requests.length, 2);
    assert.deepEqual(waiting.requests.map((r) => [r.status, r.services, r.resource_name]), [['requested', 'Consultation - Dr Anjali Rao', 'Dr Anjali Rao'], ['requested', 'Consultation - Dr Anjali Rao', 'Dr Anjali Rao']]);
    const bell = await desk.call('GET', C('notifications'));
    const item = bell.items.find((i) => i.id.startsWith('online-requests:'));
    assert.equal(item.title, '2 online booking requests waiting');
    assert.match(item.link, /\/online-booking$/);
    const [first, second] = waiting.requests;
    const accepted = await desk.call('POST', C(`online-booking/bookings/${first.id}/accept`), { requestKey: key() });
    assert.equal(accepted.status, 'booked');
    // Accepting twice changes nothing.
    assert.equal((await desk.call('POST', C(`online-booking/bookings/${first.id}/accept`), { requestKey: key() })).status, 'booked');
    await desk.call('POST', C(`online-booking/bookings/${second.id}/decline`), { reason: 'Doctor is in surgery that morning' });
    const declined = (await guest('GET', `/status/${(await one('SELECT guest_token FROM business_online_bookings WHERE id=$1', [second.id])).guest_token}`)).data;
    assert.deepEqual([declined.status, declined.declineReason], ['declined', 'Doctor is in surgery that morning']);
    // A doctor (view only) cannot answer.
    const doctor = await staff(clinic, 'clinic-doctor@test.invalid', 'doctor');
    await doctor.call('GET', C('online-booking/requests'));
    await doctor.call('POST', C(`online-booking/bookings/${first.id}/decline`), { reason: 'Not mine' }, 403);
    // One more online place in the session; this request is never answered.
    const late = await clinicBook({ time: '10:30' });
    const lateBooking = await bookingOf(late.data.guestToken);
    await pool.query("UPDATE business_appointments SET request_expires_at=now()-interval '1 minute' WHERE online_booking_id=$1", [lateBooking.id]);
    // Read as expired at once, by the guest and the desk alike, and marked so with the business's own audit row.
    const expired = (await guest('GET', `/status/${late.data.guestToken}`)).data;
    assert.equal(expired.status, 'expired');
    assert.match(expired.next, /did not confirm this booking in time/);
    const marked = await audits(clinic.id, 'appointment.expired');
    assert.deepEqual(marked.map((r) => [r.actor_id, r.channel]), [[null, 'automatic']]);
    assert.equal((await events(clinic.id, 'appointment.expired'))[0].actor_id, null);
    assert.equal((await appointmentsOf(lateBooking.id))[0].status, 'expired');
    // Its slot is free again.
    const times = (await guest('GET', `/${clinicLink.token}/times?person=${anjali.id}&date=${D}`)).data;
    assert.ok(times.groups.flatMap((g) => g.times).some((x) => x.time === '10:30'));
    const unanswered = await desk.call('GET', C('online-booking/requests'));
    assert.equal(unanswered.unanswered.length, 1);
    const lapsed = (await desk.call('GET', C('notifications'))).items.find((i) => i.id.startsWith('online-lapsed:'));
    assert.equal(lapsed.title, '1 online request was not answered in time');
    await desk.call('POST', C(`online-booking/bookings/${lateBooking.id}/accept`), { requestKey: key() }, 409);
    // New online bookings today, on the bell.
    assert.ok((await desk.call('GET', C('notifications'))).items.find((i) => i.id.startsWith('online-today:')));
  });

  await t.test('a clinic: leave closes the day; the token at the desk for a contact not yet a patient, and for a child booked by a parent', async () => {
    const leave = await A('POST', C(`clinic/doctors/${anjali.id}/leave`), { fromDate: D, toDate: D, reason: 'Conference' }, 201);
    assert.equal(leave.booked, 1);
    const days = (await guest('GET', `/${clinicLink.token}/days?person=${anjali.id}`)).data.days;
    assert.deepEqual([days.find((d) => d.date === D).open, days.find((d) => d.date === D).reason], [false, 'away']);
    await A('POST', C(`clinic/leave/${leave.id}/cancel`), {});
    // The accepted booking comes due today: the desk registers the patient, then gives the token.
    const booking = await bookingOf(clinicFirst.data.guestToken);
    const [row] = await appointmentsOf(booking.id);
    await toToday(row.id, 600);
    const notPatient = await call('POST', C('clinic/tokens'), { appointmentId: row.id }, (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.deepEqual([notPatient.status, notPatient.body.data.reason], [409, 'not_a_patient']);
    await A('POST', C('clinic/patients'), { contactId: booking.contact_id, sex: booking.person_sex, ageYears: booking.person_age,
      consent: { purposes: ['treatment'], method: 'verbal', givenBy: 'Self' } }, 201);
    const token = await A('POST', C('clinic/tokens'), { appointmentId: row.id }, 201);
    assert.equal(Number(token.contact_id), Number(booking.contact_id));
    // A child booked by a parent: the child is registered and takes the appointment.
    const child = await clinicBook({ time: '10:40', forWhom: 'someone_else', personName: 'Aarav', personAge: 6, personSex: 'male', mobile: '9811122299' });
    const childBooking = await bookingOf(child.data.guestToken);
    await A('POST', C(`online-booking/bookings/${childBooking.id}/accept`), { requestKey: key() });
    const [childRow] = await appointmentsOf(childBooking.id);
    await toToday(childRow.id, 620);
    const aarav = await A('POST', C('clinic/patients'), { name: 'Aarav', phone: '9811122299', guardianName: 'Lakshmi Devi', sex: 'male', ageYears: 6,
      consent: { purposes: ['treatment'], method: 'verbal', givenBy: 'Mother' } }, 201);
    const childToken = await A('POST', C('clinic/tokens'), { appointmentId: childRow.id, contactId: aarav.contact_id }, 201);
    assert.equal(Number(childToken.contact_id), Number(aarav.contact_id));
    assert.equal(Number((await one('SELECT contact_id FROM business_appointments WHERE id=$1', [childRow.id])).contact_id), Number(aarav.contact_id));
    assert.equal((await audits(clinic.id, 'appointment.patient_set')).length, 1);
    // A booking made for the booker themselves is not given to another patient.
    const own = await clinicBook({ time: '10:20', mobile: '9811122288' });
    const ownBooking = await bookingOf(own.data.guestToken);
    await A('POST', C(`online-booking/bookings/${ownBooking.id}/accept`), { requestKey: key() });
    const [ownRow] = await appointmentsOf(ownBooking.id);
    await toToday(ownRow.id, 640);
    const wrong = await call('POST', C('clinic/tokens'), { appointmentId: ownRow.id, contactId: aarav.contact_id }, (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(wrong.status, 409);
    assert.match(wrong.body.message, /another patient's/);
    // A request gets no token and no visit until it is accepted.
    const asked = await clinicBook({ date: D, time: '10:50', mobile: '9811122277' });
    const [askedRow] = await appointmentsOf((await bookingOf(asked.data.guestToken)).id);
    const visit = await call('POST', C('clinic/visits'), { appointmentId: askedRow.id }, (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(visit.status, 409);
    assert.match(visit.body.message, /accept it in Online booking first/);
    await toToday(askedRow.id, 660, 10, 60);
    const noToken = await call('POST', C('clinic/tokens'), { appointmentId: askedRow.id }, (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(noToken.status, 409);
    // Today's figures: a person's day counts what holds their time (the request too); the
    // appointments today are bookings only; a declined request moved to today counts in neither.
    const [declinedRow] = await all("SELECT id FROM business_appointments WHERE business_id=$1 AND status='declined' ORDER BY id LIMIT 1", [clinic.id]);
    await toToday(declinedRow.id, 680);
    const overview = await A('GET', C('overview'));
    const anjaliToday = overview.appointments.people.find((p) => p.name === 'Dr Anjali Rao');
    assert.equal(anjaliToday.booked, 4);
    const summary = await A('GET', C('summary'));
    assert.equal(summary.appointments_today, 3);
  });

  await t.test('a family\'s mobile: the desk sees the patients who share it and gives the token to the one who came, never a second record', async () => {
    const family = '9849078901';
    const consent = { purposes: ['treatment'], method: 'verbal', givenBy: 'Self' };
    // A father and his son, patients of the clinic on the family's mobile, typed two ways; a grandmother whose
    // record is switched off; a customer on the same mobile who is no patient; a boy of the son's age on another mobile.
    const father = await A('POST', C('clinic/patients'), { name: 'Ramesh Iyer', phone: '+91 98490 78901', sex: 'male', ageYears: 41, consent }, 201);
    const son = await A('POST', C('clinic/patients'), { name: 'Advik Iyer', phone: '98490-78901', guardianName: 'Ramesh Iyer', sex: 'male', ageYears: 6,
      consent: { ...consent, givenBy: 'Father' } }, 201);
    const grandmother = await A('POST', C('clinic/patients'), { name: 'Kamala Iyer', phone: family, sex: 'female', ageYears: 72, consent }, 201);
    await pool.query('UPDATE business_contacts SET active=false WHERE business_id=$1 AND id=$2', [clinic.id, grandmother.contact_id]);
    await A('POST', C('contacts'), { kind: 'customer', name: 'Iyer Electricals', phone: family }, 201);
    const otherBoy = await A('POST', C('clinic/patients'), { name: 'Advik Rao', phone: '9849078902', sex: 'male', ageYears: 6, consent }, 201);
    const patients = async () => (await one('SELECT count(*)::int AS n FROM health_patients WHERE business_id=$1', [clinic.id])).n;
    const before = await patients();
    const firstFree = async () => (await guest('GET', `/${clinicLink.token}/times?person=${anjali.id}&date=${D}`)).data.groups.flatMap((g) => g.times)[0].time;
    // The father books his son online; the desk accepts it, and it comes due today.
    const forSon = await clinicBook({ time: await firstFree(), name: 'Ramesh Iyer', mobile: family, forWhom: 'someone_else', personName: 'Advik Iyer', personAge: 6,
      personSex: 'male', visitKind: 'follow_up' });
    const sonBooking = await bookingOf(forSon.data.guestToken);
    await A('POST', C(`online-booking/bookings/${sonBooking.id}/accept`), { requestKey: key() });
    const [sonRow] = await appointmentsOf(sonBooking.id);
    await toToday(sonRow.id, 700);
    // The desk sees the clinic's patients on that mobile however it was typed, as the patients list shows them:
    // not the switched-off record, not the customer who is no patient, not the boy on another mobile.
    const seen = (await A('GET', C(`clinic/appointments/${sonRow.id}/same-mobile`))).patients;
    assert.deepEqual(seen.map((p) => p.name).sort(), ['Advik Iyer', 'Ramesh Iyer']);
    const sonSeen = seen.find((p) => p.name === 'Advik Iyer');
    assert.deepEqual(Object.keys(sonSeen).sort(), ['age', 'booked', 'consent_active', 'contact_id', 'name', 'patient_no', 'sex']);
    assert.deepEqual([sonSeen.patient_no, sonSeen.age, sonSeen.sex, sonSeen.consent_active], [son.patient_no, 6, 'male', true]);
    assert.ok(seen.findIndex((p) => p.booked) <= 0, 'the record the booking found, when a patient, comes first');
    // The token goes to the son's own record: no second patient, the appointment his, audited.
    const audited = (await audits(clinic.id, 'appointment.patient_set')).length;
    const token = await A('POST', C('clinic/tokens'), { appointmentId: sonRow.id, contactId: son.contact_id }, 201);
    assert.equal(Number(token.contact_id), Number(son.contact_id));
    assert.equal(Number((await one('SELECT contact_id FROM business_appointments WHERE id=$1', [sonRow.id])).contact_id), Number(son.contact_id));
    assert.equal(await patients(), before);
    assert.deepEqual((await audits(clinic.id, 'appointment.patient_set')).slice(audited).map((r) => [Number(r.entity_id), Number(r.details.to), r.details.why]),
      [[Number(sonRow.id), Number(son.contact_id), 'someone_else']]);
    // The father books for himself on the same mobile, and the booking may find another of the family's records
    // (the one used last): the desk gives the token to his own, which shares the mobile, and never to someone who does not.
    const own = await clinicBook({ time: await firstFree(), name: 'Ramesh Iyer', mobile: family, personAge: 41, personSex: 'male' });
    const ownBooking = await bookingOf(own.data.guestToken);
    await A('POST', C(`online-booking/bookings/${ownBooking.id}/accept`), { requestKey: key() });
    const [ownRow] = await appointmentsOf(ownBooking.id);
    await toToday(ownRow.id, 720);
    const ownSeen = (await A('GET', C(`clinic/appointments/${ownRow.id}/same-mobile`))).patients;
    assert.deepEqual(ownSeen.map((p) => p.name).sort(), ['Advik Iyer', 'Ramesh Iyer']);
    assert.ok(ownSeen.findIndex((p) => p.booked) <= 0);
    const desk = (await signIn(base, 'online-a@test.invalid', password)).token;
    const stranger = await call('POST', C('clinic/tokens'), { appointmentId: ownRow.id, contactId: otherBoy.contact_id }, desk);
    assert.deepEqual([stranger.status, /another patient's/.test(stranger.body.message)], [409, true]);
    const ownToken = await A('POST', C('clinic/tokens'), { appointmentId: ownRow.id, contactId: father.contact_id }, 201);
    assert.equal(Number(ownToken.contact_id), Number(father.contact_id));
    assert.equal(await patients(), before);
    const why = (await audits(clinic.id, 'appointment.patient_set')).slice(audited).map((r) => r.details.why);
    assert.deepEqual(why, Number(ownBooking.contact_id) === Number(father.contact_id) ? ['someone_else'] : ['someone_else', 'same_mobile']);
    // No such appointment here: 404.
    assert.equal((await call('GET', C('clinic/appointments/999999/same-mobile'), undefined, desk)).status, 404);
  });

  // --- An optical shop -----------------------------------------------------------------------------------
  await A('PATCH', O(`locations/${opticalMain.id}`), { name: opticalMain.name, openingHours: allWeek });
  const eyeTest = await service(optical, 'Eye test', 'EYE-TEST', '100', 18);
  const ravi = await resource(optical, 'Ravi (optometrist)', opticalMain.id, 'Optometrist');
  const backRoom = await resource(optical, 'Back room', opticalMain.id);
  let opticalLink;
  await t.test('an optical shop: services shown with their length, people hidden, the location\'s hours, the core\'s clash with the desk', async () => {
    opticalLink = await linkFor(optical, opticalMain.id);
    assert.equal(opticalLink.slotStepMinutes, 30);
    let page = (await guest('GET', `/${opticalLink.token}`)).data;
    assert.deepEqual([page.services.length, page.kind], [0, 'hours']);
    await A('PUT', O(`online-booking/links/${opticalLink.id}/shown`), { services: [{ skuId: eyeTest.id, shown: true }] }, 400);
    await A('PUT', O(`online-booking/links/${opticalLink.id}/shown`), { services: [{ skuId: eyeTest.id, shown: true, minutes: 20 }], people: [{ resourceId: backRoom.id, shown: false }] });
    page = (await guest('GET', `/${opticalLink.token}`)).data;
    // The price a guest pays: the item's price, with GST when the shop's prices are before tax.
    const inclusive = (await one('SELECT tax_mode FROM business_settings WHERE business_id=$1', [optical.id])).tax_mode === 'inclusive';
    assert.deepEqual(page.services.map((s) => [s.label, s.minutes, s.price]), [['Eye test', 20, inclusive ? '100.00' : '118.00']]);
    assert.deepEqual(page.people.map((p) => p.name), ['Ravi (optometrist)']);
    const times = (await guest('GET', `/${opticalLink.token}/times?services=${eyeTest.id}&person=any&date=${D}`)).data;
    assert.equal(times.groups[0].times[0].time, '09:00');
    assert.equal(times.groups.at(-1).times.at(-1).time, '19:30');
    const booked = await guest('POST', `/${opticalLink.token}/bookings`, { clientKey: key(), services: [eyeTest.id], person: 'any', date: D, time: '10:00', name: 'Ravi Kumar', mobile: mobile() }, 201);
    assert.deepEqual([booked.data.status, booked.data.person], ['booked', 'Ravi (optometrist)']);
    const contact = (await bookingOf(booked.data.guestToken)).contact_id;
    const clash = await call('POST', O('appointments'), { contactId: contact, skuId: eyeTest.id, resourceId: ravi.id, startsAt: momentAt(D, '10:10'), endsAt: momentAt(D, '10:30') },
      (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(clash.status, 409);
    const list = await A('GET', O(`appointments?source=guests_site&from=${D}&to=${D}`));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].source, 'guests_site');
    // No hours that day: closed.
    await A('PATCH', O(`locations/${opticalMain.id}`), { name: opticalMain.name, openingHours: { ...allWeek, [['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][weekdayOf(D1)]]: null } });
    const days = (await guest('GET', `/${opticalLink.token}/days?services=${eyeTest.id}&person=any`)).data.days;
    assert.deepEqual([days.find((d) => d.date === D1).open, days.find((d) => d.date === D1).reason], [false, 'closed']);
    await A('PATCH', O(`locations/${opticalMain.id}`), { name: opticalMain.name, openingHours: allWeek });
  });

  await t.test('limits: open bookings per mobile, bookings per address and per mobile; a mobile\'s no-shows make a request', async () => {
    await A('PATCH', O(`online-booking/links/${opticalLink.id}`), { maxOpenPerMobile: 2 });
    const same = '9822233344';
    const book = (time, expected = 201, extra = {}) => guest('POST', `/${opticalLink.token}/bookings`, { clientKey: key(), services: [eyeTest.id], person: 'any', date: D, time, name: 'Meera', mobile: same, ...extra }, expected);
    await book('11:00');
    await book('11:30');
    const third = await book('12:00', 409);
    assert.equal(third.data.reason, 'mobile_limit');
    // One address sending too many: 429 after 30 in ten minutes (a bad request counts too).
    const from = '10.250.250.250';
    for (let n = 0; n < 30; n += 1) await guest('POST', `/${opticalLink.token}/bookings`, { clientKey: key(), mobile: mobile() }, 400, from);
    const busy = await call('POST', `/public/appointments/${opticalLink.token}/bookings`, { clientKey: key(), mobile: mobile() }, null, { 'X-Forwarded-For': from });
    assert.equal(busy.status, 429);
    // One mobile from many addresses: 429 after 8 in an hour.
    for (let n = 0; n < 8; n += 1) await guest('POST', `/${opticalLink.token}/bookings`, { clientKey: key(), mobile: '9833344455' }, 400);
    const repeated = await call('POST', `/public/appointments/${opticalLink.token}/bookings`, { clientKey: key(), mobile: '9833344455' }, null, { 'X-Forwarded-For': address() });
    assert.equal(repeated.status, 429);
    // Two no-shows in 90 days: the next online booking waits for the desk, which sees them.
    const regular = await A('POST', O('contacts'), { kind: 'customer', name: 'Suresh', phone: '+91 98444 55566' }, 201);
    for (const day of [daysFrom(-10), daysFrom(-3)]) {
      const missed = await A('POST', O('appointments'), { contactId: regular.id, skuId: eyeTest.id, resourceId: ravi.id, startsAt: momentAt(day, '11:00'), endsAt: momentAt(day, '11:20') }, 201);
      await A('PATCH', O(`appointments/${missed.id}`), { status: 'no_show' });
    }
    const flagged = await guest('POST', `/${opticalLink.token}/bookings`, { clientKey: key(), services: [eyeTest.id], person: 'any', date: D, time: '15:00', name: 'Suresh', mobile: '9844455566' }, 201);
    assert.deepEqual([flagged.data.status, flagged.data.requestReason], ['requested', 'no_shows']);
    const row = (await A('GET', O('online-booking/requests'))).requests[0];
    assert.equal(row.no_shows, 2);
    // The customer staff know is used as they are.
    assert.equal(Number((await bookingOf(flagged.data.guestToken)).contact_id), Number(regular.id));
  });

  // --- A garage --------------------------------------------------------------------------------------
  await A('PATCH', G(`locations/${garageMain.id}`), { name: garageMain.name, openingHours: allWeek });
  const generalService = await service(garage, 'General service', 'GEN-SERVICE', '1500', 18);
  await resource(garage, 'Bay 1', garageMain.id, 'Bay');
  await resource(garage, 'Bay 2', garageMain.id, 'Bay');
  let garageLink;
  await t.test('a garage: the vehicle asked, its record linked, its booking among those a job card opens from (a request not)', async () => {
    garageLink = await linkFor(garage, garageMain.id);
    await A('PUT', G(`online-booking/links/${garageLink.id}/shown`), { services: [{ skuId: generalService.id, shown: true, minutes: 120 }] });
    const vehicle = await A('POST', G('garage/vehicles'), { registrationNo: 'TS09EA4521', make: 'Maruti', model: 'Swift', owner: { name: 'Kiran', phone: '9855566677' } }, 201);
    const book = (extra, expected = 201) => guest('POST', `/${garageLink.token}/bookings`, { clientKey: key(), services: [generalService.id], person: 'any', date: D, time: '09:00',
      name: 'Kiran', mobile: '9855566677', vehicleNo: 'ts 09 ea 4521', vehicleMake: 'Maruti', vehicleModel: 'Swift', ...extra }, expected);
    assert.equal((await book({ vehicleNo: '' }, 400)).data.field, 'vehicleNo');
    assert.equal((await book({ vehicleModel: '' }, 400)).data.field, 'vehicleModel');
    const made = await book({});
    assert.deepEqual(made.data.vehicle, { number: 'TS09EA4521', make: 'Maruti', model: 'Swift' });
    const booking = await bookingOf(made.data.guestToken);
    assert.equal(Number(booking.vehicle_id), Number(vehicle.id));
    // Brought forward to today, it is a booking a job card opens from, with the vehicle typed.
    const [row] = await appointmentsOf(booking.id);
    await toToday(row.id, 600, 120);
    let open = await A('GET', G('garage/bookings'));
    assert.deepEqual(open.map((b) => [Number(b.id), b.online_vehicle_no, Number(b.online_vehicle_id)]), [[Number(row.id), 'TS09EA4521', Number(vehicle.id)]]);
    // A request is not, until the desk accepts it.
    await A('PATCH', G(`online-booking/links/${garageLink.id}`), { confirmMode: 'confirm' });
    const asked = await book({ time: '13:00', mobile: '9855566678', vehicleNo: 'KA01MJ1234', vehicleMake: 'Honda', vehicleModel: 'City' });
    const [askedRow] = await appointmentsOf((await bookingOf(asked.data.guestToken)).id);
    await toToday(askedRow.id, 780, 120, 30);
    open = await A('GET', G('garage/bookings'));
    assert.deepEqual(open.map((b) => Number(b.id)), [Number(row.id)]);
    await A('PATCH', G(`online-booking/links/${garageLink.id}`), { confirmMode: 'instant' });
  });

  // --- A gym's free trial ----------------------------------------------------------------------------
  // A gym opens early and closes late.
  await A('PATCH', M(`locations/${gymMain.id}`), { name: gymMain.name, openingHours: Object.fromEntries(Object.keys(allWeek).map((day) => [day, { open: '05:00', close: '22:00' }])) });
  const trialClass = await service(gym, 'Free trial class', 'TRIAL', '0', 5);
  await resource(gym, 'Coach Vikram', gymMain.id, 'Trainer');
  await t.test('a gym\'s free trial: an enquiry from the website with its trial booking; someone who has had a trial is told to call', async () => {
    const link = await linkFor(gym, gymMain.id);
    await A('PUT', M(`online-booking/links/${link.id}/shown`), { services: [{ skuId: trialClass.id, shown: true, minutes: 60 }] });
    const page = (await guest('GET', `/${link.token}`)).data;
    assert.equal(page.asks.trial, true);
    const book = (expected = 201, time = '07:00') => guest('POST', `/${link.token}/bookings`, { clientKey: key(), services: [trialClass.id], person: 'any', date: D, time,
      name: 'Rahul Verma', mobile: '9866677788' }, expected);
    const made = await book();
    const booking = await bookingOf(made.data.guestToken);
    const lead = await one('SELECT *,follow_up_on::text AS follow_up_day FROM member_leads WHERE id=$1', [booking.lead_id]);
    assert.deepEqual([lead.source, lead.created_by, Number(lead.contact_id), lead.status, lead.follow_up_day], ['website', null, Number(booking.contact_id), 'open', D]);
    assert.match(lead.interest, /^Free trial: Free trial class/);
    const leads = await A('GET', M('member-plans/leads?limit=10'));
    assert.equal(leads.items.find((l) => Number(l.id) === Number(lead.id)).created_by_name, 'Guest (online)');
    assert.equal((await audits(gym.id, 'member_lead.created')).find((r) => Number(r.entity_id) === Number(lead.id)).channel, 'guests_site');
    // The desk gives the trial pass from the enquiry; a second free trial is refused.
    const slabs = (await A('GET', M('tax-rates'))).items;
    const plan = await A('POST', M('member-plans/plans'), { name: 'Gym 30 days', kind: 'duration', durationUnit: 'days', duration: '30',
      policy: 'Fees for days not used are refunded pro rata.', item: { price: '999', taxRateId: slabs.find((r) => Number(r.rate) === 5).id, hsnCode: '999723' } }, 201);
    await A('POST', M(`member-plans/leads/${lead.id}/trial`), { requestKey: key(), planId: plan.id, days: '3' }, 201);
    const again = await book(409, '08:00');
    assert.equal(again.data.reason, 'not_new');
  });

  // --- The module, the link and the plan --------------------------------------------------------------
  await t.test('the module off, the link off, the plan ended: the page and the booking are refused calmly, with the business\'s phone', async () => {
    const body = { clientKey: key(), services: [generalService.id], person: 'any', date: D, time: '15:00', name: 'Late Comer', mobile: mobile(), vehicleNo: 'TS07AB1111', vehicleMake: 'Tata', vehicleModel: 'Nexon' };
    await A('PUT', G('modules/online_appointments'), { enabled: false });
    let refused = await guest('GET', `/${garageLink.token}`, undefined, 403);
    assert.equal(refused.data.reason, 'feature_off');
    assert.equal(refused.data.card.name, garage.name);
    assert.match(refused.message, /isn't taking online bookings right now/);
    assert.equal((await guest('POST', `/${garageLink.token}/bookings`, body, 403)).data.reason, 'feature_off');
    await A('PUT', G('modules/online_appointments'), { enabled: true });
    await A('PATCH', G(`online-booking/links/${garageLink.id}`), { enabled: false });
    refused = await guest('GET', `/${garageLink.token}/days?services=${generalService.id}`, undefined, 409);
    assert.equal(refused.data.reason, 'booking_off');
    await A('PATCH', G(`online-booking/links/${garageLink.id}`), { enabled: true });
    // The plan ended.
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [garage.id]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything) VALUES($1,'trial',business_local_today($1)-30,business_local_today($1)-17,TRUE)`, [garage.id]);
    refused = await guest('GET', `/${garageLink.token}`, undefined, 409);
    assert.equal(refused.data.reason, 'not_taking_orders');
    assert.equal((await guest('POST', `/${garageLink.token}/bookings`, { ...body, clientKey: key() }, 409)).data.reason, 'not_taking_orders');
    // No such link, no such booking.
    assert.equal((await guest('GET', '/abc', undefined, 404)).data.reason, 'not_available');
    await guest('GET', '/status/not-a-booking-token-at-all-really-not', undefined, 404);
  });

  // --- Personal data -------------------------------------------------------------------------------------
  await t.test('an erased customer: erasure waits for an online request still to come; their booking keeps no details; their mobile makes a new customer', async () => {
    const request = await salonBook({ services: [beard.id], person: priya.id, time: '19:00', mobile: '9877788899', name: 'Divya', note: 'Allergic to some oils' });
    const booking = await bookingOf(request.data.guestToken);
    const P = (suffix) => S(`privacy/${suffix}`);
    const asked = await A('POST', P('requests'), { kind: 'erasure', personId: booking.contact_id, details: 'Asked to erase her details', requestKey: key() }, 201);
    const blocked = await call('POST', P(`requests/${asked.id}/erase`), { requestKey: key() }, (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.equal(blocked.status, 409);
    assert.ok(blocked.body.data.open.some((line) => /appointment still to come/.test(line)));
    await guest('POST', `/status/${request.data.guestToken}/cancel`, {});
    await A('POST', P(`requests/${asked.id}/erase`), { requestKey: key() });
    const erased = await one('SELECT * FROM business_online_bookings WHERE id=$1', [booking.id]);
    // A salon's erased client is named as one.
    assert.deepEqual([erased.booker_name, erased.mobile, erased.note], [`Erased client #${booking.contact_id}`, null, null]);
    const page = (await guest('GET', `/status/${request.data.guestToken}`)).data;
    assert.deepEqual([page.name, page.mobile, page.note], [`Erased client #${booking.contact_id}`, null, null]);
    const again = await salonBook({ services: [beard.id], person: priya.id, time: '19:30', mobile: '9877788899', name: 'Divya' });
    assert.notEqual(Number((await bookingOf(again.data.guestToken)).contact_id), Number(booking.contact_id));
  });

  // --- The tomorrow list and reminders ----------------------------------------------------------------
  await t.test('tomorrow\'s online bookings, with the reminder only for those who agreed', async () => {
    const tomorrow = daysFrom(1);
    const agreed = await guest('POST', `/${opticalLink.token}/bookings`, { clientKey: key(), services: [eyeTest.id], person: 'any', date: tomorrow, time: '17:00', name: 'Nisha',
      mobile: mobile() }, 201);
    const list = await A('GET', O('online-booking/tomorrow'));
    assert.equal(list.day, tomorrow);
    const row = list.bookings.find((b) => b.booker_name === 'Nisha');
    assert.equal(row.reminders_ok, false);
    const refused = await call('POST', O(`online-booking/bookings/${row.id}/reminder-sent`), {}, (await signIn(base, 'online-a@test.invalid', password)).token);
    assert.deepEqual([refused.status, refused.body.data && refused.body.data.reason], [409, 'consent_required']);
    assert.ok(agreed.data.guestToken);
  });

  // --- This migration's Down and Up -----------------------------------------------------------------------
  await t.test('the migration\'s Down half puts the rules back (requests become cancelled bookings), and Up again', async () => {
    const file = fs.readdirSync(path.resolve(__dirname, '../../migrations')).find((name) => name.endsWith('_online-appointments.sql'));
    const stamp = Number(file.split('_')[0]);
    await pool.end();
    pool = null;
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    const scratch = new Client({ ...connection, database });
    await scratch.connect();
    try {
      const left = (await scratch.query(`SELECT to_regclass('business_online_bookings') AS bookings,to_regclass('business_booking_links') AS links,
        (SELECT count(*)::int FROM platform_modules WHERE code='online_appointments') AS module,
        (SELECT count(*)::int FROM business_appointments WHERE created_by IS NULL) AS no_maker,
        (SELECT count(*)::int FROM business_appointments WHERE status NOT IN ('booked','completed','cancelled','no_show')) AS other`)).rows[0];
      assert.deepEqual(left, { bookings: null, links: null, module: 0, no_maker: 0, other: 0 });
      await migrate({ direction: 'up', count: Infinity });
      const back = (await scratch.query("SELECT to_regclass('business_online_bookings') IS NOT NULL AS bookings,(SELECT count(*)::int FROM platform_modules WHERE code='online_appointments') AS module")).rows[0];
      assert.deepEqual(back, { bookings: true, module: 1 });
    } finally {
      await scratch.end();
    }
  });
});
