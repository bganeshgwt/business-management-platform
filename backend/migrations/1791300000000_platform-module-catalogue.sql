-- Up Migration
-- Platform layer: the catalogue of modules a business can use.
--
-- Until now the list of capabilities was a CHECK constraint on
-- business_capabilities and the defaults per business type lived in
-- backend/src/services/businessModules.js. Both move here, into rows, so that
-- (a) a new module is one INSERT rather than an ALTER of a constraint,
-- (b) what a module applies to and depends on is data the server and the
--     future platform admin can read, and
-- (c) a later subscription plan can point at the same module codes.
--
-- Codes keep the exact capability strings already stored, so no existing
-- business_capabilities row changes meaning.

CREATE TABLE platform_modules (
  code TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,39}$'),
  name VARCHAR(80) NOT NULL,
  description VARCHAR(400) NOT NULL,
  -- core: always on for every business (settings, access, reports, activity);
  --       never listed in business_capabilities.
  -- optional: on only when a business_capabilities row says so.
  kind TEXT NOT NULL CHECK (kind IN ('core', 'optional')),
  sort_order SMALLINT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which business types a module may be enabled for, and whether a new
-- business of that type gets it by default. Applicability is deliberately
-- wider than the default: a supermarket may switch on serial numbers, a salon
-- may switch on stock transfers, but neither starts with them.
CREATE TABLE platform_module_business_types (
  module_code TEXT NOT NULL REFERENCES platform_modules(code),
  business_type TEXT NOT NULL REFERENCES business_types(code),
  enabled_by_default BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (module_code, business_type)
);
CREATE INDEX platform_module_business_types_type ON platform_module_business_types(business_type);

-- A module that needs another to make sense (stock counts need inventory).
CREATE TABLE platform_module_dependencies (
  module_code TEXT NOT NULL REFERENCES platform_modules(code),
  requires_module_code TEXT NOT NULL REFERENCES platform_modules(code),
  PRIMARY KEY (module_code, requires_module_code),
  CHECK (module_code <> requires_module_code)
);

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('settings', 'Business settings', 'Business details, tax rates, number series and locations.', 'core', 10),
 ('access', 'Staff & access', 'Who can open this business and what each role may do.', 'core', 20),
 ('reports', 'Reports', 'Financial and operational reports for this business.', 'core', 30),
 ('audit', 'Activity log', 'Who did what, and when.', 'core', 40),
 ('catalog', 'Products & services', 'Sellable products, services, variants, categories and units.', 'optional', 100),
 ('contacts', 'Customers & suppliers', 'Customer and supplier records, credit terms and balances.', 'optional', 110),
 ('sales', 'Sales', 'Sales invoices, collections, returns and refunds.', 'optional', 120),
 ('purchasing', 'Purchases', 'Purchase receipts, supplier payments and supplier returns.', 'optional', 130),
 ('inventory', 'Stock', 'Stock on hand by location, movements and corrections.', 'optional', 140),
 ('stock_counts', 'Stock counts', 'Count sheets that turn into reasoned stock corrections.', 'optional', 150),
 ('stock_transfers', 'Stock transfers', 'Moving stock between locations, with goods in transit.', 'optional', 160),
 ('batches', 'Batches & expiry', 'Batch numbers and expiry dates on stock.', 'optional', 170),
 ('serials', 'Serial / IMEI numbers', 'One record per serial-numbered unit.', 'optional', 180),
 ('variants', 'Variants', 'Size, colour and fabric variants of one product.', 'optional', 190),
 ('weight', 'Sold by weight', 'Fractional quantities sold by kg, litre or metre.', 'optional', 200),
 ('wholesale', 'Wholesale price lists', 'Quantity slabs and customer-specific prices.', 'optional', 210),
 ('books', 'Book details', 'ISBN, author and publisher on catalogue items.', 'optional', 220),
 ('appointments', 'Appointments', 'Bookings against staff and rooms, with overlap checks.', 'optional', 230),
 ('restaurant', 'Restaurant', 'The restaurant module: menu, tables, kitchen, POS and its own reports.', 'optional', 300);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('inventory', 'catalog'), ('sales', 'catalog'),
 ('purchasing', 'inventory'), ('purchasing', 'contacts'),
 ('appointments', 'catalog'), ('appointments', 'contacts'),
 ('variants', 'catalog'), ('weight', 'catalog'), ('books', 'catalog'),
 ('serials', 'inventory'), ('batches', 'inventory'),
 ('stock_counts', 'inventory'), ('stock_transfers', 'inventory'),
 ('wholesale', 'sales'), ('wholesale', 'contacts');

