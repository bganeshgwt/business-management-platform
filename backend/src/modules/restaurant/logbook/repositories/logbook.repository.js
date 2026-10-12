const pool = require("../../../../config/database");

// The shift log book: entries, who has read them, and open follow-ups.
//
// `seenBy` is the person asking: staff tied to one outlet see that outlet's
// entries and the ones for the whole restaurant, never another outlet's.

const ENTRY_COLUMNS = `le.id, le.outlet_id, o.name AS outlet_name, le.category, le.body, le.table_id,
  COALESCE(dt.table_no, le.table_label) AS table_label, le.shift_label, le.business_date::text AS business_date,
  le.needs_follow_up, le.closed_at, le.close_note, cb.name AS closed_by_name, le.created_at, le.created_by,
  wb.name AS created_by_name,
  COALESCE((SELECT json_agg(json_build_object('userId', r.user_id, 'name', ru.name, 'readAt', r.read_at)
                            ORDER BY r.read_at)
            FROM logbook_reads r JOIN users ru ON ru.id = r.user_id
            WHERE r.entry_id = le.id), '[]'::json) AS read_by`;

const ENTRY_JOINS = `LEFT JOIN outlets o ON o.id = le.outlet_id
  LEFT JOIN dining_tables dt ON dt.id = le.table_id
  LEFT JOIN users cb ON cb.id = le.closed_by
  LEFT JOIN users wb ON wb.id = le.created_by`;

// Who may see an entry: $2 is the pinned outlet (NULL for the unpinned).
const VISIBLE = `($2::bigint IS NULL OR le.outlet_id IS NULL OR le.outlet_id = $2::bigint)`;

const findEntries = async (restaurantId, seenBy, filters) => {
  const result = await pool.query(
    `SELECT ${ENTRY_COLUMNS},
            EXISTS (SELECT 1 FROM logbook_reads r WHERE r.entry_id = le.id AND r.user_id = $3) AS read_by_me,
            COUNT(*) OVER () AS total
     FROM logbook_entries le
     ${ENTRY_JOINS}
     WHERE le.restaurant_id = $1 AND ${VISIBLE}
       AND ($4::date IS NULL OR le.business_date >= $4::date)
       AND ($5::date IS NULL OR le.business_date <= $5::date)
       AND ($6::bigint IS NULL OR le.outlet_id = $6::bigint)
       AND ($7::text IS NULL OR le.category = $7)
       AND ($8::text IS NULL OR le.body ILIKE '%' || $8 || '%')
       AND ($9::boolean = FALSE OR (le.needs_follow_up AND le.closed_at IS NULL))
     ORDER BY (le.needs_follow_up AND le.closed_at IS NULL) DESC, le.created_at DESC, le.id DESC
     LIMIT $10 OFFSET $11`,
    [
      restaurantId,
      seenBy.outletId || null,
      seenBy.userId,
      filters.from || null,
      filters.to || null,
      filters.outletId || null,
      filters.category || null,
      filters.search || null,
      Boolean(filters.openOnly),
      filters.limit,
      filters.offset,
    ]
  );

  return result.rows;
};

const findEntryById = async (restaurantId, seenBy, id) => {
  const result = await pool.query(
    `SELECT ${ENTRY_COLUMNS},
            EXISTS (SELECT 1 FROM logbook_reads r WHERE r.entry_id = le.id AND r.user_id = $3) AS read_by_me
     FROM logbook_entries le
     ${ENTRY_JOINS}
     WHERE le.restaurant_id = $1 AND ${VISIBLE} AND le.id = $4`,
    [restaurantId, seenBy.outletId || null, seenBy.userId, id]
  );

  return result.rows[0] || null;
};

