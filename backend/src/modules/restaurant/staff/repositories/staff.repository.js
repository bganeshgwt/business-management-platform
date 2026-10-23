const pool = require("../../../../config/database");

// --- Employees ---

const EMPLOYEE_COLUMNS = `e.id, e.outlet_id, e.user_id, e.employee_code, e.name, e.mobile, e.email,
                          e.designation, e.department, e.employment_type, e.salary_type,
                          e.salary_amount, e.date_of_joining, e.date_of_leaving, e.address,
                          e.emergency_contact, e.notes, e.status,
                          e.pf_applicable, e.esi_applicable, e.pt_applicable, e.uan, e.esi_number,
                          e.basic_percent, e.gender,
                          e.bank_account_name, e.bank_account_number, e.bank_ifsc`;

// The list also carries the salary in force on `today` (the restaurant's
// date) and every one already planned after it, oldest first, so raises
// dated 1 October and 1 November show as "₹30,000, rising to ₹45,000 from
// 1 Oct, then ₹50,000 from 1 Nov" in September instead of as today's salary.
// employees.salary_* keeps the latest instruction (the last planned line),
// which is what an edit compares against.
const findEmployees = async (restaurantId, filters = {}, today = null) => {
  const result = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS}, o.name AS outlet_name, u.email AS login_email,
            u.mobile AS login_mobile, u.name AS login_name,
            cur.salary_type AS today_salary_type, cur.salary_amount AS today_salary_amount,
            COALESCE(planned.lines, '[]'::json) AS planned_salaries
     FROM employees e
     LEFT JOIN outlets o ON o.id = e.outlet_id
     LEFT JOIN users u ON u.id = e.user_id
     -- In force today: the latest line started by then, else (someone who
     -- joins later) the first line.
     LEFT JOIN LATERAL (
       SELECT h.effective_from, h.salary_type, h.salary_amount
       FROM employee_salary_history h
       WHERE h.employee_id = e.id
       ORDER BY (h.effective_from <= COALESCE($5::date, CURRENT_DATE)) DESC,
                CASE WHEN h.effective_from <= COALESCE($5::date, CURRENT_DATE) THEN h.effective_from END DESC NULLS LAST,
                h.effective_from
       LIMIT 1
     ) cur ON TRUE
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('from', h.effective_from::text, 'salaryType', h.salary_type,
                                         'salaryAmount', h.salary_amount) ORDER BY h.effective_from) AS lines
       FROM employee_salary_history h
       WHERE h.employee_id = e.id
         AND h.effective_from > COALESCE($5::date, CURRENT_DATE)
         AND h.effective_from > cur.effective_from
     ) planned ON TRUE
     WHERE e.restaurant_id = $1
       AND ($2::text IS NULL OR e.department = $2)
       AND ($3::text IS NULL OR e.status = $3)
       AND ($4::text IS NULL OR e.name ILIKE '%' || $4 || '%' OR e.employee_code ILIKE '%' || $4 || '%')
     ORDER BY e.status, e.name`,
    [restaurantId, filters.department || null, filters.status || null, filters.search || null, today]
  );

  return result.rows;
};

const findEmployeeById = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees e WHERE e.restaurant_id = $1 AND e.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// The salary someone starts on is also the first line of their salary
// history (see employee_salary_history), dated from the day they joined, or
// from `startsOn` (today) when no joining date is given.
const createEmployee = async (restaurantId, data, userId, startsOn = null) => {
  const result = await pool.query(
    `WITH added AS (
       INSERT INTO employees (restaurant_id, outlet_id, user_id, employee_code, name, mobile, email,
                              designation, department, employment_type, salary_type, salary_amount,
                              date_of_joining, date_of_leaving, address, emergency_contact, notes,
                              status, created_by, updated_by, pf_applicable, esi_applicable,
                              pt_applicable, uan, esi_number, basic_percent, gender,
                              bank_account_name, bank_account_number, bank_ifsc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19,
               $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
       RETURNING id, restaurant_id, salary_type, salary_amount, date_of_joining
     ), history AS (
       INSERT INTO employee_salary_history (restaurant_id, employee_id, effective_from, salary_type,
                                            salary_amount, created_by, updated_by)
       SELECT restaurant_id, id, COALESCE(date_of_joining, $20::date, CURRENT_DATE), salary_type,
              salary_amount, $19, $19
       FROM added
     )
     SELECT id FROM added`,
    [
      restaurantId,
      data.outletId,
      data.userId,
      data.employeeCode,
      data.name,
      data.mobile,
      data.email,
      data.designation,
      data.department,
      data.employmentType,
      data.salaryType,
      data.salaryAmount,
      data.dateOfJoining,
      data.dateOfLeaving,
      data.address,
      data.emergencyContact,
      data.notes,
      data.status,
      userId,
      startsOn,
      Boolean(data.pfApplicable),
      Boolean(data.esiApplicable),
      data.ptApplicable === undefined ? true : Boolean(data.ptApplicable),
      data.uan || null,
      data.esiNumber || null,
      data.basicPercent === undefined || data.basicPercent === null ? 100 : data.basicPercent,
      data.gender || null,
      data.bankAccountName || null,
      data.bankAccountNumber || null,
      data.bankIfsc || null,
    ]
  );

  return findEmployeeById(restaurantId, result.rows[0].id);
};

// The one UPDATE both kinds of save use.
const UPDATE_EMPLOYEE_SQL = `UPDATE employees
     SET outlet_id = $3, user_id = $4, employee_code = $5, name = $6, mobile = $7, email = $8,
         designation = $9, department = $10, employment_type = $11, salary_type = $12,
         salary_amount = $13, date_of_joining = $14, date_of_leaving = $15, address = $16,
         emergency_contact = $17, notes = $18, status = $19, updated_by = $20,
         pf_applicable = $21, esi_applicable = $22, pt_applicable = $23, uan = $24, esi_number = $25,
         basic_percent = $26, gender = $27,
         bank_account_name = $28, bank_account_number = $29, bank_ifsc = $30
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`;

const updateValues = (restaurantId, id, data, userId) => [
  restaurantId,
  id,
  data.outletId,
  data.userId,
  data.employeeCode,
  data.name,
  data.mobile,
  data.email,
  data.designation,
  data.department,
  data.employmentType,
  data.salaryType,
  data.salaryAmount,
  data.dateOfJoining,
  data.dateOfLeaving,
  data.address,
  data.emergencyContact,
  data.notes,
  data.status,
  userId,
  Boolean(data.pfApplicable),
  Boolean(data.esiApplicable),
  data.ptApplicable === undefined ? true : Boolean(data.ptApplicable),
  data.uan || null,
  data.esiNumber || null,
  data.basicPercent === undefined || data.basicPercent === null ? 100 : data.basicPercent,
  data.gender || null,
  data.bankAccountName || null,
  data.bankAccountNumber || null,
  data.bankIfsc || null,
];

// Payments for this person whose period ends on or after `date`: a salary
// starting on `date` would re-price days already paid for.
const findPaymentsEndingFrom = async (db, restaurantId, employeeId, date) => {
  const result = await db.query(
    `SELECT id, period_from, period_to FROM payroll_payments
     WHERE restaurant_id = $1 AND employee_id = $2 AND period_to >= $3::date
     ORDER BY period_to DESC`,
    [restaurantId, employeeId, date]
  );

  return result.rows;
};

// Saves an employee. `salaryChange` = { effectiveFrom } when the salary or
// its type changed: from that date on the new salary applies, and every day
// before keeps the salary it had. It runs under the same row lock "Mark paid"
// takes, so a salary can never start inside a period being paid at that very
// moment; { paidThrough } comes back instead when it would.
const updateEmployee = async (restaurantId, id, data, userId, salaryChange = null) => {
  if (!salaryChange) {
    const result = await pool.query(UPDATE_EMPLOYEE_SQL, updateValues(restaurantId, id, data, userId));
    return result.rows.length === 0 ? null : findEmployeeById(restaurantId, id);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT id, salary_type, salary_amount, COALESCE(date_of_joining, created_at::date)::text AS started
       FROM employees WHERE restaurant_id = $1 AND id = $2 FOR UPDATE`,
      [restaurantId, id]
    );

    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const paid = await findPaymentsEndingFrom(client, restaurantId, id, salaryChange.effectiveFrom);

    if (paid.length > 0) {
      await client.query("ROLLBACK");
      return { paidThrough: paid[0] };
    }

    // A first salary (they have only ever been on ₹0) dated from when they
    // started: their ₹0 lines were never a real salary, so they are replaced
    // by this one line rather than kept for "the days before".
    if (salaryChange.first) {
      await client.query("DELETE FROM employee_salary_history WHERE employee_id = $1", [id]);
      await client.query(
        `INSERT INTO employee_salary_history (restaurant_id, employee_id, effective_from, salary_type,
                                              salary_amount, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [restaurantId, id, salaryChange.effectiveFrom, data.salaryType, data.salaryAmount, userId]
      );
      await client.query(UPDATE_EMPLOYEE_SQL, updateValues(restaurantId, id, data, userId));
      await client.query("COMMIT");
      return await findEmployeeById(restaurantId, id, client);
    }

    // Someone added before salary history existed (or straight into the
    // database) has no history yet: their salary until now becomes the first
    // line, so the days before the change keep it.
    await client.query(
      `INSERT INTO employee_salary_history (restaurant_id, employee_id, effective_from, salary_type,
                                            salary_amount, created_by, updated_by)
       SELECT $1, $2, LEAST($3::date, $4::date - 1), $5, $6, $7, $7
       WHERE NOT EXISTS (SELECT 1 FROM employee_salary_history WHERE employee_id = $2)`,
      [
        restaurantId,
        id,
        locked.rows[0].started,
        salaryChange.effectiveFrom,
        locked.rows[0].salary_type,
        locked.rows[0].salary_amount,
        userId,
      ]
    );

    // Nothing yet starts before the new date (someone added today, whose
    // first line is today): the salary that applied to the earlier days is
    // written the day before, so replacing today's line cannot re-price them.
    await client.query(
      `INSERT INTO employee_salary_history (restaurant_id, employee_id, effective_from, salary_type,
                                            salary_amount, created_by, updated_by)
       SELECT $1, $2, $3::date - 1, h.salary_type, h.salary_amount, $4, $4
       FROM employee_salary_history h
       WHERE h.employee_id = $2
         AND NOT EXISTS (SELECT 1 FROM employee_salary_history x
                         WHERE x.employee_id = $2 AND x.effective_from < $3::date)
       ORDER BY h.effective_from
       LIMIT 1`,
      [restaurantId, id, salaryChange.effectiveFrom, userId]
    );

    // "From this date on": a later change already planned is replaced by
    // this one, which is the newest instruction.
    await client.query("DELETE FROM employee_salary_history WHERE employee_id = $1 AND effective_from > $2::date", [
      id,
      salaryChange.effectiveFrom,
    ]);

    await client.query(
      `INSERT INTO employee_salary_history (restaurant_id, employee_id, effective_from, salary_type,
                                            salary_amount, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (employee_id, effective_from) DO UPDATE SET
         salary_type = EXCLUDED.salary_type,
         salary_amount = EXCLUDED.salary_amount,
         updated_by = EXCLUDED.updated_by`,
      [restaurantId, id, salaryChange.effectiveFrom, data.salaryType, data.salaryAmount, userId]
    );

    await client.query(UPDATE_EMPLOYEE_SQL, updateValues(restaurantId, id, data, userId));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return findEmployeeById(restaurantId, id);
};

// When a person's pay starts: the day they joined (or were added), whether
// they have ever had a salary above zero, and the last day marked paid.
// Used to date a first salary set after they started working.
const findSalaryStart = async (restaurantId, employeeId) => {
  const result = await pool.query(
    `SELECT COALESCE(e.date_of_joining, e.created_at::date)::text AS started,
            EXISTS (SELECT 1 FROM employee_salary_history h
                    WHERE h.employee_id = e.id AND h.salary_amount > 0) AS had_salary,
            (SELECT MAX(p.period_to)::text FROM payroll_payments p
             WHERE p.restaurant_id = e.restaurant_id AND p.employee_id = e.id) AS paid_through
     FROM employees e
     WHERE e.restaurant_id = $1 AND e.id = $2`,
    [restaurantId, employeeId]
  );

  return result.rows[0] || null;
};

// One person's salary lines, oldest first: "Rs 30,000 a month from 1 Jan".
const findSalaryHistory = async (restaurantId, employeeId) => {
  const result = await pool.query(
    `SELECT h.id, h.effective_from, h.salary_type, h.salary_amount, h.created_at, u.name AS created_by_name
     FROM employee_salary_history h
     LEFT JOIN users u ON u.id = h.created_by
     WHERE h.restaurant_id = $1 AND h.employee_id = $2
     ORDER BY h.effective_from`,
    [restaurantId, employeeId]
  );

  return result.rows;
};

// The last day a person's pay is marked paid up to, or null.
const findPaidThrough = async (restaurantId, employeeId) => {
  const result = await pool.query(
    `SELECT MAX(period_to)::text AS paid_through FROM payroll_payments
     WHERE restaurant_id = $1 AND employee_id = $2`,
    [restaurantId, employeeId]
  );

  return result.rows[0] ? result.rows[0].paid_through : null;
};

const countAttendance = async (employeeId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM attendance WHERE employee_id = $1",
    [employeeId]
  );

  return result.rows[0].count;
};

// Everything else that makes an employee part of the record: time-clock
// punches, orders they carried as a rider, and payroll money. Any of these
// means "set them inactive", never delete.
const countHistory = async (employeeId) => {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM attendance_punches WHERE employee_id = $1) AS punches,
       (SELECT COUNT(*)::int FROM orders WHERE rider_employee_id = $1) AS rider_orders,
       (SELECT COUNT(*)::int FROM payroll_adjustments WHERE employee_id = $1) AS adjustments,
       (SELECT COUNT(*)::int FROM payroll_payments WHERE employee_id = $1) AS payments`,
    [employeeId]
  );

  return result.rows[0];
};

const removeEmployee = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM employees WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Shifts ---

const findShifts = async (restaurantId) => {
  const result = await pool.query(
    `SELECT s.id, s.name, s.start_time, s.end_time, s.break_minutes, s.grace_minutes, s.status,
            COUNT(a.id)::int AS assigned_count
     FROM shifts s
     LEFT JOIN shift_assignments a ON a.shift_id = s.id
     WHERE s.restaurant_id = $1
     GROUP BY s.id
     ORDER BY s.start_time`,
    [restaurantId]
  );

  return result.rows;
};

const findShiftById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT id, name, start_time, end_time, break_minutes, grace_minutes, status
     FROM shifts WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createShift = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO shifts (restaurant_id, name, start_time, end_time, break_minutes,
                         grace_minutes, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING id, name, start_time, end_time, break_minutes, grace_minutes, status`,
    [
      restaurantId,
      data.name,
      data.startTime,
      data.endTime,
      data.breakMinutes,
      data.graceMinutes,
      data.status,
      userId,
    ]
  );

  return result.rows[0];
};

const updateShift = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE shifts
     SET name = $3, start_time = $4, end_time = $5, break_minutes = $6, grace_minutes = $7,
         status = $8, updated_by = $9
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, name, start_time, end_time, break_minutes, grace_minutes, status`,
    [
      restaurantId,
      id,
      data.name,
      data.startTime,
      data.endTime,
      data.breakMinutes,
      data.graceMinutes,
      data.status,
      userId,
    ]
  );

  return result.rows[0] || null;
};

