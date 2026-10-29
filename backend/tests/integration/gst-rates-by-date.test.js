const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { ZONES, addDays, hourNow, today } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// GST rates by date, for both engines. A change moves items (a shop's
// catalogue items to one of its slabs, a restaurant's dishes to one of its tax
// rates) from a date entered ahead; it is cancelled before its date, or takes
// effect on the business's or restaurant's own date with no job running, and
// is kept for good with who entered it and why. From its date every sale,
// preview, quotation and type's own bill takes the new rate, a price that
// includes GST keeps its total unless the change keeps its part before GST,
// and every bill posted before keeps its rate. The clock is moved a day by
// giving the business (or restaurant) a time zone a day ahead. Runs on its own
// throwaway database with every migration applied.
test('GST rates by date', { timeout: 900000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, scratch, created = false;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (scratch) await scratch.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes the change model away and Up brings it back', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const left = async () => (await scratch.query(`SELECT
        (SELECT count(*)::int FROM pg_tables WHERE tablename IN ('business_tax_changes','business_tax_change_items')) AS tables,
        (SELECT count(*)::int FROM pg_proc WHERE proname IN ('business_tax_change_apply','business_tax_change_apply_menu','business_tax_change_price',
          'business_tax_change_today','restaurant_trading_date','business_tax_change_world','business_tax_changes_kept','business_tax_change_items_kept',
          'business_tax_rates_in_change')) AS functions,
        (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('business_tax_rates_in_change','tax_rates_in_change')) AS triggers`)).rows[0];
    assert.deepEqual(await left(), { tables: 2, functions: 9, triggers: 2 });
    // This migration's Down half, after those of every newer one.
    await migrate({ direction: 'down', count: 1791973000000, timestamp: true });
    assert.deepEqual(await left(), { tables: 0, functions: 0, triggers: 0 });
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await left(), { tables: 2, functions: 9, triggers: 2 });
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Gst-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('gst-owner');
  await owner('gst-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('gst-owner@test.invalid');
  const request = as(ownerToken);
  const otherToken = await login('gst-other@test.invalid');
  const other = as(otherToken);
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);

  // --- The clock ---------------------------------------------------------------------------
  // Two place-named zones whose dates are a day apart, each hours before its
  // midnight: a business is given the first for "the day before" and the
  // second for "the day of".
  const zones = ZONES.map((zone) => ({ zone, date: today(zone), hour: hourNow(zone) }));
  let clock = null;
  // Up to 22:00 in both: at least an hour before midnight, against a run of
  // minutes, and a pair at every hour of the day (with 20:00 and 21:00 there
  // was none from 09:00 to 10:00 UTC).
  for (const later of zones.filter((z) => z.hour <= 22)) {
    const earlier = zones.find((z) => z.date === addDays(later.date, -1) && z.hour <= 22);
    if (earlier) { clock = { before: earlier, after: later }; break; }
  }
  assert.ok(clock, 'two zones a day apart');
  const D = clock.before.date, D1 = clock.after.date;
  const dayBefore = (businessIds) => pool.query('UPDATE businesses SET timezone=$2 WHERE id=ANY($1::bigint[])', [businessIds, clock.before.zone]);
  const dayOf = (businessIds) => pool.query('UPDATE businesses SET timezone=$2 WHERE id=ANY($1::bigint[])', [businessIds, clock.after.zone]);

  // --- The shops -----------------------------------------------------------------------------
  const [mart, trade] = await withTools(request, await createBusinesses(request, 'GST', ['supermarket', 'wholesale']));
  const [elsewhere] = await createBusinesses(other, 'ELSE', ['supermarket']);
  await dayBefore([mart.id, trade.id]);
  const M = (suffix) => `/businesses/${mart.id}/${suffix}`;
  const W = (suffix) => `/businesses/${trade.id}/${suffix}`;
  const slabsOf = async (business, by = request) => {
    const slabs = (await by('GET', `/businesses/${business.id}/tax-rates?limit=100`)).items;
    return { nil: slabs.find((r) => Number(r.rate) === 0), gst5: slabs.find((r) => Number(r.rate) === 5), gst18: slabs.find((r) => Number(r.rate) === 18), gst40: slabs.find((r) => Number(r.rate) === 40) };
  };
  const ms = await slabsOf(mart);
  const ws = await slabsOf(trade);
  const gst12 = await request('POST', M('tax-rates'), { name: 'GST 12%', rate: '12' }, 201);
  const martShop = (await request('GET', M('locations'))).items[0];
  const martBranch = await request('POST', M('locations'), { name: 'Second branch', code: 'BR2' }, 201);
  const tradeShop = (await request('GET', W('locations'))).items[0];
  const biscuits = await request('POST', M('categories'), { name: 'Biscuits' }, 201);
  const creams = await request('POST', M('categories'), { name: 'Cream biscuits', parentId: biscuits.id }, 201);
  const goods = (business, body, by = request) => by('POST', `/businesses/${business.id}/catalog`, { kind: 'goods', tracking: 'quantity', unit: 'each', ...body }, 201);
  // A supermarket's prices include GST.
  const marie = await goods(mart, { name: 'Marie biscuit', code: 'MARIE', price: '118', taxRateId: ms.gst18.id, categoryId: biscuits.id, hsnCode: '19053100',
    openingStock: { locationId: martShop.id, quantity: '100', unitCost: '80' } });
  const bourbon = await goods(mart, { name: 'Bourbon cream', code: 'BOURBON', price: '59', taxRateId: ms.gst18.id, categoryId: creams.id, hsnCode: '19053200',
    openingStock: { locationId: martShop.id, quantity: '100', unitCost: '40' } });
  const namkeen = await goods(mart, { name: 'Namkeen mix', code: 'NAMKEEN', price: '50', taxRateId: ms.gst18.id, hsnCode: '21069099', mrp: '50',
    openingStock: { locationId: martShop.id, quantity: '100', unitCost: '30' } });
  const cashew = await goods(mart, { name: 'Cashew 200 g', code: 'CASHEW', price: '236', taxRateId: ms.gst18.id, hsnCode: '08013220', memberPrice: '224.20',
    openingStock: { locationId: martShop.id, quantity: '40', unitCost: '160' } });
  const tooth = await goods(mart, { name: 'Toothpaste', code: 'PASTE', price: '105', taxRateId: ms.gst5.id, hsnCode: '33061020', mrp: '110',
    openingStock: { locationId: martShop.id, quantity: '50', unitCost: '70' } });
  const cola = await goods(mart, { name: 'Cola 600 ml', code: 'COLA', price: '40', taxRateId: ms.gst40.id, hsnCode: '22021010',
    openingStock: { locationId: martShop.id, quantity: '100', unitCost: '25' } });
  await request('PUT', M(`catalog/${cashew.id}/branch-prices`), { prices: [{ locationId: martBranch.id, price: '240' }] });
  // A kit of two biscuits: its own rate is the highest of its parts'.
  const pack = await request('POST', M('kits'), { name: 'Tea-time pack', code: 'TEAPACK', price: '170', components: [{ skuId: marie.id, quantity: 1 }, { skuId: bourbon.id, quantity: 1 }] }, 201);
  assert.equal(Number(pack.tax_rate), 18);
  // A wholesaler's prices are before GST.
  const oil = await goods(trade, { name: 'Sunflower oil 1 L', code: 'OIL1L', price: '140', taxRateId: ws.gst18.id, hsnCode: '15121910',
    openingStock: { locationId: tradeShop.id, quantity: '200', unitCost: '110' } });
  const ghee = await goods(trade, { name: 'Ghee 500 ml', code: 'GHEE', price: '300', taxRateId: ws.gst18.id, hsnCode: '04059020', mrp: '360',
    openingStock: { locationId: tradeShop.id, quantity: '50', unitCost: '250' } });
  const retailer = await request('POST', W('contacts'), { kind: 'customer', name: 'Ravi Kirana' }, 201);
  const theirs = await goods(elsewhere, { name: 'Their biscuit', code: 'THEIRS', price: '10', taxRateId: (await slabsOf(elsewhere, other)).gst18.id }, other);

  // Staff: a cashier sells but does not edit the catalogue; a viewer only looks.
  const staffRole = async (business, email, template) => {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email, email, hash]);
    const roles = (await request('GET', `/businesses/${business.id}/roles?limit=100`)).items;
    await request('POST', `/businesses/${business.id}/members`, { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    return login(email);
  };
  const cashierToken = await staffRole(mart, 'gst-cashier@test.invalid', 'cashier');
  const cashier = as(cashierToken);
  const viewer = as(await staffRole(mart, 'gst-viewer@test.invalid', 'viewer'));

  const sale = (business, location, lines, extra = {}) => request('POST', `/businesses/${business.id}/documents`,
    { kind: 'sale', requestKey: key(), locationId: location.id, lines, payment: { method: 'upi', amount: 'full' }, ...extra }, 201);
  const linesOf = async (business, document) => (await request('GET', `/businesses/${business.id}/documents/${document.id}`)).lines;
  const itemOf = async (business, sku) => (await request('GET', `/businesses/${business.id}/catalog?q=${encodeURIComponent(sku.code)}`)).items.find((s) => Number(s.id) === Number(sku.id));

  // --- Previews and scheduling ----------------------------------------------------------------
  const before = {};
  await t.test('the preview finds items by slab, category, HSN or search, and says what each becomes', async () => {
    const preview = (body) => request('POST', M('tax-changes/preview'), { taxRateId: ms.gst5.id, startsOn: D1, ...body });
    const bySlab = await preview({ filters: { taxRateId: ms.gst18.id } });
    assert.deepEqual(bySlab.items.map((i) => i.label), ['Bourbon cream', 'Cashew 200 g', 'Marie biscuit', 'Namkeen mix']);
    assert.equal(bySlab.target.name, ms.gst5.name);
    assert.equal(bySlab.today, D);
    assert.equal(bySlab.dateProblem, null);
    // A price that includes GST keeps its total: the GST inside it is worked out again.
    const marieLine = bySlab.items.find((i) => i.id === Number(marie.id));
    assert.deepEqual({ from: marieLine.from.rate, price: marieLine.price, gst: marieLine.gst, total: marieLine.total },
      { from: '18.00', price: { before: '118.00', after: '118.00' }, gst: { before: '18.00', after: '5.62' }, total: { before: '118.00', after: '118.00' } });
    assert.equal(marieLine.pricesIncludeGst, true);
    // A category takes its sub-categories with it; an HSN code by its first digits; a search by name or code.
    assert.deepEqual((await preview({ filters: { categoryId: biscuits.id } })).items.map((i) => i.code), ['BOURBON', 'MARIE']);
    assert.deepEqual((await preview({ filters: { categoryId: creams.id } })).items.map((i) => i.code), ['BOURBON']);
    assert.deepEqual((await preview({ filters: { hsn: '1905' } })).items.map((i) => i.code), ['BOURBON', 'MARIE']);
    assert.deepEqual((await preview({ filters: { q: 'namk' } })).items.map((i) => i.code), ['NAMKEEN']);
    // A kit is never one: its GST is its parts'.
    assert.equal((await preview({ filters: { q: 'tea-time' } })).items.length, 0);
    // Keeping the part before GST: ₹118 at 18% is ₹105 at 5%.
    const net = await preview({ keeps: 'net', items: [marie.id] });
    assert.deepEqual(net.items[0].price, { before: '118.00', after: '105.00' });
    assert.deepEqual(net.items[0].gst, { before: '18.00', after: '5.00' });
    // Already at the slab then: shown, and left out of the count that moves.
    const same = await preview({ items: [tooth.id] });
    assert.equal(same.items[0].same, true);
    assert.equal(same.moving, 0);
    // The date: later than today, within two years.
    assert.match((await preview({ startsOn: D, items: [marie.id] })).dateProblem, /starts on a later day than today/);
    assert.match((await preview({ startsOn: addDays(D, 800), items: [marie.id] })).dateProblem, /within two years/);
    // A price before GST stays; its GST, and so the total, change.
    const oilLine = (await request('POST', W('tax-changes/preview'), { taxRateId: ws.gst5.id, startsOn: D1, items: [oil.id] })).items[0];
    assert.deepEqual({ price: oilLine.price, gst: oilLine.gst, total: oilLine.total, inclusive: oilLine.pricesIncludeGst },
      { price: { before: '140.00', after: '140.00' }, gst: { before: '25.20', after: '7.00' }, total: { before: '165.20', after: '147.00' }, inclusive: false });
    // Above the MRP after the change: named, so it can be left out.
    const ghee40 = (await request('POST', W('tax-changes/preview'), { taxRateId: ws.gst40.id, startsOn: D1, items: [ghee.id] })).items[0];
    assert.match(ghee40.problem, /Ghee 500 ml would sell at 420\.00 with GST, above its MRP of 360\.00/);
  });

  let biscuitChange, cashewChange;
  await t.test('a change is scheduled as one, idempotent, and refused where it cannot be', async () => {
    const body = { requestKey: key(), taxRateId: ms.gst5.id, startsOn: D1, keeps: 'total', reason: 'GST Council notification 9/2027-CT(R): biscuits and namkeen to 5%', items: [marie.id, bourbon.id, namkeen.id] };
    // Only someone allowed to edit the catalogue.
    assert.equal((await refused('POST', M('tax-changes'), body, cashierToken)).status, 403);
    assert.equal((await refused('POST', M('tax-changes/preview'), { taxRateId: ms.gst5.id, startsOn: D1, items: [marie.id] }, cashierToken)).status, 403);
    biscuitChange = await request('POST', M('tax-changes'), body, 201);
    assert.equal(biscuitChange.state, 'scheduled');
    assert.equal(biscuitChange.items.length, 3);
    assert.ok(biscuitChange.items.every((i) => i.status === 'scheduled'));
    assert.equal(biscuitChange.created_by_name, 'gst-owner');
    // The same request again is the same change; the same key with other data is refused.
    assert.equal((await request('POST', M('tax-changes'), body, 201)).id, biscuitChange.id);
    assert.equal((await refused('POST', M('tax-changes'), { ...body, reason: 'Something else' })).status, 409);
    // An item moves once on a day.
    const twice = await refused('POST', M('tax-changes'), { ...body, requestKey: key(), taxRateId: ms.gst40.id });
    assert.equal(twice.status, 409);
    assert.match(twice.message, /Marie biscuit already moves to GST 5% on/);
    // Keeping the part before GST (with its member and branch prices).
    cashewChange = await request('POST', M('tax-changes'), { requestKey: key(), taxRateId: ms.gst5.id, startsOn: D1, keeps: 'net', reason: 'Dry fruits to 5%, the benefit passed on', items: [cashew.id] }, 201);
    assert.equal(cashewChange.keeps, 'net');
    // Already at the slab, a date that is not ahead, an unknown item, another business's item.
    assert.match((await refused('POST', M('tax-changes'), { ...body, requestKey: key(), startsOn: addDays(D1, 1), items: [tooth.id] })).message, /already: leave it out of the change/);
    const today400 = await refused('POST', M('tax-changes'), { ...body, requestKey: key(), startsOn: D });
    assert.equal(today400.status, 400);
    assert.match(today400.message, /change its slab on the item itself/);
    assert.equal((await refused('POST', M('tax-changes'), { ...body, requestKey: key(), startsOn: addDays(D1, 3), items: [999999] })).status, 404);
    assert.equal((await refused('POST', M('tax-changes'), { ...body, requestKey: key(), startsOn: addDays(D1, 3), items: [theirs.id] })).status, 404);
    assert.equal((await refused('GET', M(`tax-changes/${biscuitChange.id}`), undefined, otherToken)).status, 404);
    assert.equal((await refused('POST', `/businesses/${elsewhere.id}/tax-changes`, body)).status, 404);
    // A reason is needed.
    assert.equal((await refused('POST', M('tax-changes'), { ...body, requestKey: key(), startsOn: addDays(D1, 3), reason: ' ' })).status, 400);
    // A slab items are to move to stays on until then.
    const later = await request('POST', M('tax-changes'), { requestKey: key(), taxRateId: gst12.id, startsOn: addDays(D1, 5), reason: 'Cola to 12%', items: [cola.id] }, 201);
    const off = await refused('PATCH', M(`tax-rates/${gst12.id}`), { name: gst12.name, active: false });
    assert.equal(off.status, 409);
    assert.match(off.message, /Items move to GST 12% on .* \(a scheduled GST rate change\)/);
    await request('POST', M(`tax-changes/${later.id}/cancel`), { reason: 'Cola stays at 40%' });
    await request('PATCH', M(`tax-rates/${gst12.id}`), { name: gst12.name, active: false });
    // The wholesaler's oil, its price before GST.
    await request('POST', W('tax-changes'), { requestKey: key(), taxRateId: ws.gst5.id, startsOn: D1, reason: 'Edible oils to 5%', items: [oil.id] }, 201);
    // A price above the MRP after the change is refused, naming it.
    const mrp = await refused('POST', W('tax-changes'), { requestKey: key(), taxRateId: ws.gst40.id, startsOn: D1, reason: 'Ghee to 40%', items: [ghee.id] });
    assert.equal(mrp.status, 409);
    assert.equal(mrp.data.reason, 'items_refused');
    // Seen by everyone who sees the catalogue; the list puts what is scheduled first.
    const listed = await viewer('GET', M('tax-changes'));
    assert.deepEqual(listed.items.slice(0, 2).map((c) => c.state), ['scheduled', 'scheduled']);
    assert.equal(listed.items.find((c) => c.id === biscuitChange.id).scheduled, 3);
    assert.equal((await viewer('GET', M('tax-changes?state=in_force'))).items.length, 0);
    const audit = await one("SELECT actor_id,details FROM business_audit WHERE business_id=$1 AND action='tax_change.scheduled' AND entity_id=$2", [mart.id, biscuitChange.id]);
    assert.equal(Number(audit.actor_id), Number(ownerUser.id));
    assert.equal(audit.details.items, 3);
  });

  await t.test('the day before: everything is at the old slab, with the change shown ahead', async () => {
    const bill = await sale(mart, martShop, [{ skuId: marie.id, quantity: '1' }]);
    before.bill = bill;
    const [line] = await linesOf(mart, bill);
    assert.equal(Number(line.tax_rate), 18);
    assert.equal(line.tax, '18.00');
    const quote = await request('POST', M('retail/quote'), { locationId: martShop.id, lines: [{ skuId: namkeen.id, quantity: '2' }] });
    assert.equal(Number(quote.lines[0].taxRate), 18);
    const item = await itemOf(mart, marie);
    assert.equal(Number(item.tax_rate), 18);
    assert.deepEqual(item.tax_change, { startsOn: D1, name: ms.gst5.name, rate: 5 });
    const history = await viewer('GET', M(`catalog/${marie.id}/tax-history`));
    assert.equal(history.item.slab_name, ms.gst18.name);
    assert.equal(history.changes.length, 1);
    assert.deepEqual({ status: history.changes[0].status, to: history.changes[0].to_name, reason: history.changes[0].reason },
      { status: 'scheduled', to: ms.gst5.name, reason: 'GST Council notification 9/2027-CT(R): biscuits and namkeen to 5%' });
    assert.equal(Number((await one('SELECT tax_rate FROM catalog_skus WHERE id=$1', [marie.id])).tax_rate), 18, 'nothing moves before its date');
  });

  await t.test('a scheduled change is cancelled before its date, one item or all of it', async () => {
    const keep = await request('POST', M('tax-changes'), { requestKey: key(), taxRateId: ms.gst18.id, startsOn: addDays(D1, 2), reason: 'Cola and toothpaste to 18% (withdrawn later)', items: [cola.id, tooth.id] }, 201);
    assert.equal((await refused('POST', M(`tax-changes/${keep.id}/cancel`), { reason: 'Withdrawn' }, cashierToken)).status, 403);
    assert.equal((await refused('POST', M(`tax-changes/${keep.id}/cancel`), {})).status, 400);
    const colaItem = keep.items.find((i) => Number(i.sku_id) === Number(cola.id));
    let now = await request('POST', M(`tax-changes/${keep.id}/items/${colaItem.id}/cancel`), { reason: 'Cola stays at 40%' });
    assert.deepEqual(now.items.map((i) => i.status).sort(), ['cancelled', 'scheduled']);
    assert.equal(now.items.find((i) => i.id === colaItem.id).cancelled_by_name, 'gst-owner');
    now = await request('POST', M(`tax-changes/${keep.id}/cancel`), { reason: 'Notification withdrawn' });
    assert.equal(now.state, 'cancelled');
    // Asking again is the same cancellation.
    assert.equal((await request('POST', M(`tax-changes/${keep.id}/cancel`), { reason: 'Notification withdrawn' })).state, 'cancelled');
    const audits = await rows("SELECT action FROM business_audit WHERE business_id=$1 AND entity_id=$2 AND action LIKE 'tax_change.%' ORDER BY id", [mart.id, keep.id]);
    assert.deepEqual(audits.map((a) => a.action), ['tax_change.scheduled', 'tax_change.item_cancelled', 'tax_change.cancelled']);
    // The database keeps a change as it was entered, and an item's change for good.
    await assert.rejects(pool.query('UPDATE business_tax_changes SET reason=$2 WHERE id=$1', [keep.id, 'x']), /kept as it was entered/);
    await assert.rejects(pool.query('DELETE FROM business_tax_change_items WHERE id=$1', [colaItem.id]), /kept for good/);
    await assert.rejects(pool.query("UPDATE business_tax_change_items SET status='scheduled' WHERE id=$1", [colaItem.id]), /kept as it is/);
  });

  // --- Every type's own bills --------------------------------------------------------------------
  // Each books an order at its price the day before, its item's slab changes
  // on the day of, and its own flow bills it on the day of at the rate of that
  // day: a price before GST keeps its taxable value, one that includes GST its
  // total. Jewellery, fuel and a room type keep their items where they are.
  const types = {};
  const minute = (n = 0) => new Date(Math.floor(Date.now() / 60000) * 60000 + n * 60000).toISOString();
  const typeChange = (business, items, taxRateId, reason) => request('POST', `/businesses/${business.id}/tax-changes`,
    { requestKey: key(), taxRateId, startsOn: D1, reason, items }, 201);
  await t.test('the day before: every type books its own orders at the old slab, and its items\' changes are scheduled', async () => {
    const made = await createBusinesses(request, 'GST', ['laundry', 'optical', 'garage', 'memberships', 'rentals', 'lodging', 'jewellery', 'fuel_station', 'hardware']);
    await dayBefore(made.map((b) => b.id));
    const [laundry, optical, garage, gym, rentals, lodge, jeweller, pump, hardware] = made;
    const at = (business) => (suffix) => `/businesses/${business.id}/${suffix}`;
    const firstLocation = async (business) => (await request('GET', at(business)('locations'))).items[0];
    const customer = (business, name, phone) => request('POST', at(business)('contacts'), { kind: 'customer', name, phone }, 201);

    // Laundry: a dry-cleaning service at 18%, its price before GST.
    const L = at(laundry), ls = await slabsOf(laundry), counter = await firstLocation(laundry);
    let list = await request('POST', L('laundry/services'), { item: { name: 'Dry cleaning', taxRateId: ls.gst18.id, hsnCode: '999712' } }, 201);
    const dry = list.services.find((s) => s.name === 'Dry cleaning');
    list = await request('POST', L('laundry/garments'), { name: 'Shirt' }, 201);
    const shirt = list.garments.find((g) => g.name === 'Shirt');
    await request('PUT', L('laundry/prices'), { prices: [{ garmentTypeId: shirt.id, serviceId: dry.id, per: 'item', price: '120' }] });
    const meena = await customer(laundry, 'Meena Iyer', '9876500103');
    const garments = await request('POST', L('laundry/orders'), { requestKey: key(), locationId: counter.id, promisedOn: addDays(D, 2), contactId: meena.id,
      items: [{ garmentTypeId: shirt.id, serviceId: dry.id }] }, 201);
    assert.deepEqual({ rate: Number(garments.items[0].tax_rate), tax: garments.items[0].tax }, { rate: 18, tax: '21.60' });
    await typeChange(laundry, [dry.sku_id], ls.gst5.id, 'Dry cleaning to 5%');
    types.laundry = { business: laundry, L, garments };

    // Optical: lens glazing, a service at 18%, its price including GST (₹2,360).
    const O = at(optical), os = await slabsOf(optical), store = await firstLocation(optical);
    const glazing = await request('POST', O('catalog'), { kind: 'service', unit: 'service', name: 'Lens glazing', code: 'GLAZE', price: '2360', taxRateId: os.gst18.id, hsnCode: '998729' }, 201);
    const anitha = await customer(optical, 'Anitha Reddy', '9876543210');
    const rx = await request('POST', O('optical/prescriptions'), { requestKey: key(), contactId: anitha.id, rows: [{ eye: 'right', zone: 'distance', sph: '-1' }] }, 201);
    const spectacles = await request('POST', O('optical/orders'), { requestKey: key(), locationId: store.id, prescriptionId: rx.id,
      frame: { ownFrame: true, description: 'Her own frame' }, lenses: [{ eye: 'right', lensType: 'single_vision' }], items: [{ skuId: glazing.id, quantity: '1' }],
      measurements: { pdRight: '31.5' }, madeAt: 'in_house', promisedOn: addDays(D, 3) }, 201);
    await typeChange(optical, [glazing.id], os.gst5.id, 'Spectacle glazing to 5%');
    types.optical = { business: optical, O, spectacles };

    // Garage: labour, a service at 18%, its price including GST (₹1,180).
    const G = at(garage), gs = await slabsOf(garage), bay = await firstLocation(garage);
    const labour = await request('POST', G('catalog'), { kind: 'service', unit: 'service', name: 'General service labour', code: 'LAB-GEN', price: '1180', taxRateId: gs.gst18.id, hsnCode: '998714' }, 201);
    const ravi = await customer(garage, 'Ravi Kumar', '9848022338');
    const car = await request('POST', G('garage/vehicles'), { registrationNo: 'TS08JK3344', make: 'Hyundai', model: 'i20', owner: { contactId: ravi.id } }, 201);
    const job = await request('POST', G('garage/job-cards'), { requestKey: key(), locationId: bay.id, vehicleId: car.id, complaints: ['General service'] }, 201);
    await request('PUT', G(`garage/job-cards/${job.id}/estimate`), { requestKey: key(), lines: [{ kind: 'labour', skuId: labour.id, quantity: '1', unitPrice: '1180' }] });
    await typeChange(garage, [labour.id], gs.gst5.id, 'Vehicle service labour to 5%');
    types.garage = { business: garage, G, job };

    // A gym: a plan's item at 18%, its price before GST; a membership sold the day before.
    const Y = at(gym), ys = await slabsOf(gym), desk = await firstLocation(gym);
    const plan = await request('POST', Y('member-plans/plans'), { policy: 'If you cancel, the fee for the days you have not used is refunded pro rata.',
      name: 'Gym 30 days', kind: 'duration', durationUnit: 'days', duration: '30', item: { price: '1000', taxRateId: ys.gst18.id, hsnCode: '999723' } }, 201);
    const asha = await customer(gym, 'Asha Rao', '9876500001');
    const sold = await request('POST', Y('member-plans/memberships'), { requestKey: key(), locationId: desk.id, planId: plan.id, contactId: asha.id,
      payments: [{ amount: 'full', method: 'cash' }] }, 201);
    assert.equal(Number((await linesOf(gym, { id: sold.document_id }))[0].tax_rate), 18);
    await typeChange(gym, [plan.price_sku_id], ys.gst5.id, 'Fitness centres to 5%');
    types.gym = { business: gym, Y, plan, asha, sold, desk };

    // Rentals: chairs from a pool, an item at 18%, its price before GST; handed over the day before.
    const R = at(rentals), rs = await slabsOf(rentals), yard = await firstLocation(rentals);
    const pool18 = await request('POST', R('rentals/items'), { item: { name: 'Plastic chair', taxRateId: rs.gst18.id }, kind: 'pool', poolQuantity: '200', rates: { day: '12' } }, 201);
    const chairs = pool18.items.find((i) => i.name === 'Plastic chair');
    const hirer = await customer(rentals, 'Suresh Events', '9000011111');
    const booking = await request('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: hirer.id, outAt: minute(), dueAt: minute(360),
      lines: [{ itemId: chairs.id, quantity: '10' }] }, 201);
    await request('POST', R(`rentals/bookings/${booking.id}/checkout`), { requestKey: key(), idKind: 'pan_card', idRef: 'ABCDE1234F' });
    assert.equal(Number(booking.lines[0].tax_rate), 18);
    await typeChange(rentals, [chairs.sku_id], rs.gst5.id, 'Hire of furniture to 5%');
    types.rentals = { business: rentals, R, booking };

    // A lodge: a room night at the slab its value decides, and an extra (laundry for guests at 18%) posted the day before.
    const H = at(lodge), hs = await slabsOf(lodge), hotel = await firstLocation(lodge);
    await request('PUT', H('lodging/settings'), { lowTaxRateId: hs.gst5.id, highTaxRateId: hs.gst18.id });
    let rooms = await request('POST', H('lodging/room-types'), { item: { name: 'Deluxe', hsnCode: '996311' }, baseOccupancy: 2, maxOccupancy: 3, rates: { rack: '4500' } }, 201);
    const deluxe = rooms.roomTypes.find((r) => r.name === 'Deluxe');
    rooms = await request('POST', H('lodging/rooms'), { locationId: hotel.id, roomTypeId: deluxe.id, rooms: [{ roomNo: '101', floor: '1' }] }, 201);
    const room = rooms.rooms.find((r) => r.room_no === '101');
    const pressing = await request('POST', H('catalog'), { kind: 'service', unit: 'service', name: 'Laundry (per piece)', code: 'LND-PC', price: '50', taxRateId: hs.gst18.id }, 201);
    const stay = await request('POST', H('lodging/stays'), { requestKey: key(), locationId: hotel.id, guest: { name: 'Ravi Kumar', phone: '9000012345' }, source: 'walk_in',
      arrival: D, departure: addDays(D, 2), roomTypeId: deluxe.id, adults: 1 }, 201);
    await request('POST', H(`lodging/stays/${stay.id}/check-in`), { requestKey: key(), roomId: room.id, guests: [{ fullName: 'Ravi Kumar', idKind: 'voter_id', idRef: 'TSV7654321' }] });
    const folio = await request('POST', H(`lodging/stays/${stay.id}/charges`), { requestKey: key(), skuId: pressing.id, quantity: '2' }, 201);
    assert.equal(Number(folio.charges.find((c) => c.kind === 'extra').tax_rate), 18);
    // A room type's nights are billed at the slab their value decides: its item is never moved.
    const roomType = await refused('POST', H('tax-changes'), { requestKey: key(), taxRateId: hs.gst18.id, startsOn: D1, reason: 'Rooms', items: [deluxe.sku_id] });
    assert.equal(roomType.status, 409);
    assert.match(roomType.message, /Deluxe is a room type: its nights are billed at the slab their value decides, under Settings › Room types & rates/);
    await typeChange(lodge, [pressing.id], hs.gst5.id, 'Laundry for guests to 5%');
    types.lodging = { business: lodge, H, stay, pressing };

    // A jeweller's items stay at 3%; a fuel stays on the nil slab.
    const J = at(jeweller);
    const j5 = (await request('GET', J('tax-rates?limit=100'))).items.find((r) => Number(r.rate) === 5);
    const pieces = await request('POST', J('jewellery/items'), { item: { name: 'Gold necklace', hsnCode: '7113' }, metal: 'gold', purity: '22K' }, 201);
    const necklace = pieces.items.find((i) => i.label === 'Gold necklace');
    const gold = await refused('POST', J('tax-changes'), { requestKey: key(), taxRateId: j5.id, startsOn: D1, reason: 'Gold to 5%', items: [necklace.sku_id] });
    assert.equal(gold.status, 409);
    assert.match(gold.message, /Gold necklace is a jewellery item: jewellery is billed at 3% GST/);
    types.jewellery = { business: jeweller, J, necklace, j5 };
    const F = at(pump), ps = await slabsOf(pump);
    const fuels = await request('POST', F('fuel/products'), { item: { name: 'Petrol' }, family: 'petrol' }, 201);
    const petrol = fuels.products.find((p) => p.name === 'Petrol');
    const fuel = await refused('POST', F('tax-changes'), { requestKey: key(), taxRateId: ps.gst18.id, startsOn: D1, reason: 'Petrol into GST', items: [petrol.sku_id] });
    assert.equal(fuel.status, 409);
    assert.match(fuel.message, /Petrol is a fuel, outside GST/);
    types.fuel = { business: pump, F, petrol, ps };

    // Hardware: cement on a quotation at 18%, its price including GST.
    const Q = at(hardware), qs = await slabsOf(hardware), yardQ = await firstLocation(hardware);
    const cement = await request('POST', Q('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'OPC cement 50 kg', code: 'CEM-OPC', price: '413', taxRateId: qs.gst18.id,
      hsnCode: '2523', openingStock: { quantity: '100', unitCost: '330', locationId: yardQ.id } }, 201);
    const builder = await customer(hardware, 'Sharma Constructions', '9845012345');
    const quotation = await request('POST', Q('quotations'), { requestKey: key(), locationId: yardQ.id, contactId: builder.id, validUntil: addDays(D, 10),
      lines: [{ skuId: cement.id, quantity: '10' }] }, 201);
    assert.equal(Number(quotation.lines[0].tax_rate), 18);
    await typeChange(hardware, [cement.id], qs.gst5.id, 'Cement to 5%');
    types.hardware = { business: hardware, Q, quotation, cement, builder };

    // A wholesaler's sales order, at the oil's 18%, its price before GST.
    types.order = await request('POST', W('sales-orders'), { locationId: tradeShop.id, contactId: retailer.id, requestKey: key(), lines: [{ skuId: oil.id, quantity: '10' }] }, 201);
  });

  await t.test('the day of: the change takes effect on the business\'s own date, with no job running', async () => {
    await dayOf([mart.id, trade.id]);
    // The first request of the day applies it.
    const item = await itemOf(mart, marie);
    assert.equal(Number(item.tax_rate), 5);
    assert.equal(Number(item.tax_rate_id), Number(ms.gst5.id));
    assert.equal(item.tax_change, null);
    // A price that includes GST kept its total.
    assert.equal(Number(item.price), 118);
    const applied = await rows('SELECT status,from_rate,to_rate,price_before,price_after FROM business_tax_change_items WHERE business_id=$1 AND change_id=$2 ORDER BY id', [mart.id, biscuitChange.id]);
    assert.ok(applied.every((i) => i.status === 'applied' && Number(i.from_rate) === 18 && Number(i.to_rate) === 5 && i.price_before === i.price_after));
    // Sales, previews and quotes take the new slab: GST inside the same total.
    const bill = await sale(mart, martShop, [{ skuId: marie.id, quantity: '1' }]);
    const [line] = await linesOf(mart, bill);
    assert.deepEqual({ rate: Number(line.tax_rate), net: line.net, tax: line.tax }, { rate: 5, net: '112.38', tax: '5.62' });
    const quote = await cashier('POST', M('retail/quote'), { locationId: martShop.id, lines: [{ skuId: namkeen.id, quantity: '2' }] });
    assert.equal(Number(quote.lines[0].taxRate), 5);
    // A bill posted before keeps its rate.
    const [old] = await linesOf(mart, before.bill);
    assert.deepEqual({ rate: Number(old.tax_rate), tax: old.tax }, { rate: 18, tax: '18.00' });
    // The kit's own rate is the highest of its parts' again.
    assert.equal(Number((await one('SELECT tax_rate FROM catalog_skus WHERE id=$1', [pack.id])).tax_rate), 5);
    // Kept for good, with who entered it and why: in the history and the activity log.
    const history = await request('GET', M(`catalog/${marie.id}/tax-history`));
    assert.equal(history.item.slab_name, ms.gst5.name);
    assert.deepEqual({ status: history.changes[0].status, from: history.changes[0].from_name, by: history.changes[0].created_by_name },
      { status: 'applied', from: ms.gst18.name, by: 'gst-owner' });
    const audit = await one("SELECT actor_id,details FROM business_audit WHERE business_id=$1 AND action='catalog.tax_changed' AND entity_id=$2", [mart.id, marie.id]);
    assert.equal(Number(audit.actor_id), Number(ownerUser.id));
    assert.deepEqual({ from: audit.details.from, to: audit.details.to, startsOn: audit.details.startsOn }, { from: ms.gst18.name, to: ms.gst5.name, startsOn: D1 });
    // It cannot be cancelled now.
    const late = await refused('POST', M(`tax-changes/${biscuitChange.id}/cancel`), { reason: 'Too late' });
    assert.equal(late.status, 409);
    assert.match(late.message, /is in force: it is kept for good/);
    assert.ok((await request('GET', M('tax-changes?state=in_force'))).items.some((c) => c.id === biscuitChange.id));
    // Keeping the part before GST moved the prices with the rate: ₹236 at 18% is ₹210 at 5%,
    // the member price ₹224.20 (₹190 before GST) is ₹199.50 and the branch's ₹240 is ₹213.56.
    const nut = await itemOf(mart, cashew);
    assert.deepEqual({ rate: Number(nut.tax_rate), price: Number(nut.price), member: Number(nut.member_price) }, { rate: 5, price: 210, member: 199.5 });
    assert.equal(Number((await request('GET', M(`catalog/${cashew.id}/branch-prices`))).branches.find((b) => Number(b.location_id) === Number(martBranch.id)).price), 213.56);
    const nutBill = await sale(mart, martShop, [{ skuId: cashew.id, quantity: '1' }]);
    const [nutLine] = await linesOf(mart, nutBill);
    assert.deepEqual({ rate: Number(nutLine.tax_rate), net: nutLine.net, tax: nutLine.tax }, { rate: 5, net: '200.00', tax: '10.00' });
    // A price before GST kept itself; its GST is the new rate's.
    const oilBill = await sale(trade, tradeShop, [{ skuId: oil.id, quantity: '1' }], { contactId: retailer.id });
    const [oilLine] = await linesOf(trade, oilBill);
    assert.deepEqual({ rate: Number(oilLine.tax_rate), net: oilLine.net, tax: oilLine.tax }, { rate: 5, net: '140.00', tax: '7.00' });
  });

  await t.test('a sales order taken the day before is invoiced at the rate of the invoice\'s day', async () => {
    const lines = (await request('GET', W(`sales-orders/${types.order.id}`))).lines;
    assert.equal(Number(lines[0].tax_rate), 18);
    const sent = await request('POST', W(`sales-orders/${types.order.id}/dispatch`), { requestKey: key(), lines: [{ orderLineId: lines[0].id, quantity: '10' }] }, 201);
    const [invoiceLine] = await linesOf(trade, sent.document);
    // The price before GST is the order's; its GST and its rate are the day's.
    assert.deepEqual({ rate: Number(invoiceLine.tax_rate), net: invoiceLine.net, tax: invoiceLine.tax }, { rate: 5, net: '1400.00', tax: '70.00' });
  });

  await t.test('the day of: every type bills its order at the rate of the bill\'s day', async () => {
    await dayOf(['laundry', 'optical', 'garage', 'gym', 'rentals', 'lodging', 'jewellery', 'fuel', 'hardware'].map((name) => types[name].business.id));

    // Laundry: the garment's ₹120 before GST is kept; its GST is 5%.
    const { L, garments } = types.laundry;
    await request('POST', L(`laundry/orders/${garments.id}/status`), { status: 'ready' });
    const handed = await request('POST', L(`laundry/orders/${garments.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'upi' } });
    const laundryBill = handed.deliveries?.[0]?.document_id ?? handed.bills?.[0]?.id;
    const [laundryLine] = await linesOf(types.laundry.business, { id: laundryBill });
    assert.deepEqual({ rate: Number(laundryLine.tax_rate), net: laundryLine.net, tax: laundryLine.tax }, { rate: 5, net: '120.00', tax: '6.00' });

    // Optical: ₹2,360 including GST keeps its total, with 5% inside it.
    const { O, spectacles } = types.optical;
    for (const status of ['in_workshop', 'quality_check', 'ready']) await request('POST', O(`optical/orders/${spectacles.id}/status`), { status });
    const delivered = await request('POST', O(`optical/orders/${spectacles.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'card' } });
    const [opticalLine] = await linesOf(types.optical.business, { id: delivered.document_id });
    assert.deepEqual({ rate: Number(opticalLine.tax_rate), net: opticalLine.net, tax: opticalLine.tax }, { rate: 5, net: '2247.62', tax: '112.38' });

    // Garage: ₹1,180 including GST keeps its total, with 5% inside it.
    const { G, job } = types.garage;
    await request('POST', G(`garage/job-cards/${job.id}/status`), { status: 'ready' });
    const billed = await request('POST', G(`garage/job-cards/${job.id}/bill`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const [garageLine] = await linesOf(types.garage.business, { id: billed.document_id });
    assert.deepEqual({ rate: Number(garageLine.tax_rate), net: garageLine.net, tax: garageLine.tax }, { rate: 5, net: '1123.81', tax: '56.19' });

    // A gym: the renewal sold today is at 5%; the membership sold the day before keeps its 18%.
    const { Y, plan, asha, sold, desk } = types.gym;
    const renewed = await request('POST', Y('member-plans/memberships'), { requestKey: key(), locationId: desk.id, planId: plan.id, contactId: asha.id, renewalOf: sold.id,
      payments: [{ amount: 'full', method: 'cash' }] }, 201);
    const [gymLine] = await linesOf(types.gym.business, { id: renewed.document_id });
    assert.deepEqual({ rate: Number(gymLine.tax_rate), net: gymLine.net, tax: gymLine.tax }, { rate: 5, net: '1000.00', tax: '50.00' });
    assert.equal(Number((await linesOf(types.gym.business, { id: sold.document_id }))[0].tax_rate), 18);

    // Rentals: the hire booked before GST is kept; its GST is 5%.
    const { R, booking } = types.rentals;
    const back = await request('POST', R(`rentals/bookings/${booking.id}/returns`), { requestKey: key(), lines: [{ lineId: booking.lines[0].id }] }, 201);
    const [hireLine] = await linesOf(types.rentals.business, { id: back.document_id });
    assert.equal(Number(hireLine.tax_rate), 5);
    assert.equal(hireLine.net, booking.lines[0].net);
    assert.equal(paise(hireLine.tax), Math.round(paise(hireLine.net) * 5 / 100));

    // A lodge: the extra posted the day before keeps its 18%, today's takes 5%, the night its value's slab.
    const { H, stay, pressing } = types.lodging;
    const folio = await request('POST', H(`lodging/stays/${stay.id}/charges`), { requestKey: key(), skuId: pressing.id, quantity: '1' }, 201);
    assert.deepEqual(folio.charges.filter((c) => c.kind === 'extra').map((c) => Number(c.tax_rate)).sort((a, b) => a - b), [5, 18]);
    const out = await request('POST', H(`lodging/stays/${stay.id}/check-out`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const stayLines = await linesOf(types.lodging.business, { id: out.document_id });
    assert.deepEqual(stayLines.map((l) => Number(l.tax_rate)).sort((a, b) => a - b), [5, 5, 18]);

    // A quotation made the day before at 18%: its bill would be at another rate than quoted, so it is revised first, and billed at 5%.
    const { Q, quotation, cement, builder } = types.hardware;
    const stale = await refused('POST', Q(`quotations/${quotation.id}/bill`), { requestKey: key() });
    assert.equal(stale.status, 409);
    assert.match(stale.message, /GST on OPC cement 50 kg is now 5%, not the 18% quoted\. Revise the quotation first\./);
    const revised = await request('PUT', Q(`quotations/${quotation.id}`), { requestKey: key(), contactId: builder.id, validUntil: addDays(D1, 10), lines: [{ skuId: cement.id, quantity: '10' }] });
    assert.equal(Number(revised.lines[0].tax_rate), 5);
    const fromQuote = await request('POST', Q(`quotations/${quotation.id}/bill`), { requestKey: key() }, 201);
    const [quoteLine] = await linesOf(types.hardware.business, fromQuote.document);
    assert.deepEqual({ rate: Number(quoteLine.tax_rate), total: paise(quoteLine.net) + paise(quoteLine.tax) }, { rate: 5, total: 413000 });
  });

  await t.test('a change the database refuses on its date is kept as refused, with why, and nothing else stops', async () => {
    // Changes entered past the screens' checks, as one entered before its item became a fuel or a jewellery item would be.
    const force = async (business, skuId, slabId, rate) => {
      const change = await one(`INSERT INTO business_tax_changes(business_id,starts_on,tax_rate_id,rate,reason,request_key,request_hash,created_by)
        VALUES($1,$2,$3,$4,'Entered before the item became what it is',$5,$6,$7) RETURNING id`, [business.id, D1, slabId, rate, key(), 'x'.repeat(64), ownerUser.id]);
      await pool.query('INSERT INTO business_tax_change_items(business_id,change_id,starts_on,sku_id) VALUES($1,$2,$3,$4)', [business.id, change.id, D1, skuId]);
      return change.id;
    };
    const { F, petrol, ps } = types.fuel;
    const { J, necklace, j5 } = types.jewellery;
    const fuelChange = await force(types.fuel.business, petrol.sku_id, ps.gst18.id, 18);
    const goldChange = await force(types.jewellery.business, necklace.sku_id, j5.id, 5);
    // The next request takes them up.
    await request('GET', F('catalog'));
    await request('GET', J('catalog'));
    const fuelDetail = await request('GET', F(`tax-changes/${fuelChange}`));
    assert.equal(fuelDetail.state, 'refused');
    assert.equal(fuelDetail.items[0].status, 'refused');
    assert.match(fuelDetail.items[0].note, /Petrol is a fuel, outside GST: it stays on the GST nil slab/);
    assert.equal(Number((await one('SELECT tax_rate FROM catalog_skus WHERE id=$1', [petrol.sku_id])).tax_rate), 0);
    const goldDetail = await request('GET', J(`tax-changes/${goldChange}`));
    assert.match(goldDetail.items[0].note, /Gold necklace is a jewellery item: jewellery is billed at 3% GST/);
    assert.equal(Number((await one('SELECT tax_rate FROM catalog_skus WHERE id=$1', [necklace.sku_id])).tax_rate), 3);
  });

  await t.test('a posting that meets a change halfway, around midnight, is refused to be sent again', async () => {
    const core = require('../../src/modules/business/core/services/business.service');
    const access = require('../../src/modules/business/core/services/businessAccess.service');
    const repo = require('../../src/modules/business/core/repositories/business.repository');
    // A type's fixed prices worked out before a change took effect inside the posting itself
    // (the request began before the day turned): refused, and nothing of it saved.
    const due = await one(`INSERT INTO business_tax_changes(business_id,starts_on,tax_rate_id,rate,reason,request_key,request_hash,created_by)
      VALUES($1,$2,$3,18,'Cola to 18%',$4,$5,$6) RETURNING id`, [mart.id, D1, ms.gst18.id, key(), 'y'.repeat(64), ownerUser.id]);
    await pool.query('INSERT INTO business_tax_change_items(business_id,change_id,starts_on,sku_id) VALUES($1,$2,$3,$4)', [mart.id, due.id, D1, cola.id]);
    const business = await access.load({ id: ownerUser.id }, mart.id);
    const body = { kind: 'sale', locationId: martShop.id, lines: [{ skuId: cola.id, quantity: '1' }] };
    const fixed = [{ price: 40, net: 2857, tax: 1143, priceRuleId: null, enteredPrice: null }];
    await assert.rejects(repo.transaction((db) => core.postDocument(db, business, { id: ownerUser.id }, body,
      { kind: 'sale', requestKey: key(), hash: 'h', lines: body.lines, paidNow: null, fixed })),
    (error) => error.statusCode === 409 && error.details?.reason === 'gst_rates_changed');
    assert.equal((await one('SELECT status FROM business_tax_change_items WHERE change_id=$1', [due.id])).status, 'scheduled', 'nothing of the refused posting is kept');
    // Sent again, the request opens the business, the change takes effect, and the bill is at the new slab.
    const again = await sale(mart, martShop, [{ skuId: cola.id, quantity: '1' }]);
    assert.equal(Number((await linesOf(mart, again))[0].tax_rate), 18);

    // A posting that began on the day before a change another request has just applied: shown by
    // the business's clock a day back and the change taken up a moment from now.
    await dayBefore([mart.id]);
    await pool.query('ALTER TABLE business_tax_change_items DISABLE TRIGGER business_tax_change_items_kept');
    try {
      await pool.query("UPDATE business_tax_change_items SET settled_at=now()+interval '1 hour' WHERE change_id=$1", [biscuitChange.id]);
      const halfway = await refused('POST', M('documents'), { kind: 'sale', requestKey: key(), locationId: martShop.id, lines: [{ skuId: marie.id, quantity: '1' }], payment: { method: 'upi', amount: 'full' } });
      assert.equal(halfway.status, 409);
      assert.equal(halfway.data.reason, 'gst_rates_changed');
      await pool.query('UPDATE business_tax_change_items SET settled_at=now() WHERE change_id=$1', [biscuitChange.id]);
    } finally {
      await pool.query('ALTER TABLE business_tax_change_items ENABLE TRIGGER business_tax_change_items_kept');
    }
    // A clock moved back by hand, long after a change took effect, does not undo it: the item keeps its new slab.
    const later = await sale(mart, martShop, [{ skuId: marie.id, quantity: '1' }]);
    assert.equal(Number((await linesOf(mart, later))[0].tax_rate), 5);
    await dayOf([mart.id]);
  });

  await t.test('a slab changed on the item itself is in its GST history too', async () => {
    await request('PATCH', M(`catalog/${tooth.id}`), { label: 'Toothpaste', price: '105', taxRateId: ms.gst18.id, active: true });
    const history = await request('GET', M(`catalog/${tooth.id}/tax-history`));
    assert.equal(history.item.slab_name, ms.gst18.name);
    assert.deepEqual({ from: history.edits[0].details.from, to: history.edits[0].details.to, by: history.edits[0].actor_name }, { from: ms.gst5.name, to: ms.gst18.name, by: 'gst-owner' });
    // The cancelled change it was in is there as well, with who cancelled it and why.
    const cancelled = history.changes.find((c) => c.status === 'cancelled');
    assert.ok(cancelled);
    assert.equal(cancelled.cancel_reason, 'Notification withdrawn');
  });

  // --- A restaurant ---------------------------------------------------------------------------------
  // The same changes for a restaurant's dishes, on its own trading day. An
  // order line takes the rate of its business day and its bill keeps it.
  const restaurantService = require('../../src/modules/restaurant/setup/services/restaurant.service');
  const sweets = await restaurantService.createRestaurant({ name: 'Annapurna Sweets', code: 'GSTSWEETS', invoicePrefix: 'AS', timezone: clock.before.zone,
    admin: { name: 'Sweets owner', email: 'sweets@gst.invalid', password } });
  await restaurantService.createRestaurant({ name: 'Other Cafe', code: 'GSTCAFE', admin: { name: 'Cafe owner', email: 'cafe@gst.invalid', password } });
  const sweetsToken = await login('sweets@gst.invalid');
  const cafeToken = await login('cafe@gst.invalid');
  const kitchenHand = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [sweets.id, 'Sweets cashier', 'sweets-cashier@gst.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='CASHIER' AND restaurant_id IS NULL", [kitchenHand.id]);
  const sweetsCashierToken = await login('sweets-cashier@gst.invalid');
  async function at(method, route, body, auth = sweetsToken, outletId = null) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...(outletId ? { 'X-Outlet-Id': String(outletId) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const S = async (method, route, body, expected = 200, outletId = null) => {
    const result = await at(method, route, body, sweetsToken, outletId);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  // Its day is its calendar date (no morning cut-off), so the clock alone decides it.
  await S('PUT', '/business-day/rules', { cutoffHour: 0, varianceThreshold: 100, blindCount: false });
  const menuRates = await S('GET', '/menu/tax-rates');
  const r5 = menuRates.find((r) => Number(r.percentage) === 5), r18 = menuRates.find((r) => Number(r.percentage) === 18), r40 = menuRates.find((r) => Number(r.percentage) === 40);
  const desserts = await S('POST', '/menu/categories', { name: 'Desserts' }, 201);
  const dish = (body) => S('POST', '/menu/products', { categoryId: desserts.id, isAvailable: true, taxRateId: r18.id, ...body }, 201);
  // Two prices that include GST, and one before it.
  const kulfi = await dish({ name: 'Kulfi', price: 118, taxMode: 'inclusive' });
  const brownie = await dish({ name: 'Brownie', price: 236, taxMode: 'inclusive' });
  const large = await S('POST', `/menu/products/${brownie.id}/variants`, { name: 'Large', priceDelta: 118 }, 201);
  const tea = await dish({ name: 'Masala tea', price: 100, taxMode: 'exclusive' });
  const nightBranch = await S('POST', '/outlets', { name: 'Night Branch', code: 'NIGHT' }, 201);
  const R0 = (await S('POST', '/business-day/open', { openingCash: 0 }, 201)).businessDate.slice(0, 10);
  const R1 = addDays(R0, 1);
  // The night branch keeps a business day of its own.
  await S('POST', '/business-day/open', { openingCash: 0 }, 201, nightBranch.id);
  const restaurantRows = {};

  await t.test('a restaurant previews and schedules its dishes\' changes, on its menu screens', async () => {
    assert.equal(R0, D, 'the restaurant is on its own date, the day before');
    const preview = await S('POST', '/menu/tax-changes/preview', { taxRateId: r5.id, startsOn: R1, filters: { taxRateId: r18.id } });
    assert.deepEqual(preview.items.map((i) => i.label), ['Brownie', 'Kulfi', 'Masala tea']);
    assert.equal(preview.today, R0);
    const byName = Object.fromEntries(preview.items.map((i) => [i.label, i]));
    assert.deepEqual({ price: byName.Kulfi.price, gst: byName.Kulfi.gst }, { price: { before: '118.00', after: '118.00' }, gst: { before: '18.00', after: '5.62' } });
    assert.deepEqual({ price: byName['Masala tea'].price, total: byName['Masala tea'].total, inclusive: byName['Masala tea'].pricesIncludeGst },
      { price: { before: '100.00', after: '100.00' }, total: { before: '118.00', after: '105.00' }, inclusive: false });
    // Only someone who manages the menu schedules; another restaurant sees nothing of it.
    const body = { requestKey: key(), taxRateId: r5.id, startsOn: R1, reason: 'Packaged sweets and tea to 5%', items: [kulfi.id, tea.id] };
    assert.equal((await at('POST', '/menu/tax-changes', body, sweetsCashierToken)).status, 403);
    const change = await S('POST', '/menu/tax-changes', body, 201);
    assert.equal(change.state, 'scheduled');
    assert.equal((await S('POST', '/menu/tax-changes', body, 201)).id, change.id);
    assert.equal((await at('POST', '/menu/tax-changes', { ...body, reason: 'Other' })).status, 409);
    assert.equal((await at('GET', `/menu/tax-changes/${change.id}`, undefined, cafeToken)).status, 404);
    const cafeDish = (await at('GET', '/menu/products', undefined, cafeToken)).body.data;
    assert.ok(Array.isArray(cafeDish));
    const twice = await at('POST', '/menu/tax-changes', { ...body, requestKey: key(), taxRateId: r40.id, items: [kulfi.id] });
    assert.equal(twice.status, 409);
    assert.match(twice.body.message, /Kulfi already moves to GST 5% \(restaurant\) on/);
    // The brownie keeps its price before GST: ₹236 at 18% is ₹210 at 5%, and its Large size ₹354 is ₹315.
    const net = await S('POST', '/menu/tax-changes', { requestKey: key(), taxRateId: r5.id, startsOn: R1, keeps: 'net', reason: 'Brownies to 5%, the benefit passed on', items: [brownie.id] }, 201);
    restaurantRows.change = change;
    restaurantRows.net = net;
    // A tax rate dishes are to move to stays on until then.
    const toForty = await S('POST', '/menu/tax-changes', { requestKey: key(), taxRateId: r40.id, startsOn: addDays(R1, 3), reason: 'Tea to 40%', items: [tea.id] }, 201);
    const off = await at('PUT', `/menu/tax-rates/${r40.id}`, { name: r40.name, percentage: r40.percentage, hsnCode: r40.hsnCode, cessPercentage: r40.cessPercentage, isDefault: false, status: 'inactive' });
    assert.equal(off.status, 409);
    assert.match(off.body.message, /Items move to GST 40% on .* \(a scheduled GST rate change\)/);
    await S('POST', `/menu/tax-changes/${toForty.id}/cancel`, { reason: 'Not notified' });
    // A dish a change has named is archived, not deleted: its GST history needs it.
    const usage = await S('GET', `/menu/products/${tea.id}/usage`);
    assert.deepEqual({ canDelete: usage.canDelete, reason: usage.reason, canArchive: usage.canArchive }, { canDelete: false, reason: 'in_tax_change', canArchive: true });
    const deleted = await at('DELETE', `/menu/products/${tea.id}`);
    assert.equal(deleted.status, 409);
    assert.match(deleted.body.message, /"Masala tea" is in a GST rate change \(from \d{1,2} [A-Z][a-z]{2} \d{4}\), so it can't be deleted/);
    const listed = await S('GET', '/menu/tax-changes');
    assert.equal(listed.today, R0);
    assert.deepEqual(listed.changes.map((c) => c.state), ['scheduled', 'scheduled', 'cancelled']);
    const logged = await rows("SELECT action FROM audit_logs WHERE restaurant_id=$1 AND entity_type='tax_change' ORDER BY id", [sweets.id]);
    assert.deepEqual(logged.map((r) => r.action), ['scheduled', 'scheduled', 'scheduled', 'cancelled']);
  });

  await t.test('the restaurant\'s day before: orders and bills at the old rate; then its day ends', async () => {
    const order = await S('POST', '/orders', { orderType: 'takeaway', items: [{ productId: kulfi.id, quantity: 1 }] }, 201);
    const bill = await S('POST', '/bills', { orderId: (order.order || order).id }, 201);
    assert.equal(Number(bill.items[0].taxPercentage), 18);
    restaurantRows.billBefore = bill;
    await S('POST', `/bills/${bill.id}/payments`, { paymentMethod: 'cash', amount: bill.dueAmount }, 201);
    const sheet = await S('GET', '/reports/day-end');
    await S('POST', '/business-day/close', { closingCash: sheet.expectedCash });
    const menu = await S('GET', '/menu/products');
    assert.equal(Number(menu.find((p) => String(p.id) === String(kulfi.id)).taxPercentage), 18, 'nothing moves before its day');
  });

  await t.test('the restaurant\'s day of: its dishes take the new rate, an order on a day before keeps the old', async () => {
    await pool.query('UPDATE restaurant_settings SET timezone=$2 WHERE restaurant_id=$1', [sweets.id, clock.after.zone]);
    assert.equal((await S('POST', '/business-day/open', { openingCash: 0 }, 201)).businessDate.slice(0, 10), R1);
    // The menu shows the trading day's rates and prices.
    const menu = await S('GET', '/menu/products');
    const now = (p) => menu.find((x) => String(x.id) === String(p.id));
    assert.deepEqual({ rate: Number(now(kulfi).taxPercentage), price: Number(now(kulfi).price) }, { rate: 5, price: 118 });
    assert.deepEqual({ rate: Number(now(tea).taxPercentage), price: Number(now(tea).price) }, { rate: 5, price: 100 });
    assert.deepEqual({ rate: Number(now(brownie).taxPercentage), price: Number(now(brownie).price) }, { rate: 5, price: 210 });
    const sizes = await S('GET', `/menu/products/${brownie.id}/variants`);
    assert.equal(Number(sizes.find((v) => String(v.id) === String(large.id)).priceDelta), 105);
    // An order today takes 5%: the kulfi's ₹118 keeps its total, the Large brownie is ₹315.
    const order = await S('POST', '/orders', { orderType: 'takeaway', items: [{ productId: kulfi.id, quantity: 1 }, { productId: brownie.id, productVariantId: large.id, quantity: 1 }] }, 201);
    const bill = await S('POST', '/bills', { orderId: (order.order || order).id }, 201);
    const line = (name) => bill.items.find((i) => i.itemName === name);
    assert.deepEqual({ rate: Number(line('Kulfi').taxPercentage), total: Number(line('Kulfi').lineTotal) }, { rate: 5, total: 118 });
    assert.deepEqual({ rate: Number(line('Brownie').taxPercentage), total: Number(line('Brownie').lineTotal) }, { rate: 5, total: 315 });
    // The night branch is still on the day before: its order is at that day's rates and prices.
    const late = await S('POST', '/orders', { orderType: 'takeaway', items: [{ productId: kulfi.id, quantity: 1 }, { productId: brownie.id, productVariantId: large.id, quantity: 1 }] }, 201, nightBranch.id);
    const lateBill = await S('POST', '/bills', { orderId: (late.order || late).id }, 201, nightBranch.id);
    const lateLine = (name) => lateBill.items.find((i) => i.itemName === name);
    assert.deepEqual({ rate: Number(lateLine('Kulfi').taxPercentage), total: Number(lateLine('Kulfi').lineTotal) }, { rate: 18, total: 118 });
    assert.deepEqual({ rate: Number(lateLine('Brownie').taxPercentage), total: Number(lateLine('Brownie').lineTotal) }, { rate: 18, total: 354 });
    // A bill made before keeps its rate.
    assert.equal(Number((await S('GET', `/bills/${restaurantRows.billBefore.id}`)).items[0].taxPercentage), 18);
    // Kept for good, with who entered it and why: on the dish, and in the activity log.
    const history = await S('GET', `/menu/products/${kulfi.id}/tax-history`);
    assert.deepEqual({ status: history.changes[0].status, from: history.changes[0].from_name, to: history.changes[0].to_name, by: history.changes[0].created_by_name },
      { status: 'applied', from: r18.name, to: r5.name, by: 'Sweets owner' });
    const log = await one("SELECT user_id,details FROM audit_logs WHERE restaurant_id=$1 AND entity_type='product' AND entity_id=$2 AND details->>'via' LIKE 'GST rate change of %'", [sweets.id, brownie.id]);
    assert.deepEqual(log.details.changes, { taxRate: [r18.name, r5.name], price: [236, 210] });
    const late409 = await at('POST', `/menu/tax-changes/${restaurantRows.change.id}/cancel`, { reason: 'Too late' });
    assert.equal(late409.status, 409);
    assert.equal((await S('GET', '/menu/tax-changes')).changes.find((c) => c.id === restaurantRows.change.id).state, 'in_force');
    // A rate changed on the dish itself is in its GST history too.
    await S('PATCH', `/menu/products/${tea.id}`, { changes: { taxRateId: r18.id }, original: {} });
    const teaHistory = await S('GET', `/menu/products/${tea.id}/tax-history`);
    assert.deepEqual(teaHistory.edits[0].details.changes.taxRate.length, 2);
  });
});
