const pool = require("../../../../config/database");
const { todayStartsSql } = require("./tradingClock");

// Statuses that still need a person. Kept in one place because the inbox, the
// summary, the guest's status screen and the bell must all agree on them.
const OPEN_STATUSES = ["pending", "processing", "acknowledged"];

// A guest's request is serialised per table while it is checked and written,
// so a double tap cannot slip two requests past the "3 waiting" limit.
const GUEST_LOCK = "table-requests:guest";

const withTransaction = async (work) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------- the table

// Everything the guest side needs about the table behind a QR code, in one
// read: the table, its floor, the restaurant and how it prices.
const findTableByToken = async (token) => {
  const result = await pool.query(
    `SELECT t.id, t.restaurant_id, t.outlet_id, t.table_no, t.status, t.table_status,
            f.name AS floor_name, f.status AS floor_status, a.name AS area_name,
            a.status AS area_status,
            r.name AS restaurant_name, r.status AS restaurant_status,
            s.currency_symbol, s.tax_mode, s.timezone, s.service_charge_percentage
     FROM dining_tables t
     JOIN restaurants r ON r.id = t.restaurant_id
     JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     LEFT JOIN restaurant_settings s ON s.restaurant_id = t.restaurant_id
     WHERE t.qr_token = $1`,
    [token]
  );

  return result.rows[0] || null;
};

// ---------------------------------------------------------------- settings

// Created on first read, so every restaurant always has a row to show.
const findSettings = async (restaurantId) => {
  const result = await pool.query(
    `INSERT INTO table_request_settings (restaurant_id)
     VALUES ($1)
     ON CONFLICT (restaurant_id) DO UPDATE SET restaurant_id = EXCLUDED.restaurant_id
     RETURNING restaurant_id, ordering_enabled, calls_enabled, guest_note, updated_at`,
    [restaurantId]
  );

  return result.rows[0];
};

