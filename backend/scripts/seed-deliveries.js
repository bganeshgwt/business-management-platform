#!/usr/bin/env node
//
// Sets up deliveries for the demo restaurant:
//
//   1. Channels — Own delivery, Swiggy (22%), Zomato (25%), Phone and Website,
//      where the restaurant has none yet.
//   2. Riders — four people in the delivery department, if the restaurant has
//      fewer than three.
//   3. History — every delivery order not yet on a channel is tagged with one,
//      with a Hyderabad address, the aggregator's order id, the rider who took
//      it and believable preparing / ready / out / delivered times, so the
//      channel report and the rider figures have something true to say.
//   4. Yesterday's rush put to bed — a delivery still "in play" more than two
//      hours after it was placed is not a live order any more, it is a seed
//      (or a test) nobody finished. Each one is landed as delivered with
//      believable times, so a board seeded this morning is not a wall of red
//      "out 328 min" by the evening. Only the delivery columns and the
//      kitchen's served mark change; bills are left to the cashier.
//   5. A busy board — when the open day has few fresh deliveries in play, a
//      lunch rush is placed through the real order and bill services: food
//      on the road, a rider on a two-drop run, one out far too long, a Zomato
//      order packed and waiting for its rider, a phone order with no
//      address, new orders just in, and the morning's deliveries already done.
//
//   node scripts/seed-deliveries.js
//
// Safe to run again, and meant to be run again right before a demo: channels
// and riders are only added where missing, history only touches orders that
// have no channel yet, stale deliveries are finished rather than removed, and
// a fresh rush is only placed when the board is quiet. It never deletes
// anything.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");
const kitchenRepository = require("../src/modules/restaurant/kitchen/repositories/kitchen.repository");
const salesChannelRepository = require("../src/modules/restaurant/deliveries/repositories/salesChannel.repository");
const { effectiveStatusSql } = require("../src/modules/restaurant/deliveries/repositories/delivery.repository");

// A delivery placed longer ago than this and still not at the door is stale.
const STALE_AFTER = "2 hours";

const say = (message) => console.log(message);

const RIDERS = [
  { code: "RDR-01", name: "Ravi Teja", mobile: "98480 11223", type: "full_time", salaryType: "monthly", salary: 16000, joined: "2025-03-10" },
  { code: "RDR-02", name: "Mohammed Irfan", mobile: "97010 44871", type: "full_time", salaryType: "monthly", salary: 15500, joined: "2025-07-01" },
  { code: "RDR-03", name: "Suresh Babu", mobile: "90009 23145", type: "part_time", salaryType: "monthly", salary: 11000, joined: "2026-01-18" },
  { code: "RDR-04", name: "Anil Kumar", mobile: "99633 50719", type: "contract", salaryType: "daily", salary: 650, joined: "2026-06-05" },
];

// Real neighbourhoods a Hyderabad kitchen delivers to, each with the landmark
// a rider actually asks for.
const ADDRESSES = [
  ["Flat 302, Sai Residency, Road No. 12, Banjara Hills", "Opp. Care Hospital"],
  ["8-2-293/82, Jubilee Hills Checkpost", "Near Peddamma Temple"],
  ["Plot 45, Kavuri Hills Phase 2, Madhapur", "Behind the Neeru's showroom"],
  ["C-704, My Home Avatar, Narsingi", "Gate 2, tell security"],
  ["12-5-149, Vijayapuri Colony, Tarnaka", "Near Tarnaka metro pillar 1102"],
  ["Flat 11B, Aparna Sarovar, Nallagandla", "Tower 4, lift lobby"],
  ["1-8-702, 2nd floor, Nallakunta", "Opp. Shankar Mutt"],
  ["Villa 27, Lanco Hills, Manikonda", "Club house lane"],
  ["House 16, Street 3, Ameerpet", "Behind the Big Bazaar"],
  ["Flat 504, Vertex Prime, KPHB Phase 6", "Near JNTU metro"],
  ["Tower 2, 9th floor, DLF Cyber City, Gachibowli", "Reception — call on arrival"],
  ["6-3-1090, Raj Bhavan Road, Somajiguda", "Next to Yashoda Hospital"],
  ["Flat 203, Lakshmi Towers, Kondapur", "Above the Ratnadeep store"],
  ["3-6-369, Himayatnagar Main Road", "Near the Tanishq showroom"],
  ["Plot 88, Jayabheri Enclave, Gachibowli", "Last house on the right"],
  ["Flat 9, Sri Sai Apartments, Begumpet", "Behind Lifestyle building"],
];

