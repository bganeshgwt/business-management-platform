import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { businessMenu } from '../src/services/businessNav.js';
import { restaurantMenu } from '../src/services/restaurantWorkspace.js';

// Help texts, the server's messages and code comments send people to a screen
// by its menu path ("Settings → Business hours"). When the menus were
// regrouped, some kept the old names. These checks find every path written in
// the code and check it against the menus as they are drawn.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const APP = path.join(ROOT, 'apps/business-web/src');
const read = (file) => fs.readFileSync(path.join(APP, file), 'utf8');

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.jsx?$/.test(entry.name)) yield full;
  }
}

// The screens, the guests' site, the shared packages and the server, as a
// reader sees them: &amp; is &, and a sentence broken over lines (or over
// comment lines) is one line.
const SOURCES = ['apps/business-web/src', 'apps/customer-web/src', 'packages', 'backend/src']
  .flatMap((dir) => [...sourceFiles(path.join(ROOT, dir))])
  .map((file) => ({
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8').replaceAll('&amp;', '&').replace(/\s*\n\s*(?:\/\/|\*|--)?\s*/g, ' '),
  }));

// Old names, and where the place is now. Each is checked with either arrow.
const RETIRED = [
  ['Operations → Business day', 'Daily work → Business day'],
  ['Restaurant → ', 'under Settings (Business hours, GST and invoice)'],
  ['Inventory → ', 'Stock → Items & stock'],
  ['Users → Roles', 'Users & access → Roles & permissions'],
  ['Settings → Stock & purchasing', 'Stock → Stock & purchasing settings'],
  ['Tables → Floor plan', 'Tables & QR'],
  ['Stock › Items ›', 'Stock › Items & stock ›'],
  ['Dues › ', 'Dues & accounts › Advances'],
  ['Purchasing → ', 'Purchases & suppliers → Returns & payments'],
  ['Business day → Drawers)', 'Business day → Drawers & cash'],
  ['Service settings › POS', 'Service settings › Orders the POS takes'],
  ['Settings → GSTIN', 'Settings → GST and invoice'],
  ['Business settings › Modules', 'Settings › Business tools'],
  ['Lab › ', 'Lab orders › Tests & panels'],
  ['My profile › PIN', 'My profile › Personal PIN'],
  ['Products › Units & pack sizes', 'Settings › Units & pack sizes'],
  ['› Scale codes', '› Weighing-scale codes'],
  ['Floor → Captain sections', 'Tables & QR → Captain sections'],
  ['Kitchen display → Stations)', 'Kitchen display → Stations & routing'],
];
const eitherArrow = (name) => [...new Set([name.replaceAll('›', '→'), name.replaceAll('→', '›')])];

test('menu names retired when the menus were regrouped do not come back', () => {
  const found = [];
  for (const { file, text } of SOURCES) {
    for (const [old, now] of RETIRED) {
      for (const name of eitherArrow(old)) if (text.includes(name)) found.push(`${file} says "${name.trim()}": it is ${now} now`);
    }
  }
  assert.deepEqual(found, []);
});

// The menus as the staff app draws them, for someone who may open everything:
// the restaurant's (its list of links is plain data inside the layout) and
// each kind of shop's. A menu is kept as places: its groups, the areas in each
// and each area's pages.
const layout = read('layouts/AppLayout.jsx');
const listStart = layout.indexOf('[', layout.indexOf('const NAV_SECTIONS = ['));
const NAV_SECTIONS = vm.runInNewContext(layout.slice(listStart, layout.indexOf('\n];', listStart) + 2));
const SHOP_TYPES = ['grocery', 'supermarket', 'wholesale', 'fashion', 'electronics', 'pharmacy', 'books', 'salon', 'healthcare', 'meat', 'weight_retail',
  'general_retail', 'hardware', 'agri_inputs', 'optical', 'garage', 'jewellery', 'fuel_station', 'memberships', 'laundry', 'rentals', 'lodging'];
