// Three demo food businesses on the restaurant engine, one of each format:
//
//   Brew & Bloom Café (cafe)         counter-first: takeaway with tokens, a few tables
//   Sweet Crust Bakery (bakery)      bakes from recipes, cookies by weight, cake
//                                    pre-orders with advances, the day-end count
//   Biryani Box (cloud_kitchen)      delivery only: Swiggy, Zomato and its own riders
//
// Each is a restaurant made the supported way (Platform › Restaurants) with
// its own owner login, set up in its format, given a menu and a week of
// trading through the real order, bill and business-day services. The logins
// are saved in .local/food-demo-logins.json (local only).
//
// Usage:  node scripts/demo-food-formats.js      (adds what is missing; never twice)
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/database");
const restaurantService = require("../src/modules/restaurant/setup/services/restaurant.service");
const formatService = require("../src/modules/restaurant/setup/services/restaurantFormat.service");
const menuService = require("../src/modules/restaurant/menu/services/menu.service");
const recipeService = require("../src/modules/restaurant/menu/services/recipe.service");
const inventoryService = require("../src/modules/restaurant/inventory/services/inventory.service");
const advancedInventory = require("../src/modules/restaurant/inventory/services/advancedInventory.service");
const tableService = require("../src/modules/restaurant/tables/services/table.service");
const businessDayService = require("../src/modules/restaurant/business-day/services/businessDay.service");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");
const deliveryService = require("../src/modules/restaurant/deliveries/services/delivery.service");
const preorderService = require("../src/modules/restaurant/preorders/services/preorder.service");

const LOGINS = path.resolve(__dirname, "../.local/food-demo-logins.json");
const DAYS = 6;
const TZ = "Asia/Kolkata";

let randomState = 20261021;
const random = () => {
  randomState = (randomState * 1103515245 + 12345) % 2147483648;
  return randomState / 2147483648;
};
const between = (low, high) => low + Math.floor(random() * (high - low + 1));
const pick = (list) => list[Math.floor(random() * list.length)];
const dayText = (date) => date.toLocaleDateString("en-CA", { timeZone: TZ });
const say = (line) => console.log(line);

