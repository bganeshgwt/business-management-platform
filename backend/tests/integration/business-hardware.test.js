const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Quotations (every type but a restaurant) and the hardware shop's own tools:
// sites with their ledger, today's rates, fitters' commission with payouts,
// and the coverage details the calculators read. Prices and GST to the
// paisa, idempotent postings, the rules the database keeps, audit and events,
// other types and other owners. Runs on its own throwaway database with every
// migration applied.
test('quotations and the hardware shop', { timeout: 300000 }, async (t) => {
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
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Hardware-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('hardware-owner');
  await owner('hardware-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(await login('hardware-owner@test.invalid'));
  const other = as(await login('hardware-other@test.invalid'));

  const [hardware, grocery, wholesale] = await createBusinesses(request, 'OWNER', ['hardware', 'grocery', 'wholesale']);
  const [otherHardware] = await createBusinesses(other, 'OTHER', ['hardware']);

  await t.test('modules, permissions and roles per type', async () => {
    for (const code of ['quotations', 'hardware_sites', 'hardware_rates', 'hardware_calculators']) assert.ok(hardware.capabilities.includes(code), `hardware starts with ${code}`);
    assert.ok(!hardware.capabilities.includes('fitter_commission'), 'fitters\' commission starts off');
    for (const business of [grocery, wholesale]) {
      for (const code of ['quotations', 'hardware_sites', 'hardware_rates', 'fitter_commission', 'hardware_calculators']) assert.ok(!business.capabilities.includes(code), `${business.business_type} has no ${code}`);
    }
    const tools = await request('GET', `/businesses/${hardware.id}/modules`);
    const tool = (code) => tools.find((m) => m.code === code);
    assert.equal(tool('fitter_commission').recommended, true);
    assert.ok(tool('fitter_commission').recommended_note);
    assert.deepEqual([...tool('quotations').requires].sort(), ['catalog', 'contacts', 'sales']);
    const wholesaleTools = await request('GET', `/businesses/${wholesale.id}/modules`);
    assert.equal(wholesaleTools.find((m) => m.code === 'quotations').recommended, true, 'quotations are recommended for a wholesaler');
    assert.ok(!wholesaleTools.some((m) => m.code === 'hardware_sites'), 'a wholesaler is not offered sites');
    const groceryTools = await request('GET', `/businesses/${grocery.id}/modules`);
    assert.equal(groceryTools.find((m) => m.code === 'quotations').recommended, false);
    // Every recommended row starts off and says why.
    const recommended = await rows("SELECT * FROM platform_module_business_types WHERE module_code IN ('quotations','fitter_commission') AND recommended");
    assert.ok(recommended.length === 6 && recommended.every((r) => !r.enabled_by_default && r.recommended_note));
    assert.equal((await one("SELECT count(*)::int AS n FROM platform_module_business_types WHERE module_code='quotations' AND business_type='restaurant'")).n, 0);
    // A grocery may switch quotations on, never a hardware tool.
    await request('PUT', `/businesses/${grocery.id}/modules/quotations`, { enabled: true });
    await request('PUT', `/businesses/${grocery.id}/modules/hardware_sites`, { enabled: true }, 409);
    await request('PUT', `/businesses/${grocery.id}/modules/quotations`, { enabled: false });
    // The shared templates hold the new permissions in every business (the role copies too).
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2
      AND rp.permission_code ~ '^(quotations|hardware_sites|fitter_commission)\\.'`, [business.id, template])).p;
    assert.deepEqual(await grants(hardware, 'cashier'), ['fitter_commission.create', 'fitter_commission.view', 'hardware_sites.edit', 'hardware_sites.view',
      'quotations.create', 'quotations.edit', 'quotations.print', 'quotations.view']);
    assert.deepEqual(await grants(hardware, 'accountant'), ['fitter_commission.approve', 'fitter_commission.view', 'hardware_sites.view', 'quotations.print', 'quotations.view']);
    assert.deepEqual(await grants(hardware, 'viewer'), ['fitter_commission.view', 'hardware_sites.view', 'quotations.view']);
    assert.deepEqual(await grants(hardware, 'stock_keeper'), ['hardware_sites.view']);
    assert.equal((await grants(hardware, 'manager')).length, 11);
    const kinds = await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'");
    for (const kind of ['sale', 'sales_order', 'delivery_challan', 'quotation']) assert.ok(kinds.d.includes(`'${kind}'`), kind);
  });

  // --- Shared set-up: a hardware shop's items, a contractor, staff -------------------------------
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const H = (suffix) => `/businesses/${hardware.id}/${suffix}`;
  const shop = (await request('GET', H('locations'))).items[0];
  const slabs = (await request('GET', H('tax-rates'))).items;
  const gst18 = slabs.find((r) => Number(r.rate) === 18), gst5 = slabs.find((r) => Number(r.rate) === 5);
  const opening = (quantity, unitCost, extra = {}) => ({ openingStock: { quantity, unitCost, locationId: shop.id, ...extra } });
  const goods = (body) => request('POST', H('catalog'), { kind: 'goods', tracking: 'quantity', taxRateId: gst18.id, ...body }, 201);
  const cement = await goods({ name: 'UltraTech OPC 53 grade cement 50 kg', code: 'CEM-OPC53', unit: 'bag', price: '395', mrp: '450', hsnCode: '2523', ...opening('400', '340') });
  const wire = await goods({ name: 'Binding wire 20 gauge', code: 'WIRE-20G', unit: 'kg', price: '95.50', hsnCode: '7217', ...opening('500', '80') });
  await request('POST', H('pack-sizes'), { skuId: wire.id, unitCode: 'coil', quantityInBase: '25' }, 201);
  const fitting = await request('POST', H('catalog'), { kind: 'service', name: 'Fitting charges', code: 'FIT', unit: 'service', tracking: 'none', price: '500', taxRateId: gst18.id }, 201);
  await request('PUT', H('modules/batches'), { enabled: true });
  const paint = await goods({ name: 'Apex exterior emulsion 4 L', code: 'APEX-4L', unit: 'each', tracking: 'batch', price: '1725', mrp: '1890', hsnCode: '3209',
    ...opening('2', '1400', { lotCode: 'B-OLD', expiresOn: daysFrom(100) }) });
  const supplier = await request('POST', H('contacts'), { kind: 'supplier', name: 'Asian Paints depot' }, 201);
  await request('POST', H('documents'), { kind: 'purchase', locationId: shop.id, contactId: supplier.id, requestKey: key(), supplierBillNo: 'AP-7781',
    lines: [{ skuId: paint.id, quantity: '5', unitPrice: '1400', lotCode: 'B-NEW', expiresOn: daysFrom(300) }] }, 201);
  const sharma = await request('POST', H('contacts'), { kind: 'customer', name: 'Sharma Constructions', phone: '9845012345' }, 201);
  const roles = (await request('GET', H('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', H('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    return as(await login(email));
  }
  const cashier = await staff('hw-cashier@test.invalid', 'cashier');
  const viewer = await staff('hw-viewer@test.invalid', 'viewer');
  const accountant = await staff('hw-accountant@test.invalid', 'accountant');
  const validUntil = daysFrom(7);
  const sum = (list, field) => list.reduce((total, x) => total + paise(x[field]), 0);
  const stockOf = async (sku) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [hardware.id, sku.id])).q);

  let quoted;
  await t.test('a quotation is priced exactly as a sale of the same lines, to the paisa', async () => {
    const lines = [{ skuId: cement.id, quantity: '40' }, { skuId: wire.id, quantity: '3', unit: 'coil' }, { skuId: fitting.id, quantity: '1' }];
    const counter = await request('POST', H('retail/quote'), { locationId: shop.id, contactId: sharma.id, lines });
    const preview = await request('POST', H('quotations/preview'), { locationId: shop.id, contactId: sharma.id, lines });
    for (const field of ['subtotal', 'tax', 'roundOff', 'total']) assert.equal(preview[field], counter[field], field);
    // Prices include GST, rounded to the rupee: 40 bags at 395, 3 coils of 25 kg at 95.50 a kg, fitting at 500.
    assert.deepEqual(preview.lines.map((l) => [l.net, l.tax]), [['13389.83', '2410.17'], ['6069.92', '1092.58'], ['423.73', '76.27']]);
    assert.deepEqual([preview.subtotal, preview.tax, preview.roundOff, preview.total], ['19883.48', '3579.02', '0.50', '23463.00']);
    quoted = await cashier('POST', H('quotations'), { requestKey: key(), locationId: shop.id, contactId: sharma.id, validUntil, lines, notes: 'Site at Whitefield, ground floor slab' }, 201);
    assert.match(quoted.quotation_no, /^QT\//);
    assert.deepEqual([quoted.status, quoted.state, quoted.revision, quoted.customer_name, quoted.customer_phone, quoted.valid_until], ['open', 'open', 1, 'Sharma Constructions', '9845012345', validUntil]);
    assert.deepEqual([quoted.subtotal, quoted.tax, quoted.round_off, quoted.total, quoted.tax_mode], ['19883.48', '3579.02', '0.50', '23463.00', 'inclusive']);
    assert.equal(sum(quoted.lines, 'net'), paise(quoted.subtotal));
    assert.equal(sum(quoted.lines, 'tax'), paise(quoted.tax));
    const coil = quoted.lines.find((l) => l.sku_id === wire.id);
    assert.deepEqual([coil.unit, Number(coil.quantity), coil.entered_unit, Number(coil.entered_quantity), coil.entered_unit_price, Number(coil.unit_factor), coil.hsn_code],
      ['kg', 75, 'coil', 3, '2387.50', 25, '7217']);
    assert.equal(quoted.lines.find((l) => l.sku_id === cement.id).mrp, '450.00');
    // Nothing leaves stock for a quotation.
    assert.equal(await stockOf(cement), 400);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='quotation.created' AND entity_id=$2", [hardware.id, quoted.id]);
    assert.equal(audit.details.total, '23463.00');
    const event = await one("SELECT payload FROM business_events WHERE business_id=$1 AND kind='quotation.created' AND entity_id=$2", [hardware.id, quoted.id]);
    assert.equal(event.payload.lines.length, 3);
  });

  await t.test('postings are idempotent and the rules hold', async () => {
    const body = { requestKey: key(), locationId: shop.id, customerName: 'Ravi Kumar', customerPhone: '98450 67890', validUntil, lines: [{ skuId: cement.id, quantity: '2' }] };
    const first = await request('POST', H('quotations'), body, 201);
    const again = await request('POST', H('quotations'), body, 201);
    assert.equal(again.id, first.id);
    await request('POST', H('quotations'), { ...body, lines: [{ skuId: cement.id, quantity: '3' }] }, 409);
    assert.equal(first.contact_id, null);
    assert.equal(first.customer_name, 'Ravi Kumar');
    await request('POST', H('quotations'), { ...body, requestKey: key(), validUntil: daysFrom(-1) }, 400);
    await request('POST', H('quotations'), { ...body, requestKey: key(), validUntil: daysFrom(181) }, 400);
    await request('POST', H('quotations'), { ...body, requestKey: key(), customerName: '' }, 400);
    await request('POST', H('quotations'), { ...body, requestKey: key(), customerPhone: '12345' }, 400);
    // A quotation is never deleted, and its lines are never edited in place.
    await assert.rejects(pool.query('DELETE FROM business_quotations WHERE id=$1', [first.id]), /never deleted; cancel it instead/);
    await assert.rejects(pool.query('UPDATE business_quotation_lines SET quantity=5 WHERE quotation_id=$1', [first.id]), /never changed; revise the quotation/);
    await assert.rejects(pool.query('UPDATE business_quotations SET revision=revision+2 WHERE id=$1', [first.id]), /one step at a time/);
    await assert.rejects(pool.query("UPDATE business_quotations SET quotation_no='QT/X' WHERE id=$1", [first.id]), /keeps its number/);
    // The viewer reads, the accountant prints but neither makes or cancels one.
    await viewer('GET', H(`quotations/${first.id}`));
    await viewer('POST', H('quotations'), { ...body, requestKey: key() }, 403);
    await accountant('POST', H(`quotations/${first.id}/cancel`), { reason: 'Customer bought elsewhere' }, 403);
    await cashier('POST', H(`quotations/${first.id}/cancel`), { reason: 'Customer bought elsewhere' }, 403);
    const cancelled = await request('POST', H(`quotations/${first.id}/cancel`), { reason: 'Customer bought elsewhere' });
    assert.deepEqual([cancelled.status, cancelled.cancel_reason], ['cancelled', 'Customer bought elsewhere']);
    const twice = await request('POST', H(`quotations/${first.id}/cancel`), { reason: 'Customer bought elsewhere' });
    assert.equal(twice.closed_at, cancelled.closed_at);
    await request('PUT', H(`quotations/${first.id}`), { ...body, requestKey: key() }, 409);
    await request('POST', H(`quotations/${first.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } }, 409);
    await assert.rejects(pool.query("UPDATE business_quotations SET notes='x' WHERE id=$1", [first.id]), /is cancelled and can no longer change/);
    await assert.rejects(pool.query('DELETE FROM business_quotation_lines WHERE quotation_id=$1', [first.id]), /never change/);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='quotation.cancelled' AND entity_id=$2", [hardware.id, first.id]);
    assert.equal(audit.details.reason, 'Customer bought elsewhere');
  });

  await t.test('a revision replaces the lines and keeps the old ones', async () => {
    const body = { requestKey: key(), contactId: sharma.id, validUntil: daysFrom(10), lines: [{ skuId: cement.id, quantity: '50' }, { skuId: wire.id, quantity: '2', unit: 'coil' }] };
    const revised = await cashier('PUT', H(`quotations/${quoted.id}`), body);
    assert.equal(revised.revision, 2);
    assert.equal(revised.quotation_no, quoted.quotation_no);
    assert.deepEqual(revised.lines.map((l) => [l.net, l.tax]), [['16737.29', '3012.71'], ['4046.61', '728.39']]);
    assert.deepEqual([revised.subtotal, revised.tax, revised.round_off, revised.total], ['20783.90', '3741.10', '0.00', '24525.00']);
    assert.equal(revised.revisions.length, 1);
    assert.deepEqual([revised.revisions[0].revision, revised.revisions[0].total_before, revised.revisions[0].total_after], [2, '23463.00', '24525.00']);
    assert.equal(revised.revisions[0].lines_before.length, 3);
    assert.equal(revised.notes, null);
    const again = await cashier('PUT', H(`quotations/${quoted.id}`), body);
    assert.equal(again.revision, 2);
    await cashier('PUT', H(`quotations/${quoted.id}`), { ...body, validUntil: daysFrom(11) }, 409);
    await viewer('PUT', H(`quotations/${quoted.id}`), { ...body, requestKey: key() }, 403);
    quoted = revised;
  });

  await t.test('an expired quotation is billed only after a revision', async () => {
    await pool.query('UPDATE business_quotations SET valid_until=$2 WHERE id=$1', [quoted.id, daysFrom(-1)]);
    const listed = await request('GET', H('quotations?state=expired'));
    assert.ok(listed.items.some((q) => q.id === quoted.id && q.state === 'expired'));
    const refused = await call('POST', H(`quotations/${quoted.id}/bill`), { requestKey: key() }, await login('hardware-owner@test.invalid'));
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /was valid until .*Revise it to bring its prices up to date/);
    // The database holds the same rule.
    await assert.rejects(pool.query("UPDATE business_quotations SET status='billed' WHERE id=$1", [quoted.id]), /was valid until .*Revise it/);
    const revised = await cashier('PUT', H(`quotations/${quoted.id}`), { requestKey: key(), contactId: sharma.id, validUntil: daysFrom(7),
      lines: [{ skuId: cement.id, quantity: '50' }, { skuId: wire.id, quantity: '2', unit: 'coil' }] });
    assert.deepEqual([revised.state, revised.revision, revised.total], ['open', 3, '24525.00']);
    quoted = revised;
  });

  await t.test('making the bill posts a sale at the quoted prices', async () => {
    const billKey = key();
    const made = await cashier('POST', H(`quotations/${quoted.id}/bill`), { requestKey: billKey }, 201);
    assert.equal(made.quotation.status, 'billed');
    assert.equal(made.quotation.document_id, made.document.id);
    assert.equal(made.document.total, quoted.total);
    const bill = await request('GET', H(`documents/${made.document.id}`));
    assert.deepEqual([bill.subtotal, bill.tax, bill.round_off, bill.total, bill.contact_id], [quoted.subtotal, quoted.tax, quoted.round_off, quoted.total, sharma.id]);
    assert.match(bill.notes, new RegExp(`Quotation ${quoted.quotation_no.replace(/\//g, '\\/')}`));
    const byItem = (sku) => bill.lines.find((l) => l.sku_id === sku.id);
    assert.deepEqual([Number(byItem(cement).quantity), byItem(cement).unit_price, byItem(cement).net, byItem(cement).tax], [50, '395.00', '16737.29', '3012.71']);
    const coil = byItem(wire);
    assert.deepEqual([coil.entered_unit, Number(coil.entered_quantity), coil.entered_unit_price, Number(coil.quantity), coil.net, coil.tax], ['coil', 2, '2387.50', 50, '4046.61', '728.39']);
    assert.equal(await stockOf(cement), 350);
    // A retry is the same bill; another request cannot bill it again.
    const again = await cashier('POST', H(`quotations/${quoted.id}/bill`), { requestKey: billKey }, 201);
    assert.equal(again.document.id, made.document.id);
    await cashier('POST', H(`quotations/${quoted.id}/bill`), { requestKey: billKey, notes: 'x' }, 409);
    const second = await call('POST', H(`quotations/${quoted.id}/bill`), { requestKey: key() }, await login('hardware-owner@test.invalid'));
    assert.equal(second.status, 409);
    assert.match(second.body.message, /billed on SI/);
    await assert.rejects(pool.query("UPDATE business_quotations SET notes='later' WHERE id=$1", [quoted.id]), /is billed and can no longer change/);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='quotation.billed' AND entity_id=$2", [hardware.id, quoted.id]);
    assert.equal(audit.details.documentNo, made.document.document_no);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='sale.posted' AND entity_id=$2", [hardware.id, made.document.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='quotation.billed' AND entity_id=$2", [hardware.id, quoted.id]));
  });

  await t.test('a line split over batches still adds up to the quotation', async () => {
    const q = await request('POST', H('quotations'), { requestKey: key(), locationId: shop.id, contactId: sharma.id, validUntil, lines: [{ skuId: paint.id, quantity: '3' }] }, 201);
    assert.deepEqual([q.lines[0].net, q.lines[0].tax, q.total], ['4385.59', '789.41', '5175.00']);
    const made = await request('POST', H(`quotations/${q.id}/bill`), { requestKey: key() }, 201);
    const bill = await request('GET', H(`documents/${made.document.id}`));
    // Oldest expiry first: both tins of B-OLD, then one of B-NEW, each at its share.
    assert.deepEqual(bill.lines.map((l) => [l.lot_code, Number(l.quantity), l.net, l.tax, Number(l.unit_price)]), [['B-OLD', 2, '2923.73', '526.27', 1725], ['B-NEW', 1, '1461.86', '263.14', 1725]]);
    assert.deepEqual([bill.subtotal, bill.tax, bill.total], ['4385.59', '789.41', '5175.00']);
  });

  await t.test('a walk-in pays the whole bill; changed GST or MRP needs a revision', async () => {
    const walkIn = await request('POST', H('quotations'), { requestKey: key(), locationId: shop.id, customerName: 'Meena Iyer', customerPhone: '9900112233', validUntil,
      lines: [{ skuId: cement.id, quantity: '5' }] }, 201);
    const unpaid = await call('POST', H(`quotations/${walkIn.id}/bill`), { requestKey: key() }, await login('hardware-owner@test.invalid'));
    assert.equal(unpaid.status, 409);
    assert.match(unpaid.body.message, /walk-in customer pays the whole bill/);
    // GST moved since the quotation.
    await request('PATCH', H(`catalog/${cement.id}`), { label: cement.label, price: '395', taxRateId: gst5.id, active: true });
    const gst = await call('POST', H(`quotations/${walkIn.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'upi' } }, await login('hardware-owner@test.invalid'));
    assert.equal(gst.status, 409);
    assert.match(gst.body.message, /GST on .* is now 5%, not the 18% quoted/);
    await request('PATCH', H(`catalog/${cement.id}`), { label: cement.label, price: '395', taxRateId: gst18.id, active: true });
    // The MRP came down below the quoted rate.
    await request('PATCH', H(`catalog/${cement.id}`), { label: cement.label, price: '380', mrp: '390', taxRateId: gst18.id, active: true });
    const mrp = await call('POST', H(`quotations/${walkIn.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'upi' } }, await login('hardware-owner@test.invalid'));
    assert.equal(mrp.status, 409);
    assert.match(mrp.body.message, /quoted at 395.00 a bag, above its MRP of 390.00 now/);
    const revised = await request('PUT', H(`quotations/${walkIn.id}`), { requestKey: key(), customerName: 'Meena Iyer', customerPhone: '9900112233', validUntil,
      lines: [{ skuId: cement.id, quantity: '5' }] });
    assert.equal(revised.total, '1900.00');
    const made = await request('POST', H(`quotations/${walkIn.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'upi' } }, 201);
    assert.equal(made.document.contact_id, null);
    const bill = await request('GET', H(`documents/${made.document.id}`));
    assert.match(bill.notes, /for Meena Iyer \(9900112233\)/);
    assert.equal(sum(bill.payments, 'amount'), paise('1900.00'));
    await request('PATCH', H(`catalog/${cement.id}`), { label: cement.label, price: '395', mrp: '450', taxRateId: gst18.id, active: true });
  });

  await t.test('with Sales orders on, a quotation becomes a sales order at its prices', async () => {
    const [tooled] = await withTools(request, [hardware]);
    assert.ok(tooled.capabilities.includes('sales_orders'));
    const service = await request('POST', H('quotations'), { requestKey: key(), locationId: shop.id, contactId: sharma.id, validUntil,
      lines: [{ skuId: cement.id, quantity: '2' }, { skuId: fitting.id, quantity: '1' }] }, 201);
    const refused = await call('POST', H(`quotations/${service.id}/order`), { requestKey: key() }, await login('hardware-owner@test.invalid'));
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /Fitting charges is a service; sales orders are for goods/);
    const q = await request('POST', H('quotations'), { requestKey: key(), locationId: shop.id, contactId: sharma.id, validUntil,
      lines: [{ skuId: cement.id, quantity: '20' }, { skuId: wire.id, quantity: '1', unit: 'coil' }] }, 201);
    const orderKey = key();
    const made = await request('POST', H(`quotations/${q.id}/order`), { requestKey: orderKey, expectedOn: daysFrom(3) }, 201);
    assert.deepEqual([made.quotation.status, made.quotation.order_id], ['ordered', made.order.id]);
    assert.equal((await request('POST', H(`quotations/${q.id}/order`), { requestKey: orderKey, expectedOn: daysFrom(3) }, 201)).order.id, made.order.id);
    const order = await request('GET', H(`sales-orders/${made.order.id}`));
    assert.deepEqual([order.subtotal, order.tax, order.total], [q.subtotal, q.tax, rupeesOf(paise(q.subtotal) + paise(q.tax))]);
    assert.deepEqual(order.lines.map((l) => [l.net, l.tax]), q.lines.map((l) => [l.net, l.tax]));
    const dispatched = await request('POST', H(`sales-orders/${order.id}/dispatch`), { requestKey: key(),
      lines: order.lines.map((l) => ({ orderLineId: l.id, quantity: String(Number(l.quantity)) })) }, 201);
    const invoice = await request('GET', H(`documents/${dispatched.document.id}`));
    assert.deepEqual([invoice.subtotal, invoice.tax], [q.subtotal, q.tax]);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='quotation.ordered' AND entity_id=$2", [hardware.id, q.id]);
    assert.equal(audit.details.orderNo, order.order_no);
  });

  await t.test('quotations belong to the business and to the module', async () => {
    await request('GET', `/businesses/${grocery.id}/quotations`, undefined, 403);
    await other('GET', H('quotations'), undefined, 404);
    await other('GET', H(`quotations/${quoted.id}`), undefined, 404);
    // Any shop may switch them on: a grocery's quotation, without sites.
    await request('PUT', `/businesses/${grocery.id}/modules/quotations`, { enabled: true });
    const rice = await request('POST', `/businesses/${grocery.id}/catalog`, { kind: 'goods', tracking: 'quantity', name: 'Sona masoori rice 25 kg', code: 'RICE25', unit: 'each', price: '1450' }, 201);
    const groceryShop = (await request('GET', `/businesses/${grocery.id}/locations`)).items[0];
    const q = await request('POST', `/businesses/${grocery.id}/quotations`, { requestKey: key(), locationId: groceryShop.id, customerName: 'Hotel Annapurna', validUntil,
      lines: [{ skuId: rice.id, quantity: '10' }] }, 201);
    assert.equal(q.site, null);
    await request('POST', `/businesses/${grocery.id}/quotations`, { requestKey: key(), locationId: groceryShop.id, customerName: 'Hotel Annapurna', validUntil, siteId: 1,
      lines: [{ skuId: rice.id, quantity: '10' }] }, 400);
    await other('GET', `/businesses/${otherHardware.id}/quotations`);
  });

  // --- Sites ------------------------------------------------------------------------------------
  const ownerToken = await login('hardware-owner@test.invalid');
  const mehta = await request('POST', H('contacts'), { kind: 'customer', name: 'Mehta Builders', phone: '9886001122' }, 201);
  let villa;
  await t.test('sites belong to one customer, and only to a hardware shop', async () => {
    villa = await cashier('POST', H('hardware/sites'), { contactId: sharma.id, name: 'Whitefield villa', address: 'Plot 14, Whitefield', contactPerson: 'Suresh (supervisor)', phone: '9900011122' }, 201);
    assert.deepEqual([villa.customer_name, villa.active], ['Sharma Constructions', true]);
    await request('POST', H('hardware/sites'), { contactId: sharma.id, name: 'whitefield VILLA' }, 409);
    await request('POST', H('hardware/sites'), { contactId: supplier.id, name: 'Depot' }, 404);
    await request('POST', H('hardware/sites'), { contactId: sharma.id, name: 'Site with a short phone', phone: '12345' }, 400);
    await viewer('POST', H('hardware/sites'), { contactId: sharma.id, name: 'Viewer site' }, 403);
    assert.equal((await viewer('GET', H('hardware/sites'))).total, 1);
    await request('GET', `/businesses/${grocery.id}/hardware/sites`, undefined, 403);
    await other('GET', H('hardware/sites'), undefined, 404);
    await other('GET', `/businesses/${otherHardware.id}/hardware/sites`);
    // The database keeps a site with its customer, and never deletes one.
    await assert.rejects(pool.query('UPDATE hardware_sites SET contact_id=$2 WHERE id=$1', [villa.id, mehta.id]), /stays with the customer/);
    await assert.rejects(pool.query('DELETE FROM hardware_sites WHERE id=$1', [villa.id]), /never deleted; close it instead/);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='site.created' AND entity_id=$2", [hardware.id, villa.id]);
    assert.equal(audit.details.customer, 'Sharma Constructions');
  });

  await t.test('a bill goes to a site; the site keeps a ledger to the paisa', async () => {
    const tower = await request('POST', H('hardware/sites'), { contactId: mehta.id, name: 'Mehta Towers' }, 201);
    const sale = (body, expected = 201) => request('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...body }, expected);
    // Another customer's site, a walk-in's bill, a closed site: refused.
    await sale({ contactId: sharma.id, siteId: tower.id, lines: [{ skuId: cement.id, quantity: '1' }] }, 409);
    const walkIn = await call('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, siteId: villa.id, lines: [{ skuId: cement.id, quantity: '1' }],
      payment: { amount: 'full', method: 'cash' } }, ownerToken);
    assert.equal(walkIn.status, 400);
    assert.match(walkIn.body.message, /named customer goes to a site/);
    await request('POST', `/businesses/${grocery.id}/documents`, { kind: 'sale', requestKey: key(), locationId: (await request('GET', `/businesses/${grocery.id}/locations`)).items[0].id,
      siteId: villa.id, lines: [{ skuId: (await request('GET', `/businesses/${grocery.id}/catalog`)).items[0].id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 400);
    // Two bills to the villa: 10 bags (₹3,950) and 4 coils of wire (₹9,550).
    const first = await cashier('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: sharma.id, siteId: villa.id, lines: [{ skuId: cement.id, quantity: '10' }] }, 201);
    const second = await sale({ contactId: sharma.id, siteId: villa.id, lines: [{ skuId: wire.id, quantity: '4', unit: 'coil' }] });
    assert.deepEqual([first.total, second.total], ['3950.00', '9550.00']);
    const bill = await request('GET', H(`documents/${first.id}`));
    assert.equal(bill.hardware.site.name, 'Whitefield villa');
    // Paid in part, two bags back.
    await request('POST', H(`documents/${first.id}/payments`), { amount: '1000', method: 'upi', requestKey: key() }, 201);
    const cementLine = bill.lines[0];
    await request('POST', H(`documents/${first.id}/returns`), { requestKey: key(), reason: 'Two bags left over', lines: [{ lineId: cementLine.id, quantity: '2', restock: true }] }, 201);
    const ledger = await request('GET', H(`hardware/sites/${villa.id}`));
    assert.deepEqual(ledger.totals, { billed: '13500.00', returned: '790.00', paid: '1000.00', balance: '11710.00' });
    assert.deepEqual(ledger.statement.map((e) => [e.kind, e.amount]), [['bill', '3950.00'], ['bill', '9550.00'], ['payment', '-1000.00'], ['return', '-790.00']]);
    assert.equal(ledger.statement.at(-1).balance, '11710.00');
    const listed = (await request('GET', H('hardware/sites?has_due=true'))).items.find((s) => s.id === villa.id);
    assert.deepEqual([listed.bill_count, paise(listed.billed), paise(listed.due)], [2, 1350000, 1171000]);
    // Sales history by site.
    const bySite = await request('GET', H(`documents?kind=sale&site=${villa.id}`));
    assert.deepEqual(bySite.items.map((d) => d.id).sort(), [first.id, second.id].sort());
    assert.ok(bySite.items.every((d) => d.site_name === 'Whitefield villa'));
    // A bill billed without its site gets it afterwards, and can lose it again.
    const third = await sale({ contactId: sharma.id, lines: [{ skuId: cement.id, quantity: '1' }] });
    await cashier('PUT', H(`hardware/bills/${third.id}/site`), { siteId: villa.id });
    assert.equal((await request('GET', H(`documents/${third.id}`))).hardware.site.id, villa.id);
    await cashier('PUT', H(`hardware/bills/${third.id}/site`), { siteId: tower.id }, 409);
    await viewer('PUT', H(`hardware/bills/${third.id}/site`), { siteId: null }, 403);
    await cashier('PUT', H(`hardware/bills/${third.id}/site`), { siteId: null });
    assert.equal((await request('GET', H(`documents/${third.id}`))).hardware.site, null);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='document.site_cleared' AND entity_id=$2", [hardware.id, third.id]));
    // The database refuses another customer's site on a bill.
    await assert.rejects(pool.query('INSERT INTO hardware_document_sites(business_id,document_id,site_id,set_by) VALUES($1,$2,$3,$4)', [hardware.id, third.id, tower.id, ownerUser.id]),
      /belongs to another customer/);
    // A stock keeper sees the sites, not the money.
    const keeper = await staff('hw-keeper@test.invalid', 'stock_keeper');
    const seen = await keeper('GET', H(`hardware/sites/${villa.id}`));
    assert.deepEqual([seen.money, seen.statement.length, seen.totals], [false, 0, null]);
    // A closed site takes no new bill.
    await request('PATCH', H(`hardware/sites/${tower.id}`), { name: 'Mehta Towers', active: false });
    const closed = await call('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: mehta.id, siteId: tower.id, lines: [{ skuId: cement.id, quantity: '1' }] }, ownerToken);
    assert.equal(closed.status, 409);
    assert.match(closed.body.message, /Mehta Towers is closed/);
  });

  await t.test('a quotation\'s site goes to its bill, its order and the order\'s invoices', async () => {
    const q = await cashier('POST', H('quotations'), { requestKey: key(), locationId: shop.id, contactId: sharma.id, siteId: villa.id, validUntil,
      lines: [{ skuId: cement.id, quantity: '5' }] }, 201);
    assert.equal(q.site.name, 'Whitefield villa');
    assert.ok((await request('GET', H(`quotations?site=${villa.id}`))).items.some((x) => x.id === q.id));
    // Another customer takes the site off; a site of the new customer only.
    const moved = await cashier('PUT', H(`quotations/${q.id}`), { requestKey: key(), contactId: mehta.id, validUntil, lines: [{ skuId: cement.id, quantity: '5' }] });
    assert.equal(moved.site, null);
    await cashier('PUT', H(`quotations/${q.id}`), { requestKey: key(), contactId: mehta.id, siteId: villa.id, validUntil, lines: [{ skuId: cement.id, quantity: '5' }] }, 409);
    const back = await cashier('PUT', H(`quotations/${q.id}`), { requestKey: key(), contactId: sharma.id, siteId: villa.id, validUntil, lines: [{ skuId: cement.id, quantity: '5' }] });
    assert.equal(back.site.id, villa.id);
    const made = await cashier('POST', H(`quotations/${q.id}/bill`), { requestKey: key() }, 201);
    assert.equal((await request('GET', H(`documents/${made.document.id}`))).hardware.site.id, villa.id);
    // The site of a billed quotation never changes.
    await assert.rejects(pool.query('DELETE FROM hardware_quotation_sites WHERE quotation_id=$1', [q.id]), /never changes/);
    const forOrder = await request('POST', H('quotations'), { requestKey: key(), locationId: shop.id, contactId: sharma.id, siteId: villa.id, validUntil,
      lines: [{ skuId: cement.id, quantity: '6' }] }, 201);
    const ordered = await request('POST', H(`quotations/${forOrder.id}/order`), { requestKey: key() }, 201);
    assert.equal((await request('GET', H(`hardware/orders/${ordered.order.id}/site`))).site.id, villa.id);
    const order = await request('GET', H(`sales-orders/${ordered.order.id}`));
    const sent = await request('POST', H(`sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: order.lines[0].id, quantity: '2' }] }, 201);
    assert.equal((await request('GET', H(`documents/${sent.document.id}`))).hardware.site.id, villa.id);
    // An order's site can change while it is still to send; earlier invoices keep theirs.
    const plain = await request('POST', H('sales-orders'), { requestKey: key(), locationId: shop.id, contactId: sharma.id, lines: [{ skuId: cement.id, quantity: '3' }] }, 201);
    const plainOrder = await request('GET', H(`sales-orders/${plain.id}`));
    const early = await request('POST', H(`sales-orders/${plain.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: plainOrder.lines[0].id, quantity: '1' }] }, 201);
    await cashier('PUT', H(`hardware/orders/${plain.id}/site`), { siteId: villa.id });
    assert.equal((await request('GET', H(`documents/${early.document.id}`))).hardware.site.id, villa.id, 'an invoice without a site takes the order\'s');
    const ledger = await request('GET', H(`hardware/sites/${villa.id}`));
    assert.equal(ledger.orders.length, 2);
    assert.ok(ledger.quotations.some((x) => x.id === q.id));
  });

  // --- Fitters' commission ------------------------------------------------------------------------
  let ramesh, imran;
  await t.test('fitters\' commission is earned to the paisa, frozen on the bill and taken back by returns', async () => {
    // Off until an owner switches it on: a bill naming a fitter is refused whole.
    const stockBefore = await stockOf(cement);
    await request('GET', H('hardware/fitters'), undefined, 403);
    const offSale = await call('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: sharma.id, fitterId: 1,
      lines: [{ skuId: cement.id, quantity: '1' }] }, ownerToken);
    assert.equal(offSale.status, 403);
    assert.match(offSale.body.message, /Fitters' commission is not switched on/);
    assert.equal(await stockOf(cement), stockBefore);
    await request('PUT', H('modules/fitter_commission'), { enabled: true });
    // The register: a cashier adds a fitter; one phone number per fitter.
    ramesh = await cashier('POST', H('hardware/fitters'), { name: 'Ramesh Kumar', trade: 'painter', phone: '9845098450', upiId: 'ramesh@okicici', area: 'Whitefield' }, 201);
    assert.deepEqual([ramesh.trade, ramesh.upi_id, ramesh.active], ['painter', 'ramesh@okicici', true]);
    await request('POST', H('hardware/fitters'), { name: 'Ramesh K', trade: 'painter', phone: '9845098450' }, 409);
    await request('POST', H('hardware/fitters'), { name: 'Bad UPI', trade: 'plumber', upiId: 'not-a-upi-id' }, 400);
    await request('POST', H('hardware/fitters'), { name: 'Welder', trade: 'welder' }, 400);
    await viewer('POST', H('hardware/fitters'), { name: 'Viewer fitter', trade: 'mason' }, 403);
    imran = await request('POST', H('hardware/fitters'), { name: 'Imran Khan', trade: 'plumber' }, 201);
    // Rules: 1% on every item, 2.5% on paints (and the categories under it), ₹2 a bag of cement.
    const paints = await request('POST', H('categories'), { name: 'Paints' }, 201);
    const exterior = await request('POST', H('categories'), { name: 'Exterior paints', parentId: paints.id }, 201);
    const emulsion = await goods({ name: 'Apex exterior emulsion 10 L', code: 'APEX-10L', unit: 'each', price: '4500', mrp: '4950', hsnCode: '3209', categoryId: exterior.id, ...opening('20', '3500') });
    await request('POST', H('hardware/fitter-rules'), { percent: '1' }, 201);
    const paintRule = await request('POST', H('hardware/fitter-rules'), { categoryId: paints.id, percent: '2.5' }, 201);
    await request('POST', H('hardware/fitter-rules'), { skuId: cement.id, perUnit: '2' }, 201);
    await request('POST', H('hardware/fitter-rules'), { categoryId: paints.id, percent: '3' }, 409);
    await request('POST', H('hardware/fitter-rules'), { categoryId: paints.id, perUnit: '5' }, 400);
    await request('POST', H('hardware/fitter-rules'), { skuId: wire.id, percent: '1', perUnit: '1' }, 400);
    await request('POST', H('hardware/fitter-rules'), { skuId: wire.id, percent: '51' }, 400);
    await cashier('POST', H('hardware/fitter-rules'), { skuId: wire.id, percent: '2' }, 403);
    assert.equal((await viewer('GET', H('hardware/fitter-rules?active=true'))).total, 3);

    // A bill fitted by Ramesh: 10 bags, 2 tins of emulsion, a coil of wire and the fitting charges.
    const lines = [{ skuId: cement.id, quantity: '10' }, { skuId: emulsion.id, quantity: '2' }, { skuId: wire.id, quantity: '1', unit: 'coil' }, { skuId: fitting.id, quantity: '1' }];
    const billKey = key();
    const sale = await cashier('POST', H('documents'), { kind: 'sale', requestKey: billKey, locationId: shop.id, contactId: sharma.id, fitterId: ramesh.id, lines }, 201);
    const bill = await request('GET', H(`documents/${sale.id}`));
    const lineOf = (sku) => bill.lines.find((l) => l.sku_id === sku.id);
    assert.deepEqual([cement, emulsion, wire, fitting].map((sku) => lineOf(sku).net), ['3347.46', '7627.12', '2023.31', '423.73']);
    // ₹2 × 10 bags; 2.5% of 7,627.12 = 190.678 → 190.68; 1% of 2,023.31 → 20.23; 1% of 423.73 → 4.24.
    assert.equal(bill.hardware.fitter.name, 'Ramesh Kumar');
    assert.equal(bill.hardware.fitter.commission, '235.15');
    assert.deepEqual(bill.hardware.fitter.lines.map((l) => [l.line_id, l.commission]),
      [[lineOf(cement).id, '20.00'], [lineOf(emulsion).id, '190.68'], [lineOf(wire).id, '20.23'], [lineOf(fitting).id, '4.24']]);
    assert.deepEqual(bill.hardware.fitter.lines.map((l) => [l.percent, l.per_unit]), [[null, '2.00'], ['2.50', null], ['1.00', null], ['1.00', null]]);
    // A retry is the same bill and the same commission; another fitter under that key is refused.
    assert.equal((await cashier('POST', H('documents'), { kind: 'sale', requestKey: billKey, locationId: shop.id, contactId: sharma.id, fitterId: ramesh.id, lines }, 201)).id, sale.id);
    await cashier('POST', H('documents'), { kind: 'sale', requestKey: billKey, locationId: shop.id, contactId: sharma.id, fitterId: imran.id, lines }, 409);
    assert.equal((await one('SELECT count(*)::int AS n FROM hardware_fitter_bills WHERE document_id=$1', [sale.id])).n, 1);
    const earnedEvent = await one("SELECT payload FROM business_events WHERE business_id=$1 AND kind='fitter_commission.earned' AND entity_id=$2", [hardware.id, sale.id]);
    assert.deepEqual([earnedEvent.payload.commission, earnedEvent.payload.lines.length], ['235.15', 4]);
    // A rule changed later never changes a posted bill; the next bill earns by the new rate.
    await request('PATCH', H(`hardware/fitter-rules/${paintRule.id}`), { percent: '5' });
    assert.equal((await request('GET', H(`documents/${sale.id}`))).hardware.fitter.commission, '235.15');
    const second = await request('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: sharma.id, fitterId: ramesh.id,
      lines: [{ skuId: emulsion.id, quantity: '1' }] }, 201);
    assert.equal((await request('GET', H(`documents/${second.id}`))).hardware.fitter.commission, '190.68');
    // The database keeps commission as it was made.
    await assert.rejects(pool.query('UPDATE hardware_fitter_bills SET commission=0 WHERE document_id=$1', [sale.id]), /kept as they were made/);
    await assert.rejects(pool.query('DELETE FROM hardware_fitter_lines WHERE document_id=$1', [sale.id]), /never deleted/);

    // Goods back take the commission back in proportion, to the paisa once all of it is back:
    // 7 kg of the 25 kg coil (5.66), then the other 18 kg (14.57) and one tin of emulsion (95.34).
    await request('POST', H(`documents/${sale.id}/returns`), { requestKey: key(), reason: 'Wire left over', lines: [{ lineId: lineOf(wire).id, quantity: '7', restock: true }] }, 201);
    await request('POST', H(`documents/${sale.id}/returns`), { requestKey: key(), reason: 'Rest of the wire and a tin',
      lines: [{ lineId: lineOf(wire).id, quantity: '18', restock: true }, { lineId: lineOf(emulsion).id, quantity: '1', restock: true }] }, 201);
    assert.deepEqual((await rows('SELECT amount FROM hardware_fitter_reversals WHERE document_id=$1 ORDER BY id', [sale.id])).map((r) => r.amount), ['5.66', '14.57', '95.34']);
    assert.equal((await request('GET', H(`documents/${sale.id}`))).hardware.fitter.taken_back, '115.57');

    // Making a quotation's bill names the fitter too.
    const q = await cashier('POST', H('quotations'), { requestKey: key(), locationId: shop.id, contactId: sharma.id, validUntil, lines: [{ skuId: cement.id, quantity: '5' }] }, 201);
    const made = await cashier('POST', H(`quotations/${q.id}/bill`), { requestKey: key(), fitterId: imran.id }, 201);
    assert.equal((await request('GET', H(`documents/${made.document.id}`))).hardware.fitter.commission, '10.00');
    // A fitter switched off is named on no new bill; fitters are a hardware shop's.
    await request('PATCH', H(`hardware/fitters/${imran.id}`), { name: 'Imran Khan', trade: 'plumber', active: false });
    const switchedOff = await call('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: sharma.id, fitterId: imran.id,
      lines: [{ skuId: cement.id, quantity: '1' }] }, ownerToken);
    assert.equal(switchedOff.status, 409);
    assert.match(switchedOff.body.message, /Imran Khan is switched off/);
    const groceryShop = (await request('GET', `/businesses/${grocery.id}/locations`)).items[0];
    const rice = (await request('GET', `/businesses/${grocery.id}/catalog`)).items[0];
    await request('POST', `/businesses/${grocery.id}/documents`, { kind: 'sale', requestKey: key(), locationId: groceryShop.id, fitterId: ramesh.id,
      lines: [{ skuId: rice.id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 400);
    await request('GET', `/businesses/${grocery.id}/hardware/fitters`, undefined, 403);
    await other('GET', H('hardware/fitters'), undefined, 404);
    await other('GET', H(`hardware/fitters/${ramesh.id}`), undefined, 404);
  });

  await t.test('fitters are paid through the expense book, never more than is due', async () => {
    const listed = (await accountant('GET', H('hardware/fitters?has_due=true'))).items;
    assert.deepEqual(listed.map((f) => f.name), ['Ramesh Kumar', 'Imran Khan']);
    // Earned 235.15 + 190.68, less 115.57 taken back by returns.
    assert.deepEqual([paise(listed[0].earned), paise(listed[0].taken_back), paise(listed[0].due), listed[0].bill_count], [42583, 11557, 31026, 2]);
    const payKey = key();
    const body = { requestKey: payKey, locationId: shop.id, amount: '200', method: 'upi', reference: 'UPI 4512 7781', notes: 'October' };
    await cashier('POST', H(`hardware/fitters/${ramesh.id}/payouts`), body, 403);
    const paid = await accountant('POST', H(`hardware/fitters/${ramesh.id}/payouts`), body, 201);
    assert.deepEqual([paid.amount, paid.method, paid.reference, paid.notes, paid.fitter_name, paid.reversed], ['200.00', 'upi', 'UPI 4512 7781', 'October', 'Ramesh Kumar', false]);
    assert.equal((await accountant('POST', H(`hardware/fitters/${ramesh.id}/payouts`), body, 201)).id, paid.id);
    await accountant('POST', H(`hardware/fitters/${ramesh.id}/payouts`), { ...body, amount: '201' }, 409);
    // The payout is an expense of the shop, so Daily money counts it.
    const expense = await one('SELECT * FROM business_expenses WHERE id=$1', [paid.expense_id]);
    assert.deepEqual([expense.category, expense.description, expense.amount, expense.method, String(expense.location_id), expense.reference],
      ['other', 'Fitter\'s commission: Ramesh Kumar (painter)', '200.00', 'upi', String(shop.id), 'UPI 4512 7781']);
    assert.equal((await request('GET', H('expenses'))).items.filter((e) => String(e.id) === String(paid.expense_id)).length, 1);
    // Never more than is due: 310.26 less 200 leaves 110.26.
    const over = await call('POST', H(`hardware/fitters/${ramesh.id}/payouts`), { requestKey: key(), locationId: shop.id, amount: '110.27', method: 'cash' }, ownerToken);
    assert.equal(over.status, 409);
    assert.match(over.body.message, /Ramesh Kumar is due 110.26/);
    await request('POST', H(`hardware/fitters/${ramesh.id}/payouts`), { requestKey: key(), locationId: shop.id, amount: '110.26', method: 'cash' }, 201);
    // Reversing the payout's expense takes the payout back.
    await accountant('POST', H(`expenses/${paid.expense_id}/reverse`), { reason: 'Paid twice by mistake' });
    const statement = await viewer('GET', H(`hardware/fitters/${ramesh.id}`));
    assert.deepEqual(statement.totals, { earned: '425.83', takenBack: '115.57', paid: '110.26', due: '200.00' });
    assert.deepEqual(statement.statement.map((e) => [e.kind, e.amount]),
      [['earned', '235.15'], ['earned', '190.68'], ['taken_back', '-5.66'], ['taken_back', '-109.91'], ['paid', '-200.00'], ['paid', '-110.26'], ['payout_reversed', '200.00']]);
    assert.equal(statement.statement.at(-1).balance, '200.00');
    const payouts = await viewer('GET', H(`hardware/fitter-payouts?fitter=${ramesh.id}`));
    assert.deepEqual(payouts.items.map((p) => [paise(p.amount), p.reversed]), [[11026, false], [20000, true]]);
    // The report for today: two bills, earned, taken back, paid (net of the reversal) and due.
    const report = await viewer('GET', H(`hardware/fitter-report?from=${daysFrom(0)}&to=${daysFrom(0)}`));
    const row = report.rows.find((r) => r.id === ramesh.id);
    assert.deepEqual([row.bills, row.earned, row.taken_back, row.paid, row.due], [2, '425.83', '115.57', '110.26', '200.00']);
    assert.equal(report.totals.due, '210.00');
    // Payouts are never edited or deleted; the audit and events record them.
    await assert.rejects(pool.query('DELETE FROM hardware_fitter_payouts WHERE id=$1', [paid.id]), /never deleted/);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='fitter_commission.paid' AND entity_id=$2", [hardware.id, paid.id]));
    assert.equal((await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='fitter.paid' AND entity_id=$2", [hardware.id, paid.id])).details.amount, '200.00');
  });

  // --- Today's rates --------------------------------------------------------------------------------
  await t.test('today\'s rates are saved together through the catalogue, and stamp when each changed', async () => {
    const steel = await goods({ name: 'TMT bar 12 mm Fe 550D', code: 'TMT-12', unit: 'kg', price: '68.50', hsnCode: '7214', ...opening('1000', '60') });
    // The board is on for a new hardware shop, and starts empty.
    assert.deepEqual((await viewer('GET', H('hardware/rates'))).items, []);
    await viewer('POST', H('hardware/rates/items'), { skuIds: [cement.id] }, 403);
    assert.equal((await request('POST', H('hardware/rates/items'), { skuIds: [cement.id, steel.id, wire.id] }, 201)).added, 3);
    assert.equal((await request('POST', H('hardware/rates/items'), { skuIds: [cement.id] }, 201)).added, 0);
    await request('POST', H('hardware/rates/items'), { skuIds: [cement.id, cement.id] }, 400);
    const opened = await viewer('GET', H('hardware/rates'));
    assert.equal(opened.taxMode, 'inclusive');
    assert.deepEqual(opened.items.map((i) => i.label).sort(), [cement.label, steel.label, wire.label].sort());
    assert.ok(opened.items.every((i) => i.previous_price === null && i.price_changed_at === null));
    const slabBefore = await one('SELECT tax_rate_id,mrp,hsn_code,label FROM catalog_skus WHERE id=$1', [cement.id]);

    // Cement 395 → 405 and steel 68.50 → 70.25 in one save; the wire's rate is unchanged.
    const saved = await request('PUT', H('hardware/rates'), { rates: [{ skuId: cement.id, price: '405', was: '395.00' },
      { skuId: steel.id, price: '70.25', was: '68.50' }, { skuId: wire.id, price: '95.50', was: '95.50' }] });
    assert.deepEqual(saved.changed.map((c) => [c.label, c.from, c.to]), [[cement.label, '395.00', '405.00'], [steel.label, '68.50', '70.25']]);
    const board = async () => (await request('GET', H('hardware/rates'))).items;
    const rowOf = (items, sku) => items.find((i) => i.id === sku.id);
    let items = await board();
    assert.deepEqual([rowOf(items, cement).price, rowOf(items, cement).previous_price, rowOf(items, steel).previous_price], ['405.00', '395.00', '68.50']);
    assert.ok(rowOf(items, cement).price_changed_at);
    assert.equal(rowOf(items, wire).price_changed_at, null);
    // Through the core update: the item keeps its slab, MRP and HSN; the audit and the event record it.
    assert.deepEqual(await one('SELECT tax_rate_id,mrp,hsn_code,label FROM catalog_skus WHERE id=$1', [cement.id]), slabBefore);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='catalog.price_changed' AND entity_id=$2 ORDER BY id DESC LIMIT 1", [hardware.id, cement.id]);
    assert.deepEqual([audit.details.from, audit.details.to], ['395.00', '405.00']);
    const event = await one("SELECT payload FROM business_events WHERE business_id=$1 AND kind='rates.changed' ORDER BY id DESC LIMIT 1", [hardware.id]);
    assert.equal(event.payload.rates.length, 2);
    // Saving the same rates again changes nothing.
    assert.deepEqual((await request('PUT', H('hardware/rates'), { rates: [{ skuId: cement.id, price: '405.00' }] })).changed, []);

    // All or nothing: a rate above the MRP is refused, and the other rates in that save stay as they were.
    const aboveMrp = await call('PUT', H('hardware/rates'), { rates: [{ skuId: steel.id, price: '72' }, { skuId: cement.id, price: '460' }] }, ownerToken);
    assert.equal(aboveMrp.status, 409);
    assert.match(aboveMrp.body.message, /above its MRP of 450\.00/);
    assert.equal((await one('SELECT price FROM catalog_skus WHERE id=$1', [steel.id])).price, '70.25');
    // A rate someone else changed since the board was opened is not overwritten.
    const stale = await call('PUT', H('hardware/rates'), { rates: [{ skuId: cement.id, price: '410', was: '395.00' }] }, ownerToken);
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /was changed to 405\.00 since you opened the board/);
    // A change made on the item itself stamps the board too.
    await request('PATCH', H(`catalog/${steel.id}`), { label: steel.label, price: '71', taxRateId: gst18.id, active: true });
    items = await board();
    assert.deepEqual([rowOf(items, steel).price, rowOf(items, steel).previous_price], ['71.00', '70.25']);
    // A bill takes today's rate.
    const sale = await request('POST', H('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: sharma.id, lines: [{ skuId: cement.id, quantity: '1' }] }, 201);
    assert.equal(sale.total, '405.00');

    // Off the board: the item and its price stay.
    await request('DELETE', H(`hardware/rates/items/${wire.id}`));
    await request('DELETE', H(`hardware/rates/items/${wire.id}`), undefined, 404);
    await request('PUT', H('hardware/rates'), { rates: [{ skuId: wire.id, price: '96' }] }, 404);
    assert.equal((await one('SELECT price FROM catalog_skus WHERE id=$1', [wire.id])).price, '95.50');
    // A hardware shop's own; switched off, the board is closed.
    await request('GET', `/businesses/${grocery.id}/hardware/rates`, undefined, 404);
    await other('GET', H('hardware/rates'), undefined, 404);
    await request('PUT', H('modules/hardware_rates'), { enabled: false });
    await request('GET', H('hardware/rates'), undefined, 403);
    await request('PUT', H('modules/hardware_rates'), { enabled: true });
    await request('PUT', H('hardware/rates'), { rates: [{ skuId: cement.id, price: '395', was: '405' }] });
  });

  // --- Tile & paint calculators ---------------------------------------------------------------------
  await t.test('the calculators read the coverage kept on the items, which changes after they are made', async () => {
    const tiles = await goods({ name: 'Vitrified floor tiles 2 x 2 ft, box of 4', code: 'VIT-2X2', unit: 'box', price: '1200', hsnCode: '6907', attributes: { coverageSqftPerUnit: '16' } });
    assert.deepEqual(tiles.attributes, { coverageSqftPerUnit: '16' });
    // A figure is a number above 0 with up to two decimals.
    const bad = (attributes) => request('POST', H('catalog'), { kind: 'goods', tracking: 'quantity', taxRateId: gst18.id, name: 'Wall tiles', code: `WT-${key().slice(0, 8)}`,
      unit: 'box', price: '900', attributes }, 400);
    await bad({ coverageSqftPerUnit: 'sixteen' });
    await bad({ coverageSqftPerUnit: '0' });
    await bad({ coverageSqftPerUnit: '15.555' });
    // A paint in 4-litre tins: its coverage per litre, and the litres in a tin.
    const tin = await goods({ name: 'Exterior emulsion 4 L tin', code: 'EXT-4L', unit: 'each', price: '2400', attributes: { coverageSqftPerLitre: '60', litresPerUnit: '4' } });
    const edit = (attributes, expected = 200) => request('PATCH', H(`catalog/${tin.id}`), { label: tin.label, price: '2400', taxRateId: gst18.id, active: true, attributes }, expected);
    // Changed on the item later: a new coverage, and an empty figure taken off.
    assert.deepEqual((await edit({ coverageSqftPerLitre: '55.5', litresPerUnit: '' })).attributes, { coverageSqftPerLitre: '55.5' });
    assert.deepEqual((await edit({ litresPerUnit: '4' })).attributes, { coverageSqftPerLitre: '55.5', litresPerUnit: '4' });
    // Other attributes are set when an item is made, not changed later.
    await edit({ manufacturer: 'Asian Paints' }, 400);
    // A change without attributes keeps them.
    await request('PATCH', H(`catalog/${tin.id}`), { label: tin.label, price: '2450', taxRateId: gst18.id, active: true });
    assert.deepEqual((await one('SELECT attributes FROM catalog_skus WHERE id=$1', [tin.id])).attributes, { coverageSqftPerLitre: '55.5', litresPerUnit: '4' });
    // What the calculators read: items on sale with a figure.
    const listed = await viewer('GET', H('hardware/calculator-items'));
    assert.deepEqual(listed.map((i) => i.label).sort(), [tiles.label, tin.label].sort());
    assert.deepEqual(listed.find((i) => i.id === tin.id).attributes, { coverageSqftPerLitre: '55.5', litresPerUnit: '4' });
    // Switched off: no list, and no figures accepted.
    await request('PUT', H('modules/hardware_calculators'), { enabled: false });
    await request('GET', H('hardware/calculator-items'), undefined, 403);
    await edit({ litresPerUnit: '4' }, 400);
    await request('PUT', H('modules/hardware_calculators'), { enabled: true });
    // A hardware shop's own.
    await request('GET', `/businesses/${grocery.id}/hardware/calculator-items`, undefined, 404);
    await other('GET', H('hardware/calculator-items'), undefined, 404);
    await request('POST', `/businesses/${grocery.id}/catalog`, { kind: 'goods', tracking: 'quantity', name: 'Floor tiles', code: 'FT-1', unit: 'box', price: '1000',
      attributes: { coverageSqftPerUnit: '16' } }, 400);
  });
});

const rupeesOf = (p) => (p / 100).toFixed(2);
