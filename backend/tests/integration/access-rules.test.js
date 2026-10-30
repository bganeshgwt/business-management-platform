// The owner's rules for access, end to end on a throwaway database:
//   - pre-orders: moving one to In production and Ready needs
//     preorders.produce, which every role that takes orders has (the built-in
//     ones and a restaurant's own copies alike) and a kitchen role gets only
//     when the owner ticks it; handing it over still needs orders.create; a
//     kitchen not tied to an outlet reads the bake list of the till it picks,
//     and staff tied to an outlet only their own;
//   - Staff & access: a manager tied to a department lists, counts and finds
//     only that department's people (the API filters it), and the list says
//     whose login is also used elsewhere (no new password from here);
//   - Table requests for every restaurant: with QR ordering off, a waiter's
//     bill ask from the captain app reaches the inbox, its summary (the POS's
//     badges) and the bell, the guests' requests stay out of them, and the
//     guests' own routes are refused;
//   - a PIN someone else sets (an admin, under Users) is marked: it switches a
//     shared till to its person (the session then answers nothing but
//     choosing their own) and unlocks one (the answer asks for their own),
//     but approves, signs and confirms nothing: the restaurant's approvals, a
//     business manager's PIN, a credit hold's release, a clinic's signature
//     and a counter bill's PIN refuse it (409 pin_not_own) before reading it;
//     the person's own PIN clears the mark; both are audited;
//   - the migration's Down half and Up again.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { addDays, momentAt, today, zoneWithHour } = require("./helpers/dates");
const { signIn, passwordOf } = require("./helpers/signIn");
const { createBusinesses } = require("./helpers/businesses");

const QR_WORDS = "Guests scan the QR code on their table to order or call staff; their orders and calls come to Table requests.";
const QR_WORDS_BEFORE = "Guests scan the QR code on their table to order or call staff; the Table requests screen.";