const countShiftAssignments = async (shiftId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM shift_assignments WHERE shift_id = $1",
    [shiftId]
  );

  return result.rows[0].count;
};

const removeShift = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM shifts WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Roster ---

const findRoster = async (restaurantId, from, to) => {
  const result = await pool.query(
    `SELECT a.id, a.employee_id, a.shift_id, a.work_date, a.assignment_status, a.notes,
            e.name AS employee_name, s.name AS shift_name, s.start_time, s.end_time,
            CASE WHEN a.assignment_status = 'leave' THEN a.leave_type_id END AS leave_type_id,
            CASE WHEN a.assignment_status = 'leave' THEN lt.name END AS leave_type_name
     FROM shift_assignments a
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN shifts s ON s.id = a.shift_id
     LEFT JOIN leave_types lt ON lt.id = a.leave_type_id
     WHERE a.restaurant_id = $1 AND a.work_date BETWEEN $2::date AND $3::date
     ORDER BY a.work_date, e.name`,
    [restaurantId, from, to]
  );

  return result.rows;
};

const findAssignment = async (restaurantId, employeeId, workDate) => {
  const result = await pool.query(
    `SELECT a.id, a.shift_id, a.assignment_status, a.leave_type_id, s.name AS shift_name, lt.name AS leave_type_name
     FROM shift_assignments a
     LEFT JOIN shifts s ON s.id = a.shift_id
     LEFT JOIN leave_types lt ON lt.id = a.leave_type_id
     WHERE a.restaurant_id = $1 AND a.employee_id = $2 AND a.work_date = $3::date`,
    [restaurantId, employeeId, workDate]
  );

  return result.rows[0] || null;
};

