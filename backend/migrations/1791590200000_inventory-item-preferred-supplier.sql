-- Up Migration
-- The supplier a stock item is normally ordered from, chosen by hand (on the
-- Reorder list or the item form). The reorder plan groups an item under it
-- first, then under the supplier it was last bought from. Optional; cleared
-- when the supplier is deleted. A trigger keeps it to a supplier of the same
-- restaurant, whatever writes it.

ALTER TABLE inventory_items
  ADD COLUMN preferred_supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE INDEX idx_inventory_items_preferred_supplier
  ON inventory_items (preferred_supplier_id)
  WHERE preferred_supplier_id IS NOT NULL;

CREATE OR REPLACE FUNCTION inventory_items_preferred_supplier_same_restaurant()
RETURNS trigger AS $$
BEGIN
  IF NEW.preferred_supplier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM suppliers s
    WHERE s.id = NEW.preferred_supplier_id AND s.restaurant_id = NEW.restaurant_id
  ) THEN
    RAISE EXCEPTION 'The preferred supplier must belong to the same restaurant'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_items_preferred_supplier
  BEFORE INSERT OR UPDATE OF preferred_supplier_id, restaurant_id ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION inventory_items_preferred_supplier_same_restaurant();

COMMENT ON COLUMN inventory_items.preferred_supplier_id IS
  'Supplier this item is normally ordered from (chosen by hand); the reorder plan uses it before the last supplier bought from.';

-- Down Migration
DROP TRIGGER IF EXISTS trg_inventory_items_preferred_supplier ON inventory_items;
DROP FUNCTION IF EXISTS inventory_items_preferred_supplier_same_restaurant();
DROP INDEX IF EXISTS idx_inventory_items_preferred_supplier;
ALTER TABLE inventory_items DROP COLUMN IF EXISTS preferred_supplier_id;
