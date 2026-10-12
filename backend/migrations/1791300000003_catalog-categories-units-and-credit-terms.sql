-- Up Migration
-- Shared core: a category tree, units with conversions, pack sizes per SKU,
-- and credit terms on customers and suppliers.

-- Categories: a tree per business. parent_id points inside the same business
-- through the composite key; a trigger refuses loops and trees deeper than
-- five levels (deeper than any shop needs, shallow enough to show).
CREATE TABLE catalog_categories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  parent_id BIGINT,
  name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, parent_id) REFERENCES catalog_categories(business_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
-- Two siblings cannot share a name ("Rice" under "Grains" once).
CREATE UNIQUE INDEX catalog_categories_sibling_name ON catalog_categories(business_id, COALESCE(parent_id, 0), lower(name));
CREATE INDEX catalog_categories_parent ON catalog_categories(business_id, parent_id);

CREATE FUNCTION catalog_categories_no_loops() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE depth INTEGER;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  WITH RECURSIVE up(id, parent_id, level) AS (
    SELECT id, parent_id, 1 FROM catalog_categories WHERE business_id = NEW.business_id AND id = NEW.parent_id
    UNION ALL
    SELECT c.id, c.parent_id, up.level + 1 FROM catalog_categories c JOIN up ON c.business_id = NEW.business_id AND c.id = up.parent_id
    WHERE up.level < 50
  )
  SELECT max(level) INTO depth FROM up;
  IF EXISTS (WITH RECURSIVE up(id, parent_id, level) AS (
      SELECT id, parent_id, 1 FROM catalog_categories WHERE business_id = NEW.business_id AND id = NEW.parent_id
      UNION ALL
      SELECT c.id, c.parent_id, up.level + 1 FROM catalog_categories c JOIN up ON c.business_id = NEW.business_id AND c.id = up.parent_id
      WHERE up.level < 50)
    SELECT 1 FROM up WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'A category cannot be placed inside itself' USING ERRCODE = '23514';
  END IF;
  -- The new row sits one level below its parent; children it already has
  -- (on a move) are checked by the depth of its own subtree.
  IF depth + 1 + COALESCE((WITH RECURSIVE down(id, level) AS (
      SELECT id, 1 FROM catalog_categories WHERE business_id = NEW.business_id AND parent_id = NEW.id
      UNION ALL SELECT c.id, down.level + 1 FROM catalog_categories c JOIN down ON c.business_id = NEW.business_id AND c.parent_id = down.id
      WHERE down.level < 50)
    SELECT max(level) FROM down), 0) > 5 THEN
    RAISE EXCEPTION 'Categories can be at most five levels deep' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_categories_no_loops BEFORE INSERT OR UPDATE OF parent_id ON catalog_categories
  FOR EACH ROW EXECUTE FUNCTION catalog_categories_no_loops();

-- Products point at a category. The free-text category column stays,
-- readable, for products created before this migration; each distinct text
-- becomes a top-level category and the product is linked to it.
ALTER TABLE catalog_products ADD COLUMN category_id BIGINT,
  ADD CONSTRAINT catalog_products_category_fkey FOREIGN KEY (business_id, category_id) REFERENCES catalog_categories(business_id, id);
CREATE INDEX catalog_products_category ON catalog_products(business_id, category_id);
INSERT INTO catalog_categories (business_id, name)
SELECT DISTINCT ON (business_id, lower(btrim(category))) business_id, btrim(category)
FROM catalog_products WHERE category IS NOT NULL AND btrim(category) <> ''
ORDER BY business_id, lower(btrim(category)), btrim(category);
UPDATE catalog_products p SET category_id = c.id
FROM catalog_categories c
WHERE c.business_id = p.business_id AND c.parent_id IS NULL AND lower(c.name) = lower(btrim(p.category));
COMMENT ON COLUMN catalog_products.category IS 'Legacy free text from before catalog_categories (1791300000003). New products use category_id; this stays readable for older ones.';

-- Units per business. A unit may convert to a base unit of the same kind
-- (g -> kg at 0.001); pack sizes that depend on the product (a strip of 10
-- tablets, a box of 24) live in catalog_sku_units below.
CREATE TABLE business_units (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  code VARCHAR(20) NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,19}$'),
  name VARCHAR(60) NOT NULL,
  -- count units take whole numbers only (decimals = 0); weight, volume and
  -- length take up to three decimals; time and service units are for services.
  kind TEXT NOT NULL CHECK (kind IN ('count', 'weight', 'volume', 'length', 'time', 'service')),
  decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 3),
  base_unit_code VARCHAR(20),
  factor_to_base NUMERIC(18,6) CHECK (factor_to_base > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, code),
  FOREIGN KEY (business_id, base_unit_code) REFERENCES business_units(business_id, code),
  CHECK ((base_unit_code IS NULL) = (factor_to_base IS NULL)),
  CHECK (base_unit_code IS NULL OR base_unit_code <> code),
  CHECK (kind <> 'count' OR decimals = 0)
);

