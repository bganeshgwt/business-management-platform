const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom, addDays } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A jeweller's money beyond the counter: rate sessions the shop names, old
// gold bought by the shop's buy-back rules (its own pieces by HUID or tag, each
// purity's deduction for outside jewellery, another deduction only with a
// manager's approval), photos of it, several of a seller's vouchers paid out at
// once within the cash limits, and its metal sent to a refiner (back refined),
// a bullion dealer (sold on a bill) or a karigar; gold schemes closed on their
// day 364 into the customer's safekeeping and collected, a returned bill's
// scheme money put back within the tenure, and the scheme money against 25% of
// a company's net worth; the cash report linking customers by PAN, phone and
// family group over the rolling month with the shop's alert levels and the
// flag at ₹10 lakh; customers' KYC, masked but to those who may see it, kept
// through an erasure; the suspicious transaction log behind its own
// permission; and on the jewellery bill, the shop's offers on making, a
// discount at the counter within its limits, and loose stones and coins at
// their own slabs. Postings are idempotent, the refusals carry their codes,
// audit and events are written, and the database keeps the rules whatever
// writes the rows. Runs on its own throwaway database with every migration applied.
test('jewellery money: old gold, refiners, schemes on day 364, the cash report, KYC, the STR log and the bill\'s discounts', { timeout: 600000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, scratch, created = false;
  await admin.connect();
  t.after(async () => {
    if (scratch) await scratch.end();
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
  const migrations = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: migrations, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes the money pieces away and puts back what it replaced; Up brings them again', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const left = async () => (await scratch.query(`SELECT
        (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tablename IN ('jewellery_buyback_deductions','jewellery_refinery_challans','jewellery_refinery_lines',
          'jewellery_old_gold_next','jewellery_kyc_documents','jewellery_kyc_owners','jewellery_scheme_closes','jewellery_scheme_moves','jewellery_cash_families',
          'jewellery_cash_family_members','jewellery_str_cases','jewellery_str_entries','jewellery_offers','jewellery_bill_items')) AS tables,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='jewellery_settings' AND column_name IN ('rate_sessions','own_piece_deduction','cash_alert_levels',
          'kyc_kinds','discount_on_metal','company_net_worth','net_worth_on')) AS settings,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='jewellery_settings' AND column_name='cash_watch_level') AS watch,
        (SELECT count(*)::int FROM business_permissions WHERE code IN ('jewellery.manage','jewellery.review')) AS permissions,
        (SELECT count(*)::int FROM pg_proc WHERE proname='jewellery_pieces_guard' AND prosrc LIKE '%safekeeping%') AS guard`)).rows[0];
    assert.deepEqual(await left(), { tables: 14, settings: 7, watch: 0, permissions: 2, guard: 1 });
    // This migration's Down half (found by its name), after those of every newer one.
    const file = fs.readdirSync(migrations).find((name) => /^\d+_jewellery-money\.sql$/.test(name));
    await migrate({ direction: 'down', count: Number(file.split('_')[0]), timestamp: true });
    assert.deepEqual(await left(), { tables: 0, settings: 0, watch: 1, permissions: 0, guard: 0 });
    assert.ok((await scratch.query("SELECT 1 FROM pg_proc WHERE proname='jewellery_pieces_guard'")).rows.length, 'the earlier guard is back');
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await left(), { tables: 14, settings: 7, watch: 0, permissions: 2, guard: 1 });
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Gold-${crypto.randomBytes(8).toString('hex')}`;
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
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('money-owner');
  await owner('money-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('money-owner@test.invalid');
  const request = as(ownerToken);
  const otherToken = await login('money-other@test.invalid');
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const today = daysFrom(0);

  const [jeweller, grocery] = await createBusinesses(request, 'MONEY', ['jewellery', 'grocery']);
  const J = (suffix) => `/businesses/${jeweller.id}/${suffix}`;
  const shop = (await request('GET', J('locations'))).items[0];
  const roles = (await request('GET', J('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', J('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const manager = await staff('money-manager@test.invalid', 'manager');
  const cashier = await staff('money-cashier@test.invalid', 'cashier');
  const karigarUser = await staff('money-karigar@test.invalid', 'karigar');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [manager.id, await bcrypt.hash('2468', 4)]);
  const rounding = (await one('SELECT rounding FROM business_settings WHERE business_id=$1', [jeweller.id])).rounding;
  // A bill's total as the business rounds it (paise to rupees).
  const billTotal = (paise) => ((rounding === 'nearest_rupee' ? Math.floor((paise + 50) / 100) * 100 : paise) / 100).toFixed(2);
  const audited = async (action) => (await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action=$2', [jeweller.id, action])).n;
  const evented = async (kind) => (await one('SELECT count(*)::int AS n FROM business_events WHERE business_id=$1 AND kind=$2', [jeweller.id, kind])).n;
  const metalOf = async (purity) => (await request('GET', J('jewellery/metal'))).find((m) => m.purity === purity) || { net_weight: '0.000', fine_weight: '0.000' };
  const customer = (name, extra = {}) => request('POST', J('contacts'), { kind: 'customer', name, ...extra }, 201);
  // Time passes, with the guards stood aside for the test only.
  async function asOf(sql, values, triggers) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      for (const [table, trigger] of triggers) await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await db.query(sql, values);
      for (const [table, trigger] of triggers) await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  // A scheme moved back so many days, as if joined then.
  const schemeBack = (schemeId, days) => asOf(`UPDATE jewellery_schemes SET started_on=started_on-$2::int,
      maturity_on=(started_on-$2::int+make_interval(months => instalments))::date,close_by=started_on-$2::int+364 WHERE id=$1`, [schemeId, days],
  [['jewellery_schemes', 'jewellery_schemes_guard']]);
  // A voucher's payouts moved to midday of another day.
  const cashOn = (voucherId, day) => asOf("UPDATE jewellery_old_gold_payouts SET created_at=($2::date+time '12:00') AT TIME ZONE 'Asia/Kolkata' WHERE old_gold_id=$1",
    [voucherId, day], [['jewellery_old_gold_payouts', 'jewellery_old_gold_payouts_append_only']]);
  async function upload(token, fields, bytes, type, name) {
    const form = new FormData();
    for (const [field, value] of Object.entries(fields)) form.append(field, String(value));
    form.append('file', new Blob([bytes], { type }), name);
    const response = await fetch(`${base}${J('jewellery/files')}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

  // --- Rate sessions ---------------------------------------------------------------------------------------
  await t.test('rate sessions: the shop names its own beyond morning and evening, and a sheet of one of them is in use', async () => {
    await manager.call('POST', J('jewellery/rates'), { requestKey: key(), session: 'morning', source: 'association', rates: [
      { metal: 'gold', purity: '22K', sellRate: '11900', buyRate: '11600' }] }, 201);
    assert.match((await refused('POST', J('jewellery/rates'), { requestKey: key(), session: 'Noon', source: 'shop', rates: [{ metal: 'gold', purity: '22K', sellRate: '12000' }] },
      manager.token)).message, /name the shop's other sessions in Jewellery settings first/);
    assert.match((await refused('PUT', J('jewellery/settings'), { rateSessions: ['Noon', 'Morning'] })).message, /Morning is one every shop has already/);
    assert.equal((await refused('PUT', J('jewellery/settings'), { rateSessions: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] })).status, 400);
    assert.match((await refused('PUT', J('jewellery/settings'), { rateSessions: ['Noon', 'noon'] })).message, /twice/);
    assert.equal((await refused('PUT', J('jewellery/settings'), { rateSessions: ['Noon'] }, cashier.token)).status, 403, 'settings are for those who change settings');
    const s = await request('PUT', J('jewellery/settings'), { rateSessions: ['Noon', 'Late evening'] });
    assert.deepEqual(s.rateSessions, ['Noon', 'Late evening']);
    const body = { requestKey: key(), session: 'noon', source: 'association', note: 'After the association\'s noon call', rates: [
      { metal: 'gold', purity: '24K', sellRate: '13000', buyRate: '12700' }, { metal: 'gold', purity: '22K', sellRate: '12000', buyRate: '11700' },
      { metal: 'gold', purity: '18K', sellRate: '9800', buyRate: '9500' }, { metal: 'silver', purity: '999', sellRate: '150', buyRate: '140' }] };
    const now = await manager.call('POST', J('jewellery/rates'), body, 201);
    const g22 = now.rates.find((r) => r.purity === '22K');
    assert.deepEqual([g22.sell_rate, g22.session, g22.session_name, g22.session_words], ['12000.00', 'own', 'Noon', 'Noon']);
    assert.deepEqual(now.sessions.map((x) => x.label), ['Morning', 'Evening', 'Noon', 'Late evening']);
    assert.equal((await manager.call('POST', J('jewellery/rates'), body, 201)).sheets, 2, 'a retry sets no other sheet');
    assert.match((await refused('POST', J('jewellery/rates'), { ...body, requestKey: key(), session: 'Afternoon' }, manager.token)).message,
      /morning, evening or one of the shop's own: Noon, Late evening/);
    const sheets = await request('GET', J('jewellery/rates'));
    assert.deepEqual([sheets.items[0].session, sheets.items[0].session_name], ['own', 'Noon']);
    // The database keeps the rule: a session of the shop's own is one it named.
    await assert.rejects(pool.query(`INSERT INTO jewellery_rate_sheets(business_id,session,session_name,source,request_key,request_hash,created_by)
      VALUES($1,'own','Night','shop',$2,$3,$4)`, [jeweller.id, key(), 'n'.repeat(64), ownerUser.id]), /Night is not one of the shop's sessions/);
    await assert.rejects(pool.query(`INSERT INTO jewellery_rate_sheets(business_id,session,source,request_key,request_hash,created_by)
      VALUES($1,'own','shop',$2,$3,$4)`, [jeweller.id, key(), 'n'.repeat(64), ownerUser.id]), /session_name/);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='jewellery_rates.set' ORDER BY id DESC LIMIT 1", [jeweller.id]);
    assert.equal(audit.details.session, 'Noon');
  });

  // --- Items, pieces, stones and coins ----------------------------------------------------------------------
  const slabs = (await request('GET', J('tax-rates'))).items;
  const slab = (rate) => slabs.find((r) => Number(r.rate) === rate);
  const supplier = await request('POST', J('contacts'), { kind: 'supplier', name: 'Zaveri Bullion & Gems' }, 201);
  const item = async (body) => (await request('POST', J('jewellery/items'), body, 201)).items.find((i) => i.label === body.item.name);
  const necklace = await item({ item: { name: 'Gold necklace', hsnCode: '7113' }, metal: 'gold', purity: '22K', wastagePercent: '8', makingMode: 'per_gram', makingValue: '300' });
  const chain = await item({ item: { name: 'Gold chain', hsnCode: '7113' }, metal: 'gold', purity: '22K', wastagePercent: '5', makingMode: 'per_gram', makingValue: '250' });
  const ring = await item({ item: { name: 'Gold ring', hsnCode: '7113' }, metal: 'gold', purity: '18K', makingMode: 'flat', makingValue: '5000' });
  const tag = (skuId, tagNo, grossWeight, huid) => request('POST', J('jewellery/pieces'), { requestKey: key(), skuId, tagNo, comesIn: 'new', locationId: shop.id, reason: 'opening',
    grossWeight, hallmarked: true, huids: [huid], cost: '1000' }, 201);
  await tag(necklace.sku_id, 'NK-1', '20.000', 'NK11AA');
  await tag(necklace.sku_id, 'NK-2', '15.000', 'NK22BB');
  await tag(ring.sku_id, 'RG-1', '4.000', 'RG11CC');
  await tag(chain.sku_id, 'OWN-1', '10.000', 'OW12AB');
  await tag(chain.sku_id, 'CH-2', '8.000', 'CH22DD');
  await tag(chain.sku_id, 'CH-3', '8.000', 'CH33EE');
  const goods = (body) => request('POST', J('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', ...body }, 201);
  const diamond = await goods({ name: 'Loose diamond 0.50 ct', code: 'DIA-50', price: '45000', taxRateId: slab(0.25).id, hsnCode: '7102' });
  const coin = await goods({ name: 'Gold coin 10 g 24K', code: 'COIN-10', price: '135000', taxRateId: slab(3).id, hsnCode: '7118' });
  const polish = await request('POST', J('catalog'), { kind: 'service', unit: 'service', name: 'Polishing', code: 'POL-1', price: '500', taxRateId: slab(18).id }, 201);
  await request('POST', J('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
    lines: [{ skuId: diamond.id, quantity: '1', unitPrice: '40000' }, { skuId: coin.id, quantity: '5', unitPrice: '130000' }] }, 201);
  const kavya = await customer('Kavya Menon', { phone: '9845011111', pan: 'AKXPM1234Q' });

  // --- Offers and the counter's discount -----------------------------------------------------------------------
  let dhanteras, wedding;
  await t.test('offers on making by dates: the best running offer for the piece\'s metal, printed as such; switched off, never changed', async () => {
    const offer = (body) => ({ requestKey: key(), startsOn: today, endsOn: daysFrom(3), ...body });
    assert.equal((await refused('POST', J('jewellery/offers'), offer({ name: 'Counter offer', makingPercent: '5' }), cashier.token)).status, 403);
    assert.equal((await refused('POST', J('jewellery/offers'), offer({ name: 'Back to front', makingPercent: '5', endsOn: daysFrom(-1) }), manager.token)).status, 400);
    assert.equal((await refused('POST', J('jewellery/offers'), offer({ name: 'Past', makingPercent: '5', startsOn: daysFrom(-9), endsOn: daysFrom(-2) }), manager.token)).status, 400);
    assert.equal((await refused('POST', J('jewellery/offers'), offer({ name: 'Too much', makingPercent: '101' }), manager.token)).status, 400);
    const body = offer({ name: 'Dhanteras', makingPercent: '20', metal: 'gold' });
    let list = await manager.call('POST', J('jewellery/offers'), body, 201);
    assert.equal((await manager.call('POST', J('jewellery/offers'), body, 201)).items.length, 1, 'a retry makes no other offer');
    assert.equal((await refused('POST', J('jewellery/offers'), { ...body, makingPercent: '25' }, manager.token)).status, 409);
    list = await manager.call('POST', J('jewellery/offers'), offer({ name: 'Wedding season', makingPercent: '10', endsOn: daysFrom(30) }), 201);
    dhanteras = list.items.find((o) => o.name === 'Dhanteras');
    wedding = list.items.find((o) => o.name === 'Wedding season');
    assert.deepEqual([dhanteras.running, dhanteras.metal_words, wedding.metal_words], [true, 'Gold', 'Every metal']);
    // NK-1: 20 g of 22K at ₹12,000, 8% wastage (₹19,200) and ₹300 a gram making (₹6,000): ₹2,65,200; the best offer takes 20% off the making.
    const preview = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['NK-1'] });
    const line = preview.lines[0];
    assert.deepEqual([line.value, line.offer.name, line.offerDiscount, line.discount, line.taxable, line.tax], ['265200.00', 'Dhanteras', '1200.00', '1200.00', '264000.00', '7920.00']);
    assert.deepEqual([preview.offerDiscount, preview.counterDiscount, preview.total], ['1200.00', '0.00', billTotal(27192000)]);
    // An offer keeps its terms in the database too.
    await assert.rejects(pool.query('UPDATE jewellery_offers SET making_percent=50 WHERE id=$1', [dhanteras.id]), /keeps its terms/);
    await assert.rejects(pool.query('DELETE FROM jewellery_offers WHERE id=$1', [dhanteras.id]), /never deleted/);
    assert.equal(await audited('jewellery_offer.created'), 2);
    assert.equal(await evented('jewellery_offer.created'), 2);
  });

  let nkBill;
  await t.test('a discount at the counter: off making and wastage (the metal only where the settings allow), within the most on a bill, with why', async () => {
    const bill = (extra) => ({ locationId: shop.id, tags: ['NK-1'], contactId: kavya.id, ...extra });
    // The counter needs sales.discount; a discount comes with why.
    assert.equal((await refused('POST', J('jewellery/bills/preview'), bill({ discount: { amount: '1000', reason: 'Regular' } }), cashier.token)).status, 403);
    assert.equal((await refused('POST', J('jewellery/bills/preview'), bill({ discount: { amount: '1000' } }), manager.token)).status, 400);
    // Making ₹6,000 + wastage ₹19,200 − the offer's ₹1,200: at most ₹24,000 comes off; never the metal's value.
    assert.match((await refused('POST', J('jewellery/bills/preview'), bill({ discount: { amount: '24000.01', reason: 'Regular' } }), manager.token)).message,
      /at most 24000\.00 on this bill \(never the metal's value/);
    const body = { requestKey: key(), ...bill({ discount: { amount: '5000', reason: 'Regular customer' } }), payments: [{ method: 'upi', amount: 'full' }] };
    const preview = await manager.call('POST', J('jewellery/bills/preview'), body);
    assert.deepEqual([preview.lines[0].offerDiscount, preview.lines[0].counterDiscount, preview.lines[0].discount, preview.lines[0].taxable, preview.lines[0].tax],
      ['1200.00', '5000.00', '6200.00', '259000.00', '7770.00']);
    nkBill = await manager.call('POST', J('jewellery/bills'), body, 201);
    assert.equal((await manager.call('POST', J('jewellery/bills'), body, 201)).id, nkBill.id, 'a retry bills nothing more');
    assert.equal((await refused('POST', J('jewellery/bills'), { ...body, discount: { amount: '5001', reason: 'Regular customer' } }, manager.token)).status, 409);
    assert.deepEqual([nkBill.offer_discount, nkBill.counter_discount, nkBill.discount_reason, nkBill.discount_on_metal, nkBill.total],
      ['1200.00', '5000.00', 'Regular customer', false, billTotal(26677000)]);
    // The invoice prints each discount as such.
    const doc = await request('GET', J(`documents/${nkBill.document_id}`));
    assert.deepEqual(doc.jewellery.discounts, { offer: '1200.00', counter: '5000.00', reason: 'Regular customer', onMetal: false });
    assert.deepEqual([doc.jewellery.lines[0].offer_name, doc.jewellery.lines[0].offer_discount, doc.jewellery.lines[0].counter_discount], ['Dhanteras', '1200.00', '5000.00']);
    const posted = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='jewellery_bill.posted' AND entity_id=$2", [jeweller.id, nkBill.id]);
    assert.deepEqual(posted.details.counterDiscount, { amount: '5000.00', reason: 'Regular customer', onMetal: false });
    // The business's most on a bill: a manager stays within it, the owner may give more.
    await pool.query('UPDATE business_settings SET max_bill_discount_percent=2 WHERE business_id=$1', [jeweller.id]);
    const ringBill = { locationId: shop.id, tags: ['NK-2'], contactId: kavya.id, discount: { amount: '4000', reason: 'Festival' } };
    assert.match((await refused('POST', J('jewellery/bills/preview'), ringBill, manager.token)).message, /At most 2% of a bill \(3978\.00 before GST on this one\)/);
    assert.equal((await request('POST', J('jewellery/bills/preview'), ringBill)).counterDiscount, '4000.00');
    await pool.query('UPDATE business_settings SET max_bill_discount_percent=10 WHERE business_id=$1', [jeweller.id]);
    // The metal's value takes a discount only where the shop's settings say so.
    const big = { ...ringBill, discount: { amount: '20000', reason: 'Wedding order' } };
    assert.match((await refused('POST', J('jewellery/bills/preview'), big)).message, /at most 18000\.00 on this bill/);
    assert.equal((await request('PUT', J('jewellery/settings'), { discountOnMetal: true })).discountOnMetal, true);
    assert.equal((await request('POST', J('jewellery/bills/preview'), big)).counterDiscount, '20000.00');
    await request('PUT', J('jewellery/settings'), { discountOnMetal: false });
    // The database keeps a counter discount on making and wastage when the rule says so.
    await assert.rejects(pool.query('UPDATE jewellery_bill_lines SET counter_discount=1 WHERE bill_id=$1', [nkBill.id]), /kept as it was billed/);
  });

  await t.test('loose stones and coins: their own lines at their catalogue prices and GST slabs, beside the pieces', async () => {
    const body = { requestKey: key(), locationId: shop.id, tags: ['NK-2'], contactId: kavya.id, items: [{ skuId: diamond.id }, { skuId: coin.id, quantity: '2' }],
      payments: [{ method: 'upi', amount: 'full' }] };
    const preview = await cashier.call('POST', J('jewellery/bills/preview'), body);
    assert.deepEqual(preview.problems, []);
    assert.deepEqual(preview.items.map((x) => [x.label, x.taxRate, x.value, x.taxable, x.tax]),
      [['Loose diamond 0.50 ct', '0.25', '45000.00', '45000.00', '112.50'], ['Gold coin 10 g 24K', '3.00', '270000.00', '270000.00', '8100.00']]);
    // NK-2: 15 g at ₹12,000, ₹14,400 wastage, ₹4,500 making less the offer's ₹900: ₹1,98,000 taxable, ₹5,940 GST.
    assert.deepEqual([preview.lines[0].taxable, preview.lines[0].tax], ['198000.00', '5940.00']);
    assert.deepEqual([preview.subtotal, preview.tax, preview.total], ['513000.00', '14152.50', billTotal(52715250)]);
    // What is not a loose stone or coin is refused as one.
    const odd = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, items: [{ skuId: polish.id }, { skuId: necklace.sku_id }, { skuId: coin.id, quantity: '9' }] });
    assert.deepEqual(odd.problems.map((p) => p.replace(/:.*/, '')), ['Polishing is a service', 'Gold necklace is sold as tagged pieces', 'Not enough of Gold coin 10 g 24K in stock here']);
    assert.equal((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, items: [{ skuId: 999999 }] }, cashier.token)).status, 404);
    assert.equal((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id }, cashier.token)).status, 400);
    // The counter finds them in the catalogue by name.
    const found = await cashier.call('GET', J('catalog?q=Gold%20coin%2010%20g%2024K&kind=goods&active=true&limit=15'));
    assert.deepEqual(found.items.map((s) => s.label), ['Gold coin 10 g 24K']);
    const bill = await cashier.call('POST', J('jewellery/bills'), body, 201);
    assert.deepEqual(bill.items.map((x) => [x.label, x.quantity, x.tax_rate, x.taxable, x.tax]),
      [['Loose diamond 0.50 ct', '1.000', '0.25', '45000.00', '112.50'], ['Gold coin 10 g 24K', '2.000', '3.00', '270000.00', '8100.00']]);
    const doc = await request('GET', J(`documents/${bill.document_id}`));
    assert.deepEqual(doc.lines.map((l) => Number(l.tax_rate)), [3, 0.25, 3]);
    assert.equal(doc.total, billTotal(52715250));
    const coins = await one('SELECT COALESCE(sum(quantity),0) AS n FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [jeweller.id, coin.id]);
    assert.equal(Number(coins.n), 3, 'the coins leave stock');
    await assert.rejects(pool.query(`INSERT INTO jewellery_bill_items(business_id,bill_id,line_id,sku_id,quantity,unit_price,value,discount,taxable,tax_rate,tax)
      SELECT business_id,bill_id,line_id,sku_id,quantity,unit_price,value,discount,taxable,tax_rate,tax FROM jewellery_bill_items WHERE bill_id=$1 LIMIT 1`, [bill.id]),
    /when the bill is made|duplicate key/);
    // The offers end: from here on the bills take none.
    await manager.call('PUT', J(`jewellery/offers/${dhanteras.id}`), { active: false });
    const after = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['CH-2'] });
    assert.deepEqual([after.lines[0].offer.name, after.lines[0].offerDiscount], ['Wedding season', '200.00']);
    const list = await manager.call('PUT', J(`jewellery/offers/${wedding.id}`), { active: false });
    assert.ok(list.items.every((o) => !o.active && !o.running));
    assert.equal(list.items.find((o) => o.name === 'Dhanteras').pieces, 2);
    assert.equal(await audited('jewellery_offer.updated'), 2);
  });

  // --- Old gold: the buy-back rules --------------------------------------------------------------------------
  let kavyaGold;
  await t.test('old gold by the shop\'s buy-back rules: its own pieces by HUID or tag, each purity\'s deduction, another only with a manager', async () => {
    await cashier.call('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, tags: ['OWN-1'], contactId: kavya.id, payments: [{ method: 'upi', amount: 'full' }] }, 201);
    const s = await request('PUT', J('jewellery/settings'), { oldGoldDeduction: '3', ownPieceDeduction: '0.5', purityDeductions: [{ metal: 'gold', purity: '22K', deductionPercent: '2' }] });
    assert.deepEqual([s.oldGoldDeduction, s.ownPieceDeduction, s.purityDeductions.find((d) => d.purity === '22K').deductionPercent, s.purityDeductions.find((d) => d.purity === '18K').deductionPercent],
      ['3.00', '0.50', '2.00', null]);
    assert.equal((await refused('PUT', J('jewellery/settings'), { purityDeductions: [{ metal: 'gold', purity: '22K', deductionPercent: '2' }, { metal: 'gold', purity: '22k', deductionPercent: '1' }] })).status, 400);
    const lines = [
      { description: 'Chain bought here', metal: 'gold', purity: '22K', testMethod: 'xrf', grossWeight: '10.000', huid: 'ow12ab' },
      { description: 'Outside bangle', metal: 'gold', purity: '22K', testMethod: 'touchstone', grossWeight: '12.000' },
      { description: 'Outside ring', metal: 'gold', purity: '18K', testMethod: 'acid', grossWeight: '4.000' }];
    const preview = await cashier.call('POST', J('jewellery/old-gold/preview'), { lines });
    // 10 g × ₹11,700 less 0.5% (its own piece) = ₹1,16,415; 12 g less 2% (22K) = ₹1,37,592; 4 g × ₹9,500 less 3% (the general rule) = ₹36,860.
    assert.deepEqual(preview.lines.map((l) => [l.rule, l.deductionPercent, l.ownTag, l.value]), [['own_piece', '0.50', 'OWN-1', '116415.00'], ['purity', '2.00', null, '137592.00'],
      ['general', '3.00', null, '36860.00']]);
    assert.deepEqual([preview.value, preview.needsApproval, preview.panNeeded], ['290867.00', false, true]);
    // The tag finds the piece as the HUID does; a piece the shop has not sold, or a tag of none, is refused.
    assert.equal((await cashier.call('POST', J('jewellery/old-gold/preview'), { lines: [{ ...lines[0], huid: undefined, tag: 'own-1' }] })).lines[0].rule, 'own_piece');
    const one22 = (extra) => ({ lines: [{ description: 'Article', metal: 'gold', purity: '22K', testMethod: 'xrf', grossWeight: '5', ...extra }] });
    assert.match((await refused('POST', J('jewellery/old-gold/preview'), one22({ huid: 'RG11CC' }), cashier.token)).message, /piece RG-1 is in stock here, not sold/);
    assert.equal((await refused('POST', J('jewellery/old-gold/preview'), one22({ tag: 'NOPE-9' }), cashier.token)).status, 404);
    assert.match((await refused('POST', J('jewellery/old-gold/preview'), one22({ tag: 'OWN-1', huid: 'NK11AA' }), cashier.token)).message, /HUID NK11AA is not on piece OWN-1/);
    // Another deduction on a line: the counter asks a manager, who approves with their PIN and why.
    const changed = lines.map((l, i) => (i === 1 ? { ...l, deductionPercent: '1' } : l));
    const asked = await cashier.call('POST', J('jewellery/old-gold/preview'), { lines: changed });
    assert.deepEqual([asked.needsApproval, asked.lines[1].override, asked.lines[1].rulePercent, asked.lines[1].value], [true, true, '2.00', '138996.00']);
    const body = { requestKey: key(), locationId: shop.id, contactId: kavya.id, idKind: 'pan_card', idRef: 'AKXPM1234Q', ownerDeclared: true, lines: changed };
    assert.match((await refused('POST', J('jewellery/old-gold'), body, cashier.token)).message, /Why the deduction is changed is required/);
    assert.match((await refused('POST', J('jewellery/old-gold'), { ...body, approval: { reason: 'Long-standing customer' } }, cashier.token)).message, /manager's PIN/);
    assert.match((await refused('POST', J('jewellery/old-gold'), { ...body, approval: { approverId: manager.id, pin: '1111', reason: 'Long-standing customer' } }, cashier.token)).message,
      /That PIN is not right/);
    const approved = { ...body, approval: { approverId: manager.id, pin: '2468', reason: 'Long-standing customer' } };
    kavyaGold = await cashier.call('POST', J('jewellery/old-gold'), approved, 201);
    assert.deepEqual([kavyaGold.value, kavyaGold.lines.map((l) => [l.deduction_rule, l.deduction_percent, l.own_tag, l.override_by_name, l.override_reason])],
      ['292271.00', [['own_piece', '0.50', 'OWN-1', null, null], ['purity', '1.00', null, 'money-manager', 'Long-standing customer'], ['general', '3.00', null, null, null]]]);
    assert.equal((await cashier.call('POST', J('jewellery/old-gold'), approved, 201)).id, kavyaGold.id, 'a retry gives the same voucher');
    const change = await one("SELECT actor_id,details FROM business_audit WHERE business_id=$1 AND action='jewellery_old_gold.deduction_changed' AND entity_id=$2", [jeweller.id, kavyaGold.id]);
    assert.deepEqual([Number(change.actor_id), change.details.rulePercent, change.details.deductionPercent, change.details.reason], [manager.id, '2.00', '1.00', 'Long-standing customer']);
    // A manager changing it themselves gives only why.
    const self = await manager.call('POST', J('jewellery/old-gold'), { ...body, requestKey: key(), lines: [{ ...lines[2], deductionPercent: '2.5' }], approval: { reason: 'Clean metal' } }, 201);
    assert.equal(self.lines[0].override_by_name, 'money-manager');
    // The database keeps the rule on what a line records.
    await assert.rejects(pool.query('UPDATE jewellery_old_gold_lines SET deduction_rule=$2 WHERE old_gold_id=$1', [kavyaGold.id, 'general']), /kept as it was written/);
    // Photos of what came in: up to ten a voucher, a photo only, opened by those who see old gold.
    const photo = await upload(cashier.token, { oldGoldId: kavyaGold.id }, png, 'image/png', 'bangle.png');
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    assert.equal((await upload(cashier.token, { oldGoldId: kavyaGold.id }, pdf, 'application/pdf', 'scan.pdf')).status, 400);
    assert.equal((await upload(karigarUser.token, { oldGoldId: kavyaGold.id }, png, 'image/png', 'x.png')).status, 403);
    await upload(cashier.token, { oldGoldId: kavyaGold.id }, png, 'image/png', 'ring.png');
    const seen = await request('GET', J(`jewellery/old-gold/${kavyaGold.id}`));
    assert.deepEqual(seen.photos.map((p) => p.file_name), ['bangle.png', 'ring.png']);
    const opened = await fetch(`${base}${J(`jewellery/files/${photo.body.data.id}`)}`, { headers: { Authorization: `Bearer ${manager.token}` } });
    assert.equal(opened.status, 200);
    assert.equal(await audited('jewellery_old_gold.photo_added'), 2);
  });

  // --- Several vouchers paid out at once -----------------------------------------------------------------------
  let kiran, k1, k2, k3;
  await t.test('several of one seller\'s vouchers paid out at once: each checked by the cash limits as it is paid, all or none', async () => {
    await request('PUT', J('jewellery/settings'), { oldGoldDeduction: '0', ownPieceDeduction: '', purityDeductions: [] });
    kiran = await customer('Kiran Patil', { phone: '9822012345' });
    const voucher = (grams) => cashier.call('POST', J('jewellery/old-gold'), { requestKey: key(), locationId: shop.id, contactId: kiran.id, idKind: 'voter_id', idRef: 'MH/01/123/456',
      ownerDeclared: true, lines: [{ description: 'Old bangle', metal: 'gold', purity: '22K', testMethod: 'xrf', grossWeight: grams }] }, 201);
    k1 = await voucher('5'); k2 = await voucher('8'); k3 = await voucher('5');
    assert.deepEqual([k1.value, k2.value, k3.value], ['58500.00', '93600.00', '58500.00']);
    const many = (list, extra = {}) => ({ requestKey: key(), contactId: kiran.id, vouchers: list, method: 'cash', ...extra });
    assert.equal((await refused('POST', J('jewellery/old-gold/payouts'), many([{ id: k1.id }]), cashier.token)).status, 403);
    assert.equal((await refused('POST', J('jewellery/old-gold/payouts'), many([]), manager.token)).status, 400);
    assert.equal((await refused('POST', J('jewellery/old-gold/payouts'), many([{ id: k1.id }, { id: k1.id }]), manager.token)).status, 400);
    // All three in cash would take Kiran to ₹2,10,600 in a day: refused at the third, and nothing is paid.
    const all = await refused('POST', J('jewellery/old-gold/payouts'), many([{ id: k1.id }, { id: k2.id }, { id: k3.id }]), manager.token);
    assert.equal(all.status, 409);
    assert.match(all.message, new RegExp(`would reach 210600\\.00 with ${k3.voucher_no.replace(/\//g, '\\/')}`));
    assert.equal((await one('SELECT count(*)::int AS n FROM jewellery_old_gold_payouts WHERE old_gold_id=ANY($1::bigint[])', [[k1.id, k2.id, k3.id]])).n, 0);
    // Another seller's voucher is not paid with Kiran's.
    assert.match((await refused('POST', J('jewellery/old-gold/payouts'), many([{ id: k1.id }, { id: kavyaGold.id }]), manager.token)).message, /brought in by Kavya Menon, not Kiran Patil/);
    const before = await request('GET', J('reports/takings'));
    const body = many([{ id: k1.id }, { id: k2.id }]);
    const paid = await manager.call('POST', J('jewellery/old-gold/payouts'), body, 201);
    assert.deepEqual([paid.seller.name, paid.paid, paid.vouchers.map((g) => [g.state, g.balance])], ['Kiran Patil', '152100.00', [['settled', '0.00'], ['settled', '0.00']]]);
    assert.equal((await manager.call('POST', J('jewellery/old-gold/payouts'), body, 201)).vouchers.length, 2);
    assert.equal((await one('SELECT count(*)::int AS n FROM jewellery_old_gold_payouts WHERE old_gold_id=ANY($1::bigint[])', [[k1.id, k2.id]])).n, 2, 'a retry pays nothing more');
    assert.equal((await refused('POST', J('jewellery/old-gold/payouts'), { ...body, method: 'upi' }, manager.token)).status, 409);
    // Each is its own payout and expense, so the day's money shows them.
    const after = await request('GET', J('reports/takings'));
    assert.equal(Number(after.expenses.cash) - Number(before.expenses.cash), 152100);
    const together = await rows("SELECT details FROM business_audit WHERE business_id=$1 AND action='jewellery_old_gold.paid' AND entity_id=ANY($2::bigint[])", [jeweller.id, [k1.id, k2.id]]);
    assert.deepEqual(together.map((a) => a.details.together), [2, 2]);
    // The third: part by UPI, and the rest in cash would reach the limit.
    let third = await manager.call('POST', J('jewellery/old-gold/payouts'), many([{ id: k3.id, amount: '10000' }], { method: 'upi', reference: 'UPI-1' }), 201);
    assert.equal(third.vouchers[0].balance, '48500.00');
    assert.match((await refused('POST', J('jewellery/old-gold/payouts'), many([{ id: k3.id, amount: '47900' }]), manager.token)).message, /section 186/);
    third = await manager.call('POST', J('jewellery/old-gold/payouts'), many([{ id: k3.id, amount: '47899' }]), 201);
    assert.equal(third.vouchers[0].balance, '601.00');
  });

  // --- What happens next to the metal ----------------------------------------------------------------------
  let refiner, dealer;
  await t.test('old gold\'s metal next: kept to resell, sent to a refiner and back refined, sold to a bullion dealer, issued to a karigar', async () => {
    // A line kept to resell as it is, or put back with the metal to melt.
    assert.equal((await refused('POST', J(`jewellery/old-gold/${k2.id}/next`), { seq: 1, next: 'resell' }, cashier.token)).status, 403);
    assert.equal((await refused('POST', J(`jewellery/old-gold/${k2.id}/next`), { seq: 1, next: 'refinery' }, manager.token)).status, 400);
    assert.equal((await refused('POST', J(`jewellery/old-gold/${k2.id}/next`), { seq: 7, next: 'resell' }, manager.token)).status, 404);
    let now = await manager.call('POST', J(`jewellery/old-gold/${k2.id}/next`), { seq: 1, next: 'resell', note: 'A good design' });
    assert.deepEqual([now.lines[0].next, now.lines[0].next_words], ['resell', 'Kept to resell as it is']);
    now = await manager.call('POST', J(`jewellery/old-gold/${k2.id}/next`), { seq: 1, next: 'melt' });
    assert.equal(now.lines[0].next, 'melt');
    assert.equal(await audited('jewellery_old_gold.next_set'), 2);
    // To a refiner: out of the shop's 22K, naming the old gold it carries.
    refiner = await request('POST', J('contacts'), { kind: 'supplier', name: 'Shree Refinery' }, 201);
    dealer = await customer('Mumbai Bullion House', { gstin: '27AAPFU0939F1ZV' });
    const g22 = await metalOf('22K');
    const send = (extra) => ({ requestKey: key(), locationId: shop.id, party: 'refiner', contactId: refiner.id, lines: [{ metal: 'gold', purity: '22K', netWeight: '10.000' }], ...extra });
    assert.equal((await refused('POST', J('jewellery/refinery'), send(), cashier.token)).status, 403);
    assert.match((await refused('POST', J('jewellery/refinery'), send({ lines: [{ metal: 'gold', purity: '22K', netWeight: '9999' }] }), manager.token)).message, /holds .* cannot go out/);
    assert.equal((await refused('POST', J('jewellery/refinery'), send({ lines: [{ metal: 'gold', purity: '22K', netWeight: '1' }, { metal: 'silver', purity: '999', netWeight: '1' }] }),
      manager.token)).status, 400);
    assert.match((await refused('POST', J('jewellery/refinery'), send({ oldGold: [{ voucherId: kavyaGold.id, seq: 3 }] }), manager.token)).message, /the challan sends none of it/);
    assert.equal((await refused('POST', J('jewellery/refinery'), send({ contactId: dealer.id }), manager.token)).status, 404, 'a refiner is a supplier');
    const body = send({ oldGold: [{ voucherId: k1.id, seq: 1 }], notes: 'Melt and refine' });
    const challan = await manager.call('POST', J('jewellery/refinery'), body, 201);
    assert.match(challan.challan_no, /^RF\/\d{4}\/0001$/);
    assert.deepEqual([challan.outcome, challan.net_weight, challan.fine_weight, challan.old_gold.map((x) => x.voucher_no)], ['out', '10.000', '9.160', [k1.voucher_no]]);
    assert.equal((await manager.call('POST', J('jewellery/refinery'), body, 201)).id, challan.id, 'a retry sends nothing more');
    assert.equal((await refused('POST', J('jewellery/refinery'), { ...body, notes: 'Other' }, manager.token)).status, 409);
    assert.equal((Number(g22.net_weight) - Number((await metalOf('22K')).net_weight)).toFixed(3), '10.000');
    const k1Now = await request('GET', J(`jewellery/old-gold/${k1.id}`));
    assert.deepEqual([k1Now.lines[0].next, k1Now.lines[0].refinery_no], ['refinery', challan.challan_no]);
    assert.match((await refused('POST', J(`jewellery/old-gold/${k1.id}/next`), { seq: 1, next: 'resell' }, manager.token)).message, /went to a refiner or dealer on RF/);
    assert.match((await refused('POST', J('jewellery/refinery'), send({ requestKey: key(), oldGold: [{ voucherId: k1.id, seq: 1 }] }), manager.token)).message, /went on already/);
    // Back refined: 9.000 g of 24K at 999 (8.991 g fine) for the 9.160 g fine that went: 0.169 g lost.
    assert.match((await refused('POST', J(`jewellery/refinery/${challan.id}/back`), { requestKey: key(), purity: '24K', netWeight: '9.200', fineness: '999' }, manager.token)).message,
      /More fine metal comes back/);
    assert.match((await refused('POST', J(`jewellery/refinery/${challan.id}/sell`), { requestKey: key(), rate: '12500' }, manager.token)).message, /went to a refiner/);
    const g24 = await metalOf('24K');
    const back = { requestKey: key(), purity: '24K', netWeight: '9.000', fineness: '999' };
    const refined = await manager.call('POST', J(`jewellery/refinery/${challan.id}/back`), back);
    assert.deepEqual([refined.outcome, refined.back_mark, refined.back_fine_weight, refined.loss_fine], ['back', '24K999', '8.991', '0.169']);
    assert.equal((await manager.call('POST', J(`jewellery/refinery/${challan.id}/back`), back)).outcome, 'back', 'a retry is the same close');
    assert.match((await refused('POST', J(`jewellery/refinery/${challan.id}/back`), { ...back, requestKey: key() }, manager.token)).message, /closed already/);
    assert.equal((Number((await metalOf('24K')).net_weight) - Number(g24.net_weight)).toFixed(3), '9.000');
    // To a bullion dealer, who buys it: a sale bill of the fine metal at the rate, with 3% GST, taking no stock.
    const sold = await manager.call('POST', J('jewellery/refinery'), send({ party: 'dealer', contactId: dealer.id, lines: [{ metal: 'gold', purity: '22K', netWeight: '5.000' }],
      oldGold: [{ voucherId: kavyaGold.id, seq: 2 }] }), 201);
    assert.match((await refused('POST', J(`jewellery/refinery/${sold.id}/back`), { requestKey: key(), purity: '24K', netWeight: '1' }, manager.token)).message, /went to a bullion dealer/);
    const sale = await manager.call('POST', J(`jewellery/refinery/${sold.id}/sell`), { requestKey: key(), rate: '12500' });
    // 4.580 g fine × ₹12,500 = ₹57,250, with ₹1,717.50 GST.
    assert.deepEqual([sale.outcome, sale.sale_rate, sale.fine_weight], ['sold', '12500.00', '4.580']);
    const doc = await request('GET', J(`documents/${sale.document_id}`));
    assert.deepEqual([doc.subtotal, doc.tax, doc.total, String(doc.contact_id), Number(doc.lines[0].tax_rate)], ['57250.00', '1717.50', billTotal(5896750), String(dealer.id), 3]);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_stock_lots l JOIN catalog_skus s ON s.id=l.sku_id WHERE l.business_id=$1 AND s.code='JWL-GOLD'", [jeweller.id])).n, 0,
      'the metal is kept in the jeweller\'s own books, not as stock');
    // A voucher whose metal went on is not cancelled.
    assert.match((await refused('POST', J(`jewellery/old-gold/${kavyaGold.id}/cancel`), { reason: 'Mistake' }, manager.token)).message, /went on to a refiner, dealer or karigar/);
    // To a karigar on an issue challan, as metal.
    const karigar = await request('POST', J('jewellery/karigars'), { supplier: { name: 'Ramesh Soni' } }, 201);
    const issue = { requestKey: key(), contactId: karigar.contact_id, locationId: shop.id, lines: [{ kind: 'metal', metal: 'gold', purity: '22K', netWeight: '3.000' }],
      oldGold: [{ voucherId: k3.id, seq: 1 }] };
    assert.equal((await refused('POST', J('jewellery/karigars/issues'), { ...issue, lines: [{ kind: 'stone', description: 'Rubies' }] })).status, 400);
    const issued = await request('POST', J('jewellery/karigars/issues'), issue, 201);
    assert.deepEqual(issued.old_gold.map((x) => x.voucher_no), [k3.voucher_no]);
    const k3Now = await request('GET', J(`jewellery/old-gold/${k3.id}`));
    assert.deepEqual([k3Now.lines[0].next, k3Now.lines[0].karigar_issue_no], ['karigar', issued.issue_no]);
    // The challans, and what the database keeps.
    assert.deepEqual((await request('GET', J('jewellery/refinery?party=refiner'))).items.map((x) => x.challan_no), [challan.challan_no]);
    assert.equal((await refused('GET', J('jewellery/refinery'), undefined, karigarUser.token)).status, 403);
    await assert.rejects(pool.query('UPDATE jewellery_refinery_lines SET net_weight=1 WHERE challan_id=$1', [challan.id]), /kept as it was written/);
    await assert.rejects(pool.query('DELETE FROM jewellery_refinery_challans WHERE id=$1', [challan.id]), /never deleted/);
    await assert.rejects(pool.query('DELETE FROM jewellery_old_gold_next WHERE old_gold_id=$1', [k1.id]), /kept as it was written/);
    assert.deepEqual([await audited('jewellery_refinery.sent'), await audited('jewellery_refinery.back'), await audited('jewellery_refinery.sold')], [2, 1, 1]);
    assert.deepEqual([await evented('jewellery_refinery.sent'), await evented('jewellery_refinery.sold')], [2, 1]);
    // The fine-weight book counts what is with refiners.
    const book = await request('GET', J('jewellery/fine-weight'));
    assert.ok(JSON.stringify(book).includes('refinery'));
  });

  // --- Gold schemes ------------------------------------------------------------------------------------------
  const terms = 'Pay your instalment every month. With every instalment paid, a discount on your jewellery bill from the day the scheme matures. The money paid is used only on jewellery, never paid back in money, and the scheme is billed within 364 days of the first instalment.';
  let gold11, quick3, priya, priyaScheme, meena, meenaScheme;
  const enrol = (body, by = cashier) => by.call('POST', J('jewellery/schemes'), { requestKey: key(), locationId: shop.id, termsAccepted: true, payment: { method: 'upi' }, ...body }, 201);
  const instalment = (schemeId) => cashier.call('POST', J(`jewellery/schemes/${schemeId}/instalments`), { requestKey: key(), method: 'upi' }, 201);

  await t.test('a scheme on its day 364: billed as metal equal to its money at the day\'s rate, held in the customer\'s safekeeping, collected later', async () => {
    let plans = await manager.call('POST', J('jewellery/scheme-plans'), { requestKey: key(), name: 'Gold 11', instalments: '11', minInstalment: '1000', discountPercent: '50', terms }, 201);
    plans = await manager.call('POST', J('jewellery/scheme-plans'), { requestKey: key(), name: 'Quick 3', instalments: '3', minInstalment: '1000', discountPercent: '50', terms }, 201);
    gold11 = plans.items.find((p) => p.name === 'Gold 11');
    quick3 = plans.items.find((p) => p.name === 'Quick 3');
    priya = await customer('Priya Nair', { phone: '9845022222' });
    priyaScheme = await enrol({ planId: gold11.id, contactId: priya.id, instalment: '5000' });
    await instalment(priyaScheme.id);
    meena = await customer('Meena Iyer', { phone: '9845033333' });
    meenaScheme = await enrol({ planId: quick3.id, contactId: meena.id, instalment: '1000' });
    // Before its day 364 a scheme is redeemed on a jewellery bill, not closed.
    assert.match((await refused('POST', J(`jewellery/schemes/${meenaScheme.id}/close`), { requestKey: key(), metal: 'gold', purity: '22K' }, manager.token)).message,
      /closes on its day 364/);
    await schemeBack(priyaScheme.id, 364);
    let now = await request('GET', J(`jewellery/schemes/${priyaScheme.id}`));
    assert.deepEqual([now.close_by, now.stage, now.can_close], [today, 'closing', true]);
    // The bell asks the shop that day: nothing closes by itself.
    const bell = (await request('GET', J('notifications'))).items.find((n) => n.id.startsWith('jewellery-schemes:closing'));
    assert.deepEqual([bell.severity, bell.title], ['critical', '1 gold scheme reaches day 364 today']);
    // ₹10,000 held at ₹12,000 a gram of 22K: 0.810 g, the fewest milligrams whose bill comes to the money.
    const preview = await request('GET', J(`jewellery/schemes/${priyaScheme.id}/close?metal=gold&purity=22K`));
    assert.deepEqual([preview.held, preview.netWeight, preview.total, preview.enough], ['10000.00', '0.810', billTotal(1001160), true]);
    assert.equal(preview.due, (Number(billTotal(1001160)) - 10000).toFixed(2));
    // The shop holds no silver: it is closed in another purity, or the metal comes in first.
    assert.match((await refused('POST', J(`jewellery/schemes/${priyaScheme.id}/close`), { requestKey: key(), metal: 'silver', purity: '999' }, manager.token)).message,
      /holds 0\.000 g of Silver 999.*needs/);
    assert.equal((await refused('POST', J(`jewellery/schemes/${priyaScheme.id}/close`), { requestKey: key(), metal: 'gold', purity: '22K' }, cashier.token)).status, 403);
    const g22 = await metalOf('22K');
    const close = { requestKey: key(), metal: 'gold', purity: '22K' };
    now = await manager.call('POST', J(`jewellery/schemes/${priyaScheme.id}/close`), close, 201);
    assert.deepEqual([now.stage, now.close_weight, now.can_collect, now.status], ['safekeeping', '0.810', true, 'redeemed']);
    assert.equal((await manager.call('POST', J(`jewellery/schemes/${priyaScheme.id}/close`), close, 201)).close_id, now.close_id, 'a retry closes nothing more');
    assert.equal((await refused('POST', J(`jewellery/schemes/${priyaScheme.id}/close`), { ...close, purity: '24K' }, manager.token)).status, 409);
    assert.equal((Number(g22.net_weight) - Number((await metalOf('22K')).net_weight)).toFixed(3), '0.810', 'set aside from the shop\'s metal');
    const doc = await request('GET', J(`documents/${now.redeemed_document_id}`));
    assert.deepEqual([doc.total, String(doc.contact_id), doc.jewellery.safekeeping.tag], [billTotal(1001160), String(priya.id), now.close_tag]);
    // The metal is hers: never billed, lent or sold to anyone else.
    const piece = await request('GET', J(`jewellery/pieces/find?code=${now.close_tag}`));
    assert.equal(piece.status, 'safekeeping');
    assert.match((await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: [now.close_tag] })).problems[0], /in safekeeping for its buyer/);
    assert.equal((await refused('POST', J('jewellery/approvals'), { requestKey: key(), locationId: shop.id, customer: { name: 'Someone' }, dueOn: today, tags: [now.close_tag] }, cashier.token)).status, 409);
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET status='in_stock' WHERE id=$1", [piece.id]));
    await assert.rejects(pool.query('DELETE FROM jewellery_scheme_closes WHERE scheme_id=$1', [priyaScheme.id]), /never deleted/);
    assert.ok((await request('GET', J('notifications'))).items.some((n) => n.id === 'jewellery-schemes:safekeeping'));
    // She collects it, paying the few rupees the last milligram added.
    assert.match((await refused('POST', J(`jewellery/schemes/${priyaScheme.id}/collect`), { requestKey: key() }, manager.token)).message, /is due on bill/);
    const collect = { requestKey: key(), note: 'Collected by Priya', payment: { method: 'upi' } };
    now = await manager.call('POST', J(`jewellery/schemes/${priyaScheme.id}/collect`), collect);
    assert.deepEqual([now.stage, now.can_collect, now.collected_by_name], ['redeemed', false, 'money-manager']);
    assert.equal((await manager.call('POST', J(`jewellery/schemes/${priyaScheme.id}/collect`), collect)).stage, 'redeemed');
    assert.equal((await request('GET', J(`jewellery/pieces/find?code=${now.close_tag}`))).status, 'sold');
    const paidUp = await request('GET', J(`documents/${now.redeemed_document_id}`));
    assert.equal(paidUp.payments.reduce((s, p) => s + Number(p.amount), 0).toFixed(2), billTotal(1001160));
    assert.deepEqual([await audited('jewellery_scheme.closed'), await audited('jewellery_scheme.collected'), await evented('jewellery_scheme.closed')], [1, 1, 1]);
  });

  await t.test('a returned bill\'s scheme money goes back onto the scheme within its tenure, to be redeemed again; after it, it stays as credit', async () => {
    await instalment(meenaScheme.id);
    await instalment(meenaScheme.id);
    assert.match((await refused('POST', J(`jewellery/schemes/${meenaScheme.id}/put-back`), { requestKey: key() })).message, /was not redeemed/);
    // CH-2: 8 g at ₹12,000, ₹4,800 wastage, ₹2,000 making: ₹1,02,800, with 3% GST ₹1,05,884; the scheme's ₹3,000 pays first.
    const first = await cashier.call('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, tags: ['CH-2'], scheme: meenaScheme.id, payments: [{ method: 'upi', amount: 'full' }] }, 201);
    assert.equal(first.total, billTotal(10588400));
    assert.match((await refused('POST', J(`jewellery/schemes/${meenaScheme.id}/put-back`), { requestKey: key() })).message, /take the pieces back on the bill's credit note first/);
    const doc = await request('GET', J(`documents/${first.document_id}`));
    await request('POST', J(`documents/${first.document_id}/returns`), { requestKey: key(), reason: 'Changed her mind', lines: [{ lineId: doc.lines[0].id, quantity: '1', restock: true }] }, 201);
    let now = await request('GET', J(`jewellery/schemes/${meenaScheme.id}`));
    assert.deepEqual([now.put_back.amount, now.put_back.withinTenure, now.put_back.documentNo], ['3000.00', true, doc.document_no]);
    assert.equal((await refused('POST', J(`jewellery/schemes/${meenaScheme.id}/put-back`), { requestKey: key(), amount: '3000.01' })).status, 409);
    const back = { requestKey: key() };
    now = await request('POST', J(`jewellery/schemes/${meenaScheme.id}/put-back`), back, 201);
    assert.deepEqual([now.status, now.held, now.moves.map((m) => [m.kind, m.amount]), now.put_back], ['active', '3000.00', [['back', '3000.00']], null]);
    assert.equal((await request('POST', J(`jewellery/schemes/${meenaScheme.id}/put-back`), back, 201)).moves.length, 1, 'a retry puts nothing more back');
    // The money she paid at the counter goes back as money; the scheme's stays on the scheme.
    await request('POST', J(`documents/${first.document_id}/refunds`), { requestKey: key(), amount: (Number(billTotal(10588400)) - 3000).toFixed(2), method: 'upi', reason: 'Returned' }, 201);
    const after = await request('GET', J(`documents/${first.document_id}`));
    assert.deepEqual(after.refunds.map((r) => [r.method, r.amount]).sort(), [['credit_note', '3000.00'], ['upi', (Number(billTotal(10588400)) - 3000).toFixed(2)]].sort());
    // Redeemed again: what came back pays as the gold scheme's credit note.
    const again = await cashier.call('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, tags: ['CH-3'], scheme: meenaScheme.id, payments: [{ method: 'upi', amount: 'full' }] }, 201);
    const againDoc = await request('GET', J(`documents/${again.document_id}`));
    assert.deepEqual(againDoc.payments[0] && [againDoc.payments[0].method, againDoc.payments[0].method_name, againDoc.payments[0].reference, againDoc.payments[0].amount],
      ['credit_note', 'Gold scheme', meenaScheme.scheme_no, '3000.00']);
    now = await request('GET', J(`jewellery/schemes/${meenaScheme.id}`));
    assert.deepEqual([now.status, now.moves.map((m) => m.kind)], ['redeemed', ['back', 'used']]);
    await assert.rejects(pool.query('DELETE FROM jewellery_scheme_moves WHERE scheme_id=$1', [meenaScheme.id]), /kept as it moved/);
    // Past its day 364 the money stays on the returned bill as her credit for her next jewellery bill.
    await request('POST', J(`documents/${again.document_id}/returns`), { requestKey: key(), reason: 'Too long', lines: [{ lineId: againDoc.lines[0].id, quantity: '1', restock: true }] }, 201);
    await schemeBack(meenaScheme.id, 366);
    assert.match((await refused('POST', J(`jewellery/schemes/${meenaScheme.id}/put-back`), { requestKey: key() })).message, /ended on its day 364/);
    const credits = await cashier.call('GET', J(`jewellery/bills/credits?contact=${meena.id}`));
    assert.deepEqual(credits.items.map((x) => [x.documentNo, x.credit]), [[againDoc.document_no, billTotal(10588400)]]);
    assert.equal(await audited('jewellery_scheme.put_back'), 1);
    assert.equal(await evented('jewellery_scheme.put_back'), 1);
  });

  await t.test('a company\'s scheme money against 25% of its net worth, as the settings give it, and the bell past it', async () => {
    assert.match((await refused('PUT', J('jewellery/settings'), { companyNetWorth: '20000' })).message, /the date the net worth is as of/);
    assert.equal((await refused('PUT', J('jewellery/settings'), { companyNetWorth: '20000', netWorthOn: daysFrom(1) })).status, 400);
    const s = await request('PUT', J('jewellery/settings'), { companyNetWorth: '20000', netWorthOn: today });
    assert.deepEqual([s.companyNetWorth, s.netWorthOn], ['20000.00', today]);
    const arjun = await customer('Arjun Rao');
    await enrol({ planId: gold11.id, contactId: arjun.id, instalment: '6000' });
    const liability = await request('GET', J('jewellery/schemes/liability'));
    assert.deepEqual(liability.netWorth, { netWorth: '20000.00', on: today, sharePercent: 25, limit: '5000.00', held: '6000.00', usedPercent: '30.00', headroom: '-1000.00', over: true });
    const bell = (await request('GET', J('notifications'))).items.find((n) => n.id.startsWith('jewellery-schemes:net-worth'));
    assert.equal(bell.title, 'Gold scheme money is past 25% of the company\'s net worth');
    assert.equal((await request('PUT', J('jewellery/settings'), { companyNetWorth: '' })).companyNetWorth, null);
    assert.equal((await request('GET', J('jewellery/schemes/liability'))).netWorth, null);
    assert.ok(!(await request('GET', J('notifications'))).items.some((n) => n.id.startsWith('jewellery-schemes:net-worth')));
  });

  // --- The cash report -----------------------------------------------------------------------------------------
  let asha;
  await t.test('the cash report: customers linked by phone and family group over the rolling month, across the month\'s end, at the shop\'s alert levels and ₹10 lakh', async () => {
    assert.equal((await refused('PUT', J('jewellery/settings'), { cashAlertLevels: ['1000000'] })).status, 400);
    assert.equal((await refused('PUT', J('jewellery/settings'), { cashAlertLevels: ['1', '2', '3', '4', '5', '6'] })).status, 400);
    assert.deepEqual((await request('PUT', J('jewellery/settings'), { cashAlertLevels: ['500000', '100000'] })).cashAlertLevels, ['100000.00', '500000.00']);
    asha = await customer('Asha Rao', { phone: '9876543210' });
    const ashaToo = await customer('Asha R.', { phone: '+91 98765-43210' });
    const deepa = await customer('Deepa Rao', { phone: '9123456780' });
    // The rolling month: from the day after this date last month to today.
    const [y, m, d] = today.split('-').map(Number);
    const monthAgo = new Date(Date.UTC(y, m - 2, Math.min(d, new Date(Date.UTC(y, m - 1, 0)).getUTCDate()))).toISOString().slice(0, 10);
    const edge = addDays(monthAgo, 1);
    const sold = async (who) => {
      const g = await cashier.call('POST', J('jewellery/old-gold'), { requestKey: key(), locationId: shop.id, contactId: who.id, idKind: 'voter_id', idRef: `RV${who.id}000`,
        ownerDeclared: true, lines: [{ description: 'Old chain', metal: 'gold', purity: '22K', testMethod: 'xrf', grossWeight: '16.000' }] }, 201);
      assert.equal(g.value, '187200.00');
      await manager.call('POST', J(`jewellery/old-gold/${g.id}/payout`), { requestKey: key(), method: 'cash' }, 201);
      return g;
    };
    // Asha: one before the rolling month, one on its first day, one today. Asha R. (her phone): one on the first day, one today. Deepa: the same.
    await cashOn((await sold(asha)).id, addDays(edge, -1));
    await cashOn((await sold(asha)).id, edge);
    await sold(asha);
    await cashOn((await sold(ashaToo)).id, edge);
    await sold(ashaToo);
    await cashOn((await sold(deepa)).id, edge);
    await sold(deepa);
    let report = await request('GET', J('jewellery/cash-report'));
    assert.deepEqual([report.from, report.to, report.alertLevels], [edge, today, ['100000.00', '500000.00']]);
    const ashas = report.people.find((p) => p.contacts.some((x) => x.id === Number(asha.id)));
    // Asha's two in the month and Asha R.'s two: one person by their phone, ₹7,48,800, past the ₹5 lakh level.
    assert.deepEqual([ashas.key, ashas.contacts.length, ashas.links.map((l) => l.link), ashas.cashOut, ashas.level, ashas.alertLevel],
      [`p:${asha.id}`, 2, ['phone'], '748800.00', 'alert', '500000.00']);
    const deepas = report.people.find((p) => p.contacts.some((x) => x.id === Number(deepa.id)));
    assert.deepEqual([deepas.cashOut, deepas.level, deepas.alertLevel, deepas.links], ['374400.00', 'alert', '100000.00', []]);
    // A family group makes them one person: ₹11,23,200 in the rolling month, flagged at ₹10 lakh.
    assert.equal((await refused('POST', J('jewellery/cash-report/families'), { name: 'Rao family', contactIds: [asha.id] }, cashier.token)).status, 403);
    let families = await request('POST', J('jewellery/cash-report/families'), { name: 'Rao family', contactIds: [asha.id] }, 201);
    assert.equal((await refused('POST', J('jewellery/cash-report/families'), { name: 'rao family' })).status, 409);
    families = await request('PUT', J(`jewellery/cash-report/families/${families.items[0].id}`), { add: [deepa.id] });
    assert.deepEqual(families.items[0].members.map((m) => m.name), ['Asha Rao', 'Deepa Rao']);
    report = await request('GET', J('jewellery/cash-report'));
    const raos = report.people.find((p) => p.contacts.some((x) => x.id === Number(deepa.id)));
    assert.deepEqual([raos.key, raos.contacts.length, raos.links.map((l) => l.link).sort(), raos.families, raos.cashOut, raos.level],
      [`p:${asha.id}`, 3, ['family', 'phone'], ['Rao family'], '1123200.00', 'reporting']);
    assert.equal(report.totals.reporting, 1);
    const theirs = await request('GET', J(`jewellery/cash-report/person?key=${raos.key}`));
    assert.equal(theirs.transactions.length, 6);
    // Only the rolling month's cash counts: the payout the day before it is left out; the calendar month alone stays below the flag.
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const month = await request('GET', J(`jewellery/cash-report?from=${firstOfMonth}&to=${today}`));
    const inMonth = month.people.find((p) => p.key === raos.key);
    if (edge < firstOfMonth) assert.deepEqual([inMonth.cashOut, inMonth.level], ['561600.00', 'alert'], 'across the month\'s end');
    const items = (await request('GET', J('notifications'))).items.filter((n) => n.category === 'Cash report');
    assert.ok(items.some((n) => n.severity === 'critical' && n.title === 'Cash with 1 customer reached ₹10 lakh in a month'));
    // Taken out of the family, Deepa is on her own again.
    await request('PUT', J(`jewellery/cash-report/families/${families.items[0].id}`), { remove: [deepa.id] });
    report = await request('GET', J('jewellery/cash-report'));
    assert.equal(report.people.find((p) => p.contacts.some((x) => x.id === Number(deepa.id))).cashOut, '374400.00');
    assert.deepEqual([await audited('jewellery_cash.family_created'), await audited('jewellery_cash.family_joined'), await audited('jewellery_cash.family_left')], [1, 2, 1]);
    assert.equal((await refused('GET', J('jewellery/cash-report/families'), undefined, cashier.token)).status, 403);
  });

  // --- KYC ---------------------------------------------------------------------------------------------------
  await t.test('customers\' KYC: the shop\'s document types, numbers masked but to those who may see KYC, copies, beneficial owners, kept and set aside', async () => {
    const add = (extra, by = cashier, contact = asha) => by.call('POST', J(`jewellery/kyc/${contact.id}/documents`), { requestKey: key(), seenOn: today, ...extra }, 201);
    assert.match((await refused('POST', J(`jewellery/kyc/${asha.id}/documents`), { requestKey: key(), kind: 'Passport', number: 'N1234567', seenOn: today }, cashier.token)).message,
      /Name the KYC documents the shop accepts in Jewellery settings first/);
    assert.deepEqual((await request('PUT', J('jewellery/settings'), { kycKinds: ['Aadhaar card', 'PAN card', 'Passport', 'Voter ID'] })).kycKinds, ['Aadhaar card', 'PAN card', 'Passport', 'Voter ID']);
    const body = { requestKey: key(), kind: 'passport', number: 'n1234567', nameOnDocument: 'Asha Rao', seenOn: today };
    let kyc = await cashier.call('POST', J(`jewellery/kyc/${asha.id}/documents`), body, 201);
    // The counter sees the last four; the number in full is for those who may see KYC.
    assert.deepEqual([kyc.full, kyc.documents[0].kind, kyc.documents[0].number, kyc.documents[0].copy_id], [false, 'Passport', '••••4567', null]);
    assert.equal((await cashier.call('POST', J(`jewellery/kyc/${asha.id}/documents`), body, 201)).documents.length, 1, 'a retry adds nothing more');
    assert.equal((await refused('POST', J(`jewellery/kyc/${asha.id}/documents`), { ...body, number: 'N7654321' }, cashier.token)).status, 409);
    assert.match((await refused('POST', J(`jewellery/kyc/${asha.id}/documents`), { requestKey: key(), kind: 'Aadhaar card', number: '1234 5678 9012', seenOn: today }, cashier.token)).message,
      /last four digits/);
    assert.equal((await refused('POST', J(`jewellery/kyc/${asha.id}/documents`), { requestKey: key(), kind: 'Ration card', number: 'RC12345', seenOn: today }, cashier.token)).status, 409);
    assert.equal((await refused('POST', J(`jewellery/kyc/${asha.id}/documents`), { requestKey: key(), kind: 'Voter ID', number: 'ABC1234567', seenOn: daysFrom(1) }, cashier.token)).status, 400);
    kyc = await add({ kind: 'Aadhaar card', number: '9012' });
    assert.equal(kyc.documents.length, 2);
    let full = await manager.call('GET', J(`jewellery/kyc/${asha.id}`));
    assert.deepEqual([full.full, full.documents.map((d) => d.number).sort()], [true, ['9012', 'N1234567']]);
    assert.equal(full.lastTransaction, today);
    assert.equal(full.keepUntil, `${Number(today.slice(0, 4)) + 5}${today.slice(4)}`, 'kept five years after the last transaction');
    // The copy: a photo or PDF, opened only by those who may see KYC.
    const passport = full.documents.find((d) => d.kind === 'Passport');
    const copy = await upload(cashier.token, { kycId: passport.id }, pdf, 'application/pdf', 'passport.pdf');
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    const asCashier = await fetch(`${base}${J(`jewellery/files/${copy.body.data.id}`)}`, { headers: { Authorization: `Bearer ${cashier.token}` } });
    assert.equal(asCashier.status, 403);
    const asManager = await fetch(`${base}${J(`jewellery/files/${copy.body.data.id}`)}`, { headers: { Authorization: `Bearer ${manager.token}` } });
    assert.deepEqual([asManager.status, asManager.headers.get('content-type')], [200, 'application/pdf']);
    full = await manager.call('GET', J(`jewellery/kyc/${asha.id}`));
    assert.equal(full.documents.find((d) => d.kind === 'Passport').copy_id, copy.body.data.id);
    // A firm's beneficial owners.
    const firm = await customer('Shree Traders');
    const firmKyc = await cashier.call('POST', J(`jewellery/kyc/${firm.id}/owners`), { name: 'Ravi Shah', role: 'Partner', sharePercent: '50', pan: 'abcde1234f' }, 201);
    assert.deepEqual([firmKyc.owners[0].name, firmKyc.owners[0].share_percent, firmKyc.owners[0].pan], ['Ravi Shah', '50.00', '••••••234F']);
    assert.equal((await manager.call('GET', J(`jewellery/kyc/${firm.id}`))).owners[0].pan, 'ABCDE1234F');
    assert.equal((await refused('POST', J(`jewellery/kyc/${firm.id}/owners`), { name: 'X', role: 'Partner', sharePercent: '101' }, cashier.token)).status, 400);
    // Set aside, never deleted: by those who may see KYC, with why.
    const aadhaar = full.documents.find((d) => d.kind === 'Aadhaar card');
    assert.equal((await refused('POST', J(`jewellery/kyc/${asha.id}/documents/${aadhaar.id}/set-aside`), { reason: 'Typed by mistake' }, cashier.token)).status, 403);
    kyc = await manager.call('POST', J(`jewellery/kyc/${asha.id}/documents/${aadhaar.id}/set-aside`), { reason: 'Typed by mistake' });
    assert.deepEqual([kyc.documents.find((d) => d.id === aadhaar.id).remove_reason, kyc.documents.at(-1).id], ['Typed by mistake', aadhaar.id]);
    assert.equal((await refused('POST', J(`jewellery/kyc/${firm.id}/owners/${firmKyc.owners[0].id}/set-aside`), {}, cashier.token)).status, 403);
    kyc = await manager.call('POST', J(`jewellery/kyc/${firm.id}/owners/${firmKyc.owners[0].id}/set-aside`), {});
    assert.ok(kyc.owners[0].removed_at);
    await assert.rejects(pool.query('DELETE FROM jewellery_kyc_documents WHERE id=$1', [passport.id]), /never deleted/);
    await assert.rejects(pool.query("UPDATE jewellery_kyc_documents SET number='X12345' WHERE id=$1", [passport.id]), /kept as it was written/);
    // The cash report says who has KYC on file.
    const report = await request('GET', J('jewellery/cash-report'));
    assert.equal(report.people.find((p) => p.contacts.some((x) => x.id === Number(asha.id))).kyc, true);
    assert.deepEqual([await audited('jewellery_kyc.recorded'), await audited('jewellery_kyc.set_aside'), await audited('jewellery_kyc.copy_added')], [2, 1, 1]);
    const recorded = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='jewellery_kyc.recorded' ORDER BY id LIMIT 1", [jeweller.id]);
    assert.equal(recorded.details.number, '••••4567', 'the activity log keeps the number masked');
    assert.equal((await refused('GET', J(`jewellery/kyc/${asha.id}`), undefined, karigarUser.token)).status, 403);
  });

  // --- The suspicious transaction log ----------------------------------------------------------------------------
  await t.test('the suspicious transaction log: its own permission (the owner\'s), never the counter\'s, audited in its own history, decided once', async () => {
    const body = { requestKey: key(), contactId: asha.id, grounds: 'Cash for old gold split over days and between family members, just under the limit each time',
      transactions: 'Old gold vouchers this month' };
    for (const person of [manager, cashier, karigarUser]) {
      assert.equal((await refused('POST', J('jewellery/str'), body, person.token)).status, 403);
      assert.equal((await refused('GET', J('jewellery/str'), undefined, person.token)).status, 403);
    }
    let kase = await request('POST', J('jewellery/str'), body, 201);
    assert.deepEqual([kase.case_no, kase.status, kase.subject, kase.entries.map((e) => e.kind)], [1, 'open', 'Asha Rao', ['opened']]);
    assert.equal(kase.request_key, undefined);
    assert.equal((await request('POST', J('jewellery/str'), body, 201)).id, kase.id, 'a retry opens nothing more');
    assert.equal((await refused('POST', J('jewellery/str'), { ...body, grounds: 'Other' })).status, 409);
    assert.equal((await refused('POST', J('jewellery/str'), { requestKey: key(), grounds: 'No one' })).status, 400);
    const walkIn = await request('POST', J('jewellery/str'), { requestKey: key(), subject: 'A man who would not give his name', grounds: 'Asked to buy gold bars in cash without a bill' }, 201);
    assert.equal(walkIn.case_no, 2);
    kase = await request('GET', J(`jewellery/str/${kase.id}`));
    assert.deepEqual(kase.entries.map((e) => e.kind), ['opened', 'viewed']);
    kase = await request('POST', J(`jewellery/str/${kase.id}/notes`), { note: 'Spoke to the principal officer' }, 201);
    assert.equal((await refused('POST', J(`jewellery/str/${kase.id}/decide`), { decision: 'reported', note: 'Reported', reportedOn: daysFrom(1) })).status, 400);
    assert.equal((await refused('POST', J(`jewellery/str/${kase.id}/decide`), { decision: 'not_reported' })).status, 400);
    kase = await request('POST', J(`jewellery/str/${kase.id}/decide`), { decision: 'reported', note: 'Filed on FINnet', reportedOn: today, reportRef: 'FIU-ACK-2026-118' });
    assert.deepEqual([kase.status, kase.reported_on, kase.report_ref, kase.entries.map((e) => e.kind)], ['reported', today, 'FIU-ACK-2026-118', ['opened', 'viewed', 'note', 'decided']]);
    assert.match((await refused('POST', J(`jewellery/str/${kase.id}/decide`), { decision: 'not_reported', note: 'x' })).message, /is decided: reported/);
    assert.deepEqual((await request('GET', J('jewellery/str?status=open'))).items.map((x) => x.case_no), [2]);
    // Given to the manager by the owner, the manager keeps it too.
    const managerRole = roles.find((r) => r.template_code === 'manager');
    await pool.query("INSERT INTO business_role_permissions(business_id,role_id,permission_code) VALUES($1,$2,'jewellery.review')", [jeweller.id, managerRole.id]);
    assert.equal((await manager.call('GET', J('jewellery/str'))).items.length, 2);
    await pool.query("DELETE FROM business_role_permissions WHERE business_id=$1 AND role_id=$2 AND permission_code='jewellery.review'", [jeweller.id, managerRole.id]);
    // Never in the activity log, the events or the bell; the database keeps every case.
    assert.equal((await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND (action LIKE '%str%' OR details::text LIKE '%FIU-ACK%')", [jeweller.id])).n, 0);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_events WHERE business_id=$1 AND payload::text LIKE '%principal officer%'", [jeweller.id])).n, 0);
    assert.ok(!JSON.stringify(await request('GET', J('notifications'))).includes('suspicious'));
    await assert.rejects(pool.query('DELETE FROM jewellery_str_cases WHERE id=$1', [kase.id]), /never deleted/);
    await assert.rejects(pool.query("UPDATE jewellery_str_cases SET grounds='Changed' WHERE id=$1", [kase.id]), /keeps what was written/);
    await assert.rejects(pool.query('DELETE FROM jewellery_str_entries WHERE case_id=$1', [kase.id]), /kept as it was written/);
  });

  await t.test('personal data: the KYC is in the customer\'s export and kept by an erasure; the suspicious transaction log is in neither', async () => {
    const shopData = require('../../src/modules/personal-data/services/personalDataShop');
    const exported = await shopData.exportOf(pool, { id: jeweller.id }, asha.id);
    const tables = exported.sections.map((s) => s.table);
    assert.ok(tables.includes('jewellery_kyc_documents'));
    assert.ok(tables.includes('jewellery_cash_family_members'));
    assert.ok(!tables.includes('jewellery_str_cases'));
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const result = await shopData.erase(db, { id: jeweller.id }, { id: ownerUser.id }, asha.id);
      assert.ok(result.kept.some((line) => /^KYC documents: .*five years/.test(line)));
      assert.ok(!result.kept.some((line) => /suspicious/i.test(line)));
      const left = await db.query('SELECT number FROM jewellery_kyc_documents WHERE business_id=$1 AND contact_id=$2 ORDER BY id', [jeweller.id, asha.id]);
      assert.deepEqual(left.rows.map((r) => r.number), ['N1234567', '9012']);
      assert.equal((await db.query('SELECT subject FROM jewellery_str_cases WHERE business_id=$1 AND contact_id=$2', [jeweller.id, asha.id])).rows[0].subject, 'Asha Rao');
    } finally { await db.query('ROLLBACK'); db.release(); }
    // A scheme's metal in safekeeping waits to be collected before an erasure.
    const open = await shopData.openItems(pool, { id: jeweller.id }, priya.id);
    assert.ok(!open.some((line) => /safekeeping/.test(line)), 'Priya collected hers');
  });

  await t.test('other types and other owners never reach a jeweller\'s money', async () => {
    const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
    for (const route of ['jewellery/offers', 'jewellery/str', 'jewellery/refinery', 'jewellery/cash-report/families', `jewellery/kyc/${asha.id}`]) {
      assert.equal((await refused('GET', G(route))).status, 403, route);
    }
    assert.equal((await refused('GET', J(`jewellery/kyc/${asha.id}`), undefined, otherToken)).status, 404);
    assert.equal((await refused('GET', J('jewellery/str'), undefined, otherToken)).status, 404);
    assert.equal((await refused('GET', J(`jewellery/kyc/${kiran.id}000`))).status, 404);
    assert.equal((await refused('GET', J(`jewellery/refinery/999999`))).status, 404);
  });
});
