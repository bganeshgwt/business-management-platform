// Service, deliveries and captains, end to end on a throwaway database of
// its own (the same pattern as restaurant.test.js — never DB_NAME):
//
//   - a large party booked across several tables
//   - the delivery charge on own-delivery orders, waived with a reason
//   - a regular's saved delivery addresses and last orders
//   - a rider's cash settled in one step, a shortfall kept as owed
//   - captain sections
//   - staff tied to an outlet with its own tables stay on them
//   - the kitchen board on an outlet reads the outlet's own day
//   - "Every dish" cancelled after KOT pages through the server
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { addDays } = require("./helpers/dates");

test("service, deliveries and captains", { timeout: 600000 }, async (t) => {
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
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      }
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  process.env.LOGIN_ATTEMPT_LIMIT = "500";
  const { runner } = await import("node-pg-migrate");
  await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"),
    migrationsTable: "pgmigrations", direction: "up", count: Infinity, checkOrder: true, log() {} });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const role = (code) => one("SELECT id FROM roles WHERE code = $1 AND restaurant_id IS NULL", [code]);
  const addUser = async (rid, name, email, roleCode, outletId = null, pin = null) => {
    const user = await one(
      "INSERT INTO users (restaurant_id,name,email,password_hash,outlet_id,pin_hash,pin_set_at) VALUES ($1,$2,$3,$4,$5,$6::varchar,CASE WHEN $6::varchar IS NULL THEN NULL ELSE NOW() END) RETURNING id",
      [rid, name, email, hash, outletId, pin ? await bcrypt.hash(pin, 4) : null]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)", [user.id, (await role(roleCode)).id]);
    return user;
  };

  const restaurant = await one("INSERT INTO restaurants (name,code) VALUES ('Service test','SVCB') RETURNING id");
  const rid = restaurant.id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING", [rid]);
  const outletA = await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Banjara Hills','BH') RETURNING id", [rid]);
  await addUser(rid, "Owner", "owner@test.invalid", "RESTAURANT_ADMIN");
  const captainUser = await addUser(rid, "Ramesh", "captain@test.invalid", "CAPTAIN");
  await addUser(rid, "Cashier", "cashier@test.invalid", "CASHIER");
  const manager = await addUser(rid, "Manager", "manager@test.invalid", "MANAGER", null, "5931");
  await addUser(rid, "Manager A", "managera@test.invalid", "MANAGER", outletA.id);
  const other = await one("INSERT INTO restaurants(name,code) VALUES ('Other','OTHERS') RETURNING id");
  await addUser(other.id, "Other owner", "other@test.invalid", "RESTAURANT_ADMIN");
  const category = await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Food') RETURNING id", [rid]);
  const dish = async (name, price) =>
    one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES ($1,$2,$3,$4,5) RETURNING id", [rid, category.id, name, price]);
  const roti = await dish("Tandoori Roti", 30);
  const tikka = await dish("Paneer Tikka", 300);
  const floor = await one("INSERT INTO floors(restaurant_id,name) VALUES ($1,'Hall') RETURNING id", [rid]);
  const table = async (no, capacity = 4, outletId = null) =>
    one("INSERT INTO dining_tables(restaurant_id,floor_id,table_no,capacity,qr_token,outlet_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [rid, floor.id, no, capacity, crypto.randomBytes(16).toString("hex"), outletId]);
  const T = {};
  for (let i = 1; i <= 6; i += 1) T[i] = await table(`T${i}`);
  const A1 = await table("A1", 4, outletA.id);
  const rider = await one("INSERT INTO employees (restaurant_id, name, department) VALUES ($1, 'Ravi', 'delivery') RETURNING id", [rid]);

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const send = async (method, url, body, token, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  };
  const expect = async (method, url, body, expected, token, headers) => {
    const result = await send(method, url, body, token, headers);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  };
  const login = async (email) => (await expect("POST", "/auth/login", { identifier: email, password }, 200)).token;
  const owner = await login("owner@test.invalid");
  const captain = await login("captain@test.invalid");
  const cashier = await login("cashier@test.invalid");
  const managerA = await login("managera@test.invalid");
  const foreign = await login("other@test.invalid");
  const atA = { "X-Outlet-Id": String(outletA.id) };
  const items = (...pairs) => pairs.map(([product, quantity]) => ({ productId: product.id, quantity }));

  await expect("POST", "/business-day/open", { openingCash: 1000 }, 201, owner);
  await expect("POST", "/business-day/open", { openingCash: 500 }, 201, owner, atA);
  const today = (await one("SELECT business_date::text AS d FROM business_days WHERE restaurant_id = $1 AND outlet_id IS NULL", [rid])).d;

  await t.test("a large party holds several tables, and none can be booked twice", async () => {
    const date = addDays(today, 2);
    const party = { guestName: "Mehta family", partySize: 10, date, startTime: "20:00", durationMinutes: 120 };
    await expect("POST", "/reservations", { ...party, tableId: T[1].id, extraTableIds: [T[2].id] }, 400, owner);
    const booking = await expect("POST", "/reservations",
      { ...party, tableId: T[1].id, extraTableIds: [T[2].id, T[3].id], overrideCapacity: true, capacityOverrideReason: "Kids on laps" }, 201, owner);
    assert.deepEqual(booking.tables.map((x) => x.tableNo), ["T1", "T2", "T3"]);
    await expect("POST", "/reservations", { guestName: "Other", partySize: 2, date, startTime: "21:00", tableId: T[3].id }, 409, owner);
    await expect("PATCH", `/reservations/${booking.id}/cancel`, { reason: "Plans changed" }, 200, owner);
    await expect("POST", "/reservations", { guestName: "Other", partySize: 2, date, startTime: "21:00", tableId: T[3].id }, 201, owner);
  });

  await t.test("own delivery is charged by the server, free above a total, waived with a reason", async () => {
    const channels = await expect("GET", "/deliveries/channels", undefined, 200, owner);
    const own = channels.find((c) => c.type === "own");
    await expect("PUT", `/deliveries/channels/${own.id}`, { name: own.name, type: own.type, deliveryCharge: 40, deliveryFreeAbove: 500 }, 200, owner);
    const small = await expect("POST", "/orders", { orderType: "delivery", customerName: "Door", deliveryCharge: 1, items: items([roti, 2]) }, 201, owner);
    assert.equal(small.deliveryCharge, 40);
    const big = await expect("PUT", `/orders/${small.id}/items`, { changesOnly: true, items: items([tikka, 2]) }, 200, owner);
    assert.equal(big.deliveryCharge, 0);
    const second = await expect("POST", "/orders", { orderType: "delivery", customerName: "Door 2", items: items([roti, 1]) }, 201, owner);
    await expect("POST", `/orders/${second.id}/delivery-charge/waive`, {}, 400, cashier);
    const asked = await send("POST", `/orders/${second.id}/delivery-charge/waive`, { reason: "Regular" }, cashier);
    assert.equal(asked.status, 403);
    assert.equal(asked.body.data.scope.amount, 40);
    const waived = await expect("POST", `/orders/${second.id}/delivery-charge/waive`, { reason: "Regular" }, 200, owner);
    assert.equal(waived.deliveryCharge, 0);
    assert.equal(waived.deliveryChargeWaivedReason, "Regular");
    await expect("POST", `/orders/${second.id}/delivery-charge/restore`, undefined, 404, foreign);
  });

  await t.test("a new delivery address is kept on the guest, offered masked to a cashier, and gone when erased", async () => {
    const order = await expect("POST", "/orders", { orderType: "delivery", customerMobile: "9812345601", customerName: "Anita", items: items([roti, 1]) }, 201, owner);
    await expect("PATCH", `/deliveries/${order.id}`, { address: "Flat 4, Sai Residency, Banjara Hills", landmark: "Near the temple", addressLabel: "Office" }, 200, owner);
    const forOwner = (await expect("GET", "/orders/guest?mobile=9812345601", undefined, 200, owner)).guest;
    assert.equal(forOwner.addresses[0].address, "Flat 4, Sai Residency, Banjara Hills");
    assert.equal(forOwner.addresses[0].label, "Office");
    assert.equal(forOwner.recentOrders.length, 1);
    const forCashier = (await expect("GET", "/orders/guest?mobile=9812345601", undefined, 200, cashier)).guest;
    assert.equal(forCashier.addresses[0].address, "…, Banjara Hills");
    const next = await expect("POST", "/orders", { orderType: "delivery", customerMobile: "9812345601", items: items([roti, 1]) }, 201, cashier);
    await expect("PATCH", `/deliveries/${next.id}`, { savedAddressId: forCashier.addresses[0].id }, 200, cashier);
    assert.equal((await expect("GET", `/orders/${next.id}`, undefined, 200, owner)).deliveryAddress, "Flat 4, Sai Residency, Banjara Hills");
    await expect("GET", `/crm/customers/${forOwner.id}/addresses`, undefined, 404, foreign);
    await expect("POST", `/crm/customers/${forOwner.id}/erase`, { reason: "Asked" }, 200, owner);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM customer_addresses WHERE customer_id = $1", [forOwner.id])).n, 0);
  });

  await t.test("a rider's bills are paid in one step; a shortfall is kept as owed; nobody pays a bill twice", async () => {
    const bills = [];
    for (const qty of [2, 3]) {
      const order = await expect("POST", "/orders", { orderType: "delivery", customerName: "Door", items: items([roti, qty]) }, 201, owner);
      await pool.query("UPDATE orders SET rider_employee_id = $2, delivery_status = 'delivered', dispatched_at = NOW(), delivered_at = NOW() WHERE id = $1", [order.id, rider.id]);
      bills.push(await expect("POST", "/bills", { orderId: order.id }, 201, owner));
    }
    const preview = await expect("GET", `/deliveries/riders/${rider.id}/settlement`, undefined, 200, cashier);
    assert.equal(preview.bills.length, 2);
    const expected = preview.cashExpected;
    const body = { bills: bills.map((b) => ({ billId: b.id, method: "cash" })), cashHanded: expected - 10, shortfallReason: "Change given" };
    const [first, second] = await Promise.all([
      send("POST", `/deliveries/riders/${rider.id}/settle`, body, cashier),
      send("POST", `/deliveries/riders/${rider.id}/settle`, body, owner),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const settled = (first.status === 201 ? first : second).body.data;
    assert.equal(settled.shortfall, 10);
    assert.equal(settled.shortfallAction, "owed");
    const paid = await one("SELECT COUNT(*)::int AS n FROM payments WHERE bill_id = ANY($1::bigint[])", [bills.map((b) => b.id)]);
    assert.equal(paid.n, 2);
    const report = await expect("GET", "/deliveries/rider-settlements", undefined, 200, cashier);
    assert.equal(report.owed.length, 1);
    await expect("POST", `/deliveries/rider-settlements/${settled.id}/repaid`, undefined, 404, foreign);
  });

  await t.test("captain sections: the most specific line wins, and calls carry their captain", async () => {
    await expect("PUT", "/tables/sections", { date: today, assignments: [] }, 403, captain);
    await expect("PUT", "/tables/sections", { date: today, assignments: [{ userId: captainUser.id, floorId: floor.id }, { userId: manager.id, tableId: T[4].id }] }, 200, owner);
    const floorPlan = await expect("GET", "/tables", undefined, 200, captain);
    assert.equal(floorPlan.find((x) => x.id === T[1].id).captain.userId, Number(captainUser.id));
    assert.equal(floorPlan.find((x) => x.id === T[4].id).captain.userId, Number(manager.id));
  });

  await t.test("a manager tied to an outlet with tables of its own cannot ring up a main-room table", async () => {
    const refused = await send("POST", "/orders", { orderType: "dine_in", tableId: T[5].id, items: items([roti, 1]) }, managerA);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.data.reason, "table_main_counter");
    const own = await expect("POST", "/orders", { orderType: "dine_in", tableId: A1.id, items: items([roti, 1]) }, 201, managerA);
    assert.equal(Number(own.outletId), Number(outletA.id));
  });

  await t.test("the kitchen board on an outlet reads the outlet's own business day", async () => {
    const mainDay = await one("SELECT id FROM business_days WHERE restaurant_id = $1 AND outlet_id IS NULL", [rid]);
    await pool.query("UPDATE business_days SET business_date = business_date - 1 WHERE id = $1", [mainDay.id]);
    try {
      const board = await expect("GET", "/kitchen/board", undefined, 200, owner, atA);
      assert.equal(board.businessDay.date, today);
      const whole = await expect("GET", "/kitchen/board", undefined, 200, owner);
      assert.notEqual(whole.businessDay.date, today);
    } finally {
      await pool.query("UPDATE business_days SET business_date = business_date + 1 WHERE id = $1", [mainDay.id]);
    }
  });

  await t.test("dishes cancelled after KOT page through the server", async () => {
    const order = await expect("POST", "/orders", { orderType: "takeaway", items: items([roti, 1], [tikka, 1]) }, 201, owner);
    await expect("GET", `/kitchen/board`, undefined, 200, owner);
    await expect("PATCH", `/orders/${order.id}/cancel`, { reason: "Guest left" }, 200, owner);
    const firstPage = await expect("GET", `/orders/cancellations?limit=1&offset=0&from=${today}&to=${today}`, undefined, 200, owner);
    const secondPage = await expect("GET", `/orders/cancellations?limit=1&offset=1&from=${today}&to=${today}`, undefined, 200, owner);
    assert.ok(firstPage.total >= 2, JSON.stringify(firstPage.total));
    assert.equal(firstPage.items.length, 1);
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
  });
});
