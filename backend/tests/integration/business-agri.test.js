const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom } = require('./helpers/dates');

// Licences & registrations (every type but a restaurant) and the seeds,
// fertilisers & pesticides shop's own tools: the item classification, the
// checks on every bill (licences, banned and crop-restricted molecules, seed
// lots, PoS receipts), farmers and village dues with season credit, the
// subsidy reconciliation and the registers. Money to the paisa, idempotent
// postings, the rules the database keeps, audit and events, other types and
// other owners. Runs on its own throwaway database with every migration applied.
test('licences and the seeds, fertilisers & pesticides shop', { timeout: 300000 }, async (t) => {
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
  const password = `Agri-${crypto.randomBytes(8).toString('hex')}`;
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
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  await owner('agri-owner');
  await owner('agri-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(await login('agri-owner@test.invalid'));
  const other = as(await login('agri-other@test.invalid'));

  const [agri, grocery, optical] = await createBusinesses(request, 'OWNER', ['agri_inputs', 'grocery', 'optical']);
  await createBusinesses(other, 'OTHER', ['agri_inputs']);

  await t.test('modules, permissions and roles per type', async () => {
    for (const code of ['licences', 'agri', 'batches']) assert.ok(agri.capabilities.includes(code), `a farm-input shop starts with ${code}`);
    for (const business of [grocery, optical]) {
      assert.ok(!business.capabilities.includes('licences'), `${business.business_type} starts without licences`);
      assert.ok(!business.capabilities.includes('agri'), `${business.business_type} has no agri`);
    }
    const tools = await request('GET', `/businesses/${agri.id}/modules`);
    assert.deepEqual([...tools.find((m) => m.code === 'agri').requires].sort(), ['batches', 'catalog', 'contacts', 'inventory', 'sales']);
    const opticalTools = await request('GET', `/businesses/${optical.id}/modules`);
    const licences = opticalTools.find((m) => m.code === 'licences');
    assert.equal(licences.recommended, true);
    assert.match(licences.recommended_note, /MD-42/);
    assert.ok(!opticalTools.some((m) => m.code === 'agri'), 'an optician is not offered the farm-input tools');
    assert.equal((await request('GET', `/businesses/${grocery.id}/modules`)).find((m) => m.code === 'licences').recommended, false);
    // Every recommended licences row starts off and says why; no restaurant row.
    const recommended = await rows("SELECT business_type FROM platform_module_business_types WHERE module_code='licences' AND recommended AND NOT enabled_by_default AND recommended_note IS NOT NULL ORDER BY 1");
    assert.deepEqual(recommended.map((r) => r.business_type), ['fuel_station', 'jewellery', 'optical', 'pharmacy', 'rentals']);
    assert.equal((await one("SELECT count(*)::int AS n FROM platform_module_business_types WHERE module_code='licences' AND business_type='restaurant'")).n, 0);
    // A grocery may keep its licences, never the farm-input tools.
    await request('PUT', `/businesses/${grocery.id}/modules/licences`, { enabled: true });
    await request('PUT', `/businesses/${grocery.id}/modules/agri`, { enabled: true }, 409);
    await request('PUT', `/businesses/${grocery.id}/modules/licences`, { enabled: false });
    // Batch tracking stays on while the farm-input tools need it.
    await request('PUT', `/businesses/${agri.id}/modules/batches`, { enabled: false }, 409);
    // The shared templates hold the new permissions in every business (the role copies too).
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2
      AND rp.permission_code ~ '^(licences|agri)\\.'`, [business.id, template])).p;
    assert.deepEqual(await grants(agri, 'manager'), ['agri.create', 'agri.edit', 'agri.view', 'licences.edit', 'licences.view']);
    assert.deepEqual(await grants(agri, 'cashier'), ['agri.create', 'agri.edit', 'agri.view']);
    assert.deepEqual(await grants(agri, 'stock_keeper'), ['agri.create', 'agri.view']);
    assert.deepEqual(await grants(agri, 'accountant'), ['agri.view', 'licences.view']);
    assert.deepEqual(await grants(agri, 'viewer'), ['agri.view', 'licences.view']);
    assert.deepEqual(await grants(grocery, 'viewer'), ['agri.view', 'licences.view'], 'role copies match their templates everywhere');
  });

  await t.test('the molecule master lists only cited entries, each with its source', async () => {
    const molecules = await rows('SELECT code,status,source FROM agri_molecules ORDER BY code');
    assert.equal(molecules.length, 18);
    assert.ok(molecules.every((m) => m.source.trim()));
    assert.deepEqual(molecules.filter((m) => m.status === 'banned').map((m) => m.code), ['dichlorvos', 'dicofol', 'dinocap', 'methomyl', 'phorate', 'triazophos']);
    const crops = await rows(`SELECT m.code,array_agg(mc.crop_code ORDER BY mc.crop_code) AS crops FROM agri_molecules m
      JOIN agri_molecule_crops mc ON mc.molecule_code=m.code GROUP BY m.code ORDER BY m.code`);
    assert.deepEqual(Object.fromEntries(crops.map((r) => [r.code, r.crops])), {
      chlorpyrifos: ['ber', 'citrus', 'tobacco'], dimethoate: ['fruits_vegetables_raw'], malathion: ['castor', 'pea', 'sorghum', 'soybean', 'sunflower'],
      mancozeb: ['guava', 'sorghum', 'tapioca'], monocrotophos: ['vegetables'], oxyfluorfen: ['groundnut', 'potato'], quinalphos: ['cardamom', 'jute', 'sorghum'],
    });
    // Every shop of the type reads it; another type does not.
    const read = await request('GET', `/businesses/${agri.id}/agri/molecules`);
    assert.equal(read.molecules.length, 18);
    assert.deepEqual(read.molecules.find((m) => m.code === 'chlorpyrifos').crops.map((c) => c.name), ['Ber', 'Citrus', 'Tobacco']);
    assert.ok(read.crops.find((c) => c.code === 'sorghum').aliases.includes('jowar'));
    await request('GET', `/businesses/${grocery.id}/agri/molecules`, undefined, 404);
    await other('GET', `/businesses/${agri.id}/agri/molecules`, undefined, 404);
  });

  // --- Shared set-up: the shop, its slabs, its staff -------------------------------------------
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const sum = (list, field) => list.reduce((total, x) => total + paise(x[field]), 0);
  const A = (suffix) => `/businesses/${agri.id}/${suffix}`;
  const ownerToken = await login('agri-owner@test.invalid');
  const refused = async (method, route, body) => {
    const result = await call(method, route, body, ownerToken);
    return { status: result.status, message: result.body.message };
  };
  const shop = (await request('GET', A('locations'))).items[0];
  const slabs = (await request('GET', A('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18), nil = slabs.find((r) => Number(r.rate) === 0);
  const opening = (quantity, unitCost, extra = {}) => ({ openingStock: { quantity, unitCost, locationId: shop.id, ...extra } });
  const goods = (body, expected = 201) => request('POST', A('catalog'), { kind: 'goods', tracking: 'quantity', taxRateId: gst5.id, ...body }, expected);
  const roles = (await request('GET', A('roles?limit=100'))).items;
  const ownerRow = await one("SELECT u.restaurant_id FROM users u WHERE u.email='agri-owner@test.invalid'");
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerRow.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', A('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    return as(await login(email));
  }
  const cashier = await staff('agri-cashier@test.invalid', 'cashier');
  const viewer = await staff('agri-viewer@test.invalid', 'viewer');
  const keeper = await staff('agri-keeper@test.invalid', 'stock_keeper');
  const sale = (body, expected = 201, by = request) => by('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...body }, expected);
  const cash = { payment: { amount: 'full', method: 'cash' } };
  const year = Number(daysFrom(0).slice(0, 4));

  // --- Licences --------------------------------------------------------------------------------
  const licence = (body) => ({ locationId: shop.id, authority: 'Agriculture Officer, Rangareddy', validFrom: daysFrom(-400), ...body });
  let fertiliserLicence;
  await t.test('licences: each location keeps its own, renewed or switched off, never deleted', async () => {
    fertiliserLicence = await request('POST', A('licences'), licence({ kind: 'fertiliser', name: 'Fertiliser authorisation letter (Form A2)', licenceNo: 'FAL/RR/2025/1187',
      validUntil: daysFrom(30), covers: ['fertiliser'] }), 201);
    assert.deepEqual([fertiliserLicence.state, fertiliserLicence.days_left, fertiliserLicence.location_name, fertiliserLicence.covers, fertiliserLicence.active],
      ['expiring', 30, shop.name, ['fertiliser'], true]);
    // One number for a kind of licence; dates in order; known categories; a short code for the kind.
    await request('POST', A('licences'), licence({ kind: 'fertiliser', name: 'Copy', licenceNo: 'fal/rr/2025/1187', covers: ['fertiliser'] }), 409);
    await request('POST', A('licences'), licence({ kind: 'seed', name: 'Seed licence', licenceNo: 'S-1', validFrom: daysFrom(0), validUntil: daysFrom(-1) }), 400);
    await request('POST', A('licences'), licence({ kind: 'seed', name: 'Seed licence', licenceNo: 'S-1', covers: ['medicines'] }), 400);
    await request('POST', A('licences'), licence({ kind: 'Seed Licence!', name: 'Seed licence', licenceNo: 'S-1' }), 400);
    await request('POST', A('licences'), licence({ kind: 'seed', name: 'Seed licence', licenceNo: 'S-1', validFrom: '2026-02-30' }), 400);
    const seed = await request('POST', A('licences'), licence({ kind: 'seed', name: 'Seed dealer licence (Form B)', licenceNo: 'SDL/1123/2025', validUntil: daysFrom(700), covers: ['seed'] }), 201);
    const insecticide = await request('POST', A('licences'), licence({ kind: 'insecticide', name: 'Insecticide sale licence (Form VIII)', licenceNo: 'INS/RR/0457', covers: ['insecticide'] }), 201);
    assert.deepEqual([seed.state, insecticide.state, insecticide.valid_until, insecticide.days_left], ['valid', 'no_expiry', null, null]);
    // Who sees and changes them: the viewer sees, the cashier neither.
    const listed = await viewer('GET', A('licences'));
    assert.equal(listed.total, 3);
    assert.deepEqual(listed.items.map((l) => l.kind), ['fertiliser', 'seed', 'insecticide']);
    await viewer('POST', A('licences'), licence({ kind: 'trade', name: 'Trade licence', licenceNo: 'T-1' }), 403);
    await cashier('GET', A('licences'), undefined, 403);
    // A later valid-until date is a renewal; the activity log keeps from and to.
    const body = { name: fertiliserLicence.name, licenceNo: fertiliserLicence.licence_no, authority: fertiliserLicence.authority, validFrom: daysFrom(-400), covers: ['fertiliser'] };
    const renewed = await request('PATCH', A(`licences/${fertiliserLicence.id}`), { ...body, validUntil: daysFrom(800) });
    assert.deepEqual([renewed.state, renewed.days_left], ['valid', 800]);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='licence.renewed' AND entity_id=$2", [agri.id, fertiliserLicence.id]);
    assert.deepEqual([audit.details.from.validUntil, audit.details.to.validUntil], [daysFrom(30), daysFrom(800)]);
    // A licence keeps its kind and its location, and is never deleted.
    await request('PATCH', A(`licences/${fertiliserLicence.id}`), { ...body, validUntil: daysFrom(800), kind: 'seed' }, 400);
    await assert.rejects(pool.query('DELETE FROM business_licences WHERE id=$1', [fertiliserLicence.id]), /never deleted; switch it off/);
    await assert.rejects(pool.query("UPDATE business_licences SET kind='trade' WHERE id=$1", [fertiliserLicence.id]), /stays with the location and the kind/);
    // The bell: a licence running out within 60 days warns, one that has run out is critical.
    await request('POST', A('licences'), licence({ kind: 'trade', name: 'Trade licence', licenceNo: 'GHMC/TL/2291', validFrom: daysFrom(-365), validUntil: daysFrom(10) }), 201);
    const shops = await request('POST', A('licences'), licence({ kind: 'shop', name: 'Shops & establishments registration', licenceNo: 'SE/2022/7781', validFrom: daysFrom(-900), validUntil: daysFrom(-3) }), 201);
    assert.deepEqual([shops.state, shops.days_left], ['expired', -3]);
    const bell = async () => (await request('GET', A('notifications'))).items.filter((i) => i.category === 'Licences');
    let items = await bell();
    assert.deepEqual(items.map((i) => [i.severity, i.title]), [['critical', 'Shops & establishments registration has run out'], ['warning', 'Trade licence runs out in 10 days']]);
    assert.ok(items.every((i) => i.link.endsWith(`/business-admin/${agri.id}/licences`)));
    assert.match(items[1].detail, /^No\. GHMC\/TL\/2291 · /);
    // Switched off (surrendered): out of the bell, kept in the list.
    const off = await request('PATCH', A(`licences/${shops.id}`), { name: shops.name, licenceNo: shops.licence_no, validFrom: daysFrom(-900), validUntil: daysFrom(-3), active: false });
    assert.equal(off.state, 'off');
    items = await bell();
    assert.deepEqual(items.map((i) => i.title), ['Trade licence runs out in 10 days']);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='licence.switched_off' AND entity_id=$2", [agri.id, shops.id]));
    assert.equal((await request('GET', A('licences?state=off'))).total, 1);
    // Another owner never sees them; a business without the tool is refused; a grocery may switch it on.
    await other('GET', A('licences'), undefined, 404);
    await request('GET', `/businesses/${grocery.id}/licences`, undefined, 403);
    await request('PUT', `/businesses/${grocery.id}/modules/licences`, { enabled: true });
    const groceryShop = (await request('GET', `/businesses/${grocery.id}/locations`)).items[0];
    const fssai = await request('POST', `/businesses/${grocery.id}/licences`, { locationId: groceryShop.id, kind: 'fssai', name: 'FSSAI registration', licenceNo: '22426182000123', validFrom: daysFrom(-30), validUntil: daysFrom(1795) }, 201);
    assert.equal(fssai.state, 'valid');
    await request('POST', `/businesses/${grocery.id}/licences`, { locationId: shop.id, kind: 'trade', name: 'Trade licence', licenceNo: 'X-1', validFrom: daysFrom(-30) }, 404);
  });

  // --- Item classification ----------------------------------------------------------------------
  let urea, dap, paddy, cotton, chlorpyrifos, mancozeb, imidacloprid, sprayer;
  await t.test('items are classified as farm inputs and checked against the molecule master', async () => {
    urea = await goods({ name: 'Neem coated urea 45 kg', code: 'UREA-45', unit: 'bag', price: '266.50', mrp: '266.50', hsnCode: '3102',
      attributes: { inputKind: 'fertiliser', subsidised: true, netKg: '45' }, ...opening('100', '242') });
    assert.deepEqual(urea.attributes, { inputKind: 'fertiliser', subsidised: 'yes', netKg: '45' });
    dap = await goods({ name: 'DAP 18:46:0 50 kg', code: 'DAP-50', unit: 'bag', price: '1350', mrp: '1350', hsnCode: '3105',
      attributes: { inputKind: 'fertiliser', netKg: '50' }, ...opening('40', '1290') });
    paddy = await goods({ name: 'Paddy seed BPT 5204 (certified)', code: 'SEED-BPT', unit: 'kg', tracking: 'batch', price: '60', taxRateId: nil.id,
      attributes: { inputKind: 'seed', seedClass: 'certified', seedCrop: 'Paddy', seedVariety: 'BPT 5204' }, ...opening('200', '45', { lotCode: 'P-2601', expiresOn: daysFrom(120) }) });
    assert.deepEqual(paddy.attributes, { inputKind: 'seed', seedClass: 'certified', seedCrop: 'Paddy', seedVariety: 'BPT 5204' });
    cotton = await goods({ name: 'Bt cotton hybrid seed 475 g', code: 'SEED-BT', unit: 'packet', tracking: 'batch', price: '864', mrp: '864', taxRateId: nil.id,
      attributes: { inputKind: 'seed', seedClass: 'truthfully_labelled', seedCrop: 'Cotton', seedVariety: 'RCH 659', netKg: '0.475' }, ...opening('30', '760', { lotCode: 'BT-77', expiresOn: daysFrom(200) }) });
    chlorpyrifos = await goods({ name: 'Chlorpyrifos 20% EC 500 ml', code: 'CPF-500', unit: 'bottle', tracking: 'batch', price: '420', mrp: '450', taxRateId: gst18.id, hsnCode: '3808',
      attributes: { inputKind: 'pesticide', molecules: ['chlorpyrifos'], formulation: '20% EC', manufacturer: 'Dhanuka Agritech' }, ...opening('24', '330', { lotCode: 'CP-11', expiresOn: daysFrom(300) }) });
    // The master's spelling is kept for a molecule it lists; another is kept as typed.
    assert.deepEqual(chlorpyrifos.attributes.molecules, ['Chlorpyrifos']);
    assert.equal(chlorpyrifos.attributes.manufacturer, 'Dhanuka Agritech');
    mancozeb = await goods({ name: 'Mancozeb 75% WP 1 kg', code: 'MZB-1', unit: 'packet', tracking: 'batch', price: '480', taxRateId: gst18.id,
      attributes: { inputKind: 'pesticide', molecules: ['Mancozeb'], formulation: '75% WP' }, ...opening('20', '390', { lotCode: 'MZ-5', expiresOn: daysFrom(400) }) });
    imidacloprid = await goods({ name: 'Imidacloprid 17.8% SL 250 ml', code: 'IMI-250', unit: 'bottle', tracking: 'batch', price: '310', taxRateId: gst18.id,
      attributes: { inputKind: 'pesticide', molecules: ['  imidacloprid '], formulation: '17.8% SL' }, ...opening('10', '240', { lotCode: 'IM-3', expiresOn: daysFrom(500) }) });
    assert.deepEqual(imidacloprid.attributes.molecules, ['imidacloprid']);
    sprayer = await goods({ name: 'Knapsack sprayer 16 L', code: 'SPRAY-16', unit: 'each', price: '1450', taxRateId: gst5.id,
      attributes: { inputKind: 'other' }, ...opening('5', '1100') });

    // An item made of a banned molecule is refused at the catalogue, and by the database.
    const banned = await refused('POST', A('catalog'), { kind: 'goods', tracking: 'batch', taxRateId: gst18.id, name: 'Dicofol 18.5% EC', code: 'DCF-1', unit: 'bottle', price: '300',
      attributes: { inputKind: 'pesticide', molecules: ['Dicofol'] } });
    assert.equal(banned.status, 409);
    assert.match(banned.message, /^Dicofol is banned in India \(S\.O\. 4294\(E\), 3 October 2023\): an item made of it cannot be kept for sale\.$/);
    await assert.rejects(pool.query(`UPDATE catalog_skus SET attributes=attributes||'{"molecules":["Imidacloprid","Phorate"]}' WHERE id=$1`, [imidacloprid.id]), /Phorate is banned in India/);
    // A seed or pesticide is kept by batch; a seed's opening lot needs its validity date.
    const seedBody = { name: 'Maize seed', code: 'SEED-MZ', unit: 'kg', price: '320', taxRateId: nil.id, attributes: { inputKind: 'seed', seedCrop: 'Maize' } };
    assert.match((await refused('POST', A('catalog'), { kind: 'goods', tracking: 'quantity', ...seedBody })).message, /kept by batch.*Choose Batch & expiry tracking/);
    const noValidity = await refused('POST', A('catalog'), { kind: 'goods', tracking: 'batch', ...seedBody, ...opening('10', '250', { lotCode: 'MZ-1' }) });
    assert.equal(noValidity.status, 400);
    assert.match(noValidity.message, /validity date as its expiry: the test date on its tag plus 9 months/);
    // Each detail belongs to its kind; a service is no farm input; the details go together.
    await goods({ ...seedBody, code: 'X-1', tracking: 'batch', attributes: { inputKind: 'seed', subsidised: true } }, 400);
    await goods({ ...seedBody, code: 'X-2', tracking: 'batch', attributes: { inputKind: 'fertiliser', molecules: ['Urea'] } }, 400);
    await goods({ ...seedBody, code: 'X-3', tracking: 'batch', attributes: { inputKind: 'seed', seedClass: 'foundation' } }, 400);
    await goods({ ...seedBody, code: 'X-4', tracking: 'batch', attributes: { seedCrop: 'Maize' } }, 400);
    await goods({ ...seedBody, code: 'X-5', tracking: 'batch', attributes: { inputKind: 'manure' } }, 400);
    await goods({ ...seedBody, code: 'X-6', tracking: 'batch', attributes: { inputKind: 'seed', netKg: '0.0001' } }, 400);
    await request('POST', A('catalog'), { kind: 'service', name: 'Soil testing', code: 'SOIL', unit: 'service', tracking: 'none', price: '100', taxRateId: gst18.id,
      attributes: { inputKind: 'fertiliser' } }, 400);

    // The classification changes on the item form, kept in the activity log; other details do not.
    const edit = (sku, attributes, expected = 200) => request('PATCH', A(`catalog/${sku.id}`), { label: sku.label, price: sku.price, taxRateId: sku.tax_rate_id, active: true, attributes }, expected);
    const changed = await edit(imidacloprid, { inputKind: 'pesticide', molecules: ['Imidacloprid', 'cypermethrin'], formulation: '17.8% SL' });
    assert.deepEqual(changed.attributes, { inputKind: 'pesticide', molecules: ['Imidacloprid', 'Cypermethrin'], formulation: '17.8% SL' });
    const classified = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='catalog.classified' AND entity_id=$2", [agri.id, imidacloprid.id]);
    assert.deepEqual([classified.details.from.molecules, classified.details.to.molecules], [['imidacloprid'], ['Imidacloprid', 'Cypermethrin']]);
    await edit(imidacloprid, { formulation: '20% SL' }, 400);
    await edit(imidacloprid, { inputKind: 'pesticide', molecules: ['Methomyl'] }, 409);
    await edit(imidacloprid, { manufacturer: 'Bayer' }, 400);
    await edit(dap, { inputKind: 'seed' }, 400);
    // Taking an item out of the farm inputs, and back.
    assert.deepEqual((await edit(sprayer, { inputKind: '' })).attributes, {});
    assert.deepEqual((await edit(sprayer, { inputKind: 'other' })).attributes, { inputKind: 'other' });
    // A grocery has no farm-input details.
    await request('POST', `/businesses/${grocery.id}/catalog`, { kind: 'goods', tracking: 'quantity', name: 'Urea', code: 'U', unit: 'each', price: '10', attributes: { inputKind: 'fertiliser' } }, 400);
  });

  // --- Checks on every bill ---------------------------------------------------------------------
  await t.test('a fertiliser, seed or pesticide needs a licence in force at the selling location', async () => {
    const branch = await request('POST', A('locations'), { name: 'Kothur branch', code: 'KTR' }, 201);
    const supplier = await request('POST', A('contacts'), { kind: 'supplier', name: 'IFFCO depot, Shamshabad' }, 201);
    // Receiving stock needs no licence.
    await request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: branch.id, contactId: supplier.id, supplierBillNo: 'IF-221',
      lines: [{ skuId: urea.id, quantity: '20', unitPrice: '242' }, { skuId: paddy.id, quantity: '50', unitPrice: '45', lotCode: 'P-2602', expiresOn: daysFrom(150) },
        { skuId: sprayer.id, quantity: '2', unitPrice: '1100' }] }, 201);
    const atBranch = (lines, extra = {}) => refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: branch.id, lines, ...cash, ...extra });
    const ureaLine = [{ skuId: urea.id, quantity: '1' }];
    let answer = await atBranch(ureaLine, { agri: { posReceipt: '2610241130' } });
    assert.equal(answer.status, 409);
    assert.equal(answer.message, 'Neem coated urea 45 kg is a fertiliser, and Kothur branch holds no fertiliser licence (authorisation letter). Add or renew it under Settings › Licences, then bill it.');
    const branchLicence = await request('POST', A('licences'), licence({ locationId: branch.id, kind: 'fertiliser', name: 'Fertiliser authorisation letter (Form A2)', licenceNo: 'FAL/RR/2025/1201',
      validUntil: daysFrom(-1), covers: ['fertiliser'] }), 201);
    answer = await atBranch(ureaLine, { agri: { posReceipt: '2610241130' } });
    assert.match(answer.message, /Kothur branch's fertiliser licence \(authorisation letter\) \(FAL\/RR\/2025\/1201\) ran out on /);
    const body = { name: branchLicence.name, licenceNo: branchLicence.licence_no, validFrom: daysFrom(-400), validUntil: daysFrom(365), covers: ['fertiliser'] };
    await request('PATCH', A(`licences/${branchLicence.id}`), { ...body, active: false });
    assert.match((await atBranch(ureaLine, { agri: { posReceipt: '2610241130' } })).message, /\(FAL\/RR\/2025\/1201\) is switched off/);
    await request('PATCH', A(`licences/${branchLicence.id}`), { ...body, validFrom: daysFrom(2), active: true });
    assert.match((await atBranch(ureaLine, { agri: { posReceipt: '2610241130' } })).message, /is valid only from /);
    await request('PATCH', A(`licences/${branchLicence.id}`), { ...body, active: true });
    const fertiliserSale = await sale({ locationId: branch.id, lines: ureaLine, agri: { posReceipt: '2610241130' }, ...cash });
    assert.equal(fertiliserSale.total, '267.00');
    // A seed needs its own licence there; a sprayer needs none.
    answer = await atBranch([{ skuId: paddy.id, quantity: '5', lotCode: 'P-2602' }]);
    assert.match(answer.message, /^Paddy seed BPT 5204 \(certified\) is a seed, and Kothur branch holds no seed licence\./);
    await sale({ locationId: branch.id, lines: [{ skuId: sprayer.id, quantity: '1' }], ...cash });
    // With Licences & registrations off, bills are not checked against licences.
    await request('PUT', A('modules/licences'), { enabled: false });
    await request('GET', A('licences'), undefined, 403);
    const unchecked = await sale({ locationId: branch.id, lines: [{ skuId: paddy.id, quantity: '5', lotCode: 'P-2602' }], ...cash });
    assert.ok(await one('SELECT 1 FROM agri_sale_lines WHERE document_id=$1', [unchecked.id]), 'the line is still kept as a farm input');
    await request('PUT', A('modules/licences'), { enabled: true });
    // The database holds the same rule where the line is kept.
    const sprayed = await sale({ locationId: branch.id, lines: [{ skuId: sprayer.id, quantity: '1' }], ...cash });
    const line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [sprayed.id]);
    await assert.rejects(pool.query("INSERT INTO agri_sale_lines(business_id,line_id,document_id,sku_id,input_kind) VALUES($1,$2,$3,$4,'seed')", [agri.id, line.id, sprayed.id, paddy.id]),
      /holds no seed licence in force on/);
    // Shops with the licences at the counter.
    await request('POST', A('licences'), licence({ locationId: branch.id, kind: 'seed', name: 'Seed dealer licence (Form B)', licenceNo: 'SDL/1124/2025', validUntil: daysFrom(700), covers: ['seed'] }), 201);
    await sale({ locationId: branch.id, lines: [{ skuId: paddy.id, quantity: '2', lotCode: 'P-2602' }], ...cash });
  });

  await t.test('banned and crop-restricted molecules: never sold, and never for a barred crop', async () => {
    const pesticide = (crop, extra = {}) => refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash,
      lines: [{ skuId: chlorpyrifos.id, quantity: '1', lotCode: 'CP-11' }], ...(crop ? { agri: { crop } } : {}), ...extra });
    let answer = await pesticide(null);
    assert.equal(answer.status, 400);
    assert.equal(answer.message, 'Chlorpyrifos 20% EC 500 ml contains Chlorpyrifos, which must not be used on some crops: give the crop the farmer is buying it for.');
    answer = await pesticide('  citrus ');
    assert.equal(answer.status, 409);
    assert.equal(answer.message, 'Chlorpyrifos must not be used on citrus: Chlorpyrifos 20% EC 500 ml cannot be sold for it (S.O. 4294(E), 3 October 2023).');
    // The line's own crop goes before the bill's.
    answer = await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash, agri: { crop: 'Cotton' },
      lines: [{ skuId: chlorpyrifos.id, quantity: '1', lotCode: 'CP-11', crop: 'Tobacco' }] });
    assert.match(answer.message, /must not be used on tobacco/);
    // Jowar is sorghum.
    answer = await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash, agri: { crop: 'jowar' },
      lines: [{ skuId: mancozeb.id, quantity: '1', lotCode: 'MZ-5' }] });
    assert.match(answer.message, /^Mancozeb must not be used on sorghum \(jowar\): /);
    // Sold for another crop: the crop is kept as said, unmatched.
    const paddyBill = await sale({ lines: [{ skuId: chlorpyrifos.id, quantity: '1', lotCode: 'CP-11' }], agri: { crop: 'Paddy' }, ...cash });
    assert.deepEqual([paddyBill.subtotal, paddyBill.tax, paddyBill.total], ['355.93', '64.07', '420.00']);
    const kept = await one('SELECT input_kind,crop,crop_code,molecules,subsidised,pos_receipt FROM agri_sale_lines WHERE document_id=$1', [paddyBill.id]);
    assert.deepEqual(kept, { input_kind: 'pesticide', crop: 'Paddy', crop_code: null, molecules: ['Chlorpyrifos'], subsidised: false, pos_receipt: null });
    // A crop or a PoS receipt only on a farm input's line.
    assert.equal((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash,
      lines: [{ skuId: sprayer.id, quantity: '1', crop: 'Paddy' }] })).status, 400);
    // A molecule banned after the item was made (the platform's list grew): the bill is refused.
    await pool.query('ALTER TABLE catalog_skus DISABLE TRIGGER catalog_skus_agri_molecules');
    await pool.query(`UPDATE catalog_skus SET attributes=attributes||'{"molecules":["Imidacloprid","Triazophos"]}' WHERE id=$1`, [imidacloprid.id]);
    await pool.query('ALTER TABLE catalog_skus ENABLE TRIGGER catalog_skus_agri_molecules');
    answer = await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash, lines: [{ skuId: imidacloprid.id, quantity: '1', lotCode: 'IM-3' }] });
    assert.equal(answer.status, 409);
    assert.match(answer.message, /contains Triazophos, banned in India \(Pesticides banned, restricted or refused in India, as on 31 March 2024/);
    await pool.query('ALTER TABLE catalog_skus DISABLE TRIGGER catalog_skus_agri_molecules');
    await pool.query(`UPDATE catalog_skus SET attributes=attributes||'{"molecules":["Imidacloprid","Cypermethrin"]}' WHERE id=$1`, [imidacloprid.id]);
    await pool.query('ALTER TABLE catalog_skus ENABLE TRIGGER catalog_skus_agri_molecules');
    // The database refuses a banned molecule or a barred pair where the line is kept.
    const plain = await sale({ lines: [{ skuId: sprayer.id, quantity: '1' }], ...cash });
    const line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [plain.id]);
    const insert = (molecules, cropCode) => pool.query(`INSERT INTO agri_sale_lines(business_id,line_id,document_id,sku_id,input_kind,crop,crop_code,molecules)
      VALUES($1,$2,$3,$4,'pesticide',$5,$6,$7)`, [agri.id, line.id, plain.id, chlorpyrifos.id, cropCode ? 'x' : null, cropCode, molecules]);
    await assert.rejects(insert(['dicofol'], null), /Dicofol is banned in India/);
    await assert.rejects(insert(['Chlorpyrifos'], 'citrus'), /Chlorpyrifos must not be used on citrus/);
    await assert.rejects(pool.query("UPDATE agri_sale_lines SET crop='Rice' WHERE document_id=$1", [paddyBill.id]), /kept as it was billed/);
  });

  await t.test('a seed lot is sold only while valid; a receipt brings it in with its validity', async () => {
    const supplier = await request('POST', A('contacts'), { kind: 'supplier', name: 'Telangana State Seeds Development Corporation' }, 201);
    const receipt = (lines, expected) => request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines }, expected);
    const missing = await refused('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
      lines: [{ skuId: paddy.id, quantity: '20', unitPrice: '45', lotCode: 'P-2603' }] });
    assert.equal(missing.message, 'Paddy seed BPT 5204 (certified) is a seed: give lot P-2603\'s validity date as its expiry (the test date on its tag plus 9 months).');
    await receipt([{ skuId: paddy.id, quantity: '20', unitPrice: '45', lotCode: 'P-OLD', expiresOn: daysFrom(-1) }], 201);
    const old = await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash, lines: [{ skuId: paddy.id, quantity: '2', lotCode: 'P-OLD' }] });
    assert.equal(old.status, 409);
    assert.match(old.message, /^Seed lot P-OLD of Paddy seed BPT 5204 \(certified\) was valid until \d{1,2} [A-Z][a-z]{2} \d{4}: it cannot be sold\.$/);
    // A pesticide past its expiry is kept apart.
    await receipt([{ skuId: mancozeb.id, quantity: '4', unitPrice: '390', lotCode: 'MZ-OLD', expiresOn: daysFrom(-10) }], 201);
    const expired = await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash, agri: { crop: 'Chilli' },
      lines: [{ skuId: mancozeb.id, quantity: '1', lotCode: 'MZ-OLD' }] });
    assert.match(expired.message, /^Batch MZ-OLD of Mancozeb 75% WP 1 kg expired on .*: it cannot be sold\. Keep it apart, marked not for sale\.$/);
    // The database refuses a seed line from a lot past its validity.
    const seedSale = await sale({ lines: [{ skuId: paddy.id, quantity: '1', lotCode: 'P-2601' }], ...cash });
    const kept = await one('SELECT line_id FROM agri_sale_lines WHERE document_id=$1', [seedSale.id]);
    assert.ok(kept);
  });

  let posBills = [];
  await t.test('a subsidised fertiliser carries its PoS receipt; the PoS stock is reconciled day by day', async () => {
    const without = await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash, lines: [{ skuId: urea.id, quantity: '2' }] });
    assert.equal(without.status, 400);
    assert.equal(without.message, 'Neem coated urea 45 kg is a subsidised fertiliser: give the receipt number the PoS device printed for this sale.');
    assert.equal((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash,
      lines: [{ skuId: dap.id, quantity: '1', posReceipt: 'R-1' }] })).status, 400, 'a PoS receipt only on a subsidised fertiliser');
    assert.equal((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash, agri: { posReceipt: 'R-1' },
      lines: [{ skuId: dap.id, quantity: '1' }] })).status, 400, 'a PoS receipt only on a bill with a subsidised fertiliser');
    assert.equal((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash, agri: { posReceipt: 'no spaces allowed!' },
      lines: [{ skuId: urea.id, quantity: '1' }] })).status, 400);
    // Two PoS sales: 2 bags at 266.50 (the receipt on the bill), then 3 more and a DAP bag (the receipt on the line).
    const firstKey = key();
    const firstBody = { kind: 'sale', requestKey: firstKey, locationId: shop.id, lines: [{ skuId: urea.id, quantity: '2' }], agri: { posReceipt: '1024/0042' }, ...cash };
    const first = await cashier('POST', A('documents'), firstBody, 201);
    assert.deepEqual([first.subtotal, first.tax, first.round_off, first.total], ['507.62', '25.38', '0.00', '533.00']);
    assert.equal((await cashier('POST', A('documents'), firstBody, 201)).id, first.id, 'a retry is the same bill');
    await cashier('POST', A('documents'), { ...firstBody, agri: { posReceipt: '1024/0043' } }, 409);
    assert.equal((await one('SELECT count(*)::int AS n FROM agri_sale_lines WHERE document_id=$1', [first.id])).n, 1);
    const second = await cashier('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...cash,
      lines: [{ skuId: urea.id, quantity: '3', posReceipt: '1024/0047' }, { skuId: dap.id, quantity: '1' }] }, 201);
    // 3 × 266.50 = 799.50 and 1,350 at 5% inside; 2,149.50 rounds to 2,150.
    assert.deepEqual([second.subtotal, second.tax, second.round_off, second.total], ['2047.14', '102.36', '0.50', '2150.00']);
    const lines = (await request('GET', A(`documents/${second.id}`))).lines;
    assert.equal(sum(lines, 'net'), paise(second.subtotal));
    assert.equal(sum(lines, 'tax'), paise(second.tax));
    posBills = [first, second];
    // A bag comes back on the second bill.
    const ureaLine = lines.find((l) => l.sku_id === urea.id);
    await request('POST', A(`documents/${second.id}/returns`), { requestKey: key(), reason: 'Bag torn', lines: [{ lineId: ureaLine.id, quantity: '1', restock: true }] }, 201);
    // The outbox mirrors each subsidised sale; the activity log keeps the receipts.
    const event = await one("SELECT payload FROM business_events WHERE business_id=$1 AND kind='agri.subsidised_sale' AND entity_id=$2", [agri.id, second.id]);
    assert.deepEqual(event.payload.lines.map((l) => [l.skuId, l.quantity, l.posReceipt]), [[urea.id, 3, '1024/0047']]);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='sale.farm_inputs' AND entity_id=$2", [agri.id, first.id]);
    assert.deepEqual(audit.details.posReceipts, ['1024/0042']);

    // The PoS device shows 92 bags of urea; the shop has 100 − 2 − 3 + 1 = 96.
    const products = await keeper('GET', A(`agri/subsidy/products?locationId=${shop.id}`));
    assert.deepEqual(products.items.map((p) => [p.id, Number(p.stock), p.today]), [[urea.id, 96, null]]);
    const checkKey = key();
    const checkBody = { requestKey: checkKey, locationId: shop.id, lines: [{ skuId: urea.id, posStock: '92' }], notes: 'Read off the PoS at closing' };
    const checked = await keeper('POST', A('agri/subsidy/checks'), checkBody, 201);
    assert.deepEqual(checked.lines.map((l) => [l.sku_id, l.pos_stock, l.app_stock, l.difference]), [[urea.id, '92.000', '96.000', '4.000']]);
    assert.equal((await keeper('POST', A('agri/subsidy/checks'), checkBody, 201)).id, checked.id, 'a retry is the same entry');
    await keeper('POST', A('agri/subsidy/checks'), { ...checkBody, lines: [{ skuId: urea.id, posStock: '93' }] }, 409);
    await viewer('POST', A('agri/subsidy/checks'), { ...checkBody, requestKey: key() }, 403);
    await keeper('POST', A('agri/subsidy/checks'), { ...checkBody, requestKey: key(), lines: [{ skuId: dap.id, posStock: '3' }] }, 404);
    await keeper('POST', A('agri/subsidy/checks'), { ...checkBody, requestKey: key(), lines: [{ skuId: urea.id, posStock: '92.5' }] }, 400);
    // Typed again later that day, the last entry counts.
    await cashier('POST', A('agri/subsidy/checks'), { requestKey: key(), locationId: shop.id, lines: [{ skuId: urea.id, posStock: '96' }] }, 201);
    const report = await viewer('GET', A(`agri/subsidy?locationId=${shop.id}&from=${daysFrom(0)}&to=${daysFrom(0)}`));
    const row = report.rows.find((r) => r.sku_id === urea.id);
    assert.deepEqual([row.day, row.sold, row.bills, row.receipts, row.returned, row.pos_stock, row.app_stock, row.difference],
      [daysFrom(0), '5.000', 2, 2, '1.000', '96.000', '96.000', '0.000']);
    assert.deepEqual([report.totals.sold, report.totals.returned, report.totals.receipts, report.totals.differences], ['5.000', '1.000', 2, 0]);
    assert.equal((await keeper('GET', A(`agri/subsidy/products?locationId=${shop.id}`))).items[0].today.pos_stock, 96);
    // Kept as typed; the activity log and the outbox record each entry.
    await assert.rejects(pool.query('UPDATE agri_pos_check_lines SET pos_stock=0 WHERE check_id=$1', [checked.id]), /kept as it was entered/);
    await assert.rejects(pool.query('DELETE FROM agri_pos_checks WHERE id=$1', [checked.id]), /kept as it was entered/);
    assert.equal((await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='pos_stock.checked' AND entity_id=$2", [agri.id, checked.id])).details.differences, 1);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='agri.pos_stock_checked' AND entity_id=$2", [agri.id, checked.id]));
    await request('GET', A(`agri/subsidy?locationId=${shop.id}&from=${daysFrom(-100)}&to=${daysFrom(0)}`), undefined, 400);
  });

  // --- Farmers, village dues and season credit ----------------------------------------------
  let ramaiah, lakshmi;
  await t.test('farmers by village, with season credit due at the harvest', async () => {
    ramaiah = await cashier('POST', A('agri/farmers'), { name: 'Ramaiah Goud', phone: '9848012345', village: 'Kothur', relativeName: 'Venkaiah Goud',
      landAcres: '3.5', crops: 'Paddy, cotton', farmerId: 'TS-1029384756' }, 201);
    assert.deepEqual([ramaiah.name, ramaiah.village, ramaiah.land_acres, ramaiah.farmer_id], ['Ramaiah Goud', 'Kothur', '3.50', 'TS-1029384756']);
    assert.equal((await one('SELECT kind FROM business_contacts WHERE id=$1', [ramaiah.contact_id])).kind, 'customer');
    const existing = await request('POST', A('contacts'), { kind: 'customer', name: 'Lakshmi Bai', phone: '9701122334' }, 201);
    lakshmi = await request('PUT', A(`agri/farmers/${existing.id}`), { village: ' kothur ', relativeName: 'Narsimha', landAcres: '2' });
    assert.equal(lakshmi.village, 'kothur');
    await request('POST', A('agri/farmers'), { contactId: existing.id, village: 'Kothur' }, 409);
    await request('PUT', A(`agri/farmers/${existing.id}`), { village: 'Kothur', farmerId: 'ts-1029384756' }, 409);
    await request('PUT', A(`agri/farmers/${existing.id}`), { village: '' }, 400);
    await request('PUT', A(`agri/farmers/${existing.id}`), { village: 'Kothur', landAcres: '-1' }, 400);
    await viewer('PUT', A(`agri/farmers/${existing.id}`), { village: 'Kothur' }, 403);
    const supplier = await request('POST', A('contacts'), { kind: 'supplier', name: 'Coromandel depot' }, 201);
    await request('PUT', A(`agri/farmers/${supplier.id}`), { village: 'Kothur' }, 404);
    await assert.rejects(pool.query('DELETE FROM agri_farmers WHERE contact_id=$1', [existing.id]), /never deleted/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='farmer.added' AND entity_id=$2", [agri.id, existing.id]));
    lakshmi = await request('PUT', A(`agri/farmers/${existing.id}`), { village: 'Kothur', relativeName: 'Narsimha', landAcres: '2' });
    assert.equal((await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='farmer.updated' AND entity_id=$2 ORDER BY id DESC LIMIT 1", [agri.id, existing.id])).details.villageBefore, 'kothur');
    const shankar = await request('POST', A('agri/farmers'), { name: 'Shankar Reddy', village: 'Madgul' }, 201);

    // Ramaiah's kharif credit: 10 kg of paddy seed and a bottle of chlorpyrifos, due at the harvest.
    const harvest = daysFrom(45);
    const seasonBody = { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: ramaiah.contact_id, agri: { season: 'kharif', seasonYear: year, dueOn: harvest, crop: 'Paddy' },
      lines: [{ skuId: paddy.id, quantity: '10', lotCode: 'P-2601' }, { skuId: chlorpyrifos.id, quantity: '1', lotCode: 'CP-11' }] };
    const credit = await cashier('POST', A('documents'), seasonBody, 201);
    assert.deepEqual([credit.subtotal, credit.tax, credit.total, credit.due_on], ['955.93', '64.07', '1020.00', harvest]);
    assert.deepEqual(await one('SELECT season,season_year,buyer_name,village FROM agri_bills WHERE document_id=$1', [credit.id]),
      { season: 'kharif', season_year: year, buyer_name: null, village: null });
    assert.equal((await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='sale.farm_inputs' AND entity_id=$2", [agri.id, credit.id])).details.dueOn, harvest);
    // Season credit is for a named customer's bill left on credit.
    const walkIn = await refused('POST', A('documents'), { ...seasonBody, requestKey: key(), contactId: null, ...cash });
    assert.deepEqual([walkIn.status, walkIn.message], [400, 'Season credit is for a named customer: choose the farmer first']);
    const paid = await refused('POST', A('documents'), { ...seasonBody, requestKey: key(), ...cash });
    assert.equal(paid.message, 'This bill is paid in full: a season and its harvest due date go on a bill on credit');
    assert.equal((await refused('POST', A('documents'), { ...seasonBody, requestKey: key(), agri: { season: 'kharif', dueOn: harvest } })).status, 400);
    assert.equal((await refused('POST', A('documents'), { ...seasonBody, requestKey: key(), agri: { season: 'kharif', seasonYear: year, dueOn: daysFrom(-1) } })).status, 400);
    assert.equal((await refused('POST', A('documents'), { ...seasonBody, requestKey: key(), agri: { season: 'summer', seasonYear: year, dueOn: harvest } })).status, 400);
    assert.equal((await refused('POST', A('documents'), { ...seasonBody, requestKey: key(), agri: { season: 'rabi', seasonYear: year + 3, dueOn: harvest } })).status, 400);
    await assert.rejects(pool.query("UPDATE agri_bills SET season='rabi' WHERE document_id=$1", [credit.id]), /kept as they were billed/);
    // Lakshmi's udhaar from earlier, now overdue; Shankar owes nothing.
    const udhaar = await sale({ contactId: lakshmi.contact_id, lines: [{ skuId: dap.id, quantity: '1' }] });
    await pool.query('UPDATE business_documents SET due_on=$2 WHERE id=$1', [udhaar.id, daysFrom(-20)]);
    await request('POST', A(`documents/${udhaar.id}/payments`), { amount: '350.25', method: 'upi', requestKey: key() }, 201);

    const dues = await viewer('GET', A('agri/village-dues'));
    const kothur = dues.rows.find((r) => r.village_key === 'kothur');
    assert.deepEqual([kothur.village, kothur.farmers, kothur.owing, kothur.owed, kothur.overdue, kothur.season_due, kothur.next_harvest_due],
      ['Kothur', 2, 2, '2019.75', '999.75', '1020.00', harvest]);
    const madgul = dues.rows.find((r) => r.village_key === 'madgul');
    assert.deepEqual([madgul.farmers, madgul.owing, madgul.owed], [1, 0, '0.00']);
    assert.equal(dues.totals.owed, '2019.75');
    await keeper('GET', A('agri/village-dues'), undefined, 403);
    // Farmers by village; one farmer's bills with their season.
    const listed = await keeper('GET', A('agri/farmers?village=kothur'));
    assert.deepEqual(listed.items.map((f) => f.name).sort(), ['Lakshmi Bai', 'Ramaiah Goud']);
    assert.ok(listed.items.every((f) => !('balance' in f) && !('has_due' in f)), 'a role that sees no dues gets the farmers without them');
    await keeper('GET', A('agri/farmers?has_due=true'), undefined, 403);
    const owing = await viewer('GET', A('agri/farmers?has_due=true'));
    assert.deepEqual([owing.total, owing.items.map((f) => Number(f.balance)).sort((x, y) => x - y)], [2, [999.75, 1020]]);
    const detail = await viewer('GET', A(`agri/farmers/${ramaiah.contact_id}`));
    assert.deepEqual([detail.balance, detail.bills.length, detail.bills[0].season, detail.bills[0].season_year, detail.bills[0].due_on], ['1020.00', 1, 'kharif', year, harvest]);
    const hidden = await keeper('GET', A(`agri/farmers/${ramaiah.contact_id}`));
    assert.deepEqual([hidden.money, hidden.balance, hidden.bills], [false, null, []]);
    assert.equal(shankar.village, 'Madgul');
    // A walk-in farmer's name and village go on the bill (for the registers).
    const walkInBill = await sale({ buyer: { name: 'Mallesh' }, agri: { village: 'Shadnagar', crop: 'Chilli' }, lines: [{ skuId: chlorpyrifos.id, quantity: '2', lotCode: 'CP-11' }], ...cash });
    assert.deepEqual(await one('SELECT season,buyer_name,village FROM agri_bills WHERE document_id=$1', [walkInBill.id]), { season: null, buyer_name: 'Mallesh', village: 'Shadnagar' });
    assert.equal((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: ramaiah.contact_id, agri: { village: 'Kothur', crop: 'Paddy' },
      lines: [{ skuId: chlorpyrifos.id, quantity: '1', lotCode: 'CP-11' }] })).status, 400);
    // The bill shows its farm-input details and the licences it prints.
    const shown = await request('GET', A(`documents/${credit.id}`));
    assert.deepEqual(shown.agri.bill, { season: 'kharif', season_year: year, buyer_name: null, village: null });
    assert.deepEqual([shown.agri.farmer.village, shown.agri.farmer.relative_name, shown.agri.farmer.farmer_id], ['Kothur', 'Venkaiah Goud', 'TS-1029384756']);
    assert.deepEqual(shown.agri.lines.map((l) => [l.input_kind, l.crop]), [['seed', 'Paddy'], ['pesticide', 'Paddy']]);
    assert.deepEqual(shown.agri.licences.map((l) => l.licence_no), ['INS/RR/0457', 'SDL/1123/2025']);
    const pos = await request('GET', A(`documents/${posBills[1].id}`));
    assert.deepEqual(pos.agri.lines.map((l) => [l.input_kind, l.subsidised, l.pos_receipt]), [['fertiliser', true, '1024/0047'], ['fertiliser', false, null]]);
    assert.deepEqual(pos.agri.licences.map((l) => l.licence_no), ['FAL/RR/2025/1187']);
  });

  // --- Registers and the board ---------------------------------------------------------------
  await t.test('the board, the seed return and the insecticide register come from the transactions', async () => {
    // The opening stock came in two days ago; today's sales and returns follow.
    await pool.query(`UPDATE business_stock_movements SET created_at=now() - interval '2 days' WHERE business_id=$1 AND adjustment_id IS NOT NULL`, [agri.id]);
    const branchPrice = await request('PUT', A(`catalog/${dap.id}/branch-prices`), { prices: [{ locationId: shop.id, price: '1340' }] });
    assert.equal(branchPrice.changed, 1);
    const board = await viewer('GET', A(`agri/board?locationId=${shop.id}`));
    const byId = (rows, sku) => rows.find((r) => r.id === sku.id);
    // Urea: 100 at the start of today, 96 now (5 sold, 1 back); DAP 40, then 2 sold.
    assert.deepEqual([byId(board.rows, urea).opening, byId(board.rows, urea).closing, byId(board.rows, urea).price, byId(board.rows, urea).subsidised],
      ['100.000', '96.000', '266.50', true]);
    assert.deepEqual([byId(board.rows, dap).opening, byId(board.rows, dap).closing, byId(board.rows, dap).price, byId(board.rows, dap).mrp], ['40.000', '38.000', '1340.00', '1350.00']);
    assert.ok(byId(board.rows, paddy) && !byId(board.rows, chlorpyrifos), 'fertilisers and seeds, not pesticides');
    assert.equal(board.closed, false);
    const yesterday = await viewer('GET', A(`agri/board?locationId=${shop.id}&on=${daysFrom(-1)}`));
    assert.deepEqual([byId(yesterday.rows, urea).opening, byId(yesterday.rows, urea).closing, yesterday.closed], ['100.000', '100.000', true]);
    await viewer('GET', A(`agri/board?locationId=${shop.id}&on=${daysFrom(1)}`), undefined, 400);

    // The seed return of this month at the shop: each seed's opening, receipts, sales, other changes and closing.
    const month = daysFrom(0).slice(0, 7);
    const ret = await viewer('GET', A(`agri/seed-return?locationId=${shop.id}&month=${month}`));
    const paddyRow = byId(ret.rows, paddy);
    for (const row of ret.rows) {
      assert.equal(Math.round(Number(row.opening) * 1000) + Math.round(Number(row.purchased) * 1000) - Math.round(Number(row.sold) * 1000) + Math.round(Number(row.other) * 1000),
        Math.round(Number(row.closing) * 1000), `${row.label} adds up`);
    }
    // Paddy at the shop: 200 opening stock, 20 kg of P-OLD received; 1 + 10 kg sold.
    assert.deepEqual([paddyRow.purchased, paddyRow.sold, paddyRow.closing, paddyRow.closing_q, paddyRow.crop, paddyRow.variety, paddyRow.seed_class],
      ['20.000', '11.000', '209.000', '2.0900', 'Paddy', 'BPT 5204', 'certified']);
    const cottonRow = byId(ret.rows, cotton);
    assert.deepEqual([cottonRow.closing, cottonRow.closing_q], ['30.000', '0.1425']);
    assert.match(ret.dueOn, /^\d{4}-\d{2}-05$/);
    await viewer('GET', A(`agri/seed-return?locationId=${shop.id}&month=2026-13`), undefined, 400);

    // The insecticide sale register: every pesticide sold, with the farmer, batch, maker and expiry.
    const register = await viewer('GET', A(`agri/insecticide-register?from=${daysFrom(0)}&to=${daysFrom(0)}`));
    const chlorpyrifosRows = register.rows.filter((r) => r.product === chlorpyrifos.label);
    assert.deepEqual(chlorpyrifosRows.map((r) => [r.farmer || 'walk-in', r.village, Number(r.quantity), r.batch, r.manufacturer, r.expires_on, r.crop]), [
      ['walk-in', null, 1, 'CP-11', 'Dhanuka Agritech', daysFrom(300), 'Paddy'],
      ['Ramaiah Goud', 'Kothur', 1, 'CP-11', 'Dhanuka Agritech', daysFrom(300), 'Paddy'],
      ['Mallesh', 'Shadnagar', 2, 'CP-11', 'Dhanuka Agritech', daysFrom(300), 'Chilli'],
    ]);
    assert.ok(register.rows.every((r) => r.location_name));
    await viewer('GET', A(`agri/insecticide-register?from=${daysFrom(-400)}&to=${daysFrom(0)}`), undefined, 400);
  });

  // --- Other types, other owners, the module off ---------------------------------------------
  await t.test('the farm-input tools belong to the type, the business and the module', async () => {
    const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
    for (const route of ['agri/farmers', 'agri/village-dues', `agri/board?locationId=${shop.id}`]) await request('GET', G(route), undefined, 403);
    await other('GET', A('agri/farmers'), undefined, 404);
    await other('GET', A(`agri/farmers/${ramaiah.contact_id}`), undefined, 404);
    // A grocery's bill and any purchase carry no farm-input details.
    const groceryShop = (await request('GET', G('locations'))).items[0];
    const rice = await request('POST', G('catalog'), { kind: 'goods', tracking: 'quantity', name: 'Sona masoori rice 25 kg', code: 'RICE25', unit: 'each', price: '1450' }, 201);
    const groceryBill = await refused('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: groceryShop.id, lines: [{ skuId: rice.id, quantity: '1' }], agri: { crop: 'Paddy' }, ...cash });
    assert.deepEqual([groceryBill.status, groceryBill.message], [400, 'Crops, PoS receipts and season credit go on the sales of a seeds, fertilisers & pesticides shop with its tools switched on']);
    const supplier = (await request('GET', A('contacts?kind=supplier'))).items[0];
    assert.equal((await refused('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, agri: { posReceipt: 'R-9' },
      lines: [{ skuId: urea.id, quantity: '1', unitPrice: '242' }] })).status, 400);
    // Switched off, the screens and the bill checks are off; the classification stays with the items.
    await request('PUT', A('modules/agri'), { enabled: false });
    await request('GET', A('agri/farmers'), undefined, 403);
    await request('GET', A('agri/molecules'), undefined, 403);
    const unchecked = await sale({ lines: [{ skuId: urea.id, quantity: '1' }], ...cash });
    assert.equal((await one('SELECT count(*)::int AS n FROM agri_sale_lines WHERE document_id=$1', [unchecked.id])).n, 0);
    assert.equal((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, lines: [{ skuId: urea.id, quantity: '1' }], agri: { posReceipt: '1024/0050' }, ...cash })).status, 400);
    assert.equal((await one('SELECT attributes FROM catalog_skus WHERE id=$1', [urea.id])).attributes.subsidised, 'yes');
    await request('PUT', A('modules/agri'), { enabled: true });
  });

  await t.test('a quotation\'s bill carries the PoS receipt and the crop', async () => {
    await request('PUT', A('modules/quotations'), { enabled: true });
    const q = await request('POST', A('quotations'), { requestKey: key(), locationId: shop.id, contactId: ramaiah.contact_id, validUntil: daysFrom(5),
      lines: [{ skuId: urea.id, quantity: '2' }, { skuId: chlorpyrifos.id, quantity: '1' }] }, 201);
    const missing = await refused('POST', A(`quotations/${q.id}/bill`), { requestKey: key(), ...cash });
    assert.match(missing.message, /subsidised fertiliser: give the receipt number/);
    const made = await request('POST', A(`quotations/${q.id}/bill`), { requestKey: key(), agri: { posReceipt: '1024/0061', crop: 'Cotton' }, ...cash }, 201);
    assert.equal(made.document.total, q.total);
    const kept = await rows('SELECT input_kind,pos_receipt,crop FROM agri_sale_lines WHERE document_id=$1 ORDER BY line_id', [made.document.id]);
    assert.deepEqual(kept.map((k) => [k.input_kind, k.pos_receipt, k.crop]), [['fertiliser', '1024/0061', 'Cotton'], ['pesticide', null, 'Cotton']]);
  });
});
