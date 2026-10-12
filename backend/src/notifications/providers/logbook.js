// The shift log book: follow-ups still open. A gas leak noted at 11 pm, a
// guest promised a call back, a freezer the technician has not seen yet —
// each stays in the bell until someone closes it in the log book.
//
// One summary alert with a count, never the entries' words: the bell is
// worked out per restaurant, and staff tied to one outlet must not read
// another outlet's notes here. The log book itself shows each person only
// what they may see.
const STALE_HOURS = 24;

module.exports = {
  key: "logbook",
  label: "Log book",
  permission: "logbook.view",

  collect: async ({ restaurantId, now, pool }) => {
    try {
      const result = await pool.query(
        `SELECT id, created_at
         FROM logbook_entries
         WHERE restaurant_id = $1 AND needs_follow_up AND closed_at IS NULL
         ORDER BY created_at
         LIMIT 200`,
        [restaurantId]
      );

      if (result.rows.length === 0) {
        return [];
      }

      const oldest = new Date(result.rows[0].created_at);
      const hoursOpen = Math.floor((now - oldest) / 3600000);
      const count = result.rows.length;

      return [
        {
          id: "logbook:follow-ups",
          severity: hoursOpen >= STALE_HOURS ? "warning" : "info",
          title: `${count} log book follow-up${count === 1 ? "" : "s"} still open`,
          detail:
            hoursOpen >= STALE_HOURS
              ? `The oldest has waited ${hoursOpen >= 48 ? `${Math.floor(hoursOpen / 24)} days` : `${hoursOpen} hours`}`
              : "Close each one in the log book once it is dealt with",
          link: "/logbook?open=1",
          category: "Log book",
          at: oldest.toISOString(),
          members: result.rows.map((row) => `logbook_entry:${row.id}`),
        },
      ];
    } catch (error) {
      console.error("logbook notifications:", error.message);
      return [];
    }
  },
};
