const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { daysFrom, weekdayOf, momentAt, zoneWithHour } = require('./helpers/dates');

// Salon & spa and weight shops, day to day: moving a booking
// (never a late-cancel charge), stylist hours / weekly off / leave, arrival,
// walk-ins, WhatsApp messages recorded, the client card, commission on
// package sessions and plan sales, flat commission, payouts, tips and mixed
// payments; the rate board, stock for today, the end-of-day weigh-up,
// wastage in one go, cutting to order, repacking into pouches, orders for
// pickup, yield by template and today's figures. Own throwaway database.
test('salon & weight shops, day to day', { timeout: 300000 }, async (t) => {
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
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `SwPro-${crypto.randomBytes(8).toString('hex')}`;
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
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const ownerUser = await owner('swpro-owner');
  await owner('swpro-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const request = as(await login('swpro-owner@test.invalid'));
  const other = as(await login('swpro-other@test.invalid'));
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);

  const [salon, meat, dry] = await withTools(request, await createBusinesses(request, 'OWNER', ['salon', 'meat', 'weight_retail']));
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const S = (suffix) => `/businesses/${salon.id}/${suffix}`;
  const M = (suffix) => `/businesses/${meat.id}/${suffix}`;
  const D = (suffix) => `/businesses/${dry.id}/${suffix}`;

  // Staff with the cashier role in the salon.
  const roles = (await request('GET', S('roles'))).items;
  const cashierUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, 'Salon cashier', 'swpro-cashier@test.invalid', hash]);
  await request('POST', S('members'), { userId: cashierUser.id, roleId: roles.find((r) => r.template_code === 'cashier').id }, 201);
  const cashier = as(await login('swpro-cashier@test.invalid'));

  // --- Salon set-up -------------------------------------------------------------------------
  const loc = (await request('GET', S('locations'))).items[0];
  const slab = (await request('GET', S('tax-rates'))).items.find((r) => Number(r.rate) === 18);
  const service = (name, code, price) => request('POST', S('catalog'), { name, code, kind: 'service', unit: 'service', tracking: 'none', price, taxRateId: slab.id }, 201);
  const cut = await service('Haircut', 'CUT', '400');
  const spa = await service('Hair spa', 'SPA', '1000');
  const facial = await service('Facial', 'FAC', '1500');
  const priya = await request('POST', S('resources'), { name: 'Priya', locationId: loc.id }, 201);
  const arjun = await request('POST', S('resources'), { name: 'Arjun', locationId: loc.id }, 201);
  const room = await request('POST', S('resources'), { name: 'Spa room', locationId: loc.id }, 201);
  await request('PUT', S(`salon/staff/${room.id}`), { kind: 'room', skuIds: [] });
  await request('PUT', S(`salon/services/${cut.id}`), { durationMinutes: 45, bufferMinutes: 15 });
  await request('PUT', S(`salon/services/${facial.id}`), { durationMinutes: 60, needsRoom: true });
  const ananya = await request('POST', S('contacts'), { kind: 'customer', name: 'Ananya', phone: '9820011111' }, 201);
  const ravi = await request('POST', S('contacts'), { kind: 'customer', name: 'Ravi' }, 201);
  await request('PUT', S('salon/settings'), { depositPercent: '25', freeCancelHours: 4, lateCancelFeePercent: '50', noShowFeePercent: '100', opensAt: '09:00', closesAt: '21:00' });
  // The salon's clock is made, not waited for: a walk-in is seated now and a
  // booking moved to two hours from now, both inside its 09:00–21:00 hours, so
  // the salon keeps a time zone where it is between 10:00 and 16:00 whenever
  // the suite runs (India's while its hour allows it). Its dates and times are
  // read on that clock; the weight shops stay on India's.
  const zone = zoneWithHour(10, 15);
  await pool.query('UPDATE businesses SET timezone=$2 WHERE id=$1', [salon.id, zone]);
  const day = (offset, tz = zone) => { const d = daysFrom(offset, tz); return { d, dow: weekdayOf(d) }; };
  const ahead = day(10);
  const at = (hhmm, d = ahead.d) => momentAt(d, hhmm, zone);
  const book = (body, expected = 201) => request('POST', S('salon/appointments'), { requestKey: key(), ...body }, expected);

  await t.test('moving a booking keeps its deposit, checks clashes and never charges a fee', async () => {
    const booking = await book({ contactId: ananya.id, skuId: cut.id, resourceId: priya.id, startsAt: at('10:00'), deposit: { amount: '100', method: 'upi' } });
    await book({ contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('15:00') });
    // Into Arjun's 15:00 booking: refused.
    await request('PATCH', S(`salon/appointments/${booking.id}`), { startsAt: at('15:30'), resourceId: arjun.id }, 409);
    // Outside hours: refused.
    await request('PATCH', S(`salon/appointments/${booking.id}`), { startsAt: at('20:30') }, 400);
    const moved = await request('PATCH', S(`salon/appointments/${booking.id}`), { startsAt: at('12:00'), resourceId: arjun.id });
    assert.equal(Number(moved.resource_id), Number(arjun.id));
    assert.equal(new Date(moved.ends_at).getTime() - new Date(moved.starts_at).getTime(), 60 * 60000, 'keeps its length');
    const details = await one('SELECT * FROM salon_appointment_details WHERE appointment_id=$1', [booking.id]);
    assert.equal(Number(details.deposit_collection_id), Number(booking.deposit_collection_id));
    assert.equal(details.moved_count, 1);
    assert.equal(details.fee_document_id, null);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='appointment.moved' AND entity_id=$2", [salon.id, String(booking.id)]);
    assert.ok(audit, 'audited');
    assert.equal(Number(audit.details.from.resourceId), Number(priya.id));
    // A move inside the late-cancel window still charges nothing (two hours from
    // now is inside the salon's hours on its clock).
    const soon = await book({ contactId: ravi.id, skuId: spa.id, resourceId: priya.id, startsAt: new Date(Math.ceil((Date.now() + 2 * 3600000) / 900000) * 900000).toISOString(),
      deposit: { amount: '250', method: 'cash' } });
    const later = new Date(new Date(soon.starts_at).getTime() + 3600000).toISOString();
    await request('PATCH', S(`salon/appointments/${soon.id}`), { startsAt: later });
    assert.equal((await one('SELECT fee_document_id FROM salon_appointment_details WHERE appointment_id=$1', [soon.id])).fee_document_id, null);
    // A room can be added on a move; a facial cannot lose its room.
    await request('PUT', S(`salon/staff/${priya.id}`), { kind: 'staff', skuIds: [] });
    const fac = await book({ contactId: ananya.id, skuId: facial.id, resourceId: priya.id, roomId: room.id, startsAt: at('16:00') });
    await request('PATCH', S(`salon/appointments/${fac.id}`), { startsAt: at('17:00'), roomId: null }, 400);
    await request('PATCH', S(`salon/appointments/${fac.id}`), { startsAt: at('17:00') });
    // Another business cannot touch it.
    await other('PATCH', S(`salon/appointments/${fac.id}`), { startsAt: at('18:00') }, 404);
  });

  await t.test('stylist hours, weekly off and leave refuse bookings', async () => {
    const later = day(12);
    await request('PUT', S(`salon/staff/${arjun.id}`), { kind: 'staff', skuIds: [], weeklyOff: [later.dow], worksFrom: '10:00', worksTo: '18:00' });
    await book({ contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('11:00', later.d) }, 409);
    const next = day(13);
    await book({ contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('09:00', next.d) }, 409);
    await book({ contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('10:00', next.d) });
    // Leave over a day with a booking is refused until it is moved.
    await request('POST', S(`salon/staff/${arjun.id}/leave`), { fromDate: next.d, toDate: next.d, reason: 'Wedding' }, 409);
    const free = day(14);
    const leave = await request('POST', S(`salon/staff/${arjun.id}/leave`), { fromDate: free.d, toDate: free.d, reason: 'Wedding' }, 201);
    await book({ contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('11:00', free.d) }, 409);
    const staffList = (await request('GET', S('salon/staff?kind=staff'))).items.find((r) => Number(r.id) === Number(arjun.id));
    assert.equal(staffList.leave.length, 1);
    assert.deepEqual(staffList.weekly_off.map(Number), [later.dow]);
    await request('POST', S(`salon/staff/${arjun.id}/leave/${leave.id}/cancel`), {});
    await book({ contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('11:00', free.d) });
    const week = await request('GET', S(`salon/calendar?date=${ahead.d}&days=7`));
    assert.equal(week.days, 7);
    assert.ok(week.appointments.length >= 4);
    await request('GET', S(`salon/calendar?date=${ahead.d}&days=9`), undefined, 400);
    // Back to every day, so later tests can book today.
    await request('PUT', S(`salon/staff/${arjun.id}`), { kind: 'staff', skuIds: [], weeklyOff: [], worksFrom: '', worksTo: '' });
  });

  await t.test('arrival, WhatsApp messages and walk-ins', async () => {
    const today = day(0);
    // A booking today that started an hour ago is late until the client arrives.
    const booking = await book({ contactId: ananya.id, skuId: spa.id, resourceId: priya.id, startsAt: at('13:00', ahead.d) });
    await pool.query("UPDATE business_appointments SET starts_at=now()-interval '1 hour',ends_at=now() WHERE id=$1", [booking.id]);
    let cal = await request('GET', S(`salon/calendar?date=${today.d}`));
    assert.equal(cal.appointments.find((a) => Number(a.id) === Number(booking.id)).late, true);
    await request('POST', S(`salon/appointments/${booking.id}/arrived`), {});
    cal = await request('GET', S(`salon/calendar?date=${today.d}`));
    const row = cal.appointments.find((a) => Number(a.id) === Number(booking.id));
    assert.equal(row.late, false);
    assert.ok(row.arrived_at);
    assert.equal(cal.totals.arrived, 1);
    const sent = await request('POST', S(`salon/appointments/${booking.id}/messages`), { kind: 'reminder' });
    assert.ok(sent.sentAt);
    await request('POST', S(`salon/appointments/${booking.id}/messages`), { kind: 'sms' }, 400);
    // Walk-ins wait, then are seated with a stylist (booked now, marked arrived).
    const walk = await cashier('POST', S('salon/walk-ins'), { contactId: ravi.id, skuId: cut.id, note: 'Short on the sides' }, 201);
    await cashier('POST', S('salon/walk-ins'), { contactId: ravi.id, skuId: cut.id }, 409);
    const waiting = (await request('GET', S('salon/walk-ins?status=waiting'))).items;
    assert.equal(waiting.length, 1);
    const requestKey = key();
    const seated = await cashier('POST', S(`salon/walk-ins/${walk.id}/seat`), { resourceId: arjun.id, requestKey });
    assert.equal(seated.walkIn.status, 'seated');
    const seatedDetails = await one('SELECT walk_in,arrived_at FROM salon_appointment_details WHERE appointment_id=$1', [seated.appointment.id]);
    assert.equal(seatedDetails.walk_in, true);
    assert.ok(seatedDetails.arrived_at);
    assert.equal((await cashier('POST', S(`salon/walk-ins/${walk.id}/seat`), { resourceId: arjun.id, requestKey })).repeated, true);
    const gone = await cashier('POST', S('salon/walk-ins'), { contactId: ananya.id, skuId: cut.id }, 201);
    await cashier('POST', S(`salon/walk-ins/${gone.id}/left`), {});
    await cashier('POST', S(`salon/walk-ins/${gone.id}/left`), {}, 409);
  });

  await t.test('the client card: profile, notes and formulas, visits', async () => {
    await request('PUT', S(`salon/clients/${ananya.id}/profile`), { birthday: '1994-03-12', gender: 'female', preferredResourceId: priya.id, allergies: 'PPD in hair dye' });
    await request('PUT', S(`salon/clients/${ananya.id}/profile`), { preferredResourceId: room.id }, 404);
    await request('POST', S(`salon/clients/${ananya.id}/notes`), { kind: 'formula', body: "L'Oreal 6.1 + 20 vol, 35 min" }, 201);
    await request('POST', S(`salon/clients/${ananya.id}/notes`), { kind: 'note', body: '' }, 400);
    const card = await request('GET', S(`salon/clients/${ananya.id}`));
    assert.equal(card.profile.allergies, 'PPD in hair dye');
    assert.equal(card.profile.preferred_resource_name, 'Priya');
    assert.equal(card.notes[0].kind, 'formula');
    assert.ok(card.stats && card.stats.visits === 0);
    // Notes are kept as written.
    await assert.rejects(pool.query('UPDATE salon_client_notes SET body=$1', ['x']));
  });

  let packageLine, held;
  await t.test('commission: plan sales, package sessions, flat amounts; tips and mixed payments', async () => {
    const pkg = await request('POST', S('salon/plans'), { kind: 'package', name: 'Spa × 4', price: '3200', validityDays: 180, services: [{ skuId: spa.id, sessions: 4 }] }, 201);
    await request('POST', S('salon/commission-rules'), { appliesTo: 'service', percent: '10' }, 201);
    await request('POST', S('salon/commission-rules'), { appliesTo: 'plan', percent: '5' }, 201);
    await request('POST', S('salon/commission-rules'), { appliesTo: 'plan', skuId: cut.id, percent: '5' }, 409);
    await request('POST', S('salon/commission-rules'), { appliesTo: 'service', skuId: cut.id, resourceId: arjun.id, flatAmount: '50' }, 201);
    // Sell the package (Priya sold it): 5% of 3200 = 160.
    const sold = await request('POST', S('salon/bills'), { locationId: loc.id, contactId: ananya.id, requestKey: key(),
      lines: [{ skuId: pkg.sku_id, quantity: '1', staffId: priya.id }], payment: { amount: '3776', method: 'upi' } }, 201);
    packageLine = await one("SELECT * FROM salon_line_staff WHERE document_id=$1", [sold.document.id]);
    assert.equal(packageLine.item_kind, 'plan');
    assert.equal(Number(packageLine.commission_amount), 160);
    held = await one('SELECT * FROM salon_client_plans WHERE document_id=$1', [sold.document.id]);
    // Use a session (Priya): commission on 3200 / 4 = 800 → 10% = 80.
    const used = await request('POST', S('salon/bills'), { locationId: loc.id, contactId: ananya.id, requestKey: key(),
      lines: [{ skuId: spa.id, quantity: '1', staffId: priya.id, clientPlanId: held.id }] }, 201);
    const session = await one('SELECT * FROM salon_line_staff WHERE document_id=$1', [used.document.id]);
    assert.equal(session.item_kind, 'session');
    assert.equal(Number(session.commission_base), 800);
    assert.equal(Number(session.commission_amount), 80);
    // At the list price instead (a setting): 1000 → 100.
    await request('PUT', S('salon/settings'), { depositPercent: '25', freeCancelHours: 4, lateCancelFeePercent: '50', noShowFeePercent: '100', opensAt: '09:00', closesAt: '21:00', sessionCommissionBasis: 'list_price' });
    const used2 = await request('POST', S('salon/bills'), { locationId: loc.id, contactId: ananya.id, requestKey: key(),
      lines: [{ skuId: spa.id, quantity: '1', staffId: priya.id, clientPlanId: held.id }] }, 201);
    assert.equal(Number((await one('SELECT commission_amount FROM salon_line_staff WHERE document_id=$1', [used2.document.id])).commission_amount), 100);
    // Arjun's haircut: flat 50 a cut. Two payments (UPI + cash) and a tip; a discount needs a reason.
    await request('POST', S('salon/bills'), { locationId: loc.id, contactId: ravi.id, requestKey: key(), discount: { amount: '20' },
      lines: [{ skuId: cut.id, quantity: '1', staffId: arjun.id }] }, 400);
    await cashier('POST', S('salon/quote'), { locationId: loc.id, contactId: ravi.id, discount: { amount: '20', reason: 'Regular' },
      lines: [{ skuId: cut.id, quantity: '1', staffId: arjun.id }] }, 403);
    const quote = await request('POST', S('salon/quote'), { locationId: loc.id, contactId: ravi.id, discount: { amount: '20', reason: 'Regular' },
      lines: [{ skuId: cut.id, quantity: '1', staffId: arjun.id }] });
    const total = Number(quote.total);
    assert.ok(total < 472, 'the discount comes off');
    await request('POST', S('salon/bills'), { locationId: loc.id, contactId: ravi.id, requestKey: key(), discount: { amount: '20', reason: 'Regular' },
      lines: [{ skuId: cut.id, quantity: '1', staffId: arjun.id }], payments: [{ amount: '400', method: 'upi' }, { amount: '400', method: 'cash' }] }, 409);
    await request('POST', S('salon/bills'), { locationId: loc.id, contactId: ravi.id, requestKey: key(),
      lines: [{ skuId: cut.id, quantity: '1', staffId: arjun.id }], payments: [{ amount: '1', method: 'upi' }, { amount: '1', method: 'cash' }, { amount: '1', method: 'card' }, { amount: '1', method: 'cash' }] }, 400);
    const cutBill = await request('POST', S('salon/bills'), { locationId: loc.id, contactId: ravi.id, requestKey: key(), discount: { amount: '20', reason: 'Regular' },
      lines: [{ skuId: cut.id, quantity: '1', staffId: arjun.id }], payments: [{ amount: '300', method: 'upi' }, { amount: (total - 300).toFixed(2), method: 'cash' }],
      tips: [{ staffId: arjun.id, amount: '50', method: 'cash' }] }, 201);
    const pays = await rows('SELECT method,amount FROM business_payments WHERE document_id=$1 ORDER BY id', [cutBill.document.id]);
    assert.deepEqual(pays.map((p) => p.method), ['upi', 'cash']);
    assert.equal(pays.reduce((s, p) => s + paise(p.amount), 0), paise(cutBill.document.total));
    const cutLine = await one('SELECT * FROM salon_line_staff WHERE document_id=$1', [cutBill.document.id]);
    assert.equal(Number(cutLine.commission_amount), 50);
    assert.equal(Number(cutLine.commission_percent), 0);
    const tip = await one('SELECT * FROM salon_tips WHERE document_id=$1', [cutBill.document.id]);
    assert.equal(Number(tip.amount), 50);
    assert.equal(Number(cutBill.document.total), total, 'a tip is not part of the bill');
  });

  await t.test('commission report: earned, tips, paid and due; payouts', async () => {
    const today = day(0).d;
    const report = await request('GET', S(`salon/commissions?from=${today}&to=${today}`));
    const p = report.rows.find((r) => Number(r.resource_id) === Number(priya.id));
    assert.equal(Number(p.commission), 340);
    assert.equal(Number(p.plan_sales), 3200);
    assert.equal(Number(p.sessions_done), 2);
    const a = report.rows.find((r) => Number(r.resource_id) === Number(arjun.id));
    assert.equal(Number(a.tips), 50);
    assert.equal(Number(a.due), 100);
    await request('POST', S('salon/commission-payouts'), { resourceId: arjun.id, from: today, to: today, amount: '150', method: 'cash', requestKey: key() }, 409);
    await cashier('POST', S('salon/commission-payouts'), { resourceId: arjun.id, from: today, to: today, amount: '50', method: 'cash', requestKey: key() }, 403);
    const requestKey = key();
    const paid = await request('POST', S('salon/commission-payouts'), { resourceId: arjun.id, from: today, to: today, amount: '100', method: 'cash', requestKey }, 201);
    assert.equal(Number(paid.commission), 50);
    assert.equal(Number(paid.tips), 50);
    assert.equal((await request('POST', S('salon/commission-payouts'), { resourceId: arjun.id, from: today, to: today, amount: '100', method: 'cash', requestKey }, 201)).id, paid.id);
    const after = (await request('GET', S(`salon/commissions?from=${today}&to=${today}`))).rows.find((r) => Number(r.resource_id) === Number(arjun.id));
    assert.equal(Number(after.paid), 100);
    assert.equal(Number(after.due), 0);
    assert.equal((await request('GET', S('salon/commission-payouts'))).items.length, 1);
  });

  await t.test('package holders: extend with a reason, usage, totals', async () => {
    await request('PATCH', S(`salon/client-plans/${held.id}`), { endsOn: '2020-01-01', reason: 'x' }, 400);
    await request('PATCH', S(`salon/client-plans/${held.id}`), { endsOn: '2099-01-01' }, 400);
    const longer = new Date(new Date(held.ends_on).getTime() + 30 * 86400000).toISOString().slice(0, 10);
    const row = await request('PATCH', S(`salon/client-plans/${held.id}`), { endsOn: longer, reason: 'Client was unwell' });
    assert.equal(String(row.ends_on).slice(0, 10), longer);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='package.extended'", [salon.id]));
    const usage = (await request('GET', S(`salon/plan-usage?plan=${held.id}`))).items;
    assert.equal(usage.length, 2);
    const totals = await request('GET', S('salon/client-plans-summary'));
    assert.equal(totals.sessions_left, 2);
    assert.equal(Number(totals.sessions_left_value), 1600);
    // Still only extendable: the price stays fixed.
    await assert.rejects(pool.query('UPDATE salon_client_plans SET price=1 WHERE id=$1', [held.id]));
    const history = (await request('GET', S('salon/appointments'))).items;
    assert.ok(history.length > 3);
    assert.ok('deposit_amount' in history[0] && 'bill_no' in history[0]);
  });

  // --- Weight shops ------------------------------------------------------------------------------
  const mloc = (await request('GET', M('locations'))).items[0];
  const nil = (await request('GET', M('tax-rates'))).items.find((r) => Number(r.rate) === 0);
  const weighed = (name, code, price, tracking = 'batch') => request('POST', M('catalog'), { name, code, kind: 'goods', unit: 'kg', tracking, price, taxRateId: nil.id }, 201);
  const whole = await weighed('Whole chicken', 'WHL', '200');
  const curry = await weighed('Curry cut', 'CUR', '260');
  const liver = await weighed('Liver', 'LVR', '180', 'quantity');
  const farm = await request('POST', M('contacts'), { kind: 'supplier', name: 'Farm' }, 201);
  const soon = day(3, meat.timezone);
  await request('POST', M('documents'), { kind: 'purchase', locationId: mloc.id, contactId: farm.id, requestKey: key(), lines: [
    { skuId: whole.id, quantity: '20', unitPrice: '150', lotCode: 'W1', expiresOn: soon.d }, { skuId: liver.id, quantity: '5', unitPrice: '100' }] }, 201);
  const wholeLot = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [meat.id, whole.id]);
  const template = await request('POST', M('weight/yield-templates'), { name: 'Curry cut', inputSkuId: whole.id, outputs: [{ skuId: curry.id, expectedPercent: '90' }] }, 201);

  await t.test('rate board: bulk change with history, MRP respected', async () => {
    const before = await request('GET', M('weight/rates'));
    assert.equal(before.rows.length, 3);
    await request('PUT', M('weight/rates'), { rates: [{ skuId: curry.id, price: '270' }, { skuId: whole.id, price: '210' }] });
    const after = await request('GET', M('weight/rates'));
    const c = after.rows.find((r) => Number(r.id) === Number(curry.id));
    assert.equal(Number(c.price), 270);
    assert.equal(Number(c.opening_price), 260, 'the rate the day opened with');
    assert.equal(c.changed_today, true);
    assert.equal((await request('GET', M(`weight/rate-history?sku=${curry.id}`))).items.length, 1);
    // An item with an MRP is never priced above it.
    await pool.query('UPDATE catalog_skus SET mrp=300 WHERE id=$1', [curry.id]);
    await request('PUT', M('weight/rates'), { rates: [{ skuId: curry.id, price: '320' }] }, 409);
    await request('PUT', M('weight/rates'), { rates: [{ skuId: curry.id, price: '260' }] });
    // Nothing changed: no history row.
    assert.equal((await request('PUT', M('weight/rates'), { rates: [{ skuId: curry.id, price: '260' }] })).changed.length, 0);
    const eggs = await request('POST', M('catalog'), { name: 'Eggs', code: 'EGG', kind: 'goods', unit: 'each', tracking: 'quantity', price: '7', taxRateId: nil.id }, 201);
    await request('PUT', M('weight/rates'), { rates: [{ skuId: eggs.id, price: '8' }] }, 404);
    // Customer rates per kg use the shared price lists, which meat shops may switch on.
    await request('PUT', M('modules/wholesale'), { enabled: true });
  });

  await t.test('cut to order: a cutting batch with who cut it and the supplier', async () => {
    const batch = await request('POST', M('weight/cut-to-order'), { inputLotId: wholeLot.id, inputQuantity: '1.5', templateId: template.id, cutBy: 'Salim',
      outputs: [{ skuId: curry.id, quantity: '1.3' }], requestKey: key() }, 201);
    assert.equal(batch.cut_to_order, true);
    assert.equal(batch.cut_by, 'Salim');
    assert.equal(Number(batch.supplier_id), Number(farm.id));
    assert.equal(batch.outputs[0].label, 'Curry cut');
    assert.equal(batch.outputs[0].lotCode, batch.batch_no);
    // The counter sells the cut from that batch.
    await request('POST', M('documents'), { kind: 'sale', locationId: mloc.id, requestKey: key(), lines: [{ skuId: curry.id, quantity: '1.3', lotCode: batch.batch_no }],
      payment: { amount: 'full', method: 'cash' } }, 201);
    // A normal batch, cut by someone else, with a poorer yield.
    await request('POST', M('weight/processing'), { inputLotId: wholeLot.id, inputQuantity: '10', templateId: template.id, cutBy: 'Ravi',
      outputs: [{ skuId: curry.id, quantity: '8.5' }, { skuId: liver.id, quantity: '0.4' }], requestKey: key() }, 201);
    const report = await request('GET', M(`weight/reports/yield?from=${day(0, meat.timezone).d}&to=${day(0, meat.timezone).d}`));
    assert.equal(report.inputs.length, 1);
    assert.equal(report.inputs[0].label, 'Curry cut');
    assert.equal(report.inputs[0].input_label, 'Whole chicken');
    assert.ok(Number(report.inputs[0].short_points) > 0);
    assert.ok(Number(report.inputs[0].short_value) > 0);
    assert.deepEqual(report.cutters.sort(), ['Ravi', 'Salim']);
    assert.equal(report.suppliers.length, 1);
    const salim = await request('GET', M(`weight/reports/yield?from=${day(0, meat.timezone).d}&to=${day(0, meat.timezone).d}&cutter=Salim`));
    assert.equal(salim.totals.batches, 1);
    const listed = (await request('GET', M(`weight/processing?cutter=Ravi`))).items;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].supplier_name, 'Farm');
  });

  await t.test('wastage in one go, today’s tile, stock for today and the weigh-up', async () => {
    let tile = await request('GET', M('weight/wastage-today'));
    assert.equal(tile.entries, 0, 'no entries means 0, not 1');
    const requestKey = key();
    const saved = await request('POST', M('weight/wastage/batch'), { locationId: mloc.id, requestKey,
      entries: [{ skuId: liver.id, quantity: '0.5', reason: 'spoiled' }, { skuId: curry.id, quantity: '0.2', reason: 'drip_loss' }] }, 201);
    assert.equal(saved.entries.length, 2);
    assert.equal((await request('POST', M('weight/wastage/batch'), { locationId: mloc.id, requestKey,
      entries: [{ skuId: liver.id, quantity: '0.5', reason: 'spoiled' }, { skuId: curry.id, quantity: '0.2', reason: 'drip_loss' }] }, 201)).repeated, true);
    await request('POST', M('weight/wastage/batch'), { locationId: mloc.id, requestKey: key(), entries: [{ skuId: liver.id, quantity: '500', reason: 'spoiled' }] }, 409);
    tile = await request('GET', M('weight/wastage-today'));
    assert.equal(tile.entries, 2);
    assert.equal(Number(tile.kg), 0.7);
    const stock = (await request('GET', M('weight/stock-today'))).rows;
    const c = stock.find((r) => Number(r.sku_id) === Number(curry.id));
    assert.equal(Number(c.cut_in), 9.8);
    assert.equal(Number(c.sold), 1.3);
    assert.equal(Number(c.wasted), 0.2);
    assert.equal(Number(c.on_hand), 8.3);
    const w = stock.find((r) => Number(r.sku_id) === Number(whole.id));
    assert.equal(Number(w.received), 20);
    assert.equal(Number(w.cut_out), 11.5);
    // The weigh-up: 8.0 kg of curry cut left (0.3 short → drip loss), 9 kg whole (0.5 over).
    const close = await request('POST', M('weight/day-close'), { locationId: mloc.id, requestKey: key(), lines: [
      { skuId: curry.id, counted: '8.0' }, { skuId: whole.id, counted: '9' }, { skuId: liver.id, counted: '' }] }, 201);
    assert.equal(Number(close.short_kg), 0.3);
    assert.equal(Number(close.over_kg), 0.5);
    assert.equal(close.lines.length, 2);
    assert.equal(Number((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE sku_id=$1', [curry.id])).q), 8);
    assert.equal(Number((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE sku_id=$1', [whole.id])).q), 9);
    assert.ok(await one("SELECT 1 FROM weight_wastage_entries WHERE sku_id=$1 AND reason='drip_loss' AND note='End-of-day weigh-up'", [curry.id]));
    assert.equal((await request('GET', M('weight/day-closes'))).items.length, 1);
    const today = await request('GET', M('weight/today'));
    assert.equal(Number(today.sold.kg), 1.3);
    assert.equal(today.cut.batches, 2);
    assert.equal(today.rates.changed_today, 2);
  });

  await t.test('orders for pickup: open, ready, collected with its bill, or cancelled with a reason', async () => {
    const hotel = await request('POST', M('contacts'), { kind: 'customer', name: 'Hotel Annapurna', phone: '9820022222' }, 201);
    const pickupAt = new Date(Date.now() + 3 * 3600000).toISOString();
    await request('POST', M('weight/pickup-orders'), { locationId: mloc.id, contactId: hotel.id, pickupAt, lines: [{ skuId: curry.id }], requestKey: key() }, 400);
    const order = await request('POST', M('weight/pickup-orders'), { locationId: mloc.id, contactId: hotel.id, pickupAt, notes: 'No skin',
      lines: [{ skuId: curry.id, quantity: '2' }, { skuId: liver.id, amount: '200' }], requestKey: key() }, 201);
    assert.equal(order.customer_name, 'Hotel Annapurna');
    await request('POST', M(`weight/pickup-orders/${order.id}/status`), { status: 'ready' });
    const listed = (await request('GET', M('weight/pickup-orders?status=ready'))).items;
    assert.equal(listed[0].lines.length, 2);
    await request('POST', M(`weight/pickup-orders/${order.id}/status`), { status: 'collected' }, 400);
    const lotCode = (await one('SELECT lot_code FROM business_stock_lots WHERE sku_id=$1 AND quantity>=2 ORDER BY id LIMIT 1', [curry.id])).lot_code;
    const bill = await request('POST', M('documents'), { kind: 'sale', locationId: mloc.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: curry.id, quantity: '2', lotCode }] }, 201);
    const done = await request('POST', M(`weight/pickup-orders/${order.id}/status`), { status: 'collected', documentId: bill.id });
    assert.equal(done.status, 'collected');
    await request('POST', M(`weight/pickup-orders/${order.id}/status`), { status: 'ready' }, 409);
    const walk = await request('POST', M('weight/pickup-orders'), { locationId: mloc.id, customerName: 'Sunita', phone: '98200 33333', pickupAt,
      lines: [{ skuId: curry.id, quantity: '1' }], requestKey: key() }, 201);
    await request('POST', M(`weight/pickup-orders/${walk.id}/status`), { status: 'cancelled' }, 400);
    await request('POST', M(`weight/pickup-orders/${walk.id}/status`), { status: 'cancelled', reason: 'Called to cancel' });
    await request('POST', M(`weight/pickup-orders/${walk.id}/status`), { status: 'collected', documentId: bill.id }, 409);
    await other('GET', M('weight/pickup-orders'), undefined, 404);
  });

  await t.test('dry fruits: repacking loose stock into pouches sold by the piece', async () => {
    const dloc = (await request('GET', D('locations'))).items[0];
    const dnil = (await request('GET', D('tax-rates'))).items[0];
    const loose = await request('POST', D('catalog'), { name: 'Cashew loose', code: 'CSH', kind: 'goods', unit: 'kg', tracking: 'quantity', price: '1000', taxRateId: dnil.id }, 201);
    const pouch = await request('POST', D('catalog'), { name: 'Cashew 250 g pouch', code: 'CSH250', kind: 'goods', unit: 'each', tracking: 'quantity', price: '260', taxRateId: dnil.id }, 201);
    const sup = await request('POST', D('contacts'), { kind: 'supplier', name: 'Nut traders' }, 201);
    await request('POST', D('documents'), { kind: 'purchase', locationId: dloc.id, contactId: sup.id, requestKey: key(), lines: [{ skuId: loose.id, quantity: '5', unitPrice: '800' }] }, 201);
    const lot = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [dry.id, loose.id]);
    await request('POST', D('weight/processing'), { inputLotId: lot.id, inputQuantity: '2.1', outputs: [{ skuId: pouch.id, quantity: '8' }], requestKey: key() }, 400);
    const batch = await request('POST', D('weight/processing'), { inputLotId: lot.id, inputQuantity: '2.1', outputs: [{ skuId: pouch.id, quantity: '8', packKg: '0.25' }], requestKey: key() }, 201);
    assert.equal(Number(batch.output_kg), 2);
    assert.equal(Number(batch.loss_kg), 0.1);
    assert.equal(Number((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE sku_id=$1', [pouch.id])).q), 8);
    // The pack weight is remembered for next time.
    const again = await request('POST', D('weight/processing'), { inputLotId: lot.id, inputQuantity: '1', outputs: [{ skuId: pouch.id, quantity: '4' }], requestKey: key() }, 201);
    assert.equal(Number(again.output_kg), 1);
    await request('POST', D('weight/processing'), { inputLotId: lot.id, inputQuantity: '1', outputs: [{ skuId: pouch.id, quantity: '2.5' }], requestKey: key() }, 400);
  });
});
