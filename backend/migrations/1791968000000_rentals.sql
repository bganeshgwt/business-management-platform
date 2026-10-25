-- Up Migration
-- A rental and hire business's own tools: the things it hires out (one by
-- one, each with its number and meter, or from a pool of the same), their
-- rates and rules, quotes and bookings checked against what is free, the
-- handover with the hirer's ID and the condition noted, the return with late
-- fees and charges billed through the core, advances and refundable deposits
-- kept apart from sales, and the deposits held.
--
-- Hire items & bookings (module "rentals", on for type "rentals"):
--   rental_settings         whether a hirer's photo ID is recorded at every
--                           handover (until changed: yes), and the shop's
--                           terms printed on the booking and handover slips.
--   rental_items            each thing hired out, billed as a service item of
--                           the catalogue (its name on the bill, its GST slab
--                           and its SAC come from the item: renting goods
--                           without an operator is taxed at the rate of a sale
--                           of the like goods, so the slab follows what is
--                           hired): hired one by one (each a unit with its own
--                           number) or from a pool of how many the shop has; a
--                           motor vehicle (a car, a motorcycle or another),
--                           self-drive or with the shop's driver; a meter read
--                           at each handover and return (kilometres, or a
--                           machine's running hours); the refundable deposit
--                           for each one hired; rates by the hour, day, week
--                           and month (a hire is billed at the cheapest mix of
--                           them that covers it); a minimum hire; the
--                           turnaround time a unit or a pooled piece needs
--                           between hires; and the late fee after a grace time,
--                           by the hour or the day. Switched off, never deleted.
--   rental_units            each unit of an item hired one by one: its name,
--                           its registration (a vehicle) or serial number, its
--                           latest meter reading (which never goes back), and
--                           whether it is in service, in maintenance or
--                           retired. Never deleted.
--   rental_bookings         a quote or a booking (RN/2627/0001): the hirer as
--                           they were, when it goes out and when it is due back
--                           (instants, shown on the business's clock; at most
--                           90 days), the hire as priced, the deposit asked,
--                           and its status: quote, reserved, out, returned or
--                           cancelled. At the handover: the hirer's photo ID
--                           (of an Aadhaar card only the last four digits are
--                           kept), the driving licence and its expiry for a
--                           self-drive vehicle, and a deposit taken below the
--                           one asked with who agreed and why. The bill made
--                           when the last of it came back (a core sale), or the
--                           cancellation charge's bill.
--   rental_booking_lines    each item on a booking: the unit (one by one) or
--                           how many from the pool, the item's rates and rules
--                           as booked, the hours charged and the cheapest mix
--                           of months, weeks, days and hours for them, the
--                           price of one for the period and the line, its GST
--                           as priced, the deposit for each one; at the
--                           handover what was noted about it, its meter and
--                           fuel; and the bill line that charged its hire.
--   rental_receipts         the advances and refundable deposits taken for a
--                           booking: each a core collection receipt in the
--                           hirer's name. An advance is money on account for
--                           the hire; a deposit is not a payment for it until
--                           the shop applies it to the bill (CGST Act, section
--                           2(31)), and what is left of it goes back.
--   rental_returns          each time things come back, and the bill posted
--                           when the last of them is back.
--   rental_return_lines     what came back of each line (and what never will),
--                           what was noted, its meter and fuel, how late it was
--                           and the late fee, and a unit sent for maintenance.
--   rental_charges          damage, a missing piece, cleaning, fuel and other
--                           charges noted at a return, and a cancellation
--                           charge: each billed with its GST on the booking's
--                           bill, at the slab of the item it is for.
--   rental_booking_events   everything that happened to a booking, as written.
-- What is free is worked out from the bookings themselves (rental_holds): a
-- reserved booking holds its units and pieces from its out time to its due
-- time and the turnaround time; one handed over holds what is still out until
-- it is due (or now, while it is late) and what came back until it came back
-- and the turnaround time. A unit is never booked twice over the same time,
-- and a pool never more than it has: the database checks every booking that
-- holds anything when it is saved, one item at a time (its row is the lock).
-- A deposit is never kept as untaxed income: whatever the shop keeps of it is
-- billed as a charge with its GST, and the deposit then pays that bill.
-- A rental item's hire is billed from its booking only (the API refuses its
-- item on any other bill).

-- --- Module, permissions and roles ------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('rentals', 'Hire items & bookings', 'Things hired out one by one (each with its number and meter) or from a pool, with hour, day, week and month rates billed at the cheapest mix, a minimum hire, turnaround time and late fees; bookings checked against what is free; the handover with the hirer''s ID; the return with late fees and charges on the bill; refundable deposits held apart from sales, applied to the bill.', 'optional', 241);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('rentals', 'catalog'), ('rentals', 'contacts'), ('rentals', 'sales');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('rentals', 'rentals', TRUE);

-- Self-drive hire needs the State Transport Authority's licence, kept with the licences.
UPDATE platform_module_business_types SET recommended = TRUE,
  recommended_note = 'Self-drive cars and motorcycles: the State Transport Authority''s rent-a-cab or rent-a-motorcycle licence, with its dates.'
WHERE module_code = 'licences' AND business_type = 'rentals' AND NOT enabled_by_default;

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('rentals', 'view', 'See bookings, what is free, the rental items and the deposits held', 540),
 ('rentals', 'create', 'Make quotes and bookings', 541),
 ('rentals', 'edit', 'Change bookings, hand items over and take them back with their charges, and send units for maintenance', 542),
 ('rentals', 'approve', 'Hand items over with less deposit than asked', 543),
 ('rentals', 'cancel', 'Cancel quotes and bookings, with a cancellation charge', 544),
 ('rentals', 'refund', 'Hand back deposits and advances held for bookings', 545),
 ('rentals', 'print', 'Print booking and handover slips and deposit receipts', 546)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'rentals'
