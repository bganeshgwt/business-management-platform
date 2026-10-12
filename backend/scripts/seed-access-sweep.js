#!/usr/bin/env node
//
// Demo data for the access features added in October 2026, on the demo
// restaurant (the first one), so their screens show a working restaurant
// instead of empty pages:
//
//   1. Leave types — Casual (1.5 days a month from this month, unused days
//      carried forward), Sick (12 days a year) and Unpaid. None is made the default, so leave
//      already marked without a type keeps following the Payroll setting it
//      was paid under: past months' pay does not change. New leave asks
//      for a type.
//   2. Tips — a tip on about twenty of the last week's cash, card and UPI
//      payments (tips never count as sales, GST or loyalty), and the tip
//      settings at their starting values (one pool, shared by hours worked).
//      Nothing is shared out: Staff > Tips shows them waiting for the manager.
//   3. Log book — a few days of handover notes from the floor, the kitchen
//      and the cash counter, two follow-ups still open and one closed, some
//      read by colleagues.
//
// Punch photos are not seeded: they are pictures of real staff, taken only
// once the owner switches them on.
//
//   node scripts/seed-access-sweep.js
//
// Safe to run again: each part is skipped when it is already there, and
// nothing is deleted.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");

const say = (message) => console.log(message);

const LEAVE_TYPES = [
  { name: "Casual", paid: true, allowanceDays: 1.5, period: "month", carryForward: true, sort: 1 },
  { name: "Sick", paid: true, allowanceDays: 12, period: "year", carryForward: false, sort: 2 },
  { name: "Unpaid", paid: false, allowanceDays: null, period: "month", carryForward: false, sort: 3 },
];

// [days before today, "HH:MM" on that day, kind, words, needs follow-up, closed note]
const LOG = [
  [3, "23:20", "maintenance", "Walk-in chiller showing 7°C at close. Moved the paneer and cream to the reach-in. Technician booked for tomorrow 11 am.", true, "Technician replaced the door gasket; holding 3°C since 2 pm."],
  [3, "22:45", "guest", "Mr. Sharma (regular, table 6) unhappy that the biryani came lukewarm. Gave a complimentary gulab jamun. Please greet him if he comes in this weekend.", false, null],
  [2, "16:10", "stock", "Basmati down to one 25 kg bag. Purchase order raised with Sri Balaji Traders, delivery promised Thursday morning.", false, null],
  [2, "23:05", "staff", "Ravi swapped Friday's evening shift with Imran. Roster updated.", false, null],
  [1, "15:30", "maintenance", "Tandoor gas burner on the left catching late. Venkatesh says it needs cleaning before Saturday.", true, null],
  [1, "22:50", "other", "UPI machine at counter 2 dropped the network twice during the dinner rush. Used counter 1's QR meanwhile.", false, null],
  [0, "11:15", "guest", "Birthday booking for 12 at 8 pm, table 10 and 11 joined. Cake arriving from Karachi Bakery at 7:30, keep the walk-in shelf clear.", true, null],
  [0, "13:40", "stock", "Paneer delivery came 2 kg short. Supplier will send the balance with tomorrow's order; noted on the receipt.", false, null],
];

const istDate = (date) => date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const addDays = (isoDate, days) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const seedLeaveTypes = async (restaurant) => {
  const existing = await pool.query("SELECT COUNT(*)::int AS n FROM leave_types WHERE restaurant_id = $1", [restaurant.id]);

  if (existing.rows[0].n > 0) {
    say(`  leave types: ${existing.rows[0].n} already set up, left as they are`);
    return;
  }

  // Counted from when the owner sets them up, as the Leave screen does: a
  // monthly type from the first of this month, a yearly one from 1 January.
  const today = istDate(new Date());
  const startOf = (period) => (period === "year" ? `${today.slice(0, 4)}-01-01` : `${today.slice(0, 7)}-01`);

  for (const type of LEAVE_TYPES) {
    await pool.query(
      `INSERT INTO leave_types (restaurant_id, name, paid, allowance_days, allowance_period, carry_forward, counts_from,
                                is_default, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, 'active', $8)`,
      [restaurant.id, type.name, type.paid, type.allowanceDays, type.period, type.carryForward, startOf(type.period), type.sort]
    );
  }

  say("  leave types: Casual (1.5 a month from this month, carried forward), Sick (12 a year), Unpaid");
};

