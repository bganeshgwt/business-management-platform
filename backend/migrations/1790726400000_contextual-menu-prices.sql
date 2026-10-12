-- Up Migration
CREATE TABLE product_selling_rules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  outlet_id BIGINT REFERENCES outlets(id) ON DELETE CASCADE,
  channel_id BIGINT REFERENCES sales_channels(id) ON DELETE CASCADE,
  order_type VARCHAR(20) CHECK (order_type IN ('dine_in','takeaway','delivery','qr','online')),
  price NUMERIC(12,2) CHECK (price >= 0),
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (outlet_id IS NOT NULL OR channel_id IS NOT NULL OR order_type IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (product_id,outlet_id,channel_id,order_type)
);
CREATE INDEX idx_product_selling_rules_restaurant ON product_selling_rules(restaurant_id,product_id);

-- Down Migration
DROP TABLE product_selling_rules;
