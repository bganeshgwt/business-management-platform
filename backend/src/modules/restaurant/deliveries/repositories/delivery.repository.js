const pool = require("../../../../config/database");
const deliveryChargeRepository = require("./deliveryCharge.repository");
const { todayStartsSql } = require("../../orders/repositories/tradingClock");

// Where a delivery order stands, as one SQL expression shared by the board,
// the rider figures, the report and the notification bell.
//
// Two things move an order along and both are honoured: the dispatcher's own
// buttons (delivery_status), and the kitchen display bumping tickets
// (kitchen_status). A kitchen that marks the biryani ready should not also
// have to tell the dispatch desk; a restaurant without a kitchen screen uses
// the desk's "Mark ready" instead. Whichever is further along wins, until the
// food leaves — from then on only the desk knows where it is.
const effectiveStatusSql = (o = "o") => `CASE
    WHEN ${o}.order_status = 'cancelled' OR ${o}.delivery_status = 'cancelled' THEN 'cancelled'
    WHEN ${o}.delivery_status IN ('out_for_delivery', 'delivered') THEN ${o}.delivery_status
    WHEN ${o}.delivery_status = 'ready' OR ${o}.kitchen_status IN ('ready', 'served') THEN 'ready'
    WHEN ${o}.delivery_status = 'preparing' OR ${o}.kitchen_status = 'preparing' THEN 'preparing'
    ELSE 'pending'
  END`;

const LIVE_STATUSES = ["pending", "preparing", "ready", "out_for_delivery"];


// Everything a card on the board needs, in one row per order.
//
// kt: the kitchen's own clock for this order, so "ready 12 min ago" is true
//     even when it was the kitchen screen, not the desk, that said ready —
//     and how many of its tickets the kitchen still has open, so the desk is
//     asked before it calls food packed that the kitchen says is cooking.
// bl: the live bills, so the card can say "Paid online" or "₹640 to collect".
const SELECT_DELIVERY = `
  SELECT o.id, o.order_number, o.order_type, o.order_status, o.kitchen_status, o.source,
         o.outlet_id, o.business_day_id, o.placed_at, o.completed_at, o.notes,
         o.customer_id, o.customer_name, o.customer_mobile, cu.name AS linked_customer_name,
         o.total_amount AS order_total, o.table_id,
         o.channel_id, o.channel_commission_percent, o.delivery_status,
         o.delivery_address, o.delivery_landmark, o.rider_employee_id, o.partner_rider_name,
         o.external_order_ref, o.delivery_eta_minutes, o.delivery_preparing_at,
         o.delivery_ready_at, o.dispatched_at, o.delivered_at, o.delivery_cancelled_at,
         o.delivery_cancel_reason, o.cancel_reason,
         ${effectiveStatusSql("o")} AS effective_status,
         ch.name AS channel_name, ch.channel_type, ch.color AS channel_color,
         ch.status AS channel_status, ch.commission_percent AS channel_current_percent,
         e.name AS rider_name, e.mobile AS rider_mobile,
         kt.started_at AS kitchen_started_at,
         CASE WHEN kt.all_ready THEN kt.ready_at END AS kitchen_ready_at,
         COALESCE(kt.open_tickets, 0) AS kitchen_open_tickets,
         COALESCE(it.item_count, 0) AS item_count,
         COALESCE(it.items, '[]') AS items,
         bl.bill_count, bl.bill_numbers, bl.bill_total, bl.paid_total, bl.first_bill_id,
         pay.methods AS payment_methods
  FROM orders o
  LEFT JOIN customers cu ON cu.id = o.customer_id
  LEFT JOIN sales_channels ch ON ch.id = o.channel_id
  LEFT JOIN employees e ON e.id = o.rider_employee_id
  LEFT JOIN LATERAL (
    SELECT MIN(k.started_at) AS started_at,
           MAX(COALESCE(k.ready_at, k.served_at)) AS ready_at,
           BOOL_AND(k.kot_status IN ('ready', 'served')) AS all_ready,
           COUNT(*) FILTER (WHERE k.kot_status IN ('new', 'cooking'))::int AS open_tickets
    FROM kots k
    WHERE k.order_id = o.id AND k.kot_status <> 'cancelled'
  ) kt ON TRUE
  LEFT JOIN LATERAL (
    SELECT SUM(oi.quantity) AS item_count,
           JSON_AGG(JSON_BUILD_OBJECT('name', oi.item_name, 'variant', oi.variant_name,
                                      'quantity', oi.quantity, 'notes', oi.notes)
                    ORDER BY oi.id) AS items
    FROM order_items oi
    WHERE oi.order_id = o.id AND oi.item_status <> 'cancelled'
  ) it ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS bill_count,
           STRING_AGG(b.bill_number, ', ' ORDER BY b.id) AS bill_numbers,
           SUM(b.total_amount) AS bill_total,
           SUM(b.paid_amount) AS paid_total,
           MIN(b.id) AS first_bill_id
    FROM bills b
    WHERE b.order_id = o.id AND b.bill_status <> 'void'
  ) bl ON TRUE
  -- Reached through the order's bills (bills by order, payments by bill, both
  -- indexed). Payments have no index by order, and asking them by order read
  -- the whole payments table once per card: a day with 1,600 deliveries took
  -- five seconds for the board and ten for the dashboard's summary.
  LEFT JOIN LATERAL (
    SELECT STRING_AGG(DISTINCT p.payment_method, ',') AS methods
    FROM bills b
    JOIN payments p ON p.bill_id = b.id AND p.payment_status = 'success'
    WHERE b.order_id = o.id AND b.bill_status <> 'void'
  ) pay ON TRUE`;

