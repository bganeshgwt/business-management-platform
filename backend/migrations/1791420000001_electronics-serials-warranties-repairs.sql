-- Up Migration
-- Phase 2, job T3 (part 2): electronics — serial / IMEI lifecycle across
-- locations, warranty registration from the sale, and repair jobs.
--
--   electronics_models           Per serial-tracked SKU: model number, whether
--                                its serials are IMEIs (checked), default
--                                warranty months and terms.
--   electronics_serial_details   A second IMEI (dual-SIM phones) and a note per unit.
--   (lifecycle)                  A unit's state — in stock where, in transit,
--                                sold to whom, back with the supplier, written
--                                off — is read from the stock ledger
--                                (business_stock_lots / _movements), never
--                                stored twice. The database refuses a serial
--                                in stock at two locations at once, a serial
--                                lot holding more than one unit, an invalid
--                                IMEI on first receipt and one number under
--                                two items.
--   electronics_warranties       A warranty registered from a sold serial line.
--   electronics_repair_jobs      Intake → status → parts and charges → delivery
--     (+ _lines, _events)        with a sale bill; stock moves only at delivery.

-- --- Modules and permissions ----------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('warranties', 'Warranties', 'Warranty registration from the sale by serial / IMEI, and lookup by IMEI or phone.', 'optional', 280),
 ('repairs', 'Repairs & service', 'Repair jobs: intake, status, parts and charges, delivery with a bill.', 'optional', 290);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('warranties', 'serials'), ('warranties', 'sales'),
 ('repairs', 'sales'), ('repairs', 'inventory');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('warranties', 'electronics', TRUE), ('warranties', 'supermarket', FALSE),
 ('repairs', 'electronics', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('warranties', 'view', 'See warranties and look them up by IMEI or phone', 280),
 ('warranties', 'create', 'Register a warranty from a sale', 281),
 ('warranties', 'cancel', 'Cancel a warranty registered by mistake', 282),
 ('warranties', 'export', 'Export warranties', 283),
 ('warranties', 'print', 'Print warranty cards', 284),
 ('repairs', 'view', 'See repair jobs', 290),
 ('repairs', 'create', 'Take in a device for repair', 291),
 ('repairs', 'edit', 'Update repair status, parts and charges', 292),
 ('repairs', 'approve', 'Deliver a repaired device and bill it', 293),
 ('repairs', 'cancel', 'Close a repair job without repair (device returned)', 294),
 ('repairs', 'export', 'Export repair jobs', 295),
 ('repairs', 'print', 'Print job cards', 296)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code IN ('warranties', 'repairs')
UNION ALL SELECT 'cashier', unnest(ARRAY['warranties.view', 'warranties.create', 'warranties.print',
                                         'repairs.view', 'repairs.create', 'repairs.approve', 'repairs.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['warranties.view', 'repairs.view', 'repairs.edit'])
UNION ALL SELECT 'accountant', code FROM business_permissions WHERE module_code IN ('warranties', 'repairs') AND action IN ('view', 'export', 'print')
UNION ALL SELECT 'viewer', code FROM business_permissions WHERE module_code IN ('warranties', 'repairs') AND action IN ('view', 'export');

INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code IN ('warranties', 'repairs')
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code IN ('warranties', 'repairs')
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Repair job numbers (RJ/2627/0001). Any later change to this CHECK must keep
-- the whole list (see the data model document).
ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check,
  ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN
    ('sale', 'purchase', 'sales_return', 'purchase_return', 'stock_transfer', 'stock_count', 'sales_order', 'collection', 'repair_job'));

-- --- Models and the serial lifecycle --------------------------------------------------------

-- An IMEI: 15 digits, the last a Luhn check digit.
CREATE FUNCTION electronics_valid_imei(code TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  total INT := 0;
  digit INT;
BEGIN
  IF code IS NULL OR code !~ '^[0-9]{15}$' THEN RETURN FALSE; END IF;
  FOR i IN 1..15 LOOP
    digit := substr(code, i, 1)::int;
    IF i % 2 = 0 THEN
      digit := digit * 2;
      IF digit > 9 THEN digit := digit - 9; END IF;
    END IF;
    total := total + digit;
  END LOOP;
  RETURN total % 10 = 0;
END $$;

CREATE TABLE electronics_models (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  model_number VARCHAR(60),
  -- imei: serials are checked as IMEIs on first receipt; serial: any text.
  serial_kind TEXT NOT NULL DEFAULT 'serial' CHECK (serial_kind IN ('imei', 'serial')),
  warranty_months SMALLINT NOT NULL DEFAULT 0 CHECK (warranty_months BETWEEN 0 AND 120),
  warranty_terms VARCHAR(1000),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);

-- Existing serial-tracked items keep their model and warranty months from
-- their attributes; their serials were never checked, so they stay 'serial'.
INSERT INTO electronics_models (business_id, sku_id, model_number, warranty_months)
SELECT s.business_id, s.id, NULLIF(left(btrim(COALESCE(s.attributes->>'model', '')), 60), ''),
  CASE WHEN COALESCE(s.attributes->>'warrantyMonths', '') ~ '^[0-9]{1,3}$' THEN LEAST((s.attributes->>'warrantyMonths')::int, 120) ELSE 0 END
FROM catalog_skus s WHERE s.tracking = 'serial';

CREATE TABLE electronics_serial_details (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  serial VARCHAR(100) NOT NULL,
  imei2 VARCHAR(15) CHECK (imei2 IS NULL OR electronics_valid_imei(imei2)),
  note VARCHAR(300),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id, serial),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE UNIQUE INDEX electronics_serial_details_imei2 ON electronics_serial_details(business_id, imei2) WHERE imei2 IS NOT NULL;
CREATE INDEX business_stock_lots_code ON business_stock_lots(business_id, lot_code) WHERE lot_code <> '';

-- A serial-numbered unit exists once: at most one unit per lot, in stock at
-- one location at a time, one number under one item, and an IMEI model's
-- number must be a valid IMEI when it is first received.
CREATE FUNCTION electronics_serial_lot_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_tracking TEXT;
  kind TEXT;
  in_stock NUMERIC;
BEGIN
  SELECT tracking INTO item_tracking FROM catalog_skus WHERE business_id = NEW.business_id AND id = NEW.sku_id;
  IF item_tracking IS DISTINCT FROM 'serial' THEN RETURN NULL; END IF;
  IF NEW.quantity > 1 THEN
    RAISE EXCEPTION 'Serial / IMEI % is one unit; it cannot be in stock twice', NEW.lot_code USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO in_stock FROM business_stock_lots
   WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id AND lot_code = NEW.lot_code;
  IF in_stock > 1 THEN
    RAISE EXCEPTION 'Serial / IMEI % is already in stock at another location', NEW.lot_code USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM business_stock_lots WHERE business_id = NEW.business_id
      AND sku_id = NEW.sku_id AND lot_code = NEW.lot_code AND id <> NEW.id) THEN
    SELECT serial_kind INTO kind FROM electronics_models WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id;
    IF kind = 'imei' AND NOT electronics_valid_imei(NEW.lot_code) THEN
      RAISE EXCEPTION 'IMEI % is not valid: an IMEI has 15 digits and its last digit is a check digit. Check the number on the box.', NEW.lot_code USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM business_stock_lots l JOIN catalog_skus s ON s.business_id = l.business_id AND s.id = l.sku_id
               WHERE l.business_id = NEW.business_id AND l.lot_code = NEW.lot_code AND l.sku_id <> NEW.sku_id AND s.tracking = 'serial') THEN
      RAISE EXCEPTION 'Serial / IMEI % is already recorded under another item', NEW.lot_code USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER electronics_serial_lot_rules AFTER INSERT OR UPDATE OF quantity, lot_code ON business_stock_lots
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION electronics_serial_lot_rules();

-- --- Warranties -----------------------------------------------------------------------------

CREATE TABLE electronics_warranties (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  -- Snapshots: the sold unit and the item as it was sold.
  serial VARCHAR(100) NOT NULL CHECK (btrim(serial) <> ''),
  item_label VARCHAR(150) NOT NULL,
  contact_id BIGINT,
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_phone VARCHAR(30) NOT NULL,
  -- The last ten digits of the phone, for lookup however it was typed.
  phone_digits VARCHAR(10) NOT NULL CHECK (phone_digits ~ '^[0-9]{6,10}$'),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  months SMALLINT NOT NULL CHECK (months BETWEEN 1 AND 120),
  terms VARCHAR(1000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancel_reason VARCHAR(300),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (ends_on = (starts_on + make_interval(months => months) - interval '1 day')::date),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
);
-- One live warranty per sold unit.
CREATE UNIQUE INDEX electronics_warranties_one_per_line ON electronics_warranties(business_id, line_id) WHERE status = 'active';
CREATE INDEX electronics_warranties_serial ON electronics_warranties(business_id, serial);
CREATE INDEX electronics_warranties_phone ON electronics_warranties(business_id, phone_digits);
CREATE INDEX electronics_warranties_period ON electronics_warranties(business_id, created_at DESC);

-- The line must be that sale's line for that item and serial. Once
-- registered only the cancellation may be written, once.
CREATE FUNCTION electronics_warranties_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A warranty cannot be deleted; cancel it with a reason' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'active' OR NEW.status <> 'cancelled'
       OR (to_jsonb(NEW) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'created_at'])
          <> (to_jsonb(OLD) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'created_at']) THEN
      RAISE EXCEPTION 'A registered warranty can only be cancelled' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
                 WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id
                   AND d.kind = 'sale' AND l.sku_id = NEW.sku_id AND l.lot_code = NEW.serial) THEN
    RAISE EXCEPTION 'A warranty must match the sold line, item and serial number' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER electronics_warranties_rules BEFORE INSERT OR UPDATE OR DELETE ON electronics_warranties
  FOR EACH ROW EXECUTE FUNCTION electronics_warranties_rules();

