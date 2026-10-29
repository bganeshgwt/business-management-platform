const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom, weekdayOf } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A hotel's, lodge's or guest house's own tools: room types with their rate
// plans and rooms with their housekeeping status; reservations priced night
// by night, each night at the GST slab its value decides (₹7,500 or less a
// room a night 5%, above it 18%); a room never booked twice, even for two
// stays saved at the same moment, and a room type never over its rooms; the
// check-in with every occupant and their photo ID (an Aadhaar's last four
// digits only); foreign guests' Form-III countdowns and acknowledgements; the
// night audit posting each room night once; extras on the folio; the
// check-out billing the folio through the core, to the guest or a company,
// the advance first; cancellations and no-shows; the guest register; the
// front desk and housekeeping roles. Money adds up to the paisa, postings are
// idempotent, the database keeps its rules, audit and events are written, and
// other types and other owners are kept out. Runs on its own throwaway
// database with every migration applied.
test('hotels, lodges and guest houses', { timeout: 300000 }, async (t) => {
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
  const password = `Lodge-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('lodge-owner');
  await owner('lodge-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('lodge-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('lodge-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const rupees = (p) => (p / 100).toFixed(2);
  const today = daysFrom(0);
  // A night's day of the week as the settings count it (1 Monday … 7 Sunday), and whether it is a weekend night (Friday, Saturday).
  const isoDay = (day) => weekdayOf(day) || 7;
  const weekend = (day) => [5, 6].includes(isoDay(day));
  // GST to the paisa, halves up (as the core works it out).
  const gst = (net, rate) => Math.floor((net * Math.round(rate * 100) + 5000) / 10000);
  // The next Thursday after today, on the business's clock.
  let thursday = daysFrom(1);
  while (weekdayOf(thursday) !== 4) thursday = addDays(thursday, 1);

  const [lodge, grocery, rentals] = await createBusinesses(request, 'OWNER', ['lodging', 'grocery', 'rentals']);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['lodging']);
  const L = (suffix) => `/businesses/${lodge.id}/${suffix}`;

  await t.test('modules, permissions and roles per type', async () => {
    assert.ok(lodge.capabilities.includes('lodging'), 'a lodging business starts with rooms & stays');
    assert.ok(lodge.capabilities.includes('receivables'), 'a lodging business keeps companies\' dues');
    for (const business of [grocery, rentals]) assert.ok(!business.capabilities.includes('lodging'), `${business.business_type} has no rooms & stays`);
    const tools = await request('GET', L('modules'));
    const module = tools.find((m) => m.code === 'lodging');
    assert.equal(module.name, 'Rooms & stays');
    assert.deepEqual([...module.requires].sort(), ['catalog', 'contacts', 'sales']);
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'lodging'), 'a grocery is not offered rooms & stays');
    await request('PUT', `/businesses/${grocery.id}/modules/lodging`, { enabled: true }, 409);
    await request('PUT', L('modules/sales'), { enabled: false }, 409);
    const permissions = await rows("SELECT code FROM business_permissions WHERE module_code='lodging' ORDER BY sort_order");
    assert.deepEqual(permissions.map((p) => p.code), ['lodging.view', 'lodging.create', 'lodging.edit', 'lodging.approve', 'lodging.cancel', 'lodging.refund', 'lodging.print']);
    const grants = async (business, template, prefix = 'lodging.') => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2`, [business.id, template])).p.filter((p) => p.startsWith(prefix));
    assert.deepEqual(await grants(lodge, 'manager'), ['lodging.approve', 'lodging.cancel', 'lodging.create', 'lodging.edit', 'lodging.print', 'lodging.refund', 'lodging.view']);
    assert.deepEqual(await grants(lodge, 'cashier'), ['lodging.create', 'lodging.edit', 'lodging.print', 'lodging.view']);
    assert.deepEqual(await grants(lodge, 'stock_keeper'), ['lodging.view']);
    assert.deepEqual(await grants(lodge, 'accountant'), ['lodging.print', 'lodging.view']);
    assert.deepEqual(await grants(lodge, 'viewer'), ['lodging.view']);
    assert.deepEqual(await grants(lodge, 'front_desk'), ['lodging.cancel', 'lodging.create', 'lodging.edit', 'lodging.print', 'lodging.view']);
    assert.deepEqual(await grants(lodge, 'front_desk', ''), ['catalog.view', 'contacts.create', 'contacts.view', 'lodging.cancel', 'lodging.create', 'lodging.edit', 'lodging.print',
      'lodging.view', 'receivables.create', 'receivables.print', 'receivables.view', 'sales.create', 'sales.edit', 'sales.print', 'sales.view'], 'the front desk: no settings, no money handed back');
    assert.deepEqual(await grants(lodge, 'housekeeping', ''), ['lodging.edit', 'lodging.view'], 'housekeeping: the rooms only');
    assert.deepEqual(await grants(grocery, 'viewer'), ['lodging.view'], 'role copies match their templates everywhere');
    const templates = (await request('GET', L('roles?limit=100'))).items.map((r) => r.template_code);
    assert.ok(templates.includes('front_desk') && templates.includes('housekeeping'), 'a lodging business has the front desk and housekeeping roles');
    assert.equal(templates.length, 8);
    const groceryTemplates = (await request('GET', `/businesses/${grocery.id}/roles?limit=100`)).items.map((r) => r.template_code);
    assert.ok(!groceryTemplates.includes('front_desk') && !groceryTemplates.includes('housekeeping'), 'other types have no lodging roles');
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'")).d.includes("'stay'"));
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_collection_refunds_source_check'")).d.includes("'lodging'"));
  });

  await t.test('other types and other owners are kept out', async () => {
    // Another type lacks the module: refused by the module check; a route that needs only a shared permission: not found for the type.
    assert.equal((await refused('GET', `/businesses/${grocery.id}/lodging/setup`)).status, 403);
    assert.equal((await refused('GET', `/businesses/${rentals.id}/lodging/desk`)).status, 403);
    const settings = await refused('PUT', `/businesses/${grocery.id}/lodging/settings`, { terms: 'x' });
    assert.deepEqual([settings.status, settings.message], [404, 'This screen belongs to hotels, lodges and guest houses']);
    // Another owner's lodge is not this owner's.
    assert.equal((await refused('GET', `/businesses/${elsewhere.id}/lodging/setup`)).status, 404);
    assert.equal((await refused('GET', L('lodging/setup'), undefined, await login('lodge-other@test.invalid'))).status, 404);
    // Switched off, its screens are refused with the module's own words.
    await other('PUT', `/businesses/${elsewhere.id}/modules/lodging`, { enabled: false });
    const off = await refused('GET', `/businesses/${elsewhere.id}/lodging/desk`, undefined, await login('lodge-other@test.invalid'));
    assert.equal(off.status, 403);
    await other('PUT', `/businesses/${elsewhere.id}/modules/lodging`, { enabled: true });
  });

  // --- The property: its location's state, its GST slabs, room types, rooms, items, guests and staff -------------------------
  const hotel = (await request('GET', L('locations'))).items[0];
  await request('PATCH', L(`locations/${hotel.id}`), { name: hotel.name, stateCode: '36', city: 'Hyderabad' });
  const slabs = (await request('GET', L('tax-rates?limit=100'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const roles = (await request('GET', L('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', L('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('lodge-desk@test.invalid', 'front_desk');
  const keeper = await staff('lodge-keeping@test.invalid', 'housekeeping');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const approval = { approverId: ownerUser.id, pin: '2468' };
  let deluxe, suite, rooms;
  const roomId = (no) => rooms.find((r) => r.room_no === no).id;
  const customer = (name, extra = {}) => request('POST', L('contacts'), { kind: 'customer', name, ...extra }, 201);
  const service = (name, code, price, taxRateId) => request('POST', L('catalog'), { kind: 'service', unit: 'service', name, code, price: String(price), taxRateId }, 201);
  // Time passes: a stay in the house moved back so many days, as if it had arrived then (its dates and its occupants' arrival).
  async function backdate(stayId, days) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE lodging_stays DISABLE TRIGGER lodging_stays_guard');
      await db.query('ALTER TABLE lodging_stay_guests DISABLE TRIGGER lodging_stay_guests_guard');
      await db.query(`UPDATE lodging_stays SET arrival=arrival-$2::int,departure=departure-$2::int,checked_in_at=checked_in_at-make_interval(days=>$2::int) WHERE id=$1`, [stayId, days]);
      // Its nights priced for their new dates, as a booking then would have been: the agreed rate, else the weekend rate on a weekend night, else the rack rate.
      await db.query('DELETE FROM lodging_stay_nights WHERE stay_id=$1', [stayId]);
      await db.query(`INSERT INTO lodging_stay_nights(business_id,stay_id,night,rate_kind,room_rate,extra_adult_rate,child_rate,extra_bed_rate)
        SELECT s.business_id,s.id,n::date,
          CASE WHEN s.agreed_rate IS NOT NULL THEN 'agreed' WHEN s.weekend_rate IS NOT NULL AND EXTRACT(ISODOW FROM n)::smallint = ANY (st.weekend_nights) THEN 'weekend' ELSE 'rack' END,
          CASE WHEN s.agreed_rate IS NOT NULL THEN s.agreed_rate WHEN s.weekend_rate IS NOT NULL AND EXTRACT(ISODOW FROM n)::smallint = ANY (st.weekend_nights) THEN s.weekend_rate ELSE s.rack_rate END,
          s.extra_adult_rate,s.child_rate,s.extra_bed_rate
        FROM lodging_stays s JOIN lodging_settings st ON st.business_id=s.business_id CROSS JOIN LATERAL generate_series(s.arrival::timestamp,(s.departure-1)::timestamp,interval '1 day') n
        WHERE s.id=$1`, [stayId]);
      await db.query('UPDATE lodging_stay_guests SET arrived_at=arrived_at-make_interval(days=>$2::int),created_at=created_at-make_interval(days=>$2::int) WHERE stay_id=$1', [stayId, days]);
      await db.query('ALTER TABLE lodging_stay_guests ENABLE TRIGGER lodging_stay_guests_guard');
      await db.query('ALTER TABLE lodging_stays ENABLE TRIGGER lodging_stays_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }

  await t.test('settings: the two GST slabs of a room night, set before anything is reserved or billed', async () => {
    let setup = await request('GET', L('lodging/setup'));
    assert.deepEqual([setup.settings.ready, setup.settings.slabLimit, setup.settings.weekendNights], [false, '7500.00', [5, 6]]);
    assert.ok(setup.slabs.some((s) => Number(s.rate) === 5) && setup.slabs.some((s) => Number(s.rate) === 18));
    // The lower slab is below the higher one.
    const backwards = await refused('PUT', L('lodging/settings'), { lowTaxRateId: gst18.id, highTaxRateId: gst5.id });
    assert.equal(backwards.status, 409);
    assert.match(backwards.message, /is not below/);
    const same = await refused('PUT', L('lodging/settings'), { lowTaxRateId: gst5.id, highTaxRateId: gst5.id });
    assert.equal(same.status, 400);
    // Room types can be set up before the slabs; a reservation cannot.
    let list = await request('POST', L('lodging/room-types'), { item: { name: 'Deluxe', hsnCode: '996311' }, baseOccupancy: 2, maxOccupancy: 3, maxExtraBeds: 1,
      rates: { rack: '4500', weekend: '5200', extraAdult: '1000', child: '500', extraBed: '800' } }, 201);
    deluxe = list.roomTypes.find((r) => r.name === 'Deluxe');
    list = await request('POST', L('lodging/rooms'), { locationId: hotel.id, roomTypeId: deluxe.id, rooms: [{ roomNo: '101', floor: '1' }, { roomNo: '102', floor: '1' }] }, 201);
    const early = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Too Early' }, arrival: today, departure: addDays(today, 1),
      roomTypeId: deluxe.id, adults: 1 });
    assert.equal(early.status, 409);
    assert.match(early.message, /Set the two GST slabs for room nights first, under Settings › Room types & rates/);
    setup = await request('PUT', L('lodging/settings'), { lowTaxRateId: gst5.id, highTaxRateId: gst18.id, terms: 'Check-out by 11 am. Photo ID for every guest.' });
    assert.deepEqual([setup.ready, setup.lowRate, setup.highRate, setup.slabLimit], [true, '5.00', '18.00', '7500.00']);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action='lodging_settings.updated'", [lodge.id])).n, 1);
  });

  await t.test('room types billed as service items counted in nights, with their rate plans and rooms', async () => {
    const list = await request('POST', L('lodging/room-types'), { item: { name: 'Suite' }, baseOccupancy: 2, maxOccupancy: 4, rates: { rack: '7000', weekend: '8500', extraAdult: '1500' } }, 201);
    suite = list.roomTypes.find((r) => r.name === 'Suite');
    assert.deepEqual([suite.base_occupancy, suite.max_occupancy, suite.rack_rate, suite.weekend_rate, suite.extra_adult_rate, suite.child_rate], [2, 4, '7000.00', '8500.00', '1500.00', null]);
    const sku = await one('SELECT s.unit,s.price,s.tax_rate,s.hsn_code,p.kind FROM catalog_skus s JOIN catalog_products p ON p.id=s.product_id WHERE s.id=$1', [deluxe.sku_id]);
    assert.deepEqual([sku.kind, sku.unit, sku.hsn_code], ['service', 'night', '996311']);
    const setup = await request('POST', L('lodging/rooms'), { locationId: hotel.id, roomTypeId: suite.id, rooms: [{ roomNo: '201', floor: '2' }] }, 201);
    rooms = setup.rooms;
    assert.deepEqual(rooms.map((r) => [r.room_no, r.status]).sort(), [['101', 'vacant_clean'], ['102', 'vacant_clean'], ['201', 'vacant_clean']]);
    // A room number is the location's once; an extra bed needs its rate; a room type's name is once.
    assert.equal((await refused('POST', L('lodging/rooms'), { locationId: hotel.id, roomTypeId: suite.id, rooms: [{ roomNo: '101' }] })).status, 409);
    assert.equal((await refused('POST', L('lodging/room-types'), { item: { name: 'Twin' }, baseOccupancy: 2, maxExtraBeds: 1, rates: { rack: '3000' } })).status, 400);
    assert.equal((await refused('POST', L('lodging/room-types'), { item: { name: 'deluxe' }, baseOccupancy: 2, rates: { rack: '3000' } })).status, 409);
    // The database: a room type's item is a service counted in nights; it is never deleted; nor is a room.
    const hourly = await request('POST', L('catalog'), { kind: 'service', unit: 'service', name: 'Rule room', code: 'RULE-ROOM', price: '0', taxRateId: gst5.id }, 201);
    await assert.rejects(rows('INSERT INTO lodging_room_types(business_id,sku_id,base_occupancy,max_occupancy,rack_rate,created_by) VALUES($1,$2,2,2,1000,$3)', [lodge.id, hourly.id, ownerUser.id]),
      /counted in nights/);
    await assert.rejects(rows('DELETE FROM lodging_room_types WHERE id=$1', [deluxe.id]), /never deleted/);
    await assert.rejects(rows('DELETE FROM lodging_rooms WHERE id=$1', [roomId('101')]), /never deleted/);
    await assert.rejects(rows("UPDATE lodging_rooms SET status='occupied' WHERE id=$1", [roomId('101')]), /occupied when a guest checks in/);
    // A rate change applies to stays booked after it.
    const changed = await request('PATCH', L(`lodging/room-types/${suite.id}`), { description: 'Sea-facing, with a sitting room' });
    assert.equal(changed.roomTypes.find((r) => r.id === suite.id).description, 'Sea-facing, with a sitting room');
  });

  await t.test('a reservation priced night by night, each night at the slab its own value decides', async () => {
    // Thursday at the rack rate 7,000 (5%), Friday and Saturday at the weekend rate 8,500 (18%).
    const preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: thursday, departure: addDays(thursday, 3), roomTypeId: suite.id, adults: 2 });
    assert.deepEqual(preview.nights.map((n) => [n.rateKind, n.amount, n.taxRate, n.tax]), [['rack', '7000.00', '5.00', '350.00'], ['weekend', '8500.00', '18.00', '1530.00'],
      ['weekend', '8500.00', '18.00', '1530.00']]);
    assert.deepEqual([preview.subtotal, preview.tax, preview.total, preview.typeFree], ['24000.00', '3410.00', '27410.00', true]);
    // An extra adult takes a weekday Deluxe night to 5,500 (still 5%); a child and an extra bed add theirs.
    const family = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: thursday, departure: addDays(thursday, 1), roomTypeId: deluxe.id, adults: 2, children: 1, extraBeds: 1 });
    assert.deepEqual([family.nights[0].amount, family.nights[0].taxRate, family.total], ['5800.00', '5.00', '6090.00']);
    // Exactly 7,500 a night is the lower slab; a paisa more is the higher.
    const at = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: thursday, departure: addDays(thursday, 1), roomTypeId: suite.id, adults: 2, agreedRate: '7500' });
    assert.deepEqual([at.nights[0].rateKind, at.nights[0].taxRate, at.nights[0].tax], ['agreed', '5.00', '375.00']);
    const over = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: thursday, departure: addDays(thursday, 1), roomTypeId: suite.id, adults: 2, agreedRate: '7500.01' });
    assert.deepEqual([over.nights[0].taxRate, over.nights[0].tax, over.total], ['18.00', '1350.00', '8850.01']);
    // A room takes its guests and its beds.
    assert.equal((await refused('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: thursday, departure: addDays(thursday, 1), roomTypeId: deluxe.id, adults: 3, children: 1 })).status, 400);
    assert.equal((await refused('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: thursday, departure: addDays(thursday, 1), roomTypeId: suite.id, adults: 2, extraBeds: 1 })).status, 400);
    // A stay arrives today or later, and is one night at least.
    assert.equal((await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Past' }, arrival: daysFrom(-1), departure: today, roomTypeId: deluxe.id, adults: 1 })).status, 400);
    assert.equal((await refused('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: today, departure: today, roomTypeId: deluxe.id, adults: 1 })).status, 400);
  });

  let asha, john, company, laundry, dinner, s1, s2;
  await t.test('a room is never booked twice over a night, nor a room type over its rooms, even for stays saved together', async () => {
    asha = await customer('Asha Rao', { phone: '9876500501' });
    // Two reservations of room 101 for the same Thursday night at the same moment: one is booked, the other refused.
    const body = (name) => ({ requestKey: key(), locationId: hotel.id, guest: { name }, arrival: thursday, departure: addDays(thursday, 1), roomTypeId: deluxe.id, roomId: roomId('101'), adults: 2 });
    const both = await Promise.all([call('POST', L('lodging/stays'), body('Guest One'), ownerToken), call('POST', L('lodging/stays'), body('Guest Two'), ownerToken)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    const lost = both.find((r) => r.status === 409);
    assert.match(lost.body.message, /Room 101 is booked by ST\/.+ for the night of/);
    const won = both.find((r) => r.status === 201).body.data;
    assert.equal(won.status, 'reserved');
    assert.match(won.stay_no, /^ST\//);
    // The same night in room 102 is free; a third Deluxe that night is refused: every Deluxe room is taken.
    const second = await request('POST', L('lodging/stays'), { ...body('Guest Three'), roomId: undefined }, 201);
    const third = await refused('POST', L('lodging/stays'), { ...body('Guest Four'), roomId: undefined });
    assert.equal(third.status, 409);
    assert.match(third.message, /Every Deluxe room is taken on the night of .+ \(2 stays for 2 rooms\)/);
    // The database itself refuses a room held twice (the exclusion constraint), whatever the screen did.
    await assert.rejects(rows('UPDATE lodging_stays SET room_id=$2 WHERE id=$1', [second.id, roomId('101')]), /lodging_stays_room_free/);
    // Two stays of the one Suite for a night, saved at the same moment, no room chosen: the room type's row is the lock, one wins.
    const suiteBody = (name) => ({ requestKey: key(), locationId: hotel.id, guest: { name }, arrival: addDays(thursday, 7), departure: addDays(thursday, 8), roomTypeId: suite.id, adults: 2 });
    const pair = await Promise.all([call('POST', L('lodging/stays'), suiteBody('Guest Five'), ownerToken), call('POST', L('lodging/stays'), suiteBody('Guest Six'), ownerToken)]);
    assert.deepEqual(pair.map((r) => r.status).sort(), [201, 409]);
    // An idempotent repeat: the same key and body is the same reservation; the same key with another body is refused.
    const again = body('Guest Seven');
    again.roomId = undefined; again.arrival = addDays(thursday, 14); again.departure = addDays(thursday, 15);
    const first = await request('POST', L('lodging/stays'), again, 201);
    assert.equal((await request('POST', L('lodging/stays'), again, 201)).id, first.id);
    assert.equal((await refused('POST', L('lodging/stays'), { ...again, adults: 1 })).status, 409);
  });

  await t.test('check-in to a vacant clean room with every occupant and their ID, an Aadhaar only by its last four digits', async () => {
    laundry = await service('Laundry (per piece)', 'LND-PC', 50, gst18.id);
    dinner = await service('Room service dinner', 'RS-DIN', 300, gst5.id);
    company = await customer('Infotech Solutions Pvt Ltd', { gstin: '27AAPFU0939F1ZV' });
    // Asha's family: Deluxe tonight and tomorrow night, an advance of 2,000 in cash.
    s1 = await request('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, contactId: asha.id, source: 'phone', arrival: today, departure: addDays(today, 2),
      roomTypeId: deluxe.id, adults: 2, advance: { amount: '2000', method: 'cash' } }, 201);
    assert.deepEqual([s1.status, s1.advance_summary.taken, s1.receipts.length], ['reserved', '2000.00', 1]);
    // Room 102 is not made up: housekeeping is asked first.
    await keeper.call('POST', L(`lodging/rooms/${roomId('102')}/status`), { status: 'vacant_dirty' });
    const guests = [
      { fullName: 'Asha Rao', gender: 'female', age: '41', nationality: 'Indian', idKind: 'aadhaar', idRef: '1234', phone: '9876500501', address: '12 MG Road, Pune' },
      { fullName: 'John Smith', gender: 'male', foreigner: true, nationality: 'British', idKind: 'passport', idRef: 'GB5544332', visaType: 'e-Tourist visa', visaNo: 'ETV998877',
        arrivedIndiaOn: daysFrom(-3), nextDestination: 'Goa, India' },
    ];
    const checkIn = { requestKey: key(), roomId: roomId('102'), guests, arrivedFrom: 'Pune', goingTo: 'Goa', purpose: 'Holiday' };
    const dirty = await refused('POST', L(`lodging/stays/${s1.id}/check-in`), checkIn);
    assert.deepEqual([dirty.status, dirty.message], [409, 'Room 102 is vacant, to be made up: a guest checks in to a room that is vacant and clean']);
    await keeper.call('POST', L(`lodging/rooms/${roomId('102')}/status`), { status: 'vacant_clean' });
    // Every occupant is recorded: not only the one who booked; an adult shows a photo ID; of an Aadhaar only the last four digits.
    assert.equal((await refused('POST', L(`lodging/stays/${s1.id}/check-in`), { ...checkIn, requestKey: key(), guests: [guests[0]] })).status, 400);
    const fullAadhaar = await refused('POST', L(`lodging/stays/${s1.id}/check-in`), { ...checkIn, requestKey: key(), guests: [{ ...guests[0], idRef: '1234 5678 9012' }, guests[1]] });
    assert.deepEqual([fullAadhaar.status, fullAadhaar.message], [400, 'Asha Rao: photo ID: type only the last four digits of the Aadhaar number; no more of it is kept']);
    assert.equal((await refused('POST', L(`lodging/stays/${s1.id}/check-in`), { ...checkIn, requestKey: key(), guests: [{ ...guests[0], idKind: undefined, idRef: undefined }, guests[1]] })).status, 400);
    // A foreigner's passport, visa (or OCI card), arrival in India and next destination, for Form-III.
    const noVisa = await refused('POST', L(`lodging/stays/${s1.id}/check-in`), { ...checkIn, requestKey: key(), guests: [guests[0], { ...guests[1], visaNo: '' }] });
    assert.equal(noVisa.status, 400);
    assert.match(noVisa.message, /visa's type and number, or for an OCI cardholder "OCI card"/);
    const stay = await request('POST', L(`lodging/stays/${s1.id}/check-in`), checkIn);
    assert.deepEqual([stay.status, stay.room_no, stay.guests.length, stay.arrived_from, stay.purpose], ['in_house', '102', 2, 'Pune', 'Holiday']);
    assert.deepEqual(stay.guests.map((g) => [g.full_name, g.id_kind, g.id_ref, g.foreigner]), [['Asha Rao', 'aadhaar', '1234', false], ['John Smith', 'passport', 'GB5544332', true]]);
    // A retry is the same check-in; the same key with another room is refused.
    assert.equal((await request('POST', L(`lodging/stays/${s1.id}/check-in`), checkIn)).status, 'in_house');
    assert.equal((await refused('POST', L(`lodging/stays/${s1.id}/check-in`), { ...checkIn, roomId: roomId('101') })).status, 409);
    assert.equal((await one('SELECT status FROM lodging_rooms WHERE id=$1', [roomId('102')])).status, 'occupied');
    const log = await rows('SELECT from_status,to_status,note FROM lodging_room_status_log WHERE room_id=$1 ORDER BY id', [roomId('102')]);
    assert.deepEqual(log.map((l) => [l.from_status, l.to_status]), [[null, 'vacant_clean'], ['vacant_clean', 'vacant_dirty'], ['vacant_dirty', 'vacant_clean'], ['vacant_clean', 'occupied']]);
    assert.match(log.at(-1).note, /^Checked in: ST\//);
    // A reservation for a day still to come does not check in today.
    const later = await request('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, contactId: asha.id, arrival: addDays(thursday, 21), departure: addDays(thursday, 22),
      roomTypeId: suite.id, adults: 1 }, 201);
    const notYet = await refused('POST', L(`lodging/stays/${later.id}/check-in`), { requestKey: key(), roomId: roomId('201'), guests: [guests[0]] });
    assert.equal(notYet.status, 409);
    assert.match(notYet.message, /change its arrival to today to check in now/);
    // The company's guest: the Suite tonight, three adults (one beyond the base), billed to the company.
    s2 = await request('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Vikram Shah', phone: '9820012345' }, billToContactId: company.id, source: 'ota',
      otaName: 'MakeMyTrip', otaBookingId: 'MMT-77812', arrival: today, departure: addDays(today, 1), roomTypeId: suite.id, roomId: roomId('201'), adults: 3 }, 201);
    assert.deepEqual([s2.bill_to_name, s2.ota_booking_id], ['Infotech Solutions Pvt Ltd', 'MMT-77812']);
    await desk.call('POST', L(`lodging/stays/${s2.id}/check-in`), { requestKey: key(), guests: [
      { fullName: 'Vikram Shah', idKind: 'pan_card', idRef: 'ABCDE1234F' }, { fullName: 'Neha Shah', idKind: 'voter_id', idRef: 'MHV1234567' },
      { fullName: 'Rohan Shah', idKind: 'driving_licence', idRef: 'MH0120190012345' }] });
  });

  await t.test('Form-III: a foreigner\'s 24-hour countdown from the check-in, marked reported with the acknowledgement', async () => {
    const list = await request('GET', L('lodging/form-iii'));
    const john = list.items.find((g) => g.full_name === 'John Smith');
    assert.ok(john, 'the foreign guest is listed to report');
    assert.equal(john.next.event, 'arrival');
    assert.ok(john.next.minutesLeft > 1430 && john.next.minutesLeft <= 1440, `due within 24 hours of the check-in (${john.next.minutesLeft} minutes left)`);
    assert.equal(list.items.filter((g) => g.full_name !== 'John Smith').length, 0, 'Indian guests are not reported on Form-III');
    // The departure report waits for the departure; the arrival is marked with its acknowledgement, once.
    assert.equal((await refused('POST', L(`lodging/guests/${john.id}/form-iii`), { event: 'departure', acknowledgement: 'FRO-1' })).status, 409);
    assert.equal((await refused('POST', L(`lodging/guests/${john.id}/form-iii`), { event: 'arrival', acknowledgement: 'x' })).status, 400);
    const marked = await desk.call('POST', L(`lodging/guests/${john.id}/form-iii`), { event: 'arrival', acknowledgement: 'FRRO/HYD/2026/000123' });
    assert.deepEqual([marked.guest.frro_arrival_ack, marked.guest.arrival_open, marked.repeated], ['FRRO/HYD/2026/000123', false, false]);
    assert.equal((await desk.call('POST', L(`lodging/guests/${john.id}/form-iii`), { event: 'arrival', acknowledgement: 'FRRO/HYD/2026/000123' })).repeated, true);
    assert.equal((await refused('POST', L(`lodging/guests/${john.id}/form-iii`), { event: 'arrival', acknowledgement: 'FRRO/HYD/2026/000999' })).status, 409);
    assert.equal((await request('GET', L('lodging/form-iii'))).items.length, 0, 'nothing left to report');
    // An Indian guest is not a Form-III guest.
    const asha1 = (await request('GET', L(`lodging/stays/${s1.id}`))).guests.find((g) => g.full_name === 'Asha Rao');
    assert.equal((await refused('POST', L(`lodging/guests/${asha1.id}/form-iii`), { event: 'arrival', acknowledgement: 'FRO-2' })).status, 409);
  });

  let nightsS1;
  await t.test('the night audit posts each room night once, at its night\'s rate and the slab its value decides', async () => {
    // Asha's family has been in the house since yesterday.
    await backdate(s1.id, 1);
    const stay = await request('GET', L(`lodging/stays/${s1.id}`));
    assert.deepEqual([stay.arrival, stay.departure], [daysFrom(-1), addDays(today, 1)]);
    // Before the slabs it is refused; with them, every stay in the house gets its nights up to tonight.
    const audit = await desk.call('POST', L('lodging/night-audit'), {});
    assert.equal(audit.nights, 3, 'yesterday and tonight for the Deluxe, tonight for the Suite');
    const value = (day) => (weekend(day) ? 520000 : 450000);
    nightsS1 = [daysFrom(-1), today].map((day) => ({ day, net: value(day), tax: gst(value(day), 5) }));
    const posted = await rows("SELECT night::text AS night,rate_kind,amount,tax_rate,tax,room_id FROM lodging_charges WHERE stay_id=$1 AND kind='room_night' ORDER BY night", [s1.id]);
    assert.deepEqual(posted.map((p) => [p.night, p.rate_kind, paise(p.amount), Number(p.tax_rate), paise(p.tax)]),
      nightsS1.map((n) => [n.day, weekend(n.day) ? 'weekend' : 'rack', n.net, 5, n.tax]));
    // The Suite's three adults: 7,000 (or 8,500 at the weekend) and 1,500 for the third adult, above 7,500: 18%.
    const suiteNight = (weekend(today) ? 850000 : 700000) + 150000;
    const suitePosted = await one("SELECT amount,tax_rate,tax,extra_adults FROM lodging_charges WHERE stay_id=$1 AND kind='room_night'", [s2.id]);
    assert.deepEqual([paise(suitePosted.amount), Number(suitePosted.tax_rate), paise(suitePosted.tax), suitePosted.extra_adults], [suiteNight, 18, gst(suiteNight, 18), 1]);
    // Run again, twice at the same moment: nothing is posted twice.
    const twice = await Promise.all([desk.call('POST', L('lodging/night-audit'), {}), request('POST', L('lodging/night-audit'), {})]);
    assert.deepEqual(twice.map((a) => a.nights), [0, 0]);
    assert.equal((await one("SELECT count(*)::int AS n FROM lodging_charges WHERE stay_id IN ($1,$2) AND kind='room_night'", [s1.id, s2.id])).n, 3);
    // The database checks every night: the slab of its value, the stay's rate, a night that has come.
    const night = await one("SELECT * FROM lodging_charges WHERE stay_id=$1 AND kind='room_night' AND night=$2", [s1.id, today]);
    await assert.rejects(rows('UPDATE lodging_charges SET amount=1 WHERE id=$1', [night.id]), /kept as it was posted/);
    await assert.rejects(rows('DELETE FROM lodging_charges WHERE id=$1', [night.id]), /void it instead/);
    // A night with the stay's own extra rates (adult 1,000, child 500, bed 800), none of them used.
    const insert = (values) => rows(`INSERT INTO lodging_charges(business_id,stay_id,kind,night,room_id,sku_id,label,quantity,rate_kind,room_rate,extra_adults,extra_adult_rate,children,
      child_rate,extra_beds,extra_bed_rate,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,created_by)
      VALUES($1,$2,'room_night',$3,$4,$5,'Rule night',1,$6,$7,0,1000,0,500,0,800,$7,$7,'exclusive',$8,$9,$7,$10,$11)`, values);
    const s1Room = roomId('102');
    await assert.rejects(insert([lodge.id, s1.id, addDays(today, 1), s1Room, deluxe.sku_id, 'rack', '4500', gst5.id, '5', '225', ownerUser.id]), /not one of stay/);
    await rows("UPDATE lodging_charges SET voided_at=now(),voided_by=$2,void_reason='Rule' WHERE id=$1", [night.id, ownerUser.id]);
    const rate = weekend(today) ? 'weekend' : 'rack', amount = weekend(today) ? '5200' : '4500';
    await assert.rejects(insert([lodge.id, s1.id, today, s1Room, deluxe.sku_id, rate, amount, gst18.id, '18', rupees(gst(paise(amount), 18)), ownerUser.id]), /billed at the lower slab/);
    await assert.rejects(insert([lodge.id, s1.id, today, s1Room, deluxe.sku_id, rate, '3000', gst5.id, '5', '150', ownerUser.id]), /charged at the stay's rate for that night/);
    // Voided by mistake: posted again at the stay's rate, as the night audit posts it.
    const reposted = await request('POST', L('lodging/night-audit'), {});
    assert.equal(reposted.nights, 1);
  });

  await t.test('extras on the folio at their own slabs, and a charge voided by a manager', async () => {
    let stay = await desk.call('POST', L(`lodging/stays/${s1.id}/charges`), { requestKey: key(), skuId: laundry.id, quantity: '3', note: '3 shirts' }, 201);
    const dinnerKey = key();
    stay = await desk.call('POST', L(`lodging/stays/${s1.id}/charges`), { requestKey: dinnerKey, skuId: dinner.id, quantity: '1' }, 201);
    const extras = stay.charges.filter((x) => x.kind === 'extra');
    assert.deepEqual(extras.map((x) => [x.label, x.amount, x.tax_rate, x.tax]), [['Laundry (per piece) · 3 shirts', '150.00', '18.00', '27.00'], ['Room service dinner', '300.00', '5.00', '15.00']]);
    // A retry is the same charge; a room type's nights and goods from stock are not extras.
    await desk.call('POST', L(`lodging/stays/${s1.id}/charges`), { requestKey: dinnerKey, skuId: dinner.id, quantity: '1' }, 201);
    assert.equal((await one("SELECT count(*)::int AS n FROM lodging_charges WHERE stay_id=$1 AND kind='extra'", [s1.id])).n, 2);
    assert.equal((await refused('POST', L(`lodging/stays/${s1.id}/charges`), { requestKey: key(), skuId: deluxe.sku_id })).status, 409);
    // The front desk does not void; a manager does, with a reason.
    const dinnerCharge = extras.find((x) => x.label === 'Room service dinner');
    assert.equal((await refused('POST', L(`lodging/stays/${s1.id}/charges/${dinnerCharge.id}/void`), { reason: 'Not ordered' }, desk.token)).status, 403);
    stay = await request('POST', L(`lodging/stays/${s1.id}/charges/${dinnerCharge.id}/void`), { reason: 'Not ordered: another room\'s dinner' });
    assert.ok(stay.charges.find((x) => x.id === dinnerCharge.id).voided_at);
    // A room type's nights are billed from the folio only: refused on an ordinary bill.
    const loose = await refused('POST', L('documents'), { kind: 'sale', requestKey: key(), locationId: hotel.id, contactId: asha.id, lines: [{ skuId: deluxe.sku_id, quantity: '1' }] });
    assert.deepEqual([loose.status, loose.message], [409, 'Deluxe is a room type: its nights are billed on the stay\'s folio at check-out']);
  });

  await t.test('check-out bills the folio through the core with the advance first, the room left to be made up, housekeeping marks it clean', async () => {
    // Asha's family leaves today, a night early: tonight's night, posted by the audit, is not stayed.
    const preview = await desk.call('POST', L(`lodging/stays/${s1.id}/check-out/preview`), {});
    const total = nightsS1[0].net + nightsS1[0].tax + 15000 + 2700;
    assert.deepEqual([preview.early, preview.departure, preview.nightsNotStayed, preview.nightsToPost], [true, today, [today], []]);
    assert.deepEqual([preview.total, preview.advance, preview.due], [rupees(total), '2000.00', rupees(total - 200000)]);
    assert.deepEqual(preview.bill.map((b) => [b.taxRate, b.net]), [['5.00', rupees(nightsS1[0].net)], ['18.00', '150.00']]);
    const body = { requestKey: key(), payment: { amount: 'full', method: 'upi', reference: 'UPI-445566' } };
    const stay = await desk.call('POST', L(`lodging/stays/${s1.id}/check-out`), body);
    assert.deepEqual([stay.status, stay.departure, stay.room_status], ['checked_out', today, 'vacant_dirty']);
    assert.deepEqual([stay.bill.total, Number(stay.bill.due), stay.advance_summary.applied], [rupees(total), 0, '2000.00']);
    const doc = await request('GET', L(`documents/${stay.document_id}`));
    assert.deepEqual([doc.kind, doc.contact_id, doc.total, doc.place_of_supply], ['sale', asha.id, rupees(total), '36']);
    assert.deepEqual(doc.lines.map((l) => [l.label.replace(/night of .*/, 'night'), Number(l.tax_rate), l.net, l.tax]),
      [['Deluxe · room 102 · night', 5, rupees(nightsS1[0].net), rupees(nightsS1[0].tax)], ['Laundry (per piece) · 3 shirts', 18, '150.00', '27.00']]);
    assert.deepEqual(doc.payments.map((p) => [p.method, p.amount]).sort(), [['cash', '2000.00'], ['upi', rupees(total - 200000)]].sort());
    // Every charge billed or voided, the occupants gone (the foreigner's departure report due), a retry the same check-out.
    const charges = await rows('SELECT kind,night::text AS night,line_id,voided_at,void_reason FROM lodging_charges WHERE stay_id=$1 ORDER BY id', [s1.id]);
    assert.ok(charges.every((x) => x.line_id || x.voided_at));
    assert.match(charges.find((x) => x.kind === 'room_night' && x.night === today && x.void_reason?.startsWith('Checked out')).void_reason, /was not stayed/);
    assert.ok((await rows('SELECT departed_at FROM lodging_stay_guests WHERE stay_id=$1', [s1.id])).every((g) => g.departed_at));
    const report = (await request('GET', L('lodging/form-iii'))).items.find((g) => g.full_name === 'John Smith');
    assert.equal(report.next.event, 'departure');
    assert.equal((await desk.call('POST', L(`lodging/stays/${s1.id}/check-out`), body)).document_id, stay.document_id);
    assert.equal((await refused('POST', L(`lodging/stays/${s1.id}/check-out`), { ...body, payment: { amount: 'full', method: 'cash' } })).status, 409);
    // Housekeeping makes the room up; the desk sees it ready.
    assert.equal((await refused('POST', L(`lodging/stays/${s1.id}/check-out`), { requestKey: key() }, keeper.token)).status, 403);
    const made = await keeper.call('POST', L(`lodging/rooms/${roomId('102')}/status`), { status: 'vacant_clean' });
    assert.equal(made.room.status, 'vacant_clean');
    const board = await desk.call('GET', L('lodging/rooms/board'));
    assert.equal(board.rooms.find((r) => r.room_no === '102').status, 'vacant_clean');
    // A checked-out stay no longer changes; its occupants' details are kept.
    await assert.rejects(rows("UPDATE lodging_stays SET notes='x' WHERE id=$1", [s1.id]), /is checked out and no longer changes/);
    await assert.rejects(rows("UPDATE lodging_stay_guests SET full_name='x' WHERE stay_id=$1", [s1.id]), /has left/);
    await assert.rejects(rows('DELETE FROM lodging_stay_guests WHERE stay_id=$1', [s1.id]), /never deleted/);
    await assert.rejects(rows('DELETE FROM lodging_stays WHERE id=$1', [s1.id]), /never deleted/);
  });

  await t.test('a company billed with its GSTIN, supplied where the property is; a guest\'s own bill paid in full unless a manager agrees', async () => {
    // The Suite, billed to the company in Maharashtra from a hotel in Telangana: the company's GSTIN on the invoice, the place of supply the hotel's state.
    const stay = await desk.call('POST', L(`lodging/stays/${s2.id}/check-out`), { requestKey: key() });
    const doc = await request('GET', L(`documents/${stay.document_id}`));
    const suiteNight = (weekend(today) ? 850000 : 700000) + 150000;
    assert.deepEqual([doc.contact_id, doc.buyer_gstin, doc.place_of_supply, doc.total], [company.id, '27AAPFU0939F1ZV', '36', rupees(suiteNight + gst(suiteNight, 18))]);
    assert.deepEqual(doc.lines.map((l) => Number(l.tax_rate)), [18]);
    assert.equal(Number(stay.bill.due), (suiteNight + gst(suiteNight, 18)) / 100, 'left on the company\'s dues');
    // A walk-in in room 101 tonight, checked out by the front desk: their own bill is paid in full.
    const walkIn = await desk.call('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Ravi Kumar', phone: '9000012345' }, source: 'walk_in',
      arrival: today, departure: addDays(today, 1), roomTypeId: deluxe.id, adults: 1 }, 201);
    await desk.call('POST', L(`lodging/stays/${walkIn.id}/check-in`), { requestKey: key(), roomId: roomId('101'), guests: [{ fullName: 'Ravi Kumar', idKind: 'voter_id', idRef: 'TSV7654321' }] });
    const owing = await refused('POST', L(`lodging/stays/${walkIn.id}/check-out`), { requestKey: key() }, desk.token);
    assert.equal(owing.status, 409);
    assert.match(owing.message, /left to pay on the bill: take the payment, or have a manager check the guest out/);
    const night = weekend(today) ? 520000 : 450000;
    const paid = await desk.call('POST', L(`lodging/stays/${walkIn.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    assert.deepEqual([paid.status, paid.bill.total, Number(paid.bill.due)], ['checked_out', rupees(night + gst(night, 5)), 0]);
  });

  await t.test('cancellations and no-shows: a cancellation charge at the first night\'s slab paid from the advance, the rest handed back with a PIN', async () => {
    const booking = await request('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, contactId: asha.id, arrival: addDays(thursday, 28), departure: addDays(thursday, 29),
      roomTypeId: suite.id, adults: 2, advance: { amount: '1000', method: 'cash' } }, 201);
    // A no-show is marked once the arrival day has come.
    assert.equal((await refused('POST', L(`lodging/stays/${booking.id}/cancel`), { requestKey: key(), reason: 'Did not come', noShow: true })).status, 409);
    // The front desk cancels but does not hand money back.
    assert.equal((await refused('POST', L(`lodging/stays/${booking.id}/cancel`), { requestKey: key(), reason: 'Plans changed', refund: { method: 'cash' }, approval }, desk.token)).status, 403);
    // A Thursday at 7,000 is the 5% slab: a charge of 500 + 25.00 GST, paid from the advance; 475.00 handed back with the manager's PIN.
    const body = { requestKey: key(), reason: 'Plans changed', charge: '500', refund: { method: 'cash' }, approval };
    const cancelled = await request('POST', L(`lodging/stays/${booking.id}/cancel`), body);
    assert.deepEqual([cancelled.status, cancelled.bill.total, Number(cancelled.bill.due), cancelled.advance_summary.applied, cancelled.advance_summary.refunded],
      ['cancelled', '525.00', 0, '525.00', '475.00']);
    const doc = await request('GET', L(`documents/${cancelled.document_id}`));
    assert.deepEqual(doc.lines.map((l) => [Number(l.tax_rate), l.net, l.tax]), [[5, '500.00', '25.00']]);
    assert.equal((await request('POST', L(`lodging/stays/${booking.id}/cancel`), body)).status, 'cancelled');
    assert.equal((await one("SELECT source FROM business_collection_refunds WHERE business_id=$1 ORDER BY id DESC LIMIT 1", [lodge.id])).source, 'lodging');
    // Today's arrival who never came: a no-show, nothing charged.
    const noShow = await desk.call('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Prakash Iyer' }, arrival: today, departure: addDays(today, 1),
      roomTypeId: deluxe.id, adults: 1 }, 201);
    assert.equal((await desk.call('POST', L(`lodging/stays/${noShow.id}/cancel`), { requestKey: key(), reason: 'Did not arrive', noShow: true })).status, 'no_show');
  });

  await t.test('the guest register: every occupant with their ID details, for those who print it', async () => {
    const register = await desk.call('GET', L(`lodging/register?from=${daysFrom(-1)}&to=${today}`));
    const names = register.items.map((g) => g.full_name);
    for (const name of ['Asha Rao', 'John Smith', 'Vikram Shah', 'Neha Shah', 'Rohan Shah', 'Ravi Kumar']) assert.ok(names.includes(name), `${name} is in the register`);
    const john = register.items.find((g) => g.full_name === 'John Smith');
    assert.deepEqual([john.nationality, john.id_ref, john.visa_type, john.visa_no, john.next_destination, john.frro_arrival_ack], ['British', 'GB5544332', 'e-Tourist visa', 'ETV998877',
      'Goa, India', 'FRRO/HYD/2026/000123']);
    assert.equal(register.items.find((g) => g.full_name === 'Asha Rao').id_ref, '1234');
    // Housekeeping neither prints the register nor sees guests' IDs or money.
    assert.equal((await refused('GET', L(`lodging/register?from=${today}&to=${today}`), undefined, keeper.token)).status, 403);
    assert.equal((await refused('GET', L('lodging/form-iii'), undefined, keeper.token)).status, 403);
    const seen = await keeper.call('GET', L(`lodging/stays/${s1.id}`));
    assert.deepEqual([seen.ids, seen.money, seen.guests[0].id_ref, seen.estimate_total], [false, false, null, null]);
    assert.equal((await refused('POST', L('lodging/stays'), { requestKey: key() }, keeper.token)).status, 403);
    // The front desk changes no settings and adds no room types.
    assert.equal((await refused('PUT', L('lodging/settings'), { terms: 'x' }, desk.token)).status, 403);
    assert.equal((await refused('POST', L('lodging/room-types'), { item: { name: 'X' }, baseOccupancy: 1, rates: { rack: '1' } }, desk.token)).status, 403);
  });

  await t.test('a stay\'s advances pay only its own bill: "apply advance" leaves them alone', async () => {
    const pickup = await service('Airport pickup', 'PICKUP', 600, gst18.id);
    const guest = await customer('Meera Pillai', { phone: '9000012399', creditDays: 15 });
    await request('POST', L('documents'), { kind: 'sale', requestKey: key(), locationId: hotel.id, contactId: guest.id, lines: [{ skuId: pickup.id, quantity: '1' }] }, 201);
    await request('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, contactId: guest.id, arrival: addDays(thursday, 35), departure: addDays(thursday, 36),
      roomTypeId: deluxe.id, adults: 1, advance: { amount: '1500', method: 'upi', reference: 'UPI-1' } }, 201);
    const applied = await refused('POST', L(`receivables/customers/${guest.id}/apply-advance`), { requestKey: key() });
    assert.equal(applied.status, 409);
    assert.match(applied.message, /no advance to apply/);
  });

  await t.test('the desk, the calendar, the bell, audit and events', async () => {
    const day = await desk.call('GET', L('lodging/desk'));
    assert.deepEqual([day.today, day.counts.inHouse, day.audit.ready], [today, 0, true]);
    const calendar = await request('GET', L(`lodging/calendar?from=${thursday}&days=14`));
    const deluxeRow = calendar.types.find((x) => x.name === 'Deluxe');
    assert.equal(deluxeRow.left[0].left, 0, 'both Deluxe rooms are taken on that Thursday');
    assert.equal(deluxeRow.rooms.find((r) => r.roomNo === '101').nights[0].stay.status, 'reserved');
    const free = await request('GET', L(`lodging/free?arrival=${thursday}&departure=${addDays(thursday, 1)}&roomType=${deluxe.id}`));
    assert.match(free.rooms.find((r) => r.roomNo === '101').clash.words, /^Room 101 is booked by ST\//);
    // A foreign guest whose arrival report is a day late: the bell rings.
    const late = await request('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Anna Muller' }, arrival: today, departure: addDays(today, 2),
      roomTypeId: deluxe.id, adults: 1 }, 201);
    await request('POST', L(`lodging/stays/${late.id}/check-in`), { requestKey: key(), roomId: roomId('102'), guests: [{ fullName: 'Anna Muller', foreigner: true, nationality: 'German',
      idKind: 'passport', idRef: 'C01X00T47', visaType: 'OCI card', visaNo: 'A1234567', arrivedIndiaOn: daysFrom(-2), nextDestination: 'Delhi, India' }] });
    await backdate(late.id, 2);
    const bell = await request('GET', L('notifications'));
    const ring = bell.items.find((i) => i.category === 'Form-III');
    assert.deepEqual([ring.severity, ring.title], ['critical', 'Form-III arrival report of Anna Muller is overdue']);
    assert.ok(bell.items.some((i) => i.category === 'Night audit'), 'nights from before today not posted are in the bell');
    assert.equal((await request('GET', L('lodging/form-iii'))).counts.overdue, 1);
    const actions = (await rows('SELECT DISTINCT action FROM business_audit WHERE business_id=$1', [lodge.id])).map((r) => r.action);
    for (const action of ['lodging_room_type.created', 'lodging_room.created', 'lodging_room.status_changed', 'lodging_stay.reserved', 'lodging_stay.checked_in', 'lodging.night_audit',
      'lodging_charge.posted', 'lodging_charge.voided', 'lodging_guest.form_iii_reported', 'lodging_stay.checked_out', 'lodging_stay.cancelled', 'lodging_stay.no_show', 'collection.refunded']) {
      assert.ok(actions.includes(action), `audit ${action}`);
    }
    const kinds = (await rows('SELECT DISTINCT kind FROM business_events WHERE business_id=$1', [lodge.id])).map((r) => r.kind);
    for (const kind of ['lodging_stay.reserved', 'lodging_stay.checked_in', 'lodging_stay.nights_posted', 'lodging_stay.checked_out', 'lodging_guest.form_iii_reported', 'sale.posted']) {
      assert.ok(kinds.includes(kind), `event ${kind}`);
    }
    // History is kept as it was written.
    await assert.rejects(rows("UPDATE lodging_stay_events SET note='x' WHERE stay_id=$1", [s1.id]), /kept as it was written/);
    await assert.rejects(rows("UPDATE lodging_room_status_log SET note='x' WHERE room_id=$1", [roomId('102')]), /kept as it was written/);
    await assert.rejects(rows('DELETE FROM lodging_receipts WHERE stay_id=$1', [s1.id]), /stays with it/);
    // Another owner's lodge holds none of it.
    assert.equal((await one('SELECT count(*)::int AS n FROM lodging_stays WHERE business_id=$1', [elsewhere.id])).n, 0);
  });
});
