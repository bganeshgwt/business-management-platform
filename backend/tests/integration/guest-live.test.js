const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Guests' live updates: a guest's page (a table's QR page, an online order's
// status, a booking's status) hears of changes to what it shows through
// GET /api/public/live?key=…, with the guest live key its status answer
// carries. The key names one restaurant or business and the rows it may
// watch, and is good for two hours; each answer brings one while something
// can still happen, none once nothing can. A stream hears the changes of its
// rows only, never another row of the same restaurant, never another
// restaurant's or business's row with the same id; each message says only
// the area and the id. A key changed, made up, or past its two hours is
// refused, and a stream ends when its key does. The limits per key, per
// client address and per process hold, apart from the staff's streams, and
// streams that close leave nothing behind. The request log never prints a
// key. A resync after the listening connection drops, and the "restarting"
// end, reach the guests' streams too. Runs on its own throwaway database
// with every migration applied.
test('guest live updates', { timeout: 600000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  const streams = new Set();
  let pool, server, hub, created = false;
  await admin.connect();
  t.after(async () => {
    for (const stream of streams) stream.close();
    if (hub) await hub.stop();
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
  // Limits small enough to reach; one proxy in front, so a test can be several addresses.
  process.env.LIVE_GUEST_STREAMS_PER_ADDRESS = '4';
  process.env.LIVE_GUEST_STREAMS_MAX = '9';
  process.env.TRUST_PROXY = '1';
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    direction: 'up', count: Infinity, checkOrder: true, log() {} });

  pool = require('../../src/config/database');
  hub = require('../../src/modules/live/services/liveHub');
  const guestKeys = require('../../src/modules/live/services/guestKeys');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const password = `Guest-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  async function owner(code) {
    const restaurant = await one("INSERT INTO restaurants(name,code,contact) VALUES($1,$1,'040 2222 3333') RETURNING id", [code]);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,restaurant_id', [restaurant.id, code, `${code}@test.invalid`, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
    return person;
  }
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth, headers = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  // A guest's call: the whole answer, `live` beside `data`.
  const guest = async (method, route, body, expected = 200) => {
    const result = await call(method, route, body);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clientKey = () => crypto.randomUUID();
  const watchOf = (live) => guestKeys.verify(live.key).watch;

  // A guest page's stream, read as a browser's EventSource reads it: no
  // Authorization header, the key in the address.
  function listen(key, headers = {}) {
    const controller = new AbortController();
    const route = `/public/live?key=${encodeURIComponent(key)}`;
    const stream = { status: 0, headers: null, body: null, messages: [], comments: 0, retry: null, done: false, close: () => controller.abort() };
    let wake = () => {};
    const arrived = () => { const waiting = wake; wake = () => {}; waiting(); };
    streams.add(stream);
    stream.opened = fetch(base + route, { headers: { Accept: 'text/event-stream', 'Accept-Encoding': 'gzip, deflate', ...headers }, signal: controller.signal })
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
                if (block.startsWith('retry:')) { stream.retry = Number(block.slice(6)); continue; }
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
    stream.until = (check, ms = 8000, what = 'a guest stream') => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { wake = () => {}; reject(new Error(`${what}: not within ${ms} ms. Messages: ${JSON.stringify(stream.messages.map((m) => [m.event, m.data]))}`)); }, ms);
      const look = () => {
        const found = check(stream);
        if (found) { clearTimeout(timer); resolve(found); } else wake = look;
      };
      look();
    });
    stream.changes = (from = 0) => stream.messages.slice(from).filter((m) => m.event === 'change');
    stream.change = (from, area, id, ms) => stream.until(() => stream.changes(from).find((m) => m.data.area === area && m.data.id === Number(id)), ms, `a change of ${area} ${id}`);
    stream.ready = async () => {
      await stream.opened;
      assert.equal(stream.status, 200, JSON.stringify(stream.body));
      return stream.until(() => stream.messages.find((m) => m.event === 'ready'), 8000, 'ready');
    };
    stream.ended = (ms = 10000) => stream.until(() => stream.done && (stream.messages.find((m) => m.event === 'end') || { event: 'closed' }), ms, 'the end');
    return stream;
  }
  const refused = async (key, headers) => {
    const stream = listen(key, headers);
    await stream.opened;
    return { status: stream.status, body: stream.body };
  };
  // Nothing arrives on these streams for `ms` after message `from` of each.
  const quiet = async (pairs, ms = 1500) => {
    await wait(ms);
    for (const [stream, from] of pairs) assert.deepEqual(stream.changes(from).map((m) => m.data), [], 'nothing else arrives');
  };
  const step = (name, work) => t.test(name, async () => {
    try {
      await work();
    } finally {
      for (const stream of streams) stream.close();
      streams.clear();
      for (let tries = 0; tries < 50 && hub && hub.guestStats().streams > 0; tries += 1) await wait(100);
    }
  });
  const seen = [];
  const remember = (stream) => seen.push(...stream.changes().map((m) => ({ data: m.data, raw: m.raw })));

  // --- Two restaurants, a table each, an owner's two shops ------------------------------------
  const ownerA = await owner('guest-a');
  await owner('guest-b');
  const tokenA = await login('guest-a@test.invalid');
  const tokenB = await login('guest-b@test.invalid');
  const A = as(tokenA);
  const B = as(tokenB);
  const ridA = Number(ownerA.restaurant_id);
  await A('POST', '/business-day/open', { openingCash: 1000 }, 201);
  await B('POST', '/business-day/open', { openingCash: 1000 }, 201);
  const menuOf = async (request) => {
    const category = await request('POST', '/menu/categories', { name: 'Main course' }, 201);
    return request('POST', '/menu/products', { categoryId: category.id, name: 'Paneer tikka', price: 280, taxPercentage: 0, foodType: 'veg', isAvailable: true }, 201);
  };
  const dishA = await menuOf(A);
  const dishB = await menuOf(B);
  const floorA = await A('POST', '/tables/floors', { name: 'Ground floor' }, 201);
  for (const tableNo of ['1', '2']) await A('POST', '/tables', { floorId: floorA.id, tableNo, capacity: 4 }, 201);
  const floorB = await B('POST', '/tables/floors', { name: 'Terrace' }, 201);
  await B('POST', '/tables', { floorId: floorB.id, tableNo: '1', capacity: 4 }, 201);
  const [tableA1, tableA2] = (await A('GET', '/tables')).sort((a, b) => Number(a.tableNo) - Number(b.tableNo));
  const [tableB1] = await B('GET', '/tables');
  const qrOrder = (table, dish = dishA) => guest('POST', `/public/tables/${table.qrToken}/orders`, { clientKey: clientKey(), items: [{ productId: dish.id, quantity: 1 }] }, 201);
  const followed = (table, ids) => guest('GET', `/public/tables/${table.qrToken}/requests?ids=${ids.join(',')}`);

  // --- The keys each status answer carries ---------------------------------------------------
  let order1;
  await step("a table's QR answer carries a key for its requests still moving, and the order each made", async () => {
    const placed = (await qrOrder(tableA1)).data;
    let answer = await followed(tableA1, [placed.id]);
    assert.equal(answer.data[0].id, placed.id);
    const key = guestKeys.verify(answer.live.key);
    assert.deepEqual(key, { v: 1, restaurant: ridA, watch: [{ area: 'table_request', id: placed.id }], exp: key.exp });
    // Two hours, given or taken a slow machine's second.
    const ends = Date.parse(answer.live.expiresAt);
    assert.ok(Math.abs(ends - (Date.now() + 2 * 3600 * 1000)) < 10000, answer.live.expiresAt);
    // Accepted: the order it made is watched too, for the kitchen's progress.
    const accepted = await A('POST', `/table-requests/${placed.id}/accept`, {});
    order1 = { id: accepted.order.id, request: placed.id };
    answer = await followed(tableA1, [placed.id]);
    assert.deepEqual(watchOf(answer.live), [{ area: 'order', id: accepted.order.id }, { area: 'table_request', id: placed.id }]);
    // A call for water joins; cancelled, it drops out.
    const water = (await guest('POST', `/public/tables/${tableA1.qrToken}/calls`, { type: 'water', clientKey: clientKey() }, 201)).data;
    answer = await followed(tableA1, [placed.id, water.id]);
    assert.deepEqual(watchOf(answer.live).map((row) => row.id).sort((a, b) => a - b), [accepted.order.id, placed.id, water.id].sort((a, b) => a - b));
    await guest('POST', `/public/tables/${tableA1.qrToken}/requests/${water.id}/cancel`);
    answer = await followed(tableA1, [placed.id, water.id]);
    assert.equal(watchOf(answer.live).some((row) => row.id === water.id && row.area === 'table_request'), false);
    // Only cancelled requests: nothing is moving, so no key; and no ids, no key.
    answer = await followed(tableA1, [water.id]);
    assert.equal(answer.live, null);
    assert.equal((await followed(tableA1, [])).live, null);
    // Another table's code never reads this table's requests, nor gives a key for them.
    answer = await followed(tableA2, [placed.id]);
    assert.deepEqual([answer.data, answer.live], [[], null]);
  });

  let online;
  await step("an online order's status answer carries a key for the request and, once accepted, its order; none once final", async () => {
    const SS = '/orders/service-settings/online-ordering';
    const link = (await A('GET', SS)).links[0];
    await A('PUT', `${SS}/${link.id}`, { enabled: true });
    const sent = (await guest('POST', `/public/online/${link.token}/orders`, { clientKey: clientKey(), service: 'takeaway', paymentMode: 'pay_at_pickup',
      guestName: 'Priya Sharma', guestMobile: '98200 10001', items: [{ productId: dishA.id, quantity: 1 }] }, 201)).data;
    const requestId = Number((await one('SELECT id FROM table_requests WHERE guest_token=$1', [sent.guestToken])).id);
    const at = `/public/online/${link.token}/orders/${sent.guestToken}`;
    let answer = await guest('GET', at);
    assert.equal(answer.data.stage, 'sent');
    assert.deepEqual(watchOf(answer.live), [{ area: 'table_request', id: requestId }]);
    assert.equal(guestKeys.verify(answer.live.key).restaurant, ridA);
    const accepted = await A('POST', `/table-requests/${requestId}/accept`, {});
    answer = await guest('GET', at);
    assert.equal(answer.data.stage, 'accepted');
    assert.deepEqual(watchOf(answer.live), [{ area: 'order', id: accepted.order.id }, { area: 'table_request', id: requestId }]);
    online = { link, guestToken: sent.guestToken, requestId, orderId: accepted.order.id, at };
    // Cancelled by the guest before anyone took it: final, no key, in the cancel's answer too.
    const other = (await guest('POST', `/public/online/${link.token}/orders`, { clientKey: clientKey(), service: 'takeaway', paymentMode: 'pay_at_pickup',
      guestName: 'Rahul Varma', guestMobile: '98200 10002', items: [{ productId: dishA.id, quantity: 1 }] }, 201)).data;
    const cancelled = await guest('POST', `/public/online/${link.token}/orders/${other.guestToken}/cancel`);
    assert.deepEqual([cancelled.data.stage, cancelled.live], ['cancelled', null]);
    assert.equal((await guest('GET', `/public/online/${link.token}/orders/${other.guestToken}`)).live, null);
  });

  let booking;
  await step("a booking's status answer carries a key for its reservation while it can still change", async () => {
    const week = Array.from({ length: 7 }, (_, day) => ({ dayOfWeek: day, isOpen: true, periods: [{ openTime: '12:00', closeTime: '15:30' }, { openTime: '19:00', closeTime: '23:30' }] }));
    await A('PUT', '/restaurants/current/business-hours', { days: week });
    const settings = await A('GET', '/reservations/online-settings');
    await A('PUT', '/reservations/online-settings', { isEnabled: true, maxPartySize: 6, seatSharePercent: 50, minNoticeMinutes: 60, daysAhead: 30,
      durationMinutes: 90, maxOpenPerMobile: 3, blockedDates: [], guestNote: null });
    const date = daysFrom(3);
    const ask = (mobile) => guest('POST', `/public/booking/${settings.token}/requests`, { date, time: '19:30', partySize: 2, guestName: 'Ananya Reddy', guestMobile: mobile }, 201);
    const first = (await ask('98480 11111')).data;
    const row = await one('SELECT id FROM reservations WHERE guest_token=$1', [first.guestToken]);
    let answer = await guest('GET', `/public/booking/status/${first.guestToken}`);
    assert.equal(answer.data.status, 'requested');
    assert.deepEqual(watchOf(answer.live), [{ area: 'reservation', id: Number(row.id) }]);
    booking = { guestToken: first.guestToken, id: Number(row.id) };
    // Declined: nothing more can happen, so no key; cancelled by the guest, none in the cancel's answer.
    const second = (await ask('98480 22222')).data;
    const secondRow = await one('SELECT id FROM reservations WHERE guest_token=$1', [second.guestToken]);
    await A('PATCH', `/reservations/${secondRow.id}/decline`, { reason: 'Fully booked that evening' });
    answer = await guest('GET', `/public/booking/status/${second.guestToken}`);
    assert.deepEqual([answer.data.status, answer.live], ['declined', null]);
    const third = (await ask('98480 33333')).data;
    const cancelled = await guest('POST', `/public/booking/status/${third.guestToken}/cancel`);
    assert.deepEqual([cancelled.data.status, cancelled.live], ['cancelled', null]);
  });

  // --- The stream ----------------------------------------------------------------------------
  await step('a stream opens with the key alone, from any web address, uncompressed', async () => {
    const answer = await followed(tableA1, [order1.request]);
    const stream = listen(answer.live.key, { Origin: 'https://order.example.com' });
    const ready = await stream.ready();
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(stream.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(stream.headers.get('x-accel-buffering'), 'no');
    assert.equal(stream.headers.get('content-encoding'), null);
    assert.equal(stream.headers.get('access-control-allow-origin'), 'https://order.example.com');
    assert.deepEqual(ready.data, { keepAliveSeconds: 25, expiresAt: answer.live.expiresAt });
    // A browser left to itself waits 15 seconds before it reconnects.
    assert.equal(stream.retry, 15000);
    assert.deepEqual(hub.guestStats(), { streams: 1, addresses: 1, keys: 1, scopes: 1, sweeping: true });
    // The staff's own counts never see a guest.
    assert.deepEqual(hub.stats(), { streams: 0, people: 0, scopes: 0, sweeping: false, listening: true });
    stream.close();
    for (let tries = 0; tries < 30 && hub.guestStats().streams > 0; tries += 1) await wait(100);
    assert.deepEqual(hub.guestStats(), { streams: 0, addresses: 0, keys: 0, scopes: 0, sweeping: false });
  });

  await step("a table's stream hears its own request and its order move on, and nothing of another table's or restaurant's", async () => {
    const placed = (await qrOrder(tableA2)).data;
    const mine = listen((await followed(tableA2, [placed.id])).live.key);
    // A key for the other restaurant that names this restaurant's rows by their ids.
    const forged = listen(guestKeys.issue({ restaurant: Number((await one("SELECT id FROM restaurants WHERE code='guest-b'")).id), watch: [{ area: 'table_request', id: placed.id }] }).key);
    await Promise.all([mine.ready(), forged.ready()]);
    // Another table's request, at the same restaurant, moving on: not this page's.
    const elsewhere = (await qrOrder(tableA1)).data;
    await A('POST', `/table-requests/${elsewhere.id}/accept`, {});
    // The other restaurant's own order.
    const theirs = (await qrOrder(tableB1, dishB)).data;
    await B('POST', `/table-requests/${theirs.id}/accept`, {});
    await quiet([[mine, 0], [forged, 0]]);
    // Accepted: this page hears of it within a moment, and reads it again.
    const started = Date.now();
    const accepted = await A('POST', `/table-requests/${placed.id}/accept`, {});
    const heard = await mine.change(0, 'table_request', placed.id, 5000);
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(heard.data, { area: 'table_request', id: placed.id });
    assert.equal(heard.raw, `event: change\ndata: ${JSON.stringify({ area: 'table_request', id: placed.id })}`);
    let answer = await followed(tableA2, [placed.id]);
    assert.equal(answer.data[0].stage, 'accepted');
    // The new answer's key watches the order too: the kitchen's ticket made ready moves it on.
    const next = listen(answer.live.key);
    await next.ready();
    const [ticket] = await A('GET', `/kitchen/orders/${accepted.order.id}/kots`);
    await A('PATCH', `/kitchen/kots/${ticket.id}/status`, { status: 'ready' });
    await next.change(0, 'order', accepted.order.id, 5000);
    answer = await followed(tableA2, [placed.id]);
    assert.equal(answer.data[0].stage, 'ready');
    // Served: the guest's request is final, so the next answer has no key.
    await A('PATCH', `/kitchen/kots/${ticket.id}/status`, { status: 'served' });
    await next.change(0, 'order', accepted.order.id, 5000);
    answer = await followed(tableA2, [placed.id]);
    assert.deepEqual([answer.data[0].stage, answer.data[0].final, answer.live], ['served', true, null]);
    // The other restaurant's key heard nothing of any of it.
    assert.deepEqual(forged.changes(), []);
    for (const each of [mine, forged, next]) { remember(each); each.close(); }
  });

  await step("an online order's and a booking's pages hear their own rows move on", async () => {
    const order = listen((await guest('GET', online.at)).live.key);
    const table = listen((await guest('GET', `/public/booking/status/${booking.guestToken}`)).live.key);
    await Promise.all([order.ready(), table.ready()]);
    // The kitchen makes the takeaway ready: the order's own row.
    const [ticket] = await A('GET', `/kitchen/orders/${online.orderId}/kots`);
    await A('PATCH', `/kitchen/kots/${ticket.id}/status`, { status: 'ready' });
    await order.change(0, 'order', online.orderId, 5000);
    assert.equal((await guest('GET', online.at)).data.stage, 'ready');
    // The booking accepted, with a table: the reservation's row.
    await A('PATCH', `/reservations/${booking.id}/accept`, { tableId: Number(tableA1.id) });
    await table.change(0, 'reservation', booking.id, 5000);
    const answer = await guest('GET', `/public/booking/status/${booking.guestToken}`);
    assert.equal(answer.data.status, 'confirmed');
    // Still followed while confirmed: the restaurant may still call it off.
    assert.deepEqual(watchOf(answer.live), [{ area: 'reservation', id: booking.id }]);
    // Neither heard the other's row.
    assert.equal(order.changes().some((m) => m.data.area === 'reservation'), false);
    assert.equal(table.changes().some((m) => m.data.area === 'order'), false);
    for (const each of [order, table]) { remember(each); each.close(); }
  });

  let shop;
  await step("a business's key hears its own business's rows, never another's with the same id", async () => {
    const [grocery, other] = await createBusinesses(A, 'GUEST', ['grocery', 'books']);
    const G = (business, suffix) => `/businesses/${business.id}/${suffix}`;
    const serviceOf = async (business) => A('POST', G(business, 'catalog'), { kind: 'service', unit: 'service', tracking: 'none', taxRate: '18', name: 'Gift wrapping', code: 'WRAP', price: '50' }, 201);
    const sale = async (business, sku) => {
      const location = (await A('GET', G(business, 'locations'))).items[0];
      return A('POST', G(business, 'documents'), { kind: 'sale', requestKey: crypto.randomUUID(), locationId: location.id, lines: [{ skuId: sku.id, quantity: '1' }],
        payment: { amount: 'full', method: 'cash' } }, 201);
    };
    const wrap = await serviceOf(grocery);
    const wrapOther = await serviceOf(other);
    const first = await sale(grocery, wrap);
    // The grocery's page watching its next bill's id, and the other shop's key naming the same ids.
    const nextId = Number(first.id) + 1;
    const mine = listen(guestKeys.issue({ business: grocery.id, watch: [{ area: 'sale', id: nextId }, { area: 'sale', id: nextId + 1 }] }).key);
    const theirs = listen(guestKeys.issue({ business: other.id, watch: [{ area: 'sale', id: nextId }, { area: 'sale', id: nextId + 1 }] }).key);
    const restaurant = listen(guestKeys.issue({ restaurant: ridA, watch: [{ area: 'sale', id: nextId }, { area: 'sale', id: nextId + 1 }] }).key);
    await Promise.all([mine.ready(), theirs.ready(), restaurant.ready()]);
    const own = await sale(grocery, wrap);
    await mine.change(0, 'sale', own.id, 5000);
    const theirSale = await sale(other, wrapOther);
    await theirs.change(0, 'sale', theirSale.id, 5000);
    await quiet([[restaurant, 0]]);
    assert.equal(mine.changes().some((m) => Number(m.data.id) === Number(theirSale.id)), false);
    assert.equal(theirs.changes().some((m) => Number(m.data.id) === Number(own.id)), false);
    // Never the location a business's change carries for its staff.
    assert.deepEqual(mine.changes().map((m) => Object.keys(m.data).sort()), [['area', 'id']]);
    shop = grocery;
    for (const each of [mine, theirs, restaurant]) { remember(each); each.close(); }
  });

  // --- Refusals, the end of a key, the limits -------------------------------------------------
  await step('a key that is missing, made up, changed, run out or sent any other way is refused', async () => {
    const good = (await followed(tableA1, [order1.request])).live.key;
    const [body, sign] = good.split('.');
    const swapped = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    swapped.restaurant += 1;
    const cases = [
      ['', 'invalid_key'],
      ['not-a-key', 'invalid_key'],
      [`${body}.${sign.slice(0, -2)}AA`, 'invalid_key'],
      [`${Buffer.from(JSON.stringify(swapped)).toString('base64url')}.${sign}`, 'invalid_key'],
      [guestKeys.keysFor(crypto.randomBytes(48).toString('hex')).issue({ restaurant: ridA, watch: [{ area: 'order', id: order1.id }] }).key, 'invalid_key'],
      [guestKeys.issue({ restaurant: ridA, watch: [{ area: 'order', id: order1.id }] }, { now: Date.now() - 2 * 3600 * 1000 - 1000 }).key, 'key_expired'],
    ];
    for (const [key, reason] of cases) {
      const answer = await refused(key);
      assert.equal(answer.status, 403, key);
      assert.equal(answer.body.data.reason, reason, key);
    }
    const expired = await refused(cases.at(-1)[0]);
    assert.match(expired.body.message, /fresh key/);
    // No key in the address: a staff login, or the key in a header, opens nothing.
    for (const headers of [{ Authorization: `Bearer ${tokenA}` }, { 'X-Guest-Key': good }]) {
      const response = await fetch(`${base}/public/live`, { headers, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).data.reason, 'invalid_key');
    }
    // The key twice in the address is no key.
    const twice = await fetch(`${base}/public/live?key=${encodeURIComponent(good)}&key=${encodeURIComponent(good)}`, { signal: AbortSignal.timeout(10000) });
    assert.equal(twice.status, 403);
    assert.equal(hub.guestStats().streams, 0);
  });

  await step('a stream ends when its key does, saying so, and leaves nothing behind', async () => {
    // A key issued two hours less three seconds ago.
    const brief = guestKeys.issue({ restaurant: ridA, watch: [{ area: 'order', id: order1.id }] }, { now: Date.now() - 2 * 3600 * 1000 + 3000 });
    const stream = listen(brief.key);
    await stream.ready();
    const ended = await stream.ended(15000);
    assert.deepEqual(ended.data, { reason: 'expired' });
    for (let tries = 0; tries < 30 && hub.guestStats().streams > 0; tries += 1) await wait(100);
    assert.deepEqual(hub.guestStats(), { streams: 0, addresses: 0, keys: 0, scopes: 0, sweeping: false });
  });

  await step('three streams a key, four an address and nine a process; the staff streams are counted apart', async () => {
    const keyOf = (id) => guestKeys.issue({ restaurant: ridA, watch: [{ area: 'order', id }] }).key;
    const from = (address) => ({ 'X-Forwarded-For': address });
    const opened = [];
    // One key in three tabs, from this machine; a fourth is refused.
    const shared = keyOf(order1.id);
    for (let n = 0; n < 3; n += 1) opened.push(listen(shared));
    await Promise.all(opened.map((stream) => stream.ready()));
    const fourth = await refused(shared);
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.data.reason, 'live_key_limit');
    // One restaurant's Wi-Fi: four pages, then the fifth is refused; another network is not.
    const wifi = [1, 2, 3, 4].map((n) => listen(keyOf(order1.id + n), from('198.51.100.7')));
    opened.push(...wifi);
    await Promise.all(wifi.map((stream) => stream.ready()));
    const fifth = await refused(keyOf(order1.id + 5), from('198.51.100.7'));
    assert.equal(fifth.status, 429);
    assert.equal(fifth.body.data.reason, 'live_address_limit');
    // Behind the proxy, the address is the visitor's, not the proxy's.
    const elsewhere = listen(keyOf(order1.id + 6), from('203.0.113.9'));
    const another = listen(keyOf(order1.id + 7), from('192.0.2.44'));
    opened.push(elsewhere, another);
    await Promise.all([elsewhere.ready(), another.ready()]);
    assert.equal(hub.guestStats().streams, 9);
    assert.equal(hub.guestStats().addresses, 4);
    // The process is full: anyone is refused.
    const full = await refused(keyOf(order1.id + 8), from('192.0.2.45'));
    assert.equal(full.status, 429);
    assert.equal(full.body.data.reason, 'live_full');
    // A staff screen still opens its own stream.
    const staffController = new AbortController();
    const staff = await fetch(`${base}/live`, { headers: { Authorization: `Bearer ${tokenA}`, Accept: 'text/event-stream' }, signal: staffController.signal });
    assert.equal(staff.status, 200);
    staffController.abort();
    for (const stream of opened) stream.close();
    for (let tries = 0; tries < 50 && (hub.guestStats().streams > 0 || hub.stats().streams > 0); tries += 1) await wait(100);
    assert.deepEqual(hub.guestStats(), { streams: 0, addresses: 0, keys: 0, scopes: 0, sweeping: false });
    assert.deepEqual(hub.stats(), { streams: 0, people: 0, scopes: 0, sweeping: false, listening: true });
  });

  await step('a quiet stream gets a ping the page can see within 25 seconds', async () => {
    const stream = listen((await followed(tableA1, [order1.request])).live.key);
    await stream.ready();
    const started = Date.now();
    const ping = await stream.until(() => stream.messages.find((m) => m.event === 'ping'), 35000, 'a ping');
    assert.deepEqual(ping.data, {});
    assert.ok(Date.now() - started <= 30000, `after ${Date.now() - started} ms`);
    // An event, never a comment: EventSource shows a page no comment.
    assert.equal(stream.comments, 0);
    stream.close();
  });

  await step('the request log never prints a key', async () => {
    const key = (await followed(tableA1, [order1.request])).live.key;
    const printed = [];
    const write = process.stdout.write;
    process.stdout.write = function capture(chunk, ...rest) {
      printed.push(String(chunk));
      return write.call(this, chunk, ...rest);
    };
    try {
      const stream = listen(key);
      await stream.ready();
      stream.close();
      await refused(`${key}x`);
      for (let tries = 0; tries < 30 && !printed.some((line) => line.includes('/api/public/live')); tries += 1) await wait(100);
      await wait(300);
    } finally {
      process.stdout.write = write;
    }
    const lines = printed.filter((line) => line.includes('/api/public/live'));
    assert.ok(lines.length >= 1, printed.join(''));
    assert.ok(lines.every((line) => line.includes('/api/public/live?key=hidden')), lines.join(''));
    assert.equal(printed.some((line) => line.includes(key.split('.')[0]) || line.includes(key.split('.')[1])), false);
  });

  await step("a guest's stream reads again after the listening connection drops", async () => {
    const stream = listen((await followed(tableA1, [order1.request])).live.key);
    await stream.ready();
    const from = stream.messages.length;
    await one(`SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE application_name='live updates' AND datname=$1`, [database]);
    const resync = await stream.until(() => stream.messages.slice(from).find((m) => m.event === 'resync'), 15000, 'a resync after the drop');
    assert.deepEqual(resync.data, {});
    stream.close();
  });

  await t.test('every message to a guest says only which row changed', () => {
    assert.ok(seen.length >= 6, JSON.stringify(seen));
    for (const { data, raw } of seen) {
      assert.deepEqual(Object.keys(data).sort(), ['area', 'id'], raw);
      assert.match(data.area, /^[a-z][a-z_]*$/);
      assert.ok(Number.isSafeInteger(data.id) && data.id > 0, raw);
      assert.doesNotMatch(raw, /Paneer|Priya|Ananya|98200|98480|outlet|location/);
    }
    assert.ok(shop);
  });

  await step("stopping ends the guests' streams too", async () => {
    const stream = listen((await followed(tableA1, [order1.request])).live.key);
    await stream.ready();
    await hub.stop();
    assert.deepEqual((await stream.ended(5000)).data, { reason: 'restarting' });
    const restarting = await refused((await followed(tableA1, [order1.request])).live.key);
    assert.equal(restarting.status, 503);
    assert.equal(restarting.body.data.reason, 'restarting');
    assert.deepEqual(hub.guestStats(), { streams: 0, addresses: 0, keys: 0, scopes: 0, sweeping: false });
    hub = null;
  });
});
