-- Up Migration
-- What a garage still needed inside Vehicles & job cards: parts that fit a
-- vehicle and what to offer when one is out of stock, photos of the
-- inspection, a mechanic's own screen, insurance claims followed to the
-- insurer's payment, the road test and the gate pass, parts issued to a job,
-- service plans by model, mechanics' commission on labour, and job cards
-- opened from a service booking or a quotation.
--
--   garage_part_groups / garage_parts
--                           a part's newer number (superseded by) and its
--                           group of parts that do the same job, offered at
--                           the parts counter and on a job card when a part
--                           is out of stock. The shop's own; no catalogue is
--                           shipped.
--   garage_part_fitments    the makes and models a part fits: make, model,
--                           variant, fuel, years from and to, engine code.
--   garage_vehicles.engine_code
--                           the engine's code (K12M), for fitment and plans.
--   garage_inspection_items each area checked when the vehicle came in, with
--                           what was found.
--   garage_job_card_photos  photos of an inspection item, or of the work (a
--                           mechanic's), kept as files under the private
--                           uploads folder; never changed or deleted.
--   garage_part_issues      parts issued to a mechanic for a job (they leave
--                           stock at once, by a core stock adjustment, held
--                           for the job) and parts brought back unused (back
--                           into stock the same way). The bill takes the
--                           parts issued and takes nothing out of stock again.
--   garage_road_tests       a road test: who drove, how far, whether it
--                           passed, and remarks. A shop that asks for one
--                           (garage_settings.road_test_required) marks a job
--                           ready only after a passed test.
--   garage_gate_passes      the gate pass made when the job is billed and the
--                           vehicle handed over, and the vehicle leaving.
--   garage_claims.intimated_on, .insurer_named
--                           when the claim was intimated; a reimbursement
--                           claim billed in the insurer's name and paid by
--                           the customer.
--   garage_claim_steps      a claim's progress after it was intimated:
--                           surveyed, approved, work done, re-inspected,
--                           invoiced and settled, each with its date.
--   garage_claim_settlements
--                           what the insurer did not pay of its bill: written
--                           off by a manager or billed to the customer, with
--                           a credit note on the insurer's bill.
--   garage_service_plans    a service plan per make and model or engine: the
--                           kilometres and days to the next service,
--                           whichever comes first, in place of the shop's own.
--   garage_commission_rates, garage_commissions, garage_commission_payouts
--                           a mechanic's commission on labour: a rate per
--                           labour item or per mechanic, earned on the labour
--                           billed and paid through the expense book.
--   garage_job_cards.appointment_id, .quotation_id
--                           the service booking a job card was opened from,
--                           and the quotation that became its estimate.
--   garage_job_card_lines.old_part
--                           what became of a part line's old part: returned
--                           to the customer, kept for the surveyor, or sold
--                           as scrap (salvage).
--   garage_settings.issue_parts, .road_test_required
--                           whether parts are issued to mechanics (or leave
--                           stock when the job is billed), and whether a road
--                           test comes before ready.

-- --- Settings and job cards -------------------------------------------------------------------

ALTER TABLE garage_settings ADD COLUMN issue_parts BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN road_test_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE garage_vehicles ADD COLUMN engine_code VARCHAR(30) CHECK (engine_code ~ '^[A-Z0-9-]{2,30}$');

ALTER TABLE garage_job_cards ADD COLUMN appointment_id BIGINT, ADD COLUMN quotation_id BIGINT,
  ADD CONSTRAINT garage_job_cards_appointment_fkey FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id),
  ADD CONSTRAINT garage_job_cards_quotation_fkey FOREIGN KEY (business_id, quotation_id) REFERENCES business_quotations(business_id, id);
CREATE UNIQUE INDEX garage_job_cards_appointment ON garage_job_cards(business_id, appointment_id) WHERE appointment_id IS NOT NULL;
CREATE UNIQUE INDEX garage_job_cards_quotation ON garage_job_cards(business_id, quotation_id) WHERE quotation_id IS NOT NULL;

