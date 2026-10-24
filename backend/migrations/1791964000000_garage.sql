-- Up Migration
-- A vehicle service and auto parts business's own tools: its customers'
-- vehicles, job cards from the vehicle's arrival to its bill, insurance claims
-- billed to the insurer and the owner, and service reminders.
--
-- Vehicles & job cards (module "garage", on for type "garage"):
--   garage_vehicles            a vehicle: its registration number (upper case,
--                              letters and digits only; one vehicle per number
--                              in a business), make, model, variant, fuel,
--                              year, chassis and engine numbers, its owner now
--                              (a customer), its latest odometer reading,
--                              insurance and PUC expiry, and when its next
--                              service is due, by date and by reading. Switched
--                              off when sold or scrapped, never deleted.
--   garage_vehicle_owners      every owner a vehicle has had, written by the
--                              database whenever the owner changes.
--   garage_odometer_readings   every reading: at a job card's arrival or
--                              delivery, or typed on the vehicle. A reading
--                              lower than the last is refused unless a manager
--                              approves it, with a note why (a meter changed or
--                              reset); the vehicle's latest reading follows it.
--   garage_job_cards           a job card (JC/2627/0001): the vehicle and the
--                              customer as they were, the odometer and fuel
--                              level in, the customer's complaints, inspection
--                              notes, the bay, the promised time, and the status
--                              from received through estimate sent, approved,
--                              in progress and waiting for parts to ready and
--                              delivered, or cancelled. An advance is the
--                              customer's money on account (a collection
--                              receipt). Billing posts the bills through the
--                              core: one to the customer, or for a cashless
--                              claim one to the insurer for the amount it
--                              approved and one to the customer for the rest;
--                              the two add up to the job to the paisa.
--   garage_job_card_mechanics  the members who work on a job card.
--   garage_job_card_lines      the estimate as it stands: parts (items kept in
--                              stock; they leave stock when the job is billed),
--                              labour and outside work (service items; outside
--                              work names the workshop that did it and its
--                              bill), each priced as charged, with who pays it
--                              (the customer, or the insurer on a claim) and
--                              whether the work is done.
--   garage_estimate_versions   every version of the estimate, as it was saved.
--   garage_estimate_approvals  who approved a version, how (in person, by phone
--                              or on WhatsApp), when, and its amount.
--   garage_claims              a job card's insurance claim: the insurer (a
--                              customer), cashless or reimbursement, the policy
--                              and claim numbers, the surveyor, the amount the
--                              insurer approved, the deductible and the
--                              depreciation.
--   garage_job_card_events     every change of a job card's status, and notes.
--   garage_reminders           each service, insurance or PUC reminder given.
--   garage_settings            the months and kilometres to the next service (6
--                              and 5,000 until changed) and the service item
--                              that bills the owner's share of a claim.
-- The advance on a cancelled job card is handed back from it
-- (business_collection_refunds source "garage").

-- --- Module, permissions and roles ------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('garage', 'Vehicles & job cards', 'Each customer''s vehicles with their registration, owners and odometer readings; job cards from the vehicle''s arrival through the estimate the owner approves, the work, parts and labour, to the bill, with an insurance claim billed to the insurer and the owner; service reminders by date and kilometres, and insurance and PUC expiry.', 'optional', 249);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('garage', 'catalog'), ('garage', 'contacts'), ('garage', 'sales');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('garage', 'garage', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('garage', 'view', 'See every vehicle and job card, the service-due list and customers'' statements', 500),
 ('garage', 'create', 'Add vehicles and open job cards', 501),
 ('garage', 'edit', 'Work on job cards: estimates, mechanics, work done and parts used, claims and billing', 502),
 ('garage', 'approve', 'Approve an odometer reading lower than the last', 503),
 ('garage', 'cancel', 'Cancel job cards', 504),
 ('garage', 'print', 'Print job cards and customers'' statements', 505)
) AS p(module_code, action, name, sort_order);

-- A mechanic of a garage: works on the job cards assigned to them; no money.
INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types) VALUES
 ('mechanic', 'Mechanic', 'Works on the job cards assigned to them: records the work done and the parts used, and moves the job along. Sees no prices and takes no money.', FALSE, 37, ARRAY['garage']);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'garage'
