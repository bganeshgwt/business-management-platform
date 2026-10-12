#!/usr/bin/env node
//
// Gives the demo restaurant a guest book worth analysing.
//
// seed-demo.js leaves a dozen customers who each ate there almost every day,
// and hundreds of anonymous bills. That is nobody's real restaurant: in a real
// one a few regulars come every week, most people come once, some came often
// and then stopped, and there is always a birthday this week. Guest insights
// has nothing true to show until the guest book looks like that.
//
// So this script:
//
//   1. Adds a cast of guests (fixed names and mobiles) with birthdays spread
//      across the year, a few of them in the coming week.
//   2. Gives each one a visit pattern — regular, new, occasional, lapsed, big
//      spender — by linking EXISTING anonymous, fully paid orders to them, the
//      way a cashier would have if the guest had given their number at the
//      till. Nothing is billed, priced or paid here: every rupee was already
//      on a real bill, so every report still adds up to the paisa.
//   3. Credits the loyalty points those paid bills would have earned (one
//      entry per bill, dated when it was paid), so each guest's points balance
//      is explained by their history.
//   2b. A lapsed guest's visits must be older than the 45 quiet days that
//      make them lapsed. Each is linked to an existing anonymous paid order
//      from within a week of the day it is meant to be, wherever the demo's
//      history reaches that far back. Only the visits older than that
//      history are rung up — through the POS's own order, bill and payment
//      services, dated to when they happened, and marked on the order as
//      coming from before the records here began. See ringUpPastVisits for
//      why each of those bills still reconciles.
//   4. Seats a regular and a big spender at open tables, if any anonymous
//      dine-in orders are open right now, so the bell can say who is in.
//   5. Records a little feedback: praise from regulars, and the poor rating
//      and complaints that put three guests on the "unhappy" list.
//
// Safe to run again: a guest who already has visits is left as they are,
// feedback is written once, and orders already linked to anyone are never
// touched — except that visits an earlier run rang up are given their
// "earlier visit" note, once, if they do not have it. It never deletes
// anything.
//
//   node scripts/seed-guest-insights.js
//   DB_NAME=restaurant_management_test node scripts/seed-guest-insights.js
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");
const restaurantRepository = require("../src/modules/restaurant/setup/repositories/restaurant.repository");

const say = (message) => console.log(message);

// --- the cast ---------------------------------------------------------------
//
// pattern     how they visit (see PATTERNS)
// birthday    days from today their birthday is kept at, for the ones who
//             make "birthdays this week" true on whatever day this runs
// seat        sat at an open table right now, if one is free to link
// mood        what they told us: "praise", "poor", "complaint", "angry"

