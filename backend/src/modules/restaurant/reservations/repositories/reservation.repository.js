const pool = require("../../../../config/database");
const { DEFAULT_CLEANING_MINUTES } = require("../../tables/repositories/table.repository");

// Statuses that still hold a table. A completed, cancelled or no-show booking
// has given its table back, so it can never clash with anything.
const HOLDING = ["booked", "confirmed", "seated"];

const BOOKING_COLUMNS = `r.id, r.reference_no, r.customer_id, r.guest_name, r.guest_mobile,
       r.party_size, r.reservation_date, to_char(r.start_time, 'HH24:MI') AS start_time,
       r.duration_minutes, to_char(r.ends_at, 'HH24:MI') AS end_time,
       r.starts_at::text AS starts_at, r.ends_at::text AS ends_at,
       r.table_id, r.capacity_override, r.capacity_override_reason, r.occasion, r.special_requests, r.source,
       r.internal_notes, r.status, r.order_id, r.cancel_reason, r.outlet_id,
       r.confirmed_at, r.seated_at, r.completed_at, r.cancelled_at, r.no_show_at, r.declined_at,
       r.created_at, r.updated_at,
       t.table_no, t.capacity AS table_capacity,
       f.name AS floor_name, a.name AS area_name,
       -- Whether the booking's table can still take a party: a floor or a
       -- section closed for the evening, or the table switched off, after the
       -- booking was taken. The booking keeps its table; the host is told.
       t.status AS table_switch, f.status AS floor_status, a.status AS area_status,
       c.name AS customer_name, c.loyalty_points AS customer_points,
       o.order_number, o.order_status, o.total_amount AS order_total,
       -- What the table actually paid: service charge and discounts included.
       (SELECT SUM(bl.total_amount) FROM bills bl
        WHERE bl.order_id = r.order_id AND bl.bill_status <> 'void') AS bill_total,
       cu.name AS created_by_name,
       -- The other tables a large party holds (reservation_tables), in
       -- table-number order: the timeline and the floor plan show the
       -- booking on each of them.
       COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('id', xt.id, 'tableNo', xt.table_no, 'capacity', xt.capacity,
                                                   'status', xt.status)
                                 ORDER BY length(xt.table_no), xt.table_no)
                 FROM reservation_tables x
                 JOIN dining_tables xt ON xt.id = x.table_id
                 WHERE x.reservation_id = r.id), '[]'::json) AS extra_tables`;

// A booking holds a table when it is the booking's main table or one of the
// others a large party holds (reservation_tables). `param` is the table.
const heldOn = (param) =>
  `(r.table_id = ${param}
    OR EXISTS (SELECT 1 FROM reservation_tables x WHERE x.reservation_id = r.id AND x.table_id = ${param}))`;

const BOOKING_JOINS = `FROM reservations r
     LEFT JOIN dining_tables t ON t.id = r.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     LEFT JOIN customers c ON c.id = r.customer_id
     LEFT JOIN orders o ON o.id = r.order_id
     LEFT JOIN users cu ON cu.id = r.created_by`;

// --- Outlets ---------------------------------------------------------------
//
// A host stand working in one outlet (the user is tied to it, or the switcher
// is on it) sees that outlet's bookings, walk-ins and tables, and may act only
// on those: to them another outlet's booking does not exist. A booking
// belongs to the outlet it was taken at, or else to its table's outlet; one
// with neither (taken with "All outlets" and no table yet), like a table
// with no outlet, belongs to everyone. `param` is the outlet, null for the
// whole restaurant.
const bookingInOutlet = (param) =>
  `(${param}::bigint IS NULL OR COALESCE(r.outlet_id, t.outlet_id) IS NULL
     OR COALESCE(r.outlet_id, t.outlet_id) = ${param}::bigint)`;

const waitlistInOutlet = (param) =>
  `(${param}::bigint IS NULL OR w.outlet_id IS NULL OR w.outlet_id = ${param}::bigint)`;

const tableInOutlet = (param) =>
  `(${param}::bigint IS NULL OR t.outlet_id IS NULL OR t.outlet_id = ${param}::bigint)`;

// --- Bookings -------------------------------------------------------------

const findByDate = async (restaurantId, date, outletId = null) => {
  const result = await pool.query(
    `SELECT ${BOOKING_COLUMNS}
     ${BOOKING_JOINS}
     WHERE r.restaurant_id = $1 AND r.reservation_date = $2
       AND ${bookingInOutlet("$3")}
     ORDER BY r.start_time, r.id`,
    [restaurantId, date, outletId || null]
  );

  return result.rows;
};

// Typed text is matched literally: "%" or "_" in a search box is a character
// the host typed, not a wildcard that returns the whole book.
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

// The digits worth matching against mobiles. A reference ("R0113") is not a
// phone number, and two digits would match nearly every guest.
const mobileDigits = (text) => {
  if (/^r\d+$/i.test(text.trim())) {
    return null;
  }

  const digits = text.replace(/\D/g, "");
  return digits.length >= 3 ? digits : null;
};

