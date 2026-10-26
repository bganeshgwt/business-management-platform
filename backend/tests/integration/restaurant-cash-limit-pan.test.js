// The cash limit and the buyer's PAN at a restaurant, end to end on a
// throwaway database. Cash of ₹2,00,000 or more is never taken for one bill
// (its cash payments with their cash tips, and what it took from an advance
// paid in cash), or from one guest on one day of the restaurant's calendar
// (cash on the bills that name them, their advances in cash, cash collected
// on their account, cash on delivery), whichever path takes it: a payment, a
// correction to cash, an advance, a collection on an account, a rider's
// settlement, a pre-order's advance, or a row written straight to the
// database (Income-tax Act 2025, section 186). A walk-in bill is limited per
// bill only. A bill over ₹2,00,000 takes no payment until the buyer's PAN, or
// their Form 97 declaration, is on it: typed with the payment, recorded on
// the bill, given when it is raised, or read from the buyer's GSTIN; a split
// bill is checked on each bill; the PAN prints. Another restaurant sees none
// of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { addDays, momentAt, today, zoneWithHour } = require("./helpers/dates");
const { signIn } = require("./helpers/signIn");

test("restaurant: the cash limit and the buyer's PAN", { timeout: 600000 }, async (t) => {
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
  // The restaurant's clock reads an hour well away from midnight, so "today"
  // cannot turn over in the middle of the test.
  const zone = zoneWithHour(1, 22);
  const made = await restaurantService.createRestaurant({
    name: "Banquet Hall",
    code: "CASHPAN1",
    invoicePrefix: "BH",
    timezone: zone,
    admin: { name: "Banquet owner", email: "owner@cashpan.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Hall",
    code: "CASHPAN2",
    admin: { name: "Other owner", email: "other@cashpan.invalid", password },
  });

  const hash = await bcrypt.hash(password, 4);
  const staff = async (name, email, role) => {
    const row = await one("INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id", [rid, name, email, hash]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    return Number(row.id);
  };
  await staff("Ravi cashier", "ravi@cashpan.invalid", "CASHIER");
  await staff("Suresh captain", "suresh@cashpan.invalid", "CAPTAIN");
  const rider = await one("INSERT INTO employees (restaurant_id, name, department) VALUES ($1, 'Imran', 'delivery') RETURNING id", [rid]);

  const app = require("../../src/app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, url, body, auth) {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function request(method, url, body, expected, auth) {
    const result = await call(method, url, body, auth);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body.data;
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const owner = await login("owner@cashpan.invalid");
  const cashier = await login("ravi@cashpan.invalid");
  const captain = await login("suresh@cashpan.invalid");
  const other = await login("other@cashpan.invalid");
  const O = (method, url, body, expected = 200) => request(method, url, body, expected, owner);
  const C = (method, url, body, expected = 200) => request(method, url, body, expected, cashier);
  // A refusal: its status and the sentence it gives.
  const refused = async (method, url, body, status, pattern, auth = owner) => {
    const result = await call(method, url, body, auth);
    assert.equal(result.status, status, `${method} ${url}: ${JSON.stringify(result.body)}`);
    assert.match(result.body.message, pattern);
    return result.body;
  };
  const auditOf = async (action, entityId) => {
    let rows = [];
    for (let tries = 0, last = -1; tries < 15 && rows.length !== last; tries += 1) {
      last = rows.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      rows = await all("SELECT details FROM audit_logs WHERE restaurant_id = $1 AND action = $2 AND entity_id = $3 ORDER BY id", [rid, action, entityId]);
    }
    return rows;
  };
  const paymentsOn = async (billId) => (await one("SELECT COUNT(*)::int AS n FROM payments WHERE bill_id = $1", [billId])).n;
  const BILL_LIMIT = /cannot be taken for one bill \(Income-tax Act 2025, section 186\)/;
  const GUEST_LIMIT = /cannot be taken from one guest in a day \(Income-tax Act 2025, section 186\)/;
  const TAKE_THE_REST = /Take the rest by UPI, card, bank transfer or cheque\./;

  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0, timezone: zone, taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 0,
    invoicePrefix: "BH", gstSplit: true, autoConsumeStock: false, loyaltyEnabled: false, autoPrintBill: false, printShowQr: false,
  });
  const food = (await O("GET", "/menu/tax-rates")).find((rate) => rate.isDefault);
  const banquets = await O("POST", "/menu/categories", { name: "Banquets" }, 201);
  // ₹1,00,000 + 5% GST = ₹1,05,000; ₹1,000 + 5% = ₹1,050; ₹2,00,000 with no GST.
  const hall = await O("POST", "/menu/products", { categoryId: banquets.id, name: "Wedding banquet", price: 100000, taxRateId: food.id, isAvailable: true }, 201);
  const thali = await O("POST", "/menu/products", { categoryId: banquets.id, name: "Banquet thali", price: 1000, taxRateId: food.id, isAvailable: true }, 201);
  const decor = await O("POST", "/menu/products", { categoryId: banquets.id, name: "Hall decoration", price: 200000, taxPercentage: 0, isAvailable: true }, 201);
  const order = async (lines, extra = {}) =>
    O("POST", "/orders", { orderType: "takeaway", ...extra, items: lines.map(([product, quantity]) => ({ productId: product.id, quantity })) }, 201);
  const raise = async (lines, extra = {}, body = {}) => O("POST", "/bills", { orderId: (await order(lines, extra)).id, ...body }, 201);
  const guest = async (name, mobile, extra = {}) => O("POST", "/crm/customers", { name, mobile, ...extra }, 201);

  await O("POST", "/business-day/open", { openingCash: 1000 }, 201);
  const todayHere = today(zone);

  await t.test("one bill: its cash payments and the cash tip on top count; the payment reaching ₹2,00,000 is refused", async () => {
    const bill = await raise([[hall, 1], [thali, 90]]);
    assert.equal(bill.totalAmount, 199500);
    assert.equal(bill.panNeeded, false);
    assert.deepEqual(bill.cashLimit, { limit: 200000, bill: { taken: 0, left: 199999.99 }, guest: null, left: 199999.99 });
    const first = await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: 150000, tenderedAmount: 154000, tipAmount: 4000 }, 201);
    assert.deepEqual(first.cashLimit.bill, { taken: 154000, left: 45999.99 });
    // The tip counts: ₹1,50,000 + ₹4,000 + ₹46,000 is ₹2,00,000.
    const body = await refused("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: 46000 }, 409, BILL_LIMIT, cashier);
    assert.match(body.message, new RegExp(`${bill.billNumber.replace(/[/-]/g, "\\$&")} would reach ₹200000\\.00`));
    assert.match(body.message, TAKE_THE_REST);
    // Refused again on a second try, and nothing of it is kept.
    await refused("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: 46000 }, 409, BILL_LIMIT, cashier);
    assert.equal(await paymentsOn(bill.id), 1);
    const most = await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: 45999.99 }, 201);
    assert.equal(most.cashLimit.bill.left, 0);
    const paid = await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: 3500.01, transactionRef: "UTR1" }, 201);
    assert.equal(paid.billStatus, "paid");
    assert.equal(paid.cashLimit.bill.taken, 199999.99);
  });

  let lakshmi;
  let printedBill;
  await t.test("a bill over ₹2,00,000 takes no payment until the buyer's PAN or declaration is on it", async () => {
    lakshmi = await guest("Lakshmi", "9845012301");
    const bill = await raise([[hall, 2]], { customerId: lakshmi.id });
    assert.equal(bill.totalAmount, 210000);
    assert.deepEqual([bill.panNeeded, bill.buyerPan, bill.panDeclaration, bill.panInGstin], [true, null, false, null]);
    const none = await refused("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: 10000 }, 409, /needs the buyer's PAN before it takes a payment/, cashier);
    assert.match(none.message, new RegExp(`${bill.billNumber.replace(/[/-]/g, "\\$&")} has none`));
    assert.match(none.message, /Form 97/);
    await refused("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: 10000, buyer: { pan: "abc" } }, 400, /Buyer PAN must look like ABCDE1234F/, cashier);
    await refused("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: 10000, buyer: { pan: "abcde1234f", panDeclaration: true } }, 400, /not both/, cashier);
    assert.equal(await paymentsOn(bill.id), 0);
    // Typed with the payment: on the bill, in capitals.
    const paid = await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: 10000, transactionRef: "UTR2", buyer: { pan: "abcde1234f" } }, 201);
    assert.equal(paid.buyerPan, "ABCDE1234F");
    assert.deepEqual((await auditOf("buyer_pan", bill.id))[0].details.changes, { pan: [null, "ABCDE1234F"] });
    // Changed on the bill while it is not settled: the declaration, then the PAN again.
    const declared = await C("PUT", `/bills/${bill.id}/pan`, { panDeclaration: true });
    assert.deepEqual([declared.buyerPan, declared.panDeclaration], [null, true]);
    await C("PUT", `/bills/${bill.id}/pan`, { panDeclaration: true });
    assert.equal((await auditOf("buyer_pan", bill.id)).length, 2, "the same declaration again changes nothing");
    await refused("PUT", `/bills/${bill.id}/pan`, {}, 400, /Type the buyer's PAN/, cashier);
    await refused("PUT", `/bills/${bill.id}/pan`, { pan: "abcde1234f" }, 403, /permission/, captain);
    await refused("PUT", `/bills/${bill.id}/pan`, { pan: "abcde1234f" }, 404, /not found/i, other);
    assert.equal((await C("PUT", `/bills/${bill.id}/pan`, { pan: "ABCDE1234F" })).buyerPan, "ABCDE1234F");
    const settled = await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "card", amount: 200000, transactionRef: "SLIP1" }, 201);
    assert.equal(settled.billStatus, "paid");
    await refused("PUT", `/bills/${bill.id}/pan`, { panDeclaration: true }, 409, /settled/, cashier);
    // The printed bill: the PAN under the buyer, and its figures.
    printedBill = await C("POST", `/bills/${bill.id}/print`, undefined, 200);
    assert.equal(printedBill.copy, "original");
    assert.deepEqual([printedBill.buyerPan, printedBill.panDeclaration, printedBill.panNeeded], ["ABCDE1234F", false, true]);
    assert.deepEqual([printedBill.subtotal, printedBill.taxAmount, printedBill.totalAmount, printedBill.paidAmount, printedBill.dueAmount], [200000, 10000, 210000, 210000, 0]);
    assert.equal(printedBill.customerName, "Lakshmi");
    assert.deepEqual(printedBill.cashLimit.bill, { taken: 0, left: 199999.99 });
  });

  await t.test("the declaration given when the bill is raised; the PAN in a buyer's GSTIN; exactly ₹2,00,000; a split bill checked on each bill", async () => {
    const raised = await raise([[hall, 2]], {}, { buyer: { panDeclaration: true } });
    assert.deepEqual([raised.panNeeded, raised.panDeclaration], [true, true]);
    assert.deepEqual((await auditOf("buyer_pan", raised.id))[0].details.changes, { panDeclaration: [false, true] });
    await C("POST", `/bills/${raised.id}/payments`, { paymentMethod: "upi", amount: raised.dueAmount, transactionRef: "UTR3" }, 201);
    await refused("POST", "/bills", { orderId: (await order([[hall, 1]])).id, buyer: { pan: "1234" } }, 400, /Buyer PAN must look like/);

    const company = await guest("Ravi Shetty", "9845012302", { companyName: "Sri Events", gstin: "29AAACS1234A1ZY" });
    const b2b = await raise([[hall, 2]], { customerId: company.id });
    assert.equal(b2b.buyer.gstin, "29AAACS1234A1ZY");
    assert.deepEqual([b2b.buyerPan, b2b.panInGstin], [null, "AAACS1234A"]);
    const withPan = await C("POST", `/bills/${b2b.id}/payments`, { paymentMethod: "upi", amount: 1000, transactionRef: "UTR4" }, 201);
    assert.deepEqual([withPan.buyerPan, withPan.panInGstin], ["AAACS1234A", null]);

    const exact = await raise([[decor, 1]]);
    assert.deepEqual([exact.totalAmount, exact.panNeeded], [200000, false]);
    await C("POST", `/bills/${exact.id}/payments`, { paymentMethod: "card", amount: 200000, transactionRef: "SLIP2" }, 201);

    // Three banquets split over two bills: ₹1,05,000 needs no PAN, ₹2,10,000 does.
    const split = await order([[hall, 3]]);
    const firstPart = await O("POST", "/bills", { orderId: split.id, items: [{ orderItemId: split.items[0].id, quantity: 1 }] }, 201);
    assert.deepEqual([firstPart.isSplit, firstPart.totalAmount, firstPart.panNeeded], [true, 105000, false]);
    await C("POST", `/bills/${firstPart.id}/payments`, { paymentMethod: "cash", amount: 105000 }, 201);
    const rest = await O("POST", "/bills", { orderId: split.id }, 201);
    assert.deepEqual([rest.totalAmount, rest.panNeeded], [210000, true]);
    await refused("POST", `/bills/${rest.id}/payments`, { paymentMethod: "upi", amount: 210000 }, 409, /needs the buyer's PAN/, cashier);
    // Each bill is its own: ₹1,05,000 in cash on the first leaves this one its own limit.
    const restPaid = await C("POST", `/bills/${rest.id}/payments`, { paymentMethod: "cash", amount: 150000, buyer: { panDeclaration: true } }, 201);
    assert.deepEqual([restPaid.panDeclaration, restPaid.cashLimit.bill.taken], [true, 150000]);
    await C("POST", `/bills/${rest.id}/payments`, { paymentMethod: "upi", amount: 60000, transactionRef: "UTR5" }, 201);
  });

  let ravi;
  await t.test("one guest's day: bills, advances in cash, an advance used on a bill, and walk-ins apart", async () => {
    ravi = await guest("Ravi Kumar", "9845012303");
    const advance = (await call("POST", "/bills/advances", { customerId: ravi.id, amount: 80000, paymentMethod: "cash", purpose: "Engagement party" }, cashier)).body.data;
    assert.match(advance.receiptNumber, /^ADV/);
    const first = await raise([[thali, 50]], { customerId: ravi.id });
    const afterFirst = await C("POST", `/bills/${first.id}/payments`, { paymentMethod: "cash", amount: 52500 }, 201);
    assert.deepEqual(afterFirst.cashLimit.guest, { customerId: Number(ravi.id), name: "Ravi Kumar", taken: 132500, left: 67499.99 });
    // Paid from the cash advance: cash this bill took, counted once (the day
    // the advance came in), not again on the guest's day.
    const second = await raise([[thali, 60]], { customerId: ravi.id });
    const fromAdvance = await C("POST", `/bills/${second.id}/payments`, { paymentMethod: "advance", amount: 63000, advanceId: advance.id }, 201);
    assert.equal(fromAdvance.cashLimit.bill.taken, 63000);
    assert.equal(fromAdvance.cashLimit.guest.taken, 132500);
    const third = await raise([[thali, 70]], { customerId: ravi.id });
    const body = await refused("POST", `/bills/${third.id}/payments`, { paymentMethod: "cash", amount: 67500 }, 409, GUEST_LIMIT, cashier);
    assert.match(body.message, /today's cash from Ravi Kumar would reach ₹200000\.00/);
    const most = await C("POST", `/bills/${third.id}/payments`, { paymentMethod: "cash", amount: 67499.99 }, 201);
    assert.deepEqual([most.cashLimit.guest.left, most.cashLimit.left], [0, 0]);
    await C("POST", `/bills/${third.id}/payments`, { paymentMethod: "card", amount: 6000.01, transactionRef: "SLIP3" }, 201);
    // A cash advance is refused; a UPI one is not limited.
    await refused("POST", "/bills/advances", { customerId: ravi.id, amount: 1, paymentMethod: "cash" }, 409, /today's cash from Ravi Kumar would reach ₹200000\.99/, cashier);
    await C("POST", "/bills/advances", { customerId: ravi.id, amount: 5000, paymentMethod: "upi", transactionRef: "UTR6" }, 201);
    // A walk-in bill names nobody: limited per bill only.
    const walkIn = await raise([[hall, 1], [thali, 80]]);
    const walked = await C("POST", `/bills/${walkIn.id}/payments`, { paymentMethod: "cash", amount: 189000 }, 201);
    assert.deepEqual([walked.billStatus, walked.cashLimit.guest], ["paid", null]);
    // Another restaurant's guest of the same name is no one here.
    assert.equal((await one("SELECT restaurant_cash_from_guest($1, $2, $3, $4::date) AS cash", [rid, ravi.id, zone, todayHere])).cash, "199999.99");
  });

  await t.test("cash collected on an account is the account's guest's; cash on delivery is the named guest's", async () => {
    const company = await guest("Anil Rao", "9845012304", { companyName: "Rao Caterers" });
    await O("PUT", `/bills/accounts/${company.id}`, { creditLimit: 500000, creditDays: 30 });
    const onAccount = [];
    for (let n = 0; n < 2; n += 1) {
      const bill = await raise([[hall, 1]]);
      await O("PATCH", `/bills/${bill.id}/account`, { customerId: company.id });
      onAccount.push(bill);
    }
    // ₹1,05,000 each is under the limit for each bill, but ₹2,10,000 from
    // the company in a day is not: nothing of the collection is kept.
    const body = await refused("POST", `/bills/accounts/${company.id}/collect`, { amount: 210000, paymentMethod: "cash" }, 409, GUEST_LIMIT);
    assert.match(body.message, /today's cash from Rao Caterers would reach ₹210000\.00/);
    assert.equal((await paymentsOn(onAccount[0].id)) + (await paymentsOn(onAccount[1].id)), 0);
    const collected = (await call("POST", `/bills/accounts/${company.id}/collect`, { amount: 190000, paymentMethod: "cash" }, owner)).body.data;
    assert.deepEqual(collected.allocations.map((row) => row.amount), [105000, 85000]);
    await refused("POST", `/bills/accounts/${company.id}/collect`, { amount: 20000, paymentMethod: "cash" }, 409, /would reach ₹210000\.00/);
    await O("POST", `/bills/accounts/${company.id}/collect`, { amount: 20000, paymentMethod: "upi", transactionRef: "UTR7" }, 201);

    // The rider brings cash from Meena, who paid an advance in cash today.
    const meena = await guest("Meena", "9845012305");
    await C("POST", "/bills/advances", { customerId: meena.id, amount: 40000, paymentMethod: "cash" }, 201);
    const delivery = await order([[hall, 1], [thali, 60]], { orderType: "delivery", customerId: meena.id });
    await pool.query("UPDATE orders SET rider_employee_id = $2, delivery_status = 'delivered', dispatched_at = NOW(), delivered_at = NOW() WHERE id = $1", [delivery.id, rider.id]);
    const bill = await O("POST", "/bills", { orderId: delivery.id }, 201);
    assert.ok(bill.totalAmount >= 168000 && bill.totalAmount <= 200000, String(bill.totalAmount));
    const settle = { bills: [{ billId: bill.id, method: "cash" }], cashHanded: bill.dueAmount };
    await refused("POST", `/deliveries/riders/${rider.id}/settle`, settle, 409, /today's cash from Meena would reach/);
    assert.equal(await paymentsOn(bill.id), 0);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM rider_settlements WHERE restaurant_id = $1", [rid])).n, 0);
    await O("POST", `/deliveries/riders/${rider.id}/settle`, { bills: [{ billId: bill.id, method: "upi", upiRef: "UTR8" }], cashHanded: 0 }, 201);

    // A pre-order's advance over the limit: the pre-order is booked, the
    // advance is not, and the answer says why.
    await O("PUT", "/restaurants/current/features/preorders", { enabled: true });
    const preorder = await O("POST", "/preorders", {
      customerId: meena.id, dueAt: new Date(Date.now() + 86400000).toISOString(),
      items: [{ productId: thali.id, quantity: 200 }], advance: { amount: 170000, paymentMethod: "cash" },
    }, 201);
    assert.match(preorder.advanceRefused, /today's cash from Meena would reach ₹210000\.00/);
    assert.equal(preorder.advanceId, null);
  });

  await t.test("correcting a payment to cash is checked the same way, before anyone is asked for a PIN", async () => {
    const bill = await raise([[hall, 2]], {}, { buyer: { pan: "PQRSM6789K" } });
    await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: 150000 }, 201);
    const upi = (await C("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: 60000, transactionRef: "UTR9" }, 201)).payments[1];
    // A cashier would need a manager's PIN: the limit refuses it first (409, not 403).
    const asked = await refused("PATCH", `/bills/${bill.id}/payments/${upi.id}`, { paymentMethod: "cash", reason: "Paid in cash" }, 409, BILL_LIMIT, cashier);
    assert.match(asked.message, /would reach ₹210000\.00/);
    assert.equal(asked.data, undefined);
    await refused("PATCH", `/bills/${bill.id}/payments/${upi.id}`, { paymentMethod: "cash", reason: "Paid in cash" }, 409, BILL_LIMIT);
    assert.equal((await O("PATCH", `/bills/${bill.id}/payments/${upi.id}`, { paymentMethod: "card", transactionRef: "SLIP4", reason: "Card, not UPI" })).payments[1].paymentMethod, "card");
    // One that keeps within the limit goes through.
    const small = await raise([[hall, 1]]);
    await C("POST", `/bills/${small.id}/payments`, { paymentMethod: "cash", amount: 50000 }, 201);
    const card = (await C("POST", `/bills/${small.id}/payments`, { paymentMethod: "card", amount: 55000, transactionRef: "SLIP5" }, 201)).payments[1];
    const fixed = await O("PATCH", `/bills/${small.id}/payments/${card.id}`, { paymentMethod: "cash", reason: "Paid in cash" });
    assert.equal(fixed.cashLimit.bill.taken, 105000);
    assert.equal((await auditOf("payment_corrected", small.id))[0].details.to, "cash");
  });

  await t.test("the day is the restaurant's: cash just before its midnight is yesterday's, just after it today's", async () => {
    const kiran = await guest("Kiran", "9845012306");
    const first = await raise([[thali, 100]], { customerId: kiran.id });
    const paid = await C("POST", `/bills/${first.id}/payments`, { paymentMethod: "cash", amount: 105000 }, 201);
    const second = await raise([[thali, 100]], { customerId: kiran.id });
    // A minute after midnight on the restaurant's clock: today's.
    await pool.query("UPDATE payments SET paid_at = $2 WHERE id = $1", [paid.payments[0].id, momentAt(todayHere, "00:01", zone)]);
    await refused("POST", `/bills/${second.id}/payments`, { paymentMethod: "cash", amount: 95000 }, 409, /today's cash from Kiran would reach ₹200000\.00/);
    // A minute before it: yesterday's.
    await pool.query("UPDATE payments SET paid_at = $2 WHERE id = $1", [paid.payments[0].id, momentAt(addDays(todayHere, -1), "23:59", zone)]);
    const now = await C("POST", `/bills/${second.id}/payments`, { paymentMethod: "cash", amount: 95000 }, 201);
    assert.deepEqual(now.cashLimit.guest, { customerId: Number(kiran.id), name: "Kiran", taken: 95000, left: 104999.99 });
    const yesterday = await one("SELECT restaurant_cash_from_guest($1, $2, $3, $4::date) AS cash", [rid, kiran.id, zone, addDays(todayHere, -1)]);
    assert.equal(yesterday.cash, "105000.00");
  });

  await t.test("the database holds the rules whatever writes the row; a captain sees no cash figures", async () => {
    const bill = await raise([[hall, 1], [thali, 90]], { customerId: lakshmi.id });
    const user = await one("SELECT id FROM users WHERE email = 'ravi@cashpan.invalid'");
    const write = (method, amount) =>
      pool.query("INSERT INTO payments (restaurant_id, bill_id, order_id, business_day_id, payment_method, amount, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [rid, bill.id, bill.orderId, bill.businessDayId, method, amount, user.id]);
    await assert.rejects(write("cash", 200000), BILL_LIMIT);
    await assert.rejects(
      pool.query("INSERT INTO customer_advances (restaurant_id, customer_id, receipt_number, amount, payment_method) VALUES ($1, $2, 'ADV-SQL', 250000, 'cash')", [rid, lakshmi.id]),
      GUEST_LIMIT
    );
    const large = await raise([[hall, 2]]);
    await assert.rejects(
      pool.query("INSERT INTO payments (restaurant_id, bill_id, order_id, payment_method, amount) VALUES ($1, $2, $3, 'upi', 10)", [rid, large.id, large.orderId]),
      /needs the buyer's PAN/
    );
    await assert.rejects(pool.query("UPDATE bills SET buyer_pan = 'ABCDE1234' WHERE id = $1", [large.id]), /bills_buyer_pan_check/);
    await assert.rejects(pool.query("UPDATE bills SET buyer_pan = 'ABCDE1234F', pan_declaration = TRUE WHERE id = $1", [large.id]), /chk_bills_pan_or_declaration/);
    await write("upi", 1000);
    // Someone who sees bills as the guest does: no cash figures.
    const seen = await request("GET", `/bills/${bill.id}`, undefined, 200, captain);
    assert.deepEqual([seen.cashLimit, seen.paymentDetailsHidden], [null, true]);
    assert.equal((await call("GET", `/bills/${bill.id}`, undefined, other)).status, 404);
  });
});
