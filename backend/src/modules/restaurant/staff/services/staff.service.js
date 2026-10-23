const staffRepository = require("../repositories/staff.repository");
const queryAll = require("../../../../utils/queryAll");
const outletRepository = require("../../setup/repositories/outlet.repository");
const userRepository = require("../../../access/repositories/user.repository");
const timeclockRepository = require("../repositories/timeclock.repository");
const { shiftWindow, zonedInstant, addDays, localDate, safeZone } = require("./timeclock.service");
const leaveService = require("./leave.service");
const statutoryService = require("./statutory.service");
const tipService = require("./tip.service");
const AppError = require("../../../../utils/AppError");
const ruleSettings = require("../../setup/services/ruleSettings.service");
const { round2 } = require("../../../../utils/money");

// "16 Aug – 31 Aug 2026" for a pay period in words a person reads.
const dayWords = (value, withYear = false) =>
  new Date(`${String(value).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
const periodWords = (from, to) => `${dayWords(from)} – ${dayWords(to, true)}`;

// "₹12,166.67" for messages a person reads.
const money = (value) =>
  `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DUPLICATE = "23505";
const FOREIGN_KEY = "23503";

// Five minutes wiping down the station after the shift is not overtime. Staying
// a quarter of an hour or more past the end is, and then all of it counts —
// the same rule the time clock uses, so a typed-in day and a clocked day agree.
// The restaurant sets its own (Settings -> Alerts and timings); this is what
// it starts at.
const OVERTIME_THRESHOLD_MINUTES = ruleSettings.DEFAULTS.timeclockOvertimeMinutes;

// Longer than this between check-in and check-out is a typing mistake, not a
// shift (a double shift with overtime is about 14 hours).
const LONGEST_SHIFT_MINUTES = 20 * 60;

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toHourMinute = (time) => (time ? String(time).slice(0, 5) : null);

// The salary a row shows. The list reads the one in force today (a raise
// dated next month is not today's salary) and every one planned after it
// (plannedSalaries, oldest first; upcomingSalary is the first of them). Single
// records carry only the latest instruction, which is what they show.
const salaryOf = (row) => {
  const today = row.today_salary_amount !== undefined && row.today_salary_amount !== null;
  const planned =
    row.planned_salaries === undefined
      ? undefined
      : (row.planned_salaries || []).map((line) => ({
          from: String(line.from).slice(0, 10),
          salaryType: line.salaryType,
          salaryAmount: Number(line.salaryAmount),
        }));

  return {
    salaryType: today ? row.today_salary_type : row.salary_type,
    salaryAmount: Number(today ? row.today_salary_amount : row.salary_amount),
    upcomingSalary: planned && planned.length > 0 ? planned[0] : null,
    ...(planned ? { plannedSalaries: planned } : {}),
  };
};

// Salaries are private: without staff.salaries the amount and its type are
// left out entirely rather than shown as zero.
const toEmployee = (row, { salaries = true } = {}) => ({
  id: row.id,
  outletId: row.outlet_id,
  outletName: row.outlet_name,
  userId: row.user_id,
  loginEmail: row.login_email,
  loginMobile: row.login_mobile || null,
  loginName: row.login_name || null,
  employeeCode: row.employee_code,
  name: row.name,
  mobile: row.mobile,
  email: row.email,
  designation: row.designation,
  department: row.department,
  employmentType: row.employment_type,
  ...(salaries ? salaryOf(row) : { salaryType: null, salaryAmount: null, salaryHidden: true }),
  // PF, ESI and professional tax: part of pay, so only with the salaries.
  ...(salaries
    ? {
        pfApplicable: Boolean(row.pf_applicable),
        esiApplicable: Boolean(row.esi_applicable),
        ptApplicable: row.pt_applicable === undefined ? true : Boolean(row.pt_applicable),
        uan: row.uan || null,
        esiNumber: row.esi_number || null,
        basicPercent: row.basic_percent === undefined || row.basic_percent === null ? 100 : Number(row.basic_percent),
        // For the bank (NEFT) sheet on Payroll.
        bankAccountName: row.bank_account_name || null,
        bankAccountNumber: row.bank_account_number || null,
        bankIfsc: row.bank_ifsc || null,
      }
    : {}),
  // Asked for professional tax (some states tax women differently).
  gender: row.gender || null,
  dateOfJoining: row.date_of_joining,
  dateOfLeaving: row.date_of_leaving,
  address: row.address,
  emergencyContact: row.emergency_contact,
  notes: row.notes,
  status: row.status,
});

const toShift = (row) => ({
  id: row.id,
  name: row.name,
  startTime: toHourMinute(row.start_time),
  endTime: toHourMinute(row.end_time),
  breakMinutes: row.break_minutes,
  graceMinutes: row.grace_minutes,
  status: row.status,
  assignedCount: row.assigned_count,
});

const getTimezone = async (restaurantId) => safeZone(await timeclockRepository.findTimezone(restaurantId));

// Today's date on the restaurant's own clock.
const restaurantToday = async (restaurantId) => localDate(new Date(), await getTimezone(restaurantId));

// "18:05" in the restaurant's own clock, whatever clock the server keeps.
const clockTime = (instant, timezone) =>
  instant
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(instant))
    : null;

// --- Employees ---

const listEmployees = async (restaurantId, filters, { salaries = true } = {}) => {
  requireRestaurantId(restaurantId);

  const rows = await staffRepository.findEmployees(restaurantId, filters, await restaurantToday(restaurantId));
  return rows.map((row) => toEmployee(row, { salaries }));
};

// A login may belong to only one employee, and both must be in this restaurant.
const validateLinks = async (restaurantId, data, employeeId = null) => {
  if (data.outletId) {
    const outlet = await outletRepository.findById(restaurantId, data.outletId);

    if (!outlet) {
      throw new AppError(400, "Selected outlet does not exist");
    }
  }

  if (data.userId) {
    const user = await userRepository.findByIdForRestaurant(restaurantId, data.userId);

    if (!user) {
      throw new AppError(400, "Selected login does not belong to this restaurant");
    }

    const employees = await staffRepository.findEmployees(restaurantId, {});
    const taken = employees.find(
      (row) => Number(row.user_id) === Number(data.userId) && Number(row.id) !== Number(employeeId)
    );

    if (taken) {
      throw new AppError(409, `That login is already linked to ${taken.name}`);
    }
  }
};

const createEmployee = async (restaurantId, data, userId, { salaries = true } = {}) => {
  requireRestaurantId(restaurantId);
  await validateLinks(restaurantId, data);

  // Someone who cannot see salaries cannot set one either, nor PF or ESI.
  const input = salaries
    ? data
    : {
        ...data,
        salaryType: "monthly",
        salaryAmount: 0,
        pfApplicable: false,
        esiApplicable: false,
        ptApplicable: true,
        uan: null,
        esiNumber: null,
        basicPercent: 100,
        bankAccountName: null,
        bankAccountNumber: null,
        bankIfsc: null,
      };
  const today = await restaurantToday(restaurantId);

  try {
    return toEmployee(await staffRepository.createEmployee(restaurantId, input, userId, today), { salaries });
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "That employee code is already used");
    }

    throw error;
  }
};

// The day a first salary applies from when no date is given: the day they
// started, or the day after pay already marked paid, whichever is later.
const firstSalaryDate = (start) => {
  const afterPaid = start.paid_through ? addDays(String(start.paid_through).slice(0, 10), 1) : null;
  return afterPaid && afterPaid > start.started ? afterPaid : start.started;
};

