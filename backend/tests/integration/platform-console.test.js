const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { today: todayIn, addDays } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The platform console's operations, for the platform's own super admin: the
// company's settings and the price list; a business of any type made with its
// plan and how long it may be used (a restaurant with an owner login of its
// own); the list of businesses with their state; a business's page with its
// timeline and its usage in counts and dates only; changing its selection,
// giving it time and modules, an order and a payment recorded; payments to
// confirm or reject; the invoice register, one invoice, and the tax invoice
// once the real GSTIN is saved. A restaurant's user is never let in.
test('platform console: settings, prices, businesses with their time, payments to confirm, the invoice register', { timeout: 600000 }, async (t) => {
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
  // A request that holds a transaction's connection never asks the pool for another.
  process.env.DB_POOL_GUARD = 'throw';
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Console-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const platformRow = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id', ['Platform Admin', 'platform@console.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformRow.id]);
  const app = require('../../src/app');
  const math = require('../../src/modules/platform/services/planMath');
  const { gstinCheckCharacter } = require('../../src/utils/gstin');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email, secret = password) => (await signIn(base, email, secret))?.token || null;
  // A caller that expects a status: the answer's data, or (a refusal) the whole answer.
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return expected >= 400 ? result.body : result.body.data;
  };
  const platform = as(await login('platform@console.invalid'));
  const P = (route) => `/users/platform${route}`;
  const today = todayIn('Asia/Kolkata');
  const fy = math.fiscalYearOf(today);
  const basic = async (type) => (await all('SELECT module_code FROM platform_plan_modules WHERE plan_code=$1 ORDER BY module_code', [`${type}_basic`])).map((r) => r.module_code);
  const actions = async (businessId) => (await all('SELECT action FROM business_audit WHERE business_id=$1 ORDER BY id', [businessId])).map((r) => r.action);
  const businessCount = async (code) => (await one('SELECT count(*)::int AS n FROM businesses WHERE upper(code)=upper($1)', [code])).n;
  const first14 = '29AACCA1234B1Z';
  const realGstin = `${first14}${gstinCheckCharacter(first14)}`;

  await t.test('settings: the sample GSTIN flagged, refusals with their reasons, a good save audited', async () => {
    const view = await platform('GET', P('/settings'));
    assert.deepEqual([view.gstin, view.sampleGstin, view.trialDays, view.graceDays, view.invoicePrefix], ['22AAAAA0000A1ZC', true, 14, 7, 'BMP']);
    assert.deepEqual(view.companyProblems, ['legal name', 'address', 'city', 'PIN code']);
    const mistyped = `${first14}${realGstin.endsWith('0') ? '1' : '0'}`;
    await platform('PUT', P('/settings'), { gstin: mistyped }, 400);
    await platform('PUT', P('/settings'), { trialDays: 31 }, 400);
    await platform('PUT', P('/settings'), { graceDays: -1 }, 400);
    await platform('PUT', P('/settings'), { invoicePrefix: 'BMP1' }, 400);
    await platform('PUT', P('/settings'), {}, 400);
    assert.equal(await one("SELECT 1 FROM platform_audit WHERE action='platform.settings_updated'"), undefined, 'a refusal changes nothing');
    const saved = await platform('PUT', P('/settings'), { legalName: 'Console Soft Private Limited', addressLine1: '12 MG Road', city: 'Bengaluru', postalCode: '560001',
      upiId: 'console@okaxis', upiPayeeName: 'Console Soft', bankName: 'State Bank of India', bankAccountName: 'Console Soft Private Limited',
      bankAccountNumber: '12345678901', bankIfsc: 'SBIN0001234', supportEmail: 'help@console.invalid' });
    assert.deepEqual([saved.companyProblems, saved.sampleGstin, saved.legalName, saved.upiId], [[], true, 'Console Soft Private Limited', 'console@okaxis']);
    const audit = await one("SELECT actor_id,details FROM platform_audit WHERE action='platform.settings_updated' ORDER BY id DESC LIMIT 1");
    assert.equal(audit.actor_id, platformRow.id);
    assert.ok(audit.details.changed.includes('legal_name') && audit.details.changed.includes('upi_id'), JSON.stringify(audit.details));
    assert.equal((await platform('GET', P('/settings'))).city, 'Bengaluru');
  });

  await t.test('prices: every plan and module price with the business types; a save stamps the review; a negative price is refused', async () => {
    const list = await platform('GET', P('/prices'));
    assert.equal(list.pricesReviewedAt, null);
    const groceryBasic = list.plans.find((p) => p.code === 'grocery_basic');
    assert.deepEqual([groceryBasic.businessType, groceryBasic.monthly, groceryBasic.yearly, groceryBasic.isDefault], ['grocery', '499.00', '4999.00', true]);
    assert.deepEqual(groceryBasic.modules, await basic('grocery'));
    assert.ok(list.types.some((type) => type.code === 'grocery' && type.name), 'the business types, with their names');
    assert.ok(list.types.some((type) => type.code === 'restaurant'));
    const loyalty = list.prices.find((p) => p.code === 'loyalty');
    assert.deepEqual([loyalty.soldAs, loyalty.monthly, loyalty.yearly, loyalty.available], ['module', '199.00', '1999.00', true]);
    assert.ok(loyalty.types.includes('grocery'));
    assert.equal(list.prices.find((p) => p.code === 'captain_app').soldAs, 'application');
    await platform('PUT', P('/prices'), { plans: [{ ...groceryBasic, yearly: '-5' }] }, 400);
    await platform('PUT', P('/prices'), { prices: [{ ...loyalty, monthly: '-1' }] }, 400);
    assert.equal((await one('SELECT prices_reviewed_at FROM platform_settings')).prices_reviewed_at, null, 'a refusal stamps nothing');
    const saved = await platform('PUT', P('/prices'), { plans: [{ ...groceryBasic, yearly: '5499' }] });
    assert.ok(saved.pricesReviewedAt);
    assert.equal(saved.plans.find((p) => p.code === 'grocery_basic').yearly, '5499.00');
    assert.ok(saved.types.length > 20);
    assert.ok(await one("SELECT 1 FROM platform_audit WHERE action='platform.prices_updated' AND actor_id=$1", [platformRow.id]));
    await platform('PUT', P('/prices'), { plans: [{ ...groceryBasic, yearly: '4999' }] });
    assert.equal((await platform('GET', P('/prices'))).plans.find((p) => p.code === 'grocery_basic').yearly, '4999.00');
  });

  let hardware;
  const hardwareBody = {
    businessType: 'hardware', name: 'Console Hardware', code: 'CON-HARDWARE', stateCode: '29', city: 'Mysuru',
    owner: { email: 'owner@conhardware.invalid', name: 'Suresh B', mobile: '9845022222', password },
    selection: { planCode: 'hardware_basic', billingPeriod: 'year', addons: [] },
    access: { kind: 'until', endsOn: addDays(today, 60), reason: 'Pilot customer' },
  };
  await t.test('a shop made by the platform with time given until a date: its trial cancelled with that reason', async () => {
    const made = await platform('POST', P('/businesses'), hardwareBody, 201);
    hardware = made.business;
    assert.equal(made.owner.created, true);
    assert.deepEqual([made.plan.state, made.plan.accessEndsOn], ['given', addDays(today, 60)]);
    const trial = await one("SELECT cancel_reason,cancelled_by FROM business_access_periods WHERE business_id=$1 AND kind='trial'", [hardware.id]);
    assert.deepEqual([trial.cancel_reason, trial.cancelled_by], ['Pilot customer', platformRow.id]);
    const given = await one("SELECT * FROM business_access_periods WHERE business_id=$1 AND kind='given' AND cancelled_at IS NULL", [hardware.id]);
    assert.deepEqual([given.starts_on, given.ends_on, given.everything, given.plan_code, given.reason], [today, addDays(today, 60), false, 'hardware_basic', 'Pilot customer']);
    assert.deepEqual([...given.modules].sort(), await basic('hardware'));
    assert.deepEqual(await one('SELECT plan_code,billing_period FROM business_subscriptions WHERE business_id=$1', [hardware.id]), { plan_code: 'hardware_basic', billing_period: 'year' });
    const done = await actions(hardware.id);
    for (const action of ['business.created', 'plan.selection_changed', 'plan.time_given']) assert.ok(done.includes(action), action);
    // The same code again is refused.
    await platform('POST', P('/businesses'), hardwareBody, 409);
    assert.equal(await businessCount('CON-HARDWARE'), 1);
  });

  const shopBody = (code, extra = {}) => ({ businessType: 'grocery', name: `Shop ${code}`, code, stateCode: '29', owner: { email: 'owner@congrocery.invalid', name: 'Lakshmi N', password }, ...extra });
  let noEnd, trialShop, plainShop;
  await t.test('time with no end that unlocks everything, a free trial kept, and refusals that leave nothing behind', async () => {
    noEnd = (await platform('POST', P('/businesses'), shopBody('CON-NOEND', { access: { kind: 'no_end', everything: true, reason: 'Founding customer' } }), 201));
    assert.deepEqual([noEnd.plan.state, noEnd.plan.accessEndsOn, noEnd.plan.everything], ['given', null, true]);
    const trialMade = await platform('POST', P('/businesses'), shopBody('CON-TRIAL', { access: { kind: 'trial' }, selection: { planCode: 'grocery_basic', billingPeriod: 'month', addons: ['loyalty'] } }), 201);
    trialShop = trialMade.business;
    assert.deepEqual([trialMade.owner.created, trialMade.plan.state, trialMade.plan.trialEndsOn], [false, 'trial', addDays(today, 13)]);
    assert.deepEqual((await all('SELECT module_code FROM business_subscription_addons WHERE business_id=$1', [trialShop.id])).map((r) => r.module_code), ['loyalty']);
    plainShop = (await platform('POST', P('/businesses'), shopBody('CON-PLAIN'), 201)).business;
    assert.equal((await one('SELECT state FROM business_plan_state($1)', [plainShop.id])).state, 'trial');
    // An add-on that needs a module neither its type's Basic plan nor the add-ons hold.
    const needy = await one(`SELECT b.code AS type,d.module_code AS addon FROM business_types b
      JOIN platform_module_dependencies d ON platform_module_sellable(d.module_code,b.code) AND platform_module_sellable(d.requires_module_code,b.code)
      WHERE b.code<>'restaurant' AND EXISTS (SELECT 1 FROM platform_module_prices pr WHERE pr.module_code=d.module_code)
        AND NOT EXISTS (SELECT 1 FROM platform_plan_modules pm WHERE pm.plan_code=b.code||'_basic' AND pm.module_code IN (d.module_code,d.requires_module_code))
      ORDER BY b.code,d.module_code LIMIT 1`);
    assert.ok(needy, "some add-on needs a module outside its type's Basic plan");
    const fresh = { email: 'owner@conrefused.invalid', name: 'Refused Owner', password };
    const refusals = [
      [{ access: { kind: 'until', endsOn: addDays(today, 30) } }, 400],
      [{ access: { kind: 'until', endsOn: addDays(today, -1), reason: 'Too late' } }, 400],
      [{ access: { kind: 'until', reason: 'No date' } }, 400],
      [{ access: { kind: 'no_end', reason: '  ' } }, 400],
      [{ access: { kind: 'forever', reason: 'Pilot' } }, 400],
      [{ selection: { planCode: 'salon_basic', billingPeriod: 'year', addons: [] } }, 400],
      [{ selection: { planCode: 'grocery_basic', billingPeriod: 'week', addons: [] } }, 400],
      [{ selection: { planCode: 'grocery_basic', billingPeriod: 'year', addons: ['lab'] } }, 400],
      [{ businessType: needy.type, selection: { planCode: `${needy.type}_basic`, billingPeriod: 'year', addons: [needy.addon] } }, 400],
    ];
    for (const [index, [extra, status]] of refusals.entries()) {
      const code = `CON-REFUSED-${index}`;
      const answer = await platform('POST', P('/businesses'), { ...shopBody(code, extra), owner: fresh }, status);
      assert.ok(answer.message, JSON.stringify(extra));
      assert.equal(await businessCount(code), 0, `nothing is made: ${JSON.stringify(extra)}`);
    }
    assert.equal(await one("SELECT 1 FROM users WHERE email='owner@conrefused.invalid'"), undefined, 'no login is left behind');
    const needs = await platform('POST', P('/businesses'), { ...shopBody('CON-NEEDS', refusals.at(-1)[0]), owner: fresh }, 400);
    assert.match(needs.message, /needs .+\. Add .+ too\.$/);
    // With no trial days, a free trial cannot be chosen.
    await pool.query('UPDATE platform_settings SET trial_days=0');
    try {
      const noTrial = await platform('POST', P('/businesses'), { ...shopBody('CON-NOTRIAL', { access: { kind: 'trial' } }), owner: fresh }, 409);
      assert.match(noTrial.message, /free trial/i);
      assert.equal(await businessCount('CON-NOTRIAL'), 0);
    } finally { await pool.query('UPDATE platform_settings SET trial_days=14'); }
  });

  let cafe, cafeRestaurant;
  const cafeBody = {
    businessType: 'restaurant', format: 'cafe', name: 'Console Cafe', code: 'CONCAFE', stateCode: '29', city: 'Bengaluru', postalCode: '560034',
    addressLine1: '80 Feet Road', phone: '08041234567', timezone: 'Asia/Kolkata',
    owner: { name: 'Meera K', email: 'owner@concafe.invalid', mobile: '9845011111', password },
    selection: { planCode: 'restaurant_basic', billingPeriod: 'month', addons: ['kitchen_display'] },
    access: { kind: 'until', endsOn: addDays(today, 30), reason: 'Pilot cafe' },
  };
  await t.test('a restaurant made by the platform: an owner login of its own, its format, its state for GST, its time', async () => {
    // A restaurant's people belong to it alone, so its owner is always a new login.
    for (const owner of [{ ...cafeBody.owner, email: 'owner@conhardware.invalid' }, { ...cafeBody.owner, email: 'other@concafe.invalid', mobile: '9845022222' }]) {
      const taken = await platform('POST', P('/businesses'), { ...cafeBody, owner }, 409);
      assert.equal(taken.message, 'A restaurant needs a login of its own. Use another email and mobile number.');
    }
    await platform('POST', P('/businesses'), { ...cafeBody, format: 'food_truck' }, 400);
    await platform('POST', P('/businesses'), { ...cafeBody, stateCode: '00' }, 400);
    await platform('POST', P('/businesses'), { ...cafeBody, owner: { ...cafeBody.owner, password: undefined } }, 400);
    await platform('POST', P('/businesses'), { ...cafeBody, access: { kind: 'until', reason: 'No date' } }, 400);
    assert.equal(await one("SELECT 1 FROM restaurants WHERE code='CONCAFE'"), undefined, 'nothing is made');
    assert.equal(await one("SELECT 1 FROM users WHERE email='owner@concafe.invalid'"), undefined);
    const made = await platform('POST', P('/businesses'), cafeBody, 201);
    cafe = made.business;
    cafeRestaurant = await one("SELECT id,format,status,address FROM restaurants WHERE code='CONCAFE'");
    assert.deepEqual([cafe.business_type, cafe.legacy_restaurant_id, cafeRestaurant.format], ['restaurant', cafeRestaurant.id, 'cafe']);
    assert.deepEqual([made.owner.created, made.restaurant.id, made.restaurant.format], [true, cafeRestaurant.id, 'cafe']);
    assert.deepEqual([made.plan.state, made.plan.accessEndsOn], ['given', addDays(today, 30)]);
    assert.match(cafeRestaurant.address, /80 Feet Road/);
    const settings = await one('SELECT state_code,city,postal_code FROM business_settings WHERE business_id=$1', [cafe.id]);
    assert.deepEqual(settings, { state_code: '29', city: 'Bengaluru', postal_code: '560034' });
    const owner = await one("SELECT u.restaurant_id,u.mobile,r.code FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.email='owner@concafe.invalid'");
    assert.deepEqual(owner, { restaurant_id: cafeRestaurant.id, mobile: '9845011111', code: 'RESTAURANT_ADMIN' });
    assert.equal((await one("SELECT cancel_reason FROM business_access_periods WHERE business_id=$1 AND kind='trial'", [cafe.id])).cancel_reason, 'Pilot cafe');
    const given = await one("SELECT modules FROM business_access_periods WHERE business_id=$1 AND kind='given' AND cancelled_at IS NULL", [cafe.id]);
    assert.ok(given.modules.includes('kitchen_display') && given.modules.includes('preorders'), given.modules.join());
    // The café's own set-up: pre-orders on, and in its plan.
    assert.ok((await one('SELECT restaurant_features($1) AS f', [cafeRestaurant.id])).f.includes('preorders'));
    const created = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='business.created'", [cafe.id]);
    assert.deepEqual([created.details.type, created.details.format, created.details.restaurantId], ['restaurant', 'cafe', cafeRestaurant.id]);
    assert.ok(await login('owner@concafe.invalid'), 'the owner signs in');
    assert.deepEqual(made.restaurant.skipped, []);
  });

  await t.test("with no free trial, a bakery's own set-up comes with the time given; what its plan leaves out is named", async () => {
    await pool.query('UPDATE platform_settings SET trial_days=0');
    let bakery;
    try {
      bakery = await platform('POST', P('/businesses'), { ...cafeBody, format: 'bakery', name: 'Console Bakery', code: 'CONBAKERY', stateCode: undefined,
        owner: { name: 'Ravi Baker', email: 'owner@conbakery.invalid', mobile: '9845055555', password },
        selection: { planCode: 'restaurant_basic', billingPeriod: 'month', addons: [] }, access: { kind: 'until', endsOn: addDays(today, 30), reason: 'Pilot bakery' } }, 201);
    } finally { await pool.query('UPDATE platform_settings SET trial_days=14'); }
    assert.deepEqual([bakery.plan.state, bakery.restaurant.format], ['given', 'bakery']);
    const features = (await one('SELECT restaurant_features($1) AS f', [bakery.restaurant.id])).f;
    assert.ok(features.includes('preorders'), `the bakery's pre-orders, in its plan, are on: ${features.join()}`);
    const basicModules = await basic('restaurant');
    for (const skipped of bakery.restaurant.skipped) {
      assert.ok(skipped.enabled && !basicModules.includes(skipped.feature) && skipped.reason, JSON.stringify(skipped));
    }
    // Its place of supply: the GSTIN in the restaurant's own settings.
    const gst14 = '27AABCB1234D1Z';
    await pool.query('UPDATE restaurant_settings SET gst_number=$2 WHERE restaurant_id=$1', [bakery.restaurant.id, `${gst14}${gstinCheckCharacter(gst14)}`]);
    const page = await platform('GET', P(`/businesses/${bakery.business.id}`));
    assert.deepEqual([page.business.placeOfSupplyCode, page.business.placeOfSupplyName, page.business.today], ['27', 'Maharashtra', today]);
  });

  await t.test('the list: state, plan, end date, owner and last active, for every type; filters by state, type, plan and end', async () => {
    assert.ok(await login('owner@conhardware.invalid'), 'the hardware shop\'s owner signs in');
    const given = await platform('GET', P('/businesses?state=given&endsWithin=90'));
    assert.deepEqual(given.items.map((b) => b.code).sort(), ['CON-HARDWARE', 'CONBAKERY', 'CONCAFE']);
    const row = given.items.find((b) => b.code === 'CON-HARDWARE');
    assert.deepEqual([row.state, row.access_ends_on, row.plan_code, row.plan_name, row.billing_period, row.addons, row.state_code, row.city],
      ['given', addDays(today, 60), 'hardware_basic', 'Basic', 'year', 0, '29', 'Mysuru']);
    assert.equal(row.owners[0].email, 'owner@conhardware.invalid');
    assert.ok(row.last_active_at, 'its owner signed in');
    const cafeRow = given.items.find((b) => b.code === 'CONCAFE');
    assert.deepEqual([cafeRow.business_type, cafeRow.restaurant_id, cafeRow.format, cafeRow.owners[0].email], ['restaurant', cafeRestaurant.id, 'cafe', 'owner@concafe.invalid']);
    const soon = (await platform('GET', P('/businesses?endsWithin=45'))).items.map((b) => b.code);
    assert.ok(soon.includes('CONCAFE') && soon.includes('CON-TRIAL') && !soon.includes('CON-HARDWARE') && !soon.includes('CON-NOEND'), soon.join());
    assert.deepEqual((await platform('GET', P('/businesses?plan=hardware_basic'))).items.map((b) => b.code), ['CON-HARDWARE']);
    assert.deepEqual((await platform('GET', P('/businesses?type=restaurant'))).items.map((b) => b.code).sort(), ['CONBAKERY', 'CONCAFE']);
    const trials = (await platform('GET', P('/businesses?state=trial'))).items.map((b) => b.code).sort();
    assert.deepEqual(trials, ['CON-PLAIN', 'CON-TRIAL']);
    const listed = await platform('GET', P('/businesses'));
    assert.ok(listed.plans.some((p) => p.code === 'grocery_basic' && p.businessType === 'grocery'));
    assert.ok(listed.types.some((type) => type.code === 'restaurant'));
    await platform('GET', P('/businesses?state=sleeping'), undefined, 400);
    await platform('GET', P('/businesses?endsWithin=soon'), undefined, 400);
  });

  let clinic;
  await t.test("a business's page: owners, plan, selection, timeline, and usage counted, never its customers, bills, patients or amounts", async () => {
    // The grocery's owner records a customer and a sale.
    const owner = as(await login('owner@congrocery.invalid'));
    const B = (route) => `/businesses/${trialShop.id}/${route}`;
    const location = (await owner('GET', B('locations'))).items[0];
    const customer = await owner('POST', B('contacts'), { kind: 'customer', name: 'Privacy Probe Customer', phone: '9845033333' }, 201);
    const item = await owner('POST', B('catalog'), { kind: 'service', unit: 'service', name: 'Probe service', code: 'PROBE', price: '7777.77', taxRate: '0' }, 201);
    const sale = await owner('POST', B('documents'), { kind: 'sale', requestKey: crypto.randomUUID(), locationId: location.id, contactId: customer.id,
      lines: [{ skuId: item.id, quantity: '1' }], payment: { method: 'cash', amount: 'full' } }, 201);
    assert.ok(sale.document_no && Number(sale.total) > 7000, JSON.stringify(sale));
    const page = await platform('GET', P(`/businesses/${trialShop.id}`));
    assert.deepEqual([page.business.id, page.business.code, page.business.type, page.plan.state, page.selection.planCode], [trialShop.id, 'CON-TRIAL', 'grocery', 'trial', 'grocery_basic']);
    assert.deepEqual([page.business.today, page.business.placeOfSupplyCode, page.business.placeOfSupplyName], [today, '29', 'Karnataka']);
    assert.equal(page.owners[0].email, 'owner@congrocery.invalid');
    assert.deepEqual(page.periods.map((p) => p.kind), ['trial']);
    assert.ok(page.catalogue.plans.some((p) => p.code === 'grocery_basic'));
    assert.ok(page.entitled.includes('loyalty'));
    assert.deepEqual(Object.keys(page.usage).sort(), ['activeLocations', 'activeUsers', 'lastSignInAt', 'salesThisMonth', 'salesTotal']);
    assert.deepEqual([page.usage.salesThisMonth, page.usage.salesTotal, page.usage.activeUsers, page.usage.activeLocations], [1, 1, 1, 1]);
    assert.ok(!Number.isNaN(Date.parse(page.usage.lastSignInAt)));
    const text = JSON.stringify(page);
    for (const secret of ['Privacy Probe Customer', '9845033333', sale.document_no, '7777.77', 'Probe service']) assert.ok(!text.includes(secret), `the page shows ${secret}`);

    // A clinic's patient.
    clinic = (await platform('POST', P('/businesses'), shopBody('CON-CLINIC', { businessType: 'healthcare' }), 201)).business;
    await owner('POST', `/businesses/${clinic.id}/clinic/patients`, { name: 'Probe Patient Name', phone: '9845044444', sex: 'female', ageYears: 41,
      consent: { purposes: ['treatment'], method: 'signed_form', givenBy: 'Self' } }, 201);
    const clinicPage = JSON.stringify(await platform('GET', P(`/businesses/${clinic.id}`)));
    for (const secret of ['Probe Patient Name', '9845044444']) assert.ok(!clinicPage.includes(secret), `the page shows ${secret}`);

    // A restaurant's bill: counted, never shown.
    const diner = as(await login('owner@concafe.invalid'));
    const rate = await diner('POST', '/menu/tax-rates', { name: 'Food 5%', percentage: 5, hsnCode: '9963' }, 201);
    const category = await diner('POST', '/menu/categories', { name: 'Coffee' }, 201);
    const dish = await diner('POST', '/menu/products', { categoryId: category.id, name: 'Filter coffee', price: 333, taxRateId: rate.id, isAvailable: true }, 201);
    await diner('POST', '/business-day/open', { openingCash: 0 }, 201);
    const order = await diner('POST', '/orders', { orderType: 'takeaway', items: [{ productId: dish.id, quantity: 1 }] }, 201);
    const bill = await diner('POST', '/bills', { orderId: order.id }, 201);
    await diner('POST', `/bills/${bill.id}/payments`, { paymentMethod: 'cash', amount: bill.dueAmount }, 201);
    assert.ok(bill.billNumber && Number(bill.totalAmount) > 333 && order.orderNumber, JSON.stringify({ bill, order }));
    const cafePage = await platform('GET', P(`/businesses/${cafe.id}`));
    assert.deepEqual([cafePage.usage.salesThisMonth, cafePage.usage.salesTotal, cafePage.usage.activeUsers, cafePage.usage.activeLocations], [1, 1, 1, 0]);
    assert.deepEqual([cafePage.business.restaurantId, cafePage.business.format, cafePage.owners[0].email], [cafeRestaurant.id, 'cafe', 'owner@concafe.invalid']);
    const cafeText = JSON.stringify(cafePage);
    for (const secret of [bill.billNumber, String(bill.totalAmount), order.orderNumber]) assert.ok(!cafeText.includes(secret), `the page shows ${secret}`);

    await platform('GET', P('/businesses/999999999'), undefined, 404);
  });

  let extraModule, recorded;
  await t.test("the platform changes a business's selection, gives it time and a module, makes its order and records its payment", async () => {
    const owner = as(await login('owner@conhardware.invalid'));
    const refused = await owner('PUT', `/businesses/${hardware.id}/plan/selection`, { planCode: 'hardware_basic', billingPeriod: 'month', addons: [] }, 409);
    assert.equal(refused.data.reason, 'given_time');
    const selection = await platform('PUT', P(`/businesses/${hardware.id}/selection`), { planCode: 'hardware_basic', billingPeriod: 'month', addons: [] });
    assert.equal(selection.billingPeriod, 'month');
    assert.equal((await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='plan.selection_changed' ORDER BY id DESC LIMIT 1", [hardware.id])).details.by, 'platform');
    await platform('PUT', P(`/businesses/${hardware.id}/selection`), { planCode: 'salon_basic', billingPeriod: 'month', addons: [] }, 400);

    extraModule = (await one(`SELECT t.module_code AS code FROM platform_module_business_types t WHERE t.business_type='hardware' AND platform_module_sellable(t.module_code,'hardware')
      AND NOT EXISTS (SELECT 1 FROM platform_plan_modules pm WHERE pm.plan_code='hardware_basic' AND pm.module_code=t.module_code) ORDER BY t.module_code LIMIT 1`)).code;
    await platform('POST', P(`/businesses/${hardware.id}/given-addons`), { modules: [extraModule], endsOn: addDays(today, 30) }, 400);
    const grants = await platform('POST', P(`/businesses/${hardware.id}/given-addons`), { modules: [extraModule], endsOn: addDays(today, 30), reason: 'Trying it' }, 201);
    assert.deepEqual(grants.map((g) => [g.module_code, g.kind, g.ends_on]), [[extraModule, 'given', addDays(today, 30)]]);
    assert.ok((await one('SELECT business_entitled_modules($1) AS m', [hardware.id])).m.includes(extraModule));

    await platform('POST', P(`/businesses/${hardware.id}/given-time`), { endsOn: addDays(today, 90), planCode: 'hardware_basic' }, 400);
    const longer = await platform('POST', P(`/businesses/${hardware.id}/given-time`), { endsOn: addDays(today, 90), planCode: 'hardware_basic', reason: 'Pilot extended' }, 201);
    assert.deepEqual([longer.kind, longer.starts_on, longer.ends_on], ['given', today, addDays(today, 90)]);
    assert.equal((await one('SELECT state FROM business_plan_state($1)', [hardware.id])).state, 'given');

    const order = await platform('POST', P(`/businesses/${hardware.id}/orders`), { kind: 'subscription' }, 201);
    assert.deepEqual([order.kind, order.startsOn, order.billingPeriod, order.total, order.igst], ['subscription', addDays(today, 91), 'month', '588.82', '89.82']);
    await platform('POST', P(`/businesses/${hardware.id}/payments`), { orderId: order.id, method: 'gift', reference: 'NEFT001', paidOn: today }, 400);
    recorded = await platform('POST', P(`/businesses/${hardware.id}/payments`), { orderId: order.id, method: 'bank', reference: 'NEFT001', paidOn: today }, 201);
    assert.deepEqual([recorded.payment.status, recorded.order.status, recorded.invoice.sample], ['confirmed', 'paid', true]);
    assert.match(recorded.invoice.number, new RegExp(`^SAMPLE/${fy}/\\d{4}$`));
    assert.deepEqual([recorded.period.kind, recorded.period.starts_on], ['paid', addDays(today, 91)]);
    // Recorded again: the order is paid already.
    await platform('POST', P(`/businesses/${hardware.id}/payments`), { orderId: order.id, method: 'bank', reference: 'NEFT001', paidOn: today }, 409);
    await platform('POST', P('/businesses/999999999/orders'), { kind: 'subscription' }, 404);

    const page = await platform('GET', P(`/businesses/${hardware.id}`));
    assert.deepEqual(page.periods.map((p) => [p.kind, p.cancelReason || null]),
      [['trial', 'Pilot customer'], ['given', 'Pilot extended'], ['given', null], ['paid', null]]);
    assert.deepEqual(page.grants.map((g) => [g.moduleCode, g.kind, g.reason]), [[extraModule, 'given', 'Trying it']]);
    const paidOrder = page.orders.find((o) => o.id === order.id);
    assert.deepEqual([paidOrder.status, paidOrder.lines.length, paidOrder.payments.map((p) => p.status)], ['paid', 1, ['confirmed']]);
    assert.deepEqual(page.invoices.map((i) => [i.number, i.sample]), [[recorded.invoice.number, true]]);
    const done = await actions(hardware.id);
    for (const action of ['plan.addons_given', 'plan.time_given', 'plan.order_created', 'plan.payment_confirmed']) assert.ok(done.includes(action), action);
  });

  let confirmed;
  await t.test("payments: an owner's payment waits first; rejected with a reason or confirmed once through the routes", async () => {
    const owner = as(await login('owner@congrocery.invalid'));
    const plan = (route) => `/businesses/${trialShop.id}/plan${route}`;
    const order = await owner('POST', plan('/orders'), { kind: 'subscription' }, 201);
    const first = await owner('POST', plan(`/orders/${order.id}/payments`), { method: 'upi', reference: 'UTR777', paidOn: today }, 201);
    const queue = await platform('GET', P('/payments'));
    assert.deepEqual([queue.items[0].id, queue.items[0].status, queue.pendingCount, queue.sampleMode], [first.id, 'pending', 1, true]);
    assert.deepEqual([queue.items[0].businessName, queue.items[0].reference, queue.items[0].amount], ['Shop CON-TRIAL', 'UTR777', order.total]);
    await platform('POST', P(`/payments/${first.id}/reject`), {}, 400);
    const rejected = await platform('POST', P(`/payments/${first.id}/reject`), { reason: 'No such UTR in the bank' });
    assert.deepEqual([rejected.status, rejected.decisionNote], ['rejected', 'No such UTR in the bank']);
    await platform('POST', P(`/payments/${first.id}/reject`), { reason: 'Again' }, 409);
    await platform('POST', P(`/payments/${first.id}/confirm`), {}, 409);

    const second = await owner('POST', plan(`/orders/${order.id}/payments`), { method: 'upi', reference: 'UTR778', paidOn: today }, 201);
    confirmed = await platform('POST', P(`/payments/${second.id}/confirm`), {});
    assert.deepEqual([confirmed.payment.status, confirmed.order.status, confirmed.invoice.sample], ['confirmed', 'paid', true]);
    // Confirmed twice (a double click): the same invoice, nothing more.
    const again = await platform('POST', P(`/payments/${second.id}/confirm`), {});
    assert.equal(again.invoice.id, confirmed.invoice.id);
    assert.equal((await one('SELECT count(*)::int AS n FROM platform_invoices WHERE order_id=$1', [order.id])).n, 1);
    await platform('POST', P('/payments/999999999/confirm'), {}, 404);

    const done = (await platform('GET', P('/payments?status=confirmed&q=CON-TRIAL'))).items;
    assert.deepEqual(done.map((p) => [p.id, p.invoiceNumber, p.recorded]), [[second.id, confirmed.invoice.number, false]]);
    const turnedDown = (await platform('GET', P('/payments?status=rejected'))).items;
    assert.deepEqual(turnedDown.map((p) => [p.id, p.decisionNote]), [[first.id, 'No such UTR in the bank']]);
    const byPlatform = (await platform('GET', P('/payments?status=confirmed&q=CON-HARDWARE'))).items;
    assert.deepEqual(byPlatform.map((p) => [p.reference, p.recorded]), [['NEFT001', true]]);
    assert.equal((await platform('GET', P(`/payments?from=${addDays(today, 1)}`))).items.length, 0);
    await platform('GET', P('/payments?status=maybe'), undefined, 400);
    await platform('GET', P('/payments?from=yesterday'), undefined, 400);

    // An open order with no payment waits to be recorded.
    const open = await owner('POST', `/businesses/${plainShop.id}/plan/orders`, { kind: 'subscription' }, 201);
    assert.ok((await platform('GET', P('/payments'))).openOrders.some((o) => o.id === open.id && o.businessId === plainShop.id && o.total === open.total));
    await platform('POST', P(`/businesses/${plainShop.id}/payments`), { orderId: open.id, method: 'cash', reference: 'Cash at the office', paidOn: today }, 201);
    assert.ok(!(await platform('GET', P('/payments'))).openOrders.some((o) => o.id === open.id));
    const done2 = await actions(trialShop.id);
    for (const action of ['plan.payment_rejected', 'plan.payment_confirmed']) assert.ok(done2.includes(action), action);
  });

  await t.test('invoices: the register leaves the SAMPLE ones out unless asked; one to print; the tax invoice once the real GSTIN is saved', async () => {
    const register = await platform('GET', P('/invoices'));
    assert.deepEqual([register.items.length, register.sampleMode, register.truncated], [0, true, false]);
    const samples = await platform('GET', P('/invoices?sample=true'));
    assert.equal(samples.items.length, 3);
    assert.ok(samples.items.every((i) => i.sample && i.number.startsWith(`SAMPLE/${fy}/`)));
    const row = samples.items.find((i) => i.id === confirmed.invoice.id);
    assert.deepEqual([row.businessName, row.buyerName, row.placeOfSupplyCode, row.placeOfSupplyName, row.gstRate, row.taxable, row.igst, row.total],
      ['Shop CON-TRIAL', 'Shop CON-TRIAL', '29', 'Karnataka', '18.00', confirmed.invoice.taxable, confirmed.invoice.igst, confirmed.invoice.total]);
    assert.equal(row.buyerGstin, null);
    const printed = await platform('GET', P(`/invoices/${confirmed.invoice.id}`));
    assert.deepEqual([printed.number, printed.sample, printed.supplier.gstin, printed.businessName], [confirmed.invoice.number, true, '22AAAAA0000A1ZC', 'Shop CON-TRIAL']);
    assert.match(printed.signatory, /Console Soft Private Limited/);
    await platform('GET', P('/invoices/999999999'), undefined, 404);

    const sampleMode = await platform('POST', P(`/orders/${confirmed.order.id}/tax-invoice`), {}, 409);
    assert.equal(sampleMode.data.reason, 'sample_gstin');
    const saved = await platform('PUT', P('/settings'), { gstin: realGstin });
    assert.equal(saved.sampleGstin, false);
    const tax = await platform('POST', P(`/orders/${confirmed.order.id}/tax-invoice`), {}, 201);
    assert.deepEqual([tax.number, tax.sample, tax.total], [`BMP/${fy}/00001`, false, confirmed.invoice.total]);
    assert.ok(Number(tax.cgst) > 0 && tax.igst === '0.00', 'the real GSTIN is in Karnataka too');
    await platform('POST', P(`/orders/${confirmed.order.id}/tax-invoice`), {}, 409);
    await platform('POST', P('/orders/999999999/tax-invoice'), {}, 404);
    assert.ok((await actions(trialShop.id)).includes('plan.tax_invoice_issued'));

    const real = await platform('GET', P('/invoices'));
    assert.deepEqual([real.sampleMode, real.items.map((i) => [i.number, i.sample])], [false, [[`BMP/${fy}/00001`, false]]]);
    assert.deepEqual([real.totals.count, real.totals.taxable, real.totals.cgst, real.totals.sgst, real.totals.igst, real.totals.total],
      [1, tax.taxable, tax.cgst, tax.sgst, '0.00', tax.total]);
    assert.equal((await platform('GET', P(`/invoices?from=${addDays(today, 1)}`))).items.length, 0);
    assert.equal((await platform('GET', P(`/invoices?from=${today}&to=${today}`))).items.length, 1);
    assert.equal((await platform('GET', P('/invoices?sample=true'))).items.length, 3, 'the SAMPLE ones are still listed apart');
    await platform('GET', P('/invoices?from=today'), undefined, 400);
  });

  await t.test("a restaurant's business is switched off and on with its restaurant", async () => {
    const refused = await platform('PUT', P(`/businesses/${cafe.id}/status`), { status: 'inactive' }, 409);
    assert.match(refused.message, /Platform › Restaurants/);
    assert.equal((await one('SELECT status FROM businesses WHERE id=$1', [cafe.id])).status, 'active');
  });

  await t.test("a restaurant's people, and an owner of a shop, are refused every console route", async () => {
    const restaurant = await one("INSERT INTO restaurants(name,code) VALUES('Console Diner','CONDINER') RETURNING id");
    const person = async (email, role) => {
      const row = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [restaurant.id, email, email, hash]);
      await pool.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL', [row.id, role]);
      return as(await login(email));
    };
    // A restaurant's admin; a restaurant's user given the Super Admin role (the console's own check);
    // and a shop's owner, who is tied to no restaurant but is not the platform.
    const callers = [await person('admin@condiner.invalid', 'RESTAURANT_ADMIN'), await person('super@condiner.invalid', 'SUPER_ADMIN'), as(await login('owner@congrocery.invalid'))];
    const routes = [
      ['GET', '/settings'], ['PUT', '/settings', { trialDays: 7 }], ['GET', '/prices'], ['PUT', '/prices', {}],
      ['GET', `/businesses/${hardware.id}`], ['PUT', `/businesses/${hardware.id}/selection`, { planCode: 'hardware_basic', billingPeriod: 'year', addons: [] }],
      ['POST', `/businesses/${hardware.id}/given-time`, { noEnd: true, everything: true, reason: 'x' }],
      ['POST', `/businesses/${hardware.id}/given-addons`, { modules: [extraModule], endsOn: addDays(today, 10), reason: 'x' }],
      ['POST', `/businesses/${hardware.id}/orders`, { kind: 'subscription' }], ['POST', `/businesses/${hardware.id}/payments`, { orderId: 1, method: 'cash', reference: 'x', paidOn: today }],
      ['GET', '/payments'], ['POST', `/payments/${recorded.payment.id}/confirm`, {}], ['POST', `/payments/${recorded.payment.id}/reject`, { reason: 'x' }],
      ['GET', '/invoices'], ['GET', `/invoices/${confirmed.invoice.id}`], ['POST', `/orders/${confirmed.order.id}/tax-invoice`, {}],
    ];
    for (const [index, caller] of callers.entries()) {
      for (const [method, route, body] of routes) {
        const refused = await caller(method, P(route), body, 403);
        if (index === 1) assert.equal(refused.message, "The platform console is for the platform's own accounts", `${method} ${route}`);
      }
    }
    assert.equal((await one('SELECT trial_days FROM platform_settings')).trial_days, 14, 'nothing changed');
    assert.equal((await one("SELECT count(*)::int AS n FROM business_access_periods WHERE business_id=$1 AND kind='given' AND cancelled_at IS NULL", [hardware.id])).n, 1);
  });
});
