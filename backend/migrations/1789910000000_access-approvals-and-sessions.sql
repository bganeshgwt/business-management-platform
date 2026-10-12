-- Up Migration

-- ===========================================================================
-- Access: finer permissions, manager approval, personal PINs, sessions,
-- sign-in history, and the payroll records that sit behind staff.salaries.
-- ===========================================================================

-- --- Finer permissions -----------------------------------------------------
-- Until now "billing.manage" meant bill AND void AND discount, and
-- "payments.manage" meant take money AND give it back. An owner could not have
-- a cashier who bills but cannot void, which is the first control every
-- restaurant asks for. Each of these is now its own permission; the ones a
-- cashier lacks can still be done with a manager's PIN (see approvals below).
INSERT INTO permissions (code, module, name) VALUES
  ('orders.cancel_after_kot', 'orders',     'Reduce or remove dishes the kitchen already has'),
  ('bills.void',              'billing',    'Void a bill'),
  ('bills.refund',            'billing',    'Refund money or take back items'),
  ('bills.reprint',           'billing',    'Reprint a bill'),
  ('bills.discount',          'billing',    'Give an on-the-spot discount at the till'),
  ('bills.complimentary',     'billing',    'Make a bill no-charge (complimentary)'),
  ('business_day.close',      'operations', 'Close the business day'),
  ('sales.view',              'reports',    'See takings and sales figures'),
  ('staff.salaries',          'staff',      'See salaries and payroll money'),
  ('menu.availability',       'menu',       'Mark a dish sold out or back on'),
  ('loyalty.adjust',          'crm',        'Add or remove loyalty points by hand'),
  ('audit.view',              'users',      'Read the activity log'),
  ('customers.credit',        'crm',        'Put a bill on a guest''s account (dues)');

-- The older permissions these were carved out of now say what they still
-- cover, so an owner reading a role is not told a cashier can close the day.
UPDATE permissions SET name = 'Open the business day (closing is its own permission)'
WHERE code = 'business_day.manage';
UPDATE permissions SET name = 'Take payments (refunds are their own permission)'
WHERE code = 'payments.manage';

-- Owners and managers get all of them. A cashier can reprint and see the
-- day's takings (they hand over the drawer); captains and the kitchen can
-- mark a dish sold out, because they are the first to know.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
  (r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER')
     AND p.code IN ('orders.cancel_after_kot', 'bills.void', 'bills.refund', 'bills.reprint',
                    'bills.discount', 'bills.complimentary', 'business_day.close', 'sales.view',
                    'staff.salaries', 'menu.availability', 'loyalty.adjust', 'audit.view',
                    'customers.credit'))
  OR (r.code = 'CASHIER' AND p.code IN ('bills.reprint', 'sales.view'))
  OR (r.code IN ('CAPTAIN', 'KITCHEN') AND p.code = 'menu.availability')
)
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE;

-- A restaurant's own roles, made before these permissions existed, keep
-- what they could do yesterday: nobody should find mid-service that the
-- cashier role the owner built can no longer void, or that the owner's own
-- copy of Restaurant Admin can no longer close the day.
--   * An admin-level role (it manages both users and roles) gets all of them.
--   * Any other role gets each new permission that was carved out of an old
--     one it holds: void, reprint and the till discount from billing; refunds
--     and guest dues from payments; closing the day from the business day;
--     salaries from managing staff; the activity log from managing roles;
--     sold-out from the menu; sales figures from reports or billing; hand
--     points from managing customers.
--   * Cancelling dishes the kitchen already has, and complimentary bills, are
--     new controls on purpose: an owner gives them to a custom role by hand.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('orders.cancel_after_kot', 'bills.void', 'bills.refund', 'bills.reprint',
                                 'bills.discount', 'bills.complimentary', 'business_day.close', 'sales.view',
                                 'staff.salaries', 'menu.availability', 'loyalty.adjust', 'audit.view',
                                 'customers.credit')
