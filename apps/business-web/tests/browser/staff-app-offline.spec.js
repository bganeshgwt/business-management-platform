import { test, expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { account, fixture, signIn } from "../../../../e2e/fixture.mjs";
import { HOST, PREVIEW_PORT, PREVIEW_URL } from "../../../../e2e/servers.mjs";

// The installable staff app working offline, on a captain's phone
// (docs/ARCHITECTURE.md › The offline base, Offline boot, The service worker):
//
//   - the network gone after the captain app opened: the offline mark and
//     strip show, and the tables stay on the screen;
//   - a reload with no network: the captain app opens from this device's
//     copies (the profile, the floor as last read), and a screen that needs
//     the network says so, still signed in;
//   - the production build (vite build, then vite preview on its own port,
//     forwarding the API): the service worker opens the app with no network
//     at all, never keeps the API, offers a new version without reloading by
//     itself, and the captain's switch "Alerts when the app is closed" sends
//     a test alert and a guest's call through the run's API to a pretend push
//     service this spec runs (never a real one); an iPhone not on the Home
//     Screen is shown the steps.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const APP = path.join(ROOT, "apps", "business-web");
const VITE = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const BUILD = path.join(ROOT, "test-results", "staff-app-build");
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const QUICKLY = { timeout: 15_000 };

const heading = (page) => page.getByRole("heading", { level: 1, name: "My tables", exact: true });
const tile = (page, tableNo) => page.getByRole("button", { name: new RegExp(`^Table ${tableNo}:`) });

// Script errors on the page.
function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

// How many snapshots this device keeps (IndexedDB bmp-offline), without ever
// making the database itself.
const snapshotsKept = (page) =>
  page.evaluate(async () => {
    const known = await indexedDB.databases();
    if (!known.some((db) => db.name === "bmp-offline")) return 0;
    return new Promise((resolve) => {
      const request = indexedDB.open("bmp-offline");
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("snapshots")) return resolve(0);
        const count = db.transaction("snapshots").objectStore("snapshots").count();
        count.onsuccess = () => {
          resolve(count.result);
          db.close();
        };
      };
      request.onerror = () => resolve(0);
    });
  });

// The captain app, signed in at `base`, its floor read and kept on the device.
async function openCaptain(page, base) {
  if (base === fixture().urls.staff) {
    await signIn(page, "CAPTAIN");
  } else {
    const { email, password } = account("CAPTAIN");
    await page.goto(`${base}/login`);
    await page.locator('input[autocomplete="username"]').fill(email);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/, { timeout: 30_000 });
  }
  await page.goto(`${base}/captain`);
  await expect(heading(page)).toBeVisible({ timeout: 30_000 });
  const [g1] = fixture().restaurant.captain.tables;
  await expect(tile(page, g1.tableNo)).toBeVisible(QUICKLY);
  await expect.poll(() => snapshotsKept(page), QUICKLY).toBeGreaterThan(0);
}