const GUESTS = [
  // Regulars: every week or so, for as long as there is history.
  { name: "Harsha Vardhan Pinnamaneni", mobile: "9849510101", email: "harsha.p@example.com", dob: "1987-03-14", pattern: "regular", seat: "regular", mood: "praise", said: "Same great biryani every time, and the staff remember how we like it. Our Friday place." },
  { name: "Keerthi Sowmya Alluri", mobile: "9849510102", email: "keerthi.alluri@example.com", dob: "1994-11-02", pattern: "regular", birthday: 0 },
  { name: "Rahul Varma Datla", mobile: "9849510103", dob: "1990-07-21", pattern: "regular", mood: "complaint" },
  { name: "Bhavani Shankar Gollapudi", mobile: "9849510104", dob: "1972-01-09", pattern: "regular", mood: "praise", said: "Apollo fish was spot on and the kids loved the family booth upstairs." },
  { name: "Sneha Latha Kakarla", mobile: "9849510105", email: "sneha.k@example.com", dob: "1996-05-30", pattern: "regular" },
  { name: "Imran Sheikh", mobile: "9849510106", dob: "1985-12-17", pattern: "regular" },
  { name: "Deepika Chowdary Ravi", mobile: "9849510107", email: "deepika.ravi@example.com", dob: "1993-08-05", pattern: "regular", mood: "praise", said: "Quick lunch service even on a busy weekday. Filter coffee is the best in Rajahmundry." },
  { name: "Arjun Kolli", mobile: "9849510108", pattern: "regular" },
  { name: "Madhavi Yerra", mobile: "9849510109", dob: "1979-04-26", pattern: "regular" },
  { name: "Srikanth Nookala", mobile: "9849510110", dob: "1988-10-11", pattern: "regular" },

  // Big spenders: family feasts and office parties — the largest bills.
  { name: "Chaitanya Raju Bhupathiraju", mobile: "9849510201", email: "chaitanya.raju@example.com", dob: "1976-06-03", pattern: "big", seat: "big" },
  { name: "Swapna Kanumuri", mobile: "9849510202", email: "swapna.k@example.com", dob: "1982-09-19", pattern: "big", birthday: 2 },
  { name: "Vikram Aditya Gokaraju", mobile: "9849510203", dob: "1980-02-29", pattern: "big" },
  { name: "Farhana Shaik", mobile: "9849510204", email: "farhana.shaik@example.com", dob: "1991-03-08", pattern: "big" },

  // New: first visit in the last few weeks.
  { name: "Ananya Iyer", mobile: "9849510301", email: "ananya.iyer@example.com", dob: "1999-01-25", pattern: "new" },
  { name: "Rohit Malhotra", mobile: "9849510302", dob: "1995-07-07", pattern: "new-returning" },
  { name: "Tejaswini Mudunuri", mobile: "9849510303", email: "tejaswini.m@example.com", dob: "1998-12-12", pattern: "new", birthday: 4 },
  { name: "Karthik Subramanian", mobile: "9849510304", dob: "1992-04-18", pattern: "new", mood: "angry" },
  { name: "Pooja Nair", mobile: "9849510305", email: "pooja.nair@example.com", pattern: "new-returning" },
  { name: "Nikhil Sai Vegesna", mobile: "9849510306", dob: "2000-08-29", pattern: "new" },
  { name: "Ayesha Siddiqua", mobile: "9849510307", dob: "1997-10-30", pattern: "new" },
  { name: "Manoj Kumar Bora", mobile: "9849510308", pattern: "new" },

  // Occasional: a couple of visits, weeks apart.
  { name: "Lokesh Nadendla", mobile: "9849510401", dob: "1986-02-02", pattern: "occasional", mood: "poor" },
  { name: "Gayatri Chilukuri", mobile: "9849510402", email: "gayatri.c@example.com", dob: "1990-05-15", pattern: "occasional", birthday: 6 },
  { name: "Suresh Pydi", mobile: "9849510403", pattern: "occasional" },
  { name: "Latha Mangipudi", mobile: "9849510404", dob: "1968-11-24", pattern: "occasional" },

  // Lapsed: came often, then stopped — each in their own way, as `targets`
  // (days ago) overriding PATTERNS.lapsed: a weekly family regular, a
  // fortnightly couple, an office-lunch regular who changed jobs, a guest
  // who came twice a month apart. Every visit is 46+ days old.
  { name: "Ramana Murthy Bhagavatula", mobile: "9849510501", dob: "1965-09-01", pattern: "lapsed", targets: [52, 60, 67, 75, 82, 90] },
  { name: "Jyothi Vadlamani", mobile: "9849510502", email: "jyothi.v@example.com", dob: "1984-03-27", pattern: "lapsed", targets: [47, 61, 75, 89] },
  { name: "Prakash Rao Koduri", mobile: "9849510503", dob: "1977-12-05", pattern: "lapsed", targets: [63, 70, 77, 84, 91, 98, 105] },
  { name: "Nandini Achanta", mobile: "9849510504", dob: "1989-06-22", pattern: "lapsed", targets: [58, 88] },
  { name: "Venu Gopal Pericherla", mobile: "9849510505", pattern: "lapsed", targets: [49, 52, 56, 59, 63, 66, 70, 73] },

  // Signed up (a QR form, a feedback card) and not yet back to eat.
  { name: "Sai Charan Tadepalli", mobile: "9849510601", dob: "2001-01-13", pattern: "none" },
  { name: "Revathi Bommidala", mobile: "9849510602", email: "revathi.b@example.com", dob: "1994-07-31", pattern: "none" },
];

// Visits as "days ago" targets. Each is matched to the nearest trading day
// that still has an anonymous paid order, so the same pattern works on a
// demo with a week of history and on one with a year.
const PATTERNS = {
  regular: { targets: [1, 4, 8, 12, 17, 22, 28, 35, 42, 50, 57], pick: "typical" },
  big: { targets: [2, 9, 16, 26, 37, 51], pick: "largest" },
  new: { targets: [3], within: 25, pick: "typical" },
  "new-returning": { targets: [5, 1], within: 25, pick: "typical" },
  occasional: { targets: [13, 29], pick: "typical" },
  // Every visit at least 46 days back: a lapsed guest is one who stopped.
  // Planned by planLapsed, not planVisits.
  lapsed: { targets: [48, 56, 64, 75, 90], pick: "typical" },
  none: { targets: [] },
};

const MOODS = {
  // Each regular says it in their own words (`said` on the guest).
  praise: {
    kind: "feedback",
    rating: 5,
    status: "reviewed",
    source: "qr",
  },
  poor: {
    kind: "feedback",
    rating: 2,
    text: "Starters took 35 minutes and the biryani was lukewarm by the time it came.",
    status: "reviewed",
    source: "qr",
  },
  angry: {
    kind: "feedback",
    rating: 1,
    text: "Paneer tikka was rubbery and nobody came to ask how the food was.",
    status: "new",
    source: "in_store",
  },
  complaint: {
    kind: "complaint",
    subject: "Charged for a raita we did not order",
    description: "Guest noticed an extra raita on the bill at the counter.",
    category: "billing",
    priority: "medium",
    status: "resolved",
    resolution: "Refunded the raita at the counter and apologised; captain briefed on repeating orders back.",
  },
};

// Guests seated at open tables are only linked to orders this fresh: older
// than a sitting and it is a table someone forgot to close. The same window
// the Guest insights screen uses for "in the house now", taken from it rather
// than written again here — at 3.5 hours against the screen's 4, a guest
// seated between the two was never placed by the seed yet would be shown.
const { SEATED_WITHIN_HOURS } = require("../src/modules/restaurant/crm/services/guestInsight.service").rules;