// Returns the record before and after, so the change can be written down.
//
// A new salary (or salary type) applies from `data.salaryEffectiveFrom`,
// today when not given: every earlier day keeps the salary it had, so a raise
// never re-prices months already worked or paid. It cannot start inside a
// period already marked paid; a raise backdated that far is paid as a bonus
// in the next pay period instead.
const updateEmployee = async (restaurantId, id, data, userId, { salaries = true } = {}) => {
  requireRestaurantId(restaurantId);
  await validateLinks(restaurantId, data, id);

  const existing = await staffRepository.findEmployeeById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Employee not found");
  }

  // An edit that does not touch the salary keeps it exactly as it was,
  // planned raises and all: one by someone who cannot see salaries, and one
  // that leaves the salary out (the Employees form sends it only when it was
  // changed on purpose). Filling it in from the form instead is how saving a
  // name started a raise planned for next month today and deleted the one
  // after it.
  const keepSalary = !salaries || (data.salaryType === undefined && data.salaryAmount === undefined);
  // PF, ESI and professional tax details stay as they are unless someone who
  // may see salaries sends them.
  const statutory = {};

  for (const [field, column] of [
    ["pfApplicable", "pf_applicable"],
    ["esiApplicable", "esi_applicable"],
    ["ptApplicable", "pt_applicable"],
    ["uan", "uan"],
    ["esiNumber", "esi_number"],
    ["basicPercent", "basic_percent"],
    ["bankAccountName", "bank_account_name"],
    ["bankAccountNumber", "bank_account_number"],
    ["bankIfsc", "bank_ifsc"],
  ]) {
    statutory[field] = salaries && data[field] !== undefined ? data[field] : existing[column];
  }

  // Left out of an edit, the gender stays as it was.
  statutory.gender = data.gender !== undefined ? data.gender : existing.gender || null;

  const input = keepSalary
    ? { ...data, ...statutory, salaryType: existing.salary_type, salaryAmount: Number(existing.salary_amount) }
    : {
        ...data,
        ...statutory,
        salaryType: data.salaryType === undefined ? existing.salary_type : data.salaryType,
        salaryAmount: data.salaryAmount === undefined ? Number(existing.salary_amount) : data.salaryAmount,
      };

  // A new amount or type starts today unless a date is given. A date given
  // with the same salary moves when the current salary started ("the raise
  // I entered today really began on the 16th"). Only someone who may see
  // salaries can do either.
  //
  // A first real salary is different: someone added at ₹0 (by a supervisor
  // who cannot see pay, or before the owner decided it) has been working on
  // the salary the owner now enters, so it applies from the day they joined
  // (or the day after pay already marked paid), unless a date is given.
  // Starting it "today" would pay ₹0 for every day already worked.
  const salaryChanged =
    input.salaryType !== existing.salary_type ||
    Math.abs(Number(input.salaryAmount) - Number(existing.salary_amount)) >= 0.005;
  let salaryFrom = null;
  let firstSalary = false;

  if (salaries && salaryChanged) {
    const start =
      Number(input.salaryAmount) > 0 && Number(existing.salary_amount) === 0
        ? await staffRepository.findSalaryStart(restaurantId, id)
        : null;
    const neverPaid = Boolean(start && !start.had_salary);
    const firstFrom = neverPaid ? firstSalaryDate(start) : null;

    salaryFrom = data.salaryEffectiveFrom || firstFrom || (await restaurantToday(restaurantId));
    // Its ₹0 lines are replaced outright when it covers them all.
    firstSalary = neverPaid && salaryFrom <= start.started;
  } else if (!keepSalary) {
    salaryFrom = data.salaryEffectiveFrom || null;
  }

  try {
    const row = await staffRepository.updateEmployee(
      restaurantId,
      id,
      input,
      userId,
      salaryFrom ? { effectiveFrom: salaryFrom, first: firstSalary } : null
    );

    if (!row) {
      throw new AppError(404, "Employee not found");
    }

    if (row.paidThrough) {
      const paid = row.paidThrough;
      const earliest = addDays(String(paid.period_to).slice(0, 10), 1);

      throw new AppError(
        409,
        `${existing.name}'s pay is marked paid up to ${dayWords(paid.period_to, true)}, so a new salary can start on ${dayWords(earliest, true)} at the earliest. For a raise that goes back further, add the difference as a bonus in the next pay period.`,
        { reason: "salary_in_paid_period", earliest }
      );
    }

    return {
      before: toEmployee(existing, { salaries: true }),
      after: toEmployee(row, { salaries: true }),
      visible: toEmployee(row, { salaries }),
      salaryFrom,
    };
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "That employee code is already used");
    }

    throw error;
  }
};

// Every salary a person has had and from when, plus the last day their pay
// is marked paid up to (a new salary can start the day after, at the
// earliest).
const salaryHistory = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const employee = await staffRepository.findEmployeeById(restaurantId, id);

  if (!employee) {
    throw new AppError(404, "Employee not found");
  }

  const [rows, paidThrough, start] = await Promise.all([
    staffRepository.findSalaryHistory(restaurantId, id),
    staffRepository.findPaidThrough(restaurantId, id),
    staffRepository.findSalaryStart(restaurantId, id),
  ]);

  return {
    employeeId: employee.id,
    name: employee.name,
    salaryType: employee.salary_type,
    salaryAmount: Number(employee.salary_amount),
    paidThrough,
    earliestNewSalary: paidThrough ? addDays(paidThrough, 1) : null,
    // Never had a salary above ₹0: a salary entered now applies from this
    // day unless another is picked (see updateEmployee).
    firstSalaryFrom: start && !start.had_salary && Number(employee.salary_amount) === 0 ? firstSalaryDate(start) : null,
    items: rows.map((row) => ({
      id: row.id,
      from: row.effective_from,
      salaryType: row.salary_type,
      salaryAmount: Number(row.salary_amount),
      setBy: row.created_by_name || null,
      setAt: row.created_at,
    })),
  };
};

// Attendance, clock punches, deliveries and pay are records, so someone with
// any of them is marked inactive rather than deleted.
const removeEmployee = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const employee = await staffRepository.findEmployeeById(restaurantId, id);

  if (!employee) {
    throw new AppError(404, "Employee not found");
  }

  const days = await staffRepository.countAttendance(id);

  if (days > 0) {
    throw new AppError(
      409,
      `${employee.name} has ${days} day(s) of attendance. Set them to inactive instead, so their record stays.`
    );
  }

  const history = await staffRepository.countHistory(id);

  if (history.rider_orders > 0) {
    throw new AppError(
      409,
      `${employee.name} has delivered ${history.rider_orders} order(s) as a rider. Set them to inactive instead, so the delivery history keeps their name.`
    );
  }

  if (history.punches > 0) {
    throw new AppError(
      409,
      `${employee.name} has used the time clock. Set them to inactive instead, so their punches stay on record.`
    );
  }

  if (history.adjustments > 0 || history.payments > 0) {
    throw new AppError(
      409,
      `${employee.name} has pay records (advances, deductions or payments). Set them to inactive instead.`
    );
  }

  try {
    await staffRepository.removeEmployee(restaurantId, id);
  } catch (error) {
    // Anything else that still points at them (a record added by another
    // module): refuse in words rather than with a server error.
    if (error.code === FOREIGN_KEY) {
      throw new AppError(409, `${employee.name} is still referred to by other records. Set them to inactive instead.`);
    }

    throw error;
  }

  return toEmployee(employee, { salaries: false });
};

// --- Paid periods ---

// Once a person's pay for a period is marked paid, the days in it are closed:
// changing attendance or the roster there would change what they "earned"
// after the money was handed over, with nothing to show the difference.
// The fix is to undo that payment, or to record the difference as a bonus or
// deduction in the next pay period.
const assertDayNotPaid = async (restaurantId, employeeId, date, name) => {
  const paid = await staffRepository.findPaidPeriod(restaurantId, employeeId, date);

  if (paid) {
    throw new AppError(
      409,
      `${name}'s pay for ${periodWords(paid.period_from, paid.period_to)} is already marked paid, so ${dayWords(date, true)} cannot be changed. Undo that payment on Payroll first, or record the difference as a bonus or deduction in the next pay period.`,
      { reason: "paid_period" }
    );
  }
};

// --- Shifts ---

const listShifts = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await staffRepository.findShifts(restaurantId);
  return rows.map(toShift);
};

const createShift = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    return toShift(await staffRepository.createShift(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A shift named "${data.name}" already exists`);
    }

    throw error;
  }
};

const updateShift = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await staffRepository.findShiftById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Shift not found");
  }

  try {
    const row = await staffRepository.updateShift(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Shift not found");
    }

    return { before: toShift(existing), after: toShift(row) };
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A shift named "${data.name}" already exists`);
    }

    throw error;
  }
};

const removeShift = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const shift = await staffRepository.findShiftById(restaurantId, id);

  if (!shift) {
    throw new AppError(404, "Shift not found");
  }

  const assigned = await staffRepository.countShiftAssignments(id);

  if (assigned > 0) {
    throw new AppError(409, `This shift is on the roster ${assigned} time(s).`);
  }

  await staffRepository.removeShift(restaurantId, id);

  return toShift(shift);
};

