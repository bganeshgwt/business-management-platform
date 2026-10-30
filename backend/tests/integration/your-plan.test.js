const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { signIn } = require('./helpers/signIn');
const { addDays } = require('./helpers/dates');

// Your plan, as the screens read it: every business on a person's list of
// businesses carries its plan's state and dates (GET /businesses), the same
// as the business's own context and, for a restaurant, its admin's profile,
// for the owner and for staff alike and never with a price; and the owner's
// Your plan answers with what its page shows (the choice and its prices, the
// open order with its GST, how to pay it and whom to ask).
test('your plan: the list of businesses carries each one\'s plan state, as its context does, never a price', { timeout: 600000 }, async (t) => {
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
  const password = `YourPlan-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const platformRow = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id', ['Platform Admin', 'platform@yourplan.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformRow.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => (await signIn(base, email, password))?.token || null;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return expected >= 400 ? result.body : result.body.data;
  };
  const platform = as(await login('platform@yourplan.invalid'));

  // The shop, its owner and a cashier the owner makes in Staff & access.
  const shop = (await platform('POST', '/users/platform/businesses', { businessType: 'grocery', name: 'Plan Kirana', code: 'PLAN-KIRANA', stateCode: '29',
    owner: { email: 'owner@plankirana.invalid', name: 'Meena R', password } }, 201)).business;
  const owner = as(await login('owner@plankirana.invalid'));
  const B = (suffix) => `/businesses/${shop.id}${suffix}`;
  const cashierRole = (await owner('GET', B('/roles'))).items.find((role) => role.template_code === 'cashier');
  await owner('POST', B('/staff-accounts'), { name: 'Ravi K', email: 'cashier@plankirana.invalid', password, roleId: cashierRole.id }, 201);
  const cashier = as(await login('cashier@plankirana.invalid'));
  const today = (await one('SELECT business_local_today($1)::text AS d', [shop.id])).d;

  // The plan as the list shows it to someone, and as the business's context does.
  const listed = async (who) => (await who('GET', '/businesses')).businesses.find((row) => Number(row.id) === Number(shop.id)).plan;
  const shown = async (expected) => {
    assert.deepEqual(await listed(owner), expected);
    assert.deepEqual(await listed(cashier), expected);
    assert.deepEqual((await owner('GET', B('/context'))).plan, expected);
  };
  // Its time set aside, then the time a case needs (the paid-plans tests' way).
  const setAside = (id) => pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [id]);
  const paidUntil = async (id, endsIn) => {
    await setAside(id);
    const made = await one(`INSERT INTO platform_orders(business_id,kind,plan_code,billing_period,starts_on,ends_on,valid_until,buyer,supplier_state_code,place_of_supply_code,
        gst_rate,taxable_amount,igst_amount,total_amount,status,paid_at)
      SELECT b.id,'subscription',b.business_type || '_basic','month',business_local_today(b.id)-30,business_local_today(b.id)+$2::int,business_local_today(b.id),
        '{"name":"Test"}','22','29',18,100,18,118,'paid',now() FROM businesses b WHERE b.id=$1 RETURNING id`, [id, endsIn]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,plan_code,everything,order_id)
      SELECT business_id,'paid',starts_on,ends_on,plan_code,FALSE,id FROM platform_orders WHERE id=$1`, [made.id]);
  };

  await t.test('a new business is on its free trial: its last day and the days left, for its owner and its staff', async () => {
    const expected = { state: 'trial', accessEndsOn: addDays(today, 13), trialEndsOn: addDays(today, 13), graceEndsOn: null, daysLeft: 14 };
    await shown(expected);
    // Never a price, an order or a payment detail.
    const row = (await cashier('GET', '/businesses')).businesses.find((b) => Number(b.id) === Number(shop.id));
    assert.deepEqual(Object.keys(row.plan).sort(), ['accessEndsOn', 'daysLeft', 'graceEndsOn', 'state', 'trialEndsOn']);
  });

  await t.test('paid time, its grace, the end, and given time with no end', async () => {
    await paidUntil(shop.id, 20);
    await shown({ state: 'paid', accessEndsOn: addDays(today, 20), trialEndsOn: null, graceEndsOn: addDays(today, 27), daysLeft: 21 });
    await paidUntil(shop.id, -2);
    await shown({ state: 'grace', accessEndsOn: addDays(today, -2), trialEndsOn: null, graceEndsOn: addDays(today, 5), daysLeft: 6 });
    await setAside(shop.id);
    await pool.query("INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything) VALUES($1,'trial',$2,$3,TRUE)",
      [shop.id, addDays(today, -30), addDays(today, -17)]);
    await shown({ state: 'ended', accessEndsOn: addDays(today, -17), trialEndsOn: addDays(today, -17), graceEndsOn: null, daysLeft: null });
    await setAside(shop.id);
    await pool.query("INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything,reason) VALUES($1,'given',$2,NULL,TRUE,'Pilot customer')",
      [shop.id, today]);
    await shown({ state: 'given', accessEndsOn: null, trialEndsOn: null, graceEndsOn: null, daysLeft: null });
  });

  await t.test("a restaurant's business on its admin's list carries the plan its profile carries", async () => {
    await platform('POST', '/users/platform/restaurants', { name: 'Plan Diner', code: 'PLANDINER', admin: { name: 'Owner', email: 'owner@plandiner.invalid', password } }, 201);
    const diner = as(await login('owner@plandiner.invalid'));
    await diner('POST', '/businesses/link-restaurant', {});
    const { plan: profile } = await diner('GET', '/auth/me');
    const row = (await diner('GET', '/businesses')).businesses.find((b) => b.business_type === 'restaurant');
    const { businessId, ...rest } = profile;
    assert.equal(Number(businessId), Number(row.id));
    assert.equal(row.plan.state, 'trial');
    assert.deepEqual(row.plan, rest);
  });

  await t.test("the owner's Your plan answers with what its page shows, and nobody else's", async () => {
    const fresh = (await platform('POST', '/users/platform/businesses', { businessType: 'general_retail', name: 'Plan Gifts', code: 'PLAN-GIFTS',
      owner: { email: 'owner@plankirana.invalid' } }, 201)).business;
    const P = (suffix) => `/businesses/${fresh.id}/plan${suffix}`;
    await pool.query(`UPDATE platform_settings SET legal_name='Acme Soft Private Limited',address_line1='12 MG Road',city='Raipur',postal_code='492001',
      upi_id='acme@okaxis',upi_payee_name='Acme Soft',bank_name='HDFC Bank',bank_account_name='Acme Soft Private Limited',bank_account_number='50200012345678',
      bank_ifsc='HDFC0001234' WHERE id=1`);
    const view = await owner('GET', P(''));
    assert.equal(view.plan.state, 'trial');
    assert.equal(view.plan.everything, true);
    assert.deepEqual(view.selection.addons, []);
    assert.equal(view.selection.billingPeriod, 'year');
    const basic = view.catalogue.plans.find((item) => item.code === view.selection.planCode);
    assert.deepEqual([basic.monthly, basic.yearly], ['499.00', '4999.00']);
    const loyalty = view.catalogue.addons.find((item) => item.code === 'loyalty');
    assert.deepEqual([loyalty.soldAs, loyalty.yearly, loyalty.available], ['module', '1999.00', true]);
    assert.equal(view.openOrder, null);
    assert.equal(view.payTo.upiLink, null);
    assert.equal(view.gstRate, '18.00');
    // The state is asked for when the business has none; the order then splits its GST by it.
    await owner('PUT', P('/selection'), { planCode: basic.code, billingPeriod: 'year', addons: ['loyalty'] });
    const refused = await owner('POST', P('/orders'), { kind: 'subscription' }, 409);
    assert.equal(refused.data.reason, 'state_required');
    const order = await owner('POST', P('/orders'), { kind: 'subscription', stateCode: '29' }, 201);
    assert.deepEqual([order.taxable, order.igst, order.total, order.placeOfSupply], ['6998.00', '1259.64', '8257.64', 'Karnataka']);
    const opened = await owner('GET', P(''));
    assert.equal(opened.openOrder.id, order.id);
    assert.equal(opened.payTo.upiLink, `upi://pay?pa=acme%40okaxis&pn=Acme%20Soft&am=8257.64&cu=INR&tn=Order%20${order.id}`);
    assert.deepEqual([opened.payTo.bankIfsc, opened.payTo.bankAccountNumber], ['HDFC0001234', '50200012345678']);
    // Staff are refused, prices and all.
    const memberRole = (await owner('GET', `/businesses/${fresh.id}/roles`)).items.find((role) => role.template_code === 'cashier');
    const cashierId = (await one("SELECT id FROM users WHERE email='cashier@plankirana.invalid'")).id;
    await owner('POST', `/businesses/${fresh.id}/members`, { userId: cashierId, roleId: memberRole.id }, 201);
    const refusedStaff = await cashier('GET', P(''), undefined, 403);
    assert.equal(refusedStaff.message, "Your plan is the owner's to see and change. Ask the owner.");
  });
});
