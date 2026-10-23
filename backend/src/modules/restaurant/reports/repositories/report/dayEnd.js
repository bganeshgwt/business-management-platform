// Day-end (Z) report queries.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { drawers } = require("./drawers");

// Every business day of one date (the main counter's and each outlet's), or
// with `outletId` given (null: the main counter) just that one's.
const daysOfDate = async (restaurantId, businessDate, outletId = undefined) => {
  const result = await pool.query(
    `SELECT bd.id, bd.outlet_id, bd.business_date, bd.day_status
     FROM business_days bd
     WHERE bd.restaurant_id = $1 AND bd.business_date = $2::date
       AND ($3::boolean = FALSE OR bd.outlet_id IS NOT DISTINCT FROM $4::bigint)
     ORDER BY bd.outlet_id NULLS FIRST`,
    [restaurantId, businessDate, outletId !== undefined, outletId ?? null]
  );

  return result.rows;
};

// The traded dates nearest to one with no business day: up to three before
// it and three after (one outlet's own, or any counter's).
const nearestDays = async (restaurantId, businessDate, outletId = undefined) => {
  const result = await pool.query(
    `(SELECT DISTINCT bd.business_date FROM business_days bd
       WHERE bd.restaurant_id = $1 AND bd.business_date < $2::date
         AND ($3::boolean = FALSE OR bd.outlet_id IS NOT DISTINCT FROM $4::bigint)
       ORDER BY bd.business_date DESC LIMIT 3)
     UNION
     (SELECT DISTINCT bd.business_date FROM business_days bd
       WHERE bd.restaurant_id = $1 AND bd.business_date > $2::date
         AND ($3::boolean = FALSE OR bd.outlet_id IS NOT DISTINCT FROM $4::bigint)
       ORDER BY bd.business_date LIMIT 3)
     ORDER BY 1`,
    [restaurantId, businessDate, outletId !== undefined, outletId ?? null]
  );

  return result.rows.map((row) => String(row.business_date).slice(0, 10));
};

// ===========================================================================
// Day end (and the Z report printed from it)
// ===========================================================================

