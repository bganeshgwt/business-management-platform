// Brands (feature "brands"): one kitchen selling under several names. A
// brand has its own menu categories (a category with no brand is every
// brand's: drinks, desserts), an order is taken under a brand, and the brand
// prints on the order's KOTs and bill. The brand report adds up each brand's
// sales by channel and what the aggregators keep.
const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");

const toBrand = (row) => ({
  id: Number(row.id),
  name: row.name,
  tagline: row.tagline || null,
  color: row.color || null,
  sortOrder: row.sort_order,
  status: row.status,
  categoryCount: row.category_count === undefined ? undefined : Number(row.category_count),
  productCount: row.product_count === undefined ? undefined : Number(row.product_count),
});

const list = async (restaurantId) => (await pool.query(
  `SELECT b.*,
     (SELECT count(*) FROM categories c WHERE c.restaurant_id = b.restaurant_id AND c.brand_id = b.id) AS category_count,
     (SELECT count(*) FROM products p JOIN categories c ON c.id = p.category_id WHERE p.restaurant_id = b.restaurant_id AND c.brand_id = b.id AND p.status = 'active') AS product_count
   FROM restaurant_brands b WHERE b.restaurant_id = $1 ORDER BY b.status, b.sort_order, b.name`,
  [restaurantId]
)).rows.map(toBrand);

const save = async (restaurantId, id, data, userId) => {
  try {
    if (id) {
      const row = (await pool.query(
        `UPDATE restaurant_brands SET name = $3, tagline = $4, color = $5, sort_order = $6, status = $7, updated_by = $8, updated_at = NOW()
         WHERE restaurant_id = $1 AND id = $2 RETURNING *`,
        [restaurantId, id, data.name, data.tagline, data.color, data.sortOrder, data.status, userId]
      )).rows[0];

      if (!row) {
        throw new AppError(404, "Brand not found");
      }

      return toBrand(row);
    }

    return toBrand((await pool.query(
      `INSERT INTO restaurant_brands (restaurant_id, name, tagline, color, sort_order, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [restaurantId, data.name, data.tagline, data.color, data.sortOrder, data.status, userId]
    )).rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      throw new AppError(409, `There is already a brand called "${data.name}"`);
    }

    throw error;
  }
};

// The brand an order is taken under: one of this restaurant's active brands,
// and every dish on the order on its menu (its own categories or a shared one).
const checkOrder = async (restaurantId, brandId, productIds, db = pool) => {
  if (!brandId) {
    return null;
  }

  const brand = (await db.query("SELECT * FROM restaurant_brands WHERE restaurant_id = $1 AND id = $2", [restaurantId, brandId])).rows[0];

  if (!brand) {
    throw new AppError(404, "Brand not found");
  }

  if (brand.status !== "active") {
    throw new AppError(409, `${brand.name} is switched off`);
  }

  if (productIds.length) {
    const other = (await db.query(
      `SELECT p.name, ob.name AS brand_name FROM products p JOIN categories c ON c.id = p.category_id
       LEFT JOIN restaurant_brands ob ON ob.id = c.brand_id
       WHERE p.restaurant_id = $1 AND p.id = ANY($2::bigint[]) AND c.brand_id IS NOT NULL AND c.brand_id <> $3 LIMIT 1`,
      [restaurantId, productIds, brandId]
    )).rows[0];

    if (other) {
      throw new AppError(400, `${other.name} is on ${other.brand_name}'s menu, not ${brand.name}'s. Take it off, or take the order under ${other.brand_name}.`, { reason: "brand_menu" });
    }
  }

  return brand;
};

// Each brand's orders and sales in a period, by channel, with the
// aggregators' commission (at each order's own rate) and what is left.
const report = async (restaurantId, { from, to }) => {
  const rows = (await pool.query(
    `SELECT COALESCE(b.id, 0) AS brand_id, COALESCE(b.name, 'No brand (kitchen name)') AS brand_name, b.color,
       COALESCE(ch.name, CASE o.order_type WHEN 'dine_in' THEN 'Dine-in' WHEN 'takeaway' THEN 'Counter / takeaway' WHEN 'delivery' THEN 'Own delivery' ELSE 'Online / QR' END) AS channel,
       count(DISTINCT bl.id)::int AS bills,
       COALESCE(sum(bl.total_amount), 0)::numeric(14,2) AS sales,
       COALESCE(sum(bl.total_amount * COALESCE(o.channel_commission_percent, 0) / 100), 0)::numeric(14,2) AS commission
     FROM bills bl
     JOIN orders o ON o.id = bl.order_id
     JOIN business_days d ON d.id = bl.business_day_id
     LEFT JOIN restaurant_brands b ON b.id = o.brand_id
     LEFT JOIN sales_channels ch ON ch.id = o.channel_id
     WHERE bl.restaurant_id = $1 AND bl.bill_status <> 'void' AND d.business_date BETWEEN $2::date AND $3::date
     GROUP BY 1, 2, 3, 4 ORDER BY 2, 6 DESC`,
    [restaurantId, from, to]
  )).rows;
  const brands = new Map();

  for (const row of rows) {
    const key = String(row.brand_id);

    if (!brands.has(key)) {
      brands.set(key, { brandId: Number(row.brand_id) || null, name: row.brand_name, color: row.color || null, bills: 0, sales: 0, commission: 0, channels: [] });
    }

    const brand = brands.get(key);
    const sales = Number(row.sales), commission = Number(row.commission);
    brand.bills += row.bills;
    brand.sales += sales;
    brand.commission += commission;
    brand.channels.push({ channel: row.channel, bills: row.bills, sales, commission, net: Math.round((sales - commission) * 100) / 100 });
  }

  const list = [...brands.values()].map((b) => ({ ...b, sales: Math.round(b.sales * 100) / 100, commission: Math.round(b.commission * 100) / 100,
    net: Math.round((b.sales - b.commission) * 100) / 100, averageBill: b.bills ? Math.round((b.sales / b.bills) * 100) / 100 : 0 }))
    .sort((a, b) => b.sales - a.sales);
  const totals = list.reduce((t, b) => ({ bills: t.bills + b.bills, sales: t.sales + b.sales, commission: t.commission + b.commission }), { bills: 0, sales: 0, commission: 0 });

  return { from, to, brands: list, totals: { ...totals, net: Math.round((totals.sales - totals.commission) * 100) / 100 } };
};

module.exports = { list, save, checkOrder, report, toBrand };
