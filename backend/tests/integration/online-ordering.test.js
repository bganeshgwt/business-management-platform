const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// The restaurant's own online ordering page: a public link per
// selling point, takeaway and delivery orders that land in the staff inbox,
// acceptance into a Website-channel order with its delivery charge, the
// guest's status page, and the limits per mobile.
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

test("online ordering page", { timeout: 600000 }, async (t) => {
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
    await runner({ databaseUrl: { ...db, database },
      dir: path.resolve(__dirname, "../../migrations"), migrationsTable: "pgmigrations",
      direction: "up", count: Infinity, checkOrder: true, log() {} });
  });
  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const restaurant = await one("INSERT INTO restaurants (name,code,contact) VALUES ('Online test','ONLINE','040 1111 2222') RETURNING id");
  const rid = restaurant.id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id) VALUES ($1)", [rid]);
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const addUser = async (restaurantId, email, role) => {
    const user = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,$2,$2,$3) RETURNING id", [restaurantId, email, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL", [user.id, role]);
    return user;
  };
  await addUser(rid, "owner@test.invalid", "RESTAURANT_ADMIN");
  await addUser(rid, "captain@test.invalid", "CAPTAIN");
  const other = await one("INSERT INTO restaurants(name,code) VALUES ('Other restaurant','OTHER') RETURNING id");
  await addUser(other.id, "other@test.invalid", "RESTAURANT_ADMIN");
  const category = await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Mains') RETURNING id", [rid]);
  const tikka = await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES ($1,$2,'Paneer Tikka',300,5) RETURNING id", [rid, category.id]);
  const naan = await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES ($1,$2,'Butter Naan',60,5) RETURNING id", [rid, category.id]);
  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(method, url, body, expected = 200, auth) {
    const response = await fetch(base + url, { method, headers: {
      "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result;
  }
  const login = async (email) => (await request("POST", "/auth/login", { identifier: email, password })).data.token;
  const owner = await login("owner@test.invalid");
  const captain = await login("captain@test.invalid");
  const foreign = await login("other@test.invalid");
  const SS = "/orders/service-settings/online-ordering";
  let link, website;
  let seq = 0;
  const order = (service, extra = {}) => ({
    clientKey: `itest-${(seq += 1)}-${crypto.randomBytes(4).toString("hex")}`,
    service,
    paymentMode: service === "delivery" ? "cash_on_delivery" : "pay_at_pickup",
    guestName: "Priya Sharma",
    guestMobile: `98200${String(10000 + seq).slice(-5)}`,
    address: service === "delivery" ? "Flat 402, Lake View Apartments, Banjara Hills" : undefined,
    items: [{ productId: tikka.id, quantity: 1 }],
    ...extra,
  });

  await t.test("each selling point gets a link, off until a manager switches it on", async () => {
    await request("POST", "/business-day/open", { businessDate: TODAY, openingCash: 500 }, 201, owner);
    const listed = (await request("GET", SS, undefined, 200, owner)).data;
    assert.equal(listed.links.length, 1);
    link = listed.links[0];
    assert.equal(link.outletId, null);
    assert.equal(link.enabled, false);
    website = (await one("SELECT id FROM sales_channels WHERE restaurant_id=$1 AND channel_type='website'", [rid]));
    await pool.query("UPDATE sales_channels SET delivery_charge=40, delivery_free_above=600 WHERE id=$1", [website.id]);
    const closed = await request("POST", `/public/online/${link.token}/orders`, order("takeaway"), 409);
    assert.match(closed.message, /not taking online orders/);
    await request("PUT", `${SS}/${link.id}`, { enabled: true }, 403, captain);
    await request("PUT", `${SS}/${link.id}`, { enabled: false }, 404, foreign);
    const on = await request("PUT", `${SS}/${link.id}`, { enabled: true, maxOpenPerMobile: 2, minDeliveryOrder: 200 }, 200, owner);
    assert.equal(on.data.live, true);
  });

  await t.test("the guest menu shows the online price, packing, the delivery charge and no online payment", async () => {
    await pool.query(
      "INSERT INTO product_selling_rules(restaurant_id,product_id,channel_id,order_type,price,is_available,packaging_charge) VALUES ($1,$2,$3,'delivery',330,true,15)",
      [rid, tikka.id, website.id]
    );
    const menu = (await request("GET", `/public/online/${link.token}/menu?service=delivery`)).data;
    const dish = menu.categories[0].dishes.find((d) => d.id === tikka.id);
    assert.equal(dish.price, 330);
    assert.equal(dish.packagingCharge, 15);
    assert.deepEqual(menu.delivery, { charge: 40, freeAbove: 600 });
    assert.equal(menu.ordering.onlinePayment.available, false);
    assert.equal(menu.ordering.enabled, true);
  });

  let guestToken, requestId;
  await t.test("a delivery order is checked, priced by the server and lands in the inbox", async () => {
    let refused = await request("POST", `/public/online/${link.token}/orders`, order("delivery", { address: "" }), 400);
    assert.match(refused.message, /delivery address/);
    refused = await request("POST", `/public/online/${link.token}/orders`, order("delivery", { paymentMode: "online" }), 400);
    assert.match(refused.message, /payment gateway/);
    refused = await request("POST", `/public/online/${link.token}/orders`, order("delivery", { items: [{ productId: naan.id, quantity: 1 }] }), 400);
    assert.match(refused.message, /minimum for delivery/);
    const sent = (await request("POST", `/public/online/${link.token}/orders`, order("delivery"), 201)).data;
    guestToken = sent.guestToken;
    assert.equal(sent.order.stage, "sent");
    assert.equal(sent.order.itemsTotal, 362.25);
    assert.equal(sent.order.deliveryCharge, 40);
    const inbox = (await request("GET", "/table-requests?view=pending&type=online", undefined, 200, captain)).data;
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].channel, "website");
    assert.equal(inbox.items[0].serviceType, "delivery");
    requestId = inbox.items[0].id;
    await request("GET", `/table-requests/${requestId}`, undefined, 404, foreign);
  });

  await t.test("accepting makes a Website delivery order with the address and the delivery charge", async () => {
    await request("POST", `/table-requests/${requestId}/accept`, undefined, 404, foreign);
    const accepted = (await request("POST", `/table-requests/${requestId}/accept`, undefined, 200, captain)).data;
    const row = await one("SELECT order_type, source, channel_id, outlet_id, delivery_address, delivery_charge, total_amount FROM orders WHERE id=$1", [accepted.order.id]);
    assert.equal(row.order_type, "delivery");
    assert.equal(row.source, "website");
    assert.equal(Number(row.channel_id), Number(website.id));
    assert.equal(row.outlet_id, null);
    assert.equal(row.delivery_address, "Flat 402, Lake View Apartments, Banjara Hills");
    assert.equal(Number(row.delivery_charge), 40);
    assert.equal(Number(row.total_amount), 362.25);
    const status = (await request("GET", `/public/online/${link.token}/orders/${guestToken}`)).data;
    assert.equal(status.stage, "accepted");
    assert.equal(status.total, 402.25);
    await request("PATCH", `/deliveries/${accepted.order.id}/status`, { status: "ready", confirmPacked: true }, 200, owner);
    await request("PATCH", `/deliveries/${accepted.order.id}/status`, { status: "out_for_delivery", partnerRiderName: "Ravi" }, 200, owner);
    const out = (await request("GET", `/public/online/${link.token}/orders/${guestToken}`)).data;
    assert.equal(out.stage, "out");
  });

  await t.test("a mobile may hold only the link's open orders; the guest can cancel while it waits", async () => {
    const mobile = "9876501234";
    const first = (await request("POST", `/public/online/${link.token}/orders`, order("takeaway", { guestMobile: mobile }), 201)).data;
    await request("POST", `/public/online/${link.token}/orders`, order("takeaway", { guestMobile: mobile }), 201);
    const third = await request("POST", `/public/online/${link.token}/orders`, order("takeaway", { guestMobile: `+91 ${mobile}` }), 409);
    assert.match(third.message, /already has 2 orders in progress/);
    const cancelled = (await request("POST", `/public/online/${link.token}/orders/${first.guestToken}/cancel`)).data;
    assert.equal(cancelled.stage, "cancelled");
    await request("POST", `/public/online/${link.token}/orders`, order("takeaway", { guestMobile: mobile }), 201);
  });

  await t.test("a new link stops the old one; a made-up token is not found", async () => {
    const fresh = (await request("POST", `${SS}/${link.id}/new-link`, undefined, 200, owner)).data;
    await request("GET", `/public/online/${link.token}/menu`, undefined, 404);
    await request("GET", `/public/online/${fresh.token}/menu`, undefined, 200);
    await request("GET", `/public/online/${fresh.token}/orders/${"0".repeat(48)}`, undefined, 404);
  });
});
