// The restaurant's own rules for alerts and timings (migration
// 1791640001000): when a discount is large, a delivery late, a guest a
// regular, how far back the reorder plan looks, which notes a cash count
// lists, and the rest. They live as columns of restaurant_settings and are
// edited on Settings -> Alerts and timings.
//
// One list (RULES) says, for each: its name in the API, its column, the
// number the code used before it was a setting (still the column's DEFAULT,
// and what is used for a restaurant with no settings row), and the range the
// screen and the database both accept. Every module reads its rules through
// load() or fromRow() here, so a bell, a report and a screen can never use
// different numbers for the same rule.
const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");

// whole: a whole number (minutes, days, counts); otherwise rupees to the paisa.
const RULES = [
  // Theft control
  { key: "alertLargeDiscountPercent", column: "alert_large_discount_percent", fallback: 20, min: 1, max: 100, whole: true, label: "Large discount (% of the bill)" },
  { key: "alertLargeDiscountAmount", column: "alert_large_discount_amount", fallback: 1000, min: 1, max: 10000000, whole: false, label: "Large discount (amount)" },
  { key: "alertHugeDiscountPercent", column: "alert_huge_discount_percent", fallback: 50, min: 1, max: 100, whole: true, label: "Warning discount (% of the bill)" },
  { key: "alertReprintCount", column: "alert_reprint_count", fallback: 3, min: 2, max: 20, whole: true, label: "Reprint alert (prints)" },
  { key: "alertCashShortCritical", column: "alert_cash_short_critical", fallback: 1000, min: 1, max: 10000000, whole: false, label: "Cash short, critical from" },
  // Deliveries
  { key: "deliverySlaMinutes", column: "delivery_sla_minutes", fallback: 45, min: 10, max: 240, whole: true, label: "Delivery promise (minutes)" },
  { key: "deliveryWarnMinutes", column: "delivery_warn_minutes", fallback: 30, min: 5, max: 235, whole: true, label: "Delivery amber after (minutes)" },
  { key: "deliveryReadyWaitMinutes", column: "delivery_ready_wait_minutes", fallback: 10, min: 1, max: 120, whole: true, label: "Packed and waiting for a rider (minutes)" },
  { key: "deliveryOutWarnMinutes", column: "delivery_out_warn_minutes", fallback: 45, min: 5, max: 240, whole: true, label: "Out for delivery, warning after (minutes)" },
  { key: "deliveryOutCriticalMinutes", column: "delivery_out_critical_minutes", fallback: 60, min: 10, max: 480, whole: true, label: "Out for delivery, critical after (minutes)" },
  // Reservations
  { key: "reservationLateMinutes", column: "reservation_late_minutes", fallback: 15, min: 1, max: 180, whole: true, label: "Booking late after (minutes)" },
  { key: "reservationLastSeatingMinutes", column: "reservation_last_seating_minutes", fallback: 30, min: 0, max: 240, whole: true, label: "Last seating before closing (minutes)" },
  { key: "reservationSlotMinutes", column: "reservation_slot_minutes", fallback: 30, min: 10, max: 60, whole: true, allowed: [10, 15, 20, 30, 45, 60], label: "Online booking times every (minutes)" },
  // Time clock
  { key: "timeclockLateMinutes", column: "timeclock_late_minutes", fallback: 15, min: 1, max: 240, whole: true, label: "Not clocked in, alert after (minutes)" },
  { key: "timeclockLongBreakMinutes", column: "timeclock_long_break_minutes", fallback: 45, min: 5, max: 480, whole: true, label: "Long break after (minutes)" },
  { key: "timeclockOvertimeMinutes", column: "timeclock_overtime_minutes", fallback: 15, min: 0, max: 240, whole: true, label: "Overtime counts from (minutes past the shift)" },
  { key: "timeclockEarlyMinutes", column: "timeclock_early_minutes", fallback: 60, min: 0, max: 720, whole: true, label: "Clock opens before the shift (minutes)" },
  // Guests
  { key: "guestRegularVisits", column: "guest_regular_visits", fallback: 3, min: 2, max: 50, whole: true, label: "Regular: visits" },
  { key: "guestRegularDays", column: "guest_regular_days", fallback: 60, min: 7, max: 730, whole: true, label: "Regular: within (days)" },
  { key: "guestLapsedDays", column: "guest_lapsed_days", fallback: 45, min: 7, max: 730, whole: true, label: "Lapsed after (days)" },
  { key: "guestNewDays", column: "guest_new_days", fallback: 30, min: 1, max: 365, whole: true, label: "New guest for (days)" },
  { key: "guestBigSpenderPercent", column: "guest_big_spender_percent", fallback: 10, min: 1, max: 50, whole: true, label: "Big spenders: top (%)" },
  // Reorder plan
  { key: "reorderLookbackDays", column: "reorder_lookback_days", fallback: 14, min: 3, max: 90, whole: true, label: "Usage read over (days)" },
  { key: "reorderSafetyDays", column: "reorder_safety_days", fallback: 2, min: 0, max: 30, whole: true, label: "Safety stock (days)" },
  { key: "reorderHorizonDays", column: "reorder_horizon_days", fallback: 7, min: 1, max: 30, whole: true, label: "Plan covers (days)" },
];