-- A part line's old part (salvage): handed back to the customer, kept for the
-- insurer's surveyor, or sold as scrap.
ALTER TABLE garage_job_card_lines ADD COLUMN old_part TEXT CHECK (old_part IN ('returned', 'surveyor', 'scrap')),
  ADD CONSTRAINT garage_job_card_lines_old_part CHECK (old_part IS NULL OR kind = 'part');

-- An estimate's version may come from a quotation.
ALTER TABLE garage_estimate_versions DROP CONSTRAINT garage_estimate_versions_source_check,
  ADD CONSTRAINT garage_estimate_versions_source_check CHECK (source IN ('estimate', 'parts', 'claim', 'quotation'));

-- What the new garage records keep as they were.
CREATE FUNCTION garage_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'garage_job_card_photos' THEN
    RAISE EXCEPTION 'A photo of a job card is kept as it was taken' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'garage_part_issues' THEN
    RAISE EXCEPTION 'Parts issued and brought back are kept as they were recorded' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'garage_road_tests' THEN
    RAISE EXCEPTION 'A road test is kept as it was recorded' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'garage_claim_steps' THEN
    RAISE EXCEPTION 'A claim''s progress is kept as it was recorded' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'garage_claim_settlements' THEN
    RAISE EXCEPTION 'A claim''s settlement is kept as it was made' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'garage_commissions' THEN
    RAISE EXCEPTION 'A commission earned is kept as it was worked out' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A commission paid is kept as it was paid' USING ERRCODE = '23514';
END $$;

-- A record added to a job card only while it is open.
CREATE FUNCTION garage_job_card_is_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT; number TEXT;
BEGIN
  SELECT status, job_no INTO state, number FROM garage_job_cards WHERE business_id = NEW.business_id AND id = NEW.job_card_id;
  IF state IS NULL OR state IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Job card % is % and takes nothing more', number, COALESCE(state, 'missing') USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- Parts: newer numbers, interchangeable groups and fitment ---------------------------------

CREATE TABLE garage_part_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX garage_part_groups_name ON garage_part_groups(business_id, lower(name));

CREATE TABLE garage_parts (
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  -- The part that replaces this one (an old number replaced by a new one).
  superseded_by_sku_id BIGINT,
  -- The parts that do the same job and can be offered for one another.
  group_id BIGINT,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, superseded_by_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, group_id) REFERENCES garage_part_groups(business_id, id),
  CHECK (superseded_by_sku_id IS NULL OR superseded_by_sku_id <> sku_id)
);
CREATE INDEX garage_parts_group ON garage_parts(business_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX garage_parts_superseded ON garage_parts(business_id, superseded_by_sku_id) WHERE superseded_by_sku_id IS NOT NULL;

CREATE TABLE garage_part_fitments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  make VARCHAR(60) NOT NULL CHECK (btrim(make) <> ''),
  -- Empty: every model of the make (every variant, fuel, year, engine).
  model VARCHAR(60) CHECK (btrim(model) <> ''),
  variant VARCHAR(60) CHECK (btrim(variant) <> ''),
  fuel TEXT CHECK (fuel IN ('petrol', 'diesel', 'cng', 'petrol_cng', 'lpg', 'electric', 'hybrid')),
  year_from SMALLINT CHECK (year_from BETWEEN 1950 AND 2100),
  year_to SMALLINT CHECK (year_to BETWEEN 1950 AND 2100),
  engine_code VARCHAR(30) CHECK (engine_code ~ '^[A-Z0-9-]{2,30}$'),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  CHECK (year_to IS NULL OR year_from IS NULL OR year_to >= year_from)
);
CREATE UNIQUE INDEX garage_part_fitments_once ON garage_part_fitments(business_id, sku_id, lower(make), lower(COALESCE(model, '')), lower(COALESCE(variant, '')),
  COALESCE(fuel, ''), COALESCE(year_from, 0), COALESCE(year_to, 0), COALESCE(engine_code, ''));
