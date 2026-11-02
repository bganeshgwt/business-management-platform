const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const guestKeys = require("../src/modules/live/services/guestKeys");

// Guest live keys (modules/live/services/guestKeys.js): what one guest's page
// may watch, signed by the server and good for two hours. A key made for one
// restaurant's rows never opens another's, a key changed by one character is
// refused, and an old one is told apart from a forged one. No database and no
// settings: the key set is made from a secret given here.

const SECRET = crypto.randomBytes(48).toString("hex");
const keys = guestKeys.keysFor(SECRET);
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const at = (ms) => ({ now: NOW + ms });
const HOUR = 3600 * 1000;

// The key's two parts, and the payload of the first as the page can read it.
const parts = (key) => key.split(".");
const payloadOf = (key) => JSON.parse(Buffer.from(parts(key)[0], "base64url").toString("utf8"));
const resign = (payload, secret = SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sign = crypto.createHmac("sha256", guestKeys.deriveSecret(secret)).update(body).digest("base64url");
  return `${body}.${sign}`;
};

test("a key says what it may watch and when it ends, and reads back as issued", () => {
  const issued = keys.issue({ restaurant: 12, watch: [{ area: "table_request", id: 45 }, { area: "order", id: 7 }] }, { now: NOW });
  assert.match(issued.key, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  // Two hours from now, to the second.
  assert.equal(issued.expiresAt, new Date(NOW + 2 * HOUR).toISOString());
  const read = keys.verify(issued.key, at(0));
  assert.deepEqual(read, { v: 1, restaurant: 12, watch: [{ area: "order", id: 7 }, { area: "table_request", id: 45 }], exp: (NOW + 2 * HOUR) / 1000 });
  // The page can read what it watches (the key is signed, not secret).
  assert.deepEqual(payloadOf(issued.key).watch, read.watch);
  assert.deepEqual(keys.read(issued.key, at(0)), { payload: read, problem: null });
});

test("the watch list is kept in one order, without repeats, so the same scope reads the same", () => {
  const one = keys.issue({ business: 3, watch: [{ area: "appointment", id: 9 }, { area: "appointment", id: 2 }, { area: "appointment", id: 9 }] }, { now: NOW });
  const two = keys.issue({ business: 3, watch: [{ area: "appointment", id: 2 }, { area: "appointment", id: 9 }] }, { now: NOW });
  assert.equal(one.key, two.key);
  assert.deepEqual(keys.verify(one.key, at(0)).watch, [{ area: "appointment", id: 2 }, { area: "appointment", id: 9 }]);
  // Ids written as text in a database row are read as numbers.
  const text = keys.issue({ restaurant: "12", watch: [{ area: "order", id: "7" }] }, { now: NOW });
  assert.deepEqual(keys.verify(text.key, at(0)), { v: 1, restaurant: 12, watch: [{ area: "order", id: 7 }], exp: (NOW + 2 * HOUR) / 1000 });
});

test("nothing to watch gives no key", () => {
  assert.equal(keys.issue({ restaurant: 12, watch: [] }, { now: NOW }), null);
});

test("a key is refused once its two hours are up, and told apart from a forged one", () => {
  const { key } = keys.issue({ restaurant: 12, watch: [{ area: "reservation", id: 3 }] }, { now: NOW });
  assert.ok(keys.verify(key, at(2 * HOUR - 1000)));
  assert.equal(keys.verify(key, at(2 * HOUR)), null);
  assert.deepEqual(keys.read(key, at(2 * HOUR + 1)), { payload: null, problem: "expired" });
  assert.deepEqual(keys.read(`${key}x`, at(0)), { payload: null, problem: "invalid" });
});

test("a key changed in any way is refused", () => {
  const { key } = keys.issue({ restaurant: 12, watch: [{ area: "order", id: 7 }] }, { now: NOW });
  const [body, sign] = parts(key);
  const payload = payloadOf(key);
  const refused = [
    // Another row, another restaurant, another area, a later end, written with the payload alone.
    resign({ ...payload, watch: [{ area: "order", id: 8 }] }, "a guess at the secret that is long enough to pass"),
    `${Buffer.from(JSON.stringify({ ...payload, restaurant: 13 })).toString("base64url")}.${sign}`,
    `${Buffer.from(JSON.stringify({ ...payload, watch: [{ area: "bill", id: 7 }] })).toString("base64url")}.${sign}`,
    `${Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 3600 })).toString("base64url")}.${sign}`,
    // The signature altered, cut short, or missing; the parts swapped; the payload alone.
    `${body}.${sign.slice(0, -1)}${sign.endsWith("A") ? "B" : "A"}`,
    `${body}.${sign.slice(0, 20)}`,
    `${body}.`,
    `${sign}.${body}`,
    body,
    // A key signed with the login secret itself rather than the key derived from it.
    `${body}.${crypto.createHmac("sha256", SECRET).update(body).digest("base64url")}`,
    // Not a key at all.
    "",
    "not a key",
    `${body}.${sign}.extra`,
    "a".repeat(5000),
    null,
    undefined,
    42,
    { key },
  ];
  for (const value of refused) {
    assert.equal(keys.verify(value, at(0)), null, `refused: ${String(value).slice(0, 60)}`);
  }
});

test("a key made by another server's secret opens nothing here", () => {
  const theirs = guestKeys.keysFor(crypto.randomBytes(48).toString("hex"));
  const { key } = theirs.issue({ restaurant: 12, watch: [{ area: "order", id: 7 }] }, { now: NOW });
  assert.equal(keys.verify(key, at(0)), null);
  assert.ok(theirs.verify(key, at(0)));
});

test("a key is for one restaurant or one business, never both or neither", () => {
  const restaurant = keys.verify(keys.issue({ restaurant: 5, watch: [{ area: "order", id: 1 }] }, { now: NOW }).key, at(0));
  const business = keys.verify(keys.issue({ business: 5, watch: [{ area: "appointment", id: 1 }] }, { now: NOW }).key, at(0));
  assert.equal(restaurant.restaurant, 5);
  assert.equal("business" in restaurant, false);
  assert.equal(business.business, 5);
  assert.equal("restaurant" in business, false);
  assert.deepEqual(guestKeys.scopeOf(restaurant), { kind: "restaurant", tenant: 5 });
  assert.deepEqual(guestKeys.scopeOf(business), { kind: "business", tenant: 5 });
  // A payload naming both, or neither, is refused even when it is signed.
  const exp = (NOW + HOUR) / 1000;
  assert.equal(keys.verify(resign({ v: 1, restaurant: 5, business: 5, watch: [{ area: "order", id: 1 }], exp }), at(0)), null);
  assert.equal(keys.verify(resign({ v: 1, watch: [{ area: "order", id: 1 }], exp }), at(0)), null);
  // Another version, a bad area, a bad id, an empty or long watch list: refused even when signed.
  assert.equal(keys.verify(resign({ v: 2, restaurant: 5, watch: [{ area: "order", id: 1 }], exp }), at(0)), null);
  assert.equal(keys.verify(resign({ v: 1, restaurant: 5, watch: [{ area: "Order", id: 1 }], exp }), at(0)), null);
  assert.equal(keys.verify(resign({ v: 1, restaurant: 5, watch: [{ area: "order", id: 0 }], exp }), at(0)), null);
  assert.equal(keys.verify(resign({ v: 1, restaurant: 5, watch: [], exp }), at(0)), null);
  const many = Array.from({ length: guestKeys.MAX_WATCH + 1 }, (_, i) => ({ area: "order", id: i + 1 }));
  assert.equal(keys.verify(resign({ v: 1, restaurant: 5, watch: many, exp }), at(0)), null);
  assert.ok(keys.verify(resign({ v: 1, restaurant: 5, watch: many.slice(1), exp }), at(0)));
});

test("a programming mistake in what is issued is refused loudly", () => {
  assert.throws(() => keys.issue({ watch: [{ area: "order", id: 1 }] }), /one restaurant or one business/);
  assert.throws(() => keys.issue({ restaurant: 1, business: 2, watch: [{ area: "order", id: 1 }] }), /one restaurant or one business/);
  assert.throws(() => keys.issue({ restaurant: 0, watch: [{ area: "order", id: 1 }] }), /one restaurant or one business/);
  assert.throws(() => keys.issue({ restaurant: 1, watch: [{ area: "Order!", id: 1 }] }), /area/);
  assert.throws(() => keys.issue({ restaurant: 1, watch: [{ area: "order", id: -4 }] }), /id/);
  assert.throws(() => keys.issue({ restaurant: 1, watch: "order:1" }), /list/);
  const many = Array.from({ length: guestKeys.MAX_WATCH + 1 }, (_, i) => ({ area: "order", id: i + 1 }));
  assert.throws(() => keys.issue({ restaurant: 1, watch: many }), /at most/);
});

test("the signing key is derived from the login secret under a label of its own", () => {
  const derived = guestKeys.deriveSecret(SECRET);
  assert.equal(derived.length, 32);
  assert.notDeepEqual(derived, Buffer.from(SECRET));
  assert.deepEqual(guestKeys.deriveSecret(SECRET), derived);
  assert.notDeepEqual(guestKeys.deriveSecret(`${SECRET}x`), derived);
  // Not the two-step sign-in's key, nor any plain hash of the secret.
  assert.notDeepEqual(derived, Buffer.from(crypto.hkdfSync("sha256", SECRET, "rmp-two-factor", "two-factor:secret", 32)));
  assert.notDeepEqual(derived, crypto.createHash("sha256").update(SECRET).digest());
});
