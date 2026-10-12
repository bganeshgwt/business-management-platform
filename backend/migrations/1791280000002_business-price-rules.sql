-- Up Migration
-- Thresholds apply to every unit on the line; the highest matching minimum
-- wins. Customer-specific thresholds precede the general price list.
CREATE TABLE business_price_rules (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL,
 sku_id BIGINT NOT NULL,
 contact_id BIGINT,
 minimum_quantity NUMERIC(16,3) NOT NULL CHECK(minimum_quantity>0),
 unit_price NUMERIC(14,2) NOT NULL CHECK(unit_price>=0),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,sku_id) REFERENCES catalog_skus(business_id,id),
 FOREIGN KEY(business_id,contact_id) REFERENCES business_contacts(business_id,id),
 UNIQUE(business_id,id)
);
CREATE UNIQUE INDEX business_price_threshold ON business_price_rules(business_id,sku_id,COALESCE(contact_id,0),minimum_quantity) WHERE active;
ALTER TABLE business_document_lines ADD COLUMN price_rule_id BIGINT;
ALTER TABLE business_document_lines ADD FOREIGN KEY(business_id,price_rule_id) REFERENCES business_price_rules(business_id,id);

-- Down Migration
ALTER TABLE business_document_lines DROP COLUMN price_rule_id;
DROP TABLE business_price_rules;
