import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { businessSections } from "../src/services/businessNav.js";
import { WORKSPACE_APPS } from "../src/services/workspaceApps.js";
import { INSTALLABLE_APPS } from "../src/services/appManifest.js";
import { defaultT } from "./helpers/defaultWords.js";

// The look's data kept in step (docs/ARCHITECTURE.md › Words and looks): the
// icon set's names (packages/ui drawings.jsx, the screens', and menuIcons.jsx,
// the menu's: one set of names), the marks a business may have, the accents'
// colours, and every mark the menus and the screens name. A name neither set
// draws is a blank square on screen.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

// The names an icon set draws, from its source (no JSX here).
const namesOf = (file, list) => {
  const source = read(file);
  const start = source.indexOf(`const ${list} = {`);
  const body = source.slice(start, source.indexOf("\n};", start));
  return new Set([...body.matchAll(/\n {2}(?:"([^"]+)"|([A-Za-z][\w-]*)): /g)].map((match) => match[1] || match[2]));
};
const SCREENS = namesOf("packages/ui/src/drawings.jsx", "PATHS");
const MENU = namesOf("packages/ui/src/menuIcons.jsx", "MENU_PATHS");
const drawn = (name) => SCREENS.has(name) || MENU.has(name);

const ui = read("packages/ui/src/businessIcons.jsx");
const BUSINESS_ICONS = [.../BUSINESS_ICONS = \[([\s\S]*?)\];/.exec(ui)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const BUSINESS_ACCENTS = Object.fromEntries([.../BUSINESS_ACCENTS = \{([\s\S]*?)\};/.exec(ui)[1].matchAll(/(\w+): "(#[0-9a-f]{6})"/g)].map((match) => [match[1], match[2]]));

test("every mark a business may have is drawn by the screens' set, once", () => {
  assert.equal(new Set(BUSINESS_ICONS).size, BUSINESS_ICONS.length);
  assert.deepEqual(BUSINESS_ICONS.filter((name) => !SCREENS.has(name)), []);
  // The product's own mark, and the restaurant's.
  assert.ok(SCREENS.has("brand") && SCREENS.has("cloche"));
});

test("the accents' strong colours are the staff app's light ones, and the server's list", () => {
  const css = read("apps/business-web/src/styles/app/accents.css");
  const light = Object.fromEntries([...css.slice(0, css.indexOf("@media")).matchAll(/\.type-accent-(\w+) \{ --accent: (#[0-9a-f]{6}); \}/g)]
    .map((match) => [match[1], match[2]]));
  assert.deepEqual(BUSINESS_ACCENTS, light);
  const server = /const ACCENTS = \[([^\]]*)\]/.exec(read("backend/src/modules/platform/services/businessTypes.service.js"))[1];
  assert.deepEqual([...server.matchAll(/'(\w+)'/g)].map((match) => match[1]).sort(), Object.keys(BUSINESS_ACCENTS).sort());
});

test("every menu entry's mark is drawn: each business type's and the restaurant's", () => {
  const blank = businessSections("grocery", defaultT).flatMap((group) => group.links).filter((link) => !drawn(link.icon)).map((link) => `${link.section}: ${link.icon}`);
  const layout = read("apps/business-web/src/layouts/AppLayout.jsx");
  const start = layout.indexOf("[", layout.indexOf("const NAV_SECTIONS = ["));
  const restaurant = vm.runInNewContext(layout.slice(start, layout.indexOf("\n];", start) + 2));
  blank.push(...restaurant.flatMap((section) => section.links).filter((link) => !drawn(link.icon)).map((link) => `${link.to}: ${link.icon}`));
  assert.deepEqual(blank, []);
});

test("no shop, clinic or gym menu entry wears a restaurant's or a bin's mark", () => {
  const icons = Object.fromEntries(businessSections("grocery", defaultT).flatMap((group) => group.links).map((link) => [link.section, link.icon]));
  // The restaurant's bowl, chef's hat and scooter; the restaurant's waste bin; a banknote for a queue.
  for (const [section, wrong] of [["products", "products"], ["drug-master", "products"], ["clinic-drugs", "products"], ["agri-crops", "products"],
    ["garage-parts", "products"], ["lab-orders", "inventoryInsights"], ["retail-reports", "inventoryInsights"], ["variant-reports", "inventoryInsights"],
    ["salon-reports", "inventoryInsights"], ["weight-reports", "inventoryInsights"], ["clinic-queue", "collection"], ["processing", "kitchen"], ["vehicles", "deliveries"]]) {
    assert.notEqual(icons[section], wrong, section);
  }
});

test("the workspaces' and the installable apps' marks are drawn", () => {
  for (const [kind, plan] of Object.entries(WORKSPACE_APPS)) assert.ok(SCREENS.has(plan.icon), `${kind}: ${plan.icon}`);
  for (const [app, entry] of Object.entries(INSTALLABLE_APPS)) assert.ok(SCREENS.has(entry.mark), `${app}: ${entry.mark}`);
});

// Every literal mark the screens hand to the shared Icon: <Icon name="…">, and
// icon="…" or icon: "…" in a file that draws with it (a page header, a
// section, a tile, an action menu, a tab), in both apps. A file with an icon
// set of its own (a guest's table page) keeps its own names, and so do the
// table calls' words, drawn by the table requests page's own set.
const OWN_SET = ["apps/business-web/src/modules/restaurant/orders/services/tableRequestWords.js"];
function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.jsx?$/.test(entry.name)) yield full;
  }
}

test("every mark a screen names is drawn", () => {
  const blank = [];
  for (const dir of ["apps/business-web/src", "apps/customer-web/src"]) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const name = path.relative(ROOT, file).split(path.sep).join("/");
      const text = fs.readFileSync(file, "utf8");
      // An icon set of its own (function Icon / const Icon in the file) draws its own names.
      if (OWN_SET.includes(name) || /\n(?:function|const) (?:Icon|NotificationIcon)\b/.test(text)) continue;
      for (const match of text.matchAll(/(?:<Icon\b[^>]*?\bname=|\bicon[=:]\s*\{?\s*)["']([a-z][A-Za-z0-9-]*)["']/g)) {
        if (!drawn(match[1])) blank.push(`${name}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(blank, []);
});
