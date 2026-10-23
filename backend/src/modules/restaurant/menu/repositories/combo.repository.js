const pool = require("../../../../config/database");

// What a combo is made of, with enough of each part to show it on screen.
const findItems = async (restaurantId, comboProductId, db = pool) => {
  const result = await db.query(
    `SELECT ci.id, ci.product_id, ci.product_variant_id, ci.quantity, ci.sort_order,
            p.name AS product_name, p.price AS product_price, p.is_combo,
            p.is_available, p.status AS product_status,
            v.name AS variant_name, v.price_delta, v.status AS variant_status
     FROM combo_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.product_variant_id
     WHERE ci.restaurant_id = $1 AND ci.combo_product_id = $2
     ORDER BY ci.sort_order, ci.id`,
    [restaurantId, comboProductId]
  );

  return result.rows;
};

// The lock every combo save takes before it checks anything (the database's
// own one-level rule takes the same one, migration 1789915000000). Two
// editors saving at the same moment ("make A a combo" while "put A inside C")
// are checked one after the other, so they cannot nest combos between them.
const COMBO_LOCK = 915002;

const lockCombos = (client, restaurantId) =>
  client.query("SELECT pg_advisory_xact_lock($1, $2::int)", [COMBO_LOCK, restaurantId]);

// Read inside the save's transaction, after the lock: the dishes in `ids` that
// are combos now, and the combos that already hold `comboProductId`.
const findNestingConflicts = async (client, restaurantId, comboProductId, ids) => {
  // One after the other: a transaction's client runs one query at a time.
  const parts = await client.query(
    `SELECT id, name FROM products
     WHERE restaurant_id = $1 AND id = ANY($2::bigint[])
       AND (is_combo OR EXISTS (SELECT 1 FROM combo_items ci WHERE ci.combo_product_id = products.id))
     ORDER BY name`,
    [restaurantId, ids]
  );
  const holders = await client.query(
    `SELECT DISTINCT p.id, p.name
     FROM combo_items ci
     JOIN products p ON p.id = ci.combo_product_id
     WHERE ci.restaurant_id = $1 AND ci.product_id = $2
     UNION SELECT p.id,p.name FROM products p, jsonb_array_elements(p.combo_choice_groups) g,
       jsonb_array_elements(g->'options') opt WHERE p.restaurant_id=$1 AND (opt->>'productId')::bigint=$2
     ORDER BY name`,
    [restaurantId, comboProductId]
  );

  return { combosAsParts: parts.rows, heldBy: holders.rows };
};

// Replaces the whole parts list in one go, which is how the editor saves it: a
// half-changed combo would consume the wrong ingredients. `verify(client)`,
// when given, runs after the lock and before any write; it throws to refuse.
const replaceItems = async (restaurantId, comboProductId, items, userId, verify = null) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await lockCombos(client, restaurantId);

    if (verify) {
      await verify(client);
    }

    await client.query(
      "DELETE FROM combo_items WHERE restaurant_id = $1 AND combo_product_id = $2",
      [restaurantId, comboProductId]
    );

    for (const [index, item] of items.entries()) {
      await client.query(
        `INSERT INTO combo_items (restaurant_id, combo_product_id, product_id,
                                  product_variant_id, quantity, sort_order,
                                  created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          restaurantId,
          comboProductId,
          item.productId,
          item.productVariantId || null,
          item.quantity,
          index,
          userId,
        ]
      );
    }

    await client.query("UPDATE products SET is_combo = ($3 OR jsonb_array_length(combo_choice_groups)>0), updated_by = $4 WHERE restaurant_id = $1 AND id = $2", [
      restaurantId,
      comboProductId,
      items.length > 0,
      userId,
    ]);

    await client.query("COMMIT");
    return await findItems(restaurantId, comboProductId, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Used inside the billing transaction: the parts a sold combo is made of, so
// their recipes can be consumed.
const findItemsForSale = async (client, restaurantId, comboProductId) => {
  const result = await client.query(
    `SELECT product_id, product_variant_id, quantity
     FROM combo_items
     WHERE restaurant_id = $1 AND combo_product_id = $2`,
    [restaurantId, comboProductId]
  );

  return result.rows;
};

// Which combos a dish belongs to — shown before deleting it, when it is marked
// sold out (so those combos can be switched off too) and in the combo editor.
const findCombosContaining = async (restaurantId, productId) => {
  const result = await pool.query(
    `SELECT DISTINCT p.id, p.name, p.is_available, p.status
     FROM combo_items ci
     JOIN products p ON p.id = ci.combo_product_id
     WHERE ci.restaurant_id = $1 AND ci.product_id = $2
     UNION SELECT p.id,p.name,p.is_available,p.status FROM products p, jsonb_array_elements(p.combo_choice_groups) g,
       jsonb_array_elements(g->'options') opt WHERE p.restaurant_id=$1 AND (opt->>'productId')::bigint=$2
     ORDER BY name`,
    [restaurantId, productId]
  );

  return result.rows;
};

module.exports = {
  findItems,
  findNestingConflicts,
  replaceItems,
  findItemsForSale,
  findCombosContaining,
};
