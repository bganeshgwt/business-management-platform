const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { addDays, momentAt, today, zoneWithHour } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');
const rules = require('../../src/modules/gst-thresholds/services/gstThresholdsRules');

// An owner's GST thresholds across the businesses under one PAN, end to end on
// a throwaway database with every migration applied. One owner runs a
// restaurant (linked to the platform), a hardware shop, a kirana, a fuel
// station in another state and a supermarket under another PAN, and has a
// book depot with no PAN and a gift shop whose GSTINs disagree. A business's
// PAN is read from its GSTINs, or is the one its owner records while it has
// none, and is never guessed. Each business's turnover is its sales less
// returns before GST (nil-rated lines and the fuel bills included), on its
// own dates and clock (a shop's posting date, the restaurant's business day),
// for the financial year and the one before, with the projection to 31 March.
// The owner and the bell of each business under the PAN are warned nearing
// ₹5 crore (at the owner's warning level), past it (e-invoicing and 6-digit
// HSN / SAC codes), and nearing and at ₹10 crore (the IRP's 30 days): a figure
// passed last year applies now, one passed this year so far from the next
// 1 April. The catalogue then lists the items whose codes are shorter. A
// second owner who typed a GSTIN of the same PAN adds up only their own
// business. Staff see the warning only where they may see the business's
// money, with the PAN masked, and the sums only when they may see every
// business's money. The standing behind the bells is kept for five minutes,
// shaped for each person, and thrown away when a PAN or a warning level changes.
test('an owner\'s GST thresholds', { timeout: 900000 }, async (t) => {
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
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes the tables away and Up brings them back with the figures and their sources', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const left = async () => (await scratch.query(`SELECT count(*)::int AS tables FROM pg_tables
      WHERE tablename IN ('platform_gst_thresholds','business_gst_pans','owner_gst_settings')`)).rows[0].tables;
    assert.equal(await left(), 3);
    // This migration's Down half, after those of every newer one.
    await migrate({ direction: 'down', count: 1791978000000, timestamp: true });
    assert.equal(await left(), 0);
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await left(), 3);
    const figures = (await scratch.query(`SELECT code, turnover::text, comparison, hsn_digits, report_within_days, applies_from::text, source
      FROM platform_gst_thresholds ORDER BY platform_gst_thresholds.turnover, code`)).rows;
    assert.deepEqual(figures.map((f) => [f.code, f.turnover, f.comparison, f.hsn_digits, f.report_within_days, f.applies_from]), [
      ['e_invoicing', '50000000.00', 'above', null, null, null],
      ['hsn_digits', '50000000.00', 'above', 6, null, '2021-04-01'],
      ['irp_reporting_days', '100000000.00', 'at_or_above', null, 30, '2025-04-01'],
    ]);
    for (const figure of figures) assert.match(figure.source, /\(\w[\w.-]*\.(?:com|in)\//, `${figure.code} names its source`);
    // One row a code and date: a second e-invoicing figure with no date is refused.
    await assert.rejects(scratch.query(`INSERT INTO platform_gst_thresholds (code, name, applies, turnover, comparison, source)
      VALUES ('e_invoicing', 'E-invoicing', 'Again.', 1, 'above', 'None')`), { code: '23505' });
    // A warning level is a whole percent from 50 to 99.
    await assert.rejects(scratch.query(`INSERT INTO owner_gst_settings (user_id, warn_percent) VALUES (1, 40)`), { code: '23514' });
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require('../../src/modules/restaurant/setup/services/restaurant.service');
  const password = `Gst-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  // Every business and the restaurant keep one clock, reading an hour well
  // away from midnight and the restaurant's 5 am cut-off: "today" is one day.
  const zone = zoneWithHour(7, 21);
  const D = today(zone);
  const year = rules.financialYear(D);
  const lastYear = rules.yearBefore(year);
  // A figure passed this year so far applies from the next 1 April.
  const nextFrom = rules.yearAfterFrom(year);
  const nextApril = rules.longDay(nextFrom);
  const spice = await restaurantService.createRestaurant({ name: 'Spice Route', code: 'GSTSPICE', invoicePrefix: 'SR', timezone: zone,
    admin: { name: 'Priya Rao', email: 'priya@gst.invalid', password } });
  const kitchen = await restaurantService.createRestaurant({ name: 'Shah Kitchen', code: 'GSTSHAH', timezone: zone,
    admin: { name: 'Vikram Shah', email: 'vikram@gst.invalid', password } });

  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const priya = await login('priya@gst.invalid');
  const request = as(priya);
  const vikram = await login('vikram@gst.invalid');
  const other = as(vikram);
  const refused = async (method, route, body, token = priya) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message };
  };
  const key = () => crypto.randomUUID();
  const P1 = 'ABCPR1234K';
  const P2 = 'AAKFS5678M';

  // --- The owner's businesses ------------------------------------------------------------
  // The restaurant joins the platform (Link my restaurant) with Priya as its owner.
  await request('POST', '/businesses/link-restaurant', {});
  const spiceBiz = (await request('GET', '/businesses')).businesses.find((b) => Number(b.legacy_restaurant_id) === Number(spice.id));
  const add = (body, by = request) => by('POST', '/businesses', { timezone: zone, ...body }, 201);
  const hardware = await add({ businessType: 'hardware', name: 'Rao Hardware & Paints', code: 'GST-HARDWARE', gstin: '36ABCPR1234K1ZO' });
  const grocery = await add({ businessType: 'grocery', name: 'Rao Kirana Stores', code: 'GST-GROCERY' });
  // A fuel station in another state: another GSTIN, the same PAN.
  const fuel = await add({ businessType: 'fuel_station', name: 'Rao Highway Fuels', code: 'GST-FUEL', gstin: '29ABCPR1234K1ZJ' });
  const mart = await add({ businessType: 'supermarket', name: 'Fresh Mart', code: 'GST-MART', gstin: '36AAKFS5678M1ZA' });
  const books = await add({ businessType: 'books', name: 'Rao Book Depot', code: 'GST-BOOKS' });
  const gifts = await add({ businessType: 'general_retail', name: 'Rao Gifts', code: 'GST-GIFTS', gstin: '36BFMPK4321Q1ZY' });
  // The gift shop's counter at the airport is registered under Priya's own PAN: the two disagree.
  await request('POST', `/businesses/${gifts.id}/locations`, { name: 'Airport counter', code: 'AIR', gstin: '36ABCPR1234K2ZN' }, 201);
  // Vikram typed a GSTIN carrying Priya's PAN on a shop of his own.
  const theirs = await add({ businessType: 'grocery', name: 'Shah Kirana', code: 'GST-THEIRS', gstin: '36ABCPR1234K3ZM' }, other);
  // They came onto the platform long ago, so each year's pace runs from 1 April.
  await pool.query("UPDATE businesses SET created_at = now() - interval '800 days' WHERE id = ANY($1::bigint[])",
    [[hardware.id, grocery.id, fuel.id, mart.id, books.id, gifts.id, theirs.id, spiceBiz.id]]);
  await pool.query("UPDATE restaurants SET created_at = now() - interval '800 days' WHERE id = ANY($1::bigint[])", [[spice.id, kitchen.id]]);

  // The restaurant: prices before GST, and a GST number typed with a mistake in it.
  const s0 = await request('GET', '/restaurants/current/settings');
  const restaurantSettings = (gstNumber) => request('PUT', '/restaurants/current/settings', { ...s0, timezone: zone, taxMode: 'exclusive', defaultTaxPercentage: 5,
    serviceChargePercentage: 0, invoicePrefix: 'SR', gstSplit: true, autoConsumeStock: false, loyaltyEnabled: false, autoPrintBill: false, printShowQr: false, gstNumber });
  await restaurantSettings('36ABCPR1234K2ZX');

  // Staff: a manager of the hardware shop only; a manager of every business
  // under the PAN, the restaurant's business included; a cashier and a stock
  // keeper of the hardware shop; the restaurant's kitchen.
  const staff = async (email, memberships) => {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [spice.id, email, email, hash]);
    for (const [business, template] of memberships) {
      const roles = (await request('GET', `/businesses/${business.id}/roles?limit=100`)).items;
      await request('POST', `/businesses/${business.id}/members`, { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    }
    return login(email);
  };
  const shopManager = await staff('kiran@gst.invalid', [[hardware, 'manager']]);
  const allManager = await staff('meera@gst.invalid', [[hardware, 'manager'], [grocery, 'manager'], [fuel, 'manager'], [spiceBiz, 'manager']]);
  const cashier = await staff('ravi@gst.invalid', [[hardware, 'cashier']]);
  const keeper = await staff('sunil@gst.invalid', [[hardware, 'stock_keeper']]);
  const cook = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [spice.id, 'Cook', 'cook@gst.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='KITCHEN' AND restaurant_id IS NULL", [cook.id]);
  const cookToken = await login('cook@gst.invalid');

  const view = (by = request) => by('GET', '/businesses/gst-thresholds');
  const groupOf = (answer, pan) => answer.groups.find((g) => g.pan === pan);
  const shopBell = async (business, token = priya) => (await as(token)('GET', `/businesses/${business.id}/notifications`)).items.filter((i) => i.id.startsWith('gst-threshold:'));
  const restaurantBell = async (token = priya) => (await as(token)('GET', '/notifications')).items.filter((i) => i.source === 'gstThresholds');

  await t.test('a business\'s PAN comes from its GSTINs, or the one its owner records, and is never guessed', async () => {
    let answer = await view();
    assert.equal(answer.owner, true);
    assert.equal(answer.warnPercent, 80);
    assert.equal(answer.today, D);
    assert.deepEqual(answer.year, year);
    assert.deepEqual(answer.lastYear, lastYear);
    assert.deepEqual(answer.groups.map((g) => [g.pan, g.businesses.map((b) => b.name)]).sort(), [
      [P2, ['Fresh Mart']],
      [P1, ['Rao Hardware & Paints', 'Rao Highway Fuels']],
    ].sort());
    assert.deepEqual(groupOf(answer, P1).businesses.map((b) => [b.name, b.source, b.gstins]),
      [['Rao Hardware & Paints', 'gstin', ['36ABCPR1234K1ZO']], ['Rao Highway Fuels', 'gstin', ['29ABCPR1234K1ZJ']]]);
    assert.deepEqual(answer.notLinked.map((b) => [b.name, b.reason]), [
      ['Rao Book Depot', 'no_gstin'], ['Rao Gifts', 'gstins_differ'], ['Rao Kirana Stores', 'no_gstin'], ['Spice Route', 'gstin_invalid'],
    ]);
    assert.deepEqual(answer.notLinked.find((b) => b.name === 'Rao Gifts').pans, [P1, 'BFMPK4321Q']);
    assert.equal(answer.notLinked.find((b) => b.name === 'Spice Route').restaurant, true);
    // The figures, each with its source and the date it applies from.
    assert.deepEqual(answer.thresholds.map((f) => [f.code, f.turnover, f.inForce]), [
      ['e_invoicing', '50000000.00', true], ['hsn_digits', '50000000.00', true], ['irp_reporting_days', '100000000.00', true],
    ]);

    // The owner records the kirana's PAN: in capitals, the spaces taken out; the same again changes nothing.
    const recorded = await request('PUT', `/businesses/${grocery.id}/gst-pan`, { pan: ' abcpr 1234k ' });
    assert.deepEqual([recorded.pan, recorded.changed], [P1, true]);
    assert.equal((await request('PUT', `/businesses/${grocery.id}/gst-pan`, { pan: P1 })).changed, false);
    const audit = await rows("SELECT action, details FROM business_audit WHERE business_id=$1 AND action LIKE 'gst_pan.%' ORDER BY id", [grocery.id]);
    assert.deepEqual(audit, [{ action: 'gst_pan.recorded', details: { pan: '••••••234K', before: null } }], 'recorded once, the PAN masked in the log');
    // And the restaurant's, whose GST number is not a valid GSTIN.
    assert.equal((await request('PUT', `/businesses/${spiceBiz.id}/gst-pan`, { pan: P1 })).pan, P1);
    const logged = await rows("SELECT action, entity_type, entity_label, details FROM audit_logs WHERE restaurant_id=$1 AND action LIKE 'gst_pan%'", [spice.id]);
    assert.deepEqual(logged, [{ action: 'gst_pan_recorded', entity_type: 'restaurant', entity_label: 'Spice Route', details: { pan: '••••••234K', before: null } }]);

    // Refused: a business whose GSTIN carries its PAN, one whose GSTINs
    // disagree, a PAN not in its shape, someone who is not the owner, another
    // owner, and anyone who is not a member.
    const hasGstin = await refused('PUT', `/businesses/${hardware.id}/gst-pan`, { pan: 'AAKFS5678M' });
    assert.deepEqual([hasGstin.status, hasGstin.message], [409, 'This business takes its PAN from its GSTIN: ABCPR1234K. To change it, change the GSTIN in its settings.']);
    const differ = await refused('PUT', `/businesses/${gifts.id}/gst-pan`, { pan: P1 });
    assert.equal(differ.status, 409);
    assert.match(differ.message, /GSTINs carry different PANs \(ABCPR1234K and BFMPK4321Q\)/);
    const shape = await refused('PUT', `/businesses/${books.id}/gst-pan`, { pan: 'ABCPR1234' });
    assert.deepEqual([shape.status, shape.message], [400, 'PAN must look like ABCDE1234F: five letters, four digits and a letter']);
    assert.deepEqual(await refused('PUT', `/businesses/${grocery.id}/gst-pan`, { pan: P2 }, allManager),
      { status: 403, message: 'Only an owner of this business records the PAN it trades under' });
    assert.equal((await refused('PUT', `/businesses/${grocery.id}/gst-pan`, { pan: P2 }, vikram)).status, 404);
    assert.equal((await refused('PUT', `/businesses/${grocery.id}/gst-pan`, { pan: P2 }, shopManager)).status, 404);

    answer = await view();
    assert.deepEqual(groupOf(answer, P1).businesses.map((b) => [b.name, b.source, b.recordedPan]), [
      ['Rao Hardware & Paints', 'gstin', null], ['Rao Highway Fuels', 'gstin', null], ['Rao Kirana Stores', 'recorded', P1], ['Spice Route', 'recorded', P1],
    ]);
    assert.deepEqual(answer.notLinked.map((b) => b.name), ['Rao Book Depot', 'Rao Gifts']);

    // Cleared, the kirana is not linked again; recorded again, it is back.
    assert.equal((await request('PUT', `/businesses/${grocery.id}/gst-pan`, { pan: '' })).pan, null);
    assert.equal((await view()).notLinked.find((b) => b.name === 'Rao Kirana Stores').reason, 'no_gstin');
    await request('PUT', `/businesses/${grocery.id}/gst-pan`, { pan: P1 });
    assert.deepEqual((await rows("SELECT action FROM business_audit WHERE business_id=$1 AND action LIKE 'gst_pan.%' ORDER BY id", [grocery.id])).map((r) => r.action),
      ['gst_pan.recorded', 'gst_pan.cleared', 'gst_pan.recorded']);

    // The restaurant's GST number corrected: its PAN now comes from it, and no other can be recorded.
    await restaurantSettings('36ABCPR1234K2ZN');
    assert.equal(groupOf(await view(), P1).businesses.find((b) => b.name === 'Spice Route').source, 'gstin');
    assert.equal((await refused('PUT', `/businesses/${spiceBiz.id}/gst-pan`, { pan: P1 })).status, 409);

    // Vikram sees his own shop under the PAN he typed, and nothing of Priya's.
    const his = await view(other);
    assert.deepEqual(his.groups.map((g) => [g.pan, g.businesses.map((b) => b.name)]), [[P1, ['Shah Kirana']]]);
    assert.deepEqual(his.notLinked, []);
    // Someone who owns no business sees no turnover.
    const manager = await view(as(shopManager));
    assert.deepEqual([manager.owner, manager.groups, manager.notLinked], [false, [], []]);
    assert.equal(manager.thresholds.length, 3);
  });

  // --- The sales ---------------------------------------------------------------------------
  const nilOf = async (business, by = request) => (await by('GET', `/businesses/${business.id}/tax-rates?limit=100`)).items;
  const location = async (business, by = request) => (await by('GET', `/businesses/${business.id}/locations`)).items[0];
  const service = (business, body, by = request) => by('POST', `/businesses/${business.id}/catalog`, { kind: 'service', unit: 'service', ...body }, 201);
  const buyer = (business, by = request) => by('POST', `/businesses/${business.id}/contacts`, { kind: 'customer', name: 'Ravi Constructions', pan: 'AABCR1234Q' }, 201);
  async function setUp(business, by = request) {
    const slabs = await nilOf(business, by);
    return { nil: slabs.find((r) => Number(r.rate) === 0), gst18: slabs.find((r) => Number(r.rate) === 18), at: await location(business, by), buyer: await buyer(business, by) };
  }
  // A sale paid by bank transfer, moved to `at` (an instant) when given.
  async function sell(business, shop, lines, at = null, by = request) {
    const sale = await by('POST', `/businesses/${business.id}/documents`, { kind: 'sale', requestKey: key(), locationId: shop.at.id, contactId: shop.buyer.id,
      lines: lines.map(([sku, quantity]) => ({ skuId: sku.id, quantity: String(quantity) })), payment: { method: 'bank', amount: 'full' } }, 201);
    if (at) await pool.query('UPDATE business_documents SET created_at=$3 WHERE business_id=$1 AND id=$2', [business.id, sale.id, at]);
    return sale;
  }
  const local = (day, time) => momentAt(day, time, zone);
  const H = {}, G = {}, M = {};
  let siteSupply, siteVisit, bulk;
  const expected = {};

  await t.test('turnover is each business\'s sales less returns before GST, on its own dates and clock, the year so far and the year before', async () => {
    // The hardware shop: three contract supplies of ₹1 crore on the nil slab,
    // one taken back; tile laying at 18% (₹1,18,000 including GST is ₹1,00,000
    // before it); a site visit just after midnight on 1 April and one just
    // before it; last year a contract supply.
    Object.assign(H, await setUp(hardware));
    siteSupply = await service(hardware, { name: 'Site supply contract', code: 'SITE-SUPPLY', price: '10000000', taxRateId: H.nil.id, hsnCode: '9954' });
    siteVisit = await service(hardware, { name: 'Site visit', code: 'SITE-VISIT', price: '100000', taxRateId: H.nil.id });
    const tiles = await service(hardware, { name: 'Tile laying', code: 'TILE-LAY', price: '118000', taxRateId: H.gst18.id, hsnCode: '995473' });
    const contract = await sell(hardware, H, [[siteSupply, 3]]);
    const lines = (await request('GET', `/businesses/${hardware.id}/documents/${contract.id}`)).lines;
    await request('POST', `/businesses/${hardware.id}/documents/${contract.id}/returns`,
      { requestKey: key(), reason: 'One contract cancelled', lines: [{ lineId: lines[0].id, quantity: '1', restock: false }] }, 201);
    const laid = await sell(hardware, H, [[tiles, 1]]);
    assert.deepEqual([laid.subtotal, laid.tax, laid.total], ['100000.00', '18000.00', '118000.00']);
    await sell(hardware, H, [[siteVisit, 1]], local(year.from, '00:30'));
    await sell(hardware, H, [[siteVisit, 1]], local(addDays(year.from, -1), '23:30'));
    await sell(hardware, H, [[siteSupply, 1]], local(addDays(lastYear.from, 30), '12:00'));
    // An item no longer sold, with a short code: not one to fix.
    const old = await service(hardware, { name: 'Old rate card', code: 'OLD-RATE', price: '100', taxRateId: H.nil.id, hsnCode: '9954' });
    await request('PATCH', `/businesses/${hardware.id}/catalog/${old.id}`, { label: 'Old rate card', price: '100', taxRateId: H.nil.id, active: false });

    // The kirana: a rice supply contract on the nil slab; a purchase is no sale.
    Object.assign(G, await setUp(grocery));
    const rice = await service(grocery, { name: 'Rice supply contract', code: 'RICE-CONTRACT', price: '4000000', taxRateId: G.nil.id });
    await sell(grocery, G, [[rice, 1]]);
    const supplier = await request('POST', `/businesses/${grocery.id}/contacts`, { kind: 'supplier', name: 'Krishna Rice Mills' }, 201);
    const bag = await request('POST', `/businesses/${grocery.id}/catalog`, { name: 'Basmati rice 25 kg', code: 'BASMATI-25', kind: 'goods', unit: 'each',
      tracking: 'quantity', price: '2100', taxRateId: G.nil.id }, 201);
    await request('POST', `/businesses/${grocery.id}/documents`, { kind: 'purchase', requestKey: key(), locationId: G.at.id, contactId: supplier.id,
      lines: [{ skuId: bag.id, quantity: '250', unitPrice: '1800' }] }, 201);

    // The fuel station: one shift's walk-in fuel bill, 995 litres of petrol at ₹100 (outside GST, on the nil slab).
    const F = (route) => `/businesses/${fuel.id}/${route}`;
    const fuelAt = (await location(fuel)).id;
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const ago = (minutes) => new Date(minute - minutes * 60000).toISOString();
    const petrol = (await request('POST', F('fuel/products'), { item: { name: 'Petrol', hsnCode: '27101241' }, family: 'petrol' }, 201)).products.find((p) => p.name === 'Petrol');
    const tank = (await request('POST', F('fuel/tanks'), { locationId: fuelAt, productId: petrol.id, tankNo: 'T1', capacity: '15000', stockNow: { litres: '9000' } }, 201))
      .tanks.find((x) => x.tank_no === 'T1');
    const unit = (await request('POST', F('fuel/dispensers'), { locationId: fuelAt, unitNo: 'DU 1', make: 'Tokheim', stampingDue: addDays(D, 200),
      nozzles: [{ nozzleNo: '1', tankId: tank.id, reading: '100000' }] }, 201)).dispensers.find((d) => d.unit_no === 'DU 1');
    await request('POST', F('fuel/measures'), { locationId: fuelAt, name: '5-litre measure', litres: '5', stampingDue: addDays(D, 150) }, 201);
    await request('POST', F('fuel/prices'), { requestKey: key(), locationId: fuelAt, effectiveFrom: ago(26 * 60), prices: [{ productId: petrol.id, price: '100.00' }] }, 201);
    const shift = await request('POST', F('fuel/shifts'), { requestKey: key(), locationId: fuelAt, openedAt: ago(120), nozzles: [unit.nozzles[0].id] }, 201);
    const closed = await request('POST', F(`fuel/shifts/${shift.id}/close`), { requestKey: key(), closedAt: ago(60),
      readings: [{ nozzleId: unit.nozzles[0].id, closing: '101000', test: '5' }], cash: '99500' });
    assert.equal(Number(closed.close.difference), 0);

    // The restaurant: a wedding banquet billed (not paid yet); a mocktail and
    // a thali paid, the mocktail credited back; a bill voided; and two thali
    // bills raised just after midnight on 1 April, one on the night of
    // 31 March's business day still open, the other with no day open.
    const rates = await request('GET', '/menu/tax-rates');
    const food = rates.find((r) => r.isDefault);
    const drinks = rates.find((r) => Number(r.percentage) === 18);
    const category = await request('POST', '/menu/categories', { name: 'Banquets' }, 201);
    const dish = (name, price, rate) => request('POST', '/menu/products', { categoryId: category.id, name, price, taxRateId: rate.id, isAvailable: true }, 201);
    const banquet = await dish('Wedding banquet', 100000, food);
    const mocktail = await dish('Mocktail', 200, drinks);
    const thali = await dish('Thali', 500, food);
    await request('POST', '/business-day/open', { openingCash: 1000 }, 201);
    const bill = async (lines) => request('POST', '/bills', { orderId: (await request('POST', '/orders', { orderType: 'takeaway',
      items: lines.map(([product, quantity]) => ({ productId: product.id, quantity })) }, 201)).id }, 201);
    const wedding = await bill([[banquet, 10]]);
    assert.equal(wedding.taxableAmount, 1000000);
    const mixed = await bill([[mocktail, 1], [thali, 1]]);
    const paid = await request('POST', `/bills/${mixed.id}/payments`, { paymentMethod: 'upi', amount: mixed.dueAmount, transactionRef: 'UTR-GST-1' }, 201);
    const drink = paid.items.find((i) => i.itemName === 'Mocktail');
    await request('POST', `/bills/${mixed.id}/refunds`, { amount: drink.returnValue, refundMethod: 'upi', reason: 'Too sweet',
      items: [{ orderItemId: drink.orderItemId, quantity: 1 }] }, 201);
    assert.equal(Number((await one('SELECT taxable_value FROM credit_notes WHERE bill_id=$1', [mixed.id])).taxable_value), 200);
    const voided = await bill([[thali, 4]]);
    await request('PATCH', `/bills/${voided.id}/void`, { reason: 'Raised by mistake' });
    const night = await one(`INSERT INTO business_days (restaurant_id, business_date, opened_at, closed_at, day_status)
      VALUES ($1, $2, $3, $4, 'closed') RETURNING id`, [spice.id, addDays(year.from, -1), local(addDays(year.from, -1), '18:00'), local(year.from, '02:00')]);
    const lateNight = await bill([[thali, 2]]);
    const firstHour = await bill([[thali, 2]]);
    await pool.query('UPDATE bills SET billed_at=$2, business_day_id=$3 WHERE id=$1', [lateNight.id, local(year.from, '00:30'), night.id]);
    await pool.query('UPDATE bills SET billed_at=$2, business_day_id=NULL WHERE id=$1', [firstHour.id, local(year.from, '00:30')]);

    // The supermarket, under its own PAN: last year a supply of ₹6 crore, nothing this year.
    Object.assign(M, await setUp(mart));
    const wholesale = await service(mart, { name: 'Institutional supply', code: 'INST-SUPPLY', price: '60000000', taxRateId: M.nil.id, hsnCode: '9963' });
    await sell(mart, M, [[wholesale, 1]], local(addDays(lastYear.from, 60), '11:00'));

    // Vikram's shop: ₹2 crore this year.
    const V = await setUp(theirs, other);
    const his = await service(theirs, { name: 'Bulk grain supply', code: 'GRAIN', price: '20000000', taxRateId: V.nil.id }, other);
    await sell(theirs, V, [[his, 1]], null, other);

    const crore = (n) => Math.round(n * 1e9);
    Object.assign(expected, {
      'Rao Hardware & Paints': { thisYear: crore(3) - crore(1) + 10000000 + 10000000, lastYear: crore(1) + 10000000 },
      'Rao Kirana Stores': { thisYear: 400000000, lastYear: 0 },
      'Rao Highway Fuels': { thisYear: 9950000, lastYear: 0 },
      'Spice Route': { thisYear: 100000000 + 70000 - 20000 + 100000, lastYear: 100000 },
    });
    const answer = await view();
    const group = groupOf(answer, P1);
    for (const business of group.businesses) {
      const want = expected[business.name];
      assert.deepEqual([business.thisYear, business.lastYear], [rules.rupees(want.thisYear), rules.rupees(want.lastYear)], business.name);
      assert.equal(business.projected, rules.rupees(rules.projection(want.thisYear, { year, today: D })), `${business.name} at the pace so far`);
    }
    const thisYear = Object.values(expected).reduce((sum, b) => sum + b.thisYear, 0);
    const lastYearTotal = Object.values(expected).reduce((sum, b) => sum + b.lastYear, 0);
    assert.deepEqual([group.thisYear, group.lastYear], ['25301000.00', '10101000.00']);
    assert.equal(rules.toPaise(group.thisYear), thisYear);
    assert.equal(rules.toPaise(group.lastYear), lastYearTotal);
    assert.equal(rules.toPaise(group.projected), Object.values(expected).reduce((sum, b) => sum + rules.projection(b.thisYear, { year, today: D }), 0));
    assert.deepEqual(group.steps.map((s) => [s.turnover, s.state]), [['50000000.00', 'below'], ['100000000.00', 'below']]);
    assert.deepEqual(group.hsn, { applies: false, from: null, digits: null });
    // Not counted with Priya's: Vikram's shop, though its GSTIN carries her PAN.
    assert.equal(groupOf(await view(other), P1).thisYear, '20000000.00');
    // The supermarket's last year passed ₹5 crore: e-invoicing and 6-digit codes apply now, this year.
    const freshMart = groupOf(answer, P2);
    assert.deepEqual([freshMart.thisYear, freshMart.lastYear, freshMart.projected], ['0.00', '60000000.00', '0.00']);
    assert.deepEqual(freshMart.steps.map((s) => [s.state, s.by, s.appliesFrom]), [['crossed', 'last_year', null], ['below', null, null]]);
    assert.equal(freshMart.steps[0].words, `Turnover passed ₹5 crore in ${lastYear.label}: e-invoicing and 6-digit HSN / SAC codes on invoices apply`);
    assert.deepEqual(freshMart.hsn, { applies: true, from: null, digits: 6 });
    assert.equal(freshMart.businesses[0].hsnToFix, 1);
    // The business not linked to a PAN still shows what it sold.
    assert.equal(answer.notLinked.find((b) => b.name === 'Rao Book Depot').thisYear, '0.00');
  });

  await t.test('the warnings: nearing ₹5 crore at the owner\'s level, past it, nearing and at ₹10 crore, on the owner\'s view and every bell', async () => {
    const hsnBefore = await as(keeper)('GET', `/businesses/${hardware.id}/gst-thresholds/hsn`);
    assert.deepEqual(hsnBefore, { applies: false, from: null, digits: null, count: 0, rule: null });
    assert.deepEqual(await refused('GET', `/businesses/${hardware.id}/gst-thresholds/hsn-items`), {
      status: 409, message: 'HSN / SAC codes of a set length are not asked of this business\'s invoices yet: nothing to fix' });
    assert.deepEqual(await shopBell(hardware), [], 'below every figure: nothing to say');

    // ₹1.5 crore more: ₹4.03 crore, 80.6% of ₹5 crore.
    bulk = await service(hardware, { name: 'Bulk order', code: 'BULK', price: '15000000', taxRateId: H.nil.id, hsnCode: '99543210' });
    await sell(hardware, H, [[bulk, 1]]);
    let group = groupOf(await view(), P1);
    assert.equal(group.thisYear, '40301000.00');
    assert.deepEqual(group.steps.map((s) => [s.state, s.share, s.warnAt]), [['near', 80.6, '40000000.00'], ['below', 40.3, '80000000.00']]);
    let lines = await shopBell(hardware);
    assert.deepEqual(lines.map((l) => [l.id, l.severity, l.category, l.link]), [[`gst-threshold:${year.label}:50000000:near`, 'warning', 'GST', '/business-admin/gst-thresholds']]);
    assert.equal(lines[0].title,
      `Turnover is nearing ₹5 crore in ${year.label}: above ₹5 crore, e-invoicing and 6-digit HSN / SAC codes on invoices apply from ${nextApril}`);
    assert.equal(lines[0].detail, `PAN ${P1} · ₹4.03 crore in ${year.label} so far, 80.6% of ₹5 crore, across 4 businesses`);
    // Every business under the PAN warns, the restaurant on its own bell.
    assert.equal((await shopBell(grocery)).length, 1);
    assert.equal((await shopBell(fuel)).length, 1);
    let restaurant = await restaurantBell();
    assert.deepEqual(restaurant.map((l) => [l.id, l.severity, l.link]), [[`gstThresholds:${year.label}:50000000:near`, 'warning', '/business-admin/gst-thresholds']]);
    assert.equal(restaurant[0].detail, `PAN ••••••234K · the businesses under this PAN together, in ${year.label} so far`);

    // The owner's own warning level: at 90% nothing is near yet; it is a whole percent from 50 to 99.
    assert.deepEqual(await request('PUT', '/businesses/gst-thresholds/warning-level', { warnPercent: 90 }), { warnPercent: 90 });
    assert.deepEqual(await request('PUT', '/businesses/gst-thresholds/warning-level', { warnPercent: '90' }), { warnPercent: 90 }, 'the same again');
    group = groupOf(await view(), P1);
    assert.deepEqual(group.steps.map((s) => [s.state, s.warnAt]), [['below', '45000000.00'], ['below', '90000000.00']]);
    assert.deepEqual(await shopBell(hardware), []);
    assert.deepEqual(await restaurantBell(), []);
    for (const bad of [49, 100, 85.5, 'eighty', null]) {
      assert.deepEqual(await refused('PUT', '/businesses/gst-thresholds/warning-level', { warnPercent: bad }),
        { status: 400, message: 'Warning level must be a whole percent from 50 to 99' }, String(bad));
    }
    assert.deepEqual(await refused('PUT', '/businesses/gst-thresholds/warning-level', { warnPercent: 80 }, shopManager),
      { status: 403, message: 'Only the owner of a business sets the warning level of its GST thresholds' });
    await request('PUT', '/businesses/gst-thresholds/warning-level', { warnPercent: 80 });

    // ₹4 crore more: past ₹5 crore this year, so its rules apply from the next
    // 1 April; and ₹8.03 crore is nearing ₹10 crore.
    await sell(hardware, H, [[siteSupply, 4]]);
    group = groupOf(await view(), P1);
    assert.equal(group.thisYear, '80301000.00');
    assert.deepEqual(group.steps.map((s) => [s.state, s.by, s.appliesFrom]), [['crossed', 'this_year', nextFrom], ['near', null, null]]);
    assert.equal(group.steps[0].words,
      `Turnover has passed ₹5 crore in ${year.label} so far: from ${nextApril}, e-invoicing and 6-digit HSN / SAC codes on invoices apply`);
    assert.equal(group.steps[1].words,
      `Turnover is nearing ₹10 crore in ${year.label}: at ₹10 crore, the 30-day limit for reporting to the IRP applies from ${nextApril}`);
    assert.equal(group.steps[1].rules[0].reportWithinDays, 30);
    assert.equal(group.steps[1].onPace, true, 'at this pace it reaches ₹10 crore by 31 March');
    lines = await shopBell(hardware);
    assert.deepEqual(lines.map((l) => [l.id, l.severity]), [[`gst-threshold:${year.label}:50000000:crossed:this_year`, 'critical'], [`gst-threshold:${year.label}:100000000:near`, 'warning']],
      'passed this year so far is critical: the moment to prepare');
    assert.equal(lines[0].title, group.steps[0].words);
    assert.equal(lines[1].detail, `PAN ${P1} · ₹8.03 crore in ${year.label} so far, 80.3% of ₹10 crore, across 4 businesses`);
    restaurant = await restaurantBell();
    assert.deepEqual(restaurant.map((l) => [l.severity, l.link]), [['critical', '/menu/tax-rates'], ['warning', '/business-admin/gst-thresholds']]);
    assert.equal(restaurant[0].title, group.steps[0].words);

    // Exactly ₹10 crore: the 30 days apply from it, from the next 1 April too.
    const rest = 10000000000 - rules.toPaise(group.thisYear);
    const balance = await service(hardware, { name: 'Balance supply', code: 'BALANCE', price: rules.rupees(rest), taxRateId: H.nil.id, hsnCode: '995411' });
    await sell(hardware, H, [[balance, 1]]);
    group = groupOf(await view(), P1);
    assert.equal(group.thisYear, '100000000.00');
    assert.deepEqual(group.steps.map((s) => [s.state, s.by, s.appliesFrom]), [['crossed', 'this_year', nextFrom], ['crossed', 'this_year', nextFrom]]);
    assert.equal(group.steps[1].words, `Turnover has reached ₹10 crore in ${year.label} so far: from ${nextApril}, the 30-day limit for reporting to the IRP applies`);
    assert.deepEqual((await shopBell(hardware)).map((l) => l.id),
      [`gst-threshold:${year.label}:50000000:crossed:this_year`, `gst-threshold:${year.label}:100000000:crossed:this_year`]);
  });

  await t.test('the bell warns only those who may see the money: the PAN masked for all but the owner, the sums only for whoever may see every business\'s', async () => {
    const owner = await shopBell(hardware);
    assert.ok(owner.every((l) => l.detail.startsWith(`PAN ${P1} · ₹10 crore`) && l.link === '/business-admin/gst-thresholds'));
    // The hardware shop's manager alone: the warning, the PAN masked, no sums; past ₹5 crore it opens the catalogue.
    const masked = `PAN ••••••234K · the businesses under this PAN together, in ${year.label} so far`;
    const alone = await shopBell(hardware, shopManager);
    assert.deepEqual(alone.map((l) => [l.severity, l.detail, l.link]), [['critical', masked, `/business-admin/${hardware.id}/products`], ['critical', masked, null]]);
    // A manager of every business under the PAN may see their money: the sums, the PAN still masked.
    const all = await shopBell(hardware, allManager);
    assert.deepEqual(all.map((l) => l.detail), [
      `PAN ••••••234K · ₹10 crore in ${year.label} so far, 200% of ₹5 crore, across 4 businesses`,
      `PAN ••••••234K · ₹10 crore in ${year.label} so far, 100% of ₹10 crore, across 4 businesses`,
    ]);
    // The kirana's bell for the same manager says the same.
    assert.equal((await shopBell(grocery, allManager)).length, 2);
    // A cashier may not see the money: no warning. Nor the restaurant's kitchen.
    assert.deepEqual(await shopBell(hardware, cashier), []);
    assert.deepEqual(await restaurantBell(cookToken), []);
    // Vikram's shop stands alone: ₹2 crore, nothing to warn.
    assert.deepEqual(await shopBell(theirs, vikram), []);
    // The supermarket's owner is warned on its bell from last year's turnover: it applies now.
    const marts = await shopBell(mart);
    assert.deepEqual(marts.map((l) => [l.id, l.severity, l.title, l.detail]), [[`gst-threshold:${year.label}:50000000:crossed:last_year`, 'critical',
      `Turnover passed ₹5 crore in ${lastYear.label}: e-invoicing and 6-digit HSN / SAC codes on invoices apply`, `PAN ${P2} · ₹6 crore in ${lastYear.label}, across 1 business`]]);
    // Nothing of another owner's: the owner's view of a manager or of Vikram holds none of Priya's businesses.
    assert.deepEqual((await view(as(allManager))).groups, []);
    assert.ok((await view(other)).groups.every((g) => g.businesses.every((b) => b.name === 'Shah Kirana')));
  });

  await t.test('once 6-digit codes apply, now or from the next 1 April, the catalogue lists the items whose HSN / SAC code is shorter, to fix', async () => {
    // Whoever looks after the catalogue sees what to fix, not the turnover:
    // passed this year so far, the codes are asked from the next 1 April, and listed now to prepare.
    const summary = await as(keeper)('GET', `/businesses/${hardware.id}/gst-thresholds/hsn`);
    assert.deepEqual([summary.applies, summary.from, summary.digits, summary.count, summary.rule.code], [true, nextFrom, 6, 2, 'hsn_digits']);
    assert.deepEqual(Object.keys(summary).sort(), ['applies', 'count', 'digits', 'from', 'rule'], 'no sums in it');
    // The supermarket's passed last year: asked now.
    assert.deepEqual(await request('GET', `/businesses/${mart.id}/gst-thresholds/hsn`).then((s) => [s.applies, s.from, s.digits, s.count]), [true, null, 6, 1]);
    const page = await as(keeper)('GET', `/businesses/${hardware.id}/gst-thresholds/hsn-items?limit=10`);
    assert.equal(page.total, 2);
    assert.deepEqual(page.items.map((i) => [i.label, i.hsn_code, i.hsn_length, i.kind]), [['Site supply contract', '9954', 4, 'service'], ['Site visit', null, 0, 'service']]);
    assert.deepEqual((await request('GET', `/businesses/${hardware.id}/gst-thresholds/hsn-items?q=visit`)).items.map((i) => i.label), ['Site visit']);
    assert.equal((await refused('GET', `/businesses/${hardware.id}/gst-thresholds/hsn-items?limit=500`)).status, 400);
    // Fixed on the item, it leaves the list.
    await request('PATCH', `/businesses/${hardware.id}/catalog/${siteVisit.id}`, { label: 'Site visit', price: '100000', taxRateId: H.nil.id, hsnCode: '998719' });
    assert.equal((await request('GET', `/businesses/${hardware.id}/gst-thresholds/hsn`)).count, 1);
    // The owner's view counts them business by business: the kirana's rice items have none, the restaurant's 18% rate none.
    const group = groupOf(await view(), P1);
    assert.deepEqual(group.hsn, { applies: true, from: nextFrom, digits: 6 });
    assert.deepEqual(group.businesses.map((b) => [b.name, b.hsnToFix]), [
      ['Rao Hardware & Paints', 1], ['Rao Highway Fuels', 0], ['Rao Kirana Stores', 2], ['Spice Route', 1],
    ]);
    // The restaurant's codes are on its tax rates: the rates with a dish on the menu and a shorter code.
    const menu = await request('GET', '/gst-thresholds/hsn');
    assert.deepEqual([menu.applies, menu.from, menu.digits], [true, nextFrom, 6]);
    assert.deepEqual(menu.rates.map((r) => [r.name, r.hsn_code, r.dishes]), [['GST 18%', null, 1]]);
    assert.equal((await refused('GET', '/gst-thresholds/hsn', undefined, cookToken)).status, 403);
    // A business whose PAN is below ₹5 crore has nothing to fix.
    assert.equal((await as(vikram)('GET', `/businesses/${theirs.id}/gst-thresholds/hsn`)).applies, false);
    // Someone not a member of the business is not told.
    assert.equal((await refused('GET', `/businesses/${hardware.id}/gst-thresholds/hsn`, undefined, vikram)).status, 404);
  });

  await t.test('the standing behind the bells is kept five minutes for everyone, shaped for each person, and thrown away when a PAN or a warning level changes', async () => {
    // Kept answers, as outside tests (utils/keptAnswers.js).
    process.env.NOTIFICATIONS_CACHE = 'on';
    try {
      const owner = await shopBell(hardware);
      assert.ok(owner[0].detail.startsWith(`PAN ${P1} · ₹10 crore in ${year.label} so far`));
      // A sale now is not in the kept standing: for five minutes the bell answers as it was.
      const extra = await service(hardware, { name: 'Extra supply', code: 'EXTRA', price: '10000000', taxRateId: H.nil.id, hsnCode: '995411' });
      await sell(hardware, H, [[extra, 1]]);
      assert.deepEqual(await shopBell(hardware), owner, 'the kept standing answers');
      // Each person's lines are still their own: the manager's PAN masked, without the sums.
      assert.deepEqual((await shopBell(hardware, shopManager)).map((l) => l.detail),
        Array(2).fill(`PAN ••••••234K · the businesses under this PAN together, in ${year.label} so far`));
      // The owner's view adds up afresh every time.
      assert.equal(groupOf(await view(), P1).thisYear, '110000000.00');
      // A warning level saved throws every kept standing away.
      await request('PUT', '/businesses/gst-thresholds/warning-level', { warnPercent: 85 });
      assert.ok((await shopBell(hardware))[0].detail.startsWith(`PAN ${P1} · ₹11 crore`));
      await sell(hardware, H, [[extra, 1]]);
      assert.ok((await shopBell(hardware))[0].detail.startsWith(`PAN ${P1} · ₹11 crore`), 'kept again');
      // The same PAN again changes nothing, and what is kept stays.
      assert.equal((await request('PUT', `/businesses/${grocery.id}/gst-pan`, { pan: P1 })).changed, false);
      assert.ok((await shopBell(hardware))[0].detail.startsWith(`PAN ${P1} · ₹11 crore`));
      // A PAN recorded (here the book depot's, under the supermarket's PAN) throws it away.
      await request('PUT', `/businesses/${books.id}/gst-pan`, { pan: P2 });
      assert.ok((await shopBell(hardware))[0].detail.startsWith(`PAN ${P1} · ₹12 crore`));
      await request('PUT', `/businesses/${books.id}/gst-pan`, { pan: '' });
      await request('PUT', '/businesses/gst-thresholds/warning-level', { warnPercent: 80 });
    } finally {
      delete process.env.NOTIFICATIONS_CACHE;
    }
  });
});
