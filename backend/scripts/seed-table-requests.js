#!/usr/bin/env node
//
// QR table requests for a service in full swing: earlier today, guests at the
// tables ordered from their phones (one order added to a table's running
// order, one opening a new table, one turned down because the mutton ran out)
// and called for water, a waiter, a high chair and the bill — all answered.
// Right now two QR orders are waiting to be accepted, one table wants its bill,
// another has asked twice for water, and a captain is on his way to a third.
//
//   node scripts/seed-table-requests.js
//   DB_NAME=restaurant_management_test node scripts/seed-table-requests.js
//
// Safe to run again: every request it makes carries a key built from the
// business date and its slot, and a slot whose key already exists is left
// exactly as it is — including one a member of staff has since accepted. It
// never deletes anything. A new business day gets a new set.
//
// Everything goes through the real paths: the guest's order through the same
// checks and pricing a phone gets, acceptance through the order service. Only
// the clock is then wound back, so the history reads like an evening rather
// than one second.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const tableRequestService = require("../src/modules/restaurant/orders/services/tableRequest.service");
const businessDayRepository = require("../src/modules/restaurant/business-day/repositories/businessDay.repository");

const say = (message) => console.log(message);

// Dishes by preference; the first one the menu actually has, active and not
// sold out, is used. Once each has been used, they are used again — a second
// table can order Butter Naan too. A menu with none of them looks for a dish
// of the same kind by name or category (HINTS), and a kind the menu has no
// dish of at all is simply left off the order: a "bread" slot must never
// come out as whatever dish happens to sit first in the list.
const HINTS = {
  bread: /naan|roti|paratha|kulcha|bread/i,
  drink: /lassi|soda|chai|coffee|juice|drink|beverage|lime|shake|mocktail/i,
  starter: /tikka|65|manchurian|kebab|kabab|roll|pakora|starter/i,
  curry: /masala|dal|curry|kadai|makhani|korma|main course/i,
  rice: /rice|pulao|biryani/i,
  biryani: /biryani/i,
  chicken: /chicken/i,
  mutton: /mutton|lamb|gosht/i,
  dessert: /jamun|meetha|rasmalai|kulfi|halwa|kheer|ice cream|dessert|sweet/i,
  chai: /chai|coffee|tea\b|lassi/i,
};

const PICK = {
  bread: ["Butter Naan", "Garlic Naan", "Tandoori Roti"],
  drink: ["Sweet Lassi", "Fresh Lime Soda", "Masala Chai", "Soft Drink (300 ml)"],
  starter: ["Paneer Tikka", "Chicken 65", "Gobi Manchurian", "Veg Spring Roll"],
  curry: ["Paneer Butter Masala", "Dal Tadka", "Kadai Paneer", "Dal Makhani"],
  rice: ["Jeera Rice", "Veg Biryani", "Veg Dum Biryani"],
  biryani: ["Chicken Dum Biryani", "Chicken Biryani", "Veg Biryani"],
  chicken: ["Butter Chicken", "Chicken Curry", "Chilli Chicken"],
  mutton: ["Mutton Rogan Josh", "Mutton Biryani", "Chicken Curry"],
  dessert: ["Gulab Jamun (2 pc)", "Gulab Jamun", "Double Ka Meetha", "Rasmalai"],
  chai: ["Masala Chai", "Filter Coffee", "Sweet Lassi"],
};

const minutesAgo = (minutes) => `NOW() - INTERVAL '${Number(minutes) * 60} seconds'`;

