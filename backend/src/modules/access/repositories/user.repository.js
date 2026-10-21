const pool = require("../../../config/database");
const roleRepository = require("./role.repository");

// What sign-in needs to decide: who this is, whether they may come in, and the
// state of their lockout counters.
const LOGIN_COLUMNS = `
  u.id, u.restaurant_id, u.outlet_id, u.name, u.email, u.mobile, u.password_hash, u.status,
  u.token_version, u.failed_login_count, u.first_failed_login_at, u.login_locked_until,
  r.status AS restaurant_status`;

// The same sign-in columns for one person by id: the code step of two-step
// sign-in, which already knows who is signing in.
const findLoginById = async (id) => {
  const result = await pool.query(
    `SELECT ${LOGIN_COLUMNS}
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE u.id = $1`,
    [id]
  );

  return result.rows[0] || null;
};

const findByEmail = async (email) => {
  const result = await pool.query(
    `SELECT ${LOGIN_COLUMNS}
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE LOWER(u.email) = LOWER($1)`,
    [email]
  );

  return result.rows[0] || null;
};

// Mobiles are compared on their last ten digits, so "+91 98480 11101",
// "098480-11101" and "9848011101" are the same phone. The same number may be
// a login at more than one restaurant; `restaurantCode`, when given, picks
// the restaurant. More than one row back means sign-in cannot tell who it is.
const findByMobile = async (digits, restaurantCode = null) => {
  const result = await pool.query(
    `SELECT ${LOGIN_COLUMNS}
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE u.mobile IS NOT NULL
       AND RIGHT(regexp_replace(u.mobile, '\\D', '', 'g'), 10) = $1
       AND ($2::text IS NULL OR UPPER(r.code) = UPPER($2))`,
    [digits, restaurantCode || null]
  );

  return result.rows;
};

// An employee code is only unique inside one restaurant, so it always comes
// with the restaurant's code. The employee must be active and linked to a login.
const findByEmployeeCode = async (restaurantCode, employeeCode) => {
  const result = await pool.query(
    `SELECT ${LOGIN_COLUMNS}
     FROM employees e
     JOIN restaurants r ON r.id = e.restaurant_id AND UPPER(r.code) = UPPER($1)
     JOIN users u ON u.id = e.user_id AND u.restaurant_id = e.restaurant_id
     WHERE UPPER(e.employee_code) = UPPER($2) AND e.status = 'active'`,
    [restaurantCode, employeeCode]
  );

  return result.rows[0] || null;
};

// Loads a user with their active roles and the permissions those roles grant,
// plus what the screen needs to know about their session and till.
const findProfileById = async (id) => {
  const result = await pool.query(
    `SELECT u.id, u.restaurant_id, u.outlet_id, u.name, u.email, u.mobile, u.status,
            u.token_version, u.pin_set_at, u.pin_locked_until, u.two_factor_enabled_at,
            r.name AS restaurant_name, r.code AS restaurant_code, r.status AS restaurant_status, r.format AS restaurant_format,
            o.name AS outlet_name, o.status AS outlet_status,
            COALESCE(ras.idle_lock_minutes, 0) AS idle_lock_minutes,
            emp.id AS employee_id, emp.employee_code,
            -- The restaurant features switched on (Settings -> Features); every
            -- feature check on this request reads this one list.
            restaurant_features(u.restaurant_id) AS features,
            COALESCE(ARRAY_AGG(DISTINCT ro.code) FILTER (WHERE ro.code IS NOT NULL), '{}') AS roles,
            -- The code is what permission checks compare against; the name is
            -- what a person should ever see on screen.
            COALESCE(ARRAY_AGG(DISTINCT ro.name) FILTER (WHERE ro.name IS NOT NULL), '{}') AS role_names,
            COALESCE(ARRAY_AGG(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     LEFT JOIN outlets o ON o.id = u.outlet_id
     LEFT JOIN restaurant_access_settings ras ON ras.restaurant_id = u.restaurant_id
     LEFT JOIN employees emp ON emp.user_id = u.id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
     LEFT JOIN role_permissions rp ON rp.role_id = ro.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE u.id = $1
     GROUP BY u.id, r.id, o.id, ras.restaurant_id, emp.id`,
    [id]
  );

  return result.rows[0] || null;
};

