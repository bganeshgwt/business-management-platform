const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Multi-location for every business type: a location's own
// address and GSTIN on its bills, staff tied to one location (they bill,
// stock, report and manage people there only), the branch picked in the top
// bar narrowing what a request leaves open, transfers received by the
// destination, the branch comparison report, and a pharmacy branch's own drug
// licences. Runs on its own throwaway database with every migration applied.
test('multi-location: branch details, staff tied to a branch, top-bar branch, comparison, pharmacy licences', { timeout: 300000 }, async (t) => {
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
  const password = `Branch-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Branches','BRANCH') RETURNING id");
  await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
  const ownerUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, 'Branch owner', 'branch-owner@test.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [ownerUser.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth, headers = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const as = (auth, headers) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth, headers);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const token = await login('branch-owner@test.invalid');
  const request = as(token);
  const key = () => crypto.randomUUID();
  const { gstinCheckCharacter } = require('../../src/utils/gstin');
  const gstin = (first14) => first14 + gstinCheckCharacter(first14);

  const [shop, pharmacy] = await withTools(request, await createBusinesses(request, 'OWNER', ['supermarket', 'pharmacy']));
  const S = (suffix) => `/businesses/${shop.id}/${suffix}`;
  const P = (suffix) => `/businesses/${pharmacy.id}/${suffix}`;
  const main = (await request('GET', S('locations'))).items[0];
  await request('PUT', S('settings'), { displayName: 'Annapurna Super Bazaar', gstin: gstin('29ABCDE1234F1Z'), addressLine1: '12 MG Road', city: 'Bengaluru',
    postalCode: '560001', taxMode: 'inclusive', rounding: 'none', fiscalYearStartMonth: 4, dateFormat: 'DD/MM/YYYY' });

  let branch;
  await t.test('a location carries its own address, state and GSTIN', async () => {
    await request('POST', S('locations'), { name: 'Bad', code: 'BAD', gstin: '33ABCDE1234F1Z0' }, 400);
    await request('POST', S('locations'), { name: 'Bad', code: 'BAD', gstin: gstin('33ABCDE1234F1Z'), stateCode: '29' }, 400);
    branch = await request('POST', S('locations'), { name: 'Chennai branch', code: 'CHN', addressLine1: '5 Anna Salai', city: 'Chennai', postalCode: '600002',
      gstin: gstin('33ABCDE1234F1Z'), phone: '044 2850 1234' }, 201);
    assert.equal(branch.state_code, '33');
    // An older client renaming the location keeps its address.
    const renamed = await request('PATCH', S(`locations/${branch.id}`), { name: 'Chennai Anna Salai', active: true });
    assert.equal(renamed.gstin, branch.gstin);
    assert.equal(renamed.city, 'Chennai');
    const ctx = await request('GET', S('context'));
    assert.equal(ctx.locations.length, 2);
    assert.equal(ctx.allLocations.find((l) => l.id === branch.id).gstin, branch.gstin);
    assert.equal(ctx.member.location_id, null);
  });

  // Stock at both locations.
  const supplier = await request('POST', S('contacts'), { kind: 'supplier', name: 'Metro wholesale' }, 201);
  const soap = await request('POST', S('catalog'), { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '18', name: 'Bath soap', code: 'SOAP', price: '59', hsnCode: '3401' }, 201);
  for (const location of [main, branch]) {
    await request('POST', S('documents'), { kind: 'purchase', requestKey: key(), locationId: location.id, contactId: supplier.id, lines: [{ skuId: soap.id, quantity: '40', unitPrice: '40' }] }, 201);
  }
  const mainSale = await request('POST', S('documents'), { kind: 'sale', requestKey: key(), locationId: main.id, lines: [{ skuId: soap.id, quantity: '3' }], payment: { amount: 'full', method: 'cash' } }, 201);

  await t.test('the bill prints the selling branch and supplies from its state', async () => {
    const sale = await request('POST', S('documents'), { kind: 'sale', requestKey: key(), locationId: branch.id, lines: [{ skuId: soap.id, quantity: '2' }], payment: { amount: 'full', method: 'cash' } }, 201);
    const doc = await request('GET', S(`documents/${sale.id}`));
    assert.equal(doc.place_of_supply, '33');
    assert.equal(doc.seller.gstin, branch.gstin);
    assert.equal(doc.seller.state_code, '33');
    assert.equal(doc.seller.city, 'Chennai');
    assert.equal(doc.seller.branch_name, 'Chennai Anna Salai');
    assert.equal(doc.seller.display_name, 'Annapurna Super Bazaar');
    // The main counter (no address of its own) prints Business settings.
    const head = await request('GET', S(`documents/${mainSale.id}`));
    assert.equal(head.seller.gstin, gstin('29ABCDE1234F1Z'));
    assert.equal(head.seller.branch_name, undefined);
    assert.equal(head.place_of_supply, '29');
  });

  // People: a cashier and a branch manager tied to the branch.
  const roles = (await request('GET', S('roles?limit=100'))).items;
  const branchManagerRole = await request('POST', S('roles'), { name: 'Branch manager', permissions: ['sales.view', 'sales.create', 'sales.refund', 'reports.view', 'inventory.view',
    'stock_transfers.view', 'stock_transfers.create', 'stock_transfers.approve', 'stock_transfers.cancel', 'stock_counts.view', 'stock_counts.create', 'access.view', 'access.edit'] }, 201);
  const people = {};
  for (const [name, roleId, where] of [['cashier', roles.find((r) => r.template_code === 'cashier').id, branch.id], ['manager', branchManagerRole.id, branch.id], ['newcomer', null, null]]) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, `Branch ${name}`, `branch-${name}@test.invalid`, hash]);
    people[name] = { id: Number(user.id), call: as(await login(`branch-${name}@test.invalid`)) };
    if (roleId) await request('POST', S('members'), { userId: user.id, roleId, workLocationId: where }, 201);
  }

  await t.test('staff tied to a branch see and bill only there', async () => {
    const { call: cashier } = people.cashier;
    const ctx = await cashier('GET', S('context'));
    assert.deepEqual(ctx.locations.map((l) => l.id), [branch.id]);
    assert.equal(ctx.member.location_id, branch.id);
    assert.equal(ctx.currentLocationId, branch.id);
    // Another location, named in the body or the query, is refused.
    await cashier('POST', S('documents'), { kind: 'sale', requestKey: key(), locationId: main.id, lines: [{ skuId: soap.id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 403);
    await cashier('GET', S(`stock?location=${main.id}`), undefined, 403);
    await cashier('GET', S(`reports/takings?locationId=${main.id}`), undefined, 403);
    // Leaving the location out bills at their own.
    const sale = await cashier('POST', S('documents'), { kind: 'sale', requestKey: key(), lines: [{ skuId: soap.id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 201);
    assert.equal(sale.location_id, branch.id);
    // Lists and the Overview answer for the branch.
    const stock = await cashier('GET', S('stock'));
    assert.ok(stock.items.length > 0 && stock.items.every((lot) => lot.location_id === branch.id));
    const sales = await cashier('GET', S('documents?kind=sale'));
    assert.ok(sales.items.every((d) => d.location_id === branch.id));
    assert.ok(!sales.items.some((d) => d.id === mainSale.id));
    const summary = await cashier('GET', S('summary'));
    assert.equal(Number(summary.sales_today), 59 * 3);
    // Returns on another branch's bill are refused.
    await cashier('POST', S(`documents/${mainSale.id}/returns`), { requestKey: key(), reason: 'Damaged', lines: [{ lineId: (await request('GET', S(`documents/${mainSale.id}`))).lines[0].id, quantity: '1' }], refund: { method: 'cash' } }, 403);
    // The owner's Overview is the whole business.
    assert.equal(Number((await request('GET', S('summary'))).sales_today), 59 * 6);
  });

  await t.test('a branch manager manages the branch only', async () => {
    const { call: manager } = people.manager;
    // Access at another location, or for every location, is beyond them.
    await manager('POST', S('members'), { userId: people.newcomer.id, roleId: roles.find((r) => r.template_code === 'cashier').id, workLocationId: main.id }, 403);
    await manager('POST', S('members'), { userId: people.newcomer.id, roleId: roles.find((r) => r.template_code === 'cashier').id }, 403);
    await manager('POST', S('members'), { userId: people.newcomer.id, roleId: branchManagerRole.id, workLocationId: branch.id }, 201);
    const staff = await manager('GET', S('members'));
    assert.ok(staff.items.every((m) => m.location_id === branch.id));
    // Of the branch's people they manage the newcomer, who has their role; not
    // the cashier, whose role sees products and customers and theirs does not;
    // nor themselves.
    assert.deepEqual(Object.fromEntries(staff.items.map((m) => [m.id, m.manages])),
      { [people.cashier.id]: false, [people.manager.id]: false, [people.newcomer.id]: true });
    // The owner's staff list shows everyone, with where each works.
    const all = await request('GET', S('members'));
    assert.equal(all.items.find((m) => m.id === people.cashier.id).location_name, 'Chennai Anna Salai');
    assert.ok(all.items.some((m) => m.location_id === null));
  });

  await t.test('transfers: sent by the source, received by the destination', async () => {
    const { call: manager } = people.manager;
    await manager('POST', S('transfers'), { requestKey: key(), fromLocationId: main.id, toLocationId: branch.id, lines: [{ skuId: soap.id, quantity: '5' }] }, 403);
    const lots = (await request('GET', S(`stock?location=${main.id}`))).items;
    const transfer = await request('POST', S('transfers'), { requestKey: key(), fromLocationId: main.id, toLocationId: branch.id,
      lines: [{ lotId: lots[0].id, skuId: soap.id, quantity: '5' }] }, 201);
    await manager('POST', S(`transfers/${transfer.id}/cancel`), { reason: 'Not needed' }, 403);
    const received = await manager('POST', S(`transfers/${transfer.id}/receive`), {});
    assert.equal(received.status, 'received');
    // The other way round, the branch sends and the main counter receives.
    const branchLot = (await manager('GET', S('stock'))).items[0];
    const back = await manager('POST', S('transfers'), { requestKey: key(), toLocationId: main.id, lines: [{ lotId: branchLot.id, skuId: soap.id, quantity: '2' }] }, 201);
    assert.equal(back.from_location_id, branch.id);
    await manager('POST', S(`transfers/${back.id}/receive`), {}, 403);
  });

  await t.test('a location with staff tied to it cannot close', async () => {
    const result = await call('PATCH', S(`locations/${branch.id}`), { name: 'Chennai Anna Salai', active: false }, token);
    assert.equal(result.status, 409);
  });

  await t.test('the top-bar branch fills in what a request leaves open', async () => {
    const picked = as(token, { 'X-Business-Location': String(branch.id) });
    const ctx = await picked('GET', S('context'));
    assert.deepEqual(ctx.locations.map((l) => l.id), [branch.id]);
    assert.equal(ctx.allLocations.length, 2);
    assert.equal(ctx.currentLocationId, branch.id);
    assert.ok((await picked('GET', S('stock'))).items.every((lot) => lot.location_id === branch.id));
    // Naming another location still works for someone not tied to one.
    assert.ok((await picked('GET', S(`stock?location=${main.id}`))).items.every((lot) => lot.location_id === main.id));
    // The staff list is not narrowed by the picker.
    assert.ok((await picked('GET', S('members'))).items.some((m) => m.location_id === null));
    // A location of another business, or nonsense, is ignored.
    const other = as(token, { 'X-Business-Location': 'abc' });
    assert.equal((await other('GET', S('context'))).currentLocationId, null);
  });

  await t.test('branch comparison: every location side by side', async () => {
    const report = await request('GET', S('reports/locations'));
    const byId = Object.fromEntries(report.locations.map((l) => [l.id, l]));
    assert.equal(byId[main.id].bills, 1);
    assert.equal(byId[branch.id].bills, 2);
    assert.equal(Number(byId[main.id].sales), 177);
    assert.equal(Number(byId[branch.id].net_sales), 177);
    assert.equal(byId[main.id].share_percent + byId[branch.id].share_percent, 100);
    assert.equal(Number(report.totals.net_sales), 354);
    assert.ok(Number(byId[branch.id].stock_value) > 0);
    // Even with a branch picked in the top bar, the comparison shows every one.
    assert.equal((await as(token, { 'X-Business-Location': String(branch.id) })('GET', S('reports/locations'))).locations.length, 2);
    // A branch manager sees their branch only.
    const theirs = await people.manager.call('GET', S('reports/locations'));
    assert.deepEqual(theirs.locations.map((l) => l.id), [branch.id]);
    await people.cashier.call('GET', S('reports/locations'), undefined, 403);
  });

  await t.test('a pharmacy branch prints its own drug licences', async () => {
    const head = (await request('GET', P('locations'))).items[0];
    const second = await request('POST', P('locations'), { name: 'Velachery', code: 'VLC' }, 201);
    await request('PUT', P('health/settings'), { drugLicence20: 'TN-20-HEAD', drugLicence21: 'TN-21-HEAD', rxScanRequired: false });
    const saved = await request('PUT', P(`health/location-licences/${second.id}`), { drugLicence20: 'TN-20-VLC', drugLicence21: 'TN-21-VLC' });
    assert.equal(saved.drug_licence_20, 'TN-20-VLC');
    const settings = await request('GET', P('health/settings'));
    assert.equal(settings.locationLicences.find((l) => l.location_id === second.id).drug_licence_21, 'TN-21-VLC');
    const five = (await request('GET', P('tax-rates'))).items.find((r) => Number(r.rate) === 5);
    const supplierP = await request('POST', P('contacts'), { kind: 'supplier', name: 'Medical agencies' }, 201);
    const pcm = await request('POST', P('catalog'), { kind: 'goods', unit: 'strip', tracking: 'batch', taxRateId: five.id, name: 'Paracetamol 650 strip', code: 'PCM', price: '30', hsnCode: '3004' }, 201);
    await request('PUT', P(`pharmacy/drugs/${pcm.id}`), { composition: 'Paracetamol', strength: '650 mg', schedule: 'none', unitsPerStrip: 15 });
    const expiry = daysFrom(400);
    const licencesOn = async (location) => {
      await request('POST', P('documents'), { kind: 'purchase', requestKey: key(), locationId: location.id, contactId: supplierP.id,
        lines: [{ skuId: pcm.id, quantity: '10', unitPrice: '20', lotCode: `B${location.id}`, expiresOn: expiry }] }, 201);
      const sale = await request('POST', P('pharmacy/sales'), { requestKey: key(), locationId: location.id, lines: [{ skuId: pcm.id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 201);
      return (await request('GET', P(`documents/${sale.document.id}`))).pharmacy.licences.map((l) => l.number);
    };
    assert.deepEqual(await licencesOn(second), ['TN-20-VLC', 'TN-21-VLC']);
    assert.deepEqual(await licencesOn(head), ['TN-20-HEAD', 'TN-21-HEAD']);
    // Clearing the branch's numbers falls back to the business-wide ones.
    await request('PUT', P(`health/location-licences/${second.id}`), { drugLicence20: '', drugLicence21: '' });
    assert.deepEqual(await licencesOn(second), ['TN-20-HEAD', 'TN-21-HEAD']);
  });
  await t.test("a branch never opens another branch's bill or transfer", async () => {
    const { call: cashier } = people.cashier;
    const { call: manager } = people.manager;
    await cashier('GET', S(`documents/${mainSale.id}`), undefined, 403);
    // A transfer between two other locations is neither listed nor opened.
    const godown = await request('POST', S('locations'), { name: 'Hosur godown', code: 'HSR' }, 201);
    const lot = (await request('GET', S(`stock?location=${main.id}`))).items.find((l) => Number(l.quantity) > 0);
    const away = await request('POST', S('transfers'), { requestKey: key(), fromLocationId: main.id, toLocationId: godown.id, lines: [{ lotId: lot.id, skuId: soap.id, quantity: '1' }] }, 201);
    const theirs = (await manager('GET', S('transfers?limit=100'))).items;
    assert.ok(theirs.length > 0 && theirs.every((x) => x.from_location_id === branch.id || x.to_location_id === branch.id));
    await manager('GET', S(`transfers/${away.id}`), undefined, 403);
    assert.equal((await manager('GET', S(`transfers/${theirs[0].id}`))).id, theirs[0].id);
    // The owner, with the godown picked, sees the godown's transfers either way.
    const picked = as(token, { 'X-Business-Location': String(godown.id) });
    assert.deepEqual((await picked('GET', S('transfers?limit=100'))).items.map((x) => x.id), [away.id]);
  });
});