const CUSTOMERS = [
  ["Aditya Varma", "98491 22314"],
  ["Sneha Reddy", "90300 41822"],
  ["Karthik Rao", "99595 10273"],
  ["Pooja Sharma", "97044 88216"],
  ["Imran Khan", "98666 30491"],
  ["Divya Nair", "91000 57723"],
  ["Rohit Agarwal", "98853 64410"],
  ["Harika Chowdary", "94409 21876"],
  ["Vikram Singh", "99490 33152"],
  ["Ananya Iyer", "96760 18845"],
  ["Farhan Ali", "98480 72290"],
  ["Meghana Rao", "90140 66301"],
  ["Sai Kiran", "93910 44120"],
  ["Lavanya Prasad", "98497 51036"],
  ["Arjun Mehta", "99122 80547"],
  ["Nikhil Jain", "97055 12683"],
];

const PARTNER_RIDERS = ["Venkatesh", "Praveen", "Shiva", "Naresh", "Rajesh", "Kalyan", "Mahesh", "Srikanth"];

const CANCEL_REASONS = [
  "Guest cancelled on the app",
  "Partner could not find a rider",
  "Guest unreachable — address not found",
];

// Deterministic, so running this twice (or on two machines) tags the same
// order the same way.
const hash = (id, salt = 0) => {
  let value = (Number(id) * 2654435761 + salt * 40503) % 4294967296;
  value = (value ^ (value >>> 13)) * 1274126177;
  return Math.abs(value % 1000003);
};

const pick = (list, id, salt) => list[hash(id, salt) % list.length];
const addMinutes = (date, minutes) => new Date(new Date(date).getTime() + minutes * 60000);
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000);

const swiggyRef = (id) => String(171000000000 + ((Number(id) * 104729) % 899999999));
const zomatoRef = (id) => String(5700000000 + ((Number(id) * 7907) % 399999999));