const updateLastLogin = async (id) => {
  await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [id]);
};

// --- Lockout counters ------------------------------------------------------
//
// Five tries in fifteen minutes, whoever sends them and however fast. Every
// password or PIN attempt first takes a numbered place in the current window,
// in one statement under a row lock, BEFORE anything is compared:
//
//   reserve  -> place 1..5: go ahead and compare
//               place 6+ or a lock in force: refused, nothing is compared
//   miss     -> the attempt that used the last place sets the lock
//   hit      -> the window starts again (a lock already set stays)
//
// Counting after the compare (as before) let a burst of parallel guesses all
// read "not locked yet" and all be checked; now at most five are ever checked
// per window. A window starts afresh once it is older than the window length
// or a lock has run out.
//
// A remembered device (user_trusted_devices) keeps its own count, so wrong
// passwords typed anywhere else never lock out the owner's own phone or till,
// and a stolen device token gets no more guesses than anyone else.

const LOCK_COLUMNS = {
  login: { table: "users", count: "failed_login_count", first: "first_failed_login_at", lock: "login_locked_until" },
  pin: { table: "users", count: "pin_failed_count", first: "pin_first_failed_at", lock: "pin_locked_until" },
  device: { table: "user_trusted_devices", count: "failed_count", first: "first_failed_at", lock: "locked_until" },
};

// db (each of these): the pool, or the client of a transaction already open
// (the approval prompt counts a manager's PIN tries under the till's lock).
const reserveAttempt = (kind) => async (id, { attempts, windowMinutes }, db = pool) => {
  const { table, count, first, lock } = LOCK_COLUMNS[kind];

  const result = await db.query(
    `WITH cur AS (
       SELECT id, ${count} AS tries, ${first} AS started, ${lock} AS locked_until
       FROM ${table} WHERE id = $1
       FOR UPDATE
     ), next AS (
       SELECT id, tries, started,
              (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked,
              (started IS NULL OR started < NOW() - make_interval(mins => $2)
               OR (locked_until IS NOT NULL AND locked_until <= NOW())) AS fresh
       FROM cur
     )
     UPDATE ${table} u
     SET ${count} = CASE WHEN next.is_locked THEN u.${count}
                         WHEN next.fresh THEN 1
                         ELSE LEAST(next.tries + 1, 30000) END,
         ${first} = CASE WHEN next.is_locked THEN u.${first}
                         WHEN next.fresh THEN NOW()
                         ELSE next.started END,
         ${lock} = CASE WHEN next.is_locked THEN u.${lock}
                        WHEN next.fresh THEN NULL
                        ELSE u.${lock} END
     FROM next
     WHERE u.id = next.id
     RETURNING next.is_locked, u.${count} AS place, u.${lock} AS locked_until`,
    [id, windowMinutes]
  );

  const row = result.rows[0];

  if (!row) {
    return { allowed: false, place: 0, lockedUntil: null };
  }

  if (row.is_locked) {
    return { allowed: false, place: row.place, lockedUntil: row.locked_until };
  }

  // Every try in this window is already taken by attempts still being
  // checked. Refused like a lock; the one that used the last try locks it.
  if (row.place > attempts) {
    return { allowed: false, place: row.place, lockedUntil: null };
  }

  return { allowed: true, place: row.place, attemptsLeft: attempts - row.place };
};

