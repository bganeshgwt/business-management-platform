const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { today, daysFrom } = require("./helpers/dates");

// Back office and guests: stock cost after returns and voided bills, staff
// tied to one outlet kept to its stock, the guest book's erase against an edit
// and against points, and guest insights masked for a cashier. Its own
// throwaway database, like restaurant.test.js.
test("stock cost, outlet stock and guest privacy", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres" });
  let created = false, pool, server;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) {
        await admin.query(`DROP DATABASE "${database}"`);
      }
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  process.env.LOGIN_ATTEMPT_LIMIT = "200";
  const { runner } = await import("node-pg-migrate");
  await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"),
    migrationsTable: "pgmigrations", direction: "up", count: Infinity, checkOrder: true, log() {} });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rid = (await one("INSERT INTO restaurants (name,code) VALUES ('Back office test','BOTEST') RETURNING id")).id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id,loyalty_earn_amount,loyalty_point_value,loyalty_min_redeem) VALUES ($1,100,1,1)", [rid]);
  // Loyalty on is the Loyalty points feature (Settings -> Features).
  await pool.query("SELECT restaurant_feature_set($1, 'guest_loyalty', TRUE)", [rid]);
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const outletA = await one("INSERT INTO outlets(restaurant_id,name,code,own_store) VALUES ($1,'Branch A','BRA',true) RETURNING id", [rid]);
  const outletB = await one("INSERT INTO outlets(restaurant_id,name,code,own_store) VALUES ($1,'Branch B','BRB',true) RETURNING id", [rid]);
  const makeUser = async (email, role, outletId = null) => {
    const user = await one("INSERT INTO users (restaurant_id,name,email,password_hash,outlet_id) VALUES ($1,$2,$2,$3,$4) RETURNING id", [rid, email, hash, outletId]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL", [user.id, role]);
    return user;
  };
  const owner = await makeUser("owner@bo.invalid", "RESTAURANT_ADMIN");
  await makeUser("manager.a@bo.invalid", "MANAGER", outletA.id);
  await makeUser("cook.a@bo.invalid", "KITCHEN", outletA.id);
  await makeUser("cashier@bo.invalid", "CASHIER");
  const kg = await one("INSERT INTO units(restaurant_id,name,short_name) VALUES ($1,'Kilogram','kg') RETURNING id", [rid]);
  const supplier = await one("INSERT INTO suppliers(restaurant_id,name) VALUES ($1,'Dairy Co') RETURNING id", [rid]);

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = {};
  async function request(method, url, body, expected = 200, who = "owner", headers = {}) {
    const response = await fetch(base + url, { method, headers: {
      "Content-Type": "application/json", ...headers, ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result.data;
  }
  for (const [who, email] of [["owner", "owner@bo.invalid"], ["managerA", "manager.a@bo.invalid"], ["cookA", "cook.a@bo.invalid"], ["cashier", "cashier@bo.invalid"]]) {
    tokens[who] = (await request("POST", "/auth/login", { identifier: email, password }, 200, null)).token;
  }
  const average = async (id) => Number((await one("SELECT average_cost FROM inventory_items WHERE id=$1", [id])).average_cost);
  const bill = (itemId, quantity, unitPrice, billNumber, headers = {}) =>
    request("POST", "/purchase-orders/receipts", { supplierId: supplier.id, billNumber, lines: [{ inventoryItemId: itemId, quantity, unitPrice, taxRate: 0 }] }, 201, "owner", headers);

  await t.test("a purchase return never moves the average cost", async () => {
    const paneer = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Paneer',$2) RETURNING id", [rid, kg.id]);
    await bill(paneer.id, 5, 300, "P-1");
    await bill(paneer.id, 8, 300, "P-2");
    const third = await bill(paneer.id, 4, 336, "P-3");
    const before = await average(paneer.id);
    assert.ok(Math.abs(before - 308.4706) < 0.0001, `average ${before}`);
    const ret = await request("POST", "/purchase-returns", { supplierId: supplier.id, goodsReceiptId: third.id, reason: "Sour", items: [{ inventoryItemId: paneer.id, quantity: 1, unitPrice: 320 }] }, 201);
    assert.equal(await average(paneer.id), before);
    await request("PUT", `/purchase-returns/${ret.id}`, { lines: [{ id: ret.items[0].id, unitPrice: 300 }], changeReason: "Credit agreed at 300" });
    assert.equal(await average(paneer.id), before);
    await request("POST", `/purchase-returns/${ret.id}/void`, { reason: "Entered by mistake" });
    assert.equal(await average(paneer.id), before);
    const free = await request("POST", "/purchase-returns", { supplierId: supplier.id, goodsReceiptId: third.id, reason: "Replacement promised", items: [{ inventoryItemId: paneer.id, quantity: 0.5, unitPrice: 0 }] }, 201);
    assert.ok(free.id);
    assert.equal(await average(paneer.id), before);
  });

  await t.test("closing stock forgets a voided bill's price", async () => {
    const ghee = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Ghee',$2) RETURNING id", [rid, kg.id]);
    await bill(ghee.id, 10, 500, "G-1");
    const second = await bill(ghee.id, 5, 550, "G-2");
    await request("POST", `/purchase-orders/receipts/${second.id}/void`, { reason: "Duplicate" });
    const same = await one(`SELECT (SELECT effective_at FROM stock_transactions WHERE reference_type='goods_receipt' AND reference_id=$1)
                              = (SELECT effective_at FROM stock_transactions WHERE reference_type='goods_receipt_void' AND reference_id=$1) AS same`, [second.id]);
    assert.equal(same.same, true);
    const valuation = await request("GET", "/inventory/valuation");
    const row = valuation.items.find((r) => Number(r.id) === Number(ghee.id));
    assert.ok(Math.abs(row.unitCost - 500) < 0.0002, `unit cost ${row.unitCost}`);
    assert.ok(Math.abs(row.value - 5000) < 0.005, `value ${row.value}`);
  });

  await t.test("voiding a return written under the old rule puts the average back", async () => {
    const oil = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Oil',$2) RETURNING id", [rid, kg.id]);
    const first = await bill(oil.id, 20, 150, "O-1");
    assert.ok(first.id);
    const ret = await request("POST", "/purchase-returns", { supplierId: supplier.id, goodsReceiptId: first.id, reason: "Leaking tin", items: [{ inventoryItemId: oil.id, quantity: 0.5, unitPrice: 0 }] }, 201);
    // As the old rule wrote it: out at the ₹0 credit, the 19.5 L left
    // re-averaged to 3,000 / 19.5.
    const pushed = (3000 / 19.5).toFixed(6);
    await pool.query("UPDATE stock_transactions SET unit_cost = 0, average_cost_after = $2 WHERE reference_type='purchase_return' AND reference_id=$1", [ret.id, pushed]);
    await pool.query("UPDATE inventory_items SET average_cost = ROUND($2::numeric, 4) WHERE id=$1", [oil.id, pushed]);
    await request("POST", `/purchase-returns/${ret.id}/void`, { reason: "Entered by mistake" });
    const after = await average(oil.id);
    assert.ok(Math.abs(after - 150) < 0.0001, `average ${after}`);
  });

  await t.test("a voided bill whose goods were partly used is re-costed as if never entered", async () => {
    const butter = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Butter',$2) RETURNING id", [rid, kg.id]);
    await bill(butter.id, 10, 500, "B-1");
    const second = await bill(butter.id, 5, 550, "B-2");
    await request("POST", "/inventory/movements/out", { inventoryItemId: butter.id, quantity: 3, transactionType: "consumption", reason: "Kitchen" }, 201);
    await request("POST", `/purchase-orders/receipts/${second.id}/void`, { reason: "Never delivered" });
    const after = await average(butter.id);
    assert.ok(Math.abs(after - 500) < 0.0001, `average ${after} (the moving-average reversal gave 492.86)`);
    const used = await one("SELECT unit_cost FROM stock_transactions WHERE inventory_item_id=$1 AND transaction_type='consumption'", [butter.id]);
    assert.ok(Math.abs(Number(used.unit_cost) - 500) < 0.0001, `3 kg used costed at ${used.unit_cost}`);
    const ledger = await one("SELECT SUM(quantity)::float8 AS qty, SUM(quantity*unit_cost)::float8 AS value FROM stock_transactions WHERE inventory_item_id=$1", [butter.id]);
    assert.ok(Math.abs(ledger.qty - 7) < 0.0005 && Math.abs(ledger.value - 3500) < 0.01, JSON.stringify(ledger));

    // Bills received on earlier days, 1 kg used today, the second voided
    // today: the day before today still closes at 10 kg x ₹500.
    const day = (back) => daysFrom(-back);
    const cardamom = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Cardamom',$2) RETURNING id", [rid, kg.id]);
    await request("POST", "/purchase-orders/receipts", { supplierId: supplier.id, billNumber: "C-1", billDate: day(3), receivedDate: day(3), lines: [{ inventoryItemId: cardamom.id, quantity: 10, unitPrice: 500, taxRate: 0 }] }, 201);
    const late = await request("POST", "/purchase-orders/receipts", { supplierId: supplier.id, billNumber: "C-2", billDate: day(2), receivedDate: day(2), lines: [{ inventoryItemId: cardamom.id, quantity: 5, unitPrice: 550, taxRate: 0 }] }, 201);
    await request("POST", "/inventory/movements/out", { inventoryItemId: cardamom.id, quantity: 1, transactionType: "consumption", reason: "Kitchen" }, 201);
    await request("POST", `/purchase-orders/receipts/${late.id}/void`, { reason: "Duplicate" });
    const yesterday = (await request("GET", `/inventory/valuation?date=${day(1)}`)).items.find((r) => Number(r.id) === Number(cardamom.id));
    assert.ok(yesterday && Math.abs(yesterday.quantity - 10) < 0.0005 && Math.abs(yesterday.unitCost - 500) < 0.0002, JSON.stringify(yesterday));
    assert.ok(Math.abs((await average(cardamom.id)) - 500) < 0.0001);

    // A bill typed at ₹55,000 a kg instead of ₹550, partly used, can still be
    // voided (it used to stop on "a negative stock value").
    const saffron = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Saffron',$2) RETURNING id", [rid, kg.id]);
    await bill(saffron.id, 10, 500, "S-1");
    const typo = await bill(saffron.id, 5, 55000, "S-2");
    await request("POST", "/inventory/movements/out", { inventoryItemId: saffron.id, quantity: 3, transactionType: "consumption", reason: "Kitchen" }, 201);
    await request("POST", `/purchase-orders/receipts/${typo.id}/void`, { reason: "Price typed wrong" });
    assert.ok(Math.abs((await average(saffron.id)) - 500) < 0.0001);

    // Stock found on an empty shelf keeps the cost it came in at: 1 kg once
    // stocked at ₹90 lakh and used up does not price the 1,000 kg found later.
    const kesar = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Kesar',$2) RETURNING id", [rid, kg.id]);
    await request("POST", "/inventory/movements/in", { inventoryItemId: kesar.id, quantity: 1, unitCost: 9000000, reason: "Typed wrong" }, 201);
    await request("POST", "/inventory/movements/out", { inventoryItemId: kesar.id, quantity: 1, transactionType: "adjustment", reason: "Used up" }, 201);
    const kesarBill = await bill(kesar.id, 1000, 1, "K-1");
    await request("POST", "/inventory/movements/in", { inventoryItemId: kesar.id, quantity: 1000, reason: "Found" }, 201);
    await request("POST", "/inventory/movements/in", { inventoryItemId: kesar.id, quantity: 0.1, unitCost: 1.2, reason: "Right price" }, 201);
    await request("POST", `/purchase-orders/receipts/${kesarBill.id}/void`, { reason: "Entered twice" });
    const kesarValue = 1000.1 * (await average(kesar.id));
    assert.ok(Math.abs(kesarValue - 1000.12) < 0.02, `worth ${kesarValue}`);
  });

  await t.test("staff tied to outlet A cannot see or move outlet B's stock", async () => {
    const rice = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id,category) VALUES ($1,'Rice',$2,'Grains') RETURNING id", [rid, kg.id]);
    const asB = { "X-Outlet-Id": String(outletB.id) };
    await request("POST", "/inventory/movements/in", { inventoryItemId: rice.id, quantity: 10, unitCost: 50, reason: "B delivery" }, 201, "owner", asB);
    await request("POST", "/inventory/movements/in", { inventoryItemId: rice.id, quantity: 4, unitCost: 50, reason: "A delivery" }, 201, "owner", { "X-Outlet-Id": String(outletA.id) });
    await request("GET", `/inventory/movements?store=${outletB.id}`, undefined, 403, "managerA");
    const mine = await request("GET", `/inventory/movements?itemId=${rice.id}`, undefined, 200, "managerA");
    assert.ok(mine.items.every((m) => Number(m.outletId) === Number(outletA.id)));
    await request("POST", "/inventory/movements/out", { inventoryItemId: rice.id, quantity: 1, outletId: outletB.id }, 403, "managerA");
    await request("POST", "/inventory/movements/in", { inventoryItemId: rice.id, quantity: 1, outletId: outletB.id }, 403, "managerA");
    await request("POST", "/inventory/movements/transfer", { inventoryItemId: rice.id, fromOutletId: outletB.id, toOutletId: outletA.id, quantity: 1 }, 403, "managerA");
    await request("POST", "/inventory/counts", { outletId: outletB.id, categories: ["Grains"] }, 403, "cookA");
    const countB = await request("POST", "/inventory/counts", { outletId: outletB.id, categories: ["Grains"] }, 201);
    await request("GET", `/inventory/counts/${countB.id}`, undefined, 404, "cookA");
    await request("POST", `/inventory/counts/${countB.id}/post`, {}, 404, "managerA");
    const stores = await request("GET", "/inventory/stores", undefined, 200, "managerA");
    assert.deepEqual(stores.map((s) => Number(s.outletId)), [Number(outletA.id)]);
    const waste = await request("POST", "/inventory-insights/wastage", { inventoryItemId: rice.id, quantity: 0.5, reason: "spoiled" }, 201, "owner", asB);
    await request("POST", `/inventory-insights/wastage/${waste.entry.id}/reverse`, {}, 404, "managerA");
    const summary = await request("GET", "/inventory-insights/summary", undefined, 200, "managerA");
    assert.equal(Number(summary.store.outletId), Number(outletA.id));
    await request("POST", "/purchase-orders/receipts", { supplierId: supplier.id, billNumber: "SB-1", outletId: outletB.id, lines: [{ inventoryItemId: rice.id, quantity: 1, unitPrice: 50, taxRate: 0 }] }, 403, "managerA");

    // A new item's opening stock goes onto A's shelf, not the main store's.
    const mint = await request("POST", "/inventory/items", { name: "Mint", unitId: kg.id, openingStock: 5, openingCost: 120 }, 201, "managerA");
    const held = await pool.query("SELECT outlet_id, quantity FROM stock_balances WHERE inventory_item_id=$1", [mint.id]);
    assert.deepEqual(held.rows.map((row) => [Number(row.outlet_id), Number(row.quantity)]), [[Number(outletA.id), 5]]);

    // The Items list and the ledger's running balance are A's store's.
    const items = await request("GET", "/inventory/items?search=Rice", undefined, 200, "managerA");
    const riceForA = items.find((item) => Number(item.id) === Number(rice.id));
    const riceA = Number((await one("SELECT quantity FROM stock_balances WHERE inventory_item_id=$1 AND outlet_id=$2", [rice.id, outletA.id])).quantity);
    assert.equal(riceForA.currentStock, riceA);
    const ledger = await request("GET", `/inventory/movements?itemId=${rice.id}`, undefined, 200, "managerA");
    assert.equal(ledger.items[0].balanceAfter, riceA);
    assert.equal(ledger.items[0].balanceScope, "store");
    const ownerLedger = await request("GET", `/inventory/movements?itemId=${rice.id}`);
    assert.equal(ownerLedger.items[0].balanceScope, "restaurant");

    // Another outlet's purchase order and return are not theirs to change.
    const orderB = await request("POST", "/purchase-orders", { supplierId: supplier.id, poStatus: "ordered", items: [{ inventoryItemId: rice.id, quantity: 2, unitPrice: 50 }] }, 201, "owner", asB);
    await request("PATCH", `/purchase-orders/${orderB.id}/status`, { status: "cancelled", reason: "Not needed" }, 403, "managerA");
    const orderA = await request("POST", "/purchase-orders", { supplierId: supplier.id, poStatus: "ordered", items: [{ inventoryItemId: rice.id, quantity: 2, unitPrice: 50 }] }, 201, "managerA");
    await request("PATCH", `/purchase-orders/${orderA.id}/status`, { status: "cancelled", reason: "Not needed" }, 200, "managerA");
    const billB = await request("POST", "/purchase-orders/receipts", { supplierId: supplier.id, billNumber: "SB-2", lines: [{ inventoryItemId: rice.id, quantity: 2, unitPrice: 50, taxRate: 0 }] }, 201, "owner", asB);
    const returnB = await request("POST", "/purchase-returns", { supplierId: supplier.id, goodsReceiptId: billB.id, reason: "Broken bag", items: [{ inventoryItemId: rice.id, quantity: 1, unitPrice: 40 }] }, 201, "owner", asB);
    await request("PUT", `/purchase-returns/${returnB.id}`, { lines: [{ id: returnB.items[0].id, unitPrice: 30 }], changeReason: "Supplier credited less" }, 403, "managerA");
  });

  await t.test("a guest's erase holds against edits and points", async () => {
    for (let i = 0; i < 4; i += 1) {
      const guest = await request("POST", "/crm/customers", { name: `Race guest ${i}`, mobile: `98480000${10 + i}` }, 201);
      await Promise.all([
        fetch(`${base}/crm/customers/${guest.id}/erase`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.owner}` }, body: JSON.stringify({ reason: "Asked" }) }),
        fetch(`${base}/crm/customers/${guest.id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.owner}` }, body: JSON.stringify({ name: "Restored", mobile: `97480000${10 + i}` }) }),
      ]);
      const row = await one("SELECT name, mobile, erased_at FROM customers WHERE id=$1", [guest.id]);
      assert.ok(row.erased_at, "erased");
      assert.equal(row.mobile, null);
      assert.ok(!row.name.includes("Restored"), row.name);
    }
    const guest = await request("POST", "/crm/customers", { name: "Points guest", mobile: "9848000099" }, 201);
    await request("POST", `/crm/customers/${guest.id}/erase`, { reason: "Asked" });
    await request("PUT", `/crm/customers/${guest.id}`, { name: "Too late" }, 409);
    // A payment that decided its guest before the erase still credits nobody.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await require("../../src/modules/restaurant/crm/repositories/loyalty.repository").recordPoints(client, rid, { customerId: guest.id, points: 5, entryType: "earn", notes: "late" }, owner.id);
      await client.query("COMMIT");
    } finally { client.release(); }
    const after = await one("SELECT loyalty_points, (SELECT COALESCE(SUM(points),0) FROM loyalty_transactions WHERE customer_id=$1)::int AS ledger FROM customers WHERE id=$1", [guest.id]);
    assert.equal(Number(after.loyalty_points), 0);
    assert.equal(Number(after.ledger), 0);
  });

  await t.test("guest insights are masked for a cashier", async () => {
    // A birthday today puts the guest on the birthdays list without a visit
    // (born in a leap year, so the 29th of February is a birthday too).
    const birthday = `1992-${today().slice(5)}`;
    const guest = await request("POST", "/crm/customers", { name: "Masked guest", mobile: "9848012345", dateOfBirth: birthday }, 201);
    const forCashier = await request("GET", `/guest-insights/guests?id=${guest.id}`, undefined, 200, "cashier");
    assert.equal(forCashier.items[0].mobile, null);
    assert.equal(forCashier.items[0].mobileMasked, "XXXXXX2345");
    const forOwner = await request("GET", `/guest-insights/guests?id=${guest.id}`);
    assert.equal(forOwner.items[0].mobile, "9848012345");
    const summary = JSON.stringify(await request("GET", "/guest-insights", undefined, 200, "cashier"));
    assert.ok(!/"mobile":"[0-9+]/.test(summary));

    // A role that may export guest lists but not see contact details gets
    // them masked in the export too, as the guest book's export does.
    const role = await one("INSERT INTO roles (restaurant_id, code, name) VALUES ($1, 'MARKETING', 'Marketing') RETURNING id", [rid]);
    await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code IN ('customers.view','customers.export')", [role.id]);
    const marketer = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,'Marketer','marketer@bo.invalid',$2) RETURNING id", [rid, hash]);
    await pool.query("INSERT INTO user_roles(user_id, role_id) VALUES ($1, $2)", [marketer.id, role.id]);
    tokens.marketer = (await request("POST", "/auth/login", { identifier: "marketer@bo.invalid", password }, 200, null)).token;
    const exported = await request("POST", "/guest-insights/segments/birthdays/export", { format: "csv" }, 200, "marketer");
    const row = exported.items.find((item) => Number(item.id) === Number(guest.id));
    assert.ok(row, "the guest is on the birthdays list");
    assert.equal(row.mobile, null);
    assert.equal(row.mobileMasked, "XXXXXX2345");
    assert.ok(!/"mobile":"[0-9+]/.test(JSON.stringify(exported.items)), "masked export");
    await request("POST", "/guest-insights/segments/birthdays/export", { format: "mobiles" }, 403, "marketer");
    const hidden = await request("POST", "/guest-insights/segments/birthdays/export", { format: "csv", search: "801234" }, 200, "marketer");
    assert.equal(hidden.total, 0, "the hidden middle digits find nobody");
    const full = await request("POST", "/guest-insights/segments/birthdays/export", { format: "csv" });
    assert.equal(full.items.find((item) => Number(item.id) === Number(guest.id)).mobile, "9848012345");
  });
});
