-- Up Migration
-- What a hotel's, lodge's or guest house's stays still needed on top of its
-- rooms and folios: rate plans with their meal plans, a calendar of rates and
-- restrictions, a discount on a stay, day use by the hour, policies worked out
-- rather than typed, group bookings, several folios to a stay with routing,
-- goods from stock on the folio, occupants joining and leaving partway, and
-- guest profiles.
--
--   lodging_settings          also the property's check-in and check-out times
--                             (no regulation fixes them: property policy): the
--                             hours a night stay holds its room, and when a
--                             check-in is early and a check-out late.
--   lodging_policies          the property's (or the business's) policy: an
--                             early check-in and a late check-out charged as a
--                             percentage of the night, a flat fee or a full
--                             night; a cancellation free until so many hours
--                             before the arrival, then so many nights or a
--                             percentage of the stay; a no-show charged the
--                             first night or the full stay; a deposit (a
--                             percentage of the stay or the first night) due so
--                             many days before the arrival. A stay keeps the
--                             policy it was booked under (lodging_stays.policy).
--   lodging_rate_plans        a room type's plans: the meal plan (EP room only,
--                             CP with breakfast, MAP half board, AP full board)
--                             with the meals' price a night per adult and per
--                             child kept apart from the room's and billed as
--                             their own lines, at the slab of the food service
--                             item the property names, so a room night's value
--                             (and its slab) is the room's alone; refundable or
--                             not; its cancellation policy; its own room rates
--                             if the room type's are not its.
--   lodging_seasons           a date range's weekday and weekend rates (and
--                             extra adult, child and extra bed rates, and a
--                             minimum stay) for a room type, or one of its plans;
--                             never two of the same kind over the same date.
--   lodging_rate_days         a date's own rates and its restrictions, for a
--                             room type or one of its plans: minimum stay,
--                             closed to arrival, stop-sell.
--   lodging_day_use_rates     a room type's price for a block of hours on one day.
--   lodging_stay_nights       each night of a stay with the rates it was priced
--                             at (worked out from the calendar), and its meals:
--                             the night audit posts each night at these.
--   lodging_groups            a group's or company's booking of several rooms
--                             (GB/2627/0001): each room its own stay, arriving
--                             and leaving together or apart, with a group folio.
--   lodging_folios            a stay's folios beyond its main one (the guest's or
--                             the company's), and a group's folio; each billed
--                             with its own GST invoice.
--   lodging_routes            which folio a stay's charges of each kind go to:
--                             room and its tax, meals, extras, goods.
--   lodging_guest_profiles    a guest's preferences and notes, from their contact.
-- A stay also keeps its rate plan, its discount (a percentage of the room's
-- value, within the business's most bill discount: the discounted value of a
-- night decides its slab), whether it is a day use (a block of hours, its
-- room never held by a night stay or another day use over those hours), and
-- its group. The folio also takes meals, a day use, early check-in and late
-- check-out charges, and goods from stock (leaving stock when their folio is
-- billed). An occupant may join or leave a stay partway, with their dates.

-- --- Settings and numbering -----------------------------------------------------------------------

ALTER TABLE lodging_settings ADD COLUMN check_in_time TIME NOT NULL DEFAULT '12:00', ADD COLUMN check_out_time TIME NOT NULL DEFAULT '11:00';

-- Group bookings are numbered (GB/2627/0001). The kinds list is widened by
-- reading the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'stay_group' = ANY(kinds) THEN kinds := array_append(kinds, 'stay_group'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- The hours a stay holds its room: a day use its block; a night stay from the
-- check-in time on its arrival day to the check-out time on its departure day,
-- on the business's clock.
CREATE FUNCTION lodging_stay_held(day_use BOOLEAN, day_from TIMESTAMPTZ, day_until TIMESTAMPTZ, arrival DATE, departure DATE, tz TEXT, check_in TIME, check_out TIME)
RETURNS TSTZRANGE LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN day_use THEN tstzrange(day_from, day_until)
    ELSE tstzrange((arrival + check_in) AT TIME ZONE tz, (departure + check_out) AT TIME ZONE tz) END;
$$;

-- What is kept as it is: never deleted.
CREATE FUNCTION lodging_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'lodging_policies' THEN
    RAISE EXCEPTION 'A policy is never deleted; switch it off instead' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'lodging_seasons' THEN
    RAISE EXCEPTION 'A season is never deleted; switch it off instead' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'lodging_groups' THEN
    RAISE EXCEPTION 'A group booking is never deleted; cancel its stays instead' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A rate plan is never deleted; switch it off instead' USING ERRCODE = '23514';
END $$;

-- --- Policies -------------------------------------------------------------------------------------

CREATE TABLE lodging_policies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  -- A property's own policy (its location), or the business's for every property (none).
  location_id BIGINT,
  -- The policy a stay takes when its plan names none: one for each property, and one for the business.
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  -- An early check-in and a late check-out: a percentage of the night's value, a flat fee (rupees) or a full night.
  early_kind TEXT CHECK (early_kind IN ('percent', 'flat', 'night')),
  early_value NUMERIC(14,2) CHECK (early_value > 0),
  late_kind TEXT CHECK (late_kind IN ('percent', 'flat', 'night')),
  late_value NUMERIC(14,2) CHECK (late_value > 0),
  -- A cancellation is free until so many hours before the arrival (the check-in
  -- time on the arrival day), then costs so many nights or a percentage of the stay.
  cancel_free_hours SMALLINT CHECK (cancel_free_hours BETWEEN 0 AND 8760),
  cancel_kind TEXT CHECK (cancel_kind IN ('nights', 'percent')),
  cancel_value NUMERIC(6,2) CHECK (cancel_value > 0),
  -- A no-show costs the first night or the full stay.
  no_show_kind TEXT CHECK (no_show_kind IN ('first_night', 'full_stay')),
  -- The deposit asked for a reservation: a percentage of the stay or the first night, due so many days before the arrival.
  deposit_kind TEXT CHECK (deposit_kind IN ('percent', 'first_night')),
  deposit_value NUMERIC(5,2) CHECK (deposit_value > 0 AND deposit_value <= 100),
  deposit_days SMALLINT CHECK (deposit_days BETWEEN 0 AND 365),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((early_kind IN ('percent', 'flat')) = (early_value IS NOT NULL)),
  CHECK (early_kind IS DISTINCT FROM 'percent' OR early_value <= 100),
  CHECK ((late_kind IN ('percent', 'flat')) = (late_value IS NOT NULL)),
  CHECK (late_kind IS DISTINCT FROM 'percent' OR late_value <= 100),
  CHECK ((cancel_kind IS NULL) = (cancel_value IS NULL)),
  CHECK ((cancel_kind IS NULL) = (cancel_free_hours IS NULL)),
  CHECK (cancel_kind IS DISTINCT FROM 'percent' OR cancel_value <= 100),
  CHECK (cancel_kind IS DISTINCT FROM 'nights' OR (cancel_value = trunc(cancel_value) AND cancel_value <= 30)),
  CHECK ((deposit_kind IS NULL) = (deposit_days IS NULL)),
  CHECK ((deposit_kind IS NOT DISTINCT FROM 'percent') = (deposit_value IS NOT NULL))
);
CREATE UNIQUE INDEX lodging_policies_name ON lodging_policies(business_id, lower(name));
CREATE UNIQUE INDEX lodging_policies_default ON lodging_policies(business_id, COALESCE(location_id, 0)) WHERE is_default AND active;
CREATE TRIGGER lodging_policies_kept BEFORE DELETE ON lodging_policies FOR EACH ROW EXECUTE FUNCTION lodging_kept();

