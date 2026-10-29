import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrivalText,
  arrivals,
  countsOf,
  marksOf,
  orderLink,
  passSince,
  passTone,
  sectionOf,
  shownTables,
  waitingAt,
  waitingDishes,
  waitingList,
} from "../src/workspaces/captain/captainFloor.js";
import { addLine, buildItems, noteLine } from "../src/modules/restaurant/orders/services/orderCart.js";

// The captain app's floor (workspaces/captain/captainFloor.js): whose tables
// these are, what is waiting at each, what each tile says and what rings the
// phone; and a note typed on a dish just added (orderCart.js noteLine).

const NOW = Date.parse("2026-10-27T20:00:00+05:30");
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

// Ramesh (user 7) has T1 and T2 today; T3 is Priya's (user 9); T4 nobody's.
const T1 = { id: 1, tableNo: "T1", capacity: 4, captain: { userId: 7, userName: "Ramesh" },
  live: { orderId: 101, orderNumber: "ORD-0101", guestCount: 2, placedAt: ago(35), orderTotal: 580 } };
const T2 = { id: 2, tableNo: "T2", capacity: 4, captain: { userId: 7, userName: "Ramesh" }, live: null };
const T3 = { id: "3", tableNo: "T3", capacity: 6, captain: { userId: 9, userName: "Priya" },
  live: { orderId: 103, orderNumber: "ORD-0103", guestCount: 5, placedAt: ago(10), orderTotal: 1200 } };
// T4 is pushed against T3: the same party, T3's order.
const T4 = { id: 4, tableNo: "T4", capacity: 2, captain: null,
  live: { orderId: 103, orderNumber: "ORD-0103", guestCount: 5, placedAt: ago(10), orderTotal: 1200, joinedTo: "T3" } };
const TABLES = [T1, T2, T3, T4];

const call = (id, tableId, type, status = "pending", minutes = 2) => ({ id, tableId, type, status, createdAt: ago(minutes) });
const ticket = (id, orderId, readyMinutes, dishes = [["Paneer tikka", 1]]) => ({
  id, orderId, tableNo: null, readyAt: ago(readyMinutes), status: "ready",
  items: dishes.map(([name, liveQuantity], index) => ({ id: id * 10 + index, name, liveQuantity })),
});

const FLOOR = {
  orders: [{ id: 101, kitchenStatus: "preparing" }, { id: 103, kitchenStatus: "pending" }],
  requests: [
    call(11, 1, "water"),
    call(12, 1, "bill", "acknowledged", 5),
    call(13, "3", "call_waiter", "done"),
    { id: 14, tableId: 3, type: "order", status: "pending", createdAt: ago(1) },
    { id: 15, tableId: null, type: "order", status: "pending", channel: "website", createdAt: ago(1) },
  ],
  tickets: [ticket(21, 101, 3, [["Paneer tikka", 2], ["Butter naan", 1]]), ticket(22, 103, 9)],
};

test("a captain's own tables come from the day's captain sections; without one, every table", () => {
  const mine = sectionOf(TABLES, 7);
  assert.deepEqual(mine.map((table) => table.tableNo), ["T1", "T2"]);
  assert.deepEqual(sectionOf(TABLES, "9").map((table) => table.tableNo), ["T3"], "ids compared as the API sends them");
  assert.deepEqual(sectionOf(TABLES, 42), []);
  assert.deepEqual(sectionOf(TABLES, null), []);
  assert.deepEqual(shownTables(TABLES, mine, true).map((table) => table.tableNo), ["T1", "T2"]);
  assert.deepEqual(shownTables(TABLES, mine, false).length, 4, "All tables");
  assert.deepEqual(shownTables(TABLES, [], true).length, 4, "no section today: every table");
});

test("what is waiting at each table: open calls and QR orders, food at the pass, the kitchen; a joined table's food once", () => {
  const waiting = waitingAt(TABLES, FLOOR);
  const t1 = waiting.get("1");
  assert.deepEqual(t1.calls.map((request) => request.id), [11, 12]);
  assert.deepEqual(t1.ready.map((entry) => entry.id), [21]);
  assert.equal(t1.kitchen, "preparing");
  assert.equal(t1.orderId, 101);
  const t3 = waiting.get("3");
  assert.deepEqual(t3.calls, [], "a call that is done waits no more");
  assert.deepEqual(t3.orders.map((request) => request.id), [14]);
  assert.deepEqual(t3.ready.map((entry) => entry.id), [22]);
  assert.equal(t3.kitchen, "pending");
  const t4 = waiting.get("4");
  assert.deepEqual(t4.ready, [], "the joined table's food is shown at the party's own table");
  assert.equal(t4.kitchen, null);
  assert.equal(waiting.get("2").orderId, null);
  assert.deepEqual(countsOf(TABLES, waiting), { calls: 3, ready: 2 }, "the online order has no table");
  assert.deepEqual(countsOf([T1, T2], waiting), { calls: 2, ready: 1 });
});

