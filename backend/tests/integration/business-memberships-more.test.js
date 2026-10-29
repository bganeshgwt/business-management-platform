const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { publishNotice, giveConsent } = require('./helpers/privacy');
const { addDays, daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// What a gym, studio or coaching centre does beyond selling and renewing:
// the class timetable with bookings, the waitlist promoted (two asking for
// the last place at once), late-cancel and no-show penalties, attendance at
// check-in; trainers' pay and sales commission to the paisa, paid through the
// expense book; visit limits across a week's end on the business's clock,
// hours and branches refused with the reason, seats checked in on their own,
// add-ons ending with the membership; freeze and transfer fees, a freeze's
// notice, a renewal moved by a freeze; a move to a cheaper plan credited to
// the paisa; an instalment schedule changed by a manager and a late fee; a
// refund due paid later and the joining fee back in part; memberships
// brought in from another system that are never sales; students with
// guardians and test results; enquiries and trial passes; the reminder
// lists; the signed acceptance of the refund policy. Refusals with their
// codes, idempotent retries, audit and events. Runs on its own throwaway
// database with every migration applied (and this one taken down and up again).
test('gyms, studios and coaching: classes, pay, plan options, fees, changes, students and enquiries', { timeout: 600000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, scratch, created = false;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (scratch) await scratch.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  const { runner } = await import('node-pg-migrate');
  const dir = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the migration goes down to before itself and up again', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const tables = ['member_seats', 'member_addons', 'member_fees', 'member_refunds', 'member_rooms', 'member_class_slots', 'member_class_sessions', 'member_class_bookings',
      'member_pay_rules', 'member_payouts', 'member_guardians', 'member_test_results', 'member_leads', 'member_acceptances'];
    const left = async () => (await scratch.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
    const column = async (table, name) => (await scratch.query('SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, name])).rows[0].n;
    assert.equal(await left(), tables.length);
    const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_memberships-more.sql')).split('_')[0]);
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.equal(await left(), 0);
    assert.equal(await column('member_memberships', 'origin'), 0);
    assert.equal(await column('member_instalments', 'version'), 0);
    assert.equal((await scratch.query("SELECT count(*)::int AS n FROM business_permissions WHERE code='member_plans.manage'")).rows[0].n, 0);
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await left(), tables.length);
    assert.equal(await column('member_plan_types', 'visit_limit'), 1);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Gym-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  async function owner(code) {
    const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', [code]);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,restaurant_id', [restaurant.id, code, `${code}@test.invalid`, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
    return person;
  }
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('club-owner');
  await owner('club-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('club-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('club-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);

  const [made, grocery] = await createBusinesses(request, 'OWNER', ['memberships', 'grocery']);
  const [gym] = await withTools(request, [made]);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['memberships']);
  const G = (suffix) => `/businesses/${gym.id}/${suffix}`;
  const tz = (await one('SELECT timezone FROM businesses WHERE id=$1', [gym.id])).timezone;

  // --- Set-up: the desk, the staff, the trainer, the items, a second branch ---------------------------------
  const shop = (await request('GET', G('locations'))).items[0];
  const branch = await request('POST', G('locations'), { name: 'Koramangala', code: 'KRM' }, 201);
  const slabs = (await request('GET', G('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const service = (body) => request('POST', G('catalog'), { kind: 'service', unit: 'service', taxRateId: gst5.id, ...body }, 201);
  const customer = (name, phone) => request('POST', G('contacts'), { kind: 'customer', name, ...(phone ? { phone } : {}) }, 201);
  const roles = (await request('GET', G('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', G('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('club-desk@test.invalid', 'cashier');
  const seller = await staff('club-seller@test.invalid', 'cashier');
  const trainer = await staff('club-trainer@test.invalid', 'trainer');
  const viewer = await staff('club-viewer@test.invalid', 'viewer');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const approval = { approverId: ownerUser.id, pin: '2468' };
  const coach = await request('POST', G('resources'), { locationId: shop.id, name: 'Coach Ravi', roleLabel: 'Trainer' }, 201);
  const joiningFee = await service({ name: 'Joining fee', code: 'JOIN', price: '500', hsnCode: '999723' });
  const locker = await service({ name: 'Locker', code: 'LOCKER', price: '300', hsnCode: '999723' });
  const towel = await service({ name: 'Towel service', code: 'TOWEL', price: '100', hsnCode: '999723' });
  const ptSession = await service({ name: 'Personal training session', code: 'PT-1', price: '800', hsnCode: '999723' });
  const policy = 'If you cancel, the fee for the days (or sessions) you have not used is refunded pro rata. Half the joining fee comes back.';
  const newPlan = (body) => request('POST', G('member-plans/plans'), { policy, ...body }, 201);
  const sell = (body, by = request, expected = 201) => by('POST', G('member-plans/memberships'), { requestKey: key(), locationId: shop.id, payments: [{ amount: 'full', method: 'cash' }], ...body }, expected);
  const checkIn = (body, by = request, expected = 201) => by('POST', G('member-plans/check-ins'), { requestKey: key(), locationId: shop.id, ...body }, expected);
  // Time passes: a membership moved back so many days, as if sold then (its dates only).
  async function backdate(membershipId, days) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE member_memberships DISABLE TRIGGER member_memberships_guard');
      await db.query('UPDATE member_memberships SET start_on=start_on-$2::int,base_end_on=base_end_on-$2::int,end_on=end_on-$2::int WHERE id=$1', [membershipId, days]);
      await db.query('ALTER TABLE member_memberships ENABLE TRIGGER member_memberships_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  // A class moved in time (its guard switched off for the change).
  async function moveClass(sessionId, sql) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE member_class_sessions DISABLE TRIGGER member_class_sessions_guard');
      await db.query(`UPDATE member_class_sessions SET ${sql} WHERE id=$1`, [sessionId]);
      await db.query('ALTER TABLE member_class_sessions ENABLE TRIGGER member_class_sessions_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  const nowTime = (await one("SELECT to_char(now() AT TIME ZONE $1,'HH24:MI') AS t", [tz])).t;
  const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  let gym30, gym90, yoga, pt, coaching, week3, couple, offPeak, branchOnly;

  await t.test('plans keep visit limits, branches, hours, seats, classes, fees, notice, the late fee and the joining fee\'s share', async () => {
    gym30 = await newPlan({ name: 'Gym 30 days', kind: 'duration', durationUnit: 'days', duration: '30', item: { price: '999', taxRateId: gst5.id, hsnCode: '999723' },
      joiningSkuId: joiningFee.id, maxFreezes: '2', maxFreezeDays: '15', graceDays: '3', transferable: true, freezeFee: '100', transferFee: '200', joiningRefundPercent: '50' });
    assert.deepEqual([gym30.freeze_fee, gym30.transfer_fee, gym30.joining_refund_percent, gym30.seats, gym30.class_names], ['100.00', '200.00', 50, 1, null]);
    gym90 = await newPlan({ name: 'Gym 90 days', kind: 'duration', durationUnit: 'days', duration: '90', item: { price: '2700', taxRateId: gst5.id, hsnCode: '999723' },
      maxFreezes: '1', maxFreezeDays: '10', freezeNoticeDays: '3' });
    yoga = await newPlan({ name: 'Yoga 10 classes', kind: 'sessions', sessions: '10', classNames: ['Yoga', 'Spin', 'HIIT'], item: { price: '2000', taxRateId: gst5.id, hsnCode: '999723' } });
    pt = await newPlan({ name: 'Personal training 8', kind: 'both', durationUnit: 'days', duration: '60', sessions: '8', personalTraining: true,
      item: { price: '6400', taxRateId: gst5.id, hsnCode: '999723' } });
    week3 = await newPlan({ name: 'Three days a week', kind: 'duration', durationUnit: 'days', duration: '30', visitLimit: '3', visitPeriod: 'week',
      item: { price: '1500', taxRateId: gst5.id, hsnCode: '999723' } });
    couple = await newPlan({ name: 'Couple monthly', kind: 'duration', durationUnit: 'days', duration: '30', seats: '2', classNames: ['Zumba'], item: { price: '1800', taxRateId: gst5.id } });
    // Hours that leave out now (the business's clock): two hours ahead in the morning, three hours back after noon.
    const t0 = minutes(nowTime);
    const away = t0 < 720 ? [t0 + 120, t0 + 180] : [t0 - 180, t0 - 120];
    offPeak = await newPlan({ name: 'Off-peak', kind: 'duration', durationUnit: 'days', duration: '30', accessFrom: hhmm(away[0]), accessTo: hhmm(away[1]),
      item: { price: '700', taxRateId: gst5.id } });
    assert.deepEqual([offPeak.access_from.slice(0, 5), offPeak.access_to.slice(0, 5)], [hhmm(away[0]), hhmm(away[1])]);
    branchOnly = await newPlan({ name: 'Koramangala only', kind: 'duration', durationUnit: 'days', duration: '30', accessLocations: [branch.id], item: { price: '800', taxRateId: gst5.id } });
    const course = await service({ name: 'NEET coaching, one year', code: 'NEET-1Y', price: '48000', taxRateId: gst18.id, hsnCode: '999293' });
    coaching = await newPlan({ name: 'NEET coaching', kind: 'duration', durationUnit: 'months', duration: '12', item: { skuId: course.id }, lateFee: '500', lateFeeAfterDays: '5' });
    // Refusals: a fee for what the plan does not allow, hours the wrong way round, a branch of no one's.
    const base = { kind: 'duration', durationUnit: 'days', duration: '30', policy, item: { price: '1', taxRateId: gst5.id } };
    assert.deepEqual(Object.values(await refused('POST', G('member-plans/plans'), { ...base, name: 'Bad fee', freezeFee: '50' })).slice(0, 1), [400]);
    assert.match((await refused('POST', G('member-plans/plans'), { ...base, name: 'Bad fee', freezeFee: '50' })).message, /not frozen takes no freeze fee/);
    assert.match((await refused('POST', G('member-plans/plans'), { ...base, name: 'Bad transfer', transferFee: '50' })).message, /not passed on takes no transfer fee/);
    assert.match((await refused('POST', G('member-plans/plans'), { ...base, name: 'Bad hours', accessFrom: '18:00', accessTo: '06:00' })).message, /end after they begin/);
    assert.equal((await refused('POST', G('member-plans/plans'), { ...base, name: 'Bad branch', accessLocations: [elsewhere.id * 1000] })).status, 404);
    // A preview discloses the late fee and the fees before the sale.
    const student = await customer('Preview Student');
    const preview = await request('POST', G('member-plans/memberships/preview'), { locationId: shop.id, planId: coaching.id, contactId: student.id });
    assert.deepEqual([preview.terms.lateFee, preview.terms.lateFeeAfterDays], ['500.00', 5]);
    // The terms are kept as sold: a later change to the plan does not reach a membership sold before it.
    const m = await sell({ planId: gym30.id, member: { name: 'Terms Kept' }, joiningFee: false });
    await request('PUT', G(`member-plans/plans/${gym30.id}`), { name: 'Gym 30 days', kind: 'duration', durationUnit: 'days', duration: '30', joiningSkuId: joiningFee.id, policy,
      maxFreezes: '2', maxFreezeDays: '15', graceDays: '3', transferable: true, freezeFee: '150', transferFee: '200', joiningRefundPercent: '50' });
    assert.equal((await request('GET', G(`member-plans/memberships/${m.id}`))).freeze_fee, '100.00');
    await request('PUT', G(`member-plans/plans/${gym30.id}`), { name: 'Gym 30 days', kind: 'duration', durationUnit: 'days', duration: '30', joiningSkuId: joiningFee.id, policy,
      maxFreezes: '2', maxFreezeDays: '15', graceDays: '3', transferable: true, freezeFee: '100', transferFee: '200', joiningRefundPercent: '50' });
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='member_plan.updated' AND details ? 'freezeFee'", [gym.id]));
  });

  let asha, ravi, meena, coachRows;
  await t.test('classes: a timetable, the waitlist promoted, two asking for the last place at once, penalties, attendance at check-in', async () => {
    const room = await request('POST', G('member-plans/rooms'), { locationId: shop.id, name: 'Studio A', capacity: '20' }, 201);
    assert.equal((await refused('POST', G('member-plans/rooms'), { locationId: shop.id, name: 'Studio B', capacity: '5' }, trainer.token)).status, 403);
    const tomorrow = addDays(today, 1);
    const isoDay = (day) => { const d = new Date(`${day}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
    const slot = await request('POST', G('member-plans/class-slots'), { roomId: room.id, className: 'Yoga', weekday: String(isoDay(tomorrow)), startsAt: '07:00', minutes: '60',
      trainerId: coach.id, capacity: '1', bookHours: '168', cancelHours: '2', waitlistSize: '1' }, 201);
    assert.equal((await refused('POST', G('member-plans/class-slots'), { roomId: room.id, className: 'Big', weekday: '1', startsAt: '07:00', minutes: '60', capacity: '30' })).status, 400);
    const week = await request('GET', G(`member-plans/classes?from=${today}&days=7`));
    const yogaClass = week.sessions.find((s) => s.slot_id === slot.id && s.day === tomorrow);
    assert.deepEqual([yogaClass.time, yogaClass.capacity, yogaClass.held, yogaClass.open, yogaClass.trainer_name], ['07:00', 1, 0, true, 'Coach Ravi']);
    // Reading again makes nothing twice.
    await request('GET', G(`member-plans/classes?from=${today}&days=7`));
    assert.equal((await one('SELECT count(*)::int AS n FROM member_class_sessions WHERE slot_id=$1 AND day=$2', [slot.id, tomorrow])).n, 1);
    const a = await sell({ planId: yoga.id, member: { name: 'Asha Rao', phone: '9876500101' } });
    const r = await sell({ planId: yoga.id, member: { name: 'Ravi Teja', phone: '9876500102' } });
    const mm = await sell({ planId: gym30.id, member: { name: 'Meena Iyer', phone: '9876500103' }, joiningFee: false });
    asha = { id: a.contact_id, membership: a }; ravi = { id: r.contact_id, membership: r }; meena = { id: mm.contact_id, membership: mm };
    // Two ask for the last place at once: one is in, the other on the waitlist; a third finds both full.
    const [first, second] = await Promise.all([asha, ravi].map((x) => desk.call('POST', G(`member-plans/classes/${yogaClass.id}/bookings`), { requestKey: key(), contactId: x.id }, 201)));
    assert.deepEqual([first.booking.status, second.booking.status].sort(), ['booked', 'waitlisted']);
    const full = await refused('POST', G(`member-plans/classes/${yogaClass.id}/bookings`), { requestKey: key(), contactId: meena.id }, desk.token);
    assert.deepEqual([full.status, full.data?.reason], [409, 'class_full']);
    // A plan that does not book the class; a booking asked again is the same booking.
    const pair = await sell({ planId: couple.id, member: { name: 'Couple Booker' } });
    const notMine = await refused('POST', G(`member-plans/classes/${yogaClass.id}/bookings`), { requestKey: key(), contactId: pair.contact_id });
    assert.deepEqual([notMine.status, notMine.data?.reason, /does not book Yoga/.test(notMine.message)], [409, 'not_eligible', true]);
    const again = { requestKey: key(), contactId: asha.id };
    const booked = first.booking.status === 'booked' ? asha : ravi, waiting = booked === asha ? ravi : asha;
    const list = await request('GET', G(`member-plans/classes/${yogaClass.id}`));
    const bookedRow = list.bookings.find((b) => b.contact_id === booked.id), waitingRow = list.bookings.find((b) => b.contact_id === waiting.id);
    assert.equal((await refused('POST', G(`member-plans/classes/${yogaClass.id}/bookings`), again)).status, 409, 'booked once');
    // The booked one cancels before the cut-off: free, and the first on the waitlist is promoted.
    const afterCancel = await desk.call('POST', G(`member-plans/class-bookings/${bookedRow.id}/cancel`), {});
    assert.deepEqual([afterCancel.late, afterCancel.promoted], [false, waiting === asha ? 'Asha Rao' : 'Ravi Teja']);
    assert.equal(afterCancel.bookings.find((b) => b.id === waitingRow.id).status, 'promoted');
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='member_class.promoted' AND entity_id=$2", [gym.id, waitingRow.id]));
    // Past the cut-off a cancel is late: the shop's penalty takes a session off the pack.
    await request('PUT', G('member-plans/settings'), { lateCancelPenalty: 'session' });
    await moveClass(yogaClass.id, "cancel_until=now()-interval '1 minute'");
    const before = Number((await one('SELECT sessions_used FROM member_memberships WHERE id=$1', [waiting.membership.id])).sessions_used);
    const late = await desk.call('POST', G(`member-plans/class-bookings/${waitingRow.id}/cancel`), {});
    assert.deepEqual([late.late, late.penalty], [true, 'session']);
    assert.equal(Number((await one('SELECT sessions_used FROM member_memberships WHERE id=$1', [waiting.membership.id])).sessions_used), before + 1);
    // A booking is kept as it was marked.
    await assert.rejects(pool.query("UPDATE member_class_bookings SET status='booked' WHERE id=$1", [waitingRow.id]), /does not become booked/);
    await assert.rejects(pool.query('DELETE FROM member_class_bookings WHERE id=$1', [waitingRow.id]), /never deleted/);
    // A class today, begun: attended takes a pack's session; a no-show takes the shop's fee.
    const hiit = await request('POST', G('member-plans/class-slots'), { roomId: room.id, className: 'HIIT', weekday: String(isoDay(tomorrow)), startsAt: '18:00', minutes: '45',
      trainerId: coach.id, capacity: '5' }, 201);
    const hiitClass = (await request('GET', G(`member-plans/classes?from=${tomorrow}&days=1`))).sessions.find((s) => s.slot_id === hiit.id);
    await desk.call('POST', G(`member-plans/classes/${hiitClass.id}/bookings`), { requestKey: key(), contactId: asha.id }, 201);
    await desk.call('POST', G(`member-plans/classes/${hiitClass.id}/bookings`), { requestKey: key(), contactId: meena.id }, 201);
    const hiitList = await request('GET', G(`member-plans/classes/${hiitClass.id}`));
    const ashaHiit = hiitList.bookings.find((b) => b.contact_id === asha.id), meenaHiit = hiitList.bookings.find((b) => b.contact_id === meena.id);
    assert.equal((await refused('POST', G(`member-plans/class-bookings/${meenaHiit.id}/attendance`), { status: 'no_show' }, trainer.token)).status, 409, 'not on its day yet');
    await moveClass(hiitClass.id, `day=$2::date,starts_at=now()-interval '10 minutes',ends_at=now()+interval '35 minutes',book_from=now()-interval '7 days',cancel_until=now()-interval '2 hours'`
      .replace('$2::date', `'${today}'::date`));
    await request('PUT', G('member-plans/settings'), { noShowPenalty: 'fee', penaltyFee: '150' });
    const used = Number((await one('SELECT sessions_used FROM member_memberships WHERE id=$1', [asha.membership.id])).sessions_used);
    await trainer.call('POST', G(`member-plans/class-bookings/${ashaHiit.id}/attendance`), { status: 'attended' });
    assert.equal(Number((await one('SELECT sessions_used FROM member_memberships WHERE id=$1', [asha.membership.id])).sessions_used), used + 1, 'a class attended takes a session');
    const noShow = await trainer.call('POST', G(`member-plans/class-bookings/${meenaHiit.id}/attendance`), { status: 'no_show' });
    assert.equal(noShow.penalty, 'fee');
    const fee = await one("SELECT f.amount,d.contact_id,l.label FROM member_fees f JOIN business_documents d ON d.id=f.document_id JOIN business_document_lines l ON l.document_id=d.id WHERE f.kind='no_show' AND f.booking_id=$1", [meenaHiit.id]);
    assert.deepEqual([fee.amount, Number(fee.contact_id), /^No-show fee · HIIT/.test(fee.label)], ['157.50', Number(meena.id), true]);
    // Marked again: the same, no second fee.
    await trainer.call('POST', G(`member-plans/class-bookings/${meenaHiit.id}/attendance`), { status: 'no_show' });
    assert.equal((await one("SELECT count(*)::int AS n FROM member_fees WHERE kind='no_show'")).n, 1);
    // Attendance at check-in: a class starting within the hour is attended, and takes the pack's session for the day.
    const spin = await request('POST', G('member-plans/class-slots'), { roomId: room.id, className: 'Spin', weekday: String(isoDay(tomorrow)), startsAt: '19:00', minutes: '45', capacity: '5' }, 201);
    const spinClass = (await request('GET', G(`member-plans/classes?from=${tomorrow}&days=1`))).sessions.find((s) => s.slot_id === spin.id);
    await desk.call('POST', G(`member-plans/classes/${spinClass.id}/bookings`), { requestKey: key(), contactId: asha.id }, 201);
    await moveClass(spinClass.id, `day='${today}'::date,starts_at=now()+interval '30 minutes',ends_at=now()+interval '75 minutes',book_from=now()-interval '7 days',cancel_until=now()`);
    const usedBefore = Number((await one('SELECT sessions_used FROM member_memberships WHERE id=$1', [asha.membership.id])).sessions_used);
    const atDesk = await checkIn({ contactId: asha.id, membershipId: asha.membership.id }, desk.call);
    assert.deepEqual([atDesk.allowed, atDesk.session_used, atDesk.classes.map((x) => x.className)], [true, false, ['Spin']]);
    assert.equal(Number((await one('SELECT sessions_used FROM member_memberships WHERE id=$1', [asha.membership.id])).sessions_used), usedBefore + 1, 'the class took the session, not the check-in');
    // A class called off cancels its bookings without a penalty.
    const zumba = await request('POST', G('member-plans/class-slots'), { roomId: room.id, className: 'Zumba', weekday: String(isoDay(tomorrow)), startsAt: '08:00', minutes: '45', capacity: '5' }, 201);
    const zumbaClass = (await request('GET', G(`member-plans/classes?from=${tomorrow}&days=1`))).sessions.find((s) => s.slot_id === zumba.id);
    await desk.call('POST', G(`member-plans/classes/${zumbaClass.id}/bookings`), { requestKey: key(), contactId: pair.contact_id }, 201);
    assert.equal((await refused('POST', G(`member-plans/classes/${zumbaClass.id}/call-off`), { reason: 'Instructor unwell' }, trainer.token)).status, 403);
    const off = await request('POST', G(`member-plans/classes/${zumbaClass.id}/call-off`), { reason: 'Instructor unwell' });
    assert.deepEqual([Boolean(off.cancelled_at), off.bookings.map((b) => b.status)], [true, ['cancelled']]);
    coachRows = { yogaClass, hiitClass };
  });

  await t.test('trainers\' pay and sales commission to the paisa, paid once through the expense book', async () => {
    const month = today.slice(0, 7);
    // The coach: 10,000 a month, 300 a class, 500 a personal-training session, 10% of PT sales, 5% of other plans.
    await request('POST', G('member-plans/pay/rules'), { trainerId: coach.id, fromMonth: month, fixedMonthly: '10000', perClass: '300', perPtSession: '500',
      ptSalesPercent: '10', planSalesPercent: '5' }, 201);
    // The seller: 1% of PT sales and 2% of other plans they sold.
    await request('POST', G('member-plans/pay/rules'), { userId: seller.id, fromMonth: month, ptSalesPercent: '1', planSalesPercent: '2' }, 201);
    assert.equal((await refused('GET', G('member-plans/pay'), undefined, desk.token)).status, 403);
    assert.equal((await refused('GET', G('member-plans/pay'), undefined, trainer.token)).status, 403);
    // A PT plan and a gym plan sold by the seller for the coach; a PT session done today.
    const pupil = await customer('Pupil Prakash', '9876500104');
    await sell({ planId: pt.id, contactId: pupil.id, soldBy: seller.id, trainerId: coach.id });
    await sell({ planId: gym30.id, contactId: pupil.id, soldBy: seller.id, trainerId: coach.id, joiningFee: false });
    const startsAt = new Date(Date.now() - 3600000).toISOString(), endsAt = new Date(Date.now() - 600000).toISOString();
    const appointment = await request('POST', G('appointments'), { resourceId: coach.id, contactId: pupil.id, skuId: ptSession.id, startsAt, endsAt }, 201);
    await request('PATCH', G(`appointments/${appointment.id}`), { status: 'completed' });
    const report = await request('GET', G(`member-plans/pay?month=${month}`));
    const coachRow = report.rows.find((r) => r.person.kind === 'trainer' && r.person.id === coach.id);
    // One class taken with someone attending (HIIT today), one PT session, 6,400.00 of PT sales and 999.00 of other plans:
    // 10,000 + 300 + 500 + 640.00 + 49.95 = 11,489.95.
    assert.deepEqual([coachRow.figures.classes, coachRow.figures.ptSessions, coachRow.figures.ptSales, coachRow.figures.planSales], [1, 1, '6400.00', '999.00']);
    assert.deepEqual(coachRow.parts, { fixed: '10000.00', classes: '300.00', ptSessions: '500.00', ptSales: '640.00', planSales: '49.95' });
    assert.equal(coachRow.amount, '11489.95');
    const sellerRow = report.rows.find((r) => r.person.kind === 'staff' && r.person.id === seller.id);
    assert.deepEqual([sellerRow.figures.ptSales, sellerRow.figures.planSales, sellerRow.amount], ['6400.00', '999.00', '83.98']);
    // Paid through the expense book, once a month per person; asked again, the same payout.
    const body = { requestKey: key(), month, trainerId: coach.id, method: 'bank', reference: 'NEFT 1', locationId: shop.id };
    const paid = await request('POST', G('member-plans/pay/payouts'), body, 201);
    assert.equal(paid.paid.amount, '11489.95');
    assert.equal((await request('POST', G('member-plans/pay/payouts'), body, 201)).payoutId, paid.payoutId);
    const twice = await refused('POST', G('member-plans/pay/payouts'), { ...body, requestKey: key() });
    assert.deepEqual([twice.status, /paid already/.test(twice.message)], [409, true]);
    assert.equal((await refused('POST', G('member-plans/pay/payouts'), { ...body, reference: 'Other' })).status, 409, 'same key, other data');
    const expense = await one('SELECT e.amount,e.category,e.method FROM member_payouts p JOIN business_expenses e ON e.id=p.expense_id WHERE p.id=$1', [paid.payoutId]);
    assert.deepEqual([expense.amount, expense.category, expense.method], ['11489.95', 'wages', 'bank']);
    await assert.rejects(pool.query('UPDATE member_pay_rules SET per_class=1'), /kept as it was written/);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='member_pay.paid' AND entity_id=$2", [gym.id, paid.payoutId]));
    // A month to come is not paid.
    const next = addDays(`${month}-01`, 40).slice(0, 7);
    assert.equal((await refused('POST', G('member-plans/pay/payouts'), { ...body, requestKey: key(), month: next, userId: seller.id, trainerId: undefined })).status, 400);
  });

  await t.test('visits a week counted on the business\'s calendar, hours and branches refused with the reason', async () => {
    const vikram = await sell({ planId: week3.id, member: { name: 'Vikram Singh', phone: '9876500105' } });
    await backdate(vikram.id, 14);
    // Three visits last week (Saturday and Sunday, the business's days): they do not count this week.
    const monday = (await one("SELECT date_trunc('week', (now() AT TIME ZONE $1)::date)::date::text AS d", [tz])).d;
    for (const [day, time] of [[addDays(monday, -2), '10:00'], [addDays(monday, -1), '09:00'], [addDays(monday, -1), '18:00']]) {
      await pool.query(`INSERT INTO member_checkins(business_id,location_id,contact_id,membership_id,day,found_by,allowed,session_used,request_key,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,'search',TRUE,FALSE,$6,$7,($5::date+$8::time) AT TIME ZONE $9)`, [gym.id, shop.id, vikram.contact_id, vikram.id, day, key(), ownerUser.id, time, tz]);
    }
    // A fourth last week is refused by the database itself.
    await assert.rejects(pool.query(`INSERT INTO member_checkins(business_id,location_id,contact_id,membership_id,day,found_by,allowed,session_used,request_key,created_by,created_at)
      VALUES($1,$2,$3,$4,$5,'search',TRUE,FALSE,$6,$7,($5::date+'20:00'::time) AT TIME ZONE $8)`, [gym.id, shop.id, vikram.contact_id, vikram.id, addDays(monday, -1), key(), ownerUser.id, tz]),
    /allows 3 visits a week: all are used/);
    for (let n = 0; n < 3; n += 1) assert.equal((await checkIn({ contactId: vikram.contact_id }, desk.call)).allowed, true);
    const fourth = await checkIn({ contactId: vikram.contact_id }, desk.call);
    assert.deepEqual([fourth.allowed, fourth.reason, /allows 3 visits a week: all are used/.test(fourth.words)], [false, 'visit_limit', true]);
    // Outside the plan's hours.
    const late = await sell({ planId: offPeak.id, member: { name: 'Late Comer' } });
    const out = await checkIn({ contactId: late.contact_id }, desk.call);
    assert.deepEqual([out.allowed, out.reason, /lets the member in from \d\d:\d\d to \d\d:\d\d/.test(out.words)], [false, 'time_of_day', true]);
    // At another branch: refused at the main desk, let in at its own.
    const branchMember = await sell({ planId: branchOnly.id, member: { name: 'Branch Member' } });
    const elsewhereDesk = await checkIn({ contactId: branchMember.contact_id }, desk.call);
    assert.deepEqual([elsewhereDesk.allowed, elsewhereDesk.reason, /at Koramangala only/.test(elsewhereDesk.words)], [false, 'branch', true]);
    assert.equal((await checkIn({ contactId: branchMember.contact_id, locationId: branch.id })).allowed, true);
  });

  await t.test('seats: each member of a shared membership checks in on their own, within its seats', async () => {
    const anil = await customer('Anil Kumar', '9876500106');
    const shared = await sell({ planId: couple.id, contactId: anil.id, seatMembers: [{ contactId: anil.id }, { name: 'Sunita Anil', phone: '9876500107' }] });
    assert.deepEqual([shared.seats, shared.seat_members.map((s) => [s.name, Boolean(s.member_code)])], [2, [['Anil Kumar', true], ['Sunita Anil', true]]]);
    const sunita = shared.seat_members.find((s) => s.name === 'Sunita Anil');
    assert.equal((await checkIn({ contactId: anil.id })).allowed, true);
    const her = await checkIn({ code: sunita.member_code });
    assert.deepEqual([her.allowed, her.membership_no], [true, shared.membership_no]);
    const kavya = await customer('Kavya Anil');
    const fullSeats = await refused('POST', G(`member-plans/memberships/${shared.id}/seats`), { contactId: kavya.id });
    assert.deepEqual([fullSeats.status, /all are taken/.test(fullSeats.message)], [409, true]);
    const freed = await request('POST', G(`member-plans/memberships/${shared.id}/seats/${sunita.id}/remove`), {});
    assert.equal(freed.seat_members.find((s) => s.id === sunita.id).removed_at !== null, true);
    await request('POST', G(`member-plans/memberships/${shared.id}/seats`), { contactId: kavya.id }, 201);
    assert.equal((await checkIn({ contactId: sunita.contact_id })).reason, 'no_membership');
    assert.equal((await checkIn({ contactId: kavya.id })).allowed, true);
    // A shared membership is not passed on; a single plan has no seats.
    assert.equal((await refused('POST', G(`member-plans/memberships/${shared.id}/transfer`), { requestKey: key(), toContactId: kavya.id })).status, 409);
    assert.equal((await refused('POST', G(`member-plans/memberships/${meena.membership.id}/seats`), { contactId: kavya.id })).status, 409);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='membership.seat_added' AND entity_id=$2", [gym.id, shared.id]));
  });

  await t.test('add-ons end with the membership; a locker is held by one running membership', async () => {
    const lalit = await sell({ planId: gym30.id, member: { name: 'Lalit Mohan' }, joiningFee: false, addons: [{ skuId: locker.id, kind: 'locker', lockerNo: 'l-12' }] });
    assert.deepEqual(lalit.addons.map((x) => [x.kind, x.locker_no, x.label, x.ends_on]), [['locker', 'L-12', 'Locker · locker L-12', lalit.end_on]]);
    assert.deepEqual((await request('GET', G(`documents/${lalit.document_id}`))).lines.map((l) => l.label), ['Gym 30 days', 'Locker']);
    // Frozen: the membership's last day moves on, and its add-on with it.
    const frozen = await request('POST', G(`member-plans/memberships/${lalit.id}/freeze`), { requestKey: key(), days: '5', payments: [{ amount: 'full', method: 'cash' }] }, 201);
    assert.equal(frozen.addons[0].ends_on, addDays(lalit.end_on, 5));
    // Locker L-12 is held while Lalit's membership runs.
    const held = await refused('POST', G(`member-plans/memberships/${meena.membership.id}/addons`), { requestKey: key(), skuId: locker.id, kind: 'locker', lockerNo: 'L-12' });
    assert.deepEqual([held.status, /Locker L-12 is held by membership/.test(held.message)], [409, true]);
    const towelBody = { requestKey: key(), skuId: towel.id, kind: 'towel', payments: [{ amount: 'full', method: 'upi' }] };
    const withTowel = await desk.call('POST', G(`member-plans/memberships/${meena.membership.id}/addons`), towelBody, 201);
    assert.equal((await desk.call('POST', G(`member-plans/memberships/${meena.membership.id}/addons`), towelBody, 201)).addons.length, withTowel.addons.length, 'asked again: one add-on');
    assert.equal((await refused('POST', G(`member-plans/memberships/${meena.membership.id}/addons`), { requestKey: key(), skuId: gym30.price_sku_id, kind: 'other' })).status, 400);
    // Lalit cancels: the locker is free for another.
    await request('POST', G(`member-plans/memberships/${lalit.id}/cancel`), { requestKey: key(), reason: 'Moving away', credit: '0' });
    await request('POST', G(`member-plans/memberships/${meena.membership.id}/addons`), { requestKey: key(), skuId: locker.id, kind: 'locker', lockerNo: 'L-12' }, 201);
  });

  await t.test('fees and notice: a freeze fee and a transfer fee billed as services at the plan\'s slab, a freeze\'s notice', async () => {
    const sunil = await sell({ planId: gym30.id, member: { name: 'Sunil Rao' }, joiningFee: false });
    const frozen = await desk.call('POST', G(`member-plans/memberships/${sunil.id}/freeze`), { requestKey: key(), startsOn: addDays(today, 1), days: '4' }, 201);
    const freezeFee = frozen.fees.find((f) => f.kind === 'freeze');
    assert.equal(freezeFee.amount, '105.00', '100.00 + GST 5%');
    const feeBill = await request('GET', G(`documents/${freezeFee.document_id}`));
    assert.deepEqual([feeBill.lines[0].label.startsWith('Freeze fee ·'), feeBill.lines[0].net, feeBill.lines[0].tax, feeBill.lines[0].hsn_code], [true, '100.00', '5.00', '999723']);
    // A plan's item stays off any other bill.
    assert.equal((await refused('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, lines: [{ skuId: gym30.price_sku_id, quantity: 1 }] })).status, 409);
    // Notice: Gym 90 days needs three days' notice for a freeze.
    const notice = await sell({ planId: gym90.id, member: { name: 'Notice Taker' } });
    const early = await refused('POST', G(`member-plans/memberships/${notice.id}/freeze`), { requestKey: key(), days: '2' });
    assert.deepEqual([early.status, early.data?.reason], [400, 'notice']);
    await request('POST', G(`member-plans/memberships/${notice.id}/freeze`), { requestKey: key(), startsOn: addDays(today, 3), days: '2' }, 201);
    // A transfer fee, billed to the member passing it on.
    await request('POST', G(`member-plans/memberships/${sunil.id}/unfreeze`), {});
    await request('POST', G(`documents/${freezeFee.document_id}/payments`), { requestKey: key(), amount: '105.00', method: 'cash' }, 201);
    const moved = await desk.call('POST', G(`member-plans/memberships/${sunil.id}/transfer`), { requestKey: key(), toMember: { name: 'Sunil Brother' } }, 201);
    const transferFee = await one("SELECT f.amount,d.contact_id FROM member_fees f JOIN business_documents d ON d.id=f.document_id WHERE f.kind='transfer' AND f.membership_id=$1", [sunil.id]);
    assert.deepEqual([transferFee.amount, Number(transferFee.contact_id), moved.member_name], ['210.00', Number(sunil.contact_id), 'Sunil Brother']);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='membership.fee_billed' AND entity_id=$2", [gym.id, sunil.id]));
  });

  await t.test('a membership followed by its renewal is frozen, and the renewal moves on by the days frozen', async () => {
    const neha = await sell({ planId: gym30.id, member: { name: 'Neha Gupta' }, joiningFee: false });
    const renewal = await sell({ planId: gym30.id, contactId: neha.contact_id, renewalOf: neha.id });
    assert.equal(renewal.start_on, addDays(neha.end_on, 1));
    await request('POST', G(`member-plans/memberships/${neha.id}/freeze`), { requestKey: key(), startsOn: addDays(today, 2), days: '5', payments: [{ amount: 'full', method: 'cash' }] }, 201);
    const moved = await request('GET', G(`member-plans/memberships/${renewal.id}`));
    assert.deepEqual([moved.start_on, moved.end_on, moved.moved_days, moved.events.at(-1).kind], [addDays(renewal.start_on, 5), addDays(renewal.end_on, 5), 5, 'moved']);
    // Called off before it begins: the renewal moves back.
    await request('POST', G(`member-plans/memberships/${neha.id}/unfreeze`), {});
    const back = await request('GET', G(`member-plans/memberships/${renewal.id}`));
    assert.deepEqual([back.start_on, back.end_on, back.moved_days], [renewal.start_on, renewal.end_on, 0]);
    // The database moves a renewal only before it begins, by the days moved.
    await assert.rejects(pool.query('UPDATE member_memberships SET start_on=start_on+1 WHERE id=$1', [renewal.id]), /keeps its member, plan, terms, start and bill/);
  });

  await t.test('a move to a cheaper plan: the unused value pays the new bill, the rest refunded by a manager or kept as credit, to the paisa', async () => {
    const kiran = await sell({ planId: gym90.id, member: { name: 'Kiran Kumar' } });
    await backdate(kiran.id, 10);
    // 10 of 90 days used (to yesterday), 80 left: 2,835.00 × 80 / 90 = 2,520.00; the new bill is 1,048.95; 1,471.05 is left over.
    const preview = await request('POST', G(`member-plans/memberships/${kiran.id}/upgrade/preview`), { planId: gym30.id });
    assert.deepEqual([preview.credit, preview.creditApplied, preview.newTotal, preview.due, preview.cheaper, preview.leftOver, preview.difference],
      ['2520.00', '1048.95', '1048.95', '0.00', true, '1471.05', 'credit']);
    const body = { requestKey: key(), planId: gym30.id, joiningFee: false, difference: 'refund', refund: { method: 'cash' } };
    const noPin = await refused('POST', G(`member-plans/memberships/${kiran.id}/upgrade`), body);
    assert.deepEqual([noPin.status, noPin.data?.reason], [400, 'approval_needed']);
    const next = await request('POST', G(`member-plans/memberships/${kiran.id}/upgrade`), { ...body, approval }, 201);
    assert.deepEqual([next.plan_name, next.bill.due, next.start_on], ['Gym 30 days', '0.00', today]);
    const oldBill = await request('GET', G(`documents/${kiran.document_id}`));
    assert.deepEqual(oldBill.refunds.map((f) => [f.amount, f.method]).sort(), [['1048.95', 'credit_note'], ['1471.05', 'cash']]);
    assert.equal(paise(oldBill.total) - paise(oldBill.returns[0].total) - paise(oldBill.payments[0].amount) + 104895 + 147105, 0, 'nothing owed either way');
    const old = await request('GET', G(`member-plans/memberships/${kiran.id}`));
    assert.deepEqual([old.status, old.credit, old.refunds_due.map((r) => [r.kind, r.amount, Boolean(r.refund_id)])], ['upgraded', '2520.00', [['downgrade', '1471.05', true]]]);
    assert.equal((await request('POST', G(`member-plans/memberships/${kiran.id}/upgrade`), { ...body, approval }, 201)).id, next.id, 'asked again: the same move');
    // Kept as credit: what is left over stays on the credit note, with the member.
    const gopal = await sell({ planId: gym90.id, member: { name: 'Gopal Das' } });
    await backdate(gopal.id, 10);
    await request('POST', G(`member-plans/memberships/${gopal.id}/upgrade`), { requestKey: key(), planId: gym30.id, joiningFee: false, difference: 'credit' }, 201);
    assert.equal((await request('GET', G(`member-plans/memberships/${gopal.id}`))).bill.due, '-1471.05');
  });

  await t.test('instalments: a manager changes the schedule without changing its total; an overdue instalment takes the disclosed late fee', async () => {
    const arjun = await customer('Arjun Reddy', '9876500108');
    const four = [0, 30, 60, 90].map((d) => ({ dueOn: addDays(today, d), amount: '14160' }));
    const enrolled = await sell({ planId: coaching.id, contactId: arjun.id, instalments: four, payments: undefined });
    assert.equal(enrolled.bill.total, '56640.00');
    const three = [{ dueOn: addDays(today, 5), amount: '20000' }, { dueOn: addDays(today, 40), amount: '20000' }, { dueOn: addDays(today, 80), amount: '16640' }];
    assert.equal((await refused('PUT', G(`member-plans/memberships/${enrolled.id}/instalments`), { reason: 'Parent asked', instalments: three }, desk.token)).status, 403);
    const wrong = await refused('PUT', G(`member-plans/memberships/${enrolled.id}/instalments`), { reason: 'Parent asked', instalments: three.slice(0, 2) });
    assert.deepEqual([wrong.status, wrong.data?.reason], [409, 'instalments_total']);
    const changed = await request('PUT', G(`member-plans/memberships/${enrolled.id}/instalments`), { reason: 'Parent asked for three', instalments: three });
    assert.deepEqual([changed.instalments.map((i) => [i.seq, i.version, i.due_on, i.amount]), changed.schedules.map((s) => [s.version, Boolean(s.replaced_at)])],
      [[[1, 2, three[0].dueOn, '20000.00'], [2, 2, three[1].dueOn, '20000.00'], [3, 2, three[2].dueOn, '16640.00']], [[1, true], [2, false]]]);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='membership.instalments_changed' AND entity_id=$2", [gym.id, enrolled.id]);
    assert.deepEqual([audit.details.from.length, audit.details.to.length, audit.details.reason], [4, 3, 'Parent asked for three']);
    await assert.rejects(pool.query('UPDATE member_instalments SET amount=1 WHERE membership_id=$1 AND version=2', [enrolled.id]), /kept as they were set/);
    // Not overdue yet: no late fee.
    const early = await refused('POST', G(`member-plans/memberships/${enrolled.id}/late-fee`), { requestKey: key(), seq: '1' });
    assert.deepEqual([early.status, /not overdue/.test(early.message)], [409, true]);
    // Time passes: instalment 1 is 10 days overdue (more than the plan's 5): 500.00 + GST 18% = 590.00.
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE member_instalments DISABLE TRIGGER member_instalments_append_only');
      await db.query('UPDATE member_instalments SET due_on=$2 WHERE membership_id=$1 AND version=2 AND seq=1', [enrolled.id, addDays(today, -10)]);
      await db.query('ALTER TABLE member_instalments ENABLE TRIGGER member_instalments_append_only');
      await db.query('COMMIT');
    } finally { db.release(); }
    const lateBody = { requestKey: key(), seq: '1' };
    const charged = await desk.call('POST', G(`member-plans/memberships/${enrolled.id}/late-fee`), lateBody, 201);
    assert.deepEqual(charged.fees.map((f) => [f.kind, f.amount, f.instalment_seq]), [['late', '590.00', 1]]);
    assert.deepEqual(charged.instalments[0].late_fee_billed, true);
    assert.equal((await desk.call('POST', G(`member-plans/memberships/${enrolled.id}/late-fee`), lateBody, 201)).fees.length, 1, 'asked again: one fee');
    const again = await refused('POST', G(`member-plans/memberships/${enrolled.id}/late-fee`), { requestKey: key(), seq: '1' }, desk.token);
    assert.deepEqual([again.status, /billed already/.test(again.message)], [409, true]);
    assert.equal((await refused('POST', G(`member-plans/memberships/${enrolled.id}/late-fee`), { requestKey: key(), seq: '9' })).status, 404);
  });

  await t.test('a cancellation\'s refund paid on a later day, on the bell until paid; the joining fee back by the plan\'s share', async () => {
    const meera = await sell({ planId: gym30.id, member: { name: 'Meera Nair', phone: '9876500109' } });
    // On its first day 1 of 30 days is used: 1,048.95 × 29 / 30 = 1,013.985, to the paisa 1,013.99; half the 525.00 joining fee is 262.50.
    const preview = await request('POST', G(`member-plans/memberships/${meera.id}/cancel/preview`), { joiningFee: true });
    assert.deepEqual([preview.most, preview.joiningFee, preview.joiningMost, preview.creditNote, preview.refund], ['1013.99', '262.50', '262.50', '1276.49', '1276.49']);
    assert.match((await refused('POST', G(`member-plans/memberships/${meera.id}/cancel/preview`), { joiningCredit: '300' })).message, /At most 262\.50 of the joining fee/);
    const body = { requestKey: key(), reason: 'Moving to Mysuru', joiningFee: true, refundOn: addDays(today, 3), approval };
    const cancelled = await request('POST', G(`member-plans/memberships/${meera.id}/cancel`), body);
    assert.deepEqual([cancelled.status, cancelled.refunded, cancelled.refunds_due.map((r) => [r.amount, r.due_on, r.refund_id])], ['cancelled', null, [['1276.49', addDays(today, 3), null]]]);
    const bell = await request('GET', G('notifications'));
    assert.ok(bell.items.some((n) => n.title === 'Meera Nair: 1276.49 to go back'));
    const listed = await request('GET', G('member-plans/refunds?open=true'));
    const due = listed.items.find((r) => r.membership_id === meera.id);
    assert.equal((await refused('POST', G(`member-plans/refunds/${due.id}/pay`), { method: 'cash' }, desk.token)).status, 403);
    assert.equal((await refused('POST', G(`member-plans/refunds/${due.id}/pay`), {})).data?.reason, 'refund_method');
    const paid = await request('POST', G(`member-plans/refunds/${due.id}/pay`), { method: 'upi' });
    assert.deepEqual([paid.open, Boolean(paid.refund_id)], [false, true]);
    assert.equal((await request('POST', G(`member-plans/refunds/${due.id}/pay`), { method: 'upi' })).refund_id, paid.refund_id, 'paid once');
    const bill = await request('GET', G(`documents/${meera.document_id}`));
    assert.deepEqual(bill.refunds.map((f) => [f.amount, f.method]), [['1276.49', 'upi']]);
    await assert.rejects(pool.query('UPDATE member_refunds SET amount=1 WHERE id=$1', [due.id]), /kept as it was set/);
    assert.ok(!(await request('GET', G('notifications'))).items.some((n) => n.title === 'Meera Nair: 1276.49 to go back'));
  });

  await t.test('memberships brought in from another system: no bill, never a sale, audited', async () => {
    const bills = async () => (await one('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1', [gym.id])).n;
    const before = await bills();
    const sales = async () => (await request('GET', G(`member-plans/pay?month=${today.slice(0, 7)}`))).rows.find((r) => r.person.kind === 'staff' && r.person.id === ownerUser.id)?.figures;
    const salesBefore = await sales();
    const body = { requestKey: key(), locationId: shop.id, planId: gym90.id, member: { name: 'Old Timer', phone: '9876500110' }, startOn: addDays(today, -20), endOn: addDays(today, 70),
      paidElsewhere: '2700' };
    assert.equal((await refused('POST', G('member-plans/memberships/brought-in'), { ...body, requestKey: key() }, viewer.token)).status, 403);
    const brought = await request('POST', G('member-plans/memberships/brought-in'), body, 201);
    assert.deepEqual([brought.origin, brought.paid_elsewhere, brought.document_id, brought.bill, brought.start_on, brought.end_on, brought.status, Boolean(brought.member_code)],
      ['brought_in', '2700.00', null, null, addDays(today, -20), addDays(today, 70), 'active', true]);
    assert.equal((await request('POST', G('member-plans/memberships/brought-in'), body, 201)).id, brought.id, 'asked again: the same');
    assert.equal(await bills(), before, 'no bill');
    assert.equal((await checkIn({ contactId: brought.contact_id })).allowed, true);
    assert.equal((await request('POST', G(`member-plans/memberships/${brought.id}/cancel/preview`), {})).most, '0.00');
    assert.equal((await refused('POST', G(`member-plans/memberships/${brought.id}/upgrade/preview`), { planId: gym30.id })).status, 409);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='membership.brought_in' AND entity_id=$2", [gym.id, brought.id]));
    assert.ok(!(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='membership.sold' AND entity_id=$2", [gym.id, brought.id])), 'never a sale');
    // Not counted in anyone's sales: the owner who entered it sold no more than before.
    assert.deepEqual(await sales(), salesBefore);
    // Refusals: one not begun, one already over.
    assert.equal((await refused('POST', G('member-plans/memberships/brought-in'), { ...body, requestKey: key(), startOn: addDays(today, 1) })).status, 400);
    assert.equal((await refused('POST', G('member-plans/memberships/brought-in'), { ...body, requestKey: key(), endOn: addDays(today, -1) })).status, 400);
    // A pack brought in with its sessions left.
    const pack = await request('POST', G('member-plans/memberships/brought-in'), { requestKey: key(), locationId: shop.id, planId: yoga.id, member: { name: 'Pack Holder' },
      startOn: addDays(today, -5), sessionsLeft: '4', paidElsewhere: '1000' }, 201);
    assert.deepEqual([pack.sessions_total, pack.sessions_left, pack.end_on], [4, 4, null]);
  });

  let arjunId;
  await t.test('coaching students: age, school and class, guardians with their WhatsApp consent, test results as progress', async () => {
    const arjun = (await request('GET', G('member-plans/members?q=Arjun'))).items[0];
    arjunId = arjun.contact_id;
    const born = `${Number(addDays(today, 3).slice(0, 4)) - 15}${addDays(today, 3).slice(4)}`;
    const page = await request('PUT', G(`member-plans/members/${arjunId}/profile`), { dateOfBirth: born, school: 'Kendriya Vidyalaya', className: '10' });
    assert.deepEqual([page.member.age, page.member.school, page.member.class_name], [14, 'Kendriya Vidyalaya', '10']);
    assert.equal((await refused('PUT', G(`member-plans/members/${arjunId}/profile`), { dateOfBirth: addDays(today, 1) })).status, 400);
    const father = await request('POST', G(`member-plans/members/${arjunId}/guardians`), { name: 'Ramesh Reddy', relation: 'Father', phone: '9876500111', whatsappConsent: true }, 201);
    assert.ok(father.consent_at);
    assert.equal((await refused('POST', G(`member-plans/members/${arjunId}/guardians`), { name: 'Lakshmi Reddy', relation: 'Mother', whatsappConsent: true })).status, 400);
    await request('POST', G(`member-plans/members/${arjunId}/guardians`), { name: 'Lakshmi Reddy', relation: 'Mother', phone: '9876500112' }, 201);
    await request('PUT', G(`member-plans/guardians/${father.id}`), { name: 'Ramesh Reddy', relation: 'Father', phone: '9876500111', whatsappConsent: false });
    assert.equal((await refused('POST', G(`member-plans/members/${arjunId}/guardians`), { name: 'Nobody' }, viewer.token)).status, 403);
    await request('POST', G(`member-plans/members/${arjunId}/results`), { testName: 'Unit test 1', takenOn: addDays(today, -20), marks: '72', outOf: '100' }, 201);
    await request('POST', G(`member-plans/members/${arjunId}/results`), { testName: 'Mock NEET', takenOn: addDays(today, -2), marks: '540', outOf: '720', remarks: 'Biology strong' }, 201);
    assert.equal((await refused('POST', G(`member-plans/members/${arjunId}/results`), { testName: 'Bad', takenOn: today, marks: '101', outOf: '100' })).status, 400);
    const seen = await request('GET', G(`member-plans/members/${arjunId}`));
    assert.deepEqual(seen.guardians.map((g) => [g.name, g.whatsapp_consent]), [['Ramesh Reddy', false], ['Lakshmi Reddy', false]]);
    assert.deepEqual(seen.results.map((r) => [r.test_name, r.percent]), [['Unit test 1', '72.0'], ['Mock NEET', '75.0']]);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='member_guardian.updated' AND entity_id=$2", [gym.id, father.id]));
  });

  await t.test('enquiries on a follow-up list, a trial pass that checks in with no bill, and the member it becomes', async () => {
    assert.equal((await refused('POST', G('member-plans/leads'), { locationId: shop.id, name: 'Pooja', source: 'instagram' })).status, 400);
    const lead = await desk.call('POST', G('member-plans/leads'), { locationId: shop.id, name: 'Pooja Sharma', phone: '9876500113', source: 'social', interest: 'Yoga in the morning',
      followUpOn: today }, 201);
    assert.ok((await desk.call('GET', G('member-plans/leads?due=true'))).items.some((l) => l.id === lead.id));
    const bills = (await one('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1', [gym.id])).n;
    const trialBody = { requestKey: key(), planId: gym30.id, days: '3', visits: '2' };
    const pass = await desk.call('POST', G(`member-plans/leads/${lead.id}/trial`), trialBody, 201);
    assert.deepEqual([pass.origin, pass.plan_name, pass.sessions_total, pass.end_on, pass.bill, pass.transferable], ['trial', 'Trial · Gym 30 days', 2, addDays(today, 2), null, false]);
    assert.equal((await desk.call('POST', G(`member-plans/leads/${lead.id}/trial`), trialBody, 201)).id, pass.id, 'asked again: one pass');
    assert.equal((await one('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1', [gym.id])).n, bills, 'a trial pass has no bill');
    const visit = await checkIn({ contactId: pass.contact_id }, desk.call);
    assert.deepEqual([visit.allowed, visit.session_used, visit.sessions_left], [true, true, 1]);
    assert.equal((await refused('POST', G(`member-plans/leads/${lead.id}/trial`), { requestKey: key(), planId: gym30.id, days: '3' }, desk.token)).status, 409);
    const repeat = await desk.call('POST', G('member-plans/leads'), { locationId: shop.id, name: 'Pooja Again', source: 'walk_in' }, 201);
    await pool.query('UPDATE member_leads SET contact_id=$2 WHERE id=$1', [repeat.id, pass.contact_id]);
    const second = await refused('POST', G(`member-plans/leads/${repeat.id}/trial`), { requestKey: key(), planId: gym30.id, days: '3' }, desk.token);
    assert.deepEqual([second.status, /trial pass is for someone new/.test(second.message)], [409, true]);
    // Converted: a membership sold from the enquiry, for the same person, with the joining fee of a first membership.
    const member = await sell({ planId: gym30.id, leadId: lead.id }, desk.call);
    assert.deepEqual([Number(member.contact_id), member.joining_fee], [Number(pass.contact_id), '525.00']);
    const closed = (await desk.call('GET', G('member-plans/leads?status=member'))).items.find((l) => l.id === lead.id);
    assert.equal(closed.membership_no, member.membership_no);
    assert.equal((await refused('PUT', G(`member-plans/leads/${repeat.id}`), { status: 'lost' }, desk.token)).status, 400);
    await desk.call('PUT', G(`member-plans/leads/${repeat.id}`), { status: 'lost', lostReason: 'Joined a gym near home' });
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='membership.trial_given' AND entity_id=$2", [gym.id, pass.id]));
  });

  await t.test('reminder lists: birthdays, sessions running low, grace days ending; a birthday wish needs consent to offers', async () => {
    const birthdays = await desk.call('GET', G('member-plans/birthdays'));
    const arjun = birthdays.items.find((b) => b.contact_id === arjunId);
    assert.deepEqual([arjun.days_to, arjun.turns], [3, 15]);
    await publishNotice(request, `/businesses/${gym.id}`);
    await giveConsent(desk.call, `/businesses/${gym.id}`, arjunId, ['reminders']);
    const wish = await refused('POST', G(`member-plans/memberships/${arjun.membership_id}/reminders`), { kind: 'birthday', channel: 'whatsapp' }, desk.token);
    assert.deepEqual([wish.status, wish.data?.reason], [409, 'consent_required']);
    await giveConsent(desk.call, `/businesses/${gym.id}`, arjunId, ['offers']);
    await desk.call('POST', G(`member-plans/memberships/${arjun.membership_id}/reminders`), { kind: 'birthday', channel: 'whatsapp' }, 201);
    // A pack with two sessions left is running low (Settings › Membership plans: 2 until changed).
    await pool.query('UPDATE member_memberships SET sessions_used=8 WHERE id=$1', [ravi.membership.id]);
    assert.ok((await desk.call('GET', G('member-plans/sessions-low'))).items.some((m) => m.id === ravi.membership.id && m.sessions_left === 2));
    // In grace days: ended two days ago with three grace days, so tomorrow is the last.
    const graceful = await sell({ planId: gym30.id, member: { name: 'Grace Member' }, joiningFee: false });
    await backdate(graceful.id, 31);
    const grace = (await desk.call('GET', G('member-plans/grace-end'))).items.find((m) => m.id === graceful.id);
    assert.deepEqual([grace.days_left, grace.grace_until, grace.grace_days_left], [-2, addDays(today, 1), 1]);
  });

  await t.test('the member\'s signature accepting the refund policy, kept privately with its version', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex');
    const upload = async (file, name, token = ownerToken) => {
      const form = new FormData();
      form.append('membershipId', String(meena.membership.id));
      form.append('file', new Blob([file]), name);
      const response = await fetch(`${base}/businesses/${gym.id}/member-plans/acceptances`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const signed = await upload(png, 'signature.png', desk.token);
    assert.equal(signed.status, 201);
    assert.deepEqual([signed.body.data.policy_version, signed.body.data.signed_by_name], [1, 'Meena Iyer']);
    assert.equal((await upload(Buffer.from('not a picture at all'), 'signature.png')).status, 400);
    const picture = await fetch(`${base}/businesses/${gym.id}/member-plans/acceptances/${signed.body.data.id}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.deepEqual([picture.status, picture.headers.get('content-type'), picture.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
    assert.equal((await request('GET', G(`member-plans/memberships/${meena.membership.id}`))).acceptances.length, 1);
    await assert.rejects(pool.query('DELETE FROM member_acceptances'), /kept as it was signed/);
  });

  await t.test('other types and other owners are kept out', async () => {
    assert.equal((await refused('GET', `/businesses/${grocery.id}/member-plans/classes`)).status, 403);
    assert.equal((await refused('GET', `/businesses/${grocery.id}/member-plans/leads`)).status, 403);
    assert.equal((await call('GET', G('member-plans/classes'), undefined, await login('club-other@test.invalid'))).status, 404);
    assert.equal((await other('GET', `/businesses/${elsewhere.id}/member-plans/leads`)).total, 0);
    assert.equal((await refused('POST', G('member-plans/leads'), { locationId: shop.id, name: 'X', source: 'walk_in' }, viewer.token)).status, 403);
    assert.equal(String(coachRows.yogaClass.day), addDays(today, 1));
  });
});
