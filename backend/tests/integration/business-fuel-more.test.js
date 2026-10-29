const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom, momentAt } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The rest of a fuel station's back office: the attendant's other sales on a
// GST invoice in the shift's settlement, cash drops and the count by notes
// and coins, the attendant's account (a short due from them and recovered,
// an excess taken to income), a walk-in fill of ₹2,00,000 or more billed on
// its own with the buyer's PAN and the cash limit, fleet customers billed by
// the month with their slip books by serial, interest on overdue fleet
// credit, the stock register's shrinkage and TVA with a day posted to the
// stock, tanker loads compartment by compartment, retention samples, dip
// charts, the inspection log, the daily sales register and every outlet at
// a glance. Money adds up to the paisa, postings are idempotent, refusals
// carry their status, the database keeps its rules, audit and events are
// written. Runs on its own throwaway database with every migration applied.
test('fuel stations: the rest of the back office', { timeout: 600000 }, async (t) => {
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
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const tables = ['fuel_close_big_fills', 'fuel_close_goods_bills', 'fuel_close_counts', 'fuel_cash_drops', 'fuel_attendant_entries', 'fuel_fleet_terms', 'fuel_indent_books',
      'fuel_month_invoices', 'fuel_month_invoice_fills', 'fuel_fleet_interest', 'fuel_receipt_compartments', 'fuel_samples', 'fuel_dip_charts', 'fuel_stock_corrections', 'fuel_inspections'];
    const left = async () => (await scratch.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
    const column = async (table, name) => (await scratch.query('SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, name])).rows[0].n;
    const checks = async (table) => (await scratch.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'", [table])).rows.map((r) => r.d);
    assert.equal(await left(), tables.length);
    const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_fuel-more.sql')).split('_')[0]);
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.equal(await left(), 0);
    for (const [table, name] of [['fuel_shift_closes', 'dropped'], ['fuel_close_products', 'big_litres'], ['fuel_credit_slips', 'held'], ['fuel_receipt_lines', 'shrinkage_per_kl'],
      ['fuel_dips', 'from_chart'], ['fuel_settings', 'denominations']]) assert.equal(await column(table, name), 0, `${table}.${name} is gone`);
    assert.ok((await checks('fuel_shift_closes')).includes('CHECK ((difference = ((cash + other) - walk_in)))'), 'the close\'s own check is back');
    assert.ok((await checks('fuel_close_products')).includes('CHECK ((walk_in_litres = (litres - credit_litres)))'));
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await left(), tables.length);
  });

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
  const ownerUser = await owner('fuel-more-owner');
  await owner('fuel-more-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('fuel-more-owner@test.invalid');
  const request = as(ownerToken);
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);
  // Typed times are read to the minute: these are whole minutes on the clock.
  const ago = (minutes) => new Date(Math.floor(Date.now() / 60000) * 60000 - minutes * 60000).toISOString();

  const [fuel, grocery] = await createBusinesses(request, 'MORE', ['fuel_station', 'grocery']);
  const F = (suffix) => `/businesses/${fuel.id}/${suffix}`;
  const outlet = (await request('GET', F('locations'))).items[0];
  const roles = (await request('GET', F('roles?limit=100'))).items;
  async function staff(email, name, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,name', [ownerUser.restaurant_id, name, email, hash]);
    await request('POST', F('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, name, call: as(token), token };
  }
  const ravi = await staff('more-ravi@test.invalid', 'Ravi Kumar', 'pump_attendant');
  const manager = await staff('more-manager@test.invalid', 'Meena Manager', 'manager');
  const cashier = await staff('more-cashier@test.invalid', 'Lakshmi Cashier', 'cashier');
  const methods = await request('GET', F('payment-methods'));
  const upi = methods.find((m) => m.kind === 'upi');
  const bank = methods.find((m) => m.kind === 'bank');
  const stockOf = async (product, locationId = outlet.id) => (await one(`SELECT COALESCE(sum(l.quantity),0) AS q FROM business_stock_lots l JOIN fuel_products f ON f.business_id=l.business_id AND f.sku_id=l.sku_id
    WHERE l.business_id=$1 AND f.id=$2 AND l.location_id=$3`, [fuel.id, product.id, locationId])).q;
  const audited = (action) => one('SELECT * FROM business_audit WHERE business_id=$1 AND action=$2 ORDER BY id DESC LIMIT 1', [fuel.id, action]);
  const evented = (kind) => one('SELECT * FROM business_events WHERE business_id=$1 AND kind=$2 ORDER BY id DESC LIMIT 1', [fuel.id, kind]);

  // The forecourt: petrol and diesel, a tank each with stock, a unit with three nozzles, the prices; a lubricant on the 18% slab.
  let setupNow = await request('POST', F('fuel/products'), { item: { name: 'Petrol' }, family: 'petrol' }, 201);
  setupNow = await request('POST', F('fuel/products'), { item: { name: 'Diesel' }, family: 'diesel', sortOrder: '2' }, 201);
  const [petrol, diesel] = ['Petrol', 'Diesel'].map((name) => setupNow.products.find((p) => p.name === name));
  setupNow = await request('POST', F('fuel/tanks'), { locationId: outlet.id, productId: petrol.id, tankNo: 'T1', capacity: '20000', stockNow: { litres: '15000', unitCost: '94' } }, 201);
  setupNow = await request('POST', F('fuel/tanks'), { locationId: outlet.id, productId: diesel.id, tankNo: 'T2', capacity: '20000', stockNow: { litres: '15000', unitCost: '87' } }, 201);
  const [t1, t2] = ['T1', 'T2'].map((no) => setupNow.tanks.find((x) => x.tank_no === no));
  setupNow = await request('POST', F('fuel/dispensers'), { locationId: outlet.id, unitNo: 'DU 1', stampingDue: addDays(today, 300), nozzles: [
    { nozzleNo: '1', tankId: t1.id, reading: '100000' }, { nozzleNo: '2', tankId: t2.id, reading: '200000' }, { nozzleNo: '3', tankId: t2.id, reading: '300000' }] }, 201);
  const du1 = setupNow.dispensers[0];
  const [n1, n2, n3] = ['1', '2', '3'].map((no) => du1.nozzles.find((n) => n.nozzle_no === no));
  await request('POST', F('fuel/prices'), { requestKey: key(), locationId: outlet.id, effectiveFrom: ago(26 * 60), prices: [{ productId: petrol.id, price: '102.12' }, { productId: diesel.id, price: '95.20' }] }, 201);
  const slabs = (await request('GET', F('tax-rates'))).items;
  const gst18 = slabs.find((r) => Number(r.rate) === 18), nil = slabs.find((r) => Number(r.rate) === 0);
  const lube = await request('POST', F('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'Engine oil 1 L', code: 'LUBE-1', price: '450', taxRateId: gst18.id }, 201);
  await request('POST', F('stock/opening'), { locationId: outlet.id, lines: [{ skuId: lube.id, quantity: '24', unitCost: '300' }] }, 201).catch(() => null);
  if (Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [fuel.id, lube.id])).q) < 24) {
    const supplier = await request('POST', F('contacts'), { kind: 'supplier', name: 'Lube Distributors' }, 201);
    await request('POST', F('documents'), { kind: 'purchase', requestKey: key(), locationId: outlet.id, contactId: supplier.id, lines: [{ skuId: lube.id, quantity: '24', unitPrice: '300' }] }, 201);
  }
  // A nozzle's first shift opens from readings taken a while ago; a later one from now (after the last close on it).
const shiftOn = async (nozzles, minutes = null, who = ravi) => who.call('POST', F('fuel/shifts'), { requestKey: key(), locationId: outlet.id, ...(minutes ? { openedAt: ago(minutes) } : {}), nozzles }, 201);

  let shiftA, transports, truck, tempo, contractors, lorry;

  await t.test('the shift\'s other sales on a GST invoice, a cash drop and the count, the takings split over the two bills and the short on the attendant\'s account', async () => {
    shiftA = await shiftOn([n1.id], 120);
    // A cash drop of ₹300 to the manager while the shift is open; not to the attendant himself, and only a manager cancels one.
    assert.equal((await refused('POST', F(`fuel/shifts/${shiftA.id}/drops`), { requestKey: key(), amount: '300', receivedBy: ravi.id }, ravi.token)).status, 409);
    const dropKey = key();
    let s = await ravi.call('POST', F(`fuel/shifts/${shiftA.id}/drops`), { requestKey: dropKey, amount: '300', receivedBy: manager.id, note: 'Safe drop at noon' }, 201);
    assert.deepEqual([s.drops.length, s.drops[0].amount, s.drops[0].received_by_name, s.dropped], [1, '300.00', 'Meena Manager', '300.00']);
    assert.equal((await ravi.call('POST', F(`fuel/shifts/${shiftA.id}/drops`), { requestKey: dropKey, amount: '300', receivedBy: manager.id, note: 'Safe drop at noon' }, 201)).drops.length, 1,
      'the same drop again is the same drop');
    assert.equal((await refused('POST', F(`fuel/shifts/${shiftA.id}/drops`), { requestKey: dropKey, amount: '301', receivedBy: manager.id }, ravi.token)).status, 409);
    s = await ravi.call('POST', F(`fuel/shifts/${shiftA.id}/drops`), { requestKey: key(), amount: '50', receivedBy: manager.id }, 201);
    assert.equal((await refused('POST', F(`fuel/shifts/${shiftA.id}/drops/${s.drops[1].id}/cancel`), { reason: 'Typed twice' }, ravi.token)).status, 403);
    s = await manager.call('POST', F(`fuel/shifts/${shiftA.id}/drops/${s.drops[1].id}/cancel`), { reason: 'Typed twice' });
    assert.equal(s.dropped, '300.00', 'a cancelled drop is not counted');
    // Petrol 495.500 litres at ₹102.12 (₹50,600.46) to walk-in buyers; two engine oils (₹900, GST 18% inside); ₹51,000 by UPI; ₹200 counted in one note.
    const body = (extra = {}) => ({ requestKey: key(), readings: [{ nozzleId: n1.id, closing: '100500.500', test: '5' }], goods: [{ skuId: lube.id, quantity: '2' }],
      payments: [{ methodId: upi.id, amount: '51000' }], count: [{ denomination: 200, pieces: 1 }], ...extra });
    const preview = await ravi.call('POST', F(`fuel/shifts/${shiftA.id}/close/preview`), body());
    assert.deepEqual([preview.walkIn, preview.goodsWalkIn, preview.other, preview.goodsOther, preview.cash, preview.dropped, preview.cashPaid, preview.cashGoods, preview.difference, preview.short],
      ['50600.46', '900.00', '50600.46', '399.54', '200.00', '300.00', '0.00', '500.00', '-0.46', '0.46']);
    assert.deepEqual(preview.goods[0].lines.map((l) => [l.label, l.quantity, l.net, l.tax]), [['Engine oil 1 L', 2, '762.71', '137.29']]);
    assert.deepEqual(preview.takings.map((x) => [x.onFuel, x.onGoods]), [['50600.46', '399.54']], 'the UPI beyond the fuel pays the other sales');
    // Refused: a fuel among the other sales, a count with a note the station does not count, a count that is not the cash typed.
    assert.match((await refused('POST', F(`fuel/shifts/${shiftA.id}/close/preview`), body({ goods: [{ skuId: petrol.sku_id, quantity: '1' }] }), ravi.token)).message,
      /Petrol is sold by the meters: it is not one of the shift's other sales/);
    assert.equal((await refused('POST', F(`fuel/shifts/${shiftA.id}/close/preview`), body({ count: [{ denomination: 2000, pieces: 1 }] }), ravi.token)).status, 400);
    assert.match((await refused('POST', F(`fuel/shifts/${shiftA.id}/close/preview`), body({ cash: '250' }), ravi.token)).message, /cash counted is ₹250\.00, but the notes and coins come to ₹200\.00/);
    assert.match((await refused('POST', F(`fuel/shifts/${shiftA.id}/close/preview`), body({ payments: [{ methodId: upi.id, amount: '52000' }] }), ravi.token)).message,
      /more than the ₹50600\.46 of walk-in sales and the ₹900\.00 of other sales/);
    const closeBody = body();
    const closed = await ravi.call('POST', F(`fuel/shifts/${shiftA.id}/close`), closeBody);
    assert.equal((await ravi.call('POST', F(`fuel/shifts/${shiftA.id}/close`), closeBody)).close.id, closed.close.id, 'the same close again is the same close');
    assert.deepEqual([closed.close.goods_walk_in, closed.close.goods_other, closed.close.dropped, closed.close.cash, closed.close.difference, closed.close.counts.length],
      ['900.00', '399.54', '300.00', '200.00', '-0.46', 1]);
    const fuelBill = await request('GET', F(`documents/${closed.close.document_id}`));
    assert.deepEqual([fuelBill.total, fuelBill.tax, fuelBill.payments.map((p) => [p.method, p.amount])], ['50600.46', '0.00', [['upi', '50600.46']]], 'the fuel bill: non-GST lines only');
    const goodsBill = await request('GET', F(`documents/${closed.close.bills.find((b) => b.part === 'goods').id}`));
    assert.deepEqual([goodsBill.total, goodsBill.tax, goodsBill.contact_id, goodsBill.lines.map((l) => [l.label, l.tax_rate])], ['900.00', '137.29', null, [['Engine oil 1 L', '18.00']]]);
    assert.deepEqual(goodsBill.payments.map((p) => [p.method, p.method_name, p.amount]), [['credit_note', 'Attendant account', '0.46'], ['upi', 'UPI', '399.54'], ['cash', null, '500.00']],
      'paid what is left of the takings, then the cash, then the attendant\'s account: nothing left due');
    // The short is due from Ravi, not left on the bills.
    let account = await manager.call('GET', F(`fuel/attendant-accounts/${ravi.id}`));
    assert.deepEqual([account.now.due, account.now.held, account.entries.map((e) => [e.kind, e.amount, e.shift_no])], ['0.46', '0.00', [['short', '0.46', shiftA.shift_no]]]);
    assert.ok(await evented('fuel_drop.made'));
    assert.ok(await audited('fuel_drop.cancelled'));
    // The database: a drop of a closed shift is kept, a close's parts and the account are kept as written.
    await assert.rejects(pool.query('UPDATE fuel_cash_drops SET amount=1 WHERE shift_id=$1', [shiftA.id]), /keeps what was handed over/);
    await assert.rejects(pool.query('DELETE FROM fuel_attendant_entries WHERE close_id=$1', [closed.close.id]), /kept as it was written/);
    await assert.rejects(pool.query('UPDATE fuel_close_counts SET pieces=2 WHERE close_id=$1', [closed.close.id]), /kept as they were closed/);
    // A manager reopens it: the bills credited, the goods back in stock, the takings and the account's payment handed back, the short reversed.
    const lubeBefore = (await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [fuel.id, lube.id])).q;
    const reopened = await manager.call('POST', F(`fuel/shifts/${shiftA.id}/reopen`), { requestKey: key(), reason: 'Petrol reading typed wrong' });
    assert.equal(reopened.status, 'open');
    const credited = await request('GET', F(`documents/${goodsBill.id}`));
    assert.deepEqual([credited.returns[0].total, credited.refunds.map((r) => [r.method, r.amount])], ['900.00', [['credit_note', '0.46'], ['upi', '399.54'], ['cash', '500.00']]]);
    assert.equal(Number((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [fuel.id, lube.id])).q), Number(lubeBefore) + 2);
    account = await manager.call('GET', F(`fuel/attendant-accounts/${ravi.id}`));
    assert.deepEqual([account.now.due, account.entries.map((e) => e.kind)], ['0.00', ['short', 'short_reversed']]);
    // Closed again; the drop still counts.
    const again = await ravi.call('POST', F(`fuel/shifts/${shiftA.id}/close`), body());
    assert.deepEqual([again.close.seq, again.close.dropped, again.close.difference], [2, '300.00', '-0.46']);
  });

  await t.test('the attendant\'s account: a short paid back or deducted from the wages, an excess taken to income by a manager, on the day\'s money', async () => {
    // Ravi pays his ₹0.46 in cash; not more than he owes.
    assert.match((await refused('POST', F(`fuel/attendant-accounts/${ravi.id}/pay`), { requestKey: key(), locationId: outlet.id, amount: '1', method: 'cash' }, cashier.token)).message,
      /Ravi Kumar owes ₹0\.46 on their account: no more than that is recovered/);
    const payKey = key();
    let account = await cashier.call('POST', F(`fuel/attendant-accounts/${ravi.id}/pay`), { requestKey: payKey, locationId: outlet.id, amount: '0.46', method: 'cash' }, 201);
    assert.equal(account.now.due, '0.00');
    await cashier.call('POST', F(`fuel/attendant-accounts/${ravi.id}/pay`), { requestKey: payKey, locationId: outlet.id, amount: '0.46', method: 'cash' }, 201);
    assert.equal((await one("SELECT count(*)::int AS n FROM fuel_attendant_entries WHERE business_id=$1 AND kind='paid'", [fuel.id])).n, 1, 'the same payment again is the same payment');
    assert.equal((await refused('POST', F(`fuel/attendant-accounts/${ravi.id}/pay`), { requestKey: payKey, locationId: outlet.id, amount: '0.40', method: 'cash' }, cashier.token)).status, 409);
    assert.equal((await refused('POST', F(`fuel/attendant-accounts/${ravi.id}/pay`), { requestKey: key(), locationId: outlet.id, amount: '1', method: 'cash' }, ravi.token)).status, 403);
    // A shift ₹100 short (diesel 100 litres at ₹95.20 = ₹9,520; ₹9,420 counted): deducted from his wages of ₹12,000 by the manager.
    const shiftB = await shiftOn([n2.id], 60);
    const closedB = await ravi.call('POST', F(`fuel/shifts/${shiftB.id}/close`), { requestKey: key(), readings: [{ nozzleId: n2.id, closing: '200100' }], cash: '9420' });
    assert.equal(closedB.close.difference, '-100.00');
    assert.equal((await refused('POST', F(`fuel/attendant-accounts/${ravi.id}/deduct`), { requestKey: key(), locationId: outlet.id, amount: '100', note: 'October wages' }, cashier.token)).status, 403);
    assert.equal((await refused('POST', F(`fuel/attendant-accounts/${ravi.id}/deduct`), { requestKey: key(), locationId: outlet.id, amount: '100' })).status, 400, 'a deduction says what it is for');
    account = await manager.call('POST', F(`fuel/attendant-accounts/${ravi.id}/deduct`), { requestKey: key(), locationId: outlet.id, amount: '100', note: 'October wages',
      wages: '11900', wagesPaidBy: { method: 'cash' } }, 201);
    assert.equal(account.now.due, '0.00');
    const wages = await one("SELECT * FROM business_expenses WHERE business_id=$1 AND category='wages' ORDER BY id DESC LIMIT 1", [fuel.id]);
    assert.deepEqual([wages.amount, wages.method], ['11900.00', 'cash'], 'the wages paid out, less the deduction, in the expense book');
    // A shift ₹25.50 in excess (diesel 50 litres = ₹4,760; ₹4,785.50 counted): held until the manager takes it to income.
    const shiftC = await shiftOn([n3.id], 50);
    await ravi.call('POST', F(`fuel/shifts/${shiftC.id}/close`), { requestKey: key(), readings: [{ nozzleId: n3.id, closing: '300050' }], cash: '4785.50' });
    account = await manager.call('GET', F(`fuel/attendant-accounts/${ravi.id}`));
    assert.equal(account.now.held, '25.50');
    assert.match((await refused('POST', F(`fuel/attendant-accounts/${ravi.id}/to-income`), { requestKey: key(), locationId: outlet.id, amount: '30', note: 'Month end' })).message,
      /₹25\.50 of Ravi Kumar is held as excess: no more than that goes to income/);
    account = await manager.call('POST', F(`fuel/attendant-accounts/${ravi.id}/to-income`), { requestKey: key(), locationId: outlet.id, amount: '25.50', note: 'Month end: excess not claimed' }, 201);
    assert.equal(account.now.held, '0.00');
    // Per attendant and period, and on the day's money.
    const accounts = await manager.call('GET', F('fuel/attendant-accounts'));
    const mine = accounts.items.find((x) => x.attendantId === Number(ravi.id));
    assert.deepEqual([mine.period.short, mine.period.excess, mine.period.paid, mine.period.deducted, mine.period.toIncome, mine.period.shortReversed, mine.closing.due, mine.closing.held],
      ['100.92', '25.50', '0.46', '100.00', '25.50', '0.46', '0.00', '0.00']);
    const day = await request('GET', F(`reports/takings?from=${today}&to=${today}`));
    assert.deepEqual([day.received.fromAttendants, day.received.otherIncome], ['0.46', '25.50']);
    assert.equal((await refused('GET', F('fuel/attendant-accounts'), undefined, ravi.token)).status, 403, 'the attendants\' money is for those who see sales');
    assert.ok(await audited('fuel_attendant.deducted'));
    assert.ok(await evented('fuel_attendant.excess_to_income'));
    // The reopening of a shift whose excess went to income is refused.
    const back = await refused('POST', F(`fuel/shifts/${shiftC.id}/reopen`), { requestKey: key(), reason: 'Check' });
    assert.deepEqual([back.status, /excess of this shift was taken to income since/.test(back.message)], [409, true]);
  });

  await t.test('a walk-in fill of ₹2,00,000 or more on a bill of its own, with the buyer\'s PAN and the cash limit', async () => {
    const shift = await shiftOn([n2.id]);
    // Diesel 2,200 litres: 2,150 to one buyer (₹2,04,680.00), 50 litres to the walk-in bill (₹4,760.00).
    const fill = (extra = {}) => ({ productId: diesel.id, litres: '2150', registration: 'ka 01 ab 1234', buyerName: 'Sri Ganesh Constructions', pan: 'AAACG1234K',
      payments: [{ methodId: bank.id, amount: '150000', reference: 'NEFT 991' }, { method: 'cash', amount: '54680' }], ...extra });
    const body = (fills, extra = {}) => ({ requestKey: key(), readings: [{ nozzleId: n2.id, closing: '202300' }], cash: '59440', bigFills: fills, ...extra });
    const tryIt = (fills, extra) => refused('POST', F(`fuel/shifts/${shift.id}/close/preview`), body(fills, extra), ravi.token);
    assert.equal((await tryIt([fill({ pan: undefined })])).status, 400, 'the buyer\'s PAN, or their declaration');
    assert.match((await tryIt([fill({ litres: '2000', payments: [{ method: 'cash', amount: '190400' }] })])).message, /comes to ₹190400\.00: a fill under ₹2,00,000 goes on the walk-in fuel bill/);
    assert.match((await tryIt([fill({ payments: [{ method: 'cash', amount: '204680' }] })])).message, /Cash of ₹2,00,000 or more cannot be taken for one bill/);
    assert.match((await tryIt([fill({ payments: [{ method: 'cash', amount: '100' }] })])).message, /it is paid ₹100\.00/);
    const twice = await tryIt([fill(), fill({ litres: '0.001', payments: [{ method: 'cash', amount: '0.10' }] })]);
    assert.equal(twice.status, 409);
    const preview = await ravi.call('POST', F(`fuel/shifts/${shift.id}/close/preview`), body([fill()]));
    assert.deepEqual([preview.bigFills[0].amount, preview.big, preview.bigCash, preview.walkIn, preview.expected, preview.difference],
      ['204680.00', '204680.00', '54680.00', '4760.00', '209440.00', '0.00']);
    const closed = await ravi.call('POST', F(`fuel/shifts/${shift.id}/close`), body([fill()]));
    const big = closed.close.big_fills[0];
    const bill = await request('GET', F(`documents/${big.document_id}`));
    assert.deepEqual([bill.total, bill.contact_id, bill.buyer_pan, bill.round_off, bill.lines[0].label, bill.lines[0].quantity],
      ['204680.00', null, 'AAACG1234K', '0.00', 'Diesel · KA01AB1234 · price includes state VAT', '2150.000']);
    assert.deepEqual(bill.payments.map((p) => [p.method, p.amount]), [['bank', '150000.00'], ['cash', '54680.00']]);
    const walkIn = await request('GET', F(`documents/${closed.close.document_id}`));
    assert.deepEqual([walkIn.total, walkIn.payments.map((p) => [p.method, p.amount])], ['4760.00', [['cash', '4760.00']]], 'the walk-in bill takes the rest');
    assert.equal(big.buyer_pan, '••••••234K');
    // The same buyer's cash later today reaches the limit: refused.
    const next = await shiftOn([n3.id], null, manager);
    const later = await refused('POST', F(`fuel/shifts/${next.id}/close/preview`), { readings: [{ nozzleId: n3.id, closing: '302200' }], cash: '0',
      bigFills: [{ productId: diesel.id, litres: '2150', pan: 'AAACG1234K', payments: [{ methodId: bank.id, amount: '54680' }, { method: 'cash', amount: '150000' }] }] }, manager.token);
    assert.deepEqual([later.status, /from one person in a day.+would reach ₹204680\.00/.test(later.message)], [409, true]);
    await manager.call('POST', F(`fuel/shifts/${next.id}/close`), { requestKey: key(), readings: [{ nozzleId: n3.id, closing: '300050' }], cash: '0' });
    // A big fill's line is credited only by reopening its shift.
    const back = await refused('POST', F(`documents/${bill.id}/returns`), { requestKey: key(), reason: 'x', lines: [{ lineId: bill.lines[0].id, quantity: '1' }] });
    assert.match(back.message, /credited only by a manager reopening the shift/);
  });

  await t.test('fleet customers billed by the month with slip books by serial: fills held, one invoice for the month, the stock out once', async () => {
    transports = await request('POST', F('contacts'), { kind: 'customer', name: 'Sri Balaji Transports', creditDays: '15', creditLimit: '500000', pan: 'AAKFS1234B' }, 201);
    truck = await request('POST', F('fuel/vehicles'), { contactId: transports.id, registration: 'TS09UB4455', productId: diesel.id }, 201);
    tempo = await request('POST', F('fuel/vehicles'), { contactId: transports.id, registration: 'TS09UB4456', productId: diesel.id }, 201);
    // Billed by the month; a book of slips 1001 to 1050.
    assert.equal((await refused('PUT', F(`fuel/fleet/${transports.id}/terms`), { billing: 'month' }, ravi.token)).status, 403);
    const terms = await request('PUT', F(`fuel/fleet/${transports.id}/terms`), { billing: 'month', interestRate: '1.5', interestAfterDays: '0' });
    assert.deepEqual([terms.terms.billing, terms.terms.interestRate], ['month', '1.50']);
    let book = await request('POST', F('fuel/indent-books'), { contactId: transports.id, bookNo: 'B-21', firstSerial: '1001', lastSerial: '1050' }, 201);
    assert.deepEqual([book.slips, book.used, book.unused, book.unusedRanges], [50, 0, 50, [{ from: 1001, to: 1050 }]]);
    assert.match((await refused('POST', F('fuel/indent-books'), { contactId: transports.id, bookNo: 'B-22', firstSerial: '1040', lastSerial: '1100' })).message, /has book B-21 already, slips 1001 to 1050/);
    await assert.rejects(pool.query("INSERT INTO fuel_indent_books(business_id,contact_id,book_no,first_serial,last_serial,issued_on,created_by) VALUES($1,$2,'X',1050,1060,current_date,$3)",
      [fuel.id, transports.id, ownerUser.id]), /are in the customer's book B-21 already/);
    const stockBefore = await stockOf(diesel);
    const shift = await shiftOn([n3.id], null, manager);
    const slip = (vehicle, litres, slipNo) => ({ contactId: transports.id, vehicleId: vehicle.id, litres, ...(slipNo ? { slipNo } : {}) });
    const body = (slips) => ({ requestKey: key(), readings: [{ nozzleId: n3.id, closing: '302350' }], slips, cash: '0' });
    const preview = (slips) => refused('POST', F(`fuel/shifts/${shift.id}/close/preview`), body(slips), manager.token);
    assert.equal((await preview([slip(truck, '200')])).status, 400, 'a book customer\'s slip gives its serial');
    assert.match((await preview([slip(truck, '200', '2001')])).message, /slip 2001 is not in any of Sri Balaji Transports's slip books in use/);
    assert.match((await preview([slip(truck, '200', '1001'), slip(tempo, '100', '1001')])).message, /slip 1001 of book B-21 was used already/);
    // 2,300 litres: 200 and 100 on slips 1001 and 1002 (held for the month), the rest walk-in.
    const closed = await manager.call('POST', F(`fuel/shifts/${shift.id}/close`), { ...body([slip(truck, '200', '1001'), slip(tempo, '100', '1002')]), cash: '190400' });
    assert.deepEqual(closed.close.slips.map((x) => [x.serial, x.held, x.document_id]), [[1001, true, null], [1002, true, null]], 'no bill yet: held on the slips');
    assert.equal(closed.close.credit, '28560.00');
    assert.equal(await stockOf(diesel), (Number(stockBefore) - 2000).toFixed(3), 'the walk-in litres leave the stock; the held fills stay until the invoice');
    // Slip 1001 again on a later shift: refused (the database too).
    const shift2 = await shiftOn([n2.id], null, manager);
    assert.match((await refused('POST', F(`fuel/shifts/${shift2.id}/close/preview`), { readings: [{ nozzleId: n2.id, closing: '202400' }], slips: [slip(truck, '50', '1001')], cash: '0' },
      manager.token)).message, /slip 1001 of book B-21 was used already, on shift/);
    book = await request('GET', F(`fuel/indent-books/${book.id}`));
    assert.deepEqual([book.used, book.unused, book.usedSlips.map((x) => x.serial), book.unusedRanges[0]], [2, 48, [1001, 1002], { from: 1003, to: 1050 }]);
    // The statement: the month's fills unbilled; the fleet list counts them against the limit.
    const month = today.slice(0, 7);
    let statement = await request('GET', F(`fuel/fleet/${transports.id}/statement?month=${month}`));
    assert.deepEqual([statement.unbilled.fills, statement.unbilled.amount, statement.terms.billing], [2, '28560.00', 'month']);
    // One invoice for the month at the outlet: a line for each fill, the stock out now, once.
    const invoiceKey = key();
    const invoice = await request('POST', F(`fuel/fleet/${transports.id}/invoice`), { requestKey: invoiceKey, month, locationId: outlet.id }, 201);
    assert.deepEqual([invoice.total, invoice.fills], ['28560.00', 2]);
    assert.equal((await request('POST', F(`fuel/fleet/${transports.id}/invoice`), { requestKey: invoiceKey, month, locationId: outlet.id }, 201)).id, invoice.id, 'the same invoice again');
    assert.match((await refused('POST', F(`fuel/fleet/${transports.id}/invoice`), { requestKey: key(), month, locationId: outlet.id })).message, /are left to bill/);
    assert.equal(await stockOf(diesel), (Number(stockBefore) - 2300).toFixed(3));
    const doc = await request('GET', F(`documents/${invoice.document_id}`));
    assert.deepEqual([doc.contact_id, doc.tax, doc.round_off, doc.lines.length, doc.due_on], [transports.id, '0.00', '0.00', 2, addDays(today, 15)]);
    assert.match(doc.lines[0].label, /^Diesel · TS09UB4455 · .+ · slip 1001 · price includes state VAT$/);
    statement = await request('GET', F(`fuel/fleet/${transports.id}/statement?month=${month}`));
    assert.deepEqual([statement.unbilled.fills, statement.invoices.length, statement.invoices[0].fills], [0, 1, 2]);
    // Its lines are not credited on their own; its shift is no longer reopened.
    assert.match((await refused('POST', F(`documents/${doc.id}/returns`), { requestKey: key(), reason: 'x', lines: [{ lineId: doc.lines[0].id, quantity: '1' }] })).message,
      /billed on the month's invoice: it is not credited on its own/);
    assert.match((await refused('POST', F(`fuel/shifts/${shift.id}/reopen`), { requestKey: key(), reason: 'x' })).message, /fleet fills are billed on the month's invoice .+: it is no longer reopened/);
    assert.ok(await evented('fuel_month_invoice.billed'));
    // A month gone by with fills not invoiced: the bell says so.
    const late = await manager.call('POST', F(`fuel/shifts/${shift2.id}/close`), { requestKey: key(), readings: [{ nozzleId: n2.id, closing: '202400' }], slips: [slip(truck, '100', '1003')], cash: '0' });
    const client = await pool.connect();
    try {
      await client.query('ALTER TABLE fuel_shift_closes DISABLE TRIGGER fuel_shift_closes_check');
      await client.query("UPDATE fuel_shift_closes SET closed_at=closed_at-interval '40 days' WHERE id=$1", [late.close.id]);
    } finally {
      await client.query('ALTER TABLE fuel_shift_closes ENABLE TRIGGER fuel_shift_closes_check');
      client.release();
    }
    const bell = await request('GET', F('notifications'));
    const pastMonth = (await one("SELECT to_char(closed_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM') AS m FROM fuel_shift_closes WHERE id=$1", [late.close.id])).m;
    assert.ok(bell.items.some((n) => n.category === 'Fuel' && /^Sri Balaji Transports's fills of .+ are not invoiced$/.test(n.title) && n.link.endsWith(`?month=${pastMonth}`)));
    await request('POST', F(`fuel/fleet/${transports.id}/invoice`), { requestKey: key(), month: pastMonth, locationId: outlet.id }, 201);
    assert.ok(!(await request('GET', F('notifications'))).items.some((n) => /are not invoiced$/.test(n.title)), 'billed: the bell is quiet');
  });

  await t.test('interest on overdue fleet credit by the customer\'s terms, to the paisa, posted when someone confirms it', async () => {
    contractors = await request('POST', F('contacts'), { kind: 'customer', name: 'Ramesh Contractors', creditDays: '0' }, 201);
    lorry = await request('POST', F('fuel/vehicles'), { contactId: contractors.id, registration: 'AP29TB0042', productId: diesel.id }, 201);
    await request('PUT', F(`fuel/fleet/${contractors.id}/terms`), { billing: 'shift', interestRate: '2', interestAfterDays: '0' });
    const shift = await shiftOn([n2.id]);
    const closed = await ravi.call('POST', F(`fuel/shifts/${shift.id}/close`), { requestKey: key(), readings: [{ nozzleId: n2.id, closing: '202600' }],
      slips: [{ contactId: contractors.id, vehicleId: lorry.id, litres: '200' }], cash: '0' });
    const bill = closed.close.slips[0].document_id;
    // The bill fell due 30 days ago: ₹19,040.00 × 2% a month × 30/30 = ₹380.80.
    const client = await pool.connect();
    try {
      await client.query('ALTER TABLE business_documents DISABLE TRIGGER USER');
      await client.query('UPDATE business_documents SET due_on=$2 WHERE id=$1', [bill, addDays(today, -30)]);
    } finally {
      await client.query('ALTER TABLE business_documents ENABLE TRIGGER USER');
      client.release();
    }
    let interest = await request('GET', F(`fuel/fleet/${contractors.id}/interest`));
    assert.deepEqual([interest.worked, interest.billed, interest.due, interest.bills[0].days, interest.bills[0].owedDays], ['380.80', '0.00', '380.80', 30, 1904000 * 30]);
    assert.match((await refused('POST', F(`fuel/fleet/${contractors.id}/interest`), { requestKey: key(), locationId: outlet.id, amount: '380.80' })).message, /Choose the service item interest is billed as/);
    const item = await request('POST', F('catalog'), { kind: 'service', unit: 'service', name: 'Interest on late payment', code: 'INT-1', price: '0', taxRateId: nil.id }, 201);
    await request('PUT', F('fuel/settings'), { interestSkuId: item.id });
    assert.equal((await refused('POST', F(`fuel/fleet/${contractors.id}/interest`), { requestKey: key(), locationId: outlet.id, amount: '380.80' }, cashier.token)).status, 403);
    assert.match((await refused('POST', F(`fuel/fleet/${contractors.id}/interest`), { requestKey: key(), locationId: outlet.id, amount: '380.00' })).message,
      /The interest due is now ₹380\.80, not ₹380\.00/);
    const chargeKey = key();
    interest = await request('POST', F(`fuel/fleet/${contractors.id}/interest`), { requestKey: chargeKey, locationId: outlet.id, amount: '380.80' }, 201);
    assert.deepEqual([interest.billed, interest.due, interest.charges.length], ['380.80', '0.00', 1]);
    await request('POST', F(`fuel/fleet/${contractors.id}/interest`), { requestKey: chargeKey, locationId: outlet.id, amount: '380.80' }, 201);
    assert.equal((await request('GET', F(`fuel/fleet/${contractors.id}/interest`))).charges.length, 1, 'the same charge again is the same charge');
    const charge = await request('GET', F(`documents/${interest.charges[0].document_id}`));
    assert.deepEqual([charge.total, charge.contact_id, charge.lines[0].label], ['380.80', contractors.id, `Interest on overdue fuel credit to ${Number(today.slice(8))} ${new Date(`${today}T00:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${today.slice(0, 4)} (2% a month)`]);
    assert.ok(await audited('fuel_fleet.interest_billed'));
  });

  await t.test('the stock register with a load\'s shrinkage and TVA (Annexure 9), a day posted to the stock; compartments, samples and dip charts', async () => {
    const highway = await request('POST', F('locations'), { name: 'Highway outlet', code: 'HWY' }, 201);
    let s = await request('POST', F('fuel/tanks'), { locationId: highway.id, productId: petrol.id, tankNo: 'H1', capacity: '20000', stockNow: { litres: '9000' } }, 201);
    s = await request('POST', F('fuel/tanks'), { locationId: highway.id, productId: diesel.id, tankNo: 'H2', capacity: '20000' }, 201);
    const [h1, h2] = ['H1', 'H2'].map((no) => s.tanks.find((x) => x.tank_no === no));
    s = await request('POST', F('fuel/dispensers'), { locationId: highway.id, unitNo: 'MPD 1', stampingDue: addDays(today, 300), nozzles: [{ nozzleNo: 'H1', tankId: h1.id, reading: '50000' }] }, 201);
    const nh = s.dispensers.find((d) => d.unit_no === 'MPD 1').nozzles[0];
    await request('POST', F('fuel/prices'), { requestKey: key(), locationId: highway.id, effectiveFrom: ago(180), prices: [{ productId: petrol.id, price: '102.50' }] }, 201);
    const terminal = await request('POST', F('contacts'), { kind: 'supplier', name: 'Cherlapally Terminal' }, 201);
    const yesterday = addDays(today, -1);
    await ravi.call('POST', F('fuel/dips'), { requestKey: key(), tankId: h1.id, dipOn: yesterday, takenAt: momentAt(yesterday, '06:00'), stock: '9000' }, 201);
    // 4,000 litres at ₹3,66,000 with shrinkage of ₹180 a KL (0.1967%: 7.869 litres) and a TVA of -₹40 a KL (-0.0437%: -1.749 litres); two compartments, a sample kept.
    const load = (invoiceNo, extra = {}) => ({ requestKey: key(), locationId: highway.id, contactId: terminal.id, invoiceNo, invoiceDate: today, lorryNo: 'AP29TB0042',
      receivedAt: ago(40), status: 'accepted', lines: [{ tankId: h1.id, invoiceLitres: '4000', invoiceAmount: '366000', invoiceDensity: '745.0', receiptDensity: '746.0', dipBefore: '8700',
        dipAfter: '12650', shrinkagePerKl: '180', tvaPerKl: '-40' }], ...extra });
    assert.match((await refused('POST', F('fuel/receipts'), load('HWY-0', { compartments: [{ compartmentNo: 1, tankId: h1.id, waterFound: false, waterCm: '2' }] }))).message,
      /water is measured only when the paste found it/);
    const received = await request('POST', F('fuel/receipts'), load('HWY-1101', {
      compartments: [{ compartmentNo: 1, tankId: h1.id, dipCm: '126.5', density: '746.2', temperature: '31.0', waterFound: false, checkLitres: '20', checkDensity: '746.1', checkTemperature: '30.8',
        shortLitres: '12', madeUpLitres: '12' }, { compartmentNo: 2, tankId: h1.id, dipCm: '98.0', density: '745.8', temperature: '30.5', waterFound: true, waterCm: '0.5', shortLitres: '0' }],
      samples: [{ tankId: h1.id, sampleNo: 'S-1101', sealNo: 'IOC 778812' }] }), 201);
    assert.deepEqual([received.lines[0].shrinkage_litres, received.lines[0].shrinkage_percent, received.lines[0].tva_litres, received.lines[0].tva_percent, received.lines[0].allowance_litres],
      ['7.869', '0.1967', '-1.749', '-0.0437', '6.120']);
    assert.deepEqual(received.compartments.map((x) => [x.compartment_no, x.water_found, x.check_litres, x.short_litres, x.made_up_litres]),
      [[1, false, '20.000', '12.000', '12.000'], [2, true, null, '0.000', '0.000']]);
    assert.deepEqual(received.samples.map((x) => [x.sample_no, x.seal_no, x.later_loads]), [['S-1101', 'IOC 778812', 0]]);
    await assert.rejects(pool.query('UPDATE fuel_receipt_compartments SET short_litres=1 WHERE receipt_id=$1', [received.id]), /kept as they were received/);
    const hs = await request('POST', F('fuel/shifts'), { requestKey: key(), locationId: highway.id, openedAt: ago(120), nozzles: [nh.id] }, 201);
    await request('POST', F(`fuel/shifts/${hs.id}/close`), { requestKey: key(), closedAt: ago(30), readings: [{ nozzleId: nh.id, closing: '50500', test: '5' }], cash: '50737.50' });
    await ravi.call('POST', F('fuel/dips'), { requestKey: key(), tankId: h1.id, stock: '12000' }, 201);
    // A = 9,000; B = 4,000; C = 6.120; D = 12,993.880; E = 495; F = 12,498.880; G = 12,000: 498.880 short, -4.16%, beyond 480 + 3.713.
    const register = await request('GET', F(`fuel/register?locationId=${highway.id}&from=${yesterday}&to=${today}`));
    const r = register.tanks.find((x) => x.tank_no === 'H1').rows[0];
    assert.deepEqual([r.opening, r.receipts, r.shrinkage, r.tva, r.afterAllowances, r.sales, r.book, r.closing, r.variation, r.percent, r.allowedLoss, r.flag, r.gap],
      ['9000.000', '4000.000', '7.869', '-1.749', '12993.880', '495.000', '12498.880', '12000.000', '-498.880', '-4.16', '483.713', 'loss', '-505.000']);
    // The manager posts the day to the stock: the gap between the dip and the stock by the meters and the invoices, once.
    const stockBefore = await stockOf(petrol, highway.id);
    assert.equal((await refused('POST', F('fuel/register/corrections'), { requestKey: key(), tankId: h1.id, day: yesterday, reason: 'Leak test' }, ravi.token)).status, 403);
    assert.match((await refused('POST', F('fuel/register/corrections'), { requestKey: key(), tankId: h1.id, day: today, reason: 'x' })).message, /still open: the next morning's dip closes it/);
    const postKey = key();
    const posted = await request('POST', F('fuel/register/corrections'), { requestKey: postKey, tankId: h1.id, day: yesterday, reason: 'Variation explained to the sales officer' }, 201);
    assert.deepEqual([posted.litres, posted.variation, posted.allowance], ['-505.000', '-498.880', '6.120']);
    assert.equal((await request('POST', F('fuel/register/corrections'), { requestKey: postKey, tankId: h1.id, day: yesterday, reason: 'Variation explained to the sales officer' }, 201)).id, posted.id);
    assert.equal((await refused('POST', F('fuel/register/corrections'), { requestKey: key(), tankId: h1.id, day: yesterday, reason: 'Again' })).status, 409);
    assert.equal(await stockOf(petrol, highway.id), (Number(stockBefore) - 505).toFixed(3));
    assert.ok(await one("SELECT 1 FROM business_stock_adjustments WHERE business_id=$1 AND quantity=-505 AND reason LIKE 'Stock register of tank H1%'", [fuel.id]));
    assert.ok(await audited('fuel_register.posted'));
    // Two later loads of petrol: the first load's sample is due for disposal, the last two loads' are kept.
    const second = await request('POST', F('fuel/receipts'), load('HWY-1102', { receivedAt: ago(20), lines: [{ tankId: h1.id, invoiceLitres: '1000', invoiceAmount: '91500', invoiceDensity: '745.0',
      receiptDensity: '745.0', dipBefore: '11000', dipAfter: '12000' }], samples: [{ tankId: h1.id, sampleNo: 'S-1102', sealNo: 'IOC 778900' }] }), 201);
    await request('POST', F('fuel/receipts'), load('HWY-1103', { receivedAt: ago(10), lines: [{ tankId: h1.id, invoiceLitres: '1000', invoiceAmount: '91500', invoiceDensity: '745.0',
      receiptDensity: '745.0', dipBefore: '12000', dipAfter: '13000' }] }), 201);
    const samples = await request('GET', F(`fuel/samples?locationId=${highway.id}`));
    assert.deepEqual(samples.items.map((x) => [x.sample_no, x.due]).sort(), [['S-1101', true], ['S-1102', false]]);
    assert.match((await refused('POST', F(`fuel/samples/${second.samples[0].id}/dispose`), {})).message, /kept until two more have come in/);
    const gone = await request('POST', F(`fuel/samples/${received.samples[0].id}/dispose`), { note: 'Poured back after two loads' });
    assert.equal(gone.disposed, true);
    assert.equal((await refused('POST', F(`fuel/samples/${received.samples[0].id}/dispose`), {})).status, 409);
    // The diesel tank's dip chart: a dip in cm reads its litres by a straight line between the chart's rows.
    assert.match((await refused('PUT', F(`fuel/tanks/${h2.id}/chart`), { rows: [{ cm: '0', litres: '0' }, { cm: '100', litres: '0' }] })).message, /litres rise with the dip/);
    assert.equal((await refused('PUT', F(`fuel/tanks/${h2.id}/chart`), { text: '0,0\n100,5000' }, ravi.token)).status, 403);
    const chart = await request('PUT', F(`fuel/tanks/${h2.id}/chart`), { text: 'cm,litres\n0,0\n100,5000\n150,9000\n200,14000' });
    assert.equal(chart.rows.length, 4);
    const dip = await ravi.call('POST', F('fuel/dips'), { requestKey: key(), tankId: h2.id, dipCm: '142.5', stock: '1' }, 201);
    assert.deepEqual([dip.stock, dip.from_chart, dip.dip_cm], ['8400.000', true, '142.5'], 'the chart\'s litres: 5000 + 4000 × 42.5 / 50');
    assert.match((await refused('POST', F('fuel/dips'), { requestKey: key(), tankId: h2.id, dipOn: yesterday, takenAt: momentAt(yesterday, '06:00'), dipCm: '250' }, ravi.token)).message,
      /outside tank H2's chart \(0\.0 to 200\.0 cm\)/);
    const board = await ravi.call('GET', F(`fuel/dips?locationId=${highway.id}`));
    assert.equal(board.tanks.find((x) => x.tank_no === 'H2').chart.length, 4);
    // The dashboard across outlets: today's shifts and sales, the register's variation, the dues and the alerts.
    const outlets = await request('GET', F('fuel/outlets'));
    const hw = outlets.outlets.find((o) => String(o.location.id) === String(highway.id));
    assert.deepEqual([hw.shifts.closed, hw.sales, hw.beyond, hw.stock.find((x) => x.tankNo === 'H1').flag, hw.litres.map((l) => [l.name, l.litres])],
      [1, '50737.50', 1, 'loss', [['Petrol', '495.000']]]);
    const main = outlets.outlets.find((o) => String(o.location.id) === String(outlet.id));
    assert.deepEqual([main.dues.unbilled, Number(main.dues.customers) > 0, main.shifts.open], ['0.00', true, 0]);
    assert.ok(hw.alerts.warning >= 1 && hw.alerts.items.some((a) => /Tank H1/.test(a.title)));
    // The daily sales register of the highway outlet.
    const sales = await request('GET', F(`fuel/sales-register?locationId=${highway.id}`));
    assert.deepEqual([sales.shifts.length, sales.shifts[0].nozzles[0].litres, sales.fuels.map((f) => [f.name, f.litres, f.amount]), sales.total],
      [1, '495.000', [['Petrol', '495.000', '50737.50']], '50737.50']);
    assert.match(sales.formatsNote, /oil companies' own formats are not matched/);
  });

  await t.test('the inspection log: kept as written, never erased', async () => {
    assert.equal((await refused('POST', F('fuel/inspections'), { locationId: outlet.id, inspectedOn: today, inspectedBy: 'x', findings: 'y' }, ravi.token)).status, 403);
    assert.equal((await refused('POST', F('fuel/inspections'), { locationId: outlet.id, inspectedOn: addDays(today, 1), inspectedBy: 'x', findings: 'y' })).status, 400);
    const entry = await request('POST', F('fuel/inspections'), { locationId: outlet.id, inspectedOn: today, inspectedBy: 'R. Sharma, sales officer', authority: 'Indian Oil',
      findings: 'Fire extinguishers due for refill; density register up to date', actions: 'Refill ordered' }, 201);
    assert.equal(entry.inspected_by, 'R. Sharma, sales officer');
    await assert.rejects(pool.query("UPDATE fuel_inspections SET findings='x' WHERE id=$1", [entry.id]), /never erased/);
    await assert.rejects(pool.query('DELETE FROM fuel_inspections WHERE id=$1', [entry.id]), /never erased/);
    assert.equal((await ravi.call('GET', F('fuel/inspections'))).length, 1);
    assert.ok(await audited('fuel_inspection.recorded'));
  });

  await t.test('other types are kept out of the new screens', async () => {
    for (const route of ['fuel/attendant-accounts', 'fuel/outlets', 'fuel/inspections', 'fuel/indent-books', 'fuel/samples']) {
      assert.equal((await refused('GET', `/businesses/${grocery.id}/${route}`)).status, 403, route);
    }
    assert.equal((await refused('POST', `/businesses/${grocery.id}/fuel/inspections`, { locationId: 1 })).status, 403);
  });
});
