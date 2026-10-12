const pool = require("../../../../config/database");

// A read mark older than this is forgotten. An alert still showing after a
// month is a standing condition, and if it is still true it is worth seeing
// again rather than sitting silently "read" forever.
const KEEP_DAYS = 30;

// The most read marks one person keeps in one restaurant. Marks are only
// written for alerts that are live, and dropped when those end, so a real
// person never gets near this; it is a ceiling, not a working limit.
const KEEP_PER_USER = 2000;

// What every provider needs to know about the restaurant, in one round trip.
//
// Deliberately a plain SELECT. restaurantRepository.findSettings creates the
// settings row on demand with an upsert, which also bumps updated_at — fine
// for a settings screen, wrong for something that runs every 30 seconds from
// every open tab.
const findContext = async (restaurantId) => {
  const result = await pool.query(
    `SELECT rs.timezone, rs.currency_symbol,
            bd.business_date AS open_business_date
     FROM restaurants r
     LEFT JOIN restaurant_settings rs ON rs.restaurant_id = r.id
     LEFT JOIN LATERAL (
       SELECT business_date FROM business_days
       WHERE restaurant_id = r.id AND day_status = 'open'
       ORDER BY opened_at
       LIMIT 1
     ) bd ON TRUE
     WHERE r.id = $1`,
    [restaurantId]
  );

  return result.rows[0] || null;
};

// This person's read marks among these alerts: { alert_id, seen_members }.
const findReads = async (restaurantId, userId, alertIds) => {
  if (alertIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT alert_id, seen_members FROM notification_reads
     WHERE restaurant_id = $1 AND user_id = $2 AND alert_id = ANY($3::text[])`,
    [restaurantId, userId, alertIds]
  );

  return result.rows;
};

// `marks` is [{ id, members }], members being the rows behind a summary alert
// at the moment it was read (null for an ordinary alert).
//
// Upsert, so marking something read twice just moves its read time on — and
// for a summary, takes in whatever it holds now.
const markRead = async (restaurantId, userId, marks) => {
  if (marks.length === 0) {
    return 0;
  }

  // Members travel as one JSON text per alert: a text[] of text[] would have
  // to be rectangular, and summaries differ in size.
  const result = await pool.query(
    `INSERT INTO notification_reads (restaurant_id, user_id, alert_id, seen_members)
     SELECT $1, $2, mark.id,
            CASE WHEN mark.members IS NULL THEN NULL
                 ELSE ARRAY(SELECT jsonb_array_elements_text(mark.members::jsonb)) END
     FROM UNNEST($3::text[], $4::text[]) AS mark(id, members)
     ON CONFLICT (restaurant_id, user_id, alert_id)
     DO UPDATE SET read_at = NOW(), seen_members = EXCLUDED.seen_members`,
    [
      restaurantId,
      userId,
      marks.map((mark) => mark.id),
      marks.map((mark) => (mark.members ? JSON.stringify(mark.members) : null)),
    ]
  );

  return result.rowCount;
};

// A summary that is still read but now stands for fewer rows remembers only
// those, so a row that was fixed and then goes wrong again is news. Also
// fills in a summary read before its members were known.
const rememberMembers = async (restaurantId, userId, updates) => {
  if (updates.length === 0) {
    return 0;
  }

  const result = await pool.query(
    `UPDATE notification_reads nr
     SET seen_members = ARRAY(SELECT jsonb_array_elements_text(u.members::jsonb))
     FROM UNNEST($3::text[], $4::text[]) AS u(id, members)
     WHERE nr.restaurant_id = $1 AND nr.user_id = $2 AND nr.alert_id = u.id`,
    [
      restaurantId,
      userId,
      updates.map((update) => update.id),
      updates.map((update) => JSON.stringify(update.members)),
    ]
  );

  return result.rowCount;
};

const markUnread = async (restaurantId, userId, alertIds) => {
  const result = await pool.query(
    `DELETE FROM notification_reads
     WHERE restaurant_id = $1 AND user_id = $2 AND alert_id = ANY($3::text[])`,
    [restaurantId, userId, alertIds]
  );

  return result.rowCount;
};

// Once an alert has ended, its read mark is dropped. Otherwise the same
// condition coming back later — the paneer running out again next week —
// would reuse the old id and arrive already "read".
//
// Only for providers that answered this time (`keys`): a provider that timed
// out has not said its alerts ended, it has said nothing, and forgetting its
// marks would make everything it shows unread again when it recovers.
const forgetEnded = async (restaurantId, userId, keys, liveIds) => {
  if (keys.length === 0) {
    return 0;
  }

  const result = await pool.query(
    `DELETE FROM notification_reads
     WHERE restaurant_id = $1 AND user_id = $2
       AND split_part(alert_id, ':', 1) = ANY($3::text[])
       AND NOT (alert_id = ANY($4::text[]))`,
    [restaurantId, userId, keys, liveIds]
  );

  return result.rowCount;
};

// Keeps the table small without a scheduled job: every write tidies up after
// the person making it — marks past a month, and anything past the newest
// KEEP_PER_USER.
const pruneOld = async (restaurantId, userId) => {
  const result = await pool.query(
    `DELETE FROM notification_reads
     WHERE restaurant_id = $1 AND user_id = $2
       AND (read_at < NOW() - make_interval(days => $3)
            OR id IN (SELECT id FROM notification_reads
                      WHERE restaurant_id = $1 AND user_id = $2
                      ORDER BY read_at DESC, id DESC
                      OFFSET $4))`,
    [restaurantId, userId, KEEP_DAYS, KEEP_PER_USER]
  );

  return result.rowCount;
};

module.exports = {
  KEEP_DAYS,
  KEEP_PER_USER,
  findContext,
  findReads,
  markRead,
  rememberMembers,
  markUnread,
  forgetEnded,
  pruneOld,
};
