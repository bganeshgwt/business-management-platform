const pool = require("../../../../config/database");

const COLUMNS = `c.id, c.name, c.channel_type, c.commission_percent, c.color, c.sort_order,
                 c.status, c.created_at, c.updated_at, c.delivery_charge, c.delivery_free_above`;

// The five every Indian restaurant starts with. The rates are the going
// rates for a mid-size restaurant; each one is edited on the Channels tab.
const DEFAULT_CHANNELS = [
  { name: "Own delivery", channelType: "own", commissionPercent: 0, color: "green", sortOrder: 0 },
  { name: "Swiggy", channelType: "aggregator", commissionPercent: 22, color: "orange", sortOrder: 10 },
  { name: "Zomato", channelType: "aggregator", commissionPercent: 25, color: "red", sortOrder: 20 },
  { name: "Phone", channelType: "phone", commissionPercent: 0, color: "blue", sortOrder: 30 },
  { name: "Website", channelType: "website", commissionPercent: 0, color: "violet", sortOrder: 40 },
];

// A restaurant created after the migration has no channels until someone
// opens the deliveries screen. Only a restaurant with none at all gets the
// defaults — a manager who deleted "Website" does not see it come back,
// because the last channel can never be deleted (see the service).
const ensureDefaults = async (restaurantId) => {
  const existing = await pool.query(
    "SELECT 1 FROM sales_channels WHERE restaurant_id = $1 LIMIT 1",
    [restaurantId]
  );

  if (existing.rows.length > 0) {
    return;
  }

  // ON CONFLICT: two screens opening at the same moment both see "none".
  for (const channel of DEFAULT_CHANNELS) {
    await pool.query(
      `INSERT INTO sales_channels (restaurant_id, name, channel_type, commission_percent, color, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        restaurantId,
        channel.name,
        channel.channelType,
        channel.commissionPercent,
        channel.color,
        channel.sortOrder,
      ]
    );
  }
};

// Every channel with how much it is used: orders ever (which decides whether
// it may be deleted), orders on the open day, and the last 30 days.
//
// "Today" and "last 30 days" count the same thing — orders placed on the
// channel that were not called off — so today can never outnumber the month.
// The 30-day money is what those orders were billed, void bills left out.
const findAll = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ${COLUMNS},
            COALESCE(usage.orders_total, 0)::int AS orders_total,
            COALESCE(usage.orders_today, 0)::int AS orders_today,
            COALESCE(usage.orders_30d, 0)::int AS orders_30d,
            COALESCE(sales.gross_30d, 0) AS gross_30d
     FROM sales_channels c
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS orders_total,
              COUNT(*) FILTER (
                WHERE o.order_status <> 'cancelled'
                  AND o.delivery_status IS DISTINCT FROM 'cancelled'
                  AND o.business_day_id IN (
                    SELECT id FROM business_days WHERE restaurant_id = $1 AND day_status = 'open'
                  )
              ) AS orders_today,
              COUNT(*) FILTER (
                WHERE o.order_status <> 'cancelled'
                  AND o.delivery_status IS DISTINCT FROM 'cancelled'
                  AND o.placed_at > NOW() - INTERVAL '30 days'
              ) AS orders_30d
       FROM orders o
       WHERE o.channel_id = c.id AND o.restaurant_id = $1
     ) usage ON TRUE
     LEFT JOIN LATERAL (
       SELECT SUM(b.total_amount) AS gross_30d
       FROM bills b
       JOIN orders o ON o.id = b.order_id
       WHERE o.channel_id = c.id AND b.restaurant_id = $1 AND b.bill_status <> 'void'
         AND o.order_status <> 'cancelled'
         AND o.delivery_status IS DISTINCT FROM 'cancelled'
         AND o.placed_at > NOW() - INTERVAL '30 days'
     ) sales ON TRUE
     WHERE c.restaurant_id = $1
     ORDER BY c.status, c.sort_order, c.name`,
    [restaurantId]
  );

  return result.rows;
};

const findById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*)::int FROM orders o WHERE o.channel_id = c.id AND o.restaurant_id = $1)
              AS orders_total
     FROM sales_channels c
     WHERE c.restaurant_id = $1 AND c.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const count = async (restaurantId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM sales_channels WHERE restaurant_id = $1",
    [restaurantId]
  );

  return result.rows[0].count;
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO sales_channels (restaurant_id, name, channel_type, commission_percent, color,
                                 sort_order, status, created_by, updated_by,
                                 delivery_charge, delivery_free_above)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE($6, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM sales_channels
                           WHERE restaurant_id = $1)),
             $7, $8, $8, $9, $10)
     RETURNING id`,
    [
      restaurantId,
      data.name,
      data.channelType,
      data.commissionPercent,
      data.color,
      data.sortOrder,
      data.status,
      userId,
      data.deliveryCharge || 0,
      data.deliveryFreeAbove || null,
    ]
  );

  return findById(restaurantId, result.rows[0].id);
};

const update = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE sales_channels
     SET name = $3, channel_type = $4, commission_percent = $5, color = $6,
         sort_order = COALESCE($7, sort_order), status = $8, updated_by = $9,
         delivery_charge = COALESCE($10, delivery_charge),
         delivery_free_above = CASE WHEN $11::boolean THEN $12::numeric ELSE delivery_free_above END
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [
      restaurantId,
      id,
      data.name,
      data.channelType,
      data.commissionPercent,
      data.color,
      data.sortOrder,
      data.status,
      userId,
      data.deliveryCharge === undefined ? null : data.deliveryCharge,
      data.deliveryFreeAbove !== undefined,
      data.deliveryFreeAbove === undefined ? null : data.deliveryFreeAbove,
    ]
  );

  return result.rows[0] ? findById(restaurantId, id) : null;
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM sales_channels WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

module.exports = {
  DEFAULT_CHANNELS,
  ensureDefaults,
  findAll,
  findById,
  count,
  create,
  update,
  remove,
};
