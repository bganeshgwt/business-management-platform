// Delivery alerts for the bell: food packed and waiting for a rider, a rider
// out far longer than a run should take, and an order nobody could deliver
// because it has no address.
//
// Read-only. Where an order stands comes from the same expression the
// deliveries board uses, so the bell and the board never disagree.
const { effectiveStatusSql } = require("../../modules/restaurant/deliveries/repositories/delivery.repository");
const ruleSettings = require("../../modules/restaurant/setup/services/ruleSettings.service");

// The timings are the restaurant's own (Settings -> Alerts and timings), read
// once per check, the same ones the board uses:
//   deliveryReadyWaitMinutes    packed food waiting this long for a rider is
//                               going cold
//   deliveryOutWarnMinutes /    a run past the first is a warning; past the
//   deliveryOutCriticalMinutes  second, someone should phone the rider
// Far enough back to catch an order still on the road after the day closed,
// near enough that the bell never reads history.
const LOOKBACK = "18 hours";
// A dozen near-identical rows bury everything else in the bell, so the worst
// few are named and the rest are counted.
const NAMED_LIMIT = 5;

const minutesBetween = (from, to) => Math.floor((to.getTime() - new Date(from).getTime()) / 60000);

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const who = (row) => row.customer_name || row.linked_customer_name || "guest";

const channelOf = (row) => (row.channel_name ? `${row.channel_name} · ` : "");

// A summary's members: the orders behind it. The summary keeps one id while
// they come and go, and turns unread only when an order joins it — not every
// time one is dispatched, delivered or given its address.
const members = (rows) => rows.map((row) => `order:${row.id}`);

