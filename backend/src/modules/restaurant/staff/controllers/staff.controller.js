const staffService = require("../services/staff.service");
const leaveService = require("../services/leave.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const authorize = require("../../../../middlewares/authorize");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const readDate = (value, field, fallback = null) => {
  if (!value) {
    return fallback;
  }

  // "2026-02-30" has the right shape but is not a day; JavaScript would read
  // it as 2 March, so the round trip must give back the same text.
  if (
    typeof value !== "string" ||
    !DATE_PATTERN.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new AppError(400, `${field} must be a date like 2026-09-19`);
  }

  return value;
};

const readTime = (value, field) => {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new AppError(400, `${field} must be a time like 09:00`);
  }

  return value;
};

const optionalTime = (value, field) => (value === undefined || value === null || value === "" ? null : readTime(value, field));

// "Today" when a request leaves the date out: the restaurant's own date, not
// the server's (a server on UTC is still on yesterday until 5:30 am in India).
const todayFor = (req) => staffService.restaurantToday(req.user.restaurantId);

// Salaries are only for those who may see them. Checked here rather than on a
// route, so the role editor is told the permission is in use.
authorize.noteEnforced("staff.salaries");
const seesSalaries = (req) => (req.user.permissions || []).includes("staff.salaries");

// --- Employees ---

const given = (value) => value !== undefined && value !== null && value !== "";

// { update: true } for an edit: a salary left out means "leave it as it is"
// (planned raises included), not "₹0 per month from today".
const readEmployeeBody = (body = {}, { update = false } = {}) => {
  const dateOfJoining = readDate(body.dateOfJoining, "Date of joining");
  const dateOfLeaving = readDate(body.dateOfLeaving, "Date of leaving");

  // Checked here as well as in the database, so the user sees a clear message
  // instead of a constraint error.
  if (dateOfJoining && dateOfLeaving && dateOfLeaving < dateOfJoining) {
    throw new AppError(400, "The leaving date cannot be before the joining date");
  }

  return {
    name: v.requiredString(body.name, "Name", 150),
    employeeCode: body.employeeCode
      ? v.requiredString(body.employeeCode, "Employee code", 30).toUpperCase()
      : null,
    mobile: v.optionalString(body.mobile, "Mobile", 20),
    email: body.email ? v.requiredEmail(body.email, "Email") : null,
    designation: v.optionalString(body.designation, "Designation", 100),
    department: v.optionalEnum(
      body.department,
      "Department",
      ["kitchen", "service", "management", "delivery", "housekeeping", "other"],
      "service"
    ),
    employmentType: v.optionalEnum(
      body.employmentType,
      "Employment type",
      ["full_time", "part_time", "contract"],
      "full_time"
    ),
    salaryType:
      update && !given(body.salaryType)
        ? undefined
        : v.optionalEnum(body.salaryType, "Salary type", ["monthly", "daily", "hourly"], "monthly"),
    salaryAmount:
      update && !given(body.salaryAmount)
        ? undefined
        : (v.optionalNumber(body.salaryAmount, "Salary", { min: 0, max: 99999999 }) ?? 0),
    // When a changed salary starts (today when left out). Ignored when the
    // salary did not change.
    salaryEffectiveFrom: readDate(body.salaryEffectiveFrom, "New salary from"),
    dateOfJoining,
    dateOfLeaving,
    outletId: v.optionalNumber(body.outletId, "Outlet", { min: 1 }),
    userId: v.optionalNumber(body.userId, "Login", { min: 1 }),
    address: v.optionalString(body.address, "Address", 500),
    emergencyContact: v.optionalString(body.emergencyContact, "Emergency contact", 20),
    notes: v.optionalString(body.notes, "Notes", 500),
    status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
    // PF, ESI and professional tax. Left out of an edit, they stay as they
    // were (and only someone who may see salaries can change them).
    pfApplicable: given(body.pfApplicable) ? v.requiredBoolean(body.pfApplicable, "PF") : update ? undefined : false,
    esiApplicable: given(body.esiApplicable) ? v.requiredBoolean(body.esiApplicable, "ESI") : update ? undefined : false,
    ptApplicable: given(body.ptApplicable) ? v.requiredBoolean(body.ptApplicable, "Professional tax") : update ? undefined : true,
    uan: body.uan === undefined ? (update ? undefined : null) : readDigits(body.uan, "UAN", 12, 12),
    esiNumber: body.esiNumber === undefined ? (update ? undefined : null) : readDigits(body.esiNumber, "ESI number", 10, 17),
    // Salary bank account, for the payroll bank sheet. Left out of an edit, it stays.
    bankAccountName:
      body.bankAccountName === undefined
        ? update
          ? undefined
          : null
        : v.optionalString(body.bankAccountName, "Name on the account", 150) || null,
    bankAccountNumber:
      body.bankAccountNumber === undefined
        ? update
          ? undefined
          : null
        : readDigits(body.bankAccountNumber, "Bank account number", 6, 20),
    bankIfsc: body.bankIfsc === undefined ? (update ? undefined : null) : readIfsc(body.bankIfsc),
    basicPercent: given(body.basicPercent)
      ? v.requiredNumber(body.basicPercent, "Basic wages share", { min: 50, max: 100 })
      : update
        ? undefined
        : 100,
    // Optional; blank means "not given". Left out of an edit, it stays.
    gender:
      body.gender === undefined
        ? update
          ? undefined
          : null
        : body.gender === null || body.gender === ""
          ? null
          : v.requiredEnum(body.gender, "Gender", ["female", "male", "other"]),
  };
};

