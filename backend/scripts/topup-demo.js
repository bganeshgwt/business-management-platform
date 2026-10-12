#!/usr/bin/env node
//
// Trades the demo restaurant forward to today.
//
// seed-demo.js lays down a month of history ending on the day it was run, and
// then the clock keeps moving. A week later the dashboard is a row of zeroes
// and the reports open on an empty page — not because anything is broken, but
// because the restaurant has apparently not served anyone since. A demo that
// looks dead is worse than no demo.
//
// So this script picks up from the last business day the seed left and trades
// every day since, ending on today. The final day is left open and only
// part-traded, up to the hour it is actually run at, because that is what a
// restaurant looks like in the middle of service.
//
//   node scripts/topup-demo.js
//
// It is safe to run repeatedly: on a day that is already up to date it adds a
// few more covers to the open day and stops. It never deletes anything and
// never touches a day that has been closed.
require("dotenv").config();

const pool = require("../src/config/database");
const businessDayService = require("../src/modules/restaurant/business-day/services/businessDay.service");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");

const say = (message) => console.log(message);

const isoDate = (date) => date.toLocaleDateString("en-CA");

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (low, high) => low + Math.floor(Math.random() * (high - low + 1));

// Friday and Saturday are the peak, Monday the lull — the same shape the seed
// uses, so a topped-up week sits flush against the seeded history instead of
// showing a visible join.
const coversForDay = (date) => {
  const base = { 0: 34, 1: 16, 2: 18, 3: 20, 4: 24, 5: 38, 6: 42 }[date.getDay()];

  return Math.max(6, base + between(-5, 6));
};

