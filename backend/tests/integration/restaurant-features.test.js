const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// Restaurant features (Settings -> Features; migration 1791470000000): each
// feature switched off refuses its endpoints with a 403 naming it, keeps its
// records, and gives everything back when switched on again. Dependencies
// (Loyalty and Online ordering need Guests), refusals that would strand money
// (advances still held, an open cash drawer), owner-only switching, the
// activity log, the Business Admin's modules screen and the public pages.
// Its own throwaway database, like the other integration tests.
test("restaurant features switch on and off", { timeout: 600000 }, async (t) => {
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
  await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"), migrationsTable: "pgmigrations",
    direction: "up", count: Infinity, checkOrder: true, log() {} });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rid = (await one("INSERT INTO restaurants (name, code) VALUES ('Features test', 'FEAT') RETURNING id")).id;
  const other = (await one("INSERT INTO restaurants (name, code) VALUES ('Other place', 'FEAT2') RETURNING id")).id;
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const makeUser = async (restaurantId, email, role) => {
    const user = await one("INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, $2, $2, $3) RETURNING id", [restaurantId, email, hash]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL", [user.id, role]);
    return user;
  };
  const ownerUser = await makeUser(rid, "owner@feat.invalid", "RESTAURANT_ADMIN");
  await makeUser(rid, "manager@feat.invalid", "MANAGER");
  await makeUser(other, "owner@other.invalid", "RESTAURANT_ADMIN");

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = {};
  async function request(method, url, body, expected = 200, who = "owner") {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return expected >= 400 ? result : result.data;
  }
  for (const [who, email] of [["owner", "owner@feat.invalid"], ["manager", "manager@feat.invalid"], ["other", "owner@other.invalid"]]) {
    tokens[who] = (await request("POST", "/auth/login", { identifier: email, password }, 200, null)).token;
  }
  const O = (method, url, body, expected = 200) => request(method, url, body, expected, "owner");
  const setFeature = (code, enabled, expected = 200, who = "owner") =>
    request("PUT", `/restaurants/current/features/${code}`, { enabled }, expected, who);
  // A switched-off endpoint: 403, naming the feature.
  const off = async (method, url, code, body) => {
    const refused = await O(method, url, body, 403);
    assert.equal(refused.data && refused.data.reason, "feature_off", `${url}: ${JSON.stringify(refused)}`);
    assert.equal(refused.data.feature, code);
    assert.match(refused.message, /switched off .*Settings → Features/);
    return refused;
  };
  const featuresNow = async () => (await one("SELECT restaurant_features($1) AS f", [rid])).f;

  // A menu, a table, an open day: the till's everyday work.
  const rate = await O("POST", "/menu/tax-rates", { name: "Food 5%", percentage: 5, hsnCode: "9963" }, 201);
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const dish = await O("POST", "/menu/products", { categoryId: category.id, name: "Dal Tadka", price: 200, taxRateId: rate.id, isAvailable: true }, 201);
  const floor = await O("POST", "/tables/floors", { name: "Ground" }, 201);
  const table = await O("POST", "/tables", { floorId: floor.id, tableNo: "T1", capacity: 4 }, 201);
  await O("POST", "/business-day/open", { openingCash: 0 }, 201);
  const guest = await O("POST", "/crm/customers", { name: "Asha Rao", mobile: "9848011111" }, 201);
  const takeaway = (extra = {}, expected = 201) =>
    O("POST", "/orders", { orderType: "takeaway", ...extra, items: [{ productId: dish.id, quantity: 1 }] }, expected);

  await t.test("every feature starts on (loyalty as the old setting: off); a restaurant with no business yet uses the defaults", async () => {
    assert.equal(await one("SELECT count(*)::int AS n FROM businesses WHERE legacy_restaurant_id = $1", [rid]).then((r) => r.n), 0);
    const list = await O("GET", "/restaurants/current/features");
    assert.equal(list.canChange, true);
    // 14 restaurant features + tasks, issues and projects (1791620000000), which apply to every type,
    // + pre-orders and brands (food formats, 1791950410000 and 1791950411000), which start off like loyalty.
    assert.equal(list.features.length, 19);
    for (const feature of list.features) {
      assert.equal(feature.enabled, !["guest_loyalty", "preorders", "brands"].includes(feature.code), feature.code);
      assert.ok(feature.name && feature.description && feature.group, feature.code);
    }
    assert.deepEqual(list.features.find((f) => f.code === "guest_loyalty").requires, ["guests"]);
    assert.deepEqual(list.features.find((f) => f.code === "guests").requiredBy.sort(), ["guest_loyalty", "online_ordering", "preorders"]);
    const me = await O("GET", "/auth/me");
    assert.equal(me.features.length, 16);
    assert.ok(!me.features.includes("guest_loyalty"));
  });

  await t.test("only the owner switches; others can read the list", async () => {
    const seen = await request("GET", "/restaurants/current/features", undefined, 200, "manager");
    assert.equal(seen.canChange, false);
    await setFeature("tips", false, 403, "manager");
    await request("POST", "/restaurants/current/features/tips/preview", { enabled: false }, 403, "manager");
    await setFeature("tips", "no", 400);
    await setFeature("not_a_feature", false, 404);
    assert.ok((await featuresNow()).includes("tips"));
  });

  await t.test("dependencies: Loyalty and Online ordering need Guests", async () => {
    await setFeature("guest_loyalty", true);
    // The first switch links the restaurant to its business; nobody joins it.
    const business = await one("SELECT id FROM businesses WHERE legacy_restaurant_id = $1", [rid]);
    assert.ok(business);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_memberships WHERE business_id = $1", [business.id])).n, 0);
    const refused = await setFeature("guests", false, 409);
    assert.match(refused.message, /needs Guests/);
    assert.ok(refused.data.blockers.some((line) => /Loyalty points/.test(line)));
    assert.ok(refused.data.blockers.some((line) => /Online ordering/.test(line)));
    await setFeature("guest_loyalty", false);
    await setFeature("online_ordering", false);
    const preview = await O("POST", "/restaurants/current/features/guests/preview", { enabled: false });
    assert.deepEqual(preview.blockers, []);
    assert.ok(preview.warnings.some((line) => /guest book/.test(line)));
    await setFeature("guests", false);
    const needs = await setFeature("guest_loyalty", true, 409);
    assert.match(needs.message, /needs Guests & CRM/);
    await setFeature("online_ordering", true, 409);
    // The database refuses it too, whatever the code does.
    await assert.rejects(pool.query("SELECT restaurant_feature_set($1, 'guest_loyalty', TRUE)", [rid]), /needs guests enabled first/);
    await setFeature("guests", true);
    await setFeature("online_ordering", true);
    await setFeature("guest_loyalty", true);
  });

  await t.test("Guests off: guest book, insights, feedback, guest lookup and picking a guest are refused; the guests are kept", async () => {
    await setFeature("guest_loyalty", false);
    await setFeature("online_ordering", false);
    await setFeature("guests", false);
    await off("GET", "/crm/customers", "guests");
    await off("GET", "/guest-insights", "guests");
    await off("GET", "/crm/feedback", "guests");
    await off("GET", "/crm/complaints", "guests");
    await off("GET", "/orders/guest?mobile=9848011111", "guests");
    await off("POST", "/orders", "guests", { orderType: "takeaway", customerId: guest.id, items: [{ productId: dish.id, quantity: 1 }] });
    // A name and mobile typed at the till stay on the order; nobody is added.
    const before = (await one("SELECT count(*)::int AS n FROM customers WHERE restaurant_id = $1", [rid])).n;
    const order = await takeaway({ customerName: "Walk-in", customerMobile: "9848022222" });
    assert.equal(order.customerId || null, null);
    assert.equal((await one("SELECT count(*)::int AS n FROM customers WHERE restaurant_id = $1", [rid])).n, before);
    await setFeature("guests", true);
    const back = await O("GET", "/crm/customers");
    assert.ok(JSON.stringify(back).includes("Asha Rao"));
    await setFeature("online_ordering", true);
  });

  await t.test("Loyalty off: the programme and its report are refused; the old setting switch drives the same feature", async () => {
    await setFeature("guest_loyalty", false);
    await off("GET", "/discounts/loyalty", "guest_loyalty");
    await off("GET", "/crm/reports/loyalty", "guest_loyalty");
    // Settings still accept loyaltyEnabled (older screens): it is the switch.
    const settings = await O("GET", "/restaurants/current/settings");
    assert.equal(settings.loyaltyEnabled, false);
    const saved = await O("PUT", "/restaurants/current/settings", { ...settings, loyaltyEnabled: true });
    assert.equal(saved.loyaltyEnabled, true);
    assert.ok((await featuresNow()).includes("guest_loyalty"));
    await O("GET", "/discounts/loyalty");
    // The rules stay in settings and are kept while it is off.
    const kept = await O("PUT", "/restaurants/current/settings", { ...saved, loyaltyEarnAmount: 50 });
    assert.equal(kept.loyaltyEarnAmount, 50);
    await setFeature("guest_loyalty", false);
    assert.equal((await O("GET", "/restaurants/current/settings")).loyaltyEarnAmount, 50);
    await setFeature("guest_loyalty", true);
  });

  await t.test("Reservations off: the book and the online booking link are refused; bookings are kept", async () => {
    const link = await O("GET", "/reservations/online-settings");
    const token = link.token || (link.settings && link.settings.token) || (Array.isArray(link) ? link[0].token : null);
    await pool.query(
      `INSERT INTO reservations (restaurant_id, reference_no, guest_name, guest_mobile, party_size, reservation_date, start_time,
         duration_minutes, status, source)
       VALUES ($1, 'R-FEAT-1', 'Kiran', '9848033333', 4, (now() AT TIME ZONE 'Asia/Kolkata')::date + 2, '20:00', 90, 'confirmed', 'phone')`,
      [rid]
    );
    const preview = await O("POST", "/restaurants/current/features/reservations/preview", { enabled: false });
    assert.ok(preview.warnings.some((line) => /still to come/.test(line)), JSON.stringify(preview));
    await setFeature("reservations", false);
    await off("GET", "/reservations/day", "reservations");
    await off("GET", "/reservations", "reservations");
    if (token) {
      const response = await fetch(`${base}/public/booking/${token}`);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).data.feature, "reservations");
    }
    await setFeature("reservations", true);
    const list = await O("GET", "/reservations?from=2000-01-01&to=2100-01-01");
    assert.ok(JSON.stringify(list).includes("R-FEAT-1"));
    if (token) {
      const response = await fetch(`${base}/public/booking/${token}`);
      assert.notEqual(response.status, 403);
    }
  });

  await t.test("QR ordering and Online ordering off: QR codes, the request inbox and the online settings are refused", async () => {
    const tables = await O("GET", "/tables");
    const qrToken = (tables.items || tables).find((row) => Number(row.id) === Number(table.id)).qrToken;
    assert.ok(qrToken);
    assert.equal((await fetch(`${base}/public/tables/${qrToken}/menu`)).status, 200);
    await setFeature("qr_ordering", false);
    const qr = await fetch(`${base}/public/tables/${qrToken}/menu`);
    assert.equal(qr.status, 403);
    assert.equal((await qr.json()).data.feature, "qr_ordering");
    await off("GET", "/tables/qr-settings", "qr_ordering");
    // The inbox still serves the online ordering page...
    await O("GET", "/table-requests/summary");
    await setFeature("online_ordering", false);
    // ...until both are off.
    await off("GET", "/table-requests/summary", "qr_ordering");
    await off("GET", "/orders/service-settings/online-ordering", "online_ordering");
    await setFeature("qr_ordering", true);
    await setFeature("online_ordering", true);
    assert.equal((await fetch(`${base}/public/tables/${qrToken}/menu`)).status, 200);
    await O("GET", "/orders/service-settings/online-ordering");
  });

  await t.test("Deliveries off: the board and delivery orders are refused; sales channels stay", async () => {
    await setFeature("deliveries", false);
    await off("GET", "/deliveries/board", "deliveries");
    await off("GET", "/deliveries/rider-settlements", "deliveries");
    await O("GET", "/deliveries/channels");
    await off("POST", "/orders", "deliveries", { orderType: "delivery", items: [{ productId: dish.id, quantity: 1 }] });
    await setFeature("deliveries", true);
    await O("GET", "/deliveries/board");
    await O("POST", "/orders", { orderType: "delivery", customerName: "Ravi", customerMobile: "9848044444", items: [{ productId: dish.id, quantity: 1 }] }, 201);
  });

  await t.test("Kitchen display off: the board is refused; KOT stations, slips and orders still work", async () => {
    await setFeature("kitchen_display", false);
    await off("GET", "/kitchen/board", "kitchen_display");
    await off("GET", "/reports/live/kitchen", "kitchen_display");
    await O("GET", "/kitchen/stations");
    await O("GET", "/kitchen/slips");
    const order = await takeaway();
    await O("GET", `/kitchen/orders/${order.id}/kots`);
    await setFeature("kitchen_display", true);
    await O("GET", "/kitchen/board");
  });

  await t.test("Captain sections, Coupons, Stock and Staff off: their endpoints are refused, the core ones stay", async () => {
    await setFeature("captain_sections", false);
    await off("GET", "/tables/sections", "captain_sections");
    await O("GET", "/tables/floors");

    await setFeature("coupons", false);
    await off("GET", "/discounts", "coupons");
    await O("GET", "/discounts/given");

    const supplier = await O("POST", "/suppliers", { name: "Veg Mart" }, 201);
    await setFeature("stock_recipes", false);
    await off("GET", "/suppliers", "stock_recipes");
    await off("GET", "/inventory/items", "stock_recipes");
    await off("GET", "/purchase-orders", "stock_recipes");
    await off("GET", `/menu/products/${dish.id}/recipe`, "stock_recipes");
    await off("GET", "/reports/consumption", "stock_recipes");
    await O("GET", "/menu/products");

    await setFeature("staff_payroll", false);
    await off("GET", "/staff", "staff_payroll");
    await off("GET", "/staff/shifts", "staff_payroll");
    await off("GET", "/timeclock/settings", "staff_payroll");
    await off("GET", "/auth/me/work", "staff_payroll");
    await O("GET", "/staff/logbook");
    // Sharing tips out needs both Tips and Staff.
    await off("GET", "/staff/tips", "staff_payroll");

    for (const code of ["captain_sections", "coupons", "stock_recipes", "staff_payroll"]) await setFeature(code, true);
    await O("GET", "/tables/sections");
    await O("GET", "/discounts");
    assert.ok(JSON.stringify(await O("GET", "/suppliers")).includes("Veg Mart"));
    assert.ok(supplier.id);
    await O("GET", "/staff");
    await O("GET", "/staff/tips");
  });

  await t.test("Tips and Advances off: no tip, no paying from an advance; an advance holding money refuses the switch", async () => {
    const advance = await O("POST", "/bills/advances", { customerId: guest.id, amount: 500, paymentMethod: "cash", purpose: "Party on Saturday" }, 201);
    const refused = await setFeature("advances", false, 409);
    assert.equal(refused.data.reason, "feature_blocked");
    assert.match(refused.data.blockers[0], /₹500/);
    assert.ok((await featuresNow()).includes("advances"));

    const order = await takeaway({ customerId: guest.id });
    const bill = await O("POST", "/bills", { orderId: order.id }, 201);
    await setFeature("tips", false);
    await off("POST", `/bills/${bill.id}/payments`, "tips", { paymentMethod: "cash", amount: 50, tipAmount: 20 });

    // Using the advance up on this bill lets Advances be switched off.
    const used = await O("POST", `/bills/${bill.id}/payments`, { paymentMethod: "advance", advanceId: advance.id, amount: Math.min(500, Number(bill.dueAmount)) }, 201);
    assert.ok(used.payments.some((p) => p.paymentMethod === "advance"));
    const left = await one("SELECT amount - used_amount - refunded_amount AS held FROM customer_advances WHERE id = $1", [advance.id]);
    if (Number(left.held) > 0) {
      await O("POST", `/bills/advances/${advance.id}/refunds`, { amount: Number(left.held), refundMethod: "cash", reason: "Party cancelled" }, 201);
    }
    await setFeature("advances", false);
    await off("GET", "/bills/advances", "advances");
    const order2 = await takeaway();
    const bill2 = await O("POST", "/bills", { orderId: order2.id }, 201);
    await off("POST", `/bills/${bill2.id}/payments`, "advances", { paymentMethod: "advance", advanceId: advance.id, amount: 10 });
    await O("POST", `/bills/${bill2.id}/payments`, { paymentMethod: "cash", amount: bill2.dueAmount }, 201);
    await setFeature("advances", true);
    await setFeature("tips", true);
    await O("GET", "/bills/advances");
    assert.ok(await one("SELECT id FROM customer_advances WHERE id = $1", [advance.id]));
  });

  await t.test("Cash drawers off: an open drawer refuses the switch; then the day is one till with its cash in and out", async () => {
    const drawer = await O("POST", "/business-day/drawers", { openingFloat: 0 }, 201);
    const drawerId = (drawer.drawer || drawer).id;
    const refused = await setFeature("cash_drawers", false, 409);
    assert.match(refused.data.blockers[0], /drawer/);
    await O("POST", `/business-day/drawers/${drawerId}/close`, { countedCash: 0, closingCash: 0, countMethod: "total", varianceReason: "Test drawer" });
    await setFeature("cash_drawers", false);
    const list = await O("GET", "/business-day/drawers");
    assert.equal(list.drawersOff, true);
    assert.deepEqual(list.drawers, []);
    await off("POST", "/business-day/drawers", "cash_drawers", { openingFloat: 0 });
    await off("GET", `/business-day/x-report?drawerId=${drawerId}`, "cash_drawers");
    await O("GET", "/business-day/x-report");
    await setFeature("cash_drawers", true);
    assert.equal((await O("GET", "/business-day/drawers")).drawers.length, 1);
  });

  await t.test("the bell leaves out a switched-off feature's alerts", async () => {
    await setFeature("reservations", false);
    const bell = await O("GET", "/notifications");
    assert.ok(!bell.sources.some((source) => source.key === "reservations" || source.key === "bookingRequests"));
    await setFeature("reservations", true);
    const back = await O("GET", "/notifications");
    assert.ok(back.sources.some((source) => source.key === "reservations"));
  });

  await t.test("every switch is in the activity log, and in the business's own audit", async () => {
    const rows = (await pool.query(
      "SELECT action, entity_label, details FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'restaurant_feature' ORDER BY id", [rid])).rows;
    assert.ok(rows.length >= 30, `${rows.length} rows`);
    assert.ok(rows.some((row) => row.action === "feature.disabled" && row.entity_label === "Reservations"));
    assert.ok(rows.some((row) => row.action === "feature.enabled" && row.entity_label === "Loyalty points"));
    const log = await O("GET", "/reports/audit-log?entityType=restaurant_feature&limit=500");
    assert.ok(JSON.stringify(log).includes("feature.disabled"));
    const business = await one("SELECT id FROM businesses WHERE legacy_restaurant_id = $1", [rid]);
    const audit = await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id = $1 AND action IN ('module.enabled', 'module.disabled')", [business.id]);
    assert.equal(audit.n, rows.length);
  });

  await t.test("the Business Admin's modules screen shows and switches the same features", async () => {
    await O("POST", "/businesses/link-restaurant");
    const business = await one("SELECT id FROM businesses WHERE legacy_restaurant_id = $1", [rid]);
    const modules = await O("GET", `/businesses/${business.id}/modules`);
    const tips = modules.find((m) => m.code === "tips");
    assert.equal(tips.enabled, true);
    assert.equal(tips.feature_group, "Money");
    assert.ok(modules.some((m) => m.code === "guest_loyalty" && m.requires.includes("guests")));
    await O("PUT", `/businesses/${business.id}/modules/tips`, { enabled: false });
    assert.ok(!(await featuresNow()).includes("tips"));
    await off("GET", "/staff/tips", "tips");
    const viaAdmin = await one("SELECT details FROM audit_logs WHERE restaurant_id = $1 AND entity_type = 'restaurant_feature' ORDER BY id DESC LIMIT 1", [rid]);
    assert.equal(viaAdmin.details.via, "business_admin");
    // The same money rule: an advance held refuses Advances here too.
    await O("POST", "/bills/advances", { customerId: guest.id, amount: 300, paymentMethod: "cash" }, 201);
    const refused = await O("PUT", `/businesses/${business.id}/modules/advances`, { enabled: false }, 409);
    assert.match(refused.message, /₹300/);
    // Dependencies hold here as well.
    await O("PUT", `/businesses/${business.id}/modules/guests`, { enabled: false }, 409);
    await O("PUT", `/businesses/${business.id}/modules/restaurant`, { enabled: false }, 409);
    await O("PUT", `/businesses/${business.id}/modules/tips`, { enabled: true });
    assert.ok((await featuresNow()).includes("tips"));
  });

  await t.test("one restaurant's switches never touch another's", async () => {
    await setFeature("kitchen_display", false);
    await request("GET", "/kitchen/board", undefined, 200, "other");
    const theirs = await request("GET", "/restaurants/current/features", undefined, 200, "other");
    assert.ok(theirs.features.find((f) => f.code === "kitchen_display").enabled);
    await setFeature("kitchen_display", true);
    assert.ok(ownerUser.id);
  });
});
