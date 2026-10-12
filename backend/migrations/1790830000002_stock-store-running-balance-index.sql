-- Up Migration

-- One store's own running balance of an item, for the stock ledger when it is
-- narrowed to one store (always, for someone tied to one outlet): each row's
-- "balance after" is what that store held just after it, added up from the
-- store's own movements in the order they were written (inventory.repository
-- findMovements). The ledger's balance_after column is the whole
-- restaurant's, which on an outlet's ledger read as 14 kg on a movement at an
-- outlet holding 4. Ordered by item, store and id, with the quantity in the
-- index itself, the running total is one ordered scan per item instead of a
-- sort of every movement the item ever had.
CREATE INDEX idx_stock_transactions_item_store
  ON stock_transactions (inventory_item_id, outlet_id, id)
  INCLUDE (quantity);

-- Down Migration

DROP INDEX IF EXISTS idx_stock_transactions_item_store;
