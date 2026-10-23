// The restaurant's own online ordering page: its links, one per
// selling point (the main counter, outlet NULL, and each outlet), and the
// guest's side of a website order. The staff side — the inbox, accepting and
// rejecting — is the table-requests module's own, because a website order is
// a request in the same inbox (table_requests, channel 'website').
const crypto = require("node:crypto");
const pool = require("../../../../config/database");

const newToken = () => crypto.randomBytes(24).toString("hex");

const LINK_COLUMNS = `l.id, l.restaurant_id, l.outlet_id, l.token, l.is_enabled, l.takeaway_enabled,
       l.delivery_enabled, l.min_delivery_order, l.pickup_minutes, l.delivery_minutes,
       l.max_open_per_mobile, l.delivery_area, l.guest_note, l.updated_at,
       ou.name AS outlet_name, ou.status AS outlet_status, ou.address AS outlet_address,
       ou.contact AS outlet_phone`;

// ---------------------------------------------------------------- links (staff)

// Every selling point gets its link on first read: the main counter and each
// outlet that is open. The token is two random UUIDs (244 random bits) —
// pgcrypto is not installed, and gen_random_uuid is built in. ON CONFLICT:
// two screens opening at once both see none.
const ensureLinks = async (restaurantId) => {
  await pool.query(
    `INSERT INTO online_ordering_links (restaurant_id, outlet_id, token)
     SELECT $1, place.outlet_id,
            replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
     FROM (SELECT NULL::bigint AS outlet_id
           UNION ALL
           SELECT id FROM outlets WHERE restaurant_id = $1 AND status = 'active') place
     WHERE NOT EXISTS (SELECT 1 FROM online_ordering_links l
                       WHERE l.restaurant_id = $1 AND l.outlet_id IS NOT DISTINCT FROM place.outlet_id)
     ON CONFLICT DO NOTHING`,
    [restaurantId]
  );
};

// Links of open outlets, and of closed ones that are still switched on (so a
// manager can see and stop one), the main counter first.
const findLinks = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ${LINK_COLUMNS}
     FROM online_ordering_links l
     LEFT JOIN outlets ou ON ou.id = l.outlet_id
     WHERE l.restaurant_id = $1 AND (l.outlet_id IS NULL OR ou.status = 'active' OR l.is_enabled)
     ORDER BY l.outlet_id IS NOT NULL, ou.name, l.id`,
    [restaurantId]
  );

  return result.rows;
};

const findLink = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${LINK_COLUMNS}
     FROM online_ordering_links l
     LEFT JOIN outlets ou ON ou.id = l.outlet_id
     WHERE l.restaurant_id = $1 AND l.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Writes only the columns given ({ column: value }); the names come from the
// service's own list, never from a request.
const updateLink = async (restaurantId, id, columns, userId) => {
  const names = Object.keys(columns);
  const values = [restaurantId, id, userId, ...names.map((name) => columns[name])];
  const sets = names.map((name, index) => `${name} = $${index + 4}`);
  const result = await pool.query(
    `UPDATE online_ordering_links SET ${[...sets, "updated_by = $3"].join(", ")}
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    values
  );

  return result.rows[0] || null;
};

