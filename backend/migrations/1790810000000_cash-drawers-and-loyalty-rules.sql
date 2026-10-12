-- Up Migration

-- ===========================================================================
-- Cash and loyalty: counting the drawer at close, cash drawers per shift,
-- cash taken in or out of a drawer, and the loyalty programme's own rules.
-- ===========================================================================

-- --- The rules the owner sets ---------------------------------------------
-- day_cutoff_hour: a business day is opened for today's date. Until this hour
--   of the morning (restaurant's own clock) yesterday's date may still be
--   opened, for a night that trades past midnight. Any other date was a
--   typing slip or worse (a "2027" day, or one back-dated four months).
-- cash_variance_threshold: a drawer counted more than this over or short
--   cannot be closed without saying why; the reason goes on the day and in
--   the activity log.
-- cash_blind_count: the cashier counts without being shown what the drawer
--   should hold, so a count cannot be "made to match". Whoever may close the
--   day (business_day.close) still sees it.
ALTER TABLE restaurant_settings
  ADD COLUMN day_cutoff_hour SMALLINT NOT NULL DEFAULT 5
    CHECK (day_cutoff_hour BETWEEN 0 AND 12),
  ADD COLUMN cash_variance_threshold NUMERIC(12,2) NOT NULL DEFAULT 100
    CHECK (cash_variance_threshold >= 0 AND cash_variance_threshold <= 100000),
  ADD COLUMN cash_blind_count BOOLEAN NOT NULL DEFAULT FALSE;

-- Loyalty rules beyond earn rate, point value and minimum to redeem:
-- loyalty_earn_basis: points on the bill total the guest pays ('total', as
--   before) or on the food after discounts, before GST and service charge
--   ('pre_tax'): GST is the government's money, not the guest's spend here.
-- loyalty_max_redeem_points / _percent: the most points one bill may use, as
--   a number and as a share of the bill (an 800-point guest no longer eats an
--   855 rupee dinner for 55 rupees). Empty: no limit.
-- loyalty_expiry_days: points unused this many days after they were earned
--   expire, oldest-expiring used first. Empty: points never expire.
ALTER TABLE restaurant_settings
  ADD COLUMN loyalty_earn_basis VARCHAR(10) NOT NULL DEFAULT 'total'
    CHECK (loyalty_earn_basis IN ('total', 'pre_tax')),
  ADD COLUMN loyalty_max_redeem_points INTEGER
    CHECK (loyalty_max_redeem_points BETWEEN 1 AND 1000000),
  ADD COLUMN loyalty_max_redeem_percent NUMERIC(5,2)
    CHECK (loyalty_max_redeem_percent > 0 AND loyalty_max_redeem_percent <= 100),
  ADD COLUMN loyalty_expiry_days INTEGER
    CHECK (loyalty_expiry_days BETWEEN 1 AND 3650);

-- --- When points run out ------------------------------------------------------
-- Each credit of points (earned on a bill, given by hand, handed back) carries
-- the last day it can be used. Written when the points are given, from the
-- rule in force then; NULL means the points do not expire.
ALTER TABLE loyalty_transactions ADD COLUMN expires_on DATE;

-- The sweep that expires points looks for credits past their date.
CREATE INDEX idx_loyalty_expiring ON loyalty_transactions (restaurant_id, expires_on)
  WHERE expires_on IS NOT NULL AND points > 0;

-- --- The count at close ---------------------------------------------------------
-- What closing the day used to keep was one figure (closing_cash). A cash-up
-- also needs: what was physically counted and how (note by note, or a total),
-- what the drawer should have held, the difference and why, and whether the
-- card machine and the UPI app agreed with the till.
--
-- closing_cash stays the figure every report compares with the drawer's
-- expected cash (report.repository DRAWER_EXPECTED): the cash the day
-- accounts for, i.e. the counted drawer plus what was dropped to the safe
-- during the day, less what was put into the drawer from the safe (a float
-- top-up). With no drops or top-ups it is simply the count. counted_cash is
-- the figure in the drawer itself.
ALTER TABLE business_days
  ADD COLUMN counted_cash NUMERIC(12,2),
  ADD COLUMN count_method VARCHAR(10) CHECK (count_method IN ('notes', 'total')),
  ADD COLUMN count_denominations JSONB,
  ADD COLUMN blind_count BOOLEAN NOT NULL DEFAULT FALSE,
  -- The first figure typed, kept when a count was changed after the
  -- difference was shown (a blind count changed to match is visible).
  ADD COLUMN first_count NUMERIC(12,2),
  ADD COLUMN expected_cash NUMERIC(12,2),
  ADD COLUMN cash_dropped NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN cash_paid_in NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN cash_variance NUMERIC(12,2),
  ADD COLUMN variance_reason VARCHAR(300),
  -- [{ method, system, reported, matched, note }]: card and UPI totals the
  -- closer ticked against the machine's settlement and the bank app.
  ADD COLUMN method_checks JSONB,
  ADD COLUMN reopened_count INTEGER NOT NULL DEFAULT 0;

-- --- Cash drawers per shift -------------------------------------------------------
-- One cashier's stint at the till within a business day: the float they
-- started with, the money they took (payments they recorded while it was
-- open), the cash taken in or out of it, and their count at the end. Two
-- cashiers at two tills each have their own; a morning and an evening
-- cashier at one till hand over between two. The business day's own count
-- stays the restaurant's final word on the day's cash.
CREATE TABLE cash_drawers (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  business_day_id  BIGINT        NOT NULL REFERENCES business_days(id) ON DELETE CASCADE,
  outlet_id        BIGINT        REFERENCES outlets(id) ON DELETE SET NULL,
  -- The person answerable for the cash in it.
  cashier_id       BIGINT        NOT NULL REFERENCES users(id),
  label            VARCHAR(60),
  drawer_status    VARCHAR(10)   NOT NULL DEFAULT 'open' CHECK (drawer_status IN ('open', 'closed')),
  opening_float    NUMERIC(12,2) NOT NULL CHECK (opening_float >= 0 AND opening_float <= 99999999),
  opened_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  opened_by        BIGINT        REFERENCES users(id),
  closed_at        TIMESTAMPTZ,
  closed_by        BIGINT        REFERENCES users(id),
  counted_cash     NUMERIC(12,2),
  count_method     VARCHAR(10)   CHECK (count_method IN ('notes', 'total')),
  count_denominations JSONB,
  blind_count      BOOLEAN       NOT NULL DEFAULT FALSE,
  first_count      NUMERIC(12,2),
  expected_cash    NUMERIC(12,2),
  cash_variance    NUMERIC(12,2),
  variance_reason  VARCHAR(300),
  notes            VARCHAR(500),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by       BIGINT        REFERENCES users(id),
  updated_by       BIGINT        REFERENCES users(id),
  CHECK (drawer_status = 'open' OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL))
);

