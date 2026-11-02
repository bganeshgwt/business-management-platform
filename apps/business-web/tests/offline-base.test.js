import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { isOfflineCapable, offlineScreenFor, offlineScreensFor, OFFLINE_SCREENS } from "../src/services/offline/offlineScreens.js";
import { outboxSummary } from "../src/services/offline/outboxWords.js";
import { snapshotAge } from "../src/services/offline/snapshots.js";
import { keyBytes, pushStatus } from "../src/services/pushRules.js";
import { installOffer, isIosDevice, isStandalone } from "../src/services/install.js";

// The offline base's rules (services/offline): which screens open with no
// network, what the offline indicator says, a snapshot's age; and this
// device's alerts on a closed phone and installing the app.

test("the screens that open with no network: the captain app, the counter, the salesperson app", () => {
  assert.deepEqual(OFFLINE_SCREENS.map((screen) => screen.id), ["captain", "counter", "sales"]);
  for (const path of ["/captain", "/captain/calls", "/captain/order?table=4", "/business-admin/12/counter", "/sales", "/sales/4/today"]) {
    assert.equal(isOfflineCapable(path), true, path);
  }
  for (const path of ["/", "/pos", "/kitchen", "/business-admin", "/business-admin/12", "/business-admin/12/sales", "/clinic/4", "/salesperson", "/captainx"]) {
    assert.equal(isOfflineCapable(path), false, path);
  }
  assert.equal(offlineScreenFor("/business-admin/12/counter").label, "Quick bill");
  const captain = { restaurantId: 3, permissions: ["orders.create"], features: ["captain_app"] };
  assert.deepEqual(offlineScreensFor(captain), [{ id: "captain", label: "Captain app", to: "/captain" }]);
  assert.deepEqual(offlineScreensFor({ ...captain, features: [] }), [], "the captain app switched off");
  assert.deepEqual(offlineScreensFor({ ...captain, permissions: ["orders.view"] }), [], "may not take orders");
  assert.deepEqual(offlineScreensFor(null), []);
});

test("what the offline indicator says: honestly, and nothing when there is nothing to say", () => {
  const counts = (waiting = 0, attention = 0, sending = 0) => ({ waiting, attention, sending, total: waiting + attention + sending });
  assert.equal(outboxSummary({ online: true, counts: counts(), paused: null }), null);
  assert.deepEqual(outboxSummary({ online: false, counts: counts(), paused: null }), { tone: "offline", label: "Offline" });
  assert.deepEqual(outboxSummary({ online: false, counts: counts(3), paused: null }), { tone: "offline", label: "Offline · 3 waiting to send" });
  assert.deepEqual(outboxSummary({ online: false, counts: counts(2, 1, 1), paused: null }), { tone: "offline", label: "Offline · 3 waiting to send" });
  assert.deepEqual(outboxSummary({ online: true, counts: counts(0, 1), paused: null }), { tone: "attention", label: "1 needs attention" });
  assert.deepEqual(outboxSummary({ online: true, counts: counts(2, 2), paused: null }), { tone: "attention", label: "2 need attention · 2 waiting" });
  assert.deepEqual(outboxSummary({ online: true, counts: counts(1), paused: "signin" }), { tone: "offline", label: "1 waiting for sign-in" });
  assert.deepEqual(outboxSummary({ online: true, counts: counts(0, 0, 2), paused: null }), { tone: "sending", label: "Sending 2…" });
});

test("a snapshot's age, in words", () => {
  const now = Date.parse("2026-11-02T19:42:00+05:30");
  assert.equal(snapshotAge(now - 20_000, now), "just now");
  assert.equal(snapshotAge(now - 60_000, now), "1 minute ago");
  assert.equal(snapshotAge(now - 42 * 60_000, now), "42 minutes ago");
  assert.match(snapshotAge(now - 3 * 3600_000, now), /^since \d{1,2}:\d{2}\s?[ap]m$/i);
});

test("alerts on a closed phone: what the switch can say, in order", () => {
  const phone = { serverKey: "BKey", production: true, secure: true, hasWorker: true, hasPush: true, hasNotification: true, ios: false,
    standalone: false, permission: "default", subscribed: false, asking: false };
  assert.equal(pushStatus({ ...phone, serverKey: undefined }), "checking");
  assert.equal(pushStatus({ ...phone, serverKey: null }), "off-server", "no keys on the server");
  assert.equal(pushStatus({ ...phone, production: false }), "development", "development runs no worker");
  assert.equal(pushStatus({ ...phone, ios: true, hasPush: false }), "ios-install", "Safari in a tab: the Home Screen first");
  assert.equal(pushStatus({ ...phone, ios: true, standalone: true }), "off", "from the Home Screen it works");
  assert.equal(pushStatus({ ...phone, hasPush: false }), "unsupported");
  assert.equal(pushStatus({ ...phone, secure: false }), "unsupported", "an address that is not https");
  assert.equal(pushStatus({ ...phone, permission: "denied" }), "denied");
  assert.equal(pushStatus({ ...phone, asking: true }), "asking", "Chrome's quiet question not answered yet");
  assert.equal(pushStatus({ ...phone, permission: "granted", subscribed: true }), "on");
  assert.equal(pushStatus({ ...phone, permission: "granted", subscribed: false }), "off");
  assert.equal(pushStatus({ ...phone, permission: "default", subscribed: true }), "off", "a subscription without permission alerts nobody");
  // The server's key as the browser takes it: the 65 bytes of the point.
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString("base64url");
  const bytes = keyBytes(key);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
  assert.equal(Buffer.from(bytes).toString("base64url"), key);
});

test("installing: the browser's own offer, the iPhone's steps, nothing once installed", () => {
  assert.equal(isIosDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X)" }), true);
  assert.equal(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 }), true, "an iPad says it is a Mac");
  assert.equal(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 }), false);
  assert.equal(isIosDevice({ userAgent: "Mozilla/5.0 (Linux; Android 14; SM-A145F)" }), false);
  assert.equal(isStandalone({ displayStandalone: true }), true);
  assert.equal(isStandalone({ navigatorStandalone: true }), true);
  assert.equal(isStandalone({}), false);
  assert.equal(installOffer({ canPrompt: true, standalone: false, ios: false }), "prompt");
  assert.equal(installOffer({ canPrompt: false, standalone: false, ios: true }), "ios");
  assert.equal(installOffer({ canPrompt: false, standalone: false, ios: false }), null, "a browser with no install of its own");
  assert.equal(installOffer({ canPrompt: true, standalone: true, ios: false }), null, "already running installed");
  assert.equal(installOffer({ canPrompt: false, standalone: false, ios: true, installed: true }), null);
});
