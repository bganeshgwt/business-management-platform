// The time clock: people who should be here and are not, people who seem to
// have gone home without clocking out, and breaks that have run long.
//
// For whoever runs the staff (staff.manage). A cashier using the tablet at the
// door does not need to be told who is late — the manager who has to find
// cover does.
const timeclock = require("../../modules/restaurant/staff/services/timeclock.service");

// A rostered person not in fifteen minutes after their shift began is worth a
// phone call: they may be stuck in traffic, or not coming at all.
const LATE_ALERT_MINUTES = 15;
// Twelve hours on the clock is past any single shift; it is almost always a
// forgotten clock-out, and left alone it pays someone for a night at home.
const LONG_SESSION_HOURS = 12;
// A 30-minute meal break that reaches 45 minutes is worth knowing about (or
// the shift's own break, where a shift allows longer).
const LONG_BREAK_MINUTES = 45;
// Past this the kiosk itself treats the session as forgotten (see the
// service); the alert changes wording to match.
const STALE_HOURS = timeclock.STALE_HOURS;
// How far back a forgotten clock-out is still chased.
const OPEN_DAY_LOOKBACK = 7;

const NAMED_LIMIT = 5;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

module.exports = {
  key: "timeclock",
  label: "Time clock",
  permission: "staff.manage",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "staff_payroll",

  collect: async (context) => {
    // Punch photos past their keeping time are deleted from here too (at most
    // once an hour a restaurant), so they go even when nobody punches.
    timeclock.sweepOldPhotos(context.restaurantId).catch(() => undefined);

    try {
      return await collectAlerts(context);
    } catch (error) {
      console.error("timeclock notifications:", error.message);
      return [];
    }
  },
};

