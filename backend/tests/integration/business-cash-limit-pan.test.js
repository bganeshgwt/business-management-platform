const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');

// Two Income-tax rules at the counter of every business. Cash of ₹2,00,000 or
// more cannot be taken for one bill or from one customer in a day (Income-tax
// Act 2025, section 186): the database refuses the cash payment or collection
// receipt that would reach it, whichever screen sends it, while UPI, card,
// bank and cheque are not limited. A sale over ₹2,00,000 records the buyer's
// PAN (typed on the bill, saved with the customer, or read from the
// customer's GSTIN), or that a Form 97 declaration was taken. Runs on its own
// throwaway database with every migration applied.
test('cash limit and PAN on large bills', { timeout: 300000 }, async (t) => {
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
  const password = `Cash-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Cash limit test','CASHTEST') RETURNING id");
  await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
  const ownerUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, 'Cash owner', 'cash-owner@test.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [ownerUser.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const token = await login('cash-owner@test.invalid');
  async function request(method, route, body, expected = 200) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const json = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(json)}`);
    return json.data ?? json;
  }
  const key = () => crypto.randomUUID();

  const [grocery, jeweller] = await createBusinesses(request, 'OWNER', ['grocery', 'jewellery']);
  const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
  const J = (suffix) => `/businesses/${jeweller.id}/${suffix}`;
  const groceryLocation = (await request('GET', G('locations'))).items[0];
  const jewelLocation = (await request('GET', J('locations'))).items[0];
  // A kirana's bulk rice at ₹50,000 a bag-load (GST nil, price as charged), and a necklace at ₹2,50,000 before 3% GST.
  const rice = await request('POST', G('catalog'), { kind: 'service', name: 'Rice, bulk order', code: 'RICEBULK', unit: 'service', price: '50000', taxRate: '0' }, 201);
  const necklace = await request('POST', J('catalog'), { kind: 'service', name: 'Gold necklace 22K', code: 'NECK1', unit: 'service', price: '250000', taxRate: '3' }, 201);
  const customer = (biz, name, extra = {}) => request('POST', `/businesses/${biz.id}/contacts`, { kind: 'customer', name, phone: '9845012345', ...extra }, 201);
  const sale = (biz, location, body, expected = 201) => request('POST', `/businesses/${biz.id}/documents`, { kind: 'sale', locationId: location.id, requestKey: key(), ...body }, expected);
  const riceLines = (bags) => [{ skuId: rice.id, quantity: String(bags) }];

  await t.test('a bill over ₹2,00,000 records the buyer\'s PAN, or a Form 97 declaration', async () => {
    const lines = [{ skuId: necklace.id, quantity: '1' }]; // 2,50,000 + 3% = 2,57,500
    const refused = await fetch(base + J('documents'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'sale', locationId: jewelLocation.id, requestKey: key(), lines, payments: [{ method: 'upi', amount: 'full' }] }) });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).message, /PAN/);
    await sale(jeweller, jewelLocation, { lines, buyer: { name: 'Kavitha', pan: 'abc' }, payments: [{ method: 'upi', amount: 'full' }] }, 400);
    const typed = await sale(jeweller, jewelLocation, { lines, buyer: { name: 'Kavitha', pan: 'abcde1234f' }, payments: [{ method: 'upi', amount: 'full' }] });
    assert.equal(Number(typed.total), 257500);
    assert.equal((await one('SELECT buyer_pan FROM business_documents WHERE id=$1', [typed.id])).buyer_pan, 'ABCDE1234F');
    const declared = await sale(jeweller, jewelLocation, { lines, buyer: { name: 'Raju', panDeclaration: true }, payments: [{ method: 'card', amount: 'full' }] });
    const row = await one('SELECT buyer_pan, pan_declaration FROM business_documents WHERE id=$1', [declared.id]);
    assert.deepEqual([row.buyer_pan, row.pan_declaration], [null, true]);
    // Saved with the customer, or read from their GSTIN.
    const withPan = await customer(jeweller, 'Meera', { pan: 'PQRSM6789K' });
    assert.equal(withPan.pan, 'PQRSM6789K');
    const fromContact = await sale(jeweller, jewelLocation, { lines, contactId: withPan.id, payments: [{ method: 'bank', amount: 'full' }] });
    assert.equal((await one('SELECT buyer_pan FROM business_documents WHERE id=$1', [fromContact.id])).buyer_pan, 'PQRSM6789K');
    const company = await customer(jeweller, 'Sri Ganesh Traders');
    await pool.query("UPDATE business_contacts SET gstin='29AAACS1234A1Z5' WHERE id=$1", [company.id]);
    const fromGstin = await sale(jeweller, jewelLocation, { lines, contactId: company.id, payments: [{ method: 'bank', amount: 'full' }] });
    assert.equal((await one('SELECT buyer_pan FROM business_documents WHERE id=$1', [fromGstin.id])).buyer_pan, 'AAACS1234A');
    // Exactly ₹2,00,000 is not over the limit.
    await sale(grocery, groceryLocation, { lines: riceLines(4), payments: [{ method: 'upi', amount: 'full' }] });
  });

  await t.test('cash of ₹2,00,000 or more for one bill is refused; other methods are not limited', async () => {
    const tooMuch = await fetch(base + G('documents'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'sale', locationId: groceryLocation.id, requestKey: key(), lines: riceLines(4), payments: [{ method: 'cash', amount: 'full' }] }) });
    assert.equal(tooMuch.status, 409);
    assert.match((await tooMuch.json()).message, /section 186/);
    // Nothing of the refused bill was kept.
    assert.equal((await one("SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND total=200000 AND kind='sale'", [grocery.id])).n, 1);
    await sale(grocery, groceryLocation, { lines: riceLines(4), payments: [{ method: 'cash', amount: '199999' }, { method: 'upi', amount: '1' }] });
    // A later cash payment on the same bill counts with the first.
    const ramesh = await customer(grocery, 'Ramesh');
    const credit = await sale(grocery, groceryLocation, { lines: riceLines(4), contactId: ramesh.id, payments: [{ method: 'cash', amount: '150000' }] });
    await request('POST', G(`documents/${credit.id}/payments`), { amount: '50000', method: 'cash', requestKey: key() }, 409);
    await request('POST', G(`documents/${credit.id}/payments`), { amount: '50000', method: 'upi', requestKey: key() }, 201);
  });

  await t.test('cash from one customer in a day adds up across bills and collection receipts', async () => {
    const suresh = await customer(grocery, 'Suresh');
    await sale(grocery, groceryLocation, { lines: riceLines(2), contactId: suresh.id, payments: [{ method: 'cash', amount: 'full' }] }); // 1,00,000 cash
    await sale(grocery, groceryLocation, { lines: riceLines(2), contactId: suresh.id, payments: [{ method: 'cash', amount: 'full' }] }, 409); // would be 2,00,000
    await sale(grocery, groceryLocation, { lines: riceLines(2), contactId: suresh.id, payments: [{ method: 'cash', amount: '99999' }, { method: 'upi', amount: '1' }] });
    // A walk-in pays in full; Anil buys on udhaar and pays later at the counter.
    const anil = await customer(grocery, 'Anil', { pan: 'ANILK1234P' });
    await sale(grocery, groceryLocation, { lines: riceLines(5), contactId: anil.id }); // 2,50,000 on udhaar
    await request('POST', G(`udhaar/${anil.id}/collections`), { locationId: groceryLocation.id, amount: '199000', method: 'cash', requestKey: key() }, 201);
    await request('POST', G(`udhaar/${anil.id}/collections`), { locationId: groceryLocation.id, amount: '1000', method: 'cash', requestKey: key() }, 409);
    await request('POST', G(`udhaar/${anil.id}/collections`), { locationId: groceryLocation.id, amount: '51000', method: 'upi', requestKey: key() }, 201);
    // The database holds the rule whatever writes the row.
    const bill = await one("SELECT id FROM business_documents WHERE business_id=$1 AND contact_id=$2 AND kind='sale' ORDER BY id LIMIT 1", [grocery.id, suresh.id]);
    await assert.rejects(pool.query("INSERT INTO business_payments(business_id,document_id,amount,method,request_key,created_by) VALUES($1,$2,150000,'cash',$3,$4)",
      [grocery.id, bill.id, key(), ownerUser.id]), /section 186/);
  });
});
