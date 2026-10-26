import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, createLiveClient, createParser, scopeOf } from "../src/services/liveClient.js";

// The staff app's live updates client (services/liveClient.js), run on a
// clock of the test's own against a pretend server: how long it waits before
// reconnecting, how it gathers a burst into one read, that it reads once
// after every (re)connection, and what it does when a stream is refused or
// ends.

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => globalThis.setImmediate(resolve));
};

// setTimeout and clearTimeout on a clock that moves only when told.
function clock() {
  let time = 1_000_000;
  let next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (run, ms) => {
      next += 1;
      timers.set(next, { run, at: time + Math.max(0, ms || 0) });
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
    // Whatever has arrived is handled at the time it arrived, then the clock moves.
    async advance(ms) {
      await flush();
      const until = time + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= until && (!due || timer.at < due.timer.at || (timer.at === due.timer.at && id < due.id))) due = { id, timer };
        }
        if (!due) break;
        timers.delete(due.id);
        time = due.timer.at;
        due.timer.run();
        await flush();
      }
      time = until;
      await flush();
    },
  };
}

// A pretend API: every request waits for the test to answer it, with an open
// stream of events or a refusal.
function server() {
  const calls = [];
  const fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const call = { url, init, resolve, aborted: false };
      init.signal.addEventListener("abort", () => {
        call.aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        call.onAbort?.();
      });
      calls.push(call);
    });
  const encoder = new TextEncoder();
  const open = (call) => {
    let controller;
    const body = new ReadableStream({ start: (c) => { controller = c; } });
    call.onAbort = () => { try { controller.error(new Error("aborted")); } catch { /* already closed */ } };
    call.resolve({ ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream; charset=utf-8" }), body });
    return {
      send: (text) => controller.enqueue(encoder.encode(text)),
      event: (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
      end: () => controller.close(),
    };
  };
  const refuse = (call, status) => call.resolve({ ok: false, status, headers: new Headers({ "content-type": "application/json" }), body: null });
  return { fetch, calls, open, refuse, last: () => calls[calls.length - 1] };
}

function setUp({ token = "token-1", random = () => 0.5 } = {}) {
  const time = clock();
  const api = server();
  const session = { token };
  const client = createLiveClient({
    fetch: api.fetch,
    baseUrl: "https://shop.example/api",
    getToken: () => session.token,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    now: time.now,
    random,
  });
  return { time, api, session, client };
}

// A subscriber that records every call, and the stream's status.
function recorder() {
  const calls = [];
  const statuses = [];
  return {
    calls,
    statuses,
    onChange: (batch) => { calls.push(batch); },
    onStatus: (status) => statuses.push(status),
  };
}

test("reconnecting waits 1, 2, 4, 8, 16 and then 30 seconds, each give or take a quarter", () => {
  const middle = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => backoffDelay(attempt, middle)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(backoffDelay(1, () => 0), 750);
  assert.equal(backoffDelay(1, () => 1), 1250);
  assert.equal(backoffDelay(6, () => 0), 22500);
  assert.equal(backoffDelay(6, () => 1), 37500);
});

test("the stream is read as it arrives: split anywhere, with any line ends, comments and several data lines", () => {
  const messages = [];
  const parse = createParser((message) => messages.push(message));
  for (const piece of ["eve", "nt: ready\nda", 'ta: {"scope":"restaurant"}\n', "\n"]) parse(piece);
  parse('id: 7\r\nevent: change\r\ndata: {"area":"order","id":5}\r');
  parse("\n\r\n");
  parse(": keep-alive\n\n");
  parse("data: one\ndata: two\n\n");
  parse("event: nothing-to-say\n\n");
  assert.deepEqual(messages, [
    { event: "ready", data: '{"scope":"restaurant"}', id: null },
    { event: "change", data: '{"area":"order","id":5}', id: "7" },
    { event: "comment", data: "", id: null },
    { event: "message", data: "one\ntwo", id: null },
  ]);
});

test("a restaurant's and a business's streams: the token in the header, never in the address", async () => {
  assert.deepEqual(scopeOf({ restaurant: true, user: 4, outlet: "2" }), { key: "restaurant|4|2", path: "/live", outlet: "2" });
  assert.deepEqual(scopeOf({ business: 9, user: 4 }), { key: "business|9|4", path: "/businesses/9/live", outlet: null });
  assert.equal(scopeOf({ restaurant: true }), null);
  const { api, client } = setUp();
  const one = recorder();
  client.subscribe({ restaurant: true, user: 4, outlet: "2" }, ["order"], one.onChange);
  client.subscribe({ business: 9, user: 4 }, ["token"], one.onChange);
  await flush();
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[0].url, "https://shop.example/api/live");
  assert.deepEqual(api.calls[0].init.headers, { Accept: "text/event-stream", Authorization: "Bearer token-1", "X-Outlet-Id": "2" });
  assert.equal(api.calls[1].url, "https://shop.example/api/businesses/9/live");
  assert.deepEqual(api.calls[1].init.headers, { Accept: "text/event-stream", Authorization: "Bearer token-1" });
  assert.ok(api.calls.every((call) => !call.url.includes("token")));
  client.closeAll();
});

test("a burst is gathered into one read, at most one a second, never two at once", async () => {
  const { time, api, client } = setUp();
  const one = recorder();
  let release;
  let slow = false;
  const onChange = (batch) => {
    one.calls.push(batch);
    if (slow) return new Promise((resolve) => { release = resolve; });
    return undefined;
  };
  client.subscribe({ restaurant: true, user: 1 }, ["order", "kot"], onChange, { onStatus: one.onStatus });
  await flush();
  const stream = api.open(api.last());
  stream.event("ready", { scope: "restaurant" });
  await flush();
  assert.deepEqual(one.statuses, ["connecting", "live"]);
  // Connected: one read, for whatever changed before it was listening.
  await time.advance(250);
  assert.deepEqual(one.calls, [{ reasons: ["reconnect"], changes: [] }]);

  // Ten changes in 90 ms, and one of an area this screen does not show.
  await time.advance(5000);
  for (let n = 1; n <= 10; n += 1) {
    stream.event("change", { area: n % 2 ? "order" : "kot", id: n });
    await time.advance(10);
  }
  stream.event("change", { area: "reservation", id: 99 });
  await time.advance(250);
  assert.equal(one.calls.length, 2);
  assert.deepEqual(one.calls[1].reasons, ["change"]);
  assert.deepEqual(one.calls[1].changes.map((change) => change.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // Another change at once waits for the second to be up.
  stream.event("change", { area: "order", id: 11 });
  await time.advance(300);
  assert.equal(one.calls.length, 2);
  await time.advance(700);
  assert.equal(one.calls.length, 3);

  // While a read is still going, changes wait for it, then go in one more read.
  slow = true;
  await time.advance(5000);
  stream.event("change", { area: "order", id: 12 });
  await time.advance(250);
  assert.equal(one.calls.length, 4);
  stream.event("change", { area: "kot", id: 13 });
  stream.event("change", { area: "kot", id: 14 });
  await time.advance(5000);
  assert.equal(one.calls.length, 4);
  slow = false;
  release();
  await time.advance(1000);
  assert.equal(one.calls.length, 5);
  assert.deepEqual(one.calls[4].changes.map((change) => change.id), [13, 14]);
  client.closeAll();
});

test("a dropped stream reconnects after 1, 2 and 4 seconds, reads once when back, and starts again from 1 second once steady", async () => {
  const { time, api, client } = setUp();
  const one = recorder();
  client.subscribe({ restaurant: true, user: 1 }, ["order"], one.onChange, { onStatus: one.onStatus });
  await flush();
  const first = api.open(api.last());
  first.event("ready", {});
  await time.advance(300);
  assert.equal(one.calls.length, 1);

  first.end();
  await flush();
  assert.equal(one.statuses.at(-1), "reconnecting");
  await time.advance(999);
  assert.equal(api.calls.length, 1);
  await time.advance(1);
  assert.equal(api.calls.length, 2);
  api.refuse(api.last(), 502);
  await time.advance(1999);
  assert.equal(api.calls.length, 2);
  await time.advance(1);
  assert.equal(api.calls.length, 3);
  api.refuse(api.last(), 503);
  await time.advance(4000);
  assert.equal(api.calls.length, 4);
  const back = api.open(api.last());
  back.event("ready", {});
  await time.advance(300);
  assert.equal(one.statuses.at(-1), "live");
  // Back: exactly one read, for what was missed meanwhile.
  assert.equal(one.calls.length, 2);
  assert.deepEqual(one.calls[1].reasons, ["reconnect"]);

  // Up for 30 seconds: the next drop waits 1 second again.
  await time.advance(30000);
  back.end();
  await time.advance(1000);
  assert.equal(api.calls.length, 5);
  client.closeAll();
});

test("the server's resync, and a stream silent for 70 seconds, each lead to one read", async () => {
  const { time, api, client } = setUp();
  const one = recorder();
  client.subscribe({ business: 3, user: 1 }, ["token"], one.onChange);
  await flush();
  const stream = api.open(api.last());
  stream.event("ready", {});
  await time.advance(300);
  // A second read waits for a second to pass since the first.
  stream.event("resync", {});
  await time.advance(1000);
  assert.deepEqual(one.calls.map((call) => call.reasons), [["reconnect"], ["reconnect"]]);
  // Keep-alives keep it open.
  for (let n = 0; n < 4; n += 1) {
    await time.advance(25000);
    stream.send(": keep-alive\n\n");
  }
  await flush();
  assert.equal(api.calls.length, 1);
  // Then nothing for 70 seconds: it is dropped and opened again.
  await time.advance(70000);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].aborted, true);
  await time.advance(1000);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].aborted, false);
  client.closeAll();
});