UNION ALL SELECT 'cashier', unnest(ARRAY['garage.view', 'garage.create', 'garage.edit', 'garage.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['garage.view'])
UNION ALL SELECT 'accountant', unnest(ARRAY['garage.view', 'garage.print'])
UNION ALL SELECT 'viewer', unnest(ARRAY['garage.view'])
UNION ALL SELECT 'mechanic', unnest(ARRAY['catalog.view', 'inventory.view', 'appointments.view', 'garage.edit', 'garage.print']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template"), and the new
-- role in existing garages.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'garage'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;
SELECT business_seed_roles(id) FROM businesses WHERE business_type = 'garage';

-- Existing garages get the tool a new one starts with (where what it needs is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'garage'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Job cards are numbered (JC/2627/0001). The kinds list is widened by reading
-- the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'job_card' = ANY(kinds) THEN kinds := array_append(kinds, 'job_card'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- The advance on a cancelled job card is handed back from the job card.
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical', 'garage'));

-- History is kept as it was written.
CREATE FUNCTION garage_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'garage_vehicle_owners' THEN
    RAISE EXCEPTION 'A vehicle''s owners are kept as they were' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'garage_estimate_versions' THEN
    RAISE EXCEPTION 'An estimate''s versions are kept as they were saved' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'garage_estimate_approvals' THEN
    RAISE EXCEPTION 'An approval of an estimate is kept as it was given' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'garage_job_card_events' THEN
    RAISE EXCEPTION 'A job card''s history is kept as it was written' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A reminder is kept as it was given' USING ERRCODE = '23514';
END $$;

-- --- Settings ------------------------------------------------------------------------------------

-- One row per business, made when the settings are first saved.
CREATE TABLE garage_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- The next service is due this many months and kilometres after a job.
  service_months SMALLINT NOT NULL DEFAULT 6 CHECK (service_months BETWEEN 1 AND 36),
  service_km INTEGER NOT NULL DEFAULT 5000 CHECK (service_km BETWEEN 500 AND 100000),
  -- The service item that bills the owner's share of a cashless claim.
  claim_share_sku_id BIGINT,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, claim_share_sku_id) REFERENCES catalog_skus(business_id, id)
);

-- --- Vehicles ------------------------------------------------------------------------------------

CREATE TABLE garage_vehicles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- As printed on the plate, in upper case with letters and digits only (TS09AB1234).
  registration_no VARCHAR(15) NOT NULL CHECK (registration_no ~ '^[A-Z0-9]{4,15}$' AND registration_no ~ '[A-Z]' AND registration_no ~ '[0-9]'),
  make VARCHAR(60) NOT NULL CHECK (btrim(make) <> ''),
  model VARCHAR(60) NOT NULL CHECK (btrim(model) <> ''),
  variant VARCHAR(60) CHECK (btrim(variant) <> ''),
  fuel TEXT CHECK (fuel IN ('petrol', 'diesel', 'cng', 'petrol_cng', 'lpg', 'electric', 'hybrid')),
  year SMALLINT CHECK (year BETWEEN 1950 AND 2100),
  -- The owner now (a customer). Every owner is kept in garage_vehicle_owners.
  contact_id BIGINT NOT NULL,
  chassis_no VARCHAR(30) CHECK (chassis_no ~ '^[A-Z0-9]{5,30}$'),
  engine_no VARCHAR(30) CHECK (engine_no ~ '^[A-Z0-9]{3,30}$'),
  -- The latest odometer reading, as garage_odometer_readings has it.
  odometer_km INTEGER CHECK (odometer_km BETWEEN 0 AND 9999999),
  odometer_at TIMESTAMPTZ,
  insurance_expires_on DATE,
  puc_expires_on DATE,
  -- When the next service is due: by date, by reading, or both.
  next_service_on DATE,
  next_service_km INTEGER CHECK (next_service_km BETWEEN 1 AND 9999999),
  notes VARCHAR(500),
  -- Switched off when sold or scrapped.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, registration_no),
  CHECK ((odometer_km IS NULL) = (odometer_at IS NULL))
);
CREATE UNIQUE INDEX garage_vehicles_chassis ON garage_vehicles(business_id, chassis_no) WHERE chassis_no IS NOT NULL;
CREATE INDEX garage_vehicles_owner ON garage_vehicles(business_id, contact_id);
CREATE TRIGGER garage_vehicles_customer BEFORE INSERT OR UPDATE OF contact_id ON garage_vehicles
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- Every owner of a vehicle, from the moment they became its owner (the next row ends it).
CREATE TABLE garage_vehicle_owners (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  vehicle_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  since TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by BIGINT NOT NULL REFERENCES users(id),
  FOREIGN KEY (business_id, vehicle_id) REFERENCES garage_vehicles(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id)
);
CREATE INDEX garage_vehicle_owners_vehicle ON garage_vehicle_owners(business_id, vehicle_id, id);
CREATE INDEX garage_vehicle_owners_contact ON garage_vehicle_owners(business_id, contact_id);
CREATE TRIGGER garage_vehicle_owners_append_only BEFORE UPDATE OR DELETE ON garage_vehicle_owners
  FOR EACH ROW EXECUTE FUNCTION garage_append_only();

CREATE FUNCTION garage_vehicle_owner_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    INSERT INTO garage_vehicle_owners (business_id, vehicle_id, contact_id, recorded_by)
    VALUES (NEW.business_id, NEW.id, NEW.contact_id, COALESCE(NEW.updated_by, NEW.created_by));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER garage_vehicles_owner_history AFTER INSERT OR UPDATE OF contact_id ON garage_vehicles
  FOR EACH ROW EXECUTE FUNCTION garage_vehicle_owner_history();

-- --- Job cards -----------------------------------------------------------------------------------

CREATE TABLE garage_job_cards (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  job_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  vehicle_id BIGINT NOT NULL,
  -- The vehicle and the customer as they were when the job card was opened.
  registration_no VARCHAR(15) NOT NULL,
  vehicle_name VARCHAR(200) NOT NULL CHECK (btrim(vehicle_name) <> ''),
  contact_id BIGINT NOT NULL,
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_phone VARCHAR(30),
  odometer_in INTEGER CHECK (odometer_in BETWEEN 0 AND 9999999),
  fuel_level TEXT CHECK (fuel_level IN ('empty', 'quarter', 'half', 'three_quarters', 'full')),
  -- What the customer says is wrong, or the service asked for, one entry each.
  complaints TEXT[] NOT NULL CHECK (cardinality(complaints) BETWEEN 1 AND 20 AND array_position(complaints, NULL) IS NULL),
  inspection_notes VARCHAR(1000),
  bay VARCHAR(40) CHECK (btrim(bay) <> ''),
  promised_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'estimate_sent', 'approved', 'in_progress', 'waiting_parts', 'ready', 'delivered', 'cancelled')),
  -- The estimate's version now (0 before the first) and the last one approved.
  estimate_version SMALLINT NOT NULL DEFAULT 0 CHECK (estimate_version BETWEEN 0 AND 999),
  approved_version SMALLINT CHECK (approved_version BETWEEN 1 AND 999),
  -- The lines now, as priced: before GST, GST, round-off and the total.
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  subtotal NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  round_off NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (round_off > -1 AND round_off < 1),
  total NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes VARCHAR(500),
  -- The advance (a collection receipt: the customer's money on account).
  advance_collection_id BIGINT,
  -- The bills: the customer's, and for a cashless claim the insurer's.
  document_id BIGINT,
  insurer_document_id BIGINT,
  bill_key UUID,
  -- The next service set when the job was billed (also on the vehicle).
  next_service_on DATE,
  next_service_km INTEGER CHECK (next_service_km BETWEEN 1 AND 9999999),
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
  FOREIGN KEY (business_id, vehicle_id) REFERENCES garage_vehicles(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, advance_collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, insurer_document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, job_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, insurer_document_id),
  UNIQUE (business_id, advance_collection_id),
  CHECK (total = subtotal + tax + round_off),
  CHECK (estimate_version > 0 OR total = 0),
  CHECK (approved_version IS NULL OR approved_version <= estimate_version),
  CHECK (status NOT IN ('estimate_sent', 'approved') OR estimate_version > 0),
  CHECK (status <> 'approved' OR approved_version IS NOT NULL),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_by IS NOT NULL)),
  CHECK ((status = 'delivered') = (bill_key IS NOT NULL)),
  CHECK (document_id IS NULL OR status = 'delivered'),
  CHECK (insurer_document_id IS NULL OR status = 'delivered'),
  CHECK ((next_service_on IS NULL AND next_service_km IS NULL) OR status = 'delivered'),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL))
);
CREATE INDEX garage_job_cards_period ON garage_job_cards(business_id, created_at DESC);
CREATE INDEX garage_job_cards_vehicle ON garage_job_cards(business_id, vehicle_id, id DESC);
CREATE INDEX garage_job_cards_contact ON garage_job_cards(business_id, contact_id);
CREATE INDEX garage_job_cards_open ON garage_job_cards(business_id, status) WHERE status NOT IN ('delivered', 'cancelled');
CREATE TRIGGER garage_job_cards_customer BEFORE INSERT ON garage_job_cards
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A new job card starts as received, with no estimate and nothing billed,
-- for a vehicle that is in use.
CREATE FUNCTION garage_job_cards_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE car RECORD;
BEGIN
  IF NEW.status <> 'received' OR NEW.estimate_version <> 0 OR NEW.approved_version IS NOT NULL OR NEW.total <> 0 THEN
    RAISE EXCEPTION 'A job card starts as received, with no estimate yet' USING ERRCODE = '23514';
  END IF;
  SELECT registration_no, active INTO car FROM garage_vehicles WHERE business_id = NEW.business_id AND id = NEW.vehicle_id;
  IF car.active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Vehicle % is switched off: switch it on again to open a job card for it', car.registration_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_job_cards_insert_check BEFORE INSERT ON garage_job_cards
  FOR EACH ROW EXECUTE FUNCTION garage_job_cards_insert_check();

