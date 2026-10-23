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

// Whole days from one YYYY-MM-DD date to another (pure calendar maths).
const daysBetween = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;

// n days from today in the given time zone (negative for the past).
const daysFrom = (n, tz = DEFAULT_TZ) => addDays(today(tz), n);

// The trading date now, as the server's tradingDateOf has it: the date on the
// business's clock less the morning cut-off (day_cutoff_hour, 5 by default).
// A restaurant's day and a business's tasks run to the cut-off, so between
// midnight and then it is still yesterday's date.
const tradingToday = (cutoffHour = 5, tz = DEFAULT_TZ) =>
  new Date(Date.now() - cutoffHour * 3600000).toLocaleDateString("en-CA", { timeZone: tz });

// The first of this month in the given time zone.
const monthStart = (tz = DEFAULT_TZ) => `${today(tz).slice(0, 8)}01`;

// Day of the week of a YYYY-MM-DD date: 0 = Sunday ... 6 = Saturday.
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

// The hour (0-23) now on the given time zone's clock.
const hourNow = (tz = DEFAULT_TZ) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()));

// What a time zone's clock reads at a moment, in milliseconds as if it were UTC.
const clockReading = (at, tz) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
};

// The moment a wall-clock time ("HH:MM") on a YYYY-MM-DD date is in the given
// time zone, as an ISO string: momentAt("2026-11-02", "10:00") is 04:30 UTC.
const momentAt = (date, time, tz = DEFAULT_TZ) => {
  const wall = Date.parse(`${date}T${time}:00Z`);
  // The zone's offset, read at the wall time and again at the result, in case
  // summer time starts or ends in between.
  let at = wall - (clockReading(wall, tz) - wall);
  at = wall - (clockReading(at, tz) - at);
  return new Date(at).toISOString();
};

// Place-named zones a whole hour apart all round the clock (the restaurant
// settings take place names only: "Etc/GMT-5" reads backwards), India first.
// Whatever the time, one of them reads any hour a test needs.
const ZONES = [
  DEFAULT_TZ, "Africa/Abidjan", "Africa/Lagos", "Africa/Johannesburg", "Africa/Nairobi", "Asia/Dubai",
  "Asia/Tashkent", "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Australia/Brisbane",
  "Pacific/Guadalcanal", "Pacific/Tarawa", "Pacific/Fakaofo", "Pacific/Kiritimati", "Atlantic/Cape_Verde",
  "America/Noronha", "America/Sao_Paulo", "America/La_Paz", "America/Bogota", "America/Guatemala",
  "America/Phoenix", "Pacific/Pitcairn", "Pacific/Gambier", "Pacific/Honolulu", "Pacific/Pago_Pago",
];

// The first of ZONES whose clock reads an hour from `from` to `to` now: a test
// that needs the business open, or in the small hours, gives it that clock
// instead of waiting for the hour (India's whenever its hour fits).
const zoneWithHour = (from, to) => {
  const zone = ZONES.find((name) => {
    const hour = hourNow(name);
    return hour >= from && hour <= to;
  });
  if (!zone) throw new Error(`No zone reads an hour from ${from} to ${to} now`);
  return zone;
};

module.exports = {
  DEFAULT_TZ, ZONES, today, addDays, daysBetween, daysFrom, tradingToday, monthStart, weekdayOf, hourNow, momentAt, zoneWithHour,
};
