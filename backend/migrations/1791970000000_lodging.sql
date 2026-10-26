-- Up Migration
-- A hotel's, lodge's or guest house's own tools: its room types and their
-- rates, its rooms and their housekeeping status; reservations and the stays
-- they become, with every occupant recorded; the Form-III reports of its
-- foreign guests; the folio of room nights and extras, billed through the core
-- at check-out; and the guest register the police ask for.
--
-- Rooms & stays (module "lodging", on for type "lodging"):
--   lodging_settings          the two GST slabs a room night is billed at and the
--                             value a room night that divides them: from 22
--                             September 2025 accommodation valued at ₹7,500 or
--                             less per unit per day is 5% without input tax
--                             credit, and above it 18% with credit (Notification
--                             15/2025-Central Tax (Rate)); the nights of the week
--                             the weekend rate is for (Friday and Saturday until
--                             changed); the terms printed on the registration
--                             card. Nothing is reserved or billed until the two
--                             slabs are set.
--   lodging_room_types        each kind of room: the service item its room nights
--                             are billed as (counted in nights: its name and SAC
--                             on the bill), how many adults its rate is for, how
--                             many guests it takes and how many extra beds; its
--                             rate plan, each a night before GST (the slab is
--                             decided on the value before tax): the rack rate, a
--                             weekend rate, and each adult beyond the base, each
--                             child and each extra bed. Switched off, never deleted.
--   lodging_rooms             each room: its number, type, floor and location, and
--                             its status: vacant and clean, vacant and dirty,
--                             occupied (a guest is checked in), or out of order
--                             with the reason. Never deleted.
--   lodging_room_status_log   every change of a room's status, as it was made.
--   lodging_stays             a reservation and the stay it becomes
--                             (ST/2627/0001): the guest who booked and a company
--                             billed instead; where it came from (a walk-in, the
--                             phone, or an OTA with its booking id); the nights,
--                             from the arrival date to the departure date on the
--                             business's clock (a night belongs to the date it
--                             starts on); the room type and the room; adults,
--                             children and extra beds; the rates as booked, or a
--                             rate agreed for every night; the room nights as
--                             priced; reserved → in the house → checked out, or
--                             cancelled, or a no-show. A room is never booked
--                             twice over the same night: an exclusion constraint
--                             refuses it, even for two stays saved at the same
--                             moment; and a room type never holds more stays on a
--                             night than it has rooms (checked when the work is
--                             saved, the room type's row the lock).
--   lodging_stay_guests       every occupant, not only the one who booked: name,
--                             adult or child, photo ID (of an Aadhaar card only the
--                             last four digits are kept) and nationality; for a
--                             foreigner (OCI cardholders included) the passport,
--                             the visa or OCI card, the date of arrival in India
--                             and the next destination, and the Form-III reports,
--                             each due within 24 hours of arrival and of
--                             departure (Immigration and Foreigners Act 2025, in
--                             force from 1 September 2025), marked reported with
--                             the portal's acknowledgement number. The portal is
--                             web-only: nothing is sent from here. Kept, never
--                             deleted: the records are kept at least a year.
--   lodging_receipts          advances and deposits taken for a stay: core
--                             collection receipts in the guest's name, held for
--                             the stay's own bill.
--   lodging_charges           the folio: a charge for each room night, posted by
--                             the night audit or at check-out at that night's rate
--                             and with its own slab, decided by the night's value;
--                             extras (laundry, food, a pickup: service items at
--                             their own slabs); a cancellation or no-show charge.
--                             Kept as posted; a mistake is voided with a reason.
--   lodging_stay_events       everything that happened to a stay, as written.
-- A stay's bill is one core sale at check-out, to the guest or to the company
-- (its GSTIN on the invoice), paid first by the stay's advances and deposits;
-- what is left of them is handed back with a manager's PIN. A room type's
-- nights are billed on no other bill.

-- --- Module, permissions and roles ------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('lodging', 'Rooms & stays', 'Room types with their rates and rooms with their housekeeping status; reservations from walk-ins, the phone and OTAs, with an advance; check-in to a room never booked twice, every occupant recorded with their ID; Form-III countdowns for foreign guests; the night audit posting each room night at its own GST slab; the folio billed at check-out to the guest or a company; the guest register.', 'optional', 243);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('lodging', 'catalog'), ('lodging', 'contacts'), ('lodging', 'sales');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('lodging', 'lodging', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('lodging', 'view', 'See rooms and their status, reservations, stays and their folios', 560),
 ('lodging', 'create', 'Take reservations, check guests in and out with every occupant, post charges, run the night audit, record Form-III', 561),
 ('lodging', 'edit', 'Mark rooms clean or dirty, and put them out of order and back', 562),
 ('lodging', 'approve', 'Change the rates of a guest in the house, void a posted charge, and check a guest out with the bill left to pay', 563),
 ('lodging', 'cancel', 'Cancel reservations and mark no-shows, with a cancellation charge', 564),
 ('lodging', 'refund', 'Hand back advances and deposits held for stays', 565),
 ('lodging', 'print', 'Print registration cards and the guest register, with the guests'' ID details', 566)
) AS p(module_code, action, name, sort_order);

-- The front desk and housekeeping, roles of a lodging business only.
INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types) VALUES
 ('front_desk', 'Front desk', 'Reservations, check-in with every occupant and their photo ID, Form-III reports, charges on the folio, the night audit and check-out with its bill; takes advances and cancels reservations. Changes no settings and hands no money back.', FALSE, 41, ARRAY['lodging']),
 ('housekeeping', 'Housekeeping', 'Sees the rooms and marks them clean or dirty, out of order and back in order. Sees no money and no guest''s ID.', FALSE, 42, ARRAY['lodging']);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'lodging'