-- A delivered or cancelled job card never changes. An open one keeps its
-- number, vehicle, customer, odometer in and price terms; its estimate goes up
-- one version at a time; an approval is of the version it stands at; its
-- advance, once taken, stays; and it moves one allowed step at a time: an
-- estimate sent waits for the owner's approval (a job card becomes approved
-- with an approval of the estimate as it stands); work goes between in
-- progress, waiting for parts and ready (a revised estimate goes back to the
-- owner); only a ready job is delivered, with its bills; any open job card
-- can be cancelled. Nothing is deleted.
CREATE FUNCTION garage_job_cards_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A job card is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Job card % is % and can no longer change', OLD.job_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.job_no <> OLD.job_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.vehicle_id <> OLD.vehicle_id OR NEW.registration_no <> OLD.registration_no OR NEW.vehicle_name <> OLD.vehicle_name
     OR NEW.contact_id <> OLD.contact_id OR NEW.customer_name <> OLD.customer_name OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
     OR NEW.odometer_in IS DISTINCT FROM OLD.odometer_in OR NEW.tax_mode <> OLD.tax_mode
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A job card keeps its number, vehicle, customer, odometer reading in and price terms' USING ERRCODE = '23514';
  END IF;
  IF OLD.advance_collection_id IS NOT NULL AND NEW.advance_collection_id IS DISTINCT FROM OLD.advance_collection_id THEN
    RAISE EXCEPTION 'A job card keeps the advance taken on it' USING ERRCODE = '23514';
  END IF;
  IF NEW.estimate_version NOT IN (OLD.estimate_version, OLD.estimate_version + 1) THEN
    RAISE EXCEPTION 'A job card''s estimate goes up one version at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.approved_version IS DISTINCT FROM OLD.approved_version AND NEW.approved_version IS DISTINCT FROM NEW.estimate_version THEN
    RAISE EXCEPTION 'An approval is of the estimate as it stands' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'received' AND NEW.status IN ('estimate_sent', 'approved', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status = 'estimate_sent' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status IN ('in_progress', 'waiting_parts') AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'ready', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('estimate_sent', 'in_progress', 'waiting_parts', 'delivered', 'cancelled'))) THEN
    RAISE EXCEPTION 'Job card % cannot go from % to %', OLD.job_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' AND NEW.approved_version IS DISTINCT FROM NEW.estimate_version THEN
    RAISE EXCEPTION 'Job card % is approved once the owner approves the estimate as it stands', OLD.job_no USING ERRCODE = '23514';
  END IF;
  -- A job card with lines is delivered with its bill (or bills).
  IF NEW.status = 'delivered' AND NEW.document_id IS NULL AND NEW.insurer_document_id IS NULL
     AND EXISTS (SELECT 1 FROM garage_job_card_lines WHERE business_id = NEW.business_id AND job_card_id = NEW.id) THEN
    RAISE EXCEPTION 'Job card % is delivered with its bill', OLD.job_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- The members working on a job card.
