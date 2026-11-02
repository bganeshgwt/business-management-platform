import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The service worker's rules (public/sw-rules.js), run the way the worker
// loads them: as a plain script that sets self.BMP_SW_RULES. Which way each
// request is answered (never the API), the cache names, the pictures kept,
// and what a push notification shows and opens.

const load = () => {
  const self = {};
  new Function("self", fs.readFileSync(new URL("../public/sw-rules.js", import.meta.url), "utf8"))(self);
  return self.BMP_SW_RULES;
};
const RULES = load();
const ORIGIN = "https://app.example.com";
const same = { origin: ORIGIN, apiBase: "/api" };
const apart = { origin: ORIGIN, apiBase: "https://api.example.com/api" };
const get = (path, mode = "cors", method = "GET") => ({ url: path.startsWith("http") ? path : `${ORIGIN}${path}`, mode, method });

test("pages: the network first, else this device's copy; never the guests' pages", () => {
  for (const path of ["/", "/captain", "/captain/calls?x=1", "/business-admin/4/counter", "/kitchen", "/login", "/welcome"]) {
    assert.equal(RULES.strategyFor(get(path, "navigate"), same), "navigate", path);
  }
  for (const path of ["/order/abc", "/online/abc/status/x", "/book/x", "/privacy-notice/r", "/shop/t", "/appointments", "/account", "/guest-assets/a.js"]) {
    assert.equal(RULES.strategyFor(get(path, "navigate"), same), "none", path);
  }
  // "/orders" and "/privacy" are staff screens, not guests' pages.
  assert.equal(RULES.strategyFor(get("/orders", "navigate"), same), "navigate");
  assert.equal(RULES.strategyFor(get("/privacy", "navigate"), same), "navigate");
  assert.equal(RULES.NAVIGATION_TIMEOUT_MS, 3500);
});

test("the API is never kept: on the app's own address or another, and its streams", () => {
  for (const url of ["/api/auth/me", "/api/live", "/api/businesses/4/live", "/api/push/key", "/api"]) {
    assert.equal(RULES.strategyFor(get(url), same), "none", url);
    assert.equal(RULES.strategyFor(get(url, "navigate"), same), "none", `${url} opened as a page`);
  }
  for (const url of ["https://api.example.com/api/auth/me", "https://api.example.com/api/live", "https://api.example.com/api"]) {
    assert.equal(RULES.strategyFor(get(url), apart), "none", url);
  }
  // Nothing but GET is ever answered by the worker.
  assert.equal(RULES.strategyFor(get("/assets/index-abc.js", "cors", "POST"), same), "none");
  assert.equal(RULES.strategyFor(get("/captain", "navigate", "POST"), same), "none");
  assert.equal(RULES.strategyFor(get("https://cdn.example.org/x.js"), same), "none", "another site");
  assert.equal(RULES.strategyFor(get("/sw.js"), same), "none");
  assert.equal(RULES.strategyFor(get("/sw-rules.js"), same), "none");
});

test("built files from the copy, pictures and the app's own files kept and refreshed", () => {
  assert.equal(RULES.strategyFor(get("/assets/CaptainLayout-Bx9a.js"), same), "asset");
  assert.equal(RULES.strategyFor(get("/assets/index-77.css"), same), "asset");
  assert.equal(RULES.strategyFor(get("/uploads/products/dal.webp"), same), "uploads");
  assert.equal(RULES.strategyFor(get("https://api.example.com/uploads/products/dal.webp"), apart), "uploads", "beside an API of its own");
  assert.equal(RULES.strategyFor(get("/icons/captain-192.png"), same), "static");
  assert.equal(RULES.strategyFor(get("/manifests/captain.webmanifest"), same), "static");
  assert.equal(RULES.strategyFor(get("/favicon.svg"), same), "static");
});

test("cache names: a copy per build; the one before is kept, older ones go", () => {
  assert.equal(RULES.shellCacheName("3f2a9c"), "bmp-shell-3f2a9c");
  const names = ["bmp-shell-a", "bmp-uploads", "bmp-shell-b", "bmp-shell-c", "other-site-cache"];
  assert.deepEqual(RULES.cachesToDelete(names, "bmp-shell-d"), ["bmp-shell-a", "bmp-shell-b"]);
  assert.deepEqual(RULES.cachesToDelete(names, "bmp-shell-c"), ["bmp-shell-a"]);
  assert.deepEqual(RULES.cachesToDelete(["bmp-shell-a"], "bmp-shell-a"), []);
  assert.deepEqual(RULES.cachesToDelete([], "bmp-shell-a"), []);
});