UNION ALL SELECT 'cashier', unnest(ARRAY['lodging.view', 'lodging.create', 'lodging.edit', 'lodging.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['lodging.view'])
UNION ALL SELECT 'accountant', unnest(ARRAY['lodging.view', 'lodging.print'])
UNION ALL SELECT 'viewer', unnest(ARRAY['lodging.view'])
UNION ALL SELECT 'front_desk', unnest(ARRAY['lodging.view', 'lodging.create', 'lodging.edit', 'lodging.cancel', 'lodging.print', 'catalog.view', 'contacts.view',
  'contacts.create', 'sales.view', 'sales.create', 'sales.edit', 'sales.print', 'receivables.view', 'receivables.create', 'receivables.print'])
UNION ALL SELECT 'housekeeping', unnest(ARRAY['lodging.view', 'lodging.edit']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template"), and the new
-- roles in existing lodging businesses.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'lodging'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;
SELECT business_seed_roles(id) FROM businesses WHERE business_type = 'lodging';

-- Existing lodging businesses get the tool a new one starts with (where what it needs is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'lodging'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Stays are numbered (ST/2627/0001). The kinds list is widened by reading
-- the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'stay' = ANY(kinds) THEN kinds := array_append(kinds, 'stay'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- An advance (or a deposit) held for a stay is handed back from the stay.
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical', 'garage', 'laundry', 'rentals', 'lodging'));

-- History is kept as it was written.
CREATE FUNCTION lodging_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'lodging_stay_events' THEN
    RAISE EXCEPTION 'A stay''s history is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'lodging_receipts' THEN
    RAISE EXCEPTION 'An advance or deposit taken for a stay stays with it' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A room''s status history is kept as it was written' USING ERRCODE = '23514';
END $$;

-- The business's own date (its time zone): a night belongs to the date it starts on.
CREATE FUNCTION lodging_today(target_business BIGINT) RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE timezone)::date FROM businesses WHERE id = target_business;
$$;

-- A date as people read it: "26 Oct".
CREATE FUNCTION lodging_day_words(day DATE) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT to_char(day, 'FMDD Mon');
$$;

-- --- Settings ------------------------------------------------------------------------------------

-- One row per business, made when the settings are first saved.
CREATE TABLE lodging_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- The slab of a room night valued at or below the limit (5% without input
  -- tax credit from 22 September 2025), and of one above it (18% with credit).
  low_tax_rate_id BIGINT,
  high_tax_rate_id BIGINT,
  -- The value of a room for a night (before GST) that divides the two slabs.
  slab_limit NUMERIC(14,2) NOT NULL DEFAULT 7500.00 CHECK (slab_limit > 0 AND slab_limit <= 10000000),
  -- The nights at the weekend rate, as days of the week (1 Monday … 7 Sunday) of the date a night starts on.
  weekend_nights SMALLINT[] NOT NULL DEFAULT '{5,6}' CHECK (weekend_nights <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]),
  -- The property's own terms, printed on the registration card.
  terms VARCHAR(2000) CHECK (btrim(terms) <> ''),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, low_tax_rate_id) REFERENCES business_tax_rates(business_id, id),
  FOREIGN KEY (business_id, high_tax_rate_id) REFERENCES business_tax_rates(business_id, id),
  CHECK ((low_tax_rate_id IS NULL) = (high_tax_rate_id IS NULL)),
  CHECK (low_tax_rate_id IS NULL OR low_tax_rate_id <> high_tax_rate_id)
);

-- The two slabs are slabs in use, the lower one below the higher.
CREATE FUNCTION lodging_settings_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE low RECORD; high RECORD;
BEGIN
  IF NEW.low_tax_rate_id IS NULL THEN RETURN NEW; END IF;
  SELECT name, rate, active INTO low FROM business_tax_rates WHERE business_id = NEW.business_id AND id = NEW.low_tax_rate_id;
  SELECT name, rate, active INTO high FROM business_tax_rates WHERE business_id = NEW.business_id AND id = NEW.high_tax_rate_id;
  IF NOT low.active OR NOT high.active THEN
    RAISE EXCEPTION 'Room nights are billed at GST slabs in use: switch the slab on again, or choose another' USING ERRCODE = '23514';
  END IF;
  IF low.rate >= high.rate THEN
    RAISE EXCEPTION 'A room night at or below the limit is billed at the lower slab and one above it at the higher: % is not below %', low.name, high.name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_settings_check BEFORE INSERT OR UPDATE ON lodging_settings
  FOR EACH ROW EXECUTE FUNCTION lodging_settings_check();

-- --- Room types and rooms ------------------------------------------------------------------------

CREATE TABLE lodging_room_types (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The service item its room nights are billed as, counted in nights: its name and SAC on the bill.
  sku_id BIGINT NOT NULL,
  -- How many adults the rate is for, the most guests (adults and children) the room takes, and its extra beds.
  base_occupancy SMALLINT NOT NULL CHECK (base_occupancy BETWEEN 1 AND 20),
  max_occupancy SMALLINT NOT NULL CHECK (max_occupancy BETWEEN 1 AND 30),
  max_extra_beds SMALLINT NOT NULL DEFAULT 0 CHECK (max_extra_beds BETWEEN 0 AND 5),
  -- The rate plan, each a night before GST: the rack rate; the weekend rate (on
  -- the settings' weekend nights); each adult beyond the base occupancy (none
  -- set: the room takes no more adults than that); each child (none set:
  -- children stay free); each extra bed.
  rack_rate NUMERIC(14,2) NOT NULL CHECK (rack_rate > 0),
  weekend_rate NUMERIC(14,2) CHECK (weekend_rate > 0),
  extra_adult_rate NUMERIC(14,2) CHECK (extra_adult_rate >= 0),
  child_rate NUMERIC(14,2) CHECK (child_rate >= 0),
  extra_bed_rate NUMERIC(14,2) CHECK (extra_bed_rate >= 0),
  description VARCHAR(300) CHECK (btrim(description) <> ''),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku_id),
  CHECK (max_occupancy >= base_occupancy),
  CHECK (max_extra_beds = 0 OR extra_bed_rate IS NOT NULL)
);
CREATE INDEX lodging_room_types_list ON lodging_room_types(business_id, active, sort_order);

-- A room type's nights are billed as a service item of this business counted
-- in nights (not a kit); it keeps that item, stays in use while stays of it
-- are reserved or in the house, and is never deleted.
CREATE FUNCTION lodging_room_types_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sku RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A room type is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sku_id <> OLD.sku_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A room type keeps the item its room nights are billed as' USING ERRCODE = '23514';
    END IF;
    IF OLD.active AND NOT NEW.active AND EXISTS (SELECT 1 FROM lodging_stays WHERE business_id = NEW.business_id AND room_type_id = NEW.id AND status IN ('reserved', 'in_house')) THEN
      RAISE EXCEPTION 'Stays of this room type are reserved or in the house: it stays in use until they are done' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.kind, s.is_kit, s.unit INTO sku FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
  WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
  IF sku.kind IS DISTINCT FROM 'service' OR sku.is_kit OR sku.unit IS DISTINCT FROM 'night' THEN
    RAISE EXCEPTION 'A room type''s nights are billed as a service item of this business counted in nights' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE lodging_rooms (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  room_type_id BIGINT NOT NULL,
  room_no VARCHAR(20) NOT NULL CHECK (room_no ~ '^[A-Za-z0-9][A-Za-z0-9 /-]{0,19}$'),
  floor VARCHAR(30) CHECK (btrim(floor) <> ''),
  -- Vacant and clean (ready for a guest), vacant and dirty (left, to be made up),
  -- occupied (a guest is checked in) or out of order (not sold: the note says why).
  status TEXT NOT NULL DEFAULT 'vacant_clean' CHECK (status IN ('vacant_clean', 'vacant_dirty', 'occupied', 'out_of_order')),
  status_note VARCHAR(300) CHECK (btrim(status_note) <> ''),
  -- Who changed the status last, and when.
  status_by BIGINT NOT NULL REFERENCES users(id),
  status_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, room_type_id) REFERENCES lodging_room_types(business_id, id),
  UNIQUE (business_id, id),
  CHECK (status <> 'out_of_order' OR status_note IS NOT NULL)
);
CREATE UNIQUE INDEX lodging_rooms_number ON lodging_rooms(business_id, location_id, lower(room_no));
CREATE INDEX lodging_rooms_type ON lodging_rooms(business_id, room_type_id);

CREATE TABLE lodging_room_status_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  room_id BIGINT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, room_id) REFERENCES lodging_rooms(business_id, id)
);
CREATE INDEX lodging_room_status_log_room ON lodging_room_status_log(business_id, room_id, id);
CREATE TRIGGER lodging_room_status_log_append_only BEFORE UPDATE OR DELETE ON lodging_room_status_log
  FOR EACH ROW EXECUTE FUNCTION lodging_append_only();

-- Every status a room takes is written to its history, with who and why.
CREATE FUNCTION lodging_rooms_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lodging_room_status_log(business_id, room_id, from_status, to_status, note, created_by)
    VALUES (NEW.business_id, NEW.id, NULL, NEW.status, NEW.status_note, NEW.status_by);
  ELSIF NEW.status <> OLD.status OR NEW.status_note IS DISTINCT FROM OLD.status_note THEN
    INSERT INTO lodging_room_status_log(business_id, room_id, from_status, to_status, note, created_by)
    VALUES (NEW.business_id, NEW.id, OLD.status, NEW.status, NEW.status_note, NEW.status_by);
  END IF;
  RETURN NULL;
END $$;

-- --- Stays ---------------------------------------------------------------------------------------