-- A cashier has one drawer open at a time in a day.
CREATE UNIQUE INDEX uq_cash_drawers_one_open ON cash_drawers (business_day_id, cashier_id)
  WHERE drawer_status = 'open';
CREATE INDEX idx_cash_drawers_day ON cash_drawers (restaurant_id, business_day_id);

CREATE TRIGGER trg_cash_drawers_updated_at
BEFORE UPDATE ON cash_drawers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Cash in and out of a drawer ------------------------------------------------
-- paid_in     change brought to the drawer from the safe (a float top-up)
-- petty_cash  cash paid out for the restaurant (ice, an auto, a plumber); it
--             is also an approved cash expense of the day (expense_id), so
--             the expense reports and the drawer agree without being told
-- drop        surplus cash taken from the drawer to the safe mid-shift
-- Each belongs to a business day (and so a drawer of the day) and, when a
-- cashier's shift is open, to that shift's drawer. A movement typed wrong is
-- cancelled with a reason, never deleted.
CREATE TABLE cash_movements (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  business_day_id  BIGINT        NOT NULL REFERENCES business_days(id) ON DELETE CASCADE,
  outlet_id        BIGINT        REFERENCES outlets(id) ON DELETE SET NULL,
  drawer_id        BIGINT        REFERENCES cash_drawers(id) ON DELETE SET NULL,
  movement_type    VARCHAR(12)   NOT NULL CHECK (movement_type IN ('paid_in', 'petty_cash', 'drop')),
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 99999999),
  reason           VARCHAR(300)  NOT NULL,
  expense_id       BIGINT        REFERENCES expenses(id),
  movement_status  VARCHAR(10)   NOT NULL DEFAULT 'recorded' CHECK (movement_status IN ('recorded', 'cancelled')),
  cancelled_at     TIMESTAMPTZ,
  cancelled_by     BIGINT        REFERENCES users(id),
  cancel_reason    VARCHAR(300),
  -- The manager whose PIN allowed it, when the person recording it could not.
  approved_by      BIGINT        REFERENCES users(id),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by       BIGINT        REFERENCES users(id),
  updated_by       BIGINT        REFERENCES users(id),
  CHECK (movement_type <> 'petty_cash' OR expense_id IS NOT NULL),
  CHECK (movement_status = 'recorded' OR cancelled_at IS NOT NULL)
);

