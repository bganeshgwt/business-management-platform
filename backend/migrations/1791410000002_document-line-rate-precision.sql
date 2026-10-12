-- Up Migration
-- A dispatched wholesale order bills each batch line at its share of the
-- order's amount, so the rate per stock unit is not always a whole paisa
-- (Rs 366.67 for 50 pieces is Rs 7.3334 each). Such a rate is kept to four
-- places so that rate x quantity matches the line.
--
-- The column becomes NUMERIC without a fixed scale: a value keeps the places
-- it was written with. Every rate written with two places (all existing
-- rows, every ordinary sale and purchase) still reads back with two
-- ('120.00'), so no screen, export, receipt or service sees a change; only a
-- dispatch line whose rate needs them carries four. The checks keep what the
-- old type guaranteed: at most four places and the same range.
ALTER TABLE business_document_lines ALTER COLUMN unit_price TYPE NUMERIC,
  ADD CONSTRAINT business_document_lines_unit_price_places CHECK (unit_price = round(unit_price, 4) AND unit_price < 1000000000000);

-- Down Migration
ALTER TABLE business_document_lines DROP CONSTRAINT business_document_lines_unit_price_places,
  ALTER COLUMN unit_price TYPE NUMERIC(14,2);
