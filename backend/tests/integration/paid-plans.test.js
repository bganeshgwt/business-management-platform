const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { signIn } = require('./helpers/signIn');

// Paid plans, the foundation: the plan catalogue, each business's access
// periods and add-on grants, its state today (business_plan_state) and what it
// may use (business_entitled_modules, business_active_capabilities, and
// restaurant_features for a restaurant), the trial every new business starts
// with, and the businesses that existed before paid plans, which keep
// everything with given time that has no end.
test('paid plans: catalogue, access periods, state and entitlement, a trial for every new business', { timeout: 300000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, scratch, created = false;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (scratch) await scratch.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  const { runner } = await import('node-pg-migrate');
  const dir = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  scratch = new Client({ ...connection, database });
  await scratch.connect();
  const rows = async (sql, values = []) => (await scratch.query(sql, values)).rows;

  await t.test('businesses made before paid plans keep everything, with given time that has no end', async () => {
    const file = fs.readdirSync(dir).find((name) => name.endsWith('_paid-plans.sql'));
    // This migration's Down half (after those of any newer one): the database as it was before paid plans.
    await migrate({ direction: 'down', count: Number(file.split('_')[0]), timestamp: true });
    const tables = async () => (await rows("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('platform_settings','business_access_periods','platform_invoices')"))[0].n;
    assert.equal(await tables(), 0);
    assert.equal((await rows("SELECT count(*)::int AS n FROM platform_modules WHERE code='captain_app'"))[0].n, 0);
    assert.doesNotMatch((await rows("SELECT prosrc FROM pg_proc WHERE proname='restaurant_features'"))[0].prosrc, /business_active_capabilities/);
    const triggers = async () => (await rows("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('businesses_start_plan','restaurants_business_status')"))[0].n;
    assert.equal(await triggers(), 0);

    // A shop, a restaurant linked to its business, and a restaurant not linked yet.
    const [shop] = await rows("INSERT INTO businesses(name,code,business_type) VALUES('Old Kirana','OLD-KIRANA','grocery') RETURNING id");
    const [linked] = await rows("INSERT INTO restaurants(name,code) VALUES('Old Dhaba','OLDDHABA') RETURNING id");
    await rows('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [linked.id]);
    const [{ id: linkedBusiness }] = await rows('SELECT restaurant_business_id($1) AS id', [linked.id]);
    const [unlinked] = await rows("INSERT INTO restaurants(name,code) VALUES('Old Cafe','OLDCAFE') RETURNING id");
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await tables(), 3);
    assert.equal(await triggers(), 2);

    const [{ id: unlinkedBusiness }] = await rows('SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [unlinked.id]);
    assert.ok(unlinkedBusiness, 'every restaurant is linked to its business');
    for (const id of [shop.id, linkedBusiness, unlinkedBusiness]) {
      const [subscription] = await rows('SELECT s.plan_code,s.billing_period,p.is_default FROM business_subscriptions s JOIN platform_plans p ON p.code=s.plan_code WHERE s.business_id=$1', [id]);
      assert.equal(subscription.is_default, true, `business ${id}`);
      assert.equal(subscription.billing_period, 'year');
      const periods = await rows(`SELECT kind,ends_on,everything,reason,starts_on=business_local_today(business_id) AS from_today
        FROM business_access_periods WHERE business_id=$1`, [id]);
      assert.deepEqual(periods, [{ kind: 'given', ends_on: null, everything: true, reason: 'Set up before paid plans began', from_today: true }]);
      const [state] = await rows('SELECT * FROM business_plan_state($1)', [id]);
      assert.equal(state.state, 'given');
      assert.equal(state.access_ends_on, null);
    }
    assert.equal((await rows('SELECT plan_code FROM business_subscriptions WHERE business_id=$1', [shop.id]))[0].plan_code, 'grocery_basic');
    for (const restaurant of [linked.id, unlinked.id]) {
      assert.ok((await rows('SELECT restaurant_features($1) AS f', [restaurant]))[0].f.includes('captain_app'), `restaurant ${restaurant}`);
    }
  });

  await t.test('the starting catalogue: a Basic plan per type, module and application prices, the settings row', async () => {
    const plans = await rows('SELECT business_type,code,name,monthly_price,yearly_price,is_default,active FROM platform_plans ORDER BY business_type');
    const types = await rows('SELECT code FROM business_types ORDER BY code');
    assert.deepEqual(plans.map((p) => p.business_type), types.map((type) => type.code));
    for (const plan of plans) {
      assert.equal(plan.code, `${plan.business_type}_basic`);
      assert.equal(plan.name, 'Basic');
      assert.ok(plan.is_default && plan.active, plan.code);
    }
    const price = (type) => { const p = plans.find((row) => row.business_type === type); return [p.monthly_price, p.yearly_price]; };
    assert.deepEqual(price('grocery'), ['499.00', '4999.00']);
    assert.deepEqual(price('restaurant'), ['799.00', '7999.00']);
    assert.deepEqual(price('salon'), ['599.00', '5999.00']);
    assert.deepEqual(price('lodging'), ['1199.00', '11999.00']);
    // Basic holds the type's modules that start on, never an application or the restaurant module itself;
    // the restaurant's also holds pre-orders and brands, which its café, bakery and cloud kitchen switch on.
    const basic = async (type) => (await rows('SELECT module_code FROM platform_plan_modules WHERE plan_code=$1 ORDER BY module_code', [`${type}_basic`])).map((r) => r.module_code);
    const starting = async (type) => (await rows(`SELECT module_code FROM platform_module_business_types WHERE business_type=$1 AND enabled_by_default
      AND module_code NOT IN ('restaurant','captain_app','kitchen_display','qr_ordering','online_ordering','lab') ORDER BY module_code`, [type])).map((r) => r.module_code);
    assert.deepEqual(await basic('grocery'), await starting('grocery'));
    assert.deepEqual(await basic('restaurant'), [...await starting('restaurant'), 'brands', 'preorders'].sort());
    assert.ok(!(await basic('restaurant')).includes('online_ordering'));
    const prices = Object.fromEntries((await rows('SELECT module_code,sold_as,monthly_price,yearly_price,available FROM platform_module_prices')).map((r) => [r.module_code, r]));
    assert.equal(prices.restaurant, undefined);
    assert.deepEqual(prices.captain_app, { module_code: 'captain_app', sold_as: 'application', monthly_price: '299.00', yearly_price: '2999.00', available: true });
    assert.deepEqual([prices.online_ordering.sold_as, prices.online_ordering.monthly_price, prices.lab.yearly_price], ['application', '399.00', '4999.00']);
    assert.deepEqual([prices.loyalty.sold_as, prices.loyalty.monthly_price, prices.loyalty.yearly_price], ['module', '199.00', '1999.00']);
    const optional = (await rows("SELECT count(*)::int AS n FROM platform_modules WHERE kind='optional' AND code<>'restaurant'"))[0].n;
    assert.equal(Object.keys(prices).length, optional);
    const [settings] = await rows('SELECT trial_days,grace_days,gstin,sac_code,gst_rate,invoice_prefix,brand_name,legal_name,prices_reviewed_at FROM platform_settings');
    assert.deepEqual(settings, { trial_days: 14, grace_days: 7, gstin: '22AAAAA0000A1ZC', sac_code: '998315', gst_rate: '18.00', invoice_prefix: 'BMP',
      brand_name: 'Business Management Platform', legal_name: null, prices_reviewed_at: null });
    // The captain app is a restaurant feature that starts on, needs the restaurant, under Service.
    const [captain] = await rows(`SELECT m.kind,m.feature_group,t.enabled_by_default,(SELECT array_agg(requires_module_code) FROM platform_module_dependencies WHERE module_code=m.code) AS needs
      FROM platform_modules m JOIN platform_module_business_types t ON t.module_code=m.code WHERE m.code='captain_app'`);
    assert.deepEqual(captain, { kind: 'optional', feature_group: 'Service', enabled_by_default: true, needs: ['restaurant'] });
    // A plan holds only modules its type can use.
    await assert.rejects(scratch.query("INSERT INTO platform_plan_modules(plan_code,module_code) VALUES('grocery_basic','lab')"), /23514|plan/i);
    await assert.rejects(scratch.query("INSERT INTO platform_plan_modules(plan_code,module_code) VALUES('restaurant_basic','restaurant')"), /plan/i);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const state = (id) => one('SELECT * FROM business_plan_state($1)', [id]);
  const entitled = async (id) => (await one('SELECT business_entitled_modules($1) AS m', [id])).m;
  const active = async (id) => (await one('SELECT business_active_capabilities($1) AS m', [id])).m;
  const day = async (id, offset = 0) => (await one('SELECT (business_local_today($1) + $2::int)::text AS d', [id, offset])).d;
  let codes = 0;
  const business = async (type, extra = {}) => {
    codes += 1;
    return one(`INSERT INTO businesses(name,code,business_type,timezone,status) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [`Plan test ${codes}`, `PLAN-TEST-${codes}`, type, extra.timezone || 'Asia/Kolkata', extra.status || 'active']);
  };
  // A business whose trial is set aside, for a test to give it periods of its own.
  const bare = async (type, extra) => {
    const made = await business(type, extra);
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1", [made.id]);
    return made;
  };
  const order = async (id, from, to, status = 'paid', kind = 'subscription') => one(`INSERT INTO platform_orders(business_id,kind,plan_code,billing_period,starts_on,ends_on,valid_until,
      buyer,supplier_state_code,place_of_supply_code,gst_rate,taxable_amount,igst_amount,total_amount,status,paid_at)
    SELECT b.id,$5,CASE WHEN $5='subscription' THEN b.business_type || '_basic' END,'year',business_local_today(b.id)+$2::int,business_local_today(b.id)+$3::int,business_local_today(b.id)+7,
      '{"name":"Test buyer"}','22','29',18,100,18,118,$4,CASE WHEN $4='paid' THEN now() END
    FROM businesses b WHERE b.id=$1 RETURNING id`, [id, from, to, status, kind]);
  const period = async (id, kind, from, to, extra = {}) => one(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything,plan_code,modules,order_id,reason)
    SELECT b.id,$2,business_local_today(b.id)+$3::int,business_local_today(b.id)+$4::int,$5,$6,$7,$8,$9 FROM businesses b WHERE b.id=$1 RETURNING id`,
  [id, kind, from, to, extra.everything ?? kind === 'trial', extra.planCode ?? null, extra.modules ?? '{}', extra.orderId ?? null, extra.reason ?? null]);
  const paid = async (id, from, to, modules = '{}') => {
    const made = await order(id, from, to);
    const type = (await one('SELECT business_type FROM businesses WHERE id=$1', [id])).business_type;
    return period(id, 'paid', from, to, { orderId: made.id, planCode: `${type}_basic`, modules });
  };

  await t.test('every new business starts a trial on its own today; none with no trial days', async () => {
    const fresh = await business('grocery');
    const periods = (await pool.query('SELECT kind,starts_on,ends_on,everything FROM business_access_periods WHERE business_id=$1', [fresh.id])).rows;
    assert.deepEqual(periods, [{ kind: 'trial', starts_on: await day(fresh.id), ends_on: await day(fresh.id, 13), everything: true }]);
    const now = await state(fresh.id);
    assert.equal(now.state, 'trial');
    assert.equal(now.trial_ends_on, await day(fresh.id, 13));
    assert.equal(now.access_ends_on, await day(fresh.id, 13));
    assert.equal(now.period_kind, 'trial');
    assert.equal(now.everything, true);
    assert.equal((await one('SELECT plan_code FROM business_subscriptions WHERE business_id=$1', [fresh.id])).plan_code, 'grocery_basic');

    await pool.query('UPDATE platform_settings SET trial_days=0');
    try {
      const none = await business('salon');
      assert.equal((await one('SELECT count(*)::int AS n FROM business_access_periods WHERE business_id=$1', [none.id])).n, 0);
      assert.equal((await state(none.id)).state, 'ended');
      assert.ok(await one('SELECT 1 FROM business_subscriptions WHERE business_id=$1', [none.id]));
    } finally { await pool.query('UPDATE platform_settings SET trial_days=14'); }
    // The view lists every business with its state.
    const listed = await one('SELECT state,trial_ends_on FROM platform_business_plan_states WHERE business_id=$1', [fresh.id]);
    assert.deepEqual(listed, { state: 'trial', trial_ends_on: await day(fresh.id, 13) });
  });

  await t.test('state: paid, given, grace, checking, ended and off, in that order', async () => {
    const paidNow = await bare('grocery');
    await paid(paidNow.id, -10, 20);
    assert.equal((await state(paidNow.id)).state, 'paid');
    assert.equal((await state(paidNow.id)).grace_ends_on, await day(paidNow.id, 27));

    const given = await bare('hardware');
    await period(given.id, 'given', 0, null, { everything: true, reason: 'Pilot customer' });
    assert.deepEqual([(await state(given.id)).state, (await state(given.id)).access_ends_on], ['given', null]);

    const grace = await bare('grocery');
    await paid(grace.id, -30, -3);
    const graced = await state(grace.id);
    assert.equal(graced.state, 'grace');
    assert.equal(graced.grace_ends_on, await day(grace.id, 4));
    assert.equal(graced.period_kind, 'paid');

    const ended = await bare('grocery');
    await paid(ended.id, -40, -8);
    assert.equal((await state(ended.id)).state, 'ended');

    // After a trial there is no grace; a payment entered in the last two days keeps it working.
    const checking = await bare('books');
    await period(checking.id, 'trial', -14, -1);
    assert.equal((await state(checking.id)).state, 'ended');
    const open = await order(checking.id, 0, 364, 'open');
    await pool.query(`INSERT INTO platform_payments(business_id,order_id,amount,method,reference,paid_on,submitted_at)
      VALUES($1,$2,118,'upi','UTR1',business_local_today($1),now()-interval '1 hour')`, [checking.id, open.id]);
    const checked = await state(checking.id);
    assert.equal(checked.state, 'checking');
    assert.ok(checked.checking_until >= await day(checking.id, 1), checked.checking_until);
    // Once per order: a payment of that order already rejected gives no more days.
    await pool.query(`INSERT INTO platform_payments(business_id,order_id,amount,method,reference,paid_on,status,decided_at,decision_note)
      VALUES($1,$2,118,'upi','UTR0',business_local_today($1),'rejected',now(),'No such payment')`, [checking.id, open.id]);
    assert.equal((await state(checking.id)).state, 'ended');

    await pool.query("UPDATE businesses SET status='inactive' WHERE id=$1", [paidNow.id]);
    assert.equal((await state(paidNow.id)).state, 'off');
    const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Plan Dhaba','PLANDHABA') RETURNING id");
    const linked = (await one('SELECT restaurant_business_id($1) AS id', [restaurant.id])).id;
    assert.equal((await state(linked)).state, 'trial');
    await pool.query("UPDATE restaurants SET status='inactive' WHERE id=$1", [restaurant.id]);
    assert.equal((await state(linked)).state, 'off');
    // Its business row follows the restaurant's switch, both ways.
    assert.equal((await one('SELECT status FROM businesses WHERE id=$1', [linked])).status, 'inactive');
    await pool.query("UPDATE restaurants SET status='active' WHERE id=$1", [restaurant.id]);
    assert.equal((await one('SELECT status FROM businesses WHERE id=$1', [linked])).status, 'active');
    assert.equal((await state(linked)).state, 'trial');
  });

  await t.test('periods never overlap and are only ever cancelled, once', async () => {
    const shop = await bare('grocery');
    const first = await period(shop.id, 'given', 0, 30, { everything: true, reason: 'Pilot' });
    await assert.rejects(period(shop.id, 'given', 30, 60, { everything: true, reason: 'Again' }), /overlap/);
    await assert.rejects(pool.query('UPDATE business_access_periods SET ends_on=ends_on+1 WHERE id=$1', [first.id]), /never changed|cancel/);
    await assert.rejects(pool.query('DELETE FROM business_access_periods WHERE id=$1', [first.id]), /never deleted|cancel/);
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Wrong date' WHERE id=$1", [first.id]);
    await assert.rejects(pool.query("UPDATE business_access_periods SET cancel_reason='Again' WHERE id=$1", [first.id]), /already cancelled/);
    await period(shop.id, 'given', 0, 60, { everything: true, reason: 'Right date' });
    await assert.rejects(period(shop.id, 'given', 61, null, { everything: true }), /reason|check/i);
    await assert.rejects(period(shop.id, 'trial', 61, 70, { everything: false }), /check/i);
    await assert.rejects(period(shop.id, 'paid', 61, 70, { planCode: 'grocery_basic' }), /check/i);
    await assert.rejects(period(shop.id, 'given', 61, 70, { planCode: 'salon_basic', reason: 'Wrong plan' }), /plan/i);
    await assert.rejects(period(shop.id, 'given', 61, 70, { modules: '{lab}', planCode: 'grocery_basic', reason: 'Not a grocery module' }), /module/i);
  });

  await t.test('a paid period unlocks the modules copied onto it, add-on grants while they cover today', async () => {
    const shop = await bare('grocery');
    const made = await paid(shop.id, -10, 20, '{catalog,contacts,sales,loyalty}');
    assert.equal((await state(shop.id)).period_id, made.id);
    const modules = await entitled(shop.id);
    assert.deepEqual(modules, ['catalog', 'contacts', 'loyalty', 'sales']);
    // The owner's switch stays on, but a module outside the plan is not active.
    await pool.query("INSERT INTO business_capabilities(business_id,capability) VALUES($1,'loyalty'),($1,'offers')", [shop.id]);
    assert.ok(!(await active(shop.id)).includes('offers'));
    assert.ok((await active(shop.id)).includes('loyalty'));
    assert.ok(!(await active(shop.id)).includes('inventory'), 'switched on by default, not in this copy');
    const addOn = await order(shop.id, 0, 20, 'paid', 'add_on');
    const grant = await one(`INSERT INTO business_access_addons(business_id,module_code,kind,starts_on,ends_on,order_id)
      VALUES($1,'offers','paid',business_local_today($1),business_local_today($1)+20,$2) RETURNING id`, [shop.id, addOn.id]);
    assert.ok((await entitled(shop.id)).includes('offers'));
    assert.ok((await active(shop.id)).includes('offers'));
    // The grant's end passes: it is out again.
    await pool.query('ALTER TABLE business_access_addons DISABLE TRIGGER business_access_addons_kept');
    try {
      await pool.query('UPDATE business_access_addons SET starts_on=starts_on-30,ends_on=business_local_today(business_id)-1 WHERE id=$1', [grant.id]);
    } finally { await pool.query('ALTER TABLE business_access_addons ENABLE TRIGGER business_access_addons_kept'); }
    assert.ok(!(await entitled(shop.id)).includes('offers'));
    assert.ok(!(await active(shop.id)).includes('offers'));
    await assert.rejects(pool.query(`INSERT INTO business_access_addons(business_id,module_code,kind,starts_on,ends_on,reason)
      VALUES($1,'lab','given',business_local_today($1),business_local_today($1)+5,'Not a grocery module')`, [shop.id]), /module/i);
  });

  await t.test('a trial unlocks everything its type can use', async () => {
    const salon = await business('salon');
    const all = (await pool.query("SELECT module_code FROM platform_module_business_types WHERE business_type='salon' ORDER BY module_code")).rows.map((r) => r.module_code);
    assert.deepEqual(await entitled(salon.id), all);
    const switched = (await pool.query('SELECT capability FROM business_capabilities WHERE business_id=$1 ORDER BY capability', [salon.id])).rows.map((r) => r.capability);
    assert.deepEqual(await active(salon.id), switched);
  });

  await t.test("a restaurant always has the restaurant module; restaurant_features() leaves out what its plan does not hold", async () => {
    const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Plan Bistro','PLANBISTRO') RETURNING id");
    const linked = (await one('SELECT restaurant_business_id($1) AS id', [restaurant.id])).id;
    assert.ok((await one('SELECT restaurant_features($1) AS f', [restaurant.id])).f.includes('guests'));
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1", [linked]);
    await paid(linked, -5, 30, '{}');
    assert.deepEqual(await entitled(linked), ['restaurant']);
    assert.deepEqual((await one('SELECT restaurant_features($1) AS f', [restaurant.id])).f, []);
    assert.ok(await one("SELECT 1 FROM business_capabilities WHERE business_id=$1 AND capability='guests'", [linked]), 'the switch itself stays on');
  });

  await t.test('a business whose time zone moves back before its trial starts is still on its trial', async () => {
    // Kiritimati is 25 hours ahead of Pago Pago: its today is always after Pago Pago's.
    const shop = await business('grocery', { timezone: 'Pacific/Kiritimati' });
    const trial = await one('SELECT starts_on FROM business_access_periods WHERE business_id=$1', [shop.id]);
    await pool.query("UPDATE businesses SET timezone='Pacific/Pago_Pago' WHERE id=$1", [shop.id]);
    assert.ok(await day(shop.id) < trial.starts_on, 'its today is before the trial starts');
    const now = await state(shop.id);
    assert.equal(now.state, 'trial');
    assert.equal(now.everything, true);
  });

  await t.test('a restaurant made through the platform has its business, a trial and its plan at once', async () => {
    const password = `Plans-${crypto.randomBytes(8).toString('hex')}`;
    const platformUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id', ['Platform Admin', 'platform@plans.invalid', await bcrypt.hash(password, 4)]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformUser.id]);
    const app = require('../../src/app');
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const token = (await signIn(base, 'platform@plans.invalid', password)).token;
    const response = await fetch(`${base}/users/platform/restaurants`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Plan Kitchen', code: 'PLANKITCHEN', timezone: 'Asia/Kolkata', admin: { name: 'Owner', email: 'owner@plankitchen.invalid', password: `Own-${crypto.randomBytes(8).toString('hex')}` } }),
      signal: AbortSignal.timeout(20000) });
    const made = (await response.json()).data;
    assert.equal(response.status, 201);
    const linked = await one('SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [made.id]);
    assert.ok(linked, 'the restaurant has its business at once');
    assert.equal((await one('SELECT plan_code FROM business_subscriptions WHERE business_id=$1', [linked.id])).plan_code, 'restaurant_basic');
    const trial = await one("SELECT starts_on,ends_on FROM business_access_periods WHERE business_id=$1 AND kind='trial'", [linked.id]);
    assert.deepEqual(trial, { starts_on: await day(linked.id), ends_on: await day(linked.id, 13) });
    assert.equal((await state(linked.id)).state, 'trial');
    assert.ok((await one('SELECT restaurant_features($1) AS f', [made.id])).f.includes('captain_app'));
  });
});
