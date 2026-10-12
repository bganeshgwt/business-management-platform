const pool = require("../../../../config/database");

// The day's sold-out list (menu_sold_out). A row counts only while its
// business day is open: when the next day opens, every dish marked yesterday
// is back on sale without anybody touching it.

const LIVE_ON_OPEN_DAY = `
  s.restored_at IS NULL
  AND s.business_day_id IN (
    SELECT bd.id FROM business_days bd
    WHERE bd.restaurant_id = $1 AND bd.day_status = 'open'
  )`;

// What is sold out right now, as bare keys, for pricing an order. `db` lets
// the order service read it inside its own transaction.
const findSoldOutKeys = async (restaurantId, db = pool, outletId = null) => {
  const result = await db.query(
    `SELECT s.product_id, s.product_variant_id
     FROM menu_sold_out s
     WHERE s.restaurant_id = $1 AND ${LIVE_ON_OPEN_DAY}
       AND s.business_day_id IN (SELECT id FROM business_days WHERE outlet_id IS NOT DISTINCT FROM $2::bigint)`,
    [restaurantId, outletId]
  );

  return result.rows;
};

// The list the POS and the kitchen show: what, which size, since when, who
// said so and why.
const findSoldOut = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `SELECT s.id, s.product_id, s.product_variant_id, s.note, s.created_at, s.business_day_id,
            p.name AS product_name, p.code AS product_code, p.category_id, c.name AS category_name,
            v.name AS variant_name, u.name AS marked_by_name
     FROM menu_sold_out s
     JOIN products p ON p.id = s.product_id
     JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_variants v ON v.id = s.product_variant_id
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.restaurant_id = $1 AND ${LIVE_ON_OPEN_DAY}
       AND s.business_day_id IN (SELECT id FROM business_days WHERE outlet_id IS NOT DISTINCT FROM $2::bigint)
     ORDER BY s.created_at DESC, s.id DESC`,
    [restaurantId, outletId]
  );

  return result.rows;
};

// Dishes switched off on the menu itself (Menu > Products), which stay off
// until someone switches them back on. Not part of the day's list, but the
// kitchen and the floor need to see both to know what cannot be sold.
const findSwitchedOff = async (restaurantId) => {
  const result = await pool.query(
    `SELECT p.id AS product_id, p.name AS product_name, p.code AS product_code,
            c.name AS category_name, p.updated_at
     FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE p.restaurant_id = $1 AND p.status = 'active' AND NOT p.is_available
     ORDER BY p.name`,
    [restaurantId]
  );

  return result.rows;
};

// Earlier today: dishes that ran out and were put back on, for the history
// under the list ("Paneer out 8:40, back 9:10").
const findRestoredToday = async (restaurantId, limit = 20, outletId = null) => {
  const result = await pool.query(
    `SELECT s.id, s.product_id, s.product_variant_id, s.created_at, s.restored_at,
            p.name AS product_name, v.name AS variant_name,
            u.name AS marked_by_name, r.name AS restored_by_name
     FROM menu_sold_out s
     JOIN products p ON p.id = s.product_id
     LEFT JOIN product_variants v ON v.id = s.product_variant_id
     LEFT JOIN users u ON u.id = s.created_by
     LEFT JOIN users r ON r.id = s.restored_by
     WHERE s.restaurant_id = $1 AND s.restored_at IS NOT NULL
       AND s.business_day_id IN (
         SELECT bd.id FROM business_days bd
         WHERE bd.restaurant_id = $1 AND bd.day_status = 'open'
           AND bd.outlet_id IS NOT DISTINCT FROM $3::bigint
       )
     ORDER BY s.restored_at DESC
     LIMIT $2`,
    [restaurantId, limit, outletId]
  );

  return result.rows;
};

// Every dish on sale, with its sizes, for the kitchen's sold-out switch. A
// cook may mark a dish sold out (menu.availability) without being allowed to
// open the menu (menu.view), so the kitchen screen cannot read the menu
// itself: this is what it searches. Names, sizes and veg marks only — no
// prices, costs or recipes.
const findDishes = async (restaurantId) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.code, p.food_type, p.is_available, c.name AS category_name,
            COALESCE(
              JSON_AGG(JSON_BUILD_OBJECT('id', v.id, 'name', v.name, 'status', v.status)
                       ORDER BY v.sort_order, v.name) FILTER (WHERE v.id IS NOT NULL), '[]'
            ) AS variants
     FROM products p
     JOIN categories c ON c.id = p.category_id AND c.status = 'active'
     LEFT JOIN product_variants v ON v.product_id = p.id AND v.status = 'active'
     WHERE p.restaurant_id = $1 AND p.status = 'active'
     GROUP BY p.id, c.name, c.sort_order
     ORDER BY c.sort_order, c.name, p.sort_order, p.name`,
    [restaurantId]
  );

  return result.rows;
};

const findProduct = async (restaurantId, productId) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.status, p.is_available
     FROM products p
     WHERE p.restaurant_id = $1 AND p.id = $2`,
    [restaurantId, productId]
  );

  return result.rows[0] || null;
};

const findVariant = async (restaurantId, productId, variantId) => {
  const result = await pool.query(
    `SELECT v.id, v.name, v.status
     FROM product_variants v
     WHERE v.restaurant_id = $1 AND v.product_id = $2 AND v.id = $3`,
    [restaurantId, productId, variantId]
  );

  return result.rows[0] || null;
};

// Marks a dish (or one size) sold out for the day. Two people marking it at
// the same moment make one row: the second finds the first's.
const markSoldOut = async (restaurantId, { businessDayId, productId, variantId, note }, userId) => {
  const inserted = await pool.query(
    `INSERT INTO menu_sold_out (restaurant_id, business_day_id, product_id, product_variant_id,
                                note, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (business_day_id, product_id, COALESCE(product_variant_id, 0))
       WHERE restored_at IS NULL
     DO NOTHING
     RETURNING id`,
    [restaurantId, businessDayId, productId, variantId || null, note || null, userId]
  );

  return { created: inserted.rows.length > 0 };
};

// Puts it back on sale. Returns whether anything was sold out to begin with.
const restore = async (restaurantId, { businessDayId, productId, variantId }, userId) => {
  const result = await pool.query(
    `UPDATE menu_sold_out
     SET restored_at = NOW(), restored_by = $5, updated_by = $5
     WHERE restaurant_id = $1 AND business_day_id = $2 AND product_id = $3
       AND COALESCE(product_variant_id, 0) = COALESCE($4::bigint, 0)
       AND restored_at IS NULL
     RETURNING id`,
    [restaurantId, businessDayId, productId, variantId || null, userId]
  );

  return { restored: result.rows.length > 0 };
};

module.exports = {
  findDishes,
  findSoldOutKeys,
  findSoldOut,
  findSwitchedOff,
  findRestoredToday,
  findProduct,
  findVariant,
  markSoldOut,
  restore,
};