// Finding a booking without knowing its day: "I booked under Mehta".
//
// The host asking is almost always about a booking still to come, so those
// come first (soonest first), then the past (most recent first). A regular
// with twenty completed visits still finds tonight's booking at the top.
const findAll = async (restaurantId, filters = {}) => {
  const search = filters.search || null;

  const result = await pool.query(
    `SELECT ${BOOKING_COLUMNS}, COUNT(*) OVER ()::int AS total_count
     ${BOOKING_JOINS}
     WHERE r.restaurant_id = $1
       AND ($2::date IS NULL OR r.reservation_date >= $2)
       AND ($3::date IS NULL OR r.reservation_date <= $3)
       AND ($4::text[] IS NULL OR r.status = ANY($4))
       AND ${bookingInOutlet("$9")}
       AND ($5::text IS NULL
            OR r.guest_name ILIKE $5 ESCAPE '\\'
            OR r.reference_no ILIKE $5 ESCAPE '\\'
            OR ($7::text IS NOT NULL
                AND regexp_replace(COALESCE(r.guest_mobile, ''), '[^0-9]', '', 'g') LIKE '%' || $7 || '%'))
     ORDER BY (r.reservation_date < $8::date),
              CASE WHEN r.reservation_date >= $8::date THEN r.starts_at END,
              r.starts_at DESC, r.id
     LIMIT $6`,
    [
      restaurantId,
      filters.from || null,
      filters.to || null,
      filters.statuses || null,
      search ? likePattern(search) : null,
      filters.limit || 50,
      search ? mobileDigits(search) : null,
      filters.today,
      filters.outletId || null,
    ]
  );

  return {
    rows: result.rows,
    total: result.rows.length > 0 ? result.rows[0].total_count : 0,
  };
};

const findById = async (restaurantId, id, outletId = null) => {
  const result = await pool.query(
    `SELECT ${BOOKING_COLUMNS}
     ${BOOKING_JOINS}
     WHERE r.restaurant_id = $1 AND r.id = $2 AND ${bookingInOutlet("$3")}`,
    [restaurantId, id, outletId || null]
  );

  return result.rows[0] || null;
};

// Another live booking on the same table whose window overlaps this one.
// Windows touching end-to-start (7:00-8:30 and 8:30-10:00) do not clash:
// that is a table turned, which is the whole point of the book.
const findClash = async (db, restaurantId, { tableId, startsAt, endsAt, excludeId }) => {
  const result = await db.query(
    `SELECT r.id, r.reference_no, r.guest_name, r.party_size, r.status,
            to_char(r.start_time, 'HH24:MI') AS start_time,
            to_char(r.ends_at, 'HH24:MI') AS end_time, r.reservation_date
     FROM reservations r
     WHERE r.restaurant_id = $1
       AND ${heldOn("$2")}
       AND r.status = ANY($3)
       AND r.starts_at < $5::timestamp
       AND r.ends_at > $4::timestamp
       AND ($6::bigint IS NULL OR r.id <> $6)
     ORDER BY r.starts_at
     LIMIT 1`,
    [restaurantId, tableId, HOLDING, startsAt, endsAt, excludeId || null]
  );

  return result.rows[0] || null;
};

// Held for the length of a booking write or a seating, so two hosts booking
// or seating the same table at the same moment cannot both pass the checks.
// With its floor's and section's state: closing the terrace for the monsoon
// closes every table on it, for bookings and seating as much as for the POS.
const lockTable = async (client, restaurantId, tableId) => {
  const result = await client.query(
    `SELECT t.id, t.table_no, t.capacity, t.status, t.table_status, t.outlet_id,
            f.status AS floor_status, a.status AS area_status
     FROM dining_tables t
     JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     WHERE t.restaurant_id = $1 AND t.id = $2
     FOR UPDATE OF t`,
    [restaurantId, tableId]
  );

  return result.rows[0] || null;
};

// How long a settled table is held as "Cleaning", as the floor plan reads it.
const CLEANING_SETTINGS = `COALESCE(
         (SELECT cleaning_minutes FROM floor_settings WHERE restaurant_id = $1),
         ${DEFAULT_CLEANING_MINUTES})`;

// The turn after the last party: they paid within the restaurant's cleaning
// time and nobody has marked the table ready since — exactly what the floor
// plan shows as "Cleaning". Read under the seating lock. null when the table
// is ready.
const findCleaningTurn = async (db, restaurantId, tableId) => {
  const result = await db.query(
    `SELECT o.order_number, o.completed_at AS settled_at,
            o.completed_at + make_interval(mins => cfg.minutes) AS ends_at,
            GREATEST(1, CEIL(EXTRACT(EPOCH FROM (o.completed_at + make_interval(mins => cfg.minutes) - NOW())) / 60))::int
              AS minutes_left
     FROM dining_tables t
     CROSS JOIN (SELECT ${CLEANING_SETTINGS} AS minutes) cfg
     JOIN orders o ON o.table_id = t.id AND o.restaurant_id = $1
     WHERE t.restaurant_id = $1 AND t.id = $2
       AND o.order_status = 'completed'
       AND o.completed_at > NOW() - make_interval(mins => cfg.minutes)
       AND (t.ready_at IS NULL OR o.completed_at > t.ready_at)
     ORDER BY o.completed_at DESC
     LIMIT 1`,
    [restaurantId, tableId]
  );

  return result.rows[0] || null;
};

// Several tables locked at once, always in id order (two hosts locking the
// same pair in opposite orders would wait on each other for ever).
const lockTables = async (client, restaurantId, tableIds) => {
  const result = await client.query(
    `SELECT t.id, t.table_no, t.capacity, t.status, t.table_status, t.outlet_id,
            f.status AS floor_status, a.status AS area_status
     FROM dining_tables t
     JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     WHERE t.restaurant_id = $1 AND t.id = ANY($2::bigint[])
     ORDER BY t.id
     FOR UPDATE OF t`,
    [restaurantId, tableIds]
  );

  return result.rows;
};

// The other tables a booking holds, replaced with exactly these.
const setExtraTables = async (client, restaurantId, reservationId, tableIds, userId) => {
  await client.query("DELETE FROM reservation_tables WHERE reservation_id = $1", [reservationId]);

  if (tableIds.length > 0) {
    await client.query(
      `INSERT INTO reservation_tables (reservation_id, table_id, restaurant_id, created_by)
       SELECT $1, UNNEST($2::bigint[]), $3, $4`,
      [reservationId, tableIds, restaurantId, userId]
    );
  }
};

