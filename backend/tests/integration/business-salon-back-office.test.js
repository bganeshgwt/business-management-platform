const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const dates = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Salon back office: salon stylist weeks, holidays and the
// manager's override; back-bar products taken from stock when a service is
// billed and the service profitability report; a client's advance refunded in
// cash or a held deposit moved to the wallet (reason + manager PIN); monthly
// target (slab) commission and the payout statement; meat shops' cut to
// order and yield by supplier; repair advances refunded with a manager PIN.
// Runs against its own throwaway database with every migration applied.
test('salon, weight shops and repairs', { timeout: 300000 }, async (t) => {
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
  const password = `R2Svc-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('r2svc-owner');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(await login('r2svc-owner@test.invalid'));
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);

  const [salon, meat, electronics] = await withTools(request, await createBusinesses(request, 'OWNER', ['salon', 'meat', 'electronics']));
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const S = (suffix) => `/businesses/${salon.id}/${suffix}`;
  const M = (suffix) => `/businesses/${meat.id}/${suffix}`;
  const E = (suffix) => `/businesses/${electronics.id}/${suffix}`;

  // A manager (with a PIN) and a cashier in the salon and the electronics shop.
  const people = {};
  for (const business of [salon, electronics]) {
    const roles = (await request('GET', `/businesses/${business.id}/roles`)).items;
    for (const template of ['manager', 'cashier']) {
      const email = `${business.business_type}-${template}@test.invalid`;
      const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, `${business.business_type} ${template}`, email, hash]);
      await request('POST', `/businesses/${business.id}/members`, { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
      people[`${business.business_type}_${template}`] = { id: person.id, call: as(await login(email)) };
    }
  }
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=ANY($1::bigint[])', [[people.salon_manager.id, people.electronics_manager.id], await bcrypt.hash('2468', 4)]);

  // --- Salon set-up -----------------------------------------------------------------------------
  const loc = (await request('GET', S('locations'))).items[0];
  const gst = (await request('GET', S('tax-rates'))).items.find((r) => Number(r.rate) === 18);
  const colour = await request('POST', S('catalog'), { name: 'Global colour', code: 'COL', kind: 'service', unit: 'service', tracking: 'none', price: '2000', taxRateId: gst.id }, 201);
  const cut = await request('POST', S('catalog'), { name: 'Haircut', code: 'CUT', kind: 'service', unit: 'service', tracking: 'none', price: '500', taxRateId: gst.id }, 201);
  const tube = await request('POST', S('catalog'), { name: 'Colour tube (ml)', code: 'CLR-ML', kind: 'goods', unit: 'ml', tracking: 'quantity', price: '5', taxRateId: gst.id }, 201);
  const developer = await request('POST', S('catalog'), { name: 'Developer (ml)', code: 'DEV-ML', kind: 'goods', unit: 'ml', tracking: 'quantity', price: '1', taxRateId: gst.id }, 201);
  const vendor = await request('POST', S('contacts'), { kind: 'supplier', name: 'Pro Salon Supplies' }, 201);
  // Two purchases of colour: the later price (₹4/ml) is the back-bar cost.
  await request('POST', S('documents'), { kind: 'purchase', locationId: loc.id, contactId: vendor.id, requestKey: key(), lines: [{ skuId: tube.id, quantity: '100', unitPrice: '3' }] }, 201);
  await request('POST', S('documents'), { kind: 'purchase', locationId: loc.id, contactId: vendor.id, requestKey: key(), lines: [{ skuId: tube.id, quantity: '100', unitPrice: '4' }, { skuId: developer.id, quantity: '15', unitPrice: '0.5' }] }, 201);
  const meera = await request('POST', S('resources'), { name: 'Meera', locationId: loc.id }, 201);
  const kavya = await request('POST', S('resources'), { name: 'Kavya', locationId: loc.id }, 201);
  const client = await request('POST', S('contacts'), { kind: 'customer', name: 'Lakshmi', phone: '98480 11111' }, 201);
  await request('PUT', S(`salon/services/${colour.id}`), { durationMinutes: 90, bufferMinutes: 0 });
  await request('PUT', S(`salon/services/${cut.id}`), { durationMinutes: 30, bufferMinutes: 0 });
  // A day 9 days ahead and its weekday (business time).
  const ahead = await one("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 9)::text AS d, extract(dow FROM (now() AT TIME ZONE 'Asia/Kolkata')::date + 9)::int AS dow");
  const at = (hhmm, day = ahead.d) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();

  await t.test('weekly schedule, holidays and the manager override', async () => {
    // Meera: her usual 10–19, but that weekday 14:00–18:00 only.
    await request('PUT', S(`salon/staff/${meera.id}`), { kind: 'staff', worksFrom: '10:00', worksTo: '19:00', weeklyOff: [] });
    const week = await request('PUT', S(`salon/staff/${meera.id}/week`), { days: [{ dow: ahead.dow, off: false, worksFrom: '14:00', worksTo: '18:00' }] });
    assert.equal(week.days.length, 1);
    await request('PUT', S(`salon/staff/${meera.id}/week`), { days: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, off: true })) }, 400);
    const refused = await call('POST', S('salon/appointments'), { contactId: client.id, skuId: cut.id, resourceId: meera.id, startsAt: at('11:00'), requestKey: key() },
      await login('salon-cashier@test.invalid'));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.data.reason, 'outside_hours');
    assert.match(refused.body.message, /14:00 to 18:00/);
    await request('POST', S('salon/appointments'), { contactId: client.id, skuId: cut.id, resourceId: meera.id, startsAt: at('14:00'), requestKey: key() }, 201);
    // A cashier asks a manager: wrong PIN, then the right one; kept with a reason.
    const body = { contactId: client.id, skuId: cut.id, resourceId: meera.id, startsAt: at('11:00'), requestKey: key() };
    await people.salon_cashier.call('POST', S('salon/appointments'), { ...body, override: { reason: 'Bride, only slot', approverId: people.salon_manager.id, pin: '1111' } }, 400);
    await people.salon_cashier.call('POST', S('salon/appointments'), { ...body, override: { reason: 'Bride', approverId: people.salon_cashier.id, pin: '2468' } }, 403);
    const let_through = await people.salon_cashier.call('POST', S('salon/appointments'), { ...body, override: { reason: 'Bride, only slot', approverId: people.salon_manager.id, pin: '2468' } }, 201);
    const kept = await one('SELECT * FROM salon_booking_overrides WHERE appointment_id=$1', [let_through.id]);
    assert.equal(Number(kept.approved_by), people.salon_manager.id);
    assert.match(kept.rule_broken, /works from 14:00/);
    // A manager overrides on their own with a reason, no PIN.
    await people.salon_manager.call('POST', S('salon/appointments'), { contactId: client.id, skuId: cut.id, resourceId: meera.id, startsAt: at('12:00'), requestKey: key(),
      override: { reason: 'Regular client' } }, 201);
    // A salon holiday closes the day for everyone (after bookings are moved).
    const later = await one("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 12)::text AS d");
    await request('POST', S('salon/holidays'), { day: ahead.d, name: 'Diwali' }, 409);
    const holiday = await request('POST', S('salon/holidays'), { day: later.d, name: 'Diwali' }, 201);
    const closed = await call('POST', S('salon/appointments'), { contactId: client.id, skuId: cut.id, resourceId: kavya.id, startsAt: at('11:00', later.d), requestKey: key() }, await login('r2svc-owner@test.invalid'));
    assert.equal(closed.status, 409);
    assert.match(closed.body.message, /closed that day \(Diwali\)/);
    const cal = await request('GET', S(`salon/calendar?date=${later.d}`));
    assert.equal(cal.holidays[0].name, 'Diwali');
    assert.ok(cal.resources.find((r) => r.id === meera.id).week.length === 1);
    await request('POST', S(`salon/holidays/${holiday.id}/cancel`), {});
    await request('POST', S('salon/appointments'), { contactId: client.id, skuId: cut.id, resourceId: kavya.id, startsAt: at('11:00', later.d), requestKey: key() }, 201);
  });

  await t.test('back-bar products leave stock when the service is billed; profitability shows their cost', async () => {
    await request('PUT', S(`salon/services/${colour.id}/products`), { products: [{ skuId: tube.id, quantity: '30' }, { skuId: developer.id, quantity: '10' }] });
    await request('PUT', S(`salon/services/${colour.id}/products`), { products: [{ skuId: cut.id, quantity: '1' }] }, 404);
    const recipe = await request('GET', S(`salon/services/${colour.id}/products`));
    assert.equal(recipe.cost, '125.00', '30 ml × ₹4 (latest purchase) + 10 ml × ₹0.50');
    const bill = await request('POST', S('salon/bills'), { locationId: loc.id, contactId: client.id, requestKey: key(),
      lines: [{ skuId: colour.id, quantity: '2', staffId: meera.id }], payment: { amount: '4720', method: 'upi' } }, 201);
    const stock = async (skuId) => Number((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [salon.id, skuId])).q);
    assert.equal(await stock(tube.id), 140, '2 colours × 30 ml out of 200 ml');
    assert.equal(await stock(developer.id), 0, '20 ml wanted, only 15 in the books');
    const usage = (await request('GET', S('salon/backbar-usage'))).items;
    const dev = usage.find((u) => Number(u.product_sku_id) === developer.id);
    assert.equal(Number(dev.short), 5);
    assert.equal(Number(dev.cost), 10);
    // From the first of this year: nine days ahead is next year late in December.
    const report = await request('GET', S(`salon/reports/service-profitability?from=${dates.today().slice(0, 4)}-01-01&to=${ahead.d}`));
    const row = report.rows.find((r) => Number(r.sku_id) === colour.id);
    assert.equal(row.sales, '4000.00');
    assert.equal(row.product_cost, '250.00');
    assert.equal(report.short.lines, 1);
    assert.ok(bill.document.document_no);
  });

  await t.test('advance: refund in cash with a manager PIN and a receipt, or a held deposit moved to the wallet', async () => {
    const booked = await request('POST', S('salon/appointments'), { contactId: client.id, skuId: cut.id, resourceId: kavya.id, startsAt: at('15:00'), requestKey: key(),
      deposit: { amount: '300', method: 'cash' } }, 201);
    let card = await request('GET', S(`salon/clients/${client.id}`));
    assert.equal(card.held, '300.00');
    // Held deposit to the wallet: the cashier needs the manager's PIN.
    await people.salon_cashier.call('POST', S(`salon/clients/${client.id}/advance-refund`), { mode: 'wallet', collectionId: booked.deposit_collection_id, reason: 'Wants it for any visit' }, 400);
    const moved = await people.salon_cashier.call('POST', S(`salon/clients/${client.id}/advance-refund`), { mode: 'wallet', collectionId: booked.deposit_collection_id,
      reason: 'Wants it for any visit', approverId: people.salon_manager.id, pin: '2468' }, 201);
    assert.equal(moved.release.amount, '300.00');
    card = await request('GET', S(`salon/clients/${client.id}`));
    assert.equal(card.held, '0.00');
    assert.equal(card.advance, '300.00');
    // A no-show now charges nothing: the deposit is not the booking's any more.
    const fee = await request('GET', S(`salon/appointments/${booked.id}/fee?status=no_show`));
    assert.equal(fee.fee, '0.00');
    // Cash refund of ₹120: number, approver, what is left.
    const refundKey = key();
    const refundBody = { mode: 'cash', collectionId: booked.deposit_collection_id, amount: '120', method: 'cash', reason: 'Moving to Pune', approverId: people.salon_manager.id, pin: '2468', requestKey: refundKey };
    await people.salon_cashier.call('POST', S(`salon/clients/${client.id}/advance-refund`), { ...refundBody, amount: '400', requestKey: key() }, 409);
    const refunded = await people.salon_cashier.call('POST', S(`salon/clients/${client.id}/advance-refund`), refundBody, 201);
    assert.match(refunded.refund.refund_no, /-R1$/);
    assert.equal(refunded.refund.left, '180.00');
    assert.equal(refunded.refund.approved_by_name, 'salon manager');
    assert.ok((await people.salon_cashier.call('POST', S(`salon/clients/${client.id}/advance-refund`), refundBody, 201)).repeated);
    card = await request('GET', S(`salon/clients/${client.id}`));
    assert.equal(card.advance, '180.00');
    assert.equal(card.refunds.length, 1);
    // The database refuses a refund past what is left.
    await assert.rejects(pool.query(`INSERT INTO business_collection_refunds(business_id,collection_id,contact_id,refund_no,amount,method,reason,source,approved_by,request_key,request_hash,created_by)
      VALUES($1,$2,$3,'X-1',500,'cash','x','salon',$4,$5,'${'0'.repeat(64)}',$4)`, [salon.id, booked.deposit_collection_id, client.id, people.salon_manager.id, key()]));
    // The rest goes on a bill as before.
    const bill = await request('POST', S('salon/bills'), { locationId: loc.id, contactId: client.id, requestKey: key(), useAdvance: true, lines: [{ skuId: cut.id, quantity: '1', staffId: kavya.id }],
      payment: { amount: '410', method: 'cash' } }, 201);
    assert.equal(bill.advanceApplied, '180.00');
    assert.equal((await request('GET', S('salon/advance-refunds'))).items.length, 1);
  });

  await t.test('slab commission: per stylist, on the month\'s net service sales, with a statement', async () => {
    await request('POST', S('salon/commission-rules'), { appliesTo: 'service', percent: '5' }, 201);
    const plan = await request('POST', S('salon/commission-plans'), { name: 'Target 50k', mode: 'stepped', slabs: [{ fromAmount: '0', percent: '10' }, { fromAmount: '3000', percent: '12' }] }, 201);
    await request('POST', S('salon/commission-plans'), { name: 'Bad', slabs: [{ fromAmount: '100', percent: '10' }] }, 400);
    await request('PATCH', S(`salon/commission-plans/${plan.id}`), { slabs: [] }, 409);
    const month = (await one("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM') AS m")).m;
    await request('PUT', S(`salon/staff/${meera.id}/commission-scheme`), { planId: plan.id, fromMonth: '2020-01' }, 400);
    await request('PUT', S(`salon/staff/${meera.id}/commission-scheme`), { planId: plan.id, fromMonth: month });
    // Meera this month: the colour bill (₹4,000 net) + a haircut ₹500 = ₹4,500.
    await request('POST', S('salon/bills'), { locationId: loc.id, contactId: client.id, requestKey: key(), lines: [{ skuId: cut.id, quantity: '1', staffId: meera.id }], payment: { amount: '590', method: 'cash' } }, 201);
    await request('POST', S('salon/bills'), { locationId: loc.id, contactId: client.id, requestKey: key(), lines: [{ skuId: cut.id, quantity: '1', staffId: kavya.id }], payment: { amount: '590', method: 'cash' } }, 201);
    const statement = await request('GET', S(`salon/commission-statement?month=${month}&staff=${meera.id}`));
    assert.equal(statement.serviceSales, '4500.00');
    assert.equal(statement.serviceCommission, '480.00', '10% of 3,000 + 12% of 1,500');
    assert.equal(statement.bands.length, 2);
    const today = (await one("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).d;
    const report = await request('GET', S(`salon/commissions?from=${month}-01&to=${today}`));
    const meeraRow = report.rows.find((r) => Number(r.resource_id) === meera.id);
    assert.equal(meeraRow.commission, '480.00', 'the slab replaces the flat 5% on services');
    const kavyaRow = report.rows.find((r) => Number(r.resource_id) === kavya.id);
    assert.equal(kavyaRow.commission, '25.00', 'Kavya stays on the flat rule');
    // Paying out checks against the slab figure.
    await request('POST', S('salon/commission-payouts'), { resourceId: meera.id, from: `${month}-01`, to: today, amount: '481', method: 'cash', requestKey: key() }, 409);
    await request('POST', S('salon/commission-payouts'), { resourceId: meera.id, from: `${month}-01`, to: today, amount: '480', method: 'cash', requestKey: key() }, 201);
    const whole = await request('POST', S('salon/commission-plans'), { name: 'Whole month', mode: 'whole', slabs: [{ fromAmount: '0', percent: '10' }, { fromAmount: '3000', percent: '12' }] }, 201);
    assert.equal(whole.mode, 'whole');
    assert.equal((await request('GET', S('salon/commission-schemes'))).find((r) => Number(r.resource_id) === meera.id).plan_name, 'Target 50k');
  });

  // --- Meat shop ---------------------------------------------------------------------------------
  await t.test('cut to order and yield compared by supplier', async () => {
    const mloc = (await request('GET', M('locations'))).items[0];
    const nil = (await request('GET', M('tax-rates'))).items.find((r) => Number(r.rate) === 0);
    const weighed = (name, code, price, tracking = 'quantity') => request('POST', M('catalog'), { name, code, kind: 'goods', unit: 'kg', tracking, price, taxRateId: nil.id }, 201);
    const bird = await weighed('Live bird', 'LIVE', '180', 'batch');
    const curry = await weighed('Curry cut', 'CURRY', '260');
    const boneless = await weighed('Boneless', 'BNLS', '380');
    const farmA = await request('POST', M('contacts'), { kind: 'supplier', name: 'Sri Lakshmi Farms' }, 201);
    const farmB = await request('POST', M('contacts'), { kind: 'supplier', name: 'Venkateshwara Hatcheries' }, 201);
    await request('POST', M('documents'), { kind: 'purchase', locationId: mloc.id, contactId: farmA.id, requestKey: key(), lines: [{ skuId: bird.id, quantity: '20', unitPrice: '120', lotCode: 'A1' }] }, 201);
    const lotA = await one("SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code='A1'", [meat.id, bird.id]);
    // Cut to order: 2 kg whole → 1.2 curry + 0.3 boneless; bill at their own rates.
    const cutBatch = await request('POST', M('weight/cut-to-order'), { inputLotId: lotA.id, inputQuantity: '2', cutBy: 'Salim', requestKey: key(),
      outputs: [{ skuId: curry.id, quantity: '1.2' }, { skuId: boneless.id, quantity: '0.3' }] }, 201);
    assert.equal(cutBatch.cut_to_order, true);
    assert.equal(cutBatch.loss_kg, '0.500');
    assert.equal(Number((await one('SELECT quantity FROM business_stock_lots WHERE id=$1', [lotA.id])).quantity), 18, 'the whole weight left stock');
    const sale = await request('POST', M('documents'), { kind: 'sale', locationId: mloc.id, requestKey: key(), lines: [{ skuId: curry.id, quantity: '1.2' }, { skuId: boneless.id, quantity: '0.3' }],
      payment: { amount: '426', method: 'cash' } }, 201);
    assert.equal(sale.total, '426.00', '1.2 × 260 + 0.3 × 380');
    // Farm B's birds dress out lighter.
    await request('POST', M('documents'), { kind: 'purchase', locationId: mloc.id, contactId: farmB.id, requestKey: key(), lines: [{ skuId: bird.id, quantity: '10', unitPrice: '110', lotCode: 'B1' }] }, 201);
    const lotB = await one("SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code='B1'", [meat.id, bird.id]);
    await request('POST', M('weight/processing'), { inputLotId: lotB.id, inputQuantity: '4', requestKey: key(), outputs: [{ skuId: curry.id, quantity: '2.4' }] }, 201);
    // A batch cut before the supplier was kept still finds it through the purchase.
    const old = await request('POST', M('weight/processing'), { inputLotId: lotA.id, inputQuantity: '2', requestKey: key(), outputs: [{ skuId: curry.id, quantity: '1.6' }] }, 201);
    const raw = await pool.connect();
    try {
      // As batches cut before the supplier was kept (append-only rows: triggers off for this fixture).
      await raw.query('BEGIN');
      await raw.query('SET LOCAL session_replication_role = replica');
      await raw.query('UPDATE weight_processing_batches SET supplier_id=NULL WHERE id=$1', [old.id]);
      await raw.query('COMMIT');
    } finally { raw.release(); }
    const today = (await one("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).d;
    const report = await request('GET', M(`weight/reports/yield?from=${today}&to=${today}`));
    const a = report.bySupplier.find((r) => Number(r.supplier_id) === farmA.id);
    const b = report.bySupplier.find((r) => Number(r.supplier_id) === farmB.id);
    assert.equal(a.batches, 2);
    assert.equal(a.yield_percent, '77.50', '(1.5 + 1.6) ÷ 4 kg');
    assert.equal(b.yield_percent, '60.00');
    assert.ok(Number(b.versus_average) < 0 && Number(a.versus_average) > 0);
    const onlyB = await request('GET', M(`weight/reports/yield?from=${today}&to=${today}&supplier=${farmB.id}`));
    assert.equal(onlyB.totals.batches, 1);
  });

  // --- Repairs ------------------------------------------------------------------------------------
  await t.test('repair advance: taken at intake, used at delivery, refunded on cancel with a manager PIN', async () => {
    const eLocation = (await request('GET', E('locations'))).items[0];
    const intake = { locationId: eLocation.id, customerName: 'Suresh', customerPhone: '99887 12345', device: 'Redmi Note 12', problem: 'Charging port', estimate: '800',
      advance: { amount: '300', method: 'cash' } };
    const job = await people.electronics_cashier.call('POST', E('repairs'), { ...intake, requestKey: key() }, 201);
    let detail = await request('GET', E(`repairs/${job.id}`));
    assert.equal(detail.advance.free, '300.00');
    // Not while the job is open.
    const open = await call('POST', E(`repairs/${job.id}/advance-refund`), { method: 'cash', reason: 'x', approverId: people.electronics_manager.id, pin: '2468', requestKey: key() },
      await login('r2svc-owner@test.invalid'));
    assert.equal(open.status, 409);
    assert.match(open.body.message, /still open/);
    await request('POST', E(`repairs/${job.id}/cancel`), { reason: 'Customer took it back' });
    const listed = (await request('GET', E('repairs?advance_to_refund=true'))).items;
    assert.ok(listed.some((j) => j.id === job.id));
    await people.electronics_cashier.call('POST', E(`repairs/${job.id}/advance-refund`), { method: 'cash', reason: 'Cancelled', requestKey: key() }, 400);
    const refund = await people.electronics_cashier.call('POST', E(`repairs/${job.id}/advance-refund`), { method: 'cash', reason: 'Cancelled, not repairable',
      approverId: people.electronics_manager.id, pin: '2468', requestKey: key() }, 201);
    assert.equal(refund.amount, '300.00');
    detail = await request('GET', E(`repairs/${job.id}`));
    assert.equal(detail.advance.free, '0.00');
    assert.equal(detail.advance.refunds.length, 1);
    assert.ok(detail.events.some((e) => /Advance refunded/.test(e.note || '')));
    await request('POST', E(`repairs/${job.id}/advance-refund`), { method: 'cash', reason: 'again', approverId: people.electronics_manager.id, pin: '2468', requestKey: key() }, 409);
    // Delivered for less than the advance: the rest is refunded.
    const labour = await request('POST', E('catalog'), { kind: 'service', name: 'Port labour', code: 'PRT', unit: 'service', price: '200', taxRate: '0' }, 201);
    const second = await request('POST', E('repairs'), { ...intake, requestKey: key() }, 201);
    await request('POST', E(`repairs/${second.id}/lines`), { kind: 'labour', skuId: labour.id }, 201);
    await request('POST', E(`repairs/${second.id}/status`), { status: 'ready' });
    await request('POST', E(`repairs/${second.id}/deliver`), { requestKey: key() });
    detail = await request('GET', E(`repairs/${second.id}`));
    assert.equal(detail.advance.free, '100.00');
    const rest = await request('POST', E(`repairs/${second.id}/advance-refund`), { method: 'upi', reference: 'UPI-9921', reason: 'Bill came to less', pin: '2468',
      approverId: people.electronics_manager.id, requestKey: key() }, 201);
    assert.equal(rest.amount, '100.00');
  });
});
