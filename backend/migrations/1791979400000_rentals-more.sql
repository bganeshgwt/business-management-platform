-- Up Migration
-- What a rental and hire business still needed on top of its bookings: kits
-- that book their parts, the statutory hirer register of the rent-a-cab and
-- rent-a-motorcycle schemes with the licence class checked against the
-- vehicle, each vehicle's papers and the facts that decide its GST slab, a
-- kilometre allowance and a fuel charge worked out at the return, late fees
-- in slabs with a cap, cancellation charges worked out from the hours before
-- the out time, pools counted per location with transfers between them, the
-- condition checked against a checklist with photos and signatures, scanning
-- units at the handover and the return, service schedules and downtime booked
-- ahead, a discount on a booking, and the use and earnings of each unit.
--
-- Hire items & bookings (module "rentals"), new tables:
--   rental_classes          the shop's classes of what it hires out (two-
--                           wheelers, cars, tents): the condition checklist
--                           checked at every handover and return, and late
--                           fee slabs with a cap that its items take unless
--                           they have their own.
--   rental_kit_parts        what a kit is made of: each part (an item from a
--                           pool) and how many of it in one kit. Booking a kit
--                           books its parts, each checked for what is free.
--   rental_pool_counts      how many of a pool each location has. The item
--                           keeps the total, worked out from these.
--   rental_transfers        units and pieces of a pool moved from one location
--                           to another, with when; never changed.
--   rental_downtime         maintenance booked ahead for a unit: it holds the
--                           unit as a booking does. Cancelled, never deleted.
--   rental_services         each service done on a unit, with its meter.
--   rental_hirers           the hirer register of a handover (Forms 5 and 3 of
--                           the schemes; 6 and 4 for a foreigner): the full
--                           address, the driving licence's issuing authority,
--                           classes and issue date, a foreigner's passport,
--                           date of birth, driving permit and visa; and the
--                           original document held, with when it went back.
--   rental_conditions       a line's checklist as checked at the handover or a
--                           return.
--   rental_files            photos of what was handed over and came back, and
--                           the signatures drawn on the screen by the hirer and
--                           the shop, at both. Never changed or deleted. No
--                           copy of an ID document is kept.
--   rental_cancellations    the cancellation charge worked out from the shop's
--                           slabs, and a manager's waiver of it.
-- And on the tables of the module:
--   rental_settings         the days before a vehicle's paper runs out that
--                           the bell warns (30, then 7, until changed), whether
--                           a vehicle with a paper run out is refused or only
--                           warned about at the handover (refused, until
--                           changed), and the cancellation slabs (none until
--                           the shop sets them).
--   rental_items            a kit (billed as itself or by its parts), its
--                           class, late fee slabs and a cap, a kilometre
--                           allowance (a day or a booking) with the extra-
--                           kilometre rate, and a fuel charge (an eighth of a
--                           tank, or a litre by the tank's size).
--   rental_units            where the unit is kept, a vehicle's class (as a
--                           driving licence names it), engine size, length and
--                           fuel, its papers' dates (registration, permit,
--                           insurance, PUC, fitness), and its service schedule.
--   rental_bookings         a discount on the hire (a percent, with its reason
--                           and who gave it).
--   rental_booking_lines    a kit's line and its parts' lines; whether a line's
--                           hire is billed; the discount on it; and the late
--                           slabs, cap, kilometre allowance and fuel charge as
--                           booked. Fuel is noted in eighths of a tank.
--   rental_return_lines     the extra kilometres and the fuel short, with their
--                           charges and the bill lines that charged them.
-- The rules the database keeps: a kit's parts are booked with it, as many as
-- it has of each; a pool is held at the location of its booking, never more
-- than that location has; a unit is booked where it is kept, and moves only by
-- a transfer; downtime holds a unit as a booking does, and is booked only over
-- free time; the late fee, the extra kilometres and the fuel charge of each
-- return are worked out from the line as booked; a licence of the hirer covers
-- the class of each self-drive vehicle; what is recorded stays as it was.

-- --- Checks of the shop's slabs --------------------------------------------------------------------

-- Late fee slabs: [{ from, flat, times }, ...] — each from so many hours late
-- (the first from 0, rising), a flat amount and a multiple of the hourly rate
-- for each hour late; at least one of the two. A multiple needs the hourly rate.
CREATE FUNCTION rental_late_slabs_ok(slabs JSONB, hourly NUMERIC) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s JSONB; prev NUMERIC := -1; f NUMERIC; flat NUMERIC; times NUMERIC; n INTEGER := 0;
BEGIN
  IF jsonb_typeof(slabs) IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  IF jsonb_array_length(slabs) NOT BETWEEN 1 AND 10 THEN RETURN FALSE; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(slabs) LOOP
    IF jsonb_typeof(s) <> 'object' THEN RETURN FALSE; END IF;
    IF jsonb_typeof(s->'from') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'flat') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'times') IS DISTINCT FROM 'number' THEN
      RETURN FALSE;
    END IF;
    f := (s->>'from')::numeric; flat := (s->>'flat')::numeric; times := (s->>'times')::numeric;
    IF f <> trunc(f) OR f <= prev OR f > 2160 OR (n = 0 AND f <> 0) THEN RETURN FALSE; END IF;
    IF flat < 0 OR flat > 1000000 OR scale(flat) > 2 OR times < 0 OR times > 100 OR scale(times) > 2 OR (flat = 0 AND times = 0) THEN RETURN FALSE; END IF;
    IF times > 0 AND hourly IS NULL THEN RETURN FALSE; END IF;
    prev := f; n := n + 1;
  END LOOP;
  RETURN TRUE;
END $$;

-- Cancellation slabs: [{ hours, percent }, ...] — from so many hours before the
-- out time (each different), so much of the hire.
CREATE FUNCTION rental_cancel_slabs_ok(slabs JSONB) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s JSONB; h NUMERIC; p NUMERIC; seen NUMERIC[] := '{}';
BEGIN
  IF jsonb_typeof(slabs) IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  IF jsonb_array_length(slabs) NOT BETWEEN 1 AND 10 THEN RETURN FALSE; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(slabs) LOOP
    IF jsonb_typeof(s) <> 'object' OR jsonb_typeof(s->'hours') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'percent') IS DISTINCT FROM 'number' THEN RETURN FALSE; END IF;
    h := (s->>'hours')::numeric; p := (s->>'percent')::numeric;
    IF h <> trunc(h) OR h < 0 OR h > 2160 OR h = ANY(seen) OR p < 0 OR p > 100 OR scale(p) > 2 THEN RETURN FALSE; END IF;
    seen := seen || h;
  END LOOP;
  RETURN TRUE;
END $$;

-- A fuel level in eighths of a tank.
CREATE FUNCTION rental_eighths(level TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE level WHEN 'empty' THEN 0 WHEN 'one_eighth' THEN 1 WHEN 'quarter' THEN 2 WHEN 'three_eighths' THEN 3 WHEN 'half' THEN 4
    WHEN 'five_eighths' THEN 5 WHEN 'three_quarters' THEN 6 WHEN 'seven_eighths' THEN 7 WHEN 'full' THEN 8 END;
$$;

-- The late fee of so many back late, by the line's rule as booked: nothing
-- within the grace time; by the hour or the day, each one or part of one at the
-- late rate; by slabs, the slab the hours late fall in prices all of them (its
-- flat amount and its multiple of the hourly rate for each hour); never more
-- than the cap for each one. Units are the hours (or days) charged.
CREATE FUNCTION rental_late_fee(per TEXT, rate NUMERIC, grace INTEGER, slabs JSONB, cap NUMERIC, minutes INTEGER, quantity INTEGER, OUT units INTEGER, OUT fee NUMERIC)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s JSONB; one NUMERIC;
BEGIN
  units := 0; fee := 0;
  IF per = 'none' OR minutes <= grace OR quantity <= 0 THEN RETURN; END IF;
  IF per = 'hour' THEN
    units := ceil(minutes / 60.0)::int; one := units * rate;
  ELSIF per = 'day' THEN
    units := ceil(minutes / 1440.0)::int; one := units * rate;
  ELSE
    units := ceil(minutes / 60.0)::int;
    SELECT e.value INTO s FROM jsonb_array_elements(slabs) WITH ORDINALITY AS e(value, n) WHERE (e.value->>'from')::numeric < units ORDER BY e.n DESC LIMIT 1;
    one := (s->>'flat')::numeric + round((s->>'times')::numeric * COALESCE(rate, 0) * units, 2);
  END IF;
  IF cap IS NOT NULL THEN one := LEAST(one, cap); END IF;
  fee := one * quantity;
END $$;

-- --- Settings ------------------------------------------------------------------------------------

ALTER TABLE rental_settings
  ADD COLUMN papers_warn_days SMALLINT NOT NULL DEFAULT 30 CHECK (papers_warn_days BETWEEN 1 AND 365),
  ADD COLUMN papers_urgent_days SMALLINT NOT NULL DEFAULT 7 CHECK (papers_urgent_days BETWEEN 0 AND 365),
  ADD COLUMN papers_lapsed TEXT NOT NULL DEFAULT 'refuse' CHECK (papers_lapsed IN ('warn', 'refuse')),
  ADD COLUMN cancel_slabs JSONB CHECK (cancel_slabs IS NULL OR rental_cancel_slabs_ok(cancel_slabs)),
  ADD COLUMN no_show_percent NUMERIC(5,2) CHECK (no_show_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT rental_settings_papers_days CHECK (papers_urgent_days < papers_warn_days);

-- --- Classes and kits ----------------------------------------------------------------------------

CREATE TABLE rental_classes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  -- The points checked at every handover and return of its items.
  checklist TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(checklist) <= 30),
  -- Late fee slabs and a cap for its items that have none of their own.
  late_slabs JSONB CHECK (late_slabs IS NULL OR rental_late_slabs_ok(late_slabs, 1)),
  late_cap NUMERIC(14,2) CHECK (late_cap > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX rental_classes_name ON rental_classes(business_id, lower(name));

-- A class is switched off, never deleted.
CREATE FUNCTION rental_classes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A class is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.checklist) p WHERE btrim(p) = '' OR length(p) > 80) THEN
    RAISE EXCEPTION 'Each point of a checklist is 1 to 80 characters' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_classes_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_classes
  FOR EACH ROW EXECUTE FUNCTION rental_classes_guard();