-- --- Rate plans, seasons, the calendar, day use ---------------------------------------------------

CREATE TABLE lodging_rate_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  room_type_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  -- EP room only, CP with breakfast, MAP half board, AP full board.
  meal_plan TEXT NOT NULL CHECK (meal_plan IN ('EP', 'CP', 'MAP', 'AP')),
  -- The meals: a food service item of the property (its name, SAC and slab on
  -- the bill), and their price a night before GST for each adult and each child.
  meal_sku_id BIGINT,
  meal_adult_rate NUMERIC(14,2) CHECK (meal_adult_rate >= 0),
  meal_child_rate NUMERIC(14,2) CHECK (meal_child_rate >= 0),
  -- The plan's own room rates a night before GST (none: the room type's).
  room_rate NUMERIC(14,2) CHECK (room_rate > 0),
  weekend_rate NUMERIC(14,2) CHECK (weekend_rate > 0),
  refundable BOOLEAN NOT NULL DEFAULT TRUE,
  -- Its policy (none: the property's).
  policy_id BIGINT,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, room_type_id) REFERENCES lodging_room_types(business_id, id),
  FOREIGN KEY (business_id, meal_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, policy_id) REFERENCES lodging_policies(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((meal_plan = 'EP') = (meal_sku_id IS NULL)),
  CHECK ((meal_plan = 'EP') = (meal_adult_rate IS NULL)),
  CHECK (meal_plan <> 'EP' OR meal_child_rate IS NULL),
  CHECK (weekend_rate IS NULL OR room_rate IS NOT NULL)
);
CREATE UNIQUE INDEX lodging_rate_plans_name ON lodging_rate_plans(business_id, room_type_id, lower(name));

-- A plan keeps its room type; its meals are a service item of this business
-- (not a kit, not a room type's nights). Never deleted.
CREATE FUNCTION lodging_rate_plans_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sku RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.room_type_id <> OLD.room_type_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'A rate plan keeps its room type' USING ERRCODE = '23514';
  END IF;
  IF NEW.meal_sku_id IS NOT NULL THEN
    SELECT p.kind, s.is_kit, s.label INTO sku FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
    WHERE s.business_id = NEW.business_id AND s.id = NEW.meal_sku_id;
    IF sku.kind IS DISTINCT FROM 'service' OR sku.is_kit OR EXISTS (SELECT 1 FROM lodging_room_types WHERE business_id = NEW.business_id AND sku_id = NEW.meal_sku_id) THEN
      RAISE EXCEPTION 'A plan''s meals are billed as a food service item of this business, not % ', sku.label USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_rate_plans_guard BEFORE INSERT OR UPDATE ON lodging_rate_plans FOR EACH ROW EXECUTE FUNCTION lodging_rate_plans_guard();
CREATE TRIGGER lodging_rate_plans_kept BEFORE DELETE ON lodging_rate_plans FOR EACH ROW EXECUTE FUNCTION lodging_kept();

CREATE TABLE lodging_seasons (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  room_type_id BIGINT NOT NULL,
  -- One of the room type's plans (none: every plan of the room type that has no season of its own).
  rate_plan_id BIGINT,
  -- From and to (both nights included).
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  -- The room's rate a night before GST on a weekday and on a weekend night (none: the weekday rate).
  weekday_rate NUMERIC(14,2) NOT NULL CHECK (weekday_rate > 0),
  weekend_rate NUMERIC(14,2) CHECK (weekend_rate > 0),
  -- Each extra adult, child and extra bed in the season (none: as without it), and its minimum stay.
  extra_adult_rate NUMERIC(14,2) CHECK (extra_adult_rate >= 0),
  child_rate NUMERIC(14,2) CHECK (child_rate >= 0),
  extra_bed_rate NUMERIC(14,2) CHECK (extra_bed_rate >= 0),
  min_stay SMALLINT CHECK (min_stay BETWEEN 1 AND 60),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, room_type_id) REFERENCES lodging_room_types(business_id, id),
  FOREIGN KEY (business_id, rate_plan_id) REFERENCES lodging_rate_plans(business_id, id),
  UNIQUE (business_id, id),
  CHECK (ends_on >= starts_on AND ends_on <= starts_on + 366),
  -- Two seasons of the same room type and plan never cover the same night.
  CONSTRAINT lodging_seasons_apart EXCLUDE USING gist (int8range(business_id, business_id, '[]') WITH &&, int8range(room_type_id, room_type_id, '[]') WITH &&,
    int8range(COALESCE(rate_plan_id, 0), COALESCE(rate_plan_id, 0), '[]') WITH &&, daterange(starts_on, ends_on, '[]') WITH &&) WHERE (active)
);
CREATE TRIGGER lodging_seasons_kept BEFORE DELETE ON lodging_seasons FOR EACH ROW EXECUTE FUNCTION lodging_kept();

CREATE TABLE lodging_rate_days (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  room_type_id BIGINT NOT NULL,
  -- One of the room type's plans (none: the room type, every plan).
  rate_plan_id BIGINT,
  day DATE NOT NULL,
  -- The night's own rates before GST (none: the season's or the plan's).
  room_rate NUMERIC(14,2) CHECK (room_rate > 0),
  extra_adult_rate NUMERIC(14,2) CHECK (extra_adult_rate >= 0),
  child_rate NUMERIC(14,2) CHECK (child_rate >= 0),
  extra_bed_rate NUMERIC(14,2) CHECK (extra_bed_rate >= 0),
  -- A stay arriving that day stays at least so many nights; no stay arrives that day; the night is not sold.
  min_stay SMALLINT CHECK (min_stay BETWEEN 1 AND 60),
  closed_to_arrival BOOLEAN NOT NULL DEFAULT FALSE,
  stop_sell BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, room_type_id) REFERENCES lodging_room_types(business_id, id),
  FOREIGN KEY (business_id, rate_plan_id) REFERENCES lodging_rate_plans(business_id, id),
  CHECK (room_rate IS NOT NULL OR extra_adult_rate IS NOT NULL OR child_rate IS NOT NULL OR extra_bed_rate IS NOT NULL OR min_stay IS NOT NULL OR closed_to_arrival OR stop_sell)
);
CREATE UNIQUE INDEX lodging_rate_days_one ON lodging_rate_days(business_id, room_type_id, COALESCE(rate_plan_id, 0), day);

-- A season's or a date's plan is one of its room type's.
CREATE FUNCTION lodging_plan_of_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rate_plan_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lodging_rate_plans WHERE business_id = NEW.business_id AND id = NEW.rate_plan_id AND room_type_id = NEW.room_type_id) THEN
    RAISE EXCEPTION 'That rate plan is of another room type' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_seasons_plan BEFORE INSERT OR UPDATE ON lodging_seasons FOR EACH ROW EXECUTE FUNCTION lodging_plan_of_type();
CREATE TRIGGER lodging_rate_days_plan BEFORE INSERT OR UPDATE ON lodging_rate_days FOR EACH ROW EXECUTE FUNCTION lodging_plan_of_type();

CREATE TABLE lodging_day_use_rates (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  room_type_id BIGINT NOT NULL,
  -- A block of so many hours on one day, and its price before GST.
  hours SMALLINT NOT NULL CHECK (hours BETWEEN 1 AND 12),
  rate NUMERIC(14,2) NOT NULL CHECK (rate > 0),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, room_type_id, hours),
  FOREIGN KEY (business_id, room_type_id) REFERENCES lodging_room_types(business_id, id)
);

