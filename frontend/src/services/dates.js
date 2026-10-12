// Dates as the API wants them: YYYY-MM-DD in the local calendar.
//
// toLocaleDateString("en-CA") rather than toISOString().slice(0, 10), because
// the ISO form converts to UTC first — so at 1am in India it reports
// yesterday, and a day's takings land on the wrong day.
//
// Every function here takes an optional `anchor`: the date the screen should
// treat as "today". A restaurant's today is its open business day, which is
// not the calendar date once service runs past midnight. A bar still serving
// at 00:30 on the 22nd is trading on the 21st, and a report that quietly
// switches to the 22nd shows it a page of zeroes in the middle of a busy
// night. Left out, the anchor is the calendar date, as before.

const asDate = (anchor) => (anchor ? new Date(`${anchor}T00:00:00`) : new Date());

export const today = (anchor) => asDate(anchor).toLocaleDateString("en-CA");

export const daysAgo = (days, anchor) => {
  const date = asDate(anchor);

  date.setDate(date.getDate() - days);

  return date.toLocaleDateString("en-CA");
};

export const monthStart = (anchor) => {
  const date = asDate(anchor);

  date.setDate(1);

  return date.toLocaleDateString("en-CA");
};

// How long a table has been sitting: "40m", "1h 40m".
//
// Lives here rather than in either page because the floor plan and the POS
// both show it, and two copies would drift — one saying "1h 40m" while the
// other said "100m" for the same table.
//
// From a day on it says "3 days" — "313h 51m" is a number nobody reads. The
// same rule as durationMinutes() in services/format.js (kept here, not
// imported, because format.js imports this file's month names).
export const elapsed = (since, now = Date.now()) => {
  const minutes = Math.max(0, Math.round((now - new Date(since)) / 60000));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  if (minutes >= 24 * 60) {
    const days = Math.floor(minutes / (24 * 60));
    return days === 1 ? "1 day" : `${days} days`;
  }

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

// A table sitting this long without being billed is worth a second look.
export const LINGERING_MINUTES = 75;

export const minutesSince = (since, now = Date.now()) =>
  Math.max(0, Math.round((now - new Date(since)) / 60000));

// The ranges worth one click. "Last 7 days" means today and the six before it,
// which is the week a manager means when they say it — not eight days.
export const QUICK_RANGES = [
  {
    key: "today",
    label: "Today",
    range: (anchor) => ({ from: today(anchor), to: today(anchor) }),
  },
  {
    key: "7d",
    label: "Last 7 days",
    range: (anchor) => ({ from: daysAgo(6, anchor), to: today(anchor) }),
  },
  {
    key: "30d",
    label: "Last 30 days",
    range: (anchor) => ({ from: daysAgo(29, anchor), to: today(anchor) }),
  },
  {
    key: "month",
    label: "This month",
    range: (anchor) => ({ from: monthStart(anchor), to: today(anchor) }),
  },
];

// Which quick range the current dates correspond to, or null for a range the
// user typed themselves. Worked out from the dates rather than remembered in
// state, so the highlight cannot drift away from what is actually shown.
export const matchingRange = (from, to, anchor) => {
  const found = QUICK_RANGES.find((option) => {
    const { from: start, to: end } = option.range(anchor);

    return start === from && end === to;
  });

  return found ? found.key : null;
};

// The app's own short month names. The browser's en-IN short month spells
// September "Sept", which no other screen (or the bill, or the KOT) does, so
// every date here is written from this one list: "23 Sep".
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "23 Sep", "23 Sep 2026" (year: true) or "23 Sep, 4:10 pm" (time: true), in
// the browser's own clock, from a Date, a timestamp or a moment string. A
// plain "2026-09-23" is read as that calendar day, not as midnight UTC (which
// would be the 22nd west of Greenwich). Anything unreadable gives "".
export const dayMonth = (value, { year = false, time = false } = {}) => {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const text = String(value);
  const date =
    value instanceof Date ? value : /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00`) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const day = `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}${year ? ` ${date.getFullYear()}` : ""}`;

  return time ? `${day}, ${date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}` : day;
};
