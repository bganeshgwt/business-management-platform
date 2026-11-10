const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { rewriteHistory } = require('./helpers/history');
const { signIn } = require('./helpers/signIn');
const { loginProblem, assertLoginFitForLive, createAppLogin, grantAppLogin, scramVerifier } = require('../../src/utils/databaseLogin');

// The database's own defences, with the API signed in as a live server's is:
// its own login (npm run db:app-login), which reads and writes rows and
// nothing more, while the test's login owns the tables (it ran the
// migrations). Then the records kept for good (migration 1791990000070): a
// business's posted bills and their lines, payments, stock movements and the
// activity logs are never changed or deleted, a restaurant's orders and bills
// never deleted, and only the tables' owner may rewrite history, after
// asking in its own session. And the schema's own rules: a primary key on
// every table, no index twice. Runs on its own throwaway database, with a login
// made for this run and dropped after it.
test('database logins and the records kept for good', { timeout: 300000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const suffix = crypto.randomBytes(10).toString('hex');
  const database = `rmp_test_${suffix}`;
  const appName = `rmp_app_${suffix}`;
  const appPassword = crypto.randomBytes(24).toString('base64url');
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, ownerPool, server, created = false, roleMade = false;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (ownerPool) await ownerPool.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`);
      if (roleMade && /^rmp_app_[a-f0-9]{20}$/.test(appName)) await admin.query(`DROP ROLE IF EXISTS "${appName}"`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });

  // The owner makes the API's login, as npm run db:app-login does.
  ownerPool = new Pool({ ...connection, database, max: 3 });
  const owner = await ownerPool.connect();
  try {
    assert.deepEqual(await createAppLogin(owner, { name: appName, password: appPassword }), { created: true }); roleMade = true;
    await grantAppLogin(owner, { database, name: appName });
    // Made again (a changed password, a server set up twice), it is brought up to date.
    assert.deepEqual(await createAppLogin(owner, { name: appName, password: appPassword }), { created: false });
    await grantAppLogin(owner, { database, name: appName });
  } finally { owner.release(); }

  // From here the API signs in as its own login.
  process.env.DB_NAME = database;
  process.env.DB_USER = appName;
  process.env.DB_PASSWORD = appPassword;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const asOwner = async (sql, values = []) => (await ownerPool.query(sql, values)).rows[0];
  const password = `Logins-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', ['logins-owner']);
  await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
  const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, 'Logins Owner', 'logins-owner@test.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const token = (await signIn(base, 'logins-owner@test.invalid', password)).token;
  async function request(method, route, body, expected = 200) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const answer = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(answer)}`);
    return answer.data ?? answer;
  }
  const key = () => crypto.randomUUID();
  const refused = (promise, pattern) => assert.rejects(promise, (error) => { assert.match(error.message, pattern); return true; });
  const noRight = (sql) => assert.rejects(pool.query(sql), (error) => { assert.equal(error.code, '42501', `${sql}: ${error.message}`); return true; });

  await t.test('the API\'s own login reads and writes rows, and can do nothing more', async () => {
    assert.equal(await loginProblem(pool), null);
    await assertLoginFitForLive(pool, { live: true });
    // The owner's login is no login for a live server.
    assert.match(await loginProblem(ownerPool), /superuser|owns the tables/);
    await assert.rejects(assertLoginFitForLive(ownerPool, { live: true }), /Refusing to run a live server: .*npm run db:app-login/);
    await assertLoginFitForLive(ownerPool, { live: false });
    // No table is made, changed, emptied or dropped, no rule switched off.
    await noRight('CREATE TABLE logins_probe (id INT)');
    await noRight('DROP TABLE business_documents');
    await noRight('ALTER TABLE business_documents DISABLE TRIGGER USER');
    await noRight('TRUNCATE business_audit');
    await noRight("SET session_replication_role = 'replica'");
    await noRight('CREATE FUNCTION logins_probe() RETURNS INT LANGUAGE sql AS $$ SELECT 1 $$');
    // The migrations' list is read, never written.
    assert.ok(Number((await one('SELECT count(*) AS n FROM pgmigrations')).n) > 100);
    await noRight("INSERT INTO pgmigrations(name, run_on) VALUES ('logins_probe', now())");
    await noRight('DELETE FROM pgmigrations');
    // A table a later migration adds is the API's to use at once.
    await ownerPool.query('CREATE TABLE logins_later (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note TEXT)');
    try {
      assert.equal((await one("INSERT INTO logins_later(note) VALUES ('rows only') RETURNING note")).note, 'rows only');
    } finally { await ownerPool.query('DROP TABLE logins_later'); }
    // One login is never both: the owner's name, or a weak password, is refused.
    const owner = await ownerPool.connect();
    try {
      await assert.rejects(createAppLogin(owner, { name: connection.user, password: appPassword }), /superuser|owns the tables/);
    } finally { owner.release(); }
    assert.throws(() => scramVerifier('short'), /at least 12 keyboard characters/);
    assert.throws(() => scramVerifier('pässwörd-long-enough'), /keyboard characters/);
    assert.match(scramVerifier(appPassword), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });

  let shop, sale, saleLine, payment;
  await t.test('a business works as before on its own login', async () => {
    [shop] = await createBusinesses(request, 'LOGINS', ['grocery']);
    const B = (route) => `/businesses/${shop.id}/${route}`;
    const location = (await request('GET', B('locations'))).items[0];
    const supplier = await request('POST', B('contacts'), { kind: 'supplier', name: 'Agarwal Traders' }, 201);
    const rice = await request('POST', B('catalog'), { name: 'Sona Masoori rice', code: 'RICE', kind: 'goods', unit: 'kg', tracking: 'batch', price: '60', taxRate: '5' }, 201);
    await request('POST', B('documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(),
      lines: [{ skuId: rice.id, quantity: '50', unitPrice: '42', lotCode: 'R-01', expiresOn: '2099-01-01' }] }, 201);
    sale = await request('POST', B('documents'), { kind: 'sale', locationId: location.id, requestKey: key(),
      lines: [{ skuId: rice.id, quantity: '2', lotCode: 'R-01' }], payment: { amount: 'full', method: 'cash' } }, 201);
    saleLine = await one('SELECT * FROM business_document_lines WHERE business_id=$1 AND document_id=$2', [shop.id, sale.id]);
    payment = await one('SELECT * FROM business_payments WHERE business_id=$1 AND document_id=$2', [shop.id, sale.id]);
    assert.ok(saleLine && payment, 'the sale was posted with its line and payment');
    assert.ok(await one('SELECT id FROM business_stock_movements WHERE business_id=$1 AND document_id=$2', [shop.id, sale.id]));
    assert.equal((await request('GET', B(`documents/${sale.id}`))).document_no, sale.document_no, 'the bill reads back');
  });

  await t.test('Give a login: a login and its access are saved together, or neither is', async () => {
    const B = (route) => `/businesses/${shop.id}/${route}`;
    const role = await one("SELECT id FROM business_roles WHERE business_id=$1 AND template_code='cashier'", [shop.id]);
    const body = { name: 'Ravi Kumar', email: 'ravi.logins@test.invalid', password: `Cashier-${crypto.randomBytes(6).toString('hex')}` };
    // A role that is not the business's: no login is left behind, and no log entry to take back.
    await request('POST', B('staff-accounts'), { ...body, roleId: 999999999 }, 404);
    assert.equal((await one('SELECT count(*)::int AS n FROM users WHERE lower(email)=$1', [body.email])).n, 0);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action='staff_account.created'", [shop.id])).n, 0);
    const member = await request('POST', B('staff-accounts'), { ...body, roleId: role.id }, 201);
    assert.equal(member.email, body.email);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action='staff_account.created'", [shop.id])).n, 1);
    assert.ok(await one('SELECT 1 FROM business_memberships WHERE business_id=$1 AND user_id=$2 AND role_id=$3', [shop.id, member.user_id, role.id]));
  });

  await t.test('a business\'s posted bills, payments, stock and activity log are kept as saved', async () => {
    const id = [shop.id, sale.id];
    await refused(pool.query('DELETE FROM business_documents WHERE business_id=$1 AND id=$2', id), /posted bill, invoice or purchase is kept for good and is never deleted/);
    await refused(pool.query('UPDATE business_documents SET total=total+1 WHERE business_id=$1 AND id=$2', id), /posted bill, invoice or purchase is kept as it was saved and never changes/);
    await refused(pool.query("UPDATE business_documents SET created_at=now()-interval '1 year' WHERE business_id=$1 AND id=$2", id), /never changes/);
    // A line takes its stock cost and batch (posting and a later delivery fill them), nothing else.
    assert.equal((await pool.query('UPDATE business_document_lines SET stock_unit_cost=$3, lot_code=$4 WHERE business_id=$1 AND id=$2',
      [shop.id, saleLine.id, saleLine.stock_unit_cost, saleLine.lot_code])).rowCount, 1);
    await refused(pool.query('UPDATE business_document_lines SET quantity=quantity+1 WHERE business_id=$1 AND id=$2', [shop.id, saleLine.id]), /line of a posted bill is kept as it was saved/);
    await refused(pool.query('DELETE FROM business_document_lines WHERE business_id=$1 AND id=$2', [shop.id, saleLine.id]), /line of a posted bill is kept for good/);
    await refused(pool.query('UPDATE business_payments SET amount=amount+1 WHERE business_id=$1 AND id=$2', [shop.id, payment.id]), /payment is kept as it was saved/);
    await refused(pool.query('DELETE FROM business_payments WHERE business_id=$1 AND id=$2', [shop.id, payment.id]), /only a bounced cheque takes back what it paid/);
    await refused(pool.query("UPDATE business_stock_movements SET quantity=0 WHERE business_id=$1 AND document_id=$2", id), /stock movement is kept as it was saved/);
    await refused(pool.query('DELETE FROM business_stock_movements WHERE business_id=$1 AND document_id=$2', id), /stock movement is kept for good/);
    await refused(pool.query("UPDATE business_audit SET details='{}' WHERE business_id=$1", [shop.id]), /entry in the activity log is kept as it was saved/);
    await refused(pool.query('DELETE FROM business_audit WHERE business_id=$1', [shop.id]), /entry in the activity log is kept for good/);
    const entry = await one("INSERT INTO platform_audit(actor_id,action,entity_type,entity_id,details) VALUES($1,'logins.probe','business',$2,'{}') RETURNING id", [person.id, shop.id]);
    await refused(pool.query("UPDATE platform_audit SET action='changed' WHERE id=$1", [entry.id]), /platform's activity log is kept as it was saved/);
    await refused(pool.query('DELETE FROM platform_audit WHERE id=$1', [entry.id]), /platform's activity log is kept for good/);
    // TRUNCATE passes the row rules by, so it is refused on its own, even to the owner.
    await refused(ownerPool.query('TRUNCATE business_audit'), /kept for good and is never deleted/);
    // The bill still reads as posted.
    assert.equal((await one('SELECT total FROM business_documents WHERE business_id=$1 AND id=$2', id)).total, sale.total);
  });

  await t.test('only the tables\' owner rewrites history, and only when its session asks', async () => {
    const back = "UPDATE business_documents SET created_at=created_at-interval '3 days' WHERE business_id=$1 AND id=$2";
    // The API's login asking is still refused: it does not own the tables.
    await refused(rewriteHistory(pool, back, [shop.id, sale.id]), /never changes/);
    // The owner without asking is refused too.
    await refused(ownerPool.query(back, [shop.id, sale.id]), /never changes/);
    const before = await one('SELECT created_at FROM business_documents WHERE business_id=$1 AND id=$2', [shop.id, sale.id]);
    assert.equal((await rewriteHistory(ownerPool, back, [shop.id, sale.id])).rowCount, 1);
    const after = await one('SELECT created_at FROM business_documents WHERE business_id=$1 AND id=$2', [shop.id, sale.id]);
    assert.equal(before.created_at.getTime() - after.created_at.getTime(), 3 * 24 * 3600 * 1000);
    // The permission lasts for that transaction alone.
    await refused(ownerPool.query(back, [shop.id, sale.id]), /never changes/);
  });

  await t.test('the schema: every table has a primary key, and no index repeats another', async () => {
    const keyless = await ownerPool.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p') ORDER BY 1`);
    assert.deepEqual(keyless.rows.map((r) => r.relname), []);
    const repeated = await ownerPool.query(`SELECT i.indrelid::regclass::text AS tbl, array_agg(i.indexrelid::regclass::text ORDER BY 1) AS names
      FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace
      GROUP BY i.indrelid, i.indkey::text, i.indclass::text, COALESCE(i.indexprs::text,''), COALESCE(i.indpred::text,'') HAVING count(*) > 1`);
    assert.deepEqual(repeated.rows, []);
  });

  await t.test('a restaurant\'s orders and bills are never deleted, nor a restaurant that has taken one', async () => {
    const empty = await asOwner("INSERT INTO restaurants(name,code) VALUES('Closed before opening','logins-empty') RETURNING id");
    await ownerPool.query('DELETE FROM restaurants WHERE id=$1', [empty.id]);
    const order = await one("INSERT INTO orders(restaurant_id,order_number,order_type) VALUES($1,'LOGINS-1','takeaway') RETURNING id", [restaurant.id]);
    await refused(pool.query('DELETE FROM orders WHERE id=$1', [order.id]), /An order is kept for good and is never deleted/);
    // Orders change as they are served: only deleting is refused.
    assert.equal((await pool.query("UPDATE orders SET notes='Window table' WHERE id=$1", [order.id])).rowCount, 1);
    // Deleting the restaurant would have taken every order and bill with it.
    await refused(ownerPool.query('DELETE FROM restaurants WHERE id=$1', [restaurant.id]), /Restaurant logins-owner has taken orders, so it is never deleted: set it inactive instead/);
    await refused(ownerPool.query('TRUNCATE orders CASCADE'), /is kept for good and is never deleted/);
    for (const table of ['bills', 'bill_items', 'payments', 'refunds', 'credit_notes', 'credit_note_items', 'order_items', 'cash_movements', 'goods_receipts', 'supplier_payments', 'purchase_returns']) {
      const guard = await asOwner("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype & 8 = 8", [table, `${table}_kept`]);
      assert.equal(guard.n, 1, `${table} refuses deletes`);
    }
  });
});
