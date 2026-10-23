// Dashboard and live kitchen queries.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { BILL_DAY, BILL_LINES, LIVE, scopeParams } = require("./sql");
const { salesByDay } = require("./sales");
const { drawers } = require("./drawers");
const { todayStartsSql } = require("../../../orders/repositories/tradingClock");

// ===========================================================================
// Dashboard
// ===========================================================================

// Live numbers for the dashboard: the business day, plus what is running now.
//
// "Today" is the business days being traded (`dayIds`): an outlet's own day,
// or the main counter's day for an outlet that trades on it (its bills only,
// through `outletId`), or — for the whole restaurant — every day open now,
// the main counter's and each outlet's own, added up, each on its own date.
// Read by one date instead, a branch whose day is 1 Oct showed ₹0 while the
// main counter still had 23 Sep open. With no day open at all (`dayIds`
// null) it is the date's bills, as before. History (the week's trend, the
// same day last week, the month) is by date, ending on `businessDate`.
//
// `withSales` false leaves out every figure that shows takings — the day's
// sales, the month, the drawer, money owed — for a person without sales.view.
// Those queries are not run at all rather than run and hidden.
//
// The parameters of every "today" query: the five of the scope, then
//   $6 the day ids (NULL: by date)
const TODAY_BILLS = `b.restaurant_id = $1
  AND ($4::bigint IS NULL OR b.outlet_id = $4)
  AND (($6::bigint[] IS NULL AND ${BILL_DAY} BETWEEN $2::date AND $3::date)
       OR b.business_day_id = ANY($6::bigint[]))`;