CREATE INDEX idx_cash_movements_day ON cash_movements (restaurant_id, business_day_id);
CREATE INDEX idx_cash_movements_drawer ON cash_movements (drawer_id) WHERE drawer_id IS NOT NULL;

CREATE TRIGGER trg_cash_movements_updated_at
BEFORE UPDATE ON cash_movements
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Who may move cash ------------------------------------------------------------
-- Taking cash out of the drawer (a drop, petty cash) is how a drawer is made
-- to look right, so it is a manager's permission. A cashier records one with
-- a manager's PIN, tied to the day and the amount.
INSERT INTO permissions (code, module, name) VALUES
  ('cash.movements', 'operations', 'Take cash in or out of the drawer (float top-up, petty cash, cash drop)');

-- Owners and managers get it, and so does any restaurant's own role that may
-- close the day: whoever signs the count may move the cash it counts.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'cash.movements'
WHERE (r.restaurant_id IS NULL AND r.is_system = TRUE AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER'))
   OR (r.restaurant_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM role_permissions x JOIN permissions xp ON xp.id = x.permission_id
        WHERE x.role_id = r.id AND xp.code = 'business_day.close'))
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'cash.movements');
DELETE FROM permissions WHERE code = 'cash.movements';

DROP TABLE IF EXISTS cash_movements;
DROP TABLE IF EXISTS cash_drawers;

ALTER TABLE business_days
  DROP COLUMN IF EXISTS reopened_count,
  DROP COLUMN IF EXISTS method_checks,
  DROP COLUMN IF EXISTS variance_reason,
  DROP COLUMN IF EXISTS cash_variance,
  DROP COLUMN IF EXISTS cash_paid_in,
  DROP COLUMN IF EXISTS cash_dropped,
  DROP COLUMN IF EXISTS expected_cash,
  DROP COLUMN IF EXISTS first_count,
  DROP COLUMN IF EXISTS blind_count,
  DROP COLUMN IF EXISTS count_denominations,
  DROP COLUMN IF EXISTS count_method,
  DROP COLUMN IF EXISTS counted_cash;

DROP INDEX IF EXISTS idx_loyalty_expiring;
ALTER TABLE loyalty_transactions DROP COLUMN IF EXISTS expires_on;

ALTER TABLE restaurant_settings
  DROP COLUMN IF EXISTS loyalty_expiry_days,
  DROP COLUMN IF EXISTS loyalty_max_redeem_percent,
  DROP COLUMN IF EXISTS loyalty_max_redeem_points,
  DROP COLUMN IF EXISTS loyalty_earn_basis,
  DROP COLUMN IF EXISTS cash_blind_count,
  DROP COLUMN IF EXISTS cash_variance_threshold,
  DROP COLUMN IF EXISTS day_cutoff_hour;
