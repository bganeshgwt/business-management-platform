-- Up Migration

-- === Split bills ===
-- A table can now be billed in parts: one bill per person or per group. Each
-- bill records exactly which order lines, and how much of each, it covers.
CREATE TABLE bill_items (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bill_id        BIGINT        NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  order_item_id  BIGINT        NOT NULL REFERENCES order_items(id),
  quantity       NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  line_subtotal  NUMERIC(14,2) NOT NULL CHECK (line_subtotal >= 0),
  line_tax       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (line_tax >= 0),
  line_total     NUMERIC(14,2) NOT NULL CHECK (line_total >= 0),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (bill_id, order_item_id)
);

CREATE INDEX idx_bill_items_bill ON bill_items(bill_id);
CREATE INDEX idx_bill_items_order_item ON bill_items(order_item_id);

-- One live bill per order is no longer the rule: an order may have several,
-- as long as together they do not bill more than was ordered (checked in code).
DROP INDEX IF EXISTS uq_bills_order_active;

ALTER TABLE bills
  ADD COLUMN print_count   INTEGER NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  ADD COLUMN last_printed_at TIMESTAMPTZ,
  ADD COLUMN is_split      BOOLEAN NOT NULL DEFAULT FALSE;

-- === Purchase returns ===
-- Goods sent back to a supplier: stock goes down and the supplier owes a credit.
CREATE TABLE purchase_returns (
  id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  supplier_id       BIGINT        NOT NULL REFERENCES suppliers(id),
  purchase_order_id BIGINT        REFERENCES purchase_orders(id),
  return_number     VARCHAR(30)   NOT NULL,
  return_date       DATE          NOT NULL DEFAULT CURRENT_DATE,
  total_amount      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  reason            VARCHAR(200)  NOT NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by        BIGINT        REFERENCES users(id),
  updated_by        BIGINT        REFERENCES users(id),
  UNIQUE (restaurant_id, return_number)
);

CREATE INDEX idx_purchase_returns_supplier ON purchase_returns(supplier_id);

CREATE TRIGGER trg_purchase_returns_updated_at
BEFORE UPDATE ON purchase_returns
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_return_items (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_return_id BIGINT        NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  inventory_item_id  BIGINT        NOT NULL REFERENCES inventory_items(id),
  quantity           NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit_price         NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  amount             NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (purchase_return_id, inventory_item_id)
);

-- === Supplier payments ===
-- What has been paid against purchases, so an outstanding balance can be shown.
CREATE TABLE supplier_payments (
  id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  supplier_id       BIGINT        NOT NULL REFERENCES suppliers(id),
  purchase_order_id BIGINT        REFERENCES purchase_orders(id),
  payment_date      DATE          NOT NULL DEFAULT CURRENT_DATE,
  amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_method    VARCHAR(20)   NOT NULL DEFAULT 'cash'
                    CHECK (payment_method IN ('cash', 'card', 'upi', 'bank', 'cheque', 'other')),
  reference_no      VARCHAR(50),
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by        BIGINT        REFERENCES users(id),
  updated_by        BIGINT        REFERENCES users(id)
);

CREATE INDEX idx_supplier_payments_supplier ON supplier_payments(supplier_id, payment_date DESC);

CREATE TRIGGER trg_supplier_payments_updated_at
BEFORE UPDATE ON supplier_payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- === Per-outlet stock ===
-- Until now stock was one number per item. Outlets each hold their own, so a
-- transfer can move stock from one to the other and both sides add up.
CREATE TABLE stock_balances (
  id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  inventory_item_id BIGINT        NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  outlet_id         BIGINT        REFERENCES outlets(id) ON DELETE CASCADE,
  quantity          NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- NULL outlet means the main store, and must count as one key, not many.
  UNIQUE NULLS NOT DISTINCT (inventory_item_id, outlet_id)
);

CREATE INDEX idx_stock_balances_item ON stock_balances(inventory_item_id);

CREATE TRIGGER trg_stock_balances_updated_at
BEFORE UPDATE ON stock_balances
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Existing stock belongs to the main store.
INSERT INTO stock_balances (restaurant_id, inventory_item_id, outlet_id, quantity)
SELECT restaurant_id, id, NULL, current_stock FROM inventory_items;

-- Returns and transfers-in need their own movement types.
ALTER TABLE stock_transactions DROP CONSTRAINT IF EXISTS stock_transactions_transaction_type_check;
ALTER TABLE stock_transactions ADD CONSTRAINT stock_transactions_transaction_type_check
  CHECK (transaction_type IN
    ('purchase', 'adjustment', 'wastage', 'consumption', 'transfer', 'opening', 'return'));

-- Permissions for the new screens.
INSERT INTO permissions (code, module, name) VALUES
  ('purchasing.returns', 'purchasing', 'Record purchase returns and supplier payments');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'purchasing.returns'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'purchasing.returns');
DELETE FROM permissions WHERE code = 'purchasing.returns';

ALTER TABLE stock_transactions DROP CONSTRAINT IF EXISTS stock_transactions_transaction_type_check;
ALTER TABLE stock_transactions ADD CONSTRAINT stock_transactions_transaction_type_check
  CHECK (transaction_type IN
    ('purchase', 'adjustment', 'wastage', 'consumption', 'transfer', 'opening'));

DROP TABLE IF EXISTS stock_balances;
DROP TABLE IF EXISTS supplier_payments;
DROP TABLE IF EXISTS purchase_return_items;
DROP TABLE IF EXISTS purchase_returns;

ALTER TABLE bills
  DROP COLUMN IF EXISTS print_count,
  DROP COLUMN IF EXISTS last_printed_at,
  DROP COLUMN IF EXISTS is_split;

DROP TABLE IF EXISTS bill_items;

CREATE UNIQUE INDEX uq_bills_order_active ON bills (order_id) WHERE bill_status <> 'void';
