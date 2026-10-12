-- Up Migration

-- ===========================================================================
-- Payroll completeness: tips shared out to staff, leave allowances, and the
-- statutory deductions (PF, ESI, professional tax).
-- ===========================================================================

-- --- Tips --------------------------------------------------------------------

-- A tip given with a payment, on top of what the payment puts toward the bill
-- (`amount`). A Rs 1,000 card swipe on a Rs 900 bill is amount 900 + tip 100,
-- so the card machine's total matches the day-end. A tip is never part of the
-- bill: not sales, not GST, not the discount base, not loyalty points. The
-- tip box at payment is the billing screen's; this column and everything that
-- shares tips out to staff is here.
ALTER TABLE payments
  ADD COLUMN tip_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tip_amount >= 0);

-- Finding the tips of a period that are still to be shared reads only the
-- payments that carry one.
CREATE INDEX idx_payments_tips ON payments (restaurant_id, paid_at) WHERE tip_amount > 0;

-- How a restaurant shares its tips:
--   routing      'pool': every tip goes into the day's pool;
--                'captain': a tip goes to the captain who took the order
--                (the login that opened it, when it is linked to an
--                employee), and only the rest goes into the pool.
--   include_service_charge  the service charge collected is shared too.
--   share_basis  'hours' (from attendance) or 'points' per designation,
--                times the days worked.
CREATE TABLE tip_settings (
  restaurant_id           BIGINT        PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  routing                 VARCHAR(10)   NOT NULL DEFAULT 'pool' CHECK (routing IN ('pool', 'captain')),
  include_service_charge  BOOLEAN       NOT NULL DEFAULT FALSE,
  share_basis             VARCHAR(10)   NOT NULL DEFAULT 'hours' CHECK (share_basis IN ('hours', 'points')),
  -- {"Captain": 3, "Steward": 2, "Helper": 1}. A designation not listed gets
  -- default_points; 0 leaves that designation out of the pool.
  designation_points      JSONB         NOT NULL DEFAULT '{}'::jsonb,
  default_points          NUMERIC(6,2)  NOT NULL DEFAULT 1 CHECK (default_points >= 0 AND default_points <= 100),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by              BIGINT        REFERENCES users(id),
  updated_by              BIGINT        REFERENCES users(id)
);

CREATE TRIGGER trg_tip_settings_updated_at
BEFORE UPDATE ON tip_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One share-out: the tips (and, when set, the service charge) of a period,
-- split between the people who worked it. The figures are kept as they were
-- confirmed. Every share lands in the pay period holding pay_date, as a
-- separate "Tips" line on the payslip.
CREATE TABLE tip_shareouts (
  id                    BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id         BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  period_from           DATE          NOT NULL,
  period_to             DATE          NOT NULL,
  pay_date              DATE          NOT NULL,
  basis                 VARCHAR(10)   NOT NULL CHECK (basis IN ('hours', 'points')),
  routing               VARCHAR(10)   NOT NULL CHECK (routing IN ('pool', 'captain')),
  tips_total            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tips_total >= 0),
  service_charge_total  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (service_charge_total >= 0),
  -- Given straight to the captain who took the order.
  direct_total          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (direct_total >= 0),
  -- Shared by hours or points.
  pool_total            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pool_total >= 0),
  note                  VARCHAR(200),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by            BIGINT        REFERENCES users(id),
  updated_by            BIGINT        REFERENCES users(id),
  CHECK (period_to >= period_from),
  -- Everything collected is given out, to the paisa.
  CHECK (tips_total + service_charge_total = direct_total + pool_total)
);

CREATE INDEX idx_tip_shareouts_restaurant ON tip_shareouts (restaurant_id, period_to DESC);

CREATE TRIGGER trg_tip_shareouts_updated_at
BEFORE UPDATE ON tip_shareouts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Each person's part of a share-out.
CREATE TABLE tip_shares (
  id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  shareout_id     BIGINT        NOT NULL REFERENCES tip_shareouts(id) ON DELETE CASCADE,
  employee_id     BIGINT        NOT NULL REFERENCES employees(id),
  -- 'pool': their share of the pool; 'direct': tips on orders they took.
  kind            VARCHAR(10)   NOT NULL CHECK (kind IN ('pool', 'direct')),
  share_date      DATE          NOT NULL,
  worked_minutes  INTEGER       NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  days_worked     NUMERIC(6,1)  NOT NULL DEFAULT 0 CHECK (days_worked >= 0),
  points          NUMERIC(6,2)  NOT NULL DEFAULT 0 CHECK (points >= 0),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (shareout_id, employee_id, kind)
);

-- Payroll reads one person's tips for a pay period.
CREATE INDEX idx_tip_shares_period ON tip_shares (restaurant_id, share_date, employee_id);
CREATE INDEX idx_tip_shares_employee ON tip_shares (employee_id);

