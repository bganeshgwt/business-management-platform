#!/usr/bin/env node
//
// Sets up the staff time clock for the demo restaurant:
//
//   1. Shifts — uses the restaurant's own (earliest start = the day shift,
//      latest = the evening shift); creates Morning and Evening if it has none.
//   2. A full brigade — a busy Indian restaurant runs on 14 or more people, so
//      if the staff list is shorter it is topped up with a tandoor chef, a
//      captain, a bartender, a dishwasher and so on.
//   3. PINs — one per employee who has none, printed below so the demo can
//      be driven at the tablet.
//   4. The roster — the last 30 days and the coming week, where missing: fixed
//      shifts per person, one weekday off each (never Friday to Sunday), and
//      the odd day of leave.
//   5. 30 days of punches — clock-ins mostly a few minutes early, some late,
//      a few no-shows, breaks around the middle of the shift (now and then a
//      long one), and overtime on busy Friday-to-Sunday nights. Each day's
//      attendance row is worked out from its punches by the same code the
//      kiosk uses, so the attendance sheet and payroll agree with the clock.
//   6. Today, live — whoever's shift is running is clocked in, one is on a
//      break, one is late and not in yet, one from a shift that has ended is
//      still on the clock, and the later shift is still to arrive. (What that
//      looks like depends on the hour it is run at: at 7 am nobody's shift
//      has started yet.)
//
//   node scripts/seed-timeclock.js
//
// Safe to run again: roster days, punches and attendance are only added where
// a person has none for that day, PINs only where a person has none, and
// nothing is ever deleted.
require("dotenv").config({ quiet: true });

const bcrypt = require("bcrypt");
const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const timeclock = require("../src/modules/restaurant/staff/services/timeclock.service");

const say = (message) => console.log(message);

const BRIGADE_SIZE = 14;
const HISTORY_DAYS = 30;
const ROSTER_AHEAD_DAYS = 6;

// Code, name, designation, department, monthly salary, mobile.
const EXTRA_STAFF = [
  ["EMP101", "Venkatesh Goud", "Tandoor Chef", "kitchen", 26000, "9848011101"],
  ["EMP102", "Anjali Reddy", "Captain", "service", 21000, "9848011102"],
  ["EMP103", "Imran Shaikh", "Chinese Cook", "kitchen", 22000, "9848011103"],
  ["EMP104", "Pooja Verma", "Hostess", "service", 18000, "9848011104"],
  ["EMP105", "Harish Chandra", "Bartender", "service", 20000, "9848011105"],
  ["EMP106", "Swathi Kumari", "Commis Chef", "kitchen", 16000, "9848011106"],
  ["EMP107", "Raju Naik", "Dishwasher", "housekeeping", 12500, "9848011107"],
  ["EMP108", "Deepika Nair", "Cashier", "service", 19000, "9848011108"],
  ["EMP109", "Naveen Babu", "Steward", "service", 15000, "9848011109"],
  ["EMP110", "Bhaskar Rao", "Store Keeper", "other", 17000, "9848011110"],
];

