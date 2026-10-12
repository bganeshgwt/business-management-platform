-- Up Migration

-- One settings row per restaurant, so restaurant_id is the primary key.
CREATE TABLE restaurant_settings (
  restaurant_id             BIGINT       PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  currency_code             VARCHAR(3)   NOT NULL DEFAULT 'INR',
  currency_symbol           VARCHAR(5)   NOT NULL DEFAULT '₹',
  timezone                  VARCHAR(50)  NOT NULL DEFAULT 'Asia/Kolkata',
  tax_mode                  VARCHAR(20)  NOT NULL DEFAULT 'exclusive'
                            CHECK (tax_mode IN ('inclusive', 'exclusive')),
  default_tax_percentage    NUMERIC(5,2) NOT NULL DEFAULT 5
                            CHECK (default_tax_percentage >= 0 AND default_tax_percentage <= 100),
  service_charge_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
                            CHECK (service_charge_percentage >= 0 AND service_charge_percentage <= 100),
  order_prefix              VARCHAR(10)  NOT NULL DEFAULT 'ORD',
  invoice_prefix            VARCHAR(10)  NOT NULL DEFAULT 'INV',
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by                BIGINT       REFERENCES users(id),
  updated_by                BIGINT       REFERENCES users(id)
);

CREATE TRIGGER trg_restaurant_settings_updated_at
BEFORE UPDATE ON restaurant_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Opening hours per weekday. outlet_id NULL means the whole restaurant;
-- an outlet row overrides the restaurant row for that outlet.
CREATE TABLE business_hours (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT      NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id      BIGINT      REFERENCES outlets(id) ON DELETE CASCADE,
  day_of_week    SMALLINT    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_open        BOOLEAN     NOT NULL DEFAULT TRUE,
  open_time      TIME,
  close_time     TIME,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     BIGINT      REFERENCES users(id),
  updated_by     BIGINT      REFERENCES users(id),
  UNIQUE NULLS NOT DISTINCT (restaurant_id, outlet_id, day_of_week),
  CONSTRAINT chk_business_hours_times
    CHECK (NOT is_open OR (open_time IS NOT NULL AND close_time IS NOT NULL))
);

CREATE INDEX idx_business_hours_restaurant_id ON business_hours(restaurant_id);

CREATE TRIGGER trg_business_hours_updated_at
BEFORE UPDATE ON business_hours
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS business_hours;
DROP TABLE IF EXISTS restaurant_settings;
