// Round 2 (R2-WS), restaurant items, end to end on a throwaway database:
// an advance taken on a pickup order (takeaway ordered ahead) and used on its
// bill; task actions written to the restaurant's activity log (audit_logs);
// the people picker searched on the server, paged. Another restaurant sees
// none of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

test("round 2 restaurant: pickup advances, task audit, people search", { timeout: 300000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres" });
  let created = false, pool, server;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`);
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
  await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"), migrationsTable: "pgmigrations", direction: "up", count: Infinity, checkOrder: true, log() {} });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");
  const made = await restaurantService.createRestaurant({ name: "Pickup Cafe", code: "PICKR2", invoicePrefix: "PC",
    admin: { name: "Pickup owner", email: "owner@pickr2.invalid", password } });
  const rid = made.id;
  await restaurantService.createRestaurant({ name: "Other Cafe", code: "OTHERR2", admin: { name: "Other owner", email: "other@pickr2.invalid", password } });
  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role) => {
    const row = await one("INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id", [rid, name, email, hash]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    return Number(row.id);
  };
  const cashierId = await staff("Ravi cashier", "ravi@pickr2.invalid", "CASHIER");
  await staff("Meena manager", "meena@pickr2.invalid", "MANAGER");
  // Many staff without a login: the picker pages through them.
  for (let n = 1; n <= 30; n += 1) {
    await pool.query("INSERT INTO employees (restaurant_id, name, designation, status) VALUES ($1, $2, 'Helper', 'active')", [rid, `Helper ${String(n).padStart(2, "0")}`]);
  }

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, url, body, auth) {
    const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  async function request(method, url, body, expected, auth) {
    const result = await call(method, url, body, auth);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password }, 200)).token;
  const owner = await login("owner@pickr2.invalid");
  const cashier = await login("ravi@pickr2.invalid");
  const other = await login("other@pickr2.invalid");
  const O = (method, url, body, expected = 200) => request(method, url, body, expected, owner);
  const C = (method, url, body, expected = 200) => request(method, url, body, expected, cashier);

  const food = (await O("GET", "/menu/tax-rates")).find((r) => r.isDefault);
  const mains = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const biryani = await O("POST", "/menu/products", { categoryId: mains.id, name: "Biryani", price: 320, taxRateId: food.id, isAvailable: true }, 201);
  const order = (token, extra = {}) => request("POST", "/orders", { orderType: "takeaway", ...extra, items: [{ productId: biryani.id, quantity: 2 }] }, 201, token);
  await O("POST", "/business-day/open", { openingCash: 1000 }, 201);

  await t.test("an advance on a pickup order: taken ahead, offered first and used on its bill", async () => {
    const guest = await O("POST", "/crm/customers", { name: "Kavya", mobile: "9876500077" }, 201);
    const someoneElse = await O("POST", "/crm/customers", { name: "Arjun", mobile: "9876500078" }, 201);
    const older = await C("POST", "/bills/advances", { customerId: guest.id, amount: 100, paymentMethod: "cash", purpose: "Old deposit" }, 201);
    const pickup = await order(cashier, { customerName: "Kavya" });
    const taken = (await call("POST", "/bills/advances", { customerId: guest.id, amount: 300, paymentMethod: "upi", transactionRef: "UTR 5512", orderId: pickup.id }, cashier)).body;
    assert.match(taken.message, /Advance ADV-0002/);
    assert.equal(taken.data.orderId, Number(pickup.id));
    assert.equal(taken.data.purpose, `Pickup order ${taken.data.orderNumber}`);
    // The paying guest is put on an order that had none.
    assert.equal(Number((await one("SELECT customer_id FROM orders WHERE id = $1", [pickup.id])).customer_id), Number(guest.id));
    // Another guest cannot pay ahead on it; not on an unknown or another restaurant's order.
    await C("POST", "/bills/advances", { customerId: someoneElse.id, amount: 50, paymentMethod: "cash", orderId: pickup.id }, 409);
    await C("POST", "/bills/advances", { customerId: guest.id, amount: 50, paymentMethod: "cash", orderId: 99999999 }, 404);
    await C("POST", "/bills/advances", { customerId: guest.id, amount: 50, paymentMethod: "cash", orderId: pickup.id, reservationId: 1 }, 400);
    await request("POST", "/business-day/open", { openingCash: 0 }, 201, other);
    const theirGuest = (await call("POST", "/crm/customers", { name: "Elsewhere", mobile: "9876500079" }, other)).body.data;
    assert.equal((await call("POST", "/bills/advances", { customerId: theirGuest.id, amount: 50, paymentMethod: "cash", orderId: pickup.id }, other)).status, 404);
    assert.deepEqual((await call("GET", `/bills/advances/order/${pickup.id}`, undefined, other)).body.data, []);
    const onOrder = await C("GET", `/bills/advances/order/${pickup.id}`);
    assert.deepEqual(onOrder.map((a) => a.id), [taken.data.id]);
    // At pickup: the bill is the guest's, and the order's advance comes first (before an older one).
    const bill = await C("POST", "/bills", { orderId: pickup.id }, 201);
    assert.equal(Number(bill.customerId), Number(guest.id));
    const held = await C("GET", `/bills/advances/held/${guest.id}?orderId=${pickup.id}`);
    assert.deepEqual(held.map((a) => a.id), [taken.data.id, older.id]);
    const paid = await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "advance", amount: 300, advanceId: taken.data.id }, 201);
    assert.equal(Number(paid.paidAmount), 300);
    const rest = Number(paid.dueAmount);
    const settled = await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: rest }, 201);
    assert.equal(settled.billStatus, "paid");
    assert.equal((await C("GET", `/bills/advances/${taken.data.id}`)).heldAmount, 0);
    // A billed order takes no more advances.
    await C("POST", "/bills/advances", { customerId: guest.id, amount: 50, paymentMethod: "cash", orderId: pickup.id }, 409);
    assert.ok(await one("SELECT 1 FROM audit_logs WHERE restaurant_id = $1 AND action = 'advance_taken' AND entity_id = $2", [rid, taken.data.id]));
  });

  await t.test("task actions are written to the restaurant's activity log", async () => {
    const task = await O("POST", "/tasks", { title: "Deep clean the tandoor", assignMode: "people", assignees: [{ kind: "user", id: cashierId }] }, 201);
    await O("PATCH", `/tasks/${task.id}`, { assignMode: "role", assignees: [{ kind: "role", id: Number((await one("SELECT id FROM roles WHERE code = 'MANAGER' AND restaurant_id IS NULL")).id) }] });
    await O("PATCH", `/tasks/${task.id}`, { priority: "high" });
    await O("POST", `/tasks/${task.id}/complete`, {});
    await O("POST", `/tasks/${task.id}/reopen`, { reason: "Grease still on the walls" });
    const rows = await all("SELECT action, entity_type, entity_label, user_name, details FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'task' AND entity_id = $2 ORDER BY id", [rid, task.id]);
    assert.deepEqual(rows.map((r) => r.action), ["created", "assigned", "updated", "completed", "reopened"]);
    assert.ok(rows.every((r) => r.entity_label === "Deep clean the tandoor" && r.user_name === "Pickup owner"));
    assert.equal(rows[1].details.assignees, 1);
    assert.equal(rows[4].details.reason, "Grease still on the walls");
    // The business-wide log keeps them too; the other restaurant's log has none.
    assert.ok(await one("SELECT 1 FROM business_audit WHERE action = 'task.reopened' AND entity_id = $1", [task.id]));
    const theirs = await one("SELECT count(*)::int AS n FROM audit_logs a JOIN restaurants r ON r.id = a.restaurant_id WHERE r.code = 'OTHERR2' AND a.entity_type = 'task'");
    assert.equal(theirs.n, 0);
  });

  await t.test("the people picker searches on the server, a page at a time", async () => {
    const ctx = await O("GET", "/tasks/context");
    assert.equal(ctx.directory.people, undefined, "people are no longer loaded with the screen");
    assert.ok(ctx.directory.peopleCount >= 33);
    const first = await O("GET", "/tasks/people?limit=10");
    assert.equal(first.total, ctx.directory.peopleCount);
    assert.equal(first.rows.length, 10);
    const next = await O("GET", "/tasks/people?limit=10&offset=10");
    assert.equal(next.rows.filter((p) => first.rows.some((q) => q.kind === p.kind && q.id === p.id)).length, 0, "pages do not overlap");
    const helpers = await O("GET", "/tasks/people?q=helper%201&limit=50");
    assert.equal(helpers.total, 10);
    assert.ok(helpers.rows.every((p) => p.kind === "employee" && p.login === false && p.detail === "Helper"));
    const logins = await O("GET", "/tasks/people?kind=user&limit=50");
    assert.deepEqual(logins.rows.map((p) => p.name).sort(), ["Meena manager", "Pickup owner", "Ravi cashier"]);
    const byRole = await O("GET", "/tasks/people?q=manager");
    assert.ok(byRole.rows.some((p) => p.name === "Meena manager"));
    await O("GET", "/tasks/people?limit=500", undefined, 400);
    // Another restaurant finds none of these people.
    const theirs = (await call("GET", "/tasks/people?q=helper&limit=50", undefined, other)).body.data;
    assert.equal(theirs.total, 0);
  });
});
