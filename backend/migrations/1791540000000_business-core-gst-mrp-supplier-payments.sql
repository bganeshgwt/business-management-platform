-- Up Migration
-- Business shared commerce, pro pass (7 Oct 2026):
--  1. Shelf prices: goods shops price GST-inclusive and round to the rupee by
--     default; an optional MRP on each item (never billed above it) and an
--     HSN / SAC code, both copied onto each invoice line.
--  2. A proper GST tax invoice: the buyer's GSTIN, address and the place of
--     supply are kept on the sale as it was posted.
--  3. Receiving: the supplier's own bill number and date on a purchase.
--  4. A small discount on a bill at the counter (permission sales.discount,
--     capped by business_settings.max_bill_discount_percent).
--  5. Paying a supplier against several bills at once, oldest first, with any
--     extra kept as an advance (business_supplier_payments), like a customer
--     collection.
-- Existing documents are not touched: every new column is empty on them.

-- --- 1. Shelf prices --------------------------------------------------------------

ALTER TABLE catalog_skus
  ADD COLUMN hsn_code VARCHAR(8) CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  ADD COLUMN mrp NUMERIC(14,2) CHECK (mrp IS NULL OR mrp > 0),
  -- The selling price never passes the MRP (prices before GST are checked
  -- with their GST by the API; this is the floor every mode shares).
  ADD CONSTRAINT catalog_skus_price_within_mrp CHECK (mrp IS NULL OR price <= mrp);

-- Snapshots on the invoice line: the code and MRP as they were when sold.
ALTER TABLE business_document_lines
  ADD COLUMN hsn_code VARCHAR(8),
  ADD COLUMN mrp NUMERIC(14,2);

-- Goods shops (what the shelf says is what the customer pays): new businesses
-- of these types start with prices including GST, rounded to the rupee.
CREATE OR REPLACE FUNCTION business_seed_settings(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_settings (business_id, display_name, tax_mode, rounding)
  SELECT id, name,
    CASE WHEN business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail') THEN 'inclusive' ELSE 'exclusive' END,
    CASE WHEN business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail') THEN 'nearest_rupee' ELSE 'none' END
  FROM businesses WHERE id = target
  ON CONFLICT (business_id) DO NOTHING;
$$;

-- The demo shops move too (their posted bills keep their own tax mode).
UPDATE business_settings s SET tax_mode = 'inclusive', rounding = 'nearest_rupee', updated_at = now()
FROM businesses b
WHERE b.id = s.business_id AND b.is_demo
  AND b.business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail');

-- --- 2 and 3. The document as posted --------------------------------------------------

ALTER TABLE business_documents
  -- GST state code where the supply is made: the buyer's GSTIN state, else
  -- the seller's own state (a walk-in buys in the shop).
  ADD COLUMN place_of_supply CHAR(2) CHECK (place_of_supply ~ '^[0-9]{2}$'),
  ADD COLUMN buyer_gstin CHAR(15),
  ADD COLUMN buyer_address VARCHAR(500),
  -- The supplier's own invoice number and date (purchases only).
  ADD COLUMN supplier_bill_no VARCHAR(60) CHECK (supplier_bill_no IS NULL OR btrim(supplier_bill_no) <> ''),
  ADD COLUMN supplier_bill_date DATE,
  ADD CONSTRAINT business_documents_supplier_bill_on_purchases
    CHECK (kind = 'purchase' OR (supplier_bill_no IS NULL AND supplier_bill_date IS NULL));
-- The same supplier bill cannot be received twice.
CREATE UNIQUE INDEX business_documents_supplier_bill ON business_documents(business_id, contact_id, upper(supplier_bill_no))
  WHERE supplier_bill_no IS NOT NULL;

-- --- 4. A small discount at the counter -------------------------------------------------

ALTER TABLE business_settings
  ADD COLUMN max_bill_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (max_bill_discount_percent BETWEEN 0 AND 100),
  -- A goods shop's walk-in pays the whole bill unless the owner allows
  -- unpaid bills with no customer named (off by default).
  ADD COLUMN walk_in_credit BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE retail_sale_discounts DROP CONSTRAINT retail_sale_discounts_source_check,
  ADD CONSTRAINT retail_sale_discounts_source_check CHECK (source IN ('offer', 'points', 'membership', 'package', 'manual'));

ALTER TABLE business_permissions DROP CONSTRAINT business_permissions_action_check,
  ADD CONSTRAINT business_permissions_action_check CHECK (action IN ('view', 'create', 'edit', 'approve', 'cancel', 'refund', 'export', 'print', 'discount'));
INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('sales.discount', 'sales', 'discount', 'Give a small discount on a bill (up to the business''s limit), with a reason', 36);
INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES ('manager', 'sales.discount');
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, 'sales.discount' FROM business_roles r WHERE r.template_code = 'manager' AND NOT r.full_access
ON CONFLICT DO NOTHING;

-- --- 5. Supplier payments ------------------------------------------------------------------

DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'supplier_payment' = ANY(kinds) THEN kinds := array_append(kinds, 'supplier_payment'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

CREATE FUNCTION business_contact_is_supplier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.contact_id AND kind = 'supplier') THEN
    RAISE EXCEPTION 'Choose a supplier of this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- One payment made to a supplier. The part that settles purchase receipts is
-- written as business_payments rows pointing back here; the rest is an
-- advance with the supplier.
CREATE TABLE business_supplier_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  payment_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  contact_name VARCHAR(150) NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque')),
  reference VARCHAR(100),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, payment_no),
  UNIQUE (business_id, request_key)
);
CREATE INDEX business_supplier_payments_period ON business_supplier_payments(business_id, created_at DESC);
CREATE INDEX business_supplier_payments_contact ON business_supplier_payments(business_id, contact_id);
CREATE TRIGGER business_supplier_payments_supplier BEFORE INSERT OR UPDATE OF contact_id ON business_supplier_payments
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_supplier();