-- --- Groups and folios ----------------------------------------------------------------------------

CREATE TABLE lodging_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  group_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  -- The group's organiser or company (a customer): its folio is billed to them.
  contact_id BIGINT NOT NULL,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, group_no),
  UNIQUE (business_id, request_key)
);
CREATE TRIGGER lodging_groups_customer BEFORE INSERT OR UPDATE OF contact_id ON lodging_groups FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();
CREATE TRIGGER lodging_groups_kept BEFORE DELETE ON lodging_groups FOR EACH ROW EXECUTE FUNCTION lodging_kept();

-- A group keeps its number, its property and where it was made.
CREATE FUNCTION lodging_groups_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.group_no <> OLD.group_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.request_key <> OLD.request_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A group booking keeps its number and its property' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_groups_guard BEFORE UPDATE ON lodging_groups FOR EACH ROW EXECUTE FUNCTION lodging_groups_guard();

CREATE TABLE lodging_folios (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- A stay's folio beyond its main one, or a group's folio.
  stay_id BIGINT,
  group_id BIGINT,
  name VARCHAR(60) NOT NULL CHECK (btrim(name) <> ''),
  -- Who it is billed to (a customer): with their GSTIN on the invoice.
  contact_id BIGINT NOT NULL,
  -- Its own GST invoice, once billed.
  document_id BIGINT,
  billed_at TIMESTAMPTZ,
  request_key UUID,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, group_id) REFERENCES lodging_groups(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, request_key),
  CHECK ((stay_id IS NULL) <> (group_id IS NULL)),
  CHECK ((document_id IS NULL) = (billed_at IS NULL))
);
CREATE UNIQUE INDEX lodging_folios_group ON lodging_folios(business_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX lodging_folios_name ON lodging_folios(business_id, stay_id, lower(name)) WHERE stay_id IS NOT NULL;
CREATE TRIGGER lodging_folios_customer BEFORE INSERT OR UPDATE OF contact_id ON lodging_folios FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A folio keeps its stay or group; it is billed once, on a sale to whom it is
-- billed to, who changes only before; it is never deleted.
CREATE FUNCTION lodging_folios_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A folio is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.document_id IS NOT NULL THEN
      RAISE EXCEPTION 'A folio is billed after it is opened' USING ERRCODE = '23514';
    END IF;
    IF NEW.stay_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lodging_stays WHERE business_id = NEW.business_id AND id = NEW.stay_id AND status IN ('reserved', 'in_house')) THEN
      RAISE EXCEPTION 'A folio is opened for a stay reserved or in the house' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stay_id IS DISTINCT FROM OLD.stay_id OR NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.request_key IS DISTINCT FROM OLD.request_key THEN
    RAISE EXCEPTION 'A folio keeps its stay or its group' USING ERRCODE = '23514';
  END IF;
  IF OLD.document_id IS NOT NULL AND (to_jsonb(NEW) <> to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Folio % is billed (its invoice is made) and no longer changes', OLD.name USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale'
     AND contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'Folio % is billed on a sale to whom it is billed to', NEW.name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_folios_guard BEFORE INSERT OR UPDATE OR DELETE ON lodging_folios FOR EACH ROW EXECUTE FUNCTION lodging_folios_guard();

-- --- Stays ----------------------------------------------------------------------------------------

ALTER TABLE lodging_stays
  ADD COLUMN rate_plan_id BIGINT,
  -- The policy the stay was booked under, as it then was (with whether its plan is refundable).
  ADD COLUMN policy JSONB CHECK (policy IS NULL OR jsonb_typeof(policy) = 'object'),
  -- A discount off the room's value (a percentage), and why.
  ADD COLUMN discount_percent NUMERIC(5,2) CHECK (discount_percent > 0 AND discount_percent <= 100),
  ADD COLUMN discount_reason VARCHAR(300) CHECK (btrim(discount_reason) <> ''),
  -- A day use: a block of hours on its arrival day (its departure the next date), its room named.
  ADD COLUMN day_use BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN day_from TIMESTAMPTZ,
  ADD COLUMN day_until TIMESTAMPTZ,
  ADD COLUMN day_hours SMALLINT CHECK (day_hours BETWEEN 1 AND 12),
  ADD COLUMN group_id BIGINT,
  ADD FOREIGN KEY (business_id, rate_plan_id) REFERENCES lodging_rate_plans(business_id, id),
  ADD FOREIGN KEY (business_id, group_id) REFERENCES lodging_groups(business_id, id),
  ADD CONSTRAINT lodging_stays_discount CHECK ((discount_percent IS NULL) = (discount_reason IS NULL)),
  ADD CONSTRAINT lodging_stays_day_use CHECK ((day_use = (day_from IS NOT NULL)) AND (day_use = (day_until IS NOT NULL)) AND (day_use = (day_hours IS NOT NULL))
    AND (NOT day_use OR (departure = arrival + 1 AND room_id IS NOT NULL AND extra_beds = 0 AND rate_plan_id IS NULL AND day_until = day_from + make_interval(hours => day_hours))));
CREATE INDEX lodging_stays_group ON lodging_stays(business_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX lodging_stays_day_use ON lodging_stays(business_id, room_id, arrival) WHERE day_use;

-- A room is never held by two night stays over the same night; day uses are held by their hours instead (lodging_stays_hours).
ALTER TABLE lodging_stays DROP CONSTRAINT lodging_stays_room_free,
  ADD CONSTRAINT lodging_stays_room_free EXCLUDE USING gist (int8range(room_id, room_id, '[]') WITH &&, daterange(arrival, departure) WITH &&)
    WHERE (room_id IS NOT NULL AND NOT day_use AND status IN ('reserved', 'in_house'));

-- A stay checked out may have no bill of its own: every charge routed to its group's folio.
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'lodging_stays'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%<> ''checked_out''::text) OR (document_id IS NOT NULL)%';
  EXECUTE format('ALTER TABLE lodging_stays DROP CONSTRAINT %I', c);
END $$;

-- Each night of a stay with the rates it is priced at; a day use's day with its block's price.
CREATE TABLE lodging_stay_nights (
  business_id BIGINT NOT NULL,
  stay_id BIGINT NOT NULL,
  night DATE NOT NULL,
  -- Where the room's rate came from: the room type's or plan's rack or weekend
  -- rate, a season's, the date's own, one rate agreed for every night, or a day use's block.
  rate_kind TEXT NOT NULL CHECK (rate_kind IN ('rack', 'weekend', 'season', 'override', 'agreed', 'day_use')),
  room_rate NUMERIC(14,2) NOT NULL CHECK (room_rate > 0),
  extra_adult_rate NUMERIC(14,2) CHECK (extra_adult_rate >= 0),
  child_rate NUMERIC(14,2) CHECK (child_rate >= 0),
  extra_bed_rate NUMERIC(14,2) CHECK (extra_bed_rate >= 0),
  -- The plan's meals that night: their item and their price for each adult and child.
  meal_sku_id BIGINT,
  meal_adult_rate NUMERIC(14,2) CHECK (meal_adult_rate >= 0),
  meal_child_rate NUMERIC(14,2) CHECK (meal_child_rate >= 0),
  PRIMARY KEY (business_id, stay_id, night),
  FOREIGN KEY (business_id, stay_id) REFERENCES lodging_stays(business_id, id),
  FOREIGN KEY (business_id, meal_sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK ((meal_sku_id IS NULL) = (meal_adult_rate IS NULL))
);

-- The stays already open are priced as they were: the agreed rate, else the weekend rate on a weekend night, else the rack rate.
INSERT INTO lodging_stay_nights (business_id, stay_id, night, rate_kind, room_rate, extra_adult_rate, child_rate, extra_bed_rate)
SELECT s.business_id, s.id, n::date,
  CASE WHEN s.agreed_rate IS NOT NULL THEN 'agreed'
    WHEN s.weekend_rate IS NOT NULL AND EXTRACT(ISODOW FROM n)::smallint = ANY (COALESCE(st.weekend_nights, '{5,6}'::smallint[])) THEN 'weekend' ELSE 'rack' END,
  CASE WHEN s.agreed_rate IS NOT NULL THEN s.agreed_rate
    WHEN s.weekend_rate IS NOT NULL AND EXTRACT(ISODOW FROM n)::smallint = ANY (COALESCE(st.weekend_nights, '{5,6}'::smallint[])) THEN s.weekend_rate ELSE s.rack_rate END,
  s.extra_adult_rate, s.child_rate, s.extra_bed_rate
FROM lodging_stays s LEFT JOIN lodging_settings st ON st.business_id = s.business_id
CROSS JOIN LATERAL generate_series(s.arrival::timestamp, (s.departure - 1)::timestamp, interval '1 day') n
WHERE s.status IN ('reserved', 'in_house');

CREATE TABLE lodging_routes (
  business_id BIGINT NOT NULL,
  stay_id BIGINT NOT NULL,
  -- room (the room nights, a day use, early check-in and late check-out, with their tax), meals, extras, goods.
  category TEXT NOT NULL CHECK (category IN ('room', 'meals', 'extras', 'goods')),
  folio_id BIGINT NOT NULL,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, stay_id, category),
  FOREIGN KEY (business_id, stay_id) REFERENCES lodging_stays(business_id, id),
  FOREIGN KEY (business_id, folio_id) REFERENCES lodging_folios(business_id, id)
);

-- A stay's charges are routed to one of its own folios, or to its group's, not yet billed.
CREATE FUNCTION lodging_routes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lodging_folios f JOIN lodging_stays s ON s.business_id = f.business_id AND s.id = NEW.stay_id
     WHERE f.business_id = NEW.business_id AND f.id = NEW.folio_id AND f.document_id IS NULL AND (f.stay_id = s.id OR f.group_id = s.group_id)) THEN
    RAISE EXCEPTION 'A stay''s charges are routed to one of its own folios not yet billed, or to its group''s' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_routes_guard BEFORE INSERT OR UPDATE ON lodging_routes FOR EACH ROW EXECUTE FUNCTION lodging_routes_guard();

