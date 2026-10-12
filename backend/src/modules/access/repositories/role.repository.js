const pool = require("../../../config/database");

// Permissions and users are counted in their own subqueries. Joining both in
// one query multiplied every permission by every user holding the role (a
// Captain showed 609 permissions for 7), and counted users from every
// restaurant on the platform against a shared system role.
const ROLE_COLUMNS = `
  r.id, r.code, r.name, r.description, r.is_system, r.status, r.restaurant_id,
  COALESCE((SELECT ARRAY_AGG(DISTINCT p.code ORDER BY p.code)
            FROM role_permissions rp
            JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = r.id), '{}') AS permissions,
  (SELECT COUNT(DISTINCT ur.user_id)::int
   FROM user_roles ur
   JOIN users u ON u.id = ur.user_id AND u.restaurant_id = $1
   WHERE ur.role_id = r.id) AS user_count`;

// What a restaurant may see and use: the shared system roles
// (restaurant_id IS NULL) except the platform owner's, plus its own. The
// platform owner's role runs the whole platform; it is never shown, copied or
// handed out from inside a restaurant.
const VISIBLE_TO_RESTAURANT = `((r.restaurant_id IS NULL AND r.code <> 'SUPER_ADMIN') OR r.restaurant_id = $1)`;

const findAll = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ${ROLE_COLUMNS}
     FROM roles r
     WHERE ${VISIBLE_TO_RESTAURANT}
     ORDER BY r.is_system DESC, r.name`,
    [restaurantId]
  );

  return result.rows;
};

const findById = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${ROLE_COLUMNS}
     FROM roles r
     WHERE ${VISIBLE_TO_RESTAURANT} AND r.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Used when assigning roles to a user: only ids the restaurant is allowed to use.
const findAssignableIds = async (restaurantId, roleIds) => {
  const result = await pool.query(
    `SELECT id FROM roles
     WHERE id = ANY($2::bigint[])
       AND status = 'active'
       AND (restaurant_id = $1 OR (restaurant_id IS NULL AND code <> 'SUPER_ADMIN'))`,
    [restaurantId, roleIds]
  );

  return result.rows.map((row) => row.id);
};

const findAllPermissions = async () => {
  const result = await pool.query(
    "SELECT id, code, module, name FROM permissions ORDER BY module, code"
  );

  return result.rows;
};

// Custom roles get the restaurant's own id, so they never leak to other restaurants.
const create = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO roles (restaurant_id, code, name, description, is_system, created_by, updated_by)
       VALUES ($1, $2, $3, $4, FALSE, $5, $5)
       RETURNING id`,
      [restaurantId, data.code, data.name, data.description, userId]
    );

    const newId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, created_by)
       SELECT $1, id, $3 FROM permissions WHERE code = ANY($2::varchar[])`,
      [newId, data.permissions, userId]
    );

    await client.query("COMMIT");
    return await findById(restaurantId, newId, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Every change that can take someone's access away (editing or switching off
// a role, changing a person's roles or status) takes this lock first, for the
// whole restaurant, until its transaction ends. Two such changes therefore run
// one after the other, and the "is there still an admin" check that ends each
// one sees what the other did — two admins demoting each other at the same
// moment can no longer both succeed and leave the restaurant with nobody.
const lockAccess = (client, restaurantId) =>
  client.query("SELECT pg_advisory_xact_lock(hashtext('access-admins'), $1::int)", [restaurantId]);

// `assertAfter(client)` runs inside the transaction once the change is made
// and may throw to undo it — used to keep at least one admin in the restaurant.
const update = async (restaurantId, id, data, userId, assertAfter = null) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await lockAccess(client, restaurantId);

    const updated = await client.query(
      `UPDATE roles
       SET name = $3, description = $4, status = $5, updated_by = $6
       WHERE restaurant_id = $1 AND id = $2 AND is_system = FALSE
       RETURNING id`,
      [restaurantId, id, data.name, data.description, data.status, userId]
    );

    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [id]);
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, created_by)
       SELECT $1, id, $3 FROM permissions WHERE code = ANY($2::varchar[])`,
      [id, data.permissions, userId]
    );

    if (assertAfter) {
      await assertAfter(client);
    }

    await client.query("COMMIT");
    return await findById(restaurantId, id, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Users of THIS restaurant holding the role, when a restaurant is given. A
// shared system role is held by people in every restaurant, and those are no
// business of this one.
const countUsers = async (roleId, restaurantId = null) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     WHERE ur.role_id = $1 AND ($2::bigint IS NULL OR u.restaurant_id = $2)`,
    [roleId, restaurantId]
  );

  return result.rows[0].count;
};

// After copying a built-in role, the restaurant's own people can be moved onto
// the copy in one go, so trimming the copy actually changes what they can do.
// Returns the ids of the people moved.
const moveUsers = async (restaurantId, fromRoleId, toRoleId, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const moved = await client.query(
      `SELECT ur.user_id
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id AND u.restaurant_id = $1
       WHERE ur.role_id = $2`,
      [restaurantId, fromRoleId]
    );
    const ids = moved.rows.map((row) => row.user_id);

    if (ids.length > 0) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, created_by)
         SELECT UNNEST($1::bigint[]), $2, $3
         ON CONFLICT DO NOTHING`,
        [ids, toRoleId, userId]
      );
      await client.query("DELETE FROM user_roles WHERE role_id = $1 AND user_id = ANY($2::bigint[])", [
        fromRoleId,
        ids,
      ]);
    }

    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Active users of the restaurant who, as things stand inside `db` (the pool
// or an open transaction), hold both "manage users" and "manage roles".
const countAdmins = async (db, restaurantId) => {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM users u
     WHERE u.restaurant_id = $1 AND u.status = 'active'
       AND (SELECT COUNT(DISTINCT p.code)
            FROM user_roles ur
            JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
            JOIN role_permissions rp ON rp.role_id = ro.id
            JOIN permissions p ON p.id = rp.permission_id
            WHERE ur.user_id = u.id AND p.code IN ('users.manage', 'roles.manage')) = 2`,
    [restaurantId]
  );

  return result.rows[0].count;
};

// The active people of this restaurant holding a role, each with every
// permission they hold today (from all their roles). Editing a role changes
// what all of them can do, so the editor must be at least as strong as each.
const findHolders = async (restaurantId, roleId) => {
  const result = await pool.query(
    `SELECT u.id, u.name,
            COALESCE((SELECT ARRAY_AGG(DISTINCT p.code)
                      FROM user_roles ur2
                      JOIN roles ro ON ro.id = ur2.role_id AND ro.status = 'active'
                      JOIN role_permissions rp ON rp.role_id = ro.id
                      JOIN permissions p ON p.id = rp.permission_id
                      WHERE ur2.user_id = u.id), '{}') AS permissions
     FROM user_roles ur
     JOIN users u ON u.id = ur.user_id AND u.restaurant_id = $1 AND u.status = 'active'
     WHERE ur.role_id = $2
     ORDER BY u.name`,
    [restaurantId, roleId]
  );

  return result.rows;
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM roles WHERE restaurant_id = $1 AND id = $2 AND is_system = FALSE RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

module.exports = {
  findAll,
  findById,
  findAssignableIds,
  findAllPermissions,
  create,
  update,
  countUsers,
  moveUsers,
  countAdmins,
  lockAccess,
  findHolders,
  remove,
};
