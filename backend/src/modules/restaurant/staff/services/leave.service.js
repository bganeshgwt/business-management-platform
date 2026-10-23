const leaveRepository = require("../repositories/leave.repository");
const queryAll = require("../../../../utils/queryAll");
const staffRepository = require("../repositories/staff.repository");
const AppError = require("../../../../utils/AppError");

// Leave allowances: Casual 1 day a month, Sick 6 days a year, Unpaid.
//
// A leave day is paid while the person still has a whole day left in that
// type's allowance; days over it, and any Unpaid leave, are loss of pay.
// Days are taken in date order: the earliest leave of a month is the one the
// allowance pays.
//
//   per month / per year   a new allowance each month (or calendar year)
//   carry forward          what is left over moves into the next month (or
//                          year); without it, it lapses
//   the first year         a yearly allowance starting part-way through a
//                          year (someone who joined in July) is the share of
//                          the year left, rounded down to half a day
//
// A leave day marked without a type counts against the restaurant's default
// type. With no leave types at all, the older all-or-nothing "leave is paid"
// setting still decides, so nothing changes until the owner sets them up.

const DUPLICATE = "23505";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toType = (row) => ({
  id: row.id,
  name: row.name,
  paid: Boolean(row.paid),
  allowanceDays: row.allowance_days === null ? null : Number(row.allowance_days),
  allowancePeriod: row.allowance_period,
  carryForward: Boolean(row.carry_forward),
  countsFrom: row.counts_from,
  isDefault: Boolean(row.is_default),
  status: row.status,
  sortOrder: row.sort_order,
  usedDays: Number(row.used_days || 0),
});

// --- Periods ("buckets") ------------------------------------------------------------

const bucketOf = (date, period) => (period === "month" ? date.slice(0, 7) : date.slice(0, 4));

const nextBucket = (bucket, period) => {
  if (period === "year") {
    return String(Number(bucket) + 1);
  }

  const [year, month] = bucket.split("-").map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
};

const bucketLabel = (bucket, period) =>
  period === "year" ? bucket : `${MONTHS[Number(bucket.slice(5, 7)) - 1]} ${bucket.slice(0, 4)}`;

// The last day of the month (or year) a date falls in.
const bucketEnd = (date, period) => {
  if (period === "year") {
    return `${date.slice(0, 4)}-12-31`;
  }

  const [year, month] = date.slice(0, 7).split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(last).padStart(2, "0")}`;
};

const floorHalf = (value) => Math.floor(value * 2) / 2;

// This period's allowance. A yearly one starting part-way through its first
// year is the share of the year left (July: half).
const allowanceFor = (type, bucket, startDate) => {
  const allowance = Number(type.allowanceDays || 0);

  if (type.allowancePeriod === "year" && bucket === startDate.slice(0, 4)) {
    const monthsLeft = 12 - (Number(startDate.slice(5, 7)) - 1);
    return floorHalf((allowance * monthsLeft) / 12);
  }

  return allowance;
};

// Walks a paid type's periods from the start, paying each leave day while a
// whole day is left. Returns each day's verdict and each period's figures.
const simulate = (type, dates, startDate, untilBucket) => {
  const period = type.allowancePeriod;
  const byBucket = new Map();

  for (const date of dates) {
    const key = bucketOf(date, period);
    byBucket.set(key, [...(byBucket.get(key) || []), date]);
  }

  const startBucket = bucketOf(startDate, period);
  let first = startBucket;
  let last = untilBucket;

  for (const key of byBucket.keys()) {
    first = key < first ? key : first;
    last = key > last ? key : last;
  }

  const verdict = new Map();
  const buckets = new Map();
  let carried = 0;

  for (let key = first, guard = 0; key <= last && guard < 2000; key = nextBucket(key, period), guard += 1) {
    const allowance = allowanceFor(type, key, startDate);
    const available = carried + allowance;
    let balance = available;
    let paid = 0;
    let unpaid = 0;

    for (const date of (byBucket.get(key) || []).sort()) {
      if (balance >= 1) {
        verdict.set(date, true);
        balance -= 1;
        paid += 1;
      } else {
        verdict.set(date, false);
        unpaid += 1;
      }
    }

    buckets.set(key, { allowance, carriedIn: carried, available, taken: paid + unpaid, paid, unpaid, left: balance });
    carried = type.carryForward ? balance : 0;
  }

  return { verdict, buckets };
};

// --- Types ----------------------------------------------------------------------------

// db: the pool, or the client of a transaction already open (payroll's
// "Mark paid" reads leave inside its own transaction).
const listTypes = async (restaurantId, db = leaveRepository.pool) => {
  requireRestaurantId(restaurantId);
  return (await leaveRepository.findTypes(db, restaurantId)).map(toType);
};

const saveType = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = id ? await leaveRepository.findTypeById(restaurantId, id) : null;

  if (id && !before) {
    throw new AppError(404, "Leave type not found");
  }

  if (data.paid && (data.allowanceDays === null || data.allowanceDays === undefined)) {
    throw new AppError(400, "Give the allowance: how many paid days per month or per year");
  }

  // The first type a restaurant sets up is its default, so leave marked
  // without a type is never left uncounted.
  const existing = await listTypes(restaurantId);
  const isDefault = data.isDefault || (!id && existing.filter((type) => type.status === "active").length === 0);

  try {
    const savedId = await leaveRepository.saveType(restaurantId, id, { ...data, isDefault }, userId);

    if (!savedId) {
      throw new AppError(404, "Leave type not found");
    }

    return {
      before: before ? toType(before) : null,
      after: toType(await leaveRepository.findTypeById(restaurantId, savedId)),
    };
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A leave type named "${data.name}" already exists`);
    }

    throw error;
  }
};

