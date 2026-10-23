const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom } = require('./helpers/dates');

// Pharmacy and clinic / lab rules. Drug master and
// substitutes, prescription sales (Schedule H / H1 / X) with the scan, the H1
// and X registers, the pharmacist's PIN, strip / loose sale, batch recall and
// blocking, expiry returns as debit notes; patients with DPDP consent,
// clinical data only for clinical roles (each view logged), consultations
// locked once completed, lab orders through samples, results with flags,
// pathologist approval by PIN and the report; plus refused roles, switched-off
// rules and other businesses. Runs on its own throwaway database.
test('pharmacy and clinic / lab rules', { timeout: 300000 }, async (t) => {
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
  const password = `Health-${crypto.randomBytes(8).toString('hex')}`;
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const ownerUser = await owner('health-owner');
  await owner('health-other');
  const token = await login('health-owner@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(token);
  const other = as(await login('health-other@test.invalid'));
  const key = () => crypto.randomUUID();
  // The pharmacy's and the clinic's own dates (India's), not the UTC date.
  const day = (offset) => daysFrom(offset);

  const [pharmacy, clinic, grocery] = await createBusinesses(request, 'OWNER', ['pharmacy', 'healthcare', 'grocery']);
  const P = (s) => `/businesses/${pharmacy.id}/${s}`;
  const C = (s) => `/businesses/${clinic.id}/${s}`;

  // Staff of the owner's restaurant, each with one role (and a PIN).
  async function staff(business, email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash,pin_hash,pin_set_at) VALUES($1,$2,$3,$4,$5,now()) RETURNING id',
      [ownerUser.restaurant_id, email.split('@')[0], email, hash, pinHash]);
    const roles = (await request('GET', `/businesses/${business.id}/roles?limit=100`)).items;
    const role = roles.find((r) => r.template_code === template);
    assert.ok(role, `role ${template} exists in ${business.business_type}`);
    await request('POST', `/businesses/${business.id}/members`, { userId: user.id, roleId: role.id }, 201);
    return { id: user.id, call: as(await login(email)) };
  }

  await t.test('new modules, roles and permissions per type', async () => {
    const ctx = await request('GET', P('context'));
    assert.ok(ctx.capabilities.includes('pharmacy'));
    const cctx = await request('GET', C('context'));
    assert.ok(cctx.capabilities.includes('patients') && !cctx.capabilities.includes('lab'));
    const roles = (await request('GET', C('roles?limit=100'))).items.map((r) => r.template_code);
    assert.ok(roles.includes('doctor') && roles.includes('pathologist') && roles.includes('lab_technician'));
    assert.ok(!roles.includes('pharmacist'));
    const groceryRoles = (await request('GET', `/businesses/${grocery.id}/roles?limit=100`)).items.map((r) => r.template_code);
    assert.ok(!groceryRoles.includes('doctor') && !groceryRoles.includes('pharmacist'));
    await request('GET', `/businesses/${grocery.id}/pharmacy/drugs`, undefined, 404);
    await other('GET', P('pharmacy/drugs'), undefined, 404);
  });

  const location = (await request('GET', P('locations'))).items[0];
  const supplier = await request('POST', P('contacts'), { kind: 'supplier', name: 'Murugan Medical Agencies' }, 201);
  const five = (await request('GET', P('tax-rates'))).items.find((r) => Number(r.rate) === 5);
  const item = (body) => request('POST', P('catalog'), { kind: 'goods', unit: 'tablet', tracking: 'batch', taxRateId: five.id, hsnCode: '3004', ...body }, 201);
  const cefixime = await item({ name: 'Cefixime 200 mg tablets', code: 'CFX', price: '11' });
  const cefiximeGeneric = await item({ name: 'Cefixime 200 mg generic', code: 'CFXG', price: '7' });
  const mph = await item({ name: 'Methylphenidate 10 mg', code: 'MPH', price: '6' });
  const pcm = await request('POST', P('catalog'), { kind: 'goods', unit: 'strip', tracking: 'batch', taxRateId: five.id, name: 'Paracetamol 650 strip', code: 'PCM', price: '30' }, 201);
  let pharmacist, counter;

  await t.test('drug master, packs and substitutes', async () => {
    await request('PUT', P(`pharmacy/drugs/${cefixime.id}`), { composition: 'Cefixime', strength: '200 mg', form: 'tablet', manufacturer: 'Alkem', schedule: 'H1', unitsPerStrip: 10, stripsPerBox: 10 });
    await request('PUT', P(`pharmacy/drugs/${cefiximeGeneric.id}`), { composition: ' cefixime ', strength: '200 MG', schedule: 'H1', unitsPerStrip: 10, looseSale: true });
    await request('PUT', P(`pharmacy/drugs/${mph.id}`), { composition: 'Methylphenidate', strength: '10 mg', schedule: 'X', unitsPerStrip: 10, looseSale: true });
    await request('PUT', P(`pharmacy/drugs/${pcm.id}`), { composition: 'Paracetamol', strength: '650 mg', schedule: 'none', unitsPerStrip: 15 });
    // A strip-stocked item cannot be cut loose.
    await request('PUT', P(`pharmacy/drugs/${pcm.id}`), { composition: 'Paracetamol', schedule: 'none', unitsPerStrip: 15, looseSale: true }, 400);
    const detail = await request('GET', P(`pharmacy/drugs/${cefixime.id}`));
    assert.deepEqual(detail.packs.map((p) => [p.unit_code, Number(p.quantity_in_base)]), [['strip', 10], ['box', 100]]);
    assert.equal(detail.substitutes.length, 1);
    assert.equal(detail.substitutes[0].id, cefiximeGeneric.id);
    const listed = await request('GET', P('pharmacy/drugs?schedule=H1'));
    assert.equal(listed.total, 2);
    for (const [sku, lots] of [[cefixime, [['CFA', 2, 20], ['CFB', 5, 400]]], [mph, [['MPA', 3, 300]]], [pcm, [['PCA', 10, 300]]]]) {
      await request('POST', P('documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), supplierBillNo: `B-${sku.code}`,
        lines: lots.map(([lotCode, qty, days]) => ({ skuId: sku.id, quantity: String(qty), ...(sku.unit === 'tablet' ? { unit: 'strip' } : {}), unitPrice: '50', lotCode, expiresOn: day(days) })) }, 201);
    }
    pharmacist = await staff(pharmacy, 'pharmacist@test.invalid', 'pharmacist');
    counter = await staff(pharmacy, 'counter@test.invalid', 'cashier');
    await counter.call('PUT', P(`pharmacy/drugs/${pcm.id}`), { composition: 'x' }, 403);
  });

  let sold;
  await t.test('prescription sales, registers and the pharmacist PIN', async () => {
    // A plain bill cannot carry a scheduled medicine (checked by the database at commit).
    const plain = await call('POST', P('documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: cefixime.id, quantity: '10', lotCode: 'CFA' }],
      payment: { amount: 'full', method: 'cash' } }, token);
    assert.equal(plain.status, 409);
    assert.match(plain.body.message, /prescription medicine/);
    const before = await one('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND kind=$2', [pharmacy.id, 'sale']);
    assert.equal(before.n, 0);
    // OTC sells without a prescription; a strip-only drug refuses loose units.
    await counter.call('POST', P('pharmacy/sales'), { requestKey: key(), locationId: location.id, lines: [{ skuId: pcm.id, quantity: '2' }], payment: { amount: 'full', method: 'cash' } }, 201);
    const noRx = await call('POST', P('pharmacy/sales'), { requestKey: key(), locationId: location.id, lines: [{ skuId: cefixime.id, quantity: '1', unit: 'strip' }] }, await login('counter@test.invalid'));
    assert.equal(noRx.status, 409);
    assert.equal(noRx.body.data.reason, 'prescription_required');
    const rx = { patientName: 'Lakshmi R', patientPhone: '9840012345', patientAge: 42, doctorName: 'Dr. K. Raman', doctorRegNo: 'TNMC 65432', prescribedOn: day(0) };
    // The scan is required by default.
    const noScan = await call('POST', P('pharmacy/sales'), { requestKey: key(), locationId: location.id, lines: [{ skuId: cefixime.id, quantity: '1', unit: 'strip' }], prescription: rx }, token);
    assert.equal(noScan.body.data.reason, 'prescription_scan_required');
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2A0D5D10000000049454E44AE426082', 'hex');
    const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), 'rx.png');
    const counterToken = await login('counter@test.invalid');
    const upload = await (await fetch(`${base}${P('pharmacy/prescription-files')}`, { method: 'POST', headers: { Authorization: `Bearer ${counterToken}` }, body: form })).json();
    assert.ok(upload.success, JSON.stringify(upload));
    const bad = new FormData(); bad.append('file', new Blob([Buffer.from('not an image at all')], { type: 'image/png' }), 'x.png');
    assert.equal((await fetch(`${base}${P('pharmacy/prescription-files')}`, { method: 'POST', headers: { Authorization: `Bearer ${counterToken}` }, body: bad })).status, 400);
    // 3 strips: 2 whole strips from the first-to-expire batch, 1 from the next.
    const body = { requestKey: key(), locationId: location.id, lines: [{ skuId: cefixime.id, quantity: '3', unit: 'strip' }], payment: { amount: 'full', method: 'upi' }, prescription: { ...rx, fileId: upload.data.id } };
    sold = await counter.call('POST', P('pharmacy/sales'), body, 201);
    const lines = await pool.query('SELECT lot_code,quantity,entered_unit,entered_quantity FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [pharmacy.id, sold.document.id]);
    assert.deepEqual(lines.rows.map((l) => [l.lot_code, Number(l.quantity), l.entered_unit]), [['CFA', 20, 'strip'], ['CFB', 10, 'strip']]);
    assert.equal(sold.registers.length, 2);
    assert.ok(sold.registers.every((r) => r.register === 'H1' && r.doctor_reg_no === 'TNMC 65432' && r.patient_name === 'Lakshmi R'));
    const retain = await one("SELECT retain_until - (created_at AT TIME ZONE 'Asia/Kolkata')::date AS days FROM pharmacy_register_entries WHERE business_id=$1 LIMIT 1", [pharmacy.id]);
    assert.ok(retain.days >= 365 * 3);
    // The same request again returns the same bill; the scan cannot be reused.
    const again = await counter.call('POST', P('pharmacy/sales'), body, 201);
    assert.equal(again.document.id, sold.document.id);
    assert.equal((await one('SELECT count(*)::int AS n FROM pharmacy_register_entries WHERE business_id=$1', [pharmacy.id])).n, 2);
    // The register and the log; the bill carries the licences and the pharmacist.
    await request('PUT', P('health/settings'), { drugLicence20: 'TN-20-1', drugLicence21: 'TN-21-1', rxScanRequired: false });
    const signer = await request('POST', P('health/signatories'), { kind: 'pharmacist', userId: pharmacist.id, name: 'Meena S.', registrationNo: 'TNPC 4512' }, 201);
    const h1 = await request('GET', P('pharmacy/registers/h1'));
    assert.equal(h1.total, 2);
    const doc = await request('GET', P(`documents/${sold.document.id}`));
    assert.deepEqual(doc.pharmacy.licences.map((l) => l.form), ['20', '21']);
    assert.equal(doc.pharmacy.pharmacist.name, 'Meena S.');
    assert.equal(doc.pharmacy.prescription.doctor_reg_no, 'TNMC 65432');
    // Schedule X: the registered pharmacist's PIN, and a loose sale.
    const xBody = { requestKey: key(), locationId: location.id, lines: [{ skuId: mph.id, quantity: '5' }], prescription: rx, payment: { amount: 'full', method: 'cash' } };
    assert.equal((await call('POST', P('pharmacy/sales'), xBody, counterToken)).body.data.reason, 'pharmacist_signoff');
    assert.equal((await call('POST', P('pharmacy/sales'), { ...xBody, signoff: { signatoryId: signer.id, pin: '1111' } }, counterToken)).status, 400);
    const x = await counter.call('POST', P('pharmacy/sales'), { ...xBody, requestKey: key(), signoff: { signatoryId: signer.id, pin: '2468' } }, 201);
    assert.equal(x.registers[0].register, 'X');
    assert.equal(x.registers[0].signatory_id, signer.id);
    assert.equal((await request('GET', P('pharmacy/registers/x'))).total, 1);
    // Reading the scan is logged.
    const scan = await fetch(`${base}${P(`pharmacy/prescription-files/${upload.data.id}`)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(scan.status, 200);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='pharmacy.prescription_file_viewed'", [pharmacy.id]));
    // Registers are kept as written.
    await assert.rejects(pool.query('DELETE FROM pharmacy_register_entries WHERE business_id=$1', [pharmacy.id]), /cannot be deleted/);
  });

  await t.test('recall: every buyer found, the batch blocked', async () => {
    await counter.call('POST', P('pharmacy/recalls'), { skuId: cefixime.id, lotCode: 'CFB', reason: 'NSQ' }, 403);
    const recall = await pharmacist.call('POST', P('pharmacy/recalls'), { skuId: cefixime.id, lotCode: 'CFB', reason: 'Not of standard quality', reference: 'CDSCO/09' }, 201);
    assert.equal(recall.sales.length, 1);
    assert.equal(recall.sales[0].phone, '9840012345');
    const blocked = await call('POST', P('pharmacy/sales'), { requestKey: key(), locationId: location.id, lines: [{ skuId: cefixime.id, quantity: '1', unit: 'strip', lotCode: 'CFB' }],
      prescription: { patientName: 'A', doctorName: 'B', doctorRegNo: 'C', prescribedOn: day(0) } }, token);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.message, /recalled and blocked/);
    // Even a stock transfer of the batch is refused by the database.
    const lot = await one("SELECT id FROM business_stock_lots WHERE business_id=$1 AND lot_code='CFB'", [pharmacy.id]);
    await assert.rejects(pool.query('INSERT INTO business_stock_movements(business_id,lot_id,document_id,quantity,balance_after) VALUES($1,$2,$3,-1,0)', [pharmacy.id, lot.id, sold.document.id]), /recalled and blocked/);
  });

  await t.test('expiry return to the distributor on a debit note', async () => {
    const near = await request('GET', P('pharmacy/near-expiry?days=365'));
    const group = near.groups.find((g) => String(g.supplier_id) === String(supplier.id));
    assert.ok(group && group.lots.some((l) => l.lot_code === 'MPA'));
    const cfb = await one("SELECT id,quantity FROM business_stock_lots WHERE business_id=$1 AND lot_code='CFB'", [pharmacy.id]);
    const owedBefore = (await request('GET', P(`suppliers/${supplier.id}/account`)));
    const noteKey = key();
    const note = await pharmacist.call('POST', P('pharmacy/debit-notes'), { requestKey: noteKey, contactId: supplier.id, reason: 'recall', lines: [{ lotId: cfb.id, quantity: '40' }] }, 201);
    assert.equal(note.lines.length, 1);
    assert.ok(note.lines[0].return_id);
    assert.ok(Number(note.claimed) > 0);
    assert.equal(Number((await one('SELECT quantity FROM business_stock_lots WHERE id=$1', [cfb.id])).quantity), Number(cfb.quantity) - 40);
    const owedAfter = await request('GET', P(`suppliers/${supplier.id}/account`));
    assert.notDeepEqual(owedAfter, owedBefore);
    // Repeating the request returns the same note.
    const same = await pharmacist.call('POST', P('pharmacy/debit-notes'), { requestKey: noteKey, contactId: supplier.id, reason: 'recall', lines: [{ lotId: cfb.id, quantity: '40' }] }, 201);
    assert.equal(same.id, note.id);
    await pharmacist.call('POST', P(`pharmacy/debit-notes/${note.id}/credit`), { creditNoteNo: 'CN-1', creditNoteDate: day(0), amount: String(Number(note.claimed) + 1) }, 409);
    const credited = await pharmacist.call('POST', P(`pharmacy/debit-notes/${note.id}/credit`), { creditNoteNo: 'CN-1', creditNoteDate: day(0), amount: note.claimed });
    assert.equal(credited.status, 'credited');
    const list = await request('GET', P('pharmacy/debit-notes'));
    assert.equal(list.items[0].status, 'credited');
  });

  // --- Clinic and lab ---------------------------------------------------------------------
  const desk = await staff(clinic, 'desk@test.invalid', 'cashier');
  const doctor = await staff(clinic, 'doctor@test.invalid', 'doctor');
  const tech = await staff(clinic, 'tech@test.invalid', 'lab_technician');
  const patho = await staff(clinic, 'patho@test.invalid', 'pathologist');
  const clinicLocation = (await request('GET', C('locations'))).items[0];
  let patient, visit;

  await t.test('patients with consent; clinical data only for clinical roles', async () => {
    const r1 = await call('POST', C('clinic/patients'), { name: 'Swathi', sex: 'female', ageYears: 34 }, await login('desk@test.invalid'));
    assert.equal(r1.status, 409);
    patient = await desk.call('POST', C('clinic/patients'), { name: 'Swathi Reddy', phone: '9000000001', sex: 'female', ageYears: 34,
      consent: { purposes: ['treatment', 'reminders'], method: 'signed_form', givenBy: 'Self' } }, 201);
    assert.equal(patient.patient_no, 'P00001');
    assert.equal(patient.consents.length, 2);
    const resource = await request('POST', C('resources'), { name: 'Dr. Ravi', locationId: clinicLocation.id }, 201);
    await request('POST', C('health/signatories'), { kind: 'doctor', userId: doctor.id, name: 'Dr. Ravi Kumar', qualification: 'MBBS, MD', registrationNo: 'TSMC 31248', resourceId: resource.id }, 201);
    const svc = await request('POST', C('catalog'), { kind: 'service', unit: 'service', name: 'Consultation', code: 'CN', price: '500', taxRate: '0' }, 201);
    const starts = new Date(Date.now() + 3600000);
    const appointment = await desk.call('POST', C('appointments'), { contactId: patient.contact_id, skuId: svc.id, resourceId: resource.id, startsAt: starts.toISOString(), endsAt: new Date(starts.getTime() + 600000).toISOString() }, 201);
    visit = await desk.call('POST', C('clinic/visits'), { appointmentId: appointment.id }, 201);
    assert.equal((await desk.call('POST', C('clinic/visits'), { appointmentId: appointment.id }, 201)).id, visit.id);
    await desk.call('PATCH', C(`clinic/visits/${visit.id}`), { complaints: 'x' }, 403);
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { bpSystolic: 150, bpDiastolic: 96, complaints: 'Headache', diagnosis: 'Hypertension', icd10Code: 'i10',
      prescription: [{ drugName: 'Amlodipine', strength: '5 mg', frequency: '1-0-0', duration: '30 days' }], followUpOn: day(14) });
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { icd10Code: 'not a code' }, 400);
    const deskView = await desk.call('GET', C(`clinic/visits/${visit.id}`));
    assert.equal(deskView.diagnosis, undefined);
    assert.equal(deskView.clinical_access, false);
    const before = (await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action='patient.clinical_viewed'", [clinic.id])).n;
    const docView = await doctor.call('GET', C(`clinic/visits/${visit.id}`));
    assert.equal(docView.icd10_code, 'I10');
    assert.equal(docView.doctor_reg_no, 'TSMC 31248');
    assert.equal(docView.prescription.length, 1);
    const after = (await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action='patient.clinical_viewed'", [clinic.id])).n;
    assert.equal(after, before + 1);
    await desk.call('PUT', C(`clinic/patients/${patient.contact_id}/clinical`), { allergies: 'x' }, 403);
    assert.equal((await desk.call('GET', C(`clinic/patients/${patient.contact_id}`))).clinical, null);
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { complete: true });
    assert.equal((await one('SELECT status FROM business_appointments WHERE id=$1', [appointment.id])).status, 'completed');
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { advice: 'More' }, 409);
    await assert.rejects(pool.query("UPDATE health_visits SET diagnosis='changed' WHERE id=$1", [visit.id]), /kept as written/);
    await doctor.call('POST', C(`clinic/visits/${visit.id}/notes`), { body: 'BP recheck advised' }, 201);
    const billed = await desk.call('POST', C(`clinic/visits/${visit.id}/bill`), { requestKey: key(), locationId: clinicLocation.id, payment: { amount: 'full', method: 'upi' } }, 201);
    assert.equal(Number(billed.document.total), 500);
    await other('GET', C(`clinic/visits/${visit.id}`), undefined, 404);
  });

  await t.test('lab: samples, flagged results, pathologist approval and the report', async () => {
    await request('PUT', C('modules/lab'), {enabled:true});
    const test = await tech.call('POST', C('lab/tests'), { code: 'HB', name: 'Haemoglobin', sampleType: 'blood', parameters: [
      { name: 'Haemoglobin', unit: 'g/dL', decimals: 1, ranges: [{ sex: 'female', ageFrom: 13, low: 12, high: 15.5, criticalLow: 7 }, { sex: 'male', ageFrom: 13, low: 13.5, high: 17.5 }] },
      { name: 'Malaria antigen', resultType: 'text', ranges: [{ normalText: 'Negative' }] }] }, 201);
    assert.equal(test.parameters.length, 2);
    await desk.call('POST', C('lab/tests'), { code: 'X1', name: 'X', parameters: [{ name: 'a' }] }, 403);
    const order = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: clinicLocation.id, visitId: visit.id, testIds: [test.id], priority: 'urgent' }, 201);
    assert.equal(order.status, 'ordered');
    assert.equal(order.results_visible, false);
    assert.match(order.samples[0].barcode, /^S\d{7}$/);
    const otId = (await one('SELECT id FROM lab_order_tests WHERE order_id=$1', [order.id])).id;
    const [hb, mal] = test.parameters;
    await tech.call('PUT', C(`lab/orders/${order.id}/results`), { results: [{ orderTestId: otId, parameterId: hb.id, value: '10' }] }, 409);
    await desk.call('POST', C(`lab/samples/${order.samples[0].id}`), { action: 'collect' });
    const received = await tech.call('POST', C(`lab/samples/${order.samples[0].id}`), { action: 'receive' });
    assert.equal(received.order_status, 'received');
    const partial = await tech.call('PUT', C(`lab/orders/${order.id}/results`), { results: [{ orderTestId: otId, parameterId: hb.id, value: '10.24' }] });
    assert.equal(partial.status, 'in_process');
    const flagged = partial.tests[0].parameters.find((p) => p.name === 'Haemoglobin');
    assert.equal(flagged.flag, 'low');
    assert.equal(Number(flagged.value_numeric), 10.2);
    assert.equal(flagged.range_text, '12 – 15.5 g/dL');
    const done = await tech.call('PUT', C(`lab/orders/${order.id}/results`), { results: [{ orderTestId: otId, parameterId: mal.id, value: 'Positive' }] });
    assert.equal(done.status, 'resulted');
    assert.equal(done.tests[0].parameters.find((p) => p.name === 'Malaria antigen').flag, 'abnormal');
    // Report ready shows on the visit only after approval.
    assert.equal((await desk.call('GET', C(`clinic/visits/${visit.id}`))).lab_status, 'pending');
    const signer = await request('POST', C('health/signatories'), { kind: 'pathologist', userId: patho.id, name: 'Dr. Anitha', registrationNo: 'TSMC 40266' }, 201);
    await tech.call('POST', C(`lab/orders/${order.id}/approve`), { signoff: { signatoryId: signer.id, pin: '2468' } }, 403);
    await patho.call('POST', C(`lab/orders/${order.id}/approve`), { signoff: { signatoryId: signer.id, pin: '0000' } }, 400);
    const approved = await patho.call('POST', C(`lab/orders/${order.id}/approve`), { signoff: { signatoryId: signer.id, pin: '2468' } });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.pathologist_reg_no, 'TSMC 40266');
    assert.equal((await desk.call('GET', C(`clinic/visits/${visit.id}`))).lab_status, 'ready');
    await tech.call('PUT', C(`lab/orders/${order.id}/results`), { results: [{ orderTestId: otId, parameterId: hb.id, value: '11' }] }, 409);
    await assert.rejects(pool.query('UPDATE lab_results SET value_numeric=11 WHERE order_id=$1', [order.id]), /cannot be changed/);
    await desk.call('GET', C(`lab/orders/${order.id}/report`), undefined, 403);
    const report = await doctor.call('GET', C(`lab/orders/${order.id}/report`));
    assert.ok(report.lab.name);
    assert.ok(report.approved_at);
    const docVisit = await doctor.call('GET', C(`clinic/visits/${visit.id}`));
    assert.equal(docVisit.lab_results.length, 2);
    // Referral commission is off unless the clinic switches it on.
    const order2 = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: clinicLocation.id, contactId: patient.contact_id, testIds: [test.id] }, 201);
    const refused = await call('POST', C(`lab/orders/${order2.id}/refer`), { outsideLab: 'Ref lab', referralCommission: '50' }, await login('desk@test.invalid'));
    assert.equal(refused.body.data.reason, 'referral_commission_off');
    const referred = await desk.call('POST', C(`lab/orders/${order2.id}/refer`), { outsideLab: 'Ref lab', outsideCharge: '300' });
    assert.equal(referred.referral_commission, null);
    await desk.call('POST', C(`lab/orders/${order2.id}/cancel`), { reason: 'Patient left' });
    assert.equal((await request('GET', C('lab/orders?status=cancelled'))).total, 1);
  });

  const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const at = (d, time) => new Date(`${d}T${time}:00+05:30`).toISOString();
  let meena, gp, review, kavya;

  await t.test('doctors: fees and follow-ups, OPD sessions, slots, leave and earnings', async () => {
    meena = await request('POST', C('resources'), { name: 'Dr. Meena', locationId: clinicLocation.id }, 201);
    gp = await request('POST', C('catalog'), { kind: 'service', unit: 'service', name: 'GP consultation', code: 'GPC', price: '400', taxRate: '0' }, 201);
    review = await request('POST', C('catalog'), { kind: 'service', unit: 'service', name: 'Review visit', code: 'REV', price: '150', taxRate: '0' }, 201);
    const tomorrow = day(1);
    const sessions = [{ dow: dowOf(tomorrow), starts: '09:00', ends: '13:00' }, { dow: dowOf(tomorrow), starts: '17:00', ends: '20:00' }];
    const profile = { speciality: 'General physician', consultationSkuId: gp.id, followUpSkuId: review.id, followUpDays: 7, slotMinutes: 15, sharePercent: '60', sessions };
    await desk.call('PUT', C(`clinic/doctors/${meena.id}`), profile, 403);
    await request('PUT', C(`clinic/doctors/${meena.id}`), { ...profile, sessions: [...sessions, { dow: dowOf(tomorrow), starts: '12:00', ends: '14:00' }] }, 400);
    const saved = await request('PUT', C(`clinic/doctors/${meena.id}`), profile);
    assert.equal(saved.sessions.length, 2);
    assert.equal(saved.consultation_label, 'GP consultation');
    assert.ok((await desk.call('GET', C('clinic/doctors'))).some((d) => d.id === meena.id && d.is_doctor));
    // Slots of 15 minutes in both sessions: 16 in the morning, 12 in the evening.
    const free = await desk.call('GET', C(`clinic/slots?doctor=${meena.id}&day=${tomorrow}`));
    assert.equal(free.slots.length, 28);
    assert.equal(free.slots[0].starts_at, at(tomorrow, '09:00'));
    // Booked within a session only.
    kavya = await desk.call('POST', C('clinic/patients'), { name: 'Kavya Iyer', phone: '9000000088', sex: 'female', ageYears: 29,
      consent: { purposes: ['treatment'], method: 'signed_form', givenBy: 'Self' } }, 201);
    const book = (time, expected) => desk.call('POST', C('appointments'), { contactId: kavya.contact_id, skuId: gp.id, resourceId: meena.id,
      startsAt: at(tomorrow, time), endsAt: new Date(Date.parse(at(tomorrow, time)) + 900000).toISOString() }, expected);
    const outside = await call('POST', C('appointments'), { contactId: kavya.contact_id, skuId: gp.id, resourceId: meena.id, startsAt: at(tomorrow, '14:00'),
      endsAt: at(tomorrow, '14:15') }, await login('desk@test.invalid'));
    assert.equal(outside.status, 409);
    assert.match(outside.body.message, /09:00–13:00, 17:00–20:00/);
    const booked = await book('09:15', 201);
    assert.equal((await desk.call('GET', C(`clinic/slots?doctor=${meena.id}&day=${tomorrow}`))).slots[1].taken, true);
    // Leave that day: the desk is told who is booked, and no one else books.
    const leave = await request('POST', C(`clinic/doctors/${meena.id}/leave`), { fromDate: tomorrow, reason: 'Conference' }, 201);
    assert.equal(leave.booked, 1);
    assert.match((await call('POST', C('appointments'), { contactId: kavya.contact_id, skuId: gp.id, resourceId: meena.id, startsAt: at(tomorrow, '10:00'),
      endsAt: at(tomorrow, '10:15') }, await login('desk@test.invalid'))).body.message, /on leave/);
    assert.equal((await desk.call('GET', C(`clinic/slots?doctor=${meena.id}&day=${tomorrow}`))).slots.length, 0);
    await request('POST', C(`clinic/leave/${leave.id}/cancel`), {});
    await book('10:00', 201);
    await request('PATCH', C(`appointments/${booked.id}`), { status: 'cancelled' });

    // Fees: the first visit pays the consultation, a return within 7 days the
    // review fee; with no review fee set, the follow-up is free.
    const walkIn = async () => desk.call('POST', C('clinic/visits'), { contactId: kavya.contact_id, resourceId: meena.id }, 201);
    const first = await walkIn();
    assert.deepEqual([(await desk.call('GET', C(`clinic/visits/${first.id}/fee`))).kind, (await desk.call('GET', C(`clinic/visits/${first.id}/fee`))).label], ['consultation', 'GP consultation']);
    const bill1 = await desk.call('POST', C(`clinic/visits/${first.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } }, 201);
    assert.equal(Number(bill1.document.total), 400);
    assert.equal(bill1.visit.fee_kind, 'consultation');
    const second = await walkIn();
    assert.equal((await desk.call('GET', C(`clinic/visits/${second.id}/fee`))).kind, 'follow_up');
    assert.equal(Number((await desk.call('POST', C(`clinic/visits/${second.id}/bill`), { requestKey: key() }, 201)).document.total), 150);
    await request('PUT', C(`clinic/doctors/${meena.id}`), { ...profile, followUpSkuId: null });
    const third = await walkIn();
    const free3 = await desk.call('POST', C(`clinic/visits/${third.id}/bill`), { requestKey: key() }, 201);
    assert.equal(free3.document, null);
    assert.equal(free3.visit.fee_kind, 'free_follow_up');
    assert.equal((await one('SELECT fee_kind FROM health_visits WHERE id=$1', [third.id])).fee_kind, 'free_follow_up');
    // A completed and billed consultation keeps how it was charged.
    await doctor.call('PATCH', C(`clinic/visits/${first.id}`), { complaints: 'Fever', complete: true });
    await assert.rejects(pool.query("UPDATE health_visits SET fee_kind='follow_up' WHERE id=$1", [first.id]), /kept as written/);
    // Earnings: three patients, ₹550 of fees, 60% to the doctor.
    const today = day(0);
    const earnings = await request('GET', C(`clinic/doctor-earnings?from=${today}&to=${today}`));
    const mine = earnings.doctors.find((d) => d.resource_id === meena.id);
    assert.deepEqual([mine.visits, mine.consultations, mine.follow_ups, mine.free_follow_ups, mine.fees, mine.share], [3, 1, 1, 1, '550.00', '330.00']);
    await desk.call('GET', C(`clinic/doctor-earnings?from=${today}&to=${today}`), undefined, 403);
  });

  await t.test('tokens: issued on arrival, called in turn (priority first), done with the visit', async () => {
    const today = day(0);
    // Today: one session capped at three patients.
    await request('PUT', C(`clinic/doctors/${meena.id}`), { consultationSkuId: gp.id, followUpDays: 7, slotMinutes: 15, sessions: [{ dow: dowOf(today), starts: '00:00', ends: '23:59', maxPatients: 3 }] });
    const register = (name, phone) => desk.call('POST', C('clinic/patients'), { name, phone, sex: 'male', ageYears: 50, consent: { purposes: ['treatment'], method: 'signed_form', givenBy: 'Self' } }, 201);
    const ramesh = await register('Ramesh Gupta', '9000000101'), sunil = await register('Sunil Rao', '9000000102'), arun = await register('Arun Das', '9000000103');
    const t1 = await desk.call('POST', C('clinic/tokens'), { contactId: kavya.contact_id, resourceId: meena.id }, 201);
    const t2 = await desk.call('POST', C('clinic/tokens'), { contactId: ramesh.contact_id, resourceId: meena.id }, 201);
    const t3 = await desk.call('POST', C('clinic/tokens'), { contactId: sunil.contact_id, resourceId: meena.id, priority: true, note: 'Senior citizen' }, 201);
    assert.deepEqual([t1.token_no, t2.token_no, t3.token_no], [1, 2, 3]);
    await desk.call('POST', C('clinic/tokens'), { contactId: kavya.contact_id, resourceId: meena.id }, 409);
    const full = await call('POST', C('clinic/tokens'), { contactId: arun.contact_id, resourceId: meena.id }, await login('desk@test.invalid'));
    assert.equal(full.body.data.reason, 'opd_full');
    // The priority patient is called first; "next" again skips them (they did not come in).
    assert.equal((await doctor.call('POST', C('clinic/tokens/next'), { resourceId: meena.id })).called.token_no, 3);
    assert.equal((await doctor.call('POST', C('clinic/tokens/next'), { resourceId: meena.id })).called.token_no, 1);
    assert.equal((await one('SELECT status FROM health_tokens WHERE id=$1', [t3.id])).status, 'skipped');
    // Starting the consultation opens the visit; completing it finishes the token.
    const started = await doctor.call('POST', C(`clinic/tokens/${t1.id}`), { action: 'start' });
    assert.equal(started.status, 'in_consultation');
    assert.ok(started.visit_id);
    await doctor.call('PATCH', C(`clinic/visits/${started.visit_id}`), { complaints: 'Cough', complete: true });
    const queue = await desk.call('GET', C(`clinic/queue?day=${today}`));
    const board = queue.doctors.find((d) => d.resource_id === meena.id);
    assert.deepEqual([board.done, board.waiting, board.serving], [1, 1, null]);
    assert.equal(queue.tokens.find((x) => x.id === t1.id).status, 'done');
    // A skipped patient can be called back; a cancelled token frees the place.
    assert.equal((await desk.call('POST', C(`clinic/tokens/${t3.id}`), { action: 'call' })).status, 'called');
    await desk.call('POST', C(`clinic/tokens/${t2.id}`), { action: 'cancel' });
    assert.equal((await desk.call('POST', C('clinic/tokens'), { contactId: arun.contact_id, resourceId: meena.id }, 201)).token_no, 4);
    await desk.call('POST', C(`clinic/tokens/${t1.id}`), { action: 'skip' }, 409);
  });

  await t.test('lab: an amended report keeps every signed version; QC holds reports by Westgard rules', async () => {
    const glucose = await tech.call('POST', C('lab/tests'), { code: 'GLU', name: 'Glucose (fasting)', sampleType: 'blood', parameters: [
      { name: 'Glucose', unit: 'mg/dL', decimals: 0, ranges: [{ low: 70, high: 110 }] }] }, 201);
    const signer = (await request('GET', C('health/signatories?kind=pathologist')))[0] || (await request('GET', C('health/signatories?kind=pathologist'))).items[0];
    const signoff = { signatoryId: signer.id, pin: '2468' };
    const resulted = async (value) => {
      const order = await desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: clinicLocation.id, contactId: kavya.contact_id, testIds: [glucose.id] }, 201);
      await desk.call('POST', C(`lab/samples/${order.samples[0].id}`), { action: 'collect' });
      await tech.call('POST', C(`lab/samples/${order.samples[0].id}`), { action: 'receive' });
      const otId = (await one('SELECT id FROM lab_order_tests WHERE order_id=$1', [order.id])).id;
      await tech.call('PUT', C(`lab/orders/${order.id}/results`), { results: [{ orderTestId: otId, parameterId: glucose.parameters[0].id, value: String(value) }] });
      return { order, otId };
    };
    const { order, otId } = await resulted(95);
    const v1 = await patho.call('POST', C(`lab/orders/${order.id}/approve`), { signoff });
    assert.equal(v1.version, 1);
    // Amending: the pathologist, with a reason and their PIN.
    await tech.call('POST', C(`lab/orders/${order.id}/amend`), { reason: 'Transcription error', signoff }, 403);
    await patho.call('POST', C(`lab/orders/${order.id}/amend`), { signoff }, 400);
    const reopened = await patho.call('POST', C(`lab/orders/${order.id}/amend`), { reason: 'Transcription error: 95 entered for 105', signoff });
    assert.equal(reopened.status, 'resulted');
    await desk.call('GET', C(`lab/orders/${order.id}/report`), undefined, 403);
    await doctor.call('GET', C(`lab/orders/${order.id}/report`), undefined, 409);
    await tech.call('PUT', C(`lab/orders/${order.id}/results`), { results: [{ orderTestId: otId, parameterId: glucose.parameters[0].id, value: '105' }] });
    const v2 = await patho.call('POST', C(`lab/orders/${order.id}/approve`), { signoff });
    assert.equal(v2.version, 2);
    const report = await doctor.call('GET', C(`lab/orders/${order.id}/report`));
    assert.deepEqual([report.report_version, report.amends.version, report.report_amend_reason], [2, 1, 'Transcription error: 95 entered for 105']);
    assert.equal(Number(report.tests[0].parameters[0].value_numeric), 105);
    const old = await doctor.call('GET', C(`lab/orders/${order.id}/report?version=1`));
    assert.equal(old.superseded, true);
    assert.equal(Number(old.tests[0].parameters[0].value_numeric), 95);
    const history = await doctor.call('GET', C(`lab/orders/${order.id}/versions`));
    assert.deepEqual(history.versions.map((x) => [x.version, x.superseded]), [[2, false], [1, true]]);
    await assert.rejects(pool.query('UPDATE lab_report_versions SET amend_reason=NULL WHERE order_id=$1', [order.id]), /cannot be changed/);
    await assert.rejects(pool.query("UPDATE lab_report_versions SET approved_at=approved_at - interval '1 day' WHERE order_id=$1", [order.id]), /cannot be changed/);

    // QC: a control at mean 100, SD 5.
    const control = await tech.call('POST', C('lab/qc/materials'), { parameterId: glucose.parameters[0].id, name: 'Bio-Rad Lyphochek', lotNo: 'L-4521', level: 'Level 1', mean: 100, sd: 5 }, 201);
    await desk.call('POST', C('lab/qc/runs'), { materialId: control.id, value: 101 }, 403);
    const run = (value) => tech.call('POST', C('lab/qc/runs'), { materialId: control.id, value }, 201);
    assert.equal((await run(102)).outcome, 'accepted');
    const warn = await run(111);
    assert.deepEqual([warn.outcome, warn.rules], ['warning', ['1-2s']]);
    const reject = await run(112);
    assert.deepEqual([reject.outcome, reject.rules], ['rejected', ['2-2s']]);
    assert.equal((await tech.call('GET', C('lab/qc/today'))).rejected, 1);
    // While QC is rejected, a glucose report is not signed.
    const held = await resulted(88);
    assert.equal((await tech.call('GET', C(`lab/orders/${held.order.id}`))).qc[0].status, 'rejected');
    const refused = await call('POST', C(`lab/orders/${held.order.id}/approve`), { signoff }, await login('patho@test.invalid'));
    assert.equal(refused.body.data.reason, 'qc_rejected');
    assert.equal((await run(117)).rules.includes('1-3s'), true);
    const fixed = await tech.call('POST', C('lab/qc/runs'), { materialId: control.id, value: 99, correctiveAction: 'Recalibrated the analyser' }, 201);
    assert.equal(fixed.outcome, 'accepted');
    assert.equal((await patho.call('POST', C(`lab/orders/${held.order.id}/approve`), { signoff })).status, 'approved');
    assert.equal((await tech.call('GET', C(`lab/qc/runs?material=${control.id}`))).total, 5);
    await assert.rejects(pool.query('UPDATE lab_qc_runs SET value=100 WHERE material_id=$1', [control.id]), /cannot be changed/);
  });

  await t.test('withdrawn consent stops new visits and tests; the record stays', async () => {
    const consent = await one("SELECT id FROM health_consents WHERE business_id=$1 AND contact_id=$2 AND purpose='treatment'", [clinic.id, patient.contact_id]);
    await desk.call('POST', C(`clinic/consents/${consent.id}/withdraw`), { reason: 'Moving away' });
    await desk.call('POST', C(`clinic/consents/${consent.id}/withdraw`), { reason: 'Again' }, 409);
    const blocked = await call('POST', C('clinic/visits'), { contactId: patient.contact_id }, await login('desk@test.invalid'));
    assert.equal(blocked.body.data.reason, 'consent_required');
    await desk.call('GET', C(`clinic/patients/${patient.contact_id}`));
    await assert.rejects(pool.query('DELETE FROM health_consents WHERE id=$1', [consent.id]), /cannot be deleted/);
    const list = await desk.call('GET', C('clinic/patients?consent=false'));
    assert.equal(list.total, 1);
  });
  await t.test("a clinic branch: visits, appointments and doctors are each branch's", async () => {
    const head = (await request('GET', C('locations'))).items[0];
    const kondapur = await request('POST', C('locations'), { name: 'Kondapur clinic', code: 'KDP' }, 201);
    const asha = await request('POST', C('resources'), { name: 'Dr. Asha', locationId: kondapur.id }, 201);
    const ravi = (await request('GET', C('resources'))).items.find((r) => r.name === 'Dr. Ravi');
    const svc = (await request('GET', C('catalog?q=Consultation'))).items[0];
    const person = await request('POST', C('clinic/patients'), { name: 'Imran Khan', phone: '9000000077', sex: 'male', ageYears: 41,
      consent: { purposes: ['treatment'], method: 'signed_form', givenBy: 'Self' } }, 201);
    const at = (hours) => { const s = new Date(Date.now() + hours * 3600000); return { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 600000).toISOString() }; };
    const atHead = await request('POST', C('appointments'), { contactId: person.contact_id, skuId: svc.id, resourceId: ravi.id, ...at(30) }, 201);
    const atBranch = await request('POST', C('appointments'), { contactId: person.contact_id, skuId: svc.id, resourceId: asha.id, ...at(31) }, 201);
    // A visit is at its doctor's branch.
    const headVisit = await request('POST', C('clinic/visits'), { appointmentId: atHead.id }, 201);
    const branchVisit = await request('POST', C('clinic/visits'), { appointmentId: atBranch.id }, 201);
    assert.equal(headVisit.location_id, head.id);
    assert.equal(branchVisit.location_id, kondapur.id);
    // A receptionist tied to Kondapur.
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, 'kdp desk', 'kdp-desk@test.invalid', hash]);
    const roles = (await request('GET', C('roles?limit=100'))).items;
    await request('POST', C('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === 'cashier').id, workLocationId: kondapur.id }, 201);
    const kdp = as(await login('kdp-desk@test.invalid'));
    // Their lists are Kondapur's: doctors, appointments and visits.
    assert.deepEqual((await kdp('GET', C('resources'))).items.map((r) => r.id), [asha.id]);
    const appointments = (await kdp('GET', C('appointments?limit=100'))).items;
    assert.ok(appointments.some((a) => a.id === atBranch.id) && !appointments.some((a) => a.id === atHead.id));
    const visits = (await kdp('GET', C('clinic/visits?limit=100'))).items;
    assert.deepEqual(visits.map((v) => v.id), [branchVisit.id]);
    // The head clinic's appointment and doctor are beyond them...
    await kdp('PATCH', C(`appointments/${atHead.id}`), { status: 'no_show' }, 403);
    await kdp('POST', C('appointments'), { contactId: person.contact_id, skuId: svc.id, resourceId: ravi.id, ...at(40) }, 403);
    await kdp('POST', C('clinic/visits'), { contactId: person.contact_id, resourceId: ravi.id }, 403);
    // ...but the patient's earlier visit there is their history, and reads.
    assert.equal((await kdp('GET', C(`clinic/visits/${headVisit.id}`))).id, headVisit.id);
    // A walk-in with no doctor opens at the receptionist's own branch.
    const walkIn = await kdp('POST', C('clinic/visits'), { contactId: person.contact_id }, 201);
    assert.equal(walkIn.location_id, kondapur.id);
    // The owner sees both branches, or one asked for.
    assert.ok((await request('GET', C('clinic/visits?limit=100'))).items.some((v) => v.id === headVisit.id));
    const headOnly = (await request('GET', C(`clinic/visits?limit=100&location=${head.id}`))).items;
    assert.ok(headOnly.length > 0 && headOnly.every((v) => v.location_id === head.id));
  });
});
