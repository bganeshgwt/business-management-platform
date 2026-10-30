const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { signIn } = require('./helpers/signIn');

// Paid plans, read-only: a business with no trial, paid or given time left,
// no grace and no payment being checked can be seen, printed and exported,
// but nothing in it can be added or changed (402 plan_ended), whoever asks
// and from whichever screen. Your plan, opening the business, sign-in and the
// person's own profile, personal-data requests and printing stay open. The
// guests' QR, online ordering and booking pages take nothing. Dates are the
// business's own (a restaurant's, its own time zone).
test('paid plans: an ended business is read-only (402), with printing, exports and Your plan always open', { timeout: 600000 }, async (t) => {
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
  const password = `ReadOnly-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const platformRow = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id,name', ['Platform Admin', 'platform@readonly.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformRow.id]);
  const platformUser = { id: platformRow.id, name: platformRow.name, restaurantId: null };
  const app = require('../../src/app');
  const svc = require('../../src/modules/platform/services/subscriptions.service');
  const planGuard = require('../../src/middlewares/planGuard');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email, secret = password) => (await signIn(base, email, secret))?.token || null;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return expected >= 400 ? result.body : result.body.data;
  };
  const platform = as(await login('platform@readonly.invalid'));
  const MESSAGE = "This business's plan has ended. You can still see and export everything; renew in Your plan to add or change anything.";
  const refusedAsEnded = (answer, businessId) => {
    assert.equal(answer.message, MESSAGE);
    assert.deepEqual(answer.data, { reason: 'plan_ended', businessId: Number(businessId) });
  };
  // Its time set aside by the test, then a trial that ended long ago: read-only.
  const endBusiness = async (id) => {
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [id]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything)
      VALUES($1,'trial',business_local_today($1)-30,business_local_today($1)-17,TRUE)`, [id]);
    assert.equal((await svc.planOf(id)).state, 'ended');
  };
  const paidUntil = async (id, endsIn) => {
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [id]);
    const made = await one(`INSERT INTO platform_orders(business_id,kind,plan_code,billing_period,starts_on,ends_on,valid_until,buyer,supplier_state_code,place_of_supply_code,
        gst_rate,taxable_amount,igst_amount,total_amount,status,paid_at)
      SELECT b.id,'subscription',b.business_type || '_basic','month',business_local_today(b.id)-30,business_local_today(b.id)+$2::int,business_local_today(b.id),
        '{"name":"Test"}','22','29',18,100,18,118,'paid',now() FROM businesses b WHERE b.id=$1 RETURNING id`, [id, endsIn]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,plan_code,everything,order_id)
      SELECT business_id,'paid',starts_on,ends_on,plan_code,FALSE,id FROM platform_orders WHERE id=$1`, [made.id]);
  };
  await pool.query(`UPDATE platform_settings SET legal_name='Acme Soft Private Limited',address_line1='12 MG Road',city='Bengaluru',postal_code='560001',upi_id='acme@okaxis' WHERE id=1`);

  const shop = (await platform('POST', '/users/platform/businesses', { businessType: 'grocery', name: 'Ended Kirana', code: 'ENDED-KIRANA', stateCode: '29',
    owner: { email: 'owner@endedkirana.invalid', name: 'Meena R', password } }, 201)).business;
  const ownerToken = await login('owner@endedkirana.invalid');
  const owner = as(ownerToken);
  const B = (suffix) => `/businesses/${shop.id}${suffix}`;
  // A request sent as written, the target untouched (fetch would tidy it).
  const raw = (method, target, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const sent = http.request({ host: '127.0.0.1', port: server.address().port, method, path: target, headers: { 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${ownerToken}` } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : {} }));
    });
    sent.on('error', reject);
    sent.end(data);
  });
  let order;

  await t.test('an ended shop: every write is refused with 402 plan_ended; it is seen, opened and renewed as before', async () => {
    const asha = await owner('POST', B('/contacts'), { kind: 'customer', name: 'Asha K' }, 201);
    const location = (await owner('GET', B('/locations'))).items[0];
    const item = await owner('POST', B('/catalog'), { name: 'Bath soap', code: 'SOAP-T', kind: 'goods', unit: 'each', tracking: 'quantity', price: '118', taxRate: '18' }, 201);
    await endBusiness(shop.id);
    refusedAsEnded(await owner('POST', B('/contacts'), { kind: 'customer', name: 'Ravi K' }, 402), shop.id);
    refusedAsEnded(await owner('POST', B('/documents'), { kind: 'sale', requestKey: crypto.randomUUID(), locationId: location.id, contactId: asha.id,
      lines: [{ skuId: item.id, quantity: '1', unitPrice: '118' }] }, 402), shop.id);
    refusedAsEnded(await owner('PUT', B(`/contacts/${asha.id}`), { name: 'Asha Kumar' }, 402), shop.id);
    refusedAsEnded(await owner('PUT', B('/modules/offers'), { enabled: true }, 402), shop.id);
    // However its id is written, the routes read business N (Express decodes it, and an id is read as a number), and so does the check;
    // an absolute-form target too.
    const id = String(shop.id);
    for (const written of [`${id}.0`, `+${id}`, [...id].map((digit) => `%3${digit}`).join(''), `0x${Number(id).toString(16)}`, `${id}e0`, `%20${id}`, `%2B${id}`, `0${id}`]) {
      const answer = await raw('POST', `/api/businesses/${written}/contacts`, { kind: 'customer', name: 'Written oddly' });
      assert.equal(answer.status, 402, `business ${written}: ${JSON.stringify(answer.body)}`);
      refusedAsEnded(answer.body, shop.id);
    }
    const absolute = await raw('POST', `http://127.0.0.1:${server.address().port}/api/businesses/${id}/contacts`, { kind: 'customer', name: 'Absolute' });
    assert.equal(absolute.status, 402, JSON.stringify(absolute.body));
    // Your plan stays open however the id is written.
    const planned = await raw('POST', `/api/businesses/${id}.0/plan/orders`, { kind: 'subscription' });
    assert.equal(planned.status, 201, JSON.stringify(planned.body));
    // Seen and opened as before; everyone's banner says ended, without prices.
    assert.ok((await owner('GET', B('/contacts'))).items.some((c) => c.name === 'Asha K'));
    const context = await owner('GET', B('/context'));
    assert.deepEqual(Object.keys(context.plan).sort(), ['accessEndsOn', 'daysLeft', 'graceEndsOn', 'state', 'trialEndsOn']);
    assert.equal(context.plan.state, 'ended');
    await owner('POST', B('/open'), {});
    // Your plan, another business of one's own and one's own profile stay open.
    order = await owner('POST', B('/plan/orders'), { kind: 'subscription' }, 201);
    assert.equal(order.startsOn, (await one('SELECT business_local_today($1)::text AS d', [shop.id])).d);
    await owner('POST', '/businesses', { businessType: 'books', name: 'Fresh Books', code: 'FRESH-BOOKS' }, 201);
    await owner('PUT', '/auth/me', { name: 'Meena Rao' });
  });

  await t.test('a payment being checked keeps it working for two days; once rejected, it is read-only again', async () => {
    const payment = await owner('POST', B(`/plan/orders/${order.id}/payments`), { method: 'upi', reference: 'UTR9001', paidOn: order.startsOn }, 201);
    assert.equal((await svc.planOf(shop.id)).state, 'checking');
    await owner('POST', B('/contacts'), { kind: 'customer', name: 'Ravi K' }, 201);
    await svc.rejectPayment(platformUser, payment.id, 'No such UTR in the bank');
    assert.equal((await svc.planOf(shop.id)).state, 'ended');
    refusedAsEnded(await owner('POST', B('/contacts'), { kind: 'customer', name: 'Kiran K' }, 402), shop.id);
  });

  // A restaurant made by the platform, with its menu, a table and its day open.
  const restaurant = async (code) => {
    const adminEmail = `owner@${code.toLowerCase()}.invalid`;
    const made = await platform('POST', '/users/platform/restaurants', { name: `Diner ${code}`, code, admin: { name: 'Owner', email: adminEmail, password } }, 201);
    const ownerToken = await login(adminEmail);
    const owner = as(ownerToken);
    const cashier = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [made.id, 'Cashier', `cashier@${code.toLowerCase()}.invalid`, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='CASHIER' AND restaurant_id IS NULL", [cashier.id]);
    const rate = await owner('POST', '/menu/tax-rates', { name: 'Food 5%', percentage: 5, hsnCode: '9963' }, 201);
    const category = await owner('POST', '/menu/categories', { name: 'Mains' }, 201);
    const dish = await owner('POST', '/menu/products', { categoryId: category.id, name: 'Dal Tadka', price: 200, taxRateId: rate.id, isAvailable: true }, 201);
    const floor = await owner('POST', '/tables/floors', { name: 'Ground' }, 201);
    const table = await owner('POST', '/tables', { floorId: floor.id, tableNo: 'T1', capacity: 4 }, 201);
    await owner('POST', '/business-day/open', { openingCash: 0 }, 201);
    const businessId = (await one('SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [made.id])).id;
    return { id: made.id, businessId, owner, ownerToken, cashier: as(await login(`cashier@${code.toLowerCase()}.invalid`)), dish, table };
  };
  const takeaway = (who, dish, expected = 201) => who('POST', '/orders', { orderType: 'takeaway', items: [{ productId: dish.id, quantity: 1 }] }, expected);

  let diner;
  await t.test('an ended restaurant takes no new orders, but its bills and kitchen tickets print, and its guests are told', async () => {
    diner = await restaurant('ENDEDDINER');
    const paidOrder = await takeaway(diner.cashier, diner.dish);
    const kot = (await diner.owner('GET', `/kitchen/orders/${paidOrder.id}/kots`))[0];
    const bill = await diner.owner('POST', '/bills', { orderId: paidOrder.id }, 201);
    await diner.owner('POST', `/bills/${bill.id}/payments`, { paymentMethod: 'cash', amount: bill.dueAmount }, 201);
    const tables = await diner.owner('GET', '/tables');
    const qrToken = (tables.items || tables).find((row) => Number(row.id) === Number(diner.table.id)).qrToken;
    await endBusiness(diner.businessId);
    refusedAsEnded(await takeaway(diner.cashier, diner.dish, 402), diner.businessId);
    refusedAsEnded(await diner.owner('POST', '/menu/categories', { name: 'Desserts' }, 402), diner.businessId);
    refusedAsEnded(await diner.owner('PUT', '/restaurants/current/features/tips', { enabled: false }, 402), diner.businessId);
    // Printing and previews only read; reports and exports are reads.
    await diner.owner('POST', `/bills/${bill.id}/print`, {});
    assert.ok(kot, 'the order sent a kitchen ticket');
    await diner.owner('POST', `/kitchen/kots/${kot.id}/print`, {});
    await diner.owner('POST', '/restaurants/current/features/tips/preview', { enabled: false });
    await diner.owner('GET', '/reports/sales');
    const exported = await fetch(`${base}/menu/products/export`, { headers: { Authorization: `Bearer ${diner.ownerToken}` }, signal: AbortSignal.timeout(20000) });
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /Dal Tadka/);
    // Everyone's profile carries the state, never a price.
    const me = await diner.cashier('GET', '/auth/me');
    assert.deepEqual([me.plan.state, me.plan.businessId], ['ended', diner.businessId]);
    assert.deepEqual(Object.keys(me.plan).sort(), ['accessEndsOn', 'businessId', 'daysLeft', 'graceEndsOn', 'state', 'trialEndsOn']);
    // Ended: there are no days left to count, so none are given.
    assert.equal(me.plan.daysLeft, null);
    // The owner renews from Your plan.
    await diner.owner('GET', '/plan');
    await diner.owner('PUT', '/plan/selection', { planCode: 'restaurant_basic', billingPeriod: 'month', addons: [] });
    // The guests' QR code takes no orders or calls.
    const guest = await call('POST', `/public/tables/${qrToken}/orders`, { clientKey: `k-${crypto.randomBytes(6).toString('hex')}`, items: [{ productId: diner.dish.id, quantity: 1 }] });
    assert.equal(guest.status, 409);
    assert.equal(guest.body.message, "This restaurant isn't taking orders online right now.");
    assert.equal((await call('POST', `/public/tables/${qrToken}/calls`, { type: 'water' })).status, 409);
    assert.equal((await call('GET', `/public/tables/${qrToken}/menu`)).status, 200);
  });

  await t.test('a restaurant in grace keeps taking orders, and its profile says grace', async () => {
    await paidUntil(diner.businessId, -2);
    await takeaway(diner.cashier, diner.dish);
    const me = await diner.cashier('GET', '/auth/me');
    assert.equal(me.plan.state, 'grace');
    assert.equal(me.plan.graceEndsOn, (await one('SELECT (business_local_today($1)+5)::text AS d', [diner.businessId])).d);
    assert.equal(me.plan.daysLeft, 6);
    // Given time with no end has no days to count.
    await svc.giveTime(platformUser, diner.businessId, { noEnd: true, everything: true, reason: 'Pilot restaurant' });
    const given = await diner.cashier('GET', '/auth/me');
    assert.deepEqual([given.plan.state, given.plan.daysLeft], ['given', null]);
  });

  await t.test('a restaurant with no business of its own yet is not checked', async () => {
    const lone = await one("INSERT INTO restaurants(name,code) VALUES('Lone Cafe','LONECAFE') RETURNING id");
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [lone.id]);
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [lone.id, 'Lone owner', 'owner@lonecafe.invalid', hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [user.id]);
    const loneOwner = as(await login('owner@lonecafe.invalid'));
    await loneOwner('POST', '/menu/categories', { name: 'Coffee' }, 201);
    assert.equal((await loneOwner('GET', '/auth/me')).plan, null);
    assert.equal(await one('SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [lone.id]), undefined);
  });

  await t.test("a restaurant's own clock decides the state: paid time that ends today by its date is still paid", async () => {
    // Pago Pago is 25 hours behind Kiritimati, so the two dates always differ:
    // by the business row's zone (Kiritimati) this paid time has already
    // ended; by the restaurant's own (Pago Pago) it ends today.
    const far = await restaurant('CLOCKDINER');
    await pool.query("UPDATE restaurant_settings SET timezone='Pacific/Pago_Pago' WHERE restaurant_id=$1", [far.id]);
    await pool.query("UPDATE businesses SET timezone='Pacific/Kiritimati' WHERE id=$1", [far.businessId]);
    await pool.query('UPDATE platform_settings SET grace_days=0');
    try {
      await paidUntil(far.businessId, 0);
      const plan = await svc.planOf(far.businessId);
      assert.equal(plan.state, 'paid');
      assert.ok(plan.accessEndsOn < (await one("SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS d")).d);
      await far.owner('POST', '/menu/categories', { name: 'Specials' }, 201);
      // On the business row's clock it would have ended.
      await pool.query("UPDATE restaurant_settings SET timezone='Pacific/Kiritimati' WHERE restaurant_id=$1", [far.id]);
      assert.equal((await svc.planOf(far.businessId)).state, 'ended');
      refusedAsEnded(await far.owner('POST', '/menu/categories', { name: 'Late specials' }, 402), far.businessId);
    } finally { await pool.query('UPDATE platform_settings SET grace_days=7'); }
  });

  await t.test('the writes an ended business may still make are listed, so a new one is a visible change', async () => {
    assert.deepEqual(planGuard.ALWAYS_ALLOWED.map((rule) => `${rule.method} ${rule.pattern.source}`), [
      '* ^\\/api\\/auth\\/',
      '* ^\\/api\\/plan(\\/|$)',
      '* ^\\/api\\/businesses\\/\\d+\\/plan(\\/|$)',
      'POST ^\\/api\\/businesses\\/?$',
      'POST ^\\/api\\/businesses\\/\\d+\\/open\\/?$',
      'POST ^\\/api\\/notifications\\/(read|unread|read-all)\\/?$',
      '* ^\\/api\\/privacy(\\/|$)',
      '* ^\\/api\\/businesses\\/\\d+\\/privacy(\\/|$)',
      '* ^\\/api\\/users\\/platform(\\/|$)',
      'POST ^\\/api\\/bills\\/\\d+\\/print\\/?$',
      'POST ^\\/api\\/bills\\/\\d+\\/adjust\\/check\\/?$',
      'POST ^\\/api\\/kitchen\\/kots\\/\\d+\\/print\\/?$',
      'POST ^\\/api\\/kitchen\\/slips\\/\\d+\\/print\\/?$',
      'POST ^\\/api\\/restaurants\\/current\\/features\\/[a-z_]+\\/preview\\/?$',
      'POST ^\\/api\\/staff\\/tips\\/preview\\/?$',
      'POST ^\\/api\\/businesses\\/\\d+\\/agri\\/(licence|counter)-check\\/?$',
      'POST ^\\/api\\/businesses\\/\\d+\\/hardware\\/calculate\\/?$',
      'POST ^\\/api\\/businesses\\/\\d+\\/clinic\\/visits\\/\\d+\\/prescription-check\\/?$',
      'POST ^\\/api\\/businesses\\/\\d+\\/jewellery\\/(bills|old-gold)\\/preview\\/?$',
    ]);
    assert.ok(planGuard.ALWAYS_ALLOWED.every((rule) => rule.pattern.flags === 'i'));
  });
});