// The notes a cash count lists, largest first. Coins are always counted
// besides, as one amount. What every counting screen showed before this was
// a setting (₹2,000 notes are out of circulation).
const DEFAULT_DENOMINATIONS = [500, 200, 100, 50, 20, 10];
const MAX_DENOMINATIONS = 15;
const MAX_NOTE = 100000;

// The cash-short alert warns from the restaurant's cash difference limit
// (Business day -> Cash rules), the line past which a count needs a reason.
const DEFAULT_CASH_VARIANCE = 100;

const DEFAULTS = Object.freeze({
  ...Object.fromEntries(RULES.map((rule) => [rule.key, rule.fallback])),
  cashDenominations: DEFAULT_DENOMINATIONS,
});

const numberOr = (value, fallback) => {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? fallback : number;
};

// A list of notes as saved: whole rupees, no repeats, largest first.
const toDenominations = (value) => {
  const list = Array.isArray(value) ? value.map(Number).filter((note) => Number.isInteger(note) && note > 0) : [];
  return list.length ? [...new Set(list)].sort((a, b) => b - a) : [...DEFAULT_DENOMINATIONS];
};

// The rules from a restaurant_settings row (any row read with SELECT * or
// RETURNING *). A missing row, or one read before the migration, gives the
// numbers the code always used.
const fromRow = (row) => {
  const source = row || {};
  const rules = Object.fromEntries(RULES.map((rule) => [rule.key, numberOr(source[rule.column], rule.fallback)]));

  rules.cashDenominations = toDenominations(source.cash_denominations);

  return rules;
};

// The same, plus the cash difference limit (kept with the cash rules, not
// edited here), for the code that needs it beside the rest.
const withCashVariance = (row) => ({
  ...fromRow(row),
  cashShortWarning: numberOr(row && row.cash_variance_threshold, DEFAULT_CASH_VARIANCE),
});

const COLUMNS = [...RULES.map((rule) => rule.column), "cash_denominations", "cash_variance_threshold"];

