-- Up Migration

-- Staff records. user_id links an employee to their login, where they have one:
-- a cook may be on the payroll without ever signing in.
CREATE TABLE employees (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id      BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id          BIGINT        REFERENCES outlets(id),
  user_id            BIGINT        REFERENCES users(id),
  employee_code      VARCHAR(30),
  name               VARCHAR(150)  NOT NULL,
  mobile             VARCHAR(20),
  email              VARCHAR(150),
  designation        VARCHAR(100),
  department         VARCHAR(30)   NOT NULL DEFAULT 'service'
                     CHECK (department IN ('kitchen', 'service', 'management', 'delivery', 'housekeeping', 'other')),
  employment_type    VARCHAR(20)   NOT NULL DEFAULT 'full_time'
                     CHECK (employment_type IN ('full_time', 'part_time', 'contract')),
  salary_type        VARCHAR(20)   NOT NULL DEFAULT 'monthly'
                     CHECK (salary_type IN ('monthly', 'daily', 'hourly')),
  salary_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (salary_amount >= 0),
  date_of_joining    DATE,
  date_of_leaving    DATE,
  address            TEXT,
  emergency_contact  VARCHAR(20),
  notes              TEXT,
  status             VARCHAR(20)   NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'inactive')),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by         BIGINT        REFERENCES users(id),
  updated_by         BIGINT        REFERENCES users(id),
  CONSTRAINT chk_employee_dates
    CHECK (date_of_leaving IS NULL OR date_of_joining IS NULL OR date_of_leaving >= date_of_joining)
);

CREATE UNIQUE INDEX uq_employees_code
  ON employees (restaurant_id, UPPER(employee_code)) WHERE employee_code IS NOT NULL;
CREATE UNIQUE INDEX uq_employees_user ON employees (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_employees_restaurant ON employees(restaurant_id);

CREATE TRIGGER trg_employees_updated_at
BEFORE UPDATE ON employees
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Shift patterns: Morning 09:00-17:00, Evening 17:00-01:00 and so on.
-- grace_minutes is how late someone may arrive before it counts as late.
CREATE TABLE shifts (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id      BIGINT       REFERENCES outlets(id),
  name           VARCHAR(100) NOT NULL,
  start_time     TIME         NOT NULL,
  end_time       TIME         NOT NULL,
  break_minutes  SMALLINT     NOT NULL DEFAULT 0 CHECK (break_minutes >= 0 AND break_minutes < 600),
  grace_minutes  SMALLINT     NOT NULL DEFAULT 10 CHECK (grace_minutes >= 0 AND grace_minutes < 120),
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_shifts_name ON shifts (restaurant_id, LOWER(name));

CREATE TRIGGER trg_shifts_updated_at
BEFORE UPDATE ON shifts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The roster: who works which shift on which day. One row per person per day.
CREATE TABLE shift_assignments (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT      NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id    BIGINT      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id       BIGINT      REFERENCES shifts(id),
  work_date      DATE        NOT NULL,
  assignment_status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                 CHECK (assignment_status IN ('scheduled', 'week_off', 'leave')),
  notes          VARCHAR(200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     BIGINT      REFERENCES users(id),
  updated_by     BIGINT      REFERENCES users(id),
  UNIQUE (employee_id, work_date)
);

CREATE INDEX idx_shift_assignments_date ON shift_assignments(restaurant_id, work_date);

CREATE TRIGGER trg_shift_assignments_updated_at
BEFORE UPDATE ON shift_assignments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Attendance: one row per person per day. worked/late/overtime minutes are
-- calculated by the server from the times and the shift, never typed in.
CREATE TABLE attendance (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT      NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id       BIGINT      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id          BIGINT      REFERENCES shifts(id),
  attendance_date   DATE        NOT NULL,
  check_in          TIMESTAMPTZ,
  check_out         TIMESTAMPTZ,
  attendance_status VARCHAR(20) NOT NULL DEFAULT 'present'
                    CHECK (attendance_status IN ('present', 'absent', 'half_day', 'leave', 'week_off')),
  worked_minutes    INTEGER     NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  late_minutes      INTEGER     NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  overtime_minutes  INTEGER     NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  notes             VARCHAR(200),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        BIGINT      REFERENCES users(id),
  updated_by        BIGINT      REFERENCES users(id),
  UNIQUE (employee_id, attendance_date),
  CONSTRAINT chk_attendance_times CHECK (check_out IS NULL OR check_in IS NULL OR check_out >= check_in)
);

CREATE INDEX idx_attendance_date ON attendance(restaurant_id, attendance_date);

CREATE TRIGGER trg_attendance_updated_at
BEFORE UPDATE ON attendance
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Permissions for the staff module.
INSERT INTO permissions (code, module, name) VALUES
  ('staff.view',   'staff', 'View staff, roster and attendance'),
  ('staff.manage', 'staff', 'Manage staff, shifts, roster and attendance');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
  (r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER')
     AND p.code IN ('staff.view', 'staff.manage'))
  OR (r.code = 'CASHIER' AND p.code = 'staff.view')
)
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE;

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('staff.view', 'staff.manage'));

DELETE FROM permissions WHERE code IN ('staff.view', 'staff.manage');

DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS shift_assignments;
DROP TABLE IF EXISTS shifts;
DROP TABLE IF EXISTS employees;
