-- Up Migration
-- Phase 2, job T3 (part 1): fashion — size × colour (× fabric) variants — and
-- exchanges (take goods back and sell replacements in one step).
--
--   fashion_variants        One row per sellable variant SKU: its size, colour
--                           and fabric as typed columns (the matrix, reports by
--                           size and colour). The SKU itself — code, barcode,
--                           price, tax, stock — is the core catalog_skus row.
--   business_exchanges      One exchange: the credit note (a core return) on
--                           the original sale, the new sale, and how the
--                           difference was settled. Shared by every type that
--                           switches on the "exchanges" module (fashion by
--                           default; electronics, supermarket, books and
--                           grocery may), hence the business_ prefix.
--   business_exchange_policies  How many days after a sale an exchange is allowed.
--
-- Money moved from the credit note to the new bill is recorded with the
-- payment / refund method 'credit_note' (no cash changes hands for it).

-- --- Module and permissions ---------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('exchanges', 'Exchanges', 'Take sold goods back and sell replacements in one step; the difference is collected or refunded.', 'optional', 270);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('exchanges', 'sales'), ('exchanges', 'inventory');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('exchanges', 'fashion', TRUE), ('exchanges', 'electronics', FALSE), ('exchanges', 'supermarket', FALSE),
 ('exchanges', 'books', FALSE), ('exchanges', 'grocery', FALSE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('exchanges', 'view', 'See exchanges', 270),
 ('exchanges', 'create', 'Exchange sold goods for other goods (refunding a difference also needs sales refunds)', 271),
 ('exchanges', 'export', 'Export exchanges', 272)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'exchanges'
UNION ALL SELECT 'cashier', unnest(ARRAY['exchanges.view', 'exchanges.create'])
UNION ALL SELECT 'accountant', unnest(ARRAY['exchanges.view', 'exchanges.export'])
UNION ALL SELECT 'viewer', unnest(ARRAY['exchanges.view', 'exchanges.export']);

INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
WHERE NOT r.full_access AND tp.permission_code LIKE 'exchanges.%'
ON CONFLICT DO NOTHING;

-- Existing fashion businesses get the module where sales and stock are on.
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'exchanges'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Money moved from a credit note to the replacement bill. Any later change to
-- these CHECKs must keep the whole list (see the data model document).
ALTER TABLE business_payments DROP CONSTRAINT business_payments_method_check,
  ADD CONSTRAINT business_payments_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque', 'credit_note'));
ALTER TABLE business_refunds DROP CONSTRAINT business_refunds_method_check,
  ADD CONSTRAINT business_refunds_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'credit_note'));

-- --- Fashion variants ------------------------------------------------------------------

-- Sizes sort the way people read them: XS, S, M, L, XL…, then numbers
-- (28, 30, 32 / shoe sizes / "2-3Y"), then anything else, free size last.
CREATE FUNCTION fashion_size_rank(size TEXT) RETURNS SMALLINT LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE
    WHEN s IN ('XXS', '2XS') THEN 10 WHEN s = 'XS' THEN 20 WHEN s = 'S' THEN 30 WHEN s = 'M' THEN 40
    WHEN s = 'L' THEN 50 WHEN s = 'XL' THEN 60 WHEN s IN ('XXL', '2XL') THEN 70 WHEN s IN ('XXXL', '3XL') THEN 80
    WHEN s = '4XL' THEN 90 WHEN s = '5XL' THEN 100
    WHEN s ~ '^[0-9]+(\.[0-9]+)?' THEN 1000 + LEAST(substring(s FROM '^[0-9]+(?:\.[0-9]+)?')::numeric, 2999) * 10
    WHEN s LIKE 'FREE%' THEN 32000
    ELSE 31000 END)::smallint
  FROM (SELECT upper(btrim(size)) AS s) x
$$;

CREATE TABLE fashion_variants (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  size VARCHAR(20) NOT NULL CHECK (btrim(size) <> ''),
  color VARCHAR(40) NOT NULL CHECK (btrim(color) <> ''),
  -- '' when the product has no fabric axis.
  fabric VARCHAR(40) NOT NULL DEFAULT '',
  size_rank SMALLINT NOT NULL DEFAULT 31000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES catalog_products(business_id, id)
);
-- One SKU per size × colour × fabric of a product (case-insensitive).
CREATE UNIQUE INDEX fashion_variants_combination ON fashion_variants(business_id, product_id, lower(size), lower(color), lower(fabric));
CREATE INDEX fashion_variants_product ON fashion_variants(business_id, product_id, size_rank);

-- The variant row must describe its own SKU's product; the rank follows the size.
CREATE FUNCTION fashion_variants_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog_skus WHERE business_id = NEW.business_id AND id = NEW.sku_id AND product_id = NEW.product_id) THEN
    RAISE EXCEPTION 'A variant must belong to its own product' USING ERRCODE = '23514';
  END IF;
  NEW.size := btrim(NEW.size); NEW.color := btrim(NEW.color); NEW.fabric := btrim(NEW.fabric);
  NEW.size_rank := fashion_size_rank(NEW.size);
  RETURN NEW;
END $$;
CREATE TRIGGER fashion_variants_rules BEFORE INSERT OR UPDATE ON fashion_variants
  FOR EACH ROW EXECUTE FUNCTION fashion_variants_rules();