const dashboard = async (
  restaurantId,
  businessDate,
  timezone,
  { outletId = null, withSales = true, dayIds = null, dates = null } = {}
) => {
  const scope = { restaurantId, from: businessDate, to: businessDate, outletId, timezone };
  const params = scopeParams(scope);
  const today = [...params, dayIds && dayIds.length > 0 ? dayIds : null];

  // Figures anyone signed in may see: what is running, what is out, what is
  // waiting. Counts, never money.
  const [openOrders, tables, lowStock, pending, dayItems, unsold, orderMix, waiting, dayCovers] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0) AS value,
              COALESCE(SUM(guest_count) FILTER (WHERE order_type = 'dine_in'), 0)::int AS seated,
              -- Taken on an earlier trading day and never closed.
              (COUNT(*) FILTER (WHERE placed_at < clock.today_starts))::int AS earlier,
              (COUNT(DISTINCT table_id) FILTER (WHERE placed_at < clock.today_starts))::int AS earlier_tables,
              COALESCE(SUM(total_amount) FILTER (WHERE placed_at < clock.today_starts), 0) AS earlier_value,
              MIN(placed_at) FILTER (WHERE placed_at < clock.today_starts) AS earlier_oldest
       FROM orders
       CROSS JOIN (SELECT ${todayStartsSql("$1")} AS today_starts) clock
       WHERE restaurant_id = $1 AND order_status = 'open' AND ($2::bigint IS NULL OR outlet_id = $2)`,
      [restaurantId, outletId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE table_status = 'occupied')::int AS occupied
       FROM dining_tables
       WHERE restaurant_id = $1 AND status = 'active' AND ($2::bigint IS NULL OR outlet_id = $2)`,
      [restaurantId, outletId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM inventory_items
       WHERE restaurant_id = $1 AND status = 'active' AND current_stock <= reorder_level`,
      [restaurantId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS complaints
       FROM complaints
       WHERE restaurant_id = $1 AND complaint_status IN ('open', 'in_progress')
         AND ($2::bigint IS NULL OR outlet_id = $2)`,
      [restaurantId, outletId]
    ),
    // Both ends of the day's selling in one pass, ranked by money for those
    // who may see it and by plates for those who may not.
    pool.query(
      `WITH sold AS (
         SELECT l.item_name,
                SUM(l.quantity) AS quantity,
                COALESCE(SUM(l.line_total), 0) AS gross_sales
         FROM bills b
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         ${BILL_LINES}
         WHERE ${LIVE} AND ${TODAY_BILLS}
         GROUP BY 1
       ), ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (ORDER BY ${withSales ? "gross_sales" : "quantity"} DESC, item_name) AS best,
                ROW_NUMBER() OVER (ORDER BY ${withSales ? "gross_sales" : "quantity"} ASC, item_name) AS worst,
                COUNT(*) OVER () AS sold_lines
         FROM sold
       )
       SELECT item_name, quantity, gross_sales, best, worst, sold_lines
       FROM ranked
       WHERE best <= 5 OR worst <= 5
       ORDER BY best`,
      today
    ),
    // How many dishes on the menu sold nothing at all today. What sold is
    // worked out once, not once per dish.
    pool.query(
      `WITH sold AS (
         SELECT DISTINCT l.product_id
         FROM bills b
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         ${BILL_LINES}
         WHERE ${LIVE} AND ${TODAY_BILLS} AND l.product_id IS NOT NULL
       )
       SELECT COUNT(*)::int AS count
       FROM products p
       WHERE p.restaurant_id = $1 AND p.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM sold WHERE sold.product_id = p.id)`,
      today
    ),
    // Orders taken today, by type: counts only. Running ones included — a
    // table eating now is part of the day even before it has a bill.
    pool.query(
      `SELECT COUNT(*)::int AS order_count,
              COUNT(*) FILTER (WHERE o.order_type = 'dine_in')::int AS dine_in,
              COUNT(*) FILTER (WHERE o.order_type = 'takeaway')::int AS takeaway,
              COUNT(*) FILTER (WHERE o.order_type = 'delivery')::int AS delivery
       FROM orders o
       LEFT JOIN business_days bd ON bd.id = o.business_day_id
       WHERE o.restaurant_id = $1 AND o.order_status <> 'cancelled'
         AND ($4::bigint IS NULL OR o.outlet_id = $4)
         AND (($6::bigint[] IS NULL
               AND COALESCE(bd.business_date, (o.placed_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date)
              OR o.business_day_id = ANY($6::bigint[]))`,
      today
    ),
    // Things waiting on a person: counted for everyone (each screen shows
    // only what its permissions allow), the money behind them only below.
    pool.query(
      `SELECT (SELECT COUNT(*) FROM bills
               WHERE restaurant_id = $1 AND bill_status IN ('unpaid', 'partial')
                 AND account_customer_id IS NULL
                 AND ($2::bigint IS NULL OR outlet_id = $2))::int AS unpaid,
              -- Bills put on a guest's or company's account are owed, but on
              -- purpose: they are counted on their own line.
              (SELECT COUNT(*) FROM bills
               WHERE restaurant_id = $1 AND bill_status IN ('unpaid', 'partial')
                 AND account_customer_id IS NOT NULL
                 AND ($2::bigint IS NULL OR outlet_id = $2))::int AS on_account,
              (SELECT COUNT(*) FROM expenses
               WHERE restaurant_id = $1 AND expense_status = 'pending'
                 AND ($2::bigint IS NULL OR outlet_id = $2))::int AS expenses_pending,
              (SELECT COUNT(*) FROM purchase_orders
               WHERE restaurant_id = $1 AND po_status IN ('ordered', 'partial')
                 AND ($2::bigint IS NULL OR outlet_id = $2))::int AS po_awaiting`,
      [restaurantId, outletId]
    ),
    // Covers by the one definition (see covers), for today's bills.
    pool.query(
      `WITH billed AS (
         SELECT b.order_id, SUM(b.total_amount) AS sales
         FROM bills b
         JOIN orders o ON o.id = b.order_id
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         WHERE ${LIVE} AND ${TODAY_BILLS} AND o.order_type = 'dine_in'
         GROUP BY b.order_id
       )
       SELECT COUNT(*)::int AS dine_in_orders,
              COALESCE(SUM(billed.sales), 0) AS dine_in_sales,
              COALESCE(SUM(o.guest_count) FILTER (WHERE o.guest_count > 0), 0)::int AS covers,
              COALESCE(SUM(billed.sales) FILTER (WHERE o.guest_count > 0), 0) AS covered_sales,
              COUNT(*) FILTER (WHERE COALESCE(o.guest_count, 0) = 0)::int AS without_guests
       FROM billed
       JOIN orders o ON o.id = billed.order_id`,
      today
    ),
  ]);

  const counts = {
    openOrders: openOrders.rows[0],
    tables: tables.rows[0],
    lowStock: lowStock.rows[0].count,
    openComplaints: pending.rows[0].complaints,
    dayItems: dayItems.rows,
    unsoldToday: unsold.rows[0].count,
    orderMix: orderMix.rows[0],
    waiting: waiting.rows[0],
    covers: dayCovers.rows[0] || null,
  };

  if (!withSales) {
    return counts;
  }

  // Everything below is money: how today compares, where it came from, what
  // the drawer should hold, and what is still owed.
  const [todaySales, trend, compare, byMethod, cash, byType, unpaid, returns, spending, month, byHour, byDay] =
    await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS bill_count,
                COALESCE(SUM(b.total_amount), 0) AS net_sales,
                COALESCE(AVG(b.total_amount), 0) AS average_bill,
                COALESCE(SUM(b.discount_amount), 0) AS discounts
         FROM bills b
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         WHERE ${LIVE} AND ${TODAY_BILLS}`,
        today
      ),
      // The last seven days, every one of them, zeroes included.
      salesByDay({ ...scope, from: addDaysSql(businessDate, -6) }),
      // Yesterday, and the same weekday a week ago — a Monday is only slow
      // compared with other Mondays. The figure that matters is "up to this
      // time": half a day measured against a whole one reports a collapse
      // every morning and a miracle every night.
      pool.query(
        `SELECT COALESCE(SUM(b.total_amount) FILTER (WHERE ${BILL_DAY} = $2::date - 1), 0) AS yesterday,
                COALESCE(SUM(b.total_amount) FILTER (WHERE ${BILL_DAY} = $2::date - 7), 0) AS same_day_last_week,
                COALESCE(SUM(b.total_amount) FILTER (
                  WHERE ${BILL_DAY} = $2::date - 7
                    AND (b.billed_at AT TIME ZONE $5)::time <= (NOW() AT TIME ZONE $5)::time), 0)
                  AS same_day_last_week_to_time
         FROM bills b
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         WHERE b.restaurant_id = $1 AND ${LIVE}
           AND ($4::bigint IS NULL OR b.outlet_id = $4)
           AND ${BILL_DAY} IN ($2::date - 1, $2::date - 7)
           AND $3::date IS NOT NULL`,
        params
      ),
      // The money collected in today's days, counted the way the drawer, the
      // day-end sheet and the Bills screen count it: every payment taken in
      // the day, a due from an older bill collected today included (`dues`).
      // Counting only the payments on today's bills left those dues out, so
      // the dashboard said ₹3,262 collected while the Bills screen and the
      // Z report said ₹3,914. With an outlet chosen: everything taken in its
      // own day; on the main counter's day (an outlet with no day of its
      // own), only what its own bills took.
      pool.query(
        `SELECT p.payment_method,
                COUNT(*)::int AS payment_count,
                COALESCE(SUM(p.amount), 0) AS amount,
                COALESCE(SUM(p.amount) FILTER (
                  WHERE b.business_day_id IS DISTINCT FROM p.business_day_id), 0) AS dues
         FROM payments p
         JOIN bills b ON b.id = p.bill_id
         LEFT JOIN business_days pd ON pd.id = p.business_day_id
         WHERE p.restaurant_id = $1 AND p.payment_status = 'success'
           AND ($4::bigint IS NULL OR pd.outlet_id = $4 OR (pd.outlet_id IS NULL AND b.outlet_id = $4))
           AND (($6::bigint[] IS NULL
                 AND COALESCE(pd.business_date, (p.paid_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date)
                OR p.business_day_id = ANY($6::bigint[]))
         GROUP BY 1
         ORDER BY amount DESC`,
        today
      ),
      // The drawers of the day, by the same arithmetic as the day-end sheet
      // (see drawers): the days being traded, or every drawer of the date
      // when none is. An outlet that trades on the main counter's day has no
      // drawer of its own: only its cash taken is shown (outlet_cash_* below).
      pool.query(
        `SELECT bd.id, bd.outlet_id,
                COALESCE((
                  SELECT SUM(p.amount) FROM payments p
                  JOIN bills pb ON pb.id = p.bill_id
                  WHERE p.business_day_id = bd.id AND p.payment_method = 'cash'
                    AND p.payment_status = 'success' AND pb.outlet_id = $3), 0) AS outlet_cash_sales,
                COALESCE((
                  SELECT SUM(r.amount) FROM refunds r
                  JOIN bills rb ON rb.id = r.bill_id
                  WHERE r.business_day_id = bd.id AND r.refund_method = 'cash' AND rb.outlet_id = $3), 0)
                  AS outlet_cash_refunds,
                COALESCE((
                  SELECT SUM(e.amount) FROM expenses e
                  WHERE e.restaurant_id = $1 AND e.expense_status = 'approved' AND e.payment_mode = 'cash'
                    AND e.expense_date = bd.business_date AND e.outlet_id = $3), 0) AS outlet_cash_expenses
         FROM business_days bd
         WHERE bd.restaurant_id = $1
           AND (($4::bigint[] IS NULL AND bd.business_date = $2::date) OR bd.id = ANY($4::bigint[]))
         ORDER BY bd.outlet_id NULLS FIRST, (bd.day_status = 'open') DESC, bd.opened_at DESC`,
        [restaurantId, businessDate, outletId, today[5]]
      ),
      pool.query(
        `SELECT o.order_type,
                COUNT(*)::int AS bill_count,
                COALESCE(SUM(b.total_amount), 0) AS net_sales,
                COALESCE(AVG(b.total_amount), 0) AS average_bill
         FROM bills b
         JOIN orders o ON o.id = b.order_id
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         WHERE ${LIVE} AND ${TODAY_BILLS}
         GROUP BY 1
         ORDER BY net_sales DESC`,
        today
      ),
      // Money billed but not yet collected — on any day, not just today.
      // A bill put on a guest's or company's account is collected later by
      // arrangement (Dues & accounts), so it is counted apart from the bills
      // still waiting at the till, as the Bills screen does.
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE account_customer_id IS NULL)::int AS count,
                COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE account_customer_id IS NULL), 0) AS due,
                COUNT(*) FILTER (WHERE account_customer_id IS NOT NULL)::int AS account_count,
                COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE account_customer_id IS NOT NULL), 0) AS account_due
         FROM bills
         WHERE restaurant_id = $1 AND bill_status IN ('unpaid', 'partial')
           AND ($2::bigint IS NULL OR outlet_id = $2)`,
        [restaurantId, outletId]
      ),
      // Refunds and voids are worth a manager's eye the moment they happen:
      // what was paid back in today's days, and today's bills voided.
      pool.query(
        `SELECT COALESCE((
                  SELECT SUM(r.amount) FROM refunds r
                  JOIN bills rb ON rb.id = r.bill_id
                  LEFT JOIN business_days rd ON rd.id = r.business_day_id
                  WHERE r.restaurant_id = $1
                    AND ($4::bigint IS NULL OR rb.outlet_id = $4)
                    AND (($6::bigint[] IS NULL
                          AND COALESCE(rd.business_date, (r.refunded_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date)
                         OR r.business_day_id = ANY($6::bigint[]))), 0) AS refunds,
                COALESCE((
                  SELECT COUNT(*) FROM bills b
                  LEFT JOIN business_days bd ON bd.id = b.business_day_id
                  WHERE b.bill_status = 'void' AND ${TODAY_BILLS}), 0)::int AS voids`,
        today
      ),
      // Approved expenses of the day (each day being traded, by its date).
      pool.query(
        `SELECT COALESCE(SUM(amount) FILTER (
                  WHERE expense_status = 'approved' AND expense_date = ANY($2::date[])), 0) AS today,
                COUNT(*) FILTER (WHERE expense_status = 'pending')::int AS awaiting_approval
         FROM expenses
         WHERE restaurant_id = $1 AND ($3::bigint IS NULL OR outlet_id = $3)`,
        [restaurantId, dates && dates.length > 0 ? dates : [businessDate], outletId]
      ),
      // The month so far, against the same number of days of the month
      // before, and how many days each span actually traded.
      pool.query(
        `WITH span AS (
           SELECT DATE_TRUNC('month', $2::date)::date AS month_start,
                  EXTRACT(DAY FROM $2::date)::int AS days_in,
                  (DATE_TRUNC('month', $2::date) - INTERVAL '1 month')::date AS prev_start
         )
         SELECT COALESCE(SUM(b.total_amount) FILTER (
                  WHERE ${BILL_DAY} BETWEEN span.month_start AND $2::date), 0) AS sales,
                COUNT(*) FILTER (
                  WHERE ${BILL_DAY} BETWEEN span.month_start AND $2::date)::int AS bills,
                COUNT(DISTINCT ${BILL_DAY}) FILTER (
                  WHERE ${BILL_DAY} BETWEEN span.month_start AND $2::date)::int AS days_traded,
                COALESCE(SUM(b.total_amount) FILTER (
                  WHERE ${BILL_DAY} BETWEEN span.prev_start
                            AND (span.prev_start + (span.days_in - 1))), 0) AS previous_sales,
                COUNT(DISTINCT ${BILL_DAY}) FILTER (
                  WHERE ${BILL_DAY} BETWEEN span.prev_start
                            AND (span.prev_start + (span.days_in - 1)))::int AS previous_days_traded
         FROM bills b
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         CROSS JOIN span
         WHERE b.restaurant_id = $1 AND ${LIVE}
           AND ($4::bigint IS NULL OR b.outlet_id = $4)
           AND ${BILL_DAY} >= span.prev_start
           AND ${BILL_DAY} <= $2::date
           AND $3::date IS NOT NULL
         GROUP BY span.month_start, span.days_in, span.prev_start`,
        params
      ),
      // Peak hours on the restaurant's clock, for today's bills.
      pool.query(
        `SELECT EXTRACT(HOUR FROM b.billed_at AT TIME ZONE $5)::int AS hour,
                COUNT(*)::int AS bill_count,
                COALESCE(SUM(b.total_amount), 0) AS net_sales
         FROM bills b
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         WHERE ${LIVE} AND ${TODAY_BILLS}
         GROUP BY 1
         ORDER BY 1`,
        today
      ),
      // Today's sales by the business day they were billed in: with All
      // outlets, what each open day (some on an older date) adds to them.
      pool.query(
        `SELECT b.business_day_id,
                COUNT(*)::int AS bill_count,
                COALESCE(SUM(b.total_amount), 0) AS net_sales
         FROM bills b
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         WHERE ${LIVE} AND ${TODAY_BILLS}
         GROUP BY 1`,
        today
      ),
    ]);

  return {
    ...counts,
    today: todaySales.rows[0],
    trend,
    compare: compare.rows[0],
    byMethod: byMethod.rows,
    // No rows: no business day has been opened for this date yet.
    cashDays: cash.rows,
    drawers: await drawers(restaurantId, cash.rows.map((row) => row.id)),
    byType: byType.rows,
    unpaid: unpaid.rows[0],
    returns: returns.rows[0],
    spending: spending.rows[0],
    // No rows when the restaurant has never billed anything.
    month: month.rows[0] || null,
    byHour: byHour.rows,
    byDay: byDay.rows,
  };
};

