const pool = require('../../../config/database');

// Alerts on a closed phone: the phones subscribed (push_subscriptions) and
// the moments each was alerted for (push_deliveries): the migration
// staff-app-push (DATABASE.md › push_subscriptions).

const COLUMNS = `s.id, s.user_id, s.purpose, s.restaurant_id, s.outlet_id, s.all_tables, s.watching_since,
  s.session_ends_at, s.last_success_at, s.failures, s.disabled_at, s.disabled_reason, s.created_at, s.updated_at`;

const one = async (db, sql, values) => (await db.query(sql, values)).rows[0] || null;

// A phone's subscription, saved for this person: a new one, or the same
// address again (the app's own sync, another person on a shared phone, a new
// outlet or All tables). Alerts start afresh (watching_since) when whom or
// what they follow changes. A row the push service has dropped is not
// brought back: null then, and the phone subscribes anew.
const save = async (db, row) => one(db,
  `INSERT INTO push_subscriptions AS s (user_id, purpose, restaurant_id, outlet_id, all_tables, endpoint, p256dh, auth, user_agent,
     token_version, session_ends_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
   ON CONFLICT (endpoint) DO UPDATE SET
     watching_since = CASE WHEN s.user_id = EXCLUDED.user_id AND s.purpose = EXCLUDED.purpose AND s.restaurant_id = EXCLUDED.restaurant_id
                            AND s.outlet_id IS NOT DISTINCT FROM EXCLUDED.outlet_id AND s.all_tables = EXCLUDED.all_tables
                           THEN s.watching_since ELSE NOW() END,
     user_id = EXCLUDED.user_id, purpose = EXCLUDED.purpose, restaurant_id = EXCLUDED.restaurant_id, outlet_id = EXCLUDED.outlet_id,
     all_tables = EXCLUDED.all_tables, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent,
     token_version = EXCLUDED.token_version, session_ends_at = EXCLUDED.session_ends_at, failures = 0
   WHERE s.disabled_at IS NULL
   RETURNING ${COLUMNS}, (xmax = 0) AS created`,
  [row.userId, row.purpose, row.restaurantId, row.outletId, row.allTables, row.endpoint, row.p256dh, row.auth, row.userAgent,
    row.tokenVersion, row.sessionEndsAt]);

const findByEndpoint = async (db, endpoint) =>
  one(db, `SELECT ${COLUMNS}, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s WHERE s.endpoint = $1`, [endpoint]);

// Removes a phone's subscription. A person removes their own, or one of their
// restaurant's on a phone they hold (only the phone knows its address).
const remove = async (db, endpoint, { userId, restaurantId }) => one(db,
  `DELETE FROM push_subscriptions WHERE endpoint = $1 AND (user_id = $2 OR restaurant_id = $3) RETURNING id`,
  [endpoint, userId, restaurantId || null]);

// The phone's address and keys moved (the browser renewed its subscription):
// the same phone, alerts carry on. Only a row still in use moves.
const move = async (db, id, { endpoint, p256dh, auth }) => one(db,
  `UPDATE push_subscriptions SET endpoint = $2, p256dh = $3, auth = $4, failures = 0
   WHERE id = $1 AND disabled_at IS NULL RETURNING id`,
  [id, endpoint, p256dh, auth]);

// The phones in use in a restaurant for `purpose`, with what each person may
// do now: their login still on, the session the phone was subscribed in not
// ended (signed out everywhere or run out), and their permissions and last
// punch on the time clock (while Staff is switched on) as of this moment.
const listActive = async (db, restaurantId, purpose = 'captain') => {
  const result = await db.query(
    `SELECT s.id, s.user_id, s.outlet_id, s.all_tables, s.watching_since, s.endpoint, s.p256dh, s.auth,
            COALESCE(ARRAY_AGG(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions,
            punch.punch_type AS last_punch, punch.punched_at AS last_punch_at, punch.clock_in_at
     FROM push_subscriptions s
     JOIN users u ON u.id = s.user_id
     JOIN restaurants r ON r.id = s.restaurant_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
     LEFT JOIN role_permissions rp ON rp.role_id = ro.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     LEFT JOIN LATERAL (
       SELECT ap.punch_type, ap.punched_at,
              (SELECT MAX(ci.punched_at) FROM attendance_punches ci
               WHERE ci.employee_id = ap.employee_id AND ci.punch_type = 'clock_in' AND ci.punched_at <= ap.punched_at) AS clock_in_at
       FROM employees e
       JOIN attendance_punches ap ON ap.employee_id = e.id
       WHERE e.user_id = u.id AND ap.restaurant_id = s.restaurant_id AND ap.punched_at > NOW() - INTERVAL '7 days'
         AND 'staff_payroll' = ANY (restaurant_features(s.restaurant_id))
       ORDER BY ap.punched_at DESC, ap.id DESC
       LIMIT 1
     ) punch ON TRUE
     WHERE s.restaurant_id = $1 AND s.purpose = $2 AND s.disabled_at IS NULL AND s.session_ends_at > NOW()
       AND u.status = 'active' AND u.restaurant_id = s.restaurant_id AND u.token_version = s.token_version
       AND NOT u.password_must_change AND r.status = 'active'
     GROUP BY s.id, punch.punch_type, punch.punched_at, punch.clock_in_at
     ORDER BY s.id`,
    [restaurantId, purpose]
  );
  return result.rows;
};

// Whether any phone in a restaurant may be alerted: most changes stop here.
const anyActive = async (db, restaurantId) =>
  Boolean(await one(db, 'SELECT 1 AS ok FROM push_subscriptions WHERE restaurant_id = $1 AND disabled_at IS NULL AND session_ends_at > NOW() LIMIT 1', [restaurantId]));

// Claims the moments for one phone: only the keys no process has claimed yet
// come back, so whichever process gets them sends, once.
const claim = async (db, subscriptionId, moments) => {
  if (!moments.length) return [];
  const result = await db.query(
    `INSERT INTO push_deliveries (subscription_id, moment) SELECT $1, UNNEST($2::text[])
     ON CONFLICT DO NOTHING RETURNING moment`,
    [subscriptionId, moments]
  );
  return result.rows.map((row) => row.moment);
};

const delivered = async (db, id) => db.query(
  'UPDATE push_subscriptions SET last_success_at = NOW(), failures = 0 WHERE id = $1', [id]);

const failed = async (db, id) => db.query(
  'UPDATE push_subscriptions SET last_failure_at = NOW(), failures = failures + 1 WHERE id = $1', [id]);

// The push service has dropped the address: never sent to again, its keys wiped.
const gone = async (db, id, reason) => db.query(
  `UPDATE push_subscriptions SET disabled_at = NOW(), disabled_reason = $2, p256dh = NULL, auth = NULL
   WHERE id = $1 AND disabled_at IS NULL`, [id, reason]);

// Old deliveries, and phones dropped or whose session ended 30 days ago.
const prune = async (db) => {
  const deliveries = await db.query("DELETE FROM push_deliveries WHERE created_at < NOW() - INTERVAL '2 days'");
  const phones = await db.query(
    `DELETE FROM push_subscriptions
     WHERE disabled_at < NOW() - INTERVAL '30 days' OR session_ends_at < NOW() - INTERVAL '30 days'`);
  return { deliveries: deliveries.rowCount, phones: phones.rowCount };
};

module.exports = { pool, save, findByEndpoint, remove, move, listActive, anyActive, claim, delivered, failed, gone, prune };
