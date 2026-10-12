// Item and menu queries: item and add-on sales, dish profitability, menu performance, category sales.
// Part of report.repository.js, which re-exports these for its callers.

const pool = require("../../../../../config/database");
const { BILL_DAY, BILL_LINES, BILL_SCOPE, LIVE, scopeParams } = require("./sql");

// ===========================================================================
// Items
// ===========================================================================

// Every dish and size sold, not the first hundred. The list is what an
// accountant ties back to the sales figure, so a cut list that did not add up
// was worse than no list.
const itemSales = async (scope) => {
  const result = await pool.query(
    `SELECT l.item_name, l.variant_name,
            c.name AS category_name,
            SUM(l.quantity) AS quantity,
            COALESCE(SUM(l.line_subtotal), 0) AS net_sales,
            COALESCE(SUM(l.line_tax), 0) AS tax,
            COALESCE(SUM(l.line_total), 0) AS gross_sales
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     ${BILL_LINES}
     LEFT JOIN products p ON p.id = l.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${LIVE} AND ${BILL_SCOPE}
     GROUP BY l.item_name, l.variant_name, c.name
     ORDER BY gross_sales DESC, l.item_name`,
    scopeParams(scope)
  );

  return result.rows;
};

// Add-ons sold (SW-B-16): each add-on on the bills of the range, how many
// plates carried it and what it added to them. Read through the bill lines,
// so a dish billed in two parts counts its add-on once per plate billed, and
// voided bills are out. Free add-ons ("no onion", a free dip) are counted too:
// how often they are asked for is the point.
const addonSales = async (scope) => {
  const result = await pool.query(
    `SELECT COALESCE(m.name, oim.modifier_name) AS addon_name,
            oim.modifier_id,
            SUM(l.quantity) AS quantity,
            COALESCE(SUM(oim.price * l.quantity), 0) AS value,
            COUNT(DISTINCT b.id)::int AS bill_count
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     ${BILL_LINES}
     JOIN order_item_modifiers oim ON oim.order_item_id = l.order_item_id
     LEFT JOIN modifiers m ON m.id = oim.modifier_id
     -- Real add-ons only: the packaging charge and a combo's chosen parts are
     -- stored beside them with no add-on of their own, and are not add-ons.
     WHERE ${LIVE} AND ${BILL_SCOPE} AND oim.modifier_id IS NOT NULL
     GROUP BY COALESCE(m.name, oim.modifier_name), oim.modifier_id
     ORDER BY value DESC, quantity DESC, addon_name`,
    scopeParams(scope)
  );

  return result.rows;
};

