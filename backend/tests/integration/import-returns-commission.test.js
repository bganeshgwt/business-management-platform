const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Three pieces, end to end on a throwaway database with every migration
// applied: a shop's spreadsheet import of styles with their variants and of
// pack sizes (rows of one style one product, made as the item form makes
// variants; a style whose rows disagree refused, naming the rows; a style
// already here gaining rows; pack sizes made as Settings › Units & pack sizes
// makes them); free goods on a return of a wholesale invoice (taken back, or
// kept and charged off the credit to the paisa, given back when they come
// back later, never more than belongs, checked by the database); and a
// mechanic's commission taken back in proportion when the labour it was
// earned on is credited (returned, or credited by value), with payouts left
// as they were. Refusals with their codes, idempotent retries, audit and
// events.
test('styles and pack sizes from a file, free goods kept on a return, commission taken back', { timeout: 900000 }, async (t) => {
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
  const dir = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes this migration away and Up brings it back', async () => {
    const probe = new Client({ ...connection, database });
    await probe.connect();
    try {
      const tables = ['wholesale_free_goods_kept', 'garage_commission_reversals'];
      const left = async () => (await probe.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
      const columns = async () => (await probe.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='garage_commissions' AND column_name IN ('document_line_id','line_net')")).rows[0].n;
      assert.deepEqual([await left(), await columns()], [2, 2]);
      const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_import-returns-commission.sql')).split('_')[0]);
      await migrate({ direction: 'down', count: stamp, timestamp: true });
      assert.deepEqual([await left(), await columns()], [0, 0]);
      assert.equal((await probe.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('wholesale_free_goods_kept_check','garage_commission_reversals_kept')")).rows[0].n, 0);
      await migrate({ direction: 'up', count: Infinity });
      assert.deepEqual([await left(), await columns()], [2, 2]);
    } finally { await probe.end(); }
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Irc-${crypto.randomBytes(8).toString('hex')}`;
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('irc-owner');
  const ownerToken = await login('irc-owner@test.invalid');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body).slice(0, 2000)}`);
    return result.body;
  };
  const answer = as(ownerToken);
  const request = async (method, route, body, expected = 200) => (await answer(method, route, body, expected)).data;
  const refused = async (method, route, body, auth = ownerToken) => {
    const result = await call(method, route, body, auth);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const expectRefused = async (method, route, body, status, pattern, auth) => {
    const result = await refused(method, route, body, auth);
    assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result)}`);
    if (pattern) assert.match(result.message, pattern);
    return result;
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const audits = (business, action) => rows('SELECT entity_id,details FROM business_audit WHERE business_id=$1 AND action=$2 ORDER BY id', [business.id, action]);
  const events = (business, kind) => rows('SELECT entity_id,payload FROM business_events WHERE business_id=$1 AND kind=$2 ORDER BY id', [business.id, kind]);

  const madeBusinesses = await createBusinesses(request, 'OWNER', ['general_retail', 'grocery', 'wholesale', 'garage']);
  const [store, grocery, ws, garage] = await withTools(request, madeBusinesses);
  assert.ok(store.capabilities.includes('variants'));
  async function staff(business, email, template, permissions) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    const roles = (await request('GET', `/businesses/${business.id}/roles?limit=100`)).items;
    const role = permissions ? await request('POST', `/businesses/${business.id}/roles`, { name: template, permissions }, 201) : roles.find((r) => r.template_code === template);
    await request('POST', `/businesses/${business.id}/members`, { userId: user.id, roleId: role.id }, 201);
    return { id: user.id, token: await login(email) };
  }

  // --- The spreadsheet import: styles with their variants, and pack sizes ----------------------------------

  const S = (suffix) => `/businesses/${store.id}/${suffix}`;
  // A spreadsheet as the staff app sends it: one { heading: cell } per row.
  const file = (headings, ...lines) => lines.map((line) => Object.fromEntries(headings.map((heading, at) => [heading, line[at] ?? ''])));
  const checking = (sheetRows, more = {}) => ({ rows: sheetRows, dryRun: true, fileName: 'styles.xlsx (Items)', ...more });
  const itemsOf = async (business) => (await request('GET', `/businesses/${business.id}/catalog?limit=100`)).items;
  const [storeShop] = (await request('GET', S('locations'))).items;
  const slabs = (await request('GET', S('tax-rates?limit=100'))).items;
  const gst5 = slabs.find((s) => Number(s.rate) === 5);

  await t.test('the template: pack sizes for goods, and a style with its variants where Variants is on', async () => {
    const guide = await request('GET', S('catalog/import-guide'));
    assert.deepEqual(guide.columns.map((c) => c.label).slice(15), ['Batch', 'Expiry', 'Pack unit', 'Units in pack', 'Style', 'Size', 'Colour', 'Fabric']);
    assert.ok(guide.notes.includes('A style\'s sizes and colours come in as its variants: give each row the style, its size or colour, and its own code.'));
    // A shop without Variants has the pack sizes only.
    const plain = await request('GET', `/businesses/${grocery.id}/catalog/import-guide`);
    assert.deepEqual(plain.columns.map((c) => c.label).slice(-3), ['Expiry', 'Pack unit', 'Units in pack']);
    // The template passes its own check: two variants of one new style, and a pack size.
    const sample = file(guide.sample.columns, ...guide.sample.rows);
    assert.ok(guide.sample.rows.every((row) => row.length === guide.sample.columns.length));
    const checked = await answer('POST', S('catalog/import'), checking(sample));
    assert.deepEqual(checked.data.rows.map((r) => r.action), sample.map(() => 'create'));
    assert.deepEqual([checked.data.styles, checked.data.packs], [{ count: 1, variants: 2 }, 1]);
    const variants = checked.data.rows.filter((r) => r.details.style);
    assert.deepEqual(variants.map((r) => [r.name, r.details.style, r.details.variant]), [['Example style · Blue / S', 'Example style (new)', 'Blue / S'],
      ['Example style · Blue / M', 'Example style (new)', 'Blue / M']]);
    assert.equal(checked.data.rows[0].details.pack, 'Box of 12');
  });

  const HEAD = ['Style', 'Size', 'Colour', 'Name', 'Code', 'Barcode', 'Category', 'Unit', 'GST rate', 'HSN / SAC', 'Sale price', 'Opening stock', 'Purchase price', 'Pack unit', 'Units in pack'];
  const styles = file(HEAD,
    ['Oxford shirt', 'M', 'Blue', '', 'OXF-BLU-M', '8904000001001', 'Shirts', 'each', '5%', '6205', '999', '6', '600', '', ''],
    ['oxford shirt', 'L', 'Blue', '', 'oxf-blu-l', '', '', '', '', '', '1,099', '4', '650', '', ''],
    ['Oxford Shirt', 'M', 'White', 'Oxford shirt white M', 'OXF-WHT-M', '', 'Shirts', 'pcs', '', '', '999', '', '', '', ''],
    ['Linen kurta', 'M', '', '', 'KUR-M', '', 'Kurtas', 'each', '5%', '', '1499', '', '', '', ''],
    ['Linen kurta', 'L', '', '', 'KUR-L', '', 'Kurtas', 'each', 'GST 18%', '', '1599', '', '', '', ''],
    ['Polo tee', 'M', 'Red', '', 'POLO-RED-M', '', '', 'each', '5%', '', '499', '', '', '', ''],
    ['Polo tee', 'm', 'red', '', 'POLO-RED-M2', '', '', 'each', '5%', '', '499', '', '', '', ''],
    ['', '', '', 'Gift wrap roll', 'WRAP-1', '', '', 'each', '18%', '', '60', '', '', 'box', '12'],
    ['', '', '', 'Ribbon', 'RIB-1', '', '', 'each', '18%', '', '20', '', '', 'each', '10'],
    ['', '', '', 'Candle', 'CAN-1', '', '', 'each', '18%', '', '50', '', '', 'box', '2.5'],
    ['', '', '', 'Greeting card', 'CARD-1', '', '', 'each', '18%', '', '25', '', '', 'carton', '10'],
    ['', '', '', 'Tape roll', 'TAPE-1', '', '', 'each', '18%', '', '30', '', '', 'box', '']);
  let firstImport;

  await t.test('styles: rows of one style are one product with its variants; a style whose rows disagree is refused, naming the rows', async () => {
    const checked = await answer('POST', S('catalog/import'), checking(styles));
    assert.equal(checked.message, 'Ready: 5 new products, 0 to update, 0 unchanged, 4 variants of 2 styles, 1 pack size, opening stock for 2 items; 7 rows refused and left out');
    const byLine = Object.fromEntries(checked.data.rows.map((r) => [r.line, r]));
    // The first row of a style gives what its rows share; a row that leaves one empty takes it.
    assert.deepEqual(byLine[2].details, { kind: 'Goods', unit: 'Each (piece)', price: '₹999.00', gst: 'GST 5%', mrp: null, hsn: '6205', category: 'Shirts (new)',
      opening: `6 each at ${storeShop.name}`, cost: '₹600.00', style: 'Oxford shirt (new)', variant: 'Blue / M' });
    assert.deepEqual([byLine[3].name, byLine[3].code, byLine[3].details.gst, byLine[3].details.hsn, byLine[3].details.unit, byLine[3].details.category],
      ['Oxford shirt · Blue / L', 'OXF-BLU-L', 'GST 5%', '6205', 'Each (piece)', 'Shirts (new)']);
    assert.deepEqual([byLine[4].name, byLine[4].details.variant], ['Oxford shirt white M', 'White / M']);
    const reasons = (line) => byLine[line].reasons.map((r) => `${r.column}: ${r.message}`);
    const twoRates = 'gst: Style Linen kurta has two GST rates: 5% (row 5), GST 18% (row 6). Its variants share one.';
    assert.deepEqual([reasons(5), reasons(6)], [[twoRates], [twoRates]]);
    assert.deepEqual(reasons(8), ['style: Row 7 is the same variant of Polo tee (red / m)']);
    assert.equal(byLine[9].details.pack, 'Box of 12');
    assert.deepEqual(reasons(10), ['packUnit: Ribbon is already stocked in each (piece): a pack is another unit']);
    assert.deepEqual(reasons(11), ['packQuantity: Candle is stocked in whole units, so a pack must hold a whole number']);
    assert.match(reasons(12)[0], /^packUnit: "carton" is not one of your units \(.*\)\. Add it in Settings › Units & pack sizes first$/);
    assert.deepEqual(reasons(13), ['packQuantity: Give how many each (piece) one pack holds']);
    // Nothing is written by a check.
    assert.equal((await itemsOf(store)).length, 0);

    const requestKey = key();
    const done = await answer('POST', S('catalog/import'), { rows: styles, dryRun: false, fileName: 'styles.xlsx (Items)', fingerprint: checked.data.fingerprint, requestKey });
    assert.equal(done.message, 'Imported: 5 products added, 0 updated, 4 variants of 2 styles, 1 pack size saved, opening stock for 2 items brought in; 7 rows refused and left out');
    firstImport = { requestKey, message: done.message };
    const items = await itemsOf(store);
    const sku = (code) => items.find((s) => s.code === code);
    const shirt = await one('SELECT id,name,category_id FROM catalog_products WHERE business_id=$1 AND name=$2', [store.id, 'Oxford shirt']);
    assert.ok(shirt, 'the style is one product, named as its first row writes it');
    const variants = await rows('SELECT code,label,product_id,price,tax_rate_id,hsn_code,unit,attributes,barcode FROM catalog_skus WHERE business_id=$1 AND product_id=$2 ORDER BY id', [store.id, shirt.id]);
    assert.deepEqual(variants.map((v) => [v.code, v.label, Number(v.price), String(v.tax_rate_id), v.hsn_code, v.unit, v.attributes]), [
      ['OXF-BLU-M', 'Oxford shirt · Blue / M', 999, String(gst5.id), '6205', 'each', { size: 'M', color: 'Blue' }],
      ['OXF-BLU-L', 'Oxford shirt · Blue / L', 1099, String(gst5.id), '6205', 'each', { size: 'L', color: 'Blue' }],
      ['OXF-WHT-M', 'Oxford shirt white M', 999, String(gst5.id), '6205', 'each', { size: 'M', color: 'White' }]]);
    assert.equal(variants[0].barcode, '8904000001001');
    assert.equal((await one('SELECT name FROM catalog_categories WHERE business_id=$1 AND id=$2', [store.id, shirt.category_id])).name, 'Shirts');
    assert.deepEqual([Number(sku('OXF-BLU-M').stock), Number(sku('OXF-BLU-L').stock), Number(sku('OXF-WHT-M').stock)], [6, 4, 0]);
    assert.notEqual(String(sku('POLO-RED-M').product_id), String(shirt.id));
    assert.ok(!sku('KUR-M') && !sku('POLO-RED-M2') && !sku('RIB-1'));
    // The pack size, as Settings › Units & pack sizes makes it.
    const pack = await one('SELECT unit_code,quantity_in_base,active FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2', [store.id, sku('WRAP-1').id]);
    assert.deepEqual([pack.unit_code, pack.quantity_in_base, pack.active], ['box', '12.000', true]);
    // The activity log: each item and the pack as made by hand, and the import with its counts.
    assert.equal((await audits(store, 'catalog.created')).length, 5);
    assert.equal((await audits(store, 'pack_size.saved')).length, 1);
    const [imported] = await audits(store, 'catalog.imported');
    assert.deepEqual(imported.details, { fileName: 'styles.xlsx (Items)', rows: 12, created: 5, updated: 0, unchanged: 0, skipped: 0, refused: 7, mode: 'skip', openingStock: 2,
      newCategories: 1, styles: 2, variants: 4, packSizes: 1 });
    assert.equal((await events(store, 'stock.adjusted')).length, 2);
    // The same import again answers the first; its key with other rows is refused.
    const again = await answer('POST', S('catalog/import'), { rows: styles, dryRun: false, fileName: 'styles.xlsx (Items)', requestKey });
    assert.deepEqual([again.message, again.data.repeated], [firstImport.message, true]);
    assert.equal((await itemsOf(store)).length, items.length);
    await expectRefused('POST', S('catalog/import'), { rows: styles.slice(0, 3), dryRun: false, requestKey }, 409, /already used for different data/);
  });

  await t.test('a style already here gains new rows with its items\' unit, GST and HSN; what never changes from a file', async () => {
    const more = file(['Style', 'Size', 'Colour', 'Code', 'Sale price', 'Opening stock', 'Category'],
      ['Oxford shirt', 'XL', 'Blue', 'OXF-BLU-XL', '1199', '3', ''],
      ['OXFORD SHIRT', 'M', 'Blue', 'OXF-BLU-M2', '999', '', ''],
      ['Oxford shirt', 'L', 'Black', 'OXF-BLU-M', '', '', ''],
      ['Oxford shirt', '', '', 'WRAP-1', '', '', ''],
      ['Oxford shirt', 'XXL', 'Blue', 'OXF-BLU-XXL', '1299', '', 'Formal shirts']);
    const checked = await request('POST', S('catalog/import'), checking(more));
    const reasons = (line) => checked.rows.find((r) => r.line === line).reasons.map((r) => r.message);
    const xl = checked.rows.find((r) => r.line === 2);
    assert.deepEqual([xl.action, xl.name, xl.details.style, xl.details.unit, xl.details.gst, xl.details.hsn, xl.details.category],
      ['create', 'Oxford shirt · Blue / XL', 'Oxford shirt', 'Each (piece)', 'GST 5%', '6205', 'Shirts']);
    assert.deepEqual(reasons(3), ['Oxford shirt already has Blue / M: Oxford shirt · Blue / M (OXF-BLU-M)']);
    assert.deepEqual(reasons(4), ['The size of Oxford shirt · Blue / M is M: it does not change from a file', 'The colour of Oxford shirt · Blue / M is Blue: it does not change from a file']);
    assert.deepEqual(reasons(5), ['Gift wrap roll is an item of its own: an item\'s style does not change']);
    assert.deepEqual(reasons(6), ['Oxford shirt is in Shirts: its variants are in its category']);
    // A new variant keeps the style's unit.
    const kg = await request('POST', S('catalog/import'), checking(file(['Style', 'Size', 'Code', 'Unit', 'Sale price'], ['Oxford shirt', 'S', 'OXF-S', 'kg', '899'])));
    assert.deepEqual(kg.rows[0].reasons.map((r) => r.message), ['Oxford shirt is counted in each (piece): its variants are too']);
    await request('POST', S('catalog/import'), { rows: more.slice(0, 1), dryRun: false, requestKey: key() });
    const xlSku = await one('SELECT s.product_id,s.unit,s.tax_rate_id,s.hsn_code,s.label FROM catalog_skus s WHERE s.business_id=$1 AND s.code=$2', [store.id, 'OXF-BLU-XL']);
    const blueM = await one('SELECT product_id FROM catalog_skus WHERE business_id=$1 AND code=$2', [store.id, 'OXF-BLU-M']);
    assert.deepEqual([String(xlSku.product_id), xlSku.unit, String(xlSku.tax_rate_id), xlSku.hsn_code], [String(blueM.product_id), 'each', String(gst5.id), '6205']);
    // Without Variants the columns are not read: each row is an item of its own.
    const plain = await request('POST', `/businesses/${grocery.id}/catalog/import`, checking(file(['Style', 'Size', 'Name', 'Code', 'Unit', 'Sale price'], ['Rice', '5 kg', 'Rice 5 kg', 'RICE-5', 'each', '400'])));
    assert.deepEqual([plain.columns.ignored, plain.rows[0].action, plain.rows[0].details.style], [['Style', 'Size'], 'create', undefined]);
  });

  await t.test('pack sizes on items already here: added, the same left alone, another quantity changed where chosen; the permission that makes them', async () => {
    const packs = file(['Code', 'Pack unit', 'Units in pack'], ['WRAP-1', 'Box', '12'], ['OXF-BLU-M', 'box', '6'], ['POLO-RED-M', 'pack', '3']);
    const skipping = await request('POST', S('catalog/import'), checking(packs));
    assert.deepEqual(skipping.rows.map((r) => r.action), ['unchanged', 'skipped', 'skipped']);
    const updating = await request('POST', S('catalog/import'), checking([...packs.slice(1), { Code: 'WRAP-1', 'Pack unit': 'box', 'Units in pack': '24' }], { mode: 'update' }));
    assert.deepEqual(updating.rows.map((r) => [r.action, r.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`)]), [
      ['update', ['Pack size: — → Box of 6']], ['update', ['Pack size: — → Pack of 3']], ['update', ['Pack size: Box of 12 → Box of 24']]]);
    const done = await answer('POST', S('catalog/import'), { rows: updating.rows.length ? [...packs.slice(1), { Code: 'WRAP-1', 'Pack unit': 'box', 'Units in pack': '24' }] : [],
      dryRun: false, mode: 'update', fingerprint: updating.fingerprint, requestKey: key() });
    assert.equal(done.message, 'Imported: 0 products added, 3 updated, 3 pack sizes saved');
    const saved = await rows(`SELECT s.code,x.unit_code,x.quantity_in_base FROM catalog_sku_units x JOIN catalog_skus s ON s.id=x.sku_id WHERE x.business_id=$1 ORDER BY s.code`, [store.id]);
    assert.deepEqual(saved.map((p) => [p.code, p.unit_code, p.quantity_in_base]), [['OXF-BLU-M', 'box', '6.000'], ['POLO-RED-M', 'pack', '3.000'], ['WRAP-1', 'box', '24.000']]);
    // A role that adds items but does not change them may not add pack sizes from a file.
    const clerk = await staff(store, 'irc-clerk@test.invalid', 'Catalogue clerk', ['catalog.view', 'catalog.create']);
    const withPack = file(['Name', 'Code', 'Unit', 'Sale price', 'Pack unit', 'Units in pack'], ['Paper bag', 'BAG-1', 'each', '5', 'box', '50']);
    await expectRefused('POST', S('catalog/import'), checking(withPack), 403,
      /^Your role may not add pack sizes: leave the Pack unit and Units in pack columns out of the file, or ask someone whose role changes items to import it\.$/, clerk.token);
    assert.equal((await refused('POST', S('catalog/import'), checking(withPack.map(({ 'Pack unit': _, 'Units in pack': __, ...rest }) => rest)), clerk.token)).status, 200);
  });

  // --- Free goods on a return of a wholesale invoice -------------------------------------------------------

  const W = (suffix) => `/businesses/${ws.id}/${suffix}`;
  await pool.query("UPDATE business_settings SET tax_mode='exclusive', rounding='none' WHERE business_id=$1", [ws.id]);
  const [depot] = (await request('GET', W('locations'))).items;
  const supplier = await request('POST', W('contacts'), { kind: 'supplier', name: 'Sunrise Foods Depot' }, 201);
  const hotel = await request('POST', W('contacts'), { kind: 'customer', name: 'Hotel Annapurna', creditDays: 30 }, 201);
  const biscuits = await request('POST', W('catalog'), { name: 'Glucose biscuits 100 g', code: 'BIS', kind: 'goods', unit: 'each', tracking: 'quantity', price: '10', taxRate: '18' }, 201);
  await request('POST', W('pack-sizes'), { skuId: biscuits.id, unitCode: 'case', quantityInBase: '48' }, 201);
  await request('POST', W('documents'), { kind: 'purchase', locationId: depot.id, contactId: supplier.id, requestKey: key(), lines: [{ skuId: biscuits.id, quantity: '2400', unitPrice: '7' }] }, 201);
  await request('POST', W('schemes'), { name: 'Buy 5 cases get 1 free', skuId: biscuits.id, unitCode: 'case', buyQuantity: '5', freeQuantity: '1', discountPercent: '2' }, 201);
  const stockOf = async () => Number((await one('SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2', [ws.id, biscuits.id])).q);
  // An order of 10 cases earns 2 free; both go on one invoice.
  const order = await request('POST', W('sales-orders'), { locationId: depot.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '10' }] }, 201);
  const orderLines = (await request('GET', W(`sales-orders/${order.id}`))).lines;
  const paidOrderLine = orderLines.find((l) => !l.free_of_line_id), freeOrderLine = orderLines.find((l) => l.free_of_line_id);
  const sent = await request('POST', W(`sales-orders/${order.id}/dispatch`), { requestKey: key(), lines: [
    { orderLineId: paidOrderLine.id, unit: 'case', quantity: '10' }, { orderLineId: freeOrderLine.id, unit: 'case', quantity: '2' }] }, 201);
  const invoiceId = sent.document.id;
  const invoice = await request('GET', W(`documents/${invoiceId}`));
  const paidLine = invoice.lines.find((l) => Number(l.net) > 0), freeLine = invoice.lines.find((l) => Number(l.net) === 0);
  const returning = (lines, more = {}) => ({ reason: 'Damaged in transit', requestKey: key(), lines, ...more });
  const keptRows = () => rows('SELECT return_id,quantity,unit_value,net,tax,tax_rate FROM wholesale_free_goods_kept WHERE business_id=$1 AND document_id=$2 ORDER BY id', [ws.id, invoiceId]);

  await t.test('the invoice: 480 paid at ₹9.80 after the scheme\'s 2%, and 96 free with them', async () => {
    assert.deepEqual([paidLine.quantity, paidLine.net, paidLine.tax, freeLine.quantity], ['480.000', '4704.00', '846.72', '96.000']);
    const [goods] = invoice.wholesale.free_goods;
    assert.deepEqual([goods.paid_line_ids.map(String), goods.paid_quantity, goods.paid_returned, goods.tax_rate], [[String(paidLine.id)], '480.000', '0.000', '18.00']);
    assert.deepEqual(goods.free.map((f) => [f.lines.map((l) => String(l.id)), f.quantity, f.returned, f.kept, f.unit_value, f.same_item]),
      [[[String(freeLine.id)], '96.000', '0.000', '0.000', '9.8000', true]]);
    assert.deepEqual(invoice.wholesale.kept, []);
  });

  await t.test('a part return with the free goods back: the credit is the paid goods\'', async () => {
    const before = await stockOf();
    const back = await request('POST', W(`documents/${invoiceId}/returns`), returning([{ lineId: paidLine.id, quantity: '120', restock: true }, { lineId: freeLine.id, quantity: '24', restock: true }]), 201);
    assert.equal(back.total, '1387.68', '120 × ₹9.80 = ₹1,176.00 with 18% GST ₹211.68');
    assert.equal(back.free_goods, undefined);
    assert.deepEqual(await keptRows(), []);
    assert.equal(await stockOf(), before + 144, 'the free goods come back into stock with the paid ones');
  });

  let keptReturn;
  await t.test('a part return keeping them: the credit less the free goods kept, to the paisa, with GST at the line\'s rate', async () => {
    const body = returning([{ lineId: paidLine.id, quantity: '120', restock: true }]);
    keptReturn = await request('POST', W(`documents/${invoiceId}/returns`), body, 201);
    // 24 more belong (96 × 240 ÷ 480 = 48, 24 came back): 24 × ₹9.80 = ₹235.20 and GST ₹42.34 come off ₹1,387.68.
    assert.equal(keptReturn.total, '1110.14');
    assert.deepEqual(keptReturn.free_goods.map((k) => [k.quantity, k.unit_value, k.net, k.tax, k.words]), [['24.000', '9.8000', '235.20', '42.34', 'Free goods kept: 24 × ₹9.80']]);
    assert.deepEqual((await keptRows()).map((k) => [String(k.return_id), k.quantity, k.net, k.tax, k.tax_rate]), [[String(keptReturn.id), '24.000', '235.20', '42.34', '18.00']]);
    // The same return sent again is the same; its key with another body is refused.
    assert.equal((await request('POST', W(`documents/${invoiceId}/returns`), body, 201)).id, keptReturn.id);
    assert.equal((await keptRows()).length, 1);
    await expectRefused('POST', W(`documents/${invoiceId}/returns`), { ...body, lines: [{ lineId: paidLine.id, quantity: '119', restock: true }] }, 409, /already used for a different return/);
    // The credit note shows it as a line of its own; the reports count the credit note less it.
    const shown = await request('GET', W(`documents/${invoiceId}`));
    assert.deepEqual(shown.wholesale.kept.map((k) => [String(k.return_id), k.words, k.label]), [[String(keptReturn.id), 'Free goods kept: 24 × ₹9.80', 'Glucose biscuits 100 g']]);
    assert.deepEqual(shown.wholesale.free_goods[0].free.map((f) => [f.returned, f.kept]), [['24.000', '24.000']]);
    const today = daysFrom(0);
    const report = await request('GET', W(`reports?from=${today}&to=${today}`));
    const returns = report.rows.find((r) => r.kind === 'sale_return');
    assert.deepEqual([returns.net, returns.tax, returns.total], ['2116.80', '381.02', '2497.82']);
    // The activity log and the outbox name the free goods kept.
    const audit = (await audits(ws, 'sale.returned')).find((a) => String(a.entity_id) === String(keptReturn.id));
    assert.deepEqual(audit.details.freeGoodsKept, [{ label: 'Glucose biscuits 100 g', quantity: '24.000', unitValue: '9.8000', net: '235.20', tax: '42.34' }]);
    const event = (await events(ws, 'sale.returned')).find((e) => String(e.entity_id) === String(keptReturn.id));
    assert.equal(event.payload.freeGoodsKept[0].net, '235.20');
  });

  await t.test('later returns: free goods brought back give back their charge, once; the rest of the paid goods charge what is kept', async () => {
    const backLater = await request('POST', W(`documents/${invoiceId}/returns`), returning([{ lineId: freeLine.id, quantity: '24', restock: true }]), 201);
    assert.equal(backLater.total, '277.54', 'the ₹235.20 and ₹42.34 kept are given back');
    assert.deepEqual(backLater.free_goods.map((k) => [k.quantity, k.net, k.tax, k.words]), [['-24.000', '-235.20', '-42.34', 'Free goods brought back: 24 × ₹9.80']]);
    // More free goods than belong come back at no value: nothing is given back twice.
    const extra = await request('POST', W(`documents/${invoiceId}/returns`), returning([{ lineId: freeLine.id, quantity: '24', restock: true }]), 201);
    assert.deepEqual([extra.total, extra.free_goods], ['0.00', undefined]);
    // The rest of the paid goods: all 96 belong, 72 are back, 24 kept.
    const rest = await request('POST', W(`documents/${invoiceId}/returns`), returning([{ lineId: paidLine.id, quantity: '240', restock: true }]), 201);
    assert.equal(rest.total, '2497.82', '₹2,352.00 + ₹423.36 less ₹277.54');
    const all = await rows('SELECT total FROM business_returns WHERE business_id=$1 AND document_id=$2', [ws.id, invoiceId]);
    assert.equal(all.reduce((sum, r) => sum + paise(r.total), 0), paise(invoice.total) - 27754, 'everything is back but the 24 free kept, charged at ₹277.54');
    assert.deepEqual((await keptRows()).map((k) => Number(k.quantity)), [24, -24, 24]);
  });

  await t.test('the limits: the database checks what is kept, and a credit cannot go below nothing', async () => {
    const [kept] = await keptRows();
    const ret = await one('SELECT id FROM business_returns WHERE business_id=$1 AND document_id=$2 ORDER BY id LIMIT 1', [ws.id, invoiceId]);
    const insert = (quantity) => pool.query(`INSERT INTO wholesale_free_goods_kept(business_id,return_id,document_id,order_line_id,free_line_id,quantity,unit_value,net,tax,tax_rate)
      VALUES($1,$2,$3,$4,$5,$6,9.8,0,0,18)`, [ws.id, ret.id, invoiceId, paidOrderLine.id, freeOrderLine.id, quantity]);
    // All 96 belong to the paid goods returned, 72 came back: 24 may be kept, and 24 are.
    await assert.rejects(insert('1'), /never more than belong to the paid goods returned and did not come back \(24\)/);
    await assert.rejects(insert('-30'), /More free goods would be given back than were kept/);
    await assert.rejects(pool.query('UPDATE wholesale_free_goods_kept SET net=0 WHERE business_id=$1', [ws.id]), /kept as they were charged/);
    await assert.rejects(pool.query('DELETE FROM wholesale_free_goods_kept WHERE business_id=$1', [ws.id]), /kept as they were charged/);
    assert.ok(kept);
    // Free goods given by hand worth more than the paid goods: keeping them all would leave the credit below nothing.
    const generous = await request('POST', W('sales-orders'), { locationId: depot.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '1', freeQuantity: '2' }] }, 201);
    const lines = (await request('GET', W(`sales-orders/${generous.id}`))).lines;
    const gPaid = lines.find((l) => !l.free_of_line_id), gFree = lines.find((l) => l.free_of_line_id);
    const gSent = await request('POST', W(`sales-orders/${generous.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: gPaid.id, quantity: '48' }, { orderLineId: gFree.id, quantity: '96' }] }, 201);
    const gInvoice = await request('GET', W(`documents/${gSent.document.id}`));
    const gPaidLine = gInvoice.lines.find((l) => Number(l.net) > 0), gFreeLine = gInvoice.lines.find((l) => Number(l.net) === 0);
    await expectRefused('POST', W(`documents/${gSent.document.id}/returns`), returning([{ lineId: gPaidLine.id, quantity: '48', restock: true }]), 409,
      /^The free goods kept come to more than this return gives back: take some of them back with it$/);
    const fine = await request('POST', W(`documents/${gSent.document.id}/returns`), returning([{ lineId: gPaidLine.id, quantity: '48', restock: true }, { lineId: gFreeLine.id, quantity: '96', restock: true }]), 201);
    assert.equal(fine.total, '566.40');
    // A van that comes back with everything refused: all its free goods back, nothing kept.
    const refusedOrder = await request('POST', W('sales-orders'), { locationId: depot.id, contactId: hotel.id, requestKey: key(), lines: [{ skuId: biscuits.id, unit: 'case', quantity: '5' }] }, 201);
    const rLines = (await request('GET', W(`sales-orders/${refusedOrder.id}`))).lines;
    const rSent = await request('POST', W(`sales-orders/${refusedOrder.id}/dispatch`), { requestKey: key(), lines: rLines.map((l) => ({ orderLineId: l.id, quantity: l.quantity })) }, 201);
    const delivery = await request('POST', W(`dispatches/${rSent.dispatch.id}/delivery`), { status: 'refused', note: 'Shop closed', requestKey: key() });
    assert.equal(delivery.return.total, rSent.document.total);
    assert.equal((await one('SELECT count(*)::int AS n FROM wholesale_free_goods_kept WHERE business_id=$1 AND document_id=$2', [ws.id, rSent.document.id])).n, 0);
  });

  // --- A mechanic's commission taken back on a credit -------------------------------------------------------

  const G = (suffix) => `/businesses/${garage.id}/${suffix}`;
  const garageShop = (await request('GET', G('locations'))).items[0];
  const garageSlabs = (await request('GET', G('tax-rates'))).items;
  const gst18 = garageSlabs.find((r) => Number(r.rate) === 18);
  const desk = await staff(garage, 'irc-desk@test.invalid', 'cashier');
  const raju = await staff(garage, 'irc-raju@test.invalid', 'mechanic');
  const deskCall = as(desk.token);
  const cashier = async (method, route, body, expected = 200) => (await deskCall(method, route, body, expected)).data;
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const service = (body) => request('POST', G('catalog'), { kind: 'service', unit: 'service', taxRateId: gst18.id, ...body }, 201);
  const labour = await service({ name: 'General service labour', code: 'LAB-GEN', price: '1180', hsnCode: '998714' });
  const share = await service({ name: 'Insurance claim: owner\'s share', code: 'CLM-SHARE', price: '0', hsnCode: '998714' });
  const ravi = await request('POST', G('contacts'), { kind: 'customer', name: 'Ravi Kumar', phone: '9848022338' }, 201);
  const insurer = await request('POST', G('contacts'), { kind: 'customer', name: 'Bharat General Insurance', gstin: '36AABCB1234F1Z9' }, 201);
  await request('PUT', G('garage/settings'), { serviceMonths: 6, serviceKm: 5000, claimShareSkuId: share.id });
  await request('PUT', G('garage/commission/rates'), { skuId: labour.id, percent: '10' });
  const swift = await cashier('POST', G('garage/vehicles'), { registrationNo: 'TS09EA4521', make: 'Maruti Suzuki', model: 'Swift', fuel: 'petrol', owner: { contactId: ravi.id }, odometerKm: '41000' }, 201);
  const open = (extra = {}) => cashier('POST', G('garage/job-cards'), { requestKey: key(), locationId: garageShop.id, vehicleId: swift.id, complaints: ['Service'], ...extra }, 201);
  const toReady = async (job) => {
    await cashier('PUT', G(`garage/job-cards/${job.id}/mechanics`), { userIds: [raju.id] });
    await cashier('POST', G(`garage/job-cards/${job.id}/approvals`), { requestKey: key(), approvedBy: 'Ravi Kumar', channel: 'phone' }, 201);
    await cashier('POST', G(`garage/job-cards/${job.id}/status`), { status: 'in_progress' });
    return cashier('POST', G(`garage/job-cards/${job.id}/status`), { status: 'ready' });
  };
  const report = async () => (await request('GET', G('garage/commission'))).rows.find((r) => Number(r.user_id) === Number(raju.id));
  const reversals = () => rows('SELECT r.*,g.job_card_id FROM garage_commission_reversals r JOIN garage_commissions g ON g.id=r.commission_id WHERE r.business_id=$1 ORDER BY r.id', [garage.id]);

  await t.test('a labour line credited takes back its commission in proportion, to the paisa, dated the credit\'s day; a payout made stays', async () => {
    const job = await open();
    await cashier('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines: [{ kind: 'labour', skuId: labour.id, quantity: '3', unitPrice: '100' }] });
    await toReady(await cashier('GET', G(`garage/job-cards/${job.id}`)));
    const billed = await cashier('POST', G(`garage/job-cards/${job.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const [billLine] = await rows('SELECT id,net FROM business_document_lines WHERE document_id=$1 ORDER BY id', [billed.document_id]);
    // ₹300 with GST is ₹254.24 of labour: 10% is ₹25.42 to Raju, kept with the bill line that carries it.
    const [earned] = await rows('SELECT amount,base,document_line_id,line_net FROM garage_commissions WHERE business_id=$1 AND job_card_id=$2', [garage.id, job.id]);
    assert.deepEqual([earned.amount, earned.base, String(earned.document_line_id), earned.line_net, billLine.net], ['25.42', '254.24', String(billLine.id), '254.24', '254.24']);
    // A third of it credited: ₹84.75 of the labour, so ₹8.47 of the commission.
    const first = await request('POST', G(`documents/${billed.document_id}/returns`), { reason: 'One hour not done', requestKey: key(), lines: [{ lineId: billLine.id, quantity: '1' }] }, 201);
    let back = await reversals();
    assert.deepEqual(back.map((r) => [String(r.return_id), String(r.line_id), r.base, r.amount, r.reversed_on.toISOString ? r.reversed_on.toISOString().slice(0, 10) : r.reversed_on]),
      [[String(first.id), String(billLine.id), '84.75', '8.47', daysFrom(0)]]);
    assert.deepEqual([(await report()).earned, (await report()).taken_back, (await report()).due], ['25.42', '8.47', '16.95']);
    // What is due is paid; a later credit does not undo the payout.
    await request('POST', G(`garage/commission/${raju.id}/payouts`), { requestKey: key(), amount: '16.95', method: 'cash' }, 201);
    assert.equal((await report()).due, '0.00');
    const second = await request('POST', G(`documents/${billed.document_id}/returns`), { reason: 'Rest not done', requestKey: key(), lines: [{ lineId: billLine.id, quantity: '2' }] }, 201);
    back = await reversals();
    assert.deepEqual(back.map((r) => [r.base, r.amount]), [['84.75', '8.47'], ['169.49', '16.95']]);
    assert.equal(back.reduce((sum, r) => sum + paise(r.amount), 0), paise(earned.amount), 'all of it credited takes back exactly what was earned');
    const row = await report();
    assert.deepEqual([row.earned, row.taken_back, row.paid, row.due], ['25.42', '25.42', '16.95', '-16.95']);
    await expectRefused('POST', G(`garage/commission/${raju.id}/payouts`), { requestKey: key(), amount: '1', method: 'cash' }, 409, /owes 16\.95 of commission taken back on credits/);
    // The mechanic's lines show what was taken back, with the credit notes.
    const mine = await request('GET', G(`garage/commission/${raju.id}`));
    assert.deepEqual(mine.taken_back.map((r) => [r.return_no, r.document_no, r.label, r.amount]), [[first.return_no, billed.document_no, 'General service labour', '8.47'],
      [second.return_no, billed.document_no, 'General service labour', '16.95']]);
    // The activity log and the outbox.
    const logged = await audits(garage, 'garage_commission.taken_back');
    assert.deepEqual(logged.map((a) => [String(a.entity_id), a.details.mechanics.map((m) => [Number(m.userId), m.amount])]),
      [[String(first.id), [[Number(raju.id), '8.47']]], [String(second.id), [[Number(raju.id), '16.95']]]]);
    assert.equal((await events(garage, 'garage_commission.taken_back')).length, 2);
    await assert.rejects(pool.query('UPDATE garage_commission_reversals SET amount=0 WHERE business_id=$1', [garage.id]), /kept as it was worked out/);
    await assert.rejects(pool.query('DELETE FROM garage_commission_reversals WHERE business_id=$1', [garage.id]), /kept as it was worked out/);
  });

  await t.test('credited by value: an insurer\'s short payment written off takes back what its labour earned; billed to the owner, nothing is taken back', async () => {
    const claimed = async (claimNo) => {
      const job = await open({ complaints: ['Accident repair'] });
      const claimBody = { insurerId: insurer.id, mode: 'cashless', policyNo: `POL-${claimNo}`, claimNo };
      await cashier('PUT', G(`garage/job-cards/${job.id}/claim`), claimBody);
      await cashier('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines: [{ kind: 'labour', skuId: labour.id, quantity: '1', unitPrice: '1770', payer: 'insurer' }] });
      await cashier('PUT', G(`garage/job-cards/${job.id}/claim`), { ...claimBody, approvedAmount: '1500' });
      await toReady(await cashier('GET', G(`garage/job-cards/${job.id}`)));
      const billed = await cashier('POST', G(`garage/job-cards/${job.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
      await request('POST', G(`garage/job-cards/${job.id}/claim/payments`), { requestKey: key(), amount: '1000', method: 'bank' }, 201);
      return { job, billed };
    };
    const before = (await reversals()).length;
    // Written off: ₹500 of the insurer's ₹1,500 bill credited, ₹423.73 of it labour; the labour line billed ₹1,500.00, so ₹15.00 × 423.73 ÷ 1,500 of Raju's ₹150.00.
    const lost = await claimed('CLM-W');
    const [earned] = await rows('SELECT id,amount,line_net,document_line_id FROM garage_commissions WHERE business_id=$1 AND job_card_id=$2', [garage.id, lost.job.id]);
    assert.deepEqual([earned.amount, earned.line_net], ['150.00', '1500.00']);
    await cashier('POST', G(`garage/job-cards/${lost.job.id}/claim/settle`), { requestKey: key(), how: 'written_off', reason: 'Insurer cut the labour', approverId: ownerUser.id, pin: '2468' }, 201);
    const [credited] = await rows('SELECT rl.net FROM business_return_lines rl JOIN business_returns r ON r.id=rl.return_id WHERE r.document_id=$1', [lost.billed.insurer_document_id]);
    const taken = (await reversals()).filter((r) => String(r.job_card_id) === String(lost.job.id));
    assert.deepEqual([credited.net, taken.map((r) => [r.base, r.amount])], ['423.73', [['423.73', '42.37']]]);
    // Billed to the owner: the labour is still billed, so nothing is taken back.
    const moved = await claimed('CLM-B');
    await cashier('POST', G(`garage/job-cards/${moved.job.id}/claim/settle`), { requestKey: key(), how: 'billed', reason: 'Owner pays what the insurer cut' }, 201);
    assert.equal((await reversals()).filter((r) => String(r.job_card_id) === String(moved.job.id)).length, 0);
    assert.equal((await reversals()).length, before + 1);
  });
});
