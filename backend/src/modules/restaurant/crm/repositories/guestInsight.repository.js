const pool = require("../../../../config/database");

// Everything guest insights reads. Read-only: this module never writes to the
// guest book, the orders or the bills — it only works out who is who.
//
// Two definitions hold across every query here, because they are the ones the
// guest history panel (loyalty.repository.customerSummary) already uses, and a
// guest's numbers must read the same wherever they are shown:
//
//   a visit  = an order linked to the guest that was not cancelled
//   spend    = the total of the bills on those orders, void bills left out
//
// Days are counted on the restaurant's own calendar ($tz), not the server's:
// a guest who ate at 11pm in Kolkata ate on that day, not the next one in UTC.

// The restaurant's clock and the settings that shape the segments. A plain
// SELECT rather than restaurantRepository.findSettings, which upserts (and so
// writes) on every call — wrong for a screen that refreshes itself.
const findContext = async (restaurantId, now = new Date()) => {
  const result = await pool.query(
    `SELECT COALESCE(rs.timezone, 'Asia/Kolkata') AS timezone,
            COALESCE(rs.currency_symbol, '₹') AS currency_symbol,
            ('guest_loyalty' = ANY (restaurant_features(r.id))) AS loyalty_enabled,
            COALESCE(rs.loyalty_min_redeem, 50) AS loyalty_min_redeem,
            COALESCE(rs.loyalty_point_value, 1) AS loyalty_point_value,
            ($2::timestamptz AT TIME ZONE COALESCE(rs.timezone, 'Asia/Kolkata'))::date AS today,
            (SELECT (MIN(o.placed_at) AT TIME ZONE COALESCE(rs.timezone, 'Asia/Kolkata'))::date
             FROM orders o WHERE o.restaurant_id = r.id) AS history_starts,
            (SELECT COUNT(*)::int FROM customers c
             WHERE c.restaurant_id = r.id AND c.status <> 'active') AS inactive_guests
     FROM restaurants r
     LEFT JOIN restaurant_settings rs ON rs.restaurant_id = r.id
     WHERE r.id = $1`,
    [restaurantId, now.toISOString()]
  );

  return result.rows[0] || null;
};

// One row per active guest: who they are, and their whole history boiled down
// to the handful of numbers every segment is decided from.
//
// Spend is what the guest kept paying for: non-void bills less what was
// refunded on them (credit notes), the same definition the guest book and the
// loyalty screen use, so a ₹762 bill refunded in full is ₹0 spent everywhere.
//
// Spend is summed per order first and only then per guest. Joining bills
// straight onto orders and counting would count an order split into three
// bills as three visits.
const findGuestFacts = async (restaurantId, timezone, now = new Date()) => {
  const result = await pool.query(
    `WITH clock AS (
       SELECT ($3::timestamptz AT TIME ZONE $2::text)::date AS today
     ),
     order_spend AS (
       SELECT b.order_id, SUM(b.total_amount - COALESCE(b.credited_amount, 0)) AS amount
       FROM bills b
       WHERE b.restaurant_id = $1 AND b.bill_status <> 'void'
       GROUP BY b.order_id
     ),
     visits AS (
       SELECT o.customer_id,
              o.placed_at,
              (o.placed_at AT TIME ZONE $2::text)::date AS visit_date,
              s.amount
       FROM orders o
       LEFT JOIN order_spend s ON s.order_id = o.id
       WHERE o.restaurant_id = $1
         AND o.customer_id IS NOT NULL
         AND o.order_status <> 'cancelled'
     ),
     per_guest AS (
       SELECT v.customer_id,
              COUNT(*)::int AS visits,
              COUNT(v.amount)::int AS billed_visits,
              COALESCE(SUM(v.amount), 0) AS spend,
              MIN(v.placed_at) AS first_visit,
              MAX(v.placed_at) AS last_visit,
              MIN(v.visit_date) AS first_visit_date,
              MAX(v.visit_date) AS last_visit_date,
              -- "In the last 60 days" is today and the 59 before it, the same
              -- way "last 7 days" means this week on every other screen.
              COUNT(*) FILTER (WHERE v.visit_date > clock.today - 60)::int AS visits_60
       FROM visits v
       CROSS JOIN clock
       GROUP BY v.customer_id
     )
     SELECT c.id, c.name, c.mobile, c.email, c.date_of_birth, c.anniversary_date, c.loyalty_points, c.created_at,
            COALESCE(g.visits, 0) AS visits,
            COALESCE(g.billed_visits, 0) AS billed_visits,
            COALESCE(g.spend, 0) AS spend,
            g.first_visit, g.last_visit,
            g.first_visit_date, g.last_visit_date,
            COALESCE(g.visits_60, 0) AS visits_60,
            (clock.today - g.last_visit_date) AS days_since_last,
            (clock.today - g.first_visit_date) AS days_since_first
     FROM customers c
     CROSS JOIN clock
     LEFT JOIN per_guest g ON g.customer_id = c.id
     WHERE c.restaurant_id = $1 AND c.status = 'active'`,
    [restaurantId, timezone, now.toISOString()]
  );

  return result.rows;
};