UNION ALL SELECT 'cashier', unnest(ARRAY['rentals.view', 'rentals.create', 'rentals.edit', 'rentals.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['rentals.view', 'rentals.edit', 'rentals.print'])
UNION ALL SELECT 'accountant', unnest(ARRAY['rentals.view', 'rentals.print'])
UNION ALL SELECT 'viewer', unnest(ARRAY['rentals.view']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'rentals'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;

-- Existing rental businesses get the tool a new one starts with (where what it needs is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'rentals'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Bookings are numbered (RN/2627/0001). The kinds list is widened by reading
-- the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'rental' = ANY(kinds) THEN kinds := array_append(kinds, 'rental'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- A deposit (or an advance) held for a booking is handed back from the booking.
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical', 'garage', 'laundry', 'rentals'));

-- History is kept as it was written.
CREATE FUNCTION rental_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rental_booking_events' THEN
    RAISE EXCEPTION 'A booking''s history is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'rental_receipts' THEN
    RAISE EXCEPTION 'An advance or deposit taken for a booking stays with it' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A return is kept as it was taken' USING ERRCODE = '23514';
END $$;

-- An instant as people read it on the business's clock: "26 Oct, 10:00 am".
CREATE FUNCTION rental_time_words(moment TIMESTAMPTZ, tz TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT to_char(moment AT TIME ZONE tz, 'FMDD Mon, FMHH12:MI am');
$$;

-- --- Settings ------------------------------------------------------------------------------------

-- One row per business, made when the settings are first saved.
CREATE TABLE rental_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- A hirer's photo ID is recorded at every handover (a self-drive vehicle always needs the driving licence).
  id_required BOOLEAN NOT NULL DEFAULT TRUE,
  -- The shop's own terms, printed on the booking and handover slips.
  terms VARCHAR(2000) CHECK (btrim(terms) <> ''),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Rental items and units ----------------------------------------------------------------------

CREATE TABLE rental_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The service item its hire is billed as: its name on the bill, GST slab and SAC.
  sku_id BIGINT NOT NULL,
  -- Hired one by one (each a unit with its own number), or from a pool of how many the shop has.
  kind TEXT NOT NULL CHECK (kind IN ('unit', 'pool')),
  pool_quantity INTEGER CHECK (pool_quantity BETWEEN 0 AND 1000000),
  -- A motor vehicle: a car (a motor cab), a motorcycle or scooter, or another;
  -- self-drive, or hired with the shop's driver (the hirer does not drive).
  vehicle TEXT CHECK (vehicle IN ('car', 'motorcycle', 'other')),
  with_driver BOOLEAN NOT NULL DEFAULT FALSE,
  -- What each unit's meter reads at the handover and the return: kilometres, or running hours.
  meter TEXT CHECK (meter IN ('km', 'hours')),
  description VARCHAR(300) CHECK (btrim(description) <> ''),
  -- The refundable deposit for each one hired.
  deposit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  -- The rates (in the business's price terms); a hire is billed at the cheapest mix of them that covers it.
  rate_hour NUMERIC(14,2) CHECK (rate_hour > 0),
  rate_day NUMERIC(14,2) CHECK (rate_day > 0),
  rate_week NUMERIC(14,2) CHECK (rate_week > 0),
  rate_month NUMERIC(14,2) CHECK (rate_month > 0),
  -- The shortest hire charged, in hours.
  min_hours SMALLINT NOT NULL DEFAULT 0 CHECK (min_hours BETWEEN 0 AND 2160),
  -- The turnaround time a unit or piece needs after a hire before the next.
  buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 10080),
  -- Late: no fee within the grace time; after it, every hour (or day) or part of one
  -- since it was due, at the late rate (none given: the item's hour or day rate).
  grace_minutes SMALLINT NOT NULL DEFAULT 0 CHECK (grace_minutes BETWEEN 0 AND 1440),
  late_per TEXT NOT NULL CHECK (late_per IN ('none', 'hour', 'day')),
  late_rate NUMERIC(14,2) CHECK (late_rate > 0),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku_id),
  CHECK (COALESCE(rate_hour, rate_day, rate_week, rate_month) IS NOT NULL),
  CHECK ((kind = 'pool') = (pool_quantity IS NOT NULL)),
  CHECK (kind = 'unit' OR (vehicle IS NULL AND meter IS NULL)),
  CHECK (vehicle IS NULL OR meter = 'km'),
  CHECK (NOT with_driver OR vehicle IS NOT NULL),
  CHECK (late_per <> 'none' OR late_rate IS NULL),
  CHECK (late_per = 'none' OR late_rate IS NOT NULL OR (late_per = 'hour' AND rate_hour IS NOT NULL) OR (late_per = 'day' AND rate_day IS NOT NULL))
);
CREATE INDEX rental_items_list ON rental_items(business_id, active, sort_order);

-- An item is billed as a service item of this business counted in services
-- (not goods, not a kit), keeps its item, its kind and whether it is a
-- vehicle, and is never deleted.
CREATE FUNCTION rental_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sku RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A rental item is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sku_id <> OLD.sku_id OR NEW.kind <> OLD.kind OR NEW.vehicle IS DISTINCT FROM OLD.vehicle OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A rental item keeps the item it is billed as, how it is hired out and whether it is a vehicle' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.kind, s.is_kit, s.unit INTO sku FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
  WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
  IF sku.kind IS DISTINCT FROM 'service' OR sku.is_kit OR sku.unit IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'A rental item is billed as a service item of this business, counted in services' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_items_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_items
  FOR EACH ROW EXECUTE FUNCTION rental_items_guard();

CREATE TABLE rental_units (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  label VARCHAR(80) NOT NULL CHECK (btrim(label) <> ''),
  -- A vehicle's registration as on its plate (letters and digits) or a machine's serial number.
  serial_no VARCHAR(30) CHECK (serial_no ~ '^[A-Z0-9][A-Z0-9/-]{0,29}$'),
  -- The latest meter reading: kilometres on a vehicle's odometer, or a machine's running hours.
  meter_reading NUMERIC(10,1) CHECK (meter_reading >= 0),
  -- In service, in maintenance (not handed over) or retired (not booked).
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance', 'retired')),
  status_note VARCHAR(300) CHECK (btrim(status_note) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, item_id) REFERENCES rental_items(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, item_id, id),
  CHECK (status = 'available' OR status_note IS NOT NULL)
);
CREATE UNIQUE INDEX rental_units_serial ON rental_units(business_id, serial_no) WHERE serial_no IS NOT NULL;
CREATE UNIQUE INDEX rental_units_label ON rental_units(business_id, item_id, lower(label));

-- A unit is of an item hired one by one (a vehicle's with its registration),
-- keeps its item, its meter never goes back, and it is never deleted.
CREATE FUNCTION rental_units_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A unit is never deleted; retire it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.item_id <> OLD.item_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A unit stays with its item' USING ERRCODE = '23514';
    END IF;
    IF OLD.meter_reading IS NOT NULL AND (NEW.meter_reading IS NULL OR NEW.meter_reading < OLD.meter_reading) THEN
      RAISE EXCEPTION 'The meter of % reads % already: a reading never goes back', OLD.label, OLD.meter_reading USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT kind, vehicle INTO item FROM rental_items WHERE business_id = NEW.business_id AND id = NEW.item_id;
  IF item.kind IS DISTINCT FROM 'unit' THEN
    RAISE EXCEPTION 'Units are kept for an item hired one by one; a pool keeps how many it has' USING ERRCODE = '23514';
  END IF;
  IF item.vehicle IS NOT NULL AND NEW.serial_no IS NULL THEN
    RAISE EXCEPTION 'A vehicle is kept with its registration number' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_units_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_units
  FOR EACH ROW EXECUTE FUNCTION rental_units_guard();

-- --- Bookings ------------------------------------------------------------------------------------

CREATE TABLE rental_bookings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  booking_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- The hirer's name and phone as they were when booked.
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_phone VARCHAR(30),
  status TEXT NOT NULL CHECK (status IN ('quote', 'reserved', 'out', 'returned', 'cancelled')),
  -- When it goes out and when it is due back (instants; shown on the business's clock).
  out_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  -- The hire of every line as priced, as one bill of it would be then (no late fee or charge).
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  subtotal NUMERIC(16,2) NOT NULL CHECK (subtotal >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  round_off NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (round_off > -1 AND round_off < 1),
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  -- The refundable deposit asked: each line's deposit for each one hired, added up.
  deposit_due NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (deposit_due >= 0),
  notes VARCHAR(500),
  -- The handover: when and by whom, the hirer's photo ID (of an Aadhaar card
  -- only the last four digits), the driving licence and its expiry for a
  -- self-drive vehicle, and a deposit taken below the one asked: who agreed and why.
  checked_out_at TIMESTAMPTZ,
  checked_out_by BIGINT REFERENCES users(id),
  checkout_key UUID,
  checkout_hash CHAR(64),
  id_kind TEXT CHECK (id_kind IN ('aadhaar', 'voter_id', 'driving_licence', 'passport', 'pan_card', 'other')),
  id_ref VARCHAR(30) CHECK (id_ref ~ '^[A-Z0-9/-]{2,30}$'),
  licence_no VARCHAR(30) CHECK (licence_no ~ '^[A-Z0-9/-]{5,30}$'),
  licence_valid_until DATE,
  deposit_waived_by BIGINT REFERENCES users(id),
  deposit_waiver VARCHAR(300) CHECK (btrim(deposit_waiver) <> ''),
  -- The last of it back, and the bill made then; or the bill of a cancellation charge.
  returned_at TIMESTAMPTZ,
  document_id BIGINT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  cancel_reason VARCHAR(300) CHECK (btrim(cancel_reason) <> ''),
  cancel_key UUID,
  cancel_hash CHAR(64),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, booking_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, checkout_key),
  UNIQUE (business_id, cancel_key),
  CHECK (due_at > out_at),
  CHECK (due_at <= out_at + interval '90 days'),
  CHECK (total = subtotal + tax + round_off),
  CHECK ((status IN ('out', 'returned')) = (checked_out_at IS NOT NULL)),
  CHECK ((checked_out_at IS NULL) = (checked_out_by IS NULL)),
  CHECK ((checked_out_at IS NULL) = (checkout_key IS NULL)),
  CHECK ((checkout_key IS NULL) = (checkout_hash IS NULL)),
  CHECK ((id_kind IS NULL) = (id_ref IS NULL)),
  CHECK (id_kind IS DISTINCT FROM 'aadhaar' OR id_ref ~ '^[0-9]{4}$'),
  CHECK ((licence_no IS NULL) = (licence_valid_until IS NULL)),
  CHECK (checked_out_at IS NOT NULL OR (id_kind IS NULL AND licence_no IS NULL AND deposit_waiver IS NULL)),
  CHECK ((deposit_waived_by IS NULL) = (deposit_waiver IS NULL)),
  CHECK ((status = 'returned') = (returned_at IS NOT NULL)),
  CHECK (status <> 'returned' OR document_id IS NOT NULL),
  CHECK (document_id IS NULL OR status IN ('returned', 'cancelled')),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_key IS NULL)),
  CHECK ((cancel_key IS NULL) = (cancel_hash IS NULL))
);
CREATE INDEX rental_bookings_period ON rental_bookings(business_id, created_at DESC);
CREATE INDEX rental_bookings_status ON rental_bookings(business_id, status, out_at);
CREATE INDEX rental_bookings_contact ON rental_bookings(business_id, contact_id);
CREATE INDEX rental_bookings_due ON rental_bookings(business_id, due_at) WHERE status = 'out';
CREATE TRIGGER rental_bookings_customer BEFORE INSERT ON rental_bookings
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A booking starts as a quote or reserved, today or later on the business's
-- clock, with nothing handed over, back or cancelled.
CREATE FUNCTION rental_bookings_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT;
BEGIN
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  IF NEW.status NOT IN ('quote', 'reserved') THEN
    RAISE EXCEPTION 'A booking starts as a quote or reserved' USING ERRCODE = '23514';
  END IF;
  IF NEW.out_at < (date_trunc('day', now() AT TIME ZONE zone) AT TIME ZONE zone) THEN
    RAISE EXCEPTION 'A booking starts today or later' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'A booking is made when it is saved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_bookings_insert_check BEFORE INSERT ON rental_bookings
  FOR EACH ROW EXECUTE FUNCTION rental_bookings_insert_check();

-- A booking keeps its number, hirer and where it was made, and is never
-- deleted. It goes quote → reserved → out → returned, or is cancelled before
-- it is handed over. Its out time changes until it is handed over and its due
-- time until it is back (then it is priced again); what was recorded at the
-- handover is written once, with the handover; the bill is given once, when
-- the last of it is back or with a cancellation charge. A returned or
-- cancelled booking no longer changes. At the handover every unit is in
-- service, the deposit held is the one asked unless someone agreed to less,
-- and a self-drive vehicle goes out on a driving licence in force that day.
CREATE FUNCTION rental_bookings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT; unit RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A booking is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('returned', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
      RAISE EXCEPTION 'Booking % is % and no longer changes', OLD.booking_no, OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.booking_no <> OLD.booking_no OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.contact_id <> OLD.contact_id
     OR NEW.customer_name <> OLD.customer_name OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone OR NEW.request_key <> OLD.request_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A booking keeps its number, its hirer and where it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'quote' AND NEW.status IN ('reserved', 'cancelled'))
       OR (OLD.status = 'reserved' AND NEW.status IN ('out', 'cancelled')) OR (OLD.status = 'out' AND NEW.status = 'returned')) THEN
    RAISE EXCEPTION 'Booking % cannot go from % to %', OLD.booking_no, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  IF NEW.out_at <> OLD.out_at AND OLD.status NOT IN ('quote', 'reserved') THEN
    RAISE EXCEPTION 'Booking % is handed over: its out time stays as it was', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.out_at <> OLD.out_at OR (OLD.status = 'quote' AND NEW.status = 'reserved'))
     AND NEW.out_at < (date_trunc('day', now() AT TIME ZONE zone) AT TIME ZONE zone) THEN
    RAISE EXCEPTION 'Booking % would start on a day that has passed: give it times today or later', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_out_at, NEW.checked_out_by, NEW.checkout_key, NEW.checkout_hash, NEW.id_kind, NEW.id_ref, NEW.licence_no, NEW.licence_valid_until,
      NEW.deposit_waived_by, NEW.deposit_waiver) IS DISTINCT FROM (OLD.checked_out_at, OLD.checked_out_by, OLD.checkout_key, OLD.checkout_hash, OLD.id_kind,
      OLD.id_ref, OLD.licence_no, OLD.licence_valid_until, OLD.deposit_waived_by, OLD.deposit_waiver)
     AND NOT (OLD.status = 'reserved' AND NEW.status = 'out') THEN
    RAISE EXCEPTION 'Booking %: what was recorded at the handover stays as it was', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.returned_at IS DISTINCT FROM OLD.returned_at AND NOT (OLD.status = 'out' AND NEW.status = 'returned') THEN
    RAISE EXCEPTION 'Booking % is back when the last of it is returned', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason, NEW.cancel_key, NEW.cancel_hash) IS DISTINCT FROM
     (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason, OLD.cancel_key, OLD.cancel_hash) AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Booking %: a cancellation is recorded when it is cancelled', OLD.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    IF OLD.document_id IS NOT NULL OR NEW.status = OLD.status THEN
      RAISE EXCEPTION 'Booking % is billed once: when the last of it is back, or with a cancellation charge', OLD.booking_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale' AND contact_id = NEW.contact_id) THEN
      RAISE EXCEPTION 'Booking % is billed on a sale to its hirer', OLD.booking_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'out' THEN
    SELECT u.label, u.status INTO unit FROM rental_booking_lines l JOIN rental_units u ON u.business_id = l.business_id AND u.id = l.unit_id
    WHERE l.business_id = NEW.business_id AND l.booking_id = NEW.id AND u.status <> 'available' ORDER BY l.seq LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION '% is % and is not handed over', unit.label, CASE unit.status WHEN 'maintenance' THEN 'in maintenance' ELSE 'retired' END USING ERRCODE = '23514';
    END IF;
    IF rental_deposit_held(NEW.business_id, NEW.id) < NEW.deposit_due AND NEW.deposit_waiver IS NULL THEN
      RAISE EXCEPTION 'Booking % asks a deposit of %: take the rest, or record who agreed to less', OLD.booking_no, NEW.deposit_due USING ERRCODE = '23514';
    END IF;
    IF NEW.licence_valid_until IS NOT NULL AND NEW.licence_valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'The driving licence % ran out on %: a vehicle is not handed over on it', NEW.licence_no, to_char(NEW.licence_valid_until, 'FMDD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
    IF NEW.licence_no IS NULL AND EXISTS (SELECT 1 FROM rental_booking_lines l JOIN rental_items i ON i.business_id = l.business_id AND i.id = l.item_id
       WHERE l.business_id = NEW.business_id AND l.booking_id = NEW.id AND i.vehicle IS NOT NULL AND NOT i.with_driver) THEN
      RAISE EXCEPTION 'A self-drive vehicle is handed over with the hirer''s driving licence number and expiry' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_bookings_guard BEFORE UPDATE OR DELETE ON rental_bookings
  FOR EACH ROW EXECUTE FUNCTION rental_bookings_guard();

CREATE TABLE rental_booking_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  -- Its place on the booking (1, 2, 3 …).
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 50),
  item_id BIGINT NOT NULL,
  -- The unit, for an item hired one by one; how many from the pool otherwise.
  unit_id BIGINT,
  -- As booked: the item's hire service and name, the unit's name and number.
  sku_id BIGINT NOT NULL,
  item_name VARCHAR(150) NOT NULL CHECK (btrim(item_name) <> ''),
  unit_label VARCHAR(80),
  serial_no VARCHAR(30),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  -- The item's rates and rules as booked (the late rate as it applies: the
  -- one set, or the item's hour or day rate).
  rate_hour NUMERIC(14,2) CHECK (rate_hour > 0),
  rate_day NUMERIC(14,2) CHECK (rate_day > 0),
  rate_week NUMERIC(14,2) CHECK (rate_week > 0),
  rate_month NUMERIC(14,2) CHECK (rate_month > 0),
  min_hours SMALLINT NOT NULL CHECK (min_hours BETWEEN 0 AND 2160),
  buffer_minutes INTEGER NOT NULL CHECK (buffer_minutes BETWEEN 0 AND 10080),
  grace_minutes SMALLINT NOT NULL CHECK (grace_minutes BETWEEN 0 AND 1440),
  late_per TEXT NOT NULL CHECK (late_per IN ('none', 'hour', 'day')),
  late_rate NUMERIC(14,2) CHECK (late_rate > 0),
  deposit_each NUMERIC(14,2) NOT NULL CHECK (deposit_each >= 0),
  -- The hire for the booked period: the hours charged (each hour or part of
  -- one, never less than the minimum), the cheapest mix of months (30 days),
  -- weeks, days and hours that covers them, the price of one for it at the
  -- booked rates, the line (that times how many), and its GST as priced.
  charged_hours INTEGER NOT NULL CHECK (charged_hours BETWEEN 1 AND 2160),
  months SMALLINT NOT NULL DEFAULT 0 CHECK (months >= 0),
  weeks SMALLINT NOT NULL DEFAULT 0 CHECK (weeks >= 0),
  days SMALLINT NOT NULL DEFAULT 0 CHECK (days >= 0),
  hours SMALLINT NOT NULL DEFAULT 0 CHECK (hours >= 0),
  price NUMERIC(14,2) NOT NULL CHECK (price > 0),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate BETWEEN 0 AND 100),
  net NUMERIC(16,2) NOT NULL CHECK (net >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  -- At the handover: what was noted about it, its meter and its fuel.
  out_note VARCHAR(300) CHECK (btrim(out_note) <> ''),
  meter_out NUMERIC(10,1) CHECK (meter_out >= 0),
  fuel_out TEXT CHECK (fuel_out IN ('empty', 'quarter', 'half', 'three_quarters', 'full')),
  -- The bill line that charged its hire.
  line_id BIGINT,
  FOREIGN KEY (business_id, booking_id) REFERENCES rental_bookings(business_id, id),
  FOREIGN KEY (business_id, item_id) REFERENCES rental_items(business_id, id),
  FOREIGN KEY (business_id, item_id, unit_id) REFERENCES rental_units(business_id, item_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, booking_id, id),
  UNIQUE (business_id, booking_id, seq),
  UNIQUE (business_id, line_id),
  CHECK (unit_id IS NULL OR quantity = 1),
  CHECK ((unit_id IS NULL) = (unit_label IS NULL)),
  CHECK (COALESCE(rate_hour, rate_day, rate_week, rate_month) IS NOT NULL),
  CHECK ((late_per = 'none') = (late_rate IS NULL)),
  CHECK ((months = 0 OR rate_month IS NOT NULL) AND (weeks = 0 OR rate_week IS NOT NULL) AND (days = 0 OR rate_day IS NOT NULL) AND (hours = 0 OR rate_hour IS NOT NULL)),
  CHECK (months * 720 + weeks * 168 + days * 24 + hours >= charged_hours),
  CHECK (price = months * COALESCE(rate_month, 0) + weeks * COALESCE(rate_week, 0) + days * COALESCE(rate_day, 0) + hours * COALESCE(rate_hour, 0)),
  CHECK (amount = price * quantity),
  CHECK (net = amount OR net + tax = amount)
);
CREATE INDEX rental_booking_lines_item ON rental_booking_lines(business_id, item_id);
CREATE INDEX rental_booking_lines_unit ON rental_booking_lines(business_id, unit_id) WHERE unit_id IS NOT NULL;
-- A unit is on a booking once, and a pool item on one line of it.
CREATE UNIQUE INDEX rental_booking_lines_one_unit ON rental_booking_lines(business_id, booking_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE UNIQUE INDEX rental_booking_lines_one_pool ON rental_booking_lines(business_id, booking_id, item_id) WHERE unit_id IS NULL;

-- A line goes on a quote or a reserved booking, of its item's hire service:
-- a unit of the item (not retired) for an item hired one by one, how many
-- from the pool otherwise; with nothing handed over or billed. It keeps its
-- item and unit; how many changes until it is handed over, and its price
-- until it is back (an extension is priced again). What was noted at the
-- handover is written once, with the handover, and the bill line once, with
-- the bill. It is taken off only before the handover.
CREATE FUNCTION rental_booking_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking RECORD; item RECORD; unit RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT booking_no, status INTO booking FROM rental_bookings WHERE business_id = OLD.business_id AND id = OLD.booking_id;
    IF booking.status NOT IN ('quote', 'reserved') THEN
      RAISE EXCEPTION 'Booking % is handed over: its lines stay', booking.booking_no USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT booking_no, status, contact_id INTO booking FROM rental_bookings WHERE business_id = NEW.business_id AND id = NEW.booking_id;
  IF TG_OP = 'INSERT' THEN
    IF booking.status NOT IN ('quote', 'reserved') THEN
      RAISE EXCEPTION 'Booking % is handed over: nothing more goes on it. Make a new booking.', booking.booking_no USING ERRCODE = '23514';
    END IF;
    SELECT kind, sku_id, active INTO item FROM rental_items WHERE business_id = NEW.business_id AND id = NEW.item_id;
    IF NEW.sku_id IS DISTINCT FROM item.sku_id THEN
      RAISE EXCEPTION 'A line is billed as the hire service of its item' USING ERRCODE = '23514';
    END IF;
    IF NOT item.active THEN
      RAISE EXCEPTION '% is switched off: switch it on to book it', NEW.item_name USING ERRCODE = '23514';
    END IF;
    IF (item.kind = 'unit') <> (NEW.unit_id IS NOT NULL) THEN
      RAISE EXCEPTION 'An item hired one by one is booked by its unit; a pool by how many' USING ERRCODE = '23514';
    END IF;
    IF NEW.unit_id IS NOT NULL THEN
      SELECT label, status INTO unit FROM rental_units WHERE business_id = NEW.business_id AND id = NEW.unit_id;
      IF unit.status = 'retired' THEN
        RAISE EXCEPTION '% is retired and is not booked', unit.label USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.out_note IS NOT NULL OR NEW.meter_out IS NOT NULL OR NEW.fuel_out IS NOT NULL OR NEW.line_id IS NOT NULL THEN
      RAISE EXCEPTION 'A line starts with nothing handed over or billed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.booking_id <> OLD.booking_id OR NEW.seq <> OLD.seq OR NEW.item_id <> OLD.item_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.sku_id <> OLD.sku_id
     OR NEW.item_name <> OLD.item_name OR NEW.unit_label IS DISTINCT FROM OLD.unit_label OR NEW.serial_no IS DISTINCT FROM OLD.serial_no THEN
    RAISE EXCEPTION 'A line of booking % keeps its item and unit', booking.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.quantity <> OLD.quantity AND booking.status NOT IN ('quote', 'reserved') THEN
    RAISE EXCEPTION 'Booking % is handed over: how many went out stays', booking.booking_no USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['quantity', 'out_note', 'meter_out', 'fuel_out', 'line_id']) <> (to_jsonb(OLD) - ARRAY['quantity', 'out_note', 'meter_out', 'fuel_out', 'line_id'])
     AND booking.status NOT IN ('quote', 'reserved', 'out') THEN
    RAISE EXCEPTION 'Booking % is back: its prices stay as billed', booking.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.out_note, NEW.meter_out, NEW.fuel_out) IS DISTINCT FROM (OLD.out_note, OLD.meter_out, OLD.fuel_out)
     AND (booking.status <> 'out' OR OLD.out_note IS NOT NULL OR OLD.meter_out IS NOT NULL OR OLD.fuel_out IS NOT NULL
       OR EXISTS (SELECT 1 FROM rental_bookings WHERE business_id = NEW.business_id AND id = NEW.booking_id AND checked_out_at <> now())) THEN
    RAISE EXCEPTION 'Booking %: what was noted at the handover stays as it was', booking.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.line_id IS DISTINCT FROM OLD.line_id THEN
    IF OLD.line_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM business_document_lines dl JOIN business_documents d ON d.business_id = dl.business_id AND d.id = dl.document_id
         WHERE dl.business_id = NEW.business_id AND dl.id = NEW.line_id AND dl.sku_id = NEW.sku_id AND d.kind = 'sale' AND d.contact_id = booking.contact_id) THEN
      RAISE EXCEPTION 'A line of booking % is billed once, on a line of its own item on a bill to its hirer', booking.booking_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_booking_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_booking_lines
  FOR EACH ROW EXECUTE FUNCTION rental_booking_lines_guard();

