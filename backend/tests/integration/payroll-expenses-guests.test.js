// People and money in the back office: "Mark all paid" on
// payroll (one transaction, same permissions, one activity-log line per
// person, refused whole when the figures moved), salary bank details for the
// bank sheet (private like the salary), "Approve selected" on expenses (all or
// none, bound to the ids and the total, audited one by one), the guest book's
// quick views, complaints oldest-first, the activity log's people search, and
// the bell's shared provider answers. On a throwaway database; another
// restaurant sees none of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

const { today, daysFrom, addDays } = require("./helpers/dates");

const TODAY = today();

test("payroll, bank sheet, expenses, guests, complaints, activity log, bell", { timeout: 600000 }, async (t) => {
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
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");

  const made = await restaurantService.createRestaurant({
    name: "Annapoorna Mess",
    code: "PROBPPL",
    invoicePrefix: "AM",
    admin: { name: "Anna owner", email: "owner@probppl.invalid", password },
  });
  const rid = made.id;
  const otherMade = await restaurantService.createRestaurant({
    name: "Other Mess",
    code: "PROBOTH",
    admin: { name: "Other owner", email: "other@probppl.invalid", password },
  });

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role) => {
    const row = await one(
      `INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
      [rid, name, email, hash]
    );
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND (restaurant_id IS NULL OR restaurant_id = $3) ORDER BY restaurant_id NULLS LAST LIMIT 1",
      [row.id, role, rid]
    );
    return Number(row.id);
  };

  // A supervisor who manages staff but may not see salaries: the manager's
  // permissions without staff.salaries.
  const supervisorRole = await one(
    "INSERT INTO roles (restaurant_id, code, name) VALUES ($1, 'PROB_SUPERVISOR', 'Supervisor') RETURNING id",
    [rid]
  );
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, rp.permission_id FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id AND r.code = 'MANAGER' AND r.restaurant_id IS NULL
     JOIN permissions p ON p.id = rp.permission_id AND p.code <> 'staff.salaries'`,
    [supervisorRole.id]
  );

  await staff("Kumar cook", "cook@probppl.invalid", "KITCHEN");
  await staff("Sita supervisor", "sita@probppl.invalid", "PROB_SUPERVISOR");

  const app = require("../../src/app");
  const registry = require("../../src/notifications");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, url, body, auth) {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function request(method, url, body, expected, auth) {
    const result = await call(method, url, body, auth);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password }, 200)).token;
  const owner = await login("owner@probppl.invalid");
  const cook = await login("cook@probppl.invalid");
  const sita = await login("sita@probppl.invalid");
  const other = await login("other@probppl.invalid");
  const O = (method, url, body, expected = 200) => request(method, url, body, expected, owner);
  const P = (value) => Math.round(Number(value || 0) * 100);
  const auditRows = async (sql, values, count) => {
    for (let i = 0; i < 40; i += 1) {
      const rows = await all(sql, values);
      if (rows.length >= count) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return all(sql, values);
  };

  await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 1000 }, 201);

  // --- Bank details -------------------------------------------------------------------------
  const FROM = daysFrom(-40);
  const TO = daysFrom(-11);
  const people = [];

  await t.test("bank details: saved and read back with salaries, refused when malformed, hidden without salaries", async () => {
    const bad = await call(
      "POST",
      "/staff",
      { name: "Bad Ifsc", salaryType: "monthly", salaryAmount: 15000, bankIfsc: "HDFC1234" },
      owner
    );
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /IFSC/);

    for (const [index, name] of ["Ravi Server", "Lakshmi Cook", "Arjun Helper"].entries()) {
      const employee = await O(
        "POST",
        "/staff",
        {
          name,
          salaryType: "monthly",
          salaryAmount: 15000 + index * 1000,
          dateOfJoining: daysFrom(-120),
          ...(index < 2
            ? { bankAccountNumber: `5010 0${index}23 4567`, bankIfsc: "hdfc0001234", bankAccountName: index === 0 ? "RAVI KUMAR" : "" }
            : {}),
        },
        201
      );
      people.push(employee);
    }

    assert.equal(people[0].bankAccountNumber, "50100023 4567".replace(/\s/g, ""));
    assert.equal(people[0].bankIfsc, "HDFC0001234", "IFSC is kept in capitals");
    assert.equal(people[0].bankAccountName, "RAVI KUMAR");
    assert.equal(people[1].bankAccountName, null);

    const list = await O("GET", "/staff");
    assert.equal(list.find((row) => row.id === people[1].id).bankIfsc, "HDFC0001234");

    const hidden = await request("GET", "/staff", undefined, 200, sita);
    const seen = hidden.find((row) => row.id === people[0].id);
    assert.equal(seen.bankAccountNumber, undefined, "no salaries permission: no bank details");

    // An edit by someone without salaries leaves the account as it was.
    await request("PUT", `/staff/${people[0].id}`, { name: "Ravi Server", bankAccountNumber: "999999999" }, 200, sita);
    const kept = await one("SELECT bank_account_number FROM employees WHERE id = $1", [people[0].id]);
    assert.equal(kept.bank_account_number, "50100023 4567".replace(/\s/g, ""));

    // A change by the owner is on the activity log, last four digits only.
    await O("PUT", `/staff/${people[0].id}`, { name: "Ravi Server", bankAccountNumber: "123456789012", bankIfsc: "SBIN0000456" });
    const [logged] = await auditRows(
      "SELECT details FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'employee' AND action = 'update' AND details ? 'bankAccountChanged'",
      [rid],
      1
    );
    assert.ok(logged, "bank change logged");
    assert.deepEqual(logged.details.bankAccountChanged, ["…4567 HDFC0001234", "…9012 SBIN0000456"]);
  });

  // --- Mark all paid ------------------------------------------------------------------------
  await t.test("mark all paid: permissions, total binding, one transaction, audit, payroll row carries bank details", async () => {
    // A bonus each, so every net pay is above nothing even with no attendance.
    for (const employee of people) {
      await O("POST", "/staff/payroll/adjustments", { employeeId: employee.id, kind: "bonus", amount: 1000, date: addDays(FROM, 2), note: "Festival" }, 201);
    }

    const sheet = await O("GET", `/staff/payroll?from=${FROM}&to=${TO}`);
    const mine = sheet.employees.filter((row) => people.some((employee) => employee.id === row.employeeId));
    assert.equal(mine.length, 3);
    assert.equal(mine.find((row) => row.employeeId === people[1].id).bankIfsc, "HDFC0001234", "payroll rows carry the bank details");
    const expected = mine.reduce((sum, row) => sum + P(Math.max(0, row.netPay)), 0) / 100;
    assert.ok(expected > 0);
    const body = { employeeIds: people.map((employee) => employee.id), from: FROM, to: TO, paymentMethod: "bank", reference: "BATCH-9", expectedTotal: expected };

    const byCook = await call("POST", "/staff/payroll/payments/bulk", body, cook);
    assert.equal(byCook.status, 403, "a cook cannot pay salaries");
    const bySupervisor = await call("POST", "/staff/payroll/payments/bulk", body, sita);
    assert.equal(bySupervisor.status, 403, "managing staff without the salaries permission is not enough");
    const byOther = await call("POST", "/staff/payroll/payments/bulk", body, other);
    assert.notEqual(byOther.status, 201, "another restaurant cannot pay these people");
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM payroll_payments WHERE restaurant_id = $1", [rid])).n, 0);

    const moved = await call("POST", "/staff/payroll/payments/bulk", { ...body, expectedTotal: expected + 500 }, owner);
    assert.equal(moved.status, 409);
    assert.equal(moved.body.data.reason, "total_changed");

    const future = await call("POST", "/staff/payroll/payments/bulk", { ...body, to: daysFrom(5) }, owner);
    assert.equal(future.status, 400);
    assert.equal(future.body.data.reason, "period_not_over");
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM payroll_payments WHERE restaurant_id = $1", [rid])).n, 0, "nothing paid by a refusal");

    // One person already paid: the whole batch is refused, nobody else paid.
    const single = await O("POST", "/staff/payroll/payments", { employeeId: people[2].id, from: FROM, to: TO, paymentMethod: "cash" }, 201);
    const clash = await call("POST", "/staff/payroll/payments/bulk", body, owner);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.data.reason, "already_paid");
    assert.deepEqual(clash.body.data.employeeIds, [people[2].id]);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM payroll_payments WHERE restaurant_id = $1", [rid])).n, 1);
    await O("DELETE", `/staff/payroll/payments/${single.id}`);

    const paid = await O("POST", "/staff/payroll/payments/bulk", body, 201);
    assert.equal(paid.count, 3);
    assert.equal(P(paid.total), P(expected));
    assert.ok(paid.payments.every((payment) => payment.paymentMethod === "bank" && payment.reference === "BATCH-9"));

    const after = await O("GET", `/staff/payroll?from=${FROM}&to=${TO}`);
    assert.equal(after.totals.paidCount, after.totals.headcount);

    const logged = await auditRows(
      "SELECT entity_id, details FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'payroll_payment' AND action = 'pay' AND details ? 'markedWithOthers'",
      [rid],
      3
    );
    assert.equal(logged.length, 3, "one activity-log line per person");
    assert.ok(logged.every((row) => row.details.markedWithOthers === 3 && row.details.method === "bank"));

    const again = await call("POST", "/staff/payroll/payments/bulk", body, owner);
    assert.equal(again.status, 409, "paying the same period twice is refused");
  });

  // --- Approve selected expenses -------------------------------------------------------------
  await t.test("approve selected: permission, ids and total bound, all or none, one log line each", async () => {
    const category = await O("POST", "/expenses/categories", { name: "Repairs" }, 201);
    const amounts = [450, 1200.5, 89.25];
    const expenses = [];

    for (const amount of amounts) {
      expenses.push(await O("POST", "/expenses", { expenseCategoryId: category.id, amount, paymentMode: "upi", notes: "NTF pest control" }, 201));
    }

    const ids = expenses.map((expense) => expense.id);
    const total = amounts.reduce((sum, amount) => sum + P(amount), 0) / 100;

    const byCook = await call("POST", "/expenses/approve", { ids, expectedTotal: total }, cook);
    assert.equal(byCook.status, 403);

    const wrongTotal = await call("POST", "/expenses/approve", { ids, expectedTotal: total - 1 }, owner);
    assert.equal(wrongTotal.status, 409);
    assert.equal(wrongTotal.body.data.reason, "total_changed");

    // Someone else's expense in the list: nothing is approved.
    const otherCategory = await request("POST", "/expenses/categories", { name: "Gas" }, 201, other);
    const theirs = await request("POST", "/expenses", { expenseCategoryId: otherCategory.id, amount: 300, paymentMode: "upi" }, 201, other);
    const mixed = await call("POST", "/expenses/approve", { ids: [...ids, theirs.id], expectedTotal: total + 300 }, owner);
    assert.equal(mixed.status, 404);
    const stillWaiting = await one(
      "SELECT COUNT(*)::int AS n FROM expenses WHERE id = ANY($1::bigint[]) AND expense_status = 'pending'",
      [[...ids, theirs.id]]
    );
    assert.equal(stillWaiting.n, 4, "a refusal approves nothing");

    const done = await O("POST", "/expenses/approve", { ids, expectedTotal: total });
    assert.equal(done.count, 3);
    assert.equal(P(done.total), P(total));
    const approved = await all("SELECT expense_status, approved_by FROM expenses WHERE id = ANY($1::bigint[])", [ids]);
    assert.ok(approved.every((row) => row.expense_status === "approved" && row.approved_by));

    const logged = await auditRows(
      "SELECT entity_id FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'expense' AND action = 'approved' AND details ? 'approvedWithOthers'",
      [rid],
      3
    );
    assert.deepEqual(logged.map((row) => Number(row.entity_id)).sort((a, b) => a - b), [...ids].sort((a, b) => a - b));

    const twice = await call("POST", "/expenses/approve", { ids, expectedTotal: total }, owner);
    assert.equal(twice.status, 409);
    assert.equal(twice.body.data.reason, "not_pending");
  });

  // --- Guest book quick views -----------------------------------------------------------------
  await t.test("guest book: occasion this week, lapsed 60+ days, top spenders, newest visit first", async () => {
    const tax = await O("POST", "/menu/tax-rates", { name: "GST 5%", percentage: 5, hsnCode: "996331", isDefault: true }, 201);
    assert.ok(tax.id);
    const menuCategory = await O("POST", "/menu/categories", { name: "Meals" }, 201);
    const thali = await O("POST", "/menu/products", { categoryId: menuCategory.id, name: "Veg Thali", price: 200, foodType: "veg" }, 201);

    const soon = addDays(TODAY, 3);
    // Born in a leap year, so the 29th of February is a birthday too.
    const birthday = await O("POST", "/crm/customers", { name: "Birthday Bindu", mobile: "9876511101", dateOfBirth: `1992-${soon.slice(5)}`, marketingOptIn: true }, 201);
    const lapsed = await O("POST", "/crm/customers", { name: "Lapsed Lokesh", mobile: "9876511102" }, 201);
    const regular = await O("POST", "/crm/customers", { name: "Regular Rekha", mobile: "9876511103" }, 201);
    await O("POST", "/crm/customers", { name: "Aaron Never", mobile: "9876511104" }, 201);

    const visit = async (customer) => {
      const order = await O("POST", "/orders", { orderType: "takeaway", customerId: customer.id, items: [{ productId: thali.id, quantity: 1 }] }, 201);
      await O("POST", "/bills", { orderId: order.id }, 201);
      return order;
    };
    const old = await visit(lapsed);
    await pool.query("UPDATE orders SET placed_at = NOW() - INTERVAL '90 days' WHERE id = $1", [old.id]);
    await visit(regular);

    const occasion = await O("GET", "/crm/guest-book?view=occasion");
    assert.deepEqual(occasion.items.map((row) => row.name), ["Birthday Bindu"]);

    const gone = await O("GET", "/crm/guest-book?view=lapsed");
    assert.deepEqual(gone.items.map((row) => row.name), ["Lapsed Lokesh"]);

    const top = await O("GET", "/crm/guest-book?view=top&sort=spend&dir=desc");
    assert.deepEqual(top.items.map((row) => row.name).sort(), ["Lapsed Lokesh", "Regular Rekha"]);

    const recent = await O("GET", "/crm/guest-book?sort=lastVisit&dir=desc");
    assert.equal(recent.items[0].name, "Regular Rekha", "newest visit first, never-visited last");
    assert.equal(recent.items[recent.items.length - 1].lastVisit, null);

    const refused = await call("GET", "/crm/guest-book?view=everyone", undefined, owner);
    assert.equal(refused.status, 400);

    const theirs = await request("GET", "/crm/guest-book?view=top", undefined, 200, other);
    assert.equal(theirs.items.length, 0, "another restaurant sees none of these guests");
    assert.ok(birthday.id);
  });

  // --- Complaints oldest first ----------------------------------------------------------------
  await t.test("complaints: ?sort=age puts the longest-waiting first within each priority", async () => {
    const newHigh = await O("POST", "/crm/complaints", { subject: "Cold biryani", priority: "high", category: "food" }, 201);
    const oldHigh = await O("POST", "/crm/complaints", { subject: "Cockroach near sink", priority: "high", category: "hygiene" }, 201);
    const medium = await O("POST", "/crm/complaints", { subject: "Slow service", priority: "medium", category: "service" }, 201);
    await pool.query("UPDATE complaints SET created_at = NOW() - INTERVAL '40 days' WHERE id = $1", [oldHigh.id]);
    await pool.query("UPDATE complaints SET created_at = NOW() - INTERVAL '60 days' WHERE id = $1", [medium.id]);

    const byAge = await O("GET", "/crm/complaints?status=open,in_progress&sort=age");
    assert.deepEqual(byAge.items.map((row) => row.id), [oldHigh.id, newHigh.id, medium.id]);

    const newest = await O("GET", "/crm/complaints?status=open,in_progress");
    assert.deepEqual(newest.items.map((row) => row.id), [newHigh.id, oldHigh.id, medium.id], "default order unchanged");

    const bad = await call("GET", "/crm/complaints?sort=random", undefined, owner);
    assert.equal(bad.status, 400);
  });

  // --- Activity log people search -------------------------------------------------------------
  await t.test("activity log: the staff member picker searches people in the log", async () => {
    const found = await O("GET", "/users/activity-log/people?q=anna");
    assert.ok(found.some((person) => person.name === "Anna owner"));
    assert.ok(found.every((person) => /anna/i.test(person.name)));
    const wildcard = await O("GET", "/users/activity-log/people?q=%25");
    assert.equal(wildcard.length, 0, "a typed % is text, not a wildcard");
    const refused = await call("GET", "/users/activity-log/people?q=a", undefined, cook);
    assert.equal(refused.status, 403);
    const theirs = await request("GET", "/users/activity-log/people", undefined, 200, other);
    assert.ok(theirs.every((person) => person.name !== "Anna owner"), "only this restaurant's people");
  });

  // --- The bell's shared answers --------------------------------------------------------------
  await t.test("bell: kept answers within cacheSeconds, fresh on demand, invalidate, per restaurant", async () => {
    const unit = await O("POST", "/inventory/units", { name: "Gram", shortName: "g" }, 201);
    const saffron = await O("POST", "/inventory/items", { name: "Saffron Strands", unitId: unit.id, category: "Spices", reorderLevel: 5 }, 201);
    const ask = (extra = {}) =>
      registry
        .collect({ restaurantId: rid, permissions: ["inventory.view", "inventory.manage", "purchasing.view"], ...extra })
        .then(({ alerts }) => alerts.some((alert) => /Saffron Strands/.test(alert.title)));

    // In tests answers are not kept unless asked for: a change shows at once.
    assert.equal(await ask(), true, "out of stock is in the bell");
    await O("POST", "/inventory/movements/in", { inventoryItemId: saffron.id, quantity: 50, unitCost: 2 }, 201);
    assert.equal(await ask(), false, "without the cache a restock clears it at once");

    process.env.NOTIFICATIONS_CACHE = "on";
    try {
      registry.invalidate(rid);
      assert.equal(await ask(), false);
      // A write through the API starts the bell afresh (utils/dashboardCache
      // clearOnWrite), so the stock running out shows at once.
      await O("POST", "/inventory/movements/out", { inventoryItemId: saffron.id, quantity: 50, transactionType: "consumption", reason: "Used up" }, 201);
      assert.equal(await ask(), true, "a write clears the kept answers");
      // A change made behind the API's back is not seen within cacheSeconds:
      // the kept answer is shared, until fresh or invalidate.
      await pool.query("UPDATE inventory_items SET status = 'inactive' WHERE id = $1", [saffron.id]);
      assert.equal(await ask(), true, "within cacheSeconds the kept answer is shared");
      assert.equal(await ask({ fresh: true }), false, "fresh asks the providers again");
      await pool.query("UPDATE inventory_items SET status = 'active' WHERE id = $1", [saffron.id]);
      assert.equal(await ask(), false, "the fresh answer is the one kept");
      registry.invalidate(rid);
      assert.equal(await ask(), true, "invalidate drops the kept answer");

      // Another restaurant never shares this one's answer.
      const theirs = await registry.collect({ restaurantId: otherMade.id, permissions: ["inventory.view"] });
      assert.ok(theirs.alerts.every((alert) => !/Saffron Strands/.test(alert.title)));

      // The bell over HTTP works with kept answers, and marking read asks afresh.
      const bell = await O("GET", "/notifications");
      assert.ok(Array.isArray(bell.items));
    } finally {
      delete process.env.NOTIFICATIONS_CACHE;
      registry.invalidate(rid);
    }
  });
});
