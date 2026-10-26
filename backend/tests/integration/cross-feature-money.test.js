const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const dates = require('./helpers/dates');
const { withTools } = require('./helpers/tools');
const { signIn } = require('./helpers/signIn');

// Money and permissions across features: the combinations no single
// feature's test covers, end to end on a throwaway database with every
// migration applied.
//   1. Electronics: split payment + EMI + a kit on one bill, then a part
//      return and the rest: stock, GST per part, the customer's refund cap,
//      what the financier owes, loyalty points, day close.
//   2. Grocery: split payment with udhaar, then an advance refunded to the
//      same customer: balance, udhaar book, statement, day close.
//   3. Pharmacy: an H1 medicine on a split-payment prescription bill, its
//      return, the H1 register, day close.
//   4. Pharmacy: the till switched to another person by PIN, billing a
//      Schedule X medicine (the pharmacist's PIN is still needed).
//   5. Wholesale: a scheme's free line invoiced at ₹0, the cheque that paid
//      it bounced (the invoice reopens, the bank charge, a credit hold).
//   6. Restaurant: an advance on a pickup order counted once in the day.
// All money compared in integer paise.
test('cross-feature money and permissions', { timeout: 300000 }, async (t) => {
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
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Cross-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const pinHash = await bcrypt.hash('2468', 4);
  const restaurantService = require('../../src/modules/restaurant/setup/services/restaurant.service');
  const made = await restaurantService.createRestaurant({ name: 'Cross check cafe', code: 'CROSSR2', invoicePrefix: 'CX',
    admin: { name: 'Cross owner', email: 'cross-owner@test.invalid', password } });
  const restaurantId = made.id;
  const ownerUser = await one("SELECT id FROM users WHERE email='cross-owner@test.invalid'");
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, pinHash]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => {
    const session = await signIn(base, email, password);
    assert.ok(session?.token, `login ${email} was refused`);
    return session.token;
  };
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const token = await login('cross-owner@test.invalid');
  const request = as(token);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value || 0) * 100);
  const sumP = (list, pick) => list.reduce((s, x) => s + paise(pick(x)), 0);

  const [electronics, grocery, pharmacy, wholesale] = await withTools(request, await createBusinesses(request, 'OWNER', ['electronics', 'grocery', 'pharmacy', 'wholesale']));
  const at = (biz) => (suffix) => `/businesses/${biz.id}/${suffix}`;
  const E = at(electronics), G = at(grocery), P = at(pharmacy), W = at(wholesale);
  const firstLocation = async (biz) => (await request('GET', `/businesses/${biz.id}/locations`)).items[0];

  // A member of a business with one role template (and the PIN 2468).
  async function member(biz, email, template) {
    let user = await one('SELECT id FROM users WHERE email=$1', [email]);
    if (!user) {
      user = await one('INSERT INTO users(restaurant_id,name,email,password_hash,pin_hash,pin_set_at) VALUES($1,$2,$3,$4,$5,now()) RETURNING id',
        [restaurantId, email.split('@')[0], email, hash, pinHash]);
    }
    const roles = (await request('GET', `/businesses/${biz.id}/roles?limit=100`)).items;
    const role = roles.find((r) => r.template_code === template);
    assert.ok(role, `${template} role in ${biz.business_type}`);
    await request('POST', `/businesses/${biz.id}/members`, { userId: user.id, roleId: role.id }, 201);
    const auth = await login(email);
    return { id: Number(user.id), token: auth, call: as(auth) };
  }

  // Every sale's lines add up to its subtotal and tax, and its total is
  // those plus the round-off, to the paisa.
  async function ties(biz, documentId) {
    const doc = await one('SELECT subtotal,tax,round_off,total FROM business_documents WHERE business_id=$1 AND id=$2', [biz.id, documentId]);
    const lines = await all('SELECT net,tax FROM business_document_lines WHERE business_id=$1 AND document_id=$2', [biz.id, documentId]);
    assert.equal(sumP(lines, (l) => l.net), paise(doc.subtotal), 'lines add up to the subtotal');
    assert.equal(sumP(lines, (l) => l.tax), paise(doc.tax), 'lines add up to the tax');
    assert.equal(paise(doc.subtotal) + paise(doc.tax) + paise(doc.round_off), paise(doc.total), 'total = subtotal + tax + round-off');
    return doc;
  }
  const stockOf = async (biz, skuId) => paise((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [biz.id, skuId])).q) / 100;

  // --- 1. Electronics: split + EMI + kit, part return, the rest, loan cancelled ------------
  await t.test('electronics: split payment + EMI + kit on one bill, part return then the rest', async () => {
    const shop = await firstLocation(electronics);
    const supplier = await request('POST', E('contacts'), { kind: 'supplier', name: 'Phone distributor' }, 201);
    const item = (body) => request('POST', E('catalog'), { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '18', ...body }, 201);
    const phone = await item({ name: 'Nova 5G 8/128', code: 'NOVA', tracking: 'serial', price: '15999', hsnCode: '851713' });
    const cover = await item({ name: 'Nova cover', code: 'NCOV', price: '499', hsnCode: '392690' });
    const earbuds = await item({ name: 'Earbuds', code: 'BUDS', price: '1499', taxRate: '18', hsnCode: '851830' });
    const cable = await item({ name: 'USB-C cable', code: 'CABLE', price: '299', taxRate: '28', hsnCode: '854442' });
    await request('POST', E('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines: [
      { skuId: phone.id, quantity: '1', unitPrice: '12000', lotCode: '861234567890011' },
      { skuId: phone.id, quantity: '1', unitPrice: '12000', lotCode: '861234567890012' },
      { skuId: cover.id, quantity: '10', unitPrice: '150' }, { skuId: earbuds.id, quantity: '10', unitPrice: '700' }, { skuId: cable.id, quantity: '10', unitPrice: '80' }] }, 201);
    const kit = await request('POST', E('kits'), { name: 'Nova combo', code: 'NOVAKIT', price: '16999', mrp: '18297',
      components: [{ skuId: phone.id, quantity: 1 }, { skuId: cover.id, quantity: 1 }, { skuId: cable.id, quantity: 1 }] }, 201);
    // Loyalty points do not apply to an electronics shop (checked with kits in the grocery below).
    assert.equal((await call('PUT', E('modules/loyalty'), { enabled: true }, token)).status, 409);
    const customer = await request('POST', E('contacts'), { kind: 'customer', name: 'Anil Kumar', phone: '9811122233' }, 201);
    const bajaj = (await request('GET', E('finance/financiers'))).items.find((f) => f.name === 'Bajaj Finserv');
    const before = { cover: await stockOf(electronics, cover.id), cable: await stockOf(electronics, cable.id), phone: await stockOf(electronics, phone.id), buds: await stockOf(electronics, earbuds.id) };
    const day0 = await request('GET', E('reports/takings'));

    // Kit 16,999 + earbuds 1,499 = 18,498; ₹200 counter discount = 18,298.
    // Down payment: ₹1,000 cash (₹2,000 handed over) + ₹1,298 UPI; the rest (₹16,000) on Bajaj.
    const sale = await request('POST', E('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: customer.id,
      lines: [{ skuId: kit.id, quantity: '1', components: [{ skuId: phone.id, lotCode: '861234567890011' }] }, { skuId: earbuds.id, quantity: '1' }],
      discount: { amount: '200', reason: 'Festival offer' },
      payments: [{ method: 'cash', amount: '1000', tendered: '2000' }, { method: 'upi', amount: '1298', reference: 'UPI 7781' }],
      finance: { financierId: bajaj.id, loanNo: 'BFL-CROSS-1', tenureMonths: 12, amount: 'rest' } }, 201);
    const doc = await ties(electronics, sale.id);
    assert.equal(paise(doc.total), 1829800);
    assert.equal(sale.change, '1000.00');
    assert.equal(paise(sale.financeCase.financed_amount), 1600000);
    assert.equal(paise(sale.financeCase.down_payment), 229800);
    const detail = await request('GET', E(`documents/${sale.id}`));
    const pay = Object.fromEntries(detail.payments.map((p) => [p.method, paise(p.amount)]));
    assert.deepEqual(pay, { cash: 100000, upi: 129800, finance: 1600000 });
    // The kit's parts at their own GST rate and HSN; the kit's share to the paisa.
    const parts = detail.lines.filter((l) => l.kit_sku_id);
    assert.deepEqual(parts.map((l) => l.hsn_code), ['851713', '392690', '854442']);
    const rateOf = (l) => Number(l.tax_rate ?? l.taxRate);
    if (parts[0].tax_rate !== undefined) assert.deepEqual(parts.map(rateOf), [18, 18, 28]);
    // Stock: one of each part and the earbuds.
    assert.equal(await stockOf(electronics, phone.id), before.phone - 1);
    assert.equal(await stockOf(electronics, cover.id), before.cover - 1);
    assert.equal(await stockOf(electronics, cable.id), before.cable - 1);
    assert.equal(await stockOf(electronics, earbuds.id), before.buds - 1);
    // The customer owes nothing; Bajaj owes 16,000.
    const balance = async () => paise((await request('GET', E(`contacts?q=${encodeURIComponent('Anil Kumar')}`))).items[0].balance);
    assert.equal(await balance(), 0);
    const owed = async () => paise((await request('GET', E('finance/outstanding'))).items.find((r) => r.name === 'Bajaj Finserv')?.financed);
    assert.equal(await owed(), 1600000);

    // Part return: the cable (a kit part at 28%) comes back.
    const cableLine = detail.lines.find((l) => l.sku_id === cable.id);
    const returned = await request('POST', E(`documents/${sale.id}/returns`), { requestKey: key(), reason: 'Not working', lines: [{ lineId: cableLine.id, quantity: '1', restock: true }] }, 201);
    const rl = await one('SELECT net,tax FROM business_return_lines WHERE business_id=$1 AND return_id=$2', [electronics.id, returned.id]);
    assert.equal(paise(rl.net), paise(cableLine.net), 'the part comes back at its own value');
    assert.equal(paise(rl.tax), paise(cableLine.tax), 'and its own GST');
    const back = paise(returned.total);
    assert.equal(back, paise(cableLine.net) + paise(cableLine.tax) + paise(returned.round_off));
    assert.equal(await stockOf(electronics, cable.id), before.cable);
    // The customer is owed the cable's value; more than that is refused.
    assert.equal(await balance(), -back);
    await request('POST', E(`documents/${sale.id}/refunds`), { requestKey: key(), amount: ((back + 1) / 100).toFixed(2), method: 'cash', reason: 'Return' }, 409);
    await request('POST', E(`documents/${sale.id}/refunds`), { requestKey: key(), amount: (back / 100).toFixed(2), method: 'cash', reason: 'Return' }, 201);
    assert.equal(await balance(), 0);
    // A part return leaves the loan as it is: Bajaj still owes 16,000, and it cannot be cancelled yet.
    assert.equal(await owed(), 1600000);
    const theCase = (await request('GET', E(`finance/cases?financierId=${bajaj.id}`))).items.find((c) => c.loan_no === 'BFL-CROSS-1');
    await request('POST', E(`finance/cases/${theCase.id}/cancel`), { reason: 'Customer returned it', requestKey: key() }, 409);

    // Everything else comes back; the loan is cancelled; the customer gets
    // back exactly what they paid themselves, less the cable already refunded.
    const rest = detail.lines.filter((l) => l.sku_id !== cable.id).map((l) => ({ lineId: l.id, quantity: String(Number(l.quantity)), restock: true }));
    const second = await request('POST', E(`documents/${sale.id}/returns`), { requestKey: key(), reason: 'Changed mind', lines: rest }, 201);
    assert.equal(back + paise(second.total), 1829800, 'two returns give back the whole bill exactly');
    const ownLeft = 229800 - back;
    await request('POST', E(`documents/${sale.id}/refunds`), { requestKey: key(), amount: ((ownLeft + 1) / 100).toFixed(2), method: 'cash', reason: 'Return' }, 409);
    await request('POST', E(`finance/cases/${theCase.id}/cancel`), { reason: 'Customer returned it', requestKey: key() });
    assert.equal(await owed(), 0);
    await request('POST', E(`documents/${sale.id}/refunds`), { requestKey: key(), amount: ((ownLeft + 1) / 100).toFixed(2), method: 'cash', reason: 'Return' }, 409);
    await request('POST', E(`documents/${sale.id}/refunds`), { requestKey: key(), amount: (ownLeft / 100).toFixed(2), method: 'upi', reason: 'Return' }, 201);
    assert.equal(await balance(), 0);
    await request('POST', E(`documents/${sale.id}/refunds`), { requestKey: key(), amount: '0.01', method: 'cash', reason: 'Return' }, 409);
    // Stock is all back.
    assert.equal(await stockOf(electronics, phone.id), before.phone);
    assert.equal(await stockOf(electronics, cover.id), before.cover);
    assert.equal(await stockOf(electronics, earbuds.id), before.buds);

    // Day close: the down payment once by method, the financed part apart, the refunds once.
    const day = await request('GET', E('reports/takings'));
    const delta = (pick) => paise(pick(day)) - paise(pick(day0));
    assert.equal(delta((d) => d.received.cash), 100000);
    assert.equal(delta((d) => d.received.upi), 129800);
    assert.equal(delta((d) => d.received.atSale), 229800);
    assert.equal(delta((d) => d.finance.booked), 1600000);
    assert.equal(delta((d) => d.finance.cancelled), 1600000);
    assert.equal(delta((d) => d.refunds.cash), back);
    assert.equal(delta((d) => d.refunds.upi), ownLeft);
    assert.equal(delta((d) => d.refunds.total), 229800);
    assert.equal(delta((d) => d.cashInHand), 100000 - back);
    assert.equal(delta((d) => d.net), 0, 'everything the customer paid went back');
    assert.equal(delta((d) => d.sales.total), 1829800);
    assert.equal(delta((d) => d.sales.returns), 1829800);
  });

  // --- 2. Grocery: split with udhaar, then an advance refund ---------------------------------
  await t.test('grocery: split payment with udhaar, an advance, part of it refunded', async () => {
    const shop = await firstLocation(grocery);
    const supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Oil depot' }, 201);
    const oil = await request('POST', G('catalog'), { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '5', name: 'Groundnut oil 1 L', code: 'GOIL', price: '180' }, 201);
    await request('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines: [{ skuId: oil.id, quantity: '40', unitPrice: '150' }] }, 201);
    const customer = await request('POST', G('contacts'), { kind: 'customer', name: 'Revathi', phone: '9845011111' }, 201);
    const day0 = await request('GET', G('reports/takings'));
    // 5 × 180 = 900: ₹300 cash + ₹200 UPI, ₹400 on udhaar.
    const sale = await request('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: customer.id,
      lines: [{ skuId: oil.id, quantity: '5' }], payments: [{ method: 'cash', amount: '300' }, { method: 'upi', amount: '200' }] }, 201);
    await ties(grocery, sale.id);
    assert.equal(paise(sale.total), 90000);
    const balance = async () => paise((await request('GET', G(`contacts?q=Revathi`))).items[0].balance);
    assert.equal(await balance(), 40000);
    // ₹1,000 cash: ₹400 settles the bill, ₹600 stays as advance.
    const receipt = await request('POST', G(`udhaar/${customer.id}/collections`), { locationId: shop.id, amount: '1000', method: 'cash', requestKey: key() }, 201);
    const collectionId = receipt.id || receipt.collection?.id;
    assert.equal(await balance(), -60000);
    // ₹250 of the advance handed back in cash (manager's approval).
    const repo = require('../../src/modules/business/core/repositories/business.repository');
    const access = require('../../src/modules/business/core/services/businessAccess.service');
    const { refundCollection } = require('../../src/modules/business/salon-weight/services/businessAdvanceRefunds');
    const business = await access.load({ id: ownerUser.id }, grocery.id);
    await repo.transaction(async (db) => {
      await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [grocery.id]);
      return refundCollection(db, business, { id: ownerUser.id }, { collectionId, contactId: customer.id,
        input: { amount: 25000, method: 'cash', reference: null, requestKey: key() }, approval: { reason: 'Asked for part back', approver: { id: Number(ownerUser.id), name: 'Cross owner' } }, source: 'salon' });
    });
    assert.equal(await balance(), -35000);
    // The udhaar book and the account agree.
    const book = await request('GET', G('udhaar?show=advance'));
    const row = book.items.find((r) => Number(r.id ?? r.contact_id) === Number(customer.id));
    assert.equal(paise(row.balance), -35000);
    const account = await request('GET', G(`udhaar/${customer.id}`));
    assert.equal(paise(account.summary.balance), -35000);
    assert.deepEqual(account.advances.map((a) => paise(a.unallocated)), [35000]);
    // The statement ties: 900 debit, 500 paid, 1000 collected, 250 refunded.
    const today = dates.today();
    const st = await request('GET', G(`udhaar/${customer.id}/statement?from=${today}&to=${today}`));
    assert.equal(paise(st.debit), 90000 + 25000);
    assert.equal(paise(st.credit), 50000 + 100000);
    assert.equal(paise(st.closing), -35000);
    assert.ok(st.entries.some((e) => e.kind === 'advance_refund' && paise(e.debit) === 25000));
    // Day close: cash 300 + 1000 in, 250 out; each split part once.
    const day = await request('GET', G('reports/takings'));
    const delta = (pick) => paise(pick(day)) - paise(pick(day0));
    assert.equal(delta((d) => d.received.cash), 30000 + 100000);
    assert.equal(delta((d) => d.received.upi), 20000);
    assert.equal(delta((d) => d.received.atSale), 50000);
    assert.equal(delta((d) => d.received.collections), 100000);
    assert.equal(delta((d) => d.sales.onCredit), 40000);
    assert.equal(delta((d) => d.refunds.cash), 25000, 'the advance handed back is money out');
    assert.equal(delta((d) => d.cashInHand), 130000 - 25000);
    assert.equal(delta((d) => d.net), 150000 - 25000);
  });

  await t.test('grocery: a kit bought with points and split payment, returned in parts: points and refunds tie', async () => {
    const shop = await firstLocation(grocery);
    const supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Festival supplier' }, 201);
    const make = (body) => request('POST', G('catalog'), { kind: 'goods', unit: 'each', tracking: 'quantity', ...body }, 201);
    const sweets = await make({ name: 'Kaju katli 500 g', code: 'KAJU', price: '450', taxRate: '5', hsnCode: '1704' });
    const dryfruit = await make({ name: 'Almonds 250 g', code: 'ALM', price: '300', taxRate: '12', hsnCode: '0802' });
    const diya = await make({ name: 'Clay diya set', code: 'DIYA', price: '150', taxRate: '0', hsnCode: '6912' });
    await request('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines: [
      { skuId: sweets.id, quantity: '10', unitPrice: '300' }, { skuId: dryfruit.id, quantity: '10', unitPrice: '200' }, { skuId: diya.id, quantity: '10', unitPrice: '80' }] }, 201);
    const kit = await request('POST', G('kits'), { name: 'Diwali hamper', code: 'HAMPER', price: '799',
      components: [{ skuId: sweets.id, quantity: 1 }, { skuId: dryfruit.id, quantity: 1 }, { skuId: diya.id, quantity: 1 }] }, 201);
    if (!grocery.capabilities.includes('loyalty')) await request('PUT', G('modules/loyalty'), { enabled: true });
    await request('PUT', G('loyalty/rules'), { earnPerAmount: '100', earnPoints: 1, pointValue: '1', minRedeemPoints: 10, maxRedeemPercent: '50', active: true });
    const customer = await request('POST', G('contacts'), { kind: 'customer', name: 'Hamper buyer', phone: '9845022222' }, 201);
    await request('POST', G(`loyalty/${customer.id}/adjustments`), { points: 300, reason: 'Opening points', requestKey: key() }, 201);
    const points = async () => (await request('GET', G(`loyalty/${customer.id}`))).balance;
    // 2 hampers = 1,598; 99 points off = 1,499: ₹500 cash + the rest by card.
    const sale = await request('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: customer.id,
      lines: [{ skuId: kit.id, quantity: '2' }], loyalty: { redeemPoints: 99 }, payments: [{ method: 'cash', amount: '500' }, { method: 'card', amount: 'full' }] }, 201);
    const doc = await ties(grocery, sale.id);
    const total = paise(doc.total);
    const earned = Math.floor(total / 10000);
    assert.equal(await points(), 300 - 99 + earned);
    const lines = (await request('GET', G(`documents/${sale.id}`))).lines;
    assert.equal(lines.length, 3, 'the kit sells as its parts');
    const exempt = lines.find((l) => l.sku_id === diya.id);
    assert.equal(paise(exempt.tax), 0, 'the 0% part carries no GST');
    // Return one of each part, then the rest: the refunds add up to what was paid, points to what was spent.
    let refunded = 0;
    for (const quantity of ['1', '1']) {
      const r = await request('POST', G(`documents/${sale.id}/returns`), { requestKey: key(), reason: 'Not needed',
        lines: lines.map((l) => ({ lineId: l.id, quantity, restock: true })) }, 201);
      await request('POST', G(`documents/${sale.id}/refunds`), { requestKey: key(), amount: r.total, method: 'cash', reason: 'Return' }, 201);
      refunded += paise(r.total);
    }
    assert.equal(refunded, total, 'the refunds add up exactly to what was paid');
    assert.equal(await points(), 300, 'every spent point back, every earned point gone');
    await request('POST', G(`documents/${sale.id}/refunds`), { requestKey: key(), amount: '0.01', method: 'cash', reason: 'Return' }, 409);
  });

  // --- 3 and 4. Pharmacy: H1 on a split bill, its return; Schedule X after a till switch -----------
  await t.test('pharmacy: H1 on a split-payment prescription bill, returned; the register; X after a PIN switch', async () => {
    const shop = await firstLocation(pharmacy);
    const supplier = await request('POST', P('contacts'), { kind: 'supplier', name: 'Medical agencies' }, 201);
    const five = (await request('GET', P('tax-rates'))).items.find((r) => Number(r.rate) === 5);
    const drug = (body) => request('POST', P('catalog'), { kind: 'goods', unit: 'tablet', tracking: 'batch', taxRateId: five.id, hsnCode: '3004', ...body }, 201);
    const cefi = await drug({ name: 'Cefpodoxime 200 mg', code: 'CPD', price: '12' });
    const mph = await drug({ name: 'Methylphenidate 5 mg', code: 'MPH5', price: '8' });
    await request('PUT', P(`pharmacy/drugs/${cefi.id}`), { composition: 'Cefpodoxime', strength: '200 mg', schedule: 'H1', unitsPerStrip: 10 });
    await request('PUT', P(`pharmacy/drugs/${mph.id}`), { composition: 'Methylphenidate', strength: '5 mg', schedule: 'X', unitsPerStrip: 10, looseSale: true });
    const expires = dates.daysFrom(400);
    await request('POST', P('documents'), { kind: 'purchase', locationId: shop.id, contactId: supplier.id, requestKey: key(), lines: [
      { skuId: cefi.id, quantity: '5', unit: 'strip', unitPrice: '80', lotCode: 'CP-1', expiresOn: expires },
      { skuId: mph.id, quantity: '3', unit: 'strip', unitPrice: '50', lotCode: 'MP-1', expiresOn: expires }] }, 201);
    await request('PUT', P('health/settings'), { rxScanRequired: false });
    const pharmacist = await member(pharmacy, 'cross-pharmacist@test.invalid', 'pharmacist');
    const cashier = await member(pharmacy, 'cross-pcashier@test.invalid', 'cashier');
    const signer = await request('POST', P('health/signatories'), { kind: 'pharmacist', userId: pharmacist.id, name: 'Meena S.', registrationNo: 'TNPC 4512' }, 201);
    const rx = { patientName: 'Lakshmi R', patientPhone: '9840012345', doctorName: 'Dr. K. Raman', doctorRegNo: 'TNMC 65432', prescribedOn: dates.today() };
    const day0 = await request('GET', P('reports/takings'));
    // 2 strips of 10 × ₹12 = ₹240: ₹100 cash + ₹140 UPI.
    const sold = await cashier.call('POST', P('pharmacy/sales'), { requestKey: key(), locationId: shop.id, lines: [{ skuId: cefi.id, quantity: '2', unit: 'strip' }],
      prescription: rx, payments: [{ method: 'cash', amount: '100', tendered: '200' }, { method: 'upi', amount: 'full', reference: 'UPI 5521' }] }, 201);
    const doc = await ties(pharmacy, sold.document.id);
    const pays = await all('SELECT method,amount,tendered FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [pharmacy.id, sold.document.id]);
    assert.deepEqual(pays.map((p) => [p.method, paise(p.amount)]), [['cash', 10000], ['upi', paise(doc.total) - 10000]]);
    assert.equal(sold.registers.length, 1);
    assert.equal(sold.registers[0].register, 'H1');
    // A split that does not cover a walk-in's bill is refused.
    const short = await call('POST', P('pharmacy/sales'), { requestKey: key(), locationId: shop.id, lines: [{ skuId: cefi.id, quantity: '1', unit: 'strip' }],
      prescription: rx, payments: [{ method: 'cash', amount: '10' }, { method: 'upi', amount: '10' }] }, cashier.token);
    assert.equal(short.status, 409, JSON.stringify(short.body));
    // The return: a cashier cannot (no refunds permission); the pharmacist can.
    const line = (await request('GET', P(`documents/${sold.document.id}`))).lines[0];
    await cashier.call('POST', P(`documents/${sold.document.id}/returns`), { requestKey: key(), reason: 'Course changed', lines: [{ lineId: line.id, quantity: '10', restock: true }] }, 403);
    const ret = await pharmacist.call('POST', P(`documents/${sold.document.id}/returns`), { requestKey: key(), reason: 'Course changed', lines: [{ lineId: line.id, quantity: '10', restock: true }] }, 201);
    const retLine = await one('SELECT net,tax FROM business_return_lines WHERE business_id=$1 AND return_id=$2', [pharmacy.id, ret.id]);
    assert.equal(paise(ret.total), paise(retLine.net) + paise(retLine.tax) + paise(ret.round_off), 'the return ties to its line and round-off');
    assert.ok(Math.abs(paise(ret.total) * 2 - paise(doc.total)) <= 2, 'half the strips, half the bill (to the paisa of round-off)');
    await cashier.call('POST', P(`documents/${sold.document.id}/refunds`), { requestKey: key(), amount: ret.total, method: 'cash', reason: 'Return' }, 403);
    await pharmacist.call('POST', P(`documents/${sold.document.id}/refunds`), { requestKey: key(), amount: ret.total, method: 'cash', reason: 'Return' }, 201);
    // The register keeps the sale as written and shows what came back.
    const h1 = await request('GET', P('pharmacy/registers/h1'));
    assert.equal(h1.total, 1);
    assert.equal(Number(h1.items[0].quantity), 20, 'two strips of 10, in tablets');
    assert.equal(Number(h1.items[0].returned), 10, 'the register shows the strip that came back');
    await assert.rejects(pool.query('UPDATE pharmacy_register_entries SET quantity=1 WHERE business_id=$1', [pharmacy.id]));

    // The till switched to the cashier by PIN; Schedule X still needs the pharmacist.
    const session = await pharmacist.call('POST', P('counter/switch'), { userId: cashier.id, pin: '2468' });
    assert.equal(Number(session.user.id), cashier.id);
    const asCashier = as(session.token);
    const xBody = { requestKey: key(), locationId: shop.id, lines: [{ skuId: mph.id, quantity: '5' }], prescription: rx, payments: [{ method: 'cash', amount: 'full' }] };
    const noSign = await call('POST', P('pharmacy/sales'), xBody, session.token);
    assert.equal(noSign.body.data?.reason, 'pharmacist_signoff');
    // The cashier's own PIN is not the pharmacist's sign-off.
    const wrong = await call('POST', P('pharmacy/sales'), { ...xBody, signoff: { signatoryId: signer.id, pin: '1357' } }, session.token);
    assert.equal(wrong.status, 400);
    // "PIN every bill" on: the counter channel needs the biller's PIN too.
    const s = await request('GET', P('settings'));
    await request('PUT', P('settings'), { displayName: s.display_name, taxMode: s.tax_mode, rounding: s.rounding, fiscalYearStartMonth: s.fiscal_year_start_month,
      dateFormat: s.date_format, counterPinEveryBill: true });
    const noPin = await call('POST', P('pharmacy/sales'), { ...xBody, channel: 'counter', signoff: { signatoryId: signer.id, pin: '2468' } }, session.token);
    assert.equal(noPin.status, 403, JSON.stringify(noPin.body));
    assert.equal(noPin.body.data?.reason, 'pin_required');
    const x = await asCashier('POST', P('pharmacy/sales'), { ...xBody, channel: 'counter', counterPin: '2468', signoff: { signatoryId: signer.id, pin: '2468' } }, 201);
    assert.equal(Number(x.document.created_by), cashier.id, 'billed as the person the till was switched to');
    assert.equal(x.registers[0].register, 'X');
    assert.equal(Number(x.registers[0].signatory_id), Number(signer.id));
    // The same request again is the same bill (the PIN is not part of it).
    const again = await asCashier('POST', P('pharmacy/sales'), { ...xBody, channel: 'counter', counterPin: '2468', signoff: { signatoryId: signer.id, pin: '2468' } }, 201);
    assert.equal(again.document.id, x.document.id);
    await request('PUT', P('settings'), { displayName: s.display_name, taxMode: s.tax_mode, rounding: s.rounding, fiscalYearStartMonth: s.fiscal_year_start_month,
      dateFormat: s.date_format, counterPinEveryBill: false });

    // Day close: each part once, the refund once.
    const day = await request('GET', P('reports/takings'));
    const delta = (pick) => paise(pick(day)) - paise(pick(day0));
    assert.equal(delta((d) => d.received.cash), 10000 + paise(x.document.total));
    assert.equal(delta((d) => d.received.upi), paise(doc.total) - 10000);
    assert.equal(delta((d) => d.refunds.cash), paise(ret.total));
    assert.equal(delta((d) => d.sales.total), paise(doc.total) + paise(x.document.total));
  });

  // --- 5. Wholesale: scheme free line, bounced cheque, credit hold --------------------------------
  await t.test('wholesale: a scheme free line, the cheque bounced, the invoice reopened, credit hold', async () => {
    await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none' WHERE business_id=$1", [wholesale.id]);
    const godown = await firstLocation(wholesale);
    const company = await request('POST', W('contacts'), { kind: 'supplier', name: 'Snack company' }, 201);
    const retailer = await request('POST', W('contacts'), { kind: 'customer', name: 'Sri Ganesh Stores', creditDays: 30 }, 201);
    const biscuits = await request('POST', W('catalog'), { name: 'Cream biscuits', code: 'CRB', kind: 'goods', unit: 'each', tracking: 'quantity', price: '10', taxRate: '18' }, 201);
    const noodles = await request('POST', W('catalog'), { name: 'Masala noodles', code: 'MNDL', kind: 'goods', unit: 'each', tracking: 'batch', price: '12', taxRate: '12' }, 201);
    await request('POST', W('pack-sizes'), { skuId: biscuits.id, unitCode: 'case', quantityInBase: '48' }, 201);
    await request('POST', W('pack-sizes'), { skuId: noodles.id, unitCode: 'case', quantityInBase: '24' }, 201);
    await request('POST', W('documents'), { kind: 'purchase', locationId: godown.id, contactId: company.id, requestKey: key(), lines: [
      { skuId: biscuits.id, quantity: '960', unitPrice: '7' }, { skuId: noodles.id, quantity: '240', unitPrice: '9', lotCode: 'MN-1', expiresOn: dates.daysFrom(180) }] }, 201);
    await request('POST', W('schemes'), { name: 'Biscuits 5 cases + 1 case noodles', skuId: biscuits.id, unitCode: 'case', buyQuantity: '5',
      freeQuantity: '1', freeSkuId: noodles.id, freeUnitCode: 'case' }, 201);
    const order = await request('POST', W('sales-orders'), { locationId: godown.id, contactId: retailer.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '5' }] }, 201);
    const lines = (await request('GET', W(`sales-orders/${order.id}`))).lines;
    const paid = lines.find((l) => !l.free_of_line_id), free = lines.find((l) => l.free_of_line_id);
    assert.ok(free, 'the free line is on the order');
    const noodleStock = await stockOf(wholesale, noodles.id);
    const sent = await request('POST', W(`sales-orders/${order.id}/dispatch`), { requestKey: key(), transporterName: 'Own van', vehicleNo: 'KA01AB1234',
      lines: [{ orderLineId: paid.id, unit: 'case', quantity: '5' }, { orderLineId: free.id, unit: 'case', quantity: '1' }] }, 201);
    const invoice = await ties(wholesale, sent.document.id);
    // 240 × ₹10 + 18% = ₹2,832; the free noodles at ₹0 and no GST.
    assert.equal(paise(invoice.total), 283200);
    const freeLine = await one('SELECT net,tax FROM business_document_lines WHERE business_id=$1 AND document_id=$2 AND sku_id=$3', [wholesale.id, sent.document.id, noodles.id]);
    assert.equal(paise(freeLine.net) + paise(freeLine.tax), 0);
    assert.equal(await stockOf(wholesale, noodles.id), noodleStock - 24);
    const balance = async () => paise((await request('GET', W(`contacts?q=${encodeURIComponent('Sri Ganesh')}`))).items[0].balance);
    assert.equal(await balance(), 283200);
    // A second order, still to go, with the scheme.
    const order2 = await request('POST', W('sales-orders'), { locationId: godown.id, contactId: retailer.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '5' }] }, 201);
    const day0 = await request('GET', W('reports/takings'));
    // A cheque pays it in full; it bounces.
    const cheque = await request('POST', W('collections'), { locationId: godown.id, contactId: retailer.id, amount: '2832', method: 'cheque', reference: '100201',
      chequeDate: dates.today(), bank: 'Canara', requestKey: key() }, 201);
    assert.equal(await balance(), 0);
    const paidOn = async () => paise((await one('SELECT COALESCE(sum(amount),0) AS s FROM business_payments WHERE business_id=$1 AND document_id=$2', [wholesale.id, sent.document.id])).s);
    assert.equal(await paidOn(), 283200);
    const b1 = await request('POST', W(`collections/${cheque.id}/cheque`), { action: 'bounce', reason: 'Funds insufficient' });
    assert.equal(b1.bounce_charge, '500.00');
    assert.equal(await paidOn(), 0, 'the invoice is open again');
    assert.equal(await balance(), 283200 + 50000);
    // The free goods stay sent; the stock does not move on a bounce.
    assert.equal(await stockOf(wholesale, noodles.id), noodleStock - 24);
    const st = await request('GET', W(`receivables/customers/${retailer.id}/statement?from=${dates.today()}&to=${dates.today()}`));
    assert.equal(paise(st.closing), 333200);
    // A second bounce within 90 days holds new orders, schemes or not.
    const cheque2 = await request('POST', W('collections'), { locationId: godown.id, contactId: retailer.id, amount: '1000', method: 'cheque', reference: '100202',
      chequeDate: dates.today(), bank: 'Canara', requestKey: key() }, 201);
    const b2 = await request('POST', W(`collections/${cheque2.id}/cheque`), { action: 'bounce', reason: 'Funds insufficient', charge: '0' });
    assert.deepEqual(b2.credit_hold, { bounces: 2, days: 90, limit: 2 });
    assert.equal(await balance(), 333200, 'a zero charge adds nothing');
    const cashier = await member(wholesale, 'cross-wcashier@test.invalid', 'cashier');
    const held = await call('POST', W('sales-orders'), { locationId: godown.id, contactId: retailer.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '5' }] }, cashier.token);
    assert.equal(held.status, 409);
    assert.equal(held.body.data.holdReason, 'bounced_cheques');
    // The open order on hold: more is refused; less is allowed, and the free goods go with the scheme.
    const line2 = (await request('GET', W(`sales-orders/${order2.id}`))).lines.find((l) => !l.free_of_line_id);
    const more = await call('PATCH', W(`sales-orders/${order2.id}`), { requestKey: key(), reason: 'More', lines: [{ orderLineId: line2.id, unit: 'case', quantity: '10' }] }, cashier.token);
    assert.equal(more.status, 409, JSON.stringify(more.body));
    assert.equal(more.body.data.reason, 'credit_hold');
    await request('PATCH', W(`sales-orders/${order2.id}`), { requestKey: key(), reason: 'Less', lines: [{ orderLineId: line2.id, unit: 'case', quantity: '4' }] });
    const after = (await request('GET', W(`sales-orders/${order2.id}`))).lines;
    const open = (l) => Number(l.quantity) - Number(l.closed_quantity || 0) - Number(l.dispatched_quantity || l.sent_quantity || 0);
    assert.equal(after.filter((l) => l.free_of_line_id && open(l) > 0).length, 0, '4 cases earn no free case');
    assert.equal(after.filter((l) => !l.free_of_line_id && open(l) > 0).reduce((s, l) => s + open(l), 0), 192);
    // Day close: a cheque that bounced is no money in.
    const day = await request('GET', W('reports/takings'));
    const delta = (pick) => paise(pick(day)) - paise(pick(day0));
    assert.equal(delta((d) => d.net), 0, 'the bounced cheques net to nothing');
    assert.equal(delta((d) => d.cashInHand), 0);
  });

  // --- 6. Restaurant: a pickup-order advance counted once ------------------------------------
  await t.test('restaurant: an advance on a pickup order is counted once in the day', async () => {
    const food = (await request('GET', '/menu/tax-rates')).find((r) => r.isDefault);
    const mains = await request('POST', '/menu/categories', { name: 'Mains' }, 201);
    const biryani = await request('POST', '/menu/products', { categoryId: mains.id, name: 'Biryani', price: 300, taxRateId: food.id, isAvailable: true }, 201);
    await request('POST', '/business-day/open', { openingCash: 1000 }, 201);
    const x0 = await request('GET', '/business-day/x-report');
    const guest = await request('POST', '/crm/customers', { name: 'Kavya', mobile: '9876500077' }, 201);
    const pickup = await request('POST', '/orders', { orderType: 'takeaway', customerName: 'Kavya', items: [{ productId: biryani.id, quantity: 2 }] }, 201);
    const advance = await request('POST', '/bills/advances', { customerId: guest.id, amount: 200, paymentMethod: 'upi', transactionRef: 'UTR 1', orderId: pickup.id }, 201);
    const bill = await request('POST', '/bills', { orderId: pickup.id }, 201);
    await request('POST', `/bills/${bill.id}/payments`, { paymentMethod: 'advance', amount: 200, advanceId: advance.id }, 201);
    const due = (await request('GET', `/bills/${bill.id}`)).dueAmount ?? null;
    const rest = Number(due ?? (Number(bill.grandTotal ?? bill.totalAmount) - 200));
    const settled = await request('POST', `/bills/${bill.id}/payments`, { paymentMethod: 'cash', amount: rest }, 201);
    assert.equal(settled.billStatus, 'paid');
    const x1 = await request('GET', '/business-day/x-report');
    // The bill: the advance it used once (as "advance", not again as UPI) and the cash part.
    const method = (r, m) => paise(r.methods.find((x) => x.method === m)?.taken || 0);
    assert.equal(method(x1, 'advance') - method(x0, 'advance'), 20000);
    assert.equal(method(x1, 'cash') - method(x0, 'cash'), paise(rest));
    assert.equal(method(x1, 'upi') - method(x0, 'upi'), 0, 'the advance is not counted again as UPI on the bill');
    // The day close: the UPI advance once as money taken; the drawer holds opening + the cash part.
    const preview = await request('GET', '/business-day/close-preview');
    assert.equal(paise(preview.figures.inDrawer), paise(1000 + rest));
    assert.equal(paise(preview.figures.cashSales), paise(rest));
    assert.equal(paise(preview.figures.methods.find((m) => m.method === 'advance').taken), 20000);
  });
});
