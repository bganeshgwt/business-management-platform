const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { rewriteHistory } = require('./helpers/history');
const dates = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');
const { publishNotice } = require('./helpers/privacy');

// The salesperson app (wholesale), against its own throwaway database with
// every migration applied:
//   - this migration's Down half and Up again;
//   - the "Salesperson" role and its limits: writes tied to the login's own
//     salesperson, reads of their own beats and customers (search reaches
//     every customer), the office reading any salesperson's day;
//   - the application off, and the plan ended;
//   - the day started and ended, places kept only within it;
//   - visits: the check-in distance and its reasons, a shop's saved place, a
//     visit off the beat, the no-order reasons and a promised payment date;
//   - orders at the shop's prices, slabs, group prices, schemes and free
//     goods, priced by the phone's own module (apps/business-web) to the paisa
//     the server makes; a price difference flagged;
//   - a credit hold and the credit limit refused on arrival, let through or
//     raised by the office, and tried again with the same request key;
//   - collections by cash, cheque and UPI (its 12-digit UTR, used once), the
//     ₹2,00,000 cash block, oldest bills first, the evening settlement;
//   - new shops: duplicates by mobile and GSTIN, cash only until approved;
//   - every write's idempotency; the office's day report and its numbers;
//     the visit order of a beat, a shop's place cleared, the settings, the
//     bell; the erasure of a salesperson's places;
//   - a shop's consent given and withdrawn in the field, recorded as such, and
//     kept by the Down half as at the counter with a note saying how.
test('salesperson app', { timeout: 600000 }, async (t) => {
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
  process.env.DB_POOL_GUARD = 'throw';
  const { runner } = await import('node-pg-migrate');
  const dir = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test("the migration's Down half takes the app away, and Up brings it back", async () => {
    const probe = new Client({ ...connection, database });
    await probe.connect();
    try {
      const tables = ['wholesale_salesperson_days', 'wholesale_visits', 'wholesale_field_orders', 'wholesale_field_collections', 'wholesale_field_refusals'];
      const shape = async () => (await probe.query(`SELECT
          (SELECT count(*)::int FROM pg_tables WHERE tablename = ANY($1)) AS tables,
          (SELECT count(*)::int FROM platform_modules WHERE code='salesperson_app') AS module,
          (SELECT count(*)::int FROM business_role_templates WHERE code='salesperson') AS role,
          (SELECT count(*)::int FROM information_schema.columns WHERE table_name='wholesale_customer_beats' AND column_name='visit_order') AS visit_order,
          (SELECT count(*)::int FROM information_schema.columns WHERE table_name='wholesale_customer_profiles' AND column_name IN ('latitude','approval')) AS profile,
          (SELECT count(*)::int FROM information_schema.columns WHERE table_name='wholesale_settings' AND column_name IN ('checkin_distance_m','record_places')) AS settings,
          (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('wholesale_visits_live','wholesale_salesperson_days_live','wholesale_field_refusals_live')) AS live`,
      [tables])).rows[0];
      assert.deepEqual(await shape(), { tables: 5, module: 1, role: 1, visit_order: 1, profile: 2, settings: 2, live: 3 });
      const file = fs.readdirSync(dir).find((name) => /^\d+_salesperson-app\.sql$/.test(name));
      await migrate({ direction: 'down', count: Number(file.split('_')[0]), timestamp: true });
      assert.deepEqual(await shape(), { tables: 0, module: 0, role: 0, visit_order: 0, profile: 0, settings: 0, live: 0 });
      await migrate({ direction: 'up', count: Infinity });
      assert.deepEqual(await shape(), { tables: 5, module: 1, role: 1, visit_order: 1, profile: 2, settings: 2, live: 3 });
    } finally { await probe.end(); }
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Field-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const ownerUser = await (async () => {
    const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', ['field-owner']);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,restaurant_id',
      [restaurant.id, 'Field owner', 'field-owner@test.invalid', hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
    return person;
  })();
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  // A caller: the answer's data on the expected status, or the whole refusal.
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return expected >= 400 ? result.body : result.body.data;
  };
  const owner = as(await login('field-owner@test.invalid'));
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = dates.daysFrom(0);
  const weekday = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const otherDay = (weekday % 7) + 1;
  // A moment `secondsAgo`, so a day's events keep their order however late in the day the test runs.
  const now = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  // A place about `metres` north of another (a degree of latitude is about 111.2 km).
  const north = (place, metres) => ({ latitude: Number((place.latitude + metres / 111195).toFixed(6)), longitude: place.longitude, accuracy: 12 });

  const [ws] = await createBusinesses(owner, 'FIELD', ['wholesale']);
  const W = (suffix) => `/businesses/${ws.id}/${suffix}`;
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none' WHERE business_id=$1", [ws.id]);
  const location = (await owner('GET', W('locations'))).items[0];
  const modules = await owner('GET', W('modules'));
  assert.equal(modules.find((m) => m.code === 'salesperson_app')?.enabled, false, 'the app starts off');
  for (const code of ['wholesale', 'salesperson_app']) {
    if (!modules.find((m) => m.code === code)?.enabled) await owner('PUT', W(`modules/${code}`), { enabled: true });
  }

  // --- The people ------------------------------------------------------------------------------
  const roles = (await owner('GET', W('roles'))).items;
  const roleOf = (template) => roles.find((r) => r.template_code === template);
  const person = async (name, email, template) => {
    const row = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, name, email, hash]);
    await owner('POST', W('members'), { userId: row.id, roleId: roleOf(template).id }, 201);
    return { id: row.id, call: as(await login(email)) };
  };
  const ravi = await person('Ravi Kumar', 'ravi@field.invalid', 'salesperson');
  const suresh = await person('Suresh Patil', 'suresh@field.invalid', 'salesperson');
  const unlinked = await person('Imran Shaikh', 'imran@field.invalid', 'salesperson');
  const manager = await person('Kavya Reddy', 'kavya@field.invalid', 'manager');
  const accountant = await person('Anil Joshi', 'anil@field.invalid', 'accountant');
  const cashier = await person('Deepa Nair', 'deepa@field.invalid', 'cashier');
  const R = ravi.call, S = suresh.call;

  // --- The catalogue, prices and schemes ---------------------------------------------------------
  const supplier = await owner('POST', W('contacts'), { kind: 'supplier', name: 'Deccan Foods Depot', creditDays: 30 }, 201);
  const biscuits = await owner('POST', W('catalog'), { name: 'Glucose biscuits 100 g', code: 'BIS', kind: 'goods', unit: 'each', tracking: 'quantity', price: '10', taxRate: '18' }, 201);
  const noodles = await owner('POST', W('catalog'), { name: 'Instant noodles 70 g', code: 'NDL', kind: 'goods', unit: 'each', tracking: 'quantity', price: '12', taxRate: '5' }, 201);
  const soap = await owner('POST', W('catalog'), { name: 'Bath soap 75 g', code: 'SOAP', kind: 'goods', unit: 'each', tracking: 'quantity', price: '30', taxRate: '18' }, 201);
  await owner('POST', W('pack-sizes'), { skuId: biscuits.id, unitCode: 'case', quantityInBase: '48' }, 201);
  await owner('POST', W('pack-sizes'), { skuId: noodles.id, unitCode: 'case', quantityInBase: '96' }, 201);
  await owner('POST', W('documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [
    { skuId: biscuits.id, quantity: '4800', unitPrice: '7' }, { skuId: noodles.id, quantity: '4800', unitPrice: '9' }, { skuId: soap.id, quantity: '1000', unitPrice: '22' }] }, 201);
  const group = await owner('POST', W('price-groups'), { name: 'HoReCa' }, 201);
  await owner('POST', W('group-prices'), { groupId: group.id, skuId: soap.id, unitPrice: '27.50' }, 201);
  // Biscuits: 5 cases or more at ₹460 a case, for every customer.
  await owner('POST', W('pricing'), { skuId: biscuits.id, unitCode: 'case', minimumQuantity: '5', unitPrice: '460' }, 201);
  // Noodles: 10 cases get 1 free; biscuits: 5 cases get 6 soaps free (not with the slab); soap: 12 or more, 5% off.
  const noodleScheme = await owner('POST', W('schemes'), { name: '10+1 noodles', skuId: noodles.id, unitCode: 'case', buyQuantity: '10', freeQuantity: '1' }, 201);
  const soapScheme = await owner('POST', W('schemes'), { name: 'Biscuits with soap', skuId: biscuits.id, unitCode: 'case', buyQuantity: '5', freeQuantity: '6', freeSkuId: soap.id, noSlab: true }, 201);
  await owner('POST', W('schemes'), { name: 'Soap 5% on a dozen', skuId: soap.id, buyQuantity: '12', discountPercent: '5' }, 201);

  // --- Beats, salespeople and shops -----------------------------------------------------------
  const raviSp = await owner('POST', W('salespeople'), { name: 'Ravi Kumar', phone: '98450 12345', userId: ravi.id, monthlyTarget: '500000' }, 201);
  const sureshSp = await owner('POST', W('salespeople'), { name: 'Suresh Patil', userId: suresh.id }, 201);
  await owner('POST', W('salespeople'), { name: 'Office counter' }, 201);
  const route = await owner('POST', W('routes'), { name: 'Hadapsar route', locationId: location.id }, 201);
  const todayBeat = await owner('POST', W('beats'), { routeId: route.id, name: 'Hadapsar market', visitDay: weekday, salespersonId: raviSp.id }, 201);
  const laterBeat = await owner('POST', W('beats'), { routeId: route.id, name: 'Kondhwa', visitDay: otherDay, salespersonId: raviSp.id }, 201);
  const sureshBeat = await owner('POST', W('beats'), { routeId: route.id, name: 'Magarpatta', visitDay: weekday, salespersonId: sureshSp.id }, 201);
  const shop = async (name, extra, beat) => {
    const contact = await owner('POST', W('contacts'), { kind: 'customer', name, creditDays: 15, ...extra }, 201);
    if (beat) await owner('PUT', W(`customer-beats/${contact.id}`), { beatId: beat.id });
    return contact;
  };
  const omSai = await shop('Om Sai Kirana', { phone: '98220 11111', gstin: '27AAPFU0939F1ZV', creditLimit: '50000' }, todayBeat);
  const balaji = await shop('Shree Balaji Traders', { phone: '98220 22222', creditLimit: '100000' }, todayBeat);
  const annapurna = await shop('Hotel Annapurna', { phone: '98220 33333', creditLimit: '1000' }, todayBeat);
  const bazaar = await shop('Navratna Super Bazaar', { phone: '98220 44444' }, todayBeat);
  const kondhwa = await shop('Kondhwa Provision Store', { phone: '98220 55555' }, laterBeat);
  const magarpatta = await shop('Magarpatta Mini Mart', { phone: '98220 66666' }, sureshBeat);
  await owner('PUT', W(`wholesale-customers/${annapurna.id}`), { priceGroupId: group.id, tradeType: 'trade' });
  // Om Sai's own price for noodles.
  await owner('POST', W('pricing'), { skuId: noodles.id, contactId: omSai.id, minimumQuantity: '1', unitPrice: '11' }, 201);
  // Two bills of Om Sai's on credit (the older first), and one of Balaji's 60 days old, past the 30-day hold.
  const bill = async (contact, quantity) => owner('POST', W('documents'), { kind: 'sale', locationId: location.id, contactId: contact.id, requestKey: key(),
    lines: [{ skuId: biscuits.id, quantity: String(quantity) }] }, 201);
  const omOld = await bill(omSai, 100);
  const omNew = await bill(omSai, 50);
  await rewriteHistory(pool, 'UPDATE business_documents SET created_at=$2,due_on=$3 WHERE id=$1', [omOld.id, dates.momentAt(dates.daysFrom(-20), '10:00'), dates.daysFrom(-5)]);
  const balajiBill = await bill(balaji, 200);
  await rewriteHistory(pool, 'UPDATE business_documents SET created_at=$2,due_on=$3 WHERE id=$1', [balajiBill.id, dates.momentAt(dates.daysFrom(-60), '10:00'), dates.daysFrom(-45)]);
  await owner('PUT', W('wholesale-settings'), { holdOverdueDays: 30 });
  const shopPlace = { latitude: 18.508934, longitude: 73.926041, accuracy: 9 };

  await t.test('the Salesperson role: its permissions, its own salesperson, its own beats', async () => {
    const template = await rows("SELECT permission_code FROM business_role_template_permissions WHERE template_code='salesperson' ORDER BY 1");
    assert.deepEqual(template.map((r) => r.permission_code), ['contacts.view', 'receivables.create', 'sales_orders.create', 'sales_orders.view', 'salesperson_app.create']);
    assert.equal(roleOf('salesperson').name, 'Salesperson');
    assert.ok(roleOf('manager'), 'the shared roles are there');
    const me = await R('GET', W('sales/me'));
    assert.equal(me.salesperson.id, raviSp.id);
    assert.deepEqual([me.can_work, me.can_watch, me.today, me.weekday], [true, false, today, weekday]);
    assert.deepEqual(me.settings, { checkin_distance_m: 100, record_places: true, hold_overdue_days: 30, bounce_hold_count: 2, bounce_hold_days: 90 });
    // A login with the role but no salesperson of its own: told how to get linked.
    const notLinked = await unlinked.call('GET', W('sales/pack'), undefined, 403);
    assert.equal(notLinked.data.reason, 'not_a_salesperson');
    assert.match(notLinked.message, /Sales orders › Routes & salespeople/);
    // The pack: Ravi's beats and their shops only, in visit order, never Suresh's.
    const pack = await R('GET', W('sales/pack'));
    assert.deepEqual(pack.beats.map((b) => b.name).sort(), ['Hadapsar market', 'Kondhwa']);
    assert.deepEqual(pack.shops.map((s) => s.name).sort(), ['Hotel Annapurna', 'Kondhwa Provision Store', 'Navratna Super Bazaar', 'Om Sai Kirana', 'Shree Balaji Traders']);
    assert.ok(!pack.shops.some((s) => s.id === magarpatta.id));
    assert.deepEqual([pack.own, pack.default_depot_id, pack.settings.rules_on, pack.settings.tax_mode], [true, location.id, true, 'exclusive']);
    assert.ok(pack.items.some((i) => i.id === noodles.id && i.pack_sizes.some((p) => p.unit_code === 'case' && Number(p.quantity_in_base) === 96)));
    assert.equal(Number(pack.items.find((i) => i.id === noodles.id).stock[location.id]), 4800);
    const om = pack.shops.find((s) => s.id === omSai.id);
    assert.equal(Number(om.balance), 1770);
    assert.deepEqual(om.open_bills.map((b) => b.document_id), [omOld.id, omNew.id], 'oldest due first');
    assert.equal(om.hold.held, false);
    const bal = pack.shops.find((s) => s.id === balaji.id);
    assert.deepEqual([bal.hold.held, bal.hold.reason, bal.hold.days], [true, 'overdue', 45]);
    assert.ok(pack.price_rules.some((r) => r.contact_id === omSai.id) && pack.price_rules.some((r) => r.contact_id === null));
    assert.equal(pack.schemes.length, 3);
    assert.deepEqual(pack.no_order_reasons.map((r) => r.code), ['shop_closed', 'owner_away', 'enough_stock', 'dues_or_hold', 'price_or_scheme', 'other_brand', 'order_later', 'other']);
    // Another salesperson's day, from Ravi's login: refused. The office reads any.
    await R('GET', W(`sales/pack?salesperson=${sureshSp.id}`), undefined, 403);
    await R('GET', W(`sales/day?salesperson=${sureshSp.id}`), undefined, 403);
    const watched = await manager.call('GET', W(`sales/pack?salesperson=${raviSp.id}`));
    assert.equal(watched.own, false);
    const office = await manager.call('GET', W('sales/me'));
    assert.deepEqual([office.salesperson, office.can_work, office.can_watch], [null, false, true]);
    assert.deepEqual(office.salespeople.map((s) => s.name), ['Office counter', 'Ravi Kumar', 'Suresh Patil']);
    await accountant.call('GET', W(`sales/day?salesperson=${raviSp.id}`));
    await cashier.call('GET', W('sales/me'), undefined, 403);
    // Search reaches every customer (a visit off the beat), with the beat each is on.
    const found = await R('GET', W('sales/customers?q=magar'));
    assert.deepEqual(found.map((c) => [c.name, c.beat_name, c.salesperson_name]), [['Magarpatta Mini Mart', 'Magarpatta', 'Suresh Patil']]);
    assert.equal((await R('GET', W('sales/customers?q=98220 66666'))).length, 1, 'by mobile');
    const card = await R('GET', W(`sales/customers/${magarpatta.id}`));
    assert.equal(card.shop.name, 'Magarpatta Mini Mart');
    // The salesperson's writes are their own: no salesperson to name, and a login with none refused.
    await unlinked.call('POST', W('sales/days/start'), { requestKey: key(), startedAt: now() }, 403);
  });

  await t.test('the application switched off, and the plan ended, refuse the app', async () => {
    await owner('PUT', W('modules/salesperson_app'), { enabled: false });
    const off = await R('GET', W('sales/pack'), undefined, 403);
    assert.match(off.message, /Salesperson app is not switched on/);
    await R('POST', W('sales/days/start'), { requestKey: key(), startedAt: now() }, 403);
    await owner('PUT', W('modules/salesperson_app'), { enabled: true });
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [ws.id]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything) VALUES($1,'trial',business_local_today($1)-30,business_local_today($1)-17,TRUE)`, [ws.id]);
    const ended = await R('POST', W('sales/days/start'), { requestKey: key(), startedAt: now() }, 402);
    assert.equal(ended.data.reason, 'plan_ended');
    // Reading stays: the phone keeps its copy fresh.
    await R('GET', W('sales/pack'));
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [ws.id]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything) VALUES($1,'trial',business_local_today($1)-1,business_local_today($1)+13,TRUE)`, [ws.id]);
    await R('GET', W('sales/pack'));
  });

  let raviDay;
  await t.test('the day: started once, ended once, with places only while records are kept', async () => {
    // Before the day starts, a check-in keeps no place.
    const early = await R('POST', W('sales/visits'), { requestKey: key(), contactId: omSai.id, checkedInAt: now(240), place: shopPlace }, 201);
    assert.deepEqual([early.latitude, early.distance_m, early.place_saved], [null, null, false]);
    await R('POST', W(`sales/visits/${early.request_key}/check-out`), { requestKey: key(), checkedOutAt: now(239), outcome: 'no_order', noOrderReason: 'shop_closed' });
    const start = { requestKey: key(), startedAt: now(180), place: { latitude: 18.5, longitude: 73.9, accuracy: 20 } };
    raviDay = await R('POST', W('sales/days/start'), start, 201);
    assert.deepEqual([raviDay.day, Number(raviDay.start_latitude), raviDay.start_accuracy_m], [today, 18.5, 20]);
    // The same request again: the same day. Another start the same day: the day already started.
    assert.equal((await R('POST', W('sales/days/start'), start, 201)).id, raviDay.id);
    await R('POST', W('sales/days/start'), { ...start, startedAt: now(170) }, 409);
    const again = await R('POST', W('sales/days/start'), { requestKey: key(), startedAt: now(170) }, 201);
    assert.deepEqual([again.id, again.already_started], [raviDay.id, true]);
    // A time ahead of the server's clock is refused.
    await R('POST', W('sales/days/start'), { requestKey: key(), startedAt: new Date(Date.now() + 3600000).toISOString() }, 400);
    // Ending a day never started: refused.
    const notStarted = await S('POST', W('sales/days/end'), { requestKey: key(), endedAt: now() }, 409);
    assert.equal(notStarted.data.reason, 'day_not_started');
    assert.equal((await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action='salesperson.day_started'", [ws.id])).n, 1);
  });

  let firstVisit;
  await t.test('visits: the shop\'s place saved once, the distance and its reasons, off the beat, the no-order reasons', async () => {
    const firstBody = { requestKey: key(), contactId: omSai.id, checkedInAt: now(150), place: shopPlace, savePlace: true };
    firstVisit = await R('POST', W('sales/visits'), firstBody, 201);
    assert.deepEqual([firstVisit.place_saved, firstVisit.distance_m, firstVisit.far, firstVisit.off_beat, firstVisit.beat_id], [true, null, false, false, todayBeat.id]);
    assert.match(firstVisit.maps, /^https:\/\/www\.google\.com\/maps\?q=18\.508934,73\.926041$/);
    const saved = await one('SELECT latitude,longitude,place_saved_by FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [ws.id, omSai.id]);
    assert.deepEqual([Number(saved.latitude), Number(saved.longitude), saved.place_saved_by], [18.508934, 73.926041, ravi.id]);
    // The same visit sent again: the same visit. The same key with something else: refused.
    assert.equal((await R('POST', W('sales/visits'), firstBody, 201)).id, firstVisit.id);
    await R('POST', W('sales/visits'), { ...firstBody, savePlace: false }, 409);
    // 40 m away: at the shop. 300 m away: far, with the reason given; and without one (the shop's place changed since the phone's copy): flagged.
    const near = await R('POST', W('sales/visits'), { requestKey: key(), contactId: omSai.id, checkedInAt: now(140), place: north(shopPlace, 40), savePlace: true }, 201);
    assert.deepEqual([near.distance_m, near.far, near.place_saved], [40, false, false]);
    const far = await R('POST', W('sales/visits'), { requestKey: key(), contactId: balaji.id, checkedInAt: now(130), place: north(shopPlace, 300) }, 201);
    assert.deepEqual([far.distance_m, far.far], [null, false], 'Balaji has no saved place yet');
    const farOm = await R('POST', W('sales/visits'), { requestKey: key(), contactId: omSai.id, checkedInAt: now(125), place: north(shopPlace, 300), farReason: 'GPS is weak here' }, 201);
    assert.deepEqual([farOm.distance_m, farOm.far, farOm.far_reason], [300, true, 'GPS is weak here']);
    const unexplained = await R('POST', W('sales/visits'), { requestKey: key(), contactId: omSai.id, checkedInAt: now(124), place: north(shopPlace, 260) }, 201);
    assert.deepEqual([unexplained.far, unexplained.far_reason], [true, null]);
    // A shop on another day's beat, and one on another salesperson's: off the beat, with the reason.
    const offBeat = await R('POST', W('sales/visits'), { requestKey: key(), contactId: kondhwa.id, checkedInAt: now(120), offBeatReason: 'Owner called for stock' }, 201);
    assert.deepEqual([offBeat.off_beat, offBeat.off_beat_reason, offBeat.beat_id], [true, 'Owner called for stock', laterBeat.id]);
    const theirs = await R('POST', W('sales/visits'), { requestKey: key(), contactId: magarpatta.id, checkedInAt: now(118), offBeatReason: 'Passing by' }, 201);
    assert.equal(theirs.off_beat, true);
    // Checking out: why no order, from the fixed list; "Other" needs a note; a promised payment goes in the dues book.
    const out = (visit, body, expected = 200) => R('POST', W(`sales/visits/${visit.request_key}/check-out`), { requestKey: key(), checkedOutAt: now(110), ...body }, expected);
    await out(near, { outcome: 'no_order', noOrderReason: 'out_of_mood' }, 400);
    await out(near, { outcome: 'no_order', noOrderReason: 'other' }, 400);
    await out(near, { outcome: 'no_order', noOrderReason: 'enough_stock', promisedAmount: '500' }, 400);
    const promised = dates.daysFrom(3);
    const checkout = { requestKey: key(), checkedOutAt: now(110), outcome: 'no_order', noOrderReason: 'dues_or_hold', note: 'Will clear the old bill', promisedOn: promised, promisedAmount: '1180' };
    const closed = await R('POST', W(`sales/visits/${far.request_key}/check-out`), checkout);
    assert.deepEqual([closed.outcome, closed.no_order_reason, closed.promised_on], ['no_order', 'dues_or_hold', promised]);
    assert.equal((await R('POST', W(`sales/visits/${far.request_key}/check-out`), checkout)).id, closed.id, 'the same check-out again');
    const twice = await R('POST', W(`sales/visits/${far.request_key}/check-out`), { ...checkout, requestKey: key() }, 409);
    assert.equal(twice.data.reason, 'checked_out');
    const reminder = await one("SELECT channel,promised_on::text AS promised_on,note FROM retail_credit_reminders WHERE business_id=$1 AND contact_id=$2 ORDER BY id DESC LIMIT 1", [ws.id, balaji.id]);
    assert.deepEqual([reminder.channel, reminder.promised_on], ['visit', promised]);
    assert.match(reminder.note, /^Promised 1180\.00 · On Ravi Kumar's visit · Will clear the old bill$/);
    await out(near, { outcome: 'no_order', noOrderReason: 'other', note: 'Owner at a wedding' });
    await out(offBeat, { outcome: 'no_order', noOrderReason: 'price_or_scheme' });
    await out(theirs, { outcome: 'no_order', noOrderReason: 'other_brand' });
    await out(farOm, { outcome: 'no_order', noOrderReason: 'order_later' });
    await out(unexplained, { outcome: 'no_order', noOrderReason: 'owner_away' });
    // A visit that has not reached the server.
    await R('POST', W(`sales/visits/${key()}/check-out`), { requestKey: key(), outcome: 'order' }, 404);
    // Suresh's own visit is his, and not Ravi's to check out.
    const sureshVisit = await S('POST', W('sales/visits'), { requestKey: key(), contactId: magarpatta.id, checkedInAt: now(100) }, 201);
    await R('POST', W(`sales/visits/${sureshVisit.request_key}/check-out`), { requestKey: key(), outcome: 'order' }, 404);
  });

  // The phone's own prices (apps/business-web/src/workspaces/sales/salesPricing.js), from the pack.
  const pricing = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/business-web/src/workspaces/sales/salesPricing.js')).href);
  const phoneTotal = async (contact, lines) => {
    const pack = await R('GET', W('sales/pack'));
    const shopRow = pack.shops.find((s) => s.id === contact.id);
    const index = pricing.pricingIndex(pack);
    const priced = pricing.priceOrder(index, { contactId: contact.id, groupId: shopRow?.price_group_id || null, day: pack.today }, lines);
    assert.deepEqual(priced.problems, []);
    return { total: pricing.rupeesText(priced.total), priced };
  };
  const order = async (contact, lines, extra = {}, expected = 201) => {
    const phone = await phoneTotal(contact, lines);
    const body = { requestKey: key(), contactId: contact.id, locationId: location.id, lines, phoneTotal: phone.total, takenAt: now(60), ...extra };
    return { body, phone, answer: await R('POST', W('sales/orders'), body, expected) };
  };

  let omVisit, omOrder;
  await t.test('orders: the shop\'s prices, slabs, group prices, schemes and free goods, as the phone priced them; a difference flagged', async () => {
    omVisit = await R('POST', W('sales/visits'), { requestKey: key(), contactId: omSai.id, checkedInAt: now(90), place: north(shopPlace, 15) }, 201);
    // Om Sai: noodles at its own ₹11 (10 cases: 1 case free), biscuits 6 cases at the slab's ₹460 a case would give way to the soap scheme's list price.
    const lines = [{ skuId: noodles.id, quantity: '10', unit: 'case' }, { skuId: biscuits.id, quantity: '6', unit: 'case' }, { skuId: soap.id, quantity: '24' }];
    const placed = await order(omSai, lines, { visitKey: omVisit.request_key });
    omOrder = placed.answer;
    // 960 × ₹11 + 5% GST; 288 × ₹10 (no slab: the scheme does not combine) + 18%; 24 × ₹30 less 5% + 18%.
    const expected = 960 * 11 * 1.05 + 288 * 10 * 1.18 + 24 * 30 * 0.95 * 1.18;
    assert.equal(paise(omOrder.total), Math.round(expected * 100));
    assert.deepEqual([omOrder.total, omOrder.phone_total, omOrder.price_difference], [placed.phone.total, placed.phone.total, '0.00']);
    assert.equal(omOrder.salesperson_id, raviSp.id);
    assert.equal(omOrder.beat_id, todayBeat.id);
    const detail = await owner('GET', W(`sales-orders/${omOrder.id}`));
    const free = detail.lines.filter((l) => l.free_of_line_id);
    assert.deepEqual(free.map((l) => [l.label, Number(l.quantity), l.entered_unit]).sort(), [['Bath soap 75 g (free)', 6, null], ['Instant noodles 70 g (free)', 96, 'case']]);
    const phoneFree = placed.phone.priced.lines.map((l) => (l.free ? Number(l.free.quantityMilli) / 1000 : l.otherFree ? l.otherFree.quantityMilli / 1000 : 0));
    assert.deepEqual(phoneFree, [96, 6, 0], 'the phone shows the same free goods');
    const field = await one('SELECT * FROM wholesale_field_orders WHERE business_id=$1 AND order_id=$2', [ws.id, omOrder.id]);
    assert.deepEqual([field.visit_key, field.salesperson_id, field.offline], [omVisit.request_key, raviSp.id, false]);
    // The same order again: the same order; the same key with other lines: refused.
    assert.equal((await R('POST', W('sales/orders'), placed.body, 201)).id, omOrder.id);
    await R('POST', W('sales/orders'), { ...placed.body, lines: lines.slice(0, 1) }, 409);
    assert.equal((await one('SELECT count(*)::int AS n FROM wholesale_orders WHERE business_id=$1 AND contact_id=$2', [ws.id, omSai.id])).n, 1);
    // A group price (Annapurna is HoReCa: soap at ₹27.50, 5% off a dozen), priced the same on the phone.
    const hotel = await phoneTotal(annapurna, [{ skuId: soap.id, quantity: '12' }]);
    assert.equal(hotel.total, (Math.round(12 * 2750 * 0.95) * 1.18 / 100).toFixed(2));
    // The slab, with no scheme in the way: 7 cases of biscuits for Kondhwa? Off the beat it is priced the same; Bazaar takes 5 cases at ₹460.
    const slab = await phoneTotal(bazaar, [{ skuId: biscuits.id, quantity: '4', unit: 'case' }]);
    assert.equal(slab.total, (4 * 48 * 10 * 1.18).toFixed(2), 'below the scheme and the slab');
    // A difference from the phone's copy: saved at the server's prices, and said.
    const stale = await order(bazaar, [{ skuId: biscuits.id, quantity: '2', unit: 'case' }], { phoneTotal: '1000.00' });
    assert.deepEqual([stale.answer.total, stale.answer.phone_total, stale.answer.price_difference], ['1132.80', '1000.00', '132.80']);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action='sales_order.priced_again' AND entity_id=$2", [ws.id, stale.answer.id])).n, 1);
    // Discounts and free goods by hand stay with the office.
    const handGiven = await R('POST', W('sales/orders'), { requestKey: key(), contactId: bazaar.id, locationId: location.id, lines: [{ skuId: soap.id, quantity: '2', discountPercent: '10' }],
      phoneTotal: '60', takenAt: now() }, 400);
    assert.match(handGiven.message, /office/);
  });

  await t.test('a credit hold and the credit limit: refused on arrival, let through or raised by the office, tried again with the same key', async () => {
    // Balaji is on hold (a bill 45 days past due, past the 30-day rule).
    const held = await order(balaji, [{ skuId: noodles.id, quantity: '2', unit: 'case' }], {}, 409);
    assert.equal(held.answer.data.reason, 'credit_hold');
    const again = await R('POST', W('sales/orders'), held.body, 409);
    assert.equal(again.data.tries, 2);
    const refusal = await one('SELECT * FROM wholesale_field_refusals WHERE business_id=$1 AND request_key=$2', [ws.id, held.body.requestKey]);
    assert.deepEqual([refusal.reason, refusal.tries, refusal.salesperson_id, refusal.order_id], ['credit_hold', 2, raviSp.id, null]);
    // Who may let it through: credit control (the manager), not a cashier, nor the salesperson.
    await cashier.call('POST', W(`sales/refusals/${refusal.id}/release`), { reason: 'x' }, 403);
    await R('POST', W(`sales/refusals/${refusal.id}/release`), { reason: 'x' }, 403);
    await manager.call('POST', W(`sales/refusals/${refusal.id}/release`), {}, 400);
    const released = await manager.call('POST', W(`sales/refusals/${refusal.id}/release`), { reason: 'Owner paid by NEFT this morning' });
    assert.equal(released.released_by_name, 'Kavya Reddy');
    await manager.call('POST', W(`sales/refusals/${refusal.id}/release`), { reason: 'again' }, 409);
    // Try again: the same request key goes, and the release is kept with the order.
    const through = await R('POST', W('sales/orders'), held.body, 201);
    const kept = await one('SELECT released_by,requested_by,reason FROM wholesale_hold_releases WHERE business_id=$1 AND order_id=$2', [ws.id, through.id]);
    assert.deepEqual([kept.released_by, kept.requested_by, kept.reason], [manager.id, ravi.id, 'Owner paid by NEFT this morning']);
    assert.equal((await one('SELECT order_id FROM wholesale_field_refusals WHERE id=$1', [refusal.id])).order_id, through.id);
    // Annapurna's limit is ₹1,000: refused; the release is not the way; the office raises the limit, and the same key goes.
    const over = await order(annapurna, [{ skuId: soap.id, quantity: '48' }], {}, 409);
    assert.equal(over.answer.data.reason, 'credit_limit');
    const overRow = await one('SELECT id FROM wholesale_field_refusals WHERE business_id=$1 AND request_key=$2', [ws.id, over.body.requestKey]);
    const notThatWay = await manager.call('POST', W(`sales/refusals/${overRow.id}/release`), { reason: 'Known customer' }, 409);
    assert.match(notThatWay.message, /raise the limit/);
    await owner('PATCH', W(`contacts/${annapurna.id}`), { name: 'Hotel Annapurna', creditLimit: '5000', creditDays: 15 });
    const raised = await R('POST', W('sales/orders'), over.body, 201);
    assert.equal(raised.contact_id, annapurna.id);
  });

  await t.test('collections: cash to the oldest bills, a cheque with its date and bank, UPI with its UTR used once, the ₹2,00,000 cash block', async () => {
    const collect = (body, expected = 201) => R('POST', W('sales/collections'), { requestKey: key(), contactId: omSai.id, locationId: location.id, takenAt: now(80),
      visitKey: omVisit.request_key, ...body }, expected);
    const cash = await collect({ amount: '1500', method: 'cash' });
    assert.deepEqual([cash.allocated, cash.unallocated, cash.salesperson_name], ['1500.00', '0.00', 'Ravi Kumar']);
    const settled = await rows('SELECT document_id,amount FROM business_payments WHERE business_id=$1 AND collection_id=$2 ORDER BY id', [ws.id, cash.id]);
    assert.deepEqual(settled.map((p) => [p.document_id, p.amount]), [[omOld.id, '1180.00'], [omNew.id, '320.00']], 'the oldest bill first');
    const detail = await one('SELECT salesperson_id,route_id FROM wholesale_collection_details WHERE business_id=$1 AND collection_id=$2', [ws.id, cash.id]);
    assert.deepEqual([detail.salesperson_id, detail.route_id], [raviSp.id, route.id]);
    // The same receipt sent again: the same receipt.
    const body = { requestKey: key(), contactId: omSai.id, locationId: location.id, amount: '10', method: 'cash', takenAt: now(79) };
    const first = await R('POST', W('sales/collections'), body, 201);
    assert.equal((await R('POST', W('sales/collections'), body, 201)).id, first.id);
    await R('POST', W('sales/collections'), { ...body, amount: '11' }, 409);
    // UPI: the 12-digit UTR, once.
    const utr = await collect({ amount: '100', method: 'upi', reference: '41234567890' }, 400);
    assert.equal(utr.data.field, 'reference');
    const upi = await collect({ amount: '100', method: 'upi', reference: '4123 4567 8901' });
    assert.equal(upi.reference, '412345678901');
    const reused = await collect({ amount: '100', method: 'upi', reference: '412345678901', contactId: bazaar.id }, 409);
    assert.equal(reused.data.reason, 'duplicate_utr');
    // A cheque: six digits, its date (post-dated allowed) and the bank.
    await collect({ amount: '200', method: 'cheque', reference: '12345', chequeDate: dates.daysFrom(10), bank: 'HDFC Bank' }, 400);
    await collect({ amount: '200', method: 'cheque', reference: '123456', chequeDate: dates.daysFrom(10) }, 400);
    const cheque = await collect({ amount: '200', method: 'cheque', reference: '123456', chequeDate: dates.daysFrom(10), bank: 'HDFC Bank' });
    const onFile = await one('SELECT cheque_no,cheque_date::text AS cheque_date,bank,status FROM business_collection_cheques WHERE business_id=$1 AND collection_id=$2', [ws.id, cheque.id]);
    assert.deepEqual(onFile, { cheque_no: '123456', cheque_date: dates.daysFrom(10), bank: 'HDFC Bank', status: 'received' });
    const sameCheque = await collect({ amount: '200', method: 'cheque', reference: '123456', chequeDate: dates.daysFrom(10), bank: 'hdfc bank' }, 409);
    assert.equal(sameCheque.data.reason, 'duplicate_cheque');
    // Cash of ₹2,00,000 or more from one shop in a day: the second part refused, in the platform's words.
    await collect({ contactId: bazaar.id, amount: '196000', method: 'cash', visitKey: undefined });
    const blocked = await collect({ contactId: bazaar.id, amount: '5000', method: 'cash', visitKey: undefined }, 409);
    assert.match(blocked.message, /^Cash of ₹2,00,000 or more cannot be taken from one customer in a day \(Income-tax Act 2025, section 186\)/);
    await collect({ contactId: bazaar.id, amount: '5000', method: 'upi', reference: '998877665544', visitKey: undefined });
    // The evening settlement shows the field's receipts under the salesperson.
    const preview = await manager.call('GET', W(`settlements/preview?salesperson=${raviSp.id}&day=${today}`));
    assert.deepEqual([preview.totals.cash, preview.totals.upi, preview.totals.cheques], ['197510.00', '5100.00', '200.00']);
  });

  let newShop, newShopBody;
  await t.test('new shops: checked by mobile and GSTIN, cash only until the office approves them', async () => {
    const check = await R('GET', W('sales/shops/check?phone=+91 98220 11111'));
    assert.deepEqual(check.map((c) => c.name), ['Om Sai Kirana']);
    assert.deepEqual((await R('GET', W('sales/shops/check?gstin=27aapfu0939f1zv'))).map((c) => c.name), ['Om Sai Kirana']);
    const add = (body, expected = 201) => R('POST', W('sales/shops'), { requestKey: key(), address: 'Near Shiv temple, Hadapsar', takenAt: now(70), beatId: todayBeat.id, ...body }, expected);
    const byPhone = await add({ name: 'Om Sai Kirana Stores', phone: '9822011111' }, 409);
    assert.deepEqual([byPhone.data.reason, byPhone.data.match.id, byPhone.data.match.beat_name], ['duplicate_shop', omSai.id, 'Hadapsar market']);
    assert.match(byPhone.message, /mobile number/);
    const byGstin = await add({ name: 'Om Sai Wholesale', gstin: '27AAPFU0939F1ZV' }, 409);
    assert.match(byGstin.message, /GSTIN/);
    await add({ name: 'Ganesh Kirana', phone: '12345' }, 400);
    await add({ name: 'Ganesh Kirana', beatId: sureshBeat.id }, 404);
    newShopBody = { requestKey: key(), name: 'Ganesh Kirana', contactPerson: 'Ganesh Pawar', phone: '97300 12345', address: 'Lane 4, Hadapsar gaon',
      beatId: todayBeat.id, place: north(shopPlace, 900), takenAt: now(70) };
    newShop = await R('POST', W('sales/shops'), newShopBody, 201);
    assert.deepEqual([newShop.approval, newShop.beat_id, newShop.phone], ['pending', todayBeat.id, '9730012345']);
    assert.equal((await R('POST', W('sales/shops'), newShopBody, 201)).id, newShop.id, 'the same shop sent again');
    await R('POST', W('sales/shops'), { ...newShopBody, name: 'Ganesh General' }, 409);
    const contact = await one('SELECT credit_limit,credit_days FROM business_contacts WHERE id=$1', [newShop.id]);
    assert.deepEqual([contact.credit_limit, contact.credit_days], [null, 0]);
    const profile = await one('SELECT added_by_salesperson_id,approval,latitude FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [ws.id, newShop.id]);
    assert.deepEqual([profile.added_by_salesperson_id, profile.approval, Number(profile.latitude) > 18.51], [raviSp.id, 'pending', true]);
    // A visit and an order naming the new shop by its request key (made on the phone before it was sent).
    const visit = await R('POST', W('sales/visits'), { requestKey: key(), newShopKey: newShopBody.requestKey, checkedInAt: now(65), place: north(shopPlace, 905) }, 201);
    assert.deepEqual([visit.contact_id, visit.far, visit.off_beat], [newShop.id, false, false]);
    await R('POST', W('sales/visits'), { requestKey: key(), newShopKey: key(), checkedInAt: now(65) }, 404);
    // Cash only: the first order goes (cash on delivery); a second, while the first is not delivered, is refused.
    const firstOrder = await order({ id: newShop.id }, [{ skuId: soap.id, quantity: '6' }], { contactId: undefined, newShopKey: newShopBody.requestKey, visitKey: visit.request_key });
    assert.match(firstOrder.answer.notes, /^Cash on delivery: a new shop not yet approved\./);
    const second = await order({ id: newShop.id }, [{ skuId: soap.id, quantity: '12' }], {}, 409);
    assert.equal(second.answer.data.reason, 'cash_only');
    assert.match(second.answer.message, /buys for cash only/);
    const cashRow = await one('SELECT id,reason FROM wholesale_field_refusals WHERE business_id=$1 AND request_key=$2', [ws.id, second.body.requestKey]);
    assert.equal(cashRow.reason, 'cash_only');
    await manager.call('POST', W(`sales/refusals/${cashRow.id}/release`), { reason: 'x' }, 409);
    // The office approves the shop and sets its credit: the same key goes.
    const pending = await manager.call('GET', W('sales/new-shops'));
    assert.deepEqual(pending.map((s) => [s.name, s.salesperson_name, s.orders]), [['Ganesh Kirana', 'Ravi Kumar', 1]]);
    await R('POST', W(`sales/new-shops/${newShop.id}/approve`), { creditLimit: '20000' }, 403);
    await manager.call('POST', W(`sales/new-shops/${newShop.id}/approve`), { creditLimit: '0', creditDays: 15 }, 400);
    const approved = await manager.call('POST', W(`sales/new-shops/${newShop.id}/approve`), { creditLimit: '20000', creditDays: 15, priceGroupId: group.id });
    assert.deepEqual([approved.approval, approved.credit_limit, approved.credit_days], ['approved', '20000.00', 15]);
    await manager.call('POST', W(`sales/new-shops/${newShop.id}/approve`), { creditLimit: '20000' }, 409);
    await manager.call('POST', W(`sales/new-shops/${omSai.id}/approve`), { creditLimit: '20000' }, 404);
    const through = await R('POST', W('sales/orders'), second.body, 201);
    assert.equal(through.contact_id, newShop.id);
    assert.deepEqual(await manager.call('GET', W('sales/new-shops')), []);
  });

  await t.test("the office's day report: attendance, adherence, calls, strike rate, lines per call, money by mode", async () => {
    // Ravi ends his day; Suresh never started.
    const end = await R('POST', W('sales/days/end'), { requestKey: key(), endedAt: now(5), place: { latitude: 18.51, longitude: 73.93, accuracy: 30 }, cashInHand: '197510' });
    assert.deepEqual([end.id, end.cash_in_hand], [raviDay.id, '197510.00']);
    const ended = await R('POST', W('sales/days/end'), { requestKey: key(), endedAt: now(4) });
    assert.equal(ended.already_ended, true);
    // After the end, a check-in keeps no place.
    const late = await R('POST', W('sales/visits'), { requestKey: key(), contactId: kondhwa.id, checkedInAt: now(2), place: shopPlace, offBeatReason: 'On the way home' }, 201);
    assert.equal(late.latitude, null);
    const report = await manager.call('GET', W(`sales/report?date=${today}`));
    const r = report.salespeople.find((s) => s.id === raviSp.id);
    // Planned: Ravi's shops on today's beat (Om Sai, Balaji, Annapurna, Bazaar, and Ganesh added today).
    assert.deepEqual([r.planned, r.visited_planned, r.adherence], [5, 3, 60]);
    // Calls: every check-in (Om Sai ×6, Balaji, Kondhwa ×2, Magarpatta, Ganesh); productive: the visits with an order.
    assert.deepEqual([r.calls, r.productive, r.strike_rate], [11, 2, 18]);
    assert.deepEqual([r.lines, r.lines_per_call], [4, 2]);
    assert.equal(r.orders, 6);
    assert.deepEqual(r.collections, { cash: '197510.00', cheque: '200.00', upi: '5100.00', other: '0.00', total: '202810.00', count: 6 });
    assert.equal(r.cash_unsettled.today, '197510.00');
    // Two priced again: one from a stale copy, one that took the price group the office gave the shop on approval.
    assert.deepEqual([r.new_shops, r.far, r.off_beat, r.price_differences], [1, 2, 3, 2]);
    assert.deepEqual(r.no_order_reasons, { shop_closed: 1, dues_or_hold: 1, other: 1, price_or_scheme: 1, other_brand: 1, order_later: 1, owner_away: 1 });
    assert.equal(r.day.started_at.slice(0, 16), raviDay.started_at.slice(0, 16));
    assert.ok(r.day.ended_at && r.day.start_place.startsWith('https://www.google.com/maps?q=18.500000,73.900000'));
    assert.equal(r.month.target, '500000.00');
    assert.ok(Number(r.month.ordered) > 0);
    const omVisitRow = r.visits.find((v) => v.id === omVisit.id);
    assert.deepEqual([omVisitRow.orders.map((o) => o.id), omVisitRow.collected, omVisitRow.distance_m], [[omOrder.id], '1800.00', 15]);
    assert.ok(omVisitRow.maps.startsWith('https://www.google.com/maps?q='));
    const s = report.salespeople.find((x) => x.id === sureshSp.id);
    assert.deepEqual([s.day, s.planned, s.calls], [null, 1, 1]);
    assert.equal(report.totals.started, 1);
    assert.deepEqual(report.refusals.map((x) => [x.reason, Boolean(x.order_id)]).sort(), [['cash_only', true], ['credit_hold', true], ['credit_limit', true]]);
    // One salesperson, and the accountant's view; a cashier sees none of it.
    assert.equal((await accountant.call('GET', W(`sales/report?date=${today}&salesperson=${sureshSp.id}`))).salespeople.length, 1);
    await cashier.call('GET', W('sales/report'), undefined, 403);
    await R('GET', W('sales/report'), undefined, 403);
    // Ravi's own day, as his phone reads it after sending.
    const day = await R('GET', W('sales/day'));
    assert.deepEqual([day.visits.length, day.orders.length, day.collections.length, day.refusals.length, day.shops.length], [11, 6, 6, 3, 1]);
    assert.ok(day.orders.every((o) => o.request_key && o.phone_total));
  });

  let medicalShop;
  await t.test("a beat's visit order, a shop's place cleared, the settings, the bell", async () => {
    const before = await manager.call('GET', W(`sales/beats/${todayBeat.id}/shops`));
    const sequence = [newShop.id, bazaar.id, annapurna.id, balaji.id, omSai.id];
    await R('PUT', W(`sales/beats/${todayBeat.id}/order`), { contactIds: sequence }, 403);
    await owner('PUT', W(`sales/beats/${todayBeat.id}/order`), { contactIds: sequence.slice(1) }, 409);
    const after = await owner('PUT', W(`sales/beats/${todayBeat.id}/order`), { contactIds: sequence });
    assert.deepEqual(after.shops.map((s) => s.id), sequence);
    assert.equal(before.shops.length, 5);
    const pack = await R('GET', W('sales/pack'));
    assert.deepEqual(pack.shops.filter((s) => s.beat_id === todayBeat.id).sort((a, b) => a.visit_order - b.visit_order).map((s) => s.id), sequence);
    // The printed beat sheet follows the visit order.
    const sheet = await owner('GET', W(`salespeople/${raviSp.id}/beat-sheet`));
    assert.deepEqual(sheet.shops.filter((x) => x.beat_name === 'Hadapsar market').map((x) => x.contact_id), sequence);
    // A shop's place: the office clears it, the salesperson may not.
    await R('POST', W(`sales/places/${omSai.id}/clear`), {}, 403);
    await manager.call('POST', W(`sales/places/${omSai.id}/clear`), {});
    await manager.call('POST', W(`sales/places/${omSai.id}/clear`), {}, 409);
    assert.equal((await one('SELECT latitude FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [ws.id, omSai.id])).latitude, null);
    // Settings: the check-in distance and whether places are recorded.
    await R('PUT', W('sales/settings'), { checkinDistance: 50 }, 403);
    await manager.call('PUT', W('sales/settings'), { checkinDistance: 10 }, 400);
    assert.deepEqual(await manager.call('PUT', W('sales/settings'), { checkinDistance: 150, recordPlaces: false }), { checkin_distance_m: 150, record_places: false });
    const noPlace = await S('POST', W('sales/days/start'), { requestKey: key(), startedAt: now(1), place: shopPlace }, 201);
    assert.equal(noPlace.start_latitude, null, 'places are not recorded');
    await manager.call('PUT', W('sales/settings'), { recordPlaces: true });
    // The bell: a refused order still waiting, and a shop waiting for approval.
    const waiting = await order(balaji, [{ skuId: noodles.id, quantity: '1', unit: 'case' }], {}, 409);
    // With the privacy notice published, the shop's consent to receipts on WhatsApp is taken with it.
    await publishNotice(owner, `/businesses/${ws.id}`);
    const medical = await R('POST', W('sales/shops'), { requestKey: key(), name: 'Sai Medical & General', address: 'Market yard', takenAt: now(1), consents: { bills_digital: true } }, 201);
    medicalShop = medical;
    // Given in person to the salesperson at the shop, and recorded as just that, by his login.
    const consent = await one("SELECT channel,method,recorded_by FROM business_consents WHERE business_id=$1 AND contact_id=$2 AND purpose='bills_digital' AND withdrawn_at IS NULL", [ws.id, medical.id]);
    assert.deepEqual([consent.channel, consent.method, Number(consent.recorded_by)], ['field', 'verbal', Number(ravi.id)]);
    assert.ok(await one("SELECT 1 AS ok FROM business_audit WHERE business_id=$1 AND action='consent.given' AND entity_id=$2 AND details->>'channel'='field'", [ws.id, medical.id]));
    assert.equal((await R('GET', W('sales/pack'))).shops.find((x) => x.id === medical.id).bills_consent, true);
    const bell = await manager.call('GET', W('notifications'));
    const field = bell.items.filter((i) => i.category === 'Field sales');
    assert.deepEqual(field.map((i) => i.title).sort(), ['1 shop from the field waits for approval', "Shree Balaji Traders's order from Ravi Kumar was refused"]);
    assert.ok(field.every((i) => i.link === `/business-admin/${ws.id}/field-sales`));
    assert.ok(!(await R('GET', W('notifications'))).items.some((i) => i.category === 'Field sales'), 'not on the salesperson\'s bell');
    assert.ok(waiting.answer.data.refusalId);
  });

  await t.test("a salesperson's places erased, keeping their days and visits", async () => {
    await R('POST', W(`sales/salespeople/${raviSp.id}/erase-places`), { reason: 'x' }, 403);
    await owner('POST', W(`sales/salespeople/${raviSp.id}/erase-places`), {}, 400);
    const erased = await owner('POST', W(`sales/salespeople/${raviSp.id}/erase-places`), { reason: 'Left the business; asked for his data to be erased' });
    assert.ok(erased.erased.wholesale_visits > 0 && erased.erased.wholesale_salesperson_days === 1);
    const left = await one(`SELECT (SELECT count(*)::int FROM wholesale_visits WHERE business_id=$1 AND salesperson_id=$2 AND latitude IS NOT NULL) AS visits,
      (SELECT count(*)::int FROM wholesale_visits WHERE business_id=$1 AND salesperson_id=$2) AS kept,
      (SELECT count(*)::int FROM wholesale_visits WHERE business_id=$1 AND salesperson_id=$2 AND distance_m IS NOT NULL) AS distances,
      (SELECT count(*)::int FROM wholesale_salesperson_days WHERE business_id=$1 AND salesperson_id=$2 AND (start_latitude IS NOT NULL OR end_latitude IS NOT NULL)) AS days`,
    [ws.id, raviSp.id]);
    assert.deepEqual(left, { visits: 0, kept: 11, distances: 5, days: 0 });
    assert.equal((await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action='salesperson.places_erased'", [ws.id])).n, 1);
    // Suresh's are his own, untouched.
    assert.equal((await one('SELECT count(*)::int AS n FROM wholesale_visits WHERE business_id=$1 AND salesperson_id=$2', [ws.id, sureshSp.id])).n, 1);
    // The registry names where a salesperson's places are, and those columns exist and can be blanked.
    const registry = require('../../src/modules/personal-data/services/personalDataRegistry');
    for (const [table, entry] of Object.entries(registry.STAFF_TABLES)) {
      for (const column of [entry.person, ...Object.keys(entry.erase)]) {
        const found = await one('SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, column]);
        assert.ok(found, `${table}.${column}`);
        if (column !== entry.person) assert.equal(found.is_nullable, 'YES', `${table}.${column} can be blanked`);
      }
    }
    // A customer's erasure blanks a visit's note and a refused order's words, and the shop's saved place.
    assert.deepEqual(registry.TABLES.wholesale_visits.erase, { note: null });
    assert.ok(registry.TABLES.wholesale_customer_profiles.erase.latitude === null);
  });

  // Last, as it takes the app away and brings it back with its tables empty.
  await t.test('consent given and withdrawn in the field; the Down half keeps it as at the counter, saying how, and Up brings the field channel back', async () => {
    // A second shop from the field, its consent given to the salesperson and kept.
    const store = await R('POST', W('sales/shops'), { requestKey: key(), name: 'Ganesh Medical Store', address: 'Bus stand road', takenAt: now(1), consents: { bills_digital: true } }, 201);
    const kept = await one("SELECT id,channel FROM business_consents WHERE business_id=$1 AND contact_id=$2 AND purpose='bills_digital' AND withdrawn_at IS NULL", [ws.id, store.contact_id]);
    assert.equal(kept.channel, 'field');
    // Sai Medical tells the salesperson to stop the bills on WhatsApp: the office records it as told there.
    const given = await one("SELECT id FROM business_consents WHERE business_id=$1 AND contact_id=$2 AND purpose='bills_digital' AND withdrawn_at IS NULL", [ws.id, medicalShop.id]);
    await owner('POST', W(`privacy/consents/${kept.id}/withdraw`), { reason: 'Asked to stop', channel: 'door' }, 400);
    await owner('POST', W(`privacy/consents/${given.id}/withdraw`), { reason: 'Asked the salesperson to stop', channel: 'field' });
    const withdrawn = await one('SELECT channel,withdrawal_channel FROM business_consents WHERE id=$1', [given.id]);
    assert.deepEqual([withdrawn.channel, withdrawn.withdrawal_channel], ['field', 'field']);

    const probe = new Client({ ...connection, database });
    await probe.connect();
    try {
      // Whether each of the two checks allows the field channel.
      const field = async () => (await probe.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='business_consents'::regclass
        AND conname IN ('business_consents_channel','business_consents_withdrawal_channel') ORDER BY conname`)).rows.map((r) => r.def.includes("'field'"));
      assert.deepEqual(await field(), [true, true]);
      const file = fs.readdirSync(dir).find((name) => /^\d+_salesperson-app\.sql$/.test(name));
      await migrate({ direction: 'down', count: Number(file.split('_')[0]), timestamp: true });
      assert.deepEqual(await field(), [false, false]);
      const rowsAfter = (await probe.query('SELECT id,channel,method,recorded_by,note,withdrawal_channel,withdrawal_reason FROM business_consents WHERE id = ANY($1) ORDER BY id',
        [[given.id, kept.id]])).rows;
      assert.deepEqual(rowsAfter.map((r) => [Number(r.id), r.channel, r.method, Number(r.recorded_by), r.note, r.withdrawal_channel, r.withdrawal_reason]), [
        [Number(given.id), 'counter', 'verbal', Number(ravi.id), 'Given in person to a salesperson at the shop', 'counter', 'Asked the salesperson to stop · Withdrawn in person to a salesperson at the shop'],
        [Number(kept.id), 'counter', 'verbal', Number(ravi.id), 'Given in person to a salesperson at the shop', null, null],
      ]);
      assert.equal((await probe.query("SELECT count(*)::int AS n FROM business_consents WHERE channel='field' OR withdrawal_channel='field'")).rows[0].n, 0);
      await migrate({ direction: 'up', count: Infinity });
      assert.deepEqual(await field(), [true, true]);
    } finally { await probe.end(); }
  });
});