const findAssignmentById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT a.id, a.employee_id, a.work_date, a.assignment_status, s.name AS shift_name,
            e.name AS employee_name
     FROM shift_assignments a
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN shifts s ON s.id = a.shift_id
     WHERE a.restaurant_id = $1 AND a.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// One row per person per day: saving the same day again replaces it.
// The leave type is kept only on a leave day.
const upsertAssignment = async (restaurantId, data, userId, db = pool) => {
  const result = await db.query(
    `INSERT INTO shift_assignments (restaurant_id, employee_id, shift_id, work_date,
                                    assignment_status, notes, leave_type_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $8, $7, $7)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET
       shift_id = EXCLUDED.shift_id,
       assignment_status = EXCLUDED.assignment_status,
       notes = EXCLUDED.notes,
       leave_type_id = EXCLUDED.leave_type_id,
       updated_by = EXCLUDED.updated_by
     RETURNING id`,
    [
      restaurantId,
      data.employeeId,
      data.shiftId,
      data.workDate,
      data.assignmentStatus,
      data.notes,
      userId,
      data.assignmentStatus === "leave" ? data.leaveTypeId || null : null,
    ]
  );

  return result.rows[0];
};

const removeAssignment = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM shift_assignments WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Attendance ---

// The day sheet: every active employee, with their roster and whatever
// attendance has been recorded so far — and whether the time clock recorded
// it, because a clocked day is corrected on the time clock, not typed over.
const findAttendanceForDate = async (restaurantId, date) => {
  const result = await pool.query(
    `SELECT e.id AS employee_id, e.name AS employee_name, e.employee_code, e.department,
            a.id AS attendance_id, a.attendance_status, a.check_in, a.check_out,
            a.worked_minutes, a.break_minutes, a.late_minutes, a.overtime_minutes, a.notes,
            COALESCE(a.shift_id, sa.shift_id) AS shift_id,
            s.name AS shift_name, s.start_time, s.end_time,
            s.break_minutes AS shift_break_minutes, s.grace_minutes,
            sa.assignment_status,
            -- The leave type: the sheet's, else the roster's for a leave day.
            CASE WHEN a.attendance_status = 'leave' THEN COALESCE(a.leave_type_id, sa.leave_type_id)
                 WHEN a.id IS NULL AND sa.assignment_status = 'leave' THEN sa.leave_type_id END AS leave_type_id,
            lt.name AS leave_type_name,
            e.outlet_id,
            EXISTS (SELECT 1 FROM attendance_punches p
                    WHERE p.employee_id = e.id AND p.work_date = $2::date) AS clocked
     FROM employees e
     LEFT JOIN shift_assignments sa ON sa.employee_id = e.id AND sa.work_date = $2::date
     LEFT JOIN attendance a ON a.employee_id = e.id AND a.attendance_date = $2::date
     LEFT JOIN shifts s ON s.id = COALESCE(a.shift_id, sa.shift_id)
     LEFT JOIN leave_types lt ON lt.id = CASE WHEN a.attendance_status = 'leave' THEN COALESCE(a.leave_type_id, sa.leave_type_id)
                                              WHEN a.id IS NULL AND sa.assignment_status = 'leave' THEN sa.leave_type_id END
     WHERE e.restaurant_id = $1 AND e.status = 'active'
     ORDER BY e.name`,
    [restaurantId, date]
  );

  return result.rows;
};

