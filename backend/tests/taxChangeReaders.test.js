const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// GST rates by date (migration 1791973000000): a change takes effect in the
// database, lazily, before anything reads an item's rate. An item's rate is
// then read from the item, as it always was, so a reader is right only when
// it runs behind one of the places that apply due changes first. These checks
// fail when a file starts (or stops) reading or writing a GST rate column, so
// whoever adds one says how it gets the rate in force on its own date, and
// when a gate is taken away.

const SRC = path.resolve(__dirname, "../src");
const read = (file) => fs.readFileSync(path.join(SRC, file), "utf8");

const HOW = {
  gate: "a shop's request: opened through access.open (the routes' context), which applies due changes first",
  posting: "inside postDocument, after onPosting applied due changes under the business's lock",
  menu: "a restaurant's menu screens and guests' menus: behind the menu gate (menu.routes.js, tableRequest menuFor)",
  order: "a restaurant's order lines: priced by priceLines for the order's own business day",
  lodging: "a room night's slab, which its value decides from the two slabs of the lodging settings",
  stored: "a document's, order's or booking's own stored rate, never an item's rate now",
  writes: "sets an item's rate when it is made or edited, or keeps the rate tables themselves",
  names: "names a rate without reading an item's (the activity log, a restaurant's default rate)",
  module: "the GST rate changes module itself",
};

const READERS = {
  "modules/access/repositories/audit.repository.js": "names",
  "modules/business/core/repositories/business.repository.js": "gate",
  "modules/business/core/services/business.service.js": "posting",
  "modules/business/core/services/businessKits.service.js": "posting",
  "modules/business/core/services/businessLocationPrices.service.js": "gate",
  "modules/business/core/services/businessSetup.service.js": "writes",
  "modules/business/fashion-electronics/services/businessFashion.service.js": "writes",
  "modules/business/fashion-electronics/services/businessFashionMerchandising.service.js": "posting",
  "modules/business/fashion-electronics/services/businessRepairs.service.js": "gate",
  "modules/business/fuel/services/fuelSetup.service.js": "writes",
  "modules/business/garage/services/garageEstimates.service.js": "gate",
  "modules/business/garage/services/garageJobCards.service.js": "gate",
  "modules/business/garage/services/garageMoney.js": "gate",
  "modules/business/hardware/services/hardwareRates.service.js": "gate",
  "modules/business/hardware/services/hardwareTinting.service.js": "gate",
  "modules/business/health/services/businessPharmacy.service.js": "gate",
  "modules/business/jewellery/services/jewelleryBills.service.js": "gate",
  "modules/business/jewellery/services/jewelleryPieces.service.js": "gate",
  "modules/business/jewellery/services/jewelleryAccounts.js": "writes",
  "modules/business/jewellery/services/jewelleryKarigars.service.js": "stored",
  "modules/business/laundry/services/laundryMoney.js": "gate",
  "modules/business/laundry/services/laundryOrders.service.js": "gate",
  "modules/business/laundry/services/laundryPrices.service.js": "gate",
  "modules/business/lodging/services/lodgingCommon.js": "lodging",
  "modules/business/lodging/services/lodgingDesk.service.js": "lodging",
  "modules/business/lodging/services/lodgingFolio.service.js": "gate",
  "modules/business/lodging/services/lodgingSetup.service.js": "lodging",
  "modules/business/lodging/services/lodgingStays.service.js": "lodging",
  "modules/business/memberships/services/memberChanges.service.js": "stored",
  "modules/business/memberships/services/memberPlans.service.js": "gate",
  "modules/business/memberships/services/memberships.service.js": "posting",
  "modules/business/optical/services/opticalLenses.service.js": "writes",
  "modules/business/optical/services/opticalOrders.service.js": "gate",
  "modules/business/quotations/services/businessQuotations.service.js": "gate",
  "modules/business/rentals/services/rentalsBookings.service.js": "gate",
  "modules/business/rentals/services/rentalsHandover.service.js": "gate",
  "modules/business/rentals/services/rentalsItems.service.js": "gate",
  "modules/business/retail/services/businessOffers.js": "posting",
  "modules/business/retail/services/businessRetail.service.js": "gate",
  "modules/business/retail/services/businessRetailReports.service.js": "gate",
  "modules/business/salon-weight/services/businessSalon.service.js": "gate",
  "modules/business/salon-weight/services/businessSalonSales.js": "posting",
  "modules/business/salon-weight/services/businessWeightDaily.service.js": "gate",
  "modules/business/wholesale/services/businessWholesale.service.js": "gate",
  "modules/business/wholesale/services/businessWholesaleDelivery.service.js": "stored",
  "modules/business/wholesale/services/businessWholesalePurchase.service.js": "gate",
  "modules/gst-thresholds/services/gstThresholds.service.js": "gate",
  "modules/gst-thresholds/services/gstTurnover.js": "menu",
  "modules/personal-data/services/personalDataRegistry.js": "stored",
  "modules/restaurant/billing/repositories/bill.repository.js": "stored",
  "modules/restaurant/billing/services/bill/refunds.js": "stored",
  "modules/restaurant/billing/services/bill/rules.js": "stored",
  "modules/restaurant/billing/services/bill/shape.js": "stored",
  "modules/restaurant/billing/services/customerAdvance.service.js": "names",
  "modules/restaurant/billing/services/gstBreakdown.js": "stored",
  "modules/restaurant/deliveries/repositories/deliveryCharge.repository.js": "stored",
  "modules/restaurant/menu/repositories/menuBulk.repository.js": "menu",
  "modules/restaurant/menu/repositories/product.repository.js": "menu",
  "modules/restaurant/menu/services/menu.service.js": "menu",
  "modules/restaurant/menu/services/menuImport.service.js": "menu",
  "modules/restaurant/orders/repositories/order.repository.js": "order",
  "modules/restaurant/orders/services/order.service.js": "order",
  "modules/restaurant/purchasing/repositories/purchase.repository.js": "stored",
  "modules/restaurant/purchasing/repositories/purchaseReturn.repository.js": "stored",
  "modules/restaurant/purchasing/services/purchase.service.js": "stored",
  "modules/restaurant/purchasing/services/purchaseReturn.service.js": "stored",
  "modules/restaurant/reports/repositories/report/gst.js": "stored",
  "modules/restaurant/reports/repositories/report/sql.js": "stored",
  "modules/restaurant/reports/services/report/gstData.js": "stored",
  "modules/restaurant/setup/controllers/restaurant.controller.js": "names",
  "modules/restaurant/setup/controllers/taxRate.controller.js": "names",
  "modules/restaurant/setup/repositories/restaurant.repository.js": "writes",
  "modules/restaurant/setup/repositories/taxRate.repository.js": "writes",
  "modules/tax-changes/services/taxChanges.service.js": "module",
  "modules/tax-changes/services/taxChangesMenu.js": "module",
  "modules/tax-changes/services/taxChangesShop.js": "module",
  "modules/business/salon-weight/services/businessWeight.service.js": "gate",
};

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (entry.name.endsWith(".js")) yield path.relative(SRC, full).split(path.sep).join("/");
  }
}
// A GST rate column: an item's slab (tax_rate, tax_rate_id, tax_rate_now), a
// dish's rate (tax_percentage) or a lodging's two slabs.
const RATE = /\btax_rate(_id|_now)?\b|tax_percentage|low_tax_rate_id|high_tax_rate_id/;

