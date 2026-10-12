// Cash and loyalty, end to end on a throwaway database: only today's business
// day can be opened and a blank count never closes it; a cashier's shift
// drawer with a cash drop (manager's PIN), petty cash and an X report; the
// close dialog's expected cash, over/short with a reason and card/UPI ticks;
// expenses dated by the business day, logged, paged; past days paged; a bill
// on a company's account no longer blocking the close; and the loyalty
// controls (earn before tax, most points per bill, refunds taking points back,
// the receipt's points lines). Another restaurant sees none of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

test("cash drawers, the day's close, expenses and loyalty", { timeout: 600000 }, async (t) => {
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
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");
  const MANAGER_PIN = "5831";

  const made = await restaurantService.createRestaurant({
    name: "Cash Cafe",
    code: "CASHB",
    invoicePrefix: "CB",
    admin: { name: "Cash owner", email: "owner@cashb.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Cafe",
    code: "OTHERB",
    admin: { name: "Other owner", email: "other@cashb.invalid", password },
  });

  // A cashier and a manager (with a PIN) of the first restaurant.
  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, pin) => {
    const row = await one(
      "INSERT INTO users (restaurant_id, name, email, password_hash, pin_hash, pin_set_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [rid, name, email, hash, pin ? await bcrypt.hash(pin, 4) : null, pin ? new Date() : null]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    return Number(row.id);
  };
  const cashierId = await staff("Ravi cashier", "ravi@cashb.invalid", "CASHIER");
  const managerId = await staff("Meena manager", "meena@cashb.invalid", "MANAGER", MANAGER_PIN);

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
  const owner = await login("owner@cashb.invalid");
  const cashier = await login("ravi@cashb.invalid");
  const manager = await login("meena@cashb.invalid");
  const other = await login("other@cashb.invalid");
  const O = (method, url, body, expected = 200, headers) => request(method, url, body, expected, owner, headers);
  const C = (method, url, body, expected = 200, headers) => request(method, url, body, expected, cashier, headers);
  const M = (method, url, body, expected = 200, headers) => request(method, url, body, expected, manager, headers);
  const P = (value) => Math.round(Number(value || 0) * 100);
  const approval = async (permission, scope) =>
    (await request("POST", "/auth/approvals", { permission, approverId: managerId, pin: MANAGER_PIN, scope }, 201, cashier)).approvalToken;
  // The activity log is written just after the response; read it once settled.
  const auditOf = async (entityType, entityId) => {
    let rows = [];
    for (let tries = 0, last = -1; tries < 15 && rows.length !== last; tries += 1) {
      last = rows.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      rows = await all(
        "SELECT action, details FROM audit_logs WHERE restaurant_id = $1 AND entity_type = $2 AND ($3::bigint IS NULL OR entity_id = $3) ORDER BY id",
        [rid, entityType, entityId || null]
      );
    }
    return rows;
  };

  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0, timezone: "Asia/Kolkata", taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 0,
    invoicePrefix: "CB", gstSplit: true, autoConsumeStock: false, loyaltyEnabled: true, loyaltyEarnAmount: 100,
    loyaltyPointValue: 1, loyaltyMinRedeem: 1, autoPrintBill: false, printShowQr: false,
  });
  const food = (await O("GET", "/menu/tax-rates")).find((r) => r.isDefault);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dish = async (name, price) => O("POST", "/menu/products", { categoryId: category.id, name, price, taxRateId: food.id, isAvailable: true }, 201);
  const paneer = await dish("Paneer Tikka", 285);
  const thali = await dish("Royal Thali", 480);
  const order = async (token, items, extra = {}) =>
    request("POST", "/orders", { orderType: "takeaway", ...extra, items: items.map(([p, quantity]) => ({ productId: p.id, quantity })) }, 201, token);
  const billFor = async (token, orderId) => request("POST", "/bills", { orderId }, 201, token);
  const pay = async (token, b, method, amount = b.dueAmount) =>
    request("POST", `/bills/${b.id}/payments`, { paymentMethod: method, amount }, 201, token);

  const status = await O("GET", "/business-day");
  const today = status.opening.today;
  const { addDays } = require("./helpers/dates");
  // Days are opened for today by date: before the morning cut-off the server
  // would otherwise suggest last night's day.

  let day;
  await t.test("only today's business day opens; any other date is refused in words", async () => {
    assert.ok(status.opening.dates.includes(today));
    await O("POST", "/business-day/open", { businessDate: addDays(today, 1), openingCash: 0 }, 400);
    await O("POST", "/business-day/open", { businessDate: "2027-01-01", openingCash: 0 }, 400);
    await O("POST", "/business-day/open", { businessDate: addDays(today, -120), openingCash: 0 }, 400);
    assert.equal(Number((await one("SELECT count(*) AS n FROM business_days WHERE restaurant_id = $1", [rid])).n), 0);
    day = await O("POST", "/business-day/open", { businessDate: today, openingCash: 2000 }, 201);
    assert.equal(day.businessDate, today);
    await O("POST", "/business-day/open", { openingCash: 0 }, 409);
  });

  await t.test("a blank closing count is refused, never closed as zero", async () => {
    const blank = await call("POST", "/business-day/close", { closingCash: "" }, owner);
    assert.equal(blank.status, 400);
    assert.match(blank.body.message, /Enter the cash counted/);
    const missing = await call("POST", "/business-day/close", {}, owner);
    assert.equal(missing.status, 400);
    assert.equal((await one("SELECT day_status FROM business_days WHERE id = $1", [day.id])).day_status, "open");
  });

  // What should be in the cashier's drawer, in paise.
  let physical = 2000 * 100;
  let drawerId;
  const takings = { card: 0, upi: 0 };
  await t.test("a cashier's shift drawer: float, takings, a PIN'd cash drop, petty cash and an X report", async () => {
    const started = await C("POST", "/business-day/drawers", { openingFloat: 2000 }, 201);
    assert.equal(Number(started.cashierId), cashierId);
    drawerId = started.id;
    await C("POST", "/business-day/drawers", { openingFloat: 0 }, 409);

    const b1 = await billFor(cashier, (await order(cashier, [[paneer, 2]])).id);
    await pay(cashier, b1, "cash");
    physical += P(b1.totalAmount);
    const b2 = await billFor(cashier, (await order(cashier, [[thali, 1]])).id);
    await pay(cashier, b2, "card");
    takings.card += P(b2.totalAmount);
    const b3 = await billFor(cashier, (await order(cashier, [[paneer, 1]])).id);
    await pay(cashier, b3, "upi");
    takings.upi += P(b3.totalAmount);

    const asked = await call("POST", "/business-day/movements", { type: "drop", amount: 1000, reason: "Drawer too full" }, cashier);
    assert.equal(asked.status, 403);
    assert.equal(asked.body.data.reason, "approval_required");
    const tooMuch = await call("POST", "/business-day/movements", { type: "drop", amount: 99999, reason: "Typo" }, cashier);
    assert.equal(tooMuch.body.data.reason, "more_than_drawer");
    const token = await approval("cash.movements", { businessDayId: day.id, amount: 1000, cashMove: "drop" });
    const drop = await C("POST", "/business-day/movements", { type: "drop", amount: 1000, reason: "Drawer too full" }, 201, { "X-Approval-Token": token });
    assert.equal(Number(drop.drawerId), Number(drawerId));
    assert.equal(drop.approvedByName, "Meena manager");
    physical -= 100000;

    const petty = await M("POST", "/business-day/movements", { type: "petty_cash", amount: 50, reason: "Ice for the bar" }, 201);
    physical -= 5000;
    const expense = await one("SELECT expense_status, payment_mode, expense_date::text AS d FROM expenses WHERE id = $1", [petty.expenseId]);
    assert.deepEqual(expense, { expense_status: "approved", payment_mode: "cash", d: today });

    const x = await C("GET", `/business-day/x-report?drawerId=${drawerId}`);
    assert.equal(P(x.drawer.figures.expectedCash), physical);
    assert.equal(P(x.drawer.figures.methods.find((m) => m.method === "card").net), takings.card);
    const logs = await auditOf("cash_movement", drop.id);
    assert.ok(logs.some((row) => row.action === "drop"), JSON.stringify(logs));
  });

  await t.test("expenses: dated by the business day, every change logged, paged with a total", async () => {
    const defaults = await O("GET", "/expenses/defaults");
    assert.equal(defaults.expenseDate, today);
    const heading = await O("POST", "/expenses/categories", { name: "Repairs" }, 201);
    const e = await O("POST", "/expenses", { expenseCategoryId: heading.id, amount: 200, paymentMode: "bank", notes: "Plumber" }, 201);
    assert.equal(e.expenseDate, today);
    await O("PUT", `/expenses/${e.id}`, { expenseCategoryId: heading.id, amount: 20, paymentMode: "bank", expenseDate: today }, 200);
    await O("DELETE", `/expenses/${e.id}`, undefined, 200);
    const logs = await auditOf("expense", e.id);
    assert.ok(logs.some((row) => row.action === "create" && Number(row.details.amount) === 200), JSON.stringify(logs));
    assert.ok(logs.some((row) => row.action === "update" && JSON.stringify(row.details.changes.amount) === "[200,20]"), JSON.stringify(logs));
    assert.ok(logs.some((row) => row.action === "delete"), JSON.stringify(logs));
    await O("POST", "/expenses", { expenseCategoryId: heading.id, amount: 10, paymentMode: "bank", expenseDate: addDays(today, 1) }, 400);

    for (let i = 1; i <= 27; i += 1) {
      await O("POST", "/expenses", { expenseCategoryId: heading.id, amount: i, paymentMode: "bank", notes: `Bulb ${i}` }, 201);
    }
    const first = await O("GET", `/expenses?from=${today}&to=${today}&page=1&pageSize=25`);
    const second = await O("GET", `/expenses?from=${today}&to=${today}&page=2&pageSize=25`);
    assert.equal(first.items.length, 25);
    assert.equal(first.total, 28);
    assert.equal(second.items.length, 3);
    assert.equal(second.page, 2);
    assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 28);
    await O("GET", "/expenses?page=1&pageSize=30", undefined, 400);
    const waiting = await O("GET", `/expenses?from=${today}&to=${today}`);
    assert.equal(waiting.summary.waitingCount, 27);
    for (const row of [...first.items, ...second.items].filter((item) => item.expenseStatus === "pending")) {
      await O("PATCH", `/expenses/${row.id}/status`, { status: "rejected" });
    }
  });

  await t.test("ending a shift and closing the day: expected cash, a reason when short, card and UPI ticked", async () => {
    const short = await call("POST", `/business-day/drawers/${drawerId}/close`, { closingCash: physical / 100 - 150 }, cashier);
    assert.equal(short.status, 400);
    assert.equal(short.body.data.reason, "variance_reason_required");
    const ended = await C("POST", `/business-day/drawers/${drawerId}/close`, { closingCash: physical / 100, countMethod: "total" });
    assert.equal(ended.variance, 0);

    const preview = await O("GET", "/business-day/close-preview");
    assert.equal(P(preview.figures.inDrawer), physical);
    assert.equal(P(preview.figures.dropped), 100000);
    const count = physical / 100;
    const shortCheck = await O("POST", "/business-day/close/check", { closingCash: count - 250 });
    assert.equal(shortCheck.refused.reason, "variance_reason_required");
    const noUpi = await O("POST", "/business-day/close/check", { closingCash: count, methodChecks: [{ method: "card", matched: true }] });
    assert.equal(noUpi.refused.reason, "method_check_required");
    const checks = [{ method: "card", matched: true }, { method: "upi", matched: true }];
    const ok = await C("POST", "/business-day/close/check", { closingCash: count, methodChecks: checks });
    assert.ok(!ok.refused, JSON.stringify(ok.refused));
    const token = await approval("business_day.close", ok.approval.scope);
    const closed = await C("POST", "/business-day/close", { closingCash: count, methodChecks: checks }, 200, { "X-Approval-Token": token });
    assert.equal(P(closed.countedCash), physical);
    assert.equal(closed.variance, 0);
    assert.equal(P(closed.closingCash), physical + 100000);
    const sheet = await O("GET", `/reports/day-end?businessDayId=${day.id}`);
    assert.equal(P(sheet.variance), 0);
    // Cash cannot come out of a drawer already counted.
    const heading = await one("SELECT id FROM expense_categories WHERE restaurant_id = $1 AND name = 'Repairs'", [rid]);
    const late = await call("POST", "/expenses", { expenseCategoryId: heading.id, amount: 40, paymentMode: "cash", expenseDate: today }, owner);
    assert.equal(late.status, 400);
    assert.equal(late.body.data.reason, "drawer_closed");
  });

  await t.test("past days are paged between two dates", async () => {
    const days = await O("GET", `/business-day/days?from=${addDays(today, -30)}&to=${today}&page=1&pageSize=25`);
    assert.equal(days.total, 1);
    assert.equal(days.items[0].id, day.id);
    assert.equal(days.page, 1);
    await O("GET", `/business-day/days?from=${today}&to=${addDays(today, -1)}`, undefined, 400);
    const theirs = await request("GET", `/business-day/days?from=${addDays(today, -30)}&to=${today}`, undefined, 200, other);
    assert.equal(theirs.total, 0);
  });

  await t.test("a bill on a company's account does not stop the day closing", async () => {
    await pool.query("UPDATE business_days SET business_date = business_date - 1 WHERE id = $1", [day.id]);
    const next = await O("POST", "/business-day/open", { openingCash: 500 }, 201);
    const company = await O("POST", "/crm/customers", { name: "Bluewave", mobile: "9876500022", companyName: "Bluewave Tech" }, 201);
    await O("PUT", `/bills/accounts/${company.id}`, { creditLimit: 5000, creditDays: 30 });
    const b = await billFor(owner, (await order(owner, [[paneer, 1]], { customerId: company.id })).id);
    await O("PATCH", `/bills/${b.id}/account`, { customerId: company.id, note: "Monthly" });
    const preview = await O("GET", "/business-day/close-preview");
    assert.equal(preview.blockers.unpaidBills.length, 0);
    const closed = await O("POST", "/business-day/close", { closingCash: 500 });
    assert.equal(closed.dayStatus, "closed");
    assert.ok(!/carried as dues/.test(closed.notes || ""));
    await pool.query("UPDATE business_days SET business_date = business_date - 2 WHERE id = $1", [next.id]);
    await O("POST", "/business-day/open", { openingCash: 0 }, 201);
  });

  await t.test("loyalty: earned before tax, at most so many points a bill, a refund takes them back, the receipt says so", async () => {
    const rules = { enabled: true, earnAmount: 100, pointValue: 1, minRedeem: 1, earnBasis: "pre_tax", maxRedeemPoints: 500, maxRedeemPercent: 50, expiryDays: 365 };
    await M("PUT", "/discounts/loyalty", rules, 403);
    await O("PUT", "/discounts/loyalty", { ...rules, maxRedeemPercent: 150 }, 400);
    const saved = await O("PUT", "/discounts/loyalty", rules);
    assert.equal(saved.rules.earnBasis, "pre_tax");

    const guest = await O("POST", "/crm/customers", { name: "Lakshmi", mobile: "9876500011" }, 201);
    const b = await billFor(owner, (await order(owner, [[thali, 2]], { customerId: guest.id })).id);
    assert.equal(b.subtotal, 960);
    await pay(owner, b, "cash");
    const points = async () => Number((await one("SELECT loyalty_points FROM customers WHERE id = $1", [guest.id])).loyalty_points);
    assert.equal(await points(), 9);
    const got = await O("GET", `/bills/${b.id}`);
    assert.equal(got.pointsEarned, 9);
    assert.equal(got.pointsBalance, 9);

    await O("POST", `/crm/customers/${guest.id}/points`, { points: 800, notes: "Opening balance" });
    const big = await billFor(owner, (await order(owner, [[paneer, 3]], { customerId: guest.id })).id);
    const refused = await call("PATCH", `/bills/${big.id}/adjust`, { loyaltyPoints: 800 }, owner);
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /At most 427 points/);
    await O("PATCH", `/bills/${big.id}/adjust`, { loyaltyPoints: 427 });

    await O("PUT", "/discounts/loyalty", { ...rules, earnBasis: "total" });
    const before = await points();
    const b2 = await billFor(owner, (await order(owner, [[thali, 2]], { customerId: guest.id })).id);
    await pay(owner, b2, "cash");
    assert.equal(await points(), before + 10);
    await O("POST", `/bills/${b2.id}/refunds`, { amount: b2.totalAmount, reason: "Wrong order", refundMethod: "cash" }, 201);
    assert.equal(await points(), before);

    // Total spent leaves the refunded bill out, on the history, the guest
    // book and sales by guest alike.
    // (The big bill's total is read again: the points used came off it.)
    const kept = P(b.totalAmount) + P((await O("GET", `/bills/${big.id}`)).totalAmount);
    const history = (await O("GET", `/crm/customers/${guest.id}/history`)).summary;
    assert.equal(P(history.totalSpent), kept);
    const book = await O("GET", "/crm/guest-book?search=Lakshmi&page=1&pageSize=25");
    assert.equal(P(book.items.find((row) => row.id === guest.id).spend), kept);
    const bySpend = await O("GET", "/crm/reports/customer-sales?search=Lakshmi");
    assert.equal(P((bySpend.items || bySpend.rows).find((row) => (row.id || row.customerId) === guest.id).spend), kept);

    // Points by hand: an approval to add 20 cannot take 20 away; one to take
    // them away can; the log keeps the reason and the approving manager.
    const held = await points();
    const add20 = await approval("loyalty.adjust", { customerId: guest.id, points: 20 });
    const misuse = await call("POST", `/crm/customers/${guest.id}/points`, { points: -20, notes: "The other way" }, cashier, { "X-Approval-Token": add20 });
    assert.equal(misuse.status, 403);
    assert.equal(await points(), held);
    const asked = await call("POST", `/crm/customers/${guest.id}/points`, { points: -20, notes: "Given twice" }, cashier);
    assert.deepEqual(asked.body.data.scope, { customerId: guest.id, pointsOff: 20 });
    const off20 = await approval("loyalty.adjust", { customerId: guest.id, pointsOff: 20 });
    await C("POST", `/crm/customers/${guest.id}/points`, { points: -20, notes: "Given twice" }, 200, { "X-Approval-Token": off20 });
    assert.equal(await points(), held - 20);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const logged = await one(
      "SELECT details, approved_by FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'customer' AND entity_id = $2 AND action = 'loyalty_adjust' ORDER BY id DESC LIMIT 1",
      [rid, guest.id]
    );
    assert.equal(logged.details.reason, "Given twice");
    assert.equal(logged.details.points, -20);
    assert.equal(Number(logged.approved_by), managerId);

    // The other restaurant reads its own programme (with Loyalty points
    // switched on there, Settings -> Features): none of ours shows.
    await request("GET", "/discounts/loyalty", undefined, 403, other);
    await request("PUT", "/discounts/loyalty", { ...rules, enabled: true }, 200, other);
    const theirs = await request("GET", "/discounts/loyalty", undefined, 200, other);
    assert.equal(theirs.summary.pointsHeld, 0);
  });

  await t.test("given at the till: opens on the trading day and pages 25 at a time with the totals for the whole period", async () => {
    const before = await O("GET", "/discounts/given");
    assert.equal(before.from, today);
    assert.equal(before.to, today);
    const already = before.total;
    for (let i = 0; i < 26; i += 1) {
      const b = await billFor(owner, (await order(owner, [[paneer, 1]])).id);
      await O("PATCH", `/bills/${b.id}/adjust`, { manualDiscount: { type: "percentage", value: 10 }, discountReason: "regular" });
    }
    const first = await O("GET", `/discounts/given?from=${today}&to=${today}&page=1&pageSize=25`);
    const second = await O("GET", `/discounts/given?from=${today}&to=${today}&page=2&pageSize=25`);
    assert.equal(first.total, already + 26);
    assert.equal(first.items.length, 25);
    assert.equal(second.items.length, already + 1);
    assert.equal(new Set([...first.items, ...second.items].map((row) => row.billId)).size, already + 26);
    // The totals cover the whole period, not just the page on show.
    assert.equal(P(first.totals.discountAmount), P(second.totals.discountAmount));
    assert.equal(first.totals.discountBills, already + 26);
    await O("GET", "/discounts/given?page=1&pageSize=30", undefined, 400);
    assert.equal((await request("GET", "/discounts/given", undefined, 200, other)).total, 0);
  });

  await t.test("another restaurant cannot read or touch this one's drawers", async () => {
    assert.equal((await call("GET", `/business-day/x-report?drawerId=${drawerId}`, undefined, other)).status, 404);
    assert.equal((await call("POST", `/business-day/drawers/${drawerId}/close`, { closingCash: 0 }, other)).status, 404);
    const move = await one("SELECT id FROM cash_movements WHERE restaurant_id = $1 LIMIT 1", [rid]);
    assert.equal((await call("POST", `/business-day/movements/${move.id}/cancel`, { reason: "x" }, other)).status, 404);
    assert.equal((await call("POST", `/business-day/${day.id}/reopen`, { reason: "x" }, other)).status, 404);
  });

  // ---- A restaurant with a branch: each till's own drawer -----------------------------
  await restaurantService.createRestaurant({
    name: "Branch Cafe",
    code: "BRANCHB",
    invoicePrefix: "BR",
    admin: { name: "Branch owner", email: "owner@branchb.invalid", password },
  });
  const bOwner = await login("owner@branchb.invalid");
  const B = (method, url, body, expected = 200, headers) => request(method, url, body, expected, bOwner, headers);
  const bRate = (await B("GET", "/menu/tax-rates")).find((r) => r.isDefault);
  const bCategory = await B("POST", "/menu/categories", { name: "Mains" }, 201);
  const bDish = await B("POST", "/menu/products", { categoryId: bCategory.id, name: "Fish Thali", price: 300, taxRateId: bRate.id, isAvailable: true }, 201);
  const bBill = async (headers) => {
    const placed = await B("POST", "/orders", { orderType: "takeaway", items: [{ productId: bDish.id, quantity: 1 }] }, 201, headers);
    return B("POST", "/bills", { orderId: (placed.order || placed).id }, 201, headers);
  };
  await B("POST", "/business-day/open", { businessDate: today, openingCash: 1000 }, 201);
  // A main-counter bill with a ₹20 till discount, made before the branch
  // exists (with branches, a takeaway is for one of them).
  const mainBill = await bBill();
  await B("PATCH", `/bills/${mainBill.id}/adjust`, { manualDiscount: { type: "amount", value: 20 }, discountReason: "regular" });
  const branch = await B("POST", "/outlets", { name: "Beach Road", code: "BEACH" }, 201);
  const atBranch = { "X-Outlet-Id": String(branch.id) };
  await B("POST", "/business-day/open", { businessDate: today, openingCash: 500 }, 201, atBranch);

  await t.test("supplier cash paid from a branch's own till comes off that branch's drawer, not the main counter's", async () => {
    const mainDrawer = await B("POST", "/business-day/drawers", { openingFloat: 1000 }, 201);
    const branchDrawer = await B("POST", "/business-day/drawers", { openingFloat: 500 }, 201, atBranch);
    const supplier = await B("POST", "/suppliers", { name: "Fish market", mobile: "9000077777" }, 201);
    await B("POST", "/purchase-returns/payments", { supplierId: supplier.id, amount: 400, paymentMethod: "cash", paidFromTill: true }, 201, atBranch);

    const main = (await B("GET", "/business-day/close-preview")).figures;
    const beach = (await B("GET", "/business-day/close-preview", undefined, 200, atBranch)).figures;
    assert.deepEqual([P(beach.supplierCash), P(beach.inDrawer)], [40000, 10000]);
    assert.deepEqual([P(main.supplierCash), P(main.inDrawer)], [0, 100000]);
    const bx = (await B("GET", `/business-day/x-report?drawerId=${branchDrawer.id}`, undefined, 200, atBranch)).drawer.figures;
    const mx = (await B("GET", `/business-day/x-report?drawerId=${mainDrawer.id}`)).drawer.figures;
    assert.deepEqual([P(bx.supplierCash), P(bx.expectedCash)], [40000, 10000]);
    assert.deepEqual([P(mx.supplierCash), P(mx.expectedCash)], [0, 100000]);

    // Paid at the main counter, it still comes off the main counter.
    await B("POST", "/purchase-returns/payments", { supplierId: supplier.id, amount: 150, paymentMethod: "cash", paidFromTill: true }, 201);
    assert.equal(P((await B("GET", "/business-day/close-preview")).figures.inDrawer), 85000);

    // Each drawer ends, and the branch's day closes, on what is really in it.
    assert.equal(P((await B("POST", `/business-day/drawers/${mainDrawer.id}/close`, { closingCash: 850, countMethod: "total" })).variance), 0);
    assert.equal(P((await B("POST", `/business-day/drawers/${branchDrawer.id}/close`, { closingCash: 100, countMethod: "total" }, 200, atBranch)).variance), 0);
    await B("POST", "/business-day/close", { closingCash: 100, countMethod: "total", methodChecks: [] }, 200, atBranch);
    const closed = await one("SELECT expected_cash, cash_variance FROM business_days WHERE outlet_id = $1", [branch.id]);
    assert.deepEqual([P(closed.expected_cash), P(closed.cash_variance)], [10000, 0]);

    // The day-end sheet (Z report) and the day book read the same till rule:
    // the branch's sheet takes its own ₹400 off and matches its count; the
    // main counter's carries only its own ₹150.
    const zBeach = await B("GET", "/reports/day-end", undefined, 200, atBranch);
    assert.deepEqual([P(zBeach.drawers[0].supplierCash), P(zBeach.drawers[0].expectedCash), P(zBeach.drawers[0].variance)], [40000, 10000, 0]);
    const zMain = (await B("GET", "/reports/day-end")).drawers.find((row) => !row.outletId);
    assert.deepEqual([P(zMain.supplierCash), P(zMain.expectedCash)], [15000, 85000]);
    const book = await B("GET", "/reports/day-book", undefined, 200, atBranch);
    assert.equal(book.vouchers.filter((v) => JSON.stringify(v).includes("Fish market")).length, 1);
  });

  await t.test("given at the till is read per outlet: a branch's manager never sees the main counter's discounts", async () => {
    // The branch's day was closed above; today's day reopens with a reason.
    const counter = await one("SELECT id FROM business_days WHERE outlet_id = $1", [branch.id]);
    await B("POST", `/business-day/${counter.id}/reopen`, { reason: "Closed too early" }, 200, atBranch);
    const branchBill = await bBill(atBranch);
    await B("PATCH", `/bills/${branchBill.id}/adjust`, { manualDiscount: { type: "amount", value: 30 }, discountReason: "regular" }, 200, atBranch);
    const managerRole = await one("SELECT id FROM roles WHERE code = 'MANAGER' AND restaurant_id IS NULL");
    await B("POST", "/users", { name: "Beach manager", email: "beach@branchb.invalid", password, roleIds: [managerRole.id], status: "active", outletId: branch.id }, 201);
    const beachManager = await login("beach@branchb.invalid");

    const everything = await B("GET", "/discounts/given?page=1&pageSize=25");
    assert.equal(everything.total, 2);
    assert.equal(P(everything.totals.discountAmount), 5000);
    const chosen = await B("GET", "/discounts/given?page=1&pageSize=25", undefined, 200, atBranch);
    assert.deepEqual(chosen.items.map((row) => row.billId), [branchBill.id]);
    assert.equal(P(chosen.totals.discountAmount), 3000);
    const pinned = await request("GET", "/discounts/given?page=1&pageSize=25", undefined, 200, beachManager);
    assert.deepEqual(pinned.items.map((row) => row.billId), [branchBill.id]);
    assert.equal(pinned.byStaff.reduce((sum, row) => sum + row.bills, 0), 1);
  });

  await t.test("cash drops sent at the same moment never take a drawer below zero", async () => {
    // The main counter's day holds ₹1,000 + ₹0 − ₹150 = ₹850 (its drawer has ended).
    const drops = await Promise.all([0, 1, 2, 3, 4].map((i) => call("POST", "/business-day/movements", { type: "drop", amount: 250, reason: `Race ${i}` }, bOwner)));
    assert.equal(drops.filter((r) => r.status === 201).length, 3);
    assert.ok(drops.filter((r) => r.status !== 201).every((r) => r.status === 400 && r.body.data.reason === "more_than_drawer"));
    assert.equal(P((await B("GET", "/business-day/close-preview")).figures.inDrawer), 10000);

    const own = await B("POST", "/business-day/drawers", { openingFloat: 100 }, 201);
    const intoDrawer = await Promise.all([0, 1, 2, 3, 4].map((i) => call("POST", "/business-day/movements", { type: "drop", amount: 40, reason: `Drawer race ${i}`, drawerId: own.id }, bOwner)));
    assert.equal(intoDrawer.filter((r) => r.status === 201).length, 2);
    assert.equal(P((await B("GET", `/business-day/x-report?drawerId=${own.id}`)).drawer.figures.expectedCash), 2000);
  });

  await t.test("a counted drawer's cash entries cannot be cancelled; a cash-in the drawer no longer holds cannot be taken back", async () => {
    const own = (await B("GET", "/business-day/drawers")).drawers.find((row) => row.status === "open");
    const petty = await B("POST", "/business-day/movements", { type: "petty_cash", amount: 10, reason: "Ice", drawerId: own.id }, 201);
    await B("POST", `/business-day/drawers/${own.id}/close`, { closingCash: 10, countMethod: "total" });
    const refused = await call("POST", `/business-day/movements/${petty.id}/cancel`, { reason: "Typed by mistake" }, bOwner);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.data.reason, "drawer_counted");
    assert.equal((await one("SELECT expense_status FROM expenses WHERE id = $1", [petty.expenseId])).expense_status, "approved");
    const after = (await B("GET", `/business-day/x-report?drawerId=${own.id}`)).drawer;
    assert.deepEqual([P(after.expectedAtClose), P(after.figures.expectedCash), P(after.variance)], [1000, 1000, 0]);

    const held = P((await B("GET", "/business-day/close-preview")).figures.inDrawer) / 100;
    const paidIn = await B("POST", "/business-day/movements", { type: "paid_in", amount: 200, reason: "Change from the safe" }, 201);
    const drop = await B("POST", "/business-day/movements", { type: "drop", amount: held + 200, reason: "All to the safe" }, 201);
    const takeBack = await call("POST", `/business-day/movements/${paidIn.id}/cancel`, { reason: "Not really put in" }, bOwner);
    assert.equal(takeBack.status, 400);
    assert.equal(takeBack.body.data.reason, "more_than_drawer");
    await B("POST", `/business-day/movements/${drop.id}/cancel`, { reason: "Drop typed wrong" });
    await B("POST", `/business-day/movements/${paidIn.id}/cancel`, { reason: "Not really put in" });
    assert.equal(P((await B("GET", "/business-day/close-preview")).figures.inDrawer), held * 100);
  });

  await t.test("a cash drop sent while the day closes is never left out of the closed day's record", async () => {
    await restaurantService.createRestaurant({
      name: "Race Cafe",
      code: "RACEB",
      admin: { name: "Race owner", email: "owner@raceb.invalid", password },
    });
    const racer = await login("owner@raceb.invalid");
    const R = (method, url, body, expected = 200) => request(method, url, body, expected, racer);
    const raceRid = Number((await one("SELECT restaurant_id FROM users WHERE email = 'owner@raceb.invalid'")).restaurant_id);
    for (let i = 0; i < 12; i += 1) {
      const opened = await R("POST", "/business-day/open", { openingCash: 1000 }, 201);
      const [closing, dropping] = await Promise.all([
        call("POST", "/business-day/close", { closingCash: 1000, countMethod: "total", methodChecks: [] }, racer),
        new Promise((resolve) => setTimeout(resolve, i * 6)).then(() =>
          call("POST", "/business-day/movements", { type: "drop", amount: 300, reason: "Safe drop" }, racer)
        ),
      ]);
      const row = await one("SELECT day_status, cash_dropped FROM business_days WHERE id = $1", [opened.id]);
      const drops = await one(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM cash_movements WHERE business_day_id = $1 AND movement_status = 'recorded' AND movement_type = 'drop'",
        [opened.id]
      );
      assert.ok(!(closing.status === 200 && dropping.status === 201), `round ${i}: both the close and the drop went through`);
      if (row.day_status === "closed") assert.equal(P(row.cash_dropped), P(drops.s), `round ${i}`);
      if (row.day_status === "open") {
        const pre = (await R("GET", "/business-day/close-preview")).figures;
        await R("POST", "/business-day/close", { closingCash: pre.inDrawer, countMethod: "total", methodChecks: [] });
      }
      await pool.query(
        "UPDATE business_days SET business_date = (SELECT MIN(business_date) - 1 FROM business_days WHERE restaurant_id = $1) WHERE id = $2",
        [raceRid, opened.id]
      );
    }
  });
});
