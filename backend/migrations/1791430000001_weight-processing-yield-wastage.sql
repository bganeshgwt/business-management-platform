-- Up Migration
-- Phase 2, job T4 (part 2): meat, seafood and other weight-based shops.
--
-- Selling by weight is the core's own job (SKUs stocked in kg or g, three
-- decimal quantities, g <-> kg conversion on the line, the Quick bill's
-- weigh buttons and scale labels). This adds what such a shop does between
-- buying and selling:
--
--   processing  Cutting / cleaning one weighed input (a whole bird, a whole
--               fish, a crate of produce) into the cuts that are sold, with
--               the weight lost recorded as process wastage. The input leaves
--               stock and each cut enters stock as reasoned stock corrections
--               (business_stock_adjustments), so the stock ledger keeps
--               exactly one source per movement and "sum of movements = lot
--               quantity" keeps holding. The input's cost is carried by the
--               cuts in proportion to their selling value.
--   yield templates  The cuts a whole input normally gives, with expected %.
--   wastage     Daily wastage entries (trimming, spoiled, unsold, drip loss…)
--               that take the weight out of stock, valued at the lot's cost.
--
-- Tables are named weight_* (meat and other weight-based shops share them).

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('processing', 'Cutting & yield', 'Cut or clean a weighed input into the cuts that are sold, with yield, process loss and cost per usable kg.', 'optional', 205),
 ('wastage', 'Daily wastage', 'Record weight thrown away (trimming, spoiled, unsold, drip loss) with its cost; wastage reports.', 'optional', 206);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('processing', 'inventory'), ('processing', 'weight'),
 ('wastage', 'inventory');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('processing', 'meat', TRUE), ('processing', 'weight_retail', TRUE),
 ('wastage', 'meat', TRUE), ('wastage', 'weight_retail', TRUE),
 ('wastage', 'grocery', FALSE), ('wastage', 'supermarket', FALSE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('processing', 'view', 'See cutting batches, yields and yield templates', 64),
 ('processing', 'create', 'Record cutting / processing batches', 65),
 ('processing', 'edit', 'Set up yield templates', 66),
 ('processing', 'export', 'Export cutting batches and yields', 67),
 ('wastage', 'view', 'See wastage entries', 68),
 ('wastage', 'create', 'Record wastage', 69),
 ('wastage', 'export', 'Export wastage', 70)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code IN ('processing', 'wastage')
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['processing.view', 'processing.create', 'processing.export', 'wastage.view', 'wastage.create', 'wastage.export'])
UNION ALL SELECT 'cashier', unnest(ARRAY['wastage.view', 'wastage.create'])
UNION ALL SELECT 'accountant', code FROM business_permissions WHERE module_code IN ('processing', 'wastage') AND action IN ('view', 'export')
UNION ALL SELECT 'viewer', code FROM business_permissions WHERE module_code IN ('processing', 'wastage') AND action IN ('view', 'export');

INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code IN ('processing', 'wastage')
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code IN ('processing', 'wastage')
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Cutting batches are numbered (CP/2627/0001). The kinds list is widened by
-- reading the current one, so kinds other jobs added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'processing' = ANY(kinds) THEN kinds := array_append(kinds, 'processing'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- Only items stocked in a weight unit (kg, g) are cut and weighed for yield.
CREATE FUNCTION weight_sku_is_weighed(target_business BIGINT, target_sku BIGINT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM catalog_skus s JOIN business_units u ON u.business_id = s.business_id AND u.code = s.unit
    JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
    WHERE s.business_id = target_business AND s.id = target_sku AND u.kind = 'weight' AND p.kind = 'goods' AND s.tracking IN ('quantity', 'batch'));
$$;

CREATE FUNCTION weight_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted % rows cannot be deleted; record a correction instead', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Posted % rows cannot be changed; record a correction instead', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- Yield templates ----------------------------------------------------------------------

CREATE TABLE weight_yield_templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  input_sku_id BIGINT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, input_sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id)
);
CREATE FUNCTION weight_template_input_weighed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT weight_sku_is_weighed(NEW.business_id, NEW.input_sku_id) THEN
    RAISE EXCEPTION 'Choose an item stocked by weight (kg or g)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER weight_yield_templates_weighed BEFORE INSERT OR UPDATE OF input_sku_id ON weight_yield_templates
  FOR EACH ROW EXECUTE FUNCTION weight_template_input_weighed();
CREATE UNIQUE INDEX weight_yield_templates_name ON weight_yield_templates(business_id, lower(name));

