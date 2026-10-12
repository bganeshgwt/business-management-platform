#!/usr/bin/env node
//
// Sets up the access features on the demo restaurant (the first one):
//
//   1. Personal PINs — the owner, a manager and a cashier who have none get
//      one, printed below, so the manager-approval prompt and the till lock
//      screen can be demonstrated straight away. A PIN someone already chose
//      is never replaced.
//   2. Payroll money for this month — an advance, a deduction and a bonus
//      against three staff, so the payroll screen shows the whole flow. Added
//      only if that exact entry is not there already.
//   3. The pay policy and the till lock are left at their defaults (week offs
//      and leave paid; tills never lock by themselves) unless already set.
//
//   node scripts/seed-access.js
//
// Safe to run again: nothing is added twice and nothing is deleted.
require("dotenv").config({ quiet: true });

const bcrypt = require("bcrypt");
const pool = require("../src/config/database");

const say = (message) => console.log(message);

// Easy to type on a keypad, and none of them a run or a repeat.
const DEMO_PINS = { RESTAURANT_ADMIN: "7391", MANAGER: "4826", CASHIER: "2468" };

const firstOfMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-CA");
};

const dayOfMonth = (day) => {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), Math.min(day, now.getDate()));
  return date.toLocaleDateString("en-CA");
};

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant found; nothing to do.");
    return;
  }

  say(`Access demo for ${restaurant.name} (id ${restaurant.id})`);

  // 1. PINs
  for (const [roleCode, pin] of Object.entries(DEMO_PINS)) {
    const person = (
      await pool.query(
        `SELECT u.id, u.name, u.pin_hash
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id AND r.code = $2
         WHERE u.restaurant_id = $1 AND u.status = 'active'
         ORDER BY (u.pin_hash IS NOT NULL) DESC, u.id
         LIMIT 1`,
        [restaurant.id, roleCode]
      )
    ).rows[0];

    if (!person) {
      say(`  no active ${roleCode.toLowerCase()} — skipped`);
    } else if (person.pin_hash) {
      say(`  ${person.name} (${roleCode.toLowerCase()}) already has a PIN — kept`);
    } else {
      await pool.query(
        "UPDATE users SET pin_hash = $2, pin_set_at = NOW(), pin_failed_count = 0, pin_locked_until = NULL WHERE id = $1",
        [person.id, await bcrypt.hash(pin, 10)]
      );
      say(`  ${person.name} (${roleCode.toLowerCase()}): PIN ${pin}`);
    }
  }

  // 2. Payroll money this month
  const staff = (
    await pool.query(
      `SELECT id, name FROM employees
       WHERE restaurant_id = $1 AND status = 'active' AND salary_type = 'monthly'
       ORDER BY salary_amount DESC, id
       LIMIT 3`,
      [restaurant.id]
    )
  ).rows;
  const owner = (
    await pool.query(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id AND r.code = 'RESTAURANT_ADMIN'
       WHERE u.restaurant_id = $1 ORDER BY u.id LIMIT 1`,
      [restaurant.id]
    )
  ).rows[0];

  const entries = [
    { kind: "advance", amount: 3000, day: 5, note: "Advance for house rent" },
    { kind: "deduction", amount: 450, day: 9, note: "Broken glassware (3 pint glasses)" },
    { kind: "bonus", amount: 1000, day: 14, note: "Weekend sales incentive" },
  ];

  for (const [index, entry] of entries.entries()) {
    const person = staff[index];

    if (!person) {
      continue;
    }

    const date = dayOfMonth(entry.day);
    const exists = await pool.query(
      `SELECT 1 FROM payroll_adjustments
       WHERE restaurant_id = $1 AND employee_id = $2 AND kind = $3 AND note = $4 AND adjustment_date >= $5::date`,
      [restaurant.id, person.id, entry.kind, entry.note, firstOfMonth()]
    );
    const paid = await pool.query(
      "SELECT 1 FROM payroll_payments WHERE employee_id = $1 AND $2::date BETWEEN period_from AND period_to",
      [person.id, date]
    );

    if (exists.rows.length > 0 || paid.rows.length > 0) {
      say(`  ${entry.kind} for ${person.name} — already there`);
      continue;
    }

    await pool.query(
      `INSERT INTO payroll_adjustments (restaurant_id, employee_id, adjustment_date, kind, amount, note, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [restaurant.id, person.id, date, entry.kind, entry.amount, entry.note, owner ? owner.id : null]
    );
    say(`  ${entry.kind} of Rs ${entry.amount} for ${person.name} on ${date}`);
  }

  // 3. Defaults, made explicit so the settings screens have a row to show.
  await pool.query(
    `INSERT INTO payroll_settings (restaurant_id) VALUES ($1) ON CONFLICT (restaurant_id) DO NOTHING`,
    [restaurant.id]
  );
  await pool.query(
    `INSERT INTO restaurant_access_settings (restaurant_id) VALUES ($1) ON CONFLICT (restaurant_id) DO NOTHING`,
    [restaurant.id]
  );

  say("Done.");
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
