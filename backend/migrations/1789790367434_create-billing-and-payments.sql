-- Up Migration

-- A bill is the money document: once created it is a record, so its amounts are
-- a snapshot and are never recalculated from the menu again.
CREATE TABLE bills (
  id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id         BIGINT        REFERENCES outlets(id),
  business_day_id   BIGINT        REFERENCES business_days(id),
  order_id          BIGINT        NOT NULL REFERENCES orders(id),
  bill_number       VARCHAR(30)   NOT NULL,
  discount_id       BIGINT        REFERENCES discounts(id),
  discount_code     VARCHAR(30),
  subtotal          NUMERIC(14,2) NOT NULL CHECK (subtotal >= 0),
  discount_amount   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  service_charge    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (service_charge >= 0),
  round_off         NUMERIC(6,2)  NOT NULL DEFAULT 0,
  total_amount      NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
  paid_amount       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  refunded_amount   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  bill_status       VARCHAR(20)   NOT NULL DEFAULT 'unpaid'
                    CHECK (bill_status IN ('unpaid', 'partial', 'paid', 'void')),
  void_reason       VARCHAR(200),
  billed_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  settled_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by        BIGINT        REFERENCES users(id),
  updated_by        BIGINT        REFERENCES users(id),
  UNIQUE (restaurant_id, bill_number)
);

-- One live bill per order: a voided bill may be replaced, but two open bills
-- for the same order would let a table be charged twice.
CREATE UNIQUE INDEX uq_bills_order_active ON bills (order_id) WHERE bill_status <> 'void';
CREATE INDEX idx_bills_restaurant ON bills(restaurant_id, billed_at DESC);
CREATE INDEX idx_bills_business_day ON bills(business_day_id);

CREATE TRIGGER trg_bills_updated_at
BEFORE UPDATE ON bills
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payments (
  id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id         BIGINT        NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  order_id        BIGINT        NOT NULL REFERENCES orders(id),
  business_day_id BIGINT        REFERENCES business_days(id),
  payment_method  VARCHAR(20)   NOT NULL
                  CHECK (payment_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other')),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  tendered_amount NUMERIC(14,2) CHECK (tendered_amount IS NULL OR tendered_amount >= 0),
  change_amount   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  transaction_ref VARCHAR(100),
  payment_status  VARCHAR(20)   NOT NULL DEFAULT 'success'
                  CHECK (payment_status IN ('success', 'failed', 'refunded')),
  paid_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      BIGINT        REFERENCES users(id)
);

CREATE INDEX idx_payments_bill ON payments(bill_id);
CREATE INDEX idx_payments_restaurant ON payments(restaurant_id, paid_at DESC);
CREATE INDEX idx_payments_business_day ON payments(business_day_id);

CREATE TABLE refunds (
  id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id         BIGINT        NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  payment_id      BIGINT        REFERENCES payments(id),
  business_day_id BIGINT        REFERENCES business_days(id),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  refund_method   VARCHAR(20)   NOT NULL DEFAULT 'cash'
                  CHECK (refund_method IN ('cash', 'card', 'upi', 'online', 'wallet', 'other')),
  reason          VARCHAR(200)  NOT NULL,
  refunded_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      BIGINT        REFERENCES users(id)
);

CREATE INDEX idx_refunds_bill ON refunds(bill_id);
CREATE INDEX idx_refunds_restaurant ON refunds(restaurant_id, refunded_at DESC);

-- Down Migration

DROP TABLE IF EXISTS refunds;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS bills;
