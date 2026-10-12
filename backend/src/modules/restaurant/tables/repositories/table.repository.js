const pool = require("../../../../config/database");
const { todayStartsSql } = require("../../orders/repositories/tradingClock");

// How long a settled table is held as "Cleaning" when a restaurant has never
// set its own figure (see floor_settings).
const DEFAULT_CLEANING_MINUTES = 10;

// --- Floors ---

const findFloors = async (restaurantId) => {
  const result = await pool.query(
    `SELECT f.id, f.name, f.sort_order, f.status,
            COUNT(DISTINCT a.id)::int AS area_count,
            COUNT(DISTINCT t.id)::int AS table_count
     FROM floors f
     LEFT JOIN dining_areas a ON a.floor_id = f.id
     LEFT JOIN dining_tables t ON t.floor_id = f.id
     WHERE f.restaurant_id = $1
     GROUP BY f.id
     ORDER BY f.sort_order, f.name`,
    [restaurantId]
  );

  return result.rows;
};

const findFloorById = async (restaurantId, id) => {
  const result = await pool.query(
    "SELECT id, name, sort_order, status FROM floors WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createFloor = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO floors (restaurant_id, name, sort_order, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, name, sort_order, status`,
    [restaurantId, data.name, data.sortOrder, data.status, userId]
  );

  return result.rows[0];
};

const updateFloor = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE floors SET name = $3, sort_order = $4, status = $5, updated_by = $6
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, name, sort_order, status`,
    [restaurantId, id, data.name, data.sortOrder, data.status, userId]
  );

  return result.rows[0] || null;
};

const countFloorChildren = async (floorId) => {
  const result = await pool.query(
    `SELECT (SELECT COUNT(*) FROM dining_areas WHERE floor_id = $1)::int AS areas,
            (SELECT COUNT(*) FROM dining_tables WHERE floor_id = $1)::int AS tables`,
    [floorId]
  );

  return result.rows[0];
};

const removeFloor = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM floors WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Dining areas ---

const findAreas = async (restaurantId) => {
  const result = await pool.query(
    `SELECT a.id, a.floor_id, a.name, a.sort_order, a.status,
            f.name AS floor_name,
            COUNT(t.id)::int AS table_count
     FROM dining_areas a
     JOIN floors f ON f.id = a.floor_id
     LEFT JOIN dining_tables t ON t.area_id = a.id
     WHERE a.restaurant_id = $1
     GROUP BY a.id, f.name, f.sort_order
     ORDER BY f.sort_order, f.name, a.sort_order, a.name`,
    [restaurantId]
  );

  return result.rows;
};

const findAreaById = async (restaurantId, id) => {
  const result = await pool.query(
    "SELECT id, floor_id, name, sort_order, status FROM dining_areas WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createArea = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO dining_areas (restaurant_id, floor_id, name, sort_order, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id, floor_id, name, sort_order, status`,
    [restaurantId, data.floorId, data.name, data.sortOrder, data.status, userId]
  );

  return result.rows[0];
};

const updateArea = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE dining_areas SET floor_id = $3, name = $4, sort_order = $5, status = $6, updated_by = $7
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id, floor_id, name, sort_order, status`,
    [restaurantId, id, data.floorId, data.name, data.sortOrder, data.status, userId]
  );

  return result.rows[0] || null;
};

// The tables on a floor or in an area that are not this outlet's own: shared
// by every outlet (no outlet), or another outlet's. Someone working in one
// outlet may close or rename a floor only when nothing on it belongs to
// anyone else.
const countOthersTables = async (restaurantId, { floorId = null, areaId = null }, outletId) => {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE t.outlet_id IS NULL)::int AS shared,
            COUNT(*) FILTER (WHERE t.outlet_id IS NOT NULL AND t.outlet_id <> $4)::int AS other
     FROM dining_tables t
     WHERE t.restaurant_id = $1
       AND ($2::bigint IS NULL OR t.floor_id = $2)
       AND ($3::bigint IS NULL OR t.area_id = $3)`,
    [restaurantId, floorId, areaId, outletId]
  );

  return result.rows[0];
};