CREATE FUNCTION business_seed_units(target BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE kind_of_business TEXT;
BEGIN
  SELECT business_type INTO kind_of_business FROM businesses WHERE id = target;
  -- Restaurants keep their own units in the restaurant module.
  IF kind_of_business IS NULL OR (kind_of_business = 'restaurant'
     AND NOT EXISTS (SELECT 1 FROM catalog_skus WHERE business_id = target)) THEN
    RETURN;
  END IF;
  -- Base units first (the conversions below point at them).
  INSERT INTO business_units (business_id, code, name, kind, decimals) VALUES
    (target, 'each', 'Each (piece)', 'count', 0), (target, 'kg', 'Kilogram', 'weight', 3),
    (target, 'litre', 'Litre', 'volume', 3), (target, 'metre', 'Metre', 'length', 3),
    (target, 'hour', 'Hour', 'time', 2), (target, 'service', 'Service', 'service', 0)
  ON CONFLICT (business_id, code) DO NOTHING;
  INSERT INTO business_units (business_id, code, name, kind, decimals, base_unit_code, factor_to_base) VALUES
    (target, 'g', 'Gram', 'weight', 3, 'kg', 0.001), (target, 'ml', 'Millilitre', 'volume', 3, 'litre', 0.001)
  ON CONFLICT (business_id, code) DO NOTHING;
  -- Packaging words the type commonly uses; how many are in one is set per product.
  INSERT INTO business_units (business_id, code, name, kind, decimals)
  SELECT target, u.code, u.name, 'count', 0
  FROM (VALUES ('pack', 'Pack'), ('box', 'Box'), ('case', 'Case'), ('dozen', 'Dozen'),
               ('strip', 'Strip'), ('tablet', 'Tablet'), ('bottle', 'Bottle'), ('pair', 'Pair')) AS u(code, name)
  WHERE (u.code IN ('pack', 'box') AND kind_of_business IN ('grocery', 'supermarket', 'wholesale', 'books', 'fashion', 'electronics', 'salon', 'pharmacy', 'meat', 'weight_retail'))
     OR (u.code = 'case' AND kind_of_business IN ('wholesale', 'supermarket'))
     OR (u.code = 'dozen' AND kind_of_business IN ('grocery', 'wholesale', 'books'))
     OR (u.code IN ('strip', 'tablet', 'bottle') AND kind_of_business = 'pharmacy')
     OR (u.code = 'pair' AND kind_of_business = 'fashion')
  ON CONFLICT (business_id, code) DO NOTHING;
END $$;
SELECT business_seed_units(id) FROM businesses;

-- A SKU's stock unit must be one of its business's units. The old fixed list
-- becomes a foreign key: every value it allowed is seeded above for every
-- business that has SKUs.
ALTER TABLE catalog_skus DROP CONSTRAINT catalog_skus_unit_check,
  ADD CONSTRAINT catalog_skus_unit_fkey FOREIGN KEY (business_id, unit) REFERENCES business_units(business_id, code);

-- Pack sizes: "1 strip = 10 tablets" for a SKU stocked in tablets. Buying or
-- selling in a pack unit is converted to the stock unit on the line.
CREATE TABLE catalog_sku_units (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  unit_code VARCHAR(20) NOT NULL,
  quantity_in_base NUMERIC(16,3) NOT NULL CHECK (quantity_in_base > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, unit_code) REFERENCES business_units(business_id, code),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku_id, unit_code)
);

