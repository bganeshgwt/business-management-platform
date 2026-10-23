const pool = require("../../../../config/database");

const COLUMNS = `bd.id, bd.business_date, bd.opened_at, bd.closed_at, bd.opening_cash,
                 bd.closing_cash, bd.notes, bd.opening_notes, bd.closing_notes, bd.day_status, bd.outlet_id,
                 bd.counted_cash, bd.count_method, bd.count_denominations, bd.blind_count, bd.first_count,
                 bd.expected_cash, bd.cash_dropped, bd.cash_paid_in, bd.cash_variance, bd.variance_reason,
                 bd.method_checks, bd.reopened_count`;

const findOpen = async (restaurantId, outletId, db = pool) => {
  const result = await db.query(
    `SELECT ${COLUMNS}, o.name AS opened_by_name
     FROM business_days bd
     LEFT JOIN users o ON o.id = bd.opened_by
     WHERE bd.restaurant_id = $1 AND bd.day_status = 'open'
       AND ($2::boolean = FALSE OR bd.outlet_id IS NOT DISTINCT FROM $3::bigint)
     ORDER BY bd.outlet_id NULLS FIRST`,
    [restaurantId, outletId !== undefined, outletId ?? null]
  );

  return result.rows[0] || null;
};

const findRecent = async (restaurantId, limit = 30, outletId) => {
  const result = await pool.query(
    `SELECT ${COLUMNS}, o.name AS opened_by_name, c.name AS closed_by_name
     FROM business_days bd
     LEFT JOIN users o ON o.id = bd.opened_by
     LEFT JOIN users c ON c.id = bd.closed_by
     WHERE bd.restaurant_id = $1
       AND ($3::boolean = FALSE OR bd.outlet_id IS NOT DISTINCT FROM $4::bigint)
     ORDER BY bd.business_date DESC
     LIMIT $2`,
    [restaurantId, limit, outletId !== undefined, outletId ?? null]
  );

  return result.rows;
};

