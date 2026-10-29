-- Up Migration
-- What a hotel's, lodge's or guest house's house still needed on top of its
-- rooms, stays and folios: a room's three kinds of status kept apart, the
-- housekeeping that goes with them, maintenance, the night audit's day, and
-- several properties run as one.
--
--   lodging_rooms             occupancy as before (vacant or occupied); its
--                             cleanliness, dirty → cleaning → clean → inspected,
--                             with who cleaned it and inspected it last and
--                             when; out of service (a flag: the room stays on
--                             sale, flagged); do not disturb, while a guest is in
--                             it. Out of order is no longer a room's status: it
--                             is a period booked for the room (below).
--   lodging_room_status_log   each change also keeps the cleanliness, out of
--                             service and do not disturb as they then were: every
--                             cleaning step with who and when.
--   lodging_out_of_order      a room's out-of-order period, booked from today or
--                             ahead with its reason, to a last night or until put
--                             back in order: the room is off sale those nights.
--                             A room type never holds more stays on a night than
--                             it has rooms in order then, and a stay never holds a
--                             room over one of its out-of-order nights (both
--                             checked when the work is saved, the room type's row
--                             the lock). Ended early or withdrawn, never deleted.
--   lodging_tickets           a room's maintenance ticket: the issue, its priority,
--                             who it is given to, when the work started and ended,
--                             and the out-of-order period it needs, if any.
--   lodging_checklist_items   a room type's linen and minibar checklist: each
--                             linen item and each minibar item (goods kept in
--                             stock by quantity) with the number a room holds.
--   lodging_room_checks       a room's linen or minibar checked: what was found of
--   lodging_room_check_lines  each item; a minibar item used by the guest in the
--                             room is posted to their folio as goods (it leaves
--                             stock when the folio is billed).
--   lodging_night_audits      each night audit run: the property and the business
--                             date it closed, the room nights it posted, the
--                             no-shows it marked, and the day's money as the day
--                             close then had it. The business date is the date on
--                             the business's own clock: a front-desk date lagging
--                             the calendar would break "Dates on the business's
--                             clock" (bills and nights are dated by that clock).
--   lodging_settings          also whether a room is inspected before it is let,
--                             and the no-show cut-off: a reservation not checked
--                             in by that time of its arrival day is marked a
--                             no-show by the night audit (none: marked by hand).
--   lodging_rate_plans        a plan of one property, or shared by every property.
--   lodging_stays             a guest moved from another property mid-stay: the
--                             stay checked out there (its folio billed with that
--                             property's GST) that this one continues.

-- --- Settings -------------------------------------------------------------------------------------

ALTER TABLE lodging_settings ADD COLUMN inspection_required BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN no_show_cutoff TIME;

-- --- Rooms: cleanliness, out of service, do not disturb -------------------------------------------

ALTER TABLE lodging_rooms
  -- Dirty (left, to be made up), being cleaned, clean, or clean and inspected by a supervisor.
  ADD COLUMN cleaning TEXT NOT NULL DEFAULT 'clean' CHECK (cleaning IN ('dirty', 'cleaning', 'clean', 'inspected')),
  ADD COLUMN cleaned_by BIGINT REFERENCES users(id),
  ADD COLUMN cleaned_at TIMESTAMPTZ,
  ADD COLUMN inspected_by BIGINT REFERENCES users(id),
  ADD COLUMN inspected_at TIMESTAMPTZ,
  -- Out of service: still sold, flagged with why (a TV not working, a view blocked).
  ADD COLUMN out_of_service BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN out_of_service_note VARCHAR(300) CHECK (btrim(out_of_service_note) <> ''),
  -- Do not disturb: the guest in the room asked not to be disturbed.
  ADD COLUMN dnd BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE lodging_rooms SET cleaning = 'dirty' WHERE status IN ('vacant_dirty', 'out_of_order');

ALTER TABLE lodging_room_status_log ADD COLUMN cleaning TEXT, ADD COLUMN out_of_service BOOLEAN, ADD COLUMN dnd BOOLEAN;

-- What is kept as it is: never deleted (or never changed, for a record of what happened).
CREATE FUNCTION lodging_house_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'lodging_checklist_items' THEN
    RAISE EXCEPTION 'A checklist item is never deleted; switch it off instead' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('lodging_room_checks', 'lodging_room_check_lines') THEN
    RAISE EXCEPTION 'A room check is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'lodging_night_audits' THEN
    RAISE EXCEPTION 'A night audit is kept as it was run' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'An out-of-order period is never deleted; end it or withdraw it instead' USING ERRCODE = '23514';
END $$;

-- --- Out of order ---------------------------------------------------------------------------------

CREATE TABLE lodging_out_of_order (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  room_id BIGINT NOT NULL,
  -- The nights the room is off sale: from the first to the last (both included; none: until it is put back in order).
  starts_on DATE NOT NULL,
  ends_on DATE,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  -- Withdrawn before its first night.
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  request_key UUID,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, room_id) REFERENCES lodging_rooms(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  -- Two periods of a room never cover the same night.
  CONSTRAINT lodging_out_of_order_apart EXCLUDE USING gist (int8range(room_id, room_id, '[]') WITH &&, daterange(starts_on, ends_on, '[]') WITH &&) WHERE (cancelled_at IS NULL)
);
CREATE INDEX lodging_out_of_order_room ON lodging_out_of_order(business_id, room_id, starts_on) WHERE cancelled_at IS NULL;

-- A room out of order until now becomes a period from today, until it is put back in order.
INSERT INTO lodging_out_of_order (business_id, room_id, starts_on, reason, created_by, created_at)
SELECT business_id, id, lodging_today(business_id), status_note, status_by, status_at FROM lodging_rooms WHERE status = 'out_of_order';
UPDATE lodging_rooms SET status = 'vacant_dirty', status_note = NULL WHERE status = 'out_of_order';

-- A room is vacant and clean (clean or inspected), vacant and dirty (dirty or being cleaned) or
-- occupied; a guest in it may ask not to be disturbed.
ALTER TABLE lodging_rooms DROP CONSTRAINT lodging_rooms_status_check,
  ADD CONSTRAINT lodging_rooms_status_check CHECK (status IN ('vacant_clean', 'vacant_dirty', 'occupied')),
  ADD CONSTRAINT lodging_rooms_cleaning_status CHECK ((status <> 'vacant_clean' OR cleaning IN ('clean', 'inspected')) AND (status <> 'vacant_dirty' OR cleaning IN ('dirty', 'cleaning'))),
  ADD CONSTRAINT lodging_rooms_dnd CHECK (NOT dnd OR status = 'occupied'),
  ADD CONSTRAINT lodging_rooms_out_of_service CHECK (out_of_service = (out_of_service_note IS NOT NULL)),
  ADD CONSTRAINT lodging_rooms_cleaned CHECK ((cleaned_at IS NULL) = (cleaned_by IS NULL) AND (inspected_at IS NULL) = (inspected_by IS NULL));

-- Every change of a room's status, cleanliness, service or do-not-disturb is written to its history, with who and why.
CREATE OR REPLACE FUNCTION lodging_rooms_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lodging_room_status_log(business_id, room_id, from_status, to_status, note, created_by, cleaning, out_of_service, dnd)
    VALUES (NEW.business_id, NEW.id, NULL, NEW.status, NEW.status_note, NEW.status_by, NEW.cleaning, NEW.out_of_service, NEW.dnd);
  ELSIF NEW.status <> OLD.status OR NEW.status_note IS DISTINCT FROM OLD.status_note OR NEW.cleaning <> OLD.cleaning OR NEW.out_of_service <> OLD.out_of_service
     OR NEW.out_of_service_note IS DISTINCT FROM OLD.out_of_service_note OR NEW.dnd <> OLD.dnd THEN
    INSERT INTO lodging_room_status_log(business_id, room_id, from_status, to_status, note, created_by, cleaning, out_of_service, dnd)
    VALUES (NEW.business_id, NEW.id, OLD.status, NEW.status, NEW.status_note, NEW.status_by, NEW.cleaning, NEW.out_of_service, NEW.dnd);
  END IF;
  RETURN NULL;
END $$;

-- A period is booked from today or ahead, for a room in use, when it is written; it keeps its
-- room, its first night and who booked it. It ends (its last night) yesterday at the earliest,
-- never on a night already gone; it is withdrawn only before its first night has passed; once
-- ended or withdrawn it no longer changes. Never deleted.
CREATE FUNCTION lodging_out_of_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE today DATE; room RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An out-of-order period is never deleted; end it or withdraw it instead' USING ERRCODE = '23514';
  END IF;
  today := lodging_today(NEW.business_id);
  IF TG_OP = 'INSERT' THEN
    SELECT room_no, active INTO room FROM lodging_rooms WHERE business_id = NEW.business_id AND id = NEW.room_id;
    IF NOT room.active THEN
      RAISE EXCEPTION 'Room % is out of use', room.room_no USING ERRCODE = '23514';
    END IF;
    IF NEW.starts_on < today THEN
      RAISE EXCEPTION 'Room % is put out of order from today or a day ahead', room.room_no USING ERRCODE = '23514';
    END IF;
    IF NEW.created_at <> now() OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'An out-of-order period is booked when it is written' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.room_id <> OLD.room_id OR NEW.starts_on <> OLD.starts_on OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.request_key IS DISTINCT FROM OLD.request_key THEN
    RAISE EXCEPTION 'An out-of-order period keeps its room and its first night' USING ERRCODE = '23514';
  END IF;
  IF OLD.cancelled_at IS NOT NULL OR (OLD.ends_on IS NOT NULL AND OLD.ends_on < today - 1) THEN
    IF (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
      RAISE EXCEPTION 'That out-of-order period is over and no longer changes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND OLD.starts_on < today THEN
    RAISE EXCEPTION 'That out-of-order period has begun: end it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.ends_on IS DISTINCT FROM OLD.ends_on AND NEW.ends_on IS NOT NULL AND NEW.ends_on < today - 1 THEN
    RAISE EXCEPTION 'An out-of-order period ends last night at the earliest: the nights gone stay as they were' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_out_of_order_guard BEFORE INSERT OR UPDATE OR DELETE ON lodging_out_of_order
  FOR EACH ROW EXECUTE FUNCTION lodging_out_of_order_guard();

-- How many rooms of a room type at a location are out of order on a night, and why.
CREATE FUNCTION lodging_rooms_down(target_business BIGINT, target_location BIGINT, target_type BIGINT, night DATE) RETURNS TABLE (down INTEGER, why TEXT)
LANGUAGE sql STABLE AS $$
  SELECT count(*)::int, string_agg('room ' || r.room_no || ': ' || o.reason, '; ' ORDER BY lower(r.room_no))
  FROM lodging_out_of_order o JOIN lodging_rooms r ON r.business_id = o.business_id AND r.id = o.room_id
  WHERE o.business_id = target_business AND r.location_id = target_location AND r.room_type_id = target_type AND r.active AND o.cancelled_at IS NULL
    AND o.starts_on <= night AND (o.ends_on IS NULL OR o.ends_on >= night);
$$;

-- When the work is saved, the room type's row the lock: no stay holds the room over one of the
-- period's nights, and the room type still has a room in order for each stay on each of them.
CREATE FUNCTION lodging_out_of_order_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD; r RECORD; type_name TEXT; holder RECORD; rooms INTEGER; last_night DATE; busy RECORD;
BEGIN
  SELECT * INTO o FROM lodging_out_of_order WHERE business_id = NEW.business_id AND id = NEW.id;
  IF o.cancelled_at IS NOT NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NOT COALESCE((o.ends_on IS NULL AND OLD.ends_on IS NOT NULL) OR o.ends_on > OLD.ends_on, FALSE) THEN RETURN NULL; END IF;
  SELECT room_no, location_id, room_type_id INTO r FROM lodging_rooms WHERE business_id = o.business_id AND id = o.room_id;
  SELECT k.label INTO type_name FROM lodging_room_types t JOIN catalog_skus k ON k.business_id = t.business_id AND k.id = t.sku_id
  WHERE t.business_id = o.business_id AND t.id = r.room_type_id FOR UPDATE OF t;
  SELECT x.stay_no, x.guest_name, x.arrival, x.departure, x.status INTO holder FROM lodging_stays x
  WHERE x.business_id = o.business_id AND x.room_id = o.room_id AND x.status IN ('reserved', 'in_house')
    AND daterange(x.arrival, x.departure) && daterange(o.starts_on, o.ends_on, '[]')
  ORDER BY x.arrival, x.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Room % is % by % (%) for the nights of % to %: move the stay to another room first', r.room_no,
      CASE holder.status WHEN 'in_house' THEN 'occupied' ELSE 'booked' END, holder.stay_no, holder.guest_name, lodging_day_words(holder.arrival), lodging_day_words(holder.departure - 1)
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::int INTO rooms FROM lodging_rooms WHERE business_id = o.business_id AND location_id = r.location_id AND room_type_id = r.room_type_id AND active;
  last_night := COALESCE(o.ends_on, (SELECT max(x.departure) - 1 FROM lodging_stays x WHERE x.business_id = o.business_id AND x.location_id = r.location_id
    AND x.room_type_id = r.room_type_id AND x.status IN ('reserved', 'in_house') AND NOT x.day_use));
  IF last_night IS NULL THEN RETURN NULL; END IF;
  SELECT q.night, q.held, q.down INTO busy FROM (
    SELECT n::date AS night,
      (SELECT count(*)::int FROM lodging_stays x WHERE x.business_id = o.business_id AND x.location_id = r.location_id AND x.room_type_id = r.room_type_id
        AND x.status IN ('reserved', 'in_house') AND NOT x.day_use AND x.arrival <= n::date AND x.departure > n::date) AS held,
      (SELECT d.down FROM lodging_rooms_down(o.business_id, r.location_id, r.room_type_id, n::date) d) AS down
    FROM generate_series(GREATEST(o.starts_on, lodging_today(o.business_id))::timestamp, last_night::timestamp, interval '1 day') n) q
  WHERE q.held > rooms - q.down ORDER BY q.night LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Room % is needed: % % stays are booked on the night of %, with % of its rooms in order then', r.room_no, busy.held, type_name,
      lodging_day_words(busy.night), rooms - busy.down USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lodging_out_of_order_free AFTER INSERT OR UPDATE ON lodging_out_of_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lodging_out_of_order_check();

-- A room type never holds more stays on a night than it has rooms in use at the stay's
-- location and in order that night (a day use holds hours, not a night); refused with the
-- reasons of the rooms out of order. One room type at a time: its row is the lock, so two
-- stays saved together are checked one after the other.
CREATE OR REPLACE FUNCTION lodging_check_type(target_business BIGINT, target_stay BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s RECORD; type_name TEXT; rooms INTEGER; busiest RECORD;
BEGIN
  SELECT * INTO s FROM lodging_stays WHERE business_id = target_business AND id = target_stay;
  IF NOT FOUND OR s.status NOT IN ('reserved', 'in_house') OR s.day_use THEN RETURN; END IF;
  SELECT k.label INTO type_name FROM lodging_room_types t JOIN catalog_skus k ON k.business_id = t.business_id AND k.id = t.sku_id
  WHERE t.business_id = target_business AND t.id = s.room_type_id FOR UPDATE OF t;
  SELECT count(*)::int INTO rooms FROM lodging_rooms WHERE business_id = target_business AND location_id = s.location_id AND room_type_id = s.room_type_id AND active;
  SELECT q.night, q.held, q.down, q.why INTO busiest FROM (
    SELECT n::date AS night,
      (SELECT count(*)::int FROM lodging_stays x WHERE x.business_id = target_business AND x.location_id = s.location_id AND x.room_type_id = s.room_type_id
        AND x.status IN ('reserved', 'in_house') AND NOT x.day_use AND x.arrival <= n::date AND x.departure > n::date) AS held,
      d.down, d.why
    FROM generate_series(s.arrival::timestamp, (s.departure - 1)::timestamp, interval '1 day') n
    CROSS JOIN LATERAL lodging_rooms_down(target_business, s.location_id, s.room_type_id, n::date) d) q
  WHERE q.held > rooms - q.down ORDER BY q.night LIMIT 1;
  IF FOUND THEN
    IF rooms = 0 THEN
      RAISE EXCEPTION 'There are no % rooms at this location yet: add them under Settings › Room types & rates', type_name USING ERRCODE = '23514';
    END IF;
    IF busiest.down > 0 THEN
      RAISE EXCEPTION 'Every % room is taken on the night of % (% stays for % rooms, % out of order: %): choose other dates or another room type', type_name,
        lodging_day_words(busiest.night), busiest.held, rooms, busiest.down, busiest.why USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Every % room is taken on the night of % (% stays for % rooms): choose other dates or another room type', type_name,
      lodging_day_words(busiest.night), busiest.held, rooms USING ERRCODE = '23514';
  END IF;
END $$;

-- When the work is saved: a stay never holds a room (a night stay or a day use) over one of its
-- out-of-order nights. The room type's row is the lock, as when a period is booked.
CREATE FUNCTION lodging_stays_in_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD; down RECORD;
BEGIN
  SELECT * INTO s FROM lodging_stays WHERE business_id = NEW.business_id AND id = NEW.id;
  IF s.room_id IS NULL OR s.status NOT IN ('reserved', 'in_house') THEN RETURN NULL; END IF;
  PERFORM 1 FROM lodging_room_types t JOIN lodging_rooms r ON r.business_id = t.business_id AND r.room_type_id = t.id
  WHERE r.business_id = s.business_id AND r.id = s.room_id FOR UPDATE OF t;
  SELECT r.room_no, o.starts_on, o.ends_on, o.reason INTO down FROM lodging_out_of_order o JOIN lodging_rooms r ON r.business_id = o.business_id AND r.id = o.room_id
  WHERE o.business_id = s.business_id AND o.room_id = s.room_id AND o.cancelled_at IS NULL AND daterange(o.starts_on, o.ends_on, '[]') && daterange(s.arrival, s.departure)
  ORDER BY o.starts_on LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Room % is out of order from % (%): choose another room', down.room_no, lodging_day_words(down.starts_on), down.reason USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER lodging_stays_in_order AFTER INSERT OR UPDATE OF room_id, arrival, departure, status ON lodging_stays
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION lodging_stays_in_order();

-- --- Maintenance tickets --------------------------------------------------------------------------

CREATE TABLE lodging_tickets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- Numbered in the business 1, 2, 3 ….
  ticket_no INTEGER NOT NULL CHECK (ticket_no > 0),
  room_id BIGINT NOT NULL,
  issue VARCHAR(500) NOT NULL CHECK (btrim(issue) <> ''),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- Open → in progress → done, or cancelled while not done.
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  -- The member of staff it is given to.
  assigned_to BIGINT REFERENCES users(id),
  -- When the work started and when it ended (done or cancelled), and by whom.
  started_at TIMESTAMPTZ,
  started_by BIGINT REFERENCES users(id),
  finished_at TIMESTAMPTZ,
  finished_by BIGINT REFERENCES users(id),
  -- What was done, or why it was cancelled.
  outcome VARCHAR(500) CHECK (btrim(outcome) <> ''),
  -- The room's out-of-order period the work needs.
  out_of_order_id BIGINT,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, room_id) REFERENCES lodging_rooms(business_id, id),
  FOREIGN KEY (business_id, out_of_order_id) REFERENCES lodging_out_of_order(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, ticket_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, out_of_order_id),
  CHECK (status IN ('open', 'cancelled') OR started_at IS NOT NULL),
  CHECK ((started_at IS NULL) = (started_by IS NULL)),
  CHECK ((status IN ('done', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK ((finished_at IS NULL) = (finished_by IS NULL)),
  CHECK (status <> 'cancelled' OR outcome IS NOT NULL),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX lodging_tickets_list ON lodging_tickets(business_id, status, priority);
CREATE INDEX lodging_tickets_room ON lodging_tickets(business_id, room_id, id);

-- A ticket starts open when it is written; it keeps its number and room; it goes open → in
-- progress → done, or is cancelled before it is done; the work starts and ends once; the
-- out-of-order period it needs is the room's own, given once. Done or cancelled, it no longer
-- changes. Never deleted.
CREATE FUNCTION lodging_tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A maintenance ticket is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.out_of_order_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.out_of_order_id IS DISTINCT FROM OLD.out_of_order_id)
     AND NOT EXISTS (SELECT 1 FROM lodging_out_of_order WHERE business_id = NEW.business_id AND id = NEW.out_of_order_id AND room_id = NEW.room_id) THEN
    RAISE EXCEPTION 'Ticket %: its out-of-order period is its room''s', NEW.ticket_no USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.created_at <> now() OR NEW.started_at IS NOT NULL THEN
      RAISE EXCEPTION 'A maintenance ticket starts open, when it is written' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('done', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
      RAISE EXCEPTION 'Ticket % is % and no longer changes', OLD.ticket_no, OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.ticket_no <> OLD.ticket_no OR NEW.room_id <> OLD.room_id OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A maintenance ticket keeps its number and its room' USING ERRCODE = '23514';
  END IF;
  IF OLD.out_of_order_id IS NOT NULL AND NEW.out_of_order_id IS DISTINCT FROM OLD.out_of_order_id THEN
    RAISE EXCEPTION 'Ticket % keeps its out-of-order period', OLD.ticket_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'open' AND NEW.status IN ('in_progress', 'done', 'cancelled')) OR (OLD.status = 'in_progress' AND NEW.status IN ('done', 'cancelled'))) THEN
    RAISE EXCEPTION 'Ticket % cannot go from % to %', OLD.ticket_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF OLD.started_at IS NOT NULL AND (NEW.started_at, NEW.started_by) IS DISTINCT FROM (OLD.started_at, OLD.started_by) THEN
    RAISE EXCEPTION 'Ticket %: the work started once', OLD.ticket_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_tickets_guard BEFORE INSERT OR UPDATE OR DELETE ON lodging_tickets FOR EACH ROW EXECUTE FUNCTION lodging_tickets_guard();

-- --- Linen and minibar checklists -----------------------------------------------------------------

CREATE TABLE lodging_checklist_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  room_type_id BIGINT NOT NULL,
  -- Linen (a bath towel, a bedsheet: named) or the minibar's (goods kept in stock by quantity).
  kind TEXT NOT NULL CHECK (kind IN ('linen', 'minibar')),
  name VARCHAR(80) CHECK (btrim(name) <> ''),
  sku_id BIGINT,
  -- How many a room of the type holds.
  par SMALLINT NOT NULL CHECK (par BETWEEN 1 AND 99),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, room_type_id) REFERENCES lodging_room_types(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((kind = 'minibar') = (sku_id IS NOT NULL)),
  CHECK ((kind = 'linen') = (name IS NOT NULL))
);
CREATE UNIQUE INDEX lodging_checklist_items_one ON lodging_checklist_items(business_id, room_type_id, kind, COALESCE(sku_id, 0), lower(COALESCE(name, '')));
CREATE TRIGGER lodging_checklist_items_kept BEFORE DELETE ON lodging_checklist_items FOR EACH ROW EXECUTE FUNCTION lodging_house_kept();

CREATE TABLE lodging_room_checks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  room_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('linen', 'minibar')),
  -- The stay in the room then: its folio takes what the minibar's guest used.
  stay_id BIGINT,
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, room_id) REFERENCES lodging_rooms(business_id, id),
  FOREIGN KEY (business_id, stay_id) REFERENCES lodging_stays(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX lodging_room_checks_room ON lodging_room_checks(business_id, room_id, id);
CREATE TRIGGER lodging_room_checks_kept BEFORE UPDATE OR DELETE ON lodging_room_checks FOR EACH ROW EXECUTE FUNCTION lodging_house_kept();

CREATE TABLE lodging_room_check_lines (
  business_id BIGINT NOT NULL,
  check_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  -- How many the room holds, and how many were found.
  par SMALLINT NOT NULL CHECK (par BETWEEN 1 AND 99),
  found SMALLINT NOT NULL CHECK (found BETWEEN 0 AND 999),
  -- A minibar item used: the goods charged to the guest's folio for it.
  charge_id BIGINT,
  PRIMARY KEY (business_id, check_id, item_id),
  FOREIGN KEY (business_id, check_id) REFERENCES lodging_room_checks(business_id, id),
  FOREIGN KEY (business_id, item_id) REFERENCES lodging_checklist_items(business_id, id),
  FOREIGN KEY (business_id, charge_id) REFERENCES lodging_charges(business_id, id),
  UNIQUE (business_id, charge_id)
);
CREATE TRIGGER lodging_room_check_lines_kept BEFORE UPDATE OR DELETE ON lodging_room_check_lines FOR EACH ROW EXECUTE FUNCTION lodging_house_kept();

-- --- The night audit ------------------------------------------------------------------------------

CREATE TABLE lodging_night_audits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The property audited (none: every property).
  location_id BIGINT,
  -- The business date it closed: the business's own date when it ran.
  day DATE NOT NULL,
  nights INTEGER NOT NULL CHECK (nights >= 0),
  no_shows INTEGER NOT NULL CHECK (no_shows >= 0),
  -- The day's money as the day close had it then (none for someone who does not see money).
  day_close JSONB CHECK (day_close IS NULL OR jsonb_typeof(day_close) = 'object'),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id)
);
CREATE INDEX lodging_night_audits_day ON lodging_night_audits(business_id, day DESC, id DESC);
CREATE TRIGGER lodging_night_audits_kept BEFORE UPDATE OR DELETE ON lodging_night_audits FOR EACH ROW EXECUTE FUNCTION lodging_house_kept();