test("each tile says, most urgent first: a call, the bill, a QR order, the food, the kitchen, the guests", () => {
  const waiting = waitingAt(TABLES, FLOOR);
  const words = (table, now = NOW) => marksOf(table, waiting.get(String(table.id)), { now, passMinutes: 8 }).map((mark) => `${mark.label}/${mark.tone}`);
  assert.deepEqual(words(T1), ["Asked for water/danger", "Wants the bill/warning", "Food ready · 3 dishes/success", "2 guests/neutral"]);
  assert.deepEqual(words(T3), ["QR order waiting/warning", "Food ready · 1 dish/danger", "5 guests/neutral"], "food 9 minutes at the pass is late");
  assert.deepEqual(words(T4), ["With T3/neutral"]);
  assert.deepEqual(words(T2), []);
  // Nothing at the pass: the kitchen's progress instead.
  const cooking = waitingAt([T1], { orders: FLOOR.orders });
  assert.deepEqual(marksOf(T1, cooking.get("1")).map((mark) => mark.label), ["Cooking", "2 guests"]);
  const sent = waitingAt([T1], { orders: [{ id: 101, kitchenStatus: "pending" }] });
  assert.deepEqual(marksOf(T1, sent.get("1")).map((mark) => mark.label), ["Order sent", "2 guests"]);
  const ready = waitingAt([T1], { orders: [{ id: 101, kitchenStatus: "ready" }] });
  assert.deepEqual(marksOf(T1, ready.get("1")).map((mark) => mark.label), ["Food ready", "2 guests"], "the pass not readable: the order's own state");
  const two = waitingAt([T1], { requests: [call(1, 1, "water"), call(2, 1, "call_waiter")] });
  assert.deepEqual(marksOf(T1, two.get("1")).map((mark) => mark.label), ["2 calls", "2 guests"]);
  assert.equal(passTone(FLOOR.tickets[0], NOW, 8), "calm");
  assert.equal(passTone(ticket(1, 1, 5), NOW, 8), "warning");
  assert.equal(passTone(ticket(1, 1, 8), NOW, 8), "late");
});

test("the Calls and Ready lists: the tables shown, the longest waiting first", () => {
  const waiting = waitingAt(TABLES, FLOOR);
  assert.deepEqual(waitingList(TABLES, waiting, "calls").map(({ entry }) => entry.id), [12, 11]);
  assert.deepEqual(waitingList(TABLES, waiting, "ready").map(({ entry, table }) => [entry.id, table.tableNo]), [[22, "T3"], [21, "T1"]]);
  assert.deepEqual(waitingList([T1, T2], waiting, "ready").map(({ entry }) => entry.id), [21]);
  assert.equal(orderLink(101), "/captain/order?order=101");
});

test("only what is new at the tables shown rings, never what was there when the screen opened", () => {
  const before = waitingAt(TABLES, FLOOR);
  const first = arrivals(null, [T1, T2], before);
  assert.deepEqual(first.fresh, [], "the first look rings nothing");
  assert.deepEqual([...first.keys].sort(), ["calls:11", "calls:12", "ready:21", "ready:21.210", "ready:21.211"]);
  const later = waitingAt(TABLES, { ...FLOOR, requests: [...FLOOR.requests, call(16, 2, "water")], tickets: [...FLOOR.tickets, ticket(23, 101, 0)] });
  const next = arrivals(first.keys, [T1, T2], later);
  assert.deepEqual(next.fresh.map(arrivalText), ["Table T2: asked for water", "Food ready for table T1"]);
  // Priya's table is not shown: nothing of hers rings for Ramesh.
  const hers = waitingAt(TABLES, { ...FLOOR, requests: [...FLOOR.requests, call(17, 3, "water")] });
  assert.deepEqual(arrivals(first.keys, [T1, T2], hers).fresh, []);
  assert.equal(arrivalText({ kind: "orders", table: T3, entry: FLOOR.requests[3] }), "Table T3 sent an order from its QR code");
});