// The restaurant's clock and currency, so every time on the board reads in
// the kitchen's own timezone whatever the browser is set to.
const findLocale = async (restaurantId) => {
  const result = await pool.query(
    "SELECT timezone, currency_symbol FROM restaurant_settings WHERE restaurant_id = $1",
    [restaurantId]
  );

  const row = result.rows[0] || {};

  return { timezone: row.timezone || "Asia/Kolkata", currency: row.currency_symbol || "₹" };
};

// Every open trading day, the one the board is about first: the outlet's
// own day when the desk works in one outlet, the restaurant's own day (no
// outlet) for the whole restaurant. Newest-first alone let a branch that
// opened its day this morning decide "today" for the whole restaurant, whose
// own day — and its orders and bills — started the evening before.
const findOpenDays = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `SELECT id, business_date, outlet_id FROM business_days
     WHERE restaurant_id = $1 AND day_status = 'open'
     ORDER BY (outlet_id IS NOT DISTINCT FROM $2::bigint) DESC, business_date DESC`,
    [restaurantId, outletId || null]
  );

  return result.rows;
};

// The business days of one calendar date (any status): an earlier day picked
// on the board. Every outlet's day of that date for the whole restaurant;
// with an outlet, that outlet's own day and the restaurant's own day (its
// orders taken with All outlets), the same scope the board's orders follow.
const findDaysOn = async (restaurantId, date, outletId = null) => {
  const result = await pool.query(
    `SELECT id, business_date, outlet_id, day_status FROM business_days
     WHERE restaurant_id = $1 AND business_date = $2::date
     ORDER BY (outlet_id IS NOT DISTINCT FROM $3::bigint) DESC, id`,
    [restaurantId, date, outletId || null]
  );

  return result.rows;
};

// A cloud kitchen on a cricket-final night can pass this; past it the oldest
// finished orders are the ones left off, never food still in play.
const BOARD_LIMIT = 800;

