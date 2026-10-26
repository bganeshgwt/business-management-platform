const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A laundry's and dry cleaner's own tools: the price list of garments and
// services (for each piece, pair or set, or by the kilo, with an express
// surcharge), garment orders taken in with a tag on every garment and what was
// noted about it, the work from received to ready on a rack, handovers billed
// through the core at intake or at delivery with the garments held until paid,
// orders not collected with the reminders sent, and damage claims settled
// with the core's credit notes and refunds. Money adds up to the paisa,
// postings are idempotent, the database keeps its rules, audit and events are
// written, and other types and other owners are kept out. Runs on its own
// throwaway database with every migration applied.
test('laundry and dry cleaning', { timeout: 300000 }, async (t) => {
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
  const password = `Wash-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('wash-owner');
  await owner('wash-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('wash-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('wash-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);

  const [laundry, grocery, garage] = await createBusinesses(request, 'OWNER', ['laundry', 'grocery', 'garage']);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['laundry']);
  const L = (suffix) => `/businesses/${laundry.id}/${suffix}`;

  await t.test('modules, permissions and roles per type', async () => {
    assert.ok(laundry.capabilities.includes('laundry'), 'a laundry starts with garment orders');
    assert.ok(laundry.capabilities.includes('receivables'), 'a laundry keeps its customers\' dues');
    for (const business of [grocery, garage]) assert.ok(!business.capabilities.includes('laundry'), `${business.business_type} has no garment orders`);
    const tools = await request('GET', L('modules'));
    const module = tools.find((m) => m.code === 'laundry');
    assert.equal(module.name, 'Garment orders');
    assert.deepEqual([...module.requires].sort(), ['catalog', 'contacts', 'sales']);
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'laundry'), 'a grocery is not offered garment orders');
    await request('PUT', `/businesses/${grocery.id}/modules/laundry`, { enabled: true }, 409);
    // Sales stays on while garment orders need it.
    await request('PUT', L('modules/sales'), { enabled: false }, 409);
    const permissions = await rows("SELECT code FROM business_permissions WHERE module_code='laundry' ORDER BY sort_order");
    assert.deepEqual(permissions.map((p) => p.code), ['laundry.view', 'laundry.create', 'laundry.edit', 'laundry.cancel', 'laundry.print', 'laundry.refund']);
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2`, [business.id, template])).p
      .filter((p) => p.startsWith('laundry.'));
    assert.deepEqual(await grants(laundry, 'manager'), ['laundry.cancel', 'laundry.create', 'laundry.edit', 'laundry.print', 'laundry.refund', 'laundry.view']);
    assert.deepEqual(await grants(laundry, 'cashier'), ['laundry.create', 'laundry.edit', 'laundry.print', 'laundry.view']);
    assert.deepEqual(await grants(laundry, 'stock_keeper'), ['laundry.edit', 'laundry.view']);
    assert.deepEqual(await grants(laundry, 'accountant'), ['laundry.print', 'laundry.view']);
    assert.deepEqual(await grants(laundry, 'viewer'), ['laundry.view']);
    assert.deepEqual(await grants(grocery, 'viewer'), ['laundry.view'], 'role copies match their templates everywhere');
    // No role of its own: the shared templates cover the counter and the work.
    assert.equal((await request('GET', L('roles?limit=100'))).items.length, 6);
    // Garment orders are numbered documents of their own.
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'")).d.includes("'laundry_order'"));
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_collection_refunds_source_check'")).d.includes("'laundry'"));
    assert.notEqual(String(elsewhere.id), String(laundry.id));
  });

  // --- Shared set-up: the shop, its GST slabs, its service items and customers ---------------------
  const shop = (await request('GET', L('locations'))).items[0];
  const slabs = (await request('GET', L('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const serviceItem = (body) => request('POST', L('catalog'), { kind: 'service', unit: 'service', price: '0', taxRateId: gst18.id, ...body }, 201);
  const customer = (name, phone, extra = {}) => request('POST', L('contacts'), { kind: 'customer', name, ...(phone ? { phone } : {}), ...extra }, 201);
  // A laundry may sell detergent and hangers over the counter too.
  await request('PUT', L('modules/inventory'), { enabled: true });

  await t.test('the database keeps the price list, orders, garments, handovers and claims within their rules', async () => {
    const item = await serviceItem({ name: 'Rule dry cleaning', code: 'RULE-DC', hsnCode: '999712' });
    const other = await serviceItem({ name: 'Rule pressing', code: 'RULE-PR' });
    const goods = await request('POST', L('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'Rule hanger', code: 'RULE-HANG', price: '10', taxRateId: gst18.id }, 201);
    const rule = await customer('Rule Customer', '9000000101');
    const supplier = await request('POST', L('contacts'), { kind: 'supplier', name: 'Rule Chemicals' }, 201);
    // A service is billed as a service item, keeps it, and is never deleted.
    const service = (sku) => one('INSERT INTO laundry_services(business_id,sku_id,created_by) VALUES($1,$2,$3) RETURNING *', [laundry.id, sku, ownerUser.id]);
    await assert.rejects(service(goods.id), /billed as a service item/);
    const dc = await service(item.id);
    await assert.rejects(service(item.id), /unique|duplicate/);
    await assert.rejects(pool.query('UPDATE laundry_services SET sku_id=$2 WHERE id=$1', [dc.id, other.id]), /keeps the item it is billed as/);
    await assert.rejects(pool.query('DELETE FROM laundry_services WHERE id=$1', [dc.id]), /never deleted/);
    // A garment is counted as a piece, a pair (two pieces) or a set; names are one per business; never deleted.
    const garment = (name, countedAs = 'piece', pieces = 1) => one('INSERT INTO laundry_garment_types(business_id,name,counted_as,pieces,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [laundry.id, name, countedAs, pieces, ownerUser.id]);
    const shirt = await garment('Rule shirt');
    await assert.rejects(garment('RULE SHIRT'), /unique|duplicate/);
    await assert.rejects(garment('Rule shoes', 'pair', 1), /check/);
    await assert.rejects(garment('Rule suit', 'set', 1), /check/);
    const suit = await garment('Rule suit', 'set', 3);
    await assert.rejects(pool.query('DELETE FROM laundry_garment_types WHERE id=$1', [shirt.id]), /never deleted/);
    await assert.rejects(pool.query("INSERT INTO laundry_prices(business_id,garment_type_id,service_id,per,price,updated_by) VALUES($1,$2,$3,'item',0,$4)", [laundry.id, shirt.id, dc.id, ownerUser.id]), /check/);
    // An order: for a customer, keeping what it was taken in with; its garments go on it when it is taken in.
    const takeIn = async (values = {}, items = [{}]) => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const order = (await db.query(`INSERT INTO laundry_orders(business_id,location_id,order_no,contact_id,customer_name,promised_on,bill_at,part_delivery,tax_mode,subtotal,tax,round_off,total,
            request_key,request_hash,created_by) VALUES($1,$2,$3,$4,'Rule Customer',$5,'delivery','whole_order','exclusive',100,18,0,118,$6,$7,$8) RETURNING *`,
        [laundry.id, shop.id, values.no || `RULE-${crypto.randomBytes(3).toString('hex')}`, values.contactId || rule.id, today, key(), 'x'.repeat(64), ownerUser.id])).rows[0];
        const made = [];
        for (const [index, extra] of items.entries()) {
          made.push((await db.query(`INSERT INTO laundry_order_items(business_id,order_id,seq,tag_no,garment_type_id,service_id,garment_name,service_name,sku_id,counted_as,per,quantity,pieces,
              rate,base,surcharge,amount,tax_rate,net,tax,acknowledged,risk_note) VALUES($1,$2,$3,$4,$5,$6,'Rule shirt','Rule dry cleaning',$7,$8,'item',1,1,100,100,0,100,18,100,18,$9,$10) RETURNING *`,
          [laundry.id, order.id, index + 1, extra.tag || `R${crypto.randomBytes(3).toString('hex').toUpperCase()}`, extra.garment || shirt.id, dc.id, extra.sku || item.id,
            extra.countedAs || 'piece', extra.acknowledged ?? false, extra.risk ?? null])).rows[0]);
        }
        await db.query('COMMIT');
        return { order, items: made };
      } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    };
    await assert.rejects(takeIn({ contactId: supplier.id }), /Choose a customer/);
    await assert.rejects(takeIn({}, [{ sku: other.id }]), /billed as the item of its service/);
    await assert.rejects(takeIn({}, [{ garment: suit.id }]), /counted as its kind of garment/);
    await assert.rejects(takeIn({}, [{ acknowledged: true }]), /check/);
    const { order, items: [first] } = await takeIn({}, [{ tag: 'RULE-1', acknowledged: true, risk: 'Old silk: colour may run' }]);
    // A tag is on one garment in the shop at a time.
    await assert.rejects(takeIn({}, [{ tag: 'RULE-1' }]), /unique|duplicate/);
    // Garments go on an order only when it is taken in.
    await assert.rejects(pool.query(`INSERT INTO laundry_order_items(business_id,order_id,seq,tag_no,garment_type_id,service_id,garment_name,service_name,sku_id,counted_as,per,quantity,pieces,
      rate,base,surcharge,amount,tax_rate,net,tax) VALUES($1,$2,2,'RULE-2',$3,$4,'Rule shirt','Rule dry cleaning',$5,'piece','item',1,1,100,100,0,100,18,100,18)`,
    [laundry.id, order.id, shirt.id, dc.id, item.id]), /when it is taken in/);
    // The order keeps what it was taken in with; its promised day and notes change; it is never deleted.
    await assert.rejects(pool.query("UPDATE laundry_orders SET customer_name='Someone else' WHERE id=$1", [order.id]), /keeps its number, customer, rules, prices and terms/);
    await pool.query("UPDATE laundry_orders SET promised_on=promised_on+1,notes='Call before 6 pm' WHERE id=$1", [order.id]);
    await assert.rejects(pool.query('DELETE FROM laundry_orders WHERE id=$1', [order.id]), /never deleted/);
    // A garment keeps what was noted and priced; it moves one allowed step at a time.
    await assert.rejects(pool.query("UPDATE laundry_order_items SET risk_note='Nothing said' WHERE id=$1", [first.id]), /keeps what was noted and priced/);
    await assert.rejects(pool.query("UPDATE laundry_order_items SET status='delivered',ready_at=now(),ready_by=$2,delivered_at=now(),delivered_by=$2 WHERE id=$1", [first.id, ownerUser.id]),
      /cannot go from received to delivered/);
    await assert.rejects(pool.query("UPDATE laundry_order_items SET status='ready' WHERE id=$1", [first.id]), /check/);
    await pool.query("UPDATE laundry_order_items SET status='ready',ready_at=now(),ready_by=$2,rack='A-12' WHERE id=$1", [first.id, ownerUser.id]);
    // Handed over only with its bill, in a handover of its order.
    await assert.rejects(pool.query("UPDATE laundry_order_items SET status='delivered',delivered_at=now(),delivered_by=$2 WHERE id=$1", [first.id, ownerUser.id]), /handed over with its bill/);
    await assert.rejects(pool.query("UPDATE laundry_order_items SET status='received',ready_at=NULL,ready_by=NULL,rack=NULL WHERE id=$1", [first.id]), /cannot go from ready to received/);
    await pool.query("UPDATE laundry_order_items SET status='in_process',ready_at=NULL,ready_by=NULL,rack=NULL WHERE id=$1", [first.id]);
    await assert.rejects(pool.query('DELETE FROM laundry_order_items WHERE id=$1', [first.id]), /never deleted/);
    // A claim waits for a decision, one at a time on a garment, is decided once and then never changes.
    const claim = () => one(`INSERT INTO laundry_claims(business_id,order_id,item_id,issue,description,reported_by,request_key,request_hash)
      VALUES($1,$2,$3,'stain','Black mark on the sleeve',$4,$5,$6) RETURNING *`, [laundry.id, order.id, first.id, ownerUser.id, key(), 'x'.repeat(64)]);
    const open = await claim();
    await assert.rejects(claim(), /unique|duplicate/);
    await assert.rejects(pool.query("UPDATE laundry_claims SET description='Changed' WHERE id=$1", [open.id]), /keeps what was reported/);
    await assert.rejects(pool.query("UPDATE laundry_claims SET decision='rejected',decided_by=$2,decided_at=now(),decide_key=$3,decide_hash=$4 WHERE id=$1",
      [open.id, ownerUser.id, key(), 'x'.repeat(64)]), /check/);
    await pool.query("UPDATE laundry_claims SET decision='rejected',decision_note='Stain was there at intake',decided_by=$2,decided_at=now(),decide_key=$3,decide_hash=$4 WHERE id=$1",
      [open.id, ownerUser.id, key(), 'x'.repeat(64)]);
    await assert.rejects(pool.query("UPDATE laundry_claims SET decision_note='Changed' WHERE id=$1", [open.id]), /was decided and no longer changes/);
    await assert.rejects(pool.query('DELETE FROM laundry_claims WHERE id=$1', [open.id]), /never deleted/);
    // Cancelled, a garment no longer changes and takes no claim.
    await pool.query("UPDATE laundry_order_items SET status='cancelled',cancel_reason='Customer took it back',cancelled_by=$2,cancelled_at=now() WHERE id=$1", [first.id, ownerUser.id]);
    await assert.rejects(pool.query("UPDATE laundry_order_items SET tag_no='RULE-9' WHERE id=$1", [first.id]), /was cancelled and no longer changes/);
    await assert.rejects(claim(), /cancelled garment takes no claim/);
    // A tag is free again once its garment leaves the shop.
    await takeIn({}, [{ tag: 'RULE-1' }]);
    // History and messages are kept as they were written.
    await pool.query("INSERT INTO laundry_order_events(business_id,order_id,note,created_by) VALUES($1,$2,'Rule note',$3)", [laundry.id, order.id, ownerUser.id]);
    await assert.rejects(pool.query("UPDATE laundry_order_events SET note='x' WHERE order_id=$1", [order.id]), /kept as it was written/);
    await pool.query("INSERT INTO laundry_notices(business_id,order_id,kind,channel,created_by) VALUES($1,$2,'reminder','whatsapp',$3)", [laundry.id, order.id, ownerUser.id]);
    await assert.rejects(pool.query('DELETE FROM laundry_notices WHERE order_id=$1', [order.id]), /kept as it was sent/);
    // Another owner's laundry is a business of its own.
    assert.equal((await one('SELECT count(*)::int AS n FROM laundry_orders WHERE business_id=$1', [elsewhere.id])).n, 0);
  });

  // --- Staff --------------------------------------------------------------------------------------------
  const roles = (await request('GET', L('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', L('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('wash-desk@test.invalid', 'cashier');
  const presser = await staff('wash-press@test.invalid', 'stock_keeper');
  const viewer = await staff('wash-viewer@test.invalid', 'viewer');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const approval = { approverId: ownerUser.id, pin: '2468' };
  let list, svc, garmentOf, orderA, orderB;

  await t.test('the price list: services billed as service items with their GST and SAC, garments counted as pieces, pairs or sets, prices for each one or by the kilo', async () => {
    // A service made with its own item takes the business's default slab (18%) and the SAC typed.
    list = await request('POST', L('laundry/services'), { item: { name: 'Dry cleaning', hsnCode: '999712' } }, 201);
    const dc = list.services.find((s) => s.name === 'Dry cleaning');
    assert.deepEqual([dc.tax_rate, dc.hsn_code, dc.unit], ['18.00', '999712', 'service']);
    assert.match(dc.item_code, /^LND-\d{2}$/);
    const item = await one('SELECT s.price,p.kind FROM catalog_skus s JOIN catalog_products p ON p.id=s.product_id WHERE s.id=$1', [dc.sku_id]);
    assert.deepEqual([item.price, item.kind], ['0.00', 'service'], 'its price is on the price list');
    list = await request('POST', L('laundry/services'), { item: { name: 'Wash & iron', taxRateId: gst18.id } }, 201);
    list = await request('POST', L('laundry/services'), { item: { name: 'Wash & fold' } }, 201);
    // An existing service item may be chosen; goods may not; one service per item.
    const press = await serviceItem({ name: 'Steam press', code: 'PRESS', hsnCode: '999712' });
    list = await request('POST', L('laundry/services'), { skuId: press.id, sortOrder: '4' }, 201);
    const hanger = (await request('GET', L('catalog?q=Rule hanger'))).items[0];
    assert.match((await refused('POST', L('laundry/services'), { skuId: hanger.id })).message, /not a service/);
    assert.equal((await refused('POST', L('laundry/services'), { skuId: press.id })).status, 409);
    // Only someone who keeps the catalogue changes the price list.
    assert.equal((await refused('POST', L('laundry/services'), { item: { name: 'Dyeing' } }, desk.token)).status, 403);
    svc = Object.fromEntries(list.services.filter((s) => !s.name.startsWith('Rule')).map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(svc).sort(), ['Dry cleaning', 'Steam press', 'Wash & fold', 'Wash & iron']);
    // Garments: a piece, a pair (two pieces) or a set with its pieces; names one each.
    for (const g of [{ name: 'Shirt' }, { name: 'Saree' }, { name: 'Suit (2 piece)', countedAs: 'set', pieces: '2' }, { name: 'Shoes', countedAs: 'pair' }, { name: 'Mixed clothes' }]) {
      list = await request('POST', L('laundry/garments'), g, 201);
    }
    assert.equal((await refused('POST', L('laundry/garments'), { name: 'shirt' })).status, 409);
    assert.match((await refused('POST', L('laundry/garments'), { name: 'Bedsheet set', countedAs: 'set', pieces: '1' })).message, /from 2 to 20/);
    garmentOf = (name) => list.garments.find((g) => g.name === name);
    assert.deepEqual([garmentOf('Shoes').pieces, garmentOf('Suit (2 piece)').pieces, garmentOf('Suit (2 piece)').counted_as], [2, 2, 'set']);
    // Prices for each one, or by the kilo; set together, changed in place, taken off with an empty price.
    const price = (garment, service, value, per = 'item') => ({ garmentTypeId: garmentOf(garment).id, serviceId: svc[service].id, per, price: value });
    list = await request('PUT', L('laundry/prices'), { prices: [price('Shirt', 'Wash & iron', '40'), price('Shirt', 'Dry cleaning', '120'), price('Saree', 'Dry cleaning', '350'),
      price('Suit (2 piece)', 'Dry cleaning', '499.50'), price('Mixed clothes', 'Wash & fold', '89.90', 'kg'), price('Shoes', 'Steam press', '75')] });
    assert.equal(list.prices.length, 6);
    list = await request('PUT', L('laundry/prices'), { prices: [price('Shoes', 'Steam press', null)] });
    assert.ok(!list.prices.some((p) => Number(p.garment_type_id) === Number(garmentOf('Shoes').id)), 'a price taken off the list');
    assert.match((await refused('PUT', L('laundry/prices'), { prices: [price('Shirt', 'Wash & iron', '0')] })).message, /Price must be/);
    assert.match((await refused('PUT', L('laundry/prices'), { prices: [price('Shirt', 'Wash & iron', '40.555')] })).message, /decimal/);
    const changed = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='laundry_price.changed' ORDER BY id DESC LIMIT 1", [laundry.id]);
    assert.deepEqual([changed.details.garment, changed.details.to], ['Shoes', null]);
    // The settings: billed at delivery and the whole order paid before any garment leaves, until changed; express surcharge none until set.
    const settings = await request('GET', L('laundry/settings'));
    assert.deepEqual([settings.billAt, settings.partDelivery, settings.expressPercent, settings.readyDays, settings.expressDays, settings.unclaimedDays],
      ['delivery', 'whole_order', '0.00', 3, 1, 30]);
    assert.equal((await refused('PUT', L('laundry/settings'), { expressPercent: '50' }, desk.token)).status, 403);
    const saved = await request('PUT', L('laundry/settings'), { expressPercent: '50', receiptTerms: 'Garments are held until paid. Please check your garments when you collect them.' });
    assert.deepEqual([saved.expressPercent, saved.billAt], ['50.00', 'delivery']);
    assert.match((await refused('PUT', L('laundry/settings'), { readyDays: '1', expressDays: '2' })).message, /no later than an ordinary one/);
    // A viewer reads the price list.
    assert.equal((await viewer.call('GET', L('laundry/price-list'))).services.length, list.services.length);
  });

  const asha = await customer('Asha Rao', '9876500101');
  const take = (body, by = request, expected = 201) => by('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, promisedOn: addDays(today, 2), ...body }, expected);
  const item = (garment, service, extra = {}) => ({ garmentTypeId: garmentOf(garment).id, serviceId: svc[service].id, ...extra });

  await t.test('taking in: each garment priced from the price list with the express surcharge and GST to the paisa, tagged, with what was noted kept', async () => {
    const body = { contactId: asha.id, express: true, items: [item('Shirt', 'Wash & iron', { quantity: '3', colour: 'White', brand: 'Arrow' }),
      item('Saree', 'Dry cleaning', { defects: ['stain'], defectNote: 'Old turmeric stain near the border', riskNote: 'Silk: colour may run', acknowledged: true, declaredValue: '6000' }),
      item('Mixed clothes', 'Wash & fold', { quantity: '2.345', pieces: '11' })], notes: 'Fold the shirts' };
    // The preview: what it will come to, with the promised day suggested (express: tomorrow).
    const preview = await desk.call('POST', L('laundry/orders/preview'), { locationId: shop.id, ...body });
    // Shirts 3 × 40.00 = 120.00 + 50% = 180.00 + 18% GST 32.40; saree 350.00 + 175.00 = 525.00 + 94.50;
    // 2.345 kg × 89.90 = 210.8155, to the paisa 210.82, + 105.41 = 316.23 + 56.92 (56.9214). Total 1,205.05.
    assert.deepEqual(preview.items.map((x) => [x.base, x.surcharge, x.amount, x.tax]),
      [['120.00', '60.00', '180.00', '32.40'], ['350.00', '175.00', '525.00', '94.50'], ['210.82', '105.41', '316.23', '56.92']]);
    assert.deepEqual([preview.subtotal, preview.tax, preview.round_off, preview.total, preview.pieces, preview.promisedOn, preview.billAt],
      ['1021.23', '183.82', '0.00', '1205.05', 15, addDays(today, 1), 'delivery']);
    // Taken in with an advance (a collection receipt: the customer's money on account).
    const taken = await take({ ...body, advance: { amount: '500', method: 'cash' } }, desk.call);
    orderA = taken;
    assert.match(taken.order_no, /^LO\//);
    assert.deepEqual([taken.status, taken.total, taken.express, taken.express_percent, taken.bill_at, taken.part_delivery, taken.advance.amount, taken.advance.free],
      ['received', '1205.05', true, '50.00', 'delivery', 'whole_order', '500.00', '500.00']);
    assert.deepEqual(taken.items.map((x) => [x.seq, x.tag_no, x.per, x.quantity, x.pieces, x.amount, x.status]),
      [[1, '1', 'item', '3.000', 3, '180.00', 'received'], [2, '2', 'item', '1.000', 1, '525.00', 'received'], [3, '3', 'kg', '2.345', 11, '316.23', 'received']]);
    assert.deepEqual([taken.items[1].defects, taken.items[1].risk_note, taken.items[1].acknowledged, taken.items[1].declared_value], [['stain'], 'Silk: colour may run', true, '6000.00']);
    assert.equal(taken.terms, 'Garments are held until paid. Please check your garments when you collect them.');
    assert.equal(paise(taken.subtotal) + paise(taken.tax) + paise(taken.round_off), paise(taken.total));
    // A repeat of the same intake is the same order; the same key with other data is refused.
    const again = { requestKey: key(), locationId: shop.id, promisedOn: addDays(today, 2), contactId: asha.id, items: [item('Shirt', 'Dry cleaning')] };
    const first = await request('POST', L('laundry/orders'), again, 201);
    assert.equal((await request('POST', L('laundry/orders'), again, 201)).id, first.id);
    assert.equal((await refused('POST', L('laundry/orders'), { ...again, express: true })).status, 409);
    // Typed tags are kept (upper case); a tag on a garment still in the shop is refused; the rest take the next numbers.
    const tagged = await take({ contactId: asha.id, items: [item('Shirt', 'Dry cleaning', { tagNo: 'a-7' }), item('Shirt', 'Wash & iron')] });
    assert.deepEqual(tagged.items.map((x) => x.tag_no), ['A-7', '5']);
    assert.match((await refused('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, promisedOn: today, contactId: asha.id, items: [item('Shirt', 'Dry cleaning', { tagNo: 'A-7' })] })).message,
      /Tag A-7 is on a garment of order .* still in the shop/);
    // What the price list says: a garment and service with no price, a bundle by the kilo without its weight or pieces, a passed promised day.
    const no = (items, extra = {}) => refused('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, promisedOn: today, contactId: asha.id, items, ...extra });
    assert.match((await no([item('Saree', 'Wash & iron')])).message, /Saree has no price for Wash & iron/);
    assert.match((await no([item('Mixed clothes', 'Wash & fold', { pieces: '4' })])).message, /priced by the kilo: give its weight/);
    assert.match((await no([item('Mixed clothes', 'Wash & fold', { quantity: '1.5' })])).message, /count the pieces/);
    assert.match((await no([item('Shirt', 'Wash & iron', { quantity: '1.5' })])).message, /whole number/);
    assert.match((await no([item('Shirt', 'Wash & iron')], { promisedOn: addDays(today, -1) })).message, /promised day cannot be one that has passed/);
    assert.match((await no([item('Shirt', 'Wash & iron', { acknowledged: true })])).message, /note them, or untick it/);
    // A new customer typed at the counter is made a customer.
    const walk = await take({ customer: { name: 'Ravi Teja', phone: '9876500102' }, items: [item('Suit (2 piece)', 'Dry cleaning')] }, desk.call);
    assert.deepEqual([walk.customer_name, walk.items[0].pieces, walk.items[0].counted_as], ['Ravi Teja', 2, 'set']);
    // The presser (a stock keeper, who does not see sales) sees orders without money, and does not take orders in.
    const seen = await presser.call('GET', L(`laundry/orders/${taken.id}`));
    assert.deepEqual([seen.money, seen.total, seen.items[0].amount, seen.advance], [false, null, null, null]);
    assert.equal((await presser.call('GET', L('laundry/orders'))).items[0].total, null);
    assert.equal((await viewer.call('GET', L(`laundry/orders/${taken.id}`))).total, '1205.05', 'a viewer sees sales, and the money');
    assert.equal((await refused('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, promisedOn: today, contactId: asha.id, items: [item('Shirt', 'Wash & iron')] }, presser.token)).status, 403);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='laundry_order.taken_in' AND entity_id=$2", [laundry.id, taken.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='laundry_order.taken_in' AND entity_id=$2", [laundry.id, taken.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='collection.recorded'", [laundry.id]));
  });

  const A = (suffix = '') => L(`laundry/orders/${orderA.id}${suffix}`);
  const idsOf = (order, ...seqs) => seqs.map((n) => order.items.find((x) => x.seq === n).id);

  await t.test('the work and a handover billed at delivery: the whole order billed at the first handover, the advance first, then the rest handed over', async () => {
    // Into the work, then ready on a rack (the presser does the work).
    let now = await presser.call('POST', A('/status'), { status: 'in_process' });
    assert.deepEqual([now.status, now.items.map((x) => x.status)], ['in_process', ['in_process', 'in_process', 'in_process']]);
    now = await presser.call('POST', A('/status'), { status: 'ready', itemIds: idsOf(orderA, 1, 3), rack: 'a-12' });
    assert.deepEqual([now.status, now.items.map((x) => x.rack)], ['part_ready', ['A-12', null, 'A-12']]);
    assert.match((await refused('POST', A('/status'), { status: 'in_process', itemIds: idsOf(orderA, 1) }, presser.token)).message, /Say why garment 1 goes back/);
    const racks = await desk.call('GET', L('laundry/racks'));
    assert.deepEqual(racks.items.filter((x) => x.order_id === orderA.id).map((x) => [x.tag_no, x.rack]), [['1', 'A-12'], ['3', 'A-12']]);
    // The presser does not bill; the desk does. The garments are held until the whole order is paid.
    assert.equal((await refused('POST', A('/deliver'), { requestKey: key(), itemIds: idsOf(orderA, 1, 3) }, presser.token)).status, 403);
    const held = await refused('POST', A('/deliver'), { requestKey: key(), itemIds: idsOf(orderA, 1, 3) }, desk.token);
    assert.deepEqual([held.status, held.data?.reason, held.data?.owed, held.data?.account], [409, 'unpaid', '705.05', false]);
    assert.match(held.message, /705\.05 is still to pay on order LO\/.*: they are held until it is paid/);
    // Paid: the bill covers every garment of the order (the saree still in the work too), one line a garment; the advance pays first.
    const body = { requestKey: key(), itemIds: idsOf(orderA, 1, 3), payment: { amount: 'full', method: 'upi', reference: 'UPI-7781' }, collectedBy: 'Asha\'s husband' };
    now = await desk.call('POST', A('/deliver'), body);
    assert.deepEqual([now.status, now.items.map((x) => x.status), now.deliveries.length, now.deliveries[0].collected_by], ['part_delivered', ['delivered', 'in_process', 'delivered'], 1, 'Asha\'s husband']);
    const bill = await request('GET', L(`documents/${now.deliveries[0].document_id}`));
    assert.deepEqual(bill.lines.map((l) => [l.label, l.quantity, l.unit_price, l.net, l.tax, l.hsn_code]), [
      ['Wash & iron · Shirt · express · tag 1', '3.000', '60.00', '180.00', '32.40', null],
      ['Dry cleaning · Saree · express · tag 2', '1.000', '525.00', '525.00', '94.50', '999712'],
      ['Wash & fold · Mixed clothes 2.345 kg, 11 pieces · express · tag 3', '1.000', '316.23', '316.23', '56.92', null]]);
    assert.deepEqual([bill.total, bill.contact_id, bill.payments.map((p) => [p.amount, p.method]).sort()], ['1205.05', asha.id, [['500.00', 'cash'], ['705.05', 'upi']]]);
    assert.equal(bill.payments.reduce((s, p) => s + paise(p.amount), 0), paise(bill.total), 'the advance and the payment are the bill, to the paisa');
    assert.deepEqual([now.advance.free, now.due, now.items[1].line_id !== null], ['0.00', '0.00', true]);
    // A repeat is the same handover; the same key with other data is refused.
    assert.equal((await desk.call('POST', A('/deliver'), body)).deliveries.length, 1);
    assert.equal((await refused('POST', A('/deliver'), { ...body, collectedBy: 'Someone else' }, desk.token)).status, 409);
    // The rest: ready, handed over with nothing more to pay or bill.
    await presser.call('POST', A('/status'), { status: 'ready', rack: 'B-3' });
    assert.match((await refused('POST', A('/deliver'), { requestKey: key(), payment: { amount: '10', method: 'cash' } }, desk.token)).message, /Nothing is owed/);
    now = await desk.call('POST', A('/deliver'), { requestKey: key() });
    assert.deepEqual([now.status, now.deliveries.length, now.deliveries[1].document_id, now.counts.delivered], ['delivered', 2, null, 3]);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND contact_id=$2', [laundry.id, asha.id])).n, 1, 'one bill for the order');
    orderA = now;
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='laundry_order.delivered' AND entity_id=$2", [laundry.id, orderA.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='laundry_order.delivered' AND entity_id=$2", [laundry.id, orderA.id]));
    // A delivered order's garments no longer change; their bill line is credited only from the order.
    assert.match((await refused('POST', A('/status'), { status: 'in_process' }, presser.token)).message, /can go into the work now|cannot go into the work/);
    const back = await refused('POST', L(`documents/${bill.id}/returns`), { requestKey: key(), reason: 'Changed mind', lines: [{ lineId: bill.lines[0].id, quantity: '1', restock: false }] });
    assert.deepEqual([back.status, /bills garment 1 of laundry order .* credited from the order/.test(back.message)], [409, true]);
  });

  await t.test('cancelling before the bill: garments cancelled with a reason, the advance handed back with a manager\'s PIN', async () => {
    const d = await take({ contactId: asha.id, items: [item('Shirt', 'Dry cleaning'), item('Saree', 'Dry cleaning')], advance: { amount: '200', method: 'upi', reference: 'UPI-1' } }, desk.call);
    // The desk does not cancel; a manager does, with a reason. A garment ready is cancelled too (returned unprocessed).
    assert.equal((await refused('POST', L(`laundry/orders/${d.id}/cancel`), { requestKey: key(), reason: 'Customer took them back' }, desk.token)).status, 403);
    await presser.call('POST', L(`laundry/orders/${d.id}/status`), { status: 'ready', itemIds: idsOf(d, 1), rack: 'C-1' });
    const body = { requestKey: key(), reason: 'Customer took them back unwashed' };
    // The advance comes off a bill while anything is left to bill.
    assert.match((await refused('POST', L(`laundry/orders/${d.id}/advance-refund`), { requestKey: key(), method: 'cash', ...approval, reason: 'Order cancelled' })).message, /still has garments to bill/);
    let now = await request('POST', L(`laundry/orders/${d.id}/cancel`), body);
    assert.deepEqual([now.status, now.items.map((x) => [x.status, x.rack, x.cancel_reason])], ['cancelled', [['cancelled', null, body.reason], ['cancelled', null, body.reason]]]);
    assert.equal((await request('POST', L(`laundry/orders/${d.id}/cancel`), body)).status, 'cancelled', 'asking again is the same cancellation');
    assert.equal((await refused('POST', L(`laundry/orders/${d.id}/cancel`), { ...body, reason: 'Other' })).status, 409);
    // The tags are free again.
    assert.ok(!(await rows("SELECT 1 FROM laundry_order_items WHERE business_id=$1 AND tag_no=ANY($2::text[]) AND status IN ('received','in_process','ready')",
      [laundry.id, now.items.map((x) => x.tag_no)])).length);
    // The advance: handed back by a manager's PIN, with a numbered refund.
    assert.equal((await refused('POST', L(`laundry/orders/${d.id}/advance-refund`), { requestKey: key(), method: 'cash', reason: 'Order cancelled' })).status, 400);
    const refund = await desk.call('POST', L(`laundry/orders/${d.id}/advance-refund`), { requestKey: key(), method: 'upi', reference: 'UPI-BACK-1', ...approval, reason: 'Order cancelled' }, 201);
    assert.deepEqual([refund.amount, refund.refund_no, refund.left], ['200.00', `${now.advance.collection_no}-R1`, '0.00']);
    now = await request('GET', L(`laundry/orders/${d.id}`));
    assert.deepEqual([now.advance.free, now.advance.refunded], ['0.00', '200.00']);
    assert.ok(await one("SELECT 1 FROM business_collection_refunds WHERE business_id=$1 AND source='laundry'", [laundry.id]));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='laundry_order.cancelled' AND entity_id=$2", [laundry.id, d.id]));
  });

  const meena = await customer('Meena Iyer', '9876500103');
  const account = await customer('Hotel Greenleaf', '9876500104', { creditDays: '30' });

  await t.test('billed at intake, each handover paying for its garments: held until paid, the customer\'s account, a garment cancelled part way with its credit note and refund', async () => {
    await request('PUT', L('laundry/settings'), { billAt: 'intake', partDelivery: 'garments' });
    // Billed now, one line a garment: 120.00 + 21.60; 499.50 + 89.91; 40.00 + 7.20; 778.21 in all, 100 paid now.
    orderB = await take({ contactId: meena.id, items: [item('Shirt', 'Dry cleaning'), item('Suit (2 piece)', 'Dry cleaning'), item('Shirt', 'Wash & iron')],
      payment: { amount: '100', method: 'cash' } }, desk.call);
    assert.deepEqual([orderB.bill_at, orderB.part_delivery, orderB.total, orderB.bills.length, orderB.bills[0].total, orderB.bills[0].paid, orderB.due],
      ['intake', 'garments', '778.21', 1, '778.21', '100.00', '678.21']);
    const intake = await request('GET', L(`documents/${orderB.document_id}`));
    assert.deepEqual(intake.lines.map((l) => [l.label, l.net, l.tax]), [[`Dry cleaning · Shirt · tag ${orderB.items[0].tag_no}`, '120.00', '21.60'],
      [`Dry cleaning · Suit (2 piece) · tag ${orderB.items[1].tag_no}`, '499.50', '89.91'], [`Wash & iron · Shirt · tag ${orderB.items[2].tag_no}`, '40.00', '7.20']]);
    assert.equal(orderB.items.every((x) => x.line_id !== null), true);
    // An advance is not taken when the bill is made at intake.
    assert.match((await refused('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, promisedOn: today, contactId: meena.id, items: [item('Shirt', 'Dry cleaning')],
      advance: { amount: '50', method: 'cash' } }, desk.token)).message, /bills orders at intake/);
    const B = (suffix) => L(`laundry/orders/${orderB.id}${suffix}`);
    await presser.call('POST', B('/status'), { status: 'ready', itemIds: idsOf(orderB, 1), rack: 'D-1' });
    // The shirt's charge is 141.60; 100 was paid: 41.60 is still to pay for it. No account: it is held.
    const held = await refused('POST', B('/deliver'), { requestKey: key(), itemIds: idsOf(orderB, 1) }, desk.token);
    assert.deepEqual([held.status, held.data?.owed], [409, '41.60']);
    assert.equal((await refused('POST', B('/deliver'), { requestKey: key(), itemIds: idsOf(orderB, 1), onAccount: true }, desk.token)).data?.reason, 'no_account');
    let now = await desk.call('POST', B('/deliver'), { requestKey: key(), itemIds: idsOf(orderB, 1), payment: { amount: '41.60', method: 'cash' } });
    assert.deepEqual([now.status, now.bills[0].paid, now.deliveries[0].document_id, now.deliveries[0].on_account], ['part_delivered', '141.60', null, false]);
    // The plain shirt is taken back unwashed: its line credited in full (47.20); nothing was paid beyond what is due, so nothing is refunded.
    now = await request('POST', B('/cancel'), { requestKey: key(), reason: 'Customer will wash it at home', itemIds: idsOf(orderB, 3) });
    const credited = await one(`SELECT r.total,rl.net,rl.tax FROM business_returns r JOIN business_return_lines rl ON rl.return_id=r.id WHERE r.document_id=$1`, [orderB.document_id]);
    assert.deepEqual([credited.total, credited.net, credited.tax, now.items[2].status, now.due], ['47.20', '40.00', '7.20', 'cancelled', '589.41']);
    assert.equal((await one('SELECT count(*)::int AS n FROM business_refunds WHERE document_id=$1', [orderB.document_id])).n, 0);
    // The suit: 589.41 still due for it; "full" pays what is owed on the order.
    await presser.call('POST', B('/status'), { status: 'ready', itemIds: idsOf(orderB, 2), rack: 'D-2' });
    now = await desk.call('POST', B('/deliver'), { requestKey: key(), payment: { amount: 'full', method: 'card' } });
    assert.deepEqual([now.status, now.due, now.bills[0].paid, now.counts.delivered, now.counts.cancelled], ['delivered', '0.00', '731.01', 2, 1]);
    assert.equal(paise('778.21') - paise('47.20'), paise('731.01'), 'the bill less its credit note is what was paid, to the paisa');
    // A customer with an account (credit days on their record) takes their garments with the money still owed on the account.
    const hotel = await take({ contactId: account.id, items: [item('Saree', 'Dry cleaning'), item('Shirt', 'Wash & iron', { quantity: '12' })] }, desk.call);
    await presser.call('POST', L(`laundry/orders/${hotel.id}/status`), { status: 'ready' });
    const onAccount = await desk.call('POST', L(`laundry/orders/${hotel.id}/deliver`), { requestKey: key(), onAccount: true, note: 'Monthly account' });
    // 350.00 + 63.00 for the saree, 12 × 40.00 = 480.00 + 86.40 for the shirts: 979.40 on the account.
    assert.deepEqual([onAccount.status, onAccount.deliveries[0].on_account, onAccount.due, onAccount.items[1].pieces], ['delivered', true, '979.40', 12]);
    assert.equal((await one('SELECT due_on::text AS d FROM business_documents WHERE id=$1', [hotel.document_id])).d, addDays(today, 30), 'the bill falls due on the account\'s days');
    // Paid in full at intake, a garment cancelled with the money back: a credit note, then the core's refund, with a manager's PIN.
    const paid = await take({ contactId: meena.id, items: [item('Saree', 'Dry cleaning'), item('Shirt', 'Wash & iron')], payment: { amount: 'full', method: 'upi', reference: 'UPI-9' } }, desk.call);
    const P = (suffix) => L(`laundry/orders/${paid.id}${suffix}`);
    const refundBody = { requestKey: key(), reason: 'Shirt not needed now', itemIds: idsOf(paid, 2), refund: { method: 'cash' } };
    assert.equal((await refused('POST', P('/cancel'), refundBody)).data?.reason, 'approval_needed');
    now = await request('POST', P('/cancel'), { ...refundBody, approval });
    const refund = await one('SELECT amount,method FROM business_refunds WHERE document_id=$1', [paid.document_id]);
    assert.deepEqual([refund.amount, refund.method, now.due, now.items.map((x) => x.status)], ['47.20', 'cash', '0.00', ['received', 'cancelled']]);
    const audit = await one("SELECT actor_id,details FROM business_audit WHERE business_id=$1 AND action='laundry_order.cancelled' AND entity_id=$2", [laundry.id, paid.id]);
    assert.deepEqual([Number(audit.actor_id), audit.details.credits[0].refund], [Number(ownerUser.id), '47.20']);
    // Nothing in the shop is left to cancel twice.
    assert.equal((await refused('POST', P('/cancel'), { requestKey: key(), reason: 'Again', itemIds: idsOf(paid, 2) })).status, 409);
  });

  await t.test('billed at delivery, each handover billing its own garments: the advance spread over the bills, GST at the rate of the day', async () => {
    await request('PUT', L('laundry/settings'), { billAt: 'delivery', partDelivery: 'garments' });
    const order = await take({ contactId: meena.id, items: [item('Shirt', 'Dry cleaning'), item('Saree', 'Dry cleaning')], advance: { amount: '200', method: 'cash' } }, desk.call);
    const O = (suffix = '') => L(`laundry/orders/${order.id}${suffix}`);
    assert.deepEqual([order.bill_at, order.part_delivery, order.total], ['delivery', 'garments', '554.60']);
    await presser.call('POST', O('/status'), { status: 'ready', itemIds: idsOf(order, 1) });
    // The shirt's bill (141.60) is paid by the advance: nothing to pay now.
    let now = await desk.call('POST', O('/deliver'), { requestKey: key() });
    assert.deepEqual([now.status, now.bills.map((b) => [b.total, b.paid]), now.advance.free], ['part_delivered', [['141.60', '141.60']], '58.40']);
    // GST on dry cleaning changes before the saree is handed over: its price before GST is kept, GST worked out at the rate of the day.
    const sku = await request('GET', L(`catalog?q=${encodeURIComponent('Dry cleaning')}`));
    const dryCleaning = sku.items.find((s) => s.label === 'Dry cleaning');
    await request('PATCH', L(`catalog/${dryCleaning.id}`), { label: dryCleaning.label, price: dryCleaning.price, taxRateId: gst5.id });
    const before = await request('GET', O());
    assert.deepEqual([before.bill.subtotal, before.bill.tax, before.bill.total, before.bill.advance, before.bill.due, before.bill.rate_changed], ['350.00', '17.50', '367.50', '58.40', '309.10', true]);
    await presser.call('POST', O('/status'), { status: 'ready' });
    const held = await refused('POST', O('/deliver'), { requestKey: key() }, desk.token);
    assert.deepEqual([held.status, held.data?.owed], [409, '309.10']);
    now = await desk.call('POST', O('/deliver'), { requestKey: key(), payment: { amount: 'full', method: 'upi', reference: 'UPI-55' } });
    assert.deepEqual([now.status, now.bills.map((b) => [b.total, b.paid, b.due]), now.advance.free], ['delivered', [['141.60', '141.60', '0.00'], ['367.50', '367.50', '0.00']], '0.00']);
    const second = await request('GET', L(`documents/${now.bills[1].id}`));
    assert.deepEqual([second.lines[0].net, second.lines[0].tax, second.lines[0].tax_rate], ['350.00', '17.50', '5.00']);
    assert.deepEqual(second.payments.map((p) => [p.amount, p.method]).sort(), [['309.10', 'upi'], ['58.40', 'cash']]);
    // The advance, 200.00, is the two payments from it, to the paisa.
    assert.equal(paise('141.60') + paise('58.40'), paise(order.advance.amount));
    await request('PATCH', L(`catalog/${dryCleaning.id}`), { label: dryCleaning.label, price: dryCleaning.price, taxRateId: gst18.id });
  });

  await t.test('damage claims: a manager\'s decision through the core\'s credit note and refund, at most the garment\'s charge; reprocessing, a credit, a rejection', async () => {
    const saree = orderA.items.find((x) => x.seq === 2);
    // The desk records what the customer says; one claim at a time on a garment waits for a decision.
    let now = await desk.call('POST', A('/claims'), { requestKey: key(), itemId: saree.id, issue: 'colour_run', description: 'Colour ran onto the border; customer has photos', askedAmount: '6000' }, 201);
    const claim = now.claims.at(-1);
    assert.deepEqual([claim.issue, claim.asked_amount, claim.decision, claim.reported_by_name], ['colour_run', '6000.00', null, 'wash-desk']);
    assert.equal((await refused('POST', A('/claims'), { requestKey: key(), itemId: saree.id, issue: 'stain', description: 'Again' }, desk.token)).status, 409);
    const decide = (id, body, token = ownerToken) => call('POST', L(`laundry/claims/${id}/decide`), { requestKey: key(), ...body }, token);
    // Only a manager decides; never more than the garment's charge on the bill (525.00 + 94.50 GST); money back needs the PIN.
    assert.equal((await decide(claim.id, { decision: 'rejected', note: 'No' }, desk.token)).status, 403);
    const over = await decide(claim.id, { decision: 'refund', amount: '700', refund: { method: 'cash' }, approval });
    assert.deepEqual([over.status, over.body.data?.reason, over.body.data?.charge], [400, 'over_charge', '619.50']);
    assert.match(over.body.message, /Compensation beyond the charge is paid outside the bill/);
    assert.equal((await decide(claim.id, { decision: 'refund', amount: '300', refund: { method: 'cash' } })).body.data?.reason, 'approval_needed');
    const body = { requestKey: key(), decision: 'refund', amount: '300', note: 'Goodwill: half the charge back', refund: { method: 'cash' }, approval };
    now = await request('POST', L(`laundry/claims/${claim.id}/decide`), body);
    const decided = now.claims.find((x) => x.id === claim.id);
    assert.deepEqual([decided.decision, decided.amount, decided.refunded, decided.credit_total, decided.decided_by_name, decided.refund_method], ['refund', '300.00', '300.00', '300.00', 'wash-owner', 'cash']);
    // The credit note splits GST in the line's own proportion: 300 × 525.00 / 619.50 = 254.24, and 45.76 GST.
    const credit = await one('SELECT rl.net,rl.tax FROM business_return_lines rl JOIN business_returns r ON r.id=rl.return_id WHERE r.id=$1', [decided.return_id]);
    assert.deepEqual([credit.net, credit.tax], ['254.24', '45.76']);
    assert.equal(paise(credit.net) + paise(credit.tax), 30000);
    const bill = await request('GET', L(`documents/${saree.document_id}`));
    assert.deepEqual([bill.refunds.map((f) => [f.amount, f.method]), bill.returns.map((r) => r.total)], [[['300.00', 'cash']], ['300.00']]);
    // Asking again is the same decision; a decided claim never changes.
    assert.equal((await request('POST', L(`laundry/claims/${claim.id}/decide`), body)).claims.find((x) => x.id === claim.id).refunded, '300.00');
    assert.equal((await one('SELECT count(*)::int AS n FROM business_refunds WHERE document_id=$1', [saree.document_id])).n, 1);
    assert.equal((await decide(claim.id, { decision: 'rejected', note: 'Changed my mind' })).status, 409);
    // The garment's charge was credited once: a second claim on it is decided without money (rejected, with a note why).
    now = await desk.call('POST', A('/claims'), { requestKey: key(), itemId: saree.id, issue: 'damage', description: 'Small tear at the pleats' }, 201);
    const second = now.claims.at(-1);
    assert.match((await decide(second.id, { decision: 'credit', amount: '50' })).body.message, /credited already/);
    assert.match((await decide(second.id, { decision: 'rejected' })).body.message, /Say why the claim is rejected/);
    now = await request('POST', L(`laundry/claims/${second.id}/decide`), { requestKey: key(), decision: 'rejected', note: 'Tear noted at intake: worn fabric' });
    assert.equal(now.claims.find((x) => x.id === second.id).decision, 'rejected');
    // Reprocessing a delivered garment: it comes back into the work under its tag, and is handed over again with nothing more to bill.
    const shirts = orderA.items.find((x) => x.seq === 1);
    now = await desk.call('POST', A('/claims'), { requestKey: key(), itemId: shirts.id, issue: 'stain', description: 'Collar not clean' }, 201);
    now = await request('POST', L(`laundry/claims/${now.claims.at(-1).id}/decide`), { requestKey: key(), decision: 'reprocess', note: 'Wash again' });
    const again = now.items.find((x) => x.id === shirts.id);
    assert.deepEqual([again.status, again.tag_no, again.delivered_at, now.status], ['received', '1', null, 'part_delivered']);
    await presser.call('POST', A('/status'), { status: 'ready', rack: 'A-1' });
    now = await desk.call('POST', A('/deliver'), { requestKey: key() });
    assert.deepEqual([now.status, now.deliveries.length, now.deliveries.at(-1).document_id, now.deliveries.at(-1).tags], ['delivered', 3, null, ['1']]);
    // A credit note only: it lowers what the customer owes (the hotel's account).
    const hotel = (await request('GET', L(`laundry/orders?contact=${account.id}`))).items[0];
    const hotelOrder = await request('GET', L(`laundry/orders/${hotel.id}`));
    now = await desk.call('POST', L(`laundry/orders/${hotel.id}/claims`), { requestKey: key(), itemId: hotelOrder.items[0].id, issue: 'shrinkage', description: 'Saree shrank' }, 201);
    now = await request('POST', L(`laundry/claims/${now.claims.at(-1).id}/decide`), { requestKey: key(), decision: 'credit', amount: '100' });
    assert.deepEqual([now.claims.at(-1).decision, now.claims.at(-1).refunded, now.due], ['credit', null, '879.40']);
    // A claim's list: those waiting first; a cancelled garment takes none.
    const claims = await viewer.call('GET', L('laundry/claims'));
    assert.ok(claims.items.length >= 4 && claims.items.every((x) => x.open === false));
    const cancelled = (await request('GET', L(`laundry/orders/${orderB.id}`))).items.find((x) => x.status === 'cancelled');
    assert.equal((await refused('POST', L(`laundry/orders/${orderB.id}/claims`), { requestKey: key(), itemId: cancelled.id, issue: 'lost', description: 'x' }, desk.token)).status, 409);
    const audit = await one("SELECT actor_id,details FROM business_audit WHERE business_id=$1 AND action='laundry_claim.decided' AND entity_id=$2", [laundry.id, claim.id]);
    assert.deepEqual([Number(audit.actor_id), audit.details.refund, audit.details.decision], [Number(ownerUser.id), '300.00', 'refund']);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='laundry_claim.decided' AND entity_id=$2", [laundry.id, claim.id]));
  });

  await t.test('racks and search, the unclaimed list with the reminders sent, the bell, re-tagging and the promised day', async () => {
    const order = await take({ contactId: meena.id, items: [item('Shirt', 'Dry cleaning', { colour: 'Blue' }), item('Saree', 'Dry cleaning')] }, desk.call);
    const O = (suffix = '') => L(`laundry/orders/${order.id}${suffix}`);
    // Re-tagged and moved while in the shop; a tag in use is refused.
    const [shirt, saree] = order.items;
    let now = await presser.call('PATCH', O(`/items/${shirt.id}`), { tagNo: 'z-90' });
    assert.equal(now.items[0].tag_no, 'Z-90');
    assert.equal((await refused('PATCH', O(`/items/${saree.id}`), { tagNo: 'Z-90' }, presser.token)).status, 409);
    assert.match((await refused('PATCH', O(`/items/${saree.id}`), { rack: 'E-1' }, presser.token)).message, /goes on a rack once it is ready/);
    now = await presser.call('POST', O('/status'), { status: 'ready', rack: 'E-1' });
    now = await presser.call('PATCH', O(`/items/${saree.id}`), { rack: 'e-2' });
    assert.deepEqual(now.items.map((x) => x.rack), ['E-1', 'E-2']);
    // Found by tag, phone or order number; the racks list what is ready.
    assert.deepEqual((await desk.call('GET', L('laundry/items?q=Z-90'))).items.map((x) => [x.order_no, x.colour, x.rack]), [[order.order_no, 'Blue', 'E-1']]);
    assert.ok((await desk.call('GET', L(`laundry/items?q=9876500103&in_shop=true`))).items.every((x) => x.customer_name === 'Meena Iyer' && x.in_shop));
    assert.equal((await desk.call('GET', L(`laundry/items?q=${encodeURIComponent(order.order_no)}`))).items.length, 2);
    assert.deepEqual((await desk.call('GET', L('laundry/racks?rack=E-2'))).items.map((x) => x.tag_no), [saree.tag_no]);
    // Ready and not collected for the business's days (30): unclaimed, with each reminder kept; nothing is disposed of.
    assert.ok(!(await request('GET', L('laundry/unclaimed'))).items.some((x) => x.id === order.id));
    await pool.query("UPDATE laundry_order_items SET ready_at=ready_at-interval '31 days' WHERE order_id=$1", [order.id]);
    let unclaimed = (await desk.call('GET', L('laundry/unclaimed'))).items.find((x) => x.id === order.id);
    assert.deepEqual([unclaimed.days_ready, unclaimed.reminders, unclaimed.status, unclaimed.ready_pieces, paise(unclaimed.balance)], [31, 0, 'ready', 2, 55460]);
    const told = await desk.call('POST', O('/notices'), { kind: 'reminder', channel: 'whatsapp' }, 201);
    assert.deepEqual([told.reminders, told.kind], [1, 'reminder']);
    unclaimed = (await desk.call('GET', L('laundry/unclaimed'))).items.find((x) => x.id === order.id);
    assert.equal(unclaimed.reminders, 1);
    await assert.rejects(pool.query('DELETE FROM laundry_notices WHERE order_id=$1', [order.id]), /kept as it was sent/);
    // The day's picture and the bell: an order past its promised day, and those not collected.
    const late = await take({ contactId: meena.id, items: [item('Shirt', 'Wash & iron')] }, desk.call);
    await pool.query('UPDATE laundry_orders SET promised_on=$2 WHERE id=$1', [late.id, addDays(today, -2)]);
    const counts = await desk.call('GET', L('laundry/orders/counts'));
    assert.ok(counts.overdue >= 1 && counts.unclaimed >= 1 && counts.open >= 2);
    const bell = await request('GET', L('notifications'));
    assert.ok(bell.items.some((n) => n.category === 'Garment orders' && n.title === `${late.order_no} is past its promised day` && /promised 2 days ago/.test(n.detail)));
    assert.ok(bell.items.some((n) => n.category === 'Garment orders' && /ready and not collected for 30 days or more/.test(n.title)));
    // The promised day moves forward (never to a day passed); the board's open orders by promised day.
    assert.match((await refused('PATCH', L(`laundry/orders/${late.id}`), { promisedOn: addDays(today, -1) }, desk.token)).message, /cannot be one that has passed/);
    now = await desk.call('PATCH', L(`laundry/orders/${late.id}`), { promisedOn: addDays(today, 1), notes: 'Customer travelling' });
    assert.deepEqual([now.promised_on, now.notes], [addDays(today, 1), 'Customer travelling']);
    const open = await desk.call('GET', L('laundry/orders/open?status=ready'));
    assert.ok(open.items.some((x) => x.id === order.id) && open.items.every((x) => x.status === 'ready'));
  });

  await t.test('other types and other owners are kept out', async () => {
    // A grocery and a garage have no garment orders: refused before anything is read.
    assert.equal((await refused('GET', `/businesses/${grocery.id}/laundry/orders`)).status, 403);
    assert.equal((await refused('GET', `/businesses/${garage.id}/laundry/price-list`)).status, 403);
    assert.equal((await refused('POST', `/businesses/${garage.id}/laundry/orders`, { requestKey: key(), locationId: shop.id, promisedOn: today, contactId: asha.id, items: [] })).status, 403);
    // The price list's catalogue routes answer for a laundry only.
    assert.equal((await refused('POST', `/businesses/${grocery.id}/laundry/garments`, { name: 'Shirt' })).status, 404);
    // Another owner's laundry: not theirs to read, and their own has none of these orders.
    assert.equal((await refused('GET', L(`laundry/orders/${orderA.id}`), undefined, await login('wash-other@test.invalid'))).status, 404);
    assert.equal((await other('GET', `/businesses/${elsewhere.id}/laundry/orders`)).total, 0);
    // A viewer reads and changes nothing; the presser does the work but cancels nothing.
    assert.equal((await refused('POST', A('/status'), { status: 'in_process' }, viewer.token)).status, 403);
    assert.equal((await refused('POST', L(`laundry/orders/${orderB.id}/cancel`), { requestKey: key(), reason: 'x' }, presser.token)).status, 403);
  });
});
