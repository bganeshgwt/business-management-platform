// Rider cash settlement (sweep SW-A-19; migration 1791330000002).
const pool = require("../../../../config/database");

// A rider's delivered bills not yet fully paid, oldest delivery first.
// `outletId`: a till in one outlet settles that outlet's bills; null (All
// outlets / the main counter's screen with no switcher) settles them all.
// `lock`: inside the settling transaction, the bills are locked (in id
// order, so two settlements can never wait on each other).
const findOpenBills = async (db, restaurantId, riderId, outletId, { lock = false } = {}) => {
  const result = await db.query(
    `SELECT b.id, b.bill_number, b.order_id, b.outlet_id, b.business_day_id, b.total_amount, b.paid_amount,
            b.refunded_amount, b.credited_amount, b.bill_status, b.subtotal, b.discount_amount,
            o.table_id, o.customer_id, o.order_number, o.delivered_at,
            COALESCE(o.customer_name, cu.name) AS customer_name,
            bd.business_date::text AS business_date
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN customers cu ON cu.id = o.customer_id
     LEFT JOIN business_days bd ON bd.id = o.business_day_id
     WHERE b.restaurant_id = $1
       AND o.rider_employee_id = $2
       AND o.order_type = 'delivery'
       AND o.delivery_status = 'delivered'
       AND b.bill_status IN ('unpaid', 'partial')
       AND ($3::bigint IS NULL OR b.outlet_id = $3)
     ORDER BY b.id
     ${lock ? "FOR UPDATE OF b" : ""}`,
    [restaurantId, riderId, outletId || null]
  );

  return result.rows;
};

// Delivered by this rider but never billed: the cashier bills them first.
const findUnbilled = async (restaurantId, riderId, outletId) => {
  const result = await pool.query(
    `SELECT o.id, o.order_number, o.total_amount, o.delivered_at
     FROM orders o
     WHERE o.restaurant_id = $1 AND o.rider_employee_id = $2
       AND o.order_type = 'delivery' AND o.delivery_status = 'delivered'
       AND o.order_status = 'open'
       AND ($3::bigint IS NULL OR o.outlet_id = $3)
       AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.order_id = o.id AND b.bill_status <> 'void')
     ORDER BY o.delivered_at`,
    [restaurantId, riderId, outletId || null]
  );

  return result.rows;
};

const insert = async (client, restaurantId, data, userId) => {
  const result = await client.query(
    `INSERT INTO rider_settlements (restaurant_id, outlet_id, business_day_id, rider_employee_id, bill_count,
                                    cash_expected, cash_handed, upi_amount, shortfall, shortfall_action,
                                    shortfall_reason, approved_by, settled_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      restaurantId,
      data.outletId || null,
      data.businessDayId || null,
      data.riderId,
      data.bills.length,
      data.cashExpected,
      data.cashHanded,
      data.upiAmount,
      data.shortfall,
      data.shortfallAction,
      data.shortfallReason || null,
      data.approvedBy || null,
      userId,
    ]
  );
  const id = result.rows[0].id;

  for (const bill of data.bills) {
    await client.query(
      `INSERT INTO rider_settlement_bills (settlement_id, bill_id, order_id, amount, payment_method)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, bill.billId, bill.orderId, bill.amount, bill.method]
    );
  }

  return id;
};

const SETTLEMENT_SELECT = `
  SELECT s.id, s.outlet_id, s.business_day_id, s.rider_employee_id, e.name AS rider_name,
         s.bill_count, s.cash_expected, s.cash_handed, s.upi_amount, s.shortfall, s.shortfall_action,
         s.shortfall_reason, s.settled_at, u.name AS settled_by_name, a.name AS approved_by_name,
         s.repaid_at, r.name AS repaid_by_name, ou.name AS outlet_name,
         bd.business_date::text AS business_date,
         COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('billId', sb.bill_id, 'billNumber', b.bill_number,
                                                     'orderNumber', o.order_number, 'amount', sb.amount,
                                                     'method', sb.payment_method) ORDER BY sb.bill_id)
                   FROM rider_settlement_bills sb
                   JOIN bills b ON b.id = sb.bill_id
                   JOIN orders o ON o.id = sb.order_id
                   WHERE sb.settlement_id = s.id), '[]') AS bills
  FROM rider_settlements s
  JOIN employees e ON e.id = s.rider_employee_id
  LEFT JOIN users u ON u.id = s.settled_by
  LEFT JOIN users a ON a.id = s.approved_by
  LEFT JOIN users r ON r.id = s.repaid_by
  LEFT JOIN outlets ou ON ou.id = s.outlet_id
  LEFT JOIN business_days bd ON bd.id = s.business_day_id`;

const findById = async (restaurantId, id, db = pool) => {
  const result = await db.query(`${SETTLEMENT_SELECT} WHERE s.restaurant_id = $1 AND s.id = $2`, [restaurantId, id]);

  return result.rows[0] || null;
};

// One business date's settlements (every outlet's day on that date, or one
// outlet's), newest first, a page at a time; with the day's totals.
const findForDate = async (restaurantId, { date, outletId, limit, offset }) => {
  const where = `s.restaurant_id = $1 AND bd.business_date = $2::date
                 AND ($3::bigint IS NULL OR s.outlet_id = $3)`;
  const [rows, totals] = await Promise.all([
    pool.query(
      `${SETTLEMENT_SELECT}
       WHERE ${where}
       ORDER BY s.settled_at DESC, s.id DESC
       LIMIT $4 OFFSET $5`,
      [restaurantId, date, outletId || null, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(s.bill_count), 0)::int AS bills,
              COALESCE(SUM(s.cash_expected), 0) AS cash_expected, COALESCE(SUM(s.cash_handed), 0) AS cash_handed,
              COALESCE(SUM(s.upi_amount), 0) AS upi_amount, COALESCE(SUM(s.shortfall), 0) AS shortfall
       FROM rider_settlements s
       LEFT JOIN business_days bd ON bd.id = s.business_day_id
       WHERE ${where}`,
      [restaurantId, date, outletId || null]
    ),
  ]);

  return { rows: rows.rows, totals: totals.rows[0] };
};

// Shortfalls riders still owe, any day (they are a debt until handed over).
const findOwed = async (restaurantId, outletId) => {
  const result = await pool.query(
    `${SETTLEMENT_SELECT}
     WHERE s.restaurant_id = $1 AND s.shortfall_action = 'owed' AND s.repaid_at IS NULL
       AND ($2::bigint IS NULL OR s.outlet_id = $2)
     ORDER BY s.settled_at`,
    [restaurantId, outletId || null]
  );

  return result.rows;
};

// The shortfall handed over into one business day's drawer (`dayId`, the
// day open at the settlement's till — see the service). Only while that day
// is still open: a day closed a moment ago has been counted, and cash marked
// into it would be in no drawer.
const markRepaid = async (restaurantId, id, outletId, userId, dayId) => {
  const result = await pool.query(
    `UPDATE rider_settlements SET repaid_at = NOW(), repaid_by = $4, repaid_business_day_id = $5
     WHERE restaurant_id = $1 AND id = $2 AND ($3::bigint IS NULL OR outlet_id = $3)
       AND shortfall_action = 'owed' AND repaid_at IS NULL
       AND EXISTS (SELECT 1 FROM business_days bd
                   WHERE bd.restaurant_id = $1 AND bd.id = $5 AND bd.day_status = 'open')
     RETURNING id`,
    [restaurantId, id, outletId || null, userId, dayId]
  );

  return result.rows[0] || null;
};

module.exports = { findOpenBills, findUnbilled, insert, findById, findForDate, findOwed, markRepaid };
