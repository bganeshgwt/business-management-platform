const pool = require("../../../../config/database");

// Tips: what was collected, how a restaurant shares it, and every share-out.
//
// A tip's day is its business day (a tip at 00:40 belongs to the night it was
// earned); a payment with no business day falls back to its own date on the
// restaurant's clock. Payments are first narrowed by paid_at a couple of days
// either side, so the partial index on tipped payments does the work.

const TIP_DAY = `COALESCE(bd.business_date, (p.paid_at AT TIME ZONE $4)::date)`;
const BILL_DAY = `COALESCE(bd.business_date, (COALESCE(b.settled_at, b.billed_at) AT TIME ZONE $4)::date)`;

// --- Settings -------------------------------------------------------------------

const findSettings = async (restaurantId) => {
  const result = await pool.query(
    `SELECT routing, include_service_charge, share_basis, designation_points, default_points, updated_at
     FROM tip_settings WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return (
    result.rows[0] || {
      routing: "pool",
      include_service_charge: false,
      share_basis: "hours",
      designation_points: {},
      default_points: 1,
      updated_at: null,
    }
  );
};

const saveSettings = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO tip_settings (restaurant_id, routing, include_service_charge, share_basis, designation_points,
                               default_points, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)
     ON CONFLICT (restaurant_id) DO UPDATE SET
       routing = EXCLUDED.routing,
       include_service_charge = EXCLUDED.include_service_charge,
       share_basis = EXCLUDED.share_basis,
       designation_points = EXCLUDED.designation_points,
       default_points = EXCLUDED.default_points,
       updated_by = EXCLUDED.updated_by
     RETURNING routing, include_service_charge, share_basis, designation_points, default_points, updated_at`,
    [
      restaurantId,
      data.routing,
      data.includeServiceCharge,
      data.shareBasis,
      JSON.stringify(data.designationPoints),
      data.defaultPoints,
      userId,
    ]
  );

  return result.rows[0];
};

// --- Collected --------------------------------------------------------------------

// Every tip of the period, with whether a share-out has taken it and the
// captain who took the order (the login that opened it, when it belongs to an
// active employee). `onlyUnshared` keeps the ones still to be shared.
const findTips = async (db, restaurantId, from, to, timezone, { onlyUnshared = false } = {}) => {
  const result = await db.query(
    `SELECT p.id, p.tip_amount, p.payment_method, p.order_id, p.bill_id, b.bill_number,
            ${TIP_DAY}::text AS day,
            sp.shareout_id,
            cap.id AS captain_employee_id, cap.name AS captain_name
     FROM payments p
     JOIN bills b ON b.id = p.bill_id
     LEFT JOIN business_days bd ON bd.id = p.business_day_id
     LEFT JOIN orders o ON o.id = p.order_id
     LEFT JOIN employees cap ON cap.user_id = o.created_by AND cap.restaurant_id = p.restaurant_id
                            AND cap.status = 'active'
     LEFT JOIN tip_shareout_payments sp ON sp.payment_id = p.id
     WHERE p.restaurant_id = $1 AND p.tip_amount > 0 AND p.payment_status = 'success'
       AND b.bill_status <> 'void'
       AND p.paid_at >= $2::date - 2 AND p.paid_at < $3::date + 3
       AND ${TIP_DAY} BETWEEN $2::date AND $3::date
       AND ($5::boolean = FALSE OR sp.payment_id IS NULL)
     ORDER BY day, p.id`,
    [restaurantId, from, to, timezone, onlyUnshared]
  );

  return result.rows;
};

// The service charge of each paid bill of the period (complimentary bills
// collected none), with whether a share-out has taken it.
const findServiceCharges = async (db, restaurantId, from, to, timezone, { onlyUnshared = false } = {}) => {
  const result = await db.query(
    `SELECT b.id, b.bill_number, b.service_charge, ${BILL_DAY}::text AS day, sb.shareout_id
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     LEFT JOIN tip_shareout_bills sb ON sb.bill_id = b.id
     WHERE b.restaurant_id = $1 AND b.bill_status = 'paid' AND b.service_charge > 0
       AND NOT COALESCE(b.is_complimentary, FALSE)
       AND COALESCE(b.settled_at, b.billed_at) >= $2::date - 2 AND COALESCE(b.settled_at, b.billed_at) < $3::date + 3
       AND ${BILL_DAY} BETWEEN $2::date AND $3::date
       AND ($5::boolean = FALSE OR sb.bill_id IS NULL)
     ORDER BY day, b.id`,
    [restaurantId, from, to, timezone, onlyUnshared]
  );

  return result.rows;
};