// Poor ratings and complaints from the last N days, matched to a guest by the
// link on the record or, when the record was taken without one (a QR rating,
// a phone complaint), by the mobile number on it. Newest first, so the first
// one seen for a guest is the one to mention.
//
// Mobiles are stored as typed, and a guest on a QR form types "+91 98495
// 10101" for the number the till saved as "9849510101". So an unlinked record
// is matched on the last ten digits — an Indian mobile without its country
// code or leading zero — and only when it has at least ten. The key is worked
// out once per row on each side, so the match is one hash join, not a
// regular expression per pair.
const PHONE_KEY = (column) => `right(regexp_replace(${column}, '[^0-9]', '', 'g'), 10)`;

const findUnhappySignals = async (restaurantId, days, maxRating, now = new Date()) => {
  const result = await pool.query(
    `WITH signals AS (
       SELECT 'feedback' AS kind, f.id, f.customer_id, ${PHONE_KEY("f.customer_mobile")} AS phone,
              f.rating, f.comments AS text, f.feedback_status AS status, f.created_at
       FROM feedback f
       WHERE f.restaurant_id = $1
         AND f.rating <= $3
         AND f.created_at >= $4::timestamptz - make_interval(days => $2)
         AND f.created_at <= $4::timestamptz
       UNION ALL
       SELECT 'complaint' AS kind, k.id, k.customer_id, ${PHONE_KEY("k.customer_mobile")} AS phone,
              NULL AS rating, k.subject AS text, k.complaint_status AS status, k.created_at
       FROM complaints k
       WHERE k.restaurant_id = $1
         AND k.created_at >= $4::timestamptz - make_interval(days => $2)
         AND k.created_at <= $4::timestamptz
     ),
     phones AS (
       SELECT id, ${PHONE_KEY("mobile")} AS phone
       FROM customers
       WHERE restaurant_id = $1 AND mobile IS NOT NULL
     )
     SELECT s.kind, s.id, c.id AS customer_id, s.rating, s.text, s.status, s.created_at
     FROM signals s
     JOIN customers c ON c.restaurant_id = $1 AND c.id = s.customer_id
     UNION ALL
     SELECT s.kind, s.id, p.id AS customer_id, s.rating, s.text, s.status, s.created_at
     FROM signals s
     JOIN phones p ON p.phone = s.phone
     WHERE s.customer_id IS NULL AND length(s.phone) = 10
     ORDER BY created_at DESC`,
    [restaurantId, days, maxRating, now.toISOString()]
  );

  return result.rows;
};

// Guests we know who are sitting at a table right now: a dine-in order linked
// to them that is still running. "Billed" counts — the bill is on the table
// and they are still in their seat, which is exactly when a manager's "thank
// you, see you Friday" lands — the same rule the floor plan uses to call a
// table occupied. An order left open longer than a sitting could last is a
// table someone forgot to close, not a guest in the room, so it is left out.
const findSeatedGuests = async (restaurantId, withinHours, now = new Date()) => {
  const result = await pool.query(
    `SELECT o.id AS order_id, o.order_number, o.order_status, o.customer_id, o.placed_at,
            o.guest_count, t.table_no
     FROM orders o
     JOIN dining_tables t ON t.id = o.table_id
     WHERE o.restaurant_id = $1
       AND o.order_status IN ('open', 'billed')
       AND o.order_type = 'dine_in'
       AND o.customer_id IS NOT NULL
       AND o.placed_at >= $3::timestamptz - make_interval(hours => $2)
       AND o.placed_at <= $3::timestamptz
     ORDER BY o.placed_at DESC`,
    [restaurantId, withinHours, now.toISOString()]
  );

  return result.rows;
};

// What each of these guests orders most often, for a line a host can use:
// "usually has the Chicken Biryani".
const findFavouriteDishes = async (restaurantId, customerIds) => {
  if (customerIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT DISTINCT ON (customer_id) customer_id, item_name, quantity
     FROM (
       SELECT o.customer_id, oi.item_name, SUM(oi.quantity) AS quantity
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id AND oi.item_status <> 'cancelled'
       WHERE o.restaurant_id = $1
         AND o.customer_id = ANY($2::bigint[])
         AND o.order_status <> 'cancelled'
       GROUP BY o.customer_id, oi.item_name
     ) dishes
     ORDER BY customer_id, quantity DESC, item_name`,
    [restaurantId, customerIds]
  );

  return result.rows;
};

// One guest in this restaurant's book, active or not, by id. The restaurant
// is part of the key, so another restaurant's guest is simply not found.
const findGuestById = async (restaurantId, customerId) => {
  const result = await pool.query(
    `SELECT id, name, mobile, status
     FROM customers
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, customerId]
  );

  return result.rows[0] || null;
};

