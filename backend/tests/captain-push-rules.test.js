const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moments = require('../src/modules/push/services/captainMoments');

// The server's rules for alerting a captain's closed phone
// (modules/push/services/captainMoments.js) beside the captain app's own
// (apps/business-web/src/workspaces/captain/captainFloor.js): the same
// moments, for the same people, and no others.

const NOW = Date.parse('2026-11-02T20:00:00+05:30');
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const appFloor = () => import(pathToFileURL(path.resolve(__dirname, '../../apps/business-web/src/workspaces/captain/captainFloor.js')).href);

// The floor: Ramesh (7) has T1 and T2 today, Priya (9) T3; T4 is nobody's;
// A1 belongs to outlet 5. Everyone may take orders, see calls and the pass.
const TABLES = [
  { id: 1, tableNo: 'T1', outletId: null, captain: { userId: 7 }, live: { orderId: 101 } },
  { id: 2, tableNo: 'T2', outletId: null, captain: { userId: 7 }, live: { orderId: 102 } },
  { id: 3, tableNo: 'T3', outletId: null, captain: { userId: 9 }, live: { orderId: 103 } },
  { id: 4, tableNo: 'T4', outletId: null, captain: null, live: { orderId: 104 } },
  { id: 11, tableNo: 'A1', outletId: 5, captain: null, live: { orderId: 111 } },
];
const ALL = ['captain_app', 'qr_ordering', 'kitchen_display', 'captain_sections'];
const PERMISSIONS = ['orders.create', 'orders.view', 'kot.manage'];
const tablesMap = new Map(TABLES.map((table) => [String(table.id), { outletId: table.outletId ? String(table.outletId) : null }]));
const captainsMap = new Map(TABLES.filter((table) => table.captain).map((table) => [String(table.id), String(table.captain.userId)]));
const context = (features = ALL) => ({ features: new Set(features), tables: tablesMap, captainOf: () => captainsMap, now: NOW });
const person = (userId, extra = {}) => ({ userId: String(userId), outletId: null, allTables: false, permissions: PERMISSIONS, lastPunch: null, ...extra });

const call = (id, tableId, type = 'water', extra = {}) => ({ id, table_id: tableId, table_no: TABLES.find((t) => t.id === tableId).tableNo, request_type: type,
  status: 'pending', outlet_id: TABLES.find((t) => t.id === tableId).outletId, channel: 'qr', created_by: null, created_at: ago(1), item_count: 0, ...extra });
const ticket = (id, orderId, extra = {}) => ({ id, orderId, status: 'ready', readyAt: ago(1), passSince: ago(1),
  items: [{ id: id * 10 + 1, liveQuantity: 2, isDone: true, doneAt: ago(1), servedAt: null }], ...extra });
const place = (tableId) => ({ tableId, tableNo: TABLES.find((t) => t.id === tableId).tableNo, ticketOutletId: TABLES.find((t) => t.id === tableId).outletId });

// What rings each person's phone in the app: the arrivals at the tables shown.
const appRings = async (userId, onlyMine, { requests = [], tickets = [] }) => {
  const floor = await appFloor();
  const rows = TABLES.map((table) => ({ ...table }));
  const mine = floor.sectionOf(rows, userId);
  const shown = floor.shownTables(rows, mine, onlyMine);
  const waiting = floor.waitingAt(rows, {
    requests: requests.map((r) => ({ id: r.id, tableId: r.table_id, type: r.request_type === 'call_waiter' ? 'call_waiter' : r.request_type, status: r.status,
      createdAt: r.created_at, askedBy: r.created_by })),
    tickets,
  });
  const { fresh } = floor.arrivals(new Set(), shown, waiting, { userId });
  return fresh.map(({ kind, table }) => `${kind === 'calls' ? 'call' : kind === 'orders' ? 'order' : 'ready'}:${table.id}`).sort();
};

// What the server sends each person's phone for the same changes.
const serverRings = (sub, { requests = [], tickets = [] }, ctx = context()) => [
  ...requests.map((row) => moments.requestMoment(row)),
  ...tickets.map((each) => moments.foodMoment(each, place(TABLES.find((t) => t.live.orderId === each.orderId).id))),
].filter((moment) => moment && moments.receives(sub, moment, ctx)).map((moment) => `${moment.kind}:${moment.tableId}`).sort();

