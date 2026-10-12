#!/usr/bin/env node
//
// The restaurant's own online ordering page (SW-A-22) in use: the main
// counter's link switched on (delivery within 6 km, ₹199 minimum), the
// Website channel charging ₹40 for delivery, free above ₹499, and today's
// online orders — two waiting in the inbox (a delivery and a takeaway), one
// accepted and being cooked, one turned down because it was out of the
// delivery area.
//
//   node scripts/seed-online-ordering.js
//   DB_NAME=restaurant_management_test RESTAURANT_ID=12 node scripts/seed-online-ordering.js
//
// The first restaurant unless RESTAURANT_ID says otherwise. Safe to run
// again: a link or a channel someone has already set up is left as it is,
// and every order carries a key built from the business date and its slot —
// a slot whose order exists is left exactly as it is, accepted or not. Never
// deletes anything. Orders go through the real paths (the guest's checks and
// pricing, acceptance through the order service); only the clock is wound
// back, so the inbox reads like an evening rather than one second.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const onlineOrderService = require("../src/modules/restaurant/online/services/onlineOrder.service");
const onlineOrderRepository = require("../src/modules/restaurant/online/repositories/onlineOrder.repository");
const salesChannelRepository = require("../src/modules/restaurant/deliveries/repositories/salesChannel.repository");
const tableRequestService = require("../src/modules/restaurant/orders/services/tableRequest.service");
const businessDayRepository = require("../src/modules/restaurant/business-day/repositories/businessDay.repository");

const say = (message) => console.log(message);

// Dishes by kind, the first the menu has (active, available, no sizes to pick).
const KINDS = {
  biryani: /biryani/i,
  bread: /naan|roti|paratha|kulcha/i,
  curry: /paneer|butter chicken|dal|masala|curry|kadai/i,
  starter: /tikka|65|kebab|manchurian|pakora/i,
  dessert: /jamun|meetha|rasmalai|kulfi|halwa|kheer/i,
  drink: /lassi|soda|chai|coffee|juice/i,
};

const SLOTS = [
  {
    slot: "delivery-waiting",
    minutesAgo: 3,
    service: "delivery",
    guestName: "Rahul Verma",
    guestMobile: "9849012345",
    address: "Flat 302, Sai Krupa Residency, Road No. 10, Banjara Hills",
    landmark: "Behind the Apollo pharmacy",
    notes: "Please ring the bell twice",
    dishes: [["biryani", 2], ["bread", 2], ["dessert", 1]],
  },
  {
    slot: "takeaway-waiting",
    minutesAgo: 1,
    service: "takeaway",
    guestName: "Ananya Rao",
    guestMobile: "9908123456",
    dishes: [["starter", 1], ["curry", 1], ["bread", 3]],
  },
  {
    slot: "delivery-accepted",
    minutesAgo: 22,
    service: "delivery",
    guestName: "Mohammed Irfan",
    guestMobile: "9703456789",
    address: "H.No. 8-2-293, Film Nagar, Jubilee Hills",
    landmark: "Opposite the Film Nagar club gate",
    dishes: [["curry", 2], ["bread", 4], ["drink", 2]],
    accept: true,
  },
  {
    slot: "delivery-declined",
    minutesAgo: 35,
    service: "delivery",
    guestName: "Sneha Kulkarni",
    guestMobile: "9866554433",
    address: "Tower 4, My Home Avatar, Narsingi",
    dishes: [["biryani", 1], ["drink", 1]],
    reject: "Sorry — Narsingi is outside our delivery area tonight. Do try takeaway!",
  },
];