WHERE r.restaurant_id IS NOT NULL
  AND (
    ( EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
              WHERE x.role_id = r.id AND xp.code = 'users.manage')
      AND EXISTS (SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
                  WHERE x.role_id = r.id AND xp.code = 'roles.manage') )
    OR EXISTS (
      SELECT 1
      FROM role_permissions x
      JOIN permissions xp ON xp.id = x.permission_id
      WHERE x.role_id = r.id
        AND (   (xp.code = 'billing.manage'      AND p.code IN ('bills.void', 'bills.reprint', 'bills.discount', 'sales.view'))
             OR (xp.code = 'payments.manage'     AND p.code IN ('bills.refund', 'customers.credit'))
             OR (xp.code = 'business_day.manage' AND p.code = 'business_day.close')
             OR (xp.code = 'staff.manage'        AND p.code = 'staff.salaries')
             OR (xp.code = 'roles.manage'        AND p.code = 'audit.view')
             OR (xp.code = 'menu.manage'         AND p.code = 'menu.availability')
             OR (xp.code = 'reports.view'        AND p.code = 'sales.view')
             OR (xp.code = 'customers.manage'    AND p.code = 'loyalty.adjust'))
    )
  )
ON CONFLICT DO NOTHING;

-- --- Users: sign-in without an email, sessions, lockout, personal PIN ------

-- Most captains, cooks and helpers have no email address, and owners were
-- inventing fake ones. A login now needs an email OR a mobile number; staff
-- can also sign in with their employee code.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users
  ADD CONSTRAINT chk_users_can_sign_in CHECK (email IS NOT NULL OR mobile IS NOT NULL);

-- A mobile number is one person's sign-in inside ONE restaurant. Someone who
-- works at two restaurants on the platform (a manager of two brands) keeps
-- the same phone at both; signing in by mobile then asks for the restaurant
-- code. Unique across the whole platform, it also let one restaurant learn
-- who another restaurant's staff are from the "already used" message.
-- Platform accounts (no restaurant) are unique among themselves.
DROP INDEX IF EXISTS uq_users_mobile;
CREATE UNIQUE INDEX uq_users_restaurant_mobile
  ON users (COALESCE(restaurant_id, 0), mobile) WHERE mobile IS NOT NULL;

ALTER TABLE users
  -- Every token carries the version it was issued under. Changing or resetting
  -- a password, or "sign out everywhere", bumps it, and every older token stops
  -- working on its next request.
  ADD COLUMN token_version          INTEGER     NOT NULL DEFAULT 0 CHECK (token_version >= 0),
  -- Wrong passwords inside one 15-minute window. Five locks the account for 15
  -- minutes. The window start is stored so "5 in 15 minutes" means exactly
  -- that, and typos days apart never add up to a lockout.
  ADD COLUMN failed_login_count     SMALLINT    NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN first_failed_login_at  TIMESTAMPTZ,
  ADD COLUMN login_locked_until     TIMESTAMPTZ,
  -- One personal PIN (4-6 digits) per person: a manager approving a void at
  -- the till, and unlocking or taking over a shared till. Only a bcrypt hash
  -- is kept; nobody, the owner included, can read a PIN back.
  ADD COLUMN pin_hash               VARCHAR(100),
  ADD COLUMN pin_set_at             TIMESTAMPTZ,
  ADD COLUMN pin_failed_count       SMALLINT    NOT NULL DEFAULT 0 CHECK (pin_failed_count >= 0),
  ADD COLUMN pin_first_failed_at    TIMESTAMPTZ,
  ADD COLUMN pin_locked_until       TIMESTAMPTZ,
  ADD CONSTRAINT chk_users_pin_set CHECK (pin_hash IS NULL OR pin_set_at IS NOT NULL);

-- --- Till settings per restaurant ----------------------------------------
-- How long a shared till may sit untouched before it locks itself. 0 = never.
-- Kept apart from restaurant_settings so the access screens own it outright.
CREATE TABLE restaurant_access_settings (
  restaurant_id      BIGINT      PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  idle_lock_minutes  SMALLINT    NOT NULL DEFAULT 0
                     CHECK (idle_lock_minutes >= 0 AND idle_lock_minutes <= 240),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         BIGINT      REFERENCES users(id),
  updated_by         BIGINT      REFERENCES users(id)
);

