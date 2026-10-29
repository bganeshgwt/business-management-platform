-- Up Migration
-- An optical shop's further tools: contact-lens prescriptions and the checks
-- at the counter, contact-lens power grids for torics, multifocals and colours
-- with replacement reminders and free trials, the workshop's steps, warranty
-- dates and warranty remakes, referring doctors, eye tests and quotations that
-- become prescriptions and orders, booked orders that can still be changed,
-- frames held for an order, several advances, and recall intervals by group.
--
--   optical_prescriptions      gains its kind (spectacles, or contact lenses),
--                              the examiner's council and how long their
--                              registration is valid, the vertex distance, the
--                              customer's age at the test, the doctor who
--                              referred them and the eye-test booking it came
--                              from. A contact-lens prescription has no PD and
--                              no vertex distance; its kind never changes.
--   optical_prescription_rows  the prism is split: horizontal (base in or out,
--                              in prism and prism_base) and vertical (base up
--                              or down). A row with base up or down moves to
--                              the vertical columns. Rows belong to spectacle
--                              prescriptions only.
--   optical_contact_lens_rows  a contact-lens prescription's lens for each eye:
--                              base curve, diameter, power, CYL and AXIS, ADD,
--                              colour, brand, how often it is replaced
--                              (modality) and the wearing schedule.
--   optical_orders             gains the frame size (A, B and DBL), the doctor
--                              who referred the customer, the quotation it was
--                              booked from (then closed as booked), and whether
--                              a remake is under warranty. While an order is
--                              booked (before the lab or the workshop) its
--                              frame, lenses and prices can be changed; after
--                              that they never change.
--   optical_order_lines        a lens line's warranty: of the lens, and of its
--                              coatings, dated once at delivery by the shop's
--                              warranty months. A booked order's lines can be
--                              written again when the order is changed.
--   optical_order_events       a workshop step (cutting, edging, fitting) is
--                              kept as a note on an order in the workshop.
--   optical_order_advances     every advance taken on an order (the one at
--                              booking, and any taken later): each a numbered
--                              collection receipt for the order's customer.
--   optical_frame_holds        a frame held in stock for an order: the stock
--                              lot it is held in cannot go below what is held
--                              (a trigger on business_stock_lots), so no bill,
--                              transfer, count or adjustment takes it, until
--                              the hold is released or the order is delivered.
--   optical_settings           gains the recall months for children (under 18
--                              at their last test), contact-lens wearers and
--                              progressive wearers, the warranty months of
--                              lenses and of coatings, and whether a remake
--                              under warranty is free or charged.
--   optical_recall_reminders   gains its kind: an eye test, or contact lenses
--                              due for replacement.
--   optical_contact_lens_trials  contact lenses given free on trial: taken
--                              out of stock by a stock adjustment (its batch
--                              kept), converted when the customer pays for
--                              lenses of the same product, or marked lapsed.
--   business_quotations        a quotation can become a spectacle order: its
--                              status is then booked.
-- A permission optical.manage lets a person change a booked order's frame,
-- lenses and prices (the owner and a manager by default).

-- --- Permission --------------------------------------------------------------------------------

INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('optical.manage', 'optical', 'manage', 'Change a booked spectacle order''s frame, lenses and prices', 496);

INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES ('manager', 'optical.manage');

INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, 'optical.manage' FROM business_roles r
WHERE NOT r.full_access AND r.template_code = 'manager'
ON CONFLICT DO NOTHING;

-- --- Prescriptions --------------------------------------------------------------------------------

ALTER TABLE optical_prescriptions
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'spectacles' CHECK (kind IN ('spectacles', 'contact_lens')),
  -- The council the examiner is registered with, and the day their registration runs to.
  ADD COLUMN registration_council VARCHAR(150) CHECK (btrim(registration_council) <> ''),
  ADD COLUMN registration_valid_until DATE,
  -- Back vertex distance in mm, for powers beyond about ±4.00 D.
  ADD COLUMN vertex_distance NUMERIC(4,1) CHECK (vertex_distance BETWEEN 5 AND 25),
  -- The customer's age in years on the day of the test (a child's recall interval).
  ADD COLUMN age_years SMALLINT CHECK (age_years BETWEEN 0 AND 120),
  -- The doctor who sent the customer, as written (a hospital-attached optical's referral).
  ADD COLUMN referred_by VARCHAR(150) CHECK (btrim(referred_by) <> ''),
  -- The eye-test booking it was recorded from.
  ADD COLUMN appointment_id BIGINT,
  ADD FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id),
  ADD CONSTRAINT optical_prescriptions_one_a_booking UNIQUE (business_id, appointment_id, kind),
  ADD CONSTRAINT optical_prescriptions_registration_named CHECK ((registration_council IS NULL AND registration_valid_until IS NULL) OR registration_no IS NOT NULL),
  ADD CONSTRAINT optical_prescriptions_lens_measures CHECK (kind = 'spectacles' OR (pd_binocular IS NULL AND pd_right IS NULL AND vertex_distance IS NULL));
