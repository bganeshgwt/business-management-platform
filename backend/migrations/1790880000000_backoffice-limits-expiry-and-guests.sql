-- Up Migration

-- ---------------------------------------------------------------------------
-- 1. A bill that had to use expired stock (sweep SW-B-01)
-- ---------------------------------------------------------------------------
-- A bill must never fail because of stock. When the only stock left of an
-- ingredient is a batch past its expiry date (yesterday's paneer, today's
-- delivery not yet keyed in), the sale takes it from that batch rather than
-- being refused at the till. That is worth knowing, not hiding: the ledger row
-- says how much of it came from expired batches, and each batch allocation says
-- it was taken after the batch had expired, so the batch view and the bell can
-- point at it.
ALTER TABLE stock_transactions ADD COLUMN expired_quantity NUMERIC(14,3);
ALTER TABLE stock_transactions ADD CONSTRAINT chk_stock_transactions_expired_quantity
  CHECK (expired_quantity IS NULL OR expired_quantity > 0);

ALTER TABLE inventory_batch_movements ADD COLUMN after_expiry BOOLEAN NOT NULL DEFAULT FALSE;

-- The bell reads the last two days of these, and only these.
CREATE INDEX idx_stock_transactions_expired_use
  ON stock_transactions (restaurant_id, created_at DESC)
  WHERE expired_quantity IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Stock & purchasing settings (SW-B-10, SW-B-11)
-- ---------------------------------------------------------------------------
-- One row per restaurant, made the first time someone saves the screen. Blank
-- limits mean "no limit", which is how every restaurant starts: an approval
-- step nobody asked for would stop the morning's buying.
--   po_approval_limit        a purchase order worth more than this (before
--                            GST) waits for an approver before it is sent
--   writeoff_approval_limit  wastage or a stock out worth more than this (at
--                            cost) needs a manager's PIN or the permission
--   transfer_receipt_required  stock sent between stores travels "in transit"
--                            until the receiving store confirms what arrived
CREATE TABLE stock_settings (
  restaurant_id             BIGINT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  po_approval_limit         NUMERIC(12,2) CHECK (po_approval_limit IS NULL OR po_approval_limit >= 0),
  writeoff_approval_limit   NUMERIC(12,2) CHECK (writeoff_approval_limit IS NULL OR writeoff_approval_limit >= 0),
  transfer_receipt_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                BIGINT REFERENCES users(id),
  updated_by                BIGINT REFERENCES users(id)
);

CREATE TRIGGER trg_stock_settings_updated_at
BEFORE UPDATE ON stock_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Purchase orders that wait for an approver (SW-B-10)
-- ---------------------------------------------------------------------------
-- "Waiting for approval" sits between draft and ordered. Who asked, who
-- approved (and for how much), or who sent it back and why, stay on the order
-- for the printed PO and the activity log. approved_amount is the total the
-- approver saw: an order edited afterwards is a different order.
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_po_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_po_status_check
  CHECK (po_status IN ('draft', 'pending_approval', 'ordered', 'partial', 'received', 'closed', 'cancelled'));

ALTER TABLE purchase_orders
  ADD COLUMN approval_requested_at TIMESTAMPTZ,
  ADD COLUMN approval_requested_by BIGINT REFERENCES users(id),
  ADD COLUMN approved_at           TIMESTAMPTZ,
  ADD COLUMN approved_by           BIGINT REFERENCES users(id),
  ADD COLUMN approved_amount       NUMERIC(12,2),
  ADD COLUMN approval_note         VARCHAR(300),
  ADD COLUMN rejected_at           TIMESTAMPTZ,
  ADD COLUMN rejected_by           BIGINT REFERENCES users(id),
  ADD COLUMN rejection_note        VARCHAR(300);

-- The approver's list and the bell read only the orders waiting.
CREATE INDEX idx_purchase_orders_waiting
  ON purchase_orders (restaurant_id, approval_requested_at)
  WHERE po_status = 'pending_approval';

-- ---------------------------------------------------------------------------
-- 4. New permissions
-- ---------------------------------------------------------------------------
-- purchasing.approve goes to owners only: the limit exists so that the person
-- who buys is not the only one who says yes to a large order, and managers
-- are the ones raising purchase orders. An owner can give it to a senior
-- manager under Roles. Large write-offs are a manager's call, as wastage
-- reversal already is. Raising an indent (asking the main store for stock) is
-- everyday kitchen work at an outlet, so the kitchen has it too.
INSERT INTO permissions (code, module, name) VALUES
  ('purchasing.approve', 'purchasing', 'Approve purchase orders over the approval limit'),
  ('inventory.approve_writeoff', 'inventory', 'Approve wastage or stock out over the approval limit'),
  ('inventory.indent', 'inventory', 'Ask the main store for stock (raise an indent)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'purchasing.approve'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'inventory.approve_writeoff'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'inventory.indent'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER', 'KITCHEN')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Why a finished dish was thrown away (SW-B-22)
