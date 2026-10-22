const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// Food formats on the restaurant engine: a bakery (counter-first, sold by
// weight, cake pre-orders with an advance billed on collection, unsold at the
// day's end), a cloud kitchen (no dine-in, tokens on deliveries) and a café.
// Own throwaway database, like restaurant.test.js.
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const TOMORROW = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

test("food formats: café, bakery and cloud kitchen", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres" });
  let created = false, pool, server;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`);
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
  const rid = (await one("INSERT INTO restaurants (name,code) VALUES ('Sweet Crust','SWC') RETURNING id")).id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING", [rid]);
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const addUser = async (email, role) => {
    const user = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,$2,$2,$3) RETURNING id", [rid, email, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL", [user.id, role]);
  };
  await addUser("owner@test.invalid", "RESTAURANT_ADMIN");
  await addUser("cook@test.invalid", "KITCHEN");
  const category = (await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Cakes & cookies') RETURNING id", [rid])).id;

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, url, body, expected = 200, auth) {
    const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password })).data.token;
  let owner = await login("owner@test.invalid");
  const cook = await login("cook@test.invalid");
  const O = (method, url, body, expected) => request(method, url, body, expected, owner);

  let cake, cookies;
  await t.test("a bakery: the format sets the POS, tokens and features", async () => {
    assert.equal((await O("GET", "/restaurants/current/format")).data.code, "restaurant");
    await request("PUT", "/restaurants/current/format", { format: "bakery" }, 403, cook);
    await O("PUT", "/restaurants/current/format", { format: "pizzeria" }, 400);
    const set = (await O("PUT", "/restaurants/current/format", { format: "bakery" })).data;
    assert.equal(set.label, "Bakery");
    assert.deepEqual(set.skipped, []);
    const service = (await O("GET", "/orders/service-settings")).data;
    assert.deepEqual(service.posOrderTypes, ["takeaway", "delivery"]);
    assert.equal(service.defaultOrderType, "takeaway");
    owner = await login("owner@test.invalid");
    const me = (await O("GET", "/auth/me")).data;
    assert.equal((me.user || me).restaurantFormat, "bakery");
    assert.ok((me.user || me).features.includes("preorders"));
    assert.ok(!(me.user || me).features.includes("reservations"));
    // The owner can still change the POS's kinds of order one by one.
    await O("PUT", "/orders/service-settings/pos", { posOrderTypes: ["takeaway"], defaultOrderType: "delivery" }, 400);
    assert.deepEqual((await O("PUT", "/orders/service-settings/pos", { posOrderTypes: ["takeaway", "delivery", "dine_in"] })).data.posOrderTypes, ["takeaway", "delivery", "dine_in"]);
    await O("PUT", "/orders/service-settings/pos", { posOrderTypes: ["takeaway", "delivery"] });
  });

  await t.test("sold by weight: the price is per kg; a dine-in is refused where the POS takes none", async () => {
    cake = (await O("POST", "/menu/products", { categoryId: category, name: "Black forest cake (1 kg)", price: 800, taxPercentage: 0 }, 201)).data;
    cookies = (await O("POST", "/menu/products", { categoryId: category, name: "Butter cookies", price: 600, taxPercentage: 0, soldBy: "weight" }, 201)).data;
    assert.equal(cake.soldBy, "unit");
    assert.equal(cookies.soldBy, "weight");
    await O("POST", "/menu/products", { categoryId: category, name: "Bad", price: 1, taxPercentage: 0, soldBy: "litre" }, 400);
    await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 500 }, 201);
    const floor = (await one("INSERT INTO floors(restaurant_id,name) VALUES ($1,'Shop') RETURNING id", [rid])).id;
    const table = (await one("INSERT INTO dining_tables(restaurant_id,floor_id,table_no,capacity,qr_token) VALUES ($1,$2,'S1',2,$3) RETURNING id", [rid, floor, crypto.randomBytes(16).toString("hex")])).id;
    const refused = await O("POST", "/orders", { orderType: "dine_in", tableId: table, items: [{ productId: cake.id, quantity: 1 }] }, 400);
    assert.equal(refused.data?.reason || refused.reason, "order_type_off");
    const order = (await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: cookies.id, quantity: 0.25 }] }, 201)).data;
    assert.equal(Number(order.items[0].quantity), 0.25);
    assert.equal(Number(order.subtotal), 150);
  });

  let preorder;
  await t.test("a cake pre-order: message, advance, bake list, ready, and billed on collection", async () => {
    const dueAt = new Date(`${TOMORROW}T17:30:00+05:30`).toISOString();
    await O("POST", "/preorders", { customerName: "Riya", customerMobile: "9876500001", dueAt: new Date(Date.now() - 86400000).toISOString(), items: [{ productId: cake.id, quantity: 1 }] }, 400);
    await O("POST", "/preorders", { customerName: "Riya", customerMobile: "9876500001", dueAt, items: [{ productId: cake.id, quantity: 1 }], advance: { amount: 900, paymentMethod: "upi" } }, 400);
    preorder = (await O("POST", "/preorders", { customerName: "Riya Sharma", customerMobile: "9876500001", dueAt, notes: "Pick up after school",
      items: [{ productId: cake.id, quantity: 1, notes: "Happy Birthday Riya · eggless · pink roses" }, { productId: cookies.id, quantity: 0.5 }],
      advance: { amount: 500, paymentMethod: "upi", transactionRef: "UPI4411" } }, 201)).data;
    assert.equal(preorder.number, "PRE-0001");
    assert.equal(preorder.estimatedTotal, 1100);
    assert.equal(preorder.advanceAmount, 500);
    assert.equal(preorder.balanceDue, 600);
    assert.match(preorder.advanceReceipt, /^ADV/);
    assert.equal((await one("SELECT purpose FROM customer_advances WHERE id=$1", [preorder.advanceId])).purpose, "Pre-order PRE-0001");
    // The baker's list for tomorrow.
    const bake = (await O("GET", `/preorders/bake-list?day=${TOMORROW}`)).data;
    const cakeLine = bake.items.find((i) => i.productId === cake.id);
    assert.equal(cakeLine.quantity, 1);
    assert.equal(cakeLine.orders[0].notes, "Happy Birthday Riya · eggless · pink roses");
    assert.equal((await O("GET", "/preorders")).data.length, 1);
    await request("POST", `/preorders/${preorder.id}/status`, { status: "ready" }, 403, cook);
    await O("POST", `/preorders/${preorder.id}/status`, { status: "in_production" });
    assert.equal((await O("POST", `/preorders/${preorder.id}/status`, { status: "ready" })).data.status, "ready");
    await O("POST", `/preorders/${preorder.id}/status`, { status: "in_production" }, 409);
    // Collected: a takeaway order with the message, the advance on it.
    const handed = (await O("POST", `/preorders/${preorder.id}/collect`, {}, 201)).data;
    assert.equal(handed.preorder.status, "collected");
    const order = (await O("GET", `/orders/${handed.orderId}`)).data;
    assert.equal(order.orderType, "takeaway");
    assert.equal(Number(order.subtotal), 1100);
    assert.equal(order.items.find((i) => Number(i.productId) === Number(cake.id)).notes, "Happy Birthday Riya · eggless · pink roses");
    assert.equal(Number((await one("SELECT order_id FROM customer_advances WHERE id=$1", [preorder.advanceId])).order_id), handed.orderId);
    // Collecting again is the same hand-over.
    assert.equal((await O("POST", `/preorders/${preorder.id}/collect`, {}, 201)).data.orderId, handed.orderId);
    // A cancelled one keeps its advance held for a refund.
    const other = (await O("POST", "/preorders", { customerName: "Arjun", customerMobile: "9876500002", dueAt, items: [{ productId: cake.id, quantity: 2 }],
      advance: { amount: 200, paymentMethod: "cash" } }, 201)).data;
    const cancelled = await O("POST", `/preorders/${other.id}/cancel`, { reason: "Party called off" });
    assert.equal(cancelled.data.status, "cancelled");
    assert.match(cancelled.message, /still held/);
    await O("POST", `/preorders/${other.id}/collect`, {}, 409);
  });

  await t.test("unsold at the day's end is a reason for waste", async () => {
    await pool.query("INSERT INTO stock_transactions (restaurant_id, inventory_item_id, transaction_type, quantity, waste_reason) SELECT $1, NULL, 'wastage', -1, 'unsold' WHERE FALSE", [rid]);
    const reasons = require("../../src/modules/restaurant/inventory/services/inventoryInsight.service").REASONS;
    assert.ok(reasons.some((r) => r.key === "unsold"));
    const check = await one("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='chk_stock_transactions_waste_reason'");
    assert.match(check.def, /unsold/);
  });

  await t.test("a cloud kitchen takes no dine-in; deliveries and parcels get tokens", async () => {
    const set = (await O("PUT", "/restaurants/current/format", { format: "cloud_kitchen" })).data;
    assert.equal(set.label, "Cloud kitchen");
    const service = (await O("GET", "/orders/service-settings")).data;
    assert.deepEqual(service.posOrderTypes, ["delivery", "takeaway"]);
    assert.equal(service.defaultOrderType, "delivery");
    assert.equal(service.tokensEnabled, true);
    const parcel = (await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: cake.id, quantity: 1 }] }, 201)).data;
    assert.ok(parcel.tokenNo >= 1);
    // Brands: one kitchen, several names (on with the cloud kitchen format).
    owner = await login("owner@test.invalid");
    assert.ok((await O("GET", "/auth/me")).data.features.includes("brands"));
    await request("POST", "/menu/brands", { name: "Wrap Republic" }, 403, cook);
    const biryani = (await O("POST", "/menu/brands", { name: "Biryani Box", tagline: "Hyderabadi dum biryani", color: "#b45309" }, 201)).data;
    const wraps = (await O("POST", "/menu/brands", { name: "Wrap Republic" }, 201)).data;
    await O("POST", "/menu/brands", { name: "wrap republic" }, 409);
    const wrapCat = (await O("POST", "/menu/categories", { name: "Rolls & wraps", brandId: wraps.id }, 201)).data;
    assert.equal(wrapCat.brandId, wraps.id);
    const roll = (await O("POST", "/menu/products", { categoryId: wrapCat.id, name: "Chicken kathi roll", price: 189, taxPercentage: 0 }, 201)).data;
    const biryaniCat = (await O("POST", "/menu/categories", { name: "Biryani", brandId: biryani.id }, 201)).data;
    const dum = (await O("POST", "/menu/products", { categoryId: biryaniCat.id, name: "Chicken dum biryani", price: 329, taxPercentage: 0 }, 201)).data;
    // The shared category (Cakes & cookies, no brand) is on every brand's menu.
    const wrong = await O("POST", "/orders", { orderType: "delivery", brandId: biryani.id, items: [{ productId: roll.id, quantity: 1 }] }, 400);
    assert.match(wrong.message, /Wrap Republic's menu/);
    const order = (await O("POST", "/orders", { orderType: "delivery", brandId: biryani.id, items: [{ productId: dum.id, quantity: 2 }, { productId: cake.id, quantity: 1 }] }, 201)).data;
    assert.equal(order.brandName, "Biryani Box");
    // Adding a dish to that order later follows the same menu.
    const open = (await O("POST", "/orders", { orderType: "delivery", brandId: biryani.id, items: [{ productId: dum.id, quantity: 1 }] }, 201)).data;
    const added = await O("PUT", `/orders/${open.id}/items`, { changesOnly: true, items: [{ productId: roll.id, quantity: 1 }] }, 400);
    assert.match(added.message, /Wrap Republic's menu/);
    await O("PUT", `/orders/${open.id}/items`, { changesOnly: true, items: [{ productId: cake.id, quantity: 1 }] });
    assert.equal((await O("GET", `/orders/${open.id}`)).data.items.length, 2);
    await O("PATCH", `/orders/${open.id}/cancel`, { reason: "Test order" });
    const bill = (await O("POST", "/bills", { orderId: order.id }, 201)).data;
    assert.equal(bill.brandName, "Biryani Box");
    await O("POST", "/orders", { orderType: "delivery", brandId: wraps.id, items: [{ productId: roll.id, quantity: 1 }] }, 201);
    const report = (await O("GET", `/menu/brands/report?from=${TODAY}&to=${TODAY}`)).data;
    const mine = report.brands.find((b) => b.brandId === biryani.id);
    assert.equal(mine.bills, 1);
    assert.equal(mine.sales, Number(bill.totalAmount));
    const brands = (await O("GET", "/menu/brands")).data;
    assert.deepEqual(brands.map((b) => [b.name, b.categoryCount]), [["Biryani Box", 1], ["Wrap Republic", 1]]);
    await O("PUT", `/menu/brands/${wraps.id}`, { name: "Wrap Republic", status: "inactive" });
    await O("POST", "/orders", { orderType: "delivery", brandId: wraps.id, items: [{ productId: roll.id, quantity: 1 }] }, 409);
    // A café: the counter starts on takeaway, dine-in allowed.
    const cafe = (await O("PUT", "/restaurants/current/format", { format: "cafe" })).data;
    assert.equal(cafe.label, "Café");
    assert.equal((await O("GET", "/orders/service-settings")).data.defaultOrderType, "takeaway");
    assert.equal((await one("SELECT format FROM restaurants WHERE id=$1", [rid])).format, "cafe");
  });
});