// [category, [[name, price, foodType, extra]]]; extra: { soldBy, weight (how often sold) }
const PLACES = [
  {
    format: "cafe", code: "BREWBLOOM", name: "Brew & Bloom Café", contact: "080 4123 7788", address: "12th Main, HAL 2nd Stage, Indiranagar, Bengaluru 560008",
    admin: { name: "Ananya Rao", email: "owner@brewbloom.demo.test", mobile: "9845012345" },
    tables: ["Window 1", "Window 2", "Window 3", "Patio 1", "Patio 2", "Sofa"],
    menu: [
      ["Coffee & tea", [["Cappuccino", 160, "veg", { weight: 5 }], ["Café latte", 180, "veg", { weight: 4 }], ["Cold coffee", 190, "veg", { weight: 4 }],
        ["South Indian filter coffee", 70, "veg", { weight: 5 }], ["Masala chai", 60, "veg", { weight: 4 }], ["Hot chocolate", 210, "veg", { weight: 2 }]]],
      ["Bakes", [["Butter croissant", 130, "veg", { weight: 3 }], ["Blueberry muffin", 120, "veg", { weight: 2 }], ["Banana walnut cake slice", 140, "egg", { weight: 2 }]]],
      ["All-day food", [["Veg club sandwich", 230, "veg", { weight: 3 }], ["Chicken pesto sandwich", 270, "non_veg", { weight: 2 }], ["Paneer tikka wrap", 220, "veg", { weight: 2 }],
        ["Penne arrabbiata", 280, "veg", { weight: 2 }], ["Masala cheese toast", 160, "veg", { weight: 3 }]]],
    ],
    orderTypes: ["takeaway", "takeaway", "takeaway", "dine_in", "dine_in"],
    covers: [28, 46],
  },
  {
    format: "bakery", code: "SWEETCRUST", name: "Sweet Crust Bakery", contact: "040 2711 4455", address: "Shop 4, Road No. 2, Banjara Hills, Hyderabad 500034",
    admin: { name: "Farhan Siddiqui", email: "owner@sweetcrust.demo.test", mobile: "9849012345" },
    tables: [],
    menu: [
      ["Cakes", [["Black forest cake (1 kg)", 850, "egg", { weight: 1 }], ["Pineapple cake (1 kg)", 750, "egg", { weight: 1 }], ["Red velvet cake (1 kg)", 1150, "egg", { weight: 1 }],
        ["Eggless truffle cake (1 kg)", 1050, "veg", { weight: 1 }], ["Pastry (slice)", 95, "egg", { weight: 4 }]]],
      ["Breads", [["Milk bread (400 g)", 55, "veg", { weight: 4 }], ["Brown bread (400 g)", 65, "veg", { weight: 2 }], ["Pav (pack of 6)", 45, "veg", { weight: 3 }]]],
      ["Cookies & rusks (by weight)", [["Osmania biscuits", 480, "veg", { soldBy: "weight", weight: 3 }], ["Butter cookies", 640, "veg", { soldBy: "weight", weight: 3 }],
        ["Kaju pista biscuits", 920, "veg", { soldBy: "weight", weight: 2 }], ["Cake rusk", 380, "egg", { soldBy: "weight", weight: 2 }]]],
      ["Savouries", [["Veg puff", 35, "veg", { weight: 5 }], ["Egg puff", 40, "egg", { weight: 4 }], ["Chicken puff", 55, "non_veg", { weight: 3 }]]],
    ],
    orderTypes: ["takeaway"],
    covers: [40, 70],
  },
  {
    format: "cloud_kitchen", code: "BIRYANIBOX", name: "Biryani Box", contact: "040 4855 9900", address: "Unit 7, Kitchen Park, Kondapur, Hyderabad 500084",
    admin: { name: "Imran Qureshi", email: "owner@biryanibox.demo.test", mobile: "9866012345" },
    tables: [],
    menu: [
      ["Biryani", [["Chicken dum biryani", 329, "non_veg", { weight: 5 }], ["Mutton dum biryani", 449, "non_veg", { weight: 3 }], ["Egg biryani", 249, "egg", { weight: 2 }],
        ["Paneer tikka biryani", 299, "veg", { weight: 2 }], ["Veg dum biryani", 239, "veg", { weight: 2 }]]],
      ["Kebabs", [["Chicken 65", 279, "non_veg", { weight: 3 }], ["Chicken tikka", 319, "non_veg", { weight: 2 }]]],
      ["Sides & sweets", [["Mirchi ka salan", 60, "veg", { weight: 3 }], ["Raita", 50, "veg", { weight: 3 }], ["Double ka meetha", 129, "veg", { weight: 2 }], ["Qubani ka meetha", 149, "veg", { weight: 1 }]]],
    ],
    orderTypes: ["delivery", "delivery", "delivery", "delivery", "takeaway"],
    covers: [35, 60],
  },
];

const readLogins = () => {
  try { return JSON.parse(fs.readFileSync(LOGINS, "utf8")); } catch { return { accounts: [] }; }
};

async function place(def) {
  const found = (await pool.query("SELECT id FROM restaurants WHERE code = $1", [def.code])).rows[0];
  const logins = readLogins();

  if (found) {
    say(`${def.name}: already set up (restaurant ${found.id})`);
    return null;
  }

  const password = `Demo-${crypto.randomBytes(6).toString("hex")}`;
  const created = await restaurantService.createRestaurant({
    name: def.name, code: def.code, contact: def.contact, email: null, address: def.address, timezone: TZ,
    invoicePrefix: def.code.slice(0, 3), orderPrefix: def.code.slice(0, 3), admin: { ...def.admin, password },
  });
  const owner = { id: created.adminId, name: def.admin.name };
  const result = await formatService.apply(created.id, def.format, owner);
  logins.accounts = [...logins.accounts.filter((a) => a.email !== def.admin.email),
    { business: def.name, format: def.format, email: def.admin.email, password, role: "Restaurant admin", restaurantCode: def.code }];
  fs.mkdirSync(path.dirname(LOGINS), { recursive: true });
  fs.writeFileSync(LOGINS, JSON.stringify(logins, null, 2));
  say(`${def.name}: created as a ${result.label.toLowerCase()} (restaurant ${created.id})${result.skipped.length ? `, ${result.skipped.length} features left as they were` : ""}`);
  return { restaurantId: created.id, userId: created.adminId };
}

