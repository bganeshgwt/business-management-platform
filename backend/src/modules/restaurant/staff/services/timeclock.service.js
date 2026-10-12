const bcrypt = require("bcrypt");
const timeclockRepository = require("../repositories/timeclock.repository");
const staffRepository = require("../repositories/staff.repository");
const AppError = require("../../../../utils/AppError");

const { pool } = timeclockRepository;

// --- Rules of the clock ----------------------------------------------------

// Five wrong PINs inside fifteen minutes locks that person's PIN for fifteen
// minutes. Enough for honest fat fingers, far too few to guess 10,000 PINs.
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MINUTES = 15;
const PIN_LOCK_MINUTES = 15;
const PIN_ROUNDS = 10;

// A session older than this is not "still on duty": the person forgot to
// clock out. The longest honest day in a restaurant (a double shift with
// overtime) is about 14 hours, so 16 leaves room without keeping a forgotten
// clock-in "on duty" into the next day.
const STALE_HOURS = 16;

// The clock opens an hour before someone's rostered start. Earlier than that
// is paid time nobody agreed to; a manager can still add the punch when they
// did ask someone to come in early.
const EARLY_CLOCK_IN_MINUTES = 60;

// Five minutes wiping down the station after the shift is not overtime. Staying
// a quarter of an hour or more past the end is, and then all of it counts.
const OVERTIME_THRESHOLD_MINUTES = 15;

// Days that are looked back over for forgotten clock-outs.
const OPEN_DAY_LOOKBACK = 7;

const ACTIONS = ["clock_in", "break_start", "break_end", "clock_out"];

// Which state each action may be taken from, and where it leaves you.
const FLOW = {
  clock_in: { from: ["out"], to: "in" },
  break_start: { from: ["in"], to: "break" },
  break_end: { from: ["break"], to: "in" },
  // Clocking out while on a break is allowed: it ends the break too. Refusing
  // would leave someone who is already on their way home stuck at the tablet.
  clock_out: { from: ["in", "break"], to: "out" },
};

const ACTION_LABELS = {
  clock_in: "clock-in",
  break_start: "break start",
  break_end: "break end",
  clock_out: "clock-out",
};

const STATE_LABELS = { in: "on duty", break: "on a break", out: "clocked out" };

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// --- Clock and calendar, on the restaurant's own clock ---------------------
//
// Shifts are wall-clock times in the restaurant's timezone ("Evening 17:00"),
// so every "when does this shift start" is worked out there — never from the
// server's clock, which may sit in UTC while the kitchen is in Kolkata.

const safeZone = (timezone) => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return timezone;
  } catch {
    return "Asia/Kolkata";
  }
};

