-- Up Migration

-- Until now the tax percentage sat directly on each product, which meant no
-- HSN/SAC code anywhere and no way to change a rate without editing every dish.
-- A named rate holds the percentage, the code the GST return asks for, and any
-- cess; products point at one.
CREATE TABLE tax_rates (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name             VARCHAR(80)   NOT NULL,
  percentage       NUMERIC(5,2)  NOT NULL
                   CHECK (percentage >= 0 AND percentage <= 100),
  -- HSN for goods, SAC for services. Restaurant service is 996331.
  hsn_code         VARCHAR(10),
  cess_percentage  NUMERIC(5,2)  NOT NULL DEFAULT 0
                   CHECK (cess_percentage >= 0 AND cess_percentage <= 100),
  is_default       BOOLEAN       NOT NULL DEFAULT FALSE,
  status           VARCHAR(20)   NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'inactive')),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by       BIGINT        REFERENCES users(id),
  updated_by       BIGINT        REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_tax_rates_restaurant_name
  ON tax_rates (restaurant_id, LOWER(name));

-- At most one default per restaurant: it is what a new dish starts with.
CREATE UNIQUE INDEX uq_tax_rates_default
  ON tax_rates (restaurant_id) WHERE is_default;

CREATE INDEX idx_tax_rates_restaurant_id ON tax_rates(restaurant_id);

CREATE TRIGGER trg_tax_rates_updated_at
BEFORE UPDATE ON tax_rates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- products.tax_percentage stays: it is the rate that was actually applied, and
-- keeping it means pricing needs no extra join. The link is what lets a rate
-- change flow to every dish that uses it.
ALTER TABLE products
  ADD COLUMN tax_rate_id BIGINT REFERENCES tax_rates(id);

CREATE INDEX idx_products_tax_rate_id ON products(tax_rate_id);

-- The GST return is filed HSN-wise, so the code is copied onto the line when the
-- order is placed. Changing a rate later must not rewrite old bills.
ALTER TABLE order_items
  ADD COLUMN hsn_code VARCHAR(10);

-- The rates an Indian restaurant actually uses, for every restaurant already in
-- the system. 5% on restaurant service is the default.
INSERT INTO tax_rates (restaurant_id, name, percentage, hsn_code, is_default)
SELECT r.id, seed.name, seed.percentage, seed.hsn_code, seed.is_default
FROM restaurants r
CROSS JOIN (VALUES
  ('Exempt',              0.00,  NULL,     FALSE),
  ('GST 5% (restaurant)', 5.00,  '996331', TRUE),
  ('GST 12%',            12.00,  '2106',   FALSE),
  ('GST 18%',            18.00,  '2201',   FALSE),
  ('GST 28%',            28.00,  '2202',   FALSE)
) AS seed(name, percentage, hsn_code, is_default);

-- Point every existing dish at the rate that matches what it already charged.
UPDATE products p
SET tax_rate_id = t.id
FROM tax_rates t
WHERE t.restaurant_id = p.restaurant_id
  AND t.percentage = p.tax_percentage;

-- Fill in the code on lines already taken, so old bills report HSN-wise too.
UPDATE order_items oi
SET hsn_code = t.hsn_code
FROM products p
JOIN tax_rates t ON t.id = p.tax_rate_id
WHERE p.id = oi.product_id AND oi.hsn_code IS NULL;

-- Down Migration

ALTER TABLE order_items DROP COLUMN IF EXISTS hsn_code;
ALTER TABLE products DROP COLUMN IF EXISTS tax_rate_id;
DROP TABLE IF EXISTS tax_rates;
