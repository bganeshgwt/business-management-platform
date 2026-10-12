-- Up Migration
CREATE TABLE inventory_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id),
  inventory_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  batch_number VARCHAR(100),
  expiry_date DATE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE inventory_batch_balances (
  batch_id BIGINT NOT NULL REFERENCES inventory_batches(id),
  outlet_id BIGINT REFERENCES outlets(id),
  quantity NUMERIC(18,6) NOT NULL,
  UNIQUE NULLS NOT DISTINCT (batch_id,outlet_id)
);
CREATE TABLE inventory_batch_movements (
  stock_transaction_id BIGINT NOT NULL REFERENCES stock_transactions(id),
  batch_id BIGINT NOT NULL REFERENCES inventory_batches(id),
  quantity NUMERIC(18,6) NOT NULL,
  PRIMARY KEY(stock_transaction_id,batch_id)
);
CREATE INDEX inventory_batches_item ON inventory_batches(restaurant_id,inventory_item_id);
-- Old stock has no known expiry. Preserve it explicitly, without inventing dates.
DO $$ DECLARE item RECORD; batch BIGINT; BEGIN
  FOR item IN SELECT DISTINCT restaurant_id,inventory_item_id FROM stock_balances LOOP
    INSERT INTO inventory_batches(restaurant_id,inventory_item_id)
    VALUES(item.restaurant_id,item.inventory_item_id) RETURNING id INTO batch;
    INSERT INTO inventory_batch_balances(batch_id,outlet_id,quantity)
    SELECT batch,outlet_id,quantity FROM stock_balances WHERE inventory_item_id=item.inventory_item_id;
  END LOOP;
END $$;

-- Down Migration
DROP TABLE inventory_batch_movements;
DROP TABLE inventory_batch_balances;
DROP TABLE inventory_batches;