async function menu(def, restaurantId, userId) {
  const products = [];
  let sort = 0;

  for (const [index, [category, items]] of def.menu.entries()) {
    const saved = await menuService.createCategory(restaurantId, { name: category, description: null, sortOrder: index, status: "active" }, userId);

    for (const [name, price, foodType, extra] of items) {
      const product = await menuService.createProduct(restaurantId, {
        categoryId: saved.id, name, code: null, description: null, price, foodType, isAvailable: true, sortOrder: (sort += 1), status: "active",
        soldBy: extra.soldBy || "unit",
      }, userId);
      products.push({ ...product, weight: extra.weight || 1, soldBy: extra.soldBy || "unit" });
    }
  }

  return products;
}

async function tables(def, restaurantId, userId) {
  if (!def.tables.length) return [];
  const floor = await tableService.createFloor(restaurantId, { name: "Café floor", sortOrder: 0, status: "active" }, userId);
  const area = await tableService.createArea(restaurantId, { floorId: floor.id, name: "Seating", sortOrder: 0, status: "active" }, userId);
  const rows = [];
  for (const tableNo of def.tables) {
    rows.push(await tableService.createTable(restaurantId, { floorId: floor.id, areaId: area.id, outletId: null, tableNo, capacity: tableNo === "Sofa" ? 4 : 2, status: "active" }, userId));
  }
  return rows;
}

const weighted = (products) => {
  const total = products.reduce((sum, p) => sum + p.weight, 0);
  let roll = random() * total;
  for (const p of products) { roll -= p.weight; if (roll <= 0) return p; }
  return products[products.length - 1];
};

async function trade(def, restaurantId, userId, products, tableRows) {
  const channels = (await pool.query("SELECT id, name, channel_type FROM sales_channels WHERE restaurant_id = $1 AND status = 'active'", [restaurantId])).rows;
  const aggregators = channels.filter((c) => c.channel_type === "aggregator");
  let orders = 0, bills = 0, sales = 0;

  for (let back = DAYS; back >= 0; back -= 1) {
    const date = new Date(Date.now() - back * 86400000);
    const businessDate = dayText(date);
    const openingCash = 2000;
    const day = await businessDayService.openDay(restaurantId, { businessDate, openingCash, notes: null }, userId);
    let cash = 0;
    const covers = back === 0 ? Math.round(def.covers[0] / 2) : between(def.covers[0], def.covers[1]);
    const stamps = [];

    for (let n = 0; n < covers; n += 1) {
      const orderType = pick(def.orderTypes);
      const table = orderType === "dine_in" && tableRows.length ? pick(tableRows) : null;
      const items = [];
      for (let l = between(1, 3); l > 0; l -= 1) {
        const p = weighted(products);
        if (items.some((i) => i.productId === p.id)) continue;
        items.push({ productId: p.id, productVariantId: null, modifierIds: [], notes: null,
          quantity: p.soldBy === "weight" ? pick([0.25, 0.25, 0.5, 0.5, 1]) : between(1, p.weight >= 4 ? 3 : 2) });
      }
      const channel = orderType === "delivery" ? (random() < 0.82 && aggregators.length ? pick(aggregators) : null) : null;
      let order;
      try {
        order = await orderService.create(restaurantId, { orderType, source: channel ? "partner" : "pos", tableId: table ? table.id : null, outletId: null,
          channelId: channel ? channel.id : null, customerId: null, customerName: null, customerMobile: null, guestCount: table ? between(1, 3) : null, notes: null, items }, userId);
      } catch (error) {
        if (n === 0) say(`  (skipped an order: ${error.message})`);
        continue;
      }
      orders += 1;
      if (channel) {
        await deliveryService.updateDetails(restaurantId, order.id, { externalRef: `${channel.name.slice(0, 3).toUpperCase()}${between(10000000, 99999999)}` }, userId).catch(() => {});
      }
      const at = `${between(8, 21)}:${String(between(0, 59)).padStart(2, "0")}`;
      stamps.push({ orderId: order.id, billId: null, at });
      if (back === 0 && n >= covers - 2) continue;
      const bill = await billService.createForOrder(restaurantId, { orderId: order.id, discountCode: null, outletId: null, loyaltyPoints: null, items: [] }, userId);
      // An aggregator pays the restaurant later (its settlement); ours are paid at the door or the counter.
      const method = channel ? "online" : pick(["upi", "upi", "upi", "cash", "card"]);
      await billService.addPayment(restaurantId, bill.id, { paymentMethod: method, amount: bill.dueAmount,
        tenderedAmount: method === "cash" ? Math.ceil(bill.dueAmount / 50) * 50 : null, transactionRef: method === "upi" ? `UPI${between(100000, 999999)}` : null }, userId);
      stamps[stamps.length - 1].billId = bill.id;
      bills += 1; sales += bill.totalAmount;
      if (method === "cash") cash += bill.totalAmount;
    }

    for (const stamp of stamps) {
      await pool.query("UPDATE orders SET created_at = ($2::date + $3::time) AT TIME ZONE $4 WHERE restaurant_id = $1 AND id = $5", [restaurantId, businessDate, stamp.at, TZ, stamp.orderId]);
      if (stamp.billId) {
        await pool.query(`UPDATE bills SET billed_at = ($2::date + $3::time + INTERVAL '25 minutes') AT TIME ZONE $5,
            settled_at = CASE WHEN settled_at IS NULL THEN NULL ELSE ($2::date + $3::time + INTERVAL '28 minutes') AT TIME ZONE $5 END WHERE restaurant_id = $1 AND id = $4`,
        [restaurantId, businessDate, stamp.at, stamp.billId, TZ]);
        await pool.query("UPDATE payments SET paid_at = ($2::date + $3::time + INTERVAL '28 minutes') AT TIME ZONE $4 WHERE restaurant_id = $1 AND bill_id = $5", [restaurantId, businessDate, stamp.at, TZ, stamp.billId]);
      }
    }
    if (back > 0) await businessDayService.closeDay(restaurantId, { closingCash: Math.round(openingCash + cash), notes: null }, userId);
    await pool.query(`UPDATE business_days SET opened_at = business_date + TIME '07:30', closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE business_date + TIME '22:30' END
      WHERE restaurant_id = $1 AND id = $2`, [restaurantId, day.id]);
  }
  say(`  trading · ${DAYS + 1} days, ${orders} orders, ${bills} bills, ₹${Math.round(sales).toLocaleString("en-IN")}`);
}

