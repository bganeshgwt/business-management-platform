// Restaurant stock and menu, on a throwaway
// database: an item taken out of use is never "low"; the item list answers a
// type-ahead picker (q + limit); a stock count can cover a spot check (the 20
// items worth most, the low ones, or named items) and keeps its old whole-store
// behaviour without one; production batches page by date; and the dish list
// says which dishes have a recipe and what a plate costs (only to those who may
// see recipe costs). Another restaurant sees none of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

const { today, addDays } = require("./helpers/dates");
const TODAY = today();

test("stock list, counts, production, dish food cost", { timeout: 600000 }, async (t) => {
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
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");

  const made = await restaurantService.createRestaurant({
    name: "Pro Kitchen",
    code: "PROB",
    invoicePrefix: "PK",
    admin: { name: "Pro owner", email: "owner@prob.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Kitchen",
    code: "PROBOTHER",
    admin: { name: "Other owner", email: "other@prob.invalid", password },
  });

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role) => {
    const row = await one(
      `INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
      [rid, name, email, hash]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    return Number(row.id);
  };
  await staff("Asha cashier", "asha@prob.invalid", "CASHIER");

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
  const owner = await login("owner@prob.invalid");
  const other = await login("other@prob.invalid");
  const cashier = await login("asha@prob.invalid");
  const O = (method, url, body, expected = 200) => request(method, url, body, expected, owner);

  await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 1000 }, 201);
  const kg = await O("POST", "/inventory/units", { name: "Kilogram", shortName: "kg" }, 201);
  const item = (name, extra) => O("POST", "/inventory/items", { name, unitId: kg.id, ...extra }, 201);

  // Twenty-five items worth 1..25 rupees a kilo, 10 kg each: the dearest 20
  // are items 6..25. Plus a low one, an out one and a retired low one.
  const stocked = [];
  for (let i = 1; i <= 25; i += 1) {
    stocked.push(await item(`Stock item ${String(i).padStart(2, "0")}`, { storageArea: i % 2 ? "Dry store" : "Walk-in", openingStock: 10, openingCost: i, reorderLevel: 1 }));
  }
  const paneer = await item("Paneer", { storageArea: "Walk-in", openingStock: 2, openingCost: 300, reorderLevel: 5, code: "PNR" });
  const ghee = await item("Ghee", { storageArea: "Dry store", reorderLevel: 2 });
  const retired = await item("Old saffron", { openingStock: 1, openingCost: 50, reorderLevel: 5 });
  await O("PUT", `/inventory/items/${retired.id}`, { name: "Old saffron", unitId: kg.id, reorderLevel: 5, status: "inactive" });

  await t.test("an inactive item is never low; active low and out items are", async () => {
    const all = await O("GET", "/inventory/items");
    const byId = new Map(all.map((row) => [row.id, row]));
    assert.equal(byId.get(retired.id).status, "inactive");
    assert.equal(byId.get(retired.id).isLow, false, "a retired item below its reorder level is not low");
    assert.equal(byId.get(paneer.id).isLow, true);
    assert.equal(byId.get(ghee.id).isLow, true);
    const low = await O("GET", "/inventory/items?lowOnly=true");
    assert.deepEqual(low.map((row) => row.name).sort(), ["Ghee", "Paneer"]);
  });

  await t.test("the item list answers a type-ahead picker: q and limit", async () => {
    const found = await O("GET", "/inventory/items?q=stock%20item&limit=5");
    assert.equal(found.length, 5);
    assert.equal(found[0].name, "Stock item 01");
    const byCode = await O("GET", "/inventory/items?q=pnr&limit=20");
    assert.deepEqual(byCode.map((row) => row.name), ["Paneer"]);
    assert.equal((await O("GET", "/inventory/items")).length, 28, "no limit: every item, as before");
    assert.equal((await request("GET", "/inventory/items?q=paneer&limit=20", undefined, 200, other)).length, 0);
    assert.equal((await call("GET", "/inventory/items?limit=0", undefined, owner)).status, 400);
  });

  await t.test("a count can be a spot check: high value, low stock or named items", async () => {
    const high = await O("POST", "/inventory/counts", { scope: "high_value" }, 201);
    const names = high.lines.map((line) => line.itemName);
    assert.equal(high.lineCount, 20);
    assert.ok(names.includes("Paneer"), "paneer (600 rupees on the shelf) is among the dearest");
    assert.ok(!names.includes("Stock item 01") && !names.includes("Stock item 06"), "the cheapest items are left off");
    assert.equal(high.scope.kind, "high_value");
    await O("POST", `/inventory/counts/${high.id}/cancel`, {});

    const low = await O("POST", "/inventory/counts", { scope: "low" }, 201);
    assert.deepEqual(low.lines.map((line) => line.itemName).sort(), ["Ghee", "Paneer"], "the retired item is not counted");
    await O("POST", `/inventory/counts/${low.id}/cancel`, {});

    const named = await O("POST", "/inventory/counts", { itemIds: [paneer.id] }, 201);
    assert.equal(named.lineCount, 1);
    assert.equal(named.scope.items, 1);
    await O("POST", `/inventory/counts/${named.id}/cancel`, {});

    const area = await O("POST", "/inventory/counts", { storageAreas: ["Walk-in"] }, 201);
    assert.equal(area.lineCount, 13, "12 walk-in stock items and paneer");
    await O("POST", `/inventory/counts/${area.id}/cancel`, {});

    const whole = await O("POST", "/inventory/counts", {}, 201);
    assert.equal(whole.lineCount, 27, "no scope: every active item, as before");
    await O("POST", `/inventory/counts/${whole.id}/cancel`, {});

    assert.equal((await call("POST", "/inventory/counts", { scope: "everything" }, owner)).status, 400);
    const foreign = await call("POST", "/inventory/counts", { itemIds: [paneer.id] }, other);
    assert.equal(foreign.status, 400, "another restaurant's item ids find nothing");
  });

  await t.test("production pages by date; without page it is the old plain list", async () => {
    const gravy = await item("Makhani gravy", { itemType: "prepared" });
    await O("PUT", `/inventory/items/${gravy.id}/recipe`, { lines: [{ inventoryItemId: stocked[24].id, quantity: 0.1 }] });
    for (let i = 1; i <= 3; i += 1) {
      await O("POST", "/inventory/production", { outputItemId: gravy.id, quantity: 1, batchNumber: `GR-${i}` }, 201);
    }
    await pool.query("UPDATE production_batches SET produced_at = NOW() - INTERVAL '10 days' WHERE batch_number = 'GR-1'");

    const plain = await O("GET", "/inventory/production");
    assert.ok(Array.isArray(plain));
    assert.equal(plain.length, 3);

    const todayPage = await O("GET", `/inventory/production?from=${TODAY}&to=${TODAY}&page=1&pageSize=1`);
    assert.equal(todayPage.total, 2);
    assert.equal(todayPage.items.length, 1);
    assert.equal(todayPage.items[0].batchNumber, "GR-3");
    assert.equal(todayPage.totalCost, 5, "two batches at 2.50 each");
    const second = await O("GET", `/inventory/production?from=${TODAY}&to=${TODAY}&page=2&pageSize=1`);
    assert.equal(second.items[0].batchNumber, "GR-2");
    const past = await O("GET", `/inventory/production?from=${TODAY}&to=${TODAY}&page=5&pageSize=1`);
    assert.equal(past.items.length, 0);
    assert.equal(past.total, 2);
    assert.equal((await call("GET", `/inventory/production?from=${TODAY}&to=2026-01-01&page=1`, undefined, owner)).status, 400);
  });

  await t.test("wastage opens on the week ending today, even with an old business day still open", async () => {
    const fresh = await O("GET", "/inventory-insights/wastage");
    assert.equal(fresh.to, TODAY);
    assert.equal(fresh.today, TODAY);
    assert.equal(fresh.from, addDays(TODAY, -6));

    const old = addDays(TODAY, -14);
    await pool.query("UPDATE business_days SET business_date = $2 WHERE restaurant_id = $1 AND day_status = 'open'", [rid, old]);
    try {
      const stale = await O("GET", "/inventory-insights/wastage");
      assert.equal(stale.businessDate, old, "entries still go on the open day");
      assert.equal(stale.to, TODAY, "but the chart shows this week");
      const asked = await O("GET", `/inventory-insights/wastage?from=${old}&to=${old}`);
      assert.equal(asked.to, old, "a range asked for is kept");
    } finally {
      await pool.query("UPDATE business_days SET business_date = $2 WHERE restaurant_id = $1 AND day_status = 'open'", [rid, TODAY]);
    }
  });

  await t.test("write-offs by nobody on record read as older entries, not Unknown", async () => {
    await O("POST", "/inventory-insights/wastage", { inventoryItemId: stocked[0].id, quantity: 1, reason: "spoiled" }, 201);
    await pool.query("UPDATE stock_transactions SET created_by = NULL WHERE restaurant_id = $1 AND transaction_type = 'wastage'", [rid]);
    const control = await O("GET", `/inventory-insights/control?from=${TODAY}&to=${TODAY}`);
    const text = JSON.stringify(control);
    assert.ok(!text.includes("Unknown"));
    assert.ok(text.includes("Not recorded (older entries)"));
  });

  await t.test("an item's preferred supplier: set alone, validated, and used by the reorder plan", async () => {
    const dairy = await O("POST", "/suppliers", { name: "Dairy Co" }, 201);
    const foreign = await request("POST", "/suppliers", { name: "Their Dairy" }, 201, other);

    let plan = await O("GET", "/inventory-insights/reorder?horizon=7");
    const unassigned = plan.groups.find((group) => group.supplierId === null);
    assert.ok(unassigned && unassigned.lines.some((line) => line.id === paneer.id), "paneer starts with no supplier");

    const refused = await call("PUT", `/inventory/items/${paneer.id}`, { preferredSupplierId: foreign.id }, owner);
    assert.equal(refused.status, 400, "another restaurant's supplier is refused");

    const set = await O("PUT", `/inventory/items/${paneer.id}`, { preferredSupplierId: dairy.id });
    assert.equal(set.preferredSupplierId, dairy.id);
    assert.equal(set.preferredSupplierName, "Dairy Co");
    assert.equal(set.reorderLevel, 5, "the rest of the item is left as it was");
    assert.equal(set.code, "PNR");

    plan = await O("GET", "/inventory-insights/reorder?horizon=7");
    const group = plan.groups.find((row) => row.supplierId === dairy.id);
    assert.ok(group, "a card for the chosen supplier");
    const line = group.lines.find((row) => row.id === paneer.id);
    assert.ok(line && line.supplier.chosen);

    // A full edit that does not name it keeps it; one that sends null clears it.
    await O("PUT", `/inventory/items/${paneer.id}`, { name: "Paneer", code: "PNR", unitId: kg.id, reorderLevel: 5, storageArea: "Walk-in" });
    assert.equal((await O("GET", "/inventory/items?q=pnr&limit=5"))[0].preferredSupplierId, dairy.id);
    await O("PUT", `/inventory/items/${paneer.id}`, { preferredSupplierId: null });
    assert.equal((await O("GET", "/inventory/items?q=pnr&limit=5"))[0].preferredSupplierId, null);

    // The database itself refuses another restaurant's supplier.
    await assert.rejects(
      pool.query("UPDATE inventory_items SET preferred_supplier_id = $1 WHERE id = $2", [foreign.id, paneer.id]),
      /same restaurant/
    );
    const made = await O("POST", "/inventory/items", { name: "Butter", unitId: kg.id, preferredSupplierId: dairy.id }, 201);
    assert.equal(made.preferredSupplierId, dairy.id);
  });

  await t.test("the dish list says which dishes have a recipe and what a plate costs", async () => {
    const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
    const dish = await O("POST", "/menu/products", { categoryId: category.id, name: "Paneer tikka", price: 250, foodType: "veg" }, 201);
    const bare = await O("POST", "/menu/products", { categoryId: category.id, name: "Plain rice", price: 100, foodType: "veg" }, 201);
    await O("POST", `/menu/products/${dish.id}/recipe`, { inventoryItemId: paneer.id, quantity: 0.2 }, 201);

    const rows = await O("GET", "/menu/products?withCost=true");
    const tikka = rows.find((row) => row.id === dish.id);
    const rice = rows.find((row) => row.id === bare.id);
    assert.equal(tikka.hasRecipe, true);
    assert.equal(tikka.plateCost, 60);
    assert.equal(tikka.foodCostPercent, 24);
    assert.equal(rice.hasRecipe, false);
    assert.equal(rice.plateCost, null);

    const plain = await O("GET", "/menu/products");
    assert.equal(plain.find((row) => row.id === dish.id).hasRecipe, undefined, "without withCost the list is as before");

    const forCashier = await request("GET", "/menu/products?withCost=true", undefined, 200, cashier);
    const seen = forCashier.find((row) => row.id === dish.id);
    assert.equal(seen.hasRecipe, true);
    assert.equal(seen.plateCost, null, "a cashier does not see what a plate costs");
  });

  await t.test("the P&L food cost is split by what took the stock, and Dish profitability is its sold part", async () => {
    const category = await O("POST", "/menu/categories", { name: "Grill" }, 201);
    const tikka = await O("POST", "/menu/products", { categoryId: category.id, name: "Ghee roast", price: 400, foodType: "veg" }, 201);
    const ghee10 = stocked[9]; // 10 rupees a kilo
    await O("POST", `/menu/products/${tikka.id}/recipe`, { inventoryItemId: ghee10.id, quantity: 1 }, 201);

    const placed = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: tikka.id, quantity: 3 }] }, 201);
    const bill = await O("POST", "/bills", { orderId: (placed.order || placed).id }, 201);
    // Issued to the kitchen by hand: 2 kg at 12 rupees.
    await O("POST", "/inventory/movements/out", { inventoryItemId: stocked[11].id, quantity: 2, transactionType: "consumption" }, 201);

    const pl = await O("GET", `/reports/profit-loss?from=${TODAY}&to=${TODAY}&basis=consumption`);
    const parts = pl.foodCostBreakdown;
    const line = (key) => pl.lines.find((row) => row.key === key).amount;
    assert.equal(parts.sold, 30, "3 plates × 1 kg at 10 rupees");
    assert.equal(parts.manual, 24);
    assert.equal(parts.production, 7.5, "three batches of 0.1 kg at 25 rupees (the batch dated back kept its movement today)");
    assert.equal(parts.used, 54, "ingredients moved into prepared items are not food cost: sold 30 + manual 24");
    assert.equal(parts.wastage, 1);
    assert.equal(parts.soldWithoutBill, 0);
    assert.equal(parts.used, line("foodUsed"), "the parts add up to Ingredients used");
    assert.equal(parts.total, line("foodCost"), "and with wastage to the cost of food");
    // The prepared item counts when a bill uses it: half a kilo of gravy at its
    // cost (2.50 a kilo, made from 0.1 kg at 25) is 1.25 of food cost.
    const [gravy] = await O("GET", "/inventory/items?q=makhani&limit=5");
    const curry = await O("POST", "/menu/products", { categoryId: category.id, name: "Makhani curry", price: 200, foodType: "veg" }, 201);
    await O("POST", `/menu/products/${curry.id}/recipe`, { inventoryItemId: gravy.id, quantity: 0.5 }, 201);
    const curryOrder = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: curry.id, quantity: 1 }] }, 201);
    await O("POST", "/bills", { orderId: (curryOrder.order || curryOrder).id }, 201);
    const withCurry = (await O("GET", `/reports/profit-loss?from=${TODAY}&to=${TODAY}&basis=consumption`)).foodCostBreakdown;
    assert.equal(withCurry.sold, 31.25);
    assert.equal(withCurry.production, 7.5, "still beside the food cost, not in it");
    assert.equal(withCurry.used, 55.25);

    const bought = await O("GET", `/reports/profit-loss?from=${TODAY}&to=${TODAY}&basis=purchases`);
    assert.equal(bought.foodCostBreakdown, undefined, "only on the stock basis");

    let dishes = await O("GET", `/reports/profitability?from=${TODAY}&to=${TODAY}`);
    assert.equal(dishes.totals.foodCost, 31.25);
    assert.equal(dishes.foodCostBreakdown.sold, 31.25);

    // An older bill's stock names it by bill number in the notes, with no id:
    // Dish profitability still finds it (it used to read ₹0).
    const moved = await pool.query(
      "UPDATE stock_transactions SET reference_id = NULL, notes = $2 WHERE restaurant_id = $1 AND reference_type = 'bill' AND reference_id = $3 RETURNING id",
      [rid, bill.billNumber, bill.id]
    );
    assert.ok(moved.rowCount > 0);
    dishes = await O("GET", `/reports/profitability?from=${TODAY}&to=${TODAY}`);
    assert.equal(dishes.totals.foodCost, 31.25);

    // Stock marked as a bill's with no such bill: in the P&L, named apart.
    await pool.query("UPDATE stock_transactions SET notes = 'NO-SUCH-BILL' WHERE id = $1", [moved.rows[0].id]);
    const after = await O("GET", `/reports/profit-loss?from=${TODAY}&to=${TODAY}&basis=consumption`);
    assert.equal(after.foodCostBreakdown.soldWithoutBill, 30);
    assert.equal(after.foodCostBreakdown.sold, 31.25);
  });
});
