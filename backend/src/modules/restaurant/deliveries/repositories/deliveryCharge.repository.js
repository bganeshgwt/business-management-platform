// The delivery charge on an order, worked out by the
// database from the order's own lines and its channel — never from a figure
// the screen sent. Shared by the orders module (new orders, changed dishes)
// and the deliveries module (a changed channel), so both follow one rule:
//
//   not a delivery, or waived           no charge
//   the channel's "free above" reached  no charge
//   otherwise                           the channel's charge
//
// A delivery with no channel picked is the restaurant's own delivery: it
// takes the charge of the first active "own" channel. Only an open order
// changes; a billed one keeps what was billed. The GST rate on the charge
// is the rate of the order's largest line (the food it carries).
const pool = require("../../../../config/database");

const refresh = (db, orderId) =>
  (db || pool).query(
    `UPDATE orders o
     SET delivery_charge = CASE
           WHEN o.order_type <> 'delivery' OR o.delivery_charge_waived_at IS NOT NULL OR ch.id IS NULL THEN 0
           WHEN ch.delivery_free_above IS NOT NULL AND o.total_amount >= ch.delivery_free_above THEN 0
           ELSE ch.delivery_charge
         END,
         delivery_charge_tax_percent = CASE
           WHEN o.order_type = 'delivery' THEN (
             SELECT oi.tax_percentage FROM order_items oi
             WHERE oi.order_id = o.id AND oi.item_status <> 'cancelled'
             ORDER BY oi.line_subtotal DESC, oi.id LIMIT 1)
         END
     FROM orders base
     LEFT JOIN LATERAL (
       SELECT c.id, c.delivery_charge, c.delivery_free_above
       FROM sales_channels c
       WHERE c.restaurant_id = base.restaurant_id
         AND (c.id = base.channel_id
              OR (base.channel_id IS NULL AND c.channel_type = 'own' AND c.status = 'active'))
       ORDER BY c.sort_order, c.id
       LIMIT 1
     ) ch ON TRUE
     WHERE o.id = $1 AND base.id = o.id AND o.order_status = 'open'`,
    [orderId]
  );

// Waives the charge (with the reason) or puts it back, then works it out
// again. Only an open delivery order; null when there is none.
const setWaived = async (client, restaurantId, orderId, { waived, reason }, userId) => {
  const result = await client.query(
    `UPDATE orders
     SET delivery_charge_waived_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
         delivery_charge_waived_by = CASE WHEN $3::boolean THEN $5::bigint ELSE NULL END,
         delivery_charge_waived_reason = CASE WHEN $3::boolean THEN $4 ELSE NULL END,
         updated_by = $5
     WHERE restaurant_id = $1 AND id = $2 AND order_type = 'delivery' AND order_status = 'open'
     RETURNING id`,
    [restaurantId, orderId, waived, reason, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  await refresh(client, orderId);

  return result.rows[0];
};

module.exports = { refresh, setWaived };