const updateSettings = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO table_request_settings
       (restaurant_id, ordering_enabled, calls_enabled, guest_note, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (restaurant_id) DO UPDATE
       SET ordering_enabled = EXCLUDED.ordering_enabled,
           calls_enabled = EXCLUDED.calls_enabled,
           guest_note = EXCLUDED.guest_note,
           updated_by = EXCLUDED.updated_by
     RETURNING restaurant_id, ordering_enabled, calls_enabled, guest_note, updated_at`,
    [restaurantId, data.orderingEnabled, data.callsEnabled, data.guestNote, userId]
  );

  return result.rows[0];
};

// The open trading day of the place a QR table belongs to, and where "today"
// starts for it: when that day was opened (a kitchen serving at 00:30 is
// still on the day it opened), or local midnight when no day is open.
//
// Exactly that place's day: a table at the Jubilee Hills branch trades on
// Jubilee Hills' day, and a table that belongs to no branch on the
// restaurant's own day (outlet null). Picking "the newest open day of any
// branch" filed a no-branch table's call under whichever branch had opened
// last.
const findDayWindow = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `SELECT d.id AS business_day_id,
            COALESCE(d.opened_at,
                     date_trunc('day', NOW() AT TIME ZONE tz.zone) AT TIME ZONE tz.zone) AS since
     FROM (SELECT COALESCE(
                    (SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1),
                    'Asia/Kolkata') AS zone) tz
     LEFT JOIN LATERAL (
       SELECT id, opened_at FROM business_days
       WHERE restaurant_id = $1 AND day_status = 'open'
         AND outlet_id IS NOT DISTINCT FROM $2::bigint
       ORDER BY opened_at DESC
       LIMIT 1
     ) d ON TRUE`,
    [restaurantId, outletId || null]
  );

  return result.rows[0];
};

// What "today" means for the staff inbox: each request is judged by the
// business day of the place its table belongs to, the same day it was filed
// under (findDayWindow) — a Jubilee Hills table's request by Jubilee Hills'
// open day, a table of no outlet by the restaurant's own day, and local
// midnight for a place with no day open. The whole restaurant's "today" is
// every place's own today put together:
//   - a branch opening its day mid-service does not restart the
//     restaurant's "today" and drop what was already answered (RG-S-03);
//   - a branch day left open for three days stretches only that branch's
//     "today", not everyone's. Taking the earliest open day of any branch
//     for the whole restaurant made every table's list and counts reach back
//     three days.
//
// DAY_START is that start for each request `r`, from the open days (TODAY_FROM)
// joined in as `today_open`, with `today_clock` for local midnight (and the
// restaurant's time zone, for reading a request's local date).
//
// The owner's rule for live screens (2 Oct): the inbox shows today only. A
// request from an earlier day that nobody answered is history: it is listed
// under "Earlier days" with a date range, never among today's waiting ones.
const TODAY_FROM = (restaurantParam) => `
     CROSS JOIN (
       SELECT date_trunc('day', NOW() AT TIME ZONE z.zone) AT TIME ZONE z.zone AS midnight, z.zone,
              ${todayStartsSql(restaurantParam)} AS trading_start
       FROM (SELECT COALESCE(
                      (SELECT timezone FROM restaurant_settings WHERE restaurant_id = ${restaurantParam}),
                      'Asia/Kolkata') AS zone) z
     ) today_clock
     LEFT JOIN (
       SELECT outlet_id, MAX(opened_at) AS opened_at
       FROM business_days
       WHERE restaurant_id = ${restaurantParam} AND day_status = 'open'
       GROUP BY outlet_id
     ) today_open ON today_open.outlet_id IS NOT DISTINCT FROM r.outlet_id`;

// Never before today's trading day began (cut-off hour, orders/repositories/
// tradingClock): a business day left open since last week made every request
// since then "today", and 12-day-old QR orders were still offered with Accept.
const DAY_START = "GREATEST(COALESCE(today_open.opened_at, today_clock.midnight), today_clock.trading_start)";

// The start of "today" shown with the inbox (`since`): the outlet's own open
// day when one outlet is chosen, else the restaurant's own day; local
// midnight when that is not open. Only a label: every request is counted by
// its own place's day (TODAY_FROM).
const findInboxWindow = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `SELECT GREATEST(COALESCE(d.opened_at,
                              date_trunc('day', NOW() AT TIME ZONE tz.zone) AT TIME ZONE tz.zone),
                     ${todayStartsSql("$1")}) AS since
     FROM (SELECT COALESCE(
                    (SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1),
                    'Asia/Kolkata') AS zone) tz
     LEFT JOIN LATERAL (
       SELECT opened_at FROM business_days
       WHERE restaurant_id = $1 AND day_status = 'open'
         AND (outlet_id IS NULL OR outlet_id = $2::bigint)
       ORDER BY CASE WHEN $2::bigint IS NOT NULL AND outlet_id = $2::bigint THEN 0 ELSE 1 END,
                opened_at DESC
       LIMIT 1
     ) d ON TRUE`,
    [restaurantId, outletId || null]
  );

  return result.rows[0];
};

// ---------------------------------------------------------------- the menu

const findMenuCategories = async (restaurantId) => {
  const result = await pool.query(
    `SELECT id, name, description
     FROM categories
     WHERE restaurant_id = $1 AND status = 'active'
     ORDER BY sort_order, name`,
    [restaurantId]
  );

  return result.rows;
};

// Every dish a guest may see: switched on, in a category that is switched on.
// Sold-out dishes are included on purpose, marked, so a guest looking for the
// biryani learns it is gone tonight rather than wondering if they missed it.
const findMenuProducts = async (restaurantId) => {
  const result = await pool.query(
    `SELECT p.id, p.category_id, p.name, p.description, p.price, p.food_type,
            p.is_available, p.is_combo, p.addon_groups, p.image_path,p.availability_schedule,p.combo_choice_groups
     FROM products p
     JOIN categories c ON c.id = p.category_id AND c.status = 'active'
     WHERE p.restaurant_id = $1 AND p.status = 'active'
     ORDER BY c.sort_order, c.name, p.sort_order, p.name`,
    [restaurantId]
  );

  return result.rows;
};

const findMenuVariants = async (restaurantId) => {
  const result = await pool.query(
    `SELECT id, product_id, name, price_delta, is_default
     FROM product_variants
     WHERE restaurant_id = $1 AND status = 'active'
     ORDER BY product_id, sort_order, name`,
    [restaurantId]
  );

  return result.rows;
};

const findMenuModifiers = async (restaurantId) => {
  const result = await pool.query(
    `SELECT pm.product_id, m.id, m.name, m.price
     FROM product_modifiers pm
     JOIN modifiers m ON m.id = pm.modifier_id
     WHERE m.restaurant_id = $1 AND m.status = 'active'
     ORDER BY m.price, m.name`,
    [restaurantId]
  );

  return result.rows;
};

const findComboParts = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ci.combo_product_id, p.name, v.name AS variant_name, ci.quantity
     FROM combo_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.product_variant_id
     WHERE ci.restaurant_id = $1
     ORDER BY ci.sort_order, ci.id`,
    [restaurantId]
  );

  return result.rows;
};

