const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { Client } = require('pg');
const bcrypt = require('bcrypt');

// Final check fixes for the Business Admin (non-restaurant types):
//   H1  the demo setup is idempotent from any prior state (the old one-item
//       placeholder, a half-written run, a complete run) and touches only the
//       person's own demos, never a tester's own records;
//   M1  the overview's "customers owe" is the receivables balance (owed − advances);
//   M2  overview sales are net of returns, each on its own date;
//   M3  one booking goes on one bill line, once;
//   M4  no-show only after the start time; done only on the day or later;
//   L2  demo names say whose they are; L3 screens of other types are refused;
//   L5  sample batch codes keep the whole item code; L6 member candidates
//       leave out people who already have access.
// Runs against its own throwaway database with every migration applied.
const SCRIPT = path.resolve(__dirname, '../../scripts/setup-business-demos.js');
const runScript = (database, userId) => new Promise((resolve, reject) => {
  execFile(process.execPath, [SCRIPT, '--user-id', String(userId), '--sample-data'], {
    cwd: path.resolve(__dirname, '../..'), timeout: 280000, maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, DB_NAME: database, MULTI_BUSINESS_DEVELOPMENT: 'true' },
  }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
});
const ean13 = (twelve) => twelve + ((10 - ([...twelve].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10);

test('final business fixes', { timeout: 900000 }, async (t) => {
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
  process.env.MULTI_BUSINESS_DEVELOPMENT = 'true';
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `FinalFix-${crypto.randomBytes(8).toString('hex')}`;
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
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const key = () => crypto.randomUUID();
  const ownerA = await owner('final-a', 'Asha Rao');
  const ownerB = await owner('final-b', 'Bharat Shah');
  const a = as(await login('final-a@test.invalid'));
  const b = as(await login('final-b@test.invalid'));
  const demosA = (await a('POST', '/businesses/development-demos', {}, 201)).businesses.filter((x) => x.is_demo);
  const demosB = (await b('POST', '/businesses/development-demos', {}, 201)).businesses.filter((x) => x.is_demo);
  // Pro pass (1791540000000): goods shops now start with prices including GST,
  // rounded to the rupee, and a walk-in pays in full. These checks were written for
  // prices before GST and post unpaid walk-in bills as fixtures.
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const of = (list, type) => list.find((x) => x.business_type === type);
  const root = (business, route) => `/businesses/${business.id}/${route}`;
  const today = (await one("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).d;

  await t.test('L2: demo businesses carry the name of whose they are', async () => {
    assert.equal(demosA.length, 11);
    assert.ok(demosA.every((x) => x.name.endsWith(' — Asha Rao')), demosA.map((x) => x.name).join(', '));
    assert.ok(demosB.every((x) => x.name.endsWith(' — Bharat Shah')));
    // An older demo with the plain name is renamed; a name the tester chose is kept.
    const grocery = of(demosA, 'grocery'), books = of(demosA, 'books');
    await pool.query("UPDATE businesses SET name='Demo · Grocery & kirana' WHERE id=$1", [grocery.id]);
    await pool.query("UPDATE businesses SET name='My test bookshop' WHERE id=$1", [books.id]);
    await a('POST', '/businesses/development-demos', {}, 201);
    assert.equal((await one('SELECT name FROM businesses WHERE id=$1', [grocery.id])).name, 'Demo · Grocery & kirana — Asha Rao');
    assert.equal((await one('SELECT name FROM businesses WHERE id=$1', [books.id])).name, 'My test bookshop');
  });

  // The state the owner's demos were in: one placeholder item from an earlier
  // version, a half-written run (a book already there with its ISBN barcode),
  // and a tester's own customer.
  const grocery = of(demosA, 'grocery'), books = of(demosA, 'books'), salon = of(demosA, 'salon');
  const location = async (business) => one('SELECT id FROM business_locations WHERE business_id=$1 ORDER BY id LIMIT 1', [business.id]);
  for (const business of [grocery, books]) {
    const sku = await a('POST', root(business, 'catalog'), { name: 'Placeholder item', code: 'DEMO-001', kind: 'goods', unit: 'each', tracking: 'quantity', price: '50' }, 201);
    const supplier = await a('POST', root(business, 'contacts'), { kind: 'supplier', name: 'Demo supplier (fictional)' }, 201);
    await a('POST', root(business, 'documents'), { kind: 'purchase', locationId: (await location(business)).id, contactId: supplier.id, requestKey: key(), notes: 'Synthetic development opening receipt',
      lines: [{ skuId: sku.id, quantity: '5', unitPrice: '30' }] }, 201);
  }
  await a('POST', root(salon, 'catalog'), { name: 'Haircut', code: 'DEMO-001', kind: 'service', unit: 'service', tracking: 'none', price: '350' }, 201);
  const godaanIsbn = ean13('978935000003');
  await a('POST', root(books, 'catalog'), { name: 'Godaan (Hindi classic, paperback)', code: 'BK-GOD', barcode: godaanIsbn, kind: 'goods', unit: 'each', tracking: 'quantity', price: '175' }, 201);
  const mine = await a('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'My own regular', phone: '90000 11111' }, 201);
  const snapshot = async (userId) => rows(`SELECT b.id,b.name,
    (SELECT count(*)::int FROM catalog_skus x WHERE x.business_id=b.id) AS items,(SELECT count(*)::int FROM business_contacts x WHERE x.business_id=b.id) AS contacts,
    (SELECT count(*)::int FROM business_documents x WHERE x.business_id=b.id) AS documents,(SELECT count(*)::int FROM business_payments x WHERE x.business_id=b.id) AS payments,
    (SELECT count(*)::int FROM business_collections x WHERE x.business_id=b.id) AS collections,(SELECT count(*)::int FROM business_appointments x WHERE x.business_id=b.id) AS appointments,
    (SELECT count(*)::int FROM retail_offers x WHERE x.business_id=b.id) AS offers,(SELECT count(*)::int FROM retail_loyalty_entries x WHERE x.business_id=b.id) AS points,
    (SELECT count(*)::int FROM wholesale_orders x WHERE x.business_id=b.id) AS orders,(SELECT count(*)::int FROM electronics_repair_jobs x WHERE x.business_id=b.id) AS repairs,
    (SELECT count(*)::int FROM business_exchanges x WHERE x.business_id=b.id) AS exchanges,(SELECT count(*)::int FROM salon_client_plans x WHERE x.business_id=b.id) AS plans,
    (SELECT count(*)::int FROM weight_processing_batches x WHERE x.business_id=b.id) AS batches,(SELECT count(*)::int FROM weight_wastage_entries x WHERE x.business_id=b.id) AS wastage,
    (SELECT count(*)::int FROM business_documents x WHERE x.business_id=b.id AND x.kind='sale') AS sales,b.business_type
    FROM businesses b WHERE b.created_by=$1 AND b.is_demo ORDER BY b.id`, [userId]);
  const otherBefore = await snapshot(ownerB.id);
  const ownBefore = await one('SELECT * FROM business_contacts WHERE id=$1', [mine.id]);

  await t.test('H1: demo sample data from the placeholder / half-written state, twice, with nothing duplicated', async () => {
    await runScript(database, ownerA.id);
    const first = await snapshot(ownerA.id);
    await runScript(database, ownerA.id);
    const second = await snapshot(ownerA.id);
    assert.deepEqual(second, first, 'the second run adds nothing');
    for (const demo of second) assert.ok(demo.sales > 0, `${demo.business_type} has sample sales`);
    const g = second.find((x) => x.business_type === 'grocery');
    assert.ok(g.offers >= 4 && g.points > 0 && g.collections > 0, JSON.stringify(g));
    assert.ok(second.find((x) => x.business_type === 'wholesale').orders >= 9);
    assert.ok(second.find((x) => x.business_type === 'electronics').repairs >= 5);
    assert.ok(second.find((x) => x.business_type === 'salon').plans >= 3);
    assert.ok(second.find((x) => x.business_type === 'meat').batches > 0 && second.find((x) => x.business_type === 'meat').wastage > 0);
    // Natural keys are never duplicated.
    const dupes = await one(`SELECT
      (SELECT count(*)::int FROM (SELECT business_id,kind,name FROM business_contacts GROUP BY 1,2,3 HAVING count(*)>1) z) AS contacts,
      (SELECT count(*)::int FROM (SELECT business_id,lower(name) FROM catalog_categories GROUP BY 1,2 HAVING count(*)>1) z) AS categories,
      (SELECT count(*)::int FROM (SELECT business_id,name FROM retail_offers GROUP BY 1,2 HAVING count(*)>1) z) AS offers,
      (SELECT count(*)::int FROM (SELECT business_id,isbn FROM books_titles WHERE isbn IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) z) AS isbns`);
    assert.deepEqual(dupes, { contacts: 0, categories: 0, offers: 0, isbns: 0 });
    // The half-written book was found by its code and kept its ISBN barcode.
    assert.equal((await one("SELECT count(*)::int AS n FROM catalog_skus WHERE business_id=$1 AND barcode=$2", [books.id, godaanIsbn])).n, 1);
    // The tester's own customer is untouched and unused; the other person's demos too.
    assert.deepEqual(await one('SELECT * FROM business_contacts WHERE id=$1', [mine.id]), ownBefore);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_documents WHERE contact_id=$1', [mine.id])).n, 0);
    assert.deepEqual(await snapshot(ownerB.id), otherBefore);
    // L5: sample batch codes keep the whole item code.
    const cut = await rows('SELECT DISTINCT lot_code FROM business_stock_lots WHERE business_id = ANY($1::bigint[]) AND lot_code<>\'\'', [demosA.map((x) => x.id)]);
    assert.ok(cut.length > 0 && cut.every((l) => !l.lot_code.endsWith('-')), cut.map((l) => l.lot_code).join(', '));
    assert.ok(cut.some((l) => /^B\d{4}-CH-CUR$/.test(l.lot_code)), 'meat batch named after the whole item code');
  });

  // --- Salon: one booking per bill line, statuses only when they can be true --------------------

  const sku = async (business, code) => one('SELECT id FROM catalog_skus WHERE business_id=$1 AND code=$2', [business.id, code]);
  const resource = async (business, name) => one('SELECT id FROM business_resources WHERE business_id=$1 AND name=$2', [business.id, name]);
  const contact = async (business, name) => one("SELECT id FROM business_contacts WHERE business_id=$1 AND kind='customer' AND name=$2", [business.id, name]);
  const at = async (days, hhmm) => (await one(`SELECT ((((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text || ' ' || $2)::timestamp AT TIME ZONE 'Asia/Kolkata') AS t`, [days, hhmm])).t.toISOString();

  await t.test('M4: a booking still to come cannot be a no-show, nor done before its day', async () => {
    const lakshmi = await contact(salon, 'Lakshmi Iyer');
    const booking = await a('POST', root(salon, 'salon/appointments'), { contactId: lakshmi.id, skuId: (await sku(salon, 'SV-CUT')).id, resourceId: (await resource(salon, 'Arjun')).id,
      startsAt: await at(1, '13:00'), requestKey: key(), deposit: { amount: '100', method: 'upi' } }, 201);
    const refused = await call('POST', root(salon, `salon/appointments/${booking.id}/status`), { status: 'no_show', requestKey: key() }, await login('final-a@test.invalid'));
    assert.equal(refused.status, 409);
    assert.match(refused.body.message || refused.body.error?.message || JSON.stringify(refused.body), /not started yet/);
    await a('PATCH', root(salon, `appointments/${booking.id}`), { status: 'no_show' }, 409);
    await a('PATCH', root(salon, `appointments/${booking.id}`), { status: 'completed' }, 409);
    assert.equal((await one('SELECT status FROM business_appointments WHERE id=$1', [booking.id])).status, 'booked');
    assert.equal((await one('SELECT fee_document_id FROM salon_appointment_details WHERE appointment_id=$1', [booking.id])).fee_document_id, null, 'no charge taken from the deposit');
    await a('POST', root(salon, `salon/appointments/${booking.id}/status`), { status: 'cancelled', requestKey: key() });
    // The sample's own no-show was booked in the past, so it was allowed.
    assert.ok((await one("SELECT count(*)::int AS n FROM business_appointments WHERE business_id=$1 AND status='no_show' AND starts_at<=now()", [salon.id])).n >= 1);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_appointments WHERE business_id=$1 AND status='no_show' AND starts_at>now()", [salon.id])).n, 0);

    // The generic appointments (a clinic) follow the same rule.
    const clinic = of(demosA, 'healthcare');
    const doctor = await resource(clinic, 'Dr. Karan Shah');
    const patient = await contact(clinic, 'Mohammed Irfan');
    const consult = (await sku(clinic, 'CN-GEN')).id;
    const later = new Date(Date.now() + 2 * 86400000);
    const future = await a('POST', root(clinic, 'appointments'), { contactId: patient.id, skuId: consult, resourceId: doctor.id, startsAt: later.toISOString(), endsAt: new Date(later.getTime() + 1800000).toISOString() }, 201);
    await a('PATCH', root(clinic, `appointments/${future.id}`), { status: 'no_show' }, 409);
    await a('PATCH', root(clinic, `appointments/${future.id}`), { status: 'completed' }, 409);
    const earlier = new Date(Date.now() - 6 * 3600000);
    const past = await a('POST', root(clinic, 'appointments'), { contactId: patient.id, skuId: consult, resourceId: doctor.id, startsAt: earlier.toISOString(), endsAt: new Date(earlier.getTime() + 1800000).toISOString() }, 201);
    assert.equal((await a('PATCH', root(clinic, `appointments/${past.id}`), { status: 'no_show' })).status, 'no_show');
  });

  await t.test('M3: one booking goes on one bill line, once', async () => {
    const ananya = await contact(salon, 'Ananya Sharma');
    const spa = (await sku(salon, 'SV-SPA')).id;
    const arjun = (await resource(salon, 'Arjun')).id;
    let booking = null;
    for (let h = 9; h <= 19 && !booking; h += 1) {
      const result = await call('POST', root(salon, 'salon/appointments'), { contactId: ananya.id, skuId: spa, resourceId: arjun, startsAt: await at(0, `${String(h).padStart(2, '0')}:00`), requestKey: key() },
        await login('final-a@test.invalid'));
      if (result.status === 201) booking = result.body.data;
    }
    assert.ok(booking, 'a free slot today');
    const pkg = await one("SELECT id FROM salon_client_plans WHERE business_id=$1 AND contact_id=$2 AND kind='package' ORDER BY id LIMIT 1", [salon.id, ananya.id]);
    const line = { skuId: spa, quantity: '1', staffId: arjun, appointmentId: booking.id, ...(pkg ? { clientPlanId: pkg.id } : {}) };
    const loc = (await location(salon)).id;
    const twice = await call('POST', root(salon, 'salon/bills'), { locationId: loc, contactId: ananya.id, lines: [line, line], appointmentIds: [booking.id], requestKey: key() }, await login('final-a@test.invalid'));
    assert.equal(twice.status, 409, JSON.stringify(twice.body));
    assert.match(JSON.stringify(twice.body), /already on this bill/);
    const usedBefore = pkg ? (await one('SELECT COALESCE(sum(quantity),0)::int AS n FROM salon_package_redemptions WHERE client_plan_id=$1', [pkg.id])).n : 0;
    await a('POST', root(salon, 'salon/bills'), { locationId: loc, contactId: ananya.id, lines: [line], appointmentIds: [booking.id], requestKey: key() }, 201);
    if (pkg) assert.equal((await one('SELECT COALESCE(sum(quantity),0)::int AS n FROM salon_package_redemptions WHERE client_plan_id=$1', [pkg.id])).n, usedBefore + 1, 'one package session used');
    const again = await call('POST', root(salon, 'salon/bills'), { locationId: loc, contactId: ananya.id, lines: [line], requestKey: key() }, await login('final-a@test.invalid'));
    assert.equal(again.status, 409);
    assert.match(JSON.stringify(again.body), /already been billed/);
  });

  // --- Overview figures ----------------------------------------------------------------------

  await t.test('M1 and M2: overview owed is the receivables balance; sales are net of returns', async () => {
    const shop = of(demosB, 'wholesale');
    const loc = (await location(shop)).id;
    const zero = await one('SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=0 ORDER BY id LIMIT 1', [shop.id]);
    const item = await b('POST', root(shop, 'catalog'), { name: 'Test carton', code: 'T-CTN', kind: 'goods', unit: 'each', tracking: 'quantity', price: '100', ...(zero ? { taxRateId: zero.id } : {}) }, 201);
    const supplier = await b('POST', root(shop, 'contacts'), { kind: 'supplier', name: 'Test supplier' }, 201);
    await b('POST', root(shop, 'documents'), { kind: 'purchase', locationId: loc, contactId: supplier.id, requestKey: key(), lines: [{ skuId: item.id, quantity: '20', unitPrice: '60' }] }, 201);
    const owing = await b('POST', root(shop, 'contacts'), { kind: 'customer', name: 'Owes from before', openingBalance: '500', openingBalanceOn: today }, 201);
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

  await t.test('L6: people who already have access are not offered again', async () => {
    const staff = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerA.restaurant_id, 'Counter Staff', 'counter-final@test.invalid', hash]);
    const shop = of(demosA, 'grocery');
    const before = await a('GET', root(shop, 'member-candidates'));
    assert.ok(before.some((u) => Number(u.id) === Number(staff.id)));
    assert.ok(!before.some((u) => Number(u.id) === Number(ownerA.id)), 'the owner already has access');
    const role = (await a('GET', `${root(shop, 'roles')}?active=true&limit=50`)).items.find((r) => !r.full_access);
    await a('POST', root(shop, 'members'), { userId: staff.id, roleId: role.id }, 201);
    const after = await a('GET', root(shop, 'member-candidates'));
    assert.ok(!after.some((u) => Number(u.id) === Number(staff.id)));
  });

  await t.test('L3: a screen of another business type is refused by the page guard', async () => {
    const nav = await import(pathToFileURL(path.resolve(__dirname, '../../../frontend/src/services/businessNav.js')).href);
    assert.equal(nav.typeAllows(nav.sectionRule('counter', 'salon'), 'salon'), false);
    assert.equal(nav.typeAllows(nav.sectionRule('counter', 'grocery'), 'grocery'), true);
    assert.equal(nav.typeAllows(nav.sectionRule('salon-bill', 'grocery'), 'grocery'), false);
    assert.equal(nav.typeAllows(nav.sectionRule('outstanding', 'grocery'), 'grocery'), false);
    assert.equal(nav.typeAllows(nav.sectionRule('sales', 'salon'), 'salon'), true);
  });
});
