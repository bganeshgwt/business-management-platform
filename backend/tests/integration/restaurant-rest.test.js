// What is left inside the restaurant, end to end on a throwaway database.
//
// The kitchen: a station report over a range of business days (tickets,
// dishes, the average and 90th-percentile times from sent to ready and from
// ready to served, late tickets, the busiest hours; cancelled tickets left out
// and counted) on a fixed set of tickets, and an earlier day's tickets read
// only. Pre-orders and their outlet: the outlet's usage counts its open
// pre-orders, switching Pre-orders & cakes off warns about them, and closing
// an outlet while a pre-order is booked there cannot both pass. The guest
// book keeps a PAN (or a declaration of none), masked for staff who do not
// see guests' details and audited; a bill over ₹2,00,000 naming the guest
// takes it with its first payment; cash under one PAN adds up on the
// restaurant's day, walk-in bills included, across its midnight. The captain
// app: asking the counter for a table's bill (once per open bill), serving a
// dish on its own (and the last one serving the ticket), named courses and a
// first course held until Fire. The migration's Down half and Up again.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { addDays, momentAt, today, zoneWithHour } = require("./helpers/dates");
const { signIn } = require("./helpers/signIn");

test("restaurant: kitchen reports, pre-orders, the guest's PAN and the captain app", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
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

  await t.test("the Down half restores the cash limit's functions as they were, and Up brings everything back", async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const body = async (name) => (await scratch.query("SELECT prosrc FROM pg_proc WHERE proname = $1", [name])).rows.map((row) => row.prosrc);
    const columns = async () =>
      (await scratch.query(`SELECT table_name || '.' || column_name AS name FROM information_schema.columns
        WHERE (table_name = 'customers' AND column_name IN ('pan', 'pan_declaration'))
           OR (table_name = 'kot_items' AND column_name IN ('served_at', 'served_by', 'course_name'))
           OR (table_name = 'service_settings' AND column_name = 'course_names') ORDER BY 1`)).rows.map((row) => row.name);
    assert.equal((await columns()).length, 6);
    assert.equal((await body("restaurant_cash_from_person")).length, 1);
    const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith("_restaurant-rest.sql")).split("_")[0]);
    await migrate({ direction: "down", count: stamp, timestamp: true });
    assert.deepEqual(await columns(), []);
    assert.deepEqual(await body("restaurant_cash_from_person"), []);
    assert.deepEqual(await body("restaurant_pan_cash_check"), []);
    // Each replaced function is back to its body in the migration that made it.
    const earlier = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((file) => file.endsWith("_restaurant-cash-limit-and-pan.sql"))), "utf8").replace(/\r\n/g, "\n");
    const made = (name) => {
      const at = earlier.indexOf(`CREATE FUNCTION ${name}(`);
      const start = earlier.indexOf("$$", at) + 2;
      return earlier.slice(start, earlier.indexOf("$$", start));
    };
    for (const name of ["restaurant_cash_from_guest", "restaurant_cash_limit_payment", "restaurant_pan_payment"]) {
      assert.deepEqual((await body(name)).map((text) => text.replace(/\r\n/g, "\n")), [made(name)], name);
    }
    await migrate({ direction: "up", count: Infinity });
    assert.equal((await columns()).length, 6);
  });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");
  // An hour well away from the restaurant's midnight, so "today" cannot turn
  // over in the middle of the test.
  const zone = zoneWithHour(1, 21);
  const made = await restaurantService.createRestaurant({
    name: "Courtyard Kitchen",
    code: "RESTREST1",
    invoicePrefix: "CK",
    timezone: zone,
    admin: { name: "Courtyard owner", email: "owner@rest.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Kitchen",
    code: "RESTREST2",
    admin: { name: "Other owner", email: "other@rest.invalid", password },
  });

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, outletId = null) => {
    const row = await one("INSERT INTO users (restaurant_id, name, email, password_hash, outlet_id) VALUES ($1, $2, $3, $4, $5) RETURNING id", [rid, name, email, hash, outletId]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
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
    return { status: response.status, body: await response.json() };
  }
  async function request(method, url, body, expected, auth, headers) {
    const result = await call(method, url, body, auth, headers);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const owner = await login("owner@rest.invalid");
  const other = await login("other@rest.invalid");
  const O = async (method, url, body, expected = 200, headers) => (await request(method, url, body, expected, owner, headers)).data;
  const refused = async (method, url, body, status, pattern, auth = owner, headers) => {
    const result = await call(method, url, body, auth, headers);
    assert.equal(result.status, status, `${method} ${url}: ${JSON.stringify(result.body)}`);
    assert.match(result.body.message, pattern);
    return result.body;
  };
  const auditOf = async (action, entityType, entityId) => {
    let rows = [];
    for (let tries = 0, last = -1; tries < 15 && rows.length !== last; tries += 1) {
      last = rows.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      rows = await all("SELECT user_id, details, entity_label FROM audit_logs WHERE restaurant_id = $1 AND action = $2 AND entity_type = $3 AND entity_id = $4 ORDER BY id",
        [rid, action, entityType, entityId]);
    }
    return rows;
  };
  const feature = async (code, enabled) => O("PUT", `/restaurants/current/features/${code}`, { enabled });

  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0, timezone: zone, taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 0,
    invoicePrefix: "CK", gstSplit: true, autoConsumeStock: false, loyaltyEnabled: false, autoPrintBill: false, printShowQr: false,
  });
  for (const code of ["kitchen_display", "qr_ordering", "preorders"]) {
    await feature(code, true);
  }

  const outletA = await O("POST", "/outlets", { name: "Rooftop", code: "ROOF", status: "active" }, 201);
  const atA = { "X-Outlet-Id": String(outletA.id) };
  await staff("Ravi cashier", "ravi@rest.invalid", "CASHIER");
  await staff("Suresh captain", "suresh@rest.invalid", "CAPTAIN");
  await staff("Meena captain", "meena@rest.invalid", "CAPTAIN", outletA.id);
  await staff("Kumar cook", "kumar@rest.invalid", "KITCHEN");
  await staff("Pickup screen", "screen@rest.invalid", "DISPLAY");
  const cashier = await login("ravi@rest.invalid");
  const captain = await login("suresh@rest.invalid");
  const captainA = await login("meena@rest.invalid");
  const cook = await login("kumar@rest.invalid");
  const screen = await login("screen@rest.invalid");
  const C = async (method, url, body, expected = 200, headers) => (await request(method, url, body, expected, cashier, headers)).data;
  const K = async (method, url, body, expected = 200, headers) => (await request(method, url, body, expected, captain, headers)).data;

  const food = (await O("GET", "/menu/tax-rates")).find((rate) => rate.isDefault);
  const mains = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const breads = await O("POST", "/menu/categories", { name: "Breads" }, 201);
  const banquets = await O("POST", "/menu/categories", { name: "Banquets" }, 201);
  const dish = (category, name, price) => O("POST", "/menu/products", { categoryId: category.id, name, price, taxRateId: food.id, isAvailable: true }, 201);
  const dal = await dish(mains, "Dal makhani", 280);
  const paneer = await dish(mains, "Paneer tikka", 320);
  const naan = await dish(breads, "Butter naan", 60);
  const cake = await dish(mains, "Black forest cake", 900);
  // ₹1,00,000 + 5% GST = ₹1,05,000 a plate.
  const hall = await dish(banquets, "Wedding banquet", 100000);
  const tandoor = await request("POST", "/kitchen/stations", { name: "Tandoor", color: "red" }, 201, owner).then((body) => body.data);
  await O("PUT", `/kitchen/category-stations/${breads.id}`, { stationId: tandoor.id });

  const floor = await one("INSERT INTO floors (restaurant_id, name) VALUES ($1, 'Courtyard') RETURNING id", [rid]);
  const table = (no, outletId = null) =>
    one("INSERT INTO dining_tables (restaurant_id, floor_id, table_no, capacity, qr_token, outlet_id) VALUES ($1, $2, $3, 4, $4, $5) RETURNING id",
      [rid, floor.id, no, crypto.randomBytes(16).toString("hex"), outletId]);
  const [T1, T2, T3, T4, A1] = [await table("T1"), await table("T2"), await table("T3"), await table("T4"), await table("A1", outletA.id)];

  await O("POST", "/business-day/open", { openingCash: 1000 }, 201);
  await O("POST", "/business-day/open", { openingCash: 500 }, 201, atA);
  const todayHere = today(zone);
  const yesterday = addDays(todayHere, -1);
  const lines = (...pairs) => pairs.map(([product, quantity, extra = {}]) => ({ productId: product.id, quantity, ...extra }));
  const ticketsOf = async (orderId) => (await request("GET", `/kitchen/orders/${orderId}/kots`, undefined, 200, cook)).data;

  // ---------------------------------------------------------------- the kitchen

  await t.test("the kitchen-station report: each station's tickets, dishes, times, late tickets and busiest hours; cancelled tickets left out", async () => {
    // Five orders, cut into tickets now, then dated to yesterday's business
    // day with fixed times on the restaurant's clock:
    //   main kitchen  M1 sent 19:00, ready 19:10, served 19:15
    //                 M2 sent 19:20, ready 19:45 (late: 25 min), served 20:00
    //                 M3 sent 20:05, ready and served 20:10 (bumped straight to served)
    //                 M4 sent 20:30, cancelled (left out)
    //                 M5 sent 18:00, cleared by a manager at 21:00 (late, never ready)
    //   tandoor       T  sent 19:05, ready 19:13, served 19:20, at the outlet
    const orders = [];
    for (const items of [lines([dal, 2]), lines([paneer, 1]), lines([dal, 1], [paneer, 1]), lines([dal, 3]), lines([paneer, 2]), lines([naan, 4])]) {
      orders.push(await O("POST", "/orders", { orderType: "takeaway", items }, 201));
    }
    const kots = [];
    for (const order of orders) {
      kots.push(...(await ticketsOf(order.id)));
    }
    assert.equal(kots.length, 6);
    const day = await one(
      `INSERT INTO business_days (restaurant_id, business_date, opened_at, closed_at, day_status)
       VALUES ($1, $2, $3, $4, 'closed') RETURNING id`,
      [rid, yesterday, momentAt(yesterday, "17:00", zone), momentAt(yesterday, "23:30", zone)]
    );
    const at = (time) => (time ? momentAt(yesterday, time, zone) : null);
    const set = (kot, status, sent, ready, served, extra = {}) =>
      pool.query(
        `UPDATE kots SET business_day_id = $2, kot_status = $3::varchar, created_at = $4, ready_at = $5, served_at = $6,
                         cancelled_at = CASE WHEN $3::varchar = 'cancelled' THEN $4::timestamptz END, cleared_reason = $7, outlet_id = $8
         WHERE id = $1`,
        [kot.id, day.id, status, at(sent), at(ready), at(served), extra.cleared || null, extra.outletId || null]
      );
    await set(kots[0], "served", "19:00", "19:10", "19:15");
    await set(kots[1], "served", "19:20", "19:45", "20:00");
    await set(kots[2], "served", "20:05", "20:10", "20:10");
    await set(kots[3], "cancelled", "20:30", null, null);
    await set(kots[4], "served", "18:00", null, "21:00", { cleared: "manager" });
    await set(kots[5], "served", "19:05", "19:13", "19:20", { outletId: outletA.id });

    const report = await O("GET", `/reports/kitchen-stations?from=${yesterday}&to=${yesterday}`);
    assert.equal(report.from, yesterday);
    assert.equal(report.lateMinutes, 20);
    assert.equal(report.cancelledLeftOut, 1);
    const main = report.stations.find((row) => row.stationName === "Main kitchen");
    const oven = report.stations.find((row) => row.stationName === "Tandoor");
    assert.deepEqual(report.stations.map((row) => row.stationName), ["Main kitchen", "Tandoor"]);
    // Main: 2 + 1 + 2 + 2 dishes on four tickets; sent to ready 600, 1500 and
    // 300 seconds (average 800, 90th percentile 1,320); ready to served 300
    // and 900 (the bumped ticket never waited at the pass).
    assert.deepEqual(
      [main.tickets, main.dishes, main.timedReady, main.avgReadySeconds, main.p90ReadySeconds, main.timedServe, main.avgServeSeconds, main.p90ServeSeconds, main.late, main.cleared],
      [4, 7, 3, 800, 1320, 2, 600, 840, 2, 1]
    );
    assert.deepEqual(main.busiestHours, [{ hour: 19, tickets: 2 }, { hour: 18, tickets: 1 }, { hour: 20, tickets: 1 }]);
    assert.deepEqual(
      [oven.tickets, oven.dishes, oven.avgReadySeconds, oven.p90ReadySeconds, oven.avgServeSeconds, oven.late, oven.busiestHours],
      [1, 4, 480, 480, 420, 0, [{ hour: 19, tickets: 1 }]]
    );
    assert.deepEqual(
      [report.total.tickets, report.total.dishes, report.total.avgReadySeconds, report.total.p90ReadySeconds, report.total.avgServeSeconds, report.total.p90ServeSeconds, report.total.late, report.total.cleared],
      [5, 11, 720, 1230, 540, 804, 2, 1]
    );
    assert.deepEqual(report.hours, [{ hour: 18, tickets: 1 }, { hour: 19, tickets: 3 }, { hour: 20, tickets: 1 }]);

    // One outlet: its own tickets only.
    const rooftop = await O("GET", `/reports/kitchen-stations?from=${yesterday}&to=${yesterday}`, undefined, 200, atA);
    assert.deepEqual(rooftop.stations.map((row) => [row.stationName, row.tickets]), [["Tandoor", 1]]);
    assert.equal(rooftop.outletName, "Rooftop");
    // Today has none of them; another restaurant sees nothing of them.
    assert.deepEqual((await O("GET", `/reports/kitchen-stations?from=${todayHere}&to=${todayHere}`)).stations, []);
    assert.equal((await request("GET", `/reports/kitchen-stations?from=${yesterday}&to=${yesterday}`, undefined, 200, other)).data.total, null);
    // Reports open it (reports.view); a cashier or a cook without it does not.
    await request("GET", `/reports/kitchen-stations?from=${yesterday}&to=${yesterday}`, undefined, 403, captain);
    await refused("GET", "/reports/kitchen-stations?from=2026-02-30", undefined, 400, /must be a real date/);

    // The same day's tickets, read only, on the dashboard's kitchen panel:
    // every ticket with its times, and the day's figures.
    const earlier = await request("GET", `/kitchen/day?date=${yesterday}`, undefined, 200, cook).then((body) => body.data);
    assert.equal(earlier.date, yesterday);
    assert.deepEqual(earlier.tickets.map((ticket) => ticket.id), [kots[4].id, kots[0].id, kots[5].id, kots[1].id, kots[2].id, kots[3].id]);
    assert.deepEqual([earlier.stats.totalCount, earlier.stats.lateCount, earlier.stats.clearedCount, earlier.stats.avgReadySeconds], [5, 2, 1, 720]);
    assert.equal(earlier.tickets[1].readyAt, at("19:10"));
    assert.equal((await request("GET", `/kitchen/day?date=${yesterday}`, undefined, 200, cook, atA)).data.tickets.length, 1);
    await refused("GET", `/kitchen/day?date=${addDays(todayHere, 1)}`, undefined, 400, /Pick today or an earlier day/, cook);
    await refused("GET", "/kitchen/day?date=yesterday", undefined, 400, /must be a real date/, cook);
    await request("GET", `/kitchen/day?date=${yesterday}`, undefined, 403, captain);
    // Reading it changes nothing.
    assert.equal((await one("SELECT count(*)::int AS n FROM kots WHERE business_day_id = $1 AND kot_status = 'served'", [day.id])).n, 5);
  });

  // ---------------------------------------------------------------- pre-orders

  const dueTomorrow = momentAt(addDays(todayHere, 1), "11:00", zone);
  const preorder = (headers, name = "Riya") =>
    call("POST", "/preorders", { customerName: name, dueAt: dueTomorrow, items: [{ productId: cake.id, quantity: 1 }] }, owner, headers);

  await t.test("an outlet's usage counts its open pre-orders; switching Pre-orders & cakes off warns about them", async () => {
    const bakery = await O("POST", "/outlets", { name: "Cake counter", code: "CAKE", status: "active" }, 201);
    const atBakery = { "X-Outlet-Id": String(bakery.id) };
    let usage = await O("GET", `/outlets/${bakery.id}/usage`);
    assert.deepEqual([usage.openPreorders, usage.canClose, usage.canDelete], [[], true, true]);
    let warning = await O("POST", "/restaurants/current/features/preorders/preview", { enabled: false });
    assert.ok(!warning.warnings.some((line) => /pre-order/.test(line)));
    assert.ok(warning.hides.includes("Pre-orders & cakes"));

    const first = await preorder(atBakery);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await preorder(atBakery, "Arjun");
    usage = await O("GET", `/outlets/${bakery.id}/usage`);
    assert.deepEqual([usage.openPreorders, usage.canClose, usage.canDelete], [[first.body.data.number, second.body.data.number], false, false]);
    warning = await O("POST", "/restaurants/current/features/preorders/preview", { enabled: false });
    assert.ok(warning.warnings.includes("2 pre-orders are still open (booked, in production or ready). They are kept but hidden: nobody can bake, hand over or cancel them until Pre-orders & cakes is switched back on."), JSON.stringify(warning.warnings));
    // Closing or deleting it is refused, with the numbers.
    await refused("PUT", `/outlets/${bakery.id}`, { name: "Cake counter", code: "CAKE", status: "inactive" }, 409, /still has 2 open pre-orders/);
    await refused("DELETE", `/outlets/${bakery.id}`, undefined, 409, /cannot be deleted yet/);
    // Usage is a manager's question.
    await request("GET", `/outlets/${bakery.id}/usage`, undefined, 403, cashier);

    for (const booked of [first, second]) {
      await O("POST", `/preorders/${booked.body.data.id}/cancel`, { reason: "Party called off" });
    }
    usage = await O("GET", `/outlets/${bakery.id}/usage`);
    assert.deepEqual([usage.openPreorders, usage.canClose], [[], true]);
  });

  await t.test("closing an outlet and booking a pre-order there at the same moment never both pass", async () => {
    // The close takes the outlet first while the booking waits (the restaurant
    // is held here, as another booking holds it while it numbers its own): the
    // close goes through, and the booking then finds the outlet closed.
    const kiosk = await O("POST", "/outlets", { name: "Mall kiosk", code: "KIOSK", status: "active" }, 201);
    const atKiosk = { "X-Outlet-Id": String(kiosk.id) };
    const holder = new Client({ ...connection, database });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM restaurants WHERE id = $1 FOR NO KEY UPDATE", [rid]);
      const booking = preorder(atKiosk, "Kiran");
      for (let tries = 0; tries < 100; tries += 1) {
        const waiting = await one(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock' AND query LIKE '%FROM restaurants WHERE id = $1 FOR UPDATE%'`, [database]);
        assert.ok(tries < 99, "the booking never reached the restaurant's lock");
        if (waiting.n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await O("PUT", `/outlets/${kiosk.id}`, { name: "Mall kiosk", code: "KIOSK", status: "inactive" });
      await holder.query("COMMIT");
      const result = await booking;
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.match(result.body.message, /"Mall kiosk" has just been closed, so it takes no pre-orders/);
    } finally {
      await holder.end();
    }
    assert.equal((await one("SELECT count(*)::int AS n FROM restaurant_preorders WHERE outlet_id = $1", [kiosk.id])).n, 0);

    // Sent together, again and again: one of the two is refused every time,
    // and a closed outlet is never left with a pre-order to bake.
    for (let round = 0; round < 8; round += 1) {
      const stall = await O("POST", "/outlets", { name: `Stall ${round}`, code: `STALL${round}`, status: "active" }, 201);
      const [closed, booked] = await Promise.all([
        call("PUT", `/outlets/${stall.id}`, { name: `Stall ${round}`, code: `STALL${round}`, status: "inactive" }, owner),
        preorder({ "X-Outlet-Id": String(stall.id) }, `Guest ${round}`),
      ]);
      const both = closed.status === 200 && booked.status === 201;
      assert.ok(!both, `round ${round}: the outlet closed and the pre-order booked`);
      assert.ok([200, 409].includes(closed.status) && [201, 400, 403, 409].includes(booked.status), `round ${round}: ${closed.status} ${booked.status}`);
      const state = await one(`SELECT o.status, (SELECT count(*)::int FROM restaurant_preorders p WHERE p.outlet_id = o.id AND p.status = 'booked') AS open
        FROM outlets o WHERE o.id = $1`, [stall.id]);
      assert.ok(!(state.status === "inactive" && state.open > 0), `round ${round}: a closed outlet holds an open pre-order`);
    }
  });

  // ---------------------------------------------------------------- the guest's PAN

  const raise = async (items, extra = {}, body = {}) =>
    O("POST", "/bills", { orderId: (await O("POST", "/orders", { orderType: "takeaway", ...extra, items }, 201)).id, ...body }, 201);
  let lakshmi;

  await t.test("the guest book keeps a PAN or a declaration: checked, masked for staff who do not see guests' details, and audited", async () => {
    await refused("POST", "/crm/customers", { name: "Lakshmi", mobile: "9845012301", pan: "ABC12" }, 400, /PAN must look like ABCDE1234F/);
    await refused("POST", "/crm/customers", { name: "Lakshmi", mobile: "9845012301", pan: "ABCDE1234F", panDeclaration: true }, 400, /not both/);
    lakshmi = await O("POST", "/crm/customers", { name: "Lakshmi", mobile: "9845012301", pan: "abcde1234f" }, 201);
    assert.deepEqual([lakshmi.pan, lakshmi.panMasked, lakshmi.panDeclaration], ["ABCDE1234F", "••••••234F", false]);
    assert.deepEqual((await auditOf("pan", "customer", lakshmi.id))[0].details.changes, { pan: [null, "••••••234F"] });

    // A cashier sees it masked, and an edit that leaves the masked box empty keeps it.
    const seen = (await C("GET", "/crm/customers?search=Lakshmi")).find((row) => row.id === lakshmi.id);
    assert.deepEqual([seen.pan, seen.panMasked], [null, "••••••234F"]);
    const edited = await C("PUT", `/crm/customers/${lakshmi.id}`, { name: "Lakshmi Iyer", pan: null, panDeclaration: false });
    assert.deepEqual([edited.pan, edited.panMasked], [null, "••••••234F"]);
    assert.equal((await one("SELECT pan FROM customers WHERE id = $1", [lakshmi.id])).pan, "ABCDE1234F");
    assert.equal((await auditOf("pan", "customer", lakshmi.id)).length, 1);

    // The declaration instead, then the PAN again: each change in the log.
    const declared = await O("PUT", `/crm/customers/${lakshmi.id}`, { name: "Lakshmi Iyer", pan: null, panDeclaration: true });
    assert.deepEqual([declared.pan, declared.panDeclaration], [null, true]);
    await O("PUT", `/crm/customers/${lakshmi.id}`, { name: "Lakshmi Iyer", pan: "ABCDE1234F", panDeclaration: false });
    const changes = (await auditOf("pan", "customer", lakshmi.id)).map((row) => row.details.changes);
    assert.deepEqual(changes.slice(1), [
      { pan: ["••••••234F", null], panDeclaration: [false, true] },
      { pan: [null, "••••••234F"], panDeclaration: [true, false] },
    ]);
    // The database holds the same rules whatever writes the row.
    await assert.rejects(pool.query("UPDATE customers SET pan = 'abcde1234f' WHERE id = $1", [lakshmi.id]));
    await assert.rejects(pool.query("UPDATE customers SET pan_declaration = TRUE WHERE id = $1", [lakshmi.id]));
  });

  await t.test("a bill over ₹2,00,000 naming the guest takes the guest book's PAN with its first payment; the cashier can still change it", async () => {
    const bill = await raise(lines([hall, 2]), { customerId: lakshmi.id });
    assert.equal(bill.totalAmount, 210000);
    assert.deepEqual([bill.panNeeded, bill.buyerPan, bill.panInGuestBook], [true, null, { pan: "ABCDE1234F", masked: "••••••234F" }]);
    // The cashier sees it masked, and does not type it.
    assert.deepEqual((await C("GET", `/bills/${bill.id}`)).panInGuestBook, { pan: null, masked: "••••••234F" });
    const paid = await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: 10000, transactionRef: "UTR-G1" }, 201);
    assert.deepEqual([paid.buyerPan, paid.panInGuestBook], ["ABCDE1234F", null]);
    // Changed on the bill while it is not settled, as before.
    const changed = await C("PUT", `/bills/${bill.id}/pan`, { pan: "FGHIJ5678K" });
    assert.equal(changed.buyerPan, "FGHIJ5678K");
    assert.equal((await one("SELECT pan FROM customers WHERE id = $1", [lakshmi.id])).pan, "ABCDE1234F");

    // A guest whose guest book says they declared none: the cashier is
    // reminded, and takes the declaration on the bill.
    const ramesh = await O("POST", "/crm/customers", { name: "Ramesh", mobile: "9845012302", panDeclaration: true }, 201);
    const second = await raise(lines([hall, 2]), { customerId: ramesh.id });
    assert.deepEqual([second.panInGuestBook, second.guestDeclaredNoPan], [null, true]);
    await refused("POST", `/bills/${second.id}/payments`, { paymentMethod: "upi", amount: 10000, transactionRef: "UTR-G2" }, 409, /needs the buyer's PAN before it takes a payment/, cashier);
    const declared = await C("POST", `/bills/${second.id}/payments`, { paymentMethod: "upi", amount: 10000, transactionRef: "UTR-G2", buyer: { panDeclaration: true } }, 201);
    assert.deepEqual([declared.buyerPan, declared.panDeclaration, declared.guestDeclaredNoPan], [null, true, false]);
  });

  await t.test("walk-in bills carrying one PAN add up for the cash limit on the restaurant's day, with that PAN's guest; across its midnight", async () => {
    const PERSON = /cannot be taken from one person in a day \(Income-tax Act 2025, section 186\)/;
    const walkIn = async () => raise(lines([hall, 2]), {}, { buyer: { pan: "KLMNO4321P" } });
    const first = await walkIn();
    const firstPaid = await C("POST", `/bills/${first.id}/payments`, { paymentMethod: "cash", amount: 150000 }, 201);
    assert.deepEqual(firstPaid.cashLimit.pan, { panEnding: "321P", taken: 150000, left: 49999.99 });
    assert.equal(firstPaid.cashLimit.left, 49999.99);
    const second = await walkIn();
    assert.deepEqual(second.cashLimit.pan, { panEnding: "321P", taken: 150000, left: 49999.99 });
    const body = await refused("POST", `/bills/${second.id}/payments`, { paymentMethod: "cash", amount: 50000 }, 409, PERSON, cashier);
    assert.match(body.message, /today's cash from the buyer with PAN ending 321P would reach ₹200000\.00/);
    assert.equal((await one("SELECT count(*)::int AS n FROM payments WHERE bill_id = $1", [second.id])).n, 0);
    await C("POST", `/bills/${second.id}/payments`, { paymentMethod: "cash", amount: 49999.99 }, 201);

    // A walk-in bill with no PAN is still limited per bill only.
    const plain = await raise(lines([dal, 10]));
    assert.equal(plain.cashLimit.pan, undefined);
    await C("POST", `/bills/${plain.id}/payments`, { paymentMethod: "cash", amount: plain.totalAmount }, 201);

    // A guest whose guest book holds the PAN is the same person: their cash
    // and the walk-in bills' add up, whichever comes first.
    const kavya = await O("POST", "/crm/customers", { name: "Kavya", mobile: "9845012303", pan: "PQRST6789U" }, 201);
    const hers = await raise(lines([hall, 1]), { customerId: kavya.id });
    await C("POST", `/bills/${hers.id}/payments`, { paymentMethod: "cash", amount: 105000 }, 201);
    const hersWalkIn = await raise(lines([hall, 2]), {}, { buyer: { pan: "PQRST6789U" } });
    assert.equal(hersWalkIn.cashLimit.pan.taken, 105000);
    await refused("POST", `/bills/${hersWalkIn.id}/payments`, { paymentMethod: "cash", amount: 95000 }, 409, PERSON, cashier);
    const paidWalkIn = await C("POST", `/bills/${hersWalkIn.id}/payments`, { paymentMethod: "cash", amount: 90000 }, 201);
    assert.equal(paidWalkIn.cashLimit.pan.taken, 195000);
    const another = await raise(lines([dal, 20]), { customerId: kavya.id });
    assert.equal(another.cashLimit.guest.taken, 195000, "the guest's own figure counts the walk-in bill under their PAN");
    await refused("POST", `/bills/${another.id}/payments`, { paymentMethod: "cash", amount: 5000 }, 409, /cannot be taken from one guest in a day/, cashier);

    // The day is the restaurant's: the first walk-in payment a minute before
    // its midnight is yesterday's, a minute after it today's.
    const third = await walkIn();
    await pool.query("UPDATE payments SET paid_at = $2 WHERE bill_id = $1", [first.id, momentAt(todayHere, "00:01", zone)]);
    await refused("POST", `/bills/${third.id}/payments`, { paymentMethod: "cash", amount: 1 }, 409, PERSON, cashier);
    await pool.query("UPDATE payments SET paid_at = $2 WHERE bill_id = $1", [first.id, momentAt(yesterday, "23:59", zone)]);
    const now = await C("POST", `/bills/${third.id}/payments`, { paymentMethod: "cash", amount: 150000 }, 201);
    assert.equal(now.cashLimit.pan.taken, 199999.99);
    const before = await one("SELECT restaurant_cash_from_person($1, NULL, $2, $3, $4::date) AS cash", [rid, "KLMNO4321P", zone, yesterday]);
    assert.equal(before.cash, "150000.00");

    // The rule is the database's, whatever writes the row.
    const fourth = await walkIn();
    const user = await one("SELECT id FROM users WHERE email = 'ravi@rest.invalid'");
    await assert.rejects(
      pool.query("INSERT INTO payments (restaurant_id, bill_id, order_id, business_day_id, payment_method, amount, created_by) VALUES ($1, $2, $3, $4, 'cash', 10, $5)",
        [rid, fourth.id, fourth.orderId, fourth.businessDayId, user.id]),
      PERSON
    );
  });

  // ---------------------------------------------------------------- the captain app

  await t.test("a captain asks the counter for a table's bill: a table request marked as theirs, once per open bill", async () => {
    const order = await K("POST", "/orders", { orderType: "dine_in", tableId: T1.id, guestCount: 2, source: "captain", items: lines([dal, 1]) }, 201);
    const key = crypto.randomUUID();
    const asked = await request("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: key }, 201, captain);
    assert.equal(asked.message, "The counter has table T1's bill request.");
    assert.deepEqual([asked.data.type, asked.data.status, asked.data.tableNo, asked.data.askedByName, asked.data.repeatCount], ["bill", "pending", "T1", "Suresh captain", 0]);
    // The same tap sent again is the same request; a second ask counts on it.
    const again = await request("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: key }, 200, captain);
    assert.deepEqual([again.data.id, again.data.repeatCount], [asked.data.id, 0]);
    const second = await request("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 200, captain);
    assert.deepEqual([second.data.id, second.data.repeatCount], [asked.data.id, 1]);
    assert.match(second.message, /already has table T1's bill request/);
    assert.equal((await one("SELECT count(*)::int AS n FROM table_requests WHERE table_id = $1 AND request_type = 'bill'", [T1.id])).n, 1);
    assert.equal((await auditOf("ask_bill", "table_request", asked.data.id)).length, 2);

    // At the counter: on Table requests and in the POS badges' count.
    const inbox = await C("GET", "/table-requests?view=pending");
    assert.deepEqual(inbox.items.filter((row) => row.id === asked.data.id).map((row) => [row.type, row.askedByName]), [["bill", "Suresh captain"]]);
    const summary = await C("GET", "/table-requests/summary");
    assert.deepEqual([summary.openCallsByType.bill, summary.unansweredCalls], [1, 1]);
    await C("POST", `/table-requests/${asked.data.id}/done`, {});
    // Done: the next ask is a new request.
    const fresh = await request("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 201, captain);
    assert.notEqual(fresh.data.id, asked.data.id);

    // Refusals: no order on the table, the bill already raised, another
    // outlet's table, a role that takes no orders, and with QR ordering off.
    await refused("POST", "/table-requests/bill-asks", { tableId: T4.id, clientKey: crypto.randomUUID() }, 409, /Table T4 has no order running/, captain);
    await C("POST", "/bills", { orderId: order.id }, 201);
    await C("POST", `/table-requests/${fresh.data.id}/done`, {});
    await refused("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 409, /The bill for table T1 is already raised/, captain);
    const garden = await O("POST", "/outlets", { name: "Garden", code: "GARDEN", status: "active" }, 201);
    const G1 = await table("G1", garden.id);
    await refused("POST", "/table-requests/bill-asks", { tableId: G1.id, clientKey: crypto.randomUUID() }, 404, /Table not found in this outlet/, captainA);
    await refused("POST", "/table-requests/bill-asks", { tableId: A1.id, clientKey: crypto.randomUUID() }, 409, /Table A1 has no order running/, captainA);
    await refused("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: "bad key" }, 400, /Request key/, captain);
    await request("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 403, cook);
    await request("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 404, other);
    await feature("qr_ordering", false);
    const off = await refused("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 403, /QR table ordering is switched off/, captain);
    assert.equal(off.data.reason, "feature_off");
    await feature("qr_ordering", true);
  });

  await t.test("a dish the kitchen ticked done is served on its own; the last one serves the ticket", async () => {
    const order = await K("POST", "/orders", { orderType: "dine_in", tableId: T2.id, guestCount: 3, source: "captain", items: lines([dal, 1], [paneer, 2]) }, 201);
    const [ticket] = await ticketsOf(order.id);
    const [first, second] = ticket.items;
    const pass = async (token = captain) => (await request("GET", "/kitchen/pass", undefined, 200, token)).data.tickets;
    assert.deepEqual((await pass()).filter((row) => row.id === ticket.id), []);

    // Serving a dish the kitchen has not marked done is refused.
    await refused("POST", `/kitchen/kots/${ticket.id}/items/${first.id}/serve`, {}, 409, /has not marked that dish done yet/, captain);
    await request("PATCH", `/kitchen/kots/${ticket.id}/items/${first.id}`, { done: true }, 200, cook);
    // The ticket still cooks, and the dish waits at the pass on its own.
    let atPass = (await pass()).find((row) => row.id === ticket.id);
    assert.equal(atPass.status, "cooking");
    assert.ok(atPass.passSince);
    assert.deepEqual(atPass.items.map((item) => [item.name, item.isDone, item.servedAt]), [["Dal makhani", true, null], ["Paneer tikka", false, null]]);

    // Permissions as for serving a ticket.
    await request("POST", `/kitchen/kots/${ticket.id}/items/${first.id}/serve`, {}, 403, screen);
    await request("POST", `/kitchen/kots/${ticket.id}/items/${first.id}/serve`, {}, 404, captainA);
    const served = await request("POST", `/kitchen/kots/${ticket.id}/items/${first.id}/serve`, {}, 200, captain);
    assert.equal(served.message, "Dal makhani is served");
    assert.equal(served.data.status, "cooking");
    const dalLine = served.data.items.find((item) => item.id === first.id);
    assert.deepEqual([Boolean(dalLine.servedAt), dalLine.servedByName], [true, "Suresh captain"]);
    // Again: nothing more to do.
    assert.equal((await request("POST", `/kitchen/kots/${ticket.id}/items/${first.id}/serve`, {}, 200, captain)).message, "Dal makhani was already served");
    // Off the pass; served on the order; the kitchen display shows it served.
    assert.deepEqual((await pass()).filter((row) => row.id === ticket.id), []);
    const lineStatus = async () => (await K("GET", `/orders/${order.id}`)).items.map((item) => [item.itemName, item.itemStatus]);
    assert.deepEqual(await lineStatus(), [["Dal makhani", "served"], ["Paneer tikka", "preparing"]]);
    const board = (await request("GET", "/kitchen/board", undefined, 200, cook)).data;
    const onBoard = board.tickets.find((row) => row.id === ticket.id);
    assert.deepEqual(onBoard.items.map((item) => [item.name, Boolean(item.servedAt)]), [["Dal makhani", true], ["Paneer tikka", false]]);
    // A dish served stays done.
    await refused("PATCH", `/kitchen/kots/${ticket.id}/items/${first.id}`, { done: false }, 409, /already been served from the floor/, cook);

    // The last dish: done, so the ticket is ready; served, so the ticket is served.
    await request("PATCH", `/kitchen/kots/${ticket.id}/items/${second.id}`, { done: true }, 200, cook);
    atPass = (await pass()).find((row) => row.id === ticket.id);
    assert.equal(atPass.status, "ready");
    const last = await request("POST", `/kitchen/kots/${ticket.id}/items/${second.id}/serve`, {}, 200, captain);
    assert.equal(last.message, `Paneer tikka is served, and with it the whole of ${ticket.kotNo}`);
    assert.deepEqual([last.data.status, last.data.servedByName], ["served", "Suresh captain"]);
    assert.deepEqual(await lineStatus(), [["Dal makhani", "served"], ["Paneer tikka", "served"]]);
    assert.equal((await K("GET", `/orders/${order.id}`)).kitchenStatus, "served");
    await refused("POST", `/kitchen/kots/${ticket.id}/items/${second.id}/serve`, {}, 409, /already gone out/, captain);

    // A recall brings every dish back to the pass, those served one by one too.
    await request("POST", `/kitchen/kots/${ticket.id}/recall`, {}, 200, cook);
    const recalled = (await pass()).find((row) => row.id === ticket.id);
    assert.deepEqual(recalled.items.map((item) => item.servedAt), [null, null]);
    await request("PATCH", `/kitchen/kots/${ticket.id}/status`, { status: "served" }, 200, captain);
  });

  await t.test("named courses: a short list in the service settings, sent and printed by name, the first course held until Fire", async () => {
    assert.deepEqual((await K("GET", "/orders/service-settings")).courseNames, ["Starters", "Mains", "Desserts"]);
    await refused("PUT", "/orders/service-settings/courses", { courseNames: ["Starters", " "] }, 400, /Give every course a name/);
    await refused("PUT", "/orders/service-settings/courses", { courseNames: ["Starters", "starters"] }, 400, /on the list twice/);
    await refused("PUT", "/orders/service-settings/courses", { courseNames: ["A", "B", "C", "D", "E", "F", "G"] }, 400, /between one and 6 courses/);
    await refused("PUT", "/orders/service-settings/courses", { courseNames: [] }, 400, /between one and 6 courses/);
    await request("PUT", "/orders/service-settings/courses", { courseNames: ["Starters", "Mains"] }, 403, captain);
    const saved = await O("PUT", "/orders/service-settings/courses", { courseNames: ["  Starters ", "Mains", "Sweets", "Paan"] });
    assert.deepEqual(saved.courseNames, ["Starters", "Mains", "Sweets", "Paan"]);

    // The captain app sends the starters held too, and the mains held.
    const order = await K("POST", "/orders", {
      orderType: "dine_in", tableId: T3.id, guestCount: 2, source: "captain",
      items: lines([paneer, 1, { courseNo: 1, courseName: "Starters", holdCourse: true }], [dal, 1, { courseNo: 2, courseName: "Mains", holdCourse: true }]),
    }, 201);
    assert.deepEqual(order.items.map((item) => [item.courseNo, item.courseName, item.fireStatus]), [[1, "Starters", "held"], [2, "Mains", "held"]]);
    assert.deepEqual(await ticketsOf(order.id), [], "nothing reaches the kitchen until Fire");
    const starters = await request("POST", `/orders/${order.id}/courses/1/fire`, {}, 200, captain);
    assert.equal(starters.message, "Starters sent to the kitchen");
    let kots = await ticketsOf(order.id);
    assert.deepEqual(kots.map((kot) => [kot.courseName, kot.items.map((item) => [item.name, item.courseName])]), [["Starters", [["Paneer tikka", "Starters"]]]]);
    const mainsFired = await request("POST", `/orders/${order.id}/courses/2/fire`, {}, 200, captain);
    assert.equal(mainsFired.message, "Mains sent to the kitchen");
    kots = await ticketsOf(order.id);
    assert.deepEqual(kots.map((kot) => kot.courseName), ["Starters", "Mains"]);
    assert.equal((await auditOf("fire", "order", order.id)).map((row) => row.details.courseName).join(","), "Starters,Mains");

    // The POS's own order is as before: course 1, sent at once, no name.
    const pos = await C("POST", "/orders", { orderType: "dine_in", tableId: T4.id, items: lines([naan, 2]) }, 201);
    assert.deepEqual(pos.items.map((item) => [item.courseNo, item.courseName, item.fireStatus]), [[1, null, "fired"]]);
    assert.deepEqual((await ticketsOf(pos.id)).map((kot) => kot.courseName), [null]);
    // The list is the restaurant's own: another restaurant keeps the three.
    assert.deepEqual((await request("GET", "/orders/service-settings", undefined, 200, other)).data.courseNames, ["Starters", "Mains", "Desserts"]);
  });
});
