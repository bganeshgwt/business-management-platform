const pool = require("../../../../config/database");
const sellingRules = require("./sellingRules.service");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// The printed menu card (sweep SW-B-20): the menu one outlet sells for one
// service, at the prices that outlet and service would charge — the same
// selling rules the till charges by (an outlet's own price, then a channel's,
// then the service's). Happy-hour prices are left out: a printed card stays
// on the table long after the happy hour ends.
//
// Categories come in their display order; a dish that is off the menu, or not
// sold at this outlet or for this service, is left out. A dish marked sold out
// for today stays on the card: it will be back tomorrow.

const ORDER_TYPES = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery",
};

const card = async (restaurantId, { outletId = null, orderType = "dine_in" }) => {
  if (!ORDER_TYPES[orderType]) {
    throw new AppError(400, "Pick dine-in, takeaway or delivery");
  }

  const [restaurant, outlet, rules] = await Promise.all([
    pool.query(
      `SELECT r.name, r.address, r.contact, r.email,
              s.gst_number, s.fssai_number, s.receipt_logo_path, s.tax_mode, s.currency_symbol, s.document_type
       FROM restaurants r
       LEFT JOIN restaurant_settings s ON s.restaurant_id = r.id
       WHERE r.id = $1`,
      [restaurantId]
    ),
    outletId
      ? pool.query("SELECT id, name, address, contact, gst_number, status FROM outlets WHERE restaurant_id = $1 AND id = $2", [
          restaurantId,
          outletId,
        ])
      : null,
    sellingRules.list(restaurantId),
  ]);

  if (!restaurant.rows.length) {
    throw new AppError(404, "Restaurant not found");
  }

  if (outletId && (!outlet || !outlet.rows.length)) {
    throw new AppError(404, "Outlet not found");
  }

  const [products, sizes, addOns] = await Promise.all([
    pool.query(
      `SELECT p.id, p.name, p.code, p.description, p.price, p.food_type, p.tax_mode, p.mrp, p.is_combo,
              p.addon_groups, c.id AS category_id, c.name AS category, c.description AS category_note,
              c.sort_order AS category_order, p.sort_order
       FROM products p
       JOIN categories c ON c.id = p.category_id AND c.restaurant_id = p.restaurant_id AND c.status = 'active'
       WHERE p.restaurant_id = $1 AND p.status = 'active'
       ORDER BY c.sort_order, c.name, c.id, p.sort_order, p.name, p.id`,
      [restaurantId]
    ),
    pool.query(
      `SELECT v.id, v.product_id, v.name, v.price_delta
       FROM product_variants v
       WHERE v.restaurant_id = $1 AND v.status = 'active'
       ORDER BY v.product_id, v.sort_order, v.id`,
      [restaurantId]
    ),
    // Add-ons offered with each dish: linked directly, or through its add-on
    // groups ("Dip", "Extras").
    pool.query(
      `SELECT pm.product_id, m.id, m.name, m.price
       FROM product_modifiers pm
       JOIN modifiers m ON m.id = pm.modifier_id AND m.status = 'active'
       WHERE m.restaurant_id = $1
       UNION
       SELECT p.id AS product_id, m.id, m.name, m.price
       FROM products p
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.addon_groups) = 'array' THEN p.addon_groups ELSE '[]'::jsonb END) g
       CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(g->'modifierIds', '[]'::jsonb)) mid
       JOIN modifiers m ON m.id = mid::bigint AND m.restaurant_id = p.restaurant_id AND m.status = 'active'
       WHERE p.restaurant_id = $1
       ORDER BY 1, 3`,
      [restaurantId]
    ),
  ]);

  const settings = restaurant.rows[0];
  const restaurantInclusive = settings.tax_mode === "inclusive";
  const context = { outletId: outletId || null, channelId: null, orderType };
  const sizesOf = new Map();
  const addOnsOf = new Map();

  for (const row of sizes.rows) {
    const list = sizesOf.get(Number(row.product_id)) || [];
    list.push(row);
    sizesOf.set(Number(row.product_id), list);
  }

  for (const row of addOns.rows) {
    const list = addOnsOf.get(Number(row.product_id)) || [];

    if (!list.some((entry) => Number(entry.id) === Number(row.id))) {
      list.push(row);
    }

    addOnsOf.set(Number(row.product_id), list);
  }

  const categories = [];
  const byCategory = new Map();
  let leftOut = 0;
  let inclusiveItems = 0;
  let exclusiveItems = 0;

  for (const row of products.rows) {
    const rule = sellingRules.selectRule(rules, row.id, context);

    if (rule && rule.is_available === false) {
      leftOut += 1;
      continue;
    }

    const price = round2(Number(rule && rule.price !== null && rule.price !== undefined ? rule.price : row.price));
    const inclusive = row.tax_mode === "inclusive" || (row.tax_mode !== "exclusive" && restaurantInclusive);

    if (inclusive) {
      inclusiveItems += 1;
    } else {
      exclusiveItems += 1;
    }

    let category = byCategory.get(Number(row.category_id));

    if (!category) {
      category = { id: Number(row.category_id), name: row.category, note: row.category_note || null, items: [] };
      byCategory.set(category.id, category);
      categories.push(category);
    }

    category.items.push({
      id: Number(row.id),
      name: row.name,
      code: row.code || null,
      description: row.description || null,
      foodType: row.food_type || null,
      price,
      mrp: row.mrp === null || row.mrp === undefined ? null : Number(row.mrp),
      priceIncludesTax: inclusive,
      isCombo: Boolean(row.is_combo),
      sizes: (sizesOf.get(Number(row.id)) || []).map((size) => ({
        id: Number(size.id),
        name: size.name,
        price: round2(price + Number(size.price_delta || 0)),
      })),
      addOns: (addOnsOf.get(Number(row.id)) || []).map((addOn) => ({
        id: Number(addOn.id),
        name: addOn.name,
        price: Number(addOn.price),
      })),
    });
  }

  const outletRow = outlet && outlet.rows[0];
  const items = categories.reduce((sum, category) => sum + category.items.length, 0);

  // One line for the foot of the card, from how the dishes on it are priced.
  const taxNote =
    settings.document_type === "bill_of_supply"
      ? "Prices are final. No GST is charged on this menu."
      : inclusiveItems > 0 && exclusiveItems === 0
        ? "All prices include GST."
        : inclusiveItems === 0
          ? "Prices are exclusive of GST; GST is added to the bill as applicable."
          : "Prices marked * include GST; GST is added to the bill on the others.";

  return {
    restaurant: {
      name: settings.name,
      address: (outletRow && outletRow.address) || settings.address || null,
      contact: (outletRow && outletRow.contact) || settings.contact || null,
      gstin: (outletRow && outletRow.gst_number) || settings.gst_number || null,
      fssai: settings.fssai_number || null,
      logo: settings.receipt_logo_path || null,
      currency: settings.currency_symbol || "₹",
    },
    outlet: outletRow ? { id: Number(outletRow.id), name: outletRow.name } : null,
    orderType,
    orderTypeLabel: ORDER_TYPES[orderType],
    taxNote,
    // Marked per dish only when the card mixes the two.
    markInclusive: inclusiveItems > 0 && exclusiveItems > 0,
    summary: { categories: categories.length, items, leftOut },
    categories,
  };
};

module.exports = { ORDER_TYPES, card };
