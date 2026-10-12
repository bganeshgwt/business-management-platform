#!/usr/bin/env node
//
// Billing and payments demo data (the billing build): the first restaurant's
// UPI ID for scan-to-pay QR codes, owner-named payment types (meal cards, a
// cheque, PhonePe), offers that use the new rules (desserts only, happy hours,
// once per guest, buy 2 get 1), and — while a business day is open — a few
// advances held for guests, as a busy restaurant would have.
//
//   DB_NAME=restaurant_management_test node scripts/seed-money.js
//
// Safe to run twice: everything is looked up first and only added when it is
// missing. It never deletes or changes another module's data.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const customerAdvanceRepository = require("../src/modules/restaurant/billing/repositories/customerAdvance.repository");
const businessDayRepository = require("../src/modules/restaurant/business-day/repositories/businessDay.repository");

const say = (message) => console.log(message);

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant yet: nothing to seed.");
    return;
  }

  const rid = restaurant.id;
  const owner = (
    await pool.query(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE u.restaurant_id = $1 AND r.code IN ('RESTAURANT_ADMIN', 'SUPER_ADMIN') ORDER BY u.id LIMIT 1`,
      [rid]
    )
  ).rows[0];
  const userId = owner ? owner.id : null;

  // The UPI ID guests pay by scanning the bill's QR code.
  const settings = (await pool.query("SELECT upi_vpa FROM restaurant_settings WHERE restaurant_id = $1", [rid])).rows[0];

  if (settings && !settings.upi_vpa) {
    await pool.query(
      "UPDATE restaurant_settings SET upi_vpa = $2, upi_payee_name = $3 WHERE restaurant_id = $1",
      [rid, "foodexrestaurant@okhdfcbank", restaurant.name]
    );
    say("UPI ID set for scan-to-pay.");
  }

  // Payment types a busy restaurant in an office area takes.
  const types = [
    ["other", "Pluxee meal card", true, 1],
    ["other", "Sodexo meal card", true, 2],
    ["other", "Cheque", true, 3],
    ["upi", "PhonePe", false, 1],
    ["card", "Amex machine", false, 1],
  ];

  for (const [method, name, needsReference, order] of types) {
    const found = await pool.query(
      "SELECT 1 FROM payment_types WHERE restaurant_id = $1 AND payment_method = $2 AND UPPER(name) = UPPER($3)",
      [rid, method, name]
    );

    if (found.rows.length === 0) {
      await pool.query(
        `INSERT INTO payment_types (restaurant_id, payment_method, name, needs_reference, sort_order, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [rid, method, name, needsReference, order, userId]
      );
      say(`Payment type ${name} added.`);
    }
  }

  // Offers that use the rules.
  const dessertCategory = (
    await pool.query(
      "SELECT id FROM categories WHERE restaurant_id = $1 AND name ILIKE ANY(ARRAY['%dessert%', '%sweet%']) ORDER BY id LIMIT 1",
      [rid]
    )
  ).rows[0];
  const pizzas = (
    await pool.query(
      "SELECT array_agg(id ORDER BY id) AS ids FROM (SELECT id FROM products WHERE restaurant_id = $1 AND status = 'active' AND name ILIKE ANY(ARRAY['%pizza%', '%kulfi%', '%lassi%']) ORDER BY id LIMIT 6) p",
      [rid]
    )
  ).rows[0];
  const offers = [
    {
      code: "SWEET20",
      name: "20% off desserts",
      type: "percentage",
      value: 20,
      rules: { category_ids: dessertCategory ? [dessertCategory.id] : null },
      skip: !dessertCategory,
    },
    {
      code: "HAPPYHR",
      name: "Happy hours, Mon–Thu 4–7 pm",
      type: "percentage",
      value: 15,
      rules: { weekdays: [1, 2, 3, 4], time_from: "16:00", time_to: "19:00" },
    },
    { code: "WELCOME100", name: "Welcome offer, once per guest", type: "amount", value: 100, rules: { once_per_guest: true }, minOrder: 499 },
    {
      code: "B2G1",
      name: "Buy 2, get 1 free",
      type: "percentage",
      value: 100,
      rules: { offer_type: "buy_get", buy_quantity: 2, get_quantity: 1, get_discount_percent: 100, product_ids: pizzas && pizzas.ids },
      skip: !(pizzas && pizzas.ids && pizzas.ids.length),
    },
  ];

  for (const offer of offers) {
    if (offer.skip) {
      continue;
    }

    const found = await pool.query("SELECT 1 FROM discounts WHERE restaurant_id = $1 AND UPPER(code) = $2", [rid, offer.code]);

    if (found.rows.length > 0) {
      continue;
    }

    const r = offer.rules;
    await pool.query(
      `INSERT INTO discounts (restaurant_id, code, name, discount_type, value, min_order_amount, applies_to, status,
                              offer_type, product_ids, category_ids, weekdays, time_from, time_to, once_per_guest,
                              buy_quantity, get_quantity, get_discount_percent, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'all', 'active', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
      [
        rid,
        offer.code,
        offer.name,
        offer.type,
        offer.value,
        offer.minOrder || 0,
        r.offer_type || "discount",
        r.product_ids || null,
        r.category_ids || null,
        r.weekdays || null,
        r.time_from || null,
        r.time_to || null,
        Boolean(r.once_per_guest),
        r.buy_quantity || null,
        r.get_quantity || null,
        r.get_discount_percent || null,
        userId,
      ]
    );
    say(`Offer ${offer.code} added.`);
  }

  // A few advances held for guests, while the main counter's day is open.
  const day = await businessDayRepository.findOpen(rid, null);
  const held = (await pool.query("SELECT COUNT(*)::int AS n FROM customer_advances WHERE restaurant_id = $1", [rid])).rows[0].n;

  if (day && held < 3) {
    const guests = (
      await pool.query(
        `SELECT id, name FROM customers WHERE restaurant_id = $1 AND erased_at IS NULL AND status = 'active'
         ORDER BY id LIMIT 3`,
        [rid]
      )
    ).rows;
    const plans = [
      [5000, "cash", "Birthday party, Saturday, 40 guests"],
      [12000, "upi", "Office lunch, 60 boxes on Friday"],
      [2500, "card", "Anniversary dinner, table for 8"],
    ];

    for (let index = 0; index < guests.length; index += 1) {
      const [amount, method, purpose] = plans[index];
      const result = await customerAdvanceRepository.create(
        rid,
        { customerId: guests[index].id, amount, paymentMethod: method, transactionRef: method === "cash" ? null : `REF${100 + index}`, purpose },
        userId
      );

      if (result.id) {
        say(`Advance of ${amount} taken from ${guests[index].name}.`);
      }
    }
  } else if (!day) {
    say("No business day open: advances left out (they go into an open day's drawer).");
  }

  // Round 2: pickup orders paid ahead — up to two open takeaways of today's
  // day, not yet billed, each with an advance that its bill will offer first.
  // Once per order: an order that already has an advance is skipped.
  if (day) {
    const pickups = (
      await pool.query(
        `SELECT o.id, o.order_number, o.customer_id FROM orders o
         WHERE o.restaurant_id = $1 AND o.order_type = 'takeaway' AND o.order_status = 'open' AND o.business_day_id = $2
           AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.order_id = o.id AND b.bill_status <> 'void')
           AND NOT EXISTS (SELECT 1 FROM customer_advances a WHERE a.order_id = o.id)
         ORDER BY o.id DESC LIMIT 2`,
        [rid, day.id]
      )
    ).rows;
    const already = (await pool.query("SELECT COUNT(*)::int AS n FROM customer_advances WHERE restaurant_id = $1 AND order_id IS NOT NULL", [rid])).rows[0].n;
    const guests = (
      await pool.query(
        `SELECT id, name FROM customers WHERE restaurant_id = $1 AND erased_at IS NULL AND status = 'active' ORDER BY id OFFSET 3 LIMIT 2`,
        [rid]
      )
    ).rows;

    for (let index = 0; index < Math.min(pickups.length, guests.length, Math.max(0, 2 - already)); index += 1) {
      const order = pickups[index];
      const result = await customerAdvanceRepository.create(
        rid,
        { customerId: order.customer_id || guests[index].id, amount: [500, 300][index], paymentMethod: index ? "cash" : "upi",
          transactionRef: index ? null : "UPI 4471209", orderId: order.id, outletId: null },
        userId
      );

      if (result.id) {
        say(`Advance taken on pickup order ${order.order_number}.`);
      }
    }
  }
};

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
