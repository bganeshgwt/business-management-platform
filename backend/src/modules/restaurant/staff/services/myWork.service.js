const myWorkRepository = require("../repositories/myWork.repository");
const timeclockRepository = require("../repositories/timeclock.repository");
const leaveService = require("./leave.service");
const { localDate, safeZone, addDays } = require("./timeclock.service");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// "My work": the signed-in person's own shifts, attendance, leave and
// payslips. Found only through their own login's link to an employee record,
// so it needs no staff permission and can never show anyone else's: there is
// no employee id to ask for, and another person's payslip is "not found".

const NOT_LINKED =
  "Your login is not linked to a staff record yet, so there is no roster or pay to show. Ask your manager to link it under Staff → Employees.";

const requireEmployee = async (user) => {
  if (!user.restaurantId) {
    throw new AppError(404, NOT_LINKED, { reason: "not_linked" });
  }

  const employee = await myWorkRepository.findEmployeeForUser(user.restaurantId, user.id);

  if (!employee) {
    throw new AppError(404, NOT_LINKED, { reason: "not_linked" });
  }

  return employee;
};

const hm = (time) => (time ? String(time).slice(0, 5) : null);

const clock = (instant, timezone) =>
  instant
    ? new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
        new Date(instant)
      )
    : null;

// Monday of the week holding `date` (rosters run Monday to Sunday).
const mondayOf = (date) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
};

const lastDayOfMonth = (date) => {
  const [year, month] = date.slice(0, 7).split("-").map(Number);
  return `${date.slice(0, 7)}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
};

const toPayslip = (row) => {
  const n = (value) => Number(value || 0);
  const netPay = round2(
    n(row.earned) + n(row.bonus) + n(row.tips) - n(row.advances) - n(row.deductions) - n(row.pf_employee) - n(row.esi_employee) - n(row.professional_tax)
  );

  return {
    id: row.id,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    payableDays: n(row.payable_days),
    paidLeaveDays: n(row.paid_leave_days),
    unpaidLeaveDays: n(row.unpaid_leave_days),
    earned: n(row.earned),
    bonus: n(row.bonus),
    tips: n(row.tips),
    advances: n(row.advances),
    deductions: n(row.deductions),
    pfEmployee: n(row.pf_employee),
    esiEmployee: n(row.esi_employee),
    professionalTax: n(row.professional_tax),
    pfEmployer: n(row.pf_employer),
    esiEmployer: n(row.esi_employer),
    netPay,
    amountPaid: n(row.amount_paid),
    paymentMethod: row.payment_method,
    paidOn: row.paid_on,
    reference: row.reference || null,
  };
};

// A login not linked to a staff record (the owner, a manager without an
// employee row) is a normal answer, not an error: { linked: false } and the
// words to show, so the page says so without a failed request.
const overview = async (user, now = new Date()) => {
  const employee = user.restaurantId ? await myWorkRepository.findEmployeeForUser(user.restaurantId, user.id) : null;

  if (!employee) {
    return { linked: false, message: NOT_LINKED };
  }

  const restaurantId = user.restaurantId;
  const timezone = safeZone(await timeclockRepository.findTimezone(restaurantId));
  const today = localDate(now, timezone);
  const weekStart = mondayOf(today);
  const rosterTo = addDays(weekStart, 13);
  const monthFrom = `${today.slice(0, 7)}-01`;
  const monthTo = lastDayOfMonth(today);

  const [roster, monthRoster, attendance, payslips] = await Promise.all([
    myWorkRepository.findRoster(restaurantId, employee.id, weekStart, rosterTo),
    myWorkRepository.findRoster(restaurantId, employee.id, monthFrom, monthTo),
    myWorkRepository.findAttendance(restaurantId, employee.id, monthFrom, monthTo),
    myWorkRepository.findPayslips(restaurantId, employee.id),
  ]);

  let leave = null;

  try {
    const balances = await leaveService.balances(restaurantId, employee.id, today);
    leave = balances.types.length > 0 ? balances.types : null;
  } catch {
    leave = null;
  }

  // Two weeks of shifts, day by day (a day with nothing on the roster says so).
  const rosterBy = new Map(roster.map((row) => [row.work_date, row]));
  const weeks = [0, 1].map((week) => {
    const from = addDays(weekStart, week * 7);

    return {
      from,
      to: addDays(from, 6),
      label: week === 0 ? "This week" : "Next week",
      days: Array.from({ length: 7 }, (_, index) => {
        const date = addDays(from, index);
        const row = rosterBy.get(date);

        return {
          date,
          today: date === today,
          status: row ? row.assignment_status : "not_rostered",
          shiftName: row && row.assignment_status === "scheduled" ? row.shift_name : null,
          startTime: row ? hm(row.start_time) : null,
          endTime: row ? hm(row.end_time) : null,
          leaveType: row && row.assignment_status === "leave" ? row.leave_type_name : null,
          notes: row ? row.notes : null,
        };
      }),
    };
  });

  // This month's attendance, counted the way payroll counts it: the sheet,
  // plus a week off or leave on the roster that nobody marked.
  const marked = new Set(attendance.map((row) => row.day));
  const days = [
    ...attendance.map((row) => ({
      date: row.day,
      status: row.status,
      checkIn: clock(row.check_in, timezone),
      checkOut: clock(row.check_out, timezone),
      workedMinutes: Number(row.worked_minutes || 0),
      lateMinutes: Number(row.late_minutes || 0),
      overtimeMinutes: Number(row.overtime_minutes || 0),
      shiftName: row.shift_name || null,
      leaveType: row.leave_type_name || null,
    })),
    ...monthRoster
      .filter((row) => ["week_off", "leave"].includes(row.assignment_status) && !marked.has(row.work_date) && row.work_date <= today)
      .map((row) => ({
        date: row.work_date,
        status: row.assignment_status,
        checkIn: null,
        checkOut: null,
        workedMinutes: 0,
        lateMinutes: 0,
        overtimeMinutes: 0,
        shiftName: null,
        leaveType: row.leave_type_name || null,
      })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  const count = (status) => days.filter((day) => day.status === status).length;

  return {
    linked: true,
    employee: {
      id: employee.id,
      name: employee.name,
      employeeCode: employee.employee_code,
      designation: employee.designation,
      department: employee.department,
      outletName: employee.outlet_name || null,
    },
    today,
    weeks,
    month: {
      from: monthFrom,
      to: monthTo,
      present: count("present"),
      halfDays: count("half_day"),
      absent: count("absent"),
      leave: count("leave"),
      weekOffs: count("week_off"),
      lateDays: days.filter((day) => day.lateMinutes > 0).length,
      lateMinutes: days.reduce((sum, day) => sum + day.lateMinutes, 0),
      workedHours: round2(days.reduce((sum, day) => sum + day.workedMinutes, 0) / 60),
      overtimeHours: round2(days.reduce((sum, day) => sum + day.overtimeMinutes, 0) / 60),
      days,
    },
    leave,
    payslips: payslips.map(toPayslip),
  };
};

const payslip = async (user, paymentId) => {
  const employee = await requireEmployee(user);
  const row = await myWorkRepository.findPayslip(user.restaurantId, employee.id, paymentId);

  if (!row) {
    throw new AppError(404, "Payslip not found");
  }

  return {
    employee: { name: employee.name, employeeCode: employee.employee_code, designation: employee.designation },
    ...toPayslip(row),
  };
};

module.exports = {
  overview,
  payslip,
};
