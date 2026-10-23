const pool = require("../../../../config/database");
const queryAll = require("../../../../utils/queryAll");
const { DRAWER_PARTS } = require("../../reports/repositories/report.repository");
const { OF_TILL, SUPPLIER_CASH_OF_DAY } = require("./tillRules");

// Cash drawers per shift, cash taken in or out of a drawer, and the figures a
// cash-up needs. A drawer's money is what its cashier recorded while it was
// open: payments and refunds they entered between its opening and its close,
// on its business day.

const DRAWER_COLUMNS = `d.id, d.business_day_id, d.outlet_id, d.cashier_id, d.label, d.drawer_status,
                        d.opening_float, d.opened_at, d.closed_at, d.counted_cash, d.count_method,
                        d.count_denominations, d.blind_count, d.first_count, d.expected_cash,
                        d.cash_variance, d.variance_reason, d.notes,
                        cu.name AS cashier_name, ou.name AS opened_by_name, xu.name AS closed_by_name,
                        bd.business_date, bd.day_status, ol.name AS outlet_name`;

const DRAWER_FROM = `FROM cash_drawers d
     JOIN business_days bd ON bd.id = d.business_day_id
     LEFT JOIN users cu ON cu.id = d.cashier_id
     LEFT JOIN users ou ON ou.id = d.opened_by
     LEFT JOIN users xu ON xu.id = d.closed_by
     LEFT JOIN outlets ol ON ol.id = d.outlet_id`;