// Every timed price running right now, for the whole menu in one read. The
// rules are the order service's (see priceWindow.repository findActivePrice):
// the restaurant's local clock, windows that run past midnight, a size-specific
// price beating a whole-dish one, then priority, then the newer window. Which
// row wins for which dish is settled by the service from these rows.
const findLiveOffers = async (restaurantId, timezone, outletId = null) => {
  const result = await pool.query(
    `WITH local AS (
       SELECT (NOW() AT TIME ZONE $2)::time AS at_time,
              (NOW() AT TIME ZONE $2)::date AS on_date,
              EXTRACT(DOW FROM (NOW() AT TIME ZONE $2))::smallint AS dow
     )
     SELECT i.product_id, i.product_variant_id, i.price, w.id AS window_id, w.name,
            w.priority, w.outlet_id, to_char(w.end_time, 'HH24:MI') AS ends_at
     FROM price_windows w
     JOIN price_window_items i ON i.price_window_id = w.id
     CROSS JOIN local
     WHERE w.restaurant_id = $1
       AND w.status = 'active'
         AND (w.outlet_id IS NULL OR w.outlet_id = $3)
       AND local.dow = ANY(w.days_of_week)
       AND (w.valid_from IS NULL OR local.on_date >= w.valid_from)
       AND (w.valid_to IS NULL OR local.on_date <= w.valid_to)
       AND CASE
             WHEN w.end_time > w.start_time
               THEN local.at_time >= w.start_time AND local.at_time < w.end_time
             ELSE local.at_time >= w.start_time OR local.at_time < w.end_time
           END`,
    [restaurantId, timezone, outletId]
  );

  return result.rows;
};

// ---------------------------------------------------------------- checking a guest's cart

// Only this restaurant's dishes can come back. A product id from another
// restaurant simply is not found, exactly like one that never existed.
const findProductsForCart = async (restaurantId, productIds) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.status, p.is_available, p.food_type, c.status AS category_status
     FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE p.restaurant_id = $1 AND p.id = ANY($2::bigint[])`,
    [restaurantId, productIds]
  );

  return result.rows;
};

const findVariantsForCart = async (restaurantId, productIds) => {
  const result = await pool.query(
    `SELECT id, product_id, name, status
     FROM product_variants
     WHERE restaurant_id = $1 AND product_id = ANY($2::bigint[])`,
    [restaurantId, productIds]
  );

  return result.rows;
};

// The add-ons each dish offers. The order service would take any add-on the
// restaurant owns on any dish; a guest may only pick the ones the dish lists.
const findModifierLinksForCart = async (restaurantId, productIds) => {
  const result = await pool.query(
    `SELECT pm.product_id, m.id, m.name, m.price, m.status
     FROM product_modifiers pm
     JOIN modifiers m ON m.id = pm.modifier_id
     WHERE m.restaurant_id = $1 AND pm.product_id = ANY($2::bigint[])`,
    [restaurantId, productIds]
  );

  return result.rows;
};

// ---------------------------------------------------------------- guest writes

const lockTableForGuest = (client, tableId) =>
  client.query("SELECT pg_advisory_xact_lock(hashtext($1), $2::int)", [GUEST_LOCK, tableId]);

const findByClientKey = async (db, tableId, clientKey) => {
  if (!clientKey) {
    return null;
  }

  const result = await db.query(
    "SELECT id, request_type FROM table_requests WHERE table_id = $1 AND client_key = $2",
    [tableId, clientKey]
  );

  return result.rows[0] || null;
};

// Writes an order request and its dishes. A key already used on this table
// returns the request it made instead of making another — but only if that
// was an order too: a key that made a call is not "this order, again", and
// answering with the call would tell the guest their order went through when
// nothing was sent. The waiting limit is checked inside the lock, after the
// key, so a retry of a request that did go through is never refused for being
// "one too many".
const createOrderRequest = (data, items, maxWaiting) =>
  withTransaction(async (client) => {
    await lockTableForGuest(client, data.tableId);

    const existing = await findByClientKey(client, data.tableId, data.clientKey);

    if (existing) {
      return existing.request_type === "order"
        ? { id: existing.id, duplicate: true }
        : { error: "KEY_IN_USE" };
    }

    const waiting = await client.query(
      `SELECT COUNT(*)::int AS count FROM table_requests
       WHERE table_id = $1 AND request_type = 'order' AND status IN ('pending', 'processing')`,
      [data.tableId]
    );

    if (waiting.rows[0].count >= maxWaiting) {
      return { error: "TOO_MANY_WAITING", waiting: waiting.rows[0].count };
    }

    const inserted = await client.query(
      `INSERT INTO table_requests
         (restaurant_id, outlet_id, table_id, business_day_id, request_type, client_key,
          guest_name, guest_mobile, notes, item_count, estimated_total)
       VALUES ($1, $2, $3, $4, 'order', $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        data.restaurantId,
        data.outletId,
        data.tableId,
        data.businessDayId,
        data.clientKey,
        data.guestName,
        data.guestMobile,
        data.notes,
        data.itemCount,
        data.estimatedTotal,
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

    return { id: requestId, duplicate: false };
  });