// Who worked the period and how much: the hours and days the pool is shared by.
const findWorkers = async (db, restaurantId, from, to) => {
  const result = await db.query(
    `SELECT e.id, e.name, e.employee_code, e.designation, e.department, e.status,
            COALESCE(SUM(a.worked_minutes), 0)::int AS worked_minutes,
            (COUNT(*) FILTER (WHERE a.attendance_status = 'present')
             + 0.5 * COUNT(*) FILTER (WHERE a.attendance_status = 'half_day'))::numeric AS days_worked
     FROM employees e
     JOIN attendance a ON a.employee_id = e.id AND a.restaurant_id = e.restaurant_id
                      AND a.attendance_date BETWEEN $2::date AND $3::date
                      AND a.attendance_status IN ('present', 'half_day')
     WHERE e.restaurant_id = $1
     GROUP BY e.id
     ORDER BY e.name`,
    [restaurantId, from, to]
  );

  return result.rows;
};

// Employees of this restaurant among `ids` (to check exclusions and pay dates).
const findEmployeesByIds = async (db, restaurantId, ids) => {
  if (!ids.length) {
    return [];
  }

  const result = await db.query(
    "SELECT id, name FROM employees WHERE restaurant_id = $1 AND id = ANY($2::bigint[])",
    [restaurantId, ids]
  );

  return result.rows;
};

// People among `ids` whose pay covering `date` is already marked paid.
const findPaidOn = async (db, restaurantId, ids, date) => {
  if (!ids.length) {
    return [];
  }

  const result = await db.query(
    `SELECT DISTINCT pp.employee_id, e.name, pp.period_from::text AS period_from, pp.period_to::text AS period_to
     FROM payroll_payments pp
     JOIN employees e ON e.id = pp.employee_id
     WHERE pp.restaurant_id = $1 AND pp.employee_id = ANY($2::bigint[])
       AND pp.period_from <= $3::date AND pp.period_to >= $3::date`,
    [restaurantId, ids, date]
  );

  return result.rows;
};

// --- Share-outs ---------------------------------------------------------------------

// Writes a share-out and everything it took, in the caller's transaction. A
// tip or a bill's service charge already taken by another share-out breaks
// the UNIQUE on its link row, so the same money is never shared twice.
const insertShareout = async (client, restaurantId, data, userId) => {
  const inserted = await client.query(
    `INSERT INTO tip_shareouts (restaurant_id, period_from, period_to, pay_date, basis, routing, tips_total,
                                service_charge_total, direct_total, pool_total, note, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING id`,
    [
      restaurantId,
      data.from,
      data.to,
      data.payDate,
      data.basis,
      data.routing,
      data.tipsTotal,
      data.serviceChargeTotal,
      data.directTotal,
      data.poolTotal,
      data.note,
      userId,
    ]
  );

  const id = inserted.rows[0].id;

  if (data.payments.length) {
    await client.query(
      `INSERT INTO tip_shareout_payments (shareout_id, payment_id, restaurant_id, tip_amount, employee_id)
       SELECT $1, payment_id, $2, tip_amount, employee_id
       FROM UNNEST($3::bigint[], $4::numeric[], $5::bigint[]) AS t(payment_id, tip_amount, employee_id)`,
      [
        id,
        restaurantId,
        data.payments.map((row) => row.id),
        data.payments.map((row) => row.amount),
        data.payments.map((row) => row.employeeId || null),
      ]
    );
  }

  if (data.bills.length) {
    await client.query(
      `INSERT INTO tip_shareout_bills (shareout_id, bill_id, restaurant_id, service_charge)
       SELECT $1, bill_id, $2, service_charge
       FROM UNNEST($3::bigint[], $4::numeric[]) AS t(bill_id, service_charge)`,
      [id, restaurantId, data.bills.map((row) => row.id), data.bills.map((row) => row.amount)]
    );
  }

  if (data.shares.length) {
    await client.query(
      `INSERT INTO tip_shares (restaurant_id, shareout_id, employee_id, kind, share_date, worked_minutes,
                               days_worked, points, amount)
       SELECT $1, $2, employee_id, kind, $3, worked_minutes, days_worked, points, amount
       FROM UNNEST($4::bigint[], $5::text[], $6::int[], $7::numeric[], $8::numeric[], $9::numeric[])
            AS t(employee_id, kind, worked_minutes, days_worked, points, amount)`,
      [
        restaurantId,
        id,
        data.payDate,
        data.shares.map((row) => row.employeeId),
        data.shares.map((row) => row.kind),
        data.shares.map((row) => row.workedMinutes || 0),
        data.shares.map((row) => row.daysWorked || 0),
        data.shares.map((row) => row.points || 0),
        data.shares.map((row) => row.amount),
      ]
    );
  }

  return id;
};

