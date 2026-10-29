const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { publishNotice, giveConsent } = require('./helpers/privacy');
const { daysFrom, momentAt } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The garage's own tools: vehicles (the plate as printed, owners kept, the
// odometer log that refuses a lower reading unless a manager approves it),
// job cards (the estimate with its versions and the owner's approvals, the
// mechanics and their work, the claim, billing through the core: one bill,
// or for a cashless claim one to the insurer and one to the owner adding up
// to the job to the paisa), service reminders by date and kilometres, and a
// customer's statement of jobs per vehicle. Idempotent postings, the rules
// the database keeps, audit and events, other types and other owners. Runs
// on its own throwaway database with every migration applied.
test('the garage', { timeout: 300000 }, async (t) => {
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
  const ownerUser = await owner('garage-owner');
  await owner('garage-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(await login('garage-owner@test.invalid'));
  const other = as(await login('garage-other@test.invalid'));

  const [made, grocery, optical] = await createBusinesses(request, 'OWNER', ['garage', 'grocery', 'optical']);
  // The garage also books services and keeps mechanic and retailer rates (its recommended tools).
  const [garage] = await withTools(request, [made]);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['garage']);

  await t.test('modules, permissions and roles per type', async () => {
    assert.ok(made.capabilities.includes('garage'), 'a garage starts with vehicles & job cards');
    for (const business of [grocery, optical]) assert.ok(!business.capabilities.includes('garage'), `${business.business_type} has no garage tools`);
    const tools = await request('GET', `/businesses/${garage.id}/modules`);
    const module = tools.find((m) => m.code === 'garage');
    assert.equal(module.name, 'Vehicles & job cards');
    assert.deepEqual([...module.requires].sort(), ['catalog', 'contacts', 'sales']);
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'garage'), 'a grocery is not offered the garage tools');
    await request('PUT', `/businesses/${grocery.id}/modules/garage`, { enabled: true }, 409);
    // The sales module stays on while the garage tools need it.
    await request('PUT', `/businesses/${garage.id}/modules/sales`, { enabled: false }, 409);
    const permissions = await rows("SELECT code FROM business_permissions WHERE module_code='garage' ORDER BY sort_order");
    assert.deepEqual(permissions.map((p) => p.code), ['garage.view', 'garage.create', 'garage.edit', 'garage.approve', 'garage.cancel', 'garage.print']);
    // The mechanic: a garage's own role, with no money.
    const roles = (await request('GET', `/businesses/${garage.id}/roles?limit=100`)).items;
    const mechanic = roles.find((r) => r.template_code === 'mechanic');
    assert.ok(mechanic, 'a garage has the mechanic role');
    assert.equal(mechanic.name, 'Mechanic');
    for (const business of [grocery, optical]) {
      assert.ok(!(await request('GET', `/businesses/${business.id}/roles?limit=100`)).items.some((r) => r.template_code === 'mechanic'), `${business.business_type} has no mechanic`);
    }
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2`, [business.id, template])).p;
    const garageGrants = async (business, template) => (await grants(business, template)).filter((p) => p.startsWith('garage.'));
    assert.deepEqual(await grants(garage, 'mechanic'), ['appointments.view', 'catalog.view', 'garage.edit', 'garage.print', 'inventory.view']);
    assert.ok(!(await grants(garage, 'mechanic')).some((p) => /^(sales|receivables|purchasing)\./.test(p)), 'the mechanic takes no money');
    assert.deepEqual(await garageGrants(garage, 'manager'), ['garage.approve', 'garage.cancel', 'garage.create', 'garage.edit', 'garage.print', 'garage.view']);
    assert.deepEqual(await garageGrants(garage, 'cashier'), ['garage.create', 'garage.edit', 'garage.print', 'garage.view']);
    assert.deepEqual(await garageGrants(garage, 'stock_keeper'), ['garage.view']);
    assert.deepEqual(await garageGrants(garage, 'accountant'), ['garage.print', 'garage.view']);
    assert.deepEqual(await garageGrants(garage, 'viewer'), ['garage.view']);
    assert.deepEqual(await garageGrants(grocery, 'viewer'), ['garage.view'], 'role copies match their templates everywhere');
    // Job cards are numbered documents of their own; an advance handed back from one is a refund of its own source.
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'")).d.includes("'job_card'"));
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_collection_refunds_source_check'")).d.includes("'garage'"));
    // Another owner's garage is a business of its own.
    assert.notEqual(String(elsewhere.id), String(garage.id));
  });

  // --- Shared set-up: the workshop, its staff, its customers -------------------------------------
  const G = (suffix) => `/businesses/${garage.id}/${suffix}`;
  const shop = (await request('GET', G('locations'))).items[0];
  const ravi = await request('POST', G('contacts'), { kind: 'customer', name: 'Ravi Kumar', phone: '9848022338' }, 201);
  const insurer = await request('POST', G('contacts'), { kind: 'customer', name: 'Bharat General Insurance', gstin: '36AABCB1234F1Z9' }, 201);
  const supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Sai Auto Spares' }, 201);

  await t.test('the database keeps vehicles, odometer readings and job cards within their rules', async () => {
    const rule = await request('POST', G('contacts'), { kind: 'customer', name: 'Rule Check' }, 201);
    const vehicle = (registration, contactId = rule.id) => pool.query(`INSERT INTO garage_vehicles(business_id,registration_no,make,model,contact_id,created_by,updated_by)
      VALUES($1,$2,'Maruti Suzuki','Swift',$3,$4,$4) RETURNING *`, [garage.id, registration, contactId, ownerUser.id]).then((r) => r.rows[0]);
    const car = await vehicle('TS07RC0001');
    // The plate as printed: upper case, letters and digits only, one vehicle per number; a customer owns it.
    await assert.rejects(vehicle('ts07rc0002'), /check/);
    await assert.rejects(vehicle('TS07 RC0002'), /check/);
    await assert.rejects(vehicle('TS07RC0001'), /unique|duplicate/);
    await assert.rejects(vehicle('TS07RC0003', supplier.id), /Choose a customer/);
    // Never deleted; every owner kept; the odometer log refuses a lower reading unless a manager approved it.
    await assert.rejects(pool.query('DELETE FROM garage_vehicles WHERE id=$1', [car.id]), /never deleted/);
    assert.equal((await one('SELECT count(*)::int AS n FROM garage_vehicle_owners WHERE vehicle_id=$1', [car.id])).n, 1);
    const read = (km, by = null, reason = null) => pool.query(`INSERT INTO garage_odometer_readings(business_id,vehicle_id,reading_km,source,recorded_by,lower_approved_by,lower_reason)
      VALUES($1,$2,$3,'vehicle',$4,$5,$6)`, [garage.id, car.id, km, ownerUser.id, by, reason]);
    await read(30000);
    await assert.rejects(read(29999), /reads 29999 km, lower than its last reading of 30000 km/);
    await assert.rejects(read(30001, ownerUser.id, 'x'), /Only a reading lower than the last/);
    await read(10, ownerUser.id, 'Instrument cluster replaced');
    assert.equal((await one('SELECT odometer_km FROM garage_vehicles WHERE id=$1', [car.id])).odometer_km, 10);
    await assert.rejects(pool.query('UPDATE garage_vehicles SET odometer_km=5 WHERE id=$1', [car.id]), /never typed over/);
    await assert.rejects(pool.query('DELETE FROM garage_odometer_readings WHERE vehicle_id=$1', [car.id]), /kept as it was read/);
    // A job card starts as received; its lines are parts (goods) or labour and outside work (services).
    const job = await one(`INSERT INTO garage_job_cards(business_id,location_id,job_no,vehicle_id,registration_no,vehicle_name,contact_id,customer_name,complaints,tax_mode,request_key,request_hash,created_by)
      VALUES($1,$2,'RULE-1',$3,'TS07RC0001','Maruti Suzuki Swift',$4,'Rule Check','{"Brake noise"}','inclusive',$5,$6,$7) RETURNING *`,
    [garage.id, shop.id, car.id, rule.id, crypto.randomUUID(), 'x'.repeat(64), ownerUser.id]);
    await assert.rejects(pool.query(`UPDATE garage_job_cards SET status='delivered',delivered_at=now(),delivered_by=$2,bill_key=$3 WHERE id=$1`, [job.id, ownerUser.id, crypto.randomUUID()]),
      /cannot go from received to delivered/);
    await assert.rejects(pool.query("UPDATE garage_job_cards SET status='estimate_sent' WHERE id=$1", [job.id]), /check/);
    await assert.rejects(pool.query("UPDATE garage_job_cards SET status='approved' WHERE id=$1", [job.id]), /approved once the owner approves|check/);
    await assert.rejects(pool.query("UPDATE garage_job_cards SET registration_no='XX01XX0001' WHERE id=$1", [job.id]), /keeps its number, vehicle, customer/);
    await assert.rejects(pool.query('DELETE FROM garage_job_cards WHERE id=$1', [job.id]), /never deleted/);
    // Cancelled: it never changes again.
    await pool.query("UPDATE garage_job_cards SET status='cancelled',cancel_reason='Rule check',cancelled_at=now(),cancelled_by=$2 WHERE id=$1", [job.id, ownerUser.id]);
    await assert.rejects(pool.query("UPDATE garage_job_cards SET notes='x' WHERE id=$1", [job.id]), /is cancelled and can no longer change/);
    // Another owner's garage is a business of its own: its vehicles are its own.
    assert.equal((await one('SELECT count(*)::int AS n FROM garage_vehicles WHERE business_id=$1', [elsewhere.id])).n, 0);
  });

  // --- Staff, slabs and items --------------------------------------------------------------------
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const ownerToken = await login('garage-owner@test.invalid');
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const today = daysFrom(0);
  const addMonths = (day, months) => {
    const [y, m, d] = day.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    target.setUTCDate(Math.min(d, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
    return target.toISOString().slice(0, 10);
  };
  const slabs = (await request('GET', G('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const roles = (await request('GET', G('roles?limit=100'))).items;
  const tokens = {};
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', G('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    tokens[email] = await login(email);
    return { id: user.id, call: as(tokens[email]), token: tokens[email] };
  }
  const desk = await staff('garage-desk@test.invalid', 'cashier');
  const raju = await staff('garage-raju@test.invalid', 'mechanic');
  const suresh = await staff('garage-suresh@test.invalid', 'mechanic');
  const viewer = await staff('garage-viewer@test.invalid', 'viewer');
  const cashier = desk.call;
  const goods = (body) => request('POST', G('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', taxRateId: gst18.id, ...body }, 201);
  const service = (body) => request('POST', G('catalog'), { kind: 'service', unit: 'service', taxRateId: gst18.id, ...body }, 201);
  const oil = await goods({ name: 'Engine oil 5W-30', code: 'OIL-5W30', unit: 'litre', price: '449.90', mrp: '480', hsnCode: '27101980' });
  const filter = await goods({ name: 'Oil filter (Swift)', code: 'FLT-SW', price: '380', mrp: '400', hsnCode: '84212300' });
  const coolant = await goods({ name: 'Coolant', code: 'CLT-1', unit: 'litre', price: '250', hsnCode: '38200000' });
  const tyre = await goods({ name: 'Rear tractor tyre 13.6-28', code: 'TYR-1328', price: '18900', taxRateId: gst5.id, hsnCode: '40117000' });
  const clutch = await goods({ name: 'Clutch plate (tractor)', code: 'CLU-575', price: '2100', taxRateId: gst5.id, hsnCode: '87089300' });
  const labour = await service({ name: 'General service labour', code: 'LAB-GEN', price: '1200', hsnCode: '998714' });
  const sublet = await service({ name: 'Outside work', code: 'SUB-OUT', price: '0', hsnCode: '998714' });
  const alignment = await service({ name: 'Wheel alignment', code: 'SRV-ALN', price: '500', hsnCode: '998714' });
  await request('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines: [
    { skuId: oil.id, quantity: '20', unitPrice: '300' }, { skuId: filter.id, quantity: '5', unitPrice: '220' }, { skuId: coolant.id, quantity: '10', unitPrice: '150' },
    { skuId: tyre.id, quantity: '2', unitPrice: '14000' }, { skuId: clutch.id, quantity: '2', unitPrice: '1300' }] }, 201);
  const stock = async (skuId) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [garage.id, skuId])).q);
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('1357', 4)]);
  let swift, tractor, activa, lakshmi;

  // --- Vehicles ------------------------------------------------------------------------------------
  await t.test('vehicles: the plate as printed, owners kept, the odometer log and a manager for a lower reading', async () => {
    // A new owner is made a customer with the vehicle; the plate, chassis and reading are read as people write them.
    swift = await cashier('POST', G('garage/vehicles'), { registrationNo: 'ts 09 ea-4521', make: 'Maruti Suzuki', model: 'Swift', variant: 'VXi', fuel: 'petrol', year: '2019',
      chassisNo: 'ma3 ewde1s00-123456', owner: { name: 'Lakshmi Prasad', phone: '9876501234' }, odometerKm: '41,250', insuranceExpiresOn: daysFrom(20), pucExpiresOn: daysFrom(200) }, 201);
    assert.deepEqual([swift.registration_no, swift.vehicle_name, swift.chassis_no, swift.odometer_km, swift.owner_name, swift.owners.length, swift.readings.length],
      ['TS09EA4521', 'Maruti Suzuki Swift VXi', 'MA3EWDE1S00123456', 41250, 'Lakshmi Prasad', 1, 1]);
    lakshmi = { id: swift.contact_id };
    assert.equal((await one("SELECT kind FROM business_contacts WHERE id=$1", [lakshmi.id])).kind, 'customer');
    // One vehicle per number (the refusal names the vehicle), one per chassis; a plate needs letters and digits.
    const again = await refused('POST', G('garage/vehicles'), { registrationNo: 'TS09EA4521', make: 'Maruti Suzuki', model: 'Swift', owner: { contactId: ravi.id } });
    assert.deepEqual([again.status, again.data?.vehicleId], [409, swift.id]);
    assert.match((await refused('POST', G('garage/vehicles'), { registrationNo: 'TS09EA9999', make: 'X', model: 'Y', chassisNo: 'MA3EWDE1S00123456', owner: { contactId: ravi.id } })).message,
      /already on TS09EA4521/);
    assert.match((await refused('POST', G('garage/vehicles'), { registrationNo: 'SWIFT', make: 'X', model: 'Y', owner: { contactId: ravi.id } })).message, /number on the plate/);
    assert.equal((await refused('POST', G('garage/vehicles'), { registrationNo: 'TS09EA9998', make: 'X', model: 'Y', owner: { contactId: supplier.id } })).status, 404);
    // Ravi's fleet: a tractor and a scooter.
    tractor = await cashier('POST', G('garage/vehicles'), { registrationNo: 'AP39TR7788', make: 'Mahindra', model: '575 DI', fuel: 'diesel', year: '2021', owner: { contactId: ravi.id },
      odometerKm: '2140' }, 201);
    activa = await cashier('POST', G('garage/vehicles'), { registrationNo: 'TS10EV0042', make: 'Honda', model: 'Activa 6G', fuel: 'petrol', owner: { contactId: ravi.id } }, 201);
    // Found by its number however it is typed; the list finds a plate typed with spaces.
    assert.equal((await cashier('GET', G('garage/vehicles/find?registration=ts-09-ea-4521'))).vehicle.id, swift.id);
    assert.equal((await cashier('GET', G('garage/vehicles/find?registration=KA01AA0001'))).vehicle, null);
    assert.deepEqual((await viewer.call('GET', G(`garage/vehicles?q=${encodeURIComponent('ts 09 ea 4521')}`))).items.map((x) => x.id), [swift.id]);
    assert.deepEqual((await viewer.call('GET', G(`garage/vehicles?owner=${ravi.id}`))).items.map((x) => x.registration_no).sort(), ['AP39TR7788', 'TS10EV0042']);
    // A lower reading needs a manager's approval with a note why: refused with the last reading; the desk asks the owner for their PIN.
    const lower = await refused('POST', G(`garage/vehicles/${swift.id}/odometer`), { km: '41000' }, desk.token);
    assert.deepEqual([lower.status, lower.data?.reason, lower.data?.lastKm], [409, 'odometer_lower', 41250]);
    assert.match(lower.message, /reads 41,000 km, lower than its last reading of 41,250 km/);
    // The managers to choose from: who may approve a lower reading, or hand back an advance; a viewer asks no one.
    assert.deepEqual((await cashier('GET', G('garage/approvers'))).map((p) => [Number(p.id), p.has_pin]), [[Number(ownerUser.id), true]]);
    assert.ok((await cashier('GET', G('garage/approvers?permission=sales.refund'))).some((p) => Number(p.id) === Number(ownerUser.id)));
    await cashier('GET', G('garage/approvers?permission=garage.cancel'), undefined, 400);
    await viewer.call('GET', G('garage/approvers'), undefined, 403);
    assert.equal((await refused('POST', G(`garage/vehicles/${swift.id}/odometer`), { km: '41000', approval: { reason: 'Cluster replaced', approverId: ownerUser.id, pin: '1111' } }, desk.token)).status, 400);
    const read = await cashier('POST', G(`garage/vehicles/${swift.id}/odometer`), { km: '41000', approval: { reason: 'Instrument cluster replaced', approverId: ownerUser.id, pin: '1357' } }, 201);
    assert.deepEqual([read.odometer_km, read.readings[0].reading_km, read.readings[0].approved_by_name, read.readings[0].lower_reason], [41000, 41000, 'garage-owner', 'Instrument cluster replaced']);
    // The owner, who may approve, gives only the reason; a reading that is not lower needs no approval.
    await request('POST', G(`garage/vehicles/${swift.id}/odometer`), { km: '40990', approval: { reason: 'Typed again after the cluster change' } }, 201);
    await request('POST', G(`garage/vehicles/${swift.id}/odometer`), { km: '41200' }, 201);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='odometer.recorded' AND details->>'reason'='Instrument cluster replaced'", [garage.id]));
    // A change of owner keeps every owner; the details change with a record of what was and what is.
    const sold = await cashier('POST', G(`garage/vehicles/${activa.id}/owner`), { owner: { name: 'Kiran Reddy', phone: '9123456780' }, note: 'Sold by Ravi' });
    assert.deepEqual(sold.owners.map((o) => o.name), ['Kiran Reddy', 'Ravi Kumar']);
    const back = await cashier('POST', G(`garage/vehicles/${activa.id}/owner`), { owner: { contactId: ravi.id } });
    assert.equal(back.owners.length, 3);
    await cashier('POST', G(`garage/vehicles/${activa.id}/owner`), { owner: { contactId: ravi.id } }, 409);
    const changed = await cashier('PATCH', G(`garage/vehicles/${tractor.id}`), { variant: 'XP Plus', pucExpiresOn: daysFrom(-3), registrationNo: 'AP 39 TR 7788' });
    assert.deepEqual([changed.variant, changed.puc_expires_on, changed.registration_no], ['XP Plus', daysFrom(-3), 'AP39TR7788']);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='vehicle.updated' AND entity_id=$2", [garage.id, tractor.id]);
    assert.deepEqual(audit.details.to, { variant: 'XP Plus', puc_expires_on: daysFrom(-3) });
    assert.match((await refused('PATCH', G(`garage/vehicles/${tractor.id}`), { owner: { contactId: lakshmi.id } }, desk.token)).message, /Change owner/);
    // Who sees vehicles: the desk and the viewer; a mechanic and another type do not; another owner sees nothing.
    await raju.call('GET', G('garage/vehicles'), undefined, 403);
    await viewer.call('POST', G('garage/vehicles'), { registrationNo: 'KA01AB1111', make: 'X', model: 'Y', owner: { contactId: ravi.id } }, 403);
    await request('GET', `/businesses/${grocery.id}/garage/vehicles`, undefined, 403);
    await other('GET', G(`garage/vehicles/${swift.id}`), undefined, 404);
  });

  // --- A job card the customer pays ----------------------------------------------------------------
  const tomorrowEvening = momentAt(daysFrom(1), '18:00');
  let job, estimateLines;
  const line = (kind, item, extra = {}) => ({ kind, skuId: item.id, quantity: '1', ...extra });

  await t.test('a job card: the reading in, complaints, mechanics and an advance; the estimate priced as charged, in versions', async () => {
    const body = { requestKey: key(), locationId: shop.id, vehicleId: swift.id, odometerKm: '41600', fuelLevel: 'half', complaints: ['Periodic service', 'Brake noise at low speed', ''],
      inspectionNotes: 'Front pads at 2 mm; wiper blades worn', bay: 'Bay 2', promisedAt: tomorrowEvening, mechanicIds: [raju.id], advance: { amount: '1000', method: 'cash' } };
    job = await cashier('POST', G('garage/job-cards'), body, 201);
    assert.match(job.job_no, /^JC\/\d{4}\/0001$/);
    assert.deepEqual([job.status, job.registration_no, job.vehicle_name, Number(job.contact_id), job.customer_name, job.odometer_in, job.fuel_level, job.complaints, job.bay, job.money],
      ['received', 'TS09EA4521', 'Maruti Suzuki Swift VXi', Number(lakshmi.id), 'Lakshmi Prasad', 41600, 'half', ['Periodic service', 'Brake noise at low speed'], 'Bay 2', true]);
    assert.deepEqual(job.mechanics.map((m) => m.name), ['garage-raju']);
    assert.deepEqual([job.advance.amount, job.advance.free, job.total, job.estimate_version], ['1000.00', '1000.00', '0.00', 0]);
    assert.equal((await one('SELECT odometer_km FROM garage_vehicles WHERE id=$1', [swift.id])).odometer_km, 41600);
    assert.equal((await one("SELECT source FROM garage_odometer_readings WHERE job_card_id=$1", [job.id])).source, 'job_in');
    // A retry gives the same job card; the same key with other data is refused.
    assert.equal((await cashier('POST', G('garage/job-cards'), body, 201)).id, job.id);
    await cashier('POST', G('garage/job-cards'), { ...body, bay: 'Bay 3' }, 409);
    // What opening checks: a complaint, a reading not lower than the last, a promised time ahead, mechanics who work on job cards.
    const refuse = async (extra, pattern, status = 400) => {
      const result = await refused('POST', G('garage/job-cards'), { requestKey: key(), locationId: shop.id, vehicleId: swift.id, complaints: ['Check'], ...extra }, desk.token);
      assert.equal(result.status, status, JSON.stringify(result));
      assert.match(result.message, pattern);
    };
    await refuse({ complaints: [' '] }, /Write what the customer says/);
    await refuse({ odometerKm: '41599' }, /lower than its last reading of 41,600 km/, 409);
    await refuse({ promisedAt: momentAt(daysFrom(-1), '10:00') }, /one that has passed/);
    await refuse({ mechanicIds: [viewer.id] }, /whose role works on job cards/, 404);
    await refuse({ vehicleId: 999999 }, /Vehicle not found/, 404);
    // Opening is the desk's: a mechanic and a viewer do not.
    await raju.call('POST', G('garage/job-cards'), { requestKey: key(), locationId: shop.id, vehicleId: swift.id, complaints: ['x'] }, 403);
    await viewer.call('POST', G('garage/job-cards'), { requestKey: key(), locationId: shop.id, vehicleId: swift.id, complaints: ['x'] }, 403);

    // The estimate: parts at the customer's price, labour and outside work as agreed; every figure the server's.
    estimateLines = [line('part', oil, { quantity: '3.5' }), line('part', filter), line('labour', labour, { unitPrice: '1000', description: 'Periodic service, brakes cleaned' }),
      line('sublet', sublet, { unitPrice: '750', vendorName: 'Sharma Denting Works', description: 'Bumper scratch touch-up' })];
    const preview = await cashier('POST', G(`garage/job-cards/${job.id}/estimate/preview`), { lines: estimateLines });
    assert.deepEqual([preview.subtotal, preview.tax, preview.round_off, preview.total], ['3139.53', '565.12', '0.35', '3705.00']);
    assert.deepEqual(preview.lines.map((l) => [l.label, l.quantity, l.unitPrice, l.net, l.tax]), [['Engine oil 5W-30', '3.500', '449.90', '1334.45', '240.20'],
      ['Oil filter (Swift)', '1.000', '380.00', '322.03', '57.97'], ['General service labour', '1.000', '1000.00', '847.46', '152.54'], ['Outside work', '1.000', '750.00', '635.59', '114.41']]);
    const estimateBody = { requestKey: key(), lines: estimateLines };
    job = await cashier('PUT', G(`garage/job-cards/${job.id}/estimate`), estimateBody);
    assert.deepEqual([job.estimate_version, job.subtotal, job.tax, job.round_off, job.total, job.status], [1, '3139.53', '565.12', '0.35', '3705.00', 'received']);
    assert.deepEqual(job.lines.map((l) => [l.kind, l.payer, l.label, l.net, l.tax, l.vendor_name]), [['part', 'customer', 'Engine oil 5W-30', '1334.45', '240.20', null],
      ['part', 'customer', 'Oil filter (Swift)', '322.03', '57.97', null], ['labour', 'customer', 'General service labour', '847.46', '152.54', null],
      ['sublet', 'customer', 'Outside work', '635.59', '114.41', 'Sharma Denting Works']]);
    assert.equal(job.lines.reduce((s, l) => s + paise(l.net) + paise(l.tax), 0) + paise(job.round_off), paise(job.total));
    assert.deepEqual([job.versions.length, job.versions[0].total, job.versions[0].source, job.versions[0].lines.length], [1, '3705.00', 'estimate', 4]);
    // A retry is the same version; the same key with other lines is refused; saving the same lines makes no new version.
    assert.equal((await cashier('PUT', G(`garage/job-cards/${job.id}/estimate`), estimateBody)).estimate_version, 1);
    await cashier('PUT', G(`garage/job-cards/${job.id}/estimate`), { ...estimateBody, lines: estimateLines.slice(0, 2) }, 409);
    const kept = job.lines.map((l, i) => ({ ...estimateLines[i], lineId: l.id, unitPrice: l.unit_price }));
    assert.equal((await cashier('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines: kept })).estimate_version, 1);
    // What the estimate checks: a part below its price is a discount (the desk gives none), never above the MRP, the right kind of item, the insurer only with a claim.
    const estimate = async (lines, pattern, status) => {
      const result = await refused('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines }, desk.token);
      assert.equal(result.status, status, JSON.stringify(result));
      assert.match(result.message, pattern);
    };
    await estimate([line('part', filter, { unitPrice: '350' })], /a lower price is a discount, which your role does not give/, 403);
    await estimate([line('part', filter, { unitPrice: '410' })], /above its MRP of 400\.00/, 409);
    await estimate([line('part', labour)], /is a service: a part is an item kept in stock/, 400);
    await estimate([line('labour', oil)], /labour and outside work are service items/, 400);
    await estimate([line('sublet', sublet, { vendorName: 'Sharma Denting Works' })], /Give the charge for the outside work/, 400);
    await estimate([line('part', filter, { payer: 'insurer' })], /only on a job card with an insurance claim/, 400);
    await estimate([line('part', oil, { quantity: '1.2345' })], /at most 3 decimal places/, 400);
    // The estimate is the desk's: a mechanic adds the parts they used instead.
    await raju.call('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines: estimateLines }, 403);
  });

  await t.test('the owner approves the estimate as it stands; work, parts used and a revision above the approval go back to the owner', async () => {
    // A quick move is not allowed while the estimate waits: sent from the desk, approved on the phone.
    await raju.call('POST', G(`garage/job-cards/${job.id}/status`), { status: 'estimate_sent' }, 403);
    job = await cashier('POST', G(`garage/job-cards/${job.id}/status`), { status: 'estimate_sent' });
    assert.equal(job.status, 'estimate_sent');
    assert.match((await refused('POST', G(`garage/job-cards/${job.id}/status`), { status: 'in_progress' }, raju.token)).message, /waits for the owner's approval/);
    const approval = { requestKey: key(), approvedBy: 'Lakshmi Prasad', channel: 'phone', note: 'Asked to keep the old wiper blades' };
    job = await cashier('POST', G(`garage/job-cards/${job.id}/approvals`), approval, 201);
    assert.deepEqual([job.status, job.approved_version, job.approvals.length, job.approvals[0].amount, job.approvals[0].channel, job.approvals[0].approved_by],
      ['approved', 1, 1, '3705.00', 'phone', 'Lakshmi Prasad']);
    assert.equal((await cashier('POST', G(`garage/job-cards/${job.id}/approvals`), approval, 201)).approvals.length, 1, 'a retry is the same approval');
    assert.match((await refused('POST', G(`garage/job-cards/${job.id}/approvals`), { ...approval, requestKey: key() }, desk.token)).message, /is approved already/);
    // The mechanic starts work, uses a part, and sees no money anywhere.
    job = await raju.call('POST', G(`garage/job-cards/${job.id}/status`), { status: 'in_progress' });
    assert.deepEqual([job.status, job.money, job.total, job.lines[0].unit_price, job.lines[0].net, job.advance, job.bill, job.approvals[0].amount], ['in_progress', false, null, null, null, null, null, null]);
    assert.ok(!job.events.some((e) => /\d+\.\d{2}/.test(e.note || '')), 'the history names no amounts');
    const parts = { requestKey: key(), parts: [{ skuId: coolant.id, quantity: '1' }], note: 'Coolant was below the mark' };
    job = await raju.call('POST', G(`garage/job-cards/${job.id}/parts`), parts, 201);
    // Version 2 comes to more than the owner approved: back to them.
    assert.deepEqual([job.estimate_version, job.status, job.lines.length, job.lines[4].label, job.lines[4].added_by_name], [2, 'estimate_sent', 5, 'Coolant', 'garage-raju']);
    assert.match(job.events.at(-1).note, /Estimate version 2: parts used · Coolant × 1 · Coolant was below the mark · more than the owner approved: ask the owner again/);
    assert.equal((await raju.call('POST', G(`garage/job-cards/${job.id}/parts`), parts, 201)).estimate_version, 2, 'a retry adds nothing');
    const full = await cashier('GET', G(`garage/job-cards/${job.id}`));
    assert.deepEqual([full.total, full.subtotal, full.tax, full.round_off, full.versions[1].source], ['3955.00', '3351.39', '603.26', '0.35', 'parts']);
    job = await cashier('POST', G(`garage/job-cards/${job.id}/approvals`), { requestKey: key(), approvedBy: 'Lakshmi Prasad', channel: 'whatsapp' }, 201);
    assert.deepEqual([job.status, job.approved_version, job.approvals[1].amount], ['approved', 2, '3955.00']);
    // The mechanic ticks the work done and the job is ready.
    job = await raju.call('POST', G(`garage/job-cards/${job.id}/status`), { status: 'in_progress' });
    job = await raju.call('POST', G(`garage/job-cards/${job.id}/work`), { lines: job.lines.map((l) => ({ lineId: l.id, done: true })), note: 'Road-tested 3 km' });
    assert.deepEqual([job.work.done, job.work.lines, job.lines.every((l) => l.done_by_name === 'garage-raju')], [5, 5, true]);
    assert.match(job.events.at(-1).note, /^Done: Engine oil 5W-30, Oil filter \(Swift\), General service labour, Outside work and Coolant · Road-tested 3 km/);
    job = await raju.call('POST', G(`garage/job-cards/${job.id}/status`), { status: 'ready' });
    assert.equal(job.status, 'ready');
    // Back from ready says why; billing is the desk's (the mechanic takes no money).
    await raju.call('POST', G(`garage/job-cards/${job.id}/status`), { status: 'in_progress' }, 400);
    await raju.call('POST', G(`garage/job-cards/${job.id}/bill`), { requestKey: key() }, 403);
    // Another mechanic, not on the job card, does not see it.
    await suresh.call('GET', G(`garage/job-cards/${job.id}`), undefined, 404);
    await suresh.call('POST', G(`garage/job-cards/${job.id}/work`), { lines: [{ lineId: job.lines[0].id, done: false }] }, 404);
    assert.deepEqual((await suresh.call('GET', G('garage/job-cards/board'))).items, []);
    assert.deepEqual((await raju.call('GET', G('garage/job-cards/board'))).items.map((x) => [x.id, x.total]), [[job.id, null]]);
    // The database keeps the steps and the approval stamp, and deletes nothing.
    await assert.rejects(pool.query("UPDATE garage_job_cards SET status='received' WHERE id=$1", [job.id]), /cannot go from ready to received/);
    await assert.rejects(pool.query('DELETE FROM garage_job_card_events WHERE job_card_id=$1', [job.id]), /history is kept as it was written/);
    await assert.rejects(pool.query('UPDATE garage_estimate_approvals SET amount=1 WHERE job_card_id=$1', [job.id]), /kept as it was given/);
  });

  await t.test('billing: one bill posted by the core at the job card\'s prices, the advance first, stock out, the next service set', async () => {
    const before = [await stock(oil.id), await stock(filter.id), await stock(coolant.id)];
    const ready = await cashier('GET', G(`garage/job-cards/${job.id}`));
    assert.deepEqual([ready.bill.total, ready.bill.customer.total, ready.bill.insurer, ready.bill.advance, ready.bill.due, ready.bill.problem], ['3955.00', '3955.00', null, '1000.00', '2955.00', null]);
    await cashier('POST', G(`garage/job-cards/${job.id}/bill`), { requestKey: key(), payment: { amount: '3000', method: 'upi' } }, 400);
    const billKey = key();
    const billBody = { requestKey: billKey, payment: { amount: 'full', method: 'upi', reference: 'UPI-77120' }, odometerOutKm: '41603', note: 'Collected by the owner' };
    const billed = await cashier('POST', G(`garage/job-cards/${job.id}/bill`), billBody);
    assert.deepEqual([billed.status, billed.delivered_by_name, billed.insurer_document_id, billed.next_service_on, billed.next_service_km],
      ['delivered', 'garage-desk', null, addMonths(today, 6), 46603]);
    const bill = await one('SELECT * FROM business_documents WHERE business_id=$1 AND id=$2', [garage.id, billed.document_id]);
    assert.deepEqual([bill.kind, bill.total, bill.subtotal, bill.tax, bill.round_off, Number(bill.contact_id), bill.notes],
      ['sale', '3955.00', '3351.39', '603.26', '0.35', Number(lakshmi.id), `Job card ${job.job_no} · TS09EA4521 · Collected by the owner`]);
    const lines = await rows('SELECT sku_id,quantity,unit_price,net,tax,hsn_code FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [garage.id, bill.id]);
    assert.deepEqual(lines.map((l) => [Number(l.sku_id), l.quantity, l.net, l.tax]), [[oil.id, '3.500', '1334.45', '240.20'], [filter.id, '1.000', '322.03', '57.97'],
      [labour.id, '1.000', '847.46', '152.54'], [sublet.id, '1.000', '635.59', '114.41'], [coolant.id, '1.000', '211.86', '38.14']]);
    assert.deepEqual(lines.map((l) => l.unit_price), ['449.90', '380.00', '1000.00', '750.00', '250.00']);
    assert.equal(lines.reduce((s, l) => s + paise(l.net) + paise(l.tax), 0) + paise(bill.round_off), paise(bill.total));
    // The advance paid first; UPI the rest; the customer owes nothing.
    const payments = await rows('SELECT amount,method,collection_id,reference FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [garage.id, bill.id]);
    assert.deepEqual(payments.map((p) => [p.amount, p.method, p.collection_id === null ? null : Number(p.collection_id), p.reference]),
      [['2955.00', 'upi', null, 'UPI-77120'], ['1000.00', 'cash', Number(billed.advance_collection_id), billed.advance.collection_no]]);
    assert.equal(Number((await request('GET', G(`contacts?kind=customer&q=Lakshmi`))).items[0].balance), 0);
    // The parts left stock now, at the workshop; the next service and the reading out are on the vehicle.
    assert.deepEqual([await stock(oil.id), await stock(filter.id), await stock(coolant.id)], [before[0] - 3.5, before[1] - 1, before[2] - 1]);
    const car = await cashier('GET', G(`garage/vehicles/${swift.id}`));
    assert.deepEqual([car.next_service_on, car.next_service_km, car.odometer_km, car.readings[0].source], [addMonths(today, 6), 46603, 41603, 'job_out']);
    // A retry gives the same bill; the same key with other data is refused; a billed job card never changes.
    assert.equal((await cashier('POST', G(`garage/job-cards/${job.id}/bill`), billBody)).document_id, billed.document_id);
    assert.match((await refused('POST', G(`garage/job-cards/${job.id}/bill`), { ...billBody, payment: { amount: 'full', method: 'cash' } }, desk.token)).message, /already used for different data/);
    await cashier('POST', G(`garage/job-cards/${job.id}/bill`), { requestKey: key() }, 409);
    await cashier('POST', G(`garage/job-cards/${job.id}/status`), { status: 'in_progress', note: 'x' }, 409);
    await assert.rejects(pool.query("UPDATE garage_job_cards SET notes='x' WHERE id=$1", [job.id]), /is delivered and can no longer change/);
    await assert.rejects(pool.query('DELETE FROM garage_job_card_lines WHERE job_card_id=$1', [job.id]), /never change/);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND kind=$2', [garage.id, 'sale'])).n, 1);
  });

  // --- An insurance claim -----------------------------------------------------------------------------
  let claimJob, share;
  const open = (vehicle, extra = {}) => cashier('POST', G('garage/job-cards'), { requestKey: key(), locationId: shop.id, vehicleId: vehicle.id, complaints: ['Accident repair'], ...extra }, 201);
  const toReady = async (target) => {
    await cashier('POST', G(`garage/job-cards/${target.id}/approvals`), { requestKey: key(), approvedBy: 'Ravi Kumar', channel: 'in_person' }, 201);
    await cashier('POST', G(`garage/job-cards/${target.id}/status`), { status: 'in_progress' });
    return cashier('POST', G(`garage/job-cards/${target.id}/status`), { status: 'ready' });
  };

  await t.test('a cashless claim: the insurer billed exactly what it approved, the owner the rest, the two adding up to the job', async () => {
    claimJob = await open(tractor, { odometerKm: '2210', complaints: ['Rear tyre burst after an accident', 'Clutch slipping'] });
    // The claim: the insurer is a customer (with its GSTIN), not the job card's own customer.
    const claimBody = { insurerId: insurer.id, mode: 'cashless', policyNo: '3001/TRC/45512', surveyorName: 'K. Srinivas', surveyorPhone: '9000011122' };
    assert.equal((await refused('PUT', G(`garage/job-cards/${claimJob.id}/claim`), { ...claimBody, insurerId: ravi.id }, desk.token)).status, 400);
    assert.equal((await refused('PUT', G(`garage/job-cards/${claimJob.id}/claim`), { ...claimBody, insurerId: supplier.id }, desk.token)).status, 404);
    claimJob = await cashier('PUT', G(`garage/job-cards/${claimJob.id}/claim`), claimBody);
    assert.deepEqual([claimJob.claim.insurer_name, claimJob.claim.mode, claimJob.claim.policy_no, claimJob.claim.approved_amount], ['Bharat General Insurance', 'cashless', '3001/TRC/45512', null]);
    // The estimate: the insurer pays the tyre, the clutch (5%) and the labour; the wheel alignment is not covered.
    claimJob = await cashier('PUT', G(`garage/job-cards/${claimJob.id}/estimate`), { requestKey: key(), lines: [
      line('part', tyre, { payer: 'insurer' }), line('part', clutch, { payer: 'insurer' }), line('labour', labour, { unitPrice: '1770', payer: 'insurer' }), line('labour', alignment)] });
    assert.deepEqual([claimJob.total, claimJob.subtotal, claimJob.tax, claimJob.versions[0].insurer_lines], ['23270.00', '21923.73', '1346.27', '22770.00']);
    claimJob = await toReady(claimJob);
    // Not billed until the insurer's approval is known, in whole rupees, within its lines; the owner's share needs its item.
    assert.match((await refused('POST', G(`garage/job-cards/${claimJob.id}/bill`), { requestKey: key() }, desk.token)).message, /Enter the amount the insurer approved/);
    assert.match((await refused('PUT', G(`garage/job-cards/${claimJob.id}/claim`), { ...claimBody, approvedAmount: '19500.50' }, desk.token)).message, /in whole rupees/);
    assert.match((await refused('PUT', G(`garage/job-cards/${claimJob.id}/claim`), { ...claimBody, approvedAmount: '23000' }, desk.token)).message, /more than its lines on the job card \(22770\.00\)/);
    assert.match((await refused('PUT', G(`garage/job-cards/${claimJob.id}/claim`), { ...claimBody, approvedAmount: '21000', deductible: '1000', depreciation: '1000' }, desk.token)).message,
      /come to more than the insurer's lines/);
    claimJob = await cashier('PUT', G(`garage/job-cards/${claimJob.id}/claim`), { ...claimBody, claimNo: 'CLM-2026-88120', approvedAmount: '19500', deductible: '1000', depreciation: '2000' });
    assert.deepEqual([claimJob.bill.claim.owner_share, claimJob.bill.claim.not_allowed, claimJob.bill.problem], ['3270.00', '270.00', 'Choose the item that bills the owner\'s share of a claim, under Settings › Garage settings']);
    // A change that leaves the amounts out keeps them (whoever sees no money changes the rest).
    claimJob = await cashier('PUT', G(`garage/job-cards/${claimJob.id}/claim`), { ...claimBody, claimNo: 'CLM-2026-88120', surveyorPhone: '9000011133' });
    assert.deepEqual([claimJob.claim.approved_amount, claimJob.claim.deductible, claimJob.claim.depreciation, claimJob.claim.surveyor_phone], ['19500.00', '1000.00', '2000.00', '9000011133']);
    assert.match((await refused('POST', G(`garage/job-cards/${claimJob.id}/bill`), { requestKey: key() }, desk.token)).message, /Settings › Garage settings/);
    // The owner sets the claim-share item (a service at 18%, SAC 998714).
    share = await service({ name: 'Insurance claim: owner\'s share', code: 'CLM-SHARE', price: '0', hsnCode: '998714' });
    await cashier('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: share.id }, 403);
    await request('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: oil.id }, 400);
    const saved = await request('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: share.id });
    assert.deepEqual([saved.claim_share.label, saved.updated_by_name], ['Insurance claim: owner\'s share', 'garage-owner']);
    const ready = await cashier('GET', G(`garage/job-cards/${claimJob.id}`));
    assert.deepEqual([ready.bill.total, ready.bill.insurer.total, ready.bill.customer.total, ready.bill.problem], ['23270.00', '19500.00', '3770.00', null]);
    // Billed: the insurer's bill and the owner's, posted together.
    const before = [await stock(tyre.id), await stock(clutch.id)];
    const billBody = { requestKey: key(), payment: { amount: '770', method: 'cash' } };
    const billed = await cashier('POST', G(`garage/job-cards/${claimJob.id}/bill`), billBody);
    const insurerBill = await one('SELECT * FROM business_documents WHERE id=$1', [billed.insurer_document_id]);
    const ownerBill = await one('SELECT * FROM business_documents WHERE id=$1', [billed.document_id]);
    assert.deepEqual([Number(insurerBill.contact_id), insurerBill.total, insurerBill.subtotal, insurerBill.tax, insurerBill.round_off, insurerBill.buyer_gstin],
      [Number(insurer.id), '19500.00', '18412.38', '1087.62', '0.00', '36AABCB1234F1Z9']);
    assert.equal(insurerBill.notes, `Job card ${claimJob.job_no} · AP39TR7788 · claim CLM-2026-88120 (policy 3001/TRC/45512) · cashless · owner: Ravi Kumar`);
    const insurerLines = await rows('SELECT sku_id,quantity,unit_price,tax_rate,net,tax FROM business_document_lines WHERE document_id=$1 ORDER BY id', [insurerBill.id]);
    assert.deepEqual(insurerLines.map((l) => [Number(l.sku_id), l.tax_rate, l.net, l.tax, l.unit_price]), [[tyre.id, '5.00', '15415.02', '770.75', '16185.77'],
      [clutch.id, '5.00', '1712.78', '85.64', '1798.42'], [labour.id, '18.00', '1284.58', '231.23', '1515.81']]);
    assert.deepEqual([Number(ownerBill.contact_id), ownerBill.total, ownerBill.subtotal, ownerBill.tax, ownerBill.round_off], [Number(ravi.id), '3770.00', '3511.35', '258.65', '0.00']);
    assert.equal(ownerBill.notes, `Job card ${claimJob.job_no} · AP39TR7788 · owner's share of claim CLM-2026-88120: deductible ₹1000.00, depreciation ₹2000.00`);
    // The owner's share at the slabs of the insurer's lines it comes from: the tyre and the clutch at 5%, the labour at 18%.
    const ownerLines = await rows('SELECT sku_id,tax_rate,net,tax FROM business_document_lines WHERE document_id=$1 ORDER BY id', [ownerBill.id]);
    assert.deepEqual(ownerLines.map((l) => [Number(l.sku_id), l.tax_rate, l.net, l.tax]), [[alignment.id, '18.00', '423.73', '76.27'], [share.id, '5.00', '2872.20', '143.61'],
      [share.id, '18.00', '215.42', '38.77']]);
    // The two bills are the job, to the paisa; each part left stock once.
    assert.equal(paise(insurerBill.total) + paise(ownerBill.total), paise(ready.total));
    assert.deepEqual([await stock(tyre.id), await stock(clutch.id)], [before[0] - 1, before[1] - 1]);
    // The insurer owes what it approved; the owner what they did not pay now.
    const balance = async (contactId) => Number((await one(`SELECT ${'(SELECT COALESCE(sum(d.total),0) FROM business_documents d WHERE d.business_id=$1 AND d.contact_id=$2) - (SELECT COALESCE(sum(p.amount),0) FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id WHERE p.business_id=$1 AND d.contact_id=$2)'} AS b`, [garage.id, contactId])).b);
    assert.deepEqual([await balance(insurer.id), await balance(ravi.id)], [19500, 3000]);
    // A retry gives the same two bills.
    const again = await cashier('POST', G(`garage/job-cards/${claimJob.id}/bill`), billBody);
    assert.deepEqual([again.document_id, again.insurer_document_id], [billed.document_id, billed.insurer_document_id]);
    // The claim of a billed job card never changes.
    await assert.rejects(pool.query("UPDATE garage_claims SET approved_amount=1 WHERE job_card_id=$1", [claimJob.id]), /never changes/);
    claimJob = billed;
  });

  await t.test('a reimbursement claim: one bill to the owner for the whole job, naming the claim; a claim taken off makes every line the owner\'s', async () => {
    const scooter = await open(activa, { odometerKm: '12000', complaints: ['Side panel cracked'] });
    await cashier('PUT', G(`garage/job-cards/${scooter.id}/claim`), { insurerId: insurer.id, mode: 'reimbursement', policyNo: 'TW/2211/9087', claimNo: 'RB-5531', approvedAmount: '700' });
    let now = await cashier('PUT', G(`garage/job-cards/${scooter.id}/estimate`), { requestKey: key(), lines: [line('labour', labour, { unitPrice: '700', payer: 'insurer' }),
      line('labour', alignment)] });
    assert.deepEqual([now.total, now.versions[0].insurer_lines], ['1200.00', '700.00']);
    now = await toReady(now);
    assert.deepEqual([now.bill.insurer, now.bill.customer.total], [null, '1200.00']);
    const billed = await cashier('POST', G(`garage/job-cards/${scooter.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'card', reference: 'CARD-5510' } });
    const bill = await one('SELECT total,contact_id,notes FROM business_documents WHERE id=$1', [billed.document_id]);
    assert.deepEqual([billed.insurer_document_id, bill.total, Number(bill.contact_id)], [null, '1200.00', Number(ravi.id)]);
    assert.equal(bill.notes, `Job card ${scooter.job_no} · TS10EV0042 · claim RB-5531 with Bharat General Insurance (reimbursement)`);
    // A claim taken off: the insurer's lines become the owner's, in a new version.
    const third = await open(activa, { complaints: ['Mirror broken'] });
    await cashier('PUT', G(`garage/job-cards/${third.id}/claim`), { insurerId: insurer.id, mode: 'cashless', policyNo: 'TW/2211/9087' });
    await cashier('PUT', G(`garage/job-cards/${third.id}/estimate`), { requestKey: key(), lines: [line('labour', alignment, { payer: 'insurer' })] });
    await assert.rejects(pool.query('DELETE FROM garage_claims WHERE job_card_id=$1', [third.id]), /make them the customer's first/);
    const off = await cashier('DELETE', G(`garage/job-cards/${third.id}/claim`));
    assert.deepEqual([off.claim, off.lines[0].payer, off.estimate_version, off.versions[1].source], [null, 'customer', 2, 'claim']);
    await cashier('DELETE', G(`garage/job-cards/${third.id}/claim`), undefined, 404);
    await request('POST', G(`garage/job-cards/${third.id}/cancel`), { reason: 'Customer will fix it himself' });
  });

  await t.test('cancelling: the advance stays the customer\'s, handed back from the job card with a manager\'s PIN', async () => {
    const parked = await open(swift, { complaints: ['AC not cooling'], advance: { amount: '500', method: 'upi', reference: 'UPI-6612' } });
    await cashier('POST', G(`garage/job-cards/${parked.id}/advance`), { requestKey: key(), amount: '200', method: 'cash' }, 409);
    await cashier('POST', G(`garage/job-cards/${parked.id}/cancel`), { reason: 'Owner took it to the dealer' }, 403);
    assert.match((await refused('POST', G(`garage/job-cards/${parked.id}/advance-refund`), { method: 'cash', reason: 'x', approverId: ownerUser.id, pin: '1357', requestKey: key() }, desk.token)).message,
      /is still open: the advance comes off the bill/);
    const cancelled = await request('POST', G(`garage/job-cards/${parked.id}/cancel`), { reason: 'Owner took it to the dealer' });
    assert.deepEqual([cancelled.status, cancelled.cancel_reason, cancelled.advance.free, cancelled.next], ['cancelled', 'Owner took it to the dealer', '500.00', []]);
    assert.equal((await request('POST', G(`garage/job-cards/${parked.id}/cancel`), { reason: 'again' })).cancel_reason, 'Owner took it to the dealer');
    assert.equal((await request('GET', G('garage/job-cards?advance_to_refund=true'))).total, 1);
    const refundBody = { method: 'upi', reference: 'UPI-REF-31', reason: 'Job card cancelled', approverId: ownerUser.id, pin: '1357', requestKey: key() };
    const refund = await cashier('POST', G(`garage/job-cards/${parked.id}/advance-refund`), refundBody, 201);
    assert.deepEqual([refund.amount, refund.source, refund.left, refund.repeated], ['500.00', 'garage', '0.00', false]);
    assert.ok((await cashier('POST', G(`garage/job-cards/${parked.id}/advance-refund`), refundBody, 201)).repeated);
    // An advance taken later on an open job card, once.
    const later = await open(tractor, { complaints: ['Hydraulic lift weak'] });
    const taken = await cashier('POST', G(`garage/job-cards/${later.id}/advance`), { requestKey: key(), amount: '1500', method: 'upi', reference: 'UPI-9001' }, 201);
    assert.deepEqual([taken.advance.amount, taken.advance.free], ['1500.00', '1500.00']);
    await request('POST', G(`garage/job-cards/${later.id}/cancel`), { reason: 'Parts not available' });
  });

  await t.test('service due: by date, by the reading the vehicle has probably reached, and insurance and PUC running out; reminders kept', async () => {
    // A car driven 100 km a day: readings 30 and 15 days ago and today.
    const city = await cashier('POST', G('garage/vehicles'), { registrationNo: 'TS08JK3344', make: 'Hyundai', model: 'i20', owner: { contactId: ravi.id } }, 201);
    for (const [km, days] of [[10000, 30], [11500, 15]]) {
      await pool.query(`INSERT INTO garage_odometer_readings(business_id,vehicle_id,reading_km,source,recorded_by,recorded_at) VALUES($1,$2,$3,'vehicle',$4,now() - make_interval(days => $5))`,
        [garage.id, city.id, km, ownerUser.id, days]);
    }
    await cashier('POST', G(`garage/vehicles/${city.id}/odometer`), { km: '13000' }, 201);
    const driven = await cashier('PATCH', G(`garage/vehicles/${city.id}`), { nextServiceKm: '13500', nextServiceOn: daysFrom(90) });
    assert.deepEqual([Number(driven.average_km_day), driven.projected_km], [100, 13000]);
    const due = await viewer.call('GET', G('garage/service-due?limit=100'));
    const row = (vehicleId, kind) => due.items.find((x) => Number(x.vehicle_id) === Number(vehicleId) && x.kind === kind);
    assert.deepEqual([row(city.id, 'service').due_by, row(city.id, 'service').days_left, row(city.id, 'service').owner_name], [daysFrom(5), 5, 'Ravi Kumar']);
    assert.deepEqual([row(swift.id, 'insurance').due_by, row(tractor.id, 'puc').due_by, row(tractor.id, 'puc').days_left], [daysFrom(20), daysFrom(-3), -3]);
    assert.ok(!row(swift.id, 'service'), 'the Swift was serviced: its next service is months away');
    assert.ok(due.items.every((x, i, all) => i === 0 || String(all[i - 1].due_by) <= String(x.due_by)), 'the soonest due first');
    // A reminder is kept and shows as recent for that reason only. On WhatsApp,
    // by SMS or by a call it needs the owner's consent to reminders.
    await viewer.call('POST', G(`garage/vehicles/${city.id}/reminders`), { kind: 'service', channel: 'whatsapp' }, 409);
    await publishNotice(request, `/businesses/${garage.id}`);
    await giveConsent(request, `/businesses/${garage.id}`, ravi.id, ['reminders']);
    await viewer.call('POST', G(`garage/vehicles/${city.id}/reminders`), { kind: 'service', channel: 'whatsapp' }, 201);
    const reminded = await viewer.call('GET', G('garage/service-due?reminded=true'));
    assert.deepEqual(reminded.items.map((x) => [Number(x.vehicle_id), x.kind, x.reminders]), [[city.id, 'service', 1]]);
    assert.equal((await viewer.call('GET', G('garage/service-due?kind=puc'))).total, 1);
    await viewer.call('POST', G(`garage/vehicles/${city.id}/reminders`), { kind: 'tyres' }, 400);
    await assert.rejects(pool.query('DELETE FROM garage_reminders WHERE vehicle_id=$1', [city.id]), /reminder is kept/);
    // The months and kilometres to the next service are the garage's settings.
    await viewer.call('PUT', G('garage/settings'), { serviceMonths: 3, serviceKm: 3000 }, 403);
    await request('PUT', G('garage/settings'), { serviceMonths: 0, serviceKm: 3000 }, 400);
    await request('PUT', G('garage/settings'), { serviceMonths: 4, serviceKm: 300 }, 400);
    const settings = await request('PUT', G('garage/settings'), { serviceMonths: 4, serviceKm: '3,000', claimShareSkuId: share.id });
    assert.deepEqual([settings.service_months, settings.service_km], [4, 3000]);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='garage_settings.updated' ORDER BY id DESC LIMIT 1", [garage.id]);
    assert.deepEqual(audit.details, { from: { serviceMonths: 6, serviceKm: 5000 }, to: { serviceMonths: 4, serviceKm: 3000 } });
    // A job billed now takes them: 4 months and 3,000 km after it.
    const quick = await open(city, { odometerKm: '13050', complaints: ['Puncture'] });
    await cashier('PUT', G(`garage/job-cards/${quick.id}/estimate`), { requestKey: key(), lines: [line('labour', labour, { unitPrice: '150' })] });
    await cashier('POST', G(`garage/job-cards/${quick.id}/status`), { status: 'ready' });
    const done = await cashier('POST', G(`garage/job-cards/${quick.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    assert.deepEqual([done.next_service_on, done.next_service_km], [addMonths(today, 4), 16050]);
    await request('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: share.id });
  });

  await t.test('a customer\'s statement: their vehicles, the jobs on each, and what they were billed, paid and owe', async () => {
    const statement = await viewer.call('GET', G(`garage/customers/${ravi.id}/statement`));
    assert.deepEqual(statement.vehicles.map((x) => x.registration_no), ['AP39TR7788', 'TS08JK3344', 'TS10EV0042']);
    const tractorJobs = statement.vehicles.find((x) => x.registration_no === 'AP39TR7788').jobs;
    assert.deepEqual(tractorJobs.map((j) => [j.job_no, j.status, j.billed, j.insurer_document_no !== null]), [[claimJob.job_no, 'delivered', '3770.00', true]]);
    assert.deepEqual([statement.billed, statement.paid, statement.due, statement.jobs], ['5120.00', '2120.00', '3000.00', 3]);
    // Someone who does not see sales reads the statement without money; another type has none.
    const keeper = await staff('garage-keeper@test.invalid', 'stock_keeper');
    const plain = await keeper.call('GET', G(`garage/customers/${ravi.id}/statement`));
    assert.deepEqual([plain.billed, plain.vehicles[0].jobs[0].billed, plain.money], [null, null, false]);
    await request('GET', `/businesses/${grocery.id}/garage/customers/${ravi.id}/statement`, undefined, 403);
  });

  await t.test('the bell, the lists, other types and other owners', async () => {
    const late = await open(swift, { complaints: ['Clutch hard'], promisedAt: momentAt(daysFrom(1), '10:00') });
    await pool.query("UPDATE garage_job_cards SET promised_at=now() - interval '2 hours' WHERE id=$1", [late.id]);
    const bell = (await cashier('GET', G('notifications'))).items.filter((i) => i.category === 'Job cards');
    assert.ok(bell.some((i) => i.severity === 'warning' && i.title === `${late.job_no} is past its promised time` && i.link.endsWith(`/job-cards/${late.id}`)));
    const board = await cashier('GET', G('garage/job-cards/board'));
    assert.deepEqual([board.counts.received >= 1, board.counts.overdue, board.items.find((x) => x.id === late.id).overdue], [true, 1, true]);
    assert.equal((await viewer.call('GET', G('garage/job-cards?overdue=true'))).items[0].id, late.id);
    assert.equal((await viewer.call('GET', G(`garage/job-cards?q=${encodeURIComponent('ts 09 ea 4521')}&status=received`))).items[0].id, late.id);
    // Another type: the job card screens belong to garages; another owner sees nothing.
    await request('GET', `/businesses/${optical.id}/garage/job-cards/board`, undefined, 404);
    await request('GET', `/businesses/${grocery.id}/garage/job-cards`, undefined, 403);
    await other('GET', G(`garage/job-cards/${late.id}`), undefined, 404);
    await other('GET', `/businesses/${elsewhere.id}/garage/job-cards/${late.id}`, undefined, 404);
    await request('POST', G(`garage/job-cards/${late.id}/cancel`), { reason: 'Opened twice' });
    // A job card with nothing on it: its mechanic does not hand the vehicle over; the desk
    // delivers it with no bill, and the vehicle keeps the next service it had.
    const was = await cashier('GET', G(`garage/vehicles/${activa.id}`));
    const look = await open(activa, { complaints: ['Check the brakes'], mechanicIds: [raju.id] });
    await raju.call('POST', G(`garage/job-cards/${look.id}/status`), { status: 'ready', note: 'Brakes checked: nothing to change' });
    assert.match((await refused('POST', G(`garage/job-cards/${look.id}/bill`), { requestKey: key() }, raju.token)).message, /service desk/);
    const handed = await cashier('POST', G(`garage/job-cards/${look.id}/bill`), { requestKey: key() });
    assert.deepEqual([handed.status, handed.document_id, handed.insurer_document_id, handed.next_service_on, handed.next_service_km], ['delivered', null, null, null, null]);
    assert.match(handed.events.at(-1).note, /^Nothing to bill/);
    const now = await cashier('GET', G(`garage/vehicles/${activa.id}`));
    assert.deepEqual([now.next_service_on, now.next_service_km], [was.next_service_on, was.next_service_km]);
  });

  await t.test('audit and events of the job cards', async () => {
    const events = await rows("SELECT kind,count(*)::int AS n FROM business_events WHERE business_id=$1 AND entity_type='job_card' GROUP BY kind ORDER BY kind", [garage.id]);
    const count = Object.fromEntries(events.map((e) => [e.kind, e.n]));
    assert.ok(count['job_card.opened'] >= 8 && count['job_card.billed'] === 5 && count['job_card.estimate_approved'] >= 4 && count['job_card.estimate_revised'] >= 5
      && count['job_card.cancelled'] >= 3 && count['job_card.status_changed'] >= 8, JSON.stringify(count));
    const billed = await one("SELECT payload FROM business_events WHERE business_id=$1 AND kind='job_card.billed' AND entity_id=$2", [garage.id, claimJob.id]);
    assert.deepEqual([billed.payload.total, billed.payload.insurerTotal, billed.payload.customerTotal], ['23270.00', '19500.00', '3770.00']);
    const audit = await rows("SELECT action FROM business_audit WHERE business_id=$1 AND entity_id=$2 AND action LIKE 'job_card.%' ORDER BY id", [garage.id, job.id]);
    assert.deepEqual([...new Set(audit.map((a) => a.action))], ['job_card.opened', 'job_card.estimate_revised', 'job_card.status_changed', 'job_card.estimate_approved',
      'job_card.work_recorded', 'job_card.billed']);
    // The advance and the bills went through the core's own records.
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='collection.recorded' AND entity_id=$2", [garage.id, job.advance_collection_id]));
    assert.equal((await one("SELECT count(*)::int AS n FROM business_events WHERE business_id=$1 AND kind='sale.posted' AND entity_id=ANY($2::bigint[])",
      [garage.id, [claimJob.document_id, claimJob.insurer_document_id]])).n, 2);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='collection.refunded'", [garage.id]));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='vehicle.owner_changed' AND details->>'note'='Sold by Ravi'", [garage.id]));
  });
});
