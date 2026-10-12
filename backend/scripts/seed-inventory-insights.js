#!/usr/bin/env node
//
// Thirty days of kitchen wastage for the demo restaurant, so Waste & reorder
// opens on a month that looks like a real kitchen's rather than an empty page.
//
// What a real month looks like, and so what this writes:
//   - a few entries every day, more at the weekend when prep runs ahead of
//     covers — over-prepped rice and gravies, milk and curd past their date,
//     tomatoes gone soft, a tray dropped at the pass, a dish sent back;
//   - reasons weighted by what the item is: dairy spoils and expires, meat is
//     over-prepped and overcooked, bottles get dropped, vegetables rot — and
//     notes worded for that ingredient ("split in the chiller" for milk,
//     "gone soft in the veg rack" only for vegetables);
//   - two bad days: a chiller that failed overnight, and a wedding party that
//     cancelled after the biryani was on;
//   - logged by the people who log it: kitchen staff and managers, with the
//     owner stepping in now and then.
//
// Every entry goes through the same path as the Log wastage button
// (inventoryInsightRepository.insertWastage → inventoryRepository.recordMovement),
// so stock, the ledger and the per-outlet balances stay in step: the ledger
// still sums to current stock afterwards. Each entry carries the business day
// it belongs to; its ledger timestamp is the moment this script ran, the same
// way seed-demo.js stamps every movement it makes.
//
// It never takes an item below zero, and never writes off more than a quarter
// of what the main store held of an item when the script started, so the
// shelves the rest of the demo relies on stay stocked. It only uses items the restaurant already has
// (by the demo pantry's names) and never creates or deletes anything else.
//
//   node scripts/seed-inventory-insights.js
//   DB_NAME=restaurant_management_test node scripts/seed-inventory-insights.js
//
// Safe to run again: seeded entries are tagged, and a second run only fills
// the business days since the last one it wrote. The same day always gets the
// same entries.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const inventoryInsightRepository = require("../src/modules/restaurant/inventory/repositories/inventoryInsight.repository");
const { REASONS } = require("../src/modules/restaurant/inventory/services/inventoryInsight.service");

const DAYS = 30;
const SEED_TAG = "waste_seed";
// Of the stock an item had when this run started, the most it may write off.
const MAX_SHARE_OF_STOCK = 0.25;

const say = (message) => console.log(message);

// ---------------------------------------------------------------- randomness
// Seeded from the date, so a given day always comes out the same however
// often, or on whichever machine, the script runs.
const generatorFor = (text) => {
  let state = [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 2147483647, 7);

  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
};

const weighted = (random, entries) => {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;

  for (const [value, weight] of entries) {
    roll -= weight;

    if (roll <= 0) {
      return value;
    }
  }

  return entries[entries.length - 1][0];
};

// ---------------------------------------------------------------- dates
const addDays = (isoDate, days) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const weekday = (isoDate) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

// ---------------------------------------------------------------- the pantry
// How each demo ingredient tends to be wasted: how likely it is to turn up in
// the bin on a given day, how much goes at once (in kg, litres or pieces), and
// why. Weights, not rules — a real kitchen has every kind on every item now
// and then.
const REASONS_BY_KIND = {
  dairy: [["spoiled", 34], ["expired", 30], ["over_prepped", 16], ["returned", 10], ["other", 10]],
  meat: [["over_prepped", 30], ["overcooked", 26], ["returned", 18], ["spoiled", 14], ["dropped", 12]],
  vegetable: [["spoiled", 46], ["over_prepped", 30], ["dropped", 10], ["other", 14]],
  paste: [["spoiled", 50], ["expired", 30], ["over_prepped", 20]],
  grain: [["over_prepped", 58], ["overcooked", 20], ["dropped", 12], ["other", 10]],
  dry: [["dropped", 38], ["expired", 34], ["other", 28]],
  bottle: [["dropped", 62], ["expired", 28], ["returned", 10]],
};

