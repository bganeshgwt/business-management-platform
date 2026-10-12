// Calendar dates on the business's own clock, for tests. The server dates
// everything in the restaurant's or business's time zone (Asia/Kolkata by
// default), so a test must never take "today" from the UTC date: between
// 00:00 and 05:30 IST the two differ by a day.

const DEFAULT_TZ = "Asia/Kolkata";

// YYYY-MM-DD in the given time zone.
const today = (tz = DEFAULT_TZ) => new Date().toLocaleDateString("en-CA", { timeZone: tz });

// A YYYY-MM-DD date moved by whole days (pure calendar maths, no clock).
const addDays = (date, n) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(n))).toISOString().slice(0, 10);
};

// n days from today in the given time zone (negative for the past).
const daysFrom = (n, tz = DEFAULT_TZ) => addDays(today(tz), n);

// The first of this month in the given time zone.
const monthStart = (tz = DEFAULT_TZ) => `${today(tz).slice(0, 8)}01`;

// Day of the week of a YYYY-MM-DD date: 0 = Sunday ... 6 = Saturday.
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

module.exports = { DEFAULT_TZ, today, addDays, daysFrom, monthStart, weekdayOf };