ALTER TABLE rental_items DROP CONSTRAINT rental_items_kind_check,
  ADD CONSTRAINT rental_items_kind_check CHECK (kind IN ('unit', 'pool', 'kit'));
ALTER TABLE rental_items DROP CONSTRAINT rental_items_late_per_check,
  ADD CONSTRAINT rental_items_late_per_check CHECK (late_per IN ('none', 'hour', 'day', 'slabs'));
ALTER TABLE rental_items
  -- A kit is billed as itself (its own rates) or by its parts (theirs).
  ADD COLUMN kit_billing TEXT CHECK (kit_billing IN ('kit', 'parts')),
  ADD COLUMN class_id BIGINT,
  ADD COLUMN late_slabs JSONB,
  ADD COLUMN late_cap NUMERIC(14,2) CHECK (late_cap > 0),
  -- Kilometres free each day or each booking; each one more at the extra-kilometre rate.
  ADD COLUMN km_allowance INTEGER CHECK (km_allowance BETWEEN 0 AND 100000),
  ADD COLUMN km_per TEXT CHECK (km_per IN ('day', 'booking')),
  ADD COLUMN extra_km_rate NUMERIC(14,2) CHECK (extra_km_rate > 0),
  -- Fuel short at the return: each eighth of a tank, or each litre (an eighth of the tank's litres).
  ADD COLUMN fuel_per TEXT CHECK (fuel_per IN ('eighth', 'litre')),
  ADD COLUMN fuel_rate NUMERIC(14,2) CHECK (fuel_rate > 0),
  ADD COLUMN tank_litres NUMERIC(7,1) CHECK (tank_litres > 0),
  ADD CONSTRAINT rental_items_class FOREIGN KEY (business_id, class_id) REFERENCES rental_classes(business_id, id),
  ADD CONSTRAINT rental_items_kit CHECK ((kind = 'kit') = (kit_billing IS NOT NULL) AND (kind <> 'kit' OR late_per = 'none')),
  ADD CONSTRAINT rental_items_slabs CHECK ((late_slabs IS NULL OR late_per = 'slabs') AND (late_slabs IS NULL OR rental_late_slabs_ok(late_slabs, COALESCE(late_rate, rate_hour)))),
  ADD CONSTRAINT rental_items_km CHECK ((km_allowance IS NULL) = (km_per IS NULL) AND (km_per IS NULL) = (extra_km_rate IS NULL) AND (km_per IS NULL OR meter = 'km')),
  ADD CONSTRAINT rental_items_fuel CHECK ((fuel_per IS NULL) = (fuel_rate IS NULL) AND (fuel_per IS DISTINCT FROM 'litre' OR tank_litres IS NOT NULL)
    AND (fuel_per IS NULL OR vehicle IS NOT NULL));
-- A kit billed by its parts has no rates of its own; slabs need no late rate.
ALTER TABLE rental_items DROP CONSTRAINT rental_items_check,
  ADD CONSTRAINT rental_items_check CHECK (COALESCE(rate_hour, rate_day, rate_week, rate_month) IS NOT NULL OR kit_billing = 'parts');
ALTER TABLE rental_items DROP CONSTRAINT rental_items_check6,
  ADD CONSTRAINT rental_items_check6 CHECK (late_per IN ('none', 'slabs') OR late_rate IS NOT NULL OR (late_per = 'hour' AND rate_hour IS NOT NULL)
    OR (late_per = 'day' AND rate_day IS NOT NULL));

CREATE TABLE rental_kit_parts (
  business_id BIGINT NOT NULL,
  kit_id BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  -- How many of the part are in one kit.
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, kit_id, part_id),
  FOREIGN KEY (business_id, kit_id) REFERENCES rental_items(business_id, id),
  FOREIGN KEY (business_id, part_id) REFERENCES rental_items(business_id, id)
);

-- A kit's parts are items from a pool. Bookings keep the parts they were made with.
CREATE FUNCTION rental_kit_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM rental_items WHERE business_id = NEW.business_id AND id = NEW.kit_id AND kind = 'kit') THEN
    RAISE EXCEPTION 'Parts belong to a kit' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rental_items WHERE business_id = NEW.business_id AND id = NEW.part_id AND kind = 'pool') THEN
    RAISE EXCEPTION 'A kit''s part is an item hired from a pool' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_kit_parts_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_kit_parts
  FOR EACH ROW EXECUTE FUNCTION rental_kit_parts_guard();

-- --- Locations: pools counted per location, units kept at one, transfers ---------------------------

CREATE TABLE rental_pool_counts (
  business_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 1000000),
  PRIMARY KEY (business_id, item_id, location_id),
  FOREIGN KEY (business_id, item_id) REFERENCES rental_items(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id)
);

-- A count is of an item from a pool, and is set to nothing rather than deleted.
CREATE FUNCTION rental_pool_counts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A location''s count of a pool is set to 0, never deleted' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rental_items WHERE business_id = NEW.business_id AND id = NEW.item_id AND kind = 'pool') THEN
    RAISE EXCEPTION 'A location counts the pieces of an item hired from a pool' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_pool_counts_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_pool_counts
  FOR EACH ROW EXECUTE FUNCTION rental_pool_counts_guard();

-- The item keeps its pool's total: what its locations have.
CREATE FUNCTION rental_pool_counts_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE rental_items SET pool_quantity = (SELECT COALESCE(sum(quantity), 0) FROM rental_pool_counts WHERE business_id = NEW.business_id AND item_id = NEW.item_id)
  WHERE business_id = NEW.business_id AND id = NEW.item_id;
  RETURN NULL;
END $$;
CREATE TRIGGER rental_pool_counts_total AFTER INSERT OR UPDATE ON rental_pool_counts
  FOR EACH ROW EXECUTE FUNCTION rental_pool_counts_total();

-- A new pool starts at the business's first location (the service moves it where it is kept).
CREATE FUNCTION rental_items_pool_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO rental_pool_counts(business_id, item_id, location_id, quantity)
  SELECT NEW.business_id, NEW.id, min(l.id), NEW.pool_quantity FROM business_locations l WHERE l.business_id = NEW.business_id AND l.active HAVING min(l.id) IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER rental_items_pool_start AFTER INSERT ON rental_items
  FOR EACH ROW WHEN (NEW.kind = 'pool') EXECUTE FUNCTION rental_items_pool_start();

-- Today's pools are at each business's first location.
INSERT INTO rental_pool_counts(business_id, item_id, location_id, quantity)
SELECT i.business_id, i.id, (SELECT min(l.id) FROM business_locations l WHERE l.business_id = i.business_id), i.pool_quantity
FROM rental_items i WHERE i.kind = 'pool';