// --- Roster ---

const getRoster = async (restaurantId, from, to) => {
  requireRestaurantId(restaurantId);

  const rows = await staffRepository.findRoster(restaurantId, from, to);

  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    shiftId: row.shift_id,
    shiftName: row.shift_name,
    startTime: toHourMinute(row.start_time),
    endTime: toHourMinute(row.end_time),
    workDate: row.work_date,
    assignmentStatus: row.assignment_status,
    leaveTypeId: row.leave_type_id || null,
    leaveTypeName: row.leave_type_name || null,
    notes: row.notes,
  }));
};

const rosterLabel = (row) =>
  row
    ? row.assignment_status === "scheduled"
      ? row.shift_name
      : row.assignment_status === "leave" && row.leave_type_name
        ? `${row.leave_type_name} leave`
        : row.assignment_status.replace("_", " ")
    : null;

// A leave type named on a leave day must be this restaurant's and in use.
const readLeaveType = async (restaurantId, status, leaveTypeId) => {
  if (status !== "leave" || !leaveTypeId) {
    return null;
  }

  const types = await leaveService.listTypes(restaurantId);
  const type = types.find((row) => Number(row.id) === Number(leaveTypeId));

  if (!type || type.status !== "active") {
    throw new AppError(400, "Choose one of the restaurant's leave types");
  }

  return type;
};

// Going over a leave allowance is allowed, but only once the manager has
// been told: the day will be unpaid. The screen asks first; a call without
// `acceptOverAllowance` is refused with the balance, so nothing goes over by
// accident.
const assertLeaveAllowance = async (restaurantId, employee, date, status, leaveTypeId, accept) => {
  if (status !== "leave" || accept) {
    return;
  }

  const check = await leaveService.checkDay(restaurantId, employee.id, date, leaveTypeId);

  if (check.overAllowance) {
    const balance = check.balance;
    throw new AppError(
      409,
      `${employee.name} has no ${check.type} leave left for ${balance.periodLabel} (${balance.available} day${
        balance.available === 1 ? "" : "s"
      } allowed, ${balance.taken - 1} taken), so this day would be unpaid. Save it anyway?`,
      { reason: "leave_over_allowance", balance, type: check.type }
    );
  }
};

const saveAssignment = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const employee = await staffRepository.findEmployeeById(restaurantId, data.employeeId);

  if (!employee) {
    throw new AppError(400, "Selected employee does not exist");
  }

  if (data.assignmentStatus === "scheduled" && !data.shiftId) {
    throw new AppError(400, "Choose a shift, or mark the day as week off or leave");
  }

  let shift = null;

  if (data.shiftId) {
    shift = await staffRepository.findShiftById(restaurantId, data.shiftId);

    if (!shift) {
      throw new AppError(400, "Selected shift does not exist");
    }
  }

  // A rostered week off or leave is paid even when nobody marked the sheet,
  // so the roster of a paid day is closed too.
  await assertDayNotPaid(restaurantId, data.employeeId, data.workDate, employee.name);

  const leaveType = await readLeaveType(restaurantId, data.assignmentStatus, data.leaveTypeId);
  await assertLeaveAllowance(
    restaurantId,
    employee,
    data.workDate,
    data.assignmentStatus,
    leaveType ? leaveType.id : null,
    data.acceptOverAllowance
  );

  const before = await staffRepository.findAssignment(restaurantId, data.employeeId, data.workDate);
  await staffRepository.upsertAssignment(restaurantId, { ...data, leaveTypeId: leaveType ? leaveType.id : null }, userId);

  return {
    roster: await getRoster(restaurantId, data.workDate, data.workDate),
    change: {
      employee: employee.name,
      date: data.workDate,
      before: rosterLabel(before),
      after:
        data.assignmentStatus === "scheduled"
          ? shift.name
          : leaveType
            ? `${leaveType.name} leave`
            : data.assignmentStatus.replace("_", " "),
    },
  };
};

const removeAssignment = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await staffRepository.findAssignmentById(restaurantId, id);

  if (existing) {
    await assertDayNotPaid(restaurantId, existing.employee_id, existing.work_date, existing.employee_name);
  }

  const removed = await staffRepository.removeAssignment(restaurantId, id);

  if (!removed) {
    throw new AppError(404, "Roster entry not found");
  }

  return existing;
};

// --- Attendance ---

const minutesBetween = (start, end) => Math.max(0, Math.round((end - start) / 60000));

// The shift for one date as real instants in the restaurant's timezone —
// the time clock's own shiftWindow, so "09:00" is nine in the morning in
// Kolkata even on a server that keeps UTC.
const windowFor = (shift, date, timezone) =>
  shift
    ? shiftWindow(
        date,
        {
          assignment_status: "scheduled",
          shift_id: shift.id,
          shift_name: shift.name,
          start_time: shift.start_time,
          end_time: shift.end_time,
          break_minutes: shift.break_minutes,
          grace_minutes: shift.grace_minutes,
        },
        timezone
      )
    : null;

// Works out hours, lateness and overtime from the times and the shift, so these
// figures are never typed in by hand. The rules match the time clock:
//   break    = the shift's break, taken off the hours (never more than the span)
//   worked   = (out - in) - break
//   late     = minutes after the shift start, less the grace minutes
//   overtime = time past the shift's end that is also genuinely extra hours
//              (arriving an hour late and staying 40 minutes is not overtime),
//              and only once it reaches the restaurant's overtime line
//              (15 minutes unless it set another)
const calculate = (window, checkIn, checkOut, status, overtimeFrom = OVERTIME_THRESHOLD_MINUTES) => {
  const none = { workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0, breakMinutes: 0 };

  if (!checkIn || !checkOut || ["absent", "leave", "week_off"].includes(status)) {
    return none;
  }

  const span = minutesBetween(checkIn, checkOut);
  const breakMinutes = window ? Math.min(window.breakMinutes, span) : 0;
  const worked = Math.max(0, span - breakMinutes);

  if (!window) {
    return { ...none, workedMinutes: worked };
  }

  const lateBy = checkIn > window.startsAt ? minutesBetween(window.startsAt, checkIn) : 0;
  const lateMinutes = Math.max(0, lateBy - window.graceMinutes);

  const pastEnd = checkOut > window.endsAt ? minutesBetween(window.endsAt, checkOut) : 0;
  const overtimeMinutes =
    pastEnd >= overtimeFrom
      ? Math.max(0, Math.min(pastEnd, worked - window.scheduledMinutes))
      : 0;

  return { workedMinutes: worked, lateMinutes, overtimeMinutes, breakMinutes };
};

const toAttendanceRow = (row, timezone, date) => ({
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  employeeCode: row.employee_code,
  department: row.department,
  attendanceId: row.attendance_id,
  attendanceStatus: row.attendance_status,
  checkIn: row.check_in,
  checkOut: row.check_out,
  // The same moments as wall-clock times at the restaurant, for the time boxes.
  checkInTime: clockTime(row.check_in, timezone),
  checkOutTime: clockTime(row.check_out, timezone),
  // A time after midnight still belongs to the day the shift started; these
  // say which of the two times fall on the next calendar day.
  checkInNextDay: Boolean(row.check_in && localDate(new Date(row.check_in), timezone) > date),
  checkOutNextDay: Boolean(row.check_out && localDate(new Date(row.check_out), timezone) > date),
  workedMinutes: row.worked_minutes || 0,
  breakMinutes: row.break_minutes || 0,
  lateMinutes: row.late_minutes || 0,
  overtimeMinutes: row.overtime_minutes || 0,
  notes: row.notes,
  shiftId: row.shift_id,
  shiftName: row.shift_name,
  startTime: toHourMinute(row.start_time),
  endTime: toHourMinute(row.end_time),
  shiftBreakMinutes: row.shift_break_minutes ?? null,
  overnight: Boolean(row.start_time && row.end_time && String(row.end_time) <= String(row.start_time)),
  rosterStatus: row.assignment_status,
  leaveTypeId: row.leave_type_id || null,
  leaveTypeName: row.leave_type_name || null,
  outletId: row.outlet_id || null,
  // Recorded on the time clock: corrected there, with a reason.
  clocked: Boolean(row.clocked),
});

