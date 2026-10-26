// The back office: stock, purchasing and imports, end to end on a throwaway
// database: a dish never saved at 0% GST by accident; a bill that takes an
// expired batch instead of being refused; approval limits on large purchase
// orders and large write-offs (a manager's PIN, tied to the amount); transfer
// notes received short with a reason; suppliers and guests from a spreadsheet
// (points into the ledger, the same file twice changing nothing); a finished
// dish written off by its recipe and undone; the printed menu card's prices;
// a guest's anniversary on the guest insights list; a debit note's figures; a
// till payment at a branch recording that branch; and the wastage log paged
// on the server. Another restaurant sees none of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

const { today, daysFrom } = require("./helpers/dates");
const { signIn } = require("./helpers/signIn");
// Opened for today on the restaurant's clock, not left to the server's
// before-the-cut-off suggestion of last night's day.
const TODAY = today();

test("back office: limits, expiry, transfers, imports, dish waste, menu card, guests", { timeout: 600000 }, async (t) => {
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
  const MANAGER_PIN = "5831";

  const made = await restaurantService.createRestaurant({
    name: "Spice Route",
    code: "SWBACK",
    invoicePrefix: "SR",
    admin: { name: "Spice owner", email: "owner@swback.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Kitchen",
    code: "SWOTHER",
    admin: { name: "Other owner", email: "other@swback.invalid", password },
  });

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, { pin = null, outletId = null } = {}) => {
    const row = await one(
      `INSERT INTO users (restaurant_id, name, email, password_hash, pin_hash, pin_set_at, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [rid, name, email, hash, pin ? await bcrypt.hash(pin, 4) : null, pin ? new Date() : null, outletId]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    return Number(row.id);
  };
  const managerId = await staff("Meena manager", "meena@swback.invalid", "MANAGER", { pin: MANAGER_PIN });
  await staff("Ravi cook", "ravi@swback.invalid", "KITCHEN");

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
  const login = async (email) => (await signIn(base, email, password)).token;
  const owner = await login("owner@swback.invalid");
  const manager = await login("meena@swback.invalid");
  const cook = await login("ravi@swback.invalid");
  const other = await login("other@swback.invalid");
  const O = (method, url, body, expected = 200, headers) => request(method, url, body, expected, owner, headers);
  const P = (value) => Math.round(Number(value || 0) * 100);
  const approval = async (requester, permission, scope, method, url) =>
    (await request("POST", "/auth/approvals", { permission, approverId: managerId, pin: MANAGER_PIN, scope, method, url }, 201, requester))
      .approvalToken;
  const auditRow = async (sql, values) => {
    for (let i = 0; i < 30; i += 1) {
      const row = await one(sql, values);
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 1000 }, 201);
  const kg = await O("POST", "/inventory/units", { name: "Kilogram", shortName: "kg" }, 201);
  const category = await O("POST", "/menu/categories", { name: "Starters" }, 201);

  await t.test("a dish with no tax rate takes the default rate, and none is refused", async () => {
    await pool.query("UPDATE tax_rates SET is_default = FALSE WHERE restaurant_id = $1", [rid]);
    const refused = await call("POST", "/menu/products", { categoryId: category.id, name: "Veg Spring Roll", price: 180, foodType: "veg" }, owner);
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /Tax rates/);

    await O("POST", "/menu/tax-rates", { name: "GST 5%", percentage: 5, hsnCode: "996331", isDefault: true }, 201);
    const dish = await O("POST", "/menu/products", { categoryId: category.id, name: "Veg Spring Roll", price: 180, foodType: "veg" }, 201);
    assert.equal(dish.taxPercentage, 5);

    const water = await O("POST", "/menu/products", { categoryId: category.id, name: "Mineral Water", price: 20, foodType: "veg", taxRateId: null }, 201);
    assert.equal(water.taxPercentage, 0, "No tax picked on purpose stays at 0%");
  });

  const paneer = await O("POST", "/inventory/items", { name: "Paneer", unitId: kg.id, category: "Dairy", reorderLevel: 1 }, 201);
  const butter = await O("POST", "/inventory/items", { name: "Butter", unitId: kg.id, category: "Dairy" }, 201);
  const tikka = await O("POST", "/menu/products", { categoryId: category.id, name: "Paneer Tikka", price: 280, foodType: "veg" }, 201);
  await O("POST", `/menu/products/${tikka.id}/recipe`, { inventoryItemId: paneer.id, quantity: 0.25 }, 201);
  await O("POST", `/menu/products/${tikka.id}/recipe`, { inventoryItemId: butter.id, quantity: 0.02 }, 201);

  await t.test("a bill takes an expired batch instead of being refused, and says so", async () => {
    await O("POST", "/inventory/movements/in", { inventoryItemId: paneer.id, quantity: 0.5, unitCost: 300, batchNumber: "PNR-OLD", expiryDate: daysFrom(-3) }, 201);
    await O("POST", "/inventory/movements/in", { inventoryItemId: butter.id, quantity: 2, unitCost: 500 }, 201);
    const order = await O("POST", "/orders", { orderType: "takeaway", items: [{ productId: tikka.id, quantity: 1 }] }, 201);
    const bill = await O("POST", "/bills", { orderId: order.id }, 201);
    const used = await one(
      `SELECT quantity, expired_quantity FROM stock_transactions
       WHERE restaurant_id = $1 AND inventory_item_id = $2 AND reference_type = 'bill' AND reference_id = $3`,
      [rid, paneer.id, bill.id]
    );
    assert.equal(Number(used.quantity), -0.25);
    assert.equal(Number(used.expired_quantity), 0.25);

    const batches = await O("GET", "/inventory/batches?show=used_after_expiry");
    const old = batches.find((row) => row.batch_number === "PNR-OLD");
    assert.ok(old && old.used_after_expiry === 0.25 && old.used_on_bills.includes(bill.billNumber));

    // A manual issue of expired stock is still refused.
    const issue = await call("POST", "/inventory/movements/out", { inventoryItemId: paneer.id, quantity: 0.1, transactionType: "consumption", reason: "Kitchen issue" }, owner);
    assert.equal(issue.status, 409);
  });

  await O("POST", "/inventory/movements/in", { inventoryItemId: paneer.id, quantity: 20, unitCost: 300, batchNumber: "PNR-NEW", expiryDate: daysFrom(20) }, 201);

  await t.test("large purchase orders wait for approval; large write-offs need a manager's PIN", async () => {
    const managerDeny = await call("PUT", "/inventory/settings", { poApprovalLimit: 1 }, manager);
    assert.equal(managerDeny.status, 403, "only the owner sets the limits");
    const limits = await O("PUT", "/inventory/settings", { poApprovalLimit: 10000, writeoffApprovalLimit: 500, transferReceiptRequired: false });
    assert.equal(limits.poApprovalLimit, 10000);

    const supplier = await O("POST", "/suppliers", { name: "Fresh Farms", mobile: "9876500011" }, 201);
    const small = await request("POST", "/purchase-orders", { supplierId: supplier.id, items: [{ inventoryItemId: paneer.id, quantity: 10, unitPrice: 300 }] }, 201, manager);
    const smallOrdered = await request("PATCH", `/purchase-orders/${small.id}/status`, { status: "ordered" }, 200, manager);
    assert.equal(smallOrdered.poStatus, "ordered");

    const big = await request("POST", "/purchase-orders", { supplierId: supplier.id, items: [{ inventoryItemId: paneer.id, quantity: 40, unitPrice: 300 }] }, 201, manager);
    const waiting = await request("PATCH", `/purchase-orders/${big.id}/status`, { status: "ordered" }, 200, manager);
    assert.equal(waiting.poStatus, "pending_approval");

    // A manager holds purchasing.approve? If not, the PIN is asked for.
    const first = await call("POST", `/purchase-orders/${big.id}/approve`, { note: "Party order" }, cook);
    assert.equal(first.status, 403, "a cook cannot approve orders");
    const approved = await request("POST", `/purchase-orders/${big.id}/approve`, { note: "Party order" }, 200, owner);
    assert.equal(approved.poStatus, "ordered");
    assert.equal(approved.approval.approvedAmount, 12000);
    assert.equal(approved.approval.note, "Party order");

    const foreign = await call("POST", `/purchase-orders/${big.id}/approve`, {}, other);
    assert.equal(foreign.status, 404, "another restaurant's order behaves as missing");

    // Waste under the limit goes straight in; over it asks for a PIN tied to
    // the quantity and the value, and the PIN logs it with the approver.
    await request("POST", `/inventory-insights/items/${paneer.id}/wastage`, { quantity: 1, reason: "spoiled" }, 201, cook);
    const over = await call("POST", `/inventory-insights/items/${paneer.id}/wastage`, { quantity: 3, reason: "spoiled", note: "Fridge failed" }, cook);
    assert.equal(over.status, 403);
    assert.equal(over.body.data.reason, "approval_required");
    assert.equal(over.body.data.permission, "inventory.approve_writeoff");
    assert.equal(over.body.data.scope.quantity, 3);
    const tooMuch = await call("POST", `/inventory-insights/items/${paneer.id}/wastage`, { quantity: 999, reason: "spoiled" }, cook);
    assert.equal(tooMuch.status, 400, "an entry refused anyway is refused before any PIN");
    const token = await approval(cook, "inventory.approve_writeoff", over.body.data.scope, "post", `/inventory-insights/items/${paneer.id}/wastage`);
    await request("POST", `/inventory-insights/items/${paneer.id}/wastage`, { quantity: 3, reason: "spoiled", note: "Fridge failed" }, 201, cook, { "X-Approval-Token": token });
    const reused = await call("POST", `/inventory-insights/items/${paneer.id}/wastage`, { quantity: 3, reason: "spoiled" }, cook, { "X-Approval-Token": token });
    assert.equal(reused.status, 403, "an approval is spent once");
    const logged = await auditRow(
      "SELECT approver_name FROM audit_logs WHERE restaurant_id = $1 AND action = 'wastage' AND approver_name IS NOT NULL",
      [rid]
    );
    assert.equal(logged.approver_name, "Meena manager");

    // Who wrote off what lists the large write-off with its approver.
    const control = await O("GET", "/inventory-insights/control");
    assert.equal(control.largeWriteoffs.length, 1);
    assert.equal(control.largeWriteoffs[0].approvedBy, "Meena manager");
    assert.ok(control.purchaseApprovals.some((row) => row.outcome === "approved" && row.orderId === big.id));

    await O("PUT", "/inventory/settings", { poApprovalLimit: null, writeoffApprovalLimit: null, transferReceiptRequired: false });
  });

  // A branch that keeps its own store, opened after the main counter's sales
  // above: a restaurant that trades through outlets names the outlet on every
  // parcel order, and those sales are the main store's.
  const branch = await one(
    "INSERT INTO outlets (restaurant_id, name, code, own_store, status) VALUES ($1, 'Jubilee Hills', 'JH01', TRUE, 'active') RETURNING id, name",
    [rid]
  );
  const branchId = Number(branch.id);
  await staff("Branch manager", "branch@swback.invalid", "MANAGER", { outletId: branchId });
  const branchManager = await login("branch@swback.invalid");

  await t.test("the wastage log pages on the server and counts the whole range", async () => {
    const page1 = await O("GET", "/inventory-insights/wastage/entries?limit=1&offset=0");
    const page2 = await O("GET", "/inventory-insights/wastage/entries?limit=1&offset=1");
    assert.equal(page1.total, 2);
    assert.equal(page1.items.length, 1);
    assert.equal(page2.items.length, 1);
    assert.notEqual(page1.items[0].id, page2.items[0].id);
    const past = await O("GET", "/inventory-insights/wastage/entries?limit=1&offset=5");
    assert.equal(past.items.length, 0);
    assert.equal(past.total, 2, "past the last page the count still describes the log");
    const bad = await call("GET", "/inventory-insights/wastage/entries?offset=-1", undefined, owner);
    assert.equal(bad.status, 400);
  });

  await t.test("a transfer note in transit, received short with a reason, reconciles", async () => {
    await O("PUT", "/inventory/settings", { transferReceiptRequired: true });
    const sent = await request("POST", "/inventory/transfers", { toOutletId: branchId, lines: [{ inventoryItemId: butter.id, quantity: 1 }] }, 201, owner);
    assert.equal(sent.status, "in_transit");
    const line = sent.lines[0];
    const noReason = await call("POST", `/inventory/transfers/${sent.id}/receive`, { lines: [{ lineId: line.id, receivedQuantity: 0.75 }] }, branchManager);
    assert.equal(noReason.status, 400, "a short line needs a reason");
    const received = await request(
      "POST",
      `/inventory/transfers/${sent.id}/receive`,
      { lines: [{ lineId: line.id, receivedQuantity: 0.75, shortfallReason: "damaged", shortfallNote: "Packet torn" }] },
      200,
      branchManager
    );
    assert.equal(received.status, "received");
    assert.equal(P(received.receivedValue) + P(received.shortfallValue), P(sent.sentValue), "received + written off = sent, to the paisa");
    assert.equal(P(received.shortfallValue), P(sent.sentValue / 4));
    const foreign = await call("GET", `/inventory/transfers/${sent.id}`, undefined, other);
    assert.equal(foreign.status, 404);
    await O("PUT", "/inventory/settings", { transferReceiptRequired: false });

    // The list pages on the server and filters by the note's date; the
    // "on the road" figure counts every note in transit whatever the dates.
    await request("POST", "/inventory/transfers", { toOutletId: branchId, lines: [{ inventoryItemId: butter.id, quantity: 0.1 }] }, 201, owner);
    const first = await O("GET", "/inventory/transfers?limit=1&offset=0");
    const second = await O("GET", "/inventory/transfers?limit=1&offset=1");
    const past = await O("GET", "/inventory/transfers?limit=1&offset=9");
    assert.equal(first.total, 2);
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal(past.items.length, 0);
    assert.equal(past.total, 2, "past the last page the count still holds");
    const old = await O("GET", `/inventory/transfers?from=${daysFrom(-40)}&to=${daysFrom(-30)}`);
    assert.equal(old.total, 0, "no note in those dates");
    const backwards = await call("GET", `/inventory/transfers?from=${daysFrom(1)}&to=${daysFrom(-1)}`, undefined, owner);
    assert.equal(backwards.status, 400);
    const indents = await O("GET", "/inventory/indents?limit=5&offset=0");
    assert.equal(indents.total, 0);
  });

  await t.test("stock movements page on the server with figures over every matching row", async () => {
    const all = await O("GET", `/inventory/movements?itemId=${butter.id}&limit=500`);
    const page = await O("GET", `/inventory/movements?itemId=${butter.id}&limit=2&offset=2`);
    assert.equal(page.total, all.total);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].id, all.items[2].id, "page 2 starts at the third movement");
    assert.equal(page.summary.in, all.items.filter((row) => row.quantity > 0).length);
    assert.equal(page.summary.out, all.items.filter((row) => row.quantity < 0).length);
    const inQty = all.items.filter((row) => row.quantity > 0).reduce((sum, row) => sum + row.quantity, 0);
    assert.equal(Math.round(page.summary.inQuantity * 1000), Math.round(inQty * 1000), "kilos in, over every page");
    const mixed = await O("GET", "/inventory/movements?limit=2");
    assert.equal(mixed.summary.inQuantity, null, "kilos of different items are not added up");
  });

  await t.test("suppliers from a spreadsheet, checked first, the same file twice changes nothing", async () => {
    const rows = [
      { "Supplier name": "Sri Lakshmi Dairy", Code: "DAIRY01", Mobile: "98480 12345", GSTIN: "37AAACL1234F1ZY", "Credit days": "7" },
      { "Supplier name": "Godavari Vegetables", Code: "VEG01", Mobile: "+91 94400 22334", "Credit days": "0" },
    ];
    const bad = await O("POST", "/suppliers/import", { rows: [...rows, { "Supplier name": "Bad GST", GSTIN: "37AAACL1234F1Z0" }], dryRun: true });
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((problem) => problem.column === "gstin"));
    const check = await O("POST", "/suppliers/import", { rows, dryRun: true });
    assert.equal(check.created, 2);
    await O("POST", "/suppliers/import", { rows, dryRun: false, fingerprint: check.fingerprint });
    const again = await O("POST", "/suppliers/import", { rows, dryRun: true });
    assert.equal(again.created, 0);
    assert.equal(again.updated, 0);
    const otherList = await request("GET", "/suppliers", undefined, 200, other);
    assert.ok(!otherList.some((row) => row.name === "Sri Lakshmi Dairy"), "another restaurant sees none of them");
  });

  await t.test("guests with anniversaries and opening points from a spreadsheet", async () => {
    const rows = [
      { Name: "Priya Sharma", Mobile: "+91 98765 43210", Anniversary: "09-11-2016", "Opening points": "450" },
      { Name: "Arjun Reddy", Mobile: "094400 11223", "Opening points": "120" },
    ];
    const check = await O("POST", "/crm/guest-book/import", { rows, dryRun: true, mode: "update" });
    assert.equal(check.created, 2);
    assert.equal(check.openingPoints.points, 570);
    await O("POST", "/crm/guest-book/import", { rows, dryRun: false, fingerprint: check.fingerprint, mode: "update" });
    const priya = await one("SELECT id, loyalty_points, anniversary_date::text AS anniversary FROM customers WHERE restaurant_id = $1 AND mobile LIKE '%9876543210'", [rid]);
    assert.equal(Number(priya.loyalty_points), 450);
    assert.equal(priya.anniversary, "2016-11-09");
    const ledger = await one("SELECT SUM(points)::int AS points FROM loyalty_transactions WHERE restaurant_id = $1", [rid]);
    assert.equal(ledger.points, 570, "opening points are in the points ledger");
    const twice = await O("POST", "/crm/guest-book/import", { rows, dryRun: true, mode: "skip" });
    assert.equal(twice.created, 0, "a mobile already in the book is never duplicated");

    // An anniversary this week puts the guest on the anniversaries list.
    const soon = daysFrom(2);
    await pool.query("UPDATE customers SET anniversary_date = $2::date - INTERVAL '8 years' WHERE id = $1", [priya.id, soon]);
    const list = await O("GET", "/guest-insights/segments/anniversaries");
    assert.ok(list.items.some((guest) => Number(guest.id) === Number(priya.id)), JSON.stringify(list.items));
  });

  await t.test("a finished dish written off by its recipe, then undone", async () => {
    const before = await one("SELECT current_stock FROM inventory_items WHERE id = $1", [butter.id]);
    const logged = await request("POST", "/inventory-insights/dish-waste", { productId: tikka.id, quantity: 2, reason: "remade", note: "Burnt" }, 201, cook);
    assert.equal(logged.ingredients.length, 2);
    const after = await one("SELECT current_stock FROM inventory_items WHERE id = $1", [butter.id]);
    assert.equal(Math.round((Number(before.current_stock) - Number(after.current_stock)) * 1000), 40, "2 plates × 0.02 kg butter");
    const cookUndo = await call("POST", `/inventory-insights/dish-waste/${logged.id}/reverse`, { note: "x" }, cook);
    assert.equal(cookUndo.status, 403, "undoing is a manager's");
    await O("POST", `/inventory-insights/dish-waste/${logged.id}/reverse`, { note: "Logged twice" });
    const back = await one("SELECT current_stock FROM inventory_items WHERE id = $1", [butter.id]);
    assert.equal(Number(back.current_stock), Number(before.current_stock));
    const foreign = await call("GET", `/inventory-insights/dish-waste/${logged.id}`, undefined, other);
    assert.equal(foreign.status, 404);
  });

  await t.test("the menu card carries the prices that outlet and service charge", async () => {
    const card = await O("GET", `/menu/menu-card?outletId=${branchId}&orderType=delivery`);
    const starters = card.categories.find((row) => row.name === "Starters");
    assert.ok(starters.items.some((item) => item.name === "Paneer Tikka" && item.price === 280));
    assert.equal(card.orderTypeLabel, "Delivery");
    const foreign = await call("GET", `/menu/menu-card?outletId=${branchId}`, undefined, other);
    assert.equal(foreign.status, 404, "another restaurant's outlet is not found");
  });

  await t.test("a purchase return carries every figure of its debit note", async () => {
    const supplier = await O("POST", "/suppliers", { name: "Hyderabad Provisions", gstNumber: "36AABCS5678K1ZT", address: "Begum Bazar" }, 201);
    const bill = await O("POST", "/purchase-orders/receipts", {
      supplierId: supplier.id,
      billNumber: "HP-1",
      lines: [{ inventoryItemId: butter.id, quantity: 4, unitPrice: 500, taxRate: 12 }],
    }, 201);
    const made = await O("POST", "/purchase-returns", {
      supplierId: supplier.id,
      goodsReceiptId: bill.id,
      reason: "Rancid",
      items: [{ inventoryItemId: butter.id, quantity: 1, unitPrice: 500, taxRate: 12 }],
    }, 201);
    const note = await O("GET", `/purchase-returns/${made.id}`);
    assert.equal(note.supplierGstin, "36AABCS5678K1ZT");
    assert.equal(note.billNumber, "HP-1");
    assert.equal(P(note.taxableAmount) + P(note.taxAmount), P(note.totalAmount));
    assert.equal(note.totalAmount, 560);
    await O("POST", `/purchase-returns/${made.id}/void`, { reason: "Supplier replaced it" });
    const voided = await O("GET", `/purchase-returns/${made.id}`);
    assert.equal(voided.status, "void");
    assert.equal(voided.returnNumber, note.returnNumber, "a reprint keeps its number");
  });

  await t.test("a till payment at a branch records that branch", async () => {
    const counter = await one(
      "INSERT INTO outlets (restaurant_id, name, code, own_store, status) VALUES ($1, 'Kondapur', 'KP01', FALSE, 'active') RETURNING id",
      [rid]
    );
    const atBranch = { "X-Outlet-Id": String(counter.id) };
    await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 2000 }, 201, atBranch);
    const supplier = await O("POST", "/suppliers", { name: "Kondapur Vegetables", creditDays: 0 }, 201);
    const paid = await call(
      "POST",
      "/purchase-returns/payments",
      { supplierId: supplier.id, amount: 750, paymentMethod: "cash", paidFromTill: true },
      owner,
      atBranch
    );
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const row = await one("SELECT outlet_id, paid_from_till FROM supplier_payments WHERE id = $1", [paid.body.paymentId]);
    assert.equal(Number(row.outlet_id), Number(counter.id));
    const listed = (paid.body.data || []).find((entry) => entry.id === paid.body.paymentId);
    assert.equal(listed.tillName, "Kondapur");
  });
});
