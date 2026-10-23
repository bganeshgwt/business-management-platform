const pool = require("../../../../config/database");
const inventoryRepository = require("./inventory.repository");
const recipeRepository = require("../../menu/repositories/recipe.repository");
const comboRepository = require("../../menu/repositories/combo.repository");

// A finished dish written off by its recipe: the dish entry,
// and one ordinary wastage row per ingredient that points back at it
// (reference_type 'dish_waste'), so every waste and stock report counts it
// like any other waste.

// The dish and size, as they are called today.
const findDish = async (restaurantId, productId, variantId) => {
  const product = await pool.query(
    `SELECT p.id, p.name, p.is_combo, p.status
     FROM products p
     WHERE p.restaurant_id = $1 AND p.id = $2`,
    [restaurantId, productId]
  );

  if (!product.rows.length) {
    return null;
  }

  let variant = null;

  if (variantId) {
    const found = await pool.query(
      `SELECT id, name FROM product_variants WHERE restaurant_id = $1 AND product_id = $2 AND id = $3`,
      [restaurantId, productId, variantId]
    );
    variant = found.rows[0] || false;
  }

  return { product: product.rows[0], variant };
};

const findModifiers = async (restaurantId, ids) => {
  if (!ids.length) {
    return [];
  }

  const result = await pool.query(
    `SELECT id, name FROM modifiers WHERE restaurant_id = $1 AND id = ANY($2::bigint[]) ORDER BY name`,
    [restaurantId, ids]
  );

  return result.rows;
};

// What one plate takes from stock: the dish's recipe for that size (a combo
// through the dishes it is made of) and each add-on's recipe. Sub-recipes are
// stock items of their own (the gravy made in a production batch), so a dish
// that uses one takes the gravy, exactly as a sale does. Returned per item,
// already multiplied by the number of plates, with each item's name, unit,
// cost (its weighted average, as every other issue is valued) and stock at
// the store.
const findIngredients = async (restaurantId, { productId, variantId, isCombo, modifierIds, quantity }, storeId) => {
  const parts = isCombo
    ? (await comboRepository.findItemsForSale(pool, restaurantId, productId)).map((part) => ({
        productId: part.product_id,
        productVariantId: part.product_variant_id,
        quantity: Number(part.quantity) * quantity,
      }))
    : [{ productId, productVariantId: variantId || null, quantity }];

  const needs = new Map();
  const add = (itemId, amount) => {
    if (amount > 0) {
      needs.set(Number(itemId), (needs.get(Number(itemId)) || 0) + amount);
    }
  };

  for (const part of parts) {
    for (const line of await recipeRepository.findForSale(pool, restaurantId, part.productId, part.productVariantId)) {
      add(line.inventory_item_id, Number(line.quantity) * part.quantity);
    }
  }

  if (modifierIds.length) {
    const addOns = await pool.query(
      `SELECT inventory_item_id, quantity FROM modifier_recipes
       WHERE restaurant_id = $1 AND modifier_id = ANY($2::bigint[])`,
      [restaurantId, modifierIds]
    );

    for (const line of addOns.rows) {
      add(line.inventory_item_id, Number(line.quantity) * quantity);
    }
  }

  if (!needs.size) {
    return [];
  }

  const items = await pool.query(
    `SELECT i.id, i.name, u.short_name AS unit,
            COALESCE(i.average_cost, i.last_cost, 0) AS unit_cost,
            COALESCE((SELECT sb.quantity FROM stock_balances sb
                      WHERE sb.inventory_item_id = i.id AND sb.outlet_id IS NOT DISTINCT FROM $3::bigint), 0) AS store_stock
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     WHERE i.restaurant_id = $1 AND i.id = ANY($2::bigint[])
     ORDER BY i.name`,
    [restaurantId, [...needs.keys()], storeId]
  );

  return items.rows.map((row) => ({
    inventoryItemId: Number(row.id),
    name: row.name,
    unit: row.unit,
    // Kept to the ledger's three places.
    quantity: Math.round(needs.get(Number(row.id)) * 1000) / 1000,
    unitCost: Number(row.unit_cost),
    storeStock: Number(row.store_stock),
  }));
};

