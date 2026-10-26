const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// Online table booking for guests: a booking link, the guest's
// request, the host's answer and the guest's own status link, on a throwaway
// database of its own.
const { daysFrom, weekdayOf } = require("./helpers/dates");
const { signIn } = require("./helpers/signIn");
const daysFromToday = (n) => daysFrom(n);
const weekday = weekdayOf;

test("online table booking", { timeout: 600000 }, async (t) => {
  require("dotenv").config({ quiet: true });
  // Never migrate, seed, or erase DB_NAME. Create a unique empty database;
  // cleanup only drops this exact name after all app connections are closed.
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
  await t.test("all migrations install on an empty database", async () => {
    await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"),
      migrationsTable: "pgmigrations", direction: "up", count: Infinity, checkOrder: true, log() {} });
  });
  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];

  const restaurant = await one("INSERT INTO restaurants (name,code,contact) VALUES ('Test restaurant','TEST','98480 22338') RETURNING id");
  const rid = restaurant.id;
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const owner = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,'Test owner','owner@test.invalid',$2) RETURNING id", [rid, hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [owner.id]);
  const captain = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,'Test captain','captain@test.invalid',$2) RETURNING id", [rid, hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='CAPTAIN' AND restaurant_id IS NULL", [captain.id]);
  const other = await one("INSERT INTO restaurants(name,code) VALUES ('Other restaurant','OTHER') RETURNING id");
  const foreign = await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES ($1,'Other owner','other@test.invalid',$2) RETURNING id", [other.id, hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [foreign.id]);
  const floor = await one("INSERT INTO floors(restaurant_id,name) VALUES ($1,'Ground') RETURNING id", [rid]);
  const tables = [];
  for (const no of ["T1", "T2"]) {
    tables.push(await one("INSERT INTO dining_tables(restaurant_id,floor_id,table_no,capacity,qr_token) VALUES ($1,$2,$3,4,md5(random()::text)) RETURNING id", [rid, floor.id, no]));
  }

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, url, body, expected = 200, auth = null) {
    const response = await fetch(base + url, { method, headers: {
      "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result;
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerToken = await login("owner@test.invalid");
  const captainToken = await login("captain@test.invalid");
  const foreignToken = await login("other@test.invalid");

  // Lunch and dinner every day but Monday.
  const week = Array.from({ length: 7 }, (_, day) => (day === 1 ? { dayOfWeek: day, isOpen: false }
    : { dayOfWeek: day, isOpen: true, periods: [{ openTime: "12:00", closeTime: "15:30" }, { openTime: "19:00", closeTime: "23:30" }] }));
  let date = daysFromToday(2);
  while (weekday(date) === 1) date = daysFromToday(3);
  let ahead = 1;
  while (weekday(daysFromToday(ahead)) !== 1) ahead += 1;
  const monday = daysFromToday(ahead);

  const settings = { isEnabled: true, maxPartySize: 6, seatSharePercent: 50, minNoticeMinutes: 60, daysAhead: 30,
    durationMinutes: 90, maxOpenPerMobile: 2, blockedDates: [], guestNote: null };
  let link;

  await t.test("the link is off until a manager turns it on, and needs opening hours", async () => {
    const shown = (await request("GET", "/reservations/online-settings", undefined, 200, ownerToken)).data;
    assert.equal(shown.isEnabled, false);
    assert.match(shown.token, /^[a-f0-9]{32}$/);
    link = shown.token;
    await request("PUT", "/reservations/online-settings", settings, 400, ownerToken);
    await request("PUT", "/restaurants/current/business-hours", { days: week }, 200, ownerToken);
    await request("PUT", "/reservations/online-settings", settings, 403, captainToken);
    const on = (await request("PUT", "/reservations/online-settings", settings, 200, ownerToken)).data;
    assert.equal(on.room.onlineSeats, 4);
  });

  await t.test("closed days are refused in words and times come from the hours", async () => {
    const closed = (await request("GET", `/public/booking/${link}/times?date=${monday}&party=2`)).data;
    assert.equal(closed.open, false);
    assert.match(closed.reason, /closed on Mondays/);
    const times = (await request("GET", `/public/booking/${link}/times?date=${date}&party=2`)).data;
    assert.equal(times.slots[0].time, "12:00");
    assert.equal(times.slots.at(-1).time, "23:00");
    assert.ok(!JSON.stringify(times).includes("table"));
  });

  let guestToken;
  let requestId;
  await t.test("a request holds no table, counts against capacity and is limited per mobile", async () => {
    const sent = await request("POST", `/public/booking/${link}/requests`,
      { date, time: "19:30", partySize: 4, guestName: "Ananya Reddy", guestMobile: "98480 11111", occasion: "birthday" }, 201);
    guestToken = sent.data.guestToken;
    const row = await one("SELECT id, status, table_id, source FROM reservations WHERE guest_token = $1", [guestToken]);
    requestId = Number(row.id);
    assert.deepEqual([row.status, row.table_id, row.source], ["requested", null, "online"]);
    // 8 seats, half online = 4, all asked for at 7:30.
    const full = await request("POST", `/public/booking/${link}/requests`,
      { date, time: "19:30", partySize: 1, guestName: "Rahul Varma", guestMobile: "98480 22222" }, 409);
    assert.match(full.message, /filled up/);
    await request("POST", `/public/booking/${link}/requests`,
      { date, time: "13:00", partySize: 2, guestName: "Ananya Reddy", guestMobile: "+91 98480 11111" }, 201);
    const limited = await request("POST", `/public/booking/${link}/requests`,
      { date, time: "21:30", partySize: 2, guestName: "Ananya Reddy", guestMobile: "9848011111" }, 409);
    assert.match(limited.message, /already has 2/);
  });

  await t.test("staff answer on the board; the guest's link shows the answer; other restaurants see nothing", async () => {
    const board = (await request("GET", `/reservations/day?date=${date}`, undefined, 200, ownerToken)).data;
    assert.equal(board.summary.requested, 2);
    assert.ok(board.bookings.some((b) => b.id === requestId && b.status === "requested"));
    await request("PATCH", `/reservations/${requestId}/accept`, {}, 404, foreignToken);
    await request("GET", `/reservations/${requestId}`, undefined, 404, foreignToken);
    const accepted = (await request("PATCH", `/reservations/${requestId}/accept`, { tableId: Number(tables[0].id) }, 200, captainToken)).data;
    assert.equal(accepted.status, "confirmed");
    assert.equal(accepted.tableNo, "T1");
    const status = (await request("GET", `/public/booking/status/${guestToken}`)).data;
    assert.equal(status.status, "confirmed");
    assert.ok(!JSON.stringify({ ...status, guestToken: null }).includes("\"T1\""));
    // The activity log is written just after the response; wait for it.
    let audit;
    for (let tries = 0; tries < 30 && !audit; tries += 1) {
      audit = await one("SELECT user_name FROM audit_logs WHERE entity_type = 'reservation' AND action = 'accept' AND entity_id = $1", [requestId]);
      if (!audit) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(audit.user_name, "Test captain");

    const second = await one("SELECT id, guest_token FROM reservations WHERE status = 'requested' AND restaurant_id = $1", [rid]);
    await request("PATCH", `/reservations/${second.id}/decline`, {}, 400, ownerToken);
    await request("PATCH", `/reservations/${second.id}/decline`, { reason: "Fully booked that day" }, 200, ownerToken);
    const declined = (await request("GET", `/public/booking/status/${second.guest_token}`)).data;
    assert.equal(declined.status, "declined");
    assert.equal(declined.reason, "Fully booked that day");
  });

  await t.test("the guest cancels from their own link", async () => {
    const cancelled = (await request("POST", `/public/booking/status/${guestToken}/cancel`)).data;
    assert.equal(cancelled.status, "cancelled");
    await request("POST", `/public/booking/status/${guestToken}/cancel`, undefined, 409);
    await request("GET", `/public/booking/status/${"x".repeat(32)}`, undefined, 404);
  });
});
