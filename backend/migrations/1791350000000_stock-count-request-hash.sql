-- Up Migration
-- A stock count's request is remembered by its key AND a hash of its content,
-- like documents and transfers: the same key sent again with different content
-- (another location, another category) is a conflict, not the old count.
-- Counts started before this migration keep no hash and are matched by key only.
ALTER TABLE business_stock_counts ADD COLUMN request_hash CHAR(64);

-- Down Migration
ALTER TABLE business_stock_counts DROP COLUMN request_hash;