-- --- Advances and deposits -----------------------------------------------------------------------

CREATE TABLE rental_receipts (
  business_id BIGINT NOT NULL,
  -- The core collection receipt in the hirer's name.
  collection_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  -- An advance (money on account for the hire) or a refundable deposit.
  purpose TEXT NOT NULL CHECK (purpose IN ('advance', 'deposit')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, collection_id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, booking_id) REFERENCES rental_bookings(business_id, id)
);
CREATE INDEX rental_receipts_booking ON rental_receipts(business_id, booking_id);
CREATE TRIGGER rental_receipts_append_only BEFORE UPDATE OR DELETE ON rental_receipts
  FOR EACH ROW EXECUTE FUNCTION rental_append_only();

-- The deposits still held for a booking: what its deposit receipts took, less
-- what paid its bill and what was handed back.
CREATE FUNCTION rental_deposit_held(target_business BIGINT, target_booking BIGINT) RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(k.amount
    - COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id = k.business_id AND p.collection_id = k.id), 0)
    - COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id = k.business_id AND f.collection_id = k.id), 0)), 0)
  FROM rental_receipts r JOIN business_collections k ON k.business_id = r.business_id AND k.id = r.collection_id
  WHERE r.business_id = target_business AND r.booking_id = target_booking AND r.purpose = 'deposit';