const partsIn = (instant, timezone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const get = (type) => Number(parts.find((part) => part.type === type).value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
};

const localDate = (instant, timezone) => {
  const p = partsIn(instant, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

const localHour = (instant, timezone) => partsIn(instant, timezone).hour;

// How far the zone is ahead of UTC at that instant, in minutes.
const offsetMinutes = (instant, timezone) => {
  const p = partsIn(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
};

// "2026-09-24" + "17:00" in Asia/Kolkata -> the instant 11:30 UTC. Checked
// twice so a date that crosses a daylight-saving change still lands right.
const zonedInstant = (date, time, timezone) => {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = String(time).split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMinutes(new Date(guess), timezone) * 60000;
  return new Date(guess - offsetMinutes(new Date(first), timezone) * 60000);
};

const addDays = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const minutesBetween = (from, to) => Math.round((new Date(to) - new Date(from)) / 60000);

// "5:58 pm", as the tablet and the rest of the staff screens write a time.
const timeLabel = (instant, timezone) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(instant))
    .replace(/\s?([ap])\.?m\.?$/i, (_, half) => ` ${half.toLowerCase()}m`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dateLabel = (isoDate) => {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

const duration = (minutes) => {
  const value = Math.max(0, Math.round(minutes));

  if (value < 60) {
    return `${value} min`;
  }

  const rest = value % 60;
  return rest ? `${Math.floor(value / 60)}h ${String(rest).padStart(2, "0")}m` : `${value / 60}h`;
};

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";

const initials = (name) =>
  String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

// --- Shifts and the maths of a day ----------------------------------------

// The rostered shift for one date as real instants. null when the person is
// not scheduled to work (week off, leave, or no roster entry at all).
// A shift whose end is not after its start runs past midnight.
const shiftWindow = (workDate, roster, timezone) => {
  if (!roster || roster.assignment_status !== "scheduled" || !roster.start_time) {
    return null;
  }

  const start = String(roster.start_time).slice(0, 5);
  const end = String(roster.end_time).slice(0, 5);
  const overnight = end <= start;
  const startsAt = zonedInstant(workDate, start, timezone);
  const endsAt = zonedInstant(overnight ? addDays(workDate, 1) : workDate, end, timezone);
  const breakMinutes = Number(roster.break_minutes || 0);

  return {
    workDate,
    shiftId: roster.shift_id,
    shiftName: roster.shift_name,
    startTime: start,
    endTime: end,
    startsAt,
    endsAt,
    overnight,
    graceMinutes: Number(roster.grace_minutes || 0),
    breakMinutes,
    scheduledMinutes: Math.max(0, minutesBetween(startsAt, endsAt) - breakMinutes),
  };
};

// Walks one person's punches for one work date, in order, and works out the
// day: when they came and went, time on and off the clock, lateness and
// overtime. It is the single source of those numbers — the kiosk, the board,
// the attendance row and the seed all go through here.
//
//   worked   = (check-out - check-in) - breaks
//   breaks   = every stretch off the clock between the first clock-in and the
//              last clock-out: breaks taken, and the gap between two stints
//              on a split shift (lunch, afternoon off, dinner)
//   late     = minutes after the rostered start, less the shift's grace —
//              the same rule the attendance sheet uses, so the two agree
//   overtime = time past the shift's end that is also genuinely extra hours:
//              staying 40 minutes after arriving an hour late is not overtime,
//              and nothing under 15 minutes past the end counts at all
//
// Punches out of order (a break with no clock-in) come back as `invalid`
// rather than being guessed at.
const summarise = (punches, window, now = new Date()) => {
  const sorted = [...punches].sort(
    (a, b) => new Date(a.punched_at) - new Date(b.punched_at) || Number(a.id || 0) - Number(b.id || 0)
  );

  let state = "out";
  let firstIn = null;
  let lastOut = null;
  let mark = null;
  let sessionStart = null;
  let breakStartedAt = null;
  let workedMs = 0;
  let offMs = 0;
  const segments = [];

  for (const punch of sorted) {
    const at = new Date(punch.punched_at).getTime();
    const rule = FLOW[punch.punch_type];

    if (!rule || !rule.from.includes(state)) {
      return { invalid: { punch, state } };
    }

    if (punch.punch_type === "clock_in") {
      if (firstIn === null) {
        firstIn = at;
      } else {
        offMs += at - lastOut;
        segments.push({ kind: "gap", from: lastOut, to: at });
      }

      sessionStart = at;
    } else if (punch.punch_type === "break_start") {
      workedMs += at - mark;
      segments.push({ kind: "work", from: mark, to: at });
      breakStartedAt = at;
    } else if (punch.punch_type === "break_end") {
      offMs += at - mark;
      segments.push({ kind: "break", from: mark, to: at });
      breakStartedAt = null;
    } else {
      if (state === "in") {
        workedMs += at - mark;
        segments.push({ kind: "work", from: mark, to: at });
      } else {
        offMs += at - mark;
        segments.push({ kind: "break", from: mark, to: at });
      }

      lastOut = at;
      breakStartedAt = null;
    }

    mark = at;
    state = rule.to;
  }

  const nowMs = new Date(now).getTime();

  // The stretch still running, for the live board. Never stored.
  if (state === "in") {
    segments.push({ kind: "work", from: mark, to: Math.max(mark, nowMs), open: true });
  } else if (state === "break") {
    segments.push({ kind: "break", from: mark, to: Math.max(mark, nowMs), open: true });
  }

  const checkIn = firstIn === null ? null : new Date(firstIn);
  const checkOut = state === "out" && firstIn !== null ? new Date(lastOut) : null;
  const breakMinutes = Math.round(offMs / 60000);
  const liveBreakMinutes =
    state === "break" ? Math.round((offMs + Math.max(0, nowMs - mark)) / 60000) : breakMinutes;

  let workedMinutes = 0;

  if (checkOut) {
    workedMinutes = Math.max(0, minutesBetween(checkIn, checkOut) - breakMinutes);
  }

  const liveWorkedMinutes = checkOut
    ? workedMinutes
    : Math.round((workedMs + (state === "in" ? Math.max(0, nowMs - mark) : 0)) / 60000);

  let lateMinutes = 0;
  let minutesAfterStart = 0;
  let overtimeMinutes = 0;

  if (window && checkIn) {
    minutesAfterStart = checkIn > window.startsAt ? minutesBetween(window.startsAt, checkIn) : 0;
    lateMinutes = Math.max(0, minutesAfterStart - window.graceMinutes);

    const pastEnd = checkOut ? minutesBetween(window.endsAt, checkOut) : 0;

    if (pastEnd >= OVERTIME_THRESHOLD_MINUTES) {
      overtimeMinutes = Math.max(0, Math.min(pastEnd, workedMinutes - window.scheduledMinutes));
    }
  }

  return {
    state,
    checkIn,
    checkOut,
    sessionStart: sessionStart === null ? null : new Date(sessionStart),
    breakStartedAt: breakStartedAt === null ? null : new Date(breakStartedAt),
    workedMinutes,
    breakMinutes,
    liveWorkedMinutes,
    liveBreakMinutes,
    lateMinutes,
    minutesAfterStart,
    overtimeMinutes,
    segments: segments.map((segment) => ({
      kind: segment.kind,
      from: new Date(segment.from).toISOString(),
      to: new Date(segment.to).toISOString(),
      open: Boolean(segment.open),
    })),
  };
};

// "1234", "0000" and "2580" (straight down the keypad) are the first PINs
// anyone tries.
const isWeakPin = (pin) =>
  /^(\d)\1+$/.test(pin) ||
  "01234567890".includes(pin) ||
  "09876543210".includes(pin) ||
  ["2580", "0852", "1212", "1122", "6969", "1004", "2000", "4321"].includes(pin);

// --- Loading the pieces ------------------------------------------------------

const getTimezone = async (restaurantId) =>
  safeZone(await timeclockRepository.findTimezone(restaurantId));

const byEmployeeAndDate = (rows) => {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.employee_id}|${row.work_date}`;

    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key).push(row);
  }

  return map;
};

const publicEmployee = (row) => ({
  id: row.id,
  name: row.name,
  firstName: firstName(row.name),
  initials: initials(row.name),
  employeeCode: row.employee_code,
  designation: row.designation,
  department: row.department,
});

// Where one person is right now: the state their latest work date's punches
// leave them in. Read from the latest DAY, not the latest single punch — a
// manager adding yesterday's forgotten clock-out this morning must not make
// someone who clocked in today look clocked out. `db` is the pool or a
// transaction's client.
const currentState = async (db, restaurantId, employeeId, now) => {
  const out = { state: "out", workDate: null, summary: null, stale: null };
  const workDate = await timeclockRepository.findLatestWorkDate(db, restaurantId, employeeId);

  if (!workDate) {
    return out;
  }

  const punches = await timeclockRepository.findDayPunches(db, restaurantId, employeeId, workDate);
  const summary = summarise(punches, null, now);

  if (summary.invalid || summary.state === "out") {
    return out;
  }

  if (now - summary.sessionStart > STALE_HOURS * 3600000) {
    return { ...out, stale: { workDate, since: summary.sessionStart } };
  }

  return { state: summary.state, workDate, summary, stale: null };
};

// A forgotten clock-in on the very day a new clock-in would be booked to
// cannot be stepped over: the day would read "in, in". The person is told to
// get the clock-out added first. (A forgotten clock-in on an earlier day is
// no obstacle — today starts clean and the old day waits for a manager.)
const staleBlock = (current, clockInDate, timezone) => {
  if (current.state !== "out" || !current.stale || current.stale.workDate !== clockInDate) {
    return null;
  }

  return `Your clock-in at ${timeLabel(current.stale.since, timezone)} on ${dateLabel(
    current.stale.workDate
  )} has no clock-out, so the clock cannot start you again that day. Ask a manager to add the clock-out on the Day timeline, then clock in.`;
};

// --- No hour on two days ------------------------------------------------------
//
// Each work date covers a stretch of time on the clock: from its first
// clock-in to its last clock-out. Two days of the same person must not
// overlap, and a later work date must start after the one before it ends —
// otherwise the same hours are paid twice.
//
// A day still open is live (covering up to now) only while it is the
// person's latest day and under 16 hours old. An open day with a later day
// after it was plainly left without a clock-out, so it covers only up to its
// last punch — which lets a manager fill in yesterday's forgotten shift one
// punch at a time while the person is on today's.

const daySpan = (date, punches, now, latest) => {
  const summary = summarise(punches, null, now);

  if (summary.invalid || !summary.checkIn) {
    return null;
  }

  const lastAt = new Date(Math.max(...punches.map((row) => new Date(row.punched_at).getTime())));

  if (summary.state === "out") {
    return { date, start: summary.checkIn, end: summary.checkOut, open: false };
  }

  const live = latest && now - summary.sessionStart <= STALE_HOURS * 3600000;
  return { date, start: summary.checkIn, end: live ? new Date(Math.max(now, lastAt)) : lastAt, open: live };
};

const assertNoOverlap = async (client, restaurantId, employee, workDate, now, timezone) => {
  const rows = await timeclockRepository.findPunchesBetween(
    client,
    restaurantId,
    employee.id,
    addDays(workDate, -1),
    addDays(workDate, 1)
  );
  const byDate = new Map();

  for (const row of rows) {
    if (!byDate.has(row.work_date)) {
      byDate.set(row.work_date, []);
    }

    byDate.get(row.work_date).push(row);
  }

  const dates = [...byDate.keys()].sort();
  const spans = dates
    .map((date) => daySpan(date, byDate.get(date), now, date === dates[dates.length - 1]))
    .filter(Boolean);
  const at = spans.findIndex((span) => span.date === workDate);

  if (at === -1) {
    return;
  }

  const clash = [spans[at - 1], spans[at + 1]].find(
    (other) => other && (other.date < workDate ? other.end > spans[at].start : spans[at].end > other.start)
  );

  if (clash) {
    throw new AppError(
      409,
      `That would overlap ${firstName(employee.name)}'s ${dateLabel(clash.date)} shift (${timeLabel(
        clash.start,
        timezone
      )} – ${clash.open ? "still on the clock" : timeLabel(clash.end, timezone)}). The same hours cannot count on two days — check the date and the time.`,
      { reason: "overlap", workDate: clash.date }
    );
  }
};

// A manager's correction changes hours; once those hours have been paid, it
// would change what someone earned after the money was handed over. The same
// rule the attendance sheet and the roster follow.
const assertNotPaid = async (restaurantId, employee, workDate) => {
  const paid = await staffRepository.findPaidPeriod(restaurantId, employee.id, workDate);

  if (paid) {
    throw new AppError(
      409,
      `${employee.name}'s pay for ${dateLabel(paid.period_from)} – ${dateLabel(
        paid.period_to
      )} is already marked paid, so ${dateLabel(workDate)} cannot be changed. Undo that payment on Payroll first, or record the difference as a bonus or deduction in the next pay period.`,
      { reason: "paid_period" }
    );
  }
};

// The rostered shift a clock-in right now would be for:
//   1. yesterday's overnight shift, while it is still running — a bar shift
//      that began yesterday evening and runs past midnight is still
//      yesterday's, so someone clocking in at 00:20 to cover it is working
//      yesterday's day;
//   2. today's shift, unless it is already over and tomorrow's is close;
//   3. tomorrow's shift, when it starts within NEXT_SHIFT_HOURS — a night
//      shift that begins at midnight belongs to the day it starts, so the
//      baker who arrives at 11:30 pm for it is early for tomorrow, not
//      "not on today's roster";
// or none, and the clock-in is simply booked to today.
const NEXT_SHIFT_HOURS = 4;

const shiftForClockIn = async (db, restaurantId, employeeId, now, timezone) => {
  const today = localDate(now, timezone);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const rows = await timeclockRepository.findRosterFor(db, restaurantId, employeeId, [yesterday, today, tomorrow]);
  const windowOn = (date) => shiftWindow(date, rows.find((row) => row.work_date === date), timezone);

  const lateNight = windowOn(yesterday);

  if (lateNight && lateNight.overnight && now < lateNight.endsAt) {
    return lateNight;
  }

  const todays = windowOn(today);
  const next = windowOn(tomorrow);
  const nextSoon = next && next.startsAt - now <= NEXT_SHIFT_HOURS * 3600000;

  if (todays && (now < todays.endsAt || !nextSoon)) {
    return todays;
  }

  return nextSoon ? next : null;
};

const workDateForClockIn = async (db, restaurantId, employeeId, now, timezone) => {
  const window = await shiftForClockIn(db, restaurantId, employeeId, now, timezone);
  return window ? window.workDate : localDate(now, timezone);
};

// Rebuilds the attendance row for one person's work date from its punches.
const rebuildAttendance = async (client, restaurantId, employee, workDate, userId, now, timezone) => {
  const [punches, roster] = await Promise.all([
    timeclockRepository.findDayPunches(client, restaurantId, employee.id, workDate),
    timeclockRepository.findRosterFor(client, restaurantId, employee.id, [workDate]),
  ]);
  const window = shiftWindow(workDate, roster[0], timezone);
  const summary = summarise(punches, window, now);

  if (summary.invalid) {
    const { punch, state } = summary.invalid;

    throw new AppError(
      409,
      `That would put ${firstName(employee.name)}'s day out of order: the ${
        ACTION_LABELS[punch.punch_type]
      } at ${timeLabel(punch.punched_at, timezone)} would come while they were ${STATE_LABELS[state]}.`
    );
  }

  const row = await timeclockRepository.upsertAttendance(
    client,
    restaurantId,
    {
      employeeId: employee.id,
      shiftId: window ? window.shiftId : null,
      workDate,
      checkIn: summary.checkIn,
      checkOut: summary.checkOut,
      workedMinutes: summary.workedMinutes,
      breakMinutes: summary.breakMinutes,
      lateMinutes: summary.lateMinutes,
      overtimeMinutes: summary.overtimeMinutes,
    },
    userId
  );

  return { row, summary, window };
};

const actionsFor = (state) => ({ out: ["clock_in"], in: ["break_start", "clock_out"], break: ["break_end", "clock_out"] })[state];

const withTransaction = async (work) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- The PIN check -------------------------------------------------------------

// Throws a message the person at the tablet can act on, or returns nothing.
//
// The attempt is counted BEFORE the PIN is compared (reservePinAttempt), in
// its own statement outside any punch transaction. So a wrong PIN is always
// on record even though the request fails, and a burst of guesses sent in
// parallel gets exactly five of them checked: the fifth locks the PIN as it
// is counted, and every guess behind it is refused unread. The right PIN
// clears the count, as it always has.
const checkPin = async (restaurantId, employee, pin, now, timezone) => {
  const name = firstName(employee.name);
  const noPin = () =>
    new AppError(409, `${name} has no PIN yet. A manager can set one under Manage PINs.`, { reason: "no_pin" });
  const locked = (until) =>
    new AppError(
      423,
      `Too many wrong PINs. ${name} can try again at ${timeLabel(until, timezone)}, or a manager can unlock it now.`,
      { reason: "locked", lockedUntil: new Date(until).toISOString() }
    );

  if (!employee.pin_hash) {
    throw noPin();
  }

  const rules = {
    windowMinutes: PIN_WINDOW_MINUTES,
    maxAttempts: PIN_MAX_ATTEMPTS,
    lockMinutes: PIN_LOCK_MINUTES,
  };
  let attempt = await timeclockRepository.reservePinAttempt(restaurantId, employee.id, rules);

  if (!attempt) {
    const state = await timeclockRepository.findPinState(restaurantId, employee.id);

    if (!state || !state.has_pin) {
      throw noPin();
    }

    if (state.pin_locked_until) {
      throw locked(state.pin_locked_until);
    }

    // The lock ran out (or a manager lifted it) between the two reads.
    attempt = await timeclockRepository.reservePinAttempt(restaurantId, employee.id, rules);

    if (!attempt) {
      throw locked(new Date(now.getTime() + PIN_LOCK_MINUTES * 60000));
    }
  }

  if (await bcrypt.compare(pin, attempt.pin_hash)) {
    await timeclockRepository.clearPinFailures(restaurantId, employee.id);
    return;
  }

  if (attempt.attempts >= PIN_MAX_ATTEMPTS) {
    throw new AppError(
      423,
      `That was ${PIN_MAX_ATTEMPTS} wrong PINs in ${PIN_WINDOW_MINUTES} minutes, so ${name}'s PIN is locked until ${timeLabel(
        attempt.pin_locked_until,
        timezone
      )}. A manager can unlock it under Manage PINs.`,
      {
        reason: "locked",
        justLocked: true,
        employeeId: employee.id,
        employeeName: employee.name,
        lockedUntil: new Date(attempt.pin_locked_until).toISOString(),
      }
    );
  }

  const left = PIN_MAX_ATTEMPTS - attempt.attempts;

  throw new AppError(
    400,
    `That PIN is not right. ${left} ${left === 1 ? "try" : "tries"} left before ${name}'s PIN locks for ${PIN_LOCK_MINUTES} minutes.`,
    { reason: "wrong_pin", attemptsLeft: left }
  );
};

