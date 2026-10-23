const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const path = require("node:path");

const DATABASE = require.resolve("../src/config/database");

// The brand report adds up its rows without loading credentials or touching a
// database: the service is run with its database and feature lookups stubbed.
function brandService() {
  const file = path.resolve(__dirname, "../src/modules/restaurant/menu/services/brand.service.js");
  const realRequire = createRequire(file);
  const context = { module: { exports: {} }, require: (name) => {
    if (name.endsWith("config/database")) return { query: async () => ({ rows: [] }) };
    if (name.endsWith("restaurantFeatures.service")) return {};
    return realRequire(name);
  }};
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  // A stub that misses its module lets the real one load, with the database
  // named in backend/.env behind it.
  assert.equal(require.cache[DATABASE], undefined, "the brand service must not load config/database");
  return context.module.exports;
}

// Objects made inside the sandbox have its own prototypes: compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

const row = (brandId, name, channel, bills, sales, commission) =>
  ({ brand_id: brandId, brand_name: name, color: null, channel, bills, sales, commission });

// Amounts as PostgreSQL returns them (numeric as text). Added as rupees in
// floating point, 0.1 + 0.2 and the like leave a tail (0.30000000000000004).
const rows = [
  row(1, "Biryani Box", "Swiggy", 1, "0.10", "0.03"),
  row(1, "Biryani Box", "Zomato", 1, "0.20", "0.06"),
  row(1, "Biryani Box", "Own delivery", 1, "1234.57", "0.00"),
  row(2, "Wrap Republic", "Swiggy", 2, "0.70", "0.14"),
  row(0, "No brand (kitchen name)", "Counter / takeaway", 3, "100.10", "0.00"),
];

const twoPlaces = (value) => Number.isFinite(value) && Math.round(value * 100) / 100 === value && !/\.\d{3,}/.test(String(value));

test("brand totals are exact to the paisa, with no floating-point tail", () => {
  const { brands, totals } = brandService().summarise(rows);
  assert.deepEqual(plain(totals), { bills: 8, sales: 1335.67, commission: 0.23, net: 1335.44 });
  for (const brand of brands) {
    for (const figure of [brand.sales, brand.commission, brand.net, brand.averageBill]) assert.ok(twoPlaces(figure), `${brand.name}: ${figure}`);
    for (const channel of brand.channels) {
      for (const figure of [channel.sales, channel.commission, channel.net]) assert.ok(twoPlaces(figure), `${brand.name} ${channel.channel}: ${figure}`);
    }
  }
});

test("each brand adds up its channels, biggest seller first", () => {
  const { brands } = brandService().summarise(rows);
  assert.deepEqual(plain(brands.map((b) => b.name)), ["Biryani Box", "No brand (kitchen name)", "Wrap Republic"]);
  const biryani = brands[0];
  assert.equal(biryani.sales, 1234.87);
  assert.equal(biryani.commission, 0.09);
  assert.equal(biryani.net, 1234.78);
  assert.equal(biryani.bills, 3);
  assert.equal(biryani.averageBill, 411.62);
  assert.equal(biryani.channels.length, 3);
});

test("no rows: zero totals and no brands", () => {
  assert.deepEqual(plain(brandService().summarise([])), { brands: [], totals: { bills: 0, sales: 0, commission: 0, net: 0 } });
});