// --- For the bell, which polls: small, indexed reads only ---

// The same numbers as findGuestFacts, for a handful of named guests rather
// than the whole guest book. idx_orders_customer_id finds their orders.
const findStatsForGuests = async (restaurantId, customerIds, timezone, now = new Date()) => {
  if (customerIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `WITH clock AS (
       SELECT ($4::timestamptz AT TIME ZONE $3::text)::date AS today
     )
     SELECT c.id, c.name, c.mobile, c.loyalty_points,
            COUNT(o.id)::int AS visits,
            COUNT(o.id) FILTER (
              WHERE (o.placed_at AT TIME ZONE $3::text)::date > clock.today - 60
            )::int AS visits_60,
            COALESCE(SUM(s.amount), 0) AS spend
     FROM customers c
     CROSS JOIN clock
     LEFT JOIN orders o
       ON o.restaurant_id = c.restaurant_id
      AND o.customer_id = c.id
      AND o.order_status <> 'cancelled'
     LEFT JOIN LATERAL (
       SELECT SUM(b.total_amount - COALESCE(b.credited_amount, 0)) AS amount
       FROM bills b
       WHERE b.order_id = o.id AND b.bill_status <> 'void'
     ) s ON TRUE
     WHERE c.restaurant_id = $1 AND c.id = ANY($2::bigint[]) AND c.status = 'active'
     GROUP BY c.id, c.name, c.mobile, c.loyalty_points, clock.today`,
    [restaurantId, customerIds, timezone, now.toISOString()]
  );

  return result.rows;
};

// The lifetime spend a guest needs to be in the top `share` of spenders: the
// k-th highest, k = share of spenders rounded up (never fewer than one). The
// same rule the Big spenders segment uses, worked out in the database so the
// bell does not have to load the whole guest book to know it.
const findBigSpenderThreshold = async (restaurantId, share) => {
  const result = await pool.query(
    `WITH spend AS (
       SELECT o.customer_id, SUM(b.total_amount - COALESCE(b.credited_amount, 0)) AS amount
       FROM orders o
       JOIN customers c ON c.id = o.customer_id AND c.status = 'active'
       JOIN bills b ON b.order_id = o.id AND b.bill_status <> 'void'
       WHERE o.restaurant_id = $1
         AND o.customer_id IS NOT NULL
         AND o.order_status <> 'cancelled'
       GROUP BY o.customer_id
       HAVING SUM(b.total_amount - COALESCE(b.credited_amount, 0)) > 0
     ),
     ranked AS (
       SELECT amount,
              ROW_NUMBER() OVER (ORDER BY amount DESC) AS position,
              COUNT(*) OVER () AS spenders
       FROM spend
     )
     SELECT amount FROM ranked
     WHERE position = GREATEST(CEIL(spenders * $2::numeric), 1)`,
    [restaurantId, share]
  );

  return result.rows.length ? Number(result.rows[0].amount) : null;
};

// Guests whose birthday is one of these MM-DD days. A list, because a guest
// born on 29 February celebrates on the 28th in a year without one.
const findBirthdayGuests = async (restaurantId, monthDays) => {
  const result = await pool.query(
    `SELECT id, name, mobile, date_of_birth
     FROM customers
     WHERE restaurant_id = $1
       AND status = 'active'
       AND date_of_birth IS NOT NULL
       AND to_char(date_of_birth, 'MM-DD') = ANY($2::text[])
     ORDER BY name`,
    [restaurantId, monthDays]
  );

  return result.rows;
};

// Guests whose wedding anniversary is one of these MM-DD days (the same
// leap-day rule as birthdays).
const findAnniversaryGuests = async (restaurantId, monthDays) => {
  const result = await pool.query(
    `SELECT id, name, mobile, anniversary_date
     FROM customers
     WHERE restaurant_id = $1
       AND status = 'active'
       AND anniversary_date IS NOT NULL
       AND to_char(anniversary_date, 'MM-DD') = ANY($2::text[])
     ORDER BY name`,
    [restaurantId, monthDays]
  );

  return result.rows;
};

module.exports = {
  findAnniversaryGuests,
  findContext,
  findGuestFacts,
  findUnhappySignals,
  findSeatedGuests,
  findFavouriteDishes,
  findGuestById,
  findStatsForGuests,
  findBigSpenderThreshold,
  findBirthdayGuests,
};
