const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { today } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The database guards on a shop's expenses, daily cash checks and cashier
// shifts. Each refuses a change the services never make, as a check violation
// (SQLSTATE 23514) with a sentence for people and no constraint name: the
// business routes answer exactly that with a 409 carrying the sentence, so a
// code path that ever reached a guard would tell the person why instead of
// failing with a server error. The records are made through the API, the way
// a shop makes them; each guard is then broken directly in SQL.
test('shop guards: expenses, cash checks and cashier shifts refuse changes as check violations', { timeout: 300000 }, async (t) => {
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
  const password = `Guards-${crypto.randomBytes(8).toString('hex')}`;
  const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Guards','GUARDS') RETURNING id");
  await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
  const owner = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
    [restaurant.id, 'Guards owner', 'guards-owner@test.invalid', await bcrypt.hash(password, 4)]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [owner.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const token = (await signIn(base, 'guards-owner@test.invalid', password)).token;
  async function request(method, route, body, expected = 200) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const json = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(json)}`);
    return json.data ?? json;
  }

  // A change a guard refuses: SQLSTATE 23514, the guard's sentence, and no
  // constraint name (a named CHECK answers 400 instead).
  async function refused(sql, values, sentence) {
    await assert.rejects(pool.query(sql, values), (error) => {
      assert.equal(error.code, '23514', `${sql} failed with ${error.code}: ${error.message}`);
      assert.equal(error.message, sentence);
      assert.equal(error.constraint, undefined);
      return true;
    });
  }

  // A kirana with an expense, a reversed one, a cash check, a closed shift and
  // an open one. Every payment is by UPI, so the drawer's expected cash is
  // only its opening cash. The changes the guards allow go through: one
  // reversal, one closing count.
  const [shop] = await createBusinesses(request, 'GUARDS', ['grocery']);
  const S = (suffix) => `/businesses/${shop.id}/${suffix}`;
  const location = (await request('GET', S('locations'))).items[0];
  const day = today();
  const expense = (description) => request('POST', S('expenses'), { spentOn: day, category: 'utilities', description, amount: '120.00',
    method: 'upi', locationId: location.id, requestKey: crypto.randomUUID() }, 201);
  const paid = await expense('Electricity bill');
  const mistake = await expense('Electricity bill entered twice');
  const reversed = await request('POST', S(`expenses/${mistake.id}/reverse`), { reason: 'Entered twice' });
  assert.equal(reversed.void_reason, 'Entered twice');
  const check = await request('POST', S('cash-checks'), { date: day, locationId: location.id, openingCash: '1000', countedCash: '1000',
    requestKey: crypto.randomUUID() }, 201);
  const first = await request('POST', S('shifts'), { locationId: location.id, openingCash: '500' }, 201);
  const closed = await request('POST', S(`shifts/${first.id}/close`), { countedCash: '500' });
  assert.equal(closed.difference, '0.00');
  const open = await request('POST', S('shifts'), { locationId: location.id, openingCash: '800' }, 201);

  await t.test('an expense is never deleted and changes only by one reversal', async () => {
    const reverseOnly = 'Recorded expenses can only be reversed once, with a reason';
    await refused('DELETE FROM business_expenses WHERE id=$1', [paid.id], 'Recorded expenses cannot be deleted');
    await refused('UPDATE business_expenses SET amount=1 WHERE id=$1', [paid.id], reverseOnly);
    await refused("UPDATE business_expenses SET voided_at=now(),voided_by=$2,void_reason='Wrong amount',amount=1 WHERE id=$1", [paid.id, owner.id], reverseOnly);
    await refused("UPDATE business_expenses SET voided_at=now(),voided_by=$2,void_reason='Reversed again' WHERE id=$1", [mistake.id, owner.id], reverseOnly);
  });

  await t.test('a cash check is never changed or deleted', async () => {
    const snapshot = 'Cash checks are permanent snapshots; record a new check to correct one';
    await refused("UPDATE business_cash_checks SET reason='Recounted' WHERE id=$1", [check.id], snapshot);
    await refused('DELETE FROM business_cash_checks WHERE id=$1', [check.id], snapshot);
  });

  await t.test('a shift is never deleted, a closed one never changes, an open one takes only its closing count', async () => {
    await refused('DELETE FROM business_counter_shifts WHERE id=$1', [open.id], 'Cashier shifts are permanent records');
    await refused('UPDATE business_counter_shifts SET counted_cash=450 WHERE id=$1', [first.id], 'A closed shift cannot be changed');
    await refused('UPDATE business_counter_shifts SET opening_cash=0 WHERE id=$1', [open.id], 'Only the closing count of a shift can be recorded');
  });

  // No route edits or deletes a cash check, and the two that write to an
  // expense or a shift lock the row and check it first.
  await t.test('through the API the services check first, so no request reaches a guard', async () => {
    const again = await request('POST', S(`expenses/${mistake.id}/reverse`), { reason: 'Reversed again' });
    assert.equal(again.void_reason, 'Entered twice', 'A second reversal returns the first');
    const refusal = await request('POST', S(`shifts/${first.id}/close`), { countedCash: '500' }, 409);
    assert.equal(refusal.message, 'This shift is already closed');
  });
});