const loadMenu = async (restaurantId) => {
  const products = await pool.query(
    `SELECT p.id, p.name, c.name AS category_name
     FROM products p
     JOIN categories c ON c.id = p.category_id AND c.status = 'active'
     WHERE p.restaurant_id = $1 AND p.status = 'active' AND p.is_available
     ORDER BY p.id`,
    [restaurantId]
  );
  const variants = await pool.query(
    `SELECT id, product_id, is_default, sort_order FROM product_variants
     WHERE restaurant_id = $1 AND status = 'active'
     ORDER BY product_id, is_default DESC, sort_order, id`,
    [restaurantId]
  );

  const byName = new Map(products.rows.map((row) => [row.name.toLowerCase(), row]));
  // A dish with sizes needs one chosen: its default, or the first.
  const sizeOf = new Map();

  for (const row of variants.rows) {
    if (!sizeOf.has(row.product_id)) {
      sizeOf.set(row.product_id, row.id);
    }
  }

  // How many times each kind has been picked, so repeats cycle through the
  // kind's dishes instead of always landing on the first.
  const picks = new Map();

  const pick = (kind) => {
    const named = PICK[kind].map((name) => byName.get(name.toLowerCase())).filter(Boolean);
    const candidates =
      named.length > 0
        ? named
        : products.rows.filter((row) => HINTS[kind].test(`${row.name} ${row.category_name}`));

    if (candidates.length === 0) {
      return null;
    }

    const turn = picks.get(kind) || 0;
    picks.set(kind, turn + 1);

    return candidates[turn % candidates.length];
  };

  const line = (kind, quantity, notes) => {
    const row = pick(kind);

    return row
      ? {
          productId: row.id,
          variantId: sizeOf.get(row.id) || null,
          modifierIds: [],
          quantity,
          notes: notes || null,
        }
      : null;
  };

  return { line, count: products.rows.length };
};

// Tables with a running order to add to, and free tables to open.
const loadTables = async (restaurantId) => {
  const result = await pool.query(
    `SELECT t.id, t.table_no, t.qr_token, t.table_status, live.id AS live_order_id
     FROM dining_tables t
     JOIN floors f ON f.id = t.floor_id AND f.status = 'active'
     LEFT JOIN LATERAL (
       SELECT o.id FROM orders o
       WHERE o.table_id = t.id AND o.restaurant_id = t.restaurant_id AND o.order_status = 'open'
       ORDER BY o.placed_at DESC LIMIT 1
     ) live ON TRUE
     WHERE t.restaurant_id = $1 AND t.status = 'active'
     ORDER BY f.sort_order, t.table_no`,
    [restaurantId]
  );

  return {
    eating: result.rows.filter((row) => row.live_order_id),
    free: result.rows.filter((row) => !row.live_order_id && row.table_status === "available"),
    all: result.rows,
  };
};

// The person answering: a captain with a real name if there is one, else a
// manager, else the admin. Test databases fill up with "Captain 123456".
const loadStaff = async (restaurantId) => {
  const result = await pool.query(
    `SELECT u.id, u.name, r.code
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.restaurant_id = $1 AND u.status = 'active'
       AND r.code IN ('CAPTAIN', 'MANAGER', 'RESTAURANT_ADMIN')
     ORDER BY (u.name ~ '[0-9]{4,}'), CASE r.code WHEN 'CAPTAIN' THEN 0 WHEN 'MANAGER' THEN 1 ELSE 2 END, u.id`,
    [restaurantId]
  );

  const captain = result.rows.find((row) => row.code === "CAPTAIN") || result.rows[0];
  const manager =
    result.rows.find((row) => row.code === "MANAGER") ||
    result.rows.find((row) => row.code === "RESTAURANT_ADMIN") ||
    captain;

  return { captain, manager };
};

const existing = async (restaurantId, clientKey) => {
  const result = await pool.query(
    "SELECT id FROM table_requests WHERE restaurant_id = $1 AND client_key = $2",
    [restaurantId, clientKey]
  );

  return result.rows[0] ? result.rows[0].id : null;
};

// Winds a request's clock back: made `created` minutes ago, first answered
// `answeredAfter` seconds later, finished `doneAfter` seconds after it was made.
const backdate = async (id, { created, answeredAfter = null, doneAfter = null, repeat = 0 }) => {
  await pool.query(
    `UPDATE table_requests
     SET created_at = ${minutesAgo(created)},
         last_asked_at = ${minutesAgo(created)} + make_interval(secs => $2),
         repeat_count = $3,
         acknowledged_at = CASE WHEN acknowledged_at IS NOT NULL AND $4::int IS NOT NULL
                                THEN ${minutesAgo(created)} + make_interval(secs => $4::int)
                                ELSE acknowledged_at END,
         resolved_at = CASE WHEN resolved_at IS NOT NULL AND $5::int IS NOT NULL
                            THEN ${minutesAgo(created)} + make_interval(secs => $5::int)
                            ELSE resolved_at END
     WHERE id = $1`,
    [id, repeat > 0 ? Math.round(created * 30) : 0, repeat, answeredAfter, doneAfter]
  );
};