const main = async () => {
  const restaurant = await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1");

  if (restaurant.rows.length === 0) {
    say("No restaurant found. Run scripts/seed-demo.js first.");
    return;
  }

  const restaurantId = Number(restaurant.rows[0].id);

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "deliveries")) {

    return;

  }
  const user = await pool.query(
    "SELECT id FROM users WHERE restaurant_id = $1 ORDER BY id LIMIT 1",
    [restaurantId]
  );
  const userId = user.rows[0] ? Number(user.rows[0].id) : null;

  say(`Deliveries for ${restaurant.rows[0].name}`);

  // ---------------------------------------------------------------- channels
  await salesChannelRepository.ensureDefaults(restaurantId);

  const channels = (
    await pool.query(
      `SELECT id, name, channel_type, commission_percent, status FROM sales_channels
       WHERE restaurant_id = $1`,
      [restaurantId]
    )
  ).rows;

  const byType = (type) => channels.filter((row) => row.channel_type === type && row.status === "active");
  const named = (name) =>
    channels.find((row) => row.name.toLowerCase() === name.toLowerCase() && row.status === "active") || null;

  const own = named("Own delivery") || byType("own")[0] || null;
  const swiggy = named("Swiggy") || byType("aggregator")[0] || null;
  const zomato = named("Zomato") || byType("aggregator")[1] || swiggy;
  const phone = named("Phone") || byType("phone")[0] || own;
  const website = named("Website") || byType("website")[0] || own;

  say(`  channels · ${channels.map((row) => `${row.name} ${Number(row.commission_percent)}%`).join(", ")}`);

  if (!own || !swiggy) {
    say("  the own-delivery or aggregator channel is switched off — leaving orders untagged");
    return;
  }

  // ---------------------------------------------------------------- riders
  const activeRiders = await pool.query(
    `SELECT COUNT(*)::int AS count FROM employees
     WHERE restaurant_id = $1 AND department = 'delivery' AND status = 'active'`,
    [restaurantId]
  );

  let addedRiders = 0;

  if (activeRiders.rows[0].count < 3) {
    for (const rider of RIDERS) {
      const inserted = await pool.query(
        `INSERT INTO employees (restaurant_id, employee_code, name, mobile, designation, department,
                                employment_type, salary_type, salary_amount, date_of_joining,
                                created_by, updated_by)
         SELECT $1, $2::varchar, $3, $4, 'Delivery rider', 'delivery', $5, $6, $7, $8::date, $9, $9
         WHERE NOT EXISTS (
           SELECT 1 FROM employees
           WHERE restaurant_id = $1 AND UPPER(employee_code) = UPPER($2::varchar)
         )
         RETURNING id`,
        [
          restaurantId,
          rider.code,
          rider.name,
          rider.mobile,
          rider.type,
          rider.salaryType,
          rider.salary,
          rider.joined,
          userId,
        ]
      );

      addedRiders += inserted.rowCount;
    }
  }

  const riders = (
    await pool.query(
      `SELECT id, name FROM employees
       WHERE restaurant_id = $1 AND department = 'delivery' AND status = 'active'
       ORDER BY employee_code NULLS LAST, id`,
      [restaurantId]
    )
  ).rows.map((row) => ({ id: Number(row.id), name: row.name }));

  say(`  riders · ${riders.map((row) => row.name).join(", ")}${addedRiders ? ` (${addedRiders} added)` : ""}`);

  if (riders.length === 0) {
    say("  no active delivery riders — cannot tag history or fill the board");
    return;
  }

  const riderNamed = (first) => riders.find((row) => row.name.startsWith(first)) || riders[0];

  // ---------------------------------------------------------------- history
  // Orders that nobody has tagged yet. Anything still cooking on the kitchen
  // display is left to finish its own way; it only gets a channel and an
  // address.
  const untagged = (
    await pool.query(
      `SELECT o.id, o.order_number, o.source, o.order_status, o.placed_at, o.customer_name,
              o.customer_mobile, o.delivery_status, o.delivered_at, o.cancel_reason,
              EXISTS (SELECT 1 FROM kots k WHERE k.order_id = o.id
                      AND k.kot_status IN ('new', 'cooking', 'ready')) AS in_kitchen
       FROM orders o
       WHERE o.restaurant_id = $1 AND o.order_type = 'delivery' AND o.channel_id IS NULL
       ORDER BY o.id`,
      [restaurantId]
    )
  ).rows;

  const channelFor = (row) => {
    if (row.source === "phone") return phone;
    if (row.source === "website") return website;
    if (row.source === "partner") return hash(row.id, 1) % 2 === 0 ? swiggy : zomato;

    const roll = hash(row.id, 2) % 100;

    if (roll < 34) return swiggy;
    if (roll < 62) return zomato;
    if (roll < 82) return own;
    if (roll < 94) return phone;
    return website;
  };

  let tagged = 0;
  let settled = 0;

  for (const row of untagged) {
    const channel = channelFor(row);
    const aggregator = channel.channel_type === "aggregator";
    const [address, landmark] = pick(ADDRESSES, row.id, 3);
    const [customerName, customerMobile] = pick(CUSTOMERS, row.id, 4);
    const age = (Date.now() - new Date(row.placed_at).getTime()) / 60000;
    const h = hash(row.id, 5);

    const fields = {
      channel_id: channel.id,
      channel_commission_percent: channel.commission_percent,
      delivery_address: address,
      delivery_landmark: landmark,
      external_order_ref: aggregator ? (channel === zomato ? zomatoRef(row.id) : swiggyRef(row.id)) : null,
      delivery_eta_minutes: aggregator ? 35 + (h % 3) * 5 : channel === phone ? 45 : 40,
      customer_name: row.customer_name || customerName,
      customer_mobile: row.customer_mobile || customerMobile,
    };

    if (row.order_status === "cancelled" || row.delivery_status === "cancelled") {
      fields.delivery_status = "cancelled";
      fields.delivery_cancelled_at = addMinutes(row.placed_at, 6 + (h % 10));
      fields.delivery_cancel_reason = row.cancel_reason || pick(CANCEL_REASONS, row.id, 6);
    } else if (
      !row.in_kitchen &&
      // Untouched for over an hour, or marked delivered by the migration
      // with no times. Anything a dispatcher has moved is left as it is.
      ((!row.delivery_status && age > 60) || (row.delivery_status === "delivered" && !row.delivered_at))
    ) {
      // A run that happened: accepted in a minute or two, packed in 14-22,
      // out a few minutes later, and at the door 10-30 minutes after that.
      // One in ten had a bad day on the road.
      const preparing = addMinutes(row.placed_at, 1 + (h % 3));
      const ready = addMinutes(row.placed_at, 14 + (h % 9));
      const out = addMinutes(ready, 2 + (h % 5));
      let delivered = addMinutes(out, 10 + ((h >> 3) % 20) + (h % 10 === 0 ? 18 : 0));

      if (delivered > minutesAgo(1)) {
        delivered = minutesAgo(1);
      }

      const partner = aggregator && hash(row.id, 7) % 5 !== 0;

      Object.assign(fields, {
        delivery_status: "delivered",
        delivery_preparing_at: preparing,
        delivery_ready_at: ready,
        dispatched_at: out,
        delivered_at: delivered,
        rider_employee_id: partner ? null : pick(riders, row.id, 8).id,
        partner_rider_name: partner ? pick(PARTNER_RIDERS, row.id, 9) : null,
      });
      settled += 1;
    }

    const columns = Object.keys(fields);

    await pool.query(
      `UPDATE orders SET ${columns.map((column, index) => `${column} = $${index + 3}`).join(", ")}
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, row.id, ...columns.map((column) => fields[column])]
    );

    tagged += 1;
  }

  say(`  history · ${tagged} delivery orders tagged, ${settled} given a full delivery record`);

  // ---------------------------------------------------------------- stale deliveries
  // Each step keeps whatever time it already has and only fills the gaps,
  // always after the step before it, so the record reads in order: placed,
  // cooking, packed, out, at the door.
  const stale = (
    await pool.query(
      `SELECT o.id, o.order_number, o.placed_at, o.kitchen_status, o.delivery_address,
              o.delivery_preparing_at, o.delivery_ready_at, o.dispatched_at,
              o.rider_employee_id, o.partner_rider_name, ch.channel_type,
              ${effectiveStatusSql("o")} AS status
       FROM orders o
       JOIN sales_channels ch ON ch.id = o.channel_id
       WHERE o.restaurant_id = $1 AND o.order_type = 'delivery'
         AND o.order_status <> 'cancelled'
         AND COALESCE(o.delivery_status, 'pending') NOT IN ('delivered', 'cancelled')
         AND o.placed_at < NOW() - $2::interval
         -- A late order that left recently is on the road, not stale.
         AND COALESCE(o.dispatched_at, o.placed_at) < NOW() - INTERVAL '90 minutes'
       ORDER BY o.id`,
      [restaurantId, STALE_AFTER]
    )
  ).rows.filter((row) => ["pending", "preparing", "ready", "out_for_delivery"].includes(row.status));

  const latest = (...dates) => new Date(Math.max(...dates.filter(Boolean).map((date) => new Date(date).getTime())));

  for (const row of stale) {
    const h = hash(row.id, 12);
    const preparing = row.delivery_preparing_at || addMinutes(row.placed_at, 1 + (h % 3));
    const ready = row.delivery_ready_at || latest(addMinutes(row.placed_at, 15 + (h % 7)), addMinutes(preparing, 1));
    const out = row.dispatched_at || addMinutes(ready, 2 + (h % 4));
    let delivered = addMinutes(out, 12 + ((h >> 2) % 16));

    if (delivered > minutesAgo(1)) {
      delivered = minutesAgo(1);
    }

    const fields = {
      delivery_status: "delivered",
      delivery_preparing_at: preparing,
      delivery_ready_at: ready,
      dispatched_at: out,
      delivered_at: delivered,
    };

    // Somebody carried it: the partner's rider for an aggregator order,
    // otherwise one of ours — who needed an address to go to.
    if (!row.rider_employee_id && !row.partner_rider_name) {
      if (row.channel_type === "aggregator") {
        fields.partner_rider_name = pick(PARTNER_RIDERS, row.id, 13);
      } else {
        fields.rider_employee_id = pick(riders, row.id, 14).id;
      }
    }

    if (!row.delivery_address && (fields.rider_employee_id || row.rider_employee_id)) {
      const [address, landmark] = pick(ADDRESSES, row.id, 15);
      fields.delivery_address = address;
      fields.delivery_landmark = landmark;
    }

    const columns = Object.keys(fields);

    await pool.query(
      `UPDATE orders SET ${columns.map((column, index) => `${column} = $${index + 3}`).join(", ")},
              kitchen_status = 'served'
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, row.id, ...columns.map((column) => fields[column])]
    );
  }

  if (stale.length > 0) {
    // The kitchen display lets go of their tickets, as it does for any order
    // that has left the building.
    await kitchenRepository.sync(restaurantId, { orderIds: stale.map((row) => row.id) });
  }

  say(`  stale · ${stale.length} deliveries still "in play" after ${STALE_AFTER} landed as delivered`);

  // ---------------------------------------------------------------- a busy board
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

  // Fresh ones only: the stale have just been landed above.
  const live = await pool.query(
    `SELECT COUNT(*)::int AS count FROM orders
     WHERE restaurant_id = $1 AND order_type = 'delivery' AND business_day_id = $2
       AND channel_id IS NOT NULL AND order_status <> 'cancelled'
       AND delivery_status IN ('preparing', 'ready', 'out_for_delivery')
       AND placed_at >= NOW() - $3::interval`,
    [restaurantId, day.rows[0].id, STALE_AFTER]
  );

  if (live.rows[0].count >= 5) {
    say(`  board · already ${live.rows[0].count} fresh deliveries in play — leaving service as it is`);
    return;
  }

  // Makes sure the kitchen's go-live mark exists before any demo order does.
  await kitchenRepository.findSettings(restaurantId);

  const products = new Map(
    (
      await pool.query(
        `SELECT id, name FROM products
         WHERE restaurant_id = $1 AND status = 'active' AND is_available = TRUE`,
        [restaurantId]
      )
    ).rows.map((row) => [row.name.toLowerCase(), Number(row.id)])
  );

  const lines = (wanted) =>
    wanted
      .map(([name, quantity, notes]) => ({
        productId: products.get(name.toLowerCase()),
        productVariantId: null,
        modifierIds: [],
        quantity,
        notes: notes || null,
      }))
      .filter((line) => line.productId);

  // Moves an order's kitchen tickets to where the food really is, with the
  // times it got there, so the kitchen display tells the same story.
  const kitchenTo = async (orderId, state, times) => {
    await kitchenRepository.sync(restaurantId, { orderIds: [orderId] });

    const status = { pending: "new", preparing: "cooking", ready: "ready" }[state] || "served";

    if (status !== "new") {
      await pool.query(
        `UPDATE kots SET kot_status = $2::varchar, started_at = $3,
                ready_at = CASE WHEN $2::varchar IN ('ready', 'served') THEN $4::timestamptz END,
                served_at = CASE WHEN $2::varchar = 'served' THEN $5::timestamptz END,
                started_by = $6,
                ready_by = CASE WHEN $2::varchar IN ('ready', 'served') THEN $6::bigint END,
                served_by = CASE WHEN $2::varchar = 'served' THEN $6::bigint END
         WHERE order_id = $1 AND kot_status NOT IN ('cancelled')`,
        [orderId, status, times.preparing, times.ready || null, times.out || null, userId]
      );

      if (status === "ready" || status === "served") {
        await pool.query(
          `UPDATE kot_items SET is_done = TRUE, done_at = $2, done_by = $3
           WHERE order_id = $1 AND NOT is_done`,
          [orderId, times.ready, userId]
        );
      }
    }

    await kitchenRepository.sync(restaurantId, { orderIds: [orderId] });
  };

  const SOURCE = { own: "pos", aggregator: "partner", phone: "phone", website: "website" };

  let placed = 0;

  const place = async (plan) => {
    const items = lines(plan.items);

    if (items.length === 0 || !plan.channel) {
      return;
    }

    const [customerName, customerMobile] = CUSTOMERS[plan.customer % CUSTOMERS.length];
    const [address, landmark] = ADDRESSES[plan.address % ADDRESSES.length];
    const placedAt = minutesAgo(plan.at);

    let order;

    try {
      order = await orderService.create(
        restaurantId,
        {
          orderType: "delivery",
          source: SOURCE[plan.channel.channel_type] || "pos",
          tableId: null,
          outletId: null,
          customerId: null,
          customerName,
          customerMobile,
          guestCount: null,
          notes: plan.notes || null,
          items,
        },
        userId
      );
    } catch (error) {
      say(`  skipped an order: ${error.message}`);
      return;
    }

    const id = order.id;

    await pool.query("UPDATE orders SET placed_at = $2 WHERE id = $1", [id, placedAt]);
    await pool.query("UPDATE order_items SET created_at = $2 WHERE order_id = $1", [id, placedAt]);

    const times = {
      preparing: plan.state === "pending" ? null : addMinutes(placedAt, 2),
      ready: plan.readyAgo !== undefined ? minutesAgo(plan.readyAgo) : null,
      out: plan.outAgo !== undefined ? minutesAgo(plan.outAgo) : null,
      delivered: plan.deliveredAgo !== undefined ? minutesAgo(plan.deliveredAgo) : null,
    };

    if (plan.state === "cancelled") {
      await orderService.cancel(restaurantId, id, plan.reason, userId);
    } else {
      await kitchenTo(id, plan.state, times);
    }

    // Money: aggregator and website orders are paid online before they are
    // cooked; own and phone orders are cash on delivery, billed when the rider
    // leaves and settled when he is back.
    if (plan.pay && plan.state !== "cancelled") {
      try {
        const bill = await billService.createForOrder(
          restaurantId,
          { orderId: id, discountCode: null, outletId: null, loyaltyPoints: null, items: [] },
          userId
        );
        const billedAt = plan.pay === "cod" ? times.out || placedAt : placedAt;

        await pool.query("UPDATE bills SET billed_at = $2 WHERE id = $1", [bill.id, billedAt]);

        const paidNow = plan.pay === "online" || plan.pay === "upi" || (plan.pay === "cod" && times.delivered);

        if (paidNow) {
          await billService.addPayment(
            restaurantId,
            bill.id,
            {
              paymentMethod: plan.pay === "cod" ? "cash" : plan.pay,
              amount: bill.dueAmount,
              tenderedAmount: null,
              transactionRef: plan.pay === "online" ? `PG${hash(id, 11)}` : null,
            },
            userId
          );

          const paidAt = plan.pay === "cod" ? times.delivered : addMinutes(placedAt, 1);

          await pool.query("UPDATE payments SET paid_at = $2 WHERE bill_id = $1", [bill.id, paidAt]);
          await pool.query(
            "UPDATE bills SET settled_at = $2 WHERE id = $1 AND settled_at IS NOT NULL",
            [bill.id, paidAt]
          );
        }
      } catch (error) {
        say(`  ${order.orderNumber} stays unbilled: ${error.message}`);
      }
    }

    const aggregator = plan.channel.channel_type === "aggregator";
    const fields = {
      channel_id: plan.channel.id,
      channel_commission_percent: plan.channel.commission_percent,
      delivery_status: plan.state,
      delivery_address: plan.noAddress ? null : address,
      delivery_landmark: plan.noAddress ? null : landmark,
      external_order_ref: aggregator ? (plan.channel === zomato ? zomatoRef(id) : swiggyRef(id)) : null,
      delivery_eta_minutes: plan.eta || (aggregator ? 40 : 45),
      delivery_preparing_at: times.preparing,
      delivery_ready_at: times.ready,
      dispatched_at: times.out,
      delivered_at: times.delivered,
      rider_employee_id: plan.rider ? plan.rider.id : null,
      partner_rider_name: plan.partner || null,
    };

    if (plan.state === "cancelled") {
      fields.delivery_cancelled_at = addMinutes(placedAt, 5);
      fields.delivery_cancel_reason = plan.reason;
    }

    const columns = Object.keys(fields);

    await pool.query(
      `UPDATE orders SET ${columns.map((column, index) => `${column} = $${index + 3}`).join(", ")}
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, ...columns.map((column) => fields[column])]
    );

    placed += 1;
  };

  const ravi = riderNamed("Ravi");
  const irfan = riderNamed("Mohammed");
  const suresh = riderNamed("Suresh");
  const anil = riderNamed("Anil");

  // The morning, done and dusted: six deliveries, one of them late.
  await place({ state: "delivered", channel: swiggy, at: 150, readyAgo: 132, outAgo: 128, deliveredAgo: 116, partner: "Venkatesh", pay: "online", customer: 0, address: 0, items: [["Chicken Dum Biryani", 2], ["Chicken 65", 1], ["Soft Drink (300 ml)", 2]] });
  await place({ state: "delivered", channel: own, at: 138, readyAgo: 121, outAgo: 118, deliveredAgo: 100, rider: ravi, pay: "cod", customer: 1, address: 1, items: [["Paneer Butter Masala", 1], ["Butter Naan", 4], ["Jeera Rice", 1]] });
  await place({ state: "delivered", channel: zomato, at: 124, readyAgo: 100, outAgo: 95, deliveredAgo: 72, partner: "Praveen", pay: "online", customer: 2, address: 2, items: [["Mutton Rogan Josh", 1], ["Laccha Paratha", 3], ["Sweet Lassi", 2]] });
  await place({ state: "delivered", channel: phone, at: 110, readyAgo: 94, outAgo: 91, deliveredAgo: 81, rider: irfan, pay: "cod", customer: 3, address: 3, items: [["Veg Biryani", 1], ["Gobi Manchurian", 1], ["Gulab Jamun (2 pc)", 2]] });
  await place({ state: "delivered", channel: website, at: 96, readyAgo: 79, outAgo: 76, deliveredAgo: 55, rider: suresh, pay: "online", customer: 4, address: 4, items: [["Butter Chicken", 1], ["Garlic Naan", 3], ["Dal Tadka", 1]] });
  await place({ state: "delivered", channel: zomato, at: 88, readyAgo: 72, outAgo: 69, deliveredAgo: 52, rider: ravi, pay: "online", customer: 5, address: 5, items: [["Kadai Paneer", 1], ["Tandoori Roti", 4], ["Fresh Lime Soda", 2]] });

  // Called off before it was cooked.
  await place({ state: "cancelled", channel: zomato, at: 80, reason: "Guest cancelled on Zomato — ordered twice by mistake", customer: 6, address: 6, items: [["Chilli Chicken", 1], ["Veg Biryani", 1]] });

  // On the road. Anil left 52 minutes ago with one order — he should have
  // been back long since. Ravi is on a two-drop run.
  await place({ state: "out_for_delivery", channel: own, at: 72, readyAgo: 55, outAgo: 52, rider: anil, pay: "cod", customer: 7, address: 7, eta: 45, items: [["Chicken Curry", 1], ["Jeera Rice", 1], ["Double Ka Meetha", 2]] });
  await place({ state: "out_for_delivery", channel: swiggy, at: 38, readyAgo: 19, outAgo: 16, partner: "Shiva", pay: "online", customer: 8, address: 8, items: [["Paneer Tikka", 1], ["Chicken Dum Biryani", 1], ["Soft Drink (300 ml)", 1]] });
  await place({ state: "out_for_delivery", channel: phone, at: 34, readyAgo: 14, outAgo: 12, rider: ravi, pay: "cod", customer: 9, address: 9, items: [["Butter Chicken", 1], ["Butter Naan", 3], ["Gulab Jamun (2 pc)", 1]] });
  await place({ state: "out_for_delivery", channel: own, at: 31, readyAgo: 13, outAgo: 12, rider: ravi, pay: "upi", customer: 10, address: 10, items: [["Veg Biryani", 2], ["Sweet Lassi", 2]] });

  // Packed at the pass. The Zomato bag has waited 13 minutes for their rider.
  await place({ state: "ready", channel: zomato, at: 27, readyAgo: 13, pay: "online", customer: 11, address: 11, items: [["Chicken Dum Biryani", 1], ["Chicken 65", 1]] });
  await place({ state: "ready", channel: website, at: 22, readyAgo: 4, rider: irfan, pay: "online", customer: 12, address: 12, items: [["Paneer Butter Masala", 1], ["Garlic Naan", 2], ["Fresh Lime Soda", 1]] });

  // On the stove — including a phone order taken without an address.
  await place({ state: "preparing", channel: swiggy, at: 16, pay: "online", customer: 13, address: 13, items: [["Mutton Rogan Josh", 1], ["Butter Naan", 2]] });
  await place({ state: "preparing", channel: own, at: 12, customer: 14, address: 14, notes: "Ring the bell twice, baby sleeping", items: [["Chicken Curry", 1], ["Tandoori Roti", 4], ["Dal Tadka", 1]] });
  await place({ state: "preparing", channel: phone, at: 9, noAddress: true, customer: 15, address: 15, items: [["Kadai Paneer", 1], ["Laccha Paratha", 2]] });

  // Just in.
  await place({ state: "pending", channel: zomato, at: 3, pay: "online", customer: 2, address: 13, items: [["Veg Biryani", 1], ["Gobi Manchurian", 1], ["Soft Drink (300 ml)", 2]] });
  await place({ state: "pending", channel: website, at: 1, pay: "online", customer: 6, address: 5, items: [["Chicken Dum Biryani", 2], ["Double Ka Meetha", 1]] });

  say(`  board · ${placed} delivery orders placed for today's service`);
};

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