CREATE INDEX garage_part_fitments_vehicle ON garage_part_fitments(business_id, lower(make), lower(COALESCE(model, '')));

-- A part is an item kept in stock, and so is the part that replaces it; a
-- chain of newer numbers never comes back to a part already in it.
CREATE FUNCTION garage_part_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE looped BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
                 WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id AND p.kind = 'goods') THEN
    RAISE EXCEPTION 'A part is an item kept in stock' USING ERRCODE = '23514';
  END IF;
  -- The fitment table has no newer number (its own statement, planned only for garage_parts).
  IF TG_TABLE_NAME <> 'garage_parts' THEN
    RETURN NEW;
  END IF;
  IF NEW.superseded_by_sku_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
                   WHERE s.business_id = NEW.business_id AND s.id = NEW.superseded_by_sku_id AND p.kind = 'goods') THEN
      RAISE EXCEPTION 'A part is replaced by another part kept in stock' USING ERRCODE = '23514';
    END IF;
    WITH RECURSIVE chain(sku) AS (
      SELECT NEW.superseded_by_sku_id
      UNION
      SELECT p.superseded_by_sku_id FROM garage_parts p JOIN chain c ON p.business_id = NEW.business_id AND p.sku_id = c.sku
      WHERE p.superseded_by_sku_id IS NOT NULL AND p.sku_id <> NEW.sku_id)
    SELECT EXISTS (SELECT 1 FROM chain WHERE sku = NEW.sku_id) INTO looped;
    IF looped THEN
      RAISE EXCEPTION 'That part is already replaced, in turn, by this one: a newer number never leads back' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_parts_check BEFORE INSERT OR UPDATE ON garage_parts FOR EACH ROW EXECUTE FUNCTION garage_part_check();
CREATE TRIGGER garage_part_fitments_check BEFORE INSERT OR UPDATE ON garage_part_fitments FOR EACH ROW EXECUTE FUNCTION garage_part_check();

-- --- The inspection and photos ------------------------------------------------------------------

CREATE TABLE garage_inspection_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  -- The area checked (Front bumper, Tyres) and what was found.
  area VARCHAR(80) NOT NULL CHECK (btrim(area) <> ''),
  finding VARCHAR(300) CHECK (btrim(finding) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  UNIQUE (business_id, id)
);
CREATE INDEX garage_inspection_items_job ON garage_inspection_items(business_id, job_card_id, id);

CREATE TABLE garage_job_card_photos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  -- The inspection item it shows; none: a photo of the work.
  inspection_item_id BIGINT,
  caption VARCHAR(200) CHECK (btrim(caption) <> ''),
  stored_name VARCHAR(80) NOT NULL CHECK (stored_name ~ '^[a-f0-9]{32}\.(jpg|png|webp)$'),
  file_name VARCHAR(150) NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  FOREIGN KEY (business_id, inspection_item_id) REFERENCES garage_inspection_items(business_id, id),
  UNIQUE (business_id, stored_name)
);
CREATE INDEX garage_job_card_photos_job ON garage_job_card_photos(business_id, job_card_id, id);

-- An inspection item is added while the job card is open, and taken off
-- only then and only with no photo; it never changes.
CREATE FUNCTION garage_inspection_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'An inspection item is kept as it was written: take it off and add it again' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO state FROM garage_job_cards WHERE business_id = OLD.business_id AND id = OLD.job_card_id;
  IF state IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'The inspection of a billed or cancelled job card never changes' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM garage_job_card_photos WHERE business_id = OLD.business_id AND inspection_item_id = OLD.id) THEN
    RAISE EXCEPTION 'An inspection item with photos stays on the job card' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER garage_inspection_items_open BEFORE INSERT ON garage_inspection_items FOR EACH ROW EXECUTE FUNCTION garage_job_card_is_open();
CREATE TRIGGER garage_inspection_items_guard BEFORE UPDATE OR DELETE ON garage_inspection_items FOR EACH ROW EXECUTE FUNCTION garage_inspection_items_guard();