const createDrawer = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO cash_drawers (restaurant_id, business_day_id, outlet_id, cashier_id, label,
                               opening_float, notes, opened_by, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)
     RETURNING id`,
    [restaurantId, data.businessDayId, data.outletId || null, data.cashierId, data.label || null, data.openingFloat, data.notes || null, userId]
  );

  return result.rows[0].id;
};

// db: the pool, or the client of a transaction that holds the day (see lockDay).
const findDrawer = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${DRAWER_COLUMNS} ${DRAWER_FROM}
     WHERE d.restaurant_id = $1 AND d.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const listDrawers = async (restaurantId, dayId) => {
  const result = await pool.query(
    `SELECT ${DRAWER_COLUMNS} ${DRAWER_FROM}
     WHERE d.restaurant_id = $1 AND d.business_day_id = $2
     ORDER BY d.opened_at, d.id`,
    [restaurantId, dayId]
  );

  return result.rows;
};

const findOpenDrawerOf = async (restaurantId, dayId, cashierId) => {
  const result = await pool.query(
    `SELECT ${DRAWER_COLUMNS} ${DRAWER_FROM}
     WHERE d.restaurant_id = $1 AND d.business_day_id = $2 AND d.cashier_id = $3 AND d.drawer_status = 'open'`,
    [restaurantId, dayId, cashierId]
  );

  return result.rows[0] || null;
};

// data: { countedCash, countMethod, denominations, blindCount, expectedCash,
//         variance, varianceReason, notes }
const closeDrawer = async (restaurantId, id, data, userId, db = pool) => {
  const result = await db.query(
    `UPDATE cash_drawers
     SET drawer_status = 'closed', closed_at = NOW(), closed_by = $3, updated_by = $3,
         counted_cash = $4, count_method = $5, count_denominations = $6, blind_count = $7,
         expected_cash = $8, cash_variance = $9, variance_reason = $10,
         notes = COALESCE($11, notes), first_count = COALESCE(first_count, $4)
     WHERE restaurant_id = $1 AND id = $2 AND drawer_status = 'open'
     RETURNING id`,
    [
      restaurantId,
      id,
      userId,
      data.countedCash,
      data.countMethod || null,
      data.denominations ? JSON.stringify(data.denominations) : null,
      Boolean(data.blindCount),
      data.expectedCash,
      data.variance,
      data.varianceReason || null,
      data.notes || null,
    ]
  );

  return result.rows[0] || null;
};

const keepDrawerFirstCount = async (restaurantId, id, counted) => {
  await pool.query(
    `UPDATE cash_drawers SET first_count = $3
     WHERE restaurant_id = $1 AND id = $2 AND drawer_status = 'open' AND first_count IS NULL`,
    [restaurantId, id, counted]
  );
};

// --- Money in a drawer ----------------------------------------------------------

const AT = (alias) => `COALESCE(${alias}.paid_at, ${alias}.created_at)`;

// What one cashier took and gave back while their drawer was open, by method;
// and the bills they raised in that time.
const drawerTakings = async (restaurantId, drawer, db = pool) => {
  const params = [restaurantId, drawer.business_day_id, drawer.cashier_id, drawer.opened_at, drawer.closed_at || null];
  const [payments, refunds, bills, riders, advances] = await queryAll(db, [
    () => db.query(
      `SELECT p.payment_method AS method, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::int AS count,
              COALESCE(SUM(p.tip_amount), 0) AS tips
       FROM payments p
       WHERE p.restaurant_id = $1 AND p.business_day_id = $2 AND p.created_by = $3
         AND p.payment_status = 'success'
         AND ${AT("p")} >= $4 AND ($5::timestamptz IS NULL OR ${AT("p")} < $5)
       GROUP BY p.payment_method`,
      params
    ),
    () => db.query(
      `SELECT r.refund_method AS method, COALESCE(SUM(r.amount), 0) AS amount, COUNT(*)::int AS count
       FROM refunds r
       WHERE r.restaurant_id = $1 AND r.business_day_id = $2 AND r.created_by = $3
         AND COALESCE(r.refunded_at, r.created_at) >= $4
         AND ($5::timestamptz IS NULL OR COALESCE(r.refunded_at, r.created_at) < $5)
       GROUP BY r.refund_method`,
      params
    ),
    () => db.query(
      `SELECT COUNT(*) FILTER (WHERE b.bill_status <> 'void')::int AS bill_count,
              COALESCE(SUM(b.total_amount) FILTER (WHERE b.bill_status <> 'void'), 0) AS sales,
              COALESCE(SUM(b.discount_amount) FILTER (WHERE b.bill_status <> 'void'), 0) AS discounts,
              COUNT(*) FILTER (WHERE b.bill_status = 'void')::int AS void_count
       FROM bills b
       WHERE b.restaurant_id = $1 AND b.business_day_id = $2 AND b.created_by = $3
         AND b.billed_at >= $4 AND ($5::timestamptz IS NULL OR b.billed_at < $5)`,
      params
    ),
    // Riders this cashier settled during the shift: the cash short never
    // reached this drawer; an owed shortfall handed over to this cashier did.
    () => db.query(
      `SELECT COALESCE(SUM(rs.shortfall) FILTER (
                WHERE rs.business_day_id = $2 AND rs.settled_by = $3
                  AND rs.settled_at >= $4 AND ($5::timestamptz IS NULL OR rs.settled_at < $5)), 0) AS shortfall,
              COALESCE(SUM(rs.shortfall) FILTER (
                WHERE rs.repaid_business_day_id = $2 AND rs.repaid_by = $3
                  AND rs.repaid_at >= $4 AND ($5::timestamptz IS NULL OR rs.repaid_at < $5)), 0) AS repaid
       FROM rider_settlements rs
       WHERE rs.restaurant_id = $1 AND (rs.business_day_id = $2 OR rs.repaid_business_day_id = $2)`,
      params
    ),
    // Advances this cashier took in cash during the shift, and unused ones
    // they handed back in cash.
    () => db.query(
      `SELECT COALESCE((SELECT SUM(ca.amount) FROM customer_advances ca
                WHERE ca.restaurant_id = $1 AND ca.business_day_id = $2 AND ca.created_by = $3
                  AND ca.payment_method = 'cash'
                  AND ca.received_at >= $4 AND ($5::timestamptz IS NULL OR ca.received_at < $5)), 0) AS taken,
              COALESCE((SELECT SUM(car.amount) FROM customer_advance_refunds car
                WHERE car.restaurant_id = $1 AND car.business_day_id = $2 AND car.created_by = $3
                  AND car.refund_method = 'cash'
                  AND car.refunded_at >= $4 AND ($5::timestamptz IS NULL OR car.refunded_at < $5)), 0) AS returned`,
      params
    ),
  ]);

  return {
    payments: payments.rows,
    refunds: refunds.rows,
    bills: bills.rows[0],
    riders: riders.rows[0],
    advances: advances.rows[0],
  };
};

// Cash paid out of the till by anyone while this drawer was the only one open
// at its till: supplier payments made from this till (tillRules: an outlet
// with a day of its own pays out of its own drawer) and cash expenses entered on the Expenses
// screen (petty cash entered on the drawer screen is already the drawer's
// own). A morning and an evening cashier at one counter: whatever the owner
// paid the vegetable man at 11 came out of the morning drawer. With two
// drawers open at once nobody can say whose drawer it came out of, so it is
// left to the day's own count.
const drawerPayouts = async (restaurantId, drawer, db = pool) => {
  const result = await db.query(
    `WITH day AS (
       SELECT id, business_date, outlet_id, restaurant_id FROM business_days WHERE restaurant_id = $1 AND id = $2
     ),
     outs AS (
       SELECT sp.amount, sp.created_at AS at, 'supplier' AS kind
       FROM supplier_payments sp, day
       WHERE sp.restaurant_id = $1 AND sp.paid_from_till AND sp.payment_status = 'posted'
         AND sp.business_date = day.business_date AND ${OF_TILL("sp", "day")}
       UNION ALL
       SELECT e.amount, e.created_at AS at, 'expense' AS kind
       FROM expenses e, day
       WHERE e.restaurant_id = $1 AND e.payment_mode = 'cash' AND e.expense_status <> 'rejected'
         AND e.expense_date = day.business_date
         AND ${OF_TILL("e", "day")}
         AND NOT EXISTS (SELECT 1 FROM cash_movements cm WHERE cm.expense_id = e.id)
     )
     SELECT COALESCE(SUM(outs.amount) FILTER (WHERE outs.kind = 'supplier'), 0) AS supplier_cash,
            COALESCE(SUM(outs.amount) FILTER (WHERE outs.kind = 'expense'), 0) AS expenses
     FROM outs
     WHERE outs.at >= $3 AND ($4::timestamptz IS NULL OR outs.at < $4)
       AND NOT EXISTS (SELECT 1 FROM cash_drawers o
                       WHERE o.business_day_id = $2 AND o.id <> $5
                         AND o.opened_at <= outs.at AND (o.closed_at IS NULL OR o.closed_at > outs.at))`,
    [restaurantId, drawer.business_day_id, drawer.opened_at, drawer.closed_at || null, drawer.id]
  );

  return result.rows[0];
};

// The whole day's money by method (taken, given back), and what of it was
// dues collected for bills of earlier days.
const dayByMethod = async (restaurantId, dayId, db = pool) => {
  const [payments, refunds, dues] = await queryAll(db, [
    () => db.query(
      `SELECT p.payment_method AS method, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::int AS count
       FROM payments p
       WHERE p.restaurant_id = $1 AND p.business_day_id = $2 AND p.payment_status = 'success'
       GROUP BY p.payment_method`,
      [restaurantId, dayId]
    ),
    () => db.query(
      `SELECT r.refund_method AS method, COALESCE(SUM(r.amount), 0) AS amount, COUNT(*)::int AS count
       FROM refunds r
       WHERE r.restaurant_id = $1 AND r.business_day_id = $2
       GROUP BY r.refund_method`,
      [restaurantId, dayId]
    ),
    () => db.query(
      `SELECT p.payment_method AS method, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::int AS count
       FROM payments p
       JOIN bills b ON b.id = p.bill_id
       WHERE p.restaurant_id = $1 AND p.business_day_id = $2 AND p.payment_status = 'success'
         AND b.business_day_id IS DISTINCT FROM $2
       GROUP BY p.payment_method`,
      [restaurantId, dayId]
    ),
  ]);

  return { payments: payments.rows, refunds: refunds.rows, dues: dues.rows };
};

// The day's takings by the person who took them, for a cashier's own X
// report when no shifts are kept.
const dayByCashier = async (restaurantId, dayId) => {
  const result = await pool.query(
    `SELECT p.created_by AS user_id, u.name AS user_name, p.payment_method AS method,
            COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::int AS count
     FROM payments p
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.restaurant_id = $1 AND p.business_day_id = $2 AND p.payment_status = 'success'
     GROUP BY p.created_by, u.name, p.payment_method
     ORDER BY u.name NULLS LAST, p.payment_method`,
    [restaurantId, dayId]
  );

  return result.rows;
};

// One cashier's whole day (no shift kept): what they took and gave back, and
// the bills they raised.
const cashierDay = async (restaurantId, dayId, cashierId) =>
  drawerTakings(restaurantId, {
    business_day_id: dayId,
    cashier_id: cashierId,
    opened_at: new Date(0),
    closed_at: null,
  });

// --- Cash in and out ---------------------------------------------------------------

const MOVEMENT_COLUMNS = `m.id, m.business_day_id, m.outlet_id, m.drawer_id, m.movement_type, m.amount,
                          m.reason, m.expense_id, m.movement_status, m.cancelled_at, m.cancel_reason,
                          m.created_at, cu.name AS created_by_name, au.name AS approved_by_name,
                          xu.name AS cancelled_by_name, dc.name AS drawer_cashier_name,
                          ec.name AS category_name`;

const MOVEMENT_FROM = `FROM cash_movements m
     LEFT JOIN users cu ON cu.id = m.created_by
     LEFT JOIN users au ON au.id = m.approved_by
     LEFT JOIN users xu ON xu.id = m.cancelled_by
     LEFT JOIN cash_drawers d ON d.id = m.drawer_id
     LEFT JOIN users dc ON dc.id = d.cashier_id
     LEFT JOIN expenses e ON e.id = m.expense_id
     LEFT JOIN expense_categories ec ON ec.id = e.expense_category_id`;

const listMovements = async (restaurantId, dayId) => {
  const result = await pool.query(
    `SELECT ${MOVEMENT_COLUMNS} ${MOVEMENT_FROM}
     WHERE m.restaurant_id = $1 AND m.business_day_id = $2
     ORDER BY m.created_at, m.id`,
    [restaurantId, dayId]
  );

  return result.rows;
};

const findMovement = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${MOVEMENT_COLUMNS}, bd.day_status, bd.business_date, d.drawer_status ${MOVEMENT_FROM}
     JOIN business_days bd ON bd.id = m.business_day_id
     WHERE m.restaurant_id = $1 AND m.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Cash put in and taken out of a day's drawers (or one drawer), by kind;
// cancelled movements count for nothing.
const movementTotals = async (restaurantId, dayId, drawerId = null, db = pool) => {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE movement_type = 'paid_in'), 0) AS paid_in,
            COALESCE(SUM(amount) FILTER (WHERE movement_type = 'drop'), 0) AS dropped,
            COALESCE(SUM(amount) FILTER (WHERE movement_type = 'petty_cash'), 0) AS petty_cash
     FROM cash_movements
     WHERE restaurant_id = $1 AND business_day_id = $2 AND movement_status = 'recorded'
       AND ($3::bigint IS NULL OR drawer_id = $3)`,
    [restaurantId, dayId, drawerId]
  );

  return result.rows[0];
};

