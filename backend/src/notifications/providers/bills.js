// Money still on the table: bills handed over and not paid, dues carried from
// earlier days, and orders left open on a day that has already been closed.
//
// For whoever takes payment (payments.manage). A captain can see a bill but
// cannot settle it, so telling them about it is noise.
//
// A failed query is left to reject: the registry then reports bills as
// "could not check" and keeps everyone's read marks, where an empty list
// would claim all is well and forget them.
const { completeContext } = require("..");

// A bill is normally paid within minutes of landing on the table. An hour
// unpaid means the guest has left, is disputing it, or it was forgotten.
const UNPAID_WARNING_MINUTES = 60;
// Three hours on, the table has certainly turned over and the money is
// walking out of the door.
const UNPAID_CRITICAL_MINUTES = 180;
// A bill raised with no business day open belongs to no day; past this it is
// a due, not something the floor should still be chasing.
const LOOSE_BILL_HOURS = 24;

const NAMED_LIMIT = 5;

// Unsettled bills still on the floor: on the open day, or on no day and under
// a day old. $1 restaurant, $2 now, $3 minutes unpaid, $4 LOOSE_BILL_HOURS.
// Reads the partial index of unsettled bills, so it stays a handful of rows
// however long the restaurant trades.
const ON_THE_FLOOR = `
  b.restaurant_id = $1
  AND b.bill_status IN ('unpaid', 'partial')
  AND b.billed_at <= $2::timestamptz - make_interval(mins => $3)
  AND (bd.day_status = 'open'
       OR (b.business_day_id IS NULL
           AND b.billed_at > $2::timestamptz - make_interval(hours => $4)))`;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const duration = (minutes) => {
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours >= 48) {
    return `${Math.floor(hours / 24)} days`;
  }

  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

const timeLabel = (at, timezone) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(at))
    .replace(/\s?([ap])\.?m\.?$/i, (_, half) => `${half.toLowerCase()}m`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "22 Sep". Built by hand: en-IN spells September "Sept", unlike every
// other screen in the app.
const dateLabel = (isoDate) => {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

const dayBefore = (isoDate) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};

// How long ago a bill was raised and when, on the restaurant's clock:
// "billed 1 h 30 min ago at 1:08pm" today, "billed 28 h 50 min ago,
// yesterday at 1:08pm" — a time alone is ambiguous once a bill is more than a
// few hours old — and "billed 3 days ago, on 21 Sep at 1:08pm" before that.
const billedAgo = (at, waited, timezone, today) => {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(at));
  const time = timeLabel(at, timezone);
  const ago = `billed ${duration(waited)} ago`;

  if (date === today) {
    return `${ago} at ${time}`;
  }

  return date === dayBefore(today) ? `${ago}, yesterday at ${time}` : `${ago}, on ${dateLabel(date)} at ${time}`;
};

const who = (row) => {
  if (row.table_no) {
    return `Table ${row.table_no}`;
  }

  const kind = { takeaway: "Takeaway", delivery: "Delivery", online: "Online order", qr: "QR order" }[
    row.order_type
  ];

  return `${kind || "Order"} ${row.order_number}`;
};

const minutesBetween = (from, to) => Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 60000));

