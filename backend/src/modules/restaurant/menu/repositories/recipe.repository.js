const pool = require("../../../../config/database");

const findByProduct = async (restaurantId, productId) => {
  const result = await pool.query(
    `SELECT r.id, r.product_id, r.product_variant_id, r.inventory_item_id, r.quantity,
            i.name AS item_name, COALESCE(i.average_cost, i.last_cost) AS last_cost,
            u.short_name AS unit_short_name,
            v.name AS variant_name
     FROM product_recipes r
     JOIN inventory_items i ON i.id = r.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     LEFT JOIN product_variants v ON v.id = r.product_variant_id
     WHERE r.restaurant_id = $1 AND r.product_id = $2
     ORDER BY v.sort_order NULLS FIRST, v.name NULLS FIRST, i.name`,
    [restaurantId, productId]
  );

  return result.rows;
};

// The sizes a dish is sold in, with how much of the dish recipe each uses.
const findVariants = async (restaurantId, productId) => {
  const result = await pool.query(
    `SELECT id, product_id, name, price_delta, is_default, sort_order, status, recipe_factor
     FROM product_variants
     WHERE restaurant_id = $1 AND product_id = $2
     ORDER BY sort_order, name`,
    [restaurantId, productId]
  );

  return result.rows;
};

const findVariantById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT id, product_id, name, recipe_factor
     FROM product_variants WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const setVariantFactor = async (restaurantId, variantId, factor, userId) => {
  const result = await pool.query(
    `UPDATE product_variants SET recipe_factor = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, product_id`,
    [restaurantId, variantId, factor, userId]
  );

  return result.rows[0] || null;
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    "SELECT id, product_id, product_variant_id, inventory_item_id, quantity FROM product_recipes WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO product_recipes (restaurant_id, product_id, product_variant_id,
                                  inventory_item_id, quantity, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id`,
    [
      restaurantId,
      data.productId,
      data.productVariantId,
      data.inventoryItemId,
      data.quantity,
      userId,
    ]
  );

  return result.rows[0].id;
};

// Starts a size's own recipe from the dish's, scaled: "Half from the dish at
// 0.5" is two clicks instead of re-typing every ingredient. Lines the size
// already has are left as they are.
const copyDishToSize = async (restaurantId, productId, variantId, factor, userId) => {
  const result = await pool.query(
    `INSERT INTO product_recipes (restaurant_id, product_id, product_variant_id,
                                  inventory_item_id, quantity, created_by, updated_by)
     SELECT r.restaurant_id, r.product_id, $3, r.inventory_item_id,
            ROUND(r.quantity * $4, 4), $5, $5
     FROM product_recipes r
     WHERE r.restaurant_id = $1 AND r.product_id = $2 AND r.product_variant_id IS NULL
       AND ROUND(r.quantity * $4, 4) > 0
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [restaurantId, productId, variantId, factor, userId]
  );

  return result.rows.length;
};

const update = async (restaurantId, id, quantity, userId) => {
  const result = await pool.query(
    `UPDATE product_recipes SET quantity = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, quantity, userId]
  );

  return result.rows[0] || null;
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM product_recipes WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Ingredients for the exact size sold.
//
// A size with a recipe of its own uses it. A size without one uses the dish's
// recipe — multiplied by the size's factor when the owner has set one (a Half
// plate at 0.5 takes half the paneer), or at full quantity when they have not.
// That last case is flagged on the recipe screen, because it is how a half
// plate used to take a full plate's ingredients without anyone noticing.
const findForSale = async (client, restaurantId, productId, productVariantId) => {
  const result = await client.query(
    `SELECT inventory_item_id, quantity
     FROM product_recipes
     WHERE restaurant_id = $1 AND product_id = $2
       AND product_variant_id IS NOT DISTINCT FROM $3`,
    [restaurantId, productId, productVariantId]
  );

  if (result.rows.length > 0 || productVariantId === null || productVariantId === undefined) {
    return result.rows;
  }

  const fallback = await client.query(
    `SELECT r.inventory_item_id,
            r.quantity * COALESCE(v.recipe_factor, 1) AS quantity
     FROM product_recipes r
     LEFT JOIN product_variants v
       ON v.id = $3 AND v.restaurant_id = r.restaurant_id AND v.product_id = r.product_id
     WHERE r.restaurant_id = $1 AND r.product_id = $2 AND r.product_variant_id IS NULL`,
    [restaurantId, productId, productVariantId]
  );

  return fallback.rows;
};

module.exports = {
  findByProduct,
  findVariants,
  findVariantById,
  setVariantFactor,
  findById,
  create,
  copyDishToSize,
  update,
  remove,
  findForSale,
};