test("a dish the kitchen ticked done waits at the pass on its own; a bill a captain asked for does not ring their own phone", () => {
  // T2's ticket still cooking: the dal is done, the naan is not.
  const T2running = { ...T2, live: { orderId: 102, orderNumber: "ORD-0102", guestCount: 2, placedAt: ago(20), orderTotal: 400 } };
  const cooking = {
    id: 31, orderId: 102, status: "cooking", readyAt: null, passSince: ago(2),
    items: [
      { id: 310, name: "Dal makhani", liveQuantity: 1, isDone: true, servedAt: null },
      { id: 311, name: "Butter naan", liveQuantity: 2, isDone: false, servedAt: null },
    ],
  };
  const waiting = waitingAt([T1, T2running], { tickets: [cooking] });
  assert.deepEqual(waitingDishes(cooking).map((item) => item.name), ["Dal makhani"]);
  assert.equal(passSince(cooking), cooking.passSince);
  assert.deepEqual(marksOf(T2running, waiting.get("2"), { now: NOW }).map((mark) => mark.label), ["Food ready · 1 dish", "2 guests"]);
  assert.equal(passTone(cooking, NOW, 8), "calm");
  const first = arrivals(null, [T2running], waiting);
  assert.deepEqual([...first.keys].sort(), ["ready:31", "ready:31.310"]);
  // The dal carried out: nothing rings. The naan up: it rings again.
  const served = { ...cooking, items: [{ ...cooking.items[0], servedAt: ago(1) }, cooking.items[1]] };
  assert.deepEqual(arrivals(first.keys, [T2running], waitingAt([T2running], { tickets: [served] })).fresh, []);
  const naanUp = { ...served, status: "ready", readyAt: ago(0), items: [served.items[0], { ...cooking.items[1], isDone: true }] };
  assert.deepEqual(waitingDishes(naanUp).map((item) => item.name), ["Butter naan"]);
  assert.deepEqual(arrivals(first.keys, [T2running], waitingAt([T2running], { tickets: [naanUp] })).fresh.map(arrivalText), ["Food ready for table T2"]);

  // The bill asked for by Ramesh (user 7) himself rings his phone no more;
  // another captain's phone rings for it.
  const asked = { ...call(41, 1, "bill"), askedBy: 7, askedByName: "Ramesh" };
  const quiet = waitingAt([T1], {});
  const now = waitingAt([T1], { requests: [asked] });
  const seen = arrivals(null, [T1], quiet).keys;
  assert.deepEqual(arrivals(seen, [T1], now, { userId: 7 }).fresh, []);
  assert.deepEqual(arrivals(seen, [T1], now, { userId: 9 }).fresh.map(arrivalText), ["Table T1: wants the bill"]);
});

test("a note typed on a dish just added goes to the kitchen with it; a dish already sent keeps its own", () => {
  const dish = { productId: 5, productVariantId: null, modifiers: [], notes: "", quantity: 1, courseNo: 1, holdCourse: false, name: "Dal makhani" };
  let cart = addLine([], dish);
  cart = addLine(cart, { ...dish, notes: "Less spicy" });
  assert.equal(cart.length, 2);
  const plain = cart.find((line) => !line.notes);
  // Noted the same way as the other: the two become one line of two.
  cart = noteLine(cart, plain.key, "  Less spicy ");
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 2);
  assert.equal(cart[0].notes, "Less spicy");
  cart = noteLine(cart, cart[0].key, "No onion");
  assert.deepEqual(buildItems(cart).map((item) => [item.notes, item.quantity]), [["No onion", 2]]);
  const saved = [{ key: "saved-1", id: 1, saved: true, notes: "", quantity: 1, savedQuantity: 1 }];
  assert.equal(noteLine(saved, "saved-1", "Extra hot"), saved, "the kitchen cooks from the note it was sent");
  assert.equal(noteLine(cart, "nothing", "x"), cart);
  assert.equal(noteLine(cart, cart[0].key, "x".repeat(250))[0].notes.length, 200);
  // A held course stays its own line: the same dish sent now is another.
  const held = addLine([], { ...dish, courseNo: 2, holdCourse: true });
  const both = addLine(held, dish);
  assert.equal(both.length, 2);
  assert.deepEqual(buildItems(both).map((item) => [item.courseNo, item.holdCourse]), [[2, true], [1, false]]);
});
