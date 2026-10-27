const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The clinic's and the lab's workspaces (the staff app's /clinic and /lab),
// end to end on a throwaway database of their own. The workspaces read and
// write through the clinic's and the lab's own routes; what they add or change:
//
//   - a consultation's referral (to whom, and why): written by the doctor,
//     read only by clinical roles, kept as written once the consultation is
//     completed; a reason needs someone to refer to;
//   - GET /clinic/medicines: the medicines this clinic's doctors have
//     prescribed, the most used first with their most used dose, for the
//     prescription; only for those who write consultations, never another
//     clinic's;
//   - GET /clinic/queue says the server's time, for the waiting clocks;
//   - GET /lab/bench: every open order and those reported today, at the
//     branch in view, with their samples (where each is) and tests (how many
//     results are in), and never a result: how many values are out of range
//     only for those who see results; reading it changes and logs nothing;
//   - the front desk reads no result anywhere: the lab orders list gives it no
//     count of values out of range, and an amendment's reason (which quotes
//     values) is the lab's and the doctors';
//   - a lab order's, a sample's and a result's every change reaches the
//     business's live stream with the order's id and location, and only that;
//     no other business hears it, and a login tied to another branch does not
//     hear a change at this one;
//   - the migration's Down half takes the triggers and the referral away, and
//     Up brings them back.
test('the clinic and lab workspaces', { timeout: 600000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  const streams = new Set();
  let pool, server, scratch, hub, created = false;
  await admin.connect();
  t.after(async () => {
    for (const stream of streams) stream.close();
    if (hub) await hub.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (scratch) await scratch.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test("the Down half takes the lab's live triggers and the referral away, and Up brings them back", async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const left = async () => (await scratch.query(`SELECT
        (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('lab_orders_live','lab_samples_live','lab_results_live')) AS triggers,
        (SELECT count(*)::int FROM pg_proc WHERE proname='live_lab_order_part') AS functions,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='health_visits' AND column_name IN ('referred_to','referral_reason')) AS columns`)).rows[0];
    assert.deepEqual(await left(), { triggers: 3, functions: 1, columns: 2 });
    // This migration's Down half, after those of every newer one.
    await migrate({ direction: 'down', count: 1791976000000, timestamp: true });
    assert.deepEqual(await left(), { triggers: 0, functions: 0, columns: 0 });
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await left(), { triggers: 3, functions: 1, columns: 2 });
  });

  pool = require('../../src/config/database');
  hub = require('../../src/modules/live/services/liveHub');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const password = `Clinic-${crypto.randomBytes(8).toString('hex')}`;
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
  const login = async (email) => (await signIn(base, email, password)).token;
  const key = () => crypto.randomUUID();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A screen's stream, read as the staff app reads it: every message as it
  // arrives; `change(from, area, id)` waits for a change after message `from`.
  function listen(route, token) {
    const controller = new AbortController();
    const stream = { status: 0, messages: [], close: () => controller.abort() };
    let wake = () => {};
    const arrived = () => { const waiting = wake; wake = () => {}; waiting(); };
    streams.add(stream);
    stream.opened = fetch(base + route, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        stream.status = response.status;
        (async () => {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                if (block.startsWith(':')) continue;
                const message = {};
                for (const line of block.split('\n')) {
                  const colon = line.indexOf(':');
                  const field = line.slice(0, colon);
                  const value = line.slice(colon + 1).trimStart();
                  if (field === 'event') message.event = value;
                  else if (field === 'data') message.data = JSON.parse(value);
                }
                stream.messages.push(message);
                arrived();
              }
            }
          } catch {
            // Closed from this end.
          }
        })();
        return stream;
      });
    stream.until = (check, ms = 8000, what = route) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { wake = () => {}; reject(new Error(`${what}: not within ${ms} ms. Messages: ${JSON.stringify(stream.messages)}`)); }, ms);
      const look = () => {
        const found = check();
        if (found) { clearTimeout(timer); resolve(found); } else wake = look;
      };
      look();
    });
    stream.changes = (from = 0) => stream.messages.slice(from).filter((m) => m.event === 'change').map((m) => m.data);
    stream.change = (from, area, id) => stream.until(() => stream.changes(from).find((m) => m.area === area && m.id === Number(id)), 8000, `${route}: ${area} ${id}`);
    stream.ready = async () => {
      await stream.opened;
      assert.equal(stream.status, 200, route);
      return stream.until(() => stream.messages.find((m) => m.event === 'ready'), 8000, `${route}: ready`);
    };
    return stream;
  }

  // --- A clinic with a lab and a branch, another with the lab off, another owner's clinic, staff ---
  const ownerUser = await owner('clw-owner');
  await owner('clw-other');
  const request = as(await login('clw-owner@test.invalid'));
  const otherToken = await login('clw-other@test.invalid');
  const other = as(otherToken);
  const [clinic, grocery] = await createBusinesses(request, 'CLW', ['healthcare', 'grocery']);
  const [plain] = await createBusinesses(request, 'PLAIN', ['healthcare']);
  const [elsewhere] = await createBusinesses(other, 'ELS', ['healthcare']);
  const C = (s) => `/businesses/${clinic.id}/${s}`;
  const E = (s) => `/businesses/${elsewhere.id}/${s}`;
  await request('PUT', C('modules/lab'), { enabled: true });
  await other('PUT', E('modules/lab'), { enabled: true });
  const main = (await request('GET', C('locations'))).items[0];
  const kondapur = await request('POST', C('locations'), { name: 'Kondapur clinic', code: 'KDP' }, 201);
  const roles = (await request('GET', C('roles?limit=100'))).items;
  async function staff(email, template, workLocationId) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash,pin_hash,pin_set_at) VALUES($1,$2,$3,$4,$5,now()) RETURNING id',
      [ownerUser.restaurant_id, email.split('@')[0], email, hash, pinHash]);
    await request('POST', C('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id, ...(workLocationId ? { workLocationId } : {}) }, 201);
    const token = await login(email);
    return { id: user.id, token, call: as(token) };
  }
  const desk = await staff('desk@test.invalid', 'cashier');
  const doctor = await staff('doctor@test.invalid', 'doctor');
  const tech = await staff('tech@test.invalid', 'lab_technician');
  const patho = await staff('patho@test.invalid', 'pathologist');
  const keeper = await staff('keeper@test.invalid', 'stock_keeper');
  const kdp = await staff('kdp@test.invalid', 'cashier', kondapur.id);
  const ravi = await request('POST', C('resources'), { name: 'Dr. Ravi', locationId: main.id }, 201);
  await request('POST', C('health/signatories'), { kind: 'doctor', userId: doctor.id, name: 'Dr. Ravi Kumar', registrationNo: 'TSMC 31248', resourceId: ravi.id }, 201);
  const pathologist = await request('POST', C('health/signatories'), { kind: 'pathologist', userId: patho.id, name: 'Dr. Anitha', registrationNo: 'TSMC 40266' }, 201);
  const register = (name, phone) => desk.call('POST', C('clinic/patients'), { name, phone, sex: 'female', ageYears: 46,
    consent: { purposes: ['treatment'], method: 'signed_form', givenBy: 'Self' } }, 201);
  const swathi = await register('Swathi Reddy', '9000000201');
  const lakshmi = await register('Lakshmi Narayanan', '9000000202');
  const visitFor = (patient) => desk.call('POST', C('clinic/visits'), { contactId: patient.contact_id, resourceId: ravi.id }, 201);
  const auditCount = async (action) => (await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action=$2', [clinic.id, action])).n;

  await t.test("a consultation's referral: the doctor writes it, only clinical roles read it, and it is kept once completed", async () => {
    const visit = await visitFor(swathi);
    const referral = { referredTo: 'Dr. S. Rao, cardiologist, City Hospital', referralReason: 'Chest pain on exertion; ECG with ST changes' };
    await desk.call('PATCH', C(`clinic/visits/${visit.id}`), { referredTo: referral.referredTo }, 403);
    const nobody = await call('PATCH', C(`clinic/visits/${visit.id}`), { referralReason: referral.referralReason }, doctor.token);
    assert.equal(nobody.status, 400);
    assert.equal(nobody.body.message, 'Say whom the patient is referred to');
    const before = await auditCount('visit.updated');
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { complaints: 'Chest pain', diagnosis: 'Stable angina', ...referral });
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='visit.updated' ORDER BY id DESC LIMIT 1", [clinic.id]);
    assert.equal(await auditCount('visit.updated'), before + 1);
    assert.ok(audit.details.fields.includes('referred_to') && audit.details.fields.includes('referral_reason'));
    const read = await doctor.call('GET', C(`clinic/visits/${visit.id}`));
    assert.deepEqual([read.referred_to, read.referral_reason], [referral.referredTo, referral.referralReason]);
    // The front desk sees who and when, never the referral.
    const front = await desk.call('GET', C(`clinic/visits/${visit.id}`));
    assert.equal(front.clinical_access, false);
    assert.ok(!('referred_to' in front) && !('referral_reason' in front));
    // Taking away whom while the reason stays is refused; both together clear it.
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { referredTo: null }, 400);
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { referredTo: null, referralReason: null });
    assert.equal((await doctor.call('GET', C(`clinic/visits/${visit.id}`))).referred_to, null);
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { referredTo: referral.referredTo, complete: true });
    await doctor.call('PATCH', C(`clinic/visits/${visit.id}`), { referredTo: 'Someone else' }, 409);
    await assert.rejects(pool.query("UPDATE health_visits SET referred_to='Someone else' WHERE id=$1", [visit.id]), /kept as written/);
    assert.equal((await one('SELECT referred_to FROM health_visits WHERE id=$1', [visit.id])).referred_to, referral.referredTo);
    await other('GET', C(`clinic/visits/${visit.id}`), undefined, 404);
  });

  await t.test('the prescription offers the medicines this clinic has prescribed, the most used first', async () => {
    const amlo = { drugName: 'Amlodipine', strength: '5 mg', dose: '1 tab', frequency: '1-0-0', duration: '30 days', instructions: 'After breakfast' };
    const first = await visitFor(lakshmi);
    await doctor.call('PATCH', C(`clinic/visits/${first.id}`), { complaints: 'Headache', prescription: [amlo, { drugName: 'Paracetamol', strength: '650 mg', frequency: '1-1-1', duration: '3 days' }] });
    const second = await visitFor(swathi);
    await doctor.call('PATCH', C(`clinic/visits/${second.id}`), { complaints: 'Review', prescription: [amlo, { drugName: 'amlodipine', strength: '10 mg', frequency: '0-0-1', duration: '15 days' }] });
    // Another owner's clinic prescribes something else: never offered here.
    const theirs = await other('POST', E('clinic/patients'), { name: 'Imran Khan', sex: 'male', ageYears: 50, consent: { purposes: ['treatment'], method: 'verbal', givenBy: 'Self' } }, 201);
    const theirVisit = await other('POST', E('clinic/visits'), { contactId: theirs.contact_id }, 201);
    await other('PATCH', E(`clinic/visits/${theirVisit.id}`), { prescription: [{ drugName: 'Metformin', strength: '500 mg' }] });

    const offered = await doctor.call('GET', C('clinic/medicines'));
    assert.deepEqual(offered.map((m) => [m.drug_name.toLowerCase(), m.times]), [['amlodipine', 3], ['paracetamol', 1]]);
    // Each with its most used line, ready to fill the prescription.
    assert.deepEqual([offered[0].strength, offered[0].dose, offered[0].frequency, offered[0].duration, offered[0].instructions], ['5 mg', '1 tab', '1-0-0', '30 days', 'After breakfast']);
    assert.deepEqual((await doctor.call('GET', C('clinic/medicines?q=para'))).map((m) => m.drug_name), ['Paracetamol']);
    assert.deepEqual(await doctor.call('GET', C(`clinic/medicines?q=${encodeURIComponent('%')}`)), []);
    // Only for those who write consultations; another business's never.
    await desk.call('GET', C('clinic/medicines'), undefined, 403);
    await patho.call('GET', C('clinic/medicines'), undefined, 403);
    await request('GET', `/businesses/${grocery.id}/clinic/medicines`, undefined, 403);
    await other('GET', C('clinic/medicines'), undefined, 404);
    assert.deepEqual((await other('GET', E('clinic/medicines'))).map((m) => m.drug_name), ['Metformin']);
  });

  await t.test("the token queue answers with the server's time", async () => {
    const queue = await desk.call('GET', C('clinic/queue'));
    assert.ok(Math.abs(Date.parse(queue.server_time) - Date.now()) < 60000);
    assert.equal(queue.day, daysFrom(0));
  });

  // The lab's tests: haemoglobin (critical below 7) and a malaria antigen.
  const hb = await tech.call('POST', C('lab/tests'), { code: 'HB', name: 'Haemoglobin', sampleType: 'blood', container: 'EDTA', parameters: [
    { name: 'Haemoglobin', unit: 'g/dL', decimals: 1, ranges: [{ sex: 'female', ageFrom: 13, low: 12, high: 15.5, criticalLow: 7 }] }] }, 201);
  const mal = await tech.call('POST', C('lab/tests'), { code: 'MAL', name: 'Malaria antigen', sampleType: 'blood', parameters: [
    { name: 'Malaria antigen', resultType: 'text', ranges: [{ normalText: 'Negative' }] }] }, 201);
  const order = (patient, body = {}) => desk.call('POST', C('lab/orders'), { requestKey: key(), locationId: main.id, contactId: patient.contact_id, testIds: [hb.id, mal.id], ...body }, 201);
  const resultFor = async (orderId, test, value, who = tech) => {
    const orderTest = await one('SELECT id FROM lab_order_tests WHERE order_id=$1 AND test_id=$2', [orderId, test.id]);
    return who.call('PUT', C(`lab/orders/${orderId}/results`), { results: [{ orderTestId: orderTest.id, parameterId: test.parameters[0].id, value }] });
  };
  let urgent;

  await t.test('the lab bench: open orders with their samples and tests, at the branch in view, and no result', async () => {
    urgent = await order(swathi, { priority: 'urgent' });
    const routine = await order(lakshmi);
    const atBranch = await request('POST', C('lab/orders'), { requestKey: key(), locationId: kondapur.id, contactId: lakshmi.contact_id, testIds: [hb.id] }, 201);
    const gone = await order(lakshmi);
    await desk.call('POST', C(`lab/orders/${gone.id}/cancel`), { reason: 'Patient left' });
    const audits = (await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1', [clinic.id])).n;
    const bench = await desk.call('GET', C('lab/bench'));
    assert.ok(Math.abs(Date.parse(bench.server_time) - Date.now()) < 60000);
    assert.equal(bench.day, daysFrom(0));
    assert.equal(bench.results_visible, false);
    assert.equal(bench.more, false);
    // Urgent first, then the oldest; a cancelled order is not on the bench.
    assert.deepEqual(bench.orders.map((o) => o.id), [urgent.id, routine.id, atBranch.id]);
    const row = bench.orders[0];
    assert.deepEqual([row.order_no, row.patient_name, row.patient_no, row.priority, row.status], [urgent.order_no, 'Swathi Reddy', swathi.patient_no, 'urgent', 'ordered']);
    // One blood sample for both tests, to collect; each test with its parameters and none typed.
    assert.deepEqual(row.samples.map((s) => [s.barcode, s.sample_type, s.container, s.status]), [[urgent.samples[0].barcode, 'blood', 'EDTA', 'awaited']]);
    assert.deepEqual(row.tests.map((x) => [x.code, x.parameters, x.entered, x.sample_id]), [['HB', 1, 0, urgent.samples[0].id], ['MAL', 1, 0, urgent.samples[0].id]]);
    // Nothing about a result, and reading it wrote nothing.
    assert.ok(!('flagged' in row) && !('critical' in row));
    assert.equal((await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1', [clinic.id])).n, audits);
    // The branch in view: a login tied to Kondapur, or a location asked for.
    assert.deepEqual((await kdp.call('GET', C('lab/bench'))).orders.map((o) => o.id), [atBranch.id]);
    assert.deepEqual((await request('GET', C(`lab/bench?location=${kondapur.id}`))).orders.map((o) => o.id), [atBranch.id]);
    await kdp.call('GET', C(`lab/bench?location=${main.id}`), undefined, 403);

    // Where the sample is: collected, rejected with the reason, collected again, in the lab.
    const sample = urgent.samples[0];
    await desk.call('POST', C(`lab/samples/${sample.id}`), { action: 'collect' });
    let seen = (await desk.call('GET', C('lab/bench'))).orders[0].samples[0];
    assert.deepEqual([seen.status, seen.collected_by_name], ['collected', 'desk']);
    await tech.call('POST', C(`lab/samples/${sample.id}`), { action: 'reject', reason: 'Haemolysed' });
    seen = (await desk.call('GET', C('lab/bench'))).orders[0].samples[0];
    assert.deepEqual([seen.status, seen.reject_reason], ['rejected', 'Haemolysed']);
    await desk.call('POST', C(`lab/samples/${sample.id}`), { action: 'collect' });
    await tech.call('POST', C(`lab/samples/${sample.id}`), { action: 'receive' });
    seen = (await desk.call('GET', C('lab/bench'))).orders[0];
    assert.deepEqual([seen.status, seen.samples[0].status, seen.samples[0].received_by_name], ['received', 'received', 'tech']);

    // A critical haemoglobin: the lab sees how many values are out of range; the desk only the progress.
    await resultFor(urgent.id, hb, '6.5');
    const lab = (await tech.call('GET', C('lab/bench'))).orders[0];
    assert.deepEqual([lab.status, lab.tests[0].entered, lab.tests[1].entered, lab.flagged, lab.critical], ['in_process', 1, 0, 1, 1]);
    assert.equal((await tech.call('GET', C('lab/bench'))).results_visible, true);
    const front = (await desk.call('GET', C('lab/bench'))).orders[0];
    assert.deepEqual([front.status, front.tests[0].entered], ['in_process', 1]);
    assert.ok(!('flagged' in front) && !('critical' in front));

    // Reported today: still on the bench, after the open orders.
    await resultFor(urgent.id, mal, 'Negative');
    await patho.call('POST', C(`lab/orders/${urgent.id}/approve`), { signoff: { signatoryId: pathologist.id, pin: '2468' } });
    const reported = await desk.call('GET', C('lab/bench'));
    assert.deepEqual(reported.orders.map((o) => o.id), [routine.id, atBranch.id, urgent.id]);
    assert.equal(reported.orders[2].status, 'approved');
    assert.ok(reported.orders[2].approved_at);

    // Who may read it: anyone who sees lab orders, in a clinic with the lab on.
    await keeper.call('GET', C('lab/bench'), undefined, 403);
    await request('GET', `/businesses/${plain.id}/lab/bench`, undefined, 403);
    await request('GET', `/businesses/${grocery.id}/lab/bench`, undefined, 403);
    await other('GET', C('lab/bench'), undefined, 404);
    assert.deepEqual((await other('GET', E('lab/bench'))).orders, []);
  });

  await t.test('what the front desk reads of the lab holds no result', async () => {
    const deskRow = (await desk.call('GET', C('lab/orders?limit=100'))).items.find((o) => o.id === urgent.id);
    const labRow = (await tech.call('GET', C('lab/orders?limit=100'))).items.find((o) => o.id === urgent.id);
    assert.equal(deskRow.flagged, null);
    assert.equal(labRow.flagged, 1);
    assert.equal(deskRow.order_no, urgent.order_no);
    // An amendment's reason quotes the values: the lab's and the doctors', not the desk's.
    const reason = 'Transcription error: 6.5 entered for 9.5';
    await patho.call('POST', C(`lab/orders/${urgent.id}/amend`), { reason, signoff: { signatoryId: pathologist.id, pin: '2468' } });
    const deskView = await desk.call('GET', C(`lab/orders/${urgent.id}`));
    assert.deepEqual([deskView.status, deskView.amend_reason, deskView.results_visible], ['resulted', null, false]);
    assert.ok(deskView.tests.every((x) => x.parameters === undefined));
    assert.equal((await tech.call('GET', C(`lab/orders/${urgent.id}`))).amend_reason, reason);
    assert.equal((await doctor.call('GET', C(`lab/orders/${urgent.id}`))).amend_reason, reason);
    const referred = await desk.call('POST', C(`lab/orders/${urgent.id}/refer`), { outsideLab: 'Metro reference lab' });
    assert.deepEqual([referred.outside_lab, referred.amend_reason], ['Metro reference lab', null]);
  });

  await t.test("every change of a lab order reaches the business's live stream, and nobody else's", async () => {
    const lab = listen(C('live'), tech.token);
    const branch = listen(C('live'), kdp.token);
    const theirs = listen(E('live'), otherToken);
    await Promise.all([lab.ready(), branch.ready(), theirs.ready()]);
    const fresh = await order(lakshmi);
    await lab.until(() => lab.changes().find((m) => m.area === 'lab' && m.id === Number(fresh.id) && m.location === Number(main.id)));
    let from = lab.messages.length;
    // A sample collected and received, a result typed: each is announced as its order, at its location.
    await desk.call('POST', C(`lab/samples/${fresh.samples[0].id}`), { action: 'collect' });
    assert.deepEqual(await lab.change(from, 'lab', fresh.id), { area: 'lab', id: Number(fresh.id), location: Number(main.id) });
    from = lab.messages.length;
    await tech.call('POST', C(`lab/samples/${fresh.samples[0].id}`), { action: 'receive' });
    await lab.change(from, 'lab', fresh.id);
    from = lab.messages.length;
    await resultFor(fresh.id, hb, '13.1');
    await lab.change(from, 'lab', fresh.id);
    // A result typed again with the same value changes nothing, and says nothing.
    from = lab.messages.length;
    await resultFor(fresh.id, hb, '13.1');
    await wait(1500);
    assert.deepEqual(lab.changes(from).filter((m) => m.area === 'lab'), []);
    // A login tied to Kondapur hears none of the main clinic's order, sample and result
    // changes (only the order's outbox event, which names no location); another
    // owner's clinic hears nothing of this one.
    assert.deepEqual(branch.changes().filter((m) => m.area === 'lab' && m.location !== undefined), []);
    assert.deepEqual(theirs.changes().filter((m) => m.area === 'lab'), []);
    // Every message names where and what, never more.
    for (const message of lab.changes()) assert.ok(Object.keys(message).every((k) => ['area', 'id', 'location'].includes(k)), JSON.stringify(message));
  });
});
