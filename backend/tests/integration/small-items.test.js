const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { addDays, today } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Small rules inside built modules, end to end on a throwaway database with
// every migration applied:
//   - a business is renamed from its Settings (the owner, or a role that
//     manages the settings), within the create rule's limits, with an audit
//     row of the old and the new name; a restaurant is renamed on its
//     Profile, and its business takes the same name;
//   - with "Ask the biller's PIN for every bill" on, the PIN typed to switch a
//     shared till counts for the next bill: the switch gives a proof (only its
//     hash kept) for that person, business and session, used once within two
//     minutes; a bill refused for another reason leaves it, and a retry of the
//     same bill is answered with it; the PIN works as before;
//   - an order for pickup at a meat shop takes an advance (a receipt in its
//     customer's name, held for the order), which pays the order's bill first
//     when it is picked up; what is left of it after a cancellation goes back
//     with a manager's PIN;
//   - a cut sold for less a kilo than its whole item cost is an offcut, and
//     what offcuts bring in is worked out from the bills, by item and by day;
//   - a link the API builds to a guest's page starts at the restaurant's own
//     guest web address, else at GUEST_WEB_URL.
test('small rules inside built modules', { timeout: 600000 }, async (t) => {
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
  // The guests' site's own address, where a guest link goes when the restaurant has set none.
  process.env.GUEST_WEB_URL = 'https://order.small.invalid/';
  const dir = path.resolve(__dirname, '../../migrations');
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes the proofs, the advance, offcuts and the name rule away, and Up brings them back', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const state = async () => (await scratch.query(`SELECT
        (SELECT count(*)::int FROM pg_tables WHERE tablename='business_counter_bill_proofs') AS proofs,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='weight_pickup_orders' AND column_name='advance_collection_id') AS advance,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='weight_processing_outputs' AND column_name='offcut') AS offcut,
        (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('restaurants_business_name','weight_pickup_orders_advance_kept')) AS triggers,
        (SELECT pg_get_constraintdef(oid) LIKE '%''pickup''%' FROM pg_constraint WHERE conname='business_collection_refunds_source_check') AS pickup_refunds`)).rows[0];
    assert.deepEqual(await state(), { proofs: 1, advance: 1, offcut: 1, triggers: 2, pickup_refunds: true });
    // This migration's Down half, after those of every newer one; found by its name.
    const file = fs.readdirSync(dir).find((name) => name.endsWith('_small-items.sql'));
    await migrate({ direction: 'down', count: Number(file.split('_')[0]), timestamp: true });
    assert.deepEqual(await state(), { proofs: 0, advance: 0, offcut: 0, triggers: 0, pickup_refunds: false });
    const sources = (await scratch.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='business_collection_refunds_source_check'")).rows[0].def;
    for (const kept of ['salon', 'repair', 'optical', 'garage', 'laundry', 'rentals', 'lodging']) assert.match(sources, new RegExp(`'${kept}'`), `${kept} stays a refund source`);
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await state(), { proofs: 1, advance: 1, offcut: 1, triggers: 2, pickup_refunds: true });
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require('../../src/modules/restaurant/setup/services/restaurant.service');
  const password = `Small-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const spice = await restaurantService.createRestaurant({ name: 'Spice Route', code: 'SMALLSPICE', timezone: 'Asia/Kolkata',
    admin: { name: 'Priya Rao', email: 'priya@small.invalid', password } });

  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const refusal = async (method, route, body, auth, status) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return { message: result.body.message, reason: result.body.data?.reason };
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const priya = await login('priya@small.invalid');
  const request = as(priya);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const audits = (businessId, action) => all('SELECT * FROM business_audit WHERE business_id=$1 AND action=$2 ORDER BY id', [businessId, action]);
  const events = (businessId, kind) => all('SELECT * FROM business_events WHERE business_id=$1 AND kind=$2 ORDER BY id', [businessId, kind]);

  // The restaurant joins the platform, and its owner runs three shops.
  await request('POST', '/businesses/link-restaurant', {});
  const spiceBiz = (await request('GET', '/businesses')).businesses.find((b) => Number(b.legacy_restaurant_id) === Number(spice.id));
  const [grocery, meat, pharmacy] = await withTools(request, await createBusinesses(request, 'SMALL', ['grocery', 'meat', 'pharmacy']));
  const G = (route) => `/businesses/${grocery.id}/${route}`;
  const M = (route) => `/businesses/${meat.id}/${route}`;
  const P = (route) => `/businesses/${pharmacy.id}/${route}`;
  const firstLocation = async (biz) => (await request('GET', `/businesses/${biz.id}/locations`)).items[0];
  const [gloc, mloc, ploc] = [await firstLocation(grocery), await firstLocation(meat), await firstLocation(pharmacy)];

  // Staff with their own PINs: two cashiers at the grocery (one also at the
  // meat shop and the pharmacy) and the meat shop's manager.
  const PINS = { ravi: '4826', sita: '7391', meena: '2468' };
  async function person(name) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash,pin_hash,pin_set_at) VALUES($1,$2,$3,$4,$5,now()) RETURNING id',
      [spice.id, `${name[0].toUpperCase()}${name.slice(1)}`, `${name}@small.invalid`, hash, await bcrypt.hash(PINS[name], 4)]);
    return { id: Number(user.id), token: await login(`${name}@small.invalid`) };
  }
  async function give(biz, who, template) {
    const role = (await request('GET', `/businesses/${biz.id}/roles?limit=100`)).items.find((r) => r.template_code === template);
    await request('POST', `/businesses/${biz.id}/members`, { userId: who.id, roleId: role.id }, 201);
  }
  const ravi = await person('ravi');
  const sita = await person('sita');
  const meena = await person('meena');
  await give(grocery, ravi, 'cashier');
  await give(grocery, sita, 'cashier');
  await give(meat, ravi, 'cashier');
  await give(pharmacy, ravi, 'cashier');
  await give(pharmacy, sita, 'cashier');
  await give(meat, meena, 'manager');

  const settingsBody = async (route, extra = {}) => {
    const s = await request('GET', route);
    return { displayName: s.display_name, taxMode: s.tax_mode, rounding: s.rounding, fiscalYearStartMonth: s.fiscal_year_start_month, dateFormat: s.date_format, ...extra };
  };

  // --- A business's own name -----------------------------------------------------------------------
  await t.test('a business is renamed from its Settings, within the create rule\'s limits, with the old and new name audited', async () => {
    const before = await request('GET', M('settings'));
    assert.equal(before.name, meat.name);
    const saved = await request('PUT', M('settings'), await settingsBody(M('settings'), { name: '  Fresh Catch Meats  ' }));
    assert.equal(saved.name, 'Fresh Catch Meats', 'the name is trimmed');
    // The switcher's list and the business itself say it at once.
    assert.equal((await request('GET', '/businesses')).businesses.find((b) => b.id === meat.id).name, 'Fresh Catch Meats');
    assert.equal((await request('GET', M('context'))).business.name, 'Fresh Catch Meats');
    assert.equal((await request('GET', M('settings'))).name, 'Fresh Catch Meats');
    // The name printed on bills is its own setting, untouched.
    assert.equal((await request('GET', M('settings'))).display_name, before.display_name);
    const [renamed] = await audits(meat.id, 'business.renamed');
    assert.deepEqual(renamed.details, { from: meat.name, to: 'Fresh Catch Meats' });
    assert.equal(Number(renamed.actor_id), Number((await one('SELECT id FROM users WHERE email=$1', ['priya@small.invalid'])).id));

    // The create rule's limits: required, at most 150 characters.
    assert.equal((await refusal('PUT', M('settings'), await settingsBody(M('settings'), { name: '   ' }), priya, 400)).message, 'Business name is required');
    assert.equal((await refusal('PUT', M('settings'), await settingsBody(M('settings'), { name: 'x'.repeat(151) }), priya, 400)).message,
      'Business name must be 150 characters or less');
    await request('PUT', M('settings'), await settingsBody(M('settings'), { name: 'x'.repeat(150) }));
    // Another of the owner's businesses' name may be taken (the create rule allows it).
    await request('PUT', M('settings'), await settingsBody(M('settings'), { name: grocery.name }));
    assert.equal((await request('GET', '/businesses')).businesses.filter((b) => b.name === grocery.name).length, 2);
    // An older screen that sends no name keeps it, and the same name again is no rename.
    const renames = (await audits(meat.id, 'business.renamed')).length;
    await request('PUT', M('settings'), await settingsBody(M('settings')));
    await request('PUT', M('settings'), await settingsBody(M('settings'), { name: grocery.name }));
    assert.equal((await audits(meat.id, 'business.renamed')).length, renames);
    assert.equal((await request('GET', M('settings'))).name, grocery.name);

    // A role that manages the settings renames it; one that does not, cannot.
    const asMeena = as(meena.token);
    await asMeena('PUT', M('settings'), await settingsBody(M('settings'), { name: 'Fresh Catch Chicken & Mutton' }));
    assert.equal(Number((await audits(meat.id, 'business.renamed')).at(-1).actor_id), meena.id);
    await refusal('PUT', M('settings'), await settingsBody(M('settings'), { name: 'Ravi\'s shop' }), ravi.token, 403);
    assert.equal((await request('GET', M('settings'))).name, 'Fresh Catch Chicken & Mutton');
  });

  await t.test('a restaurant is renamed on its Profile, and its business takes the same name', async () => {
    // Not from the business's Settings.
    const refused = await refusal('PUT', `/businesses/${spiceBiz.id}/settings`, await settingsBody(`/businesses/${spiceBiz.id}/settings`, { name: 'Spice Garden' }), priya, 409);
    assert.match(refused.message, /renamed on its own Profile page/);
    await request('PUT', '/restaurants/current', { name: 'Spice Route Kitchen', contact: '9845011111', email: null, address: 'MG Road' });
    assert.equal((await request('GET', '/businesses')).businesses.find((b) => b.id === spiceBiz.id).name, 'Spice Route Kitchen');
    const [renamed] = await audits(spiceBiz.id, 'business.renamed');
    assert.deepEqual(renamed.details, { from: 'Spice Route', to: 'Spice Route Kitchen' });
    // The same name again changes nothing more.
    await request('PUT', '/restaurants/current', { name: 'Spice Route Kitchen', contact: '9845011111', email: null, address: 'MG Road' });
    assert.equal((await audits(spiceBiz.id, 'business.renamed')).length, 1);
  });

  // --- The till switch's PIN counts for the next bill ------------------------------------------------
  const groceries = {};
  await t.test('setup: stock at the grocery and the pharmacy, the PIN asked for every bill', async () => {
    const supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Main supplier' }, 201);
    groceries.oil = await request('POST', G('catalog'), { name: 'Sunflower oil 1 L', code: 'OIL1', kind: 'goods', unit: 'each', tracking: 'quantity', price: '180', taxRate: '5' }, 201);
    await request('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: gloc.id, contactId: supplier.id,
      lines: [{ skuId: groceries.oil.id, quantity: '50', unitPrice: '150' }] }, 201);
    const chemist = await request('POST', P('contacts'), { kind: 'supplier', name: 'Medical agencies' }, 201);
    groceries.syrup = await request('POST', P('catalog'), { name: 'Cough syrup 100 ml', code: 'SYR', kind: 'goods', unit: 'bottle', tracking: 'batch', price: '95', taxRate: '5' }, 201);
    await request('POST', P('documents'), { kind: 'purchase', requestKey: key(), locationId: ploc.id, contactId: chemist.id,
      lines: [{ skuId: groceries.syrup.id, quantity: '20', unitPrice: '70', lotCode: 'SY-1', expiresOn: addDays(today(), 400) }] }, 201);
    for (const route of [G('settings'), M('settings'), P('settings')]) await request('PUT', route, await settingsBody(route, { counterPinEveryBill: true }));
  });
  const bill = (extra = {}) => ({ kind: 'sale', requestKey: key(), locationId: gloc.id, channel: 'counter', lines: [{ skuId: groceries.oil.id, quantity: '1' }],
    payment: { method: 'cash', amount: 'full' }, ...extra });
  const proofRow = (proof) => one('SELECT * FROM business_counter_bill_proofs WHERE proof_hash=$1', [sha256(proof)]);

  await t.test('the switch gives a proof for the next bill: only its hash kept, for that person, business and session', async () => {
    const session = await as(sita.token)('POST', G('counter/switch'), { userId: ravi.id, pin: PINS.ravi });
    assert.equal(session.user.id, ravi.id);
    assert.match(session.billProof, /^[A-Za-z0-9_-]{43}$/);
    const minutes = (Date.parse(session.billProofExpiresAt) - Date.now()) / 60000;
    assert.ok(minutes > 1.5 && minutes <= 2.05, `it runs out in two minutes (${minutes})`);
    const row = await proofRow(session.billProof);
    assert.equal(Number(row.business_id), grocery.id);
    assert.equal(Number(row.user_id), ravi.id);
    assert.equal(Number(row.switched_by), sita.id);
    assert.equal(row.session_hash, sha256(session.token));
    assert.equal(row.used_at, null);
    // Nothing in the table holds the proof itself.
    assert.equal((await one('SELECT count(*)::int AS n FROM business_counter_bill_proofs t WHERE strpos(to_jsonb(t)::text, $1) > 0', [session.billProof])).n, 0);
    const [switched] = (await audits(grocery.id, 'counter.switched')).slice(-1);
    assert.deepEqual(switched.details, { from: sita.id, to: ravi.id, billProof: true });

    // The bill right after the switch: no PIN asked.
    const asRavi = as(session.token);
    const first = bill();
    const posted = await asRavi('POST', G('documents'), { ...first, counterProof: session.billProof }, 201);
    assert.equal(Number(posted.created_by), ravi.id);
    const used = await proofRow(session.billProof);
    assert.ok(used.used_at);
    assert.equal(used.used_request_key, first.requestKey);
    // The same bill asked again (its answer lost) is answered with the same bill; other data with its key is refused.
    assert.equal((await asRavi('POST', G('documents'), { ...first, counterProof: session.billProof }, 201)).id, posted.id);
    await refusal('POST', G('documents'), { ...first, lines: [{ skuId: groceries.oil.id, quantity: '2' }], counterProof: session.billProof }, session.token, 409);
    // Used once: the next bill asks for the PIN again.
    const again = await refusal('POST', G('documents'), { ...bill(), counterProof: session.billProof }, session.token, 403);
    assert.equal(again.reason, 'pin_required');
    assert.match(again.message, /counts for one bill within 2 minutes/);
    // The PIN works as before; a wrong one is refused with the tries left.
    await asRavi('POST', G('documents'), { ...bill(), counterPin: PINS.ravi }, 201);
    assert.equal((await refusal('POST', G('documents'), { ...bill(), counterPin: PINS.sita }, session.token, 400)).reason, 'wrong_pin');
    assert.equal((await refusal('POST', G('documents'), bill(), session.token, 403)).reason, 'pin_required');
    // A malformed proof is no proof.
    assert.equal((await refusal('POST', G('documents'), { ...bill(), counterProof: 'not-a-proof' }, session.token, 403)).reason, 'pin_required');
    // A bill off the counter (no channel) asks for neither.
    await asRavi('POST', G('documents'), bill({ channel: undefined }), 201);
  });

  await t.test('a bill refused for another reason leaves the proof; a proof runs out after two minutes', async () => {
    const session = await as(sita.token)('POST', G('counter/switch'), { userId: ravi.id, pin: PINS.ravi });
    const short = await refusal('POST', G('documents'), { ...bill({ lines: [{ skuId: groceries.oil.id, quantity: '500' }] }), counterProof: session.billProof }, session.token, 409);
    assert.match(short.message, /Not enough usable stock/);
    assert.equal((await proofRow(session.billProof)).used_at, null, 'the refused bill did not spend it');
    await as(session.token)('POST', G('documents'), { ...bill(), counterProof: session.billProof }, 201);

    const later = await as(sita.token)('POST', G('counter/switch'), { userId: ravi.id, pin: PINS.ravi });
    // Two minutes on: the switch was made three minutes ago.
    await pool.query("UPDATE business_counter_bill_proofs SET created_at=now()-interval '3 minutes',expires_at=now()-interval '1 minute' WHERE proof_hash=$1", [sha256(later.billProof)]);
    assert.equal((await refusal('POST', G('documents'), { ...bill(), counterProof: later.billProof }, later.token, 403)).reason, 'pin_required');
    // A day after they run out, the next switch clears them away.
    await pool.query("UPDATE business_counter_bill_proofs SET created_at=now()-interval '3 days',expires_at=now()-interval '2 days' WHERE proof_hash=$1", [sha256(later.billProof)]);
    await as(sita.token)('POST', G('counter/switch'), { userId: ravi.id, pin: PINS.ravi });
    assert.equal(await proofRow(later.billProof), undefined);
  });

  await t.test('a proof is refused for another person, in another business and from another session', async () => {
    const session = await as(sita.token)('POST', G('counter/switch'), { userId: ravi.id, pin: PINS.ravi });
    // Sita, signed in as herself, holds Ravi's proof.
    assert.equal((await refusal('POST', G('documents'), { ...bill(), counterProof: session.billProof }, sita.token, 403)).reason, 'pin_required');
    // Ravi's session at the meat shop, where he bills too.
    const cut = await request('POST', M('catalog'), { name: 'Chicken curry cut', code: 'CURRY-T', kind: 'goods', unit: 'kg', tracking: 'quantity', price: '240', taxRate: '0' }, 201);
    const farm = await request('POST', M('contacts'), { kind: 'supplier', name: 'Fresh Farms' }, 201);
    await request('POST', M('documents'), { kind: 'purchase', requestKey: key(), locationId: mloc.id, contactId: farm.id, lines: [{ skuId: cut.id, quantity: '5', unitPrice: '180' }] }, 201);
    const meatBill = { kind: 'sale', requestKey: key(), locationId: mloc.id, channel: 'counter', lines: [{ skuId: cut.id, quantity: '1' }], payment: { method: 'cash', amount: 'full' } };
    assert.equal((await refusal('POST', M('documents'), { ...meatBill, counterProof: session.billProof }, session.token, 403)).reason, 'pin_required');
    // Ravi signed in on another device.
    const elsewhere = await login('ravi@small.invalid');
    // Another sign-in is another session, even within the same second.
    assert.notEqual(elsewhere, session.token);
    assert.equal((await refusal('POST', G('documents'), { ...bill(), counterProof: session.billProof }, elsewhere, 403)).reason, 'pin_required');
    // None of those spent it: the till it was given to still uses it.
    assert.equal((await proofRow(session.billProof)).used_at, null);
    await as(session.token)('POST', G('documents'), { ...bill(), counterProof: session.billProof }, 201);
  });

  await t.test('the pharmacy counter takes the switch\'s proof too; with the PIN not asked for every bill, no proof is given', async () => {
    const session = await as(sita.token)('POST', P('counter/switch'), { userId: ravi.id, pin: PINS.ravi });
    const sale = { requestKey: key(), locationId: ploc.id, channel: 'counter', lines: [{ skuId: groceries.syrup.id, quantity: '1' }], payment: { method: 'cash', amount: 'full' } };
    const sold = await as(session.token)('POST', P('pharmacy/sales'), { ...sale, counterProof: session.billProof }, 201);
    assert.equal(Number(sold.document.created_by), ravi.id);
    assert.equal((await as(session.token)('POST', P('pharmacy/sales'), { ...sale, counterProof: session.billProof }, 201)).document.id, sold.document.id);
    assert.equal((await refusal('POST', P('pharmacy/sales'), { ...sale, requestKey: key(), counterProof: session.billProof }, session.token, 403)).reason, 'pin_required');
    await request('PUT', P('settings'), await settingsBody(P('settings'), { counterPinEveryBill: false }));
    const plain = await as(sita.token)('POST', P('counter/switch'), { userId: ravi.id, pin: PINS.ravi });
    assert.equal(plain.billProof, undefined);
    assert.equal((await audits(pharmacy.id, 'counter.switched')).at(-1).details.billProof, false);
    for (const route of [G('settings'), M('settings')]) await request('PUT', route, await settingsBody(route, { counterPinEveryBill: false }));
  });

  // --- An advance on an order for pickup ------------------------------------------------------------------
  const nil = (await request('GET', M('tax-rates'))).items.find((r) => Number(r.rate) === 0);
  const kg = (name, code, price) => request('POST', M('catalog'), { name, code, kind: 'goods', unit: 'kg', tracking: 'quantity', price, taxRateId: nil.id }, 201);
  const whole = await kg('Whole chicken', 'WHOLE', '200');
  const curry = await kg('Curry cut', 'CURRY', '240');
  const bones = await kg('Chicken bones', 'BONES', '40');
  const farm = await request('POST', M('contacts'), { kind: 'supplier', name: 'Poultry farm' }, 201);
  // Bones bought in before any cutting (sold below as stock that was never cut here).
  await request('POST', M('documents'), { kind: 'purchase', requestKey: key(), locationId: mloc.id, contactId: farm.id, lines: [
    { skuId: whole.id, quantity: '20', unitPrice: '180' }, { skuId: curry.id, quantity: '20', unitPrice: '170' }, { skuId: bones.id, quantity: '1', unitPrice: '10' }] }, 201);
  const hotel = await request('POST', M('contacts'), { kind: 'customer', name: 'Hotel Annapurna', phone: '9845022222' }, 201);
  const soon = () => new Date(Date.now() + 3 * 3600000).toISOString();
  const order = (extra = {}) => ({ requestKey: key(), locationId: mloc.id, contactId: hotel.id, pickupAt: soon(), lines: [{ skuId: curry.id, quantity: '5' }], ...extra });
  const pickups = async (filters = {}) => (await request('GET', M(`weight/pickup-orders?${new URLSearchParams({ limit: 100, ...filters })}`))).items;
  const pickup = async (id) => (await pickups({ id })).find((o) => Number(o.id) === Number(id));
  let advanced;

  await t.test('an order takes an advance: a receipt in its customer\'s name, held for its bill', async () => {
    // A walk-in's order takes none: a receipt is in a saved customer's name.
    const walkIn = await refusal('POST', M('weight/pickup-orders'), order({ contactId: null, customerName: 'Walk-in', advance: { amount: '500', method: 'upi' } }), priya, 409);
    assert.match(walkIn.message, /saved customer/);
    // At most what the order comes to at today's rates (5 kg at ₹240).
    const over = await refusal('POST', M('weight/pickup-orders'), order({ advance: { amount: '1200.01', method: 'upi' } }), priya, 400);
    assert.match(over.message, /at most 1200\.00 at today's rates/);
    // Taking money needs sales.edit: a role that only bills cannot.
    const counterOnly = await request('POST', M('roles'), { name: 'Order taker', permissions: ['sales.view', 'sales.create', 'contacts.view', 'catalog.view'] }, 201);
    await request('POST', M('members'), { userId: sita.id, roleId: counterOnly.id }, 201);
    await refusal('POST', M('weight/pickup-orders'), order({ advance: { amount: '500', method: 'upi' } }), sita.token, 403);
    await as(sita.token)('POST', M('weight/pickup-orders'), order(), 201);

    const body = order({ notes: 'Curry cut, no skin', advance: { amount: '500', method: 'upi', reference: 'UPI 4412' } });
    advanced = await request('POST', M('weight/pickup-orders'), body, 201);
    assert.ok(advanced.advance_collection_id);
    // The same order asked again is the same order, with one receipt; other data with its key is refused.
    assert.equal((await request('POST', M('weight/pickup-orders'), body, 201)).id, advanced.id);
    await refusal('POST', M('weight/pickup-orders'), { ...body, notes: 'Changed' }, priya, 409);
    const receipt = await one('SELECT * FROM business_collections WHERE business_id=$1 AND id=$2', [meat.id, advanced.advance_collection_id]);
    assert.equal(receipt.amount, '500.00');
    assert.equal(Number(receipt.contact_id), Number(hotel.id));
    assert.equal(receipt.method, 'upi');
    assert.equal(receipt.reference, 'UPI 4412');
    assert.equal((await one('SELECT count(*)::int AS n FROM business_collections WHERE business_id=$1', [meat.id])).n, 1);
    const listed = await pickup(advanced.id);
    assert.equal(Number(listed.advance), 500, 'the list carries money as numbers');
    assert.equal(Number(listed.advance_left), 500);
    assert.equal(listed.advance_no, receipt.collection_no);
    assert.equal(listed.advance_to_hand_back, false);
    // Audited and announced, with its order.
    assert.ok((await audits(meat.id, 'collection.recorded')).some((a) => Number(a.entity_id) === Number(receipt.id) && Number(a.details.pickupOrderId) === Number(advanced.id)));
    assert.equal((await audits(meat.id, 'pickup_order.created')).at(-1).details.advance, '500.00');
    assert.ok((await events(meat.id, 'collection.recorded')).some((e) => Number(e.payload.pickupOrderId) === Number(advanced.id)));
    // The advance stays the order's (a database rule).
    await assert.rejects(pool.query('UPDATE weight_pickup_orders SET advance_collection_id=NULL WHERE id=$1', [advanced.id]), /advance stays with it/);
  });

  await t.test('while the order is open, its advance is not applied to the customer\'s other bills', async () => {
    const other = await request('POST', M('documents'), { kind: 'sale', requestKey: key(), locationId: mloc.id, contactId: hotel.id, lines: [{ skuId: curry.id, quantity: '1' }] }, 201);
    const applied = await refusal('POST', M(`receivables/customers/${hotel.id}/apply-advance`), { requestKey: key() }, priya, 409);
    assert.match(applied.message, /no advance to apply/);
    // Paid off, so it does not stand in the way below.
    await request('POST', M(`documents/${other.id}/payments`), { requestKey: key(), amount: other.total, method: 'cash' }, 201);
    // An order with an advance is closed by its own bill, not by marking another bill.
    const marked = await refusal('POST', M(`weight/pickup-orders/${advanced.id}/status`), { status: 'collected', documentId: other.id }, priya, 409);
    assert.match(marked.message, /has an advance: bill it from Quick bill/);
  });

  await t.test('the order\'s bill: its advance pays first, the rest is taken, and the order closes with it', async () => {
    // The advance pays only a bill in its customer's name.
    const lines = [{ skuId: curry.id, quantity: '5.25' }];
    const nameless = await refusal('POST', M('documents'), { kind: 'sale', requestKey: key(), locationId: mloc.id, lines, pickupOrderId: advanced.id, payment: { method: 'cash', amount: 'full' } },
      priya, 409);
    assert.match(nameless.message, /advance pays only a bill in their name/);
    const body = { kind: 'sale', requestKey: key(), locationId: mloc.id, contactId: hotel.id, lines, pickupOrderId: advanced.id, channel: 'counter',
      payment: { method: 'cash', amount: 'full', tendered: '1000' } };
    const posted = await request('POST', M('documents'), body, 201);
    // 5.25 kg at ₹240 = ₹1,260: ₹500 from the advance, ₹760 in cash (₹240 change from ₹1,000).
    assert.equal(posted.total, '1260.00');
    assert.equal(posted.change, '240.00');
    const payments = await all('SELECT method,amount,collection_id FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [meat.id, posted.id]);
    assert.deepEqual(payments.map((p) => [p.method, p.amount, p.collection_id === null ? null : Number(p.collection_id)]),
      [['upi', '500.00', Number(advanced.advance_collection_id)], ['cash', '760.00', null]]);
    const closed = await pickup(advanced.id);
    assert.equal(closed.status, 'collected');
    assert.equal(Number(closed.document_id), Number(posted.id));
    assert.equal(Number(closed.advance_left), 0);
    assert.equal(closed.advance_to_hand_back, false);
    const [collected] = (await audits(meat.id, 'pickup_order.collected')).slice(-1);
    assert.deepEqual(collected.details, { documentId: Number(posted.id), advanceUsed: '500.00' });
    assert.equal((await events(meat.id, 'pickup_order.collected')).at(-1).payload.advanceUsed, '500.00');
    // The advance's money came in with its receipt: the day's cash counts the bill's ₹760 only.
    const day = await request('GET', M('reports/takings'));
    assert.equal(paise(day.received.upi), 50000, 'the advance, once, on the day it was taken');
    // The same bill asked again is the same bill, paid once; the order cannot be billed twice.
    assert.equal((await request('POST', M('documents'), body, 201)).id, posted.id);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_payments WHERE business_id=$1 AND document_id=$2', [meat.id, posted.id])).n, 2);
    const twice = await refusal('POST', M('documents'), { ...body, requestKey: key() }, priya, 409);
    assert.match(twice.message, /already collected/);
  });

  await t.test('an order with no advance closes with its bill too; a bill smaller than the advance leaves the rest to hand back', async () => {
    const plain = await request('POST', M('weight/pickup-orders'), order({ contactId: null, customerName: 'Raju', lines: [{ skuId: curry.id, amount: '200' }] }), 201);
    const billed = await request('POST', M('documents'), { kind: 'sale', requestKey: key(), locationId: mloc.id, lines: [{ skuId: curry.id, quantity: '0.8' }],
      pickupOrderId: plain.id, payment: { method: 'cash', amount: 'full' } }, 201);
    assert.equal(Number((await pickup(plain.id)).document_id), Number(billed.id));
    // ₹300 taken on a 2 kg order; 1 kg is billed (₹240): ₹60 is left on the receipt.
    const small = await request('POST', M('weight/pickup-orders'), order({ lines: [{ skuId: curry.id, quantity: '2' }], advance: { amount: '300', method: 'cash' } }), 201);
    const half = await request('POST', M('documents'), { kind: 'sale', requestKey: key(), locationId: mloc.id, contactId: hotel.id, lines: [{ skuId: curry.id, quantity: '1' }],
      pickupOrderId: small.id }, 201);
    assert.equal(half.total, '240.00');
    const after = await pickup(small.id);
    assert.equal(Number(after.advance_left), 60);
    assert.equal(after.advance_to_hand_back, true);
    assert.equal((await request('GET', M(`documents/${half.id}`))).payments.reduce((s, p) => s + paise(p.amount), 0), 24000, 'the bill is paid in full by the advance');
  });

  await t.test('an advance taken later; after a cancellation a manager hands back what is left, with their PIN', async () => {
    const later = await request('POST', M('weight/pickup-orders'), order(), 201);
    const advanceKey = key();
    const taken = await request('POST', M(`weight/pickup-orders/${later.id}/advance`), { amount: '400', method: 'cash', requestKey: advanceKey }, 201);
    assert.ok(taken.advance_collection_id);
    // Asked again: the same receipt; a second advance is refused.
    assert.equal((await request('POST', M(`weight/pickup-orders/${later.id}/advance`), { amount: '400', method: 'cash', requestKey: advanceKey }, 201)).advance_collection_id,
      taken.advance_collection_id);
    assert.match((await refusal('POST', M(`weight/pickup-orders/${later.id}/advance`), { amount: '100', method: 'cash', requestKey: key() }, priya, 409)).message,
      /already has its advance/);
    // Open: nothing goes back yet.
    const hand = (extra = {}) => ({ method: 'cash', reason: 'Order cancelled by the hotel', approverId: meena.id, pin: PINS.meena, requestKey: key(), ...extra });
    assert.match((await refusal('POST', M(`weight/pickup-orders/${later.id}/advance-refund`), hand(), priya, 409)).message, /still open/);
    await request('POST', M(`weight/pickup-orders/${later.id}/status`), { status: 'cancelled', reason: 'The hotel cancelled the party' });
    assert.equal((await pickup(later.id)).advance_to_hand_back, true);
    // Ravi (a cashier, no refunds) needs a manager: without the PIN, with a wrong one, and with his own refused.
    assert.equal((await refusal('POST', M(`weight/pickup-orders/${later.id}/advance-refund`), hand({ approverId: undefined, pin: undefined }), ravi.token, 400)).reason,
      'approval_needed');
    assert.equal((await refusal('POST', M(`weight/pickup-orders/${later.id}/advance-refund`), hand({ pin: '1111' }), ravi.token, 400)).reason, 'wrong_pin');
    assert.equal((await refusal('POST', M(`weight/pickup-orders/${later.id}/advance-refund`), hand({ approverId: ravi.id, pin: PINS.ravi }), ravi.token, 403)).reason,
      'not_an_approver');
    const refundKey = key();
    const refund = await as(ravi.token)('POST', M(`weight/pickup-orders/${later.id}/advance-refund`), hand({ requestKey: refundKey }), 201);
    assert.equal(refund.amount, '400.00');
    assert.equal(refund.repeated, false);
    const row = await one('SELECT * FROM business_collection_refunds WHERE business_id=$1 AND id=$2', [meat.id, refund.id]);
    assert.equal(row.source, 'pickup');
    assert.equal(Number(row.approved_by), meena.id);
    assert.equal((await as(ravi.token)('POST', M(`weight/pickup-orders/${later.id}/advance-refund`), hand({ requestKey: refundKey }), 201)).repeated, true);
    const done = await pickup(later.id);
    assert.equal(Number(done.advance_left), 0);
    assert.equal(done.advance_to_hand_back, false);
    assert.match((await refusal('POST', M(`weight/pickup-orders/${later.id}/advance-refund`), hand(), ravi.token, 409)).message, /Nothing is left/);
    assert.equal((await audits(meat.id, 'collection.refunded')).at(-1).details.source, 'pickup');
    assert.equal(Number((await events(meat.id, 'collection.refunded')).at(-1).payload.approvedBy), meena.id);
    // Without an advance there is nothing to hand back.
    const none = await request('POST', M('weight/pickup-orders'), order(), 201);
    await request('POST', M(`weight/pickup-orders/${none.id}/status`), { status: 'cancelled', reason: 'Not needed' });
    assert.match((await refusal('POST', M(`weight/pickup-orders/${none.id}/advance-refund`), hand(), priya, 409)).message, /has no advance/);
  });

  // --- Offcuts ---------------------------------------------------------------------------------------------
  await t.test('a cut sold for less a kilo than its whole item cost is an offcut, and what offcuts bring in comes from the bills', async () => {
    const sell = (lines) => request('POST', M('documents'), { kind: 'sale', requestKey: key(), locationId: mloc.id, lines, payment: { method: 'cash', amount: 'full' } }, 201);
    // Bones sold before they were ever cut here are not offcuts.
    await sell([{ skuId: bones.id, quantity: '0.5' }]);
    const wholeLot = await one('SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [meat.id, whole.id]);
    // 10 kg of whole chicken at ₹180 a kilo: curry cut at ₹240 is a cut, bones at ₹40 an offcut.
    const batch = await request('POST', M('weight/processing'), { inputLotId: wholeLot.id, inputQuantity: '10', requestKey: key(),
      outputs: [{ skuId: curry.id, quantity: '7' }, { skuId: bones.id, quantity: '2' }] }, 201);
    const outputs = await all('SELECT output_sku_id,offcut FROM weight_processing_outputs WHERE business_id=$1 AND batch_id=$2', [meat.id, batch.id]);
    assert.deepEqual(Object.fromEntries(outputs.map((o) => [Number(o.output_sku_id), o.offcut])), { [Number(curry.id)]: false, [Number(bones.id)]: true });
    const listed = await request('GET', M(`weight/processing/${batch.id}`));
    assert.equal(listed.outputs.find((o) => Number(o.sku_id) === Number(bones.id)).offcut, true);
    // Sold: 1.5 kg of bones with 1 kg of curry cut, then 0.5 kg of bones.
    const first = await sell([{ skuId: bones.id, quantity: '1.5' }, { skuId: curry.id, quantity: '1' }]);
    await sell([{ skuId: bones.id, quantity: '0.5' }]);
    const D = today();
    const report = async () => (await request('GET', M(`weight/reports/yield?from=${addDays(D, -1)}&to=${addDays(D, 1)}`))).offcuts;
    let offcuts = await report();
    assert.equal(offcuts.recovered, '80.00');
    assert.deepEqual(offcuts.items.map((r) => [r.sku_id, r.label, r.bills, r.quantity, r.recovered, r.cut_kg]),
      [[Number(bones.id), 'Chicken bones', 2, '2.000', '80.00', '2.000']]);
    assert.equal(offcuts.days.reduce((s, d) => s + paise(d.recovered), 0), 8000);
    // Half a kilo of the first bill's bones comes back: ₹20 less.
    const line = (await request('GET', M(`documents/${first.id}`))).lines.find((l) => Number(l.sku_id) === Number(bones.id));
    await request('POST', M(`documents/${first.id}/returns`), { requestKey: key(), reason: 'Too many', lines: [{ lineId: line.id, quantity: '0.5', restock: true }] }, 201);
    offcuts = await report();
    assert.equal(offcuts.recovered, '60.00');
    assert.equal(offcuts.items[0].quantity, '1.500');
    // Someone without reports does not see it.
    await refusal('GET', M(`weight/reports/yield?from=${D}&to=${D}`), undefined, ravi.token, 403);
  });

  // --- Guest links ------------------------------------------------------------------------------------------
  await t.test('a guest link starts at the restaurant\'s own guest web address, else at GUEST_WEB_URL', async () => {
    let settings = await request('GET', '/reservations/online-settings');
    assert.equal(settings.url, `https://order.small.invalid/book/${settings.token}`);
    await request('PUT', '/orders/service-settings/guest-web-address', { guestWebAddress: 'book.spiceroute.in/' });
    settings = await request('GET', '/reservations/online-settings');
    assert.equal(settings.guestWebAddress, 'https://book.spiceroute.in');
    assert.equal(settings.url, `https://book.spiceroute.in/book/${settings.token}`);
    // The restaurant's own address is read as GUEST_WEB_URL is.
    assert.equal((await refusal('PUT', '/orders/service-settings/guest-web-address', { guestWebAddress: 'https://book.spiceroute.in/?x=1' }, priya, 400)).message,
      'Type only the address itself, like https://order.myrestaurant.in — without anything after a ? or #.');
  });
});