// How many tables in use an outlet has of its own. An outlet with tables of
// its own seats its guests there; one with none shares the main dining room
// (the tables with no outlet). See order.service refuseOtherOutletTable.
const countOutletTables = async (restaurantId, outletId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM dining_tables
     WHERE restaurant_id = $1 AND outlet_id = $2 AND status = 'active'`,
    [restaurantId, outletId]
  );

  return result.rows[0].count;
};

const countAreaTables = async (areaId) => {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM dining_tables WHERE area_id = $1",
    [areaId]
  );

  return result.rows[0].count;
};

const removeArea = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM dining_areas WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// --- Tables ---

const TABLE_COLUMNS = `t.id, t.floor_id, t.area_id, t.outlet_id, t.table_no, t.capacity,
                       t.qr_token, t.table_status, t.status, t.ready_at`;

// A table can only be seated when it, its floor and its area are all switched
// on. Closing the terrace for the monsoon closes every table on it.
const SERVICE_COLUMNS = `f.status AS floor_status, a.status AS area_status`;

const findTables = async (restaurantId, filters = {}) => {
  const result = await pool.query(
    `SELECT ${TABLE_COLUMNS}, ${SERVICE_COLUMNS},
            f.name AS floor_name, a.name AS area_name,
            f.sort_order AS floor_sort,
            live.order_id, live.order_number, live.placed_at, live.guest_count,
            live.order_total, live.bill_id, live.bill_status, live.bill_number,
            live.bill_total, live.bill_paid, live.bills_settled, live.unbilled_quantity,
            joined.joined_order_id, joined.joined_order_number, joined.joined_placed_at,
            joined.joined_guest_count, joined.joined_order_total, joined.joined_order_status,
            joined.joined_main_table_no,
            booking.booking_id, booking.booking_reference, booking.booking_guest,
            booking.booking_party, booking.booking_time, booking.booking_date,
            booking.booking_status,
            settled.settled_order_id, settled.settled_order_number, settled.settled_at,
            settled.settled_guests, settled.turn_ends_at,
            CEIL(EXTRACT(EPOCH FROM (settled.turn_ends_at - NOW())) / 60)::int AS turn_minutes_left,
            -- The party has been here since an earlier trading day: an order
            -- nobody billed or closed (see orders/repositories/tradingClock).
            (COALESCE(live.placed_at, joined.joined_placed_at) < clock.today_starts) AS earlier_day
     FROM dining_tables t
     JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     -- The restaurant's own wall clock: bookings are kept in local time, and
     -- the server may not be in the same timezone as the dining room.
     CROSS JOIN (
       SELECT NOW() AT TIME ZONE COALESCE(
                (SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1),
                'Asia/Kolkata'
              ) AS local_now,
              COALESCE(
                (SELECT cleaning_minutes FROM floor_settings WHERE restaurant_id = $1),
                ${DEFAULT_CLEANING_MINUTES}
              ) AS cleaning_minutes,
              ${todayStartsSql("$1")} AS today_starts
     ) clock
     -- What is happening on the table right now. A floor plan that only knows
     -- "occupied" is a seating chart; a waiter needs to know how long they
     -- have been sitting there and whether the bill has been raised.
     --
     -- An order may be billed in parts (one bill per guest, or the dishes
     -- served so far): every live bill counts, and so do the dishes no bill
     -- covers yet. A table whose one part-bill is paid still has food to bill.
     LEFT JOIN LATERAL (
       SELECT o.id AS order_id, o.order_number, o.placed_at, o.guest_count,
              o.total_amount AS order_total,
              b.bill_id, b.bill_status, b.bill_number, b.bill_total, b.bill_paid,
              b.bills_settled,
              (SELECT COALESCE(SUM(oi.quantity), 0)
                      - COALESCE((SELECT SUM(bi.quantity)
                                  FROM bill_items bi
                                  JOIN bills bb ON bb.id = bi.bill_id
                                  WHERE bb.order_id = o.id AND bb.bill_status <> 'void'), 0)
               FROM order_items oi
               WHERE oi.order_id = o.id AND oi.item_status <> 'cancelled') AS unbilled_quantity
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT MAX(bb.id) AS bill_id,
                (ARRAY_AGG(bb.bill_status ORDER BY bb.id DESC))[1] AS bill_status,
                STRING_AGG(bb.bill_number, ', ' ORDER BY bb.id) AS bill_number,
                SUM(bb.total_amount) AS bill_total,
                SUM(bb.paid_amount) AS bill_paid,
                -- Every live bill paid, or with less than a paisa left on it.
                BOOL_AND(bb.bill_status = 'paid' OR bb.total_amount - bb.paid_amount < 0.01) AS bills_settled
         FROM bills bb
         WHERE bb.order_id = o.id AND bb.bill_status <> 'void'
       ) b ON TRUE
       -- Open or billed, said that way so the live-orders index answers it
       -- (idx_orders_table_live): "not completed or cancelled" read every
       -- one of the restaurant's running orders once per table.
       WHERE o.table_id = t.id
         AND o.restaurant_id = $1
         AND o.order_status IN ('open', 'billed')
       ORDER BY o.placed_at DESC
       LIMIT 1
     ) live ON TRUE
     -- A table pushed against another party's table (joined to its order):
     -- that party is using it, so the floor plan shows it running, with the
     -- table its order is on. Its own running order, if any, comes first.
     LEFT JOIN LATERAL (
       SELECT o.id AS joined_order_id, o.order_number AS joined_order_number,
              o.placed_at AS joined_placed_at, o.guest_count AS joined_guest_count,
              o.total_amount AS joined_order_total, o.order_status AS joined_order_status,
              mt.table_no AS joined_main_table_no
       FROM order_joined_tables j
       JOIN orders o ON o.id = j.order_id
       LEFT JOIN dining_tables mt ON mt.id = o.table_id
       WHERE j.table_id = t.id AND j.released_at IS NULL
         AND o.restaurant_id = $1 AND o.order_status IN ('open', 'billed')
       ORDER BY j.id DESC
       LIMIT 1
     ) joined ON TRUE
     -- The party the table is being held for: due within the hour, or up to
     -- half an hour late and still not seated. Further out than that, the
     -- table is free to use and the floor plan must say so.
     LEFT JOIN LATERAL (
       SELECT r.id AS booking_id, r.reference_no AS booking_reference,
              r.guest_name AS booking_guest, r.party_size AS booking_party,
              to_char(r.start_time, 'HH24:MI') AS booking_time,
              r.reservation_date AS booking_date, r.status AS booking_status
       FROM reservations r
       -- Its main table, or one of the other tables a large party holds.
       WHERE (r.table_id = t.id
              OR EXISTS (SELECT 1 FROM reservation_tables x
                         WHERE x.reservation_id = r.id AND x.table_id = t.id))
         AND r.restaurant_id = $1
         AND r.status IN ('booked', 'confirmed')
         AND r.starts_at BETWEEN clock.local_now - INTERVAL '30 minutes'
                             AND clock.local_now + INTERVAL '60 minutes'
       ORDER BY r.starts_at
       LIMIT 1
     ) booking ON TRUE
     -- The turn: the last party here paid within the cleaning window and
     -- nobody has marked the table ready since. Settling closes the order,
     -- so "settled" is the order's completion time.
     LEFT JOIN LATERAL (
       SELECT o.id AS settled_order_id, o.order_number AS settled_order_number,
              o.completed_at AS settled_at, o.guest_count AS settled_guests,
              o.completed_at + make_interval(mins => clock.cleaning_minutes) AS turn_ends_at
       FROM orders o
       WHERE o.table_id = t.id
         AND o.restaurant_id = $1
         AND o.order_status = 'completed'
         AND o.completed_at > NOW() - make_interval(mins => clock.cleaning_minutes)
         AND (t.ready_at IS NULL OR o.completed_at > t.ready_at)
       ORDER BY o.completed_at DESC
       LIMIT 1
     ) settled ON TRUE
     WHERE t.restaurant_id = $1
       AND ($2::bigint IS NULL OR t.floor_id = $2)
       AND ($3::bigint IS NULL OR t.id = $3)
       -- One outlet's floor: its own tables and those that belong to no outlet.
       AND ($4::bigint IS NULL OR t.outlet_id IS NULL OR t.outlet_id = $4)
     ORDER BY f.sort_order, f.name, t.table_no`,
    [restaurantId, filters.floorId || null, filters.tableId || null, filters.outletId || null]
  );

  return result.rows;
};

const findTableById = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${TABLE_COLUMNS}, ${SERVICE_COLUMNS}, f.name AS floor_name, a.name AS area_name
     FROM dining_tables t
     JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     WHERE t.restaurant_id = $1 AND t.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const createTable = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO dining_tables
       (restaurant_id, outlet_id, floor_id, area_id, table_no, capacity, qr_token, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING id`,
    [
      restaurantId,
      data.outletId,
      data.floorId,
      data.areaId,
      data.tableNo,
      data.capacity,
      data.qrToken,
      data.status,
      userId,
    ]
  );

  return findTableById(restaurantId, result.rows[0].id);
};

