const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { today, daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A shop's products, customers and suppliers from a CSV file, end to end on a
// throwaway database with every migration applied: the template, the check
// that saves nothing (each row new, matching a record here, or refused with
// its reason), the import of what was checked as one transaction through the
// core's own paths (items with their opening stock, contacts with their
// opening balance), matching records left alone or updated when chosen, the
// items a business type keeps its own details for, duplicates in a file, a
// stale check, the request key, the permissions that make the records by
// hand, the row limit, the activity log and the outbox.
test('a shop imports its products, customers and suppliers from a CSV file', { timeout: 900000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, scratch, created = false;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (scratch) await scratch.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  // The import runs every query on its own transaction's connection.
  process.env.DB_POOL_GUARD = 'throw';
  const { runner } = await import('node-pg-migrate');
  const dir = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes the imports table away and Up brings it back', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const left = async () => (await scratch.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename='business_imports'")).rows[0].n;
    assert.equal(await left(), 1);
    const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_business-csv-import.sql')).split('_')[0]);
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.equal(await left(), 0);
    assert.equal((await scratch.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname='business_imports_fixed'")).rows[0].n, 0);
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await left(), 1);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Imports-${crypto.randomBytes(8).toString('hex')}`;
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('csv-owner');
  await owner('csv-other');
  const ownerToken = await login('csv-owner@test.invalid');
  // The whole answer ({ success, message, data }) of a call that must have this status.
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body).slice(0, 2000)}`);
    return result.body;
  };
  const answer = as(ownerToken);
  const request = async (method, route, body, expected = 200) => (await answer(method, route, body, expected)).data;
  const other = as(await login('csv-other@test.invalid'));
  // The status and the sentence of a refusal.
  const refused = async (method, route, body, auth = ownerToken) => {
    const result = await call(method, route, body, auth);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };

  const [grocery, pharmacy, fuel, jewellery, rentals] = await createBusinesses(request, 'OWNER', ['grocery', 'pharmacy', 'fuel_station', 'jewellery', 'rentals']);
  const [otherGrocery] = await createBusinesses(async (method, route, body, expected) => (await other(method, route, body, expected)).data, 'OTHER', ['grocery']);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
  const roleOf = async (business, template) => (await request('GET', `/businesses/${business.id}/roles?limit=100`)).items.find((r) => r.template_code === template);
  async function staff(business, email, role, extra = {}) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', `/businesses/${business.id}/members`, { userId: user.id, roleId: role.id, ...extra }, 201);
    return login(email);
  }
  const audits = (business, action) => rows('SELECT entity_id,details FROM business_audit WHERE business_id=$1 AND action=$2 ORDER BY id', [business.id, action]);
  // A CSV file as the staff app sends it: one { heading: cell } per row.
  const file = (headings, ...lines) => lines.map((line) => Object.fromEntries(headings.map((heading, at) => [heading, line[at] ?? ''])));
  const importing = (route, rows, more = {}) => ({ rows, dryRun: true, fileName: 'items.csv', ...more });
  const productsOf = async (business) => (await request('GET', `/businesses/${business.id}/catalog?limit=100`)).items;
  const units = (await request('GET', G('units?limit=100'))).items.filter((u) => u.active).map((u) => u.code).sort().join(', ');
  const slabs = (await request('GET', G('tax-rates?limit=100'))).items;
  const slabNames = slabs.filter((s) => s.active).sort((a, b) => Number(b.is_default) - Number(a.is_default) || Number(a.id) - Number(b.id)).map((s) => s.name).join(', ');
  const gst5 = slabs.find((s) => Number(s.rate) === 5);
  const gst18 = slabs.find((s) => Number(s.rate) === 18);
  const [shop] = (await request('GET', G('locations'))).items;
  const godown = await request('POST', G('locations'), { name: 'Godown', code: 'GDN' }, 201);
  const HEAD = ['Name', 'Code', 'Barcode', 'Category', 'Kind', 'Unit', 'HSN / SAC', 'GST rate', 'MRP', 'Sale price', 'Purchase price', 'Reorder level', 'Opening stock', 'Location'];
  let firstImport;

  await t.test('the template: its columns, their help and a sample whose headings are the import\'s own', async () => {
    const guide = await request('GET', G('catalog/import-guide'));
    assert.equal(guide.maxRows, 5000);
    assert.deepEqual(guide.columns.map((c) => c.label), ['Name', 'Code', 'Barcode', 'Category', 'Kind', 'Unit', 'Stock tracking', 'HSN / SAC', 'GST rate', 'MRP',
      'Sale price', 'Purchase price', 'Reorder level', 'Opening stock', 'Location', 'Batch', 'Expiry']);
    assert.deepEqual(guide.sample.columns, guide.columns.map((c) => c.label));
    assert.ok(guide.sample.rows.every((row) => row.length === guide.sample.columns.length));
    assert.match(guide.columns.find((c) => c.key === 'unit').help, new RegExp(`Yours: ${units}\\.$`));
    assert.match(guide.columns.find((c) => c.key === 'gst').help, /Yours: GST 18%, GST nil \/ exempt, GST 5%, GST 40%\.$/);
    // The template itself passes its own check: every sample row is new.
    const sample = file(guide.sample.columns, ...guide.sample.rows);
    const checked = await request('POST', G('catalog/import'), importing('catalog', sample));
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.rows.map((r) => r.action), sample.map(() => 'create'));
    const customers = await request('GET', G('contacts/import-guide?kind=customer'));
    assert.deepEqual(customers.columns.map((c) => c.label), ['Name', 'Phone', 'Email', 'GSTIN', 'State', 'Address', 'PAN', 'Credit limit', 'Credit days',
      'Opening balance', 'Opening balance as of']);
    const fromTemplate = await request('POST', G('contacts/import'), { kind: 'customer', ...importing('contacts', file(customers.sample.columns, ...customers.sample.rows)) });
    assert.deepEqual(fromTemplate.rows.map((r) => r.action), ['create', 'create', 'create']);
    const suppliers = await request('GET', G('contacts/import-guide?kind=supplier'));
    assert.ok(!suppliers.columns.some((c) => c.key === 'creditLimit'));
    // Each type says where its own items are made.
    const fuelGuide = await request('GET', `/businesses/${fuel.id}/catalog/import-guide`);
    assert.deepEqual(fuelGuide.notes, ['Fuels are made in Settings › Pumps & nozzles, with their price at each outlet: a row of one is refused, and one already here is not changed from a file.']);
    assert.ok((await request('GET', `/businesses/${jewellery.id}/catalog/import-guide`)).columns.some((c) => c.label === 'Purity'));
    assert.equal((await refused('GET', G('contacts/import-guide?kind=partner'))).message, 'Contact type must be one of: customer, supplier');
  });

  await t.test('products: the check plans every row and refuses a bad one with its reason, saving nothing', async () => {
    const before = (await productsOf(grocery)).length;
    const checked = await answer('POST', G('catalog/import'), importing('catalog', file(HEAD,
      ['Toor dal 1 kg', 'toor-1kg', '8901234567894', 'Pulses', 'Goods', 'pcs', '0713', '5%', '₹175', '160', '130.50', '10', '24', ''],
      ['Basmati rice', 'RICE-BAS', '', 'Grains › Rice', '', 'kgs', '1006', 'GST 5%', '', 'Rs. 1,250.00', '96', '25', '50.5', 'gdn'],
      ['Home delivery', 'SVC-DEL', '', '', 'Service', 'service', '996812', '18', '', '30', '', '', '', ''],
      ['Sugar 1 kg', 'SUGAR-1', '', 'Pulses', 'Goods', 'bags', '1701', '5%', '', '48', '', '', '', ''],
      ['Jaggery', 'JAG-1', '', '', 'Goods', 'each', '17019', '12%', '', '60', '', '', '', ''],
      ['Ghee 500 ml', 'GHEE-500', '', '', 'Goods', 'each', '0405', '5%', '28', '30', '', '', '', ''],
      ['Toor dal again', 'TOOR-1KG', '', '', 'Goods', 'each', '', '5%', '', '150', '', '', '', ''],
      ['Salt 1 kg', 'SALT-1', '8901234567894', '', 'Goods', 'each', '2501', '5%', '', '28', '', '', '', ''],
      ['', 'NEW-1', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['Wheat flour', 'ATTA-5', '', '', 'Goods', 'each', '1101', '5%', '', '250', '200', '', '3.5', ''],
    ), { fileName: 'grocery.csv' }));
    const data = checked.data;
    assert.equal(checked.message, 'Ready: 3 new products, 0 to update, 0 unchanged, opening stock for 2 items; 7 rows refused and left out');
    assert.equal(data.ok, true);
    assert.deepEqual(data.problems, []);
    assert.deepEqual([data.created, data.updated, data.unchanged, data.skipped, data.refused], [3, 0, 0, 0, 7]);
    assert.match(data.fingerprint, /^[a-f0-9]{32}$/);
    const byLine = Object.fromEntries(data.rows.map((r) => [r.line, r]));
    assert.deepEqual(byLine[2].details, { kind: 'Goods', unit: 'Each (piece)', price: '₹160.00', gst: 'GST 5%', mrp: '₹175.00', hsn: '0713', category: 'Pulses (new)',
      opening: `24 each at ${shop.name}`, cost: '₹130.50' });
    assert.equal(byLine[2].code, 'TOOR-1KG');
    assert.equal(byLine[3].details.opening, '50.5 kg at Godown');
    assert.equal(byLine[3].details.category, 'Grains › Rice (new)');
    assert.equal(byLine[3].details.price, '₹1,250.00');
    assert.equal(byLine[4].details.kind, 'Service');
    // Each refusal, in the words the item form uses.
    const reasons = (line) => byLine[line].reasons.map((r) => `${r.column}: ${r.message}`);
    assert.deepEqual(reasons(5), [`unit: "bags" is not one of your units (${units}). Add it in Settings › Units & pack sizes first`]);
    assert.deepEqual(reasons(6), ['hsn: HSN / SAC code must be 4, 6 or 8 digits', `gst: "12%" is not one of your GST slabs (${slabNames}). Add it in Settings › Tax rates first`]);
    assert.deepEqual(reasons(7), ['mrp: Ghee 500 ml would sell at 30.00, above its MRP of 28.00. Lower the price or correct the MRP.']);
    assert.deepEqual(reasons(8), ['code: Row 2 is the same item']);
    assert.deepEqual(reasons(9), ['barcode: Row 2 gives another item barcode 8901234567894']);
    assert.deepEqual(reasons(10), ['name: A new item needs its name', 'unit: A new item needs its unit', 'price: A new item needs its sale price']);
    assert.deepEqual(reasons(11), ['openingStock: The opening stock must be a whole number of each (piece)']);
    assert.deepEqual(data.newCategories, ['Pulses', 'Grains', 'Grains › Rice']);
    assert.deepEqual(data.opening, { items: 2, value: ((24 * 13050 + Math.round(50.5 * 9600)) / 100).toFixed(2), valueWords: `₹${((24 * 13050 + Math.round(50.5 * 9600)) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` });
    // Nothing is written by a check.
    assert.equal((await productsOf(grocery)).length, before);
    assert.equal((await one("SELECT count(*)::int AS n FROM catalog_categories WHERE business_id=$1 AND name='Pulses'", [grocery.id])).n, 0);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_imports')).n, 0);
  });

  await t.test('products: the import goes in through the core, with opening stock adding up, and is written once', async () => {
    const sheetRows = file(HEAD,
      ['Toor dal 1 kg', 'toor-1kg', '8901234567894', 'Pulses', 'Goods', 'pcs', '0713', '5%', '₹175', '160', '130.50', '10', '24', ''],
      ['Basmati rice', 'RICE-BAS', '', 'Grains › Rice', '', 'kgs', '1006', 'GST 5%', '', 'Rs. 1,250.00', '96', '25', '50.5', 'gdn'],
      ['Home delivery', 'SVC-DEL', '', '', 'Service', 'service', '996812', '18', '', '30', '', '', '', ''],
      ['Sugar 1 kg', 'SUGAR-1', '', 'Pulses', 'Goods', 'bags', '1701', '5%', '', '48', '', '', '', ''],
    );
    const checked = await request('POST', G('catalog/import'), importing('catalog', sheetRows));
    const requestKey = key();
    const done = await answer('POST', G('catalog/import'), { rows: sheetRows, dryRun: false, fileName: 'grocery.csv', fingerprint: checked.fingerprint, requestKey });
    assert.equal(done.message, 'Imported: 3 products added, 0 updated, opening stock for 2 items brought in; 1 row refused and left out');
    firstImport = { rows: sheetRows, requestKey, data: done.data };
    const items = await productsOf(grocery);
    const toor = items.find((s) => s.code === 'TOOR-1KG');
    const rice = items.find((s) => s.code === 'RICE-BAS');
    const delivery = items.find((s) => s.code === 'SVC-DEL');
    assert.deepEqual([toor.label, toor.barcode, toor.unit, toor.tracking, Number(toor.price), Number(toor.mrp), toor.hsn_code, String(toor.tax_rate_id), toor.category, Number(toor.reorder_level), Number(toor.stock)],
      ['Toor dal 1 kg', '8901234567894', 'each', 'quantity', 160, 175, '0713', String(gst5.id), 'Pulses', 10, 24]);
    assert.deepEqual([rice.unit, Number(rice.price), rice.category, Number(rice.stock)], ['kg', 1250, 'Rice', 50.5]);
    assert.deepEqual([delivery.kind, delivery.unit, delivery.tracking, String(delivery.tax_rate_id)], ['service', 'service', 'none', String(gst18.id)]);
    assert.ok(!items.some((s) => s.code === 'SUGAR-1'));
    // The categories made, the rice's under its parent.
    const grains = await one("SELECT id FROM catalog_categories WHERE business_id=$1 AND name='Grains' AND parent_id IS NULL", [grocery.id]);
    assert.ok(await one("SELECT id FROM catalog_categories WHERE business_id=$1 AND name='Rice' AND parent_id=$2", [grocery.id, grains.id]));
    assert.equal((await audits(grocery, 'category.created')).length, 3);
    // Opening stock: a lot at the purchase price, at the location named, through the core's adjustment.
    const lots = await rows('SELECT l.sku_id,l.location_id,l.quantity,l.unit_cost FROM business_stock_lots l WHERE l.business_id=$1 ORDER BY l.id', [grocery.id]);
    assert.deepEqual(lots.map((l) => [l.sku_id, l.location_id, l.quantity, l.unit_cost]),
      [[toor.id, shop.id, '24.000', '130.5000'], [rice.id, godown.id, '50.500', '96.0000']]);
    const value = lots.reduce((sum, l) => sum + Math.round(Number(l.quantity) * paise(l.unit_cost)), 0);
    assert.equal((value / 100).toFixed(2), done.data.opening.value);
    const moves = await request('GET', G('movements?limit=100'));
    assert.deepEqual(moves.items.map((m) => [m.label, m.source, m.reason, Number(m.quantity)]).sort(),
      [['Basmati rice', 'correction', 'Opening stock', 50.5], ['Toor dal 1 kg', 'correction', 'Opening stock', 24]]);
    const events = await rows("SELECT payload FROM business_events WHERE business_id=$1 AND kind='stock.adjusted' ORDER BY id", [grocery.id]);
    assert.deepEqual(events.map((e) => [e.payload.skuId, e.payload.quantity, e.payload.reason]), [[toor.id, 24, 'Opening stock'], [rice.id, 50.5, 'Opening stock']]);
    // The activity log: each item as made by hand, and the import with its counts.
    assert.deepEqual((await audits(grocery, 'catalog.created')).map((a) => a.entity_id).sort(), [toor.id, rice.id, delivery.id].sort());
    assert.equal((await audits(grocery, 'stock.adjusted')).length, 2);
    const [imported] = await audits(grocery, 'catalog.imported');
    assert.deepEqual(imported.details, { fileName: 'grocery.csv', rows: 4, created: 3, updated: 0, unchanged: 0, skipped: 0, refused: 1, mode: 'skip', openingStock: 2, newCategories: 3 });
    const saved = await one('SELECT * FROM business_imports WHERE id=$1', [imported.entity_id]);
    assert.deepEqual([saved.kind, saved.request_key, saved.file_name, saved.update_matching, saved.rows_read, saved.created_count, saved.refused_count],
      ['products', requestKey, 'grocery.csv', false, 4, 3, 1]);
    assert.equal(done.data.importId, saved.id);
    // An import is kept as it was done.
    await assert.rejects(pool.query('UPDATE business_imports SET file_name=$2 WHERE id=$1', [saved.id, 'other.csv']), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM business_imports WHERE id=$1', [saved.id]), { code: '23514' });
  });

  await t.test('products: the same import sent again answers the first, and its key with other rows is refused', async () => {
    const again = await answer('POST', G('catalog/import'), { rows: firstImport.rows, dryRun: false, fileName: 'grocery.csv', requestKey: firstImport.requestKey });
    assert.equal(again.message, firstImport.data.message);
    assert.deepEqual([again.data.created, again.data.refused, again.data.repeated], [3, 1, true]);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_imports WHERE business_id=$1', [grocery.id])).n, 1);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_stock_lots WHERE business_id=$1', [grocery.id])).n, 2);
    const other = await refused('POST', G('catalog/import'), { rows: firstImport.rows.slice(0, 2), dryRun: false, requestKey: firstImport.requestKey });
    assert.deepEqual([other.status, other.message], [409, 'This request key was already used for different data']);
    assert.equal((await refused('POST', G('catalog/import'), { rows: firstImport.rows, dryRun: false })).message, 'A valid request key is required');
  });

  await t.test('products: items already here are left as they are, or updated where chosen; opening stock goes in once', async () => {
    // The same file again: every item found, nothing to change.
    const same = await request('POST', G('catalog/import'), importing('catalog', firstImport.rows.slice(0, 3)));
    assert.deepEqual(same.rows.map((r) => r.action), ['unchanged', 'unchanged', 'unchanged']);
    assert.equal(same.rows[0].notes[0], 'Toor dal 1 kg already has stock on record, so the opening stock is not added: a stock count corrects it.');
    // A new price and a rename, found by the code and by the barcode.
    const plain = await productsOf(grocery);
    await request('POST', G('catalog'), { kind: 'goods', tracking: 'quantity', name: 'Moong dal 1 kg', code: 'MOONG-1', unit: 'each', price: '140', taxRateId: gst5.id }, 201);
    const changes = file(['Code', 'Barcode', 'Name', 'Sale price', 'MRP', 'GST rate', 'Reorder level', 'Opening stock', 'Purchase price', 'Location'],
      ['TOOR-1KG', '', '', '165', '', '', '', '', '', ''],
      ['', '8901234567894', 'Toor dal (1 kg pack)', '', '', '', '', '', '', ''],
      ['MOONG-1', '', '', '', '160', '18%', '12', '30', '120', 'Godown'],
      ['SVC-DEL', '', '', '30', '', '', '', '', '', '']);
    const skipping = await request('POST', G('catalog/import'), importing('catalog', changes));
    assert.deepEqual(skipping.rows.map((r) => r.action), ['skipped', 'refused', 'skipped', 'unchanged']);
    assert.equal(skipping.rows[1].reasons[0].message, 'Row 2 is the same item');
    assert.equal(skipping.rows[0].notes[0], 'Already here: left as it is (you chose to leave items already here as they are).');
    const updating = await request('POST', G('catalog/import'), importing('catalog', [changes[0], changes[2], changes[3]], { mode: 'update' }));
    assert.deepEqual(updating.rows.map((r) => r.action), ['update', 'update', 'unchanged']);
    assert.deepEqual(updating.rows[0].changes, [{ field: 'price', label: 'Sale price', from: '₹160.00', to: '₹165.00' }]);
    assert.deepEqual(updating.rows[1].changes.map((c) => [c.label, c.from, c.to]),
      [['GST rate', 'GST 5%', 'GST 18%'], ['MRP', '—', '₹160.00'], ['Reorder level', '0', '12'], ['Opening stock', '—', '30 each at Godown']]);
    const done = await answer('POST', G('catalog/import'), { rows: [changes[0], changes[2], changes[3]], dryRun: false, mode: 'update', fingerprint: updating.fingerprint, requestKey: key() });
    assert.equal(done.message, 'Imported: 0 products added, 2 updated, opening stock for 1 item brought in');
    const after = await productsOf(grocery);
    const toor = after.find((s) => s.code === 'TOOR-1KG');
    const moong = after.find((s) => s.code === 'MOONG-1');
    assert.equal(Number(toor.price), 165);
    assert.deepEqual([Number(moong.mrp), String(moong.tax_rate_id), Number(moong.reorder_level), Number(moong.stock)], [160, String(gst18.id), 12, 30]);
    assert.equal(after.length, plain.length + 1);
    // The item form's own activity rows: the price and the slab changed.
    assert.equal((await audits(grocery, 'catalog.price_changed')).filter((a) => a.entity_id === toor.id).at(-1).details.to, '165.00');
    assert.ok((await audits(grocery, 'catalog.slab_changed')).some((a) => a.entity_id === moong.id));
    assert.equal((await audits(grocery, 'catalog.imported')).at(-1).details.mode, 'update');
    // Stock already on record keeps it, whatever the file says.
    const recheck = await request('POST', G('catalog/import'), importing('catalog', [changes[2]], { mode: 'update' }));
    assert.equal(recheck.rows[0].action, 'unchanged');
  });

  await t.test('products: a file checked before the items moved is checked again', async () => {
    const sheetRows = file(['Code', 'Sale price'], ['TOOR-1KG', '170']);
    const checked = await request('POST', G('catalog/import'), importing('catalog', sheetRows, { mode: 'update' }));
    const toor = (await productsOf(grocery)).find((s) => s.code === 'TOOR-1KG');
    await request('PATCH', G(`catalog/${toor.id}`), { label: toor.label, price: '168', active: true, taxRateId: toor.tax_rate_id });
    const stale = await refused('POST', G('catalog/import'), { rows: sheetRows, dryRun: false, mode: 'update', fingerprint: checked.fingerprint, requestKey: key() });
    assert.deepEqual([stale.status, stale.data.reason], [409, 'stale_preview']);
    assert.equal(stale.message, 'Something in these records changed since the file was checked. Check the file again to see what it would do now. Nothing was imported.');
    assert.equal(Number((await productsOf(grocery)).find((s) => s.code === 'TOOR-1KG').price), 168);
  });

  await t.test('products: what never changes from a file, and a file that cannot be read', async () => {
    const checked = await request('POST', G('catalog/import'), importing('catalog', file(['Code', 'Barcode', 'Kind', 'Unit', 'Stock tracking', 'Name'],
      ['TOOR-1KG', '', 'Service', '', '', ''],
      ['RICE-BAS', '', '', 'each', '', ''],
      ['MOONG-1', '', '', '', 'Batch', ''],
      ['SVC-DEL', '8901234567894', '', '', '', ''],
      [`${'X'.repeat(61)}`, '', '', '', '', 'Long code'],
      ['NEW-3', '', 'Furniture', '', '', 'Desk'])));
    const reasons = checked.rows.map((r) => r.reasons.map((x) => x.message));
    assert.deepEqual(reasons, [
      ['Toor dal 1 kg is goods: an item\'s kind does not change'],
      ['Basmati rice is counted in kilogram: an item\'s unit does not change'],
      ['Moong dal 1 kg is kept by quantity: an item\'s stock tracking does not change'],
      ['Barcode 8901234567894 is on Toor dal 1 kg (TOOR-1KG), not on Home delivery'],
      ['A code has at most 60 characters', 'A new item needs its unit', 'A new item needs its sale price'],
      ['A new item needs its unit', 'A new item needs its sale price', '"Furniture" is not a kind: write Goods or Service'],
    ]);
    const newCode = await request('POST', G('catalog/import'), importing('catalog', file(['Code', 'Barcode', 'Name', 'Unit', 'Sale price'],
      ['NEW-2', '8901234567894', 'Another dal', 'each', '150'])));
    assert.deepEqual(newCode.rows[0].reasons.map((x) => x.message), ['Barcode 8901234567894 is on Toor dal 1 kg, whose code is TOOR-1KG: an item\'s code does not change']);
    // A whole file that cannot be read: checked as problems, and refused if sent anyway.
    const noCode = file(['Name', 'Sale price'], ['Loose item', '10']);
    const problems = await answer('POST', G('catalog/import'), importing('catalog', noCode));
    assert.deepEqual([problems.data.ok, problems.message], [false, '1 problem in the file. Fix them and check the file again.']);
    assert.deepEqual(problems.data.problems, [{ line: 1, column: 'code', message: 'The file needs a Code column: an item is found by its code (SKU), and a new one needs it' }]);
    const sent = await refused('POST', G('catalog/import'), { rows: noCode, dryRun: false, requestKey: key() });
    assert.deepEqual([sent.status, sent.message, sent.data.problems.length], [400, '1 problem in the file. Nothing was imported.', 1]);
    assert.equal((await refused('POST', G('catalog/import'), { rows: [], dryRun: true })).message, 'The file has no rows');
    assert.equal((await refused('POST', G('catalog/import'), { rows: 'Name,Code', dryRun: true })).message, 'Rows must be a list');
    assert.equal((await refused('POST', G('catalog/import'), { rows: noCode, dryRun: true, mode: 'replace' })).message, 'Records already here must be one of: skip, update');
  });

  await t.test('products: what a business type keeps its own details for is refused, with the screen to use', async () => {
    const F = (suffix) => `/businesses/${fuel.id}/${suffix}`;
    await request('POST', F('fuel/products'), { family: 'diesel', item: { name: 'High speed diesel', code: 'HSD-1' } }, 201);
    const checked = await request('POST', F('catalog/import'), importing('catalog', file(['Name', 'Code', 'Kind', 'Unit', 'Sale price', 'GST rate'],
      ['Petrol', 'MS-1', 'Petrol', 'litre', '102.50', 'Nil'],
      ['High speed diesel', 'HSD-1', '', '', '89.70', ''],
      ['High speed diesel', 'HSD-1', '', '', '0', ''],
      ['Engine oil 1 L', 'OIL-1', 'Goods', 'each', '450', '18%'])));
    assert.deepEqual(checked.rows.map((r) => [r.action, r.reasons?.[0]?.message || null]), [
      ['refused', 'A fuel is made in Settings › Pumps & nozzles, with its price at each outlet, not from a file'],
      ['refused', 'High speed diesel is a fuel: it is changed in Settings › Pumps & nozzles, not from a file'],
      ['refused', 'Row 3 is the same item'],
      ['create', null],
    ]);
    const unchanged = await request('POST', F('catalog/import'), importing('catalog', file(['Name', 'Code', 'Sale price'], ['High speed diesel', 'HSD-1', '0'])));
    assert.equal(unchanged.rows[0].action, 'unchanged');
    const piece = await request('POST', `/businesses/${jewellery.id}/catalog/import`, importing('catalog', file(['Name', 'Code', 'Unit', 'Sale price', 'Purity', 'Kind'],
      ['Gold chain', 'CH-22', 'each', '0', '22K', ''], ['Silver coin 10 g', 'COIN-10', 'each', '950', '', 'Goods'], ['Bangle', 'BG-1', 'each', '0', '', 'Ornament'])));
    assert.deepEqual(piece.rows.map((r) => [r.action, r.reasons?.[0]?.message || null]), [
      ['refused', 'A jewellery piece is made on Pieces & tags, with its purity and weight, not from a file'],
      ['create', null],
      ['refused', 'A jewellery piece is made on Pieces & tags, with its purity and weight, not from a file'],
    ]);
    const hire = await request('POST', `/businesses/${rentals.id}/catalog/import`, importing('catalog', file(['Name', 'Code', 'Unit', 'Sale price'],
      ['Shamiana 20 x 20', 'TENT-20', 'day', '1500'], ['Delivery charge', 'DEL-1', 'service', '300'])));
    assert.deepEqual(hire.rows.map((r) => [r.action, r.reasons?.[0]?.message || null]), [
      ['refused', 'Counted in days, it is a rental item: that is made in Rental items, with its rates, units and deposit, not from a file'],
      ['create', null],
    ]);
    // A pharmacy's medicines come in by batch, as its purchases need.
    const P = (suffix) => `/businesses/${pharmacy.id}/${suffix}`;
    const rx = await request('POST', P('catalog/import'), importing('catalog', file(['Name', 'Code', 'Unit', 'Sale price', 'Opening stock', 'Batch', 'Expiry', 'Stock tracking'],
      ['Paracetamol 500 mg strip', 'PCM-500', 'strip', '20', '40', 'B2401', '31-12-2027', ''],
      ['Cough syrup 100 ml', 'CS-100', 'bottle', '95', '10', '', '', ''],
      ['Cotton roll', 'COT-1', 'each', '45', '', '', '', 'Quantity'])));
    assert.deepEqual(rx.rows.map((r) => [r.action, r.reasons?.map((x) => x.message) || null]), [
      ['create', null],
      ['refused', ['Give the batch number of the opening stock']],
      ['refused', ['A pharmacy keeps its goods by batch and expiry: its purchases need them']],
    ]);
    assert.deepEqual((await request('GET', P('catalog/import-guide'))).notes,
      ['Medicines come in as items, kept by batch and expiry: add each one\'s drug details (composition, schedule) in Medicines & products › Drug master.']);
    await request('POST', P('catalog/import'), { rows: file(['Name', 'Code', 'Unit', 'Sale price', 'Opening stock', 'Batch', 'Expiry'],
      ['Paracetamol 500 mg strip', 'PCM-500', 'strip', '20', '40', 'B2401', '31-12-2027']), dryRun: false, requestKey: key() });
    const lot = await one("SELECT l.lot_code,l.expires_on,l.quantity,s.tracking FROM business_stock_lots l JOIN catalog_skus s ON s.id=l.sku_id WHERE l.business_id=$1", [pharmacy.id]);
    assert.deepEqual([lot.lot_code, lot.expires_on, lot.quantity, lot.tracking], ['B2401', '2027-12-31', '40.000', 'batch']);
  });

  const CUSTOMERS = ['Name', 'Phone', 'Email', 'GSTIN', 'State', 'Address', 'PAN', 'Credit limit', 'Credit days', 'Opening balance', 'Opening balance as of'];
  // Made-up GSTINs that pass the check: a Telangana and a Karnataka company.
  const { gstinCheckCharacter } = require('../../src/utils/gstin');
  const gstinOf = (first14) => `${first14}${gstinCheckCharacter(first14)}`;
  const tsGstin = gstinOf('36AABCS1234D1Z');
  const kaGstin = gstinOf('29AACCK4321M1Z');
  const wwGstin = gstinOf('36AABCW5678E1Z');
  const typo = `${tsGstin.slice(0, 14)}${tsGstin[14] === 'A' ? 'B' : 'A'}`;
  const opened = daysFrom(-30);
  const [day, month, year] = [opened.slice(8), opened.slice(5, 7), opened.slice(0, 4)];
  let customersImport;

  await t.test('customers: a phone is never needed, the GSTIN gives the state, and the opening balance is the contact\'s own', async () => {
    const sheetRows = file(CUSTOMERS,
      ['Ramesh Kumar', '+91 98480 11223', '', '', '', 'Gandhi Nagar', '', '5000', '15', '1,200', `${day}-${month}-${year}`],
      ['Lakshmi Devi', '', '', '', 'Telangana', 'Kirana Street', '', '', '', '450 Dr', ''],
      ['Sai Traders', '040 2345 6789', 'ACCOUNTS@SAITRADERS.IN', tsGstin, '', 'Industrial Estate', tsGstin.slice(2, 12), '50000', '30', '500 Cr', `${day}/${month}/${year}`],
      ['Karnataka Stores', '', '', kaGstin, 'Telangana', '', '', '', '', '', ''],
      ['Wrong PAN Co', '', '', wwGstin, '', '', 'ABCDE1234F', '', '', '', ''],
      ['Typo Traders', '', '', typo, '', '', '', '', '', '', ''],
      ['Short phone', '12345', '', '', '', '', '', '', '', '', ''],
      ['Later balance', '', '', '', '', '', '', '', '', '100', daysFrom(1).split('-').reverse().join('-')],
      ['Ramesh Kumar', '098480 11223', '', '', '', '', '', '', '', '', ''],
    );
    const checked = await answer('POST', G('contacts/import'), { kind: 'customer', ...importing('contacts', sheetRows) });
    const data = checked.data;
    assert.equal(checked.message, 'Ready: 3 new customers, 0 to update, 0 unchanged, 3 opening balances; 6 rows refused and left out');
    const byLine = Object.fromEntries(data.rows.map((r) => [r.line, r]));
    assert.deepEqual(byLine[2].details, { phone: '98480 11223', email: null, gstin: null, state: null, pan: null, creditLimit: '₹5,000.00', creditDays: '15',
      balance: `₹1,200.00 they owe you, as of ${Number(day)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month) - 1]} ${year}` });
    assert.equal(byLine[3].details.phone, null);
    assert.equal(byLine[4].details.state, 'Telangana');
    assert.match(byLine[4].details.balance, /^₹500\.00 you owe them, as of /);
    const reasons = (line) => byLine[line].reasons.map((r) => r.message);
    assert.deepEqual(reasons(5), [`The GSTIN ${kaGstin} is registered in Karnataka (29), not Telangana`]);
    assert.deepEqual(reasons(6), [`The PAN inside the GSTIN ${wwGstin} is ${wwGstin.slice(2, 12)}, not ABCDE1234F`]);
    assert.deepEqual(reasons(7), ['GSTIN has a typing mistake: its last character does not match the rest. Check it against the customer\'s GST certificate']);
    assert.deepEqual(reasons(8), ['"12345" is not a phone number: a mobile like 98765 43210, or a landline like 040 2345 6789']);
    assert.deepEqual(reasons(9), ['An opening balance cannot be dated in the future']);
    assert.deepEqual(reasons(10), ['Row 2 is the same customer']);
    assert.deepEqual(data.balances, { count: 3, total: '1150.00', totalWords: '₹1,150.00' });
    const requestKey = key();
    const done = await answer('POST', G('contacts/import'), { kind: 'customer', rows: sheetRows, dryRun: false, fileName: 'udhaar.csv', fingerprint: data.fingerprint, requestKey });
    assert.equal(done.message, 'Imported: 3 customers added, 0 updated, 3 opening balances set; 6 rows refused and left out');
    customersImport = { rows: sheetRows, requestKey };
    const people = (await request('GET', G('contacts?kind=customer&limit=100'))).items;
    const ramesh = people.find((c) => c.name === 'Ramesh Kumar');
    const lakshmi = people.find((c) => c.name === 'Lakshmi Devi');
    const sai = people.find((c) => c.name === 'Sai Traders');
    assert.deepEqual([ramesh.phone, Number(ramesh.credit_limit), ramesh.credit_days, Number(ramesh.opening_balance), ramesh.opening_balance_on, Number(ramesh.balance)],
      ['9848011223', 5000, 15, 1200, opened, 1200]);
    assert.deepEqual([lakshmi.phone, lakshmi.address, Number(lakshmi.opening_balance), lakshmi.opening_balance_on, lakshmi.credit_limit], [null, 'Kirana Street, Telangana', 450, today(), null]);
    assert.deepEqual([sai.phone, sai.email, sai.gstin, sai.pan, sai.address, Number(sai.opening_balance)], ['040 2345 6789', 'accounts@saitraders.in', tsGstin, tsGstin.slice(2, 12), 'Industrial Estate', -500]);
    // What they owe adds up: the opening balances are open items of the receivables.
    const total = people.filter((c) => [ramesh.id, lakshmi.id, sai.id].includes(c.id)).reduce((sum, c) => sum + paise(c.balance), 0);
    assert.equal(total, paise(done.data.balances.total));
    const account = await request('GET', G(`receivables/customers/${ramesh.id}`));
    assert.deepEqual(account.items.map((i) => [i.reference, Number(i.open_amount)]), [['Opening balance', 1200]]);
    // The activity log: each contact as the form makes it, and the import with its counts.
    assert.equal((await audits(grocery, 'contact.created')).filter((a) => [ramesh.id, lakshmi.id, sai.id].includes(a.entity_id)).length, 3);
    const [imported] = await audits(grocery, 'customers.imported');
    assert.deepEqual(imported.details, { fileName: 'udhaar.csv', rows: 9, created: 3, updated: 0, unchanged: 0, skipped: 0, refused: 6, mode: 'skip', openingBalances: 3 });
    assert.equal((await one('SELECT kind FROM business_imports WHERE id=$1', [imported.entity_id])).kind, 'customers');
  });

  await t.test('customers: found by GSTIN, phone or name; a balance already set stays; the same import twice is done once', async () => {
    const again = await answer('POST', G('contacts/import'), { kind: 'customer', rows: customersImport.rows, dryRun: false, requestKey: customersImport.requestKey });
    assert.equal(again.data.repeated, true);
    assert.equal((await request('GET', G('contacts?kind=customer&limit=100'))).total, 3);
    await request('POST', G('contacts'), { kind: 'customer', name: 'Gopal', phone: '' }, 201);
    await request('POST', G('contacts'), { kind: 'customer', name: 'Suresh', phone: '' }, 201);
    await request('POST', G('contacts'), { kind: 'customer', name: 'Suresh', phone: '' }, 201);
    const sheetRows = file(['Name', 'Phone', 'GSTIN', 'Opening balance', 'Credit days'],
      ['Ramesh K', '98480 11223', '', '900', '20'],
      ['', '', tsGstin, '', '45'],
      ['Gopal', '', '', '300', ''],
      ['Suresh', '', '', '', '7'],
      ['Gopal', '99887 76655', '', '', '']);
    const skipping = await request('POST', G('contacts/import'), { kind: 'customer', ...importing('contacts', sheetRows) });
    assert.deepEqual(skipping.rows.map((r) => r.action), ['skipped', 'skipped', 'skipped', 'refused', 'create']);
    assert.equal(skipping.rows[3].reasons[0].message, '2 customers are called Suresh: add their phone or GSTIN to say which');
    assert.equal(skipping.rows[4].notes[0], 'Gopal is already here with no phone or GSTIN: this row adds another customer. Leave the row out if it is the same customer.');
    const updating = await request('POST', G('contacts/import'), { kind: 'customer', ...importing('contacts', sheetRows.slice(0, 3), { mode: 'update' }) });
    assert.deepEqual(updating.rows.map((r) => r.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`)), [
      ['Name: Ramesh Kumar → Ramesh K', 'Credit days: 15 → 20'],
      ['Credit days: 30 → 45'],
      [`Opening balance: — → ₹300.00 they owe you, as of ${Number(today().slice(8))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(today().slice(5, 7)) - 1]} ${today().slice(0, 4)}`],
    ]);
    assert.equal(updating.rows[0].notes[0], `Ramesh Kumar already has an opening balance (₹1,200.00 they owe you, as of ${Number(day)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month) - 1]} ${year}): it stays; change it on their form if it is wrong.`);
    await request('POST', G('contacts/import'), { kind: 'customer', rows: sheetRows.slice(0, 3), dryRun: false, mode: 'update', fingerprint: updating.fingerprint, requestKey: key() });
    const people = (await request('GET', G('contacts?kind=customer&limit=100'))).items;
    assert.deepEqual(people.filter((c) => ['Ramesh K', 'Sai Traders', 'Gopal'].includes(c.name)).map((c) => [c.name, c.credit_days, Number(c.opening_balance)]).sort(),
      [['Gopal', 0, 300], ['Ramesh K', 20, 1200], ['Sai Traders', 45, -500]]);
    assert.ok((await audits(grocery, 'contact.updated')).length >= 3);
  });

  await t.test('suppliers: what was owed to them is their payable, Tally\'s Cr and Dr read the right way', async () => {
    const sheetRows = file(['Supplier name', 'Mobile', 'GSTIN', 'Credit limit', 'Credit days', 'Opening balance', 'As on date'],
      ['Sri Balaji Agencies', '9000012345', kaGstin, '10000', '30 days', '8,500.00 Cr', `${day}-${month}-${year}`],
      ['Annapurna Mills', '', '', '', '7', '1200 Dr', '']);
    const checked = await request('POST', G('contacts/import'), { kind: 'supplier', ...importing('contacts', sheetRows) });
    assert.deepEqual(checked.columns.ignored, ['Credit limit']);
    assert.deepEqual(checked.rows.map((r) => [r.action, r.details?.balance?.replace(/, as of .*$/, '')]), [['create', '₹8,500.00 you owe them'], ['create', '₹1,200.00 they owe you']]);
    await request('POST', G('contacts/import'), { kind: 'supplier', rows: sheetRows, dryRun: false, fingerprint: checked.fingerprint, requestKey: key() });
    const suppliers = (await request('GET', G('contacts?kind=supplier&limit=100'))).items;
    const balaji = suppliers.find((c) => c.name === 'Sri Balaji Agencies');
    assert.deepEqual([balaji.phone, balaji.credit_limit, balaji.credit_days, Number(balaji.opening_balance)], ['9000012345', null, 30, 8500]);
    assert.equal(Number(suppliers.find((c) => c.name === 'Annapurna Mills').opening_balance), -1200);
    const account = await request('GET', G(`suppliers/${balaji.id}/account`));
    assert.deepEqual(account.items.map((i) => [i.reference, Number(i.open_amount)]), [['Opening balance', 8500]]);
    assert.equal((await audits(grocery, 'suppliers.imported')).length, 1);
    // A customer and a supplier may share a GSTIN: each kind is its own book.
    const asCustomer = await request('POST', G('contacts/import'), { kind: 'customer', ...importing('contacts', file(['Name', 'GSTIN'], ['Balaji as a customer', kaGstin])) });
    assert.equal(asCustomer.rows[0].action, 'create');
  });

  await t.test('permissions: those that make the records by hand, and the business\'s own staff only', async () => {
    const cashier = await staff(grocery, 'csv-cashier@test.invalid', await roleOf(grocery, 'cashier'));
    const keeper = await staff(grocery, 'csv-keeper@test.invalid', await roleOf(grocery, 'stock_keeper'));
    const clerkRole = await request('POST', G('roles'), { name: 'Catalogue clerk', permissions: ['catalog.view', 'catalog.create'] }, 201);
    const clerk = await staff(grocery, 'csv-clerk@test.invalid', clerkRole);
    const items = file(['Name', 'Code', 'Unit', 'Sale price', 'Opening stock'], ['Poha 500 g', 'POHA-500', 'each', '45', '12']);
    const people = file(['Name', 'Phone'], ['Walk-in regular', '']);
    assert.deepEqual([(await refused('POST', G('catalog/import'), importing('catalog', items), cashier)).status, (await refused('GET', G('catalog/import-guide'), undefined, cashier)).status], [403, 403]);
    assert.equal((await refused('POST', G('catalog/import'), importing('catalog', items), cashier)).message, 'Your role (Cashier / sales) does not allow this: add products, services, categories and units.');
    const asCashier = await refused('POST', G('contacts/import'), { kind: 'customer', ...importing('contacts', people) }, cashier);
    assert.equal(asCashier.status, 200);
    const cashierUpdate = await refused('POST', G('contacts/import'), { kind: 'customer', ...importing('contacts', people, { mode: 'update' }) }, cashier);
    assert.deepEqual([cashierUpdate.status, cashierUpdate.message], [403, 'Your role (Cashier / sales) does not allow this: change customer and supplier details and credit terms.']);
    assert.equal((await refused('POST', G('contacts/import'), { kind: 'supplier', ...importing('contacts', people) }, keeper)).status, 403);
    assert.equal((await refused('POST', G('catalog/import'), importing('catalog', items), keeper)).status, 200);
    const clerkStock = await refused('POST', G('catalog/import'), importing('catalog', items), clerk);
    assert.deepEqual([clerkStock.status, clerkStock.message], [403, 'Your role may not bring stock in: leave the Opening stock column out of the file, or ask someone whose role corrects stock to import it.']);
    assert.equal((await refused('POST', G('catalog/import'), importing('catalog', items.map(({ 'Opening stock': _, ...rest }) => rest)), clerk)).status, 200);
    const clerkUpdate = await refused('POST', G('catalog/import'), importing('catalog', file(['Code', 'Sale price'], ['TOOR-1KG', '170']), { mode: 'update' }), clerk);
    assert.deepEqual([clerkUpdate.status, clerkUpdate.message], [403, 'Your role (Catalogue clerk) does not allow this: change prices, tax, categories, units and pack sizes.']);
    // Another owner's business looks like one that does not exist.
    assert.equal((await refused('POST', `/businesses/${otherGrocery.id}/catalog/import`, importing('catalog', items))).status, 404);
    assert.equal((await other('POST', `/businesses/${grocery.id}/contacts/import`, { kind: 'customer', ...importing('contacts', people) }, 404)).success, false);
  });

  await t.test('someone tied to one location and one department imports there only', async () => {
    const department = await request('POST', G('departments'), { name: 'Staples' }, 201);
    const staples = await request('POST', G('categories'), { name: 'Staples shelf', departmentId: department.id }, 201);
    const tied = await staff(grocery, 'csv-tied@test.invalid', await roleOf(grocery, 'stock_keeper'), { workLocationId: godown.id, workDepartmentId: department.id });
    const checked = await refused('POST', G('catalog/import'), importing('catalog', file(['Name', 'Code', 'Unit', 'Sale price', 'Category', 'Opening stock', 'Location'],
      ['Rava 1 kg', 'RAVA-1', 'each', '60', 'Staples shelf', '5', ''],
      ['Sooji 1 kg', 'SOOJI-1', 'each', '58', 'Pulses', '', ''],
      ['Besan 1 kg', 'BESAN-1', 'each', '90', '', '', ''],
      ['Maida 1 kg', 'MAIDA-1', 'each', '55', 'Staples shelf', '5', shop.name],
      ['Flours', 'FLOUR-1', 'each', '50', 'Flours', '', ''])), tied);
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.data.rows.map((r) => [r.action, r.reasons?.[0]?.message || r.details.opening]), [
      ['create', '5 each at Godown'],
      ['refused', 'Pulses is outside Staples, where you work'],
      ['refused', 'Give a category of Staples: you add the items of that department'],
      ['refused', `You work at Godown only: opening stock goes in there`],
      ['create', null],
    ]);
    const flours = await refused('POST', G('catalog/import'), { rows: file(['Name', 'Code', 'Unit', 'Sale price', 'Category'], ['Flours', 'FLOUR-1', 'each', '50', 'Flours']),
      dryRun: false, requestKey: key() }, tied);
    assert.deepEqual([flours.status, flours.message], [200, 'Imported: 1 product added, 0 updated']);
    assert.equal((await one("SELECT department_id FROM catalog_categories WHERE business_id=$1 AND name='Flours'", [grocery.id])).department_id, department.id);
    assert.equal((await one('SELECT p.category_id FROM catalog_skus s JOIN catalog_products p ON p.id=s.product_id WHERE s.business_id=$1 AND s.code=$2', [grocery.id, 'RAVA-1'])), undefined);
    assert.ok(staples.id);
  });

  await t.test('a file holds up to 5,000 rows, sent at once', async () => {
    const many = Array.from({ length: 5000 }, (_, at) => ({ Name: `Bulk item number ${at + 1} with a longer name for its shelf label`, Code: `BULK-${String(at + 1).padStart(5, '0')}`,
      Barcode: `89000${String(at + 1).padStart(8, '0')}`, Category: 'Bulk', Unit: 'each', 'HSN / SAC': '39249090', 'GST rate': '18%', 'Sale price': '99.50',
      'Reorder level': '5', MRP: '120' }));
    assert.ok(JSON.stringify({ rows: many }).length > 1024 * 1024, 'the file is over the 1 MB other requests are held to');
    const checked = await request('POST', G('catalog/import'), importing('catalog', many));
    assert.equal(checked.created, 5000);
    const over = await refused('POST', G('catalog/import'), importing('catalog', [...many, many[0]]));
    assert.deepEqual([over.status, over.message], [400, 'That is more than 5,000 rows. Split the file and import it in parts.']);
  });
});