$$;

-- A receipt is taken for a booking reserved or out, in the hirer's name, by
-- cash, card, UPI or bank, when it is written.
CREATE FUNCTION rental_receipts_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking RECORD; receipt RECORD;
BEGIN
  SELECT booking_no, status, contact_id INTO booking FROM rental_bookings WHERE business_id = NEW.business_id AND id = NEW.booking_id;
  SELECT contact_id, method, created_at INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF booking.status NOT IN ('reserved', 'out') THEN
    RAISE EXCEPTION 'Booking % is %: an advance or a deposit is taken while it is reserved or out', booking.booking_no, booking.status USING ERRCODE = '23514';
  END IF;
  IF receipt.contact_id <> booking.contact_id OR receipt.method NOT IN ('cash', 'card', 'upi', 'bank') OR receipt.created_at <> now() THEN
    RAISE EXCEPTION 'An advance or deposit for booking % is a new receipt in its hirer''s name, by cash, card, UPI or bank', booking.booking_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_receipts_check BEFORE INSERT ON rental_receipts
  FOR EACH ROW EXECUTE FUNCTION rental_receipts_check();

-- --- Returns and charges -------------------------------------------------------------------------

CREATE TABLE rental_returns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  -- The last of the booking back, with the bill posted then.
  final BOOLEAN NOT NULL DEFAULT FALSE,
  document_id BIGINT,
  note VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  -- When it came back.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, booking_id) REFERENCES rental_bookings(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, booking_id, id),
  UNIQUE (business_id, request_key),
  CHECK (final = (document_id IS NOT NULL))
);
CREATE INDEX rental_returns_booking ON rental_returns(business_id, booking_id, id);
CREATE TRIGGER rental_returns_append_only BEFORE UPDATE OR DELETE ON rental_returns
  FOR EACH ROW EXECUTE FUNCTION rental_append_only();

