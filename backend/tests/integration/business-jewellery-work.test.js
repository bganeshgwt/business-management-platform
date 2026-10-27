const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A jeweller's work beyond the counter: karigars and their job work (metal and
// pieces out on issue challans, back on receipts, the wastage allowed against
// the actual, the labour invoice at its GST), custom orders (advances held for
// the order's bill, the rate fixed on an advance, delivered on the jewellery
// bill), approval challans, hallmarking consignments with the HUIDs back,
// splitting, merging and re-tagging pieces, the fine-weight book and its
// counts, and the metal account with suppliers. Fine weight is kept to the
// milligram and money to the paisa through every step; postings are
// idempotent; the database keeps the rules whatever writes the rows. Runs on
// its own throwaway database with every migration applied.
test('jewellery work: karigars, custom orders, approvals, hallmarking, tags, fine weight and metal with suppliers', { timeout: 600000 }, async (t) => {
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

  await t.test('the Down half takes the work away and puts the functions it replaced back; Up brings it again', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const left = async () => (await scratch.query(`SELECT
        (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tablename IN ('jewellery_karigars','jewellery_karigar_issues','jewellery_karigar_receipts',
          'jewellery_karigar_invoices','jewellery_orders','jewellery_approvals','jewellery_hallmark_consignments','jewellery_piece_links','jewellery_files',
          'jewellery_supplier_metal','jewellery_fine_ledger','jewellery_fine_counts')) AS tables,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='jewellery_pieces' AND column_name IN ('design_code','old_hallmark')) AS columns,
        (SELECT count(*)::int FROM pg_proc WHERE proname='jewellery_pieces_guard' AND prosrc LIKE '%jewellery_karigar_issue_lines%') AS guard,
        (SELECT count(*)::int FROM pg_proc WHERE proname='jewellery_bill_lines_check' AND prosrc LIKE '%fixed_weight%') AS bill_check`)).rows[0];
    assert.deepEqual(await left(), { tables: 12, columns: 2, guard: 1, bill_check: 1 });
    // This migration's Down half (found by its name), after those of every newer one.
    const file = fs.readdirSync(migrations).find((name) => /^\d+_jewellery-work\.sql$/.test(name));
    await migrate({ direction: 'down', count: Number(file.split('_')[0]), timestamp: true });
    assert.deepEqual(await left(), { tables: 0, columns: 0, guard: 0, bill_check: 0 });
    assert.ok((await scratch.query("SELECT 1 FROM pg_proc WHERE proname='jewellery_pieces_guard'")).rows.length, 'the earlier guard is back');
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await left(), { tables: 12, columns: 2, guard: 1, bill_check: 1 });
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
  const ownerUser = await owner('work-owner');
  await owner('work-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('work-owner@test.invalid');
  const request = as(ownerToken);
  const otherToken = await login('work-other@test.invalid');
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const today = daysFrom(0);

  const [jeweller, grocery] = await createBusinesses(request, 'OWNER', ['jewellery', 'grocery']);
  const J = (suffix) => `/businesses/${jeweller.id}/${suffix}`;
  const shop = (await request('GET', J('locations'))).items[0];
  const roles = (await request('GET', J('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', J('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const manager = await staff('work-manager@test.invalid', 'manager');
  const cashier = await staff('work-cashier@test.invalid', 'cashier');
  const goldsmith = await staff('work-goldsmith@test.invalid', 'karigar');
  const accountant = await staff('work-accountant@test.invalid', 'accountant');
  const viewer = await staff('work-viewer@test.invalid', 'viewer');
  const rounding = (await one('SELECT rounding FROM business_settings WHERE business_id=$1', [jeweller.id])).rounding;
  // A bill's total as the business rounds it (paise).
  const billTotal = (paise) => (rounding === 'nearest_rupee' ? Math.floor((paise + 50) / 100) * 100 : paise);
  const rupees = (paise) => (paise / 100).toFixed(2);
  const audited = async (action) => (await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action=$2', [jeweller.id, action])).n;
  const evented = async (kind) => (await one('SELECT count(*)::int AS n FROM business_events WHERE business_id=$1 AND kind=$2', [jeweller.id, kind])).n;

  // Today's rates (morning): 22K at ₹12,000 a gram to sell and ₹11,700 to buy.
  await manager.call('POST', J('jewellery/rates'), { requestKey: key(), session: 'morning', source: 'association', rates: [
    { metal: 'gold', purity: '24K', sellRate: '13000', buyRate: '12700' }, { metal: 'gold', purity: '22K', sellRate: '12000', buyRate: '11700' },
    { metal: 'gold', purity: '18K', sellRate: '9800', buyRate: '9500' }, { metal: 'silver', purity: '925', sellRate: '140', buyRate: '130' }] }, 201);
  await request('PUT', J('jewellery/settings'), { tagPrefix: 'sl', hallmarkCharge: '45' });
  const item = async (body) => (await request('POST', J('jewellery/items'), body, 201)).items.find((i) => i.label === body.item.name);
  const necklace = await item({ item: { name: 'Gold necklace', hsnCode: '7113' }, metal: 'gold', purity: '22K', wastagePercent: '8', makingMode: 'per_gram', makingValue: '300' });
  const chainItem = await item({ item: { name: 'Gold chain', hsnCode: '7113' }, metal: 'gold', purity: '22K', wastagePercent: '5', makingMode: 'per_gram', makingValue: '250' });
  const anklets = await item({ item: { name: 'Silver anklets', hsnCode: '7113' }, metal: 'silver', purity: '925', makingMode: 'per_gram', makingValue: '20' });
  const tag = (skuId, tagNo, extra = {}) => request('POST', J('jewellery/pieces'), { requestKey: key(), skuId, tagNo, comesIn: 'new', locationId: shop.id, reason: 'opening', ...extra }, 201);
  const piece = {};
  piece.ch1 = await tag(chainItem.sku_id, 'CH-1', { grossWeight: '5.000', hallmarked: true, huids: ['CH12AB'], cost: '55000' });
  piece.ch2 = await tag(chainItem.sku_id, 'CH-2', { grossWeight: '4.000', hallmarked: true, huids: ['CH34CD'], cost: '44000' });
  piece.old1 = await tag(necklace.sku_id, 'OLD-1', { grossWeight: '6.000', hallmarked: true, oldHallmark: true, cost: '60000' });
  piece.slv1 = await tag(anklets.sku_id, 'SLV-1', { grossWeight: '50.000', cost: '6500' });
  for (const [n, huid] of [[1, 'AP11AA'], [2, 'AP22BB'], [3, 'AP33CC']]) piece[`ap${n}`] = await tag(necklace.sku_id, `AP-${n}`, { grossWeight: '8.000', hallmarked: true, huids: [huid], cost: '80000' });
  piece.nkb = await tag(necklace.sku_id, 'NK-B1', { grossWeight: '12.000', hallmarked: true, huids: ['NB12C4'], cost: '120000' });
  piece.nkx = await tag(necklace.sku_id, 'NK-X', { grossWeight: '7.000', hallmarked: true, huids: ['NX77ZZ'], cost: '70000' });
  piece.set1 = await tag(necklace.sku_id, 'SET-1', { grossWeight: '30.000', stoneWeight: '2.000', hallmarked: true, huids: ['ST01AA', 'ST02BB'], cost: '150000',
    description: 'Bridal set', stones: [{ kind: 'ruby', pieces: '10', carat: '1.500', value: '2000' }, { kind: 'emerald', pieces: '4', carat: '0.800', value: '1000' }] });
  const bullion = await request('POST', J('contacts'), { kind: 'supplier', name: 'Mehta Bullion', gstin: '36AABCB1234F1Z9' }, 201);
  const metalOf = async (purity) => (await request('GET', J('jewellery/metal'))).find((m) => m.metal === 'gold' && m.purity === purity) || { net_weight: '0.000', fine_weight: '0.000' };
  const pieceOf = (id) => request('GET', J(`jewellery/pieces/${id}`));

  // --- Karigars -------------------------------------------------------------------------------------------
  let ramesh, mohan;
  await t.test('karigars: suppliers with the wastage allowed, registered for GST or not, and a labour rate for each item', async () => {
    ramesh = await request('POST', J('jewellery/karigars'), { supplier: { name: 'Ramesh Soni', phone: '9876501234', gstin: '27AAPFU0939F1ZV' }, wastagePercent: '2' }, 201);
    assert.deepEqual([ramesh.name, ramesh.wastage_percent, ramesh.registered, ramesh.active, ramesh.rates, ramesh.account], ['Ramesh Soni', '2.00', true, true, [], []]);
    assert.equal((await one('SELECT kind FROM business_contacts WHERE id=$1', [ramesh.contact_id])).kind, 'supplier', 'a karigar is one of the shop\'s suppliers');
    mohan = await request('POST', J('jewellery/karigars'), { supplier: { name: 'Mohan Lal' } }, 201);
    assert.deepEqual([mohan.registered, mohan.wastage_percent], [false, '0.00']);
    // Only a manager makes a karigar; a supplier is a karigar once; a customer is not one.
    assert.equal((await refused('POST', J('jewellery/karigars'), { supplier: { name: 'Raju' } }, cashier.token)).status, 403);
    assert.equal((await refused('POST', J('jewellery/karigars'), { contactId: ramesh.contact_id })).status, 409);
    const customer = await request('POST', J('contacts'), { kind: 'customer', name: 'Not A Karigar' }, 201);
    assert.equal((await refused('POST', J('jewellery/karigars'), { contactId: customer.id })).status, 404);
    assert.equal((await refused('POST', J('jewellery/karigars'), { supplier: { name: 'Raju' }, wastagePercent: '30' })).status, 400);
    // The rate card: per gram of net weight, or per piece.
    ramesh = await request('PUT', J(`jewellery/karigars/${ramesh.contact_id}/rates`), { rates: [{ skuId: necklace.sku_id, basis: 'per_gram', rate: '450' },
      { skuId: chainItem.sku_id, basis: 'per_piece', rate: '600' }] });
    assert.deepEqual(ramesh.rates.map((r) => [r.label, r.basis, r.rate]), [['Gold chain', 'per_piece', '600.00'], ['Gold necklace', 'per_gram', '450.00']]);
    assert.equal((await refused('PUT', J(`jewellery/karigars/${ramesh.contact_id}/rates`), { rates: [{ skuId: necklace.sku_id, basis: 'per_gram', rate: '1' },
      { skuId: necklace.sku_id, basis: 'per_piece', rate: '2' }] })).status, 400);
    assert.equal((await refused('PUT', J(`jewellery/karigars/${ramesh.contact_id}/rates`), { rates: [{ skuId: 999999, basis: 'per_gram', rate: '1' }] })).status, 404);
    // Who sees the labour: the goldsmith sees the karigar, not the rates or the money.
    const seen = await goldsmith.call('GET', J(`jewellery/karigars/${ramesh.contact_id}`));
    assert.deepEqual([seen.costs, seen.rates.map((r) => r.rate), seen.money], [false, [null, null], null]);
    assert.equal((await request('GET', J('jewellery/karigars'))).items.length, 2);
    assert.equal(await audited('jewellery_karigar.created'), 2);
    assert.equal(await audited('jewellery_karigar.rates_set'), 1);
  });

  // --- Metal with suppliers ---------------------------------------------------------------------------------
  await t.test('the metal account: metal received and given in fine weight by purity, and part of the balance fixed into money (bhav cut)', async () => {
    const received = { requestKey: key(), kind: 'received', contactId: bullion.id, locationId: shop.id, metal: 'gold', purity: '22K', netWeight: '100', description: 'Bars on a metal balance' };
    let account = await request('POST', J('jewellery/metal-account/entries'), received, 201);
    assert.match(account.entries[0].voucher_no, /^MV\/\d{4}\/0001$/);
    assert.deepEqual([account.balances[0].owed, account.balances[0].owed_fine, account.owedMoney], ['100.000', '91.600', '0.00']);
    // A retry gives the same account; the same key with other data is refused.
    assert.equal((await request('POST', J('jewellery/metal-account/entries'), received, 201)).entries.length, 1);
    assert.equal((await refused('POST', J('jewellery/metal-account/entries'), { ...received, netWeight: '101' })).status, 409);
    // Metal for metal: 10 g given back from the shop's own.
    account = await request('POST', J('jewellery/metal-account/entries'), { requestKey: key(), kind: 'given', contactId: bullion.id, locationId: shop.id, metal: 'gold', purity: '22K',
      netWeight: '10' }, 201);
    assert.deepEqual([account.balances[0].owed, account.balances[0].owed_fine], ['90.000', '82.440']);
    assert.deepEqual([(await metalOf('22K')).net_weight, (await metalOf('22K')).fine_weight], ['90.000', '82.440']);
    assert.equal((await refused('POST', J('jewellery/metal-account/entries'), { requestKey: key(), kind: 'given', contactId: bullion.id, locationId: shop.id, metal: 'gold',
      purity: '22K', netWeight: '500' })).status, 409, 'no more is given than the location holds');
    // Part of the balance fixed: 40 g at ₹11,500 a gram is a purchase of ₹4,60,000 plus 3% GST, booked without stock.
    const fix = { requestKey: key(), contactId: bullion.id, locationId: shop.id, metal: 'gold', purity: '22K', netWeight: '40', rate: '11500', supplierBillNo: 'MB-1101' };
    assert.equal((await refused('POST', J('jewellery/metal-account/fix'), fix, cashier.token)).status, 403);
    account = await manager.call('POST', J('jewellery/metal-account/fix'), fix, 201);
    const fixed = account.entries.find((e) => e.kind === 'fixed');
    assert.deepEqual([fixed.net_weight, fixed.rate, fixed.amount, account.balances[0].owed, account.balances[0].owed_fine, account.owedMoney],
      ['40.000', '11500.00', '460000.00', '50.000', '45.800', '473800.00']);
    const purchase = await one('SELECT kind,subtotal,tax,total,supplier_bill_no FROM business_documents WHERE id=$1', [fixed.document_id]);
    assert.deepEqual(purchase, { kind: 'purchase', subtotal: '460000.00', tax: '13800.00', total: '473800.00', supplier_bill_no: 'MB-1101' });
    assert.equal((await one(`SELECT count(*)::int AS n FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      WHERE l.business_id=$1 AND s.code='JWL-GOLD'`, [jeweller.id])).n, 0, 'the metal is kept in grams in the jeweller\'s books, not as stock');
    assert.equal((await manager.call('POST', J('jewellery/metal-account/fix'), fix, 201)).entries.length, 3, 'a retry fixes nothing more');
    assert.equal((await refused('POST', J('jewellery/metal-account/fix'), { ...fix, requestKey: key(), netWeight: '60' }, manager.token)).status, 409);
    assert.equal((await refused('POST', J('jewellery/metal-account/fix'), { ...fix, requestKey: key(), purity: '18K' }, manager.token)).status, 409);
    assert.equal(await audited('jewellery_metal.fixed'), 1);
    assert.equal(await evented('jewellery_metal.received'), 1);
    assert.equal((await request('GET', J('jewellery/metal-account'))).items[0].balances[0].owed, '50.000');
    assert.equal((await refused('GET', J('jewellery/metal-account'), undefined, goldsmith.token)).status, 403, 'the metal account is for those who see purchases');
  });

  // --- Issue challans and receipts --------------------------------------------------------------------------
  let issue1, receipt1;
  await t.test('an issue challan: metal out of the shop\'s own, a piece to repair and stones, with fine weight to the milligram', async () => {
    const body = { requestKey: key(), contactId: ramesh.contact_id, locationId: shop.id, dueOn: daysFrom(7), notes: 'Bridal set and a clasp', lines: [
      { kind: 'metal', metal: 'gold', purity: '22K', netWeight: '60', description: 'Bar' },
      { kind: 'piece', tag: 'ch-1', description: 'Solder the clasp' },
      { kind: 'stone', description: 'Rubies for the set', pieces: '12', carat: '2.150', value: '2500' }] };
    assert.equal((await refused('POST', J('jewellery/karigars/issues'), body, viewer.token)).status, 403);
    issue1 = await goldsmith.call('POST', J('jewellery/karigars/issues'), body, 201);
    assert.match(issue1.issue_no, /^KI\/\d{4}\/0001$/);
    assert.deepEqual([issue1.lines.length, issue1.pieces, issue1.pieces_out, issue1.metal_net, issue1.metal_fine, issue1.karigar_name], [3, 1, 1, '60.000', '54.960', 'Ramesh Soni']);
    assert.deepEqual(issue1.lines.map((l) => [l.kind, l.net_weight, l.fine_weight]), [['metal', '60.000', '54.960'], ['piece', '5.000', '4.580'], ['stone', null, null]]);
    // A retry gives the same challan; the same key with other data is refused.
    assert.equal((await goldsmith.call('POST', J('jewellery/karigars/issues'), body, 201)).id, issue1.id);
    assert.equal((await refused('POST', J('jewellery/karigars/issues'), { ...body, notes: 'Changed' })).status, 409);
    // The metal left the shop's own; the piece is at the karigar.
    assert.deepEqual([(await metalOf('22K')).net_weight, (await metalOf('22K')).fine_weight], ['30.000', '27.480']);
    const out = await pieceOf(piece.ch1.id);
    assert.deepEqual([out.status, out.out_kind, out.out_no, out.out_with, out.with_whom], ['at_karigar', 'karigar', issue1.issue_no, 'Ramesh Soni', `Karigar issue ${issue1.issue_no}`]);
    // A piece at the karigar is not sold, sent anywhere else, weighed again in the shop or taken out of stock.
    const preview = await request('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['CH-1'] });
    assert.match(preview.problems[0], /^Piece CH-1 is at the karigar \(KI\/\d{4}\/0001, Ramesh Soni\): only a piece in stock is billed$/);
    assert.equal((await refused('POST', J('jewellery/approvals'), { requestKey: key(), locationId: shop.id, customer: { name: 'Someone' }, dueOn: today, tags: ['CH-1'] })).status, 409);
    assert.match((await refused('PUT', J(`jewellery/pieces/${piece.ch1.id}`), { grossWeight: '5.100' })).message, /its weight and purity change when it comes back on its challan/);
    const lot = await one('SELECT id FROM business_stock_lots WHERE business_id=$1 AND lot_code=$2', [jeweller.id, 'CH-1']);
    const adjust = await refused('POST', J(`stock/${lot.id}/adjustments`), { requestKey: key(), quantity: '-1', reason: 'Not on the shelf' });
    assert.deepEqual([adjust.status, /is at the karigar and is not on the shelf/.test(adjust.message)], [409, true]);
    // No more metal goes out than the location holds; the challan is dated today or later; a karigar switched off takes nothing.
    assert.match((await refused('POST', J('jewellery/karigars/issues'), { ...body, requestKey: key(), lines: [body.lines[0]] })).message, /holds 30\.000 g of Gold 22K916 \(27\.480 g fine\): 60\.000 g cannot go out/);
    assert.equal((await refused('POST', J('jewellery/karigars/issues'), { ...body, requestKey: key(), dueOn: daysFrom(-1), lines: [body.lines[2]] })).status, 400);
    assert.equal((await refused('POST', J('jewellery/karigars/issues'), { ...body, requestKey: key(), contactId: bullion.id, lines: [body.lines[2]] })).status, 404);
    await request('PUT', J(`jewellery/karigars/${mohan.contact_id}`), { active: false });
    assert.equal((await refused('POST', J('jewellery/karigars/issues'), { ...body, requestKey: key(), contactId: mohan.contact_id, lines: [body.lines[2]] })).status, 409);
    await request('PUT', J(`jewellery/karigars/${mohan.contact_id}`), { active: true });
    // The karigar's account: 60 g of 22K (54.960 g fine) issued and held.
    const account = (await request('GET', J(`jewellery/karigars/${ramesh.contact_id}`))).account;
    assert.deepEqual([account[0].mark, account[0].held, account[0].heldFine, account[0].issuedFine], ['22K916', '60.000', '54.960', '54.960']);
    assert.equal(await audited('jewellery_karigar.issued'), 1);
    assert.equal(await evented('jewellery_karigar.issued'), 1);
  });

  await t.test('a receipt: pieces made and tagged at the labour\'s cost, a repair weighed again, scrap back, and the wastage allowed against the actual', async () => {
    const body = { requestKey: key(), contactId: ramesh.contact_id, locationId: shop.id, issueId: issue1.id, karigarRef: 'RS-118', lines: [
      { kind: 'made', skuId: necklace.sku_id, tagNo: 'km-1', grossWeight: '30.000', designCode: 'nk-2041', description: 'Bridal necklace' },
      { kind: 'made', skuId: necklace.sku_id, tagNo: 'KM-2', grossWeight: '21.500', stoneWeight: '1.500', work: 'diamond', labourBasis: 'per_piece', labourRate: '2000',
        stones: [{ kind: 'diamond', carat: '0.500', value: '30000' }] },
      { kind: 'repaired', tag: 'CH-1', grossWeight: '5.120', labourBasis: 'per_piece', labourRate: '300', description: 'Clasp soldered' },
      { kind: 'metal', metal: 'gold', purity: '22K', netWeight: '6', description: 'Filings and scrap' },
      { kind: 'stone', description: 'Rubies back', pieces: '12' }] };
    // A piece made comes into stock: the goldsmith role tags no new stock.
    assert.equal((await refused('POST', J('jewellery/karigars/receipts'), body, goldsmith.token)).status, 403);
    receipt1 = await request('POST', J('jewellery/karigars/receipts'), body, 201);
    assert.match(receipt1.receipt_no, /^KR\/\d{4}\/0001$/);
    assert.deepEqual([receipt1.made, receipt1.repaired, receipt1.labour, receipt1.unbilled, receipt1.issue_no], [2, 1, '15800.00', '15800.00', issue1.issue_no]);
    // Labour: 30 g × ₹450 (the rate card), ₹2,000 a piece (typed), ₹300 for the repair; wastage at 2% of the net and of the fine weight.
    assert.deepEqual(receipt1.lines.map((l) => [l.kind, l.tag_no, l.net_weight, l.fine_weight, l.labour, l.wastage_weight, l.wastage_fine]), [
      ['made', 'KM-1', '30.000', '27.480', '13500.00', '0.600', '0.550'],
      ['made', 'KM-2', '20.000', '18.320', '2000.00', '0.400', '0.366'],
      ['repaired', 'CH-1', '5.120', '4.690', '300.00', '0.000', '0.000'],
      ['metal', null, '6.000', '5.496', '0.00', '0.000', '0.000'],
      ['stone', null, null, null, '0.00', '0.000', '0.000']]);
    assert.equal((await request('POST', J('jewellery/karigars/receipts'), body, 201)).id, receipt1.id, 'a retry gives the same receipt');
    assert.equal((await refused('POST', J('jewellery/karigars/receipts'), { ...body, karigarRef: 'RS-119' })).status, 409);
    // The pieces made are tagged in stock at the labour's cost, with their design code; the repair is back at its new weight.
    const km1 = await request('GET', J('jewellery/pieces/find?code=KM-1'));
    assert.deepEqual([km1.status, km1.net_weight, km1.cost, km1.design_code, km1.making_value, km1.events[0].kind],
      ['in_stock', '30.000', '13500.0000', 'NK-2041', '300.00', 'tagged']);
    assert.match(km1.events[0].note, /^Made by Ramesh Soni, received on KR\/\d{4}\/0001$/);
    const ch1 = await pieceOf(piece.ch1.id);
    assert.deepEqual([ch1.status, ch1.gross_weight, ch1.net_weight], ['in_stock', '5.120', '5.120']);
    assert.deepEqual(ch1.events.map((e) => e.kind), ['tagged', 'sent', 'back']);
    assert.deepEqual([ch1.events[2].details.from.grossWeight, ch1.events[2].details.to.grossWeight], ['5.000', '5.120']);
    // The scrap is back in the shop's metal: 30 g + 6 g.
    assert.deepEqual([(await metalOf('22K')).net_weight, (await metalOf('22K')).fine_weight], ['36.000', '32.976']);
    // The karigar holds what the pieces, the scrap, the repair and the wastage allowed do not account for: 2.880 g (2.638 g fine).
    const karigar = await request('GET', J(`jewellery/karigars/${ramesh.contact_id}`));
    assert.deepEqual(karigar.account.map((a) => [a.held, a.heldFine, a.issuedFine, a.madeFine, a.returnedFine, a.repairsFine, a.allowedFine, a.writtenOffFine, a.actualWastageFine]),
      [['2.880', '2.638', '54.960', '45.800', '5.496', '0.110', '0.916', '0.000', '3.554']]);
    assert.deepEqual([karigar.money.labour, karigar.money.invoiced, karigar.money.toInvoice], ['15800.00', '0.00', '15800.00']);
    // Refused: a repair of a piece not out, a piece with a HUID not hallmarked, another karigar's challan, a tag in use.
    const again = (lines, extra = {}) => refused('POST', J('jewellery/karigars/receipts'), { requestKey: key(), contactId: ramesh.contact_id, locationId: shop.id, lines, ...extra });
    assert.equal((await again([{ kind: 'repaired', tag: 'CH-1', grossWeight: '5.120' }])).status, 409);
    assert.equal((await again([{ kind: 'made', skuId: necklace.sku_id, grossWeight: '3', huids: ['ZZ11ZZ'] }])).status, 400);
    assert.equal((await again([{ kind: 'stone', description: 'x' }], { contactId: mohan.contact_id, issueId: issue1.id })).status, 409);
    assert.equal((await again([{ kind: 'made', skuId: necklace.sku_id, tagNo: 'KM-1', grossWeight: '3' }])).status, 409);
    assert.equal(await audited('jewellery_karigar.received'), 1);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='jewellery_piece.tagged' AND entity_id=$2", [jeweller.id, km1.id]));
  });

  await t.test('what is left with the karigar after the work is written off by a manager', async () => {
    const body = { requestKey: key(), metal: 'gold', purity: '22K', reason: 'Melting loss on the bridal set' };
    assert.equal((await refused('POST', J(`jewellery/karigars/${ramesh.contact_id}/write-off`), body, cashier.token)).status, 403);
    const karigar = await manager.call('POST', J(`jewellery/karigars/${ramesh.contact_id}/write-off`), body, 201);
    assert.deepEqual(karigar.account.map((a) => [a.held, a.heldFine, a.allowedFine, a.writtenOffFine, a.actualWastageFine]), [['0.000', '0.000', '0.916', '2.638', '3.554']]);
    assert.equal((await manager.call('POST', J(`jewellery/karigars/${ramesh.contact_id}/write-off`), body, 201)).account[0].held, '0.000', 'a retry writes off nothing more');
    assert.match((await refused('POST', J(`jewellery/karigars/${ramesh.contact_id}/write-off`), { ...body, requestKey: key() }, manager.token)).message, /holds no Gold 22K916/);
    assert.equal(await audited('jewellery_karigar.written_off'), 1);
  });

  await t.test('the labour invoice: a purchase from the karigar at 5% for jewellery work and 1.5% for diamond work, none from one not registered', async () => {
    const body = { requestKey: key(), contactId: ramesh.contact_id, supplierBillNo: 'RS/45' };
    assert.equal((await refused('POST', J('jewellery/karigars/invoices'), body, goldsmith.token)).status, 403);
    const invoice = await request('POST', J('jewellery/karigars/invoices'), body, 201);
    assert.deepEqual([invoice.registered, invoice.subtotal, invoice.tax, invoice.total, invoice.supplier_bill_no], [true, '15800.00', '720.00', '16520.00', 'RS/45']);
    assert.deepEqual(invoice.lines.map((l) => [l.labour, l.tax_rate, l.tax]), [['13500.00', '5.00', '675.00'], ['2000.00', '1.50', '30.00'], ['300.00', '5.00', '15.00']]);
    assert.match(invoice.lines[0].label, /^Making: Bridal necklace · tag KM-1 · 30\.000 g \(KR\/\d{4}\/0001\)$/);
    assert.equal((await one('SELECT kind FROM business_documents WHERE id=$1', [invoice.document_id])).kind, 'purchase');
    assert.equal((await one(`SELECT count(*)::int AS n FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      WHERE l.business_id=$1 AND s.code='JWL-LABOUR'`, [jeweller.id])).n, 0, 'labour is a service bought: no stock');
    assert.equal((await request('POST', J('jewellery/karigars/invoices'), body, 201)).id, invoice.id, 'a retry gives the same invoice');
    assert.match((await refused('POST', J('jewellery/karigars/invoices'), { ...body, requestKey: key() })).message, /has no labour to bill/);
    const karigar = await request('GET', J(`jewellery/karigars/${ramesh.contact_id}`));
    assert.deepEqual([karigar.money.invoiced, karigar.money.toInvoice, karigar.money.owed], ['15800.00', '0.00', '16520.00']);
    // Mohan is not registered for GST: a repair on his challan and his labour at no GST.
    const issued = await request('POST', J('jewellery/karigars/issues'), { requestKey: key(), contactId: mohan.contact_id, locationId: shop.id, lines: [{ kind: 'piece', tag: 'CH-2' }] }, 201);
    assert.match(issued.issue_no, /^KI\/\d{4}\/0002$/);
    await goldsmith.call('POST', J('jewellery/karigars/receipts'), { requestKey: key(), contactId: mohan.contact_id, locationId: shop.id, issueId: issued.id,
      lines: [{ kind: 'repaired', tag: 'CH-2', grossWeight: '4.000' }] }, 201);
    const typed = await request('POST', J('jewellery/karigars/receipts'), { requestKey: key(), contactId: mohan.contact_id, locationId: shop.id,
      lines: [{ kind: 'stone', description: 'Polishing stones returned' }] }, 201);
    assert.equal(typed.labour, '0.00');
    assert.match((await refused('POST', J('jewellery/karigars/invoices'), { requestKey: key(), contactId: mohan.contact_id })).message, /Mohan Lal has no labour to bill/);
    const ch2 = await pieceOf(piece.ch2.id);
    assert.equal(ch2.status, 'in_stock');
    // His polish, priced by someone who sees costs, on a receipt of its own.
    await request('POST', J('jewellery/karigars/issues'), { requestKey: key(), contactId: mohan.contact_id, locationId: shop.id, lines: [{ kind: 'piece', tag: 'CH-2', description: 'Polish' }] }, 201);
    await request('POST', J('jewellery/karigars/receipts'), { requestKey: key(), contactId: mohan.contact_id, locationId: shop.id,
      lines: [{ kind: 'repaired', tag: 'CH-2', grossWeight: '4.000', labourBasis: 'per_piece', labourRate: '250' }] }, 201);
    const unregistered = await request('POST', J('jewellery/karigars/invoices'), { requestKey: key(), contactId: mohan.contact_id }, 201);
    assert.deepEqual([unregistered.registered, unregistered.tax, unregistered.total, unregistered.lines[0].tax_rate], [false, '0.00', '250.00', '0.00']);
    assert.equal(await audited('jewellery_karigar.invoiced'), 2);
    assert.equal(await evented('jewellery_karigar.invoiced'), 2);
  });

  await t.test('the ITC-04 data: goods sent to job workers and received back, with the wastage, from the challans (nothing is filed)', async () => {
    assert.equal((await refused('GET', J('jewellery/karigars/itc-04'), undefined, cashier.token)).status, 403);
    const report = await accountant.call('GET', J('jewellery/karigars/itc-04'));
    assert.match(report.note, /Nothing is filed from here/);
    assert.deepEqual(report.rows.map((r) => r.part), ['sent', 'sent', 'sent', 'sent', 'sent', 'received', 'received', 'received', 'received', 'received', 'received', 'received',
      'received', 'wastage', 'wastage']);
    const [metal] = report.rows;
    assert.deepEqual([metal.table, metal.karigar, metal.gstin, metal.uqc, metal.quantity, metal.fineWeight, metal.challanNo], ['4', 'Ramesh Soni', '27AAPFU0939F1ZV', 'GMS', '60.000',
      '54.960', issue1.issue_no]);
    const back = report.rows.find((r) => r.part === 'received');
    assert.deepEqual([back.table, back.challanNo, back.originalNo, back.goods], ['5A', 'RS-118', issue1.issue_no, 'Piece made KM-1: Gold 22K916']);
    assert.deepEqual(report.rows.filter((r) => r.part === 'wastage').map((r) => [r.quantity, r.fineWeight]), [['0.600', '0.550'], ['0.400', '0.366']]);
  });

  // --- Approval challans -------------------------------------------------------------------------------------
  let approval, lakshmi;
  await t.test('approval: pieces out on a numbered challan, never sold to anyone else, back in part, and one sold from the challan on a jewellery bill', async () => {
    const body = { requestKey: key(), locationId: shop.id, customer: { name: 'Lakshmi Iyer', phone: '9845033344' }, party: 'customer', dueOn: daysFrom(3), tags: ['AP-1', 'ap-2', 'AP-3'] };
    assert.equal((await refused('POST', J('jewellery/approvals'), { ...body, requestKey: key(), dueOn: daysFrom(-1) })).status, 400);
    approval = await cashier.call('POST', J('jewellery/approvals'), body, 201);
    lakshmi = approval.contact_id;
    assert.match(approval.approval_no, /^AP\/\d{4}\/0001$/);
    assert.deepEqual([approval.state, approval.days_out, approval.pieces, approval.pieces_out, approval.party_words, approval.due_on],
      ['out', 0, 3, 3, 'A customer', daysFrom(3)]);
    assert.match(approval.gst_note, /GST time limit for goods sent on approval was not checked/);
    assert.equal((await cashier.call('POST', J('jewellery/approvals'), body, 201)).id, approval.id, 'a retry gives the same challan');
    assert.equal((await refused('POST', J('jewellery/approvals'), { ...body, notes: 'Changed' })).status, 409);
    // Out on approval: not billed to another customer, not on another challan, not taken out of stock.
    const preview = await request('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['AP-1'] });
    assert.match(preview.problems[0], /^Piece AP-1 is on approval \(AP\/\d{4}\/0001, Lakshmi Iyer\): only a piece in stock is billed$/);
    assert.equal((await refused('POST', J('jewellery/approvals'), { ...body, requestKey: key(), tags: ['AP-1'] })).status, 409);
    const lot = await one('SELECT id FROM business_stock_lots WHERE business_id=$1 AND lot_code=$2', [jeweller.id, 'AP-3']);
    assert.match((await refused('POST', J(`stock/${lot.id}/adjustments`), { requestKey: key(), quantity: '-1', reason: 'Missing' })).message, /is on approval and is not on the shelf/);
    await assert.rejects(pool.query(`INSERT INTO business_stock_transfer_lines(business_id,transfer_id,sku_id,source_lot_id,lot_code,unit_cost,quantity)
      VALUES($1,0,$2,$3,'AP-3',80000,1)`, [jeweller.id, necklace.sku_id, lot.id]), /Piece AP-3 is on approval and is not on the shelf/, 'nor moved to another location');
    // AP-2 comes back; then it cannot come back again.
    const back = { requestKey: key(), tags: ['AP-2'], note: 'Did not like the design' };
    approval = await cashier.call('POST', J(`jewellery/approvals/${approval.id}/returns`), back, 201);
    assert.deepEqual([approval.state, approval.pieces_out], ['out', 2]);
    assert.equal((await cashier.call('POST', J(`jewellery/approvals/${approval.id}/returns`), back, 201)).pieces_out, 2, 'a retry takes nothing more back');
    assert.match((await refused('POST', J(`jewellery/approvals/${approval.id}/returns`), { ...back, requestKey: key() })).message, /AP-2 was taken back already/);
    assert.equal((await pieceOf(piece.ap2.id)).status, 'in_stock');
    // AP-1 is sold from the challan: billed to the challan's customer at today's rate.
    assert.match((await refused('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, approval: approval.id, tags: ['NK-X'],
      payments: [{ method: 'cash', amount: 'full' }] })).message, /None of the pieces on the bill is out on challan/);
    assert.match((await refused('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, approval: approval.id, tags: ['AP-2'],
      payments: [{ method: 'cash', amount: 'full' }] })).message, /Piece AP-2 of challan AP\/\d{4}\/0001 was taken back already/);
    const other = await request('POST', J('contacts'), { kind: 'customer', name: 'Ravi Kumar' }, 201);
    assert.match((await refused('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, approval: approval.id, contactId: other.id, tags: ['AP-1'],
      payments: [{ method: 'cash', amount: 'full' }] })).message, /^Approval challan AP\/\d{4}\/0001 went out to Lakshmi Iyer: its pieces are billed to them$/);
    const bill = await cashier.call('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, approval: approval.id, tags: ['AP-1'],
      payments: [{ method: 'cash', amount: 'full' }] }, 201);
    // 8 g × ₹12,000 = ₹96,000, wastage 8% ₹7,680, making ₹2,400, hallmarking ₹45; GST 3%.
    const value = 9600000 + 768000 + 240000 + 4500;
    assert.deepEqual([bill.contact_id, bill.subtotal, bill.tax, bill.total], [lakshmi, rupees(value), rupees(318375), rupees(billTotal(value + 318375))]);
    approval = await request('GET', J(`jewellery/approvals/${approval.id}`));
    assert.deepEqual(approval.lines.map((l) => [l.tag_no, l.outcome, l.document_no]), [['AP-1', 'sold', bill.document_no], ['AP-2', 'returned', null], ['AP-3', 'out', null]]);
    assert.deepEqual([approval.state, approval.pieces_out, approval.pieces_sold], ['out', 1, 1]);
    assert.equal((await pieceOf(piece.ap1.id)).status, 'sold');
    // A jeweller takes AP-2 for its counter, and brings it back the same day.
    const sona = await request('POST', J('contacts'), { kind: 'customer', name: 'Sona Jewellers', gstin: '36ABCPR1234K1ZO' }, 201);
    const trade = await request('POST', J('jewellery/approvals'), { requestKey: key(), locationId: shop.id, contactId: sona.id, party: 'jeweller', dueOn: today, tags: ['AP-2'] }, 201);
    assert.equal(trade.party_words, 'Another jeweller');
    const shopItems = require('../../src/modules/personal-data/services/personalDataShop');
    assert.ok((await shopItems.openItems(pool, { id: jeweller.id }, sona.id)).some((line) => /approval challan with pieces still out/.test(line)));
    await request('POST', J(`jewellery/approvals/${trade.id}/returns`), { requestKey: key(), tags: ['AP-2'] }, 201);
    assert.ok(!(await shopItems.openItems(pool, { id: jeweller.id }, sona.id)).some((line) => /approval challan/.test(line)));
    // The last piece back: the challan is closed.
    approval = await request('POST', J(`jewellery/approvals/${approval.id}/returns`), { requestKey: key(), tags: ['AP-3'] }, 201);
    assert.deepEqual([approval.state, approval.pieces_out], ['closed', 0]);
    assert.ok((await request('GET', J('jewellery/approvals?state=closed'))).items.some((a) => a.id === approval.id));
    assert.deepEqual([await audited('jewellery_approval.sent'), await audited('jewellery_approval.returned'), await audited('jewellery_approval.sold')], [2, 3, 1]);
  });

  // --- Hallmarking and re-hallmarking ---------------------------------------------------------------------
  await t.test('old-mark stock waits to be re-hallmarked: where a HUID is needed it is not sold', async () => {
    const old = await request('GET', J('jewellery/pieces?old_hallmark=true'));
    assert.deepEqual(old.items.map((p) => p.tag_no), ['OLD-1']);
    const preview = await request('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['OLD-1'] });
    assert.deepEqual(preview.problems, ['Piece OLD-1 (gold, 6.000 g) carries the old hallmark without a HUID: it is re-hallmarked before it is sold here (Pieces & tags › Hallmarking)']);
    const sale = await refused('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, tags: ['OLD-1'], payments: [{ method: 'cash', amount: 'full' }] });
    assert.deepEqual([sale.status, sale.message], [409, preview.problems[0]]);
    await assert.rejects(pool.query("INSERT INTO jewellery_piece_huids(business_id,huid,piece_id,created_by) VALUES($1,'OL99ZZ',$2,$3)", [jeweller.id, piece.old1.id, ownerUser.id]),
      /not one waiting to be re-hallmarked/);
  });

  // --- Custom orders ----------------------------------------------------------------------------------------
  let orderA, priya, centre, consignment;
  await t.test('a custom order booked with an advance that fixes the rate (bhav cut), through the karigar and the hallmarking centre', async () => {
    const body = { requestKey: key(), locationId: shop.id, customer: { name: 'Priya Sharma', phone: '9811122233' }, skuId: necklace.sku_id, description: 'Temple necklace, mango design',
      designRef: 'TN-77', metal: 'gold', purity: '22K', weightFrom: '18', weightTo: '20', size: '18 inch', promisedOn: daysFrom(10),
      advance: { amount: '100000', method: 'cash', fixRate: true } };
    assert.equal((await refused('POST', J('jewellery/orders'), { ...body, requestKey: key(), promisedOn: daysFrom(-1) }, cashier.token)).status, 400);
    assert.equal((await refused('POST', J('jewellery/orders'), body, viewer.token)).status, 403);
    orderA = await cashier.call('POST', J('jewellery/orders'), body, 201);
    priya = orderA.contact_id;
    // ₹1,00,000 at today's ₹12,000 a gram fixes 8.333 g (to the milligram, rounded down).
    assert.match(orderA.order_no, /^CO\/\d{4}\/0001$/);
    assert.deepEqual([orderA.status, orderA.fixed_rate, orderA.fixed_weight, orderA.advances, orderA.advance_list.length, orderA.advance_list[0].kind, orderA.advance_list[0].fixes_rate],
      ['booked', '12000.00', '8.333', '100000.00', 1, 'money', true]);
    assert.match(orderA.advance_list[0].collection_no, /^RC\//);
    const receipt = await one('SELECT amount,method,notes FROM business_collections WHERE id=$1', [orderA.advance_list[0].collection_id]);
    assert.deepEqual(receipt, { amount: '100000.00', method: 'cash', notes: `Custom order ${orderA.order_no}: advance` });
    assert.equal((await cashier.call('POST', J('jewellery/orders'), body, 201)).id, orderA.id, 'a retry gives the same order and takes no second advance');
    assert.equal((await one('SELECT count(*)::int AS n FROM business_collections WHERE business_id=$1 AND contact_id=$2', [jeweller.id, priya])).n, 1);
    assert.equal((await refused('POST', J('jewellery/orders'), { ...body, size: '17 inch' }, cashier.token)).status, 409);
    // The rate is fixed once.
    assert.match((await refused('POST', J(`jewellery/orders/${orderA.id}/advances`), { requestKey: key(), amount: '5000', method: 'upi', fixRate: true })).message, /rate is fixed already/);
    // Issued to the karigar with metal for it: the order is with the karigar.
    await request('POST', J('jewellery/karigars/issues'), { requestKey: key(), contactId: ramesh.contact_id, locationId: shop.id, orderId: orderA.id,
      lines: [{ kind: 'metal', metal: 'gold', purity: '22K', netWeight: '20' }] }, 201);
    orderA = await request('GET', J(`jewellery/orders/${orderA.id}`));
    assert.deepEqual([orderA.status, orderA.status_words, orderA.issues.length], ['issued', 'With the karigar', 1]);
    // The day's rate goes up to ₹12,500 in the evening; the order keeps its ₹12,000.
    await manager.call('POST', J('jewellery/rates'), { requestKey: key(), session: 'evening', source: 'association', rates: [{ metal: 'gold', purity: '22K', sellRate: '12500', buyRate: '12100' }] }, 201);
    // Received: the piece made for it, tagged at the karigar's rate.
    const received = await request('POST', J('jewellery/karigars/receipts'), { requestKey: key(), contactId: ramesh.contact_id, locationId: shop.id, issueId: orderA.issues[0].id,
      lines: [{ kind: 'made', skuId: necklace.sku_id, tagNo: 'CO-A1', grossWeight: '19.000' }, { kind: 'metal', metal: 'gold', purity: '22K', netWeight: '0.5' }] }, 201);
    assert.deepEqual(received.lines.map((l) => [l.order_no, l.labour, l.wastage_weight, l.wastage_fine]), [[orderA.order_no, '8550.00', '0.380', '0.348'], [null, '0.00', '0.000', '0.000']]);
    orderA = await request('GET', J(`jewellery/orders/${orderA.id}`));
    assert.deepEqual([orderA.status, orderA.made.map((p) => p.tag_no), orderA.pieces], ['received', ['CO-A1'], 1]);
    assert.deepEqual((await request('GET', J(`jewellery/karigars/${ramesh.contact_id}`))).account.map((a) => [a.held, a.heldFine]), [['0.120', '0.110']]);
    // Not billed before it is ready.
    assert.match((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, order: orderA.id })).message, /is received: it is billed once it is ready/);
    // To the hallmarking centre with the old-mark piece and a silver one: the order is at the centre.
    const send = { requestKey: key(), locationId: shop.id, centre: { name: 'Sri Sai Assaying & Hallmarking Centre', gstin: '36AAKFS5678M1ZA' }, requestRef: 'REQ-5521',
      tags: ['CO-A1', 'OLD-1', 'SLV-1'] };
    consignment = await request('POST', J('jewellery/hallmarking'), send, 201);
    centre = consignment.contact_id;
    assert.match(consignment.consignment_no, /^HM\/\d{4}\/0001$/);
    assert.deepEqual([consignment.state, consignment.pieces, consignment.form, consignment.net_weight], ['at_centre', 3, 'HM/JWLR/F 1.3', '75.000']);
    assert.equal((await request('POST', J('jewellery/hallmarking'), send, 201)).id, consignment.id, 'a retry gives the same consignment');
    assert.equal((await request('GET', J(`jewellery/orders/${orderA.id}`))).status, 'at_centre');
    assert.equal((await pieceOf(piece.old1.id)).status, 'at_centre');
    assert.equal((await refused('POST', J('jewellery/hallmarking'), { ...send, requestKey: key(), tags: ['OLD-1'] })).status, 409);
    assert.match((await refused('POST', J(`jewellery/orders/${orderA.id}/cancel`), { reason: 'Changed mind' }, manager.token)).message, /at the hallmarking centre: cancel it once it is back/);
    assert.equal((await refused('POST', J('jewellery/hallmarking'), { requestKey: key(), locationId: shop.id, contactId: priya, tags: ['AP-2'] })).status, 404, 'the centre is a supplier');
  });

  await t.test('the consignment back: each piece hallmarked with its HUIDs or rejected, and the centre\'s charges a purchase recovered on the bill', async () => {
    const lines = [{ tag: 'CO-A1', result: 'hallmarked', huids: ['ca19x7'], charge: '50' }, { tag: 'OLD-1', result: 'hallmarked', huids: ['OL06D2'] }, { tag: 'SLV-1', result: 'rejected' }];
    const route = J(`jewellery/hallmarking/${consignment.id}/return`);
    assert.match((await refused('POST', route, { requestKey: key(), lines: lines.slice(0, 2) })).message, /Say how piece SLV-1 came back/);
    assert.match((await refused('POST', route, { requestKey: key(), lines: [lines[0], { ...lines[1], huids: ['CA19X7'] }, lines[2]] })).message, /HUID CA19X7 is given twice/);
    assert.match((await refused('POST', route, { requestKey: key(), lines: [lines[0], { ...lines[1], huids: ['CH12AB'] }, lines[2]] })).message, /HUID CH12AB is on piece CH-1/);
    assert.equal((await refused('POST', route, { requestKey: key(), lines: [lines[0], lines[1], { ...lines[2], huids: ['SV11AA'] }] })).status, 400);
    const body = { requestKey: key(), centreBillNo: 'AHC-778', lines };
    consignment = await request('POST', route, body, 201);
    // ₹50 + ₹45 + ₹45 (the shop's charge where none is typed), with 18% GST.
    assert.deepEqual([consignment.state, consignment.hallmarked, consignment.rejected, consignment.charges_total, consignment.centre_bill_no], ['returned', 2, 1, '165.20', 'AHC-778']);
    assert.equal((await one('SELECT kind FROM business_documents WHERE id=$1', [consignment.document_id])).kind, 'purchase');
    assert.equal((await request('POST', route, body, 201)).id, consignment.id, 'a retry changes nothing more');
    assert.match((await refused('POST', route, { ...body, requestKey: key() })).message, /came back already/);
    const old = await pieceOf(piece.old1.id);
    assert.deepEqual([old.status, old.hallmarked, old.old_hallmark, old.huids, old.hallmark_charge], ['in_stock', true, false, 'OL06D2', '45.00']);
    assert.deepEqual((await request('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['OLD-1'] })).problems, [], 'hallmarked again with a HUID, it may be sold');
    assert.deepEqual([(await pieceOf(piece.slv1.id)).status, (await pieceOf(piece.slv1.id)).hallmarked], ['in_stock', false]);
    const orderPiece = await request('GET', J('jewellery/pieces/find?code=CA19X7'));
    assert.deepEqual([orderPiece.tag_no, orderPiece.hallmark_charge], ['CO-A1', '50.00']);
    assert.equal((await request('GET', J(`jewellery/orders/${orderA.id}`))).status, 'hallmarked');
    assert.equal(await audited('jewellery_hallmarking.returned'), 1);
    assert.equal(await evented('jewellery_hallmarking.sent'), 1);
  });

  await t.test('the order is ready and delivered on its jewellery bill: the grams fixed at the order\'s rate, the rest at the day\'s, its advance paying first', async () => {
    orderA = await request('POST', J(`jewellery/orders/${orderA.id}/ready`), {});
    assert.equal(orderA.status, 'ready');
    const preview = await cashier.call('POST', J('jewellery/bills/preview'), { locationId: shop.id, order: orderA.id });
    const [line] = preview.lines;
    // 8.333 g at ₹12,000 and 10.667 g at ₹12,500: ₹2,33,333.50; wastage 8% of it; making 19 g × ₹300; hallmarking ₹50.
    assert.deepEqual([line.tag, line.fixedWeight, line.fixedRate, line.rate, line.metalValue, line.wastage, line.making, line.hallmarkCharge, line.value],
      ['CO-A1', '8.333', '12000.00', '12500.00', '233333.50', '18666.68', '5700.00', '50.00', '257750.18']);
    const value = 25775018, tax = 773251, total = billTotal(value + tax);
    assert.deepEqual([preview.subtotal, preview.tax, preview.total, preview.orderPaid, preview.toPay, preview.order.orderNo],
      [rupees(value), rupees(tax), rupees(total), '100000.00', rupees(total - 10000000), orderA.order_no]);
    const other = await request('POST', J('contacts'), { kind: 'customer', name: 'Arjun Mehta' }, 201);
    assert.match((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, order: orderA.id, contactId: other.id })).message, /is another customer's: it is billed to the customer who ordered it/);
    const body = { requestKey: key(), locationId: shop.id, order: orderA.id, buyer: { pan: 'AFZPK7190K' }, payments: [{ method: 'upi', amount: 'full', reference: 'UPI-778899' }] };
    const bill = await cashier.call('POST', J('jewellery/bills'), body, 201);
    assert.deepEqual([bill.contact_id, bill.order.order_no, bill.total, bill.lines[0].fixed_weight, bill.lines[0].fixed_rate, bill.lines[0].rate],
      [priya, orderA.order_no, rupees(total), '8.333', '12000.00', '12500.00']);
    const paid = await rows('SELECT amount,method,collection_id FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY collection_id NULLS LAST,id',
      [jeweller.id, bill.document_id]);
    assert.deepEqual(paid.map((p) => [p.amount, p.method, p.collection_id !== null]), [['100000.00', 'cash', true], [rupees(total - 10000000), 'upi', false]]);
    assert.equal((await cashier.call('POST', J('jewellery/bills'), body, 201)).id, bill.id, 'a retry gives the same bill');
    orderA = await request('GET', J(`jewellery/orders/${orderA.id}`));
    assert.deepEqual([orderA.status, orderA.document_no], ['delivered', bill.document_no]);
    assert.match((await refused('POST', J('jewellery/bills'), { ...body, requestKey: key() })).message, /is delivered: it is billed once it is ready/);
    assert.match((await refused('POST', J(`jewellery/orders/${orderA.id}/advances`), { requestKey: key(), amount: '100', method: 'cash' })).message, /is delivered and takes no advance/);
    assert.match((await refused('POST', J(`jewellery/orders/${orderA.id}/cancel`), { reason: 'Late' }, manager.token)).message, /was delivered: it is not cancelled/);
    // The database checks the line's grams at the order's rate.
    await assert.rejects(pool.query('UPDATE jewellery_orders SET notes=$2 WHERE id=$1', [orderA.id, 'x']), /keeps what it was/);
    assert.deepEqual([await audited('jewellery_order.booked'), await audited('jewellery_order.advance'), await audited('jewellery_order.delivered')], [1, 1, 1]);
  });

  let orderB, orderD, voucher;
  await t.test('an order billed at the day\'s rate, paid first by its money advance and the customer\'s old gold held for it', async () => {
    orderB = await request('POST', J('jewellery/orders'), { requestKey: key(), locationId: shop.id, contactId: priya, description: 'Plain necklace', metal: 'gold', purity: '22K',
      advance: { amount: '20000', method: 'cash' } }, 201);
    assert.deepEqual([orderB.order_no.endsWith('/0002'), orderB.fixed_rate, orderB.advances], [true, null, '20000.00']);
    voucher = await cashier.call('POST', J('jewellery/old-gold'), { requestKey: key(), locationId: shop.id, contactId: priya, idKind: 'aadhaar', idRef: '4321', ownerDeclared: true,
      lines: [{ description: 'Old ring', metal: 'gold', purity: '22K', testMethod: 'touchstone', grossWeight: '2.000' }] }, 201);
    const advance = { requestKey: key(), oldGoldId: voucher.id };
    orderB = await cashier.call('POST', J(`jewellery/orders/${orderB.id}/advances`), advance, 201);
    assert.deepEqual([orderB.advance_list.map((a) => a.kind), orderB.advances], [['money', 'old_gold'], rupees(2000000 + Math.round(Number(voucher.value) * 100))]);
    assert.equal((await cashier.call('POST', J(`jewellery/orders/${orderB.id}/advances`), advance, 201)).advance_list.length, 2, 'a retry holds it once');
    // Held for the order: not paid out, and not used on another bill.
    assert.match((await refused('POST', J(`jewellery/old-gold/${voucher.id}/payout`), { requestKey: key(), amount: '100', method: 'cash' }, manager.token)).message,
      /is held for custom order/);
    assert.match((await refused('POST', J('jewellery/bills/preview'), { locationId: shop.id, tags: ['AP-2'], oldGold: [voucher.id] })).message, /is held for custom order/);
    // A piece in stock made the order's own, of its purity only.
    assert.match((await refused('POST', J(`jewellery/orders/${orderB.id}/pieces`), { tag: 'SLV-1' })).message, /is for Gold 22K916/);
    orderB = await request('POST', J(`jewellery/orders/${orderB.id}/pieces`), { tag: 'NK-B1' }, 201);
    assert.equal(orderB.status, 'received');
    orderB = await request('POST', J(`jewellery/orders/${orderB.id}/ready`), {});
    const bill = await cashier.call('POST', J('jewellery/bills'), { requestKey: key(), locationId: shop.id, order: orderB.id, payments: [{ method: 'upi', amount: 'full' }] }, 201);
    // 12 g at the day's ₹12,500: ₹1,50,000; wastage ₹12,000; making ₹3,600; hallmarking ₹45; 3% GST.
    const value = 15000000 + 1200000 + 360000 + 4500, total = billTotal(value + 496935);
    assert.deepEqual([bill.lines[0].fixed_weight, bill.lines[0].fixed_rate, bill.lines[0].rate, bill.subtotal, bill.total], ['0.000', null, '12500.00', rupees(value), rupees(total)]);
    const gold = Math.round(Number(voucher.value) * 100);
    const paid = await rows('SELECT amount,method,collection_id FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [jeweller.id, bill.document_id]);
    assert.deepEqual(paid.filter((p) => p.collection_id !== null).map((p) => [p.amount, p.method]), [['20000.00', 'cash']], 'the order\'s receipt pays first');
    assert.deepEqual(paid.filter((p) => p.method === 'upi').map((p) => p.amount), [rupees(total - 2000000 - gold)]);
    assert.equal(paid.reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0), total);
    assert.equal((await one('SELECT sum(amount) AS amount FROM jewellery_old_gold_uses WHERE business_id=$1 AND old_gold_id=$2', [jeweller.id, voucher.id])).amount, rupees(gold));
    assert.equal((await request('GET', J(`jewellery/old-gold/${voucher.id}`))).balance, '0.00');
    assert.equal((await request('GET', J(`jewellery/orders/${orderB.id}`))).status, 'delivered');
  });

  await t.test('an order cancelled: its advance is the customer\'s again; an open order\'s advance pays only its own bill', async () => {
    const orderC = await cashier.call('POST', J('jewellery/orders'), { requestKey: key(), locationId: shop.id, customer: { name: 'Anil Kumar', phone: '9822233344' },
      description: 'Bangles, a pair', metal: 'gold', purity: '22K', advance: { amount: '5000', method: 'upi' } }, 201);
    const anil = orderC.contact_id;
    assert.equal((await refused('POST', J(`jewellery/orders/${orderC.id}/cancel`), { reason: 'Changed mind' }, cashier.token)).status, 403);
    const cancelled = await manager.call('POST', J(`jewellery/orders/${orderC.id}/cancel`), { reason: 'Customer changed mind' });
    assert.deepEqual([cancelled.status, cancelled.cancel_reason, cancelled.advances], ['cancelled', 'Customer changed mind', '5000.00']);
    assert.equal((await manager.call('POST', J(`jewellery/orders/${orderC.id}/cancel`), { reason: 'Again' })).cancel_reason, 'Customer changed mind', 'cancelled once');
    orderD = await cashier.call('POST', J('jewellery/orders'), { requestKey: key(), locationId: shop.id, contactId: anil, description: 'Ring for a child', metal: 'gold', purity: '22K',
      advance: { amount: '3000', method: 'cash' } }, 201);
    const orders = require('../../src/modules/business/jewellery/services/jewelleryOrders.service');
    const held = await orders.heldReceipts(pool, { id: jeweller.id }, anil);
    assert.deepEqual([...held], [Number(orderD.advance_list[0].collection_id)], 'the open order\'s receipt is held; the cancelled one\'s is free');
    const other = await one('SELECT document_id FROM jewellery_bills WHERE business_id=$1 ORDER BY id LIMIT 1', [jeweller.id]);
    await assert.rejects(pool.query(`INSERT INTO business_payments(business_id,document_id,amount,method,request_key,created_by,collection_id) VALUES($1,$2,100,'cash',$3,$4,$5)`,
      [jeweller.id, other.document_id, key(), ownerUser.id, orderD.advance_list[0].collection_id]), /is an advance for custom order .*: it pays only the order's own bill/);
    const shopItems = require('../../src/modules/personal-data/services/personalDataShop');
    assert.ok((await shopItems.openItems(pool, { id: jeweller.id }, anil)).some((line) => /custom order not delivered/.test(line)));
    assert.equal(await audited('jewellery_order.cancelled'), 1);
    // The day promised and the notes change while the order is open (never to a past day); a cancelled order keeps what it was.
    assert.match((await refused('PUT', J(`jewellery/orders/${orderD.id}`), { promisedOn: daysFrom(-1) })).message, /The day promised is today or later/);
    const changed = await cashier.call('PUT', J(`jewellery/orders/${orderD.id}`), { promisedOn: daysFrom(10), notes: 'Size 12' });
    assert.deepEqual([changed.promised_on, changed.notes], [daysFrom(10), 'Size 12']);
    assert.equal((await refused('PUT', J(`jewellery/orders/${orderC.id}`), { notes: 'Again' })).status, 409);
    assert.equal(await audited('jewellery_order.updated'), 1);
    // An open order past the day promised is listed, and in the bell.
    await pool.query('UPDATE jewellery_orders SET promised_on=$2 WHERE id=$1', [orderD.id, daysFrom(-2)]);
    assert.deepEqual((await request('GET', J('jewellery/orders?late=true'))).items.map((o) => o.id), [orderD.id]);
    // Its notes change while its day promised, now past, stays as it is.
    assert.equal((await cashier.call('PUT', J(`jewellery/orders/${orderD.id}`), { promisedOn: daysFrom(-2), notes: 'Size 12, call first' })).notes, 'Size 12, call first');
    const bell = (await request('GET', J('notifications'))).items.find((n) => n.category === 'Custom orders');
    assert.ok(bell && /^1 custom order past the day promised$/.test(bell.title) && bell.link.endsWith('/custom-orders'), JSON.stringify(bell));
    assert.ok(!(await goldsmith.call('GET', J('notifications'))).items.some((n) => n.category === 'Custom orders'), 'the goldsmith sees no orders\' money');
  });

  // --- Tags: split, merge, new tag, photo ---------------------------------------------------------------------
  let set2, set3;
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2A0D5D10000000049454E44AE426082', 'hex');
  const upload = async (fields, bytes, name = 'photo.png', token = ownerToken) => {
    const form = new FormData();
    for (const [field, value] of Object.entries(fields)) form.append(field, String(value));
    form.append('file', new Blob([bytes], { type: 'image/png' }), name);
    const response = await fetch(`${base}${J('jewellery/files')}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  await t.test('a set split into its articles and merged back: weight, fine weight and cost kept, each HUID and stone with its article', async () => {
    const parts = [{ tagNo: 'SET-1A', grossWeight: '18.000', stoneWeight: '1.200', huids: ['ST01AA'], stones: [1], description: 'Bridal necklace' },
      { tagNo: 'SET-1B', grossWeight: '12.000', stoneWeight: '0.800', huids: ['ST02BB'], stones: [2], description: 'Bridal earrings' }];
    const route = J(`jewellery/pieces/${piece.set1.id}/split`);
    assert.match((await refused('POST', route, { requestKey: key(), parts: [parts[0], { ...parts[1], grossWeight: '11.000' }] })).message, /come to 29\.000 g, not piece SET-1's 30\.000 g gross/);
    assert.match((await refused('POST', route, { requestKey: key(), parts: [parts[0], { ...parts[1], huids: [] }] })).message, /HUIDs \(ST01AA, ST02BB\) goes with one of the pieces/);
    assert.match((await refused('POST', route, { requestKey: key(), parts: [parts[0], { ...parts[1], stones: [] }] })).message, /2 stone lines goes with one of the pieces/);
    assert.equal((await refused('POST', route, { requestKey: key(), parts }, viewer.token)).status, 403);
    const body = { requestKey: key(), parts };
    const split = await request('POST', route, body, 201);
    // The cost is shared by net weight: 16.800 g and 11.200 g of ₹1,50,000.
    assert.deepEqual(split.pieces.map((p) => [p.tag_no, p.gross_weight, p.stone_weight, p.net_weight, p.huids, p.stone_lines, p.cost, p.status]), [
      ['SET-1A', '18.000', '1.200', '16.800', 'ST01AA', 1, '90000.0000', 'in_stock'], ['SET-1B', '12.000', '0.800', '11.200', 'ST02BB', 1, '60000.0000', 'in_stock']]);
    assert.deepEqual((await request('POST', route, body, 201)).pieces.map((p) => p.tag_no), ['SET-1A', 'SET-1B'], 'a retry splits nothing more');
    assert.equal((await refused('POST', route, { ...body, parts: [parts[1], parts[0]] })).status, 409);
    const was = await pieceOf(piece.set1.id);
    assert.deepEqual([was.status, was.in_books, was.made_into.map((m) => [m.kind, m.tag])], ['split', false, [['split', 'SET-1A'], ['split', 'SET-1B']]]);
    assert.equal((await refused('POST', route, { requestKey: key(), parts })).status, 409, 'a piece split is not split again');
    // Merged back into one: the weights, the HUIDs, the stones and the cost added up.
    const merge = { requestKey: key(), tags: ['SET-1A', 'SET-1B'], tagNo: 'SET-2', description: 'Bridal set' };
    assert.match((await refused('POST', J('jewellery/pieces/merge'), { ...merge, requestKey: key(), tags: ['SET-1A', 'SLV-1'] })).message, /one metal and purity/);
    set2 = await request('POST', J('jewellery/pieces/merge'), merge, 201);
    assert.deepEqual([set2.tag_no, set2.gross_weight, set2.stone_weight, set2.net_weight, set2.huids, set2.stone_lines, set2.cost, set2.stone_value],
      ['SET-2', '30.000', '2.000', '28.000', 'ST01AA ST02BB', 2, '150000.0000', '3000.00']);
    assert.equal((await request('POST', J('jewellery/pieces/merge'), merge, 201)).id, set2.id, 'a retry merges nothing more');
    assert.deepEqual(set2.made_from.map((m) => [m.kind, m.tag]), [['merge', 'SET-1A'], ['merge', 'SET-1B']]);
    // Through the core's stock: each unit taken out with its reason, and the new one in at the cost.
    const lots = await rows("SELECT lot_code,quantity,unit_cost FROM business_stock_lots WHERE business_id=$1 AND lot_code LIKE 'SET-%' ORDER BY lot_code", [jeweller.id]);
    assert.deepEqual(lots.map((l) => [l.lot_code, l.quantity]), [['SET-1', '0.000'], ['SET-1A', '0.000'], ['SET-1B', '0.000'], ['SET-2', '1.000']]);
    assert.equal(lots[3].unit_cost, '150000.0000');
    assert.ok(await one("SELECT 1 FROM business_stock_adjustments WHERE business_id=$1 AND reason LIKE 'Split into SET-1A, SET-1B: piece SET-1%'", [jeweller.id]));
    assert.deepEqual([await audited('jewellery_piece.split'), await audited('jewellery_piece.merged')], [1, 1]);
    // The database keeps a link's metal: a piece is never "split" into one of another weight.
    await assert.rejects(pool.query("INSERT INTO jewellery_piece_links(business_id,kind,from_piece_id,to_piece_id,request_key,created_by) VALUES($1,'retag',$2,$3,$4,$5)",
      [jeweller.id, piece.nkx.id, piece.ap2.id, key(), ownerUser.id]), { code: '23514' });
  });

  await t.test('a photo for a piece, and a new tag after a repair that keeps the piece, its HUIDs, its photo and its order', async () => {
    assert.equal((await upload({ pieceId: set2.id }, Buffer.from('not an image at all, just words'))).status, 400);
    assert.equal((await upload({ pieceId: set2.id }, png, 'photo.png', viewer.token)).status, 403);
    const photo = await upload({ pieceId: set2.id }, png);
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    assert.deepEqual([photo.body.data.kind, photo.body.data.piece_id], ['photo', set2.id]);
    const opened = await fetch(`${base}${J(`jewellery/files/${photo.body.data.id}`)}`, { headers: { Authorization: `Bearer ${viewer.token}` } });
    assert.deepEqual([opened.status, opened.headers.get('content-type')], [200, 'image/png']);
    assert.equal((await pieceOf(set2.id)).photo_id, photo.body.data.id);
    const design = await upload({ orderId: orderD.id }, png, 'design.png');
    assert.deepEqual([design.status, design.body.data.kind], [201, 'design']);
    assert.equal((await request('GET', J(`jewellery/orders/${orderD.id}`))).design_photo_id, design.body.data.id);
    // SET-2 made order D's own, then given a new tag: the new tag carries all of it.
    await request('POST', J(`jewellery/orders/${orderD.id}/pieces`), { tag: 'SET-2' }, 201);
    const body = { requestKey: key(), tagNo: 'SET-3' };
    set3 = await request('POST', J(`jewellery/pieces/${set2.id}/retag`), body, 201);
    assert.deepEqual([set3.tag_no, set3.gross_weight, set3.net_weight, set3.huids, set3.cost, set3.order_no, set3.photo_id !== null], ['SET-3', '30.000', '28.000', 'ST01AA ST02BB',
      '150000.0000', orderD.order_no, true]);
    assert.equal((await request('POST', J(`jewellery/pieces/${set2.id}/retag`), body, 201)).id, set3.id, 'a retry gives the same new tag');
    assert.equal((await pieceOf(set2.id)).status, 'retagged');
    assert.equal((await request('GET', J('jewellery/pieces/find?code=ST01AA'))).tag_no, 'SET-3');
    assert.match((await refused('POST', J(`jewellery/pieces/${piece.ch1.id}/retag`), { requestKey: key(), tagNo: 'SET-3' })).message, /Tag SET-3 is on another piece/);
    // Made for open order D, it is billed only on the order's own bill: the bill screen says so, and the database refuses it whatever writes the bill.
    const plain = { locationId: shop.id, tags: ['SET-3'], contactId: orderD.contact_id, buyer: { pan: 'AFZPK7190K' } };
    const words = `Piece SET-3 was made for custom order ${orderD.order_no}: it is billed on the order's own bill`;
    assert.deepEqual((await request('POST', J('jewellery/bills/preview'), plain)).problems, [`${words} (Sales history › Custom orders)`]);
    assert.equal((await refused('POST', J('jewellery/bills'), { ...plain, requestKey: key() })).message, `${words} (Sales history › Custom orders)`);
    const pieceService = require('../../src/modules/business/jewellery/services/jewelleryPieces.service');
    const pieceRow = pieceService.pieceRow;
    pieceService.pieceRow = async (...args) => ({ ...(await pieceRow(...args)), order_status: 'delivered' });
    try {
      const written = await refused('POST', J('jewellery/bills'), { ...plain, requestKey: key() });
      assert.deepEqual([written.status, written.message], [409, words], 'the database refuses the line');
    } finally { pieceService.pieceRow = pieceRow; }
    assert.equal((await pieceOf(set3.id)).status, 'in_stock');
    // The photo taken off is kept.
    await request('DELETE', J(`jewellery/files/${photo.body.data.id}`));
    assert.equal((await pieceOf(set2.id)).photo_id, null);
    assert.equal(await audited('jewellery_piece.photo_added'), 1);
    assert.equal(await audited('jewellery_piece.retagged'), 1);
  });

  // --- The fine-weight book and a count ---------------------------------------------------------------------
  await t.test('the fine-weight book: each purity\'s metal wherever it is, every movement that changes it, and what holds it', async () => {
    const book = await request('GET', J('jewellery/fine-weight'));
    const g22 = book.purities.find((p) => p.mark === '22K916');
    const of = (kind) => g22.movements.find((m) => m.kind === kind) || { net: '0.000', fine: '0.000' };
    const mg = (text) => Math.round(Number(text) * 1000);
    const sumOf = (list, field) => list.reduce((s, m) => s + mg(m[field]), 0);
    // What changed the total: tagged in, metal with the supplier, the karigars' wastage, old gold, the sales.
    assert.deepEqual([of('tagged').net, of('tagged').fine], ['86.000', '78.776']);
    assert.deepEqual([of('supplier_in').net, of('supplier_in').fine, of('supplier_out').net, of('supplier_out').fine], ['100.000', '91.600', '-10.000', '-9.160']);
    assert.deepEqual([of('wastage_allowed').net, of('wastage_allowed').fine, of('wastage_written_off').net, of('wastage_written_off').fine], ['-1.380', '-1.264', '-2.880', '-2.638']);
    assert.deepEqual([of('old_gold').net, of('old_gold').fine, of('sold').net, of('sold').fine], ['2.000', '1.832', '-39.000', '-35.724']);
    // Moves inside the shop take from one holder what they give another: the total is as it was.
    assert.deepEqual(g22.within.map((m) => m.kind), ['karigar_made', 'karigar_issue', 'karigar_return', 'karigar_repair', 'moved', 'split', 'merged', 'retagged']);
    for (const move of g22.within) {
      assert.deepEqual([move.net, move.fine], ['0.000', '0.000'], `${move.kind} keeps the total`);
      assert.equal(sumOf(move.moves, 'net'), 0);
    }
    const issued = g22.within.find((m) => m.kind === 'karigar_issue').moves;
    assert.deepEqual(issued.map((m) => [m.holder, m.net, m.fine]), [['metal', '-80.000', '-73.280'], ['karigar_metal', '80.000', '73.280']]);
    const made = g22.within.find((m) => m.kind === 'karigar_made');
    assert.deepEqual(made.moves.map((m) => [m.holder, m.net, m.fine]), [['stock', '69.000', '63.204'], ['karigar_metal', '-69.000', '-63.204']]);
    assert.deepEqual([made.moved.net, made.moved.fine], ['69.000', '63.204']);
    // A split, a merge and a new tag stay in stock: 28 g of pieces each time, made into others.
    for (const kind of ['split', 'merged', 'retagged']) {
      const move = g22.within.find((m) => m.kind === kind);
      assert.deepEqual([move.moved.net, move.moved.fine, move.moves], ['28.000', '25.648', []], kind);
    }
    // The closing is the opening and the movements; the holders add up to it.
    assert.equal(mg(g22.closing.net), mg(g22.opening.net) + sumOf(g22.movements, 'net'));
    assert.equal(mg(g22.closing.fine), mg(g22.opening.fine) + sumOf(g22.movements, 'fine'));
    assert.equal(sumOf(g22.holders, 'net'), mg(g22.closing.net));
    assert.equal(sumOf(g22.holders, 'fine'), mg(g22.closing.fine));
    const holder = (name) => g22.holders.find((h) => h.holder === name);
    assert.deepEqual([g22.closing.net, holder('stock').net, holder('metal').net, holder('karigar_metal').net, holder('approval').net, holder('centre').net],
      ['134.740', '116.120', '18.500', '0.120', '0.000', '0.000']);
    assert.deepEqual([holder('metal').fine, (await metalOf('22K')).fine_weight], ['16.946', '16.946']);
    const inStock = await one(`SELECT sum(jewellery_fine_of(net_weight,metal,purity)) AS fine FROM jewellery_pieces WHERE business_id=$1 AND status='in_stock' AND purity='22K'`, [jeweller.id]);
    assert.equal(holder('stock').fine, Number(inStock.fine).toFixed(3));
  });

  await t.test('a count held against the book: the tags not found, those found that the book has elsewhere, and the metal weighed', async () => {
    const tags = (await rows("SELECT tag_no FROM jewellery_pieces WHERE business_id=$1 AND status='in_stock' AND purity='22K' AND tag_no<>'NK-X' ORDER BY tag_no", [jeweller.id]))
      .map((r) => r.tag_no);
    const body = { requestKey: key(), locationId: shop.id, notes: 'Month-end count', purities: [{ metal: 'gold', purity: '22K', tags: [...tags, 'AP-1'], metalWeight: '18' }] };
    assert.equal((await refused('POST', J('jewellery/fine-weight/counts'), body, viewer.token)).status, 403);
    const count = await goldsmith.call('POST', J('jewellery/fine-weight/counts'), body, 201);
    const [line] = count.lines;
    assert.deepEqual([line.book_pieces, line.counted_pieces, line.missing_tags, line.extra_tags], [9, 9, ['NK-X'], ['AP-1']]);
    assert.deepEqual([line.book_metal_net, line.book_metal_fine, line.counted_metal_net, line.counted_metal_fine, line.metal_difference], ['18.500', '16.946', '18.000', '16.488', '-0.458']);
    // AP-1 (7.328 g fine) was found and NK-X (6.412 g fine) was not.
    assert.equal(line.pieces_difference, '0.916');
    assert.equal((await goldsmith.call('POST', J('jewellery/fine-weight/counts'), body, 201)).id, count.id, 'a retry gives the same count');
    assert.equal((await refused('POST', J('jewellery/fine-weight/counts'), { ...body, notes: 'Changed' })).status, 409);
    assert.equal((await request('GET', J('jewellery/fine-weight'))).counts[0].id, count.id);
    assert.equal(await audited('jewellery_fine.counted'), 1);
  });

  await t.test('the rest of the metal balance fixed at the day\'s rate, and the HUID list for Manak Online', async () => {
    const account = await manager.call('POST', J('jewellery/metal-account/fix'), { requestKey: key(), contactId: bullion.id, locationId: shop.id, metal: 'gold', purity: '22K' }, 201);
    // 50 g at the day's ₹12,500: ₹6,25,000 plus 3%.
    assert.deepEqual([account.balances[0].owed, account.balances[0].fixed, account.owedMoney], ['0.000', '90.000', rupees(47380000 + 64375000)]);
    assert.match((await refused('POST', J('jewellery/metal-account/fix'), { requestKey: key(), contactId: bullion.id, locationId: shop.id, metal: 'gold', purity: '22K' }, manager.token))
      .message, /owes Mehta Bullion no Gold 22K916/);
    assert.equal((await refused('GET', J('jewellery/hallmarking/huids'), undefined, cashier.token)).status, 403);
    const list = await accountant.call('GET', J('jewellery/hallmarking/huids'));
    assert.match(list.note, /format of its file was not checked/);
    const status = (huid) => list.items.find((i) => i.huid === huid)?.status;
    assert.deepEqual([status('CA19X7'), status('OL06D2'), status('AP11AA'), status('ST01AA'), status('NX77ZZ')], ['sold_consumer', 'in_stock', 'sold_consumer', 'in_stock', 'in_stock']);
    assert.equal(list.items.find((i) => i.huid === 'ST01AA').tag, 'SET-3');
    const unsold = await accountant.call('GET', J('jewellery/hallmarking/huids?status=in_stock'));
    assert.ok(unsold.items.every((i) => i.status === 'in_stock') && unsold.items.some((i) => i.huid === 'OL06D2'));
  });

  await t.test('the database keeps the challans, the book and the pieces\' moves', async () => {
    await assert.rejects(pool.query('DELETE FROM jewellery_karigar_issues WHERE id=$1', [issue1.id]), /issue challan is kept as it was written/);
    await assert.rejects(pool.query('UPDATE jewellery_karigar_receipt_lines SET labour=1 WHERE receipt_id=$1', [receipt1.id]), /receipt is kept as it was written/);
    await assert.rejects(pool.query('UPDATE jewellery_fine_ledger SET net_weight=0 WHERE business_id=$1', [jeweller.id]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET status='at_karigar' WHERE id=$1", [piece.nkx.id]), /goes to a karigar on an issue challan/);
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET status='on_approval' WHERE id=$1", [piece.nkx.id]), /goes on approval on an approval challan/);
    await assert.rejects(pool.query("UPDATE jewellery_pieces SET status='at_centre' WHERE id=$1", [piece.nkx.id]), /goes to the hallmarking centre on a consignment/);
    await assert.rejects(pool.query("UPDATE jewellery_orders SET status='hallmarked' WHERE id=$1", [orderD.id]), /cannot go from received to hallmarked/);
    await assert.rejects(pool.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,created_by)
      VALUES($1,$2,'gold','22K',-500,-458,'karigar_issue',$3)`, [jeweller.id, shop.id, ownerUser.id]), { code: '23514' });
  });

  await t.test('an order cancelled while the karigar makes it: what comes back on its challan is the shop\'s own', async () => {
    const orderE = await request('POST', J('jewellery/orders'), { requestKey: key(), locationId: shop.id, contactId: orderD.contact_id, description: 'Plain studs', metal: 'gold',
      purity: '22K' }, 201);
    const issue = await request('POST', J('jewellery/karigars/issues'), { requestKey: key(), contactId: mohan.contact_id, locationId: shop.id, orderId: orderE.id,
      lines: [{ kind: 'metal', metal: 'gold', purity: '22K', netWeight: '1' }] }, 201);
    assert.equal((await request('GET', J(`jewellery/orders/${orderE.id}`))).status, 'issued');
    assert.equal((await manager.call('POST', J(`jewellery/orders/${orderE.id}/cancel`), { reason: 'Customer moved away' })).status, 'cancelled');
    const made = { kind: 'made', skuId: chainItem.sku_id, tagNo: 'KE-1', grossWeight: '0.950' };
    const body = { requestKey: key(), contactId: mohan.contact_id, locationId: shop.id, issueId: issue.id, lines: [made] };
    assert.match((await refused('POST', J('jewellery/karigars/receipts'), { ...body, lines: [{ ...made, orderId: orderE.id }] })).message, /order .* is cancelled/);
    const receipt = await request('POST', J('jewellery/karigars/receipts'), body, 201);
    assert.deepEqual([receipt.lines[0].tag_no, receipt.lines[0].order_no], ['KE-1', null]);
    const studs = await request('GET', J('jewellery/pieces/find?code=KE-1'));
    assert.deepEqual([studs.status, studs.order_id], ['in_stock', null]);
    assert.equal((await request('GET', J(`jewellery/orders/${orderE.id}`))).pieces, 0);
  });

  await t.test('other types never have the work, and another owner\'s is not theirs to read', async () => {
    assert.equal((await refused('GET', `/businesses/${grocery.id}/jewellery/karigars`)).status, 403);
    assert.equal((await refused('GET', J(`jewellery/orders/${orderD.id}`), undefined, otherToken)).status, 404);
    assert.equal((await refused('GET', J(`jewellery/approvals/${approval.id}`), undefined, otherToken)).status, 404);
    assert.equal((await refused('GET', J('jewellery/fine-weight'), undefined, otherToken)).status, 404);
    assert.equal((await refused('POST', J(`jewellery/pieces/${piece.nkx.id}/status`), { status: 'at_karigar' })).status, 404, 'a piece moves on its challan only');
  });
});