// A UAN is 12 digits; an ESI number 10 (up to 17 with a branch suffix).
// Spaces and dashes are ignored; blank clears it.
const readDigits = (value, field, min, max) => {
  if (value === null || value === "") {
    return null;
  }

  const digits = String(value).replace(/[\s-]/g, "");

  if (!/^\d+$/.test(digits) || digits.length < min || digits.length > max) {
    throw new AppError(400, min === max ? `${field} is ${min} digits` : `${field} is ${min} to ${max} digits`);
  }

  return digits;
};

// An IFSC is 11 characters: four letters, a zero, then six letters or digits
// ("HDFC0001234"). Spaces are ignored and letters made capitals; blank clears it.
const readIfsc = (value) => {
  if (value === null || value === "") {
    return null;
  }

  const code = String(value).replace(/\s/g, "").toUpperCase();

  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) {
    throw new AppError(400, "IFSC is 11 characters, like HDFC0001234 (on the cheque book or passbook)");
  }

  return code;
};

const listEmployees = async (req, res) => {
  const filters = {
    department: req.query.department
      ? v.requiredEnum(req.query.department, "Department", [
          "kitchen",
          "service",
          "management",
          "delivery",
          "housekeeping",
          "other",
        ])
      : null,
    status: req.query.status
      ? v.requiredEnum(req.query.status, "Status", ["active", "inactive"])
      : null,
    search: v.optionalString(req.query.search, "Search", 100),
  };

  res.json({
    success: true,
    data: await staffService.listEmployees(req.user.restaurantId, filters, { salaries: seesSalaries(req) }),
  });
};

const createEmployee = async (req, res) => {
  const salaries = seesSalaries(req);
  const employee = await staffService.createEmployee(
    req.user.restaurantId,
    readEmployeeBody(req.body),
    req.user.id,
    { salaries }
  );

  logAction(req, "create", "employee", {
    id: employee.id,
    label: employee.name,
    details: salaries
      ? { salaryType: employee.salaryType, changes: { salaryAmount: [null, employee.salaryAmount] } }
      : { department: employee.department },
  });

  res.status(201).json({ success: true, message: "Employee added", data: employee });
};

// Pay, status, dates and the linked login are the changes an owner looks for
// later ("who raised his salary?"), so each edit records them before and after.
const updateEmployee = async (req, res) => {
  const id = v.requiredId(req.params.id, "Employee id");
  const { before, after, visible, salaryFrom } = await staffService.updateEmployee(
    req.user.restaurantId,
    id,
    readEmployeeBody(req.body, { update: true }),
    req.user.id,
    { salaries: seesSalaries(req) }
  );

  logAction(req, "update", "employee", {
    id: after.id,
    label: after.name,
    details: {
      changes: diff(before, after, [
        "name",
        "employeeCode",
        "department",
        "designation",
        "salaryType",
        "salaryAmount",
        "status",
        "dateOfJoining",
        "dateOfLeaving",
        "userId",
        "outletId",
      ]),
      // The day a new salary starts; the days before keep the old one.
      ...(salaryFrom ? { salaryFrom } : {}),
      // Where salary goes is worth a line in the log (a changed account is
      // how pay gets diverted), but only the last four digits are written.
      ...(before.bankAccountNumber !== after.bankAccountNumber || before.bankIfsc !== after.bankIfsc
        ? {
            bankAccountChanged: [
              before.bankAccountNumber ? `…${before.bankAccountNumber.slice(-4)} ${before.bankIfsc || ""}`.trim() : null,
              after.bankAccountNumber ? `…${after.bankAccountNumber.slice(-4)} ${after.bankIfsc || ""}`.trim() : null,
            ],
          }
        : {}),
    },
  });

  res.json({ success: true, message: "Employee updated", data: visible });
};