// Past days between two dates, newest first, a page at a time, with how many
// there are in all ("26–50 of 90"). The Business day screen's "Past days".
const findPage = async (restaurantId, { from, to, outletId, limit, offset }) => {
  const where = `bd.restaurant_id = $1
       AND ($2::date IS NULL OR bd.business_date >= $2)
       AND ($3::date IS NULL OR bd.business_date <= $3)
       AND ($4::boolean = FALSE OR bd.outlet_id IS NOT DISTINCT FROM $5::bigint)`;
  const params = [restaurantId, from || null, to || null, outletId !== undefined, outletId ?? null];
  const [rows, total] = await Promise.all([
    pool.query(
      `SELECT ${COLUMNS}, o.name AS opened_by_name, c.name AS closed_by_name
       FROM business_days bd
       LEFT JOIN users o ON o.id = bd.opened_by
       LEFT JOIN users c ON c.id = bd.closed_by
       WHERE ${where}
       ORDER BY bd.business_date DESC, bd.id DESC
       LIMIT $6 OFFSET $7`,
      [...params, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM business_days bd WHERE ${where}`, params),
  ]);

  return { rows: rows.rows, total: total.rows[0].total };
};

const findByDate = async (restaurantId, businessDate, outletId = null) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM business_days bd
     WHERE bd.restaurant_id = $1 AND bd.business_date = $2
       AND bd.outlet_id IS NOT DISTINCT FROM $3::bigint`,
    [restaurantId, businessDate, outletId]
  );

  return result.rows[0] || null;
};

// The latest day of one till (null: the main counter), open or closed.
const findLatest = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM business_days bd
     WHERE bd.restaurant_id = $1 AND bd.outlet_id IS NOT DISTINCT FROM $2::bigint
     ORDER BY bd.business_date DESC, bd.id DESC
     LIMIT 1`,
    [restaurantId, outletId]
  );

  return result.rows[0] || null;
};

const open = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO business_days (restaurant_id, outlet_id, business_date, opening_cash, notes, opening_notes, opened_by)
     VALUES ($1, $2, $3, $4, $5::text, $5::text, $6)
     RETURNING id`,
    [restaurantId, data.outletId || null, data.businessDate, data.openingCash, data.notes, userId]
  );

  return result.rows[0].id;
};

// Closes the day with its count. closing_cash is the cash the day accounts
// for (the count, plus what was dropped to the safe, less what was put in
// from it): the figure every report compares with the day's expected cash.
// counted_cash is what was in the drawer itself.
//
// data: { closingCash (accounted), countedCash, countMethod, denominations,
//         blindCount, expectedCash, cashDropped, cashPaidIn, variance,
//         varianceReason, methodChecks, notes }
// db: the pool, or the client of a transaction that holds the day
// (cashDrawerRepository.lockDay).
const close = async (restaurantId, id, data, userId, db = pool) => {
  const result = await db.query(
    `UPDATE business_days
     SET day_status = 'closed', closed_at = NOW(), closing_cash = $3, closed_by = $5,
         -- The closing note is kept beside the opening one, never over it;
         -- notes holds the two together for older readers.
         closing_notes = $4,
         notes = NULLIF(CONCAT_WS(E'\n', NULLIF(opening_notes, ''), NULLIF($4::text, '')), ''),
         counted_cash = $6, count_method = $7, count_denominations = $8, blind_count = $9,
         expected_cash = $10, cash_dropped = $11, cash_paid_in = $12, cash_variance = $13,
         variance_reason = $14, method_checks = $15,
         first_count = COALESCE(first_count, $6)
     WHERE restaurant_id = $1 AND id = $2 AND day_status = 'open'
     RETURNING id`,
    [
      restaurantId,
      id,
      data.closingCash,
      data.notes,
      userId,
      data.countedCash,
      data.countMethod || null,
      data.denominations ? JSON.stringify(data.denominations) : null,
      Boolean(data.blindCount),
      data.expectedCash,
      data.cashDropped || 0,
      data.cashPaidIn || 0,
      data.variance,
      data.varianceReason || null,
      data.methodChecks ? JSON.stringify(data.methodChecks) : null,
    ]
  );

  return result.rows[0] || null;
};

// The first figure a count gave, kept when the count is changed after the
// difference was shown (a blind count changed to match stays visible).
const keepFirstCount = async (restaurantId, id, counted) => {
  await pool.query(
    `UPDATE business_days SET first_count = $3
     WHERE restaurant_id = $1 AND id = $2 AND day_status = 'open' AND first_count IS NULL`,
    [restaurantId, id, counted]
  );
};

// Opens a closed day again (closed by mistake at lunch). What it was closed
// with stays in its notes, and who reopened it in the activity log; the count
// starts afresh.
const reopen = async (restaurantId, id, note) => {
  const result = await pool.query(
    `UPDATE business_days
     SET day_status = 'open', closed_at = NULL, closed_by = NULL, closing_cash = NULL,
         counted_cash = NULL, count_method = NULL, count_denominations = NULL, blind_count = FALSE,
         first_count = NULL, expected_cash = NULL, cash_dropped = 0, cash_paid_in = 0,
         cash_variance = NULL, variance_reason = NULL, method_checks = NULL,
         reopened_count = reopened_count + 1,
         notes = CASE WHEN notes IS NULL OR notes = '' THEN $3 ELSE notes || E'\n' || $3 END,
         updated_at = NOW()
     WHERE restaurant_id = $1 AND id = $2 AND day_status = 'closed'
     RETURNING id`,
    [restaurantId, id, note]
  );

  return result.rows[0] || null;
};

// What is still unsettled when someone tries to close the day.
//
// Open orders are looked for across ALL days, not just this one: an order is a
// table that has not paid, whichever day it started on. A restaurant was found
// with two orders still open on a day closed two days earlier — which is
// exactly what happens when nothing checks.
const findUnsettled = async (restaurantId, dayId, outletId) => {
  const [orders, bills] = await Promise.all([
    pool.query(
      `SELECT o.id, o.order_number, o.order_type, o.total_amount, o.placed_at,
              t.table_no, bd.business_date
       FROM orders o
       LEFT JOIN dining_tables t ON t.id = o.table_id
       LEFT JOIN business_days bd ON bd.id = o.business_day_id
       WHERE o.restaurant_id = $1 AND o.order_status = 'open'
         AND ($2::boolean = FALSE OR o.outlet_id IS NOT DISTINCT FROM $3::bigint)
       ORDER BY o.placed_at`,
      [restaurantId, outletId !== undefined, outletId ?? null]
    ),
    // Bills raised today and not fully paid: dues, if the owner allows them.
    // A bill put on a guest's or company's account is not one of them: it is
    // owed on the account (Dues & accounts), under the account's own limit,
    // and its guests have gone — it never stops the close, and it is not
    // "carried as a due" in the day's note.
    pool.query(
      `SELECT b.id, b.bill_number, b.total_amount, b.paid_amount,
              (b.total_amount - b.paid_amount) AS due_amount,
              o.order_number, t.table_no
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN dining_tables t ON t.id = o.table_id
       WHERE b.restaurant_id = $1 AND b.business_day_id = $2
         AND b.bill_status IN ('unpaid', 'partial')
         AND b.account_customer_id IS NULL
       ORDER BY b.billed_at`,
      [restaurantId, dayId]
    ),
  ]);

  return { orders: orders.rows, bills: bills.rows };
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${COLUMNS}, o.name AS opened_by_name, c.name AS closed_by_name
     FROM business_days bd
     LEFT JOIN users o ON o.id = bd.opened_by
     LEFT JOIN users c ON c.id = bd.closed_by
     WHERE bd.restaurant_id = $1 AND bd.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// The rules for opening and counting, kept with the restaurant's settings.
const updateCashRules = async (restaurantId, data, userId) => {
  await pool.query(
    `UPDATE restaurant_settings
     SET day_cutoff_hour = $2, cash_variance_threshold = $3, cash_blind_count = $4, updated_by = $5
     WHERE restaurant_id = $1`,
    [restaurantId, data.cutoffHour, data.varianceThreshold, data.blindCount, userId]
  );
};

module.exports = {
  findOpen,
  findRecent,
  findPage,
  findUnsettled,
  findByDate,
  findById,
  findLatest,
  open,
  close,
  keepFirstCount,
  reopen,
  updateCashRules,
};
