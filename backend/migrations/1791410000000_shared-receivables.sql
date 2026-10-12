-- Up Migration
-- Shared receivables: collections from customers, advances (on-account
-- money), and the module that shows outstanding balances, ageing and
-- statements. One model for retail udhaar and wholesale outstanding; see
-- docs/BUSINESS_PLATFORM_DATA_MODEL.md, "Shared receivables".

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('receivables', 'Collections & outstanding',
  'Money collected from customers against their bills, advances, outstanding balances, ageing and statements.', 'optional', 125);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('receivables', 'sales'), ('receivables', 'contacts');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT 'receivables', t, t IN ('wholesale', 'grocery')
FROM unnest(ARRAY['grocery', 'supermarket', 'wholesale', 'fashion', 'electronics', 'pharmacy', 'books',
                  'salon', 'meat', 'weight_retail', 'healthcare']) t;

INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('receivables.view', 'receivables', 'view', 'See outstanding balances, ageing, collections and statements', 36),
 ('receivables.create', 'receivables', 'create', 'Record collections from customers and apply advances to bills', 37),
 ('receivables.export', 'receivables', 'export', 'Export outstanding balances and collections', 38),
 ('receivables.print', 'receivables', 'print', 'Print collection receipts and customer statements', 39);

INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES
 ('manager', 'receivables.view'), ('manager', 'receivables.create'), ('manager', 'receivables.export'), ('manager', 'receivables.print'),
 ('cashier', 'receivables.view'), ('cashier', 'receivables.create'), ('cashier', 'receivables.print'),
 ('accountant', 'receivables.view'), ('accountant', 'receivables.create'), ('accountant', 'receivables.export'), ('accountant', 'receivables.print'),
 ('viewer', 'receivables.view'), ('viewer', 'receivables.export');

-- Every business's own copies of the template roles receive the new
-- permissions their template has (Owner roles already have everything).
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
WHERE NOT r.full_access AND tp.permission_code LIKE 'receivables.%'
ON CONFLICT DO NOTHING;

-- Existing wholesale and grocery businesses that sell to customers get the
-- module, as a new one of their type would.
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, 'receivables' FROM businesses b
WHERE b.business_type IN ('wholesale', 'grocery')
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'sales')
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'contacts')
ON CONFLICT DO NOTHING;

-- Two more numbered documents. Any later change to this CHECK must keep the
-- whole list (see the data model document).
ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check,
  ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN
    ('sale', 'purchase', 'sales_return', 'purchase_return', 'stock_transfer', 'stock_count', 'sales_order', 'collection'));

-- Cheques are common for trade collections.
ALTER TABLE business_payments DROP CONSTRAINT business_payments_method_check,
  ADD CONSTRAINT business_payments_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque'));

-- A contact used where only a customer makes sense (collections, orders,
-- beats). Shared by the receivables and wholesale tables.
CREATE FUNCTION business_contact_is_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.contact_id AND kind = 'customer') THEN
    RAISE EXCEPTION 'Choose a customer of this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- One receipt of money from a customer. The part that settles particular
-- bills is written as business_payments rows pointing back here; the rest is
-- the customer's advance (on-account credit).
CREATE TABLE business_collections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  collection_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- Snapshot: the receipt keeps the name it was issued to.
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
  UNIQUE (business_id, collection_no),
  UNIQUE (business_id, request_key)
);
CREATE INDEX business_collections_period ON business_collections(business_id, created_at DESC);
CREATE INDEX business_collections_contact ON business_collections(business_id, contact_id);
CREATE TRIGGER business_collections_customer BEFORE INSERT OR UPDATE OF contact_id ON business_collections
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A receipt is never edited or deleted once issued.
CREATE FUNCTION business_collections_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A collection receipt cannot be changed or deleted once issued' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_collections_fixed BEFORE UPDATE OR DELETE ON business_collections
  FOR EACH ROW EXECUTE FUNCTION business_collections_fixed();

ALTER TABLE business_payments ADD COLUMN collection_id BIGINT,
  ADD CONSTRAINT business_payments_collection_fkey FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id);
CREATE INDEX business_payments_collection ON business_payments(business_id, collection_id) WHERE collection_id IS NOT NULL;

-- Money from a collection may settle only that customer's sales, and never
-- more in total than was collected.
CREATE FUNCTION business_payments_collection_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt business_collections%ROWTYPE;
  used NUMERIC;
BEGIN
  IF NEW.collection_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id
                 AND kind = 'sale' AND contact_id = receipt.contact_id) THEN
    RAISE EXCEPTION 'A collection can only settle bills of the customer who paid it' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO used FROM business_payments WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id;
  IF used > receipt.amount THEN
    RAISE EXCEPTION 'Collection % has only % to apply to bills', receipt.collection_no, receipt.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER business_payments_collection_rules AFTER INSERT OR UPDATE ON business_payments
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION business_payments_collection_rules();

-- Down Migration
DROP TRIGGER business_payments_collection_rules ON business_payments;
DROP FUNCTION business_payments_collection_rules();
DROP INDEX business_payments_collection;
ALTER TABLE business_payments DROP CONSTRAINT business_payments_collection_fkey, DROP COLUMN collection_id;
DROP TRIGGER business_collections_fixed ON business_collections;
DROP FUNCTION business_collections_fixed();
DROP TABLE business_collections;
DROP FUNCTION business_contact_is_customer();
ALTER TABLE business_payments DROP CONSTRAINT business_payments_method_check,
  ADD CONSTRAINT business_payments_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank'));
ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check,
  ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN
    ('sale', 'purchase', 'sales_return', 'purchase_return', 'stock_transfer', 'stock_count'));
DELETE FROM business_capabilities WHERE capability = 'receivables';
DELETE FROM business_role_permissions WHERE permission_code LIKE 'receivables.%';
DELETE FROM business_role_template_permissions WHERE permission_code LIKE 'receivables.%';
DELETE FROM business_permissions WHERE module_code = 'receivables';
DELETE FROM platform_module_business_types WHERE module_code = 'receivables';
DELETE FROM platform_module_dependencies WHERE module_code = 'receivables';
DELETE FROM platform_modules WHERE code = 'receivables';