// Seating marks the table occupied inside the same transaction that checked
// it, before the order is written. The next host to try the table waits on
// the row lock and then finds it taken, instead of both opening an order.
const occupyTable = async (client, restaurantId, tableId) => {
  await client.query(
    "UPDATE dining_tables SET table_status = 'occupied' WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, tableId]
  );
};

// Undoes occupyTable when the order could not be opened after all — but only
// while nothing else has opened an order there in the meantime.
const releaseTable = async (restaurantId, tableId, previousStatus) => {
  await pool.query(
    `UPDATE dining_tables t
     SET table_status = $3
     WHERE t.restaurant_id = $1 AND t.id = $2 AND t.table_status = 'occupied'
       AND NOT EXISTS (
         SELECT 1 FROM orders o
         WHERE o.restaurant_id = $1 AND o.table_id = t.id AND o.order_status IN ('open', 'billed')
       )`,
    [restaurantId, tableId, previousStatus || "available"]
  );
};

// One new booking at a time per restaurant while its reference is drawn, so
// a burst of bookings (an online channel, two hosts on two phones) gets
// R0156, R0157, R0158 in turn instead of colliding on the same number. Held
// only until that booking's transaction ends.
const lockReferences = async (client, restaurantId) => {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('reservations.reference:' || $1::text, 0))",
    [restaurantId]
  );
};

// R0001, R0002... per restaurant. Worked out inside the booking's own
// transaction under lockReferences; the unique index is the backstop.
const nextReference = async (client, restaurantId) => {
  const result = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(reference_no, '[^0-9]', '', 'g'), '')::int), 0) + 1 AS next
     FROM reservations WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return `R${String(result.rows[0].next).padStart(4, "0")}`;
};

const insert = async (client, restaurantId, data, userId) => {
  const reference = await nextReference(client, restaurantId);

  const result = await client.query(
    `INSERT INTO reservations
       (restaurant_id, outlet_id, reference_no, customer_id, guest_name, guest_mobile, party_size,
        reservation_date, start_time, duration_minutes, table_id, capacity_override, occasion,
        special_requests, source, internal_notes, status, created_by, updated_by, capacity_override_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'booked', $17, $17, $18)
     RETURNING id`,
    [
      restaurantId,
      data.outletId || null,
      reference,
      data.customerId,
      data.guestName,
      data.guestMobile,
      data.partySize,
      data.date,
      data.startTime,
      data.durationMinutes,
      data.tableId,
      data.overrideCapacity,
      data.occasion,
      data.specialRequests,
      data.source,
      data.internalNotes,
      userId,
      data.capacityOverrideReason || null,
    ]
  );

  return result.rows[0].id;
};

// Only a booking that has not sat down can be rewritten. An online request
// can be corrected before it is answered (the guest phoned to say 8, not
// 7:30); `accept` turns it into a confirmed booking in the same statement,
// which is also the only way a request is given a table.
const update = async (client, restaurantId, id, data, userId, { accept = false } = {}) => {
  const result = await client.query(
    `UPDATE reservations
     SET customer_id = $3, guest_name = $4, guest_mobile = $5, party_size = $6,
         reservation_date = $7, start_time = $8, duration_minutes = $9, table_id = $10,
         capacity_override = $11, occasion = $12, special_requests = $13, source = $14,
         internal_notes = $15, updated_by = $16, capacity_override_reason = $17,
         status = CASE WHEN $18::boolean THEN 'confirmed' ELSE status END,
         confirmed_at = CASE WHEN $18::boolean THEN NOW() ELSE confirmed_at END
     WHERE restaurant_id = $1 AND id = $2
       AND status = ANY(CASE WHEN $18::boolean THEN ARRAY['requested']
                             ELSE ARRAY['requested', 'booked', 'confirmed'] END)
     RETURNING id`,
    [
      restaurantId,
      id,
      data.customerId,
      data.guestName,
      data.guestMobile,
      data.partySize,
      data.date,
      data.startTime,
      data.durationMinutes,
      data.tableId,
      data.overrideCapacity,
      data.occasion,
      data.specialRequests,
      data.source,
      data.internalNotes,
      userId,
      data.capacityOverrideReason || null,
      accept,
    ]
  );

  return result.rows[0] || null;
};

// Moves a booking on, but only from the states it may be moved from. The
// WHERE is the guard: if two people press Seat and No-show together, one of
// them updates nothing and is told the booking changed under them.
const transition = async (restaurantId, id, { from, to, stamp, cancelReason, userId }) => {
  const stampColumn = {
    confirmed_at: "confirmed_at",
    completed_at: "completed_at",
    cancelled_at: "cancelled_at",
    no_show_at: "no_show_at",
    declined_at: "declined_at",
  }[stamp];

  const result = await pool.query(
    `UPDATE reservations
     SET status = $3::varchar, updated_by = $4,
         cancel_reason = CASE WHEN $3::varchar IN ('cancelled', 'declined') THEN $5::varchar ELSE cancel_reason END
         ${stampColumn ? `, ${stampColumn} = NOW()` : ""}
     WHERE restaurant_id = $1 AND id = $2 AND status = ANY($6)
     RETURNING id`,
    [restaurantId, id, to, userId, cancelReason || null, from]
  );

  return result.rows[0] || null;
};