-- A return is of a booking that is out, when it is written; its bill is a sale to the hirer.
CREATE FUNCTION rental_returns_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking RECORD;
BEGIN
  SELECT booking_no, status, contact_id INTO booking FROM rental_bookings WHERE business_id = NEW.business_id AND id = NEW.booking_id;
  IF booking.status <> 'out' THEN
    RAISE EXCEPTION 'Booking % is %: things come back on a booking that is out', booking.booking_no, booking.status USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'A return is written when things come back' USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id
     AND kind = 'sale' AND contact_id = booking.contact_id) THEN
    RAISE EXCEPTION 'Booking % is billed on a sale to its hirer', booking.booking_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_returns_check BEFORE INSERT ON rental_returns
  FOR EACH ROW EXECUTE FUNCTION rental_returns_check();

CREATE TABLE rental_return_lines (
  business_id BIGINT NOT NULL,
  return_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  -- How many came back now, and how many will not (lost: charged as missing).
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  missing INTEGER NOT NULL DEFAULT 0 CHECK (missing >= 0),
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  meter_in NUMERIC(10,1) CHECK (meter_in >= 0),
  fuel_in TEXT CHECK (fuel_in IN ('empty', 'quarter', 'half', 'three_quarters', 'full')),
  -- How late it came back (minutes past its due time), the hours or days
  -- charged after the grace time, and the late fee for those back late.
  late_minutes INTEGER NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  late_units INTEGER NOT NULL DEFAULT 0 CHECK (late_units >= 0),
  late_fee NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (late_fee >= 0),
  -- The bill line that charged the late fee.
  late_line_id BIGINT,
  -- The unit went for maintenance.
  maintenance BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (business_id, return_id, line_id),
  FOREIGN KEY (business_id, booking_id, return_id) REFERENCES rental_returns(business_id, booking_id, id),
  FOREIGN KEY (business_id, booking_id, line_id) REFERENCES rental_booking_lines(business_id, booking_id, id),
  FOREIGN KEY (business_id, late_line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, late_line_id),
  CHECK (quantity + missing > 0),
  CHECK ((late_units = 0) = (late_fee = 0)),
  CHECK (late_line_id IS NULL OR late_fee > 0)
);
CREATE INDEX rental_return_lines_line ON rental_return_lines(business_id, line_id);