// One read of one row by its key, for code that runs without the settings in
// hand: the bell's providers, reports and schedulers. A plain SELECT, so a
// screen that polls never writes (restaurantRepository.findSettings upserts).
// `db` lets a transaction read through its own client.
const load = async (restaurantId, db = pool) => {
  const result = await db.query(
    `SELECT ${COLUMNS.join(", ")} FROM restaurant_settings WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return withCashVariance(result.rows[0] || null);
};

// --- Changing them ----------------------------------------------------------

const readNumber = (rule, value) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new AppError(400, `${rule.label} must be a number`);
  }

  if (rule.whole && !Number.isInteger(number)) {
    throw new AppError(400, `${rule.label} must be a whole number`);
  }

  if (rule.allowed && !rule.allowed.includes(number)) {
    throw new AppError(400, `${rule.label} must be one of ${rule.allowed.join(", ")}`);
  }

  if (number < rule.min || number > rule.max) {
    throw new AppError(400, `${rule.label} must be between ${rule.min} and ${rule.max}`);
  }

  return rule.whole ? number : Math.round(number * 100) / 100;
};

const readDenominations = (value) => {
  if (!Array.isArray(value)) {
    throw new AppError(400, "The notes a cash count lists must be a list of amounts, like 500, 200, 100");
  }

  const notes = value.map((note) => {
    const number = typeof note === "string" && note.trim() !== "" ? Number(note) : note;

    if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > MAX_NOTE) {
      throw new AppError(400, `A note in the cash count must be a whole number of rupees from 1 to ${MAX_NOTE}`);
    }

    return number;
  });

  const unique = [...new Set(notes)].sort((a, b) => b - a);

  if (unique.length === 0) {
    throw new AppError(400, "List at least one note for the cash count (coins are always counted besides)");
  }

  if (unique.length > MAX_DENOMINATIONS) {
    throw new AppError(400, `A cash count can list at most ${MAX_DENOMINATIONS} notes`);
  }

  return unique;
};

// The rules a request sends ({ alertReprintCount: 4, … }), checked one by
// one. Only what is sent changes; a rule left out keeps what is saved, so an
// older screen that knows none of them saves nothing here. Names this list
// does not know are ignored (a screen may send back what it was shown).
const readInput = (body) => {
  if (body === undefined || body === null) {
    return null;
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "The alert and timing rules could not be read");
  }

  const input = {};

  for (const rule of RULES) {
    if (body[rule.key] !== undefined && body[rule.key] !== null && body[rule.key] !== "") {
      input[rule.key] = readNumber(rule, body[rule.key]);
    }
  }

  if (body.cashDenominations !== undefined && body.cashDenominations !== null) {
    input.cashDenominations = readDenominations(body.cashDenominations);
  }

  return input;
};

// Rules that only make sense together, checked on what they will be once
// saved (the saved values filling in what was not sent).
const checkTogether = (rules) => {
  if (rules.alertHugeDiscountPercent < rules.alertLargeDiscountPercent) {
    throw new AppError(
      400,
      `The warning discount (${rules.alertHugeDiscountPercent}%) cannot be below where a large discount starts (${rules.alertLargeDiscountPercent}%).`
    );
  }

  if (rules.deliveryWarnMinutes >= rules.deliverySlaMinutes) {
    throw new AppError(
      400,
      `A delivery turns amber before it is late: the amber mark (${rules.deliveryWarnMinutes} min) must come before the promise (${rules.deliverySlaMinutes} min).`
    );
  }

  if (rules.deliveryOutCriticalMinutes <= rules.deliveryOutWarnMinutes) {
    throw new AppError(
      400,
      `A run out for delivery turns critical after it warns: ${rules.deliveryOutCriticalMinutes} min must be more than ${rules.deliveryOutWarnMinutes} min.`
    );
  }
};

// Refuses rules that do not fit together, before anything is written: the
// settings screen saves its other fields in the same request.
const check = async (restaurantId, input, db = pool) => {
  if (input && Object.keys(input).length > 0) {
    checkTogether({ ...(await load(restaurantId, db)), ...input });
  }
};

const save = async (restaurantId, input, userId, db = pool) => {
  if (!input || Object.keys(input).length === 0) {
    return load(restaurantId, db);
  }

  await check(restaurantId, input, db);

  // Column names come from RULES, never from the request.
  const sets = [];
  const values = [restaurantId, userId];

  for (const rule of RULES) {
    if (input[rule.key] !== undefined) {
      values.push(input[rule.key]);
      sets.push(`${rule.column} = $${values.length}`);
    }
  }

  if (input.cashDenominations !== undefined) {
    values.push(input.cashDenominations);
    sets.push(`cash_denominations = $${values.length}::int[]`);
  }

  await db.query(
    `UPDATE restaurant_settings SET ${sets.join(", ")}, updated_by = $2 WHERE restaurant_id = $1`,
    values
  );

  return load(restaurantId, db);
};

module.exports = {
  RULES,
  DEFAULTS,
  DEFAULT_DENOMINATIONS,
  fromRow,
  withCashVariance,
  load,
  readInput,
  checkTogether,
  check,
  save,
};