// The order a seeded acceptance made or added to, moved to the same moment,
// so the floor plan and the kitchen see a table that has been eating a while
// rather than one seated a second ago.
const backdateOrderLines = async (orderId, since, created, acceptedAfter) => {
  const at = `${minutesAgo(created)} + make_interval(secs => ${Number(acceptedAfter)})`;

  await pool.query(
    `UPDATE order_items SET created_at = ${at} WHERE order_id = $1 AND created_at >= $2`,
    [orderId, since]
  );
  await pool.query(
    `UPDATE orders SET placed_at = ${at}
     WHERE id = $1 AND source = 'qr' AND placed_at >= $2`,
    [orderId, since]
  );
};

(async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant found — nothing to seed.");
    return;
  }

  const restaurantId = restaurant.id;

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "qr_ordering")) {

    return;

  }
  say(`Seeding table requests for ${restaurant.name}`);

  const day = await businessDayRepository.findOpen(restaurantId);
  const stamp = day ? day.business_date : new Date().toLocaleDateString("en-CA");
  const keyFor = (slot) => `seed-${stamp}-${slot}`;

  // Guests must be able to order and call while seeding; a manager who has
  // switched QR ordering off keeps that choice afterwards.
  const settings = (
    await pool.query(
      `INSERT INTO table_request_settings (restaurant_id) VALUES ($1)
       ON CONFLICT (restaurant_id) DO UPDATE SET restaurant_id = EXCLUDED.restaurant_id
       RETURNING ordering_enabled, calls_enabled`,
      [restaurantId]
    )
  ).rows[0];
  await pool.query(
    "UPDATE table_request_settings SET ordering_enabled = TRUE, calls_enabled = TRUE WHERE restaurant_id = $1",
    [restaurantId]
  );

  const menu = await loadMenu(restaurantId);
  const tables = await loadTables(restaurantId);
  const staff = await loadStaff(restaurantId);

  if (tables.all.length === 0 || !staff.captain) {
    say("This restaurant needs tables and at least one captain, manager or admin — nothing seeded.");
    await pool.query(
      "UPDATE table_request_settings SET ordering_enabled = $2, calls_enabled = $3 WHERE restaurant_id = $1",
      [restaurantId, settings.ordering_enabled, settings.calls_enabled]
    );
    return;
  }

  // Tables are handed out in turn, so no two stories share a table.
  const takenTables = new Set();
  const take = (list) => {
    const table = list.find((row) => !takenTables.has(row.id)) || tables.all.find((row) => !takenTables.has(row.id));

    if (table) {
      takenTables.add(table.id);
    }

    return table;
  };

  const made = { orders: 0, calls: 0, skipped: 0 };

  const placeOrder = async (slot, table, input) => {
    const clientKey = keyFor(slot);
    const found = await existing(restaurantId, clientKey);

    if (found) {
      made.skipped += 1;
      return { id: found, fresh: false };
    }

    const items = input.items.filter(Boolean);

    if (!table || items.length === 0) {
      return null;
    }

    const { request } = await tableRequestService.placeOrder(table.qr_token, {
      clientKey,
      items,
      notes: input.notes || null,
      guestName: input.guestName || null,
      guestMobile: input.guestMobile || null,
    });

    made.orders += 1;
    return { id: request.id, fresh: true };
  };

  const placeCall = async (slot, table, type, message) => {
    const clientKey = keyFor(slot);
    const found = await existing(restaurantId, clientKey);

    if (found) {
      made.skipped += 1;
      return { id: found, fresh: false };
    }

    if (!table) {
      return null;
    }

    const { request } = await tableRequestService.callStaff(table.qr_token, {
      type,
      clientKey,
      message: message || null,
    });

    made.calls += 1;
    return { id: request.id, fresh: true };
  };

  // ------------------------------------------------------------ earlier today

  if (day) {
    // A table already eating adds bread and a drink from their phones.
    const addTable = take(tables.eating);
    const added = await placeOrder("added", addTable, {
      items: [menu.line("bread", 2), menu.line("drink", 1)],
      notes: "Please bring them with the mains",
    });

    if (added && added.fresh) {
      const since = new Date();
      const result = await tableRequestService.accept(restaurantId, added.id, staff.captain.id, null);
      await backdate(added.id, { created: 68, doneAfter: 95 });
      await backdateOrderLines(result.order.id, since, 68, 95);
    }

    // A family sits down and orders everything from the QR code.
    const openTable = take(tables.free);
    const opened = await placeOrder("opened", openTable, {
      items: [
        menu.line("starter", 1),
        menu.line("curry", 1),
        menu.line("rice", 1),
        menu.line("bread", 3),
      ],
      guestName: "Rohan Gupta",
      guestMobile: "9820011208",
      notes: "Two kids with us — medium spicy please",
    });

    if (opened && opened.fresh) {
      const since = new Date();
      const result = await tableRequestService.accept(restaurantId, opened.id, staff.captain.id, null);
      await backdate(opened.id, { created: 44, doneAfter: 70 });
      await backdateOrderLines(result.order.id, since, 44, 70);
    }

    // The mutton ran out before the kitchen could say so on the menu.
    const turnedDown = await placeOrder("rejected", take(tables.eating), {
      items: [menu.line("mutton", 2), menu.line("bread", 2)],
    });

    if (turnedDown && turnedDown.fresh) {
      await tableRequestService.reject(
        restaurantId,
        turnedDown.id,
        "Sorry — the mutton is finished for tonight. Your waiter will suggest something just as good.",
        staff.manager.id
      );
      await backdate(turnedDown.id, { created: 31, doneAfter: 130 });
    }
  } else {
    say("No business day is open, so no QR orders were seeded — open the day and run this again.");
  }

  // Calls answered through the evening.
  const answered = [
    ["water-done", "water", null, 52, 40, 150],
    ["waiter-done", "call_waiter", null, 36, 25, 180],
    ["chair-done", "other", "Could we get a high chair for our daughter?", 27, 30, 120],
    ["bill-done", "bill", null, 18, 60, 240],
  ];

  for (const [slot, type, message, created, ackAfter, doneAfter] of answered) {
    const callMade = await placeCall(slot, take(tables.eating.length > 3 ? tables.eating : tables.all), type, message);

    if (callMade && callMade.fresh) {
      await tableRequestService.acknowledge(restaurantId, callMade.id, staff.captain.id);
      await tableRequestService.markDone(restaurantId, callMade.id, staff.captain.id);
      await backdate(callMade.id, { created, answeredAfter: ackAfter, doneAfter });
    }
  }

  // ------------------------------------------------------------ right now

  if (day) {
    // Waiting for a yes: dessert for a table already eating...
    const dessert = await placeOrder("waiting-dessert", take(tables.eating), {
      items: [menu.line("dessert", 2), menu.line("chai", 2, "Less sugar in one")],
      notes: "Dessert for the kids",
    });

    if (dessert && dessert.fresh) {
      await backdate(dessert.id, { created: 1.6 });
    }

    // ...and a new table that has been waiting long enough to ring the bell.
    const waiting = await placeOrder("waiting-new", take(tables.free), {
      items: [
        menu.line("biryani", 1, "Extra salan on the side"),
        menu.line("chicken", 1),
        menu.line("bread", 4),
        menu.line("drink", 2),
      ],
      guestName: "Meera Pillai",
      guestMobile: "9820011209",
      notes: "Please send the naan hot — we'll share everything",
    });

    if (waiting && waiting.fresh) {
      await backdate(waiting.id, { created: 3.5 });
    }
  }

  const billWanted = await placeCall("waiting-bill", take(tables.eating), "bill");
  if (billWanted && billWanted.fresh) {
    await backdate(billWanted.id, { created: 4.2 });
  }

  const water = await placeCall("waiting-water", take(tables.eating.length > 0 ? tables.eating : tables.all), "water");
  if (water && water.fresh) {
    // Asked, then asked again.
    await backdate(water.id, { created: 1.2, repeat: 1 });
  }

  const onTheWay = await placeCall("waiting-waiter", take(tables.all), "call_waiter");
  if (onTheWay && onTheWay.fresh) {
    await tableRequestService.acknowledge(restaurantId, onTheWay.id, staff.captain.id);
    await backdate(onTheWay.id, { created: 2.4, answeredAfter: 35 });
  }

  // Leave QR ordering exactly as the manager had it.
  await pool.query(
    "UPDATE table_request_settings SET ordering_enabled = $2, calls_enabled = $3 WHERE restaurant_id = $1",
    [restaurantId, settings.ordering_enabled, settings.calls_enabled]
  );

  say(
    `Done: ${made.orders} QR orders and ${made.calls} calls added` +
      (made.skipped ? `, ${made.skipped} already there and left as they were` : "") +
      "."
  );
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