-- A photo of an inspection item belongs to that item's job card.
CREATE FUNCTION garage_job_card_photos_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inspection_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM garage_inspection_items
      WHERE business_id = NEW.business_id AND id = NEW.inspection_item_id AND job_card_id = NEW.job_card_id) THEN
    RAISE EXCEPTION 'A photo of an inspection item goes on that item''s job card' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_job_card_photos_open BEFORE INSERT ON garage_job_card_photos FOR EACH ROW EXECUTE FUNCTION garage_job_card_is_open();
CREATE TRIGGER garage_job_card_photos_check BEFORE INSERT ON garage_job_card_photos FOR EACH ROW EXECUTE FUNCTION garage_job_card_photos_check();
CREATE TRIGGER garage_job_card_photos_kept BEFORE UPDATE OR DELETE ON garage_job_card_photos FOR EACH ROW EXECUTE FUNCTION garage_kept();

-- --- Parts issued to a job ---------------------------------------------------------------------

CREATE TABLE garage_part_issues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  -- The part line on the job card it is for.
  line_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  lot_id BIGINT NOT NULL,
  lot_code VARCHAR(100) NOT NULL DEFAULT '',
  -- Issued to the mechanic, or brought back unused.
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'return')),
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  -- The stock's cost of one unit when it was issued (the bill's stock cost).
  unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  mechanic_id BIGINT REFERENCES users(id),
  -- The core stock adjustment that took it out of stock or put it back.
  adjustment_id BIGINT NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES garage_job_card_lines(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, lot_id) REFERENCES business_stock_lots(business_id, id),
  FOREIGN KEY (business_id, adjustment_id) REFERENCES business_stock_adjustments(business_id, id),
  UNIQUE (business_id, adjustment_id),
  CHECK (kind = 'return' OR mechanic_id IS NOT NULL)
);
CREATE INDEX garage_part_issues_job ON garage_part_issues(business_id, job_card_id, line_id);
CREATE INDEX garage_part_issues_request ON garage_part_issues(business_id, request_key);

-- A part is issued for a part line of the job card, from that line's item,
-- and never brought back more than was issued from that stock.
CREATE FUNCTION garage_part_issues_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; held NUMERIC;
BEGIN
  SELECT job_card_id, sku_id, kind INTO line FROM garage_job_card_lines WHERE business_id = NEW.business_id AND id = NEW.line_id;
  IF line.job_card_id IS DISTINCT FROM NEW.job_card_id OR line.kind <> 'part' OR line.sku_id <> NEW.sku_id THEN
    RAISE EXCEPTION 'A part is issued for a part line of its own job card' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'return' THEN
    SELECT COALESCE(sum(CASE WHEN kind = 'issue' THEN quantity ELSE -quantity END), 0) INTO held
    FROM garage_part_issues WHERE business_id = NEW.business_id AND line_id = NEW.line_id AND lot_id = NEW.lot_id;
    IF NEW.quantity > held THEN
      RAISE EXCEPTION 'Only % of that part was issued from that stock: no more comes back', held USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_part_issues_open BEFORE INSERT ON garage_part_issues FOR EACH ROW EXECUTE FUNCTION garage_job_card_is_open();
CREATE TRIGGER garage_part_issues_check BEFORE INSERT ON garage_part_issues FOR EACH ROW EXECUTE FUNCTION garage_part_issues_check();
CREATE TRIGGER garage_part_issues_kept BEFORE UPDATE OR DELETE ON garage_part_issues FOR EACH ROW EXECUTE FUNCTION garage_kept();

-- --- The road test and the gate pass ------------------------------------------------------------