-- What comes back is of the booking's lines still out: a unit whole, a pool
-- no more than is out. Its meter does not read less than at the handover.
-- Its lateness is from the line's due time to now, and its late fee is the
-- hours or days after the grace time at the booked late rate, for each one
-- back. A return line is kept as it was taken; its bill line is given once,
-- a line of its item's hire service on a bill to the hirer.
CREATE FUNCTION rental_return_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; back INTEGER; minutes INTEGER; units INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A return is kept as it was taken' USING ERRCODE = '23514';
  END IF;
  IF NEW.late_line_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.late_line_id IS NULL) AND NOT EXISTS (
       SELECT 1 FROM business_document_lines dl JOIN business_documents d ON d.business_id = dl.business_id AND d.id = dl.document_id
       JOIN rental_booking_lines l ON l.business_id = dl.business_id AND l.sku_id = dl.sku_id JOIN rental_bookings b ON b.business_id = l.business_id AND b.id = l.booking_id
       WHERE dl.business_id = NEW.business_id AND dl.id = NEW.late_line_id AND l.id = NEW.line_id AND d.kind = 'sale' AND d.contact_id = b.contact_id) THEN
    RAISE EXCEPTION 'A late fee is billed on a line of its item''s hire service, on a bill to the hirer' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'late_line_id') <> (to_jsonb(OLD) - 'late_line_id') OR OLD.late_line_id IS NOT NULL OR NEW.late_fee = 0 THEN
      RAISE EXCEPTION 'A return is kept as it was taken' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT l.*, b.due_at, b.booking_no INTO line FROM rental_booking_lines l JOIN rental_bookings b ON b.business_id = l.business_id AND b.id = l.booking_id
  WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id;
  back := COALESCE((SELECT sum(quantity + missing) FROM rental_return_lines WHERE business_id = NEW.business_id AND line_id = NEW.line_id), 0);
  IF back + NEW.quantity + NEW.missing > line.quantity THEN
    RAISE EXCEPTION '% of % % went out on booking %: % more come back at most', line.quantity, line.item_name, COALESCE(line.unit_label, ''), line.booking_no,
      line.quantity - back USING ERRCODE = '23514';
  END IF;
  IF NEW.meter_in IS NOT NULL AND line.meter_out IS NOT NULL AND NEW.meter_in < line.meter_out THEN
    RAISE EXCEPTION '% went out reading %: it cannot come back reading less', COALESCE(line.unit_label, line.item_name), line.meter_out USING ERRCODE = '23514';
  END IF;
  minutes := GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - line.due_at)) / 60))::int;
  units := CASE WHEN line.late_per = 'none' OR minutes <= line.grace_minutes THEN 0
    WHEN line.late_per = 'hour' THEN ceil(minutes / 60.0)::int ELSE ceil(minutes / 1440.0)::int END;
  IF NEW.late_minutes <> minutes OR NEW.late_units <> (CASE WHEN NEW.quantity > 0 THEN units ELSE 0 END)
     OR NEW.late_fee <> (CASE WHEN NEW.quantity > 0 THEN units * COALESCE(line.late_rate, 0) * NEW.quantity ELSE 0 END) THEN
    RAISE EXCEPTION 'The late fee of % on booking % is worked out from its due time and its booked late rate', line.item_name, line.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.maintenance AND line.unit_id IS NULL THEN
    RAISE EXCEPTION 'A unit goes for maintenance; a pool keeps how many it has' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_return_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_return_lines
  FOR EACH ROW EXECUTE FUNCTION rental_return_lines_guard();