CREATE TABLE lodging_stays (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  stay_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  -- The guest who booked (a customer), with their name and phone as they were then.
  contact_id BIGINT NOT NULL,
  guest_name VARCHAR(150) NOT NULL CHECK (btrim(guest_name) <> ''),
  guest_phone VARCHAR(30),
  -- A company (or another customer) the stay is billed to instead of the guest: its GSTIN goes on the invoice.
  bill_to_contact_id BIGINT,
  -- A walk-in, the phone, or an OTA with its booking id.
  source TEXT NOT NULL CHECK (source IN ('walk_in', 'phone', 'ota')),
  ota_name VARCHAR(60) CHECK (btrim(ota_name) <> ''),
  ota_booking_id VARCHAR(60) CHECK (btrim(ota_booking_id) <> ''),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'in_house', 'checked_out', 'cancelled', 'no_show')),
  -- The nights, from the arrival date to the departure date (the morning the guest leaves), on the business's clock.
  arrival DATE NOT NULL,
  departure DATE NOT NULL,
  room_type_id BIGINT NOT NULL,
  -- The room: chosen at the reservation or at check-in.
  room_id BIGINT,
  adults SMALLINT NOT NULL CHECK (adults BETWEEN 1 AND 30),
  children SMALLINT NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 30),
  extra_beds SMALLINT NOT NULL DEFAULT 0 CHECK (extra_beds BETWEEN 0 AND 5),
  -- The room type's rates as booked, each a night before GST, or one rate agreed
  -- for every night in place of the rack and weekend rates (an OTA's price, a company's rate).
  base_occupancy SMALLINT NOT NULL CHECK (base_occupancy BETWEEN 1 AND 20),
  rack_rate NUMERIC(14,2) NOT NULL CHECK (rack_rate > 0),
  weekend_rate NUMERIC(14,2) CHECK (weekend_rate > 0),
  extra_adult_rate NUMERIC(14,2) CHECK (extra_adult_rate >= 0),
  child_rate NUMERIC(14,2) CHECK (child_rate >= 0),
  extra_bed_rate NUMERIC(14,2) CHECK (extra_bed_rate >= 0),
  agreed_rate NUMERIC(14,2) CHECK (agreed_rate > 0),
  -- The room nights as priced when booked or last changed, each night at its own slab.
  estimate_subtotal NUMERIC(16,2) NOT NULL CHECK (estimate_subtotal >= 0),
  estimate_tax NUMERIC(16,2) NOT NULL CHECK (estimate_tax >= 0),
  estimate_total NUMERIC(16,2) NOT NULL CHECK (estimate_total >= 0),
  -- For the guest register: where the party came from, where it goes next, and why it came.
  arrived_from VARCHAR(150) CHECK (btrim(arrived_from) <> ''),
  going_to VARCHAR(150) CHECK (btrim(going_to) <> ''),
  purpose VARCHAR(150) CHECK (btrim(purpose) <> ''),
  notes VARCHAR(500),
  checked_in_at TIMESTAMPTZ,
  checked_in_by BIGINT REFERENCES users(id),
  checkin_key UUID,
  checkin_hash CHAR(64),
  checked_out_at TIMESTAMPTZ,
  checked_out_by BIGINT REFERENCES users(id),
  checkout_key UUID,
  checkout_hash CHAR(64),
  -- The bill: the folio at check-out, or a cancellation or no-show charge.
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
  FOREIGN KEY (business_id, bill_to_contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, room_type_id) REFERENCES lodging_room_types(business_id, id),
  FOREIGN KEY (business_id, room_id) REFERENCES lodging_rooms(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, stay_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, checkin_key),
  UNIQUE (business_id, checkout_key),
  UNIQUE (business_id, cancel_key),
  CHECK (departure > arrival),
  CHECK (departure <= arrival + 180),
  CHECK ((source = 'ota') = (ota_name IS NOT NULL)),
  CHECK ((source = 'ota') = (ota_booking_id IS NOT NULL)),
  CHECK (bill_to_contact_id IS NULL OR bill_to_contact_id <> contact_id),
  CHECK (adults <= base_occupancy OR extra_adult_rate IS NOT NULL),
  CHECK (extra_beds = 0 OR extra_bed_rate IS NOT NULL),
  CHECK (estimate_total = estimate_subtotal + estimate_tax),
  CHECK ((status IN ('in_house', 'checked_out')) = (checked_in_at IS NOT NULL)),
  CHECK (checked_in_at IS NULL OR room_id IS NOT NULL),
  CHECK ((checked_in_at IS NULL) = (checked_in_by IS NULL)),
  CHECK ((checked_in_at IS NULL) = (checkin_key IS NULL)),
  CHECK ((checkin_key IS NULL) = (checkin_hash IS NULL)),
  CHECK ((status = 'checked_out') = (checked_out_at IS NOT NULL)),
  CHECK ((checked_out_at IS NULL) = (checked_out_by IS NULL)),
  CHECK ((checked_out_at IS NULL) = (checkout_key IS NULL)),
  CHECK ((checkout_key IS NULL) = (checkout_hash IS NULL)),
  CHECK (status <> 'checked_out' OR document_id IS NOT NULL),
  CHECK (document_id IS NULL OR status IN ('checked_out', 'cancelled', 'no_show')),
  CHECK ((status IN ('cancelled', 'no_show')) = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_key IS NULL)),
  CHECK ((cancel_key IS NULL) = (cancel_hash IS NULL)),
  -- A room is never held by two stays over the same night: the room as a one-room
  -- range and the nights as a date range (departure not included) never overlap
  -- another stay's while both are reserved or in the house.
  CONSTRAINT lodging_stays_room_free EXCLUDE USING gist (int8range(room_id, room_id, '[]') WITH &&, daterange(arrival, departure) WITH &&)
    WHERE (room_id IS NOT NULL AND status IN ('reserved', 'in_house'))
);
CREATE INDEX lodging_stays_period ON lodging_stays(business_id, created_at DESC);
CREATE INDEX lodging_stays_status ON lodging_stays(business_id, status, arrival);
CREATE INDEX lodging_stays_contact ON lodging_stays(business_id, contact_id);
CREATE INDEX lodging_stays_type ON lodging_stays(business_id, room_type_id, arrival) WHERE status IN ('reserved', 'in_house');
CREATE INDEX lodging_stays_room ON lodging_stays(business_id, room_id) WHERE room_id IS NOT NULL;
CREATE TRIGGER lodging_stays_customer BEFORE INSERT ON lodging_stays
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A stay is billed to a customer of this business.
CREATE FUNCTION lodging_stays_bill_to() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bill_to_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.bill_to_contact_id AND kind = 'customer') THEN
    RAISE EXCEPTION 'A stay is billed to a customer of this business: add the company as a customer first' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_stays_bill_to BEFORE INSERT OR UPDATE OF bill_to_contact_id ON lodging_stays
  FOR EACH ROW EXECUTE FUNCTION lodging_stays_bill_to();

-- A stay starts as a reservation, arriving today or later on the business's
-- clock, when it is saved.
CREATE FUNCTION lodging_stays_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'reserved' THEN
    RAISE EXCEPTION 'A stay starts as a reservation' USING ERRCODE = '23514';
  END IF;
  IF NEW.arrival < lodging_today(NEW.business_id) THEN
    RAISE EXCEPTION 'A stay arrives today or later' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'A stay is made when it is saved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_stays_insert_check BEFORE INSERT ON lodging_stays
  FOR EACH ROW EXECUTE FUNCTION lodging_stays_insert_check();