-- A line entered in another unit keeps what was typed next to the stock-unit
-- quantity it became: all four or none.
ALTER TABLE business_document_lines
  ADD COLUMN entered_unit VARCHAR(20),
  ADD COLUMN entered_quantity NUMERIC(16,3) CHECK (entered_quantity > 0),
  ADD COLUMN entered_unit_price NUMERIC(14,2) CHECK (entered_unit_price >= 0),
  ADD COLUMN unit_factor NUMERIC(18,6) CHECK (unit_factor > 0),
  ADD CONSTRAINT business_document_lines_entered_unit_all_or_none CHECK (
    (entered_unit IS NULL AND entered_quantity IS NULL AND entered_unit_price IS NULL AND unit_factor IS NULL) OR
    (entered_unit IS NOT NULL AND entered_quantity IS NOT NULL AND entered_unit_price IS NOT NULL AND unit_factor IS NOT NULL));

-- Credit terms. credit_limit NULL means no limit; opening_balance is what
-- was owed when the business started using the system (positive: the
-- contact owes the business; negative: the business owes the contact).
ALTER TABLE business_contacts
  ADD COLUMN gstin CHAR(15) CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN credit_limit NUMERIC(16,2) CHECK (credit_limit >= 0),
  ADD COLUMN credit_days SMALLINT NOT NULL DEFAULT 0 CHECK (credit_days BETWEEN 0 AND 365),
  ADD COLUMN opening_balance NUMERIC(16,2) NOT NULL DEFAULT 0,
  ADD COLUMN opening_balance_on DATE,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT business_contacts_opening_dated CHECK (opening_balance = 0 OR opening_balance_on IS NOT NULL);
CREATE UNIQUE INDEX business_contacts_gstin ON business_contacts(business_id, kind, gstin) WHERE gstin IS NOT NULL;

-- Down Migration
DROP INDEX business_contacts_gstin;
ALTER TABLE business_contacts DROP CONSTRAINT business_contacts_opening_dated,
  DROP COLUMN updated_at, DROP COLUMN opening_balance_on, DROP COLUMN opening_balance,
  DROP COLUMN credit_days, DROP COLUMN credit_limit, DROP COLUMN gstin;
ALTER TABLE business_document_lines DROP CONSTRAINT business_document_lines_entered_unit_all_or_none,
  DROP COLUMN unit_factor, DROP COLUMN entered_unit_price, DROP COLUMN entered_quantity, DROP COLUMN entered_unit;
DROP TABLE catalog_sku_units;
ALTER TABLE catalog_skus DROP CONSTRAINT catalog_skus_unit_fkey;
ALTER TABLE catalog_skus ADD CONSTRAINT catalog_skus_unit_check CHECK (unit IN ('each','kg','g','litre','ml','metre','hour','service'));
DROP FUNCTION business_seed_units(BIGINT);
DROP TABLE business_units;
DROP INDEX catalog_products_category;
ALTER TABLE catalog_products DROP CONSTRAINT catalog_products_category_fkey, DROP COLUMN category_id;
COMMENT ON COLUMN catalog_products.category IS NULL;
DROP TRIGGER catalog_categories_no_loops ON catalog_categories;
DROP FUNCTION catalog_categories_no_loops();
DROP TABLE catalog_categories;
