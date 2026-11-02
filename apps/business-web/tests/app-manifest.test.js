import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { appFor, INSTALLABLE_APPS } from "../src/services/appManifest.js";

// The installable apps (services/appManifest.js): a manifest per workspace in
// public/manifests, its icons in public/icons (drawn by
// tools/render-app-icons.mjs), the brand's colours from the tokens, and which
// app a screen installs (hooks/useAppManifest.js).

const PUBLIC = new URL("../public/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path.replace(/^\//, ""), PUBLIC));
const manifestOf = (app) => JSON.parse(read(INSTALLABLE_APPS[app].manifest).toString("utf8"));

// A PNG's width and height, from its header.
const pngSize = (bytes) => {
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", "a PNG file");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

// The tokens the colours come from (packages/ui base.css): the brand and the page.
const tokens = fs.readFileSync(new URL("../../../packages/ui/src/styles/base.css", import.meta.url), "utf8");
const token = (name) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(tokens)[1];

test("a manifest per workspace: its name, start, scope, standalone, the brand's colours", () => {
  assert.deepEqual(Object.keys(INSTALLABLE_APPS).sort(), ["captain", "clinic", "counter", "kitchen", "lab", "staff"]);
  const files = fs.readdirSync(new URL("manifests/", PUBLIC)).sort();
  assert.deepEqual(files, Object.keys(INSTALLABLE_APPS).map((app) => `${app}.webmanifest`).sort(), "one file for each app, and no other");

  for (const [app, entry] of Object.entries(INSTALLABLE_APPS)) {
    const manifest = manifestOf(app);
    assert.ok(manifest.name && manifest.short_name && manifest.description, app);
    assert.ok(manifest.short_name.length <= 12, `${app}: a short name fits under an icon`);
    assert.equal(manifest.display, "standalone", app);
    assert.equal(manifest.start_url, entry.start, app);
    assert.ok(manifest.start_url.startsWith(manifest.scope), `${app}: it starts inside its scope`);
    assert.equal(manifest.id, manifest.scope, `${app}: an id of its own, so each installs on its own`);
    assert.equal(manifest.theme_color, token("primary"), `${app}: the brand's colour`);
    assert.equal(manifest.background_color, token("bg"), `${app}: the page's colour behind the splash`);
    assert.equal(entry.manifest, `/manifests/${app}.webmanifest`);
  }

  assert.equal(manifestOf("captain").scope, "/captain");
  assert.equal(manifestOf("counter").start_url, "/business-admin", "opens the business used last");
  assert.equal(new Set(Object.keys(INSTALLABLE_APPS).map((app) => manifestOf(app).id)).size, 6, "six ids");
});

test("icons: 192 and 512, a maskable one, and the iPhone's, each its own size; the notification's badge", () => {
  for (const [app, entry] of Object.entries(INSTALLABLE_APPS)) {
    const icons = manifestOf(app).icons;
    const by = (purpose, size) => icons.find((icon) => icon.purpose === purpose && icon.sizes === `${size}x${size}`);
    for (const [purpose, size] of [["any", 192], ["any", 512], ["maskable", 512]]) {
      const icon = by(purpose, size);
      assert.ok(icon, `${app}: a ${purpose} ${size} px icon`);
      assert.equal(icon.type, "image/png");
      assert.deepEqual(pngSize(read(icon.src)), { width: size, height: size }, icon.src);
    }
    assert.deepEqual(pngSize(read(entry.icon)), { width: 180, height: 180 }, entry.icon);
  }
  assert.deepEqual(pngSize(read("/icons/badge-96.png")), { width: 96, height: 96 });
});

test("which app a screen installs", () => {
  assert.equal(appFor("/captain"), "captain");
  assert.equal(appFor("/captain/calls?x=1"), "captain");
  assert.equal(appFor("/captainish"), "staff");
  assert.equal(appFor("/kitchen"), "kitchen");
  assert.equal(appFor("/clinic/4/patients"), "clinic");
  assert.equal(appFor("/lab/4/worklist"), "lab");
  assert.equal(appFor("/business-admin/4/counter"), "counter");
  assert.equal(appFor("/business-admin/4/sales"), "staff");
  assert.equal(appFor("/"), "staff");
  assert.equal(appFor(undefined), "staff");
});

test("the page starts with the staff app's manifest, its iPhone icon and the brand's colour", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifests\/staff\.webmanifest" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/staff-apple-180\.png" \/>/);
  assert.match(html, new RegExp(`<meta name="theme-color" content="${token("primary")}"`));
  // Each workspace's layout points the page at its own manifest.
  const calls = {
    "../src/workspaces/captain/CaptainLayout.jsx": 'useAppManifest("captain")',
    "../src/layouts/BusinessWorkspace.jsx": "useAppManifest(kind)",
    "../src/layouts/AppLayout.jsx": "useAppManifest(appFor(pathname))",
  };
  for (const [file, call] of Object.entries(calls)) {
    assert.ok(fs.readFileSync(new URL(file, import.meta.url), "utf8").includes(call), `${file} calls ${call}`);
  }
});