// Seating is claimed before the order is opened, so a second click cannot
// open a second order. If the order then fails, releaseSeat puts it back.
// `db` is the seating transaction's client, which holds the table's lock.
const claimSeat = async (restaurantId, id, { from, tableId, overrideCapacity, userId }, db = pool) => {
  const result = await db.query(
    `UPDATE reservations
     SET status = 'seated', seated_at = NOW(), table_id = $3,
         capacity_override = capacity_override OR $4::boolean, updated_by = $5
     WHERE restaurant_id = $1 AND id = $2 AND status = ANY($6)
     RETURNING id`,
    [restaurantId, id, tableId, overrideCapacity, userId, from]
  );

  return result.rows[0] || null;
};

const releaseSeat = async (restaurantId, id, previous) => {
  await pool.query(
    `UPDATE reservations
     SET status = $3, table_id = $4, seated_at = NULL, capacity_override = $5
     WHERE restaurant_id = $1 AND id = $2 AND status = 'seated' AND order_id IS NULL`,
    [restaurantId, id, previous.status, previous.table_id, previous.capacity_override]
  );
};

const attachOrder = async (restaurantId, id, orderId) => {
  await pool.query(
    "UPDATE reservations SET order_id = $3 WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id, orderId]
  );
};

// The party paid and left: a settled bill completes the booking. Worked out
// when the book is read, because the bill is settled somewhere else entirely.
const completeSettled = async (restaurantId) => {
  await pool.query(
    `UPDATE reservations r
     SET status = 'completed', completed_at = COALESCE(o.completed_at, NOW())
     FROM orders o
     WHERE r.restaurant_id = $1
       AND r.status = 'seated'
       AND o.id = r.order_id
       AND o.order_status = 'completed'`,
    [restaurantId]
  );
};

// --- Tables and availability ---------------------------------------------

// Every table switched on, with what is on it right now: whether its floor or
// section is closed, the party eating there, and whether it is still being
// cleaned after the last one (the same turn the floor plan shows). The host
// must see the same room the floor plan does.
const findTables = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `SELECT t.id, t.table_no, t.capacity, t.table_status, t.floor_id, t.area_id, t.outlet_id,
            f.name AS floor_name, f.sort_order AS floor_sort, f.status AS floor_status,
            a.name AS area_name, a.sort_order AS area_sort, a.status AS area_status,
            live.order_id, live.order_number, live.placed_at, live.guest_count,
            live.customer_name AS live_customer,
            turn.ends_at AS cleaning_ends_at,
            CASE WHEN turn.ends_at IS NOT NULL
                 THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (turn.ends_at - NOW())) / 60))::int
            END AS cleaning_minutes_left
     FROM dining_tables t
     JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     CROSS JOIN (SELECT ${CLEANING_SETTINGS} AS minutes) cfg
     LEFT JOIN LATERAL (
       SELECT o.id AS order_id, o.order_number, o.placed_at, o.guest_count, o.customer_name
       FROM orders o
       WHERE o.table_id = t.id
         AND o.restaurant_id = $1
         AND o.order_status IN ('open', 'billed')
       ORDER BY o.placed_at DESC
       LIMIT 1
     ) live ON TRUE
     LEFT JOIN LATERAL (
       SELECT o.completed_at + make_interval(mins => cfg.minutes) AS ends_at
       FROM orders o
       WHERE o.table_id = t.id
         AND o.restaurant_id = $1
         AND o.order_status = 'completed'
         AND o.completed_at > NOW() - make_interval(mins => cfg.minutes)
         AND (t.ready_at IS NULL OR o.completed_at > t.ready_at)
       ORDER BY o.completed_at DESC
       LIMIT 1
     ) turn ON TRUE
     WHERE t.restaurant_id = $1 AND t.status = 'active'
       AND ${tableInOutlet("$2")}
     ORDER BY f.sort_order, f.name, a.sort_order NULLS LAST, a.name NULLS LAST,
              length(t.table_no), t.table_no`,
    [restaurantId, outletId || null]
  );

  return result.rows;
};

// Live bookings on the given tables that overlap a window: one query for the
// whole room instead of one per table.
const findWindowBookings = async (restaurantId, { startsAt, endsAt, excludeId }) => {
  const result = await pool.query(
    `SELECT r.id, held.table_id, r.reference_no, r.guest_name, r.party_size, r.status,
            to_char(r.start_time, 'HH24:MI') AS start_time,
            to_char(r.ends_at, 'HH24:MI') AS end_time
     FROM reservations r
     -- One row per table the booking holds: its main table and any other
     -- tables a large party holds.
     CROSS JOIN LATERAL (
       SELECT r.table_id
       UNION
       SELECT x.table_id FROM reservation_tables x WHERE x.reservation_id = r.id
     ) held
     WHERE r.restaurant_id = $1
       AND held.table_id IS NOT NULL
       AND r.status = ANY($2)
       AND r.starts_at < $4::timestamp
       AND r.ends_at > $3::timestamp
       AND ($5::bigint IS NULL OR r.id <> $5)
     ORDER BY r.starts_at`,
    [restaurantId, HOLDING, startsAt, endsAt, excludeId || null]
  );

  return result.rows;
};

// An order still running on a table blocks seating anyone else there. Read
// on the seating transaction's client (`db`) once the table row is locked.
const findOpenOrderOnTable = async (restaurantId, tableId, db = pool) => {
  const result = await db.query(
    `SELECT id, order_number, placed_at, order_status
     FROM orders
     WHERE restaurant_id = $1 AND table_id = $2 AND order_status IN ('open', 'billed')
     ORDER BY placed_at DESC
     LIMIT 1`,
    [restaurantId, tableId]
  );

  return result.rows[0] || null;
};

// --- Guests -----------------------------------------------------------------

// Numbers are compared on their last ten digits, so "+91 98765 43210",
// "098765-43210" and "9876543210" are recognised as the same phone.
const MOBILE_KEY = (column) => `right(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10)`;

