-- Up Migration
-- An optical shop's own tools: eye prescriptions, spectacle orders made in
-- the shop's workshop or at an outside lab, the recall list of customers due
-- for an eye test, and power grids for contact lenses.
--
-- Prescriptions & spectacle orders (module "optical", on for type "optical"):
--   optical_prescriptions      a customer's eye prescription: the day of the
--                              test, who examined (a member of the business, or
--                              an outside prescriber with their registration
--                              number), the PD (both eyes together, or each
--                              eye), notes and the day it is valid until (a
--                              year after the test unless changed). While no
--                              spectacle order uses it, it can be corrected;
--                              once one does, it never changes and a correction
--                              is a new prescription. Never deleted.
--   optical_prescription_rows  its powers, one row per eye and vision (distance,
--                              near, intermediate): SPH and CYL in steps of
--                              0.25 D from -30 to +30, AXIS 1 to 180 with a CYL
--                              (and only then), ADD from +0.25 to +4.00 for near
--                              or intermediate, a prism with its base, and the
--                              visual acuity as written.
--   optical_orders             a spectacle order, the job card (SPO/2627/0001):
--                              a copy of the prescription as it was, each eye's
--                              fitting PD and height, where it is made (in-house,
--                              or at a lab with the lab's name and order
--                              number), the promised day, and its status from
--                              booked through the lab or workshop and the
--                              quality check to ready and delivered, or
--                              cancelled with a reason. A remake links to the
--                              delivered order it makes again, with the reason
--                              and who bears the cost; the customer pays nothing
--                              unless they do. The prices are worked out by the
--                              core at booking, exactly as a sale of the lines
--                              would be, and kept. An advance taken at booking
--                              is the customer's money on account (a numbered
--                              collection receipt). Delivery posts the bill
--                              through the core at those prices with GST at the
--                              rate of the day, and the advance pays first.
--   optical_order_lines        the frame (an item from stock, or the customer's
--                              own frame), the right and left lens (type, index,
--                              material, coatings, tint, brand: a lens item from
--                              the catalogue, or a lens described and billed on
--                              another line) and other items billed with it.
--   optical_order_events       every change of an order's status, with what was
--                              noted (a quality check passed or failed, the lab
--                              told, the customer told).
--   optical_settings           how many months after the last eye test a
--                              customer is due for another (12 until changed).
--   optical_recall_reminders   each reminder given to a customer due for a test.
-- A contact-lens product's powers are made as items of one product (Variants),
-- each keeping its power, base curve and diameter with the item's details.
-- The advance on a cancelled order is handed back from the order like a
-- repair job's (business_collection_refunds source "optical").

-- --- Module, permissions and roles ------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('optical', 'Prescriptions & spectacle orders', 'Eye prescriptions per customer with every change of power kept; spectacle orders with the prescription, frame and lenses, made in-house or at a lab, through the quality check to delivery, with an advance; the recall list of customers due for an eye test; power grids for contact lenses.', 'optional', 248);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('optical', 'catalog'), ('optical', 'contacts'), ('optical', 'sales');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('optical', 'optical', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('optical', 'view', 'See prescriptions, spectacle orders and the recall list', 490),
 ('optical', 'create', 'Record and correct prescriptions, and book spectacle orders', 491),
 ('optical', 'edit', 'Move spectacle orders through the lab and workshop, change their details and deliver them', 492),
 ('optical', 'approve', 'Pass or fail spectacles at the quality check', 493),
 ('optical', 'cancel', 'Cancel spectacle orders', 494),
 ('optical', 'print', 'Print job cards, customer slips and prescriptions', 495)
) AS p(module_code, action, name, sort_order);

-- An optometrist (or ophthalmic assistant) of an optical shop: eye tests and
-- prescriptions, and the quality check of finished spectacles; no money.
INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types) VALUES
 ('optometrist', 'Optometrist', 'Eye tests and prescriptions: sees customers, prescriptions, spectacle orders and appointments, records prescriptions and checks finished spectacles. Takes no money.', FALSE, 36, ARRAY['optical']);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'optical'