test("every file that reads or writes a GST rate says how it gets the rate in force on its date", () => {
  const found = [...sourceFiles(SRC)].filter((file) => RATE.test(read(file))).sort();
  const listed = Object.keys(READERS).sort();
  const unlisted = found.filter((file) => !READERS[file]);
  const gone = listed.filter((file) => !found.includes(file));
  assert.deepEqual(unlisted, [], `These files read or write a GST rate. Check each gets the rate in force on its own date (${Object.values(HOW).join("; ")}), then add it to READERS.`);
  assert.deepEqual(gone, [], "These files no longer touch a GST rate: take them off READERS.");
  for (const [file, how] of Object.entries(READERS)) assert.ok(HOW[how], `${file}: no such way "${how}"`);
});

test("every shop request opens its business through the gate that applies due changes", () => {
  for (const file of ["modules/business/core/routes/business.routes.js", "modules/business/wholesale/routes/businessTrade.routes.js"]) {
    const text = read(file);
    const context = text.slice(text.indexOf("const context = (permission) =>"), text.indexOf("const b = (path)"));
    assert.match(context, /access\.open\(req\.user, req\.params\.businessId\)/, `${file}: context opens the business with access.open`);
    assert.doesNotMatch(context, /access\.load\(/, `${file}: context must not skip the gate`);
  }
  // Every route on a business: its arguments up to the handler name context(…).
  const routeFiles = [...sourceFiles(SRC)].filter((file) => /^modules\/(business|tax-changes)\/.*\/routes\/.*\.js$/.test(file));
  let checked = 0;
  for (const file of routeFiles) {
    const text = read(file).replace(/\s+/g, " ");
    for (const match of text.matchAll(/router\.(get|post|put|patch|delete)\( ?b\(([^)]*)\)((?:(?!async \(|=>).)*)/g)) {
      checked += 1;
      assert.match(match[3], /context\(/, `${file}: the route ${match[1].toUpperCase()} ${match[2]} is not opened through context()`);
    }
  }
  assert.ok(checked > 300, `only ${checked} business routes found: the search is broken`);
});

test("postings, orders and menus apply due changes before they read a rate", () => {
  const core = read("modules/business/core/services/business.service.js");
  const posting = core.slice(core.indexOf("async function postDocument("));
  assert.ok(posting.indexOf("taxChanges().onPosting(") > 0 && posting.indexOf("taxChanges().onPosting(") < posting.indexOf("SELECT tax_mode,rounding"),
    "postDocument applies due changes before it reads the settings and the items");
  const orders = read("modules/restaurant/orders/services/order.service.js");
  const pricing = orders.slice(orders.indexOf("const priceLines = async"));
  assert.ok(pricing.indexOf("taxChanges.forOrderDay(") > 0 && pricing.indexOf("taxChanges.forOrderDay(") < pricing.indexOf("orderRepository.findSellable("),
    "priceLines applies the order day's changes before it reads the dishes");
  const menuRoutes = read("modules/restaurant/menu/routes/menu.routes.js");
  assert.ok(menuRoutes.indexOf("router.use(taxChanges.gate)") > menuRoutes.indexOf("router.use(authenticate)")
    && menuRoutes.indexOf("router.use(taxChanges.gate)") < menuRoutes.indexOf("router.get("), "the menu routes apply the trading day's changes first");
  const guests = read("modules/restaurant/orders/services/tableRequest.service.js");
  const menuFor = guests.slice(guests.indexOf("const menuFor = async"));
  assert.ok(menuFor.indexOf("taxChanges.onMenu(") > 0 && menuFor.indexOf("taxChanges.onMenu(") < menuFor.indexOf("findMenuProducts("),
    "the guests' menus apply the trading day's changes first");
});