CREATE INDEX optical_prescriptions_referrer ON optical_prescriptions(business_id, lower(referred_by)) WHERE referred_by IS NOT NULL;

-- The prism, split: horizontal (in prism and prism_base: in or out) and
-- vertical (up or down). Rows already written with base up or down move to
-- the vertical columns (the guard is paused for it: their powers stay the same).
ALTER TABLE optical_prescription_rows
  ADD COLUMN prism_vertical NUMERIC(4,2) CHECK (prism_vertical > 0 AND prism_vertical <= 20 AND prism_vertical * 4 = trunc(prism_vertical * 4)),
  ADD COLUMN prism_vertical_base TEXT CHECK (prism_vertical_base IN ('up', 'down')),
  ADD CONSTRAINT optical_prescription_rows_vertical_base CHECK ((prism_vertical IS NULL) = (prism_vertical_base IS NULL));
ALTER TABLE optical_prescription_rows DISABLE TRIGGER optical_prescription_rows_guard;
UPDATE optical_prescription_rows SET prism_vertical = prism, prism_vertical_base = prism_base, prism = NULL, prism_base = NULL WHERE prism_base IN ('up', 'down');
ALTER TABLE optical_prescription_rows ENABLE TRIGGER optical_prescription_rows_guard;
ALTER TABLE optical_prescription_rows DROP CONSTRAINT optical_prescription_rows_prism_base_check,
  ADD CONSTRAINT optical_prescription_rows_prism_base_check CHECK (prism_base IN ('in', 'out'));
ALTER TABLE optical_prescription_rows DROP CONSTRAINT optical_prescription_rows_check4,
  ADD CONSTRAINT optical_prescription_rows_check4 CHECK (sph IS NOT NULL OR add_power IS NOT NULL OR prism IS NOT NULL OR prism_vertical IS NOT NULL OR acuity IS NOT NULL);

-- A contact-lens prescription's lens for each eye.
CREATE TABLE optical_contact_lens_rows (
  business_id BIGINT NOT NULL,
  prescription_id BIGINT NOT NULL,
  eye TEXT NOT NULL CHECK (eye IN ('right', 'left')),
  base_curve NUMERIC(4,2) NOT NULL CHECK (base_curve BETWEEN 6 AND 10),
  diameter NUMERIC(4,2) NOT NULL CHECK (diameter BETWEEN 8 AND 25),
  power NUMERIC(4,2) NOT NULL CHECK (power BETWEEN -30 AND 30 AND power * 4 = trunc(power * 4)),
  cyl NUMERIC(4,2) CHECK (cyl BETWEEN -30 AND 30 AND cyl <> 0 AND cyl * 4 = trunc(cyl * 4)),
  axis SMALLINT CHECK (axis BETWEEN 1 AND 180),
  add_power NUMERIC(3,2) CHECK (add_power BETWEEN 0.25 AND 4 AND add_power * 4 = trunc(add_power * 4)),
  colour VARCHAR(40) CHECK (btrim(colour) <> ''),
  brand VARCHAR(100) CHECK (btrim(brand) <> ''),
  -- How often the lens is replaced.
  modality TEXT CHECK (modality IN ('daily', 'fortnightly', 'monthly', 'quarterly', 'half_yearly', 'yearly')),
  wearing_schedule VARCHAR(150) CHECK (btrim(wearing_schedule) <> ''),
  PRIMARY KEY (business_id, prescription_id, eye),
  FOREIGN KEY (business_id, prescription_id) REFERENCES optical_prescriptions(business_id, id),
  CHECK ((cyl IS NULL) = (axis IS NULL))
);

