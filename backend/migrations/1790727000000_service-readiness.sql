-- Up Migration
ALTER TABLE products ADD COLUMN availability_schedule JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN combo_choice_groups JSONB NOT NULL DEFAULT '[]';
ALTER TABLE order_items ADD COLUMN combo_parts JSONB;
ALTER TABLE table_request_items ADD COLUMN combo_selections JSONB NOT NULL DEFAULT '[]';
ALTER TABLE bills ADD COLUMN receipt_settings JSONB;
ALTER TABLE stock_transactions ADD COLUMN average_cost_after NUMERIC(16,6);
ALTER TABLE production_batches ADD COLUMN request_key UUID,
  ADD COLUMN batch_status VARCHAR(12) NOT NULL DEFAULT 'posted',
  ADD COLUMN void_reason TEXT,
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by BIGINT REFERENCES users(id);
CREATE UNIQUE INDEX production_request_key ON production_batches(restaurant_id, request_key)
  WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX production_batch_number ON production_batches(restaurant_id, output_item_id, batch_number);

-- The legacy insert trigger snapshots the menu's cess. A composition order
-- already has GST suppressed by pricing and must also carry no cess.
CREATE FUNCTION clear_composition_order_cess() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders o JOIN restaurant_settings s ON s.restaurant_id=o.restaurant_id
             WHERE o.id=NEW.order_id AND s.document_type='bill_of_supply') THEN
    NEW.cess_percentage := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER zz_order_item_composition BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION clear_composition_order_cess();

-- Down Migration
DROP TRIGGER zz_order_item_composition ON order_items;
DROP FUNCTION clear_composition_order_cess();
DROP INDEX production_batch_number;
DROP INDEX production_request_key;
ALTER TABLE production_batches DROP COLUMN request_key, DROP COLUMN batch_status,
  DROP COLUMN void_reason, DROP COLUMN voided_at, DROP COLUMN voided_by;
ALTER TABLE stock_transactions DROP COLUMN average_cost_after;
ALTER TABLE order_items DROP COLUMN combo_parts;
ALTER TABLE table_request_items DROP COLUMN combo_selections;
ALTER TABLE bills DROP COLUMN receipt_settings;
ALTER TABLE products DROP COLUMN availability_schedule, DROP COLUMN combo_choice_groups;
