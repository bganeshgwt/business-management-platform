const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const { addDays } = require("./helpers/dates");

// "Today" is the restaurant's date, wherever the server runs. This server
// keeps UTC−12 and the restaurant keeps Kiritimati time (UTC+14): at every
// hour the restaurant's calendar is a day or two ahead of the server's, so a
// check that took the server's date for the restaurant's fails here whenever
// the test runs, not only in the hours after midnight in India when a server
// on UTC is still on yesterday. Its own throwaway database.
test("dates follow the restaurant's clock, not the server's", { timeout: 300000 }, async (t) => {
  process.env.TZ = "Etc/GMT+12"; // POSIX names flip the sign: this is UTC−12.
  require("dotenv").config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString("hex")}`;
  const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...db, database: "postgres", connectionTimeoutMillis: 10000 });
  let created = false, pool, server;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
  const { runner } = await import("node-pg-migrate");
  await runner({ databaseUrl: { ...db, database }, dir: path.resolve(__dirname, "../../migrations"),
    migrationsTable: "pgmigrations", direction: "up", count: Infinity, checkOrder: true, log() {} });

  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rid = (await one("INSERT INTO restaurants (name,code) VALUES ('Island kitchen','ISLAND') RETURNING id")).id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id, timezone) VALUES ($1, 'Pacific/Kiritimati')", [rid]);
  const password = crypto.randomBytes(16).toString("hex");
  const owner = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,'Owner','owner@island.invalid',$2) RETURNING id",
    [rid, await bcrypt.hash(password, 4)]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [owner.id]);
  const kg = await one("INSERT INTO units(restaurant_id,name,short_name) VALUES ($1,'Kilogram','kg') RETURNING id", [rid]);
  const supplier = await one("INSERT INTO suppliers(restaurant_id,name) VALUES ($1,'Coconut traders') RETURNING id", [rid]);
  const item = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Coconut oil',$2) RETURNING id", [rid, kg.id]);

  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token = null;
  async function request(method, url, body, expected = 200) {
    const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result.data;
  }
  token = (await request("POST", "/auth/login", { identifier: "owner@island.invalid", password })).token;

  const islandDay = (n = 0) => addDays(new Date().toLocaleDateString("en-CA", { timeZone: "Pacific/Kiritimati" }), n);
  const serverDay = new Date().toLocaleDateString("en-CA");
  assert.ok(islandDay() > serverDay, `the restaurant's date (${islandDay()}) is ahead of the server's (${serverDay})`);
  const lines = [{ inventoryItemId: item.id, quantity: 5, unitPrice: 20, taxRate: 0 }];

  await t.test("a supplier's bill, a purchase order and a payment dated today on the restaurant's clock", async () => {
    await request("POST", "/purchase-orders/receipts", { supplierId: supplier.id, billNumber: "K-1", billDate: islandDay(), receivedDate: islandDay(), paymentMode: "credit", lines }, 201);
    // Left out, the bill's date is today on that clock too.
    const undated = await request("POST", "/purchase-orders/receipts", { supplierId: supplier.id, billNumber: "K-2", paymentMode: "credit", lines }, 201);
    assert.equal((await one("SELECT bill_date::text AS day FROM goods_receipts WHERE id=$1", [undated.id])).day, islandDay());
    // Tomorrow is still the future.
    await request("POST", "/purchase-orders/receipts", { supplierId: supplier.id, billNumber: "K-3", billDate: islandDay(1), paymentMode: "credit", lines }, 400);
    const order = await request("POST", "/purchase-orders", { supplierId: supplier.id, items: [{ inventoryItemId: item.id, quantity: 2, unitPrice: 20 }] }, 201);
    assert.equal((await one("SELECT order_date::text AS day FROM purchase_orders WHERE id=$1", [order.id])).day, islandDay());
    await request("POST", "/purchase-returns/payments", { supplierId: supplier.id, amount: 50, paymentDate: islandDay(), paymentMethod: "upi" }, 201);
    await request("POST", "/purchase-returns/payments", { supplierId: supplier.id, amount: 10, paymentDate: islandDay(1), paymentMethod: "upi" }, 400);
  });

  await t.test("a guest born today, and stock valued as of today", async () => {
    await request("POST", "/crm/customers", { name: "Newborn guest", mobile: "9845011111", dateOfBirth: islandDay() }, 201);
    await request("POST", "/crm/customers", { name: "Not born yet", mobile: "9845022222", dateOfBirth: islandDay(1) }, 400);
    const valuation = await request("GET", "/inventory/valuation");
    assert.equal(String(valuation.date).slice(0, 10), islandDay());
  });
});