ALTER TABLE rental_units
  ADD COLUMN location_id BIGINT,
  -- A vehicle's class, as a driving licence names it.
  ADD COLUMN vehicle_class TEXT CHECK (vehicle_class IN ('MC50CC', 'MCWOG', 'MCWG', 'LMV-NT', 'LMV', 'TRANS')),
  -- What decides a vehicle's GST slab: its engine, length and fuel.
  ADD COLUMN engine_cc INTEGER CHECK (engine_cc BETWEEN 1 AND 20000),
  ADD COLUMN length_mm INTEGER CHECK (length_mm BETWEEN 100 AND 30000),
  ADD COLUMN fuel_type TEXT CHECK (fuel_type IN ('petrol', 'diesel', 'cng', 'lpg', 'electric')),
  -- The dates its papers run until.
  ADD COLUMN rc_valid_until DATE,
  ADD COLUMN permit_valid_until DATE,
  ADD COLUMN insurance_valid_until DATE,
  ADD COLUMN puc_valid_until DATE,
  ADD COLUMN fitness_valid_until DATE,
  -- Serviced every so many running hours, kilometres or days, counted from the last service.
  ADD COLUMN service_per TEXT CHECK (service_per IN ('hours', 'km', 'days')),
  ADD COLUMN service_every INTEGER CHECK (service_every BETWEEN 1 AND 1000000),
  ADD COLUMN serviced_at TIMESTAMPTZ,
  ADD COLUMN serviced_meter NUMERIC(10,1) CHECK (serviced_meter >= 0),
  ADD CONSTRAINT rental_units_location FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  ADD CONSTRAINT rental_units_service CHECK ((service_per IS NULL) = (service_every IS NULL) AND (service_per IS NULL OR serviced_at IS NOT NULL));
UPDATE rental_units u SET location_id = (SELECT min(l.id) FROM business_locations l WHERE l.business_id = u.business_id);
ALTER TABLE rental_units ALTER COLUMN location_id SET NOT NULL;

-- A unit is kept at the business's first location unless placed elsewhere.
CREATE FUNCTION rental_units_home() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS NULL THEN
    SELECT min(id) INTO NEW.location_id FROM business_locations WHERE business_id = NEW.business_id AND active;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_units_home BEFORE INSERT ON rental_units
  FOR EACH ROW EXECUTE FUNCTION rental_units_home();

CREATE TABLE rental_transfers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  item_id BIGINT NOT NULL,
  -- A unit, or so many pieces of a pool.
  unit_id BIGINT,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  from_location_id BIGINT NOT NULL,
  to_location_id BIGINT NOT NULL,
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  -- When it moved.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, item_id) REFERENCES rental_items(business_id, id),
  FOREIGN KEY (business_id, item_id, unit_id) REFERENCES rental_units(business_id, item_id, id),
  FOREIGN KEY (business_id, from_location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, to_location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (from_location_id <> to_location_id),
  CHECK (unit_id IS NULL OR quantity = 1)
);
CREATE INDEX rental_transfers_list ON rental_transfers(business_id, created_at DESC);

-- A transfer is of a unit of an item hired one by one, or pieces of a pool, written when it moves; kept as written.
CREATE FUNCTION rental_transfers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A transfer is kept as it was written' USING ERRCODE = '23514';
  END IF;
  SELECT i.kind INTO kind FROM rental_items i WHERE i.business_id = NEW.business_id AND i.id = NEW.item_id;
  IF (kind = 'unit') <> (NEW.unit_id IS NOT NULL) OR kind = 'kit' THEN
    RAISE EXCEPTION 'A unit moves by itself; a pool by how many' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'A transfer is written when it moves' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_transfers_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_transfers
  FOR EACH ROW EXECUTE FUNCTION rental_transfers_guard();

-- --- Maintenance -------------------------------------------------------------------------------

CREATE TABLE rental_downtime (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  item_id BIGINT NOT NULL,
  unit_id BIGINT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, item_id, unit_id) REFERENCES rental_units(business_id, item_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (ends_at > starts_at),
  CHECK (ends_at <= starts_at + interval '90 days'),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX rental_downtime_unit ON rental_downtime(business_id, item_id, unit_id) WHERE cancelled_at IS NULL;

-- Downtime is cancelled, never changed otherwise or deleted.
CREATE FUNCTION rental_downtime_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Maintenance booked is cancelled, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by']) <> (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by']) OR OLD.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Maintenance booked keeps its unit and times; cancel it and book it again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_downtime_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_downtime
  FOR EACH ROW EXECUTE FUNCTION rental_downtime_guard();

CREATE TABLE rental_services (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  item_id BIGINT NOT NULL,
  unit_id BIGINT NOT NULL,
  -- The unit's meter at the service.
  meter NUMERIC(10,1) CHECK (meter >= 0),
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, item_id, unit_id) REFERENCES rental_units(business_id, item_id, id)
);
CREATE INDEX rental_services_unit ON rental_services(business_id, unit_id, id);
CREATE TRIGGER rental_services_append_only BEFORE UPDATE OR DELETE ON rental_services
  FOR EACH ROW EXECUTE FUNCTION rental_append_only();

-- --- Bookings: discount, kits, the rules as booked ----------------------------------------------------

ALTER TABLE rental_bookings
  ADD COLUMN discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  ADD COLUMN discount_reason VARCHAR(300) CHECK (btrim(discount_reason) <> ''),
  ADD COLUMN discount_by BIGINT REFERENCES users(id),
  ADD CONSTRAINT rental_bookings_discount CHECK ((discount_percent = 0) = (discount_reason IS NULL) AND (discount_reason IS NULL) = (discount_by IS NULL));

ALTER TABLE rental_booking_lines
  -- The kit line a part's line belongs to, and how many of the part are in one kit.
  ADD COLUMN kit_line_id BIGINT,
  ADD COLUMN part_quantity INTEGER CHECK (part_quantity BETWEEN 1 AND 10000),
  -- Whether the line's hire is on the bill: a kit billed as itself bills its
  -- line, one billed by its parts its parts' lines.
  ADD COLUMN billed BOOLEAN NOT NULL DEFAULT TRUE,
  -- The booking's discount on the line's hire (in its price terms).
  ADD COLUMN discount NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  ADD COLUMN late_slabs JSONB,
  ADD COLUMN late_cap NUMERIC(14,2) CHECK (late_cap > 0),
  ADD COLUMN km_allowance INTEGER CHECK (km_allowance BETWEEN 0 AND 100000),
  ADD COLUMN km_per TEXT CHECK (km_per IN ('day', 'booking')),
  ADD COLUMN extra_km_rate NUMERIC(14,2) CHECK (extra_km_rate > 0),
  ADD COLUMN fuel_per TEXT CHECK (fuel_per IN ('eighth', 'litre')),
  ADD COLUMN fuel_rate NUMERIC(14,2) CHECK (fuel_rate > 0),
  ADD COLUMN tank_litres NUMERIC(7,1) CHECK (tank_litres > 0),
  ADD CONSTRAINT rental_booking_lines_kit FOREIGN KEY (business_id, booking_id, kit_line_id) REFERENCES rental_booking_lines(business_id, booking_id, id),
  ADD CONSTRAINT rental_booking_lines_part CHECK ((kit_line_id IS NULL) = (part_quantity IS NULL) AND (kit_line_id IS NULL OR unit_id IS NULL)),
  ADD CONSTRAINT rental_booking_lines_billed CHECK ((price > 0) = billed AND (billed OR months + weeks + days + hours = 0) AND discount <= amount),
  ADD CONSTRAINT rental_booking_lines_slabs CHECK ((late_per = 'slabs') = (late_slabs IS NOT NULL) AND (late_slabs IS NULL OR rental_late_slabs_ok(late_slabs, late_rate))),
  ADD CONSTRAINT rental_booking_lines_km CHECK ((km_allowance IS NULL) = (km_per IS NULL) AND (km_per IS NULL) = (extra_km_rate IS NULL)),
  ADD CONSTRAINT rental_booking_lines_fuel CHECK ((fuel_per IS NULL) = (fuel_rate IS NULL) AND (fuel_per IS DISTINCT FROM 'litre' OR tank_litres IS NOT NULL));
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_price_check, ADD CONSTRAINT rental_booking_lines_price_check CHECK (price >= 0);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_amount_check, ADD CONSTRAINT rental_booking_lines_amount_check CHECK (amount >= 0);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_check2,
  ADD CONSTRAINT rental_booking_lines_check2 CHECK (NOT billed OR COALESCE(rate_hour, rate_day, rate_week, rate_month) IS NOT NULL);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_check3,
  ADD CONSTRAINT rental_booking_lines_check3 CHECK ((late_per = 'none' AND late_rate IS NULL) OR (late_per IN ('hour', 'day') AND late_rate IS NOT NULL) OR late_per = 'slabs');
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_check5,
  ADD CONSTRAINT rental_booking_lines_check5 CHECK (NOT billed OR months * 720 + weeks * 168 + days * 24 + hours >= charged_hours);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_check8,
  ADD CONSTRAINT rental_booking_lines_check8 CHECK (net = amount - discount OR net + tax = amount - discount);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_late_per_check,
  ADD CONSTRAINT rental_booking_lines_late_per_check CHECK (late_per IN ('none', 'hour', 'day', 'slabs'));
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_fuel_out_check,
  ADD CONSTRAINT rental_booking_lines_fuel_out_check CHECK (fuel_out IS NULL OR rental_eighths(fuel_out) IS NOT NULL);