// Roughly a third of covers at lunch, the rest in the evening.
const serviceTime = (upToHour) => {
  const lunch = Math.random() < 0.35;
  let minutes = lunch ? 12 * 60 + between(0, 179) : 19 * 60 + between(0, 239);

  // On a day still in progress, nothing may be stamped later than now.
  if (upToHour !== null) {
    minutes = Math.min(minutes, upToHour * 60 + between(0, 59));
  }

  const hours = Math.floor(minutes / 60);

  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(
    between(0, 59)
  ).padStart(2, "0")}`;
};

// A third of the day's covers at lunch, the rest at dinner — the same split
// the order timestamps use, so the hourly chart and the running total agree.
const LUNCH_SHARE = 0.35;

const PAYMENT_METHODS = ["cash", "cash", "card", "upi", "upi", "upi"];
const ORDER_TYPES = ["dine_in", "dine_in", "dine_in", "takeaway", "takeaway", "delivery"];

const main = async () => {
  const restaurant = await pool.query(
    "SELECT id FROM restaurants ORDER BY id LIMIT 1"
  );

  if (restaurant.rows.length === 0) {
    say("No restaurant found. Run scripts/seed-demo.js first.");
    return;
  }

  const restaurantId = Number(restaurant.rows[0].id);

  const user = await pool.query(
    "SELECT id FROM users WHERE restaurant_id = $1 ORDER BY id LIMIT 1",
    [restaurantId]
  );
  const userId = Number(user.rows[0].id);

  // What there is to sell, and to whom.
  const products = (
    await pool.query(
      `SELECT p.id, p.price
       FROM products p
       WHERE p.restaurant_id = $1 AND p.status = 'active' AND p.is_available = TRUE`,
      [restaurantId]
    )
  ).rows.map((row) => ({ id: Number(row.id), price: Number(row.price) }));

  if (products.length === 0) {
    say("No products to sell. Run scripts/seed-demo.js first.");
    return;
  }

  const tables = (
    await pool.query(
      "SELECT id FROM dining_tables WHERE restaurant_id = $1 AND status = 'active'",
      [restaurantId]
    )
  ).rows.map((row) => ({ id: Number(row.id) }));

  const customers = (
    await pool.query(
      "SELECT id, name, mobile FROM customers WHERE restaurant_id = $1 LIMIT 40",
      [restaurantId]
    )
  ).rows.map((row) => ({ id: Number(row.id), name: row.name, mobile: row.mobile }));

  const today = isoDate(new Date());

  // Where the seed left off. A day that is still open is finished first, then
  // closed, before the calendar is allowed to move on.
  const last = await pool.query(
    `SELECT id, business_date, day_status
     FROM business_days
     WHERE restaurant_id = $1
     ORDER BY business_date DESC
     LIMIT 1`,
    [restaurantId]
  );

  if (last.rows.length === 0) {
    say("No business days found. Run scripts/seed-demo.js first.");
    return;
  }

  const lastDate = isoDate(new Date(last.rows[0].business_date));

  if (lastDate > today) {
    say(`The demo is already trading on ${lastDate}, which is ahead of today. Nothing to do.`);
    return;
  }

  say(`Last business day: ${lastDate}${last.rows[0].day_status === "open" ? " (open)" : ""}`);
  say(`Today: ${today}`);

  // Every date from the last one to today, inclusive.
  const dates = [];
  const cursor = new Date(`${lastDate}T00:00:00`);

  while (isoDate(cursor) <= today) {
    dates.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  let addedOrders = 0;
  let addedBills = 0;
  let addedSales = 0;
  let openedDays = 0;

  for (const businessDate of dates) {
    const isToday = businessDate === today;

    // Is this day already on the books?
    const existing = await pool.query(
      `SELECT id, day_status, opening_cash
       FROM business_days
       WHERE restaurant_id = $1 AND business_date = $2::date AND outlet_id IS NULL`,
      [restaurantId, businessDate]
    );

    if (existing.rows.length > 0 && existing.rows[0].day_status === "closed") {
      continue;
    }

    const openingCash = 2000;
    let day;

    if (existing.rows.length > 0) {
      day = { id: Number(existing.rows[0].id) };
    } else {
      day = await businessDayService.openDay(
        restaurantId,
        { businessDate, openingCash, notes: null },
        userId
      );
      openedDays += 1;
    }

    // What has already been rung up on this day, so a day the seed left
    // half-traded is finished rather than traded all over again.
    const done = Number(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM orders WHERE restaurant_id = $1 AND business_day_id = $2",
          [restaurantId, day.id]
        )
      ).rows[0].count
    );

    const date = new Date(`${businessDate}T00:00:00`);
    const clock = new Date();
    const hour = clock.getHours();

    // A day in progress has served the covers it has had time to serve, which
    // is not a straight line from opening to closing. A restaurant does about
    // a third of its covers at lunch and the rest in the evening, so at 3pm it
    // has served a third and then sits quiet until seven.
    //
    // Spreading the day evenly instead made a busy mid-afternoon look like a
    // failing restaurant: at 2:44 it had served three tables.
    const servedByNow = (h) => {
      if (h < 12) {
        return 0;
      }

      // Lunch, 12 to 3: a third of the day's covers.
      if (h < 15) {
        return LUNCH_SHARE * ((h - 12) / 3);
      }

      // The lull. Nothing much happens between lunch and dinner.
      if (h < 19) {
        return LUNCH_SHARE;
      }

      // Dinner, 7 to 11: the rest of it.
      if (h < 23) {
        return LUNCH_SHARE + (1 - LUNCH_SHARE) * ((h - 19) / 4);
      }

      return 1;
    };

    const exactHour = hour + clock.getMinutes() / 60;
    const target = isToday
      ? Math.max(done, Math.round(coversForDay(date) * servedByNow(exactHour)))
      : coversForDay(date);

    const covers = Math.max(0, target - done);
    const stamps = [];
    let cashTaken = 0;

    for (let n = 0; n < covers; n += 1) {
      const orderType = pick(ORDER_TYPES);
      const table = orderType === "dine_in" && tables.length > 0 ? pick(tables) : null;
      const customer = customers.length > 0 && Math.random() < 0.34 ? pick(customers) : null;

      const chosen = [];

      for (let l = 0; l < between(1, 4); l += 1) {
        const product = pick(products);

        if (chosen.some((line) => line.productId === product.id)) {
          continue;
        }

        chosen.push({
          productId: product.id,
          productVariantId: null,
          modifierIds: [],
          quantity: between(1, 3),
          notes: null,
        });
      }

      if (chosen.length === 0) {
        continue;
      }

      let order;

      try {
        order = await orderService.create(
          restaurantId,
          {
            orderType,
            source: "pos",
            tableId: table ? table.id : null,
            outletId: null,
            customerId: customer ? customer.id : null,
            customerName: customer ? customer.name : null,
            customerMobile: customer ? customer.mobile : null,
            guestCount: orderType === "dine_in" ? between(1, 6) : null,
            notes: null,
            items: chosen,
          },
          userId
        );
      } catch {
        // Short of stock for that dish by now; skip the order rather than stop.
        continue;
      }

      addedOrders += 1;
      stamps.push({ orderId: order.id, billId: null, at: serviceTime(isToday ? hour : null) });

      // Two tables are still eating at the end of a day in progress.
      if (isToday && n >= covers - 2) {
        continue;
      }

      const bill = await billService.createForOrder(
        restaurantId,
        { orderId: order.id, discountCode: null, outletId: null, loyaltyPoints: null, items: [] },
        userId
      );

      const method = pick(PAYMENT_METHODS);

      await billService.addPayment(
        restaurantId,
        bill.id,
        {
          paymentMethod: method,
          amount: bill.dueAmount,
          tenderedAmount: method === "cash" ? Math.ceil(bill.dueAmount / 100) * 100 : null,
          transactionRef: method === "upi" ? `UPI${between(100000, 999999)}` : null,
        },
        userId
      );

      stamps[stamps.length - 1].billId = bill.id;
      addedBills += 1;
      addedSales += bill.totalAmount;

      if (method === "cash") {
        cashTaken += bill.totalAmount;
      }
    }

    // The paperwork is stamped with the hour it would have happened at, not
    // with the second this script ran. Without this every order in a month
    // lands at the same timestamp and the hourly chart is a single spike.
    const timezone = "Asia/Kolkata";

    for (const stamp of stamps) {
      await pool.query(
        `UPDATE orders SET placed_at = ($2::date + $3::time) AT TIME ZONE $4 WHERE id = $1`,
        [stamp.orderId, businessDate, stamp.at, timezone]
      );

      if (stamp.billId) {
        await pool.query(
          `UPDATE bills SET billed_at = ($2::date + $3::time + INTERVAL '45 minutes') AT TIME ZONE $4
           WHERE id = $1`,
          [stamp.billId, businessDate, stamp.at, timezone]
        );
        await pool.query(
          `UPDATE payments SET paid_at = ($2::date + $3::time + INTERVAL '50 minutes') AT TIME ZONE $4
           WHERE bill_id = $1`,
          [stamp.billId, businessDate, stamp.at, timezone]
        );
      }
    }

    // Yesterday and before are closed and counted. Today stays open, because
    // the POS needs a live day to work in.
    if (!isToday) {
      // Every table pays before the day closes. An earlier version of this
      // script closed days with tables still open — the day it left open as
      // "today" became yesterday, and its two running tables stayed "open" for
      // days afterwards. Closing the day now refuses to do that, so the
      // evening's last tables settle here, at the end of service.
      const leftOpen = await pool.query(
        `SELECT id FROM orders
         WHERE restaurant_id = $1 AND business_day_id = $2 AND order_status = 'open'
         ORDER BY placed_at`,
        [restaurantId, day.id]
      );

      for (const row of leftOpen.rows) {
        const bill = await billService.createForOrder(
          restaurantId,
          { orderId: Number(row.id), discountCode: null, outletId: null, loyaltyPoints: null, items: [] },
          userId
        );
        const method = pick(PAYMENT_METHODS);

        await billService.addPayment(
          restaurantId,
          bill.id,
          {
            paymentMethod: method,
            amount: bill.dueAmount,
            tenderedAmount: method === "cash" ? Math.ceil(bill.dueAmount / 100) * 100 : null,
            transactionRef: method === "upi" ? `UPI${between(100000, 999999)}` : null,
          },
          userId
        );

        // Late tables, settled at the end of the night.
        await pool.query(
          `UPDATE bills SET billed_at = ($2::date + TIME '22:40') AT TIME ZONE $3 WHERE id = $1`,
          [bill.id, businessDate, "Asia/Kolkata"]
        );
        await pool.query(
          `UPDATE payments SET paid_at = ($2::date + TIME '22:45') AT TIME ZONE $3 WHERE bill_id = $1`,
          [bill.id, businessDate, "Asia/Kolkata"]
        );

        addedBills += 1;
        addedSales += bill.totalAmount;

        if (method === "cash") {
          cashTaken += bill.totalAmount;
        }
      }

      const drift = Math.random() < 0.2 ? -between(20, 120) : 0;

      await businessDayService.closeDay(
        restaurantId,
        {
          closingCash: Math.round(openingCash + cashTaken + drift),
          notes: drift ? "Counted short at close" : null,
          // A bill already unpaid from before this script ran is a genuine
          // due, not something to invent a payment for.
          carryUnpaid: true,
        },
        userId
      );
    }

    // closeDay stamps closed_at with NOW(), so the honest times go on after it.
    await pool.query(
      `UPDATE business_days
       SET opened_at = business_date + TIME '10:00',
           closed_at = CASE WHEN closed_at IS NULL THEN NULL
                            ELSE business_date + TIME '23:30' END
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, day.id]
    );

    say(
      `  ${businessDate}${isToday ? " (open)" : ""} · ${covers} covers added`
    );
  }

  say("");
  say(
    `Topped up · ${openedDays} new business ${openedDays === 1 ? "day" : "days"}, ` +
      `${addedOrders} orders, ${addedBills} bills, ` +
      `₹${Math.round(addedSales).toLocaleString("en-IN")} of sales`
  );
};

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