const findForKiosk = async (restaurantId, { employeeId, employeeCode }) => {
  const employee = employeeId
    ? await timeclockRepository.findEmployeeForPin(restaurantId, employeeId)
    : await timeclockRepository.findEmployeeByCode(restaurantId, employeeCode);

  if (!employee) {
    throw new AppError(
      404,
      employeeId
        ? "Employee not found"
        : `No one on the staff list has the code ${employeeCode}. Check the code, or tap your name instead.`
    );
  }

  if (employee.status !== "active") {
    throw new AppError(
      409,
      `${employee.name} is marked inactive, so cannot clock in. A manager can reactivate them under Employees.`
    );
  }

  return employee;
};

// What the kiosk shows between the PIN and the buttons: who you are, where
// you stand, and what you can do next.
const describeState = (current, window, timezone, { opensAt = null, blocked = null, lateNow = null } = {}) => {
  const summary = current.summary;

  return {
    state: current.state,
    // Nothing to press while a forgotten clock-in on the same day is in the
    // way — the message says who can clear it.
    actions: blocked ? [] : actionsFor(current.state),
    blocked,
    // Set when it is too early to clock in for the rostered shift.
    clockInOpensAt: opensAt ? opensAt.toISOString() : null,
    // Set when clocking in now will be recorded as late, so the person hears
    // it before they tap rather than after: minutes after the grace, as the
    // attendance sheet will count them.
    lateNow,
    workDate: current.workDate,
    since: summary ? summary.sessionStart.toISOString() : null,
    checkIn: summary && summary.checkIn ? summary.checkIn.toISOString() : null,
    breakStartedAt: summary && summary.breakStartedAt ? summary.breakStartedAt.toISOString() : null,
    workedMinutes: summary ? summary.liveWorkedMinutes : 0,
    breakMinutes: summary ? summary.liveBreakMinutes : 0,
    shift: window
      ? {
          name: window.shiftName,
          workDate: window.workDate,
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          label: `${window.shiftName} ${timeLabel(window.startsAt, timezone)} – ${timeLabel(window.endsAt, timezone)}`,
          breakMinutes: window.breakMinutes,
          graceMinutes: window.graceMinutes,
        }
      : null,
    // A clock-in more than 16 hours old with no clock-out: they are treated as
    // out (so they can start today), and the old day waits for a manager.
    // (When that forgotten clock-in is what blocks today, `blocked` already
    // says so.)
    missedClockOut: current.stale && !blocked
      ? {
          workDate: current.stale.workDate,
          since: current.stale.since.toISOString(),
          message: `Your clock-out on ${dateLabel(current.stale.workDate)} is missing — a manager will add it.`,
        }
      : null,
  };
};

