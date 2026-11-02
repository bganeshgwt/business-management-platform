import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, createOutbox, outcomeOf, rewriteFrom } from "../src/services/offline/outbox.js";

// The outbox (services/offline/outbox.js), on a storage, a clock and a
// pretend server of the test's own: order within a queue, an item waiting for
// another and taking its answer, what each answer means, the pause between
// tries, discarding, and a device shared by two people.

const memory = (rows = []) => {
  const kept = new Map(rows.map((row) => [row.id, structuredClone(row)]));
  return {
    kept,
    all: async () => [...kept.values()].map((row) => structuredClone(row)),
    put: async (row) => {
      kept.set(row.id, structuredClone(row));
      return true;
    },
    delete: async (id) => kept.delete(id),
  };
};

// A server that answers each request as the test says, by url.
const server = (answers = {}) => {
  const sent = [];
  const send = async (item) => {
    sent.push({ method: item.method, url: item.url, body: item.body, key: item.requestKey });
    const answer = typeof answers[item.url] === "function" ? answers[item.url](item, sent) : answers[item.url];
    return answer || { status: 201, data: { data: { id: sent.length } } };
  };
  return { sent, send, answers };
};

const timersOf = () => {
  const waiting = [];
  return {
    waiting,
    setTimeout: (run, ms) => {
      const id = waiting.length + 1;
      waiting.push({ id, run, ms });
      return id;
    },
    clearTimeout: () => undefined,
  };
};

const ramesh = { id: 7, name: "Ramesh" };
const make = ({ storage = memory(), answers = {}, person = ramesh, clock = { at: 1_000_000 }, ids } = {}) => {
  const api = server(answers);
  let n = 0;
  const outbox = createOutbox({
    storage,
    send: api.send,
    now: () => clock.at,
    timers: timersOf(),
    random: () => 0.5,
    person: () => person,
    newId: () => (ids ? ids.shift() : `item-${(n += 1)}`),
  });
  return { outbox, api, storage, clock };
};
const entry = (label, extra = {}) => ({ queue: "orders", kind: "sales_order", label, method: "POST", url: `/orders/${label}`, body: { label }, requestKey: `key-${label}`, ...extra });

test("what each answer means", () => {
  assert.deepEqual(outcomeOf({ status: 201 }), { kind: "done" });
  assert.deepEqual(outcomeOf({ status: 200, data: { replayed: true } }), { kind: "done" }, "a repeat of the same request key answers with the first result");
  assert.equal(outcomeOf({ networkError: true }).kind, "retry");
  assert.equal(outcomeOf({}).kind, "retry");
  assert.equal(outcomeOf({ status: 401 }).kind, "signin");
  for (const status of [408, 429, 500, 502, 503]) assert.equal(outcomeOf({ status }).kind, "retry", String(status));
  for (const status of [400, 402, 403, 404, 409, 422]) assert.equal(outcomeOf({ status }).kind, "attention", String(status));
  assert.deepEqual(outcomeOf({ status: 402, data: { message: "This business's plan has ended.", data: { reason: "plan_ended" } } }),
    { kind: "attention", status: 402, reason: "plan_ended", message: "This business's plan has ended." });
  assert.equal(outcomeOf({ status: 409 }).message, "The server refused it.");
});

test("the pause between tries: 1, 2, 4 … seconds, at most a minute, give or take a fifth", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 12].map((n) => backoffDelay(n, () => 0.5)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(backoffDelay(1, () => 0), 800);
  assert.equal(backoffDelay(1, () => 1), 1200);
  assert.equal(backoffDelay(9, () => 1), 60000, "never more than a minute");
});

test("an answer carried into what waited for it: the body and the address", () => {
  const order = { body: { lines: [1], contactId: null }, url: "/businesses/4/contacts/:contactId/visits",
    resultRef: [{ from: "data.id", into: "contactId" }, { from: "data.id", into: ":contactId" }] };
  assert.deepEqual(rewriteFrom(order, { data: { id: 991 } }), { body: { lines: [1], contactId: 991 }, url: "/businesses/4/contacts/991/visits" });
  assert.deepEqual(rewriteFrom({ body: { a: 1 }, url: "/x", resultRef: { from: "data.nothing", into: "b" } }, { data: {} }), { body: { a: 1 }, url: "/x" });
  assert.deepEqual(rewriteFrom({ body: null, url: "/x" }, null), { body: null, url: "/x" });
});

