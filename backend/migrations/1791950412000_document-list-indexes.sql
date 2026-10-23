-- Up Migration
-- The bills list (Sales history, Purchases, Return at the counter) reads each
-- bill's lines, refunds and returned lines. Without these indexes every row
-- of the list scanned the whole table: a shop with 5,000 bills waited about
-- 30 seconds for its last 8.
CREATE INDEX IF NOT EXISTS business_document_lines_document ON business_document_lines (business_id, document_id);
CREATE INDEX IF NOT EXISTS business_refunds_document ON business_refunds (business_id, document_id);
CREATE INDEX IF NOT EXISTS business_return_lines_line ON business_return_lines (business_id, line_id);

-- Down Migration
DROP INDEX IF EXISTS business_return_lines_line;
DROP INDEX IF EXISTS business_refunds_document;
DROP INDEX IF EXISTS business_document_lines_document;
