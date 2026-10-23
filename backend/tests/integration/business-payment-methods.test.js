const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');

// Payment methods the owner manages (Settings › Payment methods): the five
// defaults every business starts with, the owner's own (PhonePe, Sodexo) each
// of a fixed kind, renaming and switching off, a bill paid by a named method
// recording its kind and name, another business's method or a switched-off
// one refused, older screens sending the kind alone still working, and the
// day close splitting each kind by name. Runs on its own throwaway database
// with every migration applied.
test('payment methods: defaults, owner-managed names, kind + name on payments, day close', { timeout: 300000 }, async (t) => {
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
  const password = `Methods-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Methods','METHODS') RETURNING id");
  await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
  const ownerUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, 'Methods owner', 'methods-owner@test.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [ownerUser.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
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
  const request = as(await login('methods-owner@test.invalid'));
  const key = () => crypto.randomUUID();

  const [shop, other] = await createBusinesses(request, 'OWNER', ['supermarket', 'pharmacy']);
  const S = (suffix) => `/businesses/${shop.id}/${suffix}`;
  const O = (suffix) => `/businesses/${other.id}/${suffix}`;
  const main = (await request('GET', S('locations'))).items[0];

  await t.test('every new business starts with the five usual methods', async () => {
    const methods = await request('GET', S('payment-methods'));
    assert.deepEqual(methods.map((m) => [m.name, m.kind]), [['Cash', 'cash'], ['UPI', 'upi'], ['Card', 'card'], ['Bank transfer', 'bank'], ['Cheque', 'cheque']]);
    assert.equal((await request('GET', O('payment-methods'))).length, 5);
    // A restaurant keeps its own payment types: the owner's, linked as a business, gets none of these.
    const kitchen = (await request('POST', '/businesses/link-restaurant', {})).businesses.find((b) => b.business_type === 'restaurant');
    assert.equal((await one('SELECT count(*)::int AS n FROM business_payment_methods WHERE business_id=$1', [kitchen.id])).n, 0);
  });

  let phonepe, sodexo;
  await t.test('the owner adds, renames and switches off methods', async () => {
    phonepe = await request('POST', S('payment-methods'), { name: 'PhonePe', kind: 'upi' }, 201);
    sodexo = await request('POST', S('payment-methods'), { name: '  Sodexo ', kind: 'card' }, 201);
    assert.equal(sodexo.name, 'Sodexo');
    assert.ok(sodexo.sort_order > phonepe.sort_order);
    await request('POST', S('payment-methods'), { name: 'phonepe', kind: 'upi' }, 409);
    await request('POST', S('payment-methods'), { name: 'Wallet', kind: 'wallet' }, 400);
    await request('POST', S('payment-methods'), { name: '', kind: 'cash' }, 400);
    // The kind is fixed once made; the name can change.
    await request('PATCH', S(`payment-methods/${phonepe.id}`), { kind: 'card' }, 409);
    const renamed = await request('PATCH', S(`payment-methods/${phonepe.id}`), { name: 'PhonePe UPI', kind: 'upi' });
    assert.equal(renamed.name, 'PhonePe UPI');
    assert.equal(renamed.kind, 'upi');
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='payment_method.updated' ORDER BY id DESC LIMIT 1", [shop.id]);
    assert.equal(audit.details.nameTo, 'PhonePe UPI');
    // Switched off: gone from the counter's list, still in the settings list.
    await request('PATCH', S(`payment-methods/${sodexo.id}`), { active: false });
    assert.ok(!(await request('GET', S('payment-methods'))).some((m) => m.id === sodexo.id));
    assert.equal((await request('GET', S('payment-methods?all=true'))).find((m) => m.id === sodexo.id).active, false);
    // The other business never sees them.
    await request('PATCH', O(`payment-methods/${phonepe.id}`), { name: 'Mine now' }, 404);
    assert.ok(!(await request('GET', O('payment-methods'))).some((m) => m.name === 'PhonePe UPI'));
  });

  await t.test('the last method switched on stays on', async () => {
    const others = (await request('GET', O('payment-methods')));
    for (const m of others.slice(1)) await request('PATCH', O(`payment-methods/${m.id}`), { active: false });
    await request('PATCH', O(`payment-methods/${others[0].id}`), { active: false }, 409);
    for (const m of others.slice(1)) await request('PATCH', O(`payment-methods/${m.id}`), { active: true });
  });

  const supplier = await request('POST', S('contacts'), { kind: 'supplier', name: 'Metro wholesale' }, 201);
  const soap = await request('POST', S('catalog'), { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '0', name: 'Bath soap', code: 'SOAP', price: '50' }, 201);
  await request('POST', S('documents'), { kind: 'purchase', requestKey: key(), locationId: main.id, contactId: supplier.id, lines: [{ skuId: soap.id, quantity: '100', unitPrice: '30' }] }, 201);
  const sell = (payment, expected = 201, quantity = '1') => request('POST', S('documents'),
    { kind: 'sale', requestKey: key(), locationId: main.id, lines: [{ skuId: soap.id, quantity }], ...payment }, expected);

  let phonepeSale;
  await t.test('a bill paid by a named method records its kind and name', async () => {
    phonepeSale = await sell({ payment: { amount: 'full', methodId: phonepe.id } });
    const doc = await request('GET', S(`documents/${phonepeSale.id}`));
    assert.equal(doc.payments.length, 1);
    assert.equal(doc.payments[0].method, 'upi');
    assert.equal(doc.payments[0].method_name, 'PhonePe UPI');
    // Split payment: the named cash method with change, and PhonePe.
    const cash = (await request('GET', S('payment-methods'))).find((m) => m.kind === 'cash');
    const split = await sell({ payments: [{ amount: '60', methodId: cash.id, method: 'cash', tendered: '100' }, { amount: 'full', methodId: phonepe.id, method: 'upi' }] }, 201, '2');
    assert.equal(split.change, '40.00');
    const parts = (await request('GET', S(`documents/${split.id}`))).payments;
    assert.deepEqual(parts.map((p) => [p.method, p.method_name, p.amount]), [['cash', 'Cash', '60.00'], ['upi', 'PhonePe UPI', '40.00']]);
    // Change is given back from cash only, whatever the method is called.
    await sell({ payment: { amount: '50', methodId: phonepe.id, tendered: '100' } }, 400);
    // A kind that does not match the method is refused.
    await sell({ payment: { amount: 'full', methodId: phonepe.id, method: 'card' } }, 400);
  });

  await t.test('another business\'s method, or one switched off, is refused', async () => {
    const theirs = (await request('GET', O('payment-methods')))[0];
    await sell({ payment: { amount: 'full', methodId: theirs.id } }, 404);
    await sell({ payment: { amount: 'full', methodId: sodexo.id } }, 409);
    await request('POST', S(`documents/${phonepeSale.id}/payments`), { amount: '1', methodId: theirs.id, requestKey: key() }, 404);
  });

  await t.test('older screens sending the kind alone keep working', async () => {
    const sale = await sell({ payment: { amount: 'full', method: 'cash' } });
    const doc = await request('GET', S(`documents/${sale.id}`));
    assert.equal(doc.payments[0].method, 'cash');
    assert.equal(doc.payments[0].method_name, null);
  });

  await t.test('refunds, supplier payments and later payments take a named method too', async () => {
    // A refund never goes out by cheque, whatever the method is called.
    const chequeMethod = (await request('GET', S('payment-methods'))).find((m) => m.kind === 'cheque');
    const detail = await request('GET', S(`documents/${phonepeSale.id}`));
    await request('POST', S(`documents/${phonepeSale.id}/returns`), { reason: 'Damaged', requestKey: key(), lines: [{ lineId: detail.lines[0].id, quantity: '1', restock: true }] }, 201);
    await request('POST', S(`documents/${phonepeSale.id}/refunds`), { amount: '50', methodId: chequeMethod.id, reason: 'Returned', requestKey: key() }, 400);
    const refund = await request('POST', S(`documents/${phonepeSale.id}/refunds`), { amount: '50', methodId: phonepe.id, reason: 'Returned', requestKey: key() }, 201);
    assert.equal(refund.method, 'upi');
    assert.equal(refund.method_name, 'PhonePe UPI');
    // A supplier paid by a named bank account; a cheque still needs its number.
    const hdfc = await request('POST', S('payment-methods'), { name: 'HDFC current a/c', kind: 'bank' }, 201);
    await request('POST', S(`suppliers/${supplier.id}/payments`), { locationId: main.id, amount: '100', methodId: chequeMethod.id, requestKey: key() }, 400);
    const paid = await request('POST', S(`suppliers/${supplier.id}/payments`), { locationId: main.id, amount: '100', methodId: hdfc.id, reference: 'NEFT 1', requestKey: key() }, 201);
    assert.equal(paid.method, 'bank');
    assert.equal(paid.method_name, 'HDFC current a/c');
    assert.equal((await one('SELECT method_name FROM business_payments WHERE business_id=$1 AND supplier_payment_id=$2 LIMIT 1', [shop.id, paid.id])).method_name, 'HDFC current a/c');
    // A later payment on a bill.
    const customer = await request('POST', S('contacts'), { kind: 'customer', name: 'Kiran', phone: '9876500001' }, 201);
    const credit = await request('POST', S('documents'), { kind: 'sale', requestKey: key(), locationId: main.id, contactId: customer.id, lines: [{ skuId: soap.id, quantity: '1' }] }, 201);
    const later = await request('POST', S(`documents/${credit.id}/payments`), { amount: '20', methodId: phonepe.id, requestKey: key() }, 201);
    assert.equal(later.method_name, 'PhonePe UPI');
  });

  await t.test('the day close keeps kinds and shows the names', async () => {
    const day = await request('GET', S('reports/takings'));
    // By kind, as before: UPI = 50 (PhonePe bill) + 40 (split) + 20 (later).
    assert.equal(day.received.upi, '110.00');
    assert.equal(day.received.cash, '110.00');
    const received = day.byMethodName.received;
    assert.deepEqual(received.find((r) => r.name === 'PhonePe UPI'), { method: 'upi', name: 'PhonePe UPI', amount: '110.00' });
    // Older screens' cash (no name) shows under the kind's default name, with the named cash.
    assert.deepEqual(received.find((r) => r.method === 'cash'), { method: 'cash', name: 'Cash', amount: '110.00' });
    assert.deepEqual(day.byMethodName.refunds, [{ method: 'upi', name: 'PhonePe UPI', amount: '50.00' }]);
    assert.deepEqual(day.byMethodName.suppliers, [{ method: 'bank', name: 'HDFC current a/c', amount: '100.00' }]);
    assert.equal(day.refunds.upi, '50.00');
  });

  await t.test('a renamed method keeps the old name on earlier payments', async () => {
    await request('PATCH', S(`payment-methods/${phonepe.id}`), { name: 'PhonePe business' });
    const doc = await request('GET', S(`documents/${phonepeSale.id}`));
    assert.equal(doc.payments[0].method_name, 'PhonePe UPI');
  });

  await t.test('only those who look after settings change methods', async () => {
    const roles = (await request('GET', S('roles?limit=100'))).items;
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, 'Cashier', 'methods-cashier@test.invalid', hash]);
    await request('POST', S('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === 'cashier').id }, 201);
    const cashier = as(await login('methods-cashier@test.invalid'));
    assert.ok((await cashier('GET', S('payment-methods'))).length >= 5);
    await cashier('GET', S('payment-methods?all=true'), undefined, 403);
    await cashier('POST', S('payment-methods'), { name: 'Paytm', kind: 'upi' }, 403);
    await cashier('PATCH', S(`payment-methods/${phonepe.id}`), { active: false }, 403);
  });
});