// A wrong password or PIN. The attempt holding the last place locks the
// account (or PIN) for lockMinutes.
const recordMiss = (kind) => async (id, place, { attempts, lockMinutes }, db = pool) => {
  const { table, lock } = LOCK_COLUMNS[kind];

  if (place < attempts) {
    return { justLocked: false, lockedUntil: null, attemptsLeft: attempts - place };
  }

  const result = await db.query(
    `UPDATE ${table}
     SET ${lock} = CASE WHEN ${lock} IS NULL OR ${lock} <= NOW()
                        THEN NOW() + make_interval(mins => $2) ELSE ${lock} END
     WHERE id = $1
     RETURNING ${lock} AS locked_until`,
    [id, lockMinutes]
  );

  return {
    justLocked: true,
    lockedUntil: result.rows[0] ? result.rows[0].locked_until : null,
    attemptsLeft: 0,
  };
};

// The right password or PIN: the count starts again. A lock set meanwhile by
// other attempts is left in place; only time or an admin lifts a lock.
const recordHit = (kind) => async (id, db = pool) => {
  const { table, count, first } = LOCK_COLUMNS[kind];

  await db.query(
    `UPDATE ${table} SET ${count} = 0, ${first} = NULL
     WHERE id = $1 AND (${count} <> 0 OR ${first} IS NOT NULL)`,
    [id]
  );
};

// Hands back a place that turned out not to be this account's try: a mobile
// number shared by two logins, where the password was the other one's.
const releaseAttempt = (kind) => async (id) => {
  const { table, count, lock } = LOCK_COLUMNS[kind];

  await pool.query(
    `UPDATE ${table} SET ${count} = GREATEST(${count} - 1, 0)
     WHERE id = $1 AND ${count} > 0 AND (${lock} IS NULL OR ${lock} <= NOW())`,
    [id]
  );
};

const reserveLoginAttempt = reserveAttempt("login");
const recordLoginMiss = recordMiss("login");
const recordLoginHit = recordHit("login");
const releaseLoginAttempt = releaseAttempt("login");
const reservePinAttempt = reserveAttempt("pin");
const recordPinMiss = recordMiss("pin");
const recordPinHit = recordHit("pin");
const reserveDeviceAttempt = reserveAttempt("device");
const recordDeviceMiss = recordMiss("device");
const recordDeviceHit = recordHit("device");
const releaseDeviceAttempt = releaseAttempt("device");

// --- Remembered devices ------------------------------------------------------

// The remembered device among `tokenHashes` for this person: not expired, and
// remembered under their current token version (a password change, reset or
// "sign out everywhere" since then forgets it).
const findTrustedDevice = async (userId, tokenHashes) => {
  if (!tokenHashes || tokenHashes.length === 0) {
    return null;
  }

  const result = await pool.query(
    `SELECT d.id, d.user_id, d.failed_count, d.locked_until, d.two_factor_passed_at, d.two_factor_trusted_until
     FROM user_trusted_devices d
     JOIN users u ON u.id = d.user_id
     WHERE d.user_id = $1 AND d.token_hash = ANY($2::text[])
       AND d.expires_at > NOW() AND d.token_version = u.token_version
     LIMIT 1`,
    [userId, tokenHashes]
  );

  return result.rows[0] || null;
};

// Remembers a device after a good password. Each person keeps their ten most
// recent devices; expired and older ones are dropped.
//
// Returns the new device's id (two-step marks it as passed on it).
const rememberDevice = async ({ userId, restaurantId, tokenHash, userAgent, days }) => {
  const inserted = await pool.query(
    `INSERT INTO user_trusted_devices (restaurant_id, user_id, token_hash, token_version, user_agent, expires_at)
     SELECT $1, u.id, $3, u.token_version, $4, NOW() + make_interval(days => $5)
     FROM users u WHERE u.id = $2
     RETURNING id`,
    [restaurantId || null, userId, tokenHash, userAgent ? String(userAgent).slice(0, 300) : null, days]
  );

  await pool.query(
    `DELETE FROM user_trusted_devices
     WHERE user_id = $1
       AND (expires_at <= NOW()
            OR id NOT IN (SELECT id FROM user_trusted_devices WHERE user_id = $1
                          ORDER BY last_used_at DESC, id DESC LIMIT 10))`,
    [userId]
  );

  return inserted.rows[0] ? inserted.rows[0].id : null;
};

