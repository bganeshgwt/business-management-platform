const pool = require("../../../../config/database");

const COLUMNS = `id, restaurant_id, name, percentage, hsn_code, cess_percentage,
                 is_default, status, created_at, updated_at`;

const findAll = async (restaurantId, filters = {}, db = pool) => {
  const result = await db.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*)::int FROM products p WHERE p.tax_rate_id = t.id) AS product_count
     FROM tax_rates t
     WHERE restaurant_id = $1
       AND ($2::text IS NULL OR status = $2)
     ORDER BY percentage, name`,
    [restaurantId, filters.status || null]
  );

  return result.rows;
};

const findById = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM tax_rates WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const findDefault = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM tax_rates
     WHERE restaurant_id = $1 AND is_default AND status = 'active'`,
    [restaurantId]
  );

  return result.rows[0] || null;
};

// Only one rate may be the default, so the old one is cleared in the same
// transaction as the new one is set — otherwise the unique index would reject it.
const create = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (data.isDefault) {
      await client.query(
        "UPDATE tax_rates SET is_default = FALSE WHERE restaurant_id = $1 AND is_default",
        [restaurantId]
      );
    }

    const inserted = await client.query(
      `INSERT INTO tax_rates (restaurant_id, name, percentage, hsn_code, cess_percentage,
                              is_default, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING id`,
      [
        restaurantId,
        data.name,
        data.percentage,
        data.hsnCode,
        data.cessPercentage,
        data.isDefault,
        data.status,
        userId,
      ]
    );

    await client.query("COMMIT");
    return await findById(restaurantId, inserted.rows[0].id, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// The dishes on a rate, for "these dishes still use it".
const findProducts = async (restaurantId, id, limit = 12) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.status, COUNT(*) OVER ()::int AS total
     FROM products p
     WHERE p.restaurant_id = $1 AND p.tax_rate_id = $2
     ORDER BY p.status, p.name
     LIMIT $3`,
    [restaurantId, id, limit]
  );

  return { rows: result.rows, total: result.rows.length ? result.rows[0].total : 0 };
};

// Changing a rate changes what every dish using it charges from now on, so the
// products are re-stamped in the same transaction.
//
// data.moveProductsTo: another rate every dish on this one moves to first
// (with its percentage), so a rate can be switched off without leaving a
// single dish selling at it.
const update = async (restaurantId, id, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let moved = 0;

    if (data.moveProductsTo) {
      const movedRows = await client.query(
        `UPDATE products p
         SET tax_rate_id = t.id, tax_percentage = t.percentage, updated_by = $4
         FROM tax_rates t
         WHERE p.restaurant_id = $1 AND p.tax_rate_id = $2
           AND t.restaurant_id = $1 AND t.id = $3
         RETURNING p.id`,
        [restaurantId, id, data.moveProductsTo, userId]
      );
      moved = movedRows.rows.length;
    }

    if (data.isDefault) {
      await client.query(
        "UPDATE tax_rates SET is_default = FALSE WHERE restaurant_id = $1 AND is_default AND id <> $2",
        [restaurantId, id]
      );
    }

    const updated = await client.query(
      `UPDATE tax_rates
       SET name = $3, percentage = $4, hsn_code = $5, cess_percentage = $6,
           is_default = $7, status = $8, updated_by = $9
       WHERE restaurant_id = $1 AND id = $2
       RETURNING id`,
      [
        restaurantId,
        id,
        data.name,
        data.percentage,
        data.hsnCode,
        data.cessPercentage,
        data.isDefault,
        data.status,
        userId,
      ]
    );

    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const restamped = await client.query(
      `UPDATE products SET tax_percentage = $3, updated_by = $4
       WHERE restaurant_id = $1 AND tax_rate_id = $2 AND tax_percentage <> $3
       RETURNING id`,
      [restaurantId, id, data.percentage, userId]
    );

    await client.query("COMMIT");

    const row = await findById(restaurantId, id, client);
    return { ...row, repriced_products: restamped.rows.length, moved_products: moved };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const countProducts = async (restaurantId, id) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM products WHERE restaurant_id = $1 AND tax_rate_id = $2",
    [restaurantId, id]
  );

  return result.rows[0].count;
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM tax_rates WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

module.exports = {
  findAll,
  findById,
  findDefault,
  create,
  update,
  findProducts,
  countProducts,
  remove,
};