CREATE TRIGGER trg_restaurant_access_settings_updated_at
BEFORE UPDATE ON restaurant_access_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Manager approvals ------------------------------------------------------
-- A cashier without "void a bill" asks; a manager standing there types their
-- PIN; the server issues a one-time token for exactly that cashier, that
-- permission and (when the screen says) that one request. It lives two
-- minutes and is spent by the first action that succeeds with it.
--
-- Only a SHA-256 of the token is stored: the token itself is a random 32-byte
-- secret, so a hash is enough and a database read gives nobody a usable one.
CREATE TABLE approvals (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  permission     VARCHAR(100) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  token_hash     CHAR(64)     NOT NULL UNIQUE,
  requested_by   BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_by    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- "PATCH /bills/42/void": the one request this approval is for, when the
  -- screen named it. NULL approves any one request needing the permission.
  target         VARCHAR(200),
  -- What the cashier's screen said it was for ("Void bill INV-0042") and
  -- anything the manager added.
  label          VARCHAR(200),
  note           VARCHAR(200),
  -- What the manager was shown and said yes to, as facts the request is
  -- checked against: {"billId": 42, "amount": 50}. A refund approved for
  -- Rs 50 cannot then refund Rs 2,400; money may be less, never more (see
  -- authorizeOrApprove's scope option). NULL only where the route binds
  -- nothing yet.
  scope          JSONB,
  expires_at     TIMESTAMPTZ  NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id),
  CHECK (requested_by <> approved_by)
);

-- "How many approvals did Priya give this week" and the housekeeping of
-- expired rows both read by restaurant and time.
CREATE INDEX idx_approvals_restaurant ON approvals (restaurant_id, created_at DESC);
CREATE INDEX idx_approvals_approver ON approvals (approved_by, created_at DESC);

CREATE TRIGGER trg_approvals_updated_at
BEFORE UPDATE ON approvals
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The activity log names the manager who approved an action next to the
-- person who did it, so "who let this void through" has an answer.
ALTER TABLE audit_logs
  ADD COLUMN approved_by    BIGINT       REFERENCES users(id),
  ADD COLUMN approver_name  VARCHAR(150);