// The rostered shift that matters for someone at this moment: the one they
// are clocked in to, else the one a clock-in now would be for.
const shiftForNow = async (db, restaurantId, employeeId, current, now, timezone) => {
  if (current.workDate) {
    const rows = await timeclockRepository.findRosterFor(db, restaurantId, employeeId, [current.workDate]);
    return shiftWindow(current.workDate, rows[0], timezone);
  }

  return shiftForClockIn(db, restaurantId, employeeId, now, timezone);
};

// When it is too early to clock in for this shift, the time the clock opens;
// otherwise null. A second stint on a day already started is never early.
const clockInOpensAt = async (db, restaurantId, employeeId, window, now) => {
  if (!window) {
    return null;
  }

  const opensAt = new Date(window.startsAt.getTime() - EARLY_CLOCK_IN_MINUTES * 60000);

  if (now >= opensAt) {
    return null;
  }

  const already = await timeclockRepository.findDayPunches(db, restaurantId, employeeId, window.workDate);
  return already.length > 0 ? null : opensAt;
};

// --- Kiosk ------------------------------------------------------------------

// "Is this the right PIN?" A wrong one is an everyday answer at a tablet, not
// a failure of the request, so it comes back as { valid: false } with what
// to tell the person (tries left, or until when they are locked). Punching
// itself still refuses a wrong PIN outright.
const PIN_ANSWERS = ["wrong_pin", "locked", "no_pin"];

const verify = async (restaurantId, data, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const timezone = await getTimezone(restaurantId);
  const employee = await findForKiosk(restaurantId, data);

  try {
    await checkPin(restaurantId, employee, data.pin, now, timezone);
  } catch (error) {
    if (error instanceof AppError && error.details && PIN_ANSWERS.includes(error.details.reason)) {
      return {
        valid: false,
        reason: error.details.reason,
        message: error.message,
        attemptsLeft: error.details.attemptsLeft ?? null,
        lockedUntil: error.details.lockedUntil ?? null,
        justLocked: Boolean(error.details.justLocked),
        employee: publicEmployee(employee),
      };
    }

    throw error;
  }

  const current = await currentState(pool, restaurantId, employee.id, now);
  const window = await shiftForNow(pool, restaurantId, employee.id, current, now, timezone);
  const opensAt = current.state === "out" ? await clockInOpensAt(pool, restaurantId, employee.id, window, now) : null;
  const blocked =
    current.state === "out" && current.stale
      ? staleBlock(current, await workDateForClockIn(pool, restaurantId, employee.id, now, timezone), timezone)
      : null;

  // Their own punches for the day in hand, so they can see what the clock has
  // on record for them before they add to it.
  const dayDate = current.workDate || (blocked && current.stale.workDate) || (window && window.workDate) || localDate(now, timezone);
  const dayPunches = await timeclockRepository.findDayPunches(pool, restaurantId, employee.id, dayDate);

  // Late only for the first clock-in of the shift: coming back for a second
  // stint is not arriving late.
  let lateNow = null;

  if (current.state === "out" && !blocked && window && dayPunches.length === 0 && now < window.endsAt) {
    const sinceStart = minutesBetween(window.startsAt, now);

    if (sinceStart > window.graceMinutes) {
      lateNow = {
        minutes: sinceStart - window.graceMinutes,
        sinceStart,
        graceMinutes: window.graceMinutes,
        message: `Your ${window.shiftName} shift started at ${timeLabel(window.startsAt, timezone)}. Clocking in now counts as ${duration(
          sinceStart - window.graceMinutes
        )} late${window.graceMinutes ? ` (after the ${window.graceMinutes} min grace)` : ""}.`,
      };
    }
  }

  return {
    valid: true,
    employee: publicEmployee(employee),
    ...describeState(current, window, timezone, { opensAt, blocked, lateNow }),
    punches: dayPunches.map((row) => ({
      action: row.punch_type,
      at: new Date(row.punched_at).toISOString(),
      source: row.source,
    })),
  };
};

const greeting = (instant, timezone) => {
  const hour = localHour(instant, timezone);

  if (hour >= 4 && hour < 12) {
    return "Good morning";
  }

  if (hour >= 12 && hour < 17) {
    return "Good afternoon";
  }

  return "Good evening";
};

// The confirmation card: one line a person reads in two seconds on their way
// past the tablet ("Good evening, Ravi — clocked in 5:58 pm · on time"), and
// the chips behind it.
const confirmation = (action, employee, punchedAt, result, timezone) => {
  const name = firstName(employee.name);
  const at = timeLabel(punchedAt, timezone);
  const { summary, window } = result;
  const chips = [];
  let headline;
  let detail;
  let tone = "success";

  if (action === "clock_in") {
    headline = `${greeting(punchedAt, timezone)}, ${name}`;
    const isSecondStint = summary.checkIn && summary.checkIn.getTime() !== new Date(punchedAt).getTime();

    if (isSecondStint) {
      detail = "welcome back";
    } else if (!window) {
      detail = "not on today's roster";
      tone = "info";
    } else if (summary.lateMinutes > 0) {
      detail = `${duration(summary.lateMinutes)} late`;
      tone = "warning";
    } else {
      detail = "on time";
    }

    if (window) {
      chips.push(`${window.shiftName} ${timeLabel(window.startsAt, timezone)} – ${timeLabel(window.endsAt, timezone)}`);

      if (summary.lateMinutes > 0 && !isSecondStint) {
        chips.push(`${window.graceMinutes} min grace`);
      } else if (new Date(punchedAt) < window.startsAt) {
        chips.push(`shift starts in ${duration(minutesBetween(punchedAt, window.startsAt))}`);
      }
    }

    return { tone, headline, message: `${headline} — clocked in ${at} · ${detail}`, line: `Clocked in ${at}`, detail, chips };
  }

  if (action === "break_start") {
    headline = `Enjoy your break, ${name}`;
    detail = window && window.breakMinutes ? `${window.breakMinutes} min break on your shift` : "break started";
    chips.push(`${duration(summary.liveWorkedMinutes)} worked so far`);

    return { tone: "info", headline, message: `${headline} — break started ${at}`, line: `Break started ${at}`, detail, chips };
  }

  if (action === "break_end") {
    const segments = summary.segments.filter((segment) => segment.kind === "break" && !segment.open);
    const last = segments[segments.length - 1];
    const length = last ? minutesBetween(last.from, last.to) : 0;

    headline = `Welcome back, ${name}`;
    detail = `${duration(length)} break`;

    if (window && window.breakMinutes && length > window.breakMinutes) {
      tone = "warning";
      chips.push(`${duration(length - window.breakMinutes)} over the ${window.breakMinutes} min break`);
    }

    return { tone, headline, message: `${headline} — back at ${at} · ${detail}`, line: `Back from break ${at}`, detail, chips };
  }

  headline = `Thanks, ${name} — see you next shift`;
  detail = `${duration(summary.workedMinutes)} worked`;
  chips.push(`${timeLabel(summary.checkIn, timezone)} – ${at}`);

  if (summary.breakMinutes > 0) {
    chips.push(`${duration(summary.breakMinutes)} off the clock`);
  }

  if (summary.overtimeMinutes > 0) {
    chips.push(`${duration(summary.overtimeMinutes)} overtime`);
  }

  return {
    tone: "success",
    headline,
    message: `Thanks, ${name} — clocked out ${at} · ${detail}`,
    line: `Clocked out ${at}`,
    detail,
    chips,
  };
};

