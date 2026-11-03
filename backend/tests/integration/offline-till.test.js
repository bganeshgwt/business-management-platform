const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, today } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The offline till, end to end on a throwaway database with every migration
// applied (docs/BUSINESS_RULES.md › Offline till):
//   - the application in the catalogue, its permissions, the module switch;
//   - setting up, renaming and retiring tills (never while bills wait on one,
//     unless it is lost: its numbers are then noted);
//   - the snapshot a till keeps, its stamps and balance deltas, and what is
//     left out of it;
//   - the till's pricing module (the staff app's tillPricing.js) gives the
//     same lines and totals as the server's quote, cart after cart;
//   - bills sent later are posted as made: the till's number, its time (the
//     shift, the cash limit, the day's reports and the GST month follow it),
//     its maker and its sender; in order, repeated safely, a number used once,
//     a new financial year's series, gaps recorded and filled, voids kept;
//   - what the till could not know is flagged, never refused, and stock sold
//     short is settled later; faults are refused (409) for the till to show;
//   - a B2B bill once e-invoicing applies; the plan ended; the bell; GSTR-1
//     Table 13 for the tills' series; the cashiers' cash with offline bills.
test('the offline till', { timeout: 900000 }, async (t) => {
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
  const dir = path.resolve(__dirname, '../../migrations');
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes the till tables, the till series and the application away, and Up brings them back', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const state = async () => (await scratch.query(`SELECT
        (SELECT count(*)::int FROM pg_tables WHERE tablename IN ('business_devices','business_till_settings','business_till_bills','business_till_flags',
          'business_till_shortfalls','business_till_gaps')) AS tables,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='business_number_series' AND column_name='device_id') AS device_column,
        (SELECT count(*)::int FROM pg_constraint WHERE conname='business_number_series_business_id_location_id_document_kin_key') AS old_unique,
        (SELECT count(*)::int FROM platform_modules WHERE code='offline_till') AS module,
        (SELECT count(*)::int FROM business_permissions WHERE module_code='offline_till') AS permissions,
        (SELECT prosrc LIKE '%device_id IS NOT NULL%' FROM pg_proc WHERE proname='business_cash_limit_payment') AS cash_rule`)).rows[0];
    assert.deepEqual(await state(), { tables: 6, device_column: 1, old_unique: 0, module: 1, permissions: 3, cash_rule: true });
    const file = fs.readdirSync(dir).find((name) => name.endsWith('_offline-till.sql'));
    await migrate({ direction: 'down', count: Number(file.split('_')[0]), timestamp: true });
    assert.deepEqual(await state(), { tables: 0, device_column: 0, old_unique: 1, module: 0, permissions: 0, cash_rule: false });
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await state(), { tables: 6, device_column: 1, old_unique: 0, module: 1, permissions: 3, cash_rule: true });
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require('../../src/modules/restaurant/setup/services/restaurant.service');
  const password = `Till-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const spice = await restaurantService.createRestaurant({ name: 'Annapurna Bhavan', code: 'TILLANNA', timezone: 'Asia/Kolkata',
    admin: { name: 'Lakshmi Iyer', email: 'lakshmi@till.invalid', password } });

  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth, headers = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const as = (auth, headers) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth, headers);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const refusal = async (method, route, body, auth, status, headers) => {
    const result = await call(method, route, body, auth, headers);
    assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return { message: result.body.message, reason: result.body.data?.reason };
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const owner = await login('lakshmi@till.invalid');
  const request = as(owner);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const money = (value) => (value / 100).toFixed(2);
  const pricing = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/business-web/src/modules/business/till/services/tillPricing.js')).href);
  const snapshots = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/business-web/src/modules/business/till/services/tillSnapshot.js')).href);
  const appRules = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/business-web/src/modules/business/till/services/tillRules.js')).href);

  const [grocery, fashion, pharmacy] = await createBusinesses(request, 'TILL', ['grocery', 'fashion', 'pharmacy']);
  const G = (route) => `/businesses/${grocery.id}/${route}`;
  const F = (route) => `/businesses/${fashion.id}/${route}`;
  const firstLocation = async (biz) => (await request('GET', `/businesses/${biz.id}/locations`)).items[0];
  const gloc = await firstLocation(grocery);
  const floc = await firstLocation(fashion);

  // Staff: two cashiers and a manager at the kirana; a cashier at the clothes shop.
  async function person(name) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      [spice.id, `${name[0].toUpperCase()}${name.slice(1)}`, `${name}@till.invalid`, hash]);
    return { id: Number(user.id), name: `${name[0].toUpperCase()}${name.slice(1)}`, token: await login(`${name}@till.invalid`) };
  }
  async function give(biz, who, template) {
    const role = (await request('GET', `/businesses/${biz.id}/roles?limit=100`)).items.find((r) => r.template_code === template);
    await request('POST', `/businesses/${biz.id}/members`, { userId: who.id, roleId: role.id }, 201);
  }
  const ravi = await person('ravi');
  const sita = await person('sita');
  const manju = await person('manju');
  const farhan = await person('farhan');
  await give(grocery, ravi, 'cashier');
  await give(grocery, sita, 'cashier');
  await give(grocery, manju, 'manager');
  await give(fashion, farhan, 'cashier');

  // The kirana's goods: dal by the piece (5%, MRP), sugar by weight (5%),
  // detergent in boxes of 12 (18%), milk kept by batch (5%), biscuits at 18%
  // and their twin already at 5% (for the midnight change), and a cleaning
  // liquid kept for use in the shop only.
  const item = async (biz, body) => request('POST', `/businesses/${biz.id}/catalog`, { kind: 'goods', tracking: 'quantity', ...body }, 201);
  const dal = await item(grocery, { name: 'Toor dal 1 kg', code: 'DAL1', barcode: '8901234500017', unit: 'each', price: '165', taxRate: '5', mrp: '180', hsnCode: '0713' });
  const sugar = await item(grocery, { name: 'Sugar loose', code: 'SUGAR', unit: 'kg', price: '48', taxRate: '5', hsnCode: '1701' });
  const surf = await item(grocery, { name: 'Detergent 1 kg', code: 'DET1', unit: 'each', price: '145.50', taxRate: '18', mrp: '175', hsnCode: '3402' });
  const milk = await item(grocery, { name: 'Milk 500 ml', code: 'MILK', unit: 'each', price: '29', taxRate: '5', tracking: 'batch', hsnCode: '0401' });
  const biscuit = await item(grocery, { name: 'Cream biscuit', code: 'BISC', unit: 'each', price: '35', taxRate: '18', hsnCode: '1905' });
  const biscuitAt5 = await item(grocery, { name: 'Cream biscuit (5%)', code: 'BISC5', unit: 'each', price: '35', taxRate: '5', hsnCode: '1905' });
  const cleaner = await item(grocery, { name: 'Floor cleaner (shop use)', code: 'CLEAN', unit: 'each', price: '90', taxRate: '18', internalUse: true });
  await request('POST', G('pack-sizes'), { skuId: surf.id, unitCode: 'box', quantityInBase: '12' }, 201);
  const supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Sri Lakshmi Traders' }, 201);
  await request('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: gloc.id, contactId: supplier.id, lines: [
    { skuId: dal.id, quantity: '40', unitPrice: '130' }, { skuId: sugar.id, quantity: '100', unitPrice: '40' }, { skuId: surf.id, quantity: '24', unitPrice: '110' },
    { skuId: milk.id, quantity: '3', unitPrice: '24', lotCode: 'M-EARLY', expiresOn: addDays(today(), 2) },
    { skuId: milk.id, quantity: '5', unitPrice: '24', lotCode: 'M-LATE', expiresOn: addDays(today(), 5) },
    { skuId: biscuit.id, quantity: '50', unitPrice: '25' }, { skuId: biscuitAt5.id, quantity: '50', unitPrice: '25' },
  ] }, 201);
  const ramesh = await request('POST', G('contacts'), { kind: 'customer', name: 'Ramesh Gowda', phone: '9845012345', creditLimit: '2000' }, 201);
  const hotel = await request('POST', G('contacts'), { kind: 'customer', name: 'Sagar Hotel', phone: '9845054321' }, 201);

  // --- The application ---------------------------------------------------------------------

  await t.test('the application is sold for the counter shops, off by default, with its permissions and roles', async () => {
    const module = await one("SELECT kind FROM platform_modules WHERE code='offline_till'");
    assert.equal(module.kind, 'optional');
    const types = (await all("SELECT business_type FROM platform_module_business_types WHERE module_code='offline_till' AND NOT enabled_by_default ORDER BY 1")).map((r) => r.business_type);
    assert.deepEqual(types, ['books', 'electronics', 'fashion', 'general_retail', 'grocery', 'hardware', 'meat', 'supermarket', 'weight_retail']);
    assert.deepEqual(await one("SELECT sold_as,monthly_price,yearly_price FROM platform_module_prices WHERE module_code='offline_till'"),
      { sold_as: 'application', monthly_price: '199.00', yearly_price: '1999.00' });
    assert.deepEqual((await all("SELECT requires_module_code FROM platform_module_dependencies WHERE module_code='offline_till'")).map((r) => r.requires_module_code), ['sales']);
    const grants = await all(`SELECT template_code,array_agg(permission_code ORDER BY permission_code) AS codes FROM business_role_template_permissions
      WHERE permission_code LIKE 'offline_till.%' GROUP BY template_code ORDER BY template_code`);
    assert.deepEqual(grants.map((g) => [g.template_code, g.codes]), [
      ['accountant', ['offline_till.review', 'offline_till.view']],
      ['manager', ['offline_till.manage', 'offline_till.review', 'offline_till.view']],
      ['viewer', ['offline_till.view']],
    ]);
    // Off until the owner switches it on; a pharmacy cannot have it.
    assert.equal((await refusal('GET', G('till/devices'), undefined, owner, 403)).message, 'Offline till is not switched on for this business. An owner can turn it on in Settings › Business tools.');
    await refusal('PUT', `/businesses/${pharmacy.id}/modules/offline_till`, { enabled: true }, owner, 409);
    await request('PUT', G('modules/offline_till'), { enabled: true });
    await request('PUT', F('modules/offline_till'), { enabled: true });
    // The manager's copy of the template has the new codes; a cashier's has none.
    const managerContext = await as(manju.token)('GET', G('context'));
    assert.ok(['offline_till.view', 'offline_till.manage', 'offline_till.review'].every((code) => managerContext.permissions.includes(code)));
    const cashierContext = await as(ravi.token)('GET', G('context'));
    assert.ok(!cashierContext.permissions.some((code) => code.startsWith('offline_till.')));
  });

  // --- Tills -------------------------------------------------------------------------------

  let tillOne, tillTwo, tokenOne, tokenTwo;
  await t.test('a manager sets up tills on the counter; a cashier cannot; each gets the next code and a secret kept on the device', async () => {
    await refusal('POST', G('till/devices'), { name: 'Counter 1', locationId: gloc.id }, ravi.token, 403);
    await refusal('POST', G('till/devices'), { name: '  ', locationId: gloc.id }, manju.token, 400);
    const first = await as(manju.token)('POST', G('till/devices'), { name: 'Counter 1', locationId: gloc.id }, 201);
    assert.equal(first.device.code, 'T1');
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.device.registered_by_name, 'Manju');
    // Only its hash is kept.
    const stored = await one('SELECT token_hash FROM business_devices WHERE id=$1', [first.device.id]);
    assert.equal(stored.token_hash, crypto.createHash('sha256').update(first.token).digest('hex'));
    const second = await as(manju.token)('POST', G('till/devices'), { name: 'Counter 2', locationId: gloc.id }, 201);
    assert.equal(second.device.code, 'T2');
    [tillOne, tillTwo, tokenOne, tokenTwo] = [first.device, second.device, first.token, second.token];
    const renamed = await as(manju.token)('PATCH', G(`till/devices/${tillTwo.id}`), { name: 'Billing desk' });
    assert.equal(renamed.name, 'Billing desk');
    const listed = await as(manju.token)('GET', G('till/devices'));
    assert.deepEqual(listed.items.map((d) => [d.code, d.name, d.status]), [['T1', 'Counter 1', 'online'], ['T2', 'Billing desk', 'online']]);
    assert.deepEqual(listed.settings, { warnHours: 12, stopHours: 72, waitingCap: 2000, upiId: null, upiPayee: null });
    // The limits and the till's UPI ID.
    await refusal('PUT', G('till/settings'), { warnHours: 80, stopHours: 72 }, manju.token, 400);
    await refusal('PUT', G('till/settings'), { upiId: 'not a vpa' }, manju.token, 400);
    const saved = await as(manju.token)('PUT', G('till/settings'), { warnHours: 12, stopHours: 72, waitingCap: 2000, upiId: 'ganeshkirana@okaxis', upiPayee: 'Ganesh Kirana' });
    assert.equal(saved.upiId, 'ganeshkirana@okaxis');
    const audit = await all("SELECT action FROM business_audit WHERE business_id=$1 AND action LIKE 'till.%' ORDER BY id", [grocery.id]);
    assert.deepEqual(audit.map((a) => a.action), ['till.registered', 'till.registered', 'till.renamed', 'till.settings_changed']);
  });

  const till = (token) => ({ 'X-Till-Token': token });

  // --- The snapshot --------------------------------------------------------------------------

  let kept, priceChangedAt;
  await t.test('the snapshot: what the till may sell, what it may not, customers and their balances, with stamps and deltas', async () => {
    assert.equal((await refusal('GET', G('till/snapshot'), undefined, ravi.token, 409)).reason, 'till_unknown');
    assert.equal((await refusal('GET', G('till/snapshot'), undefined, ravi.token, 409, till('x'.repeat(43)))).reason, 'till_unknown');
    // Another business's till is unknown here.
    const answer = await as(ravi.token, till(tokenOne))('GET', G('till/snapshot'));
    assert.equal(answer.till.code, 'T1');
    assert.equal(answer.settings.taxMode, 'inclusive');
    assert.equal(answer.settings.rounding, 'nearest_rupee');
    assert.equal(answer.settings.upiId, 'ganeshkirana@okaxis');
    assert.equal(answer.settings.cashLimit, '200000.00');
    assert.equal(answer.settings.einvoicing, false);
    assert.equal(answer.location.id, Number(gloc.id));
    const codes = answer.items.rows.map((row) => row.code).sort();
    assert.deepEqual(codes, ['BISC', 'BISC5', 'DAL1', 'DET1', 'MILK', 'SUGAR']);
    assert.deepEqual(answer.items.excluded.map((row) => [row.code, row.reason]), [['CLEAN', 'internal']]);
    const det = answer.items.rows.find((row) => row.code === 'DET1');
    assert.deepEqual(det.packs, [{ unit: 'box', quantity: 12 }]);
    assert.equal(answer.customers.rows.length, 2);
    assert.deepEqual(answer.customers.balances.map((b) => b.balance), ['0.00', '0.00']);
    kept = snapshots.mergeSnapshot(null, answer);
    // Nothing changed: the stamps hold and nothing moved.
    const same = await as(ravi.token, till(tokenOne))('GET', `${G('till/snapshot')}?${new URLSearchParams(snapshots.snapshotQuery(kept))}`);
    assert.equal(same.items.unchanged, true);
    assert.equal(same.customers.unchanged, true);
    assert.deepEqual(same.customers.balances, []);
    // A credit sale to Ramesh online: only his balance comes, as a delta.
    await as(ravi.token)('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: gloc.id, contactId: ramesh.id, channel: 'counter',
      lines: [{ skuId: dal.id, quantity: '2' }] }, 201);
    const moved = await as(ravi.token, till(tokenOne))('GET', `${G('till/snapshot')}?${new URLSearchParams(snapshots.snapshotQuery(kept))}`);
    assert.deepEqual(moved.customers.balances, [{ id: Number(ramesh.id), balance: '330.00' }]);
    kept = snapshots.mergeSnapshot(kept, moved);
    assert.equal(kept.customers.find((c) => c.id === Number(ramesh.id)).balance, '330.00');
    assert.equal(kept.items.length, 6);
    // A price change: the items come again.
    await pool.query('UPDATE catalog_skus SET price=46 WHERE business_id=$1 AND id=$2', [grocery.id, sugar.id]);
    // When the price changed, by the database's own clock (its price history), so
    // a bill dated just before it falls after the item was made however fast this runs.
    priceChangedAt = new Date((await one('SELECT max(changed_at) AS at FROM business_price_history WHERE business_id=$1 AND sku_id=$2 AND location_id IS NULL',
      [grocery.id, sugar.id])).at);
    const repriced = await as(ravi.token, till(tokenOne))('GET', `${G('till/snapshot')}?${new URLSearchParams(snapshots.snapshotQuery(kept))}`);
    assert.equal(repriced.items.unchanged, undefined);
    assert.equal(repriced.items.rows.find((row) => row.code === 'SUGAR').listPrice, '46.00');
    kept = snapshots.mergeSnapshot(kept, repriced);
    // The till's codes: a barcode, an item code, a left-out item.
    assert.equal(snapshots.findCode(kept, '8901234500017').item.code, 'DAL1');
    assert.equal(snapshots.findCode(kept, 'det1').item.code, 'DET1');
    assert.equal(snapshots.findCode(kept, 'CLEAN').excluded.reason, 'internal');
  });

  // --- The till's arithmetic is the server's ------------------------------------------------

  // Prices cart after cart on the till (tillPricing.js) and by the server's
  // quote, and finds every line and every total the same.
  async function compare(biz, token, label, cart, { day = today(), twin = null, fullAccess = false } = {}) {
    const snap = snapshots.mergeSnapshot(null, await as(token, till(biz.token))('GET', `/businesses/${biz.id}/till/snapshot`));
    const local = pricing.priceBill(snap, cart, { day, fullAccess });
    assert.equal(local.ok, true, `${label}: ${JSON.stringify(local.problems)}`);
    const quoted = await as(token)('POST', `/businesses/${biz.id}/retail/quote`, {
      locationId: biz.locationId, contactId: cart.contactId || null,
      lines: (twin || cart.lines).map((line) => ({ skuId: line.skuId, quantity: line.quantity, ...(line.unit ? { unit: line.unit } : {}), ...(line.lotCode ? { lotCode: line.lotCode } : {}) })),
      ...(cart.discount ? { discount: cart.discount } : {}),
    });
    assert.deepEqual(local.lines.map((line) => [money(line.amount), money(line.discount), money(line.net), money(line.tax), Number(line.taxRate).toFixed(2), Number(line.unitPrice).toFixed(2)]),
      quoted.lines.map((line) => [line.amount, line.discount, line.net, line.tax, Number(line.taxRate).toFixed(2), line.unitPrice]), `${label}: lines`);
    assert.deepEqual([money(local.subtotal), money(local.tax), money(local.roundOff), money(local.total)], [quoted.subtotal, quoted.tax, quoted.roundOff, quoted.total], `${label}: totals`);
    return local;
  }

  await t.test('the till prices every cart as the server does: inclusive and exclusive, rounding, packs, weights, discounts, several rates, a rate changing at midnight', async () => {
    const kirana = { id: grocery.id, locationId: gloc.id, token: tokenOne };
    const carts = [
      ['one piece', { lines: [{ skuId: dal.id, quantity: '1' }] }],
      ['weighed', { lines: [{ skuId: sugar.id, quantity: '0.375' }, { skuId: sugar.id, quantity: '1.250' }] }],
      ['grams', { lines: [{ skuId: sugar.id, quantity: '750', unit: 'g' }] }],
      ['a box of twelve', { lines: [{ skuId: surf.id, quantity: '2', unit: 'box' }, { skuId: surf.id, quantity: '3' }] }],
      ['several rates', { lines: [{ skuId: dal.id, quantity: '3' }, { skuId: surf.id, quantity: '1' }, { skuId: biscuit.id, quantity: '7' }, { skuId: milk.id, quantity: '2', lotCode: 'M-EARLY' }] }],
      ['₹ off', { lines: [{ skuId: dal.id, quantity: '2' }, { skuId: surf.id, quantity: '1' }, { skuId: sugar.id, quantity: '2.5' }], discount: { amount: '17.35', reason: 'Regular customer' } }],
      ['% off', { lines: [{ skuId: biscuit.id, quantity: '9' }, { skuId: dal.id, quantity: '1' }], discount: { percent: '7.5', reason: 'Festival' } }],
      ['udhaar customer', { contactId: ramesh.id, lines: [{ skuId: milk.id, quantity: '1', lotCode: 'M-LATE' }, { skuId: sugar.id, quantity: '0.9' }] }],
    ];
    for (const [label, cart] of carts) await compare(kirana, manju.token, `inclusive, rounded: ${label}`, cart);
    // Prices before GST, no rounding.
    await pool.query("UPDATE business_settings SET tax_mode='exclusive',rounding='none' WHERE business_id=$1", [grocery.id]);
    for (const [label, cart] of carts) await compare(kirana, manju.token, `exclusive, not rounded: ${label}`, cart);
    // Prices before GST, rounded to the rupee.
    await pool.query("UPDATE business_settings SET rounding='nearest_rupee' WHERE business_id=$1", [grocery.id]);
    for (const [label, cart] of carts) await compare(kirana, manju.token, `exclusive, rounded: ${label}`, cart);
    await pool.query("UPDATE business_settings SET tax_mode='inclusive',rounding='nearest_rupee' WHERE business_id=$1", [grocery.id]);
    // A branch's own price, and a member's price (loyalty on).
    await request('PUT', G(`catalog/${dal.id}/branch-prices`), { prices: [{ locationId: gloc.id, price: '160' }] });
    await compare(kirana, ravi.token, 'this branch\'s price', { lines: [{ skuId: dal.id, quantity: '2' }] });
    await pool.query('UPDATE catalog_skus SET member_price=139 WHERE business_id=$1 AND id=$2', [grocery.id, surf.id]);
    await request('PUT', G('modules/loyalty'), { enabled: true });
    await compare(kirana, ravi.token, 'a member\'s price', { contactId: hotel.id, lines: [{ skuId: surf.id, quantity: '2' }, { skuId: dal.id, quantity: '1' }] });
    await compare(kirana, ravi.token, 'a walk-in pays the shelf price', { lines: [{ skuId: surf.id, quantity: '2' }] });
    // The owner may give more than the counter's limit; a cashier may not (the till refuses it as the server does).
    await compare(kirana, owner, 'the owner\'s discount above the limit', { lines: [{ skuId: dal.id, quantity: '4' }], discount: { percent: '15', reason: 'Old friend' } }, { fullAccess: true });
    const snap = snapshots.mergeSnapshot(null, await as(ravi.token, till(tokenOne))('GET', G('till/snapshot')));
    const over = pricing.priceBill(snap, { lines: [{ skuId: dal.id, quantity: '4' }], discount: { percent: '15', reason: 'Old friend' } }, { day: today() });
    assert.equal(over.ok, false);
    assert.match(over.problems[0].message, /At most 10% of a bill/);
    // A GST change from tomorrow: tomorrow the till charges the new rate, as the server charges an item already at it.
    const fivePercent = (await request('GET', G('tax-rates?limit=100'))).items.find((r) => Number(r.rate) === 5);
    await request('POST', G('tax-changes'), { requestKey: key(), startsOn: addDays(today(), 1), keeps: 'total', taxRateId: fivePercent.id, reason: 'GST Council notification', items: [biscuit.id] }, 201);
    const lines = [{ skuId: biscuit.id, quantity: '6' }, { skuId: dal.id, quantity: '1' }];
    await compare(kirana, ravi.token, 'the day before the change', { lines });
    await compare(kirana, ravi.token, 'from the change\'s day', { lines }, { day: addDays(today(), 1), twin: [{ skuId: biscuitAt5.id, quantity: '6' }, { skuId: dal.id, quantity: '1' }] });
  });

  await t.test('a clothes shop\'s GST by price: the till works out each piece\'s rate as the server does', async () => {
    await one(`INSERT INTO fashion_gst_price_slabs(business_id,active,threshold,rate_low,rate_high) VALUES($1,TRUE,2500,5,18)
      ON CONFLICT(business_id) DO UPDATE SET active=TRUE,threshold=2500,rate_low=5,rate_high=18 RETURNING business_id`, [fashion.id]);
    const product = await request('POST', F('catalog'), { kind: 'goods', tracking: 'quantity', name: 'Cotton kurta', code: 'KURTA', unit: 'each', price: '2599', taxRate: '5', hsnCode: '6211' }, 201);
    const shirt = await request('POST', F('catalog'), { kind: 'goods', tracking: 'quantity', name: 'Linen shirt', code: 'SHIRT', unit: 'each', price: '1499', taxRate: '5', hsnCode: '6205' }, 201);
    await pool.query('INSERT INTO fashion_variants(business_id,product_id,sku_id,style,size,colour) VALUES($1,$2,$3,$4,$5,$6),($1,$7,$8,$9,$10,$11)',
      [fashion.id, product.product_id, product.id, 'Kurta', 'M', 'Blue', shirt.product_id, shirt.id, 'Shirt', 'L', 'White']).catch(() => null);
    const shop = await as(manju.token)('GET', F('till/devices')).catch(() => null);
    assert.equal(shop, null);
    const device = await request('POST', F('till/devices'), { name: 'Front counter', locationId: floc.id }, 201);
    const boutique = { id: fashion.id, locationId: floc.id, token: device.token };
    await compare(boutique, farhan.token, 'above and below the price', { lines: [{ skuId: product.id, quantity: '1' }, { skuId: shirt.id, quantity: '2' }] });
    await compare(boutique, owner, 'a discount bringing a kurta under the price', { lines: [{ skuId: product.id, quantity: '1' }], discount: { amount: '200', reason: 'Fault on the hem' } }, { fullAccess: true });
  });

  // --- Bills sent later --------------------------------------------------------------------

  const tz = 'Asia/Kolkata';
  const fresh = async (tillToken) => snapshots.mergeSnapshot(null, await as(ravi.token, till(tillToken))('GET', G('till/snapshot')));
  // A bill as the till makes it: priced by tillPricing.js on its snapshot (or a
  // copy of it as it stood then), numbered in its series, made at `madeAt`.
  function billOf(snap, { code = 'T1', seq, madeAt = new Date().toISOString(), madeBy = ravi.id, cart, pay = 'cash', kind = 'bill', year, offlineSince = null, pinRule = false, voidReason }) {
    const day = appRules.dayOf(madeAt, tz);
    const priced = pricing.priceBill(snap, cart, { day });
    assert.equal(priced.ok, true, JSON.stringify(priced.problems));
    const fy = year ?? appRules.fiscalYearOf(day, 4);
    const total = money(priced.total);
    const payments = pay === 'cash' ? [{ method: 'cash', amount: total }] : typeof pay === 'function' ? pay(priced.total) : pay;
    return {
      requestKey: key(), kind, number: appRules.billNumber(code, fy, seq), madeAt, madeBy, offlineSince, pinRule, total, contactId: cart.contactId || null,
      lines: priced.lines.map((line) => ({ skuId: line.skuId, quantity: line.enteredUnit ? String(line.enteredQuantity) : String(line.quantity), ...(line.enteredUnit ? { unit: line.enteredUnit } : {}),
        unitPrice: String(line.unitPrice), packPrice: line.packPrice === null ? null : money(line.packPrice), priceKind: line.priceKind, taxRate: line.taxRate, label: line.label })),
      ...(cart.discount ? { discount: cart.discount } : {}),
      ...(kind === 'bill' ? { payments } : { void: { reason: voidReason } }),
    };
  }
  const send = (token, tillToken, body, expected = 201) => as(token, till(tillToken))('POST', G('till/bills'), body, expected);
  const sendRefused = async (token, tillToken, body, status) => refusal('POST', G('till/bills'), body, token, status, till(tillToken));
  const rice = await item(grocery, { name: 'Sona masoori rice 25 kg', code: 'RICE25', unit: 'each', price: '1500', taxRate: '5', hsnCode: '1006' });
  await request('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: gloc.id, contactId: supplier.id, lines: [{ skuId: rice.id, quantity: '300', unitPrice: '1200' }] }, 201);

  let shift, first;
  await t.test('bills sent later are posted as they were made: the till\'s number, time, maker, prices; the sender recorded', async () => {
    shift = await as(ravi.token)('POST', G('shifts'), { locationId: gloc.id, openingCash: '1000' }, 201);
    const snap = await fresh(tokenOne);
    // Made inside Ravi's shift, a moment after it opened.
    const madeAt = new Date(new Date(shift.opened_at).getTime() + 5).toISOString();
    const body = billOf(snap, { seq: 1, madeAt, cart: { lines: [{ skuId: dal.id, quantity: '2' }, { skuId: sugar.id, quantity: '1.5' }] } });
    // Made by Ravi, sent from Sita's session on the same till.
    first = await send(sita.token, tokenOne, body);
    assert.equal(first.billNo, `T1/${appRules.fiscalLabel(appRules.fiscalYearOf(appRules.dayOf(madeAt, tz), 4))}/00001`);
    assert.deepEqual(first.flags, []);
    const doc = await one('SELECT * FROM business_documents WHERE id=$1', [first.documentId]);
    assert.equal(doc.document_no, first.billNo);
    assert.equal(new Date(doc.created_at).toISOString(), madeAt);
    assert.equal(Number(doc.created_by), ravi.id);
    assert.equal(doc.total, body.total);
    const payment = await one('SELECT * FROM business_payments WHERE document_id=$1', [doc.id]);
    assert.equal(new Date(payment.created_at).toISOString(), madeAt);
    assert.equal(Number(payment.created_by), ravi.id);
    const row = await one('SELECT * FROM business_till_bills WHERE id=$1', [first.id]);
    assert.deepEqual([Number(row.made_by), Number(row.sent_by)], [ravi.id, sita.id]);
    const series = await one('SELECT * FROM business_number_series WHERE id=$1', [doc.series_id]);
    assert.deepEqual([Number(series.device_id), series.prefix, Number(series.next_number), series.padding], [Number(tillOne.id), first.billNo.slice(0, 8), 2, 5]);
    // The lines keep the till's prices and rates.
    const lines = await all('SELECT unit_price,tax_rate,quantity FROM business_document_lines WHERE document_id=$1 ORDER BY id', [doc.id]);
    assert.deepEqual(lines.map((l) => [l.unit_price, l.tax_rate]), [['160.00', '5.00'], ['46.00', '5.00']]);
    // The cashier's shift counts its cash, at its own time.
    const current = await as(ravi.token)('GET', G(`shifts/current?location=${gloc.id}`));
    assert.equal(current.movement_so_far, body.total);
    // The audit: the sale is Ravi's, its arrival Sita's.
    const posted = await one("SELECT actor_id FROM business_audit WHERE business_id=$1 AND action='sale.posted' AND entity_id=$2", [grocery.id, doc.id]);
    assert.equal(Number(posted.actor_id), ravi.id);
    const received = await one("SELECT actor_id FROM business_audit WHERE business_id=$1 AND action='till_bill.received' AND entity_id=$2", [grocery.id, first.id]);
    assert.equal(Number(received.actor_id), sita.id);
    // Sent again with its key: the same answer; its key with other content: refused.
    const again = await send(ravi.token, tokenOne, body);
    assert.deepEqual(again, first);
    assert.equal((await sendRefused(ravi.token, tokenOne, { ...body, total: '1.00' }, 409)).message, 'This request key was already used for different data');
  });

  await t.test('cash, UPI, split and udhaar within the limit; a payment method switched off since keeps its name', async () => {
    const snap = await fresh(tokenOne);
    const methods = await request('GET', G('payment-methods'));
    const upi = (Array.isArray(methods) ? methods : methods.items).find((m) => m.kind === 'upi');
    const split = billOf(snap, { seq: 2, cart: { lines: [{ skuId: surf.id, quantity: '1', unit: 'box' }] },
      pay: (total) => [{ method: 'cash', amount: money(50000), tendered: money(50000) }, { methodId: upi.id, method: 'upi', amount: money(total - 50000), reference: 'UTR 4521' }] });
    const answer = await send(ravi.token, tokenOne, split);
    const pays = await all('SELECT method,method_name,amount FROM business_payments WHERE document_id=$1 ORDER BY id', [answer.documentId]);
    assert.deepEqual(pays.map((p) => p.method), ['cash', 'upi']);
    // Udhaar: Ramesh pays part, the rest within his limit.
    const udhaar = billOf(snap, { seq: 3, cart: { contactId: ramesh.id, lines: [{ skuId: dal.id, quantity: '5' }] }, pay: [{ method: 'cash', amount: '100.00' }] });
    const credit = await send(ravi.token, tokenOne, udhaar);
    assert.deepEqual(credit.flags, []);
    // UPI switched off after the bill was made: still recorded, by its kind and name.
    await request('PATCH', G(`payment-methods/${upi.id}`), { name: upi.name, active: false });
    const late = billOf(snap, { seq: 4, cart: { lines: [{ skuId: biscuit.id, quantity: '2' }] }, pay: (total) => [{ methodId: upi.id, method: 'upi', amount: money(total) }] });
    const recorded = await send(ravi.token, tokenOne, late);
    assert.deepEqual(await one('SELECT method,method_name FROM business_payments WHERE document_id=$1', [recorded.documentId]), { method: 'upi', method_name: upi.name });
    await request('PATCH', G(`payment-methods/${upi.id}`), { name: upi.name, active: true });
  });

  await t.test('number rules: the till\'s own series, its year, each number once; gaps recorded and filled; a void keeps its number', async () => {
    const snap = await fresh(tokenOne);
    const cart = { lines: [{ skuId: biscuit.id, quantity: '1' }] };
    assert.equal((await sendRefused(ravi.token, tokenOne, billOf(snap, { code: 'T2', seq: 1, cart }), 409)).reason, 'number_not_till');
    const fy = appRules.fiscalYearOf(today(), 4);
    assert.equal((await sendRefused(ravi.token, tokenOne, billOf(snap, { seq: 9, cart, year: fy - 1 }), 409)).reason, 'number_year');
    assert.equal((await sendRefused(ravi.token, tokenOne, billOf(snap, { seq: 1, cart }), 409)).reason, 'number_used');
    // Number 7 arrives before 5 and 6: they are gaps until they come.
    const seventh = await send(ravi.token, tokenOne, billOf(snap, { seq: 7, cart }));
    assert.ok(seventh.billNo.endsWith('00007'));
    const gaps = await all('SELECT bill_no,state FROM business_till_gaps WHERE business_id=$1 ORDER BY seq', [grocery.id]);
    assert.deepEqual(gaps.map((g) => [g.bill_no.slice(-5), g.state]), [['00005', 'missing'], ['00006', 'missing']]);
    await send(ravi.token, tokenOne, billOf(snap, { seq: 5, cart }));
    // Number 6 was voided on the till: it comes as a void, with no bill, no stock and no money.
    const stockBefore = await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [grocery.id, biscuit.id]);
    const voided = await send(ravi.token, tokenOne, billOf(snap, { seq: 6, cart: { contactId: hotel.id, lines: [{ skuId: biscuit.id, quantity: '3' }] }, kind: 'void', voidReason: 'Customer changed their mind' }));
    assert.equal(voided.kind, 'void');
    assert.equal(voided.documentId, null);
    assert.equal((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [grocery.id, biscuit.id])).q, stockBefore.q);
    assert.deepEqual((await all('SELECT state FROM business_till_gaps WHERE business_id=$1 ORDER BY seq', [grocery.id])).map((g) => g.state), ['arrived', 'arrived']);
    const series = await one('SELECT next_number FROM business_number_series WHERE business_id=$1 AND device_id=$2', [grocery.id, tillOne.id]);
    assert.equal(Number(series.next_number), 8);
    assert.equal((await sendRefused(ravi.token, tokenOne, billOf(snap, { seq: 8, cart, kind: 'void' }), 400)).message, 'Why it was voided is required');
    // A location's own series may not take a till's prefix.
    await refusal('POST', G('number-series'), { locationId: gloc.id, documentKind: 'sale', fiscalYear: fy + 1, prefix: `T1/${appRules.fiscalLabel(fy + 1)}/` }, owner, 409);
  });

  await t.test('a new financial year: the till starts its year\'s series at 1, made on the server with the first bill', async () => {
    const snap = await fresh(tokenTwo);
    const cart = { lines: [{ skuId: biscuitAt5.id, quantity: '1' }] };
    // 31 March 23:50 and 1 April 00:10 on the business's clock (before the till was set up: flagged for its time).
    const march = await send(sita.token, tokenTwo, billOf(snap, { code: 'T2', seq: 1, madeAt: '2026-03-31T18:20:00.000Z', madeBy: sita.id, cart }));
    const april = await send(sita.token, tokenTwo, billOf(snap, { code: 'T2', seq: 1, madeAt: '2026-03-31T18:40:00.000Z', madeBy: sita.id, cart }));
    assert.deepEqual([march.billNo, april.billNo], ['T2/2526/00001', 'T2/2627/00001']);
    assert.ok(march.flags.includes('time'));
    const series = await all('SELECT prefix,fiscal_year FROM business_number_series WHERE business_id=$1 AND device_id=$2 ORDER BY fiscal_year', [grocery.id, tillTwo.id]);
    assert.deepEqual(series.map((s) => [s.prefix, s.fiscal_year]), [['T2/2526/', 2025], ['T2/2627/', 2026]]);
    // The bill of 31 March is in March's sales; April's in April's (the GST month follows the bill's own time).
    const report = await request('GET', G('reports?from=2026-03-31&to=2026-04-01'));
    assert.deepEqual(report.rows.filter((r) => r.kind === 'sale').map((r) => [r.day, r.entries]), [['2026-04-01', 1], ['2026-03-31', 1]]);
  });

  await t.test('what the till could not know is flagged, never refused: price, GST rate, credit, stock, time, PIN, discount, maker', async () => {
    const snap = await fresh(tokenOne);
    // Sugar at 48 before its price changed: in force then, no flag; at 48 now: flagged, and the billed price stands.
    const then = structuredClone(snap);
    then.items.find((row) => row.id === Number(sugar.id)).listPrice = '48.00';
    const before = await send(ravi.token, tokenOne, billOf(then, { seq: 10, madeAt: new Date(priceChangedAt.getTime() - 1).toISOString(), cart: { lines: [{ skuId: sugar.id, quantity: '1' }] } }));
    assert.deepEqual(before.flags, []);
    const stale = await send(ravi.token, tokenOne, billOf(then, { seq: 11, cart: { lines: [{ skuId: sugar.id, quantity: '1' }] } }));
    assert.deepEqual(stale.flags, ['price']);
    assert.equal((await one('SELECT unit_price FROM business_document_lines WHERE document_id=$1', [stale.documentId])).unit_price, '48.00');
    // Biscuits at 5% today, before their change's day: the rate is flagged.
    const early = structuredClone(snap);
    early.items.find((row) => row.id === Number(biscuit.id)).taxRate = '5.00';
    assert.deepEqual((await send(ravi.token, tokenOne, billOf(early, { seq: 12, cart: { lines: [{ skuId: biscuit.id, quantity: '2' }] } }))).flags, ['rate']);
    // Ramesh over his limit, as the till could not see.
    await as(ravi.token)('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: gloc.id, contactId: ramesh.id, channel: 'counter', lines: [{ skuId: dal.id, quantity: '6' }] }, 201);
    const over = await send(ravi.token, tokenOne, billOf(snap, { seq: 13, cart: { contactId: ramesh.id, lines: [{ skuId: dal.id, quantity: '3' }] }, pay: [] }));
    assert.deepEqual(over.flags, ['credit']);
    // Milk: 10 sold, 8 held (3 + 5, earliest expiry first); 2 short, and no stock below zero.
    const milky = await send(ravi.token, tokenOne, billOf(snap, { seq: 14, cart: { lines: [{ skuId: milk.id, quantity: '10' }] } }));
    assert.deepEqual(milky.flags, ['stock']);
    assert.equal(milky.shortfalls, 1);
    const lots = await all('SELECT lot_code,quantity FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 ORDER BY lot_code', [grocery.id, milk.id]);
    assert.deepEqual(lots.map((l) => [l.lot_code, l.quantity]), [['M-EARLY', '0.000'], ['M-LATE', '0.000']]);
    const moves = await all('SELECT quantity FROM business_stock_movements WHERE business_id=$1 AND document_id=$2 ORDER BY id', [grocery.id, milky.documentId]);
    assert.deepEqual(moves.map((m) => m.quantity), ['-3.000', '-5.000']);
    assert.equal((await one('SELECT lot_code FROM business_document_lines WHERE document_id=$1', [milky.documentId])).lot_code, 'M-EARLY');
    assert.equal((await one('SELECT quantity FROM business_till_shortfalls WHERE document_id=$1', [milky.documentId])).quantity, '2.000');
    // Made "in the future" by a clock ahead; with no PIN where every bill asks for one.
    const ahead = await send(ravi.token, tokenOne, billOf(snap, { seq: 15, madeAt: new Date(Date.now() + 30 * 60000).toISOString(), cart: { lines: [{ skuId: biscuit.id, quantity: '1' }] } }));
    assert.deepEqual(ahead.flags, ['time']);
    await pool.query('UPDATE business_settings SET counter_pin_every_bill=TRUE WHERE business_id=$1', [grocery.id]);
    assert.deepEqual((await send(ravi.token, tokenOne, billOf(snap, { seq: 16, pinRule: true, cart: { lines: [{ skuId: biscuit.id, quantity: '1' }] } }))).flags, ['no_pin']);
    await pool.query('UPDATE business_settings SET counter_pin_every_bill=FALSE WHERE business_id=$1', [grocery.id]);
    // A cashier's discount over today's limit (the limit was lowered after the till allowed it).
    await pool.query('UPDATE business_settings SET max_bill_discount_percent=2 WHERE business_id=$1', [grocery.id]);
    const discounted = await send(ravi.token, tokenOne, billOf(snap, { seq: 17, cart: { lines: [{ skuId: dal.id, quantity: '2' }], discount: { amount: '20', reason: 'Regular' } } }));
    assert.deepEqual(discounted.flags, ['discount']);
    await pool.query('UPDATE business_settings SET max_bill_discount_percent=10 WHERE business_id=$1', [grocery.id]);
    // A maker who no longer works here; someone who never did.
    await pool.query('UPDATE business_memberships SET active=FALSE WHERE business_id=$1 AND user_id=$2', [grocery.id, sita.id]);
    assert.deepEqual((await send(ravi.token, tokenOne, billOf(snap, { seq: 18, madeBy: sita.id, cart: { lines: [{ skuId: biscuit.id, quantity: '1' }] } }))).flags, ['maker']);
    await pool.query('UPDATE business_memberships SET active=TRUE WHERE business_id=$1 AND user_id=$2', [grocery.id, sita.id]);
    assert.equal((await sendRefused(ravi.token, tokenOne, billOf(snap, { seq: 19, madeBy: farhan.id, cart: { lines: [{ skuId: biscuit.id, quantity: '1' }] } }), 409)).reason, 'maker_unknown');
  });

  await t.test('faults are refused for the till to show: a sum off by more than ₹1, an item or customer switched off since, the cash limit on one bill', async () => {
    const snap = await fresh(tokenOne);
    const off = billOf(snap, { seq: 20, cart: { lines: [{ skuId: dal.id, quantity: '1' }] } });
    assert.equal((await sendRefused(ravi.token, tokenOne, { ...off, total: money(paise(off.total) + 300), payments: [{ method: 'cash', amount: money(paise(off.total) + 300) }] }, 409)).reason, 'offline_total');
    // A paisa or two (within ₹1) is posted, flagged.
    const near = billOf(snap, { seq: 20, cart: { lines: [{ skuId: sugar.id, quantity: '0.333' }] } });
    const rounded = await send(ravi.token, tokenOne, { ...near, total: money(paise(near.total) + 1) });
    assert.deepEqual(rounded.flags, ['total']);
    await pool.query('UPDATE catalog_skus SET active=FALSE WHERE business_id=$1 AND id=$2', [grocery.id, biscuitAt5.id]);
    assert.equal((await sendRefused(ravi.token, tokenOne, billOf(snap, { seq: 21, cart: { lines: [{ skuId: biscuitAt5.id, quantity: '1' }] } }), 409)).reason, 'item_off');
    await pool.query('UPDATE catalog_skus SET active=TRUE WHERE business_id=$1 AND id=$2', [grocery.id, biscuitAt5.id]);
    await pool.query('UPDATE business_contacts SET active=FALSE WHERE business_id=$1 AND id=$2', [grocery.id, hotel.id]);
    assert.equal((await sendRefused(ravi.token, tokenOne, billOf(snap, { seq: 21, cart: { contactId: hotel.id, lines: [{ skuId: dal.id, quantity: '1' }] } }), 409)).reason, 'customer_off');
    await pool.query('UPDATE business_contacts SET active=TRUE WHERE business_id=$1 AND id=$2', [grocery.id, hotel.id]);
    // ₹2,00,000 or more in cash on one bill stays refused by the database.
    const big = billOf(snap, { seq: 21, cart: { lines: [{ skuId: rice.id, quantity: '140' }] } });
    const refused = await sendRefused(ravi.token, tokenOne, { ...big, buyer: { panDeclaration: true } }, 409);
    assert.match(refused.message, /Cash of ₹2,00,000 or more cannot be taken for one bill/);
  });

  await t.test('cash from one customer in a day across two tills is flagged, not refused: the money was taken', async () => {
    const one1 = await fresh(tokenOne);
    const two = await fresh(tokenTwo);
    const a = await send(ravi.token, tokenOne, billOf(one1, { seq: 21, cart: { contactId: hotel.id, lines: [{ skuId: rice.id, quantity: '100' }] } }));
    assert.deepEqual(a.flags, []);
    const b = await send(sita.token, tokenTwo, billOf(two, { code: 'T2', seq: 2, madeBy: sita.id, cart: { contactId: hotel.id, lines: [{ skuId: rice.id, quantity: '40' }] } }));
    assert.deepEqual(b.flags, ['cash_limit']);
  });

  await t.test('stock sold short is settled from stock received since, or as a count that was wrong; its flag follows', async () => {
    const short = await one('SELECT * FROM business_till_shortfalls WHERE business_id=$1 AND resolved_at IS NULL', [grocery.id]);
    await refusal('POST', G(`till/shortfalls/${short.id}/resolve`), { how: 'received' }, ravi.token, 403);
    // Nothing received yet: refused, the books never go below zero.
    await refusal('POST', G(`till/shortfalls/${short.id}/resolve`), { how: 'received' }, manju.token, 409);
    await refusal('POST', G(`till/shortfalls/${short.id}/resolve`), { how: 'adjusted' }, manju.token, 400);
    await request('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: gloc.id, contactId: supplier.id,
      lines: [{ skuId: milk.id, quantity: '12', unitPrice: '24', lotCode: 'M-NEW', expiresOn: addDays(today(), 6) }] }, 201);
    await as(manju.token)('POST', G(`till/shortfalls/${short.id}/resolve`), { how: 'received' });
    assert.equal((await one("SELECT quantity FROM business_stock_lots WHERE business_id=$1 AND lot_code='M-NEW'", [grocery.id])).quantity, '10.000');
    const flag = await one("SELECT f.acknowledged_at FROM business_till_flags f JOIN business_till_bills b ON b.id=f.till_bill_id WHERE b.document_id=$1 AND f.kind='stock'", [short.document_id]);
    assert.ok(flag.acknowledged_at);
    await refusal('POST', G(`till/shortfalls/${short.id}/resolve`), { how: 'received' }, manju.token, 409);
    // 12 more sold offline, 10 held: the 2 short were on the shelf all along (a count that was wrong): nothing is taken.
    const snap = await fresh(tokenTwo);
    const more = await send(sita.token, tokenTwo, billOf(snap, { code: 'T2', seq: 3, madeBy: sita.id, cart: { lines: [{ skuId: milk.id, quantity: '12' }] } }));
    assert.deepEqual(more.flags, ['stock']);
    const second = await one('SELECT id FROM business_till_shortfalls WHERE document_id=$1', [more.documentId]);
    const moves = async () => (await one('SELECT count(*)::int AS n FROM business_stock_movements WHERE business_id=$1 AND document_id=$2', [grocery.id, more.documentId])).n;
    const before = await moves();
    const settled = await as(manju.token)('POST', G(`till/shortfalls/${second.id}/resolve`), { how: 'adjusted', note: 'Two packets were in the back fridge, not in the books' });
    assert.equal(settled.resolution, 'adjusted');
    assert.equal(await moves(), before);
    const list = await as(manju.token)('GET', G('till/review/shortfalls?open=false'));
    assert.deepEqual(list.items.map((x) => x.resolution).sort(), ['adjusted', 'received']);
  });

  await t.test('the review: what is open by kind, each flag looked at, numbers noted, voids, GSTR-1 Table 13, and the bell', async () => {
    const summary = await as(manju.token)('GET', G('till/review'));
    assert.ok(summary.to_review >= 8, JSON.stringify(summary));
    assert.ok(summary.byKind.price >= 1 && summary.byKind.credit >= 1);
    const flags = await as(manju.token)('GET', G('till/review/flags?kind=price&open=true'));
    assert.equal(flags.total, 1);
    await refusal('POST', G(`till/flags/${flags.items[0].id}/acknowledge`), {}, ravi.token, 403);
    await as(manju.token)('POST', G(`till/flags/${flags.items[0].id}/acknowledge`), { note: 'Old price on the shelf label; corrected' });
    await refusal('POST', G(`till/flags/${flags.items[0].id}/acknowledge`), {}, manju.token, 409);
    const bills = await as(manju.token)('GET', G('till/review/bills?kind=void'));
    assert.equal(bills.total, 1);
    assert.equal(bills.items[0].void_reason, 'Customer changed their mind');
    // GSTR-1 Table 13 for the period: each till series' first and last number, how many, voided.
    const numbers = await as(manju.token)('GET', G(`till/numbers?from=${today()}&to=${today()}`));
    const t1 = numbers.series.find((row) => row.tillCode === 'T1');
    assert.equal(t1.first.slice(-5), '00001');
    assert.equal(t1.voided, 1);
    // Numbers 8, 9 and 19 were refused (they wait on the till, needing attention): not arrived.
    assert.equal(t1.missing, 3);
    // The bell: bills to review; a cashier's bell says nothing of it.
    const bell = await as(manju.token)('GET', G('notifications'));
    assert.ok(bell.items.some((alert) => /offline bills to review$/.test(alert.title)));
    const cashierBell = await as(ravi.token)('GET', G('notifications'));
    assert.ok(!cashierBell.items.some((alert) => alert.category === 'Offline till'));
  });

  await t.test('a till reports what waits on it: the bell warns after an hour, the shift\'s close warns, retiring is refused until it is sent or the till is lost', async () => {
    const report = await as(ravi.token, till(tokenOne))('POST', G('till/heartbeat'), { pending: 3, attention: 0, oldestMadeAt: new Date(Date.now() - 2 * 3600000).toISOString(),
      offlineSince: new Date(Date.now() - 3 * 3600000).toISOString(), lastNumber: { year: appRules.fiscalYearOf(today(), 4), seq: 25 }, holding: [23, 24, 25], version: 'test' });
    assert.equal(report.device.code, 'T1');
    assert.equal(report.settings.stopHours, 72);
    const bell = await as(manju.token)('GET', G('notifications'));
    assert.ok(bell.items.some((alert) => alert.title === 'Till T1 (Counter 1) has had bills waiting for more than an hour'));
    const current = await as(ravi.token)('GET', G(`shifts/current?location=${gloc.id}`));
    assert.deepEqual(current.tills_waiting, { bills: 3, tills: 1 });
    const waiting = await refusal('POST', G(`till/devices/${tillOne.id}/retire`), { reason: 'Old computer' }, manju.token, 409);
    assert.equal(waiting.reason, 'till_waiting');
    // Lost: its numbers 22 to 25 that never arrived are noted as missing, for the manager to explain.
    const retired = await as(manju.token)('POST', G(`till/devices/${tillOne.id}/retire`), { reason: 'Stolen from the counter', lost: true });
    assert.equal(retired.status, 'retired');
    assert.equal(retired.numbersLost, 4);
    const gaps = await as(manju.token)('GET', G('till/review/gaps?state=missing'));
    assert.deepEqual(gaps.items.map((g) => g.bill_no.slice(-5)).sort(), ['00008', '00009', '00019', '00022', '00023', '00024', '00025']);
    assert.equal(gaps.items.find((g) => g.bill_no.endsWith('00023')).on_till, true);
    await refusal('POST', G(`till/gaps/${gaps.items[0].id}/note`), {}, manju.token, 400);
    await as(manju.token)('POST', G(`till/gaps/${gaps.items[0].id}/note`), { reason: 'Lost with the stolen till' });
    // A retired till's bills are refused, saying why.
    const snap = await fresh(tokenTwo);
    const refused = await sendRefused(ravi.token, tokenOne, billOf(snap, { seq: 26, cart: { lines: [{ skuId: dal.id, quantity: '1' }] } }), 409);
    assert.equal(refused.reason, 'till_retired');
    assert.match(refused.message, /Stolen from the counter/);
    assert.equal((await refusal('GET', G('till/snapshot'), undefined, ravi.token, 409, till(tokenOne))).reason, 'till_retired');
  });

  await t.test('a shift closed while bills waited: the review shows the cash they took, and what the drawer should have held', async () => {
    const closed = await as(ravi.token)('POST', G(`shifts/${shift.id}/close`), { countedCash: '99999', reason: 'Offline bills not sent yet' });
    const snap = await fresh(tokenTwo);
    const made = new Date(new Date(closed.closed_at).getTime() - 1000).toISOString();
    const late = await send(ravi.token, tokenTwo, billOf(snap, { code: 'T2', seq: 4, madeAt: made, cart: { lines: [{ skuId: dal.id, quantity: '1' }] } }));
    const review = await as(manju.token)('GET', G('till/review'));
    const row = review.cash.find((c) => Number(c.id) === Number(shift.id));
    assert.equal(row.arrived_after_close, (await one('SELECT total FROM business_documents WHERE id=$1', [late.documentId])).total);
    assert.equal(row.expected_now, money(paise(closed.expected_cash) + paise(row.arrived_after_close)));
  });

  await t.test('a bill to a GSTIN holder once e-invoicing applies is posted, flagged to report it to the IRP', async () => {
    // The kirana's GSTIN carries its PAN; ₹6 crore of sales last financial year puts e-invoicing on it now.
    await pool.query("UPDATE business_settings SET gstin='29ABCPR1234K1ZJ',state_code='29' WHERE business_id=$1", [grocery.id]);
    const firm = await request('POST', G('contacts'), { kind: 'customer', name: 'Rao Caterers', gstin: '36AAFFR1234L1Z6' }, 201);
    const contract = await item(grocery, { kind: 'service', name: 'Institutional supply contract', code: 'INST', unit: 'service', price: '60000000', taxRate: '0' });
    const sale = await request('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: gloc.id, contactId: firm.id, lines: [{ skuId: contract.id, quantity: '1' }] }, 201);
    await pool.query("UPDATE business_documents SET created_at=now() - interval '400 days' WHERE id=$1", [sale.id]);
    const snap = await fresh(tokenTwo);
    assert.equal(snap.settings.einvoicing, true);
    // The till refuses such a bill offline (tillCounter); one made all the same is posted and flagged.
    const b2b = await send(sita.token, tokenTwo, billOf(snap, { code: 'T2', seq: 5, madeBy: sita.id, cart: { contactId: firm.id, lines: [{ skuId: dal.id, quantity: '1' }] } }));
    assert.deepEqual(b2b.flags, ['einvoice']);
  });

  await t.test('the plan ended: bills wait on the till (402)', async () => {
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [grocery.id]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything) VALUES($1,'trial',business_local_today($1)-30,business_local_today($1)-17,TRUE)`, [grocery.id]);
    const ended = await refusal('POST', G('till/bills'), billOf(kept, { code: 'T2', seq: 6, cart: { lines: [{ skuId: dal.id, quantity: '1' }] } }), sita.token, 402, till(tokenTwo));
    assert.equal(ended.reason, 'plan_ended');
    assert.equal((await refusal('POST', G('till/heartbeat'), { pending: 1 }, sita.token, 402, till(tokenTwo))).reason, 'plan_ended');
  });
});
