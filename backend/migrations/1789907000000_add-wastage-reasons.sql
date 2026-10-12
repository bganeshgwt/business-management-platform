-- Up Migration

-- === Why stock was thrown away, and on which trading day ===
-- Wastage was already a movement type, but all it could say was "wastage" and
-- a line of free text. A kitchen cannot bring waste down without knowing what
-- kind it is: spoiled cream is a storage problem, over-prepped rice is a
-- forecasting problem, a returned dish is a quality problem. Each needs a
-- different fix, so the reason is a fixed list that can be added up.
--
-- Both columns are only ever filled on wastage rows. Every other movement
-- leaves them empty, so nothing that writes stock today has to change.
ALTER TABLE stock_transactions
  ADD COLUMN waste_reason VARCHAR(20)
    CONSTRAINT chk_stock_transactions_waste_reason CHECK (
      waste_reason IS NULL OR waste_reason IN (
        'spoiled', 'expired', 'overcooked', 'dropped', 'returned', 'over_prepped', 'other'
      )
    ),
  -- The business day the waste belongs to — not the calendar date of the
  -- timestamp. The cream binned at 00:40 when the kitchen closes belongs to the
  -- day that is still open, the same way that night's bills do. Stored rather
  -- than worked out, so a date-range report is an index lookup.
  ADD COLUMN waste_date DATE,
  ADD CONSTRAINT chk_stock_transactions_waste_only CHECK (
    (waste_reason IS NULL AND waste_date IS NULL) OR transaction_type = 'wastage'
  );

-- Wastage recorded before this migration is dated by its own timestamp, on the
-- restaurant's clock. Its reason stays empty: the old free text is still on the
-- row, and guessing a category from it would put words in someone's mouth.
UPDATE stock_transactions st
SET waste_date = (st.created_at AT TIME ZONE COALESCE(rs.timezone, 'Asia/Kolkata'))::date
FROM restaurants r
LEFT JOIN restaurant_settings rs ON rs.restaurant_id = r.id
WHERE r.id = st.restaurant_id
  AND st.transaction_type = 'wastage';

-- Wastage can be written from more than one screen (Items & stock has a
-- "Stock out" with a wastage type). Filling the date here means every path
-- dates it the same way, without each one having to remember to.
CREATE FUNCTION set_waste_date() RETURNS trigger AS $$
BEGIN
  IF NEW.transaction_type = 'wastage' AND NEW.waste_date IS NULL THEN
    SELECT bd.business_date INTO NEW.waste_date
    FROM business_days bd
    WHERE bd.restaurant_id = NEW.restaurant_id AND bd.day_status = 'open'
    ORDER BY bd.opened_at
    LIMIT 1;

    -- No day open: the restaurant's own calendar date.
    IF NEW.waste_date IS NULL THEN
      SELECT (COALESCE(NEW.created_at, NOW()) AT TIME ZONE COALESCE(rs.timezone, 'Asia/Kolkata'))::date
      INTO NEW.waste_date
      FROM restaurants r
      LEFT JOIN restaurant_settings rs ON rs.restaurant_id = r.id
      WHERE r.id = NEW.restaurant_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_transactions_waste_date
BEFORE INSERT ON stock_transactions
FOR EACH ROW EXECUTE FUNCTION set_waste_date();

-- Every wastage row now has its day, so the reports can rely on it.
ALTER TABLE stock_transactions
  ADD CONSTRAINT chk_stock_transactions_waste_dated CHECK (
    transaction_type <> 'wastage' OR waste_date IS NOT NULL
  );

-- The wastage screen reads one restaurant's waste over a range of days. Waste
-- is a sliver of the ledger (sales consumption is most of it), so a partial
-- index keeps that read small however many bills have gone through.
CREATE INDEX idx_stock_transactions_waste
  ON stock_transactions (restaurant_id, waste_date DESC)
  WHERE transaction_type = 'wastage';

-- A wastage entry logged by mistake is put right with an opposite adjustment
-- that points back at it. Totals leave reversed entries out, so they look up
-- "is this one reversed?" for every row they add.
CREATE INDEX idx_stock_transactions_waste_reversal
  ON stock_transactions (reference_id)
  WHERE reference_type = 'waste_reversal';

-- Reorder suggestions ask, for every item, "which supplier did we last buy it
-- from, at what price, and how much is already on order?" — a lookup by item
-- that no existing index served (the only one on this table is by order).
CREATE INDEX idx_purchase_order_items_item ON purchase_order_items (inventory_item_id);

-- === Who may log wastage ===
-- The person who bins the spoiled paneer is usually a cook, not a manager.
-- inventory.manage lets someone adjust any stock figure, which is too much to
-- hand the kitchen; this permits logging waste and nothing else.
INSERT INTO permissions (code, module, name) VALUES
  ('inventory.waste', 'inventory', 'Log kitchen wastage (spoiled, dropped, returned)');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'inventory.waste'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER', 'KITCHEN');

-- Anyone who could already record wastage through Stock out keeps being able to
-- here, including a restaurant's own custom roles.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, waste.id
FROM role_permissions rp
JOIN permissions manage ON manage.id = rp.permission_id AND manage.code = 'inventory.manage'
CROSS JOIN permissions waste
WHERE waste.code = 'inventory.waste'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'inventory.waste');
DELETE FROM permissions WHERE code = 'inventory.waste';

DROP INDEX IF EXISTS idx_purchase_order_items_item;
DROP INDEX IF EXISTS idx_stock_transactions_waste_reversal;
DROP INDEX IF EXISTS idx_stock_transactions_waste;

DROP TRIGGER IF EXISTS trg_stock_transactions_waste_date ON stock_transactions;
DROP FUNCTION IF EXISTS set_waste_date();

ALTER TABLE stock_transactions
  DROP CONSTRAINT IF EXISTS chk_stock_transactions_waste_dated,
  DROP CONSTRAINT IF EXISTS chk_stock_transactions_waste_only,
  DROP COLUMN IF EXISTS waste_date,
  DROP COLUMN IF EXISTS waste_reason;