-- --- Several properties ---------------------------------------------------------------------------

-- A rate plan of one property (its location), or shared by every property (none).
ALTER TABLE lodging_rate_plans ADD COLUMN location_id BIGINT, ADD FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id);
DROP INDEX lodging_rate_plans_name;
CREATE UNIQUE INDEX lodging_rate_plans_name ON lodging_rate_plans(business_id, room_type_id, COALESCE(location_id, 0), lower(name));

-- The stay at another property that this one continues (the guest moved mid-stay).
ALTER TABLE lodging_stays ADD COLUMN moved_from_stay_id BIGINT, ADD FOREIGN KEY (business_id, moved_from_stay_id) REFERENCES lodging_stays(business_id, id),
  ADD CONSTRAINT lodging_stays_moved_once UNIQUE (business_id, moved_from_stay_id);

-- A stay's plan is its property's or one every property shares; a stay that continues another
-- does so from when it is made: one checked out at another property, of the same guest. A guest
-- checks in (or moves) to an inspected room when the property asks for inspection.
CREATE FUNCTION lodging_stays_house() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE place BIGINT; was RECORD; room RECORD;
BEGIN
  IF NEW.rate_plan_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.rate_plan_id IS DISTINCT FROM OLD.rate_plan_id) THEN
    SELECT location_id INTO place FROM lodging_rate_plans WHERE business_id = NEW.business_id AND id = NEW.rate_plan_id;
    IF place IS NOT NULL AND place <> NEW.location_id THEN
      RAISE EXCEPTION 'Stay %: its rate plan is one of another property''s', NEW.stay_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.moved_from_stay_id IS DISTINCT FROM OLD.moved_from_stay_id THEN
    RAISE EXCEPTION 'Stay % keeps the stay it continues', OLD.stay_no USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.moved_from_stay_id IS NOT NULL THEN
    SELECT status, location_id, contact_id INTO was FROM lodging_stays WHERE business_id = NEW.business_id AND id = NEW.moved_from_stay_id;
    IF was.status <> 'checked_out' OR was.location_id = NEW.location_id OR was.contact_id <> NEW.contact_id THEN
      RAISE EXCEPTION 'A guest moved from another property continues a stay of theirs checked out there' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'in_house' AND NEW.room_id IS NOT NULL AND (OLD.status <> 'in_house' OR NEW.room_id IS DISTINCT FROM OLD.room_id)
     AND EXISTS (SELECT 1 FROM lodging_settings WHERE business_id = NEW.business_id AND inspection_required) THEN
    SELECT room_no, cleaning INTO room FROM lodging_rooms WHERE business_id = NEW.business_id AND id = NEW.room_id;
    IF room.cleaning <> 'inspected' THEN
      RAISE EXCEPTION 'Room % is not inspected yet: a guest checks in to a room inspected after it was cleaned', room.room_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lodging_stays_house BEFORE INSERT OR UPDATE ON lodging_stays FOR EACH ROW EXECUTE FUNCTION lodging_stays_house();

