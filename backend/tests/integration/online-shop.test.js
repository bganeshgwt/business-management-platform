const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { signIn } = require('./helpers/signIn');
const { publishNotice } = require('./helpers/privacy');

// The online shop (BUSINESS_RULES.md › Online shop), end to end through the
// API, as a kirana, a pharmacy, a farm-input shop and an optician would run it:
//   - the application in the catalogue, off until the owner switches it on,
//     with its permissions in the roles;
//   - the settings: a link per location, delivery with its PIN codes, a new link;
//   - what shows online, and each rule that keeps an item off whatever the
//     settings say: from the lists, search, item pages, cart checks and placing;
//   - prices (the walk-in price at the location, never above the MRP) and the
//     cart checked again; the minimum order, the delivery charge and free
//     above, the PIN code area, slots and their caps, pause and closed hours;
//   - placing once for one clientKey; the limits per mobile and per address;
//     the block list;
//   - accepting (the customer made then, with their consents), declining, and
//     the shop's own rule declining an order not accepted in time;
//   - packing: short, not available, weighed, a replacement within the total
//     and one above it with the guest's OK (or a call), and a lower price;
//   - billing through the core at the order's prices, the delivery charge
//     split by GST rate, batches with 45 days left first, stock;
//   - payment at pickup and on delivery, refused at the door through returns;
//   - complaints and their clocks; the audit rows with no actor; the events
//     and the bell;
//   - the module off and the plan ended; erasure through the registry;
//   - this migration's Down half and Up again.
test('online shop', { timeout: 900000 }, async (t) => {
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
  process.env.TRUST_PROXY = '1';
  process.env.DB_POOL_GUARD = 'throw';
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Shop-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  async function owner(code) {
    const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', [code]);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, `Owner ${code}`, `${code}@test.invalid`, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
    return person;
  }
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth, headers = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
  }
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const refusedAs = (auth) => async (method, route, body, expected) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return { message: result.body.message, ...(result.body.data || {}) };
  };
  // A guest: no login, each from an address of their own (the per-address limits count by it).
  let addresses = 0;
  const nextAddress = () => { addresses += 1; return `10.20.${Math.floor(addresses / 250)}.${(addresses % 250) + 1}`; };
  async function guest(method, route, body, expected = 200, address = nextAddress()) {
    const result = await call(method, `/public/shop${route}`, body, null, { 'X-Forwarded-For': address });
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    return expected < 300 ? { ...(result.body.data || {}), live: result.body.live } : { message: result.body.message, ...(result.body.data || {}) };
  }
  const key = () => crypto.randomUUID();
  const ownerA = await owner('shop-a');
  await owner('shop-b');
  const tokenA = (await signIn(base, 'shop-a@test.invalid', password)).token;
  const A = as(tokenA);
  const refusedA = refusedAs(tokenA);
  const B = as((await signIn(base, 'shop-b@test.invalid', password)).token);
  const [grocery, pharmacy, agri, optical] = await createBusinesses(A, 'SHOP', ['grocery', 'pharmacy', 'agri_inputs', 'optical']);
  const [elsewhere] = await createBusinesses(B, 'ELSEWHERE', ['grocery']);
  const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
  const S = (suffix) => `/businesses/${grocery.id}/online-shop/${suffix}`;
  const mainOf = async (business) => (await A('GET', `/businesses/${business.id}/locations`)).items[0];
  const groceryMain = await mainOf(grocery);
  const audits = (businessId, action) => all('SELECT * FROM business_audit WHERE business_id=$1 AND action=$2 ORDER BY id', [businessId, action]);
  const events = (businessId, kind) => all('SELECT * FROM business_events WHERE business_id=$1 AND kind=$2 ORDER BY id', [businessId, kind]);

  // --- The application ----------------------------------------------------------------------------
  await t.test('the online shop is an application sold on its own, off until the owner switches it on, with its permissions in the roles', async () => {
    const module = await one("SELECT kind,sort_order FROM platform_modules WHERE code='online_shop'");
    assert.equal(module.kind, 'optional');
    const price = await one("SELECT sold_as,monthly_price,yearly_price FROM platform_module_prices WHERE module_code='online_shop'");
    assert.deepEqual([price.sold_as, Number(price.monthly_price), Number(price.yearly_price)], ['application', 399, 3999]);
    const types = (await all("SELECT business_type,enabled_by_default FROM platform_module_business_types WHERE module_code='online_shop' ORDER BY 1"));
    assert.deepEqual(types.map((row) => row.business_type), ['agri_inputs', 'books', 'electronics', 'fashion', 'general_retail', 'grocery', 'hardware', 'meat', 'optical', 'pharmacy',
      'supermarket', 'weight_retail']);
    assert.ok(types.every((row) => !row.enabled_by_default));
    assert.deepEqual((await all("SELECT requires_module_code FROM platform_module_dependencies WHERE module_code='online_shop' ORDER BY 1")).map((row) => row.requires_module_code), ['contacts', 'sales']);
    const modules = await A('GET', G('modules'));
    assert.equal(modules.find((m) => m.code === 'online_shop').enabled, false);
    await refusedA('GET', S('settings'), undefined, 403);
    for (const business of [grocery, pharmacy, agri, optical]) await A('PUT', `/businesses/${business.id}/modules/online_shop`, { enabled: true });
    // The shared roles hold their part; the Owner holds everything.
    const roles = (await A('GET', G('roles'))).items;
    const grants = (template) => roles.find((role) => role.template_code === template).permissions.filter((code) => code.startsWith('online_shop.')).sort();
    assert.deepEqual(grants('manager'), ['online_shop.approve', 'online_shop.cancel', 'online_shop.edit', 'online_shop.export', 'online_shop.manage', 'online_shop.review', 'online_shop.view']);
    assert.deepEqual(grants('cashier'), ['online_shop.approve', 'online_shop.cancel', 'online_shop.edit', 'online_shop.review', 'online_shop.view']);
    assert.deepEqual(grants('stock_keeper'), ['online_shop.edit', 'online_shop.view']);
    assert.deepEqual(grants('accountant'), ['online_shop.export', 'online_shop.view']);
    assert.deepEqual(grants('viewer'), ['online_shop.export', 'online_shop.view']);
    // Another owner's business is not there at all.
    await refusedAs((await signIn(base, 'shop-b@test.invalid', password)).token)('GET', S('settings'), undefined, 404);
    await B('PUT', `/businesses/${elsewhere.id}/modules/online_shop`, { enabled: true });
  });

  // --- Settings -------------------------------------------------------------------------------------
  let link;
  await t.test('settings: a link per location, off, pickup on; delivery needs its PIN codes; a new link ends the old one', async () => {
    const { links } = await A('GET', S('settings'));
    assert.equal(links.length, 1);
    [link] = links;
    assert.match(link.token, /^[a-f0-9]{48}$/);
    assert.equal(link.path, `/shop/${link.token}`);
    assert.deepEqual([link.enabled, link.pickupEnabled, link.deliveryEnabled, link.payAtShop, link.maxOpenPerMobile, link.autoDeclineMinutes, link.hideOutOfStock],
      [false, true, false, true, 2, 30, true]);
    assert.deepEqual([link.deliveryFee, link.freeDeliveryAbove, link.minOrder, link.deliveryMinutes], [30, 500, 0, 60]);
    assert.match(link.policy, /^Returns and refunds:/);
    assert.match(link.policy, /Fresh produce/);
    assert.deepEqual([link.grievanceName, link.grievanceDesignation], ['Owner shop-a', 'Owner']);
    // An off link shows the calm page, nothing more.
    const off = await guest('GET', `/${link.token}`);
    assert.deepEqual([off.shop.taking, off.shop.reason, off.items.items.length], [false, 'off', 0]);
    let refused = await refusedA('PUT', S(`settings/${groceryMain.id}`), { deliveryEnabled: true }, 400);
    assert.match(refused.message, /PIN codes/);
    refused = await refusedA('PUT', S(`settings/${groceryMain.id}`), { deliveryPins: ['50003'] }, 400);
    assert.match(refused.message, /6 digits/);
    refused = await refusedA('PUT', S(`settings/${groceryMain.id}`), { upiId: 'not a upi' }, 400);
    assert.match(refused.message, /shopname@bank/);
    refused = await refusedA('PUT', S(`settings/${groceryMain.id}`), { pickupEnabled: false }, 400);
    assert.match(refused.message, /Offer pickup, delivery or both/);
    link = await A('PUT', S(`settings/${groceryMain.id}`), { enabled: true, deliveryEnabled: true, deliveryPins: ['500034', '500033', '500034'], minOrder: '100',
      upiId: 'kirana@okaxis', upiPayee: 'Sri Ganesh Kirana', fssaiLicence: '12345678901234', carePhone: '98450 11111' });
    assert.deepEqual([link.enabled, link.deliveryPins], [true, ['500033', '500034']]);
    // The settings make the "Delivery charge" service item its bills use.
    const delivery = await one('SELECT s.label,s.tracking,p.kind FROM catalog_skus s JOIN catalog_products p ON p.id=s.product_id WHERE s.id=$1', [link.deliveryItemId]);
    assert.deepEqual([delivery.label, delivery.tracking, delivery.kind], ['Delivery charge', 'none', 'service']);
    // A new link: the old address stops working at once.
    const old = link.token;
    link = await A('POST', S(`settings/${groceryMain.id}/new-link`), {});
    assert.notEqual(link.token, old);
    await guest('GET', `/${old}`, undefined, 404);
    assert.equal((await audits(grocery.id, 'online_shop.link_replaced')).length, 1);
    assert.ok((await audits(grocery.id, 'online_shop.settings_updated')).length >= 1);
  });

  // --- What shows online ---------------------------------------------------------------------------
  const items = {};
  const item = async (business, body, stock = null) => {
    const sku = await A('POST', `/businesses/${business.id}/catalog`, { kind: 'goods', unit: 'each', tracking: 'quantity', ...body }, 201);
    if (stock) await A('POST', `/businesses/${business.id}/documents`, { kind: 'purchase', requestKey: key(), locationId: (await mainOf(business)).id,
      contactId: suppliers[business.id], lines: [{ skuId: sku.id, quantity: String(stock.quantity), unitPrice: String(stock.cost || 1), ...(stock.lot ? { lotCode: stock.lot, expiresOn: stock.expiresOn } : {}) }] }, 201);
    return sku;
  };
  const suppliers = {};
  const shopOf = async (business) => {
    const [first] = (await A('GET', `/businesses/${business.id}/online-shop/settings`)).links;
    return A('PUT', `/businesses/${business.id}/online-shop/settings/${first.locationId}`, { enabled: true });
  };
  const listed = async (token, q) => (await guest('GET', `/${token}/items${q ? `?q=${encodeURIComponent(q)}` : ''}`)).items;
  const names = (cards) => cards.map((card) => card.name).sort();
  const dayIn = (days) => {
    const [y, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  await t.test('what shows online: goods with a price and stock at the location, unless hidden; and each rule that keeps an item off whatever the settings say', async () => {
    for (const business of [grocery, pharmacy, agri, optical]) suppliers[business.id] = (await A('POST', `/businesses/${business.id}/contacts`, { kind: 'supplier', name: 'Metro Wholesale' }, 201)).id;
    const staples = await A('POST', G('categories'), { name: 'Staples' }, 201);
    const pooja = await A('POST', G('categories'), { name: 'Pooja needs' }, 201);
    const agarbatti = await A('POST', G('categories'), { name: 'Agarbatti', parentId: pooja.id }, 201);
    Object.assign(items, {
      atta: await item(grocery, { name: 'Aashirvaad Atta 5 kg', code: 'ATTA5', price: '285', mrp: '300', taxRate: '5', hsnCode: '1101', categoryId: staples.id }, { quantity: 20, cost: 240 }),
      rice: await item(grocery, { name: 'Sona Masoori rice (loose)', code: 'RICE', unit: 'kg', price: '60', taxRate: '5', hsnCode: '1006', categoryId: staples.id }, { quantity: 50, cost: 48 }),
      butter: await item(grocery, { name: 'Amul Butter 500 g', code: 'BUTTER', price: '275', mrp: '285', taxRate: '12', hsnCode: '0405' }, { quantity: 3, cost: 250 }),
      cheaper: await item(grocery, { name: 'Mother Dairy Butter 500 g', code: 'BUTTER2', price: '250', mrp: '260', taxRate: '12', hsnCode: '0405' }, { quantity: 10, cost: 220 }),
      ghee: await item(grocery, { name: 'Amul Ghee 1 L', code: 'GHEE', price: '600', mrp: '650', taxRate: '12', hsnCode: '0405' }),
      milk: await item(grocery, { name: 'Everyday milk powder 400 g', code: 'MILKP', tracking: 'batch', price: '420', mrp: '450', taxRate: '5', hsnCode: '0402' }),
      thai: await item(grocery, { name: 'Thai jasmine rice 1 kg', code: 'THAI', price: '199', taxRate: '5', hsnCode: '1006', categoryId: staples.id }, { quantity: 8, cost: 150 }),
      dhoop: await item(grocery, { name: 'Cycle dhoop sticks', code: 'DHOOP', price: '40', taxRate: '5', hsnCode: '3307', categoryId: agarbatti.id }, { quantity: 30, cost: 30 }),
      soap: await item(grocery, { name: 'Lux soap 100 g', code: 'SOAP', price: '45', taxRate: '18', hsnCode: '3401' }, { quantity: 30, cost: 35 }),
      wrapping: await A('POST', G('catalog'), { kind: 'service', unit: 'service', name: 'Gift wrapping', code: 'WRAP', price: '20', taxRate: '18' }, 201),
      cleaner: await item(grocery, { name: 'Floor cleaner for the shop', code: 'CLEAN', price: '90', taxRate: '18', internalUse: true }, { quantity: 5, cost: 80 }),
      diesel: await item(grocery, { name: 'Diesel (loose)', code: 'DIESEL', unit: 'litre', price: '92', taxRate: '0' }, { quantity: 20, cost: 88 }),
      classic: await item(grocery, { name: 'Classic Milds 20', code: 'CIG', price: '340', taxRate: '40', hsnCode: '2402' }, { quantity: 10, cost: 300 }),
      beedi: await item(grocery, { name: 'Ganesh beedi bundle', code: 'BEEDI', price: '30', taxRate: '18' }, { quantity: 10, cost: 25 }),
      lighter: await item(grocery, { name: 'Cigarette lighter', code: 'LIGHTER', price: '25', taxRate: '18', hsnCode: '9613' }, { quantity: 10, cost: 15 }),
      beer: await item(grocery, { name: 'Kingfisher 650 ml', code: 'BEER', price: '180', taxRate: '18', hsnCode: '2203' }, { quantity: 10, cost: 150 }),
      bag: await item(grocery, { name: 'Carry bag', code: 'BAG', price: '0', taxRate: '0' }, { quantity: 100, cost: 1 }),
    });
    // The milk powder in two batches: a short-dated one, and one with months to go.
    await A('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: groceryMain.id, contactId: suppliers[grocery.id], lines: [
      { skuId: items.milk.id, quantity: '5', unitPrice: '380', lotCode: 'MP-SHORT', expiresOn: dayIn(20) },
      { skuId: items.milk.id, quantity: '1', unitPrice: '380', lotCode: 'MP-LONG', expiresOn: dayIn(200) }] }, 201);
    items.combo = await A('POST', G('kits'), { name: 'Festive combo', code: 'COMBO', price: '540', components: [{ skuId: items.atta.id, quantity: 1 }, { skuId: items.cheaper.id, quantity: 1 }] }, 201);
    // A fuel is a fuel station's, sold by its meters: a shop's item made one is never online.
    await pool.query("INSERT INTO fuel_products(business_id,sku_id,family,created_by) VALUES($1,$2,'diesel',$3)", [grocery.id, items.diesel.id, ownerA.id]);
    await A('PUT', S(`items/${items.soap.product_id}`), { hidden: true });
    await A('PUT', S(`categories/${pooja.id}`), { hidden: true });

    // The pharmacy's prescription medicine; the farm-input shop's subsidised fertiliser and restricted pesticide; the optician's contact lens.
    const azithral = await item(pharmacy, { name: 'Azithral 500 tablets', code: 'AZI500', tracking: 'batch', price: '120', taxRate: '12', hsnCode: '3004' });
    const crocin = await item(pharmacy, { name: 'Crocin 650 tablets', code: 'CROCIN', tracking: 'batch', price: '35', taxRate: '12', hsnCode: '3004' });
    for (const [sku, lot] of [[azithral, 'AZ1'], [crocin, 'CR1']]) {
      await A('POST', `/businesses/${pharmacy.id}/documents`, { kind: 'purchase', requestKey: key(), locationId: (await mainOf(pharmacy)).id, contactId: suppliers[pharmacy.id],
        lines: [{ skuId: sku.id, quantity: '20', unitPrice: '20', lotCode: lot, expiresOn: dayIn(400) }] }, 201);
    }
    await A('PUT', `/businesses/${pharmacy.id}/pharmacy/drugs/${azithral.id}`, { composition: 'Azithromycin', strength: '500 mg', form: 'tablet', schedule: 'H' });
    await A('PUT', `/businesses/${pharmacy.id}/pharmacy/drugs/${crocin.id}`, { composition: 'Paracetamol', strength: '650 mg', form: 'tablet', schedule: 'none' });
    const urea = await item(agri, { name: 'Neem coated urea 45 kg', code: 'UREA', price: '266.50', taxRate: '5', attributes: { inputKind: 'fertiliser', subsidised: 'yes' } }, { quantity: 10, cost: 240 });
    const celphos = await item(agri, { name: 'Celphos tablets', code: 'CELPHOS', tracking: 'batch', price: '350', taxRate: '18', attributes: { inputKind: 'pesticide', molecules: ['Aluminium phosphide'], formulation: '56% TAB' } },
      { quantity: 10, cost: 300, lot: 'CP-01', expiresOn: dayIn(300) });
    const sprayer = await item(agri, { name: 'Knapsack sprayer 16 L', code: 'SPRAYER', price: '1450', taxRate: '18', hsnCode: '8424' }, { quantity: 4, cost: 1100 });
    const lens = await item(optical, { name: 'Acuvue Oasys -2.00', code: 'ACU200', price: '1600', taxRate: '12', hsnCode: '9001' }, { quantity: 6, cost: 1200 });
    await pool.query(`UPDATE catalog_skus SET attributes=attributes||'{"baseCurve":"8.4","power":"-2.00"}' WHERE id=$1`, [lens.id]);
    const frame = await item(optical, { name: 'Titan frame TF-12', code: 'TF12', price: '1800', taxRate: '18', hsnCode: '9003' }, { quantity: 3, cost: 1000 });

    // The kirana's shop: only what may be shown.
    const shown = names(await listed(link.token));
    assert.deepEqual(shown, ['Aashirvaad Atta 5 kg', 'Amul Butter 500 g', 'Cigarette lighter', 'Everyday milk powder 400 g', 'Mother Dairy Butter 500 g', 'Sona Masoori rice (loose)',
      'Thai jasmine rice 1 kg']);
    // Each rule's item, and each hidden one: not listed, not found by search, no item page, gone from a cart, refused when ordered.
    const never = { wrapping: 'service', cleaner: 'internal_use', combo: 'kit', diesel: 'special_type', classic: 'tobacco', beedi: 'tobacco', beer: 'alcohol' };
    for (const [name, code] of Object.entries(never)) {
      const sku = items[name];
      assert.deepEqual(await listed(link.token, sku.label.split(' ')[0]).then((cards) => cards.filter((card) => card.productId === Number(sku.product_id))), [], `${name} is not listed`);
      const page = await guest('GET', `/${link.token}/items/${sku.product_id}`, undefined, 404);
      assert.equal(page.reason, 'item_gone');
      const cart = await guest('POST', `/${link.token}/cart`, { service: 'pickup', lines: [{ skuId: sku.id, quantity: 1, price: Number(sku.price) }] });
      assert.equal(cart.lines[0].problem, 'gone', `${name} is gone from a cart`);
      const staff = await A('GET', S(`items?q=${encodeURIComponent(sku.label)}`));
      if (code !== 'service') assert.equal(staff.items.find((row) => row.skuId === Number(sku.id))?.never, code, `${name} is kept off as ${code}`);
    }
    for (const name of ['soap', 'dhoop', 'ghee', 'bag']) {
      assert.equal((await guest('GET', `/${link.token}/items/${items[name].product_id}`, undefined, 404)).reason, 'item_gone', `${name} has no page`);
    }
    // A name that says tobacco keeps off only an item with no HSN code: the lighter has its own.
    assert.ok(shown.includes('Cigarette lighter'));
    const staffRows = (await A('GET', S('items?state=hidden'))).items.map((row) => row.name).sort();
    assert.deepEqual(staffRows, ['Cycle dhoop sticks', 'Lux soap 100 g']);
    // With "Hide items out of stock" off, the ghee shows, out of stock.
    await A('PUT', S(`settings/${groceryMain.id}`), { hideOutOfStock: false });
    const ghee = (await listed(link.token, 'ghee'))[0];
    assert.deepEqual([ghee.name, ghee.variants[0].stock, ghee.variants[0].max], ['Amul Ghee 1 L', 'out', 0]);
    await A('PUT', S(`settings/${groceryMain.id}`), { hideOutOfStock: true });

    // The other shops' rules.
    const pharmacyShop = await shopOf(pharmacy);
    assert.deepEqual(names(await listed(pharmacyShop.token)), ['Crocin 650 tablets']);
    assert.equal((await A('GET', `/businesses/${pharmacy.id}/online-shop/items?q=Azithral`)).items[0].never, 'prescription');
    const agriShop = await shopOf(agri);
    assert.deepEqual(names(await listed(agriShop.token)), ['Knapsack sprayer 16 L']);
    const agriStaff = (await A('GET', `/businesses/${agri.id}/online-shop/items`)).items;
    assert.equal(agriStaff.find((row) => row.skuId === Number(urea.id)).never, 'subsidised_fertiliser');
    assert.equal(agriStaff.find((row) => row.skuId === Number(celphos.id)).never, 'restricted_pesticide');
    assert.ok(agriStaff.find((row) => row.skuId === Number(sprayer.id)).shown);
    const opticalShop = await shopOf(optical);
    assert.deepEqual(names(await listed(opticalShop.token)), ['Titan frame TF-12']);
    assert.equal((await A('GET', `/businesses/${optical.id}/online-shop/items`)).items.find((row) => row.skuId === Number(lens.id)).never, 'contact_lens');
    assert.ok(frame.id);
    // Settings show how ready the items are: shown, without a photo or maker, and what the rules keep off.
    const { links: [ready] } = await A('GET', S('settings'));
    assert.equal(ready.readiness.shown, 7);
    assert.equal(ready.readiness.withoutPhoto, 7);
    assert.deepEqual(Object.fromEntries(ready.readiness.neverOnline.map((row) => [row.code, row.count])),
      { alcohol: 1, internal_use: 1, kit: 1, service: 2, special_type: 1, tobacco: 2 });
  });

  // --- The shop page ----------------------------------------------------------------------------
  await t.test('the shop page: the seller and the policy, categories, search, an item page with its declarations and unit price, countries of imported items', async () => {
    await A('PUT', S(`items/${items.atta.product_id}`), { makerKind: 'manufacturer', makerName: 'ITC Limited', makerAddress: 'Virginia House, Kolkata 700071',
      netQuantity: '5 kg', consumerCare: '1800 425 444 444', countryOfOrigin: 'India', description: 'Whole wheat atta, stone ground.' });
    await A('PUT', S(`items/${items.thai.product_id}`), { makerKind: 'importer', makerName: 'Siam Foods India', countryOfOrigin: 'Thailand' });
    // The walk-in price at the link's location: its branch price.
    await A('PUT', G(`catalog/${items.atta.id}/branch-prices`), { prices: [{ locationId: groceryMain.id, price: '280' }] });
    const page = await guest('GET', `/${link.token}`);
    assert.equal(page.card.name, 'Sri Ganesh Kirana Stores');
    assert.deepEqual([page.shop.taking, page.shop.reason], [true, null]);
    assert.equal(page.shop.seller.fssai, '12345678901234');
    assert.deepEqual(page.shop.seller.grievance, { name: 'Owner shop-a', designation: 'Owner', phone: null, email: null });
    assert.match(page.shop.policy, /Cancelling: cancel free of charge/);
    assert.deepEqual(page.shop.delivery, { fee: 30, freeAbove: 500, minOrder: 100, minutes: 60, pins: ['500033', '500034'], areaNote: null, slots: false });
    assert.equal(page.card.privacy, null);
    assert.deepEqual(page.categories.map((c) => [c.name, c.count]), [['Staples', 3]]);
    assert.deepEqual(page.countries, [{ name: 'Thailand', count: 1 }]);
    const atta = page.items.items.find((card) => card.name === 'Aashirvaad Atta 5 kg');
    assert.deepEqual([atta.variants[0].price, atta.variants[0].mrp, atta.variants[0].stock], [280, 300, 'in']);
    const butter = page.items.items.find((card) => card.name === 'Amul Butter 500 g');
    assert.deepEqual([butter.variants[0].stock, butter.variants[0].left, butter.variants[0].max], ['low', 3, 3]);
    const rice = page.items.items.find((card) => card.name === 'Sona Masoori rice (loose)');
    assert.deepEqual([rice.variants[0].weighed, rice.variants[0].step, rice.variants[0].max, rice.variants[0].unit], [true, 0.25, 25, 'kg']);
    // Search finds by any of its words; a category and a country narrow it.
    assert.deepEqual(names(await listed(link.token, 'rice')), ['Sona Masoori rice (loose)', 'Thai jasmine rice 1 kg']);
    assert.deepEqual(names(await listed(link.token, 'staples atta')), ['Aashirvaad Atta 5 kg']);
    assert.deepEqual(names((await guest('GET', `/${link.token}/items?country=Thailand`)).items), ['Thai jasmine rice 1 kg']);
    assert.equal((await guest('GET', `/${link.token}/items?sort=price_high`)).items[0].name, 'Everyday milk powder 400 g');
    const detail = await guest('GET', `/${link.token}/items/${items.atta.product_id}`);
    assert.equal(detail.description, 'Whole wheat atta, stone ground.');
    assert.deepEqual(detail.declarations.map((row) => row.label), ['Manufactured by', 'Net quantity', 'Country of origin', 'Consumer care']);
    assert.deepEqual(detail.variants[0].unitSalePrice, { amount: 56, per: 'kg' });
  });

  // --- The cart -----------------------------------------------------------------------------------
  await t.test('the cart is checked against today\'s prices and stock, and says what is missing for delivery', async () => {
    const cart = await guest('POST', `/${link.token}/cart`, { service: 'delivery', lines: [
      { skuId: items.atta.id, quantity: 1, price: 285 }, { skuId: items.butter.id, quantity: 5, price: 275 }, { skuId: items.rice.id, quantity: 0.3, price: 60 },
      { skuId: items.beer.id, quantity: 1, price: 180, name: 'Kingfisher 650 ml' }] });
    assert.deepEqual(cart.lines.map((line) => [line.skuId, line.problem, line.quantity]), [[Number(items.atta.id), 'price', 1], [Number(items.butter.id), 'less', 3],
      [Number(items.rice.id), 'quantity', 0.25], [Number(items.beer.id), 'gone', 0]]);
    assert.equal(cart.changed, true);
    // ₹280 + ₹825 + ₹15: free delivery above ₹500.
    assert.deepEqual([cart.totals.items, cart.totals.delivery, cart.totals.total, cart.totals.moreForFree], [1120, 0, 1120, 0]);
    const small = await guest('POST', `/${link.token}/cart`, { service: 'delivery', lines: [{ skuId: items.lighter.id, quantity: 2, price: 25 }] });
    assert.deepEqual([small.totals.items, small.totals.delivery, small.totals.total, small.totals.moreForFree, small.totals.moreForMinimum], [50, 30, 80, 450, 50]);
    assert.equal(small.changed, false);
  });

  // --- Placing ----------------------------------------------------------------------------------
  const order = (lines, extra = {}) => ({ clientKey: key(), service: 'pickup', paymentMode: 'pay_at_shop', name: 'Priya Sharma', mobile: '98480 12345', lines, ...extra });
  const priced = (sku, quantity, price) => ({ skuId: sku.id, quantity, price });
  let notice, first;
  await t.test('placing: checked, limited per mobile and per address, the block list, and one order for one clientKey', async () => {
    notice = await publishNotice(A, `/businesses/${grocery.id}`);
    const contactsBefore = (await one('SELECT count(*)::int AS n FROM business_contacts WHERE business_id=$1', [grocery.id])).n;
    let refused = await guest('POST', `/${link.token}/orders`, order([priced(items.atta, 1, 280)], { mobile: '12345', total: 280 }), 400);
    assert.equal(refused.field, 'mobile');
    refused = await guest('POST', `/${link.token}/orders`, order([priced(items.atta, 1, 280)], { name: '1', total: 280 }), 400);
    assert.equal(refused.field, 'name');
    const body = order([priced(items.atta, 1, 280), priced(items.rice, 1, 60)], { total: 340, consents: ['bills_digital', 'offers'], privacyNoticeId: notice.id, note: 'Please pack the rice well' });
    first = await guest('POST', `/${link.token}/orders`, body, 201);
    assert.match(first.order.orderNo, /^ON-0001$/);
    assert.deepEqual([first.order.status, first.order.stage.key, first.order.totals.total, first.order.totals.allowance, first.order.canCancel, first.order.canChange],
      ['placed', 'placed', 340, 6, true, true]);
    assert.ok(first.live && first.live.key);
    const autoAt = new Date(first.order.autoDeclineAt).getTime();
    assert.ok(Math.abs(autoAt - (Date.now() + 30 * 60000)) < 120000, 'declined by itself 30 minutes after placing');
    // The same order again: one order. The same key with another body: refused.
    const again = await guest('POST', `/${link.token}/orders`, body, 200);
    assert.equal(again.order.orderNo, first.order.orderNo);
    refused = await guest('POST', `/${link.token}/orders`, { ...body, note: 'Something else' }, 409);
    assert.equal(refused.reason, 'key_reused');
    // No customer yet: one is made when the shop accepts.
    assert.equal((await one('SELECT count(*)::int AS n FROM business_contacts WHERE business_id=$1', [grocery.id])).n, contactsBefore);
    // A guest's own row: no actor, "Guest (online)"; its event has no actor either.
    const [placed] = await audits(grocery.id, 'online_order.placed');
    assert.deepEqual([placed.actor_id, placed.channel], [null, 'guests_site']);
    assert.equal((await events(grocery.id, 'online_order.placed'))[0].actor_id, null);
    // A price changed meanwhile: the guest sees it and accepts it first.
    await A('PATCH', G(`catalog/${items.lighter.id}`), { label: 'Cigarette lighter', price: '28', taxRate: '18' });
    refused = await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 25)], { mobile: '9000000001', total: 25 }), 409);
    assert.deepEqual([refused.reason, refused.lines[0].problem, refused.lines[0].price], ['cart_changed', 'price', 28]);
    refused = await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 28)], { mobile: '9000000001', total: 27 }), 409);
    assert.equal(refused.reason, 'cart_changed');
    // Two open orders per mobile at most.
    await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 28)], { total: 28 }), 201);
    refused = await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 28)], { total: 28 }), 409);
    assert.equal(refused.reason, 'too_many_open');
    // A mobile the shop blocked is refused, whatever it orders.
    await A('POST', S('blocked'), { mobile: '+91 90000 00666', reason: 'Refused three cash-on-delivery orders' }, 201);
    await refusedA('POST', S('blocked'), { mobile: '9000000666', reason: 'Again' }, 409);
    refused = await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 28)], { mobile: '9000000666', total: 28 }), 403);
    assert.equal(refused.reason, 'blocked');
    const blocked = await A('GET', S('blocked'));
    assert.equal(blocked.blocked[0].mobile, '9000000666');
    await A('POST', S(`blocked/${blocked.blocked[0].id}/lift`), {});
    await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 28)], { mobile: '9000000666', total: 28 }), 201);
    // One network address may send so many orders in ten minutes.
    const address = nextAddress();
    for (let n = 0; n < 20; n += 1) await guest('POST', `/${link.token}/orders`, { clientKey: key() }, 400, address);
    await guest('POST', `/${link.token}/orders`, { clientKey: key() }, 429, address);
  });

  // --- Delivery ---------------------------------------------------------------------------------
  await t.test('delivery: the PIN code area, the minimum order, the charge and free above, slots with their caps, pause and closed hours', async () => {
    const address = { address: 'Flat 302, Sai Residency, Road No. 12, Banjara Hills', landmark: 'Opposite the temple', pinCode: '500034' };
    const delivery = (lines, total, extra = {}) => order(lines, { service: 'delivery', paymentMode: 'cash_on_delivery', address, total, ...extra });
    let refused = await guest('POST', `/${link.token}/orders`, delivery([priced(items.atta, 1, 280)], 310, { mobile: '9000000002', address: { ...address, pinCode: '500081' } }), 409);
    assert.deepEqual([refused.reason, refused.field], ['outside_area', 'pinCode']);
    assert.match(refused.message, /does not deliver to 500081/);
    refused = await guest('POST', `/${link.token}/orders`, delivery([priced(items.lighter, 2, 28)], 86, { mobile: '9000000002' }), 409);
    assert.equal(refused.reason, 'below_minimum');
    refused = await guest('POST', `/${link.token}/orders`, delivery([priced(items.atta, 1, 280)], 310, { mobile: '9000000002', paymentMode: 'pay_at_shop' }), 400);
    assert.equal(refused.reason, 'payment_mode');
    const charged = await guest('POST', `/${link.token}/orders`, delivery([priced(items.atta, 1, 280)], 310, { mobile: '9000000002' }), 201);
    assert.deepEqual([charged.order.totals.items, charged.order.totals.delivery, charged.order.totals.total], [280, 30, 310]);
    const free = await guest('POST', `/${link.token}/orders`, delivery([priced(items.atta, 2, 280)], 560, { mobile: '9000000003' }), 201);
    assert.deepEqual([free.order.totals.delivery, free.order.totals.total], [0, 560]);
    // Slots: chosen when the shop offers them, each taking its cap.
    await A('PUT', S(`settings/${groceryMain.id}`), { slotsEnabled: true, slots: [{ from: '10:00', to: '12:00', cap: 1 }, { from: '17:00', to: '19:00', cap: 5 }] });
    refused = await guest('POST', `/${link.token}/orders`, delivery([priced(items.atta, 1, 280)], 310, { mobile: '9000000004' }), 400);
    assert.equal(refused.field, 'slot');
    const tomorrow = dayIn(1);
    const cart = await guest('POST', `/${link.token}/cart`, { service: 'delivery', lines: [priced(items.atta, 1, 280)] });
    assert.ok(cart.slots.some((slot) => slot.date === tomorrow && slot.from === '10:00' && slot.open));
    const slotted = await guest('POST', `/${link.token}/orders`, delivery([priced(items.atta, 1, 280)], 310, { mobile: '9000000004', slot: { date: tomorrow, from: '10:00' } }), 201);
    assert.deepEqual(slotted.order.slot, { date: tomorrow, from: '10:00', to: '12:00' });
    refused = await guest('POST', `/${link.token}/orders`, delivery([priced(items.atta, 1, 280)], 310, { mobile: '9000000005', slot: { date: tomorrow, from: '10:00' } }), 409);
    assert.equal(refused.reason, 'slot_full');
    await A('PUT', S(`settings/${groceryMain.id}`), { slotsEnabled: false });
    // Paused: the shop shows, and takes no order.
    await A('PUT', S(`settings/${groceryMain.id}`), { paused: true });
    assert.deepEqual([(await guest('GET', `/${link.token}`)).shop.reason, (await listed(link.token)).length > 0], ['paused', true]);
    refused = await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 28)], { mobile: '9000000006', total: 28 }), 409);
    assert.equal(refused.reason, 'paused');
    await A('PUT', S(`settings/${groceryMain.id}`), { paused: false });
    // Closed now: an order waits for the opening, and its clock starts then; or the shop takes none.
    const [hh, mm] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number);
    const at = (minutes) => { const m = (((hh * 60 + mm + minutes) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    await A('PATCH', G(`locations/${groceryMain.id}`), { name: groceryMain.name, active: true, openingHours: Object.fromEntries(days.map((day) => [day, { open: at(120), close: at(180) }])) });
    const closed = await guest('GET', `/${link.token}`);
    assert.equal(closed.shop.taking, true);
    assert.match(closed.shop.whenClosed, /We'll pack it when we open/);
    const waiting = await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 28)], { mobile: '9000000007', total: 28 }), 201);
    assert.ok(new Date(waiting.order.autoDeclineAt).getTime() > Date.now() + 140 * 60000, 'counted from the opening');
    await A('PUT', S(`settings/${groceryMain.id}`), { takeOrdersWhenClosed: false });
    refused = await guest('POST', `/${link.token}/orders`, order([priced(items.lighter, 1, 28)], { mobile: '9000000008', total: 28 }), 409);
    assert.equal(refused.reason, 'closed');
    await A('PUT', S(`settings/${groceryMain.id}`), { takeOrdersWhenClosed: true });
    await A('PATCH', G(`locations/${groceryMain.id}`), { name: groceryMain.name, active: true, openingHours: null });
  });

  // --- Accepting, declining, the shop's own rule ----------------------------------------------------
  const board = (lane) => A('GET', S(`orders?lane=${lane}`));
  const findOrder = async (orderNo) => (await A('GET', S('orders?lane=new'))).orders.concat((await board('packing')).orders, (await board('out')).orders, (await board('done')).orders)
    .find((row) => row.orderNo === orderNo);
  await t.test('accepting makes the customer and records their consents; declining, and the shop\'s own rule, leave no customer', async () => {
    const lane = await board('new');
    assert.ok(lane.counts.new >= 5);
    assert.ok(lane.orders.every((row) => row.status === 'placed' && row.autoDeclineAt));
    // Declined with a reason the guest reads.
    const declineMe = lane.orders.find((row) => row.mobile === '9000000666');
    await A('POST', S(`orders/${declineMe.id}/decline`), { reason: 'We are out of lighters today' });
    // The shop's own rule: an order not accepted in time is declined by itself, with an Automatic row.
    const late = lane.orders.find((row) => row.mobile === '9000000007');
    await pool.query("UPDATE shop_orders SET auto_decline_at=now()-interval '1 minute' WHERE id=$1", [late.id]);
    const after = await board('done');
    const declined = after.orders.find((row) => row.id === late.id);
    assert.deepEqual([declined.status, declined.declined], ['declined', { auto: true, reason: 'The shop did not respond in time.' }]);
    const [automatic] = await audits(grocery.id, 'online_order.declined').then((rows) => rows.filter((row) => row.channel === 'automatic'));
    assert.deepEqual([automatic.actor_id, Number(automatic.entity_id)], [null, Number(late.id)]);
    const lateEvent = (await events(grocery.id, 'online_order.declined')).find((row) => Number(row.entity_id) === Number(late.id));
    assert.deepEqual([lateEvent.actor_id, lateEvent.payload.auto], [null, true]);
    let refused = await refusedA('POST', S(`orders/${late.id}/accept`), {}, 409);
    assert.match(refused.message, /declined by itself/);
    const lateToken = (await one('SELECT guest_token FROM shop_orders WHERE id=$1', [late.id])).guest_token;
    const seen = await guest('GET', `/status/${lateToken}`);
    assert.deepEqual([seen.order.stage.label, seen.order.final, seen.live], ['The shop did not respond', true, null]);
    // Accepted: the customer is the one staff know by the mobile, or a new one; the consents ticked are recorded.
    const accepted = await A('POST', S(`orders/${(await findOrder(first.order.orderNo)).id}/accept`), {});
    assert.equal(accepted.status, 'accepted');
    const contact = await one('SELECT * FROM business_contacts WHERE id=$1', [accepted.contactId]);
    assert.deepEqual([contact.name, contact.phone, contact.source], ['Priya Sharma', '9848012345', 'guests_site']);
    const consents = await all('SELECT purpose,channel,recorded_by FROM business_consents WHERE business_id=$1 AND contact_id=$2 ORDER BY purpose', [grocery.id, contact.id]);
    assert.deepEqual(consents.map((row) => [row.purpose, row.channel, row.recorded_by]), [['bills_digital', 'guests_site', null], ['offers', 'guests_site', null]]);
    refused = await refusedA('POST', S(`orders/${accepted.id}/decline`), { reason: 'Too late' }, 409);
    assert.equal(refused.reason, 'not_placed');
    // The guest sees it accepted, and may still cancel until packing starts.
    const status = await guest('GET', `/status/${first.order.guestToken}`);
    assert.deepEqual([status.order.status, status.order.canCancel, status.order.canChange], ['accepted', true, false]);
    assert.deepEqual(status.live && JSON.parse(Buffer.from(status.live.key.split('.')[0], 'base64url').toString()).watch, [{ area: 'online_order', id: accepted.id }]);
    // A declined order made no customer.
    assert.equal((await one("SELECT count(*)::int AS n FROM business_contacts WHERE business_id=$1 AND phone='9000000666'", [grocery.id])).n, 0);
    assert.equal((await one('SELECT contact_id FROM shop_orders WHERE id=$1', [declineMe.id])).contact_id, null);
    assert.ok((await events(grocery.id, 'online_order.accepted')).length === 1);
  });

  // --- The guest's own changes -------------------------------------------------------------------
  await t.test('the guest cancels until packing starts, and changes an order (back to the cart) until it is accepted', async () => {
    const change = (await board('new')).orders.find((row) => row.mobile === '9000000002');
    const token = (await one('SELECT guest_token FROM shop_orders WHERE id=$1', [change.id])).guest_token;
    const changed = await guest('POST', `/status/${token}/change`, {});
    assert.deepEqual([changed.order.status, changed.order.stage.label], ['cancelled', 'Cancelled by you']);
    assert.deepEqual(changed.cart.lines, [{ skuId: Number(items.atta.id), quantity: 1, name: 'Aashirvaad Atta 5 kg' }]);
    assert.equal(changed.cart.linkPath, `/shop/${link.token}`);
    const [cancelRow] = (await audits(grocery.id, 'online_order.cancelled')).filter((row) => Number(row.entity_id) === Number(change.id));
    assert.deepEqual([cancelRow.actor_id, cancelRow.channel], [null, 'guests_site']);
    // Accepted, not packed yet: the guest may still cancel.
    const other = (await board('new')).orders.find((row) => row.mobile === '9000000003');
    await A('POST', S(`orders/${other.id}/accept`), {});
    const otherToken = (await one('SELECT guest_token FROM shop_orders WHERE id=$1', [other.id])).guest_token;
    const refused = await guest('POST', `/status/${otherToken}/change`, {}, 409);
    assert.equal(refused.reason, 'too_late');
    const cancelled = await guest('POST', `/status/${otherToken}/cancel`, {});
    assert.equal(cancelled.order.status, 'cancelled');
  });

  // --- Packing and billing ----------------------------------------------------------------------
  const detail = (id) => A('GET', S(`orders/${id}`));
  const line = (orderView, sku) => orderView.lines.find((row) => row.skuId === Number(sku.id));
  const stockOf = async (sku) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [grocery.id, sku.id])).q);
  const place = async (lines, total, extra = {}) => {
    const placed = await guest('POST', `/${link.token}/orders`, order(lines, { mobile: '9440011223', name: 'Ravi Kumar', total, ...extra }), 201);
    const row = (await board('new')).orders.find((card) => card.orderNo === placed.order.orderNo);
    return { ...placed, id: row.id };
  };
  let pickupOrder, deliveryOrder;
  await t.test('packing within what the guest agreed: weighed a little over, replaced with a cheaper item; billed at the order\'s prices; collected and paid', async () => {
    // ₹280 + 1 kg rice ₹60 + 2 butter ₹550 = ₹890.
    pickupOrder = await place([priced(items.atta, 1, 280), priced(items.rice, 1, 60), priced(items.butter, 2, 275)], 890);
    let view = await A('POST', S(`orders/${pickupOrder.id}/accept`), {});
    const { contactId } = view;
    // Two at once: a change against an older look at the order is refused.
    let refused = await refusedA('PATCH', S(`orders/${pickupOrder.id}/lines/${line(view, items.atta).id}`), { state: 'ok', revision: view.revision - 1 }, 409);
    assert.equal(refused.reason, 'changed');
    view = await A('PATCH', S(`orders/${pickupOrder.id}/lines/${line(view, items.atta).id}`), { state: 'ok', revision: view.revision });
    // The guest can no longer cancel once packing has started.
    refused = await guest('POST', `/status/${pickupOrder.order.guestToken}/cancel`, {}, 409);
    assert.equal(refused.reason, 'too_late');
    refused = await refusedA('PATCH', S(`orders/${pickupOrder.id}/lines/${line(view, items.rice).id}`), { state: 'ok' }, 400);
    assert.match(refused.message, /Weigh/);
    view = await A('PATCH', S(`orders/${pickupOrder.id}/lines/${line(view, items.rice).id}`), { packedQuantity: '1.05' });
    view = await A('POST', S(`orders/${pickupOrder.id}/lines/${line(view, items.butter).id}/replace`), { skuId: items.cheaper.id, quantity: 2 });
    assert.deepEqual([line(view, items.butter).state, line(view, items.cheaper).replacesLineId], ['replaced', line(view, items.butter).id]);
    // ₹280 + ₹63 + ₹500: lower than the ₹890 agreed, so it bills without asking.
    assert.deepEqual([view.figures.total, view.figures.over], [843, 0]);
    refused = await refusedA('POST', S(`orders/${pickupOrder.id}/ask`), {}, 409);
    assert.equal(refused.reason, 'within_agreed');
    const before = { atta: await stockOf(items.atta), rice: await stockOf(items.rice), cheaper: await stockOf(items.cheaper), butter: await stockOf(items.butter) };
    const billKey = key();
    const billed = await A('POST', S(`orders/${pickupOrder.id}/bill`), { requestKey: billKey });
    assert.deepEqual([billed.order.status, billed.order.finalTotal], ['packed', 843]);
    const again = await A('POST', S(`orders/${pickupOrder.id}/bill`), { requestKey: billKey });
    assert.equal(again.order.documentId, billed.order.documentId);
    const bill = await A('GET', G(`documents/${billed.order.documentId}`));
    assert.deepEqual([Number(bill.total), Number(bill.contact_id), bill.notes], [843, contactId, `Online order ${pickupOrder.order.orderNo}`]);
    assert.deepEqual(bill.lines.map((row) => [row.label, Number(row.quantity), Number(row.net) + Number(row.tax), Number(row.tax_rate)]), [
      ['Aashirvaad Atta 5 kg', 1, 280, 5], ['Sona Masoori rice (loose)', 1.05, 63, 5], ['Mother Dairy Butter 500 g', 2, 500, 12]]);
    assert.deepEqual(bill.lines.map((row) => [Number(row.net), Number(row.tax)]), [[266.67, 13.33], [60, 3], [446.43, 53.57]]);
    assert.deepEqual(bill.payments, []);
    // Stock left at billing, as for every sale; the replaced butter was never taken.
    assert.deepEqual([await stockOf(items.atta), await stockOf(items.rice), await stockOf(items.cheaper), await stockOf(items.butter)],
      [before.atta - 1, before.rice - 1.05, before.cheaper - 2, before.butter]);
    const guestView = await guest('GET', `/status/${pickupOrder.order.guestToken}`);
    assert.deepEqual([guestView.order.status, guestView.order.totals.final, guestView.order.lines.find((row) => row.state === 'replaced').name], ['packed', 843, 'Amul Butter 500 g']);
    // Ready, then collected and paid at the shop: the payment on the bill.
    await A('POST', S(`orders/${pickupOrder.id}/ready`), {});
    refused = await refusedA('POST', S(`orders/${pickupOrder.id}/out`), { riderName: 'Suresh' }, 409);
    const payKey = key();
    const done = await A('POST', S(`orders/${pickupOrder.id}/complete`), { requestKey: payKey, payment: { method: 'cash' } });
    assert.deepEqual([done.status, done.paidBy], ['completed', 'cash']);
    await A('POST', S(`orders/${pickupOrder.id}/complete`), { requestKey: payKey, payment: { method: 'cash' } });
    const paid = await A('GET', G(`documents/${billed.order.documentId}`));
    assert.deepEqual(paid.payments.map((row) => [Number(row.amount), row.method]), [[843, 'cash']]);
    const final = await guest('GET', `/status/${pickupOrder.order.guestToken}`);
    assert.deepEqual([final.order.stage.label, final.order.final, final.live], ['Collected', true, null]);
    for (const kind of ['online_order.packed', 'online_order.ready', 'online_order.completed']) assert.ok((await events(grocery.id, kind)).length >= 1, kind);
  });

  await t.test('a raise waits for the guest\'s OK; the delivery charge is billed on each GST rate of the goods; delivered and paid by UPI', async () => {
    // 2 kg rice ₹120 (5%) + Mother Dairy butter ₹250 (12%) + delivery ₹30 = ₹400.
    deliveryOrder = await place([priced(items.rice, 2, 60), priced(items.cheaper, 1, 250)], 400,
      { service: 'delivery', paymentMode: 'upi_on_delivery', address: { address: 'House 7, Lane 4, Ameerpet main road', pinCode: '500033' } });
    let view = await A('POST', S(`orders/${deliveryOrder.id}/accept`), {});
    view = await A('PATCH', S(`orders/${deliveryOrder.id}/lines/${line(view, items.cheaper).id}`), { state: 'ok' });
    // 2.4 kg of rice: ₹144, more than 10% over; the order would come to ₹424, above the ₹412 agreed.
    view = await A('PATCH', S(`orders/${deliveryOrder.id}/lines/${line(view, items.rice).id}`), { packedQuantity: '2.4' });
    assert.deepEqual([view.figures.total, view.figures.ceiling, view.figures.over], [424, 412, 12]);
    let refused = await refusedA('POST', S(`orders/${deliveryOrder.id}/bill`), { requestKey: key() }, 409);
    assert.deepEqual([refused.reason, refused.total, refused.ceiling], ['needs_ok', 424, 412]);
    view = await A('POST', S(`orders/${deliveryOrder.id}/ask`), { note: 'The rice bag came to 2.4 kg' });
    assert.deepEqual([view.change.totalBefore, view.change.totalAfter, view.change.lines[0].kind], [400, 424, 'weighed']);
    refused = await refusedA('POST', S(`orders/${deliveryOrder.id}/bill`), { requestKey: key() }, 409);
    assert.equal(refused.reason, 'waiting_for_ok');
    // The guest's page shows it, live; they accept.
    const asked = await guest('GET', `/status/${deliveryOrder.order.guestToken}`);
    assert.deepEqual([asked.order.change.totalAfter, asked.order.change.note], [424, 'The rice bag came to 2.4 kg']);
    const yes = await guest('POST', `/status/${deliveryOrder.order.guestToken}/changes/${asked.order.change.id}`, { accept: true });
    assert.deepEqual([yes.order.change, yes.order.totals.agreed], [null, 424]);
    const [okRow] = await audits(grocery.id, 'online_order.change_accepted');
    assert.deepEqual([okRow.actor_id, okRow.channel], [null, 'guests_site']);
    const billed = await A('POST', S(`orders/${deliveryOrder.id}/bill`), { requestKey: key() });
    assert.equal(billed.order.finalTotal, 424);
    const bill = await A('GET', G(`documents/${billed.order.documentId}`));
    // The ₹30 shared by the goods' value: ₹144 at 5% and ₹250 at 12%, one delivery line for each rate.
    assert.deepEqual(bill.lines.map((row) => [row.label, Math.round((Number(row.net) + Number(row.tax)) * 100) / 100, Number(row.tax_rate)]), [
      ['Sona Masoori rice (loose)', 144, 5], ['Mother Dairy Butter 500 g', 250, 12],
      ['Delivery charge (on goods at 12% GST)', 19.04, 12], ['Delivery charge (on goods at 5% GST)', 10.96, 5]]);
    assert.equal(Number(bill.total), 424);
    // Out with its delivery person, then delivered and paid by UPI with its reference.
    refused = await refusedA('POST', S(`orders/${deliveryOrder.id}/complete`), { requestKey: key(), payment: { method: 'upi' } }, 409);
    await A('POST', S(`orders/${deliveryOrder.id}/out`), { riderName: 'Suresh' });
    const onWay = await guest('GET', `/status/${deliveryOrder.order.guestToken}`);
    assert.deepEqual([onWay.order.stage.label, onWay.order.stage.detail], ['Out for delivery', 'Suresh is bringing your order.']);
    await A('POST', S(`orders/${deliveryOrder.id}/complete`), { requestKey: key(), payment: { method: 'upi', reference: '412345678901' } });
    const paid = await A('GET', G(`documents/${billed.order.documentId}`));
    assert.deepEqual(paid.payments.map((row) => [Number(row.amount), row.method, row.reference]), [[424, 'upi', '412345678901']]);
  });

  await t.test('a raise the guest turns down, an item added on the phone, a lower price within the limit, batches with 45 days left first', async () => {
    // Turned down: the shop packs within what was agreed.
    const rice = await place([priced(items.rice, 1, 60)], 60, { mobile: '9440011224' });
    let view = await A('POST', S(`orders/${rice.id}/accept`), {});
    view = await A('PATCH', S(`orders/${rice.id}/lines/${line(view, items.rice).id}`), { packedQuantity: '1.5' });
    view = await A('POST', S(`orders/${rice.id}/ask`), {});
    const no = await guest('POST', `/status/${rice.order.guestToken}/changes/${view.change.id}`, { accept: false });
    assert.equal(no.order.changes[0].status, 'rejected');
    await refusedA('POST', S(`orders/${rice.id}/bill`), { requestKey: key() }, 409);
    view = await A('PATCH', S(`orders/${rice.id}/lines/${line(view, items.rice).id}`), { packedQuantity: '1.0' });
    assert.equal((await A('POST', S(`orders/${rice.id}/bill`), { requestKey: key() })).order.finalTotal, 60);
    // Added on the phone: agreed on the phone, typed by staff.
    const atta = await place([priced(items.atta, 1, 280)], 280, { mobile: '9440011225' });
    view = await A('POST', S(`orders/${atta.id}/accept`), {});
    view = await A('PATCH', S(`orders/${atta.id}/lines/${line(view, items.atta).id}`), { state: 'ok' });
    view = await A('POST', S(`orders/${atta.id}/lines`), { skuId: items.lighter.id, quantity: 1 }, 201);
    assert.equal(line(view, items.lighter).added, true);
    view = await A('POST', S(`orders/${atta.id}/ask`), {});
    view = await A('POST', S(`orders/${atta.id}/changes/${view.change.id}/answer`), { accepted: true });
    assert.equal(view.changes[0].answeredVia, 'phone');
    // A lower price needs the reason and stays within the bill discount limit (10% of the goods).
    let refused = await refusedA('PATCH', S(`orders/${atta.id}/lines/${line(view, items.atta).id}`), { billPrice: '200', discountReason: 'Torn pack' }, 409);
    assert.equal(refused.reason, 'discount_limit');
    refused = await refusedA('PATCH', S(`orders/${atta.id}/lines/${line(view, items.atta).id}`), { billPrice: '270' }, 400);
    view = await A('PATCH', S(`orders/${atta.id}/lines/${line(view, items.atta).id}`), { billPrice: '270', discountReason: 'Torn pack' });
    assert.equal(view.figures.total, 298);
    assert.equal((await A('POST', S(`orders/${atta.id}/bill`), { requestKey: key() })).order.finalTotal, 298);
    // Two packs of milk powder: the batch with months to go first, then the short-dated one, with a warning.
    const milk = await place([priced(items.milk, 2, 420)], 840, { mobile: '9440011226' });
    view = await A('POST', S(`orders/${milk.id}/accept`), {});
    view = await A('PATCH', S(`orders/${milk.id}/lines/${line(view, items.milk).id}`), { state: 'ok' });
    const billed = await A('POST', S(`orders/${milk.id}/bill`), { requestKey: key() });
    assert.equal(billed.warnings.length, 1);
    assert.match(billed.warnings[0], /MP-SHORT expires on .*less than 45 days away/);
    const bill = await A('GET', G(`documents/${billed.order.documentId}`));
    assert.deepEqual(bill.lines.map((row) => [row.lot_code, Number(row.quantity), Number(row.net) + Number(row.tax)]), [['MP-LONG', 1, 420], ['MP-SHORT', 1, 420]]);
  });

  await t.test('refused at the door: the bill comes back through the returns, the stock with it, and the order is cancelled', async () => {
    const refusedOrder = await place([priced(items.atta, 1, 280)], 310, { mobile: '9440011227', service: 'delivery', paymentMode: 'cash_on_delivery',
      address: { address: 'Plot 22, Srinagar Colony main road', pinCode: '500034' } });
    let view = await A('POST', S(`orders/${refusedOrder.id}/accept`), {});
    view = await A('PATCH', S(`orders/${refusedOrder.id}/lines/${line(view, items.atta).id}`), { state: 'ok' });
    const billed = await A('POST', S(`orders/${refusedOrder.id}/bill`), { requestKey: key() });
    await A('POST', S(`orders/${refusedOrder.id}/out`), { riderName: 'Suresh' });
    const stock = await stockOf(items.atta);
    const returnKey = key();
    view = await A('POST', S(`orders/${refusedOrder.id}/refused`), { reason: 'Refused at the door: ordered by mistake', requestKey: returnKey });
    assert.deepEqual([view.status, view.cancelled.by, view.cancelled.reason], ['cancelled', 'shop', 'Refused at the door: ordered by mistake']);
    await A('POST', S(`orders/${refusedOrder.id}/refused`), { reason: 'Refused at the door: ordered by mistake', requestKey: returnKey });
    assert.equal(await stockOf(items.atta), stock + 1);
    const bill = await A('GET', G(`documents/${billed.order.documentId}`));
    assert.deepEqual([bill.returns.length, Number(bill.returns[0].total), Number(bill.total)], [1, 310, 310]);
    const seen = await guest('GET', `/status/${refusedOrder.order.guestToken}`);
    assert.deepEqual([seen.order.stage.label, seen.order.stage.detail], ['Cancelled by the shop', 'Refused at the door: ordered by mistake']);
  });

  // --- Complaints -------------------------------------------------------------------------------
  await t.test('complaints: a ticket number, acknowledged and resolved, with the bell\'s clocks', async () => {
    const body = { clientKey: key(), kind: 'damaged', details: 'The butter packs were soft and leaking when they came.' };
    const opened = await guest('POST', `/status/${pickupOrder.order.guestToken}/complaints`, body);
    const [ticket] = opened.order.complaints;
    assert.deepEqual([ticket.ticketNo, ticket.status, ticket.kind], ['TK-0001', 'open', 'damaged']);
    assert.ok(opened.live, 'an open complaint keeps the page live');
    const again = await guest('POST', `/status/${pickupOrder.order.guestToken}/complaints`, body);
    assert.equal(again.order.complaints.length, 1);
    const [row] = await audits(grocery.id, 'online_complaint.opened');
    assert.deepEqual([row.actor_id, row.channel], [null, 'guests_site']);
    const listed = await A('GET', S('complaints?status=open'));
    assert.deepEqual(listed.complaints.map((c) => [c.ticketNo, c.orderNo, c.kindWords]), [['TK-0001', pickupOrder.order.orderNo, 'Damaged or leaking']]);
    // The bell: a day unacknowledged warns; past its 48 hours it is critical.
    const bell = async () => (await A('GET', G('notifications'))).items.filter((item) => item.category === 'Online orders');
    assert.ok(!(await bell()).some((item) => item.id.startsWith('complaint:')));
    await pool.query("UPDATE shop_complaints SET created_at=now()-interval '25 hours',acknowledge_by=now()+interval '23 hours' WHERE id=$1", [ticket.id]);
    assert.equal((await bell()).find((item) => item.id === `complaint:${ticket.id}:ack`).severity, 'warning');
    await pool.query("UPDATE shop_complaints SET created_at=now()-interval '49 hours',acknowledge_by=now()-interval '1 hour' WHERE id=$1", [ticket.id]);
    assert.equal((await bell()).find((item) => item.id === `complaint:${ticket.id}:late`).severity, 'critical');
    await A('POST', S(`complaints/${ticket.id}/acknowledge`), { note: 'Sorry about this. We will send fresh packs today.' });
    const told = await guest('GET', `/status/${pickupOrder.order.guestToken}`);
    assert.equal(told.order.complaints[0].acknowledgement, 'Sorry about this. We will send fresh packs today.');
    await refusedA('POST', S(`complaints/${ticket.id}/resolve`), { outcome: 'magic', resolution: 'x' }, 400);
    await A('POST', S(`complaints/${ticket.id}/resolve`), { outcome: 'replaced', resolution: 'Two fresh packs delivered; the leaking ones taken back.' });
    const resolved = await guest('GET', `/status/${pickupOrder.order.guestToken}`);
    assert.deepEqual([resolved.order.complaints[0].status, resolved.order.complaints[0].outcome, resolved.live], ['resolved', 'replaced', null]);
    // New orders waiting ring the bell, one alert per newest order.
    await place([priced(items.lighter, 1, 28)], 28, { mobile: '9440011228' });
    const ring = (await bell()).find((item) => item.id.startsWith('online-orders:'));
    assert.match(ring.title, /new online order/);
  });

  // --- Report -----------------------------------------------------------------------------------
  await t.test('the report: orders by day and how they ended, their value, the minutes to accept and to pack, the reasons', async () => {
    const day = dayIn(0);
    const report = await A('GET', S(`report?from=${day}&to=${day}`));
    assert.equal(report.days.length, 1);
    assert.ok(report.totals.placed >= 10);
    assert.ok(report.totals.completed >= 2);
    assert.ok(report.totals.value >= 843 + 424);
    assert.ok(report.totals.declined_auto >= 1 && report.totals.declined >= 1 && report.totals.cancelled_guest >= 2 && report.totals.cancelled_shop >= 1);
    assert.ok(report.totals.acceptMinutes !== null && report.totals.packMinutes !== null);
    assert.ok(report.reasons.some((row) => row.reason === 'The shop did not respond in time'));
    assert.ok(report.reasons.some((row) => row.reason === 'We are out of lighters today'));
  });

  // --- Permissions ------------------------------------------------------------------------------
  await t.test('a cashier accepts and packs; a stock keeper packs and does not bill; settings and returns are a manager\'s', async () => {
    const roles = (await A('GET', G('roles'))).items;
    const staff = async (name, template) => {
      const email = `${name}@shop.test.invalid`;
      await A('POST', G('staff-accounts'), { name, email, password, roleId: roles.find((role) => role.template_code === template).id }, 201);
      return refusedAs((await signIn(base, email, password)).token);
    };
    const cashier = await staff('Lakshmi', 'cashier');
    const keeper = await staff('Raju', 'stock_keeper');
    const placed = await place([priced(items.lighter, 2, 28)], 56, { mobile: '9440011229' });
    await cashier('PUT', S(`settings/${groceryMain.id}`), { paused: true }, 403);
    await keeper('POST', S(`orders/${placed.id}/accept`), {}, 403);
    const view = await cashier('POST', S(`orders/${placed.id}/accept`), {}, 200);
    await keeper('PATCH', S(`orders/${placed.id}/lines/${view.lines[0].id}`), { state: 'ok' }, 200);
    await keeper('POST', S(`orders/${placed.id}/bill`), { requestKey: key() }, 403);
    await cashier('POST', S(`orders/${placed.id}/bill`), { requestKey: key() }, 200);
    await cashier('POST', S(`orders/${placed.id}/ready`), {}, 200);
    await cashier('POST', S(`orders/${placed.id}/refused`), { reason: 'Not collected', requestKey: key() }, 403);
    await A('POST', S(`orders/${placed.id}/refused`), { reason: 'Not collected by closing time', requestKey: key() });
  });

  // --- Module and plan --------------------------------------------------------------------------
  await t.test('with the module off, or the plan ended, the page says so and gives the phone; orders are refused as the restaurant\'s are', async () => {
    await A('PATCH', G(`locations/${groceryMain.id}`), { name: groceryMain.name, active: true, phone: '040 2335 7788' });
    const lines = [priced(items.lighter, 1, 28)];
    await A('PUT', G('modules/online_shop'), { enabled: false });
    const off = await guest('GET', `/${link.token}`);
    assert.deepEqual([off.shop.taking, off.shop.reason, off.card.location.phone, off.items.items.length], [false, 'off', '040 2335 7788', 0]);
    assert.equal((await guest('GET', `/${link.token}/items`, undefined, 403)).reason, 'feature_off');
    assert.equal((await guest('POST', `/${link.token}/cart`, { service: 'pickup', lines }, 403)).reason, 'feature_off');
    assert.equal((await guest('POST', `/${link.token}/orders`, order(lines, { mobile: '9000000010', total: 28 }), 403)).reason, 'feature_off');
    // A guest's order page still opens.
    assert.equal((await guest('GET', `/status/${pickupOrder.order.guestToken}`)).order.status, 'completed');
    await A('PUT', G('modules/online_shop'), { enabled: true });
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [grocery.id]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything)
      VALUES($1,'trial',business_local_today($1)-30,business_local_today($1)-17,TRUE)`, [grocery.id]);
    const ended = await guest('GET', `/${link.token}`);
    assert.deepEqual([ended.shop.taking, ended.shop.reason, ended.card.location.phone], [false, 'not_taking_orders', '040 2335 7788']);
    // A plan that has ended takes no order, as a restaurant's online ordering takes none.
    assert.equal((await guest('POST', `/${link.token}/orders`, order(lines, { mobile: '9000000010', total: 28 }), 409)).reason, 'not_taking_orders');
    assert.equal((await guest('GET', `/${link.token}/items`, undefined, 409)).reason, 'not_taking_orders');
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [grocery.id]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything,reason)
      VALUES($1,'given',business_local_today($1)-1,business_local_today($1)+30,TRUE,'Given back by the test')`, [grocery.id]);
    assert.equal((await guest('GET', `/${link.token}`)).shop.taking, true);
  });

  // --- Personal data ----------------------------------------------------------------------------
  await t.test('personal data: an order not handed over holds up erasure; erasure blanks the guest on their orders and complaints, through the registry', async () => {
    const ravi = await one("SELECT id FROM business_contacts WHERE business_id=$1 AND phone='9440011223'", [grocery.id]);
    const P = (suffix) => G(`privacy/${suffix}`);
    const open = await place([priced(items.lighter, 1, 28)], 28, { mobile: '9440011223' });
    await A('POST', S(`orders/${open.id}/accept`), {});
    const asked = await A('POST', P('requests'), { kind: 'erasure', personId: ravi.id, details: 'Asked to erase his details', requestKey: key() }, 201);
    const blocked = await refusedA('POST', P(`requests/${asked.id}/erase`), { requestKey: key() }, 409);
    assert.ok(blocked.open.some((line) => /online order not handed over/.test(line)), JSON.stringify(blocked.open));
    await A('POST', S(`orders/${open.id}/cancel`), { reason: 'Customer asked us to stop' });
    // Settle what he owes first (the turned-down rice and the phone order were billed to his account).
    const owed = await all(`SELECT d.id,d.total-COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.document_id=d.id),0)
      -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.document_id=d.id),0) AS due FROM business_documents d WHERE d.business_id=$1 AND d.contact_id=$2`, [grocery.id, ravi.id]);
    for (const doc of owed.filter((row) => Number(row.due) > 0)) {
      await A('POST', G(`documents/${doc.id}/payments`), { amount: Number(doc.due).toFixed(2), method: 'cash', requestKey: key() }, 201);
    }
    const exported = await A('GET', P(`people/${ravi.id}/data`));
    const section = exported.data.sections.find((s) => s.heading === 'Online orders');
    assert.ok(section && section.rows.length >= 1);
    assert.ok(section.rows.every((r) => r.guest_token === undefined && r.client_key === undefined));
    const done = await A('POST', P(`requests/${asked.id}/erase`), { requestKey: key() });
    assert.equal(done.status, 'done');
    const rows = await all('SELECT guest_name,guest_mobile,address FROM shop_orders WHERE business_id=$1 AND contact_id=$2', [grocery.id, ravi.id]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.guest_name === `Erased customer #${ravi.id}` && r.guest_mobile === null && r.address === null));
    assert.deepEqual((await all('SELECT details FROM shop_complaints WHERE business_id=$1 AND contact_id=$2', [grocery.id, ravi.id])).map((r) => r.details),
      ['Erased at the customer\'s request']);
    assert.ok(done.erasure.erased.some((e) => e.heading === 'Online orders'));
    assert.ok(done.erasure.kept.some((line) => /bill stays/.test(line)));
  });

  // --- Live, and the migration's Down -------------------------------------------------------------
  await t.test('an order and a complaint announce themselves, so the board and the guest\'s page move together', async () => {
    const triggers = (await all("SELECT tgname FROM pg_trigger WHERE tgname IN ('shop_orders_live','shop_complaints_live') ORDER BY 1")).map((row) => row.tgname);
    assert.deepEqual(triggers, ['shop_complaints_live', 'shop_orders_live']);
  });

  await t.test('the migration\'s Down half takes everything away, and Up brings it back', async () => {
    const file = fs.readdirSync(path.resolve(__dirname, '../../migrations')).find((name) => name.endsWith('_online-shop.sql'));
    const stamp = Number(file.split('_')[0]);
    await pool.end();
    pool = null;
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    const check = new Client({ ...connection, database });
    await check.connect();
    try {
      assert.equal((await check.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'shop\\_%'")).rows[0].n, 0);
      assert.equal((await check.query("SELECT count(*)::int AS n FROM platform_modules WHERE code='online_shop'")).rows[0].n, 0);
      assert.equal((await check.query("SELECT count(*)::int AS n FROM business_permissions WHERE module_code='online_shop'")).rows[0].n, 0);
    } finally { await check.end(); }
    await migrate({ direction: 'up', count: Infinity });
  });
});
