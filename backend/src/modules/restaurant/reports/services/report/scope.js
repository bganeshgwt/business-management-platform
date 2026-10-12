// The restaurant's clock and a report's scope: time zone, trading days, outlet and date range.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const businessDayRepository = require("../../../business-day/repositories/businessDay.repository");
const restaurantRepository = require("../../../setup/repositories/restaurant.repository");
const outletRepository = require("../../../setup/repositories/outlet.repository");
const AppError = require("../../../../../utils/AppError");
const tradingDayRules = require("../../../business-day/services/tradingDay");
const { requireRestaurantId } = require("./common");

// ---------------------------------------------------------------------------
// The restaurant's clock
// ---------------------------------------------------------------------------

// The restaurant's timezone, as the database will use it. Only a real zone
// name (Asia/Kolkata, UTC) is passed on: PostgreSQL reads "+05:30" or
// "UTC+05:30" as POSIX offsets with the sign turned round, which moves every
// figure by eleven hours, and a typo would stop every report with an error.
const ZONE_NAME = /^(?:[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)$/;

const DEFAULT_ZONE = "Asia/Kolkata";

const zoneOf = (settings) => {
  const zone = settings && typeof settings.timezone === "string" ? settings.timezone.trim() : "";

  if (!ZONE_NAME.test(zone)) {
    return DEFAULT_ZONE;
  }

  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_ZONE;
  }
};

const localToday = (timezone) => new Date().toLocaleDateString("en-CA", { timeZone: timezone });

// Which business days "today" is, for the dashboard, the reports' default
// dates, the day-end sheet and the kitchen block — one rule for all of them:
//
//   an outlet     its own open day; else, for an outlet that never kept a
//                 day of its own, the main counter's open day (its own bills
//                 within it); else no day is open there.
//   All outlets   every day open now — the main counter's and each outlet's
//                 own, each on its own date — added up.
//
// A kitchen still serving at 00:30 is on yesterday's day. With no day open,
// "today" is the local date on the restaurant's own clock — except before the
// cut-off hour (day_cutoff_hour), when the latest day there is last night's:
// that night is still being traded (tradingDay.dateWithNoDayOpen, the rule
// the Business day screen opens days by). A branch that closed last night's
// day at 01:30 jumped to the calendar date: its dashboard and day book read
// ₹0 while its Z report showed the night's takings.
//
// Returns { businessDate, dayOpen, days, dayIds, sharesMainDay }: `days` the
// open days added up (with the outlet's name), `dayIds` their ids (null when
// none is open), `businessDate` the latest of their dates. Reading only the
// main counter's day put a branch trading on 1 Oct on the 23 Sep day the main
// counter had left open: its dashboard, its Bills cards, its reports' dates
// and its Z report all read ₹0.
const tradingDays = async (restaurantId, outlet, timezone, settings = {}) => {
  const open = await reportRepository.openDays(restaurantId);
  // No day open: today, or last night's date until the cut-off when the
  // latest day here (`last`) is last night's.
  const none = (last) => ({
    businessDate: tradingDayRules.dateWithNoDayOpen(
      { day_cutoff_hour: settings.day_cutoff_hour, timezone },
      last ? last.business_date : null
    ),
    dayOpen: false,
    days: [],
    dayIds: null,
    sharesMainDay: false,
  });
  const result = (days, sharesMainDay = false) => ({
    businessDate: days.reduce((latest, day) => (day.business_date > latest ? day.business_date : latest), days[0].business_date),
    dayOpen: true,
    days,
    dayIds: days.map((day) => Number(day.id)),
    sharesMainDay,
  });

  if (outlet) {
    const own = open.find((day) => Number(day.outlet_id) === Number(outlet.id));

    if (own) {
      return result([own]);
    }

    // A branch that keeps days of its own and has closed tonight's is not
    // trading on the main counter's day (it takes no order until it opens
    // its next one): no day is open there. Read as the main counter's day,
    // a branch that had just closed showed ₹0 for the main counter's date on
    // its dashboard and its Z report.
    const [latestOwn] = await businessDayRepository.findRecent(restaurantId, 1, outlet.id);

    if (latestOwn) {
      return none(latestOwn);
    }

    const main = open.find((day) => !day.outlet_id);

    return main ? result([main], true) : none((await businessDayRepository.findRecent(restaurantId, 1, null))[0]);
  }

  // All outlets with none open: the latest day of any of them.
  return open.length > 0 ? result(open) : none((await businessDayRepository.findRecent(restaurantId, 1))[0]);
};

