const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const dates = require('./helpers/dates');

// Phase 2, T2 — wholesale / FMCG: sales orders, dispatch with back-orders and
// FEFO batches, order prices per pack, credit limits at order and invoice,
// shared receivables (collections, advances, ageing, statements), routes,
// beats and salespeople, wholesale reports. Runs against its own throwaway
// database with every migration applied.
test('wholesale: orders, dispatch, back-orders, collections and ageing', { timeout: 300000 }, async (t) => {
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
  process.env.MULTI_BUSINESS_DEVELOPMENT = 'true';
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Wholesale-${crypto.randomBytes(8).toString('hex')}`;
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
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const ownerUser = await owner('wholesale-owner');
  await owner('wholesale-other');
  const token = await login('wholesale-owner@test.invalid');
  const otherToken = await login('wholesale-other@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);

  const demos = (await request('POST', '/businesses/development-demos', {}, 201)).businesses;
  const otherDemos = (await other('POST', '/businesses/development-demos', {}, 201)).businesses;
  // Pro pass (1791540000000): goods shops now start with prices including GST,
  // rounded to the rupee, and a walk-in pays in full. These checks were written for
  // prices before GST and post unpaid walk-in bills as fixtures.
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const ws = demos.find((b) => b.business_type === 'wholesale');
  const grocery = demos.find((b) => b.business_type === 'grocery');
  const salon = demos.find((b) => b.business_type === 'salon');
  const otherWs = otherDemos.find((b) => b.business_type === 'wholesale');
  const root = (business, suffix) => `/businesses/${business.id}/${suffix}`;
  const W = (suffix) => root(ws, suffix);

  await t.test('modules: wholesale gets orders and receivables, grocery gets receivables, a salon neither', async () => {
    assert.ok(ws.capabilities.includes('sales_orders') && ws.capabilities.includes('receivables'));
    assert.ok(grocery.capabilities.includes('receivables') && !grocery.capabilities.includes('sales_orders'));
    assert.ok(!salon.capabilities.includes('receivables'));
    await request('PUT', root(grocery, 'modules/sales_orders'), { enabled: true }, 409);
    await request('GET', root(grocery, 'sales-orders'), undefined, 403);
    await request('GET', root(salon, 'outstanding'), undefined, 403);
    // The new permissions reached the businesses' own role copies.
    const viewer = await one("SELECT array_agg(permission_code ORDER BY permission_code) AS p FROM business_role_permissions rp JOIN business_roles r ON r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code='viewer' AND (permission_code LIKE 'sales_orders.%' OR permission_code LIKE 'receivables.%')", [ws.id]);
    assert.deepEqual(viewer.p, ['receivables.export', 'receivables.view', 'sales_orders.export', 'sales_orders.view']);
    const series = await one("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='business_number_series_document_kind_check' AND pg_get_constraintdef(oid) LIKE '%sales_order%collection%'");
    assert.equal(series.n, 1);
  });

  // Staff with each template role in the wholesale business.
  const staff = {};
  const roles = (await request('GET', W('roles'))).items;
  for (const template of ['manager', 'cashier', 'stock_keeper', 'accountant', 'viewer']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, `WS ${template}`, `ws-${template}@test.invalid`, hash]);
    await request('POST', W('members'), { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    staff[template] = as(await login(`ws-${template}@test.invalid`));
  }

  const location = (await request('GET', W('locations'))).items[0];
  const supplier = await request('POST', W('contacts'), { kind: 'supplier', name: 'HLL Depot (fictional)', creditDays: 30 }, 201);
  const kirana = await request('POST', W('contacts'), { kind: 'customer', name: 'Balaji Kirana', creditDays: 15, creditLimit: '20000' }, 201);
  const hotel = await request('POST', W('contacts'), { kind: 'customer', name: 'Hotel Saravana', creditDays: 30 }, 201);
  const soap = await request('POST', W('catalog'), { name: 'Bathing soap 100 g', code: 'SOAP', kind: 'goods', unit: 'each', tracking: 'batch', price: '32', taxRate: '18' }, 201);
  const tea = await request('POST', W('catalog'), { name: 'Tea dust 1 kg', code: 'TEA', kind: 'goods', unit: 'each', tracking: 'quantity', price: '400', taxRate: '5' }, 201);
  await request('POST', W('pack-sizes'), { skuId: soap.id, unitCode: 'case', quantityInBase: '72' }, 201);
  const day = (offset) => dates.daysFrom(offset);
  // Three batches: one already expired, one expiring first, one later.
  await request('POST', W('documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [
    { skuId: soap.id, quantity: '50', unitPrice: '20', lotCode: 'OLD', expiresOn: day(-3) },
    { skuId: soap.id, quantity: '100', unitPrice: '21', lotCode: 'B-EARLY', expiresOn: day(60) },
    { skuId: soap.id, quantity: '1000', unitPrice: '22', lotCode: 'B-LATE', expiresOn: day(300) },
    { skuId: tea.id, quantity: '40', unitPrice: '300' }] }, 201);

  // Every invoice line raised from an order is complete in itself: rate × quantity
  // is its value, and its GST is worked out on its own value to the paisa.
  async function assertLinesConsistent(orderId) {
    const invoiceLines = await rows(`SELECT bl.*,doc.tax_mode FROM wholesale_dispatch_lines dl JOIN business_document_lines bl ON bl.id=dl.document_line_id
      JOIN business_documents doc ON doc.id=bl.document_id JOIN wholesale_dispatches d ON d.id=dl.dispatch_id WHERE d.order_id=$1`, [orderId]);
    assert.ok(invoiceLines.length > 0);
    for (const l of invoiceLines) {
      const net = paise(l.net), tax = paise(l.tax), rate = Number(l.tax_rate);
      if (l.tax_mode === 'inclusive') {
        const gross = net + tax;
        assert.equal(net, Math.round((gross * 100) / (100 + rate)), `inclusive GST inside line ${l.id}`);
      } else {
        assert.equal(tax, Math.round((net * rate) / 100), `GST on line ${l.id}: ${l.tax} on ${l.net} at ${rate}%`);
      }
      const value = Number(l.unit_price) * Number(l.quantity);
      assert.ok(Math.abs(value - Number(l.net)) <= Number(l.quantity) * 0.00005 + 0.0001, `rate × quantity on line ${l.id}: ${l.unit_price} × ${l.quantity} vs ${l.net}`);
    }
  }

  let salesperson, route, beat;
  await t.test('salespeople, routes and beats; a customer is put on a beat', async () => {
    salesperson = await request('POST', W('salespeople'), { name: 'Ravi Kumar', phone: '98450 12345' }, 201);
    route = await request('POST', W('routes'), { name: 'Jayanagar route', locationId: location.id }, 201);
    beat = await request('POST', W('beats'), { routeId: route.id, name: 'Jayanagar 4th block', visitDay: 2, salespersonId: salesperson.id }, 201);
    await request('POST', W('beats'), { routeId: route.id, name: 'Bad day', visitDay: 9 }, 400);
    await request('PUT', W(`customer-beats/${kirana.id}`), { beatId: beat.id });
    await request('PUT', W(`customer-beats/${supplier.id}`), { beatId: beat.id }, 404);
    await assert.rejects(pool.query('INSERT INTO wholesale_customer_beats(business_id,contact_id,beat_id) VALUES($1,$2,$3)', [ws.id, supplier.id, beat.id]), /Choose a customer/);
    await request('POST', W('salespeople'), { name: 'ravi kumar' }, 409);
    const list = await request('GET', W('customer-beats?q=Balaji'));
    assert.equal(list.items[0].route_name, 'Jayanagar route');
    await staff.cashier('POST', W('routes'), { name: 'Nope' }, 403);
    await staff.viewer('GET', W('beats'));
  });

  await t.test('slab prices per pack: a pack slab prices the cases, a customer price beats the general one', async () => {
    await request('POST', W('pricing'), { skuId: soap.id, unitCode: 'case', minimumQuantity: '2', unitPrice: '2050' }, 201);
    await request('POST', W('pricing'), { skuId: soap.id, unitCode: 'case', minimumQuantity: '2.5', unitPrice: '2000' }, 400);
    await request('POST', W('pricing'), { skuId: tea.id, unitCode: 'case', minimumQuantity: '2', unitPrice: '1' }, 404);
    await request('POST', W('pricing'), { skuId: tea.id, contactId: hotel.id, minimumQuantity: '10', unitPrice: '380' }, 201);
    // A direct sale in cases uses the pack slab, kept exactly per case.
    const sale = await request('POST', W('documents'), { kind: 'sale', locationId: location.id, contactId: hotel.id, requestKey: key(),
      lines: [{ skuId: soap.id, unit: 'case', quantity: '2', lotCode: 'B-LATE' }] }, 201);
    const detail = await request('GET', W(`documents/${sale.id}`));
    assert.equal(detail.lines[0].entered_unit_price, '2050.00');
    assert.equal(detail.lines[0].net, '4100.00');
    assert.ok(detail.lines[0].price_rule_id);
    // One case is under the slab: list price per piece.
    const small = await request('POST', W('documents'), { kind: 'sale', locationId: location.id, contactId: hotel.id, requestKey: key(),
      lines: [{ skuId: soap.id, unit: 'case', quantity: '1', lotCode: 'B-LATE' }] }, 201);
    assert.equal((await request('GET', W(`documents/${small.id}`))).lines[0].net, String((72 * 32).toFixed(2)));
  });

  let order;
  await t.test('an order fixes prices, converts packs and takes route and salesperson from the beat; no stock moves', async () => {
    const before = await one("SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2", [ws.id, soap.id]);
    order = await staff.cashier('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: key(),
      lines: [{ skuId: soap.id, unit: 'case', quantity: '3' }, { skuId: tea.id, quantity: '10' }] }, 201);
    assert.equal(order.salesperson_id, salesperson.id);
    assert.equal(order.route_id, route.id);
    assert.equal(order.beat_id, beat.id);
    assert.equal(order.status, 'open');
    assert.match(order.order_no, /^SO\//);
    // 3 cases at 2,050 + 18% = 7,257.00; 10 tea at 400 + 5% = 4,200.00
    assert.equal(order.total, '11457.00');
    const detail = await request('GET', W(`sales-orders/${order.id}`));
    const soapLine = detail.lines.find((l) => l.sku_id === soap.id);
    assert.equal(soapLine.quantity, '216.000');
    assert.equal(soapLine.entered_unit, 'case');
    assert.equal(soapLine.entered_unit_price, '2050.00');
    const after = await one("SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2", [ws.id, soap.id]);
    assert.equal(after.q, before.q, 'taking an order moves no stock');
    // Line snapshots cannot be rewritten or deleted.
    await assert.rejects(pool.query('UPDATE wholesale_order_lines SET quantity=1 WHERE id=$1', [soapLine.id]), /keeps what was ordered/);
    await assert.rejects(pool.query('DELETE FROM wholesale_order_lines WHERE id=$1', [soapLine.id]), /Order lines are kept/);
    // Same key again: the same order; same key, other content: refused.
    const again = await staff.cashier('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: order.request_key,
      lines: [{ skuId: soap.id, unit: 'case', quantity: '3' }, { skuId: tea.id, quantity: '10' }] }, 201);
    assert.equal(again.id, order.id);
    await staff.cashier('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: order.request_key, lines: [{ skuId: tea.id, quantity: '1' }] }, 409);
  });

  await t.test('credit limit at order: balance + orders not yet sent + this order', async () => {
    // Limit 20,000; 11,457 already on order. Another 9,000 order is refused.
    const refused = await call('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: key(), lines: [{ skuId: tea.id, quantity: '22' }] }, token);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /credit limit/);
    await request('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: key(), lines: [{ skuId: tea.id, quantity: '1' }] }, 201)
      .then((small) => request('POST', W(`sales-orders/${small.id}/close`), { reason: 'Customer phoned to cancel' }))
      .then((cancelled) => assert.equal(cancelled.status, 'cancelled'));
  });

  let firstInvoice;
  await t.test('partial dispatch: oldest usable batch first, invoice at order prices, the rest is a back-order', async () => {
    await staff.cashier('POST', W(`sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [] }, 403);
    await staff.viewer('POST', W(`sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [] }, 403);
    const detail = await request('GET', W(`sales-orders/${order.id}`));
    const soapLine = detail.lines.find((l) => l.sku_id === soap.id), teaLine = detail.lines.find((l) => l.sku_id === tea.id);
    const events = (await one('SELECT count(*)::int AS n FROM business_events WHERE business_id=$1', [ws.id])).n;
    // More than ordered is refused, and nothing is written.
    await staff.stock_keeper('POST', W(`sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: teaLine.id, quantity: '11' }] }, 409);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_events WHERE business_id=$1', [ws.id])).n, events, 'a refused dispatch leaves no event');
    // 2 cases = 144 pieces: 100 from B-EARLY, 44 from B-LATE; the expired batch is never used.
    const result = await staff.stock_keeper('POST', W(`sales-orders/${order.id}/dispatch`), { requestKey: key(), vehicleNo: 'KA05 AB 1234',
      lines: [{ orderLineId: soapLine.id, unit: 'case', quantity: '2' }, { orderLineId: teaLine.id, quantity: '4' }] }, 201);
    assert.equal(result.status, 'part_dispatched');
    firstInvoice = result.document;
    const invoice = await request('GET', W(`documents/${firstInvoice.id}`));
    const soapInvoiced = invoice.lines.filter((l) => l.sku_id === soap.id);
    assert.deepEqual(soapInvoiced.map((l) => [l.lot_code, l.quantity]), [['B-EARLY', '100.000'], ['B-LATE', '44.000']]);
    assert.ok(!invoice.lines.some((l) => l.lot_code === 'OLD'));
    // 144 of 216 pieces = 2/3 of 6,150.00 net.
    assert.equal(soapInvoiced.reduce((s, l) => s + paise(l.net), 0), 410000);
    assert.match(invoice.notes, /Order SO\/.*KA05 AB 1234/);
    assert.equal(invoice.contact_id, kirana.id);
    const backOrders = await request('GET', W('back-orders'));
    const soapBack = backOrders.items.find((l) => l.sku_id === soap.id);
    assert.equal(Number(soapBack.remaining), 72);
    assert.equal(Number(backOrders.items.find((l) => l.sku_id === tea.id).remaining), 6);
    const event = await one("SELECT * FROM business_events WHERE business_id=$1 AND kind='sales_order.dispatched' ORDER BY id DESC LIMIT 1", [ws.id]);
    assert.equal(event.payload.documentId, firstInvoice.id);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='sale.posted' AND entity_id=$2", [ws.id, firstInvoice.id]));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='sales_order.dispatched' AND entity_id=$2", [ws.id, order.id]));
    // Stock ledger still reconciles for every lot.
    const bad = await rows(`SELECT l.id FROM business_stock_lots l WHERE l.business_id=$1 AND l.quantity <> COALESCE((SELECT sum(quantity) FROM business_stock_movements m WHERE m.business_id=l.business_id AND m.lot_id=l.id),0)`, [ws.id]);
    assert.deepEqual(bad, []);
  });

  await t.test('dispatching the rest bills exactly the order; repeats are safe; more than stock is refused', async () => {
    const detail = await request('GET', W(`sales-orders/${order.id}`));
    const soapLine = detail.lines.find((l) => l.sku_id === soap.id), teaLine = detail.lines.find((l) => l.sku_id === tea.id);
    const body = { requestKey: key(), lines: [{ orderLineId: soapLine.id, unit: 'case', quantity: '1' }, { orderLineId: teaLine.id, quantity: '6' }] };
    const done = await request('POST', W(`sales-orders/${order.id}/dispatch`), body, 201);
    assert.equal(done.status, 'dispatched');
    const repeat = await request('POST', W(`sales-orders/${order.id}/dispatch`), body, 201);
    assert.equal(repeat.document.id, done.document.id);
    await request('POST', W(`sales-orders/${order.id}/dispatch`), { ...body, lines: [body.lines[1]] }, 409);
    await request('POST', W(`sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: teaLine.id, quantity: '1' }] }, 409);
    const invoiced = await one(`SELECT sum(bl.net) AS net,sum(bl.tax) AS tax FROM wholesale_dispatch_lines dl JOIN business_document_lines bl ON bl.id=dl.document_line_id
      JOIN wholesale_dispatches d ON d.id=dl.dispatch_id WHERE d.order_id=$1`, [order.id]);
    const placed = await one('SELECT subtotal,tax FROM wholesale_orders WHERE id=$1', [order.id]);
    assert.equal(invoiced.net, placed.subtotal, 'the line amounts add up to the order exactly');
    // GST is rounded per invoice line, so it may differ by a paisa per extra line the order was split into.
    const split = await one(`SELECT count(*)::int - (SELECT count(*)::int FROM wholesale_order_lines WHERE order_id=$1) AS extra
      FROM wholesale_dispatch_lines dl JOIN wholesale_dispatches d ON d.id=dl.dispatch_id WHERE d.order_id=$1`, [order.id]);
    assert.ok(Math.abs(paise(invoiced.tax) - paise(placed.tax)) <= split.extra, `${invoiced.tax} vs ${placed.tax}`);
    await assertLinesConsistent(order.id);
    // A big order cannot be sent beyond usable stock (tea: 40 bought, 10 gone).
    const big = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: tea.id, quantity: '35' }] }, 201);
    const bigLine = (await request('GET', W(`sales-orders/${big.id}`))).lines[0];
    const short = await call('POST', W(`sales-orders/${big.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: bigLine.id, quantity: '35' }] }, token);
    assert.equal(short.status, 409);
    assert.match(short.body.message, /Only 30 each of Tea dust 1 kg is in usable stock/);
    // Send what there is, then close the back-order short.
    await request('POST', W(`sales-orders/${big.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: bigLine.id, quantity: '30' }] }, 201);
    await staff.cashier('POST', W(`sales-orders/${big.id}/close`), { reason: 'x' }, 403);
    const closed = await staff.manager('POST', W(`sales-orders/${big.id}/close`), { reason: 'Out of stock this week' });
    assert.equal(closed.status, 'closed');
    const line = await one('SELECT dispatched_quantity,closed_quantity FROM wholesale_order_lines WHERE id=$1', [bigLine.id]);
    assert.deepEqual([line.dispatched_quantity, line.closed_quantity], ['30.000', '5.000']);
    await request('POST', W(`sales-orders/${big.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: bigLine.id, quantity: '1' }] }, 409);
  });

  await t.test('prices including GST: the gross is shared exactly and each line carries its own GST', async () => {
    await request('POST', W('documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [{ skuId: tea.id, quantity: '10', unitPrice: '300' }] }, 201);
    await pool.query("UPDATE business_settings SET tax_mode='inclusive' WHERE business_id=$1", [ws.id]);
    try {
      const o = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: soap.id, quantity: '53' }, { skuId: tea.id, quantity: '7' }] }, 201);
      assert.equal(o.tax_mode, 'inclusive');
      const lines = (await request('GET', W(`sales-orders/${o.id}`))).lines;
      const soapLine = lines.find((l) => l.sku_id === soap.id), teaLine = lines.find((l) => l.sku_id === tea.id);
      // Three uneven parts.
      for (const [s1, s2] of [['17', '3'], ['19', '2'], ['17', '2']]) {
        await request('POST', W(`sales-orders/${o.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: soapLine.id, quantity: s1 }, { orderLineId: teaLine.id, quantity: s2 }] }, 201);
      }
      const invoiced = await one(`SELECT sum(bl.net+bl.tax) AS gross FROM wholesale_dispatch_lines dl JOIN business_document_lines bl ON bl.id=dl.document_line_id
        JOIN wholesale_dispatches d ON d.id=dl.dispatch_id WHERE d.order_id=$1`, [o.id]);
      assert.equal(invoiced.gross, o.total, 'what the customer pays adds up to the order exactly');
      await assertLinesConsistent(o.id);
    } finally {
      await pool.query("UPDATE business_settings SET tax_mode='exclusive' WHERE business_id=$1", [ws.id]);
    }
  });

  await t.test('chosen batches are honoured; an expired batch cannot be chosen', async () => {
    const o = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: soap.id, quantity: '10' }] }, 201);
    const line = (await request('GET', W(`sales-orders/${o.id}`))).lines[0];
    const lots = (await request('GET', W(`stock?sku=${soap.id}`))).items;
    const expired = lots.find((l) => l.lot_code === 'OLD'), late = lots.find((l) => l.lot_code === 'B-LATE');
    await request('POST', W(`sales-orders/${o.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: line.id, quantity: '10', lots: [{ lotId: expired.id, quantity: '10' }] }] }, 409);
    await request('POST', W(`sales-orders/${o.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: line.id, quantity: '10', lots: [{ lotId: late.id, quantity: '9' }] }] }, 400);
    const sent = await request('POST', W(`sales-orders/${o.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: line.id, quantity: '10', lots: [{ lotId: late.id, quantity: '10' }] }] }, 201);
    assert.equal((await request('GET', W(`documents/${sent.document.id}`))).lines[0].lot_code, 'B-LATE');
  });

  await t.test('credit limit at invoice: a dispatch that would pass the limit is refused', async () => {
    const tight = await request('POST', W('contacts'), { kind: 'customer', name: 'Tight Traders', creditLimit: '1000' }, 201);
    const o = await request('POST', W('sales-orders'), { locationId: location.id, contactId: tight.id, requestKey: key(), lines: [{ skuId: soap.id, quantity: '20' }] }, 201);
    // Meanwhile a counter sale on credit uses up the limit.
    await request('POST', W('documents'), { kind: 'sale', locationId: location.id, contactId: tight.id, requestKey: key(), lines: [{ skuId: soap.id, quantity: '10', lotCode: 'B-LATE' }] }, 201);
    const line = (await request('GET', W(`sales-orders/${o.id}`))).lines[0];
    const refused = await call('POST', W(`sales-orders/${o.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: line.id, quantity: '20' }] }, token);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /credit limit/);
    assert.equal((await one('SELECT status FROM wholesale_orders WHERE id=$1', [o.id])).status, 'open');
  });

  await t.test('collections: oldest bills first, the rest is an advance, receipts are numbered and fixed', async () => {
    // Age the first invoice 45 days and add an old opening balance.
    await pool.query("UPDATE business_documents SET created_at=now()-interval '45 days', due_on=(now()-interval '30 days')::date WHERE id=$1", [firstInvoice.id]);
    await request('PATCH', W(`contacts/${kirana.id}`), { name: 'Balaji Kirana', openingBalance: '1500', openingBalanceOn: day(-100), creditLimit: '20000', creditDays: 15 });
    const account = await request('GET', W(`receivables/customers/${kirana.id}`));
    const balance = paise(account.summary.balance);
    assert.equal(paise(account.summary.outstanding), balance);
    assert.equal(paise(account.summary.days_over_90), 150000);
    assert.ok(paise(account.summary.days_31_60) > 0);
    assert.ok(paise(account.summary.overdue) >= paise(account.summary.days_31_60));
    await staff.stock_keeper('GET', W('outstanding'), undefined, 403);
    await staff.cashier('POST', W('collections'), { locationId: location.id, contactId: kirana.id, amount: '100', method: 'cheque', requestKey: key() }, 400);
    await staff.cashier('POST', W('collections'), { locationId: location.id, contactId: supplier.id, amount: '100', method: 'cash', requestKey: key() }, 404);
    // 6,000 collected: opening balance first (it is an advance against it), then the oldest bill.
    const body = { locationId: location.id, contactId: kirana.id, amount: '6000', method: 'upi', reference: 'UPI-77', requestKey: key(), salespersonId: salesperson.id, routeId: route.id };
    const receipt = await staff.accountant('POST', W('collections'), body, 201);
    assert.match(receipt.collection_no, /^RC\//);
    // The opening balance is the oldest item: 1,500 stays on account against it; bills get the rest.
    // Pro pass D-01: that 1,500 is reported as against the opening balance, not as an advance.
    assert.equal(receipt.opening_applied, '1500.00');
    assert.equal(receipt.unallocated, '0.00');
    assert.equal(receipt.allocated, '4500.00');
    const again = await staff.accountant('POST', W('collections'), body, 201);
    assert.equal(again.id, receipt.id);
    await staff.accountant('POST', W('collections'), { ...body, amount: '1' }, 409);
    const detail = await request('GET', W(`collections/${receipt.id}`));
    assert.equal(detail.allocations[0].document_id, firstInvoice.id, 'the oldest bill is settled first');
    const after = await request('GET', W(`receivables/customers/${kirana.id}`));
    assert.equal(paise(after.summary.balance), balance - 600000);
    assert.equal(paise(after.summary.days_over_90), 0, 'the opening balance is cleared first');
    assert.ok(await one("SELECT 1 FROM wholesale_collection_details WHERE collection_id=$1 AND salesperson_id=$2", [receipt.id, salesperson.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='collection.recorded' AND entity_id=$2", [ws.id, receipt.id]));
    // Receipts are fixed; money from one cannot settle another customer's bill or exceed it.
    await assert.rejects(pool.query('UPDATE business_collections SET amount=1 WHERE id=$1', [receipt.id]), /cannot be changed/);
    await assert.rejects(pool.query('DELETE FROM business_collections WHERE id=$1', [receipt.id]), /cannot be changed/);
    const hotelBill = await one("SELECT id FROM business_documents WHERE business_id=$1 AND contact_id=$2 LIMIT 1", [ws.id, hotel.id]);
    await assert.rejects(pool.query("INSERT INTO business_payments(business_id,document_id,amount,method,request_key,created_by,collection_id) VALUES($1,$2,1,'cash',$3,$4,$5)",
      [ws.id, hotelBill.id, key(), ownerUser.id, receipt.id]), /only settle bills of the customer/);
    const kiranaBill = await one("SELECT id FROM business_documents WHERE business_id=$1 AND contact_id=$2 AND id<>$3 ORDER BY id DESC LIMIT 1", [ws.id, kirana.id, firstInvoice.id]);
    await assert.rejects(pool.query("INSERT INTO business_payments(business_id,document_id,amount,method,request_key,created_by,collection_id) VALUES($1,$2,99999,'cash',$3,$4,$5)",
      [ws.id, kiranaBill.id, key(), ownerUser.id, receipt.id]), /has only/);
    // Naming a bill of another customer is refused.
    await staff.accountant('POST', W('collections'), { locationId: location.id, contactId: kirana.id, amount: '10', method: 'cash', requestKey: key(), allocations: [{ documentId: hotelBill.id, amount: '10' }] }, 404);
  });

  await t.test('an advance is applied to later bills; the statement closes at the balance', async () => {
    const advance = await request('POST', W('collections'), { locationId: location.id, contactId: hotel.id, amount: '50000', method: 'bank', reference: 'NEFT-1', requestKey: key(), allocations: [] }, 201);
    assert.equal(advance.unallocated, '50000.00');
    const open = await request('GET', W(`receivables/customers/${hotel.id}/open-bills`));
    assert.ok(open.length > 0);
    const applyKey = key();
    const applied = await request('POST', W(`receivables/customers/${hotel.id}/apply-advance`), { requestKey: applyKey }, 201);
    assert.ok(paise(applied.applied) > 0);
    const repeated = await request('POST', W(`receivables/customers/${hotel.id}/apply-advance`), { requestKey: applyKey }, 201);
    assert.equal(repeated.repeated, true);
    assert.deepEqual(await request('GET', W(`receivables/customers/${hotel.id}/open-bills`)), []);
    const hotelRow = (await request('GET', W('contacts?kind=customer&q=Saravana'))).items[0];
    assert.ok(Number(hotelRow.balance) < 0, 'what is left is an advance');
    const statement = await request('GET', W(`receivables/customers/${hotel.id}/statement?from=${day(-400)}&to=${day(1)}`));
    assert.equal(statement.closing, Number(hotelRow.balance).toFixed(2));
    assert.ok(statement.entries.some((e) => e.kind === 'collection'));
    assert.ok(!statement.entries.some((e) => e.kind === 'payment' && /NEFT/.test(e.reference)), 'collections are shown once');
    const kiranaStatement = await request('GET', W(`receivables/customers/${kirana.id}/statement?from=${day(-30)}&to=${day(1)}`));
    const kiranaRow = (await request('GET', W('contacts?kind=customer&q=Balaji'))).items[0];
    assert.equal(kiranaStatement.closing, Number(kiranaRow.balance).toFixed(2));
    assert.notEqual(kiranaStatement.opening, '0.00', 'older entries are brought forward');
    // The outstanding list: owing customers, totals over all rows, an advance filter.
    const owing = await request('GET', W('outstanding'));
    assert.ok(owing.items.some((r) => r.contact_id === kirana.id));
    assert.ok(!owing.items.some((r) => r.contact_id === hotel.id));
    assert.equal(paise(owing.totals.outstanding), owing.items.reduce((s, r) => s + paise(r.outstanding), 0));
    const advances = await request('GET', W('outstanding?show=advance'));
    assert.ok(advances.items.some((r) => r.contact_id === hotel.id));
    const onRoute = await request('GET', W(`outstanding?route=${route.id}&show=all`));
    assert.deepEqual(onRoute.items.map((r) => r.contact_id), [kirana.id]);
  });

  await t.test('wholesale reports by customer, salesperson, route, collections and outstanding', async () => {
    const period = `from=${day(-60)}&to=${day(1)}`;
    const bySalesperson = await staff.accountant('GET', W(`wholesale-reports?group=salesperson&${period}`));
    const ravi = bySalesperson.rows.find((r) => r.id === salesperson.id);
    assert.ok(ravi && ravi.invoices >= 2 && paise(ravi.net_sales) > 0, JSON.stringify(bySalesperson.rows));
    assert.ok(bySalesperson.rows.some((r) => r.id === 0), 'counter sales are reported on their own line');
    const byRoute = await request('GET', W(`wholesale-reports?group=route&${period}`));
    assert.ok(byRoute.rows.some((r) => r.id === route.id));
    const byCustomer = await request('GET', W(`wholesale-reports?group=customer&${period}`));
    assert.ok(byCustomer.rows.some((r) => r.id === kirana.id && r.orders >= 1));
    const collections = await request('GET', W(`wholesale-reports?group=collections&${period}`));
    assert.ok(collections.rows.some((r) => r.salesperson === 'Ravi Kumar' && r.method === 'upi'));
    const outstanding = await request('GET', W('wholesale-reports?group=outstanding&by=route'));
    assert.ok(outstanding.rows.some((r) => r.id === route.id && paise(r.balance) > 0));
    await staff.stock_keeper('GET', W(`wholesale-reports?group=customer&${period}`), undefined, 403);
    await request('GET', W('wholesale-reports?group=everything'), undefined, 400);
  });

  await t.test('rules at the edges: packs must convert exactly, services are not ordered, roles are enforced', async () => {
    await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: soap.id, unit: 'case', quantity: '0.1' }] }, 400);
    const service = await request('POST', W('catalog'), { name: 'Display fixing', code: 'SVC-FIX', kind: 'service', unit: 'service', price: '500', taxRate: '18' }, 201);
    await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: service.id, quantity: '1' }] }, 400);
    await request('POST', W('sales-orders'), { locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [{ skuId: tea.id, quantity: '1' }] }, 404);
    await staff.viewer('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: tea.id, quantity: '1' }] }, 403);
    await staff.viewer('GET', W('outstanding'));
    await staff.viewer('POST', W('collections'), { locationId: location.id, contactId: hotel.id, amount: '1', method: 'cash', requestKey: key() }, 403);
    await staff.stock_keeper('POST', W('collections'), { locationId: location.id, contactId: hotel.id, amount: '1', method: 'cash', requestKey: key() }, 403);
    await staff.cashier('POST', W('collections'), { locationId: location.id, contactId: hotel.id, amount: '1', method: 'cash', requestKey: key(), allocations: [] }, 201);
    await staff.accountant('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: tea.id, quantity: '1' }] }, 403);
    // The module switched off: every screen and action answers 403.
    await request('PUT', W('modules/sales_orders'), { enabled: false });
    await request('GET', W('sales-orders'), undefined, 403);
    await request('GET', W('wholesale-reports?group=outstanding'), undefined, 403);
    await request('GET', W('outstanding'));
    await request('PUT', W('modules/sales_orders'), { enabled: true });
  });

  await t.test('two dispatches of the same back-order at once: one goes, the other is refused', async () => {
    const o = await request('POST', W('sales-orders'), { locationId: location.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: soap.id, quantity: '30' }] }, 201);
    const line = (await request('GET', W(`sales-orders/${o.id}`))).lines[0];
    const results = await Promise.all([1, 2, 3].map(() => call('POST', W(`sales-orders/${o.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: line.id, quantity: '30' }] }, token)));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    const sent = await one('SELECT dispatched_quantity FROM wholesale_order_lines WHERE id=$1', [line.id]);
    assert.equal(sent.dispatched_quantity, '30.000');
    assert.equal((await one('SELECT count(*)::int AS n FROM wholesale_dispatches WHERE order_id=$1', [o.id])).n, 1);
    // Two collections at once on the same bill never pay it twice.
    const bill = results.find((r) => r.status === 201).body.data.document;
    const pay = await Promise.all([1, 2].map(() => call('POST', W('collections'), { locationId: location.id, contactId: hotel.id, amount: bill.total, method: 'cash', requestKey: key(), allocations: [{ documentId: bill.id, amount: bill.total }] }, token)));
    assert.deepEqual(pay.map((r) => r.status).sort(), [201, 409]);
  });

  await t.test('another business sees nothing and cannot point at these records', async () => {
    await other('GET', W('sales-orders'), undefined, 404);
    await other('GET', W(`sales-orders/${order.id}`), undefined, 404);
    await other('POST', W('collections'), { locationId: location.id, contactId: kirana.id, amount: '1', method: 'cash', requestKey: key() }, 404);
    const theirLocation = (await other('GET', root(otherWs, 'locations'))).items[0];
    // Their business, our customer / item / order: not found in their business.
    await other('POST', root(otherWs, 'sales-orders'), { locationId: theirLocation.id, contactId: kirana.id, requestKey: key(), lines: [{ skuId: tea.id, quantity: '1' }] }, 404);
    await other('POST', root(otherWs, `sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: 1, quantity: '1' }] }, 404);
    await other('GET', root(otherWs, `receivables/customers/${kirana.id}`), undefined, 404);
    assert.equal((await other('GET', root(otherWs, 'outstanding?show=all'))).total, 0);
    // And the database refuses a cross-business link even in raw SQL.
    const theirOrder = await other('POST', root(otherWs, 'contacts'), { kind: 'customer', name: 'Their shop' }, 201)
      .then((c) => other('POST', root(otherWs, 'catalog'), { name: 'Their tea', code: 'TT', kind: 'goods', unit: 'each', tracking: 'quantity', price: '10' }, 201)
        .then(() => other('POST', root(otherWs, 'sales-orders'), { locationId: theirLocation.id, contactId: c.id, requestKey: key(), lines: [] }, 400)));
    void theirOrder;
    const ourOrder = await one('SELECT * FROM wholesale_orders WHERE id=$1', [order.id]);
    await assert.rejects(pool.query(`INSERT INTO wholesale_order_lines(business_id,order_id,sku_id,label,unit,quantity,unit_price,tax_rate,net,tax)
      VALUES($1,$2,$3,'x','each',1,1,0,1,0)`, [otherWs.id, ourOrder.id, tea.id]), { code: '23503' });
    await assert.rejects(pool.query('INSERT INTO wholesale_customer_beats(business_id,contact_id,beat_id) VALUES($1,$2,$3)', [otherWs.id, kirana.id, beat.id]), (e) => ['23503', '23514'].includes(e.code));
  });
});