UNION ALL SELECT 'cashier', unnest(ARRAY['optical.view', 'optical.create', 'optical.edit', 'optical.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['optical.view', 'optical.edit'])
UNION ALL SELECT 'accountant', unnest(ARRAY['optical.view', 'optical.print'])
UNION ALL SELECT 'viewer', unnest(ARRAY['optical.view'])
UNION ALL SELECT 'optometrist', unnest(ARRAY['catalog.view', 'contacts.view', 'contacts.create', 'appointments.view', 'appointments.create', 'appointments.edit',
  'optical.view', 'optical.create', 'optical.approve', 'optical.print']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template"), and the new
-- role in existing optical shops.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'optical'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;
SELECT business_seed_roles(id) FROM businesses WHERE business_type = 'optical';

-- Existing optical shops get the tool a new one starts with (where what it needs is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'optical'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Spectacle orders are numbered (SPO/2627/0001). The kinds list is widened by
-- reading the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'spectacle_order' = ANY(kinds) THEN kinds := array_append(kinds, 'spectacle_order'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- The advance on a cancelled spectacle order is handed back from the order.
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical'));

-- --- Settings ------------------------------------------------------------------------------------

-- One row per shop, made when the setting is first saved.
CREATE TABLE optical_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- A customer is due for an eye test this many months after their last one.
  recall_months SMALLINT NOT NULL DEFAULT 12 CHECK (recall_months BETWEEN 1 AND 60),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Prescriptions -------------------------------------------------------------------------------

CREATE TABLE optical_prescriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  examined_on DATE NOT NULL,
  -- Who examined: a member of the business (staff), or an outside
  -- ophthalmologist or optometrist (outside) named with their registration
  -- number. The name is kept as it was.
  examiner_kind TEXT NOT NULL CHECK (examiner_kind IN ('staff', 'outside')),
  examiner_user_id BIGINT REFERENCES users(id),
  examiner_name VARCHAR(150) NOT NULL CHECK (btrim(examiner_name) <> ''),
  registration_no VARCHAR(60) CHECK (btrim(registration_no) <> ''),
  -- Pupillary distance in mm: both eyes together, or each eye from the nose.
  pd_binocular NUMERIC(4,1) CHECK (pd_binocular BETWEEN 40 AND 85),
  pd_right NUMERIC(4,1) CHECK (pd_right BETWEEN 20 AND 45),
  pd_left NUMERIC(4,1) CHECK (pd_left BETWEEN 20 AND 45),
  notes VARCHAR(500),
  valid_until DATE NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((examiner_kind = 'staff') = (examiner_user_id IS NOT NULL)),
  CHECK (examiner_kind = 'staff' OR registration_no IS NOT NULL),
  CHECK (pd_binocular IS NULL OR pd_right IS NULL),
  CHECK ((pd_right IS NULL) = (pd_left IS NULL)),
  CHECK (valid_until >= examined_on)
);
CREATE INDEX optical_prescriptions_contact ON optical_prescriptions(business_id, contact_id, examined_on DESC);
CREATE INDEX optical_prescriptions_period ON optical_prescriptions(business_id, examined_on DESC);
CREATE TRIGGER optical_prescriptions_customer BEFORE INSERT OR UPDATE OF contact_id ON optical_prescriptions
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- The powers, one row per eye and vision.
CREATE TABLE optical_prescription_rows (
  business_id BIGINT NOT NULL,
  prescription_id BIGINT NOT NULL,
  eye TEXT NOT NULL CHECK (eye IN ('right', 'left')),
  zone TEXT NOT NULL CHECK (zone IN ('distance', 'near', 'intermediate')),
  sph NUMERIC(4,2) CHECK (sph BETWEEN -30 AND 30 AND sph * 4 = trunc(sph * 4)),
  cyl NUMERIC(4,2) CHECK (cyl BETWEEN -30 AND 30 AND cyl * 4 = trunc(cyl * 4)),
  axis SMALLINT CHECK (axis BETWEEN 1 AND 180),
  add_power NUMERIC(3,2) CHECK (add_power BETWEEN 0.25 AND 4 AND add_power * 4 = trunc(add_power * 4)),
  -- Prism dioptres and the direction of the base.
  prism NUMERIC(4,2) CHECK (prism > 0 AND prism <= 20 AND prism * 4 = trunc(prism * 4)),
  prism_base TEXT CHECK (prism_base IN ('in', 'out', 'up', 'down')),
  -- Visual acuity as written (6/6, 6/9 P, N6).
  acuity VARCHAR(20) CHECK (btrim(acuity) <> ''),
  PRIMARY KEY (business_id, prescription_id, eye, zone),
  FOREIGN KEY (business_id, prescription_id) REFERENCES optical_prescriptions(business_id, id),
  CHECK (cyl IS NULL OR sph IS NOT NULL),
  CHECK ((cyl IS NOT NULL AND cyl <> 0) = (axis IS NOT NULL)),
  CHECK (zone <> 'distance' OR add_power IS NULL),
  CHECK ((prism IS NULL) = (prism_base IS NULL)),
  CHECK (sph IS NOT NULL OR add_power IS NOT NULL OR prism IS NOT NULL OR acuity IS NOT NULL)
);

-- --- Spectacle orders ----------------------------------------------------------------------------

CREATE TABLE optical_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  order_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- The customer's name and phone as they were when booked.
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_phone VARCHAR(30),
  prescription_id BIGINT NOT NULL,
  -- The prescription as it was when booked (it never changes after that).
  rx JSONB NOT NULL CHECK (jsonb_typeof(rx) = 'object'),
  -- Fitting, in mm: each eye's PD and fitting height, for the eyes being made.
  pd_right NUMERIC(4,1) CHECK (pd_right BETWEEN 20 AND 45),
  pd_left NUMERIC(4,1) CHECK (pd_left BETWEEN 20 AND 45),
  fitting_height_right NUMERIC(4,1) CHECK (fitting_height_right BETWEEN 5 AND 45),
  fitting_height_left NUMERIC(4,1) CHECK (fitting_height_left BETWEEN 5 AND 45),
  made_at TEXT NOT NULL CHECK (made_at IN ('in_house', 'lab')),
  lab_name VARCHAR(150) CHECK (btrim(lab_name) <> ''),
  lab_order_no VARCHAR(60) CHECK (btrim(lab_order_no) <> ''),
  promised_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked', 'at_lab', 'in_workshop', 'quality_check', 'ready', 'delivered', 'cancelled')),
  -- A remake: the delivered order it makes again, why, and who bears its cost.
  remake_of BIGINT,
  remake_reason TEXT CHECK (remake_reason IN ('power_change', 'non_adaptation', 'measurement', 'lab_defect', 'breakage', 'coating', 'other')),
  remake_cost_by TEXT CHECK (remake_cost_by IN ('shop', 'lab', 'customer')),
  remake_note VARCHAR(300),
  -- As the core priced the lines at booking.
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  subtotal NUMERIC(16,2) NOT NULL CHECK (subtotal >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  round_off NUMERIC(16,2) NOT NULL CHECK (round_off > -1 AND round_off < 1),
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  savings NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (savings >= 0),
  discount_amount NUMERIC(14,2) CHECK (discount_amount > 0),
  discount_percent NUMERIC(5,2) CHECK (discount_percent > 0 AND discount_percent <= 100),
  discount_reason VARCHAR(120),
  notes VARCHAR(500),
  -- The advance taken at booking (a collection receipt: the customer's money on account).
  advance_collection_id BIGINT,
  -- The quality check passed: by whom and when (the last pass).
  checked_by BIGINT REFERENCES users(id),
  checked_at TIMESTAMPTZ,
  -- The bill posted at delivery (none when nothing on the order is an item).
  document_id BIGINT,
  delivery_key UUID,
  delivered_by BIGINT REFERENCES users(id),
  delivered_at TIMESTAMPTZ,
  cancel_reason VARCHAR(300),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, prescription_id) REFERENCES optical_prescriptions(business_id, id),
  FOREIGN KEY (business_id, remake_of) REFERENCES optical_orders(business_id, id),
  FOREIGN KEY (business_id, advance_collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, advance_collection_id),
  CHECK (total = subtotal + tax + round_off),
  CHECK (discount_amount IS NULL OR discount_percent IS NULL),
  CHECK ((discount_amount IS NULL AND discount_percent IS NULL) = (discount_reason IS NULL)),
  CHECK ((made_at = 'lab') = (lab_name IS NOT NULL)),
  CHECK (lab_order_no IS NULL OR made_at = 'lab'),
  CHECK ((remake_of IS NULL) = (remake_reason IS NULL)),
  CHECK ((remake_of IS NULL) = (remake_cost_by IS NULL)),
  CHECK (remake_note IS NULL OR remake_of IS NOT NULL),
  -- A remake the shop or the lab bears costs the customer nothing.
  CHECK (remake_cost_by IS NULL OR remake_cost_by = 'customer' OR total = 0),
  CHECK ((checked_by IS NULL) = (checked_at IS NULL)),
  CHECK (status NOT IN ('ready', 'delivered') OR checked_at IS NOT NULL),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_by IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivery_key IS NOT NULL)),
  CHECK (document_id IS NULL OR status = 'delivered'),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL))
);
CREATE INDEX optical_orders_period ON optical_orders(business_id, created_at DESC);
CREATE INDEX optical_orders_contact ON optical_orders(business_id, contact_id);
CREATE INDEX optical_orders_prescription ON optical_orders(business_id, prescription_id);
CREATE INDEX optical_orders_open ON optical_orders(business_id, promised_on) WHERE status NOT IN ('delivered', 'cancelled');
CREATE INDEX optical_orders_remake ON optical_orders(business_id, remake_of) WHERE remake_of IS NOT NULL;
CREATE TRIGGER optical_orders_customer BEFORE INSERT ON optical_orders
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A new order: its prescription is its customer's, and a remake makes again
-- a delivered order of the same customer.
CREATE FUNCTION optical_orders_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM optical_prescriptions WHERE business_id = NEW.business_id AND id = NEW.prescription_id AND contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'The prescription of a spectacle order is its customer''s own' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'booked' THEN
    RAISE EXCEPTION 'A spectacle order starts as booked' USING ERRCODE = '23514';
  END IF;
  IF NEW.remake_of IS NOT NULL THEN
    SELECT order_no, status, contact_id INTO original FROM optical_orders WHERE business_id = NEW.business_id AND id = NEW.remake_of;
    IF original.status IS DISTINCT FROM 'delivered' THEN
      RAISE EXCEPTION 'Spectacle order % is not delivered: only a delivered order is remade', original.order_no USING ERRCODE = '23514';
    END IF;
    IF original.contact_id <> NEW.contact_id THEN
      RAISE EXCEPTION 'A remake is for the customer of the order it remakes' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_orders_insert_check BEFORE INSERT ON optical_orders
  FOR EACH ROW EXECUTE FUNCTION optical_orders_insert_check();