-- A stay keeps its number, guest and where it was made, and is never deleted.
-- It goes reserved → in the house → checked out, or is cancelled (or marked a
-- no-show once its arrival day has come) while reserved. A room it takes is in
-- use, at its location and of its room type; a guest checks in, on a day from
-- the arrival to the night before the departure, to a room that is vacant and
-- clean, and moves only to one. Its arrival changes while it is reserved; its
-- departure while it is not checked out, never before a night already posted;
-- the adults and children are fixed once the occupants are recorded. Checking
-- out ends the stay on the business's date (a stay of one night at least); a
-- guest past the departure date is extended first. What was recorded at the
-- check-in, the check-out and a cancellation is written once, with it; the bill
-- once. A stay checked out, cancelled or marked a no-show no longer changes.
CREATE FUNCTION lodging_stays_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE today DATE; room RECORD; last_night DATE; done TEXT; check_room BOOLEAN; moving_in BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A stay is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  today := lodging_today(NEW.business_id);
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('checked_out', 'cancelled', 'no_show') THEN
      IF (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
        done := CASE OLD.status WHEN 'checked_out' THEN 'checked out' WHEN 'cancelled' THEN 'cancelled' ELSE 'a no-show' END;
        RAISE EXCEPTION 'Stay % is % and no longer changes', OLD.stay_no, done USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    check_room := NEW.room_id IS NOT NULL AND (NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.room_type_id <> OLD.room_type_id OR NEW.status <> OLD.status);
    moving_in := NEW.status = 'in_house' AND (OLD.status <> 'in_house' OR NEW.room_id IS DISTINCT FROM OLD.room_id);
  ELSE
    check_room := NEW.room_id IS NOT NULL;
  END IF;
  -- The room it takes, whenever one is given, changed, or checked in to.
  IF check_room THEN
    SELECT room_no, location_id, room_type_id, status, status_note, active INTO room FROM lodging_rooms WHERE business_id = NEW.business_id AND id = NEW.room_id;
    IF NOT room.active THEN
      RAISE EXCEPTION 'Room % is out of use', room.room_no USING ERRCODE = '23514';
    END IF;
    IF room.location_id <> NEW.location_id THEN
      RAISE EXCEPTION 'Room % is at another location', room.room_no USING ERRCODE = '23514';
    END IF;
    IF room.room_type_id <> NEW.room_type_id THEN
      RAISE EXCEPTION 'Room % is of another room type: change the stay''s room type with the room', room.room_no USING ERRCODE = '23514';
    END IF;
    IF moving_in AND room.status <> 'vacant_clean' THEN
      RAISE EXCEPTION 'Room % is %: a guest checks in to a room that is vacant and clean', room.room_no,
        CASE room.status WHEN 'vacant_dirty' THEN 'not made up yet' WHEN 'occupied' THEN 'occupied' ELSE 'out of order (' || room.status_note || ')' END USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.stay_no <> OLD.stay_no OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.contact_id <> OLD.contact_id
     OR NEW.guest_name <> OLD.guest_name OR NEW.guest_phone IS DISTINCT FROM OLD.guest_phone OR NEW.request_key <> OLD.request_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A stay keeps its number, its guest and where it was made' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'reserved' AND NEW.status IN ('in_house', 'cancelled', 'no_show')) OR (OLD.status = 'in_house' AND NEW.status = 'checked_out')) THEN
    RAISE EXCEPTION 'Stay % cannot go from % to %', OLD.stay_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.arrival <> OLD.arrival AND (OLD.status <> 'reserved' OR NEW.status <> 'reserved') THEN
    RAISE EXCEPTION 'Stay % has arrived: its arrival stays as it was', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.arrival <> OLD.arrival AND NEW.arrival < today THEN
    RAISE EXCEPTION 'Stay % would arrive on a day that has passed: give it dates from today', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'in_house' AND (today < NEW.arrival OR today >= NEW.departure) THEN
    RAISE EXCEPTION 'Stay % is for the nights of % to %: a guest checks in from the arrival day to the night before the departure', OLD.stay_no,
      lodging_day_words(NEW.arrival), lodging_day_words(NEW.departure - 1) USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'in_house' AND NEW.room_id IS NULL THEN
    RAISE EXCEPTION 'Stay % has a guest in the house: they keep a room', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'in_house' AND (NEW.adults <> OLD.adults OR NEW.children <> OLD.children) THEN
    RAISE EXCEPTION 'Stay %: the adults and children are the occupants recorded at check-in', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.departure <> OLD.departure AND OLD.status = 'in_house' THEN
    SELECT max(night) INTO last_night FROM lodging_charges WHERE business_id = NEW.business_id AND stay_id = NEW.id AND kind = 'room_night' AND voided_at IS NULL;
    IF last_night IS NOT NULL AND NEW.departure <= last_night THEN
      RAISE EXCEPTION 'Stay %: the night of % is posted already, so the guest leaves on % or later', OLD.stay_no, lodging_day_words(last_night),
        lodging_day_words(last_night + 1) USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'in_house' AND NEW.departure < today THEN
      RAISE EXCEPTION 'Stay % has a guest in the house: they leave today or later', OLD.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'in_house' AND NEW.status = 'checked_out' AND NEW.departure <> GREATEST(today, NEW.arrival + 1) THEN
    RAISE EXCEPTION 'Stay % was to leave on %: extend it to today first', OLD.stay_no, lodging_day_words(OLD.departure) USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'no_show' AND today < NEW.arrival THEN
    RAISE EXCEPTION 'Stay % arrives on %: a guest is a no-show once the arrival day has come; cancel it instead', OLD.stay_no, lodging_day_words(NEW.arrival) USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_in_at, NEW.checked_in_by, NEW.checkin_key, NEW.checkin_hash) IS DISTINCT FROM (OLD.checked_in_at, OLD.checked_in_by, OLD.checkin_key, OLD.checkin_hash)
     AND NOT (OLD.status = 'reserved' AND NEW.status = 'in_house') THEN
    RAISE EXCEPTION 'Stay %: the check-in is recorded once, with it', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.checked_out_at, NEW.checked_out_by, NEW.checkout_key, NEW.checkout_hash) IS DISTINCT FROM (OLD.checked_out_at, OLD.checked_out_by, OLD.checkout_key, OLD.checkout_hash)
     AND NOT (OLD.status = 'in_house' AND NEW.status = 'checked_out') THEN
    RAISE EXCEPTION 'Stay %: the check-out is recorded once, with it', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason, NEW.cancel_key, NEW.cancel_hash) IS DISTINCT FROM
     (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason, OLD.cancel_key, OLD.cancel_hash) AND NEW.status NOT IN ('cancelled', 'no_show') THEN
    RAISE EXCEPTION 'Stay %: a cancellation is recorded when it is cancelled', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    IF OLD.document_id IS NOT NULL OR NEW.status = OLD.status THEN
      RAISE EXCEPTION 'Stay % is billed once: at check-out, or with a cancellation charge', OLD.stay_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale'
       AND contact_id = CASE WHEN NEW.status = 'checked_out' THEN COALESCE(NEW.bill_to_contact_id, NEW.contact_id) ELSE NEW.contact_id END) THEN
      RAISE EXCEPTION 'Stay % is billed on a sale to its guest, or to the company it is billed to', OLD.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_stays_guard BEFORE INSERT OR UPDATE OR DELETE ON lodging_stays
  FOR EACH ROW EXECUTE FUNCTION lodging_stays_guard();

