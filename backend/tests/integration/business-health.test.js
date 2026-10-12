const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');

// Round 2 (R2-HEALTH): pharmacy and clinic / lab rules. Drug master and
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
  process.env.MULTI_BUSINESS_DEVELOPMENT = 'true';
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
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

  const demos = (await request('POST', '/businesses/development-demos', {}, 201)).businesses;
  const pharmacy = demos.find((b) => b.business_type === 'pharmacy');
  const clinic = demos.find((b) => b.business_type === 'healthcare');
  const grocery = demos.find((b) => b.business_type === 'grocery');
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
    assert.ok(cctx.capabilities.includes('patients') && cctx.capabilities.includes('lab'));
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
    const retain = await one("SELECT retain_until - created_at::date AS days FROM pharmacy_register_entries WHERE business_id=$1 LIMIT 1", [pharmacy.id]);
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
});
