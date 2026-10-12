// Online table booking requests waiting for an answer (the public booking
// link). A guest who asked for Saturday 8 pm is waiting to hear yes or no, and
// their covers already count against what the link offers the next guest, so
// a request left unanswered costs a table either way.
//
// For people who answer them (reservations.manage: the host stand). Someone
// tied to one outlet hears only that outlet's requests, when the registry
// passes their outlet. A request for a date already gone is history (the
// Reservations screen lists it under Earlier), so the bell does not ring for
// it.
//
// A failed query rejects, so the registry reports this area as "could not
// check" instead of "all clear".
const { completeContext } = require("..");

const NAMED_LIMIT = 5;
// Not answered this long after it came in: a warning rather than news.
const WARNING_AFTER_MINUTES = 60;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const timeLabel = (hhmm) => {
  const [hours, minutes] = String(hhmm).split(":").map(Number);
  const suffix = hours < 12 ? "am" : "pm";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return `${twelve}:${String(minutes).padStart(2, "0")}${suffix}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dateLabel = (date, today) => {
  if (date === today) {
    return "today";
  }

  const [, month, day] = String(date).split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

async function collectAlerts(context) {
  const { restaurantId, now, pool, today } = context;
  const outletId = context.outletId || null;

  const result = await pool.query(
    `SELECT r.id, r.guest_name, r.party_size, r.reservation_date::text AS reservation_date,
            to_char(r.start_time, 'HH24:MI') AS start_time, r.created_at, o.name AS outlet_name
     FROM reservations r
     LEFT JOIN outlets o ON o.id = r.outlet_id
     WHERE r.restaurant_id = $1 AND r.status = 'requested'
       AND r.reservation_date >= $2::date
       AND ($3::bigint IS NULL OR r.outlet_id = $3)
     ORDER BY r.created_at, r.id
     LIMIT 200`,
    [restaurantId, today, outletId]
  );

  const rows = result.rows;
  const alerts = [];
  const at = now instanceof Date ? now : new Date();

  for (const row of rows.slice(0, NAMED_LIMIT)) {
    const waited = Math.floor((at.getTime() - new Date(row.created_at).getTime()) / 60000);

    alerts.push({
      id: `bookingRequests:request:${row.id}`,
      severity: waited >= WARNING_AFTER_MINUTES ? "warning" : "info",
      title: `${row.guest_name} asked online for a table for ${plural(row.party_size, "guest", "guests")}, ${dateLabel(
        row.reservation_date,
        today
      )} at ${timeLabel(row.start_time)}`,
      detail: [row.outlet_name, "accept it with a table or decline it with a reason"].filter(Boolean).join(" · "),
      link: `/reservations?date=${row.reservation_date}&show=requested&booking=${row.id}`,
      category: "Reservations",
      at: new Date(row.created_at).toISOString(),
    });
  }

  if (rows.length > NAMED_LIMIT) {
    const rest = rows.slice(NAMED_LIMIT);

    alerts.push({
      id: "bookingRequests:more",
      severity: "info",
      title: `${plural(rest.length, "more online booking request", "more online booking requests")} waiting for an answer`,
      detail: "Open Reservations → Online requests",
      link: "/reservations?show=requested",
      category: "Reservations",
      at: new Date(rest[rest.length - 1].created_at).toISOString(),
      members: rest.map((row) => `request:${row.id}`),
    });
  }

  return alerts;
}

module.exports = {
  key: "bookingRequests",
  label: "Online booking requests",
  permission: "reservations.manage",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "reservations",

  collect: async (context) => collectAlerts(completeContext(context)),
};