// Inside the caller's transaction (petty cash writes its expense first).
const createMovement = async (client, restaurantId, data, userId) => {
  const result = await client.query(
    `INSERT INTO cash_movements (restaurant_id, business_day_id, outlet_id, drawer_id, movement_type,
                                 amount, reason, expense_id, approved_by, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING id`,
    [
      restaurantId,
      data.businessDayId,
      data.outletId || null,
      data.drawerId || null,
      data.type,
      data.amount,
      data.reason,
      data.expenseId || null,
      data.approvedBy || null,
      userId,
    ]
  );

  return result.rows[0].id;
};

const cancelMovement = async (client, restaurantId, id, reason, userId) => {
  const result = await client.query(
    `UPDATE cash_movements
     SET movement_status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3, cancel_reason = $4, updated_by = $3
     WHERE restaurant_id = $1 AND id = $2 AND movement_status = 'recorded'
     RETURNING id, expense_id`,
    [restaurantId, id, userId, reason]
  );

  return result.rows[0] || null;
};

// --- One at a time ------------------------------------------------------------------

// Holds one business day for the rest of the caller's transaction, so cash
// going in or out of its drawers, a drawer being counted and an entry being
// cancelled happen one after another: five drops sent at the same moment are
// each checked against what the drawer holds after the ones before them.
// NO KEY UPDATE: a bill or a payment written against the day (which only
// needs the day to exist) is never held up by it.
const lockDay = async (client, restaurantId, dayId) => {
  const result = await client.query(
    `SELECT id, day_status, business_date, outlet_id, opening_cash
     FROM business_days WHERE restaurant_id = $1 AND id = $2
     FOR NO KEY UPDATE`,
    [restaurantId, dayId]
  );

  return result.rows[0] || null;
};

