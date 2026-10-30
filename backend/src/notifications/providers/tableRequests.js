// Guests waiting on the staff, for the bell: a QR order nobody has accepted,
// and a call for a waiter, the bill or water nobody has finished. Both are a
// guest sitting at a table looking around for someone, which is why they turn
// critical within minutes rather than hours.
//
// Read-only. Uses the inbox's partial index on open requests, so it stays
// cheap however many requests the day has seen.

// An order sitting in the inbox this long needs a nudge; this long, a manager.
const ORDER_WARNING_MINUTES = 2;
const ORDER_CRITICAL_MINUTES = 5;

// A call is answered by walking over, so it gets a little longer.
const CALL_WARNING_MINUTES = 3;
const CALL_CRITICAL_MINUTES = 6;

// The worst few are named; the rest are counted, so a slammed Saturday does
// not bury every other module's alerts.
const NAMED_LIMIT = 5;

const CALL_WORDS = {
  call_waiter: "is calling for a waiter",
  bill: "asked for the bill",
  water: "asked for water",
  other: "needs something",
};

const minutesBetween = (from, to) => Math.floor((to.getTime() - new Date(from).getTime()) / 60000);

// "4 min", or "4h 36m" once it has run past an hour — a forgotten request at
// the end of a long shift should read as a length of time, not "276 min".
const duration = (minutes) =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const atMark = (createdAt, minutes) =>
  new Date(new Date(createdAt).getTime() + minutes * 60000).toISOString();

// A summary's members: every request past the named few, carried on the
// first row of its kind.
const members = (rows) => ((rows[0] && rows[0].rest_ids) || []).map((id) => `request:${id}`);

// "Today" for a request: its own place's open business day (local midnight
// when none is open) — the inbox's own rule. A request an earlier day left
// unanswered is history: the inbox lists it only under Earlier days, so the
// bell does not ring for it either, or it would lead to an empty inbox.
const { TODAY_FROM, DAY_START } = require("../../modules/restaurant/orders/repositories/tableRequest.repository");

const place = (row) =>
  [row.floor_name, row.area_name].filter(Boolean).join(" · ") || "Dining room";

// What the inbox holds (its own rule): a waiter's bill ask from the captain
// app in every restaurant, and the guests' requests from the tables' QR codes
// and the online ordering page while each is switched on (Settings ->
// Features).
const IN_INBOX = `(r.created_by IS NOT NULL
  OR (COALESCE(r.channel, 'qr') = 'qr' AND 'qr_ordering' = ANY(restaurant_features($1)))
  OR (r.channel = 'website' AND 'online_ordering' = ANY(restaurant_features($1))))`;

