// The business day: every sale, payment and expense is filed under the day
// that was open when it happened. Getting it wrong is silent and expensive —
// a day never opened leaves the morning's bills on no day at all; yesterday
// left open books today's takings to yesterday, and the day-end report and
// the cash count stop agreeing.
//
// All times are the restaurant's own wall clock (`timezone`), because that is
// what its opening hours are written in.
//
// A failed query rejects, so the registry reports this area as "could not
// check" instead of "all clear".
const { completeContext } = require("..");

// A day open this long has almost certainly run past its service.
const LONG_OPEN_HOURS = 18;
// After midnight, yesterday's day is still legitimately open while the last
// tables settle. Unless the hours say service runs later, 4am is when
// "still open" stops being a late night and becomes a forgotten close.
const DEFAULT_CUTOFF_MINUTES = 4 * 60;
// When the hours do run past midnight, give the close this long after.
const CLOSE_GRACE_MINUTES = 60;
// A restaurant that has not set its hours yet — a new one, typically — still
// cannot take an order with no day open. The bell assumes the usual lunch-to-
// late-dinner window rather than stay silent, and says it is assuming.
const ASSUMED_HOURS = { isOpen: true, openTime: "11:00", closeTime: "23:00" };

const minutesOf = (hhmm) => {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
};