test("the network gone after the captain app opened: the offline mark shows, and the tables stay", async ({ browser }) => {
  const context = await browser.newContext(PHONE);
  try {
    const page = await context.newPage();
    const problems = watch(page);
    await openCaptain(page, fixture().urls.staff);
    const { tables } = fixture().restaurant.captain;

    await context.setOffline(true);
    await expect(page.locator(".cpt-top .offline-pill")).toHaveAttribute("data-tone", "offline", QUICKLY);
    await expect(page.locator(".cpt-top .offline-pill")).toHaveAttribute("title", /No connection to the server since/);
    await expect(page.locator(".offline-strip")).toContainText("Offline. The tables show the floor as last read", QUICKLY);
    for (const table of tables) {
      await expect(tile(page, table.tableNo)).toBeVisible();
    }
    // The waiting list says nothing is waiting: the captain app sends nothing offline.
    await page.locator(".cpt-top .offline-pill").click();
    const panel = page.getByRole("dialog", { name: /Waiting to send/ });
    await expect(panel).toContainText("Offline since");
    await expect(panel).toContainText("Nothing is waiting.");
    await panel.getByRole("button", { name: "Close" }).click();

    await context.setOffline(false);
    await expect(page.locator(".offline-pill")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".offline-strip")).toHaveCount(0);
    await expect(tile(page, tables[0].tableNo)).toBeVisible();
    expect(problems).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a reload with no network: the captain app opens from this device's copies; another screen says it needs the network", async ({ browser }) => {
  const context = await browser.newContext(PHONE);
  try {
    const page = await context.newPage();
    const problems = watch(page);
    await openCaptain(page, fixture().urls.staff);
    const token = await page.evaluate(() => localStorage.getItem("rmp_token"));

    // The API out of reach (the app's own files still load in development).
    const api = `${fixture().urls.api}/**`;
    await page.route(api, (route) => route.abort("internetdisconnected"));
    await page.reload();
    await expect(heading(page)).toBeVisible(QUICKLY);
    for (const table of fixture().restaurant.captain.tables) {
      await expect(tile(page, table.tableNo)).toBeVisible();
    }
    await expect(page.locator(".offline-strip")).toContainText(/Offline\. The tables show the floor as read (just now|\d+ minutes? ago)/);
    await expect(page.locator(".cpt-top .offline-pill")).toHaveAttribute("data-tone", "offline");
    await expect(page).toHaveURL(/\/captain$/);

    // Any other screen: calmly, it needs the network, and what opens without.
    await page.goto(`${fixture().urls.staff}/`);
    await expect(page.getByRole("heading", { name: "You're offline — this screen needs the network" })).toBeVisible(QUICKLY);
    await expect(page.getByRole("link", { name: "Captain app" })).toHaveAttribute("href", "/captain");
    expect(await page.evaluate(() => localStorage.getItem("rmp_token"))).toBe(token);

    // The network back: the screen opens as usual, still signed in.
    await page.unroute(api);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "You're offline — this screen needs the network" })).toHaveCount(0, { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/login/);
    expect(problems).toEqual([]);
  } finally {
    await context.close();
  }
});

// --- The production build ------------------------------------------------------------

// A pretend push service: records each message and lets the test read it, as
// the phone whose keys it holds would (RFC 8291, the receiving side).
async function pushService() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const phone = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
  const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
  const read = ({ body }) => {
    const salt = body.subarray(0, 16);
    const serverKey = body.subarray(21, 86);
    const ikm = hkdf(Buffer.from(phone.auth, "base64url"), ecdh.computeSecret(serverKey),
      Buffer.concat([Buffer.from("WebPush: info\0"), Buffer.from(phone.p256dh, "base64url"), serverKey]), 32);
    const decipher = crypto.createDecipheriv("aes-128-gcm", hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
      hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12));
    const record = body.subarray(86);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString("utf8"));
  };
  return { endpoint: `http://${HOST}:${server.address().port}/push/captain`, phone, received, read, close: () => new Promise((r) => server.close(r)) };
}