// A call for a waiter, the bill or water. If the same kind of call from this
// table is still open, this press is counted on it rather than making a
// second card for the floor to trip over. A key already used is the same
// call only if it was the same kind of call.
const createCall = (data) =>
  withTransaction(async (client) => {
    await lockTableForGuest(client, data.tableId);

    const existing = await findByClientKey(client, data.tableId, data.clientKey);

    if (existing) {
      return existing.request_type === data.requestType
        ? { id: existing.id, repeated: false, duplicate: true }
        : { error: "KEY_IN_USE" };
    }

    if (data.requestType !== "other") {
      const open = await client.query(
        `UPDATE table_requests
         SET repeat_count = repeat_count + 1, last_asked_at = NOW()
         WHERE table_id = $1 AND request_type = $2 AND status IN ('pending', 'acknowledged')
         RETURNING id`,
        [data.tableId, data.requestType]
      );

      if (open.rows[0]) {
        return { id: open.rows[0].id, repeated: true, duplicate: false };
      }
    }

    const inserted = await client.query(
      `INSERT INTO table_requests
         (restaurant_id, outlet_id, table_id, business_day_id, request_type, client_key, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        data.restaurantId,
        data.outletId,
        data.tableId,
        data.businessDayId,
        data.requestType,
        data.clientKey,
        data.notes,
      ]
    );

    return { id: inserted.rows[0].id, repeated: false, duplicate: false };
  });

// How long a guest's phone can follow a request, and how long after a table
// has paid up its guests can still see what they ordered.
const GUEST_WINDOW = "8 hours";
const PAID_GRACE = "20 minutes";

// The requests a QR token may reach: this table's, from the sitting at it now.
// The printed code outlives every meal served at the table, so without a
// bound the next party could read the last one's dishes and notes (an
// allergy, a birthday) by counting through ids. A sitting ends when the
// table's bill is paid — with a little grace, so the family paying at the
// counter still sees their order and can leave feedback — and nothing older
// than a working day is ever shown. $1 is the restaurant, $2 the table; the
// last paid bill is looked up once, from the day's orders only.
const guestVisibleSql = (alias = "r") => `
       ${alias}.created_at > NOW() - INTERVAL '${GUEST_WINDOW}'
       AND ${alias}.created_at >= COALESCE((
         SELECT MAX(paid.completed_at)
         FROM orders paid
         WHERE paid.restaurant_id = $1 AND paid.table_id = $2
           AND paid.placed_at > NOW() - INTERVAL '1 day'
           AND paid.order_status = 'completed'
           AND paid.completed_at < NOW() - INTERVAL '${PAID_GRACE}'
       ), '-infinity'::timestamptz)`;

// The guest changed their mind before anyone acted on it. Only their own
// table's request, from their own sitting, and only while it is still waiting.
const cancelForTable = async (restaurantId, tableId, id) => {
  const result = await pool.query(
    `UPDATE table_requests r
     SET status = 'cancelled', resolved_at = NOW()
     WHERE r.restaurant_id = $1 AND r.table_id = $2 AND r.id = $3
       AND ${guestVisibleSql("r")}
       AND ((r.request_type = 'order' AND r.status = 'pending')
            OR (r.request_type <> 'order' AND r.status IN ('pending', 'acknowledged')))
     RETURNING r.id`,
    [restaurantId, tableId, id]
  );

  return result.rows[0] || null;
};

// What a guest's phone may read back: its own table's requests, from its own
// sitting, and nothing else. The table comes from the QR code, never from the
// request id, so a guessed id belonging to another table is simply not found.
//
// For an accepted order it also reads how far the kitchen has taken the
// request's OWN lines — the order lines it became — and whether the order is
// on the kitchen display at all, which decides whether those lines' statuses
// mean anything (only the display moves them).
const findForTable = async (restaurantId, tableId, ids) => {
  const result = await pool.query(
    `SELECT r.id, r.request_type, r.status, r.notes, r.reject_reason, r.item_count,
            r.estimated_total, r.repeat_count, r.created_at, r.acknowledged_at,
            r.resolved_at, r.last_asked_at, r.kitchen_reached,
            o.order_number, o.order_status, o.kitchen_status,
            COALESCE(own.linked, 0) AS own_linked,
            COALESCE(own.live, 0) AS own_live,
            COALESCE(own.served, 0) AS own_served,
            COALESCE(own.ready, 0) AS own_ready,
            (r.status = 'accepted'
             AND EXISTS (SELECT 1 FROM kots k WHERE k.order_id = r.order_id)) AS on_kitchen_display,
            -- The display has cut a ticket for this request's round: a ticket
            -- carries its lines' own time (to the millisecond), so one at or
            -- after the request's newest line covers it.
            (r.status = 'accepted' AND own.latest IS NOT NULL
             AND EXISTS (SELECT 1 FROM kots k
                         WHERE k.order_id = r.order_id AND k.kot_status <> 'cancelled'
                           AND k.created_at >= own.latest - INTERVAL '1 millisecond')) AS own_ticketed,
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
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS linked,
              COUNT(*) FILTER (WHERE oi.item_status <> 'cancelled')::int AS live,
              COUNT(*) FILTER (WHERE oi.item_status = 'served')::int AS served,
              COUNT(*) FILTER (WHERE oi.item_status IN ('ready', 'served'))::int AS ready,
              MAX(oi.created_at) FILTER (WHERE oi.item_status <> 'cancelled') AS latest
       FROM table_request_items ri
       JOIN order_items oi ON oi.id = ri.order_item_id
       WHERE ri.request_id = r.id
     ) own ON r.status = 'accepted'
     WHERE r.restaurant_id = $1 AND r.table_id = $2 AND r.id = ANY($3::bigint[])
       AND ${guestVisibleSql("r")}
     ORDER BY r.created_at DESC`,
    [restaurantId, tableId, ids]
  );

  return result.rows;
};

// A second submission of the same feedback within a couple of minutes is the
// same feedback: a guest who tapped Send twice, not two opinions.
const findRecentFeedback = async (restaurantId, rating, comments) => {
  const result = await pool.query(
    `SELECT id FROM feedback
     WHERE restaurant_id = $1 AND source = 'qr' AND rating = $2
       AND comments IS NOT DISTINCT FROM $3
       AND created_at > NOW() - INTERVAL '2 minutes'
     LIMIT 1`,
    [restaurantId, rating, comments]
  );

  return result.rows[0] ? result.rows[0].id : null;
};

// ---------------------------------------------------------------- staff side

const STAFF_COLUMNS = `r.id, r.table_id, r.outlet_id, r.request_type, r.status, r.guest_name,
            r.guest_mobile, r.notes, r.item_count, r.estimated_total, r.order_id,
            r.order_action, r.reject_reason, r.repeat_count, r.last_asked_at,
            r.acknowledged_at, r.resolved_at, r.created_at, r.updated_at,
            t.table_no, f.name AS floor_name, a.name AS area_name,
            o.order_number, ack.name AS acknowledged_by_name, res.name AS resolved_by_name,
            live.id AS live_order_id, live.order_number AS live_order_number,
            live.order_status AS live_order_status, live.outlet_id AS live_order_outlet_id,
            live.outlet_name AS live_order_outlet_name,
            r.channel, r.service_type, r.delivery_address, r.delivery_landmark, r.payment_mode,
            r.delivery_charge, r.online_link_id, place.name AS outlet_name,
            COALESCE(items.list, '[]') AS items`;

// Joined once for the list and once for a single request, so both describe a
// request the same way. A website order has no table (SW-A-22), so the table
// is a LEFT JOIN; it names the selling point it was sent to instead.
const STAFF_JOINS = `
     LEFT JOIN dining_tables t ON t.id = r.table_id
     LEFT JOIN outlets place ON place.id = r.outlet_id
     LEFT JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     LEFT JOIN orders o ON o.id = r.order_id
     LEFT JOIN users ack ON ack.id = r.acknowledged_by
     LEFT JOIN users res ON res.id = r.resolved_by
     LEFT JOIN LATERAL (
       SELECT JSON_AGG(JSON_BUILD_OBJECT(
                'id', i.id, 'productId', i.product_id, 'productVariantId', i.product_variant_id,
                'modifierIds', i.modifier_ids, 'comboSelections', i.combo_selections, 'name', i.item_name, 'variant', i.variant_name, 'modifiers', i.modifiers,
                'quantity', i.quantity, 'notes', i.notes, 'foodType', i.food_type,
                'unitPrice', i.unit_price, 'lineTotal', i.line_total)
              ORDER BY i.sort_order, i.id) AS list
       FROM table_request_items i
       WHERE i.request_id = r.id
     ) items ON TRUE
     -- What the table has running right now, while the request still waits:
     -- it tells the person accepting whether they are opening a new order or
     -- adding to one, and gives "Wants the bill" a bill to open.
     -- With the outlet it belongs to: a table shared by every outlet may have
     -- another outlet's order running on it, which only that outlet adds to.
     LEFT JOIN LATERAL (
       SELECT o2.id, o2.order_number, o2.order_status, o2.outlet_id, ou2.name AS outlet_name
       FROM orders o2
       LEFT JOIN outlets ou2 ON ou2.id = o2.outlet_id
       WHERE o2.restaurant_id = r.restaurant_id AND o2.table_id = r.table_id
         AND o2.order_status IN ('open', 'billed')
       ORDER BY o2.placed_at DESC
       LIMIT 1
     ) live ON r.status IN ('pending', 'processing', 'acknowledged')`;

// Staff working in one outlet see that outlet's tables. A table with no
// outlet (a restaurant with one location, or a table never assigned) belongs
// to everyone. Every read and every action goes through this, so a captain
// pinned to one branch cannot see — or accept, or answer — another branch's
// guests: to them, those requests do not exist. A null outlet means the
// whole restaurant.
//
// A website order with no outlet is not "everyone's" like an unassigned
// table: it was sent to the main counter's own link, and the main counter is
// a selling point of its own (its kitchen, its day). Staff working one outlet
// neither see nor accept it — accepting it from there would still cook and
// bill it at the main counter, out of their sight.
const outletScopeSql = (param, alias = "r") =>
  `(${param}::bigint IS NULL OR ${alias}.outlet_id = ${param}::bigint
    OR (${alias}.outlet_id IS NULL AND ${alias}.channel = 'qr'))`;

// Sent before the business day it would be served on began: a guest who
// ordered or called on an earlier day. Never news, never accepted.
const FROM_EARLIER_DAY = `(r.created_at < ${DAY_START}) AS from_earlier_day, today_clock.zone AS time_zone`;

// The business date a request was filed under (the day of the place its table
// belongs to), or its local calendar date when no day was open: a QR order at
// 00:30 during the 1st's late service is one of the 1st's requests.
const FILED_DATE = `COALESCE(filed_day.business_date, (r.created_at AT TIME ZONE today_clock.zone)::date)`;

// view: "pending" = today's requests still waiting; "today" = everything since
// the trading day opened; "history" = the requests of earlier days (sent
// before their place's day opened — never today's, whatever the range) in a
// date range, newest first (`from`/`to`, business dates, both inclusive; the
// screen's "Earlier days"); "all" = every request, newest waiting first (kept
// for the API, and it takes `from`/`to` too). In the live views waiting requests come first and
// oldest first — the table that has waited longest is the one to go to.
// `offset` pages through the list; `total` counts every match.
const findAll = async (restaurantId, filters) => {
  const run = (limit, offset) =>
    pool.query(
      `SELECT ${STAFF_COLUMNS}, ${FROM_EARLIER_DAY},
              COUNT(*) OVER ()::int AS total_count
       FROM table_requests r
       ${STAFF_JOINS}
       ${TODAY_FROM("$1")}
       LEFT JOIN business_days filed_day ON filed_day.id = r.business_day_id
       WHERE r.restaurant_id = $1
         AND ${outletScopeSql("$6")}
         AND (($2::text = 'pending' AND r.status = ANY($5::text[]) AND r.created_at >= ${DAY_START})
              OR ($2::text = 'today' AND r.created_at >= ${DAY_START})
              OR ($2::text = 'history' AND r.created_at < ${DAY_START})
              OR $2::text = 'all')
         AND ($3::text IS NULL
              OR ($3::text = 'order' AND r.request_type = 'order')
              OR ($3::text = 'online' AND r.channel = 'website')
              OR ($3::text = 'service' AND r.request_type <> 'order'))
         AND ($8::date IS NULL OR ${FILED_DATE} >= $8::date)
         AND ($9::date IS NULL OR ${FILED_DATE} <= $9::date)
         AND COALESCE(r.channel, 'qr') = ANY($10::text[])
       ORDER BY CASE WHEN $2::text = 'history' THEN NULL ELSE (r.status = ANY($5::text[])) END DESC,
                CASE WHEN $2::text <> 'history' AND r.status = ANY($5::text[]) THEN r.created_at END ASC,
                r.created_at DESC, r.id DESC
       LIMIT $4 OFFSET $7`,
      [
        restaurantId,
        filters.view,
        filters.type,
        limit,
        OPEN_STATUSES,
        filters.outletId || null,
        offset,
        filters.from || null,
        filters.to || null,
        // Which inboxes are switched on (Settings -> Features): table QR
        // codes ('qr') and the online ordering page ('website').
        filters.channels || ["qr", "website"],
      ]
    );

  const offset = filters.offset || 0;
  const result = await run(filters.limit, offset);
  let total = result.rows.length > 0 ? result.rows[0].total_count : 0;

  // A page past the end has no rows to carry the count: ask for it alone.
  if (result.rows.length === 0 && offset > 0) {
    const first = await run(1, 0);
    total = first.rows.length > 0 ? first.rows[0].total_count : 0;
  }

  return { rows: result.rows, total };
};

const findById = async (restaurantId, id, outletId = null) => {
  const result = await pool.query(
    `SELECT ${STAFF_COLUMNS}, ${FROM_EARLIER_DAY}
     FROM table_requests r
     ${STAFF_JOINS}
     ${TODAY_FROM("$1")}
     WHERE r.restaurant_id = $1 AND r.id = $2 AND ${outletScopeSql("$3")}`,
    [restaurantId, id, outletId]
  );

  return result.rows[0] || null;
};

// The inbox's counters and the figures a manager judges the floor by: how many
// are waiting, how long the oldest has waited, and how fast staff answer.
// Response time is request to first action — acknowledged for a call,
// accepted or rejected for an order.
const summary = async (restaurantId, outletId = null, channels = ["qr", "website"]) => {
  // "Today" is each request's own place's business day (TODAY_FROM).
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE request_type = 'order' AND status IN ('pending', 'processing'))::int
         AS pending_orders,
       MIN(created_at) FILTER (WHERE request_type = 'order' AND status IN ('pending', 'processing'))
         AS oldest_order_at,
       COUNT(*) FILTER (WHERE request_type <> 'order' AND status IN ('pending', 'acknowledged'))::int
         AS open_calls,
       COUNT(*) FILTER (WHERE request_type <> 'order' AND status = 'pending')::int
         AS unanswered_calls,
       MIN(created_at) FILTER (WHERE request_type <> 'order' AND status IN ('pending', 'acknowledged'))
         AS oldest_call_at,
       COUNT(*) FILTER (WHERE request_type = 'bill' AND status IN ('pending', 'acknowledged'))::int
         AS open_bill_calls,
       COUNT(*) FILTER (WHERE request_type = 'water' AND status IN ('pending', 'acknowledged'))::int
         AS open_water_calls,
       COUNT(*) FILTER (WHERE request_type = 'call_waiter' AND status IN ('pending', 'acknowledged'))::int
         AS open_waiter_calls,
       COUNT(*) FILTER (WHERE request_type = 'other' AND status IN ('pending', 'acknowledged'))::int
         AS open_other_calls,
       COUNT(*) FILTER (WHERE request_type = 'order' AND today)::int AS orders_today,
       COUNT(*) FILTER (WHERE request_type = 'order' AND status = 'accepted' AND today)::int
         AS accepted_today,
       COALESCE(SUM(estimated_total)
         FILTER (WHERE request_type = 'order' AND status = 'accepted' AND today), 0)
         AS accepted_value_today,
       COUNT(*) FILTER (WHERE request_type = 'order' AND status = 'rejected' AND today)::int
         AS rejected_today,
       COUNT(*) FILTER (WHERE request_type <> 'order' AND today)::int AS calls_today,
       COUNT(*) FILTER (WHERE request_type <> 'order' AND status = 'done' AND today)::int
         AS calls_done_today,
       ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(acknowledged_at, resolved_at) - created_at)))
         FILTER (WHERE today
                 AND status IN ('accepted', 'rejected', 'acknowledged', 'done')))::int
         AS avg_response_seconds
     FROM (
       SELECT r.request_type, r.status, r.created_at, r.estimated_total,
              r.acknowledged_at, r.resolved_at,
              r.created_at >= ${DAY_START} AS today
       FROM table_requests r
       ${TODAY_FROM("$1")}
       WHERE r.restaurant_id = $1
         AND ${outletScopeSql("$2")}
         AND COALESCE(r.channel, 'qr') = ANY($3::text[])
     ) req
     -- Today only, waiting ones included: a request an earlier day left
     -- unanswered is history, not a guest waiting now (the owner's rule for
     -- live screens).
     WHERE req.today`,
    [restaurantId, outletId, channels]
  );

  return result.rows[0];
};