const createEntry = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO logbook_entries (restaurant_id, outlet_id, category, body, table_id, table_label, shift_label,
                                  business_date, needs_follow_up, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING id`,
    [
      restaurantId,
      data.outletId,
      data.category,
      data.body,
      data.tableId,
      data.tableLabel,
      data.shiftLabel,
      data.businessDate,
      data.needsFollowUp,
      userId,
    ]
  );

  return result.rows[0].id;
};

// Closing a follow-up: only an open one, in one statement, so two managers
// closing it together leave one name on it.
const closeEntry = async (restaurantId, id, note, userId) => {
  const result = await pool.query(
    `UPDATE logbook_entries
     SET closed_at = NOW(), closed_by = $3, close_note = $4, updated_by = $3
     WHERE restaurant_id = $1 AND id = $2 AND needs_follow_up AND closed_at IS NULL
     RETURNING id`,
    [restaurantId, id, userId, note]
  );

  return result.rows.length > 0;
};

// Marks entries read by this person (their own are read by writing them).
const markRead = async (restaurantId, seenBy, ids) => {
  if (!ids.length) {
    return 0;
  }

  const result = await pool.query(
    `INSERT INTO logbook_reads (entry_id, user_id, restaurant_id)
     SELECT le.id, $3, le.restaurant_id
     FROM logbook_entries le
     WHERE le.restaurant_id = $1 AND ${VISIBLE} AND le.id = ANY($4::bigint[])
     ON CONFLICT DO NOTHING
     RETURNING entry_id`,
    [restaurantId, seenBy.outletId || null, seenBy.userId, ids]
  );

  return result.rows.length;
};

// What a person coming on shift has not read yet: entries from the last
// `days` days written by someone else.
const findUnread = async (restaurantId, seenBy, days = 7) => {
  const result = await pool.query(
    `SELECT ${ENTRY_COLUMNS}, FALSE AS read_by_me
     FROM logbook_entries le
     ${ENTRY_JOINS}
     WHERE le.restaurant_id = $1 AND ${VISIBLE}
       AND le.created_by <> $3
       AND le.created_at > NOW() - make_interval(days => $4)
       AND NOT EXISTS (SELECT 1 FROM logbook_reads r WHERE r.entry_id = le.id AND r.user_id = $3)
     ORDER BY le.created_at DESC, le.id DESC
     LIMIT 50`,
    [restaurantId, seenBy.outletId || null, seenBy.userId, days]
  );

  return result.rows;
};

const findOpenFollowUps = async (restaurantId, seenBy, limit = 20) => {
  const result = await pool.query(
    `SELECT ${ENTRY_COLUMNS},
            EXISTS (SELECT 1 FROM logbook_reads r WHERE r.entry_id = le.id AND r.user_id = $3) AS read_by_me,
            COUNT(*) OVER () AS total
     FROM logbook_entries le
     ${ENTRY_JOINS}
     WHERE le.restaurant_id = $1 AND ${VISIBLE} AND le.needs_follow_up AND le.closed_at IS NULL
     ORDER BY le.created_at
     LIMIT $4`,
    [restaurantId, seenBy.outletId || null, seenBy.userId, limit]
  );

  return result.rows;
};

// The table an entry names, if it is this restaurant's.
const findTable = async (restaurantId, tableId) => {
  const result = await pool.query(
    "SELECT id, table_no, outlet_id FROM dining_tables WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, tableId]
  );

  return result.rows[0] || null;
};

// The writer's rostered shift for the day, when they are an employee with one.
const findRosterShift = async (restaurantId, userId, date) => {
  const result = await pool.query(
    `SELECT s.name, s.start_time::text AS start_time, s.end_time::text AS end_time
     FROM employees e
     JOIN shift_assignments sa ON sa.employee_id = e.id AND sa.work_date = $3::date
                              AND sa.assignment_status = 'scheduled'
     JOIN shifts s ON s.id = sa.shift_id
     WHERE e.restaurant_id = $1 AND e.user_id = $2`,
    [restaurantId, userId, date]
  );

  return result.rows[0] || null;
};

const findActiveShifts = async (restaurantId) => {
  const result = await pool.query(
    `SELECT name, start_time::text AS start_time, end_time::text AS end_time
     FROM shifts WHERE restaurant_id = $1 AND status = 'active'
     ORDER BY start_time`,
    [restaurantId]
  );

  return result.rows;
};

module.exports = {
  findEntries,
  findEntryById,
  createEntry,
  closeEntry,
  markRead,
  findUnread,
  findOpenFollowUps,
  findTable,
  findRosterShift,
  findActiveShifts,
};