const getAttendance = async (restaurantId, date) => {
  requireRestaurantId(restaurantId);

  const [timezone, rows] = await Promise.all([
    getTimezone(restaurantId),
    staffRepository.findAttendanceForDate(restaurantId, date),
  ]);

  return rows.map((row) => toAttendanceRow(row, timezone, date));
};

// The two ways a time can arrive: "18:05" on the restaurant's clock (what the
// attendance sheet sends), or a full timestamp (older screens and scripts).
//
// A wall-clock check-out that is not after the check-in is the next morning:
// in 17:00, out 01:00 is an eight-hour evening shift, not a mistake.
//
// On a shift that runs past midnight (22:00-06:00), a time before the shift's
// end is the early morning after the shift began: someone who arrives at
// 00:10 is 2h10 late on that night, not early on the morning before it.
const resolveTimes = (data, timezone, shift = null) => {
  if (data.checkInTime || data.checkOutTime) {
    const start = shift ? toHourMinute(shift.start_time) : null;
    const end = shift ? toHourMinute(shift.end_time) : null;
    const overnight = Boolean(shift && end <= start);
    const afterMidnight = (time) => overnight && time < end;

    const inDate =
      data.checkInTime && afterMidnight(data.checkInTime) ? addDays(data.attendanceDate, 1) : data.attendanceDate;
    const checkIn = data.checkInTime ? zonedInstant(inDate, data.checkInTime, timezone) : null;
    let checkOut = null;

    if (data.checkOutTime) {
      if (checkIn) {
        const sameDay = zonedInstant(inDate, data.checkOutTime, timezone);
        checkOut = sameDay <= checkIn ? zonedInstant(addDays(inDate, 1), data.checkOutTime, timezone) : sameDay;
      } else {
        const outDate =
          overnight && data.checkOutTime <= end ? addDays(data.attendanceDate, 1) : data.attendanceDate;
        checkOut = zonedInstant(outDate, data.checkOutTime, timezone);
      }
    }

    return { checkIn, checkOut };
  }

  return {
    checkIn: data.checkIn ? new Date(data.checkIn) : null,
    checkOut: data.checkOut ? new Date(data.checkOut) : null,
  };
};

const attendanceSnapshot = (row, timezone) =>
  row
    ? {
        status: row.attendance_status,
        in: clockTime(row.check_in, timezone),
        out: clockTime(row.check_out, timezone),
        worked: row.worked_minutes,
        late: row.late_minutes,
        overtime: row.overtime_minutes,
        ...(row.attendance_status === "leave" && row.leave_type_name ? { leaveType: row.leave_type_name } : {}),
        notes: row.notes,
      }
    : null;

const saveAttendance = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const employee = await staffRepository.findEmployeeById(restaurantId, data.employeeId);

  if (!employee) {
    throw new AppError(400, "Selected employee does not exist");
  }

  const shift = data.shiftId ? await staffRepository.findShiftById(restaurantId, data.shiftId) : null;

  if (data.shiftId && !shift) {
    throw new AppError(400, "Selected shift does not exist");
  }

  // A day the time clock recorded is corrected there, as a manager punch with
  // a reason, so the record keeps what the tablet saw. Typing over it here
  // would also be undone by the next punch.
  if (await staffRepository.hasPunches(restaurantId, data.employeeId, data.attendanceDate)) {
    throw new AppError(
      409,
      `${employee.name} used the time clock on this day. Correct it under Time clock by adding a punch with a reason.`,
      { reason: "clocked_day" }
    );
  }

  await assertDayNotPaid(restaurantId, data.employeeId, data.attendanceDate, employee.name);

  const leaveType = await readLeaveType(restaurantId, data.attendanceStatus, data.leaveTypeId);
  await assertLeaveAllowance(
    restaurantId,
    employee,
    data.attendanceDate,
    data.attendanceStatus,
    leaveType ? leaveType.id : null,
    data.acceptOverAllowance
  );

  const [timezone, rules] = await Promise.all([getTimezone(restaurantId), ruleSettings.load(restaurantId)]);
  const { checkIn, checkOut } = resolveTimes(data, timezone, shift);

  if (checkIn && checkOut && checkOut < checkIn) {
    throw new AppError(400, "Check-out cannot be before check-in");
  }

  if (checkIn && checkOut && minutesBetween(checkIn, checkOut) > LONGEST_SHIFT_MINUTES) {
    throw new AppError(
      400,
      "That is more than 20 hours on the clock. Check the times — for a shift past midnight, enter the time after midnight (for example 01:00)."
    );
  }

  const off = ["absent", "leave", "week_off"].includes(data.attendanceStatus);
  const window = windowFor(shift, data.attendanceDate, timezone);
  const totals = calculate(window, checkIn, checkOut, data.attendanceStatus, rules.timeclockOvertimeMinutes);

  const before = await staffRepository.findAttendanceRow(restaurantId, data.employeeId, data.attendanceDate);

  await staffRepository.upsertAttendance(
    restaurantId,
    {
      ...data,
      // A day off has no times: they would only confuse the hours later.
      checkIn: off ? null : checkIn,
      checkOut: off ? null : checkOut,
      leaveTypeId: leaveType ? leaveType.id : null,
      ...totals,
    },
    userId
  );

  const after = await staffRepository.findAttendanceRow(restaurantId, data.employeeId, data.attendanceDate);

  return {
    rows: await getAttendance(restaurantId, data.attendanceDate),
    change: {
      employee: employee.name,
      date: data.attendanceDate,
      before: attendanceSnapshot(before, timezone),
      after: attendanceSnapshot(after, timezone),
    },
  };
};

// "Mark remaining present": everyone with nothing recorded for the day, done
// the way the roster says — a rostered week off or leave is marked as that,
// never as a present (paid, worked) day. People on the roster are marked
// present for their shift's times. Nobody is guessed at: someone not on the
// roster, or whose shift has not finished yet, is left for the manager.
const markRemaining = async (restaurantId, date, userId, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const timezone = await getTimezone(restaurantId);

  if (date > localDate(now, timezone)) {
    throw new AppError(400, "Attendance cannot be marked for a day that has not happened yet");
  }

  const [rows, paidIds] = await Promise.all([
    staffRepository.findAttendanceForDate(restaurantId, date),
    staffRepository.findPaidEmployeeIds(restaurantId, date),
  ]);
  const result = { present: 0, weekOff: 0, leave: 0, skipped: [] };

  for (const row of rows.filter((item) => !item.attendance_id)) {
    const base = { employeeId: row.employee_id, attendanceDate: date, notes: null };

    if (paidIds.has(Number(row.employee_id))) {
      result.skipped.push({ name: row.employee_name, reason: "has already been paid for this day" });
      continue;
    }

    if (row.clocked) {
      result.skipped.push({ name: row.employee_name, reason: "is on the time clock for this day" });
      continue;
    }

    if (row.assignment_status === "week_off" || row.assignment_status === "leave") {
      await staffRepository.upsertAttendance(
        restaurantId,
        {
          ...base,
          shiftId: null,
          attendanceStatus: row.assignment_status,
          // A leave day keeps the leave type the roster gave it.
          leaveTypeId: row.assignment_status === "leave" ? row.leave_type_id : null,
          checkIn: null,
          checkOut: null,
          workedMinutes: 0,
          lateMinutes: 0,
          overtimeMinutes: 0,
          breakMinutes: 0,
        },
        userId
      );
      result[row.assignment_status === "week_off" ? "weekOff" : "leave"] += 1;
      continue;
    }

    if (row.assignment_status !== "scheduled" || !row.shift_id) {
      result.skipped.push({ name: row.employee_name, reason: "is not on the roster for this day" });
      continue;
    }

    const shift = {
      id: row.shift_id,
      name: row.shift_name,
      start_time: row.start_time,
      end_time: row.end_time,
      break_minutes: row.shift_break_minutes,
      grace_minutes: row.grace_minutes,
    };
    const window = windowFor(shift, date, timezone);

    if (window.endsAt > now) {
      result.skipped.push({
        name: row.employee_name,
        reason: `is on ${row.shift_name}, which has not finished yet`,
      });
      continue;
    }

    const totals = calculate(window, window.startsAt, window.endsAt, "present");

    await staffRepository.upsertAttendance(
      restaurantId,
      {
        ...base,
        shiftId: row.shift_id,
        attendanceStatus: "present",
        checkIn: window.startsAt,
        checkOut: window.endsAt,
        ...totals,
      },
      userId
    );
    result.present += 1;
  }

  return { ...result, rows: await getAttendance(restaurantId, date) };
};