// The day's cash by its parts: the day-end sheet's own definitions
// (report.repository DRAWER_PARTS) for the cash taken, given back and spent,
// supplier cash paid from this till by the till rule (tillRules), and cash
// put in or taken out of its drawers. One query, so it can also run inside a
// transaction that holds the day.
const dayCash = async (restaurantId, dayId, db = pool) => {
  const parts = DRAWER_PARTS("bd");
  const moved = (type) => `COALESCE((SELECT SUM(m.amount) FROM cash_movements m
                      WHERE m.business_day_id = bd.id AND m.movement_status = 'recorded'
                        AND m.movement_type = '${type}'), 0)`;
  const result = await db.query(
    `SELECT bd.opening_cash,
            ${parts.cashSales} AS cash_sales,
            ${parts.cashRefunds} AS cash_refunds,
            ${parts.cashExpenses} AS cash_expenses,
            ${SUPPLIER_CASH_OF_DAY("bd")} AS supplier_cash,
            ${parts.cashTips} AS cash_tips,
            ${parts.riderShortfall} AS rider_shortfall,
            ${parts.riderRepaid} AS rider_repaid,
            ${parts.cashAdvances} AS cash_advances,
            ${parts.cashAdvancesReturned} AS cash_advances_returned,
            ${moved("paid_in")} AS paid_in,
            ${moved("drop")} AS dropped,
            ${moved("petty_cash")} AS petty_cash
     FROM business_days bd
     WHERE bd.restaurant_id = $1 AND bd.id = $2`,
    [restaurantId, dayId]
  );

  return result.rows[0] || null;
};

// --- People ------------------------------------------------------------------------

// A person of this restaurant who could hold a drawer here: active, and not
// tied to another outlet.
const findCashier = async (restaurantId, userId) => {
  const result = await pool.query(
    "SELECT id, name, status, outlet_id FROM users WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, userId]
  );

  return result.rows[0] || null;
};

module.exports = {
  createDrawer,
  findDrawer,
  listDrawers,
  findOpenDrawerOf,
  closeDrawer,
  keepDrawerFirstCount,
  drawerTakings,
  drawerPayouts,
  dayByMethod,
  dayByCashier,
  cashierDay,
  listMovements,
  findMovement,
  movementTotals,
  lockDay,
  dayCash,
  createMovement,
  cancelMovement,
  findCashier,
};