// The board: every delivery order of the business days asked for — the open
// day(s) for the live board, or the days of an earlier date picked on it.
// Nothing of an earlier day rides along on today's board, not even food never
// marked delivered (the owner's rule for live screens): it is on its own day,
// one date-pick away. Orders still in play come first and the rest newest
// first, so when the cap bites it is the morning's finished deliveries that
// drop off, and total_count says how many there were.
// `todayOnly` (the live board): every delivery still in play, and of the
// finished ones only those taken this trading day. A business day left open
// for a fortnight made the live board every delivery since, capped at 800.
// `earlier_day`: taken on an earlier trading day (a run nobody closed).
const findBoard = async (restaurantId, { outletId, dayIds, todayOnly = false }) => {
  const result = await pool.query(
    `${SELECT_DELIVERY.replace(
      "SELECT o.id,",
      `SELECT COUNT(*) OVER ()::int AS total_count,
              (o.placed_at < ${todayStartsSql("$1")}) AS earlier_day, o.id,`
    )}
     WHERE o.restaurant_id = $1 AND o.order_type = 'delivery'
       AND ($2::bigint IS NULL OR o.outlet_id = $2)
       AND o.business_day_id = ANY($3::bigint[])
       AND (NOT $6::boolean
            OR (${effectiveStatusSql("o")}) = ANY($4::text[])
            OR o.placed_at >= ${todayStartsSql("$1")})
     ORDER BY (${effectiveStatusSql("o")}) = ANY($4::text[]) DESC, o.placed_at DESC
     LIMIT $5`,
    [restaurantId, outletId || null, dayIds, LIVE_STATUSES, BOARD_LIMIT, Boolean(todayOnly)]
  );

  return {
    rows: result.rows,
    total: result.rows[0] ? result.rows[0].total_count : 0,
    limit: BOARD_LIMIT,
  };
};

