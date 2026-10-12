#!/usr/bin/env node
//
// A reservations book that looks like a real Indian restaurant's: the last two
// weeks of bookings (mostly honoured, a few no-shows and cancellations), a
// busy today — lunch done, a couple of tables seated now, one party running
// late, the evening filling up — tomorrow already taking shape, and a few
// walk-ins waiting at the door.
//
//   node scripts/seed-reservations.js
//   DB_NAME=restaurant_management_test node scripts/seed-reservations.js
//
// Every guest comes from the script's own list below, so the same run on the
// same day always makes the same choices, whatever else is in the database.
// A booking is linked to the guest book only when a customer there has
// exactly that guest's mobile; nobody is ever added to the guest book.
//
// Safe to run again. A booking is identified by its date, the guest's mobile
// (and, for history, its time), and one that already exists is not added
// twice. What a rerun later in the day does do is bring its own rows up to
// the time it runs, the way the host would have: its bookings whose whole
// slot has gone by are marked completed (or no-show), and its walk-ins still
// "waiting" from hours ago are moved up to now. It touches only rows it wrote
// itself (its own guests' names and numbers), never deletes anything, and
// only ever seats a party at a table that is free.
//
// History is written directly, because the booking rules rightly refuse to
// take a booking in the past. Parties seated today go through the real
// seating path, so their orders are opened exactly as the host stand would
// open them, and the dishes on them are priced by the order service.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const reservationService = require("../src/modules/restaurant/reservations/services/reservation.service");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const restaurantRepository = require("../src/modules/restaurant/setup/repositories/restaurant.repository");

const HISTORY_DAYS = 14;

const say = (message) => console.log(message);

// Deterministic per day and slot, so a re-run makes the same choices and the
// same bookings are recognised as already there.
const rngFor = (seedText) => {
  let state = 0;

  for (const char of seedText) {
    state = (state * 31 + char.charCodeAt(0)) % 2147483647;
  }

  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
};

const GUESTS = [
  ["Priya Sharma", "9820011201"],
  ["Rahul Mehta", "9820011202"],
  ["Ananya Iyer", "9820011203"],
  ["Vikram Reddy", "9820011204"],
  ["Sneha Kulkarni", "9820011205"],
  ["Arjun Nair", "9820011206"],
  ["Kavya Menon", "9820011207"],
  ["Rohan Gupta", "9820011208"],
  ["Meera Pillai", "9820011209"],
  ["Aditya Rao", "9820011210"],
  ["Ishita Banerjee", "9820011211"],
  ["Karan Malhotra", "9820011212"],
  ["Pooja Desai", "9820011213"],
  ["Siddharth Joshi", "9820011214"],
  ["Neha Kapoor", "9820011215"],
  ["Varun Choudhary", "9820011216"],
  ["Divya Krishnan", "9820011217"],
  ["Manish Agarwal", "9820011218"],
  ["Aishwarya Patil", "9820011219"],
  ["Nikhil Verma", "9820011220"],
  ["Shreya Ghosh", "9820011221"],
  ["Harish Venkatesh", "9820011222"],
  ["Lakshmi Narayanan", "9820011223"],
  ["Farhan Qureshi", "9820011224"],
  ["Tanvi Shah", "9820011225"],
  ["Gaurav Saxena", "9820011226"],
  ["Ritu Singh", "9820011227"],
  ["Abhishek Jain", "9820011228"],
  ["Deepa Raman", "9820011229"],
  ["Suresh Babu", "9820011230"],
  ["Zoya Khan", "9820011231"],
  ["Kabir Sethi", "9820011232"],
  ["Nandini Hegde", "9820011233"],
  ["Amit Das", "9820011234"],
  ["Fatima Sheikh", "9820011235"],
  ["Rajesh Kumar", "9820011236"],
  ["Swati Mishra", "9820011237"],
  ["Vivek Anand", "9820011238"],
  ["Preeti Bhatia", "9820011239"],
  ["Sanjay Pillai", "9820011240"],
  // Regulars who are also in the demo restaurant's guest book (seed-demo.js),
  // so on the demo their bookings link to their guest-book entry.
  ["Ravi Teja Konidela", "9848112233"],
  ["Anusha Reddy", "9885667788"],
  ["Divya Bharathi", "9885101112"],
  ["Mohammed Ilyas", "9963778899"],
];