CREATE TABLE rental_charges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  -- Noted at a return (damage, missing, cleaning, fuel, other), or when cancelling (cancellation).
  return_id BIGINT,
  booking_line_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('damage', 'missing', 'cleaning', 'fuel', 'other', 'cancellation')),
  -- In the business's price terms: before GST, or with GST in it.
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  -- The bill line that charged it.
  line_id BIGINT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, booking_id) REFERENCES rental_bookings(business_id, id),
  FOREIGN KEY (business_id, booking_id, return_id) REFERENCES rental_returns(business_id, booking_id, id),
  FOREIGN KEY (business_id, booking_id, booking_line_id) REFERENCES rental_booking_lines(business_id, booking_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, line_id),
  CHECK ((kind = 'cancellation') = (return_id IS NULL)),
  CHECK (kind NOT IN ('damage', 'other') OR note IS NOT NULL)
);
CREATE INDEX rental_charges_booking ON rental_charges(business_id, booking_id, id);

-- A charge is noted at a return of a booking out, or when a quote or reserved
-- booking is cancelled; it is kept as noted, and its bill line is given once,
-- a line of its item's hire service on a bill to the hirer.
CREATE FUNCTION rental_charges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A charge is kept as it was noted' USING ERRCODE = '23514';
  END IF;
  SELECT booking_no, status, contact_id INTO booking FROM rental_bookings WHERE business_id = NEW.business_id AND id = NEW.booking_id;
  IF NEW.line_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.line_id IS NULL) AND NOT EXISTS (
       SELECT 1 FROM business_document_lines dl JOIN business_documents d ON d.business_id = dl.business_id AND d.id = dl.document_id
       JOIN rental_booking_lines l ON l.business_id = dl.business_id AND l.sku_id = dl.sku_id
       WHERE dl.business_id = NEW.business_id AND dl.id = NEW.line_id AND l.id = NEW.booking_line_id AND d.kind = 'sale' AND d.contact_id = booking.contact_id) THEN
    RAISE EXCEPTION 'A charge is billed on a line of its item''s hire service, on a bill to the hirer' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'line_id') <> (to_jsonb(OLD) - 'line_id') OR OLD.line_id IS NOT NULL THEN
      RAISE EXCEPTION 'A charge is kept as it was noted' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind = 'cancellation' AND booking.status NOT IN ('quote', 'reserved') THEN
    RAISE EXCEPTION 'Booking % is %: a cancellation charge goes on a booking being cancelled', booking.booking_no, booking.status USING ERRCODE = '23514';
  END IF;
  IF NEW.kind <> 'cancellation' AND booking.status <> 'out' THEN
    RAISE EXCEPTION 'Booking % is %: charges are noted when things come back', booking.booking_no, booking.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_charges_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_charges
  FOR EACH ROW EXECUTE FUNCTION rental_charges_guard();

-- --- History -------------------------------------------------------------------------------------

-- Everything that happened to a booking: a change of status (from and to), or a note with none.
CREATE TABLE rental_booking_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, booking_id) REFERENCES rental_bookings(business_id, id),
  CHECK (to_status IS NOT NULL OR note IS NOT NULL),
  CHECK (from_status IS NULL OR to_status IS NOT NULL)
);
CREATE INDEX rental_booking_events_booking ON rental_booking_events(business_id, booking_id, id);
CREATE TRIGGER rental_booking_events_append_only BEFORE UPDATE OR DELETE ON rental_booking_events
  FOR EACH ROW EXECUTE FUNCTION rental_append_only();

-- --- What is free --------------------------------------------------------------------------------

