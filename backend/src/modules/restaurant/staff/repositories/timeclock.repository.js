const pool = require("../../../../config/database");

// Every query here filters by restaurant_id. Functions that take a `client`
// run inside the caller's transaction (a punch locks the employee row first,
// so two taps at once cannot both clock the same person in).

const PIN_COLUMNS = `e.pin_hash, e.pin_set_at, e.pin_failed_attempts, e.pin_first_failed_at,
                     e.pin_locked_until`;

const EMPLOYEE_COLUMNS = `e.id, e.employee_code, e.name, e.designation, e.department, e.status`;

const findTimezone = async (restaurantId, db = pool) => {
  const result = await db.query(
    "SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1",
    [restaurantId]
  );

  return (result.rows[0] && result.rows[0].timezone) || "Asia/Kolkata";
};

// --- Employees and PINs ---

// Everyone who can clock in: active staff, with whether they have a PIN. The
// hash itself never leaves this file except to the PIN check.
const findActiveEmployees = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS}, e.pin_hash IS NOT NULL AS has_pin, e.pin_set_at,
            e.pin_locked_until, e.pin_failed_attempts
     FROM employees e
     WHERE e.restaurant_id = $1 AND e.status = 'active'
     ORDER BY e.name`,
    [restaurantId]
  );

  return result.rows;
};

// With the PIN fields, for the check. Inactive staff are included so the
// service can say "no longer active" rather than "not found".
const findEmployeeForPin = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS}, ${PIN_COLUMNS}, e.mobile
     FROM employees e
     WHERE e.restaurant_id = $1 AND e.id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const findEmployeeByCode = async (restaurantId, code) => {
  const result = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS}, ${PIN_COLUMNS}
     FROM employees e
     WHERE e.restaurant_id = $1 AND UPPER(e.employee_code) = UPPER($2)`,
    [restaurantId, code]
  );

  return result.rows[0] || null;
};

// Takes one PIN attempt BEFORE the PIN is compared, in a single UPDATE, and
// hands back the hash to compare against. Counting first is what makes the
// lockout hold under a burst: a hundred guesses sent at once queue on this
// row, the first five get an attempt each, and the fifth one locks the PIN in
// the same statement — so the other ninety-five are refused without their
// guess ever being checked. (Counting only the failures, after a slow bcrypt
// compare, let every request that read the row before the lock landed have
// its guess checked.)
//
// A new window starts when the last one is over 15 minutes old or a lock has
// run out. No row comes back while the PIN is locked or not set; the caller
// reads the row again to say which.
const reservePinAttempt = async (restaurantId, id, { windowMinutes, maxAttempts, lockMinutes }) => {
  const result = await pool.query(
    `UPDATE employees
     SET pin_failed_attempts =
           CASE WHEN pin_locked_until IS NOT NULL OR pin_first_failed_at IS NULL
                     OR pin_first_failed_at < NOW() - make_interval(mins => $3)
                THEN 1 ELSE pin_failed_attempts + 1 END,
         pin_first_failed_at =
           CASE WHEN pin_locked_until IS NOT NULL OR pin_first_failed_at IS NULL
                     OR pin_first_failed_at < NOW() - make_interval(mins => $3)
                THEN NOW() ELSE pin_first_failed_at END,
         pin_locked_until =
           CASE WHEN (CASE WHEN pin_locked_until IS NOT NULL OR pin_first_failed_at IS NULL
                                OR pin_first_failed_at < NOW() - make_interval(mins => $3)
                           THEN 1 ELSE pin_failed_attempts + 1 END) >= $4
                THEN NOW() + make_interval(mins => $5) ELSE NULL END
     WHERE restaurant_id = $1 AND id = $2 AND pin_hash IS NOT NULL
       AND (pin_locked_until IS NULL OR pin_locked_until <= NOW())
     RETURNING pin_hash, pin_failed_attempts AS attempts, pin_locked_until`,
    [restaurantId, id, windowMinutes, maxAttempts, lockMinutes]
  );

  return result.rows[0] || null;
};

// Why an attempt was not given: no PIN, or locked until when.
const findPinState = async (restaurantId, id) => {
  const result = await pool.query(
    `SELECT pin_hash IS NOT NULL AS has_pin, pin_locked_until
     FROM employees WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const clearPinFailures = async (restaurantId, id) => {
  await pool.query(
    `UPDATE employees
     SET pin_failed_attempts = 0, pin_first_failed_at = NULL, pin_locked_until = NULL
     WHERE restaurant_id = $1 AND id = $2
       AND (pin_failed_attempts > 0 OR pin_locked_until IS NOT NULL)`,
    [restaurantId, id]
  );
};

const listPins = async (restaurantId) => {
  const result = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS}, e.pin_hash IS NOT NULL AS has_pin, e.pin_set_at,
            e.pin_locked_until, e.pin_failed_attempts, e.pin_first_failed_at
     FROM employees e
     WHERE e.restaurant_id = $1 AND e.status = 'active'
     ORDER BY (e.pin_hash IS NULL) DESC, e.name`,
    [restaurantId]
  );

  return result.rows;
};