// A good sign-in from a remembered device keeps it remembered for another
// stretch.
const touchDevice = async (id, days) => {
  await pool.query(
    `UPDATE user_trusted_devices
     SET last_used_at = NOW(), expires_at = NOW() + make_interval(days => $2)
     WHERE id = $1`,
    [id, days]
  );
};

// After this person's own password change or "sign out other devices": the
// device they did it from is stamped with the new version and stays
// remembered; every other device is forgotten by the version bump itself.
const restampDevice = async (userId, tokenHashes) => {
  if (!tokenHashes || tokenHashes.length === 0) {
    return;
  }

  await pool.query(
    `UPDATE user_trusted_devices d
     SET token_version = u.token_version
     FROM users u
     WHERE u.id = d.user_id AND d.user_id = $1 AND d.token_hash = ANY($2::text[]) AND d.expires_at > NOW()`,
    [userId, tokenHashes]
  );
};

// An admin's "unlock", and a password reset: counters and lock both cleared.
const clearLoginFailures = async (id) => {
  await pool.query(
    `UPDATE users
     SET failed_login_count = 0, first_failed_login_at = NULL, login_locked_until = NULL
     WHERE id = $1 AND (failed_login_count <> 0 OR login_locked_until IS NOT NULL)`,
    [id]
  );
};

// An admin's "unlock" also frees the person's remembered devices.
const clearDeviceFailures = async (userId) => {
  await pool.query(
    `UPDATE user_trusted_devices
     SET failed_count = 0, first_failed_at = NULL, locked_until = NULL
     WHERE user_id = $1 AND (failed_count <> 0 OR locked_until IS NOT NULL)`,
    [userId]
  );
};

const clearPinFailures = async (id) => {
  await pool.query(
    `UPDATE users
     SET pin_failed_count = 0, pin_first_failed_at = NULL, pin_locked_until = NULL
     WHERE id = $1 AND (pin_failed_count <> 0 OR pin_locked_until IS NOT NULL)`,
    [id]
  );
};

// --- Sessions --------------------------------------------------------------

// Ends every session issued so far. Returns the new version, which the caller
// may put in a fresh token so the device it was done from stays signed in.
const bumpTokenVersion = async (id) => {
  const result = await pool.query(
    "UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version",
    [id]
  );

  return result.rows[0] ? result.rows[0].token_version : null;
};

// --- Personal PIN ----------------------------------------------------------

const findPinById = async (id) => {
  const result = await pool.query(
    `SELECT u.id, u.restaurant_id, u.name, u.mobile, u.status, u.pin_hash, u.pin_set_at,
            u.pin_failed_count, u.pin_first_failed_at, u.pin_locked_until, u.login_locked_until,
            r.status AS restaurant_status
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE u.id = $1`,
    [id]
  );

  return result.rows[0] || null;
};

const setPin = async (id, pinHash, byUserId) => {
  const result = await pool.query(
    `UPDATE users
     SET pin_hash = $2, pin_set_at = NOW(), pin_failed_count = 0, pin_first_failed_at = NULL,
         pin_locked_until = NULL, updated_by = $3
     WHERE id = $1
     RETURNING id`,
    [id, pinHash, byUserId]
  );

  return result.rows[0] || null;
};

const clearPin = async (id, byUserId) => {
  const result = await pool.query(
    `UPDATE users
     SET pin_hash = NULL, pin_set_at = NULL, pin_failed_count = 0, pin_first_failed_at = NULL,
         pin_locked_until = NULL, updated_by = $2
     WHERE id = $1
     RETURNING id`,
    [id, byUserId]
  );

  return result.rows[0] || null;
};