-- What holds a rental item's units or pool, as stretches of time:
--   booked  a reserved booking: from its out time to its due time and the turnaround time;
--   back    what came back of a booking handed over: until it came back and the turnaround time;
--   out     what is still out: until it is due (or now, while it is late) and the turnaround time.
-- What was reported missing holds nothing once reported (the pool is that much smaller).
CREATE FUNCTION rental_holds(target_business BIGINT, target_item BIGINT)
RETURNS TABLE (booking_id BIGINT, booking_no VARCHAR, customer_name VARCHAR, status TEXT, line_id BIGINT, unit_id BIGINT, part TEXT, quantity INTEGER,
  starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, due_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT b.id, b.booking_no, b.customer_name, b.status, l.id, l.unit_id, 'booked', l.quantity, b.out_at, b.due_at + make_interval(mins => l.buffer_minutes), b.due_at
  FROM rental_bookings b JOIN rental_booking_lines l ON l.business_id = b.business_id AND l.booking_id = b.id
  WHERE b.business_id = target_business AND l.item_id = target_item AND b.status = 'reserved'
  UNION ALL
  SELECT b.id, b.booking_no, b.customer_name, b.status, l.id, l.unit_id, 'back', rl.quantity, b.out_at, r.created_at + make_interval(mins => l.buffer_minutes), b.due_at
  FROM rental_bookings b JOIN rental_booking_lines l ON l.business_id = b.business_id AND l.booking_id = b.id
  JOIN rental_return_lines rl ON rl.business_id = l.business_id AND rl.line_id = l.id
  JOIN rental_returns r ON r.business_id = rl.business_id AND r.id = rl.return_id
  WHERE b.business_id = target_business AND l.item_id = target_item AND b.status IN ('out', 'returned') AND rl.quantity > 0
  UNION ALL
  SELECT b.id, b.booking_no, b.customer_name, b.status, l.id, l.unit_id, 'out', l.quantity - x.back, b.out_at,
    GREATEST(b.due_at, now()) + make_interval(mins => l.buffer_minutes), b.due_at
  FROM rental_bookings b JOIN rental_booking_lines l ON l.business_id = b.business_id AND l.booking_id = b.id
  CROSS JOIN LATERAL (SELECT COALESCE(sum(rl.quantity + rl.missing), 0)::int AS back FROM rental_return_lines rl WHERE rl.business_id = l.business_id AND rl.line_id = l.id) x
  WHERE b.business_id = target_business AND l.item_id = target_item AND b.status = 'out' AND l.quantity > x.back;
$$;

-- The first hold on a unit that overlaps the time asked (its end already
-- with the asking line's turnaround time), leaving out a booking or a line's
-- own booked and still-out time.
CREATE FUNCTION rental_unit_clash(target_business BIGINT, target_item BIGINT, target_unit BIGINT, from_at TIMESTAMPTZ, until_at TIMESTAMPTZ,
  except_booking BIGINT, except_line BIGINT)
RETURNS TABLE (booking_id BIGINT, booking_no VARCHAR, customer_name VARCHAR, status TEXT, part TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, due_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT h.booking_id, h.booking_no, h.customer_name, h.status, h.part, h.starts_at, h.ends_at, h.due_at FROM rental_holds(target_business, target_item) h
  WHERE h.unit_id = target_unit AND h.starts_at < until_at AND h.ends_at > from_at
    AND (except_booking IS NULL OR h.booking_id <> except_booking) AND (except_line IS NULL OR h.line_id <> except_line OR h.part = 'back')
  ORDER BY h.starts_at, h.booking_id LIMIT 1;
$$;

-- The most of a pool held at once over the time asked, by the holds left after
-- leaving out a booking or a line's own booked and still-out time.
CREATE FUNCTION rental_pool_peak(target_business BIGINT, target_item BIGINT, from_at TIMESTAMPTZ, until_at TIMESTAMPTZ, except_booking BIGINT, except_line BIGINT)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  WITH h AS (SELECT * FROM rental_holds(target_business, target_item) x
    WHERE x.starts_at < until_at AND x.ends_at > from_at
      AND (except_booking IS NULL OR x.booking_id <> except_booking) AND (except_line IS NULL OR x.line_id <> except_line OR x.part = 'back')),
  points AS (SELECT from_at AS moment UNION SELECT GREATEST(h.starts_at, from_at) FROM h)
  SELECT COALESCE(max(used), 0)::int FROM (SELECT p.moment, sum(h.quantity) AS used FROM points p JOIN h ON h.starts_at <= p.moment AND h.ends_at > p.moment GROUP BY p.moment) u;
$$;

-- A booking line that holds something (its booking reserved or out) clashes
-- with nothing: its unit is held by no other booking over its time, and its
-- pool is never held more than the pool has. One item at a time: the item's
-- row is the lock, so two bookings saved together are checked one after the other.
CREATE FUNCTION rental_check_line(target_business BIGINT, target_line BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE l RECORD; b RECORD; zone TEXT; held INTEGER; held_from TIMESTAMPTZ; held_until TIMESTAMPTZ; clash RECORD; pool INTEGER; peak INTEGER;
BEGIN
  SELECT * INTO l FROM rental_booking_lines WHERE business_id = target_business AND id = target_line;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO b FROM rental_bookings WHERE business_id = target_business AND id = l.booking_id;
  IF b.status NOT IN ('reserved', 'out') THEN RETURN; END IF;
  SELECT pool_quantity INTO pool FROM rental_items WHERE business_id = target_business AND id = l.item_id FOR UPDATE;
  held := l.quantity - COALESCE((SELECT sum(rl.quantity + rl.missing) FROM rental_return_lines rl WHERE rl.business_id = target_business AND rl.line_id = l.id), 0);
  IF held <= 0 THEN RETURN; END IF;
  held_from := b.out_at;
  held_until := (CASE WHEN b.status = 'out' THEN GREATEST(b.due_at, now()) ELSE b.due_at END) + make_interval(mins => l.buffer_minutes);
  SELECT timezone INTO zone FROM businesses WHERE id = target_business;
  IF l.unit_id IS NOT NULL THEN
    SELECT * INTO clash FROM rental_unit_clash(target_business, l.item_id, l.unit_id, held_from, held_until, NULL, l.id);
    IF FOUND THEN
      IF clash.part = 'out' THEN
        RAISE EXCEPTION '% (%) is out on % with %, due back %: it is not free from % to %', l.unit_label, l.item_name, clash.booking_no, clash.customer_name,
          rental_time_words(clash.due_at, zone), rental_time_words(held_from, zone), rental_time_words(b.due_at, zone) USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION '% (%) is booked on % for % from % until it is free again at %: it is not free from % to %', l.unit_label, l.item_name, clash.booking_no,
        clash.customer_name, rental_time_words(clash.starts_at, zone), rental_time_words(clash.ends_at, zone), rental_time_words(held_from, zone),
        rental_time_words(b.due_at, zone) USING ERRCODE = '23514';
    END IF;
  ELSE
    peak := rental_pool_peak(target_business, l.item_id, held_from, held_until, NULL, l.id);
    IF peak + held > pool THEN
      RAISE EXCEPTION 'Only % of the % % are free from % to %: % are booked then', GREATEST(pool - peak, 0), pool, l.item_name, rental_time_words(held_from, zone),
        rental_time_words(b.due_at, zone), peak USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

-- Every line of a booking that holds something.
CREATE FUNCTION rental_check_booking(target_business BIGINT, target_booking BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE line_ref BIGINT;
BEGIN
  FOR line_ref IN SELECT id FROM rental_booking_lines WHERE business_id = target_business AND booking_id = target_booking ORDER BY item_id, id LOOP
    PERFORM rental_check_line(target_business, line_ref);
  END LOOP;
END $$;

-- Checked when the work is saved (deferred), on the booking as it then is.
CREATE FUNCTION rental_booking_lines_available() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM rental_check_line(NEW.business_id, NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rental_booking_lines_available AFTER INSERT OR UPDATE OF quantity ON rental_booking_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rental_booking_lines_available();

CREATE FUNCTION rental_bookings_available() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('reserved', 'out') AND (NEW.status <> OLD.status OR NEW.out_at <> OLD.out_at OR NEW.due_at <> OLD.due_at) THEN
    PERFORM rental_check_booking(NEW.business_id, NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rental_bookings_available AFTER UPDATE ON rental_bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rental_bookings_available();

-- Down Migration
DROP TRIGGER rental_bookings_available ON rental_bookings;
DROP TRIGGER rental_booking_lines_available ON rental_booking_lines;
DROP FUNCTION rental_bookings_available();
DROP FUNCTION rental_booking_lines_available();
DROP FUNCTION rental_check_booking(BIGINT, BIGINT);
DROP FUNCTION rental_check_line(BIGINT, BIGINT);
DROP FUNCTION rental_pool_peak(BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT, BIGINT);
DROP FUNCTION rental_unit_clash(BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT, BIGINT);
DROP FUNCTION rental_holds(BIGINT, BIGINT);
DROP TABLE rental_booking_events, rental_charges, rental_return_lines, rental_returns, rental_receipts, rental_booking_lines, rental_bookings,
  rental_units, rental_items, rental_settings;
DROP FUNCTION rental_deposit_held(BIGINT, BIGINT);
DROP FUNCTION rental_charges_guard();
DROP FUNCTION rental_return_lines_guard();
DROP FUNCTION rental_returns_check();
DROP FUNCTION rental_receipts_check();
DROP FUNCTION rental_booking_lines_guard();
DROP FUNCTION rental_bookings_guard();
DROP FUNCTION rental_bookings_insert_check();
DROP FUNCTION rental_units_guard();
DROP FUNCTION rental_items_guard();
DROP FUNCTION rental_time_words(TIMESTAMPTZ, TEXT);
DROP FUNCTION rental_append_only();
-- Refuses while a deposit or an advance has been handed back from a booking (restore a backup instead).
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical', 'garage', 'laundry'));
DELETE FROM business_number_series WHERE document_kind = 'rental';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'rental');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
UPDATE platform_module_business_types SET recommended = FALSE, recommended_note = NULL WHERE module_code = 'licences' AND business_type = 'rentals';
DELETE FROM business_capabilities WHERE capability = 'rentals';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'rentals');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'rentals');
DELETE FROM business_permissions WHERE module_code = 'rentals';
DELETE FROM platform_module_business_types WHERE module_code = 'rentals';
DELETE FROM platform_module_dependencies WHERE module_code = 'rentals';
DELETE FROM platform_modules WHERE code = 'rentals';
