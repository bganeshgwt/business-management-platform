const businessDayRepository = require("../repositories/businessDay.repository");

// The restaurant's own clock. The server may keep another time zone (a cloud
// machine on UTC is five and a half hours behind India), and a business day,
// an expense date or a cut-off hour mean the restaurant's date and hour.

const DEFAULT_ZONE = "Asia/Kolkata";

const zoneOf = (settings) => (settings && settings.timezone) || DEFAULT_ZONE;

const partsIn = (zone, at = new Date()) => {
  let format;

  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: DEFAULT_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
  }

  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));

  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
};

// Today's date on the restaurant's clock, YYYY-MM-DD.
const todayOf = (settings, at = new Date()) => partsIn(zoneOf(settings), at).date;

// A date some days later (or earlier), on the calendar itself.
const addDays = (date, days) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10);
};

// "Wed, 30 Sep 2026": how a date is said in a refusal. Built by hand: the
// en-IN locale spells September "Sept".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const sayDate = (date) => {
  const [y, m, d] = String(date).slice(0, 10).split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  return `${WEEKDAYS[weekday]}, ${d} ${MONTHS[m - 1]} ${y}`;
};

// The dates a business day may be opened for now: today, and — until the
// cut-off hour in the morning — yesterday, for a night that ran past
// midnight before anyone opened it.
const openableDates = (settings, at = new Date()) => {
  const { date, hour } = partsIn(zoneOf(settings), at);
  const cutoff = Number(settings && settings.day_cutoff_hour !== undefined && settings.day_cutoff_hour !== null ? settings.day_cutoff_hour : 5);
  const dates = hour < cutoff ? [addDays(date, -1), date] : [date];

  return { today: date, hour, cutoff, dates };
};

// The trading date when no business day is open: today on the restaurant's
// clock — except before the cut-off hour, when the most recent day (lastDate,
// the one just closed) is last night's. A kitchen that closed last night's
// day at 01:30 is still on that night until the cut-off: read as the
// calendar date, its dashboard and day book jumped to a day with no bills.
// The same window openableDates allows last night's day to be opened in.
const dateWithNoDayOpen = (settings, lastDate, at = new Date()) => {
  const { today, dates } = openableDates(settings, at);
  const last = lastDate ? String(lastDate).slice(0, 10) : null;

  return dates.length > 1 && last === dates[0] ? last : today;
};

// The day a till at this outlet is trading on: the outlet's own open day,
// else the main counter's (an outlet without days of its own trades on it).
const openDayOf = async (restaurantId, outletId) => {
  if (outletId) {
    const own = await businessDayRepository.findOpen(restaurantId, outletId);

    if (own) {
      return own;
    }
  }

  return businessDayRepository.findOpen(restaurantId, null);
};

// dateWithNoDayOpen for a place, judged by the latest day kept there: an
// outlet's own (or the main counter's, for an outlet that never kept a day of
// its own); null the main counter's; undefined any outlet's.
const dateWithNoDayOpenAt = async (restaurantId, outletId, settings, at = new Date()) => {
  let [last] = await businessDayRepository.findRecent(restaurantId, 1, outletId);

  if (!last && outletId) {
    [last] = await businessDayRepository.findRecent(restaurantId, 1, null);
  }

  return dateWithNoDayOpen(settings, last ? last.business_date : null, at);
};

// The trading date at a till now: the open day's (openDayOf), else
// dateWithNoDayOpenAt. undefined for the whole restaurant (any open day).
const currentDateOf = async (restaurantId, outletId, settings, at = new Date()) => {
  const open =
    outletId === undefined ? await businessDayRepository.findOpen(restaurantId, undefined) : await openDayOf(restaurantId, outletId);

  return open ? String(open.business_date).slice(0, 10) : dateWithNoDayOpenAt(restaurantId, outletId, settings, at);
};

// Today's date on a restaurant's clock, read from its settings: what "today"
// means for a supplier's bill, a return, a payment or a stock date, whatever
// time zone the server itself keeps.
const restaurantToday = async (restaurantId) =>
  todayOf({ timezone: await businessDayRepository.findTimezone(restaurantId) });

module.exports = {
  zoneOf,
  todayOf,
  restaurantToday,
  sayDate,
  openableDates,
  dateWithNoDayOpen,
  dateWithNoDayOpenAt,
  currentDateOf,
  openDayOf,
};
