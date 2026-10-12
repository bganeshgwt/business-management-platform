-- Up Migration

-- Outlet-specific accounting identity and sequences.
ALTER TABLE outlets
  ADD COLUMN order_prefix VARCHAR(10),
  ADD COLUMN invoice_prefix VARCHAR(10);

-- A day belongs to an outlet when outlets are used. Existing restaurant-wide
-- days remain valid for installations that do not use branches.
CREATE INDEX idx_business_days_outlet_status
  ON business_days (restaurant_id, outlet_id, day_status);

CREATE TABLE outlet_order_counters (
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id BIGINT REFERENCES outlets(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_outlet_order_counters
  ON outlet_order_counters (restaurant_id, COALESCE(outlet_id, 0));

-- Several service periods in one day (for example breakfast and dinner).
ALTER TABLE business_hours
  ADD COLUMN periods JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT chk_business_hours_periods_array CHECK (jsonb_typeof(periods) = 'array');

UPDATE business_hours
SET periods = CASE WHEN is_open THEN
  jsonb_build_array(jsonb_build_object('openTime', LEFT(open_time::text, 5), 'closeTime', LEFT(close_time::text, 5)))
  ELSE '[]'::jsonb END;

-- Each dish may follow the restaurant tax mode or explicitly include/exclude
-- tax. MRP is an optional ceiling disclosed on the menu and invoice.
ALTER TABLE products
  ADD COLUMN tax_mode VARCHAR(20) NOT NULL DEFAULT 'default'
    CHECK (tax_mode IN ('default', 'inclusive', 'exclusive')),
  ADD COLUMN mrp NUMERIC(12,2) CHECK (mrp IS NULL OR mrp >= 0);

ALTER TABLE order_items
  ADD COLUMN price_includes_tax BOOLEAN,
  ADD COLUMN mrp NUMERIC(12,2) CHECK (mrp IS NULL OR mrp >= 0),
  ADD COLUMN course_no SMALLINT NOT NULL DEFAULT 1 CHECK (course_no BETWEEN 1 AND 20),
  ADD COLUMN course_name VARCHAR(60),
  ADD COLUMN fire_status VARCHAR(20) NOT NULL DEFAULT 'fired'
    CHECK (fire_status IN ('held', 'fired')),
  ADD COLUMN fired_at TIMESTAMPTZ;

UPDATE order_items oi
SET price_includes_tax = (rs.tax_mode = 'inclusive'), fired_at = oi.created_at
FROM orders o
JOIN restaurant_settings rs ON rs.restaurant_id = o.restaurant_id
WHERE oi.order_id = o.id;

-- Ingredient usage for an add-on, such as extra cheese or sauce.
CREATE TABLE modifier_recipes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  modifier_id BIGINT NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
  inventory_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  UNIQUE (modifier_id, inventory_item_id)
);
CREATE TRIGGER trg_modifier_recipes_updated_at BEFORE UPDATE ON modifier_recipes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Prepared ingredients can themselves have recipes. Production converts raw
-- ingredients into a prepared stock item and records the actual output cost.
ALTER TABLE inventory_items
  ADD COLUMN item_type VARCHAR(20) NOT NULL DEFAULT 'raw'
    CHECK (item_type IN ('raw', 'prepared')),
  ADD COLUMN average_cost NUMERIC(12,4) CHECK (average_cost IS NULL OR average_cost >= 0);

UPDATE inventory_items SET average_cost = last_cost WHERE last_cost IS NOT NULL;

CREATE TABLE inventory_recipes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  output_item_id BIGINT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  ingredient_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  quantity NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  UNIQUE (output_item_id, ingredient_item_id),
  CHECK (output_item_id <> ingredient_item_id)
);
CREATE TRIGGER trg_inventory_recipes_updated_at BEFORE UPDATE ON inventory_recipes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE production_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id BIGINT REFERENCES outlets(id),
  output_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  batch_number VARCHAR(60) NOT NULL,
  produced_quantity NUMERIC(14,3) NOT NULL CHECK (produced_quantity > 0),
  total_cost NUMERIC(14,2) NOT NULL CHECK (total_cost >= 0),
  unit_cost NUMERIC(12,4) NOT NULL CHECK (unit_cost >= 0),
  produced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expiry_date DATE,
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  UNIQUE (restaurant_id, batch_number)
);

-- Printed-document presentation. logo_path is served from the application's
-- existing uploads directory. Composition dealers can issue a Bill of Supply.
ALTER TABLE restaurant_settings
  ADD COLUMN receipt_logo_path VARCHAR(500),
  ADD COLUMN document_type VARCHAR(30) NOT NULL DEFAULT 'auto'
    CHECK (document_type IN ('auto', 'tax_invoice', 'bill_of_supply')),
  ADD COLUMN composition_percentage NUMERIC(5,2)
    CHECK (composition_percentage IS NULL OR composition_percentage BETWEEN 0 AND 100),
  ADD COLUMN composition_note VARCHAR(200);

-- Down Migration
ALTER TABLE restaurant_settings DROP COLUMN IF EXISTS composition_note,
  DROP COLUMN IF EXISTS composition_percentage, DROP COLUMN IF EXISTS document_type,
  DROP COLUMN IF EXISTS receipt_logo_path;
DROP TABLE IF EXISTS production_batches;
DROP TABLE IF EXISTS inventory_recipes;
ALTER TABLE inventory_items DROP COLUMN IF EXISTS average_cost, DROP COLUMN IF EXISTS item_type;
DROP TABLE IF EXISTS modifier_recipes;
ALTER TABLE order_items DROP COLUMN IF EXISTS fired_at, DROP COLUMN IF EXISTS fire_status,
  DROP COLUMN IF EXISTS course_name, DROP COLUMN IF EXISTS course_no,
  DROP COLUMN IF EXISTS mrp, DROP COLUMN IF EXISTS price_includes_tax;
ALTER TABLE products DROP COLUMN IF EXISTS mrp, DROP COLUMN IF EXISTS tax_mode;
ALTER TABLE business_hours DROP COLUMN IF EXISTS periods;
DROP INDEX IF EXISTS idx_business_days_outlet_status;
DROP TABLE IF EXISTS outlet_order_counters;
ALTER TABLE outlets DROP COLUMN IF EXISTS invoice_prefix, DROP COLUMN IF EXISTS order_prefix;