-- A delivered or cancelled order never changes. An open one keeps its number,
-- customer, prescription, prices and advance, and moves one allowed step at a
-- time: booked to the lab or the workshop; the lab and the workshop to each
-- other or the quality check; the quality check to ready (passed) or back to
-- the lab or the workshop (failed); ready back to the lab or the workshop, or
-- delivered; any open order cancelled. Nothing is deleted.
CREATE FUNCTION optical_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A spectacle order is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Spectacle order % is % and can no longer change', OLD.order_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.order_no <> OLD.order_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.contact_id <> OLD.contact_id OR NEW.prescription_id <> OLD.prescription_id OR NEW.rx <> OLD.rx
     OR NEW.tax_mode <> OLD.tax_mode OR NEW.subtotal <> OLD.subtotal OR NEW.tax <> OLD.tax OR NEW.round_off <> OLD.round_off
     OR NEW.total <> OLD.total OR NEW.savings <> OLD.savings OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
     OR NEW.discount_percent IS DISTINCT FROM OLD.discount_percent OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason
     OR NEW.remake_of IS DISTINCT FROM OLD.remake_of OR NEW.remake_reason IS DISTINCT FROM OLD.remake_reason
     OR NEW.remake_cost_by IS DISTINCT FROM OLD.remake_cost_by OR NEW.advance_collection_id IS DISTINCT FROM OLD.advance_collection_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A spectacle order keeps its number, customer, prescription, prices and advance' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'booked' AND NEW.status IN ('at_lab', 'in_workshop', 'cancelled'))
    OR (OLD.status = 'at_lab' AND NEW.status IN ('in_workshop', 'quality_check', 'cancelled'))
    OR (OLD.status = 'in_workshop' AND NEW.status IN ('at_lab', 'quality_check', 'cancelled'))
    OR (OLD.status = 'quality_check' AND NEW.status IN ('ready', 'at_lab', 'in_workshop', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('at_lab', 'in_workshop', 'delivered', 'cancelled'))) THEN
    RAISE EXCEPTION 'Spectacle order % cannot go from % to %', OLD.order_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  -- Ready only after passing the quality check, which is then stamped.
  IF NEW.status = 'ready' AND OLD.status <> 'ready' AND (NEW.checked_at IS NOT DISTINCT FROM OLD.checked_at) THEN
    RAISE EXCEPTION 'Spectacle order % is ready only once it passes the quality check', OLD.order_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_orders_guard BEFORE UPDATE OR DELETE ON optical_orders
  FOR EACH ROW EXECUTE FUNCTION optical_orders_guard();

