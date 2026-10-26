// Day close and roles in the back office, end to end on a throwaway database:
// a business day left open from an earlier date is said so (and which till
// it is), the close dialog sums unpaid bills in one line and names orders
// left open from earlier days, a close carrying dues writes a count and a
// total on the day (not every bill number), a day-end sheet for a date with
// no business day answers plainly with the nearest traded dates, voided bills
// and cancelled orders page on the server, the outlet comparison calls the
// main counter by its name, the Accountant and Store keeper roles exist, the
// purchase forms can list suppliers for someone who buys without "View
// suppliers", supplier money pages are for those who pay or read reports, and
// someone tied to one outlet sees that store's purchase orders only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

const { today, daysFrom, addDays, tradingToday } = require("./helpers/dates");
const { signIn } = require("./helpers/signIn");

test("business day, close, day-end, cancellations, roles, purchasing access", { timeout: 600000 }, async (t) => {
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
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const businessDayService = require("../../src/modules/restaurant/business-day/services/businessDay.service");
  const password = crypto.randomBytes(12).toString("hex");

  const made = await restaurantService.createRestaurant({
    name: "Back Office Bistro",
    code: "PROB",
    invoicePrefix: "BO",
    admin: { name: "Bistro owner", email: "owner@prob.invalid", password },
  });
  const rid = made.id;
  const ownerRow = await one("SELECT id FROM users WHERE email = 'owner@prob.invalid'");
  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, { outletId = null } = {}) => {
    const row = await one(
      `INSERT INTO users (restaurant_id, name, email, password_hash, outlet_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [rid, name, email, hash, outletId]
    );
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
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body).slice(0, 400)}`);
    return result.body.data;
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const owner = await login("owner@prob.invalid");
  const O = (method, url, body, expected = 200, headers) => request(method, url, body, expected, owner, headers);

  // An old day, left open five days ago (opened by calling the business-day
  // service directly: the till itself only opens today's).
  const OLD = daysFrom(-5);
  await businessDayService.openDay(rid, { businessDate: OLD, openingCash: 500 }, ownerRow.id);

  await O("POST", "/menu/tax-rates", { name: "GST 5%", percentage: 5, hsnCode: "996331", isDefault: true }, 201);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dal = await O("POST", "/menu/products", { categoryId: category.id, name: "Dal Makhani", price: 200, foodType: "veg" }, 201);

  await t.test("a day left open from an earlier date is flagged, with the till's name", async () => {
    const status = await O("GET", "/business-day");
    assert.equal(status.current.businessDate, OLD);
    assert.ok(status.stale, "the old day is stale");
    assert.equal(status.stale.days, 5);
    assert.equal(status.stale.businessDate, OLD);
    assert.equal(status.stale.today, today());
    assert.equal(status.counter.name, "Main counter");
    assert.equal(status.counter.outletId, null);
  });

  // Two unpaid bills and one order left open from three days ago.
  const unpaid = [];
  for (let i = 0; i < 2; i += 1) {
    const order = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: dal.id, quantity: i + 1 }] }, 201);
    unpaid.push(await O("POST", "/bills", { orderId: order.id }, 201));
  }
  const leftOpen = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: dal.id, quantity: 1 }] }, 201);
  await pool.query("UPDATE orders SET placed_at = NOW() - INTERVAL '3 days' WHERE id = $1", [leftOpen.id]);

  await t.test("the close warning: one line for unpaid bills, orders left open from earlier days named", async () => {
    const preview = await O("GET", "/business-day/close-preview");
    const blockers = preview.blockers;
    assert.equal(blockers.unpaidSummary.count, 2);
    assert.equal(blockers.unpaidSummary.due, Math.round((unpaid[0].totalAmount + unpaid[1].totalAmount) * 100) / 100);
    assert.equal(blockers.unpaidSummary.largest[0].billNumber, unpaid[1].billNumber, "largest first");
    assert.equal(blockers.openOrders, 1);
    assert.equal(blockers.earlierOrders.count, 1);
    // An order is named by its trading date, three days before today's: before
    // the 5 am cut-off today's trading date is still yesterday's.
    assert.equal(blockers.earlierOrders.oldest, addDays(tradingToday(), -3));
    assert.ok(blockers.openOrdersValue > 0);
  });

  await t.test("closing with dues carried writes a count and a total, not every bill number", async () => {
    await pool.query("UPDATE orders SET order_status = 'cancelled', cancel_reason = 'Test' WHERE id = $1", [leftOpen.id]);
    const preview = await O("GET", "/business-day/close-preview");
    const closed = await O("POST", "/business-day/close", {
      closingCash: preview.figures.inDrawer,
      countMethod: "total",
      carryUnpaid: true,
      methodChecks: [],
    });
    assert.match(closed.notes, /2 unpaid bills carried as dues/);
    assert.ok(!closed.notes.includes(unpaid[0].billNumber), "bill numbers are not listed on the day");
    const status = await O("GET", "/business-day");
    assert.equal(status.current, null);
    assert.equal(status.stale, null);
  });

  await t.test("a day-end sheet for a date with no business day is a plain answer with nearby days", async () => {
    const noDay = await O("GET", `/reports/day-end?businessDate=${daysFrom(-2)}`);
    assert.equal(noDay.noDay, true);
    assert.match(noDay.message, /No business day was opened on/);
    assert.ok(noDay.nearestDates.includes(OLD));
    // Asking for another restaurant's day by id is still not found.
    const other = await call("GET", "/reports/day-end?businessDayId=999999", undefined, owner);
    assert.equal(other.status, 404);
  });

  await O("POST", "/business-day/open", { businessDate: today(), openingCash: 0 }, 201);

  await t.test("cancelled orders page on the server, totals over every page", async () => {
    for (let i = 0; i < 3; i += 1) {
      const order = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: dal.id, quantity: 1 }] }, 201);
      await O("PATCH", `/orders/${order.id}/cancel`, { reason: `Guest left ${i}` });
    }
    const range = `from=${OLD}&to=${today()}`;
    const page2 = await O("GET", `/reports/cancellations?${range}&cancelPage=2&pageSize=2`);
    assert.equal(page2.cancelledTotals.count, 4, "three cancelled today and the one from the old day");
    assert.equal(page2.cancelledOrders.length, 2);
    assert.equal(page2.paging.pageSize, 2);
    const beyond = await O("GET", `/reports/cancellations?${range}&cancelPage=9&pageSize=2`);
    assert.equal(beyond.cancelledOrders.length, 0);
    assert.equal(beyond.cancelledTotals.count, 4, "a page past the end still says the total");
    const unpaged = await O("GET", `/reports/cancellations?${range}`);
    assert.equal(unpaged.paging, null);
    assert.equal(unpaged.cancelledOrders.length, 4);
    const bad = await call("GET", `/reports/cancellations?${range}&pageSize=0`, undefined, owner);
    assert.equal(bad.status, 400);
  });

  await t.test("a bill raised now charges GST on its service charge (the pack's warning is for old bills)", async () => {
    const s0 = await O("GET", "/restaurants/current/settings");
    await O("PUT", "/restaurants/current/settings", {
      ...s0,
      taxMode: "exclusive",
      serviceChargePercentage: 10,
      serviceChargeOrderTypes: ["dine_in", "takeaway", "delivery"],
    });
    const order = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: dal.id, quantity: 2 }] }, 201);
    const bill = await O("POST", "/bills", { orderId: order.id }, 201);
    assert.ok(Number(bill.serviceCharge) > 0, "service charge was charged");
    const taxes = await one(
      "SELECT SUM(service_charge_taxable) AS sc, SUM(service_charge_tax) AS sc_tax FROM bill_taxes WHERE bill_id = $1",
      [bill.id]
    );
    assert.equal(Number(taxes.sc), 40);
    assert.equal(Number(taxes.sc_tax), 2, "5% GST on ₹40 of service charge");
    const pack = await O("GET", `/reports/gst?from=${today()}&to=${today()}`);
    assert.ok(!(pack.warnings || []).some((w) => /no GST on it/.test(w)), JSON.stringify(pack.warnings));
    await O("PUT", "/restaurants/current/settings", { ...s0 });
  });

  await t.test("the outlet comparison names the main counter", async () => {
    const outlets = await O("GET", `/reports/outlets?from=${OLD}&to=${today()}`);
    const main = outlets.outlets.find((row) => row.outletId === null);
    assert.ok(main, "the main counter's sales are a row");
    assert.equal(main.outletName, "Main counter");
  });

  await t.test("Accountant and Store keeper are built-in roles with the right permissions", async () => {
    const roles = await O("GET", "/roles");
    const accountant = roles.find((role) => role.code === "ACCOUNTANT");
    const keeper = roles.find((role) => role.code === "STORE_KEEPER");
    assert.ok(accountant && accountant.isSystem && keeper && keeper.isSystem);
    const codes = (role) => role.permissions.map((p) => (typeof p === "string" ? p : p.code));
    for (const code of ["reports.view", "expenses.manage", "purchasing.pay", "suppliers.view", "staff.salaries", "audit.view"]) {
      assert.ok(codes(accountant).includes(code), `accountant has ${code}`);
    }
    assert.ok(!codes(accountant).includes("orders.create"));
    for (const code of ["inventory.count", "inventory.waste", "purchasing.manage", "purchasing.receive", "suppliers.view"]) {
      assert.ok(codes(keeper).includes(code), `store keeper has ${code}`);
    }
    for (const code of ["purchasing.pay", "reports.view", "staff.salaries"]) {
      assert.ok(!codes(keeper).includes(code), `store keeper has no ${code}`);
    }
  });

  // Purchasing: a supplier, an item, an outlet with its own store.
  const kg = await O("POST", "/inventory/units", { name: "Kilogram", shortName: "kg" }, 201);
  const rice = await O("POST", "/inventory/items", { name: "Basmati rice", unitId: kg.id, category: "Dry" }, 201);
  const supplier = await O("POST", "/suppliers", { name: "Annapurna Traders", mobile: "9876500022", gstNumber: "29ABCDE1234F1Z5" }, 201);
  const outlet = await O("POST", "/outlets", { name: "Indiranagar", code: "IND" }, 201);
  await pool.query("UPDATE outlets SET own_store = TRUE WHERE id = $1", [outlet.id]);
  const mainPo = await O("POST", "/purchase-orders", { supplierId: supplier.id, items: [{ inventoryItemId: rice.id, quantity: 10, unitPrice: 90 }] }, 201);
  const outletPo = await O(
    "POST",
    "/purchase-orders",
    { supplierId: supplier.id, items: [{ inventoryItemId: rice.id, quantity: 5, unitPrice: 90 }] },
    201,
    { "X-Outlet-Id": String(outlet.id) }
  );

  // A hand-made buyer role: orders and receives, no "View suppliers".
  const buyerRole = await one(
    `INSERT INTO roles (restaurant_id, code, name, is_system) VALUES ($1, 'BUYER', 'Buyer', FALSE) RETURNING id`,
    [rid]
  );
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, id FROM permissions WHERE code IN ('purchasing.view', 'purchasing.manage', 'purchasing.receive', 'inventory.view')`,
    [buyerRole.id]
  );
  const buyerId = Number((await one(`INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, 'Bala buyer', 'bala@prob.invalid', $2) RETURNING id`, [rid, hash])).id);
  await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [buyerId, buyerRole.id]);
  await staff("Kiran keeper", "kiran@prob.invalid", "STORE_KEEPER", { outletId: outlet.id });
  await staff("Asha accounts", "asha@prob.invalid", "ACCOUNTANT");
  await staff("Ravi cook", "ravi@prob.invalid", "KITCHEN");
  const buyer = await login("bala@prob.invalid");
  const keeper = await login("kiran@prob.invalid");
  const accounts = await login("asha@prob.invalid");
  const cook = await login("ravi@prob.invalid");

  await t.test("the purchase forms can list suppliers for a buyer without View suppliers", async () => {
    const lite = await request("GET", "/suppliers", undefined, 200, buyer);
    const row = lite.find((s) => s.id === supplier.id);
    assert.ok(row && row.lite === true);
    assert.equal(row.name, "Annapurna Traders");
    assert.equal(row.gstNumber, "29ABCDE1234F1Z5");
    assert.equal(row.mobile, undefined, "no contacts in the short list");
    const full = await O("GET", "/suppliers");
    assert.equal(full.find((s) => s.id === supplier.id).mobile, "9876500022");
    const refused = await call("GET", "/suppliers", undefined, cook);
    assert.equal(refused.status, 403);
  });

  await t.test("supplier dues and payments are for those who pay or read reports", async () => {
    for (const url of ["/purchase-returns/outstanding", "/purchase-returns/payments", `/purchase-returns/statement?supplierId=${supplier.id}`]) {
      assert.equal((await call("GET", url, undefined, keeper)).status, 403, `store keeper refused ${url}`);
      assert.equal((await call("GET", url, undefined, buyer)).status, 403, `buyer refused ${url}`);
      assert.equal((await call("GET", url, undefined, accounts)).status, 200, `accountant reads ${url}`);
    }
  });

  await t.test("someone tied to one outlet sees that store's purchase orders only", async () => {
    const mine = await request("GET", "/purchase-orders", undefined, 200, keeper);
    assert.deepEqual(mine.map((po) => po.id), [outletPo.id]);
    const all = await O("GET", "/purchase-orders");
    assert.ok(all.some((po) => po.id === mainPo.id) && all.some((po) => po.id === outletPo.id));
  });
});
