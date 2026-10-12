#!/usr/bin/env node
//
// Gives the demo restaurant something for the bell to say.
//
// Notifications are never stored — the bell works them out from live data —
// so this script does not write alerts. It writes the ordinary, realistic
// situations alerts come from, through the same services the screens use:
//
//   - a cold-room failure: the cream is written off as wastage (out of stock)
//     and the paneer is brought below its reorder level;
//   - a dairy order that did not turn up yesterday, and a weekend stock-up
//     due in today;
//   - three open guest complaints (one high priority, one over a day old);
//   - two poor ratings left today;
//   - three expenses waiting for a manager's approval, one for three days.
//
// It never creates bills: an unpaid bill would stop the day being closed,
// and the demo already takes payments through topup-demo.js.
//
//   node scripts/seed-notifications.js
//   DB_NAME=restaurant_management_test node scripts/seed-notifications.js
//
// Safe to run again: each piece is skipped when it is already there (by its
// subject, reference number, note or reason), and nothing is ever deleted.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const inventoryService = require("../src/modules/restaurant/inventory/services/inventory.service");
const purchaseService = require("../src/modules/restaurant/purchasing/services/purchase.service");
const crmService = require("../src/modules/restaurant/crm/services/crm.service");
const expenseService = require("../src/modules/restaurant/expenses/services/expense.service");

const say = (message) => console.log(message);

const localDate = (timezone, offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    new Date(Date.now() + offsetDays * 86400000)
  );

