// Billing and payments, end to end on a throwaway database:
// the delivery charge on the bill (its GST, the rate rows, a waiver with a
// manager's PIN), a tip at payment, owner-named payment types, correcting how
// a payment was taken (PIN tied to both methods; nothing but the method
// moves), points going to the guest the order names when the bill is
// locked, advances taken, used on a bill and handed back, the outlet's own
// FSSAI licence and UPI ID on its bills, coupon rules (dishes, days, once per
// guest, buy 2 get 1) and numbers that restart each financial year. Another
// restaurant sees none of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { today: todayIst, weekdayOf } = require("./helpers/dates");

test("billing and payments", { timeout: 600000 }, async (t) => {
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
  const PIN = "5831";

  const made = await restaurantService.createRestaurant({
    name: "Money Cafe",
    code: "MONEYR4",
    invoicePrefix: "MC",
    admin: { name: "Money owner", email: "owner@moneyr4.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Cafe",
    code: "OTHERR4",
    admin: { name: "Other owner", email: "other@moneyr4.invalid", password },
  });

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role, pin) => {
    const row = await one(
      "INSERT INTO users (restaurant_id, name, email, password_hash, pin_hash, pin_set_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [rid, name, email, hash, pin ? await bcrypt.hash(pin, 4) : null, pin ? new Date() : null]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    return Number(row.id);
  };
  await staff("Ravi cashier", "ravi@moneyr4.invalid", "CASHIER");
  const managerId = await staff("Meena manager", "meena@moneyr4.invalid", "MANAGER", PIN);

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
  const owner = await login("owner@moneyr4.invalid");
  const cashier = await login("ravi@moneyr4.invalid");
  const other = await login("other@moneyr4.invalid");
  const O = (method, url, body, expected = 200, headers) => request(method, url, body, expected, owner, headers);
  const C = (method, url, body, expected = 200, headers) => request(method, url, body, expected, cashier, headers);
  const P = (value) => Math.round(Number(value || 0) * 100);
  const approval = async (permission, scope) =>
    (await request("POST", "/auth/approvals", { permission, approverId: managerId, pin: PIN, scope }, 201, cashier)).approvalToken;
  const auditOf = async (action, entityId) => {
    let rows = [];
    for (let tries = 0, last = -1; tries < 15 && rows.length !== last; tries += 1) {
      last = rows.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      rows = await all("SELECT details, approver_name FROM audit_logs WHERE restaurant_id = $1 AND action = $2 AND entity_id = $3 ORDER BY id", [rid, action, entityId]);
    }
    return rows;
  };

  const s0 = await O("GET", "/restaurants/current/settings");
  const settings = {
    ...s0, timezone: "Asia/Kolkata", taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 0,
    invoicePrefix: "MC", gstSplit: true, autoConsumeStock: false, loyaltyEnabled: true, loyaltyEarnAmount: 100,
    loyaltyPointValue: 1, loyaltyMinRedeem: 1, autoPrintBill: false, printShowQr: false,
  };
  await O("PUT", "/restaurants/current/settings", settings);
  const food = (await O("GET", "/menu/tax-rates")).find((r) => r.isDefault);
  const desserts = await O("POST", "/menu/categories", { name: "Desserts" }, 201);
  const mains = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dish = async (name, price, category) => O("POST", "/menu/products", { categoryId: category.id, name, price, taxRateId: food.id, isAvailable: true }, 201);
  const kulfi = await dish("Kulfi", 120, desserts);
  const brownie = await dish("Brownie", 180, desserts);
  const biryani = await dish("Biryani", 320, mains);
  const order = async (token, lines, extra = {}) =>
    request("POST", "/orders", { orderType: "takeaway", ...extra, items: lines.map(([p, quantity]) => ({ productId: p.id, quantity })) }, 201, token);
  const billFor = async (token, orderId) => request("POST", "/bills", { orderId }, 201, token);
  const addsUp = (b) =>
    P(b.subtotal) - P(b.discountAmount) + P(b.serviceCharge) + P(b.deliveryCharge) + P(b.taxAmount) + P(b.roundOff) === P(b.totalAmount) &&
    b.taxes.reduce((s, r) => s + P(r.cgst) + P(r.sgst) + P(r.cess), 0) === P(b.taxAmount) &&
    b.taxes.every((r) => P(r.taxableValue) === P(r.itemsTaxable) + P(r.serviceChargeTaxable) + P(r.deliveryChargeTaxable));

  await O("POST", "/business-day/open", { openingCash: 1000 }, 201);

  await t.test("the delivery charge is a line of the bill, taxed with the food, waived with a PIN", async () => {
    const own = (await O("GET", "/deliveries/channels")).find((c) => c.type === "own");
    await O("PUT", `/deliveries/channels/${own.id}`, { name: own.name, type: own.type, deliveryCharge: 40, deliveryFreeAbove: 999 });
    const o = await order(owner, [[kulfi, 2]], { orderType: "delivery", customerName: "Door" });
    const b = await billFor(owner, o.id);
    assert.equal(b.deliveryCharge, 40);
    assert.equal(b.deliveryChargeTax, 2);
    assert.equal(b.totalAmount, 294);
    assert.ok(addsUp(b), JSON.stringify(b.taxes));
    const asked = await C("POST", `/bills/${b.id}/adjust/check`, { deliveryCharge: { waive: true, reason: "Late" } });
    assert.equal(asked.approval.permission, "orders.waive_delivery_charge");
    const token = await approval("orders.waive_delivery_charge", asked.approval.scope);
    const waived = await C("PATCH", `/bills/${b.id}/adjust`, { deliveryCharge: { waive: true, reason: "Late" } }, 200, { "X-Approval-Token": token });
    assert.equal(waived.totalAmount, 252);
    assert.equal((await auditOf("waive_delivery_charge", b.id))[0].approver_name, "Meena manager");
    assert.equal((await O("PATCH", `/bills/${b.id}/adjust`, { deliveryCharge: { waive: false } })).totalAmount, 294);

    // A composite supply: the whole charge follows the principal dish's rate
    // (the biggest line, 5% food), not the 18% drink beside it.
    const r18 = await O("POST", "/menu/tax-rates", { name: "GST 18", percentage: 18, cessPercentage: 0 }, 201);
    const cooler = await O("POST", "/menu/products", { categoryId: mains.id, name: "Cooler", price: 100, taxRateId: (r18.data || r18).id, isAvailable: true }, 201);
    const mixed = await billFor(owner, (await order(owner, [[biryani, 1], [cooler, 1]], { orderType: "delivery", customerName: "Door 2" })).id);
    const at5 = mixed.taxes.find((row) => row.taxPercentage === 5);
    const at18 = mixed.taxes.find((row) => row.taxPercentage === 18);
    assert.equal(at5.deliveryChargeTaxable, 40);
    assert.equal(at18.deliveryChargeTaxable, 0);
    assert.equal(mixed.deliveryChargeTax, 2);
    assert.ok(addsUp(mixed), JSON.stringify(mixed.taxes));
  });

  let cashPay;
  let cashBill;
  await t.test("a tip rides on the payment; the bill, GST and sales do not change", async () => {
    cashBill = await billFor(cashier, (await order(cashier, [[biryani, 1]])).id);
    const paid = await C("POST", `/bills/${cashBill.id}/payments`, { paymentMethod: "cash", amount: 336, tenderedAmount: 500, tipAmount: 50 }, 201);
    cashPay = paid.payments[0];
    assert.equal(cashPay.tipAmount, 50);
    assert.equal(cashPay.changeAmount, 114);
    assert.equal(paid.totalAmount, 336);
    assert.equal(paid.tipTotal, 50);
    const summary = await O("GET", "/bills/day-summary");
    assert.equal(summary.tips, 50);
  });

  await t.test("correcting how a payment was taken: PIN tied to both methods, only the method moves", async () => {
    const b = await billFor(cashier, (await order(cashier, [[biryani, 1]])).id);
    const pay = (await C("POST", `/bills/${b.id}/payments`, { paymentMethod: "cash", amount: 336 }, 201)).payments[0];
    const before = await O("GET", "/bills/day-summary");
    const asked = await call("PATCH", `/bills/${b.id}/payments/${pay.id}`, { paymentMethod: "upi", transactionRef: "UTR9", reason: "Paid by GPay" }, cashier);
    assert.equal(asked.status, 403);
    assert.deepEqual(asked.body.data.scope, { amount: 336, billId: b.id, fromMethod: "cash", paymentId: pay.id, toMethod: "upi" });
    const wrong = await approval("bills.payment_correct", { ...asked.body.data.scope, toMethod: "card" });
    assert.equal((await call("PATCH", `/bills/${b.id}/payments/${pay.id}`, { paymentMethod: "upi", reason: "Paid by GPay" }, cashier, { "X-Approval-Token": wrong })).status, 403);
    const token = await approval("bills.payment_correct", asked.body.data.scope);
    const fixed = await C("PATCH", `/bills/${b.id}/payments/${pay.id}`, { paymentMethod: "upi", transactionRef: "UTR9", reason: "Paid by GPay" }, 200, { "X-Approval-Token": token });
    assert.equal(fixed.payments[0].paymentMethod, "upi");
    assert.equal(fixed.totalAmount, 336);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM credit_notes WHERE bill_id = $1", [b.id])).n, 0);
    const after = await O("GET", "/bills/day-summary");
    const m = (s, k) => P((s.byMethod.find((r) => r.paymentMethod === k) || {}).amount);
    assert.equal(m(after, "cash"), m(before, "cash") - 33600);
    assert.equal(m(after, "upi"), m(before, "upi") + 33600);
    assert.equal(P(after.salesTotal), P(before.salesTotal));
    const log = await auditOf("payment_corrected", b.id);
    assert.equal(log[0].approver_name, "Meena manager");
    assert.equal(log[0].details.from, "cash");
    const listed = await O("GET", "/bills/payment-corrections");
    assert.equal(listed.total, 1);
    // Cash that gave change stays cash.
    const change = await call("PATCH", `/bills/${cashBill.id}/payments/${cashPay.id}`, { paymentMethod: "card", reason: "x" }, owner);
    assert.equal(change.status, 400);
    assert.equal((await call("PATCH", `/bills/${b.id}/payments/${pay.id}`, { paymentMethod: "cash", reason: "x" }, other)).status, 404);
  });

  await t.test("payment types: named under a method, reference when needed, kept apart in the day", async () => {
    const pluxee = await O("POST", "/restaurants/current/payment-types", { paymentMethod: "other", name: "Pluxee", needsReference: true }, 201);
    await request("POST", "/restaurants/current/payment-types", { paymentMethod: "upi", name: "X", needsReference: false }, 403, cashier);
    const b = await billFor(cashier, (await order(cashier, [[kulfi, 1]])).id);
    await C("POST", `/bills/${b.id}/payments`, { paymentMethod: "other", amount: 126, paymentTypeId: pluxee.id }, 400);
    await C("POST", `/bills/${b.id}/payments`, { paymentMethod: "card", amount: 126, paymentTypeId: pluxee.id, transactionRef: "1" }, 400);
    const paid = await C("POST", `/bills/${b.id}/payments`, { paymentMethod: "other", amount: 126, paymentTypeId: pluxee.id, transactionRef: "PX1" }, 201);
    assert.equal(paid.payments[0].paymentTypeName, "Pluxee");
    assert.ok((await O("GET", "/bills/day-summary")).byType.some((row) => row.paymentTypeId === pluxee.id && row.amount === 126));
    await O("DELETE", `/restaurants/current/payment-types/${pluxee.id}`, undefined, 409);
    await request("PUT", `/restaurants/current/payment-types/${pluxee.id}`, { name: "Hack", needsReference: false }, 404, other);
  });

  let guest;
  await t.test("points go to the guest the order names with the bill locked", async () => {
    guest = await O("POST", "/crm/customers", { name: "Anita", mobile: "9876500011" }, 201);
    const o = await order(owner, [[biryani, 1]]);
    const b = await billFor(owner, o.id);
    await pool.query("UPDATE orders SET customer_id = $2 WHERE id = $1", [o.id, guest.id]);
    await O("POST", `/bills/${b.id}/payments`, { paymentMethod: "cash", amount: b.totalAmount }, 201);
    assert.equal((await one("SELECT COALESCE(SUM(points),0)::int AS p FROM loyalty_transactions WHERE customer_id = $1 AND entry_type = 'earn'", [guest.id])).p, 3);
    const erased = await O("POST", "/crm/customers", { name: "Gone", mobile: "9876500012" }, 201);
    const o2 = await order(owner, [[biryani, 1]], { customerId: erased.id });
    const b2 = await billFor(owner, o2.id);
    await pool.query("UPDATE orders SET customer_id = NULL WHERE id = $1", [o2.id]);
    await O("POST", `/bills/${b2.id}/payments`, { paymentMethod: "cash", amount: b2.totalAmount }, 201);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM loyalty_transactions WHERE customer_id = $1", [erased.id])).n, 0);
  });

  await t.test("an advance: taken, used on the bill, the rest handed back with a PIN", async () => {
    const company = await O("POST", "/crm/customers", { name: "Party", mobile: "9876500013", companyName: "Events Co" }, 201);
    const adv = (await call("POST", "/bills/advances", { customerId: company.id, amount: 1000, paymentMethod: "cash", purpose: "Party" }, cashier)).body.data;
    assert.match(adv.receiptNumber, /^ADV-0001$/);
    const b = await billFor(cashier, (await order(cashier, [[biryani, 2]], { customerId: company.id })).id);
    const used = await C("POST", `/bills/${b.id}/payments`, { paymentMethod: "advance", amount: 672, advanceId: adv.id }, 201);
    assert.equal(used.billStatus, "paid");
    assert.equal((await O("GET", `/bills/advances/${adv.id}`)).heldAmount, 328);
    assert.equal((await O("GET", `/bills/accounts/${company.id}/statement`)).advances.held, 328);
    const asked = await call("POST", `/bills/advances/${adv.id}/refunds`, { amount: 328, refundMethod: "cash", reason: "Cancelled" }, cashier);
    assert.equal(asked.status, 403);
    const token = await approval("advances.refund", asked.body.data.scope);
    const back = (await call("POST", `/bills/advances/${adv.id}/refunds`, { amount: 328, refundMethod: "cash", reason: "Cancelled" }, cashier, { "X-Approval-Token": token })).body.data;
    assert.equal(back.heldAmount, 0);
    const summary = await O("GET", "/bills/day-summary");
    assert.equal(summary.cashAdvances, 1000);
    assert.equal(summary.cashAdvancesReturned, 328);
    // Another restaurant: our advance does not exist for it, whatever it tries.
    assert.equal((await call("GET", `/bills/advances/${adv.id}`, undefined, other)).status, 404);
    assert.equal((await call("POST", `/bills/advances/${adv.id}/refunds`, { amount: 1, refundMethod: "cash", reason: "x" }, other)).status, 404);
    assert.deepEqual((await call("GET", `/bills/advances/held/${company.id}`, undefined, other)).body.data, []);
    assert.equal((await call("POST", "/bills/advances", { customerId: company.id, amount: 10, paymentMethod: "cash" }, other)).status, 404);
    assert.equal((await call("GET", "/bills/advances?status=all", undefined, other)).body.data.total, 0);
    assert.equal((await call("GET", "/bills/payment-corrections", undefined, other)).body.data.total, 0);
    assert.equal((await call("GET", "/restaurants/current/payment-types", undefined, other)).body.data.length, 0);
    assert.equal((await call("POST", `/bills/${b.id}/payments`, { paymentMethod: "advance", amount: 1, advanceId: adv.id }, other)).status, 404);
  });

  await t.test("the outlet's own FSSAI licence and UPI ID; checked; kept on reprints", async () => {
    const outlet = await O("POST", "/outlets", { name: "Beach Road", code: "BR", fssaiNumber: "10019022000123", upiVpa: "beach@okicici" }, 201);
    assert.equal(outlet.fssai_number, "10019022000123");
    await O("PUT", `/outlets/${outlet.id}`, { name: "Beach Road", code: "BR", fssaiNumber: "123" }, 400);
    await O("PUT", "/restaurants/current/settings", { ...settings, upiVpa: "money@okhdfcbank", upiPayeeName: "Money Cafe" });
    await O("PUT", "/restaurants/current/settings", { ...settings, upiVpa: "nope" }, 400);
    const b = await billFor(owner, (await order(owner, [[kulfi, 1]])).id);
    assert.deepEqual(b.upi, { vpa: "money@okhdfcbank", payeeName: "Money Cafe" });
    const series = await O("GET", "/restaurants/current/invoice-series");
    assert.equal(series.find((row) => row.outletId === outlet.id).example, "MC-BR-0001");
  });

  await t.test("coupon rules: chosen dishes, days, once per guest, buy 2 get 1", async () => {
    await O("POST", "/discounts", { code: "SWEET20", name: "Desserts", discountType: "percentage", value: 20, categoryIds: [desserts.id] }, 201);
    const b = await billFor(owner, (await order(owner, [[kulfi, 1], [biryani, 1]])).id);
    const applied = await O("PATCH", `/bills/${b.id}/adjust`, { discountCode: "SWEET20" });
    assert.equal(applied.couponDiscount, 24);
    assert.ok(addsUp(applied));
    const mainsOnly = await billFor(owner, (await order(owner, [[biryani, 1]])).id);
    const refused = await call("PATCH", `/bills/${mainsOnly.id}/adjust`, { discountCode: "SWEET20" }, owner);
    assert.equal(refused.status, 400);
    const today = weekdayOf(todayIst());
    await O("POST", "/discounts", { code: "LATER", name: "x", discountType: "percentage", value: 5, weekdays: [(today + 3) % 7] }, 201);
    assert.match((await call("PATCH", `/bills/${mainsOnly.id}/adjust`, { discountCode: "LATER" }, owner)).body.message, /runs on/);
    await O("POST", "/discounts", { code: "ONCE", name: "Welcome", discountType: "amount", value: 50, oncePerGuest: true }, 201);
    const g1 = await billFor(owner, (await order(owner, [[biryani, 1]], { customerId: guest.id })).id);
    await O("PATCH", `/bills/${g1.id}/adjust`, { discountCode: "ONCE" });
    const g2 = await billFor(owner, (await order(owner, [[biryani, 1]], { customerId: guest.id })).id);
    assert.equal((await call("PATCH", `/bills/${g2.id}/adjust`, { discountCode: "ONCE" }, owner)).status, 400);
    await O("POST", "/discounts", { code: "B2G1", name: "Buy 2 get 1", offerType: "buy_get", buyQuantity: 2, getQuantity: 1, getDiscountPercent: 100, productIds: [kulfi.id, brownie.id] }, 201);
    const three = await billFor(owner, (await order(owner, [[kulfi, 1], [brownie, 2]])).id);
    const free = await O("PATCH", `/bills/${three.id}/adjust`, { discountCode: "B2G1" });
    assert.equal(free.couponDiscount, 120);
    assert.ok(addsUp(free));
  });

  await t.test("numbers that restart each financial year, for bills and credit notes", async () => {
    await O("PUT", "/restaurants/current/settings", { ...settings, invoicePrefix: "MONEY", invoiceNumbering: "financial_year" }, 400);
    await O("PUT", "/restaurants/current/settings", { ...settings, invoiceNumbering: "financial_year" });
    const b = await billFor(owner, (await order(owner, [[kulfi, 1]])).id);
    assert.match(b.billNumber, /^MC\/\d{2}-\d{2}\/0001$/);
    await O("POST", `/bills/${b.id}/payments`, { paymentMethod: "cash", amount: b.totalAmount }, 201);
    const refunded = await call("POST", `/bills/${b.id}/refunds`, { amount: 10, refundMethod: "cash", reason: "Cold" }, owner);
    assert.match(refunded.body.data.creditNotes[0].number, /^CN\/\d{2}-\d{2}\/0001$/);
    await O("PUT", "/restaurants/current/settings", { ...settings, invoiceNumbering: "continuous" });
    const next = await billFor(owner, (await order(owner, [[kulfi, 1]])).id);
    assert.match(next.billNumber, /^MC-\d{4}$/);
  });
});