const replaceToken = async (restaurantId, id, userId) => {
  const result = await pool.query(
    `UPDATE online_ordering_links SET token = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, newToken(), userId]
  );

  return result.rows[0] || null;
};

// Today's online figures per link, for the settings card: how many came in,
// how many were accepted, and how many are waiting right now.
const findLinkCounts = async (restaurantId) => {
  const result = await pool.query(
    `SELECT online_link_id,
            COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS waiting,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_day,
            COUNT(*) FILTER (WHERE status = 'accepted' AND created_at > NOW() - INTERVAL '24 hours')::int
              AS accepted_last_day
     FROM table_requests
     WHERE restaurant_id = $1 AND channel = 'website' AND created_at > NOW() - INTERVAL '24 hours'
     GROUP BY online_link_id`,
    [restaurantId]
  );

  return result.rows;
};

// ---------------------------------------------------------------- the link behind a public address

// Everything the guest side needs about a link, in one read: the link, the
// place it belongs to, the restaurant and how it prices.
const GUEST_LINK_SQL = (where) => `
    SELECT ${LINK_COLUMNS},
            r.name AS restaurant_name, r.status AS restaurant_status, r.contact AS restaurant_phone,
            r.address AS restaurant_address,
            s.currency_symbol, s.tax_mode, s.timezone
     FROM online_ordering_links l
     JOIN restaurants r ON r.id = l.restaurant_id
     LEFT JOIN outlets ou ON ou.id = l.outlet_id
     LEFT JOIN restaurant_settings s ON s.restaurant_id = l.restaurant_id
     WHERE ${where}`;

const findLinkByToken = async (token) => {
  const result = await pool.query(GUEST_LINK_SQL("l.token = $1"), [token]);

  return result.rows[0] || null;
};

// The link an order was sent from, for its status page.
const findLinkById = async (id) => {
  const result = await pool.query(GUEST_LINK_SQL("l.id = $1"), [id]);

  return result.rows[0] || null;
};

// The restaurant's Website channel: the first active one. Its delivery
// charge and "free above" are what the guest is shown, and accepted orders
// are tagged with it.
const findWebsiteChannel = async (restaurantId) => {
  const result = await pool.query(
    `SELECT id, name, delivery_charge, delivery_free_above, commission_percent
     FROM sales_channels
     WHERE restaurant_id = $1 AND channel_type = 'website' AND status = 'active'
     ORDER BY sort_order, id
     LIMIT 1`,
    [restaurantId]
  );

  return result.rows[0] || null;
};

// Today's serving hours for a place: the outlet's own week if it has one,
// else the restaurant's. Today and yesterday (a dinner service running past
// midnight belongs to the day it began).
const findHours = async (restaurantId, outletId) => {
  const result = await pool.query(
    `SELECT h.day_of_week, h.is_open, to_char(h.open_time, 'HH24:MI') AS open_time,
            to_char(h.close_time, 'HH24:MI') AS close_time, h.periods
     FROM business_hours h
     WHERE h.restaurant_id = $1
       AND h.outlet_id IS NOT DISTINCT FROM (
         CASE WHEN $2::bigint IS NOT NULL AND EXISTS (
                SELECT 1 FROM business_hours o WHERE o.restaurant_id = $1 AND o.outlet_id = $2::bigint)
              THEN $2::bigint END)
     ORDER BY h.day_of_week`,
    [restaurantId, outletId || null]
  );

  return result.rows;
};

// ---------------------------------------------------------------- guest writes

const ONLINE_LOCK = "online-orders:mobile";

// What one mobile still has open with this restaurant: requests waiting for
// staff, and accepted orders not yet paid, collected or called off. Bounded
// to the last 12 hours, so a takeaway nobody closed on the till yesterday
// does not lock a regular out today.
const OPEN_FOR_MOBILE = `
  SELECT COUNT(*)::int AS count
  FROM table_requests r
  LEFT JOIN orders o ON o.id = r.order_id
  WHERE r.restaurant_id = $1 AND r.channel = 'website' AND r.guest_mobile = $2
    AND r.created_at > NOW() - INTERVAL '12 hours'
    AND (r.status IN ('pending', 'processing')
         OR (r.status = 'accepted' AND o.order_status IN ('open', 'billed')
             AND o.delivery_status IS DISTINCT FROM 'delivered'
             AND o.delivery_status IS DISTINCT FROM 'cancelled'))`;

// Writes a website order request and its dishes. The same key on the same
// link returns the request it made. One mobile's orders are counted inside a
// lock on that mobile, after the key, so a retry of an order that did go
// through is never refused as "one too many", and two taps at once cannot
// both slip under the limit.
const createOrderRequest = async (data, items, maxOpen) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2::text || ':' || $3))", [
      ONLINE_LOCK,
      data.restaurantId,
      data.guestMobile,
    ]);

    const existing = await client.query(
      `SELECT id, guest_token FROM table_requests
       WHERE online_link_id = $1 AND channel = 'website' AND client_key = $2`,
      [data.linkId, data.clientKey]
    );

    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { id: existing.rows[0].id, guestToken: existing.rows[0].guest_token, duplicate: true };
    }

    const open = await client.query(OPEN_FOR_MOBILE, [data.restaurantId, data.guestMobile]);

    if (open.rows[0].count >= maxOpen) {
      await client.query("ROLLBACK");
      return { error: "TOO_MANY_OPEN", open: open.rows[0].count };
    }

    const guestToken = newToken();
    const inserted = await client.query(
      `INSERT INTO table_requests
         (restaurant_id, outlet_id, table_id, business_day_id, request_type, client_key,
          guest_name, guest_mobile, notes, item_count, estimated_total,
          channel, online_link_id, service_type, delivery_address, delivery_landmark,
          payment_mode, delivery_charge, guest_token)
       VALUES ($1, $2, NULL, $3, 'order', $4, $5, $6, $7, $8, $9,
               'website', $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        data.restaurantId,
        data.outletId,
        data.businessDayId,
        data.clientKey,
        data.guestName,
        data.guestMobile,
        data.notes,
        data.itemCount,
        data.estimatedTotal,
        data.linkId,
        data.serviceType,
        data.address,
        data.landmark,
        data.paymentMode,
        data.deliveryCharge,
        guestToken,
      ]
    );

    const requestId = inserted.rows[0].id;

    for (const [index, item] of items.entries()) {
      await client.query(
        `INSERT INTO table_request_items
           (request_id, restaurant_id, product_id, product_variant_id, modifier_ids,
            item_name, variant_name, modifiers, food_type, quantity, notes,
            unit_price, line_total, sort_order, combo_selections)
         VALUES ($1, $2, $3, $4, $5::bigint[], $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
        [
          requestId,
          data.restaurantId,
          item.productId,
          item.productVariantId,
          item.modifierIds,
          item.itemName,
          item.variantName,
          JSON.stringify(item.modifiers),
          item.foodType,
          item.quantity,
          item.notes,
          item.unitPrice,
          item.lineTotal,
          index,
          JSON.stringify(item.comboSelections || []),
        ]
      );
    }

    await client.query("COMMIT");

    return { id: requestId, guestToken, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// One website order as its guest sees it, found by the guest's own token
// (192 random bits — the token IS the permission to look). Not by the link:
// a manager replacing a link that leaked must not blind every guest whose
// food is on its way. With how far the order it became has got — the kitchen, and for a
// delivery the dispatch desk (the deliveries module's own rule).
const findForGuest = async (guestToken, effectiveStatusSql) => {
  const result = await pool.query(
    `SELECT r.id, r.online_link_id, r.status, r.service_type, r.payment_mode, r.notes, r.reject_reason,
            r.item_count, r.estimated_total, r.delivery_charge, r.delivery_address,
            r.delivery_landmark, r.guest_name, r.created_at, r.resolved_at,
            o.order_number, o.order_status, o.kitchen_status, o.token_no,
            o.delivery_eta_minutes, o.placed_at, o.total_amount AS order_total,
            o.delivery_charge AS order_delivery_charge,
            CASE WHEN o.id IS NOT NULL AND o.order_type = 'delivery' THEN ${effectiveStatusSql("o")} END
              AS delivery_state,
            COALESCE(items.list, '[]') AS items
     FROM table_requests r
     LEFT JOIN orders o ON o.id = r.order_id
     LEFT JOIN LATERAL (
       SELECT JSON_AGG(JSON_BUILD_OBJECT(
                'name', i.item_name, 'variant', i.variant_name, 'modifiers', i.modifiers,
                'quantity', i.quantity, 'notes', i.notes, 'foodType', i.food_type,
                'lineTotal', i.line_total)
              ORDER BY i.sort_order, i.id) AS list
       FROM table_request_items i
       WHERE i.request_id = r.id
     ) items ON TRUE
     WHERE r.guest_token = $1 AND r.channel = 'website'
       AND r.created_at > NOW() - INTERVAL '3 days'`,
    [guestToken]
  );

  return result.rows[0] || null;
};

// The guest changed their mind before anyone acted on it.
const cancelForGuest = async (guestToken) => {
  const result = await pool.query(
    `UPDATE table_requests
     SET status = 'cancelled', resolved_at = NOW()
     WHERE guest_token = $1 AND channel = 'website' AND status = 'pending'
       AND created_at > NOW() - INTERVAL '3 days'
     RETURNING id`,
    [guestToken]
  );

  return result.rows[0] || null;
};

module.exports = {
  ensureLinks,
  findLinks,
  findLink,
  updateLink,
  replaceToken,
  findLinkCounts,
  findLinkByToken,
  findLinkById,
  findWebsiteChannel,
  findHours,
  createOrderRequest,
  findForGuest,
  cancelForGuest,
};