// Every business day open now — the main counter's and each outlet's own —
// with the outlet's name: what "today" means for the dashboard and the
// reports (report.service tradingDays).
const openDays = async (restaurantId) => {
  const result = await pool.query(
    `SELECT bd.id, bd.business_date, bd.outlet_id, bd.day_status, bd.opened_at, ol.name AS outlet_name
     FROM business_days bd
     LEFT JOIN outlets ol ON ol.id = bd.outlet_id
     WHERE bd.restaurant_id = $1 AND bd.day_status = 'open'
     ORDER BY bd.outlet_id NULLS FIRST, ol.name, bd.id`,
    [restaurantId]
  );

  return result.rows;
};

// "2026-09-24" moved by whole days, without the timezone traps of Date.
const addDaysSql = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

// The kitchen as the dashboard sees it: how many tickets are at each stage
// right now, how many of those still cooking are past the late mark, and when
// the oldest one came in. The same tickets the kitchen display lists (every
// open ticket at this outlet, whatever day it was cut) and the same late rule
// its station chips use, so the two screens never disagree.
//
// Counts only. The kitchen display's own board sends every ticket with its
// dishes, which is far more than a dashboard needs twice a minute.
//
// Read-only: the late mark is read, never created. A restaurant that has not
// opened the kitchen screen yet has no settings row; the column defaults
// (10 and 20 minutes) stand in until it does.
const kitchenNow = async (restaurantId, { outletId = null } = {}) => {
  const settings = await pool.query(
    "SELECT warn_minutes, late_minutes FROM kitchen_settings WHERE restaurant_id = $1",
    [restaurantId]
  );
  const warnMinutes = settings.rows[0] ? settings.rows[0].warn_minutes : 10;
  const lateMinutes = settings.rows[0] ? settings.rows[0].late_minutes : 20;

  // Today's tickets only, as on the kitchen display; tickets left open from
  // an earlier trading day are counted apart (earlier_count).
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE kot_status = 'new' AND created_at >= clock.today_starts)::int AS new_count,
       COUNT(*) FILTER (WHERE kot_status = 'cooking' AND created_at >= clock.today_starts)::int AS cooking_count,
       COUNT(*) FILTER (WHERE kot_status = 'ready' AND created_at >= clock.today_starts)::int AS ready_count,
       COUNT(*) FILTER (WHERE kot_status IN ('new', 'cooking') AND created_at >= clock.today_starts
                          AND created_at <= NOW() - make_interval(mins => $3))::int AS late_count,
       MIN(created_at) FILTER (WHERE kot_status IN ('new', 'cooking') AND created_at >= clock.today_starts) AS oldest_waiting_at,
       COUNT(*) FILTER (WHERE created_at < clock.today_starts)::int AS earlier_count,
       NOW() AS server_time
     FROM kots
     CROSS JOIN (SELECT ${todayStartsSql("$1")} AS today_starts) clock
     WHERE restaurant_id = $1
       AND kot_status IN ('new', 'cooking', 'ready')
       AND ($2::bigint IS NULL OR outlet_id = $2)`,
    [restaurantId, outletId, lateMinutes]
  );

  return { warnMinutes, lateMinutes, ...result.rows[0] };
};

module.exports = {
  dashboard,
  openDays,
  kitchenNow,
};