// The walk-ins the seed puts at the door and in today's earlier queue.
const DOOR = [
  { name: "Arvind Menon", mobile: "9820022301", party: 4, waited: 27, quoted: 20, notes: "Prefers AC section" },
  { name: "Sana Mirza", mobile: "9820022302", party: 2, waited: 12, quoted: 15, notes: null },
  { name: "Joseph Thomas", mobile: "9820022303", party: 6, waited: 5, quoted: 30, notes: "Two kids, need a high chair" },
];

const EARLIER = [
  { name: "Kiran Rao", mobile: "9820022311", party: 2, ago: 150, waited: 12, status: "seated", table: 0 },
  { name: "Leela Iyer", mobile: "9820022312", party: 4, ago: 110, waited: 22, status: "seated", table: 1 },
  { name: "Imran Ali", mobile: "9820022313", party: 3, ago: 95, waited: 18, status: "left" },
  { name: "Ramesh Gowda", mobile: "9820022314", party: 5, ago: 70, waited: 16, status: "seated", table: 2 },
];

const REQUESTS = [
  "Window table if possible",
  "Bringing our own birthday cake — please keep it chilled",
  "One guest uses a wheelchair, needs step-free seating",
  "High chair for a toddler",
  "Jain food for two guests — no onion, no garlic",
  "Nut allergy on the table",
  "Quiet corner please, business discussion",
  "Anniversary — a small dessert with a candle would be lovely",
  "Prefers the AC section",
  "Celebrating a promotion, may order a cake on the spot",
];

const NOTES = [
  "Regular — always orders the butter chicken",
  "Called to confirm at 4 pm",
  "Owner's guest, look after them",
  "Arrived 30 min late last visit",
  "Paid by corporate card last time, may want a GST invoice",
];

const CANCEL_REASONS = [
  "Guest cancelled — change of plans",
  "Guest unwell",
  "Booked twice by mistake",
  "Heavy rain, guest could not travel",
  "Moved to another date",
];

const LUNCH = ["12:00", "12:15", "12:30", "12:45", "13:00", "13:30", "14:00"];
const DINNER = ["19:00", "19:15", "19:30", "19:45", "20:00", "20:15", "20:30", "20:45", "21:00", "21:30"];

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

const toMinutes = (time) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

