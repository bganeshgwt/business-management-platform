const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createBusinesses } = require('./helpers/businesses');
const { signIn } = require('./helpers/signIn');

// Live updates: a screen's stream of changes for its restaurant or business.
// A change committed through one session reaches the streams of the same
// restaurant or business within a moment, in commit order, and no other
// business's; a message says only the area, the row's id and its outlet or
// location; a change that rolls back is never announced; someone tied to one
// outlet or location hears only of theirs; a stream ends when its session or
// access does (signed out everywhere, switched off, a membership ended, the
// token run out); the limits per person and per process hold, and a client
// that goes leaves nothing behind; a quiet stream gets its keep-alive; the
// listening connection comes back after a drop and every screen reads again;
// a second API process hears the same changes and its dashboard answers are
// cleared by them; stopping closes every stream and the connection. Live
// updates post nothing: they write no audit or event rows of their own, and a
// posting repeated with its request key announces nothing. Runs on its own
// throwaway database with every migration applied.
test('live updates', { timeout: 900000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  // Every stream opened, closed at the end whatever happened.
  const streams = new Set();
  let pool, server, scratch, hub, second, created = false;
  await admin.connect();
  t.after(async () => {
    for (const stream of streams) stream.close();
    if (second) await second.stop();
    if (hub) await hub.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (scratch) await scratch.end();
    // A plain DROP: it fails while any connection to the database is left open.
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  // Limits small enough to reach.
  process.env.LIVE_STREAMS_PER_PERSON = '4';
  process.env.LIVE_STREAMS_MAX = '12';
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes the triggers and functions away and Up brings them back', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const left = async () => (await scratch.query(`SELECT
        (SELECT count(*)::int FROM pg_proc WHERE proname IN ('live_announce','live_announce_business','live_restaurant_row','live_restaurant_part',
          'live_business_row','live_business_event','live_session')) AS functions,
        (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE '%\\_live' OR tgname LIKE '%\\_live\\_session%')) AS triggers`)).rows[0];
    assert.deepEqual(await left(), { functions: 7, triggers: 34 });
    // This migration's Down half, after those of every newer one.
    await migrate({ direction: 'down', count: 1791974000000, timestamp: true });
    assert.deepEqual(await left(), { functions: 0, triggers: 0 });
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await left(), { functions: 7, triggers: 34 });
  });

  pool = require('../../src/config/database');
  hub = require('../../src/modules/live/services/liveHub');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const password = `Live-${crypto.randomBytes(8).toString('hex')}`;
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
  async function call(method, route, body, auth, headers = {}, at = base) {
    const response = await fetch(at + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const as = (auth, headers = {}) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth, headers);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const key = () => crypto.randomUUID();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A screen's stream, read as the staff app reads it (fetch, the token in the
  // Authorization header): every message as it arrives, and the comments
  // counted. `until` waits for a condition on what has arrived.
  function listen(route, token, headers = {}, at = base) {
    const controller = new AbortController();
    const stream = { status: 0, headers: null, body: null, messages: [], comments: 0, done: false, close: () => controller.abort() };
    let wake = () => {};
    const arrived = () => { const waiting = wake; wake = () => {}; waiting(); };
    streams.add(stream);
    stream.opened = fetch(at + route, { headers: { Accept: 'text/event-stream', 'Accept-Encoding': 'gzip, deflate', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      signal: controller.signal })
      .then(async (response) => {
        stream.status = response.status;
        stream.headers = response.headers;
        if (!(response.headers.get('content-type') || '').startsWith('text/event-stream')) {
          stream.body = await response.json().catch(() => ({}));
          stream.done = true;
          arrived();
          return stream;
        }
        (async () => {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                if (block.startsWith(':')) { stream.comments += 1; arrived(); continue; }
                const message = { raw: block };
                for (const line of block.split('\n')) {
                  const colon = line.indexOf(':');
                  const field = line.slice(0, colon);
                  const value = line.slice(colon + 1).trimStart();
                  if (field === 'event') message.event = value;
                  else if (field === 'id') message.id = Number(value);
                  else if (field === 'data') message.data = JSON.parse(value);
                }
                stream.messages.push(message);
                arrived();
              }
            }
          } catch {
            // Closed from this end.
          }
          stream.done = true;
          arrived();
        })();
        return stream;
      })
      .catch(() => { stream.done = true; arrived(); return stream; });
    stream.until = (check, ms = 8000, what = route) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { wake = () => {}; reject(new Error(`${what}: not within ${ms} ms. Messages: ${JSON.stringify(stream.messages.map((m) => [m.event, m.data]))}`)); }, ms);
      const look = () => {
        const found = check(stream);
        if (found) { clearTimeout(timer); resolve(found); } else wake = look;
      };
      look();
    });
    // The change messages after message number `from`.
    stream.changes = (from = 0) => stream.messages.slice(from).filter((m) => m.event === 'change');
    stream.change = (from, area, id, ms) => stream.until(() => stream.changes(from).find((m) => m.data.area === area && (id === undefined || m.data.id === Number(id))), ms,
      `${route}: a change of ${area}${id === undefined ? '' : ` ${id}`}`);
    stream.ready = async () => {
      await stream.opened;
      assert.equal(stream.status, 200, `${route}: ${JSON.stringify(stream.body)}`);
      return stream.until(() => stream.messages.find((m) => m.event === 'ready'), 8000, `${route}: ready`);
    };
    stream.ended = (ms = 10000) => stream.until(() => stream.done && (stream.messages.find((m) => m.event === 'end') || { event: 'closed' }), ms, `${route}: the end`);
    return stream;
  }
  const refused = async (route, token, headers) => {
    const stream = listen(route, token, headers);
    await stream.opened;
    return { status: stream.status, body: stream.body };
  };
  // Nothing matching arrives on these streams for `ms` after message `from` of each.
  const quiet = async (pairs, check, ms = 1500) => {
    await wait(ms);
    for (const [stream, from] of pairs) assert.deepEqual(stream.changes(from).filter((m) => check(m.data)).map((m) => m.data), [], 'nothing else arrives');
  };
  // A subtest that closes every stream it opened, whatever happens in it, and
  // waits for the hub to forget them, so one failing never upsets the next.
  const step = (name, work) => t.test(name, async () => {
    try {
      await work();
    } finally {
      for (const stream of streams) stream.close();
      streams.clear();
      for (let tries = 0; tries < 50 && hub && hub.stats().streams > 0; tries += 1) await wait(100);
    }
  });
  // Every change message any stream carried, for the last check.
  const seenChanges = [];
  const remember = (stream) => { seenChanges.push(...stream.changes().map((m) => ({ data: m.data, raw: m.raw }))); };

  // --- Two restaurants, a business owner's shops, and staff -------------------------------
  const ownerA = await owner('live-a');
  await owner('live-b');
  const tokenA = await login('live-a@test.invalid');
  const tokenB = await login('live-b@test.invalid');
  // The owner's caller: signing out everywhere (below) gives the owner a new token.
  let ownerToken = tokenA;
  let A = as(tokenA);
  const B = as(tokenB);
  await A('POST', '/business-day/open', { openingCash: 1000 }, 201);
  await B('POST', '/business-day/open', { openingCash: 1000 }, 201);
  const menuOf = async (request) => {
    const category = await request('POST', '/menu/categories', { name: 'Main course' }, 201);
    return request('POST', '/menu/products', { categoryId: category.id, name: 'Dal makhani', price: 240, taxPercentage: 0, foodType: 'veg', isAvailable: true }, 201);
  };
  const dalA = await menuOf(A);
  const dalB = await menuOf(B);
  const floor = await A('POST', '/tables/floors', { name: 'Ground floor' }, 201);
  const table = await A('POST', '/tables', { floorId: floor.id, tableNo: '7', capacity: 4 }, 201);
  const takeaway = (request, dish = dalA) => request('POST', '/orders', { orderType: 'takeaway', items: [{ productId: dish.id, quantity: 1 }] }, 201);
  const outlet1 = await A('POST', '/outlets', { name: 'Koramangala', code: 'KRM' }, 201);
  const outlet2 = await A('POST', '/outlets', { name: 'Indiranagar', code: 'IND' }, 201);
  const cashierRole = (await A('GET', '/roles')).find((role) => role.code === 'CASHIER' && role.isSystem);
  const pinned = await A('POST', '/users', { name: 'Ravi', email: 'ravi@test.invalid', password, roleIds: [cashierRole.id], outletId: outlet1.id }, 201);
  const pinnedToken = await login('ravi@test.invalid');

  const [grocery, clinic] = await createBusinesses(A, 'LIVE', ['grocery', 'healthcare']);
  const [elsewhere] = await createBusinesses(B, 'ELSE', ['grocery']);
  const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
  const C = (suffix) => `/businesses/${clinic.id}/${suffix}`;
  const main = (await A('GET', G('locations'))).items[0];
  const branch = await A('POST', G('locations'), { name: 'Market branch', code: 'MKT' }, 201);
  const soap = await A('POST', G('catalog'), { kind: 'goods', unit: 'each', tracking: 'quantity', taxRate: '18', name: 'Bath soap', code: 'SOAP', price: '59' }, 201);
  const supplier = await A('POST', G('contacts'), { kind: 'supplier', name: 'Metro wholesale' }, 201);
  for (const location of [main, branch]) {
    await A('POST', G('documents'), { kind: 'purchase', requestKey: key(), locationId: location.id, contactId: supplier.id, lines: [{ skuId: soap.id, quantity: '40', unitPrice: '40' }] }, 201);
  }
  const sale = (locationId, requestKey = key()) => ({ kind: 'sale', requestKey, locationId, lines: [{ skuId: soap.id, quantity: '1' }], payment: { amount: 'full', method: 'cash' } });
  const groceryRoles = (await A('GET', G('roles?limit=100'))).items;
  const cashierAt = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerA.restaurant_id, 'Meena', 'meena@test.invalid', hash]);
  const cashierTemplate = groceryRoles.find((role) => role.template_code === 'cashier');
  await A('POST', G('members'), { userId: cashierAt.id, roleId: cashierTemplate.id, workLocationId: branch.id }, 201);
  const meenaToken = await login('meena@test.invalid');
  const noRestaurant = await one('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id', ['Platform', 'platform@test.invalid', hash]);
  assert.ok(noRestaurant.id);
  const platformToken = await login('platform@test.invalid');

  await step('a stream opens with the Authorization header only, for a place the person belongs to', async () => {
    assert.equal((await refused('/live')).status, 401);
    // A token in the address is never read.
    assert.equal((await refused(`/live?token=${encodeURIComponent(tokenA)}`)).status, 401);
    assert.equal((await refused(`/businesses/${grocery.id}/live?token=${encodeURIComponent(tokenA)}`)).status, 401);
    // Another owner's business looks like no business at all, and a member of none is refused.
    assert.equal((await refused(`/businesses/${elsewhere.id}/live`, tokenA)).status, 404);
    assert.equal((await refused(`/businesses/${grocery.id}/live`, tokenB)).status, 404);
    assert.equal((await refused('/businesses/abc/live', tokenA)).status, 400);
    // A login with no restaurant has no restaurant stream; someone tied to an outlet cannot ask for another.
    const none = await refused('/live', platformToken);
    assert.equal(none.status, 404);
    assert.match(none.body.message, /no restaurant/);
    assert.equal((await refused('/live', pinnedToken, { 'X-Outlet-Id': String(outlet2.id) })).status, 403);

    const stream = listen('/live', tokenA);
    const ready = await stream.ready();
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(stream.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(stream.headers.get('x-accel-buffering'), 'no');
    // Never compressed (compression would hold the messages back).
    assert.equal(stream.headers.get('content-encoding'), null);
    assert.deepEqual(ready.data, { scope: 'restaurant', keepAliveSeconds: 25 });
    const shop = listen(`/businesses/${grocery.id}/live`, tokenA);
    assert.deepEqual((await shop.ready()).data, { scope: 'business', keepAliveSeconds: 25 });
    const tied = listen(`/businesses/${grocery.id}/live`, meenaToken);
    assert.deepEqual((await tied.ready()).data, { scope: 'business', keepAliveSeconds: 25, location: branch.id });
    const outlet = listen('/live', pinnedToken);
    assert.deepEqual((await outlet.ready()).data, { scope: 'restaurant', keepAliveSeconds: 25, outlet: outlet1.id });
    for (const each of [stream, shop, tied, outlet]) each.close();
    await wait(300);
    assert.equal(hub.stats().streams, 0);
  });

  await step("a change reaches its restaurant's streams within a moment, and no other restaurant's", async () => {
    const mine = listen('/live', tokenA);
    const another = listen('/live', tokenA);
    const theirs = listen('/live', tokenB);
    await Promise.all([mine.ready(), another.ready(), theirs.ready()]);
    const fromTheirs = theirs.messages.length;
    const started = Date.now();
    const order = await takeaway(A);
    // Within a moment, even with the whole suite running beside it.
    await mine.change(0, 'order', order.id, 5000);
    await another.change(0, 'order', order.id, 5000);
    assert.ok(Date.now() - started < 5000, 'within a moment');
    // A bill paid frees the table: the bill, the order and the table are announced.
    const dineIn = await A('POST', '/orders', { orderType: 'dine_in', tableId: table.id, guestCount: 2, items: [{ productId: dalA.id, quantity: 2 }] }, 201);
    const from = mine.messages.length;
    const bill = await A('POST', '/bills', { orderId: dineIn.id }, 201);
    await A('POST', `/bills/${bill.id}/payments`, { paymentMethod: 'cash', amount: bill.dueAmount }, 201);
    await mine.change(from, 'bill', bill.id);
    await mine.change(from, 'order', dineIn.id);
    await mine.change(from, 'table', table.id);
    // The other restaurant heard nothing of it, and its own change reaches it alone.
    await quiet([[theirs, fromTheirs]], () => true);
    const fromMine = mine.messages.length;
    const theirOrder = await takeaway(B, dalB);
    await theirs.change(fromTheirs, 'order', theirOrder.id);
    await quiet([[mine, fromMine]], (data) => data.area === 'order' && data.id === theirOrder.id);
    for (const each of [mine, another, theirs]) { remember(each); each.close(); }
  });

  await step('only committed changes are announced', async () => {
    const stream = listen('/live', tokenA);
    await stream.ready();
    const from = stream.messages.length;
    // Rolled back, and a savepoint rolled back inside a transaction that commits something else.
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("UPDATE dining_tables SET table_status='cleaning' WHERE id=$1", [table.id]);
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      await db.query('SAVEPOINT live');
      await db.query("UPDATE dining_tables SET table_status='cleaning' WHERE id=$1", [table.id]);
      await db.query('ROLLBACK TO SAVEPOINT live');
      await db.query("UPDATE floors SET name='Ground floor' WHERE id=$1", [floor.id]);
      await db.query('COMMIT');
    } finally {
      db.release();
    }
    // A refused request writes nothing, so announces nothing: another restaurant's dish.
    const foreign = await call('POST', '/orders', { orderType: 'takeaway', items: [{ productId: dalB.id, quantity: 1 }] }, tokenA);
    assert.ok(foreign.status >= 400 && foreign.status < 500, JSON.stringify(foreign.body));
    await quiet([[stream, from]], () => true);
    // Several changes to one row in one transaction reach the screen once.
    const db2 = await pool.connect();
    try {
      await db2.query('BEGIN');
      await db2.query('UPDATE dining_tables SET capacity=5 WHERE id=$1', [table.id]);
      await db2.query('UPDATE dining_tables SET capacity=6 WHERE id=$1', [table.id]);
      await db2.query('COMMIT');
    } finally {
      db2.release();
    }
    await stream.change(from, 'table', table.id);
    await wait(500);
    assert.equal(stream.changes(from).filter((m) => m.data.area === 'table').length, 1);
    remember(stream);
    stream.close();
  });

  await step('a burst is delivered in commit order', async () => {
    const stream = listen('/live', tokenA);
    await stream.ready();
    const from = stream.messages.length;
    const made = [];
    for (let n = 0; n < 6; n += 1) made.push((await takeaway(A)).id);
    await stream.until(() => made.every((id) => stream.changes(from).some((m) => m.data.area === 'order' && m.data.id === id)));
    const firsts = made.map((id) => stream.changes(from).findIndex((m) => m.data.area === 'order' && m.data.id === id));
    assert.deepEqual([...firsts].sort((a, b) => a - b), firsts, 'in the order they were made');
    // Six at once: every one arrives, each message numbered after the one before.
    const together = (await Promise.all(Array.from({ length: 6 }, () => takeaway(A)))).map((order) => order.id);
    await stream.until(() => together.every((id) => stream.changes(from).some((m) => m.data.area === 'order' && m.data.id === id)));
    const numbers = stream.changes(from).map((m) => m.id);
    assert.ok(numbers.every((number, i) => i === 0 || number > numbers[i - 1]), `numbered in order: ${numbers}`);
    remember(stream);
    stream.close();
  });

  await step('someone tied to an outlet hears only of theirs, and of what belongs to no outlet', async () => {
    const theirs = listen('/live', pinnedToken);
    const everyone = listen('/live', tokenA);
    await Promise.all([theirs.ready(), everyone.ready()]);
    const fromTheirs = theirs.messages.length;
    const fromEveryone = everyone.messages.length;
    const other = await as(tokenA, { 'X-Outlet-Id': String(outlet2.id) })('POST', '/business-day/open', { openingCash: 500 }, 201);
    await everyone.change(fromEveryone, 'business_day', other.id);
    assert.equal(everyone.changes(fromEveryone).find((m) => m.data.id === other.id).data.outlet, outlet2.id);
    const own = await as(tokenA, { 'X-Outlet-Id': String(outlet1.id) })('POST', '/business-day/open', { openingCash: 500 }, 201);
    const heard = await theirs.change(fromTheirs, 'business_day', own.id);
    assert.equal(heard.data.outlet, outlet1.id);
    const counter = await takeaway(A);
    await theirs.change(fromTheirs, 'order', counter.id);
    assert.equal(theirs.changes(fromTheirs).some((m) => m.data.id === other.id && m.data.area === 'business_day'), false);
    for (const each of [theirs, everyone]) { remember(each); each.close(); }
  });

  await step("a business's change reaches its own streams, at its location, and a repeated posting announces nothing", async () => {
    const shop = listen(`/businesses/${grocery.id}/live`, tokenA);
    const tied = listen(`/businesses/${grocery.id}/live`, meenaToken);
    const theirs = listen(`/businesses/${elsewhere.id}/live`, tokenB);
    const care = listen(`/businesses/${clinic.id}/live`, tokenA);
    const restaurant = listen('/live', tokenA);
    await Promise.all([shop.ready(), tied.ready(), theirs.ready(), care.ready(), restaurant.ready()]);
    const from = new Map([shop, tied, theirs, care, restaurant].map((stream) => [stream, stream.messages.length]));
    const atMain = await A('POST', G('documents'), sale(main.id), 201);
    const heard = await shop.change(from.get(shop), 'sale', atMain.id);
    assert.deepEqual(heard.data, { area: 'sale', id: atMain.id, location: main.id });
    const repeatKey = key();
    const atBranch = await A('POST', G('documents'), sale(branch.id, repeatKey), 201);
    assert.deepEqual((await tied.change(from.get(tied), 'sale', atBranch.id)).data, { area: 'sale', id: atBranch.id, location: branch.id });
    // The same posting again (same key, same body) is the first one: nothing is written or announced.
    await shop.change(from.get(shop), 'sale', atBranch.id);
    const fromShop = shop.messages.length;
    assert.equal((await A('POST', G('documents'), sale(branch.id, repeatKey), 201)).id, atBranch.id);
    // A clinic's token queue, and a restaurant's own task (its business is the restaurant's).
    const patient = await A('POST', C('clinic/patients'), { name: 'Swathi Reddy', phone: '9000000001', sex: 'female', ageYears: 34,
      consent: { purposes: ['treatment'], method: 'signed_form', givenBy: 'Self' } }, 201);
    const token = await A('POST', C('clinic/tokens'), { contactId: patient.contact_id }, 201);
    await care.change(from.get(care), 'token', token.id);
    const task = await A('POST', '/tasks', { title: 'Check the cold room' }, 201);
    await restaurant.change(from.get(restaurant), 'task', task.id);
    await quiet([[shop, fromShop]], (data) => data.area === 'sale');
    // The tied cashier never heard of the main counter's sale; nothing reached the other owner's shop.
    assert.equal(tied.changes(from.get(tied)).some((m) => m.data.id === atMain.id), false);
    assert.deepEqual(theirs.changes(from.get(theirs)), []);
    assert.equal(shop.changes(from.get(shop)).some((m) => m.data.area === 'token' || m.data.area === 'task'), false);
    for (const each of [shop, tied, theirs, care, restaurant]) { remember(each); each.close(); }
  });

  await step('a stream ends when its session or access does', async () => {
    // Signed out everywhere from another device: the stream on this one ends at once.
    const stream = listen('/live', tokenA);
    await stream.ready();
    const elsewhereToken = (await signIn(base, 'live-a@test.invalid', password)).token;
    const fresh = await as(elsewhereToken)('POST', '/auth/sign-out-others', {});
    const signedOut = await stream.ended(5000);
    assert.equal(signedOut.data.reason, 'session_ended');
    ownerToken = fresh.token;
    A = as(ownerToken);
    // A login switched off.
    const cashier = listen('/live', pinnedToken);
    await cashier.ready();
    const current = await as(ownerToken)('GET', `/users/${pinned.id}`);
    await as(ownerToken)('PUT', `/users/${pinned.id}`, { name: current.name, email: current.email, roleIds: [cashierRole.id], outletId: outlet1.id, status: 'inactive' });
    assert.equal((await cashier.ended(5000)).data.reason, 'session_ended');
    // Moved to another location: the screen opens a new stream; then the membership ends.
    const tied = listen(`/businesses/${grocery.id}/live`, meenaToken);
    await tied.ready();
    await as(ownerToken)('POST', G('members'), { userId: cashierAt.id, roleId: cashierTemplate.id, workLocationId: main.id }, 201);
    assert.equal((await tied.ended(5000)).data.reason, 'changed');
    const moved = listen(`/businesses/${grocery.id}/live`, meenaToken);
    assert.equal((await moved.ready()).data.location, main.id);
    await as(ownerToken)('POST', G('members'), { userId: cashierAt.id, roleId: cashierTemplate.id, workLocationId: main.id, active: false }, 201);
    assert.equal((await moved.ended(5000)).data.reason, 'access_ended');
    assert.equal((await refused(`/businesses/${grocery.id}/live`, meenaToken)).status, 404);
    // A token that runs out ends its stream within a few seconds of its end.
    const version = (await one('SELECT token_version FROM users WHERE id=$1', [ownerA.id])).token_version;
    const shortLived = jwt.sign({ restaurantId: ownerA.restaurant_id, tv: version }, process.env.JWT_SECRET, { subject: String(ownerA.id), expiresIn: 3 });
    const brief = listen('/live', shortLived);
    await brief.ready();
    assert.equal((await brief.ended(12000)).data.reason, 'session_ended');
    for (let tries = 0; tries < 50 && hub.stats().streams > 0; tries += 1) await wait(100);
    assert.equal(hub.stats().streams, 0);
    // A client that goes leaves nothing behind.
    const going = listen('/live', ownerToken);
    await going.ready();
    assert.equal(hub.stats().streams, 1);
    going.close();
    await wait(300);
    assert.deepEqual(hub.stats(), { streams: 0, people: 0, scopes: 0, sweeping: false, listening: true });
  });

  await step('a cap on streams per person and per process, and nothing kept once they close', async () => {
    const staff = [];
    for (const name of ['third', 'fourth']) {
      const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerA.restaurant_id, name, `${name}@test.invalid`, hash]);
      await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='CASHIER' AND restaurant_id IS NULL", [person.id]);
      staff.push(await login(`${name}@test.invalid`));
    }
    const opened = [];
    for (let n = 0; n < 4; n += 1) opened.push(listen('/live', ownerToken));
    await Promise.all(opened.map((stream) => stream.ready()));
    // A fifth for the same person is refused; the screen keeps its slow refresh.
    const tooMany = await refused('/live', ownerToken);
    assert.equal(tooMany.status, 429);
    assert.equal(tooMany.body.data.reason, 'live_limit');
    // Others fill the process up to its cap of 12, and then anyone is refused.
    for (const token of [tokenB, staff[0]]) for (let n = 0; n < 4; n += 1) opened.push(listen('/live', token));
    await Promise.all(opened.map((stream) => stream.ready()));
    assert.equal(hub.stats().streams, 12);
    const full = await refused('/live', staff[1]);
    assert.equal(full.status, 429);
    assert.equal(full.body.data.reason, 'live_full');
    for (const stream of opened) stream.close();
    await wait(500);
    assert.deepEqual(hub.stats(), { streams: 0, people: 0, scopes: 0, sweeping: false, listening: true });
  });

  await step('a quiet stream gets a keep-alive comment within 25 seconds', async () => {
    const stream = listen('/live', tokenB);
    await stream.ready();
    const started = Date.now();
    await stream.until(() => stream.comments > 0, 35000, 'a keep-alive');
    // At most 25 seconds of silence, give or take a busy machine's timers.
    assert.ok(Date.now() - started <= 30000, `after ${Date.now() - started} ms`);
    stream.close();
  });

  const liveConnections = async () => (await one(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='live updates' AND datname=$1`, [database])).n;

  await step('the listening connection comes back after a drop, and every screen reads again', async () => {
    const stream = listen('/live', ownerToken);
    await stream.ready();
    assert.equal(await liveConnections(), 1);
    const from = stream.messages.length;
    await one(`SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE application_name='live updates' AND datname=$1`, [database]);
    await stream.until(() => stream.messages.slice(from).find((m) => m.event === 'resync'), 15000, 'a resync after the drop');
    assert.equal(await liveConnections(), 1);
    const order = await takeaway(A);
    await stream.change(from, 'order', order.id);
    stream.close();
  });

  await step('a second API process hears the same changes, and its kept dashboard answers are cleared by them', async () => {
    const port = await new Promise((resolve) => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); }); });
    const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, NODE_ENV: 'test', DB_NAME: database, PORT: String(port), JWT_SECRET: process.env.JWT_SECRET, LOGIN_ATTEMPT_LIMIT: '5000' } });
    let output = '';
    const exited = new Promise((resolve) => child.on('exit', resolve));
    second = { stop: async () => { child.kill(); await exited; } };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the second API did not start: ${output}`)), 60000);
      const read = (chunk) => { output += chunk; if (/Server running on port/.test(output)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
    });
    const other = `http://127.0.0.1:${port}/api`;
    const there = listen('/live', ownerToken, {}, other);
    const here = listen('/live', ownerToken);
    await Promise.all([there.ready(), here.ready()]);
    // Each process listens on a connection of its own.
    assert.equal(await liveConnections(), 2);
    const order = await takeaway(A);
    await there.change(0, 'order', order.id);
    // The dashboard here keeps its answer for a few seconds; a change made through the other process clears it.
    const before = (await call('GET', '/reports/dashboard', undefined, ownerToken)).body.data.openOrders;
    const from = here.messages.length;
    const madeThere = await call('POST', '/orders', { orderType: 'takeaway', items: [{ productId: dalA.id, quantity: 1 }] }, ownerToken, {}, other);
    assert.equal(madeThere.status, 201);
    await here.change(from, 'order', madeThere.body.data.id);
    assert.equal((await call('GET', '/reports/dashboard', undefined, ownerToken)).body.data.openOrders, before + 1);
    there.close();
    here.close();
    await second.stop();
    second = null;
    for (let tries = 0; tries < 50 && (await liveConnections()) > 1; tries += 1) await wait(200);
    assert.equal(await liveConnections(), 1);
  });

  await t.test('every message says where and what changed, never the data', () => {
    assert.ok(seenChanges.length > 20);
    for (const { data, raw } of seenChanges) {
      assert.match(data.area, /^[a-z][a-z_]*$/);
      assert.ok(Number.isSafeInteger(data.id) && data.id > 0, raw);
      assert.ok(Object.keys(data).every((name) => ['area', 'id', 'outlet', 'location'].includes(name)), raw);
      assert.ok(!('outlet' in data && 'location' in data), raw);
      assert.doesNotMatch(raw, /Dal makhani|Bath soap|Swathi|9000000001|cash/);
    }
  });

  await step('stopping ends every stream, and closes the listening connection', async () => {
    const stream = listen('/live', ownerToken);
    await stream.ready();
    await hub.stop();
    assert.equal((await stream.ended(5000)).data.reason, 'restarting');
    assert.equal(hub.stats().listening, false);
    assert.equal(await liveConnections(), 0);
    const restarting = await refused('/live', ownerToken);
    assert.equal(restarting.status, 503);
    assert.equal(restarting.body.data.reason, 'restarting');
    hub = null;
  });
});