const findCustomerByMobile = async (restaurantId, mobile) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.mobile, c.loyalty_points,
            (SELECT COUNT(*)::int FROM orders o
             WHERE o.restaurant_id = $1 AND o.customer_id = c.id AND o.order_status = 'completed') AS visits,
            (SELECT MAX(o.placed_at) FROM orders o
             WHERE o.restaurant_id = $1 AND o.customer_id = c.id AND o.order_status = 'completed') AS last_visit
     FROM customers c
     WHERE c.restaurant_id = $1
       AND c.status = 'active'
       AND ${MOBILE_KEY("c.mobile")} = right($2, 10)
     ORDER BY c.id
     LIMIT 1`,
    [restaurantId, mobile]
  );

  return result.rows[0] || null;
};

// How this phone number has treated the book before. A guest with two
// no-shows is worth a confirmation call the afternoon before.
const findGuestRecord = async (restaurantId, mobile, excludeId) => {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status NOT IN ('requested', 'declined'))::int AS bookings,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
            COUNT(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            MAX(reservation_date) FILTER (WHERE status = 'completed') AS last_visit
     FROM reservations
     WHERE restaurant_id = $1
       AND guest_mobile IS NOT NULL
       AND ${MOBILE_KEY("guest_mobile")} = right($2, 10)
       AND ($3::bigint IS NULL OR id <> $3)`,
    [restaurantId, mobile, excludeId || null]
  );

  return result.rows[0];
};

// Who did what to one booking, from the audit trail.
const findHistory = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT id, user_name, action, details, created_at
     FROM audit_logs
     WHERE restaurant_id = $1 AND entity_type = 'reservation' AND entity_id = $2
     ORDER BY created_at, id`,
    [restaurantId, id]
  );

  return result.rows;
};

// --- Day summary --------------------------------------------------------------

const summarise = async (restaurantId, date, outletId = null) => {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE r.status NOT IN ('cancelled', 'requested', 'declined'))::int AS bookings,
            COUNT(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
            -- Online requests still waiting for an answer, and their covers:
            -- not bookings yet, but the host must see them in the day.
            COUNT(*) FILTER (WHERE r.status = 'requested')::int AS requested,
            COALESCE(SUM(r.party_size) FILTER (WHERE r.status = 'requested'), 0)::int AS requested_covers,
            COALESCE(SUM(r.party_size) FILTER (WHERE r.status IN ('booked', 'confirmed', 'seated', 'completed')), 0)::int
              AS expected_covers,
            COUNT(*) FILTER (WHERE r.status IN ('seated', 'completed'))::int AS seated,
            COALESCE(SUM(r.party_size) FILTER (WHERE r.status IN ('seated', 'completed')), 0)::int AS seated_covers,
            COUNT(*) FILTER (WHERE r.status = 'seated')::int AS seated_now,
            COUNT(*) FILTER (WHERE r.status = 'no_show')::int AS no_shows,
            COALESCE(SUM(r.party_size) FILTER (WHERE r.status = 'no_show'), 0)::int AS no_show_covers,
            COUNT(*) FILTER (WHERE r.status IN ('booked', 'confirmed'))::int AS to_arrive,
            COUNT(*) FILTER (WHERE r.status = 'confirmed')::int AS confirmed,
            COUNT(*) FILTER (WHERE r.table_id IS NULL AND r.status IN ('booked', 'confirmed'))::int AS unassigned
     FROM reservations r
     LEFT JOIN dining_tables t ON t.id = r.table_id
     WHERE r.restaurant_id = $1 AND r.reservation_date = $2
       AND ${bookingInOutlet("$3")}`,
    [restaurantId, date, outletId || null]
  );

  return result.rows[0];
};

// Bookings and covers per day around the one being viewed, so the host can
// see Saturday filling up while taking Thursday's calls.
const countByDay = async (restaurantId, from, to, outletId = null) => {
  const result = await pool.query(
    `SELECT r.reservation_date AS date,
            COUNT(*) FILTER (WHERE r.status NOT IN ('cancelled', 'requested', 'declined'))::int AS bookings,
            COUNT(*) FILTER (WHERE r.status = 'requested')::int AS requested,
            COALESCE(SUM(r.party_size) FILTER (WHERE r.status IN ('booked', 'confirmed', 'seated', 'completed')), 0)::int
              AS covers
     FROM reservations r
     LEFT JOIN dining_tables t ON t.id = r.table_id
     WHERE r.restaurant_id = $1 AND r.reservation_date BETWEEN $2 AND $3
       AND ${bookingInOutlet("$4")}
     GROUP BY r.reservation_date`,
    [restaurantId, from, to, outletId || null]
  );

  return result.rows;
};

// --- Waitlist ---------------------------------------------------------------

const WAITLIST_COLUMNS = `w.id, w.customer_id, w.guest_name, w.guest_mobile, w.party_size,
       w.quoted_minutes, w.notes, w.status, w.joined_at, w.notified_at, w.resolved_at,
       w.table_id, w.order_id, t.table_no, o.order_number, c.name AS customer_name`;

const WAITLIST_JOINS = `FROM waitlist_entries w
     LEFT JOIN dining_tables t ON t.id = w.table_id
     LEFT JOIN orders o ON o.id = w.order_id
     LEFT JOIN customers c ON c.id = w.customer_id`;

// A queue is measured in minutes. Two hours past the wait they were quoted,
// nobody is still standing at the door: an entry left "waiting" that long is
// one the host forgot to close (the guests left, or sat down without being
// ticked off). It drops out of the live queue, the counts and the bell, and
// is listed with the day's earlier walk-ins as never closed, so the host can
// still record what happened. Yesterday's leftovers are past this long before
// the next service starts, so the queue starts every day empty.
const WAITLIST_GRACE_MINUTES = 120;

