// The rules of a guest page's live updates without React or the browser
// (guestLive.js uses them; tests/guest-live-rules.test.js checks them).
//
// A guest live key is "<payload>.<signature>": the payload, base64url JSON,
// says what the page may watch ({ restaurant | business, watch: [{ area, id }] }).
// Every status answer brings a fresh key, so the page compares what two keys
// watch, not the keys themselves: an open stream is kept while the rows it
// watches stay the same, and opened again when they change.

// What a key watches, as one string; null when it cannot be read (then the
// whole key stands for itself).
export function keyScope(key) {
  if (typeof key !== "string") {
    return null;
  }

  const [body] = key.split(".");

  try {
    const text = atob(body.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(body.length / 4) * 4, "="));
    const payload = JSON.parse(text);
    const tenant = payload.restaurant ? `restaurant:${payload.restaurant}` : payload.business ? `business:${payload.business}` : null;

    if (!tenant || !Array.isArray(payload.watch)) {
      return null;
    }

    return `${tenant}|${payload.watch.map((row) => `${row.area}:${row.id}`).sort().join(",")}`;
  } catch {
    return null;
  }
}

// Two keys watch the same rows.
export const sameScope = (one, two) => {
  if (!one || !two) {
    return false;
  }

  const a = keyScope(one);
  return a ? a === keyScope(two) : one === two;
};

// A key worth opening a stream with: one with more than a quarter of a minute
// left (a tab woken after hours holds one long expired).
export const usableKey = (live, now = Date.now()) => {
  const ends = live && live.key ? Date.parse(live.expiresAt) : NaN;
  return Number.isFinite(ends) && ends - now > 15000;
};

// How long to wait before the next try at a stream that failed: 5 seconds,
// then 10, 20, 40 and every minute, a quarter more or less so that a room
// full of phones does not come back at the same second.
const STEPS = [5000, 10000, 20000, 40000, 60000];

export const retryDelay = (attempt, random = Math.random) => {
  const step = STEPS[Math.min(Math.max(0, attempt), STEPS.length - 1)];
  return Math.round(step * (0.75 + random() * 0.5));
};

// A stream silent this long is taken as dropped: the server sends at least a
// ping every 25 seconds.
export const SILENT_MS = 70000;

// The stream's address.
export const liveAddress = (apiBase, key) => `${String(apiBase || "").replace(/\/$/, "")}/public/live?key=${encodeURIComponent(key)}`;
