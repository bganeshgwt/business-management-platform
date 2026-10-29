const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A hotel's, lodge's or guest house's house: out-of-order periods booked
// ahead and taken off the room type's sale on the server (a reservation that
// needs the room refused with the reason, two saved at once included), out of
// service still on sale, the cleaning steps with who and when and inspection
// before a room is let, do not disturb, linen and minibar checks with the
// minibar posted to the folio, maintenance tickets, the night audit's no-shows
// on the business's clock and its day close, occupancy, ADR and RevPAR on a
// fixed set of stays, and a group of properties: rate plans per property, one
// calendar, a guest moved from one property to another with GST per property.
// Refusals with their exact codes, idempotent retries, the database's own
// rules, audit and events. Runs on its own throwaway database with every
// migration applied.
test('hotels, lodges and guest houses: housekeeping, maintenance, the night audit, reports and a group of properties', { timeout: 600000 }, async (t) => {
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
      const tables = ['lodging_out_of_order', 'lodging_tickets', 'lodging_checklist_items', 'lodging_room_checks', 'lodging_room_check_lines', 'lodging_night_audits'];
      const left = async () => (await probe.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
      const column = async (table, name) => (await probe.query('SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, name])).rows[0].n;
      assert.equal(await left(), tables.length);
      const stamp = Number(require('node:fs').readdirSync(dir).find((file) => file.endsWith('_lodging-house.sql')).split('_')[0]);
      await migrate({ direction: 'down', count: stamp, timestamp: true });
      assert.equal(await left(), 0);
      for (const [table, name] of [['lodging_rooms', 'cleaning'], ['lodging_rooms', 'dnd'], ['lodging_rooms', 'out_of_service'], ['lodging_settings', 'no_show_cutoff'],
        ['lodging_settings', 'inspection_required'], ['lodging_rate_plans', 'location_id'], ['lodging_stays', 'moved_from_stay_id']]) assert.equal(await column(table, name), 0, `${table}.${name} is gone`);
      await migrate({ direction: 'up', count: Infinity });
      assert.equal(await left(), tables.length);
    } finally { await probe.end(); }
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `House-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('house-owner');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('house-owner@test.invalid');
  const request = as(ownerToken);
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const today = daysFrom(0);
  const tomorrow = daysFrom(1);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
  const D = daysFrom(10);

  const [lodge, grocery] = await createBusinesses(request, 'HOUSE', ['lodging', 'grocery']);
  const L = (suffix) => `/businesses/${lodge.id}/${suffix}`;
  const hotel = (await request('GET', L('locations'))).items[0];
  await request('PATCH', L(`locations/${hotel.id}`), { name: hotel.name, stateCode: '36', city: 'Hyderabad' });
  await request('PUT', L('modules/inventory'), { enabled: true });
  const slabsOf = async (route) => (await request('GET', route('tax-rates?limit=100'))).items;
  const slabs = await slabsOf(L);
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const roles = (await request('GET', L('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', L('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('house-desk@test.invalid', 'front_desk');
  const keeper = await staff('house-keeping@test.invalid', 'housekeeping');
  const cashier = await staff('house-cashier@test.invalid', 'cashier');
  const manager = await staff('house-manager@test.invalid', 'manager');
  const occupant = (fullName, extra = {}) => ({ fullName, idKind: 'voter_id', idRef: `HSV${crypto.randomBytes(3).toString('hex').toUpperCase()}`, ...extra });

  await request('PUT', L('lodging/settings'), { lowTaxRateId: gst5.id, highTaxRateId: gst18.id });
  let list = await request('POST', L('lodging/room-types'), { item: { name: 'Deluxe', hsnCode: '996311' }, baseOccupancy: 2, maxOccupancy: 3, rates: { rack: '4500', weekend: '5200' } }, 201);
  const deluxe = list.roomTypes.find((r) => r.name === 'Deluxe');
  list = await request('POST', L('lodging/room-types'), { item: { name: 'Suite' }, baseOccupancy: 2, maxOccupancy: 4, rates: { rack: '7000' } }, 201);
  const suite = list.roomTypes.find((r) => r.name === 'Suite');
  await request('POST', L('lodging/rooms'), { locationId: hotel.id, roomTypeId: deluxe.id, rooms: ['101', '102', '103', '104'].map((roomNo) => ({ roomNo })) }, 201);
  const setup = await request('POST', L('lodging/rooms'), { locationId: hotel.id, roomTypeId: suite.id, rooms: [{ roomNo: '201' }] }, 201);
  const roomId = (no) => setup.rooms.find((r) => r.room_no === no).id;
  const water = await request('POST', L('catalog'), { kind: 'goods', unit: 'each', name: 'Mineral water 1 L', code: 'WATER-1L', price: '50', taxRateId: gst18.id, tracking: 'quantity',
    openingStock: { locationId: hotel.id, quantity: '10', unitCost: '15' } }, 201);
  const laundry = await request('POST', L('catalog'), { kind: 'service', unit: 'service', name: 'Laundry (per piece)', code: 'LND-PC', price: '50', taxRateId: gst18.id }, 201);
  const stockOf = async (skuId) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3', [lodge.id, hotel.id, skuId])).q);
  const reserve = (body, as2 = request, expected = 201) => as2('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, roomTypeId: deluxe.id, adults: 1, ...body }, expected);
  const checkIn = (stay, room, name = stay.guest_name) => request('POST', L(`lodging/stays/${stay.id}/check-in`), { requestKey: key(), roomId: roomId(room), guests: [occupant(name)] });
  const board = async () => (await request('GET', L('lodging/rooms/board'))).rooms;
  const roomOf = async (no) => (await board()).find((r) => r.room_no === no);

  await t.test('the house belongs to lodging: other types are refused, and housekeeping sees no reports', async () => {
    assert.equal((await refused('GET', `/businesses/${grocery.id}/lodging/out-of-order`)).status, 403);
    assert.equal((await refused('POST', `/businesses/${grocery.id}/lodging/tickets`, { requestKey: key() })).status, 403);
    assert.equal((await refused('GET', L('lodging/reports'), undefined, keeper.token)).status, 403);
    assert.equal((await refused('POST', L('lodging/night-audit'), {}, keeper.token)).status, 403);
    assert.equal((await refused('PUT', L('lodging/checklists'), { roomTypeId: deluxe.id, items: [] }, keeper.token)).status, 403);
    // A room starts clean, not out of order or out of service.
    const room = await roomOf('101');
    assert.deepEqual([room.status, room.cleaning, room.out_of_order, room.out_of_service, room.dnd], ['vacant_clean', 'clean', null, false, false]);
  });

  let period;
  await t.test('out of order ahead: off the room type\'s sale for its nights, a reservation that needs the room refused with the reason, two at once included', async () => {
    const periodBody = { requestKey: key(), roomId: roomId('104'), startsOn: D, endsOn: addDays(D, 1), reason: 'Bathroom tiles relaid' };
    const made = await keeper.call('POST', L('lodging/out-of-order'), periodBody, 201);
    period = made.period;
    assert.deepEqual([period.starts_on, period.ends_on, period.reason, made.repeated], [D, addDays(D, 1), 'Bathroom tiles relaid', false]);
    // Retried: the same period; the same key for another one: refused.
    assert.equal((await keeper.call('POST', L('lodging/out-of-order'), periodBody, 201)).period.id, period.id);
    assert.equal((await refused('POST', L('lodging/out-of-order'), { ...periodBody, reason: 'Other' }, keeper.token)).status, 409);
    // Four Deluxe rooms, one out of order on D: three reservations, and the fourth refused with the reason.
    const onD = [];
    for (const name of ['Guest One', 'Guest Two', 'Guest Three']) onD.push(await reserve({ guest: { name }, arrival: D, departure: addDays(D, 1) }));
    const full = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, roomTypeId: deluxe.id, adults: 1, guest: { name: 'Guest Four' }, arrival: D, departure: addDays(D, 1) });
    assert.deepEqual([full.status, full.message], [409,
      `Every Deluxe room is taken on the night of ${day(D)} (3 stays for 4 rooms, 1 out of order: room 104: Bathroom tiles relaid): choose other dates or another room type`]);
    const preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, roomTypeId: deluxe.id, adults: 1, arrival: D, departure: addDays(D, 1) });
    assert.deepEqual([preview.typeFree, preview.typeWords], [false, full.message]);
    // The room named: refused with the reason.
    const named = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, roomTypeId: deluxe.id, adults: 1, guest: { name: 'Guest Five' },
      arrival: addDays(D, 1), departure: addDays(D, 2), roomId: roomId('104') });
    assert.deepEqual([named.status, named.message], [409, `Room 104 is out of order from ${day(D)} to ${day(addDays(D, 1))} (Bathroom tiles relaid): choose another room`]);
    // Two saved at the same moment for the last room in order on D+1: one wins.
    await reserve({ guest: { name: 'Guest Six' }, arrival: addDays(D, 1), departure: addDays(D, 2) });
    await reserve({ guest: { name: 'Guest Seven' }, arrival: addDays(D, 1), departure: addDays(D, 2) });
    const body = (name) => ({ requestKey: key(), locationId: hotel.id, roomTypeId: deluxe.id, adults: 1, guest: { name }, arrival: addDays(D, 1), departure: addDays(D, 2) });
    const pair = await Promise.all([call('POST', L('lodging/stays'), body('Guest Eight'), ownerToken), call('POST', L('lodging/stays'), body('Guest Nine'), ownerToken)]);
    assert.deepEqual(pair.map((r) => r.status).sort(), [201, 409]);
    assert.match(pair.find((r) => r.status === 409).body.message, /1 out of order: room 104: Bathroom tiles relaid/);
    // The database refuses a stay put in the room over its nights, whatever the screen did.
    await assert.rejects(rows('UPDATE lodging_stays SET room_id=$2 WHERE id=$1', [onD[0].id, roomId('104')]), /Room 104 is out of order from/);
    // A room held by a stay is not put out of order over its nights; nor a room its type's stays need.
    const holder = await reserve({ guest: { name: 'Room Holder' }, arrival: addDays(D, 5), departure: addDays(D, 6), roomId: roomId('101') });
    const held = await refused('POST', L('lodging/out-of-order'), { roomId: roomId('101'), startsOn: addDays(D, 5), reason: 'Painting' }, keeper.token);
    assert.deepEqual([held.status, held.message], [409, `Room 101 is booked by ${holder.stay_no} (Room Holder) for the night of ${day(addDays(D, 5))}: move the stay to another room first`]);
    const needed = await refused('POST', L('lodging/out-of-order'), { roomId: roomId('103'), startsOn: D, endsOn: D, reason: 'Painting' }, keeper.token);
    assert.deepEqual([needed.status, needed.message], [409, `Room 103 is needed: 3 Deluxe stays are booked on the night of ${day(D)}, with 2 of its rooms in order then`]);
    // Booked from a day gone: refused; a period over the same night of the room: refused.
    assert.equal((await refused('POST', L('lodging/out-of-order'), { roomId: roomId('103'), startsOn: daysFrom(-1), reason: 'Painting' }, keeper.token)).status, 400);
    const twice = await refused('POST', L('lodging/out-of-order'), { roomId: roomId('104'), startsOn: addDays(D, 1), reason: 'Again' }, keeper.token);
    assert.deepEqual([twice.status, twice.message], [409, `Room 104 is out of order from ${day(D)} to ${day(addDays(D, 1))} (Bathroom tiles relaid) already: change that period instead`]);
    // Changed: its last night D; then stretched over a stay that holds the room: refused.
    const shorter = await keeper.call('PATCH', L(`lodging/out-of-order/${period.id}`), { endsOn: D });
    assert.equal(shorter.period.ends_on, D);
    const later = await reserve({ guest: { name: 'Later Guest' }, arrival: addDays(D, 2), departure: addDays(D, 3), roomId: roomId('104') });
    const longer = await refused('PATCH', L(`lodging/out-of-order/${period.id}`), { endsOn: addDays(D, 3) }, keeper.token);
    assert.deepEqual([longer.status, longer.message], [409, `Room 104 is booked by ${later.stay_no} (Later Guest) for the night of ${day(addDays(D, 2))}: move the stay to another room first`]);
    // A period is never deleted.
    await assert.rejects(rows('DELETE FROM lodging_out_of_order WHERE id=$1', [period.id]), /never deleted/);
  });

  let suiteTonight;
  await t.test('out of order tonight counts too: the room off sale, on the board and the calendar, and back in order', async () => {
    const tonight = await keeper.call('POST', L('lodging/out-of-order'), { requestKey: key(), roomId: roomId('201'), reason: 'AC not cooling' }, 201);
    assert.deepEqual([tonight.period.starts_on, tonight.period.ends_on], [today, null]);
    const full = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, roomTypeId: suite.id, adults: 1, guest: { name: 'Suite Guest' }, arrival: today, departure: tomorrow });
    assert.deepEqual([full.status, full.message], [409, `Every Suite room is taken on the night of ${day(today)} (0 stays for 1 room, 1 out of order: room 201: AC not cooling): choose other dates or another room type`]);
    const room = await roomOf('201');
    assert.deepEqual([room.status, room.out_of_order.reason, room.ready], ['out_of_order', 'AC not cooling', false]);
    assert.equal((await request('GET', L('lodging/desk'))).rooms.out_of_order, 1);
    const calendar = await request('GET', L(`lodging/calendar?from=${today}&days=3`));
    const suiteRow = calendar.types.find((x) => x.name === 'Suite');
    assert.deepEqual([suiteRow.rooms[0].nights[0].down, suiteRow.left[0].left, suiteRow.rooms[0].status], ['AC not cooling', 0, 'out_of_order']);
    const free = await request('GET', L(`lodging/free?arrival=${today}&departure=${tomorrow}&roomType=${suite.id}`));
    assert.deepEqual([free.rooms[0].free, free.rooms[0].clash.words], [false, 'Room 201 is out of order from ' + day(today) + ' until it is put back in order (AC not cooling)']);
    // Back in order today: a period begun today is withdrawn, and the Suite sells tonight.
    const back = await keeper.call('POST', L(`lodging/out-of-order/${tonight.period.id}/back`), {});
    assert.ok(back.period.cancelled_at);
    assert.equal((await roomOf('201')).status, 'vacant_clean');
    suiteTonight = await reserve({ guest: { name: 'Suite Guest' }, roomTypeId: suite.id, arrival: today, departure: tomorrow });
    assert.equal((await refused('POST', L(`lodging/out-of-order/${tonight.period.id}/back`), {}, keeper.token)).status, 409, 'withdrawn, it is over');
  });

  let s102;
  await t.test('out of service: flagged with why, the room still sold and let', async () => {
    assert.deepEqual(await refused('POST', L(`lodging/rooms/${roomId('102')}/flags`), { outOfService: true }, keeper.token).then((r) => [r.status, r.message]),
      [400, 'Say why the room is out of service']);
    const flagged = await keeper.call('POST', L(`lodging/rooms/${roomId('102')}/flags`), { outOfService: true, note: 'TV not working' });
    assert.deepEqual([flagged.room.out_of_service, flagged.room.out_of_service_note, flagged.room.status], [true, 'TV not working', 'vacant_clean']);
    s102 = await reserve({ guest: { name: 'Flag Guest' }, arrival: today, departure: tomorrow, roomId: roomId('102') });
    const stay = await checkIn(s102, '102');
    assert.equal(stay.status, 'in_house');
    const free = await request('GET', L(`lodging/free?arrival=${D}&departure=${addDays(D, 1)}&roomType=${deluxe.id}`));
    assert.deepEqual([free.rooms.find((r) => r.roomNo === '102').outOfService], ['TV not working']);
  });

  let s101;
  await t.test('cleaning steps with who and when, inspection before a room is let, and do not disturb', async () => {
    // Do not disturb on a guest's room: no cleaning starts while it is on; it is for a guest's room only.
    await keeper.call('POST', L(`lodging/rooms/${roomId('102')}/flags`), { dnd: true });
    await keeper.call('POST', L(`lodging/rooms/${roomId('102')}/status`), { cleaning: 'dirty' });
    const dnd = await refused('POST', L(`lodging/rooms/${roomId('102')}/status`), { cleaning: 'cleaning' }, keeper.token);
    assert.deepEqual([dnd.status, dnd.message], [409, 'Room 102\'s guest asked not to be disturbed: clean it once they take the sign off']);
    const vacant = await refused('POST', L(`lodging/rooms/${roomId('103')}/flags`), { dnd: true }, keeper.token);
    assert.deepEqual([vacant.status, vacant.message], [409, 'Room 103 has no guest in it: do not disturb is for a guest\'s room']);
    // Room 103: dirty → being cleaned → clean → inspected, each with who and when.
    let made = await keeper.call('POST', L(`lodging/rooms/${roomId('103')}/status`), { cleaning: 'dirty' });
    assert.deepEqual([made.room.status, made.room.cleaning], ['vacant_dirty', 'dirty']);
    made = await keeper.call('POST', L(`lodging/rooms/${roomId('103')}/status`), { cleaning: 'cleaning' });
    assert.deepEqual([made.room.status, made.room.cleaning], ['vacant_dirty', 'cleaning']);
    const early = await refused('POST', L(`lodging/rooms/${roomId('103')}/status`), { cleaning: 'inspected' }, manager.token);
    assert.deepEqual([early.status, early.message], [409, 'Room 103 is being cleaned: a room is inspected once it is clean']);
    made = await keeper.call('POST', L(`lodging/rooms/${roomId('103')}/status`), { cleaning: 'clean' });
    assert.deepEqual([made.room.status, made.room.cleaning, Number(made.room.cleaned_by)], ['vacant_clean', 'clean', Number(keeper.id)]);
    made = await manager.call('POST', L(`lodging/rooms/${roomId('103')}/status`), { cleaning: 'inspected' });
    assert.deepEqual([made.room.cleaning, Number(made.room.inspected_by), Number(made.room.cleaned_by)], ['inspected', Number(manager.id), Number(keeper.id)]);
    assert.equal((await manager.call('POST', L(`lodging/rooms/${roomId('103')}/status`), { cleaning: 'inspected' })).repeated, true);
    const log = await rows('SELECT to_status,cleaning,created_by FROM lodging_room_status_log WHERE room_id=$1 ORDER BY id', [roomId('103')]);
    assert.deepEqual(log.map((l) => [l.cleaning, Number(l.created_by)]), [['clean', Number(ownerUser.id)], ['dirty', Number(keeper.id)], ['cleaning', Number(keeper.id)],
      ['clean', Number(keeper.id)], ['inspected', Number(manager.id)]]);
    assert.equal((await refused('POST', L(`lodging/rooms/${roomId('103')}/status`), { status: 'out_of_order' }, keeper.token)).status, 400);
    // Inspected before it is let: a guest checks in only to an inspected room, the database too.
    await request('PUT', L('lodging/settings'), { inspectionRequired: true });
    await keeper.call('POST', L(`lodging/rooms/${roomId('101')}/status`), { status: 'vacant_dirty' });
    await keeper.call('POST', L(`lodging/rooms/${roomId('101')}/status`), { status: 'vacant_clean' });
    s101 = await reserve({ guest: { name: 'Inspected Guest' }, arrival: today, departure: tomorrow });
    const notYet = await refused('POST', L(`lodging/stays/${s101.id}/check-in`), { requestKey: key(), roomId: roomId('101'), guests: [occupant('Inspected Guest')] });
    assert.deepEqual([notYet.status, notYet.message], [409, 'Room 101 is not inspected yet: a guest checks in to a room inspected after it was cleaned']);
    await manager.call('POST', L(`lodging/rooms/${roomId('101')}/status`), { cleaning: 'inspected' });
    assert.equal((await checkIn(s101, '101')).room_no, '101');
    await keeper.call('POST', L(`lodging/rooms/${roomId('103')}/status`), { cleaning: 'dirty' });
    await keeper.call('POST', L(`lodging/rooms/${roomId('103')}/status`), { cleaning: 'clean' });
    await assert.rejects(rows('UPDATE lodging_stays SET room_id=$2 WHERE id=$1', [s101.id, roomId('103')]), /Room 103 is not inspected yet/);
    await request('PUT', L('lodging/settings'), { inspectionRequired: false });
    assert.equal((await request('GET', L('lodging/setup'))).settings.inspectionRequired, false);
    // Checked out: the room is left dirty, do not disturb off.
    const out = await request('POST', L(`lodging/stays/${s102.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    assert.equal(out.status, 'checked_out');
    const room = await roomOf('102');
    assert.deepEqual([room.status, room.cleaning, room.dnd, room.out_of_service], ['vacant_dirty', 'dirty', false, true]);
  });

  let waterItem, towelItem;
  await t.test('linen and minibar checklists: the minibar the guest used posted to their folio as goods, leaving stock when billed', async () => {
    const notGoods = await refused('PUT', L('lodging/checklists'), { roomTypeId: deluxe.id, items: [{ kind: 'minibar', skuId: laundry.id, par: 2 }] });
    assert.deepEqual([notGoods.status, notGoods.message], [400, 'Laundry (per piece) is not goods kept by quantity: a minibar holds goods from stock']);
    const set = await request('PUT', L('lodging/checklists'), { roomTypeId: deluxe.id, items: [{ kind: 'linen', name: 'Bath towel', par: 2 }, { kind: 'minibar', skuId: water.id, par: 2 }] });
    towelItem = set.items.find((i) => i.kind === 'linen');
    waterItem = set.items.find((i) => i.kind === 'minibar');
    assert.deepEqual([towelItem.name, waterItem.name, waterItem.par], ['Bath towel', 'Mineral water 1 L', 2]);
    // The guest in 101 used both bottles: two on the folio as goods; the stock is all there until the folio is billed.
    const body = { requestKey: key(), kind: 'minibar', lines: [{ itemId: waterItem.id, found: 0 }] };
    const made = await keeper.call('POST', L(`lodging/rooms/${roomId('101')}/checks`), body, 201);
    assert.deepEqual([made.check.lines[0].short, made.check.lines[0].charged, made.check.lines[0].amount, made.check.stay_no], [2, '2.000', null, s101.stay_no]);
    let stay = await request('GET', L(`lodging/stays/${s101.id}`));
    assert.deepEqual(stay.charges.filter((x) => x.kind === 'goods').map((x) => [x.quantity, x.amount, x.tax, x.label]), [['2.000', '100.00', '18.00', 'Mineral water 1 L · Minibar, room 101']]);
    assert.equal(await stockOf(water.id), 10);
    // Retried: the same check, nothing charged twice; the same key with another count: refused.
    assert.equal((await keeper.call('POST', L(`lodging/rooms/${roomId('101')}/checks`), body, 201)).repeated, true);
    assert.equal((await refused('POST', L(`lodging/rooms/${roomId('101')}/checks`), { ...body, lines: [{ itemId: waterItem.id, found: 1 }] }, keeper.token)).status, 409);
    assert.equal((await rows("SELECT id FROM lodging_charges WHERE stay_id=$1 AND kind='goods'", [s101.id])).length, 1);
    // Every item on the list is counted; linen is recorded, not charged.
    const missing = await refused('POST', L(`lodging/rooms/${roomId('101')}/checks`), { requestKey: key(), kind: 'linen', lines: [] }, keeper.token);
    assert.deepEqual([missing.status, missing.message], [400, 'Count every item on the checklist: Bath towel not counted']);
    const linen = await keeper.call('POST', L(`lodging/rooms/${roomId('101')}/checks`), { requestKey: key(), kind: 'linen', lines: [{ itemId: towelItem.id, found: 1 }], note: 'One towel missing' }, 201);
    assert.deepEqual([linen.check.lines[0].short, linen.check.lines[0].charge_id], [1, null]);
    // A room with no guest: the minibar counted, nothing charged.
    const vacant = await keeper.call('POST', L(`lodging/rooms/${roomId('103')}/checks`), { requestKey: key(), kind: 'minibar', lines: [{ itemId: waterItem.id, found: 1 }] }, 201);
    assert.deepEqual([vacant.check.stay_id, vacant.check.lines[0].charge_id], [null, null]);
    assert.equal((await request('GET', L(`lodging/rooms/${roomId('101')}/checks`))).items.length, 2);
    // Checked out: the water leaves stock with the bill.
    stay = await request('POST', L(`lodging/stays/${s101.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const doc = await request('GET', L(`documents/${stay.document_id}`));
    assert.ok(doc.lines.some((l) => Number(l.sku_id) === Number(water.id) && Number(l.quantity) === 2 && l.net === '100.00'));
    assert.equal(await stockOf(water.id), 8);
    // A room check is kept as it was written.
    await assert.rejects(rows("UPDATE lodging_room_checks SET note='x' WHERE id=$1", [linen.check.id]), /kept as it was written/);
  });

  await t.test('maintenance tickets: by status and priority, with the out-of-order period the work needs, put back in order when done', async () => {
    // Until put back in order, room 103 would leave too few Deluxe rooms for the stays booked on D: refused; to a last night before then, booked.
    const tooLong = await refused('POST', L('lodging/tickets'), { requestKey: key(), roomId: roomId('103'), issue: 'Geyser leaking', outOfOrder: {} }, desk.token);
    assert.deepEqual([tooLong.status, tooLong.message], [409, `Room 103 is needed: 3 Deluxe stays are booked on the night of ${day(D)}, with 2 of its rooms in order then`]);
    const body = { requestKey: key(), roomId: roomId('103'), issue: 'Geyser leaking', priority: 'urgent', assignedTo: keeper.id, outOfOrder: { endsOn: addDays(today, 2) } };
    const opened = await desk.call('POST', L('lodging/tickets'), body, 201);
    assert.deepEqual([opened.ticket.ticket_no, opened.ticket.status, opened.ticket.priority, opened.ticket.assigned_name, opened.ticket.out_of_order_from, opened.ticket.out_of_order_to],
      [1, 'open', 'urgent', 'house-keeping', today, addDays(today, 2)]);
    assert.equal((await desk.call('POST', L('lodging/tickets'), body, 201)).ticket.id, opened.ticket.id);
    assert.equal((await refused('POST', L('lodging/tickets'), { ...body, priority: 'low' }, desk.token)).status, 409);
    assert.equal((await roomOf('103')).status, 'out_of_order');
    assert.equal((await refused('POST', L('lodging/tickets'), { requestKey: key(), roomId: roomId('103'), issue: 'X', assignedTo: 999999 }, desk.token)).status, 404);
    assert.equal((await refused('POST', L('lodging/tickets'), { requestKey: key(), roomId: roomId('103'), issue: 'X', priority: 'soon' }, desk.token)).status, 400);
    const second = (await keeper.call('POST', L('lodging/tickets'), { requestKey: key(), roomId: roomId('101'), issue: 'Curtain rod loose', priority: 'low' }, 201)).ticket;
    const third = (await keeper.call('POST', L('lodging/tickets'), { requestKey: key(), roomId: roomId('104'), issue: 'Door lock sticks', priority: 'high',
      outOfOrder: { startsOn: addDays(D, 20), endsOn: addDays(D, 21) } }, 201)).ticket;
    let page = await request('GET', L('lodging/tickets?open=true'));
    assert.deepEqual(page.items.map((x) => x.ticket_no), [1, third.ticket_no, second.ticket_no], 'urgent first, then high, then low');
    // Started, then done: the room back in order (its period, begun today, withdrawn).
    let step = await keeper.call('POST', L(`lodging/tickets/${opened.ticket.id}/start`), {});
    assert.deepEqual([step.ticket.status, step.ticket.started_by_name], ['in_progress', 'house-keeping']);
    page = await request('GET', L('lodging/tickets?open=true'));
    assert.equal(page.items[0].status, 'in_progress');
    step = await keeper.call('POST', L(`lodging/tickets/${opened.ticket.id}/done`), { outcome: 'Geyser replaced' });
    assert.deepEqual([step.ticket.status, step.ticket.outcome, step.ticket.out_of_order_withdrawn], ['done', 'Geyser replaced', true]);
    assert.equal((await roomOf('103')).status, 'vacant_clean');
    assert.equal((await keeper.call('POST', L(`lodging/tickets/${opened.ticket.id}/done`), {})).repeated, true);
    const closed = await refused('PATCH', L(`lodging/tickets/${opened.ticket.id}`), { priority: 'low' }, keeper.token);
    assert.deepEqual([closed.status, closed.message], [409, 'Ticket 1 is done and no longer changes']);
    // Cancelled with why; its period ahead withdrawn.
    assert.equal((await refused('POST', L(`lodging/tickets/${third.id}/cancel`), {}, keeper.token)).status, 400);
    step = await keeper.call('POST', L(`lodging/tickets/${third.id}/cancel`), { reason: 'Locksmith fixed it on the round' });
    assert.deepEqual([step.ticket.status, step.ticket.out_of_order_withdrawn], ['cancelled', true]);
    assert.equal((await refused('POST', L(`lodging/tickets/${third.id}/start`), {}, keeper.token)).status, 409);
    const changed = await keeper.call('PATCH', L(`lodging/tickets/${second.id}`), { priority: 'high', assignedTo: desk.id });
    assert.deepEqual([changed.ticket.priority, changed.ticket.assigned_name], ['high', 'house-desk']);
    // The database keeps tickets and their steps.
    await assert.rejects(rows('DELETE FROM lodging_tickets WHERE id=$1', [second.id]), /never deleted/);
    await assert.rejects(rows("UPDATE lodging_tickets SET issue='x' WHERE id=$1", [opened.ticket.id]), /is done and no longer changes/);
  });

  await t.test('the night audit marks the day\'s no-shows past the cut-off on the business\'s clock, the charge by the policy, and closes the day', async () => {
    const policy = (await request('POST', L('lodging/policies'), { name: 'No-show: first night', noShowKind: 'first_night' }, 201)).policies.find((p) => p.name === 'No-show: first night');
    const plan = (await request('POST', L('lodging/rate-plans'), { roomTypeId: deluxe.id, name: 'Guaranteed', mealPlan: 'EP', policyId: policy.id }, 201)).plans.find((p) => p.name === 'Guaranteed');
    // The cut-off at midnight: a reservation for today not checked in is past it already.
    await request('PUT', L('lodging/settings'), { noShowCutoff: '00:00' });
    const charged = await reserve({ guest: { name: 'No Show One' }, arrival: today, departure: tomorrow, ratePlanId: plan.id, agreedRate: '4000', advance: { amount: '2000', method: 'cash' } });
    const free = await reserve({ guest: { name: 'No Show Two' }, arrival: today, departure: tomorrow });
    const later = await reserve({ guest: { name: 'Tomorrow Guest' }, arrival: tomorrow, departure: addDays(tomorrow, 1) });
    // The cashier may not cancel: the audit lists them and marks none.
    const listed = await cashier.call('POST', L('lodging/night-audit'), {});
    assert.deepEqual([listed.noShows.length, listed.noShowCutoff], [0, '00:00']);
    assert.ok([charged.stay_no, free.stay_no].every((no) => listed.noShowsLeft.some((x) => x.stayNo === no)));
    assert.ok(!listed.noShowsLeft.some((x) => x.stayNo === later.stay_no), 'a reservation for tomorrow is not past its cut-off');
    // The front desk's audit marks them: the first night by the policy (4,000 with 5% GST), paid first from the advance; none under no policy.
    const audit = await desk.call('POST', L('lodging/night-audit'), {});
    const one1 = audit.noShows.find((x) => x.stayNo === charged.stay_no), two = audit.noShows.find((x) => x.stayNo === free.stay_no);
    assert.deepEqual([one1.charge, one1.total, two.charge, two.documentNo], ['4000.00', '4200.00', '0.00', null]);
    assert.ok(!audit.noShows.some((x) => x.stayNo === later.stay_no));
    const stay = await request('GET', L(`lodging/stays/${charged.id}`));
    assert.deepEqual([stay.status, stay.bill.total, stay.bill.paid, stay.bill.due], ['no_show', '4200.00', '2000.00', '2200.00']);
    assert.equal((await request('GET', L(`lodging/stays/${later.id}`))).status, 'reserved');
    assert.match(stay.cancel_reason, /^Not checked in by 00:00 on .*: marked by the night audit of /);
    // The day closed with the day close's money; the audit is kept; run again, nothing is marked twice.
    assert.ok(audit.dayClose && audit.dayClose.bills >= 1);
    assert.equal((await request('POST', L('lodging/night-audit'), {})).noShows.length, 0);
    const kept = await rows('SELECT day::text AS day,no_shows,day_close FROM lodging_night_audits WHERE business_id=$1 ORDER BY id', [lodge.id]);
    assert.deepEqual(kept.map((k) => [k.day, k.no_shows]).slice(-3), [[today, 0], [today, audit.noShows.length], [today, 0]]);
    const deskDay = await request('GET', L('lodging/desk'));
    assert.deepEqual([deskDay.audit.last.day, deskDay.audit.yesterdayOpen, deskDay.audit.noShowCutoff], [today, false, '00:00']);
    await assert.rejects(rows('UPDATE lodging_night_audits SET nights=9 WHERE business_id=$1', [lodge.id]), /kept as it was run/);
    await request('PUT', L('lodging/settings'), { noShowCutoff: null });
    assert.equal((await request('GET', L(`lodging/stays/${suiteTonight.id}`))).status, 'no_show', 'the Suite booked for tonight and not checked in, under no policy: no charge');
  });

  // --- A group of properties ------------------------------------------------------------------------------------------------
  const [chain] = await createBusinesses(request, 'GROUP', ['lodging']);
  const G = (suffix) => `/businesses/${chain.id}/${suffix}`;
  const first = (await request('GET', G('locations'))).items[0];
  await request('PATCH', G(`locations/${first.id}`), { name: 'Hotel A', stateCode: '36', city: 'Hyderabad' });
  const hotelA = { ...first, name: 'Hotel A' };
  const hotelB = await request('POST', G('locations'), { name: 'Hotel B', code: 'HB', stateCode: '29', city: 'Bengaluru' }, 201);
  const chainSlabs = await slabsOf(G);
  await request('PUT', G('lodging/settings'), { lowTaxRateId: chainSlabs.find((r) => Number(r.rate) === 5).id, highTaxRateId: chainSlabs.find((r) => Number(r.rate) === 18).id });
  list = await request('POST', G('lodging/room-types'), { item: { name: 'Deluxe' }, baseOccupancy: 2, maxOccupancy: 3, rates: { rack: '4500', weekend: '5200' } }, 201);
  const gDeluxe = list.roomTypes.find((r) => r.name === 'Deluxe');
  list = await request('POST', G('lodging/room-types'), { item: { name: 'Suite' }, baseOccupancy: 2, maxOccupancy: 4, rates: { rack: '7000' } }, 201);
  const gSuite = list.roomTypes.find((r) => r.name === 'Suite');
  await request('POST', G('lodging/rooms'), { locationId: hotelA.id, roomTypeId: gDeluxe.id, rooms: ['A1', 'A2', 'A3', 'A4'].map((roomNo) => ({ roomNo })) }, 201);
  await request('POST', G('lodging/rooms'), { locationId: hotelB.id, roomTypeId: gDeluxe.id, rooms: ['B1', 'B2'].map((roomNo) => ({ roomNo })) }, 201);
  const gSetup = await request('POST', G('lodging/rooms'), { locationId: hotelB.id, roomTypeId: gSuite.id, rooms: [{ roomNo: 'B3' }] }, 201);
  const gRoom = (no) => gSetup.rooms.find((r) => r.room_no === no).id;
  // Tonight a Deluxe night is 4,000 at every property (the room type's own rate for the date).
  await request('PUT', G('lodging/rate-days'), { roomTypeId: gDeluxe.id, from: today, to: today, roomRate: '4000' });
  const meals = await request('POST', G('catalog'), { kind: 'service', unit: 'service', name: 'Breakfast', code: 'BKF', price: '0', taxRateId: chainSlabs.find((r) => Number(r.rate) === 5).id }, 201);
  const bb = (await request('POST', G('lodging/rate-plans'), { roomTypeId: gDeluxe.id, name: 'BB', mealPlan: 'CP', mealSkuId: meals.id, mealAdultRate: '500' }, 201)).plans.find((p) => p.name === 'BB');
  const gReserve = (body, expected = 201) => request('POST', G('lodging/stays'), { requestKey: key(), roomTypeId: gDeluxe.id, adults: 1, ...body }, expected);
  const gCheckIn = (stay, room, guests = [occupant(stay.guest_name)]) => request('POST', G(`lodging/stays/${stay.id}/check-in`), { requestKey: key(), roomId: gRoom(room), guests });
  async function backdate(stayId, days) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE lodging_stays DISABLE TRIGGER lodging_stays_guard');
      await db.query('ALTER TABLE lodging_stay_guests DISABLE TRIGGER lodging_stay_guests_guard');
      await db.query('UPDATE lodging_stays SET arrival=arrival-$2::int,departure=departure-$2::int,checked_in_at=checked_in_at-make_interval(days=>$2::int) WHERE id=$1', [stayId, days]);
      await db.query(`WITH gone AS (DELETE FROM lodging_stay_nights WHERE stay_id=$1 RETURNING *)
        INSERT INTO lodging_stay_nights SELECT business_id,stay_id,night-$2::int,rate_kind,room_rate,extra_adult_rate,child_rate,extra_bed_rate,meal_sku_id,meal_adult_rate,meal_child_rate FROM gone`, [stayId, days]);
      await db.query('UPDATE lodging_stay_guests SET arrived_at=arrived_at-make_interval(days=>$2::int),created_at=created_at-make_interval(days=>$2::int) WHERE stay_id=$1', [stayId, days]);
      await db.query('ALTER TABLE lodging_stay_guests ENABLE TRIGGER lodging_stay_guests_guard');
      await db.query('ALTER TABLE lodging_stays ENABLE TRIGGER lodging_stays_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }

  let sA1, sA2;
  await t.test('occupancy, ADR and RevPAR for a fixed set of stays: per property and in all, by room type, source and plan', async () => {
    // A3 out of order tonight; tonight A1 a walk-in at 4,000, A2 an OTA's at 3,500, B1 on BB (two adults, their breakfast not room revenue).
    await request('POST', G('lodging/out-of-order'), { roomId: gRoom('A3'), startsOn: today, endsOn: today, reason: 'Ceiling repair' }, 201);
    sA1 = await gReserve({ locationId: hotelA.id, guest: { name: 'Walk In' }, source: 'walk_in', arrival: today, departure: tomorrow });
    sA2 = await gReserve({ locationId: hotelA.id, guest: { name: 'Online Guest' }, source: 'ota', otaName: 'MakeMyTrip', otaBookingId: 'MMT-1', agreedRate: '3500', arrival: today, departure: tomorrow });
    const sB1 = await gReserve({ locationId: hotelB.id, guest: { name: 'Phone Guest' }, source: 'phone', ratePlanId: bb.id, adults: 2, arrival: today, departure: tomorrow });
    await gCheckIn(sA1, 'A1');
    await gCheckIn(sA2, 'A2');
    await gCheckIn(sB1, 'B1', [occupant('Phone Guest'), occupant('Phone Guest Two')]);
    const audit = await request('POST', G('lodging/night-audit'), {});
    assert.equal(audit.nights, 3);
    const report = await request('GET', G(`lodging/reports?from=${today}&to=${today}`));
    const pick = (r) => [r.label, r.available, r.sold, r.revenue, r.occupancy, r.adr, r.revpar];
    // Six rooms available (A3 out of order), three sold for 11,500 before GST: 50%, ADR 3,833.33, RevPAR 1,916.67.
    assert.deepEqual(pick(report.total), ['In all', 6, 3, '11500.00', 50, '3833.33', '1916.67']);
    assert.equal(report.total.outOfOrder, 1);
    assert.deepEqual(report.properties.map(pick), [['Hotel A', 3, 2, '7500.00', 66.7, '3750.00', '2500.00'], ['Hotel B', 3, 1, '4000.00', 33.3, '4000.00', '1333.33']]);
    assert.deepEqual(report.byType.map(pick), [['Deluxe', 5, 3, '11500.00', 60, '3833.33', '2300.00'], ['Suite', 1, 0, '0.00', 0, null, '0.00']]);
    // By source and by plan, each against every room available: its share of the house.
    assert.deepEqual(report.bySource.map(pick), [['MakeMyTrip', 6, 1, '3500.00', 16.7, '3500.00', '583.33'], ['Phone', 6, 1, '4000.00', 16.7, '4000.00', '666.67'],
      ['Walk-in', 6, 1, '4000.00', 16.7, '4000.00', '666.67']]);
    assert.deepEqual(report.byPlan.map(pick), [['No rate plan', 6, 2, '7500.00', 33.3, '3750.00', '1250.00'], ['BB (Deluxe, CP)', 6, 1, '4000.00', 16.7, '4000.00', '666.67']]);
    // One property: Hotel B alone.
    const b = await request('GET', G(`lodging/reports?from=${today}&to=${today}&location=${hotelB.id}`));
    assert.deepEqual(pick(b.total), ['In all', 3, 1, '4000.00', 33.3, '4000.00', '1333.33']);
    assert.equal((await refused('GET', G(`lodging/reports?from=${tomorrow}&to=${today}`))).status, 400);
  });

  let corporateA;
  await t.test('rate plans shared or per property, and one reservations view across the properties', async () => {
    corporateA = (await request('POST', G('lodging/rate-plans'), { roomTypeId: gDeluxe.id, name: 'Corporate', mealPlan: 'EP', roomRate: '3800', locationId: hotelA.id }, 201))
      .plans.find((p) => p.name === 'Corporate' && Number(p.location_id) === Number(hotelA.id));
    assert.equal(corporateA.location_name, 'Hotel A');
    await request('POST', G('lodging/rate-plans'), { roomTypeId: gDeluxe.id, name: 'Corporate', mealPlan: 'EP', roomRate: '3600', locationId: hotelB.id }, 201);
    assert.equal((await refused('POST', G('lodging/rate-plans'), { roomTypeId: gDeluxe.id, name: 'corporate', mealPlan: 'EP', locationId: hotelA.id })).status, 409);
    const elsewhere = await refused('POST', G('lodging/stays'), { requestKey: key(), locationId: hotelB.id, roomTypeId: gDeluxe.id, adults: 1, guest: { name: 'X' }, ratePlanId: corporateA.id,
      arrival: addDays(D, 1), departure: addDays(D, 2) });
    assert.deepEqual([elsewhere.status, elsewhere.message], [409, 'Corporate is a plan of another property']);
    const atA = await gReserve({ locationId: hotelA.id, guest: { name: 'Corporate Guest' }, ratePlanId: corporateA.id, arrival: addDays(D, 1), departure: addDays(D, 2) });
    assert.equal(atA.nights[0].room_rate, '3800.00');
    const shared = await gReserve({ locationId: hotelB.id, guest: { name: 'Shared Plan Guest' }, ratePlanId: bb.id, arrival: addDays(D, 1), departure: addDays(D, 2) });
    await assert.rejects(rows('UPDATE lodging_stays SET rate_plan_id=$2 WHERE id=$1', [shared.id, corporateA.id]), /one of another property's/);
    // The calendar across the properties, or one of them.
    const all = await request('GET', G(`lodging/calendar?from=${today}&days=2`));
    assert.deepEqual(all.types.find((x) => x.name === 'Deluxe').rooms.map((r) => [r.roomNo, r.locationName]), [['A1', 'Hotel A'], ['A2', 'Hotel A'], ['A3', 'Hotel A'], ['A4', 'Hotel A'],
      ['B1', 'Hotel B'], ['B2', 'Hotel B']]);
    const onlyB = await request('GET', G(`lodging/calendar?from=${today}&days=2&location=${hotelB.id}`));
    assert.deepEqual(onlyB.types.find((x) => x.name === 'Deluxe').rooms.map((r) => r.roomNo), ['B1', 'B2']);
    const stays = await request('GET', G(`lodging/stays?location=${hotelB.id}&limit=100`));
    assert.ok(stays.items.every((s) => Number(s.location_id) === Number(hotelB.id) && s.location_name === 'Hotel B'));
  });

  await t.test('a guest moved to another property mid-stay: checked out and billed at one with its GST, checked in at the other, linked', async () => {
    // A guest at Hotel A since yesterday, with an advance of 9,000.
    let moving = await gReserve({ locationId: hotelA.id, guest: { name: 'Moving Guest' }, source: 'phone', arrival: today, departure: addDays(today, 2), roomTypeId: gDeluxe.id,
      advance: { amount: '9000', method: 'cash' } });
    moving = await gCheckIn(moving, 'A4', [occupant('Moving Guest')]);
    await backdate(moving.id, 1);
    await request('POST', G('lodging/night-audit'), {});
    const body = { requestKey: key(), locationId: hotelB.id, roomTypeId: gDeluxe.id, roomId: gRoom('B2'), departure: tomorrow };
    // Refused: the same property; a guest who arrived today; a plan of another property (nothing changes).
    assert.deepEqual(await refused('POST', G(`lodging/stays/${moving.id}/move`), { ...body, requestKey: key(), locationId: hotelA.id }).then((r) => [r.status, r.message]),
      [409, 'The guest is at that property already: move them to another room instead']);
    const arrivedToday = await refused('POST', G(`lodging/stays/${sA2.id}/move`), { ...body, requestKey: key() });
    assert.deepEqual([arrivedToday.status, arrivedToday.message], [409,
      `Stay ${sA2.stay_no} arrived today: a guest moves to another property from their second day; until then change their room here, or cancel and book there`]);
    const wrongPlan = await refused('POST', G(`lodging/stays/${moving.id}/move`), { ...body, requestKey: key(), ratePlanId: corporateA.id });
    assert.deepEqual([wrongPlan.status, wrongPlan.message], [409, 'Corporate is a plan of another property']);
    assert.equal((await request('GET', G(`lodging/stays/${moving.id}`))).status, 'in_house');
    // Moved: checked out at Hotel A (yesterday's night billed there, tonight's not stayed voided), checked in at Hotel B, linked.
    const next = await request('POST', G(`lodging/stays/${moving.id}/move`), body, 201);
    assert.deepEqual([next.status, next.room_no, next.location_name, next.moved_from.stay_no, next.guests.map((g) => g.full_name), next.arrived_from],
      ['in_house', 'B2', 'Hotel B', moving.stay_no, ['Moving Guest'], 'Hotel A']);
    const old = await request('GET', G(`lodging/stays/${moving.id}`));
    assert.deepEqual([old.status, old.moved_to.stay_no, old.bill.total, old.bill.paid], ['checked_out', next.stay_no, '4200.00', '4200.00']);
    // Retried: the same move; the same key with another room: refused.
    assert.equal((await request('POST', G(`lodging/stays/${moving.id}/move`), body, 201)).id, next.id);
    assert.equal((await refused('POST', G(`lodging/stays/${moving.id}/move`), { ...body, roomId: gRoom('B1') })).status, 409);
    // Each property's nights on its own invoice: Hotel A's place of supply its state (36), Hotel B's its own (29), paid by what is left of the advance.
    const out = await request('POST', G(`lodging/stays/${next.id}/check-out`), { requestKey: key() });
    const billA = await request('GET', G(`documents/${old.document_id}`));
    const billB = await request('GET', G(`documents/${out.document_id}`));
    assert.deepEqual([billA.place_of_supply, Number(billA.location_id), billA.total], ['36', Number(hotelA.id), '4200.00']);
    assert.deepEqual([billB.place_of_supply, Number(billB.location_id), billB.total, out.bill.paid], ['29', Number(hotelB.id), '4200.00', '4200.00']);
    assert.equal((await one('SELECT sum(amount) AS paid FROM business_payments WHERE business_id=$1 AND collection_id IN (SELECT collection_id FROM lodging_receipts WHERE stay_id=$2)',
      [chain.id, moving.id])).paid, '8400.00', 'the advance paid both bills');
    // The database: a stay continues only a stay checked out at another property, of the same guest, and keeps it.
    await assert.rejects(rows('UPDATE lodging_stays SET moved_from_stay_id=NULL WHERE id=$1', [next.id]), /no longer changes|keeps the stay it continues/);
  });

  await t.test('audit and events', async () => {
    const actions = (await rows('SELECT DISTINCT action FROM business_audit WHERE business_id IN ($1,$2)', [lodge.id, chain.id])).map((r) => r.action);
    for (const action of ['lodging_room.out_of_order', 'lodging_room.out_of_order_changed', 'lodging_room.back_in_order', 'lodging_room.status_changed', 'lodging_room.flags_changed',
      'lodging_checklist.set', 'lodging_room.checked', 'lodging_ticket.opened', 'lodging_ticket.started', 'lodging_ticket.done', 'lodging_ticket.cancelled', 'lodging_ticket.changed',
      'lodging.night_audit', 'lodging_stay.no_show', 'lodging_stay.moved_property', 'lodging_settings.updated', 'lodging_rate_plan.created']) {
      assert.ok(actions.includes(action), `audit ${action}`);
    }
    const kinds = (await rows('SELECT DISTINCT kind FROM business_events WHERE business_id IN ($1,$2)', [lodge.id, chain.id])).map((r) => r.kind);
    for (const kind of ['lodging_room.out_of_order', 'lodging_room.status_changed', 'lodging_room.checked', 'lodging_ticket.opened', 'lodging_ticket.done', 'lodging_stay.no_show',
      'lodging_stay.moved_property', 'lodging_charge.posted']) {
      assert.ok(kinds.includes(kind), `event ${kind}`);
    }
  });
});
