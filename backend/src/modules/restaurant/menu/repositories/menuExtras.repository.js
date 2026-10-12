const pool = require("../../../../config/database");

// --- Product variants (Half / Full, 250ml / 500ml) ---

// times_sold is how many order lines carried the size: a size that has been
// sold is switched off rather than deleted, and the screen offers which.
// combos names the combos built with the size, which must let go of it before
// it can be removed.
const findVariants = async (restaurantId, productId) => {
  const result = await pool.query(
    `SELECT v.id, v.product_id, v.name, v.price_delta, v.is_default, v.sort_order, v.status, v.kitchen_name,
            (SELECT COUNT(*)::int FROM order_items oi WHERE oi.product_variant_id = v.id) AS times_sold,
            (SELECT COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id', used.id, 'name', used.name) ORDER BY used.name), '[]'::json)
             FROM (SELECT DISTINCT p.id, p.name
                   FROM combo_items ci
                   JOIN products p ON p.id = ci.combo_product_id
                   WHERE ci.restaurant_id = v.restaurant_id AND ci.product_variant_id = v.id) AS used) AS combos
     FROM product_variants v
     WHERE v.restaurant_id = $1 AND v.product_id = $2
     ORDER BY v.sort_order, v.name`,
    [restaurantId, productId]
  );

  return result.rows;
};

// Every size in the restaurant, for the import, which checks a whole menu at once.
const findAllVariants = async (restaurantId, db = pool) => {
  const result = await db.query(
    `SELECT id, product_id, name, price_delta, is_default, sort_order, status, kitchen_name
     FROM product_variants
     WHERE restaurant_id = $1
     ORDER BY product_id, sort_order, name`,
    [restaurantId]
  );

  return result.rows;
};

// Order lines that carried this size; any at all and it cannot be deleted.
const countVariantOrderLines = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1 AND oi.product_variant_id = $2`,
    [restaurantId, id]
  );

  return result.rows[0].count;
};

// Combos built with this exact size ("Lassi Meal" uses the Small lassi).
const findCombosUsingVariant = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT DISTINCT p.id, p.name
     FROM combo_items ci
     JOIN products p ON p.id = ci.combo_product_id
     WHERE ci.restaurant_id = $1 AND ci.product_variant_id = $2
     ORDER BY p.name`,
    [restaurantId, id]
  );

  return result.rows;
};

const findVariantById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT id, product_id, name, price_delta, is_default, sort_order, status, kitchen_name
     FROM product_variants
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Only one variant per product may be the default, so the old one is cleared first.
const clearDefault = async (client, productId) => {
  await client.query(
    "UPDATE product_variants SET is_default = FALSE WHERE product_id = $1 AND is_default = TRUE",
    [productId]
  );
};

