// Reports, day-end and dashboard (job R5, 6 Oct 2026), end to end on a
// throwaway database.
//
// What it keeps true:
//   REQ-DASH-LOAD   the dashboard answer is kept for a few seconds and thrown
//                   away the moment money moves (no stale takings after a
//                   payment); the one live request answers exactly the blocks
//                   each person may read, the same as the blocks' own routes;
//                   another restaurant reads only its own.
//   REQ-DASH-DUES   bills put on a guest's account are not "unpaid".
//   REQ-ACCESS-DAYEND-TIPS  tips by method on the day-end sheet; cash tips in
//                   the drawer's expected cash, never in the sales.
//   SW-X-RIDER-DRAWER  a rider's cash and shortfall reach the drawer and the
//                   day-end, to the paisa; what riders still owe is said.
//   SW-B-07         closing the day never erases the opening note.
//   SW-B-15/16      dish profitability ties to the stock its bills took; the
//                   items report lists add-ons sold.
//   R4 hand-offs    cash advances in the drawer; advances and payment types
//                   in the day book; payment corrections in theft control;
//                   GSTR-1 11A/11B; sales by payment type.
//   SW-B-09         the paper bill on an expense or a purchase bill: private,
//                   five at most, right type and size, removal logged.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

test("reports, day-end and dashboard", { timeout: 600000 }, async (t) => {
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
    name: "Report House",
    code: "RHOUSE",
    admin: { name: "Report owner", email: "owner@reports.invalid", password },
  });
  const rid = made.id;
  const other = await restaurantService.createRestaurant({
    name: "Other Dhaba",
    code: "ODHABA",
    admin: { name: "Other owner", email: "other@reports.invalid", password },
  });

  const app = require("../../src/app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, url, body, expected = 200, auth, headers = {}) {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const response = await fetch(base + url, {
      method,
      headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = { raw: text };
    }
    if (expected !== null) {
      assert.equal(response.status, expected, `${method} ${url}: ${text.slice(0, 300)}`);
    }
    return expected === null ? { status: response.status, ...result } : result.data;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password })).token;
  const owner = await login("owner@reports.invalid");
  const foreign = await login("other@reports.invalid");
  const O = (method, url, body, expected = 200, headers = {}) => request(method, url, body, expected, owner, headers);

  await O("PUT", "/restaurants/current/settings", {
    ...(await O("GET", "/restaurants/current/settings")),
    timezone: "Asia/Kolkata",
    taxMode: "exclusive",
    defaultTaxPercentage: 5,
    serviceChargePercentage: 0,
    autoConsumeStock: true,
    loyaltyEnabled: false,
    autoPrintBill: false,
  });
  const food = await O("POST", "/menu/tax-rates", { name: "Food 5%", percentage: 5, hsnCode: "996331" }, 201);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dish = async (name, price) =>
    O("POST", "/menu/products", { categoryId: category.id, name, price, taxRateId: food.id, isAvailable: true }, 201);
  const paneer = await dish("Paneer Tikka", 300);
  const roti = await dish("Tandoori Roti", 40);
  const unit = await O("POST", "/inventory/units", { name: "Kilogram", shortName: "kg" }, 201);
  const paneerKg = await O("POST", "/inventory/items", { name: "Paneer", unitId: unit.id, openingStock: 50, openingCost: 400 }, 201);
  const butter = await O("POST", "/inventory/items", { name: "Butter", unitId: unit.id, openingStock: 20, openingCost: 500 }, 201);
  await O("POST", `/menu/products/${paneer.id}/recipe`, { inventoryItemId: paneerKg.id, quantity: 0.2 }, 201);
  const cheese = await O("POST", "/menu/modifiers", { name: "Extra butter", price: 30 }, 201);
  const freeDip = await O("POST", "/menu/modifiers", { name: "Mint dip", price: 0 }, 201);
  await O("PUT", `/menu/modifiers/${cheese.id}/recipe`, { lines: [{ inventoryItemId: butter.id, quantity: 0.02 }] });
  await O("PUT", `/menu/products/${paneer.id}/modifiers`, { modifierIds: [cheese.id, freeDip.id] });

  const day = await O("POST", "/business-day/open", { openingCash: 2000, notes: "Float has ₹500 in coins" }, 201);
  const floor = await O("POST", "/tables/floors", { name: "Ground" }, 201);
  const table = await O("POST", "/tables", { floorId: floor.id, tableNo: "T1", capacity: 4 }, 201);

  const order = async (items, extra = {}) =>
    request("POST", "/orders", { orderType: "takeaway", ...extra, items }, 201, owner).then((placed) => placed.order || placed);
  const raise = async (orderId) => O("POST", "/bills", { orderId }, 201);
  const pay = async (bill, method = "cash", extra = {}) =>
    O("POST", `/bills/${bill.id}/payments`, { paymentMethod: method, amount: bill.dueAmount, ...extra }, 201);

  await t.test("REQ-DASH-LOAD the dashboard is kept, and thrown away the moment money moves", async () => {
    const first = await O("GET", "/reports/dashboard");
    // Changed behind the API's back: a kept answer does not see it…
    await pool.query("UPDATE business_days SET opening_cash = opening_cash + 100 WHERE id = $1", [day.id]);
    const kept = await O("GET", "/reports/dashboard");
    assert.equal(kept.cash.openingCash, first.cash.openingCash, "the second look within 15 s is the kept answer");
    // …until anything is written for the restaurant: a sale and its payment.
    const bill = await raise((await order([{ productId: roti.id, quantity: 2 }])).id);
    const unpaidNow = await O("GET", "/reports/dashboard");
    assert.equal(unpaidNow.cash.openingCash, first.cash.openingCash + 100, "a write throws the kept answer away");
    assert.equal(unpaidNow.unpaid.count, first.unpaid.count + 1);
    await pay(bill);
    const paid = await O("GET", "/reports/dashboard");
    assert.equal(paid.unpaid.count, first.unpaid.count, "no stale unpaid bill after the payment");
    assert.equal(paid.netSales, Number((first.netSales + bill.totalAmount).toFixed(2)), "no stale takings after the payment");
    await pool.query("UPDATE business_days SET opening_cash = opening_cash - 100 WHERE id = $1", [day.id]);
    await O("POST", "/expenses/categories", { name: "Kept-cache nudge" }, 201);
  });

  await t.test("REQ-DASH-LOAD one live request answers exactly the blocks a person may read", async () => {
    const live = await O("GET", "/reports/dashboard/live");
    const tables = await O("GET", "/tables");
    assert.deepEqual(live.blocks.tables.data, tables, "the same answer as the block's own route");
    assert.ok(live.blocks.kitchen && live.blocks.alerts && live.blocks.stock);
    const asked = await O("GET", "/reports/dashboard/live?blocks=tables,nonsense");
    assert.deepEqual(Object.keys(asked.blocks), ["tables"]);

    const hash = await bcrypt.hash(password, 4);
    const row = await one(
      "INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, 'Cap', 'cap@reports.invalid', $2) RETURNING id",
      [rid, hash]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'CAPTAIN' AND restaurant_id IS NULL", [row.id]);
    const captain = await login("cap@reports.invalid");
    const perms = (await request("GET", "/auth/me", undefined, 200, captain)).permissions || [];
    const theirs = await request("GET", "/reports/dashboard/live", undefined, 200, captain);
    for (const [key, perm] of [["kitchen", "kds.view"], ["stock", "inventory.view"], ["guests", "customers.view"], ["staff", "staff.clock"]]) {
      assert.equal(key in theirs.blocks, perms.includes(perm), `${key} only with ${perm}`);
    }

    const otherLive = await request("GET", "/reports/dashboard/live?blocks=tables", undefined, 200, foreign);
    assert.equal(otherLive.blocks.tables.data.length, 0, "another restaurant sees none of our tables");
    const otherDash = await request("GET", "/reports/dashboard", undefined, 200, foreign);
    assert.equal(otherDash.billCount, 0, "nor our bills");
  });

  await t.test("REQ-DASH-DUES a bill on a guest's account is not an unpaid bill", async () => {
    const before = await O("GET", "/reports/dashboard");
    const guest = await O("POST", "/crm/customers", { name: "Company Guest", mobile: "9876500091" }, 201);
    const bill = await raise((await order([{ productId: roti.id, quantity: 1 }])).id);
    await pool.query("UPDATE bills SET account_customer_id = $2, account_at = NOW() WHERE id = $1", [bill.id, guest.id]);
    await O("POST", "/expenses/categories", { name: "Nudge 2" }, 201);
    const after = await O("GET", "/reports/dashboard");
    assert.equal(after.unpaid.count, before.unpaid.count);
    assert.equal(after.onAccount.count, before.onAccount.count + 1);
    assert.equal(after.onAccount.due, Number((before.onAccount.due + bill.totalAmount).toFixed(2)));
  });

  await t.test("REQ-ACCESS-DAYEND-TIPS tips by method; cash tips in the drawer, never in sales", async () => {
    const before = await O("GET", "/reports/day-end");
    const b1 = await raise((await order([{ productId: roti.id, quantity: 3 }])).id);
    await pay(b1, "cash", { tipAmount: 20, tenderedAmount: b1.dueAmount + 20 });
    const b2 = await raise((await order([{ productId: roti.id, quantity: 1 }])).id);
    await pay(b2, "upi", { tipAmount: 15 });
    const after = await O("GET", "/reports/day-end");
    assert.equal(after.tips.total, before.tips.total + 35);
    assert.deepEqual(
      after.tips.byMethod.map((row) => [row.paymentMethod, row.amount]).sort(),
      [["cash", 20], ["upi", 15]]
    );
    assert.equal(after.cashTips, 20);
    assert.equal(after.netSales, Number((before.netSales + b1.totalAmount + b2.totalAmount).toFixed(2)), "tips are not sales");
    assert.equal(after.expectedCash, Number((before.expectedCash + b1.totalAmount + 20).toFixed(2)), "the cash tip is in the drawer");
    const preview = await O("GET", "/business-day/close-preview");
    assert.equal(preview.figures.cashTips, 20);
    assert.equal(preview.figures.dayExpected, after.expectedCash, "the close and the day-end agree to the paisa");
  });

  await t.test("SW-X-RIDER-DRAWER a rider's cash and shortfall reach the drawer and the day-end", async () => {
    const rider = await one("INSERT INTO employees (restaurant_id, name, department) VALUES ($1, 'Ravi', 'delivery') RETURNING id", [rid]);
    const bills = [];
    for (const quantity of [2, 3]) {
      const placed = await order([{ productId: roti.id, quantity }], { orderType: "delivery", customerName: "Door" });
      await pool.query(
        "UPDATE orders SET rider_employee_id = $2, delivery_status = 'delivered', dispatched_at = NOW(), delivered_at = NOW() WHERE id = $1",
        [placed.id, rider.id]
      );
      bills.push(await raise(placed.id));
    }
    const before = await O("GET", "/reports/day-end");
    const preview = await O("GET", `/deliveries/riders/${rider.id}/settlement`);
    const handed = Number((preview.cashExpected - 10).toFixed(2));
    const settled = await O(
      "POST",
      `/deliveries/riders/${rider.id}/settle`,
      { bills: bills.map((b) => ({ billId: b.id, method: "cash" })), cashHanded: handed, shortfallReason: "Change given" },
      201
    );
    const after = await O("GET", "/reports/day-end");
    assert.equal(after.riderCash, Number((before.riderCash + handed).toFixed(2)));
    assert.equal(after.riderShortfall, Number((before.riderShortfall + 10).toFixed(2)));
    assert.equal(after.ridersOwe.amount, 10);
    assert.equal(
      after.expectedCash,
      Number((before.expectedCash + handed).toFixed(2)),
      "the drawer expects what the rider handed in, not the bills' full cash"
    );
    const id = (settled.settlement || settled).id;
    await O("POST", `/deliveries/rider-settlements/${id}/repaid`, undefined, 200);
    const repaid = await O("GET", "/reports/day-end");
    assert.equal(repaid.riderRepaid, 10);
    assert.equal(repaid.ridersOwe.amount, 0);
    assert.equal(repaid.expectedCash, Number((before.expectedCash + handed + 10).toFixed(2)), "the shortfall handed over is in today's drawer");
    const close = await O("GET", "/business-day/close-preview");
    assert.equal(close.figures.dayExpected, repaid.expectedCash);
  });

  await t.test("SW-B-15/16 dish profitability ties to the stock its bills took; add-ons sold are listed", async () => {
    const placed = await order([
      { productId: paneer.id, quantity: 2, modifierIds: [cheese.id, freeDip.id] },
      { productId: roti.id, quantity: 2 },
    ]);
    const bill = await raise(placed.id);
    await pay(bill);
    const today = after0(await O("GET", "/reports/trading-day"));
    const range = `?from=${today}&to=${today}`;
    const report = await O("GET", `/reports/profitability${range}`);
    const used = await one(
      `SELECT COALESCE(SUM(-st.quantity * COALESCE(st.unit_cost, i.last_cost, 0)), 0)::float AS cost
       FROM stock_transactions st JOIN inventory_items i ON i.id = st.inventory_item_id
       WHERE st.restaurant_id = $1 AND st.reference_type = 'bill'`,
      [rid]
    );
    assert.ok(used.cost > 0, "the bill took stock");
    assert.equal(report.totals.foodCost, Number(used.cost.toFixed(2)), "food cost ties to the stock bills took");
    const paneerRow = report.dishes.find((row) => row.itemName === "Paneer Tikka");
    const rotiRow = report.dishes.find((row) => row.itemName === "Tandoori Roti");
    assert.equal(paneerRow.hasRecipe, true);
    assert.equal(rotiRow.hasRecipe, false, "a dish without a recipe is flagged");
    assert.equal(rotiRow.foodCost, 0);
    assert.equal(paneerRow.contribution, Number((paneerRow.sales - paneerRow.foodCost).toFixed(2)));
    await request("GET", `/reports/profitability${range}`, undefined, 200, foreign).then((theirs) => assert.equal(theirs.dishes.length, 0));

    const items = await O("GET", `/reports/items${range}`);
    const byName = Object.fromEntries(items.addons.map((row) => [row.addonName, row]));
    assert.equal(byName["Extra butter"].quantity, 2);
    assert.equal(byName["Extra butter"].value, 60);
    assert.equal(byName["Mint dip"].quantity, 2, "a free add-on is counted");
    assert.equal(byName["Mint dip"].free, true);
  });

  await t.test("SW-B-09 the paper bill on an expense and a purchase bill is private, limited and logged", async () => {
    const categories = await O("GET", "/expenses/categories");
    const expense = await O("POST", "/expenses", { expenseCategoryId: categories[0].id, amount: 450, paymentMode: "upi", notes: "Plumber" }, 201);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const form = (bytes, type, name) => {
      const f = new FormData();
      f.append("file", new Blob([bytes], { type }), name);
      return f;
    };
    const added = await O("POST", `/expenses/${expense.id}/attachments`, form(png, "image/png", "receipt.png"), 201);
    const listed = await O("GET", "/expenses?pageSize=25&status=pending");
    assert.equal((listed.items || listed).find((row) => row.id === expense.id).attachmentCount, 1, "the paperclip count");

    const file = await fetch(`${base}/expenses/${expense.id}/attachments/${added.id}`, { headers: { Authorization: `Bearer ${owner}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.equal((await fetch(`${base}/expenses/${expense.id}/attachments/${added.id}`)).status, 401, "never without a session");
    await request("GET", `/expenses/${expense.id}/attachments/${added.id}`, undefined, 404, foreign);
    await request("POST", `/expenses/${expense.id}/attachments`, form(png, "image/png", "x.png"), 404, foreign);
    assert.equal((await fetch(`${base.replace(/\/api$/, "")}/uploads/attachments/${added.id}`)).status, 404, "not on the public uploads path");

    const refusal = async (body) => request("POST", `/expenses/${expense.id}/attachments`, body, null, owner);
    const wrong = await refusal(form(Buffer.from("MZ not a pdf"), "application/pdf", "x.pdf"));
    assert.equal(wrong.status, 400);
    assert.match(wrong.message, /JPG or PNG|PDF/, "a renamed file is refused by its bytes");
    const big = await refusal(form(Buffer.alloc(5 * 1024 * 1024 + 10, 1), "image/png", "big.png"));
    assert.equal(big.status, 400);
    assert.match(big.message, /5 MB/);
    for (let i = 0; i < 4; i += 1) await O("POST", `/expenses/${expense.id}/attachments`, form(png, "image/png", `r${i}.png`), 201);
    const sixth = await refusal(form(png, "image/png", "six.png"));
    assert.equal(sixth.status, 400);
    assert.match(sixth.message, /5 files/);

    await O("DELETE", `/expenses/${expense.id}/attachments/${added.id}`);
    // The activity log is written after the answer (best-effort, never in the
    // way of the action): under load the row can land a moment later.
    let logged = 0;
    for (let tries = 0; tries < 50 && !logged; tries += 1) {
      logged = (await one("SELECT COUNT(*)::int AS n FROM audit_logs WHERE restaurant_id = $1 AND action = 'remove_attachment' AND entity_type = 'expense'", [rid])).n;
      if (!logged) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(logged, 1, "removing a file is logged");
    assert.equal((await O("GET", `/expenses/${expense.id}/attachments`)).length, 4);

    const supplier = await O("POST", "/suppliers", { name: "Veg Vendor" }, 201);
    const bill = await O(
      "POST",
      "/purchase-orders/receipts",
      { supplierId: supplier.id, billNumber: "VV-1", lines: [{ inventoryItemId: paneerKg.id, quantity: 1, unitPrice: 400, taxRate: 0 }] },
      201
    );
    const billId = bill.id || (bill.receipt && bill.receipt.id);
    await O("POST", `/purchase-orders/receipts/${billId}/attachments`, form(Buffer.from("%PDF-1.4\n%%EOF"), "application/pdf", "bill.pdf"), 201);
    await O("POST", `/purchase-orders/receipts/${billId}/void`, { reason: "Entered twice" });
    assert.equal((await O("GET", `/purchase-orders/receipts/${billId}/attachments`)).length, 1, "a voided bill keeps its files");
    await request("GET", `/purchase-orders/receipts/${billId}/attachments`, undefined, 404, foreign);
  });

  await t.test("R4-DRAWER-ADVANCES cash advances in and out reach the drawer; paying from an advance is not new cash", async () => {
    const guest = await O("POST", "/crm/customers", { name: "Party Host", mobile: "9876500071" }, 201);
    const before = await O("GET", "/reports/day-end");
    const advance = await O("POST", "/bills/advances", { customerId: guest.id, amount: 500, paymentMethod: "cash", purpose: "Birthday party" }, 201);
    const advanceId = (advance.advance || advance).id;
    await O("POST", `/bills/advances/${advanceId}/refunds`, { amount: 100, refundMethod: "cash", reason: "Fewer guests" }, 201);
    const bill = await raise((await order([{ productId: roti.id, quantity: 2 }], { customerId: guest.id })).id);
    await O("POST", `/bills/${bill.id}/payments`, { paymentMethod: "advance", amount: bill.dueAmount, advanceId }, 201);
    const after = await O("GET", "/reports/day-end");
    assert.equal(after.cashAdvances, Number((before.cashAdvances + 500).toFixed(2)));
    assert.equal(after.cashAdvancesReturned, Number((before.cashAdvancesReturned + 100).toFixed(2)));
    assert.equal(after.expectedCash, Number((before.expectedCash + 400).toFixed(2)), "advance in, refund out, the bill paid from it adds nothing");
    const close = await O("GET", "/business-day/close-preview");
    assert.equal(close.figures.cashAdvances, after.cashAdvances);
    assert.equal(close.figures.dayExpected, after.expectedCash, "the close and the day-end agree to the paisa");

    const book = await O("GET", `/reports/day-book?from=${after.businessDate}&to=${after.businessDate}`);
    const ledgers = new Set(book.vouchers.flatMap((v) => v.entries.map((e) => e.ledger)));
    assert.ok(ledgers.has("Advances from customers"), "advances have their own ledger");
    assert.equal(book.totals.unbalanced, 0);
    const received = book.vouchers.find((v) => v.party === "Advances from customers" && v.type === "Receipt");
    assert.ok(received && received.entries.some((e) => e.ledger === "Cash" && e.debit > 0));
  });

  await t.test("R4 payment types, corrections, delivery charges and 11A in the reports", async () => {
    const type = await O("POST", "/restaurants/current/payment-types", { paymentMethod: "other", name: "Pluxee" }, 201);
    const typeId = (type.paymentType || type).id;
    const bill = await raise((await order([{ productId: roti.id, quantity: 5 }])).id);
    await O("POST", `/bills/${bill.id}/payments`, { paymentMethod: "other", paymentTypeId: typeId, amount: bill.dueAmount }, 201);
    const cashBill = await raise((await order([{ productId: roti.id, quantity: 4 }])).id);
    await pay(cashBill);
    const payment = await one("SELECT id FROM payments WHERE bill_id = $1", [cashBill.id]);
    await O("PATCH", `/bills/${cashBill.id}/payments/${payment.id}`, { paymentMethod: "upi", reason: "Guest paid by UPI" });

    const today = after0(await O("GET", "/reports/trading-day"));
    const range = `?from=${today}&to=${today}`;
    const sales = await O("GET", `/reports/sales${range}`);
    const pluxee = sales.byPaymentType.find((row) => row.paymentTypeName === "Pluxee");
    assert.equal(pluxee.amount, bill.totalAmount, "sales by payment type");
    assert.ok("deliveryCharges" in sales.summary && "tips" in sales.summary);

    const book = await O("GET", `/reports/day-book${range}`);
    assert.ok(book.vouchers.some((v) => v.entries.some((e) => e.ledger === "Pluxee (bank)")), "a payment type is a ledger of its own");

    const theft = await O("GET", `/reports/theft${range}`);
    assert.equal(theft.summary.corrections.count, 1);
    assert.equal(theft.summary.corrections.fromCash, 1, "cash written up as UPI is flagged");
    assert.equal(theft.corrections[0].oldMethod, "cash");
    assert.equal(theft.corrections[0].newMethod, "upi");
    assert.equal(theft.corrections[0].billNumber, cashBill.billNumber);

    const pack = await O("GET", `/reports/gst${range}`);
    assert.ok(pack.advances && pack.advances.table11A, "GSTR-1 11A/11B are in the pack");
    assert.equal(pack.advances.received, 500);
    assert.ok(pack.checks.every((check) => check.ok !== false), JSON.stringify(pack.checks.filter((c) => c.ok === false)));

    const theirs = await request("GET", `/reports/theft${range}`, undefined, 200, foreign);
    assert.equal(theirs.summary.corrections.count, 0, "another restaurant sees none of our corrections");
  });

  await t.test("SW-B-07 closing the day keeps the opening note beside the closing one", async () => {
    const preview = await O("GET", "/business-day/close-preview");
    await O("POST", "/business-day/close", { closingCash: preview.figures.inDrawer, carryUnpaid: true, notes: "All good, AC fixed" });
    const status = await O("GET", "/business-day");
    const closed = status.history.find((row) => row.id === day.id);
    assert.equal(closed.openingNotes, "Float has ₹500 in coins");
    assert.match(closed.closingNotes, /^All good, AC fixed/);
    const sheet = await O("GET", `/reports/day-end?businessDate=${closed.businessDate}`);
    assert.equal(sheet.notes[0].openingNotes, "Float has ₹500 in coins");
    assert.match(sheet.notes[0].closingNotes, /All good/);
  });

  void other;
});

// The trading day's date from GET /reports/trading-day.
function after0(day) {
  return day.businessDate || day.calendarDate;
}
