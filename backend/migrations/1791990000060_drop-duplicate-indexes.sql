-- Up Migration
-- Six indexes repeat another index on the same table, column for column: each
-- one made every save write twice and kept a second copy for no read. The
-- index that stays is the one behind a unique key (or, for a bill's order,
-- the other of the two identical ones). A B-tree is read both ways, so the
-- fuel prices' unique key also serves the newest-price-first lookup.
DROP INDEX idx_bills_restaurant_number;     -- = bills_restaurant_id_bill_number_key (unique)
DROP INDEX idx_bills_order_id;              -- = idx_bills_order
DROP INDEX laundry_order_items_order;       -- = laundry_order_items_business_id_order_id_seq_key (unique)
DROP INDEX rental_returns_booking;          -- = rental_returns_business_id_booking_id_id_key (unique)
DROP INDEX fuel_prices_lookup;              -- = fuel_prices_business_id_location_id_product_id_effective_fr_key (unique)
DROP INDEX lodging_stay_guests_stay;        -- = lodging_stay_guests_business_id_stay_id_seq_key (unique)

-- Down Migration
CREATE INDEX lodging_stay_guests_stay ON lodging_stay_guests(business_id, stay_id, seq);
CREATE INDEX fuel_prices_lookup ON fuel_prices(business_id, location_id, product_id, effective_from DESC);
CREATE INDEX rental_returns_booking ON rental_returns(business_id, booking_id, id);
CREATE INDEX laundry_order_items_order ON laundry_order_items(business_id, order_id, seq);
CREATE INDEX idx_bills_order_id ON bills (order_id);
CREATE INDEX idx_bills_restaurant_number ON bills (restaurant_id, bill_number);