// The sheet for one or more business days: one day (the main counter's, or an
// outlet's own), or every day of a date for the whole restaurant.
//
// `billOutletId` narrows the days' bills to one outlet. It is only for an
// outlet that traded on the main counter's day (before outlets had days of
// their own): its bills are in that day, but the drawer is not its own.
const dayEndReport = async (restaurantId, dayIds, { billOutletId = null, timezone = "Asia/Kolkata" } = {}) => {
  const params = [restaurantId, dayIds, billOutletId];
  const [sales, byMethod, refunds, voids, cancelled, byType, dayCovers, liveBills, tills, perDay] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS bill_count,
              COALESCE(SUM(total_amount), 0) AS net_sales,
              COALESCE(SUM(subtotal), 0) AS gross_sales,
              COALESCE(SUM(discount_amount), 0) AS discounts,
              COALESCE(SUM(tax_amount), 0) AS tax,
              COALESCE(SUM(cess_amount), 0) AS cess,
              COALESCE(SUM(service_charge), 0) AS service_charge,
              COALESCE(SUM(round_off), 0) AS round_off,
              MIN(bill_number) FILTER (WHERE billed_at = first_at) AS first_bill,
              MAX(bill_number) FILTER (WHERE billed_at = last_at) AS last_bill
       FROM (
         SELECT b.*, MIN(b.billed_at) OVER () AS first_at, MAX(b.billed_at) OVER () AS last_at
         FROM bills b
         WHERE b.restaurant_id = $1 AND b.business_day_id = ANY($2::bigint[]) AND b.bill_status <> 'void'
           AND ($3::bigint IS NULL OR b.outlet_id = $3)
       ) b`,
      params
    ),
    pool.query(
      `SELECT p.payment_method, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::int AS payment_count,
              -- Tips on top of the payments, by how they were given: never in
              -- the amount above, the sales, GST or the P&L.
              COALESCE(SUM(p.tip_amount), 0) AS tips,
              COUNT(*) FILTER (WHERE p.tip_amount > 0)::int AS tip_count
       FROM payments p
       LEFT JOIN bills b ON b.id = p.bill_id
       WHERE p.restaurant_id = $1 AND p.business_day_id = ANY($2::bigint[]) AND p.payment_status = 'success'
         AND ($3::bigint IS NULL OR b.outlet_id = $3)
       GROUP BY 1 ORDER BY 1`,
      params
    ),
    pool.query(
      `SELECT COALESCE(SUM(r.amount) FILTER (WHERE r.refund_method = 'cash'), 0) AS cash_refunds,
              COALESCE(SUM(r.amount), 0) AS total_refunds,
              COUNT(*)::int AS refund_count
       FROM refunds r
       LEFT JOIN bills b ON b.id = r.bill_id
       WHERE r.restaurant_id = $1 AND r.business_day_id = ANY($2::bigint[])
         AND ($3::bigint IS NULL OR b.outlet_id = $3)`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS void_count, COALESCE(SUM(total_amount), 0) AS void_value
       FROM bills
       WHERE restaurant_id = $1 AND business_day_id = ANY($2::bigint[]) AND bill_status = 'void'
         AND ($3::bigint IS NULL OR outlet_id = $3)`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cancelled_count, COALESCE(SUM(total_amount), 0) AS cancelled_value
       FROM orders
       WHERE restaurant_id = $1 AND business_day_id = ANY($2::bigint[]) AND order_status = 'cancelled'
         AND ($3::bigint IS NULL OR outlet_id = $3)`,
      params
    ),
    pool.query(
      `SELECT o.order_type, COUNT(*)::int AS bill_count, COALESCE(SUM(b.total_amount), 0) AS net_sales
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       WHERE b.restaurant_id = $1 AND b.business_day_id = ANY($2::bigint[]) AND b.bill_status <> 'void'
         AND ($3::bigint IS NULL OR b.outlet_id = $3)
       GROUP BY 1 ORDER BY 3 DESC`,
      params
    ),
    // Covers by the same rule as everywhere else (see covers), for these
    // days' bills.
    pool.query(
      `WITH billed AS (
         SELECT b.order_id, SUM(b.total_amount) AS sales
         FROM bills b
         JOIN orders o ON o.id = b.order_id
         WHERE b.restaurant_id = $1 AND b.business_day_id = ANY($2::bigint[]) AND b.bill_status <> 'void'
           AND ($3::bigint IS NULL OR b.outlet_id = $3) AND o.order_type = 'dine_in'
         GROUP BY b.order_id
       )
       SELECT COUNT(*)::int AS dine_in_orders,
              COALESCE(SUM(billed.sales), 0) AS dine_in_sales,
              COALESCE(SUM(o.guest_count) FILTER (WHERE o.guest_count > 0), 0)::int AS covers,
              COALESCE(SUM(billed.sales) FILTER (WHERE o.guest_count > 0), 0) AS covered_sales,
              COUNT(*) FILTER (WHERE COALESCE(o.guest_count, 0) = 0)::int AS without_guests
       FROM billed
       JOIN orders o ON o.id = billed.order_id`,
      params
    ),
    // The days' live bills, for CGST/SGST as the GST pack reads them.
    pool.query(
      `SELECT b.id FROM bills b
       WHERE b.restaurant_id = $1 AND b.business_day_id = ANY($2::bigint[]) AND b.bill_status <> 'void'
         AND ($3::bigint IS NULL OR b.outlet_id = $3)`,
      params
    ),
    drawers(restaurantId, dayIds),
    // Each day's own bills and its invoice numbers, first to last: every
    // counter numbers its own series, so one "first to last" across them
    // would mean nothing.
    pool.query(
      `SELECT b.business_day_id, COUNT(*)::int AS bill_count, COALESCE(SUM(b.total_amount), 0) AS net_sales,
              (ARRAY_AGG(b.bill_number ORDER BY b.billed_at, b.id))[1] AS first_bill,
              (ARRAY_AGG(b.bill_number ORDER BY b.billed_at DESC, b.id DESC))[1] AS last_bill
       FROM bills b
       WHERE b.restaurant_id = $1 AND b.business_day_id = ANY($2::bigint[]) AND b.bill_status <> 'void'
         AND ($3::bigint IS NULL OR b.outlet_id = $3)
       GROUP BY b.business_day_id`,
      params
    ),
  ]);

  // One outlet's share of the main counter's day: its own expenses.
  const outletCash = billOutletId
    ? (
        await pool.query(
          `SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.payment_mode = 'cash'), 0) AS cash_expenses,
                  COALESCE(SUM(e.amount), 0) AS total_expenses
           FROM expenses e
           WHERE e.restaurant_id = $1 AND e.expense_status = 'approved' AND e.outlet_id = $3
             AND e.expense_date IN (SELECT business_date FROM business_days WHERE id = ANY($2::bigint[]))`,
          params
        )
      ).rows[0]
    : null;

  return {
    billIds: liveBills.rows.map((row) => row.id),
    timezone,
    outletCash,
    drawers: tills,
    perDay: perDay.rows,
    sales: sales.rows[0],
    byMethod: byMethod.rows,
    refunds: refunds.rows[0],
    voids: voids.rows[0],
    cancelled: cancelled.rows[0],
    byType: byType.rows,
    covers: dayCovers.rows[0] || null,
  };
};

// The days' handover notes from the shift log book: entries written
// on these days' dates for these days' counters — an outlet's own, or the
// whole restaurant's (no outlet). Oldest first, as the day ran.
const dayLogbook = async (restaurantId, dayIds) => {
  if (dayIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT le.id, le.category, le.body, le.shift_label, le.created_at, le.outlet_id, ol.name AS outlet_name,
            le.needs_follow_up, le.closed_at, u.name AS created_by_name
     FROM logbook_entries le
     JOIN business_days bd ON bd.restaurant_id = le.restaurant_id AND bd.business_date = le.business_date
       AND (le.outlet_id IS NULL OR le.outlet_id IS NOT DISTINCT FROM bd.outlet_id)
     LEFT JOIN outlets ol ON ol.id = le.outlet_id
     LEFT JOIN users u ON u.id = le.created_by
     WHERE le.restaurant_id = $1 AND bd.id = ANY($2::bigint[])
     GROUP BY le.id, ol.name, u.name
     ORDER BY le.created_at, le.id`,
    [restaurantId, dayIds]
  );

  return result.rows;
};

// What riders still owe from earlier settlements (kept as owed, not yet
// handed over), as it stands now: at one counter (an outlet, or the main
// counter for null) or, with `all`, the whole restaurant.
const ridersOwed = async (restaurantId, { all = true, outletId = null } = {}) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(shortfall), 0) AS amount,
            COUNT(DISTINCT rider_employee_id)::int AS riders
     FROM rider_settlements
     WHERE restaurant_id = $1 AND shortfall_action = 'owed' AND repaid_at IS NULL
       AND ($2::boolean OR outlet_id IS NOT DISTINCT FROM $3::bigint)`,
    [restaurantId, all, outletId]
  );

  return result.rows[0];
};

module.exports = {
  daysOfDate,
  nearestDays,
  dayEndReport,
  dayLogbook,
  ridersOwed,
};