// A type already used on a sheet or roster stays, switched off, so old leave
// keeps its name and its pay.
const removeType = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const row = await leaveRepository.findTypeById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Leave type not found");
  }

  if (Number(row.used_days) > 0) {
    throw new AppError(
      409,
      `${row.name} is on ${row.used_days} leave day(s) already. Set it to inactive instead, so those days keep it.`
    );
  }

  await leaveRepository.removeType(restaurantId, id);
  return toType(row);
};

// --- Working out paid and unpaid leave ------------------------------------------------------

// Everything needed to judge leave days for some people.
const context = async (restaurantId, employeeIds, through, db = leaveRepository.pool) => {
  const [types, days, starts] = await queryAll(db, [
    () => listTypes(restaurantId, db),
    () => leaveRepository.findLeaveDays(restaurantId, employeeIds, through, db),
    () => leaveRepository.findStarts(restaurantId, employeeIds, db),
  ]);

  return { types, days, starts };
};

// Each person's leave days judged paid or unpaid, by type.
//   legacyPaid  the "leave is paid" setting, used when there are no types
const judge = (ctx, legacyPaid) => {
  const typeById = new Map(ctx.types.map((type) => [Number(type.id), type]));
  const defaultType = ctx.types.find((type) => type.isDefault && type.status === "active") || null;
  const startOf = new Map(ctx.starts.map((row) => [Number(row.id), row.started]));
  const people = new Map();

  for (const row of ctx.days) {
    const employeeId = Number(row.employee_id);
    const type = (row.leave_type_id && typeById.get(Number(row.leave_type_id))) || defaultType;
    const person = people.get(employeeId) || { days: [], byType: new Map() };

    person.days.push({ date: row.day, typeId: type ? Number(type.id) : null, marked: row.leave_type_id ? Number(row.leave_type_id) : null });

    if (type && type.paid) {
      person.byType.set(type.id, [...(person.byType.get(type.id) || []), row.day]);
    }

    people.set(employeeId, person);
  }

  const verdicts = new Map();

  for (const [employeeId, person] of people) {
    const start = startOf.get(employeeId) || person.days[0].date;
    const paidByType = new Map();

    for (const [typeId, dates] of person.byType) {
      const type = typeById.get(Number(typeId));
      const lastDate = dates[dates.length - 1];
      paidByType.set(Number(typeId), simulate(type, dates, start > type.countsFrom ? start : type.countsFrom, bucketOf(lastDate, type.allowancePeriod)).verdict);
    }

    verdicts.set(
      employeeId,
      person.days.map((day) => {
        const type = day.typeId ? typeById.get(day.typeId) : null;
        // No type to judge by (no types set up, or no default for leave
        // marked without one): the older "leave is paid" setting decides.
        const paid = type ? type.paid && paidByType.get(day.typeId).get(day.date) === true : Boolean(legacyPaid);

        return { date: day.date, typeId: day.typeId, typeName: type ? type.name : null, paid };
      })
    );
  }

  return verdicts;
};

// Paid and unpaid leave days per person inside [from, to], for payroll.
// Returns Map(employeeId -> { paidDates: Set, unpaidDates: Set }).
const forPayroll = async (restaurantId, employeeIds, from, to, legacyPaid, db = leaveRepository.pool) => {
  const ctx = await context(restaurantId, employeeIds, to, db);
  const verdicts = judge(ctx, legacyPaid);
  const result = new Map();

  for (const [employeeId, days] of verdicts) {
    const inside = days.filter((day) => day.date >= from && day.date <= to);
    result.set(employeeId, {
      paidDates: new Set(inside.filter((day) => day.paid).map((day) => day.date)),
      unpaidDates: new Set(inside.filter((day) => !day.paid).map((day) => day.date)),
      days: inside,
    });
  }

  return { result, hasTypes: ctx.types.length > 0 };
};