const PANTRY = [
  { names: ["Chicken"], unit: "kg", kind: "meat", chance: 0.55, min: 0.25, max: 1.2 },
  { names: ["Paneer"], unit: "kg", kind: "dairy", chance: 0.45, min: 0.15, max: 0.8 },
  { names: ["Mutton"], unit: "kg", kind: "meat", chance: 0.22, min: 0.2, max: 0.7 },
  { names: ["Prawns"], unit: "kg", kind: "meat", chance: 0.16, min: 0.1, max: 0.45 },
  { names: ["Milk"], unit: "L", kind: "dairy", chance: 0.42, min: 0.5, max: 3 },
  { names: ["Curd"], unit: "kg", kind: "dairy", chance: 0.34, min: 0.25, max: 1.5 },
  { names: ["Fresh Cream", "Cream"], unit: "L", kind: "dairy", chance: 0.2, min: 0.1, max: 0.5 },
  { names: ["Butter"], unit: "kg", kind: "dairy", chance: 0.1, min: 0.05, max: 0.25 },
  { names: ["Tomato"], unit: "kg", kind: "vegetable", chance: 0.5, min: 0.5, max: 2.5 },
  { names: ["Onion"], unit: "kg", kind: "vegetable", chance: 0.34, min: 0.5, max: 2 },
  { names: ["Capsicum"], unit: "kg", kind: "vegetable", chance: 0.3, min: 0.2, max: 1 },
  { names: ["Green Chilli"], unit: "kg", kind: "vegetable", chance: 0.26, min: 0.1, max: 0.4 },
  { names: ["Potato"], unit: "kg", kind: "vegetable", chance: 0.14, min: 0.5, max: 2 },
  { names: ["Basmati Rice"], unit: "kg", kind: "grain", chance: 0.4, min: 0.5, max: 2.5 },
  { names: ["Wheat Flour"], unit: "kg", kind: "grain", chance: 0.16, min: 0.3, max: 1.5 },
  { names: ["Ginger Garlic Paste"], unit: "kg", kind: "paste", chance: 0.1, min: 0.1, max: 0.4 },
  { names: ["Sunflower Oil"], unit: "L", kind: "dry", chance: 0.08, min: 0.5, max: 2 },
  { names: ["Ghee"], unit: "L", kind: "dry", chance: 0.05, min: 0.1, max: 0.4 },
  { names: ["Sugar"], unit: "kg", kind: "dry", chance: 0.05, min: 0.2, max: 1 },
  { names: ["Soft Drink Bottle"], unit: "pc", kind: "bottle", chance: 0.18, min: 1, max: 3 },
  { names: ["Mineral Water Bottle"], unit: "pc", kind: "bottle", chance: 0.14, min: 1, max: 4 },
];