-- Existing variant SKUs (size and colour already in their attributes) join the matrix.
INSERT INTO fashion_variants (business_id, sku_id, product_id, size, color, fabric)
SELECT DISTINCT ON (s.business_id, s.product_id, lower(btrim(s.attributes->>'size')), lower(btrim(s.attributes->>'color')), lower(btrim(COALESCE(s.attributes->>'fabric', ''))))
  s.business_id, s.id, s.product_id, left(btrim(s.attributes->>'size'), 20), left(btrim(s.attributes->>'color'), 40), left(btrim(COALESCE(s.attributes->>'fabric', '')), 40)
FROM catalog_skus s
WHERE btrim(COALESCE(s.attributes->>'size', '')) <> '' AND btrim(COALESCE(s.attributes->>'color', '')) <> ''
ORDER BY s.business_id, s.product_id, lower(btrim(s.attributes->>'size')), lower(btrim(s.attributes->>'color')), lower(btrim(COALESCE(s.attributes->>'fabric', ''))), s.id;

-- --- Exchanges ------------------------------------------------------------------------------

CREATE TABLE business_exchange_policies (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- NULL: no time limit.
  days_allowed SMALLINT CHECK (days_allowed BETWEEN 1 AND 365),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE business_exchanges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- Where the replacement was sold (the returned goods go back to the
  -- original sale's location, as every return does).
  location_id BIGINT NOT NULL,
  original_document_id BIGINT NOT NULL,
  return_id BIGINT NOT NULL,
  new_document_id BIGINT NOT NULL,
  contact_id BIGINT,
  -- Snapshots, in rupees: the credit note, the new bill, the part of the
  -- credit moved onto the new bill, and the money that changed hands.
  returned_value NUMERIC(16,2) NOT NULL CHECK (returned_value >= 0),
  new_value NUMERIC(16,2) NOT NULL CHECK (new_value >= 0),
  credit_applied NUMERIC(16,2) NOT NULL CHECK (credit_applied >= 0),
  collected NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (collected >= 0),
  refunded NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  -- cash/card/upi/bank: how money changed hands; on_account: a known
  -- customer's surplus credit was left on their account; NULL: nothing to settle.
  method TEXT CHECK (method IN ('cash', 'card', 'upi', 'bank', 'on_account')),
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, original_document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  FOREIGN KEY (business_id, new_document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, return_id),
  UNIQUE (business_id, new_document_id),
  CHECK (original_document_id <> new_document_id),
  CHECK (collected = 0 OR refunded = 0),
  CHECK ((collected > 0 OR refunded > 0) = COALESCE(method IN ('cash', 'card', 'upi', 'bank'), FALSE)),
  CHECK (method IS DISTINCT FROM 'on_account' OR contact_id IS NOT NULL)
);
CREATE INDEX business_exchanges_period ON business_exchanges(business_id, created_at DESC);
CREATE INDEX business_exchanges_original ON business_exchanges(business_id, original_document_id);

-- The credit note must be on the original sale, both documents must be
-- sales, and an exchange is never edited or deleted once posted (only its
-- timestamp may be corrected by the demo set-up).
CREATE FUNCTION business_exchanges_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An exchange cannot be deleted once posted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
      RAISE EXCEPTION 'An exchange cannot be changed once posted' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_returns WHERE business_id = NEW.business_id AND id = NEW.return_id AND document_id = NEW.original_document_id) THEN
    RAISE EXCEPTION 'The credit note of an exchange must be on the original sale' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM business_documents WHERE business_id = NEW.business_id AND id IN (NEW.original_document_id, NEW.new_document_id) AND kind = 'sale') <> 2 THEN
    RAISE EXCEPTION 'Only sales can be exchanged' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_exchanges_rules BEFORE INSERT OR UPDATE OR DELETE ON business_exchanges
  FOR EACH ROW EXECUTE FUNCTION business_exchanges_rules();

-- Down Migration
DROP TRIGGER business_exchanges_rules ON business_exchanges;
DROP FUNCTION business_exchanges_rules();
DROP TABLE business_exchanges;
DROP TABLE business_exchange_policies;
DROP TRIGGER fashion_variants_rules ON fashion_variants;
DROP FUNCTION fashion_variants_rules();
DROP TABLE fashion_variants;
DROP FUNCTION fashion_size_rank(TEXT);
-- Refuses (as it should) while credit-note payments or refunds exist.
ALTER TABLE business_refunds DROP CONSTRAINT business_refunds_method_check,
  ADD CONSTRAINT business_refunds_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank'));
ALTER TABLE business_payments DROP CONSTRAINT business_payments_method_check,
  ADD CONSTRAINT business_payments_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque'));
DELETE FROM business_capabilities WHERE capability = 'exchanges';
DELETE FROM business_role_permissions WHERE permission_code LIKE 'exchanges.%';
DELETE FROM business_role_template_permissions WHERE permission_code LIKE 'exchanges.%';
DELETE FROM business_permissions WHERE module_code = 'exchanges';
DELETE FROM platform_module_business_types WHERE module_code = 'exchanges';
DELETE FROM platform_module_dependencies WHERE module_code = 'exchanges';
DELETE FROM platform_modules WHERE code = 'exchanges';