CREATE TABLE garage_road_tests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  -- Who drove it, how far, whether it passed, and what they noticed.
  tested_by BIGINT NOT NULL REFERENCES users(id),
  distance_km NUMERIC(6,1) NOT NULL CHECK (distance_km > 0 AND distance_km <= 500),
  passed BOOLEAN NOT NULL,
  remarks VARCHAR(300) CHECK (btrim(remarks) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  CHECK (passed OR remarks IS NOT NULL)
);
CREATE INDEX garage_road_tests_job ON garage_road_tests(business_id, job_card_id, id);
CREATE TRIGGER garage_road_tests_open BEFORE INSERT ON garage_road_tests FOR EACH ROW EXECUTE FUNCTION garage_job_card_is_open();
CREATE TRIGGER garage_road_tests_kept BEFORE UPDATE OR DELETE ON garage_road_tests FOR EACH ROW EXECUTE FUNCTION garage_kept();

CREATE TABLE garage_gate_passes (
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  issued_by BIGINT NOT NULL REFERENCES users(id),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The vehicle leaving: when, who saw it out, and a note (who drove it).
  left_at TIMESTAMPTZ,
  left_recorded_by BIGINT REFERENCES users(id),
  left_note VARCHAR(300) CHECK (btrim(left_note) <> ''),
  PRIMARY KEY (business_id, job_card_id),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  CHECK ((left_at IS NULL) = (left_recorded_by IS NULL)),
  CHECK (left_note IS NULL OR left_at IS NOT NULL)
);

-- A gate pass is made for a delivered job card; the vehicle leaves once.
CREATE FUNCTION garage_gate_passes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM garage_job_cards WHERE business_id = NEW.business_id AND id = NEW.job_card_id AND status = 'delivered') THEN
      RAISE EXCEPTION 'A gate pass is made when the job is billed and the vehicle handed over' USING ERRCODE = '23514';
    END IF;
    IF NEW.left_at IS NOT NULL THEN
      RAISE EXCEPTION 'A gate pass is made before the vehicle leaves' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gate pass is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.left_at IS NOT NULL OR NEW.business_id <> OLD.business_id OR NEW.job_card_id <> OLD.job_card_id OR NEW.issued_by <> OLD.issued_by OR NEW.issued_at <> OLD.issued_at THEN
    RAISE EXCEPTION 'A gate pass keeps what it says, and the vehicle leaves once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_gate_passes_guard BEFORE INSERT OR UPDATE OR DELETE ON garage_gate_passes FOR EACH ROW EXECUTE FUNCTION garage_gate_passes_guard();

-- --- Insurance claims: progress and settlement --------------------------------------------------

ALTER TABLE garage_claims ADD COLUMN intimated_on DATE,
  ADD COLUMN insurer_named BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT garage_claims_insurer_named CHECK (NOT insurer_named OR mode = 'reimbursement');

CREATE TABLE garage_claim_steps (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('surveyed', 'approved', 'work_done', 'reinspected', 'invoiced', 'settled')),
  on_date DATE NOT NULL,
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_claims(business_id, job_card_id),
  UNIQUE (business_id, job_card_id, step)
);

-- A claim moves forward only (a step may be skipped), each step on or after
-- the one before and the day it was intimated, never after today; it is
-- invoiced with the job's bills and settled only after.
CREATE FUNCTION garage_claim_steps_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  steps TEXT[] := ARRAY['surveyed', 'approved', 'work_done', 'reinspected', 'invoiced', 'settled'];
  last RECORD; claim RECORD; today DATE; state TEXT;