test("pictures: at most 200 kept, the oldest go first; only whole, readable answers of a sensible size", () => {
  assert.equal(RULES.UPLOADS_MAX_ENTRIES, 200);
  const keys = Array.from({ length: 205 }, (_, i) => `k${i}`);
  assert.deepEqual(RULES.uploadsToDrop(keys), ["k0", "k1", "k2", "k3", "k4"]);
  assert.deepEqual(RULES.uploadsToDrop(keys.slice(0, 10)), []);
  assert.deepEqual(RULES.uploadsToDrop(["a", "b", "c"], 2), ["a"]);
  const response = (status, type = "basic", length = "2048") => ({ status, type, headers: new Headers(length ? { "content-length": length } : {}) });
  assert.equal(RULES.keepable(response(200)), true);
  assert.equal(RULES.keepable(response(200, "cors", null)), true, "no length given");
  assert.equal(RULES.keepable(response(200, "opaque")), false, "an opaque answer hides its size");
  assert.equal(RULES.keepable(response(206)), false, "part of a file");
  assert.equal(RULES.keepable(response(404)), false);
  assert.equal(RULES.keepable(response(200, "basic", String(4 * 1024 * 1024))), false, "too large");
});

test("a push notification: always shown, tagged per table, quiet while the captain app is in front; only the app's own addresses", () => {
  const message = { title: "Table T4 is calling", body: "Wants a waiter from the table's QR code", url: "/captain/calls", tag: "table-4" };
  const loud = RULES.notificationFor(message, { origin: ORIGIN, visibleCaptain: false, now: 1000 });
  assert.equal(loud.title, "Table T4 is calling");
  assert.deepEqual(loud.options, { body: "Wants a waiter from the table's QR code", icon: "/icons/captain-192.png", badge: "/icons/badge-96.png",
    data: { url: "/captain/calls" }, timestamp: 1000, silent: false, tag: "table-4", renotify: true });
  const quiet = RULES.notificationFor(message, { origin: ORIGIN, visibleCaptain: true, now: 1000 });
  assert.equal(quiet.options.silent, true, "the open app chimes; the notification still shows");
  assert.equal(quiet.options.renotify, false);
  assert.equal(RULES.notificationFor({ ...message, url: "https://evil.example/x" }, { origin: ORIGIN }).options.data.url, "/captain");
  assert.equal(RULES.notificationFor({ ...message, url: `${ORIGIN}/captain/ready?x=1` }, { origin: ORIGIN }).options.data.url, "/captain/ready?x=1");
  const bare = RULES.notificationFor(null, { origin: ORIGIN });
  assert.equal(bare.title, "Captain app");
  assert.equal(bare.options.tag, undefined, "no tag: never renotify without one");
  assert.equal(bare.options.renotify, undefined);
});

test("which window a tapped notification brings forward", () => {
  const win = (url, extra = {}) => ({ url: `${ORIGIN}${url}`, visibilityState: "visible", focused: true, ...extra });
  assert.equal(RULES.isVisibleCaptain(win("/captain/calls"), ORIGIN), true);
  assert.equal(RULES.isVisibleCaptain(win("/captain", { visibilityState: "hidden" }), ORIGIN), false);
  assert.equal(RULES.isVisibleCaptain(win("/captain", { focused: false }), ORIGIN), false);
  assert.equal(RULES.isVisibleCaptain(win("/pos"), ORIGIN), false);
  assert.equal(RULES.isVisibleCaptain({ url: "https://other.example/captain", visibilityState: "visible" }, ORIGIN), false);
  const pos = win("/pos");
  const captain = win("/captain/ready");
  const guest = win("/order/abc");
  assert.equal(RULES.windowFor([pos, captain], "/captain/calls", ORIGIN), captain, "the captain app's own window");
  assert.equal(RULES.windowFor([pos], "/captain/calls", ORIGIN), pos, "else any of the app's");
  assert.equal(RULES.windowFor([guest], "/captain/calls", ORIGIN), null, "never a guest's page");
  assert.equal(RULES.windowFor([], "/captain", ORIGIN), null);
});

test("the worker itself: production only, the API never cached, push always shown", () => {
  const worker = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  // The line the build fills in, as written here a placeholder.
  assert.match(worker, /^self\.__BMP_BUILD__ = \{ id: "development", files: \[\], api: "\/api" \};$/m);
  assert.match(worker, /self\.importScripts\("\/sw-rules\.js"\)/);
  // A new build's worker waits for the bar's Reload: skipWaiting only on its message.
  assert.equal(worker.match(/skipWaiting\(\)/g).length, 1);
  assert.match(worker, /data\.type === "SKIP_WAITING"[\s\S]{0,40}self\.skipWaiting\(\)/);
  // Every push shows a notification, inside waitUntil.
  assert.match(worker, /addEventListener\("push"[\s\S]*event\.waitUntil\([\s\S]*showNotification/);
  const registration = fs.readFileSync(new URL("../src/services/offline/serviceWorker.js", import.meta.url), "utf8");
  assert.match(registration, /import\.meta\.env\.PROD/, "registered by production builds only");
});
