// The restaurant's own alert and timing rules (migration 1791640001000), end
// to end on a throwaway database of its own (the same pattern as
// restaurant.test.js — never DB_NAME):
//
//   - a new restaurant's rules are exactly the numbers the code used
//     before they were settings, everywhere they are read
//   - the large-discount line moves what the bell's theft alert and
//     the theft report flag; the cash-short alert warns from the cash
//     difference limit and turns critical at the restaurant's line
//   - the lapsed-guest days move Guest insights' "lapsed" list and the
//     guest book's "Lapsed" view together
//   - the cash count takes the restaurant's list of notes
//   - values out of range, of the wrong kind or that do not fit
//     together are refused with a 400, and nothing is saved
//   - the kitchen's pass time sits with its timers
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const { signIn } = require("./helpers/signIn");

test("restaurant rule settings", { timeout: 600000 }, async (t) => {
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
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
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
  const ruleSettings = require("../../src/modules/restaurant/setup/services/ruleSettings.service");
  const theftProvider = require("../../src/notifications/providers/theft");
  const password = crypto.randomBytes(12).toString("hex");

  const made = await restaurantService.createRestaurant({
    name: "Rules Cafe",
    code: "RULESC",
    invoicePrefix: "RC",
    admin: { name: "Rules owner", email: "owner@rules.invalid", password },
  });
  const rid = made.id;

  const app = require("../../src/app");
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, url, body, expected = 200, auth) {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return expected < 300 ? result.data : result;
  }
  const owner = (await signIn(base, "owner@rules.invalid", password)).token;
  const O = (method, url, body, expected = 200) => request(method, url, body, expected, owner);

  // Saves rules the way the settings screen does: the whole form, with the
  // rules among it.
  const saveRules = async (rules, expected = 200) => {
    const current = await O("GET", "/restaurants/current/settings");
    return O("PUT", "/restaurants/current/settings", { ...current, rules: { ...current.rules, ...rules } }, expected);
  };

  // A menu, and a day open.
  const rates = await O("GET", "/menu/tax-rates");
  const category = await O("POST", "/menu/categories", { name: "Mains" }, 201);
  const thali = await O(
    "POST",
    "/menu/products",
    { categoryId: category.id, name: "Thali", price: 500, taxRateId: rates.find((r) => r.isDefault).id, isAvailable: true },
    201
  );
  // Enough float that the count below can hold a ₹2,000 note.
  await O("POST", "/business-day/open", { openingCash: 5000 }, 201);
  const order = (quantity, extra = {}) =>
    O("POST", "/orders", { orderType: "takeaway", ...extra, items: [{ productId: thali.id, quantity }] }, 201);
  const bill = (orderId) => O("POST", "/bills", { orderId }, 201);
  const pay = (b) => O("POST", `/bills/${b.id}/payments`, { paymentMethod: "cash", amount: b.dueAmount }, 201);
  const discounted = async (quantity, percent) => {
    const b = await bill((await order(quantity)).id);
    const adjusted = await O("PATCH", `/bills/${b.id}/adjust`, {
      manualDiscount: { type: "percentage", value: percent },
      discountReason: "regular",
    });
    return pay(adjusted);
  };
  const theftAlerts = async () => theftProvider.collect({ restaurantId: rid, pool });
  const discountAlertFor = (alerts, b) => alerts.find((alert) => alert.id === `theft:discount:${b.id}`);
  const today = (await one("SELECT business_date::text AS d FROM business_days WHERE restaurant_id = $1 AND day_status = 'open'", [rid])).d;
  const range = `?from=${today}&to=${today}`;

  await t.test("a new restaurant's rules are the numbers the code always used", async () => {
    const settings = await O("GET", "/restaurants/current/settings");
    assert.deepEqual(settings.rules, {
      alertLargeDiscountPercent: 20,
      alertLargeDiscountAmount: 1000,
      alertHugeDiscountPercent: 50,
      alertReprintCount: 3,
      alertCashShortCritical: 1000,
      deliverySlaMinutes: 45,
      deliveryWarnMinutes: 30,
      deliveryReadyWaitMinutes: 10,
      deliveryOutWarnMinutes: 45,
      deliveryOutCriticalMinutes: 60,
      reservationLateMinutes: 15,
      reservationLastSeatingMinutes: 30,
      reservationSlotMinutes: 30,
      timeclockLateMinutes: 15,
      timeclockLongBreakMinutes: 45,
      timeclockOvertimeMinutes: 15,
      timeclockEarlyMinutes: 60,
      guestRegularVisits: 3,
      guestRegularDays: 60,
      guestLapsedDays: 45,
      guestNewDays: 30,
      guestBigSpenderPercent: 10,
      reorderLookbackDays: 14,
      reorderSafetyDays: 2,
      reorderHorizonDays: 7,
      cashDenominations: [500, 200, 100, 50, 20, 10],
    });
    // The defaults, for a restaurant with no row, are the same numbers.
    assert.deepEqual(ruleSettings.fromRow(null), settings.rules);

    // Where the rules are read, the old numbers come back.
    const board = await O("GET", "/deliveries/board");
    assert.deepEqual(
      [board.slaMinutes, board.warnMinutes, board.readyWaitMinutes, board.outWarnMinutes, board.outCriticalMinutes],
      [45, 30, 10, 45, 60]
    );
    const host = await O("GET", "/reservations/day");
    assert.equal(host.lateAfterMinutes, 15);
    const insights = await O("GET", "/guest-insights");
    assert.equal(insights.rules.regularVisits, 3);
    assert.equal(insights.rules.regularWindowDays, 60);
    assert.equal(insights.rules.newWindowDays, 30);
    assert.equal(insights.rules.lapsedQuietDays, 45);
    assert.equal(insights.rules.bigSpenderSharePercent, 10);
    const plan = await O("GET", "/inventory-insights/reorder");
    assert.deepEqual([plan.horizon, plan.usageDays, plan.safetyDays], [7, 14, 2]);
    const preview = await O("GET", "/business-day/close-preview");
    assert.deepEqual(preview.rules.denominations, [500, 200, 100, 50, 20, 10]);
    assert.equal((await O("GET", "/kitchen/settings")).passMinutes, 8);
    const theft = await O("GET", `/reports/theft${range}`);
    assert.deepEqual(theft.thresholds, { discountPercent: 20, discountAmount: 1000 });
  });

  let small;
  let big;
  await t.test("the large-discount line moves what the bell and the theft report flag", async () => {
    // ₹1,000 at 15% off (₹150): under 20% and under ₹1,000 — not large.
    small = await discounted(2, 15);
    // ₹1,000 at 25% off: large at the default line, but under half — info.
    big = await discounted(2, 25);

    let alerts = await theftAlerts();
    assert.equal(discountAlertFor(alerts, small), undefined, "15% is under the default 20% line");
    assert.equal(discountAlertFor(alerts, big)?.severity, "info");
    let report = await O("GET", `/reports/theft${range}`);
    assert.equal(report.summary.discounts.count, 1);

    // The owner draws the line at 10% and calls 20% a warning.
    const saved = await saveRules({ alertLargeDiscountPercent: 10, alertHugeDiscountPercent: 20 });
    assert.equal(saved.rules.alertLargeDiscountPercent, 10);
    alerts = await theftAlerts();
    assert.equal(discountAlertFor(alerts, small)?.severity, "info", "15% is now over the 10% line");
    assert.equal(discountAlertFor(alerts, big)?.severity, "warning", "25% is past the 20% warning line");
    report = await O("GET", `/reports/theft${range}`);
    assert.deepEqual(report.thresholds, { discountPercent: 10, discountAmount: 1000 });
    assert.equal(report.summary.discounts.count, 2);
    // A line picked on the report screen still wins over the setting.
    report = await O("GET", `/reports/theft${range}&discountPercent=30`);
    assert.equal(report.summary.discounts.count, 0);

    // A reprint alert at two prints instead of three.
    await pool.query("UPDATE bills SET print_count = 2 WHERE id = $1", [small.id]);
    assert.ok(!(await theftAlerts()).some((alert) => alert.id.startsWith(`theft:reprint:${small.id}:`)));
    await saveRules({ alertReprintCount: 2 });
    assert.ok((await theftAlerts()).some((alert) => alert.id === `theft:reprint:${small.id}:2`));
  });

  await t.test("the lapsed days move Guest insights and the guest book together", async () => {
    const guest = await O("POST", "/crm/customers", { name: "Kavya", mobile: "9876500077" }, 201);
    for (let i = 0; i < 2; i += 1) await pay(await bill((await order(1, { customerId: guest.id })).id));
    // Both visits fifty days ago.
    await pool.query("UPDATE orders SET placed_at = NOW() - INTERVAL '50 days' WHERE customer_id = $1", [guest.id]);

    const lapsedNow = async () => ({
      insights: (await O("GET", "/guest-insights/segments/lapsed")).items.some((row) => Number(row.id) === Number(guest.id)),
      book: (await O("GET", "/crm/guest-book?view=lapsed")).items.some((row) => Number(row.id) === Number(guest.id)),
    });

    // At the default 45 days, fifty days quiet is lapsed on both screens.
    assert.deepEqual(await lapsedNow(), { insights: true, book: true });
    assert.equal((await O("GET", "/crm/guest-book?view=lapsed")).lapsedDays, 45);
    const segment = await O("GET", "/guest-insights/segments/lapsed");
    assert.match(segment.segment.definition, /none in the last 45 days/);

    // At 60 days they are not lapsed yet, on either.
    await saveRules({ guestLapsedDays: 60 });
    assert.deepEqual(await lapsedNow(), { insights: false, book: false });
    assert.match((await O("GET", "/guest-insights/segments/lapsed")).segment.definition, /none in the last 60 days/);

    // Two visits make a regular once the owner says two is enough over 90 days.
    const regulars = async () =>
      (await O("GET", "/guest-insights/segments/regulars")).items.some((row) => Number(row.id) === Number(guest.id));
    assert.equal(await regulars(), false);
    await saveRules({ guestRegularVisits: 2, guestRegularDays: 90 });
    assert.equal(await regulars(), true);
  });

  await t.test("the cash count takes the restaurant's list of notes", async () => {
    const preview = await O("GET", "/business-day/close-preview");
    const inDrawer = preview.figures.inDrawer;
    // Short by ₹500 when counted: a ₹2,000 note, then the rest in ₹500s and
    // coins — ₹2,000 notes are not on the default list, so it is refused.
    const counted = inDrawer - 500;
    const coins = counted - 2000 - 500 * Math.floor((counted - 2000) / 500);
    const notes = { 2000: 1, 500: Math.floor((counted - 2000) / 500), coins };
    const refused = await O(
      "POST",
      "/business-day/close",
      { closingCash: counted, countMethod: "notes", denominations: notes, varianceReason: "Counted twice" },
      400
    );
    assert.match(refused.message, /₹2000 notes are not on this restaurant's cash count/);

    // With ₹2,000 notes on the list the same count closes the day.
    await saveRules({ cashDenominations: [2000, 500, 200, 100, 50, 20, 10] });
    assert.deepEqual((await O("GET", "/business-day/close-preview")).rules.denominations, [2000, 500, 200, 100, 50, 20, 10]);
    await O("POST", "/business-day/close", {
      closingCash: counted,
      countMethod: "notes",
      denominations: notes,
      varianceReason: "Counted twice",
    });

    // ₹500 short: a warning (past the ₹100 cash difference limit, under the
    // ₹1,000 critical line)…
    const short = (await theftAlerts()).find((alert) => alert.id.startsWith("theft:cash-short:"));
    assert.equal(short?.severity, "warning", JSON.stringify(short));
    // …critical once the owner draws that line at ₹400…
    await saveRules({ alertCashShortCritical: 400 });
    assert.equal((await theftAlerts()).find((alert) => alert.id.startsWith("theft:cash-short:"))?.severity, "critical");
    // …and not worth a word when the cash difference limit is above it.
    await pool.query("UPDATE restaurant_settings SET cash_variance_threshold = 600 WHERE restaurant_id = $1", [rid]);
    assert.equal((await theftAlerts()).find((alert) => alert.id.startsWith("theft:cash-short:")), undefined);
  });

  await t.test("values that do not fit are refused, and nothing is saved", async () => {
    const before = await O("GET", "/restaurants/current/settings");
    const refuse = async (rules, pattern) => {
      const result = await O("PUT", "/restaurants/current/settings", { ...before, billFooter: "Changed?", rules }, 400);
      assert.match(result.message, pattern);
    };

    await refuse({ alertLargeDiscountPercent: 0 }, /between 1 and 100/);
    await refuse({ alertLargeDiscountPercent: 101 }, /between 1 and 100/);
    await refuse({ deliverySlaMinutes: 30.5 }, /whole number/);
    await refuse({ guestLapsedDays: "soon" }, /must be a number/);
    await refuse({ reservationSlotMinutes: 25 }, /one of 10, 15, 20, 30, 45, 60/);
    await refuse({ reorderHorizonDays: 31 }, /between 1 and 30/);
    await refuse({ cashDenominations: [] }, /at least one note/);
    await refuse({ cashDenominations: [500, 0.5] }, /whole number of rupees/);
    await refuse({ cashDenominations: "500,200" }, /list of amounts/);
    // Rules that only make sense together, checked against what is saved.
    await refuse({ deliveryWarnMinutes: 50 }, /amber mark \(50 min\) must come before the promise \(45 min\)/);
    await refuse({ deliveryOutCriticalMinutes: 40 }, /must be more than 45 min/);
    await refuse({ alertHugeDiscountPercent: 5 }, /cannot be below where a large discount starts/);

    // Nothing of a refused save is kept — the footer neither.
    const after = await O("GET", "/restaurants/current/settings");
    assert.deepEqual(after.rules, before.rules);
    assert.equal(after.billFooter, before.billFooter);

    // An older screen that sends no rules keeps them all.
    const rest = { ...after };
    delete rest.rules;
    const kept = await O("PUT", "/restaurants/current/settings", rest);
    assert.deepEqual(kept.rules, before.rules);

    // The database refuses what the API would, should anything get past it.
    await assert.rejects(
      pool.query("UPDATE restaurant_settings SET delivery_warn_minutes = 90 WHERE restaurant_id = $1", [rid]),
      /chk_restaurant_settings_delivery_warn/
    );
  });

  await t.test("the kitchen's pass time is saved with its timers", async () => {
    const saved = await O("PUT", "/kitchen/settings", { passMinutes: 12 });
    assert.equal(saved.passMinutes, 12);
    assert.equal(saved.warnMinutes, 10, "the timers are kept");
    assert.equal((await O("GET", "/kitchen/settings")).passMinutes, 12);
    await O("PUT", "/kitchen/settings", { passMinutes: 0 }, 400);
    await O("PUT", "/kitchen/settings", { passMinutes: 2.5 }, 400);
  });
});
