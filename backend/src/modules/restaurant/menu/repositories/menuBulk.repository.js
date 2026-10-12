const pool = require("../../../../config/database");

// Writes for the two bulk menu tools, the CSV import and the price revision.
// Every function takes the transaction's client: a bulk change is applied
// whole or not at all, and the database checks its rules (no size below zero,
// combos one level deep) when that transaction commits.

// Only these columns may be named in a partial update. The import changes
// exactly the columns a file carries, so the SET list is built per row, and a
// whitelist keeps a column name from ever coming from the file itself.
const PRODUCT_COLUMNS = new Set([
  "category_id",
  "name",
  "code",
  "description",
  "price",
  "tax_percentage",
  "tax_rate_id",
  "food_type",
  "is_available",
  "sort_order",
  "status",
  "kitchen_name",
]);

const VARIANT_COLUMNS = new Set(["name", "price_delta", "is_default", "sort_order", "status"]);

const setClause = (fields, allowed, startAt) => {
  const names = Object.keys(fields);

  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error(`Column ${name} cannot be written by a bulk menu change`);
    }
  }

  return {
    sql: names.map((name, index) => `${name} = $${startAt + index}`).join(", "),
    values: names.map((name) => fields[name]),
  };
};

// "Only if it still says what the preview read": each expected column becomes
// a condition on the UPDATE, so a row someone changed after the preview is
// not overwritten (the update touches no row, and the caller stops).
const expectClause = (expected, allowed, startAt) => {
  const names = Object.keys(expected || {});

  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error(`Column ${name} cannot be checked by a bulk menu change`);
    }
  }

  return {
    sql: names.map((name, index) => ` AND ${name} IS NOT DISTINCT FROM $${startAt + index}`).join(""),
    values: names.map((name) => expected[name]),
  };
};

const connect = () => pool.connect();

// One import or price revision at a time per restaurant. Held until the
// transaction ends, so a double-clicked Import or Apply waits for the first
// one, then finds the menu already changed and stops instead of applying (and
// logging) the same change twice. Key 915001 is the bulk tools' own; the
// database's menu rules use 915002 and 915003.
const lockMenu = (client, restaurantId) =>
  client.query("SELECT pg_advisory_xact_lock(915001, $1::int)", [restaurantId]);

// A category the file names but the menu does not have yet goes to the end of
// the menu, after every existing one.
const insertCategory = async (client, restaurantId, name, userId) => {
  const result = await client.query(
    `INSERT INTO categories (restaurant_id, name, sort_order, status, created_by, updated_by)
     VALUES ($1, $2,
             (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE restaurant_id = $1),
             'active', $3, $3)
     RETURNING id`,
    [restaurantId, name, userId]
  );

  return result.rows[0].id;
};

const insertModifier = async (client, restaurantId, name, price, userId) => {
  const result = await client.query(
    `INSERT INTO modifiers (restaurant_id, name, price, status, created_by, updated_by)
     VALUES ($1, $2, $3, 'active', $4, $4)
     RETURNING id`,
    [restaurantId, name, price, userId]
  );

  return result.rows[0].id;
};

const updateModifierPrice = async (client, restaurantId, id, price, userId) => {
  await client.query(
    "UPDATE modifiers SET price = $3, updated_by = $4 WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id, price, userId]
  );
};

const insertProduct = async (client, restaurantId, data, userId) => {
  const result = await client.query(
    `INSERT INTO products (restaurant_id, category_id, name, code, description, price,
                           tax_percentage, tax_rate_id, food_type, is_available, sort_order,
                           status, created_by, updated_by, kitchen_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)
     RETURNING id`,
    [
      restaurantId,
      data.categoryId,
      data.name,
      data.code,
      data.description,
      data.price,
      data.taxPercentage,
      data.taxRateId,
      data.foodType,
      data.isAvailable,
      data.sortOrder,
      data.status,
      userId,
      data.kitchenName || null,
    ]
  );

  return result.rows[0].id;
};

// fields is { column: value } with database column names; expected, when
// given, is { column: value the preview read }. Returns false when the row no
// longer holds the expected values (or is gone): nothing was written.
const updateProduct = async (client, restaurantId, id, fields, userId, expected = null) => {
  if (Object.keys(fields).length === 0) {
    return true;
  }

  const { sql, values } = setClause(fields, PRODUCT_COLUMNS, 4);
  const guard = expectClause(expected, PRODUCT_COLUMNS, 4 + values.length);

  const result = await client.query(
    `UPDATE products SET ${sql}, updated_by = $3 WHERE restaurant_id = $1 AND id = $2${guard.sql}`,
    [restaurantId, id, userId, ...values, ...guard.values]
  );

  return result.rowCount === 1;
};

// One default size per dish: the old one is cleared before a new one is set.
const clearDefaultVariant = async (client, productId) => {
  await client.query(
    "UPDATE product_variants SET is_default = FALSE WHERE product_id = $1 AND is_default",
    [productId]
  );
};

const insertVariant = async (client, restaurantId, productId, data, userId) => {
  const result = await client.query(
    `INSERT INTO product_variants (restaurant_id, product_id, name, price_delta, is_default,
                                   sort_order, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
     RETURNING id`,
    [restaurantId, productId, data.name, data.priceDelta, data.isDefault, data.sortOrder, userId]
  );

  return result.rows[0].id;
};

// Same contract as updateProduct.
const updateVariant = async (client, restaurantId, id, fields, userId, expected = null) => {
  if (Object.keys(fields).length === 0) {
    return true;
  }

  const { sql, values } = setClause(fields, VARIANT_COLUMNS, 4);
  const guard = expectClause(expected, VARIANT_COLUMNS, 4 + values.length);

  const result = await client.query(
    `UPDATE product_variants SET ${sql}, updated_by = $3 WHERE restaurant_id = $1 AND id = $2${guard.sql}`,
    [restaurantId, id, userId, ...values, ...guard.values]
  );

  return result.rowCount === 1;
};

const replaceProductModifiers = async (client, productId, modifierIds, userId) => {
  await client.query("DELETE FROM product_modifiers WHERE product_id = $1", [productId]);

  for (const modifierId of modifierIds) {
    await client.query(
      "INSERT INTO product_modifiers (product_id, modifier_id, created_by) VALUES ($1, $2, $3)",
      [productId, modifierId, userId]
    );
  }
};

// SW-A-12: a size's kitchen name, found by the dish and the size's name (a
// size the same import has just created has no id in the plan yet).
const setVariantKitchenName = async (client, restaurantId, productId, name, kitchenName, userId) => {
  await client.query(
    `UPDATE product_variants SET kitchen_name = $4, updated_by = $5
     WHERE restaurant_id = $1 AND product_id = $2 AND LOWER(name) = LOWER($3)`,
    [restaurantId, productId, name, kitchenName, userId]
  );
};

// An add-on's kitchen name is the same on every dish that offers it.
const setModifierKitchenName = async (client, restaurantId, id, kitchenName, userId) => {
  await client.query(
    "UPDATE modifiers SET kitchen_name = $3, updated_by = $4 WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id, kitchenName, userId]
  );
};

module.exports = {
  setVariantKitchenName,
  setModifierKitchenName,
  connect,
  lockMenu,
  insertCategory,
  insertModifier,
  updateModifierPrice,
  insertProduct,
  updateProduct,
  clearDefaultVariant,
  insertVariant,
  updateVariant,
  replaceProductModifiers,
};