// What a cook would actually write, by what the item is as well as why it went:
// chicken is not "gone soft in the veg rack", milk is not "charred in the
// tandoor", and a soft-drink bottle does not go mouldy. A null is an entry
// logged with no note, which is most of them in a real kitchen.
const NOTES = {
  dairy: {
    spoiled: [
      "Sour smell at the morning check",
      "Split in the chiller overnight",
      "Chiller running warm — found at opening",
      "Left out of the cold room after lunch service",
      null,
    ],
    expired: [
      "Past use-by at the weekly shelf check",
      "Batch date missed — FIFO not followed",
      "Opened pack left over from the weekend",
      null,
    ],
    over_prepped: [
      "Set too much curd for a quiet day",
      "Leftover from the dinner buffet",
      "Prepped for a full house, lunch was quiet",
      null,
    ],
    returned: ["Guest said the raita was sour", "Paneer sent back — too hard", "Wrong order fired, remade"],
    other: ["Quality check — supplier batch below standard", "Tasting portions for the new menu", "Used for staff training"],
  },
  meat: {
    over_prepped: [
      "Marinated too much ahead of the weekend",
      "Cooked extra for a party that came in short",
      "Leftover from the dinner buffet",
      null,
    ],
    overcooked: ["Tandoor too hot — batch charred", "Burnt during the dinner rush", "Dried out on the hot pass", null],
    returned: ["Guest found it undercooked", "Sent back cold, table 7", "Guest said too spicy — remade", "Wrong order fired, remade"],
    spoiled: [
      "Off smell at the morning check",
      "Left out of the cold room after lunch service",
      "Chiller running warm — found at opening",
      null,
    ],
    dropped: ["Tray slipped at the pass", "Knocked off the counter during service", null],
  },
  vegetable: {
    spoiled: ["Gone soft in the veg rack", "Mould on the top layer", "Rotten at the bottom of the crate", null],
    over_prepped: ["Chopped for a full house, lunch was quiet", "Leftover prep from the dinner rush", null],
    dropped: ["Crate dropped while unloading", "Knocked off the counter during service", null],
    other: ["Quality check — supplier batch below standard", "Heavy trimming on this batch", "Tasting portions for the new menu"],
  },
  paste: {
    spoiled: ["Mould on top of the tub", "Sour smell — batch thrown out", null],
    expired: ["Ground more than three days ago — past use", null],
    over_prepped: ["Ground too much ahead of the weekend", null],
  },
  grain: {
    over_prepped: [
      "Cooked for a full house, lunch was quiet",
      "Leftover from the dinner buffet",
      "Cooked extra for a party that came in short",
      null,
    ],
    overcooked: ["Rice caught at the bottom of the handi", "Burnt during the dinner rush", null],
    dropped: ["Sack split while unloading", "Tray slipped at the pass", null],
    other: ["Weevils found — batch thrown out", "Tasting portions for the new menu", "Used for staff training"],
  },
  dry: {
    dropped: ["Tin dropped while unloading", "Jar knocked off the shelf", "Spilled while refilling", null],
    expired: ["Past use-by at the weekly shelf check", "Batch date missed — FIFO not followed", null],
    other: ["Quality check — supplier batch below standard", "Used for staff training"],
  },
  bottle: {
    dropped: ["Crate dropped while unloading", "Bottle broke at the bar", "Knocked off the counter during service", null],
    expired: ["Past best-before at the weekly check", "Found flat at the back of the fridge", null],
    returned: ["Guest said it was flat", "Opened for the wrong table"],
  },
};

// For a reason an ingredient does not usually have (an old entry from before
// its kind changed): words that fit anything.
const ANY_ITEM_NOTES = {
  spoiled: ["Found off at the morning check"],
  expired: ["Past use-by at the weekly shelf check"],
  overcooked: ["Burnt during the dinner rush"],
  dropped: ["Knocked off the counter during service"],
  returned: ["Wrong order fired, remade"],
  over_prepped: ["Prepped for a full house, lunch was quiet"],
  other: ["Quality check — supplier batch below standard"],
};

const notesFor = (kind, reason) => (NOTES[kind] && NOTES[kind][reason]) || ANY_ITEM_NOTES[reason] || [null];

// The two days everyone remembers.
const INCIDENTS = [
  {
    daysAgo: 12,
    reason: "spoiled",
    note: "Chiller 2 compressor failed overnight — dairy written off",
    lines: [["Paneer", 1.6], ["Milk", 6], ["Curd", 3], ["Fresh Cream", 0.8]],
  },
  {
    daysAgo: 5,
    reason: "over_prepped",
    note: "Party of 40 cancelled after the biryani was on",
    lines: [["Basmati Rice", 4], ["Chicken", 3], ["Onion", 2.5], ["Curd", 1]],
  },
];

const round3 = (value) => Math.round(value * 1000) / 1000;

