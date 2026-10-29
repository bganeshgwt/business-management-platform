const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// What a rental business keeps beyond its bookings: kits that book their
// parts (never double-booked, even two at once), billed as the kit or by its
// parts; the hirer register of the rent-a-cab and rent-a-motorcycle schemes
// with the licence class checked against the vehicle; vehicle papers with
// the bell and the handover refused or warned; the slab a vehicle's facts
// make; kilometres and fuel worked out at the return to the paisa; late fee
// slabs with a cap; cancellation slabs and a manager's waiver; pools counted
// per location with transfers; checklists, photos and signatures, and the
// original document held; scanning units; service schedules and downtime; a
// discount within the limits; use and earnings. Refusals with their codes,
// idempotent retries, audit and events. Runs on its own throwaway database
// with every migration applied (and this one taken down and up again).
test('rentals: kits, registers, fleet, fees, locations, condition and reports', { timeout: 600000 }, async (t) => {
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

  await t.test('the migration goes down to before itself and up again', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const tables = ['rental_classes', 'rental_kit_parts', 'rental_pool_counts', 'rental_transfers', 'rental_downtime', 'rental_services', 'rental_hirers', 'rental_conditions',
      'rental_files', 'rental_cancellations'];
    const left = async () => (await scratch.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
    const column = async (table, name) => (await scratch.query('SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, name])).rows[0].n;
    assert.equal(await left(), tables.length);
    const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_rentals-more.sql')).split('_')[0]);
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.equal(await left(), 0);
    assert.equal(await column('rental_units', 'location_id'), 0);
    assert.equal(await column('rental_booking_lines', 'kit_line_id'), 0);
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await left(), tables.length);
    assert.equal(await column('rental_items', 'kit_billing'), 1);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Hire-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('more-owner');
  await owner('more-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('more-owner@test.invalid');
  const request = as(ownerToken);
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);
  const tomorrow = addDays(today, 1);
  const minute = (offsetMinutes = 0) => new Date(Math.floor(Date.now() / 60000) * 60000 + offsetMinutes * 60000).toISOString();

  const [rentals, grocery] = await createBusinesses(request, 'OWNER', ['rentals', 'grocery']);
  const R = (suffix) => `/businesses/${rentals.id}/${suffix}`;
  const yard = (await request('GET', R('locations'))).items[0];
  const slabs = (await request('GET', R('tax-rates'))).items;
  const gst18 = slabs.find((r) => Number(r.rate) === 18);
  const roles = (await request('GET', R('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', R('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('more-desk@test.invalid', 'cashier');
  const yardHand = await staff('more-yard@test.invalid', 'stock_keeper');
  const viewer = await staff('more-viewer@test.invalid', 'viewer');
  const manager = await staff('more-manager@test.invalid', 'manager');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const customer = (name, phone) => request('POST', R('contacts'), { kind: 'customer', name, phone }, 201);
  const hirer = await customer('Kiran Kumar', '9876500601');
  const guest = await customer('Lena Fischer', '9876500602');
  const item = async (name, body) => (await request('POST', R('rentals/items'), { item: { name, taxRateId: gst18.id, hsnCode: '997329' }, ...body }, 201)).items.find((i) => i.name === name);
  const book = (body, by = request, expected = 201) => by('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: hirer.id, ...body }, expected);
  const handOver = (booking, body = {}, token = ownerToken) => call('POST', R(`rentals/bookings/${booking.id}/checkout`), { requestKey: key(), idKind: 'pan_card', idRef: 'ABCPK1234D', ...body }, token);
  // Time passes: a booking handed over moved back so many minutes, as if it went out then (its times only).
  async function backdate(bookingId, minutes) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE rental_bookings DISABLE TRIGGER rental_bookings_guard');
      await db.query(`UPDATE rental_bookings SET out_at=out_at-make_interval(mins=>$2::int),due_at=due_at-make_interval(mins=>$2::int),
        checked_out_at=checked_out_at-make_interval(mins=>$2::int) WHERE id=$1`, [bookingId, minutes]);
      await db.query('ALTER TABLE rental_bookings ENABLE TRIGGER rental_bookings_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  const audited = (action, entity) => one('SELECT 1 FROM business_audit WHERE business_id=$1 AND action=$2 AND ($3::bigint IS NULL OR entity_id=$3)', [rentals.id, action, entity ?? null]);

  // --- Kits ---------------------------------------------------------------------------------------------------
  let poles, cloth, shamiana, stage, classTents;
  await t.test('kits: a kit books its parts, never more than a pool has even when two are saved at once, billed as itself or by its parts', async () => {
    let list = await request('POST', R('rentals/classes'), { name: 'Tents', checklist: ['Canvas clean', 'No tears'] }, 201);
    classTents = list.classes.find((k) => k.name === 'Tents');
    assert.deepEqual(classTents.checklist, ['Canvas clean', 'No tears']);
    assert.equal((await refused('POST', R('rentals/classes'), { name: 'tents' })).status, 409);
    assert.equal((await refused('POST', R('rentals/classes'), { name: 'Sheds' }, desk.token)).status, 403);
    assert.ok(await audited('rental_class.created', classTents.id));
    poles = await item('Tent poles', { kind: 'pool', poolQuantity: '40', rates: { day: '50' }, latePer: 'none' });
    cloth = await item('Tent cloth', { kind: 'pool', poolQuantity: '10', rates: { day: '400' }, latePer: 'none', classId: classTents.id });
    const gen = await item('Lamp stand', { kind: 'unit', rates: { day: '100' }, units: [{ label: 'Lamp 1' }] });
    // What a kit is made of: items from a pool, each once; billed as the kit (its own rates) or by its parts.
    const bad = (body) => refused('POST', R('rentals/items'), { item: { name: `Bad kit ${crypto.randomBytes(2).toString('hex')}` }, kind: 'kit', ...body });
    assert.match((await bad({ kitBilling: 'kit', rates: { day: '10' }, parts: [{ itemId: gen.id, quantity: '1' }] })).message, /is hired one by one: a kit's parts are items from a pool/);
    assert.match((await bad({ kitBilling: 'kit', parts: [{ itemId: poles.id, quantity: '1' }] })).message, /A kit billed as itself has its own rates/);
    assert.match((await bad({ kitBilling: 'parts', parts: [] })).message, /at least one part/);
    assert.match((await bad({ kitBilling: 'parts', parts: [{ itemId: poles.id, quantity: '1' }, { itemId: poles.id, quantity: '2' }] })).message, /Name each part once/);
    shamiana = await item('Shamiana 20x40', { kind: 'kit', kitBilling: 'kit', rates: { day: '2000' }, deposit: '1000',
      parts: [{ itemId: poles.id, quantity: '8' }, { itemId: cloth.id, quantity: '2' }] });
    stage = await item('Stage set', { kind: 'kit', kitBilling: 'parts', parts: [{ itemId: poles.id, quantity: '4' }] });
    assert.deepEqual([shamiana.kind, shamiana.kit_billing, shamiana.late_per, shamiana.parts.map((p) => [p.name, p.quantity])],
      ['kit', 'kit', 'none', [['Tent cloth', 2], ['Tent poles', 8]]]);
    assert.deepEqual([stage.kit_billing, stage.rate_day], ['parts', null]);
    // 3 kits for a day: the kit's own rate (6,000 + 18% = 7,080), 24 poles and 6 cloths held, a deposit of 3,000.
    const times = { outAt: `${tomorrow}T08:00`, dueAt: `${tomorrow}T20:00` };
    const p = await request('POST', R('rentals/bookings/preview'), { locationId: yard.id, ...times, lines: [{ itemId: shamiana.id, quantity: '3' }] });
    assert.deepEqual([p.lines[0].amount, p.lines[0].billed, p.lines[0].kitBilling, p.total, p.deposit, p.free], ['6000.00', true, 'kit', '7080.00', '3000.00', true]);
    assert.deepEqual(p.lines[0].parts.map((x) => [x.itemName, x.quantity, x.billed, x.amount, x.free]), [['Tent poles', 24, false, '0.00', true], ['Tent cloth', 6, false, '0.00', true]]);
    const a = await book({ ...times, lines: [{ itemId: shamiana.id, quantity: '3' }] });
    assert.deepEqual(a.lines.map((l) => [l.item_name, Number(l.quantity), l.billed, l.part_quantity, l.kit_line_id === null]),
      [['Shamiana 20x40', 3, true, null, true], ['Tent poles', 24, false, 8, false], ['Tent cloth', 6, false, 2, false]]);
    assert.equal(a.items, undefined);
    const listed = (await request('GET', R('rentals/bookings/open'))).items.find((x) => x.id === a.id);
    assert.equal(listed.items, '3 × Shamiana 20x40', 'the board names the kit, not its parts');
    // Two bookings of 2 kits saved at the same moment: 16 poles are left, so one is booked and the other refused.
    const race = () => call('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: hirer.id, ...times, lines: [{ itemId: shamiana.id, quantity: '2' }] }, ownerToken);
    const results = await Promise.all([race(), race()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.match(results.find((r) => r.status === 409).body.message, /^Only 0 of the 40 Tent poles are free from .+: 40 are booked then$/);
    const preview = await request('POST', R('rentals/bookings/preview'), { locationId: yard.id, ...times, lines: [{ itemId: shamiana.id, quantity: '1' }] });
    assert.deepEqual([preview.free, preview.lines[0].free], [false, false]);
    assert.match(preview.lines[0].words, /^Shamiana 20x40: Only 0 of the 40 Tent poles are free then/);
    // The database refuses a part that is not as many as the kit has of it.
    const kitLine = a.lines[0];
    await assert.rejects(rows(`INSERT INTO rental_booking_lines(business_id,booking_id,seq,item_id,sku_id,item_name,quantity,min_hours,buffer_minutes,grace_minutes,late_per,deposit_each,
        charged_hours,price,amount,tax_rate,net,tax,kit_line_id,part_quantity,billed) VALUES($1,$2,9,$3,$4,'Tent poles',5,0,0,0,'none',0,1,0,0,18,0,0,$5,8,FALSE)`,
    [rentals.id, a.id, poles.id, poles.sku_id, kitLine.id]), /A kit's part goes on the booking with its kit, as many as the kit has of it/);
    // A kit billed by its parts: the parts' lines carry the hire (8 poles for a day: 400 + 72 = 472); the kit's line nothing.
    const b = await book({ outAt: `${addDays(today, 3)}T08:00`, dueAt: `${addDays(today, 3)}T20:00`, lines: [{ itemId: stage.id, quantity: '2' }] });
    assert.deepEqual([b.total, b.lines[0].amount, b.lines[0].billed, b.lines[1].amount, b.lines[1].billed], ['472.00', '0.00', false, '400.00', true]);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='rental_booking.created' AND entity_id=$2", [rentals.id, a.id]));
  });

  let kitOut;
  await t.test('a kit goes out and comes back by its parts, each checked against its class\'s checklist; the bill has the kit\'s own line', async () => {
    kitOut = await book({ outAt: minute(), dueAt: minute(240), lines: [{ itemId: shamiana.id, quantity: '1' }] });
    const [kit, polesLine, clothLine] = kitOut.lines;
    const deposit = { amount: '1000', method: 'cash' };
    assert.match((await handOver(kitOut, { deposit })).body.message, /check Tent cloth against its checklist \(Canvas clean, No tears\)/);
    const checks = (ok) => [{ point: 'Canvas clean', ok: true }, { point: 'No tears', ok, ...(ok ? {} : { note: 'Small tear near the eyelet' }) }];
    assert.match((await handOver(kitOut, { deposit, lines: [{ lineId: clothLine.id, checks: [{ point: 'Canvas clean', ok: true }, { point: 'No tears', ok: false }] }] })).body.message,
      /say what is wrong with No tears/);
    assert.match((await handOver(kitOut, { deposit, lines: [{ lineId: clothLine.id, checks: [{ point: 'Canvas clean', ok: true }] }] })).body.message, /check No tears on Tent cloth/);
    const out = await handOver(kitOut, { deposit, lines: [{ lineId: clothLine.id, checks: checks(false) }] });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.data.conditions.map((x) => [x.stage, x.line_id, x.checks[1].ok, x.checks[1].note]), [['out', clothLine.id, false, 'Small tear near the eyelet']]);
    const B = (suffix) => R(`rentals/bookings/${kitOut.id}${suffix}`);
    // The kit comes back by its parts: its own line is refused.
    assert.match((await refused('POST', B('/returns'), { requestKey: key(), lines: [{ lineId: kit.id }] })).message, /is a kit: its parts come back, each on its own line/);
    let now = await request('POST', B('/returns'), { requestKey: key(), lines: [{ lineId: polesLine.id, quantity: '8' }] }, 201);
    assert.deepEqual([now.status, now.document_id], ['out', null]);
    assert.match((await refused('POST', B('/returns'), { requestKey: key(), lines: [{ lineId: clothLine.id }] })).message, /check Tent cloth against its checklist/);
    now = await request('POST', B('/returns'), { requestKey: key(), lines: [{ lineId: clothLine.id, checks: checks(true) }] }, 201);
    assert.equal(now.status, 'returned');
    const bill = await request('GET', R(`documents/${now.document_id}`));
    assert.deepEqual(bill.lines.map((l) => [l.label, l.quantity, l.net, l.tax]), [['Hire for 1 day · Shamiana 20x40', '1.000', '2000.00', '360.00']]);
    assert.equal(bill.total, '2360.00');
    assert.deepEqual(now.conditions.map((x) => x.stage), ['out', 'in']);
    await assert.rejects(rows('UPDATE rental_conditions SET checks=$2 WHERE booking_id=$1', [kitOut.id, '[]']), /A checklist is kept as it was checked/);
  });

  // --- The fleet: vehicles, the register, papers, kilometres and fuel -----------------------------------------
  let hatch, scooter, swift, innova, activa, swiftOut, activaOut;
  const register = { address: '12-3-45, Ameerpet, Hyderabad 500016', licenceAuthority: 'RTA Khairatabad', licenceClasses: ['LMV', 'MCWG'], licenceIssuedOn: '2019-06-12' };
  await t.test('vehicles keep their class, engine, length, fuel and papers; their slab is checked against the item\'s', async () => {
    hatch = await item('Hatchback self-drive', { kind: 'unit', vehicle: 'car', rates: { day: '1500' }, latePer: 'none',
      km: { allowance: '100', per: 'day', rate: '12' }, fuel: { per: 'eighth', rate: '300' },
      units: [{ label: 'Swift 1', serialNo: 'TS09EA1111', meterReading: '25000' }, { label: 'Innova 9', serialNo: 'TS09EA2222', meterReading: '40000' }] });
    assert.deepEqual([hatch.km_allowance, hatch.km_per, hatch.extra_km_rate, hatch.fuel_per, hatch.fuel_rate], [100, 'day', '12.00', 'eighth', '300.00']);
    assert.match((await refused('POST', R('rentals/items'), { item: { name: 'Bad fuel' }, kind: 'pool', poolQuantity: '1', rates: { day: '1' }, fuel: { per: 'eighth', rate: '1' } })).message,
      /A fuel charge is for a vehicle/);
    assert.match((await refused('POST', R('rentals/items'), { item: { name: 'Bad litre' }, kind: 'unit', vehicle: 'car', rates: { day: '1' }, fuel: { per: 'litre', rate: '100' } })).message,
      /tank's size in litres/);
    scooter = await item('Scooter self-drive', { kind: 'unit', vehicle: 'motorcycle', rates: { day: '400' }, latePer: 'none',
      km: { allowance: '50', per: 'booking', rate: '4' }, fuel: { per: 'litre', rate: '101.25', tankLitres: '5.5' }, units: [{ label: 'Activa 1', serialNo: 'TS09EB3333', meterReading: '1000' }] });
    swift = hatch.units.find((u) => u.label === 'Swift 1');
    innova = hatch.units.find((u) => u.label === 'Innova 9');
    [activa] = scooter.units;
    const facts = (unit, body) => request('PATCH', R(`rentals/units/${unit.id}`), body);
    await facts(swift, { vehicleClass: 'LMV', engineCc: '1197', lengthMm: '3995', fuelType: 'petrol', insuranceValidUntil: addDays(today, 20), pucValidUntil: addDays(today, 5) });
    let list = await facts(innova, { vehicleClass: 'LMV', engineCc: '2393', lengthMm: '4735', fuelType: 'diesel', fitnessValidUntil: addDays(today, -1) });
    await facts(activa, { vehicleClass: 'MCWOG', engineCc: '110', fuelType: 'petrol' });
    list = await request('GET', R('rentals/items'));
    const unitOf = (u) => list.items.flatMap((i) => i.units).find((x) => x.id === u.id);
    assert.deepEqual([unitOf(swift).slab, unitOf(swift).slab_matches, unitOf(innova).slab, unitOf(innova).slab_matches, unitOf(activa).slab], [18, true, 40, false, 18]);
    assert.ok(list.warnings.some((w) => /^Innova 9's engine, length and fuel make renting it out 40% \(the like goods' rate\), but Hatchback self-drive is billed at 18%/.test(w)));
    assert.match((await refused('PATCH', R(`rentals/units/${swift.id}`), { vehicleClass: 'BUS' })).message, /must be one of/);
    assert.match((await refused('PATCH', R(`rentals/units/${(await item('Chairs plain', { kind: 'unit', rates: { day: '1' }, units: [{ label: 'C1' }] })).units[0].id}`),
      { engineCc: '100' })).message, /is not a vehicle/);
    assert.equal((await refused('PATCH', R(`rentals/units/${swift.id}`), { engineCc: '1200' }, desk.token)).status, 403);
    assert.ok(await audited('rental_unit.updated', swift.id));
    // Self-drive hire needs the State Transport Authority's licences of the location.
    await request('PUT', R('modules/licences'), { enabled: true });
    for (const [kind, name] of [['rent_a_cab', 'Rent a cab'], ['rent_a_motorcycle', 'Rent a motorcycle']]) {
      await request('POST', R('licences'), { locationId: yard.id, kind, name, licenceNo: `STA/${kind}/77`, authority: 'State Transport Authority', validFrom: addDays(today, -30),
        validUntil: addDays(today, 1795) }, 201);
    }
  });

  await t.test('the hirer register: the licence\'s authority, classes and issue date, a foreigner\'s passport, permit and visa; a class that does not cover the vehicle refused', async () => {
    swiftOut = await book({ outAt: minute(), dueAt: minute(24 * 60), lines: [{ itemId: hatch.id, unitId: swift.id }] });
    const car = (body) => handOver(swiftOut, { licenceNo: 'TS0920190001234', licenceValidUntil: addDays(today, 900),
      lines: [{ lineId: swiftOut.lines[0].id, meter: '25000', fuel: 'full' }], ...body });
    assert.match((await car({})).body.message, /goes in the hirer register: give the hirer's full address, and the licence's issuing authority, classes of vehicle and issue date/);
    const wrong = await car({ register: { ...register, licenceClasses: ['MCWG'] } });
    assert.deepEqual([wrong.status, wrong.body.message], [409, 'Swift 1 is a LMV vehicle (Light motor vehicle): the hirer\'s licence covers MCWG, not it']);
    assert.match((await car({ register: { ...register, licenceClasses: ['XYZ'] } })).body.message, /XYZ is not a class of vehicle a licence names/);
    const out = await car({ register, originalHeld: 'Driving licence' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([out.body.data.hirer.address, out.body.data.hirer.licence_classes, out.body.data.hirer.licence_issued_on, out.body.data.hirer.original_held],
      [register.address, ['LMV', 'MCWG'], '2019-06-12', 'Driving licence']);
    // A foreign national (Form 4): the passport, date of birth, driving permit and visa; the permit's classes cover the scooter.
    activaOut = await book({ contactId: guest.id, outAt: minute(), dueAt: minute(6 * 60), lines: [{ itemId: scooter.id, unitId: activa.id }] });
    const foreign = { address: 'Hotel Taj Banjara, Hyderabad', licenceAuthority: 'Landratsamt München', licenceIssuedOn: '2015-03-02', foreigner: true,
      passportNo: 'c01x00t47', passportAuthority: 'Stadt München', passportNation: 'Germany', passportIssuedOn: '2020-01-15', passportValidUntil: addDays(today, 1500),
      birthDate: '1990-07-04', permitNo: 'IDP-778899', permitIssuedOn: '2026-01-10', permitClasses: ['MCWOG', 'LMV'], visaNo: 'VT1234567', visaValidUntil: addDays(today, 60) };
    const scoot = (body) => handOver(activaOut, { idKind: 'passport', idRef: 'C01X00T47', licenceNo: 'DE-B072-RM-55', licenceValidUntil: addDays(today, 3000),
      lines: [{ lineId: activaOut.lines[0].id, meter: '1000', fuel: 'full' }], ...body });
    assert.match((await scoot({ register: { ...foreign, passportNo: undefined } })).body.message, /A foreign national's register keeps the passport number/);
    assert.match((await scoot({ register: { ...foreign, passportValidUntil: addDays(today, -2) } })).body.message, /The passport C01X00T47 ran out on/);
    const went = await scoot({ register: foreign, originalHeld: 'Passport' });
    assert.equal(went.status, 200, JSON.stringify(went.body));
    assert.deepEqual([went.body.data.hirer.foreigner, went.body.data.hirer.passport_no, went.body.data.hirer.permit_classes], [true, 'C01X00T47', ['MCWOG', 'LMV']]);
    // The register is kept as it was written; the original document goes back once.
    await assert.rejects(rows("UPDATE rental_hirers SET address='Elsewhere' WHERE booking_id=$1", [swiftOut.id]), /The hirer register is kept as it was written/);
    let back = await request('POST', R(`rentals/bookings/${activaOut.id}/original-back`), {});
    assert.ok(back.hirer.original_returned_at);
    back = await request('POST', R(`rentals/bookings/${activaOut.id}/original-back`), {});
    assert.equal((await one('SELECT count(*)::int AS n FROM business_audit WHERE action=$1 AND entity_id=$2', ['rental_booking.original_returned', activaOut.id])).n, 1);
    assert.equal((await refused('POST', R(`rentals/bookings/${kitOut.id}/original-back`), {})).status, 409);
  });

  await t.test('vehicle papers: the bell at 30 and 7 days and once run out; a vehicle with one run out refused, or warned about as the shop sets it', async () => {
    const innovaOut = await book({ outAt: minute(), dueAt: minute(600), lines: [{ itemId: hatch.id, unitId: innova.id }] });
    const go = () => handOver(innovaOut, { licenceNo: 'TS0920190001234', licenceValidUntil: addDays(today, 900), register,
      lines: [{ lineId: innovaOut.lines[0].id, meter: '40000', fuel: 'full' }] });
    const stopped = await go();
    assert.deepEqual([stopped.status, /^Innova 9's fitness certificate ran out on .+: renew it, or hand over another vehicle$/.test(stopped.body.message)], [409, true]);
    assert.match((await refused('PUT', R('rentals/settings'), { papersWarnDays: '7', papersUrgentDays: '7' })).message, /Warn again closer to the date/);
    const settings = await request('PUT', R('rentals/settings'), { papersLapsed: 'warn' });
    assert.deepEqual([settings.papersWarnDays, settings.papersUrgentDays, settings.papersLapsed], [30, 7, 'warn']);
    const went = await go();
    assert.equal(went.status, 200, JSON.stringify(went.body));
    assert.equal(went.body.data.warnings.length, 1);
    assert.match(went.body.data.events.at(-1).note, /warned: Innova 9's fitness certificate ran out on/);
    await request('PUT', R('rentals/settings'), { papersLapsed: 'refuse' });
    const bell = (await request('GET', R('notifications'))).items.filter((n) => n.category === 'Fleet');
    const find = (re) => bell.find((n) => re.test(n.title));
    assert.equal(find(/^Swift 1's insurance runs out on/)?.severity, 'info');
    assert.equal(find(/^Swift 1's PUC certificate runs out on/)?.severity, 'warning');
    assert.equal(find(/^Innova 9's fitness certificate ran out on/)?.severity, 'critical');
    await request('POST', R(`rentals/bookings/${innovaOut.id}/returns`), { requestKey: key(), lines: [{ lineId: innovaOut.lines[0].id, meter: '40010', fuel: 'full' }] }, 201);
  });

  await t.test('kilometres and fuel at the return: beyond the allowance at the extra rate, the fuel short by the eighth or the litre, billed to the paisa; the register printed', async () => {
    // The car, a day: 180.5 km against 100 free is 81 km at 12 (972.00); full out, five eighths back is 3 eighths at 300 (900.00).
    const S = (suffix) => R(`rentals/bookings/${swiftOut.id}${suffix}`);
    const body = { requestKey: key(), lines: [{ lineId: swiftOut.lines[0].id, meter: '25180.5', fuel: 'five_eighths', note: 'Mud on the mats' }], originalReturned: true };
    const plan = await request('POST', S('/returns/preview'), body);
    assert.deepEqual([plan.lines[0].extraKm, plan.lines[0].kmFee, plan.lines[0].fuelShort, plan.lines[0].fuelFee, plan.kmFee, plan.fuelFee], [81, '972.00', 3, '900.00', '972.00', '900.00']);
    assert.deepEqual(plan.bill.map((x) => [x.label, x.net, x.tax]), [['Hire for 1 day · Hatchback self-drive · Swift 1 (TS09EA1111)', '1500.00', '270.00'],
      ['Extra kilometres, 81 km · Hatchback self-drive · Swift 1 (TS09EA1111)', '972.00', '174.96'],
      ['Fuel, 3 eighths of the tank short · Hatchback self-drive · Swift 1 (TS09EA1111)', '900.00', '162.00']]);
    assert.equal(plan.total, '3978.96');
    const back = await request('POST', S('/returns'), body, 201);
    assert.deepEqual([back.status, back.returns[0].lines[0].extra_km, back.returns[0].lines[0].km_fee, back.returns[0].lines[0].fuel_short, back.returns[0].lines[0].fuel_fee],
      ['returned', 81, '972.00', 3, '900.00']);
    assert.ok(back.hirer.original_returned_at, 'the original licence went back with the car');
    const bill = await request('GET', R(`documents/${back.document_id}`));
    assert.deepEqual([bill.subtotal, bill.tax, bill.total], ['3372.00', '606.96', '3978.96']);
    assert.equal(paise(bill.subtotal) + paise(bill.tax), paise(bill.total));
    const fees = await one('SELECT km_line_id,fuel_line_id FROM rental_return_lines WHERE line_id=$1', [swiftOut.lines[0].id]);
    assert.ok(fees.km_line_id && fees.fuel_line_id, 'each fee is a bill line of its own');
    // The scooter, by the booking: 62.3 km against 50 free is 13 km at 4 (52.00); 5 eighths short of a 5.5-litre tank at 101.25 a litre is 348.05.
    const A = (suffix) => R(`rentals/bookings/${activaOut.id}${suffix}`);
    const scoot = await request('POST', A('/returns'), { requestKey: key(), lines: [{ lineId: activaOut.lines[0].id, meter: '1062.3', fuel: 'three_eighths' }] }, 201);
    assert.deepEqual([scoot.returns[0].lines[0].extra_km, scoot.returns[0].lines[0].km_fee, scoot.returns[0].lines[0].fuel_short, scoot.returns[0].lines[0].fuel_fee],
      [13, '52.00', 5, '348.05']);
    // The database works the charges out again: a typed one is refused.
    await assert.rejects(rows('UPDATE rental_return_lines SET km_fee=1 WHERE line_id=$1', [activaOut.lines[0].id]), /A return is kept as it was taken/);
    // The register as the forms list it: the car on Form 5, the foreign national's scooter on Form 4.
    const printed = await yardHand.call('GET', R(`rentals/register?from=${today}&to=${today}`));
    const car = printed.vehicles.find((v) => v.label === 'Swift 1');
    assert.deepEqual([car.form, car.foreignForm, car.scheme, car.rows.length], ['Form 5', 'Form 6', 'Rent a Cab Scheme, 1989', 1]);
    const row = car.rows[0];
    assert.deepEqual([row.name, row.address, row.telephone, row.licence.number, row.licence.authority, row.licence.classes, row.licence.issuedOn, row.licence.validUntil, row.totalKm,
      row.remarks, row.originalHeld], ['Kiran Kumar', register.address, '9876500601', 'TS0920190001234', 'RTA Khairatabad', ['LMV', 'MCWG'], '2019-06-12', addDays(today, 900), 180.5,
      'Mud on the mats', 'Driving licence']);
    assert.ok(row.hiredAt && row.returnedAt);
    const bike = printed.vehicles.find((v) => v.label === 'Activa 1');
    assert.deepEqual([bike.form, bike.foreignForm, bike.rows.length, bike.foreignRows.length], ['Form 3', 'Form 4', 0, 1]);
    const f = bike.foreignRows[0];
    assert.deepEqual([f.passport.number, f.passport.nation, f.birthDate, f.permit.number, f.permit.classes, f.visa.number, f.totalKm],
      ['C01X00T47', 'Germany', '1990-07-04', 'IDP-778899', ['MCWOG', 'LMV'], 'VT1234567', 62.3]);
    assert.equal((await refused('GET', R('rentals/register'), undefined, viewer.token)).status, 403, 'the register is printed by those who print');
  });

  // --- Late slabs and cancellation slabs ----------------------------------------------------------------------
  let cycles, twoWheelers;
  await t.test('late fee slabs with a cap, from the item\'s class: the slab the hours late fall in prices all of them', async () => {
    const list = await request('POST', R('rentals/classes'), { name: 'Two-wheelers', lateSlabs: [{ from: 0, flat: '100', times: '2' }, { from: '3', flat: '0', times: '5' }], lateCap: '1000' }, 201);
    twoWheelers = list.classes.find((k) => k.name === 'Two-wheelers');
    assert.deepEqual(twoWheelers.late_slabs, [{ from: 0, flat: 100, times: 2 }, { from: 3, flat: 0, times: 5 }]);
    assert.match((await refused('POST', R('rentals/classes'), { name: 'Bad slabs', lateSlabs: [{ from: 0, flat: '0', times: '0' }] })).message, /give a flat amount, a multiple/);
    assert.match((await refused('POST', R('rentals/classes'), { name: 'Bad order', lateSlabs: [{ flat: '10' }, { from: '3', flat: '1' }, { from: '2', flat: '1' }] })).message,
      /starts at more hours late than the one before/);
    assert.match((await refused('POST', R('rentals/items'), { item: { name: 'No slabs' }, kind: 'pool', poolQuantity: '1', rates: { hour: '10' }, latePer: 'slabs' })).message,
      /Give the late fee slabs, or put the item in a class that has them/);
    cycles = await item('Pedal cycle', { kind: 'pool', poolQuantity: '10', rates: { hour: '60', day: '400' }, graceMinutes: '30', latePer: 'slabs', classId: twoWheelers.id });
    assert.deepEqual([cycles.late_per, cycles.late_slabs, cycles.class_name], ['slabs', null, 'Two-wheelers']);
    // 2 cycles 2 hours 10 minutes late: 3 hours, the first slab: 100 + 2 × 60 × 3 = 460 each, 920.
    const first = await book({ outAt: minute(), dueAt: minute(60), lines: [{ itemId: cycles.id, quantity: '2' }] });
    assert.deepEqual([first.lines[0].late_per, first.lines[0].late_slabs, first.lines[0].late_cap, first.lines[0].late_rate], ['slabs', twoWheelers.late_slabs, '1000.00', '60.00']);
    assert.equal((await handOver(first)).status, 200);
    await backdate(first.id, 190);
    let plan = await request('POST', R(`rentals/bookings/${first.id}/returns/preview`), { lines: [{ lineId: first.lines[0].id, quantity: '2' }] });
    assert.deepEqual([plan.lines[0].lateUnits, plan.lines[0].lateFee], [3, '920.00']);
    let back = await request('POST', R(`rentals/bookings/${first.id}/returns`), { requestKey: key(), lines: [{ lineId: first.lines[0].id, quantity: '2' }] }, 201);
    assert.deepEqual([back.returns[0].lines[0].late_units, back.returns[0].lines[0].late_fee], [3, '920.00']);
    // 1 cycle 5 hours late: the second slab, 5 × 60 × 5 = 1,500, held to the cap of 1,000.
    const second = await book({ outAt: minute(), dueAt: minute(60), lines: [{ itemId: cycles.id, quantity: '1' }] });
    assert.equal((await handOver(second)).status, 200);
    await backdate(second.id, 60 + 290);
    plan = await request('POST', R(`rentals/bookings/${second.id}/returns/preview`), { lines: [{ lineId: second.lines[0].id }] });
    assert.deepEqual([plan.lines[0].lateUnits, plan.lines[0].lateFee], [5, '1000.00']);
    back = await request('POST', R(`rentals/bookings/${second.id}/returns`), { requestKey: key(), lines: [{ lineId: second.lines[0].id }] }, 201);
    const bill = await request('GET', R(`documents/${back.document_id}`));
    assert.deepEqual(bill.lines.map((l) => [l.label, l.net]), [['Hire for 1 hour · Pedal cycle', '60.00'], ['Late return, 5 hours · Pedal cycle', '1000.00']]);
  });

  await t.test('cancellation slabs: the charge worked out from the hours before the out time, not typed; a manager\'s waiver kept and audited; a no-show', async () => {
    assert.match((await refused('PUT', R('rentals/settings'), { cancelSlabs: [{ hours: '24', percent: '25' }, { hours: '24', percent: '50' }] })).message, /different hours/);
    const settings = await request('PUT', R('rentals/settings'), { cancelSlabs: [{ hours: '6', percent: '50' }, { hours: '72', percent: '10' }, { hours: '0', percent: '75' },
      { hours: '24', percent: '25' }], noShowPercent: '100' });
    assert.deepEqual(settings.cancelSlabs.map((s) => [s.hours, s.percent]), [[72, 10], [24, 25], [6, 50], [0, 75]]);
    assert.equal(settings.noShowPercent, 100);
    const day = (offset) => ({ outAt: minute(offset), dueAt: minute(offset + 24 * 60) });
    // 30 hours before: 25% of 3 cycles for a day (1,200): 300 + 18% = 354.
    const x = await book({ ...day(30 * 60), lines: [{ itemId: cycles.id, quantity: '3' }] });
    const preview = await request('GET', R(`rentals/bookings/${x.id}/cancel/preview`));
    assert.deepEqual([preview.worked, preview.percent, preview.charge, preview.total, preview.noShow], [true, '25.00', '300.00', '354.00', false]);
    assert.ok(preview.hoursBefore > 29.9 && preview.hoursBefore <= 30, `${preview.hoursBefore} hours before the out time`);
    assert.match((await refused('POST', R(`rentals/bookings/${x.id}/cancel`), { requestKey: key(), reason: 'Trip off', charges: [{ lineId: x.lines[0].id, amount: '10' }] })).message,
      /worked out from the shop's cancellation slabs: it is not typed/);
    const body = { requestKey: key(), reason: 'Trip off' };
    let now = await request('POST', R(`rentals/bookings/${x.id}/cancel`), body);
    assert.equal((await request('POST', R(`rentals/bookings/${x.id}/cancel`), body)).document_id, now.document_id, 'asking again is the same cancellation');
    const bill = await request('GET', R(`documents/${now.document_id}`));
    assert.deepEqual([bill.lines[0].label, bill.lines[0].net, bill.lines[0].tax, bill.total], ['Cancellation charge · 25% of the hire · Pedal cycle', '300.00', '54.00', '354.00']);
    assert.deepEqual([now.cancellation.percent, now.cancellation.worked_out, now.cancellation.charged, now.cancellation.waiver], ['25.00', '300.00', '300.00', null]);
    // 80 hours before: 10% (120), waived by a manager with the reason: no bill, the waiver kept and audited. A cashier does not cancel.
    const y = await book({ ...day(80 * 60), lines: [{ itemId: cycles.id, quantity: '3' }] });
    assert.equal((await refused('POST', R(`rentals/bookings/${y.id}/cancel`), { requestKey: key(), reason: 'Rain' }, desk.token)).status, 403);
    assert.equal((await refused('POST', R(`rentals/bookings/${y.id}/cancel`), { requestKey: key(), reason: 'Rain', waive: { reason: 'Regular customer', approverId: ownerUser.id } },
      manager.token)).data?.reason, 'approval_needed', 'someone else\'s say-so needs their PIN');
    now = await manager.call('POST', R(`rentals/bookings/${y.id}/cancel`), { requestKey: key(), reason: 'Rain', waive: { reason: 'Regular customer', approverId: ownerUser.id, pin: '2468' } });
    assert.deepEqual([now.status, now.document_id, now.cancellation.worked_out, now.cancellation.charged, now.cancellation.waiver, now.cancellation.waived_by_name],
      ['cancelled', null, '120.00', '0.00', 'Regular customer', 'more-owner']);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE action='rental_booking.cancellation_waived' AND entity_id=$1 AND actor_id=$2", [y.id, ownerUser.id]));
    await assert.rejects(rows('UPDATE rental_cancellations SET charged=0 WHERE booking_id=$1', [x.id]), /kept as it was worked out/);
    // Past its out time and not handed over: a no-show, 100%.
    const z = await book({ ...day(0), lines: [{ itemId: cycles.id, quantity: '3' }] });
    now = await request('POST', R(`rentals/bookings/${z.id}/cancel`), { requestKey: key(), reason: 'Did not come' });
    assert.deepEqual([now.cancellation.percent, now.cancellation.worked_out], ['100.00', '1200.00']);
    // A quote is cancelled with nothing worked out, and nothing to waive.
    const q = await book({ status: 'quote', ...day(60), lines: [{ itemId: cycles.id, quantity: '1' }] });
    assert.equal((await refused('POST', R(`rentals/bookings/${q.id}/cancel`), { requestKey: key(), reason: 'No', waive: { reason: 'x' } })).status, 409);
    assert.equal((await request('POST', R(`rentals/bookings/${q.id}/cancel`), { requestKey: key(), reason: 'No' })).cancellation, null);
  });

  // --- Locations -----------------------------------------------------------------------------------------------
  await t.test('pools are counted at each location and units kept at one; transfers recorded with their dates; what is free is by location', async () => {
    const branch = await request('POST', R('locations'), { name: 'Kukatpally branch', code: 'KPHB' }, 201);
    const chairs = await item('Chairs', { kind: 'pool', poolQuantity: '100', rates: { day: '10' } });
    assert.deepEqual(chairs.counts.map((x) => [x.location_id, x.quantity]), [[yard.id, 100]]);
    const move = { requestKey: key(), itemId: chairs.id, quantity: '30', fromLocationId: yard.id, toLocationId: branch.id, note: 'For the Kukatpally wedding season' };
    let yardNow = await request('POST', R('rentals/transfers'), move, 201);
    assert.deepEqual(yardNow.pools.find((p) => p.id === chairs.id).counts.map((x) => x.quantity), [70, 30]);
    assert.equal((await request('POST', R('rentals/transfers'), move, 201)).transfers.filter((x) => x.item_id === chairs.id).length, 1, 'a retry is the same transfer');
    assert.equal((await refused('POST', R('rentals/transfers'), { ...move, quantity: '31' })).status, 409);
    assert.equal((await refused('POST', R('rentals/transfers'), { ...move, requestKey: key() }, viewer.token)).status, 403);
    assert.equal((await one('SELECT pool_quantity FROM rental_items WHERE id=$1', [chairs.id])).pool_quantity, 100, 'the item keeps the total');
    // What is free at the branch is the branch's: 30.
    const there = await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: branch.id, contactId: hirer.id, outAt: `${tomorrow}T09:00`, dueAt: `${tomorrow}T21:00`,
      lines: [{ itemId: chairs.id, quantity: '40' }] });
    assert.deepEqual([there.status, /^Only 30 of the 30 Chairs are free from .+ at Kukatpally branch: 0 are booked then$/.test(there.message)], [409, true]);
    const free = await request('GET', R(`rentals/free?outAt=${encodeURIComponent(`${tomorrow}T09:00`)}&dueAt=${encodeURIComponent(`${tomorrow}T21:00`)}&location=${branch.id}`));
    assert.equal(free.items.find((i) => i.itemId === chairs.id).free, 30);
    await book({ outAt: `${tomorrow}T09:00`, dueAt: `${tomorrow}T21:00`, lines: [{ itemId: chairs.id, quantity: '70' }] });
    assert.match((await refused('POST', R('rentals/transfers'), { ...move, requestKey: key(), quantity: '10' })).message, /Bookings at .+ hold 70 of Chairs at their busiest from now on: at most 0 can move/);
    // A pool's count is set location by location.
    assert.match((await refused('PATCH', R(`rentals/items/${chairs.id}`), { poolQuantity: '50' })).message, /Say which location's count this is/);
    const list = await request('PATCH', R(`rentals/items/${chairs.id}`), { poolQuantity: '50', locationId: branch.id });
    assert.deepEqual(list.items.find((i) => i.id === chairs.id).counts.map((x) => x.quantity), [70, 50]);
    await assert.rejects(rows('UPDATE rental_items SET pool_quantity=5 WHERE id=$1', [chairs.id]), /A pool is counted at each location/);
    // A unit moves by a transfer, not while it is booked; it is then booked where it is kept.
    const gens = await item('Genset 5 kVA', { kind: 'unit', meter: 'hours', rates: { day: '900' }, units: [{ label: 'G5-1', serialNo: 'G5A' }, { label: 'G5-2', serialNo: 'G5B' }] });
    const g1 = gens.units.find((u) => u.label === 'G5-1'), g2 = gens.units.find((u) => u.label === 'G5-2');
    await book({ outAt: `${tomorrow}T09:00`, dueAt: `${tomorrow}T21:00`, lines: [{ itemId: gens.id, unitId: g1.id }] });
    assert.match((await refused('POST', R('rentals/transfers'), { requestKey: key(), itemId: gens.id, unitId: g1.id, toLocationId: branch.id })).message, /G5-1 is booked on RN\/.+: it moves once/);
    yardNow = await request('POST', R('rentals/transfers'), { requestKey: key(), itemId: gens.id, unitId: g2.id, toLocationId: branch.id }, 201);
    assert.equal(yardNow.units.find((u) => u.id === g2.id).location_name, 'Kukatpally branch');
    const kept = await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: hirer.id, outAt: `${tomorrow}T09:00`, dueAt: `${tomorrow}T21:00`,
      lines: [{ itemId: gens.id, unitId: g2.id }] });
    assert.deepEqual([kept.status, kept.message], [409, 'G5-2 (Genset 5 kVA) is kept at Kukatpally branch: book it there, or move it here first']);
    await book({ locationId: branch.id, outAt: `${tomorrow}T09:00`, dueAt: `${tomorrow}T21:00`, lines: [{ itemId: gens.id, unitId: g2.id }] });
    await assert.rejects(rows('UPDATE rental_units SET location_id=$2 WHERE id=$1', [g2.id, yard.id]), /G5-2 moves to another location by a transfer/);
    await assert.rejects(rows("UPDATE rental_transfers SET note='x' WHERE item_id=$1", [chairs.id]), /A transfer is kept as it was written/);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='rental_transfer.made'", [rentals.id]));
    assert.ok(await audited('rental_transfer.made'));
  });

  // --- Photos, signatures, scanning, maintenance -------------------------------------------------------------------
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2A0D5D10000000049454E44AE426082', 'hex');
  const upload = async (fields, bytes = png, name = 'photo.png', token = ownerToken) => {
    const form = new FormData();
    for (const [field, value] of Object.entries(fields)) form.append(field, String(value));
    form.append('file', new Blob([bytes], { type: 'image/png' }), name);
    const response = await fetch(`${base}${R('rentals/files')}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  let lamps, gs1, gs2, scanned;
  await t.test('scanning: a unit\'s barcode or serial at the handover and the return, a unit not on the booking refused; photos and signatures kept', async () => {
    lamps = await item('Genset 10 kVA', { kind: 'unit', meter: 'hours', rates: { day: '1200' }, units: [{ label: 'GS-1', serialNo: 'GS-101', meterReading: '500' },
      { label: 'GS-2', serialNo: 'GS-102', meterReading: '800' }] });
    gs1 = lamps.units.find((u) => u.label === 'GS-1');
    gs2 = lamps.units.find((u) => u.label === 'GS-2');
    // GS-1 is serviced every 10 running hours, counted from its reading now.
    let list = await request('PATCH', R(`rentals/units/${gs1.id}`), { servicePer: 'hours', serviceEvery: '10' });
    assert.deepEqual([list.items.flatMap((i) => i.units).find((u) => u.id === gs1.id).serviced_meter, list.items.flatMap((i) => i.units).find((u) => u.id === gs1.id).service_every], ['500.0', 10]);
    assert.match((await refused('PATCH', R(`rentals/units/${swift.id}`), { servicePer: 'hours', serviceEvery: '10' })).message, /has no hour meter/);
    scanned = await book({ outAt: minute(), dueAt: minute(300), lines: [{ itemId: lamps.id, unitId: gs1.id }] });
    const S = (suffix) => R(`rentals/bookings/${scanned.id}${suffix}`);
    const hit = await yardHand.call('POST', S('/scan'), { code: 'gs 101' });
    assert.deepEqual([hit.lineId, hit.unitLabel], [scanned.lines[0].id, 'GS-1']);
    const miss = await refused('POST', S('/scan'), { code: 'GS-102' }, yardHand.token);
    assert.deepEqual([miss.status, miss.message], [409, `GS-102 is not on booking ${scanned.booking_no}: put it aside`]);
    assert.equal((await refused('POST', S('/scan'), { code: 'GS-101' }, viewer.token)).status, 403);
    // Photos of what goes out and the hirer's signature, before the handover; a renamed file refused.
    const photo = await upload({ bookingId: scanned.id, stage: 'out', kind: 'photo', lineId: scanned.lines[0].id });
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    assert.equal((await upload({ bookingId: scanned.id, stage: 'out', kind: 'signature', signer: 'hirer' }, png, 'signature.png')).status, 201);
    assert.equal((await upload({ bookingId: scanned.id, stage: 'out', kind: 'signature', signer: 'shop' }, png, 'signature.png', yardHand.token)).status, 201);
    const fake = await upload({ bookingId: scanned.id, stage: 'out', kind: 'photo' }, Buffer.from('not a picture at all, just words'), 'licence.png');
    assert.deepEqual([fake.status, fake.body.message], [400, 'Only a picture (JPG, PNG or WebP) can be added']);
    assert.equal((await upload({ bookingId: scanned.id, stage: 'in', kind: 'photo' })).status, 409, 'a return\'s photo waits for the handover');
    assert.equal((await upload({ bookingId: scanned.id, stage: 'out', kind: 'photo' }, png, 'p.png', viewer.token)).status, 403);
    const opened = await fetch(`${base}${R(`rentals/files/${photo.body.data.id}`)}`, { headers: { Authorization: `Bearer ${viewer.token}` } });
    assert.deepEqual([opened.status, opened.headers.get('x-content-type-options'), opened.headers.get('content-type')], [200, 'nosniff', 'image/png']);
    assert.ok(Buffer.from(await opened.arrayBuffer()).equals(png));
    assert.equal((await fetch(`${base}/businesses/${grocery.id}/rentals/files/${photo.body.data.id}`, { headers: { Authorization: `Bearer ${ownerToken}` } })).status, 404);
    await assert.rejects(rows('DELETE FROM rental_files WHERE booking_id=$1', [scanned.id]), /kept as it was taken/);
    // The handover with a wrong unit scanned is refused; with its own, it goes out.
    assert.match((await handOver(scanned, { scanned: ['GS-102'], lines: [{ lineId: scanned.lines[0].id, meter: '500' }] })).body.message, /GS-102 is not on booking/);
    const out = await handOver(scanned, { scanned: ['GS-101'], lines: [{ lineId: scanned.lines[0].id, meter: '500' }] }, yardHand.token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.match(out.body.data.events.at(-1).note, /scanned GS-101/);
    assert.deepEqual(out.body.data.files.map((f) => [f.stage, f.kind, f.signer]), [['out', 'photo', null], ['out', 'signature', 'hirer'], ['out', 'signature', 'shop']]);
    // Back 12 running hours later: scanned again, and now due for its service.
    const back = await request('POST', S('/returns'), { requestKey: key(), scanned: ['GS-101'], lines: [{ lineId: scanned.lines[0].id, meter: '512' }] }, 201);
    assert.equal(back.status, 'returned');
    assert.equal((await upload({ bookingId: scanned.id, stage: 'in', kind: 'signature', signer: 'hirer' })).status, 201);
  });

  await t.test('maintenance: a service schedule with the bell when due; downtime booked ahead holds a unit as a booking does', async () => {
    const bellOf = async () => (await request('GET', R('notifications'))).items.filter((n) => n.category === 'Fleet' && /GS-1 is due for its service/.test(n.title));
    assert.equal((await bellOf()).length, 1);
    let yardNow = await yardHand.call('POST', R(`rentals/units/${gs1.id}/services`), { meter: '512', note: 'Oil and filter changed' }, 201);
    assert.equal(yardNow.units.find((u) => u.id === gs1.id).service.due, false);
    assert.equal((await bellOf()).length, 0);
    assert.ok(await audited('rental_unit.serviced', gs1.id));
    // GS-2 is down for maintenance tomorrow from 10:00 to 18:00: a booking over it is refused, by the screen and by the database.
    const down = { requestKey: key(), startsAt: `${tomorrow}T10:00`, endsAt: `${tomorrow}T18:00`, reason: 'Alternator overhaul' };
    yardNow = await request('POST', R(`rentals/units/${gs2.id}/downtime`), down, 201);
    const booked = yardNow.downtime.find((d) => d.unit_id === gs2.id);
    assert.equal(booked.reason, 'Alternator overhaul');
    assert.equal((await request('POST', R(`rentals/units/${gs2.id}/downtime`), down, 201)).downtime.filter((d) => d.unit_id === gs2.id).length, 1, 'a retry is the same downtime');
    assert.equal((await refused('POST', R(`rentals/units/${gs2.id}/downtime`), { ...down, reason: 'Other' })).status, 409);
    const over = await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: hirer.id, outAt: `${tomorrow}T12:00`, dueAt: `${tomorrow}T14:00`,
      lines: [{ itemId: lamps.id, unitId: gs2.id }] });
    assert.deepEqual([over.status, /^GS-2 \(Genset 10 kVA\) is booked for maintenance \(Alternator overhaul\) from .+ to .+: it is not free from .+ to .+$/.test(over.message)], [409, true]);
    const seen = await request('POST', R('rentals/bookings/preview'), { locationId: yard.id, outAt: `${tomorrow}T12:00`, dueAt: `${tomorrow}T14:00`, lines: [{ itemId: lamps.id, unitId: gs2.id }] });
    assert.match(seen.lines[0].words, /GS-2 is booked for maintenance \(Alternator overhaul\)/);
    const week = await request('GET', R(`rentals/availability?from=${tomorrow}&days=1`));
    assert.ok(week.items.find((i) => i.itemId === lamps.id).units.find((u) => u.label === 'GS-2').days[0].holds.some((h) => h.part === 'downtime'));
    // Maintenance is booked over free time only.
    const later = await book({ outAt: `${addDays(today, 2)}T10:00`, dueAt: `${addDays(today, 2)}T12:00`, lines: [{ itemId: lamps.id, unitId: gs2.id }] });
    const clash = await refused('POST', R(`rentals/units/${gs2.id}/downtime`), { requestKey: key(), startsAt: `${addDays(today, 2)}T09:00`, endsAt: `${addDays(today, 2)}T11:00`, reason: 'Service' });
    assert.deepEqual([clash.status, new RegExp(`^GS-2 is booked on ${later.booking_no.replace(/\//g, '\\/')} \\(Kiran Kumar\\) from .+: maintenance is booked when it is free$`).test(clash.message)],
      [409, true]);
    // Cancelled, the unit is free again then.
    await request('POST', R(`rentals/downtime/${booked.id}/cancel`), {});
    await book({ outAt: `${tomorrow}T12:00`, dueAt: `${tomorrow}T14:00`, lines: [{ itemId: lamps.id, unitId: gs2.id }] });
    await assert.rejects(rows('DELETE FROM rental_downtime WHERE id=$1', [booked.id]), /cancelled, never deleted/);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='rental_downtime.booked'", [rentals.id]));
    assert.ok(await audited('rental_downtime.cancelled', booked.id));
  });

  // --- Discount ---------------------------------------------------------------------------------------------------
  let discounted;
  await t.test('a discount on a booking: by the discount permission and within the business\'s most bill discount, kept on the booking and billed', async () => {
    const lines = [{ itemId: cycles.id, quantity: '3' }];
    const times = { outAt: minute(), dueAt: minute(24 * 60) };
    assert.equal((await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: hirer.id, ...times, lines,
      discount: { percent: '5', reason: 'Regular' } }, desk.token)).status, 403);
    const over = await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: hirer.id, ...times, lines, discount: { percent: '15', reason: 'Regular' } },
      manager.token);
    assert.deepEqual([over.status, over.message], [409, 'At most 10% of a bill can be taken off. The owner can change this in Business settings.']);
    assert.match((await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: hirer.id, ...times, lines, discount: { percent: '5' } },
      manager.token)).message, /Reason for the discount/);
    // 10% off 3 cycles for a day (1,200): 120 off, 1,080 + 194.40 = 1,274.40.
    discounted = await book({ ...times, lines, discount: { percent: '10', reason: 'Regular customer' } }, manager.call);
    assert.deepEqual([discounted.discount_percent, discounted.discount_reason, discounted.lines[0].amount, discounted.lines[0].discount, discounted.lines[0].net,
      discounted.subtotal, discounted.tax, discounted.total], ['10.00', 'Regular customer', '1200.00', '120.00', '1080.00', '1080.00', '194.40', '1274.40']);
    assert.equal(paise(discounted.subtotal) + paise(discounted.tax), paise(discounted.total));
    const big = await book({ outAt: minute(60), dueAt: minute(25 * 60), lines, discount: { percent: '15', reason: 'Owner\'s friend' } });
    assert.equal(big.total, '1203.60', 'the owner gives any discount');
    // Changed and taken off by those who may; kept on the booking and billed.
    const changed = await manager.call('PATCH', R(`rentals/bookings/${big.id}`), { discount: null });
    assert.deepEqual([changed.discount_percent, changed.total], ['0.00', '1416.00']);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE action='rental_booking.changed' AND entity_id=$1 AND details ? 'discount'", [big.id]));
    assert.equal((await handOver(discounted)).status, 200);
    const back = await request('POST', R(`rentals/bookings/${discounted.id}/returns`), { requestKey: key(), lines: [{ lineId: discounted.lines[0].id }] }, 201);
    const bill = await request('GET', R(`documents/${back.document_id}`));
    assert.deepEqual(bill.lines.map((l) => [l.label, l.net, l.tax]), [['Hire for 1 day (less 10%) · 3 × Pedal cycle', '1080.00', '194.40']]);
    assert.equal(bill.total, '1274.40');
  });

  // --- Reports -----------------------------------------------------------------------------------------------------
  await t.test('use and earnings for a period on the business\'s calendar: days out against days available, the hire and fees by unit and item', async () => {
    const report = await viewer.call('GET', R(`rentals/reports?from=${today}&to=${today}`));
    assert.deepEqual([report.from, report.to, report.money], [today, today, true]);
    const swiftRow = report.units.find((u) => u.unitId === swift.id);
    // The hire and the fees are the bill lines of the unit, before GST.
    const billed = await one(`SELECT sum(dl.net) FILTER (WHERE dl.id=l.line_id) AS hire,sum(dl.net) FILTER (WHERE dl.id IN (rl.km_line_id,rl.fuel_line_id)) AS fees
      FROM rental_booking_lines l JOIN rental_return_lines rl ON rl.line_id=l.id JOIN business_document_lines dl ON dl.id IN (l.line_id,rl.km_line_id,rl.fuel_line_id) WHERE l.unit_id=$1`, [swift.id]);
    assert.deepEqual([swiftRow.hire, swiftRow.fees, swiftRow.hires], [billed.hire, billed.fees, 1]);
    assert.deepEqual([billed.hire, billed.fees], ['1500.00', '1872.00']);
    // Days out: from its handover to its return; available: today so far, since it was added.
    const span = await one(`SELECT EXTRACT(EPOCH FROM (r.created_at-b.checked_out_at)) AS out,
        EXTRACT(EPOCH FROM (LEAST(now(),((($2::date+1)::timestamp) AT TIME ZONE 'Asia/Kolkata'))-GREATEST((($2::date)::timestamp AT TIME ZONE 'Asia/Kolkata'),u.created_at))) AS available
      FROM rental_booking_lines l JOIN rental_bookings b ON b.id=l.booking_id JOIN rental_return_lines rl ON rl.line_id=l.id JOIN rental_returns r ON r.id=rl.return_id
      JOIN rental_units u ON u.id=l.unit_id WHERE l.unit_id=$1`, [swift.id, today]);
    assert.equal(swiftRow.daysOut, Math.round((Number(span.out) / 86400) * 10) / 10);
    assert.ok(Math.abs(swiftRow.daysAvailable - Math.round((Number(span.available) / 86400) * 10) / 10) <= 0.1);
    // Downtime booked comes off the days available; the item adds its units up; a pool counts piece-days; a kit its own hire.
    const cycleRow = report.items.find((i) => i.itemId === cycles.id);
    const cycleHire = await one(`SELECT COALESCE(sum(dl.net),0) AS n FROM rental_booking_lines l JOIN business_document_lines dl ON dl.id=l.line_id WHERE l.item_id=$1`, [cycles.id]);
    assert.deepEqual([cycleRow.kind, cycleRow.pool, cycleRow.hire], ['pool', 10, cycleHire.n]);
    assert.ok(cycleRow.daysOut > 0 && cycleRow.use > 0);
    const kitRow = report.items.find((i) => i.itemId === shamiana.id);
    assert.deepEqual([kitRow.kind, kitRow.hire, kitRow.daysOut], ['kit', '2000.00', null]);
    const hatchRow = report.items.find((i) => i.itemId === hatch.id);
    assert.equal(hatchRow.units, 2);
    assert.equal(paise(report.totals.hire), report.items.reduce((s, i) => s + paise(i.hire), 0));
    // Those who do not see sales see the use, not the money.
    const yardView = await yardHand.call('GET', R(`rentals/reports?from=${today}&to=${today}`));
    assert.deepEqual([yardView.money, yardView.units.find((u) => u.unitId === swift.id).hire, yardView.units.find((u) => u.unitId === swift.id).daysOut], [false, null, swiftRow.daysOut]);
    assert.match((await refused('GET', R(`rentals/reports?from=${today}&to=${addDays(today, -1)}`))).message, /end date is before the start date/);
  });

  await t.test('other types, other roles and other owners are kept out', async () => {
    const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
    for (const route of ['rentals/yard', 'rentals/register', 'rentals/reports']) assert.equal((await refused('GET', G(route))).status, 403, route);
    assert.equal((await refused('POST', G('rentals/classes'), { name: 'x' })).status, 404);
    assert.equal((await refused('POST', R(`rentals/units/${gs2.id}/services`), {}, viewer.token)).status, 403);
    assert.equal((await refused('POST', R(`rentals/units/${gs2.id}/downtime`), { requestKey: key(), startsAt: `${tomorrow}T10:00`, endsAt: `${tomorrow}T11:00`, reason: 'x' }, viewer.token)).status, 403);
    assert.equal((await refused('GET', R('rentals/yard'), undefined, await login('more-other@test.invalid'))).status, 404);
    assert.equal((await yardHand.call('GET', R('rentals/yard'))).units.length > 0, true);
  });
});
