const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom } = require('./helpers/dates');

// A jeweller's own tools: the day's rates by purity set by a manager (a
// correction is a new sheet; a bill takes the latest rate of its day). Money
// adds up to the paisa, postings are idempotent, the database keeps its rules,
// audit and events are written, and other types and other owners are kept
// out. Runs on its own throwaway database with every migration applied.
test('jewellery and gold', { timeout: 300000 }, async (t) => {
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
  const password = `Gold-${crypto.randomBytes(8).toString('hex')}`;
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
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const ownerUser = await owner('gold-owner');
  await owner('gold-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('gold-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('gold-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const today = daysFrom(0);

  const [jeweller, grocery, optical] = await createBusinesses(request, 'OWNER', ['jewellery', 'grocery', 'optical']);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['jewellery']);
  const J = (suffix) => `/businesses/${jeweller.id}/${suffix}`;

  await t.test('modules, permissions and roles per type', async () => {
    assert.ok(jeweller.capabilities.includes('jewellery'), 'a jeweller starts with gold rates & jewellery');
    assert.ok(jeweller.capabilities.includes('serials'), 'a jeweller keeps serial numbers from the start: a tag is a piece\'s number');
    for (const business of [grocery, optical]) assert.ok(!business.capabilities.includes('jewellery'), `${business.business_type} has no gold rates`);
    const tools = await request('GET', J('modules'));
    const module = tools.find((m) => m.code === 'jewellery');
    assert.equal(module.name, 'Gold rates & jewellery');
    assert.deepEqual([...module.requires].sort(), ['catalog', 'contacts', 'inventory', 'sales', 'serials']);
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'jewellery'), 'a grocery is not offered gold rates');
    await request('PUT', `/businesses/${grocery.id}/modules/jewellery`, { enabled: true }, 409);
    // Serial numbers and sales stay on while the module needs them.
    await request('PUT', J('modules/serials'), { enabled: false }, 409);
    await request('PUT', J('modules/sales'), { enabled: false }, 409);
    const permissions = await rows("SELECT code FROM business_permissions WHERE module_code='jewellery' ORDER BY sort_order");
    assert.deepEqual(permissions.map((p) => p.code), ['jewellery.view', 'jewellery.create', 'jewellery.edit', 'jewellery.approve', 'jewellery.cancel', 'jewellery.print', 'jewellery.export']);
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2`, [business.id, template])).p;
    const mine = async (business, template) => (await grants(business, template)).filter((p) => p.startsWith('jewellery.'));
    assert.deepEqual(await mine(jeweller, 'manager'), ['jewellery.approve', 'jewellery.cancel', 'jewellery.create', 'jewellery.edit', 'jewellery.export', 'jewellery.print', 'jewellery.view']);
    assert.deepEqual(await mine(jeweller, 'cashier'), ['jewellery.create', 'jewellery.edit', 'jewellery.print', 'jewellery.view']);
    assert.deepEqual(await mine(jeweller, 'stock_keeper'), ['jewellery.edit', 'jewellery.print', 'jewellery.view']);
    assert.deepEqual(await mine(jeweller, 'accountant'), ['jewellery.export', 'jewellery.print', 'jewellery.view']);
    assert.deepEqual(await mine(jeweller, 'viewer'), ['jewellery.view']);
    assert.deepEqual(await mine(grocery, 'viewer'), ['jewellery.view'], 'role copies match their templates everywhere');
    // The karigar: a jeweller's own role, with the pieces and no money.
    const roles = (await request('GET', J('roles?limit=100'))).items;
    assert.equal(roles.length, 7);
    assert.ok(roles.some((r) => r.template_code === 'karigar' && r.name === 'Karigar / goldsmith'));
    assert.deepEqual(await grants(jeweller, 'karigar'), ['catalog.view', 'inventory.view', 'jewellery.edit', 'jewellery.view']);
    for (const business of [grocery, optical]) {
      assert.ok(!(await request('GET', `/businesses/${business.id}/roles?limit=100`)).items.some((r) => r.template_code === 'karigar'), `${business.business_type}: no karigar`);
    }
    assert.notEqual(String(elsewhere.id), String(jeweller.id));
  });

  // --- Staff --------------------------------------------------------------------------------------------
  const shop = (await request('GET', J('locations'))).items[0];
  const roles = (await request('GET', J('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', J('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const manager = await staff('gold-manager@test.invalid', 'manager');
  const cashier = await staff('gold-cashier@test.invalid', 'cashier');
  const karigar = await staff('gold-karigar@test.invalid', 'karigar');
  const viewer = await staff('gold-viewer@test.invalid', 'viewer');
  const sheet = (rates, extra = {}) => ({ requestKey: key(), session: 'morning', source: 'association', rates, ...extra });

  await t.test('today\'s rates: a manager sets a sheet, a correction is a new sheet, and the latest of the day is in use', async () => {
    let now = await request('GET', J('jewellery/rates/today'));
    assert.equal(now.day, today, 'the business\'s own date');
    assert.deepEqual(now.rates, []);
    assert.equal(now.notRated.length, 7);
    const body = sheet([{ metal: 'gold', purity: '24k', sellRate: '13250.00', buyRate: '12900' }, { metal: 'gold', purity: '22K', sellRate: '12150', buyRate: '11800.50' },
      { metal: 'silver', purity: '999', sellRate: '165.50' }], { note: 'Opening rates' });
    now = await manager.call('POST', J('jewellery/rates'), body, 201);
    assert.deepEqual(now.rates.map((r) => [r.mark, r.sell_rate, r.buy_rate]), [['24K999', '13250.00', '12900.00'], ['22K916', '12150.00', '11800.50'], ['999', '165.50', null]]);
    assert.equal(now.sheets, 1);
    // The same request again gives the same rates and writes nothing more; the same key with other data is refused.
    const again = await manager.call('POST', J('jewellery/rates'), body, 201);
    assert.equal(again.sheets, 1);
    assert.equal((await refused('POST', J('jewellery/rates'), { ...body, note: 'Changed' }, manager.token)).status, 409);
    // A correction: a new sheet, which is in use for the purities it rates.
    now = await manager.call('POST', J('jewellery/rates'), sheet([{ metal: 'gold', purity: '22K', sellRate: '12175', buyRate: '11825' }], { session: 'evening', source: 'ibja' }), 201);
    const g22 = now.rates.find((r) => r.purity === '22K');
    assert.deepEqual([g22.sell_rate, g22.buy_rate, g22.session, g22.source], ['12175.00', '11825.00', 'evening', 'ibja']);
    assert.equal(now.rates.find((r) => r.purity === '24K').sell_rate, '13250.00', 'a purity the correction does not rate keeps the earlier sheet\'s rate');
    const inUse = await one("SELECT * FROM jewellery_current_rate($1,'gold','22K')", [jeweller.id]);
    assert.equal(inUse.sell_rate, '12175.00');
    // The sheets, newest first, with the replaced one marked.
    const history = await request('GET', J('jewellery/rates?limit=10'));
    assert.equal(history.total, 2);
    assert.deepEqual(history.items.map((s) => s.replaced), [false, true]);
    assert.equal(history.items[1].rates.length, 3);
    // Rates read as typed: a purity of the metal, a rate to the paisa, each purity once.
    assert.match((await refused('POST', J('jewellery/rates'), sheet([{ metal: 'gold', purity: '20K', sellRate: '10000' }]))).message, /24K, 22K, 18K, 14K/);
    assert.match((await refused('POST', J('jewellery/rates'), sheet([{ metal: 'silver', purity: '999', sellRate: '165.555' }]))).message, /two decimal places|2 decimal places/);
    assert.match((await refused('POST', J('jewellery/rates'), sheet([{ metal: 'gold', purity: '22K', sellRate: '1' }, { metal: 'gold', purity: '22K', sellRate: '2' }]))).message, /twice/);
    assert.equal((await refused('POST', J('jewellery/rates'), sheet([]))).status, 400);
    // The sheet and its rates are written to the activity log and the events.
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='jewellery_rates.set' ORDER BY id LIMIT 1", [jeweller.id]);
    assert.deepEqual(audit.details.rates.map((r) => [r.purity, r.sell, r.buy]), [['Gold 24K999', '13250.00', '12900.00'], ['Gold 22K916', '12150.00', '11800.50'], ['Silver 999', '165.50', null]]);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_events WHERE business_id=$1 AND kind='jewellery_rates.set'", [jeweller.id])).n, 2);
  });

  await t.test('the database keeps rate sheets as they were set', async () => {
    const first = await one('SELECT id FROM jewellery_rate_sheets WHERE business_id=$1 ORDER BY id LIMIT 1', [jeweller.id]);
    await assert.rejects(pool.query("UPDATE jewellery_rates SET sell_rate=1 WHERE sheet_id=$1", [first.id]), /kept as it was set/);
    await assert.rejects(pool.query('DELETE FROM jewellery_rates WHERE sheet_id=$1', [first.id]), /kept as it was set/);
    await assert.rejects(pool.query("UPDATE jewellery_rate_sheets SET note='x' WHERE id=$1", [first.id]), /kept as it was set/);
    await assert.rejects(pool.query('DELETE FROM jewellery_rate_sheets WHERE id=$1', [first.id]), /kept as it was set/);
    // A rate goes on its sheet when the sheet is set, never later.
    await assert.rejects(pool.query("INSERT INTO jewellery_rates(business_id,sheet_id,metal,purity,sell_rate) VALUES($1,$2,'gold','18K',9000)", [jeweller.id, first.id]), /when the sheet is set/);
    await assert.rejects(pool.query("INSERT INTO jewellery_rate_sheets(business_id,session,source,request_key,request_hash,created_by) VALUES($1,'noon','shop',$2,$3,$4)",
      [jeweller.id, key(), 'x'.repeat(64), ownerUser.id]), /check/);
    // A sheet is dated on the business's clock, whatever the client sends.
    const dated = await one(`INSERT INTO jewellery_rate_sheets(business_id,rate_date,session,source,request_key,request_hash,created_by) VALUES($1,'2001-01-01','morning','shop',$2,$3,$4)
      RETURNING rate_date::text AS d`, [jeweller.id, key(), 'y'.repeat(64), ownerUser.id]);
    assert.equal(dated.d, today);
  });

  await t.test('who sees and sets the rates', async () => {
    // The counter sees today's rates and cannot set them; the karigar sees no prices.
    assert.ok((await cashier.call('GET', J('jewellery/rates/today'))).rates.length >= 3);
    assert.equal((await refused('POST', J('jewellery/rates'), sheet([{ metal: 'gold', purity: '22K', sellRate: '1' }]), cashier.token)).status, 403);
    assert.equal((await refused('GET', J('jewellery/rates/today'), undefined, karigar.token)).status, 403);
    assert.equal((await refused('GET', J('jewellery/rates'), undefined, karigar.token)).status, 403);
    assert.ok((await viewer.call('GET', J('jewellery/rates'))).total >= 2);
    // Other types never have the module; another owner's jeweller is not theirs to read.
    assert.equal((await refused('GET', `/businesses/${grocery.id}/jewellery/rates/today`)).status, 403);
    assert.equal((await refused('POST', `/businesses/${optical.id}/jewellery/rates`, sheet([{ metal: 'gold', purity: '22K', sellRate: '1' }]))).status, 403);
    assert.equal((await refused('GET', J('jewellery/rates/today'), undefined, await login('gold-other@test.invalid'))).status, 404);
    assert.deepEqual((await other('GET', `/businesses/${elsewhere.id}/jewellery/rates/today`)).rates, []);
    // Switched off, the module's screens answer that it is off.
    await request('PUT', J('modules/jewellery'), { enabled: false });
    assert.match((await refused('GET', J('jewellery/rates/today'))).message, /not switched on/);
    await request('PUT', J('modules/jewellery'), { enabled: true });
  });

  // --- Items and pieces ------------------------------------------------------------------------------
  const slabs = (await request('GET', J('tax-rates'))).items;
  const gst3 = slabs.find((r) => Number(r.rate) === 3), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const supplier = await request('POST', J('contacts'), { kind: 'supplier', name: 'Mehta Bullion & Jewels' }, 201);
  let necklace, ring, piece;
  const tagBody = (extra = {}) => ({ requestKey: key(), skuId: necklace.sku_id, comesIn: 'new', locationId: shop.id, reason: 'opening', grossWeight: '10.250', stoneWeight: '0.400', ...extra });

  await t.test('jewellery items: catalogue items sold as tagged pieces, serial-numbered at 3%', async () => {
    let list = await request('POST', J('jewellery/items'), { item: { name: 'Gold necklace', hsnCode: '7113' }, metal: 'gold', purity: '22K', wastagePercent: '8', makingMode: 'per_gram', makingValue: '300' }, 201);
    necklace = list.items.find((i) => i.label === 'Gold necklace');
    assert.deepEqual([necklace.code, necklace.tax_rate, necklace.hsn_code, necklace.metal, necklace.purity, necklace.wastage_percent, necklace.making_mode, necklace.making_value],
      ['JWL-001', 3, '7113', 'gold', '22K', 8, 'per_gram', 300]);
    const sku = await one('SELECT tracking,unit,price FROM catalog_skus WHERE id=$1', [necklace.sku_id]);
    assert.deepEqual([sku.tracking, sku.unit, sku.price], ['serial', 'each', '0.00']);
    // An item already in the catalogue joins as it is: goods in pieces, serial-numbered, at 3%.
    const item = (extra) => request('POST', J('catalog'), { kind: 'goods', tracking: 'serial', unit: 'each', price: '0', taxRateId: gst3.id, ...extra }, 201);
    const made = await item({ name: '18K diamond ring', code: 'RING-18' });
    list = await request('POST', J('jewellery/items'), { skuId: made.id, metal: 'gold', purity: '18K', makingMode: 'flat', makingValue: '6500' }, 201);
    ring = list.items.find((i) => i.sku_id === made.id);
    assert.equal(ring.making_mode, 'flat');
    assert.equal((await refused('POST', J('jewellery/items'), { skuId: made.id, metal: 'gold', purity: '18K' })).status, 409);
    const at18 = await item({ name: 'Silver idol', code: 'IDOL-1', taxRateId: gst18.id });
    assert.match((await refused('POST', J('jewellery/items'), { skuId: at18.id, metal: 'silver', purity: '999' })).message, /at 18% GST: .*billed at 3%/);
    const counted = await request('POST', J('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'Gift box', code: 'BOX-1', price: '50', taxRateId: gst18.id }, 201);
    assert.match((await refused('POST', J('jewellery/items'), { skuId: counted.id, metal: 'gold', purity: '22K' })).message, /serial numbers/);
    assert.match((await refused('POST', J('jewellery/items'), { item: { name: 'Lab grown solitaire ring' }, metal: 'gold', purity: '18K' })).message, /laboratory-grown/);
    // The database holds the same rules whatever writes the row.
    await assert.rejects(pool.query("INSERT INTO jewellery_items(business_id,sku_id,metal,purity,created_by) VALUES($1,$2,'silver','999',$3)", [jeweller.id, at18.id, ownerUser.id]), /billed at 3%/);
    await assert.rejects(pool.query('DELETE FROM jewellery_items WHERE business_id=$1 AND sku_id=$2', [jeweller.id, necklace.sku_id]), /never deleted/);
    // The defaults a new piece starts with change; the item's name and GST stay in the catalogue.
    list = await request('PUT', J(`jewellery/items/${necklace.sku_id}`), { metal: 'gold', purity: '22K', wastagePercent: '8', makingMode: 'per_gram', makingValue: '300' });
    assert.ok(list.items.some((i) => i.sku_id === necklace.sku_id));
  });

  await t.test('tagging pieces: into stock with their tag or on a unit bought in, with weights to the milligram, stones and HUIDs', async () => {
    await request('PUT', J('jewellery/settings'), { tagPrefix: 'sl', hallmarkCharge: '45' });
    assert.equal((await request('GET', J('jewellery/settings'))).nextTag, 'SL00001');
    const body = tagBody({ cost: '125000', hallmarked: true, huids: ['ab12c3'], description: 'Bridal necklace with rubies',
      stones: [{ kind: 'ruby', pieces: '12', carat: '2.150', value: '2500' }, { kind: 'diamond', carat: '0.300', grade: 'F VS1 round', certificate: 'IGI 512345', value: '1500' }] });
    piece = await request('POST', J('jewellery/pieces'), body, 201);
    assert.deepEqual([piece.tag_no, piece.net_weight, piece.mark, piece.status, piece.hallmark_charge, piece.huids, piece.location_id],
      ['SL00001', '9.850', '22K916', 'in_stock', '45.00', 'AB12C3', shop.id]);
    assert.equal(piece.stones.length, 2);
    assert.equal(piece.stones[1].kind_words, 'Diamond (natural)');
    // Its price at today's 22K rate (₹12,175 a gram): metal, wastage (8% of the net weight), making (₹300 a gram), stones and hallmarking, then 3% GST.
    assert.deepEqual([piece.price.rate, piece.price.metal, piece.price.wastageWeight, piece.price.wastage, piece.price.making, piece.price.stones, piece.price.hallmark,
      piece.price.value, piece.price.tax, piece.price.total],
    ['12175.00', '119923.75', '0.788', '9593.90', '2955.00', '4000.00', '45.00', '136517.65', '4095.53', '140613.18']);
    // The unit came into stock with its tag, as a correction with its reason, at its cost.
    const lot = await one('SELECT quantity,unit_cost,location_id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [jeweller.id, necklace.sku_id, 'SL00001']);
    assert.deepEqual([lot.quantity, lot.unit_cost], ['1.000', '125000.0000']);
    assert.equal((await one("SELECT reason FROM business_stock_adjustments WHERE business_id=$1 ORDER BY id DESC LIMIT 1", [jeweller.id])).reason, 'Opening stock: piece SL00001');
    // A retry gives the same piece; the same key with other data is refused.
    assert.equal((await request('POST', J('jewellery/pieces'), body, 201)).id, piece.id);
    assert.equal((await refused('POST', J('jewellery/pieces'), { ...body, grossWeight: '10.300' })).status, 409);
    // Found by its tag or its HUID, as the counter scans either.
    assert.equal((await request('GET', J('jewellery/pieces/find?code=sl00001'))).id, piece.id);
    assert.equal((await request('GET', J('jewellery/pieces/find?code=AB12C3'))).id, piece.id);
    assert.equal((await refused('GET', J('jewellery/pieces/find?code=ZZ9999'))).status, 404);
    // A tag, a HUID and the words for a diamond are checked.
    assert.equal((await refused('POST', J('jewellery/pieces'), tagBody({ tagNo: 'SL00001' }))).status, 409);
    assert.match((await refused('POST', J('jewellery/pieces'), tagBody({ hallmarked: true, huids: ['AB12C3'] }))).message, /belongs to one article/);
    assert.match((await refused('POST', J('jewellery/pieces'), tagBody({ hallmarked: true, huids: ['AB12'] }))).message, /6 letters and digits/);
    assert.match((await refused('POST', J('jewellery/pieces'), tagBody({ huids: ['QW12E3'] }))).message, /tick Hallmarked/);
    assert.match((await refused('POST', J('jewellery/pieces'), tagBody({ stones: [{ kind: 'laboratory_grown_diamond', description: 'LGD solitaire' }] }))).message, /laboratory-grown/);
    assert.match((await refused('POST', J('jewellery/pieces'), tagBody({ stones: [{ kind: 'diamond', description: 'Artificial stone' }] }))).message, /never called fake or artificial/);
    assert.match((await refused('POST', J('jewellery/pieces'), tagBody({ stoneWeight: '10.250' }))).message, /below the gross weight/);
    assert.match((await refused('POST', J('jewellery/pieces'), tagBody({ grossWeight: '10.2505' }))).message, /3 decimal places/);
    // A unit bought in on a purchase with its number is tagged with that number.
    await request('POST', J('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
      lines: [{ skuId: ring.sku_id, quantity: '1', unitPrice: '42000', lotCode: 'RNG-77' }] }, 201);
    assert.match((await refused('POST', J('jewellery/pieces'), { requestKey: key(), skuId: ring.sku_id, comesIn: 'stock', tagNo: 'RNG-78', grossWeight: '4.120' })).message, /No unit of/);
    const bought = await request('POST', J('jewellery/pieces'), { requestKey: key(), skuId: ring.sku_id, comesIn: 'stock', tagNo: 'rng-77', grossWeight: '4.120', stoneWeight: '0.180',
      hallmarked: true, huids: ['RG77AB'], stones: [{ kind: 'laboratory_grown_diamond', carat: '0.900', certificate: 'IGI LG-889', value: '18000' }] }, 201);
    assert.deepEqual([bought.tag_no, bought.net_weight, bought.making_mode, bought.making_value, bought.mark], ['RNG-77', '3.940', 'flat', '6500.00', '18K750']);
    assert.equal(bought.stones[0].kind_words, 'Laboratory-grown diamond');
    // The audit log and the events.
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_piece.tagged' AND entity_id=$2", [jeweller.id, piece.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='jewellery_piece.tagged' AND entity_id=$2", [jeweller.id, piece.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='stock.adjusted'", [jeweller.id]));
  });

  await t.test('the karigar tags and weighs pieces and sees no prices; a piece goes out and comes back, changes in the shop, and is melted', async () => {
    // The karigar tags a unit in stock (not new stock), with the item's making charge, and sees no money.
    await request('POST', J('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
      lines: [{ skuId: necklace.sku_id, quantity: '1', unitPrice: '90000', lotCode: 'NK-55' }] }, 201);
    assert.equal((await refused('POST', J('jewellery/pieces'), tagBody(), karigar.token)).status, 403);
    const tagged = await karigar.call('POST', J('jewellery/pieces'), { requestKey: key(), skuId: necklace.sku_id, comesIn: 'stock', tagNo: 'NK-55', grossWeight: '8.005',
      makingValue: '1', wastagePercent: '50' }, 201);
    assert.deepEqual([tagged.money, tagged.making_value, tagged.wastage_percent, tagged.price], [false, null, null, null]);
    const seen = await request('GET', J(`jewellery/pieces/${tagged.id}`));
    assert.deepEqual([seen.making_value, seen.wastage_percent], ['300.00', '8.00'], 'the karigar\'s piece takes its item\'s charges');
    const list = await karigar.call('GET', J('jewellery/pieces?status=in_stock'));
    assert.ok(list.items.length >= 3 && list.items.every((p) => p.making_value === null && p.stone_value === null && p.cost === null));
    // On approval with a customer, back; to the karigar and back weighed again.
    let now = await cashier.call('POST', J(`jewellery/pieces/${tagged.id}/status`), { requestKey: key(), status: 'on_approval', withWhom: 'Lakshmi Iyer, to show at home' });
    assert.deepEqual([now.status, now.with_whom], ['on_approval', 'Lakshmi Iyer, to show at home']);
    assert.match((await refused('POST', J(`jewellery/pieces/${tagged.id}/status`), { requestKey: key(), status: 'at_karigar', withWhom: 'Ramesh' }, cashier.token)).message, /on approval/);
    now = await cashier.call('POST', J(`jewellery/pieces/${tagged.id}/status`), { requestKey: key(), status: 'in_stock' });
    const sent = { requestKey: key(), status: 'at_karigar', withWhom: 'Ramesh Soni (polish)' };
    now = await karigar.call('POST', J(`jewellery/pieces/${tagged.id}/status`), sent);
    assert.equal((await karigar.call('POST', J(`jewellery/pieces/${tagged.id}/status`), sent)).status, 'at_karigar', 'a retry changes nothing more');
    now = await karigar.call('PUT', J(`jewellery/pieces/${tagged.id}`), { grossWeight: '7.990', hallmarked: true, huids: ['NK55ZX'] });
    assert.deepEqual([now.gross_weight, now.net_weight, now.huids], ['7.990', '7.990', 'NK55ZX']);
    now = await karigar.call('POST', J(`jewellery/pieces/${tagged.id}/status`), { requestKey: key(), status: 'in_stock' });
    const changed = now.events.find((e) => e.kind === 'changed');
    assert.deepEqual([changed.details.from.grossWeight, changed.details.to.grossWeight], ['8.005', '7.990']);
    assert.deepEqual(now.events.map((e) => e.kind), ['tagged', 'sent', 'back', 'sent', 'changed', 'back']);
    // Melted by a manager: the unit leaves stock, and its metal (net and fine weight) joins the shop's metal.
    assert.equal((await refused('POST', J(`jewellery/pieces/${tagged.id}/melt`), { requestKey: key(), reason: 'Broken' }, cashier.token)).status, 403);
    const melting = { requestKey: key(), reason: 'Old design, to be remade' };
    now = await manager.call('POST', J(`jewellery/pieces/${tagged.id}/melt`), melting);
    assert.deepEqual([now.status, now.in_books], ['melted', false]);
    assert.equal((await manager.call('POST', J(`jewellery/pieces/${tagged.id}/melt`), melting)).status, 'melted', 'a retry melts nothing more');
    const metalStock = await request('GET', J('jewellery/metal'));
    const gold22 = metalStock.find((m) => m.metal === 'gold' && m.purity === '22K');
    assert.deepEqual([gold22.net_weight, gold22.fine_weight], ['7.990', '7.319'], '7.990 g at 916 is 7.319 g of fine gold');
    assert.equal((await request('GET', J('jewellery/metal/movements'))).items[0].piece_tag, 'NK-55');
    // A melted piece keeps what it was.
    assert.equal((await refused('PUT', J(`jewellery/pieces/${tagged.id}`), { grossWeight: '7.000' })).status, 409);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_piece.melted' AND entity_id=$2", [jeweller.id, tagged.id]));
  });

  await t.test('the database keeps the pieces\' rules, and a jewellery item stays off every other bill', async () => {
    await assert.rejects(pool.query('DELETE FROM jewellery_pieces WHERE id=$1', [piece.id]), /never deleted/);
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET tag_no='SL99999' WHERE id=$1", [piece.id]), /keeps its item and its tag/);
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET status='sold' WHERE id=$1", [piece.id]), /is sold on a jewellery bill/);
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET status='melted' WHERE id=$1", [piece.id]), /once its unit has left stock/);
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET description='Bridal LGD set' WHERE id=$1", [piece.id]), /check/);
    await assert.rejects(pool.query(`INSERT INTO jewellery_pieces(business_id,sku_id,tag_no,metal,purity,gross_weight,making_mode,request_key,request_hash,created_by)
      VALUES($1,$2,'NOSTOCK','gold','22K',5,'flat',$3,$4,$5)`, [jeweller.id, necklace.sku_id, key(), 'z'.repeat(64), ownerUser.id]), /not a unit of its item in stock/);
    await assert.rejects(pool.query("UPDATE jewellery_piece_huids SET huid='XX11YY' WHERE piece_id=$1", [piece.id]), /never changed/);
    await assert.rejects(pool.query('UPDATE jewellery_pieces SET hallmarked=false,hallmark_charge=0 WHERE id=$1', [piece.id]), /carries a HUID/);
    const melted = await one("SELECT id FROM jewellery_pieces WHERE business_id=$1 AND status='melted' LIMIT 1", [jeweller.id]);
    await assert.rejects(pool.query('DELETE FROM jewellery_piece_huids WHERE piece_id=$1', [melted.id]), /keeps what it was/);
    await assert.rejects(pool.query("UPDATE jewellery_piece_events SET note='x' WHERE piece_id=$1", [piece.id]), /history is kept/);
    await assert.rejects(pool.query('DELETE FROM jewellery_metal_movements WHERE business_id=$1', [jeweller.id]), /kept as it was written/);
    await assert.rejects(pool.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,piece_id,created_by)
      VALUES($1,$2,'gold','22K',1,1,'melted_piece',$3,$4)`, [jeweller.id, shop.id, piece.id, ownerUser.id]), /once it is melted/);
    // Quick bill, a sale and a quotation's bill never sell a jewellery item's piece at a price of its own.
    const sale = await refused('POST', J('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, lines: [{ skuId: necklace.sku_id, quantity: '1', lotCode: 'SL00001' }],
      payments: [{ method: 'cash', amount: 'full' }] });
    assert.equal(sale.status, 409);
    assert.match(sale.message, /jewellery item: its pieces are sold on the jewellery bill/);
    // Other types never have pieces; another owner's pieces are not theirs to read.
    assert.equal((await refused('GET', `/businesses/${grocery.id}/jewellery/pieces`)).status, 403);
    assert.equal((await refused('GET', J(`jewellery/pieces/${piece.id}`), undefined, await login('gold-other@test.invalid'))).status, 404);
    assert.equal((await other('GET', `/businesses/${elsewhere.id}/jewellery/pieces`)).total, 0);
    assert.equal((await refused('POST', J('jewellery/items'), { item: { name: 'Anklet' }, metal: 'silver', purity: '925' }, viewer.token)).status, 403);
  });

  // --- The jewellery bill --------------------------------------------------------------------------
  const meera = await request('POST', J('contacts'), { kind: 'customer', name: 'Meera Krishnan', phone: '9845011122' }, 201);
  let bill;

  await t.test('the hallmarking rules: each location\'s district as the owner says (under mandatory hallmarking until then), and the turnover exemption', async () => {
    let s = await request('GET', J('jewellery/settings'));
    assert.deepEqual([s.turnoverExempt, s.locations[0].confirmed, s.locations[0].mandatory], [false, false, true]);
    // The bell asks whoever changes settings to say.
    assert.ok((await request('GET', J('notifications'))).items.some((n) => n.category === 'Hallmarking' && /district under mandatory hallmarking/.test(n.title)));
    s = await request('PUT', J('jewellery/settings'), { locations: [{ locationId: shop.id, mandatory: true, district: 'Bengaluru Urban' }] });
    assert.deepEqual([s.locations[0].confirmed, s.locations[0].mandatory, s.locations[0].district], [true, true, 'Bengaluru Urban']);
    assert.ok(!(await request('GET', J('notifications'))).items.some((n) => n.category === 'Hallmarking'));
    assert.equal((await refused('PUT', J('jewellery/settings'), { turnoverExempt: true }, cashier.token)).status, 403);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='jewellery_settings.updated' ORDER BY id DESC LIMIT 1", [jeweller.id]);
    assert.equal(audit.details.districts[0].district, 'Bengaluru Urban');
  });

  await t.test('a jewellery bill: each piece at the latest rate of the day for its purity, making, wastage, stones and hallmarking, then 3% GST, through the core sale', async () => {
    await manager.call('POST', J('jewellery/rates'), sheet([{ metal: 'gold', purity: '18K', sellRate: '9150', buyRate: '8800' }]), 201);
    const body = { requestKey: key(), locationId: shop.id, contactId: meera.id, tags: ['sl00001', 'RNG-77'], payments: [{ method: 'upi', amount: 'full', reference: 'UPI-445566' }] };
    const preview = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, contactId: meera.id, tags: body.tags });
    assert.deepEqual(preview.problems, []);
    const [neck, rng] = preview.lines;
    assert.deepEqual([neck.mark, neck.purityLong, neck.netWeight, neck.rate, neck.metalValue, neck.wastage, neck.making, neck.stoneValue, neck.hallmarkCharge, neck.value, neck.tax, neck.total, neck.basis],
      ['22K916', '22 carat, 916 fineness', '9.850', '12175.00', '119923.75', '9593.90', '2955.00', '4000.00', '45.00', '136517.65', '4095.53', '140613.18', 'huid']);
    // The ring: 3.940 g of 18K at ₹9,150 a gram, ₹6,500 flat making, a laboratory-grown diamond at ₹18,000, ₹45 hallmarking.
    assert.deepEqual([rng.rate, rng.metalValue, rng.making, rng.stoneValue, rng.value, rng.tax, rng.total], ['9150.00', '36051.00', '6500.00', '18000.00', '60596.00', '1817.88', '62413.88']);
    // ₹1,97,113.65 before GST, ₹5,913.41 GST, rounded to the rupee: ₹2,03,027 (over ₹2,00,000: the buyer's PAN or Form 97).
    assert.deepEqual([preview.subtotal, preview.tax, preview.roundOff, preview.total, preview.panNeeded], ['197113.65', '5913.41', '-0.06', '203027.00', true]);
    assert.match((await refused('POST', J('jewellery/bills'), body, cashier.token)).message, /PAN/);
    assert.match((await refused('POST', J('jewellery/bills'), { ...body, requestKey: key(), payments: [{ method: 'cash', amount: 'full' }], buyer: { pan: 'AFZPK7190K' } }, cashier.token)).message, /section 186/);
    const posting = { ...body, buyer: { pan: 'afzpk7190k' } };
    bill = await cashier.call('POST', J('jewellery/bills'), posting, 201);
    assert.equal(bill.total, '203027.00');
    assert.equal(bill.lines.length, 2);
    // A retry gives the same bill; the same key with other data is refused.
    assert.equal((await cashier.call('POST', J('jewellery/bills'), posting, 201)).id, bill.id);
    assert.equal((await refused('POST', J('jewellery/bills'), { ...posting, notes: 'Changed' }, cashier.token)).status, 409);
    // The core sale: its lines name each piece as BIS asks, the units leave stock, the PAN and the payment are on it.
    const doc = await request('GET', J(`documents/${bill.document_id}`));
    assert.deepEqual(doc.lines.map((l) => [l.label, l.lot_code, l.net, l.tax, l.tax_rate, l.hsn_code]),
      [['Bridal necklace with rubies · 22K916 · tag SL00001', 'SL00001', '136517.65', '4095.53', '3.00', '7113'], ['18K diamond ring · 18K750 · tag RNG-77', 'RNG-77', '60596.00', '1817.88', '3.00', null]]);
    assert.deepEqual([doc.subtotal, doc.tax, doc.round_off, doc.total, doc.buyer_pan, doc.payments[0].method, doc.payments[0].amount], ['197113.65', '5913.41', '-0.06', '203027.00', 'AFZPK7190K', 'upi', '203027.00']);
    assert.match(doc.notes, /^Jewellery bill · rates of /);
    // The invoice's BIS details for each article, and the purity statement.
    assert.equal(doc.jewellery.statement, 'The buyer may get the purity of the hallmarked jewellery on this invoice checked at any BIS-recognised assaying and hallmarking centre.');
    const printed = doc.jewellery.lines[0];
    assert.deepEqual([printed.description, printed.net_weight, printed.purity_long, printed.hallmark_charge, printed.huids, printed.wastage_weight, printed.metal_value],
      ['Bridal necklace with rubies', '9.850', '22 carat, 916 fineness', '45.00', ['AB12C3'], '0.788', '119923.75']);
    assert.equal(doc.jewellery.lines[1].stones[0].kindWords, 'Laboratory-grown diamond');
    const pieceNow = await request('GET', J(`jewellery/pieces/${piece.id}`));
    assert.deepEqual([pieceNow.status, pieceNow.in_books, pieceNow.events.at(-1).kind], ['sold', false, 'sold']);
    assert.equal((await one('SELECT quantity FROM business_stock_lots WHERE business_id=$1 AND lot_code=$2', [jeweller.id, 'SL00001'])).quantity, '0.000');
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_bill.posted' AND entity_id=$2", [jeweller.id, bill.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='jewellery_bill.posted' AND entity_id=$2", [jeweller.id, bill.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='sale.posted' AND entity_id=$2", [jeweller.id, bill.document_id]));
    // A piece sold is not billed again; the bills list it.
    assert.match((await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['SL00001'] })).problems[0], /is sold/);
    assert.equal((await request('GET', J('jewellery/bills'))).items[0].tags, 'SL00001 RNG-77');
  });

  await t.test('the HUID check: gold of 2 g or more needs its HUID, unless left out by weight, metal, the article, the turnover or the district', async () => {
    const gold = await request('POST', J('jewellery/pieces'), tagBody({ grossWeight: '5.000', stoneWeight: '0', description: 'Plain gold chain' }), 201);
    const tiny = await request('POST', J('jewellery/pieces'), tagBody({ grossWeight: '1.990', stoneWeight: '0', description: 'Nose pin' }), 201);
    const kundan = await request('POST', J('jewellery/pieces'), tagBody({ grossWeight: '22.400', stoneWeight: '3.100', description: 'Kundan choker', exemption: 'kundan_polki_jadau' }), 201);
    const priced = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [gold.tag_no, tiny.tag_no, kundan.tag_no] });
    assert.match(priced.problems[0], /needs its BIS hallmark with a HUID before it is sold here/);
    assert.deepEqual(priced.lines.slice(1).map((l) => l.basis), ['under_2g', 'kundan_polki_jadau']);
    const sale = (tags) => ({ requestKey: key(), locationId: shop.id, tags, payments: [{ method: 'card', amount: 'full' }] });
    assert.equal((await refused('POST', J('jewellery/bills'), sale([gold.tag_no]), cashier.token)).status, 409);
    // The database holds the check whatever writes the line.
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET status='sold' WHERE id=$1", [gold.id]), /is sold on a jewellery bill/);
    // A district the owner says is not under mandatory hallmarking, or a business exempt by its turnover, sells it without a HUID.
    await request('PUT', J('jewellery/settings'), { locations: [{ locationId: shop.id, mandatory: false, district: 'Bengaluru Urban' }] });
    assert.equal((await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [gold.tag_no] })).lines[0].basis, 'district');
    await request('PUT', J('jewellery/settings'), { locations: [{ locationId: shop.id, mandatory: true, district: 'Bengaluru Urban' }], turnoverExempt: true });
    const exempt = await cashier.call('POST', J('jewellery/bills'), sale([gold.tag_no, tiny.tag_no]), 201);
    assert.deepEqual(exempt.lines.map((l) => l.hallmark_basis), ['turnover', 'under_2g']);
    assert.deepEqual([exempt.turnover_exempt, exempt.hallmark_mandatory], [true, true]);
    await request('PUT', J('jewellery/settings'), { turnoverExempt: false });
    assert.ok((await one('SELECT turnover_confirmed_by FROM jewellery_settings WHERE business_id=$1', [jeweller.id])).turnover_confirmed_by);
    // A walk-in pays in full; a piece on approval, a purity with no rate today and an unknown tag are refused.
    assert.equal((await refused('POST', J('jewellery/bills'), { ...sale([kundan.tag_no]), payments: [{ method: 'cash', amount: '100' }] }, cashier.token)).status, 409);
    await cashier.call('POST', J(`jewellery/pieces/${kundan.id}/status`), { requestKey: key(), status: 'on_approval', withWhom: 'Rani' });
    assert.match((await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [kundan.tag_no, 'NOPE-1'] })).problems.join(' | '), /on approval.*\| No piece has the tag NOPE-1/);
    await cashier.call('POST', J(`jewellery/pieces/${kundan.id}/status`), { requestKey: key(), status: 'in_stock' });
    const silverItem = (await request('POST', J('jewellery/items'), { item: { name: 'Silver anklets' }, metal: 'silver', purity: '925', makingMode: 'per_gram', makingValue: '20' }, 201))
      .items.find((i) => i.label === 'Silver anklets');
    const anklets = await request('POST', J('jewellery/pieces'), { requestKey: key(), skuId: silverItem.sku_id, comesIn: 'new', locationId: shop.id, grossWeight: '58.200' }, 201);
    assert.match((await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [anklets.tag_no] })).problems[0], /Silver 925 has no rate today/);
    // The karigar makes no bills; another type has none.
    assert.equal((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [kundan.tag_no] }, karigar.token)).status, 403);
    assert.equal((await refused('POST', `/businesses/${grocery.id}/jewellery/bills`, sale(['X1']))).status, 403);
  });

  await t.test('a piece taken back on its bill\'s credit note comes back into stock; the bill is kept as it was billed', async () => {
    const doc = await request('GET', J(`documents/${bill.document_id}`));
    const ringLine = doc.lines.find((l) => l.lot_code === 'RNG-77');
    assert.match((await refused('POST', J(`documents/${bill.document_id}/returns`), { requestKey: key(), reason: 'Wrong size', lines: [{ lineId: ringLine.id, quantity: '1', restock: false }] })).message,
      /comes back into stock when it is taken back/);
    await request('POST', J(`documents/${bill.document_id}/returns`), { requestKey: key(), reason: 'Wrong size', lines: [{ lineId: ringLine.id, quantity: '1', restock: true }] }, 201);
    const ring = await request('GET', J(`jewellery/pieces/find?code=RNG-77`));
    assert.deepEqual([ring.status, ring.in_books, ring.events.at(-1).kind], ['in_stock', true, 'returned']);
    assert.match(ring.events.at(-1).note, /Taken back on credit note/);
    // It can be billed again, at today's rate.
    assert.deepEqual((await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['RNG-77'] })).problems, []);
    await assert.rejects(pool.query("UPDATE jewellery_bills SET notes='x' WHERE id=$1", [bill.id]), /kept as it was billed/);
    await assert.rejects(pool.query('DELETE FROM jewellery_bill_lines WHERE bill_id=$1', [bill.id]), /kept as it was billed/);
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET status='in_stock' WHERE business_id=$1 AND tag_no='SL00001'", [jeweller.id]), /only when its bill line is returned/);
  });

  // --- Old gold --------------------------------------------------------------------------------------
  let voucher, exchange, large;
  const goldLines = () => [
    { description: 'Old bangles, a pair', pieces: '2', metal: 'gold', purity: '22K', testMethod: 'xrf', testedFineness: '912.5', grossWeight: '24.380', lessWeight: '0.120', deductionPercent: '2' },
    { description: 'Broken chain', metal: 'gold', purity: '18K', testMethod: 'touchstone', grossWeight: '6.004' },
  ];
  const intake = (extra = {}) => ({ requestKey: key(), locationId: shop.id, idKind: 'aadhaar', idRef: '9012', ownerDeclared: true, lines: goldLines(), ...extra });
  const payout = (voucherId, body, by = manager) => by.call('POST', J(`jewellery/old-gold/${voucherId}/payout`), { requestKey: key(), ...body }, 201);

  await t.test('old gold: tested and weighed, valued at the day\'s buy rate to the paisa, with the seller\'s photo ID, PAN and declaration; its metal joins the shop\'s own', async () => {
    await request('PUT', J('jewellery/settings'), { oldGoldDeduction: '1.5' });
    // Today's latest sheets buy 22K at ₹11,825 a gram and 18K at ₹8,800.
    const preview = await cashier.call('POST', J('jewellery/old-gold/preview'), { lines: goldLines() });
    assert.deepEqual(preview.problems, []);
    const [bangles, chain] = preview.lines;
    // 24.380 g less 0.120 g of dirt is 24.260 g; tested at 912.5 it holds 22.137 g of fine gold; valued as 22K (916), scaled to 912.5, less 2%: ₹2,80,062.80.
    assert.deepEqual([bangles.netWeight, bangles.fineWeight, bangles.buyRate, bangles.value], ['24.260', '22.137', '11825.00', '280062.80']);
    // The chain takes its purity's fineness and the shop's deduction (1.5%): 6.004 g × ₹8,800 × 98.5% = ₹52,042.67.
    assert.deepEqual([chain.testedFineness, chain.deductionPercent, chain.fineWeight, chain.value], ['750.0', '1.50', '4.503', '52042.67']);
    // ₹3,32,105.47 rounded as the business rounds its bills: ₹3,32,105, over ₹2,00,000 (the seller's PAN or Form 97).
    assert.deepEqual([preview.netWeight, preview.fineWeight, preview.roundOff, preview.value, preview.panNeeded], ['30.264', '26.640', '-0.47', '332105.00', true]);
    const lakshmi = { customer: { name: 'Lakshmi Iyer', phone: '9845033344' } };
    assert.match((await refused('POST', J('jewellery/old-gold'), intake(lakshmi), cashier.token)).message, /PAN/);
    assert.match((await refused('POST', J('jewellery/old-gold'), intake({ ...lakshmi, idRef: '1234 5678 9012', pan: 'ABCPK1234D' }), cashier.token)).message, /last four digits/);
    assert.match((await refused('POST', J('jewellery/old-gold'), intake({ ...lakshmi, pan: 'ABCPK1234D', ownerDeclared: false }), cashier.token)).message, /declaration/);
    const body = intake({ ...lakshmi, pan: 'abcpk1234d' });
    voucher = await cashier.call('POST', J('jewellery/old-gold'), body, 201);
    assert.match(voucher.voucher_no, /^OG\/\d{4}\/0001$/);
    assert.deepEqual([voucher.value, voucher.round_off, voucher.balance, voucher.state, voucher.pan, voucher.id_ref, voucher.lines.length],
      ['332105.00', '-0.47', '332105.00', 'open', 'ABCPK1234D', '9012', 2]);
    assert.deepEqual([voucher.lines[0].test_words, voucher.lines[0].fine_weight, voucher.lines[1].deduction_percent], ['Karatmeter (XRF)', '22.137', '1.50']);
    // A retry gives the same voucher; the same key with other data is refused.
    assert.equal((await cashier.call('POST', J('jewellery/old-gold'), body, 201)).id, voucher.id);
    assert.equal((await refused('POST', J('jewellery/old-gold'), { ...body, notes: 'Changed' }, cashier.token)).status, 409);
    // The new customer keeps the PAN they gave.
    assert.equal((await one('SELECT pan FROM business_contacts WHERE id=$1', [voucher.contact_id])).pan, 'ABCPK1234D');
    // Its metal joins the shop's own: 22K 24.260 g (22.137 g fine) beside the melted piece's 7.990 g, and 18K 6.004 g (4.503 g fine).
    const metal = await request('GET', J('jewellery/metal'));
    const g22 = metal.find((m) => m.purity === '22K'), g18 = metal.find((m) => m.purity === '18K');
    assert.deepEqual([g22.net_weight, g22.fine_weight, g18.net_weight, g18.fine_weight], ['32.250', '29.456', '6.004', '4.503']);
    assert.ok((await request('GET', J('jewellery/metal/movements?source=old_gold'))).items.every((m) => /^Old gold OG/.test(m.note)));
    // A purity the shop has no buy rate for today is not bought.
    const silver = await cashier.call('POST', J('jewellery/old-gold/preview'), { lines: [{ description: 'Silver plate', metal: 'silver', purity: '999', testMethod: 'acid', grossWeight: '120' }] });
    assert.match(silver.problems[0], /no buy rate for Silver 999 today/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_old_gold.taken' AND entity_id=$2", [jeweller.id, voucher.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='jewellery_old_gold.taken' AND entity_id=$2", [jeweller.id, voucher.id]));
  });

  await t.test('old gold paid out: cash below ₹2,00,000 to a seller in a day, the rest by UPI or bank, each in the expense book', async () => {
    assert.equal((await refused('POST', J(`jewellery/old-gold/${voucher.id}/payout`), { requestKey: key(), amount: '1000', method: 'cash' }, cashier.token)).status, 403);
    const cash = { requestKey: key(), amount: '150000', method: 'cash' };
    let now = await manager.call('POST', J(`jewellery/old-gold/${voucher.id}/payout`), cash, 201);
    assert.deepEqual([now.paid, now.balance, now.payouts.length], ['150000.00', '182105.00', 1]);
    assert.equal((await manager.call('POST', J(`jewellery/old-gold/${voucher.id}/payout`), cash, 201)).payouts.length, 1, 'a retry pays nothing more');
    // ₹60,000 more in cash today would take Lakshmi to ₹2,10,000 in cash: refused. By UPI it is paid.
    assert.match((await refused('POST', J(`jewellery/old-gold/${voucher.id}/payout`), { requestKey: key(), amount: '60000', method: 'cash' }, manager.token)).message, /section 186/);
    now = await payout(voucher.id, { amount: '60000', method: 'upi', reference: 'UPI-778899' });
    assert.deepEqual([now.paid, now.balance], ['210000.00', '122105.00']);
    assert.match((await refused('POST', J(`jewellery/old-gold/${voucher.id}/payout`), { requestKey: key(), amount: '122105.01', method: 'bank' }, manager.token)).message, /122105.00 left/);
    // Each payout is an expense at the voucher's location, so the day's money shows it; it is never reversed.
    const spent = await rows(`SELECT e.amount,e.method,e.category,e.description FROM jewellery_old_gold_payouts p JOIN business_expenses e ON e.id=p.expense_id
      WHERE p.old_gold_id=$1 ORDER BY p.id`, [voucher.id]);
    assert.deepEqual(spent.map((e) => [e.amount, e.method, e.category]), [['150000.00', 'cash', 'other'], ['60000.00', 'upi', 'other']]);
    assert.match(spent[0].description, /^Old gold bought: OG\/\d{4}\/0001 from Lakshmi Iyer$/);
    await assert.rejects(pool.query(`UPDATE business_expenses SET voided_at=now(),voided_by=$2,void_reason='Mistake'
      WHERE id=(SELECT expense_id FROM jewellery_old_gold_payouts WHERE old_gold_id=$1 ORDER BY id LIMIT 1)`, [voucher.id, ownerUser.id]), /stays as paid/);
    const day = await request('GET', J('reports/takings'));
    assert.deepEqual([Number(day.expenses.cash), Number(day.expenses.upi)], [150000, 60000]);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_old_gold.paid' AND entity_id=$2", [jeweller.id, voucher.id]));
  });

  await t.test('the shop\'s own cash limit for old gold, lower than the law\'s', async () => {
    await request('PUT', J('jewellery/settings'), { oldGoldCashLimit: '50000' });
    assert.equal((await request('GET', J('jewellery/settings'))).oldGoldCashLimit, '50000.00');
    const studs = await cashier.call('POST', J('jewellery/old-gold'), { requestKey: key(), locationId: shop.id, contactId: meera.id, idKind: 'voter_id', idRef: 'KA/12/345/678901',
      ownerDeclared: true, lines: [{ description: 'Ear studs', metal: 'gold', purity: '22K', testMethod: 'xrf', grossWeight: '5.000', deductionPercent: '0' }] }, 201);
    // 5.000 g of 22K at ₹11,825 a gram: ₹59,125.
    assert.equal(studs.value, '59125.00');
    assert.match((await refused('POST', J(`jewellery/old-gold/${studs.id}/payout`), { requestKey: key(), method: 'cash' }, manager.token)).message, /its own limit/);
    await payout(studs.id, { amount: '50000', method: 'cash' });
    const now = await payout(studs.id, { method: 'bank', reference: 'NEFT 12345' });
    assert.deepEqual([now.state, now.balance, now.payouts.map((p) => p.method)], ['settled', '0.00', ['cash', 'bank']]);
    await request('PUT', J('jewellery/settings'), { oldGoldCashLimit: '' });
    assert.equal((await request('GET', J('jewellery/settings'))).oldGoldCashLimit, null);
    assert.equal((await refused('PUT', J('jewellery/settings'), { oldGoldCashLimit: '200000' })).status, 400);
  });

  await t.test('old gold pays the seller\'s jewellery bill first, as a payment by old gold; money pays the rest, and the sale keeps its full value', async () => {
    const tag = (await one("SELECT tag_no FROM jewellery_pieces WHERE business_id=$1 AND description='Kundan choker'", [jeweller.id])).tag_no;
    assert.match((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [tag], contactId: meera.id, oldGold: [voucher.id] }, cashier.token)).message,
      /brought in by Lakshmi Iyer/);
    // What is left on her voucher (₹1,22,105) pays first; the bill's customer is hers.
    const preview = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [tag], oldGold: [voucher.id] });
    assert.equal(String(preview.contactId), String(voucher.contact_id));
    // 19.300 g of 22K at ₹12,175 with 8% wastage and ₹300 a gram making: ₹2,59,565.70, with 3% GST ₹2,67,353 rounded.
    assert.deepEqual([preview.subtotal, preview.total, preview.oldGoldPaid, preview.toPay, preview.oldGold[0].amount], ['259565.70', '267353.00', '122105.00', '145248.00', '122105.00']);
    const body = { requestKey: key(), locationId: shop.id, tags: [tag], oldGold: [voucher.id], payments: [{ method: 'upi', amount: 'full' }] };
    assert.equal((await refused('POST', J('jewellery/bills'), { ...body, requestKey: key(), payments: [{ method: 'upi', amount: '145248.01' }] }, cashier.token)).status, 400);
    exchange = await cashier.call('POST', J('jewellery/bills'), body, 201);
    assert.equal((await cashier.call('POST', J('jewellery/bills'), body, 201)).id, exchange.id);
    assert.deepEqual(exchange.old_gold.map((u) => [u.voucher_no, u.amount]), [[voucher.voucher_no, '122105.00']]);
    // The core sale at its full value, with the PAN she gave, paid by old gold (a credit note: no money moves) and by UPI.
    const doc = await request('GET', J(`documents/${exchange.document_id}`));
    assert.deepEqual([doc.total, doc.subtotal, doc.buyer_pan, doc.contact_id], ['267353.00', '259565.70', 'ABCPK1234D', voucher.contact_id]);
    assert.deepEqual(doc.payments.map((p) => [p.method, p.method_name, p.reference, p.amount]), [['credit_note', 'Old gold', voucher.voucher_no, '122105.00'], ['upi', null, null, '145248.00']]);
    const settled = await request('GET', J(`jewellery/old-gold/${voucher.id}`));
    assert.deepEqual([settled.used, settled.balance, settled.state, settled.uses[0].document_no], ['122105.00', '0.00', 'settled', doc.document_no]);
    assert.match((await refused('POST', J(`jewellery/old-gold/${voucher.id}/payout`), { requestKey: key(), method: 'upi' }, manager.token)).message, /nothing left/);
    assert.match((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [tag], oldGold: [voucher.id] }, cashier.token)).message, /nothing left/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_old_gold.used' AND entity_id=$2", [jeweller.id, voucher.id]));
  });

  await t.test('a bill old gold paid, returned: money goes back only as far as money was paid, and the old gold part goes back on its voucher', async () => {
    const doc = await request('GET', J(`documents/${exchange.document_id}`));
    await request('POST', J(`documents/${exchange.document_id}/returns`), { requestKey: key(), reason: 'Changed her mind', lines: [{ lineId: doc.lines[0].id, quantity: '1', restock: true }] }, 201);
    assert.match((await refused('POST', J(`documents/${exchange.document_id}/refunds`), { requestKey: key(), amount: '145248.01', method: 'upi', reason: 'Returned' })).message,
      /paid ₹145248.00 in money/);
    await request('POST', J(`documents/${exchange.document_id}/refunds`), { requestKey: key(), amount: '145248', method: 'upi', reason: 'Returned' }, 201);
    let now = await request('GET', J(`jewellery/old-gold/${voucher.id}`));
    assert.deepEqual(now.putBack.map((p) => [p.documentNo, p.amount]), [[doc.document_no, '122105.00']]);
    const putting = { requestKey: key(), documentId: exchange.document_id };
    assert.equal((await refused('POST', J(`jewellery/old-gold/${voucher.id}/put-back`), { ...putting, requestKey: key(), amount: '122105.01' })).status, 409);
    now = await request('POST', J(`jewellery/old-gold/${voucher.id}/put-back`), putting, 201);
    assert.deepEqual([now.used, now.balance, now.state, now.putBack.length], ['0.00', '122105.00', 'open', 0]);
    assert.equal((await request('POST', J(`jewellery/old-gold/${voucher.id}/put-back`), putting, 201)).balance, '122105.00', 'a retry puts nothing more back');
    // The bill gave its credit back: the money by UPI, the old gold by credit note; nothing is left owed either way.
    const after = await request('GET', J(`documents/${exchange.document_id}`));
    assert.deepEqual(after.refunds.map((r) => [r.method, r.amount]), [['upi', '145248.00'], ['credit_note', '122105.00']]);
    // The value is hers again, paid out by bank.
    now = await payout(voucher.id, { method: 'bank', reference: 'NEFT 99' });
    assert.deepEqual([now.paid, now.balance, now.state], ['332105.00', '0.00', 'settled']);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_old_gold.put_back' AND entity_id=$2", [jeweller.id, voucher.id]));
  });

  await t.test('cancelling old gold, and the database\'s own rules for vouchers, their uses and payouts', async () => {
    const ring = await cashier.call('POST', J('jewellery/old-gold'), { requestKey: key(), locationId: shop.id, contactId: meera.id, idKind: 'passport', idRef: 'N1234567', ownerDeclared: true,
      lines: [{ description: 'Old ring', metal: 'gold', purity: '22K', testMethod: 'touchstone', grossWeight: '3.100' }] }, 201);
    assert.equal((await refused('POST', J(`jewellery/old-gold/${ring.id}/cancel`), { reason: 'Wrong customer' }, cashier.token)).status, 403);
    const before = (await request('GET', J('jewellery/metal'))).find((m) => m.purity === '22K');
    const cancelled = await manager.call('POST', J(`jewellery/old-gold/${ring.id}/cancel`), { reason: 'The customer took it back' });
    assert.deepEqual([cancelled.state, cancelled.cancel_reason, cancelled.cancellable], ['cancelled', 'The customer took it back', false]);
    const after = (await request('GET', J('jewellery/metal'))).find((m) => m.purity === '22K');
    assert.equal((Number(before.net_weight) - Number(after.net_weight)).toFixed(3), '3.100', 'its metal goes back out');
    assert.match((await refused('POST', J(`jewellery/old-gold/${voucher.id}/cancel`), { reason: 'x' }, manager.token)).message, /paid out or used/);
    assert.match((await refused('POST', J(`jewellery/old-gold/${ring.id}/payout`), { requestKey: key(), method: 'upi' }, manager.token)).message, /cancelled/);
    // The database keeps the rules whatever writes the rows.
    await assert.rejects(pool.query('UPDATE jewellery_old_gold SET value=1 WHERE id=$1', [voucher.id]), /kept as it was written/);
    await assert.rejects(pool.query('DELETE FROM jewellery_old_gold WHERE id=$1', [voucher.id]), /never deleted/);
    await assert.rejects(pool.query("UPDATE jewellery_old_gold SET cancelled_at=now(),cancelled_by=$2,cancel_reason='x' WHERE id=$1", [voucher.id, ownerUser.id]), /paid out or used/);
    await assert.rejects(pool.query('UPDATE jewellery_old_gold_lines SET value=1 WHERE old_gold_id=$1', [voucher.id]), /kept as it was written/);
    await assert.rejects(pool.query('DELETE FROM jewellery_old_gold_payouts WHERE old_gold_id=$1', [voucher.id]), /kept as it was written/);
    const sheet22 = await one("SELECT sheet_id FROM jewellery_current_rate($1,'gold','22K')", [jeweller.id]);
    await assert.rejects(pool.query(`INSERT INTO jewellery_old_gold_lines(business_id,old_gold_id,seq,description,metal,purity,test_method,tested_fineness,gross_weight,fine_weight,
      rate_sheet_id,buy_rate,value) VALUES($1,$2,9,'Extra','gold','22K','xrf',916,1,0.916,$3,11825,11825)`, [jeweller.id, voucher.id, sheet22.sheet_id]), /when the voucher is made/);
    // ₹2,00,000 or more in cash to one seller is refused by the database too.
    large = await cashier.call('POST', J('jewellery/old-gold'), { requestKey: key(), locationId: shop.id, contactId: meera.id, idKind: 'driving_licence', idRef: 'KA0120110012345',
      panDeclaration: true, ownerDeclared: true, lines: [{ description: 'Old necklace', metal: 'gold', purity: '22K', testMethod: 'xrf', grossWeight: '20.000', deductionPercent: '0' }] }, 201);
    assert.deepEqual([large.value, large.pan, large.pan_declaration], ['236500.00', null, true]);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const spent = await db.query(`INSERT INTO business_expenses(business_id,location_id,spent_on,category,description,amount,method,request_key,created_by)
        VALUES($1,$2,CURRENT_DATE,'other','Old gold',200000,'cash',$3,$4) RETURNING id`, [jeweller.id, shop.id, key(), ownerUser.id]);
      await assert.rejects(db.query(`INSERT INTO jewellery_old_gold_payouts(business_id,old_gold_id,expense_id,amount,method,request_key,request_hash,created_by)
        VALUES($1,$2,$3,200000,'cash',$4,$5,$6)`, [jeweller.id, large.id, spent.rows[0].id, key(), 'h'.repeat(64), ownerUser.id]), /section 186/);
    } finally { await db.query('ROLLBACK'); db.release(); }
    // Old gold pays only the jewellery bills of the customer who brought it in.
    const meerasPayment = await one('SELECT id FROM business_payments WHERE business_id=$1 AND document_id=$2 LIMIT 1', [jeweller.id, bill.document_id]);
    await assert.rejects(pool.query('INSERT INTO jewellery_old_gold_uses(business_id,old_gold_id,document_id,payment_id,amount,created_by) VALUES($1,$2,$3,$4,1,$5)',
      [jeweller.id, voucher.id, bill.document_id, meerasPayment.id, ownerUser.id]), /customer who brought it in/);
  });

  await t.test('who sees and handles old gold, and the bell', async () => {
    assert.equal((await refused('GET', J('jewellery/old-gold'), undefined, karigar.token)).status, 403);
    assert.equal((await refused('POST', J('jewellery/old-gold/preview'), { lines: goldLines() }, karigar.token)).status, 403);
    assert.equal((await refused('POST', J('jewellery/old-gold'), intake({ contactId: meera.id }), viewer.token)).status, 403);
    assert.ok((await viewer.call('GET', J('jewellery/old-gold'))).total >= 4);
    const open = await request('GET', J('jewellery/old-gold?state=open'));
    assert.deepEqual(open.items.map((g) => String(g.id)), [String(large.id)]);
    assert.equal((await refused('POST', `/businesses/${grocery.id}/jewellery/old-gold`, intake())).status, 403);
    assert.equal((await refused('GET', J(`jewellery/old-gold/${voucher.id}`), undefined, await login('gold-other@test.invalid'))).status, 404);
    // Old gold taken in before today with value left rings the bell for whoever pays out.
    assert.ok(!(await request('GET', J('notifications'))).items.some((n) => n.category === 'Old gold'), 'taken in today: not yet');
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE jewellery_old_gold DISABLE TRIGGER jewellery_old_gold_guard');
      await db.query("UPDATE jewellery_old_gold SET created_at=created_at-interval '1 day' WHERE id=$1", [large.id]);
      await db.query('ALTER TABLE jewellery_old_gold ENABLE TRIGGER jewellery_old_gold_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    const bell = (await request('GET', J('notifications'))).items.find((n) => n.category === 'Old gold');
    assert.match(bell.title, /1 old gold voucher with value left/);
    assert.match(bell.detail, /236500.00/);
    assert.ok(!(await cashier.call('GET', J('notifications'))).items.some((n) => n.category === 'Old gold'), 'the counter does not pay out');
  });

  // --- Gold schemes -----------------------------------------------------------------------------------
  let quick, scheme, schemeBill;
  const terms = 'Pay your instalment every month. With every instalment paid, a discount on your jewellery bill from the day the scheme matures. The money paid is used only on jewellery, never paid back in money, and the scheme is billed within 364 days of the first instalment.';
  // Time passes: a scheme moved back so many months, as if joined then (its days only).
  async function backdate(schemeId, months) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE jewellery_schemes DISABLE TRIGGER jewellery_schemes_guard');
      await db.query(`UPDATE jewellery_schemes SET started_on=(started_on-make_interval(months => $2))::date,maturity_on=(started_on-make_interval(months => $2)+make_interval(months => instalments))::date,
        close_by=(started_on-make_interval(months => $2))::date+364 WHERE id=$1`, [schemeId, months]);
      await db.query('ALTER TABLE jewellery_schemes ENABLE TRIGGER jewellery_schemes_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  const enrol = (body, by = cashier, expected = 201) => by.call('POST', J('jewellery/schemes'), { requestKey: key(), locationId: shop.id, termsAccepted: true, ...body }, expected);

  await t.test('gold scheme plans: up to 11 monthly instalments, a discount never called interest, terms kept once made', async () => {
    const plan = (body) => ({ requestKey: key(), terms, ...body });
    let list = await manager.call('POST', J('jewellery/scheme-plans'), plan({ name: 'Swarna 11', instalments: '11', minInstalment: '2000', discountPercent: '100' }), 201);
    const swarna = list.items.find((p) => p.name === 'Swarna 11');
    // One instalment free on 11, as a yearly figure on the money held: 100% × 24 ÷ (11 × 12) = 18.2%.
    assert.deepEqual([swarna.instalments, swarna.min_instalment, swarna.discount_percent, swarna.yearly_rate, swarna.discount], [11, '2000.00', '100.00', '18.2', '2000.00']);
    list = await manager.call('POST', J('jewellery/scheme-plans'), plan({ name: 'Quick 3', instalments: '3', minInstalment: '1000', discountPercent: '50' }), 201);
    quick = list.items.find((p) => p.name === 'Quick 3');
    assert.equal((await refused('POST', J('jewellery/scheme-plans'), plan({ name: 'Twelve', instalments: '12', minInstalment: '1000', discountPercent: '0' }), manager.token)).status, 400);
    assert.match((await refused('POST', J('jewellery/scheme-plans'), plan({ name: 'Gold interest plan', instalments: '10', minInstalment: '1000', discountPercent: '10' }), manager.token)).message,
      /never "interest"/);
    assert.equal((await refused('POST', J('jewellery/scheme-plans'), plan({ name: 'Cashier plan', instalments: '5', minInstalment: '1000', discountPercent: '10' }), cashier.token)).status, 403);
    assert.equal((await refused('POST', J('jewellery/scheme-plans'), plan({ name: 'swarna 11', instalments: '5', minInstalment: '1000', discountPercent: '10' }), manager.token)).status, 409);
    // A plan keeps its terms; it is switched off, never deleted.
    await assert.rejects(pool.query('UPDATE jewellery_scheme_plans SET discount_percent=10 WHERE id=$1', [quick.id]), /keeps its terms/);
    await assert.rejects(pool.query('DELETE FROM jewellery_scheme_plans WHERE id=$1', [quick.id]), /never deleted/);
    await assert.rejects(pool.query("UPDATE jewellery_scheme_plans SET terms='Earn interest' WHERE id=$1", [quick.id]), /keeps its terms|check/);
    list = await manager.call('PUT', J(`jewellery/scheme-plans/${swarna.id}`), { active: false });
    assert.equal(list.items.find((p) => p.id === swarna.id).active, false);
    assert.match((await refused('POST', J('jewellery/schemes'), { requestKey: key(), locationId: shop.id, planId: swarna.id, contactId: meera.id, instalment: '2000', termsAccepted: true,
      payment: { method: 'upi' } }, cashier.token)).message, /switched off/);
    await manager.call('PUT', J(`jewellery/scheme-plans/${swarna.id}`), { active: true });
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_scheme_plan.created'", [jeweller.id]));
  });

  await t.test('joining a gold scheme: its terms kept, each instalment a collection receipt, the days that count', async () => {
    const body = { requestKey: key(), locationId: shop.id, planId: quick.id, contactId: meera.id, instalment: '5000', nomineeName: 'Arun Krishnan', nomineeRelation: 'Son',
      termsAccepted: true, payment: { method: 'upi', reference: 'UPI-1' } };
    assert.match((await refused('POST', J('jewellery/schemes'), { ...body, requestKey: key(), termsAccepted: false }, cashier.token)).message, /accepts the scheme's terms/);
    assert.match((await refused('POST', J('jewellery/schemes'), { ...body, requestKey: key(), instalment: '999' }, cashier.token)).message, /at least 1000.00/);
    assert.match((await refused('POST', J('jewellery/schemes'), { ...body, requestKey: key(), instalment: '5000.50' }, cashier.token)).message, /decimal/);
    scheme = await cashier.call('POST', J('jewellery/schemes'), body, 201);
    assert.match(scheme.scheme_no, /^GS\/\d{4}\/0001$/);
    const months = (n) => { const [y, m, d] = today.split('-').map(Number); const t2 = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t2.getUTCFullYear(), t2.getUTCMonth() + 1, 0)).getUTCDate();
      t2.setUTCDate(Math.min(d, last)); return t2.toISOString().slice(0, 10); };
    assert.deepEqual([scheme.started_on, scheme.maturity_on, scheme.close_by, scheme.status, scheme.stage, scheme.paid, scheme.paid_count, scheme.instalment, scheme.terms],
      [today, months(3), daysFrom(364), 'active', 'paying', '5000.00', 1, '5000.00', terms]);
    assert.deepEqual(scheme.schedule.map((s) => [s.seq, s.due_on, Boolean(s.paid)]), [[1, today, true], [2, months(1), false], [3, months(2), false]]);
    assert.equal((await cashier.call('POST', J('jewellery/schemes'), body, 201)).id, scheme.id, 'a retry joins nothing more');
    assert.equal((await refused('POST', J('jewellery/schemes'), { ...body, nomineeName: 'Someone else' }, cashier.token)).status, 409);
    // The first instalment: a collection receipt of Meera's money (her advance), no sale.
    const receipt = await one('SELECT k.amount,k.method,k.notes,k.contact_id FROM jewellery_scheme_instalments i JOIN business_collections k ON k.id=i.collection_id WHERE i.scheme_id=$1', [scheme.id]);
    assert.deepEqual([receipt.amount, receipt.method, String(receipt.contact_id)], ['5000.00', 'upi', String(meera.id)]);
    assert.match(receipt.notes, /^Gold scheme GS\/\d{4}\/0001: instalment 1 of 3$/);
    // The next two instalments, by cash; then it has them all.
    const instalment = { requestKey: key(), method: 'cash' };
    let now = await cashier.call('POST', J(`jewellery/schemes/${scheme.id}/instalments`), instalment, 201);
    assert.equal((await cashier.call('POST', J(`jewellery/schemes/${scheme.id}/instalments`), instalment, 201)).paid_count, 2, 'a retry takes nothing more');
    now = await cashier.call('POST', J(`jewellery/schemes/${scheme.id}/instalments`), { requestKey: key(), method: 'cash' }, 201);
    assert.deepEqual([now.paid_count, now.paid, now.cash_paid, now.can_pay], [3, '15000.00', '10000.00', false]);
    assert.match((await refused('POST', J(`jewellery/schemes/${scheme.id}/instalments`), { requestKey: key(), method: 'upi' }, cashier.token)).message, /all its 3 instalments/);
    // Not matured yet: no discount today.
    assert.deepEqual([now.discount_now, now.discount_when_complete], ['0.00', '2500.00']);
    // Cash into one scheme stays under ₹2,00,000 (its instalments pay one bill).
    const big = await manager.call('POST', J('jewellery/scheme-plans'), { requestKey: key(), name: 'Big 2', instalments: '2', minInstalment: '100000', discountPercent: '0', terms }, 201);
    const bigPlan = big.items.find((p) => p.name === 'Big 2');
    const bigScheme = await enrol({ planId: bigPlan.id, contactId: meera.id, instalment: '150000', payment: { method: 'bank', reference: 'NEFT 1' } });
    assert.equal((await cashier.call('POST', J(`jewellery/schemes/${bigScheme.id}/instalments`), { requestKey: key(), method: 'upi' }, 201)).paid_count, 2);
    assert.match((await refused('POST', J('jewellery/schemes'), { requestKey: key(), locationId: shop.id, planId: bigPlan.id, contactId: meera.id, instalment: '200000', termsAccepted: true,
      payment: { method: 'cash' } }, cashier.token)).message, /section 186/);
    // The database holds the scheme's rules whatever writes the rows.
    await assert.rejects(pool.query('UPDATE jewellery_schemes SET instalment=1 WHERE id=$1', [scheme.id]), /keeps what it was joined with/);
    await assert.rejects(pool.query('DELETE FROM jewellery_schemes WHERE id=$1', [scheme.id]), /never deleted/);
    await assert.rejects(pool.query('DELETE FROM jewellery_scheme_instalments WHERE scheme_id=$1', [scheme.id]), /kept as they were paid/);
    await assert.rejects(pool.query("UPDATE jewellery_schemes SET status='redeemed',redeemed_document_id=$2,redeemed_at=now(),discount=0 WHERE id=$1", [scheme.id, bill.document_id]),
      /redeemed on a jewellery bill of its member/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_scheme.joined' AND entity_id=$2", [jeweller.id, scheme.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='jewellery_scheme.instalment_paid' AND entity_id=$2", [jeweller.id, scheme.id]));
  });

  await t.test('a matured scheme redeemed on a jewellery bill: all its instalments pay it, with the discount off the pieces before GST', async () => {
    const pendant = await request('POST', J('jewellery/pieces'), tagBody({ grossWeight: '3.000', stoneWeight: '0', description: 'Gold pendant', hallmarked: true, huids: ['PD12AB'] }), 201);
    // Its scheme's third month comes: it matures today.
    await backdate(scheme.id, 3);
    const matured = await request('GET', J(`jewellery/schemes/${scheme.id}`));
    assert.ok(matured.maturity_on <= today);
    assert.deepEqual([matured.stage, matured.discount_now], ['matured', '2500.00']);
    // 3.000 g of 22K at ₹12,175: metal ₹36,525, wastage ₹2,922, making ₹900, hallmarking ₹45 = ₹40,392; less the scheme's ₹2,500 = ₹37,892, GST ₹1,136.76, ₹39,029 rounded.
    const preview = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [pendant.tag_no], scheme: scheme.id });
    assert.equal(String(preview.contactId), String(meera.id));
    assert.deepEqual([preview.lines[0].value, preview.lines[0].discount, preview.lines[0].taxable, preview.lines[0].tax, preview.total],
      ['40392.00', '2500.00', '37892.00', '1136.76', '39029.00']);
    assert.deepEqual([preview.scheme.schemeNo, preview.schemeDiscount, preview.schemePaid, preview.toPay], [scheme.scheme_no, '2500.00', '15000.00', '24029.00']);
    // Another customer's bill does not take Meera's scheme.
    assert.match((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [pendant.tag_no], scheme: scheme.id, contactId: voucher.contact_id }, cashier.token)).message,
      /is Meera Krishnan's/);
    const body = { requestKey: key(), locationId: shop.id, tags: [pendant.tag_no], scheme: scheme.id, payments: [{ method: 'upi', amount: 'full' }] };
    schemeBill = await cashier.call('POST', J('jewellery/bills'), body, 201);
    assert.equal((await cashier.call('POST', J('jewellery/bills'), body, 201)).id, schemeBill.id);
    assert.deepEqual([schemeBill.scheme.scheme_no, schemeBill.scheme_discount, schemeBill.lines[0].discount, schemeBill.lines[0].taxable], [scheme.scheme_no, '2500.00', '2500.00', '37892.00']);
    // The core sale at the discounted value, paid by the scheme's three receipts (as they were paid) and the rest by UPI.
    const doc = await request('GET', J(`documents/${schemeBill.document_id}`));
    assert.deepEqual([doc.subtotal, doc.tax, doc.round_off, doc.total], ['37892.00', '1136.76', '0.24', '39029.00']);
    assert.deepEqual(doc.payments.map((p) => [p.method, p.amount, Boolean(p.collection_id)]), [['upi', '24029.00', false], ['upi', '5000.00', true], ['cash', '5000.00', true], ['cash', '5000.00', true]]);
    assert.deepEqual([doc.jewellery.scheme.schemeNo, doc.jewellery.scheme.discount], [scheme.scheme_no, '2500.00']);
    const done = await request('GET', J(`jewellery/schemes/${scheme.id}`));
    assert.deepEqual([done.status, done.stage, done.redeemed_document_no, done.discount], ['redeemed', 'redeemed', doc.document_no, '2500.00']);
    assert.match((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['RNG-77'], scheme: scheme.id }, cashier.token)).message, /was redeemed on/);
    assert.match((await refused('POST', J(`jewellery/schemes/${scheme.id}/instalments`), { requestKey: key(), method: 'upi' }, cashier.token)).message, /redeemed/);
    // A bill smaller than what was paid into the scheme is refused: the scheme's money is all used on jewellery.
    const small = await enrol({ planId: quick.id, contactId: meera.id, instalment: '70000', payment: { method: 'upi' } });
    assert.match((await refused('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, tags: ['RNG-77'], scheme: small.id }, cashier.token)).message,
      /choose jewellery worth at least the 70000.00 paid into scheme/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_scheme.redeemed' AND entity_id=$2", [jeweller.id, scheme.id]));
  });

  await t.test('a scheme stopped with a manager\'s approval: no more instalments and no discount; its money used on a bill, never paid back in money', async () => {
    const lakshmi = { id: voucher.contact_id };
    const stopping = await enrol({ planId: quick.id, contactId: lakshmi.id, instalment: '1000', payment: { method: 'cash' } });
    assert.equal((await refused('POST', J(`jewellery/schemes/${stopping.id}/stop`), { reason: 'Moving away' }, cashier.token)).status, 403);
    const stopped = await manager.call('POST', J(`jewellery/schemes/${stopping.id}/stop`), { reason: 'Moving away' });
    assert.deepEqual([stopped.status, stopped.stop_reason, stopped.stop_approved_by_name, stopped.can_pay], ['stopped', 'Moving away', 'gold-manager', false]);
    assert.match((await refused('POST', J(`jewellery/schemes/${stopping.id}/instalments`), { requestKey: key(), method: 'upi' }, cashier.token)).message, /stopped/);
    // Never paid back in money, and never on another bill than the one that redeems it.
    const receipt = await one('SELECT collection_id FROM jewellery_scheme_instalments WHERE scheme_id=$1', [stopping.id]);
    await assert.rejects(pool.query(`INSERT INTO business_collection_refunds(business_id,collection_id,contact_id,refund_no,amount,method,reason,source,approved_by,request_key,request_hash,created_by)
      VALUES($1,$2,$3,'RF-1',1000,'cash','Back','salon',$4,$5,$6,$4)`, [jeweller.id, receipt.collection_id, lakshmi.id, ownerUser.id, key(), 'r'.repeat(64)]), /never paid back in money/);
    const lakshmisBill = await one('SELECT document_id FROM jewellery_bills WHERE business_id=$1 AND contact_id=$2 ORDER BY id LIMIT 1', [jeweller.id, lakshmi.id]);
    await assert.rejects(pool.query(`INSERT INTO business_payments(business_id,document_id,amount,method,request_key,created_by,collection_id) VALUES($1,$2,1,'cash',$3,$4,$5)`,
      [jeweller.id, lakshmisBill.document_id, key(), ownerUser.id, receipt.collection_id]), /pay only the jewellery bill that redeems it/);
    // Redeemed on her bill without a discount.
    const ring = await cashier.call('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, tags: ['RNG-77'], scheme: stopping.id, payments: [{ method: 'upi', amount: 'full' }] }, 201);
    assert.deepEqual([ring.scheme_discount, ring.lines[0].discount], ['0.00', '0.00']);
    // Taken back: money goes back only as far as money was paid at the counter; the scheme's ₹1,000 stays as her credit.
    const doc = await request('GET', J(`documents/${ring.document_id}`));
    await request('POST', J(`documents/${ring.document_id}/returns`), { requestKey: key(), reason: 'Too big', lines: [{ lineId: doc.lines[0].id, quantity: '1', restock: true }] }, 201);
    const money = Number(doc.total) - 1000;
    assert.match((await refused('POST', J(`documents/${ring.document_id}/refunds`), { requestKey: key(), amount: doc.total, method: 'upi', reason: 'Returned' })).message,
      /gold scheme's instalments are never paid back/);
    await request('POST', J(`documents/${ring.document_id}/refunds`), { requestKey: key(), amount: money.toFixed(2), method: 'upi', reason: 'Returned' }, 201);
    // Her credit pays a new jewellery bill.
    const credits = await cashier.call('GET', J(`jewellery/bills/credits?contact=${lakshmi.id}`));
    assert.deepEqual(credits.items.map((x) => [x.documentNo, x.credit]), [[doc.document_no, '1000.00']]);
    const preview = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['RNG-77'], credits: [ring.document_id] });
    assert.deepEqual([String(preview.contactId), preview.credits[0].amount, preview.paidBefore], [String(lakshmi.id), '1000.00', '1000.00']);
    const again = await cashier.call('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, tags: ['RNG-77'], credits: [ring.document_id], payments: [{ method: 'upi', amount: 'full' }] }, 201);
    const newDoc = await request('GET', J(`documents/${again.document_id}`));
    assert.deepEqual(newDoc.payments.slice(0, 1).map((p) => [p.method, p.method_name, p.reference, p.amount]), [['credit_note', 'Credit note', doc.document_no, '1000.00']]);
    const oldDoc = await request('GET', J(`documents/${ring.document_id}`));
    assert.deepEqual(oldDoc.refunds.map((r) => [r.method, r.amount]), [['upi', money.toFixed(2)], ['credit_note', '1000.00']]);
    assert.deepEqual((await cashier.call('GET', J(`jewellery/bills/credits?contact=${lakshmi.id}`))).items, []);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_scheme.stopped' AND entity_id=$2", [jeweller.id, stopping.id]));
  });

  await t.test('the money held for gold schemes, who sees it, and the bell', async () => {
    const liability = await request('GET', J('jewellery/schemes/liability'));
    // Open: Meera's ₹3,00,000 scheme and her ₹70,000 one.
    assert.deepEqual(liability.items.map((i) => [i.plan_name, i.paid]), [['Big 2', '300000.00'], ['Quick 3', '70000.00']]);
    assert.deepEqual([liability.totals.schemes, liability.totals.paid, liability.totals.discountWhenComplete], [2, '370000.00', '35000.00']);
    assert.equal(liability.asOf, today);
    const due = await request('GET', J('jewellery/schemes?stage=paying'));
    assert.ok(due.items.every((s) => s.stage === 'paying'));
    // The open ones are those the money is held for; the rest were redeemed.
    const openList = await request('GET', J('jewellery/schemes?open=true'));
    assert.deepEqual(openList.items.map((s) => s.id).sort(), liability.items.map((i) => i.id).sort());
    assert.ok((await request('GET', J('jewellery/schemes?open=false'))).items.every((s) => s.status === 'redeemed'));
    assert.equal((await refused('GET', J('jewellery/schemes'), undefined, karigar.token)).status, 403);
    assert.equal((await refused('GET', J('jewellery/schemes/liability'), undefined, karigar.token)).status, 403);
    assert.ok((await viewer.call('GET', J('jewellery/schemes'))).total >= 4);
    assert.equal((await refused('POST', J('jewellery/schemes'), { requestKey: key(), locationId: shop.id, planId: quick.id, contactId: meera.id, instalment: '1000', termsAccepted: true,
      payment: { method: 'upi' } }, viewer.token)).status, 403);
    assert.equal((await refused('GET', `/businesses/${grocery.id}/jewellery/schemes`)).status, 403);
    // Her receipts held for her schemes are not applied to her other bills (Customer dues' apply advance leaves them).
    const polish = await request('POST', J('catalog'), { kind: 'service', unit: 'service', name: 'Polishing', code: 'POL-1', price: '500', taxRateId: gst18.id }, 201);
    await request('POST', J('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: meera.id, lines: [{ skuId: polish.id, quantity: '1' }] }, 201);
    assert.match((await refused('POST', J(`receivables/customers/${meera.id}/apply-advance`), { requestKey: key() })).message, /no advance to apply/);
    // A scheme past its close day rings the bell: its money is turned into jewellery within the year.
    const open = liability.items.find((i) => i.plan_name === 'Quick 3');
    assert.ok(!(await request('GET', J('notifications'))).items.some((n) => n.category === 'Gold schemes'));
    await backdate(open.id, 12);
    const bell = (await request('GET', J('notifications'))).items.find((n) => n.category === 'Gold schemes');
    assert.deepEqual([bell.severity, bell.title], ['critical', '1 gold scheme past the close day']);
    assert.equal((await request('GET', J(`jewellery/schemes/${open.id}`))).stage, 'past_close');
  });

  // --- The cash report --------------------------------------------------------------------------------
  await t.test('the cash report: each customer\'s cash in and out in the month to today, customers with one PAN as one, flagged at ₹10 lakh; the monthly worksheet', async () => {
    // Six customers with one PAN each sell old gold for ₹1,89,200 in cash (each under ₹2,00,000): as one person, ₹11,35,200.
    for (let n = 1; n <= 6; n += 1) {
      const sold = await cashier.call('POST', J('jewellery/old-gold'), { requestKey: key(), locationId: shop.id, customer: { name: `Ramesh Shah ${n}`, phone: `98450222${String(n).padStart(2, '0')}` },
        idKind: 'voter_id', idRef: `RS${n}000`, pan: 'BCDEF1234G', ownerDeclared: true,
        lines: [{ description: 'Old chain', metal: 'gold', purity: '22K', testMethod: 'xrf', grossWeight: '16.000', deductionPercent: '0' }] }, 201);
      assert.equal(sold.value, '189200.00');
      await payout(sold.id, { method: 'cash' });
    }
    // A walk-in's cash bill, linked to no one.
    const polish = await one("SELECT id FROM catalog_skus WHERE business_id=$1 AND code='POL-1'", [jeweller.id]);
    await request('POST', J('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, lines: [{ skuId: polish.id, quantity: '1' }], payments: [{ method: 'cash', amount: 'full' }] }, 201);
    await request('PUT', J('jewellery/settings'), { cashWatchLevel: '100000' });
    const report = await request('GET', J('jewellery/cash-report'));
    assert.deepEqual([report.to, report.from <= report.to, report.reportingLevel, report.watchLevel], [today, true, '1000000.00', '100000.00']);
    const pan = report.people.find((p) => p.key === 'pan:BCDEF1234G');
    assert.deepEqual([pan.contacts.length, pan.cashIn, pan.cashOut, pan.total, pan.largest, pan.level], [6, '0.00', '1135200.00', '1135200.00', '189200.00', 'reporting']);
    assert.equal(report.people[0].key, 'pan:BCDEF1234G', 'largest first');
    // Lakshmi: ₹1,50,000 in cash for her old gold and ₹1,000 into her scheme: past the shop's own level. Meera: ₹50,000 out, ₹10,000 of scheme instalments in.
    const lakshmi = report.people.find((p) => p.key === 'pan:ABCPK1234D');
    assert.deepEqual([lakshmi.cashIn, lakshmi.cashOut, lakshmi.level], ['1000.00', '150000.00', 'watch']);
    const meeraRow = report.people.find((p) => p.key === `contact:${meera.id}`);
    assert.deepEqual([meeraRow.cashIn, meeraRow.cashOut, meeraRow.level], ['10000.00', '50000.00', null]);
    assert.deepEqual([report.unlinked.count, report.unlinked.cashIn], [1, '590.00']);
    assert.deepEqual([report.totals.reporting, report.totals.watch], [1, 1]);
    // One person's cash, as recorded.
    const theirs = await request('GET', J('jewellery/cash-report/person?key=pan:BCDEF1234G'));
    assert.deepEqual(theirs.transactions.map((x) => [x.kind, x.cashOut]), Array(6).fill(['old_gold', '189200.00']));
    const meeraCash = await request('GET', J(`jewellery/cash-report/person?key=contact:${meera.id}`));
    assert.deepEqual(meeraCash.transactions.map((x) => x.kind).sort(), ['old_gold', 'scheme', 'scheme']);
    assert.equal((await refused('GET', J('jewellery/cash-report/person?key=nobody'))).status, 400);
    // The month's worksheet: the person above ₹10 lakh with each transaction, reported by the 15th of the next month; nothing is filed.
    const sheet = await request('GET', J(`jewellery/cash-report/month?month=${today.slice(0, 7)}`));
    assert.deepEqual(sheet.people.map((p) => [p.key, p.total, p.transactions.length]), [['pan:BCDEF1234G', '1135200.00', 6]]);
    assert.match(sheet.dueBy, /^\d{4}-\d{2}-15$/);
    assert.ok(sheet.dueBy > today);
    assert.equal((await refused('GET', J('jewellery/cash-report/month?month=2026-13'))).status, 400);
    // The bell, and the owner saying the shop is a reporting entity.
    const items = (await request('GET', J('notifications'))).items.filter((n) => n.category === 'Cash report');
    assert.deepEqual(items.map((n) => [n.severity, n.title]), [['critical', 'Cash with 1 customer reached ₹10 lakh in a month'], ['warning', '1 customer past the shop\'s cash alert level']]);
    const s = await request('PUT', J('jewellery/settings'), { reportingEntity: true });
    assert.equal(s.reportingEntity, true);
    assert.ok(s.reportingEntityAt);
    assert.equal((await request('GET', J('jewellery/cash-report'))).reportingEntity, true);
    assert.equal((await refused('PUT', J('jewellery/settings'), { cashWatchLevel: '1000000' })).status, 400);
    // Who sees it: the report is for those who may export it.
    assert.equal((await refused('GET', J('jewellery/cash-report'), undefined, cashier.token)).status, 403);
    assert.equal((await refused('GET', J('jewellery/cash-report'), undefined, karigar.token)).status, 403);
    assert.equal((await refused('GET', J('jewellery/cash-report'), undefined, viewer.token)).status, 403);
    assert.ok((await manager.call('GET', J('jewellery/cash-report'))).people.length >= 3);
    assert.equal((await refused('GET', `/businesses/${grocery.id}/jewellery/cash-report`)).status, 403);
    assert.ok(!(await cashier.call('GET', J('notifications'))).items.some((n) => n.category === 'Cash report'));
  });
});