const run = async () => {
  const restaurant = (
    await pool.query(
      process.env.RESTAURANT_ID
        ? "SELECT id, name FROM restaurants WHERE id = $1"
        : "SELECT id, name FROM restaurants ORDER BY id LIMIT 1",
      process.env.RESTAURANT_ID ? [Number(process.env.RESTAURANT_ID)] : []
    )
  ).rows[0];

  if (!restaurant) {
    say("No restaurant to seed.");
    return;
  }

  const restaurantId = restaurant.id;

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "online_ordering")) {

    return;

  }
  say(`Online ordering for ${restaurant.name} (${restaurantId})`);

  await salesChannelRepository.ensureDefaults(restaurantId);
  await onlineOrderRepository.ensureLinks(restaurantId);

  const channel = await onlineOrderRepository.findWebsiteChannel(restaurantId);

  if (!channel) {
    say("  The Website channel is switched off; nothing more to do.");
    return;
  }

  // ₹40 a trip, free above ₹499 — only if nobody has set a charge yet.
  const charged = await pool.query(
    `UPDATE sales_channels SET delivery_charge = 40, delivery_free_above = 499
     WHERE id = $1 AND delivery_charge = 0 AND delivery_free_above IS NULL
     RETURNING id`,
    [channel.id]
  );
  say(charged.rowCount ? "  Website channel: ₹40 delivery, free above ₹499" : "  Website channel already has its charge");

  // The main counter's link, unless someone has already set it up.
  const opened = await pool.query(
    `UPDATE online_ordering_links
     SET is_enabled = TRUE, min_delivery_order = 199, delivery_area = 'Within 6 km of the restaurant',
         guest_note = 'Freshly made to order — biryani is packed in sealed handi boxes.'
     WHERE restaurant_id = $1 AND outlet_id IS NULL AND updated_by IS NULL AND NOT is_enabled
     RETURNING token`,
    [restaurantId]
  );
  const link = (
    await pool.query("SELECT * FROM online_ordering_links WHERE restaurant_id = $1 AND outlet_id IS NULL", [
      restaurantId,
    ])
  ).rows[0];
  say(opened.rowCount ? `  Main counter link switched on: /online/${link.token}` : `  Main counter link: /online/${link.token}`);

  if (!link.is_enabled) {
    say("  The main counter's link is switched off (by a manager); no orders are added.");
    return;
  }

  const day = await businessDayRepository.findOpen(restaurantId, null);

  if (!day) {
    say("  The main counter's business day is not open; no orders are added.");
    return;
  }

  const owner = (
    await pool.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id AND r.code IN ('RESTAURANT_ADMIN', 'MANAGER')
       WHERE u.restaurant_id = $1 AND u.status = 'active'
       ORDER BY r.code = 'RESTAURANT_ADMIN' DESC, u.id LIMIT 1`,
      [restaurantId]
    )
  ).rows[0];

  const products = (
    await pool.query(
      `SELECT p.id, p.name FROM products p
       JOIN categories c ON c.id = p.category_id AND c.status = 'active'
       WHERE p.restaurant_id = $1 AND p.status = 'active' AND p.is_available
         AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active')
       ORDER BY p.id`,
      [restaurantId]
    )
  ).rows;
  const dishFor = (kind) => products.find((product) => KINDS[kind].test(product.name));
  const date = String(day.business_date).slice(0, 10);

  for (const slot of SLOTS) {
    const items = slot.dishes
      .map(([kind, quantity]) => {
        const dish = dishFor(kind);
        return dish ? { productId: dish.id, variantId: null, modifierIds: [], quantity, notes: null } : null;
      })
      .filter(Boolean);

    if (items.length === 0) {
      say(`  ${slot.slot}: the menu has none of its dishes, left out`);
      continue;
    }

    const clientKey = `seed-online-${date}-${slot.slot}`;

    try {
      const placed = await onlineOrderService.placeOrder(link.token, {
        clientKey,
        service: slot.service,
        paymentMode: slot.service === "delivery" ? "cash_on_delivery" : "pay_at_pickup",
        items,
        notes: slot.notes || null,
        guestName: slot.guestName,
        guestMobile: slot.guestMobile,
        address: slot.address || null,
        landmark: slot.landmark || null,
      });

      if (placed.duplicate) {
        say(`  ${slot.slot}: already there`);
        continue;
      }

      const request = (
        await pool.query("SELECT id FROM table_requests WHERE guest_token = $1", [placed.guestToken])
      ).rows[0];

      if (slot.accept && owner) {
        await tableRequestService.accept(restaurantId, request.id, owner.id, null);
      }

      if (slot.reject && owner) {
        await tableRequestService.reject(restaurantId, request.id, slot.reject, owner.id, null);
      }

      // Back to when it "arrived" — never before the day opened, or the inbox
      // would file it under an earlier day — answered a minute and a half on.
      await pool.query(
        `UPDATE table_requests r
         SET created_at = t.at, last_asked_at = t.at,
             resolved_at = CASE WHEN r.resolved_at IS NULL THEN NULL
                                ELSE GREATEST(t.at, LEAST(NOW(), t.at + INTERVAL '90 seconds')) END
         FROM (SELECT LEAST(NOW(), GREATEST(NOW() - make_interval(mins => $2),
                                            $3::timestamptz + INTERVAL '5 seconds')) AS at) t
         WHERE r.id = $1`,
        [request.id, slot.minutesAgo, day.opened_at]
      );

      say(`  ${slot.slot}: ${slot.guestName}, ${items.length} dishes${slot.accept ? ", accepted" : slot.reject ? ", declined" : ", waiting"}`);
    } catch (error) {
      say(`  ${slot.slot}: not added — ${error.message}`);
    }
  }
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
