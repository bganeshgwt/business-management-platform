// The kitchen-station report's queries: the tickets of a range of business
// days, station by station, with the times the kitchen records on them.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { scopeParams } = require("./sql");

// The range's tickets as the report counts them: those of the business days
// dated inside it (a night that runs past midnight stays on its day), at the
// outlet chosen, cancelled tickets left out. For each:
//   ready_seconds   sent (cut) to ready; tickets cleared without ever being
//                   marked ready have none
//   serve_seconds   ready to served, for tickets that waited at the pass
//                   (marked ready before someone served them); a ticket
//                   bumped straight to served, or cleared, has none
//   late            past the kitchen's late mark ($6 minutes): marked ready
//                   after it, still not ready past it, or cleared without
//                   being ready after sitting past it (the kitchen display's
//                   own rule, kitchen.repository findStats)
//   hour            the hour it was sent, on the restaurant's clock ($5)
const TICKETS = `
  SELECT k.id, k.station_id, k.cleared_reason,
         EXTRACT(HOUR FROM k.created_at AT TIME ZONE $5)::int AS hour,
         (SELECT COALESCE(SUM(ki.quantity - ki.cancelled_quantity), 0) FROM kot_items ki WHERE ki.kot_id = k.id) AS dishes,
         CASE WHEN k.ready_at IS NOT NULL THEN EXTRACT(EPOCH FROM (k.ready_at - k.created_at)) END AS ready_seconds,
         CASE WHEN k.cleared_reason IS NULL AND k.served_at > k.ready_at
              THEN EXTRACT(EPOCH FROM (k.served_at - k.ready_at)) END AS serve_seconds,
         ((k.ready_at IS NOT NULL AND k.ready_at - k.created_at > make_interval(mins => $6))
           OR (k.kot_status IN ('new', 'cooking') AND NOW() - k.created_at > make_interval(mins => $6))
           OR (k.cleared_reason IS NOT NULL AND k.ready_at IS NULL
               AND k.served_at - k.created_at > make_interval(mins => $6))) AS late
  FROM kots k
  JOIN business_days bd ON bd.id = k.business_day_id
  WHERE k.restaurant_id = $1
    AND bd.business_date BETWEEN $2::date AND $3::date
    AND ($4::bigint IS NULL OR k.outlet_id = $4)
    AND k.kot_status <> 'cancelled'`;

// Station by station, and the whole kitchen (station_id NULL): tickets,
// dishes, the average and 90th-percentile times, late and cleared tickets.
const kitchenStations = async (scope, lateMinutes) => {
  const values = [...scopeParams(scope), lateMinutes];
  const [figures, hours, cancelled] = await Promise.all([
    pool.query(
      `WITH t AS (${TICKETS})
       SELECT t.station_id, GROUPING(t.station_id) = 1 AS whole,
              s.name AS station_name, s.color AS station_color, s.sort_order,
              COUNT(*)::int AS tickets,
              SUM(t.dishes) AS dishes,
              COUNT(t.ready_seconds)::int AS timed_ready,
              AVG(t.ready_seconds) AS avg_ready_seconds,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY t.ready_seconds) AS p90_ready_seconds,
              COUNT(t.serve_seconds)::int AS timed_serve,
              AVG(t.serve_seconds) AS avg_serve_seconds,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY t.serve_seconds) AS p90_serve_seconds,
              COUNT(*) FILTER (WHERE t.late)::int AS late,
              COUNT(*) FILTER (WHERE t.cleared_reason IS NOT NULL)::int AS cleared
       FROM t
       LEFT JOIN kitchen_stations s ON s.id = t.station_id
       GROUP BY GROUPING SETS ((t.station_id, s.name, s.color, s.sort_order), ())
       ORDER BY whole, s.sort_order, LOWER(s.name)`,
      values
    ),
    pool.query(
      `WITH t AS (${TICKETS})
       SELECT t.station_id, GROUPING(t.station_id) = 1 AS whole, t.hour, COUNT(*)::int AS tickets
       FROM t
       GROUP BY GROUPING SETS ((t.station_id, t.hour), (t.hour))
       ORDER BY t.hour`,
      values
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n
       FROM kots k
       JOIN business_days bd ON bd.id = k.business_day_id
       WHERE k.restaurant_id = $1
         AND bd.business_date BETWEEN $2::date AND $3::date
         AND ($4::bigint IS NULL OR k.outlet_id = $4)
         AND k.kot_status = 'cancelled'`,
      scopeParams(scope).slice(0, 4)
    ),
  ]);

  return { figures: figures.rows, hours: hours.rows, cancelled: cancelled.rows[0].n };
};

module.exports = {
  kitchenStations,
};