// --- Payroll ---

const toPayment = (row) => ({
  id: row.id,
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  employeeCode: row.employee_code,
  periodFrom: row.period_from,
  periodTo: row.period_to,
  payableDays: Number(row.payable_days),
  earned: Number(row.earned),
  bonus: Number(row.bonus),
  tips: Number(row.tips || 0),
  advances: Number(row.advances),
  deductions: Number(row.deductions),
  paidLeaveDays: Number(row.paid_leave_days || 0),
  unpaidLeaveDays: Number(row.unpaid_leave_days || 0),
  pfWages: Number(row.pf_wages || 0),
  pfEmployee: Number(row.pf_employee || 0),
  pfEmployer: Number(row.pf_employer || 0),
  esiWages: Number(row.esi_wages || 0),
  esiEmployee: Number(row.esi_employee || 0),
  esiEmployer: Number(row.esi_employer || 0),
  professionalTax: Number(row.professional_tax || 0),
  netPay: round2(
    Number(row.earned) +
      Number(row.bonus) +
      Number(row.tips || 0) -
      Number(row.advances) -
      Number(row.deductions) -
      Number(row.pf_employee || 0) -
      Number(row.esi_employee || 0) -
      Number(row.professional_tax || 0)
  ),
  amountPaid: Number(row.amount_paid),
  // What this payment moved into the next pay period.
  carried: (row.carried || []).map((item) => ({
    id: item.id,
    kind: item.kind,
    amount: Number(item.amount),
    date: item.date,
  })),
  paymentMethod: row.payment_method,
  paidOn: row.paid_on,
  reference: row.reference,
  note: row.note,
  createdByName: row.created_by_name,
  createdAt: row.created_at,
});

const toAdjustment = (row) => ({
  id: row.id,
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  date: row.adjustment_date,
  kind: row.kind,
  amount: Number(row.amount),
  note: row.note,
  // Set when this is a balance carried over from an earlier payment.
  carriedFromPaymentId: row.carried_from_payment_id || null,
  createdByName: row.created_by_name || null,
  createdAt: row.created_at || null,
});

const getPayrollSettings = async (restaurantId, db = undefined) => {
  requireRestaurantId(restaurantId);

  const row = await staffRepository.findPayrollSettings(restaurantId, db);
  return { weekOffsPaid: row.week_offs_paid, leavePaid: row.leave_paid, updatedAt: row.updated_at };
};

const savePayrollSettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await getPayrollSettings(restaurantId);
  const row = await staffRepository.savePayrollSettings(restaurantId, data, userId);

  return {
    before,
    after: { weekOffsPaid: row.week_offs_paid, leavePaid: row.leave_paid, updatedAt: row.updated_at },
  };
};

// Turns attendance and the period's advances, deductions and bonuses into pay.
//
// Monthly salary is paid per calendar day of the month it falls in: a full
// month with every day accounted for (worked, week off, approved leave) pays
// exactly the monthly salary, in February as in August. A day's rate is the
// salary divided by that month's days, so a period spanning two months is
// priced correctly on both sides.
//
//   monthly  paid days = present + half days / 2
//                        + week offs (when week offs are paid)
//                        + leave days inside the person's leave allowance
//                          (with no leave types set up: all leave, when
//                          leave is paid)
//            "absent", leave over the allowance and Unpaid leave are loss
//            of pay
//   daily    paid days = present + half days / 2 (daily wage: days worked)
//   hourly   hours worked x rate
//
//   net pay  = earned + bonus + tips - advances - deductions
//              - PF, ESI and professional tax (when switched on)
//
// Overtime is listed, not paid automatically: most owners decide it case by
// case, and it can be added as a bonus.
//
// db: the pool, or the client of the transaction "Mark paid" holds, so every
// read runs on it (asking the pool for a second connection while holding one
// can freeze the API under a rush).
const computePayroll = async (restaurantId, from, to, employeeId = null, db = staffRepository.pool) => {
  const [settings, statutory, employees, dayRows, adjustmentRows, paymentRows, tips] = await queryAll(db, [
    () => getPayrollSettings(restaurantId, db),
    () => statutoryService.getSettings(restaurantId, db),
    () => staffRepository.findPayrollEmployees(restaurantId, from, to, employeeId, db),
    () => staffRepository.payrollDays(restaurantId, from, to, employeeId, db),
    () => staffRepository.findAdjustments(restaurantId, from, to, employeeId, db),
    () => staffRepository.findPayments(db, restaurantId, from, to, employeeId),
    () => tipService.tipsForPayroll(restaurantId, from, to, employeeId, db),
  ]);

  // Each leave day judged paid or unpaid by the person's leave allowance.
  const leave = await leaveService.forPayroll(restaurantId, employeeId ? [employeeId] : null, from, to, settings.leavePaid, db);

  // ESI: who was covered when this contribution period began (they stay
  // covered to its end, above the limit too).
  const esiCovered =
    statutory && statutory.esiEnabled
      ? await staffRepository.findEsiCovered(
          restaurantId,
          employees.filter((row) => row.esi_applicable).map((row) => Number(row.id)),
          statutoryService.esiPeriodStart(from),
          from,
          statutory.esiWageLimit,
          db
        )
      : new Set();

  const rows = employees.map((employee) => {
    // One group per calendar month and per salary in force (a raise on the
    // 15th gives two groups for that month), each priced at its own rate.
    const months = dayRows.filter((row) => Number(row.employee_id) === Number(employee.id));
    const salary = Number(employee.salary_amount);
    const sum = (field) => months.reduce((total, row) => total + Number(row[field] || 0), 0);

    const presentDays = sum("present_days");
    const halfDays = sum("half_days");
    const absentDays = sum("absent_days");
    const leaveDays = sum("leave_days");
    const weekOffs = sum("week_offs");
    const workedMinutes = sum("worked_minutes");
    const hours = round2(workedMinutes / 60);

    let earned = 0;
    let payableDays = 0;
    let paidWeekOffs = 0;
    let paidLeaveDays = 0;
    const leaveOf = leave.result.get(Number(employee.id)) || { paidDates: new Set(), unpaidDates: new Set() };

    for (const group of months) {
      const rate = Number(group.salary_amount);
      const worked = group.present_days + group.half_days * 0.5;

      if (group.salary_type === "monthly") {
        const weekOffPay = settings.weekOffsPaid ? group.week_offs : 0;
        const leavePay = (group.leave_dates || []).filter((date) => leaveOf.paidDates.has(date)).length;
        const paid = worked + weekOffPay + leavePay;

        payableDays += paid;
        paidWeekOffs += weekOffPay;
        paidLeaveDays += leavePay;
        earned += (rate * paid) / group.days_in_month;
      } else if (group.salary_type === "daily") {
        payableDays += worked;
        earned += rate * worked;
      } else {
        payableDays += worked;
        earned += rate * round2(Number(group.worked_minutes) / 60);
      }
    }

    earned = round2(earned);

    const mine = adjustmentRows.filter((row) => Number(row.employee_id) === Number(employee.id));
    const total = (kind) => round2(mine.filter((row) => row.kind === kind).reduce((s, row) => s + Number(row.amount), 0));
    // Pay held back from an earlier period is owed on top, like a bonus.
    const bonus = round2(total("bonus") + total("arrears"));
    const advances = total("advance");
    const deductions = total("deduction");
    const tipsAmount = round2(tips.get(Number(employee.id)) || 0);

    // PF on the basic share of what attendance earned; ESI and professional
    // tax on gross pay (earned plus this period's bonus, not pay carried
    // from an earlier period, and never tips).
    const stat = statutoryService.compute(
      statutory,
      {
        pfApplicable: Boolean(employee.pf_applicable),
        esiApplicable: Boolean(employee.esi_applicable),
        ptApplicable: employee.pt_applicable === undefined ? true : Boolean(employee.pt_applicable),
        basicPercent: Number(employee.basic_percent || 100),
        gender: employee.gender || null,
        esiCovered: esiCovered.has(Number(employee.id)),
      },
      { earned, bonus: total("bonus") },
      from,
      to
    );

    const computedNet = round2(
      earned + bonus + tipsAmount - advances - deductions - stat.pfEmployee - stat.esiEmployee - stat.professionalTax
    );

    const payments = paymentRows
      .filter((row) => Number(row.employee_id) === Number(employee.id))
      .map(toPayment);
    const paid = payments.find((payment) => payment.periodFrom === from && payment.periodTo === to) || null;

    // A period already paid keeps the PF, ESI and professional tax it was
    // paid with, and its net pay is the net that was paid: switching the
    // setting off, or changing a rate, later never rewrites a payslip already
    // handed over (nor the sheet's totals, which must match the money paid).
    const shown = paid
      ? {
          pfWages: paid.pfWages,
          pfEmployee: paid.pfEmployee,
          pfEmployer: paid.pfEmployer,
          esiWages: paid.esiWages,
          esiEmployee: paid.esiEmployee,
          esiEmployer: paid.esiEmployer,
          esiOverLimit: false,
          professionalTax: paid.professionalTax,
        }
      : stat;

    // Attendance or money in a paid period changed afterwards (the time clock
    // can still correct a day): the figures no longer match what was paid,
    // and the screen says so.
    // (PF, ESI and professional tax follow from these and the settings; a
    // paid period keeps the amounts it was paid with.)
    const changedSincePaid =
      paid &&
      [
        [paid.earned, round2(earned)],
        [paid.bonus, bonus],
        [paid.advances, advances],
        [paid.deductions, deductions],
        [paid.tips, tipsAmount],
      ].some(([then, now]) => Math.abs(Number(then) - Number(now)) >= 0.01)
        ? { netThen: paid.netPay, netNow: computedNet }
        : null;

    // What the row shows: what was paid, unless the figures have changed
    // since (then today's working, with the change flagged beside it).
    const netPay = paid && !changedSincePaid ? paid.netPay : computedNet;
    const statShown = paid && !changedSincePaid ? shown : stat;

    return {
      employeeId: employee.id,
      name: employee.name,
      employeeCode: employee.employee_code,
      department: employee.department,
      designation: employee.designation,
      status: employee.status,
      salaryType: employee.salary_type,
      salaryAmount: salary,
      // A new salary that started inside this period: its days are priced at
      // the new rate, the days before at the old one.
      salaryChanges: (employee.salary_changes || []).map((change) => ({
        from: change.from,
        salaryType: change.salaryType,
        salaryAmount: Number(change.salaryAmount),
      })),
      presentDays,
      halfDays,
      absentDays,
      leaveDays,
      weekOffs,
      paidWeekOffs,
      paidLeaveDays,
      // Leave beyond the allowance, Unpaid leave, and (for daily or hourly
      // pay) any leave: loss of pay.
      unpaidLeaveDays: leaveDays - paidLeaveDays,
      leaveTypesInUse: leave.hasTypes,
      payableDays,
      workedHours: hours,
      lateMinutes: sum("late_minutes"),
      lateDays: sum("late_days"),
      overtimeHours: round2(sum("overtime_minutes") / 60),
      // What attendance earned, before advances, deductions and bonuses.
      estimatedPay: earned,
      bonus,
      tips: tipsAmount,
      advances,
      deductions,
      pfApplicable: Boolean(employee.pf_applicable),
      esiApplicable: Boolean(employee.esi_applicable),
      uan: employee.uan || null,
      esiNumber: employee.esi_number || null,
      bankAccountName: employee.bank_account_name || null,
      bankAccountNumber: employee.bank_account_number || null,
      bankIfsc: employee.bank_ifsc || null,
      pfWages: statShown.pfWages,
      pfEmployee: statShown.pfEmployee,
      pfEmployer: statShown.pfEmployer,
      esiWages: statShown.esiWages,
      esiEmployee: statShown.esiEmployee,
      esiEmployer: statShown.esiEmployer,
      esiOverLimit: statShown.esiOverLimit,
      // Over the ESI limit but covered since the contribution period began.
      esiContinued: Boolean(statShown.esiContinued),
      professionalTax: statShown.professionalTax,
      statutoryDeductions: round2(statShown.pfEmployee + statShown.esiEmployee + statShown.professionalTax),
      netPay,
      // Paid for exactly this period, or for part of it.
      payments,
      paid,
      changedSincePaid,
      partlyPaid: payments.length > 0 && !paid,
    };
  });

  return { settings, statutory, rows, adjustments: adjustmentRows.map(toAdjustment) };
};

