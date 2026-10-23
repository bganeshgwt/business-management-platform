// Between midnight and the business-day cut-off hour (day_cutoff_hour), the
// day being traded is still last night's, not the calendar date: an Indian
// kitchen serving at 00:30 is on yesterday's day. End to end on a throwaway
// database.
//
// What it keeps true:
//   - the write-off control's default period ends on the open
//     day's date, and every large write-off and purchase
//     approval is attributed to the business day it happened
//     in — never to its calendar date — including one logged
//     after the day was closed but before the cut-off.
//   - a branch that closes last night's day before the
//     cut-off still shows that day on its dashboard, day book
//     and reports — not the calendar date with ₹0 — and so do
//     All outlets once every day is closed; past the cut-off
//     the calendar date is "today" again.
//
// The window is made, not waited for: the test restaurant's cut-off hour is
// set so that the current hour on its clock falls inside it, whatever time
// the suite runs. Asia/Kolkata while its hour allows it (the cut-off can be
// at most 12), else a place whose clock reads early morning now.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { today, addDays, hourNow, zoneWithHour } = require("./helpers/dates");

// A zone and a cut-off with the current hour at least two hours inside the
// window (the cut-off can be at most 12): Asia/Kolkata whenever its hour
// allows it, else the first zone (helpers/dates ZONES) where it is early
// morning now.
const windowNow = () => {
  const zone = zoneWithHour(0, 9);
  return { zone, cutoff: hourNow(zone) + 3 };
};

