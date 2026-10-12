-- Up Migration

CREATE TABLE suppliers (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(150) NOT NULL,
  code           VARCHAR(30),
  contact_person VARCHAR(150),
  mobile         VARCHAR(20),
  email          VARCHAR(150),
  address        TEXT,
  gst_number     VARCHAR(20),
  payment_terms  VARCHAR(100),
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_suppliers_restaurant_name ON suppliers (restaurant_id, LOWER(name));
CREATE UNIQUE INDEX uq_suppliers_restaurant_code
  ON suppliers (restaurant_id, UPPER(code)) WHERE code IS NOT NULL;
CREATE INDEX idx_suppliers_restaurant_id ON suppliers(restaurant_id);

CREATE TRIGGER trg_suppliers_updated_at
BEFORE UPDATE ON suppliers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Units of measure: kg, litre, piece, packet.
CREATE TABLE units (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT      NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(50) NOT NULL,
  short_name     VARCHAR(10) NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     BIGINT      REFERENCES users(id),
  updated_by     BIGINT      REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_units_restaurant_name ON units (restaurant_id, LOWER(name));
CREATE INDEX idx_units_restaurant_id ON units(restaurant_id);

CREATE TRIGGER trg_units_updated_at
BEFORE UPDATE ON units
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Raw materials, not menu products: rice, oil, paneer, packaging.
-- current_stock is kept in step with stock_transactions inside one database
-- transaction, so the live figure never needs a slow SUM over the whole ledger.
CREATE TABLE inventory_items (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(150)  NOT NULL,
  code           VARCHAR(30),
  unit_id        BIGINT        NOT NULL REFERENCES units(id),
  category       VARCHAR(50),
  current_stock  NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_level  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  last_cost      NUMERIC(12,2) CHECK (last_cost IS NULL OR last_cost >= 0),
  status         VARCHAR(20)   NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by     BIGINT        REFERENCES users(id),
  updated_by     BIGINT        REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_inventory_items_name ON inventory_items (restaurant_id, LOWER(name));
CREATE UNIQUE INDEX uq_inventory_items_code
  ON inventory_items (restaurant_id, UPPER(code)) WHERE code IS NOT NULL;
CREATE INDEX idx_inventory_items_restaurant_id ON inventory_items(restaurant_id);

CREATE TRIGGER trg_inventory_items_updated_at
BEFORE UPDATE ON inventory_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every stock movement, in or out. quantity is positive for stock in and
-- negative for stock out, so the ledger always adds up to current_stock.
CREATE TABLE stock_transactions (
  id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id         BIGINT        REFERENCES outlets(id),
  inventory_item_id BIGINT        NOT NULL REFERENCES inventory_items(id),
  transaction_type  VARCHAR(20)   NOT NULL
                    CHECK (transaction_type IN
                      ('purchase', 'adjustment', 'wastage', 'consumption', 'transfer', 'opening')),
  quantity          NUMERIC(14,3) NOT NULL CHECK (quantity <> 0),
  unit_cost         NUMERIC(12,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  balance_after     NUMERIC(14,3) NOT NULL,
  reason            VARCHAR(150),
  reference_type    VARCHAR(30),
  reference_id      BIGINT,
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by        BIGINT        REFERENCES users(id)
);

CREATE INDEX idx_stock_transactions_item ON stock_transactions(inventory_item_id, created_at DESC);
CREATE INDEX idx_stock_transactions_restaurant ON stock_transactions(restaurant_id, created_at DESC);
CREATE INDEX idx_stock_transactions_type ON stock_transactions(restaurant_id, transaction_type);

-- Down Migration

DROP TABLE IF EXISTS stock_transactions;
DROP TABLE IF EXISTS inventory_items;
DROP TABLE IF EXISTS units;
DROP TABLE IF EXISTS suppliers;
