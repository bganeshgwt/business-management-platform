const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom, momentAt } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A fuel station's back office: fuels under state VAT (GST nil), tanks,
// dispensing units and nozzles with their stamping dates, the price in force;
// shifts with each nozzle's opening and closing readings, the 5-litre test
// pumped back and the attendant's settlement (cash counted, UPI, cards, fleet
// cards and credit slips), posted to the core as fuel sales exact to the
// paisa; a closed shift reopened only by a manager with a reason; the morning
// dips, tanker receipts with the density check posted as purchases, the daily
// stock register against the MDG tolerance and the density register; fleet
// vehicles with their fill limits and the customer's statement. Money adds up
// to the paisa, postings are idempotent, the database keeps its rules, audit
// and events are written, and other types and other owners are kept out.
// Runs on its own throwaway database with every migration applied.
test('fuel stations', { timeout: 300000 }, async (t) => {
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
  const password = `Fuel-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('fuel-owner');
  await owner('fuel-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('fuel-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('fuel-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);

  const [fuel, grocery, rentals] = await createBusinesses(request, 'OWNER', ['fuel_station', 'grocery', 'rentals']);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['fuel_station']);
  const F = (suffix) => `/businesses/${fuel.id}/${suffix}`;

  await t.test('modules, permissions and roles per type', async () => {
    assert.ok(fuel.capabilities.includes('fuel'), 'a fuel station starts with tanks, nozzles & shifts');
    for (const business of [grocery, rentals]) assert.ok(!business.capabilities.includes('fuel'), `${business.business_type} has no fuel tools`);
    const tools = await request('GET', F('modules'));
    const module = tools.find((m) => m.code === 'fuel');
    assert.equal(module.name, 'Tanks, nozzles & shifts');
    assert.deepEqual([...module.requires].sort(), ['catalog', 'contacts', 'inventory', 'purchasing', 'sales']);
    const licences = tools.find((m) => m.code === 'licences');
    assert.deepEqual([licences.enabled, licences.recommended], [false, true]);
    assert.match(licences.recommended_note, /PESO licence \(Form XIV\)/);
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'fuel'), 'a grocery is not offered the fuel tools');
    await request('PUT', `/businesses/${grocery.id}/modules/fuel`, { enabled: true }, 409);
    await request('PUT', F('modules/inventory'), { enabled: false }, 409);
    const permissions = await rows("SELECT code FROM business_permissions WHERE module_code='fuel' ORDER BY sort_order");
    assert.deepEqual(permissions.map((p) => p.code), ['fuel.view', 'fuel.create', 'fuel.edit', 'fuel.approve', 'fuel.export', 'fuel.print']);
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2`, [business.id, template])).p;
    const fuelGrants = async (business, template) => (await grants(business, template)).filter((p) => p.startsWith('fuel.'));
    assert.deepEqual(await fuelGrants(fuel, 'manager'), ['fuel.approve', 'fuel.create', 'fuel.edit', 'fuel.export', 'fuel.print', 'fuel.view']);
    assert.deepEqual(await fuelGrants(fuel, 'cashier'), ['fuel.create', 'fuel.edit', 'fuel.print', 'fuel.view']);
    assert.deepEqual(await fuelGrants(fuel, 'stock_keeper'), ['fuel.create', 'fuel.print', 'fuel.view']);
    assert.deepEqual(await fuelGrants(fuel, 'accountant'), ['fuel.export', 'fuel.print', 'fuel.view']);
    assert.deepEqual(await fuelGrants(fuel, 'viewer'), ['fuel.view']);
    assert.deepEqual(await fuelGrants(grocery, 'viewer'), ['fuel.view'], 'role copies match their templates everywhere');
    // The pump attendant: their own shift's readings and takings, and the dips; nothing else.
    assert.deepEqual(await grants(fuel, 'pump_attendant'), ['fuel.create', 'fuel.view']);
    const roleCodes = (await request('GET', F('roles?limit=100'))).items.map((r) => r.template_code);
    assert.ok(roleCodes.includes('pump_attendant') && roleCodes.length === 7, 'the six shared roles and the pump attendant');
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/roles?limit=100`)).items.some((r) => r.template_code === 'pump_attendant'), 'a grocery has no pump attendant');
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'")).d.includes("'fuel_shift'"));
    assert.notEqual(String(elsewhere.id), String(fuel.id));
  });

  // --- The database's own rules, on a business of their own -------------------------------------
  await t.test('the database keeps fuels, tanks, nozzles, prices, shifts, dips and receipts within their rules', async () => {
    const [rules] = await createBusinesses(request, 'RULES', ['fuel_station']);
    const R = (suffix) => `/businesses/${rules.id}/${suffix}`;
    const loc = (await request('GET', R('locations'))).items[0];
    const slabs = (await request('GET', R('tax-rates'))).items;
    const nil = slabs.find((r) => Number(r.rate) === 0), gst18 = slabs.find((r) => Number(r.rate) === 18);
    const item = (name, unit, slab, extra = {}) => request('POST', R('catalog'), { kind: 'goods', tracking: 'quantity', unit, name, code: name.toUpperCase().replace(/\W+/g, '-'),
      price: '0', taxRateId: slab.id, ...extra }, 201);
    const petrolSku = await item('Rule petrol', 'litre', nil);
    const dieselSku = await item('Rule diesel', 'litre', nil);
    const cngSku = await item('Rule CNG', 'kg', nil);
    const lubeSku = await item('Rule engine oil', 'litre', gst18);
    const pieceSku = await item('Rule petrol can', 'each', nil);
    const serviceSku = await request('POST', R('catalog'), { kind: 'service', unit: 'service', name: 'Rule air filling', code: 'RULE-AIR', price: '0', taxRateId: nil.id }, 201);
    const roles = (await request('GET', R('roles?limit=100'))).items;
    const attendant = await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,'Ravi Attendant','rule-ravi@test.invalid',$2) RETURNING id", [ownerUser.restaurant_id, hash]);
    await request('POST', R('members'), { userId: attendant.id, roleId: roles.find((r) => r.template_code === 'pump_attendant').id }, 201);
    const outsider = await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,'Not Staff','rule-out@test.invalid',$2) RETURNING id", [ownerUser.restaurant_id, hash]);
    const customer = await request('POST', R('contacts'), { kind: 'customer', name: 'Rule Transports' }, 201);
    const supplier = await request('POST', R('contacts'), { kind: 'supplier', name: 'Rule Terminal' }, 201);
    const hashText = 'x'.repeat(64);
    // A transaction on its own client: deferred checks run when it commits.
    const tx = async (work) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await work(c); await c.query('COMMIT'); return r; }
      catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
    };
    const ins = (sql, values) => pool.query(sql, values);

    // Fuels: goods items kept by quantity, counted in litres (CNG in kilos), on the GST nil slab; never deleted.
    const fuelOf = async (sku, family) => one('INSERT INTO fuel_products(business_id,sku_id,family,created_by) VALUES($1,$2,$3,$4) RETURNING *', [rules.id, sku.id, family, ownerUser.id]);
    const addFuel = (sku, family) => ins('INSERT INTO fuel_products(business_id,sku_id,family,created_by) VALUES($1,$2,$3,$4)', [rules.id, sku.id, family, ownerUser.id]);
    await assert.rejects(addFuel(lubeSku, 'petrol'), /outside GST/);
    await assert.rejects(addFuel(pieceSku, 'petrol'), /sold by the litre and CNG by the kilo/);
    await assert.rejects(addFuel(serviceSku, 'diesel'), /goods item of this business kept in stock by quantity/);
    await assert.rejects(addFuel(dieselSku, 'cng'), /CNG by the kilo/);
    const petrol = await fuelOf(petrolSku, 'petrol');
    const diesel = await fuelOf(dieselSku, 'diesel');
    const cng = await fuelOf(cngSku, 'cng');
    await assert.rejects(addFuel(petrolSku, 'petrol'), /unique|duplicate/);
    await assert.rejects(ins("UPDATE fuel_products SET family='diesel' WHERE id=$1", [petrol.id]), /keeps the item it is sold as/);
    await assert.rejects(ins('DELETE FROM fuel_products WHERE id=$1', [petrol.id]), /never deleted/);
    await assert.rejects(ins('UPDATE catalog_skus SET tax_rate=18,tax_rate_id=$2 WHERE id=$1', [petrolSku.id, gst18.id]), /stays on the GST nil slab/);
    await ins("UPDATE catalog_skus SET label='Rule petrol (MS)' WHERE id=$1", [petrolSku.id]);

    // Tanks hold petrol or diesel; units and nozzles; a nozzle draws its tank's fuel, CNG from no tank.
    const tankOf = (product, no, capacity = 15000) => one('INSERT INTO fuel_tanks(business_id,location_id,product_id,tank_no,capacity,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [rules.id, loc.id, product.id, no, capacity, ownerUser.id]);
    await assert.rejects(tankOf(cng, 'C1', 1000), /CNG is kept in no tank/);
    const t1 = await tankOf(petrol, 'T1');
    const t2 = await tankOf(diesel, 'T2', 20000);
    await assert.rejects(tankOf(petrol, 't1', 100), /unique|duplicate/);
    await assert.rejects(ins('UPDATE fuel_tanks SET product_id=$2 WHERE id=$1', [t1.id, diesel.id]), /keeps its outlet and the fuel it holds/);
    await assert.rejects(ins('DELETE FROM fuel_tanks WHERE id=$1', [t1.id]), /never deleted/);
    const unitOf = (no, due) => one(`INSERT INTO fuel_dispensers(business_id,location_id,unit_no,stamping_due,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`, [rules.id, loc.id, no, due, ownerUser.id]);
    const du1 = await unitOf('DU 1', addDays(today, 200));
    const du2 = await unitOf('DU 2', addDays(today, 20));
    await assert.rejects(ins("UPDATE fuel_dispensers SET status='suspended' WHERE id=$1", [du2.id]), /check/);
    const nozzleOf = (unit, no, product, tank, reading) => one(`INSERT INTO fuel_nozzles(business_id,location_id,dispenser_id,nozzle_no,product_id,tank_id,reading,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [rules.id, loc.id, unit.id, no, product.id, tank ? tank.id : null, reading, ownerUser.id]);
    await assert.rejects(nozzleOf(du1, '9', petrol, null, 0), /draws from a tank/);
    await assert.rejects(nozzleOf(du1, '9', cng, t1, 0), /draws from a tank/);
    await assert.rejects(nozzleOf(du1, '9', petrol, t2, 0), /draws the fuel of tank T2/);
    const n1 = await nozzleOf(du1, '1', petrol, t1, '100000.000');
    const n2 = await nozzleOf(du1, '2', diesel, t2, '250000.500');
    const n3 = await nozzleOf(du2, '3', cng, null, '5000.000');
    await assert.rejects(nozzleOf(du2, '1', petrol, t1, 0), /unique|duplicate/);
    await assert.rejects(ins('UPDATE fuel_nozzles SET reading=reading+10 WHERE id=$1', [n1.id]), /moves only with a shift's close or a meter change a manager records/);
    await assert.rejects(ins('UPDATE fuel_nozzles SET tank_id=NULL WHERE id=$1', [n2.id]), /keeps its unit, its fuel and its tank/);
    await assert.rejects(ins('DELETE FROM fuel_nozzles WHERE id=$1', [n1.id]), /never deleted/);
    // A meter change starts from the reading now, and the nozzle's reading follows it in the same moment.
    await assert.rejects(ins("INSERT INTO fuel_meter_changes(business_id,nozzle_id,from_reading,to_reading,reason,created_by) VALUES($1,$2,1,2,'x',$3)", [rules.id, n3.id, ownerUser.id]),
      /reads 5000\.000 now: a meter change starts from there/);
    await tx(async (c) => {
      await c.query("INSERT INTO fuel_meter_changes(business_id,nozzle_id,from_reading,to_reading,reason,created_by) VALUES($1,$2,5000,0,'Totaliser replaced',$3)", [rules.id, n3.id, ownerUser.id]);
      await c.query('UPDATE fuel_nozzles SET reading=0 WHERE id=$1', [n3.id]);
    });
    await assert.rejects(ins("UPDATE fuel_meter_changes SET reason='other' WHERE nozzle_id=$1", [n3.id]), /kept as it was recorded/);

    // Prices: set, never changed; within a week back.
    const priceOf = (product, value, at) => ins(`INSERT INTO fuel_prices(business_id,location_id,product_id,price,effective_from,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,${at},$5,$6,$7)`, [rules.id, loc.id, product.id, value, key(), hashText, ownerUser.id]);
    await priceOf(petrol, '102.12', "now()-interval '2 hours'");
    await priceOf(diesel, '95.20', "now()-interval '2 hours'");
    await priceOf(cng, '88.00', "now()-interval '2 hours'");
    await assert.rejects(priceOf(petrol, '100', "now()-interval '8 days'"), /within a week back and a month ahead/);
    await assert.rejects(ins('UPDATE fuel_prices SET price=1 WHERE product_id=$1', [petrol.id]), /kept as it was set/);
    assert.equal((await one('SELECT fuel_price_at($1,$2,$3,now()) AS p', [rules.id, loc.id, petrol.id])).p, '102.12');

    // Vehicles: a customer's, one active plate at a time, keeping its customer and plate.
    const vehicleOf = (contact, plate) => ins("INSERT INTO fuel_vehicles(business_id,contact_id,registration,product_id,fill_limit,created_by) VALUES($1,$2,$3,$4,300,$5)",
      [rules.id, contact.id, plate, diesel.id, ownerUser.id]);
    await assert.rejects(vehicleOf(supplier, 'TS09UB4455'), /Choose a customer/);
    await vehicleOf(customer, 'TS09UB4455');
    await assert.rejects(vehicleOf(customer, 'TS09UB4455'), /unique|duplicate/);
    await assert.rejects(ins("UPDATE fuel_vehicles SET registration='TS09UB0001' WHERE registration='TS09UB4455' AND business_id=$1", [rules.id]), /keeps its customer and its registration/);

    // Shifts: for a member of the staff, from readings of the last day, one open at a time per attendant.
    const shiftOf = (person, name, at = "now()-interval '1 hour'", locationId = loc.id) => one(`INSERT INTO fuel_shifts(business_id,location_id,shift_no,attendant_id,attendant_name,opened_at,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,${at},$6,$7,$8) RETURNING *`, [rules.id, locationId, `RULE-${crypto.randomBytes(3).toString('hex')}`, person.id, name, key(), hashText, ownerUser.id]);
    await assert.rejects(shiftOf(outsider, 'Not Staff', 'now()'), /does not work in this business/);
    await assert.rejects(shiftOf(attendant, 'Ravi', "now()-interval '2 days'"), /within the last 24 hours/);
    const s1 = await shiftOf(attendant, 'Ravi Attendant');
    await assert.rejects(shiftOf(attendant, 'Ravi', 'now()'), /unique|duplicate/);
    const take = (s, n, opening) => ins('INSERT INTO fuel_shift_nozzles(business_id,shift_id,nozzle_id,nozzle_no,product_id,tank_id,opening,added_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [rules.id, s.id, n.id, n.nozzle_no, n.product_id, n.tank_id, opening, ownerUser.id]);
    await assert.rejects(take(s1, n1, '99999'), /reads 100000\.000 on its totaliser: a shift takes it from there/);
    await take(s1, n1, '100000.000');
    await take(s1, n2, '250000.500');
    const s2 = await shiftOf(ownerUser, 'Rule Owner');
    await assert.rejects(take(s2, n1, '100000.000'), /is on shift RULE-\w+ \(Ravi Attendant\), still open/);
    await assert.rejects(ins("UPDATE fuel_dispensers SET status='suspended',status_note='Seal broken' WHERE id=$1", [du1.id]), /is open on nozzle 1 of DU 1: close it/);
    await assert.rejects(ins("INSERT INTO fuel_meter_changes(business_id,nozzle_id,from_reading,to_reading,reason,created_by) VALUES($1,$2,100000,0,'x',$3)", [rules.id, n1.id, ownerUser.id]),
      /close it before the meter changes/);
    await assert.rejects(ins('UPDATE fuel_shifts SET attendant_id=$2 WHERE id=$1', [s1.id, ownerUser.id]), /keeps its number, outlet, attendant and opening/);
    await assert.rejects(ins("UPDATE fuel_shifts SET status='closed' WHERE id=$1", [s1.id]), /closes with its closing readings and takings/);
    // A close adds up when the work is saved: every nozzle read, each fuel's litres its nozzles', at the price in force.
    const closeOf = async (c, s, seq = 1, at = 'now()') => (await c.query(`INSERT INTO fuel_shift_closes(business_id,shift_id,seq,closed_at,expected,credit,walk_in,cash,other,difference,walk_in_key,request_key,request_hash,closed_by)
      VALUES($1,$2,$3,${at},0,0,0,0,0,0,$4,$5,$6,$7) RETURNING *`, [rules.id, s.id, seq, key(), key(), hashText, ownerUser.id])).rows[0];
    const readOut = (c, fc, s, n, opening, closing, test = 0) => c.query(`INSERT INTO fuel_close_readings(business_id,close_id,shift_id,nozzle_id,product_id,tank_id,opening,closing,test,litres)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8::numeric-$7::numeric-$9::numeric)`, [rules.id, fc.id, s.id, n.id, n.product_id, n.tank_id, opening, closing, test]);
    const sold = (c, fc, s, product, priceValue) => c.query(`INSERT INTO fuel_close_products(business_id,close_id,shift_id,product_id,price,litres,credit_litres,walk_in_litres,credit_amount,walk_in_amount,amount)
      VALUES($1,$2,$3,$4,$5,0,0,0,0,0,0)`, [rules.id, fc.id, s.id, product.id, priceValue]);
    const nothingSold = async (c, fc, petrolPrice = '102.12') => {
      await readOut(c, fc, s1, n1, '100000.000', '100000.000');
      await readOut(c, fc, s1, n2, '250000.500', '250000.500');
      await sold(c, fc, s1, petrol, petrolPrice);
      await sold(c, fc, s1, diesel, '95.20');
    };
    await assert.rejects(tx(async (c) => {
      const fc = await closeOf(c, s1);
      await readOut(c, fc, s1, n1, '100000.000', '100000.000');
      await sold(c, fc, s1, petrol, '102.12');
    }), /closes with a closing reading for nozzle 2/);
    await assert.rejects(tx(async (c) => nothingSold(c, await closeOf(c, s1), '100.00')), /sells Rule petrol \(MS\) at the price in force when it opened/);
    await assert.rejects(tx(async (c) => {
      const fc = await closeOf(c, s1);
      await readOut(c, fc, s1, n1, '100000.000', '100010.000');
      await readOut(c, fc, s1, n2, '250000.500', '250000.500');
      await sold(c, fc, s1, petrol, '102.12');
      await sold(c, fc, s1, diesel, '95.20');
    }), /sales are its nozzles' litres/);
    await assert.rejects(tx(async (c) => readOut(c, await closeOf(c, s1), s1, n1, '100000.000', '100010.000', '5').then(() => c.query(
      'UPDATE fuel_close_readings SET litres=10 WHERE business_id=$1', [rules.id]))), /kept as they were closed/);
    await assert.rejects(tx(async (c) => c.query(`INSERT INTO fuel_close_readings(business_id,close_id,shift_id,nozzle_id,product_id,tank_id,opening,closing,test,litres)
      VALUES($1,$2,$3,$4,$5,$6,100000,100010,5,10)`, [rules.id, (await closeOf(c, s1)).id, s1.id, n1.id, petrol.id, t1.id])), /check constraint/);
    await assert.rejects(tx(async (c) => c.query(`INSERT INTO fuel_close_readings(business_id,close_id,shift_id,nozzle_id,product_id,tank_id,opening,closing,test,litres)
      VALUES($1,$2,$3,$4,$5,NULL,0,1,0,1)`, [rules.id, (await closeOf(c, s1)).id, s1.id, n3.id, cng.id])), /foreign key/);
    // Closed (nothing sold); a closed shift and its close no longer change.
    const firstClose = await tx(async (c) => {
      const fc = await closeOf(c, s1);
      await nothingSold(c, fc);
      await c.query("UPDATE fuel_shifts SET status='closed' WHERE id=$1", [s1.id]);
      return fc;
    });
    await assert.rejects(ins("UPDATE fuel_shifts SET notes='x' WHERE id=$1", [s1.id]), /is closed and no longer changes/);
    await assert.rejects(ins('UPDATE fuel_shift_closes SET cash=10,difference=10 WHERE id=$1', [firstClose.id]), /keeps the readings, sales and takings it closed with/);
    await assert.rejects(ins('DELETE FROM fuel_shift_closes WHERE id=$1', [firstClose.id]), /never deleted/);
    await assert.rejects(ins("UPDATE fuel_shifts SET status='open' WHERE id=$1", [s1.id]), /a manager reopens it, saying why/);
    // A price never takes effect back into a closed shift.
    await assert.rejects(priceOf(petrol, '101', "now()-interval '30 minutes'"), /sold Rule petrol \(MS\) at its price until .+: a new price takes effect from then or later/);
    // Reopened by a manager (once, with a reason), the shift is open again.
    await tx(async (c) => {
      await c.query("UPDATE fuel_shift_closes SET reopened_at=now(),reopened_by=$2,reopen_reason='Diesel closing typed wrong',reopen_key=$3,reopen_hash=$4 WHERE id=$1",
        [firstClose.id, ownerUser.id, key(), hashText]);
      await c.query("UPDATE fuel_shifts SET status='open' WHERE id=$1", [s1.id]);
    });
    await assert.rejects(ins("UPDATE fuel_shift_closes SET reopen_reason='again' WHERE id=$1", [firstClose.id]), /was reopened and no longer changes/);
    // A price that took effect while the shift was open: refused unless it closes at the change.
    await priceOf(petrol, '103.00', "now()-interval '10 minutes'");
    await assert.rejects(tx(async (c) => {
      await nothingSold(c, await closeOf(c, s1, 2));
      await c.query("UPDATE fuel_shifts SET status='closed' WHERE id=$1", [s1.id]);
    }), /The price of Rule petrol \(MS\) changed at .+, while shift RULE-\w+ was open: close it with the readings taken then/);
    await tx(async (c) => {
      await nothingSold(c, await closeOf(c, s1, 2, `(SELECT effective_from FROM fuel_prices WHERE business_id=${Number(rules.id)} AND price=103)`));
      await c.query("UPDATE fuel_shifts SET status='closed' WHERE id=$1", [s1.id]);
    });
    // The next shift on its nozzles: the shift is no longer reopened; a shift never opens before the last one closed.
    const s3 = await shiftOf(attendant, 'Ravi Attendant', 'now()');
    await take(s3, n1, '100000.000');
    await assert.rejects(take(s2, n2, '250000.500'), /opens at .+, before shift RULE-\w+ closed on nozzle 2/);
    await assert.rejects(tx(async (c) => {
      const fc = (await c.query('SELECT id FROM fuel_shift_closes WHERE shift_id=$1 AND reopened_at IS NULL', [s1.id])).rows[0];
      await c.query("UPDATE fuel_shift_closes SET reopened_at=now(),reopened_by=$2,reopen_reason='late',reopen_key=$3,reopen_hash=$4 WHERE id=$1", [fc.id, ownerUser.id, key(), hashText]);
      await c.query("UPDATE fuel_shifts SET status='open' WHERE id=$1", [s1.id]);
    }), /opened on nozzle 1 after shift .+ closed: a shift is reopened only before the next one starts/);
    // A nozzle comes off an open shift before any close of it; one closed on a shift stays.
    await ins('DELETE FROM fuel_shift_nozzles WHERE shift_id=$1 AND nozzle_id=$2', [s3.id, n1.id]);
    await assert.rejects(ins('DELETE FROM fuel_shift_nozzles WHERE shift_id=$1 AND nozzle_id=$2', [s1.id, n1.id]), /stays on shift/);

    // The cash limit: still one bill to one person at the counter; a shift's walk-in fuel bill is many buyers' fills.
    const loc2 = await request('POST', R('locations'), { name: 'Rule highway outlet', code: 'RHWY' }, 201);
    const docOf = async (c, requestKey, locationId) => (await c.query(`INSERT INTO business_documents(business_id,location_id,kind,document_no,subtotal,tax,round_off,total,tax_mode,request_key,request_hash,created_by)
      VALUES($1,$2,'sale',$3,250000,0,0,250000,'inclusive',$4,$5,$6) RETURNING *`, [rules.id, locationId, `RULE-SI-${crypto.randomBytes(3).toString('hex')}`, requestKey, hashText, ownerUser.id])).rows[0];
    const cashOf = (c, d) => c.query("INSERT INTO business_payments(business_id,document_id,amount,method,request_key,created_by) VALUES($1,$2,250000,'cash',$3,$4)", [rules.id, d.id, key(), ownerUser.id]);
    await assert.rejects(tx(async (c) => cashOf(c, await docOf(c, key(), loc.id))), /Cash of ₹2,00,000 or more cannot be taken for one bill/);
    const exempt = await pool.connect();
    try {
      await exempt.query('BEGIN');
      const walkKey = key();
      const s4 = (await exempt.query(`INSERT INTO fuel_shifts(business_id,location_id,shift_no,attendant_id,attendant_name,opened_at,request_key,request_hash,created_by)
        VALUES($1,$2,'RULE-CASH',$3,'Rule Owner',now(),$4,$5,$3) RETURNING *`, [rules.id, loc2.id, ownerUser.id, key(), hashText])).rows[0];
      await exempt.query(`INSERT INTO fuel_shift_closes(business_id,shift_id,seq,closed_at,expected,credit,walk_in,cash,other,difference,walk_in_key,request_key,request_hash,closed_by)
        VALUES($1,$2,1,now(),0,0,0,0,0,0,$3,$4,$5,$6)`, [rules.id, s4.id, walkKey, key(), hashText, ownerUser.id]);
      await cashOf(exempt, await docOf(exempt, walkKey, loc2.id));
    } finally { await exempt.query('ROLLBACK'); exempt.release(); }

    // Dips: one a day for each tank, on its day by the business's clock, within a week, no more than the tank holds; corrected only by a manager.
    const dipOf = (tank, stock, on = `(now() AT TIME ZONE 'Asia/Kolkata')::date`, at = 'now()') => one(`INSERT INTO fuel_dips(business_id,location_id,tank_id,dip_on,taken_at,stock,request_key,request_hash,created_by)
      VALUES($1,$2,$3,${on},${at},$4,$5,$6,$7) RETURNING *`, [rules.id, loc.id, tank.id, stock, key(), hashText, ownerUser.id]);
    await assert.rejects(dipOf(t1, '15000.5'), /holds at most 15000\.000 litres/);
    await assert.rejects(dipOf(t1, '100', `(now() AT TIME ZONE 'Asia/Kolkata')::date-1`), /taken on that day by the business's clock/);
    await assert.rejects(dipOf(t1, '100', `(now() AT TIME ZONE 'Asia/Kolkata')::date-8`, "now()-interval '8 days'"), /within a week of its day/);
    const d1 = await dipOf(t1, '9000');
    await assert.rejects(dipOf(t1, '100'), /unique|duplicate/);
    await assert.rejects(ins('UPDATE fuel_dips SET stock=8000 WHERE id=$1', [d1.id]), /changes only as a manager's correction, saying why/);
    await ins("UPDATE fuel_dips SET stock=8950,corrected_at=now(),corrected_by=$2,correction_reason='Read off the wrong line of the chart' WHERE id=$1", [d1.id, ownerUser.id]);
    await assert.rejects(ins('DELETE FROM fuel_dips WHERE id=$1', [d1.id]), /never deleted/);
    await assert.rejects(ins('UPDATE fuel_tanks SET capacity=8000 WHERE id=$1', [t1.id]), /held 8950\.000 litres at its dip of/);

    // Tanker receipts: from a supplier, written with their lines; a refused load is not bought and no longer changes.
    const receiptOf = (c, contact, status) => c.query(`INSERT INTO fuel_receipts(business_id,location_id,contact_id,supplier_name,invoice_no,invoice_date,lorry_no,received_at,status,refuse_reason,request_key,request_hash,created_by)
      VALUES($1,$2,$3,'Rule Terminal',$4,current_date,'TS07UA1234',now(),$5,$6,$7,$8,$9) RETURNING *`,
    [rules.id, loc.id, contact.id, `INV-${crypto.randomBytes(3).toString('hex')}`, status, status === 'refused' ? 'Density 6.5 kg/m³ off the invoice' : null, key(), hashText, ownerUser.id]);
    const lineOf = (c, receipt, tank, product, seq = 1) => c.query(`INSERT INTO fuel_receipt_lines(business_id,receipt_id,seq,tank_id,product_id,invoice_litres,invoice_amount,invoice_density,receipt_density,tolerance)
      VALUES($1,$2,$3,$4,$5,12000,1100000,745.0,751.5,3.0)`, [rules.id, receipt.id, seq, tank.id, product.id]);
    const load = await tx(async (c) => {
      const r = (await receiptOf(c, supplier, 'refused')).rows[0];
      await lineOf(c, r, t1, petrol);
      return r;
    });
    await assert.rejects(tx(async (c) => receiptOf(c, customer, 'refused')), /Choose a supplier/);
    await assert.rejects(tx(async (c) => receiptOf(c, supplier, 'accepted')), /check/);
    await assert.rejects(lineOf(pool, load, t2, diesel, 2), /lines are written with it/);
    await assert.rejects(tx(async (c) => lineOf(c, (await receiptOf(c, supplier, 'refused')).rows[0], t2, petrol)), /not a tank in use at the outlet for that fuel/);
    await assert.rejects(ins("UPDATE fuel_receipts SET notes='x' WHERE id=$1", [load.id]), /is refused and no longer changes/);
    await assert.rejects(ins('UPDATE fuel_receipt_lines SET decant_density=746,decant_by=$2,decant_at=now() WHERE receipt_id=$1', [load.id, ownerUser.id]),
      /density after decanting is written once/);
    await assert.rejects(ins('DELETE FROM fuel_receipt_lines WHERE receipt_id=$1', [load.id]), /never deleted/);
    await assert.rejects(ins('DELETE FROM fuel_receipts WHERE id=$1', [load.id]), /never deleted/);
    // Another owner's fuel station is a business of its own.
    assert.equal((await one('SELECT count(*)::int AS n FROM fuel_shifts WHERE business_id=$1', [elsewhere.id])).n, 0);
  });

  // --- Staff, the outlet and its people -------------------------------------------------------------
  const outlet = (await request('GET', F('locations'))).items[0];
  const roles = (await request('GET', F('roles?limit=100'))).items;
  async function staff(email, name, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,name', [ownerUser.restaurant_id, name, email, hash]);
    await request('POST', F('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, name, call: as(token), token };
  }
  const ravi = await staff('fuel-ravi@test.invalid', 'Ravi Kumar', 'pump_attendant');
  const suresh = await staff('fuel-suresh@test.invalid', 'Suresh Babu', 'pump_attendant');
  const cashier = await staff('fuel-cashier@test.invalid', 'Lakshmi Cashier', 'cashier');
  const viewer = await staff('fuel-viewer@test.invalid', 'Viewer Rao', 'viewer');
  // Typed times are read to the minute: these are whole minutes on the clock.
  const ago = (minutes) => new Date(Math.floor(Date.now() / 60000) * 60000 - minutes * 60000).toISOString();
  let petrol, diesel, cng, t1, t2, du1, du2, n1, n2, n3, n4, transports, truck, tempo, fleetCard, shift1, terminal;
  const stockOf = async (product, locationId = outlet.id) => (await one(`SELECT COALESCE(sum(l.quantity),0) AS q FROM business_stock_lots l JOIN fuel_products f ON f.business_id=l.business_id AND f.sku_id=l.sku_id
    WHERE l.business_id=$1 AND f.id=$2 AND l.location_id=$3`, [fuel.id, product.id, locationId])).q;

  await t.test('the forecourt: fuels on the GST nil slab, tanks with their stock, units and nozzles, measures, prices and the tolerances', async () => {
    // Fuels: goods items in litres (CNG in kilos) on the GST nil slab, priced by the fuel prices.
    let setupNow = await request('POST', F('fuel/products'), { item: { name: 'Petrol' }, family: 'petrol' }, 201);
    setupNow = await request('POST', F('fuel/products'), { item: { name: 'Diesel' }, family: 'diesel', sortOrder: '2' }, 201);
    setupNow = await request('POST', F('fuel/products'), { item: { name: 'CNG' }, family: 'cng', sortOrder: '3' }, 201);
    [petrol, diesel, cng] = ['Petrol', 'Diesel', 'CNG'].map((name) => setupNow.products.find((p) => p.name === name));
    assert.deepEqual([petrol.unit, petrol.tax_rate, petrol.family, cng.unit], ['litre', '0.00', 'petrol', 'kg']);
    const sku = await one('SELECT s.price,s.tracking,p.kind FROM catalog_skus s JOIN catalog_products p ON p.id=s.product_id WHERE s.id=$1', [petrol.sku_id]);
    assert.deepEqual([sku.price, sku.tracking, sku.kind], ['0.00', 'quantity', 'goods'], 'priced by the fuel prices, kept in stock by quantity');
    const gst18 = (await request('GET', F('tax-rates'))).items.find((r) => Number(r.rate) === 18);
    const lube = await request('POST', F('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'litre', name: 'Engine oil 20W-40', code: 'LUBE-1', price: '450', taxRateId: gst18.id }, 201);
    assert.match((await refused('POST', F('fuel/products'), { skuId: lube.id, family: 'petrol' })).message, /outside GST/);
    assert.equal((await refused('POST', F('fuel/products'), { item: { name: 'Speed' }, family: 'petrol' }, cashier.token)).status, 403);
    assert.match((await refused('PATCH', F(`catalog/${petrol.sku_id}`), { label: 'Petrol', price: '0', taxRateId: gst18.id })).message, /stays on the GST nil slab/);
    // Tanks with the stock in them now, brought into stock as a correction.
    setupNow = await request('POST', F('fuel/tanks'), { locationId: outlet.id, productId: petrol.id, tankNo: 'T1', capacity: '15000', stockNow: { litres: '9000', unitCost: '94.1000' } }, 201);
    setupNow = await request('POST', F('fuel/tanks'), { locationId: outlet.id, productId: diesel.id, tankNo: 'T2', capacity: '20000', stockNow: { litres: '12000' } }, 201);
    [t1, t2] = ['T1', 'T2'].map((no) => setupNow.tanks.find((x) => x.tank_no === no));
    assert.deepEqual([await stockOf(petrol), await stockOf(diesel)], ['9000.000', '12000.000']);
    assert.ok(await one("SELECT 1 FROM business_stock_adjustments WHERE business_id=$1 AND reason='Opening stock in tank T1'", [fuel.id]));
    assert.match((await refused('POST', F('fuel/tanks'), { locationId: outlet.id, productId: cng.id, tankNo: 'C1', capacity: '100' })).message, /CNG is kept in no tank/);
    assert.equal((await refused('POST', F('fuel/tanks'), { locationId: outlet.id, productId: petrol.id, tankNo: 't1', capacity: '100' })).status, 409);
    // Dispensing units with their stamping, and nozzles drawing their tanks' fuel (CNG from none).
    setupNow = await request('POST', F('fuel/dispensers'), { locationId: outlet.id, unitNo: 'DU 1', make: 'Tokheim', serialNo: 'TK-55120', stampedOn: addDays(today, -165),
      stampingDue: addDays(today, 200), nozzles: [{ nozzleNo: '1', tankId: t1.id, reading: '100000' }, { nozzleNo: '2', tankId: t2.id, reading: '250000.5' },
        { nozzleNo: '4', tankId: t2.id, reading: '70000' }] }, 201);
    setupNow = await request('POST', F('fuel/dispensers'), { locationId: outlet.id, unitNo: 'DU 2', stampingDue: addDays(today, 20), nozzles: [{ nozzleNo: '3', productId: cng.id, reading: '5000' }] }, 201);
    [du1, du2] = ['DU 1', 'DU 2'].map((no) => setupNow.dispensers.find((d) => d.unit_no === no));
    [n1, n2, n4] = ['1', '2', '4'].map((no) => du1.nozzles.find((n) => n.nozzle_no === no));
    n3 = du2.nozzles[0];
    assert.deepEqual([n1.reading, n2.reading, n3.reading, n3.tank_id, n2.product_name], ['100000.000', '250000.500', '5000.000', null, 'Diesel']);
    assert.match((await refused('POST', F(`fuel/dispensers/${du1.id}/nozzles`), { nozzleNo: '9', productId: petrol.id, reading: '0' })).message, /choose the tank it draws from/);
    assert.equal((await refused('POST', F(`fuel/dispensers/${du2.id}/nozzles`), { nozzleNo: '1', tankId: t1.id, reading: '0' })).status, 409, 'one nozzle number at an outlet');
    assert.match((await refused('PATCH', F(`fuel/nozzles/${n1.id}`), { reading: '1' })).message, /moves only with a shift's close, or a meter change/);
    // The 5-litre measure of the daily nozzle test, with its stamping.
    setupNow = await request('POST', F('fuel/measures'), { locationId: outlet.id, name: '5-litre measure', litres: '5', stampingDue: addDays(today, 10) }, 201);
    assert.equal(setupNow.measures[0].days_to_due, 10);
    // The prices of the outlet, typed to take effect a day ago (the morning's revision).
    const prices = await request('POST', F('fuel/prices'), { requestKey: key(), locationId: outlet.id, effectiveFrom: ago(26 * 60),
      prices: [{ productId: petrol.id, price: '102.12' }, { productId: diesel.id, price: '95.20' }, { productId: cng.id, price: '88' }] }, 201);
    assert.deepEqual(prices.current.map((p) => [p.name, p.price]), [['Petrol', '102.12'], ['Diesel', '95.20'], ['CNG', '88.00']]);
    const again = { requestKey: key(), locationId: outlet.id, prices: [{ productId: petrol.id, price: '0' }] };
    assert.match((await refused('POST', F('fuel/prices'), again)).message, /more than 0/);
    assert.equal((await refused('POST', F('fuel/prices'), { ...again, prices: [{ productId: petrol.id, price: '102.12' }] }, cashier.token)).status, 403);
    // The tolerances, MDG 2024's until changed; only someone who keeps the settings changes them.
    const settings = await request('GET', F('fuel/settings'));
    assert.deepEqual([settings.densityTolerance, settings.variationPercent, settings.petrolLossPercent, settings.petrolLossAbovePercent, settings.dieselLossPercent,
      settings.dieselLossAbovePercent, settings.above600Kl, settings.testLitres], ['3.0', '4.00', '0.75', '0.60', '0.25', '0.20', false, '5.000']);
    assert.equal((await refused('PUT', F('fuel/settings'), { densityTolerance: '4' }, cashier.token)).status, 403);
    assert.equal((await request('PUT', F('fuel/settings'), { stampingWarnDays: '45' })).stampingWarnDays, 45);
    // A fuel goes on no other bill, and petrol or diesel on no other purchase; CNG is bought on a purchase.
    terminal = await request('POST', F('contacts'), { kind: 'supplier', name: 'Cherlapally Terminal' }, 201);
    const loose = await refused('POST', F('documents'), { kind: 'sale', requestKey: key(), locationId: outlet.id, lines: [{ skuId: petrol.sku_id, quantity: '5' }], payment: { amount: 'full', method: 'cash' } });
    assert.deepEqual([loose.status, /Petrol is sold by the meters: a shift's close bills it/.test(loose.message)], [409, true]);
    const bought = await refused('POST', F('documents'), { kind: 'purchase', requestKey: key(), locationId: outlet.id, contactId: terminal.id, lines: [{ skuId: diesel.sku_id, quantity: '100', unitPrice: '88' }] });
    assert.deepEqual([bought.status, /Diesel comes in from a tanker receipt/.test(bought.message)], [409, true]);
    const gas = await request('POST', F('contacts'), { kind: 'supplier', name: 'City Gas Distribution' }, 201);
    await request('POST', F('documents'), { kind: 'purchase', requestKey: key(), locationId: outlet.id, contactId: gas.id, lines: [{ skuId: cng.sku_id, quantity: '500', unitPrice: '70' }] }, 201);
    assert.equal(await stockOf(cng), '500.000');
    // The set-up shows the PESO licence (Form XIV) once the licences are kept.
    assert.equal((await request('GET', F('fuel/setup'))).peso, null);
    await request('PUT', F('modules/licences'), { enabled: true });
    await request('POST', F('licences'), { locationId: outlet.id, kind: 'peso', name: 'PESO licence (Form XIV)', licenceNo: 'P/HQ/TS/15/1234(P123456)', authority: 'PESO',
      validFrom: addDays(today, -400), validUntil: addDays(today, 3250) }, 201);
    const peso = (await request('GET', F('fuel/setup'))).peso[0];
    assert.deepEqual([peso.licence.licence_no, peso.licence.in_force], ['P/HQ/TS/15/1234(P123456)', true]);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='fuel_price.set'", [fuel.id]));
  });

  await t.test('fleet customers: vehicles by registration with the fuel they take and their fill limits', async () => {
    transports = await request('POST', F('contacts'), { kind: 'customer', name: 'Sri Balaji Transports', phone: '9848011223', creditDays: '30', creditLimit: '50000', pan: 'AAKFS1234B' }, 201);
    truck = await request('POST', F('fuel/vehicles'), { contactId: transports.id, registration: 'ts 09 ub 4455', description: 'Tata 1613, driver Mallesh', productId: diesel.id, fillLimit: '300' }, 201);
    tempo = await request('POST', F('fuel/vehicles'), { contactId: transports.id, registration: 'TS09UB4456', productId: diesel.id }, 201);
    assert.deepEqual([truck.registration, truck.fill_limit, truck.product_name, tempo.fill_limit], ['TS09UB4455', '300.000', 'Diesel', null]);
    assert.equal((await refused('POST', F('fuel/vehicles'), { contactId: transports.id, registration: 'TS09UB4455' })).status, 409);
    assert.equal((await refused('POST', F('fuel/vehicles'), { contactId: terminal.id, registration: 'TS09UB9999' })).status, 404, 'a supplier has no fleet');
    assert.equal((await refused('POST', F('fuel/vehicles'), { contactId: transports.id, registration: 'TS09UB9999' }, ravi.token)).status, 403);
    assert.match((await refused('PATCH', F(`fuel/vehicles/${truck.id}`), { registration: 'TS09UB0000' })).message, /keeps its customer and its registration/);
    // An oil company's fleet card is a payment method of the business, taken with the shift's takings.
    fleetCard = await request('POST', F('payment-methods'), { name: 'Fleet card', kind: 'card' }, 201);
    const listed = await ravi.call('GET', F('fuel/vehicles'));
    assert.deepEqual(listed.map((x) => x.registration), ['TS09UB4455', 'TS09UB4456'], 'the attendant finds the vehicles for the credit slips');
  });

  const methods = async () => (await request('GET', F('payment-methods')));
  const closeBody = (extra = {}) => ({
    requestKey: key(),
    readings: [{ nozzleId: n1.id, closing: '100500.500', test: '5' }, { nozzleId: n2.id, closing: '250800.500', test: '5.000' }],
    slips: [{ contactId: transports.id, vehicleId: truck.id, litres: '200', slipNo: '0012' }, { contactId: transports.id, vehicleId: tempo.id, litres: '100.5', slipNo: '0013' }],
    cash: '37670',
    ...extra,
  });

  await t.test('a shift: nozzles taken from their readings, closed with the 5-litre test, credit slips and takings, posted as fuel bills exact to the paisa', async () => {
    const upi = (await methods()).find((m) => m.kind === 'upi'), card = (await methods()).find((m) => m.kind === 'card' && m.name === 'Card');
    const takings = [{ methodId: upi.id, amount: '30000', reference: 'UPI-6612' }, { methodId: card.id, amount: '20000' }, { methodId: fleetCard.id, amount: '10000', reference: 'FC-8841' }];
    // Ravi opens his own shift on nozzles 1 and 2, from their readings; not from another reading, and not for someone else.
    const open = { requestKey: key(), locationId: outlet.id, openedAt: ago(90), nozzles: [n1.id, n2.id] };
    assert.match((await refused('POST', F('fuel/shifts'), { ...open, requestKey: key(), nozzles: [{ nozzleId: n1.id, opening: '99000' }] }, ravi.token)).message,
      /totaliser reads 100000\.000 from its last close: a shift opens from there/);
    assert.equal((await refused('POST', F('fuel/shifts'), { ...open, requestKey: key(), attendantId: suresh.id }, ravi.token)).status, 403);
    shift1 = await ravi.call('POST', F('fuel/shifts'), open, 201);
    assert.match(shift1.shift_no, /^FS\//);
    assert.deepEqual([shift1.status, shift1.attendant_name, shift1.nozzles.map((n) => [n.nozzle_no, n.opening, n.price])],
      ['open', 'Ravi Kumar', [['1', '100000.000', '102.12'], ['2', '250000.500', '95.20']]]);
    assert.equal((await ravi.call('POST', F('fuel/shifts'), open, 201)).id, shift1.id, 'the same request is the same shift');
    assert.equal((await refused('POST', F('fuel/shifts'), { ...open, notes: 'other' }, ravi.token)).status, 409);
    // A nozzle is on one open shift at a time; Suresh's shift on nozzle 1 is refused, the cashier opens CNG for him.
    assert.match((await refused('POST', F('fuel/shifts'), { requestKey: key(), locationId: outlet.id, attendantId: suresh.id, nozzles: [n1.id] }, cashier.token)).message,
      /Nozzle 1 is on shift FS\/.+ \(Ravi Kumar\), still open/);
    const shift2 = await cashier.call('POST', F('fuel/shifts'), { requestKey: key(), locationId: outlet.id, attendantId: suresh.id, openedAt: ago(60), nozzles: [n3.id] }, 201);
    // The preview: petrol 495.500 litres at ₹102.12; diesel 795.000, of which 300.500 on two credit slips; the takings and ₹37,670 counted.
    const preview = await ravi.call('POST', F(`fuel/shifts/${shift1.id}/close/preview`), closeBody({ payments: takings }));
    assert.deepEqual(preview.products.map((p) => [p.name, p.price, p.litres, p.creditLitres, p.walkInLitres, p.creditAmount, p.walkInAmount, p.amount]), [
      ['Petrol', '102.12', '495.500', '0.000', '495.500', '0.00', '50600.46', '50600.46'],
      ['Diesel', '95.20', '795.000', '300.500', '494.500', '28607.60', '47076.40', '75684.00']]);
    assert.deepEqual([preview.expected, preview.credit, preview.walkIn, preview.other, preview.cash, preview.cashPaid, preview.difference, preview.short, preview.excess],
      ['126284.46', '28607.60', '97676.86', '60000.00', '37670.00', '37670.00', '-6.86', '6.86', '0.00']);
    assert.deepEqual(preview.nozzles.map((n) => [n.nozzleNo, n.gross, n.test, n.litres]), [['1', '500.500', '5.000', '495.500'], ['2', '800.000', '5.000', '795.000']]);
    assert.equal(paise(preview.expected), paise(preview.credit) + paise(preview.walkIn), 'credit and walk-in sales are the expected money, to the paisa');
    // What is refused: a nozzle not read, a closing below the opening, a test more than it moved, slips over what the meters sold, takings over the walk-in sales.
    const bad = (extra) => refused('POST', F(`fuel/shifts/${shift1.id}/close/preview`), closeBody(extra), ravi.token);
    assert.match((await bad({ readings: [{ nozzleId: n1.id, closing: '100500.500' }] })).message, /Give nozzle 2's closing reading/);
    assert.match((await bad({ readings: [{ nozzleId: n1.id, closing: '99999' }, { nozzleId: n2.id, closing: '250800.500' }] })).message, /its closing reading is not less than that/);
    assert.match((await bad({ readings: [{ nozzleId: n1.id, closing: '100002', test: '5' }, { nozzleId: n2.id, closing: '250800.500' }] })).message, /the test pumped back is no more than that/);
    assert.match((await bad({ slips: [{ contactId: transports.id, vehicleId: tempo.id, litres: '900' }] })).message, /credit slips for Diesel come to 900\.000 litres, more than the 795\.000/);
    assert.match((await bad({ payments: [{ methodId: upi.id, amount: '99000' }] })).message, /more than the ₹97676\.86 of walk-in sales/);
    assert.match((await bad({ slips: [{ contactId: transports.id, vehicleId: truck.id, litres: '10', productId: petrol.id }] })).message, /TS09UB4455 takes Diesel on credit/);
    assert.match((await bad({ payments: [{ methodId: (await methods()).find((m) => m.kind === 'cash').id, amount: '10' }] })).message, /cannot be used here/);
    // A fill over its vehicle's fill limit is allowed by a manager only.
    const over = await ravi.call('POST', F(`fuel/shifts/${shift1.id}/close/preview`), closeBody({ slips: [{ contactId: transports.id, vehicleId: truck.id, litres: '350' }] }));
    assert.deepEqual([over.approvalNeeded, over.limits[0].kind, over.slips[0].overLimit], [true, 'fill', true]);
    const blocked = await refused('POST', F(`fuel/shifts/${shift1.id}/close`), closeBody({ slips: [{ contactId: transports.id, vehicleId: truck.id, litres: '350' }], approve: true }), ravi.token);
    assert.deepEqual([blocked.status, blocked.data?.reason, /TS09UB4455 took 350\.000 litres, over its fill limit of 300\.000: a manager allows the credit/.test(blocked.message)], [409, 'approval_needed', true]);
    // Closed by Ravi: the walk-in fuel bill and the fleet customer's fuel bill, through the core, with no round-off.
    const body = closeBody({ payments: takings, note: 'Short by the change of the last cash sale' });
    const closed = await ravi.call('POST', F(`fuel/shifts/${shift1.id}/close`), body);
    assert.deepEqual([closed.status, closed.close.expected, closed.close.walk_in, closed.close.credit, closed.close.difference, closed.close.seq], ['closed', '126284.46', '97676.86', '28607.60', '-6.86', 1]);
    assert.equal((await ravi.call('POST', F(`fuel/shifts/${shift1.id}/close`), body)).close.id, closed.close.id, 'the same close again is the same close');
    assert.equal((await refused('POST', F(`fuel/shifts/${shift1.id}/close`), { ...body, cash: '1' }, ravi.token)).status, 409);
    const walkIn = await request('GET', F(`documents/${closed.close.document_id}`));
    assert.deepEqual([walkIn.contact_id, walkIn.total, walkIn.subtotal, walkIn.tax, walkIn.round_off], [null, '97676.86', '97676.86', '0.00', '0.00'], 'exact to the paisa, though the business rounds bills');
    assert.deepEqual(walkIn.lines.map((l) => [l.label, l.quantity, l.unit_price, l.net, l.tax, l.tax_rate]), [
      ['Petrol · price includes state VAT', '495.500', '102.12', '50600.46', '0.00', '0.00'], ['Diesel · price includes state VAT', '494.500', '95.20', '47076.40', '0.00', '0.00']]);
    assert.deepEqual(walkIn.payments.map((p) => [p.method, p.method_name, p.amount]), [['credit_note', 'Attendant account', '6.86'], ['upi', 'UPI', '30000.00'], ['card', 'Card', '20000.00'],
      ['card', 'Fleet card', '10000.00'], ['cash', null, '37670.00']]);
    const paid = walkIn.payments.reduce((s, p) => s + paise(p.amount), 0);
    assert.equal(paise(walkIn.total) - paid, 0, 'the attendant\'s short is paid from their account, not left due on the walk-in bill');
    const creditBill = await request('GET', F(`documents/${closed.close.slips[0].document_id}`));
    assert.deepEqual([creditBill.contact_id, creditBill.total, creditBill.round_off, creditBill.due_on, creditBill.buyer_pan], [transports.id, '28607.60', '0.00', addDays(today, 30), 'AAKFS1234B']);
    assert.deepEqual(creditBill.lines.map((l) => [l.label, l.quantity, l.net]), [['Diesel · TS09UB4455 · slip 0012 · price includes state VAT', '200.000', '19040.00'],
      ['Diesel · TS09UB4456 · slip 0013 · price includes state VAT', '100.500', '9567.60']]);
    assert.equal(paise(walkIn.total) + paise(creditBill.total), paise(closed.close.expected), 'the bills are the shift, to the paisa');
    // Stock left with the meters' litres; the nozzles read their closing readings.
    assert.deepEqual([await stockOf(petrol), await stockOf(diesel)], ['8504.500', '11205.000']);
    assert.deepEqual((await rows('SELECT reading FROM fuel_nozzles WHERE id=ANY($1::bigint[]) ORDER BY nozzle_no', [[n1.id, n2.id]])).map((r) => r.reading), ['100500.500', '250800.500']);
    // A closed shift never changes; its bill lines are credited only by a manager reopening it.
    assert.match((await refused('PATCH', F(`fuel/shifts/${shift1.id}`), { notes: 'x' }, ravi.token)).message, /is closed and no longer changes/);
    const sold = await refused('POST', F(`documents/${walkIn.id}/returns`), { requestKey: key(), reason: 'Customer return', lines: [{ lineId: walkIn.lines[0].id, quantity: '1' }] });
    assert.deepEqual([sold.status, /fuel the meters sold on shift FS\/.+: it is credited only by a manager reopening the shift/.test(sold.message)], [409, true]);
    // A price that took effect while Suresh's CNG shift was open: the shift closes at the change, at the old price; ₹18.00 in excess.
    const change = ago(20);
    await request('POST', F('fuel/prices'), { requestKey: key(), locationId: outlet.id, effectiveFrom: change, prices: [{ productId: cng.id, price: '90' }] }, 201);
    const cngClose = (extra) => ({ requestKey: key(), readings: [{ nozzleId: n3.id, closing: '5120.250' }], cash: '10600', ...extra });
    assert.match((await refused('POST', F(`fuel/shifts/${shift2.id}/close`), cngClose(), cashier.token)).message,
      /The price of CNG changed at .+, while this shift was open: close it with the readings taken then/);
    const cngShift = await cashier.call('POST', F(`fuel/shifts/${shift2.id}/close`), cngClose({ closedAt: change }));
    assert.deepEqual([cngShift.close.expected, cngShift.close.cash, cngShift.close.difference, cngShift.close.products[0].price, cngShift.close.products[0].litres],
      ['10582.00', '10600.00', '18.00', '88.00', '120.250']);
    const cngBill = await request('GET', F(`documents/${cngShift.close.document_id}`));
    assert.deepEqual(cngBill.payments.map((p) => [p.method, p.amount]), [['cash', '10582.00']], 'an excess is kept with the shift: the bill takes what is due');
    // A price never takes effect back into a closed shift that sold the fuel.
    assert.match((await refused('POST', F('fuel/prices'), { requestKey: key(), locationId: outlet.id, effectiveFrom: ago(60), prices: [{ productId: petrol.id, price: '103' }] })).message,
      /sold Petrol at its price until .+: a new price takes effect from then or later/);
    // Who sees what: Ravi his own shifts and their money; the cashier and a viewer (who sees the sales) everyone's.
    assert.deepEqual((await ravi.call('GET', F('fuel/shifts'))).items.map((s) => s.id), [shift1.id]);
    assert.equal((await refused('GET', F(`fuel/shifts/${shift2.id}`), undefined, ravi.token)).status, 404);
    assert.equal((await cashier.call('GET', F('fuel/shifts'))).total, 2);
    assert.equal((await viewer.call('GET', F('fuel/shifts'))).total, 2);
    const board = await cashier.call('GET', F('fuel/shifts/day'));
    assert.ok(board.closed.some((s) => s.id === shift1.id && s.difference === '-6.86') && board.nozzles.length === 4);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='fuel_shift.closed' AND entity_id=$2", [fuel.id, shift1.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='fuel_shift.closed' AND entity_id=$2", [fuel.id, shift1.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='fuel_shift.opened' AND entity_id=$2", [fuel.id, shift2.id]));
  });

  await t.test('a manager reopens a closed shift with a reason before the next one starts: its bills credited, its takings handed back, closed again', async () => {
    const reason = { requestKey: key(), reason: 'Diesel closing reading typed 10 litres short' };
    assert.equal((await refused('POST', F(`fuel/shifts/${shift1.id}/reopen`), reason, ravi.token)).status, 403);
    assert.equal((await refused('POST', F(`fuel/shifts/${shift1.id}/reopen`), { requestKey: key() })).status, 400);
    const reopened = await request('POST', F(`fuel/shifts/${shift1.id}/reopen`), reason);
    assert.deepEqual([reopened.status, reopened.close, reopened.history.length, reopened.history[0].reopen_reason], ['open', null, 1, 'Diesel closing reading typed 10 litres short']);
    assert.equal((await request('POST', F(`fuel/shifts/${shift1.id}/reopen`), reason)).id, shift1.id, 'asking again is the same reopening');
    const first = reopened.history[0];
    const walkIn = await request('GET', F(`documents/${first.document_id}`));
    assert.deepEqual([walkIn.returns.length, walkIn.returns[0].total, walkIn.refunds.reduce((s, f) => s + paise(f.amount), 0)], [1, '97676.86', paise('97676.86')]);
    assert.deepEqual(walkIn.refunds.map((f) => [f.method, f.method_name, f.amount]), [['credit_note', null, '6.86'], ['upi', 'UPI', '30000.00'], ['card', 'Card', '20000.00'],
      ['card', 'Fleet card', '10000.00'], ['cash', null, '37670.00']]);
    const creditBill = await request('GET', F(`documents/${first.slips[0].document_id}`));
    assert.equal(creditBill.returns[0].total, '28607.60');
    assert.deepEqual([await stockOf(petrol), await stockOf(diesel)], ['9000.000', '12000.000'], 'the litres are back in stock until the shift closes again');
    assert.deepEqual((await rows('SELECT reading FROM fuel_nozzles WHERE id=ANY($1::bigint[]) ORDER BY nozzle_no', [[n1.id, n2.id]])).map((r) => r.reading), ['100000.000', '250000.500']);
    // Closed again with the diesel reading corrected: 805.000 litres of diesel now.
    const upi = (await methods()).find((m) => m.kind === 'upi'), card = (await methods()).find((m) => m.kind === 'card' && m.name === 'Card');
    const again = await ravi.call('POST', F(`fuel/shifts/${shift1.id}/close`), closeBody({ readings: [{ nozzleId: n1.id, closing: '100500.500', test: '5' }, { nozzleId: n2.id, closing: '250810.500', test: '5' }],
      payments: [{ methodId: upi.id, amount: '30000' }, { methodId: card.id, amount: '20000' }, { methodId: fleetCard.id, amount: '10000' }], cash: '38622' }));
    assert.deepEqual([again.close.seq, again.close.walk_in, again.close.expected, again.close.difference], [2, '98628.86', '127236.46', '-6.86']);
    assert.deepEqual([await stockOf(petrol), await stockOf(diesel)], ['8504.500', '11195.000']);
    // The next shift on its nozzles has opened: the shift is no longer reopened.
    await cashier.call('POST', F('fuel/shifts'), { requestKey: key(), locationId: outlet.id, nozzles: [n1.id] }, 201);
    assert.match((await refused('POST', F(`fuel/shifts/${shift1.id}/reopen`), { requestKey: key(), reason: 'Late' })).message,
      /has opened on nozzle 1 since: a shift is reopened only before the next one starts/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='fuel_shift.reopened' AND entity_id=$2", [fuel.id, shift1.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='fuel_shift.reopened' AND entity_id=$2", [fuel.id, shift1.id]));
  });

  await t.test('a busy shift takes more than ₹2,00,000 in cash on its walk-in fuel bill: many buyers\' fills, each its own sale', async () => {
    // The owner's shift on nozzle 4 (diesel), opened 20 hours ago: 2,200 litres at ₹95.20, all cash.
    const busy = await request('POST', F('fuel/shifts'), { requestKey: key(), locationId: outlet.id, openedAt: ago(20 * 60), nozzles: [n4.id] }, 201);
    const preview = await request('POST', F(`fuel/shifts/${busy.id}/close/preview`), { readings: [{ nozzleId: n4.id, closing: '72200' }], cash: '209440' });
    assert.deepEqual([preview.walkIn, preview.difference], ['209440.00', '0.00']);
    // Left open for now: the bell says so (opened more than 16 hours ago).
    const bell = await request('GET', F('notifications'));
    assert.ok(bell.items.some((n) => n.category === 'Fuel' && n.title === `Shift ${busy.shift_no} is still open`));
    const done = await request('POST', F(`fuel/shifts/${busy.id}/close`), { requestKey: key(), readings: [{ nozzleId: n4.id, closing: '72200' }], cash: '209440' });
    const bill = await request('GET', F(`documents/${done.close.document_id}`));
    assert.deepEqual([bill.total, bill.payments.map((p) => [p.method, p.amount])], ['209440.00', [['cash', '209440.00']]]);
  });

  await t.test('tanker receipts: the density check against the invoice, the dips before and after, the purchase through the core, a manager\'s cancellation', async () => {
    const keeper = await staff('fuel-keeper@test.invalid', 'Store Keeper', 'stock_keeper');
    const load = (extra = {}, lines = {}) => ({ requestKey: key(), locationId: outlet.id, contactId: terminal.id, invoiceNo: `INV-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      invoiceDate: today, lorryNo: 'TS07UA1234', sealsOk: true, status: 'accepted',
      lines: [{ tankId: t1.id, invoiceLitres: '6000', invoiceAmount: '550000', invoiceDensity: '745.0', receiptDensity: '747.5', dipBefore: '8500', dipAfter: '14460', ...lines }], ...extra });
    // Within 3.0 kg/m³: accepted, a purchase of 6,000 litres at the invoice's value; 40 litres short by the dips.
    const accepted = await keeper.call('POST', F('fuel/receipts'), load(), 201);
    assert.deepEqual([accepted.status, accepted.lines[0].density_difference, accepted.lines[0].density_within, accepted.lines[0].received_litres, accepted.lines[0].short_litres],
      ['accepted', '2.5', true, '5960.000', '40.000']);
    const purchase = await request('GET', F(`documents/${accepted.document_id}`));
    assert.deepEqual([purchase.kind, purchase.contact_id, purchase.total, purchase.tax, purchase.supplier_bill_no, purchase.lines[0].quantity, purchase.lines[0].label],
      ['purchase', terminal.id, '550000.00', '0.00', accepted.invoice_no, '6000.000', 'Petrol · tank T1 · lorry TS07UA1234']);
    assert.equal(await stockOf(petrol), '14504.500');
    // The same invoice twice from the terminal: the core refuses it.
    assert.equal((await refused('POST', F('fuel/receipts'), load({ invoiceNo: accepted.invoice_no }), keeper.token)).status, 409);
    // 6.5 kg/m³ off the invoice: refused by the keeper's hand unless sent back; accepted by a manager saying why.
    const off = load({}, { receiptDensity: '751.5' });
    const outside = await refused('POST', F('fuel/receipts'), off, keeper.token);
    assert.deepEqual([outside.status, outside.data?.reason, /tank T1's load is 6\.5 kg\/m³ above its invoice's density, outside the 3\.0 kg\/m³ allowed/.test(outside.message)],
      [409, 'density_outside', true]);
    assert.equal((await refused('POST', F('fuel/receipts'), { ...off, densityNote: 'Oil company officer allowed it' }, keeper.token)).status, 409, 'a keeper cannot accept it');
    const sent = await keeper.call('POST', F('fuel/receipts'), { ...load({}, { receiptDensity: '751.5', dipBefore: undefined, dipAfter: undefined }), status: 'refused',
      refuseReason: 'Density 6.5 kg/m³ above the invoice' }, 201);
    assert.deepEqual([sent.status, sent.document_id, sent.lines[0].density_within], ['refused', null, false]);
    const allowed = await request('POST', F('fuel/receipts'), { ...off, densityNote: 'Sales officer checked the sample and allowed decanting' }, 201);
    assert.deepEqual([allowed.status, allowed.density_note, allowed.density_approved_by_name], ['accepted', 'Sales officer checked the sample and allowed decanting', 'fuel-owner']);
    // Dips are taken before and after decanting, and no more than the tank holds.
    assert.match((await refused('POST', F('fuel/receipts'), load({}, { dipBefore: '9000', dipAfter: '15100' }), keeper.token)).message, /Tank T1 holds at most 15000\.000 litres/);
    assert.match((await refused('POST', F('fuel/receipts'), load({}, { dipBefore: undefined, dipAfter: undefined }), keeper.token)).message, /give the dip before and after decanting/);
    // The density after decanting and 50 litres dispensed, once.
    const decanted = await keeper.call('POST', F(`fuel/receipts/${accepted.id}/decant`), { lines: [{ tankId: t1.id, density: '746.0' }] });
    assert.equal(decanted.lines[0].decant_density, '746.0');
    assert.equal((await refused('POST', F(`fuel/receipts/${accepted.id}/decant`), { lines: [{ tankId: t1.id, density: '746.5' }] }, keeper.token)).status, 409);
    // A manager cancels a load entered wrongly: the purchase credited, the litres out of stock; only that way.
    const line = purchase.lines[0];
    const back = await refused('POST', F(`documents/${purchase.id}/returns`), { requestKey: key(), reason: 'Wrong', lines: [{ lineId: line.id, quantity: '6000' }] });
    assert.match(back.message, /fuel received on tanker invoice .+: it goes back only by a manager cancelling the receipt/);
    assert.equal((await refused('POST', F(`fuel/receipts/${allowed.id}/cancel`), { requestKey: key(), reason: 'Typed twice' }, keeper.token)).status, 403);
    const cancelled = await request('POST', F(`fuel/receipts/${allowed.id}/cancel`), { requestKey: key(), reason: 'Entered against the wrong tank' });
    assert.deepEqual([cancelled.status, cancelled.cancel_reason], ['cancelled', 'Entered against the wrong tank']);
    assert.equal(await stockOf(petrol), '14504.500', 'the cancelled load is out of stock again');
    const list = await keeper.call('GET', F('fuel/receipts'));
    assert.deepEqual(list.items.map((r) => r.status).sort(), ['accepted', 'cancelled', 'refused']);
    assert.equal(list.items.find((r) => String(r.id) === String(accepted.id)).amount, 550000, 'a keeper who buys sees the value');
    assert.equal((await ravi.call('GET', F('fuel/receipts'))).items[0].amount, null, 'an attendant sees no money');
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='fuel_receipt.accepted' AND entity_id=$2", [fuel.id, accepted.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='fuel_receipt.cancelled' AND entity_id=$2", [fuel.id, allowed.id]));
  });

  await t.test('the morning dips and the day\'s stock register against the MDG tolerance; the density register', async () => {
    // An outlet of its own: a petrol tank with 9,000 litres, a nozzle, its price.
    const highway = await request('POST', F('locations'), { name: 'Highway outlet', code: 'HWY' }, 201);
    let s = await request('POST', F('fuel/tanks'), { locationId: highway.id, productId: petrol.id, tankNo: 'H1', capacity: '20000', stockNow: { litres: '9000' } }, 201);
    const h1 = s.tanks.find((x) => x.tank_no === 'H1');
    s = await request('POST', F('fuel/dispensers'), { locationId: highway.id, unitNo: 'MPD 1', stampingDue: addDays(today, 300), nozzles: [{ nozzleNo: 'H1', tankId: h1.id, reading: '50000' }] }, 201);
    const nh = s.dispensers.find((d) => d.unit_no === 'MPD 1').nozzles[0];
    await request('POST', F('fuel/prices'), { requestKey: key(), locationId: highway.id, effectiveFrom: ago(180), prices: [{ productId: petrol.id, price: '102.50' }] }, 201);
    // Yesterday's morning dip (typed on the day, with its time); today's later.
    const yesterday = addDays(today, -1);
    assert.match((await refused('POST', F('fuel/dips'), { requestKey: key(), tankId: h1.id, dipOn: yesterday, stock: '9000' }, ravi.token)).message, /Give the time the dip of/);
    const dip1 = await ravi.call('POST', F('fuel/dips'), { requestKey: key(), tankId: h1.id, dipOn: yesterday, takenAt: momentAt(yesterday, '06:00'), stock: '9000', dipCm: '142.5',
      waterCm: '0', density: '745.5', temperature: '29.5' }, 201);
    assert.equal((await refused('POST', F('fuel/dips'), { requestKey: key(), tankId: h1.id, dipOn: yesterday, takenAt: momentAt(yesterday, '07:00'), stock: '1' })).status, 409);
    assert.match((await refused('POST', F('fuel/dips'), { requestKey: key(), tankId: h1.id, stock: '20000.5' })).message, /holds at most 20000\.000 litres/);
    // A load in: 4,000 litres; the owner's shift on the nozzle: 495 litres sold after the 5-litre test.
    await request('POST', F('fuel/receipts'), { requestKey: key(), locationId: highway.id, contactId: terminal.id, invoiceNo: 'HWY-1101', invoiceDate: today, lorryNo: 'AP29TB0042',
      receivedAt: ago(40), status: 'accepted', lines: [{ tankId: h1.id, invoiceLitres: '4000', invoiceAmount: '366000', invoiceDensity: '745.0', receiptDensity: '746.0', dipBefore: '8700',
        dipAfter: '12650', decantDensity: '745.8' }] }, 201);
    const hs = await request('POST', F('fuel/shifts'), { requestKey: key(), locationId: highway.id, openedAt: ago(120), nozzles: [nh.id] }, 201);
    await request('POST', F(`fuel/shifts/${hs.id}/close`), { requestKey: key(), closedAt: ago(30), readings: [{ nozzleId: nh.id, closing: '50500', test: '5' }], cash: '50737.50' });
    // Today's dip: 12,000 litres against a book of 12,505 (9,000 + 4,000 - 495): 505 litres short, 4.21% of the dip, beyond 480 + 3.713.
    const dip2 = await ravi.call('POST', F('fuel/dips'), { requestKey: key(), tankId: h1.id, stock: '12000', density: '745.9' }, 201);
    let register = await viewer.call('GET', F(`fuel/register?locationId=${highway.id}&from=${yesterday}&to=${today}`));
    let rowsOf = register.tanks[0].rows;
    assert.deepEqual(rowsOf.map((r) => [r.day, r.opening, r.receipts, r.meter, r.test, r.sales, r.book, r.closing, r.variation, r.percent, r.allowedGain, r.allowedLoss, r.flag]), [
      [yesterday, '9000.000', '4000.000', '500.000', '5.000', '495.000', '12505.000', '12000.000', '-505.000', '-4.21', '480.000', '483.713', 'loss'],
      [today, '12000.000', '0.000', '0.000', '0.000', '0.000', '12000.000', null, null, null, null, null, 'open']]);
    const bell = await request('GET', F('notifications'));
    assert.ok(bell.items.some((n) => n.category === 'Fuel' && n.severity === 'warning' && /Tank H1 \(Petrol\): less by the dip than the book, beyond the tolerance/.test(n.title)));
    // A manager corrects today's dip (read off the wrong line): 12,100 litres is within the tolerance.
    assert.equal((await refused('PATCH', F(`fuel/dips/${dip2.id}`), { stock: '12100', reason: 'Chart' }, ravi.token)).status, 403);
    assert.match((await refused('PATCH', F(`fuel/dips/${dip2.id}`), { stock: '12100' })).message, /Why the dip is corrected is required/);
    await request('PATCH', F(`fuel/dips/${dip2.id}`), { stock: '12100', reason: 'Read off the wrong line of the dip chart' });
    register = await request('GET', F(`fuel/register?locationId=${highway.id}&from=${yesterday}&to=${today}`));
    rowsOf = register.tanks[0].rows;
    assert.deepEqual([rowsOf[0].variation, rowsOf[0].flag], ['-405.000', 'within']);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='fuel_dip.corrected' AND entity_id=$2", [fuel.id, dip2.id]));
    // The dips board: the tank with today's dip and yesterday's, and the book stock now.
    const board = await ravi.call('GET', F(`fuel/dips?locationId=${highway.id}`));
    assert.deepEqual([board.tanks[0].dip.stock, board.tanks[0].previous.stock, board.tanks[0].book.book], ['12100.000', '9000.000', '12100.000']);
    // The density register: the morning densities, and the load's by invoice, at receipt and after decanting.
    const density = await request('GET', F(`fuel/density?locationId=${highway.id}&month=${today.slice(0, 7)}`));
    const loadRow = density.tanks[0].rows.find((r) => r.loads.length);
    assert.deepEqual([loadRow.loads[0].invoice_density, loadRow.loads[0].receipt_density, loadRow.loads[0].difference, loadRow.loads[0].within, loadRow.loads[0].decant_density],
      ['745.0', '746.0', '1.0', true, '745.8']);
    assert.ok(density.tanks[0].rows.some((r) => r.dip && r.dip.density === '745.9'));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='fuel_dip.taken' AND entity_id=$2", [fuel.id, dip1.id]));
  });

  await t.test('fleet statements: the month\'s fills vehicle by vehicle, with the account\'s bills and payments', async () => {
    const month = today.slice(0, 7);
    const fleet = await request('GET', F(`fuel/fleet?month=${month}`));
    const row = fleet.items.find((x) => x.id === transports.id);
    assert.deepEqual([row.vehicles, row.fills, row.amount, row.balance, row.over_limit], [2, 2, '28607.60', '28607.60', false]);
    const statement = await cashier.call('GET', F(`fuel/fleet/${transports.id}/statement?month=${month}`));
    assert.deepEqual(statement.vehicles.map((v) => [v.registration, v.fills.length, v.amount, v.fills[0].slip_no, v.fills[0].litres, v.fills[0].price]),
      [['TS09UB4455', 1, '19040.00', '0012', '200.000', '95.20'], ['TS09UB4456', 1, '9567.60', '0013', '100.500', '95.20']]);
    assert.deepEqual(statement.totals, [{ product: 'Diesel', unit: 'litre', litres: '300.500', amount: '28607.60' }]);
    // The account: the first close's bill and its credit note, the second close's bill.
    assert.deepEqual([statement.ledger.debit, statement.ledger.credit, statement.ledger.closing], ['57215.20', '28607.60', '28607.60']);
    // The fleet's money is for those who see sales.
    assert.equal((await refused('GET', F(`fuel/fleet/${transports.id}/statement`), undefined, ravi.token)).status, 403);
    assert.equal((await refused('GET', F('fuel/fleet'), undefined, viewer.token)).status, 200, 'a viewer sees sales');
  });

  await t.test('the bell: stamping falling due, and a load accepted outside the density tolerance', async () => {
    // A diesel load 4.0 kg/m³ under its invoice's density, accepted by the manager after the sales officer's sample.
    await request('POST', F('fuel/receipts'), { requestKey: key(), locationId: outlet.id, contactId: terminal.id, invoiceNo: 'INV-D-77', invoiceDate: today, lorryNo: 'TS07UA9876',
      status: 'accepted', densityNote: 'Sales officer allowed it after a sample', lines: [{ tankId: t2.id, invoiceLitres: '4000', invoiceAmount: '352000', invoiceDensity: '830.0',
        receiptDensity: '826.0', dipBefore: '7000', dipAfter: '10990' }] }, 201);
    const bell = await request('GET', F('notifications'));
    const fuelItems = bell.items.filter((n) => n.category === 'Fuel');
    assert.ok(fuelItems.some((n) => n.title === 'Dispensing unit DU 2\'s stamping falls due in 20 days' && n.severity === 'warning'));
    assert.ok(fuelItems.some((n) => n.title === '5-litre measure\'s stamping falls due in 10 days'));
    assert.ok(fuelItems.some((n) => n.title === 'Load INV-D-77 was accepted outside the density tolerance'));
    assert.ok(fuelItems.every((n) => n.link.startsWith(`/business-admin/${fuel.id}/`)));
  });

  await t.test('other types and other owners are kept out', async () => {
    assert.equal((await refused('GET', `/businesses/${grocery.id}/fuel/shifts`)).status, 403);
    assert.equal((await refused('GET', `/businesses/${rentals.id}/fuel/setup`)).status, 403);
    // The set-up routes check the catalogue or settings permission first, then answer for a fuel station only.
    assert.equal((await refused('POST', `/businesses/${grocery.id}/fuel/products`, { item: { name: 'Petrol' }, family: 'petrol' })).status, 404);
    assert.equal((await refused('GET', F(`fuel/shifts/${shift1.id}`), undefined, await login('fuel-other@test.invalid'))).status, 404);
    assert.equal((await other('GET', `/businesses/${elsewhere.id}/fuel/shifts`)).total, 0);
    assert.equal((await refused('POST', F('fuel/shifts'), { requestKey: key(), locationId: outlet.id, nozzles: [n3.id] }, viewer.token)).status, 403);
    assert.equal((await refused('POST', F('fuel/dips'), { requestKey: key(), tankId: t1.id, stock: '1' }, viewer.token)).status, 403);
  });
});