// The people who can take over a shared till: active, with a PIN.
const findTillUsers = async (restaurantId) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.outlet_id, u.pin_locked_until,
            COALESCE(ARRAY_AGG(DISTINCT ro.name) FILTER (WHERE ro.name IS NOT NULL), '{}') AS role_names
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
     WHERE u.restaurant_id = $1 AND u.status = 'active' AND u.pin_hash IS NOT NULL
     GROUP BY u.id
     ORDER BY u.name`,
    [restaurantId]
  );

  return result.rows;
};

// The people who can approve one permission: active, holding it through an
// active role, with a PIN set. pin_hash comes back for the PIN-only check.
const findApprovers = async (restaurantId, permission, db = pool) => {
  const result = await db.query(
    `SELECT DISTINCT u.id, u.name, u.pin_hash, u.pin_locked_until
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
     JOIN role_permissions rp ON rp.role_id = ro.id
     JOIN permissions p ON p.id = rp.permission_id AND p.code = $2
     WHERE u.restaurant_id = $1 AND u.status = 'active' AND u.pin_hash IS NOT NULL
     ORDER BY u.name`,
    [restaurantId, permission]
  );

  return result.rows;
};

// --- Sign-in history -------------------------------------------------------

// Best-effort: a history row that cannot be written never blocks a sign-in.
const recordSignIn = async (entry) => {
  try {
    await pool.query(
      `INSERT INTO user_sign_ins (restaurant_id, user_id, method, outcome, identifier, ip_address, user_agent,
                                  trusted_device, two_factor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.restaurantId || null,
        entry.userId,
        entry.method,
        entry.outcome,
        entry.identifier ? String(entry.identifier).slice(0, 150) : null,
        entry.ip ? String(entry.ip).slice(0, 64) : null,
        entry.userAgent ? String(entry.userAgent).slice(0, 300) : null,
        Boolean(entry.trustedDevice),
        // How the second step went: passed, failed, a recovery code, a
        // device trusted for 30 days, or set up there and then.
        entry.twoFactor || null,
      ]
    );
  } catch (error) {
    console.error("Could not write sign-in history:", error.message);
  }
};

const findSignIns = async (userId, limit = 50) => {
  const result = await pool.query(
    `SELECT id, method, outcome, identifier, ip_address, user_agent, trusted_device, two_factor, created_at
     FROM user_sign_ins
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows;
};

// --- Till settings ---------------------------------------------------------

const findAccessSettings = async (restaurantId) => {
  const result = await pool.query(
    "SELECT idle_lock_minutes, updated_at FROM restaurant_access_settings WHERE restaurant_id = $1",
    [restaurantId]
  );

  return result.rows[0] || { idle_lock_minutes: 0, updated_at: null };
};

const saveAccessSettings = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO restaurant_access_settings (restaurant_id, idle_lock_minutes, created_by, updated_by)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (restaurant_id) DO UPDATE SET
       idle_lock_minutes = EXCLUDED.idle_lock_minutes,
       updated_by = EXCLUDED.updated_by
     RETURNING idle_lock_minutes, updated_at`,
    [restaurantId, data.idleLockMinutes, userId]
  );

  return result.rows[0];
};

// --- Admin Web: user management (all scoped to one restaurant) ---

const LIST_QUERY = `
  SELECT u.id, u.name, u.email, u.mobile, u.status, u.outlet_id, u.last_login_at,
         u.created_at, u.updated_at, u.pin_set_at, u.pin_locked_until, u.login_locked_until,
         u.two_factor_enabled_at,
         -- One of their roles is on the restaurant's "must use two-step" list.
         EXISTS (SELECT 1 FROM user_roles tur
                 JOIN restaurant_two_factor_roles tfr ON tfr.role_id = tur.role_id
                                                     AND tfr.restaurant_id = u.restaurant_id
                 WHERE tur.user_id = u.id) AS two_factor_required,
         o.name AS outlet_name,
         emp.id AS employee_id, emp.name AS employee_name, emp.employee_code,
         COALESCE(ARRAY_AGG(DISTINCT ro.id) FILTER (WHERE ro.id IS NOT NULL), '{}') AS role_ids,
         COALESCE(ARRAY_AGG(DISTINCT ro.code) FILTER (WHERE ro.code IS NOT NULL), '{}') AS roles,
         COALESCE(ARRAY_AGG(DISTINCT ro.name) FILTER (WHERE ro.name IS NOT NULL), '{}') AS role_names,
         -- Id and name together (the arrays above are sorted separately), so a
         -- screen without "view roles" can still filter people by role.
         COALESCE(JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT('id', ro.id, 'name', ro.name, 'code', ro.code))
                  FILTER (WHERE ro.id IS NOT NULL), '[]'::jsonb) AS role_list
  FROM users u
  LEFT JOIN outlets o ON o.id = u.outlet_id
  LEFT JOIN employees emp ON emp.user_id = u.id
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles ro ON ro.id = ur.role_id
`;