// A hand-entered day. break_minutes is the shift's break that was taken off
// the hours, so worked = (out - in) - break adds up on the sheet exactly as it
// does for a day the time clock recorded.
const upsertAttendance = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO attendance (restaurant_id, employee_id, shift_id, attendance_date, check_in,
                             check_out, attendance_status, worked_minutes, late_minutes,
                             overtime_minutes, notes, break_minutes, created_by, updated_by, leave_type_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)
     ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
       shift_id = EXCLUDED.shift_id,
       check_in = EXCLUDED.check_in,
       check_out = EXCLUDED.check_out,
       attendance_status = EXCLUDED.attendance_status,
       worked_minutes = EXCLUDED.worked_minutes,
       late_minutes = EXCLUDED.late_minutes,
       overtime_minutes = EXCLUDED.overtime_minutes,
       break_minutes = EXCLUDED.break_minutes,
       notes = EXCLUDED.notes,
       leave_type_id = EXCLUDED.leave_type_id,
       updated_by = EXCLUDED.updated_by
     RETURNING id`,
    [
      restaurantId,
      data.employeeId,
      data.shiftId,
      data.attendanceDate,
      data.checkIn,
      data.checkOut,
      data.attendanceStatus,
      data.workedMinutes,
      data.lateMinutes,
      data.overtimeMinutes,
      data.notes,
      data.breakMinutes || 0,
      userId,
      // Only a leave day keeps its leave type.
      data.attendanceStatus === "leave" ? data.leaveTypeId || null : null,
    ]
  );

  return result.rows[0];
};

const findAttendanceRow = async (restaurantId, employeeId, date) => {
  const result = await pool.query(
    `SELECT a.id, a.employee_id, a.shift_id, a.attendance_date, a.check_in, a.check_out, a.attendance_status,
            a.worked_minutes, a.late_minutes, a.overtime_minutes, a.break_minutes, a.notes,
            a.leave_type_id, lt.name AS leave_type_name
     FROM attendance a
     LEFT JOIN leave_types lt ON lt.id = a.leave_type_id
     WHERE a.restaurant_id = $1 AND a.employee_id = $2 AND a.attendance_date = $3::date`,
    [restaurantId, employeeId, date]
  );

  return result.rows[0] || null;
};

const hasPunches = async (restaurantId, employeeId, date) => {
  const result = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM attendance_punches
                    WHERE restaurant_id = $1 AND employee_id = $2 AND work_date = $3::date) AS clocked`,
    [restaurantId, employeeId, date]
  );

  return result.rows[0].clocked;
};

// --- Payroll ---

// The salary line in force on a day (`dayExpr`) for employee `employeeExpr`:
// the latest one starting on or before it, else the first one (the salary
// they joined on). No history at all falls back to the employees row.
const rateOn = (employeeExpr, dayExpr) => `LEFT JOIN LATERAL (
       SELECT h.salary_type, h.salary_amount
       FROM employee_salary_history h
       WHERE h.employee_id = ${employeeExpr}
       ORDER BY (h.effective_from <= ${dayExpr}) DESC,
                CASE WHEN h.effective_from <= ${dayExpr} THEN h.effective_from END DESC NULLS LAST,
                h.effective_from
       LIMIT 1
     ) rate ON TRUE`;

