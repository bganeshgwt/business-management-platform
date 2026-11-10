-- Up Migration
-- Every table has a primary key, and the columns that copy a checked value
-- are checked themselves.

-- A batch's stock at an outlet (or at the restaurant's main store, outlet
-- NULL) is already one row, unique on (batch, outlet) with NULLs counted
-- equal; a generated key makes each row addressable on its own, as
-- replication and database tools need.
ALTER TABLE inventory_batch_balances ADD COLUMN id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY;

-- The per-outlet order counters gave way to the numbering series (each
-- prefix's row in document_counters); nothing reads or writes them.
DROP TABLE outlet_order_counters;

-- Copies of checked values: a kitchen ticket line's and a guest's request
-- line's veg, non-veg or egg mark (copied from the dish, products.food_type),
-- and a kitchen change slip's order type (copied from the order,
-- orders.order_type). And a production batch's state.
ALTER TABLE kot_items ADD CONSTRAINT chk_kot_items_food_type CHECK (food_type IN ('veg', 'non_veg', 'egg'));
ALTER TABLE table_request_items ADD CONSTRAINT chk_table_request_items_food_type CHECK (food_type IN ('veg', 'non_veg', 'egg'));
ALTER TABLE kot_change_slips ADD CONSTRAINT chk_kot_change_slips_order_type CHECK (order_type IN ('dine_in', 'takeaway', 'delivery', 'qr', 'online'));
ALTER TABLE production_batches ADD CONSTRAINT chk_production_batches_status CHECK (batch_status IN ('posted', 'void'));

-- Down Migration
ALTER TABLE production_batches DROP CONSTRAINT chk_production_batches_status;
ALTER TABLE kot_change_slips DROP CONSTRAINT chk_kot_change_slips_order_type;
ALTER TABLE table_request_items DROP CONSTRAINT chk_table_request_items_food_type;
ALTER TABLE kot_items DROP CONSTRAINT chk_kot_items_food_type;
CREATE TABLE outlet_order_counters (
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id BIGINT REFERENCES outlets(id) ON DELETE CASCADE,
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_outlet_order_counters ON outlet_order_counters (restaurant_id, COALESCE(outlet_id, 0));
ALTER TABLE inventory_batch_balances DROP COLUMN id;