CREATE TABLE lodging_guest_profiles (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  -- What the guest likes (a quiet room, a floor, a pillow), and the desk's notes.
  preferences VARCHAR(1000) CHECK (btrim(preferences) <> ''),
  notes VARCHAR(2000) CHECK (btrim(notes) <> ''),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id)
);
CREATE TRIGGER lodging_guest_profiles_customer BEFORE INSERT ON lodging_guest_profiles FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- An occupant joining partway is recorded once.
ALTER TABLE lodging_stay_guests ADD COLUMN request_key UUID, ADD CONSTRAINT lodging_stay_guests_request_key UNIQUE (business_id, request_key);

-- --- The folio's charges --------------------------------------------------------------------------

-- The checks are made again with the new kinds: meals, a day use, early check-in and
-- late check-out, goods; a discount off a room night or a day use; the folio a charge is on.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'lodging_charges'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE lodging_charges DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE lodging_charges
  -- The discount off a room night's or a day use's value (its amount is what is left).
  ADD COLUMN discount NUMERIC(14,2),
  -- The folio it is on (none: the stay's main folio, billed to the company or the guest).
  ADD COLUMN folio_id BIGINT,
  ADD FOREIGN KEY (business_id, folio_id) REFERENCES lodging_folios(business_id, id),
  ADD CONSTRAINT lodging_charges_kind CHECK (kind IN ('room_night', 'meal', 'day_use', 'early_check_in', 'late_check_out', 'extra', 'goods', 'cancellation')),
  ADD CONSTRAINT lodging_charges_texts CHECK (btrim(label) <> '' AND btrim(note) <> '' AND btrim(void_reason) <> ''),
  ADD CONSTRAINT lodging_charges_quantity CHECK (quantity > 0 AND quantity <= 10000),
  ADD CONSTRAINT lodging_charges_rate_kind CHECK (rate_kind IN ('rack', 'weekend', 'season', 'override', 'agreed', 'day_use')),
  ADD CONSTRAINT lodging_charges_rates CHECK (room_rate > 0 AND extra_adults >= 0 AND extra_adult_rate >= 0 AND children >= 0 AND child_rate >= 0 AND extra_beds >= 0 AND extra_bed_rate >= 0),
  ADD CONSTRAINT lodging_charges_money CHECK (unit_price > 0 AND amount > 0 AND net >= 0 AND tax >= 0 AND tax_rate BETWEEN 0 AND 100 AND discount > 0
    AND tax_mode IN ('inclusive', 'exclusive')),
  ADD CONSTRAINT lodging_charges_room CHECK ((kind IN ('room_night', 'day_use')) = (room_id IS NOT NULL) AND (kind IN ('room_night', 'day_use')) = (rate_kind IS NOT NULL)),
  ADD CONSTRAINT lodging_charges_night_value CHECK (kind <> 'room_night' OR (quantity = 1 AND room_rate IS NOT NULL AND extra_adults IS NOT NULL AND children IS NOT NULL
    AND extra_beds IS NOT NULL AND rate_kind <> 'day_use'
    AND amount + COALESCE(discount, 0) = room_rate + extra_adults * COALESCE(extra_adult_rate, 0) + children * COALESCE(child_rate, 0) + extra_beds * COALESCE(extra_bed_rate, 0)
    AND unit_price = amount)),
  ADD CONSTRAINT lodging_charges_day_use_value CHECK (kind <> 'day_use' OR (quantity = 1 AND rate_kind = 'day_use' AND room_rate IS NOT NULL AND amount + COALESCE(discount, 0) = room_rate
    AND unit_price = amount AND extra_adults IS NULL AND children IS NULL AND extra_beds IS NULL AND extra_adult_rate IS NULL AND child_rate IS NULL AND extra_bed_rate IS NULL)),
  ADD CONSTRAINT lodging_charges_not_a_night CHECK (kind IN ('room_night', 'day_use') OR (room_rate IS NULL AND extra_adults IS NULL AND children IS NULL AND extra_beds IS NULL
    AND extra_adult_rate IS NULL AND child_rate IS NULL AND extra_bed_rate IS NULL)),
  ADD CONSTRAINT lodging_charges_discount CHECK (discount IS NULL OR kind IN ('room_night', 'day_use')),
  ADD CONSTRAINT lodging_charges_extras CHECK ((extra_adults IS NULL OR extra_adults = 0 OR extra_adult_rate IS NOT NULL) AND (extra_beds IS NULL OR extra_beds = 0 OR extra_bed_rate IS NOT NULL)),
  ADD CONSTRAINT lodging_charges_tax_mode CHECK (kind IN ('extra', 'goods') OR (tax_mode = 'exclusive' AND (tax_rate_id IS NOT NULL OR kind = 'meal'))),
  ADD CONSTRAINT lodging_charges_net CHECK ((tax_mode = 'exclusive' AND net = amount) OR (tax_mode = 'inclusive' AND net + tax = amount)),
  ADD CONSTRAINT lodging_charges_tax CHECK (tax_mode = 'inclusive' OR tax = round(net * tax_rate / 100, 2)),
  ADD CONSTRAINT lodging_charges_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL OR line_id IS NULL)),
  ADD CONSTRAINT lodging_charges_key CHECK (kind IN ('room_night', 'meal') OR request_key IS NOT NULL),
  ADD CONSTRAINT lodging_charges_folio CHECK (folio_id IS NULL OR kind <> 'cancellation');
