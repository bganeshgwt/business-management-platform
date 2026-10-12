// Sales queries: summary, by day / hour / order type / payment, covers, outlet comparison, discounts, cancellations.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { BILL_DAY, BILL_SCOPE, LIVE, scopeParams } = require("./sql");

// ===========================================================================
// Sales
// ===========================================================================

const salesSummary = async (scope) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS bill_count,
            COALESCE(SUM(b.subtotal), 0) AS gross_sales,
            COALESCE(SUM(b.discount_amount), 0) AS discounts,
            COALESCE(SUM(b.tax_amount), 0) AS tax,
            COALESCE(SUM(b.cess_amount), 0) AS cess,
            COALESCE(SUM(b.service_charge), 0) AS service_charge,
            COALESCE(SUM(b.round_off), 0) AS round_off,
            COALESCE(SUM(b.total_amount), 0) AS net_sales,
            COALESCE(SUM(b.paid_amount), 0) AS collected,
            COALESCE(SUM(b.refunded_amount), 0) AS refunded,
            COALESCE(AVG(b.total_amount), 0) AS average_bill,
            -- Delivery charges billed (inside the totals above), with their GST.
            COALESCE(SUM(b.delivery_charge), 0) AS delivery_charges,
            COALESCE(SUM(b.delivery_charge_tax), 0) AS delivery_charge_tax,
            COUNT(*) FILTER (WHERE b.delivery_charge > 0)::int AS delivery_charge_bills
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${LIVE} AND ${BILL_SCOPE}`,
    scopeParams(scope)
  );

  return result.rows[0];
};

// Every day in the range, including the ones that sold nothing. A closed
// Monday left out of the list is drawn as a straight line from Sunday to
// Tuesday, which reads as steady trade instead of a zero.
const salesByDay = async (scope) => {
  const result = await pool.query(
    `WITH days AS (
       SELECT day::date AS business_date
       FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS day
     ), sold AS (
       SELECT ${BILL_DAY} AS business_date,
              COUNT(*)::int AS bill_count,
              SUM(b.total_amount) AS net_sales,
              SUM(b.discount_amount) AS discounts
       FROM bills b
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE ${LIVE} AND ${BILL_SCOPE}
       GROUP BY 1
     )
     SELECT days.business_date,
            COALESCE(sold.bill_count, 0)::int AS bill_count,
            COALESCE(sold.net_sales, 0) AS net_sales,
            COALESCE(sold.discounts, 0) AS discounts,
            CASE WHEN COALESCE(sold.bill_count, 0) > 0
                 THEN sold.net_sales / sold.bill_count ELSE 0 END AS average_bill
     FROM days
     LEFT JOIN sold ON sold.business_date = days.business_date
     ORDER BY 1`,
    scopeParams(scope)
  );

  return result.rows;
};

// Peak hours on the restaurant's clock, the same way the dashboard reads them.
const salesByHour = async (scope) => {
  const result = await pool.query(
    `SELECT EXTRACT(HOUR FROM b.billed_at AT TIME ZONE $5)::int AS hour,
            COUNT(*)::int AS bill_count,
            COALESCE(SUM(b.total_amount), 0) AS net_sales
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${LIVE} AND ${BILL_SCOPE}
     GROUP BY 1
     ORDER BY 1`,
    scopeParams(scope)
  );

  return result.rows;
};

const orderTypes = async (scope) => {
  const result = await pool.query(
    `SELECT o.order_type,
            COUNT(*)::int AS bill_count,
            COALESCE(SUM(b.total_amount), 0) AS net_sales,
            COALESCE(AVG(b.total_amount), 0) AS average_bill
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${LIVE} AND ${BILL_SCOPE}
     GROUP BY 1
     ORDER BY net_sales DESC`,
    scopeParams(scope)
  );

  return result.rows;
};

const paymentModes = async (scope) => {
  const result = await pool.query(
    `SELECT p.payment_method,
            COUNT(*)::int AS payment_count,
            COALESCE(SUM(p.amount), 0) AS amount,
            -- Tips given on top of these payments (never in the amount).
            COALESCE(SUM(p.tip_amount), 0) AS tips
     FROM payments p
     JOIN bills b ON b.id = p.bill_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${LIVE} AND ${BILL_SCOPE} AND p.payment_status = 'success'
     GROUP BY 1
     ORDER BY amount DESC`,
    scopeParams(scope)
  );

  return result.rows;
};

// The owner's named payment types (a meal card, a cheque, a Zomato Pay)
// taken on the range's bills, each under its method: what a card company's
// settlement is checked against.
const paymentTypes = async (scope) => {
  const result = await pool.query(
    `SELECT p.payment_method, pt.id AS payment_type_id, pt.name AS payment_type_name,
            COUNT(*)::int AS payment_count,
            COALESCE(SUM(p.amount), 0) AS amount
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     JOIN bills b ON b.id = p.bill_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${LIVE} AND ${BILL_SCOPE} AND p.payment_status = 'success'
     GROUP BY 1, 2, 3
     ORDER BY amount DESC`,
    scopeParams(scope)
  );

  return result.rows;
};

// Covers and spend per head — ONE definition, used by the dashboard, the
// sales report, the outlet comparison, the waiter report and the day-end
// sheet, so no two screens can disagree about it.
//
//   covers    guests at dine-in tables whose order was billed in the range,
//             each order counted once however many bills it was split into
//   per head  what THOSE tables were billed, divided by those guests
//
// Takeaway and delivery have no guests, and a dine-in order with no guest
// count has none either; dividing all sales by dine-in guests reported a
// figure fifteen times too high. Their sales stay in every other figure —
// they just take no part in a per-head number.
//
// `groupBy` splits the figures by a column of the order (o.created_by for
// the waiter report, b.outlet_id for outlets); NULL gives one row.
const covers = async (scope, groupBy = null) => {
  const key = groupBy || "NULL::bigint";
  const result = await pool.query(
    `WITH billed AS (
       SELECT b.order_id, ${key} AS group_key, SUM(b.total_amount) AS sales
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE ${LIVE} AND ${BILL_SCOPE} AND o.order_type = 'dine_in'
       GROUP BY b.order_id, ${key}
     )
     SELECT billed.group_key,
            COUNT(*)::int AS dine_in_orders,
            COALESCE(SUM(billed.sales), 0) AS dine_in_sales,
            COALESCE(SUM(o.guest_count) FILTER (WHERE o.guest_count > 0), 0)::int AS covers,
            COALESCE(SUM(billed.sales) FILTER (WHERE o.guest_count > 0), 0) AS covered_sales,
            COUNT(*) FILTER (WHERE COALESCE(o.guest_count, 0) = 0)::int AS without_guests
     FROM billed
     JOIN orders o ON o.id = billed.order_id
     GROUP BY billed.group_key`,
    scopeParams(scope)
  );

  return result.rows;
};

// ===========================================================================
// Outlets
// ===========================================================================

// One row per outlet, so branches can be put side by side. Always the whole
// chain — a comparison of one outlet with itself answers nothing — so the
// outlet switcher does not narrow this one.
//
// Bills raised with no outlet are gathered under a plain label rather than
// dropped: money that exists has to appear somewhere or the totals stop
// matching the sales report.
const outletComparison = async (scope) => {
  const result = await pool.query(
    `SELECT b.outlet_id,
            COALESCE(ol.name, 'Main counter') AS outlet_name,
            ol.code AS outlet_code,
            COUNT(*)::int AS bill_count,
            COALESCE(SUM(b.total_amount), 0) AS net_sales,
            COALESCE(SUM(b.subtotal), 0) AS gross_sales,
            COALESCE(SUM(b.tax_amount), 0) AS tax,
            COALESCE(SUM(b.discount_amount), 0) AS discounts,
            COALESCE(AVG(b.total_amount), 0) AS average_bill
     FROM bills b
     LEFT JOIN outlets ol ON ol.id = b.outlet_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${LIVE} AND ${BILL_SCOPE}
     GROUP BY b.outlet_id, ol.name, ol.code
     ORDER BY net_sales DESC`,
    scopeParams({ ...scope, outletId: null })
  );

  return result.rows;
};

// ===========================================================================
// Discounts, staff, cancellations
// ===========================================================================

// Every rupee taken off a bill, by what took it off. A bill keeps each kind
// apart (coupon, till discount on the bill or on dishes, points, no-charge),
// so they are reported apart: points a guest redeems are their own money, not
// a discount anyone gave, and lumping them in as "Manual" sent an owner
// looking for a cashier who had given nothing. One bill with a coupon and
// points is a row under each.
//
// kind: coupon | till | points | complimentary | other (bills from before the
// kinds were kept apart, whose discount is one figure).
const discountReport = async (scope) => {
  const result = await pool.query(
    `WITH x AS (
       SELECT b.id, b.total_amount, b.discount_code, b.discount_reason, b.is_complimentary,
              b.discount_amount, b.coupon_discount, b.loyalty_discount, b.loyalty_points_used,
              COALESCE(b.manual_discount_amount, 0) + COALESCE(b.item_discount_amount, 0) AS till_discount
       FROM bills b
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE ${LIVE} AND ${BILL_SCOPE} AND b.discount_amount > 0
     ), parts AS (
       SELECT 'complimentary' AS kind, 'No charge' AS discount_code, NULL::varchar AS reason,
              id, total_amount, discount_amount AS amount, 0 AS points
       FROM x WHERE is_complimentary
       UNION ALL
       SELECT 'coupon', discount_code, NULL, id, total_amount, coupon_discount, 0
       FROM x WHERE NOT is_complimentary AND coupon_discount > 0
       UNION ALL
       SELECT 'till', 'Till discount', discount_reason, id, total_amount, till_discount, 0
       FROM x WHERE NOT is_complimentary AND till_discount > 0
       UNION ALL
       SELECT 'points', 'Points redeemed', NULL, id, total_amount, loyalty_discount, COALESCE(loyalty_points_used, 0)
       FROM x WHERE NOT is_complimentary AND loyalty_discount > 0
       UNION ALL
       SELECT 'other', COALESCE(discount_code, 'Discount (older bill)'), NULL, id, total_amount,
              discount_amount - coupon_discount - till_discount - loyalty_discount, 0
       FROM x
       WHERE NOT is_complimentary
         AND discount_amount - coupon_discount - till_discount - loyalty_discount > 0.004
     )
     SELECT kind, discount_code, reason,
            COUNT(DISTINCT id)::int AS times_used,
            COALESCE(SUM(amount), 0) AS discount_total,
            COALESCE(SUM(points), 0)::int AS points,
            COALESCE(SUM(total_amount), 0) AS net_sales
     FROM parts
     GROUP BY kind, discount_code, reason
     ORDER BY discount_total DESC, kind, discount_code`,
    scopeParams(scope)
  );

  return result.rows;
};

// Cancelled orders and voided bills: what did not turn into money.
//
// Both are filed under the business day they belong to — the order's day,
// the bill's day — never the calendar date: a void at 00:40 on a night still
// trading is part of that night's report, which is exactly when a void is
// worth reading. Who did it comes from the activity log (the person who
// cancelled or voided, and the manager who approved it), not from whoever
// last touched the record.
// Each row carries its list's totals over every row (window functions);
// a page past the end has no row to carry them (the service then asks again
// for the first row).
const cancellationReport = async (scope, limit = 1000, { voidOffset = 0, cancelOffset = 0 } = {}) => {
  const params = scopeParams(scope);
  const [cancelled, voided] = await Promise.all([
    pool.query(
      `SELECT o.id, o.order_number, o.order_type, o.total_amount, o.cancel_reason, o.placed_at,
              COALESCE(bd.business_date, (o.placed_at AT TIME ZONE $5)::date) AS business_date,
              COALESCE(log.user_name, u.name) AS cancelled_by,
              log.approver_name AS approved_by,
              COALESCE(log.created_at, o.updated_at) AS cancelled_at,
              COUNT(*) OVER ()::int AS total_count,
              SUM(o.total_amount) OVER () AS total_value
       FROM orders o
       LEFT JOIN business_days bd ON bd.id = o.business_day_id
       LEFT JOIN users u ON u.id = o.updated_by
       LEFT JOIN LATERAL (
         SELECT a.user_name, a.approver_name, a.created_at
         FROM audit_logs a
         WHERE a.restaurant_id = $1 AND a.entity_type = 'order' AND a.action = 'cancel'
           AND a.entity_id = o.id
         ORDER BY a.created_at DESC
         LIMIT 1
       ) log ON TRUE
       WHERE o.restaurant_id = $1 AND o.order_status = 'cancelled'
         AND COALESCE(bd.business_date, (o.placed_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR o.outlet_id = $4)
       ORDER BY o.placed_at DESC
       LIMIT $6 OFFSET $7`,
      [...params, limit, cancelOffset]
    ),
    pool.query(
      `SELECT b.id, b.bill_number, o.order_number, b.total_amount, b.void_reason, b.billed_at,
              ${BILL_DAY} AS business_date,
              COALESCE(log.user_name, u.name) AS voided_by,
              log.approver_name AS approved_by,
              COALESCE(log.created_at, b.updated_at) AS voided_at,
              COUNT(*) OVER ()::int AS total_count,
              SUM(b.total_amount) OVER () AS total_value
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       LEFT JOIN users u ON u.id = b.updated_by
       LEFT JOIN LATERAL (
         SELECT a.user_name, a.approver_name, a.created_at
         FROM audit_logs a
         WHERE a.restaurant_id = $1 AND a.entity_type = 'bill' AND a.action = 'void'
           AND a.entity_id = b.id
         ORDER BY a.created_at DESC
         LIMIT 1
       ) log ON TRUE
       WHERE b.bill_status = 'void' AND ${BILL_SCOPE}
       ORDER BY b.billed_at DESC
       LIMIT $6 OFFSET $7`,
      [...params, limit, voidOffset]
    ),
  ]);

  return { cancelledOrders: cancelled.rows, voidedBills: voided.rows };
};

module.exports = {
  salesSummary,
  salesByDay,
  salesByHour,
  orderTypes,
  paymentModes,
  paymentTypes,
  covers,
  outletComparison,
  discountReport,
  cancellationReport,
};
