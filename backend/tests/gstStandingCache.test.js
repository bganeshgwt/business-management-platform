const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const cache = require("../src/modules/gst-thresholds/services/standingCache");
const { keptAnswersOn } = require("../src/utils/keptAnswers");

// The standing behind an owner's GST thresholds, kept for five minutes per
// business for everyone who asks: shared while it is read, read again five
// minutes on, thrown away at once when a PAN or a warning level changes, never
// kept when the reading fails, and kept only where the bell keeps its answers
// (NOTIFICATIONS_CACHE, NODE_ENV=test). Pure: the reading and the clock are
// passed in.

const saved = { cache: process.env.NOTIFICATIONS_CACHE, env: process.env.NODE_ENV };
afterEach(() => {
  for (const [name, value] of [["NOTIFICATIONS_CACHE", saved.cache], ["NODE_ENV", saved.env]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cache.clear();
});

// A reading that counts how often it ran, and a clock that only moves when told.
function setUp() {
  process.env.NOTIFICATIONS_CACHE = "on";
  cache.clear();
  const state = { reads: 0, now: 1_000_000 };
  state.read = async () => ({ n: ++state.reads });
  state.clock = () => state.now;
  return state;
}

test("one reading serves everyone for five minutes, and two asking at once share it", async () => {
  const s = setUp();
  const [first, second] = await Promise.all([cache.remember("7", s.read, s.clock), cache.remember("7", s.read, s.clock)]);
  assert.equal(s.reads, 1, "one reading for both");
  assert.equal(first, second);
  s.now += cache.KEEP_MS - 1;
  assert.equal((await cache.remember("7", s.read, s.clock)).n, 1, "kept until five minutes are up");
  s.now += 1;
  assert.equal((await cache.remember("7", s.read, s.clock)).n, 2, "five minutes on, read again");
  assert.equal((await cache.remember("8", s.read, s.clock)).n, 3, "another business has its own");
  assert.equal(cache.KEEP_MS, 5 * 60 * 1000);
});

test("clear() throws every kept answer away, and a reading out when it comes is not kept", async () => {
  const s = setUp();
  await cache.remember("7", s.read, s.clock);
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal((await cache.remember("7", s.read, s.clock)).n, 2);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const out = cache.remember("9", async () => { await gate; return { n: ++s.reads }; }, s.clock);
  cache.clear();
  release();
  assert.equal((await out).n, 3, "whoever asked gets it");
  assert.equal((await cache.remember("9", s.read, s.clock)).n, 4, "but it was not kept");
});

test("a failed reading is never kept", async () => {
  const s = setUp();
  await assert.rejects(cache.remember("5", async () => { throw new Error("database down"); }, s.clock), /database down/);
  assert.equal(cache.size(), 0);
  assert.equal((await cache.remember("5", s.read, s.clock)).n, 1);
});

test("kept only where the bell keeps its answers: off with NOTIFICATIONS_CACHE=off, and in tests unless it is on", async () => {
  const s = setUp();
  process.env.NOTIFICATIONS_CACHE = "off";
  await cache.remember("7", s.read, s.clock);
  await cache.remember("7", s.read, s.clock);
  assert.deepEqual([s.reads, cache.size()], [2, 0], "off: read every time");
  delete process.env.NOTIFICATIONS_CACHE;
  process.env.NODE_ENV = "test";
  await cache.remember("7", s.read, s.clock);
  assert.equal(s.reads, 3, "a test sees its own change at once");
  process.env.NOTIFICATIONS_CACHE = "on";
  await cache.remember("7", s.read, s.clock);
  await cache.remember("7", s.read, s.clock);
  assert.equal(s.reads, 4, "unless the test asks for kept answers");
  assert.equal(keptAnswersOn({}), true, "kept in production");
  assert.equal(keptAnswersOn({ NODE_ENV: "production", NOTIFICATIONS_CACHE: " OFF " }), false);
  assert.equal(keptAnswersOn({ NODE_ENV: "test" }), false);
  assert.equal(keptAnswersOn({ NODE_ENV: "test", NOTIFICATIONS_CACHE: "on" }), true);
});

test("never more than its cap, the oldest going first", async () => {
  const s = setUp();
  for (let i = 0; i < cache.MAX_KEPT + 10; i += 1) await cache.remember(`b${i}`, s.read, s.clock);
  assert.equal(cache.size(), cache.MAX_KEPT);
  const reads = s.reads;
  await cache.remember(`b${cache.MAX_KEPT + 9}`, s.read, s.clock);
  assert.equal(s.reads, reads, "the newest is still kept");
  await cache.remember("b0", s.read, s.clock);
  assert.equal(s.reads, reads + 1, "the oldest went first");
});
