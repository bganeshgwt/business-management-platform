-- Up Migration

-- The last movement written for an item, by id. Every stock movement reads it
-- (inventory.repository recordMovement takes the running average to six
-- places from it), and closing stock for today values each item at it. The
-- existing index orders an item's rows by created_at, which is when the
-- writing transaction began, not the order the rows were written in; the id
-- is. Without this the lookup would sort every movement an item ever had —
-- thousands for onions — on every sale.
CREATE INDEX idx_stock_transactions_item_latest
  ON stock_transactions (inventory_item_id, id DESC)
  WHERE average_cost_after IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_stock_transactions_item_latest;