CREATE TABLE lodging_stay_guests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  stay_id BIGINT NOT NULL,
  -- Its place in the stay's register (1, 2, 3 …).
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 60),
  full_name VARCHAR(150) NOT NULL CHECK (btrim(full_name) <> ''),
  child BOOLEAN NOT NULL DEFAULT FALSE,
  gender TEXT CHECK (gender IN ('female', 'male', 'other')),
  age SMALLINT CHECK (age BETWEEN 0 AND 120),
  phone VARCHAR(30) CHECK (btrim(phone) <> ''),
  address VARCHAR(300) CHECK (btrim(address) <> ''),
  nationality VARCHAR(60) NOT NULL CHECK (btrim(nationality) <> ''),
  -- A foreign national (an OCI cardholder too): reported on Form-III.
  foreigner BOOLEAN NOT NULL DEFAULT FALSE,
  -- The photo ID seen: of an Aadhaar card only the last four digits; a foreigner's is the passport.
  id_kind TEXT CHECK (id_kind IN ('aadhaar', 'voter_id', 'driving_licence', 'passport', 'pan_card', 'other')),
  id_ref VARCHAR(30) CHECK (id_ref ~ '^[A-Z0-9/-]{2,30}$'),
  -- A foreigner's visa (its type and number) or OCI card (type "OCI card" and the card's number),
  -- the date they arrived in India and where they go next.
  visa_type VARCHAR(40) CHECK (btrim(visa_type) <> ''),
  visa_no VARCHAR(40) CHECK (visa_no ~ '^[A-Z0-9/-]{2,40}$'),
  arrived_india_on DATE,
  next_destination VARCHAR(150) CHECK (btrim(next_destination) <> ''),
  -- When they checked in and when they left.
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  departed_at TIMESTAMPTZ,
  -- The Form-III reports on the portal: each marked reported with its acknowledgement number.
  frro_arrival_ack VARCHAR(40) CHECK (frro_arrival_ack ~ '^[A-Za-z0-9/-]{3,40}$'),
  frro_arrival_at TIMESTAMPTZ,
  frro_arrival_by BIGINT REFERENCES users(id),
  frro_departure_ack VARCHAR(40) CHECK (frro_departure_ack ~ '^[A-Za-z0-9/-]{3,40}$'),
  frro_departure_at TIMESTAMPTZ,
  frro_departure_by BIGINT REFERENCES users(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, stay_id) REFERENCES lodging_stays(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, stay_id, seq),
  CHECK ((id_kind IS NULL) = (id_ref IS NULL)),
  CHECK (id_kind IS DISTINCT FROM 'aadhaar' OR id_ref ~ '^[0-9]{4}$'),
  CHECK (child OR id_kind IS NOT NULL),
  CHECK (NOT foreigner OR (id_kind = 'passport' AND visa_type IS NOT NULL AND visa_no IS NOT NULL AND arrived_india_on IS NOT NULL AND next_destination IS NOT NULL)),
  CHECK (foreigner OR (visa_type IS NULL AND visa_no IS NULL AND arrived_india_on IS NULL AND frro_arrival_ack IS NULL AND frro_departure_ack IS NULL)),
  CHECK ((frro_arrival_ack IS NULL) = (frro_arrival_at IS NULL)),
  CHECK ((frro_arrival_at IS NULL) = (frro_arrival_by IS NULL)),
  CHECK ((frro_departure_ack IS NULL) = (frro_departure_at IS NULL)),
  CHECK ((frro_departure_at IS NULL) = (frro_departure_by IS NULL)),
  CHECK (frro_departure_ack IS NULL OR departed_at IS NOT NULL),
  CHECK (departed_at IS NULL OR departed_at >= arrived_at)
);
CREATE INDEX lodging_stay_guests_stay ON lodging_stay_guests(business_id, stay_id, seq);
CREATE INDEX lodging_stay_guests_foreign ON lodging_stay_guests(business_id, arrived_at) WHERE foreigner;

-- An occupant is recorded as they check in, to a stay in the house. Their
-- details are corrected while the stay is in the house; they leave with the
-- check-out; each Form-III report is marked once (the departure's once they
-- have left). An occupant's record is never deleted.
CREATE FUNCTION lodging_stay_guests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stay RECORD; kept TEXT[] := ARRAY['departed_at', 'frro_arrival_ack', 'frro_arrival_at', 'frro_arrival_by', 'frro_departure_ack', 'frro_departure_at',
  'frro_departure_by', 'updated_by', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An occupant''s record is kept: it is never deleted' USING ERRCODE = '23514';
  END IF;
  SELECT stay_no, status INTO stay FROM lodging_stays WHERE business_id = NEW.business_id AND id = NEW.stay_id;
  IF TG_OP = 'INSERT' THEN
    IF stay.status <> 'in_house' THEN
      RAISE EXCEPTION 'Stay %: occupants are recorded as the guests check in', stay.stay_no USING ERRCODE = '23514';
    END IF;
    IF NEW.arrived_at <> now() OR NEW.created_at <> now() OR NEW.departed_at IS NOT NULL OR NEW.frro_arrival_ack IS NOT NULL OR NEW.frro_departure_ack IS NOT NULL THEN
      RAISE EXCEPTION 'An occupant is recorded as they arrive' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stay_id <> OLD.stay_id OR NEW.seq <> OLD.seq OR NEW.arrived_at <> OLD.arrived_at OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An occupant''s record keeps its stay and when they arrived' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) AND stay.status <> 'in_house' THEN
    RAISE EXCEPTION 'Stay % has left: its occupants'' details are kept as they were', stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.departed_at IS DISTINCT FROM OLD.departed_at AND (OLD.departed_at IS NOT NULL OR stay.status <> 'checked_out') THEN
    RAISE EXCEPTION 'Stay %: the occupants leave with the check-out', stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.frro_arrival_ack, NEW.frro_arrival_at, NEW.frro_arrival_by) IS DISTINCT FROM (OLD.frro_arrival_ack, OLD.frro_arrival_at, OLD.frro_arrival_by)
     AND OLD.frro_arrival_ack IS NOT NULL THEN
    RAISE EXCEPTION 'The Form-III arrival report of % is recorded already (acknowledgement %)', OLD.full_name, OLD.frro_arrival_ack USING ERRCODE = '23514';
  END IF;
  IF (NEW.frro_departure_ack, NEW.frro_departure_at, NEW.frro_departure_by) IS DISTINCT FROM (OLD.frro_departure_ack, OLD.frro_departure_at, OLD.frro_departure_by)
     AND OLD.frro_departure_ack IS NOT NULL THEN
    RAISE EXCEPTION 'The Form-III departure report of % is recorded already (acknowledgement %)', OLD.full_name, OLD.frro_departure_ack USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_stay_guests_guard BEFORE INSERT OR UPDATE OR DELETE ON lodging_stay_guests
  FOR EACH ROW EXECUTE FUNCTION lodging_stay_guests_guard();

-- --- Advances and deposits -----------------------------------------------------------------------

CREATE TABLE lodging_receipts (
  business_id BIGINT NOT NULL,
  -- The core collection receipt in the guest's name.
  collection_id BIGINT NOT NULL,
  stay_id BIGINT NOT NULL,
  -- An advance (money on account for the stay) or a refundable deposit.
  purpose TEXT NOT NULL CHECK (purpose IN ('advance', 'deposit')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, collection_id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, stay_id) REFERENCES lodging_stays(business_id, id)
);
CREATE INDEX lodging_receipts_stay ON lodging_receipts(business_id, stay_id);
CREATE TRIGGER lodging_receipts_append_only BEFORE UPDATE OR DELETE ON lodging_receipts
  FOR EACH ROW EXECUTE FUNCTION lodging_append_only();

