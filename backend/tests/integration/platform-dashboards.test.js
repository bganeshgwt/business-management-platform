const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { addDays } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The platform's dashboards read what paid plans recorded and change nothing:
// the overview (money from the company's tax invoices, the recurring income
// of the paying businesses, businesses by state, renewals due, what is left
// to do before going live), the free-trial funnel with the businesses behind
// each number, the leads with their follow-up and notes, and the sales,
// renewals and dues reports.
test('platform dashboards: the overview, the trial funnel, leads with notes, and the sales, renewals and dues reports', { timeout: 600000 }, async (t) => {
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
  const password = `Dash-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const platformRow = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id,name', ['Platform Admin', 'platform@dashboards.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformRow.id]);
  const platformUser = { id: platformRow.id, name: platformRow.name, restaurantId: null };
  const app = require('../../src/app');
  const svc = require('../../src/modules/platform/services/subscriptions.service');
  const planSettings = require('../../src/modules/platform/services/planSettings.service');
  const catalogue = require('../../src/modules/platform/services/planCatalogue.service');
  const math = require('../../src/modules/platform/services/planMath');
  const { gstinCheckCharacter } = require('../../src/utils/gstin');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email, secret = password) => (await signIn(base, email, secret))?.token || null;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return expected >= 400 ? result.body : result.body.data;
  };
  const platform = as(await login('platform@dashboards.invalid'));
  const D = (route) => `/users/platform${route}`;
  // The company's date (India); every business here keeps India's clock too.
  const today = (await one("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).d;
  const day = (n) => addDays(today, n);
  const [year, month] = today.split('-').map(Number);
  const fyStart = month >= 4 ? `${year}-04-01` : `${year - 1}-04-01`;
  const lastMonth15 = new Date(Date.UTC(year, month - 2, 15)).toISOString().slice(0, 10);
  const funnel = (query = '') => platform('GET', D(`/leads/funnel${query}`));
  const FIGURES = ['enquiries', 'enquiriesSignedUp', 'trialsStarted', 'fromEnquiries', 'direct', 'ownerAdded', 'platformAdded', 'activated', 'stillOnTrial',
    'continued', 'continuedDuringTrial', 'continuedAfterTrial', 'stopped', 'stoppedLast30', 'conversion', 'avgDaysToPay'];
  const figures = (answer) => Object.fromEntries(FIGURES.map((key) => [key, answer[key]]));

  await t.test('before going live: nothing collected yet, and what the company still has to fill in', async () => {
    const view = await platform('GET', D('/overview'));
    assert.equal(view.today, today);
    assert.deepEqual(view.todo, {
      paymentsToConfirm: 0, newEnquiries: 0, taxInvoicesToIssue: 0, companyProblems: ['legal name', 'address', 'city', 'PIN code'],
      sampleGstin: true, pricesReviewed: false, paymentDetailsMissing: true,
    });
    assert.deepEqual([view.money.today, view.money.thisMonth, view.money.lastMonth, view.money.thisFy, view.money.mrr, view.money.arr, view.money.payingBusinesses],
      ['0.00', '0.00', '0.00', '0.00', '0.00', '0.00', 0]);
    assert.equal(view.money.fyStart, fyStart);
    assert.equal(view.money.byMonth.length, 12);
    assert.deepEqual([view.money.byMonth[0].month, view.money.byMonth.at(-1).month], [new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 7), today.slice(0, 7)]);
    assert.ok(view.money.byMonth.every((m) => m.collected === '0.00' && m.beforeGst === '0.00'));
    assert.deepEqual(view.money.sampleInvoices, { count: 0, total: '0.00' });
    assert.deepEqual(view.states, { trial: 0, paid: 0, given: 0, grace: 0, checking: 0, ended: 0, off: 0 });
    assert.deepEqual(view.renewals, { in7: { count: 0, value: '0.00' }, in30: { count: 0, value: '0.00' }, endedThisMonthNotRenewed: 0 });
    assert.deepEqual([view.funnel30.trialsStarted, view.funnel30.conversion, view.funnel30.avgDaysToPay], [0, null, null]);
  });

  // --- The businesses and leads behind the numbers -----------------------------------------------

  // The company's details, all but the GSTIN, which stays the sample one for now.
  await pool.query("UPDATE platform_settings SET legal_name='Acme Soft Private Limited',address_line1='12 MG Road',city='Bengaluru',postal_code='560001' WHERE id=1");
  const first14 = '29AACCA1234B1Z';
  const realGstin = `${first14}${gstinCheckCharacter(first14)}`;
  // A business the platform sets up for an owner with a login of their own.
  const setUp = async (code, name, type, owner, stateCode = '29') => (await platform('POST', D('/businesses'), {
    businessType: type, name, code, stateCode, owner: { ...owner, password } }, 201)).business;
  // A trial from `startsIn` days from today (in the past when negative), in place of the one the business began with.
  const trialFrom = async (id, startsIn, days = 14) => {
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Moved by the test' WHERE business_id=$1 AND kind='trial' AND cancelled_at IS NULL", [id]);
    await pool.query("INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything) VALUES($1,'trial',$2::date,$2::date+$3::int-1,TRUE)", [id, day(startsIn), days]);
  };
  // A lead made `daysAgo` days ago, as the public site makes them.
  const lead = async (fields, daysAgo = 0) => (await one(`INSERT INTO platform_leads(source,name,mobile,email,business_name,business_type,city,state_code,message,ref,business_id,
      signed_up_at,consent_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11::bigint IS NULL THEN NULL ELSE now() END,now(),now()-make_interval(days => $12::int)) RETURNING id`,
  [fields.source, fields.name, fields.mobile || null, fields.email || null, fields.businessName || null, fields.businessType || null, fields.city || null,
    fields.stateCode || null, fields.message || null, fields.ref || null, fields.businessId || null, daysAgo])).id;
  const pay = (owner, businessId, order, paidOn) => owner('POST', `/businesses/${businessId}/plan/orders/${order.id}/payments`, { method: 'upi', reference: `UTR${order.id}`, paidOn }, 201);
  // Paid time made by SQL, with the paid order behind it, in place of any time the business had.
  const paidBySql = async (id, planCode, billingPeriod, taxable, from, to) => {
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [id]);
    const tax = math.gstSplit(math.toPaise(taxable), '18', '29', '29');
    const made = await one(`INSERT INTO platform_orders(business_id,kind,plan_code,billing_period,starts_on,ends_on,valid_until,buyer,supplier_state_code,place_of_supply_code,
        gst_rate,taxable_amount,cgst_amount,sgst_amount,total_amount,status,paid_at)
      VALUES($1,'subscription',$2,$3,business_local_today($1)+$4::int,business_local_today($1)+$5::int,business_local_today($1)+$4::int,'{"name":"Paid before"}','29','29',
        18,$6,$7,$7,$8,'paid',now()) RETURNING id`, [id, planCode, billingPeriod, from, to, taxable, math.toRupees(tax.cgst), math.toRupees(math.toPaise(taxable) + tax.cgst + tax.sgst)]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,plan_code,modules,order_id)
      SELECT $1,'paid',starts_on,ends_on,plan_code,modules,id FROM platform_orders WHERE id=$2`, [id, made.id]);
  };

  // Given time until a date, set up by the platform, with a renewal paid in sample mode: a SAMPLE invoice.
  const given = await setUp('DASH-GIVEN', 'Given Hardware', 'hardware', { email: 'suresh@given.invalid', name: 'Suresh B', mobile: '9876501010' });
  await svc.giveTime(platformUser, given.id, { endsOn: day(60), planCode: 'hardware_basic', reason: 'Pilot customer', replaceTrial: true });
  const givenOrder = await svc.createOrder({ id: given.id }, platformUser, { kind: 'subscription' }, { by: 'platform' });
  const sampled = await svc.recordPayment(platformUser, given.id, givenOrder.id, { method: 'bank', reference: 'NEFT-GIVEN', paidOn: today });
  assert.deepEqual([sampled.invoice.sample, sampled.invoice.total], [true, '5898.82']);
  // The real GSTIN, in Karnataka: every invoice from here on is a tax invoice.
  await planSettings.update(platformUser, { gstin: realGstin });

  // A sign-up from Facebook that paid during its trial: monthly, in Karnataka (CGST and SGST).
  const paidEarly = await setUp('DASH-PAID-EARLY', 'Paid Early Supermart', 'supermarket', { email: 'ritu@paidearly.invalid', name: 'Ritu S', mobile: '9876501001' });
  await trialFrom(paidEarly.id, -20);
  await lead({ source: 'signup', name: 'Ritu S', mobile: '9876501001', email: 'ritu@paidearly.invalid', businessName: 'Paid Early Supermart', businessType: 'supermarket',
    city: 'Bengaluru', stateCode: '29', ref: 'facebook', businessId: paidEarly.id }, 21);
  const ritu = as(await login('ritu@paidearly.invalid'));
  await ritu('PUT', `/businesses/${paidEarly.id}/plan/selection`, { planCode: 'supermarket_basic', billingPeriod: 'month', addons: [] });
  const earlyOrder = await ritu('POST', `/businesses/${paidEarly.id}/plan/orders`, { kind: 'subscription' }, 201);
  assert.deepEqual([earlyOrder.startsOn, earlyOrder.taxable, earlyOrder.total], [today, '799.00', '942.82']);
  const earlyPaid = await svc.applyPayment(platformUser, (await pay(ritu, paidEarly.id, earlyOrder, day(-10))).id);
  assert.deepEqual([earlyPaid.invoice.sample, earlyPaid.invoice.total], [false, '942.82']);

  // An enquiry that signed up and paid after its trial ended: yearly, in Maharashtra (IGST).
  const paidLate = await setUp('DASH-PAID-LATE', 'Paid Late Kirana', 'grocery', { email: 'arun@paidlate.invalid', name: 'Arun K', mobile: '9876501002' }, '27');
  await trialFrom(paidLate.id, -30);
  const arunLead = await lead({ source: 'enquiry', name: 'Arun K', mobile: '9876501002', businessName: 'Paid Late Kirana', businessType: 'grocery', city: 'Pune', stateCode: '27',
    message: 'Please call after 6 pm', businessId: paidLate.id }, 35);
  const arun = as(await login('arun@paidlate.invalid'));
  await arun('PUT', `/businesses/${paidLate.id}/plan/selection`, { planCode: 'grocery_basic', billingPeriod: 'year', addons: [] });
  const lateOrder = await arun('POST', `/businesses/${paidLate.id}/plan/orders`, { kind: 'subscription' }, 201);
  assert.deepEqual([lateOrder.startsOn, lateOrder.total], [today, '5898.82']);
  const latePaid = await svc.applyPayment(platformUser, (await pay(arun, paidLate.id, lateOrder, day(-10))).id);

  // A grocery the platform set up on a 7-day trial; its owner then adds a bookshop of her own, whose trial ended 40 days ago.
  await pool.query('UPDATE platform_settings SET trial_days=7 WHERE id=1');
  let sevenDay;
  try {
    sevenDay = await setUp('DASH-SEVEN', 'Seven Day Kirana', 'grocery', { email: 'lakshmi@sevenday.invalid', name: 'Lakshmi N', mobile: '9876501006' });
  } finally { await pool.query('UPDATE platform_settings SET trial_days=14 WHERE id=1'); }
  const lakshmi = as(await login('lakshmi@sevenday.invalid'));
  const stopped = await lakshmi('POST', '/businesses', { businessType: 'books', name: 'Stopped Books', code: 'DASH-STOPPED' }, 201);
  await trialFrom(stopped.id, -53);

  // A sign-up from Google still on trial that has made its first sale.
  const firstSale = await setUp('DASH-SALE', 'First Sale Salon', 'salon', { email: 'kiran@firstsale.invalid', name: 'Kiran P', mobile: '9876501004' });
  await trialFrom(firstSale.id, -5);
  await lead({ source: 'signup', name: 'Kiran P', mobile: '9876501004', businessName: 'First Sale Salon', businessType: 'salon', city: 'Bengaluru', stateCode: '29', ref: 'Google',
    businessId: firstSale.id }, 6);
  const kiran = as(await login('kiran@firstsale.invalid'));
  const salonAt = (await kiran('GET', `/businesses/${firstSale.id}/locations`)).items[0];
  const cut = await kiran('POST', `/businesses/${firstSale.id}/catalog`, { kind: 'service', name: 'Haircut', code: 'CUT', unit: 'service', price: '300', taxRate: '18' }, 201);
  await kiran('POST', `/businesses/${firstSale.id}/documents`, { kind: 'sale', locationId: salonAt.id, requestKey: crypto.randomUUID(), lines: [{ skuId: cut.id, quantity: '1' }] }, 201);

  // A restaurant the platform set up, on its trial, that has billed its first order.
  const diner = await platform('POST', D('/restaurants'), { name: 'First Bill Diner', code: 'DASHDINER', admin: { name: 'Farah Q', email: 'farah@firstbill.invalid', mobile: '9876501005', password } }, 201);
  const farah = as(await login('farah@firstbill.invalid'));
  const rate = await farah('POST', '/menu/tax-rates', { name: 'Food 5%', percentage: 5, hsnCode: '9963' }, 201);
  const category = await farah('POST', '/menu/categories', { name: 'Mains' }, 201);
  const dish = await farah('POST', '/menu/products', { categoryId: category.id, name: 'Dal Tadka', price: 200, taxRateId: rate.id, isAvailable: true }, 201);
  await farah('POST', '/business-day/open', { openingCash: 0 }, 201);
  const takeaway = await farah('POST', '/orders', { orderType: 'takeaway', items: [{ productId: dish.id, quantity: 1 }] }, 201);
  await farah('POST', '/bills', { orderId: takeaway.id }, 201);
  assert.ok(await one("SELECT 1 FROM businesses WHERE legacy_restaurant_id=$1 AND business_type='restaurant'", [diner.id]));

  // Call-back requests: today, 10 days ago and 70 days ago.
  const meenaLead = await lead({ source: 'enquiry', name: 'Meena R', mobile: '9876501011', email: 'meena@stores.invalid', businessName: 'Meena Stores', businessType: 'grocery',
    city: 'Mysuru', ref: 'facebook', message: 'Call me about billing' }, 0);
  await lead({ source: 'enquiry', name: 'Neha T', mobile: '9876501013', businessType: 'salon', city: 'Pune' }, 10);
  await lead({ source: 'enquiry', name: 'Old Enquiry', mobile: '9876501014', businessType: 'books', city: 'Delhi' }, 70);

  await t.test('the trial funnel: trials started and where from, a first sale, still on trial, continued (paid) and stopped, and the enquiries', async () => {
    const wide = await funnel(`?from=${day(-60)}&to=${today}`);
    assert.deepEqual([wide.from, wide.to], [day(-60), today]);
    assert.deepEqual(figures(wide), {
      enquiries: 3, enquiriesSignedUp: 1, trialsStarted: 6, fromEnquiries: 1, direct: 2, ownerAdded: 1, platformAdded: 2, activated: 2, stillOnTrial: 3,
      continued: 2, continuedDuringTrial: 1, continuedAfterTrial: 1, stopped: 1, stoppedLast30: 0, conversion: '66.67', avgDaysToPay: 15,
    });
    // Without dates: the trials that started in the last 30 days, as the overview counts them.
    const recent = await funnel();
    assert.deepEqual([recent.from, recent.to], [day(-29), today]);
    assert.deepEqual(figures(recent), {
      enquiries: 2, enquiriesSignedUp: 0, trialsStarted: 4, fromEnquiries: 0, direct: 2, ownerAdded: 0, platformAdded: 2, activated: 2, stillOnTrial: 3,
      continued: 1, continuedDuringTrial: 1, continuedAfterTrial: 0, stopped: 0, stoppedLast30: 0, conversion: '100.00', avgDaysToPay: 10,
    });
    // What the filters can be set to.
    assert.ok(recent.choices.types.some((type) => type.code === 'grocery'));
    assert.ok(recent.choices.plans.some((plan) => plan.code === 'supermarket_basic' && plan.businessType === 'supermarket'));
    assert.deepEqual(recent.choices.refs, ['facebook', 'google']);
    assert.deepEqual(recent.choices.trialLengths, [7, 14]);
    assert.ok(recent.choices.states.some((state) => state.code === '29' && state.name === 'Karnataka'));
    const stateNames = recent.choices.states.map((state) => state.name);
    assert.deepEqual(stateNames, [...stateNames].sort((a, b) => a.localeCompare(b)), 'the states A to Z');
  });

  await t.test('each number splits by type, state, source, plan and trial length', async () => {
    const range = `?from=${day(-60)}&to=${today}`;
    const grocery = await funnel(`${range}&type=grocery`);
    assert.deepEqual([grocery.trialsStarted, grocery.continued, grocery.stillOnTrial, grocery.stopped, grocery.conversion, grocery.enquiries, grocery.enquiriesSignedUp],
      [2, 1, 1, 0, '100.00', 2, 1]);
    const facebook = await funnel(`${range}&ref=FaceBook`);
    assert.deepEqual([facebook.trialsStarted, facebook.continuedDuringTrial, facebook.enquiries], [1, 1, 1]);
    const maharashtra = await funnel(`${range}&state=27`);
    assert.deepEqual([maharashtra.trialsStarted, maharashtra.continuedAfterTrial, maharashtra.enquiries], [1, 1, 1]);
    // Enquiries have no plan or trial length: those filters leave them out.
    const supermarket = await funnel(`${range}&plan=supermarket_basic`);
    assert.deepEqual([supermarket.trialsStarted, supermarket.continued, supermarket.enquiries, supermarket.enquiriesSignedUp], [1, 1, null, null]);
    const week = await funnel(`${range}&trialDays=7`);
    assert.deepEqual([week.trialsStarted, week.stillOnTrial, week.platformAdded, week.enquiries], [1, 1, 1, null]);
    assert.deepEqual(week.filters, { type: null, state: null, ref: null, plan: null, trialDays: 7 });

    const byType = await funnel(`${range}&by=type`);
    assert.deepEqual(byType.groups.map((g) => [g.key, g.trialsStarted, g.activated, g.stillOnTrial, g.continued, g.stopped, g.conversion]), [
      ['grocery', 2, 0, 1, 1, 0, '100.00'], ['books', 1, 0, 0, 0, 1, '0.00'], ['restaurant', 1, 1, 1, 0, 0, null], ['salon', 1, 1, 1, 0, 0, null],
      ['supermarket', 1, 0, 0, 1, 0, '100.00']]);
    assert.ok(byType.groups.every((g) => typeof g.label === 'string' && g.label.length > 0));
    const byLength = await funnel(`${range}&by=trialDays`);
    assert.deepEqual(byLength.groups.map((g) => [g.key, g.label, g.trialsStarted]), [['14', '14 days', 5], ['7', '7 days', 1]]);
    const bySource = await funnel(`${range}&by=ref`);
    assert.deepEqual(bySource.groups.map((g) => [g.key, g.trialsStarted, g.continued]), [[null, 4, 1], ['facebook', 1, 1], ['google', 1, 0]]);
    const byState = await funnel(`${range}&by=state`);
    assert.deepEqual(byState.groups.find((g) => g.key === '27'), { key: '27', label: 'Maharashtra', trialsStarted: 1, activated: 0, stillOnTrial: 0, continued: 1, stopped: 0, conversion: '100.00' });
    const byPlan = await funnel(`${range}&by=plan`);
    assert.deepEqual(byPlan.groups.find((g) => g.key === 'grocery_basic').trialsStarted, 2);

    for (const bad of ['?from=2026-02-30', `?from=${today}&to=${day(-1)}`, '?list=everyone', '?by=colour', '?trialDays=0', '?trialDays=1.5', '?state=00', '?state=Karnataka']) {
      await platform('GET', D(`/leads/funnel${bad}`), undefined, 400);
    }
  });

  await t.test('every number opens the businesses behind it: the owner to call, the trial dates and how it went', async () => {
    const list = (bucket, extra = '') => funnel(`?from=${day(-60)}&to=${today}&list=${bucket}${extra}`);
    const ended = await list('stopped');
    assert.equal(ended.bucket, 'stopped');
    assert.deepEqual(ended.items.map((i) => [i.name, i.ownerName, i.ownerMobile, i.trialStartsOn, i.trialEndsOn, i.trialDays, i.outcome, i.source, i.state, i.firstSaleOn]),
      [['Stopped Books', 'Lakshmi N', '9876501006', day(-53), day(-40), 14, 'stopped', 'owner', 'ended', null]]);
    const during = await list('continuedDuringTrial');
    assert.deepEqual(during.items.map((i) => [i.name, i.paidOn, i.daysToPay, i.outcome, i.source, i.ref, i.planCode, i.state, i.ownerEmail]),
      [['Paid Early Supermart', day(-10), 10, 'continued', 'signup', 'facebook', 'supermarket_basic', 'paid', 'ritu@paidearly.invalid']]);
    const after = await list('continuedAfterTrial');
    assert.deepEqual(after.items.map((i) => [i.name, i.paidOn, i.daysToPay, i.source, i.stateCode, i.stateName, i.leadId]),
      [['Paid Late Kirana', day(-10), 20, 'enquiry', '27', 'Maharashtra', arunLead]]);
    const activated = await list('activated');
    assert.deepEqual(activated.items.map((i) => [i.name, i.firstSaleOn, i.ownerName, i.ownerMobile, i.outcome]).sort(),
      [['First Bill Diner', today, 'Farah Q', '9876501005', 'on_trial'], ['First Sale Salon', today, 'Kiran P', '9876501004', 'on_trial']]);
    // Counts and dates only: nothing of what a business sold.
    for (const item of activated.items) assert.deepEqual(Object.keys(item).filter((key) => /amount|total|price|bill|customer|sale(?!On)/i.test(key)), []);
    assert.deepEqual((await list('stillOnTrial')).items.map((i) => [i.name, i.trialDays]).sort(),
      [['First Bill Diner', 14], ['First Sale Salon', 14], ['Seven Day Kirana', 7]]);
    assert.deepEqual((await list('platformAdded')).items.map((i) => i.name).sort(), ['First Bill Diner', 'Seven Day Kirana']);
    assert.deepEqual((await list('trialsStarted', '&type=grocery')).items.map((i) => i.name).sort(), ['Paid Late Kirana', 'Seven Day Kirana']);
    const enquiries = await list('enquiries');
    assert.deepEqual(enquiries.items.map((i) => i.name).sort(), ['Arun K', 'Meena R', 'Neha T']);
    const signedUp = await list('enquiriesSignedUp');
    assert.deepEqual(signedUp.items.map((i) => [i.name, i.mobile, i.business.name, i.business.state, i.outcome]), [['Arun K', '9876501002', 'Paid Late Kirana', 'paid', 'paid']]);
  });

  await t.test('the overview: money from tax invoices only, recurring income from paying businesses, businesses by state, renewals and what is left to do', async () => {
    const view = await platform('GET', D('/overview'));
    assert.deepEqual(view.states, { trial: 3, paid: 2, given: 1, grace: 0, checking: 0, ended: 1, off: 0 });
    // Monthly 799 plus a year's 4,999 over 12 (416.58); given time and trials bring nothing.
    assert.deepEqual([view.money.mrr, view.money.arr, view.money.payingBusinesses], ['1215.58', '14587.00', 2]);
    assert.deepEqual([view.money.today, view.money.thisMonth, view.money.lastMonth, view.money.thisFy, view.money.beforeGstThisMonth, view.money.gstThisMonth],
      ['6841.64', '6841.64', '0.00', '6841.64', '5798.00', '1043.64']);
    assert.deepEqual(view.money.byMonth.at(-1), { month: today.slice(0, 7), collected: '6841.64', beforeGst: '5798.00' });
    assert.deepEqual(view.money.sampleInvoices, { count: 1, total: '5898.82' });
    assert.deepEqual(view.renewals, { in7: { count: 0, value: '0.00' }, in30: { count: 1, value: '799.00' }, endedThisMonthNotRenewed: 0 });
    assert.deepEqual(view.todo, {
      paymentsToConfirm: 0, newEnquiries: 4, taxInvoicesToIssue: 1, companyProblems: [], sampleGstin: false, pricesReviewed: false, paymentDetailsMissing: true,
    });
    // The last 30 days' funnel, as Leads & trials shows it unfiltered.
    assert.deepEqual(figures(view.funnel30), figures(await funnel()));
  });

  await t.test('leads: each with its business and how it went, its follow-up and notes, each change in the platform\'s audit', async () => {
    const leads = (query = '') => platform('GET', D(`/leads${query}`));
    const everyone = await leads();
    assert.equal(everyone.total, 6);
    assert.deepEqual(everyone.items.map((l) => l.name), ['Meena R', 'Kiran P', 'Neha T', 'Ritu S', 'Arun K', 'Old Enquiry']);
    const meena = everyone.items.find((l) => l.id === meenaLead);
    assert.deepEqual([meena.source, meena.status, meena.business, meena.outcome, meena.mobile, meena.city, meena.ref, meena.message, meena.typeName.length > 0, meena.notes],
      ['enquiry', 'new', null, 'not_signed_up', '9876501011', 'Mysuru', 'facebook', 'Call me about billing', true, []]);
    const arunRow = everyone.items.find((l) => l.id === arunLead);
    assert.deepEqual([arunRow.business.name, arunRow.business.code, arunRow.outcome, arunRow.stateName], ['Paid Late Kirana', 'DASH-PAID-LATE', 'paid', 'Maharashtra']);
    assert.deepEqual((await leads('?source=enquiry')).items.map((l) => l.name), ['Meena R', 'Neha T', 'Arun K', 'Old Enquiry']);
    assert.deepEqual((await leads('?q=MEENA')).items.map((l) => l.id), [meenaLead]);
    assert.deepEqual((await leads(`?from=${day(-30)}&to=${today}`)).items.map((l) => l.name), ['Meena R', 'Kiran P', 'Neha T', 'Ritu S']);
    await platform('GET', D('/leads?status=lost'), undefined, 400);
    await platform('GET', D('/leads?from=2026-13-01'), undefined, 400);

    const contacted = await platform('PUT', D(`/leads/${meenaLead}`), { status: 'contacted' });
    assert.deepEqual([contacted.id, contacted.status], [meenaLead, 'contacted']);
    // The same again changes nothing and is written once.
    assert.equal((await platform('PUT', D(`/leads/${meenaLead}`), { status: 'contacted' })).status, 'contacted');
    assert.deepEqual((await all("SELECT action,entity_id,details,actor_id FROM platform_audit WHERE entity_type='platform_lead' ORDER BY id")).map((a) => [a.action, a.entity_id, a.details, a.actor_id]),
      [['platform.lead_status_changed', meenaLead, { from: 'new', to: 'contacted' }, platformRow.id]]);
    await platform('PUT', D(`/leads/${meenaLead}`), { status: 'lost' }, 400);
    await platform('PUT', D('/leads/99999999'), { status: 'contacted' }, 404);
    await platform('PUT', D('/leads/abc'), { status: 'contacted' }, 400);

    const note = await platform('POST', D(`/leads/${meenaLead}/notes`), { note: '  Called; she starts after Diwali.  ' }, 201);
    assert.deepEqual([note.note, note.by, typeof note.createdAt], ['Called; she starts after Diwali.', 'Platform Admin', 'string']);
    await platform('POST', D(`/leads/${meenaLead}/notes`), { note: '   ' }, 400);
    await platform('POST', D(`/leads/${meenaLead}/notes`), { note: 'x'.repeat(2001) }, 400);
    await platform('POST', D('/leads/99999999/notes'), { note: 'Nobody' }, 404);
    const shown = (await leads('?q=meena')).items[0];
    assert.deepEqual([shown.status, shown.notes.map((n) => [n.id, n.note, n.by])], ['contacted', [[note.id, 'Called; she starts after Diwali.', 'Platform Admin']]]);
    assert.ok(await one("SELECT 1 FROM platform_audit WHERE action='platform.lead_note_added' AND entity_type='platform_lead' AND entity_id=$1 AND (details->>'noteId')::bigint=$2 AND actor_id=$3",
      [meenaLead, note.id, platformRow.id]));
    assert.deepEqual((await leads('?status=contacted')).items.map((l) => l.id), [meenaLead]);
  });

  let staleOrder, waitingOrder;
  await t.test('renewals, an add-on, a lapsed business and orders not paid move the overview', async () => {
    // Paid Late Kirana adds offers for the rest of its year, then renews early (offers with it).
    const addOn = await arun('POST', `/businesses/${paidLate.id}/plan/orders`, { kind: 'add_on', modules: ['offers'] }, 201);
    assert.deepEqual([addOn.taxable, addOn.igst, addOn.total], ['1999.00', '359.82', '2358.82']);
    await svc.applyPayment(platformUser, (await pay(arun, paidLate.id, addOn, today)).id);
    const renewal = await arun('POST', `/businesses/${paidLate.id}/plan/orders`, { kind: 'subscription' }, 201);
    assert.deepEqual([renewal.taxable, renewal.total], ['6998.00', '8257.64']);
    await svc.applyPayment(platformUser, (await pay(arun, paidLate.id, renewal, today)).id);
    // Its first invoice was issued in the middle of last month.
    await pool.query('ALTER TABLE platform_invoices DISABLE TRIGGER platform_invoices_kept');
    try { await pool.query('UPDATE platform_invoices SET issued_on=$2 WHERE id=$1', [latePaid.invoice.id, lastMonth15]); }
    finally { await pool.query('ALTER TABLE platform_invoices ENABLE TRIGGER platform_invoices_kept'); }
    // Paid time ending in 5 days, and paid time that ended yesterday (in grace).
    const soon = await setUp('DASH-RENEW-SOON', 'Renew Soon Kirana', 'grocery', { email: 'rahul@renewsoon.invalid', name: 'Rahul D', mobile: '9876501020' });
    await paidBySql(soon.id, 'grocery_basic', 'month', '499.00', -25, 5);
    const lapsed = await setUp('DASH-LAPSED', 'Lapsed Salon', 'salon', { email: 'gita@lapsed.invalid', name: 'Gita M', mobile: '9876501021' });
    await paidBySql(lapsed.id, 'salon_basic', 'month', '599.00', -30, -1);
    await pool.query("UPDATE business_subscriptions SET billing_period='month' WHERE business_id IN ($1,$2)", [soon.id, lapsed.id]);
    // The salon on trial orders and pays: a payment to confirm. The bookshop's order of 45 days ago was never paid.
    waitingOrder = await kiran('POST', `/businesses/${firstSale.id}/plan/orders`, { kind: 'subscription' }, 201);
    assert.deepEqual([waitingOrder.taxable, waitingOrder.total], ['5999.00', '7078.82']);
    await pay(kiran, firstSale.id, waitingOrder, today);
    staleOrder = await one(`INSERT INTO platform_orders(business_id,kind,plan_code,billing_period,starts_on,ends_on,valid_until,buyer,supplier_state_code,place_of_supply_code,
        gst_rate,taxable_amount,igst_amount,total_amount,created_at)
      VALUES($1,'subscription','books_basic','month',business_local_today($1)-45,business_local_today($1)-16,business_local_today($1)-38,'{"name":"Stopped Books"}','29','27',
        18,499.00,89.82,588.82,now()-interval '45 days') RETURNING id`, [stopped.id]);
    // The payment details and the price list.
    await planSettings.update(platformUser, { upiId: 'acme@okaxis' });
    await catalogue.update(platformUser, {});

    const view = await platform('GET', D('/overview'));
    assert.deepEqual(view.states, { trial: 3, paid: 3, given: 1, grace: 1, checking: 0, ended: 1, off: 0 });
    // 799 + 4,999 / 12 + offers' 1,999 / 12 + 499 + 599 (in grace, still paying).
    assert.deepEqual([view.money.mrr, view.money.arr, view.money.payingBusinesses], ['2480.17', '29762.00', 4]);
    assert.deepEqual([view.money.today, view.money.thisMonth, view.money.lastMonth, view.money.beforeGstThisMonth, view.money.gstThisMonth],
      ['11559.28', '11559.28', '5898.82', '9796.00', '1763.28']);
    assert.equal(view.money.thisFy, lastMonth15 >= fyStart ? '17458.10' : '11559.28');
    assert.deepEqual(view.money.byMonth.slice(-2).map((m) => [m.month, m.collected]), [[lastMonth15.slice(0, 7), '5898.82'], [today.slice(0, 7), '11559.28']]);
    const lapsedThisMonth = day(-1).slice(0, 7) === today.slice(0, 7);
    assert.deepEqual(view.renewals, { in7: { count: 1, value: '499.00' }, in30: { count: 2, value: '1298.00' }, endedThisMonthNotRenewed: lapsedThisMonth ? 1 : 0 });
    assert.deepEqual(view.todo, {
      paymentsToConfirm: 1, newEnquiries: 3, taxInvoicesToIssue: 1, companyProblems: [], sampleGstin: false, pricesReviewed: true, paymentDetailsMissing: false,
    });
    // An order with a payment being checked keeps the salon on its trial.
    assert.deepEqual(figures(await funnel(`?from=${day(-60)}&to=${today}`)), {
      enquiries: 3, enquiriesSignedUp: 1, trialsStarted: 6, fromEnquiries: 1, direct: 2, ownerAdded: 1, platformAdded: 2, activated: 2, stillOnTrial: 3,
      continued: 2, continuedDuringTrial: 1, continuedAfterTrial: 1, stopped: 1, stoppedLast30: 0, conversion: '66.67', avgDaysToPay: 15,
    });
  });

  await t.test('the sales report by each dimension, from tax invoices alone', async () => {
    const range = `from=${lastMonth15.slice(0, 8)}01&to=${today}`;
    const sales = (by) => platform('GET', D(`/reports/sales?${range}&by=${by}`));
    const byPlan = await sales('plan');
    assert.deepEqual(byPlan.rows.map((r) => [r.key, r.invoices, r.taxable]), [['grocery_basic', 2, '9998.00'], ['supermarket_basic', 1, '799.00']]);
    assert.ok(byPlan.rows.every((r) => r.label.startsWith('Basic')));
    assert.deepEqual(byPlan.totals, { invoices: 4, taxable: '14795.00', gst: '2663.10', total: '17458.10' });
    assert.deepEqual(byPlan.sample, { invoices: 1, total: '5898.82' });
    assert.deepEqual(byPlan.rows.map((r) => r.gst), [null, null]);
    assert.deepEqual((await sales('module')).rows.map((r) => [r.key, r.label, r.invoices, r.taxable]), [['offers', 'Offers & discounts', 2, '3998.00']]);
    assert.deepEqual((await sales('application')).rows, []);
    assert.deepEqual((await sales('type')).rows.map((r) => [r.key, r.invoices, r.taxable, r.gst, r.total]),
      [['grocery', 3, '13996.00', '2519.28', '16515.28'], ['supermarket', 1, '799.00', '143.82', '942.82']]);
    assert.deepEqual((await sales('state')).rows.map((r) => [r.key, r.label, r.invoices, r.taxable]), [['27', 'Maharashtra', 3, '13996.00'], ['29', 'Karnataka', 1, '799.00']]);
    assert.deepEqual((await sales('kind')).rows.map((r) => [r.key, r.label, r.invoices, r.taxable]),
      [['new', 'New', 2, '5798.00'], ['renewal', 'Renewal', 1, '6998.00'], ['add_on', 'Add-on', 1, '1999.00']]);
    assert.deepEqual((await sales('period')).rows.map((r) => [r.key, r.label, r.invoices, r.taxable]), [['year', 'Yearly', 3, '13996.00'], ['month', 'Monthly', 1, '799.00']]);
    assert.deepEqual((await sales('month')).rows.map((r) => [r.key, r.invoices, r.taxable, r.total]),
      [[lastMonth15.slice(0, 7), 1, '4999.00', '5898.82'], [today.slice(0, 7), 3, '9796.00', '11559.28']]);
    // Unasked, this financial year by month.
    const plain = await platform('GET', D('/reports/sales'));
    assert.deepEqual([plain.from, plain.to, plain.by], [fyStart, today, 'month']);
    for (const bad of ['?by=colour', '?from=2026-13-01', `?from=${today}&to=${day(-1)}`]) await platform('GET', D(`/reports/sales${bad}`), undefined, 400);
  });

  await t.test('renewals due with what each is worth, and orders not paid by how old they are', async () => {
    const monthEnd = math.periodEnd(today, 'month');
    const due = await platform('GET', D('/reports/renewals?within=30'));
    assert.equal(due.within, 30);
    assert.deepEqual(due.items.map((r) => [r.name, r.state, r.endsOn, r.daysLeft, r.value, r.planCode, r.billingPeriod, r.ownerName, r.ownerMobile]), [
      ['Lapsed Salon', 'grace', day(-1), -1, '599.00', 'salon_basic', 'month', 'Gita M', '9876501021'],
      ['Renew Soon Kirana', 'paid', day(5), 5, '499.00', 'grocery_basic', 'month', 'Rahul D', '9876501020'],
      ['Paid Early Supermart', 'paid', monthEnd, math.daysBetweenInclusive(today, monthEnd) - 1, '799.00', 'supermarket_basic', 'month', 'Ritu S', '9876501001']]);
    assert.deepEqual(due.totals, { count: 3, value: '1897.00' });
    assert.deepEqual((await platform('GET', D('/reports/renewals?within=7'))).items.map((r) => r.name), ['Lapsed Salon', 'Renew Soon Kirana']);
    assert.equal((await platform('GET', D('/reports/renewals'))).within, 30);
    for (const bad of ['0', '366', 'soon']) await platform('GET', D(`/reports/renewals?within=${bad}`), undefined, 400);

    const dues = await platform('GET', D('/reports/dues'));
    assert.deepEqual(dues.items.map((o) => [o.orderId, o.name, o.ageDays, o.band, o.total, o.checking, o.expired, o.ownerName]), [
      [staleOrder.id, 'Stopped Books', 45, '31-60', '588.82', false, true, 'Lakshmi N'],
      [waitingOrder.id, 'First Sale Salon', 0, '0-30', '7078.82', true, false, 'Kiran P']]);
    assert.deepEqual(dues.bands.map((b) => [b.band, b.count, b.total]), [['0-30', 1, '7078.82'], ['31-60', 1, '588.82'], ['61-90', 0, '0.00'], ['90+', 0, '0.00']]);
    assert.deepEqual(dues.totals, { count: 2, total: '7667.64' });
  });

  await t.test('only the platform\'s own super admin sees the dashboards', async () => {
    await farah('GET', D('/overview'), undefined, 403);
    await lakshmi('GET', D('/leads/funnel'), undefined, 403);
    assert.equal((await call('GET', D('/overview'))).status, 401);
    // A restaurant's login given the platform's role is still refused.
    await pool.query(`INSERT INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u, roles r
      WHERE u.email='farah@firstbill.invalid' AND r.code='SUPER_ADMIN' AND r.restaurant_id IS NULL`);
    try {
      const refused = await as(await login('farah@firstbill.invalid'))('GET', D('/reports/dues'), undefined, 403);
      assert.match(refused.message, /platform's own accounts/);
    } finally {
      await pool.query(`DELETE FROM user_roles WHERE user_id=(SELECT id FROM users WHERE email='farah@firstbill.invalid')
        AND role_id=(SELECT id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL)`);
    }
  });

  await t.test('reading the dashboards changes nothing', async () => {
    const counts = () => one(`SELECT (SELECT count(*) FROM platform_audit)::int AS platform, (SELECT count(*) FROM business_audit)::int AS business,
      (SELECT count(*) FROM platform_orders)::int AS orders, (SELECT count(*) FROM platform_payments)::int AS payments, (SELECT count(*) FROM platform_invoices)::int AS invoices,
      (SELECT count(*) FROM business_access_periods)::int AS periods, (SELECT count(*) FROM platform_leads)::int AS leads, (SELECT max(updated_at) FROM platform_leads) AS touched`);
    const before = await counts();
    for (const route of ['/overview', '/leads/funnel', '/leads/funnel?list=trialsStarted', '/leads/funnel?by=type', '/leads', '/reports/sales', '/reports/renewals', '/reports/dues']) {
      await platform('GET', D(route));
    }
    assert.deepEqual(await counts(), before);
  });
});
