-- Up Migration

-- Advances and deposits (sweep SW-B-04).
--
-- "Take ₹5,000 now for Saturday's birthday party" — a booking deposit, a
-- bulk order paid half up front, a company that pays for the month ahead.
-- The money is received today (into today's drawer when it is cash), held
-- for the guest, and used on the final bill later. It is not a sale when it
-- is received: it becomes one only on the bill it is used on, so sales and
-- GST count it once, on the bill. An advance not used can be handed back,
-- with a reason and a manager's say-so.
--
-- Each advance prints a receipt with its own number series (ADV-0001…),
-- kept in document_counters like bills and credit notes.

CREATE TABLE customer_advances (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- The till that took the money: an outlet's, or the main counter (NULL).
  outlet_id        BIGINT REFERENCES outlets(id) ON DELETE SET NULL,
  -- The business day the money went into.
  business_day_id  BIGINT REFERENCES business_days(id) ON DELETE SET NULL,
  customer_id      BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  receipt_number   VARCHAR(30) NOT NULL,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  -- Used on bills so far, and handed back so far. What is left is held.
  used_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (used_amount >= 0),
  refunded_amount  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  payment_method   VARCHAR(20) NOT NULL
                   CHECK (payment_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other')),
  payment_type_id  BIGINT REFERENCES payment_types(id) ON DELETE RESTRICT,
  transaction_ref  VARCHAR(100),
  -- What it is for: "Birthday party, Sat 12 Oct, 40 guests".
  purpose          VARCHAR(200),
  -- The booking it is for, when there is one.
  reservation_id   BIGINT REFERENCES reservations(id) ON DELETE SET NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (used_amount + refunded_amount <= amount)
);

CREATE UNIQUE INDEX uq_customer_advances_number ON customer_advances (restaurant_id, receipt_number);
CREATE INDEX idx_customer_advances_customer ON customer_advances (restaurant_id, customer_id);
CREATE INDEX idx_customer_advances_day ON customer_advances (restaurant_id, business_day_id);
-- Advances still holding money, for the till's "Pay from advance".
CREATE INDEX idx_customer_advances_open ON customer_advances (restaurant_id, customer_id)
  WHERE used_amount + refunded_amount < amount;

CREATE TRIGGER trg_customer_advances_updated_at
BEFORE UPDATE ON customer_advances
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An unused advance handed back to the guest.
CREATE TABLE customer_advance_refunds (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  advance_id       BIGINT NOT NULL REFERENCES customer_advances(id) ON DELETE CASCADE,
  -- The day the money left (out of that day's drawer when it is cash).
  business_day_id  BIGINT REFERENCES business_days(id) ON DELETE SET NULL,
  outlet_id        BIGINT REFERENCES outlets(id) ON DELETE SET NULL,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  refund_method    VARCHAR(20) NOT NULL
                   CHECK (refund_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other')),
  payment_type_id  BIGINT REFERENCES payment_types(id) ON DELETE RESTRICT,
  transaction_ref  VARCHAR(100),
  reason           VARCHAR(200) NOT NULL CHECK (BTRIM(reason) <> ''),
  created_by       BIGINT REFERENCES users(id),
  approved_by      BIGINT REFERENCES users(id),
  refunded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customer_advance_refunds_advance ON customer_advance_refunds (advance_id);
CREATE INDEX idx_customer_advance_refunds_day ON customer_advance_refunds (restaurant_id, business_day_id);

-- Using an advance on a bill is a payment of its own kind: "advance", naming
-- the advance it came from. It brings no new money into the drawer (that came
-- in when the advance was taken), so every cash figure leaves it out by its
-- method; it does settle the bill like any payment.
ALTER TABLE payments DROP CONSTRAINT payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
  CHECK (payment_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other', 'advance'));
ALTER TABLE payments
  ADD COLUMN advance_id BIGINT REFERENCES customer_advances(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_payments_advance CHECK ((payment_method = 'advance') = (advance_id IS NOT NULL));

CREATE INDEX idx_payments_advance ON payments (advance_id) WHERE advance_id IS NOT NULL;

-- Money given back on a bill that was paid from an advance can go back onto
-- that advance instead of out of the drawer.
ALTER TABLE refunds DROP CONSTRAINT refunds_refund_method_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_refund_method_check
  CHECK (refund_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other', 'advance'));
ALTER TABLE refunds
  ADD COLUMN advance_id BIGINT REFERENCES customer_advances(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_refunds_advance CHECK ((refund_method = 'advance') = (advance_id IS NOT NULL));

INSERT INTO permissions (code, module, name) VALUES
  ('advances.refund', 'payments', 'Hand back an unused advance or deposit');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'advances.refund'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'advances.refund');
DELETE FROM permissions WHERE code = 'advances.refund';

ALTER TABLE refunds DROP CONSTRAINT IF EXISTS chk_refunds_advance;
ALTER TABLE refunds DROP COLUMN IF EXISTS advance_id;
DELETE FROM refunds WHERE refund_method = 'advance';
ALTER TABLE refunds DROP CONSTRAINT refunds_refund_method_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_refund_method_check
  CHECK (refund_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other'));

DROP INDEX IF EXISTS idx_payments_advance;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payments_advance;
ALTER TABLE payments DROP COLUMN IF EXISTS advance_id;
DELETE FROM payments WHERE payment_method = 'advance';
ALTER TABLE payments DROP CONSTRAINT payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
  CHECK (payment_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other'));

DROP TABLE IF EXISTS customer_advance_refunds;
DROP TABLE IF EXISTS customer_advances;