test("a refused or ended session stops, after one last read that meets the refusal", async () => {
  const { time, api, session, client } = setUp();
  const one = recorder();
  client.subscribe({ restaurant: true, user: 1 }, ["order"], one.onChange, { onStatus: one.onStatus });
  await flush();
  api.refuse(api.last(), 401);
  await time.advance(300);
  assert.equal(one.statuses.at(-1), "off");
  assert.deepEqual(one.calls, [{ reasons: ["session"], changes: [] }]);
  await time.advance(600000);
  assert.equal(api.calls.length, 1);
  client.closeAll();

  // Not a member any more: off, without trying again.
  const two = recorder();
  client.subscribe({ business: 5, user: 1 }, ["*"], two.onChange, { onStatus: two.onStatus });
  await flush();
  api.refuse(api.last(), 404);
  await time.advance(600000);
  assert.equal(two.statuses.at(-1), "off");
  assert.equal(api.calls.filter((call) => call.url.endsWith("/businesses/5/live")).length, 1);
  client.closeAll();

  // The server ends the session: with the same token, off; with a token
  // refreshed meanwhile, at once again.
  const three = recorder();
  client.subscribe({ restaurant: true, user: 2 }, ["order"], three.onChange, { onStatus: three.onStatus });
  await flush();
  let stream = api.open(api.last());
  stream.event("ready", {});
  await time.advance(300);
  session.token = "token-2";
  stream.event("end", { reason: "session_ended" });
  await flush();
  const before = api.calls.length;
  await time.advance(0);
  assert.equal(api.calls.length, before + 1);
  assert.equal(api.last().init.headers.Authorization, "Bearer token-2");
  stream = api.open(api.last());
  stream.event("ready", {});
  await time.advance(300);
  stream.event("end", { reason: "session_ended" });
  await time.advance(1000);
  assert.equal(three.statuses.at(-1), "off");
  assert.ok(three.calls.at(-1).reasons.includes("session"), JSON.stringify(three.calls));
  await time.advance(600000);
  assert.equal(api.calls.length, before + 1);
  client.closeAll();
});