-- Down Migration
DROP TRIGGER lodging_stays_house ON lodging_stays;
DROP FUNCTION lodging_stays_house();
ALTER TABLE lodging_stays DROP CONSTRAINT lodging_stays_moved_once, DROP COLUMN moved_from_stay_id;
-- Refuses while two plans of one room type share a name at different properties (restore a backup instead).
DROP INDEX lodging_rate_plans_name;
ALTER TABLE lodging_rate_plans DROP COLUMN location_id;
CREATE UNIQUE INDEX lodging_rate_plans_name ON lodging_rate_plans(business_id, room_type_id, lower(name));

DROP TABLE lodging_night_audits, lodging_room_check_lines, lodging_room_checks, lodging_checklist_items, lodging_tickets;
DROP FUNCTION lodging_tickets_guard();

DROP TRIGGER lodging_stays_in_order ON lodging_stays;
DROP FUNCTION lodging_stays_in_order();

-- The room type's check as it was (1791979720000_lodging-stays).
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

DROP TRIGGER lodging_out_of_order_free ON lodging_out_of_order;
DROP FUNCTION lodging_out_of_order_check();
DROP FUNCTION lodging_rooms_down(BIGINT, BIGINT, BIGINT, DATE);

-- The room's history as it was written (1791970000000_lodging).
CREATE OR REPLACE FUNCTION lodging_rooms_log() RETURNS trigger LANGUAGE plpgsql AS $$
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