// Setting a PIN also lifts any lock: the manager has just checked who this is.
const setPin = async (restaurantId, id, hash, userId) => {
  const result = await pool.query(
    `UPDATE employees
     SET pin_hash = $3, pin_set_at = NOW(), pin_failed_attempts = 0,
         pin_first_failed_at = NULL, pin_locked_until = NULL, updated_by = $4
     WHERE restaurant_id = $1 AND id = $2 AND status = 'active'
     RETURNING id, name`,
    [restaurantId, id, hash, userId]
  );

  return result.rows[0] || null;
};

// Returns whether there was a PIN to remove, so the answer can say so.
const removePin = async (restaurantId, id, userId) => {
  const result = await pool.query(
    `WITH before AS (
       SELECT id, pin_hash IS NOT NULL AS had_pin
       FROM employees WHERE restaurant_id = $1 AND id = $2
       FOR UPDATE
     )
     UPDATE employees e
     SET pin_hash = NULL, pin_set_at = NULL, pin_failed_attempts = 0,
         pin_first_failed_at = NULL, pin_locked_until = NULL, updated_by = $3
     FROM before b
     WHERE e.id = b.id
     RETURNING e.id, e.name, b.had_pin`,
    [restaurantId, id, userId]
  );

  return result.rows[0] || null;
};

// --- Punches (inside a transaction) ---

