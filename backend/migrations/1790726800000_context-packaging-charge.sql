-- Up Migration
ALTER TABLE product_selling_rules ADD COLUMN packaging_charge NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK(packaging_charge>=0);
-- Down Migration
ALTER TABLE product_selling_rules DROP COLUMN packaging_charge;