// A lapsed guest's visit is linked to a real order only if one exists within
// this many days of when the visit is meant to be. Further than that and the
// guest's rhythm would be bent out of shape (a weekly regular whose visits
// all land in the same few days), so that visit is rung up instead.
const LAPSED_LINK_WITHIN_DAYS = 7;
// Every lapsed visit is at least this old: 45 quiet days, plus one for luck.
const LAPSED_FROM_DAYS = 46;

// Written on every order this script rings up for a visit from before the
// records began, so anyone who opens one of those bills — or a sales report
// for June — can see where it came from, and a script can find them all.
const PAST_VISIT_NOTE = "Earlier visit from before these records began — added by the guest history demo seed";

// --- helpers ----------------------------------------------------------------

const isoAdd = (iso, days) => {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

const tableExists = async (name) =>
  (await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${name}`])).rows[0].present;

// --- 1. the guests ----------------------------------------------------------

const ensureGuests = async (restaurantId, userId) => {
  const byMobile = new Map();

  for (const guest of GUESTS) {
    await pool.query(
      `INSERT INTO customers (restaurant_id, name, mobile, email, date_of_birth, status,
                              notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'active', NULL, $6, $6)
       ON CONFLICT (restaurant_id, mobile) WHERE mobile IS NOT NULL DO NOTHING`,
      [restaurantId, guest.name, guest.mobile, guest.email || null, guest.dob || null, userId]
    );
  }

  const rows = (
    await pool.query(
      `SELECT id, name, mobile, date_of_birth, loyalty_points, created_at
       FROM customers WHERE restaurant_id = $1 AND mobile = ANY($2::text[])`,
      [restaurantId, GUESTS.map((guest) => guest.mobile)]
    )
  ).rows;

  for (const row of rows) {
    byMobile.set(row.mobile, row);
  }

  // A mobile already used by somebody else in this restaurant is theirs, not
  // ours: that guest is skipped rather than having a stranger's history.
  return GUESTS.map((guest) => {
    const row = byMobile.get(guest.mobile);
    return row && row.name === guest.name ? { ...guest, row } : null;
  }).filter(Boolean);
};

// Birthdays this week, on whatever day the script runs: the guests marked
// with `birthday` keep their year of birth but have the day moved to that
// many days from today — unless enough of the cast already have one due.
const ensureBirthdaysThisWeek = async (restaurantId, guests, today) => {
  const marked = guests.filter((guest) => guest.birthday !== undefined);
  const dueSoon = guests.filter((guest) => {
    if (!guest.row.date_of_birth) {
      return false;
    }

    const monthDay = guest.row.date_of_birth.slice(5);
    return [0, 1, 2, 3, 4, 5, 6].some((offset) => isoAdd(today, offset).slice(5) === monthDay);
  });

  if (dueSoon.length >= marked.length) {
    return 0;
  }

  let moved = 0;

  for (const guest of marked) {
    const target = isoAdd(today, guest.birthday);
    const year = (guest.row.date_of_birth || guest.dob || "1990-01-01").slice(0, 4);
    let dob = `${year}${target.slice(4)}`;

    // 29 February only exists in a leap year of birth.
    if (dob.endsWith("-02-29") && Number(year) % 4 !== 0) {
      dob = `${year}-02-28`;
    }

    if (guest.row.date_of_birth !== dob) {
      await pool.query("UPDATE customers SET date_of_birth = $3 WHERE restaurant_id = $1 AND id = $2", [
        restaurantId,
        guest.row.id,
        dob,
      ]);
      guest.row.date_of_birth = dob;
      moved += 1;
    }
  }

  return moved;
};

// --- 2 & 3. visits and the points they earned --------------------------------

// Orders that belong to nobody and are finished and fully paid. Anything tied
// to a booking, a QR table request, a waitlist entry or a delivery partner
// is left alone — those screens show who the order was for.
const findAnonymousPaidOrders = async (restaurantId, timezone) => {
  const exclusions = [];

  for (const table of ["reservations", "table_requests", "waitlist_entries"]) {
    if (await tableExists(table)) {
      exclusions.push(`NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.order_id = o.id)`);
    }
  }

  const result = await pool.query(
    `SELECT o.id, (o.placed_at AT TIME ZONE $2::text)::date AS day,
            SUM(b.total_amount) FILTER (WHERE b.bill_status = 'paid') AS total
     FROM orders o
     JOIN bills b ON b.order_id = o.id
     WHERE o.restaurant_id = $1
       AND o.customer_id IS NULL
       AND o.customer_name IS NULL
       AND o.customer_mobile IS NULL
       AND o.order_status = 'completed'
       AND o.order_type IN ('dine_in', 'takeaway')
       AND o.channel_id IS NULL
       ${exclusions.map((clause) => `AND ${clause}`).join("\n       ")}
     GROUP BY o.id
     -- Every live bill paid in full: a guest's history is money received.
     HAVING BOOL_AND(b.bill_status IN ('paid', 'void'))
        AND SUM(b.total_amount) FILTER (WHERE b.bill_status = 'paid') > 0
     ORDER BY o.id`,
    [restaurantId, timezone]
  );

  const byDay = new Map();

  for (const row of result.rows) {
    if (!byDay.has(row.day)) {
      byDay.set(row.day, []);
    }

    byDay.get(row.day).push({ id: row.id, total: Number(row.total) });
  }

  return byDay;
};

// The order to take from a day: the largest bill for a big spender, the one
// nearest the day's middle for everyone else — a regular's usual lunch, not
// the one-off banquet.
const takeOrder = (orders, pick) => {
  if (orders.length === 0) {
    return null;
  }

  const sorted = [...orders].sort((a, b) => b.total - a.total || a.id - b.id);
  const chosen = pick === "largest" ? sorted[0] : sorted[Math.floor(sorted.length / 2)];

  orders.splice(orders.indexOf(chosen), 1);
  return chosen;
};

// A guest's own visit days, where the cast gives them, else their pattern's.
const targetsOf = (guest) => guest.targets || PATTERNS[guest.pattern].targets;

const planVisits = (guest, byDay, today) => {
  const pattern = PATTERNS[guest.pattern];
  const usedDays = new Set();
  const chosen = [];

  for (const target of targetsOf(guest)) {
    let best = null;

    for (const [day, orders] of byDay) {
      const ago = daysBetween(day, today);

      if (orders.length === 0 || usedDays.has(day) || ago < 0) {
        continue;
      }

      if (pattern.within !== undefined && ago > pattern.within) {
        continue;
      }

      if (pattern.from !== undefined && ago < pattern.from) {
        continue;
      }

      const distance = Math.abs(ago - target);

      if (!best || distance < best.distance || (distance === best.distance && day > best.day)) {
        best = { day, distance };
      }
    }

    if (!best) {
      continue;
    }

    const order = takeOrder(byDay.get(best.day), pattern.pick);

    if (order) {
      usedDays.add(best.day);
      chosen.push(order);
    }
  }

  return chosen;
};

// A lapsed guest's visits: each linked to a real anonymous paid order from
// within a week of its day, where the demo's history reaches back that far;
// the rest (days ago) left to be rung up. Real orders are always preferred —
// every rupee on them is already in the day's takings.
const planLapsed = (guest, byDay, today) => {
  const usedDays = new Set();
  const linked = [];
  const rungUp = [];

  for (const target of targetsOf(guest)) {
    let best = null;

    for (const [day, orders] of byDay) {
      const ago = daysBetween(day, today);
      const distance = Math.abs(ago - target);

      if (
        orders.length === 0 ||
        usedDays.has(day) ||
        ago < LAPSED_FROM_DAYS ||
        distance > LAPSED_LINK_WITHIN_DAYS
      ) {
        continue;
      }

      if (!best || distance < best.distance || (distance === best.distance && day > best.day)) {
        best = { day, distance };
      }
    }

    const order = best ? takeOrder(byDay.get(best.day), PATTERNS.lapsed.pick) : null;

    if (order) {
      usedDays.add(best.day);
      linked.push(order);
    } else {
      rungUp.push(target);
    }
  }

  return { linked, rungUp };
};

// They joined the guest book on their first visit, not the day this ran.
const joinedOnFirstVisit = (client, restaurantId, customerId) =>
  client.query(
    `UPDATE customers c
     SET created_at = LEAST(c.created_at, first.placed_at)
     FROM (SELECT MIN(placed_at) AS placed_at FROM orders WHERE restaurant_id = $1 AND customer_id = $2) first
     WHERE c.restaurant_id = $1 AND c.id = $2 AND first.placed_at IS NOT NULL`,
    [restaurantId, customerId]
  );

// One guest's history, all or nothing: link the orders, then credit each paid
// bill's points in the order they were paid, exactly as the till would have.
// `alreadyLinked` is how many visits this run has just rung up for them (a
// lapsed guest's oldest visits); anything else already on their name means
// the history is theirs from an earlier run or the till, and is left alone.
const linkVisits = async (restaurantId, guest, orders, settings, userId, alreadyLinked = 0) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT loyalty_points,
              (SELECT COUNT(*)::int FROM orders WHERE restaurant_id = $1 AND customer_id = $2) AS linked
       FROM customers WHERE restaurant_id = $1 AND id = $2 FOR UPDATE`,
      [restaurantId, guest.row.id]
    );

    if (locked.rows.length === 0 || locked.rows[0].linked !== alreadyLinked) {
      await client.query("ROLLBACK");
      return { visits: 0, points: 0 };
    }

    // customer_id IS NULL again here: an order another process claimed since
    // the plan was made is skipped, never overwritten.
    const linked = await client.query(
      `UPDATE orders
       SET customer_id = $3, customer_name = $4, customer_mobile = $5
       WHERE restaurant_id = $1 AND id = ANY($2::bigint[]) AND customer_id IS NULL
       RETURNING id`,
      [restaurantId, orders.map((order) => order.id), guest.row.id, guest.row.name, guest.row.mobile]
    );

    let balance = Number(locked.rows[0].loyalty_points);
    let earned = 0;

    if (settings.loyalty_enabled && linked.rows.length > 0) {
      const bills = await client.query(
        `SELECT id, total_amount, COALESCE(settled_at, billed_at) AS paid_at
         FROM bills
         WHERE restaurant_id = $1 AND order_id = ANY($2::bigint[]) AND bill_status = 'paid'
         ORDER BY COALESCE(settled_at, billed_at), id`,
        [restaurantId, linked.rows.map((row) => row.id)]
      );

      for (const bill of bills.rows) {
        const points = Math.floor(Number(bill.total_amount) / Number(settings.loyalty_earn_amount));

        if (points <= 0) {
          continue;
        }

        const inserted = await client.query(
          `INSERT INTO loyalty_transactions (restaurant_id, customer_id, bill_id, points, balance_after,
                                             entry_type, amount, notes, created_at, created_by)
           VALUES ($1, $2, $3, $4, $5, 'earn', $6, $7, $8, $9)
           ON CONFLICT (bill_id) WHERE entry_type = 'earn' DO NOTHING
           RETURNING points`,
          [
            restaurantId,
            guest.row.id,
            bill.id,
            points,
            balance + points,
            bill.total_amount,
            `Earned on bill ${bill.id}`,
            bill.paid_at,
            userId,
          ]
        );

        if (inserted.rows.length > 0) {
          balance += points;
          earned += points;
        }
      }

      await client.query("UPDATE customers SET loyalty_points = $3 WHERE restaurant_id = $1 AND id = $2", [
        restaurantId,
        guest.row.id,
        balance,
      ]);
    }

    await joinedOnFirstVisit(client, restaurantId, guest.row.id);

    await client.query("COMMIT");
    return { visits: linked.rows.length, points: earned };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- 2b. before the records began ---------------------------------------------
