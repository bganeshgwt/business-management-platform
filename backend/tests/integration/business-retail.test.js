const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { signIn } = require('./helpers/signIn');

// Retail (grocery / kirana, supermarket, books & stationery):
// offers applied by the server, loyalty points, udhaar on the shared
// receivables (reminders, collections, statements), barcode and scale-label
// lookup, in-store barcodes, book details and retail reports. Each rule, the
// permission refusals and attempts across businesses. Runs on its own
// throwaway database with every migration applied.
test('retail: offers, loyalty, udhaar, barcodes, books and reports', { timeout: 300000 }, async (t) => {
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
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('retail-owner');
  await owner('retail-other');
  const token = await login('retail-owner@test.invalid');
  const otherToken = await login('retail-other@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();
  const ean = (twelve) => { let s = 0; for (let i = 0; i < 12; i += 1) s += Number(twelve[i]) * (i % 2 ? 3 : 1); return twelve + ((10 - (s % 10)) % 10); };

  const [grocery, supermarket, books] = await withTools(request, await createBusinesses(request, 'OWNER', ['grocery', 'supermarket', 'books']));
  const [otherGrocery] = await createBusinesses(other, 'OTHER', ['grocery']);
  // Goods shops start with prices including GST, rounded to the rupee, and a
  // walk-in pays in full. These checks use prices before GST and post unpaid
  // walk-in bills as fixtures.
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const root = (business, suffix) => `/businesses/${business.id}/${suffix}`;

  // Staff of the owner's restaurant with template roles in the grocery.
  const staff = {};
  for (const template of ['cashier', 'stock_keeper', 'viewer']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      [ownerUser.restaurant_id, `Retail ${template}`, `retail-${template}@test.invalid`, hash]);
    staff[template] = { id: person.id, token: await login(`retail-${template}@test.invalid`) };
  }

  await t.test('retail modules and permissions are in the catalogue, with sensible defaults per type', async () => {
    const modules = await request('GET', root(supermarket, 'modules'));
    assert.ok(modules.find((m) => m.code === 'offers').enabled, 'a supermarket starts with offers');
    assert.ok(modules.find((m) => m.code === 'loyalty').enabled, 'a supermarket starts with loyalty');
    const kirana = await request('GET', root(grocery, 'modules'));
    assert.equal(kirana.find((m) => m.code === 'offers').enabled, false, 'a kirana may switch offers on but does not start with them');
    await request('GET', root(grocery, 'offers'), undefined, 403);
    await request('PUT', root(grocery, 'modules/offers'), { enabled: true });
    await request('PUT', root(grocery, 'modules/loyalty'), { enabled: true });
    const roles = (await request('GET', root(grocery, 'roles'))).items;
    const cashier = roles.find((r) => r.template_code === 'cashier');
    assert.ok(cashier.permissions.includes('loyalty.create') && cashier.permissions.includes('offers.view'));
    assert.ok(!cashier.permissions.includes('offers.create'), 'a cashier cannot set up offers');
    for (const [template, person] of Object.entries(staff)) {
      await request('POST', root(grocery, 'members'), { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    }
  });

  let location, supplier, ramesh, sunita, rice, ghee, salt, biscuit, unsold, staples;
  await t.test('set-up: categories, items, stock', async () => {
    location = (await request('GET', root(grocery, 'locations'))).items[0];
    supplier = await request('POST', root(grocery, 'contacts'), { kind: 'supplier', name: 'Agarwal Traders' }, 201);
    ramesh = await request('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'Ramesh', phone: '9820011111' }, 201);
    sunita = await request('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'Sunita', phone: '9820022222', creditDays: 7 }, 201);
    staples = await request('POST', root(grocery, 'categories'), { name: 'Staples' }, 201);
    const riceCategory = await request('POST', root(grocery, 'categories'), { name: 'Rice', parentId: staples.id }, 201);
    const item = (name, code, unit, price, taxRate, categoryId) => request('POST', root(grocery, 'catalog'),
      { name, code, kind: 'goods', unit, tracking: 'quantity', price, taxRate, categoryId }, 201);
    rice = await item('Sona Masoori rice', 'RICE', 'kg', '60', '5', riceCategory.id);
    ghee = await item('Cow ghee 1 L', 'GHEE', 'each', '300', '5');
    salt = await item('Iodised salt 1 kg', 'SALT', 'each', '20', '0');
    biscuit = await item('Glucose biscuits', 'BISC', 'each', '10', '18');
    unsold = await item('Camphor tablets', 'CAMP', 'each', '40', '18');
    await request('POST', root(grocery, 'documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(),
      lines: [rice, ghee, salt, biscuit, unsold].map((s) => ({ skuId: s.id, quantity: '100', unitPrice: (Number(s.price) * 0.7).toFixed(2) })) }, 201);
  });

  // IST clock for an offer window that is certainly not now.
  const istHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const isoWeekday = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
  const billLines = () => [{ skuId: rice.id, quantity: '2.5' }, { skuId: salt.id, quantity: '2' }, { skuId: salt.id, quantity: '1' }, { skuId: ghee.id, quantity: '3' }, { skuId: biscuit.id, quantity: '3' }];
  let firstSale;

  await t.test('offers are validated and refused when they make no sense', async () => {
    const offer = (body, expected = 201) => request('POST', root(grocery, 'offers'), { startsOn: today, ...body }, expected);
    await offer({ name: 'Too much', kind: 'item_percent', skuId: rice.id, value: '120' }, 400);
    await offer({ name: 'No item', kind: 'item_percent', value: '10' }, 400);
    await offer({ name: 'Backwards', kind: 'bill_percent', value: '5', endsOn: '2020-01-01' }, 400);
    await offer({ name: 'Half a time', kind: 'bill_percent', value: '5', startsTime: '10:00' }, 400);
    await offer({ name: 'Whole units', kind: 'buy_x_get_y', skuId: salt.id, buyQuantity: '1.5', getQuantity: '1', value: '100' }, 400);
    const foreignSku = await one("SELECT id FROM catalog_skus WHERE business_id=$1 LIMIT 1", [supermarket.id]);
    if (foreignSku) await offer({ name: 'Foreign', kind: 'item_percent', skuId: foreignSku.id, value: '10' }, 404);
    await request('POST', root(grocery, 'offers'), { name: 'Cashier offer', kind: 'bill_percent', value: '5', startsOn: today }, 201).then(() => {});
    await as(staff.cashier.token)('POST', root(grocery, 'offers'), { name: 'Nope', kind: 'bill_percent', value: '5', startsOn: today }, 403);
    // That test offer is switched off again so it does not change the bill below.
    const created = (await request('GET', root(grocery, 'offers?q=Cashier'))).items[0];
    await request('PATCH', root(grocery, `offers/${created.id}`), { active: false });
    await as(staff.cashier.token)('PATCH', root(grocery, `offers/${created.id}`), { active: true }, 403);
  });

  await t.test('the server applies the best item offer, buy-X-get-Y across lines, caps, then one bill offer', async () => {
    const offer = (body) => request('POST', root(grocery, 'offers'), { startsOn: today, ...body }, 201);
    await offer({ name: 'Staples 10%', kind: 'category_percent', categoryId: staples.id, value: '10' });
    await offer({ name: 'Rice 5%', kind: 'item_percent', skuId: rice.id, value: '5' });
    await offer({ name: 'Salt 2+1', kind: 'buy_x_get_y', skuId: salt.id, buyQuantity: '2', getQuantity: '1', value: '100' });
    await offer({ name: 'Ghee ₹20 off', kind: 'item_amount', skuId: ghee.id, value: '20', maxDiscount: '30' });
    await offer({ name: '₹50 off over ₹1,000', kind: 'bill_amount', value: '50', minBillAmount: '1000' });
    await offer({ name: 'Never now', kind: 'bill_percent', value: '50', startsTime: hh(istHour + 6), endsTime: hh(istHour + 7) });
    await offer({ name: 'Not today', kind: 'item_percent', skuId: biscuit.id, value: '30', daysOfWeek: [(isoWeekday % 7) + 1] });
    await offer({ name: 'Switched off', kind: 'item_percent', skuId: biscuit.id, value: '50', active: false });
    await offer({ name: 'Starts later', kind: 'item_percent', skuId: biscuit.id, value: '40', startsOn: '2099-01-01' });

    const quote = await request('POST', root(grocery, 'retail/quote'), { locationId: location.id, lines: billLines() });
    const discount = (index) => Number(quote.lines[index].discount);
    // Rice: 10% of its category beats 5% of the item; plus its share of ₹50.
    assert.deepEqual(quote.lines[0].offers.map((o) => o.label), ['Staples 10%', '₹50 off over ₹1,000']);
    assert.equal(Number(quote.lines[0].offers[0].amount), 15);
    // Salt 2 + 1 on two lines is one free packet (₹20), split 13.33 / 6.67.
    assert.equal(Number(quote.lines[1].offers[0].amount) + Number(quote.lines[2].offers[0].amount), 20);
    // Ghee ₹20 × 3 is capped at ₹30 a bill.
    assert.equal(Number(quote.lines[3].offers[0].amount), 30);
    assert.ok(!quote.lines[4].offers.some((o) => o.label !== '₹50 off over ₹1,000'), 'off, later, other-day and out-of-hours offers do not apply');
    assert.equal(Number(quote.savings), 115, '15 + 20 + 30 item offers, then ₹50 off the bill');
    assert.equal([0, 1, 2, 3, 4].reduce((s, i) => s + Math.round(discount(i) * 100), 0), 11500);
    assert.equal(Number(quote.subtotal), 1025);
    // Tax is worked out on what is left after the discount, line by line.
    for (const line of quote.lines) {
      assert.equal(Math.round(Number(line.net) * 100), Math.round(Number(line.amount) * 100) - Math.round(Number(line.discount) * 100));
      assert.equal(Number(line.tax), Math.round(Number(line.net) * Number(line.taxRate)) / 100);
    }
    assert.equal(Number(quote.total), 1078.07);

    // Posting gives exactly the quote, and keeps the discount on each line.
    firstSale = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, contactId: ramesh.id, requestKey: key(), lines: billLines(),
      payment: { amount: '1078.07', method: 'upi' } }, 201);
    assert.equal(Number(firstSale.total), 1078.07);
    const detail = await request('GET', root(grocery, `documents/${firstSale.id}`));
    assert.equal(Number(detail.retail.savings), 115);
    for (const line of detail.lines) {
      const given = detail.retail.discounts.filter((d) => d.line_id === line.id).reduce((s, d) => s + Math.round(Number(d.amount) * 100), 0);
      const gross = Math.round(Number(line.unit_price) * Number(line.quantity) * 100);
      assert.equal(Math.round(Number(line.net) * 100), gross - given, `${line.label}: price × quantity − discounts = taxable value`);
    }
    // The discount lines are a snapshot: they cannot be edited afterwards.
    await assert.rejects(pool.query('UPDATE retail_sale_discounts SET amount=amount+1 WHERE business_id=$1', [grocery.id]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM retail_sale_discounts WHERE business_id=$1', [grocery.id]), { code: '23514' });
  });

  await t.test('an offer switched off, or the module off, changes nothing on old bills and no new bill gets it', async () => {
    const before = await request('GET', root(grocery, `documents/${firstSale.id}`));
    await request('PUT', root(grocery, 'modules/offers'), { enabled: false });
    const plain = await request('POST', root(grocery, 'retail/quote'), { locationId: location.id, lines: billLines() });
    assert.equal(Number(plain.savings), 0);
    assert.equal(Number(plain.subtotal), 1140);
    await request('PUT', root(grocery, 'modules/offers'), { enabled: true });
    const after = await request('GET', root(grocery, `documents/${firstSale.id}`));
    assert.deepEqual(after.retail.discounts, before.retail.discounts);
    const list = (await request('GET', root(grocery, 'offers?status=running'))).items;
    assert.ok(list.find((o) => o.name === 'Staples 10%').bills >= 1 && Number(list.find((o) => o.name === 'Staples 10%').given) > 0);
    assert.ok(!list.some((o) => ['Switched off', 'Starts later'].includes(o.name)));
    const given = await request('GET', root(grocery, `offers/given?from=${today}&to=${today}`));
    assert.equal(given.rows.reduce((s, r) => s + Math.round(Number(r.given) * 100), 0), 11500);
  });

  await t.test('prices including GST: discounts come off the gross, GST is worked out of what is left', async () => {
    await pool.query("UPDATE business_settings SET tax_mode='inclusive' WHERE business_id=$1", [supermarket.id]);
    const where = (await request('GET', root(supermarket, 'locations'))).items[0];
    const soap = await request('POST', root(supermarket, 'catalog'), { name: 'Bath soap', code: 'SOAP-T', kind: 'goods', unit: 'each', tracking: 'quantity', price: '118', taxRate: '18' }, 201);
    await request('POST', root(supermarket, 'offers'), { name: '10% off everything', kind: 'bill_percent', value: '10', startsOn: today }, 201);
    const quote = await request('POST', root(supermarket, 'retail/quote'), { locationId: where.id, lines: [{ skuId: soap.id, quantity: '1' }] });
    assert.deepEqual([quote.lines[0].discount, quote.lines[0].net, quote.lines[0].tax, quote.total], ['11.80', '90.00', '16.20', '106.20']);
  });

  await t.test('loyalty: earn on the bill, redeem within the rules, corrections never below zero', async () => {
    await request('PUT', root(grocery, 'loyalty/rules'), { earnPerAmount: '0', earnPoints: '1', pointValue: '1', minRedeemPoints: '50', maxRedeemPercent: '20', active: true }, 400);
    await as(staff.cashier.token)('PUT', root(grocery, 'loyalty/rules'), { earnPerAmount: '100', earnPoints: '1', pointValue: '1', minRedeemPoints: '50', maxRedeemPercent: '20', active: true }, 403);
    await request('PUT', root(grocery, 'loyalty/rules'), { earnPerAmount: '100', earnPoints: '1', pointValue: '1', minRedeemPoints: '50', maxRedeemPercent: '20', active: true });
    // The first sale was made before the rules: no points. A new one earns.
    const sale = await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, contactId: ramesh.id, requestKey: key(), lines: billLines() }, 201);
    assert.equal((await request('GET', root(grocery, `loyalty/${ramesh.id}`))).balance, 10, '₹1,078.07 earns 10 points');
    const welcome = key();
    const bonus = await request('POST', root(grocery, `loyalty/${ramesh.id}/adjustments`), { points: '100', reason: 'Welcome bonus', requestKey: welcome }, 201);
    assert.equal(bonus.balance, 110);
    const again = await request('POST', root(grocery, `loyalty/${ramesh.id}/adjustments`), { points: '100', reason: 'Welcome bonus', requestKey: welcome }, 201);
    assert.equal(again.id, bonus.id, 'the same request key records one correction');
    await request('POST', root(grocery, `loyalty/${ramesh.id}/adjustments`), { points: '-500', reason: 'Too many', requestKey: key() }, 409);
    await as(staff.cashier.token)('POST', root(grocery, `loyalty/${ramesh.id}/adjustments`), { points: '5', reason: 'x', requestKey: key() }, 403);

    const gheeSale = (points, extra = {}) => ({ kind: 'sale', locationId: location.id, contactId: ramesh.id, requestKey: key(), lines: [{ skuId: ghee.id, quantity: '1' }], loyalty: { redeemPoints: points }, ...extra });
    await request('POST', root(grocery, 'documents'), gheeSale('40'), 400);
    await request('POST', root(grocery, 'documents'), gheeSale('200'), 409);
    // Ghee ₹300 − ₹20 offer = ₹280 + 5% = ₹294 to pay; 20% of that is ₹58.80.
    const tooMuch = await call('POST', root(grocery, 'documents'), gheeSale('60'), token);
    assert.equal(tooMuch.status, 409);
    assert.match(tooMuch.body.message, /redeem up to 58 points/);
    await request('POST', root(grocery, 'documents'), gheeSale('50', { contactId: null }), 400);
    // A role that can sell but not redeem points is refused.
    const seller = await request('POST', root(grocery, 'roles'), { name: 'Counter (no points)', permissions: ['sales.view', 'sales.create', 'sales.edit', 'catalog.view', 'contacts.view'] }, 201);
    await request('POST', root(grocery, 'members'), { userId: staff.viewer.id, roleId: seller.id }, 201);
    await as(staff.viewer.token)('POST', root(grocery, 'documents'), gheeSale('50'), 403);
    const viewerRole = (await request('GET', root(grocery, 'roles'))).items.find((r) => r.template_code === 'viewer');
    await request('POST', root(grocery, 'members'), { userId: staff.viewer.id, roleId: viewerRole.id }, 201);

    const body = gheeSale('50');
    const redeemed = await as(staff.cashier.token)('POST', root(grocery, 'documents'), body, 201);
    assert.equal(Number(redeemed.total), 244, '50 points take ₹50 off what the customer pays');
    const repeat = await as(staff.cashier.token)('POST', root(grocery, 'documents'), body, 201);
    assert.equal(repeat.id, redeemed.id);
    const entries = await one("SELECT count(*)::int AS n FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2", [grocery.id, redeemed.id]);
    assert.equal(entries.n, 2, 'one redemption and one earning, even when the request is repeated');
    assert.equal((await request('GET', root(grocery, `loyalty/${ramesh.id}`))).balance, 110 - 50 + 2);
    const event = await one("SELECT payload FROM business_events WHERE business_id=$1 AND kind='loyalty.redeemed' AND entity_type='loyalty_entry'", [grocery.id]);
    assert.equal(event.payload.documentId, redeemed.id);

    // Goods coming back shrink the points that bill earned, in proportion.
    const detail = await request('GET', root(grocery, `documents/${sale.id}`));
    const gheeLine = detail.lines.find((l) => l.sku_id === ghee.id);
    await request('POST', root(grocery, `documents/${sale.id}/returns`), { reason: 'Seal broken', requestKey: key(), lines: [{ lineId: gheeLine.id, quantity: '3', restock: false }] }, 201);
    assert.equal((await request('GET', root(grocery, `loyalty/${ramesh.id}`))).balance, 62 - 9, 'the bill now earns 1 point instead of 10');
    const members = await request('GET', root(grocery, 'loyalty/members'));
    assert.equal(members.items.find((m) => m.id === ramesh.id).balance, 53);
    await request('POST', root(grocery, `loyalty/${ramesh.id}/adjustments`), { points: '-53', reason: 'Closing the card', requestKey: key() }, 201);
    assert.equal((await request('GET', root(grocery, `loyalty/${ramesh.id}`))).balance, 0);
  });

  await t.test('points never go below zero: returns take back unspent points, the rest is held back from the refund', async () => {
    await request('PUT', root(supermarket, 'loyalty/rules'), { earnPerAmount: '100', earnPoints: '1', pointValue: '1', minRedeemPoints: '1', maxRedeemPercent: '100', active: true });
    const where = (await request('GET', root(supermarket, 'locations'))).items[0];
    const soap = (await request('GET', root(supermarket, 'catalog?q=SOAP-T'))).items[0];
    const supplierS = await request('POST', root(supermarket, 'contacts'), { kind: 'supplier', name: 'Soap Supplier' }, 201);
    await request('POST', root(supermarket, 'documents'), { kind: 'purchase', locationId: where.id, contactId: supplierS.id, requestKey: key(), lines: [{ skuId: soap.id, quantity: '200', unitPrice: '60' }] }, 201);
    const customer = async (name) => request('POST', root(supermarket, 'contacts'), { kind: 'customer', name }, 201);
    const points = async (c) => (await request('GET', root(supermarket, `loyalty/${c.id}`))).balance;
    const sell = (c, quantity, extra = {}) => request('POST', root(supermarket, 'documents'), { kind: 'sale', locationId: where.id, contactId: c.id, requestKey: key(),
      lines: [{ skuId: soap.id, quantity }], ...extra }, 201);
    const giveBack = async (sale, quantity) => {
      const line = (await request('GET', root(supermarket, `documents/${sale.id}`))).lines[0];
      return request('POST', root(supermarket, `documents/${sale.id}/returns`), { reason: 'Returned', requestKey: key(), lines: [{ lineId: line.id, quantity, restock: true }] }, 201);
    };

    // The verifier's case: earn, spend it all on another bill, return the first bill.
    const meena = await customer('Meena');
    const first = await sell(meena, '10', { payment: { amount: '1062.00', method: 'card' } });
    assert.equal(Number(first.total), 1062);
    assert.equal(await points(meena), 10);
    const second = await sell(meena, '1', { loyalty: { redeemPoints: '10' } });
    assert.equal(Number(second.total), 96.2);
    assert.equal(await points(meena), 0);
    await giveBack(first, '10');
    assert.equal(await points(meena), 0, 'never below zero');
    const reverse = await one("SELECT * FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 AND kind='reverse'", [supermarket.id, first.id]);
    assert.deepEqual([reverse.points, reverse.shortfall_points, Number(reverse.shortfall_value)], [0, 10, 10]);
    const detail = await request('GET', root(supermarket, `documents/${first.id}`));
    assert.equal(detail.retail.heldBack, '10.00');
    const refused = await call('POST', root(supermarket, `documents/${first.id}/refunds`), { amount: '1062', method: 'cash', reason: 'Returned', requestKey: key() }, token);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /kept back for loyalty points/);
    await request('POST', root(supermarket, `documents/${first.id}/refunds`), { amount: '1052', method: 'cash', reason: 'Returned', requestKey: key() }, 201);

    // Returned in parts: the bill gives back exactly what it earned, unspent points first.
    const ravi = await customer('Ravi');
    const big = await sell(ravi, '10', { payment: { amount: '1062.00', method: 'upi' } });
    await giveBack(big, '5');
    assert.equal(await points(ravi), 5);
    await giveBack(big, '5');
    assert.equal(await points(ravi), 0);
    const back = await one("SELECT sum(-points)::int AS taken,sum(shortfall_points)::int AS short FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 AND kind='reverse'", [supermarket.id, big.id]);
    assert.deepEqual([back.taken, back.short], [10, 0]);

    // The database refuses anything that would go below zero, whatever writes it.
    await assert.rejects(pool.query(`INSERT INTO retail_loyalty_entries(business_id,contact_id,kind,points,reason,request_key,created_by)
      VALUES($1,$2,'adjust',-1,'x',$3,$4)`, [supermarket.id, ravi.id, key(), ownerUser.id]), { code: '23514' });

    // A return and a redemption at the same moment: one waits for the other, and the points end at zero either way.
    const asha = await customer('Asha');
    const earned = await sell(asha, '10', { payment: { amount: '1062.00', method: 'cash' } });
    const line = (await request('GET', root(supermarket, `documents/${earned.id}`))).lines[0];
    const [ret, spend] = await Promise.all([
      call('POST', root(supermarket, `documents/${earned.id}/returns`), { reason: 'Returned', requestKey: key(), lines: [{ lineId: line.id, quantity: '10', restock: true }] }, token),
      call('POST', root(supermarket, 'documents'), { kind: 'sale', locationId: where.id, contactId: asha.id, requestKey: key(), lines: [{ skuId: soap.id, quantity: '1' }], loyalty: { redeemPoints: '10' } }, token),
    ]);
    assert.equal(ret.status, 201);
    assert.ok([201, 409].includes(spend.status));
    assert.equal(await points(asha), 0);
    const held = await one("SELECT shortfall_points FROM retail_loyalty_entries WHERE business_id=$1 AND document_id=$2 AND kind='reverse'", [supermarket.id, earned.id]);
    assert.equal(held.shortfall_points, spend.status === 201 ? 10 : 0, 'spent points become the shortfall; unspent ones are simply taken back');
  });

  await t.test('a sale that fails leaves no discounts, points or events behind', async () => {
    const count = async () => one(`SELECT (SELECT count(*) FROM retail_sale_discounts WHERE business_id=$1)::int AS d,
      (SELECT count(*) FROM retail_loyalty_entries WHERE business_id=$1)::int AS l,(SELECT count(*) FROM business_events WHERE business_id=$1)::int AS e`, [grocery.id]);
    const before = await count();
    // Refused for the ghee in stock (the buyer's PAN lets this bill over ₹2,00,000 get that far).
    await request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, contactId: ramesh.id, requestKey: key(), buyer: { pan: 'ABCDE1234F' },
      lines: [{ skuId: rice.id, quantity: '5' }, { skuId: ghee.id, quantity: '5000' }] }, 409);
    assert.deepEqual(await count(), before);
  });

  await t.test('udhaar: the book, collections settle oldest bills, reminders with promises', async () => {
    const credit = (lines) => request('POST', root(grocery, 'documents'), { kind: 'sale', locationId: location.id, contactId: sunita.id, requestKey: key(), lines }, 201);
    const older = await credit([{ skuId: biscuit.id, quantity: '10' }]);
    const newer = await credit([{ skuId: salt.id, quantity: '1' }]);
    await pool.query("UPDATE business_documents SET created_at=now()-interval '20 days',due_on=(now() AT TIME ZONE 'Asia/Kolkata')::date-13 WHERE business_id=$1 AND id=$2", [grocery.id, older.id]);
    const book = await request('GET', root(grocery, 'udhaar'));
    const row = book.items.find((r) => r.contact_id === sunita.id);
    assert.equal(Number(row.balance), Number(older.total) + Number(newer.total));
    assert.ok(Number(row.overdue) > 0, 'the bill past its credit days is overdue');
    await as(staff.viewer.token)('GET', root(grocery, 'udhaar'));
    await as(staff.viewer.token)('POST', root(grocery, `udhaar/${sunita.id}/reminders`), { channel: 'call' }, 403);
    await as(staff.stock_keeper.token)('GET', root(grocery, 'udhaar'), undefined, 403);

    await request('POST', root(grocery, `udhaar/${sunita.id}/reminders`), { channel: 'whatsapp', promisedOn: '2020-01-01' }, 400);
    const settled = await request('POST', root(grocery, 'contacts'), { kind: 'customer', name: 'Owes nothing' }, 201);
    await request('POST', root(grocery, `udhaar/${settled.id}/reminders`), { channel: 'call' }, 409);
    const reminder = await as(staff.cashier.token)('POST', root(grocery, `udhaar/${sunita.id}/reminders`), { channel: 'whatsapp', promisedOn: today, note: 'After salary' }, 201);
    assert.equal(Number(reminder.balance), Number(row.balance));
    let remind = await request('GET', root(grocery, 'udhaar/reminders'));
    assert.equal(remind.items.find((r) => r.contact_id === sunita.id).promise_pending, true);
    await pool.query("UPDATE retail_credit_reminders SET promised_on=(now() AT TIME ZONE 'Asia/Kolkata')::date-3 WHERE id=$1", [reminder.id]);
    remind = await request('GET', root(grocery, 'udhaar/reminders'));
    assert.equal(remind.items.find((r) => r.contact_id === sunita.id).promise_broken, true);
    const log = await request('GET', root(grocery, `udhaar/reminder-log?from=${today}&to=${today}`));
    assert.equal(log.items[0].contact_name, 'Sunita');

    const collection = await as(staff.cashier.token)('POST', root(grocery, `udhaar/${sunita.id}/collections`),
      { locationId: location.id, amount: older.total, method: 'cash', requestKey: key() }, 201);
    assert.equal(Number(collection.allocated), Number(older.total));
    const account = await request('GET', root(grocery, `udhaar/${sunita.id}`));
    assert.deepEqual(account.items.map((i) => i.document_id), [newer.id], 'the oldest bill was settled first');
    assert.equal(account.reminders.length, 1);
    const statement = await request('GET', root(grocery, `udhaar/${sunita.id}/statement?from=2020-01-01&to=${today}`));
    assert.equal(Number(statement.closing), Number(newer.total));
  });

  await t.test('scanning finds items by barcode, code, ISBN and weighing-scale label', async () => {
    const assigned = await request('POST', root(grocery, 'retail/barcodes'), { skuIds: [rice.id, ghee.id] });
    assert.equal(assigned.assigned.length, 2);
    for (const a of assigned.assigned) assert.match(a.barcode, /^200\d{10}$/);
    assert.equal(ean(assigned.assigned[0].barcode.slice(0, 12)), assigned.assigned[0].barcode, 'a valid EAN-13');
    assert.equal((await request('POST', root(grocery, 'retail/barcodes'), { skuIds: [rice.id] })).alreadyHad, 1);
    await as(staff.cashier.token)('POST', root(grocery, 'retail/barcodes'), { skuIds: [salt.id] }, 403);
    const gheeCode = assigned.assigned.find((a) => a.id === ghee.id).barcode;
    assert.equal((await request('GET', root(grocery, `retail/scan?code=${gheeCode}`))).sku.id, ghee.id);
    assert.equal((await request('GET', root(grocery, 'retail/scan?code=salt'))).sku.id, salt.id);
    await request('GET', root(grocery, 'retail/scan?code=NOTHING-HERE'), undefined, 404);

    await request('PUT', root(grocery, `retail/scale-items/${rice.id}`), { pluCode: '7' });
    await request('PUT', root(grocery, `retail/scale-items/${ghee.id}`), { pluCode: '8' }, 409);
    await as(staff.cashier.token)('PUT', root(grocery, `retail/scale-items/${salt.id}`), { pluCode: '9' }, 403);
    const label = ean('210000702500');
    const scanned = await as(staff.cashier.token)('GET', root(grocery, `retail/scan?code=${label}`));
    assert.equal(scanned.sku.id, rice.id);
    assert.equal(scanned.quantity, 2.5, '02500 grams is 2.5 kg');
    assert.equal(scanned.source, 'scale');
    const badCheck = `${label.slice(0, 12)}${(Number(label[12]) + 1) % 10}`;
    await request('GET', root(grocery, `retail/scan?code=${badCheck}`), undefined, 400);
    await request('GET', root(grocery, `retail/scan?code=${ean('210009902500')}`), undefined, 404);
    await other('GET', root(grocery, `retail/scan?code=${label}`), undefined, 404);
    await request('DELETE', root(grocery, `retail/scale-items/${rice.id}`));
    await request('GET', root(grocery, `retail/scan?code=${label}`), undefined, 404);
  });

  await t.test('book details: ISBN checked and stored as ISBN-13, unique, searchable, scannable', async () => {
    await request('GET', root(grocery, 'books'), undefined, 403);
    const nil = (await request('GET', root(books, 'tax-rates'))).items.find((r) => Number(r.rate) === 0);
    const add = (body, expected = 201) => request('POST', root(books, 'books'), { price: '250', taxRateId: nil.id, ...body }, expected);
    await add({ name: 'Bad ISBN', code: 'BK-BAD', isbn: '978-0-306-40615-8' }, 400);
    const book = await add({ name: 'Kitchen science', code: 'BK-KS', isbn: '0-306-40615-2', author: 'Lakshmi Narayan', publisher: 'Demo Press', edition: '2nd', publishedYear: 2019 });
    assert.equal(book.barcode, '9780306406157', 'the ISBN-13 becomes the barcode');
    await add({ name: 'Copy', code: 'BK-KS2', isbn: '9780306406157' }, 409);
    const found = await request('GET', root(books, 'books?q=narayan'));
    assert.equal(found.items[0].isbn, '9780306406157');
    assert.equal((await request('GET', root(books, 'retail/scan?code=978-0-306-40615-7'))).sku.id, book.id);
    await request('PUT', root(books, `books/${book.id}`), { isbn: '', author: 'L. Narayan', edition: '3rd' });
    assert.equal((await request('GET', root(books, 'books?q=3rd'))).total, 0, 'edition is shown, not searched');
    assert.equal((await request('GET', root(books, 'books?q=L.%20Narayan'))).items[0].isbn, null);
    await other('PUT', root(books, `books/${book.id}`), { author: 'Hijack' }, 404);
    // A book added from the general Products screen gets the same typed details.
    const atlasIsbn = ean('978935000007');
    await request('POST', root(books, 'catalog'), { name: 'School atlas', code: 'BK-ATL', kind: 'goods', unit: 'each', tracking: 'quantity', price: '300', taxRate: '0',
      attributes: { isbn: atlasIsbn, author: 'Survey Office', publisher: 'Demo Maps' } }, 201);
    assert.equal((await request('GET', root(books, 'books?q=survey%20office'))).items[0].isbn, atlasIsbn);
  });

  await t.test('retail reports reconcile with the posted lines, net of returns', async () => {
    const top = await request('GET', root(grocery, `retail/reports/top-sellers?from=${today}&to=${today}`));
    // Today's sales lines (one udhaar bill above was moved 20 days back), less what came back from them.
    const ledger = await one(`SELECT sum(l.net-COALESCE((SELECT sum(rl.net) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0)) AS net
      FROM business_document_lines l JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id
      WHERE l.business_id=$1 AND d.kind='sale' AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date`, [grocery.id, today]);
    assert.equal(Math.round(top.rows.reduce((s, r) => s + Number(r.net), 0) * 100), Math.round(Number(ledger.net) * 100));
    assert.ok(top.rows.every((r) => Math.round((Number(r.net) - Number(r.cost)) * 100) === Math.round(Number(r.margin) * 100)));
    const margin = await request('GET', root(grocery, `retail/reports/category-margin?from=${today}&to=${today}`));
    assert.equal(Math.round(margin.rows.reduce((s, r) => s + Number(r.net), 0) * 100), Math.round(Number(ledger.net) * 100));
    assert.ok(margin.rows.find((r) => r.category === 'Staples › Rice'), 'categories are shown with their path');
    const slow = await request('GET', root(grocery, 'retail/reports/slow-movers?days=30'));
    const camphor = slow.rows.find((r) => r.sku_id === unsold.id);
    assert.equal(Number(camphor.sold), 0);
    assert.equal(camphor.days_since_sale, null);
    assert.equal(Number(slow.rows[0].sold), 0, 'unsold stock comes first');
    const value = await request('GET', root(grocery, 'retail/reports/stock-value'));
    const stock = await one('SELECT round(sum(quantity*unit_cost),2) AS v FROM business_stock_lots WHERE business_id=$1', [grocery.id]);
    assert.equal(Math.round(value.rows.reduce((s, r) => s + Number(r.cost_value), 0) * 100), Math.round(Number(stock.v) * 100));
    await request('GET', root(grocery, 'retail/reports/slow-movers?days=3'), undefined, 400);
    await as(staff.viewer.token)('GET', root(grocery, `retail/reports/top-sellers?from=${today}&to=${today}`));
    await as(staff.stock_keeper.token)('GET', root(grocery, `retail/reports/top-sellers?from=${today}&to=${today}`), undefined, 403);
  });

  await t.test('nothing crosses businesses', async () => {
    await other('GET', root(grocery, 'offers'), undefined, 404);
    await other('GET', root(grocery, 'udhaar'), undefined, 404);
    await other('POST', root(grocery, 'retail/quote'), { locationId: location.id, lines: [{ skuId: rice.id, quantity: '1' }] }, 404);
    // The other owner's own grocery cannot price, remind or collect for this one's records.
    await other('PUT', root(otherGrocery, 'modules/offers'), { enabled: true });
    await other('PUT', root(otherGrocery, 'modules/loyalty'), { enabled: true });
    const theirLocation = (await other('GET', root(otherGrocery, 'locations'))).items[0];
    await other('POST', root(otherGrocery, 'retail/quote'), { locationId: theirLocation.id, lines: [{ skuId: rice.id, quantity: '1' }] }, 404);
    await other('POST', root(otherGrocery, 'offers'), { name: 'Steal', kind: 'item_percent', skuId: rice.id, value: '10', startsOn: today }, 404);
    await other('POST', root(otherGrocery, `udhaar/${sunita.id}/reminders`), { channel: 'call' }, 404);
    await other('GET', root(otherGrocery, `udhaar/${sunita.id}`), undefined, 404);
    await other('POST', root(otherGrocery, `udhaar/${sunita.id}/collections`), { locationId: theirLocation.id, amount: '10', method: 'cash', requestKey: key() }, 404);
    await other('POST', root(otherGrocery, `loyalty/${ramesh.id}/adjustments`), { points: '5', reason: 'x', requestKey: key() }, 404);
    await other('PUT', root(otherGrocery, `retail/scale-items/${rice.id}`), { pluCode: '11' }, 404);
    // The database refuses a cross-business link even when written directly.
    const theirOffer = await other('POST', root(otherGrocery, 'offers'), { name: 'Theirs', kind: 'bill_percent', value: '5', startsOn: today }, 201);
    const line = await one('SELECT id,document_id FROM business_document_lines WHERE business_id=$1 LIMIT 1', [grocery.id]);
    await assert.rejects(pool.query(`INSERT INTO retail_sale_discounts(business_id,document_id,line_id,source,offer_id,label,amount)
      VALUES($1,$2,$3,'offer',$4,'x',1)`, [grocery.id, line.document_id, line.id, theirOffer.id]), { code: '23503' });
    await assert.rejects(pool.query('INSERT INTO retail_scale_items(business_id,sku_id,plu_code) VALUES($1,$2,$3)', [otherGrocery.id, rice.id, '00012']), { code: '23503' });
  });
});