// Clamped to the day: a time placed "45 minutes ago" just after midnight is
// simply before opening, and is skipped like any other out-of-hours slot.
const hhmm = (minutes) => {
  const within = Math.min(Math.max(minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(within / 60)).padStart(2, "0")}:${String(within % 60).padStart(2, "0")}`;
};

const addDays = (date, days) => reservationService.stampAt(date, days * 1440).slice(0, 10);

const weekdayOf = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

// Parties of two or four most evenings, the odd family of six, and a rare
// big table that eats a cabin for two hours.
const partyFor = (rng) => {
  const roll = rng();

  if (roll < 0.34) return 2;
  if (roll < 0.52) return 3;
  if (roll < 0.76) return 4;
  if (roll < 0.86) return 5;
  if (roll < 0.94) return 6;
  if (roll < 0.98) return 8;
  return 10;
};

const durationFor = (party) => (party <= 2 ? 75 : party <= 4 ? 90 : party <= 6 ? 105 : 120);

const sourceFor = (rng) => {
  const roll = rng();

  if (roll < 0.45) return "phone";
  if (roll < 0.65) return "online";
  if (roll < 0.8) return "app";
  if (roll < 0.9) return "walk_in";
  return "other";
};

const occasionFor = (rng) => {
  const roll = rng();

  if (roll < 0.1) return "birthday";
  if (roll < 0.16) return "anniversary";
  if (roll < 0.22) return "business";
  if (roll < 0.28) return "date_night";
  return null;
};

(async () => {
  const restaurant = await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1");

  if (restaurant.rows.length === 0) {
    say("No restaurant found. Run the migrations and seed the demo first.");
    return;
  }

  const restaurantId = Number(restaurant.rows[0].id);

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "reservations")) {

    return;

  }
  const settings = await restaurantRepository.findSettings(restaurantId);
  const timezone = settings.timezone || "Asia/Kolkata";
  const clock = reservationService.localClock(timezone);
  const today = clock.date;

  const user = await pool.query(
    "SELECT id FROM users WHERE restaurant_id = $1 AND status = 'active' ORDER BY id LIMIT 1",
    [restaurantId]
  );
  const userId = user.rows[0] ? Number(user.rows[0].id) : null;

  const tables = (
    await pool.query(
      `SELECT id, table_no, capacity FROM dining_tables
       WHERE restaurant_id = $1 AND status = 'active'
       ORDER BY capacity, length(table_no), table_no`,
      [restaurantId]
    )
  ).rows.map((row) => ({ id: Number(row.id), tableNo: row.table_no, capacity: row.capacity }));

  if (tables.length === 0) {
    say("No active tables. Add tables first — bookings need somewhere to sit.");
    return;
  }

  const hours = await restaurantRepository.findBusinessHours(restaurantId);
  const hoursFor = (date) => {
    const row = hours.find((item) => Number(item.day_of_week) === weekdayOf(date));

    if (!row) {
      return { open: 11 * 60, last: 22 * 60 + 30 };
    }

    if (!row.is_open) {
      return null;
    }

    const open = toMinutes(row.open_time);
    let close = toMinutes(row.close_time);

    if (close <= open) {
      close += 1440;
    }

    return { open, last: close - 30 };
  };

  // A guest on the list is linked to the guest book only when a customer
  // there has exactly their mobile — the host recognising a regular, never a
  // guess from whoever happens to be in the book.
  const linked = new Map(
    (
      await pool.query(
        `SELECT DISTINCT ON (mobile) id, mobile FROM customers
         WHERE restaurant_id = $1 AND status = 'active' AND mobile = ANY($2::text[])
         ORDER BY mobile, id`,
        [restaurantId, GUESTS.map(([, mobile]) => mobile)]
      )
    ).rows.map((row) => [row.mobile, Number(row.id)])
  );

  const guestAt = (index) => {
    const [guestName, guestMobile] = GUESTS[index % GUESTS.length];
    return { guestName, guestMobile, customerId: linked.get(guestMobile) || null };
  };

  const exists = async (date, mobile, startTime = null) =>
    (
      await pool.query(
        `SELECT 1 FROM reservations
         WHERE restaurant_id = $1 AND reservation_date = $2 AND guest_mobile = $3
           AND ($4::time IS NULL OR start_time = $4::time)`,
        [restaurantId, date, mobile, startTime]
      )
    ).rows.length > 0;

  // Rows this script wrote: its own guests, by name and number together.
  const ownGuests = [GUESTS.map(([, mobile]) => mobile), GUESTS.map(([name]) => name)];

  // ------------------------------------------------------------ catching up
  // A rerun hours after the last one finds the seed's own bookings still
  // "booked" for a lunch that is long over. A host would have closed them:
  // the confirmed ones came and ate, and roughly one in nine of the rest
  // never showed. Only bookings whose whole slot is over are touched.
  const caughtUp = await pool.query(
    `UPDATE reservations r
     SET status = CASE WHEN r.status = 'confirmed' OR r.id % 9 <> 0 THEN 'completed' ELSE 'no_show' END,
         completed_at = CASE WHEN r.status = 'confirmed' OR r.id % 9 <> 0
                             THEN r.ends_at AT TIME ZONE $4::text END,
         no_show_at = CASE WHEN r.status = 'confirmed' OR r.id % 9 <> 0
                           THEN NULL ELSE (r.starts_at + INTERVAL '25 minutes') AT TIME ZONE $4::text END
     WHERE r.restaurant_id = $1
       AND r.status IN ('booked', 'confirmed')
       AND r.ends_at <= $5::timestamp
       AND (r.guest_mobile, r.guest_name) IN (SELECT * FROM unnest($2::text[], $3::text[]))
     RETURNING r.id`,
    [restaurantId, ...ownGuests, timezone, clock.stamp]
  );

  // Occupied windows per table and date, from what is already in the book
  // plus what this run adds, so the seed never double-books a table.
  const taken = new Map();

  const loadDay = async (date) => {
    if (taken.has(date)) {
      return;
    }

    const rows = (
      await pool.query(
        `SELECT table_id, EXTRACT(EPOCH FROM (start_time))::int / 60 AS start, duration_minutes
         FROM reservations
         WHERE restaurant_id = $1 AND reservation_date = $2 AND table_id IS NOT NULL
           AND status NOT IN ('cancelled')`,
        [restaurantId, date]
      )
    ).rows;

    taken.set(
      date,
      rows.map((row) => ({
        tableId: Number(row.table_id),
        start: Number(row.start),
        end: Number(row.start) + Number(row.duration_minutes),
      }))
    );
  };

  const busyNow = new Set(
    (
      await pool.query(
        `SELECT DISTINCT table_id FROM orders
         WHERE restaurant_id = $1 AND table_id IS NOT NULL AND order_status IN ('open', 'billed')`,
        [restaurantId]
      )
    ).rows.map((row) => Number(row.table_id))
  );

  const pickTable = (date, start, duration, party, rng, { avoidBusy = false } = {}) => {
    const windows = taken.get(date);
    const fitting = tables.filter((table) => table.capacity >= party);
    // Rotate where the search starts, so the same table is not first choice
    // every time and the room fills the way a real one does.
    const offset = fitting.length ? Math.floor(rng() * Math.min(fitting.length, 4)) : 0;
    const ordered = [...fitting.slice(offset), ...fitting.slice(0, offset)].sort(
      (a, b) => a.capacity - b.capacity
    );

    return (
      ordered.find(
        (table) =>
          !(avoidBusy && busyNow.has(table.id)) &&
          !windows.some(
            (window) => window.tableId === table.id && window.start < start + duration && window.end > start
          )
      ) || null
    );
  };

  const reserve = (date, table, start, duration) =>
    taken.get(date).push({ tableId: table.id, start, end: start + duration });

  const nextReference = async () => {
    const result = await pool.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(reference_no, '[^0-9]', '', 'g'), '')::int), 0) + 1 AS next
       FROM reservations WHERE restaurant_id = $1`,
      [restaurantId]
    );

    return `R${String(result.rows[0].next).padStart(4, "0")}`;
  };

  // Local wall-clock text -> an instant, worked out by PostgreSQL in the
  // restaurant's timezone.
  const at = (date, minutes) => (minutes === null ? null : reservationService.stampAt(date, minutes));

  const insert = async (booking) => {
    const reference = await nextReference();
    const start = toMinutes(booking.startTime);
    const result = await pool.query(
      `INSERT INTO reservations
         (restaurant_id, reference_no, customer_id, guest_name, guest_mobile, party_size,
          reservation_date, start_time, duration_minutes, table_id, capacity_override, occasion,
          special_requests, source, internal_notes, status, cancel_reason,
          confirmed_at, completed_at, cancelled_at, no_show_at, created_at, updated_at,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18::timestamp AT TIME ZONE $23::text, $19::timestamp AT TIME ZONE $23::text,
               $20::timestamp AT TIME ZONE $23::text, $21::timestamp AT TIME ZONE $23::text,
               $22::timestamp AT TIME ZONE $23::text, $22::timestamp AT TIME ZONE $23::text,
               $24, $24)
       RETURNING id`,
      [
        restaurantId,
        reference,
        booking.customerId || null,
        booking.guestName,
        booking.guestMobile,
        booking.partySize,
        booking.date,
        booking.startTime,
        booking.durationMinutes,
        booking.tableId || null,
        Boolean(booking.overrideCapacity),
        booking.occasion || null,
        booking.specialRequests || null,
        booking.source,
        booking.internalNotes || null,
        booking.status,
        booking.cancelReason || null,
        booking.confirmedAt ? at(booking.date, start + booking.confirmedAt) : null,
        booking.status === "completed" ? at(booking.date, start + booking.durationMinutes) : null,
        booking.status === "cancelled" ? at(booking.date, start - 180) : null,
        booking.status === "no_show" ? at(booking.date, start + 25) : null,
        at(booking.date, start - booking.bookedAhead),
        timezone,
        userId,
      ]
    );

    return Number(result.rows[0].id);
  };

  const counts = {
    history: 0,
    today: 0,
    tomorrow: 0,
    seated: 0,
    waitlist: 0,
    refreshed: 0,
    caughtUp: caughtUp.rowCount,
    skipped: 0,
  };

  // ------------------------------------------------------------ the last two weeks
  for (let back = HISTORY_DAYS; back >= 1; back -= 1) {
    const date = addDays(today, -back);
    const window = hoursFor(date);

    if (!window) {
      continue;
    }

    await loadDay(date);

    const dayRng = rngFor(`history-${date}`);
    const weekend = [0, 5, 6].includes(weekdayOf(date));
    const howMany = (weekend ? 11 : 7) + Math.floor(dayRng() * 4);
    const usedMobiles = new Set();

    for (let index = 0; index < howMany; index += 1) {
      // One sequence per booking, so skipping one that already exists does
      // not shift every choice after it on a re-run.
      const rng = rngFor(`history-${date}-${index}`);
      const slot = pick(rng, index % 3 === 0 ? LUNCH : DINNER);
      const start = toMinutes(slot);
      const guest = guestAt(Math.floor(rng() * GUESTS.length));
      const party = partyFor(rng);
      const duration = durationFor(party);
      const roll = rng();
      const status = roll < 0.08 ? "no_show" : roll < 0.17 ? "cancelled" : "completed";

      if (start < window.open || start > window.last || usedMobiles.has(guest.guestMobile)) {
        continue;
      }

      usedMobiles.add(guest.guestMobile);

      if (await exists(date, guest.guestMobile, slot)) {
        counts.skipped += 1;
        continue;
      }

      const table = pickTable(date, start, duration, party, rng);

      if (!table) {
        continue;
      }

      if (status !== "cancelled") {
        reserve(date, table, start, duration);
      }

      await insert({
        ...guest,
        date,
        startTime: slot,
        partySize: party,
        durationMinutes: duration,
        tableId: table.id,
        occasion: occasionFor(rng),
        specialRequests: rng() < 0.3 ? pick(rng, REQUESTS) : null,
        internalNotes: rng() < 0.12 ? pick(rng, NOTES) : null,
        source: sourceFor(rng),
        status,
        cancelReason: status === "cancelled" ? pick(rng, CANCEL_REASONS) : null,
        confirmedAt: status === "cancelled" ? null : -240,
        bookedAhead: 60 * (4 + Math.floor(rng() * 72)),
      });
      counts.history += 1;
    }
  }

  // ------------------------------------------------------------ today
  const todayHours = hoursFor(today);

  if (todayHours) {
    await loadDay(today);

    const now = clock.minutes;
    const snap = (minutes) => Math.round(minutes / 15) * 15;

    // Fixed service times, plus a handful placed around "now" so whenever the
    // seed runs there is someone seated, someone late and someone on the way.
    const plan = [
      { key: 0, time: "12:30", party: 4, occasion: "business", source: "phone" },
      { key: 1, time: "13:00", party: 2, source: "online" },
      { key: 2, time: "13:15", party: 6, occasion: "birthday", source: "phone", request: 1 },
      { key: 3, time: "13:30", party: 3, source: "app" },
      { key: 4, time: hhmm(snap(now - 45)), party: 2, source: "phone", seatNow: true },
      { key: 5, time: hhmm(snap(now - 30)), party: 4, source: "online", seatNow: true, request: 4 },
      { key: 6, time: hhmm(snap(now - 25)), party: 5, source: "phone", confirmed: true, late: true },
      { key: 7, time: hhmm(snap(now + 20)), party: 2, source: "app", confirmed: true, occasion: "date_night" },
      { key: 8, time: hhmm(snap(now + 45)), party: 4, source: "phone", request: 0 },
      { key: 9, time: "19:00", party: 2, source: "online", confirmed: true },
      { key: 10, time: "19:15", party: 4, source: "phone", confirmed: true, occasion: "anniversary", request: 7 },
      { key: 11, time: "19:30", party: 6, source: "phone", request: 3 },
      { key: 12, time: "19:30", party: 2, source: "app", occasion: "date_night" },
      { key: 13, time: "19:45", party: 3, source: "walk_in", confirmed: true },
      { key: 14, time: "20:00", party: 8, source: "phone", confirmed: true, occasion: "birthday", request: 1, note: 2 },
      { key: 15, time: "20:00", party: 4, source: "online" },
      { key: 16, time: "20:15", party: 2, source: "phone", confirmed: true, request: 5 },
      { key: 17, time: "20:30", party: 5, source: "app", occasion: "business", request: 6, note: 4 },
      { key: 18, time: "20:30", party: 10, source: "phone", occasion: "birthday", unassigned: true, note: 1 },
      { key: 19, time: "21:00", party: 4, source: "online", cancelled: true },
      { key: 20, time: "21:00", party: 2, source: "phone" },
      { key: 21, time: "21:30", party: 3, source: "app", request: 8 },
    ];

    for (const item of plan) {
      const start = toMinutes(item.time);

      if (start < todayHours.open || start > todayHours.last) {
        continue;
      }

      // One guest per plan line, the same on every run; the anniversary couple
      // at 7:15 is a guest-book regular on the demo.
      const guest = guestAt(item.key === 10 ? GUESTS.length - 4 : item.key * 7 + 3);

      if (await exists(today, guest.guestMobile)) {
        counts.skipped += 1;
        continue;
      }

      const duration = durationFor(item.party);
      const finished = start + duration <= now;
      let status = "booked";

      if (item.cancelled) {
        status = "cancelled";
      } else if (finished) {
        status = item.key === 3 ? "no_show" : "completed";
      } else if (item.confirmed || start <= now) {
        status = "confirmed";
      }

      const rng = rngFor(`today-${today}-${item.key}`);
      // A party seated now keeps the table from now for its full length, so
      // the window checked is the later of the booked one and the real one.
      const holds = item.seatNow ? Math.max(duration, now + duration - start) : duration;
      const table = item.unassigned
        ? null
        : pickTable(today, start, holds, item.party, rng, {
            avoidBusy: start <= now + 30 && !finished,
          });

      if (!table && !item.unassigned) {
        continue;
      }

      if (table && status !== "cancelled") {
        reserve(today, table, start, holds);
      }

      const id = await insert({
        ...guest,
        date: today,
        startTime: item.time,
        partySize: item.party,
        durationMinutes: duration,
        tableId: table ? table.id : null,
        occasion: item.occasion || null,
        specialRequests: item.request === undefined ? null : REQUESTS[item.request],
        internalNotes: item.note === undefined ? null : NOTES[item.note],
        source: item.source,
        status,
        cancelReason: status === "cancelled" ? CANCEL_REASONS[0] : null,
        confirmedAt: status === "confirmed" || status === "completed" ? -300 : null,
        bookedAhead: 60 * (3 + ((item.key * 13) % 48)),
      });
      counts.today += 1;

      // Seated through the real path, then given the dishes they ordered, so
      // the floor plan and the POS show a table that is genuinely eating.
      if (item.seatNow && !finished && table) {
        try {
          const { order } = await reservationService.seat(restaurantId, id, { tableId: table.id }, userId, null);
          busyNow.add(table.id);

          const dishes = (
            await pool.query(
              `SELECT id FROM products
               WHERE restaurant_id = $1 AND status = 'active' AND is_available AND price > 0
                 AND name !~ '[0-9]'
               ORDER BY id LIMIT 12`,
              [restaurantId]
            )
          ).rows;

          if (dishes.length > 0) {
            const picked = [...new Set([0, 1, 2].map(() => Number(pick(rng, dishes).id)))];

            await orderService.updateItems(
              restaurantId,
              order.id,
              {
                customerId: order.customerId,
                customerName: order.customerName,
                customerMobile: order.customerMobile,
                guestCount: order.guestCount,
                notes: order.notes,
                items: picked.map((productId, index) => ({
                  productId,
                  productVariantId: null,
                  modifierIds: [],
                  quantity: index === 0 ? 2 : 1,
                  notes: null,
                })),
              },
              userId
            );
          }

          // They sat down a few minutes after their booking time, not at the
          // moment the seed happened to run.
          await pool.query(
            `UPDATE reservations SET seated_at = ($3::timestamp AT TIME ZONE $4::text)
             WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, id, reservationService.stampAt(today, start + 5), timezone]
          );
          await pool.query(
            `UPDATE orders SET placed_at = ($3::timestamp AT TIME ZONE $4::text)
             WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, order.id, reservationService.stampAt(today, start + 5), timezone]
          );
          counts.seated += 1;
        } catch (error) {
          say(`  could not seat ${guest.guestName}: ${error.message}`);
        }
      }
    }

    // ---------------------------------------------------------- the door
    // The queue is always "now". A walk-in the seed left waiting on an
    // earlier run, and still waiting when it runs again, is moved up to the
    // moment of this run rather than left standing at the door all afternoon.
    for (const guest of DOOR) {
      if (now - guest.waited < todayHours.open) {
        continue;
      }

      const refreshed = await pool.query(
        `UPDATE waitlist_entries
         SET joined_at = NOW() - make_interval(mins => $4), notified_at = NULL
         WHERE restaurant_id = $1 AND guest_mobile = $2 AND guest_name = $3 AND status = 'waiting'
           AND joined_at < NOW() - make_interval(mins => $4 + 30)
         RETURNING id`,
        [restaurantId, guest.mobile, guest.name, guest.waited]
      );

      if (refreshed.rowCount > 0) {
        counts.refreshed += refreshed.rowCount;
        continue;
      }

      const already = await pool.query(
        `SELECT 1 FROM waitlist_entries
         WHERE restaurant_id = $1 AND guest_mobile = $2
           AND (status = 'waiting' OR (joined_at AT TIME ZONE $3::text)::date = $4::date)`,
        [restaurantId, guest.mobile, timezone, today]
      );

      if (already.rows.length > 0) {
        counts.skipped += 1;
        continue;
      }

      await pool.query(
        `INSERT INTO waitlist_entries
           (restaurant_id, guest_name, guest_mobile, party_size, quoted_minutes, notes, joined_at,
            created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - make_interval(mins => $7), $8, $8)`,
        [restaurantId, guest.name, guest.mobile, guest.party, guest.quoted, guest.notes, guest.waited, userId]
      );
      counts.waitlist += 1;
    }

    // Earlier walk-ins, already dealt with, so today's average wait is real.
    for (const guest of EARLIER) {
      if (now - guest.ago < todayHours.open) {
        continue;
      }

      const already = await pool.query(
        `SELECT 1 FROM waitlist_entries
         WHERE restaurant_id = $1 AND guest_mobile = $2 AND (joined_at AT TIME ZONE $3::text)::date = $4::date`,
        [restaurantId, guest.mobile, timezone, today]
      );

      if (already.rows.length > 0) {
        continue;
      }

      const table = guest.status === "seated" ? tables[guest.table % tables.length] : null;

      await pool.query(
        `INSERT INTO waitlist_entries
           (restaurant_id, guest_name, guest_mobile, party_size, quoted_minutes, status, joined_at,
            resolved_at, table_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 15, $5, NOW() - make_interval(mins => $6),
                 NOW() - make_interval(mins => $6) + make_interval(mins => $7), $8, $9, $9)`,
        [
          restaurantId,
          guest.name,
          guest.mobile,
          guest.party,
          guest.status,
          guest.ago,
          guest.waited,
          table ? table.id : null,
          userId,
        ]
      );
      counts.waitlist += 1;
    }
  }

  // ------------------------------------------------------------ tomorrow
  const tomorrow = addDays(today, 1);
  const tomorrowHours = hoursFor(tomorrow);

  if (tomorrowHours) {
    await loadDay(tomorrow);

    const slots = ["12:30", "13:00", "13:30", "19:00", "19:30", "19:30", "20:00", "20:00", "20:15", "20:30", "21:00", "21:15", "21:30"];

    for (let index = 0; index < slots.length; index += 1) {
      const rng = rngFor(`tomorrow-${tomorrow}-${index}`);
      const start = toMinutes(slots[index]);
      const { guestName, guestMobile, customerId } = guestAt(index * 7 + 5);

      if (start < tomorrowHours.open || start > tomorrowHours.last) {
        continue;
      }

      if (await exists(tomorrow, guestMobile)) {
        counts.skipped += 1;
        continue;
      }

      const party = index === 6 ? 10 : index === 9 ? 8 : partyFor(rng);
      const duration = durationFor(party);
      // The party of ten is booked into a cabin for eight, with chairs added,
      // which the host agreed to on the phone.
      const override = party > 8;
      const table = override
        ? tables.filter((t) => t.capacity >= 8).find((t) =>
            !taken.get(tomorrow).some((w) => w.tableId === t.id && w.start < start + duration && w.end > start)
          ) || null
        : pickTable(tomorrow, start, duration, party, rng);
      const status = index === 11 ? "cancelled" : rng() < 0.4 ? "confirmed" : "booked";

      if (table && status !== "cancelled") {
        reserve(tomorrow, table, start, duration);
      }

      await insert({
        guestName,
        guestMobile,
        customerId,
        date: tomorrow,
        startTime: slots[index],
        partySize: party,
        durationMinutes: duration,
        tableId: table ? table.id : null,
        overrideCapacity: Boolean(table) && override,
        occasion: index === 6 ? "birthday" : occasionFor(rng),
        specialRequests: index === 6 ? "Surprise party — please dim the lights at 9 for the cake" : rng() < 0.3 ? pick(rng, REQUESTS) : null,
        internalNotes: index === 6 ? "Extra chairs agreed on the phone; advance of ₹2,000 paid by UPI" : null,
        source: sourceFor(rng),
        status,
        cancelReason: status === "cancelled" ? pick(rng, CANCEL_REASONS) : null,
        confirmedAt: status === "confirmed" ? -1200 : null,
        bookedAhead: 60 * (26 + index * 5),
      });
      counts.tomorrow += 1;
    }
  }

  say(`Reservations seeded for ${restaurant.rows[0].name} (${today}, ${timezone})`);
  say(`  history      ${counts.history} bookings over ${HISTORY_DAYS} days`);
  say(`  today        ${counts.today} bookings, ${counts.seated} seated through the POS`);
  say(`  tomorrow     ${counts.tomorrow} bookings`);
  say(`  waitlist     ${counts.waitlist} walk-ins`);
  say(`  brought up to now: ${counts.caughtUp} past bookings closed, ${counts.refreshed} waiting walk-ins moved to now`);
  say(`  already there, left alone: ${counts.skipped}`);
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
