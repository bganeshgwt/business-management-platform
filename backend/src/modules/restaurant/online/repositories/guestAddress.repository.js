// A regular guest's saved delivery addresses (sweep SW-A-18; migration
// 1791330000001). Newest used first; at most MAX_ADDRESSES per guest.
const pool = require("../../../../config/database");

// Five covers home, office, a parent's house and a friend's — more and the
// list at the till stops being one glance.
const MAX_ADDRESSES = 5;

const COLUMNS = "a.id, a.customer_id, a.label, a.address, a.landmark, a.last_used_at, a.use_count, a.created_at";

const findForGuest = async (restaurantId, customerId, db = pool) => {
  const result = await db.query(
    `SELECT ${COLUMNS}
     FROM customer_addresses a
     WHERE a.restaurant_id = $1 AND a.customer_id = $2
     ORDER BY a.last_used_at DESC, a.id DESC`,
    [restaurantId, customerId]
  );

  return result.rows;
};

const findOne = async (restaurantId, customerId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM customer_addresses a
     WHERE a.restaurant_id = $1 AND a.customer_id = $2 AND a.id = $3`,
    [restaurantId, customerId, id]
  );

  return result.rows[0] || null;
};

// A saved address used again for a delivery: it moves to the top.
const markUsed = async (db, restaurantId, id) => {
  await db.query(
    `UPDATE customer_addresses SET last_used_at = NOW(), use_count = use_count + 1
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );
};

// The address a delivery went to, kept on the guest. The same text again is
// the same address (used again, its landmark and label kept up to date when
// given); a sixth makes the one used longest ago make way. The guest row is
// locked first, so two tills saving the same guest at once cannot leave six.
const remember = async (db, restaurantId, customerId, { label, address, landmark }, userId) => {
  const text = String(address || "").trim();

  if (!text) {
    return null;
  }

  const guest = await db.query(
    "SELECT id FROM customers WHERE restaurant_id = $1 AND id = $2 AND erased_at IS NULL FOR UPDATE",
    [restaurantId, customerId]
  );

  if (guest.rows.length === 0) {
    return null;
  }

  const saved = await db.query(
    `INSERT INTO customer_addresses (restaurant_id, customer_id, label, address, landmark, created_by, updated_by)
     VALUES ($1, $2, COALESCE($3, 'Home'), $4, $5, $6, $6)
     ON CONFLICT (customer_id, LOWER(TRIM(address))) DO UPDATE
       SET last_used_at = NOW(),
           use_count = customer_addresses.use_count + 1,
           landmark = COALESCE(EXCLUDED.landmark, customer_addresses.landmark),
           label = CASE WHEN $3::varchar IS NULL THEN customer_addresses.label ELSE EXCLUDED.label END,
           updated_by = EXCLUDED.updated_by
     RETURNING id`,
    [restaurantId, customerId, label || null, text, landmark ? String(landmark).trim() || null : null, userId]
  );

  await db.query(
    `DELETE FROM customer_addresses
     WHERE restaurant_id = $1 AND customer_id = $2
       AND id NOT IN (
         SELECT id FROM customer_addresses
         WHERE restaurant_id = $1 AND customer_id = $2
         ORDER BY last_used_at DESC, id DESC
         LIMIT ${MAX_ADDRESSES}
       )`,
    [restaurantId, customerId]
  );

  return saved.rows[0];
};

const update = async (restaurantId, customerId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE customer_addresses
     SET label = $4, address = $5, landmark = $6, updated_by = $7
     WHERE restaurant_id = $1 AND customer_id = $2 AND id = $3
     RETURNING id`,
    [restaurantId, customerId, id, data.label, data.address, data.landmark, userId]
  );

  return result.rows[0] ? findOne(restaurantId, customerId, id) : null;
};

const remove = async (restaurantId, customerId, id) => {
  const result = await pool.query(
    "DELETE FROM customer_addresses WHERE restaurant_id = $1 AND customer_id = $2 AND id = $3 RETURNING id",
    [restaurantId, customerId, id]
  );

  return result.rows[0] || null;
};

module.exports = { MAX_ADDRESSES, findForGuest, findOne, markUsed, remember, update, remove };
