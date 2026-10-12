const pool = require("../../../../config/database");

const COLUMNS = `w.id, w.outlet_id, w.name, w.days_of_week, w.start_time, w.end_time,
                 w.valid_from, w.valid_to, w.priority, w.status`;

const findAll = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT ${COLUMNS}, o.name AS outlet_name,
            (SELECT COUNT(*)::int FROM price_window_items i WHERE i.price_window_id = w.id)
              AS item_count
     FROM price_windows w
     LEFT JOIN outlets o ON o.id = w.outlet_id
     WHERE w.restaurant_id = $1
       AND ($2::text IS NULL OR w.status = $2)
     ORDER BY w.priority DESC, w.name`,
    [restaurantId, filters.status || null]
  );

  return result.rows;
};

// `db`: a save reads the window back through its own connection (see
// replaceItems).
const findById = async (restaurantId, id, db = pool) => {
  const window = await db.query(
    `SELECT ${COLUMNS}, o.name AS outlet_name
     FROM price_windows w
     LEFT JOIN outlets o ON o.id = w.outlet_id
     WHERE w.restaurant_id = $1 AND w.id = $2`,
    [restaurantId, id]
  );

  if (window.rows.length === 0) {
    return null;
  }

  const items = await db.query(
    `SELECT i.id, i.product_id, i.product_variant_id, i.price,
            p.name AS product_name, p.price AS normal_price,
            v.name AS variant_name, v.price_delta
     FROM price_window_items i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN product_variants v ON v.id = i.product_variant_id
     WHERE i.price_window_id = $1
     ORDER BY p.name, v.name NULLS FIRST`,
    [id]
  );

  return { ...window.rows[0], items: items.rows };
};

const create = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO price_windows (restaurant_id, outlet_id, name, days_of_week, start_time,
                                end_time, valid_from, valid_to, priority, status,
                                created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     RETURNING id`,
    [
      restaurantId,
      data.outletId,
      data.name,
      data.daysOfWeek,
      data.startTime,
      data.endTime,
      data.validFrom,
      data.validTo,
      data.priority,
      data.status,
      userId,
    ]
  );

  return findById(restaurantId, result.rows[0].id);
};

const update = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE price_windows
     SET outlet_id = $3, name = $4, days_of_week = $5, start_time = $6, end_time = $7,
         valid_from = $8, valid_to = $9, priority = $10, status = $11, updated_by = $12
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [
      restaurantId,
      id,
      data.outletId,
      data.name,
      data.daysOfWeek,
      data.startTime,
      data.endTime,
      data.validFrom,
      data.validTo,
      data.priority,
      data.status,
      userId,
    ]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findById(restaurantId, id);
};

const remove = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM price_windows WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// The dish list is saved whole, so a window is never briefly half-priced.
// Read back through the same connection: a transaction that holds one
// connection and waits for a second from the pool can hang the server when
// every connection is held that way (order.repository create).
const replaceItems = async (restaurantId, windowId, items, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      "DELETE FROM price_window_items WHERE restaurant_id = $1 AND price_window_id = $2",
      [restaurantId, windowId]
    );

    for (const item of items) {
      await client.query(
        `INSERT INTO price_window_items (restaurant_id, price_window_id, product_id,
                                         product_variant_id, price, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [restaurantId, windowId, item.productId, item.productVariantId || null, item.price, userId]
      );
    }

    await client.query("COMMIT");
    return findById(restaurantId, windowId, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// The rules every timed price follows, kept in one place so the price the POS
// shows and the price the order is charged can never disagree:
//
// * "Now" is the restaurant's own local time, not the server's: a window
//   written as 16:00–19:00 means four in the afternoon where the restaurant
//   is. A window whose end is before its start runs past midnight, so the
//   time is inside it when it is after the start OR before the end.
// * A window tied to an outlet applies at that outlet only. One with no
//   outlet applies everywhere.
// * A price is for one dish in one size. A row with no size is the price of
//   the dish sold without a size ("Regular"); it does NOT cover Half or Full.
//   One happy-hour price laid over every size made the Half plate dearer
//   during happy hour than outside it. A size with no row of its own sells at
//   its normal price.
// * When two windows price the same dish and size, the higher priority wins,
//   then the one tied to this outlet, then the newer window.
const LIVE_PRICES_SQL = `
  WITH local AS (
    SELECT (NOW() AT TIME ZONE $2)::time AS at_time,
           (NOW() AT TIME ZONE $2)::date AS on_date,
           EXTRACT(DOW FROM (NOW() AT TIME ZONE $2))::smallint AS dow
  )
  SELECT DISTINCT ON (i.product_id, i.product_variant_id)
         i.product_id, i.product_variant_id, i.price,
         w.id AS price_window_id, w.name, w.outlet_id,
         to_char(w.end_time, 'HH24:MI') AS ends_at
  FROM price_windows w
  JOIN price_window_items i ON i.price_window_id = w.id
  CROSS JOIN local
  WHERE w.restaurant_id = $1
    AND w.status = 'active'
    AND (w.outlet_id IS NULL OR w.outlet_id = $3::bigint)
    AND local.dow = ANY(w.days_of_week)
    AND (w.valid_from IS NULL OR local.on_date >= w.valid_from)
    AND (w.valid_to IS NULL OR local.on_date <= w.valid_to)
    AND CASE
          WHEN w.end_time > w.start_time
            THEN local.at_time >= w.start_time AND local.at_time < w.end_time
          ELSE local.at_time >= w.start_time OR local.at_time < w.end_time
        END`;

const LIVE_PRICES_ORDER = `
  ORDER BY i.product_id, i.product_variant_id, w.priority DESC,
           (w.outlet_id IS NOT NULL) DESC, w.id DESC`;

// The special price for one dish in one size right now, or null.
//
// outletId is where the order is taken. Null is a restaurant that does not
// use outlets, where only windows meant for every outlet apply.
const findActivePrice = async (
  client,
  restaurantId,
  timezone,
  productId,
  productVariantId,
  outletId = null
) => {
  const result = await (client || pool).query(
    `${LIVE_PRICES_SQL}
       AND i.product_id = $4
       AND i.product_variant_id IS NOT DISTINCT FROM $5::bigint
     ${LIVE_PRICES_ORDER}
     LIMIT 1`,
    [restaurantId, timezone, outletId || null, productId, productVariantId || null]
  );

  return result.rows[0] || null;
};

// Every timed price running right now at one outlet, one row per dish and
// size, by exactly the rules above. The POS reads it to show the price an
// order will be charged before the order is saved.
//
// `db`: an order edit prices its new round under the order's lock and reads
// this through that transaction's own connection, never a second one from
// the pool (order.repository create says why).
const findActivePrices = async (restaurantId, timezone, outletId = null, db = pool) => {
  const result = await db.query(`${LIVE_PRICES_SQL} ${LIVE_PRICES_ORDER}`, [
    restaurantId,
    timezone,
    outletId || null,
  ]);

  return result.rows;
};

module.exports = {
  findAll,
  findById,
  create,
  update,
  remove,
  replaceItems,
  findActivePrice,
  findActivePrices,
};
