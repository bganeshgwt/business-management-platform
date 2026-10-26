const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses, ALL_TYPES } = require('./helpers/businesses');
const dates = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The foundation: module catalogue, per-business roles and permissions,
// settings, GST slabs, number series, categories, units, credit terms,
// transfers, counts and the event outbox. Runs against its own throwaway
// database with every migration applied, like business-admin.test.js.
test('business platform foundation: access, numbering, stock control and events', { timeout: 240000 }, async (t) => {
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
  const password = `Foundation-${crypto.randomBytes(8).toString('hex')}`;
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('foundation-owner');
  await owner('foundation-other');
  const token = await login('foundation-owner@test.invalid');
  const otherToken = await login('foundation-other@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();

  // One business of every type a business can be but restaurant, so the first check covers each.
  const businesses = await createBusinesses(request, 'OWNER', ALL_TYPES);
  // Goods shops start with prices including GST, rounded to the rupee, and a
  // walk-in pays in full. These checks use prices before GST and post unpaid
  // walk-in bills as fixtures.
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const byType = (type) => businesses.find((b) => b.business_type === type);
  const grocery = byType('grocery'), electronics = byType('electronics'), salon = byType('salon'), pharmacy = byType('pharmacy');
  const root = (business, suffix) => `/businesses/${business.id}/${suffix}`;

  await t.test('every new business is provisioned with roles, settings, GST slabs, units and its default modules', async () => {
    for (const business of businesses) {
      const counts = await one(`SELECT
        (SELECT count(*)::int FROM business_roles WHERE business_id=$1) AS roles,
        (SELECT count(*)::int FROM business_settings WHERE business_id=$1) AS settings,
        (SELECT count(*)::int FROM business_tax_rates WHERE business_id=$1) AS taxes,
        (SELECT count(*)::int FROM business_units WHERE business_id=$1) AS units`, [business.id]);
      // The six shared roles, plus the type's own (pharmacist; doctor, lab technician, pathologist).
      const ownRoles = (await one('SELECT count(*)::int AS n FROM business_role_templates WHERE $1 = ANY(business_types)', [business.business_type])).n;
      // GST nil, 5, 18 and 40; a jeweller nil, 0.25, 1.5, 3, 5 and 18.
      const slabs = business.business_type === 'jewellery' ? 6 : 4;
      assert.deepEqual([counts.roles, counts.settings, counts.taxes], [6 + ownRoles, 1, slabs], business.business_type);
      assert.ok(counts.units >= 8, `${business.business_type} has its units`);
      const expected = (await rows(`SELECT module_code FROM platform_module_business_types WHERE business_type=$1 AND enabled_by_default ORDER BY 1`, [business.business_type])).map((r) => r.module_code);
      assert.deepEqual([...business.capabilities].sort(), expected, business.business_type);
      assert.equal(business.role_name, 'Owner');
    }
    // Stock counts remain available; transfers are now an owner's optional tool.
    assert.ok(grocery.capabilities.includes('stock_counts') && !grocery.capabilities.includes('stock_transfers'));
    assert.ok(!electronics.capabilities.includes('stock_transfers') && electronics.capabilities.includes('serials'));
    assert.ok(!salon.capabilities.includes('stock_transfers'));
    // Each trade's own units: hardware sells by the bag, coil, sheet and foot; a
    // jeweller weighs stones in carats; a lodge sells room nights; hire is by the day.
    const unitsOf = async (business) => new Set((await rows('SELECT code FROM business_units WHERE business_id=$1', [business.id])).map((r) => r.code));
    const hardwareUnits = await unitsOf(byType('hardware'));
    for (const code of ['bag', 'coil', 'roll', 'sheet', 'set', 'dozen', 'ft', 'quintal', 'tonne']) assert.ok(hardwareUnits.has(code), `hardware has ${code}`);
    assert.equal(Number((await one("SELECT factor_to_base FROM business_units WHERE business_id=$1 AND code='ft'", [byType('hardware').id])).factor_to_base), 0.3048);
    assert.ok((await unitsOf(byType('agri_inputs'))).has('packet') && (await unitsOf(byType('jewellery'))).has('ct'));
    assert.ok((await unitsOf(byType('lodging'))).has('night') && (await unitsOf(byType('rentals'))).has('day'));
    assert.ok(!(await unitsOf(byType('grocery'))).has('coil'), 'a kirana has no hardware units');
    // A jeweller bills at 3% unless an item says otherwise; seeds and pesticides
    // are sold by batch; a gym keeps no stock until it chooses to, but collects dues.
    assert.equal(Number((await one('SELECT rate FROM business_tax_rates WHERE business_id=$1 AND is_default', [byType('jewellery').id])).rate), 3);
    assert.ok(byType('agri_inputs').capabilities.includes('batches'));
    assert.ok(!byType('memberships').capabilities.includes('inventory') && byType('memberships').capabilities.includes('receivables'));
  });

  await t.test('the module catalogue is enforced by the database', async () => {
    await assert.rejects(pool.query("INSERT INTO business_capabilities(business_id,capability) VALUES($1,'made_up')", [grocery.id]), { code: '23503' });
    await assert.rejects(pool.query("INSERT INTO business_capabilities(business_id,capability) VALUES($1,'serials')", [salon.id]), /does not apply/);
    await assert.rejects(pool.query("INSERT INTO business_capabilities(business_id,capability) VALUES($1,'settings')", [grocery.id]), /always on/);
    await assert.rejects(pool.query("DELETE FROM business_capabilities WHERE business_id=$1 AND capability='inventory'", [grocery.id]), /needed by/);
    await assert.rejects(pool.query("UPDATE businesses SET business_type='salon' WHERE id=$1", [grocery.id]), /cannot be changed/);
    // Through the API: a salon has no transfers until an owner switches them on.
    await request('GET', root(salon, 'transfers'), undefined, 403);
    await request('PUT', root(salon, 'modules/serials'), { enabled: true }, 409);
    await request('PUT', root(salon, 'modules/inventory'), { enabled: false }, 409);
    await request('PUT', root(salon, 'modules/stock_transfers'), { enabled: true });
    await request('GET', root(salon, 'transfers'));
    await request('PUT', root(salon, 'modules/stock_transfers'), { enabled: false });
    await request('GET', root(salon, 'transfers'), undefined, 403);
    const modules = await request('GET', root(salon, 'modules'));
    assert.ok(modules.find((m) => m.code === 'appointments').enabled);
    assert.ok(!modules.some((m) => m.code === 'serials'), 'modules a type cannot use are not offered');
  });

  // Staff of the owner's restaurant, each given one template role in the grocery.
  const staff = {};
  for (const template of ['manager', 'cashier', 'stock_keeper', 'accountant', 'viewer']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      [ownerUser.restaurant_id, `Grocery ${template}`, `grocery-${template}@test.invalid`, hash]);
    staff[template] = { id: person.id, token: await login(`grocery-${template}@test.invalid`) };
  }
  let location, location2, supplier, customer, rice, biscuit;
  await t.test('owners give template roles; the Owner role and self-changes are refused', async () => {
    const roles = (await request('GET', root(grocery, 'roles'))).items;
    assert.deepEqual(roles.map((r) => r.template_code).sort(), ['accountant', 'cashier', 'manager', 'owner', 'stock_keeper', 'viewer']);
    const ownerRole = roles.find((r) => r.full_access);
    for (const [template, person] of Object.entries(staff)) {
      const role = roles.find((r) => r.template_code === template);
      await request('POST', root(grocery, 'members'), { userId: person.id, roleId: role.id }, 201);
    }
    await request('POST', root(grocery, 'members'), { userId: staff.viewer.id, roleId: ownerRole.id }, 409);
    await request('PATCH', root(grocery, `roles/${ownerRole.id}`), { name: 'Boss', permissions: [] }, 409);
    await request('POST', root(grocery, 'members'), { userId: ownerUser.id, role: 'viewer' }, 409);
    // A role from another business cannot be pointed at, even directly in SQL.
    const foreignRole = await one("SELECT id FROM business_roles WHERE business_id=$1 AND template_code='manager'", [electronics.id]);
    await assert.rejects(pool.query('UPDATE business_memberships SET role_id=$3 WHERE business_id=$1 AND user_id=$2', [grocery.id, staff.viewer.id, foreignRole.id]), { code: '23503' });

    location = (await request('GET', root(grocery, 'locations'))).items[0];
    location2 = await request('POST', root(grocery, 'locations'), { name: 'Warehouse', code: 'WH' }, 201);
    supplier = await request('POST', root(grocery, 'contacts'), { kind: 'supplier', name: 'Agarwal Traders', creditDays: 15 }, 201);
    customer = await request('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'Hotel Annapurna', gstin: '27AAPFU0939F1ZV' }, 201);
    rice = await request('POST', root(grocery, 'catalog'), { name: 'Sona Masoori rice', code: 'RICE', kind: 'goods', unit: 'kg', tracking: 'batch', price: '60', taxRate: '5' }, 201);
    assert.ok(rice.tax_rate_id, 'a bare rate adopts the matching GST slab');
    await request('POST', root(grocery, 'documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(),
      lines: [{ skuId: rice.id, quantity: '50', unitPrice: '42', lotCode: 'R-01', expiresOn: '2099-01-01' }] }, 201);
  });

  await t.test('each role is allowed exactly its own actions, checked on the server', async () => {
    const sale = (overrides = {}) => ({ kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: rice.id, quantity: '1', lotCode: 'R-01' }], ...overrides });
    const purchase = () => ({ kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [{ skuId: rice.id, quantity: '1', unitPrice: '42', lotCode: 'R-01', expiresOn: '2099-01-01' }] });
    const lot = (await request('GET', root(grocery, 'stock'))).items[0];
    const cashier = as(staff.cashier.token), keeper = as(staff.stock_keeper.token), accountant = as(staff.accountant.token), viewer = as(staff.viewer.token), manager = as(staff.manager.token);

    const cashierSale = await cashier('POST', root(grocery, 'documents'), sale(), 201);
    await cashier('POST', root(grocery, 'documents'), purchase(), 403);
    await cashier('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'Walk-in regular' }, 201);
    await cashier('PATCH', root(grocery, `contacts/${customer.id}`), { name: 'Renamed', active: true }, 403);
    await cashier('POST', root(grocery, 'catalog'), { name: 'X', code: 'X1', kind: 'goods', unit: 'kg', tracking: 'quantity', price: '1' }, 403);
    await cashier('POST', root(grocery, `stock/${lot.id}/adjustments`), { quantity: '-1', reason: 'x', requestKey: key() }, 403);
    await cashier('POST', root(grocery, `documents/${cashierSale.id}/payments`), { amount: '10', method: 'cash', requestKey: key() }, 201);
    await cashier('POST', root(grocery, `documents/${cashierSale.id}/returns`), { reason: 'x', requestKey: key(), lines: [] }, 403);
    await cashier('PUT', root(grocery, 'settings'), {}, 403);
    await cashier('GET', root(grocery, 'members'), undefined, 403);
    await cashier('GET', root(grocery, 'audit'), undefined, 403);
    const cashierDocs = await cashier('GET', root(grocery, 'documents'));
    assert.ok(cashierDocs.items.every((d) => d.kind === 'sale'), 'a cashier sees sales only');
    await cashier('GET', root(grocery, 'documents?kind=purchase'), undefined, 403);

    await keeper('POST', root(grocery, 'documents'), purchase(), 201);
    await keeper('POST', root(grocery, 'documents'), sale(), 403);
    await keeper('POST', root(grocery, `stock/${lot.id}/adjustments`), { quantity: '-0.5', reason: 'Torn bag', requestKey: key() }, 201);
    await keeper('POST', root(grocery, `documents/${cashierSale.id}/payments`), { amount: '1', method: 'cash', requestKey: key() }, 403);
    await keeper('GET', root(grocery, 'reports?from=2026-01-01&to=2026-01-02'), undefined, 403);

    await accountant('POST', root(grocery, `documents/${cashierSale.id}/payments`), { amount: '1', method: 'upi', requestKey: key() }, 201);
    await accountant('POST', root(grocery, 'documents'), sale(), 403);
    await accountant('POST', root(grocery, `stock/${lot.id}/adjustments`), { quantity: '-1', reason: 'x', requestKey: key() }, 403);
    await accountant('GET', root(grocery, 'reports?from=2026-01-01&to=2026-01-02'));
    await accountant('GET', root(grocery, 'audit'));

    await viewer('GET', root(grocery, 'documents'));
    await viewer('GET', root(grocery, 'settings'));
    await viewer('POST', root(grocery, 'documents'), sale(), 403);
    await viewer('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'No' }, 403);
    await viewer('PUT', root(grocery, 'modules/stock_transfers'), { enabled: true }, 403);

    // A manager runs everything but staff access.
    await manager('POST', root(grocery, 'documents'), purchase(), 201);
    await manager('GET', root(grocery, 'members'), undefined, 403);
    await manager('POST', root(grocery, 'members'), { userId: staff.viewer.id, role: 'manager' }, 403);
    // The forbidden message names what was refused.
    const refused = await call('POST', root(grocery, 'documents'), sale(), staff.viewer.token);
    assert.match(refused.body.message, /Viewer.*record a new sale/i);
  });

  await t.test('people with access rights cannot hand out more than they hold', async () => {
    const supervisor = await request('POST', root(grocery, 'roles'), { name: 'Shift supervisor', permissions: ['access.view', 'access.edit', 'sales.view', 'sales.create', 'contacts.view'] }, 201);
    await request('POST', root(grocery, 'roles'), { name: 'Bad', permissions: ['sales.fly'] }, 400);
    await request('POST', root(grocery, 'members'), { userId: staff.cashier.id, roleId: supervisor.id }, 201);
    const sup = as(staff.cashier.token);
    const roles = (await sup('GET', root(grocery, 'roles'))).items;
    await sup('POST', root(grocery, 'members'), { userId: staff.viewer.id, roleId: roles.find((r) => r.template_code === 'manager').id }, 403);
    await sup('POST', root(grocery, 'roles'), { name: 'Refunder', permissions: ['sales.refund'] }, 403);
    await sup('POST', root(grocery, 'roles'), { name: 'Counter help', permissions: ['sales.view', 'sales.create'] }, 201);
    await sup('POST', root(grocery, 'members'), { userId: staff.cashier.id, role: 'viewer' }, 403);
    // Switching off a role in use is refused; the owner puts the cashier back.
    await request('PATCH', root(grocery, `roles/${supervisor.id}`), { name: 'Shift supervisor', permissions: [], active: false }, 409);
    await request('POST', root(grocery, 'members'), { userId: staff.cashier.id, role: 'cashier' }, 201);
  });

  await t.test('settings belong to one business and drive tax-inclusive pricing and rounding', async () => {
    const settings = { displayName: 'Annapurna Stores', legalName: 'Annapurna Stores Pvt Ltd', gstin: '27AAPFU0939F1ZV', taxMode: 'inclusive',
      rounding: 'nearest_rupee', fiscalYearStartMonth: 4, dateFormat: 'DD/MM/YYYY', postalCode: '411001', city: 'Pune' };
    await request('PUT', root(grocery, 'settings'), { ...settings, gstin: '27AAPFU0939F1ZX' }, 400);
    await request('PUT', root(grocery, 'settings'), { ...settings, stateCode: '29' }, 400);
    const saved = await request('PUT', root(grocery, 'settings'), settings);
    assert.equal(saved.state_code, '27');
    assert.equal((await request('GET', root(electronics, 'settings'))).tax_mode, 'exclusive');
    await other('GET', root(grocery, 'settings'), undefined, 404);
    await other('PUT', root(grocery, 'settings'), settings, 404);
    // 2 kg at ₹59.75 including 5% GST: ₹119.50 → net 113.81 + tax 5.69, rounded to ₹120.
    const oil = await request('POST', root(grocery, 'catalog'), { name: 'Groundnut oil', code: 'OIL', kind: 'goods', unit: 'litre', tracking: 'quantity', price: '59.75', taxRate: '5' }, 201);
    await request('POST', root(grocery, 'documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [{ skuId: oil.id, quantity: '20', unitPrice: '40' }] }, 201);
    const sale = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, contactId: customer.id, requestKey: key(), lines: [{ skuId: oil.id, quantity: '2' }] }, 201);
    assert.deepEqual([sale.subtotal, sale.tax, sale.round_off, sale.total, sale.tax_mode], ['113.81', '5.69', '0.50', '120.00', 'inclusive']);
    // Returning everything gives back the round-off too: nothing is owed.
    const detail = await request('GET', root(grocery, `documents/${sale.id}`));
    const back = await request('POST', root(grocery, `documents/${sale.id}/returns`), { reason: 'Leaking can', requestKey: key(), lines: [{ lineId: detail.lines[0].id, quantity: '2', restock: false }] }, 201);
    assert.equal(back.total, '120.00');
    assert.match(back.return_no, /^CN/);
    await request('PUT', root(grocery, 'settings'), { ...settings, taxMode: 'exclusive', rounding: 'none' });
  });

  await t.test('number series hand out every number once, in order, even under concurrent posting', async () => {
    const before = await one("SELECT next_number FROM business_number_series WHERE business_id=$1 AND location_id=$2 AND document_kind='sale'", [grocery.id, location.id]);
    const posts = await Promise.all(Array.from({ length: 12 }, () => call('POST', root(grocery, 'documents'),
      { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: rice.id, quantity: '0.5', lotCode: 'R-01' }] }, token)));
    assert.deepEqual(posts.map((p) => p.status), Array(12).fill(201));
    const numbers = posts.map((p) => Number(p.body.data.document_no.match(/(\d+)$/)[1])).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 12 }, (_, i) => Number(before.next_number) + i));
    // A refused posting gives its number back: the next sale takes it. (The
    // buyer's PAN lets this bill over ₹2,00,000 reach the stock check.)
    await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(), buyer: { pan: 'ABCDE1234F' }, lines: [{ skuId: rice.id, quantity: '9999', lotCode: 'R-01' }] }, 409);
    const next = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: rice.id, quantity: '0.5', lotCode: 'R-01' }] }, 201);
    assert.equal(Number(next.document_no.match(/(\d+)$/)[1]), numbers.at(-1) + 1);
    assert.equal(next.document_no.length <= 16, true);
    // Custom series: a second location with its own prefix; no going back; no prefix ending in a digit.
    const settingsRow = await one('SELECT fiscal_year_start_month FROM business_settings WHERE business_id=$1', [grocery.id]);
    const [year, month] = dates.today().split('-').map(Number);
    const fy = month >= settingsRow.fiscal_year_start_month ? year : year - 1;
    await request('POST', root(grocery, 'number-series'), { locationId: location2.id, documentKind: 'sale', fiscalYear: fy, prefix: 'WH2', padding: 4 }, 400);
    const series = await request('POST', root(grocery, 'number-series'), { locationId: location2.id, documentKind: 'sale', fiscalYear: fy, prefix: 'wh/inv-', padding: 5, nextNumber: 101 }, 201);
    assert.equal(series.prefix, 'WH/INV-');
    await request('POST', root(grocery, 'number-series'), { locationId: location2.id, documentKind: 'sale', fiscalYear: fy, prefix: 'WH/X-', padding: 4 }, 409);
    await request('POST', root(grocery, 'number-series'), { locationId: location2.id, documentKind: 'purchase', fiscalYear: fy, prefix: 'WH/INV-', padding: 4 }, 409);
    await request('PATCH', root(grocery, `number-series/${series.id}`), { prefix: 'WH/INV-', padding: 5, nextNumber: 50 }, 409);
    await assert.rejects(pool.query('UPDATE business_number_series SET location_id=$2 WHERE id=$1', [series.id, location.id]));
  });

  await t.test('events are written in the posting transaction and roll back with it', async () => {
    const documents = await one("SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND kind='sale'", [grocery.id]);
    const events = await one("SELECT count(*)::int AS n FROM business_events WHERE business_id=$1 AND kind='sale.posted'", [grocery.id]);
    assert.equal(events.n, documents.n, 'one sale.posted event per sale');
    const pairs = await one(`SELECT count(*)::int AS n FROM business_documents d WHERE d.business_id=$1 AND NOT EXISTS
      (SELECT 1 FROM business_events e WHERE e.business_id=d.business_id AND e.entity_type='document' AND e.entity_id=d.id)`, [grocery.id]);
    assert.equal(pairs.n, 0);
    // Make the event insert itself fail: the whole sale must disappear with it.
    await pool.query(`CREATE FUNCTION test_block_events() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind = 'sale.posted' THEN RAISE EXCEPTION 'outbox unavailable'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER test_block_events BEFORE INSERT ON business_events FOR EACH ROW EXECUTE FUNCTION test_block_events()');
    const lot = await one('SELECT quantity FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [grocery.id, rice.id, location.id]);
    const series = await one("SELECT next_number FROM business_number_series WHERE business_id=$1 AND location_id=$2 AND document_kind='sale'", [grocery.id, location.id]);
    const requestKey = key();
    const failed = await call('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey, lines: [{ skuId: rice.id, quantity: '1', lotCode: 'R-01' }] }, token);
    assert.equal(failed.status, 500);
    await pool.query('DROP TRIGGER test_block_events ON business_events; DROP FUNCTION test_block_events()');
    assert.equal((await one('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND request_key=$2', [grocery.id, requestKey])).n, 0);
    assert.equal((await one('SELECT quantity FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [grocery.id, rice.id, location.id])).quantity, lot.quantity);
    assert.equal((await one("SELECT next_number FROM business_number_series WHERE business_id=$1 AND location_id=$2 AND document_kind='sale'", [grocery.id, location.id])).next_number, series.next_number);
    // The outbox keeps unpublished rows: no edits, no deletes; publishing stamps once.
    const event = await one('SELECT id FROM business_events WHERE business_id=$1 ORDER BY id LIMIT 1', [grocery.id]);
    await assert.rejects(pool.query("UPDATE business_events SET payload='{}' WHERE id=$1", [event.id]));
    await assert.rejects(pool.query('DELETE FROM business_events WHERE id=$1', [event.id]));
    await pool.query('UPDATE business_events SET published_at=now() WHERE id=$1', [event.id]);
    await assert.rejects(pool.query('UPDATE business_events SET published_at=now() WHERE id=$1', [event.id]));
    const kinds = (await rows('SELECT DISTINCT kind FROM business_events WHERE business_id=$1', [grocery.id])).map((r) => r.kind);
    for (const kind of ['sale.posted', 'purchase.posted', 'payment.recorded', 'sale.returned', 'stock.adjusted']) assert.ok(kinds.includes(kind), kind);
  });

  const ledgerMatches = async (businessId) => {
    const mismatched = await one(`SELECT count(*)::int AS n FROM business_stock_lots l WHERE l.business_id=$1 AND l.quantity <>
      COALESCE((SELECT sum(quantity) FROM business_stock_movements m WHERE m.business_id=l.business_id AND m.lot_id=l.id),0)`, [businessId]);
    assert.equal(mismatched.n, 0, 'every lot equals the sum of its movements');
  };
  const totalRice = async () => Number((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [grocery.id, rice.id])).q);
  const inTransit = async () => Number((await one(`SELECT COALESCE(sum(x.quantity),0) AS q FROM business_stock_transfer_lines x JOIN business_stock_transfers t
    ON t.business_id=x.business_id AND t.id=x.transfer_id WHERE t.business_id=$1 AND t.status='in_transit' AND x.sku_id=$2`, [grocery.id, rice.id])).q);

  await t.test('transfers move stock through transit and reconcile; cancelling puts it back', async () => {
    await request('GET', root(grocery, 'transfers'), undefined, 403);
    await request('PUT', root(grocery, 'modules/stock_transfers'), { enabled: true });
    const source = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [grocery.id, rice.id, location.id]);
    const startTotal = await totalRice();
    const body = { fromLocationId: location.id, toLocationId: location2.id, requestKey: key(), lines: [{ lotId: source.id, quantity: '10' }] };
    await request('POST', root(grocery, 'transfers'), { ...body, toLocationId: location.id }, 400);
    await request('POST', root(grocery, 'transfers'), { ...body, requestKey: key(), lines: [{ lotId: source.id, quantity: '100000' }] }, 409);
    const transfer = await request('POST', root(grocery, 'transfers'), body, 201);
    assert.equal((await request('POST', root(grocery, 'transfers'), body, 201)).id, transfer.id, 'a repeated request is the same transfer');
    assert.match(transfer.transfer_no, /^ST/);
    assert.equal(await totalRice() + await inTransit(), startTotal, 'stock in transit is neither here nor there');
    await as(staff.cashier.token)('POST', root(grocery, `transfers/${transfer.id}/receive`), {}, 403);
    await as(staff.stock_keeper.token)('POST', root(grocery, `transfers/${transfer.id}/receive`), {});
    await request('POST', root(grocery, `transfers/${transfer.id}/receive`), {}, 409);
    const arrived = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [grocery.id, rice.id, location2.id]);
    assert.deepEqual([Number(arrived.quantity), arrived.lot_code, arrived.expires_on, Number(arrived.unit_cost)], [10, 'R-01', '2099-01-01', Number(source.unit_cost)]);
    assert.equal(await totalRice(), startTotal);
    const second = await request('POST', root(grocery, 'transfers'), { ...body, requestKey: key(), lines: [{ lotId: source.id, quantity: '2' }] }, 201);
    await request('POST', root(grocery, `transfers/${second.id}/cancel`), {}, 400);
    await request('POST', root(grocery, `transfers/${second.id}/cancel`), { reason: 'Van broke down' });
    assert.equal(await totalRice(), startTotal);
    assert.equal(await inTransit(), 0);
    await ledgerMatches(grocery.id);
    // A lot from another business cannot travel on this business's transfer.
    const foreignLot = await one('SELECT id FROM business_stock_lots WHERE business_id<>$1 LIMIT 1', [grocery.id]);
    if (foreignLot) await assert.rejects(pool.query('UPDATE business_stock_transfer_lines SET source_lot_id=$2 WHERE transfer_id=$1', [transfer.id, foreignLot.id]), { code: '23503' });
    await request('POST', root(grocery, 'transfers'), { ...body, requestKey: key(), lines: [{ lotId: foreignLot?.id || 999999, quantity: '1' }] }, 404);
  });

  await t.test('stock counts compare with the stock at approval and post reasoned corrections', async () => {
    const lot = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [grocery.id, rice.id, location2.id]);
    const count = await request('POST', root(grocery, 'counts'), { locationId: location2.id, requestKey: key() }, 201);
    await request('POST', root(grocery, 'counts'), { locationId: location2.id, requestKey: key() }, 409);
    const sheet = await request('GET', root(grocery, `counts/${count.id}`));
    const line = sheet.lines.find((l) => l.lot_id === lot.id);
    assert.equal(Number(line.expected_quantity), 10);
    // The shelf shows 9; a sale of 1 happens before approval, so nothing is missing.
    await request('PATCH', root(grocery, `counts/${count.id}/lines`), { lines: [{ lineId: line.id, countedQuantity: '9' }] });
    await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location2.id, requestKey: key(), lines: [{ skuId: rice.id, quantity: '1', lotCode: 'R-01' }] }, 201);
    await as(staff.stock_keeper.token)('POST', root(grocery, `counts/${count.id}/post`), {}, 403);
    const posted = await request('POST', root(grocery, `counts/${count.id}/post`), {});
    assert.equal(posted.corrections, 0);
    await request('POST', root(grocery, `counts/${count.id}/post`), {}, 409);
    // A real shortage needs a reason, then becomes a correction linked to the count.
    const recount = await request('POST', root(grocery, 'counts'), { locationId: location2.id, requestKey: key() }, 201);
    const recountLine = (await request('GET', root(grocery, `counts/${recount.id}`))).lines.find((l) => l.lot_id === lot.id);
    await request('PATCH', root(grocery, `counts/${recount.id}/lines`), { lines: [{ lineId: recountLine.id, countedQuantity: '6.5' }] });
    await request('POST', root(grocery, `counts/${recount.id}/post`), {}, 400);
    const done = await request('POST', root(grocery, `counts/${recount.id}/post`), { reason: 'Rats in the store room' });
    assert.equal(done.corrections, 1);
    assert.equal(Number((await one('SELECT quantity FROM business_stock_lots WHERE id=$1', [lot.id])).quantity), 6.5);
    const adjustment = await one('SELECT * FROM business_stock_adjustments WHERE business_id=$1 AND count_id=$2', [grocery.id, recount.id]);
    assert.equal(Number(adjustment.quantity), -2.5);
    assert.match(adjustment.reason, /Rats/);
    await ledgerMatches(grocery.id);
    const cancelled = await request('POST', root(grocery, 'counts'), { locationId: location2.id, requestKey: key() }, 201);
    await request('POST', root(grocery, `counts/${cancelled.id}/cancel`), { reason: 'Started by mistake' });
    const movements = await request('GET', root(grocery, 'movements?source=count'));
    assert.ok(movements.items.length >= 1);
  });

  await t.test('categories form a tree inside one business; units and pack sizes convert lines exactly', async () => {
    const staples = await request('POST', root(grocery, 'categories'), { name: 'Staples' }, 201);
    const grains = await request('POST', root(grocery, 'categories'), { name: 'Grains', parentId: staples.id }, 201);
    await request('POST', root(grocery, 'categories'), { name: 'grains', parentId: staples.id }, 409);
    await request('PATCH', root(grocery, `categories/${staples.id}`), { name: 'Staples', parentId: grains.id }, 409);
    await request('POST', root(electronics, 'categories'), { name: 'Phones', parentId: staples.id }, 404);
    await assert.rejects(pool.query('INSERT INTO catalog_categories(business_id,parent_id,name) VALUES($1,$2,$3)', [electronics.id, staples.id, 'Sneaky']), { code: '23503' });
    const foreignSlab = await one('SELECT id FROM business_tax_rates WHERE business_id=$1 LIMIT 1', [electronics.id]);
    await assert.rejects(pool.query('UPDATE catalog_skus SET tax_rate_id=$2 WHERE id=$1', [rice.id, foreignSlab.id]), { code: '23503' });
    await request('PATCH', root(grocery, `catalog/${rice.id}`), { label: rice.label, price: '60', taxRate: '5', active: true, categoryId: grains.id });
    const listed = await request('GET', root(grocery, `catalog?category=${grains.id}`));
    assert.equal(listed.items[0].category, 'Grains');
    const tree = await request('GET', root(grocery, 'categories'));
    assert.ok(tree.items.some((c) => c.path === 'Staples › Grains'));

    biscuit = await request('POST', root(grocery, 'catalog'), { name: 'Glucose biscuits', code: 'BISC', kind: 'goods', unit: 'each', tracking: 'quantity', price: '10', taxRate: '18' }, 201);
    await request('POST', root(grocery, 'pack-sizes'), { skuId: biscuit.id, unitCode: 'box', quantityInBase: '12.5' }, 400);
    await request('POST', root(grocery, 'pack-sizes'), { skuId: biscuit.id, unitCode: 'each', quantityInBase: '1' }, 400);
    await request('POST', root(grocery, 'pack-sizes'), { skuId: biscuit.id, unitCode: 'box', quantityInBase: '24' }, 201);
    // 2 boxes at ₹180 a box: 48 biscuits at ₹7.50 each in stock.
    const receipt = await request('POST', root(grocery, 'documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(),
      lines: [{ skuId: biscuit.id, unit: 'box', quantity: '2', unitPrice: '180' }] }, 201);
    assert.equal(receipt.subtotal, '360.00');
    const stockLot = await one('SELECT quantity,unit_cost FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [grocery.id, biscuit.id]);
    assert.deepEqual([Number(stockLot.quantity), Number(stockLot.unit_cost)], [48, 7.5]);
    const sold = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: biscuit.id, unit: 'box', quantity: '1' }] }, 201);
    assert.equal(sold.subtotal, '240.00');
    const soldLine = (await request('GET', root(grocery, `documents/${sold.id}`))).lines[0];
    assert.deepEqual([Number(soldLine.quantity), soldLine.entered_unit, Number(soldLine.entered_quantity), soldLine.entered_unit_price], [24, 'box', 1, '240.00']);
    await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: biscuit.id, unit: 'pack', quantity: '1' }] }, 400);
    await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: biscuit.id, quantity: '1.5' }] }, 400);
    // Grams convert to the kilogram stock unit through the unit table.
    const gramSale = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: rice.id, unit: 'g', quantity: '750', lotCode: 'R-01' }] }, 201);
    assert.equal(gramSale.subtotal, '45.00');
    await request('POST', root(grocery, 'units'), { code: 'big box', name: 'Big box', kind: 'count' }, 400);
    await request('POST', root(grocery, 'units'), { code: 'quintal', name: 'Quintal', kind: 'weight', baseUnitCode: 'kg', factorToBase: '100' }, 201);
    await request('POST', root(grocery, 'units'), { code: 'cup', name: 'Cup', kind: 'volume', baseUnitCode: 'kg', factorToBase: '1' }, 400);
  });

  await t.test('credit limits and credit days apply to customers; payment can be taken with the sale', async () => {
    const regular = await request('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'Ramesh Kirana', creditLimit: '100', creditDays: 7, openingBalance: '40', openingBalanceOn: '2026-04-01' }, 201);
    await request('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'Bad', openingBalance: '40' }, 400);
    const sale = (payment) => ({ kind: 'sale', locationId: location.id, contactId: regular.id, requestKey: key(), lines: [{ skuId: rice.id, quantity: '2', lotCode: 'R-01' }], ...(payment ? { payment } : {}) });
    // ₹126 (2 kg at ₹60 + 5%) on top of ₹40 already owed is over a ₹100 limit.
    const refused = await call('POST', root(grocery, 'documents'), sale(), token);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /credit limit/);
    await request('POST', root(grocery, 'documents'), sale({ amount: '200', method: 'cash' }), 400);
    const paid = await request('POST', root(grocery, 'documents'), sale({ amount: '70', method: 'upi', reference: 'UPI-1' }), 201);
    const detail = await request('GET', root(grocery, `documents/${paid.id}`));
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.payments[0].amount, '70.00');
    const expectedDue = await one("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 7)::text AS day");
    assert.equal(paid.due_on, expectedDue.day, 'the due date follows the credit days');
    const listed = (await request('GET', root(grocery, `contacts?kind=customer&q=${encodeURIComponent('Ramesh')}`))).items[0];
    assert.equal(Number(listed.balance), 96);
    // A viewer can read balances but not take payment with a sale.
    await as(staff.viewer.token)('GET', root(grocery, 'contacts'));
  });

  await t.test('lists search, filter and open on a period without crossing businesses', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const sales = await request('GET', root(grocery, `documents?kind=sale&from=${today}&to=${today}&limit=5`));
    assert.ok(sales.total > 5 && sales.items.length === 5);
    assert.equal((await request('GET', root(grocery, 'documents?kind=sale&from=2001-01-01&to=2001-01-31'))).total, 0);
    await request('GET', root(grocery, 'documents?from=2026-02-30'), undefined, 400);
    const found = await request('GET', root(grocery, 'catalog?q=biscuit'));
    assert.deepEqual(found.items.map((i) => i.code), ['BISC']);
    assert.equal((await request('GET', root(grocery, 'catalog?q=100%25'))).total, 0, 'search text is not a pattern');
    const audit = await request('GET', root(grocery, `audit?from=${today}&to=${today}`));
    assert.ok(audit.items[0].actor_name);
    await other('GET', root(grocery, 'documents'), undefined, 404);
    await other('GET', root(grocery, `transfers/1`), undefined, 404);
    await request('POST', root(pharmacy, 'open'), {});
    const reopened = (await request('GET', '/businesses')).businesses.find((b) => b.id === pharmacy.id);
    assert.ok(reopened.last_opened_at, 'the switcher remembers the business last opened');
    await other('POST', root(pharmacy, 'open'), {}, 404);
    const context = await request('GET', root(grocery, 'context'));
    assert.ok(context.modules.includes('settings') && context.permissions.includes('access.edit') && context.role.full_access);
    const cashierContext = await as(staff.cashier.token)('GET', root(grocery, 'context'));
    assert.ok(!cashierContext.permissions.includes('purchasing.create'));
  });
});
