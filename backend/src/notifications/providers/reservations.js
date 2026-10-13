// The host stand's alerts: who is about to walk in, who has not, and who has
// been standing at the door longer than they were promised.
//
// Everything is worked out on the restaurant's own clock (`timezone`), because
// bookings are kept as local wall-clock times.
const { WAITLIST_GRACE_MINUTES } = require("../../modules/restaurant/reservations/repositories/reservation.repository");
const ruleSettings = require("../../modules/restaurant/setup/services/ruleSettings.service");

const ARRIVING_WITHIN_MINUTES = 30;
// When a booking counts as late is the restaurant's own (Settings -> Alerts
// and timings, reservationLateMinutes), the same line the host stand uses.
// Past this, a booking nobody resolved is history for the day-end, not
// something to ring a bell about every time the bell polls. A late booking
// also stops ringing once its whole booked slot has gone by: by then the
// table has been turned, and the page lists it for marking as a no-show.
const LATE_WINDOW_MINUTES = 180;

const timeLabel = (hhmm) => {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const suffix = hours < 12 ? "am" : "pm";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return `${twelve}:${String(minutes).padStart(2, "0")}${suffix}`;
};

const bookingDetail = (row) =>
  [row.guest_name, row.table_no ? `table ${row.table_no}` : "no table yet", row.guest_mobile]
    .filter(Boolean)
    .join(" · ");

module.exports = {
  key: "reservations",
  permission: "reservations.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "reservations",

  // Never throws: a failed query costs this module its alerts for one poll,
  // not everyone's bell.
  collect: async (context) => {
    try {
      return await collectAlerts(context);
    } catch (error) {
      console.error("Reservations alerts failed:", error.message);
      return [];
    }
  },
};

async function collectAlerts({ restaurantId, timezone, now, pool }) {
  const zone = timezone || "Asia/Kolkata";
  const at = now instanceof Date ? now : new Date();
  const lateAfterMinutes = (await ruleSettings.load(restaurantId, pool)).reservationLateMinutes;

  // Both queries read only today's live bookings and the live queue — both
  // indexed and small — so this is safe to run on every poll.
  const [bookings, waiting] = await Promise.all([
    pool.query(
      `WITH clock AS (SELECT ($2::timestamptz AT TIME ZONE $3::text) AS local_now)
       SELECT r.id, r.guest_name, r.guest_mobile, r.party_size, r.status,
              to_char(r.start_time, 'HH24:MI') AS start_time, r.reservation_date,
              t.table_no,
              (r.starts_at AT TIME ZONE $3::text) AS starts_at_utc,
              ROUND(EXTRACT(EPOCH FROM (r.starts_at - clock.local_now)) / 60)::int AS minutes_until
       FROM reservations r
       CROSS JOIN clock
       LEFT JOIN dining_tables t ON t.id = r.table_id
       WHERE r.restaurant_id = $1
         AND r.status IN ('booked', 'confirmed')
         AND r.reservation_date = clock.local_now::date
         AND r.starts_at BETWEEN clock.local_now - make_interval(mins => $5)
                             AND clock.local_now + make_interval(mins => $4)
         AND r.ends_at > clock.local_now
       ORDER BY r.starts_at`,
      [restaurantId, at.toISOString(), zone, ARRIVING_WITHIN_MINUTES, LATE_WINDOW_MINUTES]
    ),
    // Past their quote, but not so far past it that the entry is plainly one
    // the host forgot to close (the page lists those apart, quietly).
    pool.query(
      `SELECT w.id, w.guest_name, w.party_size, w.quoted_minutes, w.joined_at, w.notified_at,
              ROUND(EXTRACT(EPOCH FROM ($2::timestamptz - w.joined_at)) / 60)::int AS waited
       FROM waitlist_entries w
       WHERE w.restaurant_id = $1
         AND w.status = 'waiting'
         AND w.joined_at + make_interval(mins => w.quoted_minutes) < $2::timestamptz
         AND w.joined_at + make_interval(mins => w.quoted_minutes + $3::int) > $2::timestamptz
       ORDER BY w.joined_at`,
      [restaurantId, at.toISOString(), WAITLIST_GRACE_MINUTES]
    ),
  ]);

  const alerts = [];

  for (const row of bookings.rows) {
    const link = `/reservations?date=${row.reservation_date}&booking=${row.id}`;
    const party = `${row.party_size} ${row.party_size === 1 ? "guest" : "guests"}`;

    if (row.minutes_until >= 0) {
      alerts.push({
        id: `reservations:arriving:${row.id}`,
        severity: "info",
        title: `${row.guest_name}, ${party}, arriving at ${timeLabel(row.start_time)}`,
        detail: `${bookingDetail(row)} · ${row.status === "confirmed" ? "confirmed" : "not yet confirmed"}`,
        link,
        category: "Reservations",
        // Became worth knowing half an hour before they are due.
        at: new Date(new Date(row.starts_at_utc).getTime() - ARRIVING_WITHIN_MINUTES * 60000).toISOString(),
      });
    } else if (-row.minutes_until >= lateAfterMinutes) {
      alerts.push({
        // Its own id, apart from the arriving one, so having read "arriving at
        // 7:30" does not silence "20 min late" for the same guest.
        id: `reservations:late:${row.id}`,
        severity: "warning",
        title: `${row.guest_name} is ${-row.minutes_until} min late — possible no-show`,
        detail: `${party} booked for ${timeLabel(row.start_time)} · ${bookingDetail(row)}`,
        link,
        category: "Reservations",
        at: new Date(new Date(row.starts_at_utc).getTime() + lateAfterMinutes * 60000).toISOString(),
      });
    }
  }

  for (const row of waiting.rows) {
    const promised = new Date(new Date(row.joined_at).getTime() + row.quoted_minutes * 60000);

    alerts.push({
      id: `reservations:waitlist:${row.id}`,
      severity: "warning",
      title: `${row.guest_name} (${row.party_size}) has waited ${row.waited} min — quoted ${row.quoted_minutes}`,
      detail: row.notified_at
        ? "Told their table is ready, still not seated"
        : "Walk-in waitlist · seat them or give an update",
      link: "/reservations",
      category: "Reservations",
      at: promised.toISOString(),
    });
  }

  return alerts;
}