BEGIN
  SELECT g.intimated_on, (now() AT TIME ZONE b.timezone)::date AS day INTO claim
  FROM garage_claims g JOIN businesses b ON b.id = g.business_id WHERE g.business_id = NEW.business_id AND g.job_card_id = NEW.job_card_id;
  today := claim.day;
  SELECT status INTO state FROM garage_job_cards WHERE business_id = NEW.business_id AND id = NEW.job_card_id;
  SELECT step, on_date INTO last FROM garage_claim_steps WHERE business_id = NEW.business_id AND job_card_id = NEW.job_card_id
  ORDER BY array_position(steps, step) DESC LIMIT 1;
  IF last.step IS NOT NULL AND array_position(steps, NEW.step) <= array_position(steps, last.step) THEN
    RAISE EXCEPTION 'The claim is % already: it moves forward only', replace(last.step, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.on_date > today THEN
    RAISE EXCEPTION 'A claim''s step is dated today or earlier' USING ERRCODE = '23514';
  END IF;
  IF NEW.on_date < COALESCE(last.on_date, claim.intimated_on, NEW.on_date) OR NEW.on_date < COALESCE(claim.intimated_on, NEW.on_date) THEN
    RAISE EXCEPTION 'A claim''s step comes on or after the one before it' USING ERRCODE = '23514';
  END IF;
  IF NEW.step IN ('invoiced', 'settled') AND state <> 'delivered' THEN
    RAISE EXCEPTION 'A claim is invoiced with the job''s bills' USING ERRCODE = '23514';
  END IF;
  IF NEW.step = 'settled' AND last.step IS DISTINCT FROM 'invoiced' THEN
    RAISE EXCEPTION 'A claim is settled after it is invoiced' USING ERRCODE = '23514';
  END IF;
  IF NEW.step NOT IN ('invoiced', 'settled') AND state IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'The job card is %: the claim''s steps before its bill are recorded while it is open', replace(state, '_', ' ') USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_claim_steps_check BEFORE INSERT ON garage_claim_steps FOR EACH ROW EXECUTE FUNCTION garage_claim_steps_check();
CREATE TRIGGER garage_claim_steps_kept BEFORE UPDATE OR DELETE ON garage_claim_steps FOR EACH ROW EXECUTE FUNCTION garage_kept();

-- A claim that has moved on past its intimation stays on the job card.
CREATE FUNCTION garage_claims_moved_on() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM garage_claim_steps WHERE business_id = OLD.business_id AND job_card_id = OLD.job_card_id) THEN
    RAISE EXCEPTION 'The claim has moved on since it was intimated: it stays on the job card' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER garage_claims_moved_on BEFORE DELETE ON garage_claims FOR EACH ROW EXECUTE FUNCTION garage_claims_moved_on();

