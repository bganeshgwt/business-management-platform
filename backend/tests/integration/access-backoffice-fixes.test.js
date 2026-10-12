// The access fix-up and the back-office check of 6 October 2026, end to end
// on a throwaway database:
//   - a two-step set-up ticket works once: sent again after set-up it neither
//     puts a second phone on the account nor hands out a session, and two
//     racing finishes give one session;
//   - an account locked by wrong two-step codes is not blamed on passwords
//     when the right password is typed again;
//   - a manager's PIN for a large write-off is tied to the stock item, a
//     purchase-order approval to that order, and a stock count that finds
//     more missing than the write-off limit needs a PIN tied to that count;
//   - the bell shows a manager tied to a branch only that branch's stock
//     alerts, and Waste & reorder follows the outlet picked in the switcher.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

const { daysFrom } = require("./helpers/dates");

test("access and back-office fixes: sign-in tickets, lock words, tied approvals, branch bell", { timeout: 600000 }, async (t) => {
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
  const totp = require("../../src/utils/totp");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const restaurantService = require("../../src/modules/restaurant/setup/services/restaurant.service");
  const password = crypto.randomBytes(12).toString("hex");
  const MANAGER_PIN = "5831";
  const OWNER_PIN = "4826";

  const made = await restaurantService.createRestaurant({
    name: "Tandoor House",
    code: "R2FIX",
    invoicePrefix: "TH",
    admin: { name: "Tandoor owner", email: "owner@r2fix.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Kitchen",
    code: "R2OTHER",
    admin: { name: "Other owner", email: "other@r2fix.invalid", password },
  });
  const ownerId = Number((await one("SELECT id FROM users WHERE email = 'owner@r2fix.invalid'")).id);
  await pool.query("UPDATE users SET pin_hash = $2, pin_set_at = NOW() WHERE id = $1", [ownerId, await bcrypt.hash(OWNER_PIN, 4)]);

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, { pin = null, outletId = null, roleId = null } = {}) => {
    const row = await one(
      `INSERT INTO users (restaurant_id, name, email, password_hash, pin_hash, pin_set_at, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [rid, name, email, hash, pin ? await bcrypt.hash(pin, 4) : null, pin ? new Date() : null, outletId]
    );
    if (roleId) {
      await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [row.id, roleId]);
    } else {
      await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    }
    return Number(row.id);
  };
  const customRole = async (code, permissions) => {
    const role = await one(
      "INSERT INTO roles (restaurant_id, code, name, is_system, status) VALUES ($1, $2, $2, FALSE, 'active') RETURNING id",
      [rid, code]
    );
    await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2::text[])", [role.id, permissions]);
    return Number(role.id);
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
    return result.body.data;
  }
  const signIn = (email) => request("POST", "/auth/login", { identifier: email, password }, 200);
  const login = async (email) => (await signIn(email)).token;
  const owner = await login("owner@r2fix.invalid");
  const O = (method, url, body, expected = 200, headers) => request(method, url, body, expected, owner, headers);

  await t.test("SW-A-01: a two-step set-up ticket works once, and racing finishes give one session", async () => {
    const managerRole = Number((await one("SELECT id FROM roles WHERE code = 'MANAGER' AND restaurant_id IS NULL")).id);
    await O("PUT", "/users/two-factor-roles", { roleIds: [managerRole] });

    await staff("Arun manager", "arun@r2fix.invalid", "MANAGER");
    const first = await signIn("arun@r2fix.invalid");
    assert.equal(first.token, undefined);
    assert.equal(first.twoFactor.step, "setup");
    const ticket = first.twoFactor.challengeToken;
    const setup = await request("POST", "/auth/login/two-factor/setup", { challengeToken: ticket }, 200);
    const secret = totp.base32Decode(setup.secret.replace(/\s/g, ""));
    const now = totp.stepAt();
    const session = await request("POST", "/auth/login/two-factor/enable", { challengeToken: ticket, code: totp.codeFor(secret, now - 1) }, 200);
    assert.ok(session.token);

    const again = await call("POST", "/auth/login/two-factor/setup", { challengeToken: ticket });
    assert.equal(again.status, 409, "the used set-up ticket cannot start set-up again");
    assert.equal(again.body.data && again.body.data.secret, undefined);
    const replay = await call("POST", "/auth/login/two-factor/enable", { challengeToken: ticket, code: totp.codeFor(secret, now) });
    assert.equal(replay.status, 409, "the used set-up ticket gives no second session");

    // The manager's own phone still works.
    const pw = await signIn("arun@r2fix.invalid");
    const own = await request("POST", "/auth/login/two-factor", { challengeToken: pw.twoFactor.challengeToken, code: totp.codeFor(secret, now) }, 200);
    assert.ok(own.token);

    // Two finishes racing with one ticket.
    await staff("Bina manager", "bina@r2fix.invalid", "MANAGER");
    const raceTicket = (await signIn("bina@r2fix.invalid")).twoFactor.challengeToken;
    const raceSetup = await request("POST", "/auth/login/two-factor/setup", { challengeToken: raceTicket }, 200);
    const raceSecret = totp.base32Decode(raceSetup.secret.replace(/\s/g, ""));
    const step = totp.stepAt();
    const results = await Promise.all(
      [step - 1, step].map((s) => call("POST", "/auth/login/two-factor/enable", { challengeToken: raceTicket, code: totp.codeFor(raceSecret, s) }))
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  });

  await t.test("SW-A-01: an account locked by wrong codes is not blamed on passwords", async () => {
    await staff("Chitra manager", "chitra@r2fix.invalid", "MANAGER");
    const first = await signIn("chitra@r2fix.invalid");
    const setup = await request("POST", "/auth/login/two-factor/setup", { challengeToken: first.twoFactor.challengeToken }, 200);
    const secret = totp.base32Decode(setup.secret.replace(/\s/g, ""));
    await request("POST", "/auth/login/two-factor/enable", { challengeToken: first.twoFactor.challengeToken, code: totp.codeFor(secret, totp.stepAt()) }, 200);

    const pw = await signIn("chitra@r2fix.invalid");
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await call("POST", "/auth/login/two-factor", { challengeToken: pw.twoFactor.challengeToken, code: String(100000 + i) });
      if (last.status === 423) break;
    }
    assert.equal(last.status, 423);
    assert.match(last.body.message, /two-step codes/);

    const retry = await call("POST", "/auth/login", { identifier: "chitra@r2fix.invalid", password });
    assert.equal(retry.status, 423);
    assert.doesNotMatch(retry.body.message, /^Too many wrong passwords/);
    assert.match(retry.body.message, /passwords or two-step codes/);

    // The rest of the file signs managers in with a password alone.
    await O("PUT", "/users/two-factor-roles", { roleIds: [] });
  });

  // Back office: stock, limits and staff.
  const kg = await O("POST", "/inventory/units", { name: "Kilogram", shortName: "kg" }, 201);
  const stockItem = async (name, category, quantity, unitCost) => {
    const created = await O("POST", "/inventory/items", { name, unitId: kg.id, category }, 201);
    await O("POST", "/inventory/movements/in", { inventoryItemId: created.id, quantity, unitCost }, 201);
    return created;
  };
  const paneer = await stockItem("Paneer", "Dairy", 20, 300);
  const ghee = await stockItem("Ghee", "Fats", 20, 600);
  const oil = await stockItem("Groundnut Oil", "Oils", 20, 600);
  await O("PUT", "/inventory/settings", { writeoffApprovalLimit: 500, poApprovalLimit: 5000 });
  const managerId = await staff("Meena manager", "meena@r2fix.invalid", "MANAGER", { pin: MANAGER_PIN });
  await staff("Ravi cook", "ravi@r2fix.invalid", "KITCHEN");
  const storeRole = await customRole("R2_STORE", ["inventory.view", "inventory.manage", "inventory.count"]);
  await staff("Sunil store", "sunil@r2fix.invalid", null, { roleId: storeRole });
  const buyerRole = await customRole("R2_BUYER", ["inventory.view", "purchasing.view", "purchasing.manage"]);
  await staff("Babu buyer", "babu@r2fix.invalid", null, { roleId: buyerRole });
  const cook = await login("ravi@r2fix.invalid");
  const store = await login("sunil@r2fix.invalid");
  const buyer = await login("babu@r2fix.invalid");
  const pin = async (requester, permission, scope, by = { approverId: managerId, pin: MANAGER_PIN }) =>
    (await request("POST", "/auth/approvals", { permission, ...by, scope }, 201, requester)).approvalToken;

  await t.test("SW-B-10: a write-off PIN is tied to the stock item, on every route", async () => {
    const ask = await call("POST", "/inventory-insights/wastage", { inventoryItemId: paneer.id, quantity: 2, reason: "spoiled" }, cook);
    assert.equal(ask.status, 403);
    assert.equal(ask.body.data.scope.inventoryItemId, paneer.id);
    const token = await pin(cook, "inventory.approve_writeoff", ask.body.data.scope);
    const swapped = await call("POST", "/inventory-insights/wastage", { inventoryItemId: ghee.id, quantity: 0.9, reason: "spoiled" }, cook, { "X-Approval-Token": token });
    assert.equal(swapped.status, 403, "a PIN for paneer must not write off ghee");

    const outToken = await pin(store, "inventory.approve_writeoff", { inventoryItemId: paneer.id, quantity: 2, amount: 600 });
    const wrong = await call("POST", "/inventory/movements/out", { inventoryItemId: ghee.id, quantity: 0.9, transactionType: "wastage", wasteReason: "spoiled" }, store, { "X-Approval-Token": outToken });
    assert.equal(wrong.status, 403);
    const right = await pin(store, "inventory.approve_writeoff", { inventoryItemId: paneer.id, quantity: 2, amount: 600 });
    await request("POST", "/inventory/movements/out", { inventoryItemId: paneer.id, quantity: 2, transactionType: "wastage", wasteReason: "spoiled" }, 201, store, { "X-Approval-Token": right });
  });

  await t.test("SW-B-10: a purchase-order approval is tied to that order", async () => {
    const supplier = await O("POST", "/suppliers", { name: "Dairy Co" }, 201);
    const draft = async (quantity) => {
      const po = await request("POST", "/purchase-orders", { supplierId: supplier.id, items: [{ inventoryItemId: paneer.id, quantity, unitPrice: 300 }] }, 201, buyer);
      await call("PATCH", `/purchase-orders/${po.id}/status`, { status: "ordered" }, buyer);
      return po;
    };
    const po3 = await draft(25);
    const po4 = await draft(24);
    const ask = await call("POST", `/purchase-orders/${po3.id}/approve`, {}, buyer);
    assert.equal(ask.status, 403);
    assert.deepEqual(ask.body.data.scope, { amount: 7500, purchaseOrderId: po3.id });
    const byOwner = { approverId: ownerId, pin: OWNER_PIN };
    const loose = await pin(buyer, "purchasing.approve", { amount: 7500 }, byOwner);
    assert.equal((await call("POST", `/purchase-orders/${po4.id}/approve`, {}, buyer, { "X-Approval-Token": loose })).status, 403);
    const forPo3 = await pin(buyer, "purchasing.approve", { purchaseOrderId: po3.id, amount: 7500 }, byOwner);
    assert.equal((await call("POST", `/purchase-orders/${po4.id}/approve`, {}, buyer, { "X-Approval-Token": forPo3 })).status, 403);
    const forPo4 = await pin(buyer, "purchasing.approve", { purchaseOrderId: po4.id, amount: 7200 }, byOwner);
    await request("POST", `/purchase-orders/${po4.id}/approve`, {}, 200, buyer, { "X-Approval-Token": forPo4 });
  });

  await t.test("SW-B-10: a stock count finding more missing than the limit needs a PIN tied to that count", async () => {
    const countWith = async (category, item, counted) => {
      const sheet = await request("POST", "/inventory/counts", { categories: [category] }, 201, store);
      const detail = await request("GET", `/inventory/counts/${sheet.id}`, undefined, 200, store);
      const lines = detail.lines.map((line) => {
        const value = Number(line.inventoryItemId) === Number(item.id) ? counted : Number(line.systemQuantity);
        return { id: line.id, countedQuantity: value, reason: value !== Number(line.systemQuantity) ? "unexplained" : null };
      });
      await request("PUT", `/inventory/counts/${sheet.id}/lines`, { lines }, 200, store);
      return sheet;
    };
    const big = await countWith("Fats", ghee, 6);
    const ask = await call("POST", `/inventory/counts/${big.id}/post`, {}, store);
    assert.equal(ask.status, 403);
    assert.deepEqual(ask.body.data.scope, { amount: 8400, stockCountId: big.id });
    assert.equal(Number((await one("SELECT current_stock FROM inventory_items WHERE id = $1", [ghee.id])).current_stock), 20);

    const other = await countWith("Oils", oil, 6);
    const forOther = await pin(store, "inventory.approve_writeoff", { stockCountId: other.id, amount: 8400 });
    assert.equal((await call("POST", `/inventory/counts/${big.id}/post`, {}, store, { "X-Approval-Token": forOther })).status, 403);
    const forBig = await pin(store, "inventory.approve_writeoff", { stockCountId: big.id, amount: 8400 });
    await request("POST", `/inventory/counts/${big.id}/post`, {}, 200, store, { "X-Approval-Token": forBig });
    assert.equal(Number((await one("SELECT current_stock FROM inventory_items WHERE id = $1", [ghee.id])).current_stock), 6);

    await request("POST", `/inventory/counts/${other.id}/cancel`, {}, 200, store);
    const small = await countWith("Oils", oil, 19.5);
    await request("POST", `/inventory/counts/${small.id}/post`, {}, 200, store);
  });

  await t.test("SW-B-14: a manager tied to a branch sees only that branch's stock alerts", async () => {
    const branch = await one("INSERT INTO outlets (restaurant_id, name, code, own_store, status) VALUES ($1, 'Gachibowli', 'GB', TRUE, 'active') RETURNING id", [rid]);
    const khoya = await O("POST", "/inventory/items", { name: "Khoya", unitId: kg.id }, 201);
    const cream = await O("POST", "/inventory/items", { name: "Fresh Cream", unitId: kg.id }, 201);
    await O("POST", "/inventory/movements/in", { inventoryItemId: khoya.id, quantity: 2, unitCost: 400, batchNumber: "KH-1", expiryDate: daysFrom(1), outletId: Number(branch.id) }, 201);
    await O("POST", "/inventory/movements/in", { inventoryItemId: cream.id, quantity: 1, unitCost: 250, batchNumber: "CR-1", expiryDate: daysFrom(-3) }, 201);
    const stockAlerts = async (token) =>
      ((await request("GET", "/notifications", undefined, 200, token)).items || []).filter((alert) => String(alert.id).startsWith("stockExpiry:"));

    const mine = await stockAlerts(owner);
    assert.ok(mine.some((alert) => alert.link.includes(`store=${branch.id}`)));
    assert.ok(mine.some((alert) => alert.link.includes("store=main")));

    await staff("Gopi branch manager", "gopi@r2fix.invalid", "MANAGER", { outletId: Number(branch.id) });
    const branchManager = await login("gopi@r2fix.invalid");
    const theirs = await stockAlerts(branchManager);
    assert.ok(theirs.length >= 1);
    assert.ok(theirs.every((alert) => !alert.link.includes("store=main")), JSON.stringify(theirs));
  });

  await t.test("MV-6: Waste & reorder follows the outlet picked in the switcher", async () => {
    const own = await one("INSERT INTO outlets (restaurant_id, name, code, own_store, status) VALUES ($1, 'Kondapur', 'KP', TRUE, 'active') RETURNING id", [rid]);
    const sells = await one("INSERT INTO outlets (restaurant_id, name, code, own_store, status) VALUES ($1, 'Jubilee Hills', 'JH', FALSE, 'active') RETURNING id", [rid]);
    const tomato = await O("POST", "/inventory/items", { name: "Tomato", unitId: kg.id }, 201);
    await O("POST", "/inventory/movements/in", { inventoryItemId: tomato.id, quantity: 10, unitCost: 30 }, 201);
    await O("POST", "/inventory/movements/in", { inventoryItemId: tomato.id, quantity: 5, unitCost: 30, outletId: Number(own.id) }, 201);
    const at = (outlet) => (outlet ? { "X-Outlet-Id": String(outlet) } : {});
    await O("POST", "/inventory-insights/wastage", { inventoryItemId: tomato.id, quantity: 1, reason: "spoiled" }, 201, at(own.id));
    await O("POST", "/inventory-insights/wastage", { inventoryItemId: tomato.id, quantity: 0.5, reason: "dropped" }, 201, at(sells.id));
    const tomatoes = async (outlet) =>
      (await O("GET", `/inventory-insights/wastage/entries?itemId=${tomato.id}`, undefined, 200, at(outlet))).items.reduce((sum, e) => sum + Number(e.quantity), 0);
    assert.equal(await tomatoes(null), 1.5);
    assert.equal(await tomatoes(sells.id), 0.5, "an outlet selling from the main store sees the main store's waste only");
    assert.equal(await tomatoes(own.id), 1, "an outlet with its own store sees its own waste only");
    const report = await O("GET", "/inventory-insights/wastage", undefined, 200, at(sells.id));
    assert.deepEqual(report.store, { outletId: null, name: "Main store", via: "Jubilee Hills" });
  });

  await t.test("another restaurant's stock item cannot be named in an approval", async () => {
    const other = await login("other@r2fix.invalid");
    const scope = encodeURIComponent(JSON.stringify({ inventoryItemId: paneer.id, quantity: 1, amount: 300 }));
    assert.equal((await call("GET", `/auth/approvers?permission=inventory.approve_writeoff&scope=${scope}`, undefined, other)).status, 404);
  });
});
