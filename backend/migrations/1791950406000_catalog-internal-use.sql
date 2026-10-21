-- Up Migration
-- An item kept in stock only to be used up inside services (a salon's
-- back-bar colour and developer, a clinic's gloves): it is never sold on a
-- bill, and the bill screens leave it out.
ALTER TABLE catalog_skus ADD COLUMN internal_use BOOLEAN NOT NULL DEFAULT FALSE;

-- Down Migration
ALTER TABLE catalog_skus DROP COLUMN internal_use;
