const pool = require("../../../../config/database");

// Owner-named payment types under a method (sweep SW-B-18): Pluxee and
// Sodexo meal cards or a cheque under Other, PhonePe under UPI. Every query
// is filtered by restaurant_id.

const COLUMNS = `pt.id, pt.payment_method, pt.name, pt.needs_reference, pt.status, pt.sort_order,
                 pt.created_at, pt.updated_at`;

// With how often each was used, so the screen can say "used on 214 payments"
// (and why it is switched off rather than deleted).
const findAll = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM payments p WHERE p.payment_type_id = pt.id)::int AS used_count
     FROM payment_types pt
     WHERE pt.restaurant_id = $1
     ORDER BY pt.status = 'active' DESC, pt.payment_method, pt.sort_order, pt.name`,
    [restaurantId]
  );

  return result.rows;
};

const findById = async (restaurantId, id, db = pool) => {
  const result = await db.query(`SELECT ${COLUMNS} FROM payment_types pt WHERE pt.restaurant_id = $1 AND pt.id = $2`, [
    restaurantId,
    id,
  ]);

  return result.rows[0] || null;
};

const findByName = async (restaurantId, method, name, exceptId = null) => {
  const result = await pool.query(
    `SELECT id FROM payment_types
     WHERE restaurant_id = $1 AND payment_method = $2 AND UPPER(BTRIM(name)) = UPPER(BTRIM($3))
       AND ($4::bigint IS NULL OR id <> $4)`,
    [restaurantId, method, name, exceptId]
  );

  return result.rows[0] || null;
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO payment_types (restaurant_id, payment_method, name, needs_reference, status, sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING id`,
    [restaurantId, data.paymentMethod, data.name, data.needsReference, data.status, data.sortOrder, userId]
  );

  return findById(restaurantId, result.rows[0].id);
};

// The method a type sits under never changes once it exists: payments taken
// with it are filed under that method, and moving it would move them.
const update = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE payment_types
     SET name = $3, needs_reference = $4, status = $5, sort_order = $6, updated_by = $7
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, data.name, data.needsReference, data.status, data.sortOrder, userId]
  );

  return result.rows[0] ? findById(restaurantId, id) : null;
};

const countUses = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT (SELECT COUNT(*) FROM payments WHERE restaurant_id = $1 AND payment_type_id = $2)::int
          + (SELECT COUNT(*) FROM refunds WHERE restaurant_id = $1 AND payment_type_id = $2)::int
          + (SELECT COUNT(*) FROM customer_advances WHERE restaurant_id = $1 AND payment_type_id = $2)::int AS uses`,
    [restaurantId, id]
  );

  return result.rows[0].uses;
};

const remove = async (restaurantId, id) => {
  const result = await pool.query("DELETE FROM payment_types WHERE restaurant_id = $1 AND id = $2 RETURNING id", [
    restaurantId,
    id,
  ]);

  return result.rows[0] || null;
};

module.exports = { findAll, findById, findByName, create, update, countUses, remove };