-- A pool item is on one line of a booking, besides the parts of its kits.
DROP INDEX rental_booking_lines_one_pool;
CREATE UNIQUE INDEX rental_booking_lines_one_pool ON rental_booking_lines(business_id, booking_id, item_id) WHERE unit_id IS NULL AND kit_line_id IS NULL;
CREATE UNIQUE INDEX rental_booking_lines_one_part ON rental_booking_lines(business_id, kit_line_id, item_id) WHERE kit_line_id IS NOT NULL;

ALTER TABLE rental_return_lines
  -- Kilometres beyond the allowance (each one or part of one), and their charge.
  ADD COLUMN extra_km INTEGER NOT NULL DEFAULT 0 CHECK (extra_km >= 0),
  ADD COLUMN km_fee NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (km_fee >= 0),
  ADD COLUMN km_line_id BIGINT,
  -- Eighths of a tank short of the level it went out with, and their charge.
  ADD COLUMN fuel_short SMALLINT NOT NULL DEFAULT 0 CHECK (fuel_short BETWEEN 0 AND 8),
  ADD COLUMN fuel_fee NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (fuel_fee >= 0),
  ADD COLUMN fuel_line_id BIGINT,
  ADD CONSTRAINT rental_return_lines_km_line FOREIGN KEY (business_id, km_line_id) REFERENCES business_document_lines(business_id, id),
  ADD CONSTRAINT rental_return_lines_fuel_line FOREIGN KEY (business_id, fuel_line_id) REFERENCES business_document_lines(business_id, id),
  ADD CONSTRAINT rental_return_lines_km_line_once UNIQUE (business_id, km_line_id),
  ADD CONSTRAINT rental_return_lines_fuel_line_once UNIQUE (business_id, fuel_line_id),
  ADD CONSTRAINT rental_return_lines_fees CHECK ((km_line_id IS NULL OR km_fee > 0) AND (fuel_line_id IS NULL OR fuel_fee > 0));
ALTER TABLE rental_return_lines DROP CONSTRAINT rental_return_lines_fuel_in_check,
  ADD CONSTRAINT rental_return_lines_fuel_in_check CHECK (fuel_in IS NULL OR rental_eighths(fuel_in) IS NOT NULL);

-- --- The hirer register, conditions, photos and signatures, cancellations ------------------------------

CREATE TABLE rental_hirers (
  business_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  -- The hirer, so that an erasure at their request finds the row.
  contact_id BIGINT NOT NULL,
  address VARCHAR(300) CHECK (btrim(address) <> ''),
  -- The driving licence (its number and expiry are on the booking).
  licence_authority VARCHAR(100) CHECK (btrim(licence_authority) <> ''),
  licence_classes TEXT[] NOT NULL DEFAULT '{}' CHECK (licence_classes <@ ARRAY['MC50CC', 'MCWOG', 'MCWG', 'LMV-NT', 'LMV', 'TRANS']),
  licence_issued_on DATE,
  -- A foreigner (Forms 6 and 4): passport, date of birth, driving permit, visa.
  foreigner BOOLEAN NOT NULL DEFAULT FALSE,
  passport_no VARCHAR(20) CHECK (passport_no ~ '^[A-Z0-9]{5,20}$'),
  passport_authority VARCHAR(100) CHECK (btrim(passport_authority) <> ''),
  passport_nation VARCHAR(60) CHECK (btrim(passport_nation) <> ''),
  passport_issued_on DATE,
  passport_valid_until DATE,
  birth_date DATE,
  permit_no VARCHAR(30) CHECK (permit_no ~ '^[A-Z0-9/-]{3,30}$'),
  permit_issued_on DATE,
  permit_classes TEXT[] NOT NULL DEFAULT '{}' CHECK (permit_classes <@ ARRAY['MC50CC', 'MCWOG', 'MCWG', 'LMV-NT', 'LMV', 'TRANS']),
  visa_no VARCHAR(30) CHECK (visa_no ~ '^[A-Z0-9/-]{3,30}$'),
  visa_valid_until DATE,
  -- The original document held until the return (its name, never a copy), and when it went back.
  original_held VARCHAR(100) CHECK (btrim(original_held) <> ''),
  original_returned_at TIMESTAMPTZ,
  original_returned_by BIGINT REFERENCES users(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, booking_id),
  FOREIGN KEY (business_id, booking_id) REFERENCES rental_bookings(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CHECK (NOT foreigner OR (passport_no IS NOT NULL AND passport_authority IS NOT NULL AND passport_nation IS NOT NULL AND passport_issued_on IS NOT NULL
    AND passport_valid_until IS NOT NULL AND birth_date IS NOT NULL)),
  CHECK (foreigner OR (passport_no IS NULL AND permit_no IS NULL AND visa_no IS NULL)),
  CHECK ((permit_no IS NULL) = (permit_issued_on IS NULL)),
  CHECK ((original_returned_at IS NULL) = (original_returned_by IS NULL)),
  CHECK (original_returned_at IS NULL OR original_held IS NOT NULL)
);
CREATE INDEX rental_hirers_contact ON rental_hirers(business_id, contact_id);

-- The register is written with the handover, in the hirer's name; a licence
-- covers the class of each self-drive vehicle handed over on it. It keeps
-- what was written; the original document goes back once. A customer's data
-- erased at their request blanks their details here and nothing else.
CREATE FUNCTION rental_hirers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking RECORD; unit RECORD;
  personal TEXT[] := ARRAY['address', 'licence_authority', 'licence_classes', 'licence_issued_on', 'foreigner', 'passport_no', 'passport_authority', 'passport_nation',
    'passport_issued_on', 'passport_valid_until', 'birth_date', 'permit_no', 'permit_issued_on', 'permit_classes', 'visa_no', 'visa_valid_until'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The hirer register is kept as it was written' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - personal) = (to_jsonb(OLD) - personal)
       AND EXISTS (SELECT 1 FROM business_contacts c WHERE c.business_id = NEW.business_id AND c.id = NEW.contact_id AND c.erased_at IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['original_returned_at', 'original_returned_by']) <> (to_jsonb(OLD) - ARRAY['original_returned_at', 'original_returned_by'])
       OR OLD.original_returned_at IS NOT NULL THEN
      RAISE EXCEPTION 'The hirer register is kept as it was written; the original document goes back once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT booking_no, status, contact_id, checked_out_at INTO booking FROM rental_bookings WHERE business_id = NEW.business_id AND id = NEW.booking_id;
  IF booking.status <> 'out' OR booking.checked_out_at <> now() OR NEW.contact_id <> booking.contact_id OR NEW.created_at <> now() THEN
    RAISE EXCEPTION 'Booking %: the hirer register is written with the handover, in the hirer''s name', booking.booking_no USING ERRCODE = '23514';
  END IF;
  SELECT u.label, u.vehicle_class INTO unit FROM rental_booking_lines l JOIN rental_items i ON i.business_id = l.business_id AND i.id = l.item_id
    JOIN rental_units u ON u.business_id = l.business_id AND u.id = l.unit_id
  WHERE l.business_id = NEW.business_id AND l.booking_id = NEW.booking_id AND i.vehicle IS NOT NULL AND NOT i.with_driver AND u.vehicle_class IS NOT NULL
    AND NOT (u.vehicle_class = ANY(NEW.licence_classes || NEW.permit_classes))
  ORDER BY l.seq LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% is a % vehicle: the hirer''s licence does not cover it, and it is not handed over on it', unit.label, unit.vehicle_class USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_hirers_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_hirers
  FOR EACH ROW EXECUTE FUNCTION rental_hirers_guard();

CREATE TABLE rental_conditions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  -- At the handover (out) or a return (in).
  stage TEXT NOT NULL CHECK (stage IN ('out', 'in')),
  return_id BIGINT,
  -- Each point checked: [{ point, ok, note }].
  checks JSONB NOT NULL CHECK (jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) BETWEEN 1 AND 30),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, booking_id, line_id) REFERENCES rental_booking_lines(business_id, booking_id, id),
  FOREIGN KEY (business_id, booking_id, return_id) REFERENCES rental_returns(business_id, booking_id, id),
  CHECK ((stage = 'in') = (return_id IS NOT NULL))
);
CREATE UNIQUE INDEX rental_conditions_out ON rental_conditions(business_id, line_id) WHERE stage = 'out';
CREATE UNIQUE INDEX rental_conditions_in ON rental_conditions(business_id, return_id, line_id) WHERE stage = 'in';
CREATE TRIGGER rental_conditions_append_only BEFORE UPDATE OR DELETE ON rental_conditions
  FOR EACH ROW EXECUTE FUNCTION rental_append_only();