-- The order's lines as booked. An item line keeps the core's figures for it
-- (as a sale line keeps them): the stock-unit quantity and rate, the line at
-- its price, what offers and the discount took off, the taxable value and
-- GST, and the pack it was entered in.
CREATE TABLE optical_order_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  part TEXT NOT NULL CHECK (part IN ('frame', 'lens', 'item')),
  eye TEXT CHECK (eye IN ('right', 'left')),
  -- The item billed: none for the customer's own frame, or a lens billed on another line.
  sku_id BIGINT,
  own_frame BOOLEAN NOT NULL DEFAULT FALSE,
  description VARCHAR(200) CHECK (btrim(description) <> ''),
  -- A lens: its type, index, material, coatings, tint and brand.
  lens_type TEXT CHECK (lens_type IN ('single_vision', 'bifocal', 'progressive')),
  lens_index NUMERIC(3,2) CHECK (lens_index BETWEEN 1.40 AND 2.00),
  material TEXT CHECK (material IN ('cr39', 'polycarbonate', 'trivex', 'glass', 'other')),
  coatings TEXT[] NOT NULL DEFAULT '{}'
    CHECK (coatings <@ ARRAY['anti_reflective', 'blue_cut', 'uv', 'photochromic', 'scratch_resistant']::TEXT[]),
  tint VARCHAR(60) CHECK (btrim(tint) <> ''),
  brand VARCHAR(100) CHECK (btrim(brand) <> ''),
  label VARCHAR(150),
  unit VARCHAR(20),
  quantity NUMERIC(16,3) CHECK (quantity > 0),
  unit_price NUMERIC(16,4) CHECK (unit_price >= 0),
  amount NUMERIC(16,2) CHECK (amount >= 0),
  discount NUMERIC(16,2) CHECK (discount >= 0),
  tax_rate NUMERIC(5,2) CHECK (tax_rate BETWEEN 0 AND 100),
  net NUMERIC(16,2) CHECK (net >= 0),
  tax NUMERIC(16,2) CHECK (tax >= 0),
  price_rule_id BIGINT,
  entered_unit VARCHAR(20),
  entered_quantity NUMERIC(16,3) CHECK (entered_quantity > 0),
  entered_unit_price NUMERIC(14,2) CHECK (entered_unit_price >= 0),
  unit_factor NUMERIC(18,6) CHECK (unit_factor > 0),
  hsn_code VARCHAR(8),
  mrp NUMERIC(14,2),
  offers JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(offers) = 'array'),
  FOREIGN KEY (business_id, order_id) REFERENCES optical_orders(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, unit) REFERENCES business_units(business_id, code),
  FOREIGN KEY (business_id, price_rule_id) REFERENCES business_price_rules(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((part = 'lens') = (eye IS NOT NULL)),
  CHECK ((part = 'lens') = (lens_type IS NOT NULL)),
  CHECK (part = 'lens' OR (lens_index IS NULL AND material IS NULL AND coatings = '{}' AND tint IS NULL AND brand IS NULL)),
  CHECK (NOT own_frame OR (part = 'frame' AND sku_id IS NULL AND description IS NOT NULL)),
  CHECK (part <> 'frame' OR own_frame OR sku_id IS NOT NULL),
  CHECK (part <> 'item' OR sku_id IS NOT NULL),
  CONSTRAINT optical_order_lines_priced_with_item CHECK (
    (sku_id IS NULL AND label IS NULL AND unit IS NULL AND quantity IS NULL AND unit_price IS NULL AND amount IS NULL
      AND discount IS NULL AND tax_rate IS NULL AND net IS NULL AND tax IS NULL AND price_rule_id IS NULL AND entered_unit IS NULL)
    OR (sku_id IS NOT NULL AND label IS NOT NULL AND unit IS NOT NULL AND quantity IS NOT NULL AND unit_price IS NOT NULL AND amount IS NOT NULL
      AND discount IS NOT NULL AND tax_rate IS NOT NULL AND net IS NOT NULL AND tax IS NOT NULL)),
  CHECK (discount IS NULL OR discount <= amount),
  CONSTRAINT optical_order_lines_entered_all_or_none CHECK (
    (entered_unit IS NULL AND entered_quantity IS NULL AND entered_unit_price IS NULL AND unit_factor IS NULL) OR
    (entered_unit IS NOT NULL AND entered_quantity IS NOT NULL AND entered_unit_price IS NOT NULL AND unit_factor IS NOT NULL))
);
CREATE INDEX optical_order_lines_order ON optical_order_lines(business_id, order_id);
CREATE UNIQUE INDEX optical_order_lines_one_frame ON optical_order_lines(business_id, order_id) WHERE part = 'frame';
CREATE UNIQUE INDEX optical_order_lines_one_lens_an_eye ON optical_order_lines(business_id, order_id, eye) WHERE part = 'lens';

