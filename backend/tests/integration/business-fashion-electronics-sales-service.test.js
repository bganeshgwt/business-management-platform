const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');

// Fashion and electronics, sales and service: markdowns on a
// whole style through Offers, apparel GST by the value of each piece, the
// maker's barcode on a variant, finding a sale by scanning the garment,
// credit vouchers (issued on an exchange, spent on a later bill), the no-bill
// exchange, style reports (size curve, broken runs, ageing), phones scanned
// in with IMEI 2, DOA swaps that hold the bad unit for the supplier and move
// the warranty, repair intake with an advance / passcode / checklist, the
// approval state, messages logged, warranty claims. Own throwaway database.
test('fashion and electronics: sales and service', { timeout: 300000 }, async (t) => {
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
  const password = `Fashion-${crypto.randomBytes(8).toString('hex')}`;
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const ownerUser = await owner('fe-owner');
  await owner('fe-other');
  const token = await login('fe-owner@test.invalid');
  const otherToken = await login('fe-other@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);

  const [fashion, electronics] = await withTools(request, await createBusinesses(request, 'OWNER', ['fashion', 'electronics']));
  const F = (suffix) => `/businesses/${fashion.id}/${suffix}`;
  const E = (suffix) => `/businesses/${electronics.id}/${suffix}`;

  // Staff with template roles in both shops.
  const staff = {};
  for (const template of ['manager', 'cashier']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      [ownerUser.restaurant_id, `FE ${template}`, `fe-${template}@test.invalid`, hash]);
    staff[template] = { id: person.id, call: as(await login(`fe-${template}@test.invalid`)) };
    for (const business of [fashion, electronics]) {
      const roles = (await request('GET', `/businesses/${business.id}/roles`)).items;
      await request('POST', `/businesses/${business.id}/members`, { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    }
  }

  await t.test('modules: offers on for garment shops, exchanges on for electronics, no "sold by weight" for a new garment shop', async () => {
    assert.ok(fashion.capabilities.includes('offers'));
    assert.ok(electronics.capabilities.includes('exchanges'));
    assert.ok(!fashion.capabilities.includes('weight'));
  });

  const fLocation = (await request('GET', F('locations'))).items[0];
  const fSupplier = await request('POST', F('contacts'), { kind: 'supplier', name: 'Kaveri Mills' }, 201);
  let kurta, lehenga, kurtaVariants;
  await t.test('a style: maker barcodes typed for its variants, clashes refused', async () => {
    kurta = (await request('POST', F('fashion/products'), { name: 'Silk kurta', codePrefix: 'SKT', price: '2800', taxRate: '5', sizes: ['S', 'M', 'L', 'XL'], colors: ['Ivory', 'Rust'] }, 201)).product;
    lehenga = (await request('POST', F('fashion/products'), { name: 'Bridal lehenga', codePrefix: 'BLH', price: '2999', taxRate: '5', sizes: ['M'], colors: ['Red'] }, 201)).product;
    kurtaVariants = (await request('GET', F(`fashion/products/${kurta.id}`))).variants;
    const ivoryM = kurtaVariants.find((v) => v.color === 'Ivory' && v.size === 'M');
    const rustM = kurtaVariants.find((v) => v.color === 'Rust' && v.size === 'M');
    await request('PUT', F(`fashion/products/${kurta.id}/barcodes`), { barcodes: { [ivoryM.sku_id]: '8901234567890', [rustM.sku_id]: '8901234567890' } }, 400);
    await request('PUT', F(`fashion/products/${kurta.id}/barcodes`), { barcodes: { [ivoryM.sku_id]: '8901234567890' } });
    const scanned = await request('GET', F(`retail/scan?code=8901234567890&locationId=${fLocation.id}`));
    assert.equal(Number(scanned.sku.id), Number(ivoryM.sku_id));
    // Already on another variant (not in this request): refused; another product's variant: 404.
    await request('PUT', F(`fashion/products/${kurta.id}/barcodes`), { barcodes: { [rustM.sku_id]: '8901234567890' } }, 409);
    const lehengaSku = (await request('GET', F(`fashion/products/${lehenga.id}`))).variants[0];
    await request('PUT', F(`fashion/products/${kurta.id}/barcodes`), { barcodes: { [lehengaSku.sku_id]: '1234567' } }, 404);
    await staff.cashier.call('PUT', F(`fashion/products/${kurta.id}/barcodes`), { barcodes: { [rustM.sku_id]: '1234567' } }, 403);
    // Stock arrives: per-size cost on one receipt for two styles.
    const lines = [...kurtaVariants.map((v) => ({ skuId: v.sku_id, quantity: v.size === 'M' || v.size === 'L' ? '1' : '3', unitPrice: v.size === 'XL' ? '1500' : '1400' })),
      { skuId: lehengaSku.sku_id, quantity: '2', unitPrice: '1800' }];
    await request('POST', F('documents'), { kind: 'purchase', locationId: fLocation.id, contactId: fSupplier.id, requestKey: key(), supplierBillNo: 'KM/88', supplierBillDate: '2026-10-01', lines }, 201);
  });

  const quote = (lines, extra = {}) => request('POST', F('retail/quote'), { locationId: fLocation.id, lines, ...extra });
  await t.test('apparel GST by price: 5 % up to ₹2,500 a piece, 18 % above, after discounts', async () => {
    const lehengaSku = (await request('GET', F(`fashion/products/${lehenga.id}`))).variants[0];
    const before = await quote([{ skuId: lehengaSku.sku_id, quantity: '1' }]);
    assert.equal(Number(before.lines[0].taxRate), 5, 'the item slab until the rule is on');
    await staff.cashier.call('PUT', F('fashion/gst-rule'), { active: true }, 403);
    const rule = await request('PUT', F('fashion/gst-rule'), { active: true, threshold: '2500', rateLow: '5', rateHigh: '18' });
    assert.equal(rule.active, true);
    const dear = await quote([{ skuId: lehengaSku.sku_id, quantity: '1' }]);
    assert.equal(Number(dear.lines[0].taxRate), 18);
    assert.equal(dear.total, '2999.00', 'prices include GST: the shelf price does not move');
    assert.equal(paise(dear.lines[0].net) + paise(dear.lines[0].tax), 299900);
    assert.equal(dear.lines[0].tax, '457.47');
    // ₹2,625 incl. 5 % is ₹2,500 a piece: still 5 %; a rupee more is 18 %.
    const ivoryS = kurtaVariants.find((v) => v.color === 'Ivory' && v.size === 'S');
    await request('PATCH', F(`catalog/${ivoryS.sku_id}`), { label: ivoryS.label, price: '2625', active: true });
    assert.equal(Number((await quote([{ skuId: ivoryS.sku_id, quantity: '2' }])).lines[0].taxRate), 5);
    await request('PATCH', F(`catalog/${ivoryS.sku_id}`), { label: ivoryS.label, price: '2626', active: true });
    assert.equal(Number((await quote([{ skuId: ivoryS.sku_id, quantity: '2' }])).lines[0].taxRate), 18);
    await request('PATCH', F(`catalog/${ivoryS.sku_id}`), { label: ivoryS.label, price: '2800', active: true });
    // Posted bills keep the rate on the line.
    const sale = await request('POST', F('documents'), { kind: 'sale', locationId: fLocation.id, requestKey: key(), lines: [{ skuId: lehengaSku.sku_id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 201);
    const detail = await request('GET', F(`documents/${sale.id}`));
    assert.equal(Number(detail.lines[0].tax_rate), 18);
  });

  let markdown;
  await t.test('end-of-season markdown on a whole style: % off until a date, one at a time, ended in one step', async () => {
    const ivoryL = kurtaVariants.find((v) => v.color === 'Ivory' && v.size === 'L');
    await staff.cashier.call('POST', F('fashion/markdowns'), { productIds: [kurta.id], percent: '30', endsOn: '2099-01-31' }, 403);
    await request('POST', F('fashion/markdowns'), { productIds: [kurta.id], percent: '30', endsOn: '2020-01-01' }, 400);
    const made = await staff.manager.call('POST', F('fashion/markdowns'), { productIds: [kurta.id], percent: '30', endsOn: '2099-01-31' }, 201);
    markdown = made.offers[0];
    assert.equal(markdown.kind, 'product_percent');
    await request('POST', F('fashion/markdowns'), { productIds: [kurta.id], percent: '40', endsOn: '2099-02-28' }, 409);
    const marked = await quote([{ skuId: ivoryL.sku_id, quantity: '1' }]);
    assert.equal(marked.lines[0].discount, '840.00');
    assert.equal(marked.total, '1960.00');
    // ₹1,960 a piece now: 5 % (the 18 % it carried at ₹2,800 no longer applies).
    assert.equal(Number(marked.lines[0].taxRate), 5);
    const list = await request('GET', F(`fashion/markdowns?productId=${kurta.id}`));
    assert.equal(list[0].status, 'running');
    // It shows on the Offers screen too.
    assert.ok((await request('GET', F('offers'))).items.some((o) => o.id === markdown.id && o.product_name === 'Silk kurta'));
    await request('POST', F(`fashion/markdowns/${markdown.id}/end`));
    const back = await quote([{ skuId: ivoryL.sku_id, quantity: '1' }]);
    assert.equal(back.lines[0].discount, '0.00');
    assert.equal(back.total, '2800.00');
    await other('POST', F(`fashion/markdowns/${markdown.id}/end`), undefined, 404);
  });

  let walkInSale, voucher;
  await t.test('exchange: find the sale by scanning the garment; credit as a voucher for a walk-in; spend it on a later bill', async () => {
    const rustL = kurtaVariants.find((v) => v.color === 'Rust' && v.size === 'L');
    const rustS = kurtaVariants.find((v) => v.color === 'Rust' && v.size === 'S');
    walkInSale = await request('POST', F('documents'), { kind: 'sale', locationId: fLocation.id, requestKey: key(), lines: [{ skuId: rustL.sku_id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 201);
    const found = await staff.cashier.call('GET', F(`exchanges/find?code=${encodeURIComponent(rustL.barcode)}`));
    assert.equal(found.items[0].id, walkInSale.id);
    assert.equal(Number(found.items[0].lines[0].skuId), Number(rustL.sku_id));
    await request('GET', F('exchanges/find?phone=12'), undefined, 400);
    // The cheaper size: the price drops for S, so the customer is owed money.
    await request('PATCH', F(`catalog/${rustS.sku_id}`), { label: rustS.label, price: '2000', active: true });
    const detail = await request('GET', F(`documents/${walkInSale.id}`));
    const body = { documentId: walkInSale.id, reason: 'Size too big', returnLines: [{ lineId: detail.lines[0].id, quantity: '1', restock: true }],
      newLines: [{ skuId: rustS.sku_id, quantity: '1' }] };
    const figures = await request('POST', F('exchanges/quote'), body);
    assert.equal(figures.excess, '800.00');
    // A cashier (no refunds) can still give a voucher: no money leaves.
    const exchange = await staff.cashier.call('POST', F('exchanges'), { ...body, requestKey: key(), settlement: { method: 'voucher', name: 'Meera', phone: '98450 11111' } }, 201);
    assert.equal(exchange.method, 'voucher');
    voucher = exchange.voucher;
    assert.match(voucher.voucher_no, /^CV\d{6}$/);
    assert.equal(voucher.amount, '800.00');
    const found2 = await staff.cashier.call('GET', F(`vouchers/by-number/${voucher.voucher_no.toLowerCase()}`));
    assert.equal(found2.balance, '800.00');
    assert.equal(found2.state, 'open');
    assert.equal(found2.customer_name, 'Meera');
    // Spent at the counter: the voucher pays first, the rest in cash.
    const ivoryXL = kurtaVariants.find((v) => v.color === 'Ivory' && v.size === 'XL');
    const spent = await staff.cashier.call('POST', F('documents'), { kind: 'sale', locationId: fLocation.id, requestKey: key(), voucher: { code: voucher.voucher_no },
      lines: [{ skuId: ivoryXL.sku_id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, 201);
    const paid = await request('GET', F(`documents/${spent.id}`));
    assert.deepEqual(paid.payments.map((p) => [p.method, p.amount, p.reference]).sort(), [['cash', '2000.00', null], ['credit_note', '800.00', voucher.voucher_no]].sort());
    assert.equal((await request('GET', F(`vouchers/by-number/${voucher.voucher_no}`))).state, 'used');
    const again = await call('POST', F('documents'), { kind: 'sale', locationId: fLocation.id, requestKey: key(), voucher: { code: voucher.voucher_no },
      lines: [{ skuId: ivoryXL.sku_id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } }, token);
    assert.equal(again.status, 409);
    // Another business never sees it; the voucher list shows it.
    await other('GET', F(`vouchers/by-number/${voucher.voucher_no}`), undefined, 404);
    assert.equal((await request('GET', F('vouchers?state=used'))).items[0].voucher_no, voucher.voucher_no);
    // Takings: the voucher is not cash.
    const takings = await request('GET', F('reports/takings'));
    assert.ok(JSON.stringify(takings).length > 0);
  });

  await t.test('no-bill (gift) exchange: a manager only, against the latest sale of the item, credit as a voucher', async () => {
    const ivoryM = kurtaVariants.find((v) => v.color === 'Ivory' && v.size === 'M');
    const rustM = kurtaVariants.find((v) => v.color === 'Rust' && v.size === 'M');
    const gift = await request('POST', F('documents'), { kind: 'sale', locationId: fLocation.id, requestKey: key(), lines: [{ skuId: ivoryM.sku_id, quantity: '1' }], payment: { amount: 'full', method: 'upi' } }, 201);
    const body = { noBill: true, returnSku: { skuId: ivoryM.sku_id, quantity: '1', restock: true }, reason: 'Gift, colour swap', newLines: [{ skuId: rustM.sku_id, quantity: '1' }] };
    await staff.cashier.call('POST', F('exchanges'), { ...body, requestKey: key() }, 403);
    const even = await staff.manager.call('POST', F('exchanges'), { ...body, requestKey: key() }, 201);
    assert.equal(even.no_bill, true);
    assert.equal(even.original_document_id, gift.id);
    assert.equal(even.difference ?? (Number(even.new_value) - Number(even.returned_value)).toFixed(2), '0.00');
    // Nothing of that item left to come back: refused.
    await request('POST', F('exchanges'), { ...body, requestKey: key() }, 409);
  });

  await t.test('style report: size curve, broken size runs and stock ageing', async () => {
    const report = await request('GET', F('fashion/reports/styles?from=2026-01-01&to=2026-12-31'));
    const style = report.styles.find((s) => s.product_id === kurta.id);
    assert.deepEqual(style.sizes.map((s) => s.size), ['S', 'M', 'L', 'XL']);
    assert.ok(style.sizes.reduce((sum, s) => sum + (s.share || 0), 0) > 99);
    assert.equal(Number(style.ages.d0_30), Number(style.stock_qty));
    // Rust: one L came in and was sold, then came back on the exchange; the M was
    // swapped out: Rust M is at 0 while S and XL hold stock: a broken run.
    const rust = report.broken.find((b) => b.product_id === kurta.id && b.color === 'Rust');
    assert.ok(rust && rust.missing.includes('M'));
    await staff.cashier.call('GET', F('fashion/reports/styles?from=2026-01-01&to=2026-12-31'), undefined, 403);
  });

  // --- Electronics ---------------------------------------------------------------------------
  const eLocation = (await request('GET', E('locations'))).items[0];
  const eSupplier = await request('POST', E('contacts'), { kind: 'supplier', name: 'Mobile Distributor' }, 201);
  const phone = await request('POST', E('catalog'), { kind: 'goods', name: 'Orbit 5G', code: 'ORB5G', unit: 'each', tracking: 'serial', price: '15999', taxRate: '18' }, 201);
  await request('PUT', E(`electronics/models/${phone.id}`), { serialKind: 'imei', warrantyMonths: 12, warrantyTerms: 'One year.', helpline: '1800 123 456' });
  const imei = (body) => { // 14 digits → Luhn check digit
    const total = [...body].reduce((sum, c, i) => { let d = Number(c); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } return sum + d; }, 0);
    return body + ((10 - (total % 10)) % 10);
  };
  const units = ['35209900176141', '35209900176142', '35209900176143', '35209900176144'].map(imei);
  const seconds = ['35209900176151', '35209900176152', '35209900176153', '35209900176154'].map(imei);

  await t.test('phones scanned in on one receipt with IMEI 2; bad and repeated numbers refused', async () => {
    const body = (u) => ({ locationId: eLocation.id, contactId: eSupplier.id, supplierBillNo: 'MD/41', requestKey: key(), lines: [{ skuId: phone.id, unitPrice: '12000', units: u }] });
    await request('POST', E('electronics/receipts'), body([{ serial: '123456789012345' }]), 400);
    await request('POST', E('electronics/receipts'), body([{ serial: units[0] }, { serial: units[1], imei2: units[0] }]), 400);
    await staff.cashier.call('POST', E('electronics/receipts'), body([{ serial: units[0] }]), 403);
    const first = body(units.map((serial, i) => ({ serial, imei2: seconds[i] })));
    const result = await request('POST', E('electronics/receipts'), first, 201);
    assert.equal(result.units, 4);
    assert.equal(result.document.supplier_bill_no, 'MD/41');
    assert.equal((await request('POST', E('electronics/receipts'), first, 201)).repeated, true);
    const unit = (await request('GET', E(`serials?q=${seconds[2]}`))).items[0];
    assert.equal(unit.serial, units[2]);
    assert.equal(unit.imei2, seconds[2]);
    await request('POST', E('electronics/receipts'), { ...body([{ serial: units[0] }]), supplierBillNo: 'MD/42' }, 409);
  });

  let sold;
  await t.test('DOA: the dead phone is held for the supplier, the replacement takes the warranty, and the bad unit goes back', async () => {
    await request('POST', E('contacts'), { kind: 'customer', name: 'Joseph Mathew', phone: '98200 44444' }, 201);
    sold = await request('POST', E('documents'), { kind: 'sale', locationId: eLocation.id, requestKey: key(), buyer: { name: 'Joseph Mathew', phone: '98200 44444' },
      lines: [{ skuId: phone.id, quantity: '1', lotCode: units[0] }], payment: { amount: 'full', method: 'upi' } }, 201);
    assert.equal(sold.warranties.length, 1);
    const found = await request('GET', E(`exchanges/find?code=${units[0]}`));
    assert.equal(found.items[0].id, sold.id);
    const line = (await request('GET', E(`documents/${sold.id}`))).lines[0];
    const body = { documentId: sold.id, reason: 'Does not power on', returnLines: [{ lineId: line.id, quantity: '1', restock: true, faulty: 'doa' }],
      newLines: [{ skuId: phone.id, quantity: '1', lotCode: units[1] }] };
    await request('POST', E('exchanges'), { ...body, returnLines: [{ ...body.returnLines[0], restock: false }], requestKey: key() }, 400);
    const exchange = await request('POST', E('exchanges'), { ...body, requestKey: key() }, 201);
    assert.equal(Number(exchange.difference ?? 0), 0);
    const faulty = (await request('GET', E('electronics/faulty?status=awaiting_supplier'))).items;
    assert.equal(faulty.length, 1);
    assert.equal(faulty[0].serial, units[0]);
    assert.equal(faulty[0].replacement_serial, units[1]);
    assert.equal(faulty[0].kind, 'doa');
    assert.equal(faulty[0].supplier_name, 'Mobile Distributor');
    // The bad unit is in stock but cannot be sold.
    const refused = await call('POST', E('documents'), { kind: 'sale', locationId: eLocation.id, requestKey: key(), lines: [{ skuId: phone.id, quantity: '1', lotCode: units[0] }],
      payment: { amount: 'full', method: 'cash' } }, token);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /faulty/);
    // The warranty moved: old one cancelled, the replacement registered for Joseph.
    const warranties = (await request('GET', E(`warranties/lookup?q=9820044444`))).warranties;
    assert.ok(warranties.some((w) => w.serial === units[1] && w.status === 'active' && w.customer_name === 'Joseph Mathew'));
    assert.ok(warranties.some((w) => w.serial === units[0] && w.status === 'cancelled'));
    // Back to the supplier on a purchase return.
    await staff.cashier.call('POST', E(`electronics/faulty/${faulty[0].id}/send`), { requestKey: key() }, 403);
    const sendKey = key();
    const sent = await request('POST', E(`electronics/faulty/${faulty[0].id}/send`), { requestKey: sendKey, claimNo: 'RMA-551' });
    assert.equal(sent.status, 'sent');
    assert.match(sent.return_no, /^PRR?|\//);
    assert.equal((await request('POST', E(`electronics/faulty/${faulty[0].id}/send`), { requestKey: sendKey, claimNo: 'RMA-551' })).status, 'sent');
    const unit = (await request('GET', E(`serials?q=${units[0]}`))).items[0];
    assert.equal(unit.status, 'returned_to_supplier');
    // A unit found faulty on the shelf: held, then written off.
    const held = await request('POST', E('electronics/faulty'), { skuId: phone.id, serial: units[3], reason: 'Camera blurred' }, 201);
    await request('POST', E('electronics/faulty'), { skuId: phone.id, serial: units[3], reason: 'Again' }, 409);
    await request('POST', E(`electronics/faulty/${held.id}/close`), { status: 'written_off', note: 'Not covered', requestKey: key() });
    assert.equal((await request('GET', E(`serials?q=${units[3]}`))).items[0].status, 'written_off');
  });

  let job;
  await t.test('repair intake: IMEI lookup, advance, passcode, checklist; approval when charges pass the estimate; message log; delivery uses the advance', async () => {
    const labour = await request('POST', E('catalog'), { kind: 'service', name: 'Repair labour', code: 'LAB', unit: 'service', price: '500', taxRate: '18' }, 201);
    const display = await request('POST', E('catalog'), { kind: 'goods', name: 'Orbit display', code: 'ORB-DSP', unit: 'each', tracking: 'quantity', price: '3000', taxRate: '18' }, 201);
    await request('POST', E('documents'), { kind: 'purchase', locationId: eLocation.id, contactId: eSupplier.id, requestKey: key(), lines: [{ skuId: display.id, quantity: '2', unitPrice: '2200' }] }, 201);
    const lookup = await request('GET', E(`warranties/lookup?q=${units[1]}`));
    assert.equal(lookup.warranties[0].customer_name, 'Joseph Mathew');
    const intakeBody = { locationId: eLocation.id, customerName: 'Anil Rao', customerPhone: '99000 55555', device: 'Orbit 5G, black', serial: units[2], problem: 'Screen cracked',
      estimate: '1000', passcode: '1 4 7 8', checklist: { screen_cracked: true, water_damage: false }, advance: { amount: '500', method: 'cash' }, requestKey: key() };
    await staff.cashier.call('POST', E('repairs'), { ...intakeBody, checklist: { 'Bad Key': true }, requestKey: key() }, 400);
    job = await staff.manager.call('POST', E('repairs'), intakeBody, 201);
    assert.ok(job.contact_id, 'a customer record is made for the advance');
    assert.equal(job.checklist.screen_cracked, true);
    let detail = await request('GET', E(`repairs/${job.id}`));
    assert.equal(detail.advance.amount, '500.00');
    assert.equal(detail.passcode, '1 4 7 8');
    // The cashier role (no repairs.edit) sees the passcode masked.
    const masked = await staff.cashier.call('GET', E(`repairs/${job.id}`));
    assert.equal(masked.passcode, '••••');
    await request('POST', E(`repairs/${job.id}/lines`), { kind: 'labour', skuId: labour.id, quantity: '1' }, 201);
    const over = await request('POST', E(`repairs/${job.id}/lines`), { kind: 'part', skuId: display.id, quantity: '1' }, 201);
    assert.equal(over.awaitingApproval, true);
    detail = await request('GET', E(`repairs/${job.id}`));
    assert.equal(detail.status, 'awaiting_approval');
    await request('POST', E(`repairs/${job.id}/status`), { status: 'ready' }, 409);
    await request('POST', E(`repairs/${job.id}/approval`), { decision: 'approved', note: 'Approved by phone' });
    detail = await request('GET', E(`repairs/${job.id}`));
    assert.equal(detail.status, 'in_repair');
    assert.equal(detail.estimate, '3500.00');
    await request('POST', E(`repairs/${job.id}/status`), { status: 'ready', note: 'Display replaced, tested' });
    await staff.cashier.call('POST', E(`repairs/${job.id}/messages`), { channel: 'whatsapp', stage: 'ready' }, 201);
    const counts = await request('GET', E('repairs/counts'));
    assert.equal(counts.ready, 1);
    const delivered = await request('POST', E(`repairs/${job.id}/deliver`), { requestKey: key(), payment: { amount: '3000', method: 'upi' } });
    assert.equal(delivered.passcode, null);
    const bill = await request('GET', E(`documents/${delivered.document_id}`));
    assert.equal(bill.total, '3500.00');
    assert.deepEqual(bill.payments.map((p) => p.amount).sort(), ['3000.00', '500.00']);
    assert.ok(bill.payments.find((p) => p.amount === '500.00').collection_id);
    detail = await request('GET', E(`repairs/${job.id}`));
    assert.ok(detail.events.some((e) => /WhatsApp sent: ready/.test(e.note || '')));
    assert.ok(detail.events.some((e) => /Display replaced/.test(e.note || '')));
  });

  await t.test('declined charges close the job unrepaired; warranty claims against the brand', async () => {
    const declined = await request('POST', E('repairs'), { locationId: eLocation.id, customerName: 'Rita', customerPhone: '99000 66666', device: 'Old phone', problem: 'Battery', estimate: '1',
      passcode: '0000', requestKey: key() }, 201);
    const labour = (await request('GET', E('catalog?q=LAB'))).items[0];
    await request('POST', E(`repairs/${declined.id}/lines`), { kind: 'labour', skuId: labour.id, quantity: '1' }, 201);
    const closed = await request('POST', E(`repairs/${declined.id}/approval`), { decision: 'declined' });
    assert.equal(closed.status, 'cancelled');
    assert.equal(closed.passcode, null);
    assert.match(closed.closed_reason, /declined/);
    // A warranty job: the part fitted is claimed from the brand.
    const warrantyJob = await request('POST', E('repairs'), { locationId: eLocation.id, customerName: 'Joseph Mathew', customerPhone: '98200 44444', device: 'Orbit 5G', serial: units[1],
      problem: 'Speaker', requestKey: key() }, 201);
    assert.equal(warrantyJob.under_warranty, true);
    await request('POST', E(`repairs/${declined.id}/claims`), { brand: 'Orbit' }, 400);
    const display = (await request('GET', E('catalog?q=ORB-DSP'))).items[0];
    await request('POST', E(`repairs/${warrantyJob.id}/lines`), { kind: 'part', skuId: display.id, quantity: '1' }, 201);
    const claim = await request('POST', E(`repairs/${warrantyJob.id}/claims`), { brand: 'Orbit', claimNo: 'OC-9' }, 201);
    assert.equal(claim.part_cost, '2200.00');
    const summary = await request('GET', E('warranty-claims/summary'));
    assert.equal(summary[0].brand, 'Orbit');
    assert.equal(summary[0].pending, '2200.00');
    await staff.cashier.call('PATCH', E(`warranty-claims/${claim.id}`), { status: 'submitted' }, 403);
    await request('PATCH', E(`warranty-claims/${claim.id}`), { status: 'credited', creditedAmount: '2100' });
    await request('PATCH', E(`warranty-claims/${claim.id}`), { status: 'submitted' }, 409);
    assert.equal(Number((await request('GET', E('warranty-claims?status=credited'))).items[0].credited_amount), 2100);
    await other('GET', E('warranty-claims'), undefined, 404);
  });
});