CREATE TABLE garage_claim_settlements (
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  -- The insurer's bill, what it did not pay, and how that was settled: a
  -- credit note on the insurer's bill, and for "billed" a bill to the customer.
  document_id BIGINT NOT NULL,
  short_amount NUMERIC(16,2) NOT NULL CHECK (short_amount > 0),
  how TEXT NOT NULL CHECK (how IN ('written_off', 'billed')),
  return_id BIGINT NOT NULL,
  customer_document_id BIGINT,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  approved_by BIGINT NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, job_card_id),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_claims(business_id, job_card_id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  FOREIGN KEY (business_id, customer_document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((how = 'billed') = (customer_document_id IS NOT NULL))
);
CREATE TRIGGER garage_claim_settlements_kept BEFORE UPDATE OR DELETE ON garage_claim_settlements FOR EACH ROW EXECUTE FUNCTION garage_kept();

-- --- Service plans by make, model or engine -------------------------------------------------------

CREATE TABLE garage_service_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  make VARCHAR(60) NOT NULL CHECK (btrim(make) <> ''),
  -- A model of the make, an engine of the make, or both.
  model VARCHAR(60) CHECK (btrim(model) <> ''),
  engine_code VARCHAR(30) CHECK (engine_code ~ '^[A-Z0-9-]{2,30}$'),
  -- The next service is due this many kilometres or days after a job, whichever comes first.
  interval_km INTEGER NOT NULL CHECK (interval_km BETWEEN 500 AND 100000),
  interval_days SMALLINT NOT NULL CHECK (interval_days BETWEEN 30 AND 1100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK (model IS NOT NULL OR engine_code IS NOT NULL)
);
CREATE UNIQUE INDEX garage_service_plans_once ON garage_service_plans(business_id, lower(make), lower(COALESCE(model, '')), COALESCE(engine_code, ''));

-- --- Mechanics' commission on labour --------------------------------------------------------------

CREATE TABLE garage_commission_rates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- A labour item's rate (it comes first), or a mechanic's.
  sku_id BIGINT,
  user_id BIGINT REFERENCES users(id),
  percent NUMERIC(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK ((sku_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX garage_commission_rates_item ON garage_commission_rates(business_id, sku_id) WHERE sku_id IS NOT NULL;
CREATE UNIQUE INDEX garage_commission_rates_person ON garage_commission_rates(business_id, user_id) WHERE user_id IS NOT NULL;

-- A rate is for a labour item, a service.
CREATE FUNCTION garage_commission_rates_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sku_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
      WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id AND p.kind = 'service') THEN
    RAISE EXCEPTION 'A commission rate is for a labour item, a service' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER garage_commission_rates_check BEFORE INSERT OR UPDATE ON garage_commission_rates FOR EACH ROW EXECUTE FUNCTION garage_commission_rates_check();

CREATE TABLE garage_commissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  job_card_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  -- The labour billed (before GST), the mechanic's part of it, the rate and what it earned.
  base NUMERIC(16,2) NOT NULL CHECK (base >= 0),
  percent NUMERIC(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  amount NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  earned_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_card_id) REFERENCES garage_job_cards(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES garage_job_card_lines(business_id, id),
  UNIQUE (business_id, line_id, user_id)
);
CREATE INDEX garage_commissions_person ON garage_commissions(business_id, user_id, earned_on);
CREATE TRIGGER garage_commissions_kept BEFORE UPDATE OR DELETE ON garage_commissions FOR EACH ROW EXECUTE FUNCTION garage_kept();

CREATE TABLE garage_commission_payouts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  -- The expense that paid it (the expense book, so the drawer and the day see it).
  expense_id BIGINT NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, expense_id) REFERENCES business_expenses(business_id, id),
  UNIQUE (business_id, expense_id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX garage_commission_payouts_person ON garage_commission_payouts(business_id, user_id, created_at);
CREATE TRIGGER garage_commission_payouts_kept BEFORE UPDATE OR DELETE ON garage_commission_payouts FOR EACH ROW EXECUTE FUNCTION garage_kept();

-- Down Migration
DROP TABLE garage_commission_payouts, garage_commissions, garage_commission_rates, garage_service_plans, garage_claim_settlements, garage_claim_steps,
  garage_gate_passes, garage_road_tests, garage_part_issues, garage_job_card_photos, garage_inspection_items, garage_part_fitments, garage_parts, garage_part_groups;
DROP TRIGGER garage_claims_moved_on ON garage_claims;
DROP FUNCTION garage_claims_moved_on();
DROP FUNCTION garage_commission_rates_check();
DROP FUNCTION garage_claim_steps_check();
DROP FUNCTION garage_gate_passes_guard();
DROP FUNCTION garage_part_issues_check();
DROP FUNCTION garage_job_card_photos_check();
DROP FUNCTION garage_inspection_items_guard();
DROP FUNCTION garage_part_check();
DROP FUNCTION garage_job_card_is_open();
DROP FUNCTION garage_kept();
ALTER TABLE garage_claims DROP CONSTRAINT garage_claims_insurer_named, DROP COLUMN insurer_named, DROP COLUMN intimated_on;
-- Refuses while a version came from a quotation (restore a backup instead).
ALTER TABLE garage_estimate_versions DROP CONSTRAINT garage_estimate_versions_source_check,
  ADD CONSTRAINT garage_estimate_versions_source_check CHECK (source IN ('estimate', 'parts', 'claim'));
DROP INDEX garage_job_cards_quotation;
DROP INDEX garage_job_cards_appointment;
ALTER TABLE garage_job_cards DROP CONSTRAINT garage_job_cards_quotation_fkey, DROP CONSTRAINT garage_job_cards_appointment_fkey,
  DROP COLUMN quotation_id, DROP COLUMN appointment_id;
ALTER TABLE garage_vehicles DROP COLUMN engine_code;
ALTER TABLE garage_job_card_lines DROP CONSTRAINT garage_job_card_lines_old_part, DROP COLUMN old_part;
ALTER TABLE garage_settings DROP COLUMN road_test_required, DROP COLUMN issue_parts;
