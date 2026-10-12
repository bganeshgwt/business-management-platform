-- Up Migration

-- Every movement of loyalty points, so a customer's balance can always be
-- explained. Points are earned when a bill is paid and spent at billing time.
CREATE TABLE loyalty_transactions (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id    BIGINT       NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  bill_id        BIGINT       REFERENCES bills(id) ON DELETE SET NULL,
  points         INTEGER      NOT NULL CHECK (points <> 0),
  balance_after  INTEGER      NOT NULL CHECK (balance_after >= 0),
  entry_type     VARCHAR(20)  NOT NULL
                 CHECK (entry_type IN ('earn', 'redeem', 'adjust', 'expire')),
  amount         NUMERIC(14,2),
  notes          VARCHAR(200),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id)
);

CREATE INDEX idx_loyalty_customer ON loyalty_transactions(customer_id, created_at DESC);
CREATE INDEX idx_loyalty_restaurant ON loyalty_transactions(restaurant_id, created_at DESC);

-- Points earned on a bill are written once, so a re-run cannot double them.
CREATE UNIQUE INDEX uq_loyalty_earn_per_bill
  ON loyalty_transactions (bill_id) WHERE entry_type = 'earn';

-- How the scheme works for this restaurant.
ALTER TABLE restaurant_settings
  ADD COLUMN loyalty_enabled     BOOLEAN       NOT NULL DEFAULT FALSE,
  -- Spend this much to earn one point.
  ADD COLUMN loyalty_earn_amount NUMERIC(12,2) NOT NULL DEFAULT 100
      CHECK (loyalty_earn_amount > 0),
  -- What one point is worth when it is spent.
  ADD COLUMN loyalty_point_value NUMERIC(12,2) NOT NULL DEFAULT 1
      CHECK (loyalty_point_value > 0),
  ADD COLUMN loyalty_min_redeem  INTEGER       NOT NULL DEFAULT 50
      CHECK (loyalty_min_redeem >= 0);

-- Bills record how many points were spent on them, for the receipt and reports.
ALTER TABLE bills
  ADD COLUMN loyalty_points_used INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_used >= 0),
  ADD COLUMN loyalty_discount    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (loyalty_discount >= 0);

-- Down Migration

ALTER TABLE bills
  DROP COLUMN IF EXISTS loyalty_points_used,
  DROP COLUMN IF EXISTS loyalty_discount;

ALTER TABLE restaurant_settings
  DROP COLUMN IF EXISTS loyalty_enabled,
  DROP COLUMN IF EXISTS loyalty_earn_amount,
  DROP COLUMN IF EXISTS loyalty_point_value,
  DROP COLUMN IF EXISTS loyalty_min_redeem;

DROP TABLE IF EXISTS loyalty_transactions;
