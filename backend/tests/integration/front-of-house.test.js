// The front of house's live screens, end to end on a throwaway database:
//
//   - an order taken on an earlier trading day and never closed is flagged
//     (GET /tables live.earlierDay, GET /orders earlierDay + summary.earlier)
//     and can be listed apart (?age=today|earlier, ?sort=oldest);
//   - the dashboard counts them (openOrdersEarlier) and says today's trading
//     date (tradingToday), so a counter's day left open is shown in red;
//   - the kitchen display is today's: a ticket from an earlier day is only
//     counted (earlierOpen) unless ?older=1 asks for it;
//   - the delivery board keeps an earlier day's delivery still in play but
//     never counts it as "running late", and flags a rider's run nobody closed;
//   - table requests from an earlier day are not "waiting" today, and
//     POST /table-requests/close-earlier closes them (orders.manage only).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");

const { today } = require("./helpers/dates");

test("front of house: earlier days flagged, live screens today-only", { timeout: 600000 }, async (t) => {
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
  const made = await restaurantService.createRestaurant({
    name: "Front House",
    code: "FRONT",
    admin: { name: "Front owner", email: "owner@front.invalid", password },
  });
  const rid = made.id;

  const app = require("../../src/app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, url, body, expected = 200, auth) {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (expected !== null) {
      assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    }
    return expected === null ? { status: response.status, ...result } : result.data;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password })).token;
  const owner = await login("owner@front.invalid");
  const O = (method, url, body, expected = 200) => request(method, url, body, expected, owner);

  // A captain: may see tables and orders, may not cancel or close requests.
  const bcrypt = require("bcrypt");
  const captainRole = (await pool.query("SELECT id FROM roles WHERE code = 'CAPTAIN' AND restaurant_id IS NULL")).rows[0].id;
  const captainId = (
    await pool.query(
      "INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, 'Cap', 'cap@front.invalid', $2) RETURNING id",
      [rid, await bcrypt.hash(password, 4)]
    )
  ).rows[0].id;
  await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [captainId, captainRole]);
  const captain = await login("cap@front.invalid");

  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0, timezone: "Asia/Kolkata", taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 0,
    autoConsumeStock: false, loyaltyEnabled: false, autoPrintBill: false, printShowQr: false,
  });
  const rate = await O("POST", "/menu/tax-rates", { name: "Food 5%", percentage: 5, hsnCode: "996331" }, 201);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dal = await O("POST", "/menu/products", { categoryId: category.id, name: "Dal", price: 200, taxRateId: rate.id, isAvailable: true }, 201);
  await O("POST", "/business-day/open", { businessDate: today(), openingCash: 1000 }, 201);
  const floor = await O("POST", "/tables/floors", { name: "Ground" }, 201);
  const t1 = await O("POST", "/tables", { floorId: floor.id, tableNo: "T1", capacity: 4 }, 201);
  const t2 = await O("POST", "/tables", { floorId: floor.id, tableNo: "T2", capacity: 4 }, 201);

  const dineIn = async (tableId) =>
    O("POST", "/orders", { orderType: "dine_in", tableId, guestCount: 2, items: [{ productId: dal.id, quantity: 1 }] }, 201);
  const old = await dineIn(t1.id);
  const fresh = await dineIn(t2.id);
  // The first one was taken three days ago and never closed.
  const backdate = (table, id, column = "placed_at") =>
    pool.query(`UPDATE ${table} SET ${column} = ${column} - INTERVAL '3 days' WHERE id = $1`, [id]);
  await backdate("orders", old.id);

  await t.test("tables flag the party left open from an earlier day", async () => {
    const tables = await O("GET", "/tables");
    const one = tables.find((row) => row.id === t1.id);
    const two = tables.find((row) => row.id === t2.id);
    assert.equal(one.floorState, "running");
    assert.equal(one.live.earlierDay, true);
    assert.equal(two.live.earlierDay, false);
    // A captain sees the same flag (tables.view).
    const asCaptain = await request("GET", "/tables", undefined, 200, captain);
    assert.equal(asCaptain.find((row) => row.id === t1.id).live.earlierDay, true);
  });

  await t.test("orders list: earlier-day flag, age filter, oldest first", async () => {
    const all = await O("GET", "/orders?status=open&sort=oldest");
    assert.equal(all.total, 2);
    assert.equal(all.items[0].id, old.id, "the oldest first");
    assert.equal(all.items[0].earlierDay, true);
    assert.equal(all.items[1].earlierDay, false);
    assert.equal(all.summary.earlier, 1);
    assert.equal(all.summary.earlierTables, 1);
    const todays = await O("GET", "/orders?status=open&age=today");
    assert.deepEqual(todays.items.map((row) => row.id), [fresh.id]);
    const earlier = await O("GET", "/orders?status=open&age=earlier");
    assert.deepEqual(earlier.items.map((row) => row.id), [old.id]);
    await O("GET", "/orders?age=yesterday", undefined, 400);
  });

  await t.test("dashboard counts them and names today's trading date", async () => {
    const dash = await O("GET", "/reports/dashboard");
    assert.equal(dash.openOrders, 2);
    assert.equal(dash.openOrdersEarlier.count, 1);
    assert.equal(dash.openOrdersEarlier.tables, 1);
    assert.ok(dash.openOrdersEarlier.value > 0, "the owner sees what they are worth");
    assert.match(dash.tradingToday, /^\d{4}-\d{2}-\d{2}$/);
    // Every open day of today is not "left open".
    assert.ok(dash.openDays.every((day) => day.businessDate >= dash.tradingToday));
    // A day left open from three days ago is older than tradingToday.
    await pool.query("UPDATE business_days SET business_date = business_date - 3 WHERE restaurant_id = $1", [rid]);
    await O("POST", "/kitchen/sync"); // any write clears the dashboard's short cache
    const later = await O("GET", "/reports/dashboard");
    assert.ok(later.openDays.some((day) => day.businessDate < later.tradingToday));
    await pool.query("UPDATE business_days SET business_date = business_date + 3 WHERE restaurant_id = $1", [rid]);
  });

  await t.test("the kitchen board is today's; earlier tickets are counted", async () => {
    await O("POST", "/kitchen/sync");
    const kots = (await pool.query("SELECT id, order_id FROM kots WHERE restaurant_id = $1", [rid])).rows;
    assert.ok(kots.length >= 2, "both orders reached the kitchen");
    for (const kot of kots.filter((row) => Number(row.order_id) === Number(old.id))) {
      await backdate("kots", kot.id, "created_at");
    }
    const board = await O("GET", "/kitchen/board");
    assert.ok(board.tickets.every((ticket) => Number(ticket.orderId) !== Number(old.id)), "no earlier ticket on the board");
    assert.ok(board.tickets.some((ticket) => Number(ticket.orderId) === Number(fresh.id)));
    assert.equal(board.earlierOpen.count, 1);
    assert.equal(board.earlierOpen.olderThan[120], 1);
    const withOlder = await O("GET", "/kitchen/board?older=1");
    assert.ok(withOlder.tickets.some((ticket) => Number(ticket.orderId) === Number(old.id)));
    assert.equal(withOlder.earlierOpen.shown, true);
    const live = await O("GET", "/reports/dashboard/live?blocks=kitchen");
    assert.equal(live.blocks.kitchen.data.earlierOpen, 1);
    assert.equal(live.blocks.kitchen.data.openCount, board.tickets.filter((ticket) => ["new", "cooking", "ready"].includes(ticket.status)).length);
  });

  await t.test("delivery board: an earlier day's run is in play, not late", async () => {
    const delivery = await O("POST", "/orders", { orderType: "delivery", customerName: "Door", items: [{ productId: dal.id, quantity: 1 }] }, 201);
    await backdate("orders", delivery.id);
    const board = await O("GET", "/deliveries/board");
    const card = board.orders.find((order) => order.id === delivery.id);
    assert.ok(card, "still on the board");
    assert.equal(card.earlierDay, true);
    assert.equal(board.stats.lateNow, 0, "not counted as running late");
    assert.equal(board.stats.earlierInPlay, 1);
    assert.equal(board.stats.ordersToday, 0, "not tonight's");
  });

  await t.test("table requests from an earlier day are history, closed in one go", async () => {
    const insert = (type, status) =>
      pool.query(
        `INSERT INTO table_requests (restaurant_id, table_id, request_type, status, created_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '3 days') RETURNING id`,
        [rid, t1.id, type, status]
      );
    const call = (await insert("call_waiter", "pending")).rows[0].id;
    const summary = await O("GET", "/table-requests/summary");
    assert.equal(summary.openCalls, 0, "not waiting today");
    // A business day opened three days ago does not stretch "today" back.
    await pool.query("UPDATE business_days SET opened_at = opened_at - INTERVAL '4 days' WHERE restaurant_id = $1", [rid]);
    const stretched = await O("GET", "/table-requests/summary");
    assert.equal(stretched.openCalls, 0, "a day left open does not make old calls today's");
    await request("POST", "/table-requests/close-earlier", {}, 403, captain);
    const closed = await O("POST", "/table-requests/close-earlier", { reason: "Old" });
    assert.equal(closed.done, 1);
    const row = (await pool.query("SELECT status FROM table_requests WHERE id = $1", [call])).rows[0];
    assert.equal(row.status, "done");
    await pool.query("UPDATE business_days SET opened_at = opened_at + INTERVAL '4 days' WHERE restaurant_id = $1", [rid]);
  });

  await t.test("the earlier order is billed or cancelled like any other", async () => {
    // A captain may not cancel (orders.manage); the owner may.
    await request("PATCH", `/orders/${old.id}/cancel`, { reason: "Left open" }, 403, captain);
    await O("PATCH", `/orders/${old.id}/cancel`, { reason: "Left open from an earlier day" });
    const dash = await O("GET", "/reports/dashboard");
    assert.equal(dash.openOrdersEarlier.count, 1, "only the delivery is left from earlier days");
  });
});
