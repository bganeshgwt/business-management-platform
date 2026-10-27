const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The rest of licences, and of the hardware shop, end to end on a throwaway
// database with every migration applied. A farm-input shop's licences keep
// their scanned copies (opened only by those who see licences), their
// qualified person, whether they are for retail or wholesale sales, an
// insecticide licence's endorsements and principal certificates (warning or
// stopping the counter, as the shop's setting says), a fertiliser
// authorisation's certificates of source (a purchase without one warns), and
// a renewal applied for (an insecticide licence stays in force while it is
// pending; a fertiliser authorisation only when it was applied for within a
// month; a seed licence lapses). A hardware shop keeps shades (typed or
// imported), bills tinted paint whose base leaves stock when its job is
// tinted and comes back only on a manager's PIN, works out bricks, concrete,
// plaster and steel and keeps the workings, names a fitter on a bill
// afterwards (until the commission on it is paid) and on a sales order, and
// lists each item's earlier rates. Refusals with their status, idempotent
// retries, the activity log and the outbox.
test('the rest of licences, and of the hardware shop', { timeout: 900000 }, async (t) => {
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
  const { runner } = await import('node-pg-migrate');
  const dir = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes this migration away and Up brings it back', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const tables = ['platform_licence_kinds', 'business_licence_files', 'business_licence_endorsements', 'business_licence_principals', 'business_licence_sources',
      'agri_settings', 'hardware_tint_settings', 'hardware_shades', 'hardware_quotation_tints', 'hardware_tint_jobs', 'hardware_calculations', 'hardware_order_fitters'];
    const left = async () => (await scratch.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
    const calculators = async () => (await scratch.query("SELECT name FROM platform_modules WHERE code='hardware_calculators'")).rows[0].name;
    assert.equal(await left(), tables.length);
    assert.equal(await calculators(), 'Material calculators');
    const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_licences-hardware.sql')).split('_')[0]);
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.equal(await left(), 0);
    assert.equal(await calculators(), 'Tile & paint calculators');
    assert.equal((await scratch.query("SELECT count(*)::int AS n FROM platform_modules WHERE code='hardware_tinting'")).rows[0].n, 0);
    assert.equal((await scratch.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='business_licences' AND column_name='sells_to'")).rows[0].n, 0);
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await left(), tables.length);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Licences-${crypto.randomBytes(8).toString('hex')}`;
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
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('lh-owner');
  await owner('lh-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('lh-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('lh-other@test.invalid'));
  // The status and the sentence of a refusal.
  const refused = async (method, route, body, auth = ownerToken) => {
    const result = await call(method, route, body, auth);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };

  const [agri, hardware, grocery] = await createBusinesses(request, 'OWNER', ['agri_inputs', 'hardware', 'grocery']);
  const [otherAgri] = await createBusinesses(other, 'OTHER', ['agri_inputs']);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const A = (suffix) => `/businesses/${agri.id}/${suffix}`;
  const H = (suffix) => `/businesses/${hardware.id}/${suffix}`;
  const roleOf = async (business, template) => (await request('GET', `/businesses/${business.id}/roles?limit=100`)).items.find((r) => r.template_code === template);
  async function staff(business, email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', `/businesses/${business.id}/members`, { userId: user.id, roleId: (await roleOf(business, template)).id }, 201);
    return { id: user.id, call: as(await login(email)), token: await login(email) };
  }
  const audited = (business, action, entityId) => one('SELECT details FROM business_audit WHERE business_id=$1 AND action=$2 AND entity_id=$3 ORDER BY id DESC LIMIT 1',
    [business.id, action, entityId]);
  const evented = (business, kind, entityId) => one('SELECT payload FROM business_events WHERE business_id=$1 AND kind=$2 AND entity_id=$3 ORDER BY id DESC LIMIT 1',
    [business.id, kind, entityId]);
  const cash = { payment: { amount: 'full', method: 'cash' } };
  // A date in words, as the server writes it: 7 Oct 2026.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateWords = (day) => { const [y, m, d] = String(day).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
  const groceryShop = (await request('GET', `/businesses/${grocery.id}/locations`)).items[0];
  const groceryItem = await request('POST', `/businesses/${grocery.id}/catalog`, { kind: 'goods', tracking: 'quantity', name: 'Toor dal 1 kg', code: 'TOOR-1', unit: 'each',
    price: '160', openingStock: { quantity: '20', unitCost: '130', locationId: groceryShop.id } }, 201);

  // --- Licences ---------------------------------------------------------------------------------
  const agriShop = (await request('GET', A('locations'))).items[0];
  const agriSlabs = (await request('GET', A('tax-rates'))).items;
  const gst5 = agriSlabs.find((r) => Number(r.rate) === 5), gst18 = agriSlabs.find((r) => Number(r.rate) === 18), nil = agriSlabs.find((r) => Number(r.rate) === 0);
  const agriCashier = await staff(agri, 'lh-agri-cashier@test.invalid', 'cashier');
  const agriViewer = await staff(agri, 'lh-agri-viewer@test.invalid', 'viewer');
  const licence = (body) => request('POST', A('licences'), { locationId: agriShop.id, authority: 'Agriculture Officer, Rangareddy', validFrom: daysFrom(-400), ...body }, 201);
  let fertiliser, insecticide;

  await t.test('kinds of licence come with their rules, as platform data', async () => {
    const kinds = await request('GET', A('licences/kinds'));
    assert.deepEqual(kinds.slice(0, 3).map((k) => [k.code, k.own_trade, k.sells_to, k.renewal_rule]),
      [['fertiliser', true, 'retail', 'applied_within'], ['seed', true, 'both', 'lapses'], ['insecticide', true, 'both', 'while_pending']]);
    assert.match(kinds.find((k) => k.code === 'insecticide').renewal_source, /^Insecticides Rules 1971, rule 11/);
    assert.match(kinds.find((k) => k.code === 'fertiliser').renewal_source, /^Fertiliser \(Control\) Order 1985, clause 11/);
    assert.ok(kinds.filter((k) => k.code === 'trade' || k.code === 'fssai').every((k) => k.offered && !k.own_trade));
    await agriViewer.call('GET', A('licences/kinds'));
    await request('GET', `/businesses/${grocery.id}/licences/kinds`, undefined, 403);
    await other('GET', A('licences/kinds'), undefined, 404);
  });

  await t.test('a licence names its qualified person, is for retail or wholesale sales, and keeps its scanned copies', async () => {
    fertiliser = await licence({ kind: 'fertiliser', name: 'Fertiliser authorisation letter (Form A2)', licenceNo: 'FAL/RR/2026/0311', validUntil: daysFrom(700), covers: ['fertiliser'] });
    assert.equal(fertiliser.sells_to, 'retail', 'a fertiliser authorisation is for retail sales to start with');
    insecticide = await licence({ kind: 'insecticide', name: 'Insecticide sale licence (Form VIII)', licenceNo: 'INS/RR/0911', validUntil: daysFrom(500), covers: ['insecticide'] });
    assert.equal(insecticide.sells_to, 'both');
    await licence({ kind: 'seed', name: 'Seed dealer licence (Form B)', licenceNo: 'SDL/2026/77', validUntil: daysFrom(700), covers: ['seed'] });
    // The qualified person as data: a name with a qualification, or why they are exempt.
    const body = { name: fertiliser.name, licenceNo: fertiliser.licence_no, authority: fertiliser.authority, validFrom: daysFrom(-400), validUntil: daysFrom(700), covers: ['fertiliser'] };
    assert.equal((await refused('PATCH', A(`licences/${fertiliser.id}`), { ...body, qualifiedPerson: 'K. Ramesh' })).status, 400);
    assert.equal((await refused('PATCH', A(`licences/${fertiliser.id}`), { ...body, qualification: 'B.Sc. (Agriculture)' })).status, 400);
    assert.equal((await refused('PATCH', A(`licences/${fertiliser.id}`), { ...body, sellsTo: 'farmers' })).status, 400);
    const named = await request('PATCH', A(`licences/${fertiliser.id}`), { ...body, qualifiedPerson: 'K. Ramesh', qualification: 'B.Sc. (Agriculture)',
      qualificationCertificate: 'ANGRAU/2011/4471' });
    assert.deepEqual([named.qualified_person, named.qualification, named.qualification_certificate, named.sells_to], ['K. Ramesh', 'B.Sc. (Agriculture)', 'ANGRAU/2011/4471', 'retail']);
    const exempt = await request('PATCH', A(`licences/${insecticide.id}`), { name: insecticide.name, licenceNo: insecticide.licence_no, validFrom: daysFrom(-400),
      validUntil: daysFrom(500), covers: ['insecticide'], qualifiedPerson: 'P. Narsimha', qualificationExemption: 'Dealer for over 10 years before the 2017 rules' });
    assert.equal(exempt.qualification_exemption, 'Dealer for over 10 years before the 2017 rules');
    const audit = await audited(agri, 'licence.updated', fertiliser.id);
    assert.deepEqual([audit.details.from.qualifiedPerson, audit.details.to.qualifiedPerson], [null, 'K. Ramesh']);
    await assert.rejects(pool.query("UPDATE business_licences SET qualified_person=NULL WHERE id=$1", [fertiliser.id]), /business_licences_qualified_person/);

    // A scanned copy: a PDF or a photo, kept privately, opened only by those who see licences.
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2A0D5D10000000049454E44AE426082', 'hex');
    const upload = async (licenceId, bytes, token = ownerToken, name = 'licence.png') => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'image/png' }), name);
      const response = await fetch(`${base}${A(`licences/${licenceId}/files`)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      return { status: response.status, body: await response.json() };
    };
    const first = await upload(fertiliser.id, png);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.data.mime_type, first.body.data.valid_until], ['image/png', daysFrom(700)]);
    assert.equal((await upload(fertiliser.id, Buffer.from('not a scan at all, just words'))).status, 400);
    assert.equal((await upload(fertiliser.id, png, agriViewer.token)).status, 403);
    const open = (licenceId, fileId, token) => fetch(`${base}${A(`licences/${licenceId}/files/${fileId}`)}`, { headers: { Authorization: `Bearer ${token}` } });
    const seen = await open(fertiliser.id, first.body.data.id, agriViewer.token);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await seen.arrayBuffer()).equals(png), true);
    assert.equal((await open(fertiliser.id, first.body.data.id, agriCashier.token)).status, 403, 'a cashier does not see licences');
    assert.equal((await open(fertiliser.id, first.body.data.id, await login('lh-other@test.invalid'))).status, 404);
    assert.equal((await open(insecticide.id, first.body.data.id, ownerToken)).status, 404, 'a copy is opened through its own licence');
    // Renewed: the next copy keeps the new dates beside the first.
    await request('PATCH', A(`licences/${fertiliser.id}`), { ...body, validUntil: daysFrom(1800), qualifiedPerson: 'K. Ramesh', qualification: 'B.Sc. (Agriculture)',
      qualificationCertificate: 'ANGRAU/2011/4471' });
    assert.equal((await upload(fertiliser.id, png, ownerToken, 'renewal.png')).status, 201);
    const detail = await agriViewer.call('GET', A(`licences/${fertiliser.id}`));
    assert.deepEqual(detail.files.map((f) => [f.file_name, f.valid_until]), [['renewal.png', daysFrom(1800)], ['licence.png', daysFrom(700)]]);
    assert.ok(await audited(agri, 'licence.copy_added', fertiliser.id));
    await assert.rejects(pool.query('DELETE FROM business_licence_files WHERE licence_id=$1', [fertiliser.id]), /copies are kept as they were added/);
    fertiliser = detail;
  });

  // --- Farm inputs and the counter ---------------------------------------------------------------
  const opening = (quantity, unitCost, extra = {}) => ({ openingStock: { quantity, unitCost, locationId: agriShop.id, ...extra } });
  const goods = (body) => request('POST', A('catalog'), { kind: 'goods', tracking: 'quantity', taxRateId: gst5.id, ...body }, 201);
  const chlorpyrifos = await goods({ name: 'Chlorpyrifos 20% EC 500 ml', code: 'CPF-500', unit: 'bottle', tracking: 'batch', price: '420', mrp: '450', taxRateId: gst18.id,
    attributes: { inputKind: 'pesticide', molecules: ['Chlorpyrifos'], formulation: '20% EC', manufacturer: 'Dhanuka Agritech' }, ...opening('40', '330', { lotCode: 'CP-11', expiresOn: daysFrom(300) }) });
  const imidacloprid = await goods({ name: 'Confidor 17.8% SL 250 ml', brand: 'Confidor', code: 'IMI-250', unit: 'bottle', tracking: 'batch', price: '310', taxRateId: gst18.id,
    attributes: { inputKind: 'pesticide', molecules: ['Imidacloprid'], formulation: '17.8% SL', manufacturer: 'Bayer CropScience' }, ...opening('20', '240', { lotCode: 'IM-3', expiresOn: daysFrom(500) }) });
  const dap = await goods({ name: 'DAP 18:46:0 50 kg', code: 'DAP-50', unit: 'bag', price: '1350', mrp: '1350', attributes: { inputKind: 'fertiliser', netKg: '50' }, ...opening('40', '1290') });
  const paddy = await goods({ name: 'Paddy seed BPT 5204', code: 'SEED-BPT', unit: 'kg', tracking: 'batch', price: '60', taxRateId: nil.id,
    attributes: { inputKind: 'seed', seedClass: 'certified', seedCrop: 'Paddy', seedVariety: 'BPT 5204' }, ...opening('100', '45', { lotCode: 'P-2601', expiresOn: daysFrom(120) }) });
  const sprayer = await goods({ name: 'Knapsack sprayer 16 L', code: 'SPRAY-16', unit: 'each', price: '1450', attributes: { inputKind: 'other' }, ...opening('5', '1100') });
  const sale = (body, by = request, expected = 201) => by('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: agriShop.id, ...cash, ...body }, expected);
  const pesticideLine = (sku, quantity = '1', lotCode = sku.id === chlorpyrifos.id ? 'CP-11' : 'IM-3') => ({ skuId: sku.id, quantity, lotCode });
  const paddyCrop = { agri: { crop: 'Paddy' } };
  const check = (lines, extra = {}) => request('POST', A('agri/licence-check'), { locationId: agriShop.id, lines: lines.map((l) => ({ skuId: l.id })), ...extra });

  await t.test('an insecticide on no endorsement, or without its principal\'s certificate in force, warns or stops the bill', async () => {
    // Not endorsed: billed with the warning, which the activity log keeps.
    let sold = await sale({ lines: [pesticideLine(chlorpyrifos)], ...paddyCrop });
    assert.equal(sold.warnings.length, 1);
    assert.equal(sold.warnings[0], `Chlorpyrifos 20% EC 500 ml is not endorsed on ${agriShop.name}'s insecticide licence (INS/RR/0911): add the item or its brand to the licence's endorsements under Settings › Licences.`);
    assert.deepEqual((await audited(agri, 'sale.posted', sold.id)).details.warnings, sold.warnings);
    // The counter asks ahead and hears the same.
    let notes = await check([chlorpyrifos]);
    assert.deepEqual(notes.notes.map((n) => [n.level, n.message]), [['warn', sold.warnings[0]]]);
    await agriCashier.call('POST', A('agri/licence-check'), { locationId: agriShop.id, lines: [{ skuId: chlorpyrifos.id }] });
    await agriViewer.call('POST', A('agri/licence-check'), { locationId: agriShop.id, lines: [{ skuId: chlorpyrifos.id }] }, 403);
    await request('POST', `/businesses/${grocery.id}/agri/licence-check`, { locationId: agriShop.id, lines: [] }, 404);

    // Endorsed on the licence (an item, every pack of it).
    const endorsed = await request('POST', A(`licences/${insecticide.id}/endorsements`), { productId: chlorpyrifos.product_id, endorsedOn: daysFrom(-30) }, 201);
    assert.deepEqual(endorsed.endorsements.map((e) => [e.product_name, e.active]), [['Chlorpyrifos 20% EC 500 ml', true]]);
    assert.equal((await refused('POST', A(`licences/${insecticide.id}/endorsements`), { productId: chlorpyrifos.product_id })).status, 409);
    assert.equal((await refused('POST', A(`licences/${insecticide.id}/endorsements`), { productId: chlorpyrifos.product_id, brand: 'Dhanuka' })).status, 400);
    assert.equal((await refused('POST', A(`licences/${fertiliser.id}/endorsements`), { brand: 'Dhanuka' })).message,
      'Fertiliser authorisation letter (Form A2) does not cover insecticides: endorsements and principal certificates go on an insecticide licence');
    await agriViewer.call('POST', A(`licences/${insecticide.id}/endorsements`), { brand: 'Dhanuka' }, 403);
    assert.ok(await audited(agri, 'licence.endorsement_added', insecticide.id));
    sold = await sale({ lines: [pesticideLine(chlorpyrifos)], ...paddyCrop });
    assert.deepEqual(sold.warnings, [`${agriShop.name}'s insecticide licence (INS/RR/0911) holds no principal certificate from Dhanuka Agritech, who makes Chlorpyrifos 20% EC 500 ml.`]);

    // The principal's certificate: its numbers, the formulations it authorises, its validity.
    const principal = { manufacturer: 'Dhanuka Agritech', registrationNo: 'CIR-48,190/2010-Chlorpyrifos (EC)', manufacturingLicenceNo: 'ML/HR/2019/112',
      formulations: ['EC', 'GR'], validFrom: daysFrom(-100), validUntil: daysFrom(600) };
    const withPrincipal = await request('POST', A(`licences/${insecticide.id}/principals`), principal, 201);
    const certificate = withPrincipal.principals[0];
    assert.deepEqual([certificate.manufacturer, certificate.formulations, certificate.state], ['Dhanuka Agritech', ['EC', 'GR'], 'valid']);
    assert.equal((await refused('POST', A(`licences/${insecticide.id}/principals`), principal)).status, 409, 'one certificate for the same dates');
    assert.equal((await refused('POST', A(`licences/${insecticide.id}/principals`), { ...principal, formulations: [] })).status, 400);
    assert.equal((await refused('POST', A(`licences/${insecticide.id}/principals`), { ...principal, formulations: ['EC', 'ec'] })).status, 400);
    sold = await sale({ lines: [pesticideLine(chlorpyrifos)], ...paddyCrop });
    assert.equal(sold.warnings, undefined, 'endorsed and backed by its principal: no warning');

    // The principal withdraws it: from that day it no longer covers the item.
    assert.equal((await refused('PATCH', A(`licences/${insecticide.id}/principals/${certificate.id}`), { withdrawnOn: daysFrom(2) })).status, 400);
    const withdrawn = await request('PATCH', A(`licences/${insecticide.id}/principals/${certificate.id}`), { withdrawnOn: daysFrom(0), withdrawnNote: 'Letter from Dhanuka' });
    assert.equal(withdrawn.principals[0].state, 'withdrawn');
    assert.equal((await refused('PATCH', A(`licences/${insecticide.id}/principals/${certificate.id}`), { ...principal })).status, 409);
    await assert.rejects(pool.query('UPDATE business_licence_principals SET withdrawn_on=NULL WHERE id=$1', [certificate.id]), /withdrawal stands once recorded/);
    await assert.rejects(pool.query('DELETE FROM business_licence_principals WHERE id=$1', [certificate.id]), /never deleted/);
    assert.ok(await audited(agri, 'licence.principal_withdrawn', insecticide.id));
    sold = await sale({ lines: [pesticideLine(chlorpyrifos)], ...paddyCrop });
    assert.match(sold.warnings[0], /^Dhanuka Agritech's principal certificate on .+'s insecticide licence \(INS\/RR\/0911\) was withdrawn on \d+ \w+ \d{4}, so Chlorpyrifos 20% EC 500 ml is not sold under it\.$/);

    // The shop's setting: stop such a bill instead of warning.
    assert.deepEqual(await request('GET', A('agri/settings')), { endorsementCheck: 'warn' });
    await agriCashier.call('PUT', A('agri/settings'), { endorsementCheck: 'block' }, 403);
    assert.equal((await refused('PUT', A('agri/settings'), { endorsementCheck: 'sometimes' })).status, 400);
    assert.deepEqual(await request('PUT', A('agri/settings'), { endorsementCheck: 'block' }), { endorsementCheck: 'block' });
    assert.deepEqual((await audited(agri, 'agri.settings_changed', agri.id)).details, { endorsementCheck: { from: 'warn', to: 'block' } });
    const stopped = await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: agriShop.id, ...cash, lines: [pesticideLine(chlorpyrifos)], ...paddyCrop });
    assert.equal(stopped.status, 409);
    assert.match(stopped.message, /principal certificate on .+ was withdrawn on/);
    notes = await check([chlorpyrifos, dap]);
    assert.deepEqual(notes.notes.map((n) => [n.skuId, n.level]), [[chlorpyrifos.id, 'stop']]);
    // A new certificate covers it again.
    await request('POST', A(`licences/${insecticide.id}/principals`), { ...principal, registrationNo: 'CIR-48,190/2026-Chlorpyrifos (EC)', validFrom: daysFrom(0) }, 201);
    await sale({ lines: [pesticideLine(chlorpyrifos)], ...paddyCrop });

    // A brand endorsed covers every item of that brand; its maker's certificate is still needed.
    assert.match((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: agriShop.id, ...cash, lines: [pesticideLine(imidacloprid)] })).message,
      /^Confidor 17\.8% SL 250 ml is not endorsed on /);
    await request('POST', A(`licences/${insecticide.id}/endorsements`), { brand: 'confidor' }, 201);
    assert.match((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: agriShop.id, ...cash, lines: [pesticideLine(imidacloprid)] })).message,
      /holds no principal certificate from Bayer CropScience, who makes Confidor/);
    await request('POST', A(`licences/${insecticide.id}/principals`), { manufacturer: 'Bayer CropScience', registrationNo: 'CIR-12,881/97-Imidacloprid (SL)',
      manufacturingLicenceNo: 'ML/GJ/2007/31', formulations: ['SL', 'WG'], validFrom: daysFrom(-10) }, 201);
    await sale({ lines: [pesticideLine(imidacloprid)] });
    // An endorsement switched off no longer covers the item; it is never deleted.
    const current = await request('GET', A(`licences/${insecticide.id}`));
    const itemEndorsement = current.endorsements.find((e) => e.product_id === chlorpyrifos.product_id);
    await request('PATCH', A(`licences/${insecticide.id}/endorsements/${itemEndorsement.id}`), { active: false });
    assert.equal((await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: agriShop.id, ...cash, lines: [pesticideLine(chlorpyrifos)], ...paddyCrop })).status, 409);
    await assert.rejects(pool.query('DELETE FROM business_licence_endorsements WHERE id=$1', [itemEndorsement.id]), /never deleted/);
    await request('PATCH', A(`licences/${insecticide.id}/endorsements/${itemEndorsement.id}`), { active: true });
    await request('PUT', A('agri/settings'), { endorsementCheck: 'warn' });
  });

  await t.test('a purchase of fertiliser from a supplier with no certificate of source (Form O) warns', async () => {
    const iffco = await request('POST', A('contacts'), { kind: 'supplier', name: 'IFFCO depot, Shamshabad' }, 201);
    const farmer = await request('POST', A('contacts'), { kind: 'customer', name: 'Ramaiah Goud' }, 201);
    const purchase = (supplier, lines) => request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: agriShop.id, contactId: supplier.id, lines }, 201);
    const received = await purchase(iffco, [{ skuId: dap.id, quantity: '10', unitPrice: '1290' }]);
    assert.deepEqual(received.warnings, [`DAP 18:46:0 50 kg: ${agriShop.name}'s fertiliser authorisation (FAL/RR/2026/0311) has no certificate of source (Form O) from IFFCO depot, Shamshabad: add it under Settings › Licences.`]);
    assert.deepEqual((await audited(agri, 'purchase.posted', received.id)).details.warnings, received.warnings);
    // Kept on the authorisation, with the supplier it covers.
    const source = { contactId: iffco.id, certificateNo: 'FORM-O/IFFCO/2026/118', certificateDate: daysFrom(-30) };
    const kept = await request('POST', A(`licences/${fertiliser.id}/sources`), source, 201);
    assert.deepEqual(kept.sources.map((s) => [s.name, s.contact_name, s.certificate_no]), [['IFFCO depot, Shamshabad', 'IFFCO depot, Shamshabad', 'FORM-O/IFFCO/2026/118']]);
    assert.equal((await refused('POST', A(`licences/${fertiliser.id}/sources`), source)).status, 409);
    assert.equal((await refused('POST', A(`licences/${fertiliser.id}/sources`), { ...source, certificateNo: 'X-1', certificateDate: daysFrom(1) })).status, 400);
    assert.equal((await refused('POST', A(`licences/${fertiliser.id}/sources`), { ...source, certificateNo: 'X-2', contactId: farmer.id })).status, 404);
    assert.equal((await refused('POST', A(`licences/${insecticide.id}/sources`), { ...source, certificateNo: 'X-3' })).status, 400);
    await assert.rejects(pool.query('INSERT INTO business_licence_sources(business_id,licence_id,name,contact_id,certificate_no,certificate_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [agri.id, fertiliser.id, 'Ramaiah', farmer.id, 'X-4', daysFrom(0), ownerUser.id]), /Choose a supplier of this business/);
    assert.ok(await audited(agri, 'licence.source_added', fertiliser.id));
    assert.equal((await purchase(iffco, [{ skuId: dap.id, quantity: '5', unitPrice: '1290' }])).warnings, undefined);
    // A source named as on the certificate covers the supplier of that name.
    const coromandel = await request('POST', A('contacts'), { kind: 'supplier', name: 'Coromandel International' }, 201);
    assert.equal((await purchase(coromandel, [{ skuId: dap.id, quantity: '2', unitPrice: '1290' }])).warnings.length, 1);
    await request('POST', A(`licences/${fertiliser.id}/sources`), { name: 'Coromandel  International', certificateNo: 'FORM-O/CIL/2026/9', certificateDate: daysFrom(-3) }, 201);
    assert.equal((await purchase(coromandel, [{ skuId: dap.id, quantity: '2', unitPrice: '1290' }])).warnings, undefined);
    // Switched off, it no longer covers; seed from the same supplier needs none.
    const listed = (await request('GET', A(`licences/${fertiliser.id}`))).sources.find((s) => s.certificate_no === 'FORM-O/IFFCO/2026/118');
    await request('PATCH', A(`licences/${fertiliser.id}/sources/${listed.id}`), { ...source, active: false });
    assert.equal((await purchase(iffco, [{ skuId: dap.id, quantity: '1', unitPrice: '1290' }])).warnings.length, 1);
    assert.equal((await purchase(iffco, [{ skuId: paddy.id, quantity: '10', unitPrice: '45', lotCode: 'P-2602', expiresOn: daysFrom(200) }])).warnings, undefined);
    await request('PATCH', A(`licences/${fertiliser.id}/sources/${listed.id}`), { ...source, active: true });
    await assert.rejects(pool.query('DELETE FROM business_licence_sources WHERE id=$1', [listed.id]), /never deleted/);
  });

  await t.test('a sale to a dealer with a GSTIN is a wholesale sale, and needs a licence for wholesale sales', async () => {
    const dealer = await request('POST', A('contacts'), { kind: 'customer', name: 'Sri Sai Agro Agencies', gstin: '27AAPFU0939F1ZV' }, 201);
    const answer = await refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: agriShop.id, contactId: dealer.id, ...cash,
      lines: [{ skuId: dap.id, quantity: '10' }] });
    assert.equal(answer.status, 409);
    assert.equal(answer.message, `DAP 18:46:0 50 kg is a fertiliser, and ${agriShop.name}'s fertiliser licence (authorisation letter) (FAL/RR/2026/0311) is for retail sales only, `
      + 'and a sale to a dealer (a B2B invoice to a GSTIN) needs one for wholesale sales. Add or renew it under Settings › Licences, then bill it.');
    assert.deepEqual((await check([dap], { contactId: dealer.id })).notes.map((n) => n.level), ['stop']);
    assert.equal((await check([dap])).notes.length, 0, 'a farmer\'s sale is a retail sale');
    // A farmer buys at retail; the dealer once the licence is for both.
    await sale({ lines: [{ skuId: dap.id, quantity: '1' }] });
    const body = { name: fertiliser.name, licenceNo: fertiliser.licence_no, authority: fertiliser.authority, validFrom: fertiliser.valid_from, validUntil: fertiliser.valid_until,
      covers: ['fertiliser'], qualifiedPerson: 'K. Ramesh', qualification: 'B.Sc. (Agriculture)', qualificationCertificate: 'ANGRAU/2011/4471' };
    await request('PATCH', A(`licences/${fertiliser.id}`), { ...body, sellsTo: 'both' });
    const wholesale = await sale({ contactId: dealer.id, lines: [{ skuId: dap.id, quantity: '10' }] });
    const bill = await request('GET', A(`documents/${wholesale.id}`));
    assert.deepEqual(bill.agri.licences.map((l) => l.licence_no), ['FAL/RR/2026/0311']);
    // The database holds the same rule where the line is kept.
    await request('PATCH', A(`licences/${fertiliser.id}`), { ...body, sellsTo: 'retail' });
    const tool = await sale({ contactId: dealer.id, lines: [{ skuId: sprayer.id, quantity: '1' }] });
    const line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [tool.id]);
    await assert.rejects(pool.query("INSERT INTO agri_sale_lines(business_id,line_id,document_id,sku_id,input_kind) VALUES($1,$2,$3,$4,'fertiliser')", [agri.id, line.id, tool.id, dap.id]),
      /holds no fertiliser licence in force on .+ as a wholesale sale \(a B2B invoice\): the licence must be for wholesale sales/);
  });

  await t.test('a renewal applied for keeps an insecticide licence in force, a fertiliser authorisation only within a month, and no seed licence', async () => {
    const branch = await request('POST', A('locations'), { name: 'Shadnagar branch', code: 'SDN' }, 201);
    const supplier = await request('POST', A('contacts'), { kind: 'supplier', name: 'Agro depot, Shadnagar' }, 201);
    await request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: branch.id, contactId: supplier.id, lines: [
      { skuId: chlorpyrifos.id, quantity: '10', unitPrice: '330', lotCode: 'CP-21', expiresOn: daysFrom(300) }, { skuId: dap.id, quantity: '10', unitPrice: '1290' },
      { skuId: paddy.id, quantity: '20', unitPrice: '45', lotCode: 'P-2701', expiresOn: daysFrom(150) }, { skuId: sprayer.id, quantity: '2', unitPrice: '1100' }] }, 201);
    const atBranch = (lines, extra = {}) => refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: branch.id, ...cash, lines, ...extra });
    const ins = await licence({ locationId: branch.id, kind: 'insecticide', name: 'Insecticide sale licence (Form VIII)', licenceNo: 'INS/RR/0950', validUntil: daysFrom(-3), covers: ['insecticide'] });
    assert.equal(ins.state, 'expired');
    let answer = await atBranch([{ skuId: chlorpyrifos.id, quantity: '1', lotCode: 'CP-21' }], paddyCrop);
    assert.equal(answer.status, 409);
    assert.match(answer.message, /\(INS\/RR\/0950\) ran out on /);
    // The renewal applied for: its date and the application's reference.
    const renewal = (licenceId, body, expected = 200) => request('PUT', A(`licences/${licenceId}/renewal`), body, expected);
    await renewal(ins.id, { appliedOn: daysFrom(1), reference: 'TS/AGRI/INS/5531' }, 400);
    await renewal(ins.id, { appliedOn: daysFrom(-1) }, 400);
    await agriViewer.call('PUT', A(`licences/${ins.id}/renewal`), { appliedOn: daysFrom(-1), reference: 'TS/AGRI/INS/5531' }, 403);
    const pending = await renewal(ins.id, { appliedOn: daysFrom(-1), reference: 'TS/AGRI/INS/5531' });
    assert.deepEqual([pending.state, pending.renewal_applied_on, pending.renewal_reference, pending.in_force], ['renewal_pending', daysFrom(-1), 'TS/AGRI/INS/5531', true]);
    assert.equal((await audited(agri, 'licence.renewal_applied', ins.id)).details.keepsInForce, true);
    const sold = await sale({ locationId: branch.id, lines: [{ skuId: chlorpyrifos.id, quantity: '1', lotCode: 'CP-21' }], ...paddyCrop });
    assert.equal(sold.warnings[0], `Shadnagar branch's insecticide licence (INS/RR/0950) ran out on ${dateWords(daysFrom(-3))}; `
      + `it stays in force while its renewal, applied for on ${dateWords(daysFrom(-1))} (TS/AGRI/INS/5531), is pending (Insecticides Rules 1971, rule 11). `
      + 'Type the renewed date under Settings › Licences once it comes.');
    // The bell warns until the renewed date is typed.
    const bell = async () => (await request('GET', A('notifications'))).items.filter((i) => i.category === 'Licences');
    const ringing = (await bell()).find((i) => i.id.startsWith(`licence:${ins.id}:`));
    assert.deepEqual([ringing.severity, ringing.title], ['warning', 'Insecticide sale licence (Form VIII) is in force only while its renewal is pending']);
    assert.match(ringing.detail, /renewal applied for on .+ \(TS\/AGRI\/INS\/5531\)$/);
    // The renewed date ends the renewal applied for.
    const renewed = await request('PATCH', A(`licences/${ins.id}`), { name: ins.name, licenceNo: ins.licence_no, validFrom: daysFrom(-400), validUntil: daysFrom(700), covers: ['insecticide'] });
    assert.deepEqual([renewed.state, renewed.renewal_applied_on, renewed.renewal_reference], ['valid', null, null]);
    const renewedAudit = await audited(agri, 'licence.renewed', ins.id);
    assert.deepEqual([renewedAudit.details.from.renewalAppliedOn, renewedAudit.details.to.renewalAppliedOn], [daysFrom(-1), null]);
    assert.ok(!(await bell()).some((i) => i.id.startsWith(`licence:${ins.id}:`)));
    await renewal(renewed.id, { appliedOn: null });

    // A fertiliser authorisation: applied for more than a month after its date, it has lapsed.
    const fal = await licence({ locationId: branch.id, kind: 'fertiliser', name: 'Fertiliser authorisation letter (Form A2)', licenceNo: 'FAL/RR/2026/0450', validUntil: daysFrom(-40), covers: ['fertiliser'] });
    await renewal(fal.id, { appliedOn: daysFrom(-2), reference: 'TS/AGRI/FER/881' });
    answer = await atBranch([{ skuId: dap.id, quantity: '1' }]);
    assert.equal(answer.status, 409);
    assert.match(answer.message, /\(FAL\/RR\/2026\/0450\) ran out on .+, and its renewal was applied for on .+, after .+: it has lapsed \(Fertiliser \(Control\) Order 1985, clause 11\)\. /);
    // Applied for within the month of its date, it stays in force while pending.
    await request('PATCH', A(`licences/${fal.id}`), { name: fal.name, licenceNo: fal.licence_no, validFrom: daysFrom(-400), validUntil: daysFrom(-10), covers: ['fertiliser'] });
    const inTime = await renewal(fal.id, { appliedOn: daysFrom(-5), reference: 'TS/AGRI/FER/882' });
    assert.equal(inTime.state, 'renewal_pending');
    const billed = await sale({ locationId: branch.id, lines: [{ skuId: dap.id, quantity: '1' }] });
    assert.match(billed.warnings[0], /is pending \(Fertiliser \(Control\) Order 1985, clause 11\)/);
    // A seed licence lapses on its date: a renewal applied for does not keep it.
    const seed = await licence({ locationId: branch.id, kind: 'seed', name: 'Seed dealer licence (Form B)', licenceNo: 'SDL/2026/90', validUntil: daysFrom(-5), covers: ['seed'] });
    assert.equal((await renewal(seed.id, { appliedOn: daysFrom(-1), reference: 'TS/SEED/12' })).state, 'expired');
    answer = await atBranch([{ skuId: paddy.id, quantity: '2', lotCode: 'P-2701' }]);
    assert.match(answer.message, /\(SDL\/2026\/90\) ran out on .+; a renewal applied for does not keep this kind of licence in force\./);
    // The database holds the same: the seed line is refused, a pending insecticide licence still bills.
    const tool = await sale({ locationId: branch.id, lines: [{ skuId: sprayer.id, quantity: '1' }] });
    const line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [tool.id]);
    await assert.rejects(pool.query("INSERT INTO agri_sale_lines(business_id,line_id,document_id,sku_id,input_kind) VALUES($1,$2,$3,$4,'seed')", [agri.id, line.id, tool.id, paddy.id]),
      /holds no seed licence in force on/);
    // A licence with no end date needs no renewal; one switched off records none.
    const trade = await licence({ kind: 'trade', name: 'Trade licence', licenceNo: 'GHMC/TL/2291' });
    await renewal(trade.id, { appliedOn: daysFrom(-1), reference: 'GHMC/R/1' }, 400);
  });

  await t.test('licences and their records belong to the business and its locations', async () => {
    await other('GET', A(`licences/${insecticide.id}`), undefined, 404);
    await other('POST', A(`licences/${insecticide.id}/endorsements`), { brand: 'X' }, 404);
    await request('GET', `/businesses/${otherAgri.id}/licences/${insecticide.id}`, undefined, 404);
    await request('GET', `/businesses/${otherAgri.id}/licences`, undefined, 404);
    await agriCashier.call('GET', A(`licences/${insecticide.id}`), undefined, 403);
  });

  // --- Hardware ---------------------------------------------------------------------------------
  const hwShop = (await request('GET', H('locations'))).items[0];
  const hwSlabs = (await request('GET', H('tax-rates'))).items;
  const hw18 = hwSlabs.find((r) => Number(r.rate) === 18);
  const hwCashier = await staff(hardware, 'lh-hw-cashier@test.invalid', 'cashier');
  const hwViewer = await staff(hardware, 'lh-hw-viewer@test.invalid', 'viewer');
  const hwKeeper = await staff(hardware, 'lh-hw-keeper@test.invalid', 'stock_keeper');
  const hwManager = await staff(hardware, 'lh-hw-manager@test.invalid', 'manager');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [hwManager.id, await bcrypt.hash('4826', 4)]);
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [hwCashier.id, await bcrypt.hash('1357', 4)]);
  const hwGoods = (body) => request('POST', H('catalog'), { kind: 'goods', tracking: 'quantity', taxRateId: hw18.id, ...body }, 201);
  const hwOpening = (quantity, unitCost) => ({ openingStock: { quantity, unitCost, locationId: hwShop.id } });
  const stockOf = async (sku) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [hardware.id, sku.id])).q);
  const hwSale = (body, by = request, expected = 201) => by('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: hwShop.id, ...cash, ...body }, expected);

  await t.test('paint tinting is a hardware shop\'s tool, off until switched on, with its permissions', async () => {
    assert.ok(!hardware.capabilities.includes('hardware_tinting'));
    const tools = await request('GET', H('modules'));
    const tinting = tools.find((m) => m.code === 'hardware_tinting');
    assert.deepEqual([tinting.enabled, tinting.recommended, [...tinting.requires].sort()], [false, true, ['catalog', 'inventory', 'sales']]);
    assert.match(tinting.recommended_note, /tinting machine/);
    assert.equal(tools.find((m) => m.code === 'hardware_calculators').name, 'Material calculators');
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'hardware_tinting'));
    await request('PUT', `/businesses/${grocery.id}/modules/hardware_tinting`, { enabled: true }, 409);
    await request('GET', H('hardware/shades'), undefined, 403);
    await request('PUT', H('modules/hardware_tinting'), { enabled: true });
    const grants = async (template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2 AND rp.permission_code LIKE 'hardware_tinting.%'`,
    [hardware.id, template])).p;
    assert.deepEqual(await grants('manager'), ['hardware_tinting.create', 'hardware_tinting.edit', 'hardware_tinting.view']);
    assert.deepEqual(await grants('cashier'), ['hardware_tinting.create', 'hardware_tinting.view']);
    assert.deepEqual(await grants('stock_keeper'), ['hardware_tinting.create', 'hardware_tinting.view']);
    assert.deepEqual(await grants('accountant'), ['hardware_tinting.view']);
    assert.deepEqual(await grants('viewer'), ['hardware_tinting.view']);
  });

  let sunset, mist, ocean;
  await t.test('shades are typed or imported, each maker\'s code once', async () => {
    sunset = await request('POST', H('hardware/shades'), { maker: 'Asian Paints', code: '7974', name: 'Sunset Glow', card: 'Colour Spectra', base: 'Pastel', formula: 'XR 1.25; YE 0.4' }, 201);
    assert.deepEqual(sunset.formula, [{ colourant: 'XR', ml: '1.25' }, { colourant: 'YE', ml: '0.4' }]);
    assert.equal((await refused('POST', H('hardware/shades'), { maker: 'asian paints', code: '7974', name: 'Copy', base: 'Pastel' })).status, 409);
    assert.equal((await refused('POST', H('hardware/shades'), { maker: 'Asian Paints', code: '1', name: 'Bad', base: 'Pastel', formula: 'XR lots' })).status, 400);
    assert.equal((await refused('POST', H('hardware/shades'), { maker: 'Asian Paints', code: '2', name: 'Bad', base: 'Pastel', formula: 'XR 1; XR 2' })).status, 400);
    await hwCashier.call('POST', H('hardware/shades'), { maker: 'Asian Paints', code: '3', name: 'Cashier', base: 'Pastel' }, 403);
    assert.equal((await hwViewer.call('GET', H('hardware/shades'))).total, 1);
    assert.ok(await audited(hardware, 'shade.created', sunset.id));
    await assert.rejects(pool.query('DELETE FROM hardware_shades WHERE id=$1', [sunset.id]), /never deleted; switch it off/);

    // From a spreadsheet: a check first, all or nothing, the same file twice changes nothing.
    const guide = await request('GET', H('hardware/shades/import-guide'));
    assert.deepEqual(guide.columns.map((c) => c.key), ['maker', 'code', 'name', 'card', 'base', 'formula', 'active']);
    const importing = (body, auth = ownerToken) => call('POST', H('hardware/shades/import'), body, auth);
    const bad = [{ Maker: 'Asian Paints', 'Shade code': '8125', 'Shade name': 'Morning Mist' }];
    let answer = await importing({ rows: bad, dryRun: true });
    assert.deepEqual([answer.status, answer.body.success, answer.body.data.ok, answer.body.data.problems.map((p) => [p.line, p.column])], [200, true, false, [[2, 'base']]]);
    assert.equal((await importing({ rows: bad, dryRun: false })).status, 400);
    // Headings are matched ignoring case and punctuation; one nobody knows is listed as ignored.
    const file = [
      { Maker: 'Asian Paints', shade_code: '7974', 'SHADE NAME': 'Sunset Glow', Card: '', Base: 'Pastel', Formula: 'XR 1.5; YE 0.4', Remarks: '' },
      { Maker: 'Asian Paints', shade_code: '8125', 'SHADE NAME': 'Morning Mist', Card: 'Colour Spectra', Base: 'Pastel', Formula: '', Remarks: '' },
      { Maker: 'Berger', shade_code: '2A0154', 'SHADE NAME': 'Ocean Deep', Card: '', Base: 'Deep', Formula: 'BK 2.5', Remarks: 'kept aside' },
    ];
    answer = await importing({ rows: file, dryRun: true, fileName: 'shades.csv' });
    assert.equal(answer.status, 200);
    const plan = answer.body.data;
    assert.deepEqual([plan.created, plan.updated, plan.unchanged, plan.columns.ignored], [2, 1, 0, ['Remarks']]);
    assert.deepEqual(plan.rows.find((r) => r.line === 2).changes.map((c) => [c.field, c.from, c.to]), [['formula', 'XR 1.25; YE 0.4', 'XR 1.5; YE 0.4']]);
    answer = await importing({ rows: file, dryRun: false, fingerprint: 'not-the-preview' });
    assert.deepEqual([answer.status, answer.body.data?.reason], [409, 'stale_preview']);
    await hwCashier.call('POST', H('hardware/shades/import'), { rows: file, dryRun: true }, 403);
    answer = await importing({ rows: file, dryRun: false, fileName: 'shades.csv', fingerprint: plan.fingerprint });
    assert.deepEqual([answer.status, answer.body.message], [200, 'Imported: 2 shades added, 1 updated']);
    assert.deepEqual((await audited(hardware, 'shade.imported', hardware.id)).details, { file: 'shades.csv', created: 2, updated: 1, unchanged: 0 });
    const again = await importing({ rows: file, dryRun: true });
    assert.deepEqual([again.body.data.created, again.body.data.updated, again.body.data.unchanged], [0, 0, 3]);
    const shades = (await request('GET', H('hardware/shades?limit=10'))).items;
    mist = shades.find((s) => s.code === '8125');
    ocean = shades.find((s) => s.code === '2A0154');
    assert.deepEqual([ocean.maker, ocean.base, ocean.formula], ['Berger', 'Deep', [{ colourant: 'BK', ml: '2.5' }]]);
    assert.deepEqual(shades.find((s) => s.id === sunset.id).formula, [{ colourant: 'XR', ml: '1.5' }, { colourant: 'YE', ml: '0.4' }]);
    await request('GET', `/businesses/${grocery.id}/hardware/shades`, undefined, 403);
    await other('GET', H('hardware/shades'), undefined, 404);
  });

  let pastel, deep, charge, tintedSale, job;
  await t.test('a tinted line is billed with its charge, and its base leaves stock when the job is tinted', async () => {
    pastel = await hwGoods({ name: 'Apex Ultima Base 4 L', brand: 'Asian Paints', code: 'APX-P4', unit: 'each', price: '1725', mrp: '1890', hsnCode: '3209',
      attributes: { paintBase: 'Pastel', litresPerUnit: '4' }, ...hwOpening('10', '1400') });
    assert.equal(pastel.attributes.paintBase, 'Pastel');
    deep = await hwGoods({ name: 'Apex Ultima Deep Base 4 L', code: 'APX-D4', unit: 'each', price: '1795', hsnCode: '3209', attributes: { paintBase: 'Deep' }, ...hwOpening('3', '1450') });
    charge = await request('POST', H('catalog'), { kind: 'service', name: 'Tinting charge', code: 'TINT', unit: 'service', tracking: 'none', price: '30', taxRateId: hw18.id, hsnCode: '9988' }, 201);
    // The tinting charge: a service item, billed at its own slab.
    assert.equal((await refused('PUT', H('hardware/tinting/settings'), { chargeSkuId: pastel.id })).status, 400);
    await hwCashier.call('PUT', H('hardware/tinting/settings'), { chargeSkuId: charge.id }, 403);
    const set = await request('PUT', H('hardware/tinting/settings'), { chargeSkuId: charge.id });
    assert.deepEqual([set.chargeSkuId, set.charge.label], [charge.id, 'Tinting charge']);

    const body = { kind: 'sale', requestKey: key(), locationId: hwShop.id, ...cash,
      lines: [{ skuId: pastel.id, quantity: '2', tint: { shadeId: sunset.id } }, { skuId: charge.id, quantity: '2' }] };
    tintedSale = await hwCashier.call('POST', H('documents'), body, 201);
    assert.equal(tintedSale.total, '3510.00', '2 tins at 1,725 and 2 charges at 30, GST included');
    assert.equal(await stockOf(pastel), 10, 'the base stays in stock until it is tinted');
    const jobs = await rows('SELECT * FROM hardware_tint_jobs WHERE document_id=$1', [tintedSale.id]);
    assert.equal(jobs.length, 1);
    job = jobs[0];
    assert.deepEqual([job.status, Number(job.quantity), job.shade_id], ['queued', 2, sunset.id]);
    assert.equal((await one('SELECT stock_unit_cost FROM business_document_lines WHERE id=$1', [job.line_id])).stock_unit_cost, null);
    assert.equal((await audited(hardware, 'tinting.queued', tintedSale.id)).details.jobs[0].shade, 'Asian Paints 7974 Sunset Glow');
    assert.ok(await evented(hardware, 'tinting.queued', tintedSale.id));
    // The same request again is the same bill and the same job.
    assert.equal((await hwCashier.call('POST', H('documents'), body, 201)).id, tintedSale.id);
    assert.equal((await one('SELECT count(*)::int AS n FROM hardware_tint_jobs WHERE document_id=$1', [tintedSale.id])).n, 1);
    const detail = await request('GET', H(`documents/${tintedSale.id}`));
    assert.deepEqual(detail.hardware.tints.map((x) => [x.line_id, x.code, x.name, x.status]), [[job.line_id, '7974', 'Sunset Glow', 'queued']]);

    // A shade needs its base; one switched off is not tinted; the base must be free to tint.
    const tint = (skuId, shadeId, quantity = '1') => refused('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: hwShop.id, ...cash,
      lines: [{ skuId, quantity, tint: { shadeId } }] });
    let answer = await tint(pastel.id, ocean.id);
    assert.deepEqual([answer.status, answer.message], [409, 'Berger shade 2A0154 Ocean Deep needs the Deep base, and Apex Ultima Base 4 L is the Pastel base']);
    answer = await tint(pastel.id, sunset.id, '9');
    assert.deepEqual([answer.status, answer.message], [409, 'Apex Ultima Base 4 L: only 8 free to tint here, with 2 waiting on the tinting board']);
    assert.equal((await tint(charge.id, sunset.id)).status, 400);
    await request('PATCH', H(`hardware/shades/${mist.id}`), { maker: mist.maker, code: mist.code, name: mist.name, base: mist.base, active: false });
    assert.match((await tint(pastel.id, mist.id)).message, /^Shade 8125 Morning Mist is switched off/);
    await hwViewer.call('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: hwShop.id, ...cash, lines: [{ skuId: pastel.id, quantity: '1', tint: { shadeId: sunset.id } }] }, 403);
    const elsewhere = await refused('POST', `/businesses/${grocery.id}/documents`, { kind: 'sale', requestKey: key(), locationId: groceryShop.id, ...cash,
      lines: [{ skuId: groceryItem.id, quantity: '1', tint: { shadeId: sunset.id } }] });
    assert.deepEqual([elsewhere.status, elsewhere.message], [400, 'Tinted paint belongs to a hardware shop\'s bills and quotations']);
    const bought = await refused('POST', H('documents'), { kind: 'purchase', requestKey: key(), locationId: hwShop.id,
      lines: [{ skuId: pastel.id, quantity: '1', unitPrice: '1400', tint: { shadeId: sunset.id } }] });
    assert.deepEqual([bought.status, bought.message], [400, 'Tinted paint is made to order on a sale: a purchase line is not tinted']);

    // The board: queued, then tinted (the base leaves stock), then handed over.
    const board = await hwKeeper.call('GET', H('hardware/tinting?status=queued'));
    assert.deepEqual(board.items.map((x) => [x.id, x.shade_code, x.customer, x.document_no]), [[job.id, '7974', 'Walk-in', tintedSale.document_no]]);
    assert.equal((await refused('POST', H(`hardware/tinting/${job.id}/handed-over`), {})).status, 409);
    await hwViewer.call('POST', H(`hardware/tinting/${job.id}/tinted`), {}, 403);
    const tinted = await hwKeeper.call('POST', H(`hardware/tinting/${job.id}/tinted`), {});
    assert.deepEqual([tinted.status, tinted.tinted_by_name], ['tinted', 'lh-hw-keeper']);
    assert.equal(await stockOf(pastel), 8);
    const moved = await one('SELECT quantity FROM business_stock_movements WHERE business_id=$1 AND document_id=$2', [hardware.id, tintedSale.id]);
    assert.equal(Number(moved.quantity), -2);
    assert.equal((await one('SELECT stock_unit_cost FROM business_document_lines WHERE id=$1', [job.line_id])).stock_unit_cost, '1400.0000');
    assert.equal((await audited(hardware, 'tinting.tinted', job.id)).details.quantity, 2);
    assert.equal((await evented(hardware, 'tinting.tinted', job.id)).payload.quantity, '2.000');
    assert.equal((await hwKeeper.call('POST', H(`hardware/tinting/${job.id}/tinted`), {})).status, 'tinted', 'asking again is the same');
    assert.equal(await stockOf(pastel), 8);
    const handed = await hwCashier.call('POST', H(`hardware/tinting/${job.id}/handed-over`), {});
    assert.equal(handed.status, 'handed_over');
    assert.ok(await audited(hardware, 'tinting.handed_over', job.id));
    await assert.rejects(pool.query("UPDATE hardware_tint_jobs SET status='queued' WHERE id=$1", [job.id]), /one step at a time/);
    await assert.rejects(pool.query('DELETE FROM hardware_tint_jobs WHERE id=$1', [job.id]), /never deleted/);
  });

  await t.test('a tinted line is refused on a return; a manager\'s PIN takes it back, never into stock', async () => {
    const returned = await refused('POST', H(`documents/${tintedSale.id}/returns`), { requestKey: key(), reason: 'Customer changed mind',
      lines: [{ lineId: job.line_id, quantity: '1', restock: false }] });
    assert.equal(returned.status, 409);
    assert.equal(returned.message, `This line of ${tintedSale.document_no} is paint tinted to shade 7974 (Sunset Glow): a tinted tin is not taken back. A manager may take it back with their PIN on the tinting board.`);
    // Its charge line comes back as any service line would.
    const chargeLine = await one('SELECT id FROM business_document_lines WHERE document_id=$1 AND sku_id=$2', [tintedSale.id, charge.id]);
    await request('POST', H(`documents/${tintedSale.id}/returns`), { requestKey: key(), reason: 'Charge waived', lines: [{ lineId: chargeLine.id, quantity: '2' }] }, 201);

    const approvers = await hwCashier.call('GET', H('hardware/tinting/approvers'));
    assert.ok(approvers.some((p) => Number(p.id) === hwManager.id && p.has_pin));
    const takeBack = (body, by = hwCashier.call, expected = 201) => by('POST', H(`hardware/tinting/${job.id}/take-back`), body, expected);
    const requestKey = key();
    await takeBack({ requestKey, reason: 'Wrong shade picked' }, hwCashier.call, 400);
    await takeBack({ requestKey, reason: 'Wrong shade picked', approval: { pin: '1357' } }, hwCashier.call, 403);
    const wrong = await refused('POST', H(`hardware/tinting/${job.id}/take-back`), { requestKey, reason: 'Wrong shade picked', approval: { approverId: hwManager.id, pin: '0000' } }, hwCashier.token);
    assert.equal(wrong.status, 400);
    const back = await takeBack({ requestKey, reason: 'Wrong shade picked', approval: { approverId: hwManager.id, pin: '4826' } });
    assert.deepEqual([back.status, back.approved_by_name, back.take_back_reason], ['taken_back', 'lh-hw-manager', 'Wrong shade picked']);
    assert.equal(back.return.total, '3450.00');
    assert.equal(await stockOf(pastel), 8, 'a tinted tin is no longer base paint');
    const credit = await one('SELECT r.request_key,l.restock FROM business_returns r JOIN business_return_lines l ON l.return_id=r.id WHERE r.id=$1', [back.return.id]);
    assert.deepEqual([credit.request_key, credit.restock], [requestKey, false]);
    const audit = await audited(hardware, 'tinting.taken_back', job.id);
    assert.deepEqual([audit.details.approvedBy, audit.details.wasTinted, audit.details.returnNo], ['lh-hw-manager', true, back.return.return_no]);
    assert.ok(await evented(hardware, 'tinting.taken_back', job.id));
    // The same request again is the same; another is refused.
    assert.equal((await takeBack({ requestKey, reason: 'Wrong shade picked', approval: { approverId: hwManager.id, pin: '4826' } })).status, 'taken_back');
    await takeBack({ requestKey: key(), reason: 'Again', approval: { approverId: hwManager.id, pin: '4826' } }, hwCashier.call, 409);

    // Taken back before it was tinted: its base never left stock.
    const queued = await hwSale({ lines: [{ skuId: pastel.id, quantity: '1', tint: { shadeId: sunset.id } }] });
    const queuedJob = await one('SELECT * FROM hardware_tint_jobs WHERE document_id=$1', [queued.id]);
    await hwCashier.call('POST', H(`hardware/tinting/${queuedJob.id}/take-back`), { requestKey: key(), reason: 'Cancelled before tinting',
      approval: { approverId: hwManager.id, pin: '4826' } }, 201);
    assert.equal(await stockOf(pastel), 8);
    assert.equal((await refused('POST', H(`hardware/tinting/${queuedJob.id}/tinted`), {})).message, 'This tinted line was taken back: there is nothing to tint');
  });

  await t.test('a quotation\'s tinted line is billed tinted; tinted paint is not made into a sales order', async () => {
    const [tooled] = await withTools(request, [hardware]);
    assert.ok(tooled.capabilities.includes('sales_orders'));
    const contractor = await request('POST', H('contacts'), { kind: 'customer', name: 'Sharma Constructions', phone: '9845012345' }, 201);
    const lines = [{ skuId: pastel.id, quantity: '1', tint: { shadeId: sunset.id } }, { skuId: charge.id, quantity: '1' }];
    const quoted = await request('POST', H('quotations'), { requestKey: key(), locationId: hwShop.id, contactId: contractor.id, validUntil: daysFrom(7), lines }, 201);
    assert.deepEqual(quoted.tints.map((x) => [x.line_id, x.code]), [[quoted.lines[0].id, '7974']]);
    const revised = await request('PUT', H(`quotations/${quoted.id}`), { requestKey: key(), contactId: contractor.id, validUntil: daysFrom(7),
      lines: [{ skuId: pastel.id, quantity: '2', tint: { shadeId: sunset.id } }, { skuId: charge.id, quantity: '2' }] });
    assert.deepEqual(revised.tints.map((x) => [x.line_id, x.code]), [[revised.lines[0].id, '7974']]);
    assert.equal((await one('SELECT count(*)::int AS n FROM hardware_quotation_tints WHERE quotation_id=$1', [quoted.id])).n, 1);
    const ordered = await refused('POST', H(`quotations/${quoted.id}/order`), { requestKey: key() });
    assert.equal(ordered.status, 409);
    assert.match(ordered.message, /^Paint tinted to Asian Paints shade 7974 is made to order and billed/);
    const billed = await request('POST', H(`quotations/${quoted.id}/bill`), { requestKey: key(), ...cash }, 201);
    const billedJob = await one('SELECT status,quantity,shade_id FROM hardware_tint_jobs WHERE document_id=$1', [billed.document.id]);
    assert.deepEqual([billedJob.status, Number(billedJob.quantity), billedJob.shade_id], ['queued', 2, sunset.id]);
    assert.equal(await stockOf(pastel), 8);
  });

  let cement, sand, steel8, steel12, aggregate;
  await t.test('the calculators work out bricks, concrete, plaster and steel on fixed inputs, in the units the items are sold in', async () => {
    const calc = (body, by = request, expected = 200) => by('POST', H('hardware/calculate'), body, expected);
    assert.deepEqual((await calc({ kind: 'tiles', inputs: { area: '200' }, assumptions: { coverage: '16' } })).result, { sqft: 200, needed: 220, units: 14, covers: 224 });
    assert.deepEqual((await calc({ kind: 'paint', inputs: { area: '600', coats: '2' }, assumptions: { coverage: '55' } })).result.plan,
      { litres: 22, packs: [{ size: 20, count: 1 }, { size: 1, count: 2 }] });
    const wall = await calc({ kind: 'brickwork', inputs: { length: '10', height: '10', thickness: '230' } }, hwCashier.call);
    assert.deepEqual([wall.result.bricks, wall.result.cementBags, wall.result.sandCft], [1122, 3, 21]);
    assert.deepEqual(wall.assumptions, { brickLength: 190, brickWidth: 90, brickHeight: 90, joint: 10, mix: '1:6', dryFactor: 1.33, wastage: 5, bagKg: 50, cementDensity: 1440 });
    const plaster = await calc({ kind: 'plaster', inputs: { area: '100', thickness: '12' } });
    assert.deepEqual([plaster.result.cementBags, plaster.result.sandCft], [1, 5]);
    // The items it goes on, each in its own unit: bags, cubic feet, kilograms, quintals.
    await request('POST', H('units'), { code: 'cft', name: 'Cubic foot', kind: 'volume', decimals: 0, baseUnitCode: 'litre', factorToBase: '28.316847' }, 201);
    cement = await hwGoods({ name: 'UltraTech OPC 53 grade cement 50 kg', code: 'CEM-OPC53', unit: 'bag', price: '395', mrp: '450', hsnCode: '2523', ...hwOpening('400', '340') });
    sand = await hwGoods({ name: 'River sand', code: 'SAND', unit: 'cft', price: '75', hsnCode: '2505', ...hwOpening('500', '50') });
    aggregate = await hwGoods({ name: 'Aggregate 20 mm (by the tonne)', code: 'AGG-20', unit: 'tonne', price: '1500', hsnCode: '2517', ...hwOpening('20', '1100') });
    steel12 = await hwGoods({ name: 'TMT bar 12 mm', code: 'TMT-12', unit: 'kg', price: '72', hsnCode: '7214', ...hwOpening('2000', '60') });
    steel8 = await hwGoods({ name: 'TMT bar 8 mm', code: 'TMT-8', unit: 'quintal', price: '7400', hsnCode: '7214', ...hwOpening('10', '6000') });
    const slab = await calc({ kind: 'concrete', inputs: { area: '100', thickness: '4' }, items: { cement: cement.id, sand: sand.id, aggregate: aggregate.id } });
    assert.deepEqual([slab.result.cementBags, slab.result.sandCft, slab.result.aggregateCft], [8, 15, 29]);
    assert.deepEqual(slab.lines.map((l) => [l.material, l.skuId, l.quantity, l.unit]), [['cement', cement.id, '8', 'bag'], ['sand', sand.id, '15', 'cft']]);
    assert.deepEqual(slab.unfit.map((u) => [u.material, u.label]), [['aggregate', 'Aggregate 20 mm (by the tonne)']]);
    const cube = await calc({ kind: 'concrete', inputs: { by: 'volume', volume: '1', volumeUnit: 'm3' } });
    assert.deepEqual([cube.result.cementBags, cube.result.sandCft, cube.result.aggregateCft], [9, 16, 31]);
    const bars = await calc({ kind: 'steel', inputs: { bars: [{ diameter: 12, length: '12', count: '10' }, { diameter: 8, length: '6', count: '20' }] },
      items: { steel_12: steel12.id, steel_8: steel8.id } });
    assert.deepEqual(bars.result.rows.map((r) => [r.diameter, r.kgPerMetre, r.kg, r.bars]), [[8, 0.395, 49, 11], [12, 0.889, 110, 11]]);
    assert.deepEqual(bars.lines.map((l) => [l.material, l.quantity]), [['steel_8', '0.49'], ['steel_12', '110']]);
    // Every assumption may be changed: a brick, its joint, the mix and the dry-volume factor, the wastage, steel's weight.
    const changed = await calc({ kind: 'brickwork', inputs: { length: '3', height: '3', lengthUnit: 'm', thickness: '115', openings: '1.5' },
      assumptions: { brickLength: '230', brickWidth: '110', brickHeight: '75', mix: '1:4' } });
    assert.deepEqual([changed.result.bricks, changed.result.cementBags, changed.result.sandCft], [370, 2, 8]);
    assert.equal((await refused('POST', H('hardware/calculate'), { kind: 'brickwork', inputs: { length: '10', height: '10', thickness: '230' }, assumptions: { mix: '1:2:4' } })).message,
      'The mortar mix is cement : sand, like 1:6');
    assert.equal((await refused('POST', H('hardware/calculate'), { kind: 'roofing', inputs: {} })).status, 400);
    await request('POST', `/businesses/${grocery.id}/hardware/calculate`, { kind: 'tiles', inputs: { area: '1' }, assumptions: { coverage: '1' } }, 404);
  });

  await t.test('a quotation and a bill keep the calculators\' workings, worked out again by the server', async () => {
    const working = { kind: 'concrete', inputs: { area: '100', thickness: '4' }, assumptions: { wastage: '5' }, added: [{ skuId: cement.id, quantity: '8' }] };
    const quoted = await request('POST', H('quotations'), { requestKey: key(), locationId: hwShop.id, customerName: 'Meena Iyer', validUntil: daysFrom(7),
      lines: [{ skuId: cement.id, quantity: '8' }], calculations: [working] }, 201);
    assert.equal(quoted.calculations.length, 1);
    const kept = quoted.calculations[0];
    assert.deepEqual([kept.kind, kept.revision, kept.working.assumptions.wastage, kept.working.result.cementBags, kept.working.added], ['concrete', 1, 5, 8, [{ skuId: cement.id, quantity: '8' }]]);
    assert.ok(kept.working.materials.some((m) => m.material === 'aggregate'));
    await assert.rejects(pool.query("UPDATE hardware_calculations SET kind='steel' WHERE id=$1", [kept.id]), /kept as it was saved/);
    const revised = await request('PUT', H(`quotations/${quoted.id}`), { requestKey: key(), customerName: 'Meena Iyer', validUntil: daysFrom(7),
      lines: [{ skuId: cement.id, quantity: '9' }], calculations: [{ kind: 'plaster', inputs: { area: '100', thickness: '12' } }] });
    assert.deepEqual(revised.calculations.map((c) => [c.kind, c.revision]), [['concrete', 1], ['plaster', 2]]);
    assert.equal((await refused('POST', H('quotations'), { requestKey: key(), locationId: hwShop.id, customerName: 'X', validUntil: daysFrom(7),
      lines: [{ skuId: cement.id, quantity: '1' }], calculations: [{ kind: 'concrete', inputs: { area: '0', thickness: '4' } }] })).status, 400);
    const billed = await hwSale({ lines: [{ skuId: cement.id, quantity: '3' }], calculations: [{ kind: 'brickwork', inputs: { length: '10', height: '10', thickness: '230' } }] });
    const bill = await request('GET', H(`documents/${billed.id}`));
    assert.deepEqual(bill.hardware.calculations.map((c) => [c.kind, c.working.result.bricks]), [['brickwork', 1122]]);
    const elsewhere = await refused('POST', `/businesses/${grocery.id}/documents`, { kind: 'sale', requestKey: key(), locationId: groceryShop.id, ...cash,
      lines: [{ skuId: groceryItem.id, quantity: '1' }], calculations: [] });
    assert.deepEqual([elsewhere.status, elsewhere.message], [400, 'Sites, fitters and calculator workings belong to a hardware shop\'s sales']);
  });

  await t.test('a fitter is named on a bill afterwards, and changed until the commission on it is paid', async () => {
    await request('PUT', H('modules/fitter_commission'), { enabled: true });
    const ramesh = await request('POST', H('hardware/fitters'), { name: 'Ramesh Kumar', trade: 'painter', phone: '9845098450' }, 201);
    const suresh = await request('POST', H('hardware/fitters'), { name: 'Suresh Babu', trade: 'mason', phone: '9845098451' }, 201);
    await request('POST', H('hardware/fitter-rules'), { skuId: cement.id, perUnit: '2' }, 201);
    const fitterOf = (doc) => request('PUT', H(`hardware/bills/${doc.id}/fitter`), { fitterId: ramesh.id });
    const billA = await hwSale({ lines: [{ skuId: cement.id, quantity: '10' }] });
    await hwCashier.call('PUT', H(`hardware/bills/${billA.id}/fitter`), { fitterId: ramesh.id }, 403);
    let named = await fitterOf(billA);
    assert.deepEqual([named.name, named.commission, Number(named.taken_back)], ['Ramesh Kumar', '20.00', 0]);
    assert.deepEqual((await audited(hardware, 'fitter_commission.named_later', billA.id)).details, { documentNo: billA.document_no, fitter: 'Ramesh Kumar' });
    assert.ok(await evented(hardware, 'fitter_commission.earned', billA.id));
    assert.deepEqual(await fitterOf(billA), named, 'naming the same fitter again changes nothing');
    // Goods back before the fitter is named take back their share, as a return after would.
    const billB = await hwSale({ lines: [{ skuId: cement.id, quantity: '10' }] });
    const lineB = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [billB.id]);
    await request('POST', H(`documents/${billB.id}/returns`), { requestKey: key(), reason: 'Four bags unused', lines: [{ lineId: lineB.id, quantity: '4' }] }, 201);
    named = await fitterOf(billB);
    assert.deepEqual([named.commission, named.taken_back], ['20.00', '8.00']);
    // Changed while unpaid; refused once the commission on it is paid.
    const moved = await request('PUT', H(`hardware/bills/${billA.id}/fitter`), { fitterId: suresh.id });
    assert.equal(moved.name, 'Suresh Babu');
    assert.deepEqual((await audited(hardware, 'fitter_commission.fitter_changed', billA.id)).details, { documentNo: billA.document_no, from: 'Ramesh Kumar', to: 'Suresh Babu', commission: '20.00' });
    assert.ok(await evented(hardware, 'fitter_commission.moved', billA.id));
    const billC = await hwSale({ lines: [{ skuId: cement.id, quantity: '5' }], fitterId: suresh.id });
    await request('POST', H(`hardware/fitters/${suresh.id}/payouts`), { requestKey: key(), locationId: hwShop.id, amount: '20', method: 'cash' }, 201);
    const paid = await refused('PUT', H(`hardware/bills/${billA.id}/fitter`), { fitterId: ramesh.id });
    assert.deepEqual([paid.status, paid.message], [409, `The commission on ${billA.document_no} is paid to Suresh Babu: its fitter no longer changes`]);
    // Payouts settle the oldest commission first: the later bill is still unpaid.
    assert.equal((await request('PUT', H(`hardware/bills/${billC.id}/fitter`), { fitterId: ramesh.id })).name, 'Ramesh Kumar');
    await assert.rejects(pool.query('UPDATE hardware_fitter_bills SET commission=0,changed_by=$2,changed_at=now() WHERE document_id=$1', [billA.id, ownerUser.id]), /kept as they were made/);
    await assert.rejects(pool.query('DELETE FROM hardware_fitter_bills WHERE document_id=$1', [billA.id]), /never deleted/);
    await request('PATCH', H(`hardware/fitters/${ramesh.id}`), { name: 'Ramesh Kumar', trade: 'painter', phone: '9845098450', active: false });
    const billD = await hwSale({ lines: [{ skuId: cement.id, quantity: '1' }] });
    assert.equal((await refused('PUT', H(`hardware/bills/${billD.id}/fitter`), { fitterId: ramesh.id })).status, 409);
    await request('PATCH', H(`hardware/fitters/${ramesh.id}`), { name: 'Ramesh Kumar', trade: 'painter', phone: '9845098450', active: true });
    const supplier = await request('POST', H('contacts'), { kind: 'supplier', name: 'Ambuja Cement Depot' }, 201);
    const receipt = await request('POST', H('documents'), { kind: 'purchase', requestKey: key(), locationId: hwShop.id, contactId: supplier.id,
      lines: [{ skuId: cement.id, quantity: '10', unitPrice: '340' }] }, 201);
    assert.equal((await refused('PUT', H(`hardware/bills/${receipt.id}/fitter`), { fitterId: ramesh.id })).message, 'A fitter is named on a sale');
  });

  await t.test('a sales order names a fitter, and the invoices its dispatches raise carry it', async () => {
    const fitters = (await request('GET', H('hardware/fitters?limit=10'))).items;
    const ramesh = fitters.find((f) => f.name === 'Ramesh Kumar'), suresh = fitters.find((f) => f.name === 'Suresh Babu');
    const contractor = (await request('GET', H('contacts?kind=customer&limit=10'))).items.find((c) => c.name === 'Sharma Constructions');
    const placed = await request('POST', H('sales-orders'), { requestKey: key(), locationId: hwShop.id, contactId: contractor.id, lines: [{ skuId: cement.id, quantity: '6' }] }, 201);
    const order = await request('GET', H(`sales-orders/${placed.id}`));
    assert.deepEqual(await request('GET', H(`hardware/orders/${order.id}/fitter`)), { fitter: null });
    const set = await hwCashier.call('PUT', H(`hardware/orders/${order.id}/fitter`), { fitterId: ramesh.id });
    assert.equal(set.fitter.name, 'Ramesh Kumar');
    assert.ok(await audited(hardware, 'sales_order.fitter_set', order.id));
    const first = await request('POST', H(`sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: order.lines[0].id, quantity: '3' }] }, 201);
    let invoice = await request('GET', H(`documents/${first.document.id}`));
    assert.deepEqual([invoice.hardware.fitter.name, invoice.hardware.fitter.commission], ['Ramesh Kumar', '6.00']);
    await request('PUT', H(`hardware/orders/${order.id}/fitter`), { fitterId: suresh.id });
    const second = await request('POST', H(`sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: order.lines[0].id, quantity: '3' }] }, 201);
    invoice = await request('GET', H(`documents/${second.document.id}`));
    assert.deepEqual([invoice.hardware.fitter.name, invoice.hardware.fitter.commission], ['Suresh Babu', '6.00']);
    assert.equal((await refused('PUT', H(`hardware/orders/${order.id}/fitter`), { fitterId: ramesh.id })).status, 409, 'a dispatched order no longer changes');
    // Named after a dispatch: the invoice already raised takes the fitter too.
    const later = await request('POST', H('sales-orders'), { requestKey: key(), locationId: hwShop.id, contactId: contractor.id, lines: [{ skuId: cement.id, quantity: '4' }] }, 201);
    const laterOrder = await request('GET', H(`sales-orders/${later.id}`));
    const early = await request('POST', H(`sales-orders/${later.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: laterOrder.lines[0].id, quantity: '2' }] }, 201);
    await request('PUT', H(`hardware/orders/${later.id}/fitter`), { fitterId: ramesh.id });
    invoice = await request('GET', H(`documents/${early.document.id}`));
    assert.deepEqual([invoice.hardware.fitter.name, invoice.hardware.fitter.commission], ['Ramesh Kumar', '4.00']);
    assert.ok(await audited(hardware, 'fitter_commission.named_later', early.document.id));
    assert.deepEqual(await request('PUT', H(`hardware/orders/${later.id}/fitter`), { fitterId: null }), { fitter: null });
    assert.ok(await audited(hardware, 'sales_order.fitter_cleared', later.id));
    await hwViewer.call('PUT', H(`hardware/orders/${later.id}/fitter`), { fitterId: ramesh.id }, 403);
  });

  await t.test('the rate board lists each item\'s earlier rate changes, whichever screen made them', async () => {
    await request('POST', H('hardware/rates/items'), { skuIds: [cement.id] }, 201);
    await request('PUT', H('hardware/rates'), { rates: [{ skuId: cement.id, price: '400' }] });
    await request('PUT', H('hardware/rates'), { rates: [{ skuId: cement.id, price: '405' }] });
    const supplier = (await request('GET', H('contacts?kind=supplier&limit=10'))).items[0];
    const receipt = await request('POST', H('documents'), { kind: 'purchase', requestKey: key(), locationId: hwShop.id, contactId: supplier.id,
      lines: [{ skuId: cement.id, quantity: '10', unitPrice: '345', sellingPrice: '410' }] }, 201);
    // A change of the MRP alone is not a rate change.
    await request('PATCH', H(`catalog/${cement.id}`), { label: cement.label, price: '410', mrp: '460', taxRateId: hw18.id, active: true });
    const history = await hwViewer.call('GET', H(`hardware/rates/items/${cement.id}/history`));
    assert.deepEqual(history.changes.map((c) => [c.from_price, c.to_price, c.changed_by_name, c.document_no]),
      [['405.00', '410.00', 'lh-owner', receipt.document_no], ['400.00', '405.00', 'lh-owner', null], ['395.00', '400.00', 'lh-owner', null]]);
    assert.ok(history.changes.every((c) => c.changed_at));
    assert.equal(history.item.on_board, true);
    assert.equal((await request('GET', H(`hardware/rates/items/${cement.id}/history?limit=1`))).changes.length, 1);
    await request('GET', H(`hardware/rates/items/${chlorpyrifos.id}/history`), undefined, 404);
    await request('GET', `/businesses/${grocery.id}/hardware/rates/items/${cement.id}/history`, undefined, 404);
    await other('GET', H(`hardware/rates/items/${cement.id}/history`), undefined, 404);
  });
});