const clockLabel = (hhmm) => {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(minutes).padStart(2, "0")}${hours < 12 ? "am" : "pm"}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "Wed 23 Sep", built by hand: en-IN spells September "Sept".
const dateLabel = (isoDate) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[month - 1]}`;
};

const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

const dayBefore = (isoDate) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};

const overnight = (hours) =>
  Boolean(hours && hours.isOpen && hours.openTime && hours.closeTime) &&
  minutesOf(hours.closeTime) <= minutesOf(hours.openTime);

// The restaurant's local date, weekday and minute of the day.
const wallClock = (now, timezone) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
};

// The instant it was `minutes` past local midnight today, from the local time
// now. Good enough for "when did this become true" — it is only ever shown as
// "12 min ago".
const localInstant = (now, clock, minutes) => new Date(now.getTime() - (clock.minutes - minutes) * 60000);

// Pure: given what the database says, which alerts are due? Kept apart from
// the queries so every case — early morning, a late night, a closed Sunday —
// can be checked without touching the real business day.
//
//   openDay          { id, businessDate, openedAt } or null
//   todayClosed      a day for today's date has already been opened and closed
//   yesterdayClosed  the same for yesterday's date
//   hoursToday       { isOpen, openTime: "HH:MM", closeTime: "HH:MM" } or null
//   hoursYesterday   the same for yesterday's weekday
//   hoursOpenDay     the same for the weekday of the open day
//   hoursConfigured  whether the restaurant has set its hours at all; when
//                    left out, true if any of the hours above were given
const evaluate = ({
  now,
  timezone,
  openDay,
  todayClosed = false,
  yesterdayClosed = false,
  hoursToday = null,
  hoursYesterday = null,
  hoursOpenDay = null,
  hoursConfigured,
}) => {
  const clock = wallClock(now, timezone);
  const configured =
    hoursConfigured === undefined ? Boolean(hoursToday || hoursYesterday || hoursOpenDay) : hoursConfigured;
  const alerts = [];

  if (openDay) {
    const behind = daysBetween(openDay.businessDate, clock.date);
    const cutoff = overnight(hoursOpenDay)
      ? Math.max(DEFAULT_CUTOFF_MINUTES, minutesOf(hoursOpenDay.closeTime) + CLOSE_GRACE_MINUTES)
      : DEFAULT_CUTOFF_MINUTES;
    const stale = behind >= 2 || (behind === 1 && clock.minutes >= cutoff);

    if (stale) {
      alerts.push({
        id: `businessDay:stale:${openDay.id}`,
        severity: "critical",
        title:
          behind === 1
            ? "Yesterday's business day is still open"
            : `The business day of ${dateLabel(openDay.businessDate)} is still open`,
        detail: `Today's sales are being filed under ${dateLabel(
          openDay.businessDate
        )} — close it and open today before the next bill`,
        link: "/business-day",
        category: "Business day",
        at: (behind === 1 ? localInstant(now, clock, cutoff) : new Date(openDay.openedAt)).toISOString(),
      });

      return alerts;
    }

    const openFor = (now.getTime() - new Date(openDay.openedAt).getTime()) / 3600000;

    if (openFor >= LONG_OPEN_HOURS) {
      alerts.push({
        id: `businessDay:long:${openDay.id}`,
        severity: "warning",
        title: `Business day open for ${Math.floor(openFor)} hours`,
        detail: "Close it once the last table has settled, so tomorrow's sales start on a fresh day",
        link: "/business-day",
        category: "Business day",
        at: new Date(new Date(openDay.openedAt).getTime() + LONG_OPEN_HOURS * 3600000).toISOString(),
      });
    }

    return alerts;
  }

  // Nothing open, and today has already been run and closed: an early close
  // on a quiet night is not something to ring a bell about.
  if (todayClosed) {
    return alerts;
  }

  // No hours set at all. Orders and bills are blocked all the same, so say
  // so inside a plausible trading window — as a warning, not critical,
  // because the window is a guess, and with the way to stop guessing.
  if (!configured) {
    const opens = minutesOf(ASSUMED_HOURS.openTime);

    if (clock.minutes >= opens && clock.minutes < minutesOf(ASSUMED_HOURS.closeTime)) {
      alerts.push({
        id: `businessDay:not-open:${clock.date}`,
        severity: "warning",
        title: "No business day is open",
        detail: `Orders and bills are blocked until one is opened · your opening hours are not set, so this assumes ${clockLabel(
          ASSUMED_HOURS.openTime
        )} to ${clockLabel(ASSUMED_HOURS.closeTime)} — set them in Settings`,
        link: "/business-day",
        category: "Business day",
        at: localInstant(now, clock, opens).toISOString(),
      });
    }

    return alerts;
  }

  // Past midnight in a service that runs overnight — a bar open 6pm to
  // 3:30am at half past one — last night's day should still be open. If it
  // was opened and closed early, fine; if it never was, every late bill is
  // landing on no day.
  if (
    overnight(hoursYesterday) &&
    clock.minutes < minutesOf(hoursYesterday.closeTime) &&
    !yesterdayClosed
  ) {
    alerts.push({
      // The same id the alert had before midnight, so reading it then keeps
      // it read now.
      id: `businessDay:not-open:${dayBefore(clock.date)}`,
      severity: "critical",
      title: "No business day is open",
      detail: `Service runs until ${clockLabel(
        hoursYesterday.closeTime
      )} — open the day with the float in the drawer so every late bill lands on it`,
      link: "/business-day",
      category: "Business day",
      at: localInstant(now, clock, minutesOf(hoursYesterday.openTime) - 24 * 60).toISOString(),
    });

    return alerts;
  }

  // Otherwise it is only a problem inside today's opening hours.
  if (!hoursToday || !hoursToday.isOpen || !hoursToday.openTime) {
    return alerts;
  }

  const opens = minutesOf(hoursToday.openTime);
  const closes = hoursToday.closeTime ? minutesOf(hoursToday.closeTime) : 24 * 60;
  const trading = clock.minutes >= opens && (overnight(hoursToday) || clock.minutes < closes);

  if (trading) {
    alerts.push({
      id: `businessDay:not-open:${clock.date}`,
      severity: "critical",
      title: "Today's business day has not been opened",
      detail: `You open at ${clockLabel(hoursToday.openTime)} — open the day with the float in the drawer so every bill lands on it`,
      link: "/business-day",
      category: "Business day",
      at: localInstant(now, clock, opens).toISOString(),
    });
  }

  return alerts;
};

const toHours = (row) =>
  row
    ? {
        isOpen: row.is_open,
        openTime: row.open_time,
        closeTime: row.close_time,
      }
    : null;

async function collectAlerts({ restaurantId, timezone, now, pool }) {
  const clock = wallClock(now, timezone);
  const yesterday = dayBefore(clock.date);

  const [open, closed, hours] = await Promise.all([
    pool.query(
      `SELECT id, business_date::text AS business_date, opened_at
       FROM business_days
       WHERE restaurant_id = $1 AND day_status = 'open'
       ORDER BY opened_at
       LIMIT 1`,
      [restaurantId]
    ),
    pool.query(
      `SELECT DISTINCT business_date::text AS business_date
       FROM business_days
       WHERE restaurant_id = $1 AND day_status = 'closed' AND business_date = ANY($2::date[])`,
      [restaurantId, [clock.date, yesterday]]
    ),
    // The restaurant-wide week (outlet_id NULL): seven rows at most, saved
    // together by the hours screen, so none at all means never set.
    // day_of_week 0 is Sunday, as on that screen.
    pool.query(
      `SELECT day_of_week, is_open,
              to_char(open_time, 'HH24:MI') AS open_time,
              to_char(close_time, 'HH24:MI') AS close_time
       FROM business_hours
       WHERE restaurant_id = $1 AND outlet_id IS NULL`,
      [restaurantId]
    ),
  ]);

  const openRow = open.rows[0] || null;
  const openWeekday = openRow ? new Date(`${openRow.business_date}T00:00:00Z`).getUTCDay() : null;
  const byDay = new Map(hours.rows.map((row) => [Number(row.day_of_week), row]));
  const closedDates = new Set(closed.rows.map((row) => row.business_date));

  return evaluate({
    now,
    timezone,
    openDay: openRow && {
      id: openRow.id,
      businessDate: openRow.business_date,
      openedAt: openRow.opened_at,
    },
    todayClosed: closedDates.has(clock.date),
    yesterdayClosed: closedDates.has(yesterday),
    hoursToday: toHours(byDay.get(clock.weekday)),
    hoursYesterday: toHours(byDay.get((clock.weekday + 6) % 7)),
    hoursOpenDay: openWeekday === null ? null : toHours(byDay.get(openWeekday)),
    hoursConfigured: hours.rows.length > 0,
  });
}

module.exports = {
  key: "businessDay",
  permission: "business_day.view",

  collect: (context) => collectAlerts(completeContext(context)),

  // Exported for tests; the registry only calls collect().
  evaluate,
  wallClock,
};
