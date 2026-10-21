const pool = require("../../../../config/database");

const COLUMNS = `id, restaurant_id, name, description, sort_order, status, brand_id, created_at, updated_at`;

const findAll = async (restaurantId, db = pool) => {
  const result = await db.query(
    `SELECT c.id, c.restaurant_id, c.name, c.description, c.sort_order, c.status, c.brand_id,
            (SELECT b.name FROM restaurant_brands b WHERE b.id = c.brand_id) AS brand_name,
            c.created_at, c.updated_at,
            COUNT(p.id)::int AS product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id
     WHERE c.restaurant_id = $1
     GROUP BY c.id
     ORDER BY c.sort_order, c.name`,
    [restaurantId]
  );

  return result.rows;
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM categories WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO categories (restaurant_id, name, description, sort_order, status, created_by, updated_by, brand_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
     RETURNING ${COLUMNS}`,
    [restaurantId, data.name, data.description, data.sortOrder, data.status, userId, data.brandId || null]
  );

  return result.rows[0];
};

const UPDATABLE = { name: "name", description: "description", sortOrder: "sort_order", status: "status", brandId: "brand_id" };

// Writes only the fields the edit gives (undefined means "left out, keep it"),
// so an edit never puts back an old value someone else has since changed.
const update = async (restaurantId, id, data, userId) => {
  const keys = Object.keys(UPDATABLE).filter((key) => data[key] !== undefined);
  const sets = keys.map((key, index) => `${UPDATABLE[key]} = $${index + 4}`);

  const result = await pool.query(
    `UPDATE categories
     SET ${[...sets, "updated_by = $3"].join(", ")}
     WHERE restaurant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [restaurantId, id, userId, ...keys.map((key) => data[key])]
  );

  return result.rows[0] || null;
};

const countProducts = async (categoryId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM products WHERE category_id = $1",
    [categoryId]
  );

  return result.rows[0].count;
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM categories WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

module.exports = {
  findAll,
  findById,
  create,
  update,
  countProducts,
  remove,
};