// Each active type's figures for the month (or year) holding `date`: the
// allowance, what was carried in, taken (leave already on the sheet or the
// roster for that month or year, including days later in it) and left.
const balancesFrom = (ctx, employeeId, date) => {
  const start = (ctx.starts.find((row) => Number(row.id) === Number(employeeId)) || {}).started || date;
  const defaultType = ctx.types.find((type) => type.isDefault && type.status === "active") || null;
  const mine = ctx.days.filter((row) => Number(row.employee_id) === Number(employeeId));

  return ctx.types
    .filter((type) => type.status === "active")
    .map((type) => {
      const bucket = bucketOf(date, type.allowancePeriod);
      const dates = mine
        .filter((row) => {
          const id = row.leave_type_id ? Number(row.leave_type_id) : defaultType ? Number(defaultType.id) : null;
          return id === Number(type.id);
        })
        .map((row) => row.day);

      if (!type.paid) {
        const taken = dates.filter((day) => bucketOf(day, type.allowancePeriod) === bucket).length;

        return {
          typeId: type.id,
          name: type.name,
          paid: false,
          period: type.allowancePeriod,
          periodLabel: bucketLabel(bucket, type.allowancePeriod),
          allowance: null,
          carriedIn: 0,
          available: null,
          taken,
          left: null,
          unpaid: taken,
        };
      }

      const typeStart = start > type.countsFrom ? start : type.countsFrom;
      const { buckets } = simulate(type, dates, typeStart, bucket);
      const figures = buckets.get(bucket) || {
        allowance: allowanceFor(type, bucket, typeStart),
        carriedIn: 0,
        available: allowanceFor(type, bucket, typeStart),
        taken: 0,
        paid: 0,
        unpaid: 0,
        left: allowanceFor(type, bucket, typeStart),
      };

      return {
        typeId: type.id,
        name: type.name,
        paid: true,
        isDefault: type.isDefault,
        period: type.allowancePeriod,
        periodLabel: bucketLabel(bucket, type.allowancePeriod),
        carryForward: type.carryForward,
        allowance: figures.allowance,
        carriedIn: figures.carriedIn,
        available: figures.available,
        taken: figures.taken,
        left: figures.left,
        unpaid: figures.unpaid,
      };
    });
};

// One person's balances on a date (the roster and sheet show them beside
// the leave type).
const balances = async (restaurantId, employeeId, date) => {
  requireRestaurantId(restaurantId);

  const employee = await staffRepository.findEmployeeById(restaurantId, employeeId);

  if (!employee) {
    throw new AppError(404, "Employee not found");
  }

  const through = `${date.slice(0, 4)}-12-31`;
  const ctx = await context(restaurantId, [employeeId], through);

  return { employeeId: employee.id, name: employee.name, date, types: balancesFrom(ctx, employeeId, date) };
};

// Everyone's leave record on a date: Employees -> Leave, printable.
const register = async (restaurantId, date, { includeInactive = false } = {}) => {
  requireRestaurantId(restaurantId);

  const through = `${date.slice(0, 4)}-12-31`;
  const ctx = await context(restaurantId, null, through);

  const people = ctx.starts
    .filter((row) => includeInactive || row.status === "active")
    .map((row) => ({
      employeeId: row.id,
      name: row.name,
      employeeCode: row.employee_code,
      designation: row.designation,
      department: row.department,
      outletId: row.outlet_id,
      types: balancesFrom(ctx, row.id, date),
    }));

  return { date, types: ctx.types.filter((type) => type.status === "active"), people };
};

// Would this leave day go over the allowance? Checked before saving a leave
// day on the roster or the sheet, so the manager is warned first.
const checkDay = async (restaurantId, employeeId, date, typeId) => {
  const ctx = await context(restaurantId, [employeeId], bucketEnd(date, "year"));

  if (ctx.types.length === 0) {
    return { overAllowance: false };
  }

  const defaultType = ctx.types.find((type) => type.isDefault && type.status === "active") || null;
  const type = typeId ? ctx.types.find((row) => Number(row.id) === Number(typeId)) : defaultType;

  if (!type) {
    return { overAllowance: false };
  }

  if (!type.paid) {
    return { overAllowance: false, unpaidType: true, type: type.name };
  }

  // Judged with this day counted once (it may already be on the roster).
  const withDay = {
    ...ctx,
    days: [
      ...ctx.days.filter((row) => !(row.day === date && Number(row.employee_id) === Number(employeeId))),
      { employee_id: employeeId, day: date, leave_type_id: type.id },
    ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
  };

  const balance = balancesFrom(withDay, employeeId, date).find((row) => Number(row.typeId) === Number(type.id));

  return {
    overAllowance: Boolean(balance && balance.unpaid > 0),
    type: type.name,
    balance,
  };
};

module.exports = {
  listTypes,
  saveType,
  removeType,
  forPayroll,
  balances,
  register,
  checkDay,
};
