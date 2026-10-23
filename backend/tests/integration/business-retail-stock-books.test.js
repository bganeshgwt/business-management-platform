const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { daysFrom } = require('./helpers/dates');

// Retail stock and books: opening stock and barcode editing
// on items, the Sales list's biller / payment / location, the stock ledger in
// time order, locations that are not tills, batches near expiry with a
// markdown and a write-off, school sets scanned at the counter, customer
// orders for books with an advance on account, the ISBN as the barcode, the
// Business Admin bell, and every cross-business attempt. Runs on its own
// throwaway database with every migration applied.
test('retail: items, sales list, expiry, books, bell', { timeout: 300000 }, async (t) => {
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
  const password = `Retail-${crypto.randomBytes(8).toString('hex')}`;
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const ownerUser = await owner('retail-owner');
  await owner('retail-other');
  const token = await login('retail-owner@test.invalid');
  const otherToken = await login('retail-other@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();
  // Dates on the shops' own clock (India's), which is what expiry, promises and
  // the ledger are judged by.
  const day = (offset) => daysFrom(offset);

  const [grocery, supermarket, books] = await withTools(request, await createBusinesses(request, 'OWNER', ['grocery', 'supermarket', 'books']));
  const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
  const S = (suffix) => `/businesses/${supermarket.id}/${suffix}`;
  const B = (suffix) => `/businesses/${books.id}/${suffix}`;

  // A cashier of the owner's restaurant with the Cashier template in the grocery.
  const cashierUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
    [ownerUser.restaurant_id, 'Retail cashier', 'retail-cashier@test.invalid', hash]);
  const cashier = as(await login('retail-cashier@test.invalid'));
  const groceryRoles = (await request('GET', G('roles'))).items;
  await request('POST', G('members'), { userId: cashierUser.id, roleId: groceryRoles.find((r) => r.template_code === 'cashier').id }, 201);

  const location = (await request('GET', G('locations'))).items[0];
  const item = (route, body, expected = 201) => request('POST', route, { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '5', ...body }, expected);

  let dal;
  await t.test('opening stock with a new item, and the barcode can be edited', async () => {
    dal = await item(G('catalog'), { name: 'Moong dal 1 kg', code: 'MOONG', price: '140', barcode: '8901234567897',
      openingStock: { locationId: location.id, quantity: '25', unitCost: '110' } });
    const lot = await one('SELECT quantity,unit_cost FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [grocery.id, dal.id]);
    assert.equal(Number(lot.quantity), 25);
    assert.equal(Number(lot.unit_cost), 110);
    const moved = (await request('GET', G('movements?q=Moong'))).items;
    assert.equal(moved.length, 1);
    assert.equal(moved[0].source, 'correction');
    assert.equal(moved[0].reason, 'Opening stock');
    // Serial items and batch items without a batch are refused; nothing is left behind.
    await item(G('catalog'), { name: 'Basmati 1 kg', code: 'BAS1', price: '120', tracking: 'batch', openingStock: { locationId: location.id, quantity: '5' } }, 400);
    assert.equal(await one("SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code='BAS1'", [grocery.id]), undefined);
    // Opening stock needs the right to change stock: a cashier cannot.
    await cashier('POST', G('catalog'), { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '5', name: 'X', code: 'XCASH', price: '1',
      openingStock: { locationId: location.id, quantity: '1' } }, 403);
    // The barcode: a clash names the item that has it; it can be changed and cleared.
    const sugar = await item(G('catalog'), { name: 'Sugar 1 kg', code: 'SUGAR', price: '48' });
    const clash = await call('PATCH', G(`catalog/${sugar.id}`), { label: sugar.label, price: '48', active: true, barcode: '8901234567897' }, token);
    assert.equal(clash.status, 409);
    assert.match(clash.body.message, /already on Moong dal 1 kg/);
    const changed = await request('PATCH', G(`catalog/${sugar.id}`), { label: sugar.label, price: '48', active: true, barcode: '8906001234560' });
    assert.equal(changed.barcode, '8906001234560');
    // An older client that sends no barcode keeps it; an empty one clears it.
    assert.equal((await request('PATCH', G(`catalog/${sugar.id}`), { label: sugar.label, price: '49', active: true })).barcode, '8906001234560');
    assert.equal((await request('PATCH', G(`catalog/${sugar.id}`), { label: sugar.label, price: '49', active: true, barcode: '' })).barcode, null);
    await request('PATCH', G(`catalog/${sugar.id}`), { label: sugar.label, price: '49', active: true, barcode: 'bad code!' }, 400);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='catalog.barcode_changed'", [grocery.id]));
    await other('PATCH', G(`catalog/${sugar.id}`), { label: 'x', price: '1', active: true, barcode: '1' }, 404);
  });

  await t.test('Sales list: who billed it, how it was paid, filters; the ledger in time order', async () => {
    const sale = (by, body) => by('POST', G('documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: dal.id, quantity: '1' }], ...body }, 201);
    const cash = await sale(request, { payment: { amount: 'full', method: 'cash' } });
    const upi = await sale(cashier, { payment: { amount: 'full', method: 'upi' } });
    const customer = await request('POST', G('contacts'), { kind: 'customer', name: 'Meena', phone: '9800000001' }, 201);
    const mixed = await sale(request, { contactId: customer.id, payment: { amount: '50', method: 'cash' } });
    await request('POST', G(`documents/${mixed.id}/payments`), { amount: '50', method: 'card', requestKey: key() }, 201);
    const rows = (await request('GET', G('documents?kind=sale&limit=10'))).items;
    const row = (doc) => rows.find((r) => r.id === doc.id);
    assert.equal(row(cash).paid_by, 'cash');
    assert.equal(row(upi).paid_by, 'upi');
    assert.equal(row(mixed).paid_by, 'mixed');
    assert.equal(row(upi).created_by_name, 'Retail cashier');
    assert.equal(row(cash).created_by_name, 'retail-owner');
    assert.deepEqual((await request('GET', G('documents?kind=sale&paid_by=upi'))).items.map((r) => r.id), [upi.id]);
    assert.deepEqual((await request('GET', G(`documents?kind=sale&created_by=${cashierUser.id}`))).items.map((r) => r.id), [upi.id]);
    assert.equal((await request('GET', G('documents?kind=sale&q=Retail%20cashier'))).total, 1);
    // A posting dated earlier sits on its own date in the stock ledger.
    await pool.query("UPDATE business_stock_movements SET created_at=now()-interval '3 days' WHERE business_id=$1 AND document_id=$2", [grocery.id, upi.id]);
    const ledger = (await request('GET', G(`movements?q=Moong&from=${day(-10)}&to=${day(0)}`))).items;
    const times = ledger.map((m) => Date.parse(m.created_at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    assert.equal(String(ledger.at(-1).document_id), String(upi.id));
  });

  await t.test('a warehouse is not a till: the counter flag on locations', async () => {
    const warehouse = await request('POST', S('locations'), { name: 'Back warehouse', code: 'BW', sellsAtCounter: false }, 201);
    assert.equal(warehouse.sells_at_counter, false);
    const context = await request('GET', S('context'));
    assert.equal(context.locations.find((l) => l.id === warehouse.id).sells_at_counter, false);
    // An older client (name and active only) keeps the flag; it can be switched back.
    assert.equal((await request('PATCH', S(`locations/${warehouse.id}`), { name: 'Back warehouse', active: true })).sells_at_counter, false);
    assert.equal((await request('PATCH', S(`locations/${warehouse.id}`), { name: 'Back warehouse', active: true, sellsAtCounter: true })).sells_at_counter, true);
  });

  await t.test('near expiry: soonest first with value, a markdown and a write-off', async () => {
    const sLocation = (await request('GET', S('locations'))).items[0];
    const curd = await item(S('catalog'), { name: 'Curd 400 g', code: 'CURD', price: '45', tracking: 'batch',
      openingStock: { locationId: sLocation.id, quantity: '10', unitCost: '35', lotCode: 'C-1', expiresOn: day(3) } });
    const paneer = await item(S('catalog'), { name: 'Paneer 200 g', code: 'PANEER', price: '95', tracking: 'batch',
      openingStock: { locationId: sLocation.id, quantity: '6', unitCost: '70', lotCode: 'P-1', expiresOn: day(20) } });
    await item(S('catalog'), { name: 'Ghee 1 L', code: 'GHEE1', price: '600', tracking: 'batch',
      openingStock: { locationId: sLocation.id, quantity: '4', unitCost: '500', lotCode: 'G-1', expiresOn: day(200) } });
    // A batch already past its date (a receipt cannot carry one, so it is dated here).
    await pool.query("UPDATE business_stock_lots SET expires_on=$3 WHERE business_id=$1 AND sku_id=$2", [supermarket.id, paneer.id, day(-1)]);
    const soon = await request('GET', S('retail/near-expiry?days=30'));
    assert.deepEqual(soon.rows.map((r) => r.code), ['PANEER', 'CURD']);
    assert.equal(soon.rows[0].days_left, -1);
    assert.equal(soon.rows[1].days_left, 3);
    assert.equal(soon.rows[1].cost_value, '350.00');
    assert.equal(soon.totals.expired, 1);
    assert.equal(soon.totals.within7, 1);
    assert.equal(soon.totals.expiredCost, '420.00');
    assert.equal((await request('GET', S('retail/near-expiry?days=7'))).rows.length, 2);
    await request('GET', S('retail/near-expiry?days=0'), undefined, 400);
    // Mark down: an item % offer until the batch's date, shown on the row.
    await request('POST', S('offers'), { name: 'Near expiry: Curd', kind: 'item_percent', skuId: curd.id, value: '30', startsOn: day(0), endsOn: day(3) }, 201);
    const marked = (await request('GET', S('retail/near-expiry?days=30'))).rows.find((r) => r.code === 'CURD');
    assert.equal(Number(marked.markdown.value), 30);
    const quote = await request('POST', S('retail/quote'), { locationId: sLocation.id, lines: [{ skuId: curd.id, quantity: '1', lotCode: 'C-1' }] });
    assert.equal(Number(quote.total), 32);
    // Write off the expired batch: a correction with the reason, then it is gone from the list.
    const expired = soon.rows[0];
    await request('POST', S(`stock/${expired.id}/adjustments`), { quantity: `-${Number(expired.quantity)}`, reason: 'Expired: written off', requestKey: key() }, 201);
    assert.deepEqual((await request('GET', S('retail/near-expiry?days=30'))).rows.map((r) => r.code), ['CURD']);
    // The bell: the expiring batch is there (critical once expired, a warning within 7 days).
    const bell = await request('GET', S('notifications'));
    const expiring = bell.items.find((i) => i.id.startsWith('expiry:'));
    assert.equal(expiring.severity, 'warning');
    assert.match(expiring.title, /Curd 400 g expires in 3 days/);
    assert.equal(expiring.link, `/business-admin/${supermarket.id}/near-expiry`);
    await other('GET', S('retail/near-expiry'), undefined, 404);
  });

  await t.test('the bell: low stock, overdue udhaar and broken promises, only to those allowed', async () => {
    const low = await item(G('catalog'), { name: 'Tea 250 g', code: 'TEA', price: '120', reorderLevel: '5', openingStock: { locationId: location.id, quantity: '2', unitCost: '90' } });
    const customer = await request('POST', G('contacts'), { kind: 'customer', name: 'Kiran', phone: '9800000002', creditDays: 1 }, 201);
    const bill = await request('POST', G('documents'), { kind: 'sale', locationId: location.id, contactId: customer.id, requestKey: key(), lines: [{ skuId: low.id, quantity: '1' }] }, 201);
    await pool.query("UPDATE business_documents SET due_on=$3 WHERE business_id=$1 AND id=$2", [grocery.id, bill.id, day(-40)]);
    await request('POST', G(`udhaar/${customer.id}/reminders`), { channel: 'call', promisedOn: day(0) }, 201);
    await pool.query("UPDATE retail_credit_reminders SET promised_on=$3 WHERE business_id=$1 AND contact_id=$2", [grocery.id, customer.id, day(-2)]);
    const bell = await request('GET', G('notifications'));
    const find = (prefix) => bell.items.find((i) => i.id.startsWith(prefix));
    assert.match(find(`low:${low.id}`).title, /Tea 250 g is running low/);
    const overdue = find(`overdue:${customer.id}:`);
    assert.equal(overdue.severity, 'critical');
    assert.match(overdue.title, /Kiran: ₹120\.00 udhaar overdue/);
    assert.equal(overdue.link, `/business-admin/${grocery.id}/udhaar`);
    assert.match(find('promise:').title, /Kiran broke a promise to pay/);
    assert.equal(bell.counts.critical + bell.counts.warning + bell.counts.info, bell.items.length);
    // Each alert only for a role that may see what it adds up.
    const cashierBell = await cashier('GET', G('notifications'));
    const cashierCan = groceryRoles.find((r) => r.template_code === 'cashier').permissions;
    for (const [prefix, permission] of [['low:', 'inventory.view'], ['overdue:', 'receivables.view']]) {
      assert.equal(cashierBell.items.some((i) => i.id.startsWith(prefix)), cashierCan.includes(permission), prefix);
    }
    const noStock = groceryRoles.find((r) => r.template_code === 'cashier');
    await pool.query("DELETE FROM business_role_permissions WHERE business_id=$1 AND role_id=$2 AND permission_code IN ('inventory.view','receivables.view')", [grocery.id, noStock.id]);
    const narrowed = await cashier('GET', G('notifications'));
    assert.ok(!narrowed.items.some((i) => i.id.startsWith('low:') || i.id.startsWith('overdue:') || i.id.startsWith('promise:')));
    await other('GET', G('notifications'), undefined, 404);
  });

  let bookA, notebook;
  await t.test('books: the ISBN is the barcode, school sets scan at the counter', async () => {
    const bLocation = (await request('GET', B('locations'))).items[0];
    // An item given an in-store barcode first takes the ISBN once it gets one.
    bookA = await item(B('catalog'), { name: 'Class 6 science', code: 'SCI6', price: '320', taxRate: '0', openingStock: { locationId: bLocation.id, quantity: '20', unitCost: '250' } });
    await request('POST', B('retail/barcodes'), { skuIds: [bookA.id] });
    assert.match((await one('SELECT barcode FROM catalog_skus WHERE id=$1', [bookA.id])).barcode, /^200/);
    await request('PUT', B(`books/${bookA.id}`), { isbn: '9789350000021', author: 'R. K. Sethi' });
    assert.equal((await one('SELECT barcode FROM catalog_skus WHERE id=$1', [bookA.id])).barcode, '9789350000021');
    // A maker's own barcode is kept.
    notebook = await item(B('catalog'), { name: 'Notebook 200 pages', code: 'NB200', price: '60', taxRate: '0', barcode: '8901111111116',
      openingStock: { locationId: bLocation.id, quantity: '100', unitCost: '40' } });
    // A set: its code may not be an item's code or barcode, and scans as the whole list.
    await request('POST', B('books/sets'), { name: 'X', code: 'NB200', items: [{ skuId: notebook.id, quantity: 1 }] }, 409);
    await request('POST', B('books/sets'), { name: 'X', code: 'SET-1', items: [] }, 400);
    await request('POST', B('books/sets'), { name: 'X', code: 'SET-1', items: [{ skuId: notebook.id }, { skuId: notebook.id }] }, 400);
    const set = await request('POST', B('books/sets'), { name: 'St. Mary — Class 6', code: 'sm c6', school: 'St. Mary', className: 'Class 6',
      items: [{ skuId: bookA.id, quantity: 1 }, { skuId: notebook.id, quantity: 6 }] }, 201);
    assert.equal(set.code, 'SM-C6');
    assert.equal(set.total, 680);
    const scanned = await request('GET', B(`retail/scan?code=sm-c6&locationId=${bLocation.id}`));
    assert.equal(scanned.source, 'set');
    assert.deepEqual(scanned.set.items.map((i) => [String(i.skuId), Number(i.quantity)]), [[String(bookA.id), 1], [String(notebook.id), 6]]);
    const list = await request('GET', B('books/sets'));
    assert.equal(list.total, 1);
    assert.equal(list.items[0].item_count, 2);
    // Switched off, it no longer scans.
    await request('PUT', B(`books/sets/${set.id}`), { name: set.name, code: 'SM-C6', active: false, items: [{ skuId: bookA.id, quantity: 1 }] });
    await request('GET', B(`retail/scan?code=SM-C6&locationId=${bLocation.id}`), undefined, 404);
    await other('GET', B(`books/sets/${set.id}`), undefined, 404);
    await request('GET', G('books/sets'), undefined, 403);
  });

  await t.test('books: customer orders with an advance on account, moving only forward', async () => {
    const bLocation = (await request('GET', B('locations'))).items[0];
    const meera = await request('POST', B('contacts'), { kind: 'customer', name: 'Meera', phone: '9740072727' }, 201);
    const body = { locationId: bLocation.id, title: 'The Silent Banyan', author: 'Leela Menon', contactId: meera.id, advance: '200', method: 'cash', promisedOn: day(6) };
    // An advance needs a named customer.
    await request('POST', B('books/orders'), { ...body, contactId: undefined, customerName: 'Walk-in', requestKey: key() }, 400);
    await request('POST', B('books/orders'), { ...body, isbn: '9789350000022', requestKey: key() }, 400);
    const requestKey = key();
    const order = await request('POST', B('books/orders'), { ...body, requestKey }, 201);
    assert.equal(order.order_no, 'BO-0001');
    assert.equal(order.advance, '200.00');
    // Repeating the request returns the same order and takes no second advance.
    const again = await request('POST', B('books/orders'), { ...body, requestKey }, 201);
    assert.equal(again.id, order.id);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_collections WHERE business_id=$1', [books.id])).n, 1);
    // The advance is the customer's credit: their balance is minus ₹200.
    const contact = (await request('GET', B(`contacts?kind=customer&q=Meera`))).items[0];
    assert.equal(Number(contact.balance), -200);
    // Without an advance: a walk-in by name and phone.
    const walkIn = await request('POST', B('books/orders'), { locationId: bLocation.id, title: 'Atlas of Indian Rivers', customerName: 'Arjun', phone: '9740074747', requestKey: key() }, 201);
    assert.equal(walkIn.order_no, 'BO-0002');
    assert.equal(walkIn.collection_id, null);
    // Forward only.
    await request('POST', B(`books/orders/${order.id}/status`), { status: 'collected' }, 409);
    assert.equal((await request('POST', B(`books/orders/${order.id}/status`), { status: 'arrived' })).status, 'arrived');
    const done = await request('POST', B(`books/orders/${order.id}/status`), { status: 'collected' });
    assert.ok(done.closed_at);
    await request('POST', B(`books/orders/${order.id}/status`), { status: 'cancelled' }, 409);
    await assert.rejects(pool.query('UPDATE books_customer_orders SET advance=0 WHERE id=$1', [order.id]), /fixed/);
    await assert.rejects(pool.query('DELETE FROM books_customer_orders WHERE id=$1', [walkIn.id]), /cannot be deleted/);
    const orders = await request('GET', B('books/orders?status=collected'));
    assert.deepEqual(orders.items.map((o) => o.order_no), ['BO-0001']);
    assert.equal(orders.items[0].collection_no.length > 0, true);
    await other('POST', B('books/orders'), { ...body, requestKey: key() }, 404);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='book_order.collected'", [books.id]));
  });
});
