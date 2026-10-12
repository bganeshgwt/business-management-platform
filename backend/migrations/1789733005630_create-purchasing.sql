-- Up Migration

-- A purchase order sent to a supplier. Receiving it adds stock, which is why
-- received quantities are tracked per item rather than only on the order.
CREATE TABLE purchase_orders (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id      BIGINT        REFERENCES outlets(id),
  supplier_id    BIGINT        NOT NULL REFERENCES suppliers(id),
  po_number      VARCHAR(30)   NOT NULL,
  order_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
  expected_date  DATE,
  total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  po_status      VARCHAR(20)   NOT NULL DEFAULT 'draft'
                 CHECK (po_status IN ('draft', 'ordered', 'partial', 'received', 'cancelled')),
  notes          TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by     BIGINT        REFERENCES users(id),
  updated_by     BIGINT        REFERENCES users(id),
  UNIQUE (restaurant_id, po_number),
  CONSTRAINT chk_po_dates CHECK (expected_date IS NULL OR expected_date >= order_date)
);

CREATE INDEX idx_purchase_orders_restaurant ON purchase_orders(restaurant_id, order_date DESC);
CREATE INDEX idx_purchase_orders_supplier ON purchase_orders(supplier_id);

CREATE TRIGGER trg_purchase_orders_updated_at
BEFORE UPDATE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_order_items (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_id  BIGINT        NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id  BIGINT        NOT NULL REFERENCES inventory_items(id),
  quantity           NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  received_quantity  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  unit_price         NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  amount             NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (purchase_order_id, inventory_item_id),
  CONSTRAINT chk_po_item_received CHECK (received_quantity <= quantity)
);

CREATE INDEX idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);

CREATE TRIGGER trg_purchase_order_items_updated_at
BEFORE UPDATE ON purchase_order_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS purchase_order_items;
DROP TABLE IF EXISTS purchase_orders;