CREATE TABLE garage_job_card_mechanics (
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  assigned_by BIGINT NOT NULL REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, job_card_id, user_id),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id)
);
CREATE INDEX garage_job_card_mechanics_user ON garage_job_card_mechanics(business_id, user_id);

-- The estimate as it stands. A line is a part (an item kept in stock), labour
-- or outside work (service items; outside work names the workshop that did it
-- and, once it comes, its bill), at the rate charged for one unit in the job
-- card's price terms (GST included or not) with the taxable value and GST it
-- makes, and who pays it.
CREATE TABLE garage_job_card_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('part', 'labour', 'sublet')),
  payer TEXT NOT NULL DEFAULT 'customer' CHECK (payer IN ('customer', 'insurer')),
  sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  amount NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate BETWEEN 0 AND 100),
  net NUMERIC(16,2) NOT NULL CHECK (net >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  price_rule_id BIGINT,
  hsn_code VARCHAR(8),
  mrp NUMERIC(14,2),
  description VARCHAR(200) CHECK (btrim(description) <> ''),
  vendor_name VARCHAR(150) CHECK (btrim(vendor_name) <> ''),
  vendor_bill_no VARCHAR(60) CHECK (btrim(vendor_bill_no) <> ''),
  -- The work done (labour and outside work) or the part fitted: by whom and when.
  done BOOLEAN NOT NULL DEFAULT FALSE,
  done_by BIGINT REFERENCES users(id),
  done_at TIMESTAMPTZ,
  added_by BIGINT NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, unit) REFERENCES business_units(business_id, code),
  FOREIGN KEY (business_id, price_rule_id) REFERENCES business_price_rules(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((kind = 'sublet') = (vendor_name IS NOT NULL)),
  CHECK (vendor_bill_no IS NULL OR kind = 'sublet'),
  CHECK (net + tax = amount OR net = amount),
  CHECK (done = (done_by IS NOT NULL)),
  CHECK (done = (done_at IS NOT NULL))
);
CREATE INDEX garage_job_card_lines_job ON garage_job_card_lines(business_id, job_card_id, id);