-- A contact-lens prescription's lenses, and a spectacle prescription's powers:
-- each on its own kind of prescription.
CREATE FUNCTION optical_contact_lens_rows_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM optical_prescriptions WHERE business_id = NEW.business_id AND id = NEW.prescription_id AND kind = 'contact_lens') THEN
    RAISE EXCEPTION 'A contact lens goes on a contact-lens prescription' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_contact_lens_rows_guard BEFORE INSERT OR UPDATE OR DELETE ON optical_contact_lens_rows
  FOR EACH ROW EXECUTE FUNCTION optical_contact_lens_rows_guard();

CREATE OR REPLACE FUNCTION optical_prescription_rows_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target BIGINT; owner BIGINT; used TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD.prescription_id; owner := OLD.business_id;
  ELSE target := NEW.prescription_id; owner := NEW.business_id; END IF;
  SELECT order_no INTO used FROM optical_orders WHERE business_id = owner AND prescription_id = target ORDER BY id LIMIT 1;
  IF used IS NOT NULL THEN
    RAISE EXCEPTION 'The powers of a prescription on spectacle order % never change: record a new prescription to correct them', used USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  -- Powers per vision go on a spectacle prescription; a contact-lens one has its lenses.
  IF NOT EXISTS (SELECT 1 FROM optical_prescriptions WHERE business_id = owner AND id = target AND kind = 'spectacles') THEN
    RAISE EXCEPTION 'Powers for distance, near and intermediate vision go on a spectacle prescription' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- As before, and a prescription keeps its kind.
CREATE OR REPLACE FUNCTION optical_prescriptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'A prescription keeps its kind: record a new one for spectacles or for contact lenses' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- Spectacle orders --------------------------------------------------------------------------------

ALTER TABLE optical_orders
  -- The frame's size in mm: the lens width (A), its height (B) and the bridge (DBL).
  ADD COLUMN frame_a NUMERIC(4,1) CHECK (frame_a BETWEEN 20 AND 80),
  ADD COLUMN frame_b NUMERIC(4,1) CHECK (frame_b BETWEEN 10 AND 70),
  ADD COLUMN frame_dbl NUMERIC(4,1) CHECK (frame_dbl BETWEEN 10 AND 30),
  ADD COLUMN referred_by VARCHAR(150) CHECK (btrim(referred_by) <> ''),
  ADD COLUMN quotation_id BIGINT,
  -- A remake whose lens or coating was under warranty when it was booked.
  ADD COLUMN remake_under_warranty BOOLEAN NOT NULL DEFAULT FALSE,
  ADD FOREIGN KEY (business_id, quotation_id) REFERENCES business_quotations(business_id, id),
  ADD CONSTRAINT optical_orders_one_a_quotation UNIQUE (business_id, quotation_id),
  ADD CONSTRAINT optical_orders_warranty_remake CHECK (NOT remake_under_warranty OR remake_of IS NOT NULL),
  ADD CONSTRAINT optical_orders_quotation_not_remake CHECK (quotation_id IS NULL OR remake_of IS NULL);
CREATE INDEX optical_orders_referrer ON optical_orders(business_id, lower(referred_by)) WHERE referred_by IS NOT NULL;

-- As before, and the prescription is a spectacle one.
CREATE OR REPLACE FUNCTION optical_orders_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM optical_prescriptions WHERE business_id = NEW.business_id AND id = NEW.prescription_id AND contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'The prescription of a spectacle order is its customer''s own' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM optical_prescriptions WHERE business_id = NEW.business_id AND id = NEW.prescription_id AND kind = 'spectacles') THEN
    RAISE EXCEPTION 'Spectacles are made from a spectacle prescription, not a contact-lens one' USING ERRCODE = '23514';
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