const refusal = (action, current, timezone) => {
  const since = current.summary ? timeLabel(current.summary.sessionStart, timezone) : null;

  if (action === "clock_in") {
    return current.state === "break"
      ? `You are clocked in and on a break (since ${timeLabel(current.summary.breakStartedAt, timezone)}). End the break instead.`
      : `You are already clocked in (since ${since}). Clock out first, or start a break.`;
  }

  if (current.state === "out" && current.stale) {
    // Their clock-in is too old to still be running: clocking out of it now
    // would pay the whole night at home.
    return `Your clock-in at ${timeLabel(current.stale.since, timezone)} on ${dateLabel(
      current.stale.workDate
    )} has no clock-out and is over ${STALE_HOURS} hours old, so it can no longer be closed here. Ask a manager to add the clock-out on the Day timeline.`;
  }

  if (current.state === "out") {
    if (action === "clock_out") {
      return "You are not clocked in, so there is nothing to clock out of. Clock in first.";
    }

    return action === "break_end"
      ? "You are not clocked in, so there is no break to end. Clock in first."
      : "You are not clocked in, so you cannot take a break. Clock in first.";
  }

  if (action === "break_start") {
    return `You are already on a break (since ${timeLabel(current.summary.breakStartedAt, timezone)}).`;
  }

  return "You are not on a break. Start a break first, or clock out.";
};

const punch = async (restaurantId, data, userId, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const timezone = await getTimezone(restaurantId);
  const found = await findForKiosk(restaurantId, data);
  const settings = await timeclockRepository.findSettings(restaurantId);

  await checkPin(restaurantId, found, data.pin, now, timezone);

  // Old photos go on every punch, with photos on or off: switching the
  // setting off must not keep earlier photos past their keeping time.
  purgeOldPhotos(restaurantId, settings).catch(() => undefined);

  return withTransaction(async (client) => {
    // Locked first: two taps at once queue here, and the second sees the
    // first one's punch instead of clocking the same person in twice.
    const employee = await timeclockRepository.lockEmployee(client, restaurantId, found.id);
    const current = await currentState(client, restaurantId, employee.id, now);

    if (!FLOW[data.action].from.includes(current.state)) {
      throw new AppError(409, refusal(data.action, current, timezone), { state: current.state });
    }

    const workDate =
      data.action === "clock_in"
        ? await workDateForClockIn(client, restaurantId, employee.id, now, timezone)
        : current.workDate;

    if (data.action === "clock_in") {
      const blocked = staleBlock(current, workDate, timezone);

      if (blocked) {
        throw new AppError(409, blocked, { reason: "missed_clock_out", workDate });
      }

      const roster = await timeclockRepository.findRosterFor(client, restaurantId, employee.id, [workDate]);
      const window = shiftWindow(workDate, roster[0], timezone);
      const opensAt = await clockInOpensAt(client, restaurantId, employee.id, window, now);

      if (opensAt) {
        throw new AppError(
          409,
          `Your ${window.shiftName} shift starts at ${timeLabel(window.startsAt, timezone)}, so the clock opens for you at ${timeLabel(
            opensAt,
            timezone
          )}. Starting early because a manager asked? They can add your clock-in.`,
          { reason: "too_early", opensAt: opensAt.toISOString() }
        );
      }
    }

    // With punch photos on, the tablet's picture is kept with the punch; a
    // tablet whose camera could not take one still punches, marked "no photo".
    const photoStatus = settings.punch_photos ? (data.photo ? "taken" : "missing") : null;
    const saved = await timeclockRepository.insertPunch(
      client,
      restaurantId,
      { employeeId: employee.id, workDate, punchType: data.action, punchedAt: now, source: "kiosk", photoStatus },
      userId
    );

    if (photoStatus === "taken") {
      await timeclockRepository.savePhoto(client, restaurantId, {
        punchId: saved.id,
        employeeId: employee.id,
        mimeType: data.photo.mimeType,
        image: data.photo.image,
      });
    }

    const result = await rebuildAttendance(client, restaurantId, employee, workDate, userId, now, timezone);
    await assertNoOverlap(client, restaurantId, employee, workDate, now, timezone);
    const after = FLOW[data.action].to;

    return {
      punch: {
        id: saved.id,
        action: saved.punch_type,
        punchedAt: new Date(saved.punched_at).toISOString(),
        workDate,
        photoStatus: saved.photo_status || null,
      },
      employee: publicEmployee(employee),
      state: after,
      attendance: {
        workDate,
        checkIn: result.summary.checkIn ? result.summary.checkIn.toISOString() : null,
        checkOut: result.summary.checkOut ? result.summary.checkOut.toISOString() : null,
        workedMinutes: result.summary.checkOut ? result.summary.workedMinutes : result.summary.liveWorkedMinutes,
        breakMinutes: result.summary.breakMinutes,
        lateMinutes: result.summary.lateMinutes,
        overtimeMinutes: result.summary.overtimeMinutes,
      },
      confirmation: confirmation(data.action, employee, now, result, timezone),
    };
  });
};

// --- The on-duty board -------------------------------------------------------

const STATUS_ORDER = [
  "late",
  "missed_out",
  "on_break",
  "on_duty",
  "expected",
  "absent",
  "left",
  "week_off",
  "leave",
  "unscheduled",
];

