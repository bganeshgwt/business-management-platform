const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { ZONES, addDays, hourNow, today } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The rest of GST rates by date, and of quotations. Rates kept in settings (a
// fashion shop's GST by price, a lodge's room-night slabs, a restaurant's
// default rate) change on their date on the business's own clock; a
// notification's list of HSN codes becomes dated changes; the bell reminds
// those who manage GST rates 7 days and 1 day before; open quotations and
// sales orders say what moves. A kit is quoted as one line and billed as its
// parts; part of a quotation is billed, never more than it holds; a quotation
// keeps the terms it was made with; a sales order from a quotation passes a
// credit hold with a manager's PIN. The clock is moved a day by giving the
// business (or restaurant) a time zone a day ahead. Runs on its own throwaway
// database with every migration applied.
test('GST changes and quotations', { timeout: 900000 }, async (t) => {
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
  const migrations = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: migrations, migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes the dated settings, the lists, part bills and terms away, and Up brings them back', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const left = async () => (await scratch.query(`SELECT
        (SELECT count(*)::int FROM pg_tables WHERE tablename IN ('business_tax_setting_changes','business_tax_change_imports','business_quotation_billed')) AS tables,
        (SELECT count(*)::int FROM information_schema.columns WHERE (table_name, column_name) IN
          (('business_tax_changes','import_id'),('business_quotation_lines','kit_parts'),('business_settings','quotation_terms'),('business_quotations','terms'))) AS columns,
        (SELECT count(*)::int FROM pg_proc WHERE proname IN ('business_tax_setting_change_world','business_tax_setting_changes_kept',
          'business_tax_change_imports_kept','business_quotation_billed_check')) AS functions,
        position('business_tax_setting_changes' IN (SELECT prosrc FROM pg_proc WHERE proname = 'business_tax_change_apply')) > 0 AS shop_settings,
        position('restaurant_default' IN (SELECT prosrc FROM pg_proc WHERE proname = 'business_tax_change_apply_menu')) > 0 AS menu_settings,
        position('business_tax_setting_changes' IN (SELECT prosrc FROM pg_proc WHERE proname = 'business_tax_rates_in_change')) > 0 AS slabs_kept,
        position('terms' IN (SELECT prosrc FROM pg_proc WHERE proname = 'business_quotations_guard')) > 0 AS terms_kept`)).rows[0];
    const all = { tables: 3, columns: 4, functions: 4, shop_settings: true, menu_settings: true, slabs_kept: true, terms_kept: true };
    assert.deepEqual(await left(), all);
    // This migration's Down half, after those of every newer one: its timestamp from its file name.
    const file = fs.readdirSync(migrations).find((name) => name.endsWith('_gst-changes-quotations.sql'));
    await migrate({ direction: 'down', count: Number(file.split('_')[0]), timestamp: true });
    assert.deepEqual(await left(), { tables: 0, columns: 0, functions: 0, shop_settings: false, menu_settings: false, slabs_kept: false, terms_kept: false });
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await left(), all);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Gq-${crypto.randomBytes(8).toString('hex')}`;
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('gq-owner');
  await owner('gq-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('gq-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('gq-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const sum = (list, pick) => list.reduce((total, x) => total + paise(pick(x)), 0);

  // --- The clock ---------------------------------------------------------------------------
  // Two place-named zones whose dates are a day apart, each an hour or more
  // before its midnight (the earliest hours first): a business is given the
  // first for "the day before" and the second for "the day of".
  const zones = ZONES.map((zone) => ({ zone, date: today(zone), hour: hourNow(zone) })).sort((a, b) => a.hour - b.hour);
  let clock = null;
  for (const earlier of zones.filter((z) => z.hour <= 22)) {
    const later = zones.find((z) => z.date === addDays(earlier.date, 1) && z.hour <= 22);
    if (later) { clock = { before: earlier, after: later }; break; }
  }
  assert.ok(clock, 'two zones a day apart');
  const D = clock.before.date, D1 = clock.after.date;
  const dayBefore = (ids) => pool.query('UPDATE businesses SET timezone=$2 WHERE id=ANY($1::bigint[])', [ids, clock.before.zone]);
  const dayOf = (ids) => pool.query('UPDATE businesses SET timezone=$2 WHERE id=ANY($1::bigint[])', [ids, clock.after.zone]);

  // --- The businesses -------------------------------------------------------------------------
  const [fashion, lodge, hardware, grocery] = await withTools(request, await createBusinesses(request, 'GQ', ['fashion', 'lodging', 'hardware', 'grocery']));
  const [elsewhere] = await createBusinesses(other, 'GQELSE', ['fashion']);
  const at = (business) => (suffix) => `/businesses/${business.id}/${suffix}`;
  const F = at(fashion), L = at(lodge), H = at(hardware), G = at(grocery);
  const slabsOf = async (business) => {
    const slabs = (await request('GET', `/businesses/${business.id}/tax-rates?limit=100`)).items;
    return { nil: slabs.find((r) => Number(r.rate) === 0), gst5: slabs.find((r) => Number(r.rate) === 5), gst18: slabs.find((r) => Number(r.rate) === 18) };
  };
  const firstLocation = async (business) => (await request('GET', `/businesses/${business.id}/locations`)).items[0];
  const goods = (business, body) => request('POST', `/businesses/${business.id}/catalog`, { kind: 'goods', tracking: 'quantity', unit: 'each', ...body }, 201);
  const customer = (business, name, extra = {}) => request('POST', `/businesses/${business.id}/contacts`, { kind: 'customer', name, ...extra }, 201);
  const staffRole = async (business, email, template) => {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email, email, hash]);
    const roles = (await request('GET', `/businesses/${business.id}/roles?limit=100`)).items;
    await request('POST', `/businesses/${business.id}/members`, { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    return { id: person.id, token: await login(email) };
  };
  const sale = (business, location, lines, extra = {}) => request('POST', `/businesses/${business.id}/documents`,
    { kind: 'sale', requestKey: key(), locationId: location.id, lines, payment: { method: 'upi', amount: 'full' }, ...extra }, 201);
  const linesOf = async (business, document) => (await request('GET', `/businesses/${business.id}/documents/${document.id}`)).lines;
  const stockOf = async (sku) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE sku_id=$1', [sku.id])).q);
  const bellOf = async (business, token = ownerToken) => (await as(token)('GET', `/businesses/${business.id}/notifications`)).items.filter((i) => i.category === 'GST rates');

  await t.test('a fashion shop\'s GST by price changes on its date, on its own clock, and is kept with what it was', async () => {
    await dayBefore([fashion.id]);
    const fs = await slabsOf(fashion);
    const shop = await firstLocation(fashion);
    const kurtas = await request('POST', F('categories'), { name: 'Kurtas' }, 201);
    await request('PUT', F('fashion/gst-rule'), { active: true, threshold: '2500', rateLow: '5', rateHigh: '18', categoryIds: [kurtas.id] });
    // ₹1,575 a piece including GST is ₹1,500 at 5%: the lower rate while the limit is ₹2,500.
    const kurta = await goods(fashion, { name: 'Cotton kurta', code: 'KURTA', price: '1575', taxRateId: fs.gst5.id, categoryId: kurtas.id,
      openingStock: { locationId: shop.id, quantity: '20', unitCost: '900' } });
    const cashier = await staffRole(fashion, 'gq-fashion-cashier@test.invalid', 'cashier');
    const body = { requestKey: key(), startsOn: D1, reason: 'Apparel above ₹1,000 a piece at 18%', values: { threshold: '1000', rateLow: '5', rateHigh: '18' } };
    assert.equal((await refused('POST', F('tax-changes/settings'), body, cashier.token)).status, 403);
    assert.match((await refused('POST', F('tax-changes/settings'), { ...body, requestKey: key(), startsOn: D })).message, /later day than today/);
    assert.match((await refused('POST', F('tax-changes/settings'), { ...body, requestKey: key(), values: { threshold: '1000', rateLow: '18', rateHigh: '5' } })).message,
      /higher rate must be at least the lower rate/);
    const change = await request('POST', F('tax-changes/settings'), body, 201);
    assert.equal(change.state, 'scheduled');
    assert.equal(change.words, 'Up to ₹1,000.00 a piece 5%, above it 18%');
    assert.equal((await request('POST', F('tax-changes/settings'), body, 201)).id, change.id, 'sent again, it is one change');
    assert.equal((await refused('POST', F('tax-changes/settings'), { ...body, reason: 'Other' })).status, 409);
    assert.match((await refused('POST', F('tax-changes/settings'), { ...body, requestKey: key() })).message, /GST by price already changes on/);
    const already = await refused('POST', F('tax-changes/settings'), { ...body, requestKey: key(), startsOn: addDays(D1, 1) });
    assert.equal(already.data.reason, 'already_set');
    // Another business never sees it; a business of another kind keeps no such rate.
    assert.equal((await refused('GET', `/businesses/${elsewhere.id}/tax-changes/settings`)).status, 404);
    assert.equal((await request('GET', G('tax-changes/settings'))).setting, null);
    assert.equal((await refused('POST', G('tax-changes/settings'), { ...body, requestKey: key() })).status, 404);
    // One to cancel before its date.
    const later = await request('POST', F('tax-changes/settings'), { ...body, requestKey: key(), startsOn: addDays(D1, 5), values: { threshold: '1500', rateLow: '5', rateHigh: '18' } }, 201);
    const cancelled = await request('POST', F(`tax-changes/settings/${later.id}/cancel`), { reason: 'Not notified after all' });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal((await request('POST', F(`tax-changes/settings/${later.id}/cancel`), { reason: 'Again' })).state, 'cancelled');
    const read = await request('GET', F('tax-changes/settings'));
    assert.equal(read.setting, 'fashion_price');
    assert.equal(read.current.threshold, '2500.00');
    assert.equal(read.changes[0].id, change.id);
    // The bell of those who manage GST rates: the day before.
    assert.ok((await bellOf(fashion)).some((i) => i.id === `tax_change:setting:${change.id}:1` && /GST by price changes tomorrow/.test(i.title)));
    assert.deepEqual(await bellOf(fashion, cashier.token), []);
    // The day before: a kurta of ₹1,500 is at 5%.
    const before = await sale(fashion, shop, [{ skuId: kurta.id, quantity: '1' }]);
    assert.equal(Number((await linesOf(fashion, before))[0].tax_rate), 5);
    // The day of: the same kurta is above the new limit, at 18%.
    await dayOf([fashion.id]);
    const after = await sale(fashion, shop, [{ skuId: kurta.id, quantity: '1' }]);
    assert.equal(Number((await linesOf(fashion, after))[0].tax_rate), 18);
    assert.equal(paise(after.total), paise(before.total), 'a price that includes GST keeps its total');
    const rule = await request('GET', F('fashion/gst-rule'));
    assert.equal(Number(rule.threshold), 1000);
    const now = await request('GET', F('tax-changes/settings'));
    const kept = now.changes.find((c) => c.id === change.id);
    assert.equal(kept.state, 'in_force');
    assert.deepEqual(kept.before, { threshold: '2500.00', rateLow: '5.00', rateHigh: '18.00' });
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='tax_change.setting_applied' AND entity_id=$2", [fashion.id, change.id]));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='tax_change.setting_scheduled' AND entity_id=$2", [fashion.id, change.id]));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='tax_change.setting_cancelled' AND entity_id=$2", [fashion.id, later.id]));
    assert.equal((await refused('POST', F(`tax-changes/settings/${change.id}/cancel`), { reason: 'Too late' })).status, 409);
    // The database keeps it as it was.
    await assert.rejects(pool.query("UPDATE business_tax_setting_changes SET reason='x' WHERE id=$1", [change.id]), /kept as it is/);
    await assert.rejects(pool.query('DELETE FROM business_tax_setting_changes WHERE id=$1', [change.id]), /kept for good/);
  });

  await t.test('a lodge\'s room-night slabs and their limit change on its date; a slab they move to stays on until then', async () => {
    await dayBefore([lodge.id]);
    const ls = await slabsOf(lodge);
    const gst12 = await request('POST', L('tax-rates'), { name: 'GST 12%', rate: '12' }, 201);
    const body = { requestKey: key(), startsOn: D1, reason: 'Room nights up to ₹10,000 at 12%', values: { lowTaxRateId: gst12.id, highTaxRateId: ls.gst18.id, slabLimit: '10000' } };
    const notSet = await refused('POST', L('tax-changes/settings'), body);
    assert.equal(notSet.status, 409);
    assert.match(notSet.message, /Set the two GST slabs for room nights first/);
    await request('PUT', L('lodging/settings'), { lowTaxRateId: ls.gst5.id, highTaxRateId: ls.gst18.id });
    assert.match((await refused('POST', L('tax-changes/settings'), { ...body, requestKey: key(), values: { lowTaxRateId: ls.gst18.id, highTaxRateId: gst12.id, slabLimit: '10000' } })).message,
      /GST 18% is not below GST 12%/);
    const change = await request('POST', L('tax-changes/settings'), body, 201);
    assert.equal(change.values.lowName, 'GST 12%');
    const off = await refused('PATCH', L(`tax-rates/${gst12.id}`), { name: gst12.name, active: false });
    assert.equal(off.status, 409);
    assert.match(off.message, /Room nights are billed at GST 12% from/);
    assert.equal((await request('GET', L('lodging/setup'))).settings.slabLimit, '7500.00');
    await dayOf([lodge.id]);
    const { settings } = await request('GET', L('lodging/setup'));
    assert.equal(Number(settings.lowTaxRateId), Number(gst12.id));
    assert.equal(settings.slabLimit, '10000.00');
    const kept = (await request('GET', L('tax-changes/settings'))).changes.find((c) => c.id === change.id);
    assert.equal(kept.state, 'in_force');
    assert.equal(Number(kept.before.lowTaxRateId), Number(ls.gst5.id));
    assert.equal(kept.beforeWords, 'A room night up to ₹7,500.00 at GST 5%, above it GST 18%');
  });

  // A restaurant's default GST rate: its advances' GST, at the rate of the day each was received.
  const restaurantService = require('../../src/modules/restaurant/setup/services/restaurant.service');
  await restaurantService.createRestaurant({ name: 'Ganga Sweets', code: 'GQSWEETS', invoicePrefix: 'GS', timezone: clock.before.zone,
    admin: { name: 'Sweets owner', email: 'sweets@gq.invalid', password } });
  const sweets = await one("SELECT id FROM restaurants WHERE code='GQSWEETS'");
  const sweetsToken = await login('sweets@gq.invalid');
  const S = as(sweetsToken);
  const sweetsCashier = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [sweets.id, 'Sweets cashier', 'sweets-cashier@gq.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='CASHIER' AND restaurant_id IS NULL", [sweetsCashier.id]);
  const sweetsCashierToken = await login('sweets-cashier@gq.invalid');

  await t.test('a restaurant\'s default GST rate changes on its trading day, and each advance\'s GST is at the rate of its own day', async () => {
    await S('PUT', '/business-day/rules', { cutoffHour: 0, varianceThreshold: 100, blindCount: false });
    const R0 = (await S('POST', '/business-day/open', { openingCash: 0 }, 201)).businessDate.slice(0, 10);
    const R1 = addDays(R0, 1);
    const before = await S('GET', '/menu/tax-changes/settings');
    assert.equal(before.setting, 'restaurant_default');
    assert.equal(before.current.rate, '5.00');
    const body = { requestKey: key(), startsOn: R1, reason: 'Outdoor catering at 18%', values: { rate: '18' } };
    assert.equal((await call('POST', '/menu/tax-changes/settings', body, sweetsCashierToken)).status, 403);
    const change = await S('POST', '/menu/tax-changes/settings', body, 201);
    assert.equal(change.words, '18%');
    // The bell of those who manage the menu, the day before.
    const bell = (await S('GET', '/notifications')).items.filter((i) => i.source === 'taxChanges');
    assert.ok(bell.some((i) => i.id === `taxChanges:setting:${change.id}:1` && i.title === 'Default GST rate changes tomorrow'), JSON.stringify(bell));
    const guest = await S('POST', '/crm/customers', { name: 'Meera', mobile: '9876500191' }, 201);
    await S('POST', '/bills/advances', { customerId: guest.id, amount: 1050, paymentMethod: 'cash', purpose: 'Wedding sweets' }, 201);
    const sheet = await S('GET', '/reports/day-end');
    await S('POST', '/business-day/close', { closingCash: sheet.expectedCash });
    await pool.query('UPDATE restaurant_settings SET timezone=$2 WHERE restaurant_id=$1', [sweets.id, clock.after.zone]);
    assert.equal((await S('POST', '/business-day/open', { openingCash: 0 }, 201)).businessDate.slice(0, 10), R1);
    assert.equal((await S('GET', '/restaurants/current/settings')).defaultTaxPercentage, 18);
    await S('POST', '/bills/advances', { customerId: guest.id, amount: 1180, paymentMethod: 'upi', transactionRef: 'UTR 77', purpose: 'Festival order' }, 201);
    const gst = await S('GET', `/bills/advances/gst?from=${R0}&to=${R1}`);
    assert.deepEqual(gst.rates, [5, 18]);
    assert.deepEqual(gst.byRate.map((r) => [r.rate, r.table11A.gross, r.table11A.taxable]), [[5, 1050, 1000], [18, 1180, 1000]]);
    assert.equal(gst.table11A.gross, 2230);
    assert.equal(gst.table11A.taxable, 2000);
    assert.equal(gst.table11A.cgst + gst.table11A.sgst, 230);
    const kept = (await S('GET', '/menu/tax-changes/settings')).changes.find((c) => c.id === change.id);
    assert.equal(kept.state, 'in_force');
    assert.deepEqual(kept.before, { rate: '5.00' });
    assert.ok(await one("SELECT 1 FROM audit_logs WHERE restaurant_id=$1 AND entity_type='settings' AND details->>'via' LIKE 'GST rate change of %'", [sweets.id]));
  });

  // --- A notification's list -------------------------------------------------------------------
  const T = today('Asia/Kolkata');
  const gs = await slabsOf(grocery);
  const gGst12 = await request('POST', G('tax-rates'), { name: 'GST 12%', rate: '12' }, 201);
  const kirana = await firstLocation(grocery);
  const stock = (quantity = '50') => ({ locationId: kirana.id, quantity, unitCost: '10' });
  const notebook = await goods(grocery, { name: 'Notebook A4', code: 'NB-A4', price: '59', taxRateId: gs.gst18.id, hsnCode: '48202000', openingStock: stock() });
  const register = await goods(grocery, { name: 'Long register', code: 'REG', price: '105', taxRateId: gs.gst5.id, hsnCode: '48201000', openingStock: stock() });
  const biscuit = await goods(grocery, { name: 'Cream biscuit', code: 'BIS', price: '30', taxRateId: gs.gst18.id, hsnCode: '19053100', openingStock: stock() });
  const rusk = await goods(grocery, { name: 'Milk rusk', code: 'RUSK', price: '40', taxRateId: gs.gst18.id, hsnCode: '19054000', openingStock: stock() });
  const chocolate = await goods(grocery, { name: 'Milk chocolate', code: 'CHOC', price: '50', taxRateId: gs.gst18.id, hsnCode: '18063100', openingStock: stock() });

  await t.test('a notification\'s list: each code finds its items, codes that find nothing and items given two rates are shown, and it becomes changes by rate', async () => {
    const startsOn = addDays(T, 30);
    assert.match((await refused('POST', G('tax-changes/import/preview'), { startsOn, lines: [{ code: '19', rate: '5' }] })).message, /not an HSN or SAC code of 4, 6 or 8 digits/);
    assert.match((await refused('POST', G('tax-changes/import/preview'), { startsOn, lines: [{ code: '1905', rate: 'five' }] })).message, /is not a GST rate/);
    assert.match((await refused('POST', G('tax-changes/import/preview'), { startsOn, lines: [{ code: '1905', rate: '5' }, { code: '1905', rate: '12' }] })).message,
      /Code 1905 is in the list twice, at 5% and at 12%/);
    const list = [{ code: '4820', rate: '5%' }, { code: '1905', rate: '12' }, { code: '1905 31', rate: '5' }, { code: '9999', rate: '5' }, { code: '1806', rate: '28' }];
    const preview = await request('POST', G('tax-changes/import/preview'), { startsOn, lines: list });
    const line = (code) => preview.lines.find((l) => l.code === code);
    assert.deepEqual(line('4820').items.map((i) => i.label).sort(), ['Long register', 'Notebook A4']);
    assert.equal(line('4820').target.name, 'GST 5%');
    assert.deepEqual(line('1905').items.map((i) => i.label).sort(), ['Cream biscuit', 'Milk rusk']);
    assert.deepEqual(preview.unmatched, ['9999']);
    assert.match(line('1806').problem, /No GST slab at 28%: add it under Settings › Tax rates first/);
    assert.deepEqual(preview.conflicts.map((c) => [c.label, c.lines.map((l) => `${l.code}@${Number(l.rate)}`).sort()]), [['Cream biscuit', ['190531@5', '1905@12']]]);
    // The register is at 5% already: left out, and so is the biscuit until the list is put right.
    assert.ok(preview.leftOut.some((i) => i.label === 'Long register' && /already/.test(i.problem)));
    assert.equal(preview.moving, 2);
    assert.deepEqual(preview.changes.map((c) => [c.target.name, c.items]), [['GST 5%', 1], ['GST 12%', 1]]);
    const body = { requestKey: key(), startsOn, reason: 'Notification 9/2027-Central Tax (Rate)', lines: list };
    const noRate = await refused('POST', G('tax-changes/import'), body);
    assert.equal(noRate.status, 409);
    assert.equal(noRate.data.reason, 'no_rate');
    const conflicts = await refused('POST', G('tax-changes/import'), { ...body, requestKey: key(), lines: list.filter((l) => l.code !== '1806') });
    assert.equal(conflicts.status, 409);
    assert.equal(conflicts.data.reason, 'import_conflicts');
    assert.match(conflicts.message, /Cream biscuit \(19053100\) is found by 1905 at 12% and by 190531 at 5%/);
    const fixed = { ...body, requestKey: key(), lines: [{ code: '4820', rate: '5' }, { code: '1905', rate: '12' }, { code: '9999', rate: '5' }] };
    const made = await request('POST', G('tax-changes/import'), fixed, 201);
    assert.equal(made.items, 3);
    assert.deepEqual(made.changes.map((c) => [c.rate_name, c.items]), [['GST 5%', 1], ['GST 12%', 2]]);
    assert.equal((await request('POST', G('tax-changes/import'), fixed, 201)).id, made.id, 'sent again, it is the same list');
    assert.equal((await refused('POST', G('tax-changes/import'), { ...fixed, reason: 'Other' })).status, 409);
    const named = await rows('SELECT id,import_id FROM business_tax_changes WHERE business_id=$1 AND import_id=$2', [grocery.id, made.id]);
    assert.equal(named.length, 2);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='tax_change.imported' AND entity_id=$2", [grocery.id, made.id]));
    assert.equal((await refused('POST', G('tax-changes/import'), { ...fixed, requestKey: key(), lines: [{ code: '9999', rate: '5' }] })).data.reason, 'nothing_moves');
    // Items already moving on that day are left out of a second list, with why.
    const again = await request('POST', G('tax-changes/import/preview'), { startsOn, lines: [{ code: '4820', rate: '12' }] });
    assert.ok(again.leftOut.some((i) => i.label === 'Notebook A4' && /already moves/.test(i.problem)));
  });

  await t.test('a list that moves more than 2,000 items becomes several changes in one go', async () => {
    const head = ['Name', 'Code', 'Kind', 'Unit', 'HSN / SAC', 'GST rate', 'Sale price'];
    const sheet = Array.from({ length: 2001 }, (_, n) => ({ Name: `Exercise book ${n + 1}`, Code: `EXB-${n + 1}`, Kind: 'Goods', Unit: 'each',
      'HSN / SAC': '49011010', 'GST rate': '18%', 'Sale price': '40' }));
    assert.deepEqual(Object.keys(sheet[0]), head);
    await request('POST', G('catalog/import'), { rows: sheet, dryRun: false, fileName: 'books.csv', requestKey: key() });
    const startsOn = addDays(T, 40);
    const preview = await request('POST', G('tax-changes/import/preview'), { startsOn, lines: [{ code: '4901', rate: '5' }] });
    assert.equal(preview.moving, 2001);
    assert.deepEqual(preview.changes.map((c) => c.items), [2000, 1]);
    assert.equal(preview.lines[0].found, 2001);
    assert.equal(preview.lines[0].items.length, 100);
    const made = await request('POST', G('tax-changes/import'), { requestKey: key(), startsOn, reason: 'Books to 5%', lines: [{ code: '4901', rate: '5' }] }, 201);
    assert.deepEqual(made.changes.map((c) => c.items), [2000, 1]);
  });

  await t.test('the bell of those who manage GST rates shows a change 7 days before its date and again the day before', async () => {
    const manager = await staffRole(grocery, 'gq-grocery-manager@test.invalid', 'manager');
    const cashier = await staffRole(grocery, 'gq-grocery-cashier@test.invalid', 'cashier');
    const change = (sku, days) => request('POST', G('tax-changes'), { requestKey: key(), taxRateId: gGst12.id, startsOn: addDays(T, days), reason: `In ${days} days`, items: [sku.id] }, 201);
    const seven = await change(chocolate, 7);
    const two = await change(register, 2);
    const tomorrow = await change(rusk, 1);
    const eight = await change(biscuit, 8);
    const bell = await bellOf(grocery, manager.token);
    const ids = bell.map((i) => i.id);
    assert.ok(ids.includes(`tax_change:${seven.id}:7`));
    assert.ok(ids.includes(`tax_change:${tomorrow.id}:1`));
    assert.ok(!ids.some((id) => id.startsWith(`tax_change:${eight.id}:`)), 'eight days ahead is not shown yet');
    const one7 = bell.find((i) => i.id === `tax_change:${seven.id}:7`);
    assert.equal(one7.title, '1 item moves to GST 12% in 7 days');
    assert.match(one7.detail, /now at GST 18% \(1\)/);
    assert.equal(bell.find((i) => i.id === `tax_change:${tomorrow.id}:1`).severity, 'warning');
    // From 7 days before it keeps the id it was first shown with (read once, it stays read); the day before it has a new one.
    assert.ok(ids.includes(`tax_change:${two.id}:7`));
    assert.deepEqual(await bellOf(grocery, cashier.token), [], 'a cashier does not manage GST rates');
    for (const c of [seven, two, tomorrow, eight]) await request('POST', G(`tax-changes/${c.id}/cancel`), { reason: 'Test over' });
    assert.deepEqual(await bellOf(grocery, manager.token), []);
  });

  // --- Quotations ---------------------------------------------------------------------------
  const hs = await slabsOf(hardware);
  const yard = await firstLocation(hardware);
  const hstock = (quantity = '100') => ({ locationId: yard.id, quantity, unitCost: '10' });
  const cement = await goods(hardware, { name: 'OPC cement 50 kg', code: 'CEM', price: '413', taxRateId: hs.gst18.id, hsnCode: '25232930', openingStock: hstock('200') });
  const sand = await goods(hardware, { name: 'River sand bag', code: 'SAND', price: '105', taxRateId: hs.gst5.id, hsnCode: '25051011', openingStock: hstock('200') });
  const paint = await goods(hardware, { name: 'Wall paint 1 L', code: 'PAINT', price: '472', taxRateId: hs.gst18.id, hsnCode: '32091010', openingStock: hstock() });
  const brush = await goods(hardware, { name: 'Paint brush 2 in', code: 'BRUSH', price: '105', taxRateId: hs.gst5.id, hsnCode: '96034000', openingStock: hstock() });
  const kit = await request('POST', H('kits'), { name: 'Painting kit', code: 'PKIT', price: '550', components: [{ skuId: paint.id, quantity: 1 }, { skuId: brush.id, quantity: 1 }] }, 201);
  const builder = await customer(hardware, 'Sharma Constructions', { phone: '9845012345' });
  const hManager = await staffRole(hardware, 'gq-hw-manager@test.invalid', 'manager');
  const hCashier = await staffRole(hardware, 'gq-hw-cashier@test.invalid', 'cashier');
  const quote = (lines, extra = {}) => request('POST', H('quotations'), { requestKey: key(), locationId: yard.id, contactId: builder.id, validUntil: addDays(T, 10), lines, ...extra }, 201);
  const billQ = (q, body = {}, token = ownerToken) => as(token)('POST', H(`quotations/${q.id}/bill`), { requestKey: key(), ...body }, 201);
  const lineOf = (q, sku) => q.lines.find((l) => Number(l.sku_id) === Number(sku.id));

  await t.test('open quotations and sales orders say which of their items a change moves, and from when', async () => {
    const q = await quote([{ skuId: cement.id, quantity: '10' }, { skuId: sand.id, quantity: '5' }]);
    const order = await request('POST', H('sales-orders'), { locationId: yard.id, contactId: builder.id, requestKey: key(), lines: [{ skuId: cement.id, quantity: '20' }] }, 201);
    const startsOn = addDays(T, 20);
    const preview = await request('POST', H('tax-changes/preview'), { taxRateId: hs.gst5.id, startsOn, items: [cement.id] });
    assert.deepEqual(preview.documents.map((d) => [d.kind, d.number]).sort(), [['quotation', q.quotation_no], ['sales_order', order.order_no]].sort());
    assert.deepEqual(preview.documents.find((d) => d.kind === 'quotation').items, ['OPC cement 50 kg']);
    const change = await request('POST', H('tax-changes'), { requestKey: key(), taxRateId: hs.gst5.id, startsOn, reason: 'Cement to 5%', items: [cement.id] }, 201);
    assert.equal(change.documents.length, 2);
    const notice = { startsOn, from: 18, to: 5, toName: 'GST 5%', items: ['OPC cement 50 kg'] };
    assert.deepEqual((await request('GET', H(`quotations/${q.id}`))).tax_notices, [notice]);
    assert.deepEqual((await request('GET', H(`sales-orders/${order.id}`))).tax_notices, [notice]);
    // Nothing changes the documents themselves.
    assert.equal(Number(lineOf(await request('GET', H(`quotations/${q.id}`)), cement).tax_rate), 18);
    await request('POST', H(`tax-changes/${change.id}/cancel`), { reason: 'Not this year' });
    assert.deepEqual((await request('GET', H(`quotations/${q.id}`))).tax_notices, []);
  });

  await t.test('a kit is quoted as one line, priced as on a bill, and billed or ordered as its parts with their own GST', async () => {
    // A bill of two kits, for the prices a quotation of them must show.
    const counter = await sale(hardware, yard, [{ skuId: kit.id, quantity: '2' }]);
    const counterLines = await linesOf(hardware, counter);
    const q = await quote([{ skuId: kit.id, quantity: '2' }, { skuId: sand.id, quantity: '1' }]);
    const kitLine = lineOf(q, kit);
    assert.equal(q.lines.length, 2);
    assert.equal(kitLine.label, 'Painting kit');
    assert.equal(Number(kitLine.quantity), 2);
    assert.deepEqual(kitLine.kit_parts.map((p) => [p.label, Number(p.taxRate), Number(p.quantity)]), [['Wall paint 1 L', 18, 1], ['Paint brush 2 in', 5, 1]]);
    for (const part of kitLine.kit_parts) {
      const same = counterLines.find((l) => Number(l.sku_id) === Number(part.skuId));
      assert.deepEqual([paise(part.net), paise(part.tax)], [paise(same.net), paise(same.tax)], `${part.label}: as on a bill`);
    }
    assert.equal(paise(kitLine.net) + paise(kitLine.tax), 2 * 55000);
    const paintBefore = await stockOf(paint);
    const { document } = await billQ(q);
    const billed = await linesOf(hardware, document);
    const parts = billed.filter((l) => Number(l.kit_sku_id) === Number(kit.id));
    assert.deepEqual(parts.map((l) => [Number(l.quantity), Number(l.tax_rate), l.kit_label]), [[2, 18, 'Painting kit'], [2, 5, 'Painting kit']]);
    assert.equal(paise(document.total), paise(q.total));
    assert.equal(await stockOf(paint), paintBefore - 2);
    // Ordered: the kit's parts go on the sales order at their quoted shares.
    const q2 = await quote([{ skuId: kit.id, quantity: '3' }]);
    const { order } = await request('POST', H(`quotations/${q2.id}/order`), { requestKey: key() }, 201);
    const detail = await request('GET', H(`sales-orders/${order.id}`));
    assert.deepEqual(detail.lines.map((l) => [Number(l.sku_id), Number(l.quantity)]).sort(), [[Number(paint.id), 3], [Number(brush.id), 3]].sort());
    assert.equal(paise(detail.subtotal) + paise(detail.tax), paise(q2.subtotal) + paise(q2.tax));
    // In parts: whole kits only, each bill its parts' shares, adding up to the line.
    const q3 = await quote([{ skuId: kit.id, quantity: '3' }]);
    const line3 = lineOf(q3, kit);
    assert.match((await refused('POST', H(`quotations/${q3.id}/bill`), { requestKey: key(), parts: [{ lineId: line3.id, quantity: '1.5' }] })).message, /billed in whole kits/);
    const first = await billQ(q3, { parts: [{ lineId: line3.id, quantity: '1' }] });
    assert.equal(first.quotation.state, 'part_billed');
    const rest = await billQ(q3);
    assert.equal(rest.quotation.status, 'billed');
    const all = [...await linesOf(hardware, first.document), ...await linesOf(hardware, rest.document)];
    for (const part of line3.kit_parts) {
      assert.equal(sum(all.filter((l) => Number(l.sku_id) === Number(part.skuId)), (l) => l.net), paise(part.net), `${part.label} adds up to its quoted share`);
    }
  });

  await t.test('part of a quotation is billed: what is billed and left is shown, two at once never bill more than it holds', async () => {
    const q = await quote([{ skuId: cement.id, quantity: '10' }, { skuId: sand.id, quantity: '20' }]);
    const cementLine = lineOf(q, cement), sandLine = lineOf(q, sand);
    const body = { requestKey: key(), parts: [{ lineId: cementLine.id, quantity: '4' }] };
    const first = await billQ(q, body);
    assert.equal(first.quotation.state, 'part_billed');
    assert.equal(first.quotation.status, 'open');
    assert.equal(lineOf(first.quotation, cement).left_quantity, '6.000');
    assert.equal(lineOf(first.quotation, sand).left_quantity, '20.000');
    assert.deepEqual((await linesOf(hardware, first.document)).map((l) => [Number(l.sku_id), Number(l.quantity)]), [[Number(cement.id), 4]]);
    assert.equal(first.quotation.bills.length, 1);
    // Sent again: the same bill; the same key for something else: refused.
    assert.equal((await billQ(q, body)).document.id, first.document.id);
    assert.equal((await refused('POST', H(`quotations/${q.id}/bill`), { ...body, parts: [{ lineId: cementLine.id, quantity: '5' }] })).status, 409);
    const over = await refused('POST', H(`quotations/${q.id}/bill`), { requestKey: key(), parts: [{ lineId: cementLine.id, quantity: '7' }] });
    assert.equal(over.status, 409);
    assert.match(over.message, /OPC cement 50 kg: 6 each is left to bill/);
    assert.match((await refused('PUT', H(`quotations/${q.id}`), { requestKey: key(), contactId: builder.id, validUntil: addDays(T, 10), lines: [{ skuId: cement.id, quantity: '1' }] })).message,
      /Part of quotation .* is billed/);
    // Two people bill 4 of the 6 left at the same moment: one bill is made, the other is refused.
    const both = await Promise.all([1, 2].map(() => call('POST', H(`quotations/${q.id}/bill`), { requestKey: key(), parts: [{ lineId: cementLine.id, quantity: '4' }] }, ownerToken)));
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    const now = await request('GET', H(`quotations/${q.id}`));
    assert.equal(lineOf(now, cement).left_quantity, '2.000');
    // The rest: nothing is left, it is Billed, and the bills add up to the quotation line by line.
    const last = await billQ(q, {}, hCashier.token);
    assert.equal(last.quotation.status, 'billed');
    assert.equal(Number(last.quotation.document_id), Number(last.document.id));
    const bills = last.quotation.bills;
    assert.equal(bills.length, 3);
    const lines = [];
    for (const b of bills) lines.push(...await linesOf(hardware, { id: b.id }));
    assert.equal(sum(lines.filter((l) => Number(l.sku_id) === Number(cement.id)), (l) => l.net), paise(cementLine.net));
    assert.equal(sum(lines.filter((l) => Number(l.sku_id) === Number(cement.id)), (l) => l.tax), paise(cementLine.tax));
    assert.equal(sum(lines.filter((l) => Number(l.sku_id) === Number(sand.id)), (l) => l.net), paise(sandLine.net));
    assert.equal((await rows("SELECT action FROM business_audit WHERE business_id=$1 AND entity_id=$2 AND action LIKE 'quotation.%billed' ORDER BY id", [hardware.id, q.id]))
      .map((r) => r.action).join(','), 'quotation.part_billed,quotation.part_billed,quotation.billed');
    assert.equal((await rows("SELECT 1 FROM business_events WHERE business_id=$1 AND entity_id=$2 AND kind='quotation.part_billed'", [hardware.id, q.id])).length, 2);
    assert.equal((await refused('POST', H(`quotations/${q.id}/bill`), { requestKey: key() })).status, 409);
    // The database never takes more than a line holds, nor from a billed quotation.
    await assert.rejects(pool.query(`INSERT INTO business_quotation_billed(business_id,quotation_id,line_id,document_id,quantity,net,tax,created_by)
      VALUES($1,$2,$3,$4,1,0,0,$5)`, [hardware.id, q.id, cementLine.id, last.document.id, ownerUser.id]), /is billed and is not billed again/);
    // What is left of another becomes a sales order.
    const q2 = await quote([{ skuId: cement.id, quantity: '5' }]);
    await billQ(q2, { parts: [{ lineId: q2.lines[0].id, quantity: '2' }] });
    const { order, quotation } = await request('POST', H(`quotations/${q2.id}/order`), { requestKey: key() }, 201);
    assert.equal(quotation.status, 'ordered');
    const detail = await request('GET', H(`sales-orders/${order.id}`));
    assert.deepEqual(detail.lines.map((l) => Number(l.quantity)), [3]);
    assert.equal(paise(detail.subtotal), paise(q2.lines[0].net) - Math.round(paise(q2.lines[0].net) * 2 / 5));
  });

  await t.test('a quotation prints the business\'s terms as they were when it was made', async () => {
    const settings = await request('GET', H('settings'));
    const save = (quotationTerms) => request('PUT', H('settings'), { displayName: settings.display_name, taxMode: settings.tax_mode, rounding: settings.rounding,
      fiscalYearStartMonth: settings.fiscal_year_start_month, dateFormat: settings.date_format, quotationTerms });
    const first = 'Prices include unloading at site. 50% advance with the order.';
    assert.equal((await save(first)).quotation_terms, first);
    const qa = await quote([{ skuId: sand.id, quantity: '2' }]);
    assert.equal(qa.terms, first);
    await save('Prices hold for 7 days. Transport extra.');
    assert.equal((await request('GET', H(`quotations/${qa.id}`))).terms, first, 'editing the settings leaves it as made');
    const revised = await request('PUT', H(`quotations/${qa.id}`), { requestKey: key(), contactId: builder.id, validUntil: addDays(T, 9), lines: [{ skuId: sand.id, quantity: '3' }] });
    assert.equal(revised.terms, first, 'a revision keeps them too');
    assert.equal((await quote([{ skuId: sand.id, quantity: '1' }])).terms, 'Prices hold for 7 days. Transport extra.');
    await save('');
    assert.equal((await quote([{ skuId: sand.id, quantity: '1' }])).terms, null);
    await assert.rejects(pool.query("UPDATE business_quotations SET terms='Other terms' WHERE id=$1", [qa.id]), /keeps the terms and conditions it was made with/);
  });

  await t.test('a sales order from a quotation for a customer on credit hold goes through with a manager\'s PIN, recorded as on Sales orders', async () => {
    await request('PUT', H('wholesale-settings'), { holdOverdueDays: 15 });
    const late = await customer(hardware, 'Om Sai Builders', { creditDays: 30 });
    const old = await request('POST', H('documents'), { kind: 'sale', locationId: yard.id, contactId: late.id, requestKey: key(), lines: [{ skuId: sand.id, quantity: '10' }] }, 201);
    await pool.query("UPDATE business_documents SET created_at=now()-interval '60 days', due_on=$2 WHERE id=$1", [old.id, addDays(T, -30)]);
    const q = await quote([{ skuId: cement.id, quantity: '2' }], { contactId: late.id });
    const route = H(`quotations/${q.id}/order`);
    const held = await refused('POST', route, { requestKey: key() }, hCashier.token);
    assert.equal(held.status, 409);
    assert.equal(held.data.reason, 'credit_hold');
    await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [hManager.id, await bcrypt.hash('4321', 4)]);
    assert.equal((await refused('POST', route, { requestKey: key(), release: { reason: 'x', approverId: hManager.id, pin: '9999' } }, hCashier.token)).status, 400);
    const body = { requestKey: key(), release: { reason: 'Cheque promised for Friday', approverId: hManager.id, pin: '4321' } };
    const { order } = await as(hCashier.token)('POST', route, body, 201);
    assert.equal(order.hold_released, true);
    const record = await one('SELECT * FROM wholesale_hold_releases WHERE order_id=$1', [order.id]);
    assert.equal(Number(record.released_by), Number(hManager.id));
    assert.equal(Number(record.requested_by), Number(hCashier.id));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='sales_order.hold_released' AND entity_id=$2 AND actor_id=$3", [hardware.id, order.id, hManager.id]));
    await request('PUT', H('wholesale-settings'), { holdOverdueDays: null });
  });
});
