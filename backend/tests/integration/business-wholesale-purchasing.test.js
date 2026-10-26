const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const dates = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Wholesale / FMCG: purchase orders to suppliers (reorder
// suggestions, raise, change a draft, send, receive in parts against a core
// purchase, close short or cancel); the delivery challan (its own number
// series, A4 data, numbered once for older dispatches); free-goods schemes of
// another item and "don't combine with slab price", with the scheme report per
// retailer; bounced cheques (the business's bank charge, exactly the bills it
// settled reopened, credit hold after N bounces in a window). Another business
// sees none of it. Runs against its own throwaway database.
test('wholesale: purchase orders, challan, schemes, bounced cheques', { timeout: 300000 }, async (t) => {
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
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('ws-owner');
  await owner('ws-other');
  const token = await login('ws-owner@test.invalid');
  const otherToken = await login('ws-other@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const day = (offset) => dates.daysFrom(offset);

  const [ws] = await createBusinesses(request, 'OWNER', ['wholesale']);
  const [otherWs] = await createBusinesses(other, 'OTHER', ['wholesale']);
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const W = (suffix) => `/businesses/${ws.id}/${suffix}`;
  const O = (suffix) => `/businesses/${otherWs.id}/${suffix}`;
  const staff = {};
  const roles = (await request('GET', W('roles'))).items;
  for (const template of ['manager', 'cashier', 'stock_keeper', 'accountant', 'viewer']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, `WS ${template}`, `ws-${template}@test.invalid`, hash]);
    await request('POST', W('members'), { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    staff[template] = as(await login(`ws-${template}@test.invalid`));
  }

  const location = (await request('GET', W('locations'))).items[0];
  const company = await request('POST', W('contacts'), { kind: 'supplier', name: 'Deccan Snacks (fictional)', creditDays: 30 }, 201);
  const stockist = await request('POST', W('contacts'), { kind: 'supplier', name: 'Western Stockist (fictional)', creditDays: 21 }, 201);
  const shop = await request('POST', W('contacts'), { kind: 'customer', name: 'Om Sai Super Mart', creditDays: 30 }, 201);
  const kirana = await request('POST', W('contacts'), { kind: 'customer', name: 'Shree Balaji Kirana', creditDays: 15 }, 201);
  const noodles = await request('POST', W('catalog'), { name: 'Instant noodles 70 g', code: 'NDL', kind: 'goods', unit: 'each', tracking: 'batch', price: '12', taxRate: '5', reorderLevel: '192' }, 201);
  const biscuits = await request('POST', W('catalog'), { name: 'Glucose biscuits', code: 'BIS', kind: 'goods', unit: 'each', tracking: 'quantity', price: '10', taxRate: '18' }, 201);
  const chips = await request('POST', W('catalog'), { name: 'Potato chips 52 g', code: 'CHP', kind: 'goods', unit: 'each', tracking: 'quantity', price: '15', taxRate: '5', reorderLevel: '200' }, 201);
  await request('POST', W('pack-sizes'), { skuId: noodles.id, unitCode: 'case', quantityInBase: '96' }, 201);
  await request('POST', W('pack-sizes'), { skuId: biscuits.id, unitCode: 'case', quantityInBase: '48' }, 201);
  await request('POST', W('pack-sizes'), { skuId: chips.id, unitCode: 'case', quantityInBase: '50' }, 201);
  await request('POST', W('documents'), { kind: 'purchase', locationId: location.id, contactId: company.id, requestKey: key(), lines: [
    { skuId: noodles.id, quantity: '96', unitPrice: '9.50', lotCode: 'N-1', expiresOn: day(200) },
    { skuId: biscuits.id, quantity: '2400', unitPrice: '7' }] }, 201);

  let po;
  await t.test('purchase orders: suggestions, raise, change a draft, send', async () => {
    // Back-orders the godown cannot cover: 300 chips ordered, none in stock.
    await request('POST', W('sales-orders'), { locationId: location.id, contactId: shop.id, requestKey: key(), lines: [{ skuId: chips.id, quantity: '300' }] }, 201);
    const s = await request('GET', W(`purchase-orders/suggestions?location=${location.id}`));
    const chip = s.items.find((i) => i.sku_id === chips.id);
    assert.equal(chip.reason, 'back_order');
    assert.equal(Number(chip.need), 500, 'back-orders 300 + reorder level 200 - stock 0');
    assert.equal(chip.suggested_quantity, '10');
    assert.equal(chip.suggested_unit, 'case');
    assert.equal(chip.supplier_id, null, 'never bought');
    const noodle = s.items.find((i) => i.sku_id === noodles.id);
    assert.equal(noodle.reason, 'reorder');
    assert.equal(noodle.suggested_quantity, '1');
    assert.equal(Number(noodle.supplier_id), company.id);
    assert.equal(Number(noodle.last_cost), 9.5);
    assert.ok(!s.items.some((i) => i.sku_id === biscuits.id), 'stock above its level');
    await request('GET', W('purchase-orders/suggestions'), undefined, 400);
    // An item never bought needs a cost; a viewer may not raise.
    const body = { requestKey: key(), contactId: company.id, locationId: location.id, expectedOn: day(3), lines: [{ skuId: chips.id, unit: 'case', quantity: '10' }] };
    await request('POST', W('purchase-orders'), body, 400);
    await staff.viewer('POST', W('purchase-orders'), { ...body, requestKey: key() }, 403);
    await request('POST', W('purchase-orders'), { ...body, contactId: shop.id, lines: [{ skuId: chips.id, quantity: '1', unitCost: '1' }] }, 404);
    po = await staff.stock_keeper('POST', W('purchase-orders'), { ...body, lines: [
      { skuId: chips.id, unit: 'case', quantity: '10', unitCost: '650', source: 'back_order' },
      { skuId: noodles.id, unit: 'case', quantity: '2', source: 'reorder' }] }, 201);
    assert.match(po.po_no, /^PO\//);
    assert.equal(po.status, 'draft');
    // 10 cases × ₹650 + 192 × ₹9.50 = 6,500 + 1,824 = 8,324 before GST; 5 % GST = 416.20.
    assert.equal(po.subtotal, '8324.00');
    assert.equal(po.tax, '416.20');
    // The same request key with other lines is refused.
    await staff.stock_keeper('POST', W('purchase-orders'), { ...body, lines: [{ skuId: chips.id, unit: 'case', quantity: '1', unitCost: '650' }] }, 409);
    const draft = await request('PATCH', W(`purchase-orders/${po.id}`), { contactId: stockist.id, lines: [
      { skuId: chips.id, unit: 'case', quantity: '12', unitCost: '650' }, { skuId: noodles.id, unit: 'case', quantity: '2' }] });
    assert.equal(draft.contact_name, 'Western Stockist (fictional)');
    assert.equal(draft.subtotal, '9624.00');
    await request('PATCH', W(`purchase-orders/${po.id}`), { lines: [{ skuId: chips.id, quantity: '1', unitCost: '1' }, { skuId: chips.id, quantity: '2', unitCost: '1' }] }, 400);
    const sent = await request('POST', W(`purchase-orders/${po.id}/send`), { via: 'whatsapp' });
    assert.equal(sent.status, 'sent');
    await request('POST', W(`purchase-orders/${po.id}/send`), { via: 'email' }, 409);
    await request('PATCH', W(`purchase-orders/${po.id}`), { notes: 'too late' }, 409);
    const after = await request('GET', W(`purchase-orders/suggestions?location=${location.id}`));
    assert.equal(Number(after.items.find((i) => i.sku_id === chips.id)?.on_order ?? 600), 600, 'what is on order counts');
    assert.ok(!after.items.some((i) => i.sku_id === noodles.id), 'covered by the order');
    const list = await request('GET', W('purchase-orders?status=draft,sent'));
    assert.equal(list.total, 1);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='purchase_order.sent' AND entity_id=$2", [ws.id, po.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='purchase_order.raised' AND entity_id=$2", [ws.id, po.id]));
  });

  await t.test('purchase orders: received in parts as core purchases, then closed short; a draft cancelled', async () => {
    const detail = await request('GET', W(`purchase-orders/${po.id}`));
    const chipLine = detail.lines.find((l) => l.sku_id === chips.id);
    const noodleLine = detail.lines.find((l) => l.sku_id === noodles.id);
    const stockBefore = await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [ws.id, chips.id]);
    const body = { requestKey: key(), supplierBillNo: 'WS/26-27/881', supplierBillDate: day(0), lines: [
      { poLineId: chipLine.id, unit: 'case', quantity: '7', unitCost: '640' },
      { poLineId: noodleLine.id, unit: 'case', quantity: '1', lotCode: 'N-PO1', expiresOn: day(240) }] };
    await request('POST', W(`purchase-orders/${po.id}/receive`), { ...body, requestKey: key(), lines: [{ poLineId: noodleLine.id, unit: 'case', quantity: '1' }] }, 400);
    await request('POST', W(`purchase-orders/${po.id}/receive`), { ...body, requestKey: key(), lines: [{ poLineId: 999999, quantity: '1' }] }, 404);
    const got = await staff.stock_keeper('POST', W(`purchase-orders/${po.id}/receive`), body, 201);
    assert.equal(got.status, 'part_received');
    assert.equal(got.receipts.length, 1);
    const repeat = await staff.stock_keeper('POST', W(`purchase-orders/${po.id}/receive`), body, 201);
    assert.equal(repeat.receipts.length, 1, 'the same request receives once');
    const purchase = await request('GET', W(`documents/${got.receipts[0].document_id}`));
    assert.equal(purchase.kind, 'purchase');
    assert.equal(purchase.supplier_bill_no, 'WS/26-27/881');
    assert.match(purchase.notes, new RegExp(`Against ${po.po_no.replace(/\//g, '\\/')}`));
    // 7 cases × ₹640 + 96 × ₹9.50 = 4,480 + 912 = 5,392 + 5 % = 5,661.60
    assert.equal(purchase.total, '5661.60');
    const stockAfter = await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [ws.id, chips.id]);
    assert.equal(Number(stockAfter.q) - Number(stockBefore.q), 350);
    // The supplier sends 6 more cases where 5 were left: all 6 come in, the order counts 5.
    const more = await request('POST', W(`purchase-orders/${po.id}/receive`), { requestKey: key(), lines: [{ poLineId: chipLine.id, unit: 'case', quantity: '6' }] }, 201);
    const chipNow = more.lines.find((l) => l.id === chipLine.id);
    assert.equal(chipNow.received_quantity, '600.000');
    assert.equal(chipNow.remaining, '0.000');
    assert.equal(more.status, 'part_received', 'a noodle case is still to come');
    // The payables see both purchases.
    const supplierBills = await rows("SELECT id FROM business_documents WHERE business_id=$1 AND kind='purchase' AND contact_id=$2", [ws.id, stockist.id]);
    assert.equal(supplierBills.length, 2);
    await request('POST', W(`purchase-orders/${po.id}/close`), {}, 400);
    const closed = await request('POST', W(`purchase-orders/${po.id}/close`), { reason: 'Noodles out of stock at the company' });
    assert.equal(closed.status, 'closed');
    await request('POST', W(`purchase-orders/${po.id}/close`), { reason: 'again' }, 409);
    await request('POST', W(`purchase-orders/${po.id}/receive`), { requestKey: key(), lines: [{ poLineId: noodleLine.id, quantity: '1', lotCode: 'X' }] }, 409);
    const final = await request('GET', W(`purchase-orders/${po.id}`));
    assert.equal(final.lines.find((l) => l.id === noodleLine.id).closed_quantity, '96.000');
    // A draft nothing came on is cancelled.
    const draft = await request('POST', W('purchase-orders'), { requestKey: key(), contactId: company.id, locationId: location.id, lines: [{ skuId: biscuits.id, quantity: '48' }] }, 201);
    assert.equal((await request('POST', W(`purchase-orders/${draft.id}/close`), { reason: 'Raised by mistake' })).status, 'cancelled');
    // Receipts are history.
    await assert.rejects(pool.query('DELETE FROM wholesale_purchase_receipts WHERE po_id=$1', [po.id]), /cannot be changed or deleted/);
  });

  let dispatchId, schemeOrder;
  await t.test('schemes: another item free, not on top of a slab; free at ₹0 on the invoice; the scheme report', async () => {
    await request('POST', W('pricing'), { skuId: biscuits.id, unitCode: 'case', minimumQuantity: '5', unitPrice: '400' }, 201);
    await request('POST', W('schemes'), { name: 'x', skuId: biscuits.id, unitCode: 'case', buyQuantity: '5', freeSkuId: noodles.id }, 400);
    await request('POST', W('schemes'), { name: 'x', skuId: biscuits.id, buyQuantity: '5', freeQuantity: '1', freeSkuId: noodles.id, freeUnitCode: 'crate' }, 404);
    const scheme = await request('POST', W('schemes'), { name: 'Biscuits 5 cases + 1 case noodles', skuId: biscuits.id, unitCode: 'case', buyQuantity: '5',
      freeQuantity: '1', freeSkuId: noodles.id, freeUnitCode: 'case', noSlab: true }, 201);
    assert.equal(scheme.no_slab, true);
    schemeOrder = await request('POST', W('sales-orders'), { locationId: location.id, contactId: kirana.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '5' }] }, 201);
    const lines = (await request('GET', W(`sales-orders/${schemeOrder.id}`))).lines;
    const paid = lines.find((l) => !l.free_of_line_id), free = lines.find((l) => l.free_of_line_id);
    // Not combined with the ₹400 case slab: 240 × ₹10 = 2,400 (the slab would make it 2,000).
    assert.equal(paid.net, '2400.00');
    assert.equal(paid.price_rule_id, null);
    assert.equal(free.sku_id, noodles.id);
    assert.equal(free.quantity, '96.000');
    assert.equal(free.entered_unit, 'case');
    assert.equal(free.net, '0.00');
    assert.equal(free.scheme_id, scheme.id);
    // With the scheme switched off the slab prices the line again.
    await request('PATCH', W(`schemes/${scheme.id}`), { active: false });
    const slab = await request('POST', W('sales-orders'), { locationId: location.id, contactId: shop.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '5' }] }, 201);
    assert.equal(slab.subtotal, '2000.00');
    await request('POST', W(`sales-orders/${slab.id}/close`), { reason: 'test' });
    // A stacking scheme (the default) keeps the slab and adds its free goods.
    const stack = await request('POST', W('schemes'), { name: 'Biscuits 5 + 1 (stacks)', skuId: biscuits.id, unitCode: 'case', buyQuantity: '5', freeQuantity: '1' }, 201);
    const stacked = await request('POST', W('sales-orders'), { locationId: location.id, contactId: shop.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '5' }] }, 201);
    assert.equal(stacked.subtotal, '2000.00');
    await request('POST', W(`sales-orders/${stacked.id}/close`), { reason: 'test' });
    await request('PATCH', W(`schemes/${stack.id}`), { active: false });
    // Dispatch: the free noodles leave stock; the invoice line is ₹0, named with the scheme.
    const noodleStock = await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [ws.id, noodles.id]);
    const sent = await request('POST', W(`sales-orders/${schemeOrder.id}/dispatch`), { requestKey: key(), transporterName: 'Shree Transport', vehicleNo: 'mh12ab1234', lrNo: 'LR-901',
      lines: [{ orderLineId: paid.id, unit: 'case', quantity: '5' }, { orderLineId: free.id, unit: 'case', quantity: '1' }] }, 201);
    dispatchId = sent.dispatch.id;
    assert.match(sent.dispatch.challan_no, /^DC\//);
    const noodleAfter = await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [ws.id, noodles.id]);
    assert.equal(Number(noodleStock.q) - Number(noodleAfter.q), 96);
    const invoice = await request('GET', W(`documents/${sent.document.id}`));
    const freeLine = invoice.lines.find((l) => l.sku_id === noodles.id);
    assert.equal(freeLine.net, '0.00');
    const extra = invoice.wholesale.lines.find((l) => l.document_line_id === freeLine.id);
    assert.equal(extra.free, true);
    assert.equal(extra.scheme_name, 'Biscuits 5 cases + 1 case noodles');
    assert.equal(paise(invoice.total), paise(2400 * 1.18));
    // The scheme report, per retailer.
    const report = await request('GET', W(`wholesale-scheme-report?from=${day(0)}&to=${day(0)}`));
    const row = report.rows.find((r) => r.contact_id === kirana.id && r.scheme_id === scheme.id);
    assert.equal(row.orders, 1);
    assert.equal(row.bought, '240.000');
    assert.equal(row.free_sent, '96.000');
    assert.equal(row.free_item, 'Instant noodles 70 g');
    assert.equal(row.free_value, '1152.00');
    assert.equal(report.totals.retailers >= 1, true);
    await staff.cashier('GET', W(`wholesale-scheme-report?from=${day(0)}&to=${day(0)}`), undefined, 403);
    await request('GET', W(`wholesale-scheme-report?from=${day(0)}&to=${day(-3)}`), undefined, 400);
  });

  await t.test('delivery challan: own series, the A4 data, numbered once for an older dispatch', async () => {
    const c = await staff.stock_keeper('POST', W(`dispatches/${dispatchId}/challan`), {});
    assert.match(c.challan_no, /^DC\/\d{4}\/\d+$/);
    assert.equal(c.lr_no, 'LR-901');
    assert.equal(c.transporter_name, 'Shree Transport');
    assert.equal(c.vehicle_no, 'MH12AB1234');
    assert.equal(c.contact_name, 'Shree Balaji Kirana');
    assert.equal(c.lines.length, 2);
    assert.equal(c.lines.find((l) => l.free).scheme_name, 'Biscuits 5 cases + 1 case noodles');
    const series = await one("SELECT * FROM business_number_series WHERE business_id=$1 AND document_kind='delivery_challan'", [ws.id]);
    assert.equal(series.location_id, location.id);
    // The e-way bill is typed in by hand and prints on the challan.
    await request('PATCH', W(`dispatches/${dispatchId}/transport`), { transporterName: 'Shree Transport', vehicleNo: 'MH12AB1234', lrNo: 'LR-901', ewayBillNo: '331234567890', ewayBillDate: day(0) });
    assert.equal((await request('POST', W(`dispatches/${dispatchId}/challan`), {})).eway_bill_no, '331234567890');
    // A dispatch from before challans: numbered on its first print, then kept.
    await pool.query('UPDATE wholesale_dispatches SET challan_no=NULL,challan_series_id=NULL WHERE id=$1', [dispatchId]);
    const first = await request('POST', W(`dispatches/${dispatchId}/challan`), {});
    const second = await request('POST', W(`dispatches/${dispatchId}/challan`), {});
    assert.equal(first.challan_no, second.challan_no);
    assert.notEqual(first.challan_no, c.challan_no, 'a number is never handed out twice');
    assert.equal((await rows("SELECT id FROM business_audit WHERE business_id=$1 AND action='dispatch.challan_issued' AND entity_id=$2", [ws.id, dispatchId])).length, 1);
    const list = await request('GET', W(`dispatches?q=${encodeURIComponent('LR-901')}`));
    assert.equal(list.items[0].challan_no, first.challan_no);
  });

  await t.test('bounced cheques: exactly the bills reopen, the business charge, credit hold after 2 in 90 days', async () => {
    const settings = await request('GET', W('wholesale-settings'));
    assert.equal(Number(settings.bounce_charge), 500);
    assert.equal(settings.bounce_hold_count, 2);
    assert.equal(settings.bounce_hold_days, 90);
    // Two bills; a cheque settles the older one and part of the newer one.
    const billA = await request('POST', W('documents'), { kind: 'sale', locationId: location.id, contactId: shop.id, requestKey: key(), lines: [{ skuId: biscuits.id, quantity: '50' }] }, 201); // 590
    const billB = await request('POST', W('documents'), { kind: 'sale', locationId: location.id, contactId: shop.id, requestKey: key(), lines: [{ skuId: biscuits.id, quantity: '100' }] }, 201); // 1,180
    const cheque1 = await request('POST', W('collections'), { locationId: location.id, contactId: shop.id, amount: '1000', method: 'cheque', reference: '445501',
      chequeDate: day(0), bank: 'SBI', requestKey: key() }, 201);
    const settled = await rows('SELECT document_id,amount FROM business_payments WHERE collection_id=$1 ORDER BY id', [cheque1.id]);
    assert.ok(settled.some((p) => p.document_id === billA.id));
    const paidBefore = async (id) => paise((await one('SELECT COALESCE(sum(amount),0) AS s FROM business_payments WHERE document_id=$1', [id])).s);
    const otherPaid = await paidBefore(billB.id) - paise(settled.filter((p) => p.document_id === billB.id).reduce((s, p) => s + Number(p.amount), 0));
    const b1 = await staff.accountant('POST', W(`collections/${cheque1.id}/cheque`), { action: 'bounce', reason: 'Funds insufficient' });
    assert.equal(b1.bounce_charge, '500.00', 'the business setting');
    assert.equal(b1.credit_hold, null);
    assert.deepEqual(b1.reversed_allocations.map((a) => a.documentId).sort(), settled.map((p) => p.document_id).sort());
    assert.equal(await paidBefore(billA.id), 0, 'the bill it settled is open again');
    assert.equal(await paidBefore(billB.id), otherPaid, 'other payments on a bill stay');
    const account = await request('GET', W(`receivables/customers/${shop.id}`));
    assert.ok(account.items.some((i) => /bounce charge/.test(i.reference) && paise(i.open_amount) === 50000));
    // Not on hold after one; a charge typed on the bounce wins; the second bounce in 90 days holds.
    const order = { locationId: location.id, contactId: shop.id, lines: [{ skuId: biscuits.id, quantity: '10' }] };
    await staff.cashier('POST', W('sales-orders'), { ...order, requestKey: key() }, 201);
    const cheque2 = await request('POST', W('collections'), { locationId: location.id, contactId: shop.id, amount: '300', method: 'cheque', reference: '445502',
      chequeDate: day(0), bank: 'SBI', requestKey: key() }, 201);
    const b2 = await staff.accountant('POST', W(`collections/${cheque2.id}/cheque`), { action: 'bounce', reason: 'Signature differs', charge: '350' });
    assert.equal(b2.bounce_charge, '350.00');
    assert.deepEqual(b2.credit_hold, { bounces: 2, days: 90, limit: 2 });
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='customer.credit_hold_bounces' AND entity_id=$2", [ws.id, shop.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='customer.credit_hold' AND entity_id=$2", [ws.id, shop.id]));
    const held = await call('POST', W('sales-orders'), { ...order, requestKey: key() }, await login('ws-cashier@test.invalid'));
    assert.equal(held.status, 409);
    assert.equal(held.body.data.reason, 'credit_hold');
    assert.equal(held.body.data.holdReason, 'bounced_cheques');
    assert.match(held.body.message, /2 cheques bounced in the last 90 days/);
    const summary = await request('GET', W(`sales-orders/customer-summary/${shop.id}`));
    assert.equal(summary.hold.held, true);
    assert.equal(summary.hold.reason, 'bounced_cheques');
    // A manager lets one through with a reason; the setting turns it off.
    await staff.manager('POST', W('sales-orders'), { ...order, requestKey: key(), release: { reason: 'Paid cash today' } }, 201);
    await staff.cashier('PUT', W('wholesale-settings'), { bounceHoldCount: 3 }, 403);
    await request('PUT', W('wholesale-settings'), { bounceHoldCount: 0 }, 400);
    await request('PUT', W('wholesale-settings'), { bounceHoldDays: 3 }, 400);
    await request('PUT', W('wholesale-settings'), { bounceCharge: '-1' }, 400);
    const saved = await request('PUT', W('wholesale-settings'), { bounceHoldCount: null, bounceCharge: '450' });
    assert.equal(saved.bounce_hold_count, null);
    assert.equal(saved.bounce_hold_days, 90, 'a field left out is kept');
    await staff.cashier('POST', W('sales-orders'), { ...order, requestKey: key() }, 201);
    await request('PUT', W('wholesale-settings'), { bounceHoldCount: 2 });
    // The window: bounces older than it no longer hold.
    // (the cheque row is guarded; the test moves its date with the guard off for this one statement)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query("UPDATE business_collection_cheques SET bounced_at=now()-interval '100 days' WHERE collection_id=$1", [cheque1.id]);
      await client.query('COMMIT');
    } finally { client.release(); }
    await staff.cashier('POST', W('sales-orders'), { ...order, requestKey: key() }, 201);
  });

  await t.test('another business sees none of it', async () => {
    await other('GET', O(`purchase-orders/${po.id}`), undefined, 404);
    await other('POST', O(`purchase-orders/${po.id}/close`), { reason: 'x' }, 404);
    await other('POST', O(`dispatches/${dispatchId}/challan`), {}, 404);
    assert.equal((await other('GET', O('purchase-orders'))).total, 0);
    assert.equal((await other('GET', O(`wholesale-scheme-report?from=${day(0)}&to=${day(0)}`))).rows.length, 0);
    await call('GET', W(`purchase-orders/${po.id}`), undefined, otherToken).then((r) => assert.equal(r.status, 404));
    // Every stock lot still reconciles with its movements.
    const bad = await rows(`SELECT l.id FROM business_stock_lots l WHERE l.business_id=$1 AND l.quantity <> COALESCE((SELECT sum(quantity) FROM business_stock_movements m WHERE m.business_id=l.business_id AND m.lot_id=l.id),0)`, [ws.id]);
    assert.deepEqual(bad, []);
  });
});
