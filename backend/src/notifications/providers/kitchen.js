// Kitchen alerts for the bell: tickets taking too long, and food plated but
// not picked up. Both are "a guest is waiting now" problems, which is why the
// worst of them are critical.
//
// Read-only: it looks at tickets the kitchen display has already cut. Timings
// follow the restaurant's own kitchen timers (Kitchen display → Stations).
const { stillInKitchenSql } = require("../../modules/restaurant/kitchen/repositories/kitchen.repository");

// Food waiting at the pass this long is going cold, unless the restaurant
// set its own beside the kitchen timers. Matches the board.
const PASS_MINUTES = 8;

// Past the late mark by this much, a ticket stops being a warning.
const CRITICAL_AFTER_LATE = 10;

// A dozen near-identical rows bury everything else in the bell, so the worst
// few are named and the rest are counted.
const NAMED_LIMIT = 5;

const kotLabel = (number) => `KOT-${String(number).padStart(3, "0")}`;

const destination = (row) => {
  if (row.order_type === "dine_in" || row.order_type === "qr") {
    return row.table_no ? `table ${row.table_no}` : row.order_number;
  }

  return `${row.order_type === "delivery" ? "delivery" : "takeaway"} ${row.order_number}`;
};

const minutesBetween = (from, to) => Math.floor((to.getTime() - new Date(from).getTime()) / 60000);

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// Only tickets really still in the kitchen: an open business day's, and not
// ones the board is about to clear (a paid table, a parcel billed two hours
// ago, an order cancelled or served from the orders screen). Otherwise a
// parcel nobody bumped would ring the bell as critical all evening.
const STILL_IN_KITCHEN = `
  FROM kots k
  JOIN orders o ON o.id = k.order_id
  WHERE k.restaurant_id = $1
    AND ${stillInKitchenSql("$2::timestamptz")}`;

// What a named alert says about a ticket, read only for the few that are named.
const COLUMNS = `k.id, k.kot_number, k.kot_status, k.created_at, k.ready_at, k.station_id,
  s.name AS station_name, o.order_number, o.order_type, t.table_no,
  (SELECT COUNT(*)::int FROM kot_items ki
   WHERE ki.kot_id = k.id AND ki.quantity > ki.cancelled_quantity) AS dishes`;

// `matching` is a CTE of (id, position, is_critical) over every ticket in
// the situation, worst first. The worst few come back with their details; the
// counts, and the ids of every ticket past the named few (the members of the
// "more" summary), are worked out over all of them, not over a capped page.
const namedAndRest = (matching) => `
  WITH matching AS (${matching}),
  totals AS (
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE is_critical)::int AS critical_total,
           ARRAY_AGG(id ORDER BY position) FILTER (WHERE position > ${NAMED_LIMIT}) AS rest_ids
    FROM matching
  )
  SELECT ${COLUMNS}, x.total, x.critical_total,
         CASE WHEN m.position = 1 THEN x.rest_ids END AS rest_ids
  FROM matching m
  CROSS JOIN totals x
  JOIN kots k ON k.id = m.id
  JOIN kitchen_stations s ON s.id = k.station_id
  JOIN orders o ON o.id = k.order_id
  LEFT JOIN dining_tables t ON t.id = o.table_id
  WHERE m.position <= ${NAMED_LIMIT + 1}
  ORDER BY m.position`;

// A summary's members: the tickets behind it, so it keeps one id while they
// come and go, and turns unread only when a ticket joins it.
const members = (rows) => ((rows[0] && rows[0].rest_ids) || []).map((id) => `kot:${id}`);