const findById = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `${SELECT_DELIVERY}
     WHERE o.restaurant_id = $1 AND o.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const findByIds = async (restaurantId, ids, db = pool) => {
  const result = await db.query(
    `${SELECT_DELIVERY}
     WHERE o.restaurant_id = $1 AND o.id = ANY($2::bigint[])
     ORDER BY o.placed_at`,
    [restaurantId, ids]
  );

  return result.rows;
};

// The delivery team: active employees in the delivery department, plus any
// rider named on today's orders who has since been switched off, so their
// runs still show a name.
const findRiders = async (restaurantId, { outletId, includeIds = [] }) => {
  const result = await pool.query(
    `SELECT e.id, e.name, e.mobile, e.employee_code, e.designation, e.status, e.outlet_id,
            a.check_in, a.check_out
     FROM employees e
     LEFT JOIN restaurant_settings rs ON rs.restaurant_id = e.restaurant_id
     LEFT JOIN attendance a ON a.employee_id = e.id
       AND a.attendance_date = (NOW() AT TIME ZONE COALESCE(rs.timezone, 'Asia/Kolkata'))::date
     WHERE e.restaurant_id = $1
       AND ((e.department = 'delivery' AND e.status = 'active'
             AND ($2::bigint IS NULL OR e.outlet_id IS NULL OR e.outlet_id = $2))
            OR e.id = ANY($3::bigint[]))
     ORDER BY e.name`,
    [restaurantId, outletId || null, includeIds]
  );

  return result.rows;
};

const findEmployee = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT id, name, mobile, department, status FROM employees
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const findChannel = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT id, name, channel_type, commission_percent, status FROM sales_channels
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Only these columns can be written from here. The service decides which of
// them a request touches; anything else on the order belongs to the POS.
const WRITABLE = {
  channelId: "channel_id",
  channelCommissionPercent: "channel_commission_percent",
  deliveryStatus: "delivery_status",
  address: "delivery_address",
  landmark: "delivery_landmark",
  riderId: "rider_employee_id",
  partnerRiderName: "partner_rider_name",
  externalRef: "external_order_ref",
  etaMinutes: "delivery_eta_minutes",
  preparingAt: "delivery_preparing_at",
  readyAt: "delivery_ready_at",
  dispatchedAt: "dispatched_at",
  deliveredAt: "delivered_at",
  cancelledAt: "delivery_cancelled_at",
  cancelReason: "delivery_cancel_reason",
  customerName: "customer_name",
  customerMobile: "customer_mobile",
};

// Timestamps may be given as the word "now", so every order in one run is
// stamped with the database's clock rather than each browser's.
const update = async (restaurantId, id, fields, userId, db = pool) => {
  const sets = [];
  const values = [restaurantId, id, userId];

  for (const [key, column] of Object.entries(WRITABLE)) {
    if (!(key in fields)) {
      continue;
    }

    if (fields[key] === "now") {
      sets.push(`${column} = NOW()`);
    } else {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }

  if (sets.length === 0) {
    return true;
  }

  const result = await db.query(
    `UPDATE orders SET ${sets.join(", ")}, updated_by = $3
     WHERE restaurant_id = $1 AND id = $2 AND order_type = 'delivery'
     RETURNING id`,
    [...values]
  );

  // Another channel, another delivery charge (Swiggy's guest pays Swiggy).
  if (result.rows.length > 0 && "channelId" in fields) {
    await deliveryChargeRepository.refresh(db, id);
  }

  return result.rows.length > 0;
};

// Cancels the order itself, on the connection that already holds its lock.
// These are the statements the orders module's own cancel runs (order and
// lines cancelled, any table freed); they are repeated here because that
// cancel takes the same row lock on a connection of its own, and would wait
// forever behind ours. The kitchen display drops the order on its next sync,
// as it does for any cancelled order.
const cancelOrder = async (client, restaurantId, row, reason, userId) => {
  await client.query(
    `UPDATE orders SET order_status = 'cancelled', cancel_reason = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2 AND order_status = 'open'`,
    [restaurantId, row.id, reason, userId]
  );

  await client.query("UPDATE order_items SET item_status = 'cancelled' WHERE order_id = $1", [row.id]);

  if (row.table_id) {
    await client.query("UPDATE dining_tables SET table_status = 'available' WHERE id = $1", [row.table_id]);
  }
};

// Two dispatchers pressing "Dispatch" on the same order at once, or one
// pressing "Delivered" as another presses "Cancel": the second waits here for
// the first to finish, then reads what it did.
const withLockedOrders = async (restaurantId, ids, work) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT id FROM orders
       WHERE restaurant_id = $1 AND id = ANY($2::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [restaurantId, ids]
    );

    const rows = await findByIds(restaurantId, ids, client);
    const result = await work(client, rows);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// The same test the bills report uses to decide which bills belong to a
// date range, so the channel report and the sales report are always talking
// about the same bills — and add up to the same rupee. $4 is the outlet the
// report is read for (null for the whole restaurant): the outlet switcher
// narrows this report like every other.
const BILL_RANGE = `b.bill_status <> 'void'
  AND b.restaurant_id = $1
  AND COALESCE(bd.business_date, b.billed_at::date) BETWEEN $2::date AND $3::date
  AND ($4::bigint IS NULL OR b.outlet_id = $4::bigint)`;

// Money by where it came from. A tagged order counts under its channel
// whatever kind of order it is; an untagged delivery is called out on its
// own so it can be fixed; everything else falls under its order type.
//
// Commission is worked out per bill at the rate the order was taken at,
// rounded to the paisa like the bill itself, and then summed.
const channelSales = async (restaurantId, from, to, outletId = null) => {
  const result = await pool.query(
    `SELECT CASE
              WHEN o.channel_id IS NOT NULL THEN 'channel'
              WHEN o.order_type = 'delivery' THEN 'untagged'
              ELSE 'type'
            END AS kind,
            o.channel_id,
            CASE WHEN o.channel_id IS NULL AND o.order_type <> 'delivery' THEN o.order_type END
              AS order_type,
            COUNT(DISTINCT o.id)::int AS orders,
            COUNT(*)::int AS bills,
            COALESCE(SUM(b.total_amount), 0) AS gross,
            COALESCE(SUM(ROUND(b.total_amount
                               * COALESCE(o.channel_commission_percent, ch.commission_percent, 0)
                               / 100, 2)), 0) AS commission
     FROM bills b
     JOIN orders o ON o.id = b.order_id
     LEFT JOIN sales_channels ch ON ch.id = o.channel_id
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${BILL_RANGE}
     GROUP BY 1, 2, 3`,
    [restaurantId, from, to, outletId || null]
  );

  return result.rows;
};

// The figure the reconciliation line compares against: every live bill in
// the range, counted straight off the bills table.
const billTotals = async (restaurantId, from, to, outletId = null) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS bills, COALESCE(SUM(b.total_amount), 0) AS gross
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     WHERE ${BILL_RANGE}`,
    [restaurantId, from, to, outletId || null]
  );

  return result.rows[0];
};