const board = async (restaurantId, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const timezone = await getTimezone(restaurantId);
  const today = localDate(now, timezone);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const staleBefore = new Date(now.getTime() - STALE_HOURS * 3600000);
  const dates = [yesterday, today, tomorrow];

  const [employees, roster, punches, openDays, settings] = await Promise.all([
    timeclockRepository.findActiveEmployees(restaurantId),
    timeclockRepository.findRosterForDates(restaurantId, dates),
    timeclockRepository.findPunchesForDates(restaurantId, dates),
    timeclockRepository.findOpenDays(restaurantId, staleBefore, addDays(today, -OPEN_DAY_LOOKBACK)),
    timeclockRepository.findSettings(restaurantId),
  ]);

  const rosterBy = new Map(roster.map((row) => [`${row.employee_id}|${row.work_date}`, row]));
  const punchesBy = byEmployeeAndDate(punches);
  const names = new Map(employees.map((row) => [row.id, row.name]));

  const staff = employees.map((employee) => {
    // Each of the three days this person might be on right now, with its
    // rostered shift and what their punches make of it.
    const days = Object.fromEntries(
      dates.map((date) => {
        const rosterRow = rosterBy.get(`${employee.id}|${date}`);
        const window = shiftWindow(date, rosterRow, timezone);
        const day = summarise(punchesBy.get(`${employee.id}|${date}`) || [], window, now);
        return [date, { date, roster: rosterRow, window, day }];
      })
    );
    const isOpen = ({ day }) => !day.invalid && day.state !== "out";
    const live = (entry) => isOpen(entry) && now - entry.day.sessionStart <= STALE_HOURS * 3600000;
    const lateNight =
      days[yesterday].window && days[yesterday].window.overnight && now < days[yesterday].window.endsAt;
    const todayOver = !days[today].window || now >= days[today].window.endsAt;
    const nextSoon =
      days[tomorrow].window && days[tomorrow].window.startsAt - now <= NEXT_SHIFT_HOURS * 3600000;

    // Which day is "now" for this person, the same way the kiosk books a
    // clock-in: already clocked in early for tomorrow's night shift; else on
    // today's; else still on yesterday's overnight shift; else due soon for
    // tomorrow's (today's shift is over or there is none); else today.
    let focus = days[today];

    if (days[tomorrow].day.checkIn && !days[tomorrow].day.invalid) {
      focus = days[tomorrow];
    } else if (isOpen(days[today])) {
      focus = days[today];
    } else if (live(days[yesterday]) || (lateNight && !days[today].day.checkIn)) {
      focus = days[yesterday];
    } else if (!days[today].day.checkIn && todayOver && nextSoon) {
      focus = days[tomorrow];
    }

    const { window, day } = focus;
    const valid = !day.invalid;
    let status;
    let lateByMinutes = null;
    let startsInMinutes = null;

    if (isOpen(focus) && !live(focus)) {
      // Clocked in over 16 hours ago and never out: the kiosk already treats
      // them as out, so the board must not show them as on duty.
      status = "missed_out";
    } else if (valid && day.state === "break") {
      status = "on_break";
    } else if (valid && day.state === "in") {
      status = "on_duty";
    } else if (valid && day.checkIn) {
      status = "left";
    } else if (focus.roster && focus.roster.assignment_status === "week_off") {
      status = "week_off";
    } else if (focus.roster && focus.roster.assignment_status === "leave") {
      status = "leave";
    } else if (window) {
      if (now < new Date(window.startsAt.getTime() + window.graceMinutes * 60000)) {
        status = "expected";
        startsInMinutes = Math.max(0, minutesBetween(now, window.startsAt));
      } else if (now < window.endsAt) {
        status = "late";
        lateByMinutes = minutesBetween(window.startsAt, now);
      } else {
        status = "absent";
      }
    } else {
      status = "unscheduled";
    }

    // Still on the clock a quarter of an hour or more after the shift ended:
    // either staying on (overtime someone should know about) or gone home
    // without clocking out. Either way the manager needs to look now, not at
    // the 12-hour alert.
    let pastEndMinutes = null;

    if ((status === "on_duty" || status === "on_break") && window && now > window.endsAt) {
      const over = minutesBetween(window.endsAt, now);
      pastEndMinutes = over >= OVERTIME_THRESHOLD_MINUTES ? over : null;
    }

    const lastDayPunches = punchesBy.get(`${employee.id}|${focus.date}`) || [];
    const lastPunch = lastDayPunches[lastDayPunches.length - 1];
    const lockedUntil =
      employee.pin_locked_until && new Date(employee.pin_locked_until) > now
        ? new Date(employee.pin_locked_until).toISOString()
        : null;

    return {
      ...publicEmployee(employee),
      hasPin: employee.has_pin,
      pinLockedUntil: lockedUntil,
      status,
      workDate: focus.date,
      rosterStatus: focus.roster ? focus.roster.assignment_status : null,
      shift: window
        ? {
            name: window.shiftName,
            startsAt: window.startsAt.toISOString(),
            endsAt: window.endsAt.toISOString(),
            graceMinutes: window.graceMinutes,
            breakMinutes: window.breakMinutes,
            overnight: window.overnight,
          }
        : null,
      lateByMinutes,
      startsInMinutes,
      pastEndMinutes,
      session:
        valid && day.checkIn
          ? {
              checkIn: day.checkIn.toISOString(),
              checkOut: day.checkOut ? day.checkOut.toISOString() : null,
              since: day.sessionStart.toISOString(),
              breakStartedAt: day.breakStartedAt ? day.breakStartedAt.toISOString() : null,
              workedMinutes: day.liveWorkedMinutes,
              breakMinutes: day.liveBreakMinutes,
              lateMinutes: day.lateMinutes,
              overtimeMinutes: day.overtimeMinutes,
            }
          : null,
      lastPunch: lastPunch
        ? { action: lastPunch.punch_type, at: new Date(lastPunch.punched_at).toISOString() }
        : null,
    };
  });

  // Within "late", the person furthest past their start comes first: that is
  // the call to make before any other.
  staff.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      (b.lateByMinutes || 0) - (a.lateByMinutes || 0) ||
      a.name.localeCompare(b.name)
  );

  const countOf = (status) => staff.filter((row) => row.status === status).length;
  const expected = staff.filter((row) => row.status === "expected");
  const nextStart = expected
    .map((row) => row.shift.startsAt)
    .sort()
    .find(Boolean);

  const recent = punches
    .slice(-12)
    .reverse()
    .map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      employeeName: names.get(row.employee_id) || "Former employee",
      action: row.punch_type,
      at: new Date(row.punched_at).toISOString(),
      source: row.source,
    }));

  return {
    now: now.toISOString(),
    timezone,
    date: today,
    // The tablet takes a photo at each punch when this is on.
    punchPhotos: Boolean(settings.punch_photos),
    counts: {
      onDuty: countOf("on_duty") + countOf("on_break"),
      onBreak: countOf("on_break"),
      late: countOf("late"),
      expected: expected.length,
      left: countOf("left"),
      absent: countOf("absent"),
      off: countOf("week_off") + countOf("leave"),
      rostered: staff.filter((row) => row.shift).length,
      pastEnd: staff.filter((row) => row.pastEndMinutes).length,
      missedOut: countOf("missed_out"),
      noPin: staff.filter((row) => !row.hasPin).length,
      nextStart: nextStart || null,
    },
    staff,
    recent,
    missedClockOuts: openDays.map((row) => ({
      attendanceId: row.id,
      employeeId: row.employee_id,
      employeeName: row.name,
      workDate: row.attendance_date,
      checkIn: new Date(row.check_in).toISOString(),
      // The stint left open (the latest clock-in that day), which is what
      // the missing clock-out belongs to.
      since: new Date(row.session_start).toISOString(),
      hoursOpen: Math.floor((now - new Date(row.session_start)) / 3600000),
    })),
  };
};

// --- The day timeline --------------------------------------------------------