CREATE TABLE rental_files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  -- The hirer, for the access export.
  contact_id BIGINT NOT NULL,
  line_id BIGINT,
  stage TEXT NOT NULL CHECK (stage IN ('out', 'in')),
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'signature')),
  -- Whose signature: the hirer's or the shop's.
  signer TEXT CHECK (signer IN ('hirer', 'shop')),
  stored_name VARCHAR(80) NOT NULL CHECK (stored_name ~ '^[a-f0-9]{32}\.(jpg|png|webp)$'),
  file_name VARCHAR(150) NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, booking_id) REFERENCES rental_bookings(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, booking_id, line_id) REFERENCES rental_booking_lines(business_id, booking_id, id),
  UNIQUE (business_id, stored_name),
  CHECK ((kind = 'signature') = (signer IS NOT NULL)),
  CHECK (kind = 'photo' OR line_id IS NULL)
);
CREATE INDEX rental_files_booking ON rental_files(business_id, booking_id, id);

-- A photo or signature is kept as it was taken, of its booking and hirer:
-- at the handover while the booking is reserved or out, at a return while it is out or back.
CREATE FUNCTION rental_files_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A photo or signature of a handover or return is kept as it was taken' USING ERRCODE = '23514';
  END IF;
  SELECT booking_no, status, contact_id INTO booking FROM rental_bookings WHERE business_id = NEW.business_id AND id = NEW.booking_id;
  IF NEW.contact_id <> booking.contact_id THEN
    RAISE EXCEPTION 'A photo or signature of booking % is in its hirer''s name', booking.booking_no USING ERRCODE = '23514';
  END IF;
  IF (NEW.stage = 'out' AND booking.status NOT IN ('reserved', 'out')) OR (NEW.stage = 'in' AND booking.status NOT IN ('out', 'returned')) THEN
    RAISE EXCEPTION 'Booking % is %: photos and signatures go with its handover and its returns', booking.booking_no, booking.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_files_guard BEFORE INSERT OR UPDATE OR DELETE ON rental_files
  FOR EACH ROW EXECUTE FUNCTION rental_files_guard();