CREATE TRIGGER garage_job_cards_guard BEFORE UPDATE OR DELETE ON garage_job_cards
  FOR EACH ROW EXECUTE FUNCTION garage_job_cards_guard();

-- A job card's insurance claim. The insurer is a customer of the business
-- (its bill is a sale) and not the job card's own customer. The approved
-- amount is what the insurer pays; the deductible and depreciation are the
-- owner's share of the insurer's lines.
CREATE TABLE garage_claims (
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  insurer_id BIGINT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('cashless', 'reimbursement')),
  policy_no VARCHAR(60) NOT NULL CHECK (btrim(policy_no) <> ''),
  claim_no VARCHAR(60) CHECK (btrim(claim_no) <> ''),
  surveyor_name VARCHAR(150) CHECK (btrim(surveyor_name) <> ''),
  surveyor_phone VARCHAR(30),
  approved_amount NUMERIC(16,2) CHECK (approved_amount > 0),
  deductible NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (deductible >= 0),
  depreciation NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (depreciation >= 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, job_card_id),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  FOREIGN KEY (business_id, insurer_id) REFERENCES business_contacts(business_id, id)
);
CREATE INDEX garage_claims_insurer ON garage_claims(business_id, insurer_id);

-- Lines, mechanics and the claim change only while the job card is open. A
-- part is an item kept in stock and labour or outside work a service; a line
-- is the insurer's only on a job card with a claim; a mechanic is an active
-- member of the business.
CREATE FUNCTION garage_job_card_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target RECORD; state TEXT; job_customer BIGINT; product_kind TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  SELECT status, contact_id INTO state, job_customer FROM garage_job_cards WHERE business_id = target.business_id AND id = target.job_card_id;
  IF state IS NULL OR state IN ('delivered', 'cancelled') THEN
    IF TG_TABLE_NAME = 'garage_claims' THEN
      RAISE EXCEPTION 'The claim of a billed or cancelled job card never changes' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'garage_job_card_mechanics' THEN
      RAISE EXCEPTION 'The mechanics of a billed or cancelled job card never change' USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'The lines of a billed or cancelled job card never change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.job_card_id <> OLD.job_card_id THEN
    RAISE EXCEPTION 'A line, a mechanic or a claim stays with its job card' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'garage_claims' THEN
    IF TG_OP = 'DELETE' THEN
      IF EXISTS (SELECT 1 FROM garage_job_card_lines WHERE business_id = OLD.business_id AND job_card_id = OLD.job_card_id AND payer = 'insurer') THEN
        RAISE EXCEPTION 'The insurer still pays lines of this job card: make them the customer''s first' USING ERRCODE = '23514';
      END IF;
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.insurer_id AND kind = 'customer') THEN
      RAISE EXCEPTION 'Choose the insurer from the business''s customers' USING ERRCODE = '23514';
    END IF;
    IF NEW.insurer_id = job_customer THEN
      RAISE EXCEPTION 'The insurer is not the job card''s own customer' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'garage_job_card_mechanics' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NOT EXISTS (SELECT 1 FROM business_memberships WHERE business_id = NEW.business_id AND user_id = NEW.user_id AND active) THEN
      RAISE EXCEPTION 'A mechanic on a job card is a member of the business' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.added_by <> OLD.added_by OR NEW.added_at <> OLD.added_at) THEN
    RAISE EXCEPTION 'A job card line keeps who added it and when' USING ERRCODE = '23514';
  END IF;
  SELECT p.kind INTO product_kind FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
  WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
  IF (NEW.kind = 'part') <> (product_kind = 'goods') THEN
    RAISE EXCEPTION 'A part is an item kept in stock; labour and outside work are services' USING ERRCODE = '23514';
  END IF;
  IF NEW.payer = 'insurer' AND NOT EXISTS (SELECT 1 FROM garage_claims WHERE business_id = NEW.business_id AND job_card_id = NEW.job_card_id) THEN
    RAISE EXCEPTION 'A line is the insurer''s only on a job card with an insurance claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_job_card_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON garage_job_card_lines
  FOR EACH ROW EXECUTE FUNCTION garage_job_card_parts_guard();