// --- deterministic randomness ---------------------------------------------
//
// Seeded by person and date, so the same day always gets the same story and a
// second run could never contradict the first.
const seeded = (text) => {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  let state = hash >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const between = (random, low, high) => low + Math.floor(random() * (high - low + 1));
const plusMinutes = (instant, minutes) => new Date(instant.getTime() + minutes * 60000);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

// A PIN nobody would guess but the demo can print: from the employee id,
// skipping anything the kiosk would refuse as too easy.
const demoPin = (employee) => {
  let value = 1000 + ((Number(employee.id) * 7919 + 2963) % 9000);
  const mobile = String(employee.mobile || "").replace(/\D/g, "");

  while (timeclock.isWeakPin(String(value)) || (mobile && mobile.endsWith(String(value)))) {
    value = value >= 9999 ? 1000 : value + 1;
  }

  return String(value);
};

// --- one day of punches ------------------------------------------------------

// The punches a person makes on one shift, as a real kitchen sees them. Only
// punches up to `now` are kept, so a shift still running stays open.
const planDay = ({ employee, date, window, now, role }) => {
  const random = seeded(`${employee.id}|${date}`);
  const busyNight = [0, 5, 6].includes(weekday(date));
  const punches = [];

  let clockIn;
  const arrival = random();

  if (role === "arrived-late" || arrival < 0.14) {
    clockIn = plusMinutes(window.startsAt, between(random, window.graceMinutes + 3, window.graceMinutes + 35));
  } else if (arrival < 0.32) {
    clockIn = plusMinutes(window.startsAt, between(random, 0, Math.max(0, window.graceMinutes - 1)));
  } else {
    clockIn = plusMinutes(window.startsAt, -between(random, 3, 18));
  }

  punches.push(["clock_in", clockIn]);

  const shiftLength = (window.endsAt - window.startsAt) / 60000;

  if (role === "on-break") {
    // On a break that started a quarter of an hour ago.
    const breakStart = plusMinutes(now, -between(random, 12, 22));

    if (breakStart > plusMinutes(clockIn, 45)) {
      punches.push(["break_start", breakStart]);
    }
  } else if (window.breakMinutes > 0 && random() < 0.9) {
    const breakStart = plusMinutes(
      window.startsAt,
      Math.round(shiftLength * (0.42 + random() * 0.14))
    );
    const long = random() < 0.06;
    const length = long ? between(random, 55, 72) : window.breakMinutes + between(random, -8, 10);

    punches.push(["break_start", breakStart]);
    punches.push(["break_end", plusMinutes(breakStart, Math.max(10, length))]);
  }

  // "staying-on": the shift is over but they are still on the clock — kept
  // back for a large party, or gone home without clocking out. The board
  // flags it as past their shift end.
  if (role !== "on-break" && role !== "staying-on") {
    let clockOut;

    if (busyNight && random() < 0.6) {
      clockOut = plusMinutes(window.endsAt, between(random, 25, 105));
    } else {
      clockOut = plusMinutes(window.endsAt, between(random, -4, 12));
    }

    punches.push(["clock_out", clockOut]);
  }

  // Nothing after now: a shift still going has no clock-out yet, and a break
  // still going has no end.
  return punches.filter(([, at]) => at <= now);
};

const insertDay = async (client, restaurantId, employee, date, window, punches, userId, now) => {
  const rows = punches.map(([type, at], index) => ({ id: index + 1, punch_type: type, punched_at: at }));
  const summary = timeclock.summarise(rows, window, now);

  if (summary.invalid) {
    throw new Error(`planned an impossible day for ${employee.name} on ${date}`);
  }

  await client.query(
    `INSERT INTO attendance_punches (restaurant_id, employee_id, work_date, punch_type, punched_at,
                                     source, created_by, updated_by, created_at)
     SELECT $1, $2, $3, type, at, 'kiosk', $4, $4, at
     FROM UNNEST($5::text[], $6::timestamptz[]) AS p(type, at)`,
    [restaurantId, employee.id, date, userId, punches.map(([type]) => type), punches.map(([, at]) => at)]
  );

  await client.query(
    `INSERT INTO attendance (restaurant_id, employee_id, shift_id, attendance_date, check_in, check_out,
                             attendance_status, worked_minutes, break_minutes, late_minutes,
                             overtime_minutes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'present', $7, $8, $9, $10, $11, $11)
     ON CONFLICT (employee_id, attendance_date) DO NOTHING`,
    [
      restaurantId,
      employee.id,
      window.shiftId,
      date,
      summary.checkIn,
      summary.checkOut,
      summary.workedMinutes,
      summary.breakMinutes,
      summary.lateMinutes,
      summary.overtimeMinutes,
      userId,
    ]
  );

  return summary;
};

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant found — run the demo seed first.");
    return;
  }

  const restaurantId = restaurant.id;

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "staff_payroll")) {

    return;

  }
  const settings = (
    await pool.query("SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1", [restaurantId])
  ).rows[0];
  const timezone = timeclock.safeZone((settings && settings.timezone) || "Asia/Kolkata");
  const admin = (
    await pool.query(
      "SELECT id FROM users WHERE restaurant_id = $1 AND status = 'active' ORDER BY id LIMIT 1",
      [restaurantId]
    )
  ).rows[0];
  const userId = admin ? admin.id : null;
  const now = new Date();
  const today = timeclock.localDate(now, timezone);

  say(`Time clock for ${restaurant.name} (${timezone}), ${today} ${timeclock.timeLabel(now, timezone)}`);

  // ---- 1. Shifts
  let shifts = (
    await pool.query(
      `SELECT id, name, start_time, end_time, break_minutes, grace_minutes
       FROM shifts WHERE restaurant_id = $1 AND status = 'active' ORDER BY start_time`,
      [restaurantId]
    )
  ).rows;

  if (shifts.length === 0) {
    await pool.query(
      `INSERT INTO shifts (restaurant_id, name, start_time, end_time, break_minutes, grace_minutes,
                           created_by, updated_by)
       VALUES ($1, 'Morning', '10:00', '18:00', 45, 10, $2, $2),
              ($1, 'Evening', '16:00', '00:00', 45, 10, $2, $2)
       ON CONFLICT DO NOTHING`,
      [restaurantId, userId]
    );

    shifts = (
      await pool.query(
        `SELECT id, name, start_time, end_time, break_minutes, grace_minutes
         FROM shifts WHERE restaurant_id = $1 AND status = 'active' ORDER BY start_time`,
        [restaurantId]
      )
    ).rows;
    say("  shifts · created Morning 10:00–18:00 and Evening 16:00–00:00");
  }

  const dayShift = shifts[0];
  const nightShift = shifts[shifts.length - 1];

  say(
    `  shifts · day = ${dayShift.name} ${String(dayShift.start_time).slice(0, 5)}–${String(dayShift.end_time).slice(0, 5)}, ` +
      `evening = ${nightShift.name} ${String(nightShift.start_time).slice(0, 5)}–${String(nightShift.end_time).slice(0, 5)}`
  );

  // ---- 2. A full brigade
  const activeCount = Number(
    (
      await pool.query("SELECT COUNT(*) AS count FROM employees WHERE restaurant_id = $1 AND status = 'active'", [
        restaurantId,
      ])
    ).rows[0].count
  );
  let added = 0;

  for (const [code, name, designation, department, salary, mobile] of EXTRA_STAFF) {
    if (activeCount + added >= BRIGADE_SIZE) {
      break;
    }

    const inserted = await pool.query(
      `INSERT INTO employees (restaurant_id, employee_code, name, mobile, designation, department,
                              employment_type, salary_type, salary_amount, date_of_joining,
                              status, created_by, updated_by)
       SELECT $1, $2::varchar, $3::varchar, $4, $5, $6, 'full_time', 'monthly', $7, '2025-04-01', 'active', $8, $8
       WHERE NOT EXISTS (SELECT 1 FROM employees
                         WHERE restaurant_id = $1
                           AND (UPPER(employee_code) = UPPER($2::varchar) OR LOWER(name) = LOWER($3::varchar)))
       RETURNING id`,
      [restaurantId, code, name, mobile, designation, department, salary, userId]
    );

    added += inserted.rowCount;
  }

  say(`  staff · ${activeCount} active${added ? `, ${added} added to make a full brigade` : ""}`);

  const employees = (
    await pool.query(
      `SELECT id, employee_code, name, designation, department, mobile, date_of_joining, pin_hash
       FROM employees WHERE restaurant_id = $1 AND status = 'active' ORDER BY id`,
      [restaurantId]
    )
  ).rows;

  // ---- 3. PINs
  const pinLines = [];
  let pinsSet = 0;

  for (const employee of employees) {
    const pin = demoPin(employee);

    if (!employee.pin_hash) {
      await pool.query(
        `UPDATE employees SET pin_hash = $3, pin_set_at = NOW(), pin_failed_attempts = 0,
                              pin_first_failed_at = NULL, pin_locked_until = NULL
         WHERE restaurant_id = $1 AND id = $2`,
        [restaurantId, employee.id, await bcrypt.hash(pin, 10)]
      );
      pinsSet += 1;
      pinLines.push([employee, pin]);
    } else if (await bcrypt.compare(pin, employee.pin_hash)) {
      pinLines.push([employee, pin]);
    } else {
      pinLines.push([employee, "(changed by a manager)"]);
    }
  }

  say(`  PINs · ${pinsSet} set now, ${employees.length - pinsSet} already had one`);

  // ---- 4. The roster
  const from = timeclock.addDays(today, -HISTORY_DAYS);
  const until = timeclock.addDays(today, ROSTER_AHEAD_DAYS);
  let rosterAdded = 0;

  for (const [index, employee] of employees.entries()) {
    // Fixed shifts, as most kitchens run them: the bar on evenings,
    // housekeeping, stores and management on days, everyone else (riders
    // included — deliveries peak at lunch as well as dinner) alternating.
    let shift = index % 2 === 0 ? dayShift : nightShift;

    if (/bar/i.test(employee.designation || "")) {
      shift = nightShift;
    } else if (["housekeeping", "management", "other"].includes(employee.department)) {
      shift = dayShift;
    }

    // One weekday off each, Monday to Thursday: nobody is off on a Friday,
    // Saturday or Sunday night in a restaurant.
    const dayOff = 1 + (index % 4);
    const joined = employee.date_of_joining;

    const rows = [];

    for (let date = from; date <= until; date = timeclock.addDays(date, 1)) {
      if (joined && date < joined) {
        continue;
      }

      const random = seeded(`leave|${employee.id}|${date}`);
      let status = "scheduled";

      if (weekday(date) === dayOff) {
        status = "week_off";
      } else if (date !== today && random() < 0.03) {
        status = "leave";
      }

      rows.push([date, status, status === "scheduled" ? shift.id : null]);
    }

    const result = await pool.query(
      `INSERT INTO shift_assignments (restaurant_id, employee_id, shift_id, work_date, assignment_status,
                                      created_by, updated_by)
       SELECT $1, $2, shift_id, work_date, status, $3, $3
       FROM UNNEST($4::date[], $5::text[], $6::bigint[]) AS r(work_date, status, shift_id)
       ON CONFLICT (employee_id, work_date) DO NOTHING`,
      [
        restaurantId,
        employee.id,
        userId,
        rows.map((row) => row[0]),
        rows.map((row) => row[1]),
        rows.map((row) => row[2]),
      ]
    );

    rosterAdded += result.rowCount;
  }

  say(`  roster · ${rosterAdded} days added (${from} to ${until})`);

  // ---- 5 and 6. Punches and attendance, history then today
  const roster = (
    await pool.query(
      `SELECT a.employee_id, a.work_date, a.assignment_status, a.shift_id,
              s.name AS shift_name, s.start_time, s.end_time, s.break_minutes, s.grace_minutes
       FROM shift_assignments a
       LEFT JOIN shifts s ON s.id = a.shift_id
       WHERE a.restaurant_id = $1 AND a.work_date BETWEEN $2::date AND $3::date`,
      [restaurantId, from, today]
    )
  ).rows;
  const taken = new Set(
    (
      await pool.query(
        `SELECT employee_id, attendance_date AS work_date FROM attendance
         WHERE restaurant_id = $1 AND attendance_date BETWEEN $2::date AND $3::date
         UNION
         SELECT employee_id, work_date FROM attendance_punches
         WHERE restaurant_id = $1 AND work_date BETWEEN $2::date AND $3::date`,
        [restaurantId, from, today]
      )
    ).rows.map((row) => `${row.employee_id}|${row.work_date}`)
  );
  const byId = new Map(employees.map((employee) => [employee.id, employee]));

  const client = await pool.connect();
  const tally = { days: 0, late: 0, absent: 0, overtime: 0, off: 0, punches: 0 };
  const live = [];

  try {
    await client.query("BEGIN");

    // Today's running shifts are handed out in a fixed order so the board
    // always shows one person late and one on a break.
    const todayRunning = [];

    for (const row of roster.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.employee_id - b.employee_id)) {
      const employee = byId.get(row.employee_id);

      if (!employee || taken.has(`${row.employee_id}|${row.work_date}`)) {
        continue;
      }

      const window = timeclock.shiftWindow(row.work_date, row, timezone);

      if (row.work_date < today) {
        if (!window) {
          // A week off or leave still goes on the attendance sheet, so the
          // payroll summary counts it.
          await client.query(
            `INSERT INTO attendance (restaurant_id, employee_id, attendance_date, attendance_status,
                                     created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $5)
             ON CONFLICT (employee_id, attendance_date) DO NOTHING`,
            [restaurantId, employee.id, row.work_date, row.assignment_status, userId]
          );
          tally.off += 1;
          continue;
        }

        // A few no-shows a month across the team.
        if (seeded(`absent|${employee.id}|${row.work_date}`)() < 0.035) {
          await client.query(
            `INSERT INTO attendance (restaurant_id, employee_id, shift_id, attendance_date,
                                     attendance_status, notes, created_by, updated_by)
             VALUES ($1, $2, $3, $4, 'absent', 'Did not come in, no call', $5, $5)
             ON CONFLICT (employee_id, attendance_date) DO NOTHING`,
            [restaurantId, employee.id, window.shiftId, row.work_date, userId]
          );
          tally.absent += 1;
          continue;
        }

        const punches = planDay({ employee, date: row.work_date, window, now, role: null });

        if (punches.length === 0) {
          continue;
        }

        const summary = await insertDay(client, restaurantId, employee, row.work_date, window, punches, userId, now);

        tally.days += 1;
        tally.punches += punches.length;
        tally.late += summary.lateMinutes > 0 ? 1 : 0;
        tally.overtime += summary.overtimeMinutes > 0 ? 1 : 0;
        continue;
      }

      // Today.
      if (!window || now < window.startsAt) {
        continue;
      }

      todayRunning.push({ employee, window });
    }

    let lateGiven = false;
    let breakGiven = false;
    let lateArrivalGiven = false;
    let stayingOnGiven = false;

    for (const { employee, window } of todayRunning) {
      const shiftOver = now >= window.endsAt;
      const lateEnough = now >= plusMinutes(window.startsAt, window.graceMinutes + 5);
      let role = null;

      if (!shiftOver && lateEnough && !lateGiven) {
        lateGiven = true;
        live.push(`${employee.name} — ${window.shiftName} started ${timeclock.timeLabel(window.startsAt, timezone)}, not in yet (late)`);
        continue;
      }

      // One person from a shift that has ended (within the last six hours)
      // is still on the clock.
      if (shiftOver && !stayingOnGiven && now < plusMinutes(window.endsAt, 6 * 60)) {
        role = "staying-on";
        stayingOnGiven = true;
      } else if (!shiftOver && !breakGiven && now >= plusMinutes(window.startsAt, 90)) {
        role = "on-break";
        breakGiven = true;
      } else if (!shiftOver && !lateArrivalGiven && now >= plusMinutes(window.startsAt, window.graceMinutes + 40)) {
        role = "arrived-late";
        lateArrivalGiven = true;
      }

      const punches = planDay({ employee, date: today, window, now, role });

      if (punches.length === 0) {
        continue;
      }

      const summary = await insertDay(client, restaurantId, employee, today, window, punches, userId, now);
      tally.punches += punches.length;

      const state = summary.state === "break" ? "on a break" : summary.state === "in" ? "on duty" : "clocked out";
      live.push(
        `${employee.name} — ${state} since ${timeclock.timeLabel(
          summary.state === "break" ? summary.breakStartedAt : summary.state === "in" ? summary.checkIn : summary.checkOut,
          timezone
        )}${summary.lateMinutes > 0 ? ` (${summary.lateMinutes} min late)` : ""}${
          role === "staying-on" ? `, still in after the ${window.shiftName} shift ended` : ""
        }`
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  say(
    `  history · ${tally.days} worked days, ${tally.late} late arrivals, ${tally.absent} no-shows, ` +
      `${tally.overtime} days with overtime, ${tally.off} week-offs and leave, ${tally.punches} punches in all`
  );

  const expected = roster.filter(
    (row) =>
      row.work_date === today &&
      row.assignment_status === "scheduled" &&
      timeclock.shiftWindow(today, row, timezone) &&
      now < timeclock.shiftWindow(today, row, timezone).startsAt
  );

  say(`  today · ${live.length ? "" : "no shift has started yet, so nobody is in"}`);

  for (const line of live) {
    say(`      ${line}`);
  }

  if (expected.length) {
    say(`      + ${expected.length} still to arrive for later shifts`);
  }

  say("\n  Demo PINs (type these at Staff › Time clock):");
  say(`      ${"Code".padEnd(8)} ${"Name".padEnd(20)} ${"Role".padEnd(18)} PIN`);

  for (const [employee, pin] of pinLines) {
    say(
      `      ${String(employee.employee_code || "—").padEnd(8)} ${employee.name.padEnd(20)} ${String(
        employee.designation || employee.department
      ).padEnd(18)} ${pin}`
    );
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
