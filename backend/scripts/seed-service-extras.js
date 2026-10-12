#!/usr/bin/env node
//
// Demo data for the service features built on 6 October (sweep SW-A-16 to
// SW-A-19) in the first restaurant, so the screens show a working evening:
//
//   - own delivery charges ₹40 a trip, free above ₹499 (only when the owner
//     has not set a charge yet)
//   - the most regular guest has a Home and an Office address saved
//   - a family of ten booked tonight across two tables pushed together
//   - a rider back from two deliveries with the cash still to hand in
//   - tonight's captain sections: each captain a floor of the main room
//
//   node scripts/seed-service-extras.js
//
// Safe to run again: each part looks for what it made before (by its own
// guest names and notes) and adds nothing twice. It never deletes anything,
// and adds orders only while a business day is open.
require("dotenv").config();

const pool = require("../src/config/database");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");
const reservationService = require("../src/modules/restaurant/reservations/services/reservation.service");
const guestAddressRepository = require("../src/modules/restaurant/online/repositories/guestAddress.repository");
const deliveryRepository = require("../src/modules/restaurant/deliveries/repositories/delivery.repository");

const say = (message) => console.log(message);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;

const SEED_NOTE = "Demo: rider back with cash";
const PARTY = "Kapoor family";

const run = async () => {
  const restaurant = await one("SELECT id, name FROM restaurants ORDER BY id LIMIT 1");

  if (!restaurant) {
    say("No restaurant yet; nothing to do.");
    return;
  }

  const restaurantId = Number(restaurant.id);
  const admin = await one(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE u.restaurant_id = $1 AND r.code = 'RESTAURANT_ADMIN' AND u.status = 'active' ORDER BY u.id LIMIT 1`,
    [restaurantId]
  );
  const userId = admin ? Number(admin.id) : null;
  const settings = await one("SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1", [restaurantId]);
  const zone = (settings && settings.timezone) || "Asia/Kolkata";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: zone });

  say(`Service extras for ${restaurant.name} (${today})`);

  // 1. Delivery charge on own delivery.
  const charged = await pool.query(
    `UPDATE sales_channels SET delivery_charge = 40, delivery_free_above = 499
     WHERE restaurant_id = $1 AND channel_type = 'own' AND delivery_charge = 0 AND delivery_free_above IS NULL
     RETURNING name`,
    [restaurantId]
  );
  say(charged.rows.length ? `  delivery charge set on ${charged.rows.map((row) => row.name).join(", ")}` : "  delivery charge already set");

  // 2. The most regular guest's saved addresses.
  const regular = await one(
    `SELECT c.id, c.name FROM customers c JOIN orders o ON o.customer_id = c.id
     WHERE c.restaurant_id = $1 AND c.erased_at IS NULL AND c.mobile IS NOT NULL
       AND c.name !~* '^(DLV|RCHK|R2T|TS |STK|Ambiguous|SVC|IIT|AUDIT)'
     GROUP BY c.id ORDER BY COUNT(o.id) DESC, c.id LIMIT 1`,
    [restaurantId]
  );

  if (regular) {
    const has = await guestAddressRepository.findForGuest(restaurantId, regular.id);

    if (has.length === 0) {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await guestAddressRepository.remember(
          client,
          restaurantId,
          regular.id,
          { label: "Office", address: "2nd floor, Sai Krishna Towers, Tilak Road, Rajahmundry", landmark: "Above the ICICI Bank" },
          userId
        );
        await guestAddressRepository.remember(
          client,
          restaurantId,
          regular.id,
          { label: "Home", address: "Flat 302, Sri Sai Residency, Danavaipeta, Rajahmundry", landmark: "Opposite the Kotipalli bus stand" },
          userId
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      say(`  two addresses saved for ${regular.name}`);
    } else {
      say(`  ${regular.name} already has ${has.length} saved address(es)`);
    }
  }

  // 3. Tonight's large party across two tables.
  const booked = await one(
    "SELECT id FROM reservations WHERE restaurant_id = $1 AND guest_name = $2 AND reservation_date = $3::date AND status IN ('booked','confirmed')",
    [restaurantId, PARTY, today]
  );

  if (booked) {
    say("  tonight's large party is already booked");
  } else {
    const tables = (
      await pool.query(
        `SELECT t.id, t.table_no, t.capacity FROM dining_tables t
         JOIN floors f ON f.id = t.floor_id
         WHERE t.restaurant_id = $1 AND t.status = 'active' AND t.outlet_id IS NULL AND f.status = 'active'
           AND t.capacity >= 4
           AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.table_id = t.id AND r.reservation_date = $2::date
                           AND r.status IN ('booked','confirmed','seated'))
           AND NOT EXISTS (SELECT 1 FROM reservation_tables x JOIN reservations r ON r.id = x.reservation_id
                           WHERE x.table_id = t.id AND r.reservation_date = $2::date AND r.status IN ('booked','confirmed','seated'))
         ORDER BY t.capacity DESC, t.table_no LIMIT 2`,
        [restaurantId, today]
      )
    ).rows;

    if (tables.length === 2) {
      try {
        await reservationService.create(
          restaurantId,
          {
            guestName: PARTY,
            guestMobile: "9876543210",
            partySize: 10,
            date: today,
            startTime: "20:30",
            durationMinutes: 120,
            tableId: Number(tables[0].id),
            extraTableIds: [Number(tables[1].id)],
            overrideCapacity: tables[0].capacity + tables[1].capacity < 10,
            capacityOverrideReason: tables[0].capacity + tables[1].capacity < 10 ? "Two high chairs at the end" : null,
            occasion: "anniversary",
            source: "phone",
            specialRequests: "Tables pushed together, cake at dessert",
          },
          userId
        );
        say(`  ${PARTY} (10) booked tonight at ${tables[0].table_no} + ${tables[1].table_no}`);
      } catch (error) {
        say(`  large party not booked: ${error.message}`);
      }
    } else {
      say("  no two free tables tonight for the large party");
    }
  }

  // 4. A rider back with cash for two deliveries.
  const day = await one(
    "SELECT id FROM business_days WHERE restaurant_id = $1 AND day_status = 'open' AND outlet_id IS NULL",
    [restaurantId]
  );
  const rider = await one(
    "SELECT id, name FROM employees WHERE restaurant_id = $1 AND department = 'delivery' AND status = 'active' ORDER BY id LIMIT 1",
    [restaurantId]
  );
  const done = await one("SELECT COUNT(*)::int AS n FROM orders WHERE restaurant_id = $1 AND notes = $2", [restaurantId, SEED_NOTE]);

  if (!day || !rider) {
    say("  no open day or no rider: the rider's cash is left out");
  } else if (done.n > 0) {
    say(`  ${rider.name} already has the demo deliveries`);
  } else {
    const dishes = (
      await pool.query(
        `SELECT id FROM products WHERE restaurant_id = $1 AND status = 'active' AND is_available = TRUE
           AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id)
         ORDER BY id LIMIT 6`,
        [restaurantId]
      )
    ).rows;
    const guests = [
      { name: "Lakshmi Prasanna", mobile: "9849011201", address: "D.No 46-12-3, Danavaipeta, Rajahmundry" },
      { name: "Venkat Rao", mobile: "9849011202", address: "Plot 18, Prakash Nagar, Rajahmundry" },
    ];

    for (const [index, guest] of guests.entries()) {
      const order = await orderService.create(
        restaurantId,
        {
          orderType: "delivery",
          source: "phone",
          outletId: null,
          customerName: guest.name,
          customerMobile: guest.mobile,
          notes: SEED_NOTE,
          items: dishes.slice(index * 2, index * 2 + 3).map((dish) => ({ productId: Number(dish.id), quantity: 1 })),
        },
        userId
      );
      await deliveryRepository.update(restaurantId, order.id, {
        address: guest.address,
        riderId: Number(rider.id),
        deliveryStatus: "delivered",
        dispatchedAt: "now",
        deliveredAt: "now",
      }, userId);
      await billService.createForOrder(
        restaurantId,
        { orderId: order.id, discountCode: null, outletId: null, loyaltyPoints: null, items: [] },
        userId
      );
    }

    say(`  ${rider.name} is back from two deliveries with the cash to hand in`);
  }

  // 5. Tonight's captain sections: the active floors shared out among the
  // captains, one floor each.
  const planDate = day ? (await one("SELECT business_date::text AS d FROM business_days WHERE id = $1", [day.id])).d : today;
  const planned = await one(
    "SELECT COUNT(*)::int AS n FROM captain_assignments WHERE restaurant_id = $1 AND shift_date = $2::date",
    [restaurantId, planDate]
  );

  if (planned.n > 0) {
    say("  tonight's captain plan is already made");
  } else {
    const captains = (
      await pool.query(
        `SELECT DISTINCT u.id, u.name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
         WHERE u.restaurant_id = $1 AND u.status = 'active' AND r.code = 'CAPTAIN' ORDER BY u.id LIMIT 3`,
        [restaurantId]
      )
    ).rows;
    const floors = (
      await pool.query(
        `SELECT f.id FROM floors f WHERE f.restaurant_id = $1 AND f.status = 'active'
           AND EXISTS (SELECT 1 FROM dining_tables t WHERE t.floor_id = f.id AND t.outlet_id IS NULL AND t.status = 'active')
         ORDER BY f.sort_order, f.id LIMIT 3`,
        [restaurantId]
      )
    ).rows;

    for (const [index, floor] of floors.slice(0, captains.length).entries()) {
      await pool.query(
        "INSERT INTO captain_assignments (restaurant_id, shift_date, user_id, floor_id, created_by) VALUES ($1, $2::date, $3, $4, $5)",
        [restaurantId, planDate, captains[index].id, floor.id, userId]
      );
    }

    say(`  ${Math.min(floors.length, captains.length)} captain section(s) planned for ${planDate}`);
  }
};

run()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