-- --- Repair jobs ----------------------------------------------------------------------------

CREATE TABLE electronics_repair_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  job_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT,
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_phone VARCHAR(30) NOT NULL,
  phone_digits VARCHAR(10) NOT NULL CHECK (phone_digits ~ '^[0-9]{6,10}$'),
  -- The device: an item from the catalogue when it is one, always a description.
  sku_id BIGINT,
  device VARCHAR(150) NOT NULL CHECK (btrim(device) <> ''),
  serial VARCHAR(100),
  warranty_id BIGINT,
  under_warranty BOOLEAN NOT NULL DEFAULT FALSE,
  problem VARCHAR(1000) NOT NULL CHECK (btrim(problem) <> ''),
  accessories VARCHAR(300),
  condition_notes VARCHAR(500),
  estimate NUMERIC(16,2) CHECK (estimate >= 0),
  promised_on DATE,
  technician VARCHAR(100),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'diagnosing', 'waiting_parts', 'in_repair', 'ready', 'delivered', 'cancelled')),
  -- The bill posted at delivery (none when nothing was charged or fitted).
  document_id BIGINT,
  delivered_at TIMESTAMPTZ,
  closed_reason VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  delivery_key UUID,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, warranty_id) REFERENCES electronics_warranties(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, job_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  CHECK (document_id IS NULL OR status = 'delivered'),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL AND delivery_key IS NOT NULL)),
  CHECK (status <> 'cancelled' OR closed_reason IS NOT NULL),
  CHECK (NOT under_warranty OR warranty_id IS NOT NULL)
);
CREATE INDEX electronics_repair_jobs_period ON electronics_repair_jobs(business_id, created_at DESC);
CREATE INDEX electronics_repair_jobs_open ON electronics_repair_jobs(business_id, status) WHERE status NOT IN ('delivered', 'cancelled');
CREATE INDEX electronics_repair_jobs_lookup ON electronics_repair_jobs(business_id, phone_digits);
CREATE INDEX electronics_repair_jobs_serial ON electronics_repair_jobs(business_id, serial) WHERE serial IS NOT NULL;