-- A room out of order tonight (and not occupied) takes that status again, with its reason.
ALTER TABLE lodging_rooms DROP CONSTRAINT lodging_rooms_cleaned, DROP CONSTRAINT lodging_rooms_out_of_service, DROP CONSTRAINT lodging_rooms_dnd,
  DROP CONSTRAINT lodging_rooms_cleaning_status, DROP CONSTRAINT lodging_rooms_status_check,
  ADD CONSTRAINT lodging_rooms_status_check CHECK (status IN ('vacant_clean', 'vacant_dirty', 'occupied', 'out_of_order'));
UPDATE lodging_rooms r SET status = 'out_of_order', status_note = o.reason FROM lodging_out_of_order o
WHERE o.business_id = r.business_id AND o.room_id = r.id AND o.cancelled_at IS NULL AND r.status <> 'occupied'
  AND o.starts_on <= lodging_today(r.business_id) AND (o.ends_on IS NULL OR o.ends_on >= lodging_today(r.business_id));
DROP TABLE lodging_out_of_order;
DROP FUNCTION lodging_out_of_order_guard();
DROP FUNCTION lodging_house_kept();

ALTER TABLE lodging_room_status_log DROP COLUMN dnd, DROP COLUMN out_of_service, DROP COLUMN cleaning;
ALTER TABLE lodging_rooms DROP COLUMN dnd, DROP COLUMN out_of_service_note, DROP COLUMN out_of_service, DROP COLUMN inspected_at, DROP COLUMN inspected_by,
  DROP COLUMN cleaned_at, DROP COLUMN cleaned_by, DROP COLUMN cleaning;

ALTER TABLE lodging_settings DROP COLUMN no_show_cutoff, DROP COLUMN inspection_required;
