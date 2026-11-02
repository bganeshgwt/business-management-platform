import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { keyScope, liveAddress, retryDelay, sameScope, SILENT_MS, usableKey } from "../src/services/guestLiveRules.js";

// The rules behind a guest page's live updates (src/services/guestLive.js):
// what a key watches, when a stream is kept or opened again, how long to wait
// before trying again. No browser, no React.

const keyOf = (payload, signature = "c2lnbmF0dXJl") => `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

test("two keys watching the same rows are one scope, whatever their order, end or signature", () => {
  const one = keyOf({ v: 1, restaurant: 12, watch: [{ area: "table_request", id: 45 }, { area: "order", id: 7 }], exp: 1 });
  const two = keyOf({ v: 1, restaurant: 12, watch: [{ area: "order", id: 7 }, { area: "table_request", id: 45 }], exp: 2 }, "b3RoZXI");
  assert.equal(keyScope(one), "restaurant:12|order:7,table_request:45");
  assert.equal(sameScope(one, two), true);
  // Another row, another restaurant, a business with the same id: another scope.
  assert.equal(sameScope(one, keyOf({ v: 1, restaurant: 12, watch: [{ area: "order", id: 7 }], exp: 1 })), false);
  assert.equal(sameScope(one, keyOf({ v: 1, restaurant: 13, watch: [{ area: "table_request", id: 45 }, { area: "order", id: 7 }], exp: 1 })), false);
  assert.equal(keyScope(keyOf({ v: 1, business: 12, watch: [{ area: "appointment", id: 3 }], exp: 1 })), "business:12|appointment:3");
});

test("a key that cannot be read stands for itself", () => {
  assert.equal(keyScope("not-a-key"), null);
  assert.equal(keyScope(null), null);
  assert.equal(keyScope(`${Buffer.from("{}").toString("base64url")}.x`), null);
  assert.equal(sameScope("not-a-key", "not-a-key"), true);
  assert.equal(sameScope("not-a-key", "another"), false);
  assert.equal(sameScope(null, "not-a-key"), false);
});

test("a key is used while it has more than a quarter of a minute left", () => {
  const at = (ms) => new Date(NOW + ms).toISOString();
  assert.equal(usableKey({ key: "k", expiresAt: at(2 * 3600 * 1000) }, NOW), true);
  assert.equal(usableKey({ key: "k", expiresAt: at(16000) }, NOW), true);
  assert.equal(usableKey({ key: "k", expiresAt: at(15000) }, NOW), false);
  assert.equal(usableKey({ key: "k", expiresAt: at(-1000) }, NOW), false);
  assert.equal(usableKey({ key: "k", expiresAt: "soon" }, NOW), false);
  assert.equal(usableKey(null, NOW), false);
});

test("a failed stream is tried again after 5, 10, 20 and 40 seconds, then every minute, a quarter more or less", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((attempt) => retryDelay(attempt, () => 0.5)), [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(retryDelay(0, () => 0), 3750);
  assert.equal(retryDelay(0, () => 0.999999), 6250);
  assert.equal(retryDelay(-3, () => 0.5), 5000);
  // Silent for 70 seconds is dropped: the server pings at least every 25.
  assert.equal(SILENT_MS, 70000);
});

test("the stream's address carries the key, encoded", () => {
  assert.equal(liveAddress("https://api.example.com/api/", "a.b"), "https://api.example.com/api/public/live?key=a.b");
  assert.equal(liveAddress("/api", "a+b/c"), "/api/public/live?key=a%2Bb%2Fc");
});