-- Parts fitted (goods from stock) and labour (service items), at the price
-- the customer will be charged. Stock moves only when the job is delivered
-- and these lines become the bill.
CREATE TABLE electronics_repair_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  job_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('part', 'labour')),
  sku_id BIGINT NOT NULL,
  lot_code VARCHAR(100) NOT NULL DEFAULT '',
  label VARCHAR(150) NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_id) REFERENCES electronics_repair_jobs(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id)
);
CREATE INDEX electronics_repair_lines_job ON electronics_repair_lines(business_id, job_id);

CREATE TABLE electronics_repair_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  job_id BIGINT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_id) REFERENCES electronics_repair_jobs(business_id, id)
);
CREATE INDEX electronics_repair_events_job ON electronics_repair_events(business_id, job_id, id);

-- A delivered or cancelled job is closed: neither it nor its lines change.
CREATE FUNCTION electronics_repair_jobs_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A repair job cannot be deleted; cancel it with a reason' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') AND (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Repair job % is closed and cannot change', OLD.job_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER electronics_repair_jobs_closed BEFORE UPDATE OR DELETE ON electronics_repair_jobs
  FOR EACH ROW EXECUTE FUNCTION electronics_repair_jobs_closed();

CREATE FUNCTION electronics_repair_lines_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_job BIGINT := CASE WHEN TG_OP = 'DELETE' THEN OLD.job_id ELSE NEW.job_id END;
  row_business BIGINT := CASE WHEN TG_OP = 'DELETE' THEN OLD.business_id ELSE NEW.business_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM electronics_repair_jobs WHERE business_id = row_business AND id = row_job AND status IN ('delivered', 'cancelled')) THEN
    RAISE EXCEPTION 'This repair job is closed; its parts and charges cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER electronics_repair_lines_open BEFORE INSERT OR UPDATE OR DELETE ON electronics_repair_lines
  FOR EACH ROW EXECUTE FUNCTION electronics_repair_lines_open();

