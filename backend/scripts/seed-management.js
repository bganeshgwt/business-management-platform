#!/usr/bin/env node
//
// What the owner's reports need to look like a real restaurant's: three
// months of running expenses (rent, power, gas, staff meals, repairs...), a
// handful of company guests with a GSTIN on their bills, and the
// restaurant's own GSTIN if none is set — so the P&L, the expense report, the
// GST filing pack and the day book open on realistic figures rather than
// zeroes.
//
//   node scripts/seed-management.js            (DB_NAME from .env)
//   DB_NAME=restaurant_management_test node scripts/seed-management.js
//
// Safe to run again: every expense it writes is marked, and an expense for
// the same category and date is never written twice; a bill that already has
// a buyer's GSTIN is left alone. It never deletes anything.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { gstinCheckCharacter } = require("../src/utils/gstin");

const MARK = "Monthly running cost";
const RESTAURANT_CODE = process.env.SEED_RESTAURANT_CODE || null;

// A GSTIN with a correct check character, from a state code and a PAN.
const gstin = (state, pan, entity = "1") => {
  const first14 = `${state}${pan}${entity}Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};

const CATEGORIES = [
  "Rent",
  "Electricity",
  "Gas (LPG)",
  "Water",
  "Staff meals",
  "Repairs & maintenance",
  "Housekeeping & cleaning",
  "Marketing",
  "Packaging",
  "Internet & phone",
  "Licences & fees",
  "Transport",
];

// Company guests who ask for a GST invoice: offices nearby, a builder, a
// hospital's canteen account. Fictional names, valid-looking numbers.
const COMPANY_GUESTS = [
  { name: "Konaseema Agro Exports Pvt Ltd", gstin: gstin("37", "AAGCK4821M") },
  { name: "Godavari Coastal Constructions", gstin: gstin("37", "AAIFG7310P") },
  { name: "Sri Sai Pharma Distributors LLP", gstin: gstin("37", "ACSFS2285Q") },
  { name: "Deccan Textile Traders", gstin: gstin("36", "AAHPD6621K") },
  { name: "Riverside Software Services Pvt Ltd", gstin: gstin("37", "AAKCR9034L") },
];

const RESTAURANT_GSTIN = gstin("37", "AAFCF5170R");

const iso = (date) => date.toISOString().slice(0, 10);

const addDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

// A little day-to-day wobble, the same every run for the same date so the
// seed is repeatable.
const wobble = (seed, spread) => {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return (x - Math.floor(x) - 0.5) * 2 * spread;
};

const round = (value, to = 10) => Math.max(to, Math.round(value / to) * to);

// Every running cost of the period, one entry per payment the way a manager
// would record it.
const expensesFor = (start, end) => {
  const rows = [];

  for (let day = new Date(start); day <= end; day = addDays(day, 1)) {
    const date = iso(day);
    const dom = day.getUTCDate();
    const dow = day.getUTCDay();
    const seed = Number(date.replace(/-/g, ""));

    if (dom === 1) {
      rows.push({ category: "Rent", date, amount: 85000, mode: "bank", note: "Shop rent, ground floor + kitchen" });
      rows.push({ category: "Internet & phone", date, amount: 1649, mode: "upi", note: "Broadband + 2 phone lines" });
    }

    if (dom === 5) {
      rows.push({
        category: "Electricity",
        date,
        amount: round(34000 + wobble(seed, 4500), 1),
        mode: "bank",
        note: "APEPDCL bill, commercial meter",
      });
      rows.push({ category: "Water", date, amount: round(2400 + wobble(seed, 400)), mode: "upi", note: "Water tanker + municipal" });
    }

    if (dom === 10) {
      rows.push({ category: "Marketing", date, amount: 6500, mode: "upi", note: "Instagram promotion + pamphlets" });
    }

    if (dom === 15) {
      rows.push({ category: "Repairs & maintenance", date, amount: round(3800 + wobble(seed, 2200)), mode: "cash", note: "Fridge gasket, burner service" });
    }

    if (dom === 20 && day.getUTCMonth() % 3 === 0) {
      rows.push({ category: "Licences & fees", date, amount: 4500, mode: "bank", note: "FSSAI renewal / trade licence" });
    }

    // Two 19 kg commercial cylinders most days, three at the weekend.
    rows.push({
      category: "Gas (LPG)",
      date,
      amount: (dow === 0 || dow === 6 ? 3 : 2) * 1850,
      mode: "cash",
      note: "19 kg commercial cylinders",
    });

    // Staff meals: rice, dal and vegetables for the team, bought daily.
    rows.push({ category: "Staff meals", date, amount: round(900 + wobble(seed, 250)), mode: "cash", note: "Staff lunch and dinner" });

    if (dow === 1 || dow === 4) {
      rows.push({ category: "Packaging", date, amount: round(2600 + wobble(seed, 600)), mode: "upi", note: "Takeaway boxes, bags, foil" });
      rows.push({ category: "Housekeeping & cleaning", date, amount: round(750 + wobble(seed, 200)), mode: "cash", note: "Cleaning supplies" });
    }

    if (dow === 3) {
      rows.push({ category: "Transport", date, amount: round(600 + wobble(seed, 150)), mode: "cash", note: "Auto for market run" });
    }
  }

  return rows;
};

(async () => {
  const restaurant = (
    await pool.query(
      RESTAURANT_CODE
        ? "SELECT id, name FROM restaurants WHERE code = $1"
        : "SELECT id, name FROM restaurants ORDER BY id LIMIT 1",
      RESTAURANT_CODE ? [RESTAURANT_CODE] : []
    )
  ).rows[0];

  if (!restaurant) {
    throw new Error("No restaurant to seed");
  }

  const restaurantId = restaurant.id;
  const admin = (
    await pool.query("SELECT id FROM users WHERE restaurant_id = $1 ORDER BY id LIMIT 1", [restaurantId])
  ).rows[0];
  const userId = admin ? admin.id : null;

  // The day the restaurant is trading on, or today.
  const open = (
    await pool.query(
      "SELECT business_date::text AS d FROM business_days WHERE restaurant_id = $1 AND day_status = 'open' LIMIT 1",
      [restaurantId]
    )
  ).rows[0];
  const end = new Date(`${open ? open.d : new Date().toLocaleDateString("en-CA")}T00:00:00Z`);
  // Three whole months back, from the 1st.
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 3, 1));

  // --- Categories ------------------------------------------------------------
  const categoryIds = new Map();

  for (const name of CATEGORIES) {
    const row = (
      await pool.query(
        `INSERT INTO expense_categories (restaurant_id, name, description, status, created_by, updated_by)
         VALUES ($1, $2, $3, 'active', $4, $4)
         ON CONFLICT (restaurant_id, LOWER(name)) DO UPDATE SET name = expense_categories.name
         RETURNING id`,
        [restaurantId, name, `Running cost: ${name.toLowerCase()}`, userId]
      )
    ).rows[0];

    categoryIds.set(name, row.id);
  }

  // --- Expenses ----------------------------------------------------------------
  let added = 0;

  for (const expense of expensesFor(start, end)) {
    const categoryId = categoryIds.get(expense.category);
    const exists = await pool.query(
      `SELECT 1 FROM expenses
       WHERE restaurant_id = $1 AND expense_category_id = $2 AND expense_date = $3 AND notes LIKE $4
       LIMIT 1`,
      [restaurantId, categoryId, expense.date, `${MARK}%`]
    );

    if (exists.rows.length) {
      continue;
    }

    // Today's gas is still waiting for the manager to approve, like a real
    // morning; everything before it was approved on the day.
    const pending = expense.date === iso(end) && expense.category === "Gas (LPG)";

    await pool.query(
      `INSERT INTO expenses (restaurant_id, expense_category_id, expense_date, amount, payment_mode,
                             notes, expense_status, approved_by, approved_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        restaurantId,
        categoryId,
        expense.date,
        expense.amount,
        expense.mode,
        `${MARK} — ${expense.note}`,
        pending ? "pending" : "approved",
        pending ? null : userId,
        pending ? null : `${expense.date}T18:00:00+05:30`,
        userId,
      ]
    );
    added += 1;
  }

  // --- Company guests' GST invoices --------------------------------------------
  // The biggest dine-in bills of the last week, as a company lunch would be.
  const candidates = (
    await pool.query(
      `SELECT b.id
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE b.restaurant_id = $1 AND b.bill_status IN ('paid', 'partial', 'unpaid')
         AND o.order_type = 'dine_in'
         AND COALESCE(bd.business_date, b.billed_at::date) >= $2::date - 7
         AND NOT EXISTS (SELECT 1 FROM bill_gst_recipients r WHERE r.bill_id = b.id)
       ORDER BY b.total_amount DESC
       LIMIT $3`,
      [restaurantId, iso(end), COMPANY_GUESTS.length * 2]
    )
  ).rows;

  const already = (
    await pool.query("SELECT COUNT(*)::int AS n FROM bill_gst_recipients WHERE restaurant_id = $1", [restaurantId])
  ).rows[0].n;

  let tagged = 0;

  // A few, not many: B2B is a slice of a restaurant's trade.
  for (const [index, bill] of candidates.entries()) {
    if (already + tagged >= COMPANY_GUESTS.length * 2) {
      break;
    }

    const guest = COMPANY_GUESTS[index % COMPANY_GUESTS.length];

    await pool.query(
      `INSERT INTO bill_gst_recipients (restaurant_id, bill_id, gstin, legal_name, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (bill_id) DO NOTHING`,
      [restaurantId, bill.id, guest.gstin, guest.name, userId]
    );
    tagged += 1;
  }

  // --- The restaurant's own GSTIN, if it has none ---------------------------------
  const settings = await pool.query(
    `UPDATE restaurant_settings SET gst_number = $2
     WHERE restaurant_id = $1 AND (gst_number IS NULL OR gst_number = '')
     RETURNING gst_number`,
    [restaurantId, RESTAURANT_GSTIN]
  );

  console.log(
    `${restaurant.name}: ${CATEGORIES.length} expense categories, ${added} expenses added ` +
      `(${iso(start)} to ${iso(end)}), ${tagged} bills marked B2B` +
      (settings.rows.length ? `, GSTIN set to ${RESTAURANT_GSTIN}` : "")
  );

  await pool.end();
})().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