module.exports = {
  key: "deliveries",
  permission: "orders.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "deliveries",

  collect: async ({ restaurantId, now, pool }) => {
    try {
      const at = now.toISOString();
      const rules = await ruleSettings.load(restaurantId, pool);
      const readyWaitMinutes = rules.deliveryReadyWaitMinutes;
      const outWarnMinutes = rules.deliveryOutWarnMinutes;
      const outCriticalMinutes = rules.deliveryOutCriticalMinutes;

      // Uses the orders (restaurant_id, placed_at) index, then works only on
      // the handful of deliveries still in play.
      const result = await pool.query(
        `SELECT * FROM (
           SELECT o.id, o.order_number, o.customer_name, cu.name AS linked_customer_name,
                  o.delivery_address, o.placed_at, o.dispatched_at, o.rider_employee_id,
                  o.partner_rider_name, e.name AS rider_name,
                  ch.name AS channel_name, ch.channel_type,
                  ${effectiveStatusSql("o")} AS status,
                  COALESCE(o.delivery_ready_at,
                           (SELECT MAX(COALESCE(k.ready_at, k.served_at)) FROM kots k
                            WHERE k.order_id = o.id AND k.kot_status IN ('ready', 'served')),
                           o.delivery_preparing_at, o.placed_at) AS ready_at
           FROM orders o
           LEFT JOIN customers cu ON cu.id = o.customer_id
           LEFT JOIN sales_channels ch ON ch.id = o.channel_id
           LEFT JOIN employees e ON e.id = o.rider_employee_id
           WHERE o.restaurant_id = $1
             AND o.order_type = 'delivery'
             AND o.order_status <> 'cancelled'
             AND COALESCE(o.delivery_status, 'pending') NOT IN ('delivered', 'cancelled')
             AND o.placed_at > $2::timestamptz - $3::interval
             -- Today's only (an open business day), as on the board: a
             -- delivery an earlier day left unfinished is history, found on
             -- the board by picking its date, so it does not ring here.
             AND o.business_day_id IN (SELECT id FROM business_days
                                       WHERE restaurant_id = $1 AND day_status = 'open')
         ) d
         ORDER BY d.placed_at DESC
         LIMIT 200`,
        [restaurantId, at, LOOKBACK]
      );

      // The newest 200 in play, oldest first. Past that many, what is cut is
      // the oldest — orders nobody marked delivered hours ago — and never a
      // parcel packed a minute ago, which a summary would otherwise miss.
      const rows = result.rows.reverse();
      const alerts = [];

      // ------------------------------------------------ waiting at the pass
      const waiting = rows.filter(
        (row) => row.status === "ready" && minutesBetween(row.ready_at, now) > readyWaitMinutes
      );

      for (const row of waiting.slice(0, NAMED_LIMIT)) {
        const minutes = minutesBetween(row.ready_at, now);
        const rider = row.rider_name || row.partner_rider_name;

        alerts.push({
          id: `deliveries:ready:${row.id}`,
          severity: "warning",
          title: `${row.order_number} has waited ${minutes} min for a rider`,
          detail: `${channelOf(row)}${who(row)} · ${
            rider ? `${rider} is assigned but has not left` : "no rider assigned yet"
          }`,
          link: `/deliveries?order=${row.id}`,
          category: "Deliveries",
          at: new Date(new Date(row.ready_at).getTime() + readyWaitMinutes * 60000).toISOString(),
        });
      }

      if (waiting.length > NAMED_LIMIT) {
        const rest = waiting.slice(NAMED_LIMIT);

        alerts.push({
          id: "deliveries:ready-more",
          members: members(rest),
          severity: "warning",
          title: `${plural(rest.length, "more order", "more orders")} packed and waiting for riders`,
          detail: `Ready for over ${readyWaitMinutes} min — food is going cold`,
          link: "/deliveries",
          category: "Deliveries",
          at: new Date(new Date(rest[0].ready_at).getTime() + readyWaitMinutes * 60000).toISOString(),
        });
      }

      // ------------------------------------------------ out too long
      const long = rows.filter(
        (row) =>
          row.status === "out_for_delivery" &&
          row.dispatched_at &&
          minutesBetween(row.dispatched_at, now) > outWarnMinutes
      );

      for (const row of long.slice(0, NAMED_LIMIT)) {
        const minutes = minutesBetween(row.dispatched_at, now);
        // A new severity is a new condition, so escalating to critical makes
        // a read alert unread again.
        const severity = minutes > outCriticalMinutes ? "critical" : "warning";
        const rider = row.rider_name || row.partner_rider_name || "The rider";

        alerts.push({
          id: `deliveries:out:${row.id}:${severity}`,
          severity,
          title: `${rider} has been out ${minutes} min with ${row.order_number}`,
          detail: `${channelOf(row)}${who(row)} · ${
            severity === "critical" ? "call the rider and the guest" : "longer than a run should take"
          }`,
          link: `/deliveries?order=${row.id}`,
          category: "Deliveries",
          at: new Date(
            new Date(row.dispatched_at).getTime() +
              (severity === "critical" ? outCriticalMinutes : outWarnMinutes) * 60000
          ).toISOString(),
        });
      }

      if (long.length > NAMED_LIMIT) {
        const rest = long.slice(NAMED_LIMIT);
        const worst = rest.some((row) => minutesBetween(row.dispatched_at, now) > outCriticalMinutes);

        alerts.push({
          // Per severity: a run crossing the hour is a new condition.
          id: `deliveries:out-more:${worst ? "critical" : "warning"}`,
          members: members(rest),
          severity: worst ? "critical" : "warning",
          title: `${plural(rest.length, "more delivery", "more deliveries")} out over ${outWarnMinutes} min`,
          detail: "Check the rider panel on the deliveries board",
          link: "/deliveries",
          category: "Deliveries",
          at: new Date(new Date(rest[0].dispatched_at).getTime() + outWarnMinutes * 60000).toISOString(),
        });
      }

      // ------------------------------------------------ nowhere to go
      // A Swiggy or Zomato order carried by their own rider has its address
      // in their app; any other delivery without one cannot leave.
      const noAddress = rows.filter(
        (row) =>
          !row.delivery_address &&
          ["pending", "preparing", "ready"].includes(row.status) &&
          !(row.channel_type === "aggregator" && !row.rider_employee_id)
      );

      for (const row of noAddress.slice(0, NAMED_LIMIT)) {
        alerts.push({
          id: `deliveries:no-address:${row.id}`,
          severity: "warning",
          title: `${row.order_number} has no delivery address`,
          detail: `${channelOf(row)}${who(row)} · add it before a rider is sent`,
          link: `/deliveries?order=${row.id}`,
          category: "Deliveries",
          at: new Date(row.placed_at).toISOString(),
        });
      }

      if (noAddress.length > NAMED_LIMIT) {
        const rest = noAddress.slice(NAMED_LIMIT);

        alerts.push({
          id: "deliveries:no-address-more",
          members: members(rest),
          severity: "warning",
          title: `${plural(rest.length, "more delivery", "more deliveries")} without an address`,
          detail: "Add them on the deliveries board before the riders go",
          link: "/deliveries",
          category: "Deliveries",
          at: new Date(rest[0].placed_at).toISOString(),
        });
      }

      return alerts;
    } catch (error) {
      // A database without the delivery columns yet, or a hiccup: an empty
      // deliveries section beats an empty bell.
      console.error("delivery notifications:", error.message);
      return [];
    }
  },
};
