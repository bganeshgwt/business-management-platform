const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');

// Real onboarding (12 Oct 2026): the platform creates a business of any type
// for a customer with the owner's new login; the owner signs in, adds staff
// logins of their own, resets one's password, changes currency and time zone,
// and adds another business of their own. No restaurant or demo is involved.
test('onboarding: platform creates a business, owner signs in, staff logins, locale, owner adds a business', { timeout: 300000 }, async (t) => {
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
  process.env.MULTI_BUSINESS_DEVELOPMENT = 'false';
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const password = `Onboard-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const platformUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id', ['Platform Admin', 'platform@test.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformUser.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email, secret = password) => {
    const result = await call('POST', '/auth/login', { identifier: email, password: secret });
    return result.body.data?.token || null;
  };
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const platform = as(await login('platform@test.invalid'));
  const ownerPassword = 'Owner-pass-2026';
  const shop = {
    businessType: 'pharmacy', name: 'Arogya Medicals', code: 'arogya med', legalName: 'Arogya Medicals LLP', city: 'Mysuru', postalCode: '570001',
    stateCode: '29', currency: 'INR', timezone: 'Asia/Kolkata', locationName: 'Saraswathipuram', locationCode: 'SRP',
    owner: { email: 'owner@arogya.test', name: 'Shobha K', password: ownerPassword },
  };
  let business;

  await t.test('the platform creates a business with its owner', async () => {
    await platform('POST', '/users/platform/businesses', { ...shop, businessType: 'restaurant' }, 400);
    await platform('POST', '/users/platform/businesses', { ...shop, code: 'DEMO-X' }, 400);
    await platform('POST', '/users/platform/businesses', { ...shop, timezone: 'Mars/Olympus' }, 400);
    await platform('POST', '/users/platform/businesses', { ...shop, currency: 'XYZW' }, 400);
    await platform('POST', '/users/platform/businesses', { ...shop, owner: { email: 'owner@arogya.test' } }, 400);
    const created = await platform('POST', '/users/platform/businesses', shop, 201);
    business = created.business;
    assert.equal(business.code, 'AROGYA-MED');
    assert.equal(business.is_demo, false);
    assert.equal(created.owner.created, true);
    await platform('POST', '/users/platform/businesses', { ...shop, name: 'Again' }, 409);
    const list = await platform('GET', '/users/platform/businesses?type=pharmacy');
    const row = list.items.find((b) => b.id === business.id);
    assert.equal(row.owners[0].email, 'owner@arogya.test');
    assert.equal(row.locations, 1);
    // A restaurant's admin is not the platform.
    const r = await one("INSERT INTO restaurants(name,code) VALUES('R','RONB') RETURNING id");
    const radmin = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [r.id, 'R admin', 'radmin@test.invalid', hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [radmin.id]);
    await as(await login('radmin@test.invalid'))('GET', '/users/platform/businesses', undefined, 403);
  });

  const B = (suffix) => `/businesses/${business.id}/${suffix}`;
  let owner;
  await t.test('the owner signs in and finds a ready business', async () => {
    const token = await login('owner@arogya.test', ownerPassword);
    assert.ok(token);
    owner = as(token);
    const directory = await owner('GET', '/businesses');
    assert.equal(directory.businesses.length, 1);
    assert.equal(directory.businesses[0].id, business.id);
    const ctx = await owner('GET', B('context'));
    assert.equal(ctx.role.full_access, true);
    assert.equal(ctx.settings.legal_name, 'Arogya Medicals LLP');
    assert.equal(ctx.settings.state_code, '29');
    assert.deepEqual(ctx.locations.map((l) => l.code), ['SRP']);
    assert.ok(ctx.capabilities.includes('pharmacy'));
    assert.ok((await owner('GET', B('tax-rates'))).items.length >= 3);
  });

  let staffId;
  await t.test('the owner gives staff logins of their own', async () => {
    const roles = (await owner('GET', B('roles?limit=100'))).items;
    const cashier = roles.find((r) => r.template_code === 'cashier');
    const made = await owner('POST', B('staff-accounts'), { name: 'Ravi M', email: 'ravi@arogya.test', password: 'Ravi-pass-2026', roleId: cashier.id }, 201);
    staffId = made.user_id;
    assert.equal(made.role_name, cashier.name);
    await owner('POST', B('staff-accounts'), { name: 'Dup', email: 'ravi@arogya.test', password: 'Another-pass-1', roleId: cashier.id }, 409);
    // A bad role leaves no login behind.
    await owner('POST', B('staff-accounts'), { name: 'Nobody', email: 'nobody@arogya.test', password: 'Another-pass-1', roleId: 999999 }, 404);
    assert.equal(await one("SELECT id FROM users WHERE email='nobody@arogya.test'"), undefined);
    const ravi = as(await login('ravi@arogya.test', 'Ravi-pass-2026'));
    assert.equal((await ravi('GET', B('context'))).role.name, cashier.name);
    await ravi('POST', B('staff-accounts'), { name: 'X', email: 'x@arogya.test', password: 'Xxxxxxxx-1', roleId: cashier.id }, 403);
    // A new password ends Ravi's sessions.
    await owner('POST', B(`staff-accounts/${staffId}/password`), { password: 'Ravi-new-2026' });
    assert.equal(await login('ravi@arogya.test', 'Ravi-pass-2026'), null);
    assert.ok(await login('ravi@arogya.test', 'Ravi-new-2026'));
    await ravi('GET', B('context'), undefined, 401);
    // The owner's own password is not reset here.
    const ownerId = (await one("SELECT id FROM users WHERE email='owner@arogya.test'")).id;
    await owner('POST', B(`staff-accounts/${ownerId}/password`), { password: 'Whatever-123' }, 403);
  });

  await t.test('currency and time zone are the owner\'s to set until bills exist', async () => {
    const current = await owner('GET', B('settings'));
    assert.equal(current.currency, 'INR');
    const body = { displayName: 'Arogya Medicals', taxMode: 'inclusive', rounding: 'nearest_rupee', fiscalYearStartMonth: 4, dateFormat: 'DD/MM/YYYY' };
    await owner('PUT', B('settings'), { ...body, timezone: 'Nowhere/Here' }, 400);
    const saved = await owner('PUT', B('settings'), { ...body, currency: 'aed', timezone: 'Asia/Dubai' });
    assert.equal(saved.currency, 'AED');
    assert.equal((await owner('GET', B('context'))).business.timezone, 'Asia/Dubai');
    await owner('PUT', B('settings'), { ...body, currency: 'INR', timezone: 'Asia/Kolkata' });
    // Once a bill exists, the currency stays.
    const location = (await owner('GET', B('locations'))).items[0];
    const supplier = await owner('POST', B('contacts'), { kind: 'supplier', name: 'Distributor' }, 201);
    const item = await owner('POST', B('catalog'), { kind: 'goods', unit: 'strip', tracking: 'batch', taxRate: '5', name: 'Item', code: 'IT1', price: '10', hsnCode: '3004' }, 201);
    await owner('POST', B('documents'), { kind: 'purchase', requestKey: crypto.randomUUID(), locationId: location.id, contactId: supplier.id,
      lines: [{ skuId: item.id, quantity: '5', unitPrice: '5', lotCode: 'L1', expiresOn: new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10) }] }, 201);
    await owner('PUT', B('settings'), { ...body, currency: 'USD' }, 409);
    await owner('PUT', B('settings'), { ...body, timezone: 'Asia/Kolkata' });
  });

  await t.test('an owner adds another business of their own', async () => {
    const second = await owner('POST', '/businesses', { businessType: 'salon', name: 'Arogya Wellness Spa', code: 'AROGYA-SPA' }, 201);
    assert.equal(second.business_type, 'salon');
    const directory = await owner('GET', '/businesses');
    assert.equal(directory.businesses.length, 2);
    // Staff of the first business can be given access here too.
    const candidates = await owner('GET', `/businesses/${second.id}/member-candidates`);
    assert.ok(candidates.some((c) => Number(c.id) === Number(staffId)));
    // A cashier may not start businesses.
    const ravi = as(await login('ravi@arogya.test', 'Ravi-new-2026'));
    await ravi('POST', '/businesses', { businessType: 'grocery', name: 'Side shop', code: 'SIDE-SHOP' }, 403);
  });

  await t.test('switched off, the business is closed to its people', async () => {
    await platform('PUT', `/users/platform/businesses/${business.id}/status`, { status: 'inactive' });
    await owner('GET', B('context'), undefined, 404);
    await platform('PUT', `/users/platform/businesses/${business.id}/status`, { status: 'active' });
    assert.equal((await owner('GET', B('context'))).business.id, business.id);
    const ownerId = (await one("SELECT id FROM users WHERE email='owner@arogya.test'")).id;
    await platform('POST', `/users/platform/businesses/${business.id}/owner-password`, { userId: ownerId, password: 'Owner-reset-2026' });
    assert.ok(await login('owner@arogya.test', 'Owner-reset-2026'));
  });
});