module.exports = {
  key: "table-requests",
  permission: "orders.view",

  collect: async ({ restaurantId, now, pool }) => {
    try {
      const at = now.toISOString();

      // Orders and calls are ranked separately, oldest first, each with its
      // own true count and the ids of everything past the named few — the
      // members of its "more" summary. One shared, capped list let a busy
      // inbox undercount, and a request past the cap could join a summary
      // without making it news.
      const result = await pool.query(
        `WITH waiting AS (
           SELECT r.id, r.request_type = 'order' AS is_order,
                  ROW_NUMBER() OVER (PARTITION BY r.request_type = 'order'
                                     ORDER BY r.created_at, r.id) AS position
           FROM table_requests r
           ${TODAY_FROM("$1")}
           WHERE r.restaurant_id = $1
             AND r.created_at >= ${DAY_START}
             AND ${IN_INBOX}
             AND ((r.request_type = 'order' AND r.status IN ('pending', 'processing')
                   AND r.created_at <= $2::timestamptz - make_interval(mins => $3))
                  OR (r.request_type <> 'order' AND r.status IN ('pending', 'acknowledged')
                      AND r.created_at <= $2::timestamptz - make_interval(mins => $4)))
         ),
         groups AS (
           SELECT is_order, COUNT(*)::int AS total,
                  ARRAY_AGG(id ORDER BY position) FILTER (WHERE position > $5::int) AS rest_ids
           FROM waiting
           GROUP BY is_order
         )
         SELECT r.id, r.request_type, r.status, r.created_at, r.item_count, r.estimated_total,
                r.notes, r.repeat_count, r.guest_name, t.table_no, r.channel, r.service_type,
                f.name AS floor_name, a.name AS area_name,
                g.total, CASE WHEN w.position = 1 THEN g.rest_ids END AS rest_ids
         FROM waiting w
         JOIN groups g ON g.is_order = w.is_order
         JOIN table_requests r ON r.id = w.id
         -- A website order has no table.
         LEFT JOIN dining_tables t ON t.id = r.table_id
         LEFT JOIN floors f ON f.id = t.floor_id
         LEFT JOIN dining_areas a ON a.id = t.area_id
         WHERE w.position <= $5::int + 1
         ORDER BY r.created_at, r.id`,
        [restaurantId, at, ORDER_WARNING_MINUTES, CALL_WARNING_MINUTES, NAMED_LIMIT]
      );

      const orders = result.rows.filter((row) => row.request_type === "order");
      const calls = result.rows.filter((row) => row.request_type !== "order");
      const alerts = [];

      for (const row of orders.slice(0, NAMED_LIMIT)) {
        const waited = minutesBetween(row.created_at, now);
        // Escalating is a new condition, so it makes a read alert unread.
        const severity = waited >= ORDER_CRITICAL_MINUTES ? "critical" : "warning";

        alerts.push({
          id: `table-requests:order:${row.id}:${severity}`,
          severity,
          title:
            row.channel === "website"
              ? `Online ${row.service_type} order has waited ${duration(waited)}`
              : `QR order from table ${row.table_no} has waited ${duration(waited)}`,
          detail: `${plural(row.item_count, "item", "items")}${
            row.guest_name ? ` · ${row.guest_name}` : ""
          } · ${row.channel === "website" ? "From your ordering page" : place(row)} · accept or reject it`,
          link: "/table-requests",
          category: "Table requests",
          at: atMark(
            row.created_at,
            severity === "critical" ? ORDER_CRITICAL_MINUTES : ORDER_WARNING_MINUTES
          ),
        });
      }

      if (orders.length > NAMED_LIMIT) {
        const restCount = orders[0].total - NAMED_LIMIT;
        // The rest are newer than the named ones, so the oldest of them —
        // the first after the named few — decides whether any is critical.
        const next = orders[NAMED_LIMIT];
        const worst = minutesBetween(next.created_at, now) >= ORDER_CRITICAL_MINUTES;

        alerts.push({
          // One id per severity, with the requests behind it as members:
          // accepting one leaves it read, another guest waiting makes it news.
          id: `table-requests:orders-more:${worst ? "critical" : "warning"}`,
          members: members(orders),
          severity: worst ? "critical" : "warning",
          title: `${plural(restCount, "more QR order", "more QR orders")} waiting to be accepted`,
          detail: "Guests are waiting for a yes — open the inbox",
          link: "/table-requests",
          category: "Table requests",
          at: atMark(next.created_at, ORDER_WARNING_MINUTES),
        });
      }

      for (const row of calls.slice(0, NAMED_LIMIT)) {
        const waited = minutesBetween(row.created_at, now);
        const severity = waited >= CALL_CRITICAL_MINUTES ? "critical" : "warning";
        const asked = row.repeat_count > 0 ? ` · asked ${row.repeat_count + 1} times` : "";

        alerts.push({
          id: `table-requests:call:${row.id}:${severity}`,
          severity,
          title: `Table ${row.table_no} ${CALL_WORDS[row.request_type]} — ${duration(waited)} ago`,
          detail: `${
            row.status === "acknowledged" ? "Acknowledged, not yet done" : "Nobody has answered yet"
          }${asked}${row.request_type === "other" && row.notes ? ` · “${row.notes}”` : ""}`,
          link: "/table-requests",
          category: "Table requests",
          at: atMark(
            row.created_at,
            severity === "critical" ? CALL_CRITICAL_MINUTES : CALL_WARNING_MINUTES
          ),
        });
      }

      if (calls.length > NAMED_LIMIT) {
        const restCount = calls[0].total - NAMED_LIMIT;
        const next = calls[NAMED_LIMIT];
        const worst = minutesBetween(next.created_at, now) >= CALL_CRITICAL_MINUTES;

        alerts.push({
          id: `table-requests:calls-more:${worst ? "critical" : "warning"}`,
          members: members(calls),
          severity: worst ? "critical" : "warning",
          title: `${plural(restCount, "more table", "more tables")} waiting for someone to come over`,
          detail: "Calls for a waiter, the bill or water are piling up",
          link: "/table-requests",
          category: "Table requests",
          at: atMark(next.created_at, CALL_WARNING_MINUTES),
        });
      }

      return alerts;
    } catch (error) {
      console.error("table-requests notifications:", error.message);
      return [];
    }
  },
};
