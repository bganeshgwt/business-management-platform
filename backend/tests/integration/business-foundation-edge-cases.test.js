const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const dates = require('./helpers/dates');
const { withTools } = require('./helpers/tools');

// Each case reproduces a problem in the business platform and pins its fix.
// Own throwaway database, all migrations.
test('business platform: round-off returns, whole units, overview figures, demotion, numbering, counts', { timeout: 240000 }, async (t) => {
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
  const password = `Platform-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('platform','platform') RETURNING id");
  await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
  const person = async (email) => one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, email, `${email}@test.invalid`, hash]);
  const owner = await person('shop-owner');
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [owner.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = async (name) => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: `${name}@test.invalid`, password }) })).json()).data.token;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
    return expected < 300 ? result.data : result;
  };
  const request = as(await login('shop-owner'));
  const key = () => crypto.randomUUID();
  const [grocery, pharmacy] = await withTools(request, await createBusinesses(request, 'OWNER', ['grocery', 'pharmacy']));
  // Goods shops start with prices including GST, rounded to the rupee, and a
  // walk-in pays in full. These checks use prices before GST and post unpaid
  // walk-in bills as fixtures.
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const root = (b, suffix) => `/businesses/${b.id}/${suffix}`;
  const location = (await request('GET', root(grocery, 'locations'))).items[0];
  const supplier = await request('POST', root(grocery, 'contacts'), { kind: 'supplier', name: 'Supplier' }, 201);
  const settings = { displayName: 'Corner grocery', fiscalYearStartMonth: 4, dateFormat: 'DD/MM/YYYY' };

  await t.test('round-off comes back in proportion: returns never exceed the rounded total, refunds never exceed what was paid', async () => {
    await request('PUT', root(grocery, 'settings'), { ...settings, taxMode: 'exclusive', rounding: 'nearest_rupee' });
    const big = await request('POST', root(grocery, 'catalog'), { name: 'Big item', code: 'BIG', kind: 'goods', unit: 'each', tracking: 'quantity', price: '100', taxRate: '0' }, 201);
    const small = await request('POST', root(grocery, 'catalog'), { name: 'Small piece', code: 'SMALL', kind: 'goods', unit: 'each', tracking: 'quantity', price: '0.20', taxRate: '0' }, 201);
    await request('POST', root(grocery, 'documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(),
      lines: [{ skuId: big.id, quantity: '5', unitPrice: '50' }, { skuId: small.id, quantity: '10', unitPrice: '0.10' }] }, 201);
    const sale = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(),
      lines: [{ skuId: big.id, quantity: '1' }, { skuId: small.id, quantity: '2' }] }, 201);
    assert.deepEqual([sale.subtotal, sale.round_off, sale.total], ['100.40', '-0.40', '100.00']);
    await request('POST', root(grocery, `documents/${sale.id}/payments`), { amount: '100', method: 'cash', requestKey: key() }, 201);
    const lines = (await request('GET', root(grocery, `documents/${sale.id}`))).lines;
    const bigLine = lines.find((l) => l.sku_id === big.id), smallLine = lines.find((l) => l.sku_id === small.id);
    const first = await request('POST', root(grocery, `documents/${sale.id}/returns`), { reason: 'Back', requestKey: key(),
      lines: [{ lineId: bigLine.id, quantity: '1', restock: true }, { lineId: smallLine.id, quantity: '1', restock: true }] }, 201);
    assert.deepEqual([first.total, first.round_off], ['99.80', '-0.40']);
    // The customer still holds one piece: ₹100.20 back would be more than they paid for what they returned.
    await request('POST', root(grocery, `documents/${sale.id}/refunds`), { amount: '100.20', method: 'cash', reason: 'x', requestKey: key() }, 409);
    await request('POST', root(grocery, `documents/${sale.id}/refunds`), { amount: '99.80', method: 'cash', reason: 'Returned', requestKey: key() }, 201);
    // The last piece can come back, and the shares add up exactly.
    const last = await request('POST', root(grocery, `documents/${sale.id}/returns`), { reason: 'Back', requestKey: key(), lines: [{ lineId: smallLine.id, quantity: '1', restock: true }] }, 201);
    assert.deepEqual([last.total, last.round_off], ['0.20', '0.00']);
    const sums = await one('SELECT sum(total) AS total, sum(round_off) AS round_off FROM business_returns WHERE document_id=$1', [sale.id]);
    assert.deepEqual([Number(sums.total), Number(sums.round_off)], [100, -0.4]);
    await request('POST', root(grocery, `documents/${sale.id}/refunds`), { amount: '0.21', method: 'cash', reason: 'x', requestKey: key() }, 409);
    await request('POST', root(grocery, `documents/${sale.id}/refunds`), { amount: '0.20', method: 'cash', reason: 'Last piece', requestKey: key() }, 201);
    const done = await request('GET', root(grocery, 'documents?kind=sale'));
    const row = done.items.find((d) => d.id === sale.id);
    assert.equal(Math.round((Number(row.total) - Number(row.returned) - Number(row.paid) + Number(row.refunded)) * 100), 0, 'nothing owed either way');
    // A refund can never exceed what was paid, even when credit is shown.
    const unpaid = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: big.id, quantity: '1' }] }, 201);
    const unpaidLine = (await request('GET', root(grocery, `documents/${unpaid.id}`))).lines[0];
    await request('POST', root(grocery, `documents/${unpaid.id}/returns`), { reason: 'Back', requestKey: key(), lines: [{ lineId: unpaidLine.id, quantity: '1', restock: true }] }, 201);
    await request('POST', root(grocery, `documents/${unpaid.id}/refunds`), { amount: '1', method: 'cash', reason: 'x', requestKey: key() }, 409);

    // Tax-inclusive one-paisa pieces: every piece comes back, none goes below zero.
    await request('PUT', root(grocery, 'settings'), { ...settings, taxMode: 'inclusive', rounding: 'nearest_rupee' });
    const paisa = await request('POST', root(grocery, 'catalog'), { name: 'Paisa sweet', code: 'PAISA', kind: 'goods', unit: 'each', tracking: 'quantity', price: '0.01', taxRate: '18' }, 201);
    await request('POST', root(grocery, 'documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [{ skuId: paisa.id, quantity: '10', unitPrice: '0.01' }] }, 201);
    const tiny = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: paisa.id, quantity: '3' }] }, 201);
    assert.equal(tiny.total, '0.00');
    const tinyLine = (await request('GET', root(grocery, `documents/${tiny.id}`))).lines[0];
    for (let n = 0; n < 3; n += 1) {
      const back = await request('POST', root(grocery, `documents/${tiny.id}/returns`), { reason: 'Back', requestKey: key(), lines: [{ lineId: tinyLine.id, quantity: '1', restock: true }] }, 201);
      assert.ok(Number(back.total) >= 0);
    }
    assert.equal(Number((await one('SELECT sum(total) AS t FROM business_returns WHERE document_id=$1', [tiny.id])).t), 0);
    await request('POST', root(grocery, `documents/${tiny.id}/refunds`), { amount: '0.01', method: 'cash', reason: 'x', requestKey: key() }, 409);
    await request('PUT', root(grocery, 'settings'), { ...settings, taxMode: 'exclusive', rounding: 'none' });
  });

  await t.test('whole-unit items stay whole in returns, transfers, counts, sales and pack lines', async () => {
    const loc = (await request('GET', root(pharmacy, 'locations'))).items[0];
    const branch = await request('POST', root(pharmacy, 'locations'), { name: 'Branch', code: 'BR' }, 201);
    const vendor = await request('POST', root(pharmacy, 'contacts'), { kind: 'supplier', name: 'Vendor' }, 201);
    const tablet = await request('POST', root(pharmacy, 'catalog'), { name: 'Paracetamol', code: 'PCM', kind: 'goods', unit: 'tablet', tracking: 'batch', price: '2', taxRate: '5' }, 201);
    await request('POST', root(pharmacy, 'pack-sizes'), { skuId: tablet.id, unitCode: 'strip', quantityInBase: '10' }, 201);
    await request('POST', root(pharmacy, 'documents'), { kind: 'purchase', locationId: loc.id, contactId: vendor.id, requestKey: key(),
      lines: [{ skuId: tablet.id, unit: 'strip', quantity: '30', unitPrice: '12', lotCode: 'B1', expiresOn: '2099-01-01' }] }, 201);
    await request('POST', root(pharmacy, 'documents'), { kind: 'purchase', locationId: loc.id, contactId: vendor.id, requestKey: key(),
      lines: [{ skuId: tablet.id, unit: 'strip', quantity: '0.5', unitPrice: '12', lotCode: 'B1', expiresOn: '2099-01-01' }] }, 400);
    await request('POST', root(pharmacy, 'documents'), { kind: 'sale', locationId: loc.id, requestKey: key(), lines: [{ skuId: tablet.id, quantity: '2.5', lotCode: 'B1' }] }, 400);
    const sale = await request('POST', root(pharmacy, 'documents'), { kind: 'sale', locationId: loc.id, requestKey: key(), lines: [{ skuId: tablet.id, quantity: '36', lotCode: 'B1' }] }, 201);
    const line = (await request('GET', root(pharmacy, `documents/${sale.id}`))).lines[0];
    const refused = await request('POST', root(pharmacy, `documents/${sale.id}/returns`), { reason: 'Half', requestKey: key(), lines: [{ lineId: line.id, quantity: '0.5', restock: true }] }, 400);
    assert.match(refused.message, /whole/);
    await request('POST', root(pharmacy, `documents/${sale.id}/returns`), { reason: 'Back', requestKey: key(), lines: [{ lineId: line.id, quantity: '1', restock: true }] }, 201);
    const lot = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [pharmacy.id, tablet.id]);
    assert.equal(Number(lot.quantity), 265);
    await request('POST', root(pharmacy, 'transfers'), { fromLocationId: loc.id, toLocationId: branch.id, requestKey: key(), lines: [{ lotId: lot.id, quantity: '0.5' }] }, 400);
    await request('POST', root(pharmacy, `stock/${lot.id}/adjustments`), { quantity: '-0.5', reason: 'x', requestKey: key() }, 400);
    const count = await request('POST', root(pharmacy, 'counts'), { locationId: loc.id, requestKey: key() }, 201);
    const sheet = await request('GET', root(pharmacy, `counts/${count.id}`));
    await request('PATCH', root(pharmacy, `counts/${count.id}/lines`), { lines: [{ lineId: sheet.lines[0].id, countedQuantity: '264.5' }] }, 400);
    assert.equal(Number((await one('SELECT quantity FROM business_stock_lots WHERE id=$1', [lot.id])).quantity), 265);
  });

  // Staff for the role tests.
  const staff = {};
  for (const name of ['shop-keeper', 'shop-cashier', 'shop-manager', 'shop-super', 'shop-helper']) {
    const user = await person(name);
    staff[name] = { id: user.id, token: await login(name) };
  }
  const roles = async () => (await request('GET', root(grocery, 'roles'))).items;
  const roleId = async (template) => (await roles()).find((r) => r.template_code === template).id;

  await t.test('the overview sends only the figures each role may see', async () => {
    await request('POST', root(grocery, 'members'), { userId: staff['shop-keeper'].id, roleId: await roleId('stock_keeper') }, 201);
    await request('POST', root(grocery, 'members'), { userId: staff['shop-cashier'].id, roleId: await roleId('cashier') }, 201);
    const full = await request('GET', root(grocery, 'summary'));
    for (const figure of ['sales_today', 'sales_month', 'receivables', 'payables', 'low_stock']) assert.ok(figure in full, figure);
    const keeper = await as(staff['shop-keeper'].token)('GET', root(grocery, 'summary'));
    for (const hidden of ['sales_today', 'sales_month', 'sales', 'receivables', 'appointments_today']) assert.ok(!(hidden in keeper), `keeper must not see ${hidden}`);
    assert.ok('low_stock' in keeper && 'payables' in keeper, 'a stock keeper sees purchases owed and stock');
    const cashier = await as(staff['shop-cashier'].token)('GET', root(grocery, 'summary'));
    assert.ok(!('payables' in cashier) && 'sales_today' in cashier && !('counts_open' in cashier));
  });

  await t.test('nobody changes, demotes or switches off a person or role above them', async () => {
    await request('POST', root(grocery, 'members'), { userId: staff['shop-manager'].id, roleId: await roleId('manager') }, 201);
    const supervisor = await request('POST', root(grocery, 'roles'), { name: 'Access clerk', permissions: ['access.view', 'access.edit', 'sales.view'] }, 201);
    const helper = await request('POST', root(grocery, 'roles'), { name: 'Counter help', permissions: ['sales.view'] }, 201);
    await request('POST', root(grocery, 'members'), { userId: staff['shop-super'].id, roleId: supervisor.id }, 201);
    await request('POST', root(grocery, 'members'), { userId: staff['shop-helper'].id, roleId: helper.id }, 201);
    const clerk = as(staff['shop-super'].token);
    const managerRole = (await roles()).find((r) => r.template_code === 'manager');
    await clerk('POST', root(grocery, 'members'), { userId: staff['shop-manager'].id, roleId: helper.id, active: false }, 403);
    await clerk('POST', root(grocery, 'members'), { userId: staff['shop-manager'].id, roleId: helper.id }, 403);
    await clerk('PATCH', root(grocery, `roles/${managerRole.id}`), { name: 'Manager', permissions: managerRole.permissions.filter((p) => p !== 'sales.view') }, 403);
    await clerk('PATCH', root(grocery, `roles/${managerRole.id}`), { name: 'Manager', permissions: managerRole.permissions, active: false }, 403);
    const after = (await roles()).find((r) => r.template_code === 'manager');
    assert.ok(after.permissions.includes('sales.view') && after.active);
    assert.equal((await one('SELECT active FROM business_memberships WHERE business_id=$1 AND user_id=$2', [grocery.id, staff['shop-manager'].id])).active, true);
    // Within their reach, the clerk can still act.
    await clerk('POST', root(grocery, 'members'), { userId: staff['shop-helper'].id, roleId: helper.id, active: false }, 201);
    await clerk('PATCH', root(grocery, `roles/${helper.id}`), { name: 'Counter help', permissions: [] });
  });

  await t.test('the financial-year start is fixed once documents are numbered; new series start after numbers already used', async () => {
    const refused = await request('PUT', root(grocery, 'settings'), { ...settings, fiscalYearStartMonth: 1, taxMode: 'exclusive', rounding: 'none' }, 409);
    assert.match(refused.message, /financial year start/);
    assert.equal((await request('GET', root(grocery, 'settings'))).fiscal_year_start_month, 4);
    // A number printed with a prefix before any series existed (legacy or re-created).
    const doc = await one("SELECT id FROM business_documents WHERE business_id=$1 AND kind='sale' ORDER BY id LIMIT 1", [grocery.id]);
    await pool.query("UPDATE business_documents SET document_no='OLD/0007' WHERE id=$1", [doc.id]);
    const branch = await request('POST', root(grocery, 'locations'), { name: 'Second shop', code: 'S2' }, 201);
    const [year, month] = dates.today().split('-').map(Number);
    const fy = month >= 4 ? year : year - 1;
    const series = await request('POST', root(grocery, 'number-series'), { locationId: branch.id, documentKind: 'sale', fiscalYear: fy, prefix: 'OLD/', padding: 4, nextNumber: 1 }, 201);
    assert.equal(Number(series.next_number), 8);
    const refusedBack = await request('PATCH', root(grocery, `number-series/${series.id}`), { prefix: 'OLD/', padding: 4, nextNumber: 5 }, 409);
    assert.match(refusedBack.message, /already used/);
    const big = (await request('GET', root(grocery, 'catalog?q=BIG'))).items[0];
    const vendor = (await request('GET', root(grocery, 'contacts?kind=supplier'))).items[0];
    await request('POST', root(grocery, 'documents'), { kind: 'purchase', locationId: branch.id, contactId: vendor.id, requestKey: key(), lines: [{ skuId: big.id, quantity: '1', unitPrice: '50' }] }, 201);
    const next = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: branch.id, requestKey: key(), lines: [{ skuId: big.id, quantity: '1' }] }, 201);
    assert.equal(next.document_no, 'OLD/0008');
  });

  await t.test('a reused count key with other content is refused; another business\'s category is not found', async () => {
    const body = { locationId: location.id, requestKey: key() };
    const count = await request('POST', root(grocery, 'counts'), body, 201);
    assert.equal((await request('POST', root(grocery, 'counts'), body, 201)).id, count.id);
    const branch = (await request('GET', root(grocery, 'locations'))).items.find((l) => l.code === 'S2');
    await request('POST', root(grocery, 'counts'), { ...body, locationId: branch.id }, 409);
    await request('POST', root(grocery, 'counts'), { ...body, notes: 'different' }, 409);
    await request('POST', root(grocery, `counts/${count.id}/cancel`), { reason: 'Test' });
    const foreign = await request('POST', root(pharmacy, 'categories'), { name: 'Pharmacy only' }, 201);
    const refused = await request('POST', root(grocery, 'counts'), { locationId: location.id, categoryId: foreign.id, requestKey: key() }, 404);
    assert.match(refused.message, /Category not found/);
  });
});