-- A line is written with its order (while booked) and never changes.
CREATE FUNCTION optical_order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A spectacle order''s lines are kept as they were booked' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO state FROM optical_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF state IS DISTINCT FROM 'booked' THEN
    RAISE EXCEPTION 'Lines go on a spectacle order when it is booked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON optical_order_lines
  FOR EACH ROW EXECUTE FUNCTION optical_order_lines_guard();

-- Every change of status (or a note with none), as it was made.
CREATE TABLE optical_order_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES optical_orders(business_id, id)
);
CREATE INDEX optical_order_events_order ON optical_order_events(business_id, order_id, id);

-- A reminder given to a customer due for an eye test, and how.
CREATE TABLE optical_recall_reminders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'call', 'sms')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id)
);
CREATE INDEX optical_recall_reminders_contact ON optical_recall_reminders(business_id, contact_id, created_at DESC);
CREATE TRIGGER optical_recall_reminders_customer BEFORE INSERT ON optical_recall_reminders
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- History is kept as it was written.
CREATE FUNCTION optical_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'optical_order_events' THEN
    RAISE EXCEPTION 'A spectacle order''s history is kept as it was written' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A recall reminder is kept as it was given' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER optical_order_events_append_only BEFORE UPDATE OR DELETE ON optical_order_events
  FOR EACH ROW EXECUTE FUNCTION optical_append_only();