CREATE TABLE rental_cancellations (
  business_id BIGINT NOT NULL,
  booking_id BIGINT NOT NULL,
  -- Hours from the cancellation to the out time (less than nothing: after it, a no-show).
  hours_before NUMERIC(10,2) NOT NULL,
  percent NUMERIC(5,2) NOT NULL CHECK (percent BETWEEN 0 AND 100),
  -- The charge worked out (in the booking's price terms), and what was charged.
  worked_out NUMERIC(16,2) NOT NULL CHECK (worked_out >= 0),
  charged NUMERIC(16,2) NOT NULL CHECK (charged >= 0),
  -- A manager who waived it, and why.
  waived_by BIGINT REFERENCES users(id),
  waiver VARCHAR(300) CHECK (btrim(waiver) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, booking_id),
  FOREIGN KEY (business_id, booking_id) REFERENCES rental_bookings(business_id, id),
  CHECK ((waived_by IS NULL) = (waiver IS NULL)),
  CHECK (charged = worked_out OR (charged = 0 AND waiver IS NOT NULL))
);
CREATE TRIGGER rental_cancellations_append_only BEFORE UPDATE OR DELETE ON rental_cancellations
  FOR EACH ROW EXECUTE FUNCTION rental_append_only();

-- History, returns, receipts and these: kept as written.
CREATE OR REPLACE FUNCTION rental_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rental_booking_events' THEN
    RAISE EXCEPTION 'A booking''s history is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'rental_receipts' THEN
    RAISE EXCEPTION 'An advance or deposit taken for a booking stays with it' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'rental_services' THEN
    RAISE EXCEPTION 'A service done is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'rental_conditions' THEN
    RAISE EXCEPTION 'A checklist is kept as it was checked' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'rental_cancellations' THEN
    RAISE EXCEPTION 'A cancellation charge is kept as it was worked out' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A return is kept as it was taken' USING ERRCODE = '23514';
END $$;

-- --- The guards of items, units and lines, again --------------------------------------------------

-- An item is billed as a service item of this business counted in services
-- (not goods, not a kit of the catalogue), keeps its item, its kind and
-- whether it is a vehicle, is never deleted, and keeps its pool's total as
-- its locations count it.
CREATE OR REPLACE FUNCTION rental_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sku RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A rental item is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sku_id <> OLD.sku_id OR NEW.kind <> OLD.kind OR NEW.vehicle IS DISTINCT FROM OLD.vehicle OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A rental item keeps the item it is billed as, how it is hired out and whether it is a vehicle' USING ERRCODE = '23514';
    END IF;
    IF NEW.pool_quantity IS DISTINCT FROM OLD.pool_quantity
       AND NEW.pool_quantity IS DISTINCT FROM (SELECT COALESCE(sum(quantity), 0)::int FROM rental_pool_counts WHERE business_id = NEW.business_id AND item_id = NEW.id) THEN
      RAISE EXCEPTION 'A pool is counted at each location: change a location''s count instead' USING ERRCODE = '23514';
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

-- A unit is of an item hired one by one (a vehicle's with its registration),
-- keeps its item, its meter never goes back, it moves to another location
-- only by a transfer, and it is never deleted.
CREATE OR REPLACE FUNCTION rental_units_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.location_id <> OLD.location_id AND NOT EXISTS (SELECT 1 FROM rental_transfers t WHERE t.business_id = NEW.business_id AND t.unit_id = NEW.id
       AND t.from_location_id = OLD.location_id AND t.to_location_id = NEW.location_id AND t.created_at = now()) THEN
      RAISE EXCEPTION '% moves to another location by a transfer' , OLD.label USING ERRCODE = '23514';
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

-- A line goes on a quote or a reserved booking, of its item's hire service:
-- a unit of the item (not retired) for an item hired one by one, how many
-- from the pool otherwise, how many kits for a kit; a part's line belongs to
-- its kit's line, as many as the kit has of it; a kit billed as itself bills
-- its line, one billed by its parts its parts' lines; with nothing handed over
-- or billed. It keeps its item, unit and kit; how many changes until it is
-- handed over (a kit's lines with the kit's), and its price until it is back
-- (an extension is priced again). What was noted at the handover is written
-- once, with the handover, and the bill line once, with the bill. It is taken
-- off only before the handover.
CREATE OR REPLACE FUNCTION rental_booking_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking RECORD; item RECORD; unit RECORD; kit RECORD; part INTEGER;
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
    SELECT kind, sku_id, active, kit_billing INTO item FROM rental_items WHERE business_id = NEW.business_id AND id = NEW.item_id;
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
    IF NEW.kit_line_id IS NOT NULL THEN
      SELECT l.quantity, l.kit_line_id, i.kind, i.kit_billing, i.id AS kit_id INTO kit FROM rental_booking_lines l JOIN rental_items i ON i.business_id = l.business_id AND i.id = l.item_id
      WHERE l.business_id = NEW.business_id AND l.id = NEW.kit_line_id;
      SELECT quantity INTO part FROM rental_kit_parts WHERE business_id = NEW.business_id AND kit_id = kit.kit_id AND part_id = NEW.item_id;
      IF kit.kind IS DISTINCT FROM 'kit' OR part IS NULL OR NEW.part_quantity <> part OR NEW.quantity <> kit.quantity * part THEN
        RAISE EXCEPTION 'A kit''s part goes on the booking with its kit, as many as the kit has of it' USING ERRCODE = '23514';
      END IF;
      IF NEW.billed <> (kit.kit_billing = 'parts') THEN
        RAISE EXCEPTION 'A kit billed as itself bills its own line; one billed by its parts, its parts'' lines' USING ERRCODE = '23514';
      END IF;
    ELSIF item.kind = 'kit' THEN
      IF NEW.billed <> (item.kit_billing = 'kit') THEN
        RAISE EXCEPTION 'A kit billed as itself bills its own line; one billed by its parts, its parts'' lines' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT NEW.billed THEN
      RAISE EXCEPTION 'A line''s hire is billed' USING ERRCODE = '23514';
    END IF;
    IF NEW.out_note IS NOT NULL OR NEW.meter_out IS NOT NULL OR NEW.fuel_out IS NOT NULL OR NEW.line_id IS NOT NULL THEN
      RAISE EXCEPTION 'A line starts with nothing handed over or billed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.booking_id <> OLD.booking_id OR NEW.seq <> OLD.seq OR NEW.item_id <> OLD.item_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.sku_id <> OLD.sku_id
     OR NEW.item_name <> OLD.item_name OR NEW.unit_label IS DISTINCT FROM OLD.unit_label OR NEW.serial_no IS DISTINCT FROM OLD.serial_no
     OR NEW.kit_line_id IS DISTINCT FROM OLD.kit_line_id OR NEW.part_quantity IS DISTINCT FROM OLD.part_quantity OR NEW.billed <> OLD.billed THEN
    RAISE EXCEPTION 'A line of booking % keeps its item and unit', booking.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.quantity <> OLD.quantity AND booking.status NOT IN ('quote', 'reserved') THEN
    RAISE EXCEPTION 'Booking % is handed over: how many went out stays', booking.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.quantity <> OLD.quantity AND (NEW.kit_line_id IS NOT NULL OR EXISTS (SELECT 1 FROM rental_booking_lines WHERE business_id = NEW.business_id AND kit_line_id = NEW.id)) THEN
    RAISE EXCEPTION 'Booking %: a kit and its parts change together; change the booking''s lines', booking.booking_no USING ERRCODE = '23514';
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
    IF OLD.line_id IS NOT NULL OR NOT NEW.billed OR NOT EXISTS (SELECT 1 FROM business_document_lines dl JOIN business_documents d ON d.business_id = dl.business_id AND d.id = dl.document_id
         WHERE dl.business_id = NEW.business_id AND dl.id = NEW.line_id AND dl.sku_id = NEW.sku_id AND d.kind = 'sale' AND d.contact_id = booking.contact_id) THEN
      RAISE EXCEPTION 'A line of booking % is billed once, on a line of its own item on a bill to its hirer', booking.booking_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A bill line charges a fee of a booking's line: a line of its item's hire service, on a sale to the hirer.
CREATE FUNCTION rental_fee_line_ok(target_business BIGINT, booking_line BIGINT, bill_line BIGINT) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM business_document_lines dl JOIN business_documents d ON d.business_id = dl.business_id AND d.id = dl.document_id
    JOIN rental_booking_lines l ON l.business_id = dl.business_id AND l.sku_id = dl.sku_id JOIN rental_bookings b ON b.business_id = l.business_id AND b.id = l.booking_id
    WHERE dl.business_id = target_business AND dl.id = bill_line AND l.id = booking_line AND d.kind = 'sale' AND d.contact_id = b.contact_id);
$$;

-- What comes back is of the booking's lines still out (a kit by its parts): a
-- unit whole, a pool no more than is out. Its meter does not read less than at
-- the handover. Its lateness is from the line's due time to now, and its late
-- fee is worked out by the line's rule as booked, for each one back; a vehicle
-- back pays for the kilometres beyond its booked allowance and for the fuel
-- short of the level it went out with, at the booked rates. A return line is
-- kept as it was taken; each fee's bill line is given once, a line of its
-- item's hire service on a bill to the hirer.
CREATE OR REPLACE FUNCTION rental_return_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; back INTEGER; minutes INTEGER; late RECORD; allowance NUMERIC; extra INTEGER := 0; km NUMERIC := 0; short INTEGER := 0; fuel NUMERIC := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A return is kept as it was taken' USING ERRCODE = '23514';
  END IF;
  IF NEW.late_line_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.late_line_id IS NULL) AND NOT rental_fee_line_ok(NEW.business_id, NEW.line_id, NEW.late_line_id) THEN
    RAISE EXCEPTION 'A late fee is billed on a line of its item''s hire service, on a bill to the hirer' USING ERRCODE = '23514';
  END IF;
  IF NEW.km_line_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.km_line_id IS NULL) AND NOT rental_fee_line_ok(NEW.business_id, NEW.line_id, NEW.km_line_id) THEN
    RAISE EXCEPTION 'An extra-kilometre charge is billed on a line of its item''s hire service, on a bill to the hirer' USING ERRCODE = '23514';
  END IF;
  IF NEW.fuel_line_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.fuel_line_id IS NULL) AND NOT rental_fee_line_ok(NEW.business_id, NEW.line_id, NEW.fuel_line_id) THEN
    RAISE EXCEPTION 'A fuel charge is billed on a line of its item''s hire service, on a bill to the hirer' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['late_line_id', 'km_line_id', 'fuel_line_id']) <> (to_jsonb(OLD) - ARRAY['late_line_id', 'km_line_id', 'fuel_line_id'])
       OR (NEW.late_line_id IS DISTINCT FROM OLD.late_line_id AND (OLD.late_line_id IS NOT NULL OR NEW.late_fee = 0))
       OR (NEW.km_line_id IS DISTINCT FROM OLD.km_line_id AND (OLD.km_line_id IS NOT NULL OR NEW.km_fee = 0))
       OR (NEW.fuel_line_id IS DISTINCT FROM OLD.fuel_line_id AND (OLD.fuel_line_id IS NOT NULL OR NEW.fuel_fee = 0)) THEN
      RAISE EXCEPTION 'A return is kept as it was taken' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT l.*, b.due_at, b.booking_no, i.kind AS item_kind INTO line FROM rental_booking_lines l JOIN rental_bookings b ON b.business_id = l.business_id AND b.id = l.booking_id
    JOIN rental_items i ON i.business_id = l.business_id AND i.id = l.item_id
  WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id;
  IF line.item_kind = 'kit' THEN
    RAISE EXCEPTION '% is a kit: its parts come back, each on its own line', line.item_name USING ERRCODE = '23514';
  END IF;
  back := COALESCE((SELECT sum(quantity + missing) FROM rental_return_lines WHERE business_id = NEW.business_id AND line_id = NEW.line_id), 0);
  IF back + NEW.quantity + NEW.missing > line.quantity THEN
    RAISE EXCEPTION '% of % % went out on booking %: % more come back at most', line.quantity, line.item_name, COALESCE(line.unit_label, ''), line.booking_no,
      line.quantity - back USING ERRCODE = '23514';
  END IF;
  IF NEW.meter_in IS NOT NULL AND line.meter_out IS NOT NULL AND NEW.meter_in < line.meter_out THEN
    RAISE EXCEPTION '% went out reading %: it cannot come back reading less', COALESCE(line.unit_label, line.item_name), line.meter_out USING ERRCODE = '23514';
  END IF;
  minutes := GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - line.due_at)) / 60))::int;
  SELECT * INTO late FROM rental_late_fee(line.late_per, line.late_rate, line.grace_minutes, line.late_slabs, line.late_cap, minutes, NEW.quantity);
  IF NEW.late_minutes <> minutes OR NEW.late_units <> late.units OR NEW.late_fee <> late.fee THEN
    RAISE EXCEPTION 'The late fee of % on booking % is worked out from its due time and its booked late rate', line.item_name, line.booking_no USING ERRCODE = '23514';
  END IF;
  IF line.km_per IS NOT NULL AND NEW.quantity > 0 AND NEW.meter_in IS NOT NULL AND line.meter_out IS NOT NULL THEN
    allowance := line.km_allowance * CASE WHEN line.km_per = 'day' THEN GREATEST(1, ceil(line.charged_hours / 24.0)) ELSE 1 END;
    extra := GREATEST(0, ceil(NEW.meter_in - line.meter_out - allowance))::int;
    km := extra * line.extra_km_rate;
  END IF;
  IF NEW.extra_km <> extra OR NEW.km_fee <> km THEN
    RAISE EXCEPTION 'The extra kilometres of % on booking % are worked out from its meter readings and its booked allowance', COALESCE(line.unit_label, line.item_name),
      line.booking_no USING ERRCODE = '23514';
  END IF;
  IF line.fuel_per IS NOT NULL AND NEW.quantity > 0 AND NEW.fuel_in IS NOT NULL AND line.fuel_out IS NOT NULL THEN
    short := GREATEST(0, rental_eighths(line.fuel_out) - rental_eighths(NEW.fuel_in));
    fuel := CASE line.fuel_per WHEN 'eighth' THEN short * line.fuel_rate ELSE round(short * line.tank_litres * line.fuel_rate / 8, 2) END;
  END IF;
  IF NEW.fuel_short <> short OR NEW.fuel_fee <> fuel THEN
    RAISE EXCEPTION 'The fuel charge of % on booking % is worked out from the levels noted and its booked rate', COALESCE(line.unit_label, line.item_name),
      line.booking_no USING ERRCODE = '23514';
  END IF;
  IF NEW.maintenance AND line.unit_id IS NULL THEN
    RAISE EXCEPTION 'A unit goes for maintenance; a pool keeps how many it has' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- What is free: downtime holds a unit; pools by location --------------------------------------------