const day = async (restaurantId, requestedDate, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const timezone = await getTimezone(restaurantId);
  const today = localDate(now, timezone);
  const date = requestedDate || today;

  // The day's timeline says which punches have a photo: clear the expired
  // ones first so it never offers a photo that has gone.
  await sweepOldPhotos(restaurantId);

  const [employees, roster, attendance, punches] = await Promise.all([
    timeclockRepository.findEmployeesForDay(restaurantId, date),
    timeclockRepository.findRosterForDates(restaurantId, [date]),
    timeclockRepository.findAttendanceForDate(restaurantId, date),
    timeclockRepository.findPunchesForDates(restaurantId, [date]),
  ]);

  const rosterBy = new Map(roster.map((row) => [row.employee_id, row]));
  const attendanceBy = new Map(attendance.map((row) => [row.employee_id, row]));
  const punchesBy = new Map();

  for (const row of punches) {
    if (!punchesBy.has(row.employee_id)) {
      punchesBy.set(row.employee_id, []);
    }

    punchesBy.get(row.employee_id).push(row);
  }

  const rows = [];

  for (const employee of employees) {
    const rosterRow = rosterBy.get(employee.id);
    const record = attendanceBy.get(employee.id);
    const own = punchesBy.get(employee.id) || [];

    if (!rosterRow && !record && own.length === 0) {
      continue;
    }

    const window = shiftWindow(date, rosterRow, timezone);
    const summary = summarise(own, window, now);
    const valid = !summary.invalid;

    // What the day comes to, in words a manager uses.
    let status;

    if (own.length > 0 && valid && summary.state === "break") {
      status = "on_break";
    } else if (own.length > 0 && valid && summary.state === "in") {
      status = summary.sessionStart && now - summary.sessionStart > STALE_HOURS * 3600000 ? "no_clock_out" : "on_duty";
    } else if (own.length > 0) {
      status = "present";
    } else if (record) {
      status = record.attendance_status;
    } else if (rosterRow && rosterRow.assignment_status !== "scheduled") {
      status = rosterRow.assignment_status;
    } else if (window && (date < today || now > window.endsAt)) {
      status = "absent";
    } else if (window && now > new Date(window.startsAt.getTime() + window.graceMinutes * 60000)) {
      status = "late";
    } else {
      status = "expected";
    }

    rows.push({
      ...publicEmployee(employee),
      status,
      shift: window
        ? {
            name: window.shiftName,
            startsAt: window.startsAt.toISOString(),
            endsAt: window.endsAt.toISOString(),
            graceMinutes: window.graceMinutes,
            breakMinutes: window.breakMinutes,
          }
        : null,
      rosterStatus: rosterRow ? rosterRow.assignment_status : null,
      attendance: record
        ? {
            id: record.id,
            status: record.attendance_status,
            checkIn: record.check_in ? new Date(record.check_in).toISOString() : null,
            checkOut: record.check_out ? new Date(record.check_out).toISOString() : null,
            workedMinutes: record.worked_minutes,
            breakMinutes: record.break_minutes,
            lateMinutes: record.late_minutes,
            overtimeMinutes: record.overtime_minutes,
            notes: record.notes,
          }
        : null,
      live: valid
        ? {
            state: summary.state,
            workedMinutes: summary.liveWorkedMinutes,
            breakMinutes: summary.liveBreakMinutes,
          }
        : null,
      segments: valid ? summary.segments : [],
      outOfOrder: !valid,
      punches: own.map((row) => ({
        id: row.id,
        action: row.punch_type,
        at: new Date(row.punched_at).toISOString(),
        source: row.source,
        note: row.note,
        recordedBy: row.recorded_by,
        // 'taken' (hasPhoto false once the photo has aged out), 'missing',
        // or null when photos were off.
        photoStatus: row.photo_status || null,
        hasPhoto: Boolean(row.has_photo),
      })),
    });
  }

  const sum = (pick) => rows.reduce((total, row) => total + (row.attendance ? Number(pick(row.attendance)) || 0 : 0), 0);
  // A day left open over 16 hours is not counted until its clock-out is
  // added — the same as the attendance sheet, which has no hours for it yet.
  const worked = rows.reduce(
    (total, row) =>
      total +
      (row.attendance && row.attendance.checkOut
        ? row.attendance.workedMinutes
        : row.live && row.status !== "no_clock_out"
          ? row.live.workedMinutes
          : 0),
    0
  );

  return {
    date,
    today,
    timezone,
    now: now.toISOString(),
    rows,
    totals: {
      rostered: rows.filter((row) => row.shift).length,
      present: rows.filter((row) => ["present", "on_duty", "on_break", "no_clock_out", "half_day"].includes(row.status)).length,
      late: rows.filter((row) => row.attendance && row.attendance.lateMinutes > 0).length,
      lateMinutes: sum((a) => a.lateMinutes),
      absent: rows.filter((row) => row.status === "absent").length,
      off: rows.filter((row) => ["week_off", "leave"].includes(row.status)).length,
      workedMinutes: worked,
      breakMinutes: sum((a) => a.breakMinutes),
      overtimeMinutes: sum((a) => a.overtimeMinutes),
      missingClockOut: rows.filter((row) => row.status === "no_clock_out").length,
    },
  };
};

const listPunches = async (restaurantId, requested, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const today = localDate(now, await getTimezone(restaurantId));
  const from = requested.from || today;
  const filters = { ...requested, from, to: requested.to || from };

  if (filters.to < filters.from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  const rows = await timeclockRepository.listPunches(restaurantId, filters);

  return {
    items: rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      employeeCode: row.employee_code,
      workDate: row.work_date,
      action: row.punch_type,
      at: new Date(row.punched_at).toISOString(),
      source: row.source,
      note: row.note,
      recordedBy: row.recorded_by,
    })),
    total: rows.length ? Number(rows[0].total_count) : 0,
    limit: filters.limit,
  };
};

// A punch a manager adds after the fact: the clock-out someone forgot, or a
// clock-in when the tablet was down. It is written as its own punch, marked
// 'manager' with the reason, and the day is rebuilt — or refused whole if it
// would leave the day out of order.
const addPunch = async (restaurantId, data, userId, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const timezone = await getTimezone(restaurantId);
  const at = new Date(data.at);
  const dayStarts = zonedInstant(data.workDate, "00:00", timezone);
  // A shift that began on this date cannot still be running past noon the
  // next day.
  const dayEnds = zonedInstant(addDays(data.workDate, 1), "12:00", timezone);

  if (at > new Date(now.getTime() + 60000)) {
    throw new AppError(400, "A punch cannot be in the future. Enter the time it actually happened.");
  }

  if (at < dayStarts || at > dayEnds) {
    throw new AppError(
      400,
      `The time must fall on ${dateLabel(data.workDate)} (or before noon the next day for a shift that ran past midnight).`
    );
  }

  return withTransaction(async (client) => {
    const employee = await timeclockRepository.lockEmployee(client, restaurantId, data.employeeId);

    if (!employee) {
      throw new AppError(404, "Employee not found");
    }

    await assertNotPaid(restaurantId, employee, data.workDate);

    const saved = await timeclockRepository.insertPunch(
      client,
      restaurantId,
      {
        employeeId: employee.id,
        workDate: data.workDate,
        punchType: data.action,
        punchedAt: at,
        source: "manager",
        note: data.note,
      },
      userId
    );

    const result = await rebuildAttendance(client, restaurantId, employee, data.workDate, userId, now, timezone);
    await assertNoOverlap(client, restaurantId, employee, data.workDate, now, timezone);

    return {
      punch: {
        id: saved.id,
        action: saved.punch_type,
        at: new Date(saved.punched_at).toISOString(),
        workDate: data.workDate,
        source: saved.source,
        note: saved.note,
      },
      employee: publicEmployee(employee),
      attendance: attendanceView(result.row),
    };
  });
};

const attendanceView = (row) =>
  row
    ? {
        checkIn: row.check_in ? new Date(row.check_in).toISOString() : null,
        checkOut: row.check_out ? new Date(row.check_out).toISOString() : null,
        workedMinutes: row.worked_minutes,
        breakMinutes: row.break_minutes,
        lateMinutes: row.late_minutes,
        overtimeMinutes: row.overtime_minutes,
      }
    : null;