test("items of one queue go in order; each is sent with its request key, and goes once done", async () => {
  const { outbox, api, storage } = make();
  const first = await outbox.add(entry("first"));
  await outbox.add(entry("second"));
  await outbox.add(entry("other", { queue: "collections" }));
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => s.url), ["/orders/first", "/orders/second", "/orders/other"]);
  assert.deepEqual(api.sent.map((s) => s.key), ["key-first", "key-second", "key-other"]);
  assert.equal(first.userId, 7);
  assert.deepEqual(outbox.snapshot().counts, { waiting: 0, sending: 0, attention: 0, total: 0 });
  assert.equal(storage.kept.size, 0, "done and needed by nothing: let go");
  await assert.rejects(outbox.add({ queue: "q", kind: "k", method: "POST", url: "/x" }), /needs label/);
});

test("no connection: tried again after a pause, the queue keeps its order, nothing is lost", async () => {
  let down = true;
  const { outbox, api, clock } = make({ answers: { "/orders/first": () => (down ? { networkError: true } : { status: 201, data: {} }) } });
  await outbox.add(entry("first"));
  await outbox.add(entry("second"));
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => s.url), ["/orders/first"], "the second waits behind the first");
  let [head, next] = outbox.snapshot().items;
  assert.equal(head.state, "waiting");
  assert.equal(head.attempts, 1);
  assert.equal(head.nextAt, clock.at + 1000);
  assert.match(head.lastError, /no connection/);
  assert.equal(next.state, "waiting");
  assert.deepEqual(outbox.snapshot().counts, { waiting: 2, sending: 0, attention: 0, total: 2 });

  // Before its pause is over, nothing is sent again.
  await outbox.flush();
  assert.equal(api.sent.length, 1);
  clock.at += 1000;
  await outbox.flush();
  assert.equal(api.sent.length, 2);
  [head] = outbox.snapshot().items;
  assert.equal(head.attempts, 2);
  assert.equal(head.nextAt, clock.at + 2000);

  // Connected again (online, focus, or a nudge): both go, in order.
  down = false;
  clock.at += 2000;
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => s.url), ["/orders/first", "/orders/first", "/orders/first", "/orders/second"]);
  assert.equal(outbox.snapshot().counts.total, 0);
});

test("a refusal needs attention with the server's words, and holds back only what waits for it", async () => {
  const { outbox, api } = make({
    answers: { "/orders/refused": { status: 409, data: { message: "Credit limit reached for Sharma Stores." } } },
  });
  const refused = await outbox.add(entry("refused"));
  await outbox.add(entry("after-it", { after: refused.id }));
  await outbox.add(entry("independent"));
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => s.url), ["/orders/refused", "/orders/independent"]);
  const [first, held] = outbox.snapshot().items;
  assert.equal(first.state, "attention");
  assert.equal(first.lastError, "Credit limit reached for Sharma Stores.");
  assert.equal(first.status, 409);
  assert.equal(held.state, "waiting");
  assert.equal(held.lastError, 'Waits for "refused", which needs attention.');
  assert.deepEqual(outbox.snapshot().counts, { waiting: 1, sending: 0, attention: 1, total: 2 });

  // Sorted out at the office, sent again: what waited for it goes too.
  api.answers["/orders/refused"] = { status: 201, data: { data: { id: 5 } } };
  await outbox.retry(first.id);
  await outbox.flush();
  assert.deepEqual(api.sent.slice(2).map((s) => s.url), ["/orders/refused", "/orders/after-it"]);
  assert.equal(outbox.snapshot().counts.total, 0);
});

test("an item waits for another, and takes its answer: the new shop's id into its first order", async () => {
  const { outbox, api } = make({ answers: { "/contacts": { status: 201, data: { data: { id: 812 } } } } });
  const shop = await outbox.add({ queue: "shops", kind: "contact", label: "New shop: Lakshmi Kirana", method: "POST", url: "/contacts", body: { name: "Lakshmi Kirana" } });
  await outbox.add(entry("first-order", { queue: "orders", after: shop.id, resultRef: { from: "data.id", into: "contactId" }, body: { contactId: null, lines: [2] } }));
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => [s.url, s.body]), [["/contacts", { name: "Lakshmi Kirana" }], ["/orders/first-order", { contactId: 812, lines: [2] }]]);
});

test("an item made in another queue before what it waits for is sent waits until that is done", async () => {
  let shopUp = false;
  const { outbox, api, clock } = make({ answers: { "/contacts": () => (shopUp ? { status: 201, data: { data: { id: 9 } } } : { networkError: true }) } });
  const shop = await outbox.add({ queue: "shops", kind: "contact", label: "New shop", method: "POST", url: "/contacts", body: {} });
  await outbox.add(entry("order", { after: shop.id, resultRef: { from: "data.id", into: "contactId" } }));
  await outbox.add(entry("later"));
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => s.url), ["/contacts"], "the order waits for its shop, and the later order behind it");
  shopUp = true;
  clock.at += 1000;
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => s.url), ["/contacts", "/contacts", "/orders/order", "/orders/later"]);
  assert.equal(api.sent[2].body.contactId, 9);
});

