const pool = require("../../../config/database");

// The platform console: every restaurant on the platform, at a glance.
//
// Only what a platform operator needs to run accounts: name, code, status,
// how many outlets and logins, when someone last did anything. Never a
// restaurant's bills, guests or sales.

const findRestaurants = async (filters) => {
  const result = await pool.query(
    `SELECT r.id, r.name, r.code, r.status, r.contact, r.email, r.created_at,
            (SELECT COUNT(*)::int FROM outlets o WHERE o.restaurant_id = r.id) AS outlets,
            (SELECT COUNT(*)::int FROM users u WHERE u.restaurant_id = r.id AND u.status = 'active') AS active_users,
            (SELECT COUNT(*)::int FROM users u WHERE u.restaurant_id = r.id) AS users,
            GREATEST(
              (SELECT MAX(s.created_at) FROM user_sign_ins s WHERE s.restaurant_id = r.id),
              (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.restaurant_id = r.id)
            ) AS last_activity,
            COUNT(*) OVER () AS total
     FROM restaurants r
     WHERE ($1::text IS NULL OR r.status = $1)
       AND ($2::text IS NULL OR r.name ILIKE '%' || $2 || '%' OR r.code ILIKE '%' || $2 || '%')
     ORDER BY r.status, last_activity DESC NULLS LAST, r.id DESC
     LIMIT $3 OFFSET $4`,
    [filters.status || null, filters.search || null, filters.limit, filters.offset]
  );

  return result.rows;
};

const countByStatus = async () => {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
            COUNT(*) FILTER (WHERE status <> 'active')::int AS inactive,
            COUNT(*)::int AS total
     FROM restaurants`
  );

  return result.rows[0];
};

const findRestaurant = async (id) => {
  const result = await pool.query("SELECT id, name, code, status FROM restaurants WHERE id = $1", [id]);
  return result.rows[0] || null;
};

const setStatus = async (id, status, userId) => {
  const result = await pool.query(
    "UPDATE restaurants SET status = $2, updated_by = $3 WHERE id = $1 RETURNING id, name, code, status",
    [id, status, userId]
  );

  return result.rows[0] || null;
};

// A restaurant's admins: active logins whose roles let them manage both
// users and roles (the people who run that restaurant's access).
const findAdmins = async (restaurantId) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u.mobile, u.status, u.last_login_at, u.login_locked_until
     FROM users u
     WHERE u.restaurant_id = $1
       AND (SELECT COUNT(DISTINCT p.code)
            FROM user_roles ur
            JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
            JOIN role_permissions rp ON rp.role_id = ro.id
            JOIN permissions p ON p.id = rp.permission_id
            WHERE ur.user_id = u.id AND p.code IN ('users.manage', 'roles.manage')) = 2
     ORDER BY u.status, u.name`,
    [restaurantId]
  );

  return result.rows;
};

// A new password for a restaurant's admin: every session of theirs ends and
// any lockout is lifted.
const resetPassword = async (restaurantId, userId, passwordHash, byUserId) => {
  const result = await pool.query(
    `UPDATE users
     SET password_hash = $3, updated_by = $4, token_version = token_version + 1,
         failed_login_count = 0, first_failed_login_at = NULL, login_locked_until = NULL
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, name, email`,
    [restaurantId, userId, passwordHash, byUserId]
  );

  return result.rows[0] || null;
};

module.exports = {
  findRestaurants,
  countByStatus,
  findRestaurant,
  setStatus,
  findAdmins,
  resetPassword,
};