CREATE TRIGGER optical_recall_reminders_append_only BEFORE UPDATE OR DELETE ON optical_recall_reminders
  FOR EACH ROW EXECUTE FUNCTION optical_append_only();

-- A prescription is never deleted. While no spectacle order uses it, it can
-- be corrected (its customer too); once one does, it and its powers never
-- change: a correction is a new prescription.
CREATE FUNCTION optical_prescriptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE used TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A prescription is never deleted' USING ERRCODE = '23514';
  END IF;
  SELECT order_no INTO used FROM optical_orders WHERE business_id = OLD.business_id AND prescription_id = OLD.id ORDER BY id LIMIT 1;
  IF used IS NOT NULL THEN
    RAISE EXCEPTION 'This prescription is on spectacle order % and no longer changes: record a new prescription to correct it', used USING ERRCODE = '23514';
  END IF;
  IF NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A prescription keeps who recorded it and when' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_prescriptions_guard BEFORE UPDATE OR DELETE ON optical_prescriptions
  FOR EACH ROW EXECUTE FUNCTION optical_prescriptions_guard();

CREATE FUNCTION optical_prescription_rows_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target BIGINT; owner BIGINT; used TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD.prescription_id; owner := OLD.business_id;
  ELSE target := NEW.prescription_id; owner := NEW.business_id; END IF;
  SELECT order_no INTO used FROM optical_orders WHERE business_id = owner AND prescription_id = target ORDER BY id LIMIT 1;
  IF used IS NOT NULL THEN
    RAISE EXCEPTION 'The powers of a prescription on spectacle order % never change: record a new prescription to correct them', used USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_prescription_rows_guard BEFORE INSERT OR UPDATE OR DELETE ON optical_prescription_rows
  FOR EACH ROW EXECUTE FUNCTION optical_prescription_rows_guard();

