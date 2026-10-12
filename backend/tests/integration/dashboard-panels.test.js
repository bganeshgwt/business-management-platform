// The list filters the dashboard's detail panels use, end to end on a
// throwaway database. Each panel shows the records behind a dashboard figure,
// so the list must narrow to exactly what the figure counted:
//
//   GET /bills ?businessDays=1,2   the bills of several business days at once
//                                  (All outlets' "today" is every open day)
//              ?account=none|only  bills not on a guest's account, or only those
//              ?outletId=7         one outlet's bills, for someone who may see all
//   GET /crm/complaints ?outletId=7  one outlet's complaints (and outletId on each)
//
// and the counts must agree with the dashboard's: Bills, Unpaid bills, Bills on
// account and Complaints open, for All outlets and for one outlet. Staff tied
// to an outlet still get only their own outlet's bills, whatever they ask for.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

const { today, daysFrom } = require("./helpers/dates");

test("dashboard panel list filters", { timeout: 600000 }, async (t) => {
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

  const made = await restaurantService.createRestaurant({
    name: "Panel House",
    code: "PANEL",
    admin: { name: "Panel owner", email: "owner@panel.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Place",
    code: "OTHERP",
    admin: { name: "Other owner", email: "other@panel.invalid", password },
  });

  const app = require("../../src/app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, url, body, expected = 200, auth, headers = {}) {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
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
  const owner = await login("owner@panel.invalid");
  const other = await login("other@panel.invalid");
  const O = (method, url, body, expected = 200, headers = {}) => request(method, url, body, expected, owner, headers);
  const H = (id) => (id ? { "X-Outlet-Id": String(id) } : {});

  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0, timezone: "Asia/Kolkata", taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 0,
    autoConsumeStock: false, loyaltyEnabled: false, autoPrintBill: false, printShowQr: false,
  });
  const rate = await O("POST", "/menu/tax-rates", { name: "Food 5%", percentage: 5, hsnCode: "996331" }, 201);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dal = await O("POST", "/menu/products", { categoryId: category.id, name: "Dal", price: 200, taxRateId: rate.id, isAvailable: true }, 201);

  // The main counter's day left open on an older date, and a branch trading
  // today on a day of its own: All outlets' "today" is both days.
  const dayMain = (await O("POST", "/business-day/open", { businessDate: today(), openingCash: 1000 }, 201)).id;
  await pool.query("UPDATE business_days SET business_date = $2::date, opened_at = opened_at - INTERVAL '3 days' WHERE id = $1", [dayMain, daysFrom(-3)]);
  const A = (await O("POST", "/outlets", { name: "Branch A", code: "BRA" }, 201)).id;
  const dayA = (await O("POST", "/business-day/open", { businessDate: today(), openingCash: 500 }, 201, H(A))).id;

  const order = async (headers = {}) => {
    const placed = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: dal.id, quantity: 1 }] }, 201, headers);
    return placed.order || placed;
  };
  const raise = async (headers = {}) => O("POST", "/bills", { orderId: (await order(headers)).id }, 201, headers);
  const pay = (bill, headers = {}) => O("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: bill.dueAmount }, 201, headers);

  // Main counter: two paid, one unpaid, one voided. Branch A: one paid, two
  // unpaid — one of which is put on a company's account.
  await pay(await raise());
  await pay(await raise());
  const mainUnpaid = await raise();
  const voided = await raise();
  await pool.query("UPDATE bills SET bill_status = 'void' WHERE id = $1", [voided.id]);
  await pay(await raise(H(A)), H(A));
  const aUnpaid = await raise(H(A));
  const aAccount = await raise(H(A));
  const company = await one("INSERT INTO customers (restaurant_id, name, mobile) VALUES ($1, 'Acme Pvt Ltd', '9876500001') RETURNING id", [rid]);
  await pool.query("UPDATE bills SET account_customer_id = $2 WHERE id = $1", [aAccount.id, company.id]);

  // Complaints: two open at A, one in progress at the main counter, one resolved.
  const complaint = (outletId, status, subject) =>
    pool.query(
      "INSERT INTO complaints (restaurant_id, outlet_id, subject, complaint_status) VALUES ($1, $2, $3, $4)",
      [rid, outletId, subject, status]
    );
  await complaint(A, "open", "Cold food");
  await complaint(A, "open", "Slow service");
  await complaint(null, "in_progress", "Wrong bill");
  await complaint(A, "resolved", "Old one");

  const listBills = (query, headers = {}, token = owner) => request("GET", `/bills?${query}&pageSize=100&page=1`, undefined, 200, token, headers);
  const ids = (page) => page.items.map((bill) => bill.id).sort((x, y) => x - y);

  await t.test("businessDays lists the bills of several business days, as Sales today counts them", async () => {
    const dash = await O("GET", "/reports/dashboard");
    const days = dash.openDays.map((day) => day.businessDayId).sort((x, y) => x - y);
    assert.deepEqual(days, [dayMain, dayA].sort((x, y) => x - y));
    const page = await listBills(`status=unpaid,partial,paid&businessDays=${days.join(",")}`);
    assert.equal(page.total, dash.billCount);
    assert.equal(page.total, 6);
    assert.ok(!page.items.some((bill) => bill.id === voided.id), "a voided bill is not a sale");
    const sum = page.items.reduce((total, bill) => total + Number(bill.totalAmount), 0);
    assert.ok(Math.abs(sum - dash.netSales) < 0.01, `${sum} vs ${dash.netSales}`);
    // One day only.
    assert.equal((await listBills(`status=unpaid,partial,paid&businessDays=${dayA}`)).total, 3);
  });

  await t.test("businessDays refuses anything but a list of ids", async () => {
    for (const bad of ["abc", "1,x", "-4", "1.5", "0"]) {
      const answer = await request("GET", `/bills?businessDays=${encodeURIComponent(bad)}`, undefined, null, owner);
      assert.equal(answer.status, 400, bad);
    }
    const tooMany = Array.from({ length: 201 }, (_, index) => index + 1).join(",");
    assert.equal((await request("GET", `/bills?businessDays=${tooMany}`, undefined, null, owner)).status, 400);
  });

  await t.test("account=none and account=only split what is owed the way the dashboard does", async () => {
    const dash = await O("GET", "/reports/dashboard");
    const none = await listBills("status=unpaid,partial&account=none");
    const only = await listBills("status=unpaid,partial&account=only");
    assert.equal(none.total, dash.unpaid.count);
    assert.equal(only.total, dash.onAccount.count);
    assert.deepEqual(ids(none), [mainUnpaid.id, aUnpaid.id].sort((x, y) => x - y));
    assert.deepEqual(ids(only), [aAccount.id]);
    assert.equal((await listBills("status=unpaid,partial")).total, 3, "without the filter both are listed, as before");
    assert.equal((await request("GET", "/bills?account=some", undefined, null, owner)).status, 400);
  });

  await t.test("outletId narrows the list to one outlet, matching the dashboard with that outlet chosen", async () => {
    const dashA = await O("GET", "/reports/dashboard", undefined, 200, H(A));
    const owedA = await listBills(`status=unpaid,partial&account=none&outletId=${A}`, H(A));
    assert.equal(owedA.total, dashA.unpaid.count);
    assert.deepEqual(ids(owedA), [aUnpaid.id]);
    const dayBills = await listBills(`status=unpaid,partial,paid&businessDays=${dashA.openDays.map((d) => d.businessDayId).join(",")}&outletId=${A}`, H(A));
    assert.equal(dayBills.total, dashA.billCount);
    assert.equal(dayBills.total, 3);
  });

  await t.test("staff tied to an outlet get their own outlet's bills whatever outletId they ask for", async () => {
    const hash = await bcrypt.hash(password, 4);
    const row = await one(
      "INSERT INTO users (restaurant_id, outlet_id, name, email, password_hash) VALUES ($1, $2, 'Manager A', 'manager.a@panel.invalid', $3) RETURNING id",
      [rid, A, hash]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'MANAGER' AND restaurant_id IS NULL", [row.id]);
    const managerA = await login("manager.a@panel.invalid");
    const mainOutletAsked = await listBills("status=unpaid,partial&account=none&outletId=999999", {}, managerA);
    assert.deepEqual(ids(mainOutletAsked), [aUnpaid.id]);
  });

  await t.test("complaints narrow to one outlet and carry it; the count matches the dashboard", async () => {
    const all = await O("GET", "/crm/complaints?status=open,in_progress");
    const dash = await O("GET", "/reports/dashboard");
    assert.equal(all.total, dash.openComplaints);
    assert.equal(all.total, 3);
    const atA = await O("GET", `/crm/complaints?status=open,in_progress&outletId=${A}`);
    const dashA = await O("GET", "/reports/dashboard", undefined, 200, H(A));
    assert.equal(atA.total, dashA.openComplaints);
    assert.equal(atA.total, 2);
    assert.ok(atA.items.every((item) => item.outletId === A), JSON.stringify(atA.items));
    assert.equal((await request("GET", "/crm/complaints?outletId=abc", undefined, null, owner)).status, 400);
  });

  await t.test("another restaurant sees none of it, whatever ids it passes", async () => {
    const page = await request("GET", `/bills?businessDays=${dayMain},${dayA}&pageSize=100&page=1`, undefined, 200, other);
    assert.equal(page.total, 0);
    const complaints = await request("GET", `/crm/complaints?outletId=${A}`, undefined, 200, other);
    assert.equal(complaints.total, 0);
  });
});
