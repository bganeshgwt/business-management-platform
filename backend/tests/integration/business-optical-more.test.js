const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { publishNotice, giveConsent } = require('./helpers/privacy');
const { addDays, daysFrom, momentAt } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The rest of the optical shop: lens items that keep their details (picked on
// an order), contact-lens prescriptions and the counter's checks (the MD-42
// registration, the customer's prescription), toric, multifocal and coloured
// power grids with the stock of each power, replacement reminders worked out
// on the business's clock, free trials converted on payment or lapsed, the
// prism split and the vertex distance, the frame's size, the workshop's steps,
// the examiner's council and validity, warranty dates and warranty remakes,
// referring doctors and the referral report, eye-test bookings that become
// prescriptions, quotations that become orders, booked orders changed, frames
// held in stock, several advances, and recall intervals by group. Refusals
// with their status, idempotent retries, the rules the database keeps, audit
// and events, other types and other owners. Runs on its own throwaway
// database with every migration applied.
test('the rest of the optical shop', { timeout: 600000 }, async (t) => {
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
    const tables = ['optical_contact_lens_rows', 'optical_order_advances', 'optical_frame_holds', 'optical_contact_lens_trials'];
    const left = async () => (await scratch.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
    const column = async (table, name) => (await scratch.query('SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, name])).rows[0].n;
    assert.equal(await left(), tables.length);
    const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_optical-more.sql')).split('_')[0]);
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.equal(await left(), 0);
    for (const [table, name] of [['optical_prescriptions', 'kind'], ['optical_prescriptions', 'referred_by'], ['optical_prescription_rows', 'prism_vertical'],
      ['optical_orders', 'frame_a'], ['optical_orders', 'quotation_id'], ['optical_order_lines', 'warranty_until'], ['optical_order_events', 'step'],
      ['optical_settings', 'recall_months_child'], ['optical_recall_reminders', 'kind']]) assert.equal(await column(table, name), 0, `${table}.${name} is gone`);
    assert.equal((await scratch.query("SELECT count(*)::int AS n FROM business_permissions WHERE code='optical.manage'")).rows[0].n, 0);
    assert.equal((await scratch.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='business_stock_lots_optical_holds'")).rows[0].n, 0);
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await left(), tables.length);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `OpticalMore-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('optmore-owner');
  await owner('optmore-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('optmore-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('optmore-other@test.invalid'));
  // The status and the sentence of a refusal.
  const refused = async (method, route, body, auth = ownerToken) => {
    const result = await call(method, route, body, auth);
    return { status: result.status, message: result.body.message };
  };
  const expectRefusal = async (method, route, body, status, pattern, auth) => {
    const result = await refused(method, route, body, auth);
    assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result)}`);
    if (pattern) assert.match(result.message, pattern);
  };

  const [made, grocery] = await createBusinesses(request, 'OPTMORE', ['optical', 'grocery']);
  const [optical] = await withTools(request, [made]);
  const [elsewhere] = await createBusinesses(other, 'OTHEROPT', ['optical']);
  const O = (suffix) => `/businesses/${optical.id}/${suffix}`;
  await request('PUT', O('modules/quotations'), { enabled: true });
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);
  const addMonths = (day, months) => {
    const [y, m, d] = day.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    target.setUTCDate(Math.min(d, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
    return target.toISOString().slice(0, 10);
  };
  const audited = async (action, entityId) => (await one('SELECT details FROM business_audit WHERE business_id=$1 AND action=$2 AND entity_id=$3 ORDER BY id DESC LIMIT 1', [optical.id, action, entityId]))?.details;
  const evented = async (kind, entityId) => (await one('SELECT payload FROM business_events WHERE business_id=$1 AND kind=$2 AND entity_id=$3 ORDER BY id DESC LIMIT 1', [optical.id, kind, entityId]))?.payload;
  const stock = async (skuId) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [optical.id, skuId])).q);
  const shop = (await request('GET', O('locations'))).items[0];
  const slabs = (await request('GET', O('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const roles = (await request('GET', O('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', O('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    return { as: as(await login(email)), token: await login(email), id: user.id };
  }
  const manager = await staff('optmore-manager@test.invalid', 'manager');
  const cashier = await staff('optmore-cashier@test.invalid', 'cashier');
  const keeper = await staff('optmore-keeper@test.invalid', 'stock_keeper');
  const viewer = await staff('optmore-viewer@test.invalid', 'viewer');
  const optometrist = await staff('optmore-optometrist@test.invalid', 'optometrist');
  const customer = (name, phone) => request('POST', O('contacts'), { kind: 'customer', name, ...(phone ? { phone } : {}) }, 201);
  const meena = await customer('Meena Iyer', '9000000101');
  const suresh = await customer('Suresh Babu', '9000000102');
  const kavya = await customer('Kavya Rao', '9000000103');
  const diya = await customer('Diya Sharma', '9000000104');
  const ramesh = await customer('Ramesh Gupta', '9000000105');
  const nisha = await customer('Nisha Verma', '9000000106');
  const arjun = await customer('Arjun Das', '9000000107');
  const supplier = await request('POST', O('contacts'), { kind: 'supplier', name: 'Lens House' }, 201);
  const purchase = (lines) => request('POST', O('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines }, 201);
  const goods = (body) => request('POST', O('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', taxRateId: gst5.id, ...body }, 201);
  const spectacleRows = [{ eye: 'right', zone: 'distance', sph: '-1.00' }, { eye: 'left', zone: 'distance', sph: '-1.25' },
    { eye: 'right', zone: 'near', add: '+2.00' }, { eye: 'left', zone: 'near', add: '+2.00' }];
  const prescribe = (contactId, extra = {}) => request('POST', O('optical/prescriptions'), { requestKey: key(), contactId, rows: spectacleRows, pdBinocular: '64', ...extra }, 201);
  const move = (by, order, status, extra = {}, expected = 200) => by('POST', O(`optical/orders/${order.id}/status`), { status, ...extra }, expected);
  const measured = { pdRight: '32', pdLeft: '32', fittingHeightRight: '18', fittingHeightLeft: '18' };

  // --- The shared set-up: frames, lens items that keep their details, the fitting charge --------
  const frame1 = await goods({ name: 'Titan TE-2001 black', code: 'FR-2001', price: '2499', mrp: '2499', hsnCode: '90031100' });
  const frame2 = await goods({ name: 'Fastrack FT-77 blue', code: 'FR-77', price: '1999', mrp: '1999', hsnCode: '90031100' });
  const frame3 = await goods({ name: 'Ray-Ban RB-3025 gold', code: 'FR-3025', price: '5990', mrp: '5990', hsnCode: '90031100' });
  let progressive, single;
  const fitting = await request('POST', O('catalog'), { kind: 'service', unit: 'service', name: 'Fitting charges', code: 'SV-FIT', price: '100', taxRateId: gst18.id }, 201);

  await t.test('lens items keep their design, index, material, coatings and tint', async () => {
    progressive = await goods({ name: 'Progressive 1.60 poly AR blue-cut', code: 'LN-PRG160', price: '3000', hsnCode: '90015000',
      attributes: { lensDesign: 'progressive', lensIndex: '1.6', lensMaterial: 'polycarbonate', coatings: ['blue_cut', 'anti_reflective'] } });
    assert.deepEqual(progressive.attributes, { lensDesign: 'progressive', lensIndex: '1.60', lensMaterial: 'polycarbonate', coatings: ['anti_reflective', 'blue_cut'] });
    single = await goods({ name: 'Single vision 1.56 CR-39 AR', code: 'LN-SV156', price: '1000', hsnCode: '90015000',
      attributes: { lensDesign: 'single_vision', lensIndex: '1.56', lensMaterial: 'cr39', coatings: ['anti_reflective'] } });
    // Checked as written: the index, the coatings, one kind of lens.
    await expectRefusal('POST', O('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'Bad', code: 'BAD-1', price: '10', attributes: { lensIndex: '2.5' } }, 400, /Lens index must be from 1\.40 to 2\.00/);
    await expectRefusal('POST', O('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'Bad', code: 'BAD-2', price: '10', attributes: { coatings: ['gold'] } }, 400, /must be one of/);
    await expectRefusal('POST', O('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'Bad', code: 'BAD-3', price: '10',
      attributes: { lensDesign: 'progressive', power: '-1.00', baseCurve: '8.6', diameter: '14' } }, 400, /a spectacle lens or a contact lens, not both/);
    // Changed later, with what was and what is in the activity log.
    const changed = await request('PATCH', O(`catalog/${single.id}`), { label: single.label, price: '1000', taxRateId: gst5.id, attributes: { tint: 'Grey 20%' } });
    assert.equal(changed.attributes.tint, 'Grey 20%');
    assert.deepEqual((await audited('catalog.lens_details_changed', single.id)).to, { lensDesign: 'single_vision', lensIndex: '1.56', lensMaterial: 'cr39', coatings: ['anti_reflective'], tint: 'Grey 20%' });
    await request('PATCH', O(`catalog/${single.id}`), { label: single.label, price: '1000', taxRateId: gst5.id, attributes: { tint: '' } });
    await purchase([{ skuId: frame1.id, quantity: '3', unitPrice: '1200' }, { skuId: frame2.id, quantity: '2', unitPrice: '900' }, { skuId: frame3.id, quantity: '1', unitPrice: '3000' },
      { skuId: progressive.id, quantity: '10', unitPrice: '1200' }, { skuId: single.id, quantity: '12', unitPrice: '300' }]);
  });

  // --- Prescriptions: prism split, vertex distance, examiner's registration, referrer, age ------
  let sureshRx, meenaRx, rameshRx;
  await t.test('prescriptions: the prism horizontal and vertical, the vertex distance, the examiner\'s council and validity, the referrer', async () => {
    sureshRx = await prescribe(suresh.id, { examinedOn: daysFrom(-305), vertexDistance: '12', ageYears: '58',
      rows: [{ eye: 'right', zone: 'distance', sph: '-4.50', prism: '1', prismBase: 'in', prismVertical: '0.5', prismVerticalBase: 'down' }, { eye: 'left', zone: 'distance', sph: '-4.25' },
        { eye: 'right', zone: 'near', add: '+2.00' }, { eye: 'left', zone: 'near', add: '+2.00' }] });
    assert.deepEqual([sureshRx.kind, sureshRx.vertex_distance, sureshRx.age_years, sureshRx.rows[0].prism, sureshRx.rows[0].prism_base, sureshRx.rows[0].prism_vertical,
      sureshRx.rows[0].prism_vertical_base], ['spectacles', '12.0', 58, 1, 'in', 0.5, 'down']);
    // A horizontal prism's base is in or out; a vertical one's up or down; each with its prism.
    await expectRefusal('POST', O('optical/prescriptions'), { requestKey: key(), contactId: suresh.id, rows: [{ eye: 'right', zone: 'distance', sph: '-1', prism: '1', prismBase: 'up' }] },
      400, /horizontal prism base must be one of/);
    await expectRefusal('POST', O('optical/prescriptions'), { requestKey: key(), contactId: suresh.id, rows: [{ eye: 'right', zone: 'distance', sph: '-1', prismVerticalBase: 'up' }] },
      400, /vertical prism base goes with a vertical prism/);
    await expectRefusal('POST', O('optical/prescriptions'), { requestKey: key(), contactId: suresh.id, rows: spectacleRows, vertexDistance: '40' }, 400, /Vertex distance must be from 5 to 25 mm/);
    await assert.rejects(pool.query(`INSERT INTO optical_prescription_rows(business_id,prescription_id,eye,zone,sph,prism,prism_base) VALUES($1,$2,'left','intermediate',-1,1,'up')`,
      [optical.id, sureshRx.id]), /check/);
    // An outside examiner's registration with its council, run out before the test: kept, and warned of.
    meenaRx = await request('POST', O('optical/prescriptions'), { requestKey: key(), contactId: meena.id, rows: [{ eye: 'right', zone: 'distance', sph: '-1.00' }, { eye: 'left', zone: 'distance', sph: '-1.00' }],
      pdBinocular: '62', examinedOn: daysFrom(-215), examinerKind: 'outside', examinerName: 'Dr. P. Reddy', registrationNo: 'TSMC/1234',
      registrationCouncil: 'Telangana State Medical Council', registrationValidUntil: daysFrom(-220) }, 201);
    assert.equal(meenaRx.registration_lapsed, true);
    assert.match(meenaRx.warnings[0], /Dr\. P\. Reddy's registration TSMC\/1234 with Telangana State Medical Council ran out on .*, before this eye test/);
    assert.equal((await viewer.as('GET', O('optical/prescriptions?registration_lapsed=true'))).total, 1);
    await expectRefusal('POST', O('optical/prescriptions'), { requestKey: key(), contactId: meena.id, rows: spectacleRows, registrationCouncil: 'Telangana State Medical Council' },
      400, /registration number with its council/);
    const examiners = await viewer.as('GET', O('optical/examiners'));
    assert.deepEqual(examiners.outside.map((x) => [x.name, x.registration_council, x.registration_valid_until]), [['Dr. P. Reddy', 'Telangana State Medical Council', daysFrom(-220)]]);
    // The doctor who referred the customer, written on the prescription.
    rameshRx = await prescribe(ramesh.id, { referredBy: 'Dr. Anil Kumar' });
    assert.equal(rameshRx.referred_by, 'Dr. Anil Kumar');
    assert.deepEqual((await viewer.as('GET', O('optical/examiners'))).referrers, ['Dr. Anil Kumar']);
  });

  // --- Contact-lens prescriptions -----------------------------------------------------------------
  let kavyaRx;
  await t.test('contact-lens prescriptions: each eye\'s lens, kept apart from spectacle prescriptions', async () => {
    kavyaRx = await request('POST', O('optical/prescriptions'), { requestKey: key(), kind: 'contact_lens', contactId: kavya.id, examinedOn: daysFrom(-215),
      lenses: [{ eye: 'right', baseCurve: '8.4', diameter: '14', power: '-2.00', brand: 'Acuvue Oasys', modality: 'monthly', wearingSchedule: '8 hours a day, no sleeping' },
        { eye: 'left', baseCurve: '8.4', diameter: '14', power: '-2.25', brand: 'Acuvue Oasys', modality: 'monthly' }], notes: 'First fitting' }, 201);
    assert.deepEqual([kavyaRx.kind, kavyaRx.rows, kavyaRx.lenses.map((l) => [l.eye, Number(l.base_curve), Number(l.diameter), Number(l.power), l.modality])],
      ['contact_lens', [], [['right', 8.4, 14, -2, 'monthly'], ['left', 8.4, 14, -2.25, 'monthly']]]);
    // A toric lens's CYL with its AXIS; no PD or vertex distance; a lens's power is needed.
    const cl = (lenses, extra = {}) => ({ requestKey: key(), kind: 'contact_lens', contactId: kavya.id, lenses, ...extra });
    await expectRefusal('POST', O('optical/prescriptions'), cl([{ eye: 'right', baseCurve: '8.6', diameter: '14.5', power: '-1', cyl: '-0.75' }]), 400, /Right eye lens: AXIS is needed with a CYL/);
    await expectRefusal('POST', O('optical/prescriptions'), cl([{ eye: 'right', baseCurve: '8.6', diameter: '14.5' }]), 400, /Right eye lens: power is needed/);
    await expectRefusal('POST', O('optical/prescriptions'), cl([{ eye: 'right', baseCurve: '5', diameter: '14', power: '-1' }]), 400, /base curve must be from 6 to 10 mm/);
    await expectRefusal('POST', O('optical/prescriptions'), cl([{ eye: 'right', baseCurve: '8.6', diameter: '14', power: '-1' }], { vertexDistance: '12' }), 400, /vertex distance goes with a spectacle prescription/);
    await expectRefusal('POST', O('optical/prescriptions'), cl([{ eye: 'right', baseCurve: '8.6', diameter: '14', power: '-1' }], { pdBinocular: '62' }), 400, /PD goes with a spectacle prescription/);
    // Its kind never changes; spectacles are never made from it.
    await expectRefusal('PUT', O(`optical/prescriptions/${kavyaRx.id}`), { kind: 'spectacles', rows: spectacleRows }, 400, /keeps its kind/);
    await expectRefusal('POST', O('optical/orders/preview'), { locationId: shop.id, prescriptionId: kavyaRx.id, frame: { skuId: frame1.id }, lenses: [{ eye: 'right', skuId: single.id }],
      measurements: measured }, 409, /contact-lens prescription: spectacles are made from a spectacle prescription/);
    await assert.rejects(pool.query(`INSERT INTO optical_prescription_rows(business_id,prescription_id,eye,zone,sph) VALUES($1,$2,'right','distance',-1)`, [optical.id, kavyaRx.id]),
      /go on a spectacle prescription/);
    await assert.rejects(pool.query('UPDATE optical_prescriptions SET kind=$2 WHERE id=$1', [kavyaRx.id, 'spectacles']), /keeps its kind/);
    // Corrected as a contact-lens prescription; listed by kind.
    const corrected = await request('PUT', O(`optical/prescriptions/${kavyaRx.id}`), { examinedOn: daysFrom(-215),
      lenses: [{ eye: 'right', baseCurve: '8.4', diameter: '14', power: '-2.00', modality: 'monthly' }, { eye: 'left', baseCurve: '8.4', diameter: '14', power: '-2.25', modality: 'monthly' }] });
    assert.equal(corrected.lenses.length, 2);
    assert.match((await audited('prescription.corrected', kavyaRx.id)).from.powers, /^R -2\.00 BC 8\.40 DIA 14\.00 Acuvue Oasys/);
    assert.deepEqual((await viewer.as('GET', O('optical/prescriptions?kind=contact_lens'))).items.map((p) => p.customer_name), ['Kavya Rao']);
  });

  // --- Contact lenses at the counter: MD-42, the prescription, toric and coloured grids, stock ----
  let acuvue, toric, dailies;
  await t.test('contact-lens grids for torics, multifocals and colours, with each power\'s stock', async () => {
    const grid = (body) => request('POST', O('optical/power-grid'), { unit: 'box', tracking: 'batch', taxRateId: gst5.id, hsnCode: '90013000', ...body }, 201);
    acuvue = await grid({ name: 'Acuvue Oasys (box of 6)', codePrefix: 'AOS', price: '2400', mrp: '2400', baseCurve: '8.4', diameter: '14', modality: 'monthly', lensesPerPack: '6',
      ranges: [{ from: '-1.00', to: '-3.00', step: '0.25' }] });
    assert.equal(acuvue.created, 9);
    toric = await grid({ name: 'Air Optix for Astigmatism', codePrefix: 'AOT', price: '1800', baseCurve: '8.7', diameter: '14.5', modality: 'monthly', lensesPerPack: '3',
      ranges: [{ from: '-1.00', to: '-2.00', step: '0.50' }], cylinders: ['-0.75', '-1.25'], axes: ['90', '180'] });
    assert.equal(toric.created, 12);
    assert.deepEqual([toric.items[0].code, toric.items[0].label, toric.items[0].cyl, toric.items[0].axis], ['AOT-M200-C075X090', 'Air Optix for Astigmatism · -2.00 / -0.75 × 90', '-0.75', '90']);
    const multifocal = await grid({ name: 'Biofinity Multifocal', codePrefix: 'BMF', price: '2100', baseCurve: '8.6', diameter: '14', ranges: [{ from: '-1.00', to: '-1.50', step: '0.50' }],
      adds: ['+1.00', '+2.00'] });
    assert.deepEqual(multifocal.items.map((s) => s.code), ['BMF-M150-A100', 'BMF-M150-A200', 'BMF-M100-A100', 'BMF-M100-A200']);
    const colours = await grid({ name: 'FreshLook Colors', codePrefix: 'FLC', price: '1500', baseCurve: '8.6', diameter: '14.5', ranges: [{ from: '0', to: '-1.00', step: '0.50' }],
      colours: ['Blue', 'Grey'] });
    assert.equal(colours.created, 6);
    assert.ok(colours.items.some((s) => s.label === 'FreshLook Colors · 0.00 · Grey' && s.code === 'FLC-000-GRE'));
    dailies = await grid({ name: 'Dailies AquaComfort (box of 30)', codePrefix: 'DAC', price: '1200', baseCurve: '8.7', diameter: '14', modality: 'daily', lensesPerPack: '30',
      tracking: 'quantity', ranges: [{ from: '-1.00', to: '-1.00' }] });
    // The same kind of lens for more powers; one request makes at most 600 items.
    await expectRefusal('POST', O('optical/power-grid'), { productId: toric.product.id, baseCurve: '8.7', diameter: '14.5', ranges: [{ from: '-3', to: '-3' }] }, 409, /is a toric lens: give its cylinders and axes/);
    await expectRefusal('POST', O('optical/power-grid'), { productId: acuvue.product.id, baseCurve: '8.4', diameter: '14', ranges: [{ from: '-4', to: '-4' }], colours: ['Blue'] }, 409,
      /is not a coloured lens/);
    await expectRefusal('POST', O('optical/power-grid'), { name: 'Huge', codePrefix: 'HG', unit: 'box', price: '10', taxRateId: gst5.id, baseCurve: '8.6', diameter: '14',
      ranges: [{ from: '-20', to: '+20' }], cylinders: ['-0.75', '-1.25', '-1.75', '-2.25'], axes: ['10', '90', '170', '180'] }, 400, /Make at most 600 items at a time/);
    await expectRefusal('POST', O('optical/power-grid'), { name: 'Half', codePrefix: 'HF', unit: 'box', price: '10', taxRateId: gst5.id, baseCurve: '8.6', diameter: '14',
      ranges: [{ from: '-1', to: '-1' }], cylinders: ['-0.75'] }, 400, /give both, or neither/);
    const more = await request('POST', O('optical/power-grid'), { productId: toric.product.id, baseCurve: '8.7', diameter: '14.5', ranges: [{ from: '-2.50', to: '-2.50' }],
      cylinders: ['-0.75'], axes: ['180'] }, 201);
    assert.deepEqual(more.items.map((s) => [s.code, s.cyl, s.axis]), [['AOT-M250-C075X180', '-0.75', '180']]);
    const item = await one("SELECT attributes FROM catalog_skus WHERE business_id=$1 AND code='AOT-M150-C075X180'", [optical.id]);
    assert.deepEqual(item.attributes, { power: '-1.50', baseCurve: '8.7', diameter: '14.5', cyl: '-0.75', axis: '180', modality: 'monthly', lensesPerPack: '3' });
    // Stock in, by batch, and the stock view shows each power held.
    const lens = (code) => one('SELECT id FROM catalog_skus WHERE business_id=$1 AND code=$2', [optical.id, code]);
    const aos200 = await lens('AOS-M200'), aos300 = await lens('AOS-M300'), aos150 = await lens('AOS-M150'), aos175 = await lens('AOS-M175'), aot = await lens('AOT-M150-C075X180');
    await purchase([{ skuId: aos200.id, quantity: '10', unitPrice: '1500', lotCode: 'AO-1', expiresOn: daysFrom(700) }, { skuId: aos300.id, quantity: '4', unitPrice: '1500', lotCode: 'AO-2', expiresOn: daysFrom(700) },
      { skuId: aos150.id, quantity: '3', unitPrice: '1500', lotCode: 'AO-3', expiresOn: daysFrom(700) }, { skuId: aos175.id, quantity: '3', unitPrice: '1500', lotCode: 'AO-4', expiresOn: daysFrom(700) },
      { skuId: aot.id, quantity: '2', unitPrice: '1100', lotCode: 'AT-9', expiresOn: daysFrom(500) }, { skuId: dailies.items[0].id, quantity: '5', unitPrice: '800' }]);
    const products = await keeper.as('GET', O('optical/lens-stock'));
    assert.deepEqual(products.filter((p) => Number(p.stock) > 0).map((p) => [p.name, Number(p.stock), p.powers_in_stock, p.toric]),
      [['Acuvue Oasys (box of 6)', 20, 4, false], ['Air Optix for Astigmatism', 2, 1, true], ['Dailies AquaComfort (box of 30)', 5, 1, false]]);
    const held = await keeper.as('GET', O(`optical/lens-stock/${toric.product.id}`));
    assert.deepEqual([held.toric, held.powers.length, held.powers.filter((p) => Number(p.stock) > 0).map((p) => [p.power, p.cyl, p.axis, Number(p.stock)])],
      [true, 13, [['-1.50', '-0.75', '180', 2]]]);
    await request('GET', `/businesses/${grocery.id}/optical/lens-stock`, undefined, 404);
    await other('GET', O('optical/lens-stock'), undefined, 404);
  });

  await t.test('the counter: contact lenses only under the MD-42 registration, checked against the prescription', async () => {
    const aos200 = await one("SELECT id FROM catalog_skus WHERE business_id=$1 AND code='AOS-M200'", [optical.id]);
    const aos300 = await one("SELECT id FROM catalog_skus WHERE business_id=$1 AND code='AOS-M300'", [optical.id]);
    const sale = (contactId, skuId, quantity = '1', lotCode = 'AO-1') => ({ kind: 'sale', requestKey: key(), locationId: shop.id, ...(contactId ? { contactId } : {}),
      lines: [{ skuId, quantity, lotCode }], payment: { amount: 'full', method: 'cash' } });
    await expectRefusal('POST', O('documents'), sale(kavya.id, aos200.id), 409,
      /Acuvue Oasys \(box of 6\) · -2\.00 is a contact lens, sold under an MD-42 registration, and Main store holds no medical device sale registration \(MD-42\)\. Add it under Settings › Licences \(switch on Licences & registrations in Settings › Business tools first\)/);
    // Not on the quote: the counter's figures come as before.
    await request('PUT', O('modules/licences'), { enabled: true });
    const licence = await request('POST', O('licences'), { locationId: shop.id, kind: 'md42', name: 'Medical device sale registration (MD-42)', licenceNo: 'MD42/TS/2025/0042',
      validFrom: daysFrom(-100), validUntil: daysFrom(-1) }, 201);
    await expectRefusal('POST', O('documents'), sale(kavya.id, aos200.id), 409, /\(MD42\/TS\/2025\/0042\) ran out on/);
    await pool.query('UPDATE business_licences SET valid_until=NULL WHERE id=$1', [licence.id]);
    // Her prescription's lens: no warning. Another power: a warning, the bill posted.
    const fine = await cashier.as('POST', O('documents'), sale(kavya.id, aos200.id), 201);
    assert.equal(fine.warnings, undefined);
    const off = await cashier.as('POST', O('documents'), sale(kavya.id, aos300.id, '1', 'AO-2'), 201);
    assert.match(off.warnings[0], /Acuvue Oasys \(box of 6\) · -3\.00 does not match Kavya Rao's contact-lens prescription of .* \(R -2\.00 BC 8\.4 DIA 14; L -2\.25 BC 8\.4 DIA 14\)\./);
    assert.ok((await audited('sale.posted', off.id)).warnings.length === 1, 'the warning is kept with the bill');
    const none = await cashier.as('POST', O('documents'), sale(meena.id, aos300.id, '1', 'AO-2'), 201);
    assert.match(none.warnings[0], /Meena Iyer has no contact-lens prescription in force: Acuvue Oasys \(box of 6\) · -3\.00 sold without one\./);
    const walkIn = await cashier.as('POST', O('documents'), sale(null, aos300.id, '1', 'AO-2'), 201);
    assert.match(walkIn.warnings[0], /sold without naming the customer: not checked/);
    // The batch of each unit sold stays on the bill line.
    assert.equal((await one('SELECT lot_code FROM business_document_lines WHERE document_id=$1', [fine.id])).lot_code, 'AO-1');
  });

  await t.test('replacement reminders: the lenses sold ÷ 2 eyes × the days one lasts, on the business\'s clock', async () => {
    const aos175 = await one("SELECT id FROM catalog_skus WHERE business_id=$1 AND code='AOS-M175'", [optical.id]);
    // Two boxes of 6 monthly lenses: 12 lenses ÷ 2 × 30 days = 180 days from the bill, sold at 00:30 on the business's clock 170 days ago.
    const bill = await cashier.as('POST', O('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: nisha.id, lines: [{ skuId: aos175.id, quantity: '2', lotCode: 'AO-4' }],
      payment: { amount: 'full', method: 'cash' } }, 201);
    await pool.query('UPDATE business_documents SET created_at=$2 WHERE id=$1', [bill.id, momentAt(daysFrom(-170), '00:30')]);
    // One box of 30 daily lenses: 30 ÷ 2 × 1 = 15 days, sold 20 days ago: run out.
    const daily = await cashier.as('POST', O('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: diya.id, lines: [{ skuId: dailies.items[0].id, quantity: '1' }],
      payment: { amount: 'full', method: 'cash' } }, 201);
    await pool.query('UPDATE business_documents SET created_at=$2 WHERE id=$1', [daily.id, momentAt(daysFrom(-20), '18:00')]);
    const due = await viewer.as('GET', O('optical/contact-lenses/due?due=true'));
    const of = (name) => due.items.find((r) => r.name === name);
    assert.deepEqual([of('Nisha Verma').sold_on, Number(of('Nisha Verma').lenses), of('Nisha Verma').days, of('Nisha Verma').due_on, of('Nisha Verma').days_left, of('Nisha Verma').run_out],
      [daysFrom(-170), 12, 30, daysFrom(10), 10, false]);
    assert.deepEqual([of('Diya Sharma').due_on, of('Diya Sharma').run_out], [addDays(daysFrom(-20), 15), true]);
    // Kavya's box of 6 monthly lenses (bought today) lasts 6 ÷ 2 × 30 = 90 days: not due yet.
    assert.ok(!of('Kavya Rao'));
    assert.equal((await viewer.as('GET', O('optical/contact-lenses/due'))).items.find((r) => r.name === 'Kavya Rao').due_on, addDays(today, 90));
    // A lens returned is not counted: one box back leaves 6 lenses, 90 days.
    const line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [bill.id]);
    await request('POST', O(`documents/${bill.id}/returns`), { requestKey: key(), reason: 'One box unopened', lines: [{ lineId: line.id, quantity: '1' }], refund: { method: 'cash' } }, 201);
    assert.equal((await viewer.as('GET', O('optical/contact-lenses/due'))).items.find((r) => r.name === 'Nisha Verma').due_on, addDays(daysFrom(-170), 90));
    // A reminder needs her consent to reminders, and is kept; someone who bought none is not reminded.
    await expectRefusal('POST', O(`optical/contact-lenses/${nisha.id}/reminders`), { channel: 'whatsapp' }, 409, /consent/i);
    await publishNotice(request, `/businesses/${optical.id}`);
    await giveConsent(request, `/businesses/${optical.id}`, nisha.id, ['reminders']);
    await viewer.as('POST', O(`optical/contact-lenses/${nisha.id}/reminders`), { channel: 'whatsapp' }, 201);
    assert.equal((await viewer.as('GET', O('optical/contact-lenses/due?reminded=true'))).items.map((r) => r.name).join(), 'Nisha Verma');
    await expectRefusal('POST', O(`optical/contact-lenses/${arjun.id}/reminders`), { channel: 'call' }, 409, /has bought no contact lenses here/);
    assert.ok(await audited('contact_lens.reminded', nisha.id));
    // The recall list's reminders are its own: the eye-test reminders do not count these.
    assert.equal((await one("SELECT count(*)::int AS n FROM optical_recall_reminders WHERE contact_id=$1 AND kind='contact_lens'", [nisha.id])).n, 1);
  });

  await t.test('free trials: given from stock with the batch, converted on payment or lapsed', async () => {
    const aos150 = await one("SELECT id FROM catalog_skus WHERE business_id=$1 AND code='AOS-M150'", [optical.id]);
    const aos175 = await one("SELECT id FROM catalog_skus WHERE business_id=$1 AND code='AOS-M175'", [optical.id]);
    const before = await stock(aos150.id);
    const body = { requestKey: key(), contactId: meena.id, locationId: shop.id, skuId: aos150.id, quantity: '1', days: '10', notes: 'Trying monthly lenses' };
    const trial = await cashier.as('POST', O('optical/contact-lenses/trials'), body, 201);
    assert.deepEqual([trial.status, trial.lot_code, Number(trial.quantity), trial.given_on, trial.ends_on, trial.given_by_name], ['given', 'AO-3', 1, today, addDays(today, 10), 'optmore-cashier']);
    assert.equal(await stock(aos150.id), before - 1);
    assert.equal((await one('SELECT reason FROM business_stock_adjustments a JOIN optical_contact_lens_trials t ON t.adjustment_id=a.id WHERE t.id=$1', [trial.id])).reason, 'Free trial for Meena Iyer');
    // A retry gives the same trial; the same key with other data is refused.
    assert.equal((await cashier.as('POST', O('optical/contact-lenses/trials'), body, 201)).id, trial.id);
    await expectRefusal('POST', O('optical/contact-lenses/trials'), { ...body, days: '12' }, 409, /already used for different data/);
    await expectRefusal('POST', O('optical/contact-lenses/trials'), { ...body, requestKey: key(), skuId: single.id }, 400, /is not a contact lens/);
    await expectRefusal('POST', O('optical/contact-lenses/trials'), { ...body, requestKey: key(), days: '0' }, 400, /A trial runs 1 to 60 days/);
    await viewer.as('POST', O('optical/contact-lenses/trials'), { ...body, requestKey: key() }, 403);
    // She pays for lenses of the same product: the trial is converted on that bill.
    const paid = await cashier.as('POST', O('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: meena.id, lines: [{ skuId: aos175.id, quantity: '1', lotCode: 'AO-4' }],
      payment: { amount: 'full', method: 'upi' } }, 201);
    const converted = (await viewer.as('GET', O(`optical/contact-lenses/trials?contact=${meena.id}`))).items[0];
    assert.deepEqual([converted.status, converted.document_no, converted.close_note], ['converted', paid.document_no, `Paid on bill ${paid.document_no}`]);
    assert.ok(await audited('contact_lens_trial.converted', trial.id));
    // Another trial lapses by hand; asking again is the same; it cannot then be converted.
    const second = await cashier.as('POST', O('optical/contact-lenses/trials'), { ...body, requestKey: key(), contactId: arjun.id, days: '7' }, 201);
    const lapsed = await cashier.as('POST', O(`optical/contact-lenses/trials/${second.id}/close`), { outcome: 'lapsed', note: 'Did not suit him' });
    assert.deepEqual([lapsed.status, lapsed.close_note], ['lapsed', 'Did not suit him']);
    assert.equal((await cashier.as('POST', O(`optical/contact-lenses/trials/${second.id}/close`), { outcome: 'lapsed' })).status, 'lapsed');
    await expectRefusal('POST', O(`optical/contact-lenses/trials/${second.id}/close`), { outcome: 'converted', documentId: paid.id }, 409, /was lapsed already/);
    await assert.rejects(pool.query('DELETE FROM optical_contact_lens_trials WHERE id=$1', [second.id]), /never deleted/);
    await assert.rejects(pool.query("UPDATE optical_contact_lens_trials SET notes='x' WHERE id=$1", [second.id]), /converted or lapses once/);
  });

  // --- Spectacle orders ---------------------------------------------------------------------------
  let progressiveOrder;
  await t.test('an order takes its lenses\' details from their items, the frame\'s size and the referring doctor', async () => {
    const body = { requestKey: key(), locationId: shop.id, prescriptionId: sureshRx.id, frame: { skuId: frame1.id },
      lenses: [{ eye: 'right', skuId: progressive.id }, { eye: 'left', skuId: progressive.id }], measurements: { ...measured, frameA: '52', frameB: '38', frameDbl: '18' },
      madeAt: 'lab', labName: 'Crystal Lens Lab', promisedOn: daysFrom(5), advance: { amount: '1000', method: 'cash' } };
    progressiveOrder = await request('POST', O('optical/orders'), body, 201);
    assert.deepEqual(progressiveOrder.lines.filter((l) => l.part === 'lens').map((l) => [l.eye, l.lens_type, l.lens_index, l.material, l.coatings]),
      [['right', 'progressive', '1.60', 'polycarbonate', ['anti_reflective', 'blue_cut']], ['left', 'progressive', '1.60', 'polycarbonate', ['anti_reflective', 'blue_cut']]]);
    assert.deepEqual([progressiveOrder.frame_a, progressiveOrder.frame_b, progressiveOrder.frame_dbl, progressiveOrder.total, progressiveOrder.rx.vertexDistance],
      ['52.0', '38.0', '18.0', '8499.00', '12.0']);
    // A detail typed that differs from the item's is refused; a lens with no item needs its type.
    await expectRefusal('POST', O('optical/orders/preview'), { ...body, lenses: [{ eye: 'right', skuId: progressive.id, index: '1.67' }] }, 400,
      /Right eye lens: Progressive 1\.60 poly AR blue-cut is of index 1\.60; the order takes the item's own/);
    await expectRefusal('POST', O('optical/orders/preview'), { ...body, lenses: [{ eye: 'right', skuId: progressive.id, lensType: 'bifocal' }] }, 400, /is a progressive lens/);
    await expectRefusal('POST', O('optical/orders/preview'), { ...body, lenses: [{ eye: 'right' }], items: [{ skuId: fitting.id }] }, 400, /Right eye lens: choose its type/);
    await expectRefusal('POST', O('optical/orders'), { ...body, requestKey: key(), measurements: { ...measured, frameDbl: '40' } }, 400, /Frame size DBL \(bridge\) must be from 10 to 30 mm/);
    // The referring doctor comes from the prescription unless the order names another.
    const referred = await request('POST', O('optical/orders'), { ...body, requestKey: key(), prescriptionId: rameshRx.id, frame: { ownFrame: true, description: 'Own frame' },
      lenses: [{ eye: 'right', skuId: single.id }, { eye: 'left', skuId: single.id }], measurements: measured, advance: undefined }, 201);
    assert.equal(referred.referred_by, 'Dr. Anil Kumar');
    const another = await request('POST', O('optical/orders'), { ...body, requestKey: key(), prescriptionId: rameshRx.id, frame: { ownFrame: true, description: 'Own frame' },
      lenses: [{ eye: 'right', skuId: single.id }], measurements: measured, advance: undefined, referredBy: 'Dr. Leela Menon' }, 201);
    assert.equal(another.referred_by, 'Dr. Leela Menon');
    // The frame's size changes with the details, kept in the activity log.
    const changed = await request('PATCH', O(`optical/orders/${progressiveOrder.id}`), { measurements: { ...measured, frameA: '54', frameB: '38', frameDbl: '18' } });
    assert.equal(changed.frame_a, '54.0');
    assert.deepEqual((await audited('spectacle_order.updated', progressiveOrder.id)).to, { frameA: '54.0' });
  });

  await t.test('the workshop in steps: cutting, edging and fitting, each with who did it, before the quality check', async () => {
    const order = await request('POST', O('optical/orders'), { requestKey: key(), locationId: shop.id, prescriptionId: sureshRx.id, frame: { skuId: frame1.id },
      lenses: [{ eye: 'right', skuId: single.id }, { eye: 'left', skuId: single.id }], measurements: measured, madeAt: 'in_house', promisedOn: daysFrom(2) }, 201);
    await expectRefusal('POST', O(`optical/orders/${order.id}/workshop`), { step: 'cutting' }, 409, /the workshop's steps are kept while it is in the workshop/);
    await move(keeper.as, order, 'in_workshop');
    await expectRefusal('POST', O(`optical/orders/${order.id}/status`), { status: 'quality_check' }, 409, /record its fitting before the quality check/);
    let now = await keeper.as('POST', O(`optical/orders/${order.id}/workshop`), { step: 'cutting' });
    assert.equal(now.workshop.next, 'edging');
    now = await keeper.as('POST', O(`optical/orders/${order.id}/workshop`), { step: 'edging', note: 'Edged on the auto edger' });
    // Asking again for a step done is the same step; an earlier one after a later one is refused.
    now = await keeper.as('POST', O(`optical/orders/${order.id}/workshop`), { step: 'edging' });
    assert.equal(now.workshop.steps.length, 2);
    now = await cashier.as('POST', O(`optical/orders/${order.id}/workshop`), { step: 'fitting' });
    assert.deepEqual(now.workshop.steps.map((s) => [s.step, s.by_name]), [['cutting', 'optmore-keeper'], ['edging', 'optmore-keeper'], ['fitting', 'optmore-cashier']]);
    assert.deepEqual([now.workshop.fitted, now.workshop.next], [true, null]);
    await viewer.as('POST', O(`optical/orders/${order.id}/workshop`), { step: 'fitting' }, 403);
    await move(keeper.as, order, 'quality_check');
    // Failed back to the workshop: a new visit, fitted again.
    await move(request, order, 'in_workshop', { note: 'Axis off' });
    await expectRefusal('POST', O(`optical/orders/${order.id}/status`), { status: 'quality_check' }, 409, /record its fitting/);
    now = await keeper.as('POST', O(`optical/orders/${order.id}/workshop`), { step: 'fitting' });
    assert.equal(now.workshop.steps.length, 1);
    // Lenses edged at the lab come back for fitting only; a step is never done after a later one.
    await expectRefusal('POST', O(`optical/orders/${order.id}/workshop`), { step: 'edging' }, 409, /Edging comes before fitting, which is done already/);
    await move(keeper.as, order, 'quality_check');
    assert.equal((await evented('spectacle_order.workshop_step', order.id)).step, 'fitting');
    await assert.rejects(pool.query("INSERT INTO optical_order_events(business_id,order_id,from_status,to_status,step,created_by) VALUES($1,$2,'booked','at_lab','cutting',$3)",
      [optical.id, order.id, ownerUser.id]), /check/);
  });

  // --- Changing a booked order, frames held, several advances --------------------------------------
  let meenaOrder;
  await t.test('a booked order\'s frame, lenses and prices are changed by someone who may manage orders, until the lab or the workshop', async () => {
    meenaOrder = await cashier.as('POST', O('optical/orders'), { requestKey: key(), locationId: shop.id, prescriptionId: meenaRx.id, frame: { skuId: frame1.id },
      lenses: [{ eye: 'right', skuId: single.id }, { eye: 'left', skuId: single.id }], measurements: { pdRight: '31', pdLeft: '31' }, madeAt: 'in_house', promisedOn: daysFrom(3),
      advance: { amount: '1000', method: 'cash' } }, 201);
    assert.equal(meenaOrder.total, '4499.00');
    const change = { frame: { skuId: frame2.id }, lenses: [{ eye: 'right', skuId: single.id }, { eye: 'left', skuId: single.id }], reason: 'Chose a lighter frame' };
    await cashier.as('POST', O(`optical/orders/${meenaOrder.id}/change`), change, 403);
    const changed = await manager.as('POST', O(`optical/orders/${meenaOrder.id}/change`), change);
    assert.deepEqual([changed.total, changed.lines[0].sku_id, changed.lines.length, changed.status], ['3999.00', frame2.id, 3, 'booked']);
    const log = await audited('spectacle_order.changed', meenaOrder.id);
    assert.deepEqual([log.reason, log.from.total, log.to.total, log.from.lines[0], log.to.lines[0]], ['Chose a lighter frame', '4499.00', '3999.00', 'frame: Titan TE-2001 black', 'frame: Fastrack FT-77 blue']);
    assert.match(changed.events.at(-1).note, /^Frame and lenses changed: Chose a lighter frame/);
    assert.deepEqual((await evented('spectacle_order.changed', meenaOrder.id)).to, '3999.00');
    // The same change again is the same order, kept once.
    await manager.as('POST', O(`optical/orders/${meenaOrder.id}/change`), change);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_audit WHERE action='spectacle_order.changed' AND entity_id=$1", [meenaOrder.id])).n, 1);
    // Never below the advances taken.
    await manager.as('POST', O(`optical/orders/${meenaOrder.id}/advances`), { requestKey: key(), amount: '2500', method: 'upi', reference: 'UPI-77' }, 201);
    await expectRefusal('POST', O(`optical/orders/${meenaOrder.id}/change`), { frame: { ownFrame: true, description: 'Own frame' }, lenses: [{ eye: 'right', skuId: single.id }] }, 409,
      /advances taken on SPO\/\d+\/\d+ \(3500\.00\) come to more than the new total of 1000\.00/);
    // Once it goes to the workshop, it is not changed; the database holds its prices.
    await move(keeper.as, meenaOrder, 'in_workshop');
    await expectRefusal('POST', O(`optical/orders/${meenaOrder.id}/change`), change, 409, /change only while it is booked, before it goes to the lab or the workshop/);
    await assert.rejects(pool.query('UPDATE optical_orders SET total=1 WHERE id=$1', [meenaOrder.id]), /keeps its prices once it has gone to the lab or the workshop/);
    await assert.rejects(pool.query('DELETE FROM optical_order_lines WHERE order_id=$1', [meenaOrder.id]), /kept as they were booked/);
  });

  await t.test('several advances: each a receipt, together within the total, all taken off the bill', async () => {
    const order = meenaOrder;
    const body = { requestKey: key(), amount: '400', method: 'cash' };
    const now = await cashier.as('POST', O(`optical/orders/${order.id}/advances`), body, 201);
    assert.deepEqual([now.advances.length, now.advance.amount, now.advance.free], [3, '3900.00', '3900.00']);
    // A retry is the same advance; the same key for another amount is refused.
    assert.equal((await cashier.as('POST', O(`optical/orders/${order.id}/advances`), body, 201)).advances.length, 3);
    await expectRefusal('POST', O(`optical/orders/${order.id}/advances`), { ...body, amount: '450' }, 409, /already used for different data/);
    await expectRefusal('POST', O(`optical/orders/${order.id}/advances`), { requestKey: key(), amount: '200', method: 'cash' }, 400, /at most 99\.00 more/);
    await keeper.as('POST', O(`optical/orders/${order.id}/advances`), { requestKey: key(), amount: '10', method: 'cash' }, 403);
    const listed = (await cashier.as('GET', O(`optical/orders?contact=${meena.id}`))).items.find((o) => o.id === order.id);
    assert.deepEqual([listed.advance, listed.advances_taken, listed.balance], [3900, 3, 99]);
    // Delivered: the three advances pay first, oldest first; 99 is paid now.
    await keeper.as('POST', O(`optical/orders/${order.id}/workshop`), { step: 'fitting' });
    await move(keeper.as, order, 'quality_check');
    await move(request, order, 'ready');
    const delivered = await cashier.as('POST', O(`optical/orders/${order.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const payments = await rows('SELECT amount,collection_id FROM business_payments WHERE document_id=$1 ORDER BY id', [delivered.document_id]);
    assert.deepEqual(payments.map((p) => [p.amount, p.collection_id === null]), [['99.00', true], ['1000.00', false], ['2500.00', false], ['400.00', false]]);
    assert.equal(payments.reduce((s, p) => s + paise(p.amount), 0), paise(delivered.bill_total));
    assert.equal(delivered.advance.free, '0.00');
    await assert.rejects(pool.query('DELETE FROM optical_order_advances WHERE order_id=$1', [order.id]), /kept as they were taken/);
    // A cancelled order's advances: the one named is handed back.
    const cancelledOne = await cashier.as('POST', O('optical/orders'), { requestKey: key(), locationId: shop.id, prescriptionId: meenaRx.id, frame: { ownFrame: true, description: 'Own' },
      lenses: [{ eye: 'right', skuId: single.id }], measurements: { pdRight: '31' }, madeAt: 'in_house', promisedOn: daysFrom(3), advance: { amount: '300', method: 'cash' } }, 201);
    const withSecond = await cashier.as('POST', O(`optical/orders/${cancelledOne.id}/advances`), { requestKey: key(), amount: '200', method: 'upi', reference: 'UPI-9' }, 201);
    await request('POST', O(`optical/orders/${cancelledOne.id}/cancel`), { reason: 'Changed her mind' });
    await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
    const refund = await cashier.as('POST', O(`optical/orders/${cancelledOne.id}/advance-refund`), { collectionId: withSecond.advances[1].id, method: 'upi', reference: 'UPI-R1',
      reason: 'Order cancelled', approverId: ownerUser.id, pin: '2468', requestKey: key() }, 201);
    assert.deepEqual([refund.amount, refund.collection_id, refund.left], ['200.00', withSecond.advances[1].id, '0.00']);
    const left = await request('GET', O(`optical/orders/${cancelledOne.id}`));
    assert.deepEqual([left.advance.free, left.advances.map((a) => a.free)], ['300.00', ['300.00', '0.00']]);
  });

  await t.test('a frame held in stock for an order: no bill, adjustment or count takes it until it is released or delivered', async () => {
    const held = await cashier.as('POST', O('optical/orders'), { requestKey: key(), locationId: shop.id, prescriptionId: rameshRx.id, frame: { skuId: frame3.id },
      lenses: [{ eye: 'right', skuId: single.id }], measurements: { pdRight: '32' }, madeAt: 'in_house', promisedOn: daysFrom(4), holdFrame: true }, 201);
    assert.deepEqual([held.hold.status, held.hold.held_by_name], ['held', 'optmore-cashier']);
    assert.match(held.events[0].note, /frame held in stock/);
    // The last one of that frame: the counter, an adjustment and another order's hold cannot take it.
    const sale = { kind: 'sale', requestKey: key(), locationId: shop.id, lines: [{ skuId: frame3.id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } };
    await expectRefusal('POST', O('documents'), sale, 409, /Ray-Ban RB-3025 gold is held here for spectacle order SPO\/\d+\/\d+: release the hold on the order first/);
    const lot = await one('SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [optical.id, frame3.id]);
    await expectRefusal('POST', O(`stock/${lot.id}/adjustments`), { quantity: '-1', reason: 'Damaged', requestKey: key() }, 409, /is held here for spectacle order/);
    await expectRefusal('POST', O('optical/orders'), { requestKey: key(), locationId: shop.id, prescriptionId: rameshRx.id, frame: { skuId: frame3.id },
      lenses: [{ eye: 'right', skuId: single.id }], measurements: { pdRight: '32' }, madeAt: 'in_house', promisedOn: daysFrom(4), holdFrame: true }, 409, /No Ray-Ban RB-3025 gold is free in stock here/);
    assert.equal(Number((await request('GET', O(`optical/orders/${held.id}`))).lines[0].in_stock), 1, 'its own hold is its stock');
    // Asking to hold it again changes nothing; released by hand, then held again.
    await cashier.as('POST', O(`optical/orders/${held.id}/frame-hold`), { hold: true });
    assert.equal((await one("SELECT count(*)::int AS n FROM optical_frame_holds WHERE order_id=$1", [held.id])).n, 1);
    const released = await cashier.as('POST', O(`optical/orders/${held.id}/frame-hold`), { hold: false, reason: 'Customer may choose another' });
    assert.deepEqual([released.hold.status, released.hold.close_reason], ['released', 'Customer may choose another']);
    const again = await cashier.as('POST', O(`optical/orders/${held.id}/frame-hold`), { hold: true });
    assert.equal(again.hold.status, 'held');
    assert.ok(await audited('spectacle_order.frame_held', held.id));
    // Changing the frame of a booked order releases its hold.
    const changed = await request('POST', O(`optical/orders/${held.id}/change`), { frame: { skuId: frame1.id }, lenses: [{ eye: 'right', skuId: single.id }] });
    assert.deepEqual([changed.hold.status, changed.hold.close_reason], ['released', 'Frame changed']);
    await request('POST', O(`optical/orders/${held.id}/change`), { frame: { skuId: frame3.id }, lenses: [{ eye: 'right', skuId: single.id }] });
    await cashier.as('POST', O(`optical/orders/${held.id}/frame-hold`), { hold: true });
    // Delivered: the held frame leaves on the bill, from its lot.
    await move(keeper.as, held, 'in_workshop');
    await keeper.as('POST', O(`optical/orders/${held.id}/workshop`), { step: 'fitting' });
    await move(keeper.as, held, 'quality_check');
    await move(request, held, 'ready');
    const done = await cashier.as('POST', O(`optical/orders/${held.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'card', reference: 'C-1' } });
    assert.deepEqual([done.hold.status, await stock(frame3.id)], ['delivered', 0]);
    await assert.rejects(pool.query("UPDATE optical_frame_holds SET status='held',closed_at=NULL,closed_by=NULL WHERE order_id=$1", [held.id]), /released or delivered once/);
    // A cancelled order's held frame goes back to stock.
    await purchase([{ skuId: frame3.id, quantity: '1', unitPrice: '3000' }]);
    const cancelled = await cashier.as('POST', O('optical/orders'), { requestKey: key(), locationId: shop.id, prescriptionId: rameshRx.id, frame: { skuId: frame3.id },
      lenses: [{ eye: 'right', skuId: single.id }], measurements: { pdRight: '32' }, madeAt: 'in_house', promisedOn: daysFrom(4), holdFrame: true }, 201);
    await request('POST', O(`optical/orders/${cancelled.id}/cancel`), { reason: 'Not wanted' });
    await cashier.as('POST', O('documents'), { ...sale, requestKey: key() }, 201);
  });

  // --- Warranty dates and warranty remakes ----------------------------------------------------------
  await t.test('warranty dates per lens and coating, and a remake under warranty free by the shop\'s rule', async () => {
    await viewer.as('PUT', O('optical/settings'), { lensWarrantyMonths: 12 }, 403);
    await expectRefusal('PUT', O('optical/settings'), { coatingWarrantyMonths: 61 }, 400, /The coating warranty is 1 to 60 whole months/);
    const settings = await request('PUT', O('optical/settings'), { lensWarrantyMonths: 12, coatingWarrantyMonths: 6 });
    assert.deepEqual([settings.lens_warranty_months, settings.coating_warranty_months, settings.warranty_remakes, settings.recall_months], [12, 6, 'free', 12]);
    // Delivered: each lens's warranty from today, and its coatings'.
    const order = progressiveOrder;
    await move(keeper.as, order, 'at_lab', { labOrderNo: 'CL-1' });
    await move(keeper.as, order, 'quality_check');
    await move(request, order, 'ready');
    const delivered = await cashier.as('POST', O(`optical/orders/${order.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    assert.deepEqual(delivered.lines.filter((l) => l.part === 'lens').map((l) => [l.warranty_until, l.coating_warranty_until]),
      [[addMonths(today, 12), addMonths(today, 6)], [addMonths(today, 12), addMonths(today, 6)]]);
    assert.equal(delivered.lines[0].warranty_until, null, 'a frame has no lens warranty');
    await assert.rejects(pool.query("UPDATE optical_order_lines SET warranty_until=NULL WHERE order_id=$1 AND part='lens'", [order.id]), /kept as they were booked/);
    // A coating peeled within its warranty: by the shop's rule the customer pays nothing.
    const remake = (reason, costBy) => ({ requestKey: key(), locationId: shop.id, prescriptionId: sureshRx.id, frame: { ownFrame: true, description: 'Frame of the order' },
      lenses: [{ eye: 'right', skuId: progressive.id }, { eye: 'left', skuId: progressive.id }], measurements: measured, madeAt: 'lab', labName: 'Crystal Lens Lab',
      promisedOn: daysFrom(5), remake: { orderId: order.id, reason, costBy } });
    await expectRefusal('POST', O('optical/orders'), remake('coating', 'customer'), 409,
      new RegExp(`The coating warranty of ${order.order_no.replace(/\//g, '\\/')} runs to .*: by the shop's rule a remake under warranty costs the customer nothing`));
    const free = await request('POST', O('optical/orders'), remake('coating', 'shop'), 201);
    assert.deepEqual([free.total, free.remake_under_warranty], ['0.00', true]);
    assert.match(free.events[0].note, /under warranty/);
    // Charged by the shop's rule; a power change is no warranty matter.
    await request('PUT', O('optical/settings'), { warrantyRemakes: 'charged' });
    const charged = await request('POST', O('optical/orders'), remake('lab_defect', 'customer'), 201);
    assert.deepEqual([charged.total, charged.remake_under_warranty], ['6000.00', true]);
    const power = await request('POST', O('optical/orders'), remake('power_change', 'customer'), 201);
    assert.equal(power.remake_under_warranty, false);
    for (const o of [charged, power]) await request('POST', O(`optical/orders/${o.id}/cancel`), { reason: 'Checked the rule' });
    assert.deepEqual((await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='optical_settings.updated' ORDER BY id DESC LIMIT 1", [optical.id])).details,
      { from: { warrantyRemakes: 'free' }, to: { warrantyRemakes: 'charged' } });
  });

  // --- Eye tests and quotations -----------------------------------------------------------------------
  await t.test('an eye-test booking, done, opens a prescription for its customer', async () => {
    const room = await request('POST', O('resources'), { locationId: shop.id, name: 'Test room 1', roleLabel: 'Optometrist' }, 201);
    const test = await request('POST', O('catalog'), { kind: 'service', unit: 'service', name: 'Eye test', code: 'SV-EYE', price: '0', taxRateId: gst18.id }, 201);
    const booking = await request('POST', O('appointments'), { resourceId: room.id, contactId: arjun.id, skuId: test.id, startsAt: momentAt(daysFrom(-1), '10:00'),
      endsAt: momentAt(daysFrom(-1), '10:30') }, 201);
    const body = { requestKey: key(), contactId: arjun.id, appointmentId: booking.id, ageYears: '10', rows: spectacleRows.slice(0, 2) };
    await expectRefusal('POST', O('optical/prescriptions'), body, 409, /Mark the eye-test booking done first/);
    await request('PATCH', O(`appointments/${booking.id}`), { status: 'completed' });
    const rx = await request('POST', O('optical/prescriptions'), { ...body, requestKey: key() }, 201);
    assert.deepEqual([rx.appointment_id, rx.age_years], [booking.id, 10]);
    assert.equal((await audited('prescription.recorded', rx.id)).appointmentId, Number(booking.id));
    await expectRefusal('POST', O('optical/prescriptions'), { ...body, requestKey: key() }, 409, /already has its spectacle prescription: correct that one instead/);
    await expectRefusal('POST', O('optical/prescriptions'), { ...body, requestKey: key(), contactId: meena.id }, 409, /another customer's/);
    // Its contact-lens prescription may come from the same test.
    await request('POST', O('optical/prescriptions'), { requestKey: key(), kind: 'contact_lens', contactId: arjun.id, appointmentId: booking.id,
      lenses: [{ eye: 'right', baseCurve: '8.6', diameter: '14', power: '-1.00' }] }, 201);
    await expectRefusal('PUT', O(`optical/prescriptions/${rx.id}`), { contactId: meena.id, rows: spectacleRows.slice(0, 2) }, 400, /stays with that booking's customer/);
  });

  await t.test('a quotation becomes a spectacle order at its prices, and is closed as booked', async () => {
    const quote = await request('POST', O('quotations'), { requestKey: key(), locationId: shop.id, contactId: meena.id, validUntil: daysFrom(10),
      lines: [{ skuId: frame2.id, quantity: '1' }, { skuId: single.id, quantity: '1' }, { skuId: single.id, quantity: '1' }, { skuId: fitting.id, quantity: '1' }] }, 201);
    assert.equal(quote.total, '4099.00');
    const [f, r, l] = quote.lines;
    const body = { requestKey: key(), locationId: shop.id, prescriptionId: meenaRx.id, quotationId: quote.id, frame: { quotationLineId: f.id },
      lenses: [{ eye: 'right', quotationLineId: r.id }, { eye: 'left', quotationLineId: l.id }], measurements: { pdRight: '31', pdLeft: '31' }, madeAt: 'in_house', promisedOn: daysFrom(3) };
    // Its own customer's prescription; its lines once; no discount of its own.
    await expectRefusal('POST', O('optical/orders'), { ...body, requestKey: key(), prescriptionId: sureshRx.id }, 409, /another customer's/);
    await expectRefusal('POST', O('optical/orders'), { ...body, requestKey: key(), lenses: [{ eye: 'right', quotationLineId: r.id }, { eye: 'left', quotationLineId: r.id }] }, 400, /goes on the order once/);
    await expectRefusal('POST', O('optical/orders'), { ...body, requestKey: key(), discount: { amount: '50', reason: 'x' } }, 400, /takes its items, prices and discount/);
    await viewer.as('POST', O('optical/orders'), body, 403);
    const order = await request('POST', O('optical/orders'), body, 201);
    assert.deepEqual([order.total, order.quotation_no, order.lines.map((l) => [l.part, l.sku_id, l.net])], [quote.total, quote.quotation_no,
      [['frame', frame2.id, f.net], ['lens', single.id, r.net], ['lens', single.id, l.net], ['item', fitting.id, quote.lines[3].net]]]);
    assert.deepEqual(order.lines.filter((x) => x.part === 'lens').map((x) => x.lens_type), ['single_vision', 'single_vision']);
    const closed = await request('GET', O(`quotations/${quote.id}`));
    assert.deepEqual([closed.status, closed.spectacle_order_no], ['booked', order.order_no]);
    assert.equal((await evented('quotation.booked', quote.id)).orderNo, order.order_no);
    // A retry is the same order; booked again, or cancelled, it is refused.
    assert.equal((await request('POST', O('optical/orders'), body, 201)).id, order.id);
    await expectRefusal('POST', O('optical/orders'), { ...body, requestKey: key() }, 409, new RegExp(`is on spectacle order ${order.order_no.replace(/\//g, '\\/')}`));
    await expectRefusal('POST', O(`quotations/${quote.id}/cancel`), { reason: 'x' }, 409, /Cancel the spectacle order instead/);
    // A line of two units is not one lens.
    const two = await request('POST', O('quotations'), { requestKey: key(), locationId: shop.id, contactId: meena.id, validUntil: daysFrom(10),
      lines: [{ skuId: frame2.id, quantity: '1' }, { skuId: single.id, quantity: '2' }] }, 201);
    await expectRefusal('POST', O('optical/orders'), { ...body, requestKey: key(), quotationId: two.id, frame: { quotationLineId: two.lines[0].id },
      lenses: [{ eye: 'right', quotationLineId: two.lines[1].id }] }, 400, /goes on the order as another item/);
    await request('POST', O(`optical/orders/${order.id}/cancel`), { reason: 'Test of the quotation' });
  });

  // --- Recall by group and the referral report ---------------------------------------------------------
  await t.test('recall intervals by group: children, contact-lens wearers and progressive wearers', async () => {
    await prescribe(diya.id, { examinedOn: daysFrom(-215), ageYears: '9' });
    // With the shop's 12 months nobody tested 7 months ago is due; Suresh's 10-month-old test is not either.
    let recall = await viewer.as('GET', O('optical/recall'));
    assert.deepEqual(recall.items.map((r) => r.name), []);
    await expectRefusal('PUT', O('optical/settings'), { recallMonthsChild: 'six' }, 400, /A child is due for an eye test after is 1 to 60 whole months/);
    const saved = await request('PUT', O('optical/settings'), { recallMonthsChild: 6, recallMonthsContactLens: 6, recallMonthsProgressive: 9 });
    assert.deepEqual([saved.recall_months_child, saved.recall_months_contact_lens, saved.recall_months_progressive, saved.lens_warranty_months], [6, 6, 9, 12]);
    recall = await viewer.as('GET', O('optical/recall'));
    const due = Object.fromEntries(recall.items.map((r) => [r.name, [r.months, r.child, r.lens_wearer, r.progressive, r.due_on]]));
    assert.deepEqual(due, {
      'Kavya Rao': [6, false, true, false, addMonths(daysFrom(-215), 6)],
      'Diya Sharma': [6, true, false, false, addMonths(daysFrom(-215), 6)],
      'Suresh Babu': [9, false, false, true, addMonths(daysFrom(-305), 9)],
    });
    assert.equal((await viewer.as('GET', O('optical/recall?child=true'))).items[0].name, 'Diya Sharma');
    // Meena (an adult, no group) keeps the shop's 12 months; her history says so.
    const history = await viewer.as('GET', O(`optical/customers/${meena.id}`));
    assert.deepEqual([history.recall.months, history.recall.groups, history.recall.due_on], [12, [], addMonths(daysFrom(-215), 12)]);
    assert.deepEqual((await viewer.as('GET', O(`optical/customers/${suresh.id}`))).recall.groups, ['progressive wearer']);
    // A group's months cleared: the shop's months again.
    await request('PUT', O('optical/settings'), { recallMonthsProgressive: '' });
    assert.ok(!(await viewer.as('GET', O('optical/recall'))).items.some((r) => r.name === 'Suresh Babu'));
  });

  await t.test('the referral report: each doctor\'s prescriptions, customers and orders in the dates chosen', async () => {
    await request('POST', O('optical/prescriptions'), { requestKey: key(), kind: 'contact_lens', contactId: ramesh.id, referredBy: 'dr. anil  kumar',
      lenses: [{ eye: 'right', baseCurve: '8.6', diameter: '14', power: '-1.00' }] }, 201);
    const report = await request('GET', O(`optical/referrals?from=${today}&to=${today}`));
    const anil = report.rows.find((r) => r.doctor === 'dr. anil  kumar' || r.doctor === 'Dr. Anil Kumar');
    const leela = report.rows.find((r) => r.doctor === 'Dr. Leela Menon');
    const rameshOrders = await rows("SELECT total,status FROM optical_orders WHERE business_id=$1 AND referred_by ILIKE 'dr. anil%'", [optical.id]);
    assert.deepEqual([anil.prescriptions, anil.contact_lens_prescriptions, anil.customers, anil.orders, anil.delivered],
      [1, 1, 1, rameshOrders.filter((o) => o.status !== 'cancelled').length, rameshOrders.filter((o) => o.status === 'delivered').length]);
    assert.ok(anil.orders >= 2 && anil.delivered === 1, 'the referred orders, and the one delivered');
    assert.equal(paise(anil.booked_value), rameshOrders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + paise(o.total), 0));
    assert.deepEqual([leela.prescriptions, leela.orders, report.totals.doctors, report.money], [0, 1, 2, true]);
    // Someone who does not see sales sees the counts without the money; another day has none.
    const seen = await optometrist.as('GET', O(`optical/referrals?from=${today}&to=${today}`));
    assert.deepEqual([seen.money, seen.rows[0].booked_value, seen.totals.billed], [false, null, null]);
    assert.equal((await request('GET', O(`optical/referrals?from=${daysFrom(-40)}&to=${daysFrom(-30)}`))).rows.length, 0);
    await expectRefusal('GET', O(`optical/referrals?from=${today}&to=${daysFrom(-1)}`), undefined, 400, /end date is before the start date/);
    await request('GET', `/businesses/${grocery.id}/optical/referrals`, undefined, 403);
    await other('GET', O('optical/referrals'), undefined, 404);
    await other('GET', `/businesses/${elsewhere.id}/optical/contact-lenses/due`);
  });

  await t.test('who may do what, and other types', async () => {
    const grants = async (template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2 AND rp.permission_code='optical.manage'`, [optical.id, template])).p;
    assert.deepEqual(await grants('manager'), ['optical.manage']);
    for (const template of ['cashier', 'stock_keeper', 'accountant', 'viewer', 'optometrist']) assert.deepEqual(await grants(template), [], `${template} does not change booked orders`);
    assert.deepEqual((await one("SELECT array_agg(permission_code) AS p FROM business_role_template_permissions WHERE permission_code='optical.manage'")).p, ['optical.manage'].map(() => 'optical.manage'));
    await request('POST', `/businesses/${grocery.id}/optical/contact-lenses/trials`, {}, 403);
    await request('GET', `/businesses/${grocery.id}/optical/lens-stock`, undefined, 404);
    await other('POST', O(`optical/orders/${meenaOrder.id}/advances`), { requestKey: key(), amount: '1', method: 'cash' }, 404);
  });
});
