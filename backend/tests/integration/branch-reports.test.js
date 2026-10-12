// Branch accounting and reports, end to end on a throwaway database: a
// restaurant whose main counter left its business day open eight days ago,
// and three branches trading today on days of their own — two registered for
// GST on their own (own GSTIN, own invoice series), one on the restaurant's.
//
// What it keeps true:
//   - a branch's invoice and credit-note series start at 0001, its own;
//   - a branch is reported on its own business day everywhere (dashboard,
//     the reports' default dates, the day-end sheet with its own drawer), and
//     All outlets adds up every open day, each on its own date;
//   - stock used by any branch's bills reaches the consumption report and the
//     P&L food cost;
//   - the GST pack is one registration's; credit notes carry exactly the GST
//     recorded on them; service charge is filed at each dish's own rate;
//   - a GSTIN added to a guest never turns their earlier bills into B2B;
//   - the day book credits a company's late payment to the company;
//   - GSTR-1's B2B row never counts untaxed service charge twice;
//   - the manager-PIN prompt for taking off a sent dish shows its value;
//   - the dashboard's money collected is the day's, dues included, as the
//     Z report and the Bills screen count it, and All outlets says what a
//     counter still open on an older date adds to Sales today;
//   - another restaurant can read none of it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

const { today, daysFrom } = require("./helpers/dates");
const TODAY = today();
const daysFromToday = (n) => daysFrom(n);

// A GSTIN with a valid check character, from its first 14 characters.
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const gstin = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return `${first14}${CHARS[(36 - (sum % 36)) % 36]}`;
};