-- Down Migration
DROP TABLE optical_recall_reminders, optical_order_events, optical_order_lines, optical_orders, optical_prescription_rows, optical_prescriptions, optical_settings;
DROP FUNCTION optical_prescription_rows_guard();
DROP FUNCTION optical_prescriptions_guard();
DROP FUNCTION optical_append_only();
DROP FUNCTION optical_order_lines_guard();
DROP FUNCTION optical_orders_guard();
DROP FUNCTION optical_orders_insert_check();
-- Refuses while an advance has been handed back from a spectacle order (restore a backup instead).
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair'));
DELETE FROM business_number_series WHERE document_kind = 'spectacle_order';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'spectacle_order');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_role_permissions WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'optometrist');
UPDATE business_memberships m SET role_id = (SELECT r2.id FROM business_roles r2 WHERE r2.business_id = m.business_id AND r2.template_code = 'viewer')
  WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'optometrist');
DELETE FROM business_roles WHERE template_code = 'optometrist';
DELETE FROM business_role_template_permissions WHERE template_code = 'optometrist';
DELETE FROM business_role_templates WHERE code = 'optometrist';
DELETE FROM business_capabilities WHERE capability = 'optical';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'optical');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'optical');
DELETE FROM business_permissions WHERE module_code = 'optical';
DELETE FROM platform_module_business_types WHERE module_code = 'optical';
DELETE FROM platform_module_dependencies WHERE module_code = 'optical';
DELETE FROM platform_modules WHERE code = 'optical';