const placesOf = (groups, pagesOf) => groups.map((group) => ({
  title: group.title,
  areas: group.links.map((link) => ({ label: link.label, pages: pagesOf(link) })),
}));
const RESTAURANT = placesOf(restaurantMenu(NAV_SECTIONS), (link) => (link.related || [link]).map((page) => page.label));
const PLATFORM = RESTAURANT.filter((group) => group.title === 'Platform');
const shopMenu = (type, can = () => true) => placesOf(businessMenu(1, type, can, () => true), (link) => link.pages.map((page) => page.label));

// What a path may name on a page, by the page's name: its tabs, sections and
// buttons. Where the page lists them in code ({ id | key | value, label } or a
// card's title="…"), they are read from it.
const listed = (file) => [...read(file).matchAll(/\{ (?:id|key|value): "[\w-]+", label: "([^"]+)"/g)].map((match) => match[1]);
const titled = (file) => [...read(file).matchAll(/title="([^"{}]+)"/g)].map((match) => match[1]);
const SHARED_PARTS = { 'My profile': titled('modules/access/pages/ProfilePage.jsx') };
const RESTAURANT_PARTS = {
  ...SHARED_PARTS,
  Settings: listed('modules/restaurant/setup/pages/RestaurantSettingsPage.jsx'),
  'Service settings': listed('modules/restaurant/setup/pages/ServiceSettingsPage.jsx'),
  // The drawers tab is "Cash in & out" while Cash drawers is off.
  'Business day': [...listed('modules/restaurant/business-day/pages/BusinessDayPage.jsx'), 'Drawers & cash', 'Cash in & out'],
  Deliveries: listed('modules/restaurant/deliveries/pages/DeliveriesPage.jsx'),
  'Dues & accounts': listed('modules/restaurant/billing/pages/DuesPage.jsx'),
  'Discounts & offers': listed('modules/restaurant/billing/pages/DiscountsPage.jsx'),
  'Items & stock': [...listed('modules/restaurant/inventory/pages/InventoryItemsPage.jsx'), 'Stores', 'Units'],
  'Waste & reorder': listed('modules/restaurant/inventory/pages/InventoryInsightsPage.jsx'),
  Wastage: ['Dishes wasted'],
  Reports: listed('modules/restaurant/reports/pages/ReportsPage.jsx'),
  Users: listed('modules/access/pages/UsersPage.jsx'),
  Orders: ['Open'],
  'Kitchen display': ['Stations & routing'],
  Reservations: ['Online requests'],
  Products: ['Prices & outlets', 'Print menu', 'Sizes & add-ons'],
  'Tables & QR': ['Captain sections'],
};
const SHOP_PARTS = {
  ...SHARED_PARTS,
  Settings: listed('modules/business/core/pages/SettingsPage.jsx'),
  // The same page by its heading, with its cards' titles.
  'Business settings': [...listed('modules/business/core/pages/SettingsPage.jsx'), ...titled('modules/business/core/pages/SettingsPage.jsx')],
  'Barcode labels': titled('modules/business/retail/pages/LabelsPage.jsx'),
  Categories: titled('modules/business/core/pages/CategoriesPage.jsx'),
  'Stylists & services': listed('modules/business/salon/pages/SalonSetupPage.jsx'),
  'Staff & access': ['New staff login', 'Give access'],
  Warranties: ['Register a warranty'],
};
const MENUS = {
  restaurant: { menus: [RESTAURANT], parts: RESTAURANT_PARTS },
  shop: { menus: SHOP_TYPES.map((type) => [...shopMenu(type), ...PLATFORM]), parts: SHOP_PARTS },
};
// Which menus a file's paths are about: the restaurant's, the shops', or (for
// shared code) either. The shops' settings page also shows a restaurant's
// feature switches.
const BOTH = ['apps/business-web/src/modules/business/core/pages/SettingsPage.jsx'];
const contextsOf = (file) => (BOTH.includes(file) ? ['restaurant', 'shop']
  : /\/restaurant\//.test(file) ? ['restaurant'] : /\/business\//.test(file) ? ['shop'] : ['restaurant', 'shop']);
// Arrows that are not menu paths: Excel's menus, a column heading, an example
// of nested categories and a few steps of a process.
const NOT_MENU = ['File', 'Save As', 'Download', 'From', 'Staples', 'Rice', 'Customer', 'Draft', 'Waiting'];

// The names that may come after a place in a menu: the areas of a group, the
// pages of an area, and the parts of a page (an area opens on its first page).
// null when the menu has no such place.
function nextNames(menu, parts, place) {
  const group = menu.find((g) => g.title === place);
  if (group) return group.areas.map((area) => area.label);
  const area = menu.flatMap((g) => g.areas).find((a) => a.label === place);
  const isPage = menu.some((g) => g.areas.some((a) => a.pages.includes(place)));
  if (!area && !isPage && !parts[place]) return null;
  return [...(area ? area.pages : []), ...(parts[area ? area.pages[0] : place] || []), ...(parts[place] || [])];
}

// Every "A → B" or "A › B" in the code, with the place A it starts from (the
// longest run of words before the arrow that is a place) and what comes after.
function* menuPaths() {
  for (const { file, text } of SOURCES) {
    const menus = contextsOf(file).map((context) => MENUS[context]);
    for (const match of text.matchAll(/([A-Za-z&'’][A-Za-z&'’ ]{0,60}) ([→›]) (?=\S)/g)) {
      const words = match[1].trim().split(' ');
      const after = text.slice(match.index + match[0].length);
      const said = after.split(/[.,;:()"'`<>{}—]| [→›] /)[0].trim();
      let place = null;
      let next = [];
      for (let count = Math.min(5, words.length); count >= 1 && !place; count -= 1) {
        const name = words.slice(-count).join(' ');
        if (NOT_MENU.includes(name)) place = name;
        for (const { menus: list, parts } of menus) {
          for (const menu of list) {
            const names = nextNames(menu, parts, name);
            if (names) { place = name; next.push(...names); }
          }
        }
      }
      yield { file, words, arrow: match[2], after, said, place, next };
    }
  }
}

test('every menu path in the code leads to a place on the menus as drawn', () => {
  const lost = [];
  let checked = 0;
  for (const { file, words, arrow, after, said, place, next } of menuPaths()) {
    const last = words.at(-1);
    // Code names (BusinessAdminRoutes › OverviewSheet) and prose that only
    // uses an arrow ("todo → in progress") are not menu paths.
    if (/[a-z][A-Z]/.test(last) || (!place && !/^[A-Z]/.test(last))) continue;
    if (NOT_MENU.includes(place)) continue;
    checked += 1;
    if (!place) {
      lost.push(`${file}: "${last} ${arrow} ${said}" starts at "${last}", which is no place on the menus`);
      continue;
    }
    // Next: a place in it, written in full or shortened ("Till lock" for "Till
    // lock & sign-in"); an instruction ("open a bill") or a name put in by the
    // code ({kind…}) is taken as it is.
    const leads = /^[^A-Z]/.test(after) || next.some((name) => after.startsWith(name) || (said.length >= 3 && name.startsWith(said)));
    if (!leads) lost.push(`${file}: "${place} ${arrow} ${said}": no "${said}" in ${place}`);
  }
  assert.ok(checked > 60, `only ${checked} menu paths found: the search is broken`);
  assert.deepEqual(lost, [], 'Point these at where the place is now');
});

// The shops' Settings area keeps its name for someone who may open only some
// of its pages, so "Settings › Units & pack sizes" holds for a stock keeper.
test("the shops' Settings area keeps its name for everyone who may open a page in it", () => {
  const renamed = [];
  for (const type of SHOP_TYPES) {
    const settingsPages = shopMenu(type).flatMap((group) => group.areas).find((area) => area.label === 'Settings').pages;
    for (const permission of ['settings.view', 'catalog.view', 'appointments.view']) {
      const areas = shopMenu(type, (code) => code === permission).flatMap((group) => group.areas);
      const settings = areas.find((area) => area.pages.some((page) => settingsPages.includes(page)));
      if (settings && settings.label !== 'Settings') renamed.push(`${type}, with only ${permission}: "${settings.label}"`);
    }
  }
  assert.deepEqual(renamed, []);
});