// The entry and its ingredient rows, in one transaction. A dish that was
// cooked used its ingredients whatever the stock figure says — like a sale,
// the write-off is never refused for stock; a figure that goes below zero is
// the signal that a delivery or a count is missing.
const create = async (restaurantId, entry, ingredients, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO dish_waste_entries
         (restaurant_id, outlet_id, product_id, product_variant_id, item_name, quantity, reason, note,
          addons, waste_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       RETURNING id`,
      [
        restaurantId,
        entry.outletId || null,
        entry.productId,
        entry.variantId || null,
        entry.itemName,
        entry.quantity,
        entry.reason,
        entry.note || null,
        JSON.stringify(entry.addons || []),
        entry.wasteDate,
        userId,
      ]
    );
    const id = Number(inserted.rows[0].id);
    let value = 0;

    for (const line of ingredients) {
      const balance = await inventoryRepository.recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: line.inventoryItemId,
          outletId: entry.outletId || null,
          transactionType: "wastage",
          quantity: -line.quantity,
          reason: `Dish wasted: ${entry.quantity} × ${entry.itemName}`,
          referenceType: "dish_waste",
          referenceId: id,
          notes: entry.note || entry.reasonLabel,
          allowNegative: true,
        },
        userId
      );

      if (balance === null) {
        throw new Error(`Stock item ${line.inventoryItemId} vanished while the dish was written off`);
      }

      const stamped = await client.query(
        `UPDATE stock_transactions
         SET waste_reason = $4, waste_date = $5::date
         WHERE id = (SELECT id FROM stock_transactions
                     WHERE restaurant_id = $1 AND reference_type = 'dish_waste' AND reference_id = $2
                       AND inventory_item_id = $3
                     ORDER BY id DESC LIMIT 1)
         RETURNING ROUND(-quantity * COALESCE(unit_cost, 0), 2) AS value`,
        [restaurantId, id, line.inventoryItemId, entry.reason, entry.wasteDate]
      );

      value += Number(stamped.rows[0].value);
    }

    value = Math.round(value * 100) / 100;

    await client.query(
      "UPDATE dish_waste_entries SET value = $3, ingredient_lines = $4 WHERE restaurant_id = $1 AND id = $2",
      [restaurantId, id, value, ingredients.length]
    );

    await client.query("COMMIT");
    return { id, value };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const ENTRY_COLUMNS = `d.id, d.outlet_id, d.product_id, d.product_variant_id, d.item_name, d.quantity, d.reason,
       d.note, d.addons, d.value, d.ingredient_lines, d.waste_date::text AS waste_date, d.created_at,
       d.reversed_at, d.reversal_note, cu.name AS logged_by, ru.name AS reversed_by,
       COALESCE(o.name, 'Main store') AS store_name`;

const ENTRY_JOINS = `
     LEFT JOIN users cu ON cu.id = d.created_by
     LEFT JOIN users ru ON ru.id = d.reversed_by
     LEFT JOIN outlets o ON o.id = d.outlet_id`;

// One store's entries only when `store` is given ({ storeId }, null = main):
// an outlet that keeps no store of its own writes off from the main store.
const STORE_OF_ENTRY = `(CASE WHEN o.own_store THEN o.id END)`;

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${ENTRY_COLUMNS}, ${STORE_OF_ENTRY} AS store_id
     FROM dish_waste_entries d ${ENTRY_JOINS}
     WHERE d.restaurant_id = $1 AND d.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const findAll = async (restaurantId, { from, to, store = null, limit = 100 }) => {
  const result = await pool.query(
    `SELECT ${ENTRY_COLUMNS}, COUNT(*) OVER ()::int AS total_count
     FROM dish_waste_entries d ${ENTRY_JOINS}
     WHERE d.restaurant_id = $1 AND d.waste_date BETWEEN $2::date AND $3::date
       AND ($4::boolean IS NOT TRUE OR ${STORE_OF_ENTRY} IS NOT DISTINCT FROM $5::bigint)
     ORDER BY d.waste_date DESC, d.id DESC
     LIMIT $6`,
    [restaurantId, from, to, Boolean(store), store ? store.storeId : null, limit]
  );

  return { rows: result.rows, total: result.rows.length ? result.rows[0].total_count : 0 };
};

// The ingredient rows behind one entry, with what each was worth.
const findLines = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT st.id, st.inventory_item_id, i.name, u.short_name AS unit, -st.quantity AS quantity,
            ROUND(-st.quantity * COALESCE(st.unit_cost, 0), 2) AS value, st.outlet_id
     FROM stock_transactions st
     JOIN inventory_items i ON i.id = st.inventory_item_id
     JOIN units u ON u.id = i.unit_id
     WHERE st.restaurant_id = $1 AND st.reference_type = 'dish_waste' AND st.reference_id = $2
       AND st.transaction_type = 'wastage'
     ORDER BY i.name`,
    [restaurantId, id]
  );

  return result.rows;
};