const createVariant = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (data.isDefault) {
      await clearDefault(client, data.productId);
    }

    const result = await client.query(
      `INSERT INTO product_variants
         (restaurant_id, product_id, name, price_delta, is_default, sort_order, status, created_by, updated_by,
          kitchen_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
       RETURNING id, product_id, name, price_delta, is_default, sort_order, status, kitchen_name`,
      [
        restaurantId,
        data.productId,
        data.name,
        data.priceDelta,
        data.isDefault,
        data.sortOrder,
        data.status,
        userId,
        data.kitchenName || null,
      ]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Builds "col = $n" for the fields an edit gives; undefined means "left out,
// keep it", so the column is not written at all.
const setList = (data, columns, startAt) => {
  const keys = Object.keys(columns).filter((key) => data[key] !== undefined);

  return {
    sql: keys.map((key, index) => `${columns[key]} = $${startAt + index}`),
    values: keys.map((key) => data[key]),
  };
};

const VARIANT_COLUMNS = {
  name: "name",
  priceDelta: "price_delta",
  isDefault: "is_default",
  sortOrder: "sort_order",
  status: "status",
  kitchenName: "kitchen_name",
};

const updateVariant = async (restaurantId, id, productId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (data.isDefault === true) {
      await clearDefault(client, productId);
    }

    const { sql, values } = setList(data, VARIANT_COLUMNS, 4);
    const result = await client.query(
      `UPDATE product_variants
       SET ${[...sql, "updated_by = $3"].join(", ")}
       WHERE restaurant_id = $1 AND id = $2
       RETURNING id, product_id, name, price_delta, is_default, sort_order, status, kitchen_name`,
      [restaurantId, id, userId, ...values]
    );

    await client.query("COMMIT");
    return result.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const removeVariant = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM product_variants WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Modifiers (add-ons shared between products) ---

const findModifiers = async (restaurantId, db = pool) => {
  const result = await db.query(
    `SELECT m.id, m.name, m.price, m.status, m.kitchen_name,
            COUNT(pm.product_id)::int AS product_count,
            (SELECT COUNT(*)::int FROM order_item_modifiers oim WHERE oim.modifier_id = m.id) AS times_sold
     FROM modifiers m
     LEFT JOIN product_modifiers pm ON pm.modifier_id = m.id
     WHERE m.restaurant_id = $1
     GROUP BY m.id
     ORDER BY m.name`,
    [restaurantId]
  );

  return result.rows;
};

// Times this add-on was sold; any at all and it cannot be deleted.
const countModifierSales = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM order_item_modifiers oim
     JOIN order_items oi ON oi.id = oim.order_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1 AND oim.modifier_id = $2`,
    [restaurantId, id]
  );

  return result.rows[0].count;
};

// Which add-ons each dish offers, for the whole restaurant at once (import
// and export).
const findAllProductModifierLinks = async (restaurantId, db = pool) => {
  const result = await db.query(
    `SELECT pm.product_id, pm.modifier_id
     FROM product_modifiers pm
     JOIN products p ON p.id = pm.product_id
     WHERE p.restaurant_id = $1`,
    [restaurantId]
  );

  return result.rows;
};

const findModifierById = async (restaurantId, id) => {
  const result = await pool.query(
    "SELECT id, name, price, status, kitchen_name FROM modifiers WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createModifier = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO modifiers (restaurant_id, name, price, status, created_by, updated_by, kitchen_name)
     VALUES ($1, $2, $3, $4, $5, $5, $6)
     RETURNING id, name, price, status, kitchen_name`,
    [restaurantId, data.name, data.price, data.status, userId, data.kitchenName || null]
  );

  return result.rows[0];
};

const MODIFIER_COLUMNS = { name: "name", price: "price", status: "status", kitchenName: "kitchen_name" };

const updateModifier = async (restaurantId, id, data, userId) => {
  const { sql, values } = setList(data, MODIFIER_COLUMNS, 4);
  const result = await pool.query(
    `UPDATE modifiers SET ${[...sql, "updated_by = $3"].join(", ")}
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, name, price, status, kitchen_name`,
    [restaurantId, id, userId, ...values]
  );

  return result.rows[0] || null;
};

const removeModifier = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM modifiers WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Which modifiers a product offers ---

const findProductModifierIds = async (productId) => {
  const result = await pool.query(
    "SELECT modifier_id FROM product_modifiers WHERE product_id = $1",
    [productId]
  );

  return result.rows.map((row) => row.modifier_id);
};

const replaceProductModifiers = async (productId, modifierIds, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const locked = (await client.query("SELECT addon_groups FROM products WHERE id=$1 FOR UPDATE",[productId])).rows[0];
    const selected=new Set(modifierIds.map(Number));
    if((locked?.addon_groups||[]).some(group=>group.modifierIds.some(id=>!selected.has(Number(id))))) {
      throw new (require('../../../../utils/AppError'))(400,'Remove the add-on from its choice group before unlinking it');
    }
    await client.query("DELETE FROM product_modifiers WHERE product_id = $1", [productId]);

    for (const modifierId of modifierIds) {
      await client.query(
        "INSERT INTO product_modifiers (product_id, modifier_id, created_by) VALUES ($1, $2, $3)",
        [productId, modifierId, userId]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return findProductModifierIds(productId);
};

// Used to check the ids sent really belong to this restaurant.
const findModifierIdsForRestaurant = async (restaurantId, modifierIds) => {
  const result = await pool.query(
    "SELECT id FROM modifiers WHERE restaurant_id = $1 AND id = ANY($2::bigint[])",
    [restaurantId, modifierIds]
  );

  return result.rows.map((row) => row.id);
};

module.exports = {
  findVariants,
  findAllVariants,
  countVariantOrderLines,
  findCombosUsingVariant,
  countModifierSales,
  findAllProductModifierLinks,
  findVariantById,
  createVariant,
  updateVariant,
  removeVariant,
  findModifiers,
  findModifierById,
  createModifier,
  updateModifier,
  removeModifier,
  findProductModifierIds,
  replaceProductModifiers,
  findModifierIdsForRestaurant,
};