// Everyone payroll must cover for a period: active staff, plus anyone who has
// since left but worked or had money recorded in it (their final settlement).
// Their salary is the one in force on the period's last day; salary_changes
// lists any new salary that started inside the period.
const findPayrollEmployees = async (restaurantId, from, to, employeeId = null, db = pool) => {
  const result = await db.query(
    `SELECT e.id, e.name, e.employee_code, e.department, e.designation, e.status,
            e.pf_applicable, e.esi_applicable, e.pt_applicable, e.uan, e.esi_number, e.basic_percent,
            e.gender, e.outlet_id, e.bank_account_name, e.bank_account_number, e.bank_ifsc,
            COALESCE(rate.salary_type, e.salary_type) AS salary_type,
            COALESCE(rate.salary_amount, e.salary_amount) AS salary_amount,
            e.date_of_joining, e.date_of_leaving,
            COALESCE((SELECT json_agg(json_build_object('from', h.effective_from, 'salaryType', h.salary_type,
                                                        'salaryAmount', h.salary_amount) ORDER BY h.effective_from)
                      FROM employee_salary_history h
                      WHERE h.employee_id = e.id AND h.effective_from > $2::date
                        AND h.effective_from <= $3::date
                        -- The first line is the salary they started on, not a change.
                        AND EXISTS (SELECT 1 FROM employee_salary_history earlier
                                    WHERE earlier.employee_id = e.id
                                      AND earlier.effective_from < h.effective_from)), '[]'::json) AS salary_changes
     FROM employees e
     ${rateOn("e.id", "$3::date")}
     WHERE e.restaurant_id = $1
       AND ($4::bigint IS NULL OR e.id = $4)
       AND (e.status = 'active'
            OR EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id
                         AND a.attendance_date BETWEEN $2::date AND $3::date)
            OR EXISTS (SELECT 1 FROM payroll_adjustments pa WHERE pa.employee_id = e.id
                         AND pa.adjustment_date BETWEEN $2::date AND $3::date)
            -- Tips shared to someone who has since left are still theirs.
            OR EXISTS (SELECT 1 FROM tip_shares ts WHERE ts.employee_id = e.id
                         AND ts.share_date BETWEEN $2::date AND $3::date))
     ORDER BY e.name`,
    [restaurantId, from, to, employeeId]
  );

  return result.rows;
};

// Day counts per employee per calendar month and per salary in force on
// those days (a raise on the 15th splits the month in two). A week off or
// leave on the roster counts even when nobody marked attendance for that day:
// the roster already says the person was off, and they should not lose the
// day's pay because the sheet was left blank.
const payrollDays = async (restaurantId, from, to, employeeId = null, db = pool) => {
  const result = await db.query(
    `WITH raw AS (
       SELECT a.employee_id, a.attendance_date AS day, a.attendance_status AS status,
              a.worked_minutes, a.late_minutes, a.overtime_minutes
       FROM attendance a
       WHERE a.restaurant_id = $1 AND a.attendance_date BETWEEN $2::date AND $3::date
       UNION ALL
       SELECT sa.employee_id, sa.work_date, sa.assignment_status, 0, 0, 0
       FROM shift_assignments sa
       WHERE sa.restaurant_id = $1 AND sa.work_date BETWEEN $2::date AND $3::date
         AND sa.assignment_status IN ('week_off', 'leave')
         AND NOT EXISTS (SELECT 1 FROM attendance a
                         WHERE a.employee_id = sa.employee_id AND a.attendance_date = sa.work_date)
     ), days AS (
       SELECT raw.*, COALESCE(rate.salary_type, e.salary_type) AS salary_type,
              COALESCE(rate.salary_amount, e.salary_amount) AS salary_amount
       FROM raw
       JOIN employees e ON e.id = raw.employee_id
       ${rateOn("raw.employee_id", "raw.day")}
     )
     SELECT employee_id, to_char(day, 'YYYY-MM') AS month, salary_type, salary_amount,
            EXTRACT(DAY FROM (date_trunc('month', day) + INTERVAL '1 month - 1 day'))::int AS days_in_month,
            COUNT(*) FILTER (WHERE status = 'present')::int AS present_days,
            COUNT(*) FILTER (WHERE status = 'half_day')::int AS half_days,
            COUNT(*) FILTER (WHERE status = 'absent')::int AS absent_days,
            COUNT(*) FILTER (WHERE status = 'leave')::int AS leave_days,
            COUNT(*) FILTER (WHERE status = 'week_off')::int AS week_offs,
            COALESCE(SUM(worked_minutes), 0)::int AS worked_minutes,
            COALESCE(SUM(late_minutes), 0)::int AS late_minutes,
            COALESCE(SUM(overtime_minutes), 0)::int AS overtime_minutes,
            -- Which days were leave, so each can be judged paid or unpaid by
            -- the person's leave allowance.
            COALESCE(ARRAY_AGG(day::text ORDER BY day) FILTER (WHERE status = 'leave'), '{}') AS leave_dates,
            COUNT(*) FILTER (WHERE late_minutes > 0)::int AS late_days
     FROM days
     WHERE ($4::bigint IS NULL OR employee_id = $4)
     GROUP BY employee_id, to_char(day, 'YYYY-MM'), days_in_month, salary_type, salary_amount
     ORDER BY employee_id, month, MIN(day)`,
    [restaurantId, from, to, employeeId]
  );

  return result.rows;
};

const findPayrollSettings = async (restaurantId, db = pool) => {
  const result = await db.query(
    "SELECT week_offs_paid, leave_paid, updated_at FROM payroll_settings WHERE restaurant_id = $1",
    [restaurantId]
  );

  return result.rows[0] || { week_offs_paid: true, leave_paid: true, updated_at: null };
};

const savePayrollSettings = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO payroll_settings (restaurant_id, week_offs_paid, leave_paid, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (restaurant_id) DO UPDATE SET
       week_offs_paid = EXCLUDED.week_offs_paid,
       leave_paid = EXCLUDED.leave_paid,
       updated_by = EXCLUDED.updated_by
     RETURNING week_offs_paid, leave_paid, updated_at`,
    [restaurantId, data.weekOffsPaid, data.leavePaid, userId]
  );

  return result.rows[0];
};

const findAdjustments = async (restaurantId, from, to, employeeId = null, db = pool) => {
  const result = await db.query(
    `SELECT pa.id, pa.employee_id, e.name AS employee_name, pa.adjustment_date, pa.kind, pa.amount,
            pa.note, pa.created_at, u.name AS created_by_name, pa.carried_from_payment_id
     FROM payroll_adjustments pa
     JOIN employees e ON e.id = pa.employee_id
     LEFT JOIN users u ON u.id = pa.created_by
     WHERE pa.restaurant_id = $1 AND pa.adjustment_date BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR pa.employee_id = $4)
     ORDER BY pa.adjustment_date DESC, pa.id DESC`,
    [restaurantId, from, to, employeeId]
  );

  return result.rows;
};

const findAdjustmentById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT pa.id, pa.employee_id, e.name AS employee_name, pa.adjustment_date, pa.kind, pa.amount, pa.note,
            pa.carried_from_payment_id
     FROM payroll_adjustments pa
     JOIN employees e ON e.id = pa.employee_id
     WHERE pa.restaurant_id = $1 AND pa.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createAdjustment = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO payroll_adjustments (restaurant_id, employee_id, adjustment_date, kind, amount, note,
                                      created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING id`,
    [restaurantId, data.employeeId, data.adjustmentDate, data.kind, data.amount, data.note, userId]
  );

  return findAdjustmentById(restaurantId, result.rows[0].id);
};