CREATE FUNCTION business_supplier_payments_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A supplier payment cannot be changed or deleted once made' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_supplier_payments_fixed BEFORE UPDATE OR DELETE ON business_supplier_payments
  FOR EACH ROW EXECUTE FUNCTION business_supplier_payments_fixed();

ALTER TABLE business_payments ADD COLUMN supplier_payment_id BIGINT,
  ADD CONSTRAINT business_payments_supplier_payment_fkey FOREIGN KEY (business_id, supplier_payment_id) REFERENCES business_supplier_payments(business_id, id),
  ADD CONSTRAINT business_payments_one_source CHECK (collection_id IS NULL OR supplier_payment_id IS NULL);
CREATE INDEX business_payments_supplier_payment ON business_payments(business_id, supplier_payment_id) WHERE supplier_payment_id IS NOT NULL;

-- Money from a supplier payment settles only that supplier's receipts, and
-- never more in total than was paid.
CREATE FUNCTION business_payments_supplier_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid business_supplier_payments%ROWTYPE;
  used NUMERIC;
BEGIN
  IF NEW.supplier_payment_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO paid FROM business_supplier_payments WHERE business_id = NEW.business_id AND id = NEW.supplier_payment_id;
  IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id
                 AND kind = 'purchase' AND contact_id = paid.contact_id) THEN
    RAISE EXCEPTION 'A supplier payment can only settle receipts of the supplier it was paid to' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO used FROM business_payments WHERE business_id = NEW.business_id AND supplier_payment_id = NEW.supplier_payment_id;
  IF used > paid.amount THEN
    RAISE EXCEPTION 'Supplier payment % has only % to apply to receipts', paid.payment_no, paid.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER business_payments_supplier_rules AFTER INSERT OR UPDATE ON business_payments
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION business_payments_supplier_rules();

-- --- 6. Udhaar for every goods counter -----------------------------------------------
-- A counter that gives a named customer credit needs the screens to collect
-- it: Collections & outstanding starts on for every goods shop, and the demo
-- shops get it now.
UPDATE platform_module_business_types SET enabled_by_default = TRUE
WHERE module_code = 'receivables' AND business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail');
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, 'receivables' FROM businesses b
WHERE b.is_demo AND b.business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail')
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'sales')
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'contacts')
ON CONFLICT DO NOTHING;

-- Down Migration
UPDATE platform_module_business_types SET enabled_by_default = (business_type IN ('wholesale', 'grocery')) WHERE module_code = 'receivables';
DROP TRIGGER business_payments_supplier_rules ON business_payments;
DROP FUNCTION business_payments_supplier_rules();
DROP INDEX business_payments_supplier_payment;
ALTER TABLE business_payments DROP CONSTRAINT business_payments_one_source, DROP CONSTRAINT business_payments_supplier_payment_fkey, DROP COLUMN supplier_payment_id;
DROP TRIGGER business_supplier_payments_fixed ON business_supplier_payments;
DROP FUNCTION business_supplier_payments_fixed();
DROP TABLE business_supplier_payments;
DROP FUNCTION business_contact_is_supplier();
DELETE FROM business_number_series WHERE document_kind = 'supplier_payment';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'supplier_payment');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_role_permissions WHERE permission_code = 'sales.discount';
DELETE FROM business_role_template_permissions WHERE permission_code = 'sales.discount';
DELETE FROM business_permissions WHERE code = 'sales.discount';
ALTER TABLE business_permissions DROP CONSTRAINT business_permissions_action_check,
  ADD CONSTRAINT business_permissions_action_check CHECK (action IN ('view', 'create', 'edit', 'approve', 'cancel', 'refund', 'export', 'print'));
DELETE FROM retail_sale_discounts WHERE source = 'manual';
ALTER TABLE retail_sale_discounts DROP CONSTRAINT retail_sale_discounts_source_check,
  ADD CONSTRAINT retail_sale_discounts_source_check CHECK (source IN ('offer', 'points', 'membership', 'package'));
ALTER TABLE business_settings DROP COLUMN walk_in_credit, DROP COLUMN max_bill_discount_percent;
DROP INDEX business_documents_supplier_bill;
ALTER TABLE business_documents DROP CONSTRAINT business_documents_supplier_bill_on_purchases,
  DROP COLUMN supplier_bill_date, DROP COLUMN supplier_bill_no, DROP COLUMN buyer_address, DROP COLUMN buyer_gstin, DROP COLUMN place_of_supply;
CREATE OR REPLACE FUNCTION business_seed_settings(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_settings (business_id, display_name)
  SELECT id, name FROM businesses WHERE id = target
  ON CONFLICT (business_id) DO NOTHING;
$$;
ALTER TABLE business_document_lines DROP COLUMN mrp, DROP COLUMN hsn_code;
ALTER TABLE catalog_skus DROP CONSTRAINT catalog_skus_price_within_mrp, DROP COLUMN mrp, DROP COLUMN hsn_code;
