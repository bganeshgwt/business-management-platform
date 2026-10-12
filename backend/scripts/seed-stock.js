#!/usr/bin/env node
//
// Gives the demo restaurant's store the shape a real one has after a couple
// of weeks of the new stock screens: suppliers with credit terms, items with
// storage areas and the packs they are bought in, the daily vegetable, meat
// and dairy bills entered without purchase orders, a supplier payment or two,
// last week's walk-in count posted and this week's dry-store count half done.
//
//   node scripts/seed-stock.js
//   DB_NAME=restaurant_management_test node scripts/seed-stock.js
//
// Safe to run again: every bill carries a fixed bill number and is skipped if
// it is already there; storage areas, packs and credit days are only filled
// where empty; the counts are only created once. It never deletes anything.
require("dotenv").config();

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const supplierService = require("../src/modules/restaurant/purchasing/services/supplier.service");
const inventoryService = require("../src/modules/restaurant/inventory/services/inventory.service");
const purchaseService = require("../src/modules/restaurant/purchasing/services/purchase.service");
const purchaseReturnService = require("../src/modules/restaurant/purchasing/services/purchaseReturn.service");
const businessDayRepository = require("../src/modules/restaurant/business-day/repositories/businessDay.repository");

const say = (message) => console.log(message);

const isoDate = (date) => date.toLocaleDateString("en-CA");

const daysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return isoDate(date);
};

// The supplier roster seed-demo.js uses, with the credit each really gives.
const SUPPLIERS = [
  {
    name: "Sri Venkateswara Traders",
    contactPerson: "K. Ramesh",
    mobile: "9848011223",
    email: "orders@svtraders.example",
    address: "Shop 14, Rythu Bazaar Road, Rajahmundry",
    gstNumber: "37AABCS1429B1Z5",
    paymentTerms: "15 days credit",
    creditDays: 15,
  },
  {
    name: "Godavari Fresh Vegetables",
    contactPerson: "M. Lakshmi",
    mobile: "9885044556",
    address: "Stall 7, Kotipalli Bus Stand Market, Rajahmundry",
    paymentTerms: "Cash on delivery",
    creditDays: 0,
  },
  {
    name: "Krishna Dairy & Foods",
    contactPerson: "B. Srinivas",
    mobile: "9963077889",
    email: "supply@krishnadairy.example",
    address: "Danavaipeta, Rajahmundry",
    gstNumber: "37AADCK9021M1ZP",
    paymentTerms: "7 days credit",
    creditDays: 7,
  },
  {
    name: "Coastal Meat Suppliers",
    contactPerson: "A. Farooq",
    mobile: "9701033445",
    address: "Alcot Gardens, Rajahmundry",
    paymentTerms: "Weekly settlement",
    creditDays: 7,
  },
];

// Where each kind of stock is kept, in the order a store is walked.
const AREAS = {
  Dairy: "Walk-in cooler",
  Meat: "Freezer",
  Seafood: "Freezer",
  Vegetables: "Veg rack",
  Grains: "Dry store",
  Grocery: "Dry store",
  Spices: "Dry store",
  Oils: "Dry store",
  Beverages: "Bar store",
};

// How the market sells them.
const PACKS = {
  "Basmati Rice": [{ name: "Bag 25 kg", size: 25 }],
  "Wheat Flour": [{ name: "Bag 10 kg", size: 10 }],
  Sugar: [{ name: "Bag 50 kg", size: 50 }],
  Salt: [{ name: "Packet 1 kg", size: 1 }],
  Ghee: [{ name: "Tin 15 L", size: 15 }],
  Onion: [{ name: "Sack 50 kg", size: 50 }],
  Potato: [{ name: "Sack 50 kg", size: 50 }],
  Tomato: [{ name: "Crate 25 kg", size: 25 }],
  Milk: [{ name: "Crate 12 L", size: 12 }],
  "Mineral Water Bottle": [{ name: "Case of 24", size: 24 }],
  "Soft Drink Bottle": [{ name: "Crate of 24", size: 24 }],
};

