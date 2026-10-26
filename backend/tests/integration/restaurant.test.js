const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcrypt");

// The restaurant's own calendar date (Asia/Kolkata). Only today's business day
// can be opened, so dated steps use today and days counted from it.
const { today, daysFrom } = require("./helpers/dates");
const { signIn, passwordOf } = require("./helpers/signIn");
const TODAY = today();
const daysFromToday = (n) => daysFrom(n);

test("isolated restaurant workflows", { timeout: 600000 }, async (t) => {
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
  const migrationOptions = { databaseUrl: { ...db, database },
    dir: path.resolve(__dirname, "../../migrations"), migrationsTable: "pgmigrations",
    direction: "up", count: Infinity, checkOrder: true, log() {} };
  await t.test("all migrations install on an empty database", async () => {
    await runner(migrationOptions);
  });
  pool = require("../../src/config/database");
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const restaurant = await one("INSERT INTO restaurants (name,code) VALUES ('Test restaurant','TEST') RETURNING id");
  const rid = restaurant.id;
  await pool.query("INSERT INTO restaurant_settings (restaurant_id,auto_consume_stock,loyalty_earn_amount,loyalty_point_value,loyalty_min_redeem) VALUES ($1,true,100,1,1)", [rid]);
  // Loyalty on is the Loyalty points feature (Settings -> Features).
  await pool.query("SELECT restaurant_feature_set($1, 'guest_loyalty', TRUE)", [rid]);
  const guest = await one("INSERT INTO customers(restaurant_id,name,mobile) VALUES ($1,'Test guest','9876543210') RETURNING id", [rid]);
  const password = crypto.randomBytes(16).toString("hex");
  const hash = await bcrypt.hash(password, 4);
  const user = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,'Test owner','owner@test.invalid',$2) RETURNING id", [rid,hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [user.id]);
  const kitchen = await one("INSERT INTO users (restaurant_id,name,email,password_hash) VALUES ($1,'Test cook','cook@test.invalid',$2) RETURNING id", [rid,hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='KITCHEN' AND restaurant_id IS NULL", [kitchen.id]);
  const other = await one("INSERT INTO restaurants(name,code) VALUES ('Other restaurant','OTHER') RETURNING id");
  const foreignUser = await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES ($1,'Other owner','other@test.invalid',$2) RETURNING id", [other.id,hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [foreignUser.id]);
  const category = await one("INSERT INTO categories(restaurant_id,name) VALUES ($1,'Food') RETURNING id",[rid]);
  const product = await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES ($1,$2,'Test meal',100,5) RETURNING id", [rid,category.id]);
  const unit = await one("INSERT INTO units(restaurant_id,name,short_name) VALUES ($1,'Kilogram','kg') RETURNING id", [rid]);
  const ingredient = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id,last_cost) VALUES ($1,'Rice',$2,50) RETURNING id",[rid,unit.id]);
  await require("../../src/modules/restaurant/inventory/services/inventory.service").recordMovement(rid, {
    inventoryItemId: ingredient.id, quantity: 10, unitCost: 50, transactionType: "opening",
    outletId: null, reason: "Test opening stock", notes: null,
  }, user.id);
  await pool.query("INSERT INTO product_recipes(restaurant_id,product_id,inventory_item_id,quantity) VALUES ($1,$2,$3,0.2)", [rid,product.id,ingredient.id]);
  const app = require("../../src/app");
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token;
  async function request(method, url, body, expected = 200, auth = token, headers = {}) {
    const response = await fetch(base + url, { method, headers: {
      "Content-Type": "application/json", ...headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(result)}`);
    return result.data;
  }
  await t.test("password login and authentication enforcement", async () => {
    await request("GET", "/users", undefined, 401, null);
    const session = await signIn(base, "owner@test.invalid", password);
    token = session.token;
    assert.ok(token);
    await request("GET", "/auth/me");
  });
  await t.test("kitchen role cannot read financial reports", async () => {
    const session = await signIn(base, "cook@test.invalid", password);
    await request("GET", "/reports/profit-loss", undefined, 403, session.token);
  });
  await t.test("invalid day inputs do not write business days", async () => {
    await request("POST", "/business-day/open", { businessDate: "2026-02-30" }, 400);
    assert.equal(Number((await one("SELECT count(*) AS count FROM business_days")).count), 0);
    await request("POST", "/business-day/open", { businessDate: TODAY, openingCash: 500 }, 201);
    await request("POST", "/business-day/close", {}, 400);
    await request("POST", "/business-day/close", { closingCash: " " }, 400);
    assert.equal((await one("SELECT day_status FROM business_days")).day_status, "open");
  });
  await t.test("service, channel and outlet prices enforce availability and preserve saved prices", async () => {
    const dish = await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES ($1,$2,'Pricing test',100,5) RETURNING id",[rid,category.id]);
    const variant = await one("INSERT INTO product_variants(restaurant_id,product_id,name,price_delta) VALUES ($1,$2,'Large',20) RETURNING id",[rid,dish.id]);
    const channel = await one("INSERT INTO sales_channels(restaurant_id,name,commission_percent) VALUES ($1,'Phone',10) RETURNING id",[rid]);
    const outlet = await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Branch','BRANCH') RETURNING id",[rid]);
    const foreignOutlet = await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Foreign','FOREIGN') RETURNING id",[other.id]);
    const path = `/menu/products/${dish.id}/selling-rules`;
    await request("PUT",path,{orderType:"takeaway",price:120});
    const channelRule = await request("PUT",path,{channelId:channel.id,price:150});
    const branchRule = await request("PUT",path,{outletId:outlet.id,price:175});
    await request("PUT",path,{outletId:foreignOutlet.id,price:1},400);
    await request("PUT",path,{price:1},400);
    const cook = await signIn(base,"cook@test.invalid",password);
    await request("PUT",path,{orderType:"takeaway",price:1},403,cook.token);
    const foreign = await signIn(base,"other@test.invalid",password);
    await request("DELETE",`/menu/selling-rules/${channelRule.id}`,undefined,404,foreign.token);
    const preview = async (query, headers={}) => (await request("GET",`/orders/offers?${query}`,undefined,200,token,headers)).find(r=>Number(r.productId)===Number(dish.id)&&Number(r.productVariantId)===Number(variant.id));
    assert.equal((await preview("orderType=takeaway")).price,140);
    assert.equal((await preview(`orderType=delivery&channelId=${channel.id}`)).price,170);
    assert.equal((await preview(`orderType=delivery&channelId=${channel.id}`,{"X-Outlet-Id":String(outlet.id)})).price,195);
    const o = await request("POST","/orders",{orderType:"takeaway",items:[{productId:dish.id,productVariantId:variant.id,quantity:1}]},201);
    assert.equal(Number((await one("SELECT unit_price FROM order_items WHERE order_id=$1",[o.id])).unit_price),140);
    await request("PUT",path,{orderType:"takeaway",price:130});
    const b = await request("POST","/bills",{orderId:o.id},201);
    assert.equal(b.totalAmount,147);
    await request("POST",`/bills/${b.id}/payments`,{paymentMethod:"cash",amount:b.totalAmount},201);
    await request("PUT",path,{orderType:"takeaway",isAvailable:false});
    assert.equal((await preview("orderType=takeaway")).isAvailable,false);
    await request("POST","/orders",{orderType:"takeaway",items:[{productId:dish.id,productVariantId:variant.id,quantity:1}]},400);
    const floor=await one("INSERT INTO floors(restaurant_id,name) VALUES ($1,'Pricing floor') RETURNING id",[rid]);
    const qrToken=crypto.randomBytes(16).toString("hex");
    await one("INSERT INTO dining_tables(restaurant_id,outlet_id,floor_id,table_no,qr_token) VALUES($1,$2,$3,'QR1',$4) RETURNING id",[rid,outlet.id,floor.id,qrToken]);
    const guestMenu=await require("../../src/modules/restaurant/orders/services/tableRequest.service").getMenu(qrToken);
    const guestDish=guestMenu.categories.flatMap(c=>c.dishes).find(d=>Number(d.id)===Number(dish.id));
    assert.equal(guestDish.price,175);assert.equal(guestDish.variants[0].price,195);
    await request("DELETE",`/menu/selling-rules/${branchRule.id}`);
    assert.equal((await preview(`orderType=delivery&channelId=${channel.id}`,{"X-Outlet-Id":String(outlet.id)})).price,170);
  });
  await t.test("batch expiry follows receipts, FEFO issues, transfers and receipt reversals", async () => {
    const item = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES ($1,'Batch milk',$2) RETURNING id",[rid,unit.id]);
    const supplier = await one("INSERT INTO suppliers(restaurant_id,name) VALUES ($1,'Test dairy') RETURNING id",[rid]);
    const data={supplierId:supplier.id,billDate:TODAY,receivedDate:TODAY,paymentMode:"credit",lines:[{inventoryItemId:item.id,quantity:5,unitPrice:20,taxRate:0,batchNumber:"MILK-A",expiryDate:daysFromToday(2)}]};
    const receipt=await request("POST","/purchase-orders/receipts",data,201);
    await request("POST","/inventory/movements/in",{inventoryItemId:item.id,quantity:3,batchNumber:"MILK-B",expiryDate:daysFromToday(11)},201);
    await request("POST","/inventory/movements/in",{inventoryItemId:item.id,quantity:1,expiryDate:"2026-02-30"},400);
    await request("POST","/inventory/movements/out",{inventoryItemId:item.id,quantity:2,transactionType:"consumption",reason:"Kitchen issue"},201);
    let batches=(await request("GET","/inventory/batches")).filter(r=>Number(r.inventory_item_id)===Number(item.id));
    assert.equal(Number(batches.find(r=>r.batch_number==="MILK-A").quantity),3);
    assert.equal(Number(batches.find(r=>r.batch_number==="MILK-B").quantity),3);
    const milkDish=await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES($1,$2,'Milk glass',30,0) RETURNING id",[rid,category.id]);
    await pool.query("INSERT INTO product_recipes(restaurant_id,product_id,inventory_item_id,quantity) VALUES($1,$2,$3,1)",[rid,milkDish.id,item.id]);
    const milkOrder=await request("POST","/orders",{orderType:"takeaway",items:[{productId:milkDish.id,quantity:1}]},201);
    const milkBill=await request("POST","/bills",{orderId:milkOrder.id},201);
    await request("PATCH",`/bills/${milkBill.id}/void`,{reason:"Test batch restoration"});
    await request("PATCH",`/orders/${milkOrder.id}/cancel`,{reason:"Test cancellation"});
    batches=(await request("GET","/inventory/batches")).filter(r=>Number(r.inventory_item_id)===Number(item.id));
    assert.equal(batches.length,2);
    assert.equal(Number(batches.find(r=>r.batch_number==="MILK-A").quantity),3);
    const branch=await one("INSERT INTO outlets(restaurant_id,name,code) VALUES ($1,'Stock branch','STOCK') RETURNING id",[rid]);
    await request("POST","/inventory/movements/transfer",{inventoryItemId:item.id,quantity:1,toOutletId:branch.id},201);
    batches=(await request("GET","/inventory/batches")).filter(r=>Number(r.inventory_item_id)===Number(item.id));
    const transferred=batches.find(r=>Number(r.outlet_id)===Number(branch.id));
    assert.equal(transferred.batch_number,"MILK-A");assert.equal(transferred.expiry_date,daysFromToday(2));assert.equal(Number(transferred.quantity),1);
    await request("POST",`/purchase-orders/receipts/${receipt.id}/void`,{reason:"Incorrect supplier bill"});
    const balance=await one("SELECT SUM(quantity) AS total FROM inventory_batch_balances WHERE batch_id IN (SELECT id FROM inventory_batches WHERE inventory_item_id=$1)",[item.id]);
    assert.equal(Number(balance.total),1);
    assert.equal(Number((await one("SELECT current_stock FROM inventory_items WHERE id=$1",[item.id])).current_stock),1);
    const foreign=await signIn(base,"other@test.invalid",password);
    assert.equal((await request("GET","/inventory/batches",undefined,200,foreign.token)).length,0);
  });
  await t.test("add-on groups enforce required and maximum choices without repricing saved lines",async()=>{
    const dish=await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES($1,$2,'Choice meal',100,0) RETURNING id",[rid,category.id]);
    const ids=[];
    for(const name of ['Mild','Hot','Extra hot']){
      const row=await one("INSERT INTO modifiers(restaurant_id,name,price) VALUES($1,$2,10) RETURNING id",[rid,name]);ids.push(Number(row.id));
      await pool.query("INSERT INTO product_modifiers(product_id,modifier_id) VALUES($1,$2)",[dish.id,row.id]);
    }
    const url=`/menu/products/${dish.id}/addon-groups`;
    const groups=[{name:"Spice",min:1,max:1,modifierIds:ids}];
    await request("PUT",url,{groups});
    await request("PUT",url,{groups:[{...groups[0],max:4}]},400);
    await request("PUT",url,{groups:[groups[0],{...groups[0],name:"Duplicate choices"}]},400);
    const create=modifierIds=>({orderType:"takeaway",items:[{productId:dish.id,quantity:1,modifierIds}]});
    await request("POST","/orders",create([]),400);
    await request("POST","/orders",create(ids.slice(0,2)),400);
    const o=await request("POST","/orders",create([ids[0]]),201);
    await request("PUT",url,{groups:[{...groups[0],min:2,max:2}]});
    const b=await request("POST","/bills",{orderId:o.id},201);
    assert.equal(b.totalAmount,110);
    await request("POST",`/bills/${b.id}/payments`,{paymentMethod:"cash",amount:110},201);
    const cook=await signIn(base,"cook@test.invalid",password);
    await request("PUT",url,{groups:[]},403,cook.token);
    const foreign=await signIn(base,"other@test.invalid",password);
    await request("GET",url,undefined,404,foreign.token);
    await request("PUT",url,{groups:[]});
  });
  await t.test("packaging is charged per takeaway item, retained on bills and refunded",async()=>{
    const dish=await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES($1,$2,'Packed meal',100,5) RETURNING id",[rid,category.id]);
    const url=`/menu/products/${dish.id}/selling-rules`;
    await request('PUT',url,{orderType:'takeaway',packagingCharge:10});
    const preview=(await request('GET','/orders/offers?orderType=takeaway')).find(r=>Number(r.productId)===Number(dish.id));
    assert.equal(preview.packagingCharge,10);assert.equal(preview.price,100);
    const o=await request('POST','/orders',{orderType:'takeaway',items:[{productId:dish.id,quantity:2}]},201);
    assert.equal(o.items[0].modifierTotal,10);assert.equal(o.totalAmount,231);
    await request('PUT',url,{orderType:'takeaway',packagingCharge:20});
    const b=await request('POST','/bills',{orderId:o.id},201);
    assert.equal(b.totalAmount,231);assert.equal(b.items[0].packagingCharge,10);
    await request('POST',`/bills/${b.id}/payments`,{paymentMethod:'cash',amount:231},201);
    await request('POST',`/bills/${b.id}/refunds`,{refundMethod:'cash',amount:231,reason:'Packaging test refund'},201);
    const service=require('../../src/modules/restaurant/orders/services/order.service');
    const price=await service.priceLines(rid,[{productId:dish.id,quantity:1,modifierIds:[]}],'exclusive','Asia/Kolkata',{orderType:'dine_in'});
    assert.equal(price.totals.totalAmount,105);assert.equal(price.lines[0].modifierTotal,0);
  });
  await t.test("advanced outlet, course, recipe, production, hours and document settings work together",async()=>{
    const branch=await one("INSERT INTO outlets(restaurant_id,name,code,order_prefix,invoice_prefix) VALUES($1,'Advanced branch','ADV','AORD','AINV') RETURNING id",[rid]);
    const branch2=await one("INSERT INTO outlets(restaurant_id,name,code,order_prefix,invoice_prefix) VALUES($1,'Second branch','ADV2','BORD','BINV') RETURNING id",[rid]);
    const h1={"X-Outlet-Id":String(branch.id)},h2={"X-Outlet-Id":String(branch2.id)};
    await request("POST","/business-day/open",{businessDate:TODAY,openingCash:100},201,token,h1);
    await request("POST","/business-day/open",{businessDate:TODAY,openingCash:200},201,token,h2);
    assert.equal((await request("GET","/business-day",undefined,200,token,h1)).current.outletId,branch.id);
    const inclusive=await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage,tax_mode,mrp) VALUES($1,$2,'MRP meal',105,5,'inclusive',110) RETURNING id",[rid,category.id]);
    const held=await request("POST","/orders",{orderType:"takeaway",items:[{productId:inclusive.id,quantity:1,courseNo:2,courseName:'Main',holdCourse:true}]},201,token,h1);
    assert.match(held.orderNumber,/^AORD-/);assert.equal(held.items[0].fireStatus,"held");assert.equal(held.totalAmount,105);
    await request("POST",`/orders/${held.id}/courses/2/fire`,{},200,token,h1);
    assert.equal((await one("SELECT fire_status FROM order_items WHERE order_id=$1",[held.id])).fire_status,"fired");
    const firstBill=await request("POST","/bills",{orderId:held.id},201,token,h1);assert.match(firstBill.billNumber,/^AINV-/);
    await request("POST",`/bills/${firstBill.id}/payments`,{paymentMethod:'cash',amount:firstBill.totalAmount},201,token,h1);
    const secondOrder=await request("POST","/orders",{orderType:"takeaway",items:[{productId:inclusive.id,quantity:1}]},201,token,h2);assert.match(secondOrder.orderNumber,/^BORD-/);
    const secondBill=await request("POST","/bills",{orderId:secondOrder.id},201,token,h2);assert.match(secondBill.billNumber,/^BINV-/);
    await request("POST",`/bills/${secondBill.id}/payments`,{paymentMethod:'cash',amount:secondBill.totalAmount},201,token,h2);
    const advancedRaw=await one("INSERT INTO inventory_items(restaurant_id,name,unit_id,last_cost) VALUES($1,'Advanced raw',$2,40) RETURNING id",[rid,unit.id]);
    await request("POST","/inventory/movements/in",{inventoryItemId:advancedRaw.id,quantity:20,unitCost:40},201);
    const modifier=await one("INSERT INTO modifiers(restaurant_id,name,price) VALUES($1,'Recipe add-on',10) RETURNING id",[rid]);
    const addOnDish=await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES($1,$2,'Add-on recipe dish',50,0) RETURNING id",[rid,category.id]);
    await pool.query("INSERT INTO product_modifiers(product_id,modifier_id) VALUES($1,$2)",[addOnDish.id,modifier.id]);
    await request("PUT",`/menu/modifiers/${modifier.id}/recipe`,{lines:[{inventoryItemId:advancedRaw.id,quantity:0.1}]});
    const before=Number((await one("SELECT current_stock FROM inventory_items WHERE id=$1",[advancedRaw.id])).current_stock);
    const addOnOrder=await request("POST","/orders",{orderType:"takeaway",items:[{productId:addOnDish.id,quantity:1,modifierIds:[modifier.id]}]},201);
    const addOnBill=await request("POST","/bills",{orderId:addOnOrder.id},201);
    await request("POST",`/bills/${addOnBill.id}/payments`,{paymentMethod:'cash',amount:addOnBill.totalAmount},201);
    assert.equal(Number((await one("SELECT current_stock FROM inventory_items WHERE id=$1",[advancedRaw.id])).current_stock),before-0.1);
    const prepared=await one("INSERT INTO inventory_items(restaurant_id,name,unit_id,item_type) VALUES($1,'Prepared gravy',$2,'prepared') RETURNING id",[rid,unit.id]);
    await request("PUT",`/inventory/items/${prepared.id}/recipe`,{lines:[{inventoryItemId:advancedRaw.id,quantity:0.5}]});
    const produced=await request("POST","/inventory/production",{outputItemId:prepared.id,quantity:2,batchNumber:'PREP-1',expiryDate:daysFromToday(3)},201);
    assert.equal(produced.quantity,2);assert.equal(Number((await one("SELECT current_stock FROM inventory_items WHERE id=$1",[prepared.id])).current_stock),2);
    const hours=Array.from({length:7},(_,dayOfWeek)=>({dayOfWeek,isOpen:true,periods:[{openTime:'07:00',closeTime:'11:00'},{openTime:'18:00',closeTime:'23:00'}]}));
    const savedHours=await request("PUT","/restaurants/current/business-hours",{days:hours});assert.equal(savedHours[0].periods.length,2);
    const settings=await request("GET","/restaurants/current/settings");
    const updated=await request("PUT","/restaurants/current/settings",{...settings,documentType:'bill_of_supply',compositionPercentage:5,compositionNote:'Composition declaration',receiptLogoPath:'https://example.invalid/logo.png'});
    assert.equal(updated.documentType,'bill_of_supply');assert.equal(updated.compositionPercentage,5);
    await request("PUT","/restaurants/current/settings",{...updated,documentType:'auto',compositionPercentage:null,compositionNote:null,receiptLogoPath:null});
  });
  let order, bill;
  const newOrder = () => request("POST", "/orders", { orderType: "takeaway", customerId: guest.id, items: [{ productId: product.id, quantity: 2 }] }, 201);
  await require('./service-readiness.cjs')(t,{request,one,pool,rid,category,unit,token});
  await t.test("order reaches kitchen and prevents premature day close", async () => {
    order = await newOrder();
    await request("GET", "/kitchen/board");
    assert.ok(Number((await one("SELECT count(*) AS count FROM order_items WHERE order_id=$1", [order.id])).count) > 0);
    await request("POST", "/business-day/close", { closingCash: 500 }, 409);
  });
  await t.test("another restaurant cannot read the order", async () => {
    const session = await signIn(base, "other@test.invalid", password);
    await request("GET", `/orders/${order.id}`, undefined, 404, session.token);
  });
  await t.test("billing prices from menu and consumes the recipe once", async () => {
    bill = await request("POST", "/bills", { orderId: order.id }, 201);
    assert.equal(bill.totalAmount, 210);
    assert.equal(Number((await one("SELECT current_stock FROM inventory_items WHERE id=$1", [ingredient.id])).current_stock), 9.6);
    assert.equal(Number((await one("SELECT loyalty_points FROM customers WHERE id=$1",[guest.id])).loyalty_points),0);
  });
  await t.test("split payment settles the bill without consuming stock again", async () => {
    await request("POST", `/bills/${bill.id}/payments`, { paymentMethod: "cash", amount: 100 }, 201);
    await request("POST", `/bills/${bill.id}/payments`, { paymentMethod: "upi", amount: 110 }, 201);
    assert.equal((await one("SELECT bill_status FROM bills WHERE id=$1", [bill.id])).bill_status, "paid");
    assert.equal(Number((await one("SELECT loyalty_points FROM customers WHERE id=$1",[guest.id])).loyalty_points),2);
    assert.equal(Number((await one("SELECT current_stock FROM inventory_items WHERE id=$1", [ingredient.id])).current_stock), 9.6);
  });
  await t.test("refund issues a balanced credit note", async () => {
    await request("POST", `/bills/${bill.id}/refunds`, { amount: 105, refundMethod: "cash", reason: "Test refund" }, 201);
    const note = await one("SELECT total_amount,taxable_value,tax_amount,round_off FROM credit_notes WHERE bill_id=$1",[bill.id]);
    assert.equal(Number(note.total_amount), 105);
    assert.equal(Math.round((Number(note.taxable_value)+Number(note.tax_amount)+Number(note.round_off))*100), 10500);
  });
  await t.test("concurrent bills get unique numbers", async () => {
    const orders = await Promise.all([newOrder(),newOrder(),newOrder()]);
    const bills = await Promise.all(orders.map(o => request("POST", "/bills", {orderId:o.id},201)));
    assert.equal(new Set(bills.map(b=>b.billNumber)).size,3);
    for(const b of bills) await request("POST",`/bills/${b.id}/payments`,{paymentMethod:"cash",amount:b.totalAmount},201);
  });
  await t.test("void restores stock and redeemed points, then order can be cancelled", async () => {
    const stock = Number((await one("SELECT current_stock FROM inventory_items WHERE id=$1",[ingredient.id])).current_stock);
    const points = Number((await one("SELECT loyalty_points FROM customers WHERE id=$1",[guest.id])).loyalty_points);
    assert.ok(points >= 1);
    const o = await newOrder();
    const b = await request("POST","/bills",{orderId:o.id,loyaltyPoints:1},201);
    assert.equal(Number((await one("SELECT loyalty_points FROM customers WHERE id=$1",[guest.id])).loyalty_points),points-1);
    await request("PATCH",`/bills/${b.id}/void`,{reason:"Test void"});
    assert.equal(Number((await one("SELECT current_stock FROM inventory_items WHERE id=$1",[ingredient.id])).current_stock),stock);
    assert.equal(Number((await one("SELECT loyalty_points FROM customers WHERE id=$1",[guest.id])).loyalty_points),points);
    await request("PATCH",`/orders/${o.id}/cancel`,{reason:"Test cancellation"});
  });
  await t.test("expenses reject impossible dates and include approved spending", async () => {
    const before=await request("GET",`/reports/expenses?from=${TODAY}&to=${TODAY}`);
    const category=await request("POST","/expenses/categories",{name:"Repairs"},201);
    const data={expenseCategoryId:category.id,expenseDate:TODAY,amount:50,paymentMode:"cash"};
    await request("POST","/expenses",{...data,expenseDate:"2026-02-30"},400);
    await request("GET","/expenses?from=2026-09-30&to=2026-09-01",undefined,400);
    const expense=await request("POST","/expenses",data,201);
    await request("PATCH",`/expenses/${expense.id}/status`,{status:"approved"});
    const report=await request("GET",`/reports/expenses?from=${TODAY}&to=${TODAY}`);
    assert.equal(report.total-before.total,50);
  });
  await t.test("reservation and walk-in records can be created and cancelled", async () => {
    const tomorrow=daysFromToday(1);
    const booking=await request("POST","/reservations",{guestName:"Booking guest",partySize:2,date:tomorrow,startTime:"19:00"},201);
    await request("PATCH",`/reservations/${booking.id}/cancel`,{reason:"Guest cancelled"});
    const walkin=await request("POST","/reservations/waitlist",{guestName:"Walk-in guest",partySize:2},201);
    await request("PATCH",`/reservations/waitlist/${walkin.id}/left`,{});
    await request("GET","/reservations/day");
  });
  await t.test("main module read endpoints load on a freshly migrated database", async () => {
    for(const route of ["/users","/roles","/menu/products","/tables","/inventory/items","/inventory/movements",
      "/purchase-orders","/suppliers","/crm/customers","/staff","/timeclock/board","/deliveries/board",
      "/table-requests/summary","/notifications","/guest-insights","/inventory-insights/summary","/reports/dashboard"]) {
      await request("GET",route);
    }
  });
  await t.test("GST, P&L and balanced day book report recorded transactions", async () => {
    const range = `?from=${TODAY}&to=${TODAY}`;
    await request("GET","/reports/gst"+range);
    await request("GET","/reports/profit-loss"+range);
    const book=await request("GET","/reports/day-book"+range);
    assert.ok(book.totals.vouchers>0);
    assert.equal(book.totals.unbalanced,0);
    assert.equal(book.totals.debit,book.totals.credit);
  });
  await t.test("delivery requires packing and a rider, then records completion", async () => {
    const o=await request("POST","/orders",{orderType:"delivery",items:[{productId:product.id,quantity:1}]},201);
    const route=`/deliveries/${o.id}/status`;
    await request("PATCH",route,{status:"out_for_delivery",partnerRiderName:"Test rider"},409);
    await request("PATCH",route,{status:"ready",confirmPacked:true});
    await request("PATCH",route,{status:"out_for_delivery"},400);
    await request("PATCH",route,{status:"out_for_delivery",partnerRiderName:"Test rider"});
    const foreign=await signIn(base,"other@test.invalid",password);
    await request("GET",`/deliveries/${o.id}`,undefined,404,foreign.token);
    await request("PATCH",route,{status:"delivered"});
    const b=await request("POST","/bills",{orderId:o.id},201);
    await request("POST",`/bills/${b.id}/payments`,{paymentMethod:"cash",amount:b.totalAmount},201);
    const saved=await one("SELECT delivery_status,dispatched_at,delivered_at FROM orders WHERE id=$1",[o.id]);
    assert.equal(saved.delivery_status,"delivered");assert.ok(saved.dispatched_at);assert.ok(saved.delivered_at);
  });
  await t.test("payroll locks settled periods and prevents duplicate or excessive payments", async () => {
    const employee=await request("POST","/staff",{name:"Test waiter",salaryType:"daily",salaryAmount:500,dateOfJoining:"2026-09-01"},201);
    await request("POST","/staff/attendance",{employeeId:employee.id,attendanceDate:TODAY,attendanceStatus:"present"},201);
    await request("POST","/staff/payroll/adjustments",{employeeId:employee.id,date:TODAY,kind:"bonus",amount:50,note:"Test bonus"},201);
    const payroll=await request("GET",`/staff/payroll?from=${TODAY}&to=${TODAY}`);
    assert.equal(payroll.employees.find(e=>Number(e.id)===Number(employee.id)||Number(e.employeeId)===Number(employee.id)).netPay,550);
    const payment={employeeId:employee.id,from:TODAY,to:TODAY,paidOn:TODAY,paymentMethod:"bank"};
    await request("POST","/staff/payroll/payments",{...payment,amountPaid:1000},400);
    const paid=await request("POST","/staff/payroll/payments",payment,201);
    assert.equal(paid.amountPaid,550);
    await request("POST","/staff/payroll/payments",payment,409);
    await request("POST","/staff/payroll/adjustments",{employeeId:employee.id,date:TODAY,kind:"bonus",amount:50,note:"Late bonus"},409);
    const cook=await signIn(base,"cook@test.invalid",password);
    await request("GET","/staff/payroll",undefined,403,cook.token);
    const foreign=await signIn(base,"other@test.invalid",password);
    await request("POST","/staff/payroll/payments",payment,400,foreign.token);
  });
  const loadSeconds=Number(process.env.RMP_LOAD_SECONDS||0);
  if(loadSeconds>0){
    await t.test("sustained concurrent order, bill and payment service", async () => {
      assert.ok(loadSeconds<=300,"Load run capped at five minutes");
      const dish=await one("INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES($1,$2,'Load meal',100,5) RETURNING id",[rid,category.id]);
      const started=Date.now(),durations=[],numbers=new Set();let completed=0;
      await Promise.all(Array.from({length:4},async()=>{
        while(Date.now()-started<loadSeconds*1000){
          const at=Date.now();
          const o=await request("POST","/orders",{orderType:"takeaway",items:[{productId:dish.id,quantity:1}]},201);
          const b=await request("POST","/bills",{orderId:o.id},201);
          assert.equal(b.totalAmount,105);assert.ok(!numbers.has(b.billNumber));numbers.add(b.billNumber);
          await request("POST",`/bills/${b.id}/payments`,{paymentMethod:"cash",amount:105},201);
          completed++;durations.push(Date.now()-at);
          if(completed%20===0)await request("GET","/kitchen/board");
        }
      }));
      durations.sort((a,b)=>a-b);
      const metrics={seconds:(Date.now()-started)/1000,workers:4,completed,uniqueBills:numbers.size,flowP95Ms:durations[Math.floor(durations.length*0.95)],flowMaxMs:durations.at(-1)};
      console.log("LOAD_RESULT "+JSON.stringify(metrics));
      assert.ok(completed>0);
      const unpaid=await one("SELECT count(*) AS count FROM bills WHERE restaurant_id=$1 AND bill_status NOT IN ('paid','void')",[rid]);
      assert.equal(Number(unpaid.count),0);
      const book=await request("GET",`/reports/day-book?from=${TODAY}&to=${TODAY}`);
      assert.equal(book.totals.unbalanced,0);assert.equal(book.totals.debit,book.totals.credit);
    });
  }
  await t.test("every stock movement and store balance reconciles to its batch allocations", async () => {
    const mismatch=await one(`SELECT count(*) AS count FROM stock_transactions st
      LEFT JOIN (SELECT stock_transaction_id,SUM(quantity) AS quantity FROM inventory_batch_movements GROUP BY stock_transaction_id) bm ON bm.stock_transaction_id=st.id
      WHERE ABS(st.quantity-COALESCE(bm.quantity,0))>0.000001`);
    assert.equal(Number(mismatch.count),0);
    const stores=await one(`SELECT count(*) AS count FROM stock_balances sb
      LEFT JOIN (SELECT b.inventory_item_id,bb.outlet_id,SUM(bb.quantity) AS quantity FROM inventory_batch_balances bb JOIN inventory_batches b ON b.id=bb.batch_id GROUP BY b.inventory_item_id,bb.outlet_id) batches
      ON batches.inventory_item_id=sb.inventory_item_id AND batches.outlet_id IS NOT DISTINCT FROM sb.outlet_id
      WHERE ABS(sb.quantity-COALESCE(batches.quantity,0))>0.000001`);
    assert.equal(Number(stores.count),0);
  });
  await t.test("explicit zero cash can close a settled day", async () => {
    await request("POST","/business-day/close",{closingCash:0,varianceReason:"Test: all cash banked before the count"});
    assert.equal((await one("SELECT day_status FROM business_days WHERE restaurant_id=$1 AND outlet_id IS NULL",[rid])).day_status,"closed");
  });
  await t.test("password change invalidates old sessions and accepts the new password", async () => {
    const newPassword = crypto.randomBytes(16).toString("hex");
    const oldToken = token;
    const session = await request("POST", "/auth/change-password", { currentPassword: passwordOf(base, "owner@test.invalid", password), newPassword });
    await request("GET", "/auth/me", undefined, 401, oldToken);
    await request("GET", "/auth/me", undefined, 200, session.token);
    await request("POST", "/auth/login", { identifier: "owner@test.invalid", password }, 401, null);
    await request("POST", "/auth/login", { identifier: "owner@test.invalid", password: newPassword }, 200, null);
  });
});
