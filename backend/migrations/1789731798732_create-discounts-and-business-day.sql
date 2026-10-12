-- Up Migration

-- Offers and coupons. A percentage discount can be capped with max_discount_amount.
CREATE TABLE discounts (
  id                  BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  code                VARCHAR(30)   NOT NULL,
  name                VARCHAR(150)  NOT NULL,
  description         TEXT,
  discount_type       VARCHAR(20)   NOT NULL
                      CHECK (discount_type IN ('percentage', 'amount')),
  value               NUMERIC(12,2) NOT NULL CHECK (value > 0),
  max_discount_amount NUMERIC(12,2) CHECK (max_discount_amount IS NULL OR max_discount_amount > 0),
  min_order_amount    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
  valid_from          DATE,
  valid_to            DATE,
  usage_limit         INTEGER       CHECK (usage_limit IS NULL OR usage_limit > 0),
  used_count          INTEGER       NOT NULL DEFAULT 0,
  applies_to          VARCHAR(20)   NOT NULL DEFAULT 'all'
                      CHECK (applies_to IN ('all', 'dine_in', 'takeaway', 'delivery', 'online')),
  status              VARCHAR(20)   NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive')),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by          BIGINT        REFERENCES users(id),
  updated_by          BIGINT        REFERENCES users(id),
  CONSTRAINT chk_discount_percentage CHECK (discount_type <> 'percentage' OR value <= 100),
  CONSTRAINT chk_discount_dates CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX uq_discounts_restaurant_code ON discounts (restaurant_id, UPPER(code));
CREATE INDEX idx_discounts_restaurant_id ON discounts(restaurant_id);

CREATE TRIGGER trg_discounts_updated_at
BEFORE UPDATE ON discounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The business day: sales are grouped by this, not by midnight, because a
-- restaurant open past 00:00 still counts those orders as the previous day.
CREATE TABLE business_days (
  id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id       BIGINT        REFERENCES outlets(id),
  business_date   DATE          NOT NULL,
  opened_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  opening_cash    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  closing_cash    NUMERIC(12,2) CHECK (closing_cash IS NULL OR closing_cash >= 0),
  notes           TEXT,
  day_status      VARCHAR(20)   NOT NULL DEFAULT 'open'
                  CHECK (day_status IN ('open', 'closed')),
  opened_by       BIGINT        REFERENCES users(id),
  closed_by       BIGINT        REFERENCES users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (restaurant_id, outlet_id, business_date)
);

-- Only one day can be open at a time per restaurant/outlet.
CREATE UNIQUE INDEX uq_business_days_one_open
  ON business_days (restaurant_id, COALESCE(outlet_id, 0))
  WHERE day_status = 'open';

CREATE INDEX idx_business_days_restaurant_id ON business_days(restaurant_id);

CREATE TRIGGER trg_business_days_updated_at
BEFORE UPDATE ON business_days
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- New permissions for the modules added above.
INSERT INTO permissions (code, module, name) VALUES
  ('discounts.view',    'discounts',  'View discounts and offers'),
  ('discounts.manage',  'discounts',  'Create and edit discounts and offers'),
  ('business_day.view', 'operations', 'View the business day'),
  ('business_day.manage', 'operations', 'Open and close the business day');

-- Grant them to the system roles that need them.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
  (r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN')
     AND p.code IN ('discounts.view', 'discounts.manage', 'business_day.view', 'business_day.manage'))
  OR (r.code = 'MANAGER'
     AND p.code IN ('discounts.view', 'discounts.manage', 'business_day.view', 'business_day.manage'))
  OR (r.code = 'CASHIER'
     AND p.code IN ('discounts.view', 'business_day.view', 'business_day.manage'))
)
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE;

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions
  WHERE code IN ('discounts.view', 'discounts.manage', 'business_day.view', 'business_day.manage')
);

DELETE FROM permissions
WHERE code IN ('discounts.view', 'discounts.manage', 'business_day.view', 'business_day.manage');

DROP TABLE IF EXISTS business_days;
DROP TABLE IF EXISTS discounts;