const lockEmployee = async (client, restaurantId, id) => {
  const result = await client.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees e
     WHERE e.restaurant_id = $1 AND e.id = $2
     FOR UPDATE`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

// The latest day this person has any punch on. Where someone stands is read
// from that day's punches — not from their single latest punch, which a
// manager's correction to an earlier day can make look like the latest.
const findLatestWorkDate = async (client, restaurantId, employeeId) => {
  const result = await client.query(
    `SELECT MAX(work_date) AS work_date
     FROM attendance_punches
     WHERE restaurant_id = $1 AND employee_id = $2`,
    [restaurantId, employeeId]
  );

  return result.rows[0] ? result.rows[0].work_date : null;
};

// One person's punches over a few work dates, for checking that no two days
// claim the same hours.
const findPunchesBetween = async (client, restaurantId, employeeId, from, to) => {
  const result = await client.query(
    `SELECT id, work_date, punch_type, punched_at, source
     FROM attendance_punches
     WHERE restaurant_id = $1 AND employee_id = $2 AND work_date BETWEEN $3::date AND $4::date
     ORDER BY work_date, punched_at, id`,
    [restaurantId, employeeId, from, to]
  );

  return result.rows;
};

const findPunchById = async (client, restaurantId, id) => {
  const result = await client.query(
    `SELECT id, employee_id, work_date, punch_type, punched_at, source, note
     FROM attendance_punches
     WHERE restaurant_id = $1 AND id = $2`,
    [restaurantId, id]
  );

  return result.rows[0] || null;
};

const deletePunch = async (client, restaurantId, id) => {
  await client.query("DELETE FROM attendance_punches WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    id,
  ]);
};

// A day whose last punch was taken back has nothing left to say the person
// was here, so the row built from those punches goes too.
const deleteAttendance = async (client, restaurantId, employeeId, workDate) => {
  await client.query(
    "DELETE FROM attendance WHERE restaurant_id = $1 AND employee_id = $2 AND attendance_date = $3::date",
    [restaurantId, employeeId, workDate]
  );
};

const findDayPunches = async (client, restaurantId, employeeId, workDate) => {
  const result = await client.query(
    `SELECT id, work_date, punch_type, punched_at, source, note
     FROM attendance_punches
     WHERE restaurant_id = $1 AND employee_id = $2 AND work_date = $3::date
     ORDER BY punched_at, id`,
    [restaurantId, employeeId, workDate]
  );

  return result.rows;
};

// photo_status: 'taken' or 'missing' when punch photos are on, else NULL.
const insertPunch = async (client, restaurantId, data, userId) => {
  const result = await client.query(
    `INSERT INTO attendance_punches (restaurant_id, employee_id, work_date, punch_type,
                                     punched_at, source, note, created_by, updated_by, photo_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
     RETURNING id, work_date, punch_type, punched_at, source, note, photo_status`,
    [
      restaurantId,
      data.employeeId,
      data.workDate,
      data.punchType,
      data.punchedAt,
      data.source,
      data.note || null,
      userId,
      data.photoStatus || null,
    ]
  );

  return result.rows[0];
};

// --- Punch photos ---

const findSettings = async (restaurantId) => {
  const result = await pool.query(
    "SELECT punch_photos, photo_keep_days, updated_at FROM timeclock_settings WHERE restaurant_id = $1",
    [restaurantId]
  );

  return result.rows[0] || { punch_photos: false, photo_keep_days: 60, updated_at: null };
};

const saveSettings = async (restaurantId, data, userId) => {
  const result = await pool.query(
    `INSERT INTO timeclock_settings (restaurant_id, punch_photos, photo_keep_days, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (restaurant_id) DO UPDATE SET
       punch_photos = EXCLUDED.punch_photos,
       photo_keep_days = EXCLUDED.photo_keep_days,
       updated_by = EXCLUDED.updated_by
     RETURNING punch_photos, photo_keep_days, updated_at`,
    [restaurantId, data.punchPhotos, data.photoKeepDays, userId]
  );

  return result.rows[0];
};

const savePhoto = async (client, restaurantId, data) => {
  await client.query(
    `INSERT INTO attendance_punch_photos (punch_id, restaurant_id, employee_id, mime_type, image)
     VALUES ($1, $2, $3, $4, $5)`,
    [data.punchId, restaurantId, data.employeeId, data.mimeType, data.image]
  );
};

// Photos older than the restaurant keeps them for are deleted.
const purgePhotos = async (restaurantId, keepDays) => {
  const result = await pool.query(
    `DELETE FROM attendance_punch_photos
     WHERE restaurant_id = $1 AND taken_at < NOW() - make_interval(days => $2::int)`,
    [restaurantId, keepDays]
  );

  return result.rowCount;
};

const findPhoto = async (restaurantId, punchId) => {
  const result = await pool.query(
    `SELECT ph.punch_id, ph.mime_type, ph.image, ph.taken_at, ph.employee_id
     FROM attendance_punch_photos ph
     WHERE ph.restaurant_id = $1 AND ph.punch_id = $2`,
    [restaurantId, punchId]
  );

  return result.rows[0] || null;
};

// The roster entry and its shift for one person on the given dates.
const findRosterFor = async (client, restaurantId, employeeId, dates) => {
  const result = await client.query(
    `SELECT a.work_date, a.assignment_status, a.shift_id,
            s.name AS shift_name, s.start_time, s.end_time, s.break_minutes, s.grace_minutes
     FROM shift_assignments a
     LEFT JOIN shifts s ON s.id = a.shift_id
     WHERE a.restaurant_id = $1 AND a.employee_id = $2 AND a.work_date = ANY($3::date[])`,
    [restaurantId, employeeId, dates]
  );

  return result.rows;
};

// The day's attendance row, rebuilt from the punches. Notes a manager wrote
// are kept; the status becomes 'present' because someone who punched in was
// here, whatever the sheet said before.
const upsertAttendance = async (client, restaurantId, data, userId) => {
  const result = await client.query(
    `INSERT INTO attendance (restaurant_id, employee_id, shift_id, attendance_date, check_in,
                             check_out, attendance_status, worked_minutes, break_minutes,
                             late_minutes, overtime_minutes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'present', $7, $8, $9, $10, $11, $11)
     ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
       shift_id = COALESCE(EXCLUDED.shift_id, attendance.shift_id),
       check_in = EXCLUDED.check_in,
       check_out = EXCLUDED.check_out,
       attendance_status = 'present',
       worked_minutes = EXCLUDED.worked_minutes,
       break_minutes = EXCLUDED.break_minutes,
       late_minutes = EXCLUDED.late_minutes,
       overtime_minutes = EXCLUDED.overtime_minutes,
       -- Someone who punched in was here: it is no longer a leave day.
       leave_type_id = NULL,
       updated_by = EXCLUDED.updated_by
     RETURNING id, attendance_date, check_in, check_out, worked_minutes, break_minutes,
               late_minutes, overtime_minutes, attendance_status`,
    [
      restaurantId,
      data.employeeId,
      data.shiftId,
      data.workDate,
      data.checkIn,
      data.checkOut,
      data.workedMinutes,
      data.breakMinutes,
      data.lateMinutes,
      data.overtimeMinutes,
      userId,
    ]
  );

  return result.rows[0];
};

// --- The board ---

const findRosterForDates = async (restaurantId, dates) => {
  const result = await pool.query(
    `SELECT a.employee_id, a.work_date, a.assignment_status, a.shift_id,
            s.name AS shift_name, s.start_time, s.end_time, s.break_minutes, s.grace_minutes
     FROM shift_assignments a
     LEFT JOIN shifts s ON s.id = a.shift_id
     WHERE a.restaurant_id = $1 AND a.work_date = ANY($2::date[])`,
    [restaurantId, dates]
  );

  return result.rows;
};

const findPunchesForDates = async (restaurantId, dates) => {
  const result = await pool.query(
    `SELECT p.id, p.employee_id, p.work_date, p.punch_type, p.punched_at, p.source, p.note,
            u.name AS recorded_by, p.photo_status,
            EXISTS (SELECT 1 FROM attendance_punch_photos ph WHERE ph.punch_id = p.id) AS has_photo
     FROM attendance_punches p
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.restaurant_id = $1 AND p.work_date = ANY($2::date[])
     ORDER BY p.punched_at, p.id`,
    [restaurantId, dates]
  );

  return result.rows;
};

// Days someone clocked in to and never out of, whose open stint began before
// `before`. These are the "forgot to clock out" days a manager has to close by
// hand. The stint is timed from its own clock-in (the latest one that day),
// not the day's first: someone back for a dinner stint after a split has only
// been on the clock since they came back.
const findOpenDays = async (restaurantId, before, sinceDate) => {
  const result = await pool.query(
    `SELECT a.id, a.employee_id, a.attendance_date, a.check_in, e.name, e.employee_code,
            COALESCE(s.session_start, a.check_in) AS session_start
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN LATERAL (
       SELECT MAX(p.punched_at) AS session_start
       FROM attendance_punches p
       WHERE p.restaurant_id = a.restaurant_id AND p.work_date = a.attendance_date
         AND p.employee_id = a.employee_id AND p.punch_type = 'clock_in'
     ) s ON TRUE
     WHERE a.restaurant_id = $1
       AND a.check_in IS NOT NULL AND a.check_out IS NULL
       AND COALESCE(s.session_start, a.check_in) < $2::timestamptz
       AND a.attendance_date >= $3::date
     ORDER BY a.check_in`,
    [restaurantId, before, sinceDate]
  );

  return result.rows;
};

const findAttendanceForDate = async (restaurantId, date) => {
  const result = await pool.query(
    `SELECT id, employee_id, shift_id, attendance_status, check_in, check_out, worked_minutes,
            break_minutes, late_minutes, overtime_minutes, notes
     FROM attendance
     WHERE restaurant_id = $1 AND attendance_date = $2::date`,
    [restaurantId, date]
  );

  return result.rows;
};

// Employees on the day timeline: anyone active, plus anyone inactive who
// still has a record that day (so a person who left mid-month keeps their
// last days on the sheet).
const findEmployeesForDay = async (restaurantId, date) => {
  const result = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS}
     FROM employees e
     WHERE e.restaurant_id = $1
       AND (e.status = 'active'
            OR EXISTS (SELECT 1 FROM attendance_punches p
                       WHERE p.employee_id = e.id AND p.work_date = $2::date))
     ORDER BY e.name`,
    [restaurantId, date]
  );

  return result.rows;
};

// The punch log: newest first, with who recorded it.
const listPunches = async (restaurantId, filters) => {
  const result = await pool.query(
    `SELECT p.id, p.employee_id, p.work_date, p.punch_type, p.punched_at, p.source, p.note,
            e.name AS employee_name, e.employee_code, u.name AS recorded_by,
            COUNT(*) OVER () AS total_count
     FROM attendance_punches p
     JOIN employees e ON e.id = p.employee_id
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.restaurant_id = $1
       AND p.work_date BETWEEN $2::date AND $3::date
       AND ($4::bigint IS NULL OR p.employee_id = $4)
       AND ($5::text IS NULL OR p.source = $5)
     ORDER BY p.punched_at DESC, p.id DESC
     LIMIT $6`,
    [
      restaurantId,
      filters.from,
      filters.to,
      filters.employeeId || null,
      filters.source || null,
      filters.limit,
    ]
  );

  return result.rows;
};

module.exports = {
  pool,
  findTimezone,
  findActiveEmployees,
  findEmployeeForPin,
  findEmployeeByCode,
  reservePinAttempt,
  findPinState,
  clearPinFailures,
  listPins,
  setPin,
  removePin,
  lockEmployee,
  findLatestWorkDate,
  findPunchesBetween,
  findPunchById,
  deletePunch,
  deleteAttendance,
  findDayPunches,
  insertPunch,
  findSettings,
  saveSettings,
  savePhoto,
  purgePhotos,
  findPhoto,
  findRosterFor,
  upsertAttendance,
  findRosterForDates,
  findPunchesForDates,
  findOpenDays,
  findAttendanceForDate,
  findEmployeesForDay,
  listPunches,
};