-- Applicability and defaults. The defaults reproduce businessModules.js
-- exactly for the thirteen original modules; stock counts default on wherever
-- stock is kept, stock transfers where chains with several stores are usual.
WITH retail(type) AS (VALUES ('grocery'), ('supermarket'), ('wholesale'), ('fashion'), ('electronics'),
                              ('pharmacy'), ('books'), ('salon'), ('meat'), ('weight_retail')),
 rows(module_code, business_type, enabled_by_default) AS (
  SELECT 'restaurant', 'restaurant', TRUE
  UNION ALL SELECT m, t.type, TRUE FROM retail t, unnest(ARRAY['catalog', 'contacts', 'sales', 'inventory', 'purchasing', 'stock_counts']) m
  UNION ALL SELECT m, 'healthcare', m IN ('catalog', 'contacts', 'sales', 'appointments')
    FROM unnest(ARRAY['catalog', 'contacts', 'sales', 'appointments', 'inventory', 'purchasing', 'stock_counts', 'stock_transfers', 'batches']) m
  UNION ALL SELECT 'stock_transfers', t.type, t.type IN ('supermarket', 'wholesale', 'fashion', 'electronics', 'pharmacy') FROM retail t
  UNION ALL SELECT 'batches', t.type, t.type IN ('grocery', 'supermarket', 'wholesale', 'pharmacy', 'meat', 'weight_retail')
    FROM retail t WHERE t.type IN ('grocery', 'supermarket', 'wholesale', 'pharmacy', 'meat', 'weight_retail', 'salon')
  UNION ALL SELECT 'weight', t.type, t.type IN ('grocery', 'supermarket', 'fashion', 'meat', 'weight_retail')
    FROM retail t WHERE t.type IN ('grocery', 'supermarket', 'fashion', 'meat', 'weight_retail', 'wholesale')
  UNION ALL SELECT 'variants', t.type, t.type IN ('supermarket', 'fashion')
    FROM retail t WHERE t.type IN ('supermarket', 'fashion', 'electronics', 'books', 'salon')
  UNION ALL SELECT 'serials', t.type, t.type = 'electronics' FROM retail t WHERE t.type IN ('electronics', 'supermarket')
  UNION ALL SELECT 'wholesale', t.type, t.type = 'wholesale' FROM retail t WHERE t.type IN ('wholesale', 'grocery', 'supermarket', 'pharmacy')
  UNION ALL SELECT 'books', t.type, t.type = 'books' FROM retail t WHERE t.type IN ('books', 'supermarket')
  UNION ALL SELECT 'appointments', t.type, t.type = 'salon' FROM retail t WHERE t.type IN ('salon', 'electronics')
)
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT module_code, business_type, enabled_by_default FROM rows;

-- Every stored capability must be a known, optional module that applies to
-- the business's type. These rows were written only by the provisioning code
-- whose defaults are reproduced above, so this check is expected to pass; if
-- it does not, the migration stops with the offending rows named rather than
-- guessing what they should mean.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(format('business %s: %s', c.business_id, c.capability), ', ') INTO bad
  FROM business_capabilities c JOIN businesses b ON b.id = c.business_id
  WHERE NOT EXISTS (SELECT 1 FROM platform_module_business_types t
                    WHERE t.module_code = c.capability AND t.business_type = b.business_type);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Capabilities outside the module catalogue: %', bad;
  END IF;
END $$;

-- The hard-coded list becomes a foreign key to the catalogue.
ALTER TABLE business_capabilities DROP CONSTRAINT business_capabilities_capability_check;
ALTER TABLE business_capabilities
  ADD CONSTRAINT business_capabilities_module_fkey FOREIGN KEY (capability) REFERENCES platform_modules(code),
  ADD COLUMN enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN enabled_by BIGINT REFERENCES users(id);
