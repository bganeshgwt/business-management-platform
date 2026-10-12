-- Up Migration

-- The batch view (Items & stock → Batches & expiry) lists, for every batch, how
-- much a sale had to take from it after it expired (sweep SW-B-01). That
-- lookup goes from the batch to its movements, and inventory_batch_movements
-- had no index by batch: its key starts with the stock movement. On a busy
-- restaurant (8,000 batches, 14,000 movements) the list took 17-22 seconds,
-- one full scan of the movements per batch. Only the few movements marked
-- "after expiry" are ever looked up this way, so a partial index keeps it
-- small and the list answers in milliseconds.
CREATE INDEX IF NOT EXISTS inventory_batch_movements_after_expiry
  ON inventory_batch_movements (batch_id)
  WHERE after_expiry;

-- Down Migration

DROP INDEX IF EXISTS inventory_batch_movements_after_expiry;
