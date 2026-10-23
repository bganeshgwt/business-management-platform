const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom, momentAt, zoneWithHour } = require('./helpers/dates');

// Salon & spa (service times, stylist skills, rooms, the
// calendar with deposits and the no-show / late-cancel rule, packages,
// memberships, the mixed bill, staff commissions) and weight-based shops
// (sales by weight, cutting with yield and cost sharing, yield templates,
// daily wastage, stock by weight, yield and wastage reports). Runs against
// its own throwaway database with every migration applied.
test('salon & spa and weight-based shops', { timeout: 300000 }, async (t) => {
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
  const password = `SalonWeight-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('salon-owner');
  await owner('salon-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const request = as(await login('salon-owner@test.invalid'));
  const other = as(await login('salon-other@test.invalid'));
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);

  const [salon, meat, dry, grocery] = await createBusinesses(request, 'OWNER', ['salon', 'meat', 'weight_retail', 'grocery']);
  const [otherSalon, otherMeat] = await createBusinesses(other, 'OTHER', ['salon', 'meat']);
  // Goods shops start with prices including GST, rounded to the rupee, and a
  // walk-in pays in full. These checks use prices before GST and post unpaid
  // walk-in bills as fixtures.
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const S = (suffix) => `/businesses/${salon.id}/${suffix}`;
  const M = (suffix) => `/businesses/${meat.id}/${suffix}`;

  await t.test('specialist modules start optional and owners enable the workflows they use', async () => {
    assert.ok(!salon.capabilities.includes('packages') && !salon.capabilities.includes('commissions'));
    for (const shop of [meat, dry]) assert.ok(!shop.capabilities.includes('processing') && shop.capabilities.includes('wastage'));
    for (const code of ['packages','commissions']) await request('PUT', S(`modules/${code}`), {enabled:true});
    for (const shop of [meat,dry]) await request('PUT', `/businesses/${shop.id}/modules/processing`, {enabled:true});
    for (const code of ['packages','commissions']) await other('PUT', `/businesses/${otherSalon.id}/modules/${code}`, {enabled:true});
    await other('PUT', `/businesses/${otherMeat.id}/modules/processing`, {enabled:true});
    assert.ok(!grocery.capabilities.includes('wastage') && !grocery.capabilities.includes('processing'));
    await request('PUT', `/businesses/${grocery.id}/modules/processing`, { enabled: true }, 409);
    await request('GET', `/businesses/${grocery.id}/weight/processing`, undefined, 403);
    await request('PUT', `/businesses/${grocery.id}/modules/wastage`, { enabled: true });
    await request('GET', `/businesses/${grocery.id}/weight/wastage`);
    await request('PUT', `/businesses/${grocery.id}/modules/wastage`, { enabled: false });
    await request('GET', `/businesses/${meat.id}/salon/calendar?date=2026-10-06`, undefined, 403);
    await request('GET', S('salon/plans'));
    // A salon's commissions need appointments; switching appointments off is refused while they are on.
    await request('PUT', S('modules/appointments'), { enabled: false }, 409);
    const viewer = await one(`SELECT array_agg(permission_code ORDER BY permission_code) AS p FROM business_role_permissions rp JOIN business_roles r ON r.id=rp.role_id
      WHERE r.business_id=$1 AND r.template_code='viewer' AND (permission_code LIKE 'packages.%' OR permission_code LIKE 'commissions.%')`, [salon.id]);
    assert.deepEqual(viewer.p, ['commissions.export', 'commissions.view', 'packages.export', 'packages.view']);
    const kinds = await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'");
    for (const kind of ['sales_order', 'collection', 'repair_job', 'processing']) assert.ok(kinds.d.includes(`'${kind}'`), kind);
  });

  // Staff with each template role in the salon and the meat shop.
  const staff = { salon: {}, meat: {} };
  for (const [type, business] of [['salon', salon], ['meat', meat]]) {
    const roles = (await request('GET', `/businesses/${business.id}/roles`)).items;
    for (const template of ['cashier', 'stock_keeper', 'viewer']) {
      const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, `${type} ${template}`, `${type}-${template}@test.invalid`, hash]);
      await request('POST', `/businesses/${business.id}/members`, { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
      staff[type][template] = as(await login(`${type}-${template}@test.invalid`));
    }
  }

  // --- Salon ----------------------------------------------------------------------------------
  const loc = (await request('GET', S('locations'))).items[0];
  const slab = (await request('GET', S('tax-rates'))).items.find((r) => Number(r.rate) === 18);
  const service = (name, code, price) => request('POST', S('catalog'), { name, code, kind: 'service', unit: 'service', tracking: 'none', price, taxRateId: slab.id }, 201);
  const cut = await service('Haircut', 'CUT', '400');
  const spa = await service('Hair spa', 'SPA', '1200');
  const facial = await service('Facial', 'FAC', '1500');
  const shampoo = await request('POST', S('catalog'), { name: 'Shampoo', code: 'SHA', kind: 'goods', unit: 'each', tracking: 'quantity', price: '500', taxRateId: slab.id }, 201);
  const supplier = await request('POST', S('contacts'), { kind: 'supplier', name: 'Beauty Depot' }, 201);
  await request('POST', S('documents'), { kind: 'purchase', locationId: loc.id, contactId: supplier.id, requestKey: key(), lines: [{ skuId: shampoo.id, quantity: '10', unitPrice: '300' }] }, 201);
  const priya = await request('POST', S('resources'), { name: 'Priya', roleLabel: 'Senior stylist', locationId: loc.id }, 201);
  const arjun = await request('POST', S('resources'), { name: 'Arjun', locationId: loc.id }, 201);
  const room = await request('POST', S('resources'), { name: 'Spa room', locationId: loc.id }, 201);
  const ananya = await request('POST', S('contacts'), { kind: 'customer', name: 'Ananya' }, 201);
  const ravi = await request('POST', S('contacts'), { kind: 'customer', name: 'Ravi' }, 201);
  // The salon's clock is made, not waited for: a late cancellation is booked an
  // hour from now inside its 09:00–21:00 hours, so the salon keeps a time zone
  // where it is between 10:00 and 16:00 whenever the suite runs (India's while
  // its hour allows it). Its dates and times are read on that clock; the weight
  // shops stay on India's.
  const zone = zoneWithHour(10, 15);
  await pool.query('UPDATE businesses SET timezone=$2 WHERE id=$1', [salon.id, zone]);
  // Bookings are made on a day 10 days ahead, at 10:00 business time.
  const ahead = { d: daysFrom(10, zone) };
  const at = (hhmm, day = ahead.d) => momentAt(day, hhmm, zone);
  // The day of a booking has come: its start moves to `minutes` ago (a no-show
  // is allowed only after the start, and a booking is done or billed on its day).
  const arrive = async (appointmentId, minutes = 60) => pool.query(`UPDATE business_appointments SET ends_at=now()-($2::int * interval '1 minute')+(ends_at-starts_at),
    starts_at=now()-($2::int * interval '1 minute') WHERE id=$1`, [appointmentId, minutes]);

  await t.test('service times, skills and rooms shape a booking', async () => {
    await request('PUT', S(`salon/services/${cut.id}`), { durationMinutes: 45, bufferMinutes: 15 });
    await request('PUT', S(`salon/services/${facial.id}`), { durationMinutes: 60, bufferMinutes: 0, needsRoom: true });
    await request('PUT', S(`salon/services/${shampoo.id}`), { durationMinutes: 30 }, 404);
    await request('PUT', S(`salon/staff/${arjun.id}`), { kind: 'staff', skuIds: [cut.id] });
    await request('PUT', S(`salon/staff/${room.id}`), { kind: 'room', skuIds: [] });
    await request('PUT', S(`salon/staff/${room.id}`), { kind: 'room', skuIds: [cut.id] }, 400);
    // Arjun does haircuts only.
    await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: spa.id, resourceId: arjun.id, startsAt: at('10:00'), requestKey: key() }, 409);
    // A facial needs a room; a room is not a stylist.
    await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: facial.id, resourceId: priya.id, startsAt: at('10:00'), requestKey: key() }, 400);
    await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: room.id, startsAt: at('10:00'), requestKey: key() }, 404);
    // Outside the salon's hours (09:00–21:00 by default).
    await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('20:30'), requestKey: key() }, 400);
    const booking = await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('10:00'), requestKey: key() }, 201);
    // Haircut 45 min + 15 clean-up: Arjun is busy until 11:00.
    assert.equal(new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime(), 60 * 60000);
    await request('POST', S('salon/appointments'), { contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('10:50'), requestKey: key() }, 409);
    await request('POST', S('salon/appointments'), { contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('11:00'), requestKey: key() }, 201);
    // The room cannot hold two facials at once, even with two stylists.
    await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: facial.id, resourceId: priya.id, roomId: room.id, startsAt: at('14:00'), requestKey: key() }, 201);
    await request('PUT', S(`salon/staff/${arjun.id}`), { kind: 'staff', skuIds: [cut.id, facial.id] });
    await request('POST', S('salon/appointments'), { contactId: ravi.id, skuId: facial.id, resourceId: arjun.id, roomId: room.id, startsAt: at('14:30'), requestKey: key() }, 409);
    // The generic appointment endpoints run the same salon rules.
    await request('POST', S('appointments'), { contactId: ananya.id, skuId: spa.id, resourceId: arjun.id, startsAt: at('12:00'), endsAt: at('13:00') }, 409);
    await request('POST', S('appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: room.id, startsAt: at('12:00'), endsAt: at('13:00') }, 404);
    await request('POST', S('appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('06:00'), endsAt: at('07:00') }, 400);
    await request('POST', S('appointments'), { contactId: ananya.id, skuId: facial.id, resourceId: priya.id, startsAt: at('12:00'), endsAt: at('13:00') }, 400);
    const generic = await request('POST', S('appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('12:00'), endsAt: at('12:30') }, 201);
    assert.equal(new Date(generic.ends_at).getTime() - new Date(generic.starts_at).getTime(), 60 * 60000, 'service time + clean-up, not the time sent');
    await request('PATCH', S(`appointments/${generic.id}`), { status: 'cancelled' });
    const day = await request('GET', S(`salon/calendar?date=${ahead.d}`));
    assert.equal(day.appointments.length, 4);
    assert.deepEqual(day.resources.map((r) => r.kind), ['staff', 'staff', 'room']);
  });

  let deposited;
  await t.test('deposits are advances; no-show and late-cancel charges come only out of the deposit', async () => {
    await request('PUT', S('salon/settings'), { depositPercent: '25', freeCancelHours: 4, lateCancelFeePercent: '50', noShowFeePercent: '100', opensAt: '09:00', closesAt: '21:00' });
    const requestKey = key();
    const body = { contactId: ravi.id, skuId: spa.id, resourceId: priya.id, startsAt: at('16:00'), requestKey, deposit: { amount: '300', method: 'upi' } };
    deposited = await request('POST', S('salon/appointments'), body, 201);
    assert.match(deposited.deposit_no, /^RC\//);
    // The same request again returns the same booking; different content is refused.
    assert.equal((await request('POST', S('salon/appointments'), body, 201)).id, deposited.id);
    await request('POST', S('salon/appointments'), { ...body, startsAt: at('17:00') }, 409);
    const collection = await one('SELECT * FROM business_collections WHERE business_id=$1 AND id=$2', [salon.id, deposited.deposit_collection_id]);
    assert.equal(collection.amount, '300.00');
    const balance = (await request('GET', S('contacts?kind=customer'))).items.find((c) => c.id === ravi.id).balance;
    assert.equal(Number(balance), -300, 'a deposit is the client\'s advance');
    // Cancelling 10 days ahead is free: the deposit stays as advance.
    const early = await request('GET', S(`salon/appointments/${deposited.id}/fee?status=cancelled`));
    assert.equal(early.fee, '0.00');
    // A no-show keeps 100% of the ₹1,200 price — but never more than the ₹300 deposit.
    const noShowKey = key();
    // Ten days ahead it cannot be a no-show yet; once its time has passed, it can.
    await request('POST', S(`salon/appointments/${deposited.id}/status`), { status: 'no_show', requestKey: key() }, 409);
    await arrive(deposited.id);
    const result = await request('POST', S(`salon/appointments/${deposited.id}/status`), { status: 'no_show', requestKey: noShowKey });
    assert.equal(result.fee.total, '300.00');
    assert.equal(result.fee.percent, 100);
    const fee = await one('SELECT * FROM business_documents WHERE business_id=$1 AND id=$2', [salon.id, result.fee.documentId]);
    assert.equal(paise(fee.subtotal) + paise(fee.tax), 30000, 'the fee includes its GST');
    const paid = await one('SELECT sum(amount) AS s, max(collection_id) AS k FROM business_payments WHERE business_id=$1 AND document_id=$2', [salon.id, fee.id]);
    assert.equal(paid.s, '300.00');
    assert.equal(Number(paid.k), deposited.deposit_collection_id);
    // Repeating the request does nothing more.
    assert.ok((await request('POST', S(`salon/appointments/${deposited.id}/status`), { status: 'no_show', requestKey: noShowKey })).repeated);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND notes LIKE $2', [salon.id, 'No-show%'])).n, 1);
    // The generic Appointments screen's No-show applies the same rule.
    const viaList = await request('POST', S('salon/appointments'), { contactId: ravi.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('19:00'), requestKey: key(), deposit: { amount: '100', method: 'upi' } }, 201);
    await request('PATCH', S(`appointments/${viaList.id}`), { status: 'no_show' }, 409);
    await arrive(viaList.id, 30);
    const patched = await request('PATCH', S(`appointments/${viaList.id}`), { status: 'no_show' });
    assert.equal(patched.status, 'no_show');
    assert.equal(patched.fee.total, '100.00', '100% of ₹400, capped at the ₹100 deposit');
    // Late cancellation (within 4 hours of the start): 50% of ₹400, out of a ₹500 deposit. An hour
    // from now is inside the salon's hours on its clock.
    const late = await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: priya.id,
      startsAt: new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000).toISOString(), requestKey: key(), deposit: { amount: '500', method: 'cash' } }, 201);
    const charged = await request('POST', S(`salon/appointments/${late.id}/status`), { status: 'cancelled', requestKey: key() });
    assert.equal(charged.fee.total, '200.00');
    const left = await one(`SELECT k.amount - COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.collection_id=k.id),0) AS free FROM business_collections k WHERE k.id=$1`, [late.deposit_collection_id]);
    assert.equal(left.free, '300.00', 'the rest of the deposit stays as advance');
    const events = await rows("SELECT kind FROM business_events WHERE business_id=$1 AND entity_type='appointment' AND entity_id=$2 ORDER BY id", [salon.id, deposited.id]);
    assert.deepEqual(events.map((e) => e.kind), ['appointment.booked', 'appointment.no_show']);
  });

  let pkgPlan, goldPlan, ananyaPackage;
  const bill = (body, expected = 201, who = request) => who('POST', S('salon/bills'), { locationId: loc.id, requestKey: key(), ...body }, expected);
  await t.test('packages and memberships: sold on a bill, then used on later bills', async () => {
    pkgPlan = await request('POST', S('salon/plans'), { kind: 'package', name: 'Spa × 3', price: '3000', validityDays: 90, services: [{ skuId: spa.id, sessions: 3 }] }, 201);
    goldPlan = await request('POST', S('salon/plans'), { kind: 'membership', name: 'Gold', price: '2000', validityDays: 365, serviceDiscountPercent: '20', productDiscountPercent: '10' }, 201);
    await request('POST', S('salon/plans'), { kind: 'membership', name: 'Nothing off', price: '10', validityDays: 30, serviceDiscountPercent: '0', productDiscountPercent: '0' }, 400);
    await request('POST', S('salon/plans'), { kind: 'package', name: 'Bad', price: '10', validityDays: 30, services: [{ skuId: shampoo.id, sessions: 2 }] }, 404);
    await staff.salon.cashier('POST', S('salon/plans'), { kind: 'package', name: 'X', price: '1', validityDays: 1, services: [{ skuId: cut.id, sessions: 1 }] }, 403);
    // A plan needs the client, one per line.
    await bill({ lines: [{ skuId: pkgPlan.sku_id, quantity: '1' }], payment: { amount: '3540', method: 'upi' } }, 400);
    await bill({ contactId: ananya.id, lines: [{ skuId: pkgPlan.sku_id, quantity: '2' }] }, 400);
    const sold = await bill({ contactId: ananya.id, lines: [{ skuId: pkgPlan.sku_id, quantity: '1', staffId: priya.id }], payment: { amount: '3540', method: 'upi' } });
    assert.equal(sold.document.total, '3540.00');
    ananyaPackage = await one('SELECT * FROM salon_client_plans WHERE business_id=$1 AND contact_id=$2 AND kind=$3', [salon.id, ananya.id, 'package']);
    assert.equal(ananyaPackage.price, '3540.00');
    const days = await one("SELECT ($1::date - $2::date) AS n", [ananyaPackage.ends_on, ananyaPackage.starts_on]);
    assert.equal(days.n, 89, 'valid for 90 days including the first');
    // A session paid from the package: the whole line comes off, no GST.
    const quote = await request('POST', S('salon/quote'), { locationId: loc.id, contactId: ananya.id, lines: [{ skuId: spa.id, quantity: '1', staffId: priya.id, clientPlanId: ananyaPackage.id }] });
    assert.equal(quote.total, '0.00');
    assert.equal(quote.lines[0].offers[0].source, 'package');
    const used = await bill({ contactId: ananya.id, lines: [{ skuId: spa.id, quantity: '2', staffId: priya.id, clientPlanId: ananyaPackage.id }] });
    assert.equal(used.document.total, '0.00');
    // One session left: two more are refused, before anything is saved.
    await bill({ contactId: ananya.id, lines: [{ skuId: spa.id, quantity: '2', clientPlanId: ananyaPackage.id }] }, 409);
    await bill({ contactId: ananya.id, lines: [{ skuId: spa.id, quantity: '1', clientPlanId: ananyaPackage.id }, { skuId: spa.id, quantity: '1', clientPlanId: ananyaPackage.id }] }, 409);
    // Not Ravi's package; not a service in it.
    await bill({ contactId: ravi.id, lines: [{ skuId: spa.id, quantity: '1', clientPlanId: ananyaPackage.id }] }, 404);
    await bill({ contactId: ananya.id, lines: [{ skuId: cut.id, quantity: '1', clientPlanId: ananyaPackage.id }] }, 409);
    const holding = (await request('GET', S(`salon/client-plans?contact=${ananya.id}`))).items[0];
    assert.equal(holding.sessions_used, 2);
    assert.equal(holding.state, 'active');
    // The redemption cannot be inserted past the sessions bought, even directly.
    const charged = await bill({ contactId: ananya.id, lines: [{ skuId: spa.id, quantity: '1' }] });
    const chargedLine = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [charged.document.id]);
    await assert.rejects(pool.query(`INSERT INTO salon_package_redemptions(business_id,client_plan_id,sku_id,quantity,document_id,line_id,created_by)
      VALUES($1,$2,$3,2,$4,$5,$6)`, [salon.id, ananyaPackage.id, spa.id, charged.document.id, chargedLine.id, ownerUser.id]), /no sessions/);
    // An expired package cannot be used (moved back in time outside the API).
    const move = async (days) => {
      await pool.query('ALTER TABLE salon_client_plans DISABLE TRIGGER salon_client_plans_fixed');
      try {
        await pool.query(`UPDATE salon_client_plans SET starts_on=(now() AT TIME ZONE $3)::date+$2::int-30,ends_on=(now() AT TIME ZONE $3)::date+$2::int WHERE id=$1`, [ananyaPackage.id, days, zone]);
      } finally {
        await pool.query('ALTER TABLE salon_client_plans ENABLE TRIGGER salon_client_plans_fixed');
      }
    };
    await move(-1);
    await bill({ contactId: ananya.id, lines: [{ skuId: spa.id, quantity: '1', clientPlanId: ananyaPackage.id }] }, 409);
    await move(60);

    // Gold membership: 20% off services, 10% off products, applied by itself.
    // With the module off a plan's item is not sold as a plain service.
    await request('PUT', S('modules/packages'), { enabled: false });
    await bill({ contactId: ravi.id, lines: [{ skuId: goldPlan.sku_id, quantity: '1' }], payment: { amount: '2360', method: 'card' } }, 409);
    await request('POST', S('documents'), { kind: 'sale', locationId: loc.id, contactId: ravi.id, requestKey: key(), lines: [{ skuId: goldPlan.sku_id, quantity: '1' }] }, 409);
    await request('PUT', S('modules/packages'), { enabled: true });
    await bill({ contactId: ravi.id, lines: [{ skuId: goldPlan.sku_id, quantity: '1' }], payment: { amount: '2360', method: 'card' } });
    const member = await bill({ contactId: ravi.id, lines: [{ skuId: cut.id, quantity: '1', staffId: arjun.id }, { skuId: shampoo.id, quantity: '2', staffId: arjun.id }] });
    const doc = await request('GET', S(`documents/${member.document.id}`));
    const discounts = doc.retail.discounts;
    assert.deepEqual(discounts.map((d) => [d.source, d.amount]), [['membership', '80.00'], ['membership', '100.00']]);
    // The line's price less its discounts is its taxable value; GST on what is left.
    for (const l of doc.lines) {
      const off = discounts.filter((d) => d.line_id === l.id).reduce((s, d) => s + paise(d.amount), 0);
      assert.equal(Math.round(paise(l.unit_price) * Number(l.quantity)) - off, paise(l.net));
      assert.equal(paise(l.tax), Math.round(paise(l.net) * 0.18));
    }
    assert.equal(member.document.total, '1439.60', '(400 - 80) + (1000 - 100), plus 18% GST');
    // A quote is the posting.
    const again = await request('POST', S('salon/quote'), { locationId: loc.id, contactId: ravi.id, lines: [{ skuId: cut.id, quantity: '1', staffId: arjun.id }, { skuId: shampoo.id, quantity: '2' }] });
    assert.equal(again.total, member.document.total);
    assert.equal((await one('SELECT count(*)::int AS n FROM salon_membership_uses WHERE business_id=$1', [salon.id])).n, 2);
  });

  await t.test('a used plan cannot be cancelled; its sale line is returned only after cancelling', async () => {
    await request('POST', S(`salon/client-plans/${ananyaPackage.id}/cancel`), { reason: 'Changed mind' }, 409);
    const fresh = await bill({ contactId: ananya.id, lines: [{ skuId: pkgPlan.sku_id, quantity: '1' }], payment: { amount: '3540', method: 'upi' } });
    const detail = await request('GET', S(`documents/${fresh.document.id}`));
    const line = detail.lines[0];
    await request('POST', S(`documents/${fresh.document.id}/returns`), { reason: 'Refund', requestKey: key(), lines: [{ lineId: line.id, quantity: '1', restock: false }] }, 409);
    const held = await one('SELECT id FROM salon_client_plans WHERE business_id=$1 AND line_id=$2', [salon.id, line.id]);
    await staff.salon.cashier('POST', S(`salon/client-plans/${held.id}/cancel`), { reason: 'x' }, 403);
    await request('POST', S(`salon/client-plans/${held.id}/cancel`), { reason: 'Client moved city' });
    await request('POST', S(`documents/${fresh.document.id}/returns`), { reason: 'Refund', requestKey: key(), lines: [{ lineId: line.id, quantity: '1', restock: false }] }, 201);
    await assert.rejects(pool.query("UPDATE salon_client_plans SET status='active',cancelled_at=NULL,cancelled_by=NULL,cancel_reason=NULL WHERE id=$1", [held.id]), /fixed/);
  });

  await t.test('the bill: deposits put against it, bookings marked done, commission by the most specific rule', async () => {
    await staff.salon.stock_keeper('GET', S('salon/commissions?from=2026-01-01&to=2026-12-31'), undefined, 403);
    await request('POST', S('salon/commission-rules'), { appliesTo: 'service', percent: '10' }, 201);
    await request('POST', S('salon/commission-rules'), { appliesTo: 'service', percent: '12' }, 409);
    await request('POST', S('salon/commission-rules'), { appliesTo: 'goods', percent: '5' }, 201);
    await request('POST', S('salon/commission-rules'), { resourceId: priya.id, appliesTo: 'service', percent: '15' }, 201);
    await request('POST', S('salon/commission-rules'), { resourceId: priya.id, appliesTo: 'service', skuId: facial.id, percent: '25' }, 201);
    await request('POST', S('salon/commission-rules'), { appliesTo: 'goods', skuId: cut.id, percent: '5' }, 409);
    await staff.salon.cashier('POST', S('salon/commission-rules'), { appliesTo: 'service', percent: '50' }, 403);
    const visit = await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: facial.id, resourceId: priya.id, roomId: room.id, startsAt: at('17:00'),
      requestKey: key(), deposit: { amount: '500', method: 'upi' } }, 201);
    const lines = [{ skuId: facial.id, quantity: '1', staffId: priya.id, appointmentId: visit.id }, { skuId: cut.id, quantity: '1', staffId: arjun.id }, { skuId: shampoo.id, quantity: '1', staffId: priya.id }];
    // A deposit held for a booking still to come is not used on another bill.
    const later = await request('POST', S('salon/appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('19:30'),
      requestKey: key(), deposit: { amount: '400', method: 'cash' } }, 201);
    const without = await request('POST', S('salon/quote'), { locationId: loc.id, contactId: ananya.id, lines, useAdvance: true });
    const withVisit = await request('POST', S('salon/quote'), { locationId: loc.id, contactId: ananya.id, lines, useAdvance: true, appointmentIds: [visit.id] });
    assert.equal(paise(withVisit.advance) - paise(without.advance), 50000, 'a deposit counts only when its booking is on the bill');
    const summary = await request('GET', S(`salon/clients/${ananya.id}`));
    assert.equal(summary.held, '900.00');
    const quote = withVisit;
    assert.equal(quote.total, '2832.00');
    assert.equal(paise(quote.toPay), paise(quote.total) - paise(quote.advanceUsable));
    const billBody = { locationId: loc.id, contactId: ananya.id, lines, appointmentIds: [visit.id], useAdvance: true, payment: { amount: quote.toPay, method: 'card' }, requestKey: key() };
    // A booking on a later day is billed (and so marked done) on its day.
    await staff.salon.cashier('POST', S('salon/bills'), { ...billBody, requestKey: key() }, 409);
    await arrive(visit.id, 20);
    const posted = await staff.salon.cashier('POST', S('salon/bills'), billBody, 201);
    assert.equal(posted.advanceApplied, quote.advanceUsable);
    // Repeating the request reports what the first one did.
    const again = await staff.salon.cashier('POST', S('salon/bills'), billBody, 201);
    assert.ok(again.repeated);
    assert.equal(again.document.id, posted.document.id);
    assert.equal(again.advanceApplied, posted.advanceApplied);
    const held = await one(`SELECT k.amount - COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.collection_id=k.id),0) AS free FROM business_collections k WHERE k.id=$1`, [later.deposit_collection_id]);
    assert.equal(held.free, '400.00', 'the later booking keeps its deposit');
    const pays = await rows('SELECT amount,collection_id FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [salon.id, posted.document.id]);
    assert.equal(pays.reduce((s, p) => s + paise(p.amount), 0), 283200, 'paid in full');
    assert.ok(pays.some((p) => Number(p.collection_id) === visit.deposit_collection_id));
    const appointment = await one('SELECT a.status,d.bill_document_id FROM business_appointments a JOIN salon_appointment_details d ON d.appointment_id=a.id WHERE a.id=$1', [visit.id]);
    assert.deepEqual(appointment, { status: 'completed', bill_document_id: posted.document.id });
    await bill({ contactId: ananya.id, lines: [{ skuId: cut.id, quantity: '1' }], appointmentIds: [visit.id] }, 409);
    // Facial by Priya: 25% (her facial rule); haircut by Arjun: 10% (everyone); shampoo by Priya: 5% (products).
    const staffLines = await rows(`SELECT s.label,ls.commission_percent,ls.commission_base,ls.commission_amount FROM salon_line_staff ls
      JOIN business_document_lines l ON l.id=ls.line_id JOIN catalog_skus s ON s.id=l.sku_id WHERE ls.document_id=$1 ORDER BY l.id`, [posted.document.id]);
    assert.deepEqual(staffLines.map((l) => [l.label, Number(l.commission_percent), l.commission_amount]), [['Facial', 25, '375.00'], ['Haircut', 10, '40.00'], ['Shampoo', 5, '25.00']]);
    // A return takes commission back in proportion.
    const detail = await request('GET', S(`documents/${posted.document.id}`));
    await request('POST', S(`documents/${posted.document.id}/returns`), { reason: 'Unhappy', requestKey: key(), lines: [{ lineId: detail.lines[0].id, quantity: '1', restock: false }] }, 201);
    const day = daysFrom(0, zone);
    const report = await request('GET', S(`salon/commissions?from=${day}&to=${day}`));
    const priyaRow = report.rows.find((r) => r.resource_id === priya.id);
    // Priya today: lines billed before any rule earned 0%; the facial was returned (0); the shampoo earned 5% of ₹500.
    assert.equal(priyaRow.commission, '25.00');
    const linesList = await request('GET', S(`salon/commission-lines?staff=${priya.id}&from=${day}&to=${day}`));
    assert.ok(linesList.items.some((l) => Number(l.returned_quantity) === 1 && Number(l.commission_after_returns) === 0));
    // Snapshots are append-only.
    await assert.rejects(pool.query('UPDATE salon_line_staff SET commission_amount=0 WHERE document_id=$1', [posted.document.id]), /cannot be changed/);
  });

  await t.test('salon permissions and other businesses', async () => {
    await staff.salon.viewer('POST', S('salon/appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('18:00'), requestKey: key() }, 403);
    await staff.salon.viewer('GET', S(`salon/calendar?date=${ahead.d}`));
    await staff.salon.viewer('POST', S('salon/bills'), { locationId: loc.id, lines: [{ skuId: cut.id, quantity: '1' }], requestKey: key() }, 403);
    await staff.salon.stock_keeper('PUT', S('salon/settings'), { depositPercent: '10' }, 403);
    // A cashier books and takes deposits (they record money on sales).
    await staff.salon.cashier('POST', S('salon/appointments'), { contactId: ananya.id, skuId: cut.id, resourceId: arjun.id, startsAt: at('18:00'), requestKey: key(), deposit: { amount: '100', method: 'cash' } }, 201);
    // Another owner sees none of this.
    const O = (suffix) => `/businesses/${salon.id}/${suffix}`;
    await other('GET', O(`salon/calendar?date=${ahead.d}`), undefined, 404);
    await other('POST', O('salon/bills'), { locationId: loc.id, lines: [{ skuId: cut.id, quantity: '1' }], requestKey: key() }, 404);
    // In their own salon, this salon's records do not exist.
    const theirs = (suffix) => `/businesses/${otherSalon.id}/${suffix}`;
    const theirLoc = (await other('GET', theirs('locations'))).items[0];
    const theirClient = await other('POST', theirs('contacts'), { kind: 'customer', name: 'Theirs' }, 201);
    const theirCut = await other('POST', theirs('catalog'), { name: 'Cut', code: 'CUT', kind: 'service', unit: 'service', tracking: 'none', price: '300', taxRate: '18' }, 201);
    await other('POST', theirs('salon/appointments'), { contactId: theirClient.id, skuId: theirCut.id, resourceId: priya.id, startsAt: at('10:00'), requestKey: key() }, 404);
    await other('POST', theirs('salon/bills'), { locationId: theirLoc.id, contactId: theirClient.id, lines: [{ skuId: theirCut.id, quantity: '1', clientPlanId: ananyaPackage.id }], requestKey: key() }, 404);
    await other('POST', theirs('salon/bills'), { locationId: theirLoc.id, lines: [{ skuId: theirCut.id, quantity: '1', staffId: priya.id }], requestKey: key() }, 404);
    await other('POST', theirs('salon/client-plans/' + ananyaPackage.id + '/cancel'), { reason: 'x' }, 404);
    await other('PUT', theirs(`salon/staff/${priya.id}`), { kind: 'room' }, 404);
    await other('POST', theirs('salon/commission-rules'), { resourceId: priya.id, appliesTo: 'service', percent: '5' }, 404);
    await assert.rejects(pool.query('INSERT INTO salon_staff_skills(business_id,resource_id,sku_id) VALUES($1,$2,$3)', [otherSalon.id, priya.id, theirCut.id]), /foreign key/);
  });

  // --- Weight-based shops ------------------------------------------------------------------------------
  const mloc = (await request('GET', M('locations'))).items[0];
  const nil = (await request('GET', M('tax-rates'))).items.find((r) => Number(r.rate) === 0);
  const weighed = (name, code, price, tracking = 'batch') => request('POST', M('catalog'), { name, code, kind: 'goods', unit: 'kg', tracking, price, taxRateId: nil.id }, 201);
  const whole = await weighed('Whole chicken', 'WHL', '200');
  const curry = await weighed('Curry cut', 'CUR', '260');
  const liver = await weighed('Liver', 'LVR', '180', 'quantity');
  const eggs = await request('POST', M('catalog'), { name: 'Eggs (tray)', code: 'EGG', kind: 'goods', unit: 'each', tracking: 'quantity', price: '180', taxRateId: nil.id }, 201);
  const farm = await request('POST', M('contacts'), { kind: 'supplier', name: 'Farm' }, 201);
  const soon = await one("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 3)::text AS d");
  await request('POST', M('documents'), { kind: 'purchase', locationId: mloc.id, contactId: farm.id, requestKey: key(), lines: [
    { skuId: whole.id, quantity: '20', unitPrice: '150', lotCode: 'W1', expiresOn: soon.d }, { skuId: eggs.id, quantity: '10', unitPrice: '150' }] }, 201);
  const wholeLot = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [meat.id, whole.id]);
  let template, batch;

  await t.test('yield templates are for weighed items, adding up to at most 100%', async () => {
    await request('POST', M('weight/yield-templates'), { name: 'Eggs', inputSkuId: eggs.id, outputs: [{ skuId: curry.id, expectedPercent: '80' }] }, 400);
    await request('POST', M('weight/yield-templates'), { name: 'Too much', inputSkuId: whole.id, outputs: [{ skuId: curry.id, expectedPercent: '90' }, { skuId: liver.id, expectedPercent: '15' }] }, 400);
    await request('POST', M('weight/yield-templates'), { name: 'Self', inputSkuId: whole.id, outputs: [{ skuId: whole.id, expectedPercent: '50' }] }, 400);
    template = await request('POST', M('weight/yield-templates'), { name: 'Chicken curry cut', inputSkuId: whole.id, outputs: [{ skuId: curry.id, expectedPercent: '85' }, { skuId: liver.id, expectedPercent: '5' }] }, 201);
    await staff.meat.stock_keeper('POST', M('weight/yield-templates'), { name: 'X', inputSkuId: whole.id, outputs: [{ skuId: curry.id, expectedPercent: '50' }] }, 403);
    const listed = (await request('GET', M('weight/yield-templates'))).items[0];
    assert.equal(Number(listed.expected_yield), 90);
  });

  await t.test('cutting moves the input out and the cuts in, sharing the cost by selling value', async () => {
    const body = { inputLotId: wholeLot.id, inputQuantity: '10', templateId: template.id, notes: 'Morning', outputs: [{ skuId: curry.id, quantity: '8.4' }, { skuId: liver.id, quantity: '0.5' }] };
    await request('POST', M('weight/processing'), { ...body, requestKey: key(), inputQuantity: '25' }, 409);
    await request('POST', M('weight/processing'), { ...body, requestKey: key(), outputs: [{ skuId: curry.id, quantity: '10.5' }] }, 400);
    await request('POST', M('weight/processing'), { ...body, requestKey: key(), outputs: [{ skuId: eggs.id, quantity: '1' }] }, 400);
    await staff.meat.cashier('POST', M('weight/processing'), { ...body, requestKey: key() }, 403);
    const requestKey = key();
    batch = await staff.meat.stock_keeper('POST', M('weight/processing'), { ...body, requestKey }, 201);
    assert.match(batch.batch_no, /^CP\//);
    assert.deepEqual([batch.input_kg, batch.output_kg, batch.loss_kg], ['10.000', '8.900', '1.100']);
    assert.equal(batch.input_value, '1500.00');
    // The same request again returns the same batch; other content under the key is refused.
    assert.equal((await request('POST', M('weight/processing'), { ...body, requestKey }, 201)).id, batch.id);
    await request('POST', M('weight/processing'), { ...body, notes: 'Changed', requestKey }, 409);
    assert.equal((await one('SELECT quantity FROM business_stock_lots WHERE id=$1', [wholeLot.id])).quantity, '10.000');
    const outputs = await rows('SELECT o.*,l.lot_code,l.expires_on,l.quantity AS lot_quantity,l.unit_cost AS lot_cost FROM weight_processing_outputs o JOIN business_stock_lots l ON l.id=o.lot_id WHERE o.batch_id=$1 ORDER BY o.id', [batch.id]);
    // 8.4 kg × ₹260 = 2184 and 0.5 kg × ₹180 = 90 of selling value share ₹1,500 of cost.
    assert.deepEqual(outputs.map((o) => o.cost_share), ['1440.63', '59.37']);
    assert.equal(outputs.reduce((s, o) => s + paise(o.cost_share), 0), 150000);
    assert.equal(outputs[0].lot_code, batch.batch_no, 'batch-tracked cuts get a batch named after the cutting');
    assert.equal(outputs[0].expires_on, soon.d, 'and the input\'s use-by date');
    assert.equal(outputs[1].lot_code, '', 'untracked cuts join their loose stock');
    assert.equal(Number(outputs[0].lot_cost).toFixed(2), (1440.63 / 8.4).toFixed(2));
    // The ledger: every lot's movements add up to its quantity.
    const off = await one(`SELECT count(*)::int AS n FROM business_stock_lots l WHERE l.business_id=$1 AND l.quantity <>
      COALESCE((SELECT sum(quantity) FROM business_stock_movements m WHERE m.lot_id=l.id),0)`, [meat.id]);
    assert.equal(off.n, 0);
    const event = await one("SELECT payload FROM business_events WHERE business_id=$1 AND kind='processing.posted' AND entity_id=$2", [meat.id, batch.id]);
    assert.equal(event.payload.lossKg, '1.100');
    // An expired batch cannot be cut.
    await pool.query("UPDATE business_stock_lots SET expires_on=(now() AT TIME ZONE 'Asia/Kolkata')::date-1 WHERE id=$1", [wholeLot.id]);
    await request('POST', M('weight/processing'), { ...body, inputQuantity: '1', outputs: [{ skuId: curry.id, quantity: '0.8' }], requestKey: key() }, 409);
    await pool.query('UPDATE business_stock_lots SET expires_on=$2 WHERE id=$1', [wholeLot.id, soon.d]);
  });

  await t.test('selling by weight: grams on the line, kilograms in stock', async () => {
    const sale = await staff.meat.cashier('POST', M('documents'), { kind: 'sale', locationId: mloc.id, requestKey: key(),
      lines: [{ skuId: curry.id, quantity: '750', unit: 'g', lotCode: batch.batch_no }, { skuId: liver.id, quantity: '0.25' }] }, 201);
    assert.equal(sale.total, '240.00', '0.75 kg × ₹260 + 0.25 kg × ₹180');
    const stock = (await request('GET', M('weight/stock'))).items;
    const curryRow = stock.find((r) => r.sku_id === curry.id);
    assert.equal(Number(curryRow.on_hand), 7.65);
    assert.equal(Number(curryRow.on_hand_kg), 7.65);
    assert.equal(Number(curryRow.sold_7d), 0.75);
    assert.ok(!stock.some((r) => r.sku_id === eggs.id), 'only items stocked by weight');
  });

  await t.test('daily wastage leaves stock at cost; reports add up', async () => {
    const lot = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [meat.id, curry.id, batch.batch_no]);
    await request('POST', M('weight/wastage'), { lotId: lot.id, quantity: '0.2', reason: 'other', requestKey: key() }, 400);
    await request('POST', M('weight/wastage'), { lotId: lot.id, quantity: '50', reason: 'spoiled', requestKey: key() }, 409);
    await staff.meat.viewer('POST', M('weight/wastage'), { lotId: lot.id, quantity: '0.2', reason: 'spoiled', requestKey: key() }, 403);
    const entry = await staff.meat.cashier('POST', M('weight/wastage'), { lotId: lot.id, quantity: '0.350', reason: 'unsold', requestKey: key() }, 201);
    assert.equal(entry.kg, '0.350');
    assert.equal(entry.value, (0.35 * Number(lot.unit_cost)).toFixed(2));
    assert.equal((await one('SELECT quantity FROM business_stock_lots WHERE id=$1', [lot.id])).quantity, '7.300');
    const eggLot = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [meat.id, eggs.id]);
    await request('POST', M('weight/wastage'), { lotId: eggLot.id, quantity: '1.5', reason: 'damaged', requestKey: key() }, 400);
    const eggEntry = await request('POST', M('weight/wastage'), { lotId: eggLot.id, quantity: '1', reason: 'damaged', note: 'Dropped a tray', requestKey: key() }, 201);
    assert.equal(eggEntry.kg, null, 'counted items have no kg');
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const waste = await request('GET', M(`weight/reports/wastage?from=${day}&to=${day}`));
    assert.equal(waste.totals.entries, 2);
    assert.equal(paise(waste.totals.value), paise(entry.value) + paise(eggEntry.value));
    const curryWaste = waste.items.find((r) => r.sku_id === curry.id);
    assert.equal(Number(curryWaste.wastage_percent), Math.round((10000 * 0.35) / (0.35 + 0.75)) / 100);
    const yields = await request('GET', M(`weight/reports/yield?from=${day}&to=${day}`));
    assert.equal(yields.totals.yieldPercent, '89.00');
    assert.equal(Number(yields.inputs[0].expected_percent), 90);
    assert.equal(yields.inputs[0].cost_per_usable_kg, (1500 / 8.9).toFixed(2));
    await staff.meat.stock_keeper('GET', M(`weight/reports/yield?from=${day}&to=${day}`), undefined, 403);
    await assert.rejects(pool.query('DELETE FROM weight_wastage_entries WHERE id=$1', [entry.id]), /cannot be deleted/);
  });

  await t.test('weight shops are separate businesses', async () => {
    await other('GET', M('weight/processing'), undefined, 404);
    const theirs = (suffix) => `/businesses/${otherMeat.id}/${suffix}`;
    await other('POST', theirs('weight/wastage'), { lotId: wholeLot.id, quantity: '0.1', reason: 'spoiled', requestKey: key() }, 404);
    await other('POST', theirs('weight/processing'), { inputLotId: wholeLot.id, inputQuantity: '1', outputs: [{ skuId: curry.id, quantity: '0.5' }], requestKey: key() }, 404);
    await other('PATCH', theirs(`weight/yield-templates/${template.id}`), { active: false }, 404);
    await other('GET', theirs(`weight/processing/${batch.id}`), undefined, 404);
    assert.equal((await request('GET', M(`weight/processing/${batch.id}`))).outputs.length, 2);
    await assert.rejects(pool.query(`INSERT INTO weight_yield_templates(business_id,name,input_sku_id,created_by) VALUES($1,'x',$2,$3)`, [otherMeat.id, whole.id, ownerUser.id]), /foreign key|stocked by weight/);
  });
});