CREATE TRIGGER garage_job_card_mechanics_guard BEFORE INSERT OR UPDATE OR DELETE ON garage_job_card_mechanics
  FOR EACH ROW EXECUTE FUNCTION garage_job_card_parts_guard();
CREATE TRIGGER garage_claims_guard BEFORE INSERT OR UPDATE OR DELETE ON garage_claims
  FOR EACH ROW EXECUTE FUNCTION garage_job_card_parts_guard();

-- Every version of the estimate as it was saved: its totals, the insurer's
-- part of them, its lines, and what changed.
CREATE TABLE garage_estimate_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  version SMALLINT NOT NULL CHECK (version BETWEEN 1 AND 999),
  subtotal NUMERIC(16,2) NOT NULL CHECK (subtotal >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  round_off NUMERIC(16,2) NOT NULL CHECK (round_off > -1 AND round_off < 1),
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  insurer_lines NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (insurer_lines >= 0),
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  -- The estimate written or revised, parts a mechanic used, or the claim taken off.
  source TEXT NOT NULL CHECK (source IN ('estimate', 'parts', 'claim')),
  note VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  UNIQUE (business_id, job_card_id, version),
  UNIQUE (business_id, request_key),
  CHECK (total = subtotal + tax + round_off)
);
CREATE TRIGGER garage_estimate_versions_append_only BEFORE UPDATE OR DELETE ON garage_estimate_versions
  FOR EACH ROW EXECUTE FUNCTION garage_append_only();

-- Who approved a version of the estimate (the owner, or someone for them),
-- how and when, and its amount (the version's total).
CREATE TABLE garage_estimate_approvals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  version SMALLINT NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  approved_by VARCHAR(150) NOT NULL CHECK (btrim(approved_by) <> ''),
  channel TEXT NOT NULL CHECK (channel IN ('in_person', 'phone', 'whatsapp')),
  approved_at TIMESTAMPTZ NOT NULL,
  note VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by BIGINT NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id, version) REFERENCES garage_estimate_versions(business_id, job_card_id, version),
  UNIQUE (business_id, request_key),
  CHECK (approved_at <= recorded_at + interval '5 minutes')
);
CREATE INDEX garage_estimate_approvals_job ON garage_estimate_approvals(business_id, job_card_id, id);
CREATE TRIGGER garage_estimate_approvals_append_only BEFORE UPDATE OR DELETE ON garage_estimate_approvals
  FOR EACH ROW EXECUTE FUNCTION garage_append_only();