-- ---------------------------------------------------------------------------
-- A dish written off by its recipe can be "remade" (made twice, billed once:
-- a wrong order or a mistake at the pass) or a "quality" complaint. Both add
-- up separately on Waste & reorder, because each has its own fix.
ALTER TABLE stock_transactions DROP CONSTRAINT IF EXISTS chk_stock_transactions_waste_reason;
ALTER TABLE stock_transactions ADD CONSTRAINT chk_stock_transactions_waste_reason
  CHECK (waste_reason IS NULL OR waste_reason IN
    ('spoiled', 'expired', 'overcooked', 'dropped', 'returned', 'over_prepped', 'remade', 'quality', 'other'));

-- ---------------------------------------------------------------------------
-- 6. Which till paid a supplier (REQ-SUPPLIER-OUTLET)
-- ---------------------------------------------------------------------------
-- Cash handed to a supplier out of a branch's drawer comes off that branch's
-- day-end count, not the main counter's. NULL is the main counter (and every
-- payment made from the office).
ALTER TABLE supplier_payments ADD COLUMN outlet_id BIGINT REFERENCES outlets(id);

CREATE INDEX idx_supplier_payments_till_day
  ON supplier_payments (restaurant_id, business_date)
  WHERE paid_from_till;

-- ---------------------------------------------------------------------------
-- 7. A guest's anniversary (SW-B-21)
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN anniversary_date DATE;

-- ---------------------------------------------------------------------------
-- 8. The bell's expiry and bills-due checks (SW-B-14)
-- ---------------------------------------------------------------------------
-- Batches with a known expiry, by date; and supplier bills still owed, by the
-- day they fall due. Both alerts read only these.
CREATE INDEX idx_inventory_batches_expiry
  ON inventory_batches (restaurant_id, expiry_date)
  WHERE expiry_date IS NOT NULL;

CREATE INDEX idx_goods_receipts_due
  ON goods_receipts (restaurant_id, due_date)
  WHERE receipt_status = 'posted' AND due_date IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_goods_receipts_due;
DROP INDEX IF EXISTS idx_inventory_batches_expiry;

ALTER TABLE customers DROP COLUMN IF EXISTS anniversary_date;

DROP INDEX IF EXISTS idx_supplier_payments_till_day;
ALTER TABLE supplier_payments DROP COLUMN IF EXISTS outlet_id;

-- Dish write-offs keep their rows; their reasons fold back into "other".
UPDATE stock_transactions SET waste_reason = 'other' WHERE waste_reason IN ('remade', 'quality');
ALTER TABLE stock_transactions DROP CONSTRAINT IF EXISTS chk_stock_transactions_waste_reason;
ALTER TABLE stock_transactions ADD CONSTRAINT chk_stock_transactions_waste_reason
  CHECK (waste_reason IS NULL OR waste_reason IN
    ('spoiled', 'expired', 'overcooked', 'dropped', 'returned', 'over_prepped', 'other'));

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions
                        WHERE code IN ('purchasing.approve', 'inventory.approve_writeoff', 'inventory.indent'));
DELETE FROM permissions WHERE code IN ('purchasing.approve', 'inventory.approve_writeoff', 'inventory.indent');

DROP INDEX IF EXISTS idx_purchase_orders_waiting;
-- An order still waiting goes back to being a draft.
UPDATE purchase_orders SET po_status = 'draft' WHERE po_status = 'pending_approval';
ALTER TABLE purchase_orders
  DROP COLUMN IF EXISTS approval_requested_at,
  DROP COLUMN IF EXISTS approval_requested_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_amount,
  DROP COLUMN IF EXISTS approval_note,
  DROP COLUMN IF EXISTS rejected_at,
  DROP COLUMN IF EXISTS rejected_by,
  DROP COLUMN IF EXISTS rejection_note;
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_po_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_po_status_check
  CHECK (po_status IN ('draft', 'ordered', 'partial', 'received', 'closed', 'cancelled'));

DROP TABLE IF EXISTS stock_settings;

DROP INDEX IF EXISTS idx_stock_transactions_expired_use;
ALTER TABLE inventory_batch_movements DROP COLUMN IF EXISTS after_expiry;
ALTER TABLE stock_transactions DROP CONSTRAINT IF EXISTS chk_stock_transactions_expired_quantity;
ALTER TABLE stock_transactions DROP COLUMN IF EXISTS expired_quantity;
