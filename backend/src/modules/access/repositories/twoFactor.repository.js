const pool = require("../../../config/database");

// Two-step sign-in: the person's state, the recovery codes, remembered
// devices' two-step marks, and the roles a restaurant requires it for.

// Everything sign-in needs to decide whether to ask for a code. The secret
// itself is read only by findSecret, never with the person's profile.
const findState = async (userId) => {
  const result = await pool.query(
    `SELECT u.id, u.restaurant_id, u.two_factor_enabled_at, u.two_factor_pending_at,
            (SELECT COUNT(*)::int FROM user_recovery_codes c
             WHERE c.user_id = u.id AND c.used_at IS NULL) AS recovery_codes_left,
            EXISTS (
              SELECT 1
              FROM user_roles ur
              JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
              JOIN restaurant_two_factor_roles tr ON tr.role_id = ro.id AND tr.restaurant_id = u.restaurant_id
              WHERE ur.user_id = u.id
            ) AS required
     FROM users u
     WHERE u.id = $1`,
    [userId]
  );

  return result.rows[0] || null;
};

const findSecret = async (userId) => {
  const result = await pool.query(
    "SELECT two_factor_secret, two_factor_pending, two_factor_last_step FROM users WHERE id = $1",
    [userId]
  );

  return result.rows[0] || null;
};

// Only while two-step is off: a new secret must never be lined up behind a
// working one (that is how a second phone could be slipped onto an account).
// false when two-step is already on.
const savePending = async (userId, encrypted) => {
  const result = await pool.query(
    `UPDATE users SET two_factor_pending = $2, two_factor_pending_at = NOW()
     WHERE id = $1 AND two_factor_enabled_at IS NULL
     RETURNING id`,
    [userId, encrypted]
  );

  return result.rows.length > 0;
};

// The salt of the person's current recovery-code set (null for a set made
// before salted codes, which is checked the older way).
const findRecoverySalt = async (userId) => {
  const result = await pool.query("SELECT two_factor_recovery_salt FROM users WHERE id = $1", [userId]);
  return result.rows[0] ? result.rows[0].two_factor_recovery_salt : null;
};

