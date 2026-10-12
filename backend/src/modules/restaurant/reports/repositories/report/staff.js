// Staff queries: staff, waiter and captain-section figures.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { BILL_DAY, BILL_LINES, BILL_SCOPE, LIVE, VOIDED_BILL_OF_REMOVAL, scopeParams } = require("./sql");

// Who raised the bills: the cashier's view.
const staffReport = async (scope) => {
  const result = await pool.query(
    `SELECT COALESCE(u.name, 'Unknown') AS user_name,
            COUNT(DISTINCT b.id)::int AS bill_count,
            COALESCE(SUM(b.total_amount), 0) AS net_sales,
            COALESCE(AVG(b.total_amount), 0) AS average_bill
     FROM bills b
     LEFT JOIN users u ON u.id = b.created_by
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${LIVE} AND ${BILL_SCOPE}
     GROUP BY 1
     ORDER BY net_sales DESC`,
    scopeParams(scope)
  );

  return result.rows;
};

// Who took the orders: the captain's and waiter's view. The staff report
// credits whoever raised the bill, which at most restaurants is the cashier,
// so it could never say which waiter sells and which one only carries plates.
// Credit goes to the person who opened the order.
const waiterReport = async (scope) => {
  const params = scopeParams(scope);
  const [sales, items, removed] = await Promise.all([
    pool.query(
      `SELECT o.created_by AS user_id,
              COALESCE(u.name, 'Unknown') AS user_name,
              COUNT(DISTINCT o.id)::int AS order_count,
              COUNT(DISTINCT o.id) FILTER (WHERE o.order_type = 'dine_in')::int AS dine_in_orders,
              COALESCE(SUM(b.total_amount), 0) AS net_sales,
              COALESCE(SUM(b.total_amount) FILTER (WHERE o.order_type = 'dine_in'), 0) AS dine_in_sales,
              COALESCE(SUM(b.total_amount) FILTER (WHERE o.order_type = 'takeaway'), 0) AS takeaway_sales,
              COALESCE(SUM(b.total_amount) FILTER (WHERE o.order_type = 'delivery'), 0) AS delivery_sales,
              COALESCE(SUM(b.discount_amount), 0) AS discounts
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE ${LIVE} AND ${BILL_SCOPE}
       GROUP BY o.created_by, u.name
       ORDER BY net_sales DESC`,
      params
    ),
    pool.query(
      `SELECT o.created_by AS user_id, COALESCE(SUM(l.quantity), 0) AS plates
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       ${BILL_LINES}
       WHERE ${LIVE} AND ${BILL_SCOPE}
       GROUP BY o.created_by`,
      params
    ),
    // Dishes taken off after the kitchen had them, charged to the person
    // whose order it was, beside what they sold.
    //
    // As in theft control, a dish taken off only to close out a bill that
    // had already been voided is not counted again: the void is the event,
    // and counting both charged the same plates twice. It is counted apart
    // (covered_count) so the screen can say so.
    //
    // By name as well as id: someone whose every order was cancelled after
    // the kitchen had it has no sales row, and is exactly who this column
    // is for.
    pool.query(
      `SELECT o.created_by AS user_id,
              COALESCE(u.name, 'Unknown') AS user_name,
              COUNT(*) FILTER (WHERE vd.bill_number IS NULL)::int AS removed_count,
              COALESCE(SUM(c.amount) FILTER (WHERE vd.bill_number IS NULL), 0) AS removed_value,
              COUNT(*) FILTER (WHERE vd.bill_number IS NOT NULL)::int AS covered_count
       FROM order_item_cancellations c
       JOIN orders o ON o.id = c.order_id
       LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN business_days bd ON bd.id = c.business_day_id
       ${VOIDED_BILL_OF_REMOVAL("c")}
       WHERE c.restaurant_id = $1 AND c.after_kot
         AND COALESCE(bd.business_date, (c.created_at AT TIME ZONE $5)::date) BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR c.outlet_id = $4)
       GROUP BY o.created_by, u.name`,
      params
    ),
  ]);

  return { sales: sales.rows, items: items.rows, removed: removed.rows };
};

// Dine-in sales by captain section: each dine-in bill under the captain who
// held its table on the bill's business date (captain_assignments: a table
// given to someone wins over their area, an area over the floor — as the
// floor plan reads it). Tables nobody was given are counted under no captain.
const captainSections = async (scope) => {
  const result = await pool.query(
    `SELECT ca.user_id AS captain_id, cu.name AS captain_name,
            STRING_AGG(DISTINCT COALESCE(ct.table_no, ar.name, fl.name), ', ') AS sections,
            COUNT(DISTINCT o.id)::int AS order_count,
            COUNT(DISTINCT t.id)::int AS table_count,
            COALESCE(SUM(b.total_amount), 0) AS net_sales,
            COALESCE(SUM(o.guest_count) FILTER (WHERE o.guest_count > 0), 0)::int AS guests
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN LATERAL (
       SELECT x.user_id, x.floor_id, x.area_id, x.table_id
       FROM captain_assignments x
       WHERE x.restaurant_id = b.restaurant_id AND x.shift_date = ${BILL_DAY}
         AND (x.table_id = t.id OR x.area_id = t.area_id OR x.floor_id = t.floor_id)
       ORDER BY (x.table_id IS NOT NULL) DESC, (x.area_id IS NOT NULL) DESC
       LIMIT 1
     ) ca ON TRUE
     LEFT JOIN users cu ON cu.id = ca.user_id
     LEFT JOIN dining_tables ct ON ct.id = ca.table_id
     LEFT JOIN dining_areas ar ON ar.id = ca.area_id
     LEFT JOIN floors fl ON fl.id = ca.floor_id
     WHERE ${LIVE} AND ${BILL_SCOPE} AND o.order_type = 'dine_in'
     GROUP BY ca.user_id, cu.name
     ORDER BY net_sales DESC`,
    scopeParams(scope)
  );

  return result.rows;
};

module.exports = {
  staffReport,
  waiterReport,
  captainSections,
};
