const pool = require("../../../../config/database");

const COLUMNS = `p.id, p.restaurant_id, p.category_id, p.name, p.code, p.description,
                 p.price, p.tax_percentage, p.tax_rate_id, p.tax_mode, p.mrp, p.food_type, p.is_available,
                 p.sort_order, p.status, p.addon_groups, p.availability_schedule, p.combo_choice_groups,
                 p.is_combo, p.image_path, p.kitchen_name, p.sold_by, p.created_at, p.updated_at`;

// Filters are optional: NULL means "no filter", so one query serves the whole list screen.
const findAll = async (restaurantId, filters = {}, db = pool) => {
  const result = await db.query(
    `SELECT ${COLUMNS}, c.name AS category_name, t.name AS tax_rate_name, t.hsn_code,
            offer.price AS offer_price, offer.name AS offer_name,
            -- For a combo, the parts that cannot be made right now, so the
            -- list can say the thali cannot be served and why: the part is
            -- sold out, archived, or the exact size the combo uses (the Small
            -- lassi) is switched off. The same three reasons the till refuses
            -- the combo for.
            CASE WHEN p.is_combo THEN (
              SELECT COALESCE(
                       JSON_AGG(
                         JSON_BUILD_OBJECT(
                           'name', part.name,
                           'size', v.name,
                           'reason', CASE
                                       WHEN part.status <> 'active' THEN 'archived'
                                       WHEN NOT part.is_available THEN 'sold_out'
                                       ELSE 'size_off'
                                     END
                         ) ORDER BY ci.sort_order, ci.id
                       ),
                       '[]'::json
                     )
              FROM combo_items ci
              JOIN products part ON part.id = ci.product_id
              LEFT JOIN product_variants v ON v.id = ci.product_variant_id
              WHERE ci.combo_product_id = p.id
                AND (NOT part.is_available OR part.status <> 'active' OR v.status = 'inactive')
            ) END AS unavailable_parts,
            -- Only when the products screen asks (withCost): whether the dish
            -- has a recipe and what one plate costs at today's stock costs —
            -- the dish recipe, or the default size's own recipe when the dish
            -- has none — the figures the Recipe dialog shows.
            CASE WHEN $6::boolean THEN COALESCE(rc.all_lines, 0) > 0 END AS has_recipe,
            CASE WHEN $6::boolean THEN
              CASE WHEN COALESCE(rc.dish_lines, 0) > 0 THEN rc.dish_cost ELSE dv.cost END
            END AS plate_cost,
            CASE WHEN $6::boolean THEN
              CASE WHEN COALESCE(rc.dish_lines, 0) > 0 THEN p.price ELSE p.price + COALESCE(dv.price_delta, 0) END
            END AS plate_price
     FROM products p
     JOIN categories c ON c.id = p.category_id
     LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
     -- Recipe costs for every dish in one pass (not one lookup per dish).
     LEFT JOIN (
       SELECT pr.product_id,
              COUNT(*) AS all_lines,
              COUNT(*) FILTER (WHERE pr.product_variant_id IS NULL) AS dish_lines,
              SUM(pr.quantity * COALESCE(ri.average_cost, ri.last_cost, 0))
                FILTER (WHERE pr.product_variant_id IS NULL) AS dish_cost
       FROM product_recipes pr
       JOIN inventory_items ri ON ri.id = pr.inventory_item_id
       WHERE $6::boolean AND pr.restaurant_id = $1
       GROUP BY pr.product_id
     ) rc ON rc.product_id = p.id
     LEFT JOIN (
       SELECT pv.product_id, pv.price_delta,
              SUM(pr.quantity * COALESCE(ri.average_cost, ri.last_cost, 0)) AS cost
       FROM product_variants pv
       JOIN product_recipes pr ON pr.product_variant_id = pv.id AND pr.restaurant_id = $1
       JOIN inventory_items ri ON ri.id = pr.inventory_item_id
       WHERE $6::boolean AND pv.is_default
       GROUP BY pv.id, pv.product_id, pv.price_delta
     ) dv ON dv.product_id = p.id
     -- The price a timed window is charging for this dish right now, so the POS
     -- can show it before the order is saved. NULL when no window applies, and
     -- skipped entirely unless a timezone is asked for.
     LEFT JOIN LATERAL (
       SELECT i.price, w.name
       FROM price_windows w
       JOIN price_window_items i ON i.price_window_id = w.id
       WHERE $5::text IS NOT NULL
         AND w.restaurant_id = p.restaurant_id
         AND w.status = 'active'
         AND i.product_id = p.id
         AND i.product_variant_id IS NULL
         AND EXTRACT(DOW FROM (NOW() AT TIME ZONE $5))::smallint = ANY(w.days_of_week)
         AND (w.valid_from IS NULL OR (NOW() AT TIME ZONE $5)::date >= w.valid_from)
         AND (w.valid_to IS NULL OR (NOW() AT TIME ZONE $5)::date <= w.valid_to)
         AND CASE
               WHEN w.end_time > w.start_time
                 THEN (NOW() AT TIME ZONE $5)::time >= w.start_time
                      AND (NOW() AT TIME ZONE $5)::time < w.end_time
               ELSE (NOW() AT TIME ZONE $5)::time >= w.start_time
                    OR (NOW() AT TIME ZONE $5)::time < w.end_time
             END
       ORDER BY w.priority DESC, w.id DESC
       LIMIT 1
     ) AS offer ON TRUE
     WHERE p.restaurant_id = $1
       AND ($2::bigint IS NULL OR p.category_id = $2)
       -- A short code finds its dish too: "PT01" is how a busy person looks it up.
       AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.code ILIKE $3 || '%')
       AND ($4::text IS NULL OR p.status = $4)
     ORDER BY c.sort_order, c.name, p.sort_order, p.name`,
    [
      restaurantId,
      filters.categoryId || null,
      filters.search || null,
      filters.status || null,
      filters.timezone || null,
      Boolean(filters.withCost),
    ]
  );

  return result.rows;
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${COLUMNS}, c.name AS category_name, t.name AS tax_rate_name, t.hsn_code
     FROM products p
     JOIN categories c ON c.id = p.category_id
     LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
     WHERE p.restaurant_id = $1 AND p.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO products (restaurant_id, category_id, name, code, description, price,
                           tax_percentage, tax_rate_id, tax_mode, mrp, food_type, is_available, sort_order,
                           status, kitchen_name, created_by, updated_by, sold_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $16, $15, $15, $17)
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
      // "default" (the restaurant's own setting) when the caller says nothing,
      // the same as the menu screen sends: a script or an import that has no
      // opinion on how the price carries tax must not fail on it (the demo
      // seed stopped on the very first dish).
      data.taxMode || "default",
      data.mrp ?? null,
      data.foodType,
      data.isAvailable,
      data.sortOrder,
      data.status,
      userId,
      // SW-A-12: the name the KOT may print instead (null: none).
      data.kitchenName || null,
      // Sold by the piece, or by weight (the price is per kg).
      data.soldBy || "unit",
    ]
  );

  return findById(restaurantId, result.rows[0].id);
};

