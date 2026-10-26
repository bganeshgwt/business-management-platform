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

// The optical shop's own tools: prescriptions (powers per eye checked, kept
// unchanged once an order uses them, history per customer), spectacle orders
// (the core's prices at booking, the advance, the lab and workshop steps, the
// quality check, delivery billed through the core with the advance taken off,
// cancellation with the advance handed back, remakes), the recall list and
// the contact-lens power grid. Money to the paisa, idempotent postings, the
// rules the database keeps, audit and events, other types and other owners.
// Runs on its own throwaway database with every migration applied.
test('the optical shop', { timeout: 300000 }, async (t) => {
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
  const password = `Optical-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('optical-owner');
  await owner('optical-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(await login('optical-owner@test.invalid'));
  const other = as(await login('optical-other@test.invalid'));

  const [made, grocery, fashion] = await createBusinesses(request, 'OWNER', ['optical', 'grocery', 'fashion']);
  // The optician also keeps contact-lens batches, frame variants and eye-test bookings (recommended tools).
  const [optical] = await withTools(request, [made]);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['optical']);

  await t.test('modules, permissions and roles per type', async () => {
    assert.ok(made.capabilities.includes('optical'), 'an optical shop starts with prescriptions & spectacle orders');
    for (const business of [grocery, fashion]) assert.ok(!business.capabilities.includes('optical'), `${business.business_type} has no optical tools`);
    const tools = await request('GET', `/businesses/${optical.id}/modules`);
    const module = tools.find((m) => m.code === 'optical');
    assert.equal(module.name, 'Prescriptions & spectacle orders');
    assert.deepEqual([...module.requires].sort(), ['catalog', 'contacts', 'sales']);
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'optical'), 'a grocery is not offered the optical tools');
    await request('PUT', `/businesses/${grocery.id}/modules/optical`, { enabled: true }, 409);
    // The sales module stays on while the optical tools need it.
    await request('PUT', `/businesses/${optical.id}/modules/sales`, { enabled: false }, 409);
    const permissions = await rows("SELECT code FROM business_permissions WHERE module_code='optical' ORDER BY sort_order");
    assert.deepEqual(permissions.map((p) => p.code), ['optical.view', 'optical.create', 'optical.edit', 'optical.approve', 'optical.cancel', 'optical.print']);
    // The optometrist: an optical shop's own role, with no money.
    const roles = (await request('GET', `/businesses/${optical.id}/roles?limit=100`)).items;
    const optometrist = roles.find((r) => r.template_code === 'optometrist');
    assert.ok(optometrist, 'an optical shop has the optometrist role');
    assert.equal(optometrist.name, 'Optometrist');
    for (const business of [grocery, fashion]) {
      assert.ok(!(await request('GET', `/businesses/${business.id}/roles?limit=100`)).items.some((r) => r.template_code === 'optometrist'), `${business.business_type} has no optometrist`);
    }
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2`, [business.id, template])).p;
    const opticalGrants = async (business, template) => (await grants(business, template)).filter((p) => p.startsWith('optical.'));
    assert.deepEqual(await grants(optical, 'optometrist'), ['appointments.create', 'appointments.edit', 'appointments.view', 'catalog.view', 'contacts.create', 'contacts.view',
      'optical.approve', 'optical.create', 'optical.print', 'optical.view']);
    assert.ok(!(await grants(optical, 'optometrist')).some((p) => /^(sales|receivables|purchasing)\./.test(p)), 'the optometrist takes no money');
    assert.deepEqual(await opticalGrants(optical, 'manager'), ['optical.approve', 'optical.cancel', 'optical.create', 'optical.edit', 'optical.print', 'optical.view']);
    assert.deepEqual(await opticalGrants(optical, 'cashier'), ['optical.create', 'optical.edit', 'optical.print', 'optical.view']);
    assert.deepEqual(await opticalGrants(optical, 'stock_keeper'), ['optical.edit', 'optical.view']);
    assert.deepEqual(await opticalGrants(optical, 'accountant'), ['optical.print', 'optical.view']);
    assert.deepEqual(await opticalGrants(optical, 'viewer'), ['optical.view']);
    assert.deepEqual(await opticalGrants(grocery, 'viewer'), ['optical.view'], 'role copies match their templates everywhere');
    // Spectacle orders are numbered documents of their own.
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'")).d.includes("'spectacle_order'"));
  });

  await t.test('the database keeps a prescription\'s powers within their rules', async () => {
    const customer = await request('POST', `/businesses/${optical.id}/contacts`, { kind: 'customer', name: 'Rule Check', phone: '9000000001' }, 201);
    const prescription = await one(`INSERT INTO optical_prescriptions(business_id,contact_id,examined_on,examiner_kind,examiner_user_id,examiner_name,valid_until,request_key,request_hash,created_by)
      VALUES($1,$2,$3,'staff',$4,'Owner',$5,$6,$7,$4) RETURNING id`, [optical.id, customer.id, daysFrom(0), ownerUser.id, daysFrom(365), crypto.randomUUID(), 'x'.repeat(64)]);
    const row = (values) => pool.query(`INSERT INTO optical_prescription_rows(business_id,prescription_id,eye,zone,sph,cyl,axis,add_power,prism,prism_base,acuity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [optical.id, prescription.id, ...values]);
    await row(['right', 'distance', '-2.25', '-0.75', 180, null, null, null, '6/6']);
    // A CYL needs its AXIS, and no AXIS without one; steps of 0.25; ADD only for near; a prism with its base.
    await assert.rejects(row(['left', 'distance', '-2.00', '-0.50', null, null, null, null, null]), /check/);
    await assert.rejects(row(['left', 'distance', '-2.00', null, 90, null, null, null, null]), /check/);
    await assert.rejects(row(['left', 'distance', '-2.10', null, null, null, null, null, null]), /check/);
    await assert.rejects(row(['left', 'distance', '-2.00', null, null, '2.00', null, null, null]), /check/);
    await assert.rejects(row(['left', 'near', null, null, null, '4.25', null, null, null]), /check/);
    await assert.rejects(row(['left', 'distance', '-2.00', null, null, null, '1.00', null, null]), /check/);
    await assert.rejects(row(['left', 'distance', '-31.00', null, null, null, null, null, null]), /check/);
    await row(['left', 'near', null, null, null, '2.00', null, null, 'N6']);
    // An outside prescriber is named with a registration number.
    await assert.rejects(pool.query(`INSERT INTO optical_prescriptions(business_id,contact_id,examined_on,examiner_kind,examiner_name,valid_until,request_key,request_hash,created_by)
      VALUES($1,$2,$3,'outside','Dr Rao',$4,$5,$6,$7)`, [optical.id, customer.id, daysFrom(0), daysFrom(365), crypto.randomUUID(), 'x'.repeat(64), ownerUser.id]), /check/);
    // Never deleted.
    await assert.rejects(pool.query('DELETE FROM optical_prescriptions WHERE id=$1', [prescription.id]), /never deleted/);
    // A supplier is not a customer with a prescription.
    const supplier = await request('POST', `/businesses/${optical.id}/contacts`, { kind: 'supplier', name: 'Lens Lab' }, 201);
    await assert.rejects(pool.query(`INSERT INTO optical_prescriptions(business_id,contact_id,examined_on,examiner_kind,examiner_user_id,examiner_name,valid_until,request_key,request_hash,created_by)
      VALUES($1,$2,$3,'staff',$4,'Owner',$5,$6,$7,$4)`, [optical.id, supplier.id, daysFrom(0), ownerUser.id, daysFrom(365), crypto.randomUUID(), 'x'.repeat(64)]), /Choose a customer/);
    // Another owner's optical shop is a business of its own.
    assert.notEqual(String(elsewhere.id), String(optical.id));
  });

  // --- Shared set-up: the shop, its slabs, its staff, its customers -----------------------------
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const O = (suffix) => `/businesses/${optical.id}/${suffix}`;
  const ownerToken = await login('optical-owner@test.invalid');
  const refused = async (method, route, body) => {
    const result = await call(method, route, body, ownerToken);
    return { status: result.status, message: result.body.message };
  };
  const today = daysFrom(0);
  // The same day so many months on (the month's last day when it has fewer days).
  const addMonths = (day, months) => {
    const [y, m, d] = day.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    target.setUTCDate(Math.min(d, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
    return target.toISOString().slice(0, 10);
  };
  const shop = (await request('GET', O('locations'))).items[0];
  const slabs = (await request('GET', O('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const roles = (await request('GET', O('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', O('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    return as(await login(email));
  }
  const cashier = await staff('optical-cashier@test.invalid', 'cashier');
  const optometrist = await staff('optical-optometrist@test.invalid', 'optometrist');
  const keeper = await staff('optical-keeper@test.invalid', 'stock_keeper');
  const viewer = await staff('optical-viewer@test.invalid', 'viewer');
  const anitha = await request('POST', O('contacts'), { kind: 'customer', name: 'Anitha Reddy', phone: '9876543210' }, 201);
  const ravi = await request('POST', O('contacts'), { kind: 'customer', name: 'Ravi Kumar', phone: '9848022338' }, 201);
  const distance = (eye, sph, cyl, axis, acuity) => ({ eye, zone: 'distance', sph, cyl, axis, acuity });
  let anithaRx, oldRx;

  await t.test('prescriptions: powers per eye and vision, the examiner, PD, a year\'s validity, corrections', async () => {
    const body = { requestKey: key(), contactId: anitha.id, pdBinocular: '63', notes: 'Computer work most of the day',
      rows: [distance('right', '-2.25', '-0.75', '180', '6/6'), distance('left', '-2.00', '-0.50', '90', '6/6'),
        { eye: 'right', zone: 'near', add: '+1.50', acuity: 'N6' }, { eye: 'left', zone: 'near', add: '1.50' }, { eye: 'right', zone: 'intermediate' }] };
    anithaRx = await optometrist('POST', O('optical/prescriptions'), body, 201);
    // The person recording examined; the test is today and valid a year; an empty row is left out.
    assert.deepEqual([anithaRx.examiner_kind, anithaRx.examiner_name, anithaRx.examined_on, anithaRx.valid_until, anithaRx.pd_binocular, anithaRx.locked],
      ['staff', 'optical-optometrist', today, addMonths(today, 12), '63.0', false]);
    assert.deepEqual(anithaRx.rows.map((r) => [r.eye, r.zone, r.sph, r.cyl, r.axis, r.add]), [
      ['right', 'distance', -2.25, -0.75, 180, null], ['right', 'near', null, null, null, 1.5], ['left', 'distance', -2, -0.5, 90, null], ['left', 'near', null, null, null, 1.5]]);
    // A retry gives the same prescription; the same key for other powers is refused.
    assert.equal((await optometrist('POST', O('optical/prescriptions'), body, 201)).id, anithaRx.id);
    await optometrist('POST', O('optical/prescriptions'), { ...body, notes: 'Other' }, 409);
    // Powers as an optometrist writes them, checked with the reason.
    const bad = async (rows, extra, pattern) => {
      const result = await refused('POST', O('optical/prescriptions'), { requestKey: key(), contactId: anitha.id, rows, ...extra });
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.match(result.message, pattern);
    };
    await bad([distance('right', '-2.25', '-0.75')], {}, /Right eye, distance: AXIS is needed with a CYL of -0.75/);
    await bad([distance('right', '-2.25', null, '90')], {}, /AXIS goes with a CYL/);
    await bad([distance('right', '-2.30')], {}, /SPH goes in steps of 0\.25/);
    await bad([distance('right', '-31')], {}, /SPH must be from -30\.00 to \+30\.00/);
    await bad([distance('right', '-2', '-0.5', '181')], {}, /AXIS must be a whole number of degrees from 1 to 180/);
    await bad([{ eye: 'left', zone: 'distance', sph: '-1', add: '2' }], {}, /ADD goes on the near or intermediate row/);
    await bad([{ eye: 'left', zone: 'near', add: '4.25' }], {}, /ADD must be from \+0\.25 to \+4\.00/);
    await bad([{ eye: 'left', zone: 'distance', cyl: '-1', axis: '90' }], {}, /give it with the CYL/);
    await bad([{ eye: 'left', zone: 'distance', sph: '-1', prism: '1' }], {}, /say which way its base points/);
    await bad([{ eye: 'right', zone: 'distance' }], {}, /Give the powers of at least one eye/);
    await bad([distance('right', '-1'), distance('right', '-1.25')], {}, /given twice/);
    await bad([distance('right', '-1')], { pdBinocular: '62', pdRight: '31' }, /not both/);
    await bad([distance('right', '-1')], { examinedOn: daysFrom(1) }, /still to come/);
    await bad([distance('right', '-1')], { examinerKind: 'outside', examinerName: 'Dr. S. Rao' }, /registration number/);
    await bad([distance('right', '-1')], { validUntil: daysFrom(-1) }, /cannot run out before/);
    // An outside prescriber, named with their registration number; plano is 0.00; a prism with its base; each eye's PD.
    oldRx = await cashier('POST', O('optical/prescriptions'), { requestKey: key(), contactId: ravi.id, examinerKind: 'outside', examinerName: 'Dr. S. Rao',
      registrationNo: 'APMC/45678', examinedOn: daysFrom(-400), pdRight: '31.5', pdLeft: '31',
      rows: [distance('right', 'plano', '-1.25', '45'), { eye: 'left', zone: 'distance', sph: '+0.75', prism: '1', prismBase: 'in' }] }, 201);
    assert.deepEqual([oldRx.examiner_name, oldRx.registration_no, oldRx.valid_until, oldRx.rows[0].sph, oldRx.rows[1].prism, oldRx.rows[1].prism_base, oldRx.lapsed],
      ['Dr. S. Rao', 'APMC/45678', addMonths(daysFrom(-400), 12), 0, 1, 'in', true]);
    // Who records: the viewer and the stock keeper only see.
    await viewer('POST', O('optical/prescriptions'), { requestKey: key(), contactId: anitha.id, rows: [distance('right', '-1')] }, 403);
    await keeper('POST', O('optical/prescriptions'), { requestKey: key(), contactId: anitha.id, rows: [distance('right', '-1')] }, 403);
    const listed = await viewer('GET', O('optical/prescriptions'));
    assert.deepEqual(listed.items.filter((p) => p.customer_name !== 'Rule Check').map((p) => [p.customer_name, p.latest, p.orders]), [['Anitha Reddy', true, 0], ['Ravi Kumar', true, 0]]);
    assert.equal((await viewer('GET', O(`optical/prescriptions?contact=${ravi.id}`))).total, 1);
    // Corrected while no order uses it; the activity log keeps what was and what is.
    const corrected = await optometrist('PUT', O(`optical/prescriptions/${anithaRx.id}`), { ...body, requestKey: undefined,
      rows: [distance('right', '-2.50', '-0.75', '180', '6/6'), distance('left', '-2.00', '-0.50', '90', '6/6'), { eye: 'right', zone: 'near', add: '1.50' }, { eye: 'left', zone: 'near', add: '1.50' }] });
    assert.equal(corrected.rows[0].sph, -2.5);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='prescription.corrected' AND entity_id=$2", [optical.id, anithaRx.id]);
    assert.match(audit.details.from.powers, /^R distance -2\.25 -0\.75 x 180/);
    assert.match(audit.details.to.powers, /^R distance -2\.50 -0\.75 x 180/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='prescription.recorded' AND entity_id=$2", [optical.id, oldRx.id]));
    // A customer's history: newest first, and when they are next due.
    const second = await optometrist('POST', O('optical/prescriptions'), { requestKey: key(), contactId: ravi.id, examinedOn: daysFrom(-30),
      rows: [distance('right', '-0.25', '-1.25', '50'), distance('left', '+1.00')], pdBinocular: '62.5' }, 201);
    const history = await viewer('GET', O(`optical/customers/${ravi.id}`));
    assert.deepEqual(history.prescriptions.map((p) => p.id), [second.id, oldRx.id]);
    assert.deepEqual([history.customer.name, history.recall.months, history.recall.due_on], ['Ravi Kumar', 12, addMonths(daysFrom(-30), 12)]);
    // Who may be named as examiner: those who record prescriptions, with their latest registration number.
    const examiners = await optometrist('GET', O('optical/examiners'));
    assert.ok(examiners.staff.some((s) => s.name === 'optical-optometrist'));
    assert.ok(!examiners.staff.some((s) => s.name === 'optical-viewer'), 'a viewer does not examine');
    assert.deepEqual(examiners.outside, [{ name: 'Dr. S. Rao', registration_no: 'APMC/45678' }]);
    // Another type is refused (it has no such tools); another owner sees nothing.
    await request('GET', `/businesses/${grocery.id}/optical/prescriptions`, undefined, 403);
    await request('PUT', `/businesses/${fashion.id}/optical/settings`, { recallMonths: 6 }, 404);
    await other('GET', O('optical/prescriptions'), undefined, 404);
    await other('GET', `/businesses/${elsewhere.id}/optical/customers/${anitha.id}`, undefined, 404);
  });

  // --- Spectacle orders ------------------------------------------------------------------------
  const supplier = await request('POST', O('contacts'), { kind: 'supplier', name: 'Vision Distributors' }, 201);
  const goods = (body) => request('POST', O('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', taxRateId: gst5.id, ...body }, 201);
  const frame = await goods({ name: 'Titan Eye+ TE-1001 black', code: 'FR-TE1001', price: '2499', mrp: '2499', hsnCode: '90031100' });
  const frame2 = await goods({ name: 'Ray-Ban RB-5154 tortoise', code: 'FR-RB5154', price: '6990', mrp: '6990', hsnCode: '90031100' });
  const lens = await goods({ name: 'Single vision 1.56 anti-reflective lens', code: 'LN-SV156', price: '1250', hsnCode: '90015000' });
  const fitting = await request('POST', O('catalog'), { kind: 'service', unit: 'service', name: 'Fitting charges', code: 'SV-FIT', price: '99.50', taxRateId: gst18.id }, 201);
  const labCharge = await request('POST', O('catalog'), { kind: 'service', unit: 'service', name: 'Progressive lenses (lab)', code: 'SV-PRG', price: '4500', taxRateId: gst5.id }, 201);
  await request('POST', O('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines: [
    { skuId: frame.id, quantity: '2', unitPrice: '1200' }, { skuId: frame2.id, quantity: '1', unitPrice: '3500' }, { skuId: lens.id, quantity: '8', unitPrice: '400' }] }, 201);
  const stock = async (skuId) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [optical.id, skuId])).q);
  const sv = (eye, extra = {}) => ({ eye, lensType: 'single_vision', skuId: lens.id, index: '1.56', material: 'cr39', coatings: ['anti_reflective', 'blue_cut'], ...extra });
  const orderBody = (extra = {}) => ({
    requestKey: key(), locationId: shop.id, prescriptionId: anithaRx.id, frame: { skuId: frame.id }, lenses: [sv('right'), sv('left')],
    items: [{ skuId: fitting.id, quantity: '1' }], measurements: { pdRight: '31.5', pdLeft: '31.5' }, madeAt: 'lab', labName: 'Crystal Lens Lab',
    promisedOn: daysFrom(3), ...extra });
  const move = (by, order, status, extra = {}, expected = 200) => by('POST', O(`optical/orders/${order.id}/status`), { status, ...extra }, expected);
  let order, second;

  await t.test('spectacle orders: priced by the core at booking, the prescription copied, an advance on account', async () => {
    // Every figure is the server's: what a sale of these lines comes to now (prices include GST, rounded to the rupee).
    const preview = await cashier('POST', O('optical/orders/preview'), orderBody());
    assert.deepEqual([preview.subtotal, preview.tax, preview.roundOff, preview.total], ['4845.28', '253.22', '0.50', '5099.00']);
    assert.deepEqual(preview.lines.map((l) => [l.part, l.eye, l.net, l.tax]),
      [['frame', null, '2380.00', '119.00'], ['lens', 'right', '1190.48', '59.52'], ['lens', 'left', '1190.48', '59.52'], ['item', null, '84.32', '15.18']]);
    const body = orderBody({ advance: { amount: '2000', method: 'cash' }, notes: 'Thin lenses please' });
    order = await cashier('POST', O('optical/orders'), body, 201);
    assert.match(order.order_no, /^SPO\/\d{4}\/0001$/);
    assert.deepEqual([order.status, order.total, order.subtotal, order.tax, order.round_off, order.made_at, order.lab_name, order.money],
      ['booked', '5099.00', '4845.28', '253.22', '0.50', 'lab', 'Crystal Lens Lab', true]);
    assert.deepEqual([order.advance.amount, order.advance.free, order.bill.total, order.bill.due], ['2000.00', '2000.00', '5099.00', '3099.00']);
    assert.deepEqual(order.lines.map((l) => [l.part, l.eye, l.sku_id, l.net, l.tax, l.lens_type, l.lens_index, l.coatings]), [
      ['frame', null, frame.id, '2380.00', '119.00', null, null, []], ['lens', 'right', lens.id, '1190.48', '59.52', 'single_vision', '1.56', ['anti_reflective', 'blue_cut']],
      ['lens', 'left', lens.id, '1190.48', '59.52', 'single_vision', '1.56', ['anti_reflective', 'blue_cut']], ['item', null, fitting.id, '84.32', '15.18', null, null, []]]);
    // The prescription as it was is on the order, and it never changes now.
    assert.deepEqual([order.rx.id, order.rx.examinerName, order.rx.rows.map((r) => r.sph)], [anithaRx.id, 'optical-optometrist', [-2.5, null, -2, null]]);
    assert.match((await refused('PUT', O(`optical/prescriptions/${anithaRx.id}`), { contactId: anitha.id, rows: [distance('right', '-3')] })).message,
      new RegExp(`is on spectacle order ${order.order_no.replace(/\//g, '\\/')} and no longer changes`));
    await assert.rejects(pool.query("UPDATE optical_prescription_rows SET sph=-3 WHERE business_id=$1 AND prescription_id=$2 AND eye='right' AND zone='distance'", [optical.id, anithaRx.id]), /never change/);
    assert.equal((await optometrist('GET', O(`optical/prescriptions/${anithaRx.id}`))).locked, true);
    // A retry gives the same order; the same key with other data is refused.
    assert.equal((await cashier('POST', O('optical/orders'), body, 201)).id, order.id);
    await cashier('POST', O('optical/orders'), { ...body, notes: 'Other' }, 409);
    // The advance: a numbered receipt in the customer's name, money on their account until the bill.
    const receipt = await one('SELECT * FROM business_collections WHERE business_id=$1 AND id=$2', [optical.id, order.advance_collection_id]);
    assert.deepEqual([receipt.amount, receipt.method, Number(receipt.contact_id), receipt.notes], ['2000.00', 'cash', Number(anitha.id), `Advance on spectacle order ${order.order_no}`]);
    assert.equal(Number((await request('GET', O('contacts?kind=customer&q=Anitha'))).items[0].balance), -2000);
    // What booking checks, with the reason.
    const refuse = async (extra, pattern, status = 400, by = refused) => {
      const result = await by('POST', O('optical/orders'), orderBody(extra));
      assert.equal(result.status, status, JSON.stringify(result));
      assert.match(result.message, pattern);
    };
    await refuse({ measurements: { pdRight: '31.5' } }, /fitting PD of the left eye/);
    await refuse({ lenses: [sv('right', { lensType: 'progressive' })], measurements: { pdRight: '31.5' } }, /needs the fitting height of the right eye/);
    await refuse({ prescriptionId: oldRx.id, lenses: [sv('right', { lensType: 'bifocal' })], measurements: { pdRight: '31', fittingHeightRight: '16' } }, /needs its near power \(the ADD\)/);
    await refuse({ advance: { amount: '6000', method: 'cash' } }, /at most 5099\.00/);
    await refuse({ promisedOn: daysFrom(-1) }, /one that has passed/);
    await refuse({ labName: '' }, /The lab's name is required/);
    await refuse({ madeAt: 'in_house' }, /go with spectacles made at a lab/);
    await refuse({ frame: { ownFrame: true, description: 'Own black metal frame' }, lenses: [{ eye: 'right', lensType: 'single_vision' }], items: [] }, /Put the price on the order/);
    await refuse({ frame: { skuId: fitting.id } }, /is a service: the frame is an item from stock/);
    await refuse({ lenses: [sv('right'), sv('right')] }, /Each eye has one lens/);
    await refuse({ lenses: [sv('right', { index: '1.555' })] }, /index must be from 1\.40 to 2\.00/);
    await refuse({ lenses: [sv('right', { coatings: ['gold'] })] }, /coating must be one of/);
    // Booking is selling: the optometrist records prescriptions and never books.
    await optometrist('POST', O('optical/orders'), orderBody(), 403);
    await keeper('POST', O('optical/orders/preview'), orderBody(), 403);
  });

  await t.test('the work: the lab, the workshop and the quality check by someone who may approve it', async () => {
    // Steps are not skipped.
    await move(cashier, order, 'ready', {}, 409);
    assert.equal((await refused('POST', O(`optical/orders/${order.id}/status`), { status: 'quality_check' })).status, 409);
    // Sent to the lab with its order number, by the stock keeper (who sees no money).
    let now = await move(keeper, order, 'at_lab', { labOrderNo: 'CL-7781' });
    assert.deepEqual([now.status, now.lab_order_no, now.total, now.money, now.lines[0].unit_price, now.lines[0].net, now.advance, now.bill],
      ['at_lab', 'CL-7781', null, false, null, null, null, null]);
    assert.ok(!now.events.some((e) => /\d+\.\d{2}/.test(e.note || '')), 'the history names no amounts');
    now = await move(keeper, order, 'in_workshop', { note: 'Lenses back from the lab for fitting' });
    now = await move(keeper, order, 'quality_check');
    // Passing or failing it needs optical.approve; a fail says what failed.
    await move(cashier, order, 'ready', {}, 403);
    await move(optometrist, order, 'in_workshop', {}, 400);
    now = await move(optometrist, order, 'in_workshop', { note: 'Right lens axis at 170, not 180' });
    now = await move(keeper, order, 'quality_check');
    now = await move(optometrist, order, 'ready', { note: 'Checked on the lensometer' });
    assert.deepEqual([now.status, now.checked_by_name, Boolean(now.checked_at), now.next], ['ready', 'optical-optometrist', true, ['in_workshop', 'at_lab']]);
    assert.deepEqual(now.events.map((e) => e.to_status), ['booked', 'at_lab', 'in_workshop', 'quality_check', 'in_workshop', 'quality_check', 'ready']);
    assert.match(now.events[1].note, /^Sent to Crystal Lens Lab · lab order CL-7781/);
    assert.match(now.events[4].note, /^Quality check failed: Right lens axis at 170/);
    assert.match(now.events[6].note, /^Quality check passed: Checked on the lensometer/);
    // The database keeps the steps, the prices and the lines, and deletes nothing.
    await assert.rejects(pool.query("UPDATE optical_orders SET status='booked' WHERE id=$1", [order.id]), /cannot go from ready to booked/);
    await assert.rejects(pool.query('UPDATE optical_orders SET total=1 WHERE id=$1', [order.id]), /keeps its number, customer, prescription, prices and advance/);
    await assert.rejects(pool.query('UPDATE optical_order_lines SET net=0 WHERE order_id=$1', [order.id]), /kept as they were booked/);
    await assert.rejects(pool.query('DELETE FROM optical_orders WHERE id=$1', [order.id]), /never deleted/);
    await assert.rejects(pool.query('DELETE FROM optical_order_events WHERE order_id=$1', [order.id]), /history is kept as it was written/);
    // The day's chips and the bell: ready to collect.
    assert.equal((await cashier('GET', O('optical/orders/counts'))).ready, 1);
    const bell = (await cashier('GET', O('notifications'))).items.filter((i) => i.category === 'Spectacle orders');
    assert.deepEqual(bell.map((i) => [i.severity, i.title, i.link.endsWith(`/spectacle-orders/${order.id}`)]), [['info', `${order.order_no} is ready to collect`, true]]);
    assert.equal((await cashier('GET', O('optical/orders/open?ready=true'))).total, 1);
    // A WhatsApp message to the customer is kept in the history.
    assert.match((await optometrist('POST', O(`optical/orders/${order.id}/messages`), { channel: 'whatsapp', stage: 'ready' }, 201)).note, /^WhatsApp sent: ready to collect/);
  });

  await t.test('delivery: the bill posted by the core at the booked prices, the advance taken off first', async () => {
    // Delivering bills: the stock keeper may not.
    await keeper('POST', O(`optical/orders/${order.id}/deliver`), { requestKey: key() }, 403);
    await cashier('POST', O(`optical/orders/${order.id}/deliver`), { requestKey: key(), payment: { amount: '3100', method: 'upi' } }, 400);
    const before = [await stock(frame.id), await stock(lens.id)];
    const deliveryKey = key();
    const deliveryBody = { requestKey: deliveryKey, payment: { amount: 'full', method: 'upi', reference: 'UPI-4411' } };
    const delivered = await cashier('POST', O(`optical/orders/${order.id}/deliver`), deliveryBody);
    assert.deepEqual([delivered.status, delivered.delivered_by_name, delivered.bill], ['delivered', 'optical-cashier', null]);
    const bill = await one('SELECT * FROM business_documents WHERE business_id=$1 AND id=$2', [optical.id, delivered.document_id]);
    assert.deepEqual([bill.kind, bill.total, bill.subtotal, bill.tax, bill.round_off, Number(bill.contact_id), bill.notes],
      ['sale', '5099.00', '4845.28', '253.22', '0.50', Number(anitha.id), `Spectacle order ${order.order_no}`]);
    const lines = await rows('SELECT sku_id,quantity,unit_price,net,tax FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [optical.id, bill.id]);
    assert.deepEqual(lines.map((l) => [Number(l.sku_id), l.quantity, l.net, l.tax]), [[frame.id, '1.000', '2380.00', '119.00'], [lens.id, '1.000', '1190.48', '59.52'],
      [lens.id, '1.000', '1190.48', '59.52'], [fitting.id, '1.000', '84.32', '15.18']]);
    assert.equal(lines.reduce((s, l) => s + paise(l.net) + paise(l.tax), 0) + paise(bill.round_off), paise(bill.total));
    const payments = await rows('SELECT amount,method,collection_id,reference FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [optical.id, bill.id]);
    assert.deepEqual(payments.map((p) => [p.amount, p.method, p.collection_id === null ? null : Number(p.collection_id), p.reference]),
      [['3099.00', 'upi', null, 'UPI-4411'], ['2000.00', 'cash', Number(order.advance_collection_id), order.advance.collection_no]]);
    // The frame and the lenses left stock now, at the order's location; the customer owes nothing.
    assert.deepEqual([await stock(frame.id), await stock(lens.id)], [before[0] - 1, before[1] - 2]);
    assert.equal(Number((await request('GET', O('contacts?kind=customer&q=Anitha'))).items[0].balance), 0);
    assert.equal(delivered.advance.free, '0.00');
    // A retry gives the same delivery; the same key with other data, or another delivery, is refused; a delivered order never changes.
    assert.equal((await cashier('POST', O(`optical/orders/${order.id}/deliver`), deliveryBody)).document_id, delivered.document_id);
    assert.match((await cashier('POST', O(`optical/orders/${order.id}/deliver`), { ...deliveryBody, payment: { amount: 'full', method: 'cash' } }, 409)).message,
      /already used for different data/);
    await cashier('POST', O(`optical/orders/${order.id}/deliver`), { requestKey: key() }, 409);
    await move(cashier, order, 'in_workshop', { note: 'x' }, 409);
    await assert.rejects(pool.query("UPDATE optical_orders SET notes='x' WHERE id=$1", [order.id]), /is delivered and can no longer change/);
  });

  await t.test('cancelling: the advance stays the customer\'s, handed back from the order with a manager\'s PIN', async () => {
    // The customer's own frame; progressive lenses described and billed as the lab's charge; a discount with its reason.
    second = await request('POST', O('optical/orders'), orderBody({
      frame: { ownFrame: true, description: 'Customer\'s own gold metal frame' }, items: [{ skuId: labCharge.id, quantity: '1' }],
      lenses: [{ eye: 'right', lensType: 'progressive', brand: 'Essilor Varilux', index: '1.6', material: 'polycarbonate', coatings: ['anti_reflective'] },
        { eye: 'left', lensType: 'progressive', brand: 'Essilor Varilux', index: '1.60', material: 'polycarbonate', coatings: ['anti_reflective'] }],
      measurements: { pdRight: '31.5', pdLeft: '31.5', fittingHeightRight: '18', fittingHeightLeft: '18.5' },
      discount: { amount: '100', reason: 'Regular customer' }, advance: { amount: '1500', method: 'upi', reference: 'UPI-2201' } }), 201);
    assert.deepEqual([second.total, second.savings, second.discount_amount, second.discount_reason, second.lines[0].own_frame, second.lines[0].description,
      second.lines[1].lens_index, second.lines[1].sku_id, second.lines[3].net, second.lines[3].tax],
    ['4400.00', '100.00', '100.00', 'Regular customer', true, 'Customer\'s own gold metal frame', '1.60', null, '4190.48', '209.52']);
    // A cashier gives no discount (sales.discount) and does not cancel (optical.cancel).
    await cashier('POST', O('optical/orders/preview'), orderBody({ discount: { amount: '50', reason: 'x' } }), 403);
    await cashier('POST', O(`optical/orders/${second.id}/cancel`), { reason: 'Changed mind' }, 403);
    await request('POST', O(`optical/orders/${second.id}/advance-refund`), { method: 'cash', reason: 'x', pin: '2468', requestKey: key() }, 409);
    const cancelled = await request('POST', O(`optical/orders/${second.id}/cancel`), { reason: 'Customer moved to another city' });
    assert.deepEqual([cancelled.status, cancelled.cancel_reason, cancelled.advance.free, cancelled.next], ['cancelled', 'Customer moved to another city', '1500.00', []]);
    assert.equal((await request('POST', O(`optical/orders/${second.id}/cancel`), { reason: 'again' })).cancel_reason, 'Customer moved to another city');
    assert.equal((await request('GET', O('optical/orders?advance_to_refund=true'))).total, 1);
    // A cashier hands it back with the owner's PIN; a retry is the same refund; nothing is left after it.
    await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
    const refundBody = { method: 'upi', reference: 'UPI-REF-9', reason: 'Order cancelled', approverId: ownerUser.id, pin: '2468', requestKey: key() };
    await cashier('POST', O(`optical/orders/${second.id}/advance-refund`), { ...refundBody, requestKey: key(), pin: '1111' }, 400);
    const refund = await cashier('POST', O(`optical/orders/${second.id}/advance-refund`), refundBody, 201);
    assert.deepEqual([refund.amount, refund.method, refund.source, refund.left, refund.repeated], ['1500.00', 'upi', 'optical', '0.00', false]);
    assert.ok((await cashier('POST', O(`optical/orders/${second.id}/advance-refund`), refundBody, 201)).repeated);
    await cashier('POST', O(`optical/orders/${second.id}/advance-refund`), { ...refundBody, requestKey: key() }, 409);
    assert.equal((await request('GET', O(`optical/orders/${second.id}`))).advance.refunds.length, 1);
    await assert.rejects(pool.query("UPDATE optical_orders SET notes='x' WHERE id=$1", [second.id]), /is cancelled and can no longer change/);
  });

  await t.test('a remake: linked to the delivered order, at no cost to the customer when the lab bears it', async () => {
    const remakeBody = orderBody({ frame: { ownFrame: true, description: `Frame of ${order.order_no}` }, items: [],
      remake: { orderId: order.id, reason: 'non_adaptation', costBy: 'lab', note: 'Blurred at the edges' } });
    assert.match((await refused('POST', O('optical/orders'), { ...remakeBody, requestKey: key(), remake: { ...remakeBody.remake, orderId: second.id } })).message, /only a delivered order is made again/);
    assert.match((await refused('POST', O('optical/orders'), { ...remakeBody, requestKey: key(), advance: { amount: '100', method: 'cash' } })).message, /takes no advance/);
    const remake = await cashier('POST', O('optical/orders'), remakeBody, 201);
    assert.deepEqual([remake.total, remake.remake_of_no, remake.remake_reason, remake.remake_cost_by, remake.lines.filter((l) => l.sku_id).map((l) => [l.net, l.tax, l.unit_price])],
      ['0.00', order.order_no, 'non_adaptation', 'lab', [['0.00', '0.00', '0.0000'], ['0.00', '0.00', '0.0000']]]);
    assert.deepEqual((await cashier('GET', O(`optical/orders/${order.id}`))).remakes.map((r) => r.order_no), [remake.order_no]);
    await move(keeper, remake, 'at_lab', { labOrderNo: 'CL-7790' });
    await move(keeper, remake, 'quality_check');
    await move(optometrist, remake, 'ready');
    const before = await stock(lens.id);
    const done = await cashier('POST', O(`optical/orders/${remake.id}/deliver`), { requestKey: key() });
    const bill = await one('SELECT total FROM business_documents WHERE business_id=$1 AND id=$2', [optical.id, done.document_id]);
    assert.deepEqual([done.status, bill.total, await stock(lens.id)], ['delivered', '0.00', before - 2]);
    // A remake the customer pays for is priced as any order.
    const paid = await cashier('POST', O('optical/orders'), orderBody({ frame: { ownFrame: true, description: 'Same frame' }, lenses: [sv('right')], items: [],
      measurements: { pdRight: '31.5' }, remake: { orderId: order.id, reason: 'power_change', costBy: 'customer' } }), 201);
    assert.equal(paid.total, '1250.00');
    await request('POST', O(`optical/orders/${paid.id}/cancel`), { reason: 'Booked to check the price' });
  });

  await t.test('GST at delivery is the rate of the day: a price including GST keeps its total', async () => {
    const third = await cashier('POST', O('optical/orders'), orderBody({ frame: { skuId: frame2.id }, items: [], madeAt: 'in_house', labName: undefined }), 201);
    assert.deepEqual([third.total, third.lines[0].net, third.lines[0].tax], ['9490.00', '6657.14', '332.86']);
    // The frame's slab moves to 18% after booking: the bill keeps the agreed price and works out GST at 18%.
    await request('PATCH', O(`catalog/${frame2.id}`), { label: frame2.label, price: '6990', mrp: '6990', taxRateId: gst18.id });
    await move(keeper, third, 'in_workshop');
    await move(keeper, third, 'quality_check');
    assert.equal((await move(optometrist, third, 'ready')).bill, null, 'the optometrist sees no money');
    const ready = await cashier('GET', O(`optical/orders/${third.id}`));
    assert.deepEqual([ready.bill.total, ready.bill.tax, ready.bill.rate_changed, ready.bill.due], ['9490.00', '1185.31', true, '9490.00']);
    const done = await cashier('POST', O(`optical/orders/${third.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'card', reference: 'CARD-88' } });
    const bill = await one('SELECT total,subtotal,tax,round_off FROM business_documents WHERE business_id=$1 AND id=$2', [optical.id, done.document_id]);
    assert.deepEqual([bill.total, bill.subtotal, bill.tax, bill.round_off], ['9490.00', '8304.69', '1185.31', '0.00']);
    const framed = await one('SELECT unit_price,tax_rate,net,tax FROM business_document_lines WHERE business_id=$1 AND document_id=$2 AND sku_id=$3', [optical.id, done.document_id, frame2.id]);
    assert.deepEqual([framed.tax_rate, framed.net, framed.tax], ['18.00', '5923.73', '1066.27']);
  });

  await t.test('stock: an item not in usable stock stops the delivery until it is received', async () => {
    const fourth = await cashier('POST', O('optical/orders'), orderBody({ items: [], madeAt: 'in_house', labName: undefined }), 201);
    // The last frame of the model is sold at the counter meanwhile.
    assert.equal(await stock(frame.id), 1);
    await request('POST', O('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, lines: [{ skuId: frame.id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 201);
    await move(keeper, fourth, 'in_workshop');
    await move(keeper, fourth, 'quality_check');
    const ready = await move(optometrist, fourth, 'ready');
    assert.equal(Number(ready.lines[0].in_stock), 0);
    const result = await call('POST', O(`optical/orders/${fourth.id}/deliver`), { requestKey: key() }, ownerToken);
    assert.equal(result.status, 409);
    assert.match(result.body.message, /Not enough usable stock for Titan Eye\+ TE-1001 black/);
    assert.equal((await one('SELECT status FROM optical_orders WHERE id=$1', [fourth.id])).status, 'ready');
    await request('POST', O('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines: [{ skuId: frame.id, quantity: '1', unitPrice: '1200' }] }, 201);
    const done = await cashier('POST', O(`optical/orders/${fourth.id}/deliver`), { requestKey: key() });
    // Nothing paid now: the bill is on the customer's dues.
    assert.equal((await one('SELECT total FROM business_documents WHERE id=$1', [done.document_id])).total, '4999.00');
    assert.equal(Number((await request('GET', O('contacts?kind=customer&q=Anitha'))).items[0].balance), 4999);
    // An open order past its promised day is late: on the chips and in the bell.
    const late = await cashier('POST', O('optical/orders'), orderBody({ items: [] }), 201);
    await pool.query("UPDATE optical_orders SET promised_on=(now() AT TIME ZONE 'Asia/Kolkata')::date - 2 WHERE id=$1", [late.id]);
    assert.equal((await cashier('GET', O('optical/orders/counts'))).overdue, 1);
    const bell = (await cashier('GET', O('notifications'))).items.filter((i) => i.category === 'Spectacle orders');
    assert.ok(bell.some((i) => i.severity === 'warning' && i.title === `${late.order_no} is past its promised day` && /promised 2 days ago/.test(i.detail)));
    assert.equal((await cashier('GET', O('optical/orders/open?overdue=true'))).items[0].id, late.id);
  });

  // --- The recall list ---------------------------------------------------------------------------
  await t.test('the recall list: customers whose last eye test was the set months ago, with a reminder kept', async () => {
    const lakshmi = await request('POST', O('contacts'), { kind: 'customer', name: 'Lakshmi Devi', phone: '9000012345' }, 201);
    await optometrist('POST', O('optical/prescriptions'), { requestKey: key(), contactId: lakshmi.id, examinedOn: daysFrom(-400), rows: [distance('right', '+1.25'), distance('left', '+1.50')] }, 201);
    // Ravi's latest test is 30 days old and Anitha's is today: only Lakshmi is due (12 months by default).
    let recall = await viewer('GET', O('optical/recall'));
    assert.deepEqual(recall.items.map((r) => [r.name, r.phone, r.examined_on, r.due_on, r.months, r.reminded_recently]),
      [['Lakshmi Devi', '9000012345', daysFrom(-400), addMonths(daysFrom(-400), 12), 12, false]]);
    assert.ok(Number(recall.items[0].days_overdue) > 0);
    // The months are a setting: an owner's (settings.edit), 1 to 60.
    assert.equal((await viewer('GET', O('optical/settings'))).recall_months, 12);
    await viewer('PUT', O('optical/settings'), { recallMonths: 24 }, 403);
    await request('PUT', O('optical/settings'), { recallMonths: 0 }, 400);
    await request('PUT', O('optical/settings'), { recallMonths: 1.5 }, 400);
    const saved = await request('PUT', O('optical/settings'), { recallMonths: 24 });
    assert.deepEqual([saved.recall_months, saved.updated_by_name], [24, 'optical-owner']);
    assert.equal((await viewer('GET', O('optical/recall'))).total, 0);
    await request('PUT', O('optical/settings'), { recallMonths: 12 });
    const setting = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='optical_settings.updated' ORDER BY id LIMIT 1", [optical.id]);
    assert.deepEqual(setting.details, { from: { recallMonths: 12 }, to: { recallMonths: 24 } });
    // A reminder is kept and shows as recent; a customer never tested here is not reminded.
    await viewer('POST', O(`optical/recall/${lakshmi.id}/reminders`), { channel: 'whatsapp' }, 201);
    recall = await viewer('GET', O('optical/recall?reminded=true'));
    assert.deepEqual(recall.items.map((r) => [r.name, r.reminded_recently, Boolean(r.reminded_at), r.reminders]), [['Lakshmi Devi', true, true, 1]]);
    assert.equal((await viewer('GET', O('optical/recall?reminded=false'))).total, 0);
    const stranger = await request('POST', O('contacts'), { kind: 'customer', name: 'Walk-in Gopal' }, 201);
    await viewer('POST', O(`optical/recall/${stranger.id}/reminders`), { channel: 'call' }, 409);
    await viewer('POST', O(`optical/recall/${lakshmi.id}/reminders`), { channel: 'pigeon' }, 400);
    await assert.rejects(pool.query('DELETE FROM optical_recall_reminders WHERE business_id=$1', [optical.id]), /kept as it was given/);
    assert.equal((await viewer('GET', O(`optical/customers/${lakshmi.id}`))).recall.reminded_at !== null, true);
    // Another type has no recall list.
    await request('GET', `/businesses/${grocery.id}/optical/recall`, undefined, 403);
  });

  // --- Contact lenses: the power grid -----------------------------------------------------------
  await t.test('the power grid: one contact-lens product\'s powers made as its items, with Variants on', async () => {
    const [plain] = await createBusinesses(request, 'PLAIN', ['optical']);
    const grid = { name: 'Acuvue Oasys (box of 6)', brand: 'Johnson & Johnson', unit: 'box', tracking: 'batch', price: '2450', mrp: '2450', taxRateId: gst5.id,
      hsnCode: '90013000', codePrefix: 'AO6', baseCurve: '8.4', diameter: '14', ranges: [{ from: '-0.50', to: '-6.00', step: '0.25' }, { from: '+0.50', to: '+2.00', step: '0.25' }] };
    // Only with Variants on, only an optical shop's, only someone who adds items.
    await request('POST', `/businesses/${plain.id}/optical/power-grid`, { ...grid, taxRateId: undefined, taxRate: '5' }, 403);
    await request('POST', `/businesses/${fashion.id}/optical/power-grid`, grid, 404);
    await cashier('POST', O('optical/power-grid'), grid, 403);
    const made = await request('POST', O('optical/power-grid'), grid, 201);
    assert.equal(made.created, 30);
    assert.deepEqual(made.items.slice(0, 2).map((s) => [s.code, s.label, s.power]), [['AO6-M600', 'Acuvue Oasys (box of 6) · -6.00', '-6.00'], ['AO6-M575', 'Acuvue Oasys (box of 6) · -5.75', '-5.75']]);
    assert.deepEqual(made.items.at(-1).code, 'AO6-P200');
    const item = await one("SELECT attributes,tracking,unit,price,tax_rate,hsn_code,mrp,product_id FROM catalog_skus WHERE business_id=$1 AND code='AO6-M250'", [optical.id]);
    assert.deepEqual([item.attributes, item.tracking, item.unit, item.price, item.tax_rate, item.hsn_code, item.mrp, Number(item.product_id)],
      [{ power: '-2.50', baseCurve: '8.4', diameter: '14.0' }, 'batch', 'box', '2450.00', '5.00', '90013000', '2450.00', Number(made.product.id)]);
    // More powers later: one it has is left as it is; the same lens keeps its base curve and diameter.
    const more = await request('POST', O('optical/power-grid'), { productId: made.product.id, baseCurve: '8.4', diameter: '14.0', ranges: [{ from: '-6.00', to: '-8.00', step: '0.50' }] }, 201);
    assert.deepEqual(more.items.map((s) => s.power), ['-8.00', '-7.50', '-7.00', '-6.50']);
    assert.match((await refused('POST', O('optical/power-grid'), { productId: made.product.id, baseCurve: '8.4', diameter: '14', ranges: [{ from: '-1', to: '-2', step: '0.5' }] })).message,
      /already has every one of these powers/);
    assert.match((await refused('POST', O('optical/power-grid'), { productId: made.product.id, baseCurve: '8.8', diameter: '14', ranges: [{ from: '-9', to: '-9' }] })).message,
      /another base curve or diameter is another lens product/);
    // Powers and steps checked; a prefix used once.
    assert.match((await refused('POST', O('optical/power-grid'), { ...grid, codePrefix: 'X1', ranges: [{ from: '-0.50', to: '-1.75', step: '0.5' }] })).message, /does not go in steps of 0\.50/);
    assert.match((await refused('POST', O('optical/power-grid'), { ...grid, codePrefix: 'X1', ranges: [{ from: '-0.30', to: '-1' }] })).message, /steps of 0\.25/);
    assert.match((await refused('POST', O('optical/power-grid'), { ...grid, codePrefix: 'X1', baseCurve: '6' })).message, /Base curve must be from 7 to 10 mm/);
    assert.equal((await refused('POST', O('optical/power-grid'), grid)).status, 409);
    // The product's powers, lowest first, each with its stock.
    const powers = await cashier('GET', O(`optical/power-grid/${made.product.id}`));
    assert.deepEqual([powers.powers.length, powers.powers[0].power, powers.powers.at(-1).power, powers.base_curve, powers.diameter], [34, '-8.00', '2.00', '8.4', '14.0']);
    // Each power sells like any item: received by batch, billed at the counter.
    const minus250 = made.items.find((s) => s.power === '-2.50');
    await request('POST', O('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
      lines: [{ skuId: minus250.id, quantity: '4', unitPrice: '1600', lotCode: 'B4471', expiresOn: daysFrom(500) }] }, 201);
    const sold = await cashier('POST', O('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, lines: [{ skuId: minus250.id, quantity: '1', lotCode: 'B4471' }],
      payment: { amount: 'full', method: 'cash' } }, 201);
    assert.equal(sold.total, '2450.00');
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='catalog.lens_powers_created' AND entity_id=$2", [optical.id, made.product.id]));
  });

  await t.test('audit and events of the orders', async () => {
    const events = await rows(`SELECT kind,count(*)::int AS n FROM business_events WHERE business_id=$1 AND entity_type='spectacle_order' GROUP BY kind ORDER BY kind`, [optical.id]);
    const count = Object.fromEntries(events.map((e) => [e.kind, e.n]));
    assert.ok(count['spectacle_order.booked'] >= 7 && count['spectacle_order.delivered'] === 4 && count['spectacle_order.cancelled'] === 2 && count['spectacle_order.status_changed'] > 10, JSON.stringify(count));
    const booked = await one("SELECT payload FROM business_events WHERE business_id=$1 AND kind='spectacle_order.booked' AND entity_id=$2", [optical.id, order.id]);
    assert.deepEqual([booked.payload.orderNo, booked.payload.total, booked.payload.advanceCollectionId], [order.order_no, '5099.00', Number(order.advance_collection_id)]);
    const audit = await rows("SELECT action FROM business_audit WHERE business_id=$1 AND entity_id=$2 AND action LIKE 'spectacle_order.%' ORDER BY id", [optical.id, order.id]);
    assert.deepEqual([...new Set(audit.map((a) => a.action))], ['spectacle_order.booked', 'spectacle_order.status_changed', 'spectacle_order.customer_told', 'spectacle_order.delivered']);
    // The advance and the bill went through the core's own records.
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='collection.recorded' AND entity_id=$2", [optical.id, order.advance_collection_id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='sale.posted' AND entity_id=$2", [optical.id, (await one('SELECT document_id FROM optical_orders WHERE id=$1', [order.id])).document_id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='collection.refunded'", [optical.id]));
  });
});
