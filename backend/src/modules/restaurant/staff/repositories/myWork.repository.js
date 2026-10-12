const pool = require("../../../../config/database");

// "My work": a person's own roster, attendance and payslips, found only
// through their own login's employee link. Every query is scoped by the
// restaurant and that one employee.

const findEmployeeForUser = async (restaurantId, userId) => {
  const result = await pool.query(
    `SELECT e.id, e.name, e.employee_code, e.designation, e.department, e.status, e.outlet_id,
            o.name AS outlet_name, e.date_of_joining::text AS date_of_joining
     FROM employees e
     LEFT JOIN outlets o ON o.id = e.outlet_id
     WHERE e.restaurant_id = $1 AND e.user_id = $2`,
    [restaurantId, userId]
  );

  return result.rows[0] || null;
};

const findRoster = async (restaurantId, employeeId, from, to) => {
  const result = await pool.query(
    `SELECT sa.work_date::text AS work_date, sa.assignment_status, sa.notes,
            s.name AS shift_name, s.start_time::text AS start_time, s.end_time::text AS end_time,
            s.break_minutes, lt.name AS leave_type_name
     FROM shift_assignments sa
     LEFT JOIN shifts s ON s.id = sa.shift_id
     LEFT JOIN leave_types lt ON lt.id = sa.leave_type_id
     WHERE sa.restaurant_id = $1 AND sa.employee_id = $2 AND sa.work_date BETWEEN $3::date AND $4::date
     ORDER BY sa.work_date`,
    [restaurantId, employeeId, from, to]
  );

  return result.rows;
};

const findAttendance = async (restaurantId, employeeId, from, to) => {
  const result = await pool.query(
    `SELECT a.attendance_date::text AS day, a.attendance_status AS status, a.check_in, a.check_out,
            a.worked_minutes, a.late_minutes, a.overtime_minutes, a.break_minutes,
            s.name AS shift_name, lt.name AS leave_type_name
     FROM attendance a
     LEFT JOIN shifts s ON s.id = a.shift_id
     LEFT JOIN leave_types lt ON lt.id = a.leave_type_id
     WHERE a.restaurant_id = $1 AND a.employee_id = $2 AND a.attendance_date BETWEEN $3::date AND $4::date
     ORDER BY a.attendance_date`,
    [restaurantId, employeeId, from, to]
  );

  return result.rows;
};

const PAYSLIP_COLUMNS = `pp.id, pp.period_from::text AS period_from, pp.period_to::text AS period_to,
  pp.payable_days, pp.earned, pp.bonus, pp.tips, pp.advances, pp.deductions, pp.pf_employee, pp.esi_employee,
  pp.professional_tax, pp.pf_employer, pp.esi_employer, pp.pf_wages, pp.esi_wages, pp.paid_leave_days,
  pp.unpaid_leave_days, pp.amount_paid, pp.payment_method, pp.paid_on::text AS paid_on, pp.reference,
  pp.created_at`;

// Their payments, newest first: each is a payslip once marked paid.
const findPayslips = async (restaurantId, employeeId, limit = 24) => {
  const result = await pool.query(
    `SELECT ${PAYSLIP_COLUMNS}
     FROM payroll_payments pp
     WHERE pp.restaurant_id = $1 AND pp.employee_id = $2
     ORDER BY pp.period_to DESC, pp.id DESC
     LIMIT $3`,
    [restaurantId, employeeId, limit]
  );

  return result.rows;
};

// One payslip, only if it is this employee's: anyone else's answers "not found".
const findPayslip = async (restaurantId, employeeId, paymentId) => {
  const result = await pool.query(
    `SELECT ${PAYSLIP_COLUMNS}
     FROM payroll_payments pp
     WHERE pp.restaurant_id = $1 AND pp.employee_id = $2 AND pp.id = $3`,
    [restaurantId, employeeId, paymentId]
  );

  return result.rows[0] || null;
};

module.exports = {
  findEmployeeForUser,
  findRoster,
  findAttendance,
  findPayslips,
  findPayslip,
};