-- A delivered or cancelled order never changes. An open one keeps its
-- number, customer, prescription, remake and advance at booking; its prices
-- change only while it is booked (its frame and lenses changed before it goes
-- to the lab or the workshop). It moves one allowed step at a time, as before.
CREATE OR REPLACE FUNCTION optical_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A spectacle order is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Spectacle order % is % and can no longer change', OLD.order_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.order_no <> OLD.order_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.contact_id <> OLD.contact_id OR NEW.prescription_id <> OLD.prescription_id OR NEW.rx <> OLD.rx
     OR NEW.remake_of IS DISTINCT FROM OLD.remake_of OR NEW.remake_reason IS DISTINCT FROM OLD.remake_reason
     OR NEW.remake_cost_by IS DISTINCT FROM OLD.remake_cost_by OR NEW.remake_under_warranty <> OLD.remake_under_warranty
     OR NEW.advance_collection_id IS DISTINCT FROM OLD.advance_collection_id OR NEW.quotation_id IS DISTINCT FROM OLD.quotation_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A spectacle order keeps its number, customer, prescription and advance' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tax_mode <> OLD.tax_mode OR NEW.subtotal <> OLD.subtotal OR NEW.tax <> OLD.tax OR NEW.round_off <> OLD.round_off
     OR NEW.total <> OLD.total OR NEW.savings <> OLD.savings OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
     OR NEW.discount_percent IS DISTINCT FROM OLD.discount_percent OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason)
     AND NOT (OLD.status = 'booked' AND NEW.status = 'booked') THEN
    RAISE EXCEPTION 'Spectacle order % keeps its prices once it has gone to the lab or the workshop', OLD.order_no USING ERRCODE = '23514';
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

-- A lens line's warranty, dated at delivery: of the lens, and of its coatings.
ALTER TABLE optical_order_lines
  ADD COLUMN warranty_until DATE,
  ADD COLUMN coating_warranty_until DATE,
  ADD CONSTRAINT optical_order_lines_warranty_lens CHECK (part = 'lens' OR (warranty_until IS NULL AND coating_warranty_until IS NULL)),
  ADD CONSTRAINT optical_order_lines_warranty_coating CHECK (coating_warranty_until IS NULL OR coatings <> '{}');

-- A line goes in while its order is booked; a booked order's lines are
-- written again when its frame and lenses are changed; delivery dates the
-- warranties of its lenses and coatings, once. Nothing else changes.
CREATE OR REPLACE FUNCTION optical_order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO state FROM optical_orders WHERE business_id = OLD.business_id AND id = OLD.order_id;
    IF state = 'booked' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'A spectacle order''s lines are kept as they were booked' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO state FROM optical_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF TG_OP = 'INSERT' THEN
    IF state IS DISTINCT FROM 'booked' THEN
      RAISE EXCEPTION 'Lines go on a spectacle order when it is booked' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF state = 'ready' AND OLD.warranty_until IS NULL AND OLD.coating_warranty_until IS NULL
     AND (to_jsonb(NEW) - ARRAY['warranty_until', 'coating_warranty_until']) = (to_jsonb(OLD) - ARRAY['warranty_until', 'coating_warranty_until']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A spectacle order''s lines are kept as they were booked' USING ERRCODE = '23514';
END $$;

-- A step of the workshop, kept on an order in the workshop.
ALTER TABLE optical_order_events
  ADD COLUMN step TEXT CHECK (step IN ('cutting', 'edging', 'fitting')),
  ADD CONSTRAINT optical_order_events_step_in_workshop CHECK (step IS NULL OR (from_status = 'in_workshop' AND to_status = 'in_workshop'));

-- Every advance taken on an order.
CREATE TABLE optical_order_advances (
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  collection_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, collection_id),
  FOREIGN KEY (business_id, order_id) REFERENCES optical_orders(business_id, id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id)
);
CREATE INDEX optical_order_advances_order ON optical_order_advances(business_id, order_id, created_at);
INSERT INTO optical_order_advances (business_id, order_id, collection_id, created_by, created_at)
SELECT business_id, id, advance_collection_id, created_by, created_at FROM optical_orders WHERE advance_collection_id IS NOT NULL;

-- An advance is taken on an open order, as its customer's receipt.
CREATE FUNCTION optical_order_advances_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD;
BEGIN
  SELECT order_no, status, contact_id INTO o FROM optical_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF o.status NOT IN ('booked', 'at_lab', 'in_workshop', 'quality_check', 'ready') THEN
    RAISE EXCEPTION 'Spectacle order % is % and takes no advance', o.order_no, o.status USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id AND contact_id = o.contact_id) THEN
    RAISE EXCEPTION 'An advance on spectacle order % is its customer''s own receipt', o.order_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_order_advances_insert_check BEFORE INSERT ON optical_order_advances
  FOR EACH ROW EXECUTE FUNCTION optical_order_advances_insert_check();