// The daily buying that never has a purchase order: [days ago, supplier,
// bill number, paid on delivery?, lines [item, quantity, price, GST %]].
const BILLS = [
  [11, "Godavari Fresh Vegetables", "GFV-2231", true, [["Onion", 20, 29, 0], ["Tomato", 15, 34, 0], ["Green Chilli", 2, 76, 0]]],
  [10, "Coastal Meat Suppliers", "CMS-0917", false, [["Chicken", 12, 228, 0], ["Mutton", 4, 705, 0]]],
  [9, "Krishna Dairy & Foods", "KDF/24-25/1187", false, [["Paneer", 6, 320, 5], ["Curd", 10, 76, 5], ["Milk", 24, 58, 0]]],
  [8, "Godavari Fresh Vegetables", "GFV-2248", true, [["Potato", 20, 26, 0], ["Capsicum", 4, 58, 0], ["Tomato", 10, 36, 0]]],
  [7, "Sri Venkateswara Traders", "SVT/1463", false, [["Basmati Rice", 25, 112, 5], ["Sugar", 10, 42, 5], ["Garam Masala", 1, 590, 5], ["Cashew Nuts", 2, 900, 5]]],
  [6, "Coastal Meat Suppliers", "CMS-0931", false, [["Chicken", 15, 232, 0], ["Prawns", 3, 560, 0]]],
  [5, "Krishna Dairy & Foods", "KDF/24-25/1204", false, [["Paneer", 5, 325, 5], ["Butter", 4, 515, 12], ["Milk", 24, 58, 0]]],
  [4, "Godavari Fresh Vegetables", "GFV-2263", true, [["Onion", 25, 30, 0], ["Green Chilli", 2, 80, 0], ["Tomato", 12, 38, 0]]],
  [2, "Godavari Fresh Vegetables", "GFV-2279", true, [["Potato", 15, 27, 0], ["Capsicum", 3, 60, 0]]],
  [1, "Krishna Dairy & Foods", "KDF/24-25/1221", false, [["Paneer", 4, 330, 5], ["Curd", 8, 80, 5]]],
  [0, "Coastal Meat Suppliers", "CMS-0948", false, [["Chicken", 10, 233, 0]]],
];

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant to seed.");
    return;
  }

  const restaurantId = Number(restaurant.id);

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "stock_recipes")) {

    return;

  }
  const admin = (
    await pool.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.restaurant_id = $1 AND r.code IN ('RESTAURANT_ADMIN', 'MANAGER')
       ORDER BY u.id LIMIT 1`,
      [restaurantId]
    )
  ).rows[0];
  const userId = admin ? Number(admin.id) : null;

  say(`Stock and purchasing for ${restaurant.name}`);

  // --- suppliers and their credit days ---
  const suppliers = new Map();

  for (const definition of SUPPLIERS) {
    const found = (
      await pool.query(
        "SELECT id, credit_days FROM suppliers WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)",
        [restaurantId, definition.name]
      )
    ).rows[0];

    if (found) {
      if (found.credit_days === null) {
        await pool.query("UPDATE suppliers SET credit_days = $2 WHERE id = $1", [found.id, definition.creditDays]);
      }

      suppliers.set(definition.name, Number(found.id));
    } else {
      const created = await supplierService.create(
        restaurantId,
        {
          code: null,
          status: "active",
          email: null,
          gstNumber: null,
          ...definition,
        },
        userId
      );
      suppliers.set(definition.name, created.id);
    }
  }

  say(`  suppliers · ${suppliers.size} with credit terms`);

  // --- storage areas and packs ---
  const items = await inventoryService.listItems(restaurantId, {});
  const byName = new Map(items.map((item) => [item.name, item]));
  let areas = 0;
  let packs = 0;

  for (const item of items) {
    if (!item.storageArea && AREAS[item.category]) {
      await pool.query("UPDATE inventory_items SET storage_area = $2 WHERE id = $1", [item.id, AREAS[item.category]]);
      areas += 1;
    }

    if (item.packs.length === 0 && PACKS[item.name]) {
      await inventoryService.replacePacks(restaurantId, item.id, PACKS[item.name], userId);
      packs += 1;
    }
  }

  say(`  storage areas · ${areas} set · packs · ${packs} items`);

  // --- purchase bills without an order ---
  const openDay = await businessDayRepository.findOpen(restaurantId);
  let bills = 0;

  for (const [ago, supplierName, billNumber, paid, lines] of BILLS) {
    const supplierId = suppliers.get(supplierName);
    const exists = (
      await pool.query(
        "SELECT 1 FROM goods_receipts WHERE restaurant_id = $1 AND supplier_id = $2 AND LOWER(bill_number) = LOWER($3)",
        [restaurantId, supplierId, billNumber]
      )
    ).rows.length;

    const priced = lines.filter(([name]) => byName.has(name));

    if (exists || priced.length === 0) {
      continue;
    }

    await purchaseService.createDirect(
      restaurantId,
      {
        supplierId,
        billNumber,
        billDate: daysAgo(ago),
        receivedDate: daysAgo(ago),
        pricesIncludeTax: false,
        billTotal: null,
        notes: null,
        paymentMode: paid ? "paid" : "credit",
        paymentMethod: "cash",
        // Only today's cash can come out of today's drawer.
        paidFromTill: paid && ago === 0 && Boolean(openDay),
        paymentReference: null,
        outletId: null,
        lines: priced.map(([name, quantity, unitPrice, taxRate]) => ({
          inventoryItemId: byName.get(name).id,
          packId: null,
          quantity,
          rejectedQuantity: 0,
          rejectionReason: null,
          unitPrice,
          taxRate,
        })),
      },
      userId
    );
    bills += 1;
  }

  say(`  purchase bills · ${bills} added`);

  // --- a payment on account ---
  const svt = suppliers.get("Sri Venkateswara Traders");
  const paidAlready = (
    await pool.query(
      "SELECT 1 FROM supplier_payments WHERE restaurant_id = $1 AND supplier_id = $2 AND reference_no = 'NEFT-SEED-0412'",
      [restaurantId, svt]
    )
  ).rows.length;

  if (!paidAlready) {
    await purchaseReturnService.createPayment(
      restaurantId,
      {
        supplierId: svt,
        purchaseOrderId: null,
        goodsReceiptId: null,
        paymentDate: daysAgo(3),
        amount: 2000,
        paymentMethod: "bank",
        referenceNo: "NEFT-SEED-0412",
        notes: "Part payment against SVT/1463",
        paidFromTill: false,
      },
      userId
    );
    say("  supplier payment · 1 added");
  }

  // --- last week's walk-in count, posted; this week's dry store, half done ---
  const counted = (
    await pool.query("SELECT notes FROM stock_counts WHERE restaurant_id = $1 AND notes LIKE 'Seed:%'", [restaurantId])
  ).rows.map((row) => row.notes);

  if (!counted.includes("Seed: weekly walk-in cooler count")) {
    try {
      const sheet = await inventoryService.createCount(
        restaurantId,
        {
          outletId: null,
          categories: ["Dairy"],
          storageAreas: ["Walk-in cooler"],
          countedAt: null,
          blind: false,
          notes: "Seed: weekly walk-in cooler count",
        },
        userId
      );

      // Most lines match; paneer and curd come up short, milk a little over.
      const off = { Paneer: -0.4, Curd: -0.6, Milk: 0.5 };
      const reasons = { Paneer: "staff_meals", Curd: "wastage_not_logged", Milk: "delivery_not_entered" };

      await inventoryService.saveCountLines(
        restaurantId,
        sheet.id,
        {
          lines: sheet.lines
            .filter((line) => line.systemQuantity !== null && line.systemQuantity >= 0)
            .map((line) => ({
              id: line.id,
              countedQuantity: Math.max(0, Math.round((line.systemQuantity + (off[line.itemName] || 0)) * 1000) / 1000),
              reason: reasons[line.itemName] || null,
              note: line.itemName === "Paneer" ? "Staff lunch on Sunday not entered" : null,
            })),
        },
        userId
      );
      await inventoryService.postCount(restaurantId, sheet.id, userId);
      say(`  stock count · ${sheet.countNumber} posted`);
    } catch (error) {
      say(`  stock count · skipped (${error.message})`);
    }
  }

  if (!counted.includes("Seed: dry store count in progress")) {
    try {
      const sheet = await inventoryService.createCount(
        restaurantId,
        {
          outletId: null,
          categories: ["Grocery", "Grains", "Spices", "Oils"],
          storageAreas: ["Dry store"],
          countedAt: null,
          blind: false,
          notes: "Seed: dry store count in progress",
        },
        userId
      );

      await inventoryService.saveCountLines(
        restaurantId,
        sheet.id,
        {
          lines: sheet.lines.slice(0, Math.ceil(sheet.lines.length / 2)).map((line, index) => ({
            id: line.id,
            countedQuantity: Math.max(0, Math.round(((line.systemQuantity || 0) - (index % 3 === 0 ? 0.25 : 0)) * 1000) / 1000),
            reason: index % 3 === 0 ? "unexplained" : null,
            note: null,
          })),
        },
        userId
      );
      say(`  stock count · ${sheet.countNumber} left open, half counted`);
    } catch (error) {
      say(`  stock count · skipped (${error.message})`);
    }
  }

  // --- half plates use half the dish recipe unless they have their own ---
  const halves = await pool.query(
    `UPDATE product_variants v SET recipe_factor = 0.5
     WHERE v.restaurant_id = $1 AND LOWER(v.name) = 'half' AND v.recipe_factor IS NULL
       AND NOT EXISTS (SELECT 1 FROM product_recipes r WHERE r.product_variant_id = v.id)
     RETURNING v.id`,
    [restaurantId]
  );

  say(`  half plates · ${halves.rows.length} set to half the dish recipe`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
