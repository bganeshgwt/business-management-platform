const pool = require("../../../../config/database");

// Leave types and the leave days they are counted against.

const TYPE_COLUMNS = `lt.id, lt.name, lt.paid, lt.allowance_days, lt.allowance_period, lt.carry_forward,
  lt.counts_from::text AS counts_from, lt.is_default, lt.status, lt.sort_order, lt.created_at, lt.updated_at`;

const findTypes = async (db, restaurantId) => {
  const result = await db.query(
    `SELECT ${TYPE_COLUMNS},
            (SELECT COUNT(*)::int FROM attendance a WHERE a.leave_type_id = lt.id)
            + (SELECT COUNT(*)::int FROM shift_assignments sa WHERE sa.leave_type_id = lt.id) AS used_days
     FROM leave_types lt
     WHERE lt.restaurant_id = $1
     ORDER BY lt.status, lt.sort_order, lt.name`,
    [restaurantId]
  );

  return result.rows;
};

const findTypeById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${TYPE_COLUMNS},
            (SELECT COUNT(*)::int FROM attendance a WHERE a.leave_type_id = lt.id)
            + (SELECT COUNT(*)::int FROM shift_assignments sa WHERE sa.leave_type_id = lt.id) AS used_days
     FROM leave_types lt
     WHERE lt.restaurant_id = $1 AND lt.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// A type saved as the default takes over from the previous one in the same
// transaction (one default per restaurant, by a unique index).
const saveType = async (restaurantId, id, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (data.isDefault) {
      await client.query(
        "UPDATE leave_types SET is_default = FALSE, updated_by = $3 WHERE restaurant_id = $1 AND is_default AND id IS DISTINCT FROM $2",
        [restaurantId, id, userId]
      );
    }

    const values = [
      restaurantId,
      data.name,
      data.paid,
      data.paid ? data.allowanceDays : null,
      data.allowancePeriod,
      data.paid ? data.carryForward : false,
      data.countsFrom,
      data.isDefault,
      data.status,
      data.sortOrder,
      userId,
    ];

    const result = id
      ? await client.query(
          `UPDATE leave_types
           SET name = $2, paid = $3, allowance_days = $4, allowance_period = $5, carry_forward = $6,
               counts_from = $7, is_default = $8, status = $9, sort_order = $10, updated_by = $11
           WHERE restaurant_id = $1 AND id = $12
           RETURNING id`,
          [...values, id]
        )
      : await client.query(
          `INSERT INTO leave_types (restaurant_id, name, paid, allowance_days, allowance_period, carry_forward,
                                    counts_from, is_default, status, sort_order, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           RETURNING id`,
          values
        );

    await client.query("COMMIT");
    return result.rows[0] ? result.rows[0].id : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const removeType = async (restaurantId, id) => {
  const result = await pool.query("DELETE FROM leave_types WHERE restaurant_id = $1 AND id = $2 RETURNING id", [
    restaurantId,
    id,
  ]);

  return result.rows.length > 0;
};

// Every leave day for these people up to `through`, oldest first, with its
// type: the attendance sheet's, else the roster's for that day. A leave day
// on the roster that nobody marked on the sheet still counts, exactly as the
// payroll counts it.
const findLeaveDays = async (restaurantId, employeeIds, through, db = pool) => {
  const result = await db.query(
    `SELECT employee_id, day, leave_type_id
     FROM (
       SELECT a.employee_id, a.attendance_date::text AS day,
              COALESCE(a.leave_type_id, sa.leave_type_id) AS leave_type_id
       FROM attendance a
       LEFT JOIN shift_assignments sa ON sa.employee_id = a.employee_id AND sa.work_date = a.attendance_date
                                    AND sa.assignment_status = 'leave'
       WHERE a.restaurant_id = $1 AND a.attendance_status = 'leave' AND a.attendance_date <= $3::date
       UNION ALL
       SELECT sa.employee_id, sa.work_date::text, sa.leave_type_id
       FROM shift_assignments sa
       WHERE sa.restaurant_id = $1 AND sa.assignment_status = 'leave' AND sa.work_date <= $3::date
         AND NOT EXISTS (SELECT 1 FROM attendance a
                         WHERE a.employee_id = sa.employee_id AND a.attendance_date = sa.work_date)
     ) days
     WHERE ($2::bigint[] IS NULL OR employee_id = ANY($2::bigint[]))
     ORDER BY employee_id, day`,
    [restaurantId, employeeIds && employeeIds.length ? employeeIds : null, through]
  );

  return result.rows;
};

// When each person's leave starts counting: the day they joined, or were added.
const findStarts = async (restaurantId, employeeIds, db = pool) => {
  const result = await db.query(
    `SELECT e.id, e.name, e.employee_code, e.designation, e.department, e.status, e.outlet_id,
            COALESCE(e.date_of_joining, e.created_at::date)::text AS started,
            e.date_of_leaving::text AS left_on
     FROM employees e
     WHERE e.restaurant_id = $1 AND ($2::bigint[] IS NULL OR e.id = ANY($2::bigint[]))
     ORDER BY e.name`,
    [restaurantId, employeeIds && employeeIds.length ? employeeIds : null]
  );

  return result.rows;
};

module.exports = {
  pool,
  findTypes,
  findTypeById,
  saveType,
  removeType,
  findLeaveDays,
  findStarts,
};
