const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { signIn } = require('./helpers/signIn');

// A clinic's lab gathered by department, the tests a doctor orders billed
// later, and the clinic's own drug list behind the prescription, end to end
// on a throwaway database of their own:
//
//   - the lab's departments: the eight every lab has, made with each clinic
//     (and with no other business), the lab's own, a test and a profile in
//     one, Other where a test starts, switched off once empty, who works in
//     each; the bench names each test's department and the person's own;
//   - billing an order's tests later: from the order (part now and the rest
//     later, a profile as one line, never twice, the database's own guard),
//     with the visit's bill (the consultation and the ordered tests on one
//     bill, each test on its own line), as they are ordered, and with a bill
//     the desk made before; a test cancelled alone (unbilled: nothing more;
//     billed: the answer names its bill), the last one cancelling the order;
//     the referral commission on the tests' share of a bill;
//   - the clinic's drug list: kept by the doctors, imported from a
//     spreadsheet with a check first; the prescription picking from it, its
//     warnings (an allergy, the same medicine or group twice, a day's dose
//     over the most) shown before saving and kept with the doctor's reason,
//     checked again on completing;
//   - refusals with their exact codes, idempotent retries, the audit, the
//     events and the live stream;
//   - the migration's Down half (by its slug) and Up again, with what Up
//     makes of the rows kept before.
test('the lab by department, billing ordered tests later, and the clinic\'s drug list', { timeout: 600000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, listener, created = false;
  await admin.connect();
  t.after(async () => {
    if (listener) await listener.end();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
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
  const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_clinic-lab-more.sql')).split('_')[0]);
  const probe = async (sql, values = []) => {
    const client = new Client({ ...connection, database });
    await client.connect();
    try { return (await client.query(sql, values)).rows; } finally { await client.end(); }
  };
  const shape = async () => (await probe(`SELECT
      (SELECT count(*)::int FROM pg_tables WHERE tablename IN ('lab_departments','lab_department_staff','health_clinic_drugs')) AS tables,
      (SELECT count(*)::int FROM information_schema.columns WHERE (table_name,column_name) IN (('lab_tests','department_id'),('lab_order_tests','document_line_id'),
        ('lab_order_tests','cancelled_at'),('lab_order_tests','cancel_reason'),('health_prescription_items','drug_id'),('health_prescription_items','warnings'))) AS columns,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('businesses_default_lab_departments','lab_tests_department_default','lab_order_test_billing','lab_order_tests_live')) AS triggers`))[0];

  await t.test('the Down half takes the departments, the billing links and the drug list away, and Up brings them back', async () => {
    assert.deepEqual(await shape(), { tables: 3, columns: 6, triggers: 4 });
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.deepEqual(await shape(), { tables: 0, columns: 0, triggers: 0 });
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await shape(), { tables: 3, columns: 6, triggers: 4 });
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Lab-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const pinHash = await bcrypt.hash('2468', 4);
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
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  // A refusal: its status and its sentence (and details).
  const refused = (auth) => async (method, route, body, status) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return { message: result.body.message, data: result.body.data };
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const key = () => crypto.randomUUID();

  // --- A clinic with its lab, another with the lab off, a grocery, another owner's clinic, staff ---
  const ownerUser = await owner('clm-owner');
  const otherUser = await owner('clm-other');
  const ownerToken = await login('clm-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('clm-other@test.invalid'));
  const [clinic, grocery] = await createBusinesses(request, 'CLM', ['healthcare', 'grocery']);
  const [plain] = await createBusinesses(request, 'CLMPLAIN', ['healthcare']);
  const [elsewhere] = await createBusinesses(other, 'CLMELS', ['healthcare']);
  const C = (s) => `/businesses/${clinic.id}/${s}`;
  const E = (s) => `/businesses/${elsewhere.id}/${s}`;
  await request('PUT', C('modules/lab'), { enabled: true });
  await other('PUT', E('modules/lab'), { enabled: true });
  const main = (await request('GET', C('locations'))).items[0];
  const roles = (await request('GET', C('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash,pin_hash,pin_set_at) VALUES($1,$2,$3,$4,$5,now()) RETURNING id',
      [ownerUser.restaurant_id, email.split('@')[0], email, hash, pinHash]);
    await request('POST', C('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, token, call: as(token), refused: refused(token) };
  }
  const desk = await staff('desk@test.invalid', 'cashier');
  const doctor = await staff('doctor@test.invalid', 'doctor');
  const tech = await staff('tech@test.invalid', 'lab_technician');
  const patho = await staff('patho@test.invalid', 'pathologist');
  const ravi = await request('POST', C('resources'), { name: 'Dr. Ravi', locationId: main.id }, 201);
  await request('POST', C('health/signatories'), { kind: 'doctor', userId: doctor.id, name: 'Dr. Ravi Kumar', registrationNo: 'TSMC 31248', resourceId: ravi.id }, 201);
  const pathologist = await request('POST', C('health/signatories'), { kind: 'pathologist', userId: patho.id, name: 'Dr. Anitha', registrationNo: 'TSMC 40266' }, 201);
  const service = (name, code, price) => request('POST', C('catalog'), { kind: 'service', unit: 'service', name, code, price: String(price), taxRate: '0' }, 201);
  const consultation = await service('Consultation', 'CONS', 500);
  await request('PUT', C(`clinic/doctors/${ravi.id}`), { consultationSkuId: consultation.id, followUpDays: 0, slotMinutes: 10, sharePercent: '0' });
  const hbService = await service('Haemoglobin test', 'SVC-HB', 150);
  const lftService = await service('Liver function tests', 'SVC-LFT', 600);
  const register = (name, phone) => desk.call('POST', C('clinic/patients'), { name, phone, sex: 'female', ageYears: 46,
    consent: { purposes: ['treatment'], method: 'signed_form', givenBy: 'Self' } }, 201);
  const lakshmi = await register('Lakshmi Narayanan', '9000000301');
  const swathi = await register('Swathi Reddy', '9000000302');
  const auditCount = async (action, entity = null) => (await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action=$2 AND ($3::bigint IS NULL OR entity_id=$3)',
    [clinic.id, action, entity])).n;
  const linesOf = (documentId) => rows('SELECT id,sku_id,label,net,tax FROM business_document_lines WHERE document_id=$1 ORDER BY id', [documentId]);
  const rowOf = async (orderId, testId) => one('SELECT * FROM lab_order_tests WHERE order_id=$1 AND test_id=$2', [orderId, testId]);
  let deps, hb, esr, sgot, sgpt, lft, urine;
  const dep = (code) => deps.find((d) => d.code === code);

  await t.test('the lab\'s departments: the eight every lab has, its own, a test in one, and who works in each', async () => {
    const listed = await tech.call('GET', C('lab/departments'));
    deps = listed.departments;
    assert.deepEqual(deps.map((d) => [d.code, d.name]), [['haematology', 'Haematology'], ['biochemistry', 'Biochemistry'], ['microbiology', 'Microbiology'],
      ['serology', 'Serology / immunology'], ['clinical_pathology', 'Clinical pathology'], ['histopathology', 'Histopathology'], ['imaging', 'Imaging'], ['other', 'Other']]);
    assert.deepEqual(listed.mine, []);
    // Those who keep the departments see whom they may tie to one: staff whose role sees the lab.
    assert.ok([tech.id, patho.id, doctor.id, desk.id].every((u) => listed.people.some((p) => p.user_id === u)));
    assert.deepEqual((await desk.call('GET', C('lab/departments'))).people, []);
    // Made with every clinic, and with no other business.
    assert.equal((await one('SELECT count(*)::int AS n FROM lab_departments WHERE business_id=$1', [plain.id])).n, 8);
    assert.equal((await one('SELECT count(*)::int AS n FROM lab_departments WHERE business_id=$1', [grocery.id])).n, 0);
    await request('GET', `/businesses/${grocery.id}/lab/departments`, undefined, 403);
    await request('GET', `/businesses/${plain.id}/lab/departments`, undefined, 403);
    await other('GET', C('lab/departments'), undefined, 404);

    // A test saved without a department is in Other; one may be put in any department switched on.
    hb = await tech.call('POST', C('lab/tests'), { code: 'HB', name: 'Haemoglobin', sampleType: 'blood', container: 'EDTA', skuId: hbService.id, parameters: [
      { name: 'Haemoglobin', unit: 'g/dL', decimals: 1, ranges: [{ sex: 'female', ageFrom: 13, low: 12, high: 15.5, criticalLow: 7 }] }] }, 201);
    assert.deepEqual([hb.department_code, hb.department_name], ['other', 'Other']);
    hb = await tech.call('PUT', C(`lab/tests/${hb.id}`), { code: 'HB', name: 'Haemoglobin', sampleType: 'blood', container: 'EDTA', skuId: hbService.id, departmentId: dep('haematology').id,
      parameters: hb.parameters.map((p) => ({ id: p.id, name: p.name, unit: p.unit, decimals: p.decimals, ranges: p.ranges })) });
    assert.equal(hb.department_code, 'haematology');
    esr = await tech.call('POST', C('lab/tests'), { code: 'ESR', name: 'ESR', sampleType: 'blood', departmentId: dep('haematology').id,
      parameters: [{ name: 'ESR', unit: 'mm/hr', decimals: 0, ranges: [{ high: 20 }] }] }, 201);
    sgot = await tech.call('POST', C('lab/tests'), { code: 'SGOT', name: 'SGOT', sampleType: 'serum', departmentId: dep('biochemistry').id,
      parameters: [{ name: 'SGOT', unit: 'U/L', decimals: 0, ranges: [{ high: 40 }] }] }, 201);
    sgpt = await tech.call('POST', C('lab/tests'), { code: 'SGPT', name: 'SGPT', sampleType: 'serum', departmentId: dep('biochemistry').id,
      parameters: [{ name: 'SGPT', unit: 'U/L', decimals: 0, ranges: [{ high: 40 }] }] }, 201);
    lft = await tech.call('POST', C('lab/tests'), { code: 'LFT', name: 'Liver function tests', kind: 'profile', skuId: lftService.id, testIds: [sgot.id, sgpt.id],
      departmentId: dep('biochemistry').id }, 201);
    urine = await tech.call('POST', C('lab/tests'), { code: 'URM', name: 'Urine routine', sampleType: 'urine', departmentId: dep('clinical_pathology').id,
      parameters: [{ name: 'Pus cells', resultType: 'text', ranges: [{ normalText: 'Nil' }] }] }, 201);
    assert.equal(lft.department_code, 'biochemistry');
    const haem = await tech.call('GET', C(`lab/tests?department=${dep('haematology').id}`));
    assert.deepEqual(haem.items.map((x) => x.code).sort(), ['ESR', 'HB']);
    assert.equal(haem.items[0].department_name, 'Haematology');

    // The lab's own department; a name kept once.
    const molecular = await tech.call('POST', C('lab/departments'), { name: 'Molecular biology' }, 201);
    assert.deepEqual([molecular.code, molecular.name, molecular.active, molecular.tests], [null, 'Molecular biology', true, 0]);
    assert.equal((await tech.refused('POST', C('lab/departments'), { name: 'molecular  BIOLOGY' }, 409)).message, 'There is a department called molecular BIOLOGY already');
    await desk.call('POST', C('lab/departments'), { name: 'Cytology' }, 403);
    await tech.call('POST', C('lab/departments'), { name: ' ' }, 400);
    // Other stays on; a department with tests in use is switched off once they are moved; an empty one at once.
    assert.equal((await tech.refused('PUT', C(`lab/departments/${dep('other').id}`), { active: false }, 409)).message, 'Other stays on: a test without a department of its own is in it');
    assert.equal((await tech.refused('PUT', C(`lab/departments/${dep('haematology').id}`), { active: false }, 409)).message,
      'Move the 2 tests in Haematology to another department first (Tests & panels)');
    const imaging = await tech.call('PUT', C(`lab/departments/${dep('imaging').id}`), { active: false });
    assert.equal(imaging.active, false);
    assert.equal(await auditCount('lab.department_switched_off', imaging.id), 1);
    const offTest = await tech.refused('POST', C('lab/tests'), { code: 'XRAY', name: 'Chest X-ray', sampleType: 'other', departmentId: imaging.id,
      parameters: [{ name: 'Impression', resultType: 'text', ranges: [{ normalText: 'Normal' }] }] }, 409);
    assert.equal(offTest.message, 'Imaging is switched off: choose another department');
    await tech.call('PUT', C(`lab/departments/${imaging.id}`), { active: true });
    await tech.call('PUT', C(`lab/departments/${molecular.id}`), { name: 'Molecular diagnostics' });
    assert.equal(await auditCount('lab.department_created', molecular.id), 1);
    assert.equal(await auditCount('lab.department_updated', molecular.id), 1);

    // Who works in a department: the clinic's staff only; the tech's worklist opens on theirs.
    const haematology = await tech.call('PUT', C(`lab/departments/${dep('haematology').id}`), { staff: [tech.id] });
    assert.deepEqual(haematology.staff.map((s) => s.user_id), [tech.id]);
    await tech.call('PUT', C(`lab/departments/${dep('haematology').id}`), { staff: [tech.id, otherUser.id] }, 404);
    assert.deepEqual((await tech.call('GET', C('lab/departments'))).mine, [dep('haematology').id]);
    assert.deepEqual((await patho.call('GET', C('lab/departments'))).mine, []);
  });

  let order1, receipt;
  const rowsOf = async (orderId) => rows('SELECT * FROM lab_order_tests WHERE order_id=$1 ORDER BY id', [orderId]);

  await t.test('billing an order\'s tests later: part now and the rest later, a profile as one line, never twice', async () => {
    order1 = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: lakshmi.contact_id, testIds: [hb.id, lft.id, esr.id] }, 201);
    const hbRow = await rowOf(order1.id, hb.id), sgotRow = await rowOf(order1.id, sgot.id), sgptRow = await rowOf(order1.id, sgpt.id), esrRow = await rowOf(order1.id, esr.id);
    // Nothing billed: the order says what is left to bill, at the tests' prices; ESR has no service to bill.
    let detail = await desk.call('GET', C(`lab/orders/${order1.id}`));
    assert.equal(detail.billing.state, 'none');
    assert.deepEqual(detail.billing.to_bill.map((u) => [u.kind, u.code, u.price, u.order_test_ids]), [['test', 'HB', '150.00', [hbRow.id]], ['profile', 'LFT', '600.00', [sgotRow.id, sgptRow.id]]]);
    assert.deepEqual(detail.billing.no_service, [esrRow.id]);
    assert.deepEqual(detail.tests.map((x) => [x.code, x.department]), [['HB', 'Haematology'], ['SGOT', 'Biochemistry'], ['SGPT', 'Biochemistry'], ['ESR', 'Haematology']]);
    const listed = (await desk.call('GET', C('lab/orders?billing=none&limit=100'))).items.find((o) => o.id === order1.id);
    assert.deepEqual([listed.billing, listed.bill_nos], ['none', null]);

    // Billing is the front desk's (sales.create), as every bill; the lab and the doctors do not bill.
    const body = { requestKey: key(), orderTestIds: [hbRow.id], payment: { amount: 'full', method: 'upi' } };
    await tech.call('POST', C(`lab/orders/${order1.id}/bill`), body, 403);
    await doctor.call('POST', C(`lab/orders/${order1.id}/bill`), body, 403);
    // Part now: the haemoglobin alone, at its price, paid.
    const first = await desk.call('POST', C(`lab/orders/${order1.id}/bill`), body, 201);
    receipt = first.document;
    assert.equal(Number(first.document.total), 150);
    assert.equal(first.billing.state, 'part');
    assert.deepEqual(first.billing.bills.map((b) => b.document_no), [first.document.document_no]);
    const firstLines = await linesOf(first.document.id);
    assert.deepEqual(firstLines.map((l) => [Number(l.sku_id), l.label, l.net]), [[hbService.id, 'Haemoglobin test', '150.00']]);
    assert.equal(Number((await rowOf(order1.id, hb.id)).document_line_id), firstLines[0].id);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_payments WHERE document_id=$1', [first.document.id])).n, 1);
    // The same request again is the same bill; the key with other data is refused.
    const again = await desk.call('POST', C(`lab/orders/${order1.id}/bill`), body, 201);
    assert.deepEqual([again.document.id, again.repeated], [first.document.id, true]);
    assert.equal((await desk.refused('POST', C(`lab/orders/${order1.id}/bill`), { ...body, orderTestIds: [sgotRow.id] }, 409)).message, 'This request key was already used for different data');
    // A test is never billed twice.
    assert.equal((await desk.refused('POST', C(`lab/orders/${order1.id}/bill`), { requestKey: key(), orderTestIds: [hbRow.id] }, 409)).message,
      `Haemoglobin is billed already (${first.document.document_no})`);
    // The rest later: one of the profile's tests brings the profile, one line for both.
    const second = await desk.call('POST', C(`lab/orders/${order1.id}/bill`), { requestKey: key(), orderTestIds: [sgotRow.id] }, 201);
    const secondLines = await linesOf(second.document.id);
    assert.deepEqual(secondLines.map((l) => [Number(l.sku_id), l.net]), [[lftService.id, '600.00']]);
    assert.deepEqual([(await rowOf(order1.id, sgot.id)).document_line_id, (await rowOf(order1.id, sgpt.id)).document_line_id].map(Number), [secondLines[0].id, secondLines[0].id]);
    assert.equal(second.billing.state, 'part');
    // What is left has no service: said so, and nothing is billed.
    assert.match((await desk.refused('POST', C(`lab/orders/${order1.id}/bill`), { requestKey: key() }, 409)).message, /^No test left to bill has a service to bill it as/);
    assert.equal((await desk.refused('POST', C(`lab/orders/${order1.id}/bill`), { requestKey: key(), orderTestIds: [esrRow.id] }, 409)).message,
      'ESR has no service to bill it as: choose one under Lab orders › Tests & panels (Billed as)');
    assert.equal((await desk.refused('POST', C(`lab/orders/${order1.id}/bill`), { requestKey: key(), orderTestIds: [999999] }, 404)).message, 'That test is not on this order');
    // Cancelling the unbilled ESR needs no credit note: the order is then billed.
    const cancelled = await desk.call('POST', C(`lab/orders/${order1.id}/tests/${esrRow.id}/cancel`), { reason: 'Not needed after all' });
    assert.deepEqual(cancelled.cancelled_test, { id: esrRow.id, name: 'ESR', billed_on: null });
    assert.equal(cancelled.billing.state, 'billed');
    detail = (await desk.call('GET', C('lab/orders?limit=100'))).items.find((o) => o.id === order1.id);
    assert.equal(detail.billing, 'billed');
    assert.deepEqual(detail.bill_nos.split(', ').sort(), [first.document.document_no, second.document.document_no].sort());
    assert.equal(detail.tests, 'HB, SGOT, SGPT');
    assert.equal((await desk.refused('POST', C(`lab/orders/${order1.id}/bill`), { requestKey: key() }, 409)).message, 'Every test on this order is billed already');
    assert.equal((await desk.refused('POST', C(`lab/orders/${order1.id}/bill`), { requestKey: key(), orderTestIds: [esrRow.id] }, 409)).message, 'ESR was cancelled: it is not billed');
    // Its bills are ordinary sales; the order keeps the first.
    assert.equal(Number((await one('SELECT document_id FROM lab_orders WHERE id=$1', [order1.id])).document_id), first.document.id);
    assert.equal((await request('GET', C(`documents/${second.document.id}`))).lines[0].label, 'Liver function tests');
    // The audit and the events, with the order.
    assert.equal(await auditCount('lab.tests_billed', order1.id), 2);
    assert.equal(await auditCount('lab.test_cancelled', order1.id), 1);
    const events = await rows("SELECT kind,payload FROM business_events WHERE business_id=$1 AND entity_type='lab_order' AND entity_id=$2 AND kind='lab.tests_billed' ORDER BY id",
      [clinic.id, order1.id]);
    assert.deepEqual(events.map((e) => e.payload.tests), [['HB'], ['LFT']]);
    // Another owner's clinic, a clinic with the lab off, a grocery.
    await other('POST', C(`lab/orders/${order1.id}/bill`), { requestKey: key() }, 404);
    await request('POST', `/businesses/${plain.id}/lab/orders/${order1.id}/bill`, { requestKey: key() }, 403);
    await request('POST', `/businesses/${grocery.id}/lab/orders/${order1.id}/bill`, { requestKey: key() }, 404);
    await desk.call('POST', C(`lab/orders/${order1.id}/bill`), { orderTestIds: [hbRow.id] }, 400);
  });

  await t.test('the database keeps each test\'s bill line: once, on its own patient\'s bill, a line no other test holds', async () => {
    const hbRow = await rowOf(order1.id, hb.id), esrRow = await rowOf(order1.id, esr.id);
    const otherLine = (await linesOf((await one("SELECT id FROM business_documents WHERE business_id=$1 AND kind='sale' AND id<>$2 ORDER BY id DESC LIMIT 1", [clinic.id, receipt.id])).id))[0];
    await assert.rejects(pool.query('UPDATE lab_order_tests SET document_line_id=$2 WHERE id=$1', [hbRow.id, otherLine.id]), /billed already; a test is billed only once/);
    // A second order, unbilled, and a bill on Sales for each patient.
    const order2 = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: lakshmi.contact_id, testIds: [hb.id] }, 201);
    const sale = (patient) => desk.call('POST', C('documents'), { kind: 'sale', requestKey: key(), locationId: main.id, contactId: patient.contact_id, lines: [{ skuId: hbService.id, quantity: '1' }] }, 201);
    const swathiBill = await sale(swathi), lakshmiBill = await sale(lakshmi);
    const order2Row = await rowOf(order2.id, hb.id);
    await assert.rejects(pool.query('UPDATE lab_order_tests SET document_line_id=$2 WHERE id=$1', [order2Row.id, (await linesOf(swathiBill.id))[0].id]), /billed on a bill to its own patient/);
    await assert.rejects(pool.query('UPDATE lab_order_tests SET document_line_id=$2 WHERE id=$1', [order2Row.id, hbRow.document_line_id]), /That bill line is another test's already/);
    await assert.rejects(pool.query('UPDATE lab_order_tests SET document_line_id=$2 WHERE id=$1', [esrRow.id, (await linesOf(lakshmiBill.id))[0].id]), /A cancelled test is not billed/);
    await assert.rejects(pool.query('UPDATE lab_order_tests SET cancelled_at=NULL,cancelled_by=NULL,cancel_reason=NULL WHERE id=$1', [esrRow.id]), /A cancelled test stays cancelled/);
    await assert.rejects(pool.query('DELETE FROM lab_order_tests WHERE id=$1', [order2Row.id]), /An ordered test is not deleted/);
    // The desk's bill on Sales, named as the order is made: its line for the test is linked.
    const named = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: lakshmi.contact_id, testIds: [hb.id], documentId: lakshmiBill.id }, 201);
    assert.equal(named.billing.state, 'billed');
    assert.equal(Number((await rowOf(named.id, hb.id)).document_line_id), (await linesOf(lakshmiBill.id))[0].id);
    assert.equal((await desk.refused('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: lakshmi.contact_id, testIds: [hb.id], documentId: lakshmiBill.id }, 409)).message,
      'That bill has none of these tests on it');
    assert.equal((await desk.refused('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: lakshmi.contact_id, testIds: [hb.id], documentId: swathiBill.id }, 409)).message,
      'That bill is not this patient\'s');
    // Billed as it is ordered: each test on its line of that bill.
    const atOnce = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: swathi.contact_id, testIds: [hb.id, lft.id], bill: true,
      payment: { amount: 'full', method: 'cash' } }, 201);
    assert.equal(atOnce.billing.state, 'billed');
    assert.equal(atOnce.billing.bills.length, 1);
    assert.equal(Number((await one('SELECT total FROM business_documents WHERE id=$1', [atOnce.document_id])).total), 750);
    assert.equal((await desk.refused('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: swathi.contact_id, testIds: [esr.id], bill: true }, 400)).message,
      'None of these tests has a service to bill it as (Lab orders › Tests & panels, Billed as); order them without billing, or bill them on the Sales screen');
  });

  let visitOrder;
  await t.test('with the visit\'s bill: the consultation and the visit\'s ordered tests on one bill, each test on its own line', async () => {
    const visit = await desk.call('POST', C('clinic/visits'), { contactId: swathi.contact_id, resourceId: ravi.id }, 201);
    // The doctor orders; a doctor does not bill.
    visitOrder = await doctor.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, visitId: visit.id, testIds: [hb.id, lft.id] }, 201);
    await doctor.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, visitId: visit.id, testIds: [hb.id], bill: true }, 403);
    const hbRow = await rowOf(visitOrder.id, hb.id), sgotRow = await rowOf(visitOrder.id, sgot.id);
    const front = await desk.call('GET', C(`clinic/visits/${visit.id}`));
    assert.equal(front.clinical_access, false);
    assert.deepEqual(front.lab_orders.map((o) => [o.order_no, o.billing, o.bill_nos]), [[visitOrder.order_no, 'none', []]]);
    assert.deepEqual(front.lab_to_bill.map((u) => [u.order_no, u.kind, u.code, u.price]), [[visitOrder.order_no, 'test', 'HB', '150.00'], [visitOrder.order_no, 'profile', 'LFT', '600.00']]);
    // A test is billed as that test, never as a line of its own beside it; a test of another visit is not this visit's.
    assert.equal((await desk.refused('POST', C(`clinic/visits/${visit.id}/bill`), { requestKey: key(), lines: [{ skuId: hbService.id }], labTests: [hbRow.id] }, 409)).message,
      'A test ordered for this visit is billed as that test: tick it under Tests, not as a line of its own');
    assert.equal((await desk.refused('POST', C(`clinic/visits/${visit.id}/bill`), { requestKey: key(), labTests: [(await rowOf(order1.id, hb.id)).id] }, 404)).message,
      'That test was not ordered for this visit');
    const visitKey = key();
    const billed = await desk.call('POST', C(`clinic/visits/${visit.id}/bill`), { requestKey: visitKey, labTests: [hbRow.id, sgotRow.id], payment: { amount: 'full', method: 'upi' } }, 201);
    // 500 consultation + 150 haemoglobin + 600 liver function tests, to the paisa.
    assert.equal(Number(billed.document.total), 1250);
    const lines = await linesOf(billed.document.id);
    assert.deepEqual(lines.map((l) => [Number(l.sku_id), l.net]), [[consultation.id, '500.00'], [hbService.id, '150.00'], [lftService.id, '600.00']]);
    assert.deepEqual((await rowsOf(visitOrder.id)).map((r) => Number(r.document_line_id)), [lines[1].id, lines[2].id, lines[2].id]);
    const after = await desk.call('GET', C(`clinic/visits/${visit.id}`));
    assert.deepEqual([after.document_no, after.lab_to_bill, after.lab_orders[0].billing, after.lab_orders[0].bill_nos], [billed.document.document_no, [], 'billed', [billed.document.document_no]]);
    // The same request again is the same bill.
    assert.equal((await desk.call('POST', C(`clinic/visits/${visit.id}/bill`), { requestKey: visitKey, labTests: [hbRow.id, sgotRow.id], payment: { amount: 'full', method: 'upi' } }, 201)).document.id,
      billed.document.id);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='visit.billed' AND entity_id=$2", [clinic.id, visit.id]);
    assert.deepEqual(audit.details.tests, ['HB', 'LFT']);
    const tested = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='lab.tests_billed' AND entity_id=$2", [clinic.id, visitOrder.id]);
    assert.deepEqual([tested.details.tests, tested.details.withVisitBill], [['HB', 'LFT'], true]);

    // Part with the visit's bill, the rest from the order later.
    const second = await desk.call('POST', C('clinic/visits'), { contactId: lakshmi.contact_id, resourceId: ravi.id }, 201);
    const order = await doctor.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, visitId: second.id, testIds: [hb.id, lft.id] }, 201);
    await desk.call('POST', C(`clinic/visits/${second.id}/bill`), { requestKey: key(), labTests: [(await rowOf(order.id, hb.id)).id] }, 201);
    assert.deepEqual((await desk.call('GET', C(`clinic/visits/${second.id}`))).lab_to_bill.map((u) => u.code), ['LFT']);
    const rest = await desk.call('POST', C(`lab/orders/${order.id}/bill`), { requestKey: key() }, 201);
    assert.deepEqual([Number(rest.document.total), rest.billing.state], [600, 'billed']);
  });

  await t.test('the referral commission is a share of what the tests were billed at, not of the visit\'s bill', async () => {
    await request('PUT', C('health/settings'), { referralCommissionEnabled: true, referralCommissionPercent: 10 });
    const referred = await desk.call('POST', C(`lab/orders/${visitOrder.id}/refer`), { outsideLab: 'Metro reference lab' });
    // 10% of 150 + 600, not of the 1,250 with the consultation.
    assert.equal(referred.referral_commission, '75.00');
  });

  await t.test('one test cancelled: the rest go on, a billed one says its bill, the last one cancels the order', async () => {
    // Haemoglobin and ESR on one blood sample: the haemoglobin's result typed, the ESR cancelled, the report ready to sign.
    const order = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: lakshmi.contact_id, testIds: [hb.id, esr.id] }, 201);
    const sample = order.samples[0];
    await tech.call('POST', C(`lab/samples/${sample.id}`), { action: 'collect' });
    await tech.call('POST', C(`lab/samples/${sample.id}`), { action: 'receive' });
    const hbRow = await rowOf(order.id, hb.id), esrRow = await rowOf(order.id, esr.id);
    await tech.call('PUT', C(`lab/orders/${order.id}/results`), { results: [{ orderTestId: hbRow.id, parameterId: hb.parameters[0].id, value: '11.2' }] });
    assert.equal((await tech.refused('POST', C(`lab/orders/${order.id}/tests/${hbRow.id}/cancel`), { reason: 'Repeat' }, 409)).message,
      'Results are typed for Haemoglobin: clear them before cancelling it');
    await tech.call('POST', C(`lab/orders/${order.id}/tests/${esrRow.id}/cancel`), {}, 400);
    await doctor.call('POST', C(`lab/orders/${order.id}/tests/${esrRow.id}/cancel`), { reason: 'Not needed' });
    const cancelled = await tech.call('POST', C(`lab/orders/${order.id}/tests/${esrRow.id}/cancel`), { reason: 'Asked again' });
    assert.deepEqual([cancelled.status, cancelled.repeated], ['resulted', true]);
    const esrTest = cancelled.tests.find((x) => x.code === 'ESR');
    assert.deepEqual([esrTest.cancel_reason, esrTest.cancelled_by_name], ['Not needed', 'doctor']);
    assert.equal((await tech.refused('PUT', C(`lab/orders/${order.id}/results`), { results: [{ orderTestId: esrRow.id, parameterId: esr.parameters[0].id, value: '12' }] }, 409)).message,
      'This test was cancelled: no result is typed for it');
    // The bench leaves it out: the tech's worklist sees the haemoglobin only, in its department.
    const bench = await tech.call('GET', C('lab/bench'));
    const onBench = bench.orders.find((o) => o.id === order.id);
    assert.deepEqual(onBench.tests.map((x) => [x.code, x.department]), [['HB', 'Haematology']]);
    assert.deepEqual(bench.my_departments, [dep('haematology').id]);
    assert.ok(bench.departments.some((d) => d.name === 'Molecular diagnostics' && d.code === null));
    assert.deepEqual((await desk.call('GET', C('lab/bench'))).my_departments, []);
    // Signed, the order is closed, and the report has no ESR.
    await patho.call('POST', C(`lab/orders/${order.id}/approve`), { signoff: { signatoryId: pathologist.id, pin: '2468' } });
    assert.equal((await tech.refused('POST', C(`lab/orders/${order.id}/tests/${hbRow.id}/cancel`), { reason: 'Late' }, 409)).message, 'This order is closed');
    assert.deepEqual((await doctor.call('GET', C(`lab/orders/${order.id}/report`))).tests.map((x) => x.code), ['HB']);

    // A sample only a cancelled test needed is not collected.
    const withUrine = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: lakshmi.contact_id, testIds: [hb.id, urine.id] }, 201);
    const urineRow = await rowOf(withUrine.id, urine.id);
    const urineSample = withUrine.samples.find((s) => s.sample_type === 'urine');
    const after = await desk.call('POST', C(`lab/orders/${withUrine.id}/tests/${urineRow.id}/cancel`), { reason: 'Could not give a sample' });
    assert.equal(after.samples.find((s) => s.id === urineSample.id).needed, false);
    assert.equal((await desk.refused('POST', C(`lab/samples/${urineSample.id}`), { action: 'collect' }, 409)).message, 'Every test of this sample was cancelled: it is not needed');
    assert.deepEqual((await tech.call('GET', C('lab/bench'))).orders.find((o) => o.id === withUrine.id).samples.map((s) => s.sample_type), ['blood']);
    // The last test cancels the order.
    const last = await desk.call('POST', C(`lab/orders/${withUrine.id}/tests/${(await rowOf(withUrine.id, hb.id)).id}/cancel`), { reason: 'Patient left' });
    assert.deepEqual([last.status, last.cancel_reason], ['cancelled', 'Patient left']);
    assert.equal((await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='lab.order_cancelled' AND entity_id=$2", [clinic.id, withUrine.id])).details.lastTest, 'HB');
    // A billed test cancelled: the answer names its bill, for the return on Sales.
    const billedOrder = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: swathi.contact_id, testIds: [hb.id, esr.id], bill: true }, 201);
    const billedHb = await desk.call('POST', C(`lab/orders/${billedOrder.id}/tests/${(await rowOf(billedOrder.id, hb.id)).id}/cancel`), { reason: 'Done elsewhere' });
    assert.equal(billedHb.cancelled_test.billed_on, billedOrder.billing.bills[0].document_no);
    assert.equal((await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='lab.test_cancelled' AND entity_id=$2", [clinic.id, billedOrder.id])).details.billedOn,
      billedOrder.billing.bills[0].document_no);
    await other('POST', C(`lab/orders/${billedOrder.id}/tests/1/cancel`), { reason: 'x' }, 404);
    await desk.call('POST', C(`lab/orders/${billedOrder.id}/tests/999999/cancel`), { reason: 'x' }, 404);
  });

  await t.test('a test billed or cancelled is announced on the live stream as its order', async () => {
    listener = new Client({ ...connection, database });
    await listener.connect();
    const heard = [];
    listener.on('notification', (message) => { if (message.channel === 'live_change') heard.push(JSON.parse(message.payload)); });
    await listener.query('LISTEN live_change');
    const until = async (check) => { for (let i = 0; i < 50 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100)); return check(); };
    const order = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: swathi.contact_id, testIds: [hb.id, esr.id] }, 201);
    // The order's own announcements first, then each change after them.
    await until(() => heard.some((m) => m.area === 'lab' && m.id === order.id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    heard.length = 0;
    await desk.call('POST', C(`lab/orders/${order.id}/tests/${(await rowOf(order.id, esr.id)).id}/cancel`), { reason: 'Not needed' });
    assert.ok(await until(() => heard.some((m) => m.area === 'lab' && m.id === order.id && m.business === clinic.id && m.location === main.id)), JSON.stringify(heard));
    heard.length = 0;
    await desk.call('POST', C(`lab/orders/${order.id}/bill`), { requestKey: key() }, 201);
    assert.ok(await until(() => heard.some((m) => m.area === 'lab' && m.id === order.id)), JSON.stringify(heard));
  });

  let paracetamol, amoxicillin, ibuprofen, aspirin;
  await t.test('the clinic\'s drug list: kept by the doctors, one entry per generic, strength and form', async () => {
    const add = (body, by = doctor) => by.call('POST', C('clinic/drugs'), body, 201);
    paracetamol = await add({ genericName: 'Paracetamol', brandNames: 'Dolo, Calpol', strength: '650 mg', form: 'Tablet', route: 'Oral', usualDose: '1 tab', usualFrequency: '1-1-1',
      maxDailyAmount: '4000', maxDailyUnit: 'mg' });
    assert.deepEqual([paracetamol.generic_name, paracetamol.max_daily_amount, paracetamol.max_daily_unit, paracetamol.active], ['Paracetamol', '4000.000', 'mg', true]);
    amoxicillin = await add({ genericName: 'Amoxicillin', strength: '500 mg', form: 'Capsule', usualDose: '1 cap', usualFrequency: 'TDS', maxDailyAmount: 3, maxDailyUnit: 'g',
      allergyGroup: 'Penicillins' });
    ibuprofen = await add({ genericName: 'Ibuprofen', brandNames: 'Brufen', strength: '400 mg', form: 'Tablet', usualDose: '1 tab', usualFrequency: 'TDS', maxDailyAmount: 2400,
      maxDailyUnit: 'mg', allergyGroup: 'NSAIDs' });
    // The owner keeps it too.
    aspirin = await request('POST', C('clinic/drugs'), { genericName: 'Aspirin', strength: '75 mg', form: 'Tablet', allergyGroup: 'NSAIDs' }, 201);
    assert.equal(await auditCount('clinic_drug.created'), 4);
    assert.equal((await doctor.refused('POST', C('clinic/drugs'), { genericName: 'paracetamol', strength: '650 MG', form: 'tablet' }, 409)).message,
      'paracetamol 650 MG tablet is on the drug list already');
    assert.equal((await doctor.refused('POST', C('clinic/drugs'), { genericName: 'Cetirizine', maxDailyAmount: 10 }, 400)).message, 'Give the most a day as an amount and its unit, or neither');
    assert.match((await doctor.refused('POST', C('clinic/drugs'), { genericName: 'Cetirizine', maxDailyAmount: 10, maxDailyUnit: 'spoons' }, 400)).message, /^The most a day is in mg, g, mcg/);
    await doctor.call('POST', C('clinic/drugs'), { strength: '10 mg' }, 400);
    // The doctors keep it (patients.edit_clinical); the desk and the lab do not, nor another business.
    await desk.call('POST', C('clinic/drugs'), { genericName: 'Cetirizine' }, 403);
    await tech.call('GET', C('clinic/drugs'), undefined, 403);
    await desk.call('GET', C('clinic/drugs/picker'), undefined, 403);
    await other('GET', C('clinic/drugs'), undefined, 404);
    await request('GET', `/businesses/${grocery.id}/clinic/drugs`, undefined, 403);
    // Switched off: offered on no new prescription, still on the list.
    const off = await doctor.call('PUT', C(`clinic/drugs/${aspirin.id}`), { active: false });
    assert.deepEqual([off.active, off.allergy_group], [false, 'NSAIDs']);
    assert.equal(await auditCount('clinic_drug.switched_off', aspirin.id), 1);
    assert.deepEqual((await doctor.call('GET', C('clinic/drugs/picker'))).map((d) => d.generic_name), ['Amoxicillin', 'Ibuprofen', 'Paracetamol']);
    assert.deepEqual((await doctor.call('GET', C('clinic/drugs?active=false'))).items.map((d) => d.generic_name), ['Aspirin']);
    assert.deepEqual((await doctor.call('GET', C('clinic/drugs?q=brufen'))).items.map((d) => d.generic_name), ['Ibuprofen']);
    const renamed = await doctor.call('PUT', C(`clinic/drugs/${paracetamol.id}`), { usualFrequency: 'TDS' });
    assert.deepEqual([renamed.usual_frequency, renamed.brand_names, renamed.max_daily_amount], ['TDS', 'Dolo, Calpol', '4000.000']);
    await doctor.call('PUT', C(`clinic/drugs/${paracetamol.id}`), { usualFrequency: '1-1-1' });
    await doctor.call('PUT', C(`clinic/drugs/${amoxicillin.id}`), { genericName: 'Paracetamol', strength: '650 mg', form: 'Tablet' }, 409);
  });

  await t.test('the drug list from a spreadsheet: a check first, then all of it or nothing', async () => {
    const guide = await doctor.call('GET', C('clinic/drugs/import-guide'));
    assert.deepEqual(guide.columns.map((c) => c.label), ['Generic name', 'Brand names', 'Strength', 'Form', 'Route', 'Usual dose', 'How often', 'Most a day', 'Allergy group', 'In use']);
    const file = [
      { 'Generic name': 'Cetirizine', Strength: '10 mg', Form: 'Tablet', 'Usual dose': '1 tab', 'How often': 'HS', 'Most a day': '10 mg', 'Allergy group': '' },
      { 'Generic name': 'paracetamol', Strength: '650 mg', Form: 'TABLET', 'Brand names': 'Dolo, Calpol, Crocin' },
      { 'Generic name': 'Metformin', Strength: '500 mg', Form: 'Tablet', 'Most a day': 'lots' },
    ];
    const bad = await doctor.call('POST', C('clinic/drugs/import'), { rows: file, dryRun: true });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.problems.map((p) => [p.line, p.column]), [[4, 'max']]);
    assert.equal((await doctor.refused('POST', C('clinic/drugs/import'), { rows: file }, 400)).message, '1 problem in the file. Nothing was imported.');
    file[2]['Most a day'] = '2000 mg';
    const check = await doctor.call('POST', C('clinic/drugs/import'), { rows: file, dryRun: true });
    assert.deepEqual([check.ok, check.created, check.updated, check.unchanged], [true, 2, 1, 0]);
    assert.deepEqual(check.rows.find((r) => r.line === 3).changes.map((c) => [c.label, c.from, c.to]), [['Brand names', 'Dolo, Calpol', 'Dolo, Calpol, Crocin']]);
    await desk.call('POST', C('clinic/drugs/import'), { rows: file, dryRun: true }, 403);
    const done = await doctor.call('POST', C('clinic/drugs/import'), { rows: file, fingerprint: check.fingerprint, fileName: 'drugs.csv' });
    assert.deepEqual([done.created, done.updated], [2, 1]);
    const metformin = await one("SELECT * FROM health_clinic_drugs WHERE business_id=$1 AND generic_name='Metformin'", [clinic.id]);
    assert.deepEqual([metformin.max_daily_amount, metformin.max_daily_unit, metformin.active], ['2000.000', 'mg', true]);
    assert.equal((await one('SELECT brand_names FROM health_clinic_drugs WHERE id=$1', [paracetamol.id])).brand_names, 'Dolo, Calpol, Crocin');
    // The same file again changes nothing; a preview that went stale is refused.
    const twice = await doctor.call('POST', C('clinic/drugs/import'), { rows: file, dryRun: true });
    assert.deepEqual([twice.created, twice.updated, twice.unchanged], [0, 0, 3]);
    file[0]['Usual dose'] = '2 tab';
    const stale = await doctor.refused('POST', C('clinic/drugs/import'), { rows: file, fingerprint: twice.fingerprint }, 409);
    assert.equal(stale.data.reason, 'stale_preview');
    assert.equal(await auditCount('clinic_drug.imported'), 1);
  });

  await t.test('the prescription picks from the list; its warnings are shown first and kept with the doctor\'s reason', async () => {
    const farida = await register('Farida Begum', '9000000303');
    await doctor.call('PUT', C(`clinic/patients/${farida.contact_id}/clinical`), { allergies: 'Penicillin (rash); aspirin' });
    const visit = await desk.call('POST', C('clinic/visits'), { contactId: farida.contact_id, resourceId: ravi.id }, 201);
    const prescription = [
      { drugId: amoxicillin.id, drugName: 'Amoxicillin', dose: '1 cap', frequency: 'TDS', duration: '5 days' },
      { drugId: paracetamol.id, drugName: 'Paracetamol', dose: '2 tab', frequency: '1-1-1-1', duration: '3 days' },
      { drugId: ibuprofen.id, drugName: 'Ibuprofen', dose: '1 tab', frequency: 'TDS' },
      { drugName: 'Paracetamol', dose: '1', frequency: 'SOS' },
    ];
    // Before saving: the warnings, nothing written.
    const audits = (await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1', [clinic.id])).n;
    const shown = await doctor.call('POST', C(`clinic/visits/${visit.id}/prescription-check`), { prescription });
    assert.deepEqual(shown.warnings.map((w) => [w.line, w.kind]), [[0, 'allergy'], [1, 'dose_over_max'], [2, 'allergy'], [3, 'same_medicine']]);
    assert.equal(shown.warnings[0].message, 'Allergy: the patient\'s allergies say "Penicillin (rash)", and Amoxicillin is in Penicillins.');
    assert.equal(shown.warnings[1].message, 'Paracetamol: 2 tab 1-1-1-1 is 5,200 mg a day, more than the most of 4,000 mg a day.');
    assert.equal(shown.warnings[2].message, 'Allergy: the patient\'s allergies say "aspirin", a medicine in NSAIDs, and Ibuprofen is in NSAIDs too.');
    assert.equal((await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1', [clinic.id])).n, audits);
    await desk.call('POST', C(`clinic/visits/${visit.id}/prescription-check`), { prescription }, 403);
    // Saved without reasons: refused, and nothing of the save is kept.
    const stopped = await doctor.refused('PATCH', C(`clinic/visits/${visit.id}`), { complaints: 'Fever and sore throat', prescription }, 409);
    assert.equal(stopped.message, 'The prescription has 4 warnings: give your reason to go on with each, or change the prescription.');
    assert.equal(stopped.data.reason, 'prescription_warnings');
    assert.deepEqual(stopped.data.warnings.map((w) => [w.line, w.kind, w.drug]), [[0, 'allergy', 'Amoxicillin'], [1, 'dose_over_max', 'Paracetamol'], [2, 'allergy', 'Ibuprofen'],
      [3, 'same_medicine', 'Paracetamol']]);
    assert.equal((await one('SELECT count(*)::int AS n FROM health_prescription_items WHERE visit_id=$1', [visit.id])).n, 0);
    assert.equal((await one('SELECT complaints FROM health_visits WHERE id=$1', [visit.id])).complaints, null);
    const oneLeft = await doctor.refused('PATCH', C(`clinic/visits/${visit.id}`), { prescription: [prescription[0]] }, 409);
    assert.equal(oneLeft.message, 'Allergy: the patient\'s allergies say "Penicillin (rash)", and Amoxicillin is in Penicillins. Give your reason to go on, or change the prescription.');
    // With a reason for each, the doctor goes on: the warnings are kept with the lines.
    const reasons = [{ allergy: 'Took amoxicillin last year with no reaction; watched for 30 minutes' }, { dose_over_max: 'Two days only, under watch' },
      { allergy: 'No reaction to ibuprofen before' }, { same_medicine: 'Only if the fever comes back at night' }];
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { complaints: 'Fever and sore throat', prescription: prescription.map((p, i) => ({ ...p, reasons: reasons[i] })) });
    const kept = await rows('SELECT * FROM health_prescription_items WHERE visit_id=$1 ORDER BY sort_order', [visit.id]);
    assert.deepEqual(kept.map((k) => [k.drug_id === null ? null : Number(k.drug_id), k.drug_name, k.strength]), [[amoxicillin.id, 'Amoxicillin', '500 mg'],
      [paracetamol.id, 'Paracetamol', '650 mg'], [ibuprofen.id, 'Ibuprofen', '400 mg'], [null, 'Paracetamol', null]]);
    assert.deepEqual(kept[0].warnings, [{ kind: 'allergy', message: shown.warnings[0].message, reason: reasons[0].allergy }]);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='visit.updated' AND entity_id=$2 ORDER BY id DESC LIMIT 1", [clinic.id, visit.id]);
    assert.deepEqual(audit.details.warnings.map((w) => [w.drug, w.kind]), [['Amoxicillin', 'allergy'], ['Paracetamol', 'dose_over_max'], ['Ibuprofen', 'allergy'], ['Paracetamol', 'same_medicine']]);
    // The doctor reads them back with the lines; the front desk sees no prescription.
    const read = await doctor.call('GET', C(`clinic/visits/${visit.id}`));
    assert.deepEqual(read.prescription.map((p) => [p.on_list, p.form]), [[true, 'Capsule'], [true, 'Tablet'], [true, 'Tablet'], [false, null]]);
    assert.equal(read.prescription[1].warnings[0].reason, 'Two days only, under watch');
    assert.equal((await desk.call('GET', C(`clinic/visits/${visit.id}`))).prescription, undefined);
    // Another clinic's medicine is not on this list; the database keeps a warning only with its reason.
    const theirs = await other('POST', E('clinic/drugs'), { genericName: 'Paracetamol' }, 201);
    assert.equal((await doctor.refused('PATCH', C(`clinic/visits/${visit.id}`), { prescription: [{ drugId: theirs.id, drugName: 'Paracetamol' }] }, 404)).message,
      'Medicine 1 is not on the clinic\'s drug list');
    await assert.rejects(pool.query(`INSERT INTO health_prescription_items(business_id,visit_id,drug_name,warnings) VALUES($1,$2,'Amoxicillin','[{"kind":"allergy","message":"x"}]')`,
      [clinic.id, visit.id]), /health_prescription_items_warnings_answered/);

    // Completing checks again: an allergy recorded since stops it until the doctor gives a reason.
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { diagnosis: 'Pharyngitis', prescription: [{ drugId: paracetamol.id, drugName: 'Paracetamol', dose: '1 tab', frequency: 'TDS' }] });
    await doctor.call('PUT', C(`clinic/patients/${farida.contact_id}/clinical`), { allergies: 'Penicillin (rash); aspirin; paracetamol' });
    const late = await doctor.refused('PATCH', C(`clinic/visits/${visit.id}`), { complete: true }, 409);
    assert.deepEqual([late.data.reason, late.data.warnings.map((w) => w.kind)], ['prescription_warnings', ['allergy']]);
    assert.equal((await one('SELECT status FROM health_visits WHERE id=$1', [visit.id])).status, 'open');
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { prescription: [{ drugId: paracetamol.id, drugName: 'Paracetamol', dose: '1 tab', frequency: 'TDS',
      reasons: { allergy: 'A mild rash only, years ago; the patient asks for it' } }], complete: true });
    assert.equal((await one('SELECT status FROM health_visits WHERE id=$1', [visit.id])).status, 'completed');
    // The medicines prescribed before are still offered.
    assert.ok((await doctor.call('GET', C('clinic/medicines'))).some((m) => m.drug_name === 'Paracetamol'));
  });

  await t.test('Up again keeps the tests kept before in Other and the tests of orders billed as they were ordered on their lines', async () => {
    const atOnce = await one("SELECT id,document_id FROM lab_orders WHERE business_id=$1 AND contact_id=$2 AND document_id IS NOT NULL ORDER BY id LIMIT 1", [clinic.id, swathi.contact_id]);
    const before = await rowsOf(atOnce.id);
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    await migrate({ direction: 'up', count: Infinity });
    const departments = await rows('SELECT code FROM lab_departments WHERE business_id=$1 ORDER BY sort_order', [clinic.id]);
    assert.equal(departments.length, 8);
    assert.deepEqual((await rows('SELECT DISTINCT d.code FROM lab_tests t JOIN lab_departments d ON d.id=t.department_id WHERE t.business_id=$1', [clinic.id])).map((d) => d.code), ['other']);
    assert.deepEqual((await rowsOf(atOnce.id)).map((r) => r.document_line_id), before.map((r) => r.document_line_id));
  });
});
