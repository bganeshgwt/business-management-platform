#!/usr/bin/env node
//
// Sets up the kitchen display for the demo restaurant:
//
//   1. Stations — Main kitchen (the catch-all), Tandoor, Chinese wok,
//      Desserts and Beverages.
//   2. Routing — each menu category to its station by what it is called, and
//      the dishes a real kitchen cooks somewhere other than their category
//      (Paneer Tikka in the tandoor, Chilli Chicken off the wok).
//   3. A board in the middle of service — a few tables and parcels placed
//      through the real order service over the last hour, so some tickets are
//      new, some cooking, one waiting at the pass and one running late, with
//      a table on its second round and the earlier tickets already served.
//
//   node scripts/seed-kitchen.js
//
// Safe to run again: stations and routing are only added where missing (a
// manager's own changes are left alone), and the board is only filled when
// the kitchen is quiet. It never deletes anything.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");
const kitchenRepository = require("../src/modules/restaurant/kitchen/repositories/kitchen.repository");

const say = (message) => console.log(message);

const STATIONS = [
  { name: "Main kitchen", color: "orange", sortOrder: 0 },
  { name: "Tandoor", color: "red", sortOrder: 10 },
  { name: "Chinese wok", color: "violet", sortOrder: 20 },
  { name: "Desserts", color: "pink", sortOrder: 30 },
  { name: "Beverages", color: "teal", sortOrder: 40 },
];

// A category goes where its name says it is cooked; anything else stays with
// the main kitchen, which is the default.
const CATEGORY_RULES = [
  [/bread|roti|naan|tandoor|kebab|kabab/i, "Tandoor"],
  [/chinese|wok|noodle|indo.?chinese/i, "Chinese wok"],
  [/dessert|sweet|ice ?cream|mithai/i, "Desserts"],
  [/beverage|drink|juice|shake|mocktail|lassi|coffee|tea|cooler|bar/i, "Beverages"],
];

// The demo menu files these under Starters, but they are not cooked there.
const DISH_EXCEPTIONS = [
  ["Paneer Tikka", "Tandoor"],
  ["Gobi Manchurian", "Chinese wok"],
  ["Chilli Chicken", "Chinese wok"],
  ["Veg Spring Roll", "Chinese wok"],
];

// The board is only filled when fewer tickets than this are open.
const QUIET_BELOW = 6;