const removeAdjustment = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM payroll_adjustments WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// `carried` lists what this payment moved into the next pay period: an
// advance larger than the pay, or pay held back.
const PAYMENT_COLUMNS = `pp.id, pp.employee_id, e.name AS employee_name, e.employee_code,
  pp.period_from, pp.period_to, pp.payable_days, pp.earned, pp.bonus, pp.advances, pp.deductions,
  pp.amount_paid, pp.payment_method, pp.paid_on, pp.reference, pp.note, pp.created_at,
  pp.tips, pp.paid_leave_days, pp.unpaid_leave_days, pp.pf_wages, pp.pf_employee, pp.pf_employer,
  pp.esi_wages, pp.esi_employee, pp.esi_employer, pp.professional_tax,
  u.name AS created_by_name,
  COALESCE((SELECT json_agg(json_build_object('id', c.id, 'kind', c.kind, 'amount', c.amount,
                                              'date', c.adjustment_date) ORDER BY c.id)
            FROM payroll_adjustments c WHERE c.carried_from_payment_id = pp.id), '[]'::json) AS carried`;

// Payments whose period overlaps [from, to].
const findPayments = async (db, restaurantId, from, to, employeeId = null) => {
  const result = await db.query(
    `SELECT ${PAYMENT_COLUMNS}
     FROM payroll_payments pp
     JOIN employees e ON e.id = pp.employee_id
     LEFT JOIN users u ON u.id = pp.created_by
     WHERE pp.restaurant_id = $1
       AND pp.period_from <= $3::date AND pp.period_to >= $2::date
       AND ($4::bigint IS NULL OR pp.employee_id = $4)
     ORDER BY pp.paid_on DESC, pp.id DESC`,
    [restaurantId, from, to, employeeId]
  );

  return result.rows;
};

const findPaymentById = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${PAYMENT_COLUMNS}
     FROM payroll_payments pp
     JOIN employees e ON e.id = pp.employee_id
     LEFT JOIN users u ON u.id = pp.created_by
     WHERE pp.restaurant_id = $1 AND pp.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Writes one payment and what it carries into the next period, on the
