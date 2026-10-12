-- Up Migration

-- The floor plan's turn between one party and the next.
--
-- Taking the last payment closes the order and frees the table in the same
-- step, so until now a table read "ready to seat" the second its bill was
-- settled — while the last guests were still getting up and nobody had
-- cleared it. The floor plan now holds a settled table as "Cleaning" for a
-- few minutes, and whoever resets it taps "Mark ready". That tap is the only
-- thing stored here; when a table was settled is already on its orders.

-- The last time someone said this table is clean and laid. A settlement
-- after this moment starts a new turn; one before it is already dealt with.
ALTER TABLE dining_tables
  ADD COLUMN ready_at TIMESTAMPTZ,
  ADD COLUMN ready_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- One row per restaurant, written the first time a manager changes it; a
-- restaurant without a row uses the defaults.
CREATE TABLE floor_settings (
  restaurant_id     BIGINT       PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- How long a settled table stays "Cleaning" when nobody marks it ready.
  -- Ten minutes is a fine-dining reset; a udupi counter clears in two. Zero
  -- switches the hold off: a settled table is free straight away. Past the
  -- window it is assumed someone reset it and forgot to tap.
  cleaning_minutes  SMALLINT     NOT NULL DEFAULT 10 CHECK (cleaning_minutes BETWEEN 0 AND 120),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by        BIGINT       REFERENCES users(id),
  updated_by        BIGINT       REFERENCES users(id)
);

CREATE TRIGGER trg_floor_settings_updated_at
BEFORE UPDATE ON floor_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- "When was this table last settled?" is asked for every table each time the
-- floor plan refreshes. Without this it walks every completed order the
-- restaurant has ever had; with it, it reads one row per table.
CREATE INDEX idx_orders_table_settled
  ON orders (table_id, completed_at DESC)
  WHERE order_status = 'completed' AND table_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_orders_table_settled;
DROP TABLE IF EXISTS floor_settings;

ALTER TABLE dining_tables
  DROP COLUMN IF EXISTS ready_by,
  DROP COLUMN IF EXISTS ready_at;
