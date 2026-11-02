const crypto = require("node:crypto");

// Guest live keys (ARCHITECTURE.md §3.5, "Guests' streams").
//
// A guest has no login, so a guest's page cannot open a stream the way a
// staff screen does. Instead each status answer the guest reads (a table's
// QR requests, an online order, a booking, a business's guest page) carries a
// key naming exactly what that page may watch: one restaurant or one
// business, and the rows in it, as { area, id } pairs of the live updates'
// own areas. The page opens GET /api/public/live?key=… with it
// (routes/guestLive.routes.js), and hears of changes to those rows only.
//
// The key is "<payload>.<signature>", both base64url. The payload is
// { v, restaurant | business, watch: [{ area, id }], exp } as JSON, readable
// by the page; the signature is an HMAC-SHA256 of it. The signing key is
// derived from JWT_SECRET through HKDF with a label of its own, so no new
// setting is needed and no other use of the secret can make or read one.
// A key lasts two hours: the page reads its status again before then, and
// every answer brings a fresh key. A change of JWT_SECRET ends every key,
// which costs a guest one more read.
//
// issue() is called with a list worked out from rows the caller just read,
// so a mistake in it is a programming error and throws; verify() is called
// with whatever arrived in an address, so it never throws.

const VERSION = 1;
const LIFETIME_SECONDS = 2 * 60 * 60;
// The most rows one page watches: a table's twenty requests and their orders.
const MAX_WATCH = 40;
const MAX_KEY_LENGTH = 4096;
const AREA = /^[a-z][a-z_]{0,39}$/;
const PART = /^[A-Za-z0-9_-]+$/;

const deriveSecret = (secret) => Buffer.from(crypto.hkdfSync("sha256", String(secret), "bmp-guest-live", "guest live key", 32));

const idOf = (value) => {
  const number = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

// The restaurant or business a payload is for.
const scopeOf = (payload) =>
  payload.restaurant ? { kind: "restaurant", tenant: payload.restaurant } : { kind: "business", tenant: payload.business };

// The watch list in one order, without repeats: the same rows always make
// the same list.
const tidy = (watch) => {
  const seen = new Map();

  for (const { area, id } of watch) {
    seen.set(`${area}:${id}`, { area, id });
  }

  return [...seen.values()].sort((a, b) => (a.area === b.area ? a.id - b.id : a.area < b.area ? -1 : 1));
};

// A payload read back from a key, checked part by part even though it is
// signed: only what this version writes is ever accepted.
const checked = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.v !== VERSION) {
    return null;
  }

  const restaurant = payload.restaurant === undefined ? null : idOf(payload.restaurant);
  const business = payload.business === undefined ? null : idOf(payload.business);

  if (Boolean(restaurant) === Boolean(business) || (payload.restaurant !== undefined && !restaurant) || (payload.business !== undefined && !business)) {
    return null;
  }

  const { watch, exp } = payload;

  if (!Array.isArray(watch) || watch.length === 0 || watch.length > MAX_WATCH || !Number.isSafeInteger(exp)) {
    return null;
  }

  for (const entry of watch) {
    if (!entry || typeof entry !== "object" || typeof entry.area !== "string" || !AREA.test(entry.area) || !Number.isSafeInteger(entry.id) || entry.id <= 0) {
      return null;
    }
  }

  return {
    v: VERSION,
    ...(restaurant ? { restaurant } : { business }),
    watch: watch.map(({ area, id }) => ({ area, id })),
    exp,
  };
};

// The key set for one secret: { issue, verify, read }.
function keysFor(secret) {
  const key = deriveSecret(secret);
  const sign = (body) => crypto.createHmac("sha256", key).update(body).digest("base64url");

  // { restaurant | business, watch: [{ area, id }] } → { key, expiresAt }, or
  // null when there is nothing to watch.
  const issue = ({ restaurant, business, watch }, { now = Date.now() } = {}) => {
    const restaurantId = restaurant === undefined || restaurant === null ? null : idOf(restaurant);
    const businessId = business === undefined || business === null ? null : idOf(business);

    if (Boolean(restaurantId) === Boolean(businessId) || (restaurant != null && !restaurantId) || (business != null && !businessId)) {
      throw new Error("A guest live key is for one restaurant or one business");
    }

    if (!Array.isArray(watch)) {
      throw new Error("A guest live key's watch is a list of { area, id }");
    }

    const rows = tidy(
      watch.map((entry) => {
        if (!entry || typeof entry.area !== "string" || !AREA.test(entry.area)) {
          throw new Error(`A guest live key cannot watch the area ${JSON.stringify(entry && entry.area)}`);
        }

        const id = idOf(entry.id);

        if (!id) {
          throw new Error(`A guest live key cannot watch the id ${JSON.stringify(entry.id)}`);
        }

        return { area: entry.area, id };
      })
    );

    if (rows.length === 0) {
      return null;
    }

    if (rows.length > MAX_WATCH) {
      throw new Error(`A guest live key watches at most ${MAX_WATCH} rows`);
    }

    const exp = Math.floor(now / 1000) + LIFETIME_SECONDS;
    const payload = { v: VERSION, ...(restaurantId ? { restaurant: restaurantId } : { business: businessId }), watch: rows, exp };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");

    return { key: `${body}.${sign(body)}`, expiresAt: new Date(exp * 1000).toISOString() };
  };

  // { payload, problem }: the payload with problem null, or no payload and
  // "invalid" (not a key of this server) or "expired" (one whose two hours
  // are up).
  const read = (value, { now = Date.now() } = {}) => {
    const refused = { payload: null, problem: "invalid" };

    if (typeof value !== "string" || value.length > MAX_KEY_LENGTH) {
      return refused;
    }

    const parts = value.split(".");

    if (parts.length !== 2 || !PART.test(parts[0]) || !PART.test(parts[1])) {
      return refused;
    }

    const expected = Buffer.from(sign(parts[0]));
    const given = Buffer.from(parts[1]);

    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return refused;
    }

    let payload;

    try {
      payload = checked(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    } catch {
      return refused;
    }

    if (!payload) {
      return refused;
    }

    if (payload.exp * 1000 <= now) {
      return { payload: null, problem: "expired" };
    }

    return { payload, problem: null };
  };

  // The payload, or null for anything that is not a live key of this server.
  const verify = (value, options) => read(value, options).payload;

  return { issue, read, verify };
}

// The server's own key set, from JWT_SECRET (config/env.js), made on first
// use: requiring this file reads no setting, so the unit tests load it alone.
let own = null;
const ownKeys = () => {
  const { secret } = require("../../../config/env").jwt;

  if (!own || own.secret !== secret) {
    own = { secret, keys: keysFor(secret) };
  }

  return own.keys;
};

module.exports = {
  VERSION,
  LIFETIME_SECONDS,
  MAX_WATCH,
  deriveSecret,
  keysFor,
  scopeOf,
  issue: (scope, options) => ownKeys().issue(scope, options),
  read: (key, options) => ownKeys().read(key, options),
  verify: (key, options) => ownKeys().verify(key, options),
};