-- What holds a rental item's units or pool, as stretches of time:
--   booked    a reserved booking: from its out time to its due time and the turnaround time;
--   back      what came back of a booking handed over: until it came back and the turnaround time;
--   out       what is still out: until it is due (or now, while it is late) and the turnaround time;
--   downtime  maintenance booked for a unit (no booking: its reason in the hirer's place).
-- What was reported missing holds nothing once reported (the pool is that much smaller).
CREATE OR REPLACE FUNCTION rental_holds(target_business BIGINT, target_item BIGINT)
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
  WHERE b.business_id = target_business AND l.item_id = target_item AND b.status = 'out' AND l.quantity > x.back
  UNION ALL
  SELECT NULL::bigint, NULL::varchar, d.reason, 'downtime', NULL::bigint, d.unit_id, 'downtime', 1, d.starts_at, d.ends_at, d.ends_at
  FROM rental_downtime d WHERE d.business_id = target_business AND d.item_id = target_item AND d.cancelled_at IS NULL;
$$;

-- The first hold on a unit that overlaps the time asked (its end already
-- with the asking line's turnaround time), leaving out a booking or a line's
-- own booked and still-out time.
CREATE OR REPLACE FUNCTION rental_unit_clash(target_business BIGINT, target_item BIGINT, target_unit BIGINT, from_at TIMESTAMPTZ, until_at TIMESTAMPTZ,
  except_booking BIGINT, except_line BIGINT)
RETURNS TABLE (booking_id BIGINT, booking_no VARCHAR, customer_name VARCHAR, status TEXT, part TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, due_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT h.booking_id, h.booking_no, h.customer_name, h.status, h.part, h.starts_at, h.ends_at, h.due_at FROM rental_holds(target_business, target_item) h
  WHERE h.unit_id = target_unit AND h.starts_at < until_at AND h.ends_at > from_at
    AND (except_booking IS NULL OR h.booking_id IS DISTINCT FROM except_booking) AND (except_line IS NULL OR h.line_id IS DISTINCT FROM except_line OR h.part = 'back')
  ORDER BY h.starts_at, h.booking_id LIMIT 1;
$$;

-- The most of a pool held at once at a location over the time asked, by the
-- holds of that location's bookings left after leaving out a booking or a
-- line's own booked and still-out time.
CREATE FUNCTION rental_location_peak(target_business BIGINT, target_item BIGINT, target_location BIGINT, from_at TIMESTAMPTZ, until_at TIMESTAMPTZ,
  except_booking BIGINT, except_line BIGINT)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  WITH h AS (SELECT x.* FROM rental_holds(target_business, target_item) x JOIN rental_bookings b ON b.business_id = target_business AND b.id = x.booking_id
    WHERE b.location_id = target_location AND x.starts_at < until_at AND x.ends_at > from_at
      AND (except_booking IS NULL OR x.booking_id <> except_booking) AND (except_line IS NULL OR x.line_id <> except_line OR x.part = 'back')),
  points AS (SELECT from_at AS moment UNION SELECT GREATEST(h.starts_at, from_at) FROM h)
  SELECT COALESCE(max(used), 0)::int FROM (SELECT p.moment, sum(h.quantity) AS used FROM points p JOIN h ON h.starts_at <= p.moment AND h.ends_at > p.moment GROUP BY p.moment) u;
$$;

-- A booking line that holds something (its booking reserved or out) clashes
-- with nothing: its unit is kept where it is booked and held by no other
-- booking or downtime over its time, and its pool is never held at its
-- location more than the location has. A kit holds nothing itself: its parts
-- do. One item at a time: the item's row is the lock, so two bookings saved
-- together are checked one after the other.
CREATE OR REPLACE FUNCTION rental_check_line(target_business BIGINT, target_line BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE l RECORD; b RECORD; zone TEXT; held INTEGER; held_from TIMESTAMPTZ; held_until TIMESTAMPTZ; clash RECORD; kind TEXT; pool INTEGER; peak INTEGER; unit RECORD;
  place TEXT;
BEGIN
  SELECT * INTO l FROM rental_booking_lines WHERE business_id = target_business AND id = target_line;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO b FROM rental_bookings WHERE business_id = target_business AND id = l.booking_id;
  IF b.status NOT IN ('reserved', 'out') THEN RETURN; END IF;
  SELECT i.kind INTO kind FROM rental_items i WHERE i.business_id = target_business AND i.id = l.item_id FOR UPDATE;
  IF kind = 'kit' THEN RETURN; END IF;
  held := l.quantity - COALESCE((SELECT sum(rl.quantity + rl.missing) FROM rental_return_lines rl WHERE rl.business_id = target_business AND rl.line_id = l.id), 0);
  IF held <= 0 THEN RETURN; END IF;
  held_from := b.out_at;
  held_until := (CASE WHEN b.status = 'out' THEN GREATEST(b.due_at, now()) ELSE b.due_at END) + make_interval(mins => l.buffer_minutes);
  SELECT timezone INTO zone FROM businesses WHERE id = target_business;
  IF l.unit_id IS NOT NULL THEN
    SELECT u.label, u.location_id, x.name AS location_name INTO unit FROM rental_units u JOIN business_locations x ON x.business_id = u.business_id AND x.id = u.location_id
    WHERE u.business_id = target_business AND u.id = l.unit_id;
    IF unit.location_id <> b.location_id THEN
      RAISE EXCEPTION '% (%) is kept at %: book it there, or move it here first', l.unit_label, l.item_name, unit.location_name USING ERRCODE = '23514';
    END IF;
    SELECT * INTO clash FROM rental_unit_clash(target_business, l.item_id, l.unit_id, held_from, held_until, NULL, l.id);
    IF FOUND THEN
      IF clash.part = 'downtime' THEN
        RAISE EXCEPTION '% (%) is booked for maintenance (%) from % to %: it is not free from % to %', l.unit_label, l.item_name, clash.customer_name,
          rental_time_words(clash.starts_at, zone), rental_time_words(clash.ends_at, zone), rental_time_words(held_from, zone), rental_time_words(b.due_at, zone)
          USING ERRCODE = '23514';
      END IF;
      IF clash.part = 'out' THEN
        RAISE EXCEPTION '% (%) is out on % with %, due back %: it is not free from % to %', l.unit_label, l.item_name, clash.booking_no, clash.customer_name,
          rental_time_words(clash.due_at, zone), rental_time_words(held_from, zone), rental_time_words(b.due_at, zone) USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION '% (%) is booked on % for % from % until it is free again at %: it is not free from % to %', l.unit_label, l.item_name, clash.booking_no,
        clash.customer_name, rental_time_words(clash.starts_at, zone), rental_time_words(clash.ends_at, zone), rental_time_words(held_from, zone),
        rental_time_words(b.due_at, zone) USING ERRCODE = '23514';
    END IF;
  ELSE
    pool := COALESCE((SELECT quantity FROM rental_pool_counts WHERE business_id = target_business AND item_id = l.item_id AND location_id = b.location_id), 0);
    peak := rental_location_peak(target_business, l.item_id, b.location_id, held_from, held_until, NULL, l.id);
    IF peak + held > pool THEN
      place := CASE WHEN (SELECT count(*) FROM business_locations WHERE business_id = target_business AND active) > 1
        THEN ' at ' || (SELECT name FROM business_locations WHERE business_id = target_business AND id = b.location_id) ELSE '' END;
      RAISE EXCEPTION 'Only % of the % % are free from % to %: % are booked then', GREATEST(pool - peak, 0), pool, l.item_name, rental_time_words(held_from, zone),
        rental_time_words(b.due_at, zone) || place, peak USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

-- Downtime is booked over free time only: no booking holds the unit then, and
-- no other downtime. The item's row is the lock, as for a booking.
CREATE FUNCTION rental_downtime_free() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE clash RECORD; zone TEXT; label TEXT;
BEGIN
  IF NEW.cancelled_at IS NOT NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM rental_items WHERE business_id = NEW.business_id AND id = NEW.item_id FOR UPDATE;
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  SELECT u.label INTO label FROM rental_units u WHERE u.business_id = NEW.business_id AND u.id = NEW.unit_id;
  SELECT * INTO clash FROM rental_holds(NEW.business_id, NEW.item_id) h WHERE h.unit_id = NEW.unit_id AND h.part <> 'downtime' AND h.starts_at < NEW.ends_at
    AND h.ends_at > NEW.starts_at ORDER BY h.starts_at LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% is % on % (%) from % to %: maintenance is booked when it is free', label, CASE clash.part WHEN 'out' THEN 'out' ELSE 'booked' END,
      clash.booking_no, clash.customer_name, rental_time_words(clash.starts_at, zone), rental_time_words(clash.ends_at, zone) USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM rental_downtime d WHERE d.business_id = NEW.business_id AND d.unit_id = NEW.unit_id AND d.id <> NEW.id AND d.cancelled_at IS NULL
     AND d.starts_at < NEW.ends_at AND d.ends_at > NEW.starts_at) THEN
    RAISE EXCEPTION 'Maintenance of % is already booked over part of that time', label USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rental_downtime_free AFTER INSERT ON rental_downtime
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rental_downtime_free();

-- Down Migration
DROP TRIGGER rental_downtime_free ON rental_downtime;
DROP FUNCTION rental_downtime_free();

-- What is free, as it was.
CREATE OR REPLACE FUNCTION rental_check_line(target_business BIGINT, target_line BIGINT) RETURNS void LANGUAGE plpgsql AS $$
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
DROP FUNCTION rental_location_peak(BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT, BIGINT);
CREATE OR REPLACE FUNCTION rental_unit_clash(target_business BIGINT, target_item BIGINT, target_unit BIGINT, from_at TIMESTAMPTZ, until_at TIMESTAMPTZ,
  except_booking BIGINT, except_line BIGINT)
RETURNS TABLE (booking_id BIGINT, booking_no VARCHAR, customer_name VARCHAR, status TEXT, part TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, due_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT h.booking_id, h.booking_no, h.customer_name, h.status, h.part, h.starts_at, h.ends_at, h.due_at FROM rental_holds(target_business, target_item) h
  WHERE h.unit_id = target_unit AND h.starts_at < until_at AND h.ends_at > from_at
    AND (except_booking IS NULL OR h.booking_id <> except_booking) AND (except_line IS NULL OR h.line_id <> except_line OR h.part = 'back')
  ORDER BY h.starts_at, h.booking_id LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION rental_holds(target_business BIGINT, target_item BIGINT)
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

-- The guards as they were.
CREATE OR REPLACE FUNCTION rental_return_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP FUNCTION rental_fee_line_ok(BIGINT, BIGINT, BIGINT);
CREATE OR REPLACE FUNCTION rental_booking_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION rental_units_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION rental_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION rental_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rental_booking_events' THEN
    RAISE EXCEPTION 'A booking''s history is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'rental_receipts' THEN
    RAISE EXCEPTION 'An advance or deposit taken for a booking stays with it' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A return is kept as it was taken' USING ERRCODE = '23514';
END $$;

-- The new tables.
DROP TABLE rental_cancellations, rental_files, rental_conditions, rental_hirers, rental_services, rental_downtime, rental_transfers;
DROP FUNCTION rental_files_guard();
DROP FUNCTION rental_hirers_guard();
DROP FUNCTION rental_downtime_guard();
DROP FUNCTION rental_transfers_guard();

-- Returns and lines as they were (refuses while a kit, a slab or an eighth of a tank is kept: restore a backup instead).
ALTER TABLE rental_return_lines DROP CONSTRAINT rental_return_lines_fuel_in_check,
  ADD CONSTRAINT rental_return_lines_fuel_in_check CHECK (fuel_in IN ('empty', 'quarter', 'half', 'three_quarters', 'full'));
ALTER TABLE rental_return_lines DROP COLUMN extra_km, DROP COLUMN km_fee, DROP COLUMN km_line_id, DROP COLUMN fuel_short, DROP COLUMN fuel_fee, DROP COLUMN fuel_line_id;
DROP INDEX rental_booking_lines_one_part;
DROP INDEX rental_booking_lines_one_pool;
CREATE UNIQUE INDEX rental_booking_lines_one_pool ON rental_booking_lines(business_id, booking_id, item_id) WHERE unit_id IS NULL;
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_fuel_out_check,
  ADD CONSTRAINT rental_booking_lines_fuel_out_check CHECK (fuel_out IN ('empty', 'quarter', 'half', 'three_quarters', 'full'));
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_late_per_check,
  ADD CONSTRAINT rental_booking_lines_late_per_check CHECK (late_per IN ('none', 'hour', 'day'));
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_check8, ADD CONSTRAINT rental_booking_lines_check8 CHECK (net = amount OR net + tax = amount);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_check5, ADD CONSTRAINT rental_booking_lines_check5 CHECK (months * 720 + weeks * 168 + days * 24 + hours >= charged_hours);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_check3, ADD CONSTRAINT rental_booking_lines_check3 CHECK ((late_per = 'none') = (late_rate IS NULL));
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_check2, ADD CONSTRAINT rental_booking_lines_check2 CHECK (COALESCE(rate_hour, rate_day, rate_week, rate_month) IS NOT NULL);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_amount_check, ADD CONSTRAINT rental_booking_lines_amount_check CHECK (amount > 0);
ALTER TABLE rental_booking_lines DROP CONSTRAINT rental_booking_lines_price_check, ADD CONSTRAINT rental_booking_lines_price_check CHECK (price > 0);
ALTER TABLE rental_booking_lines DROP COLUMN kit_line_id, DROP COLUMN part_quantity, DROP COLUMN billed, DROP COLUMN discount, DROP COLUMN late_slabs, DROP COLUMN late_cap,
  DROP COLUMN km_allowance, DROP COLUMN km_per, DROP COLUMN extra_km_rate, DROP COLUMN fuel_per, DROP COLUMN fuel_rate, DROP COLUMN tank_litres;
ALTER TABLE rental_bookings DROP COLUMN discount_percent, DROP COLUMN discount_reason, DROP COLUMN discount_by;

-- Units, pools and items as they were.
DROP TRIGGER rental_units_home ON rental_units;
DROP FUNCTION rental_units_home();
ALTER TABLE rental_units DROP COLUMN location_id, DROP COLUMN vehicle_class, DROP COLUMN engine_cc, DROP COLUMN length_mm, DROP COLUMN fuel_type, DROP COLUMN rc_valid_until,
  DROP COLUMN permit_valid_until, DROP COLUMN insurance_valid_until, DROP COLUMN puc_valid_until, DROP COLUMN fitness_valid_until, DROP COLUMN service_per,
  DROP COLUMN service_every, DROP COLUMN serviced_at, DROP COLUMN serviced_meter;
DROP TRIGGER rental_items_pool_start ON rental_items;
DROP FUNCTION rental_items_pool_start();
DROP TABLE rental_pool_counts;
DROP FUNCTION rental_pool_counts_total();
DROP FUNCTION rental_pool_counts_guard();
DROP TABLE rental_kit_parts;
DROP FUNCTION rental_kit_parts_guard();
ALTER TABLE rental_items DROP CONSTRAINT rental_items_check6,
  ADD CONSTRAINT rental_items_check6 CHECK (late_per = 'none' OR late_rate IS NOT NULL OR (late_per = 'hour' AND rate_hour IS NOT NULL) OR (late_per = 'day' AND rate_day IS NOT NULL));
ALTER TABLE rental_items DROP CONSTRAINT rental_items_check, ADD CONSTRAINT rental_items_check CHECK (COALESCE(rate_hour, rate_day, rate_week, rate_month) IS NOT NULL);
ALTER TABLE rental_items DROP CONSTRAINT rental_items_kit, DROP CONSTRAINT rental_items_slabs, DROP CONSTRAINT rental_items_km, DROP CONSTRAINT rental_items_fuel,
  DROP CONSTRAINT rental_items_class;
ALTER TABLE rental_items DROP COLUMN kit_billing, DROP COLUMN class_id, DROP COLUMN late_slabs, DROP COLUMN late_cap, DROP COLUMN km_allowance, DROP COLUMN km_per,
  DROP COLUMN extra_km_rate, DROP COLUMN fuel_per, DROP COLUMN fuel_rate, DROP COLUMN tank_litres;
ALTER TABLE rental_items DROP CONSTRAINT rental_items_late_per_check, ADD CONSTRAINT rental_items_late_per_check CHECK (late_per IN ('none', 'hour', 'day'));
ALTER TABLE rental_items DROP CONSTRAINT rental_items_kind_check, ADD CONSTRAINT rental_items_kind_check CHECK (kind IN ('unit', 'pool'));
DROP TABLE rental_classes;
DROP FUNCTION rental_classes_guard();
ALTER TABLE rental_settings DROP CONSTRAINT rental_settings_papers_days, DROP COLUMN papers_warn_days, DROP COLUMN papers_urgent_days, DROP COLUMN papers_lapsed,
  DROP COLUMN cancel_slabs, DROP COLUMN no_show_percent;
DROP FUNCTION rental_late_fee(TEXT, NUMERIC, INTEGER, JSONB, NUMERIC, INTEGER, INTEGER);
DROP FUNCTION rental_eighths(TEXT);
DROP FUNCTION rental_cancel_slabs_ok(JSONB);
DROP FUNCTION rental_late_slabs_ok(JSONB, NUMERIC);
