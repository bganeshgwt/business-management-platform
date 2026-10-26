const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { pathToFileURL } = require('node:url');
const { createBusinesses } = require('./helpers/businesses');
const { GOODS_TYPES } = require('../../src/modules/business/core/services/businessTypes');
const { signIn } = require('./helpers/signIn');

// Business shared commerce: GST-inclusive shelf prices
// by default, MRP and HSN, the tax invoice's buyer and place of supply, a
// walk-in pays in full, a small counter discount within permission and limit,
// receiving with the supplier's bill and new shelf prices, paying suppliers
// oldest first, day close, the IMEI scan with the warranty registered at the
// sale, searches, and today's overview figures. Runs on its own throwaway
// database with every migration applied.
test('business core: prices, invoice, counter, suppliers, day close', { timeout: 300000 }, async (t) => {
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
  const password = `Core-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('core-owner');
  await owner('core-other');
  const token = await login('core-owner@test.invalid');
  const otherToken = await login('core-other@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);

  // Every goods shop type, and a salon, a wholesaler and a gym that price before GST.
  const businesses = await createBusinesses(request, 'OWNER', [...GOODS_TYPES, 'salon', 'wholesale', 'memberships']);
  const byType = (type) => businesses.find((b) => b.business_type === type);
  const grocery = byType('grocery'), electronics = byType('electronics'), salon = byType('salon'), wholesale = byType('wholesale');
  const [otherGrocery] = await createBusinesses(other, 'OTHER', ['grocery']);
  const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
  const E = (suffix) => `/businesses/${electronics.id}/${suffix}`;

  // Staff of the owner's restaurant with template roles in the grocery.
  const staff = {};
  for (const template of ['manager', 'cashier', 'stock_keeper', 'accountant']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      [ownerUser.restaurant_id, `Core ${template}`, `core-${template}@test.invalid`, hash]);
    staff[template] = { id: person.id, call: as(await login(`core-${template}@test.invalid`)) };
  }
  const roles = (await request('GET', G('roles'))).items;
  for (const [template, person] of Object.entries(staff)) {
    await request('POST', G('members'), { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
  }
  const settingsBody = async (business, changes) => {
    const s = await request('GET', `/businesses/${business.id}/settings`);
    return { displayName: s.display_name, legalName: s.legal_name, gstin: s.gstin, stateCode: s.state_code, addressLine1: s.address_line1, city: s.city,
      postalCode: s.postal_code, taxMode: s.tax_mode, rounding: s.rounding, fiscalYearStartMonth: s.fiscal_year_start_month, dateFormat: s.date_format, ...changes };
  };

  await t.test('goods shops start with prices including GST, rounded to the rupee; others before GST', async () => {
    // The staff app's goods shops (Quick bill, udhaar) are the server's.
    const types = await import(pathToFileURL(path.resolve(__dirname, '../../../apps/business-web/src/services/businessTypes.js')).href);
    assert.deepEqual([...types.GOODS].sort(), [...GOODS_TYPES].sort());
    for (const type of GOODS_TYPES) {
      const s = await request('GET', `/businesses/${byType(type).id}/settings`);
      // A jeweller prices before GST (metal, making and stones, then 3%), still rounded to the rupee.
      assert.equal(s.tax_mode, type === 'jewellery' ? 'exclusive' : 'inclusive', type);
      assert.equal(s.rounding, 'nearest_rupee', type);
      assert.equal(s.walk_in_credit, false, type);
      assert.equal(Number(s.max_bill_discount_percent), 10, type);
    }
    for (const business of [salon, wholesale, byType('memberships')]) {
      const s = await request('GET', `/businesses/${business.id}/settings`);
      assert.equal(s.tax_mode, 'exclusive', business.business_type);
      assert.equal(s.rounding, 'none', business.business_type);
    }
    // Every goods counter can collect what it gives on credit.
    for (const type of ['meat', 'fashion', 'electronics']) assert.ok(byType(type).capabilities.includes('receivables'), type);
    const permissions = await request('GET', G('permissions'));
    assert.ok(permissions.permissions.find((p) => p.code === 'sales.discount'));
    const manager = roles.find((r) => r.template_code === 'manager');
    assert.ok(manager.permissions.includes('sales.discount'));
    assert.ok(!roles.find((r) => r.template_code === 'cashier').permissions.includes('sales.discount'));
  });

  let location, supplier, ramesh, gstBuyer, ghee, rice, salt;
  await t.test('MRP and HSN on items: never priced or billed above the MRP', async () => {
    location = (await request('GET', G('locations'))).items[0];
    await request('PUT', G('settings'), await settingsBody(grocery, { stateCode: '29', legalName: 'Sharma Kirana Stores' }));
    supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Agarwal Traders', creditDays: 15 }, 201);
    ramesh = await request('POST', G('contacts'), { kind: 'customer', name: 'Ramesh', phone: '9820011111', address: '12 MG Road, Bengaluru' }, 201);
    gstBuyer = await request('POST', G('contacts'), { kind: 'customer', name: 'Hotel Pune', gstin: '27AAPFU0939F1ZV', address: 'FC Road, Pune' }, 201);
    const item = (body, expected = 201) => request('POST', G('catalog'), { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '5', ...body }, expected);
    // Above the MRP, and badly formed codes, are refused.
    await item({ name: 'Cow ghee 1 L', code: 'GHEE-X', price: '340', mrp: '330' }, 409);
    await item({ name: 'Cow ghee 1 L', code: 'GHEE-X', price: '330', mrp: '330', hsnCode: '04O5' }, 400);
    ghee = await item({ name: 'Cow ghee 1 L', code: 'GHEE', price: '330', mrp: '330', hsnCode: '0405' });
    assert.equal(ghee.hsn_code, '0405');
    assert.equal(ghee.mrp, '330.00');
    rice = await item({ name: 'Sona Masoori rice 5 kg', code: 'RICE5', price: '350', mrp: '375', hsnCode: '100630' });
    salt = await item({ name: 'Iodised salt 1 kg', code: 'SALT', price: '20', taxRate: '0' });
    // Changing the price checks it again; an older client sending no MRP keeps it.
    await request('PATCH', G(`catalog/${ghee.id}`), { label: ghee.label, price: '335', active: true }, 409);
    const kept = await request('PATCH', G(`catalog/${rice.id}`), { label: rice.label, price: '360', active: true });
    assert.equal(kept.mrp, '375.00');
    assert.equal(kept.hsn_code, '100630');
    // With prices before GST the MRP is compared with GST added: 330 + 5% is above 330.
    await pool.query("UPDATE business_settings SET tax_mode='exclusive' WHERE business_id=$1", [grocery.id]);
    const refused = await call('POST', G('retail/quote'), { locationId: location.id, lines: [{ skuId: ghee.id, quantity: '1' }] }, token);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /above its MRP of 330\.00/);
    await pool.query("UPDATE business_settings SET tax_mode='inclusive' WHERE business_id=$1", [grocery.id]);
    // Isolation: another business cannot see or touch the item.
    await other('PATCH', `/businesses/${grocery.id}/catalog/${ghee.id}`, { label: 'x', price: '1', active: true }, 404);
    await other('GET', `/businesses/${otherGrocery.id}/catalog?q=GHEE`).then((page) => assert.equal(page.total, 0));
  });

  let purchase;
  await t.test('receiving: supplier bill number and date, refused twice, new shelf price and MRP from the receipt', async () => {
    const body = (no, lines) => ({ kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), supplierBillNo: no, supplierBillDate: '2026-10-01', lines });
    purchase = await request('POST', G('documents'), body('AT/553', [
      { skuId: ghee.id, quantity: '40', unitPrice: '280' }, { skuId: rice.id, quantity: '30', unitPrice: '300' }, { skuId: salt.id, quantity: '100', unitPrice: '15' }]), 201);
    assert.equal(purchase.supplier_bill_no, 'AT/553');
    assert.equal(purchase.supplier_bill_date.slice(0, 10), '2026-10-01');
    const again = await call('POST', G('documents'), body('at/553', [{ skuId: salt.id, quantity: '1', unitPrice: '15' }]), token);
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already received as PR\//);
    await request('POST', G('documents'), { ...body('AT/554', [{ skuId: salt.id, quantity: '1', unitPrice: '15' }]), supplierBillDate: '2099-01-01' }, 400);
    await request('POST', G('documents'), { kind: 'sale', locationId: location.id, contactId: ramesh.id, requestKey: key(), supplierBillNo: 'X', lines: [{ skuId: salt.id, quantity: '1' }] }, 400);
    // Searchable by the supplier's bill number.
    assert.equal((await request('GET', G('documents?kind=purchase&q=AT/553'))).total, 1);
    // A new shelf price and MRP from the receipt: needs catalogue rights, keeps within the MRP.
    await staff.accountant.call('POST', G('documents'), body('AT/555', [{ skuId: salt.id, quantity: '10', unitPrice: '16', sellingPrice: '22' }]), 403);
    await request('POST', G('documents'), body('AT/556', [{ skuId: salt.id, quantity: '10', unitPrice: '16', sellingPrice: '25', mrp: '24' }]), 409);
    const priced = await staff.stock_keeper.call('POST', G('documents'), body('AT/557', [{ skuId: salt.id, quantity: '10', unitPrice: '16', sellingPrice: '22', mrp: '24' }]), 201);
    const now = (await request('GET', G('catalog?q=SALT'))).items[0];
    assert.equal(Number(now.price), 22);
    assert.equal(Number(now.mrp), 24);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='catalog.price_changed' AND entity_id=$2", [grocery.id, salt.id]);
    assert.equal(audit.details.documentNo, priced.document_no);
    assert.equal(audit.details.from, '20.00');
  });

  let gstSale;
  await t.test('the tax invoice keeps the buyer, the place of supply, HSN and MRP as billed', async () => {
    gstSale = await request('POST', G('documents'), { kind: 'sale', locationId: location.id, contactId: gstBuyer.id, requestKey: key(),
      lines: [{ skuId: ghee.id, quantity: '2' }, { skuId: rice.id, quantity: '1' }] }, 201);
    assert.equal(gstSale.place_of_supply, '27');
    assert.equal(gstSale.buyer_gstin, '27AAPFU0939F1ZV');
    // Prices include GST: 2 × 330 + 360 = 1,020 exactly, GST worked out of it.
    assert.equal(gstSale.total, '1020.00');
    assert.equal(paise(gstSale.subtotal) + paise(gstSale.tax), 102000);
    const detail = await request('GET', G(`documents/${gstSale.id}`));
    assert.equal(detail.lines[0].hsn_code, '0405');
    assert.equal(detail.lines[0].mrp, '330.00');
    assert.equal(detail.contact_gstin, '27AAPFU0939F1ZV');
    assert.equal(detail.contact_address, 'FC Road, Pune');
    assert.equal(detail.seller.state_code, '29');
    // The buyer's details changing later do not rewrite the invoice.
    await request('PATCH', G(`contacts/${gstBuyer.id}`), { name: 'Hotel Pune', address: 'New address', gstin: null, active: true });
    const after = await request('GET', G(`documents/${gstSale.id}`));
    assert.equal(after.contact_gstin, '27AAPFU0939F1ZV');
    assert.equal(after.contact_address, 'FC Road, Pune');
    // A walk-in buys in the shop: the place of supply is the shop's state.
    const walkIn = await request('POST', G('documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines: [{ skuId: salt.id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 201);
    assert.equal(walkIn.place_of_supply, '29');
  });

  await t.test('a walk-in pays the whole bill; udhaar needs a customer unless the owner allows it', async () => {
    const lines = [{ skuId: ghee.id, quantity: '1' }];
    const refused = await call('POST', G('documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines }, token);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /walk-in customer pays the whole bill/);
    await request('POST', G('documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines, payment: { amount: '100', method: 'cash' } }, 409);
    const full = await staff.cashier.call('POST', G('documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines, payment: { amount: 'full', method: 'upi' } }, 201);
    const paid = await request('GET', G(`documents/${full.id}`));
    assert.equal(paid.payments[0].amount, '330.00');
    assert.equal(paid.payments[0].method, 'upi');
    // A named customer may take it on udhaar.
    await staff.cashier.call('POST', G('documents'), { kind: 'sale', locationId: location.id, contactId: ramesh.id, requestKey: key(), lines }, 201);
    // The owner can allow unpaid walk-in bills; a cashier cannot change that.
    await staff.cashier.call('PUT', G('settings'), await settingsBody(grocery, { walkInCredit: true }), 403);
    await request('PUT', G('settings'), await settingsBody(grocery, { walkInCredit: true, maxBillDiscountPercent: '12' }));
    const unpaid = await request('POST', G('documents'), { kind: 'sale', locationId: location.id, requestKey: key(), lines }, 201);
    assert.equal((await request('GET', G('documents?kind=sale&walk_in_due=true'))).items.map((d) => d.id).includes(unpaid.id), true);
    await request('PUT', G('settings'), await settingsBody(grocery, { walkInCredit: false, maxBillDiscountPercent: '10' }));
    // Other types keep their own ways: a salon bill may wait for payment.
    const salonLocation = (await request('GET', `/businesses/${salon.id}/locations`)).items[0];
    const cut = await request('POST', `/businesses/${salon.id}/catalog`, { kind: 'service', name: 'Haircut', code: 'CUT', unit: 'service', price: '300', taxRate: '18' }, 201);
    await request('POST', `/businesses/${salon.id}/documents`, { kind: 'sale', locationId: salonLocation.id, requestKey: key(), lines: [{ skuId: cut.id, quantity: '1' }] }, 201);
  });

  await t.test('a small discount at the counter: permission, reason, the owner\'s limit, recorded on the bill', async () => {
    const lines = [{ skuId: ghee.id, quantity: '1' }];
    const quote = (who, discount, expected = 200) => who('POST', G('retail/quote'), { locationId: location.id, contactId: ramesh.id, lines, discount }, expected);
    await quote(staff.cashier.call, { amount: '10', reason: 'Regular' }, 403);
    await quote(staff.manager.call, { amount: '10' }, 400);
    await quote(staff.manager.call, { amount: '10', percent: '2', reason: 'x' }, 400);
    const over = await call('POST', G('retail/quote'), { locationId: location.id, lines, discount: { amount: '40', reason: 'Regular' } }, (await login('core-manager@test.invalid')));
    assert.equal(over.status, 409);
    assert.match(over.body.message, /At most 10% .*33\.00/);
    const five = await quote(staff.manager.call, { percent: '5', reason: 'Regular customer' });
    assert.equal(five.savings, '16.50');
    assert.equal(five.total, '314.00');
    assert.equal(five.lines[0].offers[0].source, 'manual');
    // The owner (full access) is not held to the limit.
    assert.equal((await quote(request, { amount: '100', reason: 'Damaged box' })).total, '230.00');
    const sale = await staff.manager.call('POST', G('documents'), { kind: 'sale', locationId: location.id, contactId: ramesh.id, requestKey: key(), lines,
      discount: { amount: '30', reason: 'Regular customer' }, payment: { amount: 'full', method: 'cash' } }, 201);
    assert.equal(sale.total, '300.00');
    const detail = await request('GET', G(`documents/${sale.id}`));
    assert.equal(detail.retail.discounts[0].source, 'manual');
    assert.equal(detail.retail.discounts[0].label, 'Discount: Regular customer');
    assert.equal(detail.retail.savings, '30.00');
  });

  await t.test('paying a supplier: oldest receipts first, the rest an advance, once per request, statement and list', async () => {
    const before = await request('GET', G(`suppliers/${supplier.id}/account`));
    const owed = paise(before.summary.balance);
    assert.ok(owed > 0);
    assert.equal(before.items[0].document_id, purchase.id, 'the oldest receipt first');
    await staff.cashier.call('POST', G(`suppliers/${supplier.id}/payments`), { locationId: location.id, amount: '100', method: 'cash', requestKey: key() }, 403);
    await request('POST', G(`suppliers/${supplier.id}/payments`), { locationId: location.id, amount: '100', method: 'cheque', requestKey: key() }, 400);
    await request('POST', G(`suppliers/${ramesh.id}/payments`), { locationId: location.id, amount: '100', method: 'cash', requestKey: key() }, 404);
    const requestKey = key();
    const body = { locationId: location.id, amount: '30000', method: 'bank', reference: 'UTR 778899', requestKey };
    const paid = await staff.accountant.call('POST', G(`suppliers/${supplier.id}/payments`), body, 201);
    assert.match(paid.payment_no, /^SP\//);
    assert.equal(paid.settled[0].documentId, purchase.id);
    assert.equal(paise(paid.allocated), owed);
    // The same request again changes nothing; different content with its key is refused.
    const repeat = await request('POST', G(`suppliers/${supplier.id}/payments`), body, 201);
    assert.equal(repeat.id, paid.id);
    await request('POST', G(`suppliers/${supplier.id}/payments`), { ...body, amount: '1' }, 409);
    const account = await request('GET', G(`suppliers/${supplier.id}/account`));
    assert.equal(paise(account.summary.balance), owed - 3000000);
    assert.equal(account.items.length, 0, 'everything owed is settled');
    assert.equal(paise(account.advances[0].unallocated), 3000000 - owed);
    // A receipt of another supplier cannot be settled from this payment.
    const second = await request('POST', G('contacts'), { kind: 'supplier', name: 'Gupta Oils' }, 201);
    const theirs = await request('POST', G('documents'), { kind: 'purchase', locationId: location.id, contactId: second.id, requestKey: key(), lines: [{ skuId: ghee.id, quantity: '1', unitPrice: '280' }] }, 201);
    await request('POST', G(`suppliers/${supplier.id}/payments`), { locationId: location.id, amount: '50', method: 'cash', requestKey: key(), allocations: [{ documentId: theirs.id, amount: '50' }] }, 404);
    await assert.rejects(pool.query('UPDATE business_supplier_payments SET amount=1 WHERE id=$1', [paid.id]), /cannot be changed/);
    // Chosen receipts.
    const chosen = await request('POST', G(`suppliers/${second.id}/payments`), { locationId: location.id, amount: '100', method: 'upi', requestKey: key(), allocations: [{ documentId: theirs.id, amount: '100' }] }, 201);
    assert.equal(chosen.unallocated, '0.00');
    const list = await request('GET', G('payables?show=all'));
    const row = list.items.find((r) => r.contact_id === second.id);
    assert.equal(Number(row.outstanding), 194);
    const statement = await request('GET', G(`suppliers/${supplier.id}/statement?from=2026-01-01&to=2099-12-31`));
    assert.equal(statement.closing, account.summary.balance);
    assert.ok(statement.entries.some((e) => e.kind === 'voucher' && e.reference.includes('UTR 778899')));
    const voucher = await request('GET', G(`supplier-payments/${paid.id}`));
    assert.equal(voucher.allocations.length, 2);
    assert.equal((await request('GET', G('supplier-payments?q=UTR'))).total, 1);
    await other('GET', G(`suppliers/${supplier.id}/account`), undefined, 404);
  });

  await t.test('day close: takings by method, person and counter, with the cash that should be in the drawer', async () => {
    const day = await request('GET', G('reports/takings'));
    const sales = await one(`SELECT count(*)::int AS bills, sum(total) AS total FROM business_documents WHERE business_id=$1 AND kind='sale'`, [grocery.id]);
    assert.equal(day.sales.bills, sales.bills);
    assert.equal(paise(day.sales.total), paise(sales.total));
    const payments = await one(`SELECT COALESCE(sum(p.amount) FILTER (WHERE p.method='cash'),0) AS cash, COALESCE(sum(p.amount),0) AS total FROM business_payments p
      JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id WHERE p.business_id=$1 AND d.kind='sale'`, [grocery.id]);
    assert.equal(paise(day.received.total), paise(payments.total));
    assert.equal(paise(day.received.cash), paise(payments.cash));
    // Paid to suppliers: the bank transfer and the UPI payment above.
    assert.equal(day.suppliers.bank, '30000.00');
    assert.equal(day.suppliers.upi, '100.00');
    assert.equal(paise(day.cashInHand), paise(payments.cash));
    assert.equal(day.sales.counterDiscounts, '30.00');
    assert.ok(paise(day.sales.onCredit) >= 33000, 'udhaar given today');
    const cashier = day.byPerson.find((p) => p.name === 'Core cashier');
    assert.equal(cashier.bills, 2);
    assert.equal(cashier.in.upi, '330.00');
    assert.equal(day.byLocation[0].name, location.name);
    // A cashier may see it; another business may not; a long range is refused.
    await staff.cashier.call('GET', G('reports/takings'));
    await other('GET', G('reports/takings'), undefined, 404);
    await request('GET', G('reports/takings?from=2026-01-01&to=2026-03-01'), undefined, 400);
  });

  await t.test('electronics: the IMEI scan finds the unit; the warranty is registered with the sale', async () => {
    const centre = (await request('GET', E('locations'))).items[0];
    const phone = await request('POST', E('catalog'), { kind: 'goods', name: 'Dhruv 5G', code: 'DH5G', unit: 'each', tracking: 'serial', price: '18999', mrp: '19999', taxRate: '18', hsnCode: '8517' }, 201);
    await request('PUT', E(`electronics/models/${phone.id}`), { serialKind: 'serial', warrantyMonths: 12, warrantyTerms: 'Manufacturing defects only.' });
    const shop = await request('POST', E('contacts'), { kind: 'supplier', name: 'Phone Distributor' }, 201);
    await request('POST', E('documents'), { kind: 'purchase', locationId: centre.id, contactId: shop.id, requestKey: key(),
      lines: ['SN-1001', 'SN-1002'].map((lotCode) => ({ skuId: phone.id, quantity: '1', unitPrice: '15000', lotCode })) }, 201);
    const scanned = await request('GET', E(`retail/scan?code=SN-1002&locationId=${centre.id}`));
    assert.equal(scanned.source, 'serial');
    assert.equal(scanned.serial, 'SN-1002');
    assert.deepEqual(scanned.lots.map((l) => l.lot_code), ['SN-1002']);
    // A walk-in's name and phone carry the warranty.
    const sale = await request('POST', E('documents'), { kind: 'sale', locationId: centre.id, requestKey: key(), buyer: { name: 'Arvind Menon', phone: '99001 23456' },
      lines: [{ skuId: phone.id, quantity: '1', lotCode: 'SN-1002' }], payment: { amount: 'full', method: 'card' } }, 201);
    assert.equal(sale.total, '18999.00');
    assert.equal(sale.warranties.length, 1);
    const warranty = await request('GET', E(`warranties/${sale.warranties[0].id}`));
    assert.equal(warranty.customer_name, 'Arvind Menon');
    assert.equal(warranty.months, 12);
    assert.equal(warranty.terms, 'Manufacturing defects only.');
    // Scanning it again says where it went; the bill is found by the serial.
    const sold = await call('GET', E(`retail/scan?code=SN-1002&locationId=${centre.id}`), undefined, token);
    assert.equal(sold.status, 409);
    assert.match(sold.body.message, new RegExp(`already sold on ${sale.document_no.replace(/\//g, '\\/')}`));
    assert.equal((await request('GET', E('documents?kind=sale&q=SN-1002'))).items[0].id, sale.id);
    // Without a name and phone the unit waits on the warranties screen.
    const plain = await request('POST', E('documents'), { kind: 'sale', locationId: centre.id, requestKey: key(),
      lines: [{ skuId: phone.id, quantity: '1', lotCode: 'SN-1001' }], payment: { amount: 'full', method: 'cash' } }, 201);
    assert.equal(plain.warranties.length, 0);
    const today = await request('GET', E('summary'));
    assert.equal(today.warranties_missing, 1);
    assert.equal(today.bills_today, 2);
  });

  await t.test('the overview sends today\'s counter figures, only to those who may see them', async () => {
    const summary = await request('GET', G('summary'));
    assert.ok(summary.bills_today >= 5);
    assert.ok(Number(summary.taken_today.cash) > 0);
    assert.ok(Number(summary.credit_given_today) > 0);
    assert.equal(summary.promises_due_today, 0);
    assert.ok(Number(summary.payables_overdue) >= 0);
    const stock = await staff.stock_keeper.call('GET', G('summary'));
    assert.equal(stock.taken_today, undefined, 'a stock keeper does not see the takings');
    assert.equal(stock.bills_today, undefined);
  });
});