-- The tips each share-out took. A payment's tip can be in one share-out only
-- (the UNIQUE), so the same tips can never be shared twice, even by two
-- managers confirming at the same moment. Undoing a share-out deletes these
-- rows and the tips are free to be shared again.
CREATE TABLE tip_shareout_payments (
  shareout_id    BIGINT        NOT NULL REFERENCES tip_shareouts(id) ON DELETE CASCADE,
  payment_id     BIGINT        NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  tip_amount     NUMERIC(12,2) NOT NULL CHECK (tip_amount > 0),
  -- The captain it went to directly; NULL when it went into the pool.
  employee_id    BIGINT        REFERENCES employees(id),
  PRIMARY KEY (shareout_id, payment_id)
);

-- The same for the service charge of each bill, when it is shared.
CREATE TABLE tip_shareout_bills (
  shareout_id     BIGINT        NOT NULL REFERENCES tip_shareouts(id) ON DELETE CASCADE,
  bill_id         BIGINT        NOT NULL UNIQUE REFERENCES bills(id) ON DELETE CASCADE,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  service_charge  NUMERIC(12,2) NOT NULL CHECK (service_charge > 0),
  PRIMARY KEY (shareout_id, bill_id)
);

-- --- Leave allowances --------------------------------------------------------

-- Leave types the owner sets: Casual 1 day a month, Sick 6 days a year,
-- Unpaid. Leave inside the allowance is paid; days over it, and Unpaid leave,
-- are loss of pay. With no leave types at all, the older all-or-nothing
-- "leave is paid" setting still applies, so nothing changes for a restaurant
-- until its owner sets them up.
--
-- counts_from: allowances build up from this month (or year); a carried-
-- forward balance does not reach back to before the type existed.
-- is_default: the type a leave day marked without one counts against.
CREATE TABLE leave_types (
  id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name              VARCHAR(40)   NOT NULL,
  paid              BOOLEAN       NOT NULL DEFAULT TRUE,
  allowance_days    NUMERIC(5,1)  CHECK (allowance_days IS NULL OR (allowance_days >= 0 AND allowance_days <= 366)),
  allowance_period  VARCHAR(10)   NOT NULL DEFAULT 'month' CHECK (allowance_period IN ('month', 'year')),
  carry_forward     BOOLEAN       NOT NULL DEFAULT FALSE,
  counts_from       DATE          NOT NULL DEFAULT CURRENT_DATE,
  is_default        BOOLEAN       NOT NULL DEFAULT FALSE,
  status            VARCHAR(20)   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order        SMALLINT      NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by        BIGINT        REFERENCES users(id),
  updated_by        BIGINT        REFERENCES users(id),
  -- A paid type has an allowance; an unpaid one has none to count.
  CONSTRAINT chk_leave_type_allowance CHECK (
    (paid AND allowance_days IS NOT NULL) OR (NOT paid AND allowance_days IS NULL AND NOT carry_forward)
  )
);

CREATE UNIQUE INDEX uq_leave_types_name ON leave_types (restaurant_id, LOWER(name));
CREATE UNIQUE INDEX uq_leave_types_default ON leave_types (restaurant_id) WHERE is_default;

CREATE TRIGGER trg_leave_types_updated_at
BEFORE UPDATE ON leave_types
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which leave a leave day is. Read only when the day's status is 'leave'.
ALTER TABLE attendance ADD COLUMN leave_type_id BIGINT REFERENCES leave_types(id);
ALTER TABLE shift_assignments ADD COLUMN leave_type_id BIGINT REFERENCES leave_types(id);

-- --- PF, ESI and professional tax --------------------------------------------

-- Off until the owner switches each one on; then the starting values are the
-- rules in force: PF 12% + 12% on basic wages up to Rs 15,000 a month; ESI
-- 0.75% + 3.25% when gross pay is Rs 21,000 a month or less; professional tax
-- by the slab table of the restaurant's state (owner-editable, because
-- states revise them).
CREATE TABLE statutory_settings (
  restaurant_id      BIGINT        PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  pf_enabled         BOOLEAN       NOT NULL DEFAULT FALSE,
  pf_employee_rate   NUMERIC(5,2)  NOT NULL DEFAULT 12 CHECK (pf_employee_rate >= 0 AND pf_employee_rate <= 100),
  pf_employer_rate   NUMERIC(5,2)  NOT NULL DEFAULT 12 CHECK (pf_employer_rate >= 0 AND pf_employer_rate <= 100),
  pf_wage_ceiling    NUMERIC(12,2) NOT NULL DEFAULT 15000 CHECK (pf_wage_ceiling > 0),
  esi_enabled        BOOLEAN       NOT NULL DEFAULT FALSE,
  esi_employee_rate  NUMERIC(5,2)  NOT NULL DEFAULT 0.75 CHECK (esi_employee_rate >= 0 AND esi_employee_rate <= 100),
  esi_employer_rate  NUMERIC(5,2)  NOT NULL DEFAULT 3.25 CHECK (esi_employer_rate >= 0 AND esi_employer_rate <= 100),
  esi_wage_limit     NUMERIC(12,2) NOT NULL DEFAULT 21000 CHECK (esi_wage_limit > 0),
  pt_enabled         BOOLEAN       NOT NULL DEFAULT FALSE,
  pt_state           VARCHAR(40),
  -- [{"over": 7500, "amount": 175}, {"over": 10000, "amount": 200, "februaryAmount": 300}]:
  -- gross pay for the month above `over` pays `amount` (February's own amount
  -- where a state asks for one). Below the lowest slab, nothing.
  pt_slabs           JSONB         NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by         BIGINT        REFERENCES users(id),
  updated_by         BIGINT        REFERENCES users(id)
);