const payrollSummary = async (restaurantId, from, to) => {
  requireRestaurantId(restaurantId);

  const { settings, statutory, rows, adjustments } = await computePayroll(restaurantId, from, to);
  const add = (field) => round2(rows.reduce((sum, row) => sum + row[field], 0));

  return {
    settings,
    statutory: {
      pfEnabled: statutory.pfEnabled,
      esiEnabled: statutory.esiEnabled,
      ptEnabled: statutory.ptEnabled,
    },
    employees: rows,
    adjustments,
    totals: {
      headcount: rows.length,
      payableDays: rows.reduce((sum, row) => sum + row.payableDays, 0),
      workedHours: add("workedHours"),
      overtimeHours: add("overtimeHours"),
      estimatedPay: add("estimatedPay"),
      bonus: add("bonus"),
      tips: add("tips"),
      advances: add("advances"),
      deductions: add("deductions"),
      pfEmployee: add("pfEmployee"),
      pfEmployer: add("pfEmployer"),
      esiEmployee: add("esiEmployee"),
      esiEmployer: add("esiEmployer"),
      professionalTax: add("professionalTax"),
      statutoryDeductions: add("statutoryDeductions"),
      paidLeaveDays: rows.reduce((sum, row) => sum + row.paidLeaveDays, 0),
      unpaidLeaveDays: rows.reduce((sum, row) => sum + row.unpaidLeaveDays, 0),
      netPay: add("netPay"),
      paid: round2(
        rows.reduce((sum, row) => sum + (row.paid ? row.paid.amountPaid : 0), 0)
      ),
      paidCount: rows.filter((row) => row.paid).length,
    },
  };
};

// An advance, deduction or bonus lands in the pay period holding its date. A
// period already marked paid is closed: the entry goes in the next one.
const assertPeriodOpen = async (restaurantId, employeeId, date, name) => {
  const payments = await staffRepository.findPayments(staffRepository.pool, restaurantId, date, date, employeeId);

  if (payments.length > 0) {
    const paid = payments[0];

    throw new AppError(
      409,
      `${name}'s pay for ${paid.period_from} to ${paid.period_to} is already marked paid. Record this in the next pay period, or undo that payment first.`
    );
  }
};

const addAdjustment = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const employee = await staffRepository.findEmployeeById(restaurantId, data.employeeId);

  if (!employee) {
    throw new AppError(400, "Selected employee does not exist");
  }

  await assertPeriodOpen(restaurantId, data.employeeId, data.adjustmentDate, employee.name);

  return toAdjustment(await staffRepository.createAdjustment(restaurantId, data, userId));
};

const removeAdjustment = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await staffRepository.findAdjustmentById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Entry not found");
  }

  await assertPeriodOpen(restaurantId, existing.employee_id, existing.adjustment_date, existing.employee_name);
  await staffRepository.removeAdjustment(restaurantId, id);

  return toAdjustment(existing);
};

const listPayments = async (restaurantId, from, to) => {
  requireRestaurantId(restaurantId);

  const rows = await staffRepository.findPayments(staffRepository.pool, restaurantId, from, to);
  return rows.map(toPayment);
};