test("the cut-off window: last night's day is still the trading day", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  // Never migrate, seed, or erase DB_NAME. A unique empty database, dropped
  // by exact name after every connection to it is closed.
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
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");
  const MANAGER_PIN = "6142";

  const made = await restaurantService.createRestaurant({
    name: "Midnight Dhaba",
    code: "MIDNIGHT",
    admin: { name: "Night owner", email: "owner@cutoff.invalid", password },
  });
  const rid = made.id;

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, { pin = null } = {}) => {
    const row = await one(
      `INSERT INTO users (restaurant_id, name, email, password_hash, pin_hash, pin_set_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [rid, name, email, hash, pin ? await bcrypt.hash(pin, 4) : null, pin ? new Date() : null]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    return Number(row.id);
  };
  const managerId = await staff("Night manager", "manager@cutoff.invalid", "MANAGER", { pin: MANAGER_PIN });
  await staff("Night cook", "cook@cutoff.invalid", "KITCHEN");

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
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body).slice(0, 400)}`);
    return result.body.data;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password }, 200)).token;
  const owner = await login("owner@cutoff.invalid");
  const cook = await login("cook@cutoff.invalid");
  const manager = await login("manager@cutoff.invalid");
  const O = (method, url, body, expected = 200, headers) => request(method, url, body, expected, owner, headers);
  const H = (id) => (id ? { "X-Outlet-Id": String(id) } : {});
  const approval = async (requester, permission, scope, method, url) =>
    (await request("POST", "/auth/approvals", { permission, approverId: managerId, pin: MANAGER_PIN, scope, method, url }, 201, requester))
      .approvalToken;
  // The activity log is written after the answer is sent.
  const auditCount = async (sql, values, atLeast) => {
    for (let i = 0; i < 50; i += 1) {
      const row = await one(sql, values);
      if (row.n >= atLeast) return row.n;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return (await one(sql, values)).n;
  };
  // Anything written for the restaurant throws the kept dashboard away.
  const nudge = async (name) => O("POST", "/expenses/categories", { name }, 201);

  // The window: the restaurant's clock, its cut-off past the current hour.
  const { zone: ZONE, cutoff: CUTOFF } = windowNow();
  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0, timezone: ZONE, taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 0,
    autoConsumeStock: false, loyaltyEnabled: false, autoPrintBill: false,
  });
  const setCutoff = (hour) => O("PUT", "/business-day/rules", { cutoffHour: hour, varianceThreshold: 100, blindCount: false });
  await setCutoff(CUTOFF);
  const CALENDAR = today(ZONE);
  const LAST_NIGHT = addDays(CALENDAR, -1);
  assert.ok(hourNow(ZONE) < CUTOFF, `the hour on ${ZONE} (${hourNow(ZONE)}) is inside the window (cut-off ${CUTOFF})`);

  const food = await O("POST", "/menu/tax-rates", { name: "Food 5%", percentage: 5, hsnCode: "996331" }, 201);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dal = await O("POST", "/menu/products", { categoryId: category.id, name: "Dal Tadka", price: 200, taxRateId: food.id, isAvailable: true }, 201);
  const unit = await O("POST", "/inventory/units", { name: "Kilogram", shortName: "kg" }, 201);
  const paneer = await O("POST", "/inventory/items", { name: "Paneer", unitId: unit.id, openingStock: 50, openingCost: 400 }, 201);

  const sale = async (headers = {}) => {
    const placed = await request("POST", "/orders", { orderType: "takeaway", items: [{ productId: dal.id, quantity: 1 }] }, 201, owner, headers);
    const bill = await O("POST", "/bills", { orderId: (placed.order || placed).id }, 201, headers);
    await O("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: bill.dueAmount }, 201, headers);
    return bill;
  };
  // A write-off over the limit, let through with the manager's PIN.
  const bigWaste = async (quantity, note) => {
    const url = `/inventory-insights/items/${paneer.id}/wastage`;
    const body = { quantity, reason: "spoiled", note };
    const over = await call("POST", url, body, cook);
    assert.equal(over.status, 403, JSON.stringify(over.body));
    assert.equal(over.body.data.reason, "approval_required");
    const token = await approval(cook, "inventory.approve_writeoff", over.body.data.scope, "post", url);
    return request("POST", url, body, 201, cook, { "X-Approval-Token": token });
  };
  const LARGE = "SELECT COUNT(*)::int AS n FROM audit_logs WHERE restaurant_id = $1 AND action = 'wastage' AND details ? 'overLimit'";

  await t.test("tonight's large write-offs and purchase approvals are on last night's day", async () => {
    const day = await O("POST", "/business-day/open", { openingCash: 1000 }, 201);
    assert.equal(day.businessDate, LAST_NIGHT, "a day opened without a date before the cut-off is last night's");

    await O("PUT", "/inventory/settings", { poApprovalLimit: 10000, writeoffApprovalLimit: 500, transferReceiptRequired: false });
    await bigWaste(3, "Fridge failed at midnight");
    assert.equal(await auditCount(LARGE, [rid], 1), 1);

    const supplier = await O("POST", "/suppliers", { name: "Night Farms", mobile: "9876500031" }, 201);
    const po = await request("POST", "/purchase-orders", { supplierId: supplier.id, items: [{ inventoryItemId: paneer.id, quantity: 40, unitPrice: 300 }] }, 201, manager);
    assert.equal((await request("PATCH", `/purchase-orders/${po.id}/status`, { status: "ordered" }, 200, manager)).poStatus, "pending_approval");
    await O("POST", `/purchase-orders/${po.id}/approve`, { note: "Weekend stock" });
    await auditCount(
      "SELECT COUNT(*)::int AS n FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'purchase_order' AND action IN ('approval_requested', 'approve')",
      [rid],
      2
    );

    // No dates: the open day's week, ending on last night's date.
    const control = await O("GET", "/inventory-insights/control");
    assert.equal(control.to, LAST_NIGHT);
    assert.equal(control.largeWriteoffs.length, 1, "the large write-off logged after midnight is in");
    assert.equal(control.largeWriteoffs[0].approvedBy, "Night manager");
    assert.equal(control.largeWriteoffs[0].value, 1200);
    assert.equal(control.summary.largeWriteoffs.count, 1);
    const outcomes = control.purchaseApprovals.filter((row) => row.orderId === Number(po.id)).map((row) => row.outcome).sort();
    assert.deepEqual(outcomes, ["approved", "asked"], "the purchase approval asked and given after midnight are in");
    const cook0 = control.byPerson.find((row) => row.userName === "Night cook");
    assert.equal(cook0.overLimit, 1);
    assert.equal(cook0.items.value, 1200, "the write-off's own row and its approval agree on the day");

    // Each row is filed under its business day, not its calendar date.
    const night = await O("GET", `/inventory-insights/control?from=${LAST_NIGHT}&to=${LAST_NIGHT}`);
    assert.equal(night.largeWriteoffs.length, 1);
    assert.equal(night.purchaseApprovals.length, 2);
    const calendar = await O("GET", `/inventory-insights/control?from=${CALENDAR}&to=${CALENDAR}`);
    assert.equal(calendar.largeWriteoffs.length, 0, "nothing on the calendar date: that day has not been traded");
    assert.equal(calendar.purchaseApprovals.length, 0);
  });

  await t.test("a branch that closed last night's day still shows it until the cut-off", async () => {
    const A = (await O("POST", "/outlets", { name: "Night Branch", code: "NIGHT" }, 201)).id;
    const dayA = await O("POST", "/business-day/open", { openingCash: 500 }, 201, H(A));
    assert.equal(dayA.businessDate, LAST_NIGHT);
    const bill = await sale(H(A));
    const sheet = await O("GET", "/reports/day-end", undefined, 200, H(A));
    await O("POST", "/business-day/close", { closingCash: sheet.expectedCash }, 200, H(A));

    const z = await O("GET", "/reports/day-end", undefined, 200, H(A));
    assert.equal(Number(z.businessDayId), Number(dayA.id));

    const dash = await O("GET", "/reports/dashboard", undefined, 200, H(A));
    assert.equal(dash.businessDate, LAST_NIGHT, "the dashboard stays on the day just closed");
    assert.equal(dash.dayOpen, false);
    assert.equal(dash.billCount, 1, JSON.stringify({ billCount: dash.billCount, netSales: dash.netSales }));
    assert.equal(dash.netSales, bill.totalAmount);

    const book = await O("GET", "/reports/day-book", undefined, 200, H(A));
    assert.equal(book.from, LAST_NIGHT);
    assert.equal(book.to, LAST_NIGHT);
    assert.ok(book.vouchers.some((v) => v.type === "Sales" && v.date === LAST_NIGHT), JSON.stringify(book.vouchers.map((v) => [v.type, v.date])));

    const sales = await O("GET", "/reports/sales", undefined, 200, H(A));
    assert.equal(sales.from, LAST_NIGHT, "a report with no dates is on last night's day too");

    // Past the cut-off (none at all) the calendar date is today again.
    await setCutoff(0);
    await nudge("Past the cut-off");
    const morning = await O("GET", "/reports/dashboard", undefined, 200, H(A));
    assert.equal(morning.businessDate, CALENDAR);
    assert.equal(morning.billCount, 0);
    await setCutoff(CUTOFF);
    await nudge("Back in the window");
  });

  await t.test("with every day closed, All outlets and the stock screens stay on last night", async () => {
    const sheet = await O("GET", "/reports/day-end");
    await O("POST", "/business-day/close", { closingCash: sheet.expectedCash });

    const dash = await O("GET", "/reports/dashboard");
    assert.equal(dash.businessDate, LAST_NIGHT);
    assert.equal(dash.dayOpen, false);
    assert.equal(dash.billCount, 1, "All outlets: the branch's bill of last night");

    // A large write-off after the close, still before the cut-off, is last
    // night's, as its stock row is.
    const entry = await bigWaste(2, "Closing clean-up");
    assert.equal(await auditCount(LARGE, [rid], 2), 2);
    const row = await one("SELECT waste_date::text AS d FROM stock_transactions WHERE restaurant_id = $1 AND transaction_type = 'wastage' ORDER BY id DESC LIMIT 1", [rid]);
    assert.equal(row.d, LAST_NIGHT, JSON.stringify(entry));

    const control = await O("GET", "/inventory-insights/control");
    assert.equal(control.to, LAST_NIGHT);
    assert.equal(control.largeWriteoffs.length, 2);
    const calendar = await O("GET", `/inventory-insights/control?from=${CALENDAR}&to=${CALENDAR}`);
    assert.equal(calendar.largeWriteoffs.length, 0);
  });
});