test.describe("the production build", () => {
  test.describe.configure({ mode: "serial" });
  let preview = null;

  const startPreview = async () => {
    preview = spawn(process.execPath, [VITE, "preview", "--outDir", BUILD, "--port", String(PREVIEW_PORT), "--strictPort", "--host", HOST], {
      cwd: APP,
      env: { ...process.env, VITE_API_BASE_URL: "/api", VITE_CUSTOMER_WEB_URL: "same-origin", PREVIEW_API_ORIGIN: new URL(fixture().urls.api).origin },
      stdio: "ignore",
      windowsHide: true,
    });
    await expect.poll(async () => (await fetch(PREVIEW_URL).catch(() => null))?.status ?? 0, { timeout: 60_000 }).toBe(200);
  };

  const stopPreview = async () => {
    if (preview) {
      const stopped = new Promise((resolve) => preview.once("exit", resolve));
      preview.kill();
      await stopped;
      preview = null;
    }
  };

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    // Built as one address serves both apps (GO_LIVE › One address): the API at /api.
    const built = spawnSync(process.execPath, [VITE, "build", "--outDir", BUILD, "--emptyOutDir"], {
      cwd: APP,
      env: { ...process.env, VITE_API_BASE_URL: "/api", VITE_CUSTOMER_WEB_URL: "same-origin" },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(built.status, built.stderr || built.stdout).toBe(0);
    await startPreview();
  });

  test.afterAll(async () => {
    await stopPreview();
  });

  test("the service worker opens the app with no network at all, and never keeps the API", async ({ browser }) => {
    const worker = fs.readFileSync(path.join(BUILD, "sw.js"), "utf8");
    const build = JSON.parse(/^self\.__BMP_BUILD__ = (.*);$/m.exec(worker)[1]);
    expect(build.id).toMatch(/^[0-9a-f]{16}$/);
    expect(build.api).toBe("/api");
    expect(build.files).toContain("/index.html");
    expect(build.files.some((file) => /^\/assets\/index-[\w-]+\.js$/.test(file))).toBe(true);
    expect(build.files.filter((file) => file === "/api" || file.startsWith("/api/"))).toEqual([]);

    const context = await browser.newContext(PHONE);
    try {
      const page = await context.newPage();
      const problems = watch(page);
      await openCaptain(page, PREVIEW_URL);
      // The worker took over this page and keeps this build's copy.
      await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 60_000 }).toBe(true);
      const kept = await page.evaluate(async () => {
        const names = await caches.keys();
        const urls = [];
        for (const name of names) for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
        return { names, urls };
      });
      expect(kept.names).toContain(`bmp-shell-${build.id}`);
      expect(kept.urls.some((url) => url.endsWith("/index.html"))).toBe(true);
      expect(kept.urls.filter((url) => /^\/api(\/|$)/.test(new URL(url).pathname))).toEqual([]);

      // No network at all: the server gone, the browser offline.
      await stopPreview();
      await context.setOffline(true);
      await page.reload();
      await expect(heading(page)).toBeVisible({ timeout: 30_000 });
      await expect(tile(page, fixture().restaurant.captain.tables[0].tableNo)).toBeVisible();
      await expect(page.locator(".offline-strip")).toContainText("Offline. The tables show the floor as read");
      await page.goto(`${PREVIEW_URL}/business-admin`);
      await expect(page.getByRole("heading", { name: "You're offline — this screen needs the network" })).toBeVisible(QUICKLY);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
      if (!preview) await startPreview();
    }
  });

  test("a new version: the bar offers Reload, and never reloads by itself", async ({ browser }) => {
    const context = await browser.newContext(PHONE);
    const worker = path.join(BUILD, "sw.js");
    const original = fs.readFileSync(worker, "utf8");
    try {
      const page = await context.newPage();
      await openCaptain(page, PREVIEW_URL);
      await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 60_000 }).toBe(true);
      await page.evaluate(() => {
        window.__sameDocument = true;
      });

      // A new build goes live: its worker installs beside this one and waits.
      fs.writeFileSync(worker, `${original}\n// A newer build.\n`);
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((registration) => registration.update()));
      const bar = page.locator(".update-bar");
      await expect(bar).toContainText("A new version is ready", { timeout: 60_000 });
      await page.waitForTimeout(3000);
      expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
      await expect(heading(page)).toBeVisible();

      // Reload, pressed: the new worker takes over and the page reloads once.
      const reloaded = page.waitForEvent("load", { timeout: 30_000 });
      await bar.getByRole("button", { name: "Reload", exact: true }).click();
      await reloaded;
      await expect.poll(() => page.evaluate(() => window.__sameDocument === undefined).catch(() => false), { timeout: 30_000 }).toBe(true);
      await expect(heading(page)).toBeVisible(QUICKLY);
      await expect(page.locator(".update-bar")).toHaveCount(0);
      expect(await page.evaluate(() => navigator.serviceWorker.getRegistration().then((registration) => Boolean(registration.waiting)))).toBe(false);
    } finally {
      fs.writeFileSync(worker, original);
      await context.close();
    }
  });

  test("alerts when the app is closed: the switch, a test alert, and a guest's call at the captain's table", async ({ browser }) => {
    const service = await pushService();
    const context = await browser.newContext({ ...PHONE });
    await context.grantPermissions(["notifications"], { origin: PREVIEW_URL });
    // The browser's push service, pretended: the subscription this phone would
    // get points at the pretend service and carries its keys.
    await context.addInitScript(({ endpoint, p256dh, auth }) => {
      const made = () => sessionStorage.getItem("e2e-push") === "on";
      const subscription = (key) => ({
        endpoint,
        expirationTime: null,
        options: { applicationServerKey: key, userVisibleOnly: true },
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        unsubscribe: async () => {
          sessionStorage.removeItem("e2e-push");
          return true;
        },
      });
      window.PushManager.prototype.subscribe = async function subscribe(options) {
        sessionStorage.setItem("e2e-push", "on");
        return subscription(options.applicationServerKey);
      };
      window.PushManager.prototype.getSubscription = async function getSubscription() {
        return made() ? subscription(null) : null;
      };
    }, { endpoint: service.endpoint, ...service.phone });
    const [g1] = fixture().restaurant.captain.tables;
    let callId = null;
    try {
      const page = await context.newPage();
      const problems = watch(page);
      await openCaptain(page, PREVIEW_URL);

      // Off on this phone: a calm line says what that means.
      const banner = page.locator(".cpt-push-banner");
      await expect(banner).toContainText("Alerts are off while the app is closed", QUICKLY);
      await banner.getByRole("button", { name: "Turn on" }).click();
      const sheet = page.getByRole("dialog", { name: "Alerts" });
      await expect(sheet.locator("[data-push-status]")).toHaveAttribute("data-push-status", "off");
      await sheet.getByRole("switch", { name: /Alerts when the app is closed/ }).click({ force: true });
      await expect(sheet.locator("[data-push-status]")).toHaveAttribute("data-push-status", "on", QUICKLY);
      await expect(sheet).toContainText("On. Guests' calls and food ready at your tables reach this phone even when the app is closed.");

      await sheet.getByRole("button", { name: "Send a test alert" }).click();
      await expect.poll(() => service.received.length, QUICKLY).toBe(1);
      expect(service.read(service.received[0])).toMatchObject({ title: "Test alert", url: "/captain", tag: "test" });
      expect(service.received[0].headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B[\w-]{86}$/);
      await sheet.getByRole("button", { name: "Close" }).click();
      await expect(banner).toHaveCount(0);

      // A guest at G1, the captain's own table, asks for water: the closed phone hears of it.
      const call = await fetch(`${fixture().urls.api}/public/tables/${g1.qrToken}/calls`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "water" }),
      });
      expect([200, 201]).toContain(call.status);
      callId = (await call.json()).data.id;
      await expect.poll(() => service.received.length, { timeout: 20_000 }).toBe(2);
      const alert = service.read(service.received[1]);
      expect(alert).toMatchObject({ title: `Table ${g1.tableNo} asked for water`, url: "/captain/calls", tag: `table-${g1.id}`, kind: "call" });
      expect(service.received[1].headers.ttl).toBe("120");
      expect(service.received[1].headers.urgency).toBe("high");

      // Off again: this phone gets nothing more.
      await page.getByRole("button", { name: /More for/ }).click();
      await page.getByRole("menuitem", { name: "Alerts" }).click();
      await sheet.getByRole("switch", { name: /Alerts when the app is closed/ }).click({ force: true });
      await expect(sheet.locator("[data-push-status]")).toHaveAttribute("data-push-status", "off", QUICKLY);
      expect(problems).toEqual([]);
    } finally {
      // Put back: the call closed, and no subscription left pointing at the pretend service.
      const captain = account("CAPTAIN");
      const session = await (await fetch(`${fixture().urls.api}/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: captain.email, password: captain.password }),
      })).json();
      const asCaptain = { Authorization: `Bearer ${session.data.token}`, "Content-Type": "application/json" };
      if (callId) {
        await fetch(`${fixture().urls.api}/table-requests/${callId}/done`, { method: "POST", headers: asCaptain });
      }
      await fetch(`${fixture().urls.api}/push/subscriptions`, { method: "DELETE", headers: asCaptain, body: JSON.stringify({ endpoint: service.endpoint }) });
      await context.close();
      await service.close();
    }
  });

  test("an iPhone not on the Home Screen is shown the steps first", async ({ browser }) => {
    const context = await browser.newContext({
      ...PHONE,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    });
    try {
      const page = await context.newPage();
      await openCaptain(page, PREVIEW_URL);
      const banner = page.locator(".cpt-push-banner");
      await expect(banner).toContainText("Add it to the Home Screen to get them", QUICKLY);
      await banner.getByRole("button", { name: "Show me how" }).click();
      const sheet = page.getByRole("dialog", { name: "Alerts" });
      await expect(sheet.locator("[data-push-status]")).toHaveAttribute("data-push-status", "ios-install");
      await sheet.getByRole("button", { name: "Add the app to the Home Screen" }).click();
      const steps = page.getByRole("dialog", { name: "Add Captain app to your Home Screen" });
      await expect(steps).toContainText("Add to Home Screen");
      await expect(steps).toContainText("only from the app on the Home Screen");
      // The ⋯ menu offers the same steps as installing.
      await steps.getByRole("button", { name: "Done" }).click();
      await sheet.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: /More for/ }).click();
      await expect(page.getByRole("menuitem", { name: "Install the captain app" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