// What one payment records, worked out from the person's payroll row (never
// from the screen). `data.amountPaid` left out pays the full net pay. Paying
// more than is owed is refused; less carries the rest to the next period.
const paymentFigures = (row, name, data) => {
  const payable = Math.max(0, row.netPay);
  const amountPaid = round2(data.amountPaid ?? payable);

  // Paying more than is owed is almost always a slip of the finger (an
  // extra zero). Rounding up by less than a rupee is fine; anything more
  // is recorded first as a bonus or an advance, so the books say why.
  if (amountPaid > payable + 1) {
    throw new AppError(
      400,
      `${money(amountPaid)} is more than ${name}'s net pay of ${money(payable)} for this period. If you are paying extra, add it as a bonus or an advance first.`,
      { reason: "overpaid", netPay: row.netPay }
    );
  }

  const period = periodWords(data.from, data.to);
  const carries = [];

  // Advances and deductions bigger than the pay: the rest is still owed
  // by the employee and is taken from the next period, not forgotten.
  if (row.netPay < 0) {
    carries.push({
      kind: "advance",
      amount: round2(-row.netPay),
      note: `Advance balance carried from the pay for ${period}`,
    });
  }

  // Paid less than owed (part now, the rest later): the rest is still
  // owed to the employee and is added to the next period. Under a rupee
  // is rounding.
  const heldBack = round2(payable - amountPaid);

  if (heldBack >= 1) {
    carries.push({
      kind: "arrears",
      amount: heldBack,
      note: `Pay still owed from ${period}`,
    });
  }

  return {
    payableDays: row.payableDays,
    earned: row.estimatedPay,
    bonus: row.bonus,
    advances: row.advances,
    deductions: row.deductions,
    // Kept on the payment as they were paid.
    tips: row.tips,
    paidLeaveDays: row.paidLeaveDays,
    unpaidLeaveDays: row.unpaidLeaveDays,
    pfWages: row.pfWages,
    pfEmployee: row.pfEmployee,
    pfEmployer: row.pfEmployer,
    esiWages: row.esiWages,
    esiEmployee: row.esiEmployee,
    esiEmployer: row.esiEmployer,
    professionalTax: row.professionalTax,
    amountPaid,
    paymentMethod: data.paymentMethod,
    paidOn: data.paidOn,
    reference: data.reference,
    note: data.note,
    carries,
  };
};

// Marks one person's pay for a period as paid. The figures are worked out
// here, never taken from the screen, and kept on the payment as they stood.
const recordPayment = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const employee = await staffRepository.findEmployeeById(restaurantId, data.employeeId);

  if (!employee) {
    throw new AppError(400, "Selected employee does not exist");
  }

  // Paying for days that have not happened yet would close them: their
  // attendance could no longer be marked (a day off next week, an absence),
  // and the pay would be worked out before anyone knew it. Pay up to today;
  // money handed over early is an advance, which the month's pay takes back.
  const today = await restaurantToday(restaurantId);

  if (data.to > today) {
    throw new AppError(
      400,
      `This pay period runs to ${dayWords(data.to, true)}, which has not happened yet. Mark ${employee.name} paid up to today (${dayWords(today, true)}), or record the money as an advance, which the month's pay then takes back.`,
      { reason: "period_not_over", today }
    );
  }

  let figures = null;

  const result = await staffRepository.createPayment(
    restaurantId,
    data.employeeId,
    data.from,
    data.to,
    async (client) => {
      const { rows } = await computePayroll(restaurantId, data.from, data.to, data.employeeId, client);
      const row = rows[0];

      if (!row) {
        throw new AppError(400, `${employee.name} has nothing to pay for this period`);
      }

      figures = row;
      return paymentFigures(row, employee.name, data);
    },
    userId
  );

  if (result.overlapping) {
    const paid = result.overlapping[0];

    throw new AppError(
      409,
      `${employee.name} is already paid for ${paid.period_from} to ${paid.period_to}, which overlaps this period. Undo that payment first if it was wrong.`
    );
  }

  return { payment: toPayment(result.payment), figures };
};

// "Mark all paid": pays everyone listed for one period, each their full net
// pay, in ONE transaction (all or nobody), with the same rules as one
// payment: no future days, nobody already paid for any of these days, never
// more than the net pay, and an advance bigger than the pay carried forward.
// `expectedTotal` is the total the screen showed: if the figures changed
// since (someone marked attendance or added an advance), nothing is paid and
// the screen is asked to reload, so the owner pays what they were shown.
const recordPaymentsBulk = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const employeeIds = [...new Set(data.employeeIds.map(Number))];
  const today = await restaurantToday(restaurantId);

  if (data.to > today) {
    throw new AppError(
      400,
      `This pay period runs to ${dayWords(data.to, true)}, which has not happened yet. Pay up to today (${dayWords(today, true)}), or record the money as advances, which the month's pay then takes back.`,
      { reason: "period_not_over", today }
    );
  }

  const result = await staffRepository.createPayments(
    restaurantId,
    employeeIds,
    data.from,
    data.to,
    async (client) => {
      const { rows } = await computePayroll(restaurantId, data.from, data.to, null, client);
      const byId = new Map(rows.map((row) => [Number(row.employeeId), row]));
      const lines = employeeIds.map((employeeId) => {
        const row = byId.get(employeeId);

        if (!row) {
          throw new AppError(400, "One of the people chosen has nothing to pay for this period. Reload the pay sheet and try again.", {
            reason: "not_in_period",
            employeeId,
          });
        }

        return { employeeId, data: paymentFigures(row, row.name, { ...data, amountPaid: undefined }) };
      });

      const total = round2(lines.reduce((sum, line) => sum + line.data.amountPaid, 0));

      if (data.expectedTotal !== undefined && data.expectedTotal !== null && Math.abs(total - data.expectedTotal) >= 1) {
        throw new AppError(
          409,
          `The pay changed after the sheet was opened: it now comes to ${money(total)}, not ${money(data.expectedTotal)}. Nobody was marked paid. Reload the pay sheet and check it again.`,
          { reason: "total_changed", total }
        );
      }

      return lines;
    },
    userId
  );

  if (result.overlapping) {
    const names = [...new Set(result.overlapping.map((row) => row.employee_name))];

    throw new AppError(
      409,
      `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} ${names.length === 1 ? "is" : "are"} already paid for some of these days. Nobody was marked paid. Reload the pay sheet and try again.`,
      { reason: "already_paid", employeeIds: [...new Set(result.overlapping.map((row) => Number(row.employee_id)))] }
    );
  }

  return { payments: result.payments.map(toPayment) };
};

const removePayment = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await staffRepository.findPaymentById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Payment not found");
  }

  // Undoing it also takes back what it carried into the next period, unless
  // that period has been paid in turn.
  const settled = await staffRepository.findSettledCarries(restaurantId, id);

  if (settled.length > 0) {
    throw new AppError(
      409,
      `The balance this payment carried forward was settled in the pay for ${periodWords(settled[0].period_from, settled[0].period_to)}. Undo that payment first.`
    );
  }

  await staffRepository.removePayment(restaurantId, id);

  return toPayment(existing);
};

// --- PF, ESI and professional tax ------------------------------------------------------

const getStatutorySettings = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  return { ...(await statutoryService.getSettings(restaurantId)), presets: statutoryService.presets() };
};

const saveStatutorySettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  return statutoryService.saveSettings(restaurantId, data, userId);
};