-- A night's meals are charged once; a day use, an early check-in and a late check-out once a stay.
CREATE UNIQUE INDEX lodging_charges_one_meal ON lodging_charges(business_id, stay_id, night) WHERE kind = 'meal' AND voided_at IS NULL;
CREATE UNIQUE INDEX lodging_charges_once ON lodging_charges(business_id, stay_id, kind) WHERE kind IN ('day_use', 'early_check_in', 'late_check_out') AND voided_at IS NULL;
CREATE INDEX lodging_charges_folio ON lodging_charges(business_id, folio_id) WHERE folio_id IS NOT NULL;

-- --- The rules, with the new parts ----------------------------------------------------------------

-- A stay keeps its number, guest and where it was made, and is never deleted
-- (a group's stay takes its guest from the rooming list while it is reserved).
-- It goes reserved → in the house → checked out, or is cancelled (or marked a
-- no-show once its arrival day has come) while reserved. A room it takes is in
-- use, at its location and of its room type; a guest checks in, on a day from
-- the arrival to the night before the departure, to a room that is vacant and
-- clean, and moves only to one. Its arrival changes while it is reserved; its
-- departure while it is not checked out, never before a night already posted;
-- the adults and children are the occupants in the room. Checking out ends the
-- stay on the business's date (a stay of one night at least); a guest past the
-- departure date is extended first. A day use stays one, a block of hours on
-- its own day; a plan is one of its room type's; a stay stays in its group.
-- What was recorded at the check-in, the check-out and a cancellation is
-- written once, with it; the bill once. A stay checked out, cancelled or marked
-- a no-show no longer changes.
CREATE OR REPLACE FUNCTION lodging_stays_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE today DATE; room RECORD; last_night DATE; done TEXT; check_room BOOLEAN; moving_in BOOLEAN := FALSE; tz TEXT; grown INTEGER; young INTEGER;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
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
  -- A plan of its room type.
  IF NEW.rate_plan_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.rate_plan_id IS DISTINCT FROM OLD.rate_plan_id OR NEW.room_type_id <> OLD.room_type_id)
     AND NOT EXISTS (SELECT 1 FROM lodging_rate_plans WHERE business_id = NEW.business_id AND id = NEW.rate_plan_id AND room_type_id = NEW.room_type_id) THEN
    RAISE EXCEPTION 'Stay %: its rate plan is one of its room type''s', NEW.stay_no USING ERRCODE = '23514';
  END IF;
  -- A day use is a block of hours within its own day.
  IF NEW.day_use AND (TG_OP = 'INSERT' OR NEW.day_from <> OLD.day_from OR NEW.day_until <> OLD.day_until OR NEW.arrival <> OLD.arrival) THEN
    SELECT timezone INTO tz FROM businesses WHERE id = NEW.business_id;
    IF (NEW.day_from AT TIME ZONE tz)::date <> NEW.arrival OR NEW.day_until > ((NEW.arrival + 1)::timestamp AT TIME ZONE tz) THEN
      RAISE EXCEPTION 'Stay %: a day use is a block of hours within its own day', NEW.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.stay_no <> OLD.stay_no OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.request_key <> OLD.request_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.day_use <> OLD.day_use OR NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'A stay keeps its number, its guest and where it was made' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contact_id <> OLD.contact_id OR NEW.guest_name <> OLD.guest_name OR NEW.guest_phone IS DISTINCT FROM OLD.guest_phone)
     AND NOT (OLD.group_id IS NOT NULL AND OLD.status = 'reserved' AND NEW.status = 'reserved') THEN
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
  -- In the house, the adults and children are the occupants in the room (joining and leaving partway).
  IF OLD.status = 'in_house' AND (NEW.adults <> OLD.adults OR NEW.children <> OLD.children) THEN
    SELECT count(*) FILTER (WHERE NOT child)::int, count(*) FILTER (WHERE child)::int INTO grown, young FROM lodging_stay_guests
    WHERE business_id = NEW.business_id AND stay_id = NEW.id AND departed_at IS NULL;
    IF grown <> NEW.adults OR young <> NEW.children THEN
      RAISE EXCEPTION 'Stay %: the adults and children are the occupants in the room', OLD.stay_no USING ERRCODE = '23514';
    END IF;
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
    IF NOT EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id AND d.kind = 'sale'
       AND (d.contact_id = CASE WHEN NEW.status = 'checked_out' THEN COALESCE(NEW.bill_to_contact_id, NEW.contact_id) ELSE NEW.contact_id END
         OR (NEW.status = 'checked_out' AND EXISTS (SELECT 1 FROM lodging_folios f WHERE f.business_id = NEW.business_id AND f.stay_id = NEW.id AND f.document_id = d.id)))) THEN
      RAISE EXCEPTION 'Stay % is billed on a sale to its guest, to the company it is billed to, or to one of its folios', OLD.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- An occupant is recorded as they check in, to a stay in the house (with the
-- check-in, or joining partway). Their details are corrected while the stay is
-- in the house; they leave once, partway or with the check-out; each Form-III
-- report is marked once (the departure's once they have left). An occupant's
-- record is never deleted.
CREATE OR REPLACE FUNCTION lodging_stay_guests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.stay_id <> OLD.stay_id OR NEW.seq <> OLD.seq OR NEW.arrived_at <> OLD.arrived_at OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.request_key IS DISTINCT FROM OLD.request_key THEN
    RAISE EXCEPTION 'An occupant''s record keeps its stay and when they arrived' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) AND (stay.status <> 'in_house' OR OLD.departed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Stay % has left: its occupants'' details are kept as they were', stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.departed_at IS DISTINCT FROM OLD.departed_at AND (OLD.departed_at IS NOT NULL OR stay.status NOT IN ('in_house', 'checked_out') OR NEW.departed_at <> now()) THEN
    RAISE EXCEPTION 'Stay %: an occupant leaves once, partway or with the check-out', stay.stay_no USING ERRCODE = '23514';
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

-- A charge goes on the folio of a stay in the house (a cancellation charge on a
-- reservation being cancelled), when it is written, on one of the stay's own
-- folios or its group's not yet billed. A room night is one of the stay's
-- nights that has come, for the room the guest is in, billed as its room
-- type's item at that night's rates as the stay was priced (with each adult
-- beyond the base, each child and each extra bed), less the stay's discount,
-- and with the GST slab its value after the discount decides: at or below the
-- settings' limit the lower slab, above it the higher, the GST worked out to
-- the paisa. A day use is its block's price, less the discount, at the slab
-- its value would take for a night. A night's meals are its plan's meal rates
-- for the stay's adults and children, at the meal item's slab. An early
-- check-in or a late check-out is billed as the room type's nights at a
-- room-night slab. An extra is a service item and goods are an item kept in
-- stock by quantity (not a room type's), at their item's slab, charged on the
-- day. A charge is kept as it was posted, moved between folios before it is
-- billed; it is voided once, before it is billed, while the guest is in the
-- house; its bill line is given once, a line of its own item on a sale to whom
-- its folio is billed. It is never deleted.
CREATE OR REPLACE FUNCTION lodging_charges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stay RECORD; settings RECORD; sku RECORD; want RECORD; folio RECORD; today DATE; room_item BIGINT; slab BIGINT; slab_rate NUMERIC; worth NUMERIC; cut NUMERIC;
  meal NUMERIC; bill_contact BIGINT;
  kept TEXT[] := ARRAY['line_id', 'void_reason', 'voided_by', 'voided_at', 'folio_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A charge on the folio is kept as it was posted: void it instead' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO stay FROM lodging_stays WHERE business_id = NEW.business_id AND id = NEW.stay_id;
  bill_contact := CASE WHEN NEW.kind = 'cancellation' THEN stay.contact_id ELSE COALESCE(stay.bill_to_contact_id, stay.contact_id) END;
  IF NEW.folio_id IS NOT NULL THEN
    SELECT * INTO folio FROM lodging_folios WHERE business_id = NEW.business_id AND id = NEW.folio_id;
    IF folio.stay_id IS DISTINCT FROM NEW.stay_id AND (folio.group_id IS NULL OR folio.group_id IS DISTINCT FROM stay.group_id) THEN
      RAISE EXCEPTION 'A charge of stay % goes on one of its own folios, or on its group''s', stay.stay_no USING ERRCODE = '23514';
    END IF;
    IF folio.document_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.folio_id IS DISTINCT FROM OLD.folio_id) THEN
      RAISE EXCEPTION 'Folio % is billed already: post the charge to another folio', folio.name USING ERRCODE = '23514';
    END IF;
    bill_contact := folio.contact_id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'A charge on the folio is kept as it was posted' USING ERRCODE = '23514';
    END IF;
    IF NEW.folio_id IS DISTINCT FROM OLD.folio_id AND (OLD.line_id IS NOT NULL OR OLD.voided_at IS NOT NULL OR NEW.line_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Stay %: a charge billed or voided stays on its folio', stay.stay_no USING ERRCODE = '23514';
    END IF;
    IF NEW.line_id IS DISTINCT FROM OLD.line_id AND (OLD.line_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM business_document_lines dl JOIN business_documents d ON d.business_id = dl.business_id AND d.id = dl.document_id
         WHERE dl.business_id = NEW.business_id AND dl.id = NEW.line_id AND dl.sku_id = NEW.sku_id AND d.kind = 'sale' AND d.contact_id = bill_contact)) THEN
      RAISE EXCEPTION 'A charge of stay % is billed once, on a line of its own item on its folio''s bill', stay.stay_no USING ERRCODE = '23514';
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
  IF NEW.kind IN ('extra', 'goods') THEN
    SELECT p.kind, s.tax_rate, s.tax_rate_id, s.label, s.tracking INTO sku FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
    WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
    IF NEW.kind = 'extra' AND sku.kind IS DISTINCT FROM 'service' THEN
      RAISE EXCEPTION '% is goods kept in stock: it goes on the folio as goods', sku.label USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'goods' AND (sku.kind IS DISTINCT FROM 'goods' OR sku.tracking IN ('batch', 'serial')) THEN
      RAISE EXCEPTION '% is not goods kept by quantity: sell it on a bill of its own', sku.label USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM lodging_room_types WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id) THEN
      RAISE EXCEPTION '% is a room type''s nights: they are posted by the night audit', sku.label USING ERRCODE = '23514';
    END IF;
    IF NEW.tax_rate <> sku.tax_rate OR NEW.tax_rate_id IS DISTINCT FROM sku.tax_rate_id OR NEW.night <> today THEN
      RAISE EXCEPTION 'An extra is charged on the day it is posted, with GST at its item''s slab' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind = 'meal' THEN
    SELECT * INTO want FROM lodging_stay_nights WHERE business_id = NEW.business_id AND stay_id = NEW.stay_id AND night = NEW.night;
    IF NOT FOUND OR want.meal_sku_id IS NULL OR NEW.night < stay.arrival OR NEW.night >= stay.departure OR NEW.night > today THEN
      RAISE EXCEPTION 'The meals of the night of % are posted once it has come, on a night of stay % whose plan has meals', lodging_day_words(NEW.night), stay.stay_no USING ERRCODE = '23514';
    END IF;
    SELECT tax_rate, tax_rate_id INTO sku FROM catalog_skus WHERE business_id = NEW.business_id AND id = want.meal_sku_id;
    meal := stay.adults * want.meal_adult_rate + stay.children * COALESCE(want.meal_child_rate, 0);
    IF NEW.sku_id <> want.meal_sku_id OR NEW.quantity <> 1 OR NEW.amount <> meal OR NEW.unit_price <> meal OR NEW.tax_rate <> sku.tax_rate
       OR NEW.tax_rate_id IS DISTINCT FROM sku.tax_rate_id THEN
      RAISE EXCEPTION 'The meals of the night of % of stay % are charged at its plan''s meal rates, at the meal item''s slab', lodging_day_words(NEW.night), stay.stay_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IN ('early_check_in', 'late_check_out') THEN
    IF NEW.sku_id <> room_item OR NEW.quantity <> 1 OR settings.low_tax_rate_id IS NULL OR NEW.tax_rate_id NOT IN (settings.low_tax_rate_id, settings.high_tax_rate_id)
       OR NEW.tax_rate <> (SELECT rate FROM business_tax_rates WHERE business_id = NEW.business_id AND id = NEW.tax_rate_id) THEN
      RAISE EXCEPTION 'An early check-in or late check-out charge of stay % is billed as its room type''s nights, at a room-night slab', stay.stay_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- A room night or a day use.
  IF NEW.room_id <> stay.room_id THEN
    RAISE EXCEPTION 'A room night of stay % is charged for the room the guest is in', stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'day_use' THEN
    IF NOT stay.day_use OR NEW.night <> stay.arrival THEN
      RAISE EXCEPTION 'Stay % is not a day use on %', stay.stay_no, lodging_day_words(NEW.night) USING ERRCODE = '23514';
    END IF;
  ELSE
    IF stay.day_use THEN
      RAISE EXCEPTION 'Stay % is a day use: it has no room nights', stay.stay_no USING ERRCODE = '23514';
    END IF;
    IF NEW.night < stay.arrival OR NEW.night >= stay.departure THEN
      RAISE EXCEPTION 'The night of % is not one of stay %''s nights', lodging_day_words(NEW.night), stay.stay_no USING ERRCODE = '23514';
    END IF;
    IF NEW.night > today THEN
      RAISE EXCEPTION 'The night of % is posted once it has come', lodging_day_words(NEW.night) USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.sku_id <> room_item THEN
    RAISE EXCEPTION 'A room night of stay % is billed as its room type''s nights', stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF settings.low_tax_rate_id IS NULL THEN
    RAISE EXCEPTION 'Room nights are not billed until their two GST slabs are set (Settings › Room types & rates)' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO want FROM lodging_stay_nights WHERE business_id = NEW.business_id AND stay_id = NEW.stay_id AND night = NEW.night;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The night of % of stay % has no rate: change the stay to price it again', lodging_day_words(NEW.night), stay.stay_no USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'day_use' THEN
    IF want.rate_kind <> 'day_use' OR NEW.room_rate <> want.room_rate THEN
      RAISE EXCEPTION 'The day use of stay % is charged at its block''s price', stay.stay_no USING ERRCODE = '23514';
    END IF;
    worth := NEW.room_rate;
  ELSE
    IF NEW.rate_kind <> want.rate_kind OR NEW.room_rate <> want.room_rate OR NEW.extra_adults <> GREATEST(0, stay.adults - stay.base_occupancy) OR NEW.children <> stay.children
       OR NEW.extra_beds <> stay.extra_beds OR NEW.extra_adult_rate IS DISTINCT FROM want.extra_adult_rate OR NEW.child_rate IS DISTINCT FROM want.child_rate
       OR NEW.extra_bed_rate IS DISTINCT FROM want.extra_bed_rate THEN
      RAISE EXCEPTION 'The night of % of stay % is charged at the stay''s rate for that night', lodging_day_words(NEW.night), stay.stay_no USING ERRCODE = '23514';
    END IF;
    worth := NEW.room_rate + NEW.extra_adults * COALESCE(NEW.extra_adult_rate, 0) + NEW.children * COALESCE(NEW.child_rate, 0) + NEW.extra_beds * COALESCE(NEW.extra_bed_rate, 0);
  END IF;
  cut := round(worth * COALESCE(stay.discount_percent, 0) / 100, 2);
  IF COALESCE(NEW.discount, 0) <> cut THEN
    RAISE EXCEPTION 'The night of % of stay % takes the stay''s discount of %%%', lodging_day_words(NEW.night), stay.stay_no, COALESCE(stay.discount_percent, 0) USING ERRCODE = '23514';
  END IF;
  slab := CASE WHEN NEW.amount <= settings.slab_limit THEN settings.low_tax_rate_id ELSE settings.high_tax_rate_id END;
  SELECT rate INTO slab_rate FROM business_tax_rates WHERE business_id = NEW.business_id AND id = slab;
  IF NEW.tax_rate_id <> slab OR NEW.tax_rate <> slab_rate THEN
    RAISE EXCEPTION 'The night of % is valued at %: a room night at or below % is billed at the lower slab, above it at the higher', lodging_day_words(NEW.night),
      NEW.amount, settings.slab_limit USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A room type never holds more stays on a night than it has rooms in use at
-- the stay's location (a day use holds hours, not a night). One room type at
-- a time: its row is the lock, so two stays saved together are checked one
-- after the other.
CREATE OR REPLACE FUNCTION lodging_check_type(target_business BIGINT, target_stay BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s RECORD; type_name TEXT; rooms INTEGER; busiest RECORD;
BEGIN
  SELECT * INTO s FROM lodging_stays WHERE business_id = target_business AND id = target_stay;
  IF NOT FOUND OR s.status NOT IN ('reserved', 'in_house') OR s.day_use THEN RETURN; END IF;
  SELECT k.label INTO type_name FROM lodging_room_types t JOIN catalog_skus k ON k.business_id = t.business_id AND k.id = t.sku_id
  WHERE t.business_id = target_business AND t.id = s.room_type_id FOR UPDATE OF t;
  SELECT count(*)::int INTO rooms FROM lodging_rooms WHERE business_id = target_business AND location_id = s.location_id AND room_type_id = s.room_type_id AND active;
  SELECT n::date AS night, count(x.id)::int AS held INTO busiest
  FROM generate_series(s.arrival::timestamp, (s.departure - 1)::timestamp, interval '1 day') n
  JOIN lodging_stays x ON x.business_id = target_business AND x.location_id = s.location_id AND x.room_type_id = s.room_type_id
    AND x.status IN ('reserved', 'in_house') AND NOT x.day_use AND x.arrival <= n::date AND x.departure > n::date
  GROUP BY n HAVING count(x.id) > rooms ORDER BY n LIMIT 1;
  IF FOUND THEN
    IF rooms = 0 THEN
      RAISE EXCEPTION 'There are no % rooms at this location yet: add them under Settings › Room types & rates', type_name USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Every % room is taken on the night of % (% stays for % rooms): choose other dates or another room type', type_name,
      lodging_day_words(busiest.night), busiest.held, rooms USING ERRCODE = '23514';
  END IF;
END $$;

-- When the work is saved: a stay checked in has every occupant recorded (its
-- adults and its children); a stay checked out has every one of its nights
-- (or its day use) billed, every charge on its folios billed or voided (those
-- on its group's folio are billed with the group), and its occupants gone.
CREATE OR REPLACE FUNCTION lodging_stays_done() RETURNS trigger LANGUAGE plpgsql AS $$
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
    SELECT count(DISTINCT c.night)::int INTO billed FROM lodging_charges c
    WHERE c.business_id = NEW.business_id AND c.stay_id = NEW.id AND c.kind = CASE WHEN NEW.day_use THEN 'day_use' ELSE 'room_night' END
      AND c.voided_at IS NULL AND c.night >= NEW.arrival AND c.night < NEW.departure
      AND (c.line_id IS NOT NULL OR EXISTS (SELECT 1 FROM lodging_folios f WHERE f.business_id = c.business_id AND f.id = c.folio_id AND f.group_id IS NOT NULL));
    IF billed <> (CASE WHEN NEW.day_use THEN 1 ELSE NEW.departure - NEW.arrival END) THEN
      RAISE EXCEPTION 'Stay %: every night from arrival to departure (or its day use) is billed at check-out', NEW.stay_no USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM lodging_charges c WHERE c.business_id = NEW.business_id AND c.stay_id = NEW.id AND c.voided_at IS NULL
       AND ((c.line_id IS NULL AND NOT EXISTS (SELECT 1 FROM lodging_folios f WHERE f.business_id = c.business_id AND f.id = c.folio_id AND f.group_id IS NOT NULL))
         OR (c.kind IN ('room_night', 'meal') AND c.night >= NEW.departure))) THEN
      RAISE EXCEPTION 'Stay %: every charge on the folio is billed or voided at check-out', NEW.stay_no USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM lodging_stay_guests WHERE business_id = NEW.business_id AND stay_id = NEW.id AND departed_at IS NULL) THEN
      RAISE EXCEPTION 'Stay %: the occupants leave with the check-out', NEW.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- A day use never shares its room's hours with a night stay or another day use
-- (a night stay holds its room from the check-in time on its arrival day to
-- the check-out time on its departure day). Checked when the work is saved,
-- the room's row the lock, so two saved together are checked one after the other.
CREATE FUNCTION lodging_stays_hours() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD; tz TEXT; ci TIME; co TIME; clash RECORD; room_no TEXT;
BEGIN
  SELECT * INTO s FROM lodging_stays WHERE business_id = NEW.business_id AND id = NEW.id;
  IF s.room_id IS NULL OR s.status NOT IN ('reserved', 'in_house') THEN RETURN NULL; END IF;
  IF NOT s.day_use AND NOT EXISTS (SELECT 1 FROM lodging_stays x WHERE x.business_id = s.business_id AND x.room_id = s.room_id AND x.day_use AND x.status IN ('reserved', 'in_house')) THEN
    RETURN NULL;
  END IF;
  SELECT r.room_no INTO room_no FROM lodging_rooms r WHERE r.business_id = s.business_id AND r.id = s.room_id FOR UPDATE;
  SELECT timezone INTO tz FROM businesses WHERE id = s.business_id;
  SELECT check_in_time, check_out_time INTO ci, co FROM lodging_settings WHERE business_id = s.business_id;
  ci := COALESCE(ci, '12:00'::time); co := COALESCE(co, '11:00'::time);
  SELECT x.stay_no, x.guest_name, x.day_use INTO clash FROM lodging_stays x
  WHERE x.business_id = s.business_id AND x.room_id = s.room_id AND x.id <> s.id AND x.status IN ('reserved', 'in_house') AND (x.day_use OR s.day_use)
    AND lodging_stay_held(x.day_use, x.day_from, x.day_until, x.arrival, x.departure, tz, ci, co) && lodging_stay_held(s.day_use, s.day_from, s.day_until, s.arrival, s.departure, tz, ci, co)
  ORDER BY x.arrival, x.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Room % is held by % (%) at those hours: a day use never shares its room''s hours with another stay', room_no, clash.stay_no, clash.guest_name USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lodging_stays_hours AFTER INSERT OR UPDATE ON lodging_stays
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lodging_stays_hours();

-- Down Migration
DROP TRIGGER lodging_stays_hours ON lodging_stays;
DROP FUNCTION lodging_stays_hours();
-- The rules as they were (1791970000000_lodging, and the stays' guard as 1791977000000_personal-data left it).
CREATE OR REPLACE FUNCTION lodging_stays_done() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION lodging_check_type(target_business BIGINT, target_stay BIGINT) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION lodging_charges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION lodging_stay_guests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION lodging_stays_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE today DATE; room RECORD; last_night DATE; done TEXT; check_room BOOLEAN; moving_in BOOLEAN := FALSE;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
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

-- The folio's charges as they were (refuses while a charge of a new kind, a discount or a folio is kept: restore a backup instead).
DROP INDEX lodging_charges_folio;
DROP INDEX lodging_charges_once;
DROP INDEX lodging_charges_one_meal;
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'lodging_charges'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE lodging_charges DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE lodging_charges DROP COLUMN folio_id, DROP COLUMN discount,
  ADD CONSTRAINT lodging_charges_kind_check CHECK (kind IN ('room_night', 'extra', 'cancellation')),
  ADD CONSTRAINT lodging_charges_label_check CHECK (btrim(label) <> ''),
  ADD CONSTRAINT lodging_charges_quantity_check CHECK (quantity > 0 AND quantity <= 10000),
  ADD CONSTRAINT lodging_charges_rate_kind_check CHECK (rate_kind IN ('rack', 'weekend', 'agreed')),
  ADD CONSTRAINT lodging_charges_room_rate_check CHECK (room_rate > 0),
  ADD CONSTRAINT lodging_charges_extra_adults_check CHECK (extra_adults >= 0),
  ADD CONSTRAINT lodging_charges_extra_adult_rate_check CHECK (extra_adult_rate >= 0),
  ADD CONSTRAINT lodging_charges_children_check CHECK (children >= 0),
  ADD CONSTRAINT lodging_charges_child_rate_check CHECK (child_rate >= 0),
  ADD CONSTRAINT lodging_charges_extra_beds_check CHECK (extra_beds >= 0),
  ADD CONSTRAINT lodging_charges_extra_bed_rate_check CHECK (extra_bed_rate >= 0),
  ADD CONSTRAINT lodging_charges_unit_price_check CHECK (unit_price > 0),
  ADD CONSTRAINT lodging_charges_amount_check CHECK (amount > 0),
  ADD CONSTRAINT lodging_charges_tax_mode_check CHECK (tax_mode IN ('inclusive', 'exclusive')),
  ADD CONSTRAINT lodging_charges_tax_rate_check CHECK (tax_rate BETWEEN 0 AND 100),
  ADD CONSTRAINT lodging_charges_net_check CHECK (net >= 0),
  ADD CONSTRAINT lodging_charges_tax_check CHECK (tax >= 0),
  ADD CONSTRAINT lodging_charges_note_check CHECK (btrim(note) <> ''),
  ADD CONSTRAINT lodging_charges_void_reason_check CHECK (btrim(void_reason) <> ''),
  ADD CHECK ((kind = 'room_night') = (room_id IS NOT NULL)),
  ADD CHECK ((kind = 'room_night') = (rate_kind IS NOT NULL)),
  ADD CHECK (kind <> 'room_night' OR (quantity = 1 AND room_rate IS NOT NULL AND extra_adults IS NOT NULL AND children IS NOT NULL AND extra_beds IS NOT NULL
    AND amount = room_rate + extra_adults * COALESCE(extra_adult_rate, 0) + children * COALESCE(child_rate, 0) + extra_beds * COALESCE(extra_bed_rate, 0)
    AND unit_price = amount)),
  ADD CHECK (kind = 'room_night' OR (room_rate IS NULL AND extra_adults IS NULL AND children IS NULL AND extra_beds IS NULL
    AND extra_adult_rate IS NULL AND child_rate IS NULL AND extra_bed_rate IS NULL)),
  ADD CHECK (extra_adults IS NULL OR extra_adults = 0 OR extra_adult_rate IS NOT NULL),
  ADD CHECK (extra_beds IS NULL OR extra_beds = 0 OR extra_bed_rate IS NOT NULL),
  ADD CHECK (kind = 'extra' OR (tax_mode = 'exclusive' AND tax_rate_id IS NOT NULL)),
  ADD CHECK ((tax_mode = 'exclusive' AND net = amount) OR (tax_mode = 'inclusive' AND net + tax = amount)),
  ADD CHECK (tax_mode = 'inclusive' OR tax = round(net * tax_rate / 100, 2)),
  ADD CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  ADD CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  ADD CHECK (voided_at IS NULL OR line_id IS NULL),
  ADD CHECK (kind = 'room_night' OR request_key IS NOT NULL);

ALTER TABLE lodging_stay_guests DROP CONSTRAINT lodging_stay_guests_request_key, DROP COLUMN request_key;
DROP TABLE lodging_guest_profiles, lodging_routes, lodging_stay_nights;

ALTER TABLE lodging_stays DROP CONSTRAINT lodging_stays_room_free,
  ADD CONSTRAINT lodging_stays_room_free EXCLUDE USING gist (int8range(room_id, room_id, '[]') WITH &&, daterange(arrival, departure) WITH &&)
    WHERE (room_id IS NOT NULL AND status IN ('reserved', 'in_house')),
  ADD CHECK (status <> 'checked_out' OR document_id IS NOT NULL);
DROP INDEX lodging_stays_day_use;
DROP INDEX lodging_stays_group;
ALTER TABLE lodging_stays DROP CONSTRAINT lodging_stays_day_use, DROP CONSTRAINT lodging_stays_discount, DROP COLUMN group_id, DROP COLUMN day_hours, DROP COLUMN day_until,
  DROP COLUMN day_from, DROP COLUMN day_use, DROP COLUMN discount_reason, DROP COLUMN discount_percent, DROP COLUMN policy, DROP COLUMN rate_plan_id;

DROP TABLE lodging_folios, lodging_groups, lodging_day_use_rates, lodging_rate_days, lodging_seasons, lodging_rate_plans, lodging_policies;
DROP FUNCTION lodging_routes_guard();
DROP FUNCTION lodging_folios_guard();
DROP FUNCTION lodging_groups_guard();
DROP FUNCTION lodging_plan_of_type();
DROP FUNCTION lodging_rate_plans_guard();
DROP FUNCTION lodging_kept();
DROP FUNCTION lodging_stay_held(BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, TEXT, TIME, TIME);

DELETE FROM business_number_series WHERE document_kind = 'stay_group';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'stay_group');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

ALTER TABLE lodging_settings DROP COLUMN check_out_time, DROP COLUMN check_in_time;