//
// A lapsed guest came at least twice and then not for 45 days, so every one of
// their visits is more than 45 days old. planLapsed links each one to a real
// order where the demo's history reaches back that far. A demo made by
// seed-demo.js has about a month of trading, so for most of them there is no
// order old enough. Those visits are rung up instead, through the same
// order, bill and payment services the POS uses — priced from the menu,
// taxed, rounded and paid exactly as the till would have, earning the points
// the till would have credited — then dated to the day and hour they
// happened, and marked with PAST_VISIT_NOTE on the order.
//
// Four choices keep that honest:
//
//   - No business day. The first business day on record is when this system
//     started running the restaurant's days, and these meals came before it.
//     Every report already dates a bill without a business day by its bill
//     date, and no day's cash drawer changes.
//   - No stock. The stock ledger starts from an opening count taken after
//     these meals, and every movement carries a running balance, so taking
//     their ingredients out of today's shelves would be wrong twice over. The
//     billing service decides from the auto-consume setting; for this
//     script's own process only — never the running app — it sees that
//     setting as off, and each bill records that it took nothing
//     (consume_stock = false), so voiding one later returns nothing either.
//   - Takeaway, so no table on today's floor is touched while they are rung up.
//   - The note on each order, so these bills can always be told apart from
//     the restaurant's own trading.
//
// Invoice numbers are a running count, so these bills carry the next numbers
// in the series: their numbers are later than their dates. Renumbering them
// would leave a gap in the series instead, which is worse on a GST invoice
// book. Only a demo that trades for more than 45 days before its first
// invoice (seed-demo.js building that history) avoids both, and then
// planLapsed links it and nothing is rung up at all.