async function collectAlerts({ restaurantId, timezone, now, pool, money, today }) {
  const at = now.toISOString();
  const floorParams = [restaurantId, at, UNPAID_WARNING_MINUTES, LOOSE_BILL_HOURS];

  const [named, rest, dues, strandedOrders] = await Promise.all([
    // The longest waiting, named one by one.
    pool.query(
      `SELECT b.id, b.bill_number, b.bill_status, b.total_amount, b.paid_amount, b.billed_at,
              o.order_number, o.order_type, o.customer_name, t.table_no
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       LEFT JOIN dining_tables t ON t.id = o.table_id
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE ${ON_THE_FLOOR}
       ORDER BY b.billed_at, b.id
       LIMIT $5`,
      [...floorParams, NAMED_LIMIT]
    ),
    // Everything after them, as one summary: totals over every row, not a
    // capped page of them, so the amount shown is the amount owed.
    pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(rest.due), 0) AS due,
              MIN(rest.billed_at) AS oldest,
              COALESCE(array_agg(rest.id ORDER BY rest.id) FILTER (WHERE rest.id IS NOT NULL), '{}') AS ids
       FROM (
         SELECT b.id, b.total_amount - b.paid_amount AS due, b.billed_at
         FROM bills b
         LEFT JOIN business_days bd ON bd.id = b.business_day_id
         WHERE ${ON_THE_FLOOR}
         ORDER BY b.billed_at, b.id
         OFFSET $5
       ) rest`,
      [...floorParams, NAMED_LIMIT]
    ),
    // Dues are bills a manager chose to carry when closing the day: a regular
    // who settles next week. Worth knowing about, not worth an alarm.
    pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(b.total_amount - b.paid_amount), 0) AS due,
              COALESCE(array_agg(b.id ORDER BY b.id) FILTER (WHERE b.id IS NOT NULL), '{}') AS ids,
              MIN(COALESCE(bd.business_date, (b.billed_at AT TIME ZONE $3)::date))::text AS oldest_date,
              MAX(COALESCE(bd.closed_at, b.billed_at + make_interval(hours => $4))) AS since
       FROM bills b
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE b.restaurant_id = $1
         AND b.bill_status IN ('unpaid', 'partial')
         AND (bd.day_status = 'closed'
              OR (b.business_day_id IS NULL
                  AND b.billed_at <= $2::timestamptz - make_interval(hours => $4)))`,
      [restaurantId, at, timezone, LOOSE_BILL_HOURS]
    ),
    // Closing the day refuses while orders are open, so these can only be
    // left over from before that rule — or from a day closed some other way.
    // Either way the table shows as occupied and the money is unaccounted for.
    pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(o.total_amount), 0) AS value,
              COALESCE(array_agg(o.id ORDER BY o.id) FILTER (WHERE o.id IS NOT NULL), '{}') AS ids,
              MIN(bd.business_date)::text AS oldest_date,
              MAX(bd.closed_at) AS since
       FROM orders o
       JOIN business_days bd ON bd.id = o.business_day_id
       WHERE o.restaurant_id = $1 AND o.order_status = 'open' AND bd.day_status = 'closed'`,
      [restaurantId]
    ),
  ]);

  const alerts = [];
  const rows = named.rows;

  for (const row of rows) {
    const waited = minutesBetween(row.billed_at, now);
    const severity = waited >= UNPAID_CRITICAL_MINUTES ? "critical" : "warning";
    const due = Number(row.total_amount) - Number(row.paid_amount);
    const partial = row.bill_status === "partial";

    alerts.push({
      // The severity is part of the id: crossing three hours is a new
      // situation, so a bill read at the one-hour mark comes back unread.
      id: `bills:unpaid:${row.id}:${severity}`,
      severity,
      title: partial
        ? `${who(row)} still owes ${money(due)} of ${money(row.total_amount)}`
        : `${who(row)} has not paid ${money(due)}`,
      detail: [
        row.bill_number,
        billedAgo(row.billed_at, waited, timezone, today),
        partial ? `${money(row.paid_amount)} paid so far` : null,
        row.customer_name,
      ]
        .filter(Boolean)
        .join(" · "),
      link: `/bills?status=${row.bill_status}`,
      category: "Billing",
      at: new Date(
        new Date(row.billed_at).getTime() +
          (severity === "critical" ? UNPAID_CRITICAL_MINUTES : UNPAID_WARNING_MINUTES) * 60000
      ).toISOString(),
    });
  }

  const others = rest.rows[0];

  if (others && others.count > 0) {
    const namedDue = rows.reduce((sum, row) => sum + Number(row.total_amount) - Number(row.paid_amount), 0);
    const totalCount = rows.length + others.count;
    const totalDue = namedDue + Number(others.due);
    const oldestWait = minutesBetween(others.oldest, now);
    const severity = oldestWait >= UNPAID_CRITICAL_MINUTES ? "critical" : "warning";

    alerts.push({
      // One id per severity, with the bills behind it as members: paying
      // one of them leaves this read, a new bill passing the hour does not.
      id: `bills:unpaid-more:${severity}`,
      members: others.ids,
      severity,
      title: `${plural(others.count, "more bill", "more bills")} unpaid for over an hour — ${money(others.due)} due`,
      detail: `${plural(totalCount, "bill", "bills")} and ${money(totalDue)} outstanding in all · the oldest of these billed ${duration(
        oldestWait
      )} ago`,
      link: "/bills?status=unpaid",
      category: "Billing",
      at: new Date(
        new Date(others.oldest).getTime() +
          (severity === "critical" ? UNPAID_CRITICAL_MINUTES : UNPAID_WARNING_MINUTES) * 60000
      ).toISOString(),
    });
  }

  const carried = dues.rows[0];

  if (carried && carried.count > 0) {
    alerts.push({
      // A new due carried makes this worth reading again; one being
      // collected does not.
      id: "bills:dues",
      members: carried.ids,
      severity: "info",
      title: `${money(carried.due)} in dues carried from earlier days`,
      detail: `${plural(carried.count, "bill", "bills")} · oldest from ${dateLabel(
        carried.oldest_date
      )} · collect when the guest next visits`,
      link: "/bills?status=unpaid",
      category: "Billing",
      // Became a due when the day it belonged to was closed.
      at: new Date(carried.since || now).toISOString(),
    });
  }

  const stranded = strandedOrders.rows[0];

  if (stranded && stranded.count > 0) {
    alerts.push({
      id: "bills:stranded",
      members: stranded.ids,
      severity: "critical",
      title: `${plural(stranded.count, "order is", "orders are")} still open on a closed day`,
      detail: `${money(stranded.value)} not billed · oldest from ${dateLabel(
        stranded.oldest_date
      )} · bill or cancel ${stranded.count === 1 ? "it" : "them"} so the table frees up`,
      link: "/orders?status=open",
      category: "Billing",
      at: new Date(stranded.since || now).toISOString(),
    });
  }

  return alerts;
}

module.exports = {
  key: "bills",
  permission: "payments.manage",

  collect: (context) => collectAlerts(completeContext(context)),
};