COMMENT ON COLUMN business_capabilities.capability IS 'A platform_modules.code of kind optional. Core modules are always on and never listed.';

-- The rules a single foreign key cannot express, checked at the end of each
-- statement (so a whole default set can be inserted in one INSERT):
--   * core modules are never stored (they are always on);
--   * the module must apply to the business's type;
--   * every module it depends on must be enabled too;
--   * a module cannot be switched off while an enabled module depends on it.
CREATE FUNCTION business_capabilities_enforce() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  missing TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM platform_modules WHERE code = NEW.capability AND kind = 'core') THEN
      RAISE EXCEPTION 'Module % is always on and is not stored per business', NEW.capability USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM platform_module_business_types t JOIN businesses b ON b.business_type = t.business_type
                   WHERE b.id = NEW.business_id AND t.module_code = NEW.capability) THEN
      RAISE EXCEPTION 'Module % does not apply to this type of business', NEW.capability USING ERRCODE = '23514';
    END IF;
    SELECT string_agg(d.requires_module_code, ', ') INTO missing
    FROM platform_module_dependencies d
    WHERE d.module_code = NEW.capability
      AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = NEW.business_id AND c.capability = d.requires_module_code);
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'Module % needs % enabled first', NEW.capability, missing USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE
  SELECT string_agg(d.module_code, ', ') INTO missing
  FROM platform_module_dependencies d
  JOIN business_capabilities c ON c.business_id = OLD.business_id AND c.capability = d.module_code
  WHERE d.requires_module_code = OLD.capability;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Module % is needed by % and cannot be switched off', OLD.capability, missing USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;

CREATE CONSTRAINT TRIGGER business_capabilities_enforce
  AFTER INSERT OR DELETE ON business_capabilities
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION business_capabilities_enforce();

-- A capability row is switched on or off, never re-pointed.
CREATE FUNCTION business_capabilities_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_id <> OLD.business_id OR NEW.capability <> OLD.capability THEN
    RAISE EXCEPTION 'Switch a module off and another on instead of changing it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_capabilities_no_update BEFORE UPDATE ON business_capabilities
  FOR EACH ROW EXECUTE FUNCTION business_capabilities_no_update();

-- A business's type decides which modules, units, tax slabs and screens it
-- has. Changing it later would silently reinterpret its records (a pharmacy's
-- batches seen as a salon's), so the type is fixed once the business exists.
CREATE FUNCTION businesses_type_is_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_type <> OLD.business_type THEN
    RAISE EXCEPTION 'A business type cannot be changed after the business is created' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_type_is_fixed BEFORE UPDATE OF business_type ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_type_is_fixed();

-- Existing non-restaurant businesses that keep stock receive the two new
-- stock modules where their type has them by default, so the demos show the
-- new screens. Nothing is taken away from anyone.
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code IN ('stock_counts', 'stock_transfers')
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'inventory')
ON CONFLICT DO NOTHING;

-- Down Migration
DROP TRIGGER businesses_type_is_fixed ON businesses;
DROP FUNCTION businesses_type_is_fixed();
DELETE FROM business_capabilities WHERE capability IN ('stock_counts', 'stock_transfers');
DROP TRIGGER business_capabilities_no_update ON business_capabilities;
DROP FUNCTION business_capabilities_no_update();
DROP TRIGGER business_capabilities_enforce ON business_capabilities;
DROP FUNCTION business_capabilities_enforce();
ALTER TABLE business_capabilities DROP CONSTRAINT business_capabilities_module_fkey,
  DROP COLUMN enabled_at, DROP COLUMN enabled_by;
ALTER TABLE business_capabilities ADD CONSTRAINT business_capabilities_capability_check CHECK (capability IN
 ('catalog','inventory','purchasing','sales','contacts','appointments','variants','serials','batches','weight','wholesale','books','restaurant'));
DROP TABLE platform_module_dependencies, platform_module_business_types, platform_modules;