// Undo: each ingredient row gets the same reversal any wastage entry gets
// (an adjustment pointing back at it), and the entry says who undid it.
// The entry is locked first, so two managers pressing Undo together reverse
// it once.
const reverse = async (restaurantId, id, note, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT id, reversed_at FROM dish_waste_entries WHERE restaurant_id = $1 AND id = $2 FOR UPDATE",
      [restaurantId, id]
    );

    if (!locked.rows.length) {
      await client.query("ROLLBACK");
      return { error: "NOT_FOUND" };
    }

    if (locked.rows[0].reversed_at) {
      await client.query("ROLLBACK");
      return { error: "ALREADY" };
    }

    const lines = await client.query(
      `SELECT st.id, st.inventory_item_id, st.outlet_id, st.quantity
       FROM stock_transactions st
       WHERE st.restaurant_id = $1 AND st.reference_type = 'dish_waste' AND st.reference_id = $2
         AND st.transaction_type = 'wastage'
         AND NOT EXISTS (SELECT 1 FROM stock_transactions rv
                         WHERE rv.restaurant_id = st.restaurant_id AND rv.reference_type = 'waste_reversal'
                           AND rv.reference_id = st.id)
       ORDER BY st.id`,
      [restaurantId, id]
    );

    for (const line of lines.rows) {
      await inventoryRepository.recordMovement(
        client,
        restaurantId,
        {
          inventoryItemId: line.inventory_item_id,
          outletId: line.outlet_id,
          transactionType: "adjustment",
          quantity: -Number(line.quantity),
          reason: "Dish write-off reversed",
          referenceType: "waste_reversal",
          referenceId: line.id,
          notes: note,
        },
        userId
      );
    }

    await client.query(
      `UPDATE dish_waste_entries SET reversed_at = NOW(), reversed_by = $3, reversal_note = $4
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, userId, note || null]
    );

    await client.query("COMMIT");
    return { lines: lines.rows.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Dishes with a recipe, and their sizes and add-ons, for the picker.
const findPickable = async (restaurantId) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.code, p.is_combo, p.food_type, c.name AS category,
            COALESCE((SELECT json_agg(json_build_object('id', v.id, 'name', v.name) ORDER BY v.sort_order, v.id)
                      FROM product_variants v
                      WHERE v.product_id = p.id AND v.restaurant_id = p.restaurant_id AND v.status = 'active'), '[]') AS sizes,
            (EXISTS (SELECT 1 FROM product_recipes r WHERE r.restaurant_id = p.restaurant_id AND r.product_id = p.id)
             OR (p.is_combo AND EXISTS (SELECT 1 FROM combo_items ci
                                        JOIN product_recipes r ON r.product_id = ci.product_id AND r.restaurant_id = ci.restaurant_id
                                        WHERE ci.restaurant_id = p.restaurant_id AND ci.combo_product_id = p.id))) AS has_recipe
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.restaurant_id = $1 AND p.status = 'active'
     ORDER BY p.name`,
    [restaurantId]
  );

  const addOns = await pool.query(
    `SELECT m.id, m.name FROM modifiers m
     WHERE m.restaurant_id = $1 AND m.status = 'active'
       AND EXISTS (SELECT 1 FROM modifier_recipes mr WHERE mr.restaurant_id = m.restaurant_id AND mr.modifier_id = m.id)
     ORDER BY m.name`,
    [restaurantId]
  );

  return { dishes: result.rows, addOns: addOns.rows };
};

module.exports = {
  findDish,
  findModifiers,
  findIngredients,
  create,
  findById,
  findAll,
  findLines,
  reverse,
  findPickable,
};
