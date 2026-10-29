const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom, weekdayOf } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A hotel's, lodge's or guest house's stays beyond the room and the folio:
// rate plans with meal plans (the meals billed as their own lines, so the
// room's value alone decides its slab), the rate calendar (seasons, weekend
// rates, dates of their own, minimum stay, closed to arrival, stop-sell)
// checked on the server, a discount that moves a night from 18% to 5%, day
// use by the hour never sharing a room's hours with a night stay (even two
// saved at once), policies worked out (early check-in, late check-out,
// cancellation, no-show, deposit) and waived by a manager, group bookings
// with their rooming list and group folio, several folios to a stay with
// routing billed as invoices that add up, minibar goods leaving stock when
// billed, occupants joining and leaving partway, and guest profiles. Money
// adds up to the paisa, postings are idempotent, the database keeps its
// rules, audit and events are written. Runs on its own throwaway database
// with every migration applied.
test('hotels, lodges and guest houses: rates, policies, groups and folios', { timeout: 600000 }, async (t) => {
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
  const password = `Stays-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('stays-owner');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('stays-owner@test.invalid');
  const request = as(ownerToken);
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const rupees = (p) => (p / 100).toFixed(2);
  const today = daysFrom(0);
  const tomorrow = daysFrom(1);
  // The next Thursday after today, on the business's clock, and the week after it.
  let thursday = daysFrom(1);
  while (weekdayOf(thursday) !== 4) thursday = addDays(thursday, 1);
  const T = addDays(thursday, 7);

  const [lodge, grocery] = await createBusinesses(request, 'OWNER', ['lodging', 'grocery']);
  const L = (suffix) => `/businesses/${lodge.id}/${suffix}`;
  const hotel = (await request('GET', L('locations'))).items[0];
  await request('PATCH', L(`locations/${hotel.id}`), { name: hotel.name, stateCode: '36', city: 'Hyderabad' });
  await request('PUT', L('modules/inventory'), { enabled: true });
  const slabs = (await request('GET', L('tax-rates?limit=100'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const roles = (await request('GET', L('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', L('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('stays-desk@test.invalid', 'front_desk');
  const keeper = await staff('stays-keeping@test.invalid', 'housekeeping');
  const manager = await staff('stays-manager@test.invalid', 'manager');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const customer = (name, extra = {}) => request('POST', L('contacts'), { kind: 'customer', name, ...extra }, 201);
  const service = (name, code, price, taxRateId) => request('POST', L('catalog'), { kind: 'service', unit: 'service', name, code, price: String(price), taxRateId }, 201);
  const occupant = (fullName, extra = {}) => ({ fullName, idKind: 'voter_id', idRef: `TSV${crypto.randomBytes(3).toString('hex').toUpperCase()}`, ...extra });
  const charges = (stayId) => rows('SELECT kind,night::text AS night,amount,discount,tax_rate,tax,folio_id,line_id,voided_at,extra_adults FROM lodging_charges WHERE stay_id=$1 ORDER BY id', [stayId]);
  // Time passes: a stay moved back so many days, as if it had been booked and arrived then (its dates, its nights' rates, its day use, its occupants).
  async function backdate(stayId, days) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE lodging_stays DISABLE TRIGGER lodging_stays_guard');
      await db.query('ALTER TABLE lodging_stay_guests DISABLE TRIGGER lodging_stay_guests_guard');
      await db.query(`UPDATE lodging_stays SET arrival=arrival-$2::int,departure=departure-$2::int,checked_in_at=checked_in_at-make_interval(days=>$2::int),
        day_from=day_from-make_interval(days=>$2::int),day_until=day_until-make_interval(days=>$2::int) WHERE id=$1`, [stayId, days]);
      await db.query(`WITH gone AS (DELETE FROM lodging_stay_nights WHERE stay_id=$1 RETURNING *)
        INSERT INTO lodging_stay_nights SELECT business_id,stay_id,night-$2::int,rate_kind,room_rate,extra_adult_rate,child_rate,extra_bed_rate,meal_sku_id,meal_adult_rate,meal_child_rate FROM gone`, [stayId, days]);
      await db.query('UPDATE lodging_stay_guests SET arrived_at=arrived_at-make_interval(days=>$2::int),created_at=created_at-make_interval(days=>$2::int) WHERE stay_id=$1', [stayId, days]);
      await db.query('ALTER TABLE lodging_stay_guests ENABLE TRIGGER lodging_stay_guests_guard');
      await db.query('ALTER TABLE lodging_stays ENABLE TRIGGER lodging_stays_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }

  // --- The property: its slabs, room types, rooms and items ---------------------------------------------------------------
  await request('PUT', L('lodging/settings'), { lowTaxRateId: gst5.id, highTaxRateId: gst18.id });
  let list = await request('POST', L('lodging/room-types'), { item: { name: 'Deluxe', hsnCode: '996311' }, baseOccupancy: 2, maxOccupancy: 3, maxExtraBeds: 1,
    rates: { rack: '4500', weekend: '5200', extraAdult: '1000', child: '500', extraBed: '800' } }, 201);
  const deluxe = list.roomTypes.find((r) => r.name === 'Deluxe');
  list = await request('POST', L('lodging/room-types'), { item: { name: 'Suite' }, baseOccupancy: 2, maxOccupancy: 4, rates: { rack: '7000', weekend: '8500', extraAdult: '1500' } }, 201);
  const suite = list.roomTypes.find((r) => r.name === 'Suite');
  await request('POST', L('lodging/rooms'), { locationId: hotel.id, roomTypeId: deluxe.id, rooms: ['101', '102', '103', '104', '105', '106', '107', '108'].map((roomNo) => ({ roomNo })) }, 201);
  const setup = await request('POST', L('lodging/rooms'), { locationId: hotel.id, roomTypeId: suite.id, rooms: [{ roomNo: '201' }, { roomNo: '202' }, { roomNo: '203' }] }, 201);
  const roomId = (no) => setup.rooms.find((r) => r.room_no === no).id;
  const meals = await service('Breakfast and dinner', 'MEALS', 0, gst5.id);
  const laundry = await service('Laundry (per piece)', 'LND-PC', 50, gst18.id);
  const water = await request('POST', L('catalog'), { kind: 'goods', unit: 'each', name: 'Mineral water 1 L', code: 'WATER-1L', price: '50', taxRateId: gst18.id, tracking: 'quantity',
    openingStock: { locationId: hotel.id, quantity: '10', unitCost: '15' } }, 201);
  const company = await customer('Infotech Solutions Pvt Ltd', { gstin: '27AAPFU0939F1ZV' });
  const stockOf = async (skuId) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3', [lodge.id, hotel.id, skuId])).q);
  const reserve = (body, as2 = request, expected = 201) => as2('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, roomTypeId: deluxe.id, adults: 1, ...body }, expected);

  await t.test('the new parts belong to lodging: other types are refused, and the group number series is a kind of its own', async () => {
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'")).d.includes("'stay_group'"));
    assert.equal((await refused('GET', `/businesses/${grocery.id}/lodging/rates`)).status, 403);
    assert.equal((await refused('POST', `/businesses/${grocery.id}/lodging/groups`, { requestKey: key() })).status, 403);
    // The front desk changes no rates and no policies; housekeeping books nothing.
    assert.equal((await refused('POST', L('lodging/rate-plans'), { roomTypeId: deluxe.id, name: 'X', mealPlan: 'EP' }, desk.token)).status, 403);
    assert.equal((await refused('POST', L('lodging/policies'), { name: 'X' }, desk.token)).status, 403);
    assert.equal((await refused('POST', L('lodging/groups'), { requestKey: key() }, keeper.token)).status, 403);
    assert.equal((await refused('PUT', L('lodging/day-use-rates'), { roomTypeId: deluxe.id, rates: [] }, desk.token)).status, 403);
  });

  let halfBoard, saver, mapStay;
  await t.test('rate plans with meal plans: the meals billed as their own lines, the room\'s value alone deciding its slab', async () => {
    // A plan with meals names the food item they are billed as; a room type's nights are not meals.
    assert.equal((await refused('POST', L('lodging/rate-plans'), { roomTypeId: suite.id, name: 'Half board', mealPlan: 'MAP', mealAdultRate: '900' })).status, 400);
    const notMeals = await refused('POST', L('lodging/rate-plans'), { roomTypeId: suite.id, name: 'Half board', mealPlan: 'MAP', mealSkuId: suite.sku_id, mealAdultRate: '900' });
    assert.deepEqual([notMeals.status, notMeals.message], [400, 'Suite is a room type\'s nights, not meals']);
    let rates = await request('POST', L('lodging/rate-plans'), { roomTypeId: suite.id, name: 'Half board', mealPlan: 'MAP', mealSkuId: meals.id, mealAdultRate: '900', mealChildRate: '400' }, 201);
    halfBoard = rates.plans.find((p) => p.name === 'Half board');
    assert.deepEqual([halfBoard.meal_plan, halfBoard.meal_adult_rate, halfBoard.meal_child_rate, halfBoard.refundable], ['MAP', '900.00', '400.00', true]);
    assert.equal((await refused('POST', L('lodging/rate-plans'), { roomTypeId: suite.id, name: 'half board', mealPlan: 'EP' })).status, 409);
    rates = await request('POST', L('lodging/rate-plans'), { roomTypeId: deluxe.id, name: 'Saver', mealPlan: 'EP', roomRate: '4000', refundable: false }, 201);
    saver = rates.plans.find((p) => p.name === 'Saver');
    // A Suite night at 7,000 with meals of 1,800 for two: the room alone (7,000) is at or below 7,500, so 5%; the meals at their item's 5%.
    const preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: thursday, departure: addDays(thursday, 1), roomTypeId: suite.id,
      ratePlanId: halfBoard.id, adults: 2 });
    assert.deepEqual([preview.nights[0].amount, preview.nights[0].taxRate, preview.nights[0].meals, preview.nights[0].mealsTax, preview.total], ['7000.00', '5.00', '1800.00', '90.00', '9240.00']);
    // A stay tonight at the Suite's own rate for today (7,000), on half board: billed as the room at 5% and the meals as their own line at 5%.
    await request('PUT', L('lodging/rate-days'), { roomTypeId: suite.id, from: today, to: today, roomRate: '7000' });
    mapStay = await request('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Asha Rao', phone: '9876500501' }, arrival: today, departure: tomorrow,
      roomTypeId: suite.id, ratePlanId: halfBoard.id, roomId: roomId('201'), adults: 2 }, 201);
    assert.deepEqual([mapStay.plan.meal_plan, mapStay.estimate_total, mapStay.nights[0].rate_kind, mapStay.nights[0].meals], ['MAP', '9240.00', 'override', '1800.00']);
    await request('POST', L(`lodging/stays/${mapStay.id}/check-in`), { requestKey: key(), guests: [occupant('Asha Rao'), occupant('Vikram Rao')] });
    const out = await request('POST', L(`lodging/stays/${mapStay.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const doc = await request('GET', L(`documents/${out.document_id}`));
    assert.deepEqual(doc.lines.map((l) => [l.sku_id, Number(l.tax_rate), l.net, l.tax]), [[suite.sku_id, 5, '7000.00', '350.00'], [meals.id, 5, '1800.00', '90.00']]);
    assert.equal(doc.total, '9240.00');
    // The database keeps a night's meals at the plan's rates and the meal item's slab.
    const meal = await one("SELECT * FROM lodging_charges WHERE stay_id=$1 AND kind='meal'", [mapStay.id]);
    assert.deepEqual([meal.amount, meal.tax_rate], ['1800.00', '5.00']);
  });

  await t.test('the rate calendar: seasons, weekend rates, dates of their own, minimum stay, closed to arrival and stop-sell, refused with the reason', async () => {
    // Outside any season: Thursday at the rack rate, Friday at the weekend rate.
    let preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: thursday, departure: addDays(thursday, 2), roomTypeId: deluxe.id, adults: 2 });
    assert.deepEqual(preview.nights.map((n) => [n.rateKind, n.amount]), [['rack', '4500.00'], ['weekend', '5200.00']]);
    // A season from T for a week: 6,000 on weekdays (5%) and 7,800 on weekend nights (18%).
    await request('POST', L('lodging/seasons'), { roomTypeId: deluxe.id, name: 'Diwali', startsOn: T, endsOn: addDays(T, 6), weekdayRate: '6000', weekendRate: '7800' }, 201);
    const overlap = await refused('POST', L('lodging/seasons'), { roomTypeId: deluxe.id, name: 'Wedding season', startsOn: addDays(T, 3), endsOn: addDays(T, 10), weekdayRate: '5000' });
    assert.equal(overlap.status, 409);
    assert.match(overlap.message, /Diwali .* covers some of these dates already/);
    preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: T, departure: addDays(T, 3), roomTypeId: deluxe.id, adults: 2 });
    assert.deepEqual(preview.nights.map((n) => [n.rateKind, n.amount, n.taxRate]), [['season', '6000.00', '5.00'], ['season', '7800.00', '18.00'], ['season', '7800.00', '18.00']]);
    // A date of its own for the room type (Friday at 7,000), and one for the Saver plan only (Saturday at 3,900).
    await request('PUT', L('lodging/rate-days'), { roomTypeId: deluxe.id, from: addDays(T, 1), to: addDays(T, 1), roomRate: '7000' });
    await request('PUT', L('lodging/rate-days'), { roomTypeId: deluxe.id, ratePlanId: saver.id, from: addDays(T, 2), to: addDays(T, 2), roomRate: '3900' });
    preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: T, departure: addDays(T, 3), roomTypeId: deluxe.id, adults: 2 });
    assert.deepEqual(preview.nights.map((n) => [n.rateKind, n.amount, n.taxRate]), [['season', '6000.00', '5.00'], ['override', '7000.00', '5.00'], ['season', '7800.00', '18.00']]);
    preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: T, departure: addDays(T, 3), roomTypeId: deluxe.id, ratePlanId: saver.id, adults: 2 });
    assert.deepEqual(preview.nights.map((n) => [n.rateKind, n.amount]), [['season', '6000.00'], ['override', '7000.00'], ['override', '3900.00']]);
    // The calendar's screen shows each date's rate and restrictions.
    const calendar = (await request('GET', L(`lodging/rates?roomType=${deluxe.id}&from=${T}&days=3`))).calendar;
    assert.deepEqual(calendar.dates.map((d) => [d.rateKind, d.roomRate]), [['season', '6000.00'], ['override', '7000.00'], ['season', '7800.00']]);
    // Minimum stay of 2 arriving on T+14, closed to arrival on T+15, stop-sell on T+17.
    await request('PUT', L('lodging/rate-days'), { roomTypeId: deluxe.id, from: addDays(T, 14), to: addDays(T, 14), minStay: 2 });
    await request('PUT', L('lodging/rate-days'), { roomTypeId: deluxe.id, from: addDays(T, 15), to: addDays(T, 15), closedToArrival: true });
    await request('PUT', L('lodging/rate-days'), { roomTypeId: deluxe.id, from: addDays(T, 17), to: addDays(T, 17), stopSell: true });
    const short = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Short Stay' }, arrival: addDays(T, 14), departure: addDays(T, 15), roomTypeId: deluxe.id, adults: 1 });
    assert.deepEqual([short.status, short.data?.reason], [409, 'min_stay']);
    assert.match(short.message, /Deluxe is sold for at least 2 nights arriving on/);
    const closed = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Closed Day' }, arrival: addDays(T, 15), departure: addDays(T, 16), roomTypeId: deluxe.id, adults: 1 });
    assert.deepEqual([closed.status, closed.data?.reason], [409, 'closed_to_arrival']);
    const sold = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Stop Sell' }, arrival: addDays(T, 16), departure: addDays(T, 18), roomTypeId: deluxe.id, adults: 1 });
    assert.deepEqual([sold.status, sold.data?.reason], [409, 'stop_sell']);
    assert.match(sold.message, /is not sold on the night of .* \(stop-sell\)/);
    // Two nights from T+14 (through the day closed to arrival) are allowed; the preview says what the calendar refuses.
    assert.equal((await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: addDays(T, 14), departure: addDays(T, 16), roomTypeId: deluxe.id, adults: 1 })).calendarFree, true);
    assert.equal((await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: addDays(T, 16), departure: addDays(T, 18), roomTypeId: deluxe.id, adults: 1 })).calendarFree, false);
    // A change is checked too: moving a reservation's arrival onto the day closed to arrival is refused.
    const booked = await reserve({ guest: { name: 'Moving Guest' }, arrival: addDays(T, 20), departure: addDays(T, 21) });
    const moved = await refused('PATCH', L(`lodging/stays/${booked.id}`), { arrival: addDays(T, 15), departure: addDays(T, 16) });
    assert.deepEqual([moved.status, moved.data?.reason], [409, 'closed_to_arrival']);
    // The stop-sell taken off, the same stay is sold.
    await request('PUT', L('lodging/rate-days'), { roomTypeId: deluxe.id, from: addDays(T, 17), to: addDays(T, 17), clear: true });
    await reserve({ guest: { name: 'Stop Sell' }, arrival: addDays(T, 16), departure: addDays(T, 18) });
    assert.ok((await rows("SELECT 1 FROM business_audit WHERE business_id=$1 AND action IN ('lodging_rate_days.set','lodging_rate_days.cleared','lodging_season.created','lodging_rate_plan.created')", [lodge.id])).length >= 4);
  });

  await t.test('a discount on a stay, within the most a bill takes off: the discounted night\'s value decides its slab', async () => {
    const friday = addDays(thursday, 1);
    let preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: friday, departure: addDays(friday, 1), roomTypeId: suite.id, adults: 2 });
    assert.deepEqual([preview.nights[0].amount, preview.nights[0].taxRate], ['8500.00', '18.00']);
    preview = await request('POST', L('lodging/stays/preview'), { locationId: hotel.id, arrival: friday, departure: addDays(friday, 1), roomTypeId: suite.id, adults: 2, discount: { percent: '15' } });
    assert.deepEqual([preview.nights[0].value, preview.nights[0].discount, preview.nights[0].amount, preview.nights[0].taxRate], ['8500.00', '1275.00', '7225.00', '5.00']);
    // The discount permission, within the business's most (10%); the owner may give more.
    const body = { guest: { name: 'Corporate Guest' }, arrival: today, departure: tomorrow, roomTypeId: suite.id, roomId: roomId('202'), adults: 2, agreedRate: '8000' };
    assert.equal((await reserve({ ...body, discount: { percent: '5', reason: 'Regular' } }, desk.call, 403)).status, undefined);
    const tooMuch = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, ...body, discount: { percent: '15', reason: 'Too much' } }, manager.token);
    assert.deepEqual([tooMuch.status, tooMuch.message], [409, 'At most 10% of a bill can be taken off. The owner can change this in Business settings.']);
    let stay = await reserve({ ...body, discount: { percent: '10', reason: 'Corporate rate' } }, manager.call);
    assert.deepEqual([stay.discount_percent, stay.estimate_total, stay.nights[0].amount, stay.nights[0].tax_rate], ['10.00', '7560.00', '7200.00', '5.00']);
    await request('POST', L(`lodging/stays/${stay.id}/check-in`), { requestKey: key(), guests: [occupant('Corporate Guest'), occupant('Second Guest')] });
    await request('POST', L('lodging/night-audit'), {});
    let posted = (await charges(stay.id)).filter((x) => x.kind === 'room_night');
    assert.deepEqual(posted.map((x) => [x.amount, x.discount, x.tax_rate, x.tax]), [['7200.00', '800.00', '5.00', '360.00']]);
    // The database: a night is charged with the stay's discount.
    const night = await one("SELECT * FROM lodging_charges WHERE stay_id=$1 AND kind='room_night'", [stay.id]);
    await assert.rejects(rows('UPDATE lodging_charges SET discount=NULL WHERE id=$1', [night.id]), /kept as it was posted/);
    // A smaller discount in the house: the night posted is posted again at 7,600, now above 7,500: 18%.
    stay = await request('PATCH', L(`lodging/stays/${stay.id}`), { discount: { percent: '5', reason: 'Corporate rate, revised' } });
    posted = (await charges(stay.id)).filter((x) => x.kind === 'room_night');
    assert.deepEqual(posted.map((x) => [x.amount, x.discount, x.tax_rate, Boolean(x.voided_at)]), [['7200.00', '800.00', '5.00', true], ['7600.00', '400.00', '18.00', false]]);
    const out = await request('POST', L(`lodging/stays/${stay.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'card' } });
    assert.equal(out.bill.total, '8968.00');
  });

  await t.test('day use by the hour: priced by its block, never sharing its room\'s hours with a night stay or another day use, even two at once', async () => {
    await request('PUT', L('lodging/day-use-rates'), { roomTypeId: deluxe.id, rates: [{ hours: 4, rate: '1500' }, { hours: 6, rate: '2200' }] });
    // A night stay in room 105 from tomorrow holds it from the check-in time (12:00).
    await reserve({ guest: { name: 'Night Guest' }, arrival: tomorrow, departure: addDays(tomorrow, 1), roomId: roomId('105'), agreedRate: '4000' });
    const over = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Day One' }, arrival: tomorrow, roomTypeId: deluxe.id, roomId: roomId('105'),
      adults: 1, dayUse: { from: '10:00', hours: 4 } });
    assert.equal(over.status, 409);
    assert.match(over.message, /Room 105 is booked by ST\/.+ at those hours/);
    const morning = await reserve({ guest: { name: 'Day One' }, arrival: tomorrow, roomId: roomId('105'), dayUse: { from: '06:00', hours: 4 } });
    assert.deepEqual([morning.day_use, morning.departure, morning.nights[0].rate_kind, morning.nights[0].amount, morning.nights[0].tax_rate, morning.estimate_total],
      [true, addDays(tomorrow, 1), 'day_use', '1500.00', '5.00', '1575.00']);
    const noRate = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Day Two' }, arrival: tomorrow, roomTypeId: deluxe.id, roomId: roomId('104'),
      adults: 1, dayUse: { from: '06:00', hours: 5 } });
    assert.deepEqual([noRate.status, noRate.data?.reason], [409, 'no_day_use_rate']);
    // Two day uses of room 106 at overlapping hours saved at the same moment: one is booked, the other refused.
    const dayBody = (name, from) => ({ requestKey: key(), locationId: hotel.id, guest: { name }, arrival: tomorrow, roomTypeId: deluxe.id, roomId: roomId('106'), adults: 1, dayUse: { from, hours: 4 } });
    const both = await Promise.all([call('POST', L('lodging/stays'), dayBody('Day Three', '14:00'), ownerToken), call('POST', L('lodging/stays'), dayBody('Day Four', '16:00'), ownerToken)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    // A night stay over the day use's hours is refused too.
    const night = await refused('POST', L('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Late Night' }, arrival: tomorrow, departure: addDays(tomorrow, 1),
      roomTypeId: deluxe.id, roomId: roomId('106'), adults: 1 });
    assert.equal(night.status, 409);
    assert.match(night.message, /at those hours \(a day use\)/);
    // The database itself: a day use moved onto the night stay's hours is refused when the work is saved.
    await assert.rejects(rows("UPDATE lodging_stays SET day_from=day_from+interval '5 hours',day_until=day_until+interval '5 hours' WHERE id=$1", [morning.id]), /never shares its room's hours/);
    // The morning's day use, come round: checked in on its day, its price on the folio at the slab its value would take for a night, billed at check-out.
    await backdate(morning.id, 1);
    let stay = await request('POST', L(`lodging/stays/${morning.id}/check-in`), { requestKey: key(), guests: [occupant('Day One')] });
    assert.deepEqual(stay.charges.map((x) => [x.kind, x.amount, x.tax_rate]), [['day_use', '1500.00', '5.00']]);
    assert.equal((await request('POST', L('lodging/night-audit'), {})).posted.filter((p) => p.stayId === morning.id).length, 0, 'the night audit posts no night for a day use');
    stay = await request('POST', L(`lodging/stays/${morning.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    assert.deepEqual([stay.status, stay.bill.total], ['checked_out', '1575.00']);
  });

  await t.test('policies worked out, not typed: early check-in, late check-out, cancellation, no-show and deposit, each waivable by a manager', async () => {
    // Check-in from 23:59 and check-out by 00:00: a check-in today is early and a check-out on the departure day is late.
    await request('PUT', L('lodging/settings'), { checkInTime: '23:59', checkOutTime: '00:00' });
    const rates = await request('POST', L('lodging/policies'), { name: 'Standard', isDefault: true, earlyKind: 'percent', earlyValue: '50', lateKind: 'flat', lateValue: '1000',
      cancelFreeHours: 48, cancelKind: 'nights', cancelValue: 1, noShowKind: 'first_night', depositKind: 'percent', depositValue: '30', depositDays: 2 }, 201);
    assert.equal(rates.policies.find((p) => p.name === 'Standard').is_default, true);
    // A stay booked now keeps the policy; what it charges is worked out and shown.
    const early = await reserve({ guest: { name: 'Early Bird' }, arrival: today, departure: tomorrow, roomId: roomId('101'), agreedRate: '4000' });
    assert.equal(early.policy.name, 'Standard');
    assert.deepEqual([early.policy_charges.early.now, early.policy_charges.early.amount, early.policy_charges.early.taxRate], [true, '2000.00', '5.00']);
    assert.deepEqual([early.policy_charges.deposit.amount, early.policy_charges.deposit.short, early.policy_charges.cancel.amount, early.policy_charges.cancel.rule],
      ['1260.00', '1260.00', '4000.00', 'nights']);
    let stay = await desk.call('POST', L(`lodging/stays/${early.id}/check-in`), { requestKey: key(), guests: [occupant('Early Bird')] });
    assert.deepEqual(stay.charges.filter((x) => x.kind === 'early_check_in').map((x) => [x.amount, x.tax_rate, x.tax]), [['2000.00', '5.00', '100.00']]);
    // Waived: the front desk needs a manager's PIN; with it, no charge, and the waiver is audited.
    const waived = await reserve({ guest: { name: 'Waived Guest' }, arrival: today, departure: tomorrow, roomId: roomId('102'), agreedRate: '4000' });
    const noPin = await refused('POST', L(`lodging/stays/${waived.id}/check-in`), { requestKey: key(), guests: [occupant('Waived Guest')], waiver: { reason: 'Room was ready' } }, desk.token);
    assert.deepEqual([noPin.status, noPin.data?.reason], [400, 'approval_needed']);
    stay = await desk.call('POST', L(`lodging/stays/${waived.id}/check-in`), { requestKey: key(), guests: [occupant('Waived Guest')],
      waiver: { reason: 'Room was ready', approverId: ownerUser.id, pin: '2468' } });
    assert.equal(stay.charges.filter((x) => x.kind === 'early_check_in').length, 0);
    const audit = await one("SELECT actor_id,details FROM business_audit WHERE business_id=$1 AND action='lodging_policy.waived' AND entity_id=$2", [lodge.id, waived.id]);
    assert.deepEqual([Number(audit.actor_id), audit.details.charge, audit.details.amount], [Number(ownerUser.id), 'early_check_in', '2000.00']);
    // The waived guest's day comes round: checked out on the departure day after the check-out time, the late check-out charge (a flat 1,000) at the last night's slab.
    await backdate(waived.id, 1);
    const preview = await request('POST', L(`lodging/stays/${waived.id}/check-out/preview`), {});
    assert.deepEqual([preview.lateCheckOut.amount, preview.lateCheckOut.taxRate, preview.total], ['1000.00', '5.00', '5250.00']);
    stay = await request('POST', L(`lodging/stays/${waived.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const doc = await request('GET', L(`documents/${stay.document_id}`));
    assert.deepEqual(doc.lines.map((l) => [l.label.split(' · ')[0], l.net, l.tax]), [['Deluxe', '4000.00', '200.00'], ['Late check-out', '1000.00', '50.00']]);
    // A cancellation more than 48 hours ahead is free; within them, the first night; a plan not refundable, the full stay whenever.
    const far = await reserve({ guest: { name: 'Far Ahead' }, arrival: addDays(T, 21), departure: addDays(T, 22), agreedRate: '4000' });
    assert.deepEqual([far.policy_charges.cancel.amount, far.policy_charges.cancel.rule], ['0.00', 'free']);
    assert.equal((await request('POST', L(`lodging/stays/${far.id}/cancel`), { requestKey: key(), reason: 'Plans changed' })).document_id, null);
    const near = await reserve({ guest: { name: 'Near Day' }, arrival: tomorrow, departure: addDays(tomorrow, 1), agreedRate: '4000' });
    const typed = await refused('POST', L(`lodging/stays/${near.id}/cancel`), { requestKey: key(), reason: 'Plans changed', charge: '500' });
    assert.deepEqual([typed.status, typed.data?.reason], [409, 'policy_charge']);
    const cancelled = await request('POST', L(`lodging/stays/${near.id}/cancel`), { requestKey: key(), reason: 'Plans changed' });
    assert.deepEqual([cancelled.status, cancelled.bill.total], ['cancelled', '4200.00']);
    const kind = await reserve({ guest: { name: 'Kind Waiver' }, arrival: tomorrow, departure: addDays(tomorrow, 1), agreedRate: '4000' });
    assert.equal((await request('POST', L(`lodging/stays/${kind.id}/cancel`), { requestKey: key(), reason: 'Illness', waiver: { reason: 'A regular guest, unwell' } })).document_id, null);
    const nonRefundable = await reserve({ guest: { name: 'Saver Guest' }, arrival: addDays(T, 21), departure: addDays(T, 23), ratePlanId: saver.id });
    assert.equal(nonRefundable.policy.refundable, false);
    const kept = await request('POST', L(`lodging/stays/${nonRefundable.id}/cancel`), { requestKey: key(), reason: 'Plans changed' });
    assert.equal(kept.bill.total, '8400.00', 'the full stay: two nights at the Saver plan\'s 4,000');
    // A no-show: the first night.
    const noShow = await reserve({ guest: { name: 'Never Came' }, arrival: today, departure: addDays(today, 2), agreedRate: '4000' });
    const marked = await request('POST', L(`lodging/stays/${noShow.id}/cancel`), { requestKey: key(), reason: 'Did not arrive', noShow: true });
    assert.deepEqual([marked.status, marked.bill.total], ['no_show', '4200.00']);
    // The first stay checks out a night early (before its departure day): no late check-out charge.
    stay = await request('POST', L(`lodging/stays/${early.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'upi', reference: 'UPI-77' } });
    assert.equal(stay.charges.filter((x) => x.kind === 'late_check_out').length, 0);
    assert.equal(stay.bill.total, '6300.00', 'the night 4,200 and the early check-in 2,100');
  });

  let group;
  await t.test('a group booking: a block of rooms, the rooming list, checked in together, the room nights on the group\'s folio billed to the company', async () => {
    const body = { requestKey: key(), locationId: hotel.id, name: 'Infotech offsite', contactId: company.id, arrival: today, departure: tomorrow,
      rooms: [{ roomTypeId: deluxe.id, roomId: roomId('103'), adults: 1, agreedRate: '4000' }, { roomTypeId: deluxe.id, roomId: roomId('104'), adults: 1, agreedRate: '4000' },
        { roomTypeId: deluxe.id, roomId: roomId('107'), adults: 1, agreedRate: '4000', departure: addDays(today, 2) }] };
    group = await request('POST', L('lodging/groups'), body, 201);
    assert.match(group.group_no, /^GB\//);
    assert.deepEqual([group.rooms, group.stays.length, group.stays.every((s) => s.guest_name === 'Infotech Solutions Pvt Ltd')], [3, 3, true]);
    // A retry is the same group; the same key with another body is refused.
    assert.equal((await request('POST', L('lodging/groups'), body, 201)).id, group.id);
    assert.equal((await refused('POST', L('lodging/groups'), { ...body, name: 'Other' })).status, 409);
    const [g1, g2, g3] = group.stays;
    // The rooming list names two rooms' guests.
    group = await request('PATCH', L(`lodging/groups/${group.id}/rooming`), { stays: [{ stayId: g1.id, guest: { name: 'Ravi Menon' } }, { stayId: g2.id, guest: { name: 'Lata Iyer' } }] });
    assert.deepEqual(group.stays.map((s) => s.guest_name), ['Ravi Menon', 'Lata Iyer', 'Infotech Solutions Pvt Ltd']);
    // A stay of no group keeps its guest.
    const alone = await reserve({ guest: { name: 'Single Guest' }, arrival: addDays(T, 40), departure: addDays(T, 41), agreedRate: '4000' });
    await assert.rejects(rows('UPDATE lodging_stays SET contact_id=$2 WHERE id=$1', [alone.id, company.id]), /keeps its number, its guest/);
    // Checked in together (no early charge waived here: the policy's charges go to each room's folio).
    group = await request('POST', L(`lodging/groups/${group.id}/check-in`), { requestKey: key(), stays: [{ stayId: g1.id, guests: [occupant('Ravi Menon')] },
      { stayId: g2.id, guests: [occupant('Lata Iyer')] }, { stayId: g3.id, guests: [occupant('Mohan Das')] }] });
    assert.ok(group.stays.every((s) => s.status === 'in_house'));
    await request('POST', L(`lodging/stays/${g1.id}/charges`), { requestKey: key(), skuId: laundry.id, quantity: '1' }, 201);
    await request('POST', L('lodging/night-audit'), {});
    const onFolio = await rows("SELECT stay_id,amount,tax FROM lodging_charges WHERE folio_id=$1 AND kind='room_night' AND voided_at IS NULL", [group.folio_id]);
    assert.equal(onFolio.length, 3, 'each room\'s night is on the group\'s folio');
    // Two rooms leave together; the third stays on.
    group = await request('POST', L(`lodging/groups/${group.id}/check-out`), { requestKey: key(), stays: [{ stayId: g1.id, payment: { amount: 'full', method: 'cash' } }, { stayId: g2.id }] });
    assert.deepEqual(group.stays.map((s) => s.status), ['checked_out', 'checked_out', 'in_house']);
    assert.equal(group.bill, null, 'the group\'s folio waits for the last room');
    const early = (stayId) => rows("SELECT amount,folio_id FROM lodging_charges WHERE stay_id=$1 AND kind='early_check_in' AND voided_at IS NULL", [stayId]);
    const ravi = await request('GET', L(`lodging/stays/${g1.id}`));
    assert.ok(ravi.bill, 'Ravi\'s own bill: the laundry and the early check-in');
    assert.equal(ravi.bill.total, rupees(5900), "Ravi's own bill: the laundry; the early check-in goes with the room to the group's folio");
    assert.deepEqual((await early(g2.id)).map((x) => [x.amount, Number(x.folio_id)]), [['2000.00', Number(group.folio_id)]]);
    const billNow = await refused('POST', L(`lodging/groups/${group.id}/bill`), { requestKey: key() });
    assert.equal(billNow.status, 409);
    assert.match(billNow.message, /still reserved or in the house/);
    // The third leaves on its own a night early; then the group's folio is billed to the company, with its GSTIN, at the property's state.
    await request('POST', L(`lodging/stays/${g3.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const billKey = key();
    group = await request('POST', L(`lodging/groups/${group.id}/bill`), { requestKey: billKey });
    const doc = await request('GET', L(`documents/${group.document_id}`));
    assert.deepEqual([doc.contact_id, doc.buyer_gstin, doc.place_of_supply, doc.total], [company.id, '27AAPFU0939F1ZV', '36', '18900.00'],
      'three room nights at 4,200 and three early check-ins at 2,100');
    assert.equal(doc.lines.length, 6);
    assert.equal((await request('POST', L(`lodging/groups/${group.id}/bill`), { requestKey: billKey })).document_id, group.document_id);
    assert.equal((await one('SELECT document_id FROM lodging_folios WHERE id=$1', [group.folio_id])).document_id, group.document_id);
  });

  await t.test('split folios: room and tax to the company, extras and goods to the guest, billed as two invoices adding up; minibar goods leave stock when billed', async () => {
    let stay = await reserve({ guest: { name: 'Sunil Rao' }, arrival: today, departure: tomorrow, roomTypeId: suite.id, roomId: roomId('203'), agreedRate: '6000',
      advance: { amount: '1000', method: 'cash' } });
    const folioKey = key();
    stay = await request('POST', L(`lodging/stays/${stay.id}/folios`), { requestKey: folioKey, name: 'Company', contactId: company.id }, 201);
    assert.equal((await request('POST', L(`lodging/stays/${stay.id}/folios`), { requestKey: folioKey, name: 'Company', contactId: company.id }, 201)).folios.length, 1);
    const companyFolio = stay.folios.find((f) => f.name === 'Company');
    assert.equal((await refused('POST', L(`lodging/stays/${stay.id}/folios`), { requestKey: key(), name: 'company', contactId: company.id })).status, 409);
    stay = await request('PUT', L(`lodging/stays/${stay.id}/routing`), { room: companyFolio.id });
    assert.equal(Number(stay.routes.room), Number(companyFolio.id));
    stay = await request('POST', L(`lodging/stays/${stay.id}/check-in`), { requestKey: key(), guests: [occupant('Sunil Rao')] });
    // The early check-in charge follows the room to the company's folio; the laundry and the water go to the guest's.
    assert.equal(Number(stay.charges.find((x) => x.kind === 'early_check_in').folio_id), Number(companyFolio.id));
    await request('POST', L(`lodging/stays/${stay.id}/charges`), { requestKey: key(), skuId: laundry.id, quantity: '1' }, 201);
    const waterKey = key();
    stay = await request('POST', L(`lodging/stays/${stay.id}/charges`), { requestKey: waterKey, skuId: water.id, quantity: '2' }, 201);
    await request('POST', L(`lodging/stays/${stay.id}/charges`), { requestKey: waterKey, skuId: water.id, quantity: '2' }, 201);
    assert.deepEqual(stay.charges.filter((x) => x.kind === 'goods').map((x) => [x.amount, x.tax_rate, x.folio_id]), [['100.00', '18.00', null]]);
    // Goods leave stock when their folio is billed: the stock is all there until then, and no more is taken than is left beyond the folios.
    assert.equal(await stockOf(water.id), 10);
    const tooMany = await refused('POST', L(`lodging/stays/${stay.id}/charges`), { requestKey: key(), skuId: water.id, quantity: '9' });
    assert.equal(tooMany.status, 409);
    assert.match(tooMany.message, /^Only 8 of Mineral water 1 L is in stock at this property/);
    // A charge moved to another folio and back.
    const laundryCharge = stay.charges.find((x) => x.kind === 'extra');
    stay = await request('POST', L(`lodging/stays/${stay.id}/charges/${laundryCharge.id}/move`), { folioId: companyFolio.id });
    assert.equal(Number(stay.charges.find((x) => x.id === laundryCharge.id).folio_id), Number(companyFolio.id));
    stay = await request('POST', L(`lodging/stays/${stay.id}/charges/${laundryCharge.id}/move`), { folioId: null });
    assert.equal(stay.charges.find((x) => x.id === laundryCharge.id).folio_id, null);
    await request('POST', L('lodging/night-audit'), {});
    const preview = await request('POST', L(`lodging/stays/${stay.id}/check-out/preview`), {});
    assert.deepEqual(preview.folios.map((f) => [f.name, f.total]), [['Main', '177.00'], ['Company', '9450.00']]);
    stay = await request('POST', L(`lodging/stays/${stay.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'upi', reference: 'UPI-9' } });
    const guestBill = await request('GET', L(`documents/${stay.document_id}`));
    const companyBill = await request('GET', L(`documents/${stay.folios.find((f) => f.name === 'Company').document_id}`));
    assert.deepEqual([guestBill.contact_id, guestBill.total], [stay.contact_id, '177.00']);
    assert.deepEqual([companyBill.contact_id, companyBill.buyer_gstin, companyBill.total], [company.id, '27AAPFU0939F1ZV', '9450.00']);
    const all = await one('SELECT sum(net+tax) AS total FROM lodging_charges WHERE stay_id=$1 AND voided_at IS NULL', [stay.id]);
    assert.equal(Number(all.total), 177 + 9450, 'the two invoices add up to every charge');
    // The guest's advance paid the guest's bill; a receipt settles only its own customer's bills, so the rest stays held for the guest.
    assert.deepEqual([Number(guestBill.payments.find((p) => p.method === 'cash').amount), companyBill.payments.length, stay.advance_summary.left], [177, 0, '823.00']);
    assert.equal(await stockOf(water.id), 8, 'the water left stock with its bill');
  });

  await t.test('occupants joining and leaving partway, kept for the register with their dates', async () => {
    let stay = await reserve({ guest: { name: 'Neel Shah' }, arrival: today, departure: addDays(today, 2), roomId: roomId('108'), agreedRate: '4000' });
    stay = await request('POST', L(`lodging/stays/${stay.id}/check-in`), { requestKey: key(), guests: [occupant('Neel Shah')], waiver: { reason: 'Early arrival agreed' } });
    const joinKey = key();
    stay = await request('POST', L(`lodging/stays/${stay.id}/guests`), { requestKey: joinKey, guest: occupant('Meera Shah') }, 201);
    assert.equal((await request('POST', L(`lodging/stays/${stay.id}/guests`), { requestKey: joinKey, guest: occupant('Meera Shah') }, 201)).guests.length, 2);
    stay = await request('POST', L(`lodging/stays/${stay.id}/guests`), { requestKey: key(), guest: { fullName: 'Karl Jensen', foreigner: true, nationality: 'Danish', idKind: 'passport',
      idRef: 'DK1234567', visaType: 'e-Tourist visa', visaNo: 'ETV55443', arrivedIndiaOn: daysFrom(-2), nextDestination: 'Goa, India' } }, 201);
    assert.deepEqual([stay.adults, stay.guests.length], [3, 3]);
    const full = await refused('POST', L(`lodging/stays/${stay.id}/guests`), { requestKey: key(), guest: occupant('One More') });
    assert.equal(full.status, 409);
    assert.match(full.message, /takes at most 3 guests/);
    // The night posted with the third adult at the extra adult's rate.
    await request('POST', L('lodging/night-audit'), {});
    const night = (await charges(stay.id)).find((x) => x.kind === 'room_night');
    assert.deepEqual([night.extra_adults, night.amount, night.tax_rate], [1, '5000.00', '5.00']);
    const karl = stay.guests.find((g) => g.full_name === 'Karl Jensen');
    assert.equal((await request('GET', L('lodging/form-iii'))).items.find((g) => g.id === karl.id).next.event, 'arrival');
    // Karl leaves: his departure kept, the Form-III departure report due; then Meera; the last adult may not leave.
    stay = await request('POST', L(`lodging/stays/${stay.id}/guests/${karl.id}/leave`), { reason: 'Went on to Goa' });
    assert.deepEqual([stay.adults, Boolean(stay.guests.find((g) => g.id === karl.id).departed_at)], [2, true]);
    const report = (await request('GET', L('lodging/form-iii'))).items.find((g) => g.id === karl.id);
    assert.deepEqual([report.next.event, report.departure_open], ['arrival', true], 'the arrival report is still to make, and now the departure report too');
    stay = await request('POST', L(`lodging/stays/${stay.id}/guests/${stay.guests.find((g) => g.full_name === 'Meera Shah').id}/leave`), {});
    const last = await refused('POST', L(`lodging/stays/${stay.id}/guests/${stay.guests.find((g) => g.full_name === 'Neel Shah').id}/leave`), {});
    assert.deepEqual([last.status, last.message], [409, 'Neel Shah is the last adult in the room: check the stay out instead']);
    // The register keeps who joined and left, with their dates.
    const register = await request('GET', L(`lodging/register?from=${today}&to=${today}`));
    const kept = register.items.find((g) => g.full_name === 'Karl Jensen');
    assert.ok(kept.arrived_at && kept.departed_at);
    // The database: in the house, the adults are the occupants in the room.
    await assert.rejects(rows('UPDATE lodging_stays SET adults=3 WHERE id=$1', [stay.id]), /the occupants in the room/);
  });

  await t.test('guest profiles: preferences and notes from the guest\'s contact, with their past stays', async () => {
    const guest = mapStay.contact_id;
    let profile = await request('PUT', L(`lodging/profiles/${guest}`), { preferences: 'A quiet room on a high floor; feather-free pillows', notes: 'Pays by UPI' });
    assert.deepEqual([profile.preferences, profile.notes, profile.counts.stays], ['A quiet room on a high floor; feather-free pillows', 'Pays by UPI', 1]);
    assert.equal(profile.stays[0].stay_no, mapStay.stay_no);
    profile = await keeper.call('GET', L(`lodging/profiles/${guest}`));
    assert.equal(profile.stays[0].estimate_total, null, 'housekeeping sees no money');
    assert.equal((await refused('PUT', L(`lodging/profiles/${guest}`), { notes: 'x' }, keeper.token)).status, 403);
    const next = await reserve({ contactId: guest, arrival: addDays(T, 30), departure: addDays(T, 31), agreedRate: '4000' });
    assert.equal(next.profile.preferences, 'A quiet room on a high floor; feather-free pillows', 'the stay shows the guest\'s preferences');
  });

  await t.test('audit and events', async () => {
    const actions = (await rows('SELECT DISTINCT action FROM business_audit WHERE business_id=$1', [lodge.id])).map((r) => r.action);
    for (const action of ['lodging_rate_plan.created', 'lodging_season.created', 'lodging_rate_days.set', 'lodging_rate_days.cleared', 'lodging_day_use_rates.set', 'lodging_policy.created',
      'lodging_policy.waived', 'lodging_group.created', 'lodging_group.checked_in', 'lodging_group.checked_out', 'lodging_group.billed', 'lodging_stay.roomed', 'lodging_folio.opened',
      'lodging_stay.routed', 'lodging_charge.moved', 'lodging_guest.joined', 'lodging_guest.left', 'lodging_guest_profile.saved', 'lodging_stay.changed']) {
      assert.ok(actions.includes(action), `audit ${action}`);
    }
    const kinds = (await rows('SELECT DISTINCT kind FROM business_events WHERE business_id=$1', [lodge.id])).map((r) => r.kind);
    for (const kind of ['lodging_group.created', 'lodging_group.billed', 'lodging_guest.joined', 'lodging_guest.left', 'lodging_stay.nights_posted']) assert.ok(kinds.includes(kind), `event ${kind}`);
    // What is kept: a policy, a season, a plan and a group are never deleted; a folio neither.
    await assert.rejects(rows('DELETE FROM lodging_rate_plans WHERE id=$1', [saver.id]), /never deleted/);
    await assert.rejects(rows('DELETE FROM lodging_groups WHERE id=$1', [group.id]), /never deleted/);
    await assert.rejects(rows('DELETE FROM lodging_folios WHERE id=$1', [group.folio_id]), /never deleted/);
  });
});
