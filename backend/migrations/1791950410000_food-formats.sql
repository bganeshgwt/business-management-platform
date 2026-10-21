-- Up Migration
-- Food formats on the restaurant engine: a café (counter-first, tokens), a
-- bakery (production, selling by weight, cake pre-orders, day-end unsold) and
-- a cloud kitchen (delivery only, aggregator channels). A restaurant is one
-- of them; the format presets its features and how the POS opens.
ALTER TABLE restaurants ADD COLUMN format TEXT NOT NULL DEFAULT 'restaurant'
  CHECK (format IN ('restaurant', 'cafe', 'bakery', 'cloud_kitchen'));
COMMENT ON COLUMN restaurants.format IS 'restaurant (full service), cafe (counter first), bakery (production and pre-orders) or cloud_kitchen (delivery only).';

-- The kinds of order the POS offers (a cloud kitchen takes no dine-in) and
-- the one a new order starts on (a café: takeaway at the counter).
ALTER TABLE service_settings
  ADD COLUMN pos_order_types TEXT[] NOT NULL DEFAULT '{dine_in,takeaway,delivery}',
  ADD COLUMN default_order_type TEXT NOT NULL DEFAULT 'dine_in',
  ADD CONSTRAINT service_settings_pos_types CHECK (cardinality(pos_order_types) > 0 AND pos_order_types <@ ARRAY['dine_in', 'takeaway', 'delivery']::TEXT[]),
  ADD CONSTRAINT service_settings_default_type CHECK (default_order_type = ANY (pos_order_types));

-- A dish or bake sold by weight: its price is per kg and the quantity on the
-- order is the weight in kg (0.25 = 250 g).
ALTER TABLE products ADD COLUMN sold_by TEXT NOT NULL DEFAULT 'unit' CHECK (sold_by IN ('unit', 'weight'));

-- Unsold at the end of the day (a bakery's leftover cakes and breads).
ALTER TABLE stock_transactions DROP CONSTRAINT IF EXISTS chk_stock_transactions_waste_reason;
ALTER TABLE stock_transactions ADD CONSTRAINT chk_stock_transactions_waste_reason
  CHECK (waste_reason IS NULL OR waste_reason IN
    ('spoiled', 'expired', 'overcooked', 'dropped', 'returned', 'over_prepped', 'remade', 'quality', 'unsold', 'other'));

-- Pre-orders: a cake or a party order for a later day, with the message on
-- the cake, the advance taken and when it is due. It is baked, made ready,
-- and on collection becomes a takeaway order billed against the advance.
CREATE TABLE restaurant_preorders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id BIGINT REFERENCES outlets(id) ON DELETE SET NULL,
  preorder_number VARCHAR(20) NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  due_at TIMESTAMPTZ NOT NULL,
  fulfilment TEXT NOT NULL DEFAULT 'pickup' CHECK (fulfilment IN ('pickup', 'delivery')),
  delivery_address VARCHAR(300),
  notes VARCHAR(500),
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'in_production', 'ready', 'collected', 'cancelled')),
  estimated_total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (estimated_total >= 0),
  advance_id BIGINT REFERENCES customer_advances(id) ON DELETE SET NULL,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  cancel_reason VARCHAR(300),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  collected_at TIMESTAMPTZ,
  UNIQUE (restaurant_id, preorder_number),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CHECK (status <> 'collected' OR order_id IS NOT NULL),
  CHECK (fulfilment = 'pickup' OR delivery_address IS NOT NULL)
);
CREATE INDEX restaurant_preorders_due ON restaurant_preorders (restaurant_id, due_at) WHERE status IN ('booked', 'in_production', 'ready');

CREATE TABLE restaurant_preorder_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  preorder_id BIGINT NOT NULL REFERENCES restaurant_preorders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_variant_id BIGINT REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  -- The message on the cake, the flavour, the shape: what the baker reads.
  notes VARCHAR(300)
);
CREATE INDEX restaurant_preorder_items_order ON restaurant_preorder_items (restaurant_id, preorder_id);

-- Pre-orders are a restaurant feature: on for a bakery (and a café), off for
-- the others until switched on.
INSERT INTO platform_modules (code, name, description, kind, sort_order, feature_group) VALUES
 ('preorders', 'Pre-orders & cakes', 'Orders for a later day (cakes, party trays) with the message, an advance and the time it is due; made ready and billed on collection.', 'optional', 317, 'Service');
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('preorders', 'restaurant', FALSE);
INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES ('preorders', 'restaurant'), ('preorders', 'guests');

-- Down Migration
DELETE FROM business_capabilities WHERE capability = 'preorders';
DELETE FROM platform_module_dependencies WHERE module_code = 'preorders';
DELETE FROM platform_module_business_types WHERE module_code = 'preorders';
DELETE FROM platform_modules WHERE code = 'preorders';
DROP TABLE restaurant_preorder_items;
DROP TABLE restaurant_preorders;
UPDATE stock_transactions SET waste_reason = 'other' WHERE waste_reason = 'unsold';
ALTER TABLE stock_transactions DROP CONSTRAINT IF EXISTS chk_stock_transactions_waste_reason;
ALTER TABLE stock_transactions ADD CONSTRAINT chk_stock_transactions_waste_reason
  CHECK (waste_reason IS NULL OR waste_reason IN
    ('spoiled', 'expired', 'overcooked', 'dropped', 'returned', 'over_prepped', 'remade', 'quality', 'other'));
ALTER TABLE products DROP COLUMN sold_by;
ALTER TABLE service_settings DROP CONSTRAINT service_settings_default_type, DROP CONSTRAINT service_settings_pos_types,
  DROP COLUMN default_order_type, DROP COLUMN pos_order_types;
ALTER TABLE restaurants DROP COLUMN format;
