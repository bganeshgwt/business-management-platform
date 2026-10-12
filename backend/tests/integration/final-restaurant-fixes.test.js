// The final check's fixes for the restaurant module, end to end on a
// throwaway database of its own (the same pattern as restaurant.test.js —
// never DB_NAME):
//
//   FINAL-1  the P&L counts delivery charges, and agrees with the GST pack
//            and the day book
//   FINAL-2  a rider's shortfall is marked handed over only into an open day
//            and, where drawers are kept, an open drawer
//   FINAL-3  the day book carries the shortfall and its repayment, so its
//            cash matches the drawer
//   FINAL-4  the Orders list learns the business day without
//            business_day.view, and the last day when none is open
//   FINAL-5  people without sales.view or payments.manage (a captain) see
//            today's bills only, without how they were paid
//   FINAL-6  My work answers a login not linked to staff with linked: false
//   FINAL-7  the money paths read through their transaction's own client:
//            this file runs with a pool of four and the hold-and-wait guard
//            on "throw", so any such read fails the request at once
//   FINAL-8  the deliveries report names its outlet; the bell rings for
//            online booking requests, by permission and outlet
//   FINAL-9  the cash in/out PIN prompt says which way and how much (and a
//            PIN for cash in cannot take cash out); ESI continues to the end
//            of the contribution period
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

