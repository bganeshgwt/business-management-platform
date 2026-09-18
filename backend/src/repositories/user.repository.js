const pool = require("../config/database");

const findByEmail = async (email) => {
  const result = await pool.query(
    `SELECT u.id, u.restaurant_id, u.outlet_id, u.name, u.email, u.password_hash, u.status,
            r.status AS restaurant_status
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE LOWER(u.email) = LOWER($1)`,
    [email]
  );

  return result.rows[0] || null;
};

// Loads a user with their active roles and the permissions those roles grant.
const findProfileById = async (id) => {
  const result = await pool.query(
    `SELECT u.id, u.restaurant_id, u.outlet_id, u.name, u.email, u.mobile, u.status,
            r.name AS restaurant_name, r.status AS restaurant_status,
            COALESCE(ARRAY_AGG(DISTINCT ro.code) FILTER (WHERE ro.code IS NOT NULL), '{}') AS roles,
            COALESCE(ARRAY_AGG(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
     LEFT JOIN role_permissions rp ON rp.role_id = ro.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE u.id = $1
     GROUP BY u.id, r.id`,
    [id]
  );

  return result.rows[0] || null;
};

const updateLastLogin = async (id) => {
  await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [id]);
};

module.exports = {
  findByEmail,
  findProfileById,
  updateLastLogin,
};
