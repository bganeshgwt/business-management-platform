import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { appFor, installedApp, INSTALLABLE_APPS, RESTAURANT_MARK } from "../src/services/appManifest.js";

// The installable apps (services/appManifest.js): a manifest per workspace in
// public/manifests, its icons in public/icons (both written by
// tools/render-app-icons.mjs), the brand's colours from the tokens, which app
// a screen installs (hooks/useAppManifest.js), and the marks the staff app
// wears: the restaurant's, and each a business may have.

const PUBLIC = new URL("../public/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path.replace(/^\//, ""), PUBLIC));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const manifestOf = (app, mark = null) => json(installedApp(app, mark).manifest);

// A PNG's width and height, from its header.
const pngSize = (bytes) => {
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", "a PNG file");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

// The tokens the colours come from (packages/ui base.css): the brand and the page.
const tokens = fs.readFileSync(new URL("../../../packages/ui/src/styles/base.css", import.meta.url), "utf8");
const token = (name) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(tokens)[1];

// The marks a business may have (packages/ui/src/businessIcons.jsx), as written there.
const businessIcons = fs.readFileSync(new URL("../../../packages/ui/src/businessIcons.jsx", import.meta.url), "utf8");
const BUSINESS_ICONS = [.../BUSINESS_ICONS = \[([\s\S]*?)\];/.exec(businessIcons)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const STAFF_MARKS = [RESTAURANT_MARK, ...BUSINESS_ICONS];

test("a manifest per workspace: its name, start, scope, standalone, the brand's colours", () => {
  assert.deepEqual(Object.keys(INSTALLABLE_APPS).sort(), ["captain", "clinic", "counter", "kitchen", "lab", "sales", "staff"]);
  const files = fs.readdirSync(new URL("manifests/", PUBLIC), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  assert.deepEqual(files, Object.keys(INSTALLABLE_APPS).map((app) => `${app}.webmanifest`).sort(), "one file for each app, and no other");

  for (const [app, entry] of Object.entries(INSTALLABLE_APPS)) {
    const manifest = manifestOf(app);
    assert.equal(manifest.name, entry.name, app);
    assert.equal(manifest.short_name, entry.short, app);
    assert.equal(manifest.description, entry.description, app);
    assert.ok(manifest.short_name.length <= 12, `${app}: a short name fits under an icon`);
    assert.equal(manifest.display, "standalone", app);
    assert.equal(manifest.start_url, entry.start, app);
    assert.ok(manifest.start_url.startsWith(manifest.scope), `${app}: it starts inside its scope`);
    assert.equal(manifest.id, manifest.scope, `${app}: an id of its own, so each installs on its own`);
    assert.equal(manifest.theme_color, token("primary"), `${app}: the brand's colour`);
    assert.equal(manifest.background_color, token("bg"), `${app}: the page's colour behind the splash`);
    assert.equal(installedApp(app).manifest, `/manifests/${app}.webmanifest`);
  }

  assert.equal(manifestOf("captain").scope, "/captain");
  assert.equal(manifestOf("counter").start_url, "/business-admin", "opens the business used last");
  assert.equal(new Set(Object.keys(INSTALLABLE_APPS).map((app) => manifestOf(app).id)).size, 7, "seven ids");
});

test("the staff app wears the restaurant's mark or a business's: one app, its own icons for each mark", () => {
  const files = fs.readdirSync(new URL("manifests/staff/", PUBLIC)).sort();
  assert.deepEqual(files, STAFF_MARKS.map((mark) => `${mark}.webmanifest`).sort(), "one for each mark a business may have, and the restaurant's");
  const staff = manifestOf("staff");

  for (const mark of STAFF_MARKS) {
    const manifest = manifestOf("staff", mark);
    // The same app, so a phone keeps one staff app, wearing the mark it was installed with.
    for (const key of ["id", "name", "short_name", "description", "start_url", "scope", "display", "theme_color", "background_color"]) {
      assert.equal(manifest[key], staff[key], `${mark}: ${key}`);
    }
    for (const icon of manifest.icons) assert.ok(icon.src.startsWith(`/icons/staff/${mark}-`), `${mark}: ${icon.src}`);
  }

  // Not the restaurant's name, not a cloche, where no business is open.
  assert.equal(staff.name, "Staff app");
  assert.ok(staff.icons.every((icon) => !icon.src.includes(RESTAURANT_MARK)));
});

test("icons: 192 and 512, a maskable one, and the iPhone's, each its own size; the notification's badge", () => {
  const wearing = [...Object.keys(INSTALLABLE_APPS).map((app) => [app, null]), ...STAFF_MARKS.map((mark) => ["staff", mark])];
  for (const [app, mark] of wearing) {
    const icons = manifestOf(app, mark).icons;
    const by = (purpose, size) => icons.find((icon) => icon.purpose === purpose && icon.sizes === `${size}x${size}`);
    for (const [purpose, size] of [["any", 192], ["any", 512], ["maskable", 512]]) {
      const icon = by(purpose, size);
      assert.ok(icon, `${app} ${mark || ""}: a ${purpose} ${size} px icon`);
      assert.equal(icon.type, "image/png");
      assert.deepEqual(pngSize(read(icon.src)), { width: size, height: size }, icon.src);
    }
    assert.deepEqual(pngSize(read(installedApp(app, mark).icon)), { width: 180, height: 180 }, installedApp(app, mark).icon);
  }
  // Flat tiles: every icon stays a few kilobytes.
  for (const mark of STAFF_MARKS) assert.ok(read(`/icons/staff/${mark}-512.png`).length < 40_000, `${mark}: a small file`);
  assert.deepEqual(pngSize(read("/icons/badge-96.png")), { width: 96, height: 96 });
});

test("which app a screen installs, and what the staff app wears there", () => {
  assert.equal(appFor("/captain"), "captain");
  assert.equal(appFor("/captain/calls?x=1"), "captain");
  assert.equal(appFor("/captainish"), "staff");
  assert.equal(appFor("/kitchen"), "kitchen");
  assert.equal(appFor("/clinic/4/patients"), "clinic");
  assert.equal(appFor("/lab/4/worklist"), "lab");
  assert.equal(appFor("/business-admin/4/counter"), "counter");
  assert.equal(appFor("/business-admin/4/sales"), "staff");
  assert.equal(appFor("/sales/4/shops"), "sales");
  assert.equal(appFor("/salesperson"), "staff");
  assert.equal(appFor("/"), "staff");
  assert.equal(appFor(undefined), "staff");

  assert.deepEqual([installedApp("staff", "dumbbell").manifest, installedApp("staff", "dumbbell").icon],
    ["/manifests/staff/dumbbell.webmanifest", "/icons/staff/dumbbell-apple-180.png"]);
  assert.equal(installedApp("staff").manifest, "/manifests/staff.webmanifest", "the product's own");
  assert.equal(installedApp("clinic", "stethoscope").manifest, "/manifests/clinic.webmanifest", "a workspace's app wears its own");
  assert.equal(installedApp("nowhere").key, "staff");
});

test("the page starts with the staff app's manifest, its iPhone icon, the brand's colour and the product's tab icon", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifests\/staff\.webmanifest" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/staff-apple-180\.png" \/>/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
  assert.match(html, new RegExp(`<meta name="theme-color" content="${token("primary")}"`));
  // Each workspace's layout points the page at its own manifest, wearing the mark of where it is.
  const calls = {
    "../src/workspaces/captain/CaptainLayout.jsx": 'useAppManifest("captain", { icon: RESTAURANT_MARK',
    "../src/workspaces/sales/SalesLayout.jsx": 'useAppManifest("sales", { icon: look?.icon',
    "../src/layouts/BusinessWorkspace.jsx": "useAppManifest(kind, business ?",
    "../src/layouts/AppLayout.jsx": "useAppManifest(appFor(pathname), place)",
  };
  for (const [file, call] of Object.entries(calls)) {
    assert.ok(fs.readFileSync(new URL(file, import.meta.url), "utf8").includes(call), `${file} calls ${call}`);
  }
});

test("both apps' tab icon is the product's mark, not a tool's logo", () => {
  const icon = fs.readFileSync(new URL("../../../packages/ui/src/drawings.jsx", import.meta.url), "utf8");
  const brand = /\n {2}brand: \(\s*<>([\s\S]*?)<\/>/.exec(icon)[1].replace(/\s+/g, " ").trim();
  const staff = read("/favicon.svg").toString("utf8");
  const guests = fs.readFileSync(new URL("../../customer-web/src/favicon.svg", import.meta.url), "utf8");
  assert.equal(guests, staff, "the same mark on both apps");
  assert.ok(staff.includes(brand), "the product's mark (drawings.jsx brand)");
  assert.doesNotMatch(staff, /vite|#646cff|#bd34fe/i);
});
