// The captain app's own route, end to end on a throwaway database of its own
// (the same pattern as service-deliveries-captains.test.js, never DB_NAME).
//
// The captain app (the staff app's /captain) takes orders, answers calls and
// raises bills through the APIs the POS, Table requests and the kitchen
// already use. The one route of its own is the food at the pass,
// GET /api/kitchen/pass, which its Ready list and its tables read:
//
//   - only tickets the kitchen has marked ready and nobody has served, oldest
//     first, each with its table, its order and its dishes; never another
//     restaurant's
//   - read only: reading it changes no ticket
//   - the outlet the person works in: an outlet picked, or a login tied to one
//   - whoever may read an order's tickets (kot.manage or kds.view); a role with
//     neither is refused, and so is every reader while the kitchen display is
//     switched off
//   - a ticket the captain serves leaves the pass in the captain's name, and
//     its dishes are served on the order; serving it again changes nothing
//   - a table that has paid, or an order cancelled, is not waited on
//
// and the captain sections its My tables follow (GET /tables, and the calls
// in GET /table-requests, carry each table's captain of the day): only while
// the restaurant has Captain sections switched on.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { signIn } = require("./helpers/signIn");

test("the captain app: the food at the pass, and whose tables are whose", { timeout: 600000 }, async (t) => {
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
  const addUser = async (rid, name, email, roleCode, outletId = null) => {
    const user = await one(
      "INSERT INTO users (restaurant_id,name,email,password_hash,outlet_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [rid, name, email, hash, outletId]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL", [user.id, roleCode]);
    return user;
  };

  // A restaurant with a main room and one outlet, its staff (the captain
  // Ramesh, a captain tied to the outlet, the kitchen, a cashier, the pickup
  // counter's TV), and another restaurant.
  const rid = (await one("INSERT INTO restaurants (name,code) VALUES ('Captain test','CPTN') RETURNING id")).id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING", [rid]);
  const outletA = await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Banjara Hills','BH') RETURNING id", [rid]);
  await addUser(rid, "Owner", "owner@test.invalid", "RESTAURANT_ADMIN");
  const captainUser = await addUser(rid, "Ramesh", "captain@test.invalid", "CAPTAIN");
  await addUser(rid, "Sunil", "captain-bh@test.invalid", "CAPTAIN", outletA.id);
  await addUser(rid, "Cook", "cook@test.invalid", "KITCHEN");
  await addUser(rid, "Cashier", "cashier@test.invalid", "CASHIER");
  await addUser(rid, "Pickup TV", "display@test.invalid", "DISPLAY");
  const other = (await one("INSERT INTO restaurants(name,code) VALUES ('Other','OTHC') RETURNING id")).id;
  await addUser(other, "Other owner", "other@test.invalid", "RESTAURANT_ADMIN");
  const category = await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Food') RETURNING id", [rid]);
  const dish = async (name, price) =>
    one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES ($1,$2,$3,$4,5) RETURNING id", [rid, category.id, name, price]);
  const roti = await dish("Tandoori Roti", 30);
  const tikka = await dish("Paneer Tikka", 300);
  const floor = await one("INSERT INTO floors(restaurant_id,name) VALUES ($1,'Hall') RETURNING id", [rid]);
  const table = async (no, outletId = null) =>
    one("INSERT INTO dining_tables(restaurant_id,floor_id,table_no,capacity,qr_token,outlet_id) VALUES ($1,$2,$3,4,$4,$5) RETURNING id",
      [rid, floor.id, no, crypto.randomBytes(16).toString("hex"), outletId]);
  const T1 = await table("T1");
  const T2 = await table("T2");
  const T3 = await table("T3");
  const A1 = await table("A1", outletA.id);

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
    return result.body;
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const owner = await login("owner@test.invalid");
  const captain = await login("captain@test.invalid");
  const captainBh = await login("captain-bh@test.invalid");
  const cook = await login("cook@test.invalid");
  const cashier = await login("cashier@test.invalid");
  const display = await login("display@test.invalid");
  const foreign = await login("other@test.invalid");
  const atA = { "X-Outlet-Id": String(outletA.id) };
  const items = (...pairs) => pairs.map(([product, quantity]) => ({ productId: product.id, quantity }));
  const pass = async (token, headers) => (await expect("GET", "/kitchen/pass", undefined, 200, token, headers)).data;
  const ticketsOf = async (orderId) => (await expect("GET", `/kitchen/orders/${orderId}/kots`, undefined, 200, cook)).data;
  const moveTicket = async (id, status, token = cook, headers) =>
    expect("PATCH", `/kitchen/kots/${id}/status`, { status }, 200, token, headers);

  await expect("POST", "/business-day/open", { openingCash: 1000 }, 201, owner);
  await expect("POST", "/business-day/open", { openingCash: 500 }, 201, owner, atA);

  // Two tables the captain serves: the starters on T1 and the breads on T2.
  const first = (await expect("POST", "/orders", { orderType: "dine_in", tableId: T1.id, guestCount: 2, source: "captain",
    items: items([tikka, 1]) }, 201, captain)).data;
  const second = (await expect("POST", "/orders", { orderType: "dine_in", tableId: T2.id, guestCount: 3, source: "captain",
    items: items([roti, 2]) }, 201, captain)).data;
  let firstTicket, secondTicket;

  await t.test("only food marked ready is on the pass, oldest first; reading it changes no ticket", async () => {
    // Saving each order cut its ticket: new, still in the kitchen.
    [firstTicket] = await ticketsOf(first.id);
    [secondTicket] = await ticketsOf(second.id);
    assert.equal(firstTicket.status, "new");
    const tickets = () => pool.query("SELECT id, kot_status, updated_at FROM kots WHERE restaurant_id = $1 ORDER BY id", [rid]);
    const before = (await tickets()).rows;
    const empty = await pass(captain);
    assert.deepEqual(empty.tickets, [], "new tickets are still in the kitchen");
    assert.equal(empty.passMinutes, 8);
    assert.ok(!Number.isNaN(Date.parse(empty.serverTime)));
    assert.deepEqual((await tickets()).rows, before, "reading the pass changes no ticket");

    await moveTicket(secondTicket.id, "cooking");
    await moveTicket(firstTicket.id, "ready");
    let atPass = (await pass(captain)).tickets;
    assert.deepEqual(atPass.map((ticket) => ticket.id), [firstTicket.id]);
    const [ready] = atPass;
    assert.equal(ready.status, "ready");
    assert.equal(ready.tableNo, "T1");
    assert.equal(Number(ready.orderId), Number(first.id));
    assert.equal(ready.orderNumber, first.orderNumber);
    assert.equal(ready.guestCount, 2);
    assert.ok(ready.readyAt);
    assert.deepEqual(ready.items.map((item) => [item.name, item.liveQuantity]), [["Paneer Tikka", 1]]);
    assert.equal(ready.takenBy, "Ramesh");

    // The breads follow: the starters were ready first, so they stay first.
    await moveTicket(secondTicket.id, "ready");
    atPass = (await pass(captain)).tickets;
    assert.deepEqual(atPass.map((ticket) => ticket.id), [firstTicket.id, secondTicket.id]);
  });

  await t.test("whoever may read an order's tickets reads the pass; nobody else, and never another restaurant's", async () => {
    assert.equal((await pass(cook)).tickets.length, 2, "the kitchen (kds.view)");
    assert.equal((await pass(cashier)).tickets.length, 2, "a cashier (kot.manage)");
    assert.equal((await pass(owner)).tickets.length, 2, "the owner");
    await expect("GET", "/kitchen/pass", undefined, 403, display);
    await expect("GET", "/kitchen/pass", undefined, 401);
    assert.deepEqual((await pass(foreign)).tickets, [], "another restaurant's pass has none of these");
  });

  await t.test("the pass follows the outlet the person works in", async () => {
    const atOutlet = (await expect("POST", "/orders", { orderType: "dine_in", tableId: A1.id, items: items([roti, 1]) }, 201, captainBh)).data;
    assert.equal(Number(atOutlet.outletId), Number(outletA.id));
    const [outletTicket] = (await expect("GET", `/kitchen/orders/${atOutlet.id}/kots`, undefined, 200, owner, atA)).data;
    await moveTicket(outletTicket.id, "ready", owner, atA);

    assert.deepEqual((await pass(owner, atA)).tickets.map((ticket) => ticket.tableNo), ["A1"], "an outlet picked");
    assert.deepEqual((await pass(captainBh)).tickets.map((ticket) => ticket.tableNo), ["A1"], "a login tied to the outlet");
    assert.deepEqual((await pass(captain)).tickets.map((ticket) => ticket.tableNo), ["T1", "T2", "A1"], "the whole restaurant");
    // The captain tied to the outlet serves its own food, never the main room's.
    await expect("PATCH", `/kitchen/kots/${firstTicket.id}/status`, { status: "served" }, 404, captainBh);
    await moveTicket(outletTicket.id, "served", captainBh);
    assert.deepEqual((await pass(captainBh)).tickets, []);
    assert.deepEqual((await pass(captain)).tickets.map((ticket) => ticket.tableNo), ["T1", "T2"]);
  });

  await t.test("served by the captain: off the pass in the captain's name, once, and served on the order", async () => {
    const served = await moveTicket(firstTicket.id, "served", captain);
    assert.match(served.message, /is served$/);
    assert.equal(served.data.status, "served");
    assert.equal(served.data.servedByName, "Ramesh");
    assert.deepEqual((await pass(captain)).tickets.map((ticket) => ticket.id), [secondTicket.id]);
    const order = (await expect("GET", `/orders/${first.id}`, undefined, 200, captain)).data;
    assert.deepEqual(order.items.map((item) => item.itemStatus), ["served"]);
    assert.equal(order.kitchenStatus, "served");
    const row = await one("SELECT served_by, served_at FROM kots WHERE id = $1", [firstTicket.id]);
    assert.equal(Number(row.served_by), Number(captainUser.id));

    // Served again (a second phone, a double tap): nothing changes.
    const again = await moveTicket(firstTicket.id, "served", captain);
    assert.match(again.message, /was already served$/);
    const after = await one("SELECT served_at FROM kots WHERE id = $1", [firstTicket.id]);
    assert.equal(after.served_at.toISOString(), row.served_at.toISOString());
    // Serving needs the ticket permission; reading the pass does not give it.
    await expect("PATCH", `/kitchen/kots/${secondTicket.id}/status`, { status: "served" }, 403, display);
  });

  await t.test("a table that has paid, or an order cancelled, is not waited on", async () => {
    // T2 is billed and paid at the counter with its breads still at the pass.
    const bill = (await expect("POST", "/bills", { orderId: second.id }, 201, cashier)).data;
    await expect("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: bill.dueAmount }, 201, cashier);
    assert.deepEqual((await pass(captain)).tickets, []);

    // A dish rung up on T3, ready, then the order cancelled.
    const third = (await expect("POST", "/orders", { orderType: "dine_in", tableId: T3.id, items: items([tikka, 1]) }, 201, captain)).data;
    const [thirdTicket] = await ticketsOf(third.id);
    await moveTicket(thirdTicket.id, "ready");
    assert.deepEqual((await pass(captain)).tickets.map((ticket) => ticket.id), [thirdTicket.id]);
    await expect("PATCH", `/orders/${third.id}/cancel`, { reason: "Guest left", reasonCode: "guest_changed_mind" }, 200, owner);
    assert.deepEqual((await pass(captain)).tickets, []);
  });

  await t.test("a table is a captain's by the day's sections, only while Captain sections is switched on", async () => {
    await expect("PUT", "/tables/sections", { assignments: [{ userId: captainUser.id, tableId: T1.id }] }, 200, owner);
    const captainOf = async () =>
      (await expect("GET", "/tables", undefined, 200, captain)).data.find((row) => Number(row.id) === Number(T1.id)).captain;
    assert.equal((await captainOf()).userId, Number(captainUser.id));
    assert.equal((await captainOf()).userName, "Ramesh");
    // A guest at T1 asks for water from the table's QR code: the call carries its captain.
    const { qr_token: token } = await one("SELECT qr_token FROM dining_tables WHERE id = $1", [T1.id]);
    const called = await expect("POST", `/public/tables/${token}/calls`, { type: "water" }, 201);
    const callOf = async () =>
      (await expect("GET", "/table-requests?view=pending", undefined, 200, captain)).data.items.find((row) => row.id === called.data.id);
    assert.equal((await callOf()).captain.userId, Number(captainUser.id));

    // Switched off, every captain sees every table: no table and no call is
    // anyone's, and the day's plan is kept for when it comes back on.
    await expect("PUT", "/restaurants/current/features/captain_sections", { enabled: false }, 200, owner);
    try {
      assert.equal(await captainOf(), null);
      assert.equal((await callOf()).captain, null);
      assert.equal((await one("SELECT COUNT(*)::int AS n FROM captain_assignments WHERE restaurant_id = $1", [rid])).n, 1);
    } finally {
      await expect("PUT", "/restaurants/current/features/captain_sections", { enabled: true }, 200, owner);
    }
    assert.equal((await captainOf()).userId, Number(captainUser.id));
    await expect("POST", `/table-requests/${called.data.id}/done`, undefined, 200, captain);
  });

  await t.test("with the kitchen display switched off there is no pass", async () => {
    await expect("PUT", "/restaurants/current/features/kitchen_display", { enabled: false }, 200, owner);
    try {
      const refused = await expect("GET", "/kitchen/pass", undefined, 403, captain);
      assert.equal(refused.data.reason, "feature_off");
      assert.equal(refused.data.feature, "kitchen_display");
    } finally {
      await expect("PUT", "/restaurants/current/features/kitchen_display", { enabled: true }, 200, owner);
    }
    assert.deepEqual((await pass(captain)).tickets, []);
  });
});