// The first name on the list that the restaurant actually stocks.
const findByName = (rows, names) => {
  for (const name of names) {
    const found = rows.find((row) => row.name.toLowerCase() === name.toLowerCase());

    if (found) {
      return found;
    }
  }

  return null;
};

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant found — run the demo seed first.");
    return;
  }

  const restaurantId = restaurant.id;
  const admin = (
    await pool.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.restaurant_id = $1 AND u.status = 'active' AND r.code = 'RESTAURANT_ADMIN'
       ORDER BY u.id LIMIT 1`,
      [restaurantId]
    )
  ).rows[0];

  if (!admin) {
    say(`${restaurant.name} has no active admin to record these as — skipped.`);
    return;
  }

  const userId = admin.id;
  const settings = (
    await pool.query("SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1", [restaurantId])
  ).rows[0];
  const timezone = (settings && settings.timezone) || "Asia/Kolkata";

  say(`Seeding notification scenarios for ${restaurant.name} (${timezone})`);

  // ------------------------------------------------------------ stock
  const units = (
    await pool.query("SELECT id, short_name FROM units WHERE restaurant_id = $1 AND status = 'active'", [
      restaurantId,
    ])
  ).rows;
  const unitFor = (short) => units.find((unit) => unit.short_name.toLowerCase() === short) || units[0];

  const loadItems = async () =>
    (
      await pool.query(
        `SELECT id, name, current_stock, reorder_level, last_cost
         FROM inventory_items WHERE restaurant_id = $1 AND status = 'active'`,
        [restaurantId]
      )
    ).rows;

  // Brings an item down to `target` with a wastage entry, or creates it at
  // that level if the restaurant does not stock it yet. The reason doubles as
  // the marker that it has been done.
  const shortage = async ({ names, create, target, reason }) => {
    if (!units.length) {
      say("  stock: no units defined — skipped");
      return null;
    }

    const item = findByName(await loadItems(), names);

    if (!item) {
      const made = await inventoryService.createItem(
        restaurantId,
        {
          name: create.name,
          code: null,
          unitId: unitFor(create.unit).id,
          category: create.category,
          reorderLevel: create.reorderLevel,
          status: "active",
          openingStock: target,
          openingCost: create.cost,
        },
        userId
      );
      say(`  stock: added ${made.name} at ${target} (reorder level ${create.reorderLevel})`);
      return made.id;
    }

    const done = await pool.query(
      "SELECT 1 FROM stock_transactions WHERE restaurant_id = $1 AND inventory_item_id = $2 AND reason = $3",
      [restaurantId, item.id, reason]
    );

    if (done.rows.length || Number(item.current_stock) <= target) {
      say(`  stock: ${item.name} already short — left as it is`);
      return item.id;
    }

    const quantity = Math.round((Number(item.current_stock) - target) * 1000) / 1000;

    await inventoryService.recordMovement(
      restaurantId,
      {
        inventoryItemId: item.id,
        transactionType: "wastage",
        quantity: -quantity,
        reason,
        notes: "Logged by the closing manager",
      },
      userId
    );

    say(`  stock: ${item.name} written down by ${quantity} to ${target}`);
    return item.id;
  };

  const creamId = await shortage({
    names: ["Fresh Cream", "Cream"],
    create: { name: "Fresh Cream", unit: "l", category: "Dairy", reorderLevel: 5, cost: 215 },
    target: 0,
    reason: "Spoiled — cold room lost power overnight",
  });

  const paneerId = await shortage({
    names: ["Paneer"],
    create: { name: "Paneer", unit: "kg", category: "Dairy", reorderLevel: 8, cost: 330 },
    target: 3.5,
    reason: "Spoiled — cold room lost power overnight (paneer)",
  });

  // ------------------------------------------------------------ purchase orders
  const suppliers = (
    await pool.query("SELECT id, name FROM suppliers WHERE restaurant_id = $1 AND status = 'active' ORDER BY id", [
      restaurantId,
    ])
  ).rows;

  const items = await loadItems();
  const priceOf = (item, fallback) => Number(item.last_cost) || fallback;

  const purchaseOrder = async ({ note, supplierNames, orderOffset, expectedOffset, lines }) => {
    const open = await pool.query(
      `SELECT po_number FROM purchase_orders
       WHERE restaurant_id = $1 AND notes = $2 AND po_status IN ('ordered', 'partial')`,
      [restaurantId, note]
    );

    if (open.rows.length) {
      say(`  purchasing: ${open.rows[0].po_number} (${note}) is already on order`);
      return;
    }

    const supplier = findByName(suppliers, supplierNames) || suppliers[0];
    const resolved = lines
      .map((line) => ({ item: line.id ? items.find((row) => row.id === line.id) : findByName(items, line.names), line }))
      .filter((entry) => entry.item);

    if (!supplier || resolved.length === 0) {
      say(`  purchasing: no supplier or items for "${note}" — skipped`);
      return;
    }

    const order = await purchaseService.create(
      restaurantId,
      {
        supplierId: supplier.id,
        orderDate: localDate(timezone, orderOffset),
        expectedDate: localDate(timezone, expectedOffset),
        poStatus: "ordered",
        notes: note,
        items: resolved.map(({ item, line }) => ({
          inventoryItemId: item.id,
          quantity: line.quantity,
          unitPrice: priceOf(item, line.price),
        })),
      },
      userId
    );

    say(`  purchasing: ${order.poNumber} to ${supplier.name}, due ${localDate(timezone, expectedOffset)}`);
  };

  // Placed four days ago for yesterday — and it has not come.
  await purchaseOrder({
    note: "Weekly dairy order — confirmed on the phone with Ramesh",
    supplierNames: ["Krishna Dairy & Foods", "Fresh Farms"],
    orderOffset: -4,
    expectedOffset: -1,
    lines: [
      { id: creamId, quantity: 15, price: 215 },
      { id: paneerId, quantity: 10, price: 330 },
      { names: ["Butter", "Curd"], quantity: 5, price: 250 },
    ],
  });

  // Due in today, so someone is ready at the back door to weigh it in.
  await purchaseOrder({
    note: "Weekend stock-up — vegetables and staples",
    supplierNames: ["Godavari Fresh Vegetables", "Fresh Farms"],
    orderOffset: -1,
    expectedOffset: 0,
    lines: [
      { names: ["Tomato", "Basmati Rice"], quantity: 25, price: 40 },
      { names: ["Onion", "Sunflower Oil"], quantity: 40, price: 32 },
      { names: ["Capsicum", "Potato"], quantity: 8, price: 58 },
    ],
  });

  // ------------------------------------------------------------ complaints
  const complaint = async ({ subject, hoursAgo, ...rest }) => {
    const exists = await pool.query("SELECT 1 FROM complaints WHERE restaurant_id = $1 AND subject = $2", [
      restaurantId,
      subject,
    ]);

    if (exists.rows.length) {
      say(`  complaints: "${subject}" already logged`);
      return;
    }

    const created = await crmService.createComplaint(
      restaurantId,
      {
        subject,
        customerId: null,
        assignedTo: null,
        complaintStatus: "open",
        ...rest,
      },
      userId
    );

    await pool.query(
      "UPDATE complaints SET created_at = NOW() - make_interval(mins => $2) WHERE id = $1",
      [created.id, Math.round(hoursAgo * 60)]
    );

    say(`  complaints: logged "${subject}"`);
  };

  await complaint({
    subject: "Hair found in the paneer butter masala",
    description: "Guest at table 6 showed the server a hair in the curry. Dish was taken back; guest is upset and wants to speak to the manager.",
    category: "hygiene",
    priority: "high",
    customerName: "Srinivas Rao",
    customerMobile: "9848022331",
    hoursAgo: 0.7,
  });

  await complaint({
    subject: "Delivery arrived 50 minutes late and cold",
    description: "Swiggy order for 3 biryanis. Rider picked up late; guest called the restaurant directly.",
    category: "delivery",
    priority: "medium",
    customerName: "Lakshmi Prasanna",
    customerMobile: "9912034567",
    hoursAgo: 5,
  });

  await complaint({
    subject: "Charged for two mineral water bottles, only one served",
    description: "Guest noticed on the bill after paying by UPI. Asked for ₹20 back.",
    category: "billing",
    priority: "low",
    customerName: "Arjun Varma",
    customerMobile: "9701456789",
    hoursAgo: 28,
  });

  // ------------------------------------------------------------ feedback
  const feedback = async ({ comments, minutesAgo, ...rest }) => {
    const exists = await pool.query(
      `SELECT 1 FROM feedback
       WHERE restaurant_id = $1 AND comments = $2 AND created_at > NOW() - INTERVAL '20 hours'`,
      [restaurantId, comments]
    );

    if (exists.rows.length) {
      say("  feedback: today's poor rating already recorded");
      return;
    }

    await crmService.createFeedback(
      restaurantId,
      { customerId: null, comments, feedbackStatus: "new", ...rest },
      userId
    );

    // createFeedback answers with the list, so the new row is found by its text.
    await pool.query(
      `UPDATE feedback SET created_at = NOW() - make_interval(mins => $3)
       WHERE id = (SELECT id FROM feedback WHERE restaurant_id = $1 AND comments = $2 ORDER BY id DESC LIMIT 1)`,
      [restaurantId, comments, minutesAgo]
    );

    say(`  feedback: ${rest.rating}★ from ${rest.customerName}`);
  };

  await feedback({
    rating: 2,
    comments: "Starters took 40 minutes and the butter naan came to the table cold.",
    customerName: "Karthik Reddy",
    customerMobile: "9866123450",
    source: "qr",
    minutesAgo: 35,
  });

  await feedback({
    rating: 1,
    comments: "AC in the family hall was not working. Very uncomfortable with kids.",
    customerName: "Meena Subramanian",
    customerMobile: null,
    source: "in_store",
    minutesAgo: 95,
  });

  // ------------------------------------------------------------ expenses
  const categories = (
    await pool.query("SELECT id, name FROM expense_categories WHERE restaurant_id = $1 AND status = 'active' ORDER BY id", [
      restaurantId,
    ])
  ).rows;

  const expense = async ({ referenceNo, categoryNames, daysAgo, ...rest }) => {
    const exists = await pool.query("SELECT 1 FROM expenses WHERE restaurant_id = $1 AND reference_no = $2", [
      restaurantId,
      referenceNo,
    ]);

    if (exists.rows.length) {
      say(`  expenses: ${referenceNo} already entered`);
      return;
    }

    const category = findByName(categories, categoryNames) || categories[0];

    if (!category) {
      say("  expenses: no expense categories — skipped");
      return;
    }

    const created = await expenseService.create(
      restaurantId,
      {
        expenseCategoryId: category.id,
        supplierId: null,
        expenseDate: localDate(timezone, -daysAgo),
        referenceNo,
        ...rest,
      },
      userId
    );

    // Entered when it was spent, so "waiting 3 days" is true.
    await pool.query(
      "UPDATE expenses SET created_at = NOW() - make_interval(days => $2, hours => 2) WHERE id = $1",
      [created.id, daysAgo]
    );

    say(`  expenses: ${referenceNo} (${category.name}) awaiting approval`);
  };

  await expense({
    referenceNo: "HPG-448213",
    categoryNames: ["Utilities"],
    amount: 3780,
    paymentMode: "cash",
    notes: "HP Gas — 2 commercial cylinders, paid to the delivery man",
    daysAgo: 3,
  });

  await expense({
    referenceNo: "PLB-0924",
    categoryNames: ["Maintenance", "Repairs"],
    amount: 1200,
    paymentMode: "upi",
    notes: "Plumber — kitchen sink blockage cleared",
    daysAgo: 0,
  });

  await expense({
    referenceNo: "PC-2609",
    categoryNames: ["Maintenance", "Miscellaneous"],
    amount: 2500,
    paymentMode: "bank",
    notes: "Pest control — monthly service",
    daysAgo: 0,
  });

  say("Done. Open the bell in the top bar, or /notifications.");
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