test('the same moments for the same people as the open app: My tables, All tables, nobody\'s section', async () => {
  const changes = {
    requests: [call(1, 1, 'water'), call(2, 3, 'call_waiter'), call(3, 4, 'bill'), call(4, 2, 'order', { status: 'processing', item_count: 3 })],
    tickets: [ticket(51, 101), ticket(53, 103), ticket(54, 104)],
  };
  for (const [userId, onlyMine] of [[7, true], [7, false], [9, true], [9, false], [12, true]]) {
    const sub = person(userId, { allTables: !onlyMine });
    assert.deepEqual(serverRings(sub, changes), await appRings(userId, onlyMine, changes), `user ${userId}, ${onlyMine ? 'my tables' : 'all tables'}`);
  }
  // Ramesh, his own tables: T1's water, T2's QR order, T1's food.
  assert.deepEqual(serverRings(person(7), changes), ['call:1', 'order:2', 'ready:1']);
  // Someone with no section today hears of every table.
  assert.equal(serverRings(person(12), changes).length, 7);
});

test('a waiter\'s own bill ask never rings their own phone, and does ring the table\'s captain', async () => {
  const changes = { requests: [call(5, 1, 'bill', { created_by: 9 })] };
  assert.deepEqual(serverRings(person(9, { allTables: true }), changes), await appRings(9, false, changes));
  assert.deepEqual(serverRings(person(9, { allTables: true }), changes), []);
  assert.deepEqual(serverRings(person(7), changes), ['call:1']);
  // A waiter's bill ask is in the inbox even with QR ordering off; a guest's call is not.
  const noQr = context(['captain_app', 'kitchen_display']);
  assert.deepEqual(serverRings(person(7), changes, noQr), ['call:1']);
  assert.deepEqual(serverRings(person(7), { requests: [call(6, 1, 'water')] }, noQr), []);
});

test('only what the person may see: the captain app, calls, the pass, and the outlet they work in', () => {
  const changes = { requests: [call(1, 1, 'water'), call(7, 11, 'call_waiter')], tickets: [ticket(51, 101), ticket(61, 111, { }) ] };
  // Food on A1 is outlet 5's ticket.
  const ctx = context();
  const ringsAt = (sub, extra = ctx) => serverRings(sub, changes, extra);
  assert.deepEqual(ringsAt(person(12)), ['call:1', 'call:11', 'ready:1', 'ready:11'].sort());
  assert.deepEqual(ringsAt(person(12, { permissions: ['orders.view', 'kot.manage'] })), [], 'no captain app without orders.create');
  assert.deepEqual(ringsAt(person(12), context(['qr_ordering', 'kitchen_display'])), [], 'the Captain app feature off');
  assert.deepEqual(ringsAt(person(12, { permissions: ['orders.create', 'kot.manage'] })), ['ready:1', 'ready:11'].sort(), 'no calls without orders.view');
  assert.deepEqual(ringsAt(person(12, { permissions: ['orders.create', 'orders.view'] })), ['call:1', 'call:11'].sort(), 'no pass without kot.manage or kds.view');
  assert.deepEqual(ringsAt(person(12, { permissions: ['orders.create', 'orders.view', 'kds.view'] })).length, 4, 'kds.view reads the pass too');
  assert.deepEqual(ringsAt(person(12), context(['captain_app', 'qr_ordering'])), ['call:1', 'call:11'].sort(), 'no pass with the kitchen display off');
  // Working in outlet 5: its own A1 and the tables of no outlet; its pass is its own tickets only.
  assert.deepEqual(serverRings(person(12, { outletId: '5' }), { requests: [call(1, 1, 'water'), call(7, 11)], tickets: [ticket(51, 101), {
    ...ticket(61, 111) }] }), ['call:1', 'call:11', 'ready:11'].sort());
});