const STILL_WAITING = `w.status = 'waiting'
       AND w.joined_at + make_interval(mins => w.quoted_minutes + ${WAITLIST_GRACE_MINUTES}) > NOW()`;

const findWaiting = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `SELECT ${WAITLIST_COLUMNS}
     ${WAITLIST_JOINS}
     WHERE w.restaurant_id = $1 AND ${STILL_WAITING} AND ${waitlistInOutlet("$2")}
     ORDER BY w.joined_at, w.id`,
    [restaurantId, outletId || null]
  );

  return result.rows;
};

// Walk-ins who joined on a local date and were never seated, marked as left
// or removed, and are long past their quote: the ones findWaiting stopped
// showing.
const findUnclosedOn = async (restaurantId, date, timezone, outletId = null) => {
  const result = await pool.query(
    `SELECT ${WAITLIST_COLUMNS}
     ${WAITLIST_JOINS}
     WHERE w.restaurant_id = $1
       AND w.status = 'waiting'
       AND NOT (${STILL_WAITING})
       AND (w.joined_at AT TIME ZONE $3::text)::date = $2::date
       AND ${waitlistInOutlet("$4")}
     ORDER BY w.joined_at DESC
     LIMIT 30`,
    [restaurantId, date, timezone, outletId || null]
  );

  return result.rows;
};

// Everyone who left the queue on a given local date, newest first.
const findResolvedOn = async (restaurantId, date, timezone, outletId = null) => {
  const result = await pool.query(
    `SELECT ${WAITLIST_COLUMNS}
     ${WAITLIST_JOINS}
     WHERE w.restaurant_id = $1
       AND w.status <> 'waiting'
       AND (w.resolved_at AT TIME ZONE $3::text)::date = $2::date
       AND ${waitlistInOutlet("$4")}
     ORDER BY w.resolved_at DESC
     LIMIT 30`,
    [restaurantId, date, timezone, outletId || null]
  );

  return result.rows;
};

// How long walk-ins really waited today. Only the ones who were seated count
// towards the average: someone who gave up after five minutes did not wait
// five minutes for a table.
const waitStats = async (restaurantId, date, timezone, outletId = null) => {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${STILL_WAITING})::int AS waiting_now,
            COALESCE(SUM(party_size) FILTER (WHERE ${STILL_WAITING}), 0)::int AS waiting_covers,
            COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - joined_at)) / 60)
              FILTER (WHERE ${STILL_WAITING}), 0)::int AS longest_minutes,
            COUNT(*) FILTER (WHERE status = 'waiting' AND NOT (${STILL_WAITING})
              AND (joined_at AT TIME ZONE $3::text)::date = $2::date)::int AS unclosed_today,
            COUNT(*) FILTER (WHERE status = 'seated'
              AND (resolved_at AT TIME ZONE $3::text)::date = $2::date)::int AS seated_today,
            ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - joined_at)) / 60)
              FILTER (WHERE status = 'seated' AND (resolved_at AT TIME ZONE $3::text)::date = $2::date))::int
              AS average_wait,
            COUNT(*) FILTER (WHERE status = 'left'
              AND (resolved_at AT TIME ZONE $3::text)::date = $2::date)::int AS left_today
     FROM waitlist_entries w
     WHERE restaurant_id = $1
       AND (status = 'waiting' OR resolved_at >= NOW() - INTERVAL '2 days')
       AND ${waitlistInOutlet("$4")}`,
    [restaurantId, date, timezone, outletId || null]
  );

  return result.rows[0];
};

const findWaitlistById = async (restaurantId, id, outletId = null) => {
  const result = await pool.query(
    `SELECT ${WAITLIST_COLUMNS}
     ${WAITLIST_JOINS}
     WHERE w.restaurant_id = $1 AND w.id = $2 AND ${waitlistInOutlet("$3")}`,
    [restaurantId, id, outletId || null]
  );

  return result.rows[0] || null;
};

const insertWaitlist = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO waitlist_entries
       (restaurant_id, outlet_id, customer_id, guest_name, guest_mobile, party_size,
        quoted_minutes, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING id`,
    [
      restaurantId,
      data.outletId || null,
      data.customerId,
      data.guestName,
      data.guestMobile,
      data.partySize,
      data.quotedMinutes,
      data.notes,
      userId,
    ]
  );

  return result.rows[0].id;
};

const updateWaitlist = async (restaurantId, id, data, userId) => {
  const result = await pool.query(
    `UPDATE waitlist_entries
     SET customer_id = $3, guest_name = $4, guest_mobile = $5, party_size = $6,
         quoted_minutes = $7, notes = $8, updated_by = $9
     WHERE restaurant_id = $1 AND id = $2 AND status = 'waiting'
     RETURNING id`,
    [
      restaurantId,
      id,
      data.customerId,
      data.guestName,
      data.guestMobile,
      data.partySize,
      data.quotedMinutes,
      data.notes,
      userId,
    ]
  );

  return result.rows[0] || null;
};

const markNotified = async (restaurantId, id, userId) => {
  const result = await pool.query(
    `UPDATE waitlist_entries SET notified_at = NOW(), updated_by = $3
     WHERE restaurant_id = $1 AND id = $2 AND status = 'waiting'
     RETURNING id`,
    [restaurantId, id, userId]
  );

  return result.rows[0] || null;
};