// Every salary someone has had, and from when. Pay is private, so this sits
// behind staff.salaries (the route checks it).
const salaryHistory = async (req, res) => {
  const id = v.requiredId(req.params.id, "Employee id");

  res.json({ success: true, data: await staffService.salaryHistory(req.user.restaurantId, id) });
};

const removeEmployee = async (req, res) => {
  const id = v.requiredId(req.params.id, "Employee id");
  const removed = await staffService.removeEmployee(req.user.restaurantId, id);

  logAction(req, "delete", "employee", { id, label: removed.name });

  res.json({ success: true, message: "Employee removed" });
};

// --- Shifts ---

const readShiftBody = (body = {}) => ({
  name: v.requiredString(body.name, "Shift name", 100),
  startTime: readTime(body.startTime, "Start time"),
  endTime: readTime(body.endTime, "End time"),
  breakMinutes: v.optionalNumber(body.breakMinutes, "Break minutes", { min: 0, max: 599 }) ?? 0,
  graceMinutes: v.optionalNumber(body.graceMinutes, "Grace minutes", { min: 0, max: 119 }) ?? 10,
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

const listShifts = async (req, res) => {
  res.json({ success: true, data: await staffService.listShifts(req.user.restaurantId) });
};

const createShift = async (req, res) => {
  const shift = await staffService.createShift(
    req.user.restaurantId,
    readShiftBody(req.body),
    req.user.id
  );

  logAction(req, "create", "shift", {
    id: shift.id,
    label: shift.name,
    details: { startTime: shift.startTime, endTime: shift.endTime, breakMinutes: shift.breakMinutes },
  });

  res.status(201).json({ success: true, message: "Shift created", data: shift });
};

const updateShift = async (req, res) => {
  const id = v.requiredId(req.params.id, "Shift id");
  const { before, after } = await staffService.updateShift(
    req.user.restaurantId,
    id,
    readShiftBody(req.body),
    req.user.id
  );

  logAction(req, "update", "shift", {
    id: after.id,
    label: after.name,
    details: { changes: diff(before, after, ["name", "startTime", "endTime", "breakMinutes", "graceMinutes", "status"]) },
  });

  res.json({ success: true, message: "Shift updated", data: after });
};

const removeShift = async (req, res) => {
  const id = v.requiredId(req.params.id, "Shift id");
  const removed = await staffService.removeShift(req.user.restaurantId, id);

  logAction(req, "delete", "shift", { id, label: removed.name });

  res.json({ success: true, message: "Shift deleted" });
};

// --- Roster ---

const getRoster = async (req, res) => {
  const from = readDate(req.query.from, "From", await todayFor(req));
  const to = readDate(req.query.to, "To", from);

  res.json({ success: true, data: await staffService.getRoster(req.user.restaurantId, from, to) });
};

const saveAssignment = async (req, res) => {
  const body = req.body || {};

  const data = {
    employeeId: v.requiredId(body.employeeId, "Employee"),
    shiftId: v.optionalNumber(body.shiftId, "Shift", { min: 1 }),
    workDate: readDate(body.workDate, "Date", await todayFor(req)),
    assignmentStatus: v.optionalEnum(
      body.assignmentStatus,
      "Status",
      ["scheduled", "week_off", "leave"],
      "scheduled"
    ),
    // Which leave, on a leave day; and the manager's yes to going over the
    // allowance (the day is then unpaid).
    leaveTypeId: v.optionalNumber(body.leaveTypeId, "Leave type", { min: 1 }),
    acceptOverAllowance: body.acceptOverAllowance === true,
    notes: v.optionalString(body.notes, "Notes", 200),
  };

  const { roster, change } = await staffService.saveAssignment(req.user.restaurantId, data, req.user.id);

  if (change.before !== change.after) {
    logAction(req, "update", "roster", {
      id: data.employeeId,
      label: `${change.employee} · ${change.date}`,
      details: { changes: { roster: [change.before, change.after] } },
    });
  }

  res.status(201).json({ success: true, message: "Roster saved", data: roster });
};

const removeAssignment = async (req, res) => {
  const id = v.requiredId(req.params.id, "Roster id");
  const removed = await staffService.removeAssignment(req.user.restaurantId, id);

  logAction(req, "delete", "roster", {
    id,
    label: removed ? `${removed.employee_name} · ${removed.work_date}` : null,
  });

  res.json({ success: true, message: "Roster entry removed" });
};

// --- Attendance ---

const getAttendance = async (req, res) => {
  const date = readDate(req.query.date, "Date", await todayFor(req));

  res.json({ success: true, data: { date, rows: await staffService.getAttendance(req.user.restaurantId, date) } });
};

// Hours, lateness and overtime are calculated by the server from these times.
// Times come as "18:05" on the restaurant's clock (checkInTime/checkOutTime),
// or as full timestamps (checkIn/checkOut) from older callers.
const saveAttendance = async (req, res) => {
  const body = req.body || {};

  const data = {
    employeeId: v.requiredId(body.employeeId, "Employee"),
    attendanceDate: readDate(body.attendanceDate, "Date", await todayFor(req)),
    shiftId: v.optionalNumber(body.shiftId, "Shift", { min: 1 }),
    attendanceStatus: v.optionalEnum(
      body.attendanceStatus,
      "Status",
      ["present", "absent", "half_day", "leave", "week_off"],
      "present"
    ),
    checkInTime: optionalTime(body.checkInTime, "Check in"),
    checkOutTime: optionalTime(body.checkOutTime, "Check out"),
    checkIn: v.optionalString(body.checkIn, "Check in", 40),
    checkOut: v.optionalString(body.checkOut, "Check out", 40),
    leaveTypeId: v.optionalNumber(body.leaveTypeId, "Leave type", { min: 1 }),
    acceptOverAllowance: body.acceptOverAllowance === true,
    notes: v.optionalString(body.notes, "Notes", 200),
  };

  for (const [field, label] of [["checkIn", "Check in"], ["checkOut", "Check out"]]) {
    if (data[field] && Number.isNaN(Date.parse(data[field]))) {
      throw new AppError(400, `${label} is not a valid time`);
    }
  }

  const { rows, change } = await staffService.saveAttendance(req.user.restaurantId, data, req.user.id);

  // Rewriting someone's times rewrites their lateness and pay, so every
  // hand edit is written down with what it was before.
  logAction(req, change.before ? "update" : "create", "attendance", {
    id: data.employeeId,
    label: `${change.employee} · ${change.date}`,
    details: { before: change.before, after: change.after },
  });

  res.status(201).json({ success: true, message: "Attendance saved", data: rows });
};

const markRemaining = async (req, res) => {
  const date = readDate(req.body?.date, "Date", await todayFor(req));
  const result = await staffService.markRemaining(req.user.restaurantId, date, req.user.id);

  logAction(req, "mark_remaining", "attendance", {
    label: date,
    details: {
      present: result.present,
      weekOff: result.weekOff,
      leave: result.leave,
      skipped: result.skipped.length,
    },
  });

  const parts = [
    result.present && `${result.present} present`,
    result.weekOff && `${result.weekOff} on week off`,
    result.leave && `${result.leave} on leave`,
  ].filter(Boolean);

  res.json({
    success: true,
    message: parts.length ? `Marked ${parts.join(", ")}` : "Nobody could be marked automatically",
    data: result,
  });
};

// --- Payroll ---

const readRange = (query, today) => {
  const from = readDate(query.from, "From", today);
  const to = readDate(query.to, "To", from);

  if (to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  return { from, to };
};

const payroll = async (req, res) => {
  const { from, to } = readRange(req.query, await todayFor(req));

  res.json({
    success: true,
    data: { from, to, ...(await staffService.payrollSummary(req.user.restaurantId, from, to)) },
  });
};

const getPayrollSettings = async (req, res) => {
  res.json({ success: true, data: await staffService.getPayrollSettings(req.user.restaurantId) });
};

const savePayrollSettings = async (req, res) => {
  const body = req.body || {};
  const { before, after } = await staffService.savePayrollSettings(
    req.user.restaurantId,
    {
      weekOffsPaid: v.requiredBoolean(body.weekOffsPaid, "Week offs are paid", true),
      leavePaid: v.requiredBoolean(body.leavePaid, "Leave is paid", true),
    },
    req.user.id
  );

  logAction(req, "update", "payroll_settings", {
    label: "Pay policy",
    details: { changes: diff(before, after, ["weekOffsPaid", "leavePaid"]) },
  });

  res.json({ success: true, message: "Pay policy saved", data: after });
};

const listAdjustments = async (req, res) => {
  const { from, to } = readRange(req.query, await todayFor(req));
  const { adjustments } = await staffService.payrollSummary(req.user.restaurantId, from, to);

  res.json({ success: true, data: adjustments });
};

const ADJUSTMENT_LABELS = { advance: "Advance", deduction: "Deduction", bonus: "Bonus", arrears: "Pay owed" };

const addAdjustment = async (req, res) => {
  const body = req.body || {};

  const adjustment = await staffService.addAdjustment(
    req.user.restaurantId,
    {
      employeeId: v.requiredId(body.employeeId, "Employee"),
      adjustmentDate: readDate(body.date, "Date", await todayFor(req)),
      kind: v.requiredEnum(body.kind, "Type", ["advance", "deduction", "bonus"]),
      amount: v.requiredNumber(body.amount, "Amount", { min: 0.01, max: 9999999 }),
      note: v.requiredString(body.note, "Reason", 200),
    },
    req.user.id
  );

  logAction(req, "create", "payroll_adjustment", {
    id: adjustment.id,
    label: `${ADJUSTMENT_LABELS[adjustment.kind]} · ${adjustment.employeeName}`,
    details: { kind: adjustment.kind, amount: adjustment.amount, date: adjustment.date, note: adjustment.note },
  });

  res.status(201).json({ success: true, message: `${ADJUSTMENT_LABELS[adjustment.kind]} recorded`, data: adjustment });
};

const removeAdjustment = async (req, res) => {
  const id = v.requiredId(req.params.id, "Entry id");
  const removed = await staffService.removeAdjustment(req.user.restaurantId, id);

  logAction(req, "delete", "payroll_adjustment", {
    id,
    label: `${ADJUSTMENT_LABELS[removed.kind]} · ${removed.employeeName}`,
    details: { kind: removed.kind, amount: removed.amount, date: removed.date, note: removed.note },
  });

  res.json({ success: true, message: "Entry removed" });
};

const listPayments = async (req, res) => {
  const { from, to } = readRange(req.query, await todayFor(req));

  res.json({ success: true, data: await staffService.listPayments(req.user.restaurantId, from, to) });
};

// One activity-log line per payment (also one per person on "Mark all paid").
const logPayment = (req, payment, extra = {}) => {
  logAction(req, "pay", "payroll_payment", {
    id: payment.id,
    label: `${payment.employeeName} · ${payment.periodFrom} to ${payment.periodTo}`,
    details: {
      earned: payment.earned,
      bonus: payment.bonus,
      advances: payment.advances,
      deductions: payment.deductions,
      netPay: payment.netPay,
      amountPaid: payment.amountPaid,
      method: payment.paymentMethod,
      ...extra,
      // Balances moved into the next period (an advance bigger than the pay,
      // or pay held back), so the log shows nothing was lost.
      ...(payment.carried.length > 0
        ? {
            carriedForward: payment.carried.map((item) => ({ kind: item.kind, amount: item.amount, date: item.date })),
          }
        : {}),
    },
  });
};

const recordPayment = async (req, res) => {
  const body = req.body || {};
  const { from, to } = readRange({ from: body.from, to: body.to }, await todayFor(req));

  const { payment } = await staffService.recordPayment(
    req.user.restaurantId,
    {
      employeeId: v.requiredId(body.employeeId, "Employee"),
      from,
      to,
      amountPaid: v.optionalNumber(body.amountPaid, "Amount paid", { min: 0, max: 99999999 }),
      paymentMethod: v.optionalEnum(body.paymentMethod, "Paid by", ["cash", "bank", "upi", "cheque"], "cash"),
      paidOn: readDate(body.paidOn, "Paid on", await todayFor(req)),
      reference: v.optionalString(body.reference, "Reference", 60),
      note: v.optionalString(body.note, "Note", 200),
    },
    req.user.id
  );

  logPayment(req, payment);

  res.status(201).json({ success: true, message: `Marked paid for ${payment.employeeName}`, data: payment });
};

// "Mark all paid": everyone listed, for one period, their full net pay, in
// one transaction. Same permissions as one payment (the route), and each
// payment gets its own activity-log line, as if paid one by one.
const recordPaymentsBulk = async (req, res) => {
  const body = req.body || {};
  const { from, to } = readRange({ from: body.from, to: body.to }, await todayFor(req));

  if (!Array.isArray(body.employeeIds) || body.employeeIds.length === 0) {
    throw new AppError(400, "Choose the people to mark paid");
  }

  if (body.employeeIds.length > 500) {
    throw new AppError(400, "Mark at most 500 people paid at a time");
  }

  const { payments } = await staffService.recordPaymentsBulk(
    req.user.restaurantId,
    {
      employeeIds: body.employeeIds.map((id) => v.requiredId(id, "Employee")),
      from,
      to,
      paymentMethod: v.optionalEnum(body.paymentMethod, "Paid by", ["cash", "bank", "upi", "cheque"], "bank"),
      paidOn: readDate(body.paidOn, "Paid on", await todayFor(req)),
      reference: v.optionalString(body.reference, "Reference", 60),
      note: v.optionalString(body.note, "Note", 200),
      expectedTotal: v.optionalNumber(body.expectedTotal, "Total", { min: 0, max: 9999999999 }),
    },
    req.user.id
  );

  for (const payment of payments) {
    logPayment(req, payment, { markedWithOthers: payments.length });
  }

  const total = payments.reduce((sum, payment) => sum + Math.round(payment.amountPaid * 100), 0) / 100;

  res.status(201).json({
    success: true,
    message: `${payments.length} ${payments.length === 1 ? "person" : "people"} marked paid`,
    data: { payments, count: payments.length, total },
  });
};

const removePayment = async (req, res) => {
  const id = v.requiredId(req.params.id, "Payment id");
  const removed = await staffService.removePayment(req.user.restaurantId, id);

  logAction(req, "delete", "payroll_payment", {
    id,
    label: `${removed.employeeName} · ${removed.periodFrom} to ${removed.periodTo}`,
    details: {
      amountPaid: removed.amountPaid,
      method: removed.paymentMethod,
      paidOn: removed.paidOn,
      ...(removed.carried.length > 0 ? { carriedForwardRemoved: removed.carried.length } : {}),
    },
  });

  res.json({ success: true, message: "Payment undone" });
};

// --- Leave types and balances ---

const readLeaveType = (body = {}) => {
  const paid = v.requiredBoolean(body.paid, "Paid leave", true);

  return {
    name: v.requiredString(body.name, "Name", 40),
    paid,
    allowanceDays: paid
      ? v.requiredNumber(body.allowanceDays, "Allowance (days)", { min: 0, max: 366 })
      : null,
    allowancePeriod: v.optionalEnum(body.allowancePeriod, "Allowance per", ["month", "year"], "month"),
    carryForward: paid ? v.requiredBoolean(body.carryForward, "Carry forward", false) : false,
    countsFrom: readDate(body.countsFrom, "Counts from", null),
    isDefault: v.requiredBoolean(body.isDefault, "Default type", false),
    status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
    sortOrder: v.optionalNumber(body.sortOrder, "Order", { min: 0, max: 999 }) ?? 0,
  };
};

const listLeaveTypes = async (req, res) => {
  res.json({ success: true, data: await leaveService.listTypes(req.user.restaurantId) });
};

const LEAVE_FIELDS = ["name", "paid", "allowanceDays", "allowancePeriod", "carryForward", "countsFrom", "isDefault", "status"];

const saveLeaveType = async (req, res) => {
  const id = req.params.id ? v.requiredId(req.params.id, "Leave type id") : null;
  const data = readLeaveType(req.body);

  if (!data.countsFrom) {
    // Allowances build up from the start of this month (or this year).
    const today = await todayFor(req);
    data.countsFrom = data.allowancePeriod === "year" ? `${today.slice(0, 4)}-01-01` : `${today.slice(0, 7)}-01`;
  }

  const { before, after } = await leaveService.saveType(req.user.restaurantId, id, data, req.user.id);

  logAction(req, id ? "update" : "create", "leave_type", {
    id: after.id,
    label: after.name,
    details: id ? { changes: diff(before, after, LEAVE_FIELDS) } : { paid: after.paid, allowance: after.allowanceDays, per: after.allowancePeriod },
  });

  res.status(id ? 200 : 201).json({ success: true, message: id ? "Leave type saved" : "Leave type added", data: after });
};

const removeLeaveType = async (req, res) => {
  const id = v.requiredId(req.params.id, "Leave type id");
  const removed = await leaveService.removeType(req.user.restaurantId, id);

  logAction(req, "delete", "leave_type", { id, label: removed.name });

  res.json({ success: true, message: "Leave type deleted" });
};

// One person's leave left, on a date (the roster and the sheet show it).
const leaveBalances = async (req, res) => {
  const employeeId = v.requiredId(req.query.employeeId, "Employee");
  const date = readDate(req.query.date, "Date", await todayFor(req));

  res.json({ success: true, data: await leaveService.balances(req.user.restaurantId, employeeId, date) });
};

// Everyone's leave record: allowance, taken and left, per type.
const leaveRegister = async (req, res) => {
  const date = readDate(req.query.date, "Date", await todayFor(req));

  res.json({
    success: true,
    data: await leaveService.register(req.user.restaurantId, date, { includeInactive: req.query.includeInactive === "1" }),
  });
};

// --- PF, ESI and professional tax ---

const getStatutorySettings = async (req, res) => {
  res.json({ success: true, data: await staffService.getStatutorySettings(req.user.restaurantId) });
};

const readRate = (value, field, fallback) =>
  given(value) ? v.requiredNumber(value, field, { min: 0, max: 100 }) : fallback;

const readSlabs = (value) => {
  if (value === undefined || value === null) {
    return [];
  }

  const list = v.requiredArray(value, "Professional tax slabs");

  if (list.length > 20) {
    throw new AppError(400, "Give up to 20 professional tax slabs");
  }

  return list.map((slab, index) => {
    const row = slab || {};
    const label = `Slab ${index + 1}`;

    return {
      over: v.requiredNumber(row.over, `${label}: pay above`, { min: 0, max: 99999999 }),
      amount: v.requiredNumber(row.amount, `${label}: tax`, { min: 0, max: 2500 }),
      ...(given(row.februaryAmount)
        ? { februaryAmount: v.requiredNumber(row.februaryAmount, `${label}: February tax`, { min: 0, max: 2500 }) }
        : {}),
      // A slab for women only (Maharashtra taxes women from Rs 25,000);
      // otherwise it is for everyone.
      ...(given(row.for) && row.for !== "everyone" ? { for: v.requiredEnum(row.for, `${label}: for`, ["women"]) } : {}),
    };
  });
};

const STATUTORY_FIELDS = [
  "pfEnabled",
  "pfEmployeeRate",
  "pfEmployerRate",
  "pfWageCeiling",
  "esiEnabled",
  "esiEmployeeRate",
  "esiEmployerRate",
  "esiWageLimit",
  "ptEnabled",
  "ptState",
];

const saveStatutorySettings = async (req, res) => {
  const body = req.body || {};
  const { before, after } = await staffService.saveStatutorySettings(
    req.user.restaurantId,
    {
      pfEnabled: v.requiredBoolean(body.pfEnabled, "PF", false),
      pfEmployeeRate: readRate(body.pfEmployeeRate, "PF from the employee (%)", 12),
      pfEmployerRate: readRate(body.pfEmployerRate, "PF from the employer (%)", 12),
      pfWageCeiling: given(body.pfWageCeiling)
        ? v.requiredNumber(body.pfWageCeiling, "PF wage ceiling", { min: 1, max: 9999999 })
        : 15000,
      esiEnabled: v.requiredBoolean(body.esiEnabled, "ESI", false),
      esiEmployeeRate: readRate(body.esiEmployeeRate, "ESI from the employee (%)", 0.75),
      esiEmployerRate: readRate(body.esiEmployerRate, "ESI from the employer (%)", 3.25),
      esiWageLimit: given(body.esiWageLimit)
        ? v.requiredNumber(body.esiWageLimit, "ESI wage limit", { min: 1, max: 9999999 })
        : 21000,
      ptEnabled: v.requiredBoolean(body.ptEnabled, "Professional tax", false),
      ptState: v.optionalString(body.ptState, "State", 40),
      ptSlabs: readSlabs(body.ptSlabs),
    },
    req.user.id
  );

  logAction(req, "update", "statutory_settings", {
    label: "PF, ESI and professional tax",
    details: {
      changes: diff(before, after, STATUTORY_FIELDS),
      ...(JSON.stringify(before.ptSlabs) !== JSON.stringify(after.ptSlabs) ? { ptSlabs: [before.ptSlabs, after.ptSlabs] } : {}),
    },
  });

  res.json({ success: true, message: "Saved", data: after });
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const readMonth = async (req, value) => {
  if (!value) {
    return (await todayFor(req)).slice(0, 7);
  }

  if (typeof value !== "string" || !MONTH_PATTERN.test(value)) {
    throw new AppError(400, "Month must be like 2026-09");
  }

  return value;
};

// What a month's payroll owes for PF, ESI and professional tax.
const statutorySummary = async (req, res) => {
  const month = await readMonth(req, req.query.month);

  res.json({ success: true, data: await staffService.statutorySummary(req.user.restaurantId, month) });
};

// --- Monthly attendance register (muster roll) ---

const DEPARTMENTS = ["kitchen", "service", "management", "delivery", "housekeeping", "other"];

const musterRoll = async (req, res) => {
  const month = await readMonth(req, req.query.month);

  res.json({
    success: true,
    data: await staffService.musterRoll(req.user.restaurantId, month, {
      outletId: v.optionalNumber(req.query.outletId, "Outlet", { min: 1 }),
      department: req.query.department ? v.requiredEnum(req.query.department, "Department", DEPARTMENTS) : null,
    }),
  });
};

// --- Copy last week's roster ---

const SKIP_WORDS = {
  inactive: "inactive",
  left: "has left",
  shift_not_used: "shift no longer used",
  paid: "pay already marked paid",
  already_filled: "day already filled",
};

const copyWeek = async (req, res) => {
  const body = req.body || {};
  const weekStart = readDate(body.weekStart, "Week starting");

  if (!weekStart) {
    throw new AppError(400, "Say which week to fill: the date it starts");
  }

  const result = await staffService.copyWeek(
    req.user.restaurantId,
    { weekStart, replace: body.replace === true },
    req.user.id
  );

  const reasons = {};

  for (const item of result.skipped) {
    reasons[SKIP_WORDS[item.reason] || item.reason] = (reasons[SKIP_WORDS[item.reason] || item.reason] || 0) + 1;
  }

  logAction(req, "copy_week", "roster", {
    label: `${result.from} to ${result.to}`,
    details: {
      copiedFrom: `${result.sourceFrom} to ${result.sourceTo}`,
      copied: result.copied,
      replaced: result.replaced,
      skipped: result.skipped.length,
      ...(result.skipped.length ? { skippedBecause: reasons } : {}),
      replace: body.replace === true,
    },
  });

  res.json({
    success: true,
    message: `Copied ${result.copied} day${result.copied === 1 ? "" : "s"} from last week${
      result.skipped.length ? `; ${result.skipped.length} skipped` : ""
    }.`,
    data: result,
  });
};

module.exports = {
  listLeaveTypes,
  saveLeaveType,
  removeLeaveType,
  leaveBalances,
  leaveRegister,
  getStatutorySettings,
  saveStatutorySettings,
  statutorySummary,
  musterRoll,
  copyWeek,
  salaryHistory,
  listEmployees,
  createEmployee,
  updateEmployee,
  removeEmployee,
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
  payroll,
  getPayrollSettings,
  savePayrollSettings,
  listAdjustments,
  addAdjustment,
  removeAdjustment,
  listPayments,
  recordPayment,
  recordPaymentsBulk,
  removePayment,
};