const main = async () => {
  const restaurant = await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1");

  if (restaurant.rows.length === 0) {
    say("No restaurant found. Run scripts/seed-demo.js first.");
    return;
  }

  const restaurantId = Number(restaurant.rows[0].id);

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "kitchen_display")) {

    return;

  }
  const user = await pool.query(
    "SELECT id FROM users WHERE restaurant_id = $1 ORDER BY id LIMIT 1",
    [restaurantId]
  );
  const userId = user.rows[0] ? Number(user.rows[0].id) : null;

  say(`Kitchen display for ${restaurant.rows[0].name}`);

  // ---------------------------------------------------------------- stations
  // The catch-all first, so "Main kitchen" is the default however this
  // restaurant started.
  await kitchenRepository.ensureDefault(restaurantId);

  for (const station of STATIONS) {
    await pool.query(
      `INSERT INTO kitchen_stations (restaurant_id, name, color, sort_order, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT DO NOTHING`,
      [restaurantId, station.name, station.color, station.sortOrder, userId]
    );
  }

  const stationRows = (
    await pool.query(
      "SELECT id, name, status FROM kitchen_stations WHERE restaurant_id = $1",
      [restaurantId]
    )
  ).rows;
  const stationId = (name) => {
    const found = stationRows.find((row) => row.name.toLowerCase() === name.toLowerCase());
    return found && found.status === "active" ? found.id : null;
  };

  say(`  stations · ${stationRows.map((row) => row.name).join(", ")}`);

  // ---------------------------------------------------------------- routing
  const categories = (
    await pool.query("SELECT id, name FROM categories WHERE restaurant_id = $1", [restaurantId])
  ).rows;
  let routed = 0;

  for (const category of categories) {
    const rule = CATEGORY_RULES.find(([pattern]) => pattern.test(category.name));
    const target = rule ? stationId(rule[1]) : null;

    if (!target) {
      continue;
    }

    const inserted = await pool.query(
      `INSERT INTO kitchen_category_stations (category_id, restaurant_id, station_id, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (category_id) DO NOTHING
       RETURNING category_id`,
      [category.id, restaurantId, target, userId]
    );

    routed += inserted.rowCount;
  }

  let exceptions = 0;

  for (const [dish, station] of DISH_EXCEPTIONS) {
    const target = stationId(station);

    if (!target) {
      continue;
    }

    const inserted = await pool.query(
      `INSERT INTO kitchen_product_stations (product_id, restaurant_id, station_id, updated_by)
       SELECT p.id, p.restaurant_id, $3, $4
       FROM products p
       WHERE p.restaurant_id = $1 AND LOWER(p.name) = LOWER($2)
       ON CONFLICT (product_id) DO NOTHING
       RETURNING product_id`,
      [restaurantId, dish, target, userId]
    );

    exceptions += inserted.rowCount;
  }

  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

  say(
    `  routing · ${plural(routed, "category", "categories")} and ${plural(
      exceptions,
      "dish",
      "dishes"
    )} newly routed`
  );

  // ---------------------------------------------------------------- a live board
  const day = await pool.query(
    `SELECT id FROM business_days
     WHERE restaurant_id = $1 AND day_status = 'open'
     ORDER BY outlet_id NULLS FIRST LIMIT 1`,
    [restaurantId]
  );

  if (day.rows.length === 0) {
    say("  board · no business day is open, so no orders can be placed. Open a day and run again.");
    return;
  }

  // Makes sure the go-live mark exists before any demo order does.
  await kitchenRepository.findSettings(restaurantId);

  const open = await pool.query(
    `SELECT COUNT(*)::int AS count FROM kots
     WHERE restaurant_id = $1 AND kot_status IN ('new', 'cooking', 'ready')`,
    [restaurantId]
  );

  if (open.rows[0].count >= QUIET_BELOW) {
    say(`  board · already ${open.rows[0].count} tickets open — leaving service as it is`);
    return;
  }

  const products = new Map(
    (
      await pool.query(
        `SELECT id, name FROM products
         WHERE restaurant_id = $1 AND status = 'active' AND is_available = TRUE`,
        [restaurantId]
      )
    ).rows.map((row) => [row.name.toLowerCase(), Number(row.id)])
  );

  const modifierId = async (name) => {
    const result = await pool.query(
      `SELECT id FROM modifiers WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
         AND status = 'active' LIMIT 1`,
      [restaurantId, name]
    );
    return result.rows[0] ? Number(result.rows[0].id) : null;
  };

  const halfOf = async (productId) => {
    const result = await pool.query(
      `SELECT id FROM product_variants
       WHERE product_id = $1 AND LOWER(name) = 'half' AND status = 'active' LIMIT 1`,
      [productId]
    );
    return result.rows[0] ? Number(result.rows[0].id) : null;
  };

  // [dish, quantity, { note, modifier, half }]
  const lines = async (wanted) => {
    const built = [];

    for (const [name, quantity, extra = {}] of wanted) {
      const productId = products.get(name.toLowerCase());

      if (!productId) {
        continue;
      }

      const modifier = extra.modifier ? await modifierId(extra.modifier) : null;

      built.push({
        productId,
        productVariantId: extra.half ? await halfOf(productId) : null,
        modifierIds: modifier ? [modifier] : [],
        quantity,
        notes: extra.note || null,
      });
    }

    return built;
  };

  const freeTables = (
    await pool.query(
      `SELECT id, table_no, capacity FROM dining_tables
       WHERE restaurant_id = $1 AND status = 'active' AND table_status = 'available'
       ORDER BY capacity, id`,
      [restaurantId]
    )
  ).rows.map((row) => ({ id: Number(row.id), tableNo: row.table_no, capacity: row.capacity }));

  const takeTable = (guests) => {
    const index = freeTables.findIndex((table) => table.capacity >= guests);
    const at = index >= 0 ? index : freeTables.length > 0 ? 0 : -1;
    return at >= 0 ? freeTables.splice(at, 1)[0] : null;
  };

  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

  // Stamps lines saved in the last moment with the time they would have been
  // rung up, so the kitchen clocks read like a real service — and the
  // tickets they went out on with the same time. The order service cuts a
  // KOT the moment an order is saved, so by now the round's tickets exist,
  // stamped "now"; left so, a ticket would be marked ready (minutes ago)
  // before it was sent, and the board's average ticket time came out
  // negative. A course sent at once was fired when it was rung up.
  const stampRound = async (orderId, minutes) => {
    const at = minutesAgo(minutes);

    await pool.query(
      `UPDATE order_items
       SET created_at = $2,
           fired_at = CASE WHEN fire_status = 'fired' THEN $2::timestamptz ELSE fired_at END
       WHERE order_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'`,
      [orderId, at]
    );
    await pool.query(
      `UPDATE kots SET created_at = $2
       WHERE order_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'`,
      [orderId, at]
    );
    await pool.query(
      `UPDATE kot_items SET created_at = $2
       WHERE order_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'`,
      [orderId, at]
    );
  };

  // Moves an order's tickets for one station on, with the times it happened.
  const progress = async (orderId, stationName, status, times) => {
    const station = stationId(stationName);

    if (!station) {
      return;
    }

    await pool.query(
      `UPDATE kots SET kot_status = $3,
              started_at = $4, ready_at = $5, served_at = $6,
              started_by = CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE $7::bigint END,
              ready_by = CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE $7::bigint END,
              served_by = CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE $7::bigint END
       WHERE order_id = $1 AND station_id = $2 AND kot_status NOT IN ('served', 'cancelled')
         AND created_at = (SELECT MAX(created_at) FROM kots WHERE order_id = $1 AND station_id = $2)`,
      [
        orderId,
        station,
        status,
        times.started ? minutesAgo(times.started) : null,
        times.ready ? minutesAgo(times.ready) : null,
        times.served ? minutesAgo(times.served) : null,
        userId,
      ]
    );

    if (status === "ready" || status === "served") {
      await pool.query(
        `UPDATE kot_items ki SET is_done = TRUE, done_at = k.ready_at, done_by = $3
         FROM kots k
         WHERE k.id = ki.kot_id AND k.order_id = $1 AND k.station_id = $2 AND NOT ki.is_done`,
        [orderId, station, userId]
      );
    }
  };

  const placed = [];

  const place = async ({ type, guests, customer, notes, source, round, at }) => {
    const table = type === "dine_in" ? takeTable(guests) : null;
    const orderType = type === "dine_in" && !table ? "takeaway" : type;
    const items = await lines(round);

    if (items.length === 0) {
      return null;
    }

    try {
      const order = await orderService.create(
        restaurantId,
        {
          orderType,
          source: source || (orderType === "dine_in" ? "captain" : "pos"),
          tableId: table ? table.id : null,
          outletId: null,
          customerId: null,
          customerName: customer || null,
          customerMobile: null,
          guestCount: orderType === "dine_in" ? guests : null,
          notes: notes || null,
          items,
        },
        userId
      );

      await pool.query("UPDATE orders SET placed_at = $2 WHERE id = $1", [order.id, minutesAgo(at)]);
      await stampRound(order.id, at);
      await kitchenRepository.sync(restaurantId, { orderIds: [order.id] });
      placed.push(order.id);

      return { order, items, guests, customer, notes };
    } catch (error) {
      say(`  skipped an order: ${error.message}`);
      return null;
    }
  };

  // A second round on the same order: the POS saves the whole order again,
  // and the kitchen must send only what is new.
  const addRound = async (placedOrder, round, at) => {
    if (!placedOrder) {
      return;
    }

    const more = await lines(round);

    await orderService.updateItems(
      restaurantId,
      placedOrder.order.id,
      {
        customerId: null,
        customerName: placedOrder.customer || null,
        customerMobile: null,
        guestCount: placedOrder.order.guestCount,
        notes: placedOrder.notes || null,
        items: [...placedOrder.items, ...more],
      },
      userId
    );

    await stampRound(placedOrder.order.id, at);
    await kitchenRepository.sync(restaurantId, { orderIds: [placedOrder.order.id] });
  };

  // An hour ago: a family of four, fed and nearly done.
  const early = await place({
    type: "dine_in",
    guests: 4,
    at: 58,
    round: [
      ["Chicken Curry", 1],
      ["Jeera Rice", 1],
      ["Butter Naan", 3],
      ["Double Ka Meetha", 2],
      ["Fresh Lime Soda", 2],
    ],
  });

  if (early) {
    await progress(early.order.id, "Beverages", "served", { started: 57, ready: 55, served: 54 });
    await progress(early.order.id, "Main kitchen", "served", { started: 55, ready: 44, served: 42 });
    await progress(early.order.id, "Tandoor", "served", { started: 50, ready: 46, served: 42 });
    await progress(early.order.id, "Desserts", "served", { started: 30, ready: 27, served: 26 });
  }

  // A parcel collected twenty minutes ago, paid at the counter.
  const parcel = await place({
    type: "takeaway",
    customer: "Sandeep",
    at: 41,
    round: [
      ["Chicken Dum Biryani", 1],
      ["Gulab Jamun (2 pc)", 1],
    ],
  });

  if (parcel) {
    await progress(parcel.order.id, "Main kitchen", "served", { started: 39, ready: 29, served: 27 });
    await progress(parcel.order.id, "Desserts", "served", { started: 32, ready: 30, served: 27 });

    try {
      const bill = await billService.createForOrder(
        restaurantId,
        { orderId: parcel.order.id, discountCode: null, outletId: null, loyaltyPoints: null, items: [] },
        userId
      );
      await billService.addPayment(
        restaurantId,
        bill.id,
        { paymentMethod: "upi", amount: bill.dueAmount, tenderedAmount: null, transactionRef: null },
        userId
      );
    } catch (error) {
      say(`  the parcel stays unbilled: ${error.message}`);
    }
  }

  // Starters out and eaten; the mains just went in — two rounds, two tickets.
  const twoRounds = await place({
    type: "dine_in",
    guests: 4,
    at: 34,
    round: [
      ["Paneer Tikka", 1],
      ["Chicken 65", 1, { note: "Extra crispy" }],
    ],
  });

  if (twoRounds) {
    await progress(twoRounds.order.id, "Tandoor", "served", { started: 33, ready: 22, served: 20 });
    await progress(twoRounds.order.id, "Main kitchen", "served", { started: 32, ready: 19, served: 17 });

    await addRound(
      twoRounds,
      [
        ["Butter Chicken", 1, { modifier: "Extra Butter" }],
        ["Dal Tadka", 1],
        ["Butter Naan", 4],
        ["Jeera Rice", 1],
      ],
      7
    );
    await progress(twoRounds.order.id, "Main kitchen", "cooking", { started: 4 });
  }

  // The one running late: a rogan josh that has been on the stove too long.
  const slow = await place({
    type: "dine_in",
    guests: 2,
    at: 24,
    round: [
      ["Mutton Rogan Josh", 1, { note: "Well done, less oil" }],
      ["Garlic Naan", 2],
      ["Sweet Lassi", 2],
    ],
  });

  if (slow) {
    await progress(slow.order.id, "Beverages", "served", { started: 23, ready: 21, served: 20 });
    await progress(slow.order.id, "Main kitchen", "cooking", { started: 21 });
    await progress(slow.order.id, "Tandoor", "cooking", { started: 3 });
  }

  // A parcel whose Chinese is up and waiting at the pass for its biryani.
  const waiting = await place({
    type: "takeaway",
    customer: "Rahul",
    at: 13,
    round: [
      ["Chicken Dum Biryani", 2],
      ["Gobi Manchurian", 1, { note: "Less oil" }],
    ],
  });

  if (waiting) {
    await progress(waiting.order.id, "Chinese wok", "ready", { started: 11, ready: 3 });
    await progress(waiting.order.id, "Main kitchen", "cooking", { started: 10 });
  }

  // A delivery from a partner app: drinks packed, wok going, biryani not yet.
  const delivery = await place({
    type: "delivery",
    source: "partner",
    customer: "Neha",
    at: 9,
    round: [
      ["Veg Biryani", 1],
      ["Chilli Chicken", 1, { modifier: "Extra Spicy" }],
      ["Soft Drink (300 ml)", 2],
    ],
  });

  if (delivery) {
    await progress(delivery.order.id, "Beverages", "served", { started: 8, ready: 7, served: 7 });
    await progress(delivery.order.id, "Chinese wok", "cooking", { started: 5 });
  }

  // Just sat down: a big table with an allergy on the order.
  await place({
    type: "dine_in",
    guests: 6,
    at: 4,
    notes: "One guest is allergic to cashew — no cashew paste in any gravy",
    round: [
      ["Paneer Butter Masala", 2],
      ["Veg Biryani", 1],
      ["Laccha Paratha", 4],
    ],
  });

  // A parcel rung up two minutes ago.
  await place({
    type: "takeaway",
    customer: "Priya",
    at: 2,
    round: [
      ["Kadai Paneer", 1, { half: true, modifier: "No Onion No Garlic" }],
      ["Tandoori Roti", 3],
    ],
  });

  // And a table ordering chai while they read the menu.
  await place({
    type: "dine_in",
    guests: 3,
    at: 1,
    round: [
      ["Masala Chai", 3, { modifier: "Less Spicy" }],
      ["Egg Pakoda", 1],
    ],
  });

  // Order lines and orders take their kitchen status from the tickets.
  if (placed.length > 0) {
    await kitchenRepository.sync(restaurantId, { orderIds: placed });
  }

  const board = await pool.query(
    `SELECT kot_status, COUNT(*)::int AS count FROM kots
     WHERE restaurant_id = $1 AND order_id = ANY($2::bigint[])
     GROUP BY kot_status`,
    [restaurantId, placed]
  );

  say(
    `  board · ${placed.length} orders, ` +
      board.rows.map((row) => `${row.count} ${row.kot_status}`).join(", ")
  );
};

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