CREATE TRIGGER trg_statutory_settings_updated_at
BEFORE UPDATE ON statutory_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per person: who is covered, their numbers, and how much of their salary is
-- basic wages (PF is worked out on basic wages; under the Code on Wages at
-- least half of pay counts as wages, so 50% is the lowest share).
ALTER TABLE employees
  ADD COLUMN pf_applicable   BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN esi_applicable  BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN pt_applicable   BOOLEAN       NOT NULL DEFAULT TRUE,
  ADD COLUMN uan             VARCHAR(12)   CHECK (uan IS NULL OR uan ~ '^[0-9]{12}$'),
  ADD COLUMN esi_number      VARCHAR(17)   CHECK (esi_number IS NULL OR esi_number ~ '^[0-9]{10,17}$'),
  ADD COLUMN basic_percent   NUMERIC(5,2)  NOT NULL DEFAULT 100 CHECK (basic_percent >= 50 AND basic_percent <= 100);

-- A paid period keeps every line as it was paid: tips, the leave split and
-- each statutory deduction (and the employer's part, which is not taken from
-- the person but is owed to the PF and ESI offices).
ALTER TABLE payroll_payments
  ADD COLUMN tips               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tips >= 0),
  ADD COLUMN paid_leave_days    NUMERIC(6,1)  NOT NULL DEFAULT 0 CHECK (paid_leave_days >= 0),
  ADD COLUMN unpaid_leave_days  NUMERIC(6,1)  NOT NULL DEFAULT 0 CHECK (unpaid_leave_days >= 0),
  ADD COLUMN pf_wages           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pf_wages >= 0),
  ADD COLUMN pf_employee        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pf_employee >= 0),
  ADD COLUMN pf_employer        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pf_employer >= 0),
  ADD COLUMN esi_wages          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (esi_wages >= 0),
  ADD COLUMN esi_employee       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (esi_employee >= 0),
  ADD COLUMN esi_employer       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (esi_employer >= 0),
  ADD COLUMN professional_tax   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (professional_tax >= 0);

-- Down Migration

ALTER TABLE payroll_payments
  DROP COLUMN IF EXISTS professional_tax,
  DROP COLUMN IF EXISTS esi_employer,
  DROP COLUMN IF EXISTS esi_employee,
  DROP COLUMN IF EXISTS esi_wages,
  DROP COLUMN IF EXISTS pf_employer,
  DROP COLUMN IF EXISTS pf_employee,
  DROP COLUMN IF EXISTS pf_wages,
  DROP COLUMN IF EXISTS unpaid_leave_days,
  DROP COLUMN IF EXISTS paid_leave_days,
  DROP COLUMN IF EXISTS tips;

ALTER TABLE employees
  DROP COLUMN IF EXISTS basic_percent,
  DROP COLUMN IF EXISTS esi_number,
  DROP COLUMN IF EXISTS uan,
  DROP COLUMN IF EXISTS pt_applicable,
  DROP COLUMN IF EXISTS esi_applicable,
  DROP COLUMN IF EXISTS pf_applicable;

DROP TABLE IF EXISTS statutory_settings;

ALTER TABLE shift_assignments DROP COLUMN IF EXISTS leave_type_id;
ALTER TABLE attendance DROP COLUMN IF EXISTS leave_type_id;
DROP TABLE IF EXISTS leave_types;

DROP TABLE IF EXISTS tip_shareout_bills;
DROP TABLE IF EXISTS tip_shareout_payments;
DROP TABLE IF EXISTS tip_shares;
DROP TABLE IF EXISTS tip_shareouts;
DROP TABLE IF EXISTS tip_settings;

DROP INDEX IF EXISTS idx_payments_tips;
ALTER TABLE payments DROP COLUMN IF EXISTS tip_amount;