-- An approval is of the version the open job card stands at, for its total.
CREATE FUNCTION garage_estimate_approvals_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job RECORD; version_total NUMERIC;
BEGIN
  SELECT job_no, status, estimate_version INTO job FROM garage_job_cards WHERE business_id = NEW.business_id AND id = NEW.job_card_id;
  IF job.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Job card % is % and takes no approvals', job.job_no, job.status USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> job.estimate_version THEN
    RAISE EXCEPTION 'Version % of the estimate on job card % has been revised: approve the estimate as it stands', NEW.version, job.job_no USING ERRCODE = '23514';
  END IF;
  SELECT total INTO version_total FROM garage_estimate_versions WHERE business_id = NEW.business_id AND job_card_id = NEW.job_card_id AND version = NEW.version;
  IF NEW.amount <> version_total THEN
    RAISE EXCEPTION 'An approval is for the estimate''s total' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_estimate_approvals_check BEFORE INSERT ON garage_estimate_approvals
  FOR EACH ROW EXECUTE FUNCTION garage_estimate_approvals_check();

-- Every change of a job card's status (or a note with none), as it was made.
CREATE TABLE garage_job_card_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id)
);
CREATE INDEX garage_job_card_events_job ON garage_job_card_events(business_id, job_card_id, id);
CREATE TRIGGER garage_job_card_events_append_only BEFORE UPDATE OR DELETE ON garage_job_card_events
  FOR EACH ROW EXECUTE FUNCTION garage_append_only();

-- --- Odometer readings ---------------------------------------------------------------------------

CREATE TABLE garage_odometer_readings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  vehicle_id BIGINT NOT NULL,
  reading_km INTEGER NOT NULL CHECK (reading_km BETWEEN 0 AND 9999999),
  -- Read at a job card's arrival or delivery, or typed on the vehicle.
  source TEXT NOT NULL CHECK (source IN ('job_in', 'job_out', 'vehicle')),
  job_card_id BIGINT,
  -- A reading lower than the last: the manager who approved it, and why.
  lower_approved_by BIGINT REFERENCES users(id),
  lower_reason VARCHAR(300) CHECK (btrim(lower_reason) <> ''),
  recorded_by BIGINT NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, vehicle_id) REFERENCES garage_vehicles(business_id, id),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((source = 'vehicle') = (job_card_id IS NULL)),
  CHECK ((lower_approved_by IS NULL) = (lower_reason IS NULL))
);
CREATE INDEX garage_odometer_readings_vehicle ON garage_odometer_readings(business_id, vehicle_id, id);