const PAST_VISIT_TIMES = ["13:20", "20:40", "21:05", "13:45", "20:10"];
const PAST_METHODS = ["upi", "cash", "card", "upi", "cash"];

// The dishes a past visit is made of: the restaurant's own menu, oldest dishes
// first (the ones it has always sold), no combos.
const findPastMenu = async (restaurantId) =>
  (
    await pool.query(
      `SELECT id, name
       FROM products
       WHERE restaurant_id = $1 AND status = 'active' AND is_available = TRUE
         AND is_combo = FALSE AND price > 0
       ORDER BY id
       LIMIT 40`,
      [restaurantId]
    )
  ).rows;

// For this process only: the settings the billing service reads, with stock
// consumption switched off, put back the moment the work is done.
const withoutStockConsumption = async (work) => {
  const original = restaurantRepository.findSettings;

  restaurantRepository.findSettings = async (...args) => ({
    ...(await original(...args)),
    auto_consume_stock: false,
  });

  try {
    return await work();
  } finally {
    restaurantRepository.findSettings = original;
  }
};

// Moves one rung-up visit to when it happened: out of today's business day,
// served, billed 25 minutes in and paid five minutes after that — the points
// it earned dated with the payment.
const datePastVisit = async (restaurantId, { orderId, billId, date, time }, timezone) => {
  const client = await pool.connect();
  // The restaurant's local date and time, plus some minutes, as an instant.
  const at = (minutes) => `($3::date + $4::time + INTERVAL '${minutes} minutes') AT TIME ZONE $5`;

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE orders
       SET business_day_id = NULL, kitchen_status = 'served',
           placed_at = ${at(0)}, created_at = ${at(0)}, completed_at = ${at(30)}
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, orderId, date, time, timezone]
    );
    await client.query(
      `UPDATE order_items
       SET item_status = 'served', created_at = ${at(0)}
       WHERE order_id = $2 AND item_status <> 'cancelled'
         AND EXISTS (SELECT 1 FROM orders WHERE restaurant_id = $1 AND id = $2)`,
      [restaurantId, orderId, date, time, timezone]
    );
    await client.query(
      `UPDATE bills
       SET business_day_id = NULL, billed_at = ${at(25)}, created_at = ${at(25)}, settled_at = ${at(30)}
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, billId, date, time, timezone]
    );
    await client.query(
      `UPDATE payments
       SET business_day_id = NULL, paid_at = ${at(30)}, created_at = ${at(30)}
       WHERE restaurant_id = $1 AND bill_id = $2`,
      [restaurantId, billId, date, time, timezone]
    );
    await client.query(
      `UPDATE loyalty_transactions
       SET created_at = ${at(30)}
       WHERE restaurant_id = $1 AND bill_id = $2`,
      [restaurantId, billId, date, time, timezone]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// The visits of a lapsed guest that no real order could stand for (`back`:
// how many days ago each was), oldest first so their points build up in
// order. `index` varies the dishes, times and payment methods from guest to
// guest.
const ringUpPastVisits = async (restaurantId, guest, back, menu, context, index) => {
  const { today, timezone, userId } = context;
  const daysAgo = [...back].sort((a, b) => b - a);
  let visits = 0;

  for (const [n, back] of daysAgo.entries()) {
    const date = isoAdd(today, -back);
    const time = PAST_VISIT_TIMES[(index + n) % PAST_VISIT_TIMES.length];
    const method = PAST_METHODS[(index + n) % PAST_METHODS.length];
    let order = null;

    // Two dishes, one or two of each. A dish that is off the menu right now
    // (sold out, outside its hours) is refused, so the next pair is tried.
    for (let attempt = 0; attempt < 4 && !order; attempt += 1) {
      const dish = (k) => menu[(index * 7 + n * 3 + attempt * 11 + k * 5) % menu.length];
      const items = [dish(0), dish(1)]
        .filter((one, position, all) => all.findIndex((other) => other.id === one.id) === position)
        .map((one, k) => ({
          productId: one.id,
          productVariantId: null,
          modifierIds: [],
          quantity: 1 + ((index + n + k) % 2),
          notes: null,
        }));

      try {
        order = await orderService.create(
          restaurantId,
          {
            orderType: "takeaway",
            source: "pos",
            tableId: null,
            outletId: null,
            customerId: guest.row.id,
            customerName: guest.row.name,
            customerMobile: guest.row.mobile,
            guestCount: null,
            notes: PAST_VISIT_NOTE,
            items,
          },
          userId
        );
      } catch {
        order = null;
      }
    }

    if (!order) {
      continue;
    }

    let bill;

    try {
      bill = await billService.createForOrder(
        restaurantId,
        { orderId: order.id, discountCode: null, outletId: null, loyaltyPoints: null, items: [] },
        userId
      );
      await billService.addPayment(
        restaurantId,
        bill.id,
        {
          paymentMethod: method,
          amount: bill.dueAmount,
          tenderedAmount: method === "cash" ? Math.ceil(bill.dueAmount / 100) * 100 : null,
          transactionRef: method === "upi" ? `UPI${String(bill.id).padStart(8, "0")}` : null,
        },
        userId
      );
    } catch (error) {
      // Never leave a half-rung visit open on today's floor: an order with no
      // bill is cancelled; a bill that could not be paid is left for a person.
      if (!bill) {
        await orderService
          .cancel(restaurantId, order.id, "Guest history seed could not bill this visit", userId)
          .catch(() => {});
      }

      throw error;
    }

    await datePastVisit(restaurantId, { orderId: order.id, billId: bill.id, date, time }, timezone);
    visits += 1;
  }

  if (visits > 0) {
    await joinedOnFirstVisit(pool, restaurantId, guest.row.id);
  }

  const earned = (
    await pool.query(
      `SELECT COALESCE(SUM(points), 0)::int AS points FROM loyalty_transactions
       WHERE restaurant_id = $1 AND customer_id = $2 AND entry_type = 'earn'`,
      [restaurantId, guest.row.id]
    )
  ).rows[0].points;

  return { visits, points: earned };
};

// Visits rung up by an earlier run of this script, before orders were marked:
// a lapsed cast guest's takeaway order with no business day, from more than
// 45 days ago, is one of them — the restaurant's own orders always carry a
// business day. Marked once; a note someone has since written is kept.
const markPastVisits = async (restaurantId, customerIds) => {
  if (customerIds.length === 0) {
    return 0;
  }

  const result = await pool.query(
    `UPDATE orders
     SET notes = $3
     WHERE restaurant_id = $1
       AND customer_id = ANY($2::bigint[])
       AND business_day_id IS NULL
       AND order_type = 'takeaway'
       AND notes IS NULL
       AND placed_at < NOW() - make_interval(days => $4)`,
    [restaurantId, customerIds, PAST_VISIT_NOTE, LAPSED_FROM_DAYS - 1]
  );

  return result.rowCount;
};

// --- 4. who is in right now ---------------------------------------------------

const seatGuests = async (restaurantId, guests) => {
  const ids = guests.map((guest) => guest.row.id);

  const already = await pool.query(
    `SELECT COUNT(*)::int AS count FROM orders
     WHERE restaurant_id = $1 AND order_status = 'open' AND order_type = 'dine_in'
       AND customer_id = ANY($2::bigint[])
       AND placed_at >= NOW() - make_interval(mins => $3)`,
    [restaurantId, ids, Math.round(SEATED_WITHIN_HOURS * 60)]
  );

  if (already.rows[0].count > 0) {
    return null;
  }

  const open = (
    await pool.query(
      `SELECT o.id, t.table_no
       FROM orders o
       JOIN dining_tables t ON t.id = o.table_id
       JOIN business_days bd ON bd.id = o.business_day_id AND bd.day_status = 'open'
       WHERE o.restaurant_id = $1
         AND o.order_status = 'open'
         AND o.order_type = 'dine_in'
         AND o.customer_id IS NULL
         AND o.customer_name IS NULL
         AND o.customer_mobile IS NULL
         AND o.placed_at >= NOW() - make_interval(mins => $2)
       ORDER BY o.placed_at DESC
       LIMIT 2`,
      [restaurantId, Math.round(SEATED_WITHIN_HOURS * 60)]
    )
  ).rows;

  const seatedAs = ["regular", "big"];
  const seated = [];

  for (const [index, order] of open.entries()) {
    const guest = guests.find((candidate) => candidate.seat === seatedAs[index]);

    if (!guest) {
      continue;
    }

    const updated = await pool.query(
      `UPDATE orders SET customer_id = $3, customer_name = $4, customer_mobile = $5
       WHERE restaurant_id = $1 AND id = $2 AND customer_id IS NULL
       RETURNING id`,
      [restaurantId, order.id, guest.row.id, guest.row.name, guest.row.mobile]
    );

    if (updated.rows.length > 0) {
      seated.push(`${guest.name} at ${order.table_no}`);
    }
  }

  return seated;
};

// --- 5. what they told us ------------------------------------------------------

const recordMoods = async (restaurantId, guests, userId) => {
  let written = 0;

  for (const guest of guests.filter((candidate) => candidate.mood)) {
    const mood = { ...MOODS[guest.mood], ...(guest.said ? { text: guest.said } : {}) };

    // Said after their most recent finished visit, an hour or two after it.
    const visit = (
      await pool.query(
        `SELECT MAX(placed_at) AS placed_at FROM orders
         WHERE restaurant_id = $1 AND customer_id = $2 AND order_status = 'completed'`,
        [restaurantId, guest.row.id]
      )
    ).rows[0].placed_at;

    if (!visit) {
      continue;
    }

    if (mood.kind === "feedback") {
      const exists = await pool.query(
        "SELECT 1 FROM feedback WHERE restaurant_id = $1 AND customer_id = $2 AND comments = $3",
        [restaurantId, guest.row.id, mood.text]
      );

      if (exists.rows.length > 0) {
        continue;
      }

      await pool.query(
        `INSERT INTO feedback (restaurant_id, customer_id, customer_name, customer_mobile, rating,
                               comments, source, feedback_status, created_at, updated_at,
                               created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz + INTERVAL '90 minutes',
                 $9::timestamptz + INTERVAL '90 minutes', $10, $10)`,
        [
          restaurantId,
          guest.row.id,
          guest.row.name,
          guest.row.mobile,
          mood.rating,
          mood.text,
          mood.source,
          mood.status,
          visit,
          userId,
        ]
      );
    } else {
      const exists = await pool.query(
        "SELECT 1 FROM complaints WHERE restaurant_id = $1 AND customer_id = $2 AND subject = $3",
        [restaurantId, guest.row.id, mood.subject]
      );

      if (exists.rows.length > 0) {
        continue;
      }

      await pool.query(
        `INSERT INTO complaints (restaurant_id, customer_id, customer_name, customer_mobile, subject,
                                 description, category, priority, complaint_status, resolution,
                                 resolved_at, created_at, updated_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11::timestamptz + INTERVAL '1 day', $11::timestamptz + INTERVAL '1 hour',
                 $11::timestamptz + INTERVAL '1 day', $12, $12)`,
        [
          restaurantId,
          guest.row.id,
          guest.row.name,
          guest.row.mobile,
          mood.subject,
          mood.description,
          mood.category,
          mood.priority,
          mood.status,
          mood.resolution,
          visit,
          userId,
        ]
      );
    }

    written += 1;
  }

  return written;
};

// --- run ------------------------------------------------------------------------

const main = async () => {
  const restaurant = await pool.query(
    `SELECT r.id, r.name,
            COALESCE(rs.timezone, 'Asia/Kolkata') AS timezone,
            ('guest_loyalty' = ANY (restaurant_features(r.id))) AS loyalty_enabled,
            COALESCE(rs.loyalty_earn_amount, 100) AS loyalty_earn_amount
     FROM restaurants r
     LEFT JOIN restaurant_settings rs ON rs.restaurant_id = r.id
     ORDER BY r.id
     LIMIT 1`
  );

  if (restaurant.rows.length === 0) {
    say("No restaurant found. Run scripts/seed-demo.js first.");
    return;
  }

  const settings = restaurant.rows[0];
  const restaurantId = Number(settings.id);
  // Nothing to seed for a feature switched off in Settings -> Features.
  if (await featureOff(pool, restaurantId, "guests")) {
    return;
  }

  const user = await pool.query(
    `SELECT u.id FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.restaurant_id = $1
     ORDER BY (r.code = 'RESTAURANT_ADMIN') DESC NULLS LAST, u.id
     LIMIT 1`,
    [restaurantId]
  );
  const userId = user.rows.length ? Number(user.rows[0].id) : null;

  const today = (
    await pool.query("SELECT (NOW() AT TIME ZONE $1::text)::date AS today", [settings.timezone])
  ).rows[0].today;

  say(`Guest insights demo data for ${settings.name} (${today}, ${settings.timezone})`);

  const guests = await ensureGuests(restaurantId, userId);
  say(`  guests · ${guests.length} in the cast`);

  const moved = await ensureBirthdaysThisWeek(restaurantId, guests, today);
  say(`  birthdays · ${moved ? `${moved} moved into the coming week` : "already some this week"}`);

  const byDay = await findAnonymousPaidOrders(restaurantId, settings.timezone);
  const days = [...byDay.keys()].sort();
  const oldest = days[0];
  const historyDays = oldest ? daysBetween(oldest, today) : 0;

  say(
    `  history · ${days.length} trading days with anonymous paid orders${
      oldest ? `, back to ${oldest} (${historyDays} days)` : ""
    }`
  );

  let visits = 0;
  let points = 0;
  let linkedGuests = 0;
  const lapsedGuests = [];

  const withHistory = new Set(
    (
      await pool.query(
        `SELECT DISTINCT customer_id FROM orders
         WHERE restaurant_id = $1 AND customer_id = ANY($2::bigint[])`,
        [restaurantId, guests.map((guest) => guest.row.id)]
      )
    ).rows.map((row) => row.customer_id)
  );

  for (const guest of guests) {
    // Linked on an earlier run (or since, at the till): their history is
    // theirs now and is not added to.
    if (withHistory.has(guest.row.id)) {
      continue;
    }

    if (guest.pattern === "lapsed") {
      const plan = planLapsed(guest, byDay, today);

      // Some of their visits are older than the demo's history: those are
      // rung up below, and the rest linked after them, oldest first.
      if (plan.rungUp.length > 0) {
        lapsedGuests.push({ guest, plan });
        continue;
      }

      // The history reaches back far enough: linked like anyone else's.
      const result = await linkVisits(restaurantId, guest, plan.linked, settings, userId);

      if (result.visits > 0) {
        linkedGuests += 1;
        visits += result.visits;
        points += result.points;
      }

      continue;
    }

    const plan = planVisits(guest, byDay, today);

    if (plan.length === 0) {
      continue;
    }

    const result = await linkVisits(restaurantId, guest, plan, settings, userId);

    if (result.visits > 0) {
      linkedGuests += 1;
      visits += result.visits;
      points += result.points;
    }
  }

  say(`  visits · ${visits} paid orders linked to ${linkedGuests} guests, ${points} points credited`);

  if (lapsedGuests.length > 0) {
    const openDay = await pool.query(
      "SELECT 1 FROM business_days WHERE restaurant_id = $1 AND day_status = 'open' LIMIT 1",
      [restaurantId]
    );
    const menu = await findPastMenu(restaurantId);
    const canRingUp = openDay.rows.length > 0 && menu.length > 0;

    let guestsDone = 0;
    let rungVisits = 0;
    let realVisits = 0;
    let lapsedPoints = 0;

    await withoutStockConsumption(async () => {
      for (const [index, { guest, plan }] of lapsedGuests.entries()) {
        let rung = { visits: 0, points: 0 };

        if (canRingUp) {
          rung = await ringUpPastVisits(
            restaurantId,
            guest,
            plan.rungUp,
            menu,
            { today, timezone: settings.timezone, userId },
            index
          );
        } else if (plan.linked.length < 2) {
          // Nothing can be rung up today, and the real orders alone would not
          // make them lapsed (two visits at least): left for the next run.
          continue;
        }

        const linked =
          plan.linked.length > 0
            ? await linkVisits(restaurantId, guest, plan.linked, settings, userId, rung.visits)
            : { visits: 0, points: 0 };

        if (rung.visits + linked.visits > 0) {
          guestsDone += 1;
          rungVisits += rung.visits;
          realVisits += linked.visits;
          lapsedPoints += rung.points + linked.points;
        }
      }
    });

    const older = lapsedGuests.flatMap(({ plan }) => plan.rungUp);

    say(
      `  lapsed · ${guestsDone} guests: ${realVisits} visits linked to real orders${
        canRingUp
          ? `, ${rungVisits} older visits (${Math.min(...older)}–${Math.max(
              ...older
            )} days ago, past the linkable history of ${historyDays} days) rung up and marked as earlier visits`
          : `; the older visits were not rung up: ${
              menu.length === 0 ? "the menu has no dish on sale" : "the POS needs an open business day"
            }. Run this again once it has`
      }, ${lapsedPoints} points earned`
    );
  }

  // Visits rung up before they were marked, by an earlier run of this script.
  const marked = await markPastVisits(
    restaurantId,
    guests.filter((guest) => guest.pattern === "lapsed").map((guest) => guest.row.id)
  );

  if (marked > 0) {
    say(`  earlier visits · ${marked} rung up by an earlier run now marked as such`);
  }

  const seated = await seatGuests(restaurantId, guests);
  say(
    `  in the house · ${
      seated === null
        ? "already seated from an earlier run"
        : seated.length
          ? seated.join(", ")
          : "no anonymous table open right now to seat anyone at"
    }`
  );

  const moods = await recordMoods(restaurantId, guests, userId);
  say(`  feedback · ${moods} new ratings and complaints`);
};

// Run as a script it seeds; required (by the module's tests) it only hands
// over the planning rules, so they can be checked without writing anything.
if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = {
  planLapsed,
  PAST_VISIT_NOTE,
  LAPSED_LINK_WITHIN_DAYS,
  LAPSED_FROM_DAYS,
};