CREATE FUNCTION electronics_repair_events_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Repair history cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER electronics_repair_events_fixed BEFORE UPDATE OR DELETE ON electronics_repair_events
  FOR EACH ROW EXECUTE FUNCTION electronics_repair_events_fixed();

-- Down Migration
DROP TRIGGER electronics_repair_events_fixed ON electronics_repair_events;
DROP FUNCTION electronics_repair_events_fixed();
DROP TRIGGER electronics_repair_lines_open ON electronics_repair_lines;
DROP FUNCTION electronics_repair_lines_open();
DROP TRIGGER electronics_repair_jobs_closed ON electronics_repair_jobs;
DROP FUNCTION electronics_repair_jobs_closed();
DROP TABLE electronics_repair_events, electronics_repair_lines, electronics_repair_jobs;
DROP TRIGGER electronics_warranties_rules ON electronics_warranties;
DROP FUNCTION electronics_warranties_rules();
DROP TABLE electronics_warranties;
DROP TRIGGER electronics_serial_lot_rules ON business_stock_lots;
DROP FUNCTION electronics_serial_lot_rules();
DROP INDEX business_stock_lots_code;
DROP TABLE electronics_serial_details;
DROP TABLE electronics_models;
DROP FUNCTION electronics_valid_imei(TEXT);
-- Refuses (as it should) while repair-job number series exist.
ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check,
  ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN
    ('sale', 'purchase', 'sales_return', 'purchase_return', 'stock_transfer', 'stock_count', 'sales_order', 'collection'));
DELETE FROM business_capabilities WHERE capability IN ('warranties', 'repairs');
DELETE FROM business_role_permissions WHERE permission_code LIKE 'warranties.%' OR permission_code LIKE 'repairs.%';
DELETE FROM business_role_template_permissions WHERE permission_code LIKE 'warranties.%' OR permission_code LIKE 'repairs.%';
DELETE FROM business_permissions WHERE module_code IN ('warranties', 'repairs');
DELETE FROM platform_module_business_types WHERE module_code IN ('warranties', 'repairs');
DELETE FROM platform_module_dependencies WHERE module_code IN ('warranties', 'repairs');
DELETE FROM platform_modules WHERE code IN ('warranties', 'repairs');