const updateTable = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE dining_tables
     SET outlet_id = $3, floor_id = $4, area_id = $5, table_no = $6, capacity = $7,
         status = $8, updated_by = $9
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [
      restaurantId,
      id,
      data.outletId,
      data.floorId,
      data.areaId,
      data.tableNo,
      data.capacity,
      data.status,
      userId,
    ]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findTableById(restaurantId, id);
};

// A new token invalidates every QR code already printed for that table.
const regenerateQrToken = async (restaurantId, id, qrToken, userId) => {
  const result = await pool.query(
    `UPDATE dining_tables SET qr_token = $3, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, qrToken, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return findTableById(restaurantId, id);
};

const removeTable = async (restaurantId, id) => {
  const result = await pool.query(
    "DELETE FROM dining_tables WHERE restaurant_id = $1 AND id = $2 RETURNING id",
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Whether any order, running or long settled, was ever rung up on this table.
// Those orders point at the table for good (bills, reports and the guest's
// history read through them), so such a table is switched off, not deleted.
const hasOrderHistory = async (restaurantId, id) => {
  const result = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM orders WHERE restaurant_id = $1 AND table_id = $2) AS used",
    [restaurantId, id]
  );

  return result.rows[0].used;
};

// --- The turn between parties ---

// The order still running on a table, if any. A table with guests on it is
// not "ready", whatever anyone taps.
const findLiveOrder = async (restaurantId, tableId) => {
  const result = await pool.query(
    `SELECT id, order_number, order_status
     FROM orders
     WHERE restaurant_id = $1 AND table_id = $2 AND order_status IN ('open', 'billed')
     ORDER BY placed_at DESC
     LIMIT 1`,
    [restaurantId, tableId]
  );

  return result.rows[0] || null;
};

// Records that the table has been cleared and laid again. Any settlement
// before this moment is dealt with; the next one starts a new turn. A table
// someone once set to the old 'cleaning' status is put back to available.
const markReady = async (restaurantId, id, userId) => {
  const result = await pool.query(
    `UPDATE dining_tables
     SET ready_at = NOW(), ready_by = $3,
         table_status = CASE WHEN table_status = 'cleaning' THEN 'available' ELSE table_status END
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, userId]
  );

  return result.rows[0] || null;
};