// transaction's client. Returns the new payment's id.
const insertPayment = async (client, restaurantId, employeeId, from, to, data, userId) => {
  // Pay held back, or an advance bigger than the pay, goes into the next pay
  // period that is not already paid, tied to this payment so undoing the
  // payment takes it back out.
  const carries = data.carries || [];

  const inserted = await client.query(
    `INSERT INTO payroll_payments (restaurant_id, employee_id, period_from, period_to, payable_days,
                                   earned, bonus, advances, deductions, amount_paid, payment_method,
                                   paid_on, reference, note, created_by, updated_by,
                                   tips, paid_leave_days, unpaid_leave_days, pf_wages, pf_employee,
                                   pf_employer, esi_wages, esi_employee, esi_employer, professional_tax)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15,
             $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
     RETURNING id`,
    [
      restaurantId,
      employeeId,
      from,
      to,
      data.payableDays,
      data.earned,
      data.bonus,
      data.advances,
      data.deductions,
      data.amountPaid,
      data.paymentMethod,
      data.paidOn,
      data.reference,
      data.note,
      userId,
      data.tips || 0,
      data.paidLeaveDays || 0,
      data.unpaidLeaveDays || 0,
      data.pfWages || 0,
      data.pfEmployee || 0,
      data.pfEmployer || 0,
      data.esiWages || 0,
      data.esiEmployee || 0,
      data.esiEmployer || 0,
      data.professionalTax || 0,
    ]
  );

  const paymentId = inserted.rows[0].id;

  if (carries.length > 0) {
    let date = (await client.query("SELECT ($1::date + 1)::text AS day", [to])).rows[0].day;

    // Skip over any later period already paid for this person.
    for (let hop = 0; hop < 60; hop += 1) {
      const covering = await client.query(
        `SELECT period_to FROM payroll_payments
         WHERE restaurant_id = $1 AND employee_id = $2
           AND period_from <= $3::date AND period_to >= $3::date
         LIMIT 1`,
        [restaurantId, employeeId, date]
      );

      if (covering.rows.length === 0) {
        break;
      }

      date = (await client.query("SELECT ($1::date + 1)::text AS day", [covering.rows[0].period_to])).rows[0].day;
    }

    for (const carry of carries) {
      await client.query(
        `INSERT INTO payroll_adjustments (restaurant_id, employee_id, adjustment_date, kind, amount, note,
                                          carried_from_payment_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [restaurantId, employeeId, date, carry.kind, carry.amount, carry.note, paymentId, userId]
      );
    }
  }

  return paymentId;
};

// Marks a period paid. The employee row is locked first, so two clicks on
// "Mark paid" cannot both pass the overlap check and pay the same days twice.
// `build(client)` works out the figures inside the same transaction.
const createPayment = async (restaurantId, employeeId, from, to, build, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM employees WHERE restaurant_id = $1 AND id = $2 FOR UPDATE", [
      restaurantId,
      employeeId,
    ]);

    const overlapping = await findPayments(client, restaurantId, from, to, employeeId);

    if (overlapping.length > 0) {
      await client.query("ROLLBACK");
      return { overlapping };
    }

    const data = await build(client);
    const paymentId = await insertPayment(client, restaurantId, employeeId, from, to, data, userId);

    const payment = await findPaymentById(restaurantId, paymentId, client);

    await client.query("COMMIT");
    return { payment };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Marks several people paid for one period in ONE transaction ("Mark all
// paid"): every employee row is locked first (in id order, so two of these
// cannot deadlock), then nobody may already be paid for any of these days,
// then `build(client)` works out everyone's figures on the same client and
// returns [{ employeeId, data }]. Either everyone is paid or nobody is.
const createPayments = async (restaurantId, employeeIds, from, to, build, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM employees WHERE restaurant_id = $1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE",
      [restaurantId, employeeIds]
    );

    const wanted = new Set(employeeIds.map(Number));
    const overlapping = (await findPayments(client, restaurantId, from, to)).filter((row) =>
      wanted.has(Number(row.employee_id))
    );

    if (overlapping.length > 0) {
      await client.query("ROLLBACK");
      return { overlapping };
    }

    const lines = await build(client);
    const payments = [];

    for (const line of lines) {
      const paymentId = await insertPayment(client, restaurantId, line.employeeId, from, to, line.data, userId);
      payments.push(await findPaymentById(restaurantId, paymentId, client));
    }

    await client.query("COMMIT");
    return { payments };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// A balance this payment carried forward that has since been paid out in a
// later period: the payment cannot be undone before that later one.
const findSettledCarries = async (restaurantId, paymentId) => {
  const result = await pool.query(
    `SELECT c.id, c.kind, c.amount, c.adjustment_date, later.period_from, later.period_to
     FROM payroll_adjustments c
     JOIN payroll_payments later ON later.restaurant_id = c.restaurant_id
       AND later.employee_id = c.employee_id
       AND later.period_from <= c.adjustment_date AND later.period_to >= c.adjustment_date
     WHERE c.restaurant_id = $1 AND c.carried_from_payment_id = $2`,
    [restaurantId, paymentId]
  );

  return result.rows;
};

// Whether one person's pay covering this day has been marked paid.
const findPaidPeriod = async (restaurantId, employeeId, date) => {
  const result = await pool.query(
    `SELECT id, period_from, period_to FROM payroll_payments
     WHERE restaurant_id = $1 AND employee_id = $2
       AND period_from <= $3::date AND period_to >= $3::date
     LIMIT 1`,
    [restaurantId, employeeId, date]
  );

  return result.rows[0] || null;
};

// Everyone whose pay covering this day has been marked paid.
const findPaidEmployeeIds = async (restaurantId, date) => {
  const result = await pool.query(
    `SELECT DISTINCT employee_id FROM payroll_payments
     WHERE restaurant_id = $1 AND period_from <= $2::date AND period_to >= $2::date`,
    [restaurantId, date]
  );

  return new Set(result.rows.map((row) => Number(row.employee_id)));
};

const removePayment = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM payroll_payments WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- PF, ESI and professional tax settings ---------------------------------------

// ESI: who of these people was covered at the start of the contribution
// period beginning `periodStart` (statutory.service esiPeriodStart), so stays
// covered to its end whatever their gross pay does. Covered means either
//   - a pay period of theirs already paid in this contribution period, before
//     `before`, deducted ESI; or
//   - their monthly salary on the day the contribution period began (or the
//     day they joined, when later) was within the ESI limit.
// Returns the ids of those covered.
const findEsiCovered = async (restaurantId, employeeIds, periodStart, before, wageLimit, db = pool) => {
  if (!employeeIds.length) {
    return new Set();
  }

  const result = await db.query(
    `SELECT e.id
     FROM employees e
     WHERE e.restaurant_id = $1 AND e.id = ANY($2::bigint[])
       AND (EXISTS (SELECT 1 FROM payroll_payments pp
                    WHERE pp.restaurant_id = $1 AND pp.employee_id = e.id
                      AND pp.period_from >= $3::date AND pp.period_from < $4::date
                      AND pp.esi_employee > 0)
            OR EXISTS (SELECT 1 FROM (
                         SELECT h.salary_type, h.salary_amount
                         FROM employee_salary_history h
                         WHERE h.restaurant_id = $1 AND h.employee_id = e.id
                         -- the salary in force that day; days before the
                         -- first row use the first row (the salary they
                         -- joined on)
                         ORDER BY (h.effective_from <= GREATEST($3::date, COALESCE(e.date_of_joining, $3::date))) DESC,
                                  CASE WHEN h.effective_from <= GREATEST($3::date, COALESCE(e.date_of_joining, $3::date))
                                       THEN h.effective_from END DESC,
                                  h.effective_from
                         LIMIT 1) s
                       WHERE s.salary_type = 'monthly' AND s.salary_amount > 0 AND s.salary_amount <= $5))`,
    [restaurantId, employeeIds, periodStart, before, wageLimit]
  );

  return new Set(result.rows.map((row) => Number(row.id)));
};

const findStatutorySettings = async (restaurantId, db = pool) => {
  const result = await db.query("SELECT * FROM statutory_settings WHERE restaurant_id = $1", [restaurantId]);
  return result.rows[0] || null;
};

const findGstNumber = async (restaurantId, db = pool) => {
  const result = await db.query("SELECT gst_number FROM restaurant_settings WHERE restaurant_id = $1", [restaurantId]);
  return result.rows[0] ? result.rows[0].gst_number : null;
};

const saveStatutorySettings = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO statutory_settings (restaurant_id, pf_enabled, pf_employee_rate, pf_employer_rate, pf_wage_ceiling,
                                     esi_enabled, esi_employee_rate, esi_employer_rate, esi_wage_limit,
                                     pt_enabled, pt_state, pt_slabs, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $13)
     ON CONFLICT (restaurant_id) DO UPDATE SET
       pf_enabled = EXCLUDED.pf_enabled, pf_employee_rate = EXCLUDED.pf_employee_rate,
       pf_employer_rate = EXCLUDED.pf_employer_rate, pf_wage_ceiling = EXCLUDED.pf_wage_ceiling,
       esi_enabled = EXCLUDED.esi_enabled, esi_employee_rate = EXCLUDED.esi_employee_rate,
       esi_employer_rate = EXCLUDED.esi_employer_rate, esi_wage_limit = EXCLUDED.esi_wage_limit,
       pt_enabled = EXCLUDED.pt_enabled, pt_state = EXCLUDED.pt_state, pt_slabs = EXCLUDED.pt_slabs,
       updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [
      restaurantId,
      data.pfEnabled,
      data.pfEmployeeRate,
      data.pfEmployerRate,
      data.pfWageCeiling,
      data.esiEnabled,
      data.esiEmployeeRate,
      data.esiEmployerRate,
      data.esiWageLimit,
      data.ptEnabled,
      data.ptState,
      JSON.stringify(data.ptSlabs),
      userId,
    ]
  );

  return result.rows[0];
};

// --- The month's attendance register (muster roll) ----------------------------------

// Everyone the register covers for a month: active staff, and anyone who has
// since left but has a day recorded in it — the same people payroll covers.
const findMusterEmployees = async (restaurantId, from, to, filters = {}) => {
  const result = await pool.query(
    `SELECT e.id, e.name, e.employee_code, e.designation, e.department, e.status, e.outlet_id,
            o.name AS outlet_name, e.date_of_joining::text AS date_of_joining,
            e.date_of_leaving::text AS date_of_leaving
     FROM employees e
     LEFT JOIN outlets o ON o.id = e.outlet_id
     WHERE e.restaurant_id = $1
       AND ($4::bigint IS NULL OR e.outlet_id = $4)
       AND ($5::text IS NULL OR e.department = $5)
       AND (e.status = 'active'
            OR EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id
                         AND a.attendance_date BETWEEN $2::date AND $3::date))
     ORDER BY e.department, e.name`,
    [restaurantId, from, to, filters.outletId || null, filters.department || null]
  );

  return result.rows;
};

// Each day of the month per person: the sheet's day, else a week off or leave
// on the roster (counted by payroll even when the sheet was left blank), with
// whether the time clock recorded it.
const findMusterDays = async (restaurantId, from, to) => {
  const result = await pool.query(
    `SELECT employee_id, day, status, late_minutes, overtime_minutes, worked_minutes, leave_type_name, clocked
     FROM (
       SELECT a.employee_id, a.attendance_date::text AS day, a.attendance_status AS status,
              a.late_minutes, a.overtime_minutes, a.worked_minutes, lt.name AS leave_type_name,
              EXISTS (SELECT 1 FROM attendance_punches p WHERE p.employee_id = a.employee_id
                        AND p.work_date = a.attendance_date) AS clocked
       FROM attendance a
       LEFT JOIN shift_assignments sa ON sa.employee_id = a.employee_id AND sa.work_date = a.attendance_date
                                    AND sa.assignment_status = 'leave'
       LEFT JOIN leave_types lt ON lt.id = CASE WHEN a.attendance_status = 'leave'
                                                THEN COALESCE(a.leave_type_id, sa.leave_type_id) END
       WHERE a.restaurant_id = $1 AND a.attendance_date BETWEEN $2::date AND $3::date
       UNION ALL
       SELECT sa.employee_id, sa.work_date::text, sa.assignment_status, 0, 0, 0, lt.name, FALSE
       FROM shift_assignments sa
       LEFT JOIN leave_types lt ON lt.id = sa.leave_type_id
       WHERE sa.restaurant_id = $1 AND sa.work_date BETWEEN $2::date AND $3::date
         AND sa.assignment_status IN ('week_off', 'leave')
         AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = sa.employee_id
                           AND a.attendance_date = sa.work_date)
     ) days
     ORDER BY employee_id, day`,
    [restaurantId, from, to]
  );

  return result.rows;
};

// --- Copying a week of the roster ---------------------------------------------------

// The roster rows of a week, with whether each person is still working
// (active, not yet left) and whether each shift is still in use.
const findWeekRoster = async (db, restaurantId, from, to) => {
  const result = await db.query(
    `SELECT a.employee_id, a.work_date::text AS work_date, a.shift_id, a.assignment_status, a.notes,
            a.leave_type_id, e.name AS employee_name, e.status AS employee_status,
            e.date_of_leaving::text AS date_of_leaving, s.status AS shift_status, s.name AS shift_name
     FROM shift_assignments a
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN shifts s ON s.id = a.shift_id
     WHERE a.restaurant_id = $1 AND a.work_date BETWEEN $2::date AND $3::date
     ORDER BY a.work_date, e.name`,
    [restaurantId, from, to]
  );

  return result.rows;
};

// Pay already marked paid for anyone on these days: such days are skipped.
const findPaidRanges = async (db, restaurantId, from, to) => {
  const result = await db.query(
    `SELECT employee_id, period_from::text AS period_from, period_to::text AS period_to
     FROM payroll_payments
     WHERE restaurant_id = $1 AND period_from <= $3::date AND period_to >= $2::date`,
    [restaurantId, from, to]
  );

  return result.rows;
};

module.exports = {
  pool,
  findEsiCovered,
  findStatutorySettings,
  findGstNumber,
  saveStatutorySettings,
  findMusterEmployees,
  findMusterDays,
  findWeekRoster,
  findPaidRanges,
  findEmployees,
  findEmployeeById,
  createEmployee,
  updateEmployee,
  countAttendance,
  countHistory,
  removeEmployee,
  findShifts,
  findShiftById,
  createShift,
  updateShift,
  countShiftAssignments,
  removeShift,
  findRoster,
  findAssignment,
  findAssignmentById,
  upsertAssignment,
  removeAssignment,
  findAttendanceForDate,
  upsertAttendance,
  findAttendanceRow,
  hasPunches,
  findPayrollEmployees,
  payrollDays,
  findPayrollSettings,
  savePayrollSettings,
  findAdjustments,
  findAdjustmentById,
  createAdjustment,
  removeAdjustment,
  findPayments,
  findPaymentById,
  createPayment,
  createPayments,
  removePayment,
  findSettledCarries,
  findPaidPeriod,
  findPaidEmployeeIds,
  findSalaryHistory,
  findSalaryStart,
  findPaidThrough,
};