test("a session that ended: everything waits for the sign-in, then goes", async () => {
  let signedIn = false;
  const { outbox, api } = make({ answers: { "/orders/first": () => (signedIn ? { status: 201, data: {} } : { status: 401, data: { message: "Your session has ended." } }) } });
  await outbox.add(entry("first"));
  await outbox.add(entry("second", { queue: "other" }));
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => s.url), ["/orders/first"], "nothing more is tried while signed out");
  assert.equal(outbox.snapshot().paused, "signin");
  assert.equal(outbox.snapshot().items[0].state, "waiting", "not refused: kept");
  assert.equal(outbox.snapshot().items[0].lastError, "Waiting for you to sign in again.");
  await outbox.flush();
  assert.equal(api.sent.length, 1);
  signedIn = true;
  await outbox.resume();
  assert.deepEqual(api.sent.map((s) => s.url), ["/orders/first", "/orders/first", "/orders/second"]);
  assert.equal(outbox.snapshot().paused, null);
});

test("discarding says what is lost; what waited for it then needs attention", async () => {
  const { outbox, api } = make({ answers: { "/contacts": { networkError: true } } });
  const shop = await outbox.add({ queue: "shops", kind: "contact", label: "New shop: Lakshmi Kirana", method: "POST", url: "/contacts", body: {} });
  const order = await outbox.add(entry("order for Lakshmi", { after: shop.id }));
  await outbox.flush();
  const described = outbox.describe(shop.id);
  assert.equal(described.item.label, "New shop: Lakshmi Kirana");
  assert.deepEqual(described.dependents.map((each) => each.label), ["order for Lakshmi"]);
  await outbox.discard(shop.id);
  const [left] = outbox.snapshot().items;
  assert.equal(left.id, order.id);
  assert.equal(left.state, "attention");
  assert.equal(left.lastError, 'It waited for "New shop: Lakshmi Kirana", which was discarded.');
  assert.equal(await outbox.discard("missing"), null);
  assert.equal(api.sent.length, 1);
});

test("kept on the device: a new page picks up what was waiting, a half-sent item goes again", async () => {
  const storage = memory([
    { id: "a", queue: "orders", kind: "k", label: "A", method: "POST", url: "/a", body: {}, requestKey: "ka", createdAt: 1, seq: 1, attempts: 2, state: "sending", userId: 7 },
    { id: "b", queue: "orders", kind: "k", label: "B", method: "POST", url: "/b", body: {}, requestKey: "kb", createdAt: 2, seq: 2, attempts: 0, state: "waiting", userId: 7 },
  ]);
  const { outbox, api } = make({ storage });
  const seen = [];
  outbox.subscribe((state) => seen.push(state.counts.total));
  await outbox.ready();
  assert.deepEqual(outbox.snapshot().items.map((item) => item.state), ["waiting", "waiting"]);
  await outbox.flush();
  assert.deepEqual(api.sent.map((s) => [s.url, s.key]), [["/a", "ka"], ["/b", "kb"]]);
  assert.equal(seen.at(-1), 0);
});

test("a shared device: another person's items wait for them, and signing out clears one's own", async () => {
  const storage = memory();
  const priya = { id: 9, name: "Priya" };
  const asPriya = make({ storage, person: priya, ids: ["p1"], answers: { "/orders/priya": { networkError: true } } });
  await asPriya.outbox.add(entry("priya"));
  await asPriya.outbox.flush();
  const asRamesh = make({ storage, ids: ["r1"] });
  await asRamesh.outbox.add(entry("ramesh"));
  await asRamesh.outbox.flush();
  assert.deepEqual(asRamesh.api.sent.map((s) => s.url), ["/orders/ramesh"], "Priya's waits for Priya");
  assert.deepEqual(asRamesh.outbox.pending().map((item) => [item.label, item.userName]), [["priya", "Priya"]]);
  assert.deepEqual(asRamesh.outbox.pending(7), []);
  await asPriya.outbox.refresh();
  await asPriya.outbox.clearFor(9);
  assert.equal(storage.kept.size, 0);
});

test("nothing is kept to send while nobody is signed in", async () => {
  const { outbox } = make({ person: null });
  await assert.rejects(outbox.add(entry("x")), /nobody is signed in/);
});