-- "Everything Ravi did last week" and "every void this month".
CREATE INDEX idx_audit_logs_user ON audit_logs (restaurant_id, user_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs (restaurant_id, action, created_at DESC);

-- --- Sign-in history -------------------------------------------------------
-- Every sign-in attempt against a known account: password, PIN switch on a
-- shared till, success or not. The owner reads it per user; a lockout shows
-- up as the run of failures that caused it. Attempts against accounts that do
-- not exist are not stored: they belong to no restaurant and are mostly typos.
CREATE TABLE user_sign_ins (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method         VARCHAR(20)  NOT NULL CHECK (method IN ('password', 'pin', 'unlock')),
  outcome        VARCHAR(20)  NOT NULL
                 CHECK (outcome IN ('success', 'wrong_password', 'wrong_pin', 'locked', 'inactive')),
  -- What they typed to identify themselves: email, mobile or employee code.
  identifier     VARCHAR(150),
  ip_address     VARCHAR(64),
  user_agent     VARCHAR(300),
  -- Came from a device this person has signed in on before (see
  -- user_trusted_devices), so the owner can tell their own phone from a
  -- stranger's guesses.
  trusted_device BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_sign_ins_user ON user_sign_ins (user_id, created_at DESC);
CREATE INDEX idx_user_sign_ins_restaurant ON user_sign_ins (restaurant_id, created_at DESC);

-- --- Remembered devices ------------------------------------------------------
-- Five wrong passwords lock an account for fifteen minutes. On its own that
-- also lets anyone who knows the owner's email keep the owner out, again and
-- again. A device (a browser) that has signed in to an account with the right
-- password is remembered for that account: it keeps working through such a
-- lock, with its own count of five wrong passwords, so guesses from anywhere
-- else can neither lock out the owner's phone or the restaurant's till nor
-- use the remembered device to guess faster. The lock still stops every
-- device that has never signed in.
--
-- Only a SHA-256 of the device's random 32-byte token is kept, as for
-- approvals.
CREATE TABLE user_trusted_devices (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT       REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id          BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       CHAR(64)     NOT NULL UNIQUE,
  -- The account's token_version when the device was remembered. Everything
  -- that ends every session (a password change or reset, "sign out
  -- everywhere", switching the account off) bumps that version, and with it
  -- every remembered device is forgotten too; the device the person made the
  -- change from is re-stamped and stays remembered.
  token_version    INTEGER      NOT NULL DEFAULT 0,
  user_agent       VARCHAR(300),
  failed_count     SMALLINT     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  first_failed_at  TIMESTAMPTZ,
  locked_until     TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Remembered for 120 days after it was last used to sign in.
  expires_at       TIMESTAMPTZ  NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Sign-in looks a device up by its hash (the UNIQUE index); housekeeping
-- keeps the newest few per person.
CREATE INDEX idx_user_trusted_devices_user ON user_trusted_devices (user_id, last_used_at DESC);

CREATE TRIGGER trg_user_trusted_devices_updated_at
BEFORE UPDATE ON user_trusted_devices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Payroll: policy, advances and deductions, and what was actually paid ---

-- Salary history. employees.salary_amount is only the salary today; pay for
-- an earlier period must use the salary that applied then. Without this a
-- raise re-priced every earlier month: paid months showed "changed since
-- paid" (and an owner might pay the "difference" again), unpaid ones were
-- worked out at the new rate.
--
-- Each row is "from this date on, this salary". The rate for a day is the
-- latest row on or before it; days before the first row use the first row
-- (the salary someone joined on). A new salary may not start inside a period
-- already marked paid.
CREATE TABLE employee_salary_history (
  id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Part of the employee's own record: an employee can only be deleted when
  -- they have no pay records at all, and then this goes with them.
  employee_id     BIGINT        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_from  DATE          NOT NULL,
  salary_type     VARCHAR(20)   NOT NULL CHECK (salary_type IN ('monthly', 'daily', 'hourly')),
  salary_amount   NUMERIC(12,2) NOT NULL CHECK (salary_amount >= 0),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      BIGINT        REFERENCES users(id),
  updated_by      BIGINT        REFERENCES users(id),
  -- One salary per person per start date; payroll looks up "the latest on or
  -- before this day" through this index.
  UNIQUE (employee_id, effective_from)
);

CREATE INDEX idx_employee_salary_history_restaurant ON employee_salary_history (restaurant_id, employee_id);

CREATE TRIGGER trg_employee_salary_history_updated_at
BEFORE UPDATE ON employee_salary_history
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Everyone's salary today, as the salary they have had since they joined
-- (or since they were added, when no joining date was entered).
INSERT INTO employee_salary_history (restaurant_id, employee_id, effective_from, salary_type, salary_amount)
SELECT e.restaurant_id, e.id, COALESCE(e.date_of_joining, e.created_at::date), e.salary_type, e.salary_amount
FROM employees e;

-- Whether week offs and approved leave are paid, per restaurant. Most Indian
-- restaurants pay a monthly salary for every day of the month, week offs
-- included, and pay approved leave; "absent" is the loss-of-pay day.
CREATE TABLE payroll_settings (
  restaurant_id   BIGINT      PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  week_offs_paid  BOOLEAN     NOT NULL DEFAULT TRUE,
  leave_paid      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      BIGINT      REFERENCES users(id),
  updated_by      BIGINT      REFERENCES users(id)
);

CREATE TRIGGER trg_payroll_settings_updated_at
BEFORE UPDATE ON payroll_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Money that moves outside the attendance maths:
--   advance    cash given mid-month, taken back from that period's pay
--   deduction  a fine, breakage, canteen or uniform charge
--   bonus      an incentive or festival bonus added to that period's pay
-- Each falls into the pay period that contains its date.
CREATE TABLE payroll_adjustments (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id      BIGINT        NOT NULL REFERENCES employees(id),
  adjustment_date  DATE          NOT NULL,
  -- arrears: pay held back from an earlier period, still owed to the person.
  -- Only ever written by "Mark paid" (see carried_from_payment_id below).
  kind             VARCHAR(20)   NOT NULL CHECK (kind IN ('advance', 'deduction', 'bonus', 'arrears')),
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  -- Why: "Diwali advance", "broken glass", "Sept sales incentive".
  note             VARCHAR(200)  NOT NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by       BIGINT        REFERENCES users(id),
  updated_by       BIGINT        REFERENCES users(id)
);

CREATE INDEX idx_payroll_adjustments_period
  ON payroll_adjustments (restaurant_id, adjustment_date, employee_id);
CREATE INDEX idx_payroll_adjustments_employee ON payroll_adjustments (employee_id);

CREATE TRIGGER trg_payroll_adjustments_updated_at
BEFORE UPDATE ON payroll_adjustments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A pay period marked as paid: the figures as they stood when it was paid,
-- so a later attendance correction cannot quietly rewrite what someone was
-- given. Periods for one person never overlap (checked in code under a row
-- lock), so the same days cannot be paid twice.
CREATE TABLE payroll_payments (
  id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id     BIGINT        NOT NULL REFERENCES employees(id),
  period_from     DATE          NOT NULL,
  period_to       DATE          NOT NULL,
  payable_days    NUMERIC(6,2)  NOT NULL DEFAULT 0 CHECK (payable_days >= 0),
  earned          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (earned >= 0),
  bonus           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  advances        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (advances >= 0),
  deductions      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  -- What actually changed hands. Usually the net pay, but the owner may round
  -- it or hold part back; the difference is visible on the record.
  amount_paid     NUMERIC(12,2) NOT NULL CHECK (amount_paid >= 0),
  payment_method  VARCHAR(20)   NOT NULL CHECK (payment_method IN ('cash', 'bank', 'upi', 'cheque')),
  paid_on         DATE          NOT NULL,
  reference       VARCHAR(60),
  note            VARCHAR(200),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      BIGINT        REFERENCES users(id),
  updated_by      BIGINT        REFERENCES users(id),
  CHECK (period_to >= period_from)
);

CREATE INDEX idx_payroll_payments_employee ON payroll_payments (employee_id, period_from);
CREATE INDEX idx_payroll_payments_restaurant ON payroll_payments (restaurant_id, paid_on DESC);

-- A payment that could not settle everything moves the rest into the next
-- pay period instead of losing it: an advance bigger than the pay is still
-- owed by the employee ("advance"), pay held back is still owed to them
-- ("arrears"). The balance points at the payment that carried it, so undoing
-- that payment takes the balance back out with it.
ALTER TABLE payroll_adjustments
  ADD COLUMN carried_from_payment_id BIGINT REFERENCES payroll_payments(id) ON DELETE CASCADE;

CREATE INDEX idx_payroll_adjustments_carried
  ON payroll_adjustments (carried_from_payment_id) WHERE carried_from_payment_id IS NOT NULL;

CREATE TRIGGER trg_payroll_payments_updated_at
BEFORE UPDATE ON payroll_payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS user_trusted_devices;
DROP TABLE IF EXISTS employee_salary_history;
DROP INDEX IF EXISTS idx_payroll_adjustments_carried;
ALTER TABLE IF EXISTS payroll_adjustments DROP COLUMN IF EXISTS carried_from_payment_id;
DROP TABLE IF EXISTS payroll_payments;
DROP TABLE IF EXISTS payroll_adjustments;
DROP TABLE IF EXISTS payroll_settings;
DROP TABLE IF EXISTS user_sign_ins;

DROP INDEX IF EXISTS idx_audit_logs_action;
DROP INDEX IF EXISTS idx_audit_logs_user;
ALTER TABLE audit_logs
  DROP COLUMN IF EXISTS approver_name,
  DROP COLUMN IF EXISTS approved_by;

DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS restaurant_access_settings;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS chk_users_pin_set,
  DROP COLUMN IF EXISTS pin_locked_until,
  DROP COLUMN IF EXISTS pin_first_failed_at,
  DROP COLUMN IF EXISTS pin_failed_count,
  DROP COLUMN IF EXISTS pin_set_at,
  DROP COLUMN IF EXISTS pin_hash,
  DROP COLUMN IF EXISTS login_locked_until,
  DROP COLUMN IF EXISTS first_failed_login_at,
  DROP COLUMN IF EXISTS failed_login_count,
  DROP COLUMN IF EXISTS token_version;

-- Logins created without an email get a placeholder that can never receive
-- mail, so the column can be required again.
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_can_sign_in;
UPDATE users SET email = 'user' || id || '@no-email.invalid' WHERE email IS NULL;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

-- Back to one login per number across the platform: where two restaurants
-- share a number, the older login keeps it (every login has an email again
-- by now, so nobody is left without a way to sign in).
DROP INDEX IF EXISTS uq_users_restaurant_mobile;
UPDATE users u SET mobile = NULL
WHERE u.mobile IS NOT NULL
  AND EXISTS (SELECT 1 FROM users o WHERE o.mobile = u.mobile AND o.id < u.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_mobile ON users (mobile) WHERE mobile IS NOT NULL;

UPDATE permissions SET name = 'Open and close the business day' WHERE code = 'business_day.manage';
UPDATE permissions SET name = 'Record payments and refunds' WHERE code = 'payments.manage';

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions
  WHERE code IN ('orders.cancel_after_kot', 'bills.void', 'bills.refund', 'bills.reprint',
                 'bills.discount', 'bills.complimentary', 'business_day.close', 'sales.view',
                 'staff.salaries', 'menu.availability', 'loyalty.adjust', 'audit.view',
                 'customers.credit')
);

DELETE FROM permissions
WHERE code IN ('orders.cancel_after_kot', 'bills.void', 'bills.refund', 'bills.reprint',
               'bills.discount', 'bills.complimentary', 'business_day.close', 'sales.view',
               'staff.salaries', 'menu.availability', 'loyalty.adjust', 'audit.view',
               'customers.credit');
