const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { today } = require('./helpers/dates');

// Counter payments in the shared core, retail & electronics: split
// payment on shop bills (cash + UPI + card + udhaar, change from cash only,
// day close by method), the per-staff PIN at a shared counter (quick switch,
// "ask the PIN for every bill"), loyalty points spent coming back on a
// return, EMI sales with financier payouts net of subvention, and accessory
// kits sold as their components. Runs on its own throwaway database with
// every migration applied.
test('counter payments: split payment, counter PIN, points on returns, EMI, kits', { timeout: 300000 }, async (t) => {
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
  const password = `Counter-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Counter test','CTRTEST') RETURNING id");
  await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
  const ownerUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, 'Counter owner', 'counter-owner@test.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [ownerUser.id]);
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
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const token = await login('counter-owner@test.invalid');
  const request = as(token);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);

  const [grocery, electronics] = await withTools(request, await createBusinesses(request, 'OWNER', ['grocery', 'electronics']));
  const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
  const E = (suffix) => `/businesses/${electronics.id}/${suffix}`;
  const groceryLocation = (await request('GET', G('locations'))).items[0];
  const shopLocation = (await request('GET', E('locations'))).items[0];

  // Two cashiers and a person of another business.
  const staff = {};
  const roles = (await request('GET', G('roles'))).items;
  for (const name of ['ravi', 'sita', 'outsider']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      [restaurant.id, `Cashier ${name}`, `counter-${name}@test.invalid`, hash]);
    staff[name] = { id: Number(person.id), token: await login(`counter-${name}@test.invalid`) };
    staff[name].call = as(staff[name].token);
    if (name !== 'outsider') await request('POST', G('members'), { userId: person.id, roleId: roles.find((r) => r.template_code === 'cashier').id }, 201);
  }

  const item = (biz, body) => request('POST', `/businesses/${biz.id}/catalog`, { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '5', ...body }, 201);
  const supplierOf = async (biz) => request('POST', `/businesses/${biz.id}/contacts`, { kind: 'supplier', name: 'Main supplier' }, 201);
  const receive = async (biz, location, supplier, lines) => request('POST', `/businesses/${biz.id}/documents`,
    { kind: 'purchase', requestKey: key(), locationId: location.id, contactId: supplier.id, lines }, 201);

  const groceries = {};
  await t.test('setup: stock at the grocery', async () => {
    const supplier = await supplierOf(grocery);
    groceries.oil = await item(grocery, { name: 'Sunflower oil 1 L', code: 'OIL1', price: '180', mrp: '199', hsnCode: '1512' });
    groceries.atta = await item(grocery, { name: 'Atta 5 kg', code: 'ATTA5', price: '260', taxRate: '0', hsnCode: '1101' });
    await receive(grocery, groceryLocation, supplier, [
      { skuId: groceries.oil.id, quantity: '50', unitPrice: '150' }, { skuId: groceries.atta.id, quantity: '50', unitPrice: '220' }]);
  });

  // --- 1. Split payment --------------------------------------------------------------
  await t.test('split payment: cash + UPI + card on one bill, change from cash only', async () => {
    const lines = [{ skuId: groceries.oil.id, quantity: '2' }, { skuId: groceries.atta.id, quantity: '1' }]; // 360 + 260 = 620
    const base = { kind: 'sale', locationId: groceryLocation.id, lines };
    // Only cash is over-tendered.
    await request('POST', G('documents'), { ...base, requestKey: key(), payments: [{ method: 'upi', amount: '100', tendered: '200' }] }, 400);
    await request('POST', G('documents'), { ...base, requestKey: key(), payment: { method: 'cash', amount: 'full' }, payments: [] }, 400);
    // More than the bill is refused; less than the bill from a walk-in too.
    await request('POST', G('documents'), { ...base, requestKey: key(), payments: [{ method: 'cash', amount: '400' }, { method: 'upi', amount: '300' }] }, 400);
    await request('POST', G('documents'), { ...base, requestKey: key(), payments: [{ method: 'cash', amount: '200' }, { method: 'upi', amount: '300' }] }, 409);
    await request('POST', G('documents'), { ...base, requestKey: key(), payments: [{ method: 'cash', amount: 'full' }, { method: 'upi', amount: 'full' }] }, 400);
    const sale = await request('POST', G('documents'), { ...base, requestKey: key(),
      payments: [{ method: 'upi', amount: '300', reference: 'UPI 8812' }, { method: 'card', amount: '120' }, { method: 'cash', amount: 'full', tendered: '500' }] }, 201);
    assert.equal(sale.total, '620.00');
    assert.equal(sale.change, '300.00');
    const detail = await request('GET', G(`documents/${sale.id}`));
    const by = Object.fromEntries(detail.payments.map((p) => [p.method, p]));
    assert.equal(by.upi.amount, '300.00');
    assert.equal(by.upi.reference, 'UPI 8812');
    assert.equal(by.card.amount, '120.00');
    assert.equal(by.cash.amount, '200.00');
    assert.equal(by.cash.tendered, '500.00');
    // The old single payment still works.
    const single = await request('POST', G('documents'), { ...base, requestKey: key(), payment: { method: 'cash', amount: 'full' } }, 201);
    assert.equal((await request('GET', G(`documents/${single.id}`))).payments.length, 1);
  });

  await t.test('split payment with udhaar: the rest goes on the named customer; day close counts each part', async () => {
    const customer = await request('POST', G('contacts'), { kind: 'customer', name: 'Lakshmi', phone: '9845012345' }, 201);
    const sale = await request('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: groceryLocation.id, contactId: customer.id,
      lines: [{ skuId: groceries.oil.id, quantity: '5' }], payments: [{ method: 'cash', amount: '300' }, { method: 'upi', amount: '200' }] }, 201);
    assert.equal(sale.total, '900.00');
    const contact = (await request('GET', G(`contacts?q=Lakshmi`))).items[0];
    assert.equal(Number(contact.balance), 400);
    const day = await request('GET', G('reports/takings'));
    // Bills: 620 (300 UPI + 120 card + 200 cash) + 620 cash + 900 (300 cash + 200 UPI + 400 udhaar).
    assert.equal(day.received.cash, '1120.00');
    assert.equal(day.received.upi, '500.00');
    assert.equal(day.received.card, '120.00');
    assert.equal(day.received.atSale, '1740.00');
    assert.equal(day.sales.onCredit, '400.00');
    assert.equal(day.cashInHand, '1120.00');
  });

  // --- 2. Per-staff PIN at the counter ---------------------------------------------------
  await t.test('counter PIN: switch who is billing, and the PIN for every bill', async () => {
    await call('PUT', '/auth/me/pin', { password, pin: '4826', confirmPin: '4826' }, staff.ravi.token);
    await call('PUT', '/auth/me/pin', { password, pin: '7391', confirmPin: '7391' }, staff.sita.token);
    const list = await staff.ravi.call('GET', G('counter/staff'));
    assert.equal(list.current, staff.ravi.id);
    const sita = list.people.find((p) => p.id === staff.sita.id);
    assert.equal(sita.hasPin, true);
    assert.ok(!list.people.some((p) => p.id === staff.outsider.id));
    // Wrong PIN: refused with the tries left; another business's person: not here.
    const wrong = await call('POST', G('counter/switch'), { userId: staff.sita.id, pin: '1397' }, staff.ravi.token);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.data.reason, 'wrong_pin');
    await staff.ravi.call('POST', G('counter/switch'), { userId: staff.outsider.id, pin: '4826' }, 404);
    const session = await staff.ravi.call('POST', G('counter/switch'), { userId: staff.sita.id, pin: '7391' });
    assert.equal(session.user.id, staff.sita.id);
    const asSita = as(session.token);
    const lines = [{ skuId: groceries.oil.id, quantity: '1' }];
    const bill = await asSita('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: groceryLocation.id, lines, payment: { method: 'cash', amount: 'full' }, channel: 'counter' }, 201);
    assert.equal(Number(bill.created_by), staff.sita.id);
    // "Ask the PIN for every bill".
    const s = await request('GET', G('settings'));
    await request('PUT', G('settings'), { displayName: s.display_name, taxMode: s.tax_mode, rounding: s.rounding, fiscalYearStartMonth: s.fiscal_year_start_month,
      dateFormat: s.date_format, counterPinEveryBill: true });
    assert.equal((await request('GET', G('context'))).settings.counter_pin_every_bill, true);
    const body = () => ({ kind: 'sale', requestKey: key(), locationId: groceryLocation.id, lines, payment: { method: 'cash', amount: 'full' }, channel: 'counter' });
    const missing = await call('POST', G('documents'), body(), session.token);
    assert.equal(missing.status, 403);
    assert.equal(missing.body.data.reason, 'pin_required');
    await asSita('POST', G('documents'), { ...body(), counterPin: '4826' }, 400);
    const pinned = body();
    const posted = await asSita('POST', G('documents'), { ...pinned, counterPin: '7391' }, 201);
    assert.equal(Number(posted.created_by), staff.sita.id);
    // The PIN is never part of the stored request: a retry with it is the same bill.
    const again = await asSita('POST', G('documents'), { ...pinned, counterPin: '7391' }, 201);
    assert.equal(again.id, posted.id);
    // Other screens (no counter channel) are not asked.
    await asSita('POST', G('documents'), { ...body(), channel: undefined }, 201);
    await request('PUT', G('settings'), { displayName: s.display_name, taxMode: s.tax_mode, rounding: s.rounding, fiscalYearStartMonth: s.fiscal_year_start_month,
      dateFormat: s.date_format, counterPinEveryBill: false });
  });

  // --- 3. Loyalty: spent points come back on a return ---------------------------------------
  await t.test('loyalty: points spent come back in proportion on a return (setting on by default)', async () => {
    if (!grocery.capabilities.includes('loyalty')) await request('PUT', G('modules/loyalty'), { enabled: true });
    const rules = await request('GET', G('loyalty/rules'));
    assert.equal(rules.return_spent_points, true);
    await request('PUT', G('loyalty/rules'), { earnPerAmount: '100', earnPoints: 1, pointValue: '1', minRedeemPoints: 10, maxRedeemPercent: '50', active: true });
    const customer = await request('POST', G('contacts'), { kind: 'customer', name: 'Points customer', phone: '9845099999' }, 201);
    await request('POST', G(`loyalty/${customer.id}/adjustments`), { points: 200, reason: 'Opening points', requestKey: key() }, 201);
    // 4 × 180 = 720, 100 points (₹100) redeemed: pays 620, earns 6.
    const sale = await request('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: groceryLocation.id, contactId: customer.id,
      lines: [{ skuId: groceries.oil.id, quantity: '4' }], loyalty: { redeemPoints: 100 }, payment: { method: 'cash', amount: 'full' } }, 201);
    assert.equal(sale.total, '620.00');
    const balance = async () => (await request('GET', G(`loyalty/${customer.id}`))).balance;
    assert.equal(await balance(), 200 - 100 + 6);
    const line = (await request('GET', G(`documents/${sale.id}`))).lines[0];
    // Half the goods back: 50 spent points back, 3 earned points taken back.
    await request('POST', G(`documents/${sale.id}/returns`), { requestKey: key(), reason: 'Leaking', lines: [{ lineId: line.id, quantity: '2', restock: true }] }, 201);
    assert.equal(await balance(), 106 + 50 - 3);
    // The rest: everything spent is back and everything earned gone.
    await request('POST', G(`documents/${sale.id}/returns`), { requestKey: key(), reason: 'Leaking', lines: [{ lineId: line.id, quantity: '2', restock: true }] }, 201);
    assert.equal(await balance(), 200);
    const entries = await pool.query("SELECT kind,points,value FROM retail_loyalty_entries WHERE document_id=$1 AND kind='restore' ORDER BY id", [sale.id]);
    assert.deepEqual(entries.rows.map((e) => [e.points, e.value]), [[50, '50.00'], [50, '50.00']]);
    // Switched off: nothing comes back.
    await request('PUT', G('loyalty/rules'), { earnPerAmount: '100', earnPoints: 1, pointValue: '1', minRedeemPoints: 10, maxRedeemPercent: '50', active: true, returnSpentPoints: false });
    const second = await request('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: groceryLocation.id, contactId: customer.id,
      lines: [{ skuId: groceries.oil.id, quantity: '2' }], loyalty: { redeemPoints: 50 }, payment: { method: 'cash', amount: 'full' } }, 201);
    const secondLine = (await request('GET', G(`documents/${second.id}`))).lines[0];
    await request('POST', G(`documents/${second.id}/returns`), { requestKey: key(), reason: 'Changed mind', lines: [{ lineId: secondLine.id, quantity: '2', restock: true }] }, 201);
    assert.equal(await balance(), 150);
  });

  // --- 3b. An advance handed back stops being the customer's advance --------------------
  await t.test('advance refunds: balance, udhaar book and unallocated receipts show only what is left', async () => {
    const customer = await request('POST', G('contacts'), { kind: 'customer', name: 'Advance customer', phone: '9845077777' }, 201);
    const receipt = await request('POST', G(`udhaar/${customer.id}/collections`), { locationId: groceryLocation.id, amount: '1000', method: 'cash', requestKey: key() }, 201);
    const collectionId = receipt.id || receipt.collection?.id || receipt.collectionId;
    assert.ok(collectionId, JSON.stringify(receipt));
    const balance = async () => Number((await request('GET', G(`contacts?q=Advance customer`))).items[0].balance);
    assert.equal(await balance(), -1000);
    // Handed back 300 (the salon / repair refund service, with a manager's approval).
    const repo = require('../../src/modules/business/core/repositories/business.repository');
    const access = require('../../src/modules/business/core/services/businessAccess.service');
    const { refundCollection } = require('../../src/modules/business/salon-weight/services/businessAdvanceRefunds');
    const business = await access.load({ id: ownerUser.id }, grocery.id);
    await repo.transaction(async (db) => {
      await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [grocery.id]);
      return refundCollection(db, business, { id: ownerUser.id }, { collectionId, contactId: customer.id,
        input: { amount: 30000, method: 'cash', reference: null, requestKey: key() }, approval: { reason: 'Customer asked for part back', approver: { id: Number(ownerUser.id), name: 'Counter owner' } }, source: 'salon' });
    });
    assert.equal(await balance(), -700);
    const book = await request('GET', G('udhaar?show=advance'));
    const row = book.items.find((r) => Number(r.id ?? r.contact_id) === Number(customer.id));
    assert.ok(row, 'the customer is listed with an advance');
    assert.equal(Number(row.balance), -700);
    const account = await request('GET', G(`udhaar/${customer.id}`));
    assert.equal(Number(account.summary.balance), -700);
    assert.deepEqual(account.advances.map((a) => Number(a.unallocated)), [700]);
  });

  // --- 4. Kits ---------------------------------------------------------------------------
  const phones = {};
  await t.test('kits: sold as their components, price split for GST and HSN, serials asked', async () => {
    const supplier = await supplierOf(electronics);
    phones.phone = await item(electronics, { name: 'Orbit 5G 8/128', code: 'ORB5G', tracking: 'serial', price: '15999', taxRate: '18', hsnCode: '851713' });
    phones.cover = await item(electronics, { name: 'Orbit back cover', code: 'ORBCOV', price: '499', taxRate: '18', hsnCode: '392690' });
    phones.guard = await item(electronics, { name: 'Tempered glass', code: 'GLASS', price: '299', taxRate: '18', hsnCode: '700719' });
    phones.charger = await item(electronics, { name: 'Charger 33 W', code: 'CHG33', price: '999', taxRate: '28', hsnCode: '850440' });
    await receive(electronics, shopLocation, supplier, [
      { skuId: phones.phone.id, quantity: '1', unitPrice: '12000', lotCode: '356789012345671' },
      { skuId: phones.phone.id, quantity: '1', unitPrice: '12000', lotCode: '356789012345672' },
      { skuId: phones.phone.id, quantity: '1', unitPrice: '12000', lotCode: '356789012345673' },
      { skuId: phones.cover.id, quantity: '10', unitPrice: '150' }, { skuId: phones.guard.id, quantity: '10', unitPrice: '60' },
      { skuId: phones.charger.id, quantity: '10', unitPrice: '500' }]);
    await request('PUT', E(`electronics/models/${phones.phone.id}`), { serialKind: 'imei', warrantyMonths: 12, warrantyTerms: 'One year.', helpline: '1800 123 456' });
    // A kit needs goods, and a serial part only once.
    await request('POST', E('kits'), { name: 'Bad kit', code: 'BAD', price: '100', components: [{ skuId: phones.phone.id, quantity: 2 }] }, 400);
    const kit = await request('POST', E('kits'), { name: 'Orbit 5G combo', code: 'ORBKIT', barcode: '8901234500017', price: '16499', mrp: '17797',
      components: [{ skuId: phones.phone.id, quantity: 1 }, { skuId: phones.cover.id, quantity: 1 }, { skuId: phones.guard.id, quantity: 1 }] }, 201);
    assert.equal(kit.is_kit, true);
    const kits = await request('GET', E('kits'));
    assert.equal(kits.total, 1);
    assert.equal(kits.items[0].available, 3);
    assert.equal(kits.items[0].components.length, 3);
    // The counter scan shows the parts and the phones in stock.
    const scanned = await request('GET', E(`retail/scan?code=8901234500017&locationId=${shopLocation.id}`));
    assert.equal(scanned.kit.components.length, 3);
    assert.equal(scanned.kit.components.find((c) => c.skuId === phones.phone.id).lots.length, 3);
    // Not bought as a kit; the phone's serial is needed.
    await request('POST', E('documents'), { kind: 'purchase', requestKey: key(), locationId: shopLocation.id, contactId: supplier.id, lines: [{ skuId: kit.id, quantity: '1', unitPrice: '1' }] }, 409);
    const base = { kind: 'sale', locationId: shopLocation.id, buyer: { name: 'Suresh', phone: '9000012345' }, payment: { method: 'cash', amount: 'full' } };
    await request('POST', E('documents'), { ...base, requestKey: key(), lines: [{ skuId: kit.id, quantity: '1' }] }, 400);
    await request('POST', E('documents'), { ...base, requestKey: key(), lines: [{ skuId: kit.id, quantity: '2', components: [{ skuId: phones.phone.id, lotCode: '356789012345671' }] }] }, 400);
    // A quote shows the kit's parts against the line they came from.
    const quote = await request('POST', E('retail/quote'), { locationId: shopLocation.id, lines: [{ skuId: phones.charger.id, quantity: '1' },
      { skuId: kit.id, quantity: '1', components: [{ skuId: phones.phone.id, lotCode: '356789012345671' }] }] });
    assert.deepEqual(quote.lines.map((l) => l.inputIndex), [0, 1, 1, 1]);
    assert.equal(quote.lines[1].kitLabel, 'Orbit 5G combo');
    const sale = await request('POST', E('documents'), { ...base, requestKey: key(), lines: [{ skuId: phones.charger.id, quantity: '1' },
      { skuId: kit.id, quantity: '1', components: [{ skuId: phones.phone.id, lotCode: '356789012345671' }] }] }, 201);
    assert.equal(sale.total, String((999 + 16499).toFixed(2)));
    const detail = await request('GET', E(`documents/${sale.id}`));
    const parts = detail.lines.filter((l) => l.kit_sku_id);
    assert.equal(parts.length, 3);
    assert.ok(parts.every((l) => l.kit_label === 'Orbit 5G combo' && l.kit_group === 1));
    // The kit price, split by list price (15999 : 499 : 299), to the paisa.
    const gross = parts.map((l) => paise(l.net) + paise(l.tax));
    assert.equal(gross.reduce((s, x) => s + x, 0), 1649900);
    assert.deepEqual(parts.map((l) => l.hsn_code), ['851713', '392690', '700719']);
    assert.equal(parts[0].lot_code, '356789012345671');
    assert.ok(gross[0] > gross[1] && gross[1] > gross[2]);
    // Stock came off each part; the kit can now be made twice.
    assert.equal((await request('GET', E('kits'))).items[0].available, 2);
    // A warranty was registered for the phone in the kit.
    assert.ok((sale.warranties || []).some((w) => w.serial === '356789012345671'));
  });

  // --- 5. EMI & finance ----------------------------------------------------------------
  await t.test('EMI: the financed part is owed by the financier; payout net of subvention; cancel after a return', async () => {
    assert.ok((await request('GET', E('context'))).modules.includes('finance'));
    const financiers = (await request('GET', E('finance/financiers'))).items;
    assert.deepEqual(financiers.map((f) => f.name).sort(), ['Bajaj Finserv', 'HDFC Bank', 'Home Credit', 'ICICI Bank']);
    const bajaj = financiers.find((f) => f.name === 'Bajaj Finserv');
    await request('PATCH', E(`finance/financiers/${bajaj.id}`), { subventionPercent: '2' });
    const tvs = await request('POST', E('finance/financiers'), { name: 'TVS Credit', subventionPercent: '1.5' }, 201);
    await request('POST', E('finance/financiers'), { name: 'tvs credit' }, 409);
    const customer = await request('POST', E('contacts'), { kind: 'customer', name: 'Priya Nair', phone: '9888812345' }, 201);
    const lines = [{ skuId: phones.phone.id, quantity: '1', lotCode: '356789012345672' }];
    const body = (extra) => ({ kind: 'sale', locationId: shopLocation.id, contactId: customer.id, lines, requestKey: key(), ...extra });
    // A walk-in with no name is refused; so is more than the bill.
    await request('POST', E('documents'), { ...body({ contactId: undefined }), payments: [{ method: 'cash', amount: '3000' }], finance: { financierId: bajaj.id, loanNo: 'BFL-1' } }, 409);
    await request('POST', E('documents'), body({ finance: { financierId: bajaj.id, loanNo: 'BFL-1', amount: '20000' } }), 400);
    const sale = await request('POST', E('documents'), body({ payments: [{ method: 'cash', amount: '2000', tendered: '2000' }, { method: 'upi', amount: '999' }],
      finance: { financierId: bajaj.id, loanNo: 'BFL-778812', doNo: 'DO-5521', tenureMonths: 9, amount: 'rest' } }), 201);
    assert.equal(sale.total, '15999.00');
    assert.equal(sale.financeCase.financed_amount, '13000.00');
    assert.equal(sale.financeCase.down_payment, '2999.00');
    // Same loan twice is refused.
    await request('POST', E('documents'), body({ lines: [{ skuId: phones.charger.id, quantity: '1' }], finance: { financierId: bajaj.id, loanNo: 'bfl-778812' } }), 409);
    // The customer owes nothing; the bill shows the case.
    assert.equal(Number((await request('GET', E(`contacts?q=Priya`))).items[0].balance), 0);
    const detail = await request('GET', E(`documents/${sale.id}`));
    assert.equal(detail.finance[0].loan_no, 'BFL-778812');
    assert.ok(detail.payments.some((p) => p.method === 'finance' && p.amount === '13000.00'));
    // Day close: the financed part is not money in the drawer.
    let day = await request('GET', E('reports/takings'));
    assert.equal(day.finance.booked, '13000.00');
    assert.equal(day.received.upi, '999.00');
    // What the financiers owe.
    const owed = await request('GET', E('finance/outstanding'));
    const row = owed.items.find((r) => r.name === 'Bajaj Finserv');
    assert.equal(row.cases, 1);
    assert.equal(row.financed, '13000.00');
    assert.equal(row.expected_subvention, '260.00');
    // A second EMI, with TVS, cancelled after the goods came back.
    const second = await request('POST', E('documents'), body({ lines: [{ skuId: phones.charger.id, quantity: '1' }], payments: [{ method: 'cash', amount: '199' }],
      finance: { financierId: tvs.id, loanNo: 'TVS-11', amount: 'rest' } }), 201);
    const secondCase = (await request('GET', E(`finance/cases?financierId=${tvs.id}`))).items[0];
    await request('POST', E(`finance/cases/${secondCase.id}/cancel`), { reason: 'Customer returned it', requestKey: key() }, 409);
    const secondLine = (await request('GET', E(`documents/${second.id}`))).lines[0];
    await request('POST', E(`documents/${second.id}/returns`), { requestKey: key(), reason: 'Returned', lines: [{ lineId: secondLine.id, quantity: '1', restock: true }] }, 201);
    // The customer gets back only what they paid themselves.
    await request('POST', E(`documents/${second.id}/refunds`), { requestKey: key(), amount: '300', method: 'cash', reason: 'Return' }, 409);
    await request('POST', E(`finance/cases/${secondCase.id}/cancel`), { reason: 'Customer returned it', requestKey: key() });
    await request('POST', E(`documents/${second.id}/refunds`), { requestKey: key(), amount: '199', method: 'cash', reason: 'Return' }, 201);
    assert.equal(Number((await request('GET', E(`contacts?q=Priya`))).items[0].balance), 0);
    // The payout: 13000 less 2% subvention = 12740; a wrong amount is refused.
    const settle = { financierId: bajaj.id, locationId: shopLocation.id, receivedOn: today(electronics.timezone), method: 'bank', reference: 'UTR998877',
      cases: [{ caseId: sale.financeCase.id }] };
    await request('POST', E('finance/settlements'), { ...settle, requestKey: key(), amountReceived: '13000' }, 409);
    const payout = await request('POST', E('finance/settlements'), { ...settle, requestKey: key(), amountReceived: '12740' }, 201);
    assert.equal(payout.subvention_total, '260.00');
    await request('POST', E('finance/settlements'), { ...settle, requestKey: key(), amountReceived: '12740' }, 409);
    const settled = (await request('GET', E('finance/cases?status=settled'))).items;
    assert.equal(settled[0].subvention_charged, '260.00');
    day = await request('GET', E('reports/takings'));
    assert.equal(day.received.fromFinanciers, '12740.00');
    assert.equal(day.finance.subvention, '260.00');
    assert.equal(day.finance.cancelled, '800.00');
    // Cases never move back.
    await assert.rejects(pool.query("UPDATE electronics_finance_cases SET status='pending' WHERE id=$1", [sale.financeCase.id]));
    // A cashier sells on EMI but cannot record payouts.
    const eRoles = (await request('GET', E('roles'))).items;
    await request('POST', E('members'), { userId: staff.ravi.id, roleId: eRoles.find((r) => r.template_code === 'cashier').id }, 201);
    await staff.ravi.call('POST', E('finance/settlements'), { ...settle, requestKey: key(), amountReceived: '1' }, 403);
    assert.ok((await staff.ravi.call('GET', E('finance/financiers'))).items.length >= 5);
  });
});