-- A receipt is taken for a stay reserved or in the house, in its guest's name,
-- by cash, card, UPI or bank, when it is written.
CREATE FUNCTION lodging_receipts_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stay RECORD; receipt RECORD;
BEGIN
  SELECT stay_no, status, contact_id INTO stay FROM lodging_stays WHERE business_id = NEW.business_id AND id = NEW.stay_id;
  SELECT contact_id, method, created_at INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF stay.status NOT IN ('reserved', 'in_house') THEN
    RAISE EXCEPTION 'Stay % is %: an advance or a deposit is taken while it is reserved or in the house', stay.stay_no, replace(stay.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF receipt.contact_id <> stay.contact_id OR receipt.method NOT IN ('cash', 'card', 'upi', 'bank') OR receipt.created_at <> now() THEN
    RAISE EXCEPTION 'An advance or deposit for stay % is a new receipt in its guest''s name, by cash, card, UPI or bank', stay.stay_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_receipts_check BEFORE INSERT ON lodging_receipts
  FOR EACH ROW EXECUTE FUNCTION lodging_receipts_check();

-- --- The folio -----------------------------------------------------------------------------------

CREATE TABLE lodging_charges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  stay_id BIGINT NOT NULL,
  -- A room night (posted by the night audit or at check-out), an extra, or a cancellation or no-show charge.
  kind TEXT NOT NULL CHECK (kind IN ('room_night', 'extra', 'cancellation')),
  -- A room night: the night (the date it starts on); otherwise the date charged (the business's clock).
  night DATE NOT NULL,
  -- The room the guest was in that night.
  room_id BIGINT,
  -- The item billed: the room type's for a room night or a cancellation charge, a service item for an extra.
  sku_id BIGINT NOT NULL,
  -- The bill line's words.
  label VARCHAR(150) NOT NULL CHECK (btrim(label) <> ''),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  -- A room night's value: the night's rate (rack, weekend or agreed) with the
  -- extra adults, children and extra beds at their rates, all before GST.
  rate_kind TEXT CHECK (rate_kind IN ('rack', 'weekend', 'agreed')),
  room_rate NUMERIC(14,2) CHECK (room_rate > 0),
  extra_adults SMALLINT CHECK (extra_adults >= 0),
  extra_adult_rate NUMERIC(14,2) CHECK (extra_adult_rate >= 0),
  children SMALLINT CHECK (children >= 0),
  child_rate NUMERIC(14,2) CHECK (child_rate >= 0),
  extra_beds SMALLINT CHECK (extra_beds >= 0),
  extra_bed_rate NUMERIC(14,2) CHECK (extra_bed_rate >= 0),
  -- The price of one and the charge, in the terms charged (a room night and a cancellation charge: before GST).
  unit_price NUMERIC(14,4) NOT NULL CHECK (unit_price > 0),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  -- Its GST: a room night's slab by its value, an extra's item's slab (and its rate, when the item's rate is no slab of the business).
  tax_rate_id BIGINT,
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate BETWEEN 0 AND 100),
  net NUMERIC(16,2) NOT NULL CHECK (net >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  -- The bill line that charged it.
  line_id BIGINT,
  -- A mistake, voided with a reason before it is billed (then left off the bill).
  void_reason VARCHAR(300) CHECK (btrim(void_reason) <> ''),
  voided_by BIGINT REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  request_key UUID,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, stay_id) REFERENCES lodging_stays(business_id, id),
  FOREIGN KEY (business_id, room_id) REFERENCES lodging_rooms(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, tax_rate_id) REFERENCES business_tax_rates(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, line_id),
  UNIQUE (business_id, request_key),
  CHECK ((kind = 'room_night') = (room_id IS NOT NULL)),
  CHECK ((kind = 'room_night') = (rate_kind IS NOT NULL)),
  CHECK (kind <> 'room_night' OR (quantity = 1 AND room_rate IS NOT NULL AND extra_adults IS NOT NULL AND children IS NOT NULL AND extra_beds IS NOT NULL
    AND amount = room_rate + extra_adults * COALESCE(extra_adult_rate, 0) + children * COALESCE(child_rate, 0) + extra_beds * COALESCE(extra_bed_rate, 0)
    AND unit_price = amount)),
  CHECK (kind = 'room_night' OR (room_rate IS NULL AND extra_adults IS NULL AND children IS NULL AND extra_beds IS NULL
    AND extra_adult_rate IS NULL AND child_rate IS NULL AND extra_bed_rate IS NULL)),
  CHECK (extra_adults IS NULL OR extra_adults = 0 OR extra_adult_rate IS NOT NULL),
  CHECK (extra_beds IS NULL OR extra_beds = 0 OR extra_bed_rate IS NOT NULL),
  CHECK (kind = 'extra' OR (tax_mode = 'exclusive' AND tax_rate_id IS NOT NULL)),
  CHECK ((tax_mode = 'exclusive' AND net = amount) OR (tax_mode = 'inclusive' AND net + tax = amount)),
  CHECK (tax_mode = 'inclusive' OR tax = round(net * tax_rate / 100, 2)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CHECK (voided_at IS NULL OR line_id IS NULL),
  CHECK (kind = 'room_night' OR request_key IS NOT NULL)
);
-- A night is charged once (a voided night is not posted again by the night audit).
CREATE UNIQUE INDEX lodging_charges_one_night ON lodging_charges(business_id, stay_id, night) WHERE kind = 'room_night' AND voided_at IS NULL;
CREATE INDEX lodging_charges_stay ON lodging_charges(business_id, stay_id, night, id);

