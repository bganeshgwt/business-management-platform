const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const dates = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Wholesale / FMCG distribution: receipts split between bills, opening
// balance and advance; cheques (date, bank, deposit, clear, bounce with
// reversal and charge); follow-ups and promises; evening settlement per
// salesperson; price groups with dated prices, revisions and schemes; line
// discounts and free goods; credit hold with a manager's PIN; order edits
// and closing one line; transport and e-way bill; delivery runs, pick list
// and load sheet; delivery, van returns; invoice extras; trade details and
// place of supply; salespeople logins and targets; overview figures;
// supplier claims; the documents list's wholesale filters. Runs against its
// own throwaway database with every migration applied.
test('wholesale: cheques, settlement, schemes, hold, edits, delivery', { timeout: 300000 }, async (t) => {
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
  const password = `WsPro-${crypto.randomBytes(8).toString('hex')}`;
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
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('wspro-owner');
  await owner('wspro-other');
  const token = await login('wspro-owner@test.invalid');
  const otherToken = await login('wspro-other@test.invalid');
  const tokens = {};
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const day = (offset) => dates.daysFrom(offset);

  const [ws] = await createBusinesses(request, 'OWNER', ['wholesale']);
  const [otherWs] = await createBusinesses(other, 'OTHER', ['wholesale']);
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const W = (suffix) => `/businesses/${ws.id}/${suffix}`;
  const O = (suffix) => `/businesses/${otherWs.id}/${suffix}`;

  // Staff with each template role.
  const staff = {};
  const people = {};
  const roles = (await request('GET', W('roles'))).items;
  for (const template of ['manager', 'cashier', 'stock_keeper', 'accountant', 'viewer']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, `WSP ${template}`, `wsp-${template}@test.invalid`, hash]);
    await request('POST', W('members'), { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    tokens[template] = await login(`wsp-${template}@test.invalid`);
    staff[template] = as(tokens[template]);
    people[template] = person;
  }

  const location = (await request('GET', W('locations'))).items[0];
  const supplier = await request('POST', W('contacts'), { kind: 'supplier', name: 'Sunrise Foods Depot (fictional)', creditDays: 30 }, 201);
  const shop = await request('POST', W('contacts'), { kind: 'customer', name: 'Om Sai Super Mart', creditDays: 30, openingBalance: '2000', openingBalanceOn: day(-120) }, 201);
  const kirana = await request('POST', W('contacts'), { kind: 'customer', name: 'Shree Balaji Kirana', creditDays: 15 }, 201);
  const hotel = await request('POST', W('contacts'), { kind: 'customer', name: 'Hotel Annapurna', creditDays: 7 }, 201);
  const noodles = await request('POST', W('catalog'), { name: 'Instant noodles 70 g', code: 'NDL', kind: 'goods', unit: 'each', tracking: 'batch', price: '12', taxRate: '18' }, 201);
  const biscuits = await request('POST', W('catalog'), { name: 'Glucose biscuits 100 g', code: 'BIS', kind: 'goods', unit: 'each', tracking: 'quantity', price: '10', taxRate: '18' }, 201);
  await request('POST', W('pack-sizes'), { skuId: noodles.id, unitCode: 'case', quantityInBase: '96' }, 201);
  await request('POST', W('pack-sizes'), { skuId: biscuits.id, unitCode: 'case', quantityInBase: '48' }, 201);
  await request('POST', W('documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [
    { skuId: noodles.id, quantity: '960', unitPrice: '9', lotCode: 'N-EARLY', expiresOn: day(40) },
    { skuId: noodles.id, quantity: '960', unitPrice: '9', lotCode: 'N-LATE', expiresOn: day(200) },
    { skuId: biscuits.id, quantity: '2400', unitPrice: '7' }] }, 201);
  const salesperson = await request('POST', W('salespeople'), { name: 'Ravi Kumar', phone: '98450 12345' }, 201);
  const route = await request('POST', W('routes'), { name: 'Hadapsar route', locationId: location.id }, 201);
  const isoToday = ((new Date(`${day(0)}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const beat = await request('POST', W('beats'), { routeId: route.id, name: 'Hadapsar market', visitDay: isoToday, salespersonId: salesperson.id }, 201);
  for (const c of [shop, kirana, hotel]) await request('PUT', W(`customer-beats/${c.id}`), { beatId: beat.id });

  // A bill for each customer (a counter sale on credit).
  const bill = async (contact, quantity) => request('POST', W('documents'), { kind: 'sale', locationId: location.id, contactId: contact.id, requestKey: key(),
    lines: [{ skuId: biscuits.id, quantity: String(quantity) }] }, 201);

  await t.test('a receipt says what went against bills, the opening balance and what is a true advance', async () => {
    const b1 = await bill(shop, 50); // 590.00
    const receipt = await request('POST', W('collections'), { locationId: location.id, contactId: shop.id, amount: '3000', method: 'cash', requestKey: key() }, 201);
    assert.equal(receipt.opening_applied, '2000.00');
    assert.equal(receipt.allocated, '590.00');
    assert.equal(receipt.unallocated, '410.00');
    const detail = await request('GET', W(`collections/${receipt.id}`));
    assert.deepEqual([detail.allocated, detail.opening_applied, detail.unallocated], ['590.00', '2000.00', '410.00']);
    const list = await request('GET', W(`collections?contact=${shop.id}`));
    const row = list.items.find((k) => k.id === receipt.id);
    assert.equal(Number(row.opening_applied), 2000);
    assert.equal(Number(row.unallocated), 410);
    // A second receipt: the opening balance is already covered, so it is all advance.
    const second = await request('POST', W('collections'), { locationId: location.id, contactId: shop.id, amount: '100', method: 'cash', requestKey: key() }, 201);
    assert.equal(second.opening_applied, '0.00');
    assert.equal(second.unallocated, '100.00');
    assert.ok(b1.id);
  });

  let cheque;
  await t.test('a cheque has a date and bank; post-dated cannot be deposited; deposit and clear are logged', async () => {
    await bill(kirana, 100); // 1,180.00
    await request('POST', W('collections'), { locationId: location.id, contactId: kirana.id, amount: '10', method: 'cash', chequeDate: day(0), requestKey: key() }, 400);
    await request('POST', W('collections'), { locationId: location.id, contactId: kirana.id, amount: '10', method: 'cheque', reference: '000111', chequeDate: day(200), requestKey: key() }, 400);
    const pdc = await request('POST', W('collections'), { locationId: location.id, contactId: kirana.id, amount: '100', method: 'cheque', reference: '000222',
      chequeDate: day(10), bank: 'HDFC Bank', requestKey: key(), salespersonId: salesperson.id }, 201);
    assert.equal(pdc.cheque_date, day(10));
    assert.equal(pdc.cheque_status, 'received');
    const early = await call('POST', W(`collections/${pdc.id}/cheque`), { action: 'deposit' }, token);
    assert.equal(early.status, 409);
    assert.match(early.body.message, /cannot be deposited before then/);
    const out = await request('GET', W('outstanding?show=all&q=Balaji'));
    assert.equal(Number(out.items[0].post_dated_cheques), 100);
    assert.equal(Number(out.totals.uncleared_cheques), 100);
    cheque = await staff.cashier('POST', W('collections'), { locationId: location.id, contactId: kirana.id, amount: '1000', method: 'cheque', reference: '000333',
      chequeDate: day(0), bank: 'SBI', requestKey: key(), salespersonId: salesperson.id }, 201);
    const due = await request('GET', W('cheques?due=true'));
    assert.ok(due.items.some((c) => c.collection_id === cheque.id));
    const deposited = await staff.cashier('POST', W(`collections/${cheque.id}/cheque`), { action: 'deposit', depositedInto: 'Current a/c' });
    assert.equal(deposited.status, 'deposited');
    await staff.viewer('POST', W(`collections/${cheque.id}/cheque`), { action: 'clear' }, 403);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='cheque.deposited' AND entity_id=$2", [ws.id, cheque.id]));
    // What was written on a cheque never changes; the row is never deleted.
    await assert.rejects(pool.query("UPDATE business_collection_cheques SET cheque_no='999' WHERE collection_id=$1", [cheque.id]), /cannot be changed/);
    await assert.rejects(pool.query('DELETE FROM business_collection_cheques WHERE collection_id=$1', [cheque.id]), /kept/);
  });

  await t.test('a bounced cheque reopens the bills, stops counting and adds the bank charge', async () => {
    const before = await request('GET', W(`receivables/customers/${kirana.id}`));
    const settledBills = await rows('SELECT document_id,amount FROM business_payments WHERE collection_id=$1', [cheque.id]);
    assert.ok(settledBills.length > 0);
    await staff.cashier('POST', W(`collections/${cheque.id}/cheque`), { action: 'bounce', reason: 'Funds insufficient' }, 403);
    await staff.accountant('POST', W(`collections/${cheque.id}/cheque`), { action: 'bounce' }, 400);
    const bounced = await staff.accountant('POST', W(`collections/${cheque.id}/cheque`), { action: 'bounce', reason: 'Funds insufficient', charge: '250' });
    assert.equal(bounced.status, 'bounced');
    assert.equal(bounced.reversed_allocations.length, settledBills.length);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_payments WHERE collection_id=$1', [cheque.id])).n, 0);
    const after = await request('GET', W(`receivables/customers/${kirana.id}`));
    assert.equal(paise(after.summary.balance), paise(before.summary.balance) + 100000 + 25000, 'the cheque no longer counts and the charge is owed');
    assert.equal(paise(after.summary.outstanding), paise(after.summary.balance));
    assert.ok(after.items.some((i) => /bounce charge/.test(i.reference)));
    // Twice is refused; a bounced cheque is not deposited again.
    await staff.accountant('POST', W(`collections/${cheque.id}/cheque`), { action: 'bounce', reason: 'again' }, 409);
    await staff.accountant('POST', W(`collections/${cheque.id}/cheque`), { action: 'clear' }, 409);
    const receipt = await request('GET', W(`collections/${cheque.id}`));
    assert.equal(receipt.cheque.status, 'bounced');
    assert.equal(receipt.unallocated, '0.00');
    // The statement shows the receipt and, on the day it bounced, the cheque returned and the charge.
    const statement = await request('GET', W(`receivables/customers/${kirana.id}/statement?from=${day(-1)}&to=${day(0)}`));
    assert.ok(statement.entries.some((e) => e.kind === 'bounce' && paise(e.debit) === 100000));
    assert.ok(statement.entries.some((e) => e.kind === 'bounce_charge' && paise(e.debit) === 25000));
    assert.equal(paise(statement.closing), paise(after.summary.balance));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='collection.reversed' AND entity_id=$2", [ws.id, cheque.id]));
    // The overview's cheque figures.
    const summary = await request('GET', W('wholesale-summary'));
    assert.equal(summary.cheques.bounced_30_days, 1);
    assert.equal(summary.cheques.post_dated, 1);
  });

  await t.test('a promise is kept in the reminder book and shown on the outstanding list', async () => {
    await request('POST', W(`receivables/customers/${kirana.id}/follow-ups`), { channel: 'call', promisedOn: day(-1) }, 400);
    const promise = await staff.cashier('POST', W(`receivables/customers/${kirana.id}/follow-ups`), { channel: 'whatsapp', promisedOn: day(3), promisedAmount: '500', note: 'Will pay on Friday' }, 201);
    assert.match(promise.note, /Promised 500.00/);
    const out = await request('GET', W('outstanding?q=Balaji'));
    assert.equal(out.items[0].promised_on, day(3));
    assert.ok(out.items[0].last_reminder_at);
    const account = await request('GET', W(`receivables/customers/${kirana.id}`));
    assert.equal(account.reminders[0].channel, 'whatsapp');
    await staff.viewer('POST', W(`receivables/customers/${kirana.id}/follow-ups`), { channel: 'call' }, 403);
  });

  await t.test('evening settlement per salesperson; shortage needs a note; each receipt settles once', async () => {
    await request('POST', W('collections'), { locationId: location.id, contactId: hotel.id, amount: '700', method: 'cash', requestKey: key(), salespersonId: salesperson.id }, 201);
    await request('POST', W('collections'), { locationId: location.id, contactId: hotel.id, amount: '300', method: 'upi', reference: 'UPI-1', requestKey: key(), salespersonId: salesperson.id }, 201);
    const preview = await request('GET', W(`settlements/preview?salesperson=${salesperson.id}&day=${day(0)}`));
    assert.equal(preview.totals.cash, '700.00');
    assert.equal(preview.totals.upi, '300.00');
    // The bounced cheque does not count; the post-dated one does.
    assert.equal(preview.totals.cheques, '100.00');
    assert.equal(preview.totals.cheque_count, 1);
    await staff.cashier('POST', W('settlements'), { salespersonId: salesperson.id, day: day(0), cashHanded: '700', requestKey: key() }, 403);
    await staff.accountant('POST', W('settlements'), { salespersonId: salesperson.id, day: day(0), cashHanded: '650', requestKey: key() }, 400);
    await staff.accountant('POST', W('settlements'), { salespersonId: salesperson.id, day: day(1), cashHanded: '0', requestKey: key() }, 400);
    const body = { salespersonId: salesperson.id, day: day(0), cashHanded: '650', notes: 'Short by 50; to be recovered from salary', requestKey: key() };
    const settled = await staff.accountant('POST', W('settlements'), body, 201);
    assert.equal(settled.difference, '-50.00');
    assert.equal(settled.receipts, 3);
    const again = await staff.accountant('POST', W('settlements'), body, 201);
    assert.equal(again.id, settled.id);
    const empty = await request('GET', W(`settlements/preview?salesperson=${salesperson.id}&day=${day(0)}`));
    assert.equal(empty.receipts.length, 0);
    assert.equal(empty.earlier.length, 1);
    await staff.accountant('POST', W('settlements'), { salespersonId: salesperson.id, day: day(0), cashHanded: '0', requestKey: key() }, 409);
    await assert.rejects(pool.query('UPDATE wholesale_settlements SET cash_handed=700 WHERE id=$1', [settled.id]), /cannot be changed/);
    const settledList = await request('GET', W('collections?settled=true'));
    assert.equal(settledList.total, 3);
    assert.ok(settledList.items.every((k) => k.salesperson_name === 'Ravi Kumar'));
  });

  let group;
  await t.test('price groups with dated prices; the customer price beats the group, the group beats a slab', async () => {
    group = await request('POST', W('price-groups'), { name: 'Retailers' }, 201);
    await request('POST', W('price-groups'), { name: 'retailers' }, 409);
    await staff.cashier('POST', W('price-groups'), { name: 'HoReCa' }, 403);
    await request('PUT', W(`wholesale-customers/${kirana.id}`), { priceGroupId: group.id, stateCode: '27', pinCode: '411028', contactPerson: 'Mr Balaji' });
    await request('PUT', W(`wholesale-customers/${kirana.id}`), { stateCode: 'MH' }, 400);
    // A general slab: a case at ₹1,100; the group price: ₹1,050 a case from today.
    await request('POST', W('pricing'), { skuId: noodles.id, unitCode: 'case', minimumQuantity: '1', unitPrice: '1100' }, 201);
    const current = await request('POST', W('group-prices'), { groupId: group.id, skuId: noodles.id, unitCode: 'case', minimumQuantity: '1', unitPrice: '1050' }, 201);
    await request('POST', W('group-prices'), { groupId: group.id, skuId: noodles.id, unitCode: 'case', unitPrice: '1000', validFrom: day(-1) }, 400);
    const order = await request('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: key(), lines: [{ skuId: noodles.id, unit: 'case', quantity: '2' }] }, 201);
    const line = (await request('GET', W(`sales-orders/${order.id}`))).lines[0];
    assert.equal(line.entered_unit_price, '1050.00');
    assert.equal(line.net, '2100.00');
    // Someone not in the group pays the slab.
    const hotelOrder = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: noodles.id, unit: 'case', quantity: '2' }] }, 201);
    assert.equal((await request('GET', W(`sales-orders/${hotelOrder.id}`))).lines[0].entered_unit_price, '1100.00');
    // A new price from a later date ends the current one the day before.
    const later = await request('POST', W('group-prices'), { groupId: group.id, skuId: noodles.id, unitCode: 'case', minimumQuantity: '1', unitPrice: '1080', validFrom: day(5) }, 201);
    assert.equal((await one('SELECT valid_to FROM wholesale_group_prices WHERE id=$1', [current.id])).valid_to, day(4));
    const listed = await request('GET', W(`group-prices?group=${group.id}`));
    assert.deepEqual(listed.items.map((p) => p.state).sort(), ['current', 'upcoming']);
    // An upcoming price can simply be withdrawn; the current one ends today.
    const withdrawn = await request('POST', W(`group-prices/${later.id}/end`), {});
    assert.equal(withdrawn.withdrawn, true);
    // Revise every running price in the group by 10 %, from tomorrow.
    const revised = await request('POST', W('group-prices/revise'), { groupId: group.id, percent: 10, validFrom: day(1) });
    assert.equal(revised.revised, 1);
    assert.ok(await one("SELECT 1 FROM wholesale_group_prices WHERE group_id=$1 AND unit_price=1155 AND valid_from=$2", [group.id, day(1)]));
    // A customer's own price still wins.
    await request('POST', W('pricing'), { skuId: noodles.id, contactId: kirana.id, unitCode: 'case', minimumQuantity: '1', unitPrice: '990' }, 201);
    const own = await request('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: key(), lines: [{ skuId: noodles.id, unit: 'case', quantity: '1' }] }, 201);
    assert.equal((await request('GET', W(`sales-orders/${own.id}`))).lines[0].entered_unit_price, '990.00');
    for (const o of [order, hotelOrder, own]) await request('POST', W(`sales-orders/${o.id}/close`), { reason: 'test order' });
  });

  let schemeOrder;
  await t.test('a scheme gives free cases and a discount; a hand discount needs sales.discount', async () => {
    const scheme = await request('POST', W('schemes'), { name: 'Buy 5 cases get 1 free', skuId: biscuits.id, unitCode: 'case', buyQuantity: '5', freeQuantity: '1', discountPercent: '2' }, 201);
    await request('POST', W('schemes'), { name: 'Nothing', skuId: biscuits.id, buyQuantity: '5' }, 400);
    await staff.cashier('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: biscuits.id, quantity: '10', discountPercent: '5' }] }, 403);
    schemeOrder = await staff.manager('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(),
      lines: [{ skuId: biscuits.id, unit: 'case', quantity: '5', discountPercent: '3' }] }, 201);
    const lines = (await request('GET', W(`sales-orders/${schemeOrder.id}`))).lines;
    const paid = lines.find((l) => !l.free_of_line_id), free = lines.find((l) => l.free_of_line_id);
    // 5 cases × 48 × ₹10 = 2,400 less 5 % (scheme 2 + hand 3) = 2,280.00 + 18 % GST.
    assert.equal(paid.discount_percent, '5.00');
    assert.equal(paid.net, '2280.00');
    assert.equal(paid.scheme_id, scheme.id);
    assert.equal(free.quantity, '48.000');
    assert.equal(free.entered_unit, 'case');
    assert.equal(free.net, '0.00');
    assert.equal(schemeOrder.total, String((2280 * 1.18).toFixed(2)));
    // The free line ships at no charge; the invoice knows the discount and the free goods.
    const sent = await request('POST', W(`sales-orders/${schemeOrder.id}/dispatch`), { requestKey: key(), lines: [
      { orderLineId: paid.id, unit: 'case', quantity: '5' }, { orderLineId: free.id, unit: 'case', quantity: '1' }] }, 201);
    const invoice = await request('GET', W(`documents/${sent.document.id}`));
    assert.equal(invoice.wholesale.order_no, schemeOrder.order_no);
    assert.equal(invoice.wholesale.lines.filter((l) => l.free).length, 1);
    assert.equal(invoice.wholesale.lines.find((l) => !l.free).discount_percent, '5.00');
    const freeInvoiceLine = invoice.lines.find((l) => Number(l.net) === 0);
    assert.equal(freeInvoiceLine.quantity, '48.000');
    const used = await request('GET', W('schemes'));
    assert.equal(used.items[0].times_used, 1);
  });

  await t.test('credit hold on overdue bills; a manager lets it through with a PIN and a reason', async () => {
    await staff.cashier('PUT', W('wholesale-settings'), { holdOverdueDays: 15 }, 403);
    await request('PUT', W('wholesale-settings'), { holdOverdueDays: 400 }, 400);
    await request('PUT', W('wholesale-settings'), { holdOverdueDays: 15 });
    // Om Sai's opening balance was covered; give them an old unpaid bill.
    const old = await bill(shop, 200); // 2,360: more than the 510 of advances they hold
    await pool.query("UPDATE business_documents SET created_at=now()-interval '60 days', due_on=$2 WHERE id=$1", [old.id, day(-30)]);
    const body = { locationId: location.id, contactId: shop.id, requestKey: key(), lines: [{ skuId: biscuits.id, quantity: '10' }] };
    const held = await call('POST', W('sales-orders'), body, tokens.cashier);
    assert.equal(held.status, 409);
    assert.equal(held.body.data.reason, 'credit_hold');
    assert.ok(held.body.data.days >= 30);
    const summary = await staff.cashier('GET', W(`sales-orders/customer-summary/${shop.id}`));
    assert.equal(summary.hold.held, true);
    // The cashier cannot release it alone; a manager without a PIN cannot either.
    await staff.cashier('POST', W('sales-orders'), { ...body, release: { reason: 'Owner said yes' } }, 400);
    await staff.cashier('POST', W('sales-orders'), { ...body, release: { reason: 'x', approverId: people.manager.id, pin: '4321' } }, 409);
    await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [people.manager.id, await bcrypt.hash('4321', 4)]);
    await staff.cashier('POST', W('sales-orders'), { ...body, release: { reason: 'x', approverId: people.manager.id, pin: '9999' } }, 400);
    await staff.cashier('POST', W('sales-orders'), { ...body, release: { reason: 'x', approverId: people.viewer.id, pin: '4321' } }, 403);
    const released = await staff.cashier('POST', W('sales-orders'), { ...body, release: { reason: 'Cheque promised for Friday', approverId: people.manager.id, pin: '4321' } }, 201);
    assert.equal(released.hold_released, true);
    const record = await one('SELECT * FROM wholesale_hold_releases WHERE order_id=$1', [released.id]);
    assert.equal(record.released_by, people.manager.id);
    assert.equal(record.requested_by, people.cashier.id);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='sales_order.hold_released' AND entity_id=$2 AND actor_id=$3", [ws.id, released.id, people.manager.id]));
    // A manager releases their own order with a reason; an exempt customer is never held.
    await staff.manager('POST', W('sales-orders'), { ...body, requestKey: key(), release: { reason: 'Regular customer' } }, 201);
    await staff.cashier('PUT', W(`wholesale-customers/${shop.id}`), { holdExempt: true }, 403);
    await request('PUT', W(`wholesale-customers/${shop.id}`), { holdExempt: true });
    await staff.cashier('POST', W('sales-orders'), { ...body, requestKey: key() }, 201);
    await request('PUT', W(`wholesale-customers/${shop.id}`), { holdExempt: false });
    const list = await request('GET', W(`sales-orders?contact=${shop.id}&status=open`));
    assert.ok(list.items.some((o) => o.hold_released));
    await request('PUT', W('wholesale-settings'), { holdOverdueDays: null });
  });

  let edited;
  await t.test('an order is edited before it goes; what was sent never changes', async () => {
    edited = await staff.cashier('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(),
      lines: [{ skuId: noodles.id, unit: 'case', quantity: '3' }, { skuId: biscuits.id, quantity: '24' }] }, 201);
    const lines = (await request('GET', W(`sales-orders/${edited.id}`))).lines;
    const n = lines.find((l) => l.sku_id === noodles.id), b = lines.find((l) => l.sku_id === biscuits.id);
    await staff.cashier('PATCH', W(`sales-orders/${edited.id}`), { requestKey: key(), lines: [{ orderLineId: n.id, quantity: '3', unit: 'case' }] }, 400);
    await staff.cashier('PATCH', W(`sales-orders/${edited.id}`), { requestKey: key(), reason: 'no change', lines: [{ orderLineId: n.id, unit: 'case', quantity: '3' }, { orderLineId: b.id, quantity: '24' }] }, 409);
    // 3 cases → 2 cases; biscuits removed; tea… a new line of biscuits by the case.
    const body = { requestKey: key(), reason: 'Shop phoned: 2 cases only', lines: [{ orderLineId: n.id, unit: 'case', quantity: '2' }, { skuId: biscuits.id, unit: 'case', quantity: '1' }] };
    const saved = await staff.cashier('PATCH', W(`sales-orders/${edited.id}`), body);
    const again = await staff.cashier('PATCH', W(`sales-orders/${edited.id}`), body);
    assert.equal(again.total, saved.total);
    const detail = await request('GET', W(`sales-orders/${edited.id}`));
    assert.equal(detail.edits.length, 1);
    const live = detail.lines.filter((l) => Number(l.remaining) > 0);
    assert.deepEqual(live.map((l) => [l.sku_id, l.quantity]).sort(), [[noodles.id, '192.000'], [biscuits.id, '48.000']].sort());
    assert.ok(detail.lines.filter((l) => l.removed_by_edit).length === 2);
    // 2 cases at the ₹1,100 case slab + 48 × ₹10 = 2,680 + 18 % = 3,162.40
    assert.equal(saved.total, '3162.40');
    // Send part, then nothing that was sent can be edited away.
    const live2 = detail.lines.find((l) => l.sku_id === noodles.id && Number(l.remaining) > 0);
    await request('POST', W(`sales-orders/${edited.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: live2.id, unit: 'case', quantity: '1' }] }, 201);
    const left = await staff.cashier('PATCH', W(`sales-orders/${edited.id}`), { requestKey: key(), reason: 'Biscuits not wanted', lines: [{ orderLineId: live2.id, quantity: '96' }] });
    assert.equal(left.status, 'part_dispatched');
    await staff.cashier('PATCH', W(`sales-orders/${edited.id}`), { requestKey: key(), reason: 'Nothing', lines: [] }, 409);
    // Close just the odd remainder of one line.
    await staff.cashier('POST', W(`sales-orders/${edited.id}/lines/${live2.id}/close`), { reason: 'x' }, 403);
    const closed = await staff.manager('POST', W(`sales-orders/${edited.id}/lines/${live2.id}/close`), { reason: 'Last case damaged' });
    assert.equal(closed.status, 'closed');
    await staff.cashier('PATCH', W(`sales-orders/${edited.id}`), { requestKey: key(), reason: 'too late', lines: [{ skuId: biscuits.id, quantity: '1' }] }, 409);
  });

  let run;
  await t.test('the dispatch board, a combined pick list and a delivery run with one load sheet', async () => {
    const a = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: noodles.id, unit: 'case', quantity: '4' }] }, 201);
    const b = await request('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: key(), lines: [{ skuId: noodles.id, unit: 'case', quantity: '2' }, { skuId: biscuits.id, quantity: '12' }] }, 201);
    const board = await request('GET', W(`dispatch-board?route=${route.id}`));
    assert.ok(board.some((o) => o.id === a.id && o.lines_ready === 1));
    const pick = await request('GET', W(`pick-list?orders=${a.id},${b.id}`));
    const noodleItem = pick.items.find((i) => i.sku_id === noodles.id);
    assert.equal(Number(noodleItem.wanted), 576);
    assert.equal(noodleItem.pack_unit, 'case');
    assert.equal(noodleItem.take[0].lot_code, 'N-EARLY', 'earliest expiry first');
    await request('GET', W('pick-list?orders=999999'), undefined, 409);
    await staff.cashier('POST', W('delivery-runs'), { requestKey: key(), orderIds: [a.id] }, 403);
    // A third order that cannot go (nothing of it in stock).
    const empty = await request('POST', W('catalog'), { name: 'Rare spice', code: 'RARE', kind: 'goods', unit: 'each', tracking: 'quantity', price: '50', taxRate: '5' }, 201);
    const c = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: empty.id, quantity: '2' }] }, 201);
    const body = { requestKey: key(), orderIds: [a.id, b.id, c.id], vehicleNo: 'mh12 ab 4455', driverName: 'Santosh', helperName: 'Raju', routeId: route.id };
    run = await staff.stock_keeper('POST', W('delivery-runs'), body, 201);
    assert.equal(run.sent.length, 2);
    assert.equal(run.skipped.length, 1);
    assert.match(run.skipped[0].reason, /nothing in stock/);
    assert.equal(run.vehicle_no, 'MH12 AB 4455');
    assert.equal(run.invoices.length, 2);
    assert.ok(run.items.some((i) => i.sku_id === noodles.id && Number(i.quantity) === 576));
    const repeat = await staff.stock_keeper('POST', W('delivery-runs'), body, 201);
    assert.equal(repeat.id, run.id);
    const dispatches = await request('GET', W(`dispatches?run=${run.id}`));
    assert.equal(dispatches.total, 2);
    assert.ok(dispatches.items.every((d) => d.delivery_status === 'out_for_delivery' && d.driver_name === 'Santosh'));
    const summary = await request('GET', W('wholesale-summary'));
    assert.ok(summary.out_for_delivery.count >= 2);
    assert.equal(summary.beats_today[0].name, 'Hadapsar market');
  });

  await t.test('transport and e-way bill; delivered, part returned, refused', async () => {
    const dispatches = (await request('GET', W(`dispatches?run=${run.id}`))).items;
    const [first, second] = dispatches;
    await request('PATCH', W(`dispatches/${first.id}/transport`), { ewayBillNo: '1234' }, 400);
    await request('PATCH', W(`dispatches/${first.id}/transport`), { ewayBillNo: '123456789012' }, 400);
    await request('PATCH', W(`dispatches/${first.id}/transport`), { transporterId: 'BAD' }, 400);
    const t1 = await staff.stock_keeper('PATCH', W(`dispatches/${first.id}/transport`), { ewayBillNo: '1234 5678 9012', ewayBillDate: day(0), vehicleNo: 'MH12AB4455',
      transporterName: 'Own vehicle', distanceKm: 18 });
    assert.equal(t1.eway_bill_no, '123456789012');
    const invoice = await request('GET', W(`documents/${first.document_id}`));
    assert.equal(invoice.wholesale.eway_bill_no, '123456789012');
    assert.equal(invoice.wholesale.distance_km, 18);
    // Delivered in full.
    const done = await staff.stock_keeper('POST', W(`dispatches/${first.id}/delivery`), { status: 'delivered', receivedBy: 'Shop owner' });
    assert.equal(done.delivery_status, 'delivered');
    await staff.stock_keeper('POST', W(`dispatches/${first.id}/delivery`), { status: 'delivered' }, 409);
    // Part returned: needs sales.refund (the stock keeper has none) and a reason.
    const lines = (await request('GET', W(`documents/${second.document_id}`))).lines;
    await staff.stock_keeper('POST', W(`dispatches/${second.id}/delivery`), { status: 'part_returned', note: 'x', requestKey: key(), returns: [{ documentLineId: lines[0].id, quantity: '1' }] }, 403);
    await staff.manager('POST', W(`dispatches/${second.id}/delivery`), { status: 'part_returned', requestKey: key(), returns: [{ documentLineId: lines[0].id, quantity: '1' }] }, 400);
    const stockBefore = await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [ws.id, lines[0].sku_id]);
    const back = await staff.manager('POST', W(`dispatches/${second.id}/delivery`), { status: 'part_returned', note: 'One packet torn', requestKey: key(),
      returns: [{ documentLineId: lines[0].id, quantity: '1' }] });
    assert.equal(back.delivery_status, 'part_returned');
    assert.ok(back.return.return_no);
    const stockAfter = await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [ws.id, lines[0].sku_id]);
    assert.equal(Number(stockAfter.q), Number(stockBefore.q) + 1);
    const order = await request('GET', W(`sales-orders/${second.order_id}`));
    assert.equal(order.dispatches[0].return_no, back.return.return_no);
    // A dispatch with a transport on the dispatch itself.
    const o = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: biscuits.id, quantity: '6' }] }, 201);
    const line = (await request('GET', W(`sales-orders/${o.id}`))).lines[0];
    const sent = await request('POST', W(`sales-orders/${o.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: line.id, quantity: '6' }], driverName: 'Anil', lrNo: 'LR-55' }, 201);
    assert.equal(sent.dispatch.driver_name, 'Anil');
    assert.equal(sent.dispatch.delivery_status, 'out_for_delivery');
    const refused = await staff.manager('POST', W(`dispatches/${sent.dispatch.id}/delivery`), { status: 'refused', note: 'Shop closed', requestKey: key() });
    assert.equal(refused.delivery_status, 'refused');
    const doc = await request('GET', W(`documents/${sent.document.id}`));
    assert.equal(doc.returns.length, 1);
    assert.equal(paise(doc.returns[0].total), paise(doc.total));
  });

  await t.test('the sales list knows the order, salesperson, route and delivery; walk-in bills apart', async () => {
    const fromOrders = await request('GET', W('documents?kind=sale&source=order'));
    assert.ok(fromOrders.items.length > 0 && fromOrders.items.every((d) => d.order_no));
    const counter = await request('GET', W('documents?kind=sale&source=counter'));
    assert.ok(counter.items.every((d) => !d.order_no));
    const bySalesperson = await request('GET', W(`documents?kind=sale&salesperson=${salesperson.id}`));
    assert.ok(bySalesperson.items.every((d) => d.salesperson_name === 'Ravi Kumar'));
    const unpaid = await request('GET', W('documents?kind=sale&unpaid=true'));
    assert.ok(unpaid.items.every((d) => d.unpaid));
    const out = await request('GET', W('documents?kind=sale&delivery=out_for_delivery'));
    assert.ok(out.items.every((d) => d.delivery_status === 'out_for_delivery'));
  });

  await t.test('trade details; a beat from the customer form; place of supply from the state', async () => {
    await staff.viewer('PUT', W(`wholesale-customers/${hotel.id}`), { tradeType: 'walk_in' }, 403);
    const saved = await request('PUT', W(`wholesale-customers/${hotel.id}`), { tradeType: 'trade', stateCode: '29', pan: 'abcde1234f', beatId: null });
    assert.equal(saved.pan, 'ABCDE1234F');
    assert.equal(saved.beat, null);
    await request('PUT', W(`wholesale-customers/${hotel.id}`), { stateCode: '29', beatId: beat.id });
    const o = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: biscuits.id, quantity: '2' }] }, 201);
    const line = (await request('GET', W(`sales-orders/${o.id}`))).lines[0];
    const sent = await request('POST', W(`sales-orders/${o.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: line.id, quantity: '2' }] }, 201);
    assert.equal((await request('GET', W(`documents/${sent.document.id}`))).place_of_supply, '29');
    const walkIn = await request('POST', W('contacts'), { kind: 'customer', name: 'Counter customer' }, 201);
    await request('PUT', W(`wholesale-customers/${walkIn.id}`), { tradeType: 'walk_in' });
    const list = await request('GET', W('customer-beats?trade=trade&limit=100'));
    assert.ok(!list.items.some((c) => c.id === walkIn.id));
    await request('GET', W(`wholesale-customers/${supplier.id}`), undefined, 404);
  });

  await t.test('a salesperson linked to a login with a monthly target; the beat sheet', async () => {
    const stranger = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, 'Not a member', 'wsp-stranger@test.invalid', hash]);
    await request('PATCH', W(`salespeople/${salesperson.id}`), { name: 'Ravi Kumar', userId: stranger.id }, 404);
    const linked = await request('PATCH', W(`salespeople/${salesperson.id}`), { name: 'Ravi Kumar', phone: '98450 12345', userId: people.cashier.id, monthlyTarget: '500000' });
    assert.equal(linked.user_id, people.cashier.id);
    // An older client sending only the name keeps the link and target.
    const kept = await request('PATCH', W(`salespeople/${salesperson.id}`), { name: 'Ravi Kumar', phone: '98450 12345', active: true });
    assert.equal(kept.user_id, people.cashier.id);
    assert.equal(kept.monthly_target, '500000.00');
    const list = await request('GET', W('salespeople'));
    const ravi = list.items.find((s) => s.id === salesperson.id);
    assert.equal(ravi.user_name, 'WSP cashier');
    assert.ok(Number(ravi.invoiced_this_month) > 0);
    assert.ok(Number(ravi.collected_this_month) > 0);
    const logins = await request('GET', W('salesperson-logins'));
    assert.equal(logins.find((u) => u.id === people.cashier.id).linked_to, 'Ravi Kumar');
    const sheet = await request('GET', W(`salespeople/${salesperson.id}/beat-sheet`));
    assert.ok(sheet.shops.length >= 3);
    assert.ok(sheet.shops.every((s) => s.beat_name === 'Hadapsar market'));
    assert.ok('balance' in sheet.shops[0]);
  });

  await t.test('the customer summary shows the last order to repeat it', async () => {
    const summary = await request('GET', W(`sales-orders/customer-summary/${kirana.id}`));
    assert.ok(summary.last_order.lines.length >= 1);
    assert.ok(summary.account.balance !== undefined);
    const viewerSummary = await staff.stock_keeper('GET', W(`sales-orders/customer-summary/${kirana.id}`));
    assert.equal(viewerSummary.account, null, 'what they owe needs receivables.view');
  });

  await t.test('claims against a supplier move open → submitted → settled with a credit note', async () => {
    await request('POST', W('claims'), { supplierId: kirana.id, kind: 'damage', amount: '100' }, 404);
    await staff.viewer('POST', W('claims'), { supplierId: supplier.id, kind: 'damage', amount: '100' }, 403);
    const claim = await request('POST', W('claims'), { supplierId: supplier.id, kind: 'expiry', amount: '1250.50', notes: 'Expired noodles' }, 201);
    await request('PATCH', W(`claims/${claim.id}`), { status: 'settled', settledAmount: '1200' }, 400);
    await request('PATCH', W(`claims/${claim.id}`), { status: 'submitted' });
    const settled = await request('PATCH', W(`claims/${claim.id}`), { status: 'settled', settledAmount: '1200', creditNoteNo: 'CN-77' });
    assert.equal(settled.status, 'settled');
    await request('PATCH', W(`claims/${claim.id}`), { status: 'rejected' }, 409);
    const list = await request('GET', W('claims?status=settled'));
    assert.equal(list.items[0].supplier_name, 'Sunrise Foods Depot (fictional)');
  });

  await t.test('another business sees none of it', async () => {
    await other('GET', O(`collections/${cheque.id}`), undefined, 404);
    await other('POST', O(`collections/${cheque.id}/cheque`), { action: 'deposit' }, 404);
    await other('GET', O(`delivery-runs/${run.id}`), undefined, 404);
    await other('PATCH', O(`sales-orders/${edited.id}`), { requestKey: key(), reason: 'x', lines: [] }, 404);
    await other('PUT', O(`wholesale-customers/${kirana.id}`), {}, 404);
    await other('GET', O(`pick-list?orders=${schemeOrder.id}`), undefined, 409);
    await call('GET', W('wholesale-summary'), undefined, otherToken).then((r) => assert.equal(r.status, 404));
    // Every stock lot still reconciles with its movements.
    const bad = await rows(`SELECT l.id FROM business_stock_lots l WHERE l.business_id=$1 AND l.quantity <> COALESCE((SELECT sum(quantity) FROM business_stock_movements m WHERE m.business_id=l.business_id AND m.lot_id=l.id),0)`, [ws.id]);
    assert.deepEqual(bad, []);
  });
});