const SHAREOUT_COLUMNS = `s.id, s.period_from::text AS period_from, s.period_to::text AS period_to,
  s.pay_date::text AS pay_date, s.basis, s.routing, s.tips_total, s.service_charge_total, s.direct_total,
  s.pool_total, s.note, s.created_at, u.name AS created_by_name,
  (SELECT COUNT(*)::int FROM tip_shareout_payments sp WHERE sp.shareout_id = s.id) AS tip_count,
  (SELECT COUNT(*)::int FROM tip_shareout_bills sb WHERE sb.shareout_id = s.id) AS bill_count`;

const findShareouts = async (restaurantId, from, to) => {
  const result = await pool.query(
    `SELECT ${SHAREOUT_COLUMNS}
     FROM tip_shareouts s
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.restaurant_id = $1 AND s.period_to >= $2::date AND s.period_from <= $3::date
     ORDER BY s.period_to DESC, s.id DESC`,
    [restaurantId, from, to]
  );

  return result.rows;
};

const findShareoutById = async (db, restaurantId, id) => {
  const result = await db.query(
    `SELECT ${SHAREOUT_COLUMNS}
     FROM tip_shareouts s
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.restaurant_id = $1 AND s.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const findShares = async (db, restaurantId, shareoutIds) => {
  if (!shareoutIds.length) {
    return [];
  }

  const result = await db.query(
    `SELECT ts.shareout_id, ts.employee_id, e.name AS employee_name, e.designation, ts.kind,
            ts.share_date::text AS share_date, ts.worked_minutes, ts.days_worked, ts.points, ts.amount
     FROM tip_shares ts
     JOIN employees e ON e.id = ts.employee_id
     WHERE ts.restaurant_id = $1 AND ts.shareout_id = ANY($2::bigint[])
     ORDER BY ts.amount DESC, e.name`,
    [restaurantId, shareoutIds]
  );

  return result.rows;
};

// Each person's tips landing in a pay period, split direct / pool.
const findPersonTotals = async (restaurantId, from, to, employeeId = null, db = pool) => {
  const result = await db.query(
    `SELECT ts.employee_id, e.name, e.designation,
            COALESCE(SUM(ts.amount) FILTER (WHERE ts.kind = 'direct'), 0) AS direct,
            COALESCE(SUM(ts.amount) FILTER (WHERE ts.kind = 'pool'), 0) AS pool,
            COALESCE(SUM(ts.amount), 0) AS total,
            COUNT(DISTINCT ts.shareout_id)::int AS shareouts
     FROM tip_shares ts
     JOIN employees e ON e.id = ts.employee_id
     WHERE ts.restaurant_id = $1 AND ts.share_date BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR ts.employee_id = $4)
     GROUP BY ts.employee_id, e.name, e.designation
     ORDER BY total DESC, e.name`,
    [restaurantId, from, to, employeeId]
  );

  return result.rows;
};

// Removes a share-out; its tips and service charges are free to share again.
const deleteShareout = async (client, restaurantId, id) => {
  const result = await client.query("DELETE FROM tip_shareouts WHERE restaurant_id = $1 AND id = $2 RETURNING id", [
    restaurantId,
    id,
  ]);

  return result.rows.length > 0;
};

// Payments already made covering a share's day, for any person in it: the
// share-out can no longer be undone.
const findPaidShares = async (db, restaurantId, shareoutId) => {
  const result = await db.query(
    `SELECT DISTINCT e.name, pp.period_from::text AS period_from, pp.period_to::text AS period_to
     FROM tip_shares ts
     JOIN employees e ON e.id = ts.employee_id
     JOIN payroll_payments pp ON pp.restaurant_id = ts.restaurant_id AND pp.employee_id = ts.employee_id
                              AND pp.period_from <= ts.share_date AND pp.period_to >= ts.share_date
     WHERE ts.restaurant_id = $1 AND ts.shareout_id = $2`,
    [restaurantId, shareoutId]
  );

  return result.rows;
};

module.exports = {
  pool,
  findSettings,
  saveSettings,
  findTips,
  findServiceCharges,
  findWorkers,
  findEmployeesByIds,
  findPaidOn,
  insertShareout,
  findShareouts,
  findShareoutById,
  findShares,
  findPersonTotals,
  deleteShareout,
  findPaidShares,
};