// The bakery's morning bake: ingredients in stock, bakes made from recipes,
// and the counter's puffs and pastries sold from what was baked.
async function bakery(restaurantId, userId, products) {
  const unit = async (name, shortName) => (await inventoryService.createUnit(restaurantId, { name, shortName, status: "active" }, userId)).id;
  const kg = await unit("Kilogram", "kg"), litre = await unit("Litre", "L"), piece = await unit("Piece", "pc");
  const raw = {};
  for (const [name, unitId, stock, cost] of [["Maida (flour)", kg, 80, 42], ["Butter", kg, 20, 520], ["Sugar", kg, 40, 44], ["Fresh cream", litre, 15, 210],
    ["Eggs", piece, 300, 6.5], ["Cocoa powder", kg, 5, 640], ["Mixed vegetable filling", kg, 12, 90]]) {
    raw[name] = (await inventoryService.createItem(restaurantId, { name, code: null, unitId, category: "Bakery stores", reorderLevel: Math.round(stock / 4), status: "active",
      openingStock: stock, openingCost: cost }, userId)).id;
  }
  const bakes = [
    ["Veg puff (baked)", piece, [["Maida (flour)", 0.04], ["Butter", 0.015], ["Mixed vegetable filling", 0.03]], 60, "Veg puff"],
    ["Pastry slice (baked)", piece, [["Maida (flour)", 0.03], ["Sugar", 0.02], ["Fresh cream", 0.03], ["Eggs", 0.5], ["Cocoa powder", 0.004]], 40, "Pastry (slice)"],
    ["Black forest cake 1 kg (baked)", piece, [["Maida (flour)", 0.25], ["Sugar", 0.2], ["Fresh cream", 0.35], ["Eggs", 4], ["Cocoa powder", 0.05], ["Butter", 0.08]], 4, "Black forest cake (1 kg)"],
  ];
  for (const [name, unitId, recipe, made, productName] of bakes) {
    const item = await inventoryService.createItem(restaurantId, { name, code: null, unitId, category: "Bakes", reorderLevel: 0, status: "active", itemType: "prepared" }, userId);
    await advancedInventory.saveItemRecipe(restaurantId, item.id, recipe.map(([ingredient, quantity]) => ({ inventoryItemId: raw[ingredient], quantity })), userId);
    await advancedInventory.produce(restaurantId, { outputItemId: item.id, quantity: made, batchNumber: `B${dayText(new Date()).replace(/-/g, "")}-${item.id}`,
      expiryDate: null, notes: "Morning bake", requestKey: crypto.randomUUID() }, userId);
    const product = products.find((p) => p.name === productName);
    if (product) await recipeService.addLine(restaurantId, product.id, { inventoryItemId: item.id, productVariantId: null, quantity: 1 }, userId);
  }
  say("  bakes · ingredients in stock, 3 bakes made from recipes this morning (puffs, pastry slices, black forest)");
}

