// Captain sections (migration 1791330000003).
const pool = require("../../../../config/database");

const findForDate = async (restaurantId, date, db = pool) => {
  const result = await db.query(
    `SELECT a.id, a.shift_date::text AS shift_date, a.user_id, u.name AS user_name,
            a.floor_id, f.name AS floor_name, a.area_id, ar.name AS area_name,
            a.table_id, t.table_no
     FROM captain_assignments a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN floors f ON f.id = a.floor_id
     LEFT JOIN dining_areas ar ON ar.id = a.area_id
     LEFT JOIN dining_tables t ON t.id = a.table_id
     WHERE a.restaurant_id = $1 AND a.shift_date = $2::date
     ORDER BY u.name, f.name NULLS LAST, ar.name NULLS LAST, t.table_no NULLS LAST`,
    [restaurantId, date]
  );

  return result.rows;
};

// Each table's captain on a date: its own assignment, else its section's,
// else its floor's. { tableId: { userId, userName } }. None while the
// restaurant has Captain sections switched off: the plans are kept, and every
// captain sees every table.
const captainsByTable = async (restaurantId, date) => {
  const result = await pool.query(
    `SELECT t.id AS table_id, pick.user_id, pick.user_name
     FROM dining_tables t
     JOIN LATERAL (
       SELECT a.user_id, u.name AS user_name
       FROM captain_assignments a
       JOIN users u ON u.id = a.user_id
       WHERE a.restaurant_id = $1 AND a.shift_date = $2::date
         AND (a.table_id = t.id OR a.area_id = t.area_id OR a.floor_id = t.floor_id)
       ORDER BY CASE WHEN a.table_id IS NOT NULL THEN 0 WHEN a.area_id IS NOT NULL THEN 1 ELSE 2 END
       LIMIT 1
     ) pick ON TRUE
     WHERE t.restaurant_id = $1
       AND 'captain_sections' = ANY (restaurant_features($1))`,
    [restaurantId, date]
  );

  return new Map(result.rows.map((row) => [Number(row.table_id), { userId: Number(row.user_id), userName: row.user_name }]));
};

// The day's plan replaced in one go (the screen sends the whole plan).
const replaceForDate = async (restaurantId, date, rows, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM captain_assignments WHERE restaurant_id = $1 AND shift_date = $2::date", [restaurantId, date]);

    for (const row of rows) {
      await client.query(
        `INSERT INTO captain_assignments (restaurant_id, shift_date, user_id, floor_id, area_id, table_id, created_by)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7)`,
        [restaurantId, date, row.userId, row.floorId || null, row.areaId || null, row.tableId || null, userId]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// People who can take a section: active staff of this restaurant whose role
// lets them take orders.
const findCaptains = async (restaurantId) => {
  const result = await pool.query(
    `SELECT DISTINCT u.id, u.name, u.outlet_id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id AND p.code = 'orders.create'
     WHERE u.restaurant_id = $1 AND u.status = 'active'
     ORDER BY u.name`,
    [restaurantId]
  );

  return result.rows;
};

module.exports = { findForDate, captainsByTable, replaceForDate, findCaptains };