module.exports = {
  key: "kitchen",
  permission: "kds.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "kitchen_display",

  collect: async ({ restaurantId, now, pool }) => {
    try {
      const settings = await pool.query(
        "SELECT late_minutes, pass_minutes FROM kitchen_settings WHERE restaurant_id = $1",
        [restaurantId]
      );
      const lateMinutes = settings.rows[0] ? settings.rows[0].late_minutes : 20;
      const passMinutes = settings.rows[0] ? settings.rows[0].pass_minutes : PASS_MINUTES;
      const criticalMinutes = lateMinutes + CRITICAL_AFTER_LATE;
      const at = now.toISOString();

      // Late tickets and tickets at the pass are read separately, each with
      // its own limit and its own true count. One shared, capped list let a
      // backlog of late tickets push every "food waiting at the pass" alert
      // off the end, and undercounted the rest.
      const [late, pass] = await Promise.all([
        pool.query(
          namedAndRest(`
            SELECT k.id,
                   ROW_NUMBER() OVER (ORDER BY k.created_at, k.id) AS position,
                   k.created_at <= $2::timestamptz - make_interval(mins => $4) AS is_critical
            ${STILL_IN_KITCHEN}
              AND k.kot_status IN ('new', 'cooking')
              AND k.created_at <= $2::timestamptz - make_interval(mins => $3)`),
          [restaurantId, at, lateMinutes, criticalMinutes]
        ),
        pool.query(
          namedAndRest(`
            SELECT k.id,
                   ROW_NUMBER() OVER (ORDER BY k.ready_at, k.id) AS position,
                   FALSE AS is_critical
            ${STILL_IN_KITCHEN}
              AND k.kot_status = 'ready'
              AND k.ready_at <= $2::timestamptz - make_interval(mins => $3)`),
          [restaurantId, at, passMinutes]
        ),
      ]);

      const alerts = [];
      const lateTotal = late.rows.length > 0 ? Number(late.rows[0].total) : 0;
      const criticalTotal = late.rows.length > 0 ? Number(late.rows[0].critical_total) : 0;
      const named = late.rows.slice(0, NAMED_LIMIT);

      for (const row of named) {
        const waited = minutesBetween(row.created_at, now);
        // A new severity is a new condition, so escalating to critical makes
        // a read alert unread again.
        const severity = waited >= criticalMinutes ? "critical" : "warning";

        alerts.push({
          id: `kitchen:late:${row.id}:${severity}`,
          severity,
          title: `${kotLabel(row.kot_number)} for ${destination(row)} has waited ${waited} min`,
          detail: `${row.station_name} · ${
            row.kot_status === "new" ? "not started yet" : "still cooking"
          } · ${plural(row.dishes, "dish", "dishes")}`,
          link: `/kitchen?station=${row.station_id}`,
          category: "Kitchen",
          at: new Date(new Date(row.created_at).getTime() + lateMinutes * 60000).toISOString(),
        });
      }

      const lateRest = lateTotal - named.length;

      if (lateRest > 0) {
        // The named ones are the oldest, so the rest hold a critical ticket
        // only if more tickets are critical than were named.
        const worst = criticalTotal > named.length ? "critical" : "warning";
        const next = late.rows[NAMED_LIMIT];

        alerts.push({
          // One id per severity, with the tickets behind it as members: a
          // ticket served leaves it read, another one running late makes it
          // news, and the backlog turning critical is news too.
          id: `kitchen:late-more:${worst}`,
          members: members(late.rows),
          severity: worst,
          title: `${plural(lateRest, "more ticket", "more tickets")} past ${lateMinutes} min`,
          detail: "The kitchen is behind — check the board",
          link: "/kitchen",
          category: "Kitchen",
          at: new Date(new Date(next.created_at).getTime() + lateMinutes * 60000).toISOString(),
        });
      }

      const passTotal = pass.rows.length > 0 ? Number(pass.rows[0].total) : 0;
      const atPass = pass.rows.slice(0, NAMED_LIMIT);

      for (const row of atPass) {
        const waiting = minutesBetween(row.ready_at, now);

        alerts.push({
          id: `kitchen:pass:${row.id}`,
          severity: "warning",
          title: `Food waiting at the pass: ${kotLabel(row.kot_number)} for ${destination(row)}`,
          detail: `Ready ${waiting} min ago · ${row.station_name} · pick it up before it goes cold`,
          link: `/kitchen?station=${row.station_id}`,
          category: "Kitchen",
          at: new Date(new Date(row.ready_at).getTime() + passMinutes * 60000).toISOString(),
        });
      }

      const passRest = passTotal - atPass.length;

      if (passRest > 0) {
        const next = pass.rows[NAMED_LIMIT];

        alerts.push({
          id: "kitchen:pass-more",
          members: members(pass.rows),
          severity: "warning",
          title: `${plural(passRest, "more plate", "more plates")} waiting at the pass`,
          detail: `Ready for over ${passMinutes} min and not yet served`,
          link: "/kitchen",
          category: "Kitchen",
          at: new Date(new Date(next.ready_at).getTime() + passMinutes * 60000).toISOString(),
        });
      }

      return alerts;
    } catch (error) {
      // A database without the kitchen tables yet, or a hiccup: an empty
      // kitchen section beats an empty bell.
      console.error("kitchen notifications:", error.message);
      return [];
    }
  },
};