const resolveWaitlist = async (restaurantId, id, { status, tableId, userId }, db = pool) => {
  const result = await db.query(
    `UPDATE waitlist_entries
     SET status = $3, resolved_at = NOW(), table_id = COALESCE($4, table_id), updated_by = $5
     WHERE restaurant_id = $1 AND id = $2 AND status = 'waiting'
     RETURNING id`,
    [restaurantId, id, status, tableId || null, userId]
  );

  return result.rows[0] || null;
};

const reopenWaitlist = async (restaurantId, id) => {
  await pool.query(
    `UPDATE waitlist_entries
     SET status = 'waiting', resolved_at = NULL, table_id = NULL
     WHERE restaurant_id = $1 AND id = $2 AND status = 'seated' AND order_id IS NULL`,
    [restaurantId, id]
  );
};

const attachWaitlistOrder = async (restaurantId, id, orderId) => {
  await pool.query(
    "UPDATE waitlist_entries SET order_id = $3 WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id, orderId]
  );
};

// --- Online booking --------------------------------------------------------
//
// A booking link belongs to one place: the main counter (outlet NULL) or one
// outlet. Its room and its load are counted strictly for that place — unlike
// the host stand's "All outlets", where a booking with no outlet is everyone's.

// Requests still waiting for an answer, oldest first: the guest who asked
// first is answered first. Every date, because a request for next Saturday
// needs its answer today.
const findPendingRequests = async (restaurantId, outletId = null) => {
  const result = await pool.query(
    `SELECT ${BOOKING_COLUMNS}
     ${BOOKING_JOINS}
     WHERE r.restaurant_id = $1 AND r.status = 'requested'
       AND ${bookingInOutlet("$2")}
     ORDER BY r.created_at, r.id
     LIMIT 200`,
    [restaurantId, outletId || null]
  );

  return result.rows;
};

// A request nobody answered before its time is over: the guest is told so on
// their link instead of seeing "waiting" for ever. `nowStamp` is the
// restaurant's wall clock ("2026-10-06 19:45:00").
const expireRequests = async (restaurantId, nowStamp) => {
  await pool.query(
    `UPDATE reservations
     SET status = 'declined', declined_at = NOW(),
         cancel_reason = 'The restaurant could not answer before the booking time'
     WHERE restaurant_id = $1 AND status = 'requested' AND starts_at < $2::timestamp`,
    [restaurantId, nowStamp]
  );
};

const ONLINE_COLUMNS = `s.id, s.restaurant_id, s.outlet_id, s.token, s.is_enabled, s.max_party_size,
       s.seat_share_percent, s.min_notice_minutes, s.days_ahead, s.duration_minutes,
       s.max_open_per_mobile, to_json(s.blocked_dates) AS blocked_dates, s.guest_note, s.updated_at`;

// The link's settings, made on first look (switched off) so every counter
// and outlet has a link ready to turn on.
const findOnlineSettings = async (restaurantId, outletId, newToken) => {
  await pool.query(
    `INSERT INTO online_booking_settings (restaurant_id, outlet_id, token)
     VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, outlet_id) DO NOTHING`,
    [restaurantId, outletId || null, newToken]
  );

  const result = await pool.query(
    `SELECT ${ONLINE_COLUMNS}, o.name AS outlet_name,
            ss.guest_web_address
     FROM online_booking_settings s
     LEFT JOIN outlets o ON o.id = s.outlet_id
     LEFT JOIN service_settings ss ON ss.restaurant_id = s.restaurant_id
     WHERE s.restaurant_id = $1 AND s.outlet_id IS NOT DISTINCT FROM $2::bigint`,
    [restaurantId, outletId || null]
  );

  return result.rows[0] || null;
};

const updateOnlineSettings = async (restaurantId, outletId, data, userId) => {
  const result = await pool.query(
    `UPDATE online_booking_settings
     SET is_enabled = $3, max_party_size = $4, seat_share_percent = $5, min_notice_minutes = $6,
         days_ahead = $7, duration_minutes = $8, max_open_per_mobile = $9,
         blocked_dates = $10::date[], guest_note = $11, updated_by = $12
     WHERE restaurant_id = $1 AND outlet_id IS NOT DISTINCT FROM $2::bigint
     RETURNING id`,
    [
      restaurantId,
      outletId || null,
      data.isEnabled,
      data.maxPartySize,
      data.seatSharePercent,
      data.minNoticeMinutes,
      data.daysAhead,
      data.durationMinutes,
      data.maxOpenPerMobile,
      data.blockedDates,
      data.guestNote,
      userId,
    ]
  );

  return result.rows[0] || null;
};

const replaceOnlineToken = async (restaurantId, outletId, token, userId) => {
  await pool.query(
    `UPDATE online_booking_settings SET token = $3, updated_by = $4
     WHERE restaurant_id = $1 AND outlet_id IS NOT DISTINCT FROM $2::bigint`,
    [restaurantId, outletId || null, token, userId]
  );
};

// What a guest's phone needs to know about the place behind a link. The
// restaurant and the outlet must both still be trading.
const findOnlineLink = async (token) => {
  const result = await pool.query(
    `SELECT ${ONLINE_COLUMNS},
            r.name AS restaurant_name, r.status AS restaurant_status, r.contact AS restaurant_contact,
            r.address AS restaurant_address,
            o.name AS outlet_name, o.status AS outlet_status, o.contact AS outlet_contact,
            o.address AS outlet_address,
            COALESCE(rs.timezone, 'Asia/Kolkata') AS timezone
     FROM online_booking_settings s
     JOIN restaurants r ON r.id = s.restaurant_id
     LEFT JOIN outlets o ON o.id = s.outlet_id
     LEFT JOIN restaurant_settings rs ON rs.restaurant_id = s.restaurant_id
     WHERE s.token = $1`,
    [token]
  );

  return result.rows[0] || null;
};