// How the deliveries themselves went, by channel and by rider: counted by
// the day the order was placed on, whether or not it has been billed yet.
const deliveryPerformance = async (restaurantId, from, to, slaMinutes, outletId = null) => {
  const params = [restaurantId, from, to, slaMinutes, outletId || null];
  const scope = `o.restaurant_id = $1 AND o.order_type = 'delivery'
       AND COALESCE(bd.business_date, o.placed_at::date) BETWEEN $2::date AND $3::date
       AND ($5::bigint IS NULL OR o.outlet_id = $5::bigint)`;
  const measures = `
     COUNT(*)::int AS orders,
     COUNT(*) FILTER (WHERE ${effectiveStatusSql("o")} = 'delivered')::int AS delivered,
     COUNT(*) FILTER (WHERE ${effectiveStatusSql("o")} = 'cancelled')::int AS cancelled,
     COUNT(o.delivered_at)::int AS timed,
     AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.placed_at)) / 60)
       FILTER (WHERE o.delivered_at IS NOT NULL) AS avg_door_minutes,
     AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.dispatched_at)) / 60)
       FILTER (WHERE o.delivered_at IS NOT NULL AND o.dispatched_at IS NOT NULL) AS avg_ride_minutes,
     COUNT(*) FILTER (WHERE o.delivered_at IS NOT NULL
                        AND o.delivered_at - o.placed_at <= make_interval(mins => $4))::int AS on_time`;

  // Partner riders (Swiggy's, Zomato's, a Porter pickup) are not ours to
  // rank one by one, so they are counted together as one row.
  const [byChannel, byRider] = await Promise.all([
    pool.query(
      `SELECT o.channel_id, ${measures}
       FROM orders o
       LEFT JOIN business_days bd ON bd.id = o.business_day_id
       WHERE ${scope}
       GROUP BY o.channel_id`,
      params
    ),
    pool.query(
      `SELECT o.rider_employee_id, e.name AS rider_name, ${measures}
       FROM orders o
       LEFT JOIN employees e ON e.id = o.rider_employee_id
       LEFT JOIN business_days bd ON bd.id = o.business_day_id
       WHERE ${scope}
         AND (o.rider_employee_id IS NOT NULL OR o.partner_rider_name IS NOT NULL)
       GROUP BY o.rider_employee_id, e.name`,
      params
    ),
  ]);

  return { byChannel: byChannel.rows, byRider: byRider.rows };
};

module.exports = {
  LIVE_STATUSES,
  effectiveStatusSql,
  findLocale,
  findOpenDays,
  findDaysOn,
  findBoard,
  findById,
  findByIds,
  findRiders,
  findEmployee,
  findChannel,
  update,
  cancelOrder,
  withLockedOrders,
  channelSales,
  billTotals,
  deliveryPerformance,
};
