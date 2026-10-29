const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { daysFrom, momentAt } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// What the garage keeps beyond its job cards' first round: parts that fit a
// vehicle and the substitutes offered when one is out of stock (typed and
// imported), inspection photos, a mechanic's notes, the road test and the
// gate pass, parts issued to a mechanic and brought back (stock out once,
// never twice), service plans by model, mechanics' commission paid through the
// expense book, insurance claims (the owner's share split by GST slab, a
// reimbursement billed in the insurer's name and paid by the customer, the
// claim's progress, the insurer's payments and a short payment written off or
// billed), and job cards opened from a service booking or a quotation.
// Refusals with their codes, idempotent retries, audit and events. Runs on its
// own throwaway database with every migration applied.
test('the garage, the rest', { timeout: 300000 }, async (t) => {
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
  const dir = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes this migration away and Up brings it back', async () => {
    const probe = new Client({ ...connection, database });
    await probe.connect();
    try {
      const tables = ['garage_part_groups', 'garage_parts', 'garage_part_fitments', 'garage_inspection_items', 'garage_job_card_photos', 'garage_part_issues', 'garage_road_tests',
        'garage_gate_passes', 'garage_claim_steps', 'garage_claim_settlements', 'garage_service_plans', 'garage_commission_rates', 'garage_commissions', 'garage_commission_payouts'];
      const left = async () => (await probe.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
      const column = async (table, name) => (await probe.query('SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, name])).rows[0].n;
      assert.equal(await left(), tables.length);
      const stamp = Number(require('node:fs').readdirSync(dir).find((file) => file.endsWith('_garage-more.sql')).split('_')[0]);
      await migrate({ direction: 'down', count: stamp, timestamp: true });
      assert.equal(await left(), 0);
      for (const [table, name] of [['garage_claims', 'insurer_named'], ['garage_claims', 'intimated_on'], ['garage_job_cards', 'appointment_id'], ['garage_job_cards', 'quotation_id'],
        ['garage_vehicles', 'engine_code'], ['garage_settings', 'issue_parts'], ['garage_settings', 'road_test_required']]) assert.equal(await column(table, name), 0, `${table}.${name} is gone`);
      await migrate({ direction: 'up', count: Infinity });
      assert.equal(await left(), tables.length);
    } finally { await probe.end(); }
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Garage-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('gm-owner');
  await owner('gm-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('gm-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('gm-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const expectRefused = async (method, route, body, status, pattern, token) => {
    const result = await refused(method, route, body, token);
    assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result)}`);
    if (pattern) assert.match(result.message, pattern);
  };

  const [made, grocery] = await createBusinesses(request, 'GM', ['garage', 'grocery']);
  const [garage] = await withTools(request, [made]);
  await request('PUT', `/businesses/${garage.id}/modules/quotations`, { enabled: true });
  const [elsewhere] = await createBusinesses(other, 'GMO', ['garage']);
  const G = (suffix) => `/businesses/${garage.id}/${suffix}`;
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);
  const shop = (await request('GET', G('locations'))).items[0];
  const slabs = (await request('GET', G('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const roles = (await request('GET', G('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', G('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('gm-desk@test.invalid', 'cashier');
  const keeper = await staff('gm-keeper@test.invalid', 'stock_keeper');
  const raju = await staff('gm-raju@test.invalid', 'mechanic');
  const suresh = await staff('gm-suresh@test.invalid', 'mechanic');
  const accountant = await staff('gm-accounts@test.invalid', 'accountant');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const cashier = desk.call;
  const goods = (body) => request('POST', G('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', taxRateId: gst18.id, ...body }, 201);
  const service = (body) => request('POST', G('catalog'), { kind: 'service', unit: 'service', taxRateId: gst18.id, ...body }, 201);
  const padOld = await goods({ name: 'Brake pad set (old number)', code: 'BP-1000', price: '1500', hsnCode: '87083000' });
  const padNew = await goods({ name: 'Brake pad set', code: 'BP-1021', price: '1600', hsnCode: '87083000' });
  const padAlt = await goods({ name: 'Brake pad set (aftermarket)', code: 'BP-A77', price: '1100', hsnCode: '87083000' });
  const filter = await goods({ name: 'Oil filter', code: 'FLT-10', price: '380', hsnCode: '84212300' });
  const oil = await goods({ name: 'Engine oil 5W-30', code: 'OIL-5W30', unit: 'litre', price: '450', hsnCode: '27101980' });
  const clutch = await goods({ name: 'Clutch plate (tractor)', code: 'CLU-575', price: '2100', taxRateId: gst5.id, hsnCode: '87089300' });
  const labour = await service({ name: 'General service labour', code: 'LAB-GEN', price: '1200', hsnCode: '998714' });
  const alignment = await service({ name: 'Wheel alignment', code: 'SRV-ALN', price: '500', hsnCode: '998714' });
  const share = await service({ name: 'Insurance claim: owner\'s share', code: 'CLM-SHARE', price: '0', hsnCode: '998714' });
  const supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Sai Auto Spares' }, 201);
  await request('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines: [
    { skuId: padNew.id, quantity: '4', unitPrice: '900' }, { skuId: padAlt.id, quantity: '2', unitPrice: '600' }, { skuId: filter.id, quantity: '6', unitPrice: '220' },
    { skuId: oil.id, quantity: '20', unitPrice: '300' }, { skuId: clutch.id, quantity: '4', unitPrice: '1300' }] }, 201);
  const stock = async (skuId) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [garage.id, skuId])).q);
  const ravi = await request('POST', G('contacts'), { kind: 'customer', name: 'Ravi Kumar', phone: '9848022338' }, 201);
  const insurer = await request('POST', G('contacts'), { kind: 'customer', name: 'Bharat General Insurance', gstin: '36AABCB1234F1Z9' }, 201);
  await request('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: share.id });
  const swift = await cashier('POST', G('garage/vehicles'), { registrationNo: 'TS09EA4521', make: 'Maruti Suzuki', model: 'Swift', variant: 'VXi', fuel: 'petrol', year: '2019',
    engineCode: 'k12m', owner: { contactId: ravi.id }, odometerKm: '41000' }, 201);
  const tractor = await cashier('POST', G('garage/vehicles'), { registrationNo: 'AP39TR7788', make: 'Mahindra', model: '575 DI', fuel: 'diesel', owner: { contactId: ravi.id } }, 201);
  const open = (vehicle, extra = {}) => cashier('POST', G('garage/job-cards'), { requestKey: key(), locationId: shop.id, vehicleId: vehicle.id, complaints: ['Service'], ...extra }, 201);
  const line = (kind, item, extra = {}) => ({ kind, skuId: item.id, quantity: '1', ...extra });
  const toReady = async (job, mechanics = []) => {
    if (mechanics.length) await cashier('PUT', G(`garage/job-cards/${job.id}/mechanics`), { userIds: mechanics });
    await cashier('POST', G(`garage/job-cards/${job.id}/approvals`), { requestKey: key(), approvedBy: 'Ravi Kumar', channel: 'phone' }, 201);
    await cashier('POST', G(`garage/job-cards/${job.id}/status`), { status: 'in_progress' });
    return cashier('POST', G(`garage/job-cards/${job.id}/status`), { status: 'ready' });
  };

  await t.test('fitment: the parts that fit a vehicle, in stock first, and the substitutes for one out of stock', async () => {
    assert.equal(swift.engine_code, 'K12M');
    const fit = (body, token = keeper.token) => refused('POST', G('garage/part-fitments'), body, token);
    // The store keeps fitment (catalog.edit): the old pad, the aftermarket pad and the filter fit the Swift; the new pad fits 2018 to 2023 petrol K12M.
    assert.equal((await fit({ skuId: padOld.id, make: 'Maruti  Suzuki', model: 'Swift' })).status, 201);
    assert.equal((await fit({ skuId: padNew.id, make: 'Maruti Suzuki', model: 'Swift', fuel: 'petrol', yearFrom: '2018', yearTo: '2023', engineCode: 'k12m' })).status, 201);
    assert.equal((await fit({ skuId: padAlt.id, make: 'maruti suzuki', model: 'swift', variant: 'ZXi' })).status, 201);
    assert.equal((await fit({ skuId: filter.id, make: 'Maruti Suzuki' })).status, 201);
    assert.equal((await fit({ skuId: filter.id, make: 'Hyundai', model: 'i20' })).status, 201);
    // Refusals: the same fitment twice, a service, years the wrong way round, a variant with no model, a role that does not keep the catalogue.
    await expectRefused('POST', G('garage/part-fitments'), { skuId: filter.id, make: 'MARUTI SUZUKI' }, 409, /already fits maruti suzuki/i, keeper.token);
    await expectRefused('POST', G('garage/part-fitments'), { skuId: labour.id, make: 'Maruti Suzuki' }, 400, /is a service: a part is an item kept in stock/, keeper.token);
    await expectRefused('POST', G('garage/part-fitments'), { skuId: filter.id, make: 'Tata', yearFrom: '2022', yearTo: '2019' }, 400, /Year to/, keeper.token);
    await expectRefused('POST', G('garage/part-fitments'), { skuId: filter.id, make: 'Tata', variant: 'XZ' }, 400, /variant goes with its model/, keeper.token);
    await expectRefused('POST', G('garage/part-fitments'), { skuId: filter.id, make: 'Tata' }, 403, null, desk.token);
    // The vehicle's parts: in stock first; the old pad (none in stock) offers the newer pad; the variant-specific pad is left out.
    const parts = await raju.call('GET', G(`garage/vehicles/${swift.id}/parts`));
    assert.deepEqual(parts.parts.map((p) => [p.code, p.in_stock]), [['BP-1021', 4], ['FLT-10', 6], ['BP-1000', 0]]);
    assert.deepEqual(parts.parts[2].substitutes, []);
    // A newer number and a group: the old pad is replaced by the new one, which shares a group with the aftermarket pad.
    await expectRefused('PUT', G(`garage/parts/${padOld.id}`), { supersededBySkuId: padNew.id }, 403, null, desk.token);
    const linked = await keeper.call('PUT', G(`garage/parts/${padOld.id}`), { supersededBySkuId: padNew.id });
    assert.equal(linked.superseded_by_label, 'Brake pad set');
    await keeper.call('PUT', G(`garage/parts/${padNew.id}`), { group: 'Front brake pads, Swift' });
    await keeper.call('PUT', G(`garage/parts/${padAlt.id}`), { group: 'front brake pads, swift' });
    // A newer number never leads back; a part is never its own newer number.
    await expectRefused('PUT', G(`garage/parts/${padNew.id}`), { supersededBySkuId: padOld.id }, 409, /never leads back/, keeper.token);
    await expectRefused('PUT', G(`garage/parts/${padNew.id}`), { supersededBySkuId: padNew.id }, 400, /replaced by another part/, keeper.token);
    assert.deepEqual((await desk.call('GET', G('garage/part-groups'))).map((g) => [g.name, g.parts]), [['Front brake pads, Swift', 2]]);
    // The counter and the job card ask for a part's substitutes: the newer number, then the group, in stock first.
    const offered = await desk.call('GET', G(`garage/parts/${padOld.id}/substitutes?locationId=${shop.id}`));
    assert.deepEqual([offered.part.in_stock, offered.substitutes.map((x) => [x.code, x.why, x.in_stock])], [0, [['BP-1021', 'newer', 4]]]);
    const both = await desk.call('GET', G(`garage/parts/${padNew.id}/substitutes`));
    assert.deepEqual(both.substitutes.map((x) => [x.code, x.why]), [['BP-A77', 'group'], ['BP-1000', 'older']]);
    const fits = await raju.call('GET', G(`garage/vehicles/${swift.id}/parts?q=old`));
    assert.deepEqual(fits.parts.map((p) => [p.code, p.substitutes.map((x) => x.code)]), [['BP-1000', ['BP-1021']]]);
    // The database keeps a part a stocked item and a chain without loops.
    await assert.rejects(pool.query('INSERT INTO garage_part_fitments(business_id,sku_id,make,created_by) VALUES($1,$2,$3,$4)', [garage.id, labour.id, 'Tata', ownerUser.id]), /kept in stock/);
    // Imported from a CSV file: checked first, then imported; the same file again adds nothing.
    const sheet = [{ 'Part code': 'FLT-10', Make: 'Honda', Model: 'City', 'Year from': '2017' }, { 'Part code': 'bp-a77', Make: 'Maruti Suzuki', Model: 'Dzire' },
      { 'Part code': 'NOPE', Make: 'Tata' }];
    const checked = await keeper.call('POST', G('garage/part-fitments/import'), { rows: sheet, dryRun: true });
    assert.deepEqual([checked.ok, checked.problems.map((p) => [p.line, p.message])], [false, [[4, 'No item has the code NOPE']]]);
    const good = sheet.slice(0, 2);
    const preview = await keeper.call('POST', G('garage/part-fitments/import'), { rows: good, dryRun: true });
    assert.deepEqual([preview.ok, preview.created], [true, 2]);
    const imported = await keeper.call('POST', G('garage/part-fitments/import'), { rows: good, fingerprint: preview.fingerprint, fileName: 'fitment.csv' });
    assert.deepEqual([imported.created, imported.unchanged], [2, 0]);
    assert.deepEqual([(await keeper.call('POST', G('garage/part-fitments/import'), { rows: good })).unchanged], [2]);
    assert.equal((await desk.call('GET', G('garage/part-fitments?q=Dzire'))).total, 1);
    const fitment = (await desk.call('GET', G('garage/part-fitments?q=Hyundai'))).items[0];
    await keeper.call('DELETE', G(`garage/part-fitments/${fitment.id}`));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='garage_part.fitments_imported' AND details->>'file'='fitment.csv'", [garage.id]));
    // Another type has no fitment; another owner sees none.
    await expectRefused('GET', `/businesses/${grocery.id}/garage/vehicles/${swift.id}/parts`, undefined, 404);
    await other('GET', G(`garage/vehicles/${swift.id}/parts`), undefined, 404);
  });

  await t.test('inspection photos, a mechanic\'s note, and who sees them', async () => {
    const job = await open(swift, { mechanicIds: [raju.id] });
    const inspected = await raju.call('POST', G(`garage/job-cards/${job.id}/inspection`), { area: 'Front bumper', finding: 'Scratch on the left' }, 201);
    const item = inspected.items[0];
    await expectRefused('POST', G(`garage/job-cards/${job.id}/inspection`), { area: ' ' }, 400, /Name the area/, raju.token);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/inspection`), { area: 'Tyres' }, 404, null, suresh.token);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
    const upload = async (token, fields, bytes = png, name = 'bumper.png') => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
      form.append('file', new Blob([bytes], { type: 'image/png' }), name);
      const response = await fetch(`${base}/businesses/${garage.id}/garage/photos`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      return { status: response.status, body: await response.json() };
    };
    const added = await upload(raju.token, { jobCardId: job.id, inspectionItemId: item.id, caption: 'Left of the number plate' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    // A renamed file is refused; a mechanic not on the job card cannot add one; a photo of another job card's item is refused.
    assert.equal((await upload(raju.token, { jobCardId: job.id }, Buffer.from('not a photo at all, only text'), 'x.png')).status, 400);
    assert.equal((await upload(suresh.token, { jobCardId: job.id })).status, 404);
    const otherJob = await open(tractor, { mechanicIds: [raju.id] });
    assert.equal((await upload(raju.token, { jobCardId: otherJob.id, inspectionItemId: item.id })).status, 404);
    // Opened only through the API, by someone who sees the job card.
    const photoId = added.body.data.id;
    const get = (token) => fetch(`${base}/businesses/${garage.id}/garage/photos/${photoId}`, { headers: { Authorization: `Bearer ${token}` } });
    const shown = await get(desk.token);
    assert.deepEqual([shown.status, shown.headers.get('content-type'), shown.headers.get('x-content-type-options'), Buffer.from(await shown.arrayBuffer()).equals(png)],
      [200, 'image/png', 'nosniff', true]);
    assert.equal((await get(suresh.token)).status, 404);
    // A mechanic's note and a photo of the work go into the history.
    const noted = await raju.call('POST', G(`garage/job-cards/${job.id}/notes`), { note: 'Rear brake drums worn: tell the owner' }, 201);
    assert.ok(noted.events.some((e) => e.note === 'Rear brake drums worn: tell the owner' && e.by_name === 'gm-raju'));
    assert.equal((await upload(raju.token, { jobCardId: job.id, caption: 'Drums after cleaning' })).status, 201);
    const detail = await desk.call('GET', G(`garage/job-cards/${job.id}`));
    assert.deepEqual([detail.inspection_items.length, detail.photos.length, detail.photos[0].inspection_item_id, detail.photos[1].inspection_item_id],
      [1, 2, item.id, null]);
    // An item with a photo stays; the database keeps photos as taken.
    await expectRefused('DELETE', G(`garage/job-cards/${job.id}/inspection/${item.id}`), undefined, 409, /has photos/, raju.token);
    await assert.rejects(pool.query('DELETE FROM garage_job_card_photos WHERE id=$1', [photoId]), /kept as it was taken/);
    const spare = await raju.call('POST', G(`garage/job-cards/${job.id}/inspection`), { area: 'Spare wheel' }, 201);
    assert.equal((await raju.call('DELETE', G(`garage/job-cards/${job.id}/inspection/${spare.id}`))).items.length, 1);
    await request('POST', G(`garage/job-cards/${job.id}/cancel`), { reason: 'Owner will come back' });
    await request('POST', G(`garage/job-cards/${otherJob.id}/cancel`), { reason: 'Owner will come back' });
    assert.equal((await upload(raju.token, { jobCardId: job.id })).status, 409);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='job_card.photo_added' AND entity_id=$2", [garage.id, job.id]));
  });

  let billedJob;
  await t.test('parts issued to a mechanic leave stock once; the road test, the gate pass, service plans and commission', async () => {
    // A plan for the Swift's model and engine, and commission: 10% on general labour, Suresh 5% on everything.
    await expectRefused('POST', G('garage/plans'), { make: 'Maruti Suzuki', intervalKm: '10000', intervalDays: '365' }, 400, /model, the engine code, or both/);
    await expectRefused('POST', G('garage/plans'), { make: 'Maruti Suzuki', model: 'Swift', engineCode: 'K12M', intervalKm: '100', intervalDays: '365' }, 400, /500 to 1,00,000 km/);
    const plan = await request('POST', G('garage/plans'), { make: 'maruti suzuki', model: 'swift', engineCode: 'k12m', intervalKm: '10,000', intervalDays: '365' }, 201);
    await request('POST', G('garage/plans'), { make: 'Maruti Suzuki', model: 'Swift', intervalKm: '7500', intervalDays: '180' }, 201);
    await expectRefused('POST', G('garage/plans'), { make: 'Maruti Suzuki', model: 'SWIFT', engineCode: 'K12M', intervalKm: '9000', intervalDays: '300' }, 409, /has a plan already/);
    await expectRefused('POST', G('garage/plans'), { make: 'Tata', model: 'Nexon', intervalKm: '9000', intervalDays: '300' }, 403, null, desk.token);
    await request('PUT', G('garage/commission/rates'), { skuId: labour.id, percent: '10' });
    await request('PUT', G('garage/commission/rates'), { userId: suresh.id, percent: '5' });
    await expectRefused('PUT', G('garage/commission/rates'), { skuId: oil.id, percent: '10' }, 400, /commission is on labour/);
    await expectRefused('PUT', G('garage/commission/rates'), { userId: accountant.id, percent: '5' }, 404, /works on job cards/);
    // Issuing parts is the garage's own choice: off, it is refused.
    const job = await open(swift, { odometerKm: '41500', mechanicIds: [raju.id, suresh.id] });
    await cashier('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines: [line('part', oil, { quantity: '3' }), line('part', filter),
      line('labour', labour, { unitPrice: '1180' }), line('labour', alignment)] });
    const fresh = await keeper.call('GET', G(`garage/job-cards/${job.id}`));
    const [oilLine, filterLine, labourLine, alignLine] = fresh.lines;
    const issueBody = { requestKey: key(), mechanicId: raju.id, lines: [{ lineId: oilLine.id, quantity: '3' }, { lineId: filterLine.id, quantity: '1' }] };
    await expectRefused('POST', G(`garage/job-cards/${job.id}/issues`), issueBody, 409, /switch it on in Settings › Garage settings/, keeper.token);
    await expectRefused('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: share.id, issueParts: true, roadTestRequired: true }, 403, null, desk.token);
    const settings = await request('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: share.id, issueParts: true, roadTestRequired: true });
    assert.deepEqual([settings.issue_parts, settings.road_test_required], [true, true]);
    // Issued: the store (inventory.edit) issues; the desk and a mechanic do not.
    await expectRefused('POST', G(`garage/job-cards/${job.id}/issues`), issueBody, 403, null, desk.token);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/issues`), issueBody, 403, null, raju.token);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/issues`), { ...issueBody, requestKey: key(), lines: [{ lineId: labourLine.id, quantity: '1' }] }, 400, /only parts are issued/, keeper.token);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/issues`), { ...issueBody, requestKey: key(), lines: [{ lineId: oilLine.id, quantity: '4' }] }, 409, /3 litre is left to issue/, keeper.token);
    const before = [await stock(oil.id), await stock(filter.id)];
    let now = await keeper.call('POST', G(`garage/job-cards/${job.id}/issues`), issueBody, 201);
    assert.deepEqual([await stock(oil.id), await stock(filter.id)], [before[0] - 3, before[1] - 1]);
    assert.deepEqual(now.parts_held.map((p) => [p.label, p.issued, p.held]), [['Engine oil 5W-30', '3.000', '3.000'], ['Oil filter', '1.000', '1.000']]);
    // A retry issues nothing more; the same key with other parts is refused.
    await keeper.call('POST', G(`garage/job-cards/${job.id}/issues`), issueBody, 201);
    assert.equal(await stock(oil.id), before[0] - 3);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/issues`), { ...issueBody, lines: [{ lineId: oilLine.id, quantity: '1' }] }, 409, /already used for different data/, keeper.token);
    // A part line held for the job keeps it: not taken off, not lowered below what is held; the job card is not cancelled with parts held.
    await expectRefused('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines: [line('part', filter, { lineId: filterLine.id, unitPrice: '380' })] }, 409,
      /has parts issued for it/, desk.token);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/cancel`), { reason: 'x' }, 409, /bring them back into stock before cancelling/);
    // One litre comes back unused: into stock; the bill then waits until the line is issued in full.
    now = await keeper.call('POST', G(`garage/job-cards/${job.id}/issues/back`), { requestKey: key(), lines: [{ lineId: oilLine.id, quantity: '1' }] }, 201);
    assert.equal(await stock(oil.id), before[0] - 2);
    assert.deepEqual(now.parts_held[0].held, '2.000');
    await expectRefused('POST', G(`garage/job-cards/${job.id}/issues/back`), { requestKey: key(), lines: [{ lineId: oilLine.id, quantity: '5' }] }, 409, /2 litre is held/, keeper.token);
    await assert.rejects(pool.query('DELETE FROM garage_part_issues WHERE job_card_id=$1', [job.id]), /kept as they were recorded/);
    // The road test before ready: who drove, how far, passed; a test not passed says why.
    await cashier('POST', G(`garage/job-cards/${job.id}/approvals`), { requestKey: key(), approvedBy: 'Ravi Kumar', channel: 'whatsapp' }, 201);
    await raju.call('POST', G(`garage/job-cards/${job.id}/status`), { status: 'in_progress' });
    await raju.call('POST', G(`garage/job-cards/${job.id}/work`), { lines: [{ lineId: labourLine.id, done: true }] });
    await expectRefused('POST', G(`garage/job-cards/${job.id}/status`), { status: 'ready' }, 409, /Record a passed road test/, raju.token);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/road-tests`), { km: '3', passed: false }, 400, /Say what the road test found/, raju.token);
    await raju.call('POST', G(`garage/job-cards/${job.id}/road-tests`), { km: '3', passed: false, remarks: 'Pulls to the left on braking' }, 201);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/status`), { status: 'ready' }, 409, /Record a passed road test/, raju.token);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/road-tests`), { km: '600', passed: true }, 400, /0.1 to 500 km/, raju.token);
    await expectRefused('POST', G(`garage/job-cards/${job.id}/road-tests`), { km: '2', passed: true, testedBy: accountant.id }, 404, /works on job cards/, raju.token);
    now = await raju.call('POST', G(`garage/job-cards/${job.id}/road-tests`), { km: '4.5', passed: true, remarks: 'Brakes even now' }, 201);
    assert.deepEqual(now.road_tests.map((r) => [r.tested_by_name, r.distance_km, r.passed]), [['gm-raju', '3.0', false], ['gm-raju', '4.5', true]]);
    await raju.call('POST', G(`garage/job-cards/${job.id}/status`), { status: 'ready' });
    // Billing waits for the oil line to be issued in full; then it takes the parts held and nothing more from stock.
    await expectRefused('POST', G(`garage/job-cards/${job.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } }, 409, /Issue 1 litre more of Engine oil/, desk.token);
    await keeper.call('POST', G(`garage/job-cards/${job.id}/issues`), { requestKey: key(), mechanicId: raju.id, lines: [{ lineId: oilLine.id, quantity: '1' }] }, 201);
    const held = [await stock(oil.id), await stock(filter.id)];
    assert.deepEqual(held, [before[0] - 3, before[1] - 1]);
    const billBody = { requestKey: key(), payment: { amount: 'full', method: 'cash' }, odometerOutKm: '41505' };
    billedJob = await cashier('POST', G(`garage/job-cards/${job.id}/bill`), billBody);
    assert.deepEqual([await stock(oil.id), await stock(filter.id)], held, 'the bill takes the parts held, not stock again');
    const lines = await rows('SELECT sku_id,quantity,stock_unit_cost FROM business_document_lines WHERE document_id=$1 ORDER BY id', [billedJob.document_id]);
    assert.deepEqual(lines.map((l) => [Number(l.sku_id), l.quantity, l.stock_unit_cost]).slice(0, 2), [[oil.id, '3.000', '300.0000'], [filter.id, '1.000', '220.0000']]);
    assert.ok(!(await one('SELECT 1 FROM business_stock_movements WHERE document_id=$1', [billedJob.document_id])), 'no stock moved on the bill');
    // The plan of the Swift's model and engine sets the next service: 365 days and 10,000 km.
    assert.deepEqual([billedJob.next_service_on, billedJob.next_service_km], [daysFrom(365), 51505]);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='job_card.billed' AND (details->>'servicePlanId')::bigint=$2", [garage.id, plan.id]));
    // The gate pass: made with the bill; the vehicle leaves once.
    assert.deepEqual([Boolean(billedJob.gate_pass), billedJob.gate_pass.left_at], [true, null]);
    const left = await cashier('POST', G(`garage/job-cards/${job.id}/gate-pass/left`), { note: 'Driven out by the owner' });
    assert.deepEqual([Boolean(left.gate_pass.left_at), left.gate_pass.left_note], [true, 'Driven out by the owner']);
    assert.equal((await cashier('POST', G(`garage/job-cards/${job.id}/gate-pass/left`), { note: 'again' })).gate_pass.left_note, 'Driven out by the owner');
    await assert.rejects(pool.query('UPDATE garage_gate_passes SET left_note=$2 WHERE job_card_id=$1', [job.id, 'x']), /leaves once/);
    await expectRefused('POST', G(`garage/job-cards/${fresh.id}/road-tests`), { km: '2', passed: true }, 409, /no longer changes/, raju.token);
    // Commission: general labour (10%) to Raju who did it; the alignment, with no item rate, shared by the two: Suresh's 5% on his half, Raju none.
    const earned = await rows('SELECT g.user_id,l.label,g.base,g.percent,g.amount FROM garage_commissions g JOIN garage_job_card_lines l ON l.id=g.line_id WHERE g.job_card_id=$1 ORDER BY g.id', [job.id]);
    assert.deepEqual(earned.map((e) => [Number(e.user_id), e.label, e.base, e.percent, e.amount]),
      [[raju.id, 'General service labour', '1000.00', '10.00', '100.00'], [suresh.id, 'Wheel alignment', '211.86', '5.00', '10.59']]);
    void alignLine;
    const report = await accountant.call('GET', G('garage/commission'));
    const row = (userId) => report.rows.find((r) => Number(r.user_id) === Number(userId));
    assert.deepEqual([row(raju.id).earned, row(raju.id).labour, row(raju.id).due, row(suresh.id).earned, report.totals.earned], ['100.00', '1000.00', '100.00', '10.59', '110.59']);
    await expectRefused('GET', G('garage/commission'), undefined, 403, null, desk.token);
    // Paid through the expense book, by a manager, never more than is due.
    await expectRefused('POST', G(`garage/commission/${raju.id}/payouts`), { requestKey: key(), amount: '100', method: 'cash' }, 403, null, accountant.token);
    await expectRefused('POST', G(`garage/commission/${raju.id}/payouts`), { requestKey: key(), amount: '150', method: 'cash' }, 409, /is due 100\.00/);
    const payoutBody = { requestKey: key(), amount: '60', method: 'cash', notes: 'Weekly' };
    const paid = await request('POST', G(`garage/commission/${raju.id}/payouts`), payoutBody, 201);
    assert.equal((await request('POST', G(`garage/commission/${raju.id}/payouts`), payoutBody, 201)).id, paid.id, 'a retry is the same payout');
    const expense = await one('SELECT amount,method,description FROM business_expenses WHERE id=$1', [paid.expense_id]);
    assert.deepEqual([expense.amount, expense.method, expense.description], ['60.00', 'cash', 'Mechanic\'s commission: gm-raju']);
    assert.equal(row(raju.id).due, '100.00');
    assert.equal((await accountant.call('GET', G('garage/commission'))).rows.find((r) => Number(r.user_id) === raju.id).due, '40.00');
    const mine = await accountant.call('GET', G(`garage/commission/${raju.id}`));
    assert.deepEqual([mine.items.map((i) => i.label), mine.payouts.map((p) => p.amount)], [['General service labour'], ['60.00']]);
    await assert.rejects(pool.query('UPDATE garage_commissions SET amount=0 WHERE job_card_id=$1', [job.id]), /kept as it was worked out/);
    await request('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: share.id, issueParts: false, roadTestRequired: false });
  });

  let cashless;
  await t.test('a cashless claim: the owner\'s share split by GST slab, to the paisa; the claim\'s progress; the insurer\'s payments and a short payment written off', async () => {
    cashless = await open(tractor, { complaints: ['Clutch slipping after an accident'] });
    const claimBody = { insurerId: insurer.id, mode: 'cashless', policyNo: 'POL-1', claimNo: 'CLM-1', intimatedOn: daysFrom(-3) };
    await expectRefused('PUT', G(`garage/job-cards/${cashless.id}/claim`), { ...claimBody, intimatedOn: daysFrom(1) }, 400, /intimated today or earlier/, desk.token);
    await expectRefused('PUT', G(`garage/job-cards/${cashless.id}/claim`), { ...claimBody, insurerNamed: true }, 400, /reimbursement claim/, desk.token);
    await cashier('PUT', G(`garage/job-cards/${cashless.id}/claim`), claimBody);
    // The progress: surveyed two days ago; approved needs the amount first; never back, never ahead of today.
    await cashier('POST', G(`garage/job-cards/${cashless.id}/claim/steps`), { step: 'surveyed', on: daysFrom(-2), note: 'K. Srinivas' }, 201);
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/steps`), { step: 'approved' }, 409, /amount the insurer approved/, desk.token);
    await cashier('PUT', G(`garage/job-cards/${cashless.id}/estimate`), { requestKey: key(), lines: [line('part', clutch, { payer: 'insurer' }),
      line('labour', labour, { unitPrice: '1770', payer: 'insurer' }), line('labour', alignment)] });
    await cashier('PUT', G(`garage/job-cards/${cashless.id}/claim`), { ...claimBody, approvedAmount: '3000', deductible: '500', depreciation: '200' });
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/steps`), { step: 'approved', on: daysFrom(-3) }, 409, /on or after the one before/, desk.token);
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/steps`), { step: 'approved', on: daysFrom(1) }, 409, /today or earlier/, desk.token);
    let now = await cashier('POST', G(`garage/job-cards/${cashless.id}/claim/steps`), { step: 'approved', on: daysFrom(-1) }, 201);
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/steps`), { step: 'surveyed' }, 409, /moves forward only/, desk.token);
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/steps`), { step: 'work_done' }, 403, null, raju.token);
    assert.deepEqual([now.claim.status, now.claim.steps.map((s) => s.step), now.claim.intimated_on.slice(0, 10)], ['approved', ['surveyed', 'approved'], daysFrom(-3)]);
    // A claim that has moved on stays on the job card.
    await expectRefused('DELETE', G(`garage/job-cards/${cashless.id}/claim`), undefined, 409, /is approved: it stays on the job card/, desk.token);
    // The owner's share at the slabs of the insurer's lines: the clutch (5%) and the labour (18%), each less its part of the approval.
    now = await toReady(now);
    // Salvage: the old clutch plate kept for the surveyor; labour has no old part.
    const clutchLine = now.lines.find((l) => l.kind === 'part'), labourLine = now.lines.find((l) => l.kind === 'labour');
    await expectRefused('PUT', G(`garage/job-cards/${cashless.id}/old-parts`), { lines: [{ lineId: labourLine.id, oldPart: 'scrap' }] }, 400, /only a part has an old part/, desk.token);
    await expectRefused('PUT', G(`garage/job-cards/${cashless.id}/old-parts`), { lines: [{ lineId: clutchLine.id, oldPart: 'melted' }] }, 400, null, desk.token);
    now = await raju.call('PUT', G(`garage/job-cards/${cashless.id}/old-parts`), { lines: [{ lineId: clutchLine.id, oldPart: 'surveyor' }] }, 404);
    now = await cashier('PUT', G(`garage/job-cards/${cashless.id}/old-parts`), { lines: [{ lineId: clutchLine.id, oldPart: 'surveyor' }] });
    assert.equal(now.lines.find((l) => l.id === clutchLine.id).old_part, 'surveyor');
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='job_card.old_parts_recorded' AND entity_id=$2", [garage.id, cashless.id]));
    assert.deepEqual(now.bill.share_lines.map((x) => [x.rate, paise(x.net) + paise(x.tax)]), [['5.00', 47209], ['18.00', 39791]]);
    assert.deepEqual([now.bill.total, now.bill.insurer.total, now.bill.customer.total], ['4370.00', '3000.00', '1370.00']);
    const billed = await cashier('POST', G(`garage/job-cards/${cashless.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const ownerLines = await rows('SELECT sku_id,label,tax_rate,net,tax FROM business_document_lines WHERE document_id=$1 ORDER BY id', [billed.document_id]);
    assert.deepEqual(ownerLines.map((l) => [Number(l.sku_id), l.label, l.tax_rate, paise(l.net) + paise(l.tax)]), [[alignment.id, 'Wheel alignment', '18.00', 50000],
      [share.id, 'Insurance claim: owner\'s share (GST 5%)', '5.00', 47209], [share.id, 'Insurance claim: owner\'s share (GST 18%)', '18.00', 39791]]);
    for (const l of ownerLines.slice(1)) assert.equal(paise(l.tax), Math.round(paise(l.net) * Number(l.tax_rate) / 100), 'GST at the slab, to the paisa');
    const insurerBill = await one('SELECT total FROM business_documents WHERE id=$1', [billed.insurer_document_id]);
    const ownerBill = await one('SELECT total FROM business_documents WHERE id=$1', [billed.document_id]);
    assert.equal(paise(insurerBill.total) + paise(ownerBill.total), paise(now.total), 'the two bills are the job, to the paisa');
    assert.deepEqual([billed.claim.status, billed.claim.insurer_bill.due], ['invoiced', '3000.00']);
    await expectRefused('PUT', G(`garage/job-cards/${cashless.id}/old-parts`), { lines: [{ lineId: clutchLine.id, oldPart: 'scrap' }] }, 409, /no longer changes/, desk.token);
    // The insurer pays part: recorded against its bill (the accountant may), never more than is due.
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/payments`), { requestKey: key(), amount: '3500', method: 'bank' }, 409, /owes 3000\.00/, accountant.token);
    const payBody = { requestKey: key(), amount: '2500', method: 'bank', reference: 'UTR 4455' };
    now = await accountant.call('POST', G(`garage/job-cards/${cashless.id}/claim/payments`), payBody, 201);
    assert.equal((await accountant.call('POST', G(`garage/job-cards/${cashless.id}/claim/payments`), payBody, 201)).claim.insurer_bill.paid, '2500.00', 'a retry pays once');
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/payments`), { ...payBody, amount: '2400' }, 409, /already used for different data/, accountant.token);
    assert.deepEqual([now.claim.insurer_bill.due, now.claim.status], ['500.00', 'invoiced']);
    // The short payment written off: a manager's say-so (the desk names the manager and their PIN), a credit note on the insurer's bill.
    const writeOff = { requestKey: key(), how: 'written_off', reason: 'Insurer deducted the labour difference' };
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/settle`), writeOff, 400, /PIN/, desk.token);
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/settle`), { ...writeOff, approverId: ownerUser.id, pin: '1111' }, 400, /not right/, desk.token);
    now = await cashier('POST', G(`garage/job-cards/${cashless.id}/claim/settle`), { ...writeOff, approverId: ownerUser.id, pin: '2468' }, 201);
    assert.deepEqual([now.claim.status, now.claim.settlement.how, now.claim.settlement.short_amount, now.claim.insurer_bill.due, now.claim.insurer_bill.credited],
      ['settled', 'written_off', '500.00', '0.00', '500.00']);
    const credit = await one('SELECT total,round_off FROM business_returns WHERE document_id=$1', [billed.insurer_document_id]);
    assert.deepEqual([credit.total, credit.round_off], ['500.00', '0.00']);
    const credited = await rows(`SELECT dl.tax_rate,rl.net,rl.tax,rl.restock FROM business_return_lines rl JOIN business_document_lines dl ON dl.id=rl.line_id
      JOIN business_returns r ON r.id=rl.return_id WHERE r.document_id=$1 ORDER BY rl.id`, [billed.insurer_document_id]);
    assert.equal(credited.reduce((s, l) => s + paise(l.net) + paise(l.tax), 0), 50000);
    assert.ok(credited.every((l) => l.restock === false), 'nothing comes back into stock');
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='job_card.claim_short_written_off' AND actor_id=$2 AND entity_id=$3", [garage.id, ownerUser.id, cashless.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='job_card.claim_settled' AND entity_id=$2", [garage.id, cashless.id]));
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/settle`), { ...writeOff, requestKey: key(), approverId: ownerUser.id, pin: '2468' }, 409, /settled already/, desk.token);
    await expectRefused('POST', G(`garage/job-cards/${cashless.id}/claim/payments`), { requestKey: key(), amount: '1', method: 'bank' }, 409, /settled/, accountant.token);
    await assert.rejects(pool.query('DELETE FROM garage_claim_steps WHERE job_card_id=$1', [cashless.id]), /progress is kept/);
  });

  await t.test('a short payment billed to the customer, and a reimbursement claim billed in the insurer\'s name and paid by the customer', async () => {
    const job = await open(tractor, { complaints: ['Clutch again'] });
    const claimBody = { insurerId: insurer.id, mode: 'cashless', policyNo: 'POL-2', claimNo: 'CLM-2' };
    await cashier('PUT', G(`garage/job-cards/${job.id}/claim`), claimBody);
    await cashier('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines: [line('part', clutch, { payer: 'insurer' }), line('labour', labour, { unitPrice: '1770', payer: 'insurer' })] });
    await cashier('PUT', G(`garage/job-cards/${job.id}/claim`), { ...claimBody, approvedAmount: '3870' });
    await toReady(await cashier('GET', G(`garage/job-cards/${job.id}`)));
    let now = await cashier('POST', G(`garage/job-cards/${job.id}/bill`), { requestKey: key() });
    assert.equal(now.document_id, null, 'the insurer pays the whole job');
    await accountant.call('POST', G(`garage/job-cards/${job.id}/claim/payments`), { requestKey: key(), amount: '3600', method: 'cheque', reference: '004512' }, 201);
    // Billed to the customer: the desk (no PIN), a credit note on the insurer's bill and a bill to the customer at the same slabs.
    await expectRefused('POST', G(`garage/job-cards/${job.id}/claim/settle`), { requestKey: key(), how: 'billed', reason: 'x' }, 403, null, accountant.token);
    now = await cashier('POST', G(`garage/job-cards/${job.id}/claim/settle`), { requestKey: key(), how: 'billed', reason: 'Owner agreed to pay what the insurer cut' }, 201);
    assert.deepEqual([now.claim.status, now.claim.settlement.how, now.claim.settlement.short_amount, now.claim.insurer_bill.due], ['settled', 'billed', '270.00', '0.00']);
    const settlement = await one('SELECT customer_document_id FROM garage_claim_settlements WHERE job_card_id=$1', [job.id]);
    const ownerBill = await one('SELECT total,contact_id FROM business_documents WHERE id=$1', [settlement.customer_document_id]);
    assert.deepEqual([ownerBill.total, Number(ownerBill.contact_id)], ['270.00', Number(ravi.id)]);
    const lines = await rows('SELECT tax_rate,net,tax FROM business_document_lines WHERE document_id=$1 ORDER BY id', [settlement.customer_document_id]);
    assert.deepEqual(lines.map((l) => l.tax_rate), ['5.00', '18.00']);
    assert.equal(lines.reduce((s, l) => s + paise(l.net) + paise(l.tax), 0), 27000);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='job_card.claim_short_billed' AND entity_id=$2", [garage.id, job.id]));

    // Reimbursement in the insurer's name: two bills, the customer pays both now.
    const rb = await open(swift, { complaints: ['Bumper replaced'] });
    const rbClaim = { insurerId: insurer.id, mode: 'reimbursement', insurerNamed: true, policyNo: 'POL-3', claimNo: 'RB-3' };
    await cashier('PUT', G(`garage/job-cards/${rb.id}/claim`), rbClaim);
    await cashier('PUT', G(`garage/job-cards/${rb.id}/estimate`), { requestKey: key(), lines: [line('labour', labour, { unitPrice: '2000', payer: 'insurer' }), line('labour', alignment)] });
    let ready = await toReady(await cashier('GET', G(`garage/job-cards/${rb.id}`)));
    assert.match(ready.bill.problem, /before billing it in the insurer's name/);
    await cashier('PUT', G(`garage/job-cards/${rb.id}/claim`), { ...rbClaim, approvedAmount: '1800' });
    ready = await cashier('GET', G(`garage/job-cards/${rb.id}`));
    assert.deepEqual([ready.bill.insurer_named, ready.bill.insurer.total, ready.bill.customer.total], [true, '1800.00', '700.00']);
    await expectRefused('POST', G(`garage/job-cards/${rb.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } }, 400, /pays the bill in the insurer's name now/, desk.token);
    const done = await cashier('POST', G(`garage/job-cards/${rb.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' }, insurerPayment: { method: 'upi', reference: 'UPI-77' } });
    const insurerBill = await one('SELECT total,contact_id,notes FROM business_documents WHERE id=$1', [done.insurer_document_id]);
    assert.deepEqual([insurerBill.total, Number(insurerBill.contact_id)], ['1800.00', Number(insurer.id)]);
    assert.match(insurerBill.notes, /reimbursement, paid by Ravi Kumar/);
    const pay = await one('SELECT amount,method,reference FROM business_payments WHERE document_id=$1', [done.insurer_document_id]);
    assert.deepEqual([pay.amount, pay.method, pay.reference], ['1800.00', 'upi', 'UPI-77']);
    assert.deepEqual([done.claim.status, done.claim.insurer_bill.due, done.claim.steps.map((s) => s.step)], ['settled', '0.00', ['invoiced', 'settled']]);
  });

  await t.test('a service booking and a quotation become job cards', async () => {
    const bay = await request('POST', G('resources'), { locationId: shop.id, name: 'Bay 1', roleLabel: 'Service bay' }, 201);
    const at = (days, hour) => momentAt(daysFrom(days), hour);
    const booking = await request('POST', G('appointments'), { resourceId: bay.id, contactId: ravi.id, skuId: labour.id, startsAt: at(0, '09:00'), endsAt: at(0, '10:00') }, 201);
    const later = await request('POST', G('appointments'), { resourceId: bay.id, contactId: ravi.id, skuId: labour.id, startsAt: at(2, '09:00'), endsAt: at(2, '10:00') }, 201);
    const stranger = await request('POST', G('contacts'), { kind: 'customer', name: 'Someone Else' }, 201);
    const theirs = await request('POST', G('appointments'), { resourceId: bay.id, contactId: stranger.id, skuId: labour.id, startsAt: at(0, '11:00'), endsAt: at(0, '12:00') }, 201);
    const waiting = await cashier('GET', G('garage/bookings'));
    assert.deepEqual(waiting.map((b) => Number(b.id)).sort(), [Number(booking.id), Number(theirs.id)].sort());
    assert.deepEqual(waiting.find((b) => Number(b.id) === Number(booking.id)).vehicles.map((v) => v.registration_no), ['AP39TR7788', 'TS09EA4521']);
    const body = { requestKey: key(), locationId: shop.id, vehicleId: swift.id, complaints: ['Periodic service'], appointmentId: booking.id };
    await expectRefused('POST', G('garage/job-cards'), { ...body, requestKey: key(), appointmentId: later.id }, 409, /later day/, desk.token);
    await expectRefused('POST', G('garage/job-cards'), { ...body, requestKey: key(), appointmentId: theirs.id }, 409, /another customer's/, desk.token);
    const fromBooking = await cashier('POST', G('garage/job-cards'), body, 201);
    assert.deepEqual([Number(fromBooking.appointment_id), fromBooking.booking.status], [Number(booking.id), 'completed']);
    assert.match(fromBooking.events[0].note, /from the service booking of/);
    assert.equal((await cashier('POST', G('garage/job-cards'), body, 201)).id, fromBooking.id, 'a retry is the same job card');
    await expectRefused('POST', G('garage/job-cards'), { ...body, requestKey: key() }, 409, /is completed/, desk.token);
    assert.ok(!(await cashier('GET', G('garage/bookings'))).some((b) => Number(b.id) === Number(booking.id)));
    // A quotation of the customer's becomes the estimate, at its prices, and is closed.
    const quotation = await request('POST', G('quotations'), { requestKey: key(), locationId: shop.id, contactId: ravi.id, validUntil: daysFrom(10),
      lines: [{ skuId: padNew.id, quantity: '1' }, { skuId: alignment.id, quantity: '1' }] }, 201);
    const offered = await cashier('GET', G(`garage/job-cards/${fromBooking.id}/quotations`));
    assert.deepEqual(offered.map((q) => q.quotation_no), [quotation.quotation_no]);
    const convertBody = { requestKey: key(), quotationId: quotation.id };
    await expectRefused('POST', G(`garage/job-cards/${fromBooking.id}/estimate/quotation`), convertBody, 403, null, raju.token);
    const estimated = await cashier('POST', G(`garage/job-cards/${fromBooking.id}/estimate/quotation`), convertBody);
    assert.deepEqual([estimated.estimate_version, estimated.versions[0].source, estimated.total, estimated.lines.map((l) => [l.kind, l.label]), estimated.quotation.quotation_no],
      [1, 'quotation', quotation.total, [['part', 'Brake pad set'], ['labour', 'Wheel alignment']], quotation.quotation_no]);
    assert.equal((await cashier('POST', G(`garage/job-cards/${fromBooking.id}/estimate/quotation`), convertBody)).estimate_version, 1, 'a retry is the same version');
    const closed = await request('GET', G(`quotations/${quotation.id}`));
    assert.deepEqual([closed.status, closed.cancel_reason], ['cancelled', `Made into the estimate of job card ${fromBooking.job_no}`]);
    const second = await open(tractor, { complaints: ['Check'] });
    await expectRefused('POST', G(`garage/job-cards/${second.id}/estimate/quotation`), { requestKey: key(), quotationId: quotation.id }, 409, /is cancelled/, desk.token);
    await expectRefused('POST', G(`garage/job-cards/${fromBooking.id}/estimate/quotation`), { requestKey: key(), quotationId: quotation.id }, 409, /has an estimate already/, desk.token);
    await request('POST', G(`garage/job-cards/${second.id}/cancel`), { reason: 'Opened to check a refusal' });
    await request('POST', G(`garage/job-cards/${fromBooking.id}/cancel`), { reason: 'Customer will come back' });
  });

  await t.test('another type, another owner, and the database\'s rules', async () => {
    await expectRefused('GET', `/businesses/${grocery.id}/garage/part-fitments`, undefined, 404);
    await expectRefused('GET', `/businesses/${grocery.id}/garage/commission`, undefined, 404);
    await expectRefused('GET', `/businesses/${grocery.id}/garage/plans`, undefined, 403);
    await other('GET', `/businesses/${elsewhere.id}/garage/part-fitments`);
    assert.equal((await other('GET', `/businesses/${elsewhere.id}/garage/part-fitments`)).total, 0);
    await other('GET', G('garage/commission'), undefined, 404);
    // A step is not recorded on a job card's claim before it is billed as invoiced, nor settled before invoiced.
    const job = await open(tractor, { complaints: ['Rules'] });
    await cashier('PUT', G(`garage/job-cards/${job.id}/claim`), { insurerId: insurer.id, mode: 'cashless', policyNo: 'POL-9' });
    await assert.rejects(pool.query("INSERT INTO garage_claim_steps(business_id,job_card_id,step,on_date,created_by) VALUES($1,$2,'invoiced',$3,$4)", [garage.id, job.id, today, ownerUser.id]),
      /invoiced with the job's bills/);
    await assert.rejects(pool.query('INSERT INTO garage_gate_passes(business_id,job_card_id,issued_by) VALUES($1,$2,$3)', [garage.id, job.id, ownerUser.id]), /when the job is billed/);
    await request('POST', G(`garage/job-cards/${job.id}/cancel`), { reason: 'Rules checked' });
  });
});
