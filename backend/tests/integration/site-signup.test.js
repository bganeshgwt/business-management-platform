const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const { today: todayIn, addDays } = require('./helpers/dates');

// The platform's public site (/api/site), with no login: the company's details
// and the price list its pages show, signing up into a free trial (the owner's
// own login; the business, or the restaurant in its format, with the plan's
// modules and the chosen add-ons switched on; the selection for the first
// order; the lead, linked to the person's earlier request to be called back),
// the request to be called back, and the limits that keep both forms from
// being flooded.
test('platform site: info, pricing, sign-up into a free trial, call-back enquiries', { timeout: 600000 }, async (t) => {
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
  // Signing up never asks the pool for a second connection while a transaction holds one.
  process.env.DB_POOL_GUARD = 'throw';
  // The forms keep their limit of five an hour from one address: each case
  // sends from an address of its own, through one proxy the API trusts.
  process.env.TRUST_PROXY = '1';
  delete process.env.SITE_FORM_LIMIT;
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const { gstinCheckCharacter } = require('../../src/utils/gstin');
  const gstin = (first14) => `${first14}${gstinCheckCharacter(first14)}`;
  const app = require('../../src/app');
  // The super admin's own saves of the settings and the price list, as the console makes them.
  const planSettings = require('../../src/modules/platform/services/planSettings.service');
  const catalogue = require('../../src/modules/platform/services/planCatalogue.service');
  const platformUser = await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,'Platform Admin','platform@site.invalid',$1) RETURNING id",
    [crypto.randomBytes(24).toString('hex')]);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let addresses = 0;
  const address = () => `203.0.113.${++addresses}`;
  async function call(method, route, body, { auth, from } = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from || address(),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json() };
  }
  const send = async (method, route, body, expected = 200, options) => {
    const result = await call(method, route, body, options);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return expected >= 400 ? result.body : result.body.data;
  };
  const password = `Signup-${crypto.randomBytes(8).toString('hex')}`;
  const signup = (owner, business, selection, extra = {}) => ({
    owner: { name: 'Lakshmi Narayan', password, ...owner }, business: { city: 'Mysuru', stateCode: '29', ...business },
    selection: { billingPeriod: 'year', addons: [], ...selection }, acceptedTerms: true, website: '', ...extra,
  });
  const counts = async () => one(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM businesses)::int AS businesses,
    (SELECT count(*) FROM restaurants)::int AS restaurants, (SELECT count(*) FROM platform_leads)::int AS leads`);
  const switches = async (businessId) => (await all('SELECT capability FROM business_capabilities WHERE business_id=$1 ORDER BY capability', [businessId])).map((r) => r.capability);
  const planModules = async (code) => (await all('SELECT module_code FROM platform_plan_modules WHERE plan_code=$1 ORDER BY module_code', [code])).map((r) => r.module_code);
  const sorted = (codes) => [...new Set(codes)].sort();
  const today = todayIn('Asia/Kolkata');

  await t.test('pricing: every business type with its plans and add-ons, the trial and the GST rate, with no login', async () => {
    // A plan no longer offered is left out; a module owners may not add says so.
    await pool.query("INSERT INTO platform_plans(code,business_type,name,monthly_price,yearly_price,active) VALUES('grocery_old','grocery','Old',399,3999,false)");
    await pool.query("UPDATE platform_module_prices SET available=false WHERE module_code='wastage'");
    const pricing = await send('GET', '/site/pricing');
    const types = (await all('SELECT code,name FROM business_types ORDER BY name')).map((r) => ({ code: r.code, name: r.name }));
    assert.equal(pricing.types.length, 23);
    assert.deepEqual(pricing.types.map((type) => ({ code: type.code, name: type.name })), types);
    assert.deepEqual([pricing.trialDays, pricing.gstRate], [14, '18.00']);
    const grocery = pricing.types.find((type) => type.code === 'grocery');
    assert.deepEqual(grocery.plans.map((p) => [p.code, p.name, p.monthly, p.yearly, p.isDefault]), [['grocery_basic', 'Basic', '499.00', '4999.00', true]]);
    assert.deepEqual(grocery.plans[0].modules.map((m) => m.code).sort(), await planModules('grocery_basic'));
    const loyalty = grocery.addons.find((a) => a.code === 'loyalty');
    assert.deepEqual([loyalty.soldAs, loyalty.monthly, loyalty.yearly, loyalty.available], ['module', '199.00', '1999.00', true]);
    assert.equal(grocery.addons.find((a) => a.code === 'wastage').available, false);
    assert.ok(!grocery.addons.some((a) => a.code === 'restaurant'));
    const restaurant = pricing.types.find((type) => type.code === 'restaurant');
    assert.deepEqual(restaurant.formats, ['restaurant', 'cafe', 'bakery', 'cloud_kitchen']);
    assert.equal(grocery.formats, undefined);
    assert.deepEqual(restaurant.addons.find((a) => a.code === 'online_ordering').soldAs, 'application');
    // The GST states a business can be in, by their code.
    assert.deepEqual(pricing.states.find((s) => s.code === '29'), { code: '29', name: 'Karnataka' });
    assert.ok(!pricing.states.some((s) => ['97', '99'].includes(s.code)));
    // Read for every type at once, each type's answer is what planCatalogue.forType gives one
    // business of it: the same plans, modules and add-ons, in the catalogue's order.
    const order = Object.fromEntries((await all('SELECT code,sort_order FROM platform_modules')).map((r) => [r.code, r.sort_order]));
    const inOrder = (list) => list.every((item, i) => i === 0 || order[list[i - 1].code] <= order[item.code]);
    const byCode = (list) => [...list].sort((a, b) => a.code.localeCompare(b.code));
    const tidy = (type) => ({ ...type, plans: type.plans.map((plan) => ({ ...plan, modules: byCode(plan.modules) })), addons: byCode(type.addons) });
    for (const type of pricing.types) {
      const offer = await catalogue.forType(type.code);
      assert.deepEqual(tidy(type), tidy({ code: type.code, name: type.name, ...offer, ...(type.code === 'restaurant' ? { formats: restaurant.formats } : {}) }), type.code);
      assert.deepEqual(type.plans.map((plan) => plan.code), offer.plans.map((plan) => plan.code), type.code);
      assert.ok(inOrder(type.addons) && type.plans.every((plan) => inOrder(plan.modules)), type.code);
    }
    assert.ok(grocery.addons.length > 10 && restaurant.plans[0].modules.length > 10);
    await pool.query("UPDATE platform_module_prices SET available=true WHERE module_code='wastage'");
  });

  await t.test('the pages\' answers are kept a minute, and a save of the price list or the settings shows at once', async () => {
    const grocery = (pricing) => pricing.types.find((type) => type.code === 'grocery');
    const plan = (pricing) => grocery(pricing).plans.find((p) => p.code === 'grocery_basic');
    const addon = (pricing, code) => grocery(pricing).addons.find((a) => a.code === code);
    const basic = { code: 'grocery_basic', businessType: 'grocery', name: 'Basic', description: 'The everyday tools of this kind of business.', isDefault: true, active: true,
      sortOrder: 10, modules: await planModules('grocery_basic') };
    // Saving the price list forgets the answer; the next is read afresh and kept.
    await catalogue.update(platformUser, { plans: [{ ...basic, monthly: '499', yearly: '4999' }] });
    assert.equal(plan(await send('GET', '/site/pricing')).yearly, '4999.00');
    // A change made by hand in the database waits for the minute.
    await pool.query("UPDATE platform_plans SET yearly_price=4499 WHERE code='grocery_basic'");
    await pool.query("UPDATE platform_module_prices SET available=false WHERE module_code='offers'");
    const kept = await send('GET', '/site/pricing');
    assert.deepEqual([plan(kept).yearly, addon(kept, 'offers').available], ['4999.00', true]);
    // A price saved in the price list is in the very next answer, with everything changed since.
    await catalogue.update(platformUser, { plans: [{ ...basic, monthly: '549', yearly: '5499' }] });
    const fresh = await send('GET', '/site/pricing');
    assert.deepEqual([plan(fresh).monthly, plan(fresh).yearly, addon(fresh, 'offers').available], ['549.00', '5499.00', false]);
    await pool.query("UPDATE platform_module_prices SET available=true WHERE module_code='offers'");
    await catalogue.update(platformUser, { plans: [{ ...basic, monthly: '499', yearly: '4999' }] });
    assert.deepEqual([plan(await send('GET', '/site/pricing')).yearly, addon(await send('GET', '/site/pricing'), 'offers').available], ['4999.00', true]);
    // The settings: kept the same way, and a save shows on both answers at once.
    await planSettings.update(platformUser, { trialDays: 14 });
    assert.equal((await send('GET', '/site/info')).trialDays, 14);
    await pool.query('UPDATE platform_settings SET trial_days=10');
    assert.equal((await send('GET', '/site/info')).trialDays, 14);
    await planSettings.update(platformUser, { trialDays: 12 });
    assert.equal((await send('GET', '/site/info')).trialDays, 12);
    assert.equal((await send('GET', '/site/pricing')).trialDays, 12);
    await planSettings.update(platformUser, { trialDays: 14 });
    assert.equal((await send('GET', '/site/pricing')).trialDays, 14);
  });

  await t.test('info: the brand, the company\'s contact and grievance officer, the trial and grace days; never how to pay', async () => {
    const empty = await send('GET', '/site/info');
    assert.deepEqual(empty, {
      brandName: 'Business Management Platform',
      company: { name: null, address: null, city: null, postalCode: null, phone: null, email: null, website: null },
      support: { phone: null, email: null }, grievance: { name: null, email: null }, trialDays: 14, graceDays: 7, gstRate: '18.00',
    });
    // Saved as the console saves them: the next answer has them.
    await planSettings.update(platformUser, {
      brandName: 'Acme Business Suite', legalName: 'Acme Soft Private Limited', addressLine1: '12 MG Road', addressLine2: 'Ashok Nagar', city: 'Bengaluru',
      postalCode: '560001', phone: '080 4000 1234', email: 'hello@acme.invalid', website: 'https://acme.invalid', supportPhone: '080 4000 5678',
      supportEmail: 'help@acme.invalid', grievanceOfficerName: 'Meera Rao', grievanceOfficerEmail: 'grievance@acme.invalid', upiId: 'acme@okaxis',
      upiPayeeName: 'Acme Soft', bankName: 'State Bank of India', bankAccountName: 'Acme Soft Private Limited', bankAccountNumber: '12345678901',
      bankIfsc: 'SBIN0001234', paymentNote: 'Pay within 7 days', pan: 'AAAAA0000A',
    });
    const info = await send('GET', '/site/info');
    assert.deepEqual(info, {
      brandName: 'Acme Business Suite',
      company: { name: 'Acme Soft Private Limited', address: '12 MG Road, Ashok Nagar', city: 'Bengaluru', postalCode: '560001', phone: '080 4000 1234',
        email: 'hello@acme.invalid', website: 'https://acme.invalid' },
      support: { phone: '080 4000 5678', email: 'help@acme.invalid' }, grievance: { name: 'Meera Rao', email: 'grievance@acme.invalid' },
      trialDays: 14, graceDays: 7, gstRate: '18.00',
    });
    const text = JSON.stringify(info);
    for (const secret of ['acme@okaxis', '12345678901', 'SBIN0001234', 'State Bank', 'Pay within', 'AAAAA0000A', '22AAAAA0000A1ZC']) assert.ok(!text.includes(secret), secret);
  });

  let kirana;
  await t.test('a grocery signs up: the owner\'s own login, the business on its trial, the plan\'s modules and loyalty on, the selection and a lead', async () => {
    const body = signup({ mobile: '+91 98480 11101', email: 'Lakshmi@Kirana.test' }, { name: 'Sri Lakshmi Kirana', type: 'grocery', gstin: gstin('29ABCDE1234F1Z') },
      { planCode: 'grocery_basic', billingPeriod: 'month', addons: ['loyalty'] }, { ref: 'Facebook' });
    const session = await send('POST', '/site/signup', body, 201);
    assert.equal(typeof session.token, 'string');
    assert.equal(typeof session.deviceToken, 'string');
    assert.equal(session.user.email, 'lakshmi@kirana.test');
    assert.equal(session.user.restaurantId, null);
    // The password is the person's own: nothing asks them to choose another.
    assert.equal(session.user.passwordChangeRequired, false);
    assert.equal((await one('SELECT password_must_change FROM users WHERE id=$1', [session.user.id])).password_must_change, false);
    const me = await send('GET', '/auth/me', undefined, 200, { auth: session.token });
    assert.equal(me.id, session.user.id);
    const { businesses } = await send('GET', '/businesses', undefined, 200, { auth: session.token });
    assert.equal(businesses.length, 1);
    kirana = businesses[0];
    assert.deepEqual([kirana.name, kirana.business_type, kirana.full_access], ['Sri Lakshmi Kirana', 'grocery', true]);
    // Its code: the name's first words and four digits.
    assert.match(kirana.code, /^SRI-LAKSHMI-\d{4}$/);
    const state = await one('SELECT state,trial_ends_on::text FROM business_plan_state($1)', [kirana.id]);
    assert.deepEqual([state.state, state.trial_ends_on], ['trial', addDays(today, 13)]);
    const settings = await one('SELECT city,state_code,gstin FROM business_settings WHERE business_id=$1', [kirana.id]);
    assert.deepEqual(settings, { city: 'Mysuru', state_code: '29', gstin: gstin('29ABCDE1234F1Z') });
    // The selection for the first order, and the switches: the plan's modules and the add-on.
    const selection = await send('GET', `/businesses/${kirana.id}/plan`, undefined, 200, { auth: session.token });
    assert.deepEqual([selection.selection.planCode, selection.selection.billingPeriod, selection.selection.addons.map((a) => a.code)], ['grocery_basic', 'month', ['loyalty']]);
    assert.deepEqual(await switches(kirana.id), sorted([...await planModules('grocery_basic'), 'loyalty']));
    // A lead of its own, with where the person came from.
    const lead = await one('SELECT * FROM platform_leads WHERE business_id=$1', [kirana.id]);
    assert.deepEqual([lead.source, lead.name, lead.mobile, lead.email, lead.business_name, lead.business_type, lead.city, lead.state_code, lead.ref, lead.status],
      ['signup', 'Lakshmi Narayan', '9848011101', 'lakshmi@kirana.test', 'Sri Lakshmi Kirana', 'grocery', 'Mysuru', '29', 'facebook', 'new']);
    assert.ok(lead.signed_up_at && lead.consent_at);
    // What the business's activity log keeps.
    const audit = await all('SELECT action,actor_id,details FROM business_audit WHERE business_id=$1 ORDER BY id', [kirana.id]);
    const actions = audit.map((row) => row.action);
    for (const action of ['business.created', 'module.enabled', 'business.signed_up', 'plan.selection_changed']) assert.ok(actions.includes(action), action);
    assert.ok(audit.every((row) => Number(row.actor_id) === Number(session.user.id)));
    assert.deepEqual(audit.find((row) => row.action === 'module.enabled').details, { module: 'loyalty', via: 'signup' });
    assert.deepEqual(audit.find((row) => row.action === 'business.signed_up').details,
      { leadId: Number(lead.id), ref: 'facebook', planCode: 'grocery_basic', billingPeriod: 'month', addons: ['loyalty'] });
  });

  await t.test('the same sign-up sent again, or twice at once, makes one login and one business', async () => {
    const before = await counts();
    const again = signup({ mobile: '9848011101', email: 'lakshmi@kirana.test' }, { name: 'Sri Lakshmi Kirana', type: 'grocery' }, { planCode: 'grocery_basic' });
    const refused = await send('POST', '/site/signup', again, 409);
    assert.equal(refused.message, 'That email already has a login. Sign in instead.');
    const mobileTaken = await send('POST', '/site/signup', { ...again, owner: { ...again.owner, email: 'other@kirana.test' } }, 409);
    assert.equal(mobileTaken.message, 'That mobile number already has a login. Sign in instead.');
    assert.deepEqual(await counts(), before);
    const twin = signup({ mobile: '9848011102', email: 'twin@kirana.test' }, { name: 'Twin Stores', type: 'grocery' }, {});
    const results = await Promise.all([call('POST', '/site/signup', twin), call('POST', '/site/signup', twin)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], JSON.stringify(results.map((r) => r.body.message)));
    assert.equal((await one("SELECT count(*)::int AS n FROM users WHERE email='twin@kirana.test'")).n, 1);
    assert.equal((await one("SELECT count(*)::int AS n FROM businesses WHERE name='Twin Stores'")).n, 1);
  });

  await t.test('a smaller plan: the type\'s other starting modules are switched off, what a module needs first', async () => {
    // Without inventory, the modules that need it go before it; tasks goes on before issues, which needs it.
    await pool.query("INSERT INTO platform_plans(code,business_type,name,monthly_price,yearly_price) VALUES('grocery_lite','grocery','Lite',299,2999)");
    await pool.query("INSERT INTO platform_plan_modules(plan_code,module_code) VALUES('grocery_lite','catalog'),('grocery_lite','contacts'),('grocery_lite','sales')");
    const session = await send('POST', '/site/signup', signup({ mobile: '9848011103', email: 'lite@kirana.test' }, { name: 'Lite Kirana', type: 'grocery' },
      { planCode: 'grocery_lite', addons: ['tasks', 'issues'] }), 201);
    const [business] = (await send('GET', '/businesses', undefined, 200, { auth: session.token })).businesses;
    assert.deepEqual(await switches(business.id), ['catalog', 'contacts', 'issues', 'sales', 'tasks']);
    const changes = (await all("SELECT action,details->>'module' AS module FROM business_audit WHERE business_id=$1 AND action LIKE 'module.%' ORDER BY id", [business.id]))
      .map((row) => `${row.action === 'module.enabled' ? '+' : '-'}${row.module}`);
    assert.ok(changes.indexOf('-batches') < changes.indexOf('-inventory') && changes.indexOf('-purchasing') < changes.indexOf('-inventory'), changes.join(' '));
    assert.ok(changes.indexOf('+tasks') < changes.indexOf('+issues'), changes.join(' '));
    assert.deepEqual(changes.filter((c) => c.startsWith('+')), ['+tasks', '+issues']);
  });

  await t.test('a café signs up: the restaurant with its owner as its admin, its format, its business on a trial with pre-orders on', async () => {
    const session = await send('POST', '/site/signup', signup({ mobile: '9845012345', email: 'owner@chai-point.test', name: 'Arjun Shetty' },
      { name: 'Chai Point Café', type: 'restaurant', format: 'cafe', city: 'Udupi', stateCode: '29' }, { planCode: 'restaurant_basic', billingPeriod: 'year' }), 201);
    assert.ok(session.user.restaurantId);
    assert.equal(session.user.restaurantFormat, 'cafe');
    assert.ok(session.user.roles.includes('RESTAURANT_ADMIN'));
    assert.equal(session.user.passwordChangeRequired, false);
    assert.ok(session.user.features.includes('preorders'));
    const restaurant = await one('SELECT * FROM restaurants WHERE id=$1', [session.user.restaurantId]);
    assert.deepEqual([restaurant.name, restaurant.format, restaurant.status], ['Chai Point Café', 'cafe', 'active']);
    assert.match(restaurant.code, /^CHAI-POINT-\d{4}$/);
    assert.equal(Number(restaurant.created_by), Number(session.user.id));
    const business = await one('SELECT * FROM businesses WHERE legacy_restaurant_id=$1', [restaurant.id]);
    assert.deepEqual([business.business_type, business.code], ['restaurant', restaurant.code]);
    assert.equal((await one('SELECT state FROM business_plan_state($1)', [business.id])).state, 'trial');
    assert.deepEqual(await one('SELECT city,state_code FROM business_settings WHERE business_id=$1', [business.id]), { city: 'Udupi', state_code: '29' });
    // The plan's modules on, but for the two a café's format switches off;
    // the applications a new restaurant starts with, not chosen, off.
    const basic = await planModules('restaurant_basic');
    assert.deepEqual(await switches(business.id), sorted([...basic.filter((m) => !['captain_sections', 'reservations'].includes(m)), 'restaurant']));
    const selection = await one('SELECT plan_code,billing_period FROM business_subscriptions WHERE business_id=$1', [business.id]);
    assert.deepEqual(selection, { plan_code: 'restaurant_basic', billing_period: 'year' });
    const lead = await one('SELECT source,business_type,business_name FROM platform_leads WHERE business_id=$1', [business.id]);
    assert.deepEqual(lead, { source: 'signup', business_type: 'restaurant', business_name: 'Chai Point Café' });
    assert.equal((await one("SELECT details->>'format' AS format FROM business_audit WHERE business_id=$1 AND action='business.signed_up'", [business.id])).format, 'cafe');
  });

  await t.test('a bakery keeps the kitchen display its owner chose, which its format would switch off', async () => {
    const session = await send('POST', '/site/signup', signup({ mobile: '9845012346', email: 'owner@bake-house.test' },
      { name: 'Bake House', type: 'restaurant', format: 'bakery' }, { planCode: 'restaurant_basic', addons: ['kitchen_display'] }), 201);
    const business = await one('SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [session.user.restaurantId]);
    const basic = await planModules('restaurant_basic');
    assert.deepEqual(await switches(business.id),
      sorted([...basic.filter((m) => !['captain_sections', 'reservations', 'tips'].includes(m)), 'kitchen_display', 'restaurant']));
    assert.ok(session.user.features.includes('kitchen_display'));
  });

  await t.test('a restaurant needs a login of its own; a business refuses a login that exists', async () => {
    const before = await counts();
    const restaurantMessage = 'A restaurant needs a login of its own. Use another email and mobile number, or contact us.';
    const email = await send('POST', '/site/signup', signup({ mobile: '9845012399', email: 'LAKSHMI@kirana.test' }, { name: 'Lakshmi Tiffins', type: 'restaurant' }, {}), 409);
    assert.equal(email.message, restaurantMessage);
    const mobile = await send('POST', '/site/signup', signup({ mobile: '9848011101', email: 'tiffins@lakshmi.test' }, { name: 'Lakshmi Tiffins', type: 'restaurant' }, {}), 409);
    assert.equal(mobile.message, restaurantMessage);
    // A café's owner may not sign up a shop with the café's login either.
    const shop = await send('POST', '/site/signup', signup({ mobile: '9845099999', email: 'owner@chai-point.test' }, { name: 'Chai Stores', type: 'grocery' }, {}), 409);
    assert.equal(shop.message, 'That email already has a login. Sign in instead.');
    assert.deepEqual(await counts(), before);
  });

  await t.test('a call-back enquiry, then a sign-up with the same mobile: one lead, the enquiry, now with its business', async () => {
    const received = await send('POST', '/site/enquiries', { name: 'Ravi Kumar', mobile: '98765 00001', businessType: 'pharmacy', city: 'Hubballi',
      message: 'Two counters, about 4,000 medicines.', ref: 'whatsapp', consent: true, website: '' }, 201);
    assert.deepEqual(received, { received: true });
    const enquiry = await one("SELECT * FROM platform_leads WHERE mobile='9876500001'");
    assert.deepEqual([enquiry.source, enquiry.status, enquiry.business_id, enquiry.business_type, enquiry.ref], ['enquiry', 'new', null, 'pharmacy', 'whatsapp']);
    assert.ok(enquiry.consent_at);
    const session = await send('POST', '/site/signup', signup({ mobile: '+91-98765-00001', email: 'ravi@arogya.test', name: 'Ravi Kumar' },
      { name: 'Arogya Medicals', type: 'pharmacy', city: 'Hubballi' }, {}, { ref: 'facebook' }), 201);
    const [business] = (await send('GET', '/businesses', undefined, 200, { auth: session.token })).businesses;
    const leads = await all("SELECT * FROM platform_leads WHERE mobile='9876500001'");
    assert.equal(leads.length, 1);
    assert.deepEqual([leads[0].id, leads[0].source, Number(leads[0].business_id), leads[0].ref, leads[0].email, leads[0].business_name],
      [enquiry.id, 'enquiry', Number(business.id), 'whatsapp', 'ravi@arogya.test', 'Arogya Medicals']);
    assert.ok(leads[0].signed_up_at);
    // An enquiry by email alone is found by its email too, whatever its case.
    await send('POST', '/site/enquiries', { name: 'Divya', mobile: '9876500002', email: 'Divya@Salon.test', consent: true }, 201);
    const salon = await send('POST', '/site/signup', signup({ mobile: '9876500099', email: 'divya@salon.test', name: 'Divya' }, { name: 'Glow Salon', type: 'salon' }, {}), 201);
    const [glow] = (await send('GET', '/businesses', undefined, 200, { auth: salon.token })).businesses;
    assert.equal((await one('SELECT source FROM platform_leads WHERE business_id=$1', [glow.id])).source, 'enquiry');
  });

  await t.test('refused: the honeypot filled, the terms not accepted, consent not given, and what is not valid', async () => {
    const before = await counts();
    const good = signup({ mobile: '9845070001', email: 'refused@shop.test' }, { name: 'Refused Stores', type: 'grocery' }, { planCode: 'grocery_basic' });
    const name = async (code) => (await one('SELECT name FROM platform_modules WHERE code=$1', [code])).name;
    const refusals = [
      [{ ...good, website: 'https://spam.invalid' }, 'This form could not be sent. Please try again.'],
      [{ ...good, acceptedTerms: undefined }, 'Accept the terms of service and the privacy policy to sign up'],
      [{ ...good, acceptedTerms: 'yes' }, 'Accept the terms of service and the privacy policy to sign up'],
      [{ ...good, owner: { ...good.owner, mobile: '12345' } }, /^Mobile /],
      [{ ...good, owner: { ...good.owner, mobile: '' } }, 'Mobile is required'],
      [{ ...good, owner: { ...good.owner, email: 'not-an-email' } }, 'Email is not a valid email address'],
      [{ ...good, owner: { ...good.owner, password: 'short' } }, 'Password must be between 8 and 72 characters'],
      [{ ...good, business: { ...good.business, type: 'spaceship' } }, 'Choose the type of your business'],
      [{ ...good, business: { ...good.business, type: 'restaurant', format: 'food_truck' } }, "Choose the restaurant's format"],
      [{ ...good, business: { ...good.business, stateCode: '' } }, "Choose your business's state"],
      [{ ...good, business: { ...good.business, stateCode: '99' } }, "Choose your business's state"],
      [{ ...good, business: { ...good.business, gstin: gstin('27ABCDE1234F1Z') } }, 'The state must be the one in the GSTIN (Maharashtra)'],
      [{ ...good, business: { ...good.business, city: '' } }, 'City is required'],
      [{ ...good, selection: { ...good.selection, planCode: 'salon_basic' } }, 'That plan is not offered for this type of business'],
      [{ ...good, selection: { ...good.selection, planCode: 'grocery_old' } }, 'That plan is not offered for this type of business'],
      [{ ...good, selection: { ...good.selection, billingPeriod: 'week' } }, 'Billing period must be one of: month, year'],
      [{ ...good, selection: { ...good.selection, addons: ['lab'] } }, 'lab cannot be added to this type of business'],
      [{ ...good, selection: { planCode: 'grocery_lite', billingPeriod: 'year', addons: ['exchanges'] } },
        `${await name('exchanges')} needs ${await name('inventory')}. Add ${await name('inventory')} too.`],
    ];
    await pool.query("UPDATE platform_module_prices SET available=false WHERE module_code='wastage'");
    refusals.push([{ ...good, selection: { ...good.selection, addons: ['wastage'] } }, /is not offered as an add-on\. Contact us to add it\.$/]);
    for (const [body, message] of refusals) {
      const answer = await send('POST', '/site/signup', body, 400);
      if (message instanceof RegExp) assert.match(answer.message, message);
      else assert.equal(answer.message, message);
    }
    await pool.query("UPDATE platform_module_prices SET available=true WHERE module_code='wastage'");
    const enquiry = { name: 'Suresh', mobile: '9845070002', consent: true, website: '' };
    assert.equal((await send('POST', '/site/enquiries', { ...enquiry, website: 'spam' }, 400)).message, 'This form could not be sent. Please try again.');
    assert.equal((await send('POST', '/site/enquiries', { ...enquiry, consent: false }, 400)).message, 'Tick the box to agree to be contacted, so we can call you back');
    assert.equal((await send('POST', '/site/enquiries', { ...enquiry, mobile: undefined }, 400)).message, 'Mobile is required');
    assert.equal((await send('POST', '/site/enquiries', { ...enquiry, name: ' ' }, 400)).message, 'Your name is required');
    assert.equal((await send('POST', '/site/enquiries', { ...enquiry, businessType: 'spaceship' }, 400)).message, 'Choose the type of your business');
    assert.equal((await send('POST', '/site/enquiries', { ...enquiry, email: 'nope' }, 400)).message, 'Email is not a valid email address');
    assert.equal((await send('POST', '/site/enquiries', ['a list'], 400)).message, 'A JSON object is required');
    assert.deepEqual(await counts(), before);
  });

  await t.test('the trial days come from the settings; with none, the business starts ended and keeps the switches its owner chose', async () => {
    await planSettings.update(platformUser, { trialDays: 7 });
    const week = await send('POST', '/site/signup', signup({ mobile: '9845080001', email: 'week@shop.test' }, { name: 'Week Stores', type: 'general_retail' }, {}), 201);
    const [weekShop] = (await send('GET', '/businesses', undefined, 200, { auth: week.token })).businesses;
    assert.equal((await one('SELECT trial_ends_on::text AS d FROM business_plan_state($1)', [weekShop.id])).d, addDays(today, 6));
    assert.equal((await send('GET', '/site/pricing')).trialDays, 7);
    await planSettings.update(platformUser, { trialDays: 0 });
    try {
      assert.equal((await send('GET', '/site/info')).trialDays, 0);
      const paysFirst = await send('POST', '/site/signup', signup({ mobile: '9845080002', email: 'first@diner.test' }, { name: 'Pay First Diner', type: 'restaurant' },
        { planCode: 'restaurant_basic', addons: ['qr_ordering'] }), 201);
      const business = await one('SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [paysFirst.user.restaurantId]);
      assert.equal((await one('SELECT state FROM business_plan_state($1)', [business.id])).state, 'ended');
      assert.deepEqual(await switches(business.id), sorted([...await planModules('restaurant_basic'), 'qr_ordering', 'restaurant']));
    } finally { await planSettings.update(platformUser, { trialDays: 14 }); }
  });

  await t.test('five of each form an hour from one address; the sixth is refused, the other form still answers', async () => {
    const from = address();
    const incomplete = signup({ mobile: '9845090001', email: 'flood@shop.test' }, { name: 'Flood Stores', type: 'grocery' }, {}, { acceptedTerms: false });
    for (let i = 0; i < 5; i += 1) await send('POST', '/site/signup', incomplete, 400, { from });
    const sixth = await send('POST', '/site/signup', { ...incomplete, acceptedTerms: true }, 429, { from });
    assert.match(sixth.message, /^Too many forms sent from this network/);
    assert.equal((await one("SELECT count(*)::int AS n FROM users WHERE email='flood@shop.test'")).n, 0);
    await send('POST', '/site/enquiries', { name: 'Flood', mobile: '9845090002', consent: true }, 201, { from });
    // Reading the site is never held back by the forms' limit.
    await send('GET', '/site/info', undefined, 200, { from });
  });
});