const lastDayOf = (month) => {
  const [year, number] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, "0")}`;
};

// What a month's payroll owes the PF and ESI offices and the state, split
// into the employee's part (taken from pay) and the employer's (on top). A
// person already paid for exactly that month shows what they were paid with.
const statutorySummary = async (restaurantId, month) => {
  requireRestaurantId(restaurantId);

  const from = `${month}-01`;
  const to = lastDayOf(month);
  const { statutory, rows } = await computePayroll(restaurantId, from, to);

  const people = rows
    .map((row) => {
      const source = row.paid || row;

      return {
        employeeId: row.employeeId,
        name: row.name,
        employeeCode: row.employeeCode,
        uan: row.uan,
        esiNumber: row.esiNumber,
        grossPay: round2(row.estimatedPay + row.bonus),
        pfWages: source.pfWages,
        pfEmployee: source.pfEmployee,
        pfEmployer: source.pfEmployer,
        esiWages: source.esiWages,
        esiEmployee: source.esiEmployee,
        esiEmployer: source.esiEmployer,
        professionalTax: source.professionalTax,
        paid: Boolean(row.paid),
      };
    })
    .filter((row) => row.pfEmployee || row.pfEmployer || row.esiEmployee || row.esiEmployer || row.professionalTax);

  const add = (field) => round2(people.reduce((sum, row) => sum + Number(row[field] || 0), 0));
  const pfEmployee = add("pfEmployee");
  const pfEmployer = add("pfEmployer");
  const esiEmployee = add("esiEmployee");
  const esiEmployer = add("esiEmployer");
  const professionalTax = add("professionalTax");

  return {
    month,
    from,
    to,
    settings: { pfEnabled: statutory.pfEnabled, esiEnabled: statutory.esiEnabled, ptEnabled: statutory.ptEnabled, ptState: statutory.ptState },
    people,
    totals: {
      pfWages: add("pfWages"),
      pfEmployee,
      pfEmployer,
      pf: round2(pfEmployee + pfEmployer),
      esiWages: add("esiWages"),
      esiEmployee,
      esiEmployer,
      esi: round2(esiEmployee + esiEmployer),
      professionalTax,
      payable: round2(pfEmployee + pfEmployer + esiEmployee + esiEmployer + professionalTax),
    },
  };
};

// --- The month's attendance register (muster roll) ---------------------------------------

const MUSTER_CODES = { present: "P", absent: "A", half_day: "½", leave: "L", week_off: "WO" };

// One row per person, one cell per day: P, A, ½, L or WO, with a late mark;
// and each person's totals. The day counts are the ones payroll uses for the
// same month (the sheet, plus a week off or leave on the roster that nobody
// marked), so the register and the pay always agree.
const musterRoll = async (restaurantId, month, filters = {}) => {
  requireRestaurantId(restaurantId);

  const from = `${month}-01`;
  const to = lastDayOf(month);
  const [employees, dayRows, timezone] = await Promise.all([
    staffRepository.findMusterEmployees(restaurantId, from, to, filters),
    staffRepository.findMusterDays(restaurantId, from, to),
    getTimezone(restaurantId),
  ]);

  const days = [];

  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
  }

  const today = localDate(new Date(), timezone);
  const byEmployee = new Map();

  for (const row of dayRows) {
    const key = Number(row.employee_id);
    byEmployee.set(key, [...(byEmployee.get(key) || []), row]);
  }

  const rows = employees.map((employee) => {
    const cells = {};
    const totals = { present: 0, halfDays: 0, absent: 0, leave: 0, weekOffs: 0, lateDays: 0, overtimeMinutes: 0, workedMinutes: 0 };

    for (const row of byEmployee.get(Number(employee.id)) || []) {
      cells[row.day] = {
        code: MUSTER_CODES[row.status] || "?",
        status: row.status,
        late: Number(row.late_minutes) > 0,
        lateMinutes: Number(row.late_minutes),
        overtimeMinutes: Number(row.overtime_minutes),
        workedMinutes: Number(row.worked_minutes),
        leaveType: row.leave_type_name || null,
        clocked: Boolean(row.clocked),
      };

      totals.present += row.status === "present" ? 1 : 0;
      totals.halfDays += row.status === "half_day" ? 1 : 0;
      totals.absent += row.status === "absent" ? 1 : 0;
      totals.leave += row.status === "leave" ? 1 : 0;
      totals.weekOffs += row.status === "week_off" ? 1 : 0;
      totals.lateDays += Number(row.late_minutes) > 0 ? 1 : 0;
      totals.overtimeMinutes += Number(row.overtime_minutes);
      totals.workedMinutes += Number(row.worked_minutes);
    }

    // Days before they joined or after they left are not theirs to mark.
    for (const day of days) {
      if (!cells[day]) {
        const before = employee.date_of_joining && day < employee.date_of_joining;
        const after = employee.date_of_leaving && day > employee.date_of_leaving;
        cells[day] = before || after ? { code: "—", status: "not_employed" } : day > today ? { code: "", status: "future" } : { code: "", status: "unmarked" };
      }
    }

    return {
      employeeId: employee.id,
      name: employee.name,
      employeeCode: employee.employee_code,
      designation: employee.designation,
      department: employee.department,
      outletId: employee.outlet_id,
      outletName: employee.outlet_name,
      status: employee.status,
      cells,
      totals: {
        ...totals,
        overtimeHours: round2(totals.overtimeMinutes / 60),
        workedHours: round2(totals.workedMinutes / 60),
        // Days that count for pay: worked days plus week offs and leave
        // (whether leave is paid is the payroll's call, by allowance).
        markedDays: totals.present + totals.halfDays + totals.absent + totals.leave + totals.weekOffs,
        unmarked: days.filter((day) => cells[day].status === "unmarked").length,
      },
    };
  });

  const add = (field) => rows.reduce((sum, row) => sum + row.totals[field], 0);

  return {
    month,
    from,
    to,
    today,
    days,
    rows,
    totals: {
      people: rows.length,
      present: add("present"),
      halfDays: add("halfDays"),
      absent: add("absent"),
      leave: add("leave"),
      weekOffs: add("weekOffs"),
      lateDays: add("lateDays"),
      overtimeHours: round2(add("overtimeMinutes") / 60),
      unmarked: add("unmarked"),
    },
  };
};

// --- Copying last week's roster --------------------------------------------------------------

// Fills the week starting `weekStart` from the seven days before it, in one
// go: shifts, week offs and leave (with its type). A day already filled is
// kept unless `replace`. Skipped, with the reason: someone inactive or who
// has left by then, a shift no longer in use, a day whose pay is already
// marked paid. All or nothing: if anything fails, nothing is copied.
const copyWeek = async (restaurantId, { weekStart, replace }, userId) => {
  requireRestaurantId(restaurantId);

  const sourceFrom = addDays(weekStart, -7);
  const sourceTo = addDays(weekStart, -1);
  const targetTo = addDays(weekStart, 6);
  const client = await staffRepository.pool.connect();
  const result = { copied: 0, replaced: 0, skipped: [], from: weekStart, to: targetTo, sourceFrom, sourceTo };

  try {
    await client.query("BEGIN");

    const [source, target, paid] = await queryAll(client, [
      () => staffRepository.findWeekRoster(client, restaurantId, sourceFrom, sourceTo),
      () => staffRepository.findWeekRoster(client, restaurantId, weekStart, targetTo),
      () => staffRepository.findPaidRanges(client, restaurantId, weekStart, targetTo),
    ]);

    if (source.length === 0) {
      throw new AppError(400, `There is nothing on the roster for ${dayWords(sourceFrom)} – ${dayWords(sourceTo, true)} to copy.`, {
        reason: "empty_source",
      });
    }

    const filled = new Set(target.map((row) => `${row.employee_id}|${row.work_date}`));
    const skip = (row, date, reason) => result.skipped.push({ employeeId: row.employee_id, name: row.employee_name, date, reason });

    for (const row of source) {
      const date = addDays(row.work_date, 7);

      if (row.employee_status !== "active") {
        skip(row, date, "inactive");
        continue;
      }

      if (row.date_of_leaving && row.date_of_leaving < date) {
        skip(row, date, "left");
        continue;
      }

      if (row.assignment_status === "scheduled" && row.shift_status !== "active") {
        skip(row, date, "shift_not_used");
        continue;
      }

      if (paid.some((range) => Number(range.employee_id) === Number(row.employee_id) && range.period_from <= date && range.period_to >= date)) {
        skip(row, date, "paid");
        continue;
      }

      const already = filled.has(`${row.employee_id}|${date}`);

      if (already && !replace) {
        skip(row, date, "already_filled");
        continue;
      }

      await staffRepository.upsertAssignment(
        restaurantId,
        {
          employeeId: row.employee_id,
          shiftId: row.assignment_status === "scheduled" ? row.shift_id : null,
          workDate: date,
          assignmentStatus: row.assignment_status,
          leaveTypeId: row.leave_type_id,
          notes: row.notes,
        },
        userId,
        client
      );

      result.copied += 1;
      result.replaced += already ? 1 : 0;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { ...result, roster: await getRoster(restaurantId, weekStart, targetTo) };
};

module.exports = {
  restaurantToday,
  getStatutorySettings,
  saveStatutorySettings,
  statutorySummary,
  musterRoll,
  copyWeek,
  listEmployees,
  createEmployee,
  updateEmployee,
  removeEmployee,
  salaryHistory,
  listShifts,
  createShift,
  updateShift,
  removeShift,
  getRoster,
  saveAssignment,
  removeAssignment,
  getAttendance,
  saveAttendance,
  markRemaining,
  payrollSummary,
  getPayrollSettings,
  savePayrollSettings,
  addAdjustment,
  removeAdjustment,
  listPayments,
  recordPayment,
  recordPaymentsBulk,
  removePayment,
};
