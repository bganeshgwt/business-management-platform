-- Up Migration

-- The time clock: a tablet at the staff entrance where each person taps their
-- name, types a PIN and clocks in, takes a break or clocks out.
--
-- The PIN lives on the employee rather than on a login, because most of the
-- people who clock in (cooks, helpers, riders) never sign in to anything.
-- Only a bcrypt hash is kept: nobody, including a manager, can read a PIN back.
--
-- pin_failed_attempts / pin_first_failed_at count wrong PINs inside one
-- 15-minute window; five in the window sets pin_locked_until. The window start
-- is stored (rather than only the last failure) so "5 wrong in 15 minutes"
-- means exactly that, and a slow trickle of typos days apart never locks
-- anyone out.
ALTER TABLE employees
  ADD COLUMN pin_hash             VARCHAR(100),
  ADD COLUMN pin_set_at           TIMESTAMPTZ,
  ADD COLUMN pin_failed_attempts  SMALLINT    NOT NULL DEFAULT 0 CHECK (pin_failed_attempts >= 0),
  ADD COLUMN pin_first_failed_at  TIMESTAMPTZ,
  ADD COLUMN pin_locked_until     TIMESTAMPTZ,
  ADD CONSTRAINT chk_employees_pin_set CHECK (pin_hash IS NULL OR pin_set_at IS NOT NULL);

-- Time off the clock that day, from the punches: breaks taken, plus the gap
-- between two stints on a split shift (lunch, afternoon off, dinner).
-- worked_minutes is check-out minus check-in minus this, so a day read off the
-- attendance sheet always adds up. Rows typed in by hand keep 0 here.
ALTER TABLE attendance
  ADD COLUMN break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0);

-- Every tap on the clock, kept as it happened. The attendance row for the day
-- is worked out from these, so a disputed hour can always be traced back to
-- the punches behind it — and a manager's correction is a new punch marked
-- 'manager' with a reason, never an edit to what the kiosk recorded.
--
-- work_date is the day the shift STARTED: a bar shift from 5 pm to 1 am, and
-- the clock-out at 1:04 am, both belong to the evening it began.
CREATE TABLE attendance_punches (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id    BIGINT       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date      DATE         NOT NULL,
  punch_type     VARCHAR(20)  NOT NULL
                 CHECK (punch_type IN ('clock_in', 'break_start', 'break_end', 'clock_out')),
  punched_at     TIMESTAMPTZ  NOT NULL,
  source         VARCHAR(20)  NOT NULL DEFAULT 'kiosk'
                 CHECK (source IN ('kiosk', 'manager')),
  -- Why a manager entered it ("forgot to clock out, left at 11:30 per CCTV").
  note           VARCHAR(200),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- The login the kiosk (or the manager) was signed in as when it was taken.
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id),
  CONSTRAINT chk_punch_note CHECK (source = 'kiosk' OR note IS NOT NULL)
);

-- One person's day, in order: rebuilding the attendance row after each punch,
-- and the day timeline.
CREATE INDEX idx_attendance_punches_day
  ON attendance_punches (restaurant_id, work_date, employee_id, punched_at);

-- "Where is this person now": the latest punch for one employee.
CREATE INDEX idx_attendance_punches_employee
  ON attendance_punches (employee_id, punched_at DESC);

-- The on-duty board and the bell read the last day or two across everyone.
CREATE INDEX idx_attendance_punches_recent
  ON attendance_punches (restaurant_id, punched_at DESC);

CREATE TRIGGER trg_attendance_punches_updated_at
BEFORE UPDATE ON attendance_punches
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The bell looks for days still open (clocked in, never clocked out). A
-- partial index keeps that a handful of rows however long the history grows.
CREATE INDEX idx_attendance_open
  ON attendance (restaurant_id, check_in)
  WHERE check_in IS NOT NULL AND check_out IS NULL;

-- Using the kiosk is its own permission: a cashier's login often runs the
-- tablet at the door, and they should not need staff.manage (salaries, PINs)
-- for that. Setting PINs stays under staff.manage.
INSERT INTO permissions (code, module, name) VALUES
  ('staff.clock', 'staff', 'Use the staff time clock and see who is on duty');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'staff.clock'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER', 'CASHIER');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'staff.clock');
DELETE FROM permissions WHERE code = 'staff.clock';

DROP INDEX IF EXISTS idx_attendance_open;
DROP TABLE IF EXISTS attendance_punches;

ALTER TABLE attendance DROP COLUMN IF EXISTS break_minutes;

ALTER TABLE employees
  DROP CONSTRAINT IF EXISTS chk_employees_pin_set,
  DROP COLUMN IF EXISTS pin_locked_until,
  DROP COLUMN IF EXISTS pin_first_failed_at,
  DROP COLUMN IF EXISTS pin_failed_attempts,
  DROP COLUMN IF EXISTS pin_set_at,
  DROP COLUMN IF EXISTS pin_hash;