// Cake and party orders: due today, tomorrow and later, most with an advance.
async function preorders(restaurantId, userId, products) {
  const cake = (name) => products.find((p) => p.name === name);
  const at = (days, time) => new Date(`${dayText(new Date(Date.now() + days * 86400000))}T${time}:00+05:30`).toISOString();
  const book = [
    ["Riya Sharma", "9876500101", at(0, "18:30"), [[cake("Black forest cake (1 kg)"), 1, "Happy Birthday Riya · 7 candles"]], 400, "ready"],
    ["Mohammed Aslam", "9876500102", at(0, "20:00"), [[cake("Red velvet cake (1 kg)"), 2, "Happy Anniversary Ammi & Abbu"], [cake("Veg puff"), 20, null]], 1000, "in_production"],
    ["Lakshmi Reddy", "9876500103", at(1, "11:00"), [[cake("Eggless truffle cake (1 kg)"), 1, "Congratulations Kavya · eggless"]], 500, null],
    ["Ravi Teja", "9876500104", at(1, "17:00"), [[cake("Pineapple cake (1 kg)"), 3, "Team Fintech · Diwali party"], [cake("Butter cookies"), 1.5, "Gift boxes of 250 g"]], 1500, null],
    ["Sneha Kapoor", "9876500105", at(2, "16:00"), [[cake("Black forest cake (1 kg)"), 2, "Happy 1st Birthday Aarav · blue theme"], [cake("Chicken puff"), 30, null]], 0, null],
    ["Arvind Menon", "9876500106", at(4, "12:00"), [[cake("Red velvet cake (1 kg)"), 1, "Happy Retirement Sir"]], 600, null],
  ];
  for (const [name, mobile, dueAt, items, advance, status] of book) {
    const created = await preorderService.create(restaurantId, {
      customerName: name, customerMobile: mobile, dueAt, fulfilment: "pickup", notes: null,
      items: items.filter(([p]) => p).map(([p, quantity, notes]) => ({ productId: p.id, productVariantId: null, quantity, notes })),
      advance: advance ? { amount: advance, paymentMethod: pick(["upi", "cash"]), transactionRef: null } : null,
    }, userId, {});
    if (status === "in_production") await preorderService.setStatus(restaurantId, created.id, "in_production", userId);
    if (status === "ready") await preorderService.setStatus(restaurantId, created.id, "ready", userId);
  }
  say(`  pre-orders · ${book.length} cake and party orders (2 due today, 4 later)`);
}

async function main() {
  for (const def of PLACES) {
    const made = await place(def);
    if (!made) continue;
    const { restaurantId, userId } = made;
    const products = await menu(def, restaurantId, userId);
    const tableRows = await tables(def, restaurantId, userId);
    say(`  menu · ${products.length} items${tableRows.length ? `, ${tableRows.length} tables` : ""}`);
    if (def.format === "bakery") {
      // History first (no stock kept then), then this morning's bake and today's counter.
      await trade(def, restaurantId, userId, products, tableRows);
      await bakery(restaurantId, userId, products);
      await preorders(restaurantId, userId, products);
    } else {
      await trade(def, restaurantId, userId, products, tableRows);
    }
  }
  say(`Logins: ${LOGINS}`);
}

main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => pool.end());