// Dish profitability (SW-B-15): for each dish and size sold in the range,
// what it sold before GST and what its ingredients cost.
//
// The cost is what the stock really lost to these bills: every stock movement
// a bill made (net of what its own changes put back), valued at the cost the
// movement carried when it was made (the weighted-average cost then; the
// item's latest cost where an old movement has none) — the same figures the
// P&L's food cost and the stock consumption report's sold usage add up. A
// bill's movements name the bill, not the dish, so each bill's cost is shared
// between its lines in proportion to each line's recipe cost at today's
// prices (the dish or size recipe, and its add-ons' recipes). A line whose
// dish has no recipe takes no share and is flagged. A bill whose stock left
// but none of whose lines has a recipe is returned as unmatched, so the
// totals still tie.
const dishProfitability = async (scope) => {
  const result = await pool.query(
    `WITH live_bills AS (
       SELECT b.id
       FROM bills b
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE ${LIVE} AND ${BILL_SCOPE}
     ),
     lines AS (
       SELECT b.id AS bill_id, l.order_item_id, l.product_id, l.product_variant_id,
              l.item_name, l.variant_name, l.quantity, l.line_subtotal
       FROM bills b
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       ${BILL_LINES}
       WHERE ${LIVE} AND ${BILL_SCOPE}
     ),
     unit_cost AS (
       SELECT i.id, COALESCE(i.average_cost, i.last_cost, 0) AS cost
       FROM inventory_items i WHERE i.restaurant_id = $1
     ),
     -- A size's own recipe when it has one, else the dish recipe times the
     -- size's factor (1 when none is set), as billing takes the stock out.
     dish_cost AS (
       SELECT pr.product_id, SUM(pr.quantity * uc.cost) AS cost
       FROM product_recipes pr JOIN unit_cost uc ON uc.id = pr.inventory_item_id
       WHERE pr.restaurant_id = $1 AND pr.product_variant_id IS NULL
       GROUP BY pr.product_id
     ),
     size_cost AS (
       SELECT pr.product_variant_id, SUM(pr.quantity * uc.cost) AS cost
       FROM product_recipes pr JOIN unit_cost uc ON uc.id = pr.inventory_item_id
       WHERE pr.restaurant_id = $1 AND pr.product_variant_id IS NOT NULL
       GROUP BY pr.product_variant_id
     ),
     addon_cost AS (
       SELECT oim.order_item_id, SUM(mr.quantity * uc.cost) AS cost
       FROM order_item_modifiers oim
       JOIN modifier_recipes mr ON mr.modifier_id = oim.modifier_id
       JOIN unit_cost uc ON uc.id = mr.inventory_item_id
       WHERE oim.order_item_id IN (SELECT order_item_id FROM lines)
       GROUP BY oim.order_item_id
     ),
     costed AS (
       SELECT lines.*,
              (dc.cost IS NOT NULL OR sc.cost IS NOT NULL) AS has_recipe,
              lines.quantity * (
                COALESCE(sc.cost, COALESCE(dc.cost, 0) * COALESCE(pv.recipe_factor, 1)) + COALESCE(ac.cost, 0)
              ) AS theory
       FROM lines
       LEFT JOIN dish_cost dc ON dc.product_id = lines.product_id
       LEFT JOIN size_cost sc ON sc.product_variant_id = lines.product_variant_id
       LEFT JOIN product_variants pv ON pv.id = lines.product_variant_id
       LEFT JOIN addon_cost ac ON ac.order_item_id = lines.order_item_id
     ),
     -- A bill's stock movements name it by id, or — as older bills did — by
     -- its bill number in the notes with no id (the P&L reads both, through
     -- MOVEMENT_BILL). Read by id alone, the stock of every older bill was
     -- missing here and this food cost came out far below the P&L's.
     used AS (
       SELECT bill_id, SUM(cost) AS cost
       FROM (
         SELECT st.reference_id AS bill_id,
                -st.quantity * COALESCE(st.unit_cost, i.last_cost, 0) AS cost
         FROM stock_transactions st
         JOIN inventory_items i ON i.id = st.inventory_item_id
         WHERE st.restaurant_id = $1 AND st.reference_type = 'bill'
           AND st.reference_id IN (SELECT id FROM live_bills)
         UNION ALL
         SELECT nb.id,
                -st.quantity * COALESCE(st.unit_cost, i.last_cost, 0)
         FROM bills nb
         JOIN stock_transactions st
           ON st.restaurant_id = nb.restaurant_id AND st.reference_type = 'bill'
          AND st.reference_id IS NULL AND st.notes = nb.bill_number
         JOIN inventory_items i ON i.id = st.inventory_item_id
         WHERE nb.restaurant_id = $1 AND nb.id IN (SELECT id FROM live_bills)
       ) moves
       GROUP BY bill_id
     ),
     bill_theory AS (
       SELECT bill_id, SUM(theory) AS theory FROM costed GROUP BY bill_id
     )
     SELECT c.product_id, c.product_variant_id, c.item_name, c.variant_name,
            BOOL_OR(c.has_recipe) AS has_recipe,
            SUM(c.quantity) AS quantity,
            COALESCE(SUM(c.line_subtotal), 0) AS sales,
            COALESCE(SUM(CASE WHEN bt.theory > 0 THEN u.cost * c.theory / bt.theory ELSE 0 END), 0) AS cost,
            COALESCE(SUM(c.theory), 0) AS theory
     FROM costed c
     JOIN bill_theory bt ON bt.bill_id = c.bill_id
     LEFT JOIN used u ON u.bill_id = c.bill_id
     GROUP BY c.product_id, c.product_variant_id, c.item_name, c.variant_name
     UNION ALL
     -- Stock taken by bills none of whose lines has a recipe to share it by.
     SELECT NULL, NULL, NULL, NULL, FALSE, 0, 0, COALESCE(SUM(u.cost), 0), 0
     FROM used u JOIN bill_theory bt ON bt.bill_id = u.bill_id
     WHERE bt.theory = 0 OR bt.theory IS NULL
     HAVING COALESCE(SUM(u.cost), 0) <> 0`,
    scopeParams(scope)
  );

  return result.rows;
};