-- A reading is never lower than the vehicle's last unless a manager approved
-- it (and only then carries an approval). Readings are kept as they were read.
CREATE FUNCTION garage_odometer_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE car RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An odometer reading is kept as it was read' USING ERRCODE = '23514';
  END IF;
  SELECT v.registration_no, v.odometer_km, v.odometer_at, b.timezone INTO car
  FROM garage_vehicles v JOIN businesses b ON b.id = v.business_id WHERE v.business_id = NEW.business_id AND v.id = NEW.vehicle_id FOR UPDATE OF v;
  IF car.odometer_km IS NOT NULL AND NEW.reading_km < car.odometer_km AND NEW.lower_approved_by IS NULL THEN
    RAISE EXCEPTION '% reads % km, lower than its last reading of % km on %. A manager approves a lower reading (a meter changed or reset), with a note why.',
      car.registration_no, NEW.reading_km, car.odometer_km, to_char(car.odometer_at AT TIME ZONE car.timezone, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  IF NEW.lower_approved_by IS NOT NULL AND (car.odometer_km IS NULL OR NEW.reading_km >= car.odometer_km) THEN
    RAISE EXCEPTION 'Only a reading lower than the last needs a manager''s approval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_odometer_readings_check BEFORE INSERT OR UPDATE OR DELETE ON garage_odometer_readings
  FOR EACH ROW EXECUTE FUNCTION garage_odometer_check();

-- The vehicle's latest reading follows its log.
CREATE FUNCTION garage_odometer_latest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE garage_vehicles SET odometer_km = NEW.reading_km, odometer_at = NEW.recorded_at WHERE business_id = NEW.business_id AND id = NEW.vehicle_id;
  RETURN NULL;
END $$;
CREATE TRIGGER garage_odometer_readings_latest AFTER INSERT ON garage_odometer_readings
  FOR EACH ROW EXECUTE FUNCTION garage_odometer_latest();

-- A vehicle is switched off, never deleted; it keeps who added it; its
-- latest reading is the last one in its odometer log, never typed over.
CREATE FUNCTION garage_vehicles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A vehicle is never deleted; switch it off when it is sold or scrapped' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A vehicle keeps who added it and when' USING ERRCODE = '23514';
  END IF;
  IF NEW.odometer_km IS DISTINCT FROM OLD.odometer_km OR NEW.odometer_at IS DISTINCT FROM OLD.odometer_at THEN
    SELECT reading_km, recorded_at INTO latest FROM garage_odometer_readings WHERE business_id = NEW.business_id AND vehicle_id = NEW.id ORDER BY id DESC LIMIT 1;
    IF latest.reading_km IS DISTINCT FROM NEW.odometer_km OR latest.recorded_at IS DISTINCT FROM NEW.odometer_at THEN
      RAISE EXCEPTION 'A vehicle''s odometer is read into its odometer log, never typed over' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_vehicles_guard BEFORE UPDATE OR DELETE ON garage_vehicles
  FOR EACH ROW EXECUTE FUNCTION garage_vehicles_guard();

-- --- Reminders -----------------------------------------------------------------------------------

-- A reminder given to a vehicle's owner: its next service, or its insurance
-- or PUC running out; and how.
CREATE TABLE garage_reminders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  vehicle_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('service', 'insurance', 'puc')),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'call', 'sms')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, vehicle_id) REFERENCES garage_vehicles(business_id, id)
);
CREATE INDEX garage_reminders_vehicle ON garage_reminders(business_id, vehicle_id, kind, created_at DESC);
CREATE TRIGGER garage_reminders_append_only BEFORE UPDATE OR DELETE ON garage_reminders
  FOR EACH ROW EXECUTE FUNCTION garage_append_only();

-- Down Migration
DROP TABLE garage_reminders, garage_odometer_readings, garage_job_card_events, garage_estimate_approvals, garage_estimate_versions, garage_claims,
  garage_job_card_lines, garage_job_card_mechanics, garage_job_cards, garage_vehicle_owners, garage_vehicles, garage_settings;
DROP FUNCTION garage_vehicles_guard();
DROP FUNCTION garage_odometer_latest();
DROP FUNCTION garage_odometer_check();
DROP FUNCTION garage_estimate_approvals_check();
DROP FUNCTION garage_job_card_parts_guard();
DROP FUNCTION garage_job_cards_guard();
DROP FUNCTION garage_job_cards_insert_check();
DROP FUNCTION garage_vehicle_owner_history();
DROP FUNCTION garage_append_only();
-- Refuses while an advance has been handed back from a job card (restore a backup instead).
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical'));
DELETE FROM business_number_series WHERE document_kind = 'job_card';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'job_card');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_role_permissions WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'mechanic');
UPDATE business_memberships m SET role_id = (SELECT r2.id FROM business_roles r2 WHERE r2.business_id = m.business_id AND r2.template_code = 'viewer')
  WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'mechanic');
DELETE FROM business_roles WHERE template_code = 'mechanic';
DELETE FROM business_role_template_permissions WHERE template_code = 'mechanic';
DELETE FROM business_role_templates WHERE code = 'mechanic';
DELETE FROM business_capabilities WHERE capability = 'garage';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'garage');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'garage');
DELETE FROM business_permissions WHERE module_code = 'garage';
DELETE FROM platform_module_business_types WHERE module_code = 'garage';
DELETE FROM platform_module_dependencies WHERE module_code = 'garage';
DELETE FROM platform_modules WHERE code = 'garage';