// Turning it on: the pending secret becomes the real one, the first code's
// step is spent, and a fresh set of recovery codes replaces any old ones —
// all together or not at all. Never over a secret already in use: false when
// two-step is already on or nothing is being set up.
const enable = async (userId, restaurantId, step, codeHashes, salt) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE users
       SET two_factor_secret = two_factor_pending, two_factor_enabled_at = NOW(), two_factor_last_step = $2,
           two_factor_pending = NULL, two_factor_pending_at = NULL
       WHERE id = $1 AND two_factor_pending IS NOT NULL AND two_factor_enabled_at IS NULL
       RETURNING id`,
      [userId, step]
    );

    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await replaceCodes(client, userId, restaurantId, codeHashes, salt);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const replaceCodes = async (db, userId, restaurantId, codeHashes, salt) => {
  await db.query("UPDATE users SET two_factor_recovery_salt = $2 WHERE id = $1", [userId, salt || null]);
  await db.query("DELETE FROM user_recovery_codes WHERE user_id = $1", [userId]);
  await db.query(
    `INSERT INTO user_recovery_codes (restaurant_id, user_id, code_hash)
     SELECT $1, $2, hash FROM UNNEST($3::text[]) AS hash`,
    [restaurantId || null, userId, codeHashes]
  );
};

const newCodes = async (userId, restaurantId, codeHashes, salt) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await replaceCodes(client, userId, restaurantId, codeHashes, salt);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Spends the step a code was accepted for. Only a step later than the last
// one passes, in one statement, so the same code typed twice (or on two
// screens at once) works only once.
const spendStep = async (userId, step) => {
  const result = await pool.query(
    `UPDATE users SET two_factor_last_step = $2
     WHERE id = $1 AND two_factor_secret IS NOT NULL
       AND (two_factor_last_step IS NULL OR two_factor_last_step < $2)
     RETURNING id`,
    [userId, step]
  );

  return result.rows.length > 0;
};

// Spends one recovery code; false when it is not theirs or already used.
const spendRecoveryCode = async (userId, codeHash) => {
  const result = await pool.query(
    `UPDATE user_recovery_codes SET used_at = NOW()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
     RETURNING id`,
    [userId, codeHash]
  );

  return result.rows.length > 0;
};

// Off: the secret, the codes and every device's two-step marks go. `endSessions`
// (an admin's reset) also signs the person out everywhere.
const disable = async (userId, { endSessions = false } = {}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users
       SET two_factor_secret = NULL, two_factor_enabled_at = NULL, two_factor_last_step = NULL,
           two_factor_pending = NULL, two_factor_pending_at = NULL, two_factor_recovery_salt = NULL,
           token_version = CASE WHEN $2 THEN token_version + 1 ELSE token_version END
       WHERE id = $1`,
      [userId, endSessions]
    );
    await client.query("DELETE FROM user_recovery_codes WHERE user_id = $1", [userId]);
    await client.query(
      `UPDATE user_trusted_devices SET two_factor_passed_at = NULL, two_factor_trusted_until = NULL
       WHERE user_id = $1`,
      [userId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// --- Sign-in tickets: each works once -------------------------------------------

// Whether a ticket has been used already.
const isTicketSpent = async (ticketId) => {
  const result = await pool.query("SELECT 1 FROM user_two_factor_spent_tickets WHERE ticket_id = $1", [ticketId]);
  return result.rows.length > 0;
};

// Marks a ticket used. false when it was used already (two requests with the
// same ticket at once: only one wins). Rows well past their ticket's own
// expiry are no longer needed and go on the way.
const spendTicket = async (ticketId, userId, expiresAt) => {
  await pool.query("DELETE FROM user_two_factor_spent_tickets WHERE expires_at < NOW() - INTERVAL '1 hour'");

  const result = await pool.query(
    `INSERT INTO user_two_factor_spent_tickets (ticket_id, user_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (ticket_id) DO NOTHING
     RETURNING ticket_id`,
    [ticketId, userId, expiresAt]
  );

  return result.rows.length > 0;
};

// --- Remembered devices ---------------------------------------------------------

// This device passed two-step for this person; with `trustDays`, it is also
// not asked again until then.
const markDevicePassed = async (deviceId, userId, trustDays = 0) => {
  await pool.query(
    `UPDATE user_trusted_devices
     SET two_factor_passed_at = NOW(),
         two_factor_trusted_until = CASE WHEN $3::int > 0 THEN NOW() + make_interval(days => $3::int)
                                         ELSE two_factor_trusted_until END
     WHERE id = $1 AND user_id = $2`,
    [deviceId, userId, trustDays]
  );
};

// A password change, "sign out everywhere" or a reset ends every device's
// 30-day trust: the next sign-in asks for a code again.
const endDeviceTrust = async (userId) => {
  await pool.query(
    `UPDATE user_trusted_devices SET two_factor_trusted_until = NULL
     WHERE user_id = $1 AND two_factor_trusted_until IS NOT NULL`,
    [userId]
  );
};

// The device row a challenge names, if it is still this person's and still
// remembered under their current token version.
const findDevice = async (deviceId, userId) => {
  const result = await pool.query(
    `SELECT d.id, d.user_id, d.two_factor_passed_at, d.two_factor_trusted_until
     FROM user_trusted_devices d
     JOIN users u ON u.id = d.user_id
     WHERE d.id = $1 AND d.user_id = $2 AND d.expires_at > NOW() AND d.token_version = u.token_version`,
    [deviceId, userId]
  );

  return result.rows[0] || null;
};

// A device among `tokenHashes` where this person has passed two-step before.
const findPassedDevice = async (userId, tokenHashes) => {
  if (!tokenHashes || tokenHashes.length === 0) {
    return null;
  }

  const result = await pool.query(
    `SELECT d.id
     FROM user_trusted_devices d
     JOIN users u ON u.id = d.user_id
     WHERE d.user_id = $1 AND d.token_hash = ANY($2::text[])
       AND d.expires_at > NOW() AND d.token_version = u.token_version
       AND d.two_factor_passed_at IS NOT NULL
     LIMIT 1`,
    [userId, tokenHashes]
  );

  return result.rows[0] || null;
};

const countTrustedDevices = async (userId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM user_trusted_devices
     WHERE user_id = $1 AND two_factor_trusted_until > NOW()`,
    [userId]
  );

  return result.rows[0].count;
};

// --- Roles that must use it -------------------------------------------------------

const findRequiredRoles = async (restaurantId) => {
  const result = await pool.query(
    `SELECT tr.role_id, ro.name, ro.code
     FROM restaurant_two_factor_roles tr
     JOIN roles ro ON ro.id = tr.role_id
     WHERE tr.restaurant_id = $1
     ORDER BY ro.name`,
    [restaurantId]
  );

  return result.rows;
};

const saveRequiredRoles = async (restaurantId, roleIds, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM restaurant_two_factor_roles WHERE restaurant_id = $1", [restaurantId]);
    await client.query(
      `INSERT INTO restaurant_two_factor_roles (restaurant_id, role_id, created_by)
       SELECT $1, id, $3 FROM UNNEST($2::bigint[]) AS id`,
      [restaurantId, roleIds, userId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  findState,
  findSecret,
  savePending,
  findRecoverySalt,
  enable,
  newCodes,
  spendStep,
  spendRecoveryCode,
  disable,
  isTicketSpent,
  spendTicket,
  markDevicePassed,
  endDeviceTrust,
  findDevice,
  findPassedDevice,
  countTrustedDevices,
  findRequiredRoles,
  saveRequiredRoles,
};