-- A frame held in stock for an order.
CREATE TABLE optical_frame_holds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  lot_id BIGINT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- held, then released (by hand, a cancelled order or a changed frame) or delivered.
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'delivered')),
  held_by BIGINT NOT NULL REFERENCES users(id),
  held_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(300),
  FOREIGN KEY (business_id, order_id) REFERENCES optical_orders(business_id, id),
  FOREIGN KEY (business_id, lot_id) REFERENCES business_stock_lots(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((status = 'held') = (closed_at IS NULL)),
  CHECK ((status = 'held') = (closed_by IS NULL))
);
CREATE UNIQUE INDEX optical_frame_holds_one_an_order ON optical_frame_holds(business_id, order_id) WHERE status = 'held';
CREATE INDEX optical_frame_holds_lot ON optical_frame_holds(lot_id) WHERE status = 'held';

-- A hold is never deleted, and closes once.
CREATE FUNCTION optical_frame_holds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A frame held for an order is never deleted; release it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'held' OR NEW.status = 'held'
     OR (to_jsonb(NEW) - ARRAY['status', 'closed_by', 'closed_at', 'close_reason']) <> (to_jsonb(OLD) - ARRAY['status', 'closed_by', 'closed_at', 'close_reason']) THEN
    RAISE EXCEPTION 'A frame held for an order is released or delivered once, and is otherwise kept as it was' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_frame_holds_guard BEFORE UPDATE OR DELETE ON optical_frame_holds
  FOR EACH ROW EXECUTE FUNCTION optical_frame_holds_guard();

-- Stock held for an order stays: a lot never goes below what is held in it,
-- whatever takes it (a bill, a transfer, a count, an adjustment).
CREATE FUNCTION optical_frame_holds_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held NUMERIC; holder TEXT; item TEXT;
BEGIN
  IF NEW.quantity >= OLD.quantity THEN RETURN NEW; END IF;
  SELECT sum(h.quantity), min(o.order_no) INTO held, holder FROM optical_frame_holds h
    JOIN optical_orders o ON o.business_id = h.business_id AND o.id = h.order_id
    WHERE h.lot_id = NEW.id AND h.status = 'held';
  IF held IS NULL OR NEW.quantity >= held THEN RETURN NEW; END IF;
  SELECT label INTO item FROM catalog_skus WHERE business_id = NEW.business_id AND id = NEW.sku_id;
  RAISE EXCEPTION '% is held here for spectacle order %: release the hold on the order first', item, holder USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_stock_lots_optical_holds BEFORE UPDATE OF quantity ON business_stock_lots
  FOR EACH ROW EXECUTE FUNCTION optical_frame_holds_stock();

-- --- Settings, reminders and trials --------------------------------------------------------------

ALTER TABLE optical_settings
  -- A group's own months (none: the shop's recall months); the shortest of a customer's groups applies.
  ADD COLUMN recall_months_child SMALLINT CHECK (recall_months_child BETWEEN 1 AND 60),
  ADD COLUMN recall_months_contact_lens SMALLINT CHECK (recall_months_contact_lens BETWEEN 1 AND 60),
  ADD COLUMN recall_months_progressive SMALLINT CHECK (recall_months_progressive BETWEEN 1 AND 60),
  -- How long the shop's warranty on a lens and on its coatings runs from delivery (none: no warranty).
  ADD COLUMN lens_warranty_months SMALLINT CHECK (lens_warranty_months BETWEEN 1 AND 60),
  ADD COLUMN coating_warranty_months SMALLINT CHECK (coating_warranty_months BETWEEN 1 AND 60),
  -- A remake under warranty: free (the shop or the lab bears it), or charged as any order.
  ADD COLUMN warranty_remakes TEXT NOT NULL DEFAULT 'free' CHECK (warranty_remakes IN ('free', 'charged'));

ALTER TABLE optical_recall_reminders ADD COLUMN kind TEXT NOT NULL DEFAULT 'eye_test' CHECK (kind IN ('eye_test', 'contact_lens'));

