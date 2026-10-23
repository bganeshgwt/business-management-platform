const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom } = require('./helpers/dates');

// Business rules: the owner sets the customer-credit age groups,
// "expiring soon", credit-voucher validity, the quick weight buttons, the
// receipt paper and the day cut-off; each starts at what the code used to fix.
test('business rules: defaults, validation, age groups and expiring soon follow the settings', { timeout: 300000 }, async (t) => {
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
  const password = `Rules-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Rules','RULES') RETURNING id");
  await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
  const ownerUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, 'Rules owner', 'rules-owner@test.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [ownerUser.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const token = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'rules-owner@test.invalid', password }) })).json()).data.token;
  async function request(method, route, body, expected = 200) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const json = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(json)}`);
    return json.data ?? json;
  }
  const [shop] = await createBusinesses(request, 'RULES', ['supermarket']);
  const S = (suffix) => `/businesses/${shop.id}/${suffix}`;
  const basics = { displayName: 'Rule shop', taxMode: 'inclusive', rounding: 'none', fiscalYearStartMonth: 4, dateFormat: 'DD/MM/YYYY' };
  const daysAgo = (n) => daysFrom(-n);

  await t.test('defaults are the old fixed values', async () => {
    const ctx = await request('GET', S('context'));
    assert.equal(ctx.settings.voucher_valid_days, 90);
    assert.deepEqual(ctx.settings.ageing_days, [30, 60, 90]);
    assert.equal(ctx.settings.near_expiry_days, 30);
    assert.deepEqual(ctx.settings.weight_buttons_grams, [250, 500, 1000, 2000]);
    assert.equal(ctx.settings.receipt_width_mm, 80);
    assert.equal(ctx.settings.day_cutoff_hour, 5);
  });

  await t.test('rules are checked and saved; an older client keeps them', async () => {
    await request('PUT', S('settings'), { ...basics, ageingDays: [30, 30, 90] }, 400);
    await request('PUT', S('settings'), { ...basics, ageingDays: [30, 60] }, 400);
    await request('PUT', S('settings'), { ...basics, weightButtonsGrams: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, 400);
    await request('PUT', S('settings'), { ...basics, receiptWidthMm: 72 }, 400);
    await request('PUT', S('settings'), { ...basics, dayCutoffHour: 13 }, 400);
    await request('PUT', S('settings'), { ...basics, nearExpiryDays: 0 }, 400);
    const saved = await request('PUT', S('settings'), { ...basics, ageingDays: [15, 45, 120], nearExpiryDays: 10, voucherValidDays: 30,
      weightButtonsGrams: [1000, 100, 250, 250], receiptWidthMm: 58, dayCutoffHour: 3 });
    assert.deepEqual(saved.ageing_days, [15, 45, 120]);
    assert.deepEqual(saved.weight_buttons_grams, [100, 250, 1000]);
    assert.equal(saved.receipt_width_mm, 58);
    const kept = await request('PUT', S('settings'), basics);
    assert.deepEqual(kept.ageing_days, [15, 45, 120]);
    assert.deepEqual((await request('GET', S('context'))).settings.ageing_days, [15, 45, 120]);
  });

  await t.test('customer credit falls into the business\'s own age groups', async () => {
    const customer = await request('POST', S('contacts'), { kind: 'customer', name: 'Credit customer', openingBalance: '500', openingBalanceOn: daysAgo(40) }, 201);
    const outstanding = await request('GET', S(`outstanding?q=${encodeURIComponent('Credit customer')}`));
    const row = outstanding.items.find((r) => Number(r.contact_id) === Number(customer.id));
    // 40 days old with groups 15 / 45 / 120: the second group.
    assert.equal(Number(row.days_31_60), 500);
    assert.equal(Number(row.days_0_30), 0);
    await request('PUT', S('settings'), { ...basics, ageingDays: [30, 60, 90] });
    const again = (await request('GET', S(`outstanding?q=${encodeURIComponent('Credit customer')}`))).items.find((r) => Number(r.contact_id) === Number(customer.id));
    assert.equal(Number(again.days_31_60), 500);
    await request('PUT', S('settings'), { ...basics, ageingDays: [50, 60, 90] });
    const third = (await request('GET', S(`outstanding?q=${encodeURIComponent('Credit customer')}`))).items.find((r) => Number(r.contact_id) === Number(customer.id));
    assert.equal(Number(third.days_0_30), 500);
  });

  await t.test('expiring soon follows the business\'s days', async () => {
    const location = (await request('GET', S('locations'))).items[0];
    const supplier = await request('POST', S('contacts'), { kind: 'supplier', name: 'Dairy' }, 201);
    const curd = await request('POST', S('catalog'), { kind: 'goods', unit: 'each', tracking: 'batch', taxRate: '5', name: 'Curd', code: 'CURD', price: '40', hsnCode: '0403' }, 201);
    await request('POST', S('documents'), { kind: 'purchase', requestKey: crypto.randomUUID(), locationId: location.id, contactId: supplier.id,
      lines: [{ skuId: curd.id, quantity: '10', unitPrice: '30', lotCode: 'C20', expiresOn: daysFrom(20) }] }, 201);
    await request('PUT', S('settings'), { ...basics, nearExpiryDays: 10 });
    assert.equal(Number((await request('GET', S('summary'))).expiring_soon), 0);
    assert.equal((await request('GET', S('retail/near-expiry'))).totals.batches, 0);
    assert.equal((await request('GET', S('stock?expiring=true'))).total, 0);
    await request('PUT', S('settings'), { ...basics, nearExpiryDays: 30 });
    assert.equal(Number((await request('GET', S('summary'))).expiring_soon), 1);
    assert.equal((await request('GET', S('stock?expiring=true'))).total, 1);
  });

  await t.test('the task day cut-off follows the business', async () => {
    const recurrence = require('../../src/modules/tasks/services/recurrence.service');
    const at2 = recurrence.slotsOn({ frequency: 'daily', due_times: ['02:00'] }, '2026-10-07', null, '03:00');
    assert.ok(at2[0].due.startsWith('2026-10-08'));
    const at4 = recurrence.slotsOn({ frequency: 'daily', due_times: ['04:00'] }, '2026-10-07', null, '03:00');
    assert.ok(at4[0].due.startsWith('2026-10-07'));
  });
});