test("final restaurant fixes", { timeout: 600000 }, async (t) => {
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
  // A small pool and the guard refusing hold-and-wait outright (FINAL-7).
  process.env.DB_POOL_MAX = "4";
  process.env.DB_CONNECT_TIMEOUT_MS = "4000";
  process.env.DB_POOL_GUARD = "throw";
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
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const statutoryService = require("../../src/modules/restaurant/staff/services/statutory.service");
  const password = crypto.randomBytes(12).toString("hex");
  const MANAGER_PIN = "5831";

  const made = await restaurantService.createRestaurant({
    name: "Final Cafe",
    code: "FINALF",
    invoicePrefix: "FF",
    admin: { name: "Final owner", email: "owner@final.invalid", password },
  });
  const rid = made.id;
  const otherMade = await restaurantService.createRestaurant({
    name: "Other Final",
    code: "OTHERF",
    admin: { name: "Other owner", email: "other@final.invalid", password },
  });

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, pin) => {
    const row = await one(
      "INSERT INTO users (restaurant_id, name, email, password_hash, pin_hash, pin_set_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [rid, name, email, hash, pin ? await bcrypt.hash(pin, 4) : null, pin ? new Date() : null]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [
      row.id,
      role,
    ]);
    return Number(row.id);
  };
  const cashierId = await staff("Ravi cashier", "ravi@final.invalid", "CASHIER");
  const managerId = await staff("Meena manager", "meena@final.invalid", "MANAGER", MANAGER_PIN);
  await staff("Arun captain", "arun@final.invalid", "CAPTAIN");
  await staff("Kitchen screen", "kds@final.invalid", "KITCHEN");

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
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function request(method, url, body, expected, auth, headers) {
    const result = await call(method, url, body, auth, headers);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password }, 200)).token;
  const owner = await login("owner@final.invalid");
  const cashier = await login("ravi@final.invalid");
  const captain = await login("arun@final.invalid");
  const kitchen = await login("kds@final.invalid");
  const other = await login("other@final.invalid");
  const O = (method, url, body, expected = 200, headers) => request(method, url, body, expected, owner, headers);
  const C = (method, url, body, expected = 200, headers) => request(method, url, body, expected, cashier, headers);
  const P = (value) => Math.round(Number(value || 0) * 100);
  const approval = async (permission, scope) =>
    (await request("POST", "/auth/approvals", { permission, approverId: managerId, pin: MANAGER_PIN, scope }, 201, cashier)).approvalToken;

  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0,
    timezone: "Asia/Kolkata",
    taxMode: "exclusive",
    defaultTaxPercentage: 5,
    serviceChargePercentage: 0,
    invoicePrefix: "FF",
    gstSplit: true,
    autoConsumeStock: false,
    autoPrintBill: false,
    printShowQr: false,
  });
  const food = (await O("GET", "/menu/tax-rates")).find((r) => r.isDefault);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const roti = await O("POST", "/menu/products", { categoryId: category.id, name: "Roti Combo", price: 100, taxRateId: food.id, isAvailable: true }, 201);
  const order = async (token, quantity, extra = {}) =>
    request("POST", "/orders", { orderType: "takeaway", ...extra, items: [{ productId: roti.id, quantity }] }, 201, token);
  const billFor = async (token, orderId) => request("POST", "/bills", { orderId }, 201, token);
  const pay = async (token, b, method, extra = {}) =>
    request("POST", `/bills/${b.id}/payments`, { paymentMethod: method, amount: b.dueAmount, ...extra }, 201, token);

  const day = await O("POST", "/business-day/open", { openingCash: 1000 }, 201);
  const today = day.businessDate;
  const own = (await O("GET", "/deliveries/channels")).find((c) => c.type === "own");
  await O("PUT", `/deliveries/channels/${own.id}`, { name: own.name, type: own.type, deliveryCharge: 40, deliveryFreeAbove: 9999 });

  // ------------------------------------------------------------------ FINAL-1
  await t.test("FINAL-1 the P&L counts the delivery charge, and agrees with the GST pack and the day book", async () => {
    const delivered = await billFor(owner, (await order(owner, 2, { orderType: "delivery", customerName: "Door" })).id);
    assert.equal(delivered.deliveryCharge, 40);
    await pay(owner, delivered, "cash");
    const counter = await billFor(owner, (await order(owner, 1)).id);
    await pay(owner, counter, "upi", { transactionRef: "UPI-FINAL-0001" });

    const bills = await all("SELECT total_amount, tax_amount, round_off, delivery_charge FROM bills WHERE restaurant_id = $1 AND bill_status <> 'void'", [rid]);
    const beforeGst = bills.reduce((sum, b) => sum + P(b.total_amount) - P(b.tax_amount), 0);

    const pl = await O("GET", `/reports/profit-loss?from=${today}&to=${today}`);
    const line = (key) => pl.lines.find((row) => row.key === key);
    assert.ok(line("deliveryCharges"), "a Delivery charges line");
    assert.equal(line("deliveryCharges").label, "Delivery charges");
    assert.equal(P(line("deliveryCharges").amount), 4000);
    assert.equal(P(line("netRevenue").amount), beforeGst, "net revenue is every bill before GST, delivery charge included");

    const pack = await O("GET", `/reports/gst?from=${today}&to=${today}`);
    const roundOff = bills.reduce((sum, b) => sum + P(b.round_off), 0);
    assert.equal(P(pack.net.taxableValue) + roundOff, P(line("netRevenue").amount), "the GST pack's taxable value agrees");

    const book = await O("GET", `/reports/day-book?from=${today}&to=${today}`);
    const salesBeforeGst = book.vouchers
      .filter((v) => v.type === "Sales")
      .reduce(
        (sum, v) =>
          sum + P(v.amount) - v.entries.filter((e) => /^Output/.test(e.ledger)).reduce((s, e) => s + P(e.credit) - P(e.debit), 0),
        0
      );
    assert.equal(salesBeforeGst, P(line("netRevenue").amount), "the day book's sales agree");
  });

  // ------------------------------------------------------------- FINAL-2 / 3
  const cashOfBook = (book) =>
    book.vouchers.flatMap((v) => v.entries).filter((e) => e.ledger === "Cash").reduce((s, e) => s + P(e.debit) - P(e.credit), 0);

  let settlementId;
  await t.test("FINAL-3 the day book carries the rider's shortfall, so its cash matches the drawer", async () => {
    const rider = await one("INSERT INTO employees (restaurant_id, name, department) VALUES ($1, 'Rider Ravi', 'delivery') RETURNING id", [rid]);
    const bills = [];
    for (const quantity of [2, 3]) {
      const placed = await order(owner, quantity, { orderType: "delivery", customerName: "Door" });
      await pool.query(
        "UPDATE orders SET rider_employee_id = $2, delivery_status = 'delivered', dispatched_at = NOW(), delivered_at = NOW() WHERE id = $1",
        [placed.id, rider.id]
      );
      bills.push(await billFor(owner, placed.id));
    }
    const preview = await O("GET", `/deliveries/riders/${rider.id}/settlement`);
    const handed = Number((preview.cashExpected - 10).toFixed(2));
    const settled = await O(
      "POST",
      `/deliveries/riders/${rider.id}/settle`,
      { bills: bills.map((b) => ({ billId: b.id, method: "cash" })), cashHanded: handed, shortfallReason: "Change given" },
      201
    );
    settlementId = (settled.settlement || settled).id;

    const book = await O("GET", `/reports/day-book?from=${today}&to=${today}`);
    const short = book.vouchers.find((v) => v.number === `RDS-${settlementId}`);
    assert.ok(short, "a voucher for the shortfall");
    assert.equal(short.type, "Journal");
    assert.deepEqual(
      short.entries.map((e) => [e.ledger.startsWith("Rider Rider Ravi") ? "rider" : e.ledger, P(e.debit), P(e.credit)]).sort(),
      [["Cash", 0, 1000], ["rider", 1000, 0]]
    );
    assert.equal(book.totals.unbalanced, 0);
    assert.ok(book.ledgers.some((l) => l.ledger.startsWith("Rider Rider Ravi") && l.group === "Loans & Advances (Asset)"));

    const close = await O("GET", "/business-day/close-preview");
    assert.equal(cashOfBook(book), P(close.figures.dayExpected) - P(1000), "the day book's cash is what the drawer expects");
  });

  await t.test("FINAL-2 a shortfall is marked handed over only into an open day and an open drawer", async () => {
    // No day open at the till: refused, nothing recorded.
    await pool.query("UPDATE business_days SET day_status = 'closed', closed_at = NOW() WHERE id = $1", [day.id]);
    const noDay = await call("POST", `/deliveries/rider-settlements/${settlementId}/repaid`, undefined, owner);
    assert.equal(noDay.status, 409);
    assert.match(noDay.body.message, /No business day is open at the main counter/);
    assert.equal((await one("SELECT repaid_at FROM rider_settlements WHERE id = $1", [settlementId])).repaid_at, null);
    await pool.query("UPDATE business_days SET day_status = 'open', closed_at = NULL WHERE id = $1", [day.id]);

    // Drawers kept today and the person taking the cash has none open.
    await C("POST", "/business-day/drawers", { openingFloat: 0 }, 201);
    const noDrawer = await call("POST", `/deliveries/rider-settlements/${settlementId}/repaid`, undefined, owner);
    assert.equal(noDrawer.status, 409);
    assert.match(noDrawer.body.message, /Your cash drawer is closed/);
    assert.equal((await one("SELECT repaid_at FROM rider_settlements WHERE id = $1", [settlementId])).repaid_at, null);

    // Another restaurant cannot touch it.
    assert.equal((await call("POST", `/deliveries/rider-settlements/${settlementId}/repaid`, undefined, other)).status, 404);

    // The cashier with an open drawer takes it: into today's day.
    await C("POST", `/deliveries/rider-settlements/${settlementId}/repaid`, undefined, 200);
    const row = await one("SELECT repaid_by, repaid_business_day_id FROM rider_settlements WHERE id = $1", [settlementId]);
    assert.equal(Number(row.repaid_by), cashierId);
    assert.equal(Number(row.repaid_business_day_id), Number(day.id));
    await C("POST", `/deliveries/rider-settlements/${settlementId}/repaid`, undefined, 409);

    const book = await O("GET", `/reports/day-book?from=${today}&to=${today}`);
    const repaid = book.vouchers.find((v) => v.number === `RDR-${settlementId}`);
    assert.ok(repaid, "a receipt for the cash handed over");
    assert.equal(repaid.type, "Receipt");
    assert.equal(P(repaid.entries.find((e) => e.ledger === "Cash").debit), 1000);
    const close = await O("GET", "/business-day/close-preview");
    assert.equal(cashOfBook(book), P(close.figures.dayExpected) - P(1000), "still matching the drawer after the repayment");
  });

  // ------------------------------------------------------------------ FINAL-4
  await t.test("FINAL-4 the Orders list learns the day without business_day.view; with none open, the last one", async () => {
    assert.equal((await call("GET", "/business-day", undefined, captain)).status, 403);
    const mine = await request("GET", "/orders/day", undefined, 200, captain);
    assert.equal(Number(mine.current.id), Number(day.id));
    assert.equal(mine.latest, null);

    const never = await request("GET", "/orders/day", undefined, 200, other);
    assert.deepEqual(never, { current: null, latest: null });
    const closed = await one(
      "INSERT INTO business_days (restaurant_id, business_date, day_status, opened_at, closed_at) VALUES ($1, $2::date - 1, 'closed', NOW() - INTERVAL '1 day', NOW()) RETURNING id",
      [otherMade.id, today]
    );
    const last = await request("GET", "/orders/day", undefined, 200, other);
    assert.equal(last.current, null);
    assert.equal(Number(last.latest.id), Number(closed.id));
    assert.equal(last.latest.status, "closed");
  });

  // ------------------------------------------------------------------ FINAL-5
  await t.test("FINAL-5 a captain sees today's bills only, without how they were paid", async () => {
    const tipped = await billFor(owner, (await order(owner, 1)).id);
    await pay(owner, tipped, "upi", { transactionRef: "UPI-FINAL-SECRET", tipAmount: 15 });
    const old = await billFor(owner, (await order(owner, 1)).id);
    const yesterday = await one(
      "INSERT INTO business_days (restaurant_id, business_date, day_status, opened_at, closed_at) VALUES ($1, $2::date - 1, 'closed', NOW() - INTERVAL '1 day', NOW() - INTERVAL '12 hours') RETURNING id",
      [rid, today]
    );
    await pool.query("UPDATE bills SET business_day_id = $2 WHERE id = $1", [old.id, yesterday.id]);

    const list = await request("GET", `/bills?from=2020-01-01&to=${today}&pageSize=100&page=1`, undefined, 200, captain);
    assert.equal(list.todayOnly, true);
    assert.ok(list.items.length > 0);
    assert.ok(list.items.every((b) => Number(b.businessDayId) === Number(day.id)), "today's bills only, whatever dates were asked");
    assert.ok(!list.items.some((b) => b.id === old.id));
    assert.ok(list.items.every((b) => b.payments.length === 0 && b.tipTotal === null && b.paymentDetailsHidden === true));

    const seen = await request("GET", `/bills/${tipped.id}`, undefined, 200, captain);
    assert.equal(seen.totalAmount, tipped.totalAmount);
    assert.equal(seen.billStatus, "paid");
    assert.deepEqual(seen.payments, []);
    assert.ok(!JSON.stringify(seen).includes("UPI-FINAL-SECRET"), "no UPI reference");
    assert.equal(seen.tipTotal, null);
    assert.equal((await call("GET", `/bills/${old.id}`, undefined, captain)).status, 404, "an earlier day's bill is not theirs to browse");

    // The cashier and the owner are unchanged.
    const full = await C("GET", `/bills/${tipped.id}`);
    assert.equal(full.payments[0].transactionRef, "UPI-FINAL-SECRET");
    assert.equal(full.tipTotal, 15);
    await C("GET", `/bills/${old.id}`);
    const ownerList = await O("GET", `/bills?from=2020-01-01&to=${today}&pageSize=100&page=1`);
    assert.ok(ownerList.items.some((b) => b.id === old.id));
    assert.equal(ownerList.todayOnly, false);
  });

  // ------------------------------------------------------------------ FINAL-6
  await t.test("FINAL-6 My work answers a login not linked to staff with linked: false", async () => {
    const work = await O("GET", "/auth/me/work");
    assert.equal(work.linked, false);
    assert.match(work.message, /not linked to a staff record/);
  });

  // ------------------------------------------------------------------ FINAL-7
  await t.test("FINAL-7 the money paths hold one connection each (guard on throw, pool of four)", async () => {
    // A wrong PIN is refused, and the try it cost is kept (the approval
    // check commits what it counted even when it refuses).
    const wrong = await call("POST", "/auth/approvals", { permission: "bills.void", approverId: managerId, pin: "0000" }, cashier);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.data.reason, "wrong_pin");
    assert.equal((await one("SELECT pin_failed_count FROM users WHERE id = $1", [managerId])).pin_failed_count, 1);
    assert.equal(
      (await one("SELECT COUNT(*)::int AS n FROM audit_logs WHERE restaurant_id = $1 AND action = 'approval_denied'", [rid])).n,
      1
    );
    // The right PIN clears the count.
    await approval("bills.void", null);
    assert.equal((await one("SELECT pin_failed_count FROM users WHERE id = $1", [managerId])).pin_failed_count, 0);

    // Re-pricing a bill with it locked: the delivery charge off, then on.
    const b = await billFor(owner, (await order(owner, 1, { orderType: "delivery", customerName: "Door" })).id);
    const off = await O("PATCH", `/bills/${b.id}/adjust`, { deliveryCharge: { waive: true, reason: "Late" } });
    assert.equal(off.deliveryCharge, 0);
    const on = await O("PATCH", `/bills/${b.id}/adjust`, { deliveryCharge: { waive: false } });
    assert.equal(on.deliveryCharge, 40);

    // Ten at once on a pool of four: none waits on a second connection.
    const rush = await Promise.all(
      Array.from({ length: 10 }, () => call("POST", "/auth/approvals", { permission: "bills.void", approverId: managerId, pin: MANAGER_PIN }, cashier))
    );
    assert.ok(rush.every((r) => [201, 429].includes(r.status)), JSON.stringify(rush.map((r) => r.status)));
    assert.ok(rush.some((r) => r.status === 201));
  });

  // ------------------------------------------------------------------ FINAL-8
  await t.test("FINAL-8 the deliveries report names its outlet", async () => {
    const all0 = await O("GET", "/deliveries/report");
    assert.ok("outletName" in all0);
    assert.equal(all0.outletName, null);
    const outlet = await one("INSERT INTO outlets (restaurant_id, name, code) VALUES ($1, 'Beach Road', 'BR') RETURNING id", [rid]);
    const one0 = await O("GET", "/deliveries/report", undefined, 200, { "X-Outlet-Id": String(outlet.id) });
    assert.equal(one0.outletName, "Beach Road");
    assert.equal(Number(one0.outletId), Number(outlet.id));
  });

  await t.test("FINAL-8 the bell rings for online booking requests, for people who answer them", async () => {
    const booking = await one(
      `INSERT INTO reservations (restaurant_id, reference_no, guest_name, guest_mobile, party_size, reservation_date, start_time, source, status)
       VALUES ($1, 'RQ-1', 'Online Guest', '9876500011', 4, $2::date + 1, '20:00', 'online', 'requested') RETURNING id`,
      [rid, today]
    );
    const stale = await one(
      `INSERT INTO reservations (restaurant_id, reference_no, guest_name, party_size, reservation_date, start_time, source, status)
       VALUES ($1, 'RQ-0', 'Gone Guest', 2, $2::date - 3, '20:00', 'online', 'requested') RETURNING id`,
      [rid, today]
    );
    const bell = await request("GET", "/notifications", undefined, 200, captain);
    const alert = bell.items.find((item) => item.id === `bookingRequests:request:${booking.id}`);
    assert.ok(alert, JSON.stringify(bell.items.map((item) => item.id)));
    assert.match(alert.title, /Online Guest asked online for a table for 4 guests/);
    assert.match(alert.link, new RegExp(`booking=${booking.id}`));
    assert.ok(!bell.items.some((item) => item.id === `bookingRequests:request:${stale.id}`), "a request for a day gone does not ring");

    const kitchenBell = await request("GET", "/notifications", undefined, 200, kitchen);
    assert.ok(!kitchenBell.items.some((item) => item.id.startsWith("bookingRequests:")), "only for reservations.manage");
    const otherBell = await request("GET", "/notifications", undefined, 200, other);
    assert.ok(!otherBell.items.some((item) => item.id.startsWith("bookingRequests:")), "never another restaurant's");

    // Answered: it stops ringing.
    await pool.query("UPDATE reservations SET status = 'declined', cancel_reason = 'Full', declined_at = NOW() WHERE id = $1", [booking.id]);
    const after = await request("GET", "/notifications", undefined, 200, captain);
    assert.ok(!after.items.some((item) => item.id === `bookingRequests:request:${booking.id}`));
  });

  // ------------------------------------------------------------------ FINAL-9
  await t.test("FINAL-9 the cash in/out PIN prompt says which way and how much", async () => {
    const ask = async (scope) =>
      request("GET", `/auth/approvers?permission=cash.movements&scope=${encodeURIComponent(JSON.stringify(scope))}`, undefined, 200, cashier);
    const drop = await ask({ businessDayId: day.id, amount: 500, cashMove: "drop" });
    assert.notEqual(drop.action, "do this");
    assert.match(drop.summary, /^Take ₹500(\.00)? out of the drawer to the safe/);
    const topUp = await ask({ businessDayId: day.id, amount: 200, cashMove: "paid_in" });
    assert.match(topUp.summary, /^Put ₹200(\.00)? into the drawer/);
    const undo = await ask({ businessDayId: day.id, amount: 50, cashMove: "cancel_petty_cash" });
    assert.match(undo.summary, /^Cancel petty cash of ₹50(\.00)?: it goes back into the drawer/);

    const asked = await call("POST", "/business-day/movements", { type: "paid_in", amount: 100, reason: "Float top-up" }, cashier);
    assert.equal(asked.status, 403);
    assert.equal(asked.body.data.scope.cashMove, "paid_in", "the server ties the approval to the direction");
    // A PIN given for taking cash out cannot put it in (or the other way).
    const outToken = await approval("cash.movements", { businessDayId: day.id, amount: 100, cashMove: "drop" });
    const mismatch = await call("POST", "/business-day/movements", { type: "paid_in", amount: 100, reason: "Float top-up" }, cashier, {
      "X-Approval-Token": outToken,
    });
    assert.equal(mismatch.status, 403);
    const inToken = await approval("cash.movements", { businessDayId: day.id, amount: 100, cashMove: "paid_in" });
    const moved = await C("POST", "/business-day/movements", { type: "paid_in", amount: 100, reason: "Float top-up" }, 201, {
      "X-Approval-Token": inToken,
    });
    assert.equal(moved.approvedByName, "Meena manager");
  });

  await t.test("FINAL-9 ESI: covered at the start of a contribution period, covered to its end", async () => {
    assert.equal(statutoryService.esiPeriodStart("2026-05-10"), "2026-04-01");
    assert.equal(statutoryService.esiPeriodStart("2026-09-30"), "2026-04-01");
    assert.equal(statutoryService.esiPeriodStart("2026-10-06"), "2026-10-01");
    assert.equal(statutoryService.esiPeriodStart("2027-03-31"), "2026-10-01");
    const settings = { esiEnabled: true, esiEmployeeRate: 0.75, esiEmployerRate: 3.25, esiWageLimit: 21000 };
    const month = ["2026-11-01", "2026-11-30"];
    const over = statutoryService.compute(settings, { esiApplicable: true }, { earned: 25000, bonus: 0 }, ...month);
    assert.equal(over.esiEmployee, 0);
    assert.equal(over.esiOverLimit, true);
    const kept = statutoryService.compute(settings, { esiApplicable: true, esiCovered: true }, { earned: 25000, bonus: 0 }, ...month);
    assert.equal(kept.esiEmployee, 188);
    assert.equal(kept.esiEmployer, 813);
    assert.equal(kept.esiContinued, true);

    // Through payroll: two people over the limit this month, one of whom
    // earned within it when the contribution period began.
    await pool.query("INSERT INTO statutory_settings (restaurant_id, esi_enabled) VALUES ($1, TRUE)", [rid]);
    const start = statutoryService.esiPeriodStart(today);
    const person = async (name, salary) => {
      const row = await one(
        `INSERT INTO employees (restaurant_id, name, salary_type, salary_amount, esi_applicable, date_of_joining)
         VALUES ($1, $2, 'monthly', $3, TRUE, $4::date - 60) RETURNING id`,
        [rid, name, salary, start]
      );
      await pool.query(
        "INSERT INTO employee_salary_history (restaurant_id, employee_id, effective_from, salary_type, salary_amount) VALUES ($1, $2, $3::date - 60, 'monthly', $4)",
        [rid, row.id, start, salary]
      );
      await O("POST", "/staff/payroll/adjustments", { employeeId: row.id, date: today, kind: "bonus", amount: 25000, note: "Festival bonus" }, 201);
      return Number(row.id);
    };
    const covered = await person("Covered Cook", 20000);
    const notCovered = await person("Senior Chef", 30000);
    const from = `${today.slice(0, 7)}-01`;
    const sheet = await O("GET", `/staff/payroll?from=${from}&to=${today}`);
    const rowOf = (id) => sheet.employees.find((row) => Number(row.employeeId) === id);
    assert.ok(rowOf(covered).esiEmployee > 0, JSON.stringify(rowOf(covered)));
    assert.equal(rowOf(covered).esiContinued, true);
    assert.equal(rowOf(notCovered).esiEmployee, 0);
    assert.equal(rowOf(notCovered).esiOverLimit, true);

    // Marking it paid works it out on the payment's own connection, and keeps
    // the ESI it was paid with.
    const paid = await O(
      "POST",
      "/staff/payroll/payments",
      { employeeId: covered, from, to: today, paidOn: today, paymentMethod: "bank" },
      201
    );
    assert.equal(paid.esiEmployee, rowOf(covered).esiEmployee);
  });
});