// Takes back a punch a manager added by mistake (the wrong time, the wrong
// person, the wrong day). Only a manager's own punches can go: what the
// tablet recorded is the record, and is corrected by adding to it. The
// removal, with the punch it removed and why, goes in the activity log, and
// the day is worked out again — or refused whole if what is left would be out
// of order or overlap another day.
const removePunch = async (restaurantId, punchId, userId, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const timezone = await getTimezone(restaurantId);

  return withTransaction(async (client) => {
    const found = await timeclockRepository.findPunchById(client, restaurantId, punchId);

    if (!found) {
      throw new AppError(404, "Punch not found");
    }

    const employee = await timeclockRepository.lockEmployee(client, restaurantId, found.employee_id);
    // Read again under the lock: another manager may have just removed it.
    const target = await timeclockRepository.findPunchById(client, restaurantId, punchId);

    if (!employee || !target) {
      throw new AppError(404, "Punch not found");
    }

    if (target.source !== "manager") {
      throw new AppError(
        409,
        "This punch was made at the tablet, so it stays on the record. To correct the day, add a punch with the reason instead.",
        { reason: "kiosk_punch" }
      );
    }

    await assertNotPaid(restaurantId, employee, target.work_date);
    await timeclockRepository.deletePunch(client, restaurantId, punchId);

    const remaining = await timeclockRepository.findDayPunches(client, restaurantId, employee.id, target.work_date);
    let attendance = null;

    if (remaining.length === 0) {
      await timeclockRepository.deleteAttendance(client, restaurantId, employee.id, target.work_date);
    } else {
      const result = await rebuildAttendance(client, restaurantId, employee, target.work_date, userId, now, timezone);
      await assertNoOverlap(client, restaurantId, employee, target.work_date, now, timezone);
      attendance = attendanceView(result.row);
    }

    return {
      punch: {
        id: target.id,
        action: target.punch_type,
        at: new Date(target.punched_at).toISOString(),
        workDate: target.work_date,
        note: target.note,
      },
      employee: publicEmployee(employee),
      attendance,
      dayCleared: remaining.length === 0,
      label: `${ACTION_LABELS[target.punch_type]} at ${timeLabel(target.punched_at, timezone)} on ${dateLabel(target.work_date)}`,
    };
  });
};

// --- PINs ----------------------------------------------------------------------

// With the restaurant's timezone, so "locked until 6:14 pm" reads on its clock.
const listPins = async (restaurantId, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const [timezone, rows] = await Promise.all([
    getTimezone(restaurantId),
    timeclockRepository.listPins(restaurantId),
  ]);

  const items = rows.map((row) => {
    const locked = row.pin_locked_until && new Date(row.pin_locked_until) > now;
    const windowOpen =
      row.pin_first_failed_at && now - new Date(row.pin_first_failed_at) < PIN_WINDOW_MINUTES * 60000;

    return {
      ...publicEmployee(row),
      hasPin: row.has_pin,
      pinSetAt: row.pin_set_at ? new Date(row.pin_set_at).toISOString() : null,
      lockedUntil: locked ? new Date(row.pin_locked_until).toISOString() : null,
      recentFailures: windowOpen ? row.pin_failed_attempts : 0,
    };
  });

  return { timezone, items };
};

const setPin = async (restaurantId, employeeId, pin, userId) => {
  requireRestaurantId(restaurantId);

  const employee = await timeclockRepository.findEmployeeForPin(restaurantId, employeeId);

  if (!employee) {
    throw new AppError(404, "Employee not found");
  }

  if (employee.status !== "active") {
    throw new AppError(409, `${employee.name} is inactive. Reactivate them under Employees before setting a PIN.`);
  }

  if (isWeakPin(pin)) {
    throw new AppError(
      400,
      "That PIN is too easy to guess. Avoid runs like 1234 and repeats like 1111 — pick digits that mean nothing to anyone else."
    );
  }

  const mobile = String(employee.mobile || "").replace(/\D/g, "");

  if (mobile.length >= pin.length && mobile.endsWith(pin)) {
    throw new AppError(
      400,
      "That PIN is the end of their mobile number, which colleagues know. Pick different digits."
    );
  }

  const hash = await bcrypt.hash(pin, PIN_ROUNDS);
  const saved = await timeclockRepository.setPin(restaurantId, employeeId, hash, userId);

  if (!saved) {
    throw new AppError(404, "Employee not found");
  }

  return { employeeId: saved.id, name: saved.name, hadPin: Boolean(employee.pin_hash) };
};

const removePin = async (restaurantId, employeeId, userId) => {
  requireRestaurantId(restaurantId);

  const removed = await timeclockRepository.removePin(restaurantId, employeeId, userId);

  if (!removed) {
    throw new AppError(404, "Employee not found");
  }

  return { employeeId: removed.id, name: removed.name, hadPin: removed.had_pin };
};

const unlockPin = async (restaurantId, employeeId) => {
  requireRestaurantId(restaurantId);

  const employee = await timeclockRepository.findEmployeeForPin(restaurantId, employeeId);

  if (!employee) {
    throw new AppError(404, "Employee not found");
  }

  await timeclockRepository.clearPinFailures(restaurantId, employeeId);

  return { employeeId: employee.id, name: employee.name };
};

// --- Punch photos ----------------------------------------------------------------

// Photos past their keeping time are deleted whatever the setting is now:
// an owner who switches photos off still expects last month's faces to go
// when their 60 days are up. Every punch deletes them (one indexed delete),
// and so do the day's timeline and the time clock's alerts, at most once an
// hour a restaurant (see sweepOldPhotos), so a restaurant that has stopped
// using the kiosk altogether still loses them while anyone runs the staff
// screens.
const purgeOldPhotos = async (restaurantId, settings = null) => {
  const current = settings || (await timeclockRepository.findSettings(restaurantId));
  const removed = await timeclockRepository.purgePhotos(restaurantId, Number(current.photo_keep_days));
  lastPhotoSweep.set(Number(restaurantId), Date.now());
  return removed;
};

const PHOTO_SWEEP_MS = 60 * 60 * 1000;
const lastPhotoSweep = new Map();

const sweepOldPhotos = async (restaurantId) => {
  const last = lastPhotoSweep.get(Number(restaurantId)) || 0;

  if (Date.now() - last < PHOTO_SWEEP_MS) {
    return 0;
  }

  return purgeOldPhotos(restaurantId);
};

const toSettings = (row) => ({
  punchPhotos: Boolean(row.punch_photos),
  photoKeepDays: Number(row.photo_keep_days),
  updatedAt: row.updated_at || null,
});

const getSettings = async (restaurantId) => {
  requireRestaurantId(restaurantId);
  return toSettings(await timeclockRepository.findSettings(restaurantId));
};

const saveSettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await getSettings(restaurantId);
  const after = toSettings(await timeclockRepository.saveSettings(restaurantId, data, userId));

  // A shorter keeping time applies at once.
  await purgeOldPhotos(restaurantId, { photo_keep_days: after.photoKeepDays });

  return { before, after };
};

// A punch's photo, for managers. Another restaurant's punch, a punch with no
// photo and a photo past its keeping time all answer "not found".
const getPhoto = async (restaurantId, punchId) => {
  requireRestaurantId(restaurantId);

  await purgeOldPhotos(restaurantId);

  const photo = await timeclockRepository.findPhoto(restaurantId, punchId);

  if (!photo) {
    throw new AppError(404, "No photo for this punch");
  }

  return { mimeType: photo.mime_type, image: photo.image, takenAt: photo.taken_at };
};

module.exports = {
  getSettings,
  saveSettings,
  getPhoto,
  purgeOldPhotos,
  sweepOldPhotos,
  ACTIONS,
  EARLY_CLOCK_IN_MINUTES,
  PIN_MAX_ATTEMPTS,
  PIN_WINDOW_MINUTES,
  PIN_LOCK_MINUTES,
  STALE_HOURS,
  verify,
  punch,
  board,
  day,
  listPunches,
  addPunch,
  removePunch,
  listPins,
  setPin,
  removePin,
  unlockPin,
  // Pure helpers, shared with the notification provider, the seed and tests.
  summarise,
  shiftWindow,
  zonedInstant,
  localDate,
  addDays,
  timeLabel,
  dateLabel,
  duration,
  isWeakPin,
  safeZone,
};
