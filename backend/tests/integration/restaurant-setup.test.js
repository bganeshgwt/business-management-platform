// Restaurant set-up: the outlets list's real next bill number and
// shared invoice series (GET /outlets?series=1 and the invoice-series list),
// and the Features screen's "Switch off?" question naming the screens that go
// and the open work that stays (POST /restaurants/current/features/:code/preview).
// On a throwaway database; another restaurant sees none of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");

const { today } = require("./helpers/dates");

const TODAY = today();

test("restaurant set-up: next bill numbers, shared series, feature switch-off preview", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres" });
  let created = false;
  let pool;
  let server;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) {
        await admin.query(`DROP DATABASE "${database}"`);
      }
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  process.env.LOGIN_ATTEMPT_LIMIT = "500";
  const { runner } = await import("node-pg-migrate");
  await runner({
    databaseUrl: { ...db, database },
    dir: path.resolve(__dirname, "../../migrations"),
    migrationsTable: "pgmigrations",
    direction: "up",
    count: Infinity,
    checkOrder: true,
    log() {},
  });

  pool = require("../../src/config/database");
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");

  await restaurantService.createRestaurant({
    name: "Prasad Bhavan",
    code: "PROBSET",
    invoicePrefix: "PB",
    admin: { name: "Prasad owner", email: "owner@probset.invalid", password },
  });
  await restaurantService.createRestaurant({
    name: "Other Bhavan",
    code: "PROBSOT",
    invoicePrefix: "OB",
    admin: { name: "Other owner", email: "other@probset.invalid", password },
  });

  const app = require("../../src/app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, url, body, auth) {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function request(method, url, body, expected, auth) {
    const result = await call(method, url, body, auth);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password }, 200)).token;
  const owner = await login("owner@probset.invalid");
  const other = await login("other@probset.invalid");
  const O = (method, url, body, expected = 200) => request(method, url, body, expected, owner);

  await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 500 }, 201);
  await O("POST", "/menu/tax-rates", { name: "GST 5%", percentage: 5, hsnCode: "996331", isDefault: true }, 201);
  const category = await O("POST", "/menu/categories", { name: "Tiffins" }, 201);
  const dosa = await O("POST", "/menu/products", { categoryId: category.id, name: "Masala Dosa", price: 90, foodType: "veg" }, 201);

  await t.test("next bill number: read from the real counter, before and after bills", async () => {
    const before = await O("GET", "/restaurants/current/invoice-series");
    const main = before.find((row) => row.outletId === null);
    assert.equal(main.nextNumber, "PB-0001");
    assert.equal(main.issued, 0);

    for (let i = 0; i < 2; i += 1) {
      const order = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: dosa.id, quantity: 1 }] }, 201);
      await O("POST", "/bills", { orderId: order.id }, 201);
    }

    const after = await O("GET", "/restaurants/current/invoice-series");
    const mainAfter = after.find((row) => row.outletId === null);
    assert.equal(mainAfter.nextNumber, "PB-0003");
    assert.equal(mainAfter.issued, 2);
    assert.equal(mainAfter.example, "PB-0001", "the old example field is unchanged");
  });

  await t.test("outlets ?series=1: each outlet's series, next number and who shares it", async () => {
    const jubilee = await O("POST", "/outlets", { name: "Jubilee", code: "JUB", invoicePrefix: "JA" }, 201);
    const ameerpet = await O("POST", "/outlets", { name: "Ameerpet", code: "AMR", invoicePrefix: "JA" }, 201);
    const kukatpally = await O("POST", "/outlets", { name: "Kukatpally", code: "KPHB", invoicePrefix: "KP" }, 201);
    const mirror = await O("POST", "/outlets", { name: "Main mirror", code: "MIR", invoicePrefix: "PB" }, 201);

    const plain = await O("GET", "/outlets");
    assert.ok(plain.every((row) => row.invoiceSeries === undefined), "the plain list is unchanged");

    const listed = await O("GET", "/outlets?series=1");
    const byId = new Map(listed.map((row) => [Number(row.id), row.invoiceSeries]));
    assert.equal(byId.get(Number(jubilee.id)).series, "JA");
    assert.equal(byId.get(Number(jubilee.id)).nextNumber, "JA-0001");
    assert.deepEqual(byId.get(Number(jubilee.id)).sharedWith, ["Ameerpet"]);
    assert.deepEqual(byId.get(Number(ameerpet.id)).sharedWith, ["Jubilee"]);
    assert.deepEqual(byId.get(Number(kukatpally.id)).sharedWith, []);
    assert.equal(byId.get(Number(mirror.id)).nextNumber, "PB-0003", "a till sharing the main series continues its numbers");
    assert.ok(byId.get(Number(mirror.id)).sharedWith.includes("Main counter"));

    const theirs = await request("GET", "/outlets?series=1", undefined, 200, other);
    assert.equal(theirs.length, 0, "another restaurant sees none of these outlets");
  });

  await t.test("feature switch-off preview names the screens that go and the open work that stays", async () => {
    const supplier = await O("POST", "/suppliers", { name: "Sri Venkateswara Rice", mobile: "9876522201" }, 201);
    const kg = await O("POST", "/inventory/units", { name: "Kilogram", shortName: "kg" }, 201);
    const rice = await O("POST", "/inventory/items", { name: "Sona Masoori", unitId: kg.id, category: "Grains" }, 201);
    await O("POST", "/purchase-orders", { supplierId: supplier.id, items: [{ inventoryItemId: rice.id, quantity: 25, unitPrice: 60 }] }, 201);
    const placed = await O("POST", "/purchase-orders", { supplierId: supplier.id, items: [{ inventoryItemId: rice.id, quantity: 10, unitPrice: 60 }] }, 201);
    await O("PATCH", `/purchase-orders/${placed.id}/status`, { status: "ordered" });

    const stock = await O("POST", "/restaurants/current/features/stock_recipes/preview", { enabled: false });
    assert.ok(stock.hides.includes("Purchase orders") && stock.hides.includes("Items & stock"));
    assert.equal(stock.blockers.length, 0);
    const poLine = stock.warnings.find((line) => /purchase orders are still open/.test(line));
    assert.ok(poLine, JSON.stringify(stock.warnings));
    assert.match(poLine, /1 draft/);
    assert.match(poLine, /1 placed for ₹600/);
    assert.match(poLine, /stay saved but hidden/);

    const guests = await O("POST", "/restaurants/current/features/guests/preview", { enabled: false });
    assert.ok(guests.hides.includes("Complaints"));

    // Switching on hides nothing.
    await O("PUT", "/restaurants/current/features/kitchen_display", { enabled: false });
    const on = await O("POST", "/restaurants/current/features/kitchen_display/preview", { enabled: true });
    assert.deepEqual(on.hides, []);
  });
});
