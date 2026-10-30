const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { today: todayIn, addDays, daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Paid plans, the money: the owner's selection and orders (lines, GST, the
// date paid time starts), payments entered by reference and confirmed once
// by the super admin (an invoice, a paid period or add-on grants), sample
// invoices before the real GSTIN and the tax invoice after it, given time and
// given add-ons, and the switches a plan does not unlock.
test('paid plans: orders, payments by reference, GST invoices with a sample series, given time and add-ons', { timeout: 600000 }, async (t) => {
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
  const password = `Plans-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const platformRow = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id,name', ['Platform Admin', 'platform@plans.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformRow.id]);
  const platformUser = { id: platformRow.id, name: platformRow.name, restaurantId: null };
  const app = require('../../src/app');
  const svc = require('../../src/modules/platform/services/subscriptions.service');
  const planSettings = require('../../src/modules/platform/services/planSettings.service');
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
  const as = (auth) => {
    const send = async (method, route, body, expected = 200) => {
      const result = await call(method, route, body, auth);
      assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
      return expected >= 400 ? result.body : result.body.data;
    };
    return send;
  };
  const platform = as(await login('platform@plans.invalid'));
  // The company's details, all but the GSTIN, which stays the sample one (state 22).
  await pool.query(`UPDATE platform_settings SET legal_name='Acme Soft Private Limited',address_line1='12 MG Road',city='Bengaluru',postal_code='560001',
    upi_id='acme@okaxis',upi_payee_name='Acme Soft',bank_name='State Bank of India',bank_account_name='Acme Soft Private Limited',bank_account_number='12345678901',
    bank_ifsc='SBIN0001234',support_email='help@acme.invalid' WHERE id=1`);
  const ownerEmail = 'owner@plankirana.invalid';
  const shopBody = (code, name, type = 'grocery', extra = {}) => ({ businessType: type, name, code, stateCode: '29', owner: { email: ownerEmail, name: 'Lakshmi N', password }, ...extra });
  const shop = (await platform('POST', '/users/platform/businesses', shopBody('PLAN-KIRANA', 'Plan Kirana'), 201)).business;
  const owner = as(await login(ownerEmail));
  const P = (suffix = '', id = shop.id) => `/businesses/${id}/plan${suffix}`;
  const today = (await one('SELECT business_local_today($1)::text AS d', [shop.id])).d;
  const fy = math.fiscalYearOf(todayIn('Asia/Kolkata'));
  const state = async (id) => (await svc.planOf(id)).state;
  const entitled = async (id) => (await one('SELECT business_entitled_modules($1) AS m', [id])).m;
  const basic = async (type) => (await all('SELECT module_code FROM platform_plan_modules WHERE plan_code=$1 ORDER BY module_code', [`${type}_basic`])).map((r) => r.module_code);
  const pay = (id, orderId, reference, paidOn = today) => owner('POST', P(`/orders/${orderId}/payments`, id), { method: 'upi', reference, paidOn }, 201);

  let order, applied;
  await t.test('during the trial the owner chooses a plan and orders it: lines, IGST from the sample GSTIN\'s state, starting after the trial', async () => {
    const chosen = await owner('PUT', P('/selection'), { planCode: 'grocery_basic', billingPeriod: 'year', addons: ['loyalty'] });
    assert.deepEqual([chosen.planCode, chosen.billingPeriod, chosen.addons.map((a) => a.code)], ['grocery_basic', 'year', ['loyalty']]);
    await owner('PUT', P('/selection'), { planCode: 'salon_basic', billingPeriod: 'year', addons: [] }, 400);
    await owner('PUT', P('/selection'), { planCode: 'grocery_basic', billingPeriod: 'week', addons: [] }, 400);
    await owner('PUT', P('/selection'), { planCode: 'grocery_basic', billingPeriod: 'year', addons: ['lab'] }, 400);
    const refused = await owner('POST', P('/orders'), { kind: 'add_on', modules: ['offers'] }, 409);
    assert.match(refused.message, /trial everything is unlocked/);
    order = await owner('POST', P('/orders'), { kind: 'subscription' }, 201);
    assert.deepEqual(order.lines.map((l) => [l.itemKind, l.itemCode, l.fullPrice, l.amount]), [['plan', 'grocery_basic', '4999.00', '4999.00'], ['module', 'loyalty', '1999.00', '1999.00']]);
    assert.deepEqual([order.taxable, order.cgst, order.sgst, order.igst, order.total], ['6998.00', '0.00', '0.00', '1259.64', '8257.64']);
    assert.deepEqual([order.supplierStateCode, order.placeOfSupplyCode, order.status], ['22', '29', 'open']);
    // The trial runs today to today + 13: paid time starts the day after.
    assert.equal(order.startsOn, addDays(today, 14));
    assert.equal(order.endsOn, math.periodEnd(addDays(today, 14), 'year'));
    assert.equal(order.validUntil, addDays(today, 7));
    assert.deepEqual(order.modules, [...await basic('grocery'), 'loyalty'].sort());
    const view = await owner('GET', P());
    assert.equal(view.openOrder.id, order.id);
    assert.deepEqual([view.plan.state, view.plan.daysLeft, view.plan.trialEndsOn], ['trial', 14, addDays(today, 13)]);
    assert.equal(view.payTo.upiLink, `upi://pay?pa=acme%40okaxis&pn=Acme%20Soft&am=8257.64&cu=INR&tn=Order%20${order.id}`);
    assert.equal(view.payTo.bankIfsc, 'SBIN0001234');
    assert.ok(view.catalogue.plans.some((p) => p.code === 'grocery_basic' && p.yearly === '4999.00'));
    assert.ok(view.catalogue.addons.some((a) => a.code === 'loyalty' && a.soldAs === 'module'));
    assert.ok(view.entitled.includes('stock_transfers'), 'a trial unlocks everything');
  });

  await t.test('only the owner sees and changes the plan', async () => {
    const roles = (await owner('GET', `/businesses/${shop.id}/roles?limit=100`)).items;
    const cashier = roles.find((r) => r.template_code === 'cashier');
    await owner('POST', `/businesses/${shop.id}/staff-accounts`, { name: 'Ravi M', email: 'ravi@plankirana.invalid', password: 'Ravi-pass-2026', roleId: cashier.id }, 201);
    const ravi = as(await login('ravi@plankirana.invalid', 'Ravi-pass-2026'));
    await ravi('GET', P(), undefined, 403);
    await ravi('POST', P('/orders'), { kind: 'subscription' }, 403);
    // A business of someone else's is not found.
    const other = (await platform('POST', '/users/platform/businesses', { ...shopBody('OTHER-KIRANA', 'Other Kirana'), owner: { email: 'other@kirana.invalid', name: 'Other', password } }, 201)).business;
    await owner('GET', P('', other.id), undefined, 404);
  });

  let payment;
  await t.test('the owner says they paid; the super admin applies it once: a sample invoice, a paid period after the trial', async () => {
    await owner('POST', P(`/orders/${order.id}/payments`), { method: 'upi', reference: 'UTR123', paidOn: addDays(today, 1) }, 400);
    await owner('POST', P(`/orders/${order.id}/payments`), { method: 'gift', reference: 'UTR123', paidOn: today }, 400);
    await owner('POST', P(`/orders/${order.id}/payments`), { method: 'upi', reference: ' ', paidOn: today }, 400);
    payment = await pay(shop.id, order.id, 'UTR123');
    assert.deepEqual([payment.status, payment.amount, payment.method], ['pending', '8257.64', 'upi']);
    await owner('POST', P(`/orders/${order.id}/payments`), { method: 'upi', reference: 'UTR124', paidOn: today }, 409);
    assert.equal((await owner('GET', P())).openOrder.payments[0].status, 'pending');

    applied = await svc.applyPayment(platformUser, payment.id);
    assert.equal(applied.payment.status, 'confirmed');
    assert.equal(applied.order.status, 'paid');
    assert.deepEqual([applied.invoice.number, applied.invoice.sample, applied.invoice.igst, applied.invoice.total], [`SAMPLE/${fy}/0001`, true, '1259.64', '8257.64']);
    assert.deepEqual([applied.invoice.supplier.gstin, applied.invoice.buyer.stateCode, applied.invoice.placeOfSupply.name], ['22AAAAA0000A1ZC', '29', 'Karnataka']);
    assert.deepEqual(applied.invoice.lines.map((l) => [l.description, l.sac, l.taxable]), [['Basic plan', '998315', '4999.00'], ['Loyalty points', '998315', '1999.00']]);
    assert.deepEqual([applied.period.kind, applied.period.starts_on, applied.period.ends_on], ['paid', order.startsOn, order.endsOn]);
    assert.deepEqual(applied.period.modules, [...await basic('grocery'), 'loyalty'].sort());
    // Paid time has not started: the trial goes on.
    assert.equal(await state(shop.id), 'trial');
    const view = await owner('GET', P());
    assert.equal(view.openOrder, null);
    assert.deepEqual(view.invoices.map((i) => [i.number, i.sample]), [[`SAMPLE/${fy}/0001`, true]]);
    const printed = await owner('GET', P(`/invoices/${applied.invoice.id}`));
    assert.equal(printed.number, `SAMPLE/${fy}/0001`);
    assert.match(printed.signatory, /Acme Soft Private Limited/);
    const actions = (await all('SELECT action FROM business_audit WHERE business_id=$1 ORDER BY id', [shop.id])).map((r) => r.action);
    for (const action of ['plan.selection_changed', 'plan.order_created', 'plan.payment_submitted', 'plan.payment_confirmed']) assert.ok(actions.includes(action), action);
  });

  let books;
  await t.test('confirming is idempotent: two confirms at once, or a confirm and a reject, leave one decision and one invoice', async () => {
    const again = await svc.applyPayment(platformUser, payment.id);
    assert.equal(again.invoice.id, applied.invoice.id);
    assert.equal((await one('SELECT count(*)::int AS n FROM platform_invoices WHERE order_id=$1', [order.id])).n, 1);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_access_periods WHERE business_id=$1 AND kind='paid'", [shop.id])).n, 1);
    await assert.rejects(svc.rejectPayment(platformUser, payment.id, 'Not in the bank'), (error) => error.statusCode === 409);

    // The owner's second business, in Maharashtra: no state yet, so the order asks for one.
    books = await owner('POST', '/businesses', { businessType: 'books', name: 'Plan Books', code: 'PLAN-BOOKS' }, 201);
    await owner('PUT', P('/selection', books.id), { planCode: 'books_basic', billingPeriod: 'month', addons: [] });
    const noState = await owner('POST', P('/orders', books.id), { kind: 'subscription' }, 409);
    assert.equal(noState.data.reason, 'state_required');
    const first = await owner('POST', P('/orders', books.id), { kind: 'subscription', stateCode: '27' }, 201);
    assert.deepEqual([first.placeOfSupplyCode, first.total], ['27', '588.82']);
    const paid = await pay(books.id, first.id, 'UTR2001');
    const both = await Promise.all([svc.applyPayment(platformUser, paid.id), svc.applyPayment(platformUser, paid.id)]);
    assert.equal(both[0].invoice.id, both[1].invoice.id);
    assert.equal((await one('SELECT count(*)::int AS n FROM platform_invoices WHERE order_id=$1', [first.id])).n, 1);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_access_periods WHERE business_id=$1 AND kind='paid'", [books.id])).n, 1);

    const second = await owner('POST', P('/orders', books.id), { kind: 'subscription' }, 201);
    assert.equal(second.startsOn, addDays(both[0].period.ends_on, 1));
    const raced = await pay(books.id, second.id, 'UTR2002');
    const settled = await Promise.allSettled([svc.applyPayment(platformUser, raced.id), svc.rejectPayment(platformUser, raced.id, 'No such UTR')]);
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, JSON.stringify(settled.map((s) => s.reason?.message)));
    assert.ok(settled.filter((s) => s.status === 'rejected').every((s) => s.reason.statusCode === 409));
    const decided = (await one('SELECT status FROM platform_payments WHERE id=$1', [raced.id])).status;
    assert.equal((await one('SELECT count(*)::int AS n FROM platform_invoices WHERE order_id=$1', [second.id])).n, decided === 'confirmed' ? 1 : 0);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_access_periods WHERE business_id=$1 AND kind='paid'", [books.id])).n, decided === 'confirmed' ? 2 : 1);
  });

  let paisaOrder;
  await t.test('an order whose tax a real GSTIN would split otherwise: first its sample invoice, under IGST', async () => {
    // ₹54.50: IGST at 18% is ₹9.81, but CGST and SGST at 9% would round to ₹4.91 each.
    const paisa = (await platform('POST', '/users/platform/businesses', shopBody('PAISA-MART', 'Paisa Mart'), 201)).business;
    paisaOrder = await one(`INSERT INTO platform_orders(business_id,kind,plan_code,billing_period,starts_on,ends_on,valid_until,buyer,supplier_state_code,place_of_supply_code,
        gst_rate,taxable_amount,igst_amount,total_amount)
      VALUES($1,'subscription','grocery_basic','month',business_local_today($1)+14,business_local_today($1)+43,business_local_today($1)+7,'{"name":"Paisa Mart","stateCode":"29"}',
        '22','29',18,54.50,9.81,64.31) RETURNING id`, [paisa.id]);
    await pool.query(`INSERT INTO platform_order_lines(order_id,line_no,item_kind,item_code,name,full_price,charged_days,period_days,amount)
      VALUES($1,1,'plan','grocery_basic','Basic plan',54.50,30,30,54.50)`, [paisaOrder.id]);
    const sampled = await svc.applyPayment(platformUser, (await pay(paisa.id, paisaOrder.id, 'UTR5001')).id);
    assert.deepEqual([sampled.invoice.sample, sampled.invoice.cgst, sampled.invoice.igst, sampled.invoice.total], [true, '0.00', '9.81', '64.31']);
  });

  await t.test('the real GSTIN: a tax invoice for the order invoiced as a sample, the real series from 1', async () => {
    const sampleNext = async () => (await one("SELECT next_number FROM platform_invoice_series WHERE gstin='22AAAAA0000A1ZC'")).next_number;
    const samplesBefore = await sampleNext();
    await assert.rejects(svc.issueTaxInvoice(platformUser, order.id), (error) => error.statusCode === 409 && /real GSTIN/.test(error.message));
    const first14 = '29AACCA1234B1Z';
    const real = `${first14}${gstinCheckCharacter(first14)}`;
    const mistyped = `${first14}${real.endsWith('0') ? '1' : '0'}`;
    await assert.rejects(planSettings.update(platformUser, { gstin: mistyped }), (error) => error.statusCode === 400);
    await assert.rejects(planSettings.update(platformUser, { trialDays: 31 }), (error) => error.statusCode === 400);
    // A prefix leaves room for 99,999 invoices a year: 5 characters at most, and never SAMPLE, the sample invoices' own.
    for (const prefix of ['BMP1', 'ACMESOFT', 'BMPIND', 'SAMPLE']) {
      await assert.rejects(planSettings.update(platformUser, { invoicePrefix: prefix }), (error) => error.statusCode === 400, prefix);
    }
    await planSettings.update(platformUser, { invoicePrefix: 'ACMES' });
    await planSettings.update(platformUser, { invoicePrefix: 'BMP' });
    await assert.rejects(pool.query("UPDATE platform_settings SET invoice_prefix='ACMESOFT' WHERE id=1"), /check constraint|too long/);
    await assert.rejects(pool.query("UPDATE platform_settings SET invoice_prefix='BMP1' WHERE id=1"), /check constraint/);
    await assert.rejects(pool.query("INSERT INTO platform_invoice_series(gstin,fiscal_year,prefix) VALUES('22AAAAA0000A1ZC','9900','BMP')"), /check constraint/);
    await assert.rejects(pool.query("INSERT INTO platform_invoice_series(gstin,fiscal_year,prefix) VALUES($1,'9900','SAMPLE')", [real]), /check constraint/);
    await assert.rejects(pool.query("INSERT INTO platform_invoice_series(gstin,fiscal_year,prefix) VALUES($1,'9900','ACMESOFT')", [real]), /check constraint|too long/);
    await assert.rejects(pool.query("INSERT INTO platform_invoice_series(gstin,fiscal_year,prefix) VALUES($1,'9900','ACMEX1')", [real]), /check constraint/);
    await planSettings.update(platformUser, { gstin: real });
    assert.ok(await one("SELECT 1 FROM platform_audit WHERE action='platform.settings_updated' AND details->'changed' ? 'gstin'"));
    const tax = await svc.issueTaxInvoice(platformUser, order.id);
    assert.deepEqual([tax.number, tax.sample, tax.cgst, tax.sgst, tax.igst, tax.total], [`BMP/${fy}/00001`, false, '629.82', '629.82', '0.00', '8257.64']);
    assert.equal(tax.paidOn, today);
    await assert.rejects(svc.issueTaxInvoice(platformUser, order.id), (error) => error.statusCode === 409);
    // The next order's invoice takes the next real number; the sample series is left alone.
    await owner('PUT', P('/selection', books.id), { planCode: 'books_basic', billingPeriod: 'month', addons: [] });
    const next = await owner('POST', P('/orders', books.id), { kind: 'subscription' }, 201);
    const done = await svc.applyPayment(platformUser, (await pay(books.id, next.id, 'UTR2003')).id);
    assert.deepEqual([done.invoice.number, done.invoice.sample, done.invoice.igst], [`BMP/${fy}/00002`, false, '89.82']);
    assert.equal(await sampleNext(), samplesBefore);
    // A GSTIN corrected during the year starts its own series at 1: the same number again, under the other GSTIN.
    const corrected14 = '29AACCB5678C1Z';
    const corrected = `${corrected14}${gstinCheckCharacter(corrected14)}`;
    await planSettings.update(platformUser, { gstin: corrected });
    const again = await owner('POST', P('/orders', books.id), { kind: 'subscription' }, 201);
    const twice = await svc.applyPayment(platformUser, (await pay(books.id, again.id, 'UTR2004')).id);
    assert.deepEqual([twice.invoice.number, twice.invoice.supplier.gstin], [`BMP/${fy}/00001`, corrected]);
    assert.equal((await one('SELECT count(*)::int AS n FROM platform_invoices WHERE number=$1', [`BMP/${fy}/00001`])).n, 2);
    await planSettings.update(platformUser, { gstin: real });
    // The order invoiced as a sample under IGST: its tax invoice within the state splits the same tax, so it adds up to what was paid.
    const paisaTax = await svc.issueTaxInvoice(platformUser, paisaOrder.id);
    assert.deepEqual([paisaTax.taxable, paisaTax.cgst, paisaTax.sgst, paisaTax.igst, paisaTax.total], ['54.50', '4.91', '4.90', '0.00', '64.31']);
    assert.equal(paisaTax.number, `BMP/${fy}/00003`);
  });

  let period;
  await t.test('in paid time a selection change waits for the next order; an add-on costs the days left and ends with the period', async () => {
    // Twenty days later, as far as the grocery's time goes: its paid period covers today.
    await pool.query('ALTER TABLE business_access_periods DISABLE TRIGGER business_access_periods_kept');
    try {
      await pool.query('UPDATE business_access_periods SET starts_on=starts_on-20,ends_on=ends_on-20 WHERE business_id=$1', [shop.id]);
    } finally { await pool.query('ALTER TABLE business_access_periods ENABLE TRIGGER business_access_periods_kept'); }
    assert.equal(await state(shop.id), 'paid');
    period = await one("SELECT starts_on,ends_on FROM business_access_periods WHERE business_id=$1 AND kind='paid'", [shop.id]);
    await owner('PUT', P('/selection'), { planCode: 'grocery_basic', billingPeriod: 'year', addons: [] });
    assert.ok((await entitled(shop.id)).includes('loyalty'), 'paid for, so kept to the end of the period');
    assert.ok(!(await entitled(shop.id)).includes('offers'));
    const addOn = await owner('POST', P('/orders'), { kind: 'add_on', modules: ['offers'] }, 201);
    const daysLeft = math.daysBetweenInclusive(today, period.ends_on);
    const periodDays = math.daysBetweenInclusive(period.starts_on, period.ends_on);
    assert.deepEqual(addOn.lines.map((l) => [l.itemCode, l.fullPrice, l.chargedDays, l.periodDays, l.amount]),
      [['offers', '1999.00', daysLeft, periodDays, math.toRupees(math.addOnCharge(199900n, daysLeft, periodDays))]]);
    assert.deepEqual([addOn.kind, addOn.startsOn, addOn.endsOn, addOn.planCode], ['add_on', today, period.ends_on, null]);
    // The real GSTIN is in Karnataka too: CGST and SGST.
    assert.ok(Number(addOn.cgst) > 0 && addOn.cgst === addOn.sgst && addOn.igst === '0.00');
    const done = await svc.applyPayment(platformUser, (await pay(shop.id, addOn.id, 'UTR3001')).id);
    assert.deepEqual(done.grants.map((g) => [g.module_code, g.kind, g.starts_on, g.ends_on]), [['offers', 'paid', today, period.ends_on]]);
    assert.ok((await entitled(shop.id)).includes('offers'));
    // It joins the selection, for the next order.
    assert.deepEqual((await owner('GET', P())).selection.addons.map((a) => a.code), ['offers']);
    await owner('POST', P('/orders'), { kind: 'add_on', modules: ['offers'] }, 409);
  });

  await t.test('an add-on priced at nothing is unlocked at once: the order is paid, with no payment and no invoice', async () => {
    await pool.query("UPDATE platform_module_prices SET monthly_price=0,yearly_price=0 WHERE module_code='wastage'");
    try {
      const free = await owner('POST', P('/orders'), { kind: 'add_on', modules: ['wastage'] }, 201);
      assert.deepEqual([free.status, free.total, free.lines.map((l) => l.amount)], ['paid', '0.00', ['0.00']]);
      assert.equal((await one('SELECT count(*)::int AS n FROM platform_payments WHERE order_id=$1', [free.id])).n, 0);
      assert.equal((await one('SELECT count(*)::int AS n FROM platform_invoices WHERE order_id=$1', [free.id])).n, 0);
      assert.deepEqual(await one('SELECT kind,starts_on,ends_on FROM business_access_addons WHERE order_id=$1', [free.id]), { kind: 'paid', starts_on: today, ends_on: period.ends_on });
      assert.ok((await entitled(shop.id)).includes('wastage'));
      const view = await owner('GET', P());
      assert.equal(view.openOrder, null);
      assert.ok(view.selection.addons.some((a) => a.code === 'wastage'), 'it joins the selection');
      assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='plan.order_granted' AND entity_id=$2", [shop.id, free.id]));
    } finally { await pool.query("UPDATE platform_module_prices SET monthly_price=199,yearly_price=1999 WHERE module_code='wastage'"); }
    // The next order keeps to the add-ons the owner chose before.
    await owner('PUT', P('/selection'), { planCode: 'grocery_basic', billingPeriod: 'year', addons: ['offers'] });
  });

  await t.test('a module the plan does not unlock cannot be switched on', async () => {
    const refused = await owner('PUT', `/businesses/${shop.id}/modules/stock_transfers`, { enabled: true }, 409);
    assert.equal(refused.message, 'Not in your plan. The owner can add it in Your plan.');
    assert.equal(refused.data.reason, 'not_in_plan');
    await owner('PUT', `/businesses/${shop.id}/modules/offers`, { enabled: true });
    const modules = await owner('GET', `/businesses/${shop.id}/modules`);
    assert.equal(modules.find((m) => m.code === 'stock_transfers').in_plan, false);
    assert.equal(modules.find((m) => m.code === 'offers').in_plan, true);
    assert.equal(modules.find((m) => m.code === 'offers').enabled, true);
  });

  // A paid period set by SQL, with the paid order behind it.
  const paidBySql = async (id, from, to) => {
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [id]);
    const made = await one(`INSERT INTO platform_orders(business_id,kind,plan_code,billing_period,starts_on,ends_on,valid_until,buyer,supplier_state_code,place_of_supply_code,
        gst_rate,taxable_amount,igst_amount,total_amount,status,paid_at)
      VALUES($1,'subscription','grocery_basic','month',business_local_today($1)+$2::int,business_local_today($1)+$3::int,business_local_today($1),'{"name":"Test"}','22','29',
        18,100,18,118,'paid',now()) RETURNING id`, [id, from, to]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,plan_code,modules,order_id)
      SELECT $1,'paid',starts_on,ends_on,'grocery_basic',modules,id FROM platform_orders WHERE id=$2`, [id, made.id]);
  };
  let graceShop, endedShop, endedOrder, renewal;
  await t.test('a renewal starts the day after the current time: in paid time, in grace, and today once ended', async () => {
    renewal = await owner('POST', P('/orders'), { kind: 'subscription' }, 201);
    assert.equal(renewal.startsOn, addDays(period.ends_on, 1));
    assert.deepEqual(renewal.lines.map((l) => l.itemCode), ['grocery_basic', 'offers']);
    graceShop = (await platform('POST', '/users/platform/businesses', shopBody('GRACE-MART', 'Grace Mart'), 201)).business;
    endedShop = (await platform('POST', '/users/platform/businesses', shopBody('ENDED-MART', 'Ended Mart'), 201)).business;
    await paidBySql(graceShop.id, -30, -3);
    await paidBySql(endedShop.id, -40, -8);
    assert.deepEqual([await state(graceShop.id), await state(endedShop.id)], ['grace', 'ended']);
    assert.equal((await owner('POST', P('/orders', graceShop.id), { kind: 'subscription' }, 201)).startsOn, addDays(today, -2));
    endedOrder = await owner('POST', P('/orders', endedShop.id), { kind: 'subscription' }, 201);
    assert.equal(endedOrder.startsOn, today);
  });

  let waiting;
  await t.test('one open order: a new one replaces the old, but not while a payment of it is being checked', async () => {
    const again = await owner('POST', P('/orders'), { kind: 'subscription' }, 201);
    assert.equal((await one('SELECT status FROM platform_orders WHERE id=$1', [renewal.id])).status, 'cancelled');
    await owner('POST', P(`/orders/${renewal.id}/payments`), { method: 'upi', reference: 'UTR4000', paidOn: today }, 409);
    waiting = await pay(shop.id, again.id, 'UTR4001');
    const refused = await owner('POST', P('/orders'), { kind: 'subscription' }, 409);
    assert.equal(refused.data.reason, 'payment_being_checked');
    assert.equal((await one("SELECT count(*)::int AS n FROM platform_orders WHERE business_id=$1 AND status='open'", [shop.id])).n, 1);
  });

  await t.test('confirming waits for the company details', async () => {
    await pool.query('UPDATE platform_settings SET legal_name=NULL WHERE id=1');
    try {
      await assert.rejects(svc.applyPayment(platformUser, waiting.id), (error) => error.statusCode === 409 && /^Complete the company details/.test(error.message)
        && error.details.problems.includes('legal name'));
      assert.equal((await one('SELECT status FROM platform_payments WHERE id=$1', [waiting.id])).status, 'pending');
      // Recording a payment waits too, and nothing is kept.
      await assert.rejects(svc.recordPayment(platformUser, endedShop.id, endedOrder.id, { method: 'bank', reference: 'NEFT77', paidOn: today }), (error) => error.statusCode === 409);
      assert.equal((await one('SELECT count(*)::int AS n FROM platform_payments WHERE order_id=$1', [endedOrder.id])).n, 0);
    } finally { await pool.query("UPDATE platform_settings SET legal_name='Acme Soft Private Limited' WHERE id=1"); }
  });

  await t.test('the super admin records a payment received: entered and confirmed at once', async () => {
    await assert.rejects(svc.recordPayment(platformUser, endedShop.id, endedOrder.id, { method: 'gift', reference: 'NEFT77', paidOn: today }), (error) => error.statusCode === 400);
    const done = await svc.recordPayment(platformUser, endedShop.id, endedOrder.id, { method: 'bank', reference: 'NEFT77', paidOn: today });
    assert.deepEqual([done.payment.status, done.payment.method, done.order.status, done.invoice.sample], ['confirmed', 'bank', 'paid', false]);
    assert.match(done.invoice.number, new RegExp(`^BMP/${fy}/\\d{5}$`));
    assert.deepEqual([done.period.starts_on, done.period.kind], [today, 'paid']);
    assert.equal(await state(endedShop.id), 'paid');
    // The owner's waiting payment cannot be recorded over.
    await assert.rejects(svc.recordPayment(platformUser, shop.id, waiting.orderId, { method: 'cash', reference: 'Cash at office', paidOn: today }),
      (error) => error.statusCode === 409 && error.details.reason === 'payment_being_checked');
  });

  await t.test('the price list: plans and module prices saved, the review stamped; orders keep their prices', async () => {
    const catalogue = require('../../src/modules/platform/services/planCatalogue.service');
    const pro = { code: 'grocery_pro', businessType: 'grocery', name: 'Pro', monthly: '899', yearly: '8999', modules: [...await basic('grocery'), 'loyalty', 'offers'], isDefault: false, active: true };
    await assert.rejects(catalogue.update(platformUser, { plans: [{ ...pro, monthly: '-1' }] }), (error) => error.statusCode === 400);
    await assert.rejects(catalogue.update(platformUser, { prices: [{ code: 'loyalty', soldAs: 'module', monthly: 'free', yearly: '0', available: true }] }), (error) => error.statusCode === 400);
    await assert.rejects(catalogue.update(platformUser, { plans: [{ ...pro, modules: ['lab'] }] }), /plan holds only modules its business type can use/);
    assert.equal((await one('SELECT prices_reviewed_at FROM platform_settings')).prices_reviewed_at, null);
    const saved = await catalogue.update(platformUser, { plans: [pro], prices: [{ code: 'loyalty', soldAs: 'module', monthly: '249', yearly: '2499', available: true }] });
    assert.ok(saved.pricesReviewedAt);
    assert.deepEqual(saved.plans.find((p) => p.code === 'grocery_pro').yearly, '8999.00');
    const offer = await catalogue.forType('grocery');
    assert.deepEqual(offer.plans.map((p) => [p.code, p.isDefault]), [['grocery_basic', true], ['grocery_pro', false]]);
    assert.equal(offer.addons.find((a) => a.code === 'loyalty').monthly, '249.00');
    assert.ok(await one("SELECT 1 FROM platform_audit WHERE action='platform.prices_updated'"));
    // The open order keeps the prices it was made with.
    assert.deepEqual((await all('SELECT item_code,amount FROM platform_order_lines WHERE order_id=$1 ORDER BY line_no', [waiting.orderId])).map((l) => l.amount), ['4999.00', '1999.00']);
    // A new default takes over from the old; the type always keeps one.
    await catalogue.update(platformUser, { plans: [{ ...pro, isDefault: true }] });
    assert.equal((await one("SELECT code FROM platform_plans WHERE business_type='grocery' AND is_default")).code, 'grocery_pro');
    await assert.rejects(catalogue.update(platformUser, { plans: [{ ...pro, isDefault: false }] }), /default plan/);
    await catalogue.update(platformUser, { plans: [{ code: 'grocery_basic', businessType: 'grocery', name: 'Basic', monthly: '499', yearly: '4999', modules: await basic('grocery'), isDefault: true, active: true }] });
    assert.equal((await one("SELECT code FROM platform_plans WHERE business_type='grocery' AND is_default")).code, 'grocery_basic');
  });

  await t.test('a renewal that leaves out a restaurant feature still holding money is refused with its reason', async () => {
    const dinerPassword = `Diner-${crypto.randomBytes(8).toString('hex')}`;
    await platform('POST', '/users/platform/restaurants', { name: 'Plan Diner', code: 'PLANDINER', admin: { name: 'Diner owner', email: 'owner@plandiner.invalid', password: dinerPassword } }, 201);
    const diner = as(await login('owner@plandiner.invalid', dinerPassword));
    await diner('POST', '/business-day/open', { openingCash: 0 }, 201);
    const guest = await diner('POST', '/crm/customers', { name: 'Party Host', mobile: '9876500071' }, 201);
    await diner('POST', '/bills/advances', { customerId: guest.id, amount: 500, paymentMethod: 'cash', purpose: 'Birthday party' }, 201);
    await pool.query("INSERT INTO platform_plans(code,business_type,name,monthly_price,yearly_price) VALUES('restaurant_lite','restaurant','Lite',499,4999)");
    await pool.query("INSERT INTO platform_plan_modules(plan_code,module_code) SELECT 'restaurant_lite',module_code FROM platform_plan_modules WHERE plan_code='restaurant_basic' AND module_code<>'advances'");
    await diner('PUT', '/plan/selection', { planCode: 'restaurant_lite', billingPeriod: 'month', addons: [] });
    const refused = await diner('POST', '/plan/orders', { kind: 'subscription', stateCode: '29' }, 409);
    assert.match(refused.message, /^Advances & deposits cannot be left out of the next order yet: 1 advance still holds ₹500 of guests' money/);
    assert.deepEqual([refused.data.reason, refused.data.module], ['module_in_use', 'advances']);
    await diner('PUT', '/plan/selection', { planCode: 'restaurant_lite', billingPeriod: 'month', addons: ['advances'] });
    const made = await diner('POST', '/plan/orders', { kind: 'subscription', stateCode: '29' }, 201);
    assert.deepEqual(made.lines.map((l) => [l.itemCode, l.amount]), [['restaurant_lite', '499.00'], ['advances', '199.00']]);
    const view = await diner('GET', '/plan');
    assert.deepEqual([view.plan.state, view.openOrder.id], ['trial', made.id]);
    // A restaurant's feature outside its plan cannot be switched on, from either screen.
    const business = (await one("SELECT id FROM businesses WHERE code='PLANDINER'")).id;
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1", [business]);
    await pool.query("INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,plan_code,modules,reason) VALUES($1,'given',business_local_today($1),NULL,'restaurant_lite','{tips}','Pilot')", [business]);
    await diner('PUT', '/restaurants/current/features/tips', { enabled: false });
    const back = await diner('PUT', '/restaurants/current/features/tips', { enabled: true });
    assert.deepEqual([back.enabled, back.changed], [true, true]);
    const notInPlan = await diner('PUT', '/restaurants/current/features/reservations', { enabled: true }, 409);
    assert.equal(notInPlan.message, 'Not in your plan. The owner can add it in Your plan.');
    const features = await diner('GET', '/restaurants/current/features');
    assert.deepEqual([features.features.find((f) => f.code === 'reservations').inPlan, features.features.find((f) => f.code === 'reservations').enabled], [false, false]);
    assert.ok(!(await diner('GET', '/auth/me')).features.includes('reservations'), 'switched on, but not in the plan');
    // Switching off goes by the switches themselves: Guests waits for Online ordering, which the plan leaves out but is still
    // switched on, and Online ordering is truly switched off; then Guests goes.
    const guestsFirst = await diner('PUT', '/restaurants/current/features/guests', { enabled: false }, 409);
    assert.match(guestsFirst.message, /Online ordering page needs Guests & CRM/);
    assert.equal((await diner('POST', '/restaurants/current/features/online_ordering/preview', { enabled: false })).changed, true);
    assert.equal((await diner('PUT', '/restaurants/current/features/online_ordering', { enabled: false })).changed, true);
    assert.equal((await diner('PUT', '/restaurants/current/features/guests', { enabled: false })).changed, true);
    assert.equal(await one("SELECT 1 FROM business_capabilities WHERE business_id=$1 AND capability IN ('guests','online_ordering')", [business]), undefined);
    // A switch already off is left alone.
    assert.equal((await diner('PUT', '/restaurants/current/features/online_ordering', { enabled: false })).changed, false);
  });

  await t.test('with no trial, a payment being checked unlocks what its order holds', async () => {
    await pool.query('UPDATE platform_settings SET trial_days=0');
    let fresh;
    try {
      fresh = (await platform('POST', '/users/platform/businesses', shopBody('CHECK-MART', 'Check Mart'), 201)).business;
    } finally { await pool.query('UPDATE platform_settings SET trial_days=14'); }
    assert.equal(await state(fresh.id), 'ended');
    assert.deepEqual(await entitled(fresh.id), []);
    const made = await owner('POST', P('/orders', fresh.id), { kind: 'subscription' }, 201);
    assert.equal(made.startsOn, today);
    await pay(fresh.id, made.id, 'UTR6001');
    assert.equal(await state(fresh.id), 'checking');
    assert.deepEqual([...await entitled(fresh.id)].sort(), [...made.modules].sort());
    await owner('POST', `/businesses/${fresh.id}/contacts`, { kind: 'customer', name: 'First customer' }, 201);
  });

  await t.test('given time: the owner asks the company; given add-ons unlock at once; a new end replaces the given period', async () => {
    await svc.giveTime(platformUser, graceShop.id, { noEnd: true, everything: true, reason: 'Pilot customer' });
    assert.equal(await state(graceShop.id), 'given');
    const refused = await owner('PUT', P('/selection', graceShop.id), { planCode: 'grocery_basic', billingPeriod: 'month', addons: [] }, 409);
    assert.match(refused.message, /^Your access is arranged by Business Management Platform\. Contact us to change it \(help@acme\.invalid\)\.$/);
    await owner('POST', P('/orders', graceShop.id), { kind: 'subscription' }, 409);

    const clinic = (await platform('POST', '/users/platform/businesses', shopBody('PLAN-CLINIC', 'Plan Clinic', 'healthcare'), 201)).business;
    const given = await svc.giveTime(platformUser, clinic.id, { endsOn: daysFrom(60), planCode: 'healthcare_basic', reason: 'Pilot clinic', replaceTrial: true });
    assert.deepEqual([given.kind, given.starts_on, given.ends_on, given.everything], ['given', today, daysFrom(60), false]);
    assert.equal((await one("SELECT cancel_reason FROM business_access_periods WHERE business_id=$1 AND kind='trial'", [clinic.id])).cancel_reason, 'Pilot clinic');
    assert.equal(await state(clinic.id), 'given');
    assert.ok(!(await entitled(clinic.id)).includes('lab'));
    const grants = await svc.giveAddons(platformUser, clinic.id, { modules: ['lab'], endsOn: daysFrom(30), reason: 'Trying the lab' });
    assert.deepEqual(grants.map((g) => [g.module_code, g.kind, g.ends_on, g.reason]), [['lab', 'given', daysFrom(30), 'Trying the lab']]);
    assert.ok((await entitled(clinic.id)).includes('lab'));
    await assert.rejects(svc.giveAddons(platformUser, clinic.id, { modules: ['loyalty'], endsOn: daysFrom(30), reason: 'Not a clinic module' }), (error) => error.statusCode === 400);
    const longer = await svc.giveTime(platformUser, clinic.id, { endsOn: daysFrom(90), planCode: 'healthcare_basic', reason: 'Pilot extended' });
    assert.deepEqual([longer.starts_on, longer.ends_on], [given.starts_on, daysFrom(90)]);
    assert.equal((await one('SELECT cancel_reason FROM business_access_periods WHERE id=$1', [given.id])).cancel_reason, 'Pilot extended');
    assert.equal((await svc.planOf(clinic.id)).accessEndsOn, daysFrom(90));
    const actions = (await all('SELECT action FROM business_audit WHERE business_id=$1', [clinic.id])).map((r) => r.action);
    assert.ok(actions.includes('plan.time_given') && actions.includes('plan.addons_given'));
  });
});
