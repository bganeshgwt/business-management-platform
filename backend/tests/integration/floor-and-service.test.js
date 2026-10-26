// Floor and service: bookings and seating, the QR inbox, the kitchen display,
// deliveries and the floor plan, on a throwaway database of their own (the
// same pattern as restaurant.test.js — never DB_NAME).
//
// Covers closed floors and sections, tables still being cleaned, seating
// through the order service, QR rounds reaching the kitchen at once, a QR
// accept rush that used to freeze the API, who sent each kitchen round and
// when a held course was fired, outlet scoping of tickets, bookings and
// deliveries, sales figures kept from roles without sales.view, and guests'
// numbers masked in lists.
//
// It also covers rushes of Seat presses and refused bookings that froze the
// API, table setup across outlets, a QR order added to another outlet's
// order, a booking that could not be edited once its floor closed, the QR
// inbox's "today" stretched by a branch day left open, and live deliveries'
// numbers on the board.
//
// And the owner's rule for live screens: the QR inbox, its bell and
// the deliveries board show today's business day only; earlier days are read
// by date, a page at a time (the Orders list pages through every order).
//
// The API runs here with a pool of four connections and the hold-and-wait
// guard on (config/database.js): a transaction that asks the pool for a
// second connection deadlocks a small pool at once, and the guard names the
// place. No such place may be in the floor and service code.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { momentAt, tradingToday } = require("./helpers/dates");
const { signIn, passwordOf } = require("./helpers/signIn");