// Takes a waiting order request for this person to accept. Only one person
// can hold it: a second "Accept" at the same moment finds nothing to take. A
// claim abandoned by a crash mid-way is taken back after two minutes.
const claimForAccept = async (restaurantId, id, userId, outletId = null) => {
  const result = await pool.query(
    `UPDATE table_requests r
     SET status = 'processing', updated_by = $3
     WHERE r.restaurant_id = $1 AND r.id = $2 AND r.request_type = 'order'
       AND ${outletScopeSql("$4")}
       AND (r.status = 'pending'
            OR (r.status = 'processing' AND r.updated_at < NOW() - INTERVAL '2 minutes'))
     RETURNING r.id`,
    [restaurantId, id, userId, outletId]
  );

  return result.rows[0] || null;
};

// Acceptance failed (a dish sold out, the day is closed...): the request goes
// back to waiting, exactly as it was, so it can be rejected with a reason.
const releaseClaim = (restaurantId, id) =>
  pool.query(
    `UPDATE table_requests SET status = 'pending'
     WHERE restaurant_id = $1 AND id = $2 AND status = 'processing'`,
    [restaurantId, id]
  );

// Accepted, and which order line each of the guest's dishes became, in one
// go: the guest's status screen follows those lines from the first poll.
const markAccepted = (restaurantId, id, orderId, action, userId, links = []) =>
  withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE table_requests
       SET status = 'accepted', order_id = $3, order_action = $4,
           resolved_at = NOW(), resolved_by = $5, updated_by = $5
       WHERE restaurant_id = $1 AND id = $2 AND status = 'processing'
       RETURNING id`,
      [restaurantId, id, orderId, action, userId]
    );

    if (result.rows[0] && links.length > 0) {
      await client.query(
        `UPDATE table_request_items i SET order_item_id = v.order_item_id
         FROM UNNEST($2::bigint[], $3::bigint[]) AS v(id, order_item_id)
         WHERE i.id = v.id AND i.request_id = $1`,
        [id, links.map((link) => link.requestItemId), links.map((link) => link.orderItemId)]
      );
    }

    return result.rows[0] || null;
  });

const reject = async (restaurantId, id, reason, userId, outletId = null) => {
  const result = await pool.query(
    `UPDATE table_requests r
     SET status = 'rejected', reject_reason = $3, resolved_at = NOW(),
         resolved_by = $4, updated_by = $4
     WHERE r.restaurant_id = $1 AND r.id = $2 AND r.request_type = 'order' AND r.status = 'pending'
       AND ${outletScopeSql("$5")}
     RETURNING r.id`,
    [restaurantId, id, reason, userId, outletId]
  );

  return result.rows[0] || null;
};

const acknowledge = async (restaurantId, id, userId, outletId = null) => {
  const result = await pool.query(
    `UPDATE table_requests r
     SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $3, updated_by = $3
     WHERE r.restaurant_id = $1 AND r.id = $2 AND r.request_type <> 'order' AND r.status = 'pending'
       AND ${outletScopeSql("$4")}
     RETURNING r.id`,
    [restaurantId, id, userId, outletId]
  );

  return result.rows[0] || null;
};

// Done straight from waiting is allowed: the waiter who walked past and
// poured the water does not need to press two buttons.
const markDone = async (restaurantId, id, userId, outletId = null) => {
  const result = await pool.query(
    `UPDATE table_requests r
     SET status = 'done', resolved_at = NOW(), resolved_by = $3, updated_by = $3,
         acknowledged_at = COALESCE(r.acknowledged_at, NOW()),
         acknowledged_by = COALESCE(r.acknowledged_by, $3)
     WHERE r.restaurant_id = $1 AND r.id = $2 AND r.request_type <> 'order'
       AND r.status IN ('pending', 'acknowledged')
       AND ${outletScopeSql("$4")}
     RETURNING r.id`,
    [restaurantId, id, userId, outletId]
  );

  return result.rows[0] || null;
};

// ---------------------------------------------------------------- accepting into an order

// The order the table is eating on right now, if any: open, or billed and not
// yet paid. A table with a paid or cancelled order is free.
const findLiveOrder = async (restaurantId, tableId) => {
  const result = await pool.query(
    `SELECT o.id, o.order_number, o.order_status, o.outlet_id, ou.name AS outlet_name,
            (SELECT b.bill_number FROM bills b
             WHERE b.order_id = o.id AND b.bill_status <> 'void'
             ORDER BY b.id DESC LIMIT 1) AS bill_number
     FROM orders o
     LEFT JOIN outlets ou ON ou.id = o.outlet_id
     WHERE o.restaurant_id = $1 AND o.table_id = $2
       AND o.order_status IN ('open', 'billed')
     ORDER BY o.placed_at DESC
     LIMIT 1`,
    [restaurantId, tableId]
  );

  return result.rows[0] || null;
};

// Before a new round goes onto an order whose earlier dishes were already
// ready or served: the requests already accepted into it keep what they had
// reached, so their guests are not told "being prepared" again when the
// order's kitchen status goes back to pending for the new dishes. Only when
// no ticket is still open on the kitchen display: if one is, each request is
// followed by its own lines' tickets anyway.
const rememberReached = (restaurantId, orderId) =>
  pool.query(
    `UPDATE table_requests r
     SET kitchen_reached = o.kitchen_status
     FROM orders o
     WHERE o.id = r.order_id AND o.restaurant_id = $1 AND o.id = $2
       AND r.status = 'accepted'
       AND o.kitchen_status IN ('ready', 'served')
       AND NOT EXISTS (SELECT 1 FROM kots k
                       WHERE k.order_id = o.id AND k.kot_status IN ('new', 'cooking', 'ready'))
       AND (r.kitchen_reached IS NULL OR (r.kitchen_reached = 'ready' AND o.kitchen_status = 'served'))`,
    [restaurantId, orderId]
  );

// Requests still waiting from an earlier day (QR orders not accepted, calls
// not done), for closing them in one go.
const findEarlierWaiting = async (restaurantId, outletId = null, channels = ["qr", "website"]) => {
  const result = await pool.query(
    `SELECT r.id, r.request_type, r.status
     FROM table_requests r
     ${TODAY_FROM("$1")}
     WHERE r.restaurant_id = $1
       AND ${outletScopeSql("$2")}
       AND COALESCE(r.channel, 'qr') = ANY($3::text[])
       AND r.created_at < ${DAY_START}
       AND ((r.request_type = 'order' AND r.status = 'pending')
            OR (r.request_type <> 'order' AND r.status IN ('pending', 'acknowledged')))
     ORDER BY r.created_at
     LIMIT 2000`,
    [restaurantId, outletId, channels]
  );

  return result.rows;
};

module.exports = {
  findEarlierWaiting,
  OPEN_STATUSES,
  // "Today" for each request, for the bell (notifications/providers).
  TODAY_FROM,
  DAY_START,
  findTableByToken,
  findSettings,
  updateSettings,
  findDayWindow,
  findInboxWindow,
  findMenuCategories,
  findMenuProducts,
  findMenuVariants,
  findMenuModifiers,
  findComboParts,
  findLiveOffers,
  findProductsForCart,
  findVariantsForCart,
  findModifierLinksForCart,
  createOrderRequest,
  createCall,
  cancelForTable,
  findForTable,
  findRecentFeedback,
  findAll,
  findById,
  summary,
  claimForAccept,
  releaseClaim,
  markAccepted,
  reject,
  acknowledge,
  markDone,
  findLiveOrder,
  rememberReached,
};
