const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { withTools } = require('./helpers/tools');
const { createBusinesses } = require('./helpers/businesses');
const { signIn } = require('./helpers/signIn');

// Business Admin rules for the non-restaurant types:
//   - the overview's "customers owe" is the receivables balance (owed − advances);
//   - overview sales are net of returns, each on its own date;
//   - one booking goes on one bill line, once;
//   - no-show only after the start time; done only on the day or later;
//   - screens of other types are refused; member candidates leave out
//     people who already have access.
// Runs against its own throwaway database with every migration applied.

test('business admin: bookings, overview figures, member candidates, page guard', { timeout: 600000 }, async (t) => {
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
  const password = `Owner-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  async function owner(code, name) {
    const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', [code]);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,restaurant_id', [restaurant.id, name, `${code}@test.invalid`, hash]);
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
  const login = async (email) => (await signIn(base, email, password)).token;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const key = () => crypto.randomUUID();
  const ownerA = await owner('owner-a', 'Asha Rao');
  await owner('owner-b', 'Bharat Shah');
  const a = as(await login('owner-a@test.invalid'));
  const b = as(await login('owner-b@test.invalid'));
  // Owner A runs a grocery, a salon and a clinic, owner B a wholesale business,
  // each added the way an owner adds one, with its specialist tools on.
  const businessesA = await withTools(a, await createBusinesses(a, 'A', ['grocery', 'salon', 'healthcare']));
  const businessesB = await withTools(b, await createBusinesses(b, 'B', ['wholesale']));
  // Goods shops start with prices including GST, rounded to the rupee, and a
  // walk-in pays in full. These checks use prices before GST and post unpaid
  // walk-in bills as fixtures.
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const of = (list, type) => list.find((x) => x.business_type === type);
  const root = (business, route) => `/businesses/${business.id}/${route}`;
  const location = async (business) => one('SELECT id FROM business_locations WHERE business_id=$1 ORDER BY id LIMIT 1', [business.id]);
  const today = (await one("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).d;

  // --- Salon: one booking per bill line, statuses only when they can be true --------------------

  // The salon as its owner sets it up: two services, a stylist who does both
  // (no day off and no set hours, so he can be booked whatever day the test
  // runs), two clients, and a package of five hair spa sessions sold to Ananya.
  const salon = of(businessesA, 'salon');
  const salonLocation = (await location(salon)).id;
  const service = (name, code, price) => a('POST', root(salon, 'catalog'), { name, code, kind: 'service', unit: 'service', tracking: 'none', price, taxRate: '18' }, 201);
  const cut = await service('Haircut', 'SV-CUT', '350');
  const spa = await service('Hair spa', 'SV-SPA', '1200');
  const arjun = await a('POST', root(salon, 'resources'), { name: 'Arjun', roleLabel: 'Stylist', locationId: salonLocation }, 201);
  await a('PUT', root(salon, `salon/staff/${arjun.id}`), { kind: 'staff', skuIds: [cut.id, spa.id] });
  const customer = (name, phone) => a('POST', root(salon, 'contacts'), { kind: 'customer', name, phone }, 201);
  const lakshmi = await customer('Lakshmi Iyer', '98200 55555');
  const ananya = await customer('Ananya Sharma', '98860 11001');
  const hairSpa = await a('POST', root(salon, 'salon/plans'), { kind: 'package', name: 'Hair spa × 5', price: '5000', validityDays: 180, services: [{ skuId: spa.id, sessions: 5 }] }, 201);
  const packageSale = { locationId: salonLocation, contactId: ananya.id, lines: [{ skuId: hairSpa.sku_id, quantity: '1' }] };
  const { total } = await a('POST', root(salon, 'salon/quote'), packageSale);
  await a('POST', root(salon, 'salon/bills'), { ...packageSale, payment: { amount: total, method: 'upi' }, requestKey: key() }, 201);
  const at = async (days, hhmm) => (await one(`SELECT ((((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text || ' ' || $2)::timestamp AT TIME ZONE 'Asia/Kolkata') AS t`, [days, hhmm])).t.toISOString();

  await t.test('a booking still to come cannot be a no-show, nor done before its day', async () => {
    const booking = await a('POST', root(salon, 'salon/appointments'), { contactId: lakshmi.id, skuId: cut.id, resourceId: arjun.id,
      startsAt: await at(1, '13:00'), requestKey: key(), deposit: { amount: '100', method: 'upi' } }, 201);
    const refused = await call('POST', root(salon, `salon/appointments/${booking.id}/status`), { status: 'no_show', requestKey: key() }, await login('owner-a@test.invalid'));
    assert.equal(refused.status, 409);
    assert.match(refused.body.message || refused.body.error?.message || JSON.stringify(refused.body), /not started yet/);
    await a('PATCH', root(salon, `appointments/${booking.id}`), { status: 'no_show' }, 409);
    await a('PATCH', root(salon, `appointments/${booking.id}`), { status: 'completed' }, 409);
    assert.equal((await one('SELECT status FROM business_appointments WHERE id=$1', [booking.id])).status, 'booked');
    assert.equal((await one('SELECT fee_document_id FROM salon_appointment_details WHERE appointment_id=$1', [booking.id])).fee_document_id, null, 'no charge taken from the deposit');
    await a('POST', root(salon, `salon/appointments/${booking.id}/status`), { status: 'cancelled', requestKey: key() });
    // Once its start time has passed a booking can be a no-show: a haircut
    // Lakshmi missed at 09:00 today, or at 19:00 yesterday when it is not
    // 09:00 yet (the salon books from 09:00 to 21:00).
    const hour = Number((await one("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','HH24') AS h")).h);
    const missed = await a('POST', root(salon, 'salon/appointments'), { contactId: lakshmi.id, skuId: cut.id, resourceId: arjun.id,
      startsAt: hour >= 9 ? await at(0, '09:00') : await at(-1, '19:00'), requestKey: key() }, 201);
    await a('POST', root(salon, `salon/appointments/${missed.id}/status`), { status: 'no_show', requestKey: key() });
    assert.ok((await one("SELECT count(*)::int AS n FROM business_appointments WHERE business_id=$1 AND status='no_show' AND starts_at<=now()", [salon.id])).n >= 1);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_appointments WHERE business_id=$1 AND status='no_show' AND starts_at>now()", [salon.id])).n, 0);

    // The generic appointments (a clinic) follow the same rule: its doctor, a
    // patient and the consultation they are booked for.
    const clinic = of(businessesA, 'healthcare');
    const doctor = await a('POST', root(clinic, 'resources'), { name: 'Dr. Karan Shah', roleLabel: 'Paediatrician', locationId: (await location(clinic)).id }, 201);
    const patient = await a('POST', root(clinic, 'contacts'), { kind: 'customer', name: 'Mohammed Irfan', phone: '98200 44444' }, 201);
    const consult = (await a('POST', root(clinic, 'catalog'), { name: 'General consultation', code: 'CN-GEN', kind: 'service', unit: 'service', tracking: 'none', price: '500', taxRate: '0' }, 201)).id;
    const later = new Date(Date.now() + 2 * 86400000);
    const future = await a('POST', root(clinic, 'appointments'), { contactId: patient.id, skuId: consult, resourceId: doctor.id, startsAt: later.toISOString(), endsAt: new Date(later.getTime() + 1800000).toISOString() }, 201);
    await a('PATCH', root(clinic, `appointments/${future.id}`), { status: 'no_show' }, 409);
    await a('PATCH', root(clinic, `appointments/${future.id}`), { status: 'completed' }, 409);
    const earlier = new Date(Date.now() - 6 * 3600000);
    const past = await a('POST', root(clinic, 'appointments'), { contactId: patient.id, skuId: consult, resourceId: doctor.id, startsAt: earlier.toISOString(), endsAt: new Date(earlier.getTime() + 1800000).toISOString() }, 201);
    assert.equal((await a('PATCH', root(clinic, `appointments/${past.id}`), { status: 'no_show' })).status, 'no_show');
  });

  await t.test('one booking goes on one bill line, once', async () => {
    let booking = null;
    for (let h = 9; h <= 19 && !booking; h += 1) {
      const result = await call('POST', root(salon, 'salon/appointments'), { contactId: ananya.id, skuId: spa.id, resourceId: arjun.id, startsAt: await at(0, `${String(h).padStart(2, '0')}:00`), requestKey: key() },
        await login('owner-a@test.invalid'));
      if (result.status === 201) booking = result.body.data;
    }
    assert.ok(booking, 'a free slot today');
    const pkg = await one("SELECT id FROM salon_client_plans WHERE business_id=$1 AND contact_id=$2 AND kind='package' ORDER BY id LIMIT 1", [salon.id, ananya.id]);
    const line = { skuId: spa.id, quantity: '1', staffId: arjun.id, appointmentId: booking.id, clientPlanId: pkg.id };
    const loc = (await location(salon)).id;
    const twice = await call('POST', root(salon, 'salon/bills'), { locationId: loc, contactId: ananya.id, lines: [line, line], appointmentIds: [booking.id], requestKey: key() }, await login('owner-a@test.invalid'));
    assert.equal(twice.status, 409, JSON.stringify(twice.body));
    assert.match(JSON.stringify(twice.body), /already on this bill/);
    const usedBefore = (await one('SELECT COALESCE(sum(quantity),0)::int AS n FROM salon_package_redemptions WHERE client_plan_id=$1', [pkg.id])).n;
    await a('POST', root(salon, 'salon/bills'), { locationId: loc, contactId: ananya.id, lines: [line], appointmentIds: [booking.id], requestKey: key() }, 201);
    assert.equal((await one('SELECT COALESCE(sum(quantity),0)::int AS n FROM salon_package_redemptions WHERE client_plan_id=$1', [pkg.id])).n, usedBefore + 1, 'one package session used');
    const again = await call('POST', root(salon, 'salon/bills'), { locationId: loc, contactId: ananya.id, lines: [line], requestKey: key() }, await login('owner-a@test.invalid'));
    assert.equal(again.status, 409);
    assert.match(JSON.stringify(again.body), /already been billed/);
  });

  // --- Overview figures ----------------------------------------------------------------------

  await t.test('overview owed is the receivables balance; sales are net of returns', async () => {
    const shop = of(businessesB, 'wholesale');
    const loc = (await location(shop)).id;
    const zero = await one('SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=0 ORDER BY id LIMIT 1', [shop.id]);
    const item = await b('POST', root(shop, 'catalog'), { name: 'Test carton', code: 'T-CTN', kind: 'goods', unit: 'each', tracking: 'quantity', price: '100', ...(zero ? { taxRateId: zero.id } : {}) }, 201);
    const supplier = await b('POST', root(shop, 'contacts'), { kind: 'supplier', name: 'Test supplier' }, 201);
    await b('POST', root(shop, 'documents'), { kind: 'purchase', locationId: loc, contactId: supplier.id, requestKey: key(), lines: [{ skuId: item.id, quantity: '20', unitPrice: '60' }] }, 201);
    await b('POST', root(shop, 'contacts'), { kind: 'customer', name: 'Owes from before', openingBalance: '500', openingBalanceOn: today }, 201);
    const ahead = await b('POST', root(shop, 'contacts'), { kind: 'customer', name: 'Paid ahead' }, 201);
    const credit = await b('POST', root(shop, 'documents'), { kind: 'sale', locationId: loc, contactId: ahead.id, requestKey: key(), lines: [{ skuId: item.id, quantity: '1' }] }, 201);
    await b('POST', root(shop, 'collections'), { locationId: loc, contactId: ahead.id, amount: (Number(credit.total) + 200).toFixed(2), method: 'cash', requestKey: key(), allocations: [] }, 201);
    // An even exchange in effect: a walk-in sale returned the same day adds nothing.
    const walkIn = await b('POST', root(shop, 'documents'), { kind: 'sale', locationId: loc, requestKey: key(), lines: [{ skuId: item.id, quantity: '1' }], payment: { amount: '0', method: 'cash' } }, 201);
    await b('POST', root(shop, `documents/${walkIn.id}/payments`), { amount: walkIn.total, method: 'cash', requestKey: key() }, 201);
    const detail = await b('GET', root(shop, `documents/${walkIn.id}`));
    const back = await b('POST', root(shop, `documents/${walkIn.id}/returns`), { reason: 'Changed mind', requestKey: key(), lines: [{ lineId: detail.lines[0].id, quantity: '1', restock: true }] }, 201);
    const summary = await b('GET', root(shop, 'summary'));
    const net = Number(credit.total) + Number(walkIn.total) - Number(back.total);
    assert.equal(Number(summary.sales_today), net);
    assert.equal(Number(summary.sales_month), net);
    assert.equal(Number(summary.sales), net);
    assert.ok(Number(summary.sales_month) <= Number(summary.sales), 'this month is never more than all time');
    assert.equal(Number(summary.receivables_owed), 500);
    assert.equal(Number(summary.receivables_advances), 200);
    assert.equal(Number(summary.receivables), 300);
    // The same figure as Outstanding (every customer, owed less advances).
    const outstanding = await b('GET', `${root(shop, 'outstanding')}?show=all`);
    assert.equal(Number(outstanding.totals.balance), Number(summary.receivables));
  });

  await t.test('people who already have access are not offered again', async () => {
    const staff = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerA.restaurant_id, 'Counter Staff', 'counter-staff@test.invalid', hash]);
    const shop = of(businessesA, 'grocery');
    const before = await a('GET', root(shop, 'member-candidates'));
    assert.ok(before.some((u) => Number(u.id) === Number(staff.id)));
    assert.ok(!before.some((u) => Number(u.id) === Number(ownerA.id)), 'the owner already has access');
    const role = (await a('GET', `${root(shop, 'roles')}?active=true&limit=50`)).items.find((r) => !r.full_access);
    await a('POST', root(shop, 'members'), { userId: staff.id, roleId: role.id }, 201);
    const after = await a('GET', root(shop, 'member-candidates'));
    assert.ok(!after.some((u) => Number(u.id) === Number(staff.id)));
  });

  await t.test('a screen of another business type is refused by the page guard', async () => {
    const nav = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/business-web/src/services/businessNav.js')).href);
    assert.equal(nav.typeAllows(nav.sectionRule('counter', 'salon'), 'salon'), false);
    assert.equal(nav.typeAllows(nav.sectionRule('counter', 'grocery'), 'grocery'), true);
    assert.equal(nav.typeAllows(nav.sectionRule('salon-bill', 'grocery'), 'grocery'), false);
    assert.equal(nav.typeAllows(nav.sectionRule('outstanding', 'grocery'), 'grocery'), false);
    assert.equal(nav.typeAllows(nav.sectionRule('sales', 'salon'), 'salon'), true);
  });
});