-- A charge goes on the folio of a stay in the house (a cancellation charge on
-- a reservation being cancelled), when it is written. A room night is one of
-- the stay's nights that has come, for the room the guest is in, billed as its
-- room type's item, at that night's rate as the stay has it (the agreed rate,
-- else the weekend rate on a weekend night, else the rack rate, with each adult
-- beyond the base, each child and each extra bed), and with the GST slab its
-- value decides: at or below the settings' limit the lower slab, above it the
-- higher, the GST worked out to the paisa. An extra is a service item (not a
-- room type's) at its item's slab, charged on the day. A charge is kept as it
-- was posted; it is voided once, before it is billed, while the guest is in
-- the house; its bill line is given once, a line of its own item on the
-- stay's bill. It is never deleted.
CREATE FUNCTION lodging_charges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stay RECORD; settings RECORD; sku RECORD; today DATE; room_item BIGINT; weekend BOOLEAN; want_kind TEXT; want_rate NUMERIC; slab BIGINT; slab_rate NUMERIC;
  kept TEXT[] := ARRAY['line_id', 'void_reason', 'voided_by', 'voided_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A charge on the folio is kept as it was posted: void it instead' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO stay FROM lodging_stays WHERE business_id = NEW.business_id AND id = NEW.stay_id;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'A charge on the folio is kept as it was posted' USING ERRCODE = '23514';
    END IF;
    IF NEW.line_id IS DISTINCT FROM OLD.line_id AND (OLD.line_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM business_document_lines dl JOIN business_documents d ON d.business_id = dl.business_id AND d.id = dl.document_id
         WHERE dl.business_id = NEW.business_id AND dl.id = NEW.line_id AND dl.sku_id = NEW.sku_id AND d.kind = 'sale'
           AND d.contact_id IN (stay.contact_id, COALESCE(stay.bill_to_contact_id, stay.contact_id)))) THEN
      RAISE EXCEPTION 'A charge of stay % is billed once, on a line of its own item on the stay''s bill', stay.stay_no USING ERRCODE = '23514';
    END IF;
    IF (NEW.voided_at, NEW.voided_by, NEW.void_reason) IS DISTINCT FROM (OLD.voided_at, OLD.voided_by, OLD.void_reason)
       AND (OLD.voided_at IS NOT NULL OR OLD.line_id IS NOT NULL OR stay.status <> 'in_house') THEN
      RAISE EXCEPTION 'Stay %: a charge is voided once, before it is billed, while the guest is in the house', stay.stay_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.created_at <> now() OR NEW.line_id IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'A charge is posted when it is written, not yet billed or voided' USING ERRCODE = '23514';
  END IF;
  today := lodging_today(NEW.business_id);
  SELECT sku_id INTO room_item FROM lodging_room_types WHERE business_id = NEW.business_id AND id = stay.room_type_id;
  SELECT * INTO settings FROM lodging_settings WHERE business_id = NEW.business_id;
  IF NEW.kind = 'cancellation' THEN
    IF stay.status <> 'reserved' THEN
      RAISE EXCEPTION 'Stay % is %: a cancellation charge goes on a reservation being cancelled', stay.stay_no, replace(stay.status, '_', ' ') USING ERRCODE = '23514';
    END IF;
    IF NEW.sku_id <> room_item OR settings.low_tax_rate_id IS NULL OR NEW.tax_rate_id NOT IN (settings.low_tax_rate_id, settings.high_tax_rate_id)
       OR NEW.tax_rate <> (SELECT rate FROM business_tax_rates WHERE business_id = NEW.business_id AND id = NEW.tax_rate_id) THEN
      RAISE EXCEPTION 'A cancellation charge of stay % is billed as its room type''s nights, at a room-night slab', stay.stay_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF stay.status <> 'in_house' THEN
    RAISE EXCEPTION 'Stay % is %: charges go on the folio while the guest is in the house', stay.stay_no, replace(stay.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'extra' THEN
    SELECT p.kind, s.tax_rate, s.tax_rate_id, s.label INTO sku FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
    WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
    IF sku.kind IS DISTINCT FROM 'service' THEN
      RAISE EXCEPTION '% is goods kept in stock: sell it on a bill of its own; the folio takes services', sku.label USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM lodging_room_types WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id) THEN
      RAISE EXCEPTION '% is a room type''s nights: they are posted by the night audit', sku.label USING ERRCODE = '23514';
    END IF;
    IF NEW.tax_rate <> sku.tax_rate OR NEW.tax_rate_id IS DISTINCT FROM sku.tax_rate_id OR NEW.night <> today THEN
      RAISE EXCEPTION 'An extra is charged on the day it is posted, with GST at its item''s slab' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- A room night.
  IF NEW.room_id <> stay.room_id THEN
    RAISE EXCEPTION 'A room night of stay % is charged for the room the guest is in', stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.night < stay.arrival OR NEW.night >= stay.departure THEN
    RAISE EXCEPTION 'The night of % is not one of stay %''s nights', lodging_day_words(NEW.night), stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.night > today THEN
    RAISE EXCEPTION 'The night of % is posted once it has come', lodging_day_words(NEW.night) USING ERRCODE = '23514';
  END IF;
  IF NEW.sku_id <> room_item THEN
    RAISE EXCEPTION 'A room night of stay % is billed as its room type''s nights', stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF settings.low_tax_rate_id IS NULL THEN
    RAISE EXCEPTION 'Room nights are not billed until their two GST slabs are set (Settings › Room types & rates)' USING ERRCODE = '23514';
  END IF;
  weekend := EXTRACT(ISODOW FROM NEW.night)::smallint = ANY (settings.weekend_nights);
  want_kind := CASE WHEN stay.agreed_rate IS NOT NULL THEN 'agreed' WHEN weekend AND stay.weekend_rate IS NOT NULL THEN 'weekend' ELSE 'rack' END;
  want_rate := CASE want_kind WHEN 'agreed' THEN stay.agreed_rate WHEN 'weekend' THEN stay.weekend_rate ELSE stay.rack_rate END;
  IF NEW.rate_kind <> want_kind OR NEW.room_rate <> want_rate OR NEW.extra_adults <> GREATEST(0, stay.adults - stay.base_occupancy) OR NEW.children <> stay.children
     OR NEW.extra_beds <> stay.extra_beds OR NEW.extra_adult_rate IS DISTINCT FROM stay.extra_adult_rate OR NEW.child_rate IS DISTINCT FROM stay.child_rate
     OR NEW.extra_bed_rate IS DISTINCT FROM stay.extra_bed_rate THEN
    RAISE EXCEPTION 'The night of % of stay % is charged at the stay''s rate for that night', lodging_day_words(NEW.night), stay.stay_no USING ERRCODE = '23514';
  END IF;
  slab := CASE WHEN NEW.amount <= settings.slab_limit THEN settings.low_tax_rate_id ELSE settings.high_tax_rate_id END;
  SELECT rate INTO slab_rate FROM business_tax_rates WHERE business_id = NEW.business_id AND id = slab;
  IF NEW.tax_rate_id <> slab OR NEW.tax_rate <> slab_rate THEN
    RAISE EXCEPTION 'The night of % is valued at %: a room night at or below % is billed at the lower slab, above it at the higher', lodging_day_words(NEW.night),
      NEW.amount, settings.slab_limit USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_charges_guard BEFORE INSERT OR UPDATE OR DELETE ON lodging_charges
  FOR EACH ROW EXECUTE FUNCTION lodging_charges_guard();

-- --- History -------------------------------------------------------------------------------------

-- Everything that happened to a stay: a change of status (from and to), or a note with none.
CREATE TABLE lodging_stay_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  stay_id BIGINT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, stay_id) REFERENCES lodging_stays(business_id, id),
  CHECK (to_status IS NOT NULL OR note IS NOT NULL),
  CHECK (from_status IS NULL OR to_status IS NOT NULL)
);
CREATE INDEX lodging_stay_events_stay ON lodging_stay_events(business_id, stay_id, id);
CREATE TRIGGER lodging_stay_events_append_only BEFORE UPDATE OR DELETE ON lodging_stay_events
  FOR EACH ROW EXECUTE FUNCTION lodging_append_only();

-- --- What a stay holds ---------------------------------------------------------------------------

-- A room type never holds more stays on a night than it has rooms in use at
-- the stay's location. One room type at a time: its row is the lock, so two
-- stays saved together are checked one after the other.
CREATE FUNCTION lodging_check_type(target_business BIGINT, target_stay BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s RECORD; type_name TEXT; rooms INTEGER; busiest RECORD;
BEGIN
  SELECT * INTO s FROM lodging_stays WHERE business_id = target_business AND id = target_stay;
  IF NOT FOUND OR s.status NOT IN ('reserved', 'in_house') THEN RETURN; END IF;
  SELECT k.label INTO type_name FROM lodging_room_types t JOIN catalog_skus k ON k.business_id = t.business_id AND k.id = t.sku_id
  WHERE t.business_id = target_business AND t.id = s.room_type_id FOR UPDATE OF t;
  SELECT count(*)::int INTO rooms FROM lodging_rooms WHERE business_id = target_business AND location_id = s.location_id AND room_type_id = s.room_type_id AND active;
  SELECT n::date AS night, count(x.id)::int AS held INTO busiest
  FROM generate_series(s.arrival::timestamp, (s.departure - 1)::timestamp, interval '1 day') n
  JOIN lodging_stays x ON x.business_id = target_business AND x.location_id = s.location_id AND x.room_type_id = s.room_type_id
    AND x.status IN ('reserved', 'in_house') AND x.arrival <= n::date AND x.departure > n::date
  GROUP BY n HAVING count(x.id) > rooms ORDER BY n LIMIT 1;
  IF FOUND THEN
    IF rooms = 0 THEN
      RAISE EXCEPTION 'There are no % rooms at this location yet: add them under Settings › Room types & rates', type_name USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Every % room is taken on the night of % (% stays for % rooms): choose other dates or another room type', type_name,
      lodging_day_words(busiest.night), busiest.held, rooms USING ERRCODE = '23514';
  END IF;
END $$;

-- Checked when the work is saved (deferred), on the stay as it then is.
CREATE FUNCTION lodging_stays_type_free() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('reserved', 'in_house') THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM lodging_check_type(NEW.business_id, NEW.id);
  ELSIF NEW.arrival <> OLD.arrival OR NEW.departure <> OLD.departure OR NEW.room_type_id <> OLD.room_type_id THEN
    PERFORM lodging_check_type(NEW.business_id, NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lodging_stays_type_free AFTER INSERT OR UPDATE ON lodging_stays
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lodging_stays_type_free();

-- When the work is saved: a stay checked in has every occupant recorded (its
-- adults and its children); a stay checked out has every one of its nights
-- billed, every charge on its folio billed or voided, and its occupants gone.
CREATE FUNCTION lodging_stays_done() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grown INTEGER; young INTEGER; billed INTEGER;
BEGIN
  IF OLD.status = 'reserved' AND NEW.status = 'in_house' THEN
    SELECT count(*) FILTER (WHERE NOT child)::int, count(*) FILTER (WHERE child)::int INTO grown, young FROM lodging_stay_guests
    WHERE business_id = NEW.business_id AND stay_id = NEW.id;
    IF grown <> NEW.adults OR young <> NEW.children THEN
      RAISE EXCEPTION 'Stay % is for % adults and % children: every occupant is recorded at check-in (% and % recorded)', NEW.stay_no, NEW.adults, NEW.children,
        grown, young USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'in_house' AND NEW.status = 'checked_out' THEN
    SELECT count(DISTINCT night)::int INTO billed FROM lodging_charges WHERE business_id = NEW.business_id AND stay_id = NEW.id AND kind = 'room_night'
      AND voided_at IS NULL AND line_id IS NOT NULL AND night >= NEW.arrival AND night < NEW.departure;
    IF billed <> NEW.departure - NEW.arrival THEN
      RAISE EXCEPTION 'Stay %: every night from arrival to departure is billed at check-out', NEW.stay_no USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM lodging_charges WHERE business_id = NEW.business_id AND stay_id = NEW.id AND voided_at IS NULL
       AND (line_id IS NULL OR (kind = 'room_night' AND night >= NEW.departure))) THEN
      RAISE EXCEPTION 'Stay %: every charge on the folio is billed or voided at check-out', NEW.stay_no USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM lodging_stay_guests WHERE business_id = NEW.business_id AND stay_id = NEW.id AND departed_at IS NULL) THEN
      RAISE EXCEPTION 'Stay %: the occupants leave with the check-out', NEW.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lodging_stays_done AFTER UPDATE ON lodging_stays
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lodging_stays_done();