test('news only: nothing from before the phone\'s alerts, or older than a quarter of an hour; each dish counts', () => {
  const moment = moments.requestMoment(call(1, 1, 'water', { created_at: ago(5) }));
  assert.deepEqual(moments.freshKeys(moment, { since: ago(10), now: NOW }), ['call:1']);
  assert.deepEqual(moments.freshKeys(moment, { since: ago(2), now: NOW }), [], 'alerts switched on after the call');
  assert.deepEqual(moments.freshKeys(moments.requestMoment(call(1, 1, 'water', { created_at: ago(20) })), { since: ago(60), now: NOW }), []);
  assert.equal(moments.requestMoment(call(1, 1, 'water', { status: 'done' })), null, 'a call answered');
  assert.equal(moments.requestMoment(call(1, 1, 'order', { status: 'accepted' })), null, 'an order accepted');
  assert.equal(moments.requestMoment({ ...call(1, 1), table_id: null }), null, 'an online order has no table');

  // A ticket cooking with one dish done, then a second: each dish is a key of its own.
  const cooking = ticket(70, 101, { status: 'cooking', readyAt: null, passSince: ago(6), items: [
    { id: 701, liveQuantity: 1, isDone: true, doneAt: ago(6), servedAt: null },
    { id: 702, liveQuantity: 2, isDone: true, doneAt: ago(1), servedAt: null },
    { id: 703, liveQuantity: 1, isDone: false, doneAt: null, servedAt: null },
    { id: 704, liveQuantity: 1, isDone: true, doneAt: ago(1), servedAt: ago(0.5) },
  ] });
  const food = moments.foodMoment(cooking, place(1));
  assert.deepEqual(food.keys.map((entry) => entry.key), ['ready:70', 'ready:70.701', 'ready:70.702']);
  assert.deepEqual(moments.freshKeys(food, { since: ago(3), now: NOW }), ['ready:70.702'], 'only the dish that came up since');
  assert.equal(food.dishes, 3, 'the dishes waiting: one and two, not the one cooking nor the one served');
});

test('off shift by the time clock, and the words on the phone', () => {
  assert.equal(moments.offShift({ lastPunch: null }, NOW), false, 'no time clock: never off shift');
  assert.equal(moments.offShift({ lastPunch: { type: 'clock_out', at: ago(30) } }, NOW), true);
  assert.equal(moments.offShift({ lastPunch: { type: 'clock_in', at: ago(60), clockInAt: ago(60) } }, NOW), false);
  assert.equal(moments.offShift({ lastPunch: { type: 'break_end', at: ago(60), clockInAt: ago(17 * 60) } }, NOW), true, 'a forgotten clock-in');
  assert.equal(serverRings(person(12, { lastPunch: { type: 'clock_out', at: ago(5) } }), { requests: [call(1, 1)] }).length, 0);

  const water = moments.message(moments.requestMoment(call(1, 1, 'water')));
  assert.deepEqual(water.payload, { title: 'Table T1 asked for water', body: 'Asked for water from the table\'s QR code', url: '/captain/calls',
    tag: 'table-1', kind: 'call', table: 'T1', orderId: null });
  assert.equal(water.topic, 't1call');
  assert.equal(water.ttl, 120);
  assert.equal(water.urgency, 'high');
  assert.equal(moments.message(moments.requestMoment(call(2, 3, 'call_waiter'))).payload.title, 'Table T3 is calling');
  assert.equal(moments.message(moments.requestMoment(call(3, 4, 'bill', { created_by: 9 }))).payload.body, 'Asked from the captain app');
  const order = moments.message(moments.requestMoment(call(4, 2, 'order', { item_count: 3, guest_name: 'Asha', notes: 'No onion' })));
  assert.equal(order.payload.title, 'Table T2 sent an order');
  assert.ok(!JSON.stringify(order).includes('Asha') && !JSON.stringify(order).includes('onion'), 'never a guest\'s name or note');
  const food = moments.message(moments.foodMoment(ticket(51, 101), { ...place(1), outletName: 'Main hall' }));
  assert.equal(food.payload.title, 'Table T1: 2 dishes ready');
  assert.equal(food.payload.body, 'At the pass, to carry out · Main hall');
  assert.equal(food.payload.url, '/captain/ready');
  assert.equal(food.topic, 't1food');
  assert.equal(food.ttl, 300);
  assert.ok(Buffer.byteLength(JSON.stringify(food.payload)) < 1024, 'well under a kilobyte');
  assert.match(moments.message(moments.requestMoment(call(9, 1, 'water', { table_id: 123456789012 }))).topic, /^[A-Za-z0-9_-]{1,32}$/);
});