test("floor and service", { timeout: 600000 }, async (t) => {
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
  process.env.DB_POOL_MAX = "4";
  process.env.DB_CONNECT_TIMEOUT_MS = "4000";
  process.env.DB_POOL_GUARD = "warn";
  // What the guard reports, kept for the last check.
  const guardWarnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    const text = args.map(String).join(" ");
    if (text.startsWith("[db pool guard]")) guardWarnings.push(text);
    else realWarn(...args);
  };
  t.after(() => { console.warn = realWarn; });
  const { runner } = await import("node-pg-migrate");
  await t.test("all migrations install on an empty database", async () => {
    await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"),
      migrationsTable: "pgmigrations", direction: "up", count: Infinity, checkOrder: true, log() {} });
  });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const role = (code) => one("SELECT id FROM roles WHERE code = $1 AND restaurant_id IS NULL", [code]);
  const addUser = async (rid, name, email, roleCode, outletId = null) => {
    const user = await one(
      "INSERT INTO users (restaurant_id,name,email,password_hash,outlet_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [rid, name, email, hash, outletId]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)", [user.id, (await role(roleCode)).id]);
    return user;
  };

  // ------------------------------------------------------------ the restaurant
  const restaurant = await one("INSERT INTO restaurants (name,code) VALUES ('Floor test','FLOOR') RETURNING id");
  const rid = restaurant.id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING", [rid]);
  const outletA = await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Banjara Hills','BH') RETURNING id", [rid]);
  const outletB = await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Jubilee Hills','JH') RETURNING id", [rid]);
  await addUser(rid, "Owner", "owner@test.invalid", "RESTAURANT_ADMIN");
  await addUser(rid, "Captain", "captain@test.invalid", "CAPTAIN");
  await addUser(rid, "Captain A", "captaina@test.invalid", "CAPTAIN", outletA.id);
  await addUser(rid, "Cook A", "cooka@test.invalid", "KITCHEN", outletA.id);
  await addUser(rid, "Cashier A", "cashiera@test.invalid", "CASHIER", outletA.id);
  await addUser(rid, "Cashier", "cashier@test.invalid", "CASHIER");
  await addUser(rid, "Manager A", "managera@test.invalid", "MANAGER", outletA.id);
  const clerkRole = await one("INSERT INTO roles(restaurant_id,code,name,is_system,status) VALUES ($1,'CLERK','Stock clerk',FALSE,'active') RETURNING id", [rid]);
  await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code IN ('inventory.view','orders.view','reports.view')", [clerkRole.id]);
  const clerk = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,'Clerk','clerk@test.invalid',$2) RETURNING id", [rid, hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)", [clerk.id, clerkRole.id]);
  const other = await one("INSERT INTO restaurants(name,code) VALUES ('Other','OTHERR') RETURNING id");
  await addUser(other.id, "Other owner", "other@test.invalid", "RESTAURANT_ADMIN");
  const category = await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Food') RETURNING id", [rid]);
  const dish = async (name, price) =>
    one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES ($1,$2,$3,$4,5) RETURNING id", [rid, category.id, name, price]);
  const chai = await dish("Masala Chai", 30);
  const naan = await dish("Butter Naan", 60);
  const jamun = await dish("Gulab Jamun", 90);

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
  const login = async (email) => (await signIn(base, email, password)).token;
  const owner = await login("owner@test.invalid");
  const captain = await login("captain@test.invalid");
  const captainA = await login("captaina@test.invalid");
  const cookA = await login("cooka@test.invalid");
  const cashierA = await login("cashiera@test.invalid");
  const cashier = await login("cashier@test.invalid");
  const managerA = await login("managera@test.invalid");
  const clerkToken = await login("clerk@test.invalid");
  const foreign = await login("other@test.invalid");
  const atA = { "X-Outlet-Id": String(outletA.id) };
  const atB = { "X-Outlet-Id": String(outletB.id) };
  const O = (method, url, body, expected = 200, headers) => expect(method, url, body, expected, owner, headers);

  const dayAll = await O("POST", "/business-day/open", { openingCash: 500 }, 201);
  const dayA = await O("POST", "/business-day/open", { openingCash: 500 }, 201, atA);
  await O("POST", "/business-day/open", { openingCash: 500 }, 201, atB);
  const ground = await O("POST", "/tables/floors", { name: "Ground" }, 201);
  const terrace = await O("POST", "/tables/floors", { name: "Terrace" }, 201);
  const patio = await O("POST", "/tables/areas", { floorId: ground.id, name: "Patio" }, 201);
  const table = (tableNo, extra = {}) => O("POST", "/tables", { floorId: ground.id, tableNo, capacity: 4, ...extra }, 201);
  const free = [];
  for (let i = 1; i <= 16; i += 1) free.push(await table(`M${i}`));
  const closedFloorTable = await table("CF1", { floorId: terrace.id });
  const closedAreaTable = await table("CA1", { areaId: patio.id });
  const a1 = await table("A1", { outletId: outletA.id });
  const b1 = await table("B1", { outletId: outletB.id });
  await O("PUT", `/tables/floors/${terrace.id}`, { name: "Terrace", status: "inactive" });
  await O("PUT", `/tables/areas/${patio.id}`, { floorId: ground.id, name: "Patio", status: "inactive" });
  const tokenOf = async (tableId) => (await one("SELECT qr_token FROM dining_tables WHERE id = $1", [tableId])).qr_token;
  const ist = (offsetMinutes = 0) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric",
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(Date.now() + offsetMinutes * 60000)).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}` };
  };
  let keyCount = 0;
  const guest = (tableToken, kind, body) =>
    send("POST", `/public/tables/${tableToken}/${kind}`, { clientKey: `k-${(keyCount += 1)}-${crypto.randomBytes(4).toString("hex")}`, ...body });

  await t.test("closed floors and sections take no booking, no seating and no QR order", async () => {
    const now = await O("GET", "/reservations/availability?now=true&partySize=2");
    for (const closed of [closedFloorTable, closedAreaTable]) {
      const row = now.tables.find((one) => one.id === closed.id);
      assert.equal(row.fit, "closed");
      assert.notEqual(now.suggestedTableId, closed.id);
    }
    const tomorrow = ist(24 * 60).date;
    await O("POST", "/reservations", { guestName: "Rain", partySize: 2, date: tomorrow, startTime: "20:00", tableId: closedFloorTable.id }, 400);
    await O("POST", "/reservations", { guestName: "Rain", partySize: 2, date: tomorrow, startTime: "20:00", tableId: closedAreaTable.id }, 400);
    const walkIn = await O("POST", "/reservations/waitlist", { guestName: "Walk in", partySize: 2 }, 201);
    await O("POST", `/reservations/waitlist/${walkIn.id}/seat`, { tableId: closedAreaTable.id }, 400);
    assert.equal((await one("SELECT status FROM waitlist_entries WHERE id = $1", [walkIn.id])).status, "waiting");
    const closedToken = await tokenOf(closedAreaTable.id);
    assert.equal((await send("GET", `/public/tables/${closedToken}/menu`)).status, 404);
    assert.equal((await guest(closedToken, "orders", { items: [{ productId: chai.id, quantity: 1 }] })).status, 404);
  });

  await t.test("seating uses the order service: the outlet's own day, and never a table still being cleaned", async () => {
    await O("PUT", "/tables/settings", { cleaningMinutes: 10 });
    const eat = await O("POST", "/orders", { orderType: "dine_in", tableId: free[1].id, items: [{ productId: chai.id, quantity: 1 }] }, 201);
    const bill = await O("POST", "/bills", { orderId: eat.id }, 201);
    await O("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: bill.dueAmount }, 201);
    const avail = await O("GET", "/reservations/availability?now=true&partySize=2");
    assert.equal(avail.tables.find((row) => row.id === free[1].id).fit, "cleaning");
    const walkIn = await O("POST", "/reservations/waitlist", { guestName: "Next party", partySize: 2 }, 201);
    const refused = await send("POST", `/reservations/waitlist/${walkIn.id}/seat`, { tableId: free[1].id }, owner);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /clean/i);
    await expect("PATCH", `/tables/${free[1].id}/ready`, undefined, 200, captain);
    const seated = await O("POST", `/reservations/waitlist/${walkIn.id}/seat`, { tableId: free[1].id });
    assert.equal(Number((await one("SELECT business_day_id FROM orders WHERE id = $1", [seated.order.id])).business_day_id), dayAll.id);
    await O("PUT", "/tables/settings", { cleaningMinutes: 0 });
    const walkInA = await O("POST", "/reservations/waitlist", { guestName: "Branch party", partySize: 2 }, 201);
    const seatedA = await O("POST", `/reservations/waitlist/${walkInA.id}/seat`, { tableId: a1.id });
    const row = await one("SELECT outlet_id, business_day_id FROM orders WHERE id = $1", [seatedA.order.id]);
    assert.equal(Number(row.outlet_id), outletA.id);
    assert.equal(Number(row.business_day_id), dayA.id);
  });

  await t.test("a QR second round reaches the kitchen at once, priced like the till's", async () => {
    const running = await O("POST", "/orders", { orderType: "dine_in", tableId: free[3].id, items: [{ productId: naan.id, quantity: 2 }] }, 201);
    const placed = await guest(await tokenOf(free[3].id), "orders", { items: [{ productId: jamun.id, quantity: 1 }] });
    assert.equal(placed.status, 201);
    const accepted = await expect("POST", `/table-requests/${placed.body.data.id}/accept`, {}, 200, captain);
    assert.equal(accepted.action, "added");
    const line = await one("SELECT id FROM order_items WHERE order_id = $1 AND product_id = $2", [running.id, jamun.id]);
    const sent = await one("SELECT COALESCE(SUM(quantity),0)::numeric AS n FROM kot_items WHERE order_item_id = $1", [line.id]);
    assert.equal(Number(sent.n), 1);
    const order = await O("GET", `/orders/${running.id}`);
    assert.equal(order.totalAmount, 220.5);
  });

  await t.test("twelve QR orders accepted at the same moment all go through and the API stays up", async () => {
    const rush = free.slice(4, 16);
    const requests = [];
    for (const tbl of rush) {
      const placed = await guest(await tokenOf(tbl.id), "orders", { items: [{ productId: chai.id, quantity: 1 }] });
      requests.push(placed.body.data.id);
    }
    const results = await Promise.all(requests.map((id) => send("POST", `/table-requests/${id}/accept`, {}, captain)));
    assert.deepEqual(results.map((r) => r.status), requests.map(() => 200));
    await login("owner@test.invalid");
    const twin = await tokenOf(b1.id);
    const first = await guest(twin, "orders", { items: [{ productId: chai.id, quantity: 1 }] });
    const second = await guest(twin, "orders", { items: [{ productId: naan.id, quantity: 1 }] });
    const both = await Promise.all([first, second].map((r) => send("POST", `/table-requests/${r.body.data.id}/accept`, {}, owner)));
    assert.deepEqual(both.map((r) => r.status), [200, 200]);
    assert.equal((await all("SELECT id FROM orders WHERE table_id = $1 AND order_status = 'open'", [b1.id])).length, 1);
  });

  await t.test("each kitchen round says who sent it, and a fired course is sent when it is fired", async () => {
    const order = await O("POST", "/orders", { orderType: "dine_in", tableId: free[0].id, items: [{ productId: naan.id, quantity: 1 }] }, 201);
    await expect("PUT", `/orders/${order.id}/items`, { changesOnly: true, items: [{ productId: chai.id, quantity: 1 }] }, 200, captain);
    const tickets = await O("GET", `/kitchen/orders/${order.id}/kots`);
    const second = tickets.find((ticket) => ticket.items.some((item) => item.name === "Masala Chai"));
    assert.equal(second.sentBy, "Captain");
    assert.equal(second.sentByLabel, "Sent by Captain");
    const held = await O("POST", "/orders", { orderType: "dine_in", tableId: free[2].id, items: [
      { productId: naan.id, quantity: 1, courseNo: 1 },
      { productId: jamun.id, quantity: 1, courseNo: 2, holdCourse: true }] }, 201);
    await pool.query("UPDATE order_items SET created_at = created_at - INTERVAL '40 minutes' WHERE order_id = $1", [held.id]);
    await expect("POST", `/orders/${held.id}/courses/2/fire`, undefined, 200, captain);
    const fired = await one(`SELECT EXTRACT(EPOCH FROM (NOW() - k.created_at))::int AS age, u.name
      FROM kots k JOIN kot_items ki ON ki.kot_id = k.id LEFT JOIN users u ON u.id = k.sent_by
      WHERE k.order_id = $1 AND ki.product_id = $2`, [held.id, jamun.id]);
    assert.ok(fired.age < 120, `the dessert ticket is ${fired.age} s old`);
    assert.equal(fired.name, "Captain");
  });

  await t.test("staff of one outlet cannot open or move another outlet's tickets, bookings or deliveries", async () => {
    const takeaway = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: chai.id, quantity: 1 }] }, 201, atB);
    const [ticket] = await O("GET", `/kitchen/orders/${takeaway.id}/kots`, undefined, 200, atB);
    await expect("GET", `/kitchen/kots/${ticket.id}`, undefined, 404, cookA);
    await expect("PATCH", `/kitchen/kots/${ticket.id}/status`, { status: "cooking" }, 404, cookA);
    await expect("GET", `/kitchen/orders/${takeaway.id}/kots`, undefined, 404, cookA);
    await expect("GET", `/kitchen/kots/${ticket.id}`, undefined, 404, foreign);
    const later = ist(120);
    const booking = await O("POST", "/reservations", { guestName: "Branch B", guestMobile: "9876505678", partySize: 2, date: later.date, startTime: later.time }, 201, atB);
    await expect("GET", `/reservations/${booking.id}`, undefined, 404, captainA);
    await expect("PATCH", `/reservations/${booking.id}/cancel`, { reason: "not ours" }, 404, captainA);
    const board = await expect("GET", `/reservations/day?date=${later.date}`, undefined, 200, captainA);
    assert.ok(!board.bookings.some((row) => row.id === booking.id));
    assert.ok(!board.tables.some((row) => row.id === b1.id));
    const delivery = await O("POST", "/orders", { orderType: "delivery", customerName: "Door", items: [{ productId: chai.id, quantity: 1 }] }, 201, atB);
    await expect("GET", `/deliveries/${delivery.id}`, undefined, 404, cashierA);
    await expect("PATCH", `/deliveries/${delivery.id}/status`, { status: "cancelled", reason: "x" }, 404, cashierA);
    const tables = await expect("GET", "/tables", undefined, 200, captainA);
    assert.ok(!tables.some((row) => row.id === b1.id));
    const refused = await send("POST", "/orders", { orderType: "dine_in", tableId: b1.id, items: [{ productId: chai.id, quantity: 1 }] }, captainA);
    assert.equal(refused.status, 400);
  });

  await t.test("sales figures stay with sales.view; guests' numbers are masked in lists", async () => {
    const summary = await expect("GET", "/deliveries/summary", undefined, 200, clerkToken);
    assert.equal(summary.stats.salesToday, null);
    assert.equal(summary.stats.cashWithRiders, null);
    await expect("GET", "/deliveries/report", undefined, 403, clerkToken);
    const inbox = await expect("GET", "/table-requests/summary", undefined, 200, captain);
    assert.ok(!("acceptedValueToday" in inbox));
    await O("POST", "/orders", { orderType: "takeaway", customerName: "Private", customerMobile: "9123456780", items: [{ productId: chai.id, quantity: 1 }] }, 201);
    const orders = await expect("GET", "/orders?limit=200", undefined, 200, cashier);
    assert.ok(!JSON.stringify(orders.items.map((row) => row.customerMobile)).includes("9123456780"));
    const plus = await O("POST", "/reservations", { guestName: "Plus", guestMobile: "+91 94990 64824", partySize: 2, date: ist(24 * 60).date, startTime: "21:00" }, 201);
    assert.equal(plus.guestMobile, "9499064824");
    const list = await expect("GET", `/reservations?from=${ist(24 * 60).date}&to=${ist(24 * 60).date}`, undefined, 200, cashier);
    assert.ok(!JSON.stringify(list.items.map((row) => row.guestMobile)).includes("9499064824"));
  });

  await t.test("tables: whole numbers only, and a part-billed table is not 'paid'", async () => {
    await O("POST", "/tables", { floorId: ground.id, tableNo: "FR", capacity: 3.7 }, 400);
    await O("PUT", `/tables/floors/${ground.id}`, { name: "Ground", sortOrder: 1.5 }, 400);
    const tbl = await table("P1");
    const order = await O("POST", "/orders", { orderType: "dine_in", tableId: tbl.id,
      items: [{ productId: naan.id, quantity: 1 }, { productId: chai.id, quantity: 1 }] }, 201);
    const chaiLine = order.items.find((item) => item.productId === chai.id);
    const bill = await O("POST", "/bills", { orderId: order.id, items: [{ orderItemId: chaiLine.id, quantity: 1 }] }, 201);
    await O("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: bill.dueAmount }, 201);
    const floorPlan = await O("GET", "/tables");
    const row = floorPlan.find((one) => one.id === tbl.id);
    assert.equal(row.live.fullyPaid, false);
    assert.notEqual(row.floorState, "paid");
  });
  const rushFloor = await O("POST", "/tables/floors", { name: "Rush" }, 201);
  const rushTables = [];
  for (let i = 1; i <= 24; i += 1) rushTables.push(await table(`R${i}`, { floorId: rushFloor.id }));
  const timedLogin = async () => {
    const started = Date.now();
    const result = await send("POST", "/auth/login", { identifier: "owner@test.invalid", password: passwordOf(base, "owner@test.invalid", password) });
    return { status: result.status, ms: Date.now() - started };
  };

  await t.test("twelve Seat presses for one party at once: one seats them, the rest are told, sign-in keeps working", async () => {
    const now = ist();
    const booking = await O("POST", "/reservations", { guestName: "Rush party", partySize: 2, date: now.date, startTime: now.time }, 201);
    const started = Date.now();
    const [presses, signIn] = await Promise.all([
      Promise.all(rushTables.slice(0, 12).map((tbl) => send("POST", `/reservations/${booking.id}/seat`, { tableId: tbl.id }, owner))),
      new Promise((resolve) => setTimeout(resolve, 50)).then(timedLogin),
    ]);
    const codes = presses.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 200).length, 1, codes.join(","));
    assert.equal(codes.filter((c) => c === 409).length, 11, codes.join(","));
    assert.ok(Date.now() - started < 3500, `took ${Date.now() - started} ms`);
    assert.equal(signIn.status, 200);
    assert.ok(signIn.ms < 3500, `sign-in took ${signIn.ms} ms`);
    const walkIn = await O("POST", "/reservations/waitlist", { guestName: "Rush walk-in", partySize: 2 }, 201);
    const walkCodes = (await Promise.all(rushTables.slice(12).map((tbl) =>
      send("POST", `/reservations/waitlist/${walkIn.id}/seat`, { tableId: tbl.id }, owner)))).map((r) => r.status);
    assert.equal(walkCodes.filter((c) => c === 200).length, 1, walkCodes.join(","));
    assert.equal(walkCodes.filter((c) => c === 409).length, 11, walkCodes.join(","));
    const refused = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      send("POST", "/reservations", { guestName: `Refused ${i}`, partySize: 2, date: ist(24 * 60).date, startTime: "19:00", tableId: b1.id }, captainA)));
    assert.deepEqual(refused.map((r) => r.status), refused.map(() => 400));
  });

  await t.test("a manager tied to one outlet sets up that outlet's tables only", async () => {
    const bTable = await table("BX", { outletId: outletB.id });
    const before = await one("SELECT outlet_id, capacity, qr_token FROM dining_tables WHERE id = $1", [bTable.id]);
    await expect("PUT", `/tables/${bTable.id}`, { floorId: ground.id, tableNo: "BX", capacity: 8, outletId: outletA.id }, 404, managerA);
    await expect("PUT", `/tables/${bTable.id}`, { floorId: ground.id, tableNo: "BX", capacity: 8 }, 404, managerA);
    await expect("PATCH", `/tables/${bTable.id}/qr`, undefined, 404, managerA);
    await expect("DELETE", `/tables/${bTable.id}`, undefined, 404, managerA);
    assert.deepEqual(await one("SELECT outlet_id, capacity, qr_token FROM dining_tables WHERE id = $1", [bTable.id]), before);
    await expect("POST", "/tables", { floorId: ground.id, tableNo: "NB", capacity: 4, outletId: outletB.id }, 403, managerA);
    const own = await expect("POST", "/tables", { floorId: ground.id, tableNo: "NA", capacity: 4 }, 201, managerA);
    assert.equal(Number(own.outletId), outletA.id);
    await expect("PUT", `/tables/${own.id}`, { floorId: ground.id, tableNo: "NA", capacity: 6 }, 200, managerA);
    assert.equal(Number((await one("SELECT outlet_id FROM dining_tables WHERE id = $1", [own.id])).outlet_id), outletA.id);
    const shared = await table("SH");
    await expect("PUT", `/tables/${shared.id}`, { floorId: ground.id, tableNo: "SH", capacity: 2 }, 403, managerA);
    await expect("PATCH", `/tables/${shared.id}/ready`, undefined, 200, managerA);
    await expect("PUT", `/tables/floors/${ground.id}`, { name: "Ground", status: "inactive" }, 403, managerA);
    await expect("PUT", "/tables/settings", { cleaningMinutes: 25 }, 403, managerA);
    await O("PUT", `/tables/${bTable.id}`, { floorId: ground.id, tableNo: "BX", capacity: 4 }, 404, atA);
    await O("PUT", `/tables/${bTable.id}`, { floorId: ground.id, tableNo: "BX", capacity: 5 });
    assert.equal(Number((await one("SELECT outlet_id FROM dining_tables WHERE id = $1", [bTable.id])).outlet_id), outletB.id);
  });

  await t.test("a QR order is never added to another outlet's running order", async () => {
    const shared = await table("SQ");
    const running = await O("POST", "/orders", { orderType: "dine_in", tableId: shared.id, items: [{ productId: chai.id, quantity: 1 }] }, 201, atB);
    assert.equal(Number(running.outletId), outletB.id);
    const placed = await guest(await tokenOf(shared.id), "orders", { items: [{ productId: naan.id, quantity: 1 }] });
    const inbox = await expect("GET", "/table-requests?view=pending&limit=200", undefined, 200, cashierA);
    const seen = inbox.items.find((row) => row.id === placed.body.data.id);
    assert.equal(Number(seen.tableOrder.outletId), outletB.id);
    const refused = await send("POST", `/table-requests/${placed.body.data.id}/accept`, {}, cashierA);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /Jubilee Hills/);
    assert.equal((await all("SELECT id FROM order_items WHERE order_id = $1", [running.id])).length, 1);
    assert.equal((await one("SELECT status FROM table_requests WHERE id = $1", [placed.body.data.id])).status, "pending");
    const accepted = await O("POST", `/table-requests/${placed.body.data.id}/accept`, {}, 200, atB);
    assert.equal(accepted.order.id, running.id);
  });

  await t.test("a booking keeps its table, and can still be edited, when its floor closes after it was taken", async () => {
    const tomorrow = ist(24 * 60).date;
    await O("PUT", `/tables/floors/${terrace.id}`, { name: "Terrace", status: "active" });
    const booking = await O("POST", "/reservations", { guestName: "Terrace", partySize: 2, date: tomorrow, startTime: "20:30", tableId: closedFloorTable.id }, 201);
    await O("PUT", `/tables/floors/${terrace.id}`, { name: "Terrace", status: "inactive" });
    const renamed = await O("PUT", `/reservations/${booking.id}`, { guestName: "Terrace (Mehta)", partySize: 2, date: tomorrow, startTime: "20:30", tableId: closedFloorTable.id });
    assert.equal(renamed.guestName, "Terrace (Mehta)");
    assert.equal(renamed.tableId, closedFloorTable.id);
    assert.equal(renamed.tableOutOfService, "floor");
    await O("POST", "/reservations", { guestName: "New", partySize: 2, date: tomorrow, startTime: "13:00", tableId: closedFloorTable.id }, 400);
  });

  await t.test("the QR inbox's 'today' is each table's own place's day", async () => {
    const own = await one("SELECT id, opened_at FROM business_days WHERE restaurant_id = $1 AND outlet_id IS NULL AND day_status = 'open'", [rid]);
    const branch = await one("SELECT id FROM business_days WHERE restaurant_id = $1 AND outlet_id = $2 AND day_status = 'open'", [rid, outletB.id]);
    const sharedCall = await guest(await tokenOf(free[0].id), "calls", { type: "water" });
    const branchCall = await guest(await tokenOf(b1.id), "calls", { type: "water" });
    for (const placed of [sharedCall, branchCall]) await expect("POST", `/table-requests/${placed.body.data.id}/done`, {}, 200, captain);
    await pool.query("UPDATE business_days SET opened_at = opened_at - INTERVAL '3 days' WHERE id = $1", [branch.id]);
    await pool.query("UPDATE business_days SET opened_at = opened_at - INTERVAL '1 hour' WHERE id = $1", [own.id]);
    await pool.query("UPDATE table_requests SET created_at = created_at - INTERVAL '2 days' WHERE id = ANY($1::bigint[])",
      [[sharedCall.body.data.id, branchCall.body.data.id]]);
    const today = await O("GET", "/table-requests?view=today&limit=500");
    assert.ok(!today.items.some((row) => row.id === sharedCall.body.data.id), "a shared table's call from before the restaurant's day is not today's");
    // The owner's rule for live screens: a branch day left open since an
    // earlier date does not stretch "today" back to it.
    assert.ok(!today.items.some((row) => row.id === branchCall.body.data.id), "a day left open does not make a 2-day-old call today's");
    const summary = await O("GET", "/table-requests/summary");
    const ownNow = await one("SELECT opened_at FROM business_days WHERE id = $1", [own.id]);
    // Today runs from the day's opening, but never from before the trading
    // day's start (the 05:00 cut-off): between 05:00 and 06:00 the opening
    // moved back an hour falls before it.
    const tradingStart = Date.parse(momentAt(tradingToday(), "05:00"));
    const expectedSince = Math.max(new Date(ownNow.opened_at).getTime(), tradingStart);
    assert.ok(Math.abs(new Date(summary.since) - expectedSince) < 1000, `${summary.since}`);
    await pool.query("UPDATE business_days SET opened_at = opened_at + INTERVAL '3 days' WHERE id = $1", [branch.id]);
  });

  await t.test("the deliveries board masks every guest's number for a cashier; opening one delivery gives it", async () => {
    const live = await O("POST", "/orders", { orderType: "delivery", customerName: "On the way", customerMobile: "9811122233",
      items: [{ productId: chai.id, quantity: 1 }] }, 201);
    const board = await expect("GET", "/deliveries/board", undefined, 200, cashier);
    const card = board.orders.find((row) => row.id === live.id);
    assert.match(card.customerMobile, /^X+2233$/);
    assert.ok(!/\b[6-9]\d{9}\b/.test(JSON.stringify(board.orders.map((row) => row.customerMobile))));
    const opened = await expect("GET", `/deliveries/${live.id}`, undefined, 200, cashier);
    assert.match(opened.customerMobile.replace(/\D/g, ""), /9811122233$/);
    const ownerBoard = await O("GET", "/deliveries/board");
    assert.match(ownerBoard.orders.find((row) => row.id === live.id).customerMobile.replace(/\D/g, ""), /9811122233$/);
    // How it was paid reaches the card through the order's bills (the
    // board no longer scans every payment for each card).
    const bill = await O("POST", "/bills", { orderId: live.id }, 201);
    await O("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: bill.dueAmount }, 201);
    const paidCard = (await O("GET", "/deliveries/board")).orders.find((row) => row.id === live.id);
    assert.deepEqual(paidCard.paymentMethods, ["upi"]);
    assert.ok(await one("SELECT 1 AS ok FROM pg_indexes WHERE indexname = 'idx_orders_table_live'"));
  });

  await t.test("every order-taker can read the outlets a sale can be for", async () => {
    const outlets = await expect("GET", "/orders/outlets", undefined, 200, cashier);
    assert.deepEqual(outlets.map((row) => row.name).sort(), ["Banjara Hills", "Jubilee Hills"]);
    assert.ok(outlets.every((row) => Object.keys(row).sort().join() === "id,name"));
    await expect("GET", "/outlets", undefined, 403, cashier);
  });

  await t.test("live screens show today only; earlier days are read by date, a page at a time", async () => {
    const own = await one(
      "SELECT id, to_char(business_date, 'YYYY-MM-DD') AS d FROM business_days WHERE restaurant_id = $1 AND outlet_id IS NULL AND day_status = 'open'",
      [rid]
    );
    const earlier = await one(
      `INSERT INTO business_days (restaurant_id, business_date, day_status, opened_at, closed_at)
       VALUES ($1, $2::date - 3, 'closed', NOW() - INTERVAL '3 days 14 hours', NOW() - INTERVAL '3 days 2 hours')
       RETURNING id, to_char(business_date, 'YYYY-MM-DD') AS d`,
      [rid, own.d]
    );
    // A QR order and a call that nobody answered on that earlier day.
    const order = await guest(await tokenOf(free[13].id), "orders", { items: [{ productId: chai.id, quantity: 1 }] });
    const callForBill = await guest(await tokenOf(free[14].id), "calls", { type: "bill" });
    const ids = [order.body.data.id, callForBill.body.data.id];
    await pool.query(
      "UPDATE table_requests SET created_at = NOW() - INTERVAL '3 days 5 hours', business_day_id = $2 WHERE id = ANY($1::bigint[])",
      [ids, earlier.id]
    );
    for (const view of ["pending", "today"]) {
      const live = await O("GET", `/table-requests?view=${view}&limit=500`);
      assert.ok(!live.items.some((row) => ids.includes(row.id)), `${view} holds nothing of an earlier day`);
    }
    const history = await O("GET", `/table-requests?view=history&from=${earlier.d}&to=${earlier.d}`);
    // A range that reaches today still holds nothing of today.
    const reaching = await O("GET", `/table-requests?view=history&from=${earlier.d}&to=${ist(24 * 60).date}&limit=500`);
    assert.ok(reaching.items.length >= 2 && reaching.items.every((row) => row.fromEarlierDay));
    assert.deepEqual(history.items.map((row) => row.id).sort(), [...ids].sort());
    assert.ok(history.items.every((row) => row.fromEarlierDay));
    const accept = await send("POST", `/table-requests/${ids[0]}/accept`, {}, owner);
    assert.equal(accept.status, 409, "an order of an earlier day is never cooked");
    await O("POST", `/table-requests/${ids[0]}/reject`, { reason: "Sent on an earlier day" });
    await O("POST", `/table-requests/${ids[1]}/done`, {});
    const first = await O("GET", `/table-requests?view=history&from=${earlier.d}&limit=1`);
    const second = await O("GET", `/table-requests?view=history&from=${earlier.d}&limit=1&offset=1`);
    assert.equal(first.total, second.total);
    assert.notEqual(first.items[0].id, second.items[0].id);
    await O("GET", "/table-requests?view=history&from=2026-02-30", undefined, 400);

    // The Orders list pages through every order.
    const page1 = await O("GET", "/orders?limit=2");
    const page2 = await O("GET", "/orders?limit=2&offset=2");
    assert.equal(page1.total, page2.total);
    assert.ok(!page2.items.some((row) => page1.items.some((other) => other.id === row.id)));
    await O("GET", "/orders?limit=2&offset=1.5", undefined, 400);

    // The deliveries board is today's; an earlier day is one date away.
    const never = await O("POST", "/orders", { orderType: "delivery", customerName: "Never sent", customerMobile: "9811100001",
      deliveryAddress: "4 Park Lane", items: [{ productId: naan.id, quantity: 1 }] }, 201);
    await pool.query("UPDATE orders SET business_day_id = $2, placed_at = placed_at - INTERVAL '3 days 4 hours' WHERE id = $1",
      [never.id, earlier.id]);
    const today = await O("GET", "/deliveries/board");
    assert.ok(!today.orders.some((row) => row.id === never.id), "today's board holds nothing of an earlier day");
    const then = await O("GET", `/deliveries/board?date=${earlier.d}`);
    assert.ok(then.orders.some((row) => row.id === never.id));
    assert.equal(then.viewingDate, earlier.d);
    await O("GET", "/deliveries/board?date=2026-02-30", undefined, 400);
  });

  await t.test("no transaction in the floor and service code asks the pool for a second connection", async (sub) => {
    const floorAndServiceFiles = /(reservation|order|table|tableRequest|kitchen|delivery|availability)\.(service|repository|controller)\.js/;
    const ours = guardWarnings.filter((text) => {
      const caller = text.split("\n").find((line) => line.trim().startsWith("at "));
      return caller && floorAndServiceFiles.test(caller);
    });
    // Other modules' places, if this test happened to pass through one, are
    // named for whoever owns them; they do not fail this test.
    for (const text of guardWarnings.filter((one) => !ours.includes(one))) {
      sub.diagnostic(text.split("\n").slice(0, 3).join(" | "));
    }
    assert.deepEqual(ours, []);
  });
});
