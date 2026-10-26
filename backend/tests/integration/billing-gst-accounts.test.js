// Billing, reports and guest accounts, end to end on a throwaway database:
// a restaurant made the supported way (with its defaults), bill numbers that
// stay unique across outlets, the GST pack filing the bills' own GST (service
// charge at the food's real rates, cess apart, only real credit notes), each
// outlet's own business day on the Bills screen and the day-end sheet, cash
// paid to suppliers from the till, theft control at a branch, and bills put
// on a company's account and collected.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { signIn } = require("./helpers/signIn");

test("billing, reports and guest accounts", { timeout: 600000 }, async (t) => {
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

  let rid;
  await t.test("a restaurant made the supported way starts with every default, tax rates first", async () => {
    const made = await restaurantService.createRestaurant({
      name: "Test Cafe",
      code: "TCAFE",
      invoicePrefix: "TC",
      admin: { name: "Test owner", email: "owner@cash.invalid", password },
    });
    rid = made.id;
    const rates = await all("SELECT percentage, hsn_code, is_default FROM tax_rates WHERE restaurant_id = $1 ORDER BY percentage", [rid]);
    assert.deepEqual(rates.map((r) => Number(r.percentage)), [0, 5, 18, 40]);
    const def = rates.find((r) => r.is_default);
    assert.equal(Number(def.percentage), 5);
    assert.equal(def.hsn_code, "996331");
    assert.equal(made.defaults.channels, 5);
    assert.equal(made.defaults.stations, 1);
    assert.equal(made.defaults.settings, 1);
    await assert.rejects(
      restaurantService.createRestaurant({ name: "Again", code: "tcafe", admin: { name: "x", email: "x@cash.invalid", password } }),
      /already exists/
    );
    assert.equal(Number((await one("SELECT count(*) AS n FROM users WHERE email = 'x@cash.invalid'")).n), 0);
  });

  const other = await restaurantService.createRestaurant({
    name: "Other Cafe",
    code: "OTHER",
    admin: { name: "Other owner", email: "other@cash.invalid", password },
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
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result.data;
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const owner = await login("owner@cash.invalid");
  const O = (method, url, body, expected = 200, headers = {}) => request(method, url, body, expected, owner, headers);
  const H = (id) => (id ? { "X-Outlet-Id": String(id) } : {});
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

  // Settings, rates, dishes, a table, two outlets with no invoice prefix of
  // their own, and a day open at each.
  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0, timezone: "Asia/Kolkata", taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 10,
    orderPrefix: "TO", invoicePrefix: "TC", gstNumber: "37AABCR1234K1ZG", fssaiNumber: "10124999000777",
    gstSplit: true, autoConsumeStock: false, loyaltyEnabled: true, loyaltyEarnAmount: 100, loyaltyPointValue: 1,
    loyaltyMinRedeem: 1, autoPrintBill: false, printShowQr: false, serviceChargeOrderTypes: ["dine_in"],
  });
  const rates = await O("GET", "/menu/tax-rates");
  const food = rates.find((r) => r.isDefault);
  const drinks = await O("POST", "/menu/tax-rates", { name: "Drinks 18%", percentage: 18, hsnCode: "2202" }, 201);
  const aerated = await O("POST", "/menu/tax-rates", { name: "Aerated 5% + 1% cess", percentage: 5, hsnCode: "2202", cessPercentage: 1 }, 201);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dish = async (name, price, rate) =>
    O("POST", "/menu/products", { categoryId: category.id, name, price, taxRateId: rate.id, isAvailable: true }, 201);
  const paneer = await dish("Paneer Tikka", 285, food);
  const soda = await dish("Lime Soda", 90, drinks);
  const cola = await dish("Craft Cola", 300, aerated);
  const floor = await O("POST", "/tables/floors", { name: "Ground" }, 201);
  const tables = [];
  for (let i = 1; i <= 4; i += 1) tables.push((await O("POST", "/tables", { floorId: floor.id, tableNo: `T${i}`, capacity: 4 }, 201)).id);
  const mainDay = await O("POST", "/business-day/open", { openingCash: 2000 }, 201);
  const D = mainDay.businessDate;
  const A = (await O("POST", "/outlets", { name: "Beach Road", code: "BEACH" }, 201)).id;
  const B = (await O("POST", "/outlets", { name: "MVP Colony", code: "MVP" }, 201)).id;
  const dayA = await O("POST", "/business-day/open", { openingCash: 1000 }, 201, H(A));
  const dayB = await O("POST", "/business-day/open", { openingCash: 700 }, 201, H(B));
  const order = async (items, extra = {}, headers = {}) =>
    O("POST", "/orders", { orderType: "takeaway", ...extra, items: items.map(([p, quantity]) => ({ productId: p.id, quantity })) }, 201, headers);
  const bill = async (orderId, headers = {}) => O("POST", "/bills", { orderId }, 201, headers);
  const pay = async (b, method = "cash", headers = {}) =>
    O("POST", `/bills/${b.id}/payments`, { paymentMethod: method, amount: b.dueAmount }, 201, headers);

  await t.test("tills at the main counter and two outlets billing at once never share a bill number", async () => {
    const where = [null, null, A, A, B, B];
    const orders = [];
    for (const w of where) orders.push(await order([[paneer, 1]], {}, H(w)));
    const bills = await Promise.all(orders.map((o, i) => bill(o.id, H(where[i]))));
    const numbers = bills.map((b) => b.billNumber);
    assert.equal(new Set(numbers).size, 6);
    assert.deepEqual([...new Set(numbers.map((n) => n.replace(/-\d+$/, "")))].sort(), ["TC", "TC-BEACH", "TC-MVP"]);
    for (const b of bills) await pay(b, "cash", H(b.outletId));
  });

  let mixed;
  await t.test("the GST pack files the bills' own GST: service charge at the food's rates, cess apart", async () => {
    const o = await order([[paneer, 1], [soda, 2]], { orderType: "dine_in", tableId: tables[0], guestCount: 2 });
    mixed = await pay(await bill(o.id));
    await pay(await bill((await order([[cola, 2]])).id));
    const pack = await O("GET", `/reports/gst?from=${D}&to=${D}`);
    const rates = new Set(pack.b2c.rows.map((r) => Number(r.rate)));
    assert.deepEqual([...rates].sort((a, b) => a - b), [5, 18]);
    const stored = await all(
      `SELECT bt.tax_percentage::float AS rate, SUM(bt.taxable_value)::float AS taxable, SUM(bt.cgst_amount)::float AS cgst,
              SUM(bt.cess_amount)::float AS cess
       FROM bill_taxes bt JOIN bills b ON b.id = bt.bill_id WHERE b.restaurant_id = $1 AND b.bill_status <> 'void' GROUP BY 1`,
      [rid]
    );
    for (const row of stored) {
      const b2c = pack.b2c.rows.find((r) => Number(r.rate) === row.rate);
      assert.ok(near(b2c.taxableValue, row.taxable) && near(b2c.cgst, row.cgst) && near(b2c.cess, row.cess), JSON.stringify([b2c, row]));
    }
    const sc18 = pack.hsn.rows.find((r) => /service charge/i.test(r.description) && Number(r.rate) === 18);
    assert.ok(sc18 && near(sc18.taxableValue, 18), JSON.stringify(pack.hsn.rows));
    assert.ok(near(pack.registerTotals.cess, 6));
    const colaHsn = pack.hsn.rows.find((r) => r.hsnCode === "2202" && Number(r.rate) === 5);
    assert.equal(colaHsn.description, "Aerated 5% + 1% cess");
    assert.ok(pack.checks.every((c) => c.ok), JSON.stringify(pack.checks));
  });

  await t.test("only real credit notes are filed, with exactly their own GST", async () => {
    const b = await bill((await order([[paneer, 1]])).id);
    await O("POST", `/bills/${b.id}/payments`, { paymentMethod: "upi", amount: 50 }, 201);
    await O("POST", `/bills/${b.id}/refunds`, { amount: 50, refundMethod: "upi", reason: "Wrong card" }, 201);
    await O("PATCH", `/bills/${b.id}/void`, { reason: "Raised by mistake" });
    const line = mixed.items.find((i) => i.itemName === "Lime Soda");
    await O("POST", `/bills/${mixed.id}/refunds`, { amount: line.returnValue, refundMethod: "cash", reason: "Too sweet", items: [{ orderItemId: line.orderItemId, quantity: 1 }] }, 201);
    const pack = await O("GET", `/reports/gst?from=${D}&to=${D}`);
    assert.equal(pack.creditNotes.rows.length, 1);
    const cn = await one("SELECT credit_note_number, tax_amount::float AS tax FROM credit_notes WHERE bill_id = $1", [mixed.id]);
    assert.equal(pack.creditNotes.rows[0].creditNoteNumber, cn.credit_note_number);
    assert.ok(near(pack.creditNotes.rows[0].taxAmount, cn.tax));
  });

  await t.test("discounts: points redeemed are their own row, never 'Manual'", async () => {
    const guest = await O("POST", "/crm/customers", { name: "Lakshmi", mobile: "9876500011" }, 201);
    await pool.query("UPDATE customers SET loyalty_points = 100 WHERE id = $1", [guest.id]);
    const b = await bill((await order([[paneer, 1]], { customerId: guest.id })).id);
    await pay(await O("PATCH", `/bills/${b.id}/adjust`, { loyaltyPoints: 20 }));
    const report = await O("GET", `/reports/discounts?from=${D}&to=${D}`);
    const points = report.rows.find((r) => r.kind === "points");
    assert.ok(points && near(points.discountTotal, 20));
    assert.ok(!report.rows.some((r) => r.discountCode === "Manual"));
  });

  await t.test("each outlet's own day: Bills screen figures, day-end sheet, till supplier cash and short closes", async () => {
    const supplier = await O("POST", "/suppliers", { name: "Veg Supplier", status: "active" }, 201);
    await O("POST", "/purchase-returns/payments", { supplierId: supplier.id, amount: 350, paymentMethod: "cash", paidFromTill: true }, 201);
    const summaryA = await O("GET", "/bills/day-summary", undefined, 200, H(A));
    const billsA = await one("SELECT count(*)::int AS n FROM bills WHERE business_day_id = $1 AND bill_status <> 'void'", [dayA.id]);
    assert.equal(Number(summaryA.businessDayId), Number(dayA.id));
    assert.equal(summaryA.billCount, billsA.n);
    const sheetA = await O("GET", `/reports/day-end?businessDate=${D}`, undefined, 200, H(A));
    assert.equal(Number(sheetA.businessDayId), Number(dayA.id));
    assert.equal(sheetA.wholeDrawer, true);
    assert.ok(near(sheetA.openingCash, 1000));
    const all3 = await O("GET", `/reports/day-end?businessDate=${D}`);
    assert.equal(all3.drawers.length, 3);
    const main = all3.drawers.find((d) => !d.outletId);
    assert.ok(near(main.supplierCash, 350));
    assert.ok(near(main.expectedCash, main.openingCash + main.cashSales - main.cashRefunds - main.cashExpenses - 350));
    const sheetB = await O("GET", `/reports/day-end?businessDate=${D}`, undefined, 200, H(B));
    const shortCount = Math.round((sheetB.expectedCash - 500) * 100) / 100;
    // A short drawer beyond the allowed difference needs a reason before it closes.
    await O("POST", "/business-day/close", { closingCash: shortCount }, 400, H(B));
    await O("POST", "/business-day/close", { closingCash: shortCount, varianceReason: "Test: ₹500 missing at count" }, 200, H(B));
    const theft = await O("GET", `/reports/theft?from=${D}&to=${D}`);
    const short = theft.cashShort.find((r) => Number(r.businessDayId) === Number(dayB.id));
    assert.ok(short && near(short.difference, -500), JSON.stringify(theft.cashShort));
  });

  await t.test("a pinned cashier cannot make another outlet's bill a B2B invoice", async () => {
    const hash = await bcrypt.hash(password, 4);
    const cashier = await one(
      "INSERT INTO users (restaurant_id, outlet_id, name, email, password_hash) VALUES ($1, $2, 'Beach cashier', 'beach@cash.invalid', $3) RETURNING id",
      [rid, A, hash]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'CASHIER' AND restaurant_id IS NULL", [cashier.id]);
    const token = await login("beach@cash.invalid");
    const elsewhere = await one("SELECT id FROM bills WHERE restaurant_id = $1 AND outlet_id IS NULL AND bill_status = 'paid' LIMIT 1", [rid]);
    await request("PUT", `/reports/gst/bills/${elsewhere.id}/recipient`, { gstin: "29AAGCB7383J1Z4", legalName: "Leak Pvt Ltd" }, 404, token);
    const chk = await request("POST", `/bills/${mixed.id}/adjust/check`, { discountCode: null }, 404, token);
    assert.equal(chk, undefined);
  });

  await t.test("a bill on a company's account, within its limit, collected later into today's day", async () => {
    const company = await O("POST", "/crm/customers", { name: "Bluewave", mobile: "9876500022", companyName: "Bluewave Tech" }, 201);
    const b = await bill((await order([[paneer, 2]], { orderType: "dine_in", tableId: tables[1], guestCount: 2, customerId: company.id })).id);
    await O("PATCH", `/bills/${b.id}/account`, { customerId: company.id }, 400);
    await O("PUT", `/bills/accounts/${company.id}`, { creditLimit: 1000, creditDays: 30 });
    const onAccount = await O("PATCH", `/bills/${b.id}/account`, { customerId: company.id, note: "Monthly" });
    assert.equal(Number(onAccount.accountCustomerId), Number(company.id));
    assert.equal((await one("SELECT table_status FROM dining_tables WHERE id = $1", [tables[1]])).table_status, "available");
    await O("PATCH", `/bills/${b.id}/void`, { reason: "Wrong bill" }, 409);
    const second = await bill((await order([[paneer, 2]])).id);
    await O("PATCH", `/bills/${second.id}/account`, { customerId: company.id }, 400);
    const dues = await O("GET", "/bills/accounts/dues");
    const row = dues.accounts.find((r) => Number(r.customerId) === Number(company.id));
    assert.ok(near(row.outstanding, b.totalAmount) && near(row.ageing.current, b.totalAmount));
    await O("POST", `/bills/accounts/${company.id}/collect`, { amount: b.totalAmount + 1, paymentMethod: "cash" }, 400);
    await O("POST", `/bills/accounts/${company.id}/collect`, { amount: b.totalAmount, paymentMethod: "upi" }, 201);
    const payment = await one("SELECT business_day_id FROM payments WHERE bill_id = $1", [b.id]);
    assert.equal(Number(payment.business_day_id), Number(mainDay.id));
    const statement = await O("GET", `/bills/accounts/${company.id}/statement`);
    assert.equal(statement.entries.length, 2);
    assert.ok(near(statement.closingBalance, 0));
    const foreign = await login("other@cash.invalid");
    await request("GET", `/bills/accounts/${company.id}/statement`, undefined, 404, foreign);
    await request("PUT", `/bills/accounts/${company.id}`, { creditLimit: 5 }, 404, foreign);
    assert.equal(Number(other.id) > 0, true);
    await pay(second);
  });

  await t.test("an outlet's worked-out invoice series keeps bill numbers within GST's 16 characters", async () => {
    const C = (await O("POST", "/outlets", { name: "MVP Colony Visakha", code: "MVP COLONY VISAKHA" }, 201)).id;
    await O("POST", "/business-day/open", { openingCash: 0 }, 201, H(C));
    const b = await pay(await bill((await order([[paneer, 1]], {}, H(C))).id, H(C)), "cash", H(C));
    assert.ok(b.billNumber.length <= 16 && /^[A-Z0-9/-]+$/.test(b.billNumber), b.billNumber);
    const series = await O("GET", "/restaurants/current/invoice-series");
    const row = series.find((r) => Number(r.outletId) === Number(C));
    assert.equal(row.example, `${b.billNumber.replace(/-\d+$/, "")}-0001`);
    assert.ok(series.every((r) => r.example.length <= 16));
    await O("PUT", "/restaurants/current/settings", { ...s0, invoicePrefix: "TC 1#" }, 400);
    assert.equal((await O("GET", "/restaurants/current/settings")).invoicePrefix, "TC");
  });

  await t.test("a branch's own day is named for the branch; a dayless outlet's bill can be paid", async () => {
    const summary = await O("GET", "/bills/day-summary", undefined, 200, H(A));
    assert.equal(summary.days[0].outletName, "Beach Road");
    const F = (await O("POST", "/outlets", { name: "Kiosk", code: "KIOSK" }, 201)).id;
    const b = await bill((await order([[paneer, 1]])).id, H(F));
    assert.equal(Number(b.outletId), Number(F));
    await pay(b, "cash", H(F));
    const payment = await one("SELECT business_day_id FROM payments WHERE bill_id = $1", [b.id]);
    assert.equal(Number(payment.business_day_id), Number(mainDay.id));
  });

  await t.test("an account's limit holds after a bill went on it; collections go into the collecting till's day", async () => {
    const guest = await O("POST", "/crm/customers", { name: "Arjun", mobile: "9876500033" }, 201);
    await O("PUT", `/bills/accounts/${guest.id}`, { creditLimit: 450, creditDays: 15 });
    // ₹599 of paneer at 50% off: ₹299 on a ₹450 account.
    const b = await bill((await order([[paneer, 2]], { customerId: guest.id })).id);
    await O("PATCH", `/bills/${b.id}/adjust`, { manualDiscount: { type: "percentage", value: 50 }, discountReason: "regular" });
    await O("PATCH", `/bills/${b.id}/account`, { customerId: guest.id });
    // Taking the discount off would make it ₹599: the check (before any PIN)
    // says it would be refused, and the change itself is refused.
    const check = await O("POST", `/bills/${b.id}/adjust/check`, { manualDiscount: null, itemDiscounts: [] });
    assert.equal(check.refused.reason, "credit_limit");
    await O("PATCH", `/bills/${b.id}/adjust`, { manualDiscount: null, itemDiscounts: [] }, 400);
    const dues = await O("GET", "/bills/accounts/dues");
    assert.ok(dues.accounts.find((r) => Number(r.customerId) === Number(guest.id)).outstanding <= 450);
    // A Beach Road bill on the account, collected at the main counter.
    const beach = await bill((await order([[soda, 1]], {}, H(A))).id, H(A));
    await O("PATCH", `/bills/${beach.id}/account`, { customerId: guest.id }, 200, H(A));
    const owed = (await O("GET", "/bills/accounts/dues")).accounts.find((r) => Number(r.customerId) === Number(guest.id)).outstanding;
    await O("POST", `/bills/accounts/${guest.id}/collect`, { amount: owed, paymentMethod: "cash" }, 201);
    const days = await all("SELECT DISTINCT business_day_id FROM payments WHERE bill_id = ANY($1::bigint[])", [[b.id, beach.id]]);
    assert.deepEqual(days.map((d) => Number(d.business_day_id)), [Number(mainDay.id)]);
    const book = await O("GET", `/reports/day-book?from=${D}&to=${D}`);
    const party = `Arjun (account ${guest.id})`;
    assert.ok(book.vouchers.some((v) => v.type === "Sales" && v.party === party && v.number === beach.billNumber));
    assert.ok(book.vouchers.some((v) => v.type === "Receipt" && v.party === party && near(v.amount, owed)));
    assert.equal(book.totals.unbalanced, 0);
  });

  await t.test("a company guest's address is frozen onto their tax invoice", async () => {
    const address = "8-2-293 Road No 12, Banjara Hills, Hyderabad";
    const company = await O("POST", "/crm/customers", { name: "Suresh", mobile: "9876500044", companyName: "Godavari Traders", gstin: "36AAGCG7383J1Z4", address }, 201);
    const b = await bill((await order([[paneer, 1]], { customerId: company.id })).id);
    assert.equal(b.buyer.address, address);
    await pool.query("UPDATE customers SET address = 'Elsewhere' WHERE id = $1", [company.id]);
    assert.equal((await O("GET", `/bills/${b.id}`)).buyer.address, address);
    await pay(b);
  });

  await t.test("an older bill (no stored GST rows) files its service charge at its food's real rates", async () => {
    const o = await order([[paneer, 1], [soda, 2]], { orderType: "dine_in", tableId: tables[2], guestCount: 2 });
    const b = await pay(await bill(o.id));
    await pool.query("DELETE FROM bill_taxes WHERE bill_id = $1", [b.id]);
    const pack = await O("GET", `/reports/gst?from=${D}&to=${D}`);
    const rates = new Set([...pack.b2c.rows, ...pack.hsn.rows].map((r) => Number(r.rate)));
    assert.deepEqual([...rates].sort((x, y) => x - y), [5, 18]);
    assert.ok(pack.checks.every((c) => c.ok), JSON.stringify(pack.checks));
    const reprint = await O("GET", `/bills/${b.id}`);
    assert.deepEqual(reprint.taxes.map((x) => x.taxPercentage), [5, 18]);
    assert.ok(near(reprint.taxes.reduce((sum, x) => sum + x.taxAmount, 0), reprint.taxAmount));
  });
});