// The open days as the screens show them: whose day, and its date.
const daysOut = (days) =>
  days.map((day) => ({
    businessDayId: Number(day.id),
    businessDate: day.business_date,
    outletId: day.outlet_id ? Number(day.outlet_id) : null,
    outletName: day.outlet_name || null,
    label: day.outlet_name || "Main counter",
  }));

// "Today" for a report with no dates: the date of the business day being
// traded (see tradingDays).
const tradingDate = async (restaurantId, timezone, outlet = null, settings = {}) =>
  (await tradingDays(restaurantId, outlet, timezone, settings)).businessDate;

// Everything a report needs to know about where it is looking.
//
//   range     { from, to } from the query; missing dates mean the trading day
//             of the outlet chosen (its own business day), or of the whole
//             restaurant
//   outletId  from the outlet switcher (req.outletId); null = whole restaurant
const scopeFor = async (restaurantId, range = {}, outletId = null) => {
  requireRestaurantId(restaurantId);

  const settings = (await restaurantRepository.findSettings(restaurantId)) || {};
  const timezone = zoneOf(settings);

  let { from, to } = range;
  let outlet = null;

  if (outletId) {
    outlet = await outletRepository.findById(restaurantId, outletId);

    // resolveOutlet has already checked the outlet is this restaurant's; a
    // missing one here means it was deleted in between.
    if (!outlet) {
      throw new AppError(404, "Outlet not found");
    }
  }

  if (!from || !to) {
    const today = await tradingDate(restaurantId, timezone, outlet, settings);
    from = from || to || today;
    to = to || from;
  }

  if (to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  return {
    scope: { restaurantId, from, to, outletId: outlet ? outlet.id : null, timezone },
    settings,
    outlet,
  };
};

// What the screens print above a report, so a sheet handed over says what it
// covers: the dates, and which outlet (or all of them).
const describe = ({ scope, outlet }) => ({
  from: scope.from,
  to: scope.to,
  outletId: outlet ? outlet.id : null,
  outletName: outlet ? outlet.name : null,
  // A closed outlet's history can still be read; the screens say it is closed.
  outletClosed: Boolean(outlet && outlet.status !== "active"),
  timezone: scope.timezone,
});

// Which day "today" is for the Reports screen: the business day being traded
// (the kitchen still serving at 00:30 is on yesterday's day) and the local
// calendar date on the restaurant's own clock, not the browser's. With an
// outlet chosen (or for staff tied to one), that outlet's own day; for All
// outlets the latest of the days open, with every open day listed so the
// screen can say when one of them is on an older date.
const tradingDay = async (restaurantId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const settings = (await restaurantRepository.findSettings(restaurantId)) || {};
  const timezone = zoneOf(settings);
  const outlet = outletId ? await outletRepository.findById(restaurantId, outletId) : null;
  const today = await tradingDays(restaurantId, outlet, timezone, settings);

  return {
    businessDate: today.dayOpen ? today.businessDate : null,
    // One day: its id. Several (All outlets): see openDays.
    businessDayId: today.dayIds && today.dayIds.length === 1 ? today.dayIds[0] : null,
    dayOpen: today.dayOpen,
    openDays: daysOut(today.days),
    outletId: outlet ? outlet.id : null,
    outletName: outlet ? outlet.name : null,
    // The outlet trades on the main counter's day (it has none of its own).
    sharesMainDay: today.sharesMainDay,
    calendarDate: localToday(timezone),
    timezone,
  };
};

module.exports = {
  zoneOf,
  tradingDays,
  daysOut,
  scopeFor,
  describe,
  tradingDay,
};