async function collectAlerts({ restaurantId, timezone: rawZone, now, pool }) {
  const timezone = timeclock.safeZone(rawZone || "Asia/Kolkata");
  const today = timeclock.localDate(now, timezone);
  const yesterday = timeclock.addDays(today, -1);
  const at = now.toISOString();

  const [rostered, openDays, lastPunches] = await Promise.all([
    // Today's roster, and yesterday's in case an overnight shift is still on.
    // Anyone who has clocked in that day, or whom a manager has already marked
    // absent or on leave, is not "late".
    pool.query(
      `SELECT a.employee_id, a.work_date, a.assignment_status, a.shift_id,
              s.name AS shift_name, s.start_time, s.end_time, s.break_minutes, s.grace_minutes,
              e.name, e.mobile
       FROM shift_assignments a
       JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
       JOIN shifts s ON s.id = a.shift_id
       LEFT JOIN attendance att
              ON att.employee_id = a.employee_id AND att.attendance_date = a.work_date
       WHERE a.restaurant_id = $1
         AND a.work_date = ANY($2::date[])
         AND a.assignment_status = 'scheduled'
         AND (att.id IS NULL
              OR (att.check_in IS NULL
                  AND att.attendance_status NOT IN ('absent', 'leave', 'week_off', 'half_day')))
       ORDER BY s.start_time, e.name`,
      [restaurantId, [yesterday, today]]
    ),
    // Clocked in, never out, and the open stint began twelve hours ago or
    // more. The stint is timed from its own clock-in — the latest one that
    // day — not the day's first: a split-shift cook in at 10, out at 3 and
    // back at 6 has been on the clock four hours at 10 pm, not twelve. (The
    // partial index on open attendance rows keeps the outer scan small.)
    pool.query(
      `SELECT a.id, a.employee_id, a.attendance_date, a.check_in, e.name,
              COALESCE(s.session_start, a.check_in) AS session_start
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN LATERAL (
         SELECT MAX(p.punched_at) AS session_start
         FROM attendance_punches p
         WHERE p.restaurant_id = a.restaurant_id AND p.work_date = a.attendance_date
           AND p.employee_id = a.employee_id AND p.punch_type = 'clock_in'
       ) s ON TRUE
       WHERE a.restaurant_id = $1
         AND a.check_in IS NOT NULL AND a.check_out IS NULL
         AND COALESCE(s.session_start, a.check_in) <= $2::timestamptz - make_interval(hours => $3)
         AND a.attendance_date >= $4::date
       ORDER BY COALESCE(s.session_start, a.check_in)`,
      [restaurantId, at, LONG_SESSION_HOURS, timeclock.addDays(today, -OPEN_DAY_LOOKBACK)]
    ),
    // Each person's latest punch in the last shift-length; a break_start that
    // is still the latest one is a break still going. With the break their
    // shift allows that day, so the alert can say how far over it is.
    pool.query(
      `SELECT DISTINCT ON (p.employee_id)
              p.id, p.employee_id, p.work_date, p.punch_type, p.punched_at, e.name,
              s.name AS shift_name, s.break_minutes AS shift_break_minutes
       FROM attendance_punches p
       JOIN employees e ON e.id = p.employee_id
       LEFT JOIN shift_assignments sa
              ON sa.employee_id = p.employee_id AND sa.work_date = p.work_date
             AND sa.assignment_status = 'scheduled'
       LEFT JOIN shifts s ON s.id = sa.shift_id
       WHERE p.restaurant_id = $1
         AND p.punched_at > $2::timestamptz - make_interval(hours => $3)
       ORDER BY p.employee_id, p.punched_at DESC, p.id DESC`,
      [restaurantId, at, STALE_HOURS]
    ),
  ]);

  const alerts = [];

  // --- Not in yet ------------------------------------------------------------
  const late = [];

  for (const row of rostered.rows) {
    const window = timeclock.shiftWindow(row.work_date, row, timezone);

    if (!window) {
      continue;
    }

    const alertFrom = new Date(window.startsAt.getTime() + LATE_ALERT_MINUTES * 60000);

    // Only while the shift is on: after it ends this is an absence for the
    // attendance sheet, not something to chase now.
    if (now >= alertFrom && now < window.endsAt) {
      late.push({ row, window, alertFrom, minutes: Math.round((now - window.startsAt) / 60000) });
    }
  }

  for (const { row, window, alertFrom, minutes } of late.slice(0, NAMED_LIMIT)) {
    alerts.push({
      id: `timeclock:late:${row.employee_id}:${row.work_date}`,
      severity: "warning",
      title: `${row.name} has not clocked in — ${window.shiftName} started ${minutes} min ago`,
      detail: [
        `Shift ${timeclock.timeLabel(window.startsAt, timezone)} – ${timeclock.timeLabel(window.endsAt, timezone)}`,
        row.mobile ? `call ${row.mobile}` : null,
        "or mark leave on the roster",
      ]
        .filter(Boolean)
        .join(" · "),
      link: "/staff/timeclock",
      category: "Staff",
      at: alertFrom.toISOString(),
    });
  }

  if (late.length > NAMED_LIMIT) {
    const rest = late.slice(NAMED_LIMIT);

    alerts.push({
      // One id for the day, with the people behind it as members: someone
      // clocking in leaves it read, someone else missing their start makes it
      // news.
      id: `timeclock:late-more:${today}`,
      members: rest.map((item) => `employee:${item.row.employee_id}:${item.row.work_date}`),
      severity: "warning",
      title: `${plural(rest.length, "more person has", "more people have")} not clocked in for their shift`,
      detail: rest.map((item) => item.row.name).join(", "),
      link: "/staff/timeclock",
      category: "Staff",
      at: rest[0].alertFrom.toISOString(),
    });
  }

  // --- Long on the clock / forgot to clock out -------------------------------
  for (const row of openDays.rows.slice(0, NAMED_LIMIT * 2)) {
    const started = new Date(row.session_start);
    const hours = Math.floor((now - started) / 3600000);
    const forgotten = hours >= STALE_HOURS;
    const since = timeclock.timeLabel(started, timezone);

    alerts.push({
      // The stage is in the id: an alert read at 12 hours comes back unread
      // once the kiosk has given up on the session and it needs fixing.
      id: `timeclock:${forgotten ? "open" : "long"}:${row.id}`,
      severity: "warning",
      title: forgotten
        ? `${row.name} never clocked out on ${timeclock.dateLabel(row.attendance_date)}`
        : `${row.name} has been clocked in for ${hours} hours`,
      detail: forgotten
        ? `Clocked in at ${since} · add the clock-out time so their hours are right`
        : `Since ${since} · still here, or forgot to clock out?`,
      link: `/staff/timeclock?tab=day&date=${row.attendance_date}`,
      category: "Staff",
      at: new Date(started.getTime() + (forgotten ? STALE_HOURS : LONG_SESSION_HOURS) * 3600000).toISOString(),
    });
  }

  // --- Long breaks ------------------------------------------------------------
  for (const row of lastPunches.rows) {
    if (row.punch_type !== "break_start") {
      continue;
    }

    // Past 45 minutes — or past the shift's own break, where a shift allows
    // a longer one (a 60-minute split break is not "long" at 50).
    const allowed = Number(row.shift_break_minutes || 0);
    const limit = Math.max(LONG_BREAK_MINUTES, allowed);
    const minutes = Math.round((now - new Date(row.punched_at)) / 60000);

    if (minutes < limit) {
      continue;
    }

    alerts.push({
      id: `timeclock:break:${row.id}`,
      severity: "info",
      title: `${row.name}'s break has run ${timeclock.duration(minutes)}`,
      detail: [
        `On break since ${timeclock.timeLabel(row.punched_at, timezone)}`,
        allowed
          ? `the ${row.shift_name} shift allows ${allowed} min, so ${timeclock.duration(minutes - allowed)} over`
          : row.shift_name
            ? `the ${row.shift_name} shift has no break set`
            : "not on the roster today",
      ].join(" · "),
      link: "/staff/timeclock",
      category: "Staff",
      at: new Date(new Date(row.punched_at).getTime() + limit * 60000).toISOString(),
    });
  }

  return alerts;
}