const seedTips = async (restaurant) => {
  await pool.query(
    "INSERT INTO tip_settings (restaurant_id) VALUES ($1) ON CONFLICT (restaurant_id) DO NOTHING",
    [restaurant.id]
  );

  const tipped = await pool.query("SELECT COUNT(*)::int AS n FROM payments WHERE restaurant_id = $1 AND tip_amount > 0", [restaurant.id]);

  if (tipped.rows[0].n > 0) {
    say(`  tips: ${tipped.rows[0].n} payments already carry a tip, left as they are`);
    return;
  }

  // Paid bills only, never a payment already in a tip share-out: on each of
  // the last seven days, a couple of cash bills and one card and one UPI
  // bill, as a dining room sees them.
  const candidates = await pool.query(
    `SELECT id, payment_method, amount
     FROM (
       SELECT p.id, p.payment_method, p.amount,
              ROW_NUMBER() OVER (
                PARTITION BY (p.paid_at AT TIME ZONE 'Asia/Kolkata')::date, p.payment_method
                ORDER BY p.paid_at
              ) AS nth
       FROM payments p
       JOIN bills b ON b.id = p.bill_id AND b.bill_status = 'paid'
       WHERE p.restaurant_id = $1
         AND p.payment_method IN ('cash', 'card', 'upi')
         AND p.paid_at > NOW() - INTERVAL '7 days'
         AND p.amount >= 300
         AND NOT EXISTS (SELECT 1 FROM tip_shareout_payments s WHERE s.payment_id = p.id)
     ) picked
     WHERE nth <= CASE WHEN payment_method = 'cash' THEN 2 ELSE 1 END
     ORDER BY id`,
    [restaurant.id]
  );

  // Round amounts in cash, a share of the bill on cards and UPI.
  const chosen = candidates.rows.slice(0, 28);
  let total = 0;

  for (const [index, row] of chosen.entries()) {
    const amount = Number(row.amount);
    const tip =
      row.payment_method === "cash"
        ? [20, 50, 50, 100, 30, 100, 200][index % 7]
        : Math.max(10, Math.round(amount * [0.05, 0.08, 0.1][index % 3]));

    await pool.query("UPDATE payments SET tip_amount = $2 WHERE id = $1 AND tip_amount = 0", [row.id, tip]);
    total += tip;
  }

  say(`  tips: ₹${total} on ${chosen.length} of the last week's payments, waiting to be shared out`);
};

const seedLogbook = async (restaurant) => {
  const already = await pool.query("SELECT 1 FROM logbook_entries WHERE restaurant_id = $1 AND body = $2", [restaurant.id, LOG[0][3]]);

  if (already.rows.length > 0) {
    say("  log book: already seeded");
    return;
  }

  // People who write in it: the restaurant's managers, cashiers and
  // captains first, then anyone active.
  const writers = (
    await pool.query(
      `SELECT u.id, u.name
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.restaurant_id = $1 AND u.status = 'active'
       ORDER BY CASE r.code WHEN 'MANAGER' THEN 1 WHEN 'RESTAURANT_ADMIN' THEN 2 WHEN 'CASHIER' THEN 3 WHEN 'CAPTAIN' THEN 4 ELSE 5 END, u.id
       LIMIT 4`,
      [restaurant.id]
    )
  ).rows;

  if (writers.length === 0) {
    say("  log book: no active logins to write it, skipped");
    return;
  }

  // The log book's own "today": the restaurant-wide open business day first
  // (as the log book stamps entries), else an outlet's, else the date.
  const open = await pool.query(
    `SELECT business_date::text AS day FROM business_days
     WHERE restaurant_id = $1 AND day_status = 'open'
     ORDER BY outlet_id NULLS FIRST, business_date DESC
     LIMIT 1`,
    [restaurant.id]
  );
  const today = open.rows[0] ? open.rows[0].day : istDate(new Date());

  const shiftFor = (time) => {
    const hour = Number(time.slice(0, 2));
    return hour < 17 ? "Morning (09:00–17:00)" : "Evening (17:00–01:00)";
  };

  let count = 0;

  for (const [index, [daysBack, time, category, body, followUp, closedNote]] of LOG.entries()) {
    const day = addDays(today, -daysBack);
    const writer = writers[index % writers.length];
    const closer = writers[(index + 1) % writers.length];

    const inserted = await pool.query(
      `INSERT INTO logbook_entries (restaurant_id, category, body, shift_label, business_date, needs_follow_up,
                                    closed_at, closed_by, close_note, created_by, updated_by, created_at)
       VALUES ($1, $2, $3, $4, $5::date, $6,
               CASE WHEN $7::text IS NULL THEN NULL ELSE ($5::date + INTERVAL '1 day' + TIME '14:05') AT TIME ZONE 'Asia/Kolkata' END,
               CASE WHEN $7::text IS NULL THEN NULL ELSE $8::bigint END,
               $7, $9, $9, ($5::date + $10::time) AT TIME ZONE 'Asia/Kolkata')
       RETURNING id`,
      [restaurant.id, category, body, shiftFor(time), day, followUp, closedNote, closer.id, writer.id, time]
    );

    // Older entries have been read by the colleagues on the next shifts.
    if (daysBack >= 2) {
      for (const reader of writers.filter((person) => person.id !== writer.id).slice(0, 2)) {
        await pool.query(
          `INSERT INTO logbook_reads (entry_id, user_id, restaurant_id, read_at)
           VALUES ($1, $2, $3, ($4::date + INTERVAL '1 day' + TIME '10:30') AT TIME ZONE 'Asia/Kolkata')
           ON CONFLICT DO NOTHING`,
          [inserted.rows[0].id, reader.id, restaurant.id, day]
        );
      }
    }

    count += 1;
  }

  say(`  log book: ${count} entries over the last four days, 2 follow-ups open`);
};

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant yet: run seed-demo.js first.");
    return;
  }

  say(`Access demo data for ${restaurant.name}:`);
  await seedLeaveTypes(restaurant);
  await seedTips(restaurant);
  await seedLogbook(restaurant);
  say("Done.");
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