// Every dish on the menu and what it did — including the ones that did
// nothing.
//
// The item report cannot answer this and never could: it groups what was
// sold, so a dish nobody ordered produces no row and is invisible by
// construction. "What is dead weight on my menu?" has to start from the menu
// and join the sales on.
//
// Two lookups per dish: what it sold in the window, and when it last sold at
// all. "Nothing this month" and "nothing, ever" call for different decisions.
const menuPerformance = async (scope) => {
  const result = await pool.query(
    `WITH sold AS (
       SELECT l.product_id,
              SUM(l.quantity) AS quantity,
              SUM(l.line_total) AS gross_sales,
              COUNT(DISTINCT b.order_id) AS order_count
       FROM bills b
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       ${BILL_LINES}
       WHERE ${LIVE} AND ${BILL_SCOPE} AND l.product_id IS NOT NULL
       GROUP BY l.product_id
     )
     SELECT p.id, p.name, p.price, p.is_available, p.food_type,
            COALESCE(c.name, 'Uncategorised') AS category_name,
            COALESCE(sold.quantity, 0) AS quantity,
            COALESCE(sold.gross_sales, 0) AS gross_sales,
            COALESCE(sold.order_count, 0) AS order_count,
            ever.last_sold
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN sold ON sold.product_id = p.id
     LEFT JOIN LATERAL (
       -- No date bound: the last time this dish sold at all, which is what
       -- separates "quiet this week" from "nobody has ever ordered it".
       SELECT MAX(${BILL_DAY}) AS last_sold
       FROM order_items oi
       JOIN bills b ON b.order_id = oi.order_id
       LEFT JOIN business_days bd ON bd.id = b.business_day_id
       WHERE oi.product_id = p.id
         AND oi.item_status <> 'cancelled'
         AND b.bill_status <> 'void'
         AND b.restaurant_id = $1
         AND ($4::bigint IS NULL OR b.outlet_id = $4)
     ) ever ON TRUE
     WHERE p.restaurant_id = $1 AND p.status = 'active'
     ORDER BY gross_sales DESC, p.name`,
    scopeParams(scope)
  );

  return result.rows;
};

const categorySales = async (scope) => {
  const result = await pool.query(
    `SELECT COALESCE(c.name, 'Uncategorised') AS category_name,
            SUM(l.quantity) AS quantity,
            COALESCE(SUM(l.line_total), 0) AS gross_sales
     FROM bills b
     LEFT JOIN business_days bd ON bd.id = b.business_day_id
     ${BILL_LINES}
     LEFT JOIN products p ON p.id = l.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${LIVE} AND ${BILL_SCOPE}
     GROUP BY 1
     ORDER BY gross_sales DESC`,
    scopeParams(scope)
  );

  return result.rows;
};

module.exports = {
  itemSales,
  addonSales,
  dishProfitability,
  menuPerformance,
  categorySales,
};