const findAll = async (restaurantId) => {
  const result = await pool.query(
    `${LIST_QUERY}
     WHERE u.restaurant_id = $1
     GROUP BY u.id, o.name, emp.id
     ORDER BY u.name`,
    [restaurantId]
  );

  return result.rows;
};

const findByIdForRestaurant = async (restaurantId, id, db = pool) => {
  const result = await db.query(
    `${LIST_QUERY}
     WHERE u.restaurant_id = $1 AND u.id = $2
     GROUP BY u.id, o.name, emp.id`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// Every permission a set of roles grants (active roles only).
const findPermissionsOfRoles = async (roleIds) => {
  const result = await pool.query(
    `SELECT DISTINCT p.code
     FROM roles ro
     JOIN role_permissions rp ON rp.role_id = ro.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ro.id = ANY($1::bigint[]) AND ro.status = 'active'`,
    [roleIds]
  );

  return result.rows.map((row) => row.code);
};

// Every permission one user holds today.
const findPermissionsOfUser = async (userId) => {
  const result = await pool.query(
    `SELECT DISTINCT p.code
     FROM user_roles ur
     JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
     JOIN role_permissions rp ON rp.role_id = ro.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId]
  );

  return result.rows.map((row) => row.code);
};

// How many OTHER active users can still run the restaurant's access: they hold
// both "manage users" and "manage roles". Used so the last one cannot be
// removed, demoted or deactivated.
const countOtherAdmins = async (restaurantId, excludingUserId) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM users u
     WHERE u.restaurant_id = $1 AND u.status = 'active' AND u.id <> $2
       AND (SELECT COUNT(DISTINCT p.code)
            FROM user_roles ur
            JOIN roles ro ON ro.id = ur.role_id AND ro.status = 'active'
            JOIN role_permissions rp ON rp.role_id = ro.id
            JOIN permissions p ON p.id = rp.permission_id
            WHERE ur.user_id = u.id AND p.code IN ('users.manage', 'roles.manage')) = 2`,
    [restaurantId, excludingUserId]
  );

  return result.rows[0].count;
};

// Another login of the same restaurant already using this phone (compared on
// its last ten digits). Platform accounts, which have no restaurant, are
// compared with each other.
const findMobileClash = async (digits, excludingUserId, restaurantId) => {
  const result = await pool.query(
    `SELECT id, name FROM users
     WHERE mobile IS NOT NULL
       AND RIGHT(regexp_replace(mobile, '\\D', '', 'g'), 10) = $1
       AND id <> $2
       AND restaurant_id IS NOT DISTINCT FROM $3::bigint
     LIMIT 1`,
    [digits, excludingUserId || 0, restaurantId || null]
  );

  return result.rows[0] || null;
};

// The user row and its role links are written together, or not at all.
const create = async (restaurantId, data, userId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO users (restaurant_id, outlet_id, name, email, mobile, password_hash, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING id`,
      [
        restaurantId,
        data.outletId,
        data.name,
        data.email,
        data.mobile,
        data.passwordHash,
        data.status,
        userId,
      ]
    );

    const newId = inserted.rows[0].id;

    for (const roleId of data.roleIds) {
      await client.query(
        "INSERT INTO user_roles (user_id, role_id, created_by) VALUES ($1, $2, $3)",
        [newId, roleId, userId]
      );
    }

    await client.query("COMMIT");
    return await findByIdForRestaurant(restaurantId, newId, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// A deactivated (or locked) account also has its sessions ended, so an open
// screen stops working on its next request rather than at the next sign-in.
//
// `assertAfter(client)` runs inside the transaction once the change is made,
// under the restaurant's access lock (see role.repository lockAccess), and may
// throw to undo it — used so the restaurant always keeps an admin even when
// two admins change each other at the same moment.
const update = async (restaurantId, id, data, userId, assertAfter = null) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await roleRepository.lockAccess(client, restaurantId);

    const updated = await client.query(
      `UPDATE users
       SET name = $3, email = $4, mobile = $5, outlet_id = $6, status = $7, updated_by = $8,
           token_version = CASE WHEN $7::varchar <> 'active' AND status = 'active'
                                THEN token_version + 1 ELSE token_version END
       WHERE restaurant_id = $1 AND id = $2
       RETURNING id`,
      [restaurantId, id, data.name, data.email, data.mobile, data.outletId, data.status, userId]
    );

    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);

    for (const roleId of data.roleIds) {
      await client.query(
        "INSERT INTO user_roles (user_id, role_id, created_by) VALUES ($1, $2, $3)",
        [id, roleId, userId]
      );
    }

    if (assertAfter) {
      await assertAfter(client);
    }

    await client.query("COMMIT");
    return await findByIdForRestaurant(restaurantId, id, client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// A reset also ends every session the person had: whoever was using the old
// password is signed out on their next request.
const updatePassword = async (restaurantId, id, passwordHash, userId) => {
  const result = await pool.query(
    `UPDATE users
     SET password_hash = $3, updated_by = $4, token_version = token_version + 1,
         failed_login_count = 0, first_failed_login_at = NULL, login_locked_until = NULL
     WHERE restaurant_id = $1 AND id = $2
     RETURNING id`,
    [restaurantId, id, passwordHash, userId]
  );

  return result.rows[0] || null;
};

// Someone changing their OWN password: scoped by user id alone, because a
// platform owner has no restaurant to scope by.
const findCredentialsById = async (id) => {
  const result = await pool.query(
    `SELECT id, restaurant_id, password_hash, token_version, login_locked_until
     FROM users WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
};

// Their other sessions end; the caller issues a fresh token for this device.
const updateOwnPassword = async (id, passwordHash) => {
  const result = await pool.query(
    `UPDATE users SET password_hash = $2, updated_by = $1, token_version = token_version + 1
     WHERE id = $1 RETURNING id, token_version`,
    [id, passwordHash]
  );

  return result.rows[0] || null;
};

// Only the details that are nobody else's business to set: not email, which is
// the login, and not roles or status.
const updateOwnProfile = async (id, data) => {
  const result = await pool.query(
    "UPDATE users SET name = $2, mobile = $3, updated_by = $1 WHERE id = $1 RETURNING id",
    [id, data.name, data.mobile]
  );

  return result.rows[0] || null;
};

module.exports = {
  findLoginById,
  findByEmail,
  findByMobile,
  findByEmployeeCode,
  findCredentialsById,
  updateOwnPassword,
  updateOwnProfile,
  findProfileById,
  updateLastLogin,
  reserveLoginAttempt,
  recordLoginMiss,
  recordLoginHit,
  releaseLoginAttempt,
  reservePinAttempt,
  recordPinMiss,
  recordPinHit,
  reserveDeviceAttempt,
  recordDeviceMiss,
  recordDeviceHit,
  releaseDeviceAttempt,
  findTrustedDevice,
  rememberDevice,
  touchDevice,
  restampDevice,
  clearLoginFailures,
  clearDeviceFailures,
  clearPinFailures,
  bumpTokenVersion,
  findPinById,
  setPin,
  clearPin,
  findTillUsers,
  findApprovers,
  recordSignIn,
  findSignIns,
  findAccessSettings,
  saveAccessSettings,
  findAll,
  findByIdForRestaurant,
  findPermissionsOfRoles,
  findPermissionsOfUser,
  countOtherAdmins,
  findMobileClash,
  create,
  update,
  updatePassword,
};