// The tables a link's room is made of: in use, on an open floor and section,
// and belonging to that place.
const seatsInPlace = async (restaurantId, outletId, db = pool) => {
  const result = await db.query(
    `SELECT COUNT(*)::int AS tables, COALESCE(SUM(t.capacity), 0)::int AS seats,
            COALESCE(MAX(t.capacity), 0)::int AS largest
     FROM dining_tables t
     JOIN floors f ON f.id = t.floor_id
     LEFT JOIN dining_areas a ON a.id = t.area_id
     WHERE t.restaurant_id = $1 AND t.status = 'active'
       AND f.status = 'active' AND (a.id IS NULL OR a.status = 'active')
       AND t.outlet_id IS NOT DISTINCT FROM $2::bigint`,
    [restaurantId, outletId || null]
  );

  return result.rows[0];
};

// Every party expected in a place between two wall-clock stamps: live
// bookings and requests still waiting for an answer (a request holds no
// table, but its guests are still coming if the host says yes).
const findPlaceLoad = async (db, restaurantId, outletId, fromStamp, toStamp) => {
  const result = await db.query(
    `SELECT r.starts_at::text AS starts_at, r.ends_at::text AS ends_at, r.party_size
     FROM reservations r
     LEFT JOIN dining_tables t ON t.id = r.table_id
     WHERE r.restaurant_id = $1
       AND r.status IN ('requested', 'booked', 'confirmed', 'seated')
       AND COALESCE(r.outlet_id, t.outlet_id) IS NOT DISTINCT FROM $2::bigint
       AND r.starts_at < $4::timestamp
       AND r.ends_at > $3::timestamp`,
    [restaurantId, outletId || null, fromStamp, toStamp]
  );

  return result.rows;
};

// Requests and upcoming bookings one phone holds at this restaurant, however
// they were made.
const countOpenForMobile = async (db, restaurantId, mobile, today) => {
  const result = await db.query(
    `SELECT COUNT(*)::int AS open
     FROM reservations
     WHERE restaurant_id = $1
       AND status IN ('requested', 'booked', 'confirmed')
       AND reservation_date >= $3::date
       AND guest_mobile IS NOT NULL
       AND ${MOBILE_KEY("guest_mobile")} = right($2, 10)`,
    [restaurantId, mobile.replace(/\D/g, ""), today]
  );

  return result.rows[0].open;
};

const insertRequest = async (client, restaurantId, data) => {
  const reference = await nextReference(client, restaurantId);

  const result = await client.query(
    `INSERT INTO reservations
       (restaurant_id, outlet_id, reference_no, guest_name, guest_mobile, party_size,
        reservation_date, start_time, duration_minutes, occasion, special_requests,
        source, status, guest_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'online', 'requested', $12)
     RETURNING id`,
    [
      restaurantId,
      data.outletId || null,
      reference,
      data.guestName,
      data.guestMobile,
      data.partySize,
      data.date,
      data.startTime,
      data.durationMinutes,
      data.occasion,
      data.specialRequests,
      data.guestToken,
    ]
  );

  return result.rows[0].id;
};

// A guest's own booking from their status link: what they asked for and
// where it stands. Never the table, the staff notes or who handled it.
const findByGuestToken = async (guestToken) => {
  const result = await pool.query(
    `SELECT r.id, r.restaurant_id, r.outlet_id, r.reference_no, r.guest_name, r.party_size,
            r.reservation_date, to_char(r.start_time, 'HH24:MI') AS start_time, r.duration_minutes,
            r.occasion, r.special_requests, r.status, r.cancel_reason, r.created_at,
            r.confirmed_at, r.declined_at, r.cancelled_at, r.guest_mobile,
            res.name AS restaurant_name, res.contact AS restaurant_contact, res.address AS restaurant_address,
            o.name AS outlet_name, o.contact AS outlet_contact, o.address AS outlet_address,
            COALESCE(rs.timezone, 'Asia/Kolkata') AS timezone,
            s.token AS link_token, s.is_enabled AS link_enabled
     FROM reservations r
     JOIN restaurants res ON res.id = r.restaurant_id
     LEFT JOIN outlets o ON o.id = r.outlet_id
     LEFT JOIN restaurant_settings rs ON rs.restaurant_id = r.restaurant_id
     LEFT JOIN online_booking_settings s
       ON s.restaurant_id = r.restaurant_id AND s.outlet_id IS NOT DISTINCT FROM r.outlet_id
     WHERE r.guest_token = $1`,
    [guestToken]
  );

  return result.rows[0] || null;
};

module.exports = {
  findPendingRequests,
  expireRequests,
  findOnlineSettings,
  updateOnlineSettings,
  replaceOnlineToken,
  findOnlineLink,
  seatsInPlace,
  findPlaceLoad,
  countOpenForMobile,
  insertRequest,
  findByGuestToken,
  lockTables,
  setExtraTables,
  WAITLIST_GRACE_MINUTES,
  findByDate,
  findAll,
  findById,
  findClash,
  lockTable,
  findCleaningTurn,
  occupyTable,
  releaseTable,
  lockReferences,
  insert,
  update,
  transition,
  claimSeat,
  releaseSeat,
  attachOrder,
  completeSettled,
  findTables,
  findWindowBookings,
  findOpenOrderOnTable,
  findCustomerByMobile,
  findGuestRecord,
  findHistory,
  summarise,
  countByDay,
  findWaiting,
  findUnclosedOn,
  findResolvedOn,
  waitStats,
  findWaitlistById,
  insertWaitlist,
  updateWaitlist,
  markNotified,
  resolveWaitlist,
  reopenWaitlist,
  attachWaitlistOrder,
};
