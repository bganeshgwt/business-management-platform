// Alerts on a closed phone for the captain app (Web Push), end to end on a
// throwaway database of its own (never DB_NAME), sending only to a pretend
// push service this test runs on 127.0.0.1: never a real push service.
//
//   - the migration's Down half and Up again, found by its slug
//   - the server's key, and saving a phone's subscription: whoever may open
//     the captain app, for the outlet they work in; the same phone again
//     updates it; refusals in words
//   - who is alerted, by the captain app's own rules: a guest's call or a
//     waiter's bill ask at a table, food at the pass; a captain's own tables
//     today, All tables, nobody's section, the outlet, the waiter's own ask
//   - once per moment and phone, however many API processes hear the change
//     (two dispatchers here), and nothing for what is no longer news
//   - the message: encrypted for the phone, VAPID-signed for its push
//     service, TTL, Urgency and Topic, a tag per table, no guest's details
//   - nobody signed out everywhere, whose session ended or who is off shift
//   - a 410 from the push service switches the subscription off for good;
//     the phone is told to subscribe again
//   - a test alert, removal, a renewed subscription moving over, pruning
//   - a consumer of the live updates that fails never stops the others
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { signIn, passwordOf } = require("./helpers/signIn");
const pushService = require("./helpers/pushService");