// The demo pantry is written in kg and litres. An item kept in grams or
// millilitres gets the same amounts, scaled; one in a unit that cannot be
// converted is left alone rather than given a nonsense quantity.
const factorFor = (profileUnit, itemUnit) => {
  const unit = String(itemUnit || "").toLowerCase();
  const wanted = profileUnit.toLowerCase();

  if (unit === wanted || (wanted === "l" && ["ltr", "litre", "liter", "lt"].includes(unit))) {
    return 1;
  }

  if ((wanted === "kg" && ["g", "gm", "gms", "gram"].includes(unit)) || (wanted === "l" && unit === "ml")) {
    return 1000;
  }

  if (wanted === "pc" && ["pcs", "piece", "pieces", "nos", "no", "btl", "bottle", "bottles"].includes(unit)) {
    return 1;
  }

  return null;
};

// Entries an earlier run wrote with a note that does not fit the ingredient —
// notes used to be picked by reason alone, so chicken could be "gone soft in
// the veg rack" — are given one that does. Only this script's own rows, and
// only the note: quantities, dates and the ledger are untouched, and a note
// that already fits is left alone, so this is safe on every run.
const INCIDENT_NOTES = new Set(INCIDENTS.map((incident) => incident.note));

const fitSeededNotes = async (restaurantId) => {
  const rows = (
    await pool.query(
      `SELECT st.id, st.waste_reason, st.notes, i.name
       FROM stock_transactions st
       JOIN inventory_items i ON i.id = st.inventory_item_id
       WHERE st.restaurant_id = $1 AND st.transaction_type = 'wastage'
         AND st.reference_type = $2 AND st.notes IS NOT NULL`,
      [restaurantId, SEED_TAG]
    )
  ).rows;

  let refitted = 0;

  for (const row of rows) {
    const profile = PANTRY.find((entry) =>
      entry.names.some((name) => name.toLowerCase() === row.name.toLowerCase())
    );

    if (!profile || !row.waste_reason || INCIDENT_NOTES.has(row.notes)) {
      continue;
    }

    const fitting = notesFor(profile.kind, row.waste_reason).filter(Boolean);

    if (fitting.length === 0 || fitting.includes(row.notes)) {
      continue;
    }

    // Picked by the row's id, so a second run picks the same note.
    await pool.query(
      "UPDATE stock_transactions SET notes = $3 WHERE restaurant_id = $1 AND id = $2 AND reference_type = $4",
      [restaurantId, row.id, fitting[Number(row.id) % fitting.length], SEED_TAG]
    );
    refitted += 1;
  }

  return refitted;
};

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant found — run the demo seed first.");
    return;
  }

  const restaurantId = Number(restaurant.id);

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "stock_recipes")) {

    return;

  }
  const context = await inventoryInsightRepository.findContext(restaurantId);
  const timezone = (context && context.timezone) || "Asia/Kolkata";
  const businessDate =
    (context && context.open_business_date) ||
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

  // The people who log waste: kitchen staff and managers, with the owner
  // stepping in now and then. Whoever the restaurant actually has.
  const staff = (
    await pool.query(
      `SELECT DISTINCT ON (u.id) u.id, u.name, r.code AS role
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.restaurant_id = $1 AND u.status = 'active'
         AND r.code IN ('KITCHEN', 'MANAGER', 'RESTAURANT_ADMIN')
       ORDER BY u.id, r.code`,
      [restaurantId]
    )
  ).rows;

  // People before test and system accounts, which tend to carry numbers.
  const person = (row) => !/\d/.test(row.name);
  const preferPeople = (rows) => [...rows.filter(person), ...rows.filter((row) => !person(row))];

  const admins = preferPeople(staff.filter((row) => row.role === "RESTAURANT_ADMIN")).slice(0, 1);
  const kitchen = preferPeople(staff.filter((row) => row.role !== "RESTAURANT_ADMIN")).slice(0, 3);
  const loggers = [...kitchen.map((row) => [row.id, 3]), ...admins.map((row) => [row.id, 1])];

  if (loggers.length === 0) {
    say(`${restaurant.name} has no admin, manager or kitchen user to log wastage as.`);
    return;
  }

  const last = (
    await pool.query(
      `SELECT MAX(waste_date) AS last FROM stock_transactions
       WHERE restaurant_id = $1 AND transaction_type = 'wastage' AND reference_type = $2`,
      [restaurantId, SEED_TAG]
    )
  ).rows[0].last;

  const firstDay = addDays(businessDate, -(DAYS - 1));
  const start = last && last >= firstDay ? addDays(last, 1) : firstDay;

  const refitted = await fitSeededNotes(restaurantId);

  if (refitted) {
    say(`Gave ${refitted} earlier seeded entries a note that fits the ingredient.`);
  }

  if (start > businessDate) {
    say(`Wastage is already seeded up to ${last} for ${restaurant.name}. Nothing to add.`);
    return;
  }

  // The kitchen's waste is logged at the main store, so only what sits there
  // can be written off: stock an outlet keeps on its own shelf is not the
  // main kitchen's to throw away. "current_stock" below is that shelf's
  // figure (never more than the restaurant's total).
  const items = (
    await pool.query(
      `SELECT i.id, i.name, u.short_name AS unit,
              LEAST(i.current_stock, COALESCE(main.quantity, 0)) AS current_stock
       FROM inventory_items i
       JOIN units u ON u.id = i.unit_id
       LEFT JOIN stock_balances main
         ON main.inventory_item_id = i.id AND main.outlet_id IS NULL
       WHERE i.restaurant_id = $1 AND i.status = 'active'`,
      [restaurantId]
    )
  ).rows;

  const byName = new Map(items.map((row) => [row.name.toLowerCase(), row]));
  const pantry = [];

  for (const profile of PANTRY) {
    const item = profile.names.map((name) => byName.get(name.toLowerCase())).find(Boolean);

    if (!item) {
      continue;
    }

    const factor = factorFor(profile.unit, item.unit);

    if (factor === null) {
      continue;
    }

    pantry.push({
      ...profile,
      item,
      factor,
      // Scaled to the days this run covers, so topping up a week later cannot
      // eat a month's allowance in seven days.
      budget:
        Math.max(0, Number(item.current_stock)) *
        MAX_SHARE_OF_STOCK *
        ((daysBetween(start, businessDate) + 1) / DAYS),
    });
  }

  if (pantry.length === 0) {
    say(`${restaurant.name} has none of the demo pantry's ingredients — nothing to seed.`);
    return;
  }

  const byPantryName = (name) =>
    pantry.find((entry) => entry.names.some((candidate) => candidate.toLowerCase() === name.toLowerCase()));

  // ---- 1. Plan the whole period first.
  const planned = [];

  for (let date = start; date <= businessDate; date = addDays(date, 1)) {
    const random = generatorFor(`${restaurantId}:${date}`);
    const day = weekday(date);
    // Friday to Sunday the kitchen preps for a crowd, and not every crowd comes.
    const busy = day === 0 || day === 5 || day === 6;
    const daysAgo = daysBetween(date, businessDate);

    for (const entry of pantry) {
      const chance = entry.chance * (busy ? 1.3 : 1);

      if (random() >= chance) {
        continue;
      }

      const reason = weighted(random, REASONS_BY_KIND[entry.kind]);
      const raw = entry.min + (entry.max - entry.min) * random() * random();
      // Pieces are whole; everything else to the nearest 50 g or 50 ml,
      // which is what a kitchen scale is read to.
      const quantity =
        entry.unit === "pc" ? Math.max(1, Math.round(raw)) : Math.max(0.05, Math.round(raw * 20) / 20);
      const notes = notesFor(entry.kind, reason);

      planned.push({
        entry,
        date,
        quantity: round3(quantity * entry.factor),
        reason,
        note: notes[Math.floor(random() * notes.length)],
        userId: weighted(random, loggers),
        order: random(),
        incident: false,
      });
    }

    for (const incident of INCIDENTS.filter((row) => row.daysAgo === daysAgo)) {
      const userId = weighted(random, loggers);

      for (const [name, quantity] of incident.lines) {
        const entry = byPantryName(name);

        if (entry) {
          planned.push({
            entry,
            date,
            quantity: round3(quantity * entry.factor),
            reason: incident.reason,
            note: incident.note,
            userId,
            order: 0,
            incident: true,
          });
        }
      }
    }
  }

  // ---- 2. Fit each item's allowance. Where a month of waste is more than an
  // item can spare, a scattered selection of whole entries is kept rather
  // than every entry shrunk to a sliver — "0.1 kg chicken over-prepped" is not
  // a thing a cook writes — and rather than the first fortnight eating the
  // lot. The two remembered bad days are kept first.
  const kept = [];
  let skipped = 0;

  for (const entry of pantry) {
    const mine = planned
      .filter((row) => row.entry === entry)
      .sort((a, b) => Number(b.incident) - Number(a.incident) || a.order - b.order);
    let room = Math.min(entry.budget, Math.max(0, Number(entry.item.current_stock) - 0.001));

    for (const row of mine) {
      if (row.quantity <= room) {
        kept.push(row);
        room -= row.quantity;
      } else {
        skipped += 1;
      }
    }
  }

  // ---- 3. Write them in date order, through the real stock path.
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  let written = 0;
  let value = 0;
  const reasonCounts = {};
  const costs = new Map(
    (
      await pool.query("SELECT id, last_cost FROM inventory_items WHERE id = ANY($1::bigint[])", [
        pantry.map((entry) => entry.item.id),
      ])
    ).rows.map((row) => [Number(row.id), Number(row.last_cost || 0)])
  );

  for (const row of kept) {
    try {
      await inventoryInsightRepository.insertWastage(
        restaurantId,
        {
          inventoryItemId: row.entry.item.id,
          quantity: row.quantity,
          reason: row.reason,
          reasonLabel: REASONS.find((reason) => reason.key === row.reason).label,
          note: row.note,
          referenceType: SEED_TAG,
          wasteDate: row.date,
        },
        row.userId
      );
    } catch (error) {
      // Stock moved underneath the plan (a sale while this ran): leave it out.
      if (error.code === "NEGATIVE_STOCK") {
        skipped += 1;
        continue;
      }

      throw error;
    }

    written += 1;
    value += row.quantity * (costs.get(Number(row.entry.item.id)) || 0);
    reasonCounts[row.reason] = (reasonCounts[row.reason] || 0) + 1;
  }

  // Recorded through the real stock path, so each item it touched must still
  // have a ledger that adds up to its stock.
  const check = await pool.query(
    `SELECT COUNT(*)::int AS off
     FROM inventory_items i
     WHERE i.restaurant_id = $1 AND i.id = ANY($2::bigint[])
       AND i.current_stock <> COALESCE(
         (SELECT SUM(st.quantity) FROM stock_transactions st WHERE st.inventory_item_id = i.id), 0)`,
    [restaurantId, pantry.map((entry) => entry.item.id)]
  );

  say(`Wastage for ${restaurant.name}, ${start} to ${businessDate}:`);
  say(`  ${written} entries across ${pantry.length} ingredients, about ₹${Math.round(value).toLocaleString("en-IN")} at cost`);
  say(
    `  by reason: ${Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} ${n}`)
      .join(", ")}`
  );

  if (skipped) {
    say(`  ${skipped} planned entries left out: the item could not spare that much stock`);
  }

  say(
    check.rows[0].off === 0
      ? "  the stock ledger still adds up to current stock for every item it touched"
      : `  WARNING: ${check.rows[0].off} item(s) whose ledger does not add up to current stock — they were out of step before this ran`
  );
};

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("\nSeeding wastage failed:", error.message);
    console.error(error);
    await pool.end();
    process.exit(1);
  });
