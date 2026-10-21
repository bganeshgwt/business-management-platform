-- Up Migration
-- A supplier's bill line as printed: free goods on a scheme ("10 + 1 free")
-- and a trade discount on the rate. The line's quantity includes the free
-- units; its net is what was charged (paid units at the rate, less the
-- discount), so the stock cost of every unit received is net / quantity.
ALTER TABLE business_document_lines
  ADD COLUMN free_quantity NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (free_quantity >= 0),
  ADD COLUMN discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent < 100),
  ADD CONSTRAINT business_document_lines_free_below_quantity CHECK (free_quantity < quantity);

-- Down Migration
ALTER TABLE business_document_lines
  DROP CONSTRAINT business_document_lines_free_below_quantity,
  DROP COLUMN discount_percent,
  DROP COLUMN free_quantity;