test("access rules: who moves pre-orders, a department's staff list, table requests and a PIN someone else sets", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  // Never migrate, seed, or erase DB_NAME. A unique empty database, dropped
  // by exact name after every connection to it is closed.
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: "postgres" });
  let created = false;
  let pool;
  let server;
  let scratch;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (scratch) await scratch.end().catch(() => {});
    if (pool) await pool.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) {
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
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
  const dir = path.resolve(__dirname, "../../migrations");
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: "pgmigrations", checkOrder: true, log() {}, ...options });
  await migrate({ direction: "up", count: Infinity });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");
  // An hour well away from the restaurant's midnight and its morning cut-off,
  // so its trading day cannot turn over in the middle of the test.
  const zone = zoneWithHour(7, 20);
  const made = await restaurantService.createRestaurant({
    name: "Hearth Bakery",
    code: "ACCRULES1",
    invoicePrefix: "HB",
    timezone: zone,
    admin: { name: "Hearth owner", email: "owner@access.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Bakery",
    code: "ACCRULES2",
    admin: { name: "Other owner", email: "other@access.invalid", password },
  });

  await t.test("the Down half takes the permission, the mark and the words away; Up gives the permission to every role that takes orders, a restaurant's own too", async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const rows = async (sql, values = []) => (await scratch.query(sql, values)).rows;
    const state = async () => (await rows(`SELECT
        (SELECT count(*)::int FROM permissions WHERE code = 'preorders.produce') AS permission,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pin_must_change') AS mark,
        (SELECT description FROM platform_modules WHERE code = 'qr_ordering') AS words`))[0];
    assert.deepEqual(await state(), { permission: 1, mark: 1, words: QR_WORDS });
    // This migration's Down half, after those of every newer one; found by its name.
    const file = fs.readdirSync(dir).find((name) => name.endsWith("_access-rules.sql"));
    await migrate({ direction: "down", count: Number(file.split("_")[0]), timestamp: true });
    assert.deepEqual(await state(), { permission: 0, mark: 0, words: QR_WORDS_BEFORE });

    // The restaurant's own roles as an owner made them before: a copy that
    // takes orders, and an oven role that does not.
    const role = async (code, name, permissions) => {
      const [made] = await rows("INSERT INTO roles (restaurant_id, code, name, is_system) VALUES ($1, $2, $3, FALSE) RETURNING id", [rid, code, name]);
      await scratch.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2::text[])", [made.id, permissions]);
    };
    await role("TILL_COPY", "Till (copy)", ["menu.view", "orders.view", "orders.create"]);
    await role("OVEN", "Oven", ["kds.view", "kot.manage"]);
    await migrate({ direction: "up", count: Infinity });
    assert.deepEqual(await state(), { permission: 1, mark: 1, words: QR_WORDS });

    const holders = async (code) => (await rows(`SELECT r.code FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id AND p.code = $1
        WHERE r.restaurant_id IS NULL OR r.restaurant_id = $2 ORDER BY r.code`, [code, rid])).map((row) => row.code);
    const takers = await holders("orders.create");
    // Every role that takes orders moves pre-orders along, as before; the kitchen's do not.
    assert.deepEqual(await holders("preorders.produce"), takers);
    for (const code of ["RESTAURANT_ADMIN", "MANAGER", "CASHIER", "CAPTAIN", "TILL_COPY"]) assert.ok(takers.includes(code), code);
    for (const code of ["KITCHEN", "OVEN"]) assert.ok(!takers.includes(code), code);
    // Nobody's PIN is marked by the migration.
    assert.equal((await rows("SELECT count(*)::int AS n FROM users WHERE pin_must_change"))[0].n, 0);
  });

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, outletId = null) => {
    const row = await one("INSERT INTO users (restaurant_id, name, email, password_hash, outlet_id) VALUES ($1, $2, $3, $4, $5) RETURNING id", [rid, name, email, hash, outletId]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND (restaurant_id IS NULL OR restaurant_id = $3)", [row.id, role, rid]);
    return Number(row.id);
  };

  const app = require("../../src/app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, url, body, auth, headers = {}) {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  async function request(method, url, body, expected, auth, headers) {
    const result = await call(method, url, body, auth, headers);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  // A refusal: its status, its reason, and its words.
  const refused = async (method, url, body, status, auth, reason, pattern, headers) => {
    const result = await call(method, url, body, auth, headers);
    assert.equal(result.status, status, `${method} ${url}: ${JSON.stringify(result.body)}`);
    if (reason) assert.equal(result.body.data?.reason, reason, JSON.stringify(result.body));
    if (pattern) assert.match(result.body.message, pattern);
    return result.body;
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownPassword = (email) => passwordOf(base, email, password);
  const owner = await login("owner@access.invalid");
  const ownerId = Number((await one("SELECT id FROM users WHERE email = 'owner@access.invalid'")).id);
  const O = async (method, url, body, expected = 200, headers) => (await request(method, url, body, expected, owner, headers)).data;
  const feature = async (code, enabled) => O("PUT", `/restaurants/current/features/${code}`, { enabled });
  // The activity log is written after the answer goes out: wait for it to settle.
  const auditOf = async (action, entityType, entityId) => {
    let found = [];
    for (let tries = 0, last = -1; tries < 15 && found.length !== last; tries += 1) {
      last = found.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      found = await all("SELECT user_id, details FROM audit_logs WHERE restaurant_id = $1 AND action = $2 AND entity_type = $3 AND entity_id = $4 ORDER BY id",
        [rid, action, entityType, entityId]);
    }
    return found;
  };

  for (const code of ["preorders", "qr_ordering"]) await feature(code, true);
  const outletA = await O("POST", "/outlets", { name: "Rooftop", code: "ROOF", status: "active" }, 201);
  const atA = { "X-Outlet-Id": String(outletA.id) };
  const cashierId = await staff("Ravi cashier", "ravi@access.invalid", "CASHIER");
  const captainId = await staff("Suresh captain", "suresh@access.invalid", "CAPTAIN");
  const cookId = await staff("Kumar cook", "kumar@access.invalid", "KITCHEN");
  await staff("Meena cook", "meena@access.invalid", "KITCHEN", outletA.id);
  const managerId = await staff("Anil manager", "anil@access.invalid", "MANAGER");
  const cashier = await login("ravi@access.invalid");
  const captain = await login("suresh@access.invalid");
  const cook = await login("kumar@access.invalid");
  const cookA = await login("meena@access.invalid");
  const manager = await login("anil@access.invalid");

  const food = (await O("GET", "/menu/tax-rates")).find((rate) => rate.isDefault);
  const cakes = await O("POST", "/menu/categories", { name: "Cakes" }, 201);
  const cake = await O("POST", "/menu/products", { categoryId: cakes.id, name: "Chocolate truffle cake", price: 900, taxRateId: food.id, isAvailable: true }, 201);
  const floor = await one("INSERT INTO floors (restaurant_id, name) VALUES ($1, 'Courtyard') RETURNING id", [rid]);
  const table = (no) =>
    one("INSERT INTO dining_tables (restaurant_id, floor_id, table_no, capacity, qr_token) VALUES ($1, $2, $3, 4, $4) RETURNING id, table_no, qr_token",
      [rid, floor.id, no, crypto.randomBytes(16).toString("hex")]);
  const [T1, T2] = [await table("T1"), await table("T2")];
  await O("POST", "/business-day/open", { openingCash: 1000 }, 201);

  // ---------------------------------------------------------------- pre-orders

  await t.test("pre-orders: In production and Ready need preorders.produce, which the owner ticks for a kitchen role; handing over stays orders.create", async () => {
    const day = addDays(today(zone), 1);
    const book = async (name, mobile, headers) =>
      O("POST", "/preorders", { customerName: name, customerMobile: mobile, dueAt: momentAt(day, "11:00", zone), items: [{ productId: cake.id, quantity: 1, notes: `Happy birthday ${name}` }] }, 201, headers);
    const main = await book("Riya", "9845012345");
    const rooftop = await book("Arjun", "9845012346", atA);

    // The kitchen's built-in role reads the bake list but moves nothing.
    await refused("POST", `/preorders/${main.id}/status`, { status: "in_production" }, 403, cook);
    assert.equal((await O("GET", `/preorders/${main.id}`)).status, "booked");
    // A role that took orders keeps moving them along (the cashier's).
    const started = await request("POST", `/preorders/${main.id}/status`, { status: "in_production" }, 200, cashier);
    assert.equal(started.data.status, "in_production");
    assert.equal(started.data.customerMobile, "9845012345");
    assert.equal((await auditOf("status", "preorder", main.id)).length, 1);

    // The owner ticks it on the oven role (the role editor) and moves the cook onto it.
    const oven = (await O("GET", "/roles")).find((row) => row.code === "OVEN");
    assert.ok(!oven.permissions.includes("preorders.produce"));
    const permissions = (await O("GET", "/roles/permissions")).find((row) => row.code === "preorders.produce");
    assert.deepEqual([permissions.module, permissions.name, permissions.enforced], ["kitchen", "Move pre-orders to In production and Ready", true]);
    await O("PUT", `/roles/${oven.id}`, { name: oven.name, permissions: [...oven.permissions, "preorders.produce"] });
    const cookUser = await O("GET", `/users/${cookId}`);
    await O("PUT", `/users/${cookId}`, { name: cookUser.name, email: cookUser.email, mobile: null, outletId: null, status: "active", roleIds: [oven.id] });
    const ready = await request("POST", `/preorders/${main.id}/status`, { status: "ready" }, 200, cook);
    // The kitchen is told what it changed, not the guest's mobile or the money.
    assert.deepEqual(ready.data, { id: main.id, number: main.number, status: "ready" });
    // Handing it over is still taking an order.
    await refused("POST", `/preorders/${main.id}/collect`, {}, 403, cook);
    // A status out of turn is still refused for whoever asks.
    await refused("POST", `/preorders/${main.id}/status`, { status: "in_production" }, 409, cook, null, /cannot be marked in production/);

    // The bake list: the kitchen not tied to an outlet reads the main
    // counter's unless it picks another till; each order says where it is.
    let list = (await request("GET", `/preorders/bake-list?day=${day}`, undefined, 200, cook)).data;
    assert.deepEqual(list.counter, { outletId: null, name: "Main counter" });
    assert.deepEqual(list.counters, [{ outletId: null, name: "Main counter" }, { outletId: Number(outletA.id), name: "Rooftop" }]);
    assert.deepEqual(list.items.flatMap((item) => item.orders.map((order) => [order.id, order.number, order.status])), [[main.id, main.number, "ready"]]);
    list = (await request("GET", `/preorders/bake-list?day=${day}&outletId=${outletA.id}`, undefined, 200, cook)).data;
    assert.deepEqual(list.counter, { outletId: Number(outletA.id), name: "Rooftop" });
    assert.deepEqual(list.items.flatMap((item) => item.orders.map((order) => [order.id, order.status, order.customer])), [[rooftop.id, "booked", "Arjun"]]);
    list = (await request("GET", `/preorders/bake-list?day=${day}&outletId=main`, undefined, 200, cook)).data;
    assert.deepEqual(list.items.flatMap((item) => item.orders.map((order) => order.id)), [main.id]);
    // The manager's outlet switcher (X-Outlet-Id) still picks for whoever has it.
    list = (await request("GET", `/preorders/bake-list?day=${day}`, undefined, 200, owner, atA)).data;
    assert.equal(list.counter.outletId, Number(outletA.id));
    await refused("GET", `/preorders/bake-list?day=${day}&outletId=999999`, undefined, 404, cook, null, /Outlet not found/);
    await refused("GET", `/preorders/bake-list?day=${day}&outletId=roof`, undefined, 400, cook, null, /Choose an outlet, or the main counter/);

    // Staff tied to an outlet read their own and pick nothing.
    list = (await request("GET", `/preorders/bake-list?day=${day}`, undefined, 200, cookA)).data;
    assert.equal(list.counter.outletId, Number(outletA.id));
    assert.equal(list.counters, null);
    assert.equal((await request("GET", `/preorders/bake-list?day=${day}&outletId=${outletA.id}`, undefined, 200, cookA)).data.counter.outletId, Number(outletA.id));
    await refused("GET", `/preorders/bake-list?day=${day}&outletId=main`, undefined, 403, cookA, null, /one outlet only/);

    for (const booked of [main, rooftop]) await O("POST", `/preorders/${booked.id}/cancel`, { reason: "Test order taken off" });
  });

  // ---------------------------------------------------------------- table requests

  await t.test("Table requests with QR ordering off: a waiter's bill ask reaches the inbox, the badges and the bell; the guests' requests stay out", async () => {
    // While QR ordering is on, a guest at T1 asks for water and one at T2 for the bill.
    const guestCall = async (tableRow, type) => {
      const response = await fetch(`${base}/public/tables/${tableRow.qr_token}/calls`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, clientKey: crypto.randomUUID() }),
      });
      assert.equal(response.status, 201, await response.text());
      return Number((await one("SELECT id FROM table_requests WHERE table_id = $1 AND request_type = $2 ORDER BY id DESC LIMIT 1", [tableRow.id, type])).id);
    };
    const water = await guestCall(T1, "water");
    const guestBill = await guestCall(T2, "bill");
    await feature("qr_ordering", false);
    await feature("online_ordering", false);
    try {
      for (const tableRow of [T1, T2]) {
        await request("POST", "/orders", { orderType: "dine_in", tableId: tableRow.id, guestCount: 2, source: "captain", items: [{ productId: cake.id, quantity: 1 }] }, 201, captain);
      }
      const asked = await request("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 201, captain);
      assert.equal(asked.message, "The counter has table T1's bill request.");
      assert.deepEqual([asked.data.type, asked.data.status, asked.data.askedByName], ["bill", "pending", "Suresh captain"]);
      // A second ask counts on the waiter's own.
      const again = await request("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 200, captain);
      assert.deepEqual([again.data.id, again.data.repeatCount], [asked.data.id, 1]);
      // At T2 a guest's bill request is still open from before, out of the
      // inbox now: the waiter's ask counts on it, and it takes the waiter's
      // name, so the counter sees it.
      const atT2 = await request("POST", "/table-requests/bill-asks", { tableId: T2.id, clientKey: crypto.randomUUID() }, 200, captain);
      assert.deepEqual([atT2.data.id, atT2.data.repeatCount, atT2.data.askedByName], [guestBill, 1, "Suresh captain"]);
      assert.match(atT2.message, /already has table T2's bill request/);

      // At the counter: the waiters' asks alone, in the list and in the badges' summary.
      const inbox = (await request("GET", "/table-requests?view=pending", undefined, 200, cashier)).data;
      assert.deepEqual(inbox.items.map((row) => [row.tableNo, row.id, row.type, row.askedByName]).sort(),
        [["T1", asked.data.id, "bill", "Suresh captain"], ["T2", guestBill, "bill", "Suresh captain"]]);
      const summary = (await request("GET", "/table-requests/summary", undefined, 200, cashier)).data;
      assert.deepEqual([summary.openCallsByType.bill, summary.openCallsByType.water, summary.unansweredCalls, summary.pendingOrders], [2, 0, 2, 0]);
      // The bell says it too, once it has waited, and not the guests' calls.
      const bell = await require("../../src/notifications/providers/tableRequests").collect({ restaurantId: rid, now: new Date(Date.now() + 10 * 60000), pool });
      assert.deepEqual(bell.map((alert) => alert.title.split(" — ")[0]).sort(), ["Table T1 asked for the bill", "Table T2 asked for the bill"]);

      // The guests' own routes wait for QR or online ordering.
      await refused("GET", "/table-requests/settings", undefined, 403, cashier, "feature_off");
      await refused("POST", `/table-requests/${water}/reject`, { reason: "Closed" }, 403, cashier, "feature_off");
      await refused("POST", `/table-requests/${water}/accept`, {}, 403, cashier, "feature_off");
      // The counter closes the waiters' asks.
      for (const id of [asked.data.id, guestBill]) await request("POST", `/table-requests/${id}/done`, {}, 200, cashier);
      assert.equal((await request("GET", "/table-requests/summary", undefined, 200, cashier)).data.unansweredCalls, 0);
    } finally {
      await feature("qr_ordering", true);
    }
    // QR ordering back on: the guest's water is in the inbox again.
    const back = (await request("GET", "/table-requests?view=pending", undefined, 200, cashier)).data;
    assert.deepEqual(back.items.map((row) => row.id), [water]);
    await request("POST", `/table-requests/${water}/done`, {}, 200, cashier);
  });

  // ---------------------------------------------------------------- a PIN someone else sets

  await t.test("a PIN an admin sets switches a till to its person, who then chooses their own, and approves nothing as them", async () => {
    const GIVEN = "5831";
    const OWN = "7392";
    const set = await request("PUT", `/users/${managerId}/pin`, { pin: GIVEN, confirmPin: GIVEN }, 200, owner);
    assert.match(set.message, /they choose their own the first time they use it; until then it approves nothing/);
    assert.equal(set.data.pinGiven, true);
    assert.equal((await one("SELECT pin_must_change FROM users WHERE id = $1", [managerId])).pin_must_change, true);
    assert.deepEqual((await auditOf("create", "user_pin", managerId)).map((row) => [Number(row.user_id), row.details.setByAnother]), [[ownerId, true]]);
    assert.equal((await O("GET", "/users")).find((row) => row.id === managerId).pinGiven, true);

    // Signed in with the password, the person carries on; their profile says the PIN was given.
    let me = (await request("GET", "/auth/me", undefined, 200, manager)).data;
    assert.deepEqual([me.hasPin, me.pinGiven, me.pinChangeRequired], [true, true, false]);
    await request("GET", "/orders", undefined, 200, manager);

    // It approves nothing as them: named, refused before it is read (no try spent); on its own, it matches nobody.
    const approvers = (await request("GET", "/auth/approvers?permission=audit.view", undefined, 200, cashier)).data.approvers;
    assert.deepEqual(approvers.map((row) => [row.id, row.pinGiven]), [[managerId, true]]);
    const approval = { permission: "audit.view", approverId: managerId, pin: GIVEN, label: "Read the activity log" };
    await refused("POST", "/auth/approvals", approval, 409, cashier, "pin_not_own",
      /^Anil manager's PIN was set by someone else, so it cannot approve anything until Anil manager chooses their own: My profile › Personal PIN\.$/);
    assert.equal((await one("SELECT pin_failed_count FROM users WHERE id = $1", [managerId])).pin_failed_count, 0);
    await refused("POST", "/auth/approvals", { permission: "audit.view", pin: GIVEN }, 400, cashier, "wrong_pin");

    // It unlocks their own locked till, and the answer asks for a PIN of their own.
    assert.deepEqual((await request("POST", "/auth/unlock", { pin: GIVEN }, 200, manager)).data, { unlocked: true, pinChangeRequired: true });
    await request("GET", "/orders", undefined, 200, manager);

    // It switches the cashier's till to them: the session answers nothing but choosing their own.
    const switched = (await request("POST", "/auth/pin-login", { userId: managerId, pin: GIVEN }, 200, cashier)).data;
    assert.deepEqual([switched.user.id, switched.user.pinChangeRequired, switched.user.pinGiven], [managerId, true, true]);
    const till = switched.token;
    await refused("GET", "/orders", undefined, 403, till, "pin_change_required", /Choose a PIN of your own before you carry on/);
    await refused("GET", "/live", undefined, 403, till, "pin_change_required");
    me = (await request("GET", "/auth/me", undefined, 200, till)).data;
    assert.equal(me.pinChangeRequired, true);
    // The till's lock screen still works meanwhile.
    assert.ok((await request("GET", "/auth/till-users", undefined, 200, till)).data.some((row) => row.id === managerId));
    assert.deepEqual((await request("POST", "/auth/unlock", { pin: GIVEN }, 200, till)).data, { unlocked: true, pinChangeRequired: true });

    // Their own: with their password, and not the PIN they were given.
    await refused("PUT", "/auth/me/pin", { password: "not-the-password", pin: OWN, confirmPin: OWN }, 400, till, "wrong_password", /Your password is not right/);
    await refused("PUT", "/auth/me/pin", { password: ownPassword("anil@access.invalid"), pin: GIVEN, confirmPin: GIVEN }, 400, till, null,
      /^Choose a PIN of your own, not the one you were given$/);
    const chosen = await request("PUT", "/auth/me/pin", { password: ownPassword("anil@access.invalid"), pin: OWN, confirmPin: OWN }, 200, till);
    assert.equal(chosen.message, "Your own PIN is set. Use it from now on.");
    assert.deepEqual([chosen.data.pinGiven, chosen.data.pinChangeRequired], [false, false]);
    assert.equal((await one("SELECT pin_must_change FROM users WHERE id = $1", [managerId])).pin_must_change, false);
    assert.deepEqual((await auditOf("reset", "user_pin", managerId)).map((row) => [Number(row.user_id), row.details.replacedGivenPin]), [[managerId, true]]);
    // The till carries on as them, and their own PIN approves.
    await request("GET", "/orders", undefined, 200, till);
    const granted = await request("POST", "/auth/approvals", { ...approval, pin: OWN }, 201, cashier);
    assert.equal(granted.data.approver.id, managerId);
    // Their own PIN at a till asks for nothing more.
    assert.deepEqual((await request("POST", "/auth/unlock", { pin: OWN }, 200, manager)).data, { unlocked: true });
    const again = (await request("POST", "/auth/pin-login", { userId: managerId, pin: OWN }, 200, cashier)).data;
    assert.equal(again.user.pinChangeRequired, false);
    await request("GET", "/orders", undefined, 200, again.token);

    // An admin who sets their own PIN under Users sets their own; removing a PIN takes the mark with it.
    assert.equal((await request("PUT", `/users/${ownerId}/pin`, { pin: "2957", confirmPin: "2957" }, 200, owner)).data.pinGiven, false);
    await request("PUT", `/users/${cashierId}/pin`, { pin: "8263", confirmPin: "8263" }, 200, owner);
    assert.equal((await one("SELECT pin_must_change FROM users WHERE id = $1", [cashierId])).pin_must_change, true);
    await request("DELETE", `/users/${cashierId}/pin`, undefined, 200, owner);
    assert.deepEqual(await one("SELECT pin_hash, pin_must_change FROM users WHERE id = $1", [cashierId]), { pin_hash: null, pin_must_change: false });
    // The database keeps no mark without a PIN.
    await assert.rejects(pool.query("UPDATE users SET pin_must_change = TRUE WHERE id = $1", [cashierId]), /users_pin_must_change_has_pin/);
  });

  // ---------------------------------------------------------------- businesses

  const ownerRequest = async (method, url, body, expected = 200) => (await request(method, url, body, expected, owner)).data;
  const [fashion, grocery, clinic] = await createBusinesses(ownerRequest, "ACCESS", ["fashion", "grocery", "healthcare"]);
  const at = (business) => (route) => `/businesses/${business.id}/${route}`;
  const rolesOf = async (business) => (await O("GET", at(business)("roles?limit=100"))).items;
  const roleOf = async (business, template) => (await rolesOf(business)).find((role) => role.template_code === template);

  await t.test("Staff & access: a manager tied to a department lists, counts and finds only its people; a login used elsewhere gets no password from here", async () => {
    const F = at(fashion);
    const men = await O("POST", F("departments"), { name: "Menswear" }, 201);
    const women = await O("POST", F("departments"), { name: "Womenswear" }, 201);
    const managerRole = await roleOf(fashion, "manager");
    const head = await O("POST", F("roles"), { name: "Department head", permissions: [...managerRole.permissions, "access.view", "access.edit"] }, 201);
    const cashierRole = await roleOf(fashion, "cashier");
    const keeperRole = await roleOf(fashion, "stock_keeper");
    const login_ = async (name, email, roleId, workDepartmentId) =>
      O("POST", F("staff-accounts"), { name, email, password, roleId, ...(workDepartmentId ? { workDepartmentId } : {}) }, 201);
    const farhan = await login_("Farhan Ali", "farhan@access.invalid", head.id, men.id);
    const imran = await login_("Imran Khan", "imran@access.invalid", cashierRole.id, men.id);
    const lata = await login_("Lata Shah", "lata@access.invalid", cashierRole.id, women.id);
    await login_("Gopal Das", "gopal@access.invalid", keeperRole.id);
    // The restaurant's cashier works in Menswear too: a login also used at the restaurant.
    await O("POST", F("members"), { userId: cashierId, roleId: cashierRole.id, workDepartmentId: men.id }, 201);
    const headToken = await login("farhan@access.invalid");
    const list = async (query = "", auth = headToken) => (await request("GET", F(`members${query}`), undefined, 200, auth)).data;

    // The department head: Menswear's people alone, counted and searched as such.
    let page = await list();
    assert.equal(page.total, 3);
    assert.deepEqual(page.items.map((m) => [m.name, m.department_name, m.manages, m.login_elsewhere]), [
      ["Farhan Ali", "Menswear", false, false],
      ["Imran Khan", "Menswear", true, false],
      ["Ravi cashier", "Menswear", true, true],
    ]);
    assert.equal((await list("?q=Lata")).total, 0);
    assert.equal((await list("?q=Imran")).total, 1);
    // Asking for another department changes nothing.
    assert.deepEqual((await list(`?department=${women.id}`)).items.map((m) => m.name), ["Farhan Ali", "Imran Khan", "Ravi cashier"]);
    // The owner sees everyone, and may ask for one department.
    page = await list("", owner);
    assert.equal(page.total, 6);
    assert.deepEqual((await list(`?department=${women.id}`, owner)).items.map((m) => m.name), ["Lata Shah"]);
    assert.equal(page.items.find((m) => m.full_access).login_elsewhere, true);

    // A login used here alone gets a new password from the head; one used elsewhere is refused, as the list says.
    await request("POST", F(`staff-accounts/${imran.user_id}/password`), { password: `New-${crypto.randomBytes(6).toString("hex")}` }, 200, headToken);
    await refused("POST", F(`staff-accounts/${cashierId}/password`), { password: `New-${crypto.randomBytes(6).toString("hex")}` }, 409, headToken, null, /also used in another business/);
    // Someone of another department is not the head's to change.
    await refused("POST", F(`staff-accounts/${lata.user_id}/password`), { password: `New-${crypto.randomBytes(6).toString("hex")}` }, 403, headToken, null, /does not work in your department/);
    assert.ok(farhan.user_id);
  });

  await t.test("a business's PIN checks refuse a PIN someone else set: the counter's switch gives no bill proof, its bill PIN, a manager's PIN, a credit release and a signature", async () => {
    const G = at(grocery);
    const H = at(clinic);
    const managerRole = await roleOf(grocery, "manager");
    await O("POST", G("members"), { userId: managerId, roleId: managerRole.id }, 201);
    await O("POST", H("members"), { userId: managerId, roleId: (await roleOf(clinic, "manager")).id }, 201);
    const s = await O("GET", G("settings"));
    await O("PUT", G("settings"), { displayName: s.display_name, taxMode: s.tax_mode, rounding: s.rounding, fiscalYearStartMonth: s.fiscal_year_start_month,
      dateFormat: s.date_format, counterPinEveryBill: true });
    const location = (await O("GET", G("locations"))).items[0];
    const service = await O("POST", G("catalog"), { name: "Gift wrapping", code: "WRAP", kind: "service", unit: "service", price: "20", taxRate: "18" }, 201);
    const bill = (extra) => ({ kind: "sale", requestKey: crypto.randomUUID(), locationId: location.id, channel: "counter", lines: [{ skuId: service.id, quantity: "1" }],
      payment: { method: "cash", amount: "full" }, ...extra });
    const signatory = await O("POST", H("health/signatories"), { kind: "pathologist", userId: managerId, name: "Dr. Anil", registrationNo: "TSMC 40001" }, 201);

    const GIVEN = "6284";
    const OWN = "3917";
    await request("PUT", `/users/${managerId}/pin`, { pin: GIVEN, confirmPin: GIVEN }, 200, owner);

    // The counter switches to them with it: the session must choose its own PIN, and gets no proof for a bill.
    const switched = (await request("POST", G("counter/switch"), { userId: managerId, pin: GIVEN }, 200, owner)).data;
    assert.deepEqual([switched.user.id, switched.user.pinChangeRequired, switched.billProof], [managerId, true, undefined]);
    await refused("GET", G("context"), undefined, 403, switched.token, "pin_change_required");
    const [audit] = await all("SELECT details FROM business_audit WHERE business_id = $1 AND action = 'counter.switched' ORDER BY id DESC LIMIT 1", [grocery.id]);
    assert.deepEqual(audit.details, { from: ownerId, to: managerId, billProof: false, pinGiven: true });

    // Their own session's bill with it: refused before it is read.
    await refused("POST", G("documents"), bill({ counterPin: GIVEN }), 409, manager, "pin_not_own",
      /^Your PIN was set by someone else, so it cannot confirm a bill until you choose your own: My profile › Personal PIN\.$/);
    assert.equal((await one("SELECT pin_failed_count FROM users WHERE id = $1", [managerId])).pin_failed_count, 0);

    // A manager's PIN on a refund, a credit hold's release and a pathologist's signature, as their services read them.
    const access = require("../../src/modules/business/core/services/businessAccess.service");
    const pins = require("../../src/modules/business/salon-weight/services/businessManagerPin");
    const credit = require("../../src/modules/business/wholesale/services/businessWholesaleCredit.service");
    const health = require("../../src/modules/business/health/services/healthCommon");
    const ownerUser = { id: ownerId, name: "Hearth owner" };
    const groceryAsOwner = await access.load(ownerUser, grocery.id);
    const clinicAsOwner = await access.load(ownerUser, clinic.id);
    const notOwn = (pattern) => (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.details.reason, "pin_not_own");
      assert.match(error.message, pattern);
      return true;
    };
    await assert.rejects(pins.readApproval(groceryAsOwner, ownerUser, { reason: "Damaged pack", approverId: managerId, pin: GIVEN }, "sales.refund"),
      notOwn(/^Anil manager's PIN was set by someone else, so it cannot approve anything/));
    await assert.rejects(credit.readRelease(groceryAsOwner, ownerUser, { reason: "Pays on Friday", approverId: managerId, pin: GIVEN }),
      notOwn(/cannot approve anything/));
    await assert.rejects(health.verifySignature(clinicAsOwner, "pathologist", { signatoryId: signatory.id, pin: GIVEN }, "Approving the report"),
      notOwn(/^Dr\. Anil's PIN was set by someone else, so it cannot sign anything until Dr\. Anil chooses their own/));
    assert.equal((await one("SELECT pin_failed_count FROM users WHERE id = $1", [managerId])).pin_failed_count, 0);

    // Their own PIN, chosen from the switched session, and each of them takes it.
    await request("PUT", "/auth/me/pin", { password: ownPassword("anil@access.invalid"), pin: OWN, confirmPin: OWN }, 200, switched.token);
    await request("GET", G("context"), undefined, 200, switched.token);
    assert.equal((await pins.readApproval(groceryAsOwner, ownerUser, { reason: "Damaged pack", approverId: managerId, pin: OWN }, "sales.refund")).approver.id, managerId);
    assert.equal(Number((await credit.readRelease(groceryAsOwner, ownerUser, { reason: "Pays on Friday", approverId: managerId, pin: OWN })).approver.id), managerId);
    assert.equal(Number((await health.verifySignature(clinicAsOwner, "pathologist", { signatoryId: signatory.id, pin: OWN }, "Approving the report")).id), Number(signatory.id));
    const sold = await request("POST", G("documents"), bill({ counterPin: OWN }), 201, manager);
    assert.equal(Number((await one("SELECT created_by FROM business_documents WHERE id = $1", [sold.data.id])).created_by), managerId);
    // A switch with their own PIN gives the next bill its proof again.
    const proofed = (await request("POST", G("counter/switch"), { userId: managerId, pin: OWN }, 200, owner)).data;
    assert.ok(proofed.billProof);
    assert.equal(proofed.user.pinChangeRequired, false);
  });
});