test("a stream ended for a change opens again at once, one ended for a restart after a moment, one refused for too many after a minute", async () => {
  const { time, api, client } = setUp();
  const one = recorder();
  client.subscribe({ business: 7, user: 1 }, ["sale"], one.onChange, { onStatus: one.onStatus });
  await flush();
  let stream = api.open(api.last());
  stream.event("ready", {});
  await time.advance(300);
  stream.event("end", { reason: "changed" });
  await time.advance(0);
  assert.equal(api.calls.length, 2);
  stream = api.open(api.last());
  stream.event("ready", {});
  await time.advance(300);
  stream.event("end", { reason: "restarting" });
  await time.advance(499);
  assert.equal(api.calls.length, 2);
  await time.advance(3000);
  assert.equal(api.calls.length, 3);
  api.refuse(api.last(), 429);
  await time.advance(59000);
  assert.equal(api.calls.length, 3);
  await time.advance(1000);
  assert.equal(api.calls.length, 4);
  client.closeAll();
});

test("screens share one stream, which closes a moment after the last leaves, and signing out closes every one", async () => {
  const { time, api, client } = setUp();
  const bell = recorder();
  const page = recorder();
  const stopBell = client.subscribe({ restaurant: true, user: 1 }, ["*"], bell.onChange);
  const stopPage = client.subscribe({ restaurant: true, user: 1 }, ["kot"], page.onChange);
  await flush();
  assert.equal(api.calls.length, 1);
  const stream = api.open(api.last());
  stream.event("ready", {});
  await time.advance(300);
  stream.event("change", { area: "bill", id: 3 });
  await time.advance(1000);
  assert.deepEqual(bell.calls.at(-1).changes, [{ area: "bill", id: 3 }]);
  assert.deepEqual(page.calls.map((call) => call.reasons), [["reconnect"]]);
  // Moving from one live screen to another keeps the stream.
  stopPage();
  const stopNext = client.subscribe({ restaurant: true, user: 1 }, ["order"], page.onChange);
  await time.advance(5000);
  assert.equal(api.calls.length, 1);
  stopBell();
  stopNext();
  await time.advance(1999);
  assert.equal(api.calls[0].aborted, false);
  await time.advance(1);
  assert.equal(api.calls[0].aborted, true);
  assert.equal(client.connectionCount(), 0);
  // Another person on the same till has a stream of their own; signing out ends them all.
  client.subscribe({ restaurant: true, user: 1 }, ["order"], page.onChange);
  client.subscribe({ restaurant: true, user: 2 }, ["order"], page.onChange);
  await flush();
  assert.equal(client.connectionCount(), 2);
  client.closeAll();
  await time.advance(600000);
  assert.ok(api.calls.slice(1).every((call) => call.aborted));
  assert.equal(api.calls.length, 3);
});
