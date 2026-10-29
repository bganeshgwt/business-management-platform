// The kitchen-station report: how each station of the kitchen did over a
// range of business days.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const kitchenRepository = require("../../../kitchen/repositories/kitchen.repository");
const { num } = require("./common");
const { describe, scopeFor } = require("./scope");

// Whole seconds, or null when no ticket was timed.
const seconds = (value) => (value === null || value === undefined ? null : Math.round(Number(value)));

// The three hours a station sent the most tickets in, busiest first (an
// earlier hour first on a tie).
const BUSIEST = 3;

const busiestOf = (hours) =>
  [...hours]
    .sort((a, b) => b.tickets - a.tickets || a.hour - b.hour)
    .slice(0, BUSIEST)
    .map(({ hour, tickets }) => ({ hour, tickets }));

const figuresOf = (row, hours) => ({
  tickets: row.tickets,
  dishes: Math.round(num(row.dishes) * 100) / 100,
  // Sent (the ticket cut) to marked ready.
  timedReady: row.timed_ready,
  avgReadySeconds: seconds(row.avg_ready_seconds),
  p90ReadySeconds: seconds(row.p90_ready_seconds),
  // Marked ready to served, for the tickets that waited at the pass.
  timedServe: row.timed_serve,
  avgServeSeconds: seconds(row.avg_serve_seconds),
  p90ServeSeconds: seconds(row.p90_serve_seconds),
  late: row.late,
  // Left the board without anyone pressing Served (cleared).
  cleared: row.cleared,
  busiestHours: busiestOf(hours),
});

// For each station that had tickets in the range (the business days dated
// inside it, on the restaurant's calendar, at the outlet chosen): its tickets
// and dishes, the average and the 90th-percentile time from sent to ready and
// from ready to served, the tickets past the kitchen's late mark (the kitchen
// settings' timers) and its busiest hours; and the same for the whole
// kitchen. Cancelled tickets are left out, and counted so the screen says so.
const kitchenStationReport = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const settings = await kitchenRepository.findSettings(restaurantId);
  const data = await reportRepository.kitchenStations(context.scope, settings.late_minutes);
  const hoursOf = (stationId) =>
    data.hours.filter((row) => (stationId === null ? row.whole : !row.whole && Number(row.station_id) === Number(stationId)));
  // The whole kitchen's row comes back with no tickets too: none then.
  const whole = data.figures.find((row) => row.whole && row.tickets > 0);

  return {
    ...describe(context),
    warnMinutes: settings.warn_minutes,
    lateMinutes: settings.late_minutes,
    cancelledLeftOut: data.cancelled,
    total: whole ? figuresOf(whole, hoursOf(null)) : null,
    stations: data.figures
      .filter((row) => !row.whole)
      .map((row) => ({
        stationId: Number(row.station_id),
        stationName: row.station_name,
        stationColor: row.station_color,
        ...figuresOf(row, hoursOf(row.station_id)),
      })),
    // Tickets sent in each hour of the day, the whole kitchen's.
    hours: hoursOf(null).map(({ hour, tickets }) => ({ hour, tickets })),
  };
};

module.exports = {
  kitchenStationReport,
};
