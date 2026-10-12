// The service desk's own settings (migration 1790960000001 and later):
// token numbers, the collection screen, and the other switches of the
// service lane. One row per restaurant, made on first read.
const pool = require("../../../../config/database");

const find = async (restaurantId, db = pool) => {
  const result = await db.query(
    `INSERT INTO service_settings (restaurant_id)
     VALUES ($1)
     ON CONFLICT (restaurant_id) DO UPDATE SET restaurant_id = EXCLUDED.restaurant_id
     RETURNING *`,
    [restaurantId]
  );

  return result.rows[0];
};

// Writes only the columns given ({ column: value }); the names come from the
// service's own list, never from a request.
const update = async (restaurantId, columns, userId) => {
  await find(restaurantId);

  const names = Object.keys(columns);

  if (names.length === 0) {
    return find(restaurantId);
  }

  const values = [restaurantId, userId, ...names.map((name) => columns[name])];
  const sets = names.map((name, index) => `${name} = $${index + 3}`);
  const result = await pool.query(
    `UPDATE service_settings SET ${sets.join(", ")}, updated_by = $2, updated_at = NOW()
     WHERE restaurant_id = $1
     RETURNING *`,
    values
  );

  return result.rows[0];
};

module.exports = { find, update };
