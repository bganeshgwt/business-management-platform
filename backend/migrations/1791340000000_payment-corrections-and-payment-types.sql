-- Up Migration

-- Billing and payments build (sweep SW-B-02, SW-B-18).
--
-- 1. Correcting the way a payment was taken. "Sir, I paid by GPay" is a daily
--    till correction: the cashier keyed a UPI payment as cash, so the drawer
--    reads short and the UPI total does not match the bank at close. The only
--    way out used to be a refund (a credit note that lowers GST and sales) or
--    a void (theft control). A correction changes the method (and reference)
--    of one payment while its business day is still open, and nothing else:
--    the bill, its GST, the sales and the points stay exactly as they were.
--    Every correction is kept here, with who made it, who approved it and
--    why, so the activity log and theft control can list them.
--
-- 2. Owner-named payment types under a method: Pluxee and Sodexo meal cards
--    or a cheque under Other, PhonePe under UPI, an Amex machine under Card.
--    The method still decides where the money goes (cash in the drawer, the
--    rest at the bank); the type says exactly what it was, so a meal-card
--    company's monthly settlement can be totalled.

CREATE TABLE payment_types (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- The method it sits under; the method is what the drawer and the bank see.
  payment_method  VARCHAR(20) NOT NULL
                  CHECK (payment_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other')),
  name            VARCHAR(60) NOT NULL CHECK (BTRIM(name) <> ''),
  -- A cheque number, a meal-card slip: the till asks for it before saving.
  needs_reference BOOLEAN NOT NULL DEFAULT FALSE,
  -- Switched off, it is no longer offered at the till; the payments already
  -- taken with it keep its name.
  status          VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      BIGINT REFERENCES users(id),
  updated_by      BIGINT REFERENCES users(id)
);

-- One "Pluxee" under Other per restaurant; the same name may sit under two
-- methods (a "Zomato Pay" card swipe and a "Zomato Pay" UPI).
CREATE UNIQUE INDEX uq_payment_types_name ON payment_types (restaurant_id, payment_method, UPPER(BTRIM(name)));
CREATE INDEX idx_payment_types_restaurant ON payment_types (restaurant_id, status);

CREATE TRIGGER trg_payment_types_updated_at
BEFORE UPDATE ON payment_types
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A payment or a refund may name its type. ON DELETE RESTRICT: a type that
-- was used is switched off, never deleted, so history keeps its name.
ALTER TABLE payments
  ADD COLUMN payment_type_id BIGINT REFERENCES payment_types(id) ON DELETE RESTRICT;
ALTER TABLE refunds
  ADD COLUMN payment_type_id BIGINT REFERENCES payment_types(id) ON DELETE RESTRICT;

CREATE INDEX idx_payments_type ON payments (payment_type_id) WHERE payment_type_id IS NOT NULL;

CREATE TABLE payment_corrections (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id             BIGINT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  payment_id          BIGINT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  -- The payment's own day: a correction is only ever made while it is open.
  business_day_id     BIGINT REFERENCES business_days(id) ON DELETE SET NULL,
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  old_method          VARCHAR(20) NOT NULL,
  new_method          VARCHAR(20) NOT NULL,
  old_payment_type_id BIGINT REFERENCES payment_types(id) ON DELETE SET NULL,
  new_payment_type_id BIGINT REFERENCES payment_types(id) ON DELETE SET NULL,
  old_reference       VARCHAR(100),
  new_reference       VARCHAR(100),
  reason              VARCHAR(200) NOT NULL CHECK (BTRIM(reason) <> ''),
  corrected_by        BIGINT REFERENCES users(id),
  -- The manager whose PIN allowed it, when the cashier did not hold the right.
  approved_by         BIGINT REFERENCES users(id),
  corrected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (old_method <> new_method
         OR old_payment_type_id IS DISTINCT FROM new_payment_type_id
         OR old_reference IS DISTINCT FROM new_reference)
);

CREATE INDEX idx_payment_corrections_bill ON payment_corrections (bill_id);
-- Theft control and the activity screens read a period at a time.
CREATE INDEX idx_payment_corrections_period ON payment_corrections (restaurant_id, corrected_at DESC);

INSERT INTO permissions (code, module, name) VALUES
  ('bills.payment_correct', 'billing', 'Correct how a payment was taken (cash, card, UPI) on an open day');

-- Owners and managers; a cashier asks a manager for the PIN at the till.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'bills.payment_correct'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'bills.payment_correct');
DELETE FROM permissions WHERE code = 'bills.payment_correct';

DROP TABLE IF EXISTS payment_corrections;
DROP INDEX IF EXISTS idx_payments_type;
ALTER TABLE refunds DROP COLUMN IF EXISTS payment_type_id;
ALTER TABLE payments DROP COLUMN IF EXISTS payment_type_id;
DROP TABLE IF EXISTS payment_types;