test("alerts on a closed phone: who, once, and the message", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres" });
  let created = false, pool, server, hub, service;
  await admin.connect();
  t.after(async () => {
    if (hub) await hub.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (service) await service.close();
    if (pool) await pool.end();
    try {
      if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) {
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      }
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  process.env.LOGIN_ATTEMPT_LIMIT = "500";
  // The server's own key pair for this run, made as npm run push:keys makes it.
  const webPush = require("../../src/modules/push/services/webPush");
  const vapid = webPush.generateKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = "mailto:alerts@example.com";
  const { runner } = await import("node-pg-migrate");
  const dir = path.resolve(__dirname, "../../migrations");
  const migrate = (options) => runner({ databaseUrl: { ...db, database }, dir, migrationsTable: "pgmigrations", checkOrder: true, log() {}, ...options });
  await migrate({ direction: "up", count: Infinity });

  pool = require("../../src/config/database");

  // The migration's Down half (after those of any newer one), by its slug,
  // then Up again: its two tables go and come back.
  const pushTables = async () => (await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('push_subscriptions','push_deliveries')")).rows[0].n;
  const file = fs.readdirSync(dir).find((name) => name.endsWith("_staff-app-push.sql"));
  await migrate({ direction: "down", count: Number(file.split("_")[0]), timestamp: true });
  assert.equal(await pushTables(), 0, "Down removes both tables");
  await migrate({ direction: "up", count: Infinity });
  assert.equal(await pushTables(), 2, "Up makes them again");
  const config = require("../../src/config/env");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const addUser = async (rid, name, email, roleCode, outletId = null) => {
    const user = await one(
      "INSERT INTO users (restaurant_id,name,email,password_hash,outlet_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [rid, name, email, hash, outletId]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL", [user.id, roleCode]);
    return user;
  };

  // A restaurant with a main room and the outlet Banjara Hills; captains
  // Ramesh (T1 today), Priya (no section) and Sunil (tied to the outlet);
  // the kitchen and the owner; another restaurant with its own captain.
  const rid = (await one("INSERT INTO restaurants (name,code) VALUES ('Push test','PUSH') RETURNING id")).id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1) ON CONFLICT DO NOTHING", [rid]);
  const outletA = await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Banjara Hills','BH') RETURNING id", [rid]);
  await addUser(rid, "Owner", "owner@test.invalid", "RESTAURANT_ADMIN");
  const ramesh = await addUser(rid, "Ramesh", "ramesh@test.invalid", "CAPTAIN");
  const priya = await addUser(rid, "Priya", "priya@test.invalid", "CAPTAIN");
  const sunil = await addUser(rid, "Sunil", "sunil@test.invalid", "CAPTAIN", outletA.id);
  await addUser(rid, "Cook", "cook@test.invalid", "KITCHEN");
  const other = (await one("INSERT INTO restaurants(name,code) VALUES ('Other','OTHP') RETURNING id")).id;
  await addUser(other, "Other captain", "other@test.invalid", "CAPTAIN");
  await addUser(other, "Other owner", "other-owner@test.invalid", "RESTAURANT_ADMIN");
  const category = await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Food') RETURNING id", [rid]);
  const tikka = await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES ($1,$2,'Paneer Tikka',300,5) RETURNING id", [rid, category.id]);
  const floor = await one("INSERT INTO floors(restaurant_id,name) VALUES ($1,'Hall') RETURNING id", [rid]);
  const table = async (no, restaurantId = rid, outletId = null, floorId = floor.id) =>
    one("INSERT INTO dining_tables(restaurant_id,floor_id,table_no,capacity,qr_token,outlet_id) VALUES ($1,$2,$3,4,$4,$5) RETURNING id, qr_token",
      [restaurantId, floorId, no, crypto.randomBytes(16).toString("hex"), outletId]);
  const T1 = await table("T1");
  const T2 = await table("T2");
  const A1 = await table("A1", rid, outletA.id);
  const otherFloor = await one("INSERT INTO floors(restaurant_id,name) VALUES ($1,'Hall') RETURNING id", [other]);
  const X1 = await table("X1", other, null, otherFloor.id);

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const send = async (method, url, body, token, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  };
  const expect = async (method, url, body, expected, token, headers) => {
    const result = await send(method, url, body, token, headers);
    assert.equal(result.status, expected, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const sessions = {};
  const login = async (email) => (await signIn(base, email, password)).token;
  sessions.owner = await login("owner@test.invalid");
  sessions.ramesh = await login("ramesh@test.invalid");
  sessions.priya = await login("priya@test.invalid");
  sessions.sunil = await login("sunil@test.invalid");
  sessions.cook = await login("cook@test.invalid");
  sessions.other = await login("other@test.invalid");
  sessions.otherOwner = await login("other-owner@test.invalid");
  await expect("POST", "/business-day/open", { openingCash: 1000 }, 201, sessions.owner);
  await expect("POST", "/business-day/open", { openingCash: 500 }, 201, sessions.owner, { "X-Outlet-Id": String(outletA.id) });
  await expect("POST", "/business-day/open", { openingCash: 500 }, 201, sessions.otherOwner);
  // Ramesh has T1 today; Priya and Sunil have no section.
  await expect("PUT", "/tables/sections", { assignments: [{ userId: ramesh.id, tableId: T1.id }] }, 200, sessions.owner);

  // The pretend push service, and a pretend phone per captain.
  service = await pushService.start();
  const phones = { ramesh: pushService.phone(), priya: pushService.phone(), sunil: pushService.phone(), other: pushService.phone() };
  const subscription = (name, endpoint = service.endpoint(name)) =>
    ({ endpoint, keys: { p256dh: phones[name].p256dh, auth: phones[name].auth } });
  const read = (message) => JSON.parse(pushService.decrypt(message.body, phones[message.name]).text);

  // The live updates heard by two dispatchers, as two API processes would.
  hub = require("../../src/modules/live/services/liveHub");
  const { createDispatcher } = require("../../src/modules/push/services/captainPush");
  const working = [];
  const dispatchers = [createDispatcher({ retryMs: 50 }), createDispatcher({ retryMs: 50 })];
  const consumers = dispatchers.map((dispatcher) => hub.onChange((note) => { working.push(dispatcher.handle(note)); }));
  await hub.start();
  // Waits for the changes heard so far to be dealt with, and for the messages to arrive.
  const settle = async (ms = 600) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    while (working.length) await Promise.allSettled(working.splice(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  const names = () => service.received.map((message) => message.name).sort();
  let t1Order = null;
  // A guest's call from a table's QR code: a new one (201), or counted on the
  // same kind of call still open there (200).
  const call = async (tableRow, type = "water") => {
    // "Something else" says what: Raju, 98480 11101 (a guest's own words, never on a phone's alert).
    const answer = await send("POST", `/public/tables/${tableRow.qr_token}/calls`, { type, ...(type === "other" ? { message: "Raju, 98480 11101: an extra plate" } : {}) });
    assert.ok([200, 201].includes(answer.status), `a ${type} call at ${tableRow.id}: ${JSON.stringify(answer.body)}`);
    return answer.body.data;
  };
  t.after(() => consumers.forEach((stop) => stop()));

  await t.test("the server's key, and saving a phone's subscription", async () => {
    assert.deepEqual((await expect("GET", "/push/key", undefined, 200)).data, { publicKey: vapid.publicKey });
    const kept = config.push;
    config.push = null;
    try {
      const off = await expect("GET", "/push/key", undefined, 404);
      assert.equal(off.data.reason, "push_off");
      assert.equal(off.message, "Alerts on a closed phone are not set up on this server.");
      await expect("POST", "/push/subscriptions", { subscription: subscription("ramesh") }, 404, sessions.ramesh);
    } finally {
      config.push = kept;
    }

    const saved = await expect("POST", "/push/subscriptions", { purpose: "captain", subscription: subscription("ramesh") }, 201, sessions.ramesh);
    assert.equal(saved.message, "Alerts are on for this phone.");
    assert.deepEqual(Object.keys(saved.data).sort(), ["allTables", "createdAt", "lastSuccessAt", "outletId", "purpose", "sessionEndsAt", "watchingSince"]);
    assert.equal(saved.data.outletId, null);
    assert.equal(saved.data.allTables, false);
    assert.ok(!JSON.stringify(saved).includes(phones.ramesh.auth), "the phone's secret is never sent back");
    // The same phone again: brought up to date, alerts not started afresh.
    const again = await expect("POST", "/push/subscriptions", { subscription: subscription("ramesh") }, 200, sessions.ramesh);
    assert.equal(again.data.watchingSince, saved.data.watchingSince);
    // Sunil works at the outlet he is tied to; Priya across the restaurant.
    assert.equal((await expect("POST", "/push/subscriptions", { subscription: subscription("sunil") }, 201, sessions.sunil)).data.outletId, Number(outletA.id));
    await expect("POST", "/push/subscriptions", { subscription: subscription("priya") }, 201, sessions.priya);
    await expect("POST", "/push/subscriptions", { subscription: subscription("other") }, 201, sessions.other);

    const row = await one("SELECT user_id, restaurant_id, outlet_id, token_version, session_ends_at, user_agent FROM push_subscriptions WHERE endpoint = $1",
      [service.endpoint("ramesh")]);
    assert.equal(Number(row.user_id), Number(ramesh.id));
    assert.equal(Number(row.restaurant_id), Number(rid));
    const exp = JSON.parse(Buffer.from(sessions.ramesh.split(".")[1], "base64url")).exp;
    assert.equal(row.session_ends_at.getTime(), exp * 1000, "bounded by the session it was made in");

    // Refusals.
    const refused = async (body, status, token = sessions.priya, pattern = null) => {
      const answer = await expect("POST", "/push/subscriptions", body, status, token);
      if (pattern) assert.match(answer.message, pattern);
      return answer;
    };
    await refused({ subscription: subscription("priya", "https://example.com/push/1") }, 400, sessions.priya, /push service is not one this server sends alerts through/);
    await refused({ subscription: subscription("priya", "http://10.1.1.1/push/1") }, 400);
    await refused({ subscription: { endpoint: service.endpoint("x"), keys: { p256dh: "short", auth: phones.priya.auth } } }, 400, sessions.priya, /p256dh/);
    await refused({ subscription: { endpoint: service.endpoint("x"), keys: { p256dh: phones.priya.p256dh, auth: "short" } } }, 400, sessions.priya, /auth/);
    await refused({ subscription: subscription("priya"), purpose: "marketing" }, 400, sessions.priya, /captain/);
    await refused({ subscription: subscription("priya"), allTables: "yes" }, 400, sessions.priya, /All tables/);
    await refused({}, 400, sessions.priya, /endpoint and keys/);
    await refused({ subscription: subscription("priya") }, 401, null);
    await refused({ subscription: subscription("priya") }, 403, sessions.cook);
    await expect("PUT", "/restaurants/current/features/captain_app", { enabled: false }, 200, sessions.owner);
    try {
      const off = await refused({ subscription: subscription("priya") }, 403);
      assert.equal(off.data.reason, "feature_off");
    } finally {
      await expect("PUT", "/restaurants/current/features/captain_app", { enabled: true }, 200, sessions.owner);
    }
  });

  await t.test("a guest's call: the captain of the table, and whoever has no section; once each", async () => {
    // Settle what the set-up announced first: nothing of it is a moment.
    await settle();
    assert.deepEqual(names(), []);
    const water = await call(T1, "water");
    await settle();
    assert.deepEqual(names(), ["priya", "ramesh", "sunil"], "T1 is Ramesh's; Priya and Sunil have no section and see T1 (no outlet)");
    const message = service.to("ramesh")[0];
    assert.deepEqual(read(message), { title: "Table T1 asked for water", body: "Asked for water from the table's QR code", url: "/captain/calls",
      tag: `table-${T1.id}`, kind: "call", table: "T1", orderId: null });
    assert.equal(message.headers.ttl, "120");
    assert.equal(message.headers.urgency, "high");
    assert.equal(message.headers.topic, `t${T1.id}call`);
    assert.equal(message.headers["content-encoding"], "aes128gcm");
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(message.headers.authorization);
    assert.equal(key, vapid.publicKey);
    const claims = webPush.verifyVapidToken(token, vapid.publicKey).claims;
    assert.equal(claims.aud, service.origin);
    assert.equal(claims.sub, "mailto:alerts@example.com");
    assert.ok(claims.exp * 1000 - Date.now() <= 24 * 3600 * 1000);

    // Answering it is no news; neither is asking again for the same (it counts on the open call).
    service.clear();
    await call(T1, "water");
    await expect("POST", `/table-requests/${water.id}/acknowledge`, undefined, 200, sessions.ramesh);
    await expect("POST", `/table-requests/${water.id}/done`, undefined, 200, sessions.ramesh);
    await settle();
    assert.deepEqual(names(), []);
    const rows = await pool.query("SELECT moment FROM push_deliveries ORDER BY moment");
    assert.deepEqual([...new Set(rows.rows.map((row) => row.moment))], [`call:${water.id}`], "one delivery row per phone for the call");
  });

  await t.test("the captain's own tables, All tables, the outlet, and a waiter's own bill ask", async () => {
    service.clear();
    await call(T2, "call_waiter");
    await settle();
    assert.deepEqual(names(), ["priya", "sunil"], "T2 is not Ramesh's");
    assert.equal(read(service.to("priya")[0]).title, "Table T2 is calling");

    service.clear();
    await call(A1, "water");
    await settle();
    assert.deepEqual(names(), ["priya", "sunil"], "A1 is the outlet's: Sunil's and every table's Priya");
    assert.equal(read(service.to("sunil")[0]).body, "Asked for water from the table's QR code · Banjara Hills");

    // Ramesh takes T1's order; Priya asks the counter for its bill: her own
    // ask never rings her phone.
    t1Order = (await expect("POST", "/orders", { orderType: "dine_in", tableId: T1.id, guestCount: 2, source: "captain",
      items: [{ productId: tikka.id, quantity: 2 }] }, 201, sessions.ramesh)).data;
    await settle();
    assert.deepEqual(names(), ["priya", "sunil"], "a new ticket is no news");
    service.clear();
    await expect("POST", "/table-requests/bill-asks", { tableId: T1.id, clientKey: crypto.randomUUID() }, 201, sessions.priya);
    await settle();
    assert.deepEqual(names(), ["ramesh", "sunil"]);
    assert.deepEqual([read(service.to("ramesh")[0]).title, read(service.to("ramesh")[0]).body], ["Table T1 wants the bill", "Asked from the captain app"]);

    // Ramesh chooses All tables: alerts follow every table from now on.
    service.clear();
    const all = await expect("POST", "/push/subscriptions", { subscription: subscription("ramesh"), allTables: true }, 200, sessions.ramesh);
    assert.equal(all.data.allTables, true);
    await call(T2, "other");
    await settle();
    assert.deepEqual(names(), ["priya", "ramesh", "sunil"]);
    assert.equal(read(service.to("ramesh")[0]).title, "Table T2 needs something");
    assert.ok(!/Raju|98480|plate/.test(JSON.stringify(read(service.to("ramesh")[0]))), "never the guest's own words, name or number");
    await expect("POST", "/push/subscriptions", { subscription: subscription("ramesh"), allTables: false }, 200, sessions.ramesh);

    // Another restaurant's call reaches its own captain only.
    service.clear();
    await call(X1, "water");
    await settle();
    assert.deepEqual(names(), ["other"]);
  });

  await t.test("food at the pass: the table's captain and every table's, at the outlet of the ticket", async () => {
    service.clear();
    const order = t1Order;
    const [ticket] = (await expect("GET", `/kitchen/orders/${order.id}/kots`, undefined, 200, sessions.cook)).data;
    await expect("PATCH", `/kitchen/kots/${ticket.id}/status`, { status: "cooking" }, 200, sessions.cook);
    await settle();
    assert.deepEqual(names(), [], "cooking is no news");
    await expect("PATCH", `/kitchen/kots/${ticket.id}/status`, { status: "ready" }, 200, sessions.cook);
    await settle();
    assert.deepEqual(names(), ["priya", "ramesh"], "Sunil works at the outlet: the main room's pass is not his");
    const food = service.to("ramesh")[0];
    assert.deepEqual(read(food), { title: "Table T1: 2 dishes ready", body: "At the pass, to carry out", url: "/captain/ready",
      tag: `table-${T1.id}`, kind: "ready", table: "T1", orderId: String(order.id) });
    assert.equal(food.headers.ttl, "300");
    assert.equal(food.headers.topic, `t${T1.id}food`);

    // Served: no news, and reading the pass again sends nothing more.
    service.clear();
    await expect("PATCH", `/kitchen/kots/${ticket.id}/status`, { status: "served" }, 200, sessions.ramesh);
    await settle();
    assert.deepEqual(names(), []);
  });

  await t.test("once per moment, however many processes hear it", async () => {
    service.clear();
    const water = await call(T2, "water");
    await settle();
    const before = names();
    assert.deepEqual(before, ["priya", "sunil"]);
    // The same change heard again by both dispatchers at once: nothing more.
    const note = { restaurant: Number(rid), area: "table_request", id: Number(water.id) };
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.handle(note)));
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.handle(note)));
    await settle(200);
    assert.deepEqual(names(), before);
    await expect("POST", `/table-requests/${water.id}/done`, undefined, 200, sessions.priya);
  });

  await t.test("nobody signed out everywhere, whose session ended, or who is off shift", async () => {
    // Priya's password changes: every session of hers ends, and her phone is sent nothing.
    const priyaOwn = passwordOf(base, "priya@test.invalid", password);
    await expect("POST", "/auth/change-password", { currentPassword: priyaOwn, newPassword: `Own-${crypto.randomBytes(9).toString("hex")}` }, 200, sessions.priya);
    // Sunil's session has run out.
    await pool.query("UPDATE push_subscriptions SET session_ends_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [sunil.id]);
    // Ramesh clocked out on the time clock (Staff is on): off shift.
    const employee = await one("INSERT INTO employees (restaurant_id, user_id, name, employee_code) VALUES ($1, $2, 'Ramesh', 'E-PUSH-1') RETURNING id", [rid, ramesh.id]);
    const today = (await one("SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS d")).d;
    await pool.query(`INSERT INTO attendance_punches (restaurant_id, employee_id, work_date, punch_type, punched_at)
      VALUES ($1, $2, $3, 'clock_in', NOW() - INTERVAL '5 hours'), ($1, $2, $3, 'clock_out', NOW() - INTERVAL '10 minutes')`, [rid, employee.id, today]);
    service.clear();
    const water = await call(T1, "water");
    await settle();
    assert.deepEqual(names(), []);
    // Back on shift: alerts again.
    await pool.query("INSERT INTO attendance_punches (restaurant_id, employee_id, work_date, punch_type, punched_at) VALUES ($1, $2, $3, 'clock_in', NOW())",
      [rid, employee.id, today]);
    await expect("POST", `/table-requests/${water.id}/done`, undefined, 200, sessions.ramesh);
    await call(T1, "call_waiter");
    await settle();
    assert.deepEqual(names(), ["ramesh"]);
  });

  await t.test("a push service's 410 switches the phone off for good, and it is asked to subscribe again", async () => {
    service.clear();
    service.answer("ramesh", 410);
    await call(T1, "other");
    await settle();
    assert.equal(service.to("ramesh").length, 1, "tried once: a 410 is not tried again");
    const row = await one("SELECT disabled_at, disabled_reason, p256dh, auth FROM push_subscriptions WHERE endpoint = $1", [service.endpoint("ramesh")]);
    assert.ok(row.disabled_at);
    assert.equal(row.disabled_reason, "push service 410");
    assert.equal(row.p256dh, null, "its keys are wiped");
    assert.equal(row.auth, null);
    service.clear();
    await call(T1, "other");
    await settle();
    assert.deepEqual(names(), []);
    const gone = await expect("POST", "/push/subscriptions", { subscription: subscription("ramesh") }, 409, sessions.ramesh);
    assert.equal(gone.data.reason, "subscription_gone");
    // The phone subscribes afresh, at a new address.
    service.answer("ramesh-2", 201);
    await expect("POST", "/push/subscriptions", { subscription: subscription("ramesh", service.endpoint("ramesh-2")) }, 201, sessions.ramesh);
  });

  await t.test("a test alert, removing a phone, a renewed subscription, pruning", async () => {
    service.clear();
    const sent = await expect("POST", "/push/test", { endpoint: service.endpoint("ramesh-2") }, 200, sessions.ramesh);
    assert.deepEqual(sent.data, { sent: true });
    const [testMessage] = service.to("ramesh-2");
    assert.deepEqual(JSON.parse(pushService.decrypt(testMessage.body, phones.ramesh).text),
      { title: "Test alert", body: "Alerts reach this phone even while the captain app is closed.", url: "/captain", tag: "test", kind: "test" });
    await expect("POST", "/push/test", { endpoint: service.endpoint("other") }, 404, sessions.ramesh, undefined);
    service.answer("ramesh-2", 410);
    assert.equal((await expect("POST", "/push/test", { endpoint: service.endpoint("ramesh-2") }, 409, sessions.ramesh)).data.reason, "subscription_gone");

    // Removing: by the phone's endpoint, once.
    const removed = await expect("DELETE", "/push/subscriptions", { endpoint: service.endpoint("other") }, 200, sessions.other);
    assert.deepEqual(removed.data, { removed: true });
    assert.deepEqual((await expect("DELETE", "/push/subscriptions", { endpoint: service.endpoint("other") }, 200, sessions.other)).data, { removed: false });
    await expect("DELETE", "/push/subscriptions", {}, 400, sessions.other);

    // A renewed subscription (the service worker's pushsubscriptionchange):
    // the old address and its secret move it to the new one.
    await expect("POST", "/push/subscriptions", { subscription: subscription("other") }, 201, sessions.other);
    const fresh = pushService.phone();
    const renewal = { oldEndpoint: service.endpoint("other"), subscription: { endpoint: service.endpoint("other-2"), keys: { p256dh: fresh.p256dh, auth: fresh.auth } } };
    await expect("POST", "/push/subscriptions/renew", { ...renewal, oldAuth: phones.priya.auth }, 404);
    await expect("POST", "/push/subscriptions/renew", { ...renewal, oldAuth: phones.other.auth }, 200);
    phones["other-2"] = fresh;
    service.clear();
    await call(X1, "call_waiter");
    await settle();
    assert.deepEqual(names(), ["other-2"]);
    assert.equal(JSON.parse(pushService.decrypt(service.to("other-2")[0].body, fresh).text).title, "Table X1 is calling");

    // Pruning: phones dropped 30 days ago, and deliveries two days old.
    await pool.query("UPDATE push_subscriptions SET disabled_at = NOW() - INTERVAL '31 days' WHERE endpoint = $1", [service.endpoint("ramesh")]);
    await pool.query("UPDATE push_deliveries SET created_at = NOW() - INTERVAL '3 days'");
    const repo = require("../../src/modules/push/repositories/push.repository");
    const pruned = await repo.prune(pool);
    assert.equal(pruned.phones, 1);
    assert.ok(pruned.deliveries > 0);
    assert.equal((await one("SELECT COUNT(*)::int AS n FROM push_deliveries")).n, 0);
  });

  await t.test("a live updates consumer that fails never stops the others", async () => {
    const stopThrowing = hub.onChange(() => { throw new Error("broken consumer"); });
    const stopRejecting = hub.onChange(async () => { throw new Error("broken consumer"); });
    try {
      service.clear();
      await call(X1, "other");
      await settle();
      assert.deepEqual(names(), ["other-2"]);
    } finally {
      stopThrowing();
      stopRejecting();
    }
  });
});
