const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// Food formats on the restaurant engine: a bakery (counter-first, sold by
// weight, cake pre-orders with an advance billed on collection, a bake list
// per till that the kitchen reads too, pre-orders kept to the outlet of staff
// tied to one, no closing an outlet with pre-orders still open, unsold at the
// day's end), a cloud kitchen (no dine-in, tokens on deliveries) and a café
// (pre-orders with no advance while Advances is off). Own throwaway
// database, like restaurant.test.js.
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
  // restaurant: Sweet Crust unless another is named; outletId: tied to that outlet.
  const addUser = async (email, role, restaurant = rid, outletId = null) => {
    const user = await one("INSERT INTO users (restaurant_id,name,email,password_hash,outlet_id) VALUES ($1,$2,$2,$3,$4) RETURNING id", [restaurant, email, hash, outletId]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL", [user.id, role]);
  };
  await addUser("owner@test.invalid", "RESTAURANT_ADMIN");
  await addUser("cook@test.invalid", "KITCHEN");
  const category = (await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Cakes & cookies') RETURNING id", [rid])).id;

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  // headers: e.g. { "X-Outlet-Id": "3" }, the outlet picked at the top of the screen.
  async function request(method, url, body, expected = 200, auth, headers = {}) {
    const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password })).data.token;
  let owner = await login("owner@test.invalid");
  const cook = await login("cook@test.invalid");
  const O = (method, url, body, expected, headers) => request(method, url, body, expected, owner, headers);

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
    // A wrong payment type for the advance is refused before anything is saved:
    // no pre-order, and no new guest either.
    const count = async (table) => (await one(`SELECT count(*)::int AS n FROM ${table} WHERE restaurant_id=$1`, [rid])).n;
    const before = await count("restaurant_preorders");
    const guests = await count("customers");
    const meera = { customerName: "Meera", customerMobile: "9876500003", dueAt, items: [{ productId: cake.id, quantity: 1 }] };
    const badType = await O("POST", "/preorders", { ...meera, advance: { amount: 300, paymentMethod: "upi", paymentTypeId: 999999 } }, 400);
    assert.match(badType.message, /payment type was not found/);
    assert.equal(await count("restaurant_preorders"), before);
    assert.equal(await count("customers"), guests);
    // The till cannot take the advance (no business day open): the pre-order is
    // booked all the same, the message says so, and the advance is taken later.
    await pool.query("UPDATE business_days SET day_status='closed' WHERE restaurant_id=$1 AND day_status='open'", [rid]);
    let booked;
    try {
      booked = await O("POST", "/preorders", { ...meera, advance: { amount: 300, paymentMethod: "cash" } }, 201);
      // With no day open, the baker's list opens on the restaurant's own date.
      assert.equal((await O("GET", "/preorders/bake-list")).data.day, TODAY);
    } finally {
      await pool.query("UPDATE business_days SET day_status='open' WHERE restaurant_id=$1 AND business_date=$2", [rid, TODAY]);
    }
    assert.match(booked.data.advanceRefused, /Open the business day first/);
    assert.match(booked.message, /booked for Meera, but the advance was not taken: Open the business day first\..* Take it from the pre-order/);
    assert.equal(booked.data.advanceId, null);
    assert.equal(await count("restaurant_preorders"), before + 1);
    const paid = (await O("POST", `/preorders/${booked.data.id}/advance`, { amount: 300, paymentMethod: "cash" }, 201)).data;
    assert.match(paid.advanceReceipt, /^ADV/);
    assert.equal(paid.balanceDue, 500);
    // Asked without a day, the baker's list is the open business day's, not the
    // calendar's (as after midnight with last night's day still open). Here the
    // open day is moved to tomorrow's date to tell the two apart.
    assert.equal((await O("GET", "/preorders/bake-list")).data.day, TODAY);
    await pool.query("UPDATE business_days SET business_date=$2 WHERE restaurant_id=$1 AND day_status='open'", [rid, TOMORROW]);
    try {
      const bakes = (await O("GET", "/preorders/bake-list")).data;
      assert.equal(bakes.day, TOMORROW);
      assert.ok(bakes.items.some((i) => i.productId === cake.id));
    } finally {
      await pool.query("UPDATE business_days SET business_date=$2 WHERE restaurant_id=$1 AND day_status='open'", [rid, TODAY]);
    }
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
    // Brands switched off: no new order or category under a brand. An order
    // taken under one before keeps its brand and can still be added to.
    const pending = (await O("POST", "/orders", { orderType: "delivery", brandId: biryani.id, items: [{ productId: dum.id, quantity: 1 }] }, 201)).data;
    await O("PUT", "/restaurants/current/features/brands", { enabled: false });
    const off = await O("POST", "/orders", { orderType: "delivery", brandId: biryani.id, items: [{ productId: dum.id, quantity: 1 }] }, 403);
    assert.equal(off.data?.reason || off.reason, "feature_off");
    await O("POST", "/menu/categories", { name: "Bowls", brandId: biryani.id }, 403);
    // A category keeps the brand it has (saved again as it is), but cannot be given another.
    assert.equal((await O("PUT", `/menu/categories/${wrapCat.id}`, { name: "Rolls & wraps", brandId: wraps.id })).data.brandId, wraps.id);
    await O("PUT", `/menu/categories/${wrapCat.id}`, { name: "Rolls & wraps", brandId: biryani.id }, 403);
    await O("POST", "/orders", { orderType: "delivery", items: [{ productId: dum.id, quantity: 1 }] }, 201);
    await O("PUT", `/orders/${pending.id}/items`, { changesOnly: true, items: [{ productId: roll.id, quantity: 1 }] });
    const kept = (await O("GET", `/orders/${pending.id}`)).data;
    assert.equal(kept.items.length, 2);
    assert.equal(kept.brandName, "Biryani Box");
    await O("PUT", "/restaurants/current/features/brands", { enabled: true });
    await O("PATCH", `/orders/${pending.id}/cancel`, { reason: "Test order" });
    // A café: the counter starts on takeaway, dine-in allowed.
    const cafe = (await O("PUT", "/restaurants/current/format", { format: "cafe" })).data;
    assert.equal(cafe.label, "Café");
    assert.equal((await O("GET", "/orders/service-settings")).data.defaultOrderType, "takeaway");
    assert.equal((await one("SELECT format FROM restaurants WHERE id=$1", [rid])).format, "cafe");
  });

  await t.test("Advances off: a pre-order is booked without an advance, and none is taken on it", async () => {
    // A café of its own, whose owner has switched Advances off. The café
    // format leaves that switch as it is; the bakery format switches it on.
    const cafe = (await one("INSERT INTO restaurants (name,code) VALUES ('Bean & Bun','BNB') RETURNING id")).id;
    await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING", [cafe]);
    await addUser("cafe@test.invalid", "RESTAURANT_ADMIN", cafe);
    const cafeOwner = await login("cafe@test.invalid");
    const C = (method, url, body, expected) => request(method, url, body, expected, cafeOwner);
    await C("PUT", "/restaurants/current/features/advances", { enabled: false });
    assert.equal((await C("PUT", "/restaurants/current/format", { format: "cafe" })).data.label, "Café");
    const features = (await C("GET", "/auth/me")).data.features;
    assert.ok(features.includes("preorders"));
    assert.ok(!features.includes("advances"));
    const trays = (await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Party trays') RETURNING id", [cafe])).id;
    const tray = (await C("POST", "/menu/products", { categoryId: trays, name: "Sandwich tray", price: 1200, taxPercentage: 0 }, 201)).data;
    // A day is open: the till could take the money, were Advances on.
    await C("POST", "/business-day/open", { businessDate: TODAY, openingCash: 500 }, 201);
    const count = async (table) => (await one(`SELECT count(*)::int AS n FROM ${table} WHERE restaurant_id=$1`, [cafe])).n;
    const guests = await count("customers");
    const party = { customerName: "Nisha", customerMobile: "9876500021", dueAt: new Date(`${TOMORROW}T12:00:00+05:30`).toISOString(),
      items: [{ productId: tray.id, quantity: 2 }] };
    // An advance is refused as any switched-off feature is, before anything
    // is saved: no pre-order, no new guest.
    const refused = await C("POST", "/preorders", { ...party, advance: { amount: 500, paymentMethod: "upi", transactionRef: "UPI7788" } }, 403);
    assert.equal(refused.data.reason, "feature_off");
    assert.equal(refused.data.feature, "advances");
    assert.equal(await count("restaurant_preorders"), 0);
    assert.equal(await count("customers"), guests);
    // Without one, the pre-order is booked: the whole value due on pickup.
    const booked = (await C("POST", "/preorders", party, 201)).data;
    assert.equal(booked.number, "PRE-0001");
    assert.equal(booked.advanceId, null);
    assert.equal(booked.balanceDue, 2400);
    // Taking the advance later is refused the same way, and nothing is taken.
    const later = await C("POST", `/preorders/${booked.id}/advance`, { amount: 500, paymentMethod: "cash" }, 403);
    assert.equal(later.data.reason, "feature_off");
    assert.equal(later.data.feature, "advances");
    assert.equal(await count("customer_advances"), 0);
    // The bakery format switches Advances on, and the advance is taken.
    assert.deepEqual((await C("PUT", "/restaurants/current/format", { format: "bakery" })).data.skipped, []);
    assert.ok((await C("GET", "/auth/me")).data.features.includes("advances"));
    const paid = (await C("POST", `/preorders/${booked.id}/advance`, { amount: 500, paymentMethod: "cash" }, 201)).data;
    assert.match(paid.advanceReceipt, /^ADV/);
    assert.equal(paid.balanceDue, 1900);
  });

  await t.test("the bake list is the till's: its outlet's pre-orders, or the main counter's", async () => {
    const bakeFor = async (auth, headers) => (await request("GET", `/preorders/bake-list?day=${TOMORROW}`, undefined, 200, auth, headers)).data;
    const lines = (list) => list.items.map((item) => [item.name, item.quantity]);
    // No outlets: one list for the whole restaurant (Meera's cake), naming no till.
    const single = await bakeFor(owner);
    assert.deepEqual(lines(single), [["Black forest cake (1 kg)", 1]]);
    assert.equal(single.counter, null);
    // Two shops open, and each books cakes for tomorrow.
    const kondapur = (await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Kondapur','KDP') RETURNING id", [rid])).id;
    const gachibowli = (await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Gachibowli','GCB') RETURNING id", [rid])).id;
    const at = (outletId) => ({ "X-Outlet-Id": String(outletId) });
    const dueAt = new Date(`${TOMORROW}T11:00:00+05:30`).toISOString();
    const kavya = (await O("POST", "/preorders", { customerName: "Kavya", customerMobile: "9876500011", dueAt,
      items: [{ productId: cake.id, quantity: 2, notes: "Happy anniversary" }] }, 201, at(kondapur))).data;
    assert.equal(kavya.outletName, "Kondapur");
    await O("POST", "/preorders", { customerName: "Gautam", customerMobile: "9876500012", dueAt,
      items: [{ productId: cake.id, quantity: 3 }, { productId: cookies.id, quantity: 1.5 }] }, 201, at(gachibowli));
    // Each outlet's list is its own pre-orders; the main counter's are those
    // booked with no outlet picked.
    const atKondapur = await bakeFor(owner, at(kondapur));
    assert.deepEqual(lines(atKondapur), [["Black forest cake (1 kg)", 2]]);
    assert.equal(atKondapur.items[0].orders[0].notes, "Happy anniversary");
    assert.deepEqual(atKondapur.counter, { outletId: kondapur, name: "Kondapur" });
    const atGachibowli = await bakeFor(owner, at(gachibowli));
    assert.deepEqual(lines(atGachibowli), [["Black forest cake (1 kg)", 3], ["Butter cookies", 1.5]]);
    assert.deepEqual(atGachibowli.counter, { outletId: gachibowli, name: "Gachibowli" });
    const atMain = await bakeFor(owner);
    assert.deepEqual(lines(atMain), [["Black forest cake (1 kg)", 1]]);
    assert.deepEqual(atMain.counter, { outletId: null, name: "Main counter" });
    // A cashier tied to Kondapur gets Kondapur's list without picking it.
    await addUser("kondapur@test.invalid", "CASHIER", rid, kondapur);
    const theirs = await bakeFor(await login("kondapur@test.invalid"));
    assert.deepEqual(lines(theirs), [["Black forest cake (1 kg)", 2]]);
    assert.equal(theirs.counter.name, "Kondapur");
  });

  // The outlets above, and the open pre-orders by guest: Kavya's at Kondapur,
  // Gautam's at Gachibowli, Meera's at the main counter.
  const outletOf = async (code) => Number((await one("SELECT id FROM outlets WHERE restaurant_id=$1 AND code=$2", [rid, code])).id);
  const openByGuest = async () => Object.fromEntries((await O("GET", "/preorders")).data.map((p) => [p.customerName, p]));

  await t.test("a user tied to an outlet sees and acts on its pre-orders only; another outlet's are not found", async () => {
    const kondapur = await outletOf("KDP");
    const { Kavya: kavya, Gautam: gautam, Meera: meera } = await openByGuest();
    const numbers = (list) => list.map((p) => p.number).sort();
    // The cashier tied to Kondapur: its pre-orders, open or all, and no other.
    const cashier = await login("kondapur@test.invalid");
    const K = (method, url, body, expected) => request(method, url, body, expected, cashier);
    assert.deepEqual(numbers((await K("GET", "/preorders")).data), [kavya.number]);
    assert.deepEqual(numbers((await K("GET", "/preorders?status=all")).data), [kavya.number]);
    // Gachibowli's, and the main counter's, are not found, whatever is asked.
    for (const other of [gautam, meera]) {
      for (const [method, url, body] of [
        ["GET", `/preorders/${other.id}`],
        ["POST", `/preorders/${other.id}/status`, { status: "in_production" }],
        ["POST", `/preorders/${other.id}/advance`, { amount: 100, paymentMethod: "cash" }],
        ["POST", `/preorders/${other.id}/collect`, {}],
        ["POST", `/preorders/${other.id}/cancel`, { reason: "Not ours" }],
      ]) {
        assert.equal((await K(method, url, body, 404)).message, "Pre-order not found", `${method} ${url}`);
      }
    }
    // And nothing was done to them.
    const after = await openByGuest();
    assert.deepEqual([after.Gautam.status, after.Gautam.advanceId, after.Meera.status], ["booked", null, "booked"]);
    // Its own are seen and moved along.
    assert.equal((await K("GET", `/preorders/${kavya.id}`)).data.number, kavya.number);
    assert.equal((await K("POST", `/preorders/${kavya.id}/status`, { status: "in_production" })).data.status, "in_production");
    // Not tied to an outlet: every outlet's, whichever outlet is picked at the top.
    const every = [kavya, gautam, meera].map((p) => p.number).sort();
    assert.deepEqual(numbers((await O("GET", "/preorders")).data), every);
    assert.deepEqual(numbers((await O("GET", "/preorders", undefined, 200, { "X-Outlet-Id": String(kondapur) })).data), every);
    assert.equal((await O("GET", `/preorders/${gautam.id}`, undefined, 200, { "X-Outlet-Id": String(kondapur) })).data.number, gautam.number);
  });

  await t.test("the kitchen reads the bake list (kds.view), and books, hands over and cancels nothing", async () => {
    const gachibowli = await outletOf("GCB");
    const { Meera: meera } = await openByGuest();
    // Kitchen display is off in a bakery: the kitchen's own permission is enough.
    assert.ok(!(await request("GET", "/auth/me", undefined, 200, cook)).data.features.includes("kitchen_display"));
    const bakes = (await request("GET", `/preorders/bake-list?day=${TOMORROW}`, undefined, 200, cook)).data;
    assert.deepEqual(bakes, (await O("GET", `/preorders/bake-list?day=${TOMORROW}`)).data);
    assert.deepEqual(bakes.items.map((item) => [item.name, item.quantity]), [["Black forest cake (1 kg)", 1]]);
    // The pre-orders themselves are the counter's.
    const dueAt = new Date(`${TOMORROW}T16:00:00+05:30`).toISOString();
    await request("GET", "/preorders", undefined, 403, cook);
    await request("GET", `/preorders/${meera.id}`, undefined, 403, cook);
    await request("POST", "/preorders", { customerName: "Cook", customerMobile: "9876500031", dueAt, items: [{ productId: cake.id, quantity: 1 }] }, 403, cook);
    await request("POST", `/preorders/${meera.id}/collect`, {}, 403, cook);
    await request("POST", `/preorders/${meera.id}/cancel`, { reason: "Oven broke down" }, 403, cook);
    assert.equal((await openByGuest()).Meera.status, "booked");
    // A baker tied to Gachibowli gets Gachibowli's list.
    await addUser("baker@test.invalid", "KITCHEN", rid, gachibowli);
    const theirs = (await request("GET", `/preorders/bake-list?day=${TOMORROW}`, undefined, 200, await login("baker@test.invalid"))).data;
    assert.deepEqual(theirs.counter, { outletId: gachibowli, name: "Gachibowli" });
    assert.deepEqual(theirs.items.map((item) => [item.name, item.quantity]), [["Black forest cake (1 kg)", 3], ["Butter cookies", 1.5]]);
  });

  await t.test("an outlet with open pre-orders is neither closed nor deleted until they are handed over or cancelled", async () => {
    const kondapur = await outletOf("KDP");
    const at = { "X-Outlet-Id": String(kondapur) };
    const lakshmi = (await O("POST", "/preorders", { customerName: "Lakshmi", customerMobile: "9876500013",
      dueAt: new Date(`${TOMORROW}T15:00:00+05:30`).toISOString(), items: [{ productId: cake.id, quantity: 1 }] }, 201, at)).data;
    const { Kavya: kavya } = await openByGuest();
    const closing = { name: "Kondapur", code: "KDP", status: "inactive" };
    const refused = await O("PUT", `/outlets/${kondapur}`, closing, 409);
    assert.equal(refused.message, `"Kondapur" still has 2 open pre-orders to bake and hand over (${kavya.number} and ${lakshmi.number}), so it cannot be closed yet. Hand them over or cancel them first, in Pre-orders & cakes.`);
    assert.deepEqual(refused.data, { reason: "outlet_has_open_preorders", preorders: [kavya.number, lakshmi.number] });
    assert.equal((await O("GET", `/outlets/${kondapur}`)).data.status, "active");
    // Deleting it would hand them to the main counter's list: refused the same way.
    await O("POST", `/preorders/${lakshmi.id}/cancel`, { reason: "Changed her mind" });
    const kept = await O("DELETE", `/outlets/${kondapur}`, undefined, 409);
    assert.equal(kept.message, `"Kondapur" still has 1 open pre-order to bake and hand over (${kavya.number}), so it cannot be deleted yet. Hand it over or cancel it first, in Pre-orders & cakes.`);
    assert.equal(kept.data.reason, "outlet_has_open_preorders");
    // Anything else about an open outlet is saved as before.
    assert.equal((await O("PUT", `/outlets/${kondapur}`, { name: "Kondapur", code: "KDP", contact: "040 2300 1111" })).data.contact, "040 2300 1111");
    // With none open, it closes.
    await O("POST", `/preorders/${kavya.id}/cancel`, { reason: "Shop closing" });
    assert.equal((await O("PUT", `/outlets/${kondapur}`, closing)).data.status, "inactive");
  });
});