-- A room is never deleted; it keeps its location. It is occupied when a guest
-- checks in to it and stays occupied until they leave it. Its type changes,
-- and it goes out of use, only while no stay is reserved for it or in it and
-- the stays of its type still fit in the rooms left.
CREATE FUNCTION lodging_rooms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE guest RECORD; has_guest BOOLEAN; kind RECORD; busiest RECORD; rooms INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A room is never deleted; take it out of use instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'occupied' THEN
      RAISE EXCEPTION 'A room starts vacant: it is occupied when a guest checks in' USING ERRCODE = '23514';
    END IF;
    SELECT active INTO kind FROM lodging_room_types WHERE business_id = NEW.business_id AND id = NEW.room_type_id;
    IF NOT kind.active THEN
      RAISE EXCEPTION 'That room type is switched off: switch it on to add rooms to it' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Room % stays at its location', OLD.room_no USING ERRCODE = '23514';
  END IF;
  SELECT stay_no, guest_name INTO guest FROM lodging_stays WHERE business_id = NEW.business_id AND room_id = NEW.id AND status = 'in_house' LIMIT 1;
  has_guest := FOUND;
  IF NEW.status = 'occupied' AND OLD.status <> 'occupied' AND NOT has_guest THEN
    RAISE EXCEPTION 'Room % is occupied when a guest checks in to it', NEW.room_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'occupied' AND NEW.status <> 'occupied' AND has_guest THEN
    RAISE EXCEPTION 'Room % has % in it (%): check them out or move them first', NEW.room_no, guest.guest_name, guest.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.room_type_id <> OLD.room_type_id OR (OLD.active AND NOT NEW.active) THEN
    IF EXISTS (SELECT 1 FROM lodging_stays WHERE business_id = NEW.business_id AND room_id = NEW.id AND status IN ('reserved', 'in_house')) THEN
      RAISE EXCEPTION 'Room % has a stay reserved for it or in it: move the stay to another room first', NEW.room_no USING ERRCODE = '23514';
    END IF;
    SELECT count(*)::int INTO rooms FROM lodging_rooms WHERE business_id = NEW.business_id AND location_id = OLD.location_id AND room_type_id = OLD.room_type_id
      AND active AND id <> OLD.id;
    SELECT n::date AS night, count(x.id)::int AS held INTO busiest
    FROM lodging_stays x JOIN LATERAL generate_series(GREATEST(x.arrival, lodging_today(NEW.business_id))::timestamp, (x.departure - 1)::timestamp, interval '1 day') n ON TRUE
    WHERE x.business_id = NEW.business_id AND x.location_id = OLD.location_id AND x.room_type_id = OLD.room_type_id AND x.status IN ('reserved', 'in_house')
    GROUP BY n HAVING count(x.id) > rooms ORDER BY n LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Room % is needed: % stays of its type are booked on the night of %, and % other rooms are left', OLD.room_no, busiest.held,
        lodging_day_words(busiest.night), rooms USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_rooms_guard BEFORE INSERT OR UPDATE OR DELETE ON lodging_rooms
  FOR EACH ROW EXECUTE FUNCTION lodging_rooms_guard();
CREATE TRIGGER lodging_rooms_log AFTER INSERT OR UPDATE ON lodging_rooms
  FOR EACH ROW EXECUTE FUNCTION lodging_rooms_log();
CREATE TRIGGER lodging_room_types_guard BEFORE INSERT OR UPDATE OR DELETE ON lodging_room_types
  FOR EACH ROW EXECUTE FUNCTION lodging_room_types_guard();

-- Down Migration
DROP TRIGGER lodging_room_types_guard ON lodging_room_types;
DROP TRIGGER lodging_rooms_log ON lodging_rooms;
DROP TRIGGER lodging_rooms_guard ON lodging_rooms;
DROP TRIGGER lodging_stays_done ON lodging_stays;
DROP TRIGGER lodging_stays_type_free ON lodging_stays;
DROP TABLE lodging_stay_events, lodging_charges, lodging_receipts, lodging_stay_guests, lodging_stays, lodging_room_status_log, lodging_rooms,
  lodging_room_types, lodging_settings;
DROP FUNCTION lodging_rooms_guard();
DROP FUNCTION lodging_stays_done();
DROP FUNCTION lodging_stays_type_free();
DROP FUNCTION lodging_check_type(BIGINT, BIGINT);
DROP FUNCTION lodging_charges_guard();
DROP FUNCTION lodging_receipts_check();
DROP FUNCTION lodging_stay_guests_guard();
DROP FUNCTION lodging_stays_guard();
DROP FUNCTION lodging_stays_insert_check();
DROP FUNCTION lodging_stays_bill_to();
DROP FUNCTION lodging_rooms_log();
DROP FUNCTION lodging_room_types_guard();
DROP FUNCTION lodging_settings_check();
DROP FUNCTION lodging_day_words(DATE);
DROP FUNCTION lodging_today(BIGINT);
DROP FUNCTION lodging_append_only();
-- Refuses while an advance or a deposit has been handed back from a stay (restore a backup instead).
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical', 'garage', 'laundry', 'rentals'));
DELETE FROM business_number_series WHERE document_kind = 'stay';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'stay');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_role_permissions WHERE role_id IN (SELECT id FROM business_roles WHERE template_code IN ('front_desk', 'housekeeping'));
UPDATE business_memberships m SET role_id = (SELECT r2.id FROM business_roles r2 WHERE r2.business_id = m.business_id AND r2.template_code = 'viewer')
  WHERE role_id IN (SELECT id FROM business_roles WHERE template_code IN ('front_desk', 'housekeeping'));
DELETE FROM business_roles WHERE template_code IN ('front_desk', 'housekeeping');
DELETE FROM business_role_template_permissions WHERE template_code IN ('front_desk', 'housekeeping');
DELETE FROM business_role_templates WHERE code IN ('front_desk', 'housekeeping');
DELETE FROM business_capabilities WHERE capability = 'lodging';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'lodging');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'lodging');
DELETE FROM business_permissions WHERE module_code = 'lodging';
DELETE FROM platform_module_business_types WHERE module_code = 'lodging';
DELETE FROM platform_module_dependencies WHERE module_code = 'lodging';
DELETE FROM platform_modules WHERE code = 'lodging';
