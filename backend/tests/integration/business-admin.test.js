const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { signIn } = require('./helpers/signIn');

test('multi-business admin: isolation, weighted stock, idempotency and appointments', { timeout: 180000 }, async (t) => {
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
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const password = `Business-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  async function owner(code) {
    const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', [code]);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, code, `${code}@test.invalid`, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
    return person;
  }
  const user = await owner('business-owner');
  const stranger = await owner('business-other');
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token;
  async function request(method, route, body, expected = 200, auth = token) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
    return result.data;
  }
  token = (await signIn(base, 'business-owner@test.invalid', password)).token;
  const otherToken = (await signIn(base, 'business-other@test.invalid', password)).token;
  let businesses, grocery, electronics, pharmacy, salon;
  const root = (b, suffix) => `/businesses/${b.id}/${suffix}`;
  await t.test('businesses an owner adds are restricted to that owner', async () => {
    await request('GET', '/businesses', undefined, 401, null);
    businesses = await createBusinesses(request, 'OWNER', ['grocery', 'electronics', 'pharmacy', 'salon', 'wholesale']);
    // Goods shops start GST-inclusive; these checks use prices before GST.
    await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
    const ids = businesses.map((b) => b.id);
    assert.equal((await request('GET', '/businesses', undefined, 200, otherToken)).businesses.filter((b) => ids.includes(b.id)).length, 0);
    grocery = businesses.find((b) => b.business_type === 'grocery');
    electronics = businesses.find((b) => b.business_type === 'electronics');
    pharmacy = businesses.find((b) => b.business_type === 'pharmacy');
    salon = businesses.find((b) => b.business_type === 'salon');
    await request('GET', root(grocery, 'catalog'), undefined, 404, otherToken);
  });
  let location, supplier, customer, sku, sale;
  const newSku = (label, overrides = {}) => ({ name: label, code: label, kind: 'goods', unit: 'kg', tracking: 'quantity', price: '120.00', taxRate: '5', ...overrides });
  await t.test('catalog, typed contacts and capability validation', async () => {
    location = (await request('GET', root(grocery, 'locations'))).items[0];
    supplier = await request('POST', root(grocery, 'contacts'), { kind: 'supplier', name: 'Supplier' }, 201);
    customer = await request('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'Customer' }, 201);
    sku = await request('POST', root(grocery, 'catalog'), newSku('RICE'), 201);
    await request('POST', root(grocery, 'catalog'), newSku('RICE'), 409);
    await request('POST', root(grocery, 'catalog'), newSku('BAD', { price: false }), 400);
    await request('POST', root(grocery, 'catalog'), newSku('BAD', { attributes: { madeUp: 'test' } }), 400);
    await request('POST', root(grocery, 'catalog'), newSku('SERIAL', { unit: 'each', tracking: 'serial' }), 400);
    await request('POST', root(grocery, 'appointments'), {}, 403);
    await request('GET', root(grocery, 'catalog?limit=1000'), undefined, 400);
    const empty = await request('GET', root(grocery, 'catalog?offset=100'));
    assert.equal(empty.total, 1); assert.equal(empty.items.length, 0);
  });
  await t.test('viewer cannot mutate and database relationships reject cross-business references', async () => {
    await pool.query("INSERT INTO business_memberships(business_id,user_id,role_id) SELECT $1,$2,id FROM business_roles WHERE business_id=$1 AND template_code='viewer'", [grocery.id, stranger.id]);
    await request('GET', root(grocery, 'catalog'), undefined, 200, otherToken);
    await request('POST', root(grocery, 'contacts'), { name: 'Not allowed', kind: 'customer' }, 403, otherToken);
    const foreignLocation = (await request('GET', root(electronics, 'locations'))).items[0];
    await assert.rejects(pool.query('INSERT INTO business_resources(business_id,location_id,name) VALUES($1,$2,$3)', [grocery.id, foreignLocation.id, 'Invalid']), { code: '23503' });
  });
  await t.test('purchases, fractional sales and immutable invoice prices reconcile', async () => {
    const purchaseBody = { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: crypto.randomUUID(), lines: [{ skuId: sku.id, quantity: '2.000', unitPrice: '60' }] };
    const purchase = await request('POST', root(grocery, 'documents'), purchaseBody, 201);
    assert.equal(purchase.total, '126.00');
    const replay = await request('POST', root(grocery, 'documents'), purchaseBody, 201);
    assert.equal(replay.id, purchase.id);
    await request('POST', root(grocery, 'documents'), { ...purchaseBody, notes: 'changed' }, 409);
    const saleBody = { kind: 'sale', locationId: location.id, contactId: customer.id, requestKey: crypto.randomUUID(), lines: [{ skuId: sku.id, quantity: '0.375', unitPrice: '0' }] };
    sale = await request('POST', root(grocery, 'documents'), saleBody, 201);
    assert.equal(sale.subtotal, '45.00'); assert.equal(sale.tax, '2.25'); assert.equal(sale.total, '47.25');
    await request('PATCH', root(grocery, `catalog/${sku.id}`), { label: 'Rice changed', price: '200', taxRate: '18', active: true });
    const detail = await request('GET', root(grocery, `documents/${sale.id}`));
    assert.equal(detail.lines[0].unit_price, '120.00'); assert.equal(detail.lines[0].label, 'RICE');
    const lots = await request('GET', root(grocery, 'stock'));
    assert.equal(Number(lots.items[0].quantity), 1.625);
    await request('POST', root(grocery, 'documents'), { ...saleBody, requestKey: crypto.randomUUID(), lines: [{ skuId: sku.id, quantity: '10' }] }, 409);
    assert.equal((await request('GET', root(grocery, 'documents'))).total, 2);
  });
  await t.test('concurrent sales cannot oversell; failed documents roll back', async () => {
    const make = () => ({ kind: 'sale', locationId: location.id, requestKey: crypto.randomUUID(), lines: [{ skuId: sku.id, quantity: '1.000' }] });
    const statuses = await Promise.all([make(), make()].map(async (body) => (await fetch(base + root(grocery, 'documents'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status));
    assert.deepEqual(statuses.sort(), [201, 409]);
    const lot = (await request('GET', root(grocery, 'stock'))).items[0];
    assert.equal(Number(lot.quantity), 0.625);
    const ledger = await one('SELECT sum(quantity) AS quantity FROM business_stock_movements WHERE business_id=$1 AND lot_id=$2', [grocery.id, lot.id]);
    assert.equal(Number(ledger.quantity), Number(lot.quantity));
  });
  await t.test('payments are idempotent and cannot overcollect or cross businesses', async () => {
    const body = { amount: '47.25', method: 'cash', requestKey: crypto.randomUUID() };
    const pay = await request('POST', root(grocery, `documents/${sale.id}/payments`), body, 201);
    assert.equal((await request('POST', root(grocery, `documents/${sale.id}/payments`), body, 201)).id, pay.id);
    await request('POST', root(grocery, `documents/${sale.id}/payments`), { ...body, amount: '1' }, 409);
    await request('POST', root(grocery, `documents/${sale.id}/payments`), { ...body, requestKey: crypto.randomUUID() }, 409);
    await request('GET', root(electronics, `documents/${sale.id}`), undefined, 404);
  });
  await t.test('serials are individually received/sold and expired batches cannot be sold', async () => {
    for (const business of [electronics, pharmacy]) {
      const loc = (await request('GET', root(business, 'locations'))).items[0];
      const supp = await request('POST', root(business, 'contacts'), { kind: 'supplier', name: 'Supplier' }, 201);
      const serial = business.id === electronics.id;
      const item = await request('POST', root(business, 'catalog'), newSku(serial ? 'PHONE' : 'MEDICINE', { unit: 'each', tracking: serial ? 'serial' : 'batch' }), 201);
      const line = { skuId: item.id, quantity: '1', unitPrice: '50', lotCode: serial ? 'IMEI-TEST-1' : 'BATCH-1', ...(!serial ? { expiresOn: '2000-01-01' } : {}) };
      const body = { kind: 'purchase', locationId: loc.id, contactId: supp.id, requestKey: crypto.randomUUID(), lines: [line] };
      await request('POST', root(business, 'documents'), body, 201);
      if (serial) await request('POST', root(business, 'documents'), { ...body, requestKey: crypto.randomUUID() }, 409);
      await request('POST', root(business, 'documents'), { kind: 'sale', locationId: loc.id, requestKey: crypto.randomUUID(), lines: [line] }, serial ? 201 : 409);
      if (serial) await request('POST', root(business, 'documents'), { kind: 'sale', locationId: loc.id, requestKey: crypto.randomUUID(), lines: [line] }, 409);
    }
  });
  await t.test('returns use original prices, restore stock once and refunds cannot exceed credit', async () => {
    const detail = await request('GET', root(grocery, `documents/${sale.id}`));
    const body = { reason: 'Customer return', requestKey: crypto.randomUUID(), lines: [{ lineId: detail.lines[0].id, quantity: '0.375', restock: true }] };
    const returned = await request('POST', root(grocery, `documents/${sale.id}/returns`), body, 201);
    assert.equal(returned.total, '47.25');
    assert.equal((await request('POST', root(grocery, `documents/${sale.id}/returns`), body, 201)).id, returned.id);
    await request('POST', root(grocery, `documents/${sale.id}/returns`), { ...body, requestKey: crypto.randomUUID() }, 409);
    const refund = { amount: '47.25', method: 'cash', reason: 'Returned item', requestKey: crypto.randomUUID() };
    const refunded = await request('POST', root(grocery, `documents/${sale.id}/refunds`), refund, 201);
    assert.equal((await request('POST', root(grocery, `documents/${sale.id}/refunds`), refund, 201)).id, refunded.id);
    await request('POST', root(grocery, `documents/${sale.id}/refunds`), { ...refund, requestKey: crypto.randomUUID() }, 409);
    const final = await request('GET', root(grocery, `documents/${sale.id}`));
    assert.equal(final.lines[0].returned_quantity, '0.375');
    assert.equal(final.refunds.length, 1);
    assert.equal(Number((await request('GET', root(grocery, 'stock'))).items[0].quantity), 1);
    const summary = await request('GET', root(grocery, 'summary'));
    assert.equal(Number(summary.sales), 236);
    // "Customers owe" is the customers' balances, as Udhaar / Outstanding show
    // them (this customer's bill was returned and refunded); the unpaid walk-in
    // bills are a separate figure.
    assert.equal(Number(summary.receivables), 0);
    assert.equal(Number(summary.receivables_walk_in), 236);
  });
  await t.test('stock adjustments are auditable, idempotent and cannot create negative stock', async () => {
    const lot = (await request('GET', root(grocery, 'stock'))).items[0];
    const body = { quantity: '-0.200', reason: 'Physical shortage', requestKey: crypto.randomUUID() };
    const adjustment = await request('POST', root(grocery, `stock/${lot.id}/adjustments`), body, 201);
    assert.equal((await request('POST', root(grocery, `stock/${lot.id}/adjustments`), body, 201)).id, adjustment.id);
    await request('POST', root(grocery, `stock/${lot.id}/adjustments`), { ...body, quantity: '-10', requestKey: crypto.randomUUID() }, 409);
    assert.equal(Number((await request('GET', root(grocery, 'stock'))).items[0].quantity), 0.8);
    const moves = await request('GET', root(grocery, 'movements'));
    assert.equal(Math.round(moves.items.reduce((sum, r) => sum + Number(r.quantity), 0) * 1000), 800);
  });
  await t.test('service bookings reject overlaps, permit adjacent appointments and audit transitions', async () => {
    const loc = (await request('GET', root(salon, 'locations'))).items[0];
    const contact = await request('POST', root(salon, 'contacts'), { kind: 'customer', name: 'Test guest' }, 201);
    const item = await request('POST', root(salon, 'catalog'), newSku('CUT', { kind: 'service', unit: 'service', tracking: 'none' }), 201);
    const staff = await request('POST', root(salon, 'resources'), { name: 'Stylist', locationId: loc.id }, 201);
    const body = { contactId: contact.id, skuId: item.id, resourceId: staff.id, startsAt: '2026-11-01T10:00:00Z', endsAt: '2026-11-01T11:00:00Z' };
    const booking = await request('POST', root(salon, 'appointments'), body, 201);
    await request('POST', root(salon, 'appointments'), body, 409);
    await request('POST', root(salon, 'appointments'), { ...body, startsAt: body.endsAt, endsAt: '2026-11-01T12:00:00Z' }, 201);
    await request('PATCH', root(salon, `appointments/${booking.id}`), { status: 'cancelled' });
    await request('PATCH', root(salon, `appointments/${booking.id}`), { status: 'completed' }, 409);
    await request('POST', root(salon, 'appointments'), { ...body, contactId: customer.id }, 404);
    assert.ok((await request('GET', root(salon, 'audit'))).items.some((r) => r.action === 'appointment.cancelled'));
  });
  await t.test('wholesale thresholds have deterministic customer precedence and saved prices', async () => {
    const wholesale = businesses.find((b) => b.business_type === 'wholesale');
    const loc = (await request('GET', root(wholesale, 'locations'))).items[0];
    const customer = await request('POST', root(wholesale, 'contacts'), { kind: 'customer', name: 'Distributor' }, 201);
    const item = await request('POST', root(wholesale, 'catalog'), newSku('SERVICE', { kind: 'service', unit: 'service', price: '100', taxRate: '0' }), 201);
    const general = await request('POST', root(wholesale, 'pricing'), { skuId: item.id, minimumQuantity: '10', unitPrice: '80' }, 201);
    const special = await request('POST', root(wholesale, 'pricing'), { skuId: item.id, contactId: customer.id, minimumQuantity: '5', unitPrice: '70' }, 201);
    await request('POST', root(wholesale, 'pricing'), { skuId: item.id, minimumQuantity: '10', unitPrice: '79' }, 409);
    const make = (qty, customerId) => ({ kind: 'sale', locationId: loc.id, contactId: customerId, requestKey: crypto.randomUUID(), lines: [{ skuId: item.id, quantity: qty }] });
    assert.equal((await request('POST', root(wholesale, 'documents'), make('9'), 201)).total, '900.00');
    assert.equal((await request('POST', root(wholesale, 'documents'), make('10'), 201)).total, '800.00');
    const sale = await request('POST', root(wholesale, 'documents'), make('10', customer.id), 201);
    assert.equal(sale.total, '700.00');
    await request('DELETE', root(wholesale, `pricing/${special.id}`));
    assert.equal((await request('GET', root(wholesale, `documents/${sale.id}`))).lines[0].unit_price, '70.00');
    assert.equal((await request('POST', root(wholesale, 'documents'), make('10', customer.id), 201)).total, '800.00');
    await request('GET', root(grocery, 'pricing'), undefined, 403);
    assert.ok(general.id);
  });
  await t.test('reports account for events on posting dates and restaurant bridge is explicit', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: grocery.timezone }).format(new Date());
    const report = await request('GET', root(grocery, `reports?from=${day}&to=${day}`));
    assert.equal(Number(report.rows.find((r) => r.kind === 'sale_return').total), 47.25);
    assert.equal(Number(report.rows.find((r) => r.kind === 'sale_refund').total), 47.25);
    await request('GET', root(grocery, 'reports?from=2026-02-30&to=2026-03-01'), undefined, 400);
    const linked = await request('POST', '/businesses/link-restaurant', {});
    assert.equal(linked.businesses.filter((b) => b.business_type === 'restaurant').length, 1);
    const again = await request('POST', '/businesses/link-restaurant', {});
    assert.equal(again.businesses.length, linked.businesses.length);
  });
  await t.test('owners grant only eligible staff access; viewers cannot elevate themselves and revocation is immediate', async () => {
    const original = await one('SELECT restaurant_id FROM users WHERE id=$1', [user.id]);
    const staff = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [original.restaurant_id, 'Business staff', 'business-staff@test.invalid', hash]);
    const staffToken = (await signIn(base, 'business-staff@test.invalid', password)).token;
    await request('GET', root(salon, 'summary'), undefined, 404, staffToken);
    await request('POST', root(salon, 'members'), { userId: stranger.id, role: 'viewer' }, 404);
    await request('POST', root(salon, 'members'), { userId: user.id, role: 'viewer' }, 409);
    await request('POST', root(salon, 'members'), { userId: staff.id, role: 'viewer' }, 201);
    await request('GET', root(salon, 'summary'), undefined, 200, staffToken);
    await request('POST', root(salon, 'contacts'), { kind: 'customer', name: 'Forbidden' }, 403, staffToken);
    await request('POST', root(salon, 'members'), { userId: staff.id, role: 'manager' }, 403, staffToken);
    await request('GET', root(salon, 'member-candidates'), undefined, 403, staffToken);
    await request('POST', root(salon, 'members'), { userId: staff.id, role: 'manager' }, 201);
    await request('POST', root(salon, 'contacts'), { kind: 'customer', name: 'Allowed customer' }, 201, staffToken);
    await request('POST', root(salon, 'members'), { userId: staff.id, role: 'viewer', active: false }, 201);
    await request('GET', root(salon, 'summary'), undefined, 404, staffToken);
    const members = await request('GET', root(salon, 'members'));
    assert.equal(members.items.find((m) => m.id === staff.id).active, false);
  });
});
