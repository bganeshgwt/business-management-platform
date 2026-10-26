const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const dates = require('./helpers/dates');
const { withTools } = require('./helpers/tools');
const { signIn } = require('./helpers/signIn');

// Fashion and electronics: the size × colour matrix, variant
// reports, exchanges (return + new sale, difference paid or refunded), the
// serial / IMEI lifecycle across locations, warranty registration and lookup,
// and repair jobs. Runs against its own throwaway database with every
// migration applied.
test('fashion and electronics: variants, exchanges, serials, warranties, repairs', { timeout: 300000 }, async (t) => {
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('fe-owner');
  await owner('fe-other');
  const token = await login('fe-owner@test.invalid');
  const otherToken = await login('fe-other@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return expected < 300 ? result.body.data : result.body;
  };
  const request = as(token);
  const other = as(otherToken);
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const count = async (sql, values) => (await one(sql, values)).n;

  const [fz, el, grocery] = await withTools(request, await createBusinesses(request, 'OWNER', ['fashion', 'electronics', 'grocery']));
  const [otherFz, otherEl] = await withTools(other, await createBusinesses(other, 'OTHER', ['fashion', 'electronics']));
  // Goods shops start with prices including GST, rounded to the rupee, and a
  // walk-in pays in full. These checks use prices before GST and post unpaid
  // walk-in bills as fixtures.
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none', walk_in_credit=true");
  const F = (suffix) => `/businesses/${fz.id}/${suffix}`;
  const E = (suffix) => `/businesses/${el.id}/${suffix}`;

  await t.test('modules: fashion gets variants and exchanges, electronics gets serials, warranties and repairs', async () => {
    assert.ok(['variants', 'exchanges'].every((m) => fz.capabilities.includes(m)));
    assert.ok(['serials', 'warranties', 'repairs'].every((m) => el.capabilities.includes(m)));
    assert.ok(!grocery.capabilities.includes('exchanges') && !grocery.capabilities.includes('variants'));
    await request('GET', `/businesses/${grocery.id}/fashion/products`, undefined, 403);
    await request('GET', F('repairs'), undefined, 403);
    await request('GET', F('warranties'), undefined, 403);
    await request('PUT', `/businesses/${grocery.id}/modules/repairs`, { enabled: true }, 409);
    // Warranties need serials: switching serials off while warranties are on is refused.
    await request('PUT', E('modules/serials'), { enabled: false }, 409);
    const series = await count("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='business_number_series_document_kind_check' AND pg_get_constraintdef(oid) LIKE '%sales_order%collection%repair_job%'");
    assert.equal(series, 1);
    const cashier = await one("SELECT array_agg(permission_code ORDER BY permission_code) AS p FROM business_role_permissions rp JOIN business_roles r ON r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code='cashier' AND (permission_code LIKE 'exchanges.%' OR permission_code LIKE 'repairs.%' OR permission_code LIKE 'warranties.%')", [el.id]);
    assert.deepEqual(cashier.p, ['exchanges.create', 'exchanges.view', 'repairs.approve', 'repairs.create', 'repairs.print', 'repairs.view', 'warranties.create', 'warranties.print', 'warranties.view']);
  });

  // Staff with template roles in both businesses.
  const staff = {};
  for (const business of [fz, el]) {
    const roles = (await request('GET', `/businesses/${business.id}/roles`)).items;
    for (const template of ['manager', 'cashier', 'stock_keeper', 'viewer']) {
      const email = `fe-${business.business_type}-${template}@test.invalid`;
      const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, `${business.business_type} ${template}`, email, hash]);
      await request('POST', `/businesses/${business.id}/members`, { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
      staff[`${business.business_type}_${template}`] = as(await login(email));
    }
  }
  const fzLocation = (await request('GET', F('locations'))).items[0];
  const slabs = (await request('GET', F('tax-rates'))).items;
  const gst5 = slabs.find((s) => Number(s.rate) === 5);
  const supplier = await request('POST', F('contacts'), { kind: 'supplier', name: 'Tiruppur Knits (fictional)' }, 201);
  const priya = await request('POST', F('contacts'), { kind: 'customer', name: 'Priya Nair', phone: '98450 11111' }, 201);
  const eanOk = (code) => {
    const digits = [...code].map(Number);
    return /^\d{13}$/.test(code) && (10 - (digits.slice(0, 12).reduce((s, d, i) => s + d * (i % 2 ? 3 : 1), 0) % 10)) % 10 === digits[12];
  };

  let shirt, matrix;
  const cell = (size, color) => matrix.variants.find((x) => x.size === size && x.color === color);
  await t.test('size × colour matrix: one SKU per variant with its own code, barcode and price', async () => {
    shirt = (await request('POST', F('fashion/products'), { name: 'Oxford shirt', brand: 'Demo Mills', codePrefix: 'OXF', price: '999', taxRateId: gst5.id,
      sizes: ['L', 'S', 'M', 'XXL'], colors: ['Sky blue', 'White'], sizePrices: { XXL: '1099' }, barcodes: { 'white|m|': '8901234567897' } }, 201)).product;
    matrix = await request('GET', F(`fashion/products/${shirt.id}`));
    assert.deepEqual(matrix.sizes, ['S', 'M', 'L', 'XXL'], 'sizes read S, M, L, XXL');
    assert.deepEqual(matrix.colors, ['Sky blue', 'White']);
    assert.equal(matrix.variants.length, 8);
    assert.equal(cell('XXL', 'White').price, '1099.00');
    assert.equal(cell('M', 'White').barcode, '8901234567897');
    assert.equal(cell('S', 'Sky blue').code, 'OXF-SKY-S');
    assert.ok(matrix.variants.filter((x) => x.barcode !== '8901234567897').every((x) => eanOk(x.barcode)), 'generated barcodes are valid EAN-13');
    assert.equal(new Set(matrix.variants.map((x) => x.barcode)).size, 8);
    const sku = await one('SELECT attributes,label FROM catalog_skus WHERE business_id=$1 AND id=$2', [fz.id, cell('L', 'White').sku_id]);
    assert.deepEqual(sku.attributes, { size: 'L', color: 'White' });
    assert.equal(sku.label, 'Oxford shirt · White / L');
    // More colours: only the missing combinations are created, at each size's price.
    const added = await request('POST', F(`fashion/products/${shirt.id}/variants`), { colors: ['Navy'] }, 201);
    assert.equal(added.created, 4);
    await request('POST', F(`fashion/products/${shirt.id}/variants`), { colors: ['navy'] }, 409);
    matrix = await request('GET', F(`fashion/products/${shirt.id}`));
    assert.equal(cell('XXL', 'Navy').price, '1099.00');
    // A new size needs a price unless one is given for it.
    await request('POST', F(`fashion/products/${shirt.id}/variants`), { sizes: ['3XL'] }, 400);
    await request('POST', F(`fashion/products/${shirt.id}/variants`), { sizes: ['3XL'], sizePrices: { '3XL': '1149' } }, 201);
    // One price for every variant of a size.
    assert.equal((await request('PUT', F(`fashion/products/${shirt.id}/prices`), { sizes: ['S'], price: '949' })).updated, 3);
    matrix = await request('GET', F(`fashion/products/${shirt.id}`));
    assert.equal(cell('S', 'Navy').price, '949.00');
    assert.deepEqual(matrix.sizes, ['S', 'M', 'L', 'XXL', '3XL']);
    // A code prefix already used, and a barcode on another item, are refused.
    await request('POST', F('fashion/products'), { name: 'Copy', codePrefix: 'OXF', price: '1', sizes: ['S'], colors: ['Sky blue'] }, 409);
    await request('POST', F('fashion/products'), { name: 'Copy', codePrefix: 'CPY', price: '1', sizes: ['S'], colors: ['Red'], barcodes: { 'red|s|': '8901234567897' } }, 409);
    await request('POST', F('fashion/products'), { name: 'No sizes', price: '1', sizes: [], colors: ['Red'] }, 400);
    const list = await request('GET', F('fashion/products?q=oxford'));
    assert.equal(list.total, 1);
    assert.equal(list.items[0].variant_count, 15);
    // The database keeps one variant per combination and to its own product.
    await assert.rejects(pool.query('INSERT INTO fashion_variants(business_id,sku_id,product_id,size,color) VALUES($1,$2,$3,$4,$5)', [fz.id, cell('S', 'Navy').sku_id, shirt.id, 's', 'NAVY']), /duplicate key|fashion_variants/);
    const otherProduct = await one("INSERT INTO catalog_products(business_id,name,kind) VALUES($1,'Other','goods') RETURNING id", [fz.id]);
    await assert.rejects(pool.query('UPDATE fashion_variants SET product_id=$3 WHERE business_id=$1 AND sku_id=$2', [fz.id, cell('S', 'Navy').sku_id, otherProduct.id]), /its own product/);
  });

  await t.test('matrix permissions and isolation', async () => {
    await staff.fashion_cashier('POST', F('fashion/products'), { name: 'X', price: '1', sizes: ['S'], colors: ['Red'] }, 403);
    await staff.fashion_viewer('GET', F(`fashion/products/${shirt.id}`));
    await staff.fashion_viewer('PUT', F(`fashion/products/${shirt.id}/prices`), { price: '1' }, 403);
    await staff.fashion_stock_keeper('POST', F(`fashion/products/${shirt.id}/variants`), { colors: ['Olive'] }, 201);
    // Another owner: not a member here (404), and our product is not in their business (404).
    await other('GET', F(`fashion/products/${shirt.id}`), undefined, 404);
    await other('GET', `/businesses/${otherFz.id}/fashion/products/${shirt.id}`, undefined, 404);
    await other('POST', `/businesses/${otherFz.id}/fashion/products/${shirt.id}/variants`, { colors: ['Red'] }, 404);
  });

  let paidSale;
  await t.test('stock and sales at variant level; the variant report', async () => {
    matrix = await request('GET', F(`fashion/products/${shirt.id}`));
    // Receive by the matrix: an ordinary purchase, one line per variant.
    const lines = matrix.variants.filter((x) => ['Sky blue', 'White'].includes(x.color)).map((x) => ({ skuId: x.sku_id, quantity: x.size === 'M' ? '10' : '4', unitPrice: '520' }));
    await request('POST', F('documents'), { kind: 'purchase', locationId: fzLocation.id, contactId: supplier.id, requestKey: key(), lines }, 201);
    matrix = await request('GET', F(`fashion/products/${shirt.id}`));
    assert.equal(Number(cell('M', 'White').stock), 10);
    assert.equal(Number(cell('M', 'Navy').stock), 0);
    paidSale = await request('POST', F('documents'), { kind: 'sale', locationId: fzLocation.id, contactId: priya.id, requestKey: key(),
      lines: [{ skuId: cell('M', 'Sky blue').sku_id, quantity: '2' }, { skuId: cell('L', 'White').sku_id, quantity: '1' }],
      payment: { amount: '0', method: 'cash' } }, 201);
    await request('POST', F(`documents/${paidSale.id}/payments`), { amount: paidSale.total, method: 'upi', requestKey: key() }, 201);
    const today = dates.today();
    const report = await request('GET', F(`fashion/reports/variants?from=${dates.monthStart()}&to=${today}&productId=${shirt.id}`));
    const row = report.items.find((r) => r.sku_id === cell('M', 'Sky blue').sku_id);
    assert.equal(Number(row.net_qty), 2);
    assert.equal(Number(row.stock_qty), 8);
    assert.equal(row.net_sales, '1998.00');
    assert.equal(row.sell_through, 20);
    const m = report.bySize.find((s) => s.key === 'M');
    assert.equal(Number(m.net_qty), 2);
    assert.equal(Number(m.stock_qty), 18);
    assert.deepEqual(report.bySize.map((s) => s.key), ['S', 'M', 'L', 'XXL', '3XL']);
    assert.equal(report.byColor.find((c) => c.key === 'White').net_sales, '999.00');
    await request('GET', F('fashion/reports/variants?from=2026-01-01&to=2027-06-01'), undefined, 400);
    await staff.fashion_stock_keeper('GET', F(`fashion/reports/variants?from=${today}&to=${today}`), undefined, 403);
  });

  const stockOf = async (skuId) => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [fz.id, skuId])).q);
  const docSums = async (documentId) => one(`SELECT
    COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
    COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
    COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded,
    (SELECT total FROM business_documents WHERE business_id=$1 AND id=$2) AS total`, [fz.id, documentId]);
  const owed = (s) => paise(s.total) - paise(s.returned) - paise(s.paid) + paise(s.refunded);

  await t.test('exchange: same price — the credit note pays the new bill, no money changes hands', async () => {
    const detail = await request('GET', F(`documents/${paidSale.id}`));
    const mLine = detail.lines.find((l) => l.sku_id === cell('M', 'Sky blue').sku_id);
    const body = { documentId: paidSale.id, reason: 'Size too small', returnLines: [{ lineId: mLine.id, quantity: '1' }], newLines: [{ skuId: cell('L', 'Sky blue').sku_id, quantity: '1' }] };
    const documents = await count('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1', [fz.id]);
    const quote = await request('POST', F('exchanges/quote'), body);
    assert.equal(quote.difference, '0.00');
    assert.equal(quote.due, '0.00');
    assert.equal(await count('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1', [fz.id]), documents, 'a quote saves nothing');
    const before = { m: await stockOf(cell('M', 'Sky blue').sku_id), l: await stockOf(cell('L', 'Sky blue').sku_id) };
    const exchangeKey = key();
    const exchange = await staff.fashion_cashier('POST', F('exchanges'), { ...body, requestKey: exchangeKey }, 201);
    assert.equal(exchange.credit_applied, exchange.new_value);
    assert.equal(exchange.collected, '0.00');
    assert.equal(exchange.method, null);
    assert.equal(await stockOf(cell('M', 'Sky blue').sku_id), before.m + 1, 'the returned shirt is back in stock');
    assert.equal(await stockOf(cell('L', 'Sky blue').sku_id), before.l - 1);
    const original = await docSums(paidSale.id), replacement = await docSums(exchange.new_document_id);
    assert.equal(owed(original), 0);
    assert.equal(owed(replacement), 0, 'the new bill is settled by the credit note');
    const moved = await one("SELECT method,reference FROM business_payments WHERE business_id=$1 AND document_id=$2", [fz.id, exchange.new_document_id]);
    assert.deepEqual(moved, { method: 'credit_note', reference: exchange.return_no });
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='exchange.posted' AND entity_id=$2", [fz.id, exchange.id]));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='exchange.posted' AND entity_id=$2", [fz.id, exchange.id]));
    // A retry with the same key returns the same exchange; different content is a conflict.
    assert.equal((await staff.fashion_cashier('POST', F('exchanges'), { ...body, requestKey: exchangeKey }, 201)).id, exchange.id);
    await staff.fashion_cashier('POST', F('exchanges'), { ...body, reason: 'Other', requestKey: exchangeKey }, 409);
    const listed = await request('GET', F(`exchanges?q=${encodeURIComponent(exchange.return_no)}`));
    assert.equal(listed.total, 1);
    // The ledger: every lot still equals the sum of its movements.
    const drift = await one(`SELECT count(*)::int AS n FROM business_stock_lots l WHERE l.business_id=$1 AND l.quantity <>
      COALESCE((SELECT sum(quantity) FROM business_stock_movements m WHERE m.business_id=l.business_id AND m.lot_id=l.id),0)`, [fz.id]);
    assert.equal(drift.n, 0);
  });

  await t.test('exchange: dearer item — the difference is collected; a walk-in pays it all', async () => {
    const walkIn = await request('POST', F('documents'), { kind: 'sale', locationId: fzLocation.id, requestKey: key(), lines: [{ skuId: cell('S', 'White').sku_id, quantity: '1' }], payment: { amount: '996.45', method: 'cash' } }, 201);
    assert.equal(walkIn.total, '996.45');
    const line = (await request('GET', F(`documents/${walkIn.id}`))).lines[0];
    const body = { documentId: walkIn.id, reason: 'Wants the XXL', returnLines: [{ lineId: line.id, quantity: '1' }], newLines: [{ skuId: cell('XXL', 'White').sku_id, quantity: '1' }] };
    const quote = await request('POST', F('exchanges/quote'), body);
    assert.equal(quote.walkIn, true);
    // 1099 + 5% = 1153.95 less the paid 996.45 credit = 157.50 due.
    assert.equal(quote.due, '157.50');
    await request('POST', F('exchanges'), { ...body, requestKey: key(), settlement: { method: 'cash', amount: '100' } }, 400);
    await request('POST', F('exchanges'), { ...body, requestKey: key() }, 400);
    const exchange = await request('POST', F('exchanges'), { ...body, requestKey: key(), settlement: { method: 'upi', reference: 'UPI-77' } }, 201);
    assert.equal(exchange.collected, '157.50');
    assert.equal(exchange.method, 'upi');
    assert.equal(owed(await docSums(exchange.new_document_id)), 0);
  });

  await t.test('exchange: cheaper item — the rest is refunded only by someone who may refund', async () => {
    const sale = await request('POST', F('documents'), { kind: 'sale', locationId: fzLocation.id, requestKey: key(), lines: [{ skuId: cell('XXL', 'Sky blue').sku_id, quantity: '1' }], payment: { amount: '1153.95', method: 'card' } }, 201);
    const line = (await request('GET', F(`documents/${sale.id}`))).lines[0];
    const body = { documentId: sale.id, reason: 'Too big', returnLines: [{ lineId: line.id, quantity: '1' }], newLines: [{ skuId: cell('S', 'Sky blue').sku_id, quantity: '1' }] };
    const quote = await request('POST', F('exchanges/quote'), body);
    assert.equal(quote.excess, String(((paise('1153.95') - paise('996.45')) / 100).toFixed(2)));
    const stock = await stockOf(cell('XXL', 'Sky blue').sku_id);
    const returnsBefore = await count('SELECT count(*)::int AS n FROM business_returns WHERE business_id=$1', [fz.id]);
    // A cashier may exchange but not refund money: nothing at all is saved.
    const refused = await staff.fashion_cashier('POST', F('exchanges'), { ...body, requestKey: key(), settlement: { method: 'cash' } }, 403);
    assert.match(refused.message, /refund/i);
    assert.equal(await stockOf(cell('XXL', 'Sky blue').sku_id), stock);
    assert.equal(await count('SELECT count(*)::int AS n FROM business_returns WHERE business_id=$1', [fz.id]), returnsBefore);
    // A walk-in cannot keep it on account.
    await request('POST', F('exchanges'), { ...body, requestKey: key(), settlement: { method: 'on_account' } }, 400);
    const exchange = await staff.fashion_manager('POST', F('exchanges'), { ...body, requestKey: key(), settlement: { method: 'cash' } }, 201);
    assert.equal(exchange.refunded, quote.excess);
    const original = await docSums(sale.id);
    assert.equal(paise(original.refunded), paise(quote.excess) + paise(exchange.credit_applied));
  });

  await t.test('exchange: a known customer may leave a surplus on account; policy days; over-returns', async () => {
    const sale = await request('POST', F('documents'), { kind: 'sale', locationId: fzLocation.id, contactId: priya.id, requestKey: key(), lines: [{ skuId: cell('XXL', 'White').sku_id, quantity: '1' }], payment: { amount: '1153.95', method: 'cash' } }, 201);
    const line = (await request('GET', F(`documents/${sale.id}`))).lines[0];
    const body = { documentId: sale.id, reason: 'Exchange for smaller', returnLines: [{ lineId: line.id, quantity: '1' }], newLines: [{ skuId: cell('M', 'White').sku_id, quantity: '1' }] };
    // Over-return is refused and leaves nothing behind.
    await request('POST', F('exchanges'), { ...body, returnLines: [{ lineId: line.id, quantity: '2' }], requestKey: key(), settlement: { method: 'on_account' } }, 409);
    const exchange = await request('POST', F('exchanges'), { ...body, requestKey: key(), settlement: { method: 'on_account' } }, 201);
    assert.equal(exchange.method, 'on_account');
    assert.equal(exchange.refunded, '0.00');
    const balance = await one(`SELECT ${require('../../src/modules/business/core/repositories/business.repository').contactBalanceSql('c')} AS b FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [fz.id, priya.id]);
    assert.ok(Number(balance.b) < 0, 'the customer has credit on account');
    // The kept credit is an advance (a credit-note collection), spendable on a
    // later bill even though this fashion business has receivables switched off.
    assert.ok(fz.capabilities.includes('receivables'), 'every goods counter can collect udhaar');
    const kept = await one('SELECT * FROM business_collections WHERE business_id=$1 AND id=$2', [fz.id, exchange.credit_collection_id]);
    assert.equal(kept.method, 'credit_note');
    assert.equal(kept.amount, '105.00');
    assert.equal(kept.contact_id, priya.id);
    const credits = await staff.fashion_cashier('GET', F('exchanges/credits'));
    assert.equal(credits.find((c) => c.contact_id === priya.id).credit, '105.00');
    const later = await request('POST', F('documents'), { kind: 'sale', locationId: fzLocation.id, contactId: priya.id, requestKey: key(), lines: [{ skuId: cell('M', 'White').sku_id, quantity: '1' }] }, 201);
    // Reports: store credit is no money in when it is kept, only when a bill uses it.
    const day = (await one("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d")).d;
    const collected = async () => paise((await request('GET', F(`reports?from=${day}&to=${day}`))).rows.filter((r) => r.kind === 'sale_payment').reduce((s, r) => s + Number(r.total), 0));
    const beforeUse = await collected();
    assert.equal(beforeUse, paise((await one("SELECT COALESCE(sum(p.amount),0) AS s FROM business_payments p JOIN business_documents d ON d.id=p.document_id WHERE p.business_id=$1 AND d.kind='sale' AND p.method<>'finance' AND p.collection_id IS NULL", [fz.id])).s)
      + paise((await one("SELECT COALESCE(sum(amount),0) AS s FROM business_collections WHERE business_id=$1 AND method<>'credit_note'", [fz.id])).s));
    await staff.fashion_viewer('POST', F(`exchanges/credits/${priya.id}/use`), { requestKey: key() }, 403);
    const useKey = key();
    const used = await staff.fashion_cashier('POST', F(`exchanges/credits/${priya.id}/use`), { requestKey: useKey }, 201);
    assert.equal(used.applied, '105.00');
    assert.equal((await staff.fashion_cashier('POST', F(`exchanges/credits/${priya.id}/use`), { requestKey: useKey }, 201)).repeated, true);
    assert.equal(owed(await docSums(later.id)), paise(later.total) - 10500);
    const pay = await one('SELECT method,collection_id FROM business_payments WHERE business_id=$1 AND document_id=$2', [fz.id, later.id]);
    assert.deepEqual(pay, { method: 'credit_note', collection_id: kept.id });
    assert.equal(await collected(), beforeUse + 10500, 'the credit counts once, when the bill uses it');
    await staff.fashion_cashier('POST', F(`exchanges/credits/${priya.id}/use`), { requestKey: key() }, 409);
    const after = await one(`SELECT ${require('../../src/modules/business/core/repositories/business.repository').contactBalanceSql('c')} AS b FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [fz.id, priya.id]);
    assert.equal(paise(after.b), paise(balance.b) + paise(later.total), 'using the credit does not change what the customer owes overall');
    await other('POST', `/businesses/${otherFz.id}/exchanges/credits/${priya.id}/use`, { requestKey: key() }, 404);
    // Policy: within 1 day; a sale from 5 days ago is refused.
    await staff.fashion_cashier('PUT', F('exchanges/policy'), { daysAllowed: 1 }, 403);
    await request('PUT', F('exchanges/policy'), { daysAllowed: 1 });
    const old = await request('POST', F('documents'), { kind: 'sale', locationId: fzLocation.id, requestKey: key(), lines: [{ skuId: cell('L', 'White').sku_id, quantity: '1' }], payment: { amount: '1048.95', method: 'cash' } }, 201);
    await pool.query("UPDATE business_documents SET created_at=now()-interval '5 days' WHERE business_id=$1 AND id=$2", [fz.id, old.id]);
    const oldLine = (await request('GET', F(`documents/${old.id}`))).lines[0];
    const late = await request('POST', F('exchanges/quote'), { documentId: old.id, returnLines: [{ lineId: oldLine.id, quantity: '1' }], newLines: [{ skuId: cell('L', 'Sky blue').sku_id, quantity: '1' }] }, 409);
    assert.match(late.message, /within 1 day of the sale/);
    assert.equal((await request('PUT', F('exchanges/policy'), { daysAllowed: null })).daysAllowed, null);
    // Another business's sale is not found from here; others cannot see our exchanges.
    await other('POST', `/businesses/${otherFz.id}/exchanges/quote`, body, 404);
    await other('GET', F(`exchanges/${exchange.id}`), undefined, 404);
    await staff.fashion_viewer('POST', F('exchanges/quote'), body, 403);
    await staff.fashion_viewer('GET', F(`exchanges/${exchange.id}`));
    // An exchange is never edited.
    await assert.rejects(pool.query("UPDATE business_exchanges SET reason='x' WHERE id=$1", [exchange.id]), /cannot be changed/);
  });

  // --- Electronics -------------------------------------------------------------------------
  const imei = (body14) => {
    const total = [...body14].reduce((sum, c, i) => { let d = Number(c); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } return sum + d; }, 0);
    return body14 + ((10 - (total % 10)) % 10);
  };
  const imeis = ['35209900176148', '35209900176149', '35209900176150', '35209900176151', '35209900176152'].map(imei);
  const elMain = (await request('GET', E('locations'))).items[0];
  const centre = await request('POST', E('locations'), { name: 'Service centre', code: 'SC' }, 201);
  const elSupplier = await request('POST', E('contacts'), { kind: 'supplier', name: 'Mobile World Distributors (fictional)' }, 201);
  const ravi = await request('POST', E('contacts'), { kind: 'customer', name: 'Ravi Shankar', phone: '+91 98860 22222' }, 201);
  const phone = await request('POST', E('catalog'), { name: 'Demo phone 5G 128 GB', code: 'DP5G', kind: 'goods', unit: 'each', tracking: 'serial', price: '15999', taxRate: '18' }, 201);
  const glass = await request('POST', E('catalog'), { name: 'Screen glass', code: 'GLASS', kind: 'goods', unit: 'each', tracking: 'quantity', price: '499', taxRate: '18' }, 201);
  const display = await request('POST', E('catalog'), { name: 'Display unit (spare)', code: 'DISP', kind: 'goods', unit: 'each', tracking: 'quantity', price: '3500', taxRate: '18' }, 201);
  const labour = await request('POST', E('catalog'), { name: 'Repair labour', code: 'LAB', kind: 'service', unit: 'service', price: '300', taxRate: '18' }, 201);

  let sale;
  await t.test('serials: IMEI checked on receipt, one unit in one place, lifecycle across locations', async () => {
    await request('PUT', E(`electronics/models/${phone.id}`), { modelNumber: 'DP-5G', serialKind: 'imei', warrantyMonths: 12, warrantyTerms: 'Manufacturing defects only.' });
    await request('PUT', E(`electronics/models/${glass.id}`), { serialKind: 'imei' }, 400);
    await staff.electronics_cashier('PUT', E(`electronics/models/${phone.id}`), { serialKind: 'serial' }, 403);
    const bad = await request('POST', E('documents'), { kind: 'purchase', locationId: elMain.id, contactId: elSupplier.id, requestKey: key(),
      lines: [{ skuId: phone.id, quantity: '1', unitPrice: '12000', lotCode: '352099001761480' }] }, 409);
    assert.match(bad.message, /not valid/);
    await request('POST', E('documents'), { kind: 'purchase', locationId: elMain.id, contactId: elSupplier.id, requestKey: key(),
      lines: imeis.map((code) => ({ skuId: phone.id, quantity: '1', unitPrice: '12000', lotCode: code })).concat([{ skuId: glass.id, quantity: '20', unitPrice: '150' }]) }, 201);
    // The same number under another item is refused by the database.
    const tablet = await request('POST', E('catalog'), { name: 'Demo tablet', code: 'TAB', kind: 'goods', unit: 'each', tracking: 'serial', price: '9999', taxRate: '18' }, 201);
    const clash = await request('POST', E('documents'), { kind: 'purchase', locationId: elMain.id, contactId: elSupplier.id, requestKey: key(),
      lines: [{ skuId: tablet.id, quantity: '1', unitPrice: '7000', lotCode: imeis[0] }] }, 409);
    assert.match(clash.message, /another item/);
    // Move one handset to the service centre: in transit, then in stock there.
    const lot = (await request('GET', E(`stock?sku=${phone.id}&q=${imeis[0]}`))).items[0];
    const transfer = await request('POST', E('transfers'), { fromLocationId: elMain.id, toLocationId: centre.id, requestKey: key(), lines: [{ lotId: lot.id, quantity: '1' }] }, 201);
    let unit = (await request('GET', E(`serials?q=${imeis[0]}`))).items[0];
    assert.equal(unit.status, 'in_transit');
    assert.equal(unit.location_name, 'Service centre');
    await request('POST', E(`transfers/${transfer.id}/receive`), {});
    unit = (await request('GET', E(`serials?q=${imeis[0]}`))).items[0];
    assert.equal(unit.status, 'in_stock');
    assert.equal(unit.location_id, centre.id);
    // The database refuses the same unit in stock at the main shop too.
    await assert.rejects(pool.query('UPDATE business_stock_lots SET quantity=1 WHERE business_id=$1 AND id=$2', [el.id, lot.id]), /already in stock at another location/);
    await assert.rejects(pool.query('UPDATE business_stock_lots SET quantity=2 WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND location_id=$4', [el.id, phone.id, imeis[0], centre.id]), /one unit/);
    // Sold from the service centre to Ravi.
    sale = await request('POST', E('documents'), { kind: 'sale', locationId: centre.id, contactId: ravi.id, requestKey: key(),
      lines: [{ skuId: phone.id, quantity: '1', lotCode: imeis[0] }, { skuId: glass.id, quantity: '1' }], payment: { amount: '0', method: 'cash' } }, 409);
    // (No glass at the service centre: the whole sale is refused.)
    sale = await request('POST', E('documents'), { kind: 'sale', locationId: centre.id, contactId: ravi.id, requestKey: key(), lines: [{ skuId: phone.id, quantity: '1', lotCode: imeis[0] }] }, 201);
    unit = (await request('GET', E(`serials?status=sold`))).items.find((u) => u.serial === imeis[0]);
    assert.equal(unit.customer_name, 'Ravi Shankar');
    assert.equal(unit.sold_no, sale.document_no);
    assert.equal((await request('GET', E('serials?status=in_stock'))).total, 4);
    const history = await request('GET', E(`serials/history?serial=${imeis[0]}`));
    assert.deepEqual(history.movements.map((m) => m.source), ['purchase', 'transfer', 'transfer', 'sale']);
    assert.equal(history.unit.received_no.startsWith('PR/'), true);
    // A second IMEI: checked, unique, and found by lookups.
    await request('PUT', E('serials/details'), { skuId: phone.id, serial: imeis[0], imei2: '123456789012345' }, 400);
    await request('PUT', E('serials/details'), { skuId: phone.id, serial: imeis[0], imei2: imeis[1] }, 409);
    const second = imei('35209900176199');
    await request('PUT', E('serials/details'), { skuId: phone.id, serial: imeis[0], imei2: second, note: 'Dual SIM' });
    assert.equal((await request('GET', E(`serials/history?serial=${second}`))).unit.serial, imeis[0]);
    await staff.electronics_cashier('PUT', E('serials/details'), { skuId: phone.id, serial: imeis[0], imei2: second }, 403);
    await other('GET', `/businesses/${otherEl.id}/serials/history?serial=${imeis[0]}`, undefined, 404);
  });

  let warranty;
  await t.test('warranties: registered from the sale, found by IMEI or phone, cancelled with a reason', async () => {
    // The sale registered the unit's warranty itself, to Ravi on file.
    // It is cancelled here so registering by hand can be checked too.
    assert.equal(sale.warranties?.length, 1);
    assert.equal(sale.warranties[0].serial, imeis[0]);
    await request('POST', E(`warranties/${sale.warranties[0].id}/cancel`), { reason: 'Checking registration by hand' });
    const eligible = await staff.electronics_cashier('GET', E(`warranties/eligible?q=${imeis[0]}`));
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].warranty_months, 12);
    const line = eligible[0];
    await staff.electronics_stock_keeper('POST', E('warranties'), { lineId: line.line_id, requestKey: key() }, 403);
    const tomorrow = dates.daysFrom(2);
    await request('POST', E('warranties'), { lineId: line.line_id, startsOn: tomorrow, requestKey: key() }, 400);
    const warrantyKey = key();
    warranty = await staff.electronics_cashier('POST', E('warranties'), { lineId: line.line_id, requestKey: warrantyKey }, 201);
    assert.equal(warranty.months, 12);
    assert.equal(warranty.starts_on, line.sold_on);
    const expected = await one("SELECT (($1::date + interval '12 months') - interval '1 day')::date::text AS d", [line.sold_on]);
    assert.equal(warranty.ends_on, expected.d);
    assert.equal(warranty.customer_name, 'Ravi Shankar');
    assert.equal(warranty.phone_digits, '9886022222');
    assert.equal(warranty.terms, 'Manufacturing defects only.');
    assert.equal((await staff.electronics_cashier('POST', E('warranties'), { lineId: line.line_id, requestKey: warrantyKey }, 201)).id, warranty.id);
    await request('POST', E('warranties'), { lineId: line.line_id, requestKey: key() }, 409);
    // A line that is not a serial cannot carry a warranty.
    const plain = await request('POST', E('documents'), { kind: 'sale', locationId: elMain.id, requestKey: key(), lines: [{ skuId: glass.id, quantity: '1' }] }, 201);
    const plainLine = (await request('GET', E(`documents/${plain.id}`))).lines[0];
    await request('POST', E('warranties'), { lineId: plainLine.id, customerName: 'X', customerPhone: '9999999999', requestKey: key() }, 400);
    // Lookup by IMEI, by second IMEI and by the phone however it is typed.
    for (const q of [imeis[0], '098860-22222', '9886022222']) {
      const found = await staff.electronics_viewer('GET', E(`warranties/lookup?q=${encodeURIComponent(q)}`));
      assert.equal(found.warranties[0]?.id, warranty.id, `lookup ${q}`);
      assert.equal(found.warranties[0].state, 'active');
    }
    assert.equal((await request('GET', E('warranties?state=active'))).total, 1);
    const card = await request('GET', E(`warranties/${warranty.id}`));
    assert.equal(card.document_no, sale.document_no);
    // The database only allows a cancellation, and only matching lines.
    await assert.rejects(pool.query("UPDATE electronics_warranties SET ends_on=ends_on+1 WHERE id=$1", [warranty.id]), /can only be cancelled/);
    await assert.rejects(pool.query(`INSERT INTO electronics_warranties(business_id,document_id,line_id,sku_id,serial,item_label,customer_name,customer_phone,phone_digits,starts_on,ends_on,months,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,'WRONG','x','x','999999','999999',current_date,current_date,1,gen_random_uuid(),repeat('a',64),$5)`, [el.id, sale.id, line.line_id, phone.id, ownerUser.id]), /must match/);
    await staff.electronics_cashier('POST', E(`warranties/${warranty.id}/cancel`), { reason: 'Wrong customer' }, 403);
    await other('GET', E(`warranties/lookup?q=${imeis[0]}`), undefined, 404);
    assert.equal((await other('GET', `/businesses/${otherEl.id}/warranties/lookup?q=${imeis[0]}`)).warranties.length, 0);
  });

  await t.test('repairs: intake under warranty, status, parts and labour, delivery bills and moves stock', async () => {
    const job = await staff.electronics_cashier('POST', E('repairs'), { locationId: elMain.id, contactId: ravi.id, skuId: phone.id, serial: imeis[0],
      problem: 'Screen cracked, touch not working', accessories: 'Back cover', estimate: '3500', requestKey: key() }, 201);
    assert.match(job.job_no, /^RJ\//);
    assert.equal(job.under_warranty, true);
    assert.equal(job.warranty_id, warranty.id);
    assert.equal(job.customer_phone, '+91 98860 22222');
    await staff.electronics_viewer('POST', E('repairs'), { locationId: elMain.id, customerName: 'A', customerPhone: '9999999999', device: 'Phone', problem: 'x', requestKey: key() }, 403);
    await request('POST', E('repairs'), { locationId: elMain.id, customerName: 'A', customerPhone: '12', device: 'Phone', problem: 'x', requestKey: key() }, 400);
    await request('POST', E(`repairs/${job.id}/status`), { status: 'delivered' }, 400);
    await staff.electronics_stock_keeper('POST', E(`repairs/${job.id}/status`), { status: 'diagnosing', note: 'Display damaged' });
    await staff.electronics_stock_keeper('POST', E(`repairs/${job.id}/status`), { status: 'received' }, 409);
    // Parts and labour: under warranty the part is free unless priced; labour is charged here.
    const part = await staff.electronics_stock_keeper('POST', E(`repairs/${job.id}/lines`), { kind: 'part', skuId: display.id, quantity: '1' }, 201);
    assert.equal(part.unit_price, '0.00');
    await request('POST', E(`repairs/${job.id}/lines`), { kind: 'labour', skuId: glass.id }, 400);
    await request('POST', E(`repairs/${job.id}/lines`), { kind: 'part', skuId: labour.id }, 400);
    await request('POST', E(`repairs/${job.id}/lines`), { kind: 'labour', skuId: labour.id, unitPrice: '250' }, 201);
    const extra = await request('POST', E(`repairs/${job.id}/lines`), { kind: 'part', skuId: glass.id, unitPrice: '199' }, 201);
    await request('DELETE', E(`repairs/${job.id}/lines/${extra.id}`));
    await request('POST', E(`repairs/${job.id}/lines`), { kind: 'part', skuId: glass.id, unitPrice: '199' }, 201);
    await request('POST', E(`repairs/${job.id}/deliver`), { requestKey: key() }, 409);
    await request('POST', E(`repairs/${job.id}/status`), { status: 'ready' });
    // The display is not in stock: delivery is refused and the job stays ready.
    const refused = await staff.electronics_cashier('POST', E(`repairs/${job.id}/deliver`), { requestKey: key() }, 409);
    assert.match(refused.message, /Not enough usable stock/);
    assert.equal((await request('GET', E(`repairs/${job.id}`))).status, 'ready');
    await request('POST', E('documents'), { kind: 'purchase', locationId: elMain.id, contactId: elSupplier.id, requestKey: key(), lines: [{ skuId: display.id, quantity: '2', unitPrice: '2400' }] }, 201);
    await staff.electronics_stock_keeper('POST', E(`repairs/${job.id}/deliver`), { requestKey: key() }, 403);
    const glassBefore = Number((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [el.id, glass.id, elMain.id])).q);
    const deliveryKey = key();
    // 250 + 199 = 449 before GST; 18 % = 80.82; total 529.82.
    const delivered = await staff.electronics_cashier('POST', E(`repairs/${job.id}/deliver`), { requestKey: deliveryKey, payment: { amount: '529.82', method: 'upi' } });
    assert.equal(delivered.status, 'delivered');
    const bill = await request('GET', E(`documents/${delivered.document_id}`));
    assert.equal(bill.total, '529.82');
    assert.equal(bill.lines.length, 3);
    assert.equal(bill.payments[0].amount, '529.82');
    assert.match(bill.notes, new RegExp(job.job_no));
    const glassAfter = Number((await one('SELECT sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [el.id, glass.id, elMain.id])).q);
    assert.equal(glassAfter, glassBefore - 1, 'parts leave stock at delivery');
    assert.equal((await staff.electronics_cashier('POST', E(`repairs/${job.id}/deliver`), { requestKey: deliveryKey })).document_id, delivered.document_id, 'a retried delivery bills once');
    // A closed job never changes.
    await request('POST', E(`repairs/${job.id}/lines`), { kind: 'labour', skuId: labour.id }, 409);
    await request('POST', E(`repairs/${job.id}/cancel`), { reason: 'x' }, 409);
    await assert.rejects(pool.query("UPDATE electronics_repair_jobs SET problem='x' WHERE id=$1", [job.id]), /closed/);
    const detail = await request('GET', E(`repairs/${job.id}`));
    assert.deepEqual(detail.events.map((e) => e.to_status), ['received', 'diagnosing', 'ready', 'delivered']);
    for (const kind of ['repair.received', 'repair.status_changed', 'repair.delivered', 'sale.posted', 'payment.recorded']) {
      assert.ok(await one('SELECT 1 FROM business_events WHERE business_id=$1 AND kind=$2', [el.id, kind]), kind);
    }
    // A job with nothing charged is delivered without a bill; another is cancelled.
    const quick = await request('POST', E('repairs'), { locationId: elMain.id, customerName: 'Walk-in', customerPhone: '90000 12345', device: 'Old feature phone', problem: 'Check battery', requestKey: key() }, 201);
    assert.equal(quick.under_warranty, false);
    await request('POST', E(`repairs/${quick.id}/status`), { status: 'ready' });
    await request('POST', E(`repairs/${quick.id}/deliver`), { requestKey: key(), payment: { amount: '10', method: 'cash' } }, 400);
    assert.equal((await request('POST', E(`repairs/${quick.id}/deliver`), { requestKey: key() })).document_id, null);
    const dropped = await request('POST', E('repairs'), { locationId: elMain.id, customerName: 'Meena', customerPhone: '90000 54321', device: 'Tablet', problem: 'No power', requestKey: key() }, 201);
    await staff.electronics_cashier('POST', E(`repairs/${dropped.id}/cancel`), { reason: 'x' }, 403);
    assert.equal((await request('POST', E(`repairs/${dropped.id}/cancel`), { reason: 'Customer took it back unrepaired' })).status, 'cancelled');
    assert.equal((await request('GET', E('repairs?stage=open'))).total, 0);
    assert.equal((await request('GET', E(`repairs?q=${encodeURIComponent('Old feature')}`))).total, 1);
    // Lookup by phone also lists repair history.
    assert.equal((await request('GET', E('warranties/lookup?q=9886022222'))).repairs.length, 1);
    // Isolation: another owner's token and another business's records.
    await other('GET', E(`repairs/${job.id}`), undefined, 404);
    await other('GET', `/businesses/${otherEl.id}/repairs/${job.id}`, undefined, 404);
    const otherLocation = (await other('GET', `/businesses/${otherEl.id}/locations`)).items[0];
    await request('POST', E('repairs'), { locationId: otherLocation.id, customerName: 'A', customerPhone: '9999999999', device: 'P', problem: 'x', requestKey: key() }, 404);
    const open = await request('POST', E('repairs'), { locationId: elMain.id, customerName: 'B', customerPhone: '9999999999', device: 'P', problem: 'x', requestKey: key() }, 201);
    const otherSku = await other('POST', `/businesses/${otherEl.id}/catalog`, { name: 'Theirs', code: 'THEIRS', kind: 'service', unit: 'service', price: '1', taxRate: '0' }, 201);
    await request('POST', E(`repairs/${open.id}/lines`), { kind: 'labour', skuId: otherSku.id }, 404);
  });

  await t.test('a returned unit loses its warranty; a cancelled one can be registered again', async () => {
    const line = (await request('GET', E(`documents/${sale.id}`))).lines[0];
    await request('POST', E(`warranties/${warranty.id}/cancel`), { reason: 'Registered with the wrong start date' });
    await request('POST', E(`warranties/${warranty.id}/cancel`), { reason: 'again' }, 404);
    const again = await request('POST', E('warranties'), { lineId: line.id, startsOn: line ? (await request('GET', E(`warranties/eligible?q=${imeis[0]}`)))[0].sold_on : undefined, months: 24, requestKey: key() }, 201);
    assert.equal(again.months, 24);
    await request('POST', E(`documents/${sale.id}/returns`), { reason: 'Dead on arrival', requestKey: key(), lines: [{ lineId: line.id, quantity: '1', restock: true }] }, 201);
    const found = await request('GET', E(`warranties/lookup?q=${imeis[0]}`));
    assert.equal(found.warranties.find((w) => w.id === again.id).state, 'returned');
    assert.equal(found.unregistered.length, 0);
    const unit = (await request('GET', E(`serials?q=${imeis[0]}`))).items[0];
    assert.equal(unit.status, 'in_stock', 'the returned handset is back in stock at the service centre');
    assert.equal(unit.location_id, centre.id);
  });

  await t.test('variant codes widen against existing colours; a colour code can be typed', async () => {
    // "Sky blue" already has SKY: "Skyline" becomes SKYL, never refused.
    await request('POST', F(`fashion/products/${shirt.id}/variants`), { colors: ['Skyline'] }, 201);
    await request('POST', F(`fashion/products/${shirt.id}/variants`), { colors: ['Sand'], colorCodes: { Sand: 'SND' } }, 201);
    await request('POST', F(`fashion/products/${shirt.id}/variants`), { colors: ['Sandal'], colorCodes: { Sandal: 'SND' } }, 409);
    matrix = await request('GET', F(`fashion/products/${shirt.id}`));
    assert.equal(cell('M', 'Skyline').code, 'OXF-SKYL-M');
    assert.equal(cell('M', 'Sky blue').code, 'OXF-SKY-M');
    assert.equal(cell('S', 'Sand').code, 'OXF-SND-S');
    // A new size for an existing colour keeps that colour's code part.
    await request('POST', F(`fashion/products/${shirt.id}/variants`), { sizes: ['4XL'], sizePrices: { '4XL': '1399' } }, 201);
    matrix = await request('GET', F(`fashion/products/${shirt.id}`));
    assert.equal(cell('4XL', 'Skyline').code, 'OXF-SKYL-4XL');
    assert.equal(cell('4XL', 'Sky blue').code, 'OXF-SKY-4XL');
  });

  await t.test('the one-place serial rule holds under concurrent direct inserts', async () => {
    const code = imei('35209900176160');
    const [first, second] = [new Client({ ...connection, database }), new Client({ ...connection, database })];
    await first.connect(); await second.connect();
    try {
      await first.query('BEGIN'); await second.query('BEGIN');
      await first.query('INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,quantity) VALUES($1,$2,$3,$4,1)', [el.id, elMain.id, phone.id, code]);
      const racing = second.query('INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,quantity) VALUES($1,$2,$3,$4,1)', [el.id, centre.id, phone.id, code]).then(() => 'committed', (error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query('COMMIT');
      assert.match(await racing, /already in stock at another location/);
      await second.query('ROLLBACK');
    } finally {
      await first.end(); await second.end();
      await pool.query('DELETE FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [el.id, phone.id, code]);
    }
  });
});