// --- Floor settings ---

const findSettings = async (restaurantId) => {
  const result = await pool.query(
    "SELECT cleaning_minutes, updated_at FROM floor_settings WHERE restaurant_id = $1",
    [restaurantId]
  );

  return result.rows[0] || { cleaning_minutes: DEFAULT_CLEANING_MINUTES, updated_at: null };
};

const saveSettings = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO floor_settings (restaurant_id, cleaning_minutes, created_by, updated_by)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (restaurant_id)
     DO UPDATE SET cleaning_minutes = EXCLUDED.cleaning_minutes, updated_by = EXCLUDED.updated_by
     RETURNING cleaning_minutes, updated_at`,
    [restaurantId, data.cleaningMinutes, userId]
  );

  return result.rows[0];
};

module.exports = {
  findFloors,
  findFloorById,
  createFloor,
  updateFloor,
  countFloorChildren,
  removeFloor,
  findAreas,
  findAreaById,
  createArea,
  updateArea,
  countOthersTables,
  countAreaTables,
  countOutletTables,
  removeArea,
  findTables,
  findTableById,
  createTable,
  updateTable,
  regenerateQrToken,
  removeTable,
  hasOrderHistory,
  findLiveOrder,
  markReady,
  findSettings,
  saveSettings,
  DEFAULT_CLEANING_MINUTES,
};