CREATE TABLE optical_contact_lens_trials (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  -- The stock lot the lenses came from (their batch), and the adjustment that took them out.
  lot_id BIGINT NOT NULL,
  lot_code VARCHAR(100) NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  adjustment_id BIGINT NOT NULL,
  given_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'given' CHECK (status IN ('given', 'converted', 'lapsed')),
  -- The bill it converted on.
  document_id BIGINT,
  notes VARCHAR(300),
  close_note VARCHAR(300),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, lot_id) REFERENCES business_stock_lots(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  UNIQUE (adjustment_id),
  CHECK (ends_on >= given_on),
  CHECK ((status = 'converted') = (document_id IS NOT NULL)),
  CHECK ((status = 'given') = (closed_at IS NULL)),
  CHECK ((status = 'given') = (closed_by IS NULL))
);
CREATE INDEX optical_contact_lens_trials_contact ON optical_contact_lens_trials(business_id, contact_id, given_on DESC);
CREATE INDEX optical_contact_lens_trials_open ON optical_contact_lens_trials(business_id, ends_on) WHERE status = 'given';
CREATE TRIGGER optical_contact_lens_trials_customer BEFORE INSERT ON optical_contact_lens_trials
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A trial is never deleted, and closes once (converted or lapsed).
CREATE FUNCTION optical_contact_lens_trials_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A contact-lens trial is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'given' OR NEW.status = 'given'
     OR (to_jsonb(NEW) - ARRAY['status', 'document_id', 'close_note', 'closed_by', 'closed_at']) <> (to_jsonb(OLD) - ARRAY['status', 'document_id', 'close_note', 'closed_by', 'closed_at']) THEN
    RAISE EXCEPTION 'A contact-lens trial is converted or lapses once, and is otherwise kept as it was given' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER optical_contact_lens_trials_guard BEFORE UPDATE OR DELETE ON optical_contact_lens_trials
  FOR EACH ROW EXECUTE FUNCTION optical_contact_lens_trials_guard();

-- History is kept as it was written (the advances of an order too).
CREATE OR REPLACE FUNCTION optical_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'optical_order_events' THEN
    RAISE EXCEPTION 'A spectacle order''s history is kept as it was written' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'optical_order_advances' THEN
    RAISE EXCEPTION 'A spectacle order''s advances are kept as they were taken' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A recall reminder is kept as it was given' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER optical_order_advances_append_only BEFORE UPDATE OR DELETE ON optical_order_advances
  FOR EACH ROW EXECUTE FUNCTION optical_append_only();

-- --- Quotations that become spectacle orders -------------------------------------------------------

ALTER TABLE business_quotations DROP CONSTRAINT business_quotations_status_check,
  ADD CONSTRAINT business_quotations_status_check CHECK (status IN ('open', 'billed', 'ordered', 'booked', 'cancelled'));

-- As before, and a quotation booked as a spectacle order is checked as one billed or ordered.
CREATE OR REPLACE FUNCTION business_quotations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A quotation is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Quotation % is % and can no longer change', OLD.quotation_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.quotation_no <> OLD.quotation_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A quotation keeps its number, its location and who made it' USING ERRCODE = '23514';
  END IF;
  IF NEW.terms IS DISTINCT FROM OLD.terms THEN
    RAISE EXCEPTION 'A quotation keeps the terms and conditions it was made with' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision NOT IN (OLD.revision, OLD.revision + 1) THEN
    RAISE EXCEPTION 'A quotation is revised one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('billed', 'ordered', 'booked') THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    IF OLD.valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'Quotation % was valid until %. Revise it to bring its prices up to date first.', OLD.quotation_no, to_char(OLD.valid_until, 'DD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Down Migration
-- Refuses while a quotation is booked as a spectacle order (restore a backup
-- instead). A contact-lens prescription is left without its lenses, and a row
-- with both prisms keeps only the horizontal one.
CREATE OR REPLACE FUNCTION business_quotations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A quotation is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Quotation % is % and can no longer change', OLD.quotation_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.quotation_no <> OLD.quotation_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A quotation keeps its number, its location and who made it' USING ERRCODE = '23514';
  END IF;
  IF NEW.terms IS DISTINCT FROM OLD.terms THEN
    RAISE EXCEPTION 'A quotation keeps the terms and conditions it was made with' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision NOT IN (OLD.revision, OLD.revision + 1) THEN
    RAISE EXCEPTION 'A quotation is revised one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('billed', 'ordered') THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    IF OLD.valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'Quotation % was valid until %. Revise it to bring its prices up to date first.', OLD.quotation_no, to_char(OLD.valid_until, 'DD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE business_quotations DROP CONSTRAINT business_quotations_status_check,
  ADD CONSTRAINT business_quotations_status_check CHECK (status IN ('open', 'billed', 'ordered', 'cancelled'));