test("branch accounting and reports", { timeout: 600000 }, async (t) => {
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

  const made = await restaurantService.createRestaurant({
    name: "Branch Books",
    code: "BBOOKS",
    admin: { name: "Branch owner", email: "owner@branch.invalid", password },
  });
  const rid = made.id;
  await restaurantService.createRestaurant({
    name: "Other Cafe",
    code: "OTHER",
    admin: { name: "Other owner", email: "other@branch.invalid", password },
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
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (expected !== null) {
      assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    }
    return expected === null ? { status: response.status, ...result } : result.data;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password })).token;
  const owner = await login("owner@branch.invalid");
  const O = (method, url, body, expected = 200, headers = {}) => request(method, url, body, expected, owner, headers);
  const H = (id) => (id ? { "X-Outlet-Id": String(id) } : {});
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

  const R1 = gstin("37AABCB1234K1Z");
  const R2 = gstin("37AABCB1234K2Z");
  const R3 = gstin("37AABCB1234K3Z");
  const G1 = gstin("36AAGCB7383J1Z");
  const G2 = gstin("36AAGCL7383J1Z");

  const s0 = await O("GET", "/restaurants/current/settings");
  await O("PUT", "/restaurants/current/settings", {
    ...s0, timezone: "Asia/Kolkata", taxMode: "exclusive", defaultTaxPercentage: 5, serviceChargePercentage: 10,
    orderPrefix: "BO", invoicePrefix: "BB", gstNumber: R1, fssaiNumber: "10124999000777", gstSplit: true,
    autoConsumeStock: true, loyaltyEnabled: false, autoPrintBill: false, printShowQr: false,
    serviceChargeOrderTypes: ["dine_in"],
  });
  const food = await O("POST", "/menu/tax-rates", { name: "Food 5%", percentage: 5, hsnCode: "996331" }, 201);
  const water18 = await O("POST", "/menu/tax-rates", { name: "Water 18%", percentage: 18, hsnCode: "2201" }, 201);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dish = async (name, price, rate) =>
    O("POST", "/menu/products", { categoryId: category.id, name, price, taxRateId: rate.id, isAvailable: true }, 201);
  const paneer = await dish("Paneer Tikka", 310, food);
  const dal = await dish("Dal Tadka", 200, food);
  const water = await dish("Mineral Water", 40, water18);

  // Stock and recipes, so bills take ingredients out of the store.
  const unit = await O("POST", "/inventory/units", { name: "Kilogram", shortName: "kg" }, 201);
  const paneerKg = await O("POST", "/inventory/items", { name: "Paneer", unitId: unit.id, openingStock: 50, openingCost: 342.5 }, 201);
  const dalKg = await O("POST", "/inventory/items", { name: "Toor Dal", unitId: unit.id, openingStock: 50, openingCost: 120 }, 201);
  await O("POST", `/menu/products/${paneer.id}/recipe`, { inventoryItemId: paneerKg.id, quantity: 0.2 }, 201);
  await O("POST", `/menu/products/${dal.id}/recipe`, { inventoryItemId: dalKg.id, quantity: 0.15 }, 201);

  const floor = await O("POST", "/tables/floors", { name: "Ground" }, 201);
  const mainTables = [];
  for (let i = 1; i <= 5; i += 1) mainTables.push((await O("POST", "/tables", { floorId: floor.id, tableNo: `M${i}`, capacity: 4 }, 201)).id);

  // The main counter's day, left open since eight days ago.
  const D1 = TODAY;
  const D0 = daysFromToday(-8);
  const dayM = (await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 3000 }, 201)).id;
  await pool.query("UPDATE business_days SET business_date = $2::date, opened_at = opened_at - INTERVAL '8 days' WHERE id = $1", [dayM, D0]);

  const A = (await O("POST", "/outlets", { name: "Beach Branch", code: "BEACH", gstNumber: R2, invoicePrefix: "BA" }, 201)).id;
  const B = (await O("POST", "/outlets", { name: "Hill Branch", code: "HILL", gstNumber: R3, invoicePrefix: "BH" }, 201)).id;
  const C = (await O("POST", "/outlets", { name: "Cafe Corner", code: "CC" }, 201)).id;
  const dayA = (await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 2000 }, 201, H(A))).id;
  const dayB = (await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 500 }, 201, H(B))).id;
  const dayC = (await O("POST", "/business-day/open", { businessDate: TODAY, openingCash: 300 }, 201, H(C))).id;
  const floorA = await O("POST", "/tables/floors", { name: "Beach floor" }, 201, H(A));
  const tableA = (await O("POST", "/tables", { floorId: floorA.id, tableNo: "A1", capacity: 4 }, 201, H(A))).id;

  // A manager tied to branch A, and a captain at the main counter.
  const hash = await bcrypt.hash(password, 4);
  const person = async (email, role, outletId = null) => {
    const row = await one(
      "INSERT INTO users (restaurant_id, outlet_id, name, email, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [rid, outletId, email.split("@")[0], email, hash]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [row.id, role]);
    return login(email);
  };
  const managerA = await person("manager.a@branch.invalid", "MANAGER", A);
  const captain = await person("captain@branch.invalid", "CAPTAIN");
  const MA = (method, url, body, expected = 200) => request(method, url, body, expected, managerA);

  const order = async (items, extra = {}, headers = {}, token = owner) => {
    const placed = await request(
      "POST",
      "/orders",
      { orderType: "takeaway", ...extra, items: items.map(([p, quantity]) => ({ productId: p.id, quantity })) },
      201,
      token,
      headers
    );
    return placed.order || placed;
  };
  const raise = async (orderId, headers = {}) => O("POST", "/bills", { orderId }, 201, headers);
  const pay = async (b, method = "cash", headers = {}) =>
    O("POST", `/bills/${b.id}/payments`, { paymentMethod: method, amount: b.dueAmount }, 201, headers);
  const sale = async (items, headers = {}, method = "cash", extra = {}) => pay(await raise((await order(items, extra, headers)).id, headers), method, headers);
  const returnOne = async (b, itemName, headers = {}) => {
    const line = b.items.find((i) => i.itemName === itemName);
    return O("POST", `/bills/${b.id}/refunds`, {
      amount: line.returnValue,
      refundMethod: "cash",
      reason: "Guest did not like it",
      items: [{ orderItemId: line.orderItemId, quantity: 1 }],
    }, 201, headers);
  };

  // The day's sales: two at the main counter (on its old day, at its own
  // tables, which are the main counter's whatever the switcher says), three
  // at A (one dine-in with service charge on 5% food and 18% water), one at
  // B and C.
  const m1 = await sale([[paneer, 1], [dal, 1]], {}, "cash", { orderType: "dine_in", tableId: mainTables[3], guestCount: 2 });
  await sale([[dal, 2]], {}, "cash", { orderType: "dine_in", tableId: mainTables[4], guestCount: 2 });
  await sale([[paneer, 2], [water, 1]], H(A), "card", { orderType: "dine_in", tableId: tableA, guestCount: 2 });
  await sale([[dal, 2]], H(A));
  const a3 = await sale([[paneer, 1], [water, 1]], H(A));
  const b1 = await sale([[dal, 1], [water, 2]], H(B));
  await sale([[paneer, 1]], H(C));

  const billsOf = async (dayIds, outletId = null) =>
    one(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount), 0)::float AS total
       FROM bills WHERE restaurant_id = $1 AND bill_status <> 'void' AND business_day_id = ANY($2::bigint[])
         AND ($3::bigint IS NULL OR outlet_id = $3)`,
      [rid, dayIds, outletId]
    );
  const cashOf = async (dayId) =>
    Number(
      (await one(
        `SELECT COALESCE((SELECT SUM(amount) FROM payments WHERE business_day_id = $1 AND payment_method = 'cash' AND payment_status = 'success'), 0)
              - COALESCE((SELECT SUM(amount) FROM refunds WHERE business_day_id = $1 AND refund_method = 'cash'), 0) AS net`,
        [dayId]
      )).net
    );

  await t.test("a new branch's invoice series and credit notes are its own, starting at 0001", async () => {
    const first = async (outletId) =>
      (await one("SELECT bill_number FROM bills WHERE restaurant_id = $1 AND outlet_id = $2 ORDER BY id LIMIT 1", [rid, outletId])).bill_number;
    assert.equal(await first(A), "BA-0001");
    assert.equal(await first(B), "BH-0001");
    assert.match(await first(C), /-0001$/);
    await returnOne(m1, "Dal Tadka");
    await returnOne(a3, "Paneer Tikka", H(A));
    await returnOne(b1, "Mineral Water", H(B));
    const note = async (billId) => (await one("SELECT credit_note_number FROM credit_notes WHERE bill_id = $1", [billId])).credit_note_number;
    assert.equal(await note(m1.id), "CN-0001");
    const numA = await note(a3.id);
    const numB = await note(b1.id);
    assert.match(numA, /-0001$/);
    assert.match(numB, /-0001$/);
    assert.equal(new Set([numA.replace(/-\d+$/, ""), numB.replace(/-\d+$/, ""), "CN"]).size, 3);
    assert.ok([numA, numB].every((n) => n.length <= 16));
    const packA = await O("GET", `/reports/gst?from=${D1}&to=${D1}`, undefined, 200, H(A));
    assert.ok(packA.documents.some((d) => d.kind === "credit_note" && d.totalIssued === 1 && numA.startsWith(d.series)), JSON.stringify(packA.documents));
  });

  await t.test("a branch is reported on its own business day everywhere; All outlets adds up every open day", async () => {
    const own = await billsOf([dayA]);
    const dash = await O("GET", "/reports/dashboard", undefined, 200, H(A));
    assert.equal(dash.businessDate, D1);
    assert.equal(dash.billCount, own.n);
    assert.ok(near(dash.netSales, own.total));
    const mgr = await MA("GET", "/reports/dashboard");
    assert.equal(mgr.businessDate, D1);
    assert.equal(mgr.cash.outletOnly, false);
    assert.ok(near(mgr.cash.openingCash, 2000));
    assert.ok(near(mgr.cash.expected, 2000 + (await cashOf(dayA))));
    const trading = await MA("GET", "/reports/trading-day");
    assert.equal(trading.businessDate, D1);
    assert.equal(Number(trading.businessDayId), Number(dayA));
    const sales = await MA("GET", "/reports/sales");
    assert.equal(sales.from, D1);
    assert.equal(sales.summary.billCount, own.n);
    const z = await MA("GET", "/reports/day-end");
    assert.equal(Number(z.businessDayId), Number(dayA));
    assert.equal(z.billCount, own.n);
    assert.equal(z.wholeDrawer, true);
    assert.ok(near(z.openingCash, 2000));
    const byDate = await O("GET", `/reports/day-end?businessDate=${D1}`, undefined, 200, H(A));
    assert.equal(Number(byDate.businessDayId), Number(dayA));

    const every = await billsOf([dayM, dayA, dayB, dayC]);
    const dashAll = await O("GET", "/reports/dashboard");
    assert.equal(dashAll.billCount, every.n);
    assert.ok(near(dashAll.netSales, every.total));
    assert.equal(dashAll.openDays.length, 4);
    assert.ok(dashAll.openDays.some((d) => d.businessDate === D0 && !d.outletId));
    const zAll = await O("GET", "/reports/day-end");
    assert.deepEqual(zAll.businessDayIds.map(Number).sort(), [dayM, dayA, dayB, dayC].map(Number).sort());
    assert.deepEqual(zAll.businessDates, [D0, D1]);
    assert.equal(zAll.billCount, every.n);
    const zC = await O("GET", "/reports/day-end", undefined, 200, H(C));
    assert.equal(Number(zC.businessDayId), Number(dayC));
    assert.ok(near(zC.openingCash, 300));
  });

  await t.test("stock used by a branch's bills reaches the consumption report and the P&L food cost", async () => {
    const used = await all(
      `SELECT st.inventory_item_id AS item, SUM(-st.quantity)::float AS qty, SUM(-st.quantity * COALESCE(st.unit_cost, i.last_cost))::float AS value
       FROM stock_transactions st
       JOIN bills b ON b.id = st.reference_id AND st.reference_type = 'bill'
       JOIN inventory_items i ON i.id = st.inventory_item_id
       WHERE b.restaurant_id = $1 AND b.business_day_id = $2
       GROUP BY 1`,
      [rid, dayA]
    );
    const paneerUsed = used.find((r) => Number(r.item) === Number(paneerKg.id));
    assert.ok(paneerUsed && paneerUsed.qty > 0);
    const consumption = await O("GET", `/reports/consumption?from=${D1}&to=${D1}`, undefined, 200, H(A));
    const row = consumption.rows.find((r) => r.itemName === "Paneer");
    assert.ok(row && near(row.consumed, paneerUsed.qty), JSON.stringify(consumption.rows));
    const pl = await O("GET", `/reports/profit-loss?from=${D1}&to=${D1}`, undefined, 200, H(A));
    const foodUsed = pl.lines.find((l) => l.key === "foodUsed");
    assert.ok(Math.abs(foodUsed.amount - used.reduce((s, r) => s + r.value, 0)) < 0.02, JSON.stringify(foodUsed));
    // The main counter's day left open since D0: its bills' stock is on D0.
    const old = await O("GET", `/reports/consumption?from=${D0}&to=${D0}`);
    assert.ok(old.rows.length > 0);
  });

  await t.test("the GST pack: one registration, credit notes' own GST, service charge at each dish's rate", async () => {
    const all3 = await O("GET", `/reports/gst?from=${D1}&to=${D1}`);
    for (const g of [R1, R2, R3]) assert.ok(all3.registrations.some((r) => r.gstin === g), JSON.stringify(all3.registrations));
    const aNumbers = (await all("SELECT bill_number FROM bills WHERE outlet_id = $1", [A])).map((r) => r.bill_number);
    assert.equal(all3.gstNumber, R1);
    assert.ok(!all3.register.some((r) => aNumbers.includes(r.invoiceNumber)));

    const packA = await O("GET", `/reports/gst?from=${D1}&to=${D1}&gstin=${R2}`);
    assert.equal(packA.gstNumber, R2);
    assert.deepEqual(packA.register.map((r) => r.invoiceNumber).sort(), [...aNumbers].sort());
    assert.ok(packA.checks.every((c) => c.ok), JSON.stringify(packA.checks));

    // The paneer's credit note: ₹310 at 5%, CGST 7.75 + SGST 7.75.
    const note = await one("SELECT * FROM credit_notes WHERE bill_id = $1", [a3.id]);
    assert.ok(near(note.taxable_value, 310) && near(note.tax_amount, 15.5));
    const cn = packA.creditNotes.rows.find((r) => r.invoiceNumber === a3.billNumber);
    assert.equal(cn.creditNoteNumber, note.credit_note_number);
    assert.ok(near(cn.taxableValue, 310) && near(cn.cgst, 7.75) && near(cn.sgst, 7.75));

    // B2C by rate equals the bills' own stored GST, service charge included.
    const stored = await all(
      `SELECT bt.tax_percentage::float AS rate, SUM(bt.taxable_value)::float AS taxable, SUM(bt.cgst_amount)::float AS cgst,
              SUM(bt.service_charge_taxable)::float AS sc
       FROM bill_taxes bt JOIN bills b ON b.id = bt.bill_id
       WHERE b.outlet_id = $1 AND b.bill_status <> 'void' GROUP BY 1`,
      [A]
    );
    assert.ok(stored.find((r) => r.rate === 18).sc > 0);
    for (const row of stored) {
      const b2c = packA.b2c.rows.find((r) => Number(r.rate) === row.rate);
      assert.ok(b2c && near(b2c.taxableValue, row.taxable) && near(b2c.cgst, row.cgst), JSON.stringify([b2c, row]));
    }
    assert.ok(packA.hsn.rows.every((r) => Math.abs(r.taxAmount - (r.taxableValue * r.rate) / 100) <= 0.05), JSON.stringify(packA.hsn.rows));

    // Day book and P&L: the credit note under its own number, at 5% only.
    const book = await O("GET", `/reports/day-book?from=${D1}&to=${D1}`, undefined, 200, H(A));
    const voucher = book.vouchers.find((v) => v.type === "Credit Note" && v.narration.includes(a3.billNumber));
    assert.equal(voucher.number, note.credit_note_number);
    const ledger = (name) => voucher.entries.find((e) => e.ledger === name);
    assert.ok(near(ledger("Sales returns @ 5%").debit, 310));
    assert.equal(ledger("Sales returns @ 18%"), undefined);
    assert.ok(near(ledger("Output CGST @ 2.5%").debit, 7.75));
    assert.equal(book.totals.unbalanced, 0);
    const pl = await O("GET", `/reports/profit-loss?from=${D1}&to=${D1}`, undefined, 200, H(A));
    assert.ok(near(pl.lines.find((l) => l.key === "refunds").amount, -310));
  });

  await t.test("a GSTIN added to a guest later never makes their earlier bill a B2B invoice", async () => {
    const guest = await O("POST", "/crm/customers", { name: "Late Guest", mobile: "9876500077" }, 201);
    const before = await sale([[dal, 1]], H(A), "cash", { customerId: guest.id });
    await O("PUT", `/crm/customers/${guest.id}`, { name: "Late Guest", companyName: "Late Co", gstin: G2 });
    const pack = await O("GET", `/reports/gst?from=${D1}&to=${D1}`, undefined, 200, H(A));
    assert.equal(pack.register.find((r) => r.invoiceNumber === before.billNumber).recipientGstin, null);
    const reprint = await O("GET", `/bills/${before.id}`, undefined, 200, H(A));
    assert.ok(!reprint.buyer || !reprint.buyer.gstin);
    const after = await sale([[dal, 1]], H(A), "cash", { customerId: guest.id });
    const pack2 = await O("GET", `/reports/gst?from=${D1}&to=${D1}`, undefined, 200, H(A));
    assert.equal(pack2.register.find((r) => r.invoiceNumber === after.billNumber).recipientGstin, G2);

    // Changing the GSTIN, removing it or erasing the guest rewrites neither
    // invoice: the ordinary bill stays ordinary, the B2B one keeps G2.
    const readBoth = async () => {
      const pack3 = await O("GET", `/reports/gst?from=${D1}&to=${D1}`, undefined, 200, H(A));
      const plain = await O("GET", `/bills/${before.id}`, undefined, 200, H(A));
      return [
        pack3.register.find((r) => r.invoiceNumber === before.billNumber).recipientGstin,
        Boolean(plain.buyer && plain.buyer.gstin),
        pack3.register.find((r) => r.invoiceNumber === after.billNumber).recipientGstin,
      ];
    };
    await O("PUT", `/crm/customers/${guest.id}`, { name: "Late Guest", companyName: "Later Co", gstin: G1 });
    assert.deepEqual(await readBoth(), [null, false, G2]);
    await O("PUT", `/crm/customers/${guest.id}`, { name: "Late Guest", companyName: "", gstin: "" });
    assert.deepEqual(await readBoth(), [null, false, G2]);
    await O("PUT", `/crm/customers/${guest.id}`, { name: "Late Guest", companyName: "Late Co", gstin: G2 });
    await O("POST", `/crm/customers/${guest.id}/erase`, { reason: "Asked to be forgotten" });
    assert.deepEqual(await readBoth(), [null, false, G2]);
  });

  await t.test("the day book credits a company's payment on an older invoice to the company", async () => {
    const company = await O("POST", "/crm/customers", { name: "Bluewave", mobile: "9876500055", companyName: "Bluewave Tech", gstin: G1 }, 201);
    const b = await raise((await order([[paneer, 1]], { customerId: company.id }, H(A))).id, H(A));
    const old = await one(
      `INSERT INTO business_days (restaurant_id, outlet_id, business_date, opening_cash, closing_cash, day_status, opened_at, closed_at, opened_by, closed_by)
       SELECT $1, $2, $3::date, 0, 0, 'closed', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days' + INTERVAL '10 hours', id, id
       FROM users WHERE email = 'owner@branch.invalid' RETURNING id`,
      [rid, A, daysFromToday(-3)]
    );
    await pool.query("UPDATE bills SET business_day_id = $2, billed_at = billed_at - INTERVAL '3 days' WHERE id = $1", [b.id, old.id]);
    await pay(b, "upi", H(A));
    const book = await O("GET", `/reports/day-book?from=${D1}&to=${D1}`, undefined, 200, H(A));
    const receipt = book.vouchers.find((v) => v.type === "Receipt" && v.party.includes(G1));
    assert.equal(receipt.party, `Bluewave Tech (${G1})`);
    assert.ok(receipt.entries.some((e) => e.ledger.includes(G1) && near(e.credit, b.totalAmount)));
  });

  await t.test("the dashboard's money collected is the day's, dues from earlier bills included", async () => {
    // The company's UPI payment on its three-day-old invoice (the day book
    // case above) was taken in A's day today.
    const taken = await one(
      `SELECT COALESCE(SUM(p.amount), 0)::float AS total,
              COALESCE(SUM(p.amount) FILTER (WHERE b.business_day_id IS DISTINCT FROM p.business_day_id), 0)::float AS dues
       FROM payments p JOIN bills b ON b.id = p.bill_id
       WHERE p.business_day_id = $1 AND p.payment_status = 'success'`,
      [dayA]
    );
    assert.ok(taken.dues > 0);
    const sum = (rows) => Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100);
    const dash = await O("GET", "/reports/dashboard", undefined, 200, H(A));
    assert.equal(sum(dash.byMethod), Math.round(taken.total * 100));
    assert.ok(near(dash.duesCollected, taken.dues));
    const z = await O("GET", "/reports/day-end", undefined, 200, H(A));
    const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.paymentMethod, Math.round(Number(r.amount) * 100)]));
    assert.deepEqual(byKey(dash.byMethod), byKey(z.byMethod));
    const bills = await O("GET", "/bills/day-summary", undefined, 200, H(A));
    assert.equal(sum(dash.byMethod), Math.round(bills.collected * 100));
    assert.ok(near(dash.duesCollected, bills.duesCollected));
    const all = await O("GET", "/reports/dashboard");
    const allBills = await O("GET", "/bills/day-summary");
    assert.equal(sum(all.byMethod), Math.round(allBills.collected * 100));
    assert.ok(near(all.duesCollected, allBills.duesCollected));

    // All outlets: each open day with what it adds; the main counter's old
    // day is the whole gap between Sales today and the 7-day chart's today.
    const main = all.openDays.find((d) => d.outletId === null);
    const ownM = await billsOf([dayM]);
    assert.equal(main.businessDate, D0);
    assert.equal(main.billCount, ownM.n);
    assert.ok(near(main.netSales, ownM.total));
    assert.ok(near(all.openDays.reduce((s, d) => s + d.netSales, 0), all.netSales));
    const todayPoint = all.trend.find((p) => p.businessDate === all.businessDate);
    assert.ok(near(all.netSales - main.netSales, todayPoint.netSales));
  });

  await t.test("GSTR-1's B2B row never counts untaxed service charge; the tables add up", async () => {
    // An older bill, from before GST was kept rate by rate: service charge
    // with no GST on it, and a buyer's GSTIN written on it.
    const o = await order([[paneer, 1], [water, 1]], { orderType: "dine_in", tableId: mainTables[0], guestCount: 2 });
    const b = await raise(o.id);
    const lines = await one("SELECT COALESCE(SUM(line_tax), 0)::float AS tax FROM bill_items WHERE bill_id = $1", [b.id]);
    const head = await one("SELECT subtotal::float AS s, discount_amount::float AS d, service_charge::float AS sc FROM bills WHERE id = $1", [b.id]);
    const raw = Math.round((head.s - head.d + lines.tax + head.sc) * 100) / 100;
    const total = Math.round(raw);
    await pool.query("DELETE FROM bill_taxes WHERE bill_id = $1", [b.id]);
    await pool.query(
      "UPDATE bills SET tax_amount = $2, service_charge_tax = 0, cess_amount = 0, total_amount = $3, round_off = $4 WHERE id = $1",
      [b.id, lines.tax, total, Math.round((total - raw) * 100) / 100]
    );
    await O("PUT", `/reports/gst/bills/${b.id}/recipient`, { gstin: G1, legalName: "Bluewave Tech" });
    await pay({ id: b.id, dueAmount: total });
    const pack = await O("GET", `/reports/gst?from=${D0}&to=${D0}&gstin=${R1}`);
    assert.ok(pack.untaxedServiceCharge > 0);
    const P = (v) => Math.round(Number(v || 0) * 100);
    const nil = pack.nilExempt.reduce((s, r) => s + P(r.nilRatedOrExempt), 0);
    assert.equal(
      P(pack.b2b.totals.taxableValue) + P(pack.b2c.totals.taxableValue) + nil + P(pack.untaxedServiceCharge),
      P(pack.registerTotals.taxableValue)
    );
    assert.equal(P(pack.b2b.totals.taxableValue), pack.b2b.invoices.reduce((s, r) => s + P(r.taxableValue), 0));
    assert.ok(pack.checks.find((c) => c.key === "tables").ok);
  });

  await t.test("the manager-PIN prompt for taking off a sent dish shows what it is worth", async () => {
    const o = await order([[dal, 2]], { orderType: "dine_in", tableId: mainTables[1], guestCount: 2 }, {}, captain);
    const line = o.items.find((i) => Number(i.productId) === Number(dal.id));
    const refused = await request(
      "PUT",
      `/orders/${o.id}/items`,
      { changesOnly: true, items: [{ id: line.id, quantity: 1, seenQuantity: 2 }], cancelReason: "quality" },
      null,
      captain
    );
    assert.equal(refused.status, 403);
    const scope = refused.data.scope;
    assert.ok(scope.amount > 0);
    const prompt = await request("GET", `/auth/approvers?permission=orders.cancel_after_kot&scope=${encodeURIComponent(JSON.stringify(scope))}`, undefined, 200, captain);
    const value = prompt.facts.find((f) => /value/i.test(f.label));
    assert.ok(value && value.value.includes("₹"), JSON.stringify(prompt.facts));
    assert.match(prompt.summary, /₹/);
  });

  await t.test("a branch that has closed its day is not read as trading on the main counter's older day", async () => {
    const sheet = await O("GET", "/reports/day-end", undefined, 200, H(C));
    await O("POST", "/business-day/close", { closingCash: sheet.expectedCash }, 200, H(C));
    const z = await O("GET", "/reports/day-end", undefined, 200, H(C));
    assert.equal(Number(z.businessDayId), Number(dayC));
    assert.equal(z.dayStatus, "closed");
    assert.equal(z.variance, 0);
    const dash = await O("GET", "/reports/dashboard", undefined, 200, H(C));
    assert.equal(dash.dayOpen, false);
    assert.equal(dash.businessDate, D1);
    assert.equal(dash.billCount, (await billsOf([dayC])).n);
  });

  await t.test("another restaurant reads none of it", async () => {
    const other = await login("other@branch.invalid");
    await request("GET", `/reports/day-end?businessDayId=${dayA}`, undefined, 404, other);
    const picked = await request("GET", "/reports/dashboard", undefined, null, other, H(A));
    assert.ok(picked.status === 403 || picked.status === 404, JSON.stringify(picked));
    const pack = await request("GET", `/reports/gst?from=${D1}&to=${D1}&gstin=${R2}`, undefined, 200, other);
    assert.equal(pack.register.length, 0);
    assert.ok(!pack.registrations.some((r) => r.invoiceCount > 0));
  });
});