CREATE TABLE weight_yield_template_outputs (
  business_id BIGINT NOT NULL,
  template_id BIGINT NOT NULL,
  output_sku_id BIGINT NOT NULL,
  expected_percent NUMERIC(5,2) NOT NULL CHECK (expected_percent > 0 AND expected_percent <= 100),
  PRIMARY KEY (business_id, template_id, output_sku_id),
  FOREIGN KEY (business_id, template_id) REFERENCES weight_yield_templates(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, output_sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE FUNCTION weight_template_output_weighed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT weight_sku_is_weighed(NEW.business_id, NEW.output_sku_id) THEN
    RAISE EXCEPTION 'Every cut must be an item stocked by weight (kg or g)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER weight_yield_template_outputs_weighed BEFORE INSERT OR UPDATE OF output_sku_id ON weight_yield_template_outputs
  FOR EACH ROW EXECUTE FUNCTION weight_template_output_weighed();
-- Expected cuts add up to at most the whole input.
CREATE FUNCTION weight_template_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COALESCE(sum(expected_percent), 0) FROM weight_yield_template_outputs
      WHERE business_id = NEW.business_id AND template_id = NEW.template_id) > 100 THEN
    RAISE EXCEPTION 'The expected cuts add up to more than 100%% of the input' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER weight_yield_template_outputs_total AFTER INSERT OR UPDATE ON weight_yield_template_outputs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION weight_template_total();

-- --- Cutting / processing batches -----------------------------------------------------------

CREATE TABLE weight_processing_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  batch_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  location_id BIGINT NOT NULL,
  template_id BIGINT,
  input_sku_id BIGINT NOT NULL,
  input_lot_id BIGINT NOT NULL,
  -- Snapshots: the input as it was cut (its own unit) and in kilograms.
  input_label VARCHAR(150) NOT NULL,
  input_unit TEXT NOT NULL,
  input_quantity NUMERIC(16,3) NOT NULL CHECK (input_quantity > 0),
  input_unit_cost NUMERIC(14,4) NOT NULL CHECK (input_unit_cost >= 0),
  input_value NUMERIC(16,2) NOT NULL CHECK (input_value >= 0),
  input_kg NUMERIC(16,3) NOT NULL CHECK (input_kg > 0),
  output_kg NUMERIC(16,3) NOT NULL CHECK (output_kg > 0),
  -- Weight lost in cutting / cleaning (bones, feathers, skin, drip).
  loss_kg NUMERIC(16,3) NOT NULL CHECK (loss_kg >= 0),
  input_adjustment_id BIGINT NOT NULL,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, template_id) REFERENCES weight_yield_templates(business_id, id),
  FOREIGN KEY (business_id, input_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, input_lot_id) REFERENCES business_stock_lots(business_id, id),
  FOREIGN KEY (business_id, input_adjustment_id) REFERENCES business_stock_adjustments(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, batch_no),
  UNIQUE (business_id, request_key),
  CHECK (output_kg + loss_kg = input_kg)
);
CREATE INDEX weight_processing_batches_period ON weight_processing_batches(business_id, created_at DESC);
CREATE TRIGGER weight_processing_batches_append_only BEFORE UPDATE OR DELETE ON weight_processing_batches
  FOR EACH ROW EXECUTE FUNCTION weight_append_only();

CREATE TABLE weight_processing_outputs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  batch_id BIGINT NOT NULL,
  output_sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  unit TEXT NOT NULL,
  lot_id BIGINT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  kg NUMERIC(16,3) NOT NULL CHECK (kg > 0),
  -- The share of the input's cost this cut carries, and per stock unit.
  cost_share NUMERIC(16,2) NOT NULL CHECK (cost_share >= 0),
  unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  expected_percent NUMERIC(5,2) CHECK (expected_percent > 0 AND expected_percent <= 100),
  adjustment_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, batch_id) REFERENCES weight_processing_batches(business_id, id),
  FOREIGN KEY (business_id, output_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, lot_id) REFERENCES business_stock_lots(business_id, id),
  FOREIGN KEY (business_id, adjustment_id) REFERENCES business_stock_adjustments(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (batch_id, output_sku_id)
);
CREATE TRIGGER weight_processing_outputs_append_only BEFORE UPDATE OR DELETE ON weight_processing_outputs
  FOR EACH ROW EXECUTE FUNCTION weight_append_only();

-- --- Daily wastage ---------------------------------------------------------------------------

CREATE TABLE weight_wastage_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  lot_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  unit TEXT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  -- kilograms when the item is weighed, NULL for counted items.
  kg NUMERIC(16,3) CHECK (kg > 0),
  reason TEXT NOT NULL CHECK (reason IN ('trimming', 'spoiled', 'unsold', 'drip_loss', 'damaged', 'other')),
  note VARCHAR(300),
  unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  value NUMERIC(16,2) NOT NULL CHECK (value >= 0),
  adjustment_id BIGINT NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, lot_id) REFERENCES business_stock_lots(business_id, id),
  FOREIGN KEY (business_id, adjustment_id) REFERENCES business_stock_adjustments(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, adjustment_id),
  CHECK (reason <> 'other' OR note IS NOT NULL)
);
CREATE INDEX weight_wastage_entries_period ON weight_wastage_entries(business_id, created_at DESC);
CREATE TRIGGER weight_wastage_entries_append_only BEFORE UPDATE OR DELETE ON weight_wastage_entries
  FOR EACH ROW EXECUTE FUNCTION weight_append_only();

-- Down Migration
DROP TABLE weight_wastage_entries, weight_processing_outputs, weight_processing_batches;
DROP TABLE weight_yield_template_outputs, weight_yield_templates;
DROP FUNCTION weight_template_total();
DROP FUNCTION weight_template_output_weighed();
DROP FUNCTION weight_template_input_weighed();
DROP FUNCTION weight_append_only();
DROP FUNCTION weight_sku_is_weighed(BIGINT, BIGINT);
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'processing');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_capabilities WHERE capability IN ('processing', 'wastage');
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('processing', 'wastage'));
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('processing', 'wastage'));
DELETE FROM business_permissions WHERE module_code IN ('processing', 'wastage');
DELETE FROM platform_module_business_types WHERE module_code IN ('processing', 'wastage');
DELETE FROM platform_module_dependencies WHERE module_code IN ('processing', 'wastage');
DELETE FROM platform_modules WHERE code IN ('processing', 'wastage');