CREATE OR REPLACE FUNCTION optical_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'optical_order_events' THEN
    RAISE EXCEPTION 'A spectacle order''s history is kept as it was written' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A recall reminder is kept as it was given' USING ERRCODE = '23514';
END $$;

DROP TABLE optical_contact_lens_trials;
DROP FUNCTION optical_contact_lens_trials_guard();
ALTER TABLE optical_recall_reminders DROP COLUMN kind;
ALTER TABLE optical_settings DROP COLUMN recall_months_child, DROP COLUMN recall_months_contact_lens, DROP COLUMN recall_months_progressive,
  DROP COLUMN lens_warranty_months, DROP COLUMN coating_warranty_months, DROP COLUMN warranty_remakes;

DROP TRIGGER business_stock_lots_optical_holds ON business_stock_lots;
DROP FUNCTION optical_frame_holds_stock();
DROP TABLE optical_frame_holds;
DROP FUNCTION optical_frame_holds_guard();
DROP TABLE optical_order_advances;
DROP FUNCTION optical_order_advances_insert_check();

ALTER TABLE optical_order_events DROP CONSTRAINT optical_order_events_step_in_workshop, DROP COLUMN step;

CREATE OR REPLACE FUNCTION optical_order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER TABLE optical_order_lines DROP CONSTRAINT optical_order_lines_warranty_lens, DROP CONSTRAINT optical_order_lines_warranty_coating,
  DROP COLUMN warranty_until, DROP COLUMN coating_warranty_until;

CREATE OR REPLACE FUNCTION optical_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION optical_orders_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
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

DROP INDEX optical_orders_referrer;
ALTER TABLE optical_orders DROP CONSTRAINT optical_orders_one_a_quotation, DROP CONSTRAINT optical_orders_warranty_remake, DROP CONSTRAINT optical_orders_quotation_not_remake,
  DROP COLUMN frame_a, DROP COLUMN frame_b, DROP COLUMN frame_dbl, DROP COLUMN referred_by, DROP COLUMN quotation_id, DROP COLUMN remake_under_warranty;

CREATE OR REPLACE FUNCTION optical_prescriptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION optical_prescription_rows_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

DROP TABLE optical_contact_lens_rows;
DROP FUNCTION optical_contact_lens_rows_guard();

ALTER TABLE optical_prescription_rows DROP CONSTRAINT optical_prescription_rows_check4,
  ADD CONSTRAINT optical_prescription_rows_check4 CHECK (sph IS NOT NULL OR add_power IS NOT NULL OR prism IS NOT NULL OR acuity IS NOT NULL);
ALTER TABLE optical_prescription_rows DROP CONSTRAINT optical_prescription_rows_prism_base_check,
  ADD CONSTRAINT optical_prescription_rows_prism_base_check CHECK (prism_base IN ('in', 'out', 'up', 'down'));
ALTER TABLE optical_prescription_rows DISABLE TRIGGER optical_prescription_rows_guard;
UPDATE optical_prescription_rows SET prism = prism_vertical, prism_base = prism_vertical_base, prism_vertical = NULL, prism_vertical_base = NULL
  WHERE prism_vertical IS NOT NULL AND prism IS NULL;
ALTER TABLE optical_prescription_rows ENABLE TRIGGER optical_prescription_rows_guard;
ALTER TABLE optical_prescription_rows DROP CONSTRAINT optical_prescription_rows_vertical_base, DROP COLUMN prism_vertical, DROP COLUMN prism_vertical_base;

DROP INDEX optical_prescriptions_referrer;
ALTER TABLE optical_prescriptions DROP CONSTRAINT optical_prescriptions_one_a_booking, DROP CONSTRAINT optical_prescriptions_registration_named,
  DROP CONSTRAINT optical_prescriptions_lens_measures,
  DROP COLUMN kind, DROP COLUMN registration_council, DROP COLUMN registration_valid_until, DROP COLUMN vertex_distance,
  DROP COLUMN age_years, DROP COLUMN referred_by, DROP COLUMN appointment_id;

DELETE FROM business_role_permissions WHERE permission_code = 'optical.manage';
DELETE FROM business_role_template_permissions WHERE permission_code = 'optical.manage';
DELETE FROM business_permissions WHERE code = 'optical.manage';