const connect = () => pool.connect();

// The dish, locked until the transaction ends. An edit reads the dish, checks
// it and writes it as one step, so a sold-out tap from the kitchen in the same
// instant waits for the edit and is then applied on top of it, instead of the
// edit writing back the "on sale" it read a moment earlier. Read again after
// the write, inside the same transaction, it is the dish as the edit left it.
const lockById = async (client, restaurantId, id) => {
  const result = await client.query(
    `SELECT ${COLUMNS}, c.name AS category_name, t.name AS tax_rate_name, t.hsn_code
     FROM products p
     JOIN categories c ON c.id = p.category_id
     LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
     WHERE p.restaurant_id = $1 AND p.id = $2
     FOR UPDATE OF p`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Only these columns may be named by an edit; the SET list is built from the
// fields the edit actually changes, so a column it does not mention is never
// written (and never overwritten with an old value).
const EDITABLE_COLUMNS = new Set([
  "category_id",
  "name",
  "code",
  "description",
  "price",
  "tax_percentage",
  "tax_rate_id",
  "tax_mode",
  "mrp",
  "food_type",
  "is_available",
  "sort_order",
  "status",
  "kitchen_name",
  "sold_by",
]);

// fields is { column: value }. Returns false when the dish is gone.
const updateColumns = async (client, restaurantId, id, fields, userId) => {
  const names = Object.keys(fields);

  for (const name of names) {
    if (!EDITABLE_COLUMNS.has(name)) {
      throw new Error(`Column ${name} cannot be written by a dish edit`);
    }
  }

  const sets = names.map((name, index) => `${name} = $${index + 4}`);
  const result = await client.query(
    `UPDATE products SET ${[...sets, "updated_by = $3"].join(", ")}
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id, userId, ...names.map((name) => fields[name])]
  );

  return result.rowCount === 1;
};

const setImagePath = async (restaurantId, id, imagePath, userId) => {
  const result = await pool.query(
    `UPDATE products SET image_path = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, imagePath, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findById(restaurantId, id);
};

// Used by the availability toggle on the product list.
const setAvailability = async (restaurantId, id, isAvailable, userId) => {
  const result = await pool.query(
    `UPDATE products
     SET is_available = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, isAvailable, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findById(restaurantId, id);
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM products WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Archiving (status inactive) is how a dish with sales history leaves the
// menu: past bills and reports still point at it, so it cannot be deleted.
const setStatus = async (restaurantId, id, status, userId) => {
  const result = await pool.query(
    `UPDATE products SET status = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, status, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findById(restaurantId, id);
};

// How many order lines have ever carried this dish. Any at all and the dish
// cannot be deleted; the number is what the refusal tells the manager.
const countOrderLines = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1 AND oi.product_id = $2`,
    [restaurantId, id]
  );

  return result.rows[0].count;
};

// Everything the activity log holds about one dish: its own edits, price and
// sold-out switches, photo, combo parts and add-ons, and its sizes. A deleted
// size no longer points at the dish, so it is found by the label it was
// logged under ("Dish · Half").
const findHistory = async (restaurantId, id, name, limit = 200) => {
  const result = await pool.query(
    `SELECT a.id, a.user_name, a.approver_name, a.action, a.entity_type, a.entity_id,
            a.entity_label, a.details, a.created_at
     FROM audit_logs a
     WHERE a.restaurant_id = $1
       AND (
         (a.entity_type IN ('product', 'combo', 'product_image', 'product_modifiers')
          AND a.entity_id = $2)
         OR (a.entity_type = 'product_variant'
             AND (a.entity_id IN (SELECT v.id FROM product_variants v
                                  WHERE v.restaurant_id = $1 AND v.product_id = $2)
                  OR (a.action = 'delete' AND a.entity_label LIKE $3 || ' · %')))
       )
       -- A plate written off (Waste & reorder → Dish wasted) is logged against
       -- the dish but changes nothing about it: it is not part of its history.
       AND a.action NOT IN ('dish_wasted', 'dish_waste_reversed')
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $4`,
    [restaurantId, id, name, limit]
  );

  return result.rows;
};

module.exports = {
  findAll,
  setImagePath,
  findById,
  create,
  connect,
  lockById,
  updateColumns,
  setAvailability,
  remove,
  setStatus,
  countOrderLines,
  findHistory,
};
