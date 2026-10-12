const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// SW-A-12: kitchen names (any Indian script) for dishes, sizes and add-ons on
// KOTs, the kitchen board and change slips; the kitchen settings choose menu,
// kitchen or both; the menu import and export carry them; bills keep the
// menu name. Own throwaway database, like restaurant.test.js.
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const HINDI = "पनीर टिक्का";
const TAMIL = "பனீர் டிக்கா";
const TELUGU = "పనీర్ టిక్కా";

test("kitchen names on KOTs", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres" });
  let created = false, pool, server;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) {
        await admin.query(`DROP DATABASE "${database}"`);
      }
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  process.env.LOGIN_ATTEMPT_LIMIT = "200";
  const { runner } = await import("node-pg-migrate");
  await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"),
    migrationsTable: "pgmigrations", direction: "up", count: Infinity, checkOrder: true, log() {} });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rid = (await one("INSERT INTO restaurants (name,code) VALUES ('Names test','KNT') RETURNING id")).id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING", [rid]);
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const addUser = async (restaurantId, email, role) => {
    const user = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,$2,$2,$3) RETURNING id", [restaurantId, email, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL", [user.id, role]);
  };
  await addUser(rid, "owner@test.invalid", "RESTAURANT_ADMIN");
  await addUser(rid, "cook@test.invalid", "KITCHEN");
  const other = (await one("INSERT INTO restaurants(name,code) VALUES ('Other','OTH') RETURNING id")).id;
  await addUser(other, "other@test.invalid", "RESTAURANT_ADMIN");
  const category = (await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Starters') RETURNING id", [rid])).id;
  const floor = (await one("INSERT INTO floors(restaurant_id,name) VALUES ($1,'Ground') RETURNING id", [rid])).id;
  const table = (await one("INSERT INTO dining_tables(restaurant_id,floor_id,table_no,capacity,qr_token) VALUES ($1,$2,'T1',4,$3) RETURNING id", [rid, floor, crypto.randomBytes(16).toString("hex")])).id;

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, url, body, expected = 200, auth) {
    const response = await fetch(base + url, { method, headers: {
      "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password })).data.token;
  const owner = await login("owner@test.invalid");
  const cook = await login("cook@test.invalid");
  const foreign = await login("other@test.invalid");
  const O = (method, url, body, expected) => request(method, url, body, expected, owner);

  let dish, half, cheese;
  await t.test("dishes, sizes and add-ons keep a kitchen name in any script", async () => {
    dish = (await O("POST", "/menu/products", { categoryId: category, name: "Paneer Tikka", price: 300, taxPercentage: 5, kitchenName: HINDI }, 201)).data;
    assert.equal(dish.kitchenName, HINDI);
    const tamil = (await O("POST", "/menu/products", { categoryId: category, name: "Tikka T", price: 300, taxPercentage: 5, kitchenName: TAMIL }, 201)).data;
    assert.equal(tamil.kitchenName, TAMIL);
    const telugu = (await O("PATCH", `/menu/products/${tamil.id}`, { changes: { kitchenName: TELUGU }, original: { kitchenName: TAMIL } })).data;
    assert.equal((telugu.product || telugu).kitchenName, TELUGU);
    const refused = await O("POST", "/menu/products", { categoryId: category, name: "Long", price: 1, taxPercentage: 5, kitchenName: "क".repeat(151) }, 400);
    assert.match(refused.message, /Kitchen name must be 150 characters or less/);
    half = (await O("POST", `/menu/products/${dish.id}/variants`, { name: "Half", price: 180, kitchenName: "हाफ" }, 201)).data;
    assert.equal(half.kitchenName, "हाफ");
    cheese = (await O("POST", "/menu/modifiers", { name: "Extra cheese", price: 40, kitchenName: "चीज़" }, 201)).data;
    assert.equal(cheese.kitchenName, "चीज़");
    await O("PUT", `/menu/products/${dish.id}/modifiers`, { modifierIds: [cheese.id] });
    await request("PUT", `/menu/variants/${half.id}`, { kitchenName: "x" }, 404, foreign);
    await request("PUT", `/menu/modifiers/${cheese.id}`, { kitchenName: "x" }, 404, foreign);
    await request("PATCH", `/menu/products/${dish.id}`, { changes: { kitchenName: "x" }, original: {} }, 404, foreign);
  });

  await t.test("the kitchen settings choose menu, kitchen or both", async () => {
    assert.equal((await O("GET", "/kitchen/settings")).data.kitchenNameMode, "both");
    await O("PUT", "/kitchen/settings", { kitchenNameMode: "urdu" }, 400);
    await request("PUT", "/kitchen/settings", { kitchenNameMode: "menu" }, 403, cook);
    assert.equal((await O("PUT", "/kitchen/settings", { kitchenNameMode: "kitchen" })).data.kitchenNameMode, "kitchen");
    const timers = (await O("PUT", "/kitchen/settings", { warnMinutes: 9, lateMinutes: 18 })).data;
    assert.equal(timers.kitchenNameMode, "kitchen");
    assert.equal((await request("GET", "/kitchen/settings", undefined, 200, foreign)).data.kitchenNameMode, "both");
  });

  await t.test("tickets and change slips carry the names and the choice; the order keeps menu names", async () => {
    await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 500 }, 201);
    const order = (await O("POST", "/orders", { orderType: "dine_in", tableId: table,
      items: [{ productId: dish.id, productVariantId: half.id, quantity: 2, modifierIds: [cheese.id] }] }, 201)).data;
    assert.equal(order.items[0].itemName, "Paneer Tikka");
    const [ticket] = (await O("GET", `/kitchen/orders/${order.id}/kots`)).data;
    assert.equal(ticket.nameMode, "kitchen");
    assert.equal(ticket.items[0].kitchenName, HINDI);
    assert.equal(ticket.items[0].variantKitchenName, "हाफ");
    assert.deepEqual(ticket.items[0].modifierKitchenNames, ["चीज़"]);
    await request("GET", `/kitchen/orders/${order.id}/kots`, undefined, 404, foreign);
    await O("POST", `/kitchen/kots/${ticket.id}/print`);
    await O("PATCH", `/orders/${order.id}/cancel`, { reason: "Guest left" });
    const [slip] = (await O("POST", "/kitchen/slips/claim", { orderIds: [order.id] })).data;
    assert.equal(slip.nameMode, "kitchen");
    assert.equal(slip.lines[0].kitchenName, HINDI);
    assert.equal(slip.lines[0].variantKitchenName, "हाफ");
  });

  await t.test("the menu import and export carry kitchen names, and a round trip changes nothing", async () => {
    const rows = [{ Name: "Paneer Tikka", "Kitchen name": TAMIL, "Size kitchen names": "Half=அரை", "Add-on kitchen names": "Extra cheese=சீஸ்" }];
    const check = (await O("POST", "/menu/products/import", { rows, dryRun: true })).data;
    assert.equal(check.ok, true, JSON.stringify(check.problems));
    await O("POST", "/menu/products/import", { rows, dryRun: false, fingerprint: check.fingerprint, confirmFlagged: true });
    const names = await one(
      `SELECT (SELECT kitchen_name FROM products WHERE id=$1) AS dish, (SELECT kitchen_name FROM product_variants WHERE id=$2) AS half,
              (SELECT kitchen_name FROM modifiers WHERE id=$3) AS cheese`, [dish.id, half.id, cheese.id]);
    assert.deepEqual(names, { dish: TAMIL, half: "அரை", cheese: "சீஸ்" });
    const bad = (await O("POST", "/menu/products/import", { rows: [{ Name: "Paneer Tikka", "Size kitchen names": "Quarter=x" }], dryRun: true })).data;
    assert.match(bad.problems[0].message, /"Quarter" is not a size of "Paneer Tikka"/);
    const exported = (await O("GET", "/menu/products/export")).data;
    const row = exported.rows.find((r) => r.name === "Paneer Tikka");
    assert.equal(row.kitchenName, TAMIL);
    assert.equal(row.sizeKitchenNames, "Half=அரை");
    assert.equal(row.addOnKitchenNames, "Extra cheese=சீஸ்");
    const back = (await O("POST", "/menu/products/import", { rows: exported.rows, dryRun: true })).data;
    assert.equal(back.updated, 0);
    assert.equal(back.created, 0);
  });
});
