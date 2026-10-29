-- Up Migration
-- The rest of the seeds, fertilisers & pesticides shop: what its bills check,
-- what it keeps of its seed lots and stock, its registers, season credit and
-- company schemes.
--
--   crops in groups      a crop belongs to groups (vegetables, fruits, pulses,
--                        cereals and millets, oilseeds, fruits and vegetables
--                        eaten raw): a molecule barred on a group is barred on
--                        each crop in it. The groups and their crops are
--                        platform data; a shop adds its own crops (with their
--                        groups) and other names and groups for the platform's.
--   label-approved crops a pesticide's label names the crops it is approved
--                        for (kept with the item); a crop not on it warns.
--   restricted use       aluminium phosphide, methyl bromide, DDT and the
--                        cypermethrin smoke generator go only to a buyer tagged
--                        as a pest-control operator or a government body (with
--                        their licence or order reference), or with a manager's
--                        override as the shop's setting allows; carbofuran only
--                        as its 3% CG formulation.
--   seed lots            each lot's date of test, germination, physical purity,
--                        tag number and SATHI QR texts; valid for 9 months from
--                        the test, 6 more after each passing retest (every
--                        retest kept). The lot's expiry follows, so the counter
--                        sells it until then.
--   subsidised bags      a farmer's subsidised bags in a month (the business's
--                        own month) against the limit for the location's state
--                        (50 to start with): a warning near it, and a stop or a
--                        manager's override over it, as the shop's setting says.
--   stock kept apart     expired stock segregated, not for sale, and disposed of
--                        (Insecticides Rules 1971, rule 10A); stock seized or
--                        sampled by an inspector, with their reference. Each is
--                        taken out of stock by a core stock adjustment.
--   food or feed         a location marked as also storing or selling food or
--                        feed (rule 10C): an insecticide other than a registered
--                        household one received or kept there warns.
--   registers            Form XIII (insecticides sold to dealers and bulk
--                        consumers), the monthly Form XIV return and the sulphur
--                        buyers' register (rule 10B), worked out from the bills;
--                        returns marked as sent.
--   price history        every price and MRP an item had, and every branch
--                        price, from when it changed (kept by the database for
--                        any screen that changes them): the board of a day gone
--                        by shows that day's prices.
--   season credit        a farmer's credit for a season: its limit, the date it
--                        falls due, its interest on overdue (none, a % a month
--                        after the due date, or a % a month from each bill's
--                        date), a guarantor and the crop pledged. Interest is
--                        worked out to the paisa and billed only when someone
--                        confirms it; produce taken against what is owed pays
--                        the season's bills as a non-cash payment.
--   company schemes      a supplier's scheme for a season (quantity slabs,
--                        target rebates, free goods, gifts): what the purchases
--                        earn, the claims made and received, and what is due.
--   advisory line        a pesticide's dose per acre, safety interval and
--                        protective gear, printed on the bill when the shop
--                        switches it on.

-- --- Permission ---------------------------------------------------------------------------------

INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('agri.approve', 'agri', 'approve', 'Allow restricted-use pesticides and subsidised bags over the limit, set season credit terms and bill its interest', 488);

INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES ('manager', 'agri.approve');

-- Existing businesses' copies of the shared templates (keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code AND tp.permission_code = 'agri.approve'
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

-- --- Crops in groups ---------------------------------------------------------------------------

-- A group is a crop entry a ban or a label can name for all its crops.
ALTER TABLE agri_crops ADD COLUMN is_group BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE agri_crops SET is_group = TRUE WHERE code IN ('vegetables', 'fruits_vegetables_raw');
INSERT INTO agri_crops (code, name, aliases, is_group) VALUES
 ('fruits', 'Fruits', '{fruit}', TRUE), ('pulses', 'Pulses', '{pulse}', TRUE),
 ('cereals', 'Cereals and millets', '{cereal,millet,millets}', TRUE), ('oilseeds', 'Oilseeds', '{oilseed}', TRUE);

-- The platform's crops in its groups.
CREATE TABLE agri_crop_groups (
  crop_code VARCHAR(40) NOT NULL REFERENCES agri_crops(code),
  group_code VARCHAR(40) NOT NULL REFERENCES agri_crops(code),
  PRIMARY KEY (crop_code, group_code),
  CHECK (crop_code <> group_code)
);
INSERT INTO agri_crop_groups (crop_code, group_code) VALUES
 ('ber', 'fruits'), ('citrus', 'fruits'), ('guava', 'fruits'), ('potato', 'vegetables'), ('pea', 'pulses'), ('sorghum', 'cereals'),
 ('soybean', 'oilseeds'), ('castor', 'oilseeds'), ('sunflower', 'oilseeds'), ('groundnut', 'oilseeds');

-- A shop's own crops (a name), or what it adds to one of the platform's (other
-- names its farmers use, more groups). Switched off, never deleted.
CREATE TABLE agri_shop_crops (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  crop_code VARCHAR(40) REFERENCES agri_crops(code),
  name VARCHAR(80) CHECK (btrim(name) <> ''),
  aliases TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(aliases) <= 10),
  groups TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(groups) <= 10),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK ((crop_code IS NULL) <> (name IS NULL))
);
CREATE UNIQUE INDEX agri_shop_crops_platform ON agri_shop_crops(business_id, crop_code) WHERE crop_code IS NOT NULL;
CREATE UNIQUE INDEX agri_shop_crops_name ON agri_shop_crops(business_id, lower(name)) WHERE name IS NOT NULL;

CREATE FUNCTION agri_shop_crops_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A crop is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.crop_code IS DISTINCT FROM OLD.crop_code OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'A crop keeps its name: add the other name to it instead' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.groups) g WHERE NOT EXISTS (SELECT 1 FROM agri_crops c WHERE c.code = g AND c.is_group)) THEN
    RAISE EXCEPTION 'A crop goes only into the groups on the list (vegetables, fruits, pulses and the rest)' USING ERRCODE = '23514';
  END IF;
  IF NEW.crop_code IS NOT NULL AND EXISTS (SELECT 1 FROM agri_crops c WHERE c.code = NEW.crop_code AND c.is_group) THEN
    RAISE EXCEPTION 'A group is not put into another group' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agri_shop_crops_check BEFORE INSERT OR UPDATE OR DELETE ON agri_shop_crops
  FOR EACH ROW EXECUTE FUNCTION agri_shop_crops_check();

-- --- Restricted use: who may buy, and the formulation allowed -----------------------------------

-- users_only: only a pest-control operator or a government body may buy it
-- (users_formulation: only in that formulation); only_formulation: it is
-- sold in that formulation and no other.
ALTER TABLE agri_molecules
  ADD COLUMN users_only BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN users_formulation VARCHAR(40) CHECK (btrim(users_formulation) <> ''),
  ADD COLUMN only_formulation VARCHAR(40) CHECK (btrim(only_formulation) <> ''),
  ADD CONSTRAINT agri_molecules_users_formulation CHECK (users_only OR users_formulation IS NULL);
UPDATE agri_molecules SET users_only = TRUE WHERE code IN ('aluminium_phosphide', 'methyl_bromide', 'ddt');
UPDATE agri_molecules SET users_only = TRUE, users_formulation = 'smoke generator' WHERE code = 'cypermethrin';
UPDATE agri_molecules SET only_formulation = '3% CG' WHERE code = 'carbofuran';

-- An item made of a banned molecule is never kept for sale, nor one of a
-- molecule allowed in one formulation only, in another.
CREATE OR REPLACE FUNCTION agri_item_molecules_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE banned TEXT; limited RECORD;
BEGIN
  IF jsonb_typeof(NEW.attributes -> 'molecules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'An item''s molecules are kept as a list of names' USING ERRCODE = '23514';
  END IF;
  SELECT m.name INTO banned FROM agri_molecules m
  WHERE m.status = 'banned' AND lower(m.name) IN (SELECT lower(btrim(x)) FROM jsonb_array_elements_text(NEW.attributes -> 'molecules') x)
  ORDER BY m.name LIMIT 1;
  IF banned IS NOT NULL THEN
    RAISE EXCEPTION '% is banned in India: an item made of it cannot be kept for sale', banned USING ERRCODE = '23514';
  END IF;
  SELECT m.name, m.only_formulation INTO limited FROM agri_molecules m
  WHERE m.only_formulation IS NOT NULL AND lower(m.name) IN (SELECT lower(btrim(x)) FROM jsonb_array_elements_text(NEW.attributes -> 'molecules') x)
    AND regexp_replace(lower(m.only_formulation), '[^a-z0-9%]', '', 'g') <> regexp_replace(lower(COALESCE(NEW.attributes ->> 'formulation', '')), '[^a-z0-9%]', '', 'g')
  ORDER BY m.name LIMIT 1;
  IF limited.name IS NOT NULL THEN
    RAISE EXCEPTION '% may be kept for sale only as its % formulation', limited.name, limited.only_formulation USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A customer tagged as a pest-control operator or a government body (with
-- their licence or order reference), or as a bulk consumer (for Form XIII).
-- Switched off, never deleted.
CREATE TABLE agri_buyer_tags (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  tag TEXT NOT NULL CHECK (tag IN ('pest_control_operator', 'government', 'bulk_consumer')),
  reference VARCHAR(80) CHECK (btrim(reference) <> ''),
  valid_until DATE,
  notes VARCHAR(300),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id, tag),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CHECK (tag = 'bulk_consumer' OR reference IS NOT NULL)
);
CREATE TRIGGER agri_buyer_tags_customer BEFORE INSERT ON agri_buyer_tags
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

CREATE FUNCTION agri_buyer_tags_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A buyer''s tag is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.tag <> OLD.tag OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A tag stays with the buyer it was given to' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agri_buyer_tags_guard BEFORE UPDATE OR DELETE ON agri_buyer_tags
  FOR EACH ROW EXECUTE FUNCTION agri_buyer_tags_guard();

-- A manager's override, given with their PIN before the bill and used by one
-- bill on the day it was given: a restricted-use pesticide for a buyer not
-- tagged (these items), or a farmer's subsidised bags over the month's limit.
CREATE TABLE agri_overrides (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('restricted_use', 'bag_limit')),
  location_id BIGINT NOT NULL,
  contact_id BIGINT,
  sku_ids BIGINT[] NOT NULL DEFAULT '{}',
  given_on DATE NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  approved_by BIGINT NOT NULL REFERENCES users(id),
  document_id BIGINT,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (kind <> 'bag_limit' OR contact_id IS NOT NULL),
  CHECK (kind <> 'restricted_use' OR cardinality(sku_ids) BETWEEN 1 AND 100)
);
CREATE INDEX agri_overrides_document ON agri_overrides(business_id, document_id) WHERE document_id IS NOT NULL;

CREATE FUNCTION agri_overrides_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A manager''s override is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.document_id IS NOT NULL OR NEW.document_id IS NULL OR (to_jsonb(NEW) - 'document_id') <> (to_jsonb(OLD) - 'document_id') THEN
    RAISE EXCEPTION 'A manager''s override is used once, by one bill, as it was given' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agri_overrides_guard BEFORE UPDATE OR DELETE ON agri_overrides
  FOR EACH ROW EXECUTE FUNCTION agri_overrides_guard();

-- --- Seed lots -----------------------------------------------------------------------------------

-- A seed lot's tag: its date of test, germination and physical purity, the
-- tag number, and its validity (9 months from the test, 6 more after each
-- passing retest). One for each item and lot number, wherever it is held.
CREATE TABLE agri_seed_lots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  lot_code VARCHAR(100) NOT NULL CHECK (btrim(lot_code) <> ''),
  tested_on DATE NOT NULL,
  germination NUMERIC(5,2) NOT NULL CHECK (germination >= 0 AND germination <= 100),
  purity NUMERIC(5,2) NOT NULL CHECK (purity >= 0 AND purity <= 100),
  tag_no VARCHAR(60) CHECK (btrim(tag_no) <> ''),
  valid_until DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku_id, lot_code),
  CHECK (valid_until > tested_on)
);

-- Each retest of a lot, kept as it was entered: passed, it extends the
-- lot's validity by 6 months.
CREATE TABLE agri_seed_retests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  seed_lot_id BIGINT NOT NULL,
  tested_on DATE NOT NULL,
  germination NUMERIC(5,2) NOT NULL CHECK (germination >= 0 AND germination <= 100),
  purity NUMERIC(5,2) NOT NULL CHECK (purity >= 0 AND purity <= 100),
  passed BOOLEAN NOT NULL,
  report_no VARCHAR(60) CHECK (btrim(report_no) <> ''),
  valid_before DATE NOT NULL,
  valid_after DATE NOT NULL,
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, seed_lot_id) REFERENCES agri_seed_lots(business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (passed OR valid_after = valid_before),
  CHECK (NOT passed OR valid_after > valid_before)
);
CREATE INDEX agri_seed_retests_lot ON agri_seed_retests(business_id, seed_lot_id, id);

-- The SATHI QR texts scanned for a lot or its packs. Nothing is filed with them.
CREATE TABLE agri_seed_qr_codes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  seed_lot_id BIGINT NOT NULL,
  qr_text VARCHAR(1000) NOT NULL CHECK (btrim(qr_text) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, seed_lot_id) REFERENCES agri_seed_lots(business_id, id),
  UNIQUE (business_id, qr_text)
);
CREATE INDEX agri_seed_qr_codes_lot ON agri_seed_qr_codes(business_id, seed_lot_id);

-- A lot's tag stays with its item and lot number; its test details are
-- corrected only until it is retested; it is never deleted.
CREATE FUNCTION agri_seed_lots_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A seed lot''s tag is never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.sku_id <> OLD.sku_id OR NEW.lot_code <> OLD.lot_code OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A seed lot''s tag stays with its item and lot number' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tested_on <> OLD.tested_on OR NEW.germination <> OLD.germination OR NEW.purity <> OLD.purity)
     AND EXISTS (SELECT 1 FROM agri_seed_retests r WHERE r.business_id = OLD.business_id AND r.seed_lot_id = OLD.id) THEN
    RAISE EXCEPTION 'A seed lot that has been retested keeps its first test as it was' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agri_seed_lots_guard BEFORE UPDATE OR DELETE ON agri_seed_lots
  FOR EACH ROW EXECUTE FUNCTION agri_seed_lots_guard();

-- --- Stock kept apart -----------------------------------------------------------------------------

-- Stock taken out of saleable stock (a core stock adjustment) and kept apart:
-- expired (segregated, not for sale; closed when disposed of), seized by an
-- inspector (closed when the seizure ends, or released back into stock) or
-- drawn as a sample (closed with what came of it).
CREATE TABLE agri_stock_holds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('expired', 'seized', 'sampled')),
  location_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  lot_id BIGINT NOT NULL,
  lot_code VARCHAR(100) NOT NULL DEFAULT '',
  expires_on DATE,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  held_on DATE NOT NULL,
  officer VARCHAR(150) CHECK (btrim(officer) <> ''),
  officer_reference VARCHAR(80) CHECK (btrim(officer_reference) <> ''),
  notes VARCHAR(300),
  adjustment_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'closed', 'released')),
  closed_on DATE,
  closed_how VARCHAR(300) CHECK (btrim(closed_how) <> ''),
  closed_reference VARCHAR(80) CHECK (btrim(closed_reference) <> ''),
  close_adjustment_id BIGINT,
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, lot_id) REFERENCES business_stock_lots(business_id, id),
  FOREIGN KEY (business_id, adjustment_id) REFERENCES business_stock_adjustments(business_id, id),
  FOREIGN KEY (business_id, close_adjustment_id) REFERENCES business_stock_adjustments(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (kind = 'expired' OR (officer IS NOT NULL AND officer_reference IS NOT NULL)),
  CHECK (status <> 'released' OR (kind = 'seized' AND close_adjustment_id IS NOT NULL)),
  CHECK ((status = 'held') = (closed_on IS NULL)),
  CHECK ((closed_on IS NULL) = (closed_by IS NULL)),
  CHECK (closed_on IS NULL OR closed_how IS NOT NULL),
  CHECK (closed_on IS NULL OR closed_on >= held_on)
);
CREATE INDEX agri_stock_holds_list ON agri_stock_holds(business_id, kind, status, held_on DESC);

CREATE FUNCTION agri_stock_holds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock kept apart is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'held' OR (to_jsonb(NEW) - ARRAY['status', 'closed_on', 'closed_how', 'closed_reference', 'close_adjustment_id', 'closed_by', 'closed_at'])
     <> (to_jsonb(OLD) - ARRAY['status', 'closed_on', 'closed_how', 'closed_reference', 'close_adjustment_id', 'closed_by', 'closed_at']) THEN
    RAISE EXCEPTION 'Stock kept apart keeps what was kept, and is closed once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agri_stock_holds_guard BEFORE UPDATE OR DELETE ON agri_stock_holds
  FOR EACH ROW EXECUTE FUNCTION agri_stock_holds_guard();

-- A location that also stores or sells food or feed (Insecticides Rules 1971, rule 10C).
CREATE TABLE agri_food_locations (
  business_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  set_by BIGINT NOT NULL REFERENCES users(id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, location_id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id)
);

-- --- The shop's settings ------------------------------------------------------------------------

-- restricted_use, bag_limit_mode: a stop, or a manager's override allowed;
-- interest_sku_id: the service item interest on season credit is billed as
-- (its own GST slab); advisory_on: the advisory line printed on bills.
ALTER TABLE agri_settings
  ADD COLUMN restricted_use TEXT NOT NULL DEFAULT 'block' CHECK (restricted_use IN ('block', 'override')),
  ADD COLUMN bag_limit_mode TEXT NOT NULL DEFAULT 'block' CHECK (bag_limit_mode IN ('block', 'override')),
  ADD COLUMN interest_sku_id BIGINT,
  ADD COLUMN advisory_on BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT agri_settings_interest_sku FOREIGN KEY (business_id, interest_sku_id) REFERENCES catalog_skus(business_id, id);

-- A farmer's subsidised bags allowed in a month, for each state the shop's
-- locations are in; a state without a row allows 50.
CREATE TABLE agri_bag_limits (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  state_code CHAR(2) NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
  bags_per_month INTEGER NOT NULL CHECK (bags_per_month BETWEEN 1 AND 10000),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, state_code)
);

-- --- Season credit --------------------------------------------------------------------------------

-- A farmer's credit for one season: its limit (none: no limit of its own),
-- the date its bills fall due, its interest on overdue (none; after_due: a %
-- a month on what is owed after the due date; from_bill: a % a month on what
-- is owed from each bill's date), a guarantor and the crop pledged. Its bills
-- carry it (agri_bills). Closed, it takes no new bills; never deleted.
CREATE TABLE agri_season_credits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  season TEXT NOT NULL CHECK (season IN ('kharif', 'rabi', 'zaid')),
  season_year SMALLINT NOT NULL CHECK (season_year BETWEEN 2000 AND 2100),
  due_on DATE NOT NULL,
  credit_limit NUMERIC(14,2) CHECK (credit_limit > 0),
  interest TEXT NOT NULL DEFAULT 'none' CHECK (interest IN ('none', 'after_due', 'from_bill')),
  interest_rate NUMERIC(5,2) CHECK (interest_rate > 0 AND interest_rate <= 10),
  guarantor_name VARCHAR(150) CHECK (btrim(guarantor_name) <> ''),
  guarantor_phone VARCHAR(30),
  guarantor_address VARCHAR(300),
  crop_pledged VARCHAR(200),
  notes VARCHAR(300),
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, contact_id, season, season_year),
  CHECK ((interest = 'none') = (interest_rate IS NULL)),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);
CREATE TRIGGER agri_season_credits_customer BEFORE INSERT ON agri_season_credits
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A bill's farm-input details also keep the season's credit it is on, the
-- buyer's tags when billed and the manager's override for the bag limit.
ALTER TABLE agri_bills
  ADD COLUMN season_credit_id BIGINT,
  ADD COLUMN buyer_tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN bag_override_id BIGINT,
  ADD CONSTRAINT agri_bills_season_credit FOREIGN KEY (business_id, season_credit_id) REFERENCES agri_season_credits(business_id, id),
  ADD CONSTRAINT agri_bills_bag_override FOREIGN KEY (business_id, bag_override_id) REFERENCES agri_overrides(business_id, id),
  ADD CONSTRAINT agri_bills_season_credit_season CHECK (season_credit_id IS NULL OR season IS NOT NULL);
CREATE INDEX agri_bills_season_credit ON agri_bills(business_id, season_credit_id) WHERE season_credit_id IS NOT NULL;
-- A row keeps something: a season, a walk-in farmer, the buyer's tags or an override.
DO $$
DECLARE named TEXT;
BEGIN
  SELECT conname INTO named FROM pg_constraint WHERE conrelid = 'agri_bills'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%buyer_name IS NOT NULL%';
  EXECUTE format('ALTER TABLE agri_bills DROP CONSTRAINT %I', named);
END $$;
ALTER TABLE agri_bills ADD CONSTRAINT agri_bills_keeps_something
  CHECK (season IS NOT NULL OR buyer_name IS NOT NULL OR village IS NOT NULL OR cardinality(buyer_tags) > 0 OR bag_override_id IS NOT NULL);

-- A season goes on a named customer's sale, on that customer's credit for
-- that season; a walk-in's name and village on a walk-in's.
CREATE OR REPLACE FUNCTION agri_bills_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc RECORD; account RECORD;
BEGIN
  SELECT kind, contact_id INTO doc FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN
    RAISE EXCEPTION 'A season and a farmer go on a sale' USING ERRCODE = '23514';
  END IF;
  IF NEW.season IS NOT NULL AND doc.contact_id IS NULL THEN
    RAISE EXCEPTION 'Season credit is for a named customer: choose the farmer first' USING ERRCODE = '23514';
  END IF;
  IF (NEW.buyer_name IS NOT NULL OR NEW.village IS NOT NULL) AND doc.contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'A named customer''s village is kept with their farmer details' USING ERRCODE = '23514';
  END IF;
  IF NEW.season_credit_id IS NOT NULL THEN
    SELECT contact_id, season, season_year INTO account FROM agri_season_credits WHERE business_id = NEW.business_id AND id = NEW.season_credit_id;
    IF account.contact_id IS DISTINCT FROM doc.contact_id OR account.season IS DISTINCT FROM NEW.season OR account.season_year IS DISTINCT FROM NEW.season_year THEN
      RAISE EXCEPTION 'A bill goes on its own customer''s credit for its season' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A season's credit stays with its farmer and season; its due date and
-- interest are fixed once a bill is on it.
CREATE FUNCTION agri_season_credits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A season''s credit is never deleted; close it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.season <> OLD.season OR NEW.season_year <> OLD.season_year
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A season''s credit stays with its farmer and its season' USING ERRCODE = '23514';
  END IF;
  IF (NEW.due_on <> OLD.due_on OR NEW.interest <> OLD.interest OR NEW.interest_rate IS DISTINCT FROM OLD.interest_rate)
     AND EXISTS (SELECT 1 FROM agri_bills b WHERE b.business_id = OLD.business_id AND b.season_credit_id = OLD.id) THEN
    RAISE EXCEPTION 'A season''s due date and interest are fixed once a bill is on it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agri_season_credits_guard BEFORE UPDATE OR DELETE ON agri_season_credits
  FOR EACH ROW EXECUTE FUNCTION agri_season_credits_guard();

-- Interest billed on a season's credit: the bill (a charge through the core),
-- the day it was worked out to, the amount and the workings bill by bill.
CREATE TABLE agri_season_interest (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  season_credit_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  worked_to DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  workings JSONB NOT NULL CHECK (jsonb_typeof(workings) = 'array'),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, season_credit_id) REFERENCES agri_season_credits(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX agri_season_interest_credit ON agri_season_interest(business_id, season_credit_id);

-- Produce taken from a farmer against what they owe on a season: the crop,
-- quantity, rate and value; its value pays the season's bills as non-cash
-- payments (agri_produce_payments). Never changed.
CREATE TABLE agri_produce_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  receipt_no INTEGER NOT NULL CHECK (receipt_no > 0),
  season_credit_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  crop VARCHAR(100) NOT NULL CHECK (btrim(crop) <> ''),
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL CHECK (unit IN ('quintal', 'kg', 'bag', 'tonne')),
  rate NUMERIC(14,2) NOT NULL CHECK (rate > 0),
  value NUMERIC(14,2) NOT NULL CHECK (value > 0),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, season_credit_id) REFERENCES agri_season_credits(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, receipt_no),
  UNIQUE (business_id, request_key),
  CHECK (value = round(quantity * rate, 2))
);
CREATE TABLE agri_produce_payments (
  business_id BIGINT NOT NULL,
  receipt_id BIGINT NOT NULL,
  payment_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (business_id, payment_id),
  FOREIGN KEY (business_id, receipt_id) REFERENCES agri_produce_receipts(business_id, id),
  FOREIGN KEY (business_id, payment_id) REFERENCES business_payments(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id)
);
CREATE INDEX agri_produce_payments_receipt ON agri_produce_payments(business_id, receipt_id);

-- --- Company schemes --------------------------------------------------------------------------------

-- A supplier's scheme for a season: the items it counts, its dates, and what
-- reaching each quantity earns (agri_scheme_benefits); claims made on it and
-- what came back (agri_scheme_claims). Switched off, never deleted.
CREATE TABLE agri_schemes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  season TEXT NOT NULL CHECK (season IN ('kharif', 'rabi', 'zaid')),
  season_year SMALLINT NOT NULL CHECK (season_year BETWEEN 2000 AND 2100),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  notes VARCHAR(500),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  CHECK (ends_on >= starts_on)
);
CREATE TRIGGER agri_schemes_supplier BEFORE INSERT OR UPDATE OF contact_id ON agri_schemes
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_supplier();

CREATE TABLE agri_scheme_items (
  business_id BIGINT NOT NULL,
  scheme_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  PRIMARY KEY (business_id, scheme_id, sku_id),
  FOREIGN KEY (business_id, scheme_id) REFERENCES agri_schemes(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);

-- What reaching a quantity earns: per_unit (a rebate on every unit bought,
-- the highest slab reached), target (an amount), free_goods (an item and
-- quantity) or a gift. Of each kind, the highest reached counts.
CREATE TABLE agri_scheme_benefits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  scheme_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('per_unit', 'target', 'free_goods', 'gift')),
  min_quantity NUMERIC(16,3) NOT NULL CHECK (min_quantity >= 0),
  rate NUMERIC(14,2) CHECK (rate > 0),
  amount NUMERIC(14,2) CHECK (amount > 0),
  free_sku_id BIGINT,
  free_quantity NUMERIC(16,3) CHECK (free_quantity > 0),
  gift VARCHAR(150) CHECK (btrim(gift) <> ''),
  FOREIGN KEY (business_id, scheme_id) REFERENCES agri_schemes(business_id, id),
  FOREIGN KEY (business_id, free_sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, scheme_id, kind, min_quantity),
  CHECK ((kind = 'per_unit') = (rate IS NOT NULL)),
  CHECK ((kind = 'target') = (amount IS NOT NULL)),
  CHECK ((kind = 'free_goods') = (free_sku_id IS NOT NULL AND free_quantity IS NOT NULL)),
  CHECK ((kind = 'free_goods') OR (free_sku_id IS NULL AND free_quantity IS NULL)),
  CHECK ((kind = 'gift') = (gift IS NOT NULL))
);

-- A claim made on a scheme (money, free goods or a gift) and what came back.
CREATE TABLE agri_scheme_claims (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  scheme_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('money', 'free_goods', 'gift')),
  claimed_on DATE NOT NULL,
  reference VARCHAR(80) CHECK (btrim(reference) <> ''),
  amount NUMERIC(14,2) CHECK (amount > 0),
  quantity NUMERIC(16,3) CHECK (quantity > 0),
  description VARCHAR(300),
  received_on DATE,
  received_amount NUMERIC(14,2) CHECK (received_amount >= 0),
  received_quantity NUMERIC(16,3) CHECK (received_quantity >= 0),
  received_reference VARCHAR(80) CHECK (btrim(received_reference) <> ''),
  received_note VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by BIGINT REFERENCES users(id),
  received_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, scheme_id) REFERENCES agri_schemes(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((kind = 'money') = (amount IS NOT NULL)),
  CHECK ((kind = 'free_goods') = (quantity IS NOT NULL)),
  CHECK (received_amount IS NULL OR kind = 'money'),
  CHECK (received_quantity IS NULL OR kind = 'free_goods'),
  CHECK ((received_on IS NULL) = (received_at IS NULL)),
  CHECK ((received_on IS NULL) = (received_by IS NULL)),
  CHECK (received_on IS NULL OR received_on >= claimed_on)
);
CREATE INDEX agri_scheme_claims_scheme ON agri_scheme_claims(business_id, scheme_id);

-- A scheme is switched off, never deleted, and keeps its supplier; a claim
-- is never deleted, and what came back on it is recorded once.
CREATE FUNCTION agri_schemes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A scheme and its claims are never deleted; switch the scheme off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'agri_schemes' THEN
    IF NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A scheme stays with its supplier' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.received_on IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['received_on', 'received_amount', 'received_quantity', 'received_reference', 'received_note', 'received_by', 'received_at'])
        <> (to_jsonb(OLD) - ARRAY['received_on', 'received_amount', 'received_quantity', 'received_reference', 'received_note', 'received_by', 'received_at']) THEN
    RAISE EXCEPTION 'A claim keeps what was claimed, and what came back is recorded once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agri_schemes_guard BEFORE UPDATE OR DELETE ON agri_schemes
  FOR EACH ROW EXECUTE FUNCTION agri_schemes_guard();
CREATE TRIGGER agri_scheme_claims_guard BEFORE UPDATE OR DELETE ON agri_scheme_claims
  FOR EACH ROW EXECUTE FUNCTION agri_schemes_guard();

-- --- Returns sent -----------------------------------------------------------------------------------

-- A monthly return marked as sent for a location: Form XIV (insecticides, by
-- the 15th) or Form D (the seed stock return, by the 5th).
CREATE TABLE agri_returns_filed (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  form TEXT NOT NULL CHECK (form IN ('form_xiv', 'form_d')),
  location_id BIGINT NOT NULL,
  month_start DATE NOT NULL CHECK (extract(day FROM month_start) = 1),
  filed_on DATE NOT NULL CHECK (filed_on >= month_start),
  reference VARCHAR(80) CHECK (btrim(reference) <> ''),
  notes VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, form, location_id, month_start)
);

-- --- What the bills keep ----------------------------------------------------------------------------

-- Each farm-input line also keeps: the shop's own crop it matched, the
-- item's formulation, whether its crop is off the label, who a restricted-use
-- pesticide went to (a tagged buyer, or a manager's override) and the
-- advisory line printed with it.
ALTER TABLE agri_sale_lines
  ADD COLUMN shop_crop_id BIGINT,
  ADD COLUMN formulation VARCHAR(40),
  ADD COLUMN off_label BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN restricted_by TEXT CHECK (restricted_by IN ('pest_control_operator', 'government', 'override')),
  ADD COLUMN override_id BIGINT,
  ADD COLUMN advisory VARCHAR(400),
  ADD CONSTRAINT agri_sale_lines_shop_crop FOREIGN KEY (business_id, shop_crop_id) REFERENCES agri_shop_crops(business_id, id),
  ADD CONSTRAINT agri_sale_lines_override FOREIGN KEY (business_id, override_id) REFERENCES agri_overrides(business_id, id),
  ADD CONSTRAINT agri_sale_lines_one_crop CHECK (crop_code IS NULL OR shop_crop_id IS NULL),
  ADD CONSTRAINT agri_sale_lines_shop_crop_said CHECK (shop_crop_id IS NULL OR crop IS NOT NULL),
  ADD CONSTRAINT agri_sale_lines_override_given CHECK ((restricted_by = 'override') = (override_id IS NOT NULL));

-- The rules again where the line is kept: no banned molecule; no molecule
-- barred on the crop or a group it is in; the one formulation allowed; a
-- restricted-use pesticide only to a buyer tagged in force or on a manager's
-- override that covers it; a licence in force covering the line at the
-- selling location on the day, for the kind of sale (while Licences &
-- registrations is on); no seed lot past its validity. Never changed.
CREATE OR REPLACE FUNCTION agri_sale_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc RECORD; banned TEXT; pair RECORD; lot RECORD; category TEXT; trade TEXT; in_groups TEXT[]; formula TEXT; limited RECORD; given RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A farm-input bill line is kept as it was billed' USING ERRCODE = '23514';
  END IF;
  SELECT d.kind, d.location_id, d.document_no, d.buyer_gstin, d.contact_id, (d.created_at AT TIME ZONE b.timezone)::date AS day INTO doc
  FROM business_documents d JOIN businesses b ON b.id = d.business_id WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN
    RAISE EXCEPTION 'Farm-input details go on a sale' USING ERRCODE = '23514';
  END IF;
  SELECT m.name INTO banned FROM agri_molecules m
  WHERE m.status = 'banned' AND lower(m.name) IN (SELECT lower(btrim(x)) FROM unnest(NEW.molecules) x) ORDER BY m.name LIMIT 1;
  IF banned IS NOT NULL THEN
    RAISE EXCEPTION '% is banned in India: an item made of it is never sold', banned USING ERRCODE = '23514';
  END IF;
  IF NEW.crop_code IS NOT NULL OR NEW.shop_crop_id IS NOT NULL THEN
    -- The crop's groups: the platform's, and those the shop added.
    in_groups := ARRAY(SELECT g.group_code FROM agri_crop_groups g WHERE g.crop_code = NEW.crop_code
      UNION SELECT unnest(s.groups) FROM agri_shop_crops s WHERE s.business_id = NEW.business_id AND s.active
        AND (s.crop_code = NEW.crop_code OR s.id = NEW.shop_crop_id));
    SELECT m.name, c.name AS crop INTO pair FROM agri_molecule_crops mc
    JOIN agri_molecules m ON m.code = mc.molecule_code JOIN agri_crops c ON c.code = mc.crop_code
    WHERE (mc.crop_code = NEW.crop_code OR mc.crop_code = ANY (in_groups))
      AND lower(m.name) IN (SELECT lower(btrim(x)) FROM unnest(NEW.molecules) x) ORDER BY m.name LIMIT 1;
    IF pair.name IS NOT NULL THEN
      RAISE EXCEPTION '% must not be used on %: it is not sold for that crop', pair.name, lower(pair.crop) USING ERRCODE = '23514';
    END IF;
  END IF;
  formula := regexp_replace(lower(COALESCE(NEW.formulation, '')), '[^a-z0-9%]', '', 'g');
  SELECT m.name, m.only_formulation INTO limited FROM agri_molecules m
  WHERE m.only_formulation IS NOT NULL AND lower(m.name) IN (SELECT lower(btrim(x)) FROM unnest(NEW.molecules) x)
    AND regexp_replace(lower(m.only_formulation), '[^a-z0-9%]', '', 'g') <> formula ORDER BY m.name LIMIT 1;
  IF limited.name IS NOT NULL THEN
    RAISE EXCEPTION '% is sold only as its % formulation', limited.name, limited.only_formulation USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM agri_molecules m WHERE m.users_only AND lower(m.name) IN (SELECT lower(btrim(x)) FROM unnest(NEW.molecules) x)
      AND (m.users_formulation IS NULL OR position(regexp_replace(lower(m.users_formulation), '[^a-z0-9%]', '', 'g') IN formula) > 0)) THEN
    IF NEW.restricted_by IS NULL THEN
      RAISE EXCEPTION 'A restricted-use pesticide goes only to a pest-control operator or a government body, or on a manager''s override: % names neither', doc.document_no
        USING ERRCODE = '23514';
    ELSIF NEW.restricted_by = 'override' THEN
      SELECT o.kind, o.given_on, o.location_id, o.contact_id, o.sku_ids INTO given FROM agri_overrides o WHERE o.business_id = NEW.business_id AND o.id = NEW.override_id;
      IF given.kind IS DISTINCT FROM 'restricted_use' OR given.given_on <> doc.day OR given.location_id <> doc.location_id
         OR (given.contact_id IS NOT NULL AND given.contact_id IS DISTINCT FROM doc.contact_id) OR NOT (NEW.sku_id = ANY (given.sku_ids)) THEN
        RAISE EXCEPTION 'The manager''s override on % does not cover this pesticide', doc.document_no USING ERRCODE = '23514';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM agri_buyer_tags t WHERE t.business_id = NEW.business_id AND t.contact_id = doc.contact_id AND t.tag = NEW.restricted_by
        AND t.active AND (t.valid_until IS NULL OR t.valid_until >= doc.day)) THEN
      RAISE EXCEPTION 'The buyer on % is not tagged as a % in force', doc.document_no, replace(NEW.restricted_by, '_', ' ') USING ERRCODE = '23514';
    END IF;
  END IF;
  category := CASE NEW.input_kind WHEN 'fertiliser' THEN 'fertiliser' WHEN 'seed' THEN 'seed' WHEN 'pesticide' THEN 'insecticide' END;
  trade := CASE WHEN doc.buyer_gstin IS NULL THEN 'retail' ELSE 'wholesale' END;
  IF category IS NOT NULL AND EXISTS (SELECT 1 FROM business_capabilities WHERE business_id = NEW.business_id AND capability = 'licences')
     AND NOT business_licence_covering(NEW.business_id, doc.location_id, category, doc.day, trade) THEN
    RAISE EXCEPTION 'This location holds no % licence in force on %, so % cannot bill it%', category, to_char(doc.day, 'DD Mon YYYY'), doc.document_no,
      CASE WHEN trade = 'wholesale' THEN ' as a wholesale sale (a B2B invoice): the licence must be for wholesale sales' ELSE '' END
      USING ERRCODE = '23514';
  END IF;
  IF NEW.input_kind = 'seed' THEN
    SELECT l.lot_code, l.expires_on INTO lot FROM business_document_lines dl
    JOIN business_stock_lots l ON l.business_id = dl.business_id AND l.location_id = doc.location_id AND l.sku_id = dl.sku_id AND l.lot_code = dl.lot_code
    WHERE dl.business_id = NEW.business_id AND dl.id = NEW.line_id;
    IF lot.expires_on IS NOT NULL AND lot.expires_on < doc.day THEN
      RAISE EXCEPTION 'Seed lot % was valid until %: it is never sold after that', lot.lot_code, to_char(lot.expires_on, 'DD Mon YYYY') USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- --- Records kept as they were made --------------------------------------------------------------------

CREATE FUNCTION agri_records_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', CASE TG_TABLE_NAME
    WHEN 'agri_seed_retests' THEN 'A seed lot''s retest is kept as it was entered'
    WHEN 'agri_seed_qr_codes' THEN 'A scanned QR text is kept as it was scanned'
    WHEN 'agri_season_interest' THEN 'Interest billed on season credit is kept as it was worked out'
    WHEN 'agri_produce_receipts' THEN 'Produce taken against dues is kept as it was taken'
    WHEN 'agri_produce_payments' THEN 'Produce taken against dues is kept as it was taken'
    ELSE 'A return marked as sent is kept as it was marked' END
    USING ERRCODE = '23514';
END $$;
CREATE TRIGGER agri_seed_retests_fixed BEFORE UPDATE OR DELETE ON agri_seed_retests FOR EACH ROW EXECUTE FUNCTION agri_records_fixed();
CREATE TRIGGER agri_seed_qr_codes_fixed BEFORE UPDATE OR DELETE ON agri_seed_qr_codes FOR EACH ROW EXECUTE FUNCTION agri_records_fixed();
CREATE TRIGGER agri_season_interest_fixed BEFORE UPDATE OR DELETE ON agri_season_interest FOR EACH ROW EXECUTE FUNCTION agri_records_fixed();
CREATE TRIGGER agri_produce_receipts_fixed BEFORE UPDATE OR DELETE ON agri_produce_receipts FOR EACH ROW EXECUTE FUNCTION agri_records_fixed();
CREATE TRIGGER agri_produce_payments_fixed BEFORE UPDATE OR DELETE ON agri_produce_payments FOR EACH ROW EXECUTE FUNCTION agri_records_fixed();
CREATE TRIGGER agri_returns_filed_fixed BEFORE UPDATE OR DELETE ON agri_returns_filed FOR EACH ROW EXECUTE FUNCTION agri_records_fixed();

-- --- Price history --------------------------------------------------------------------------------

-- Every selling price and MRP an item had (location NULL), and every price a
-- branch set for it (price NULL: back to the item's own), from when it
-- changed. Kept by the triggers below, whichever screen changes a price.
CREATE TABLE business_price_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  location_id BIGINT,
  price NUMERIC(14,2),
  mrp NUMERIC(14,2),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CHECK (location_id IS NOT NULL OR price IS NOT NULL),
  CHECK (location_id IS NULL OR mrp IS NULL)
);
CREATE INDEX business_price_history_sku ON business_price_history(business_id, sku_id, location_id, changed_at DESC, id DESC);

-- What the items cost now, from when each was made; each branch price from when it was set.
INSERT INTO business_price_history (business_id, sku_id, location_id, price, mrp, changed_at)
SELECT business_id, id, NULL, price, mrp, created_at FROM catalog_skus;
INSERT INTO business_price_history (business_id, sku_id, location_id, price, changed_at)
SELECT business_id, sku_id, location_id, price, updated_at FROM business_sku_location_prices;

CREATE FUNCTION business_price_history_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.price IS NOT DISTINCT FROM OLD.price AND NEW.mrp IS NOT DISTINCT FROM OLD.mrp THEN
    RETURN NULL;
  END IF;
  INSERT INTO business_price_history (business_id, sku_id, location_id, price, mrp) VALUES (NEW.business_id, NEW.id, NULL, NEW.price, NEW.mrp);
  RETURN NULL;
END $$;
CREATE TRIGGER catalog_skus_price_history AFTER INSERT OR UPDATE OF price, mrp ON catalog_skus
  FOR EACH ROW EXECUTE FUNCTION business_price_history_item();

CREATE FUNCTION business_price_history_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO business_price_history (business_id, sku_id, location_id, price) VALUES (OLD.business_id, OLD.sku_id, OLD.location_id, NULL);
  ELSIF TG_OP = 'INSERT' OR NEW.price IS DISTINCT FROM OLD.price THEN
    INSERT INTO business_price_history (business_id, sku_id, location_id, price) VALUES (NEW.business_id, NEW.sku_id, NEW.location_id, NEW.price);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER business_sku_location_prices_history AFTER INSERT OR UPDATE OF price OR DELETE ON business_sku_location_prices
  FOR EACH ROW EXECUTE FUNCTION business_price_history_branch();

CREATE FUNCTION business_price_history_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A price kept in the history is never changed' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_price_history_fixed BEFORE UPDATE OR DELETE ON business_price_history
  FOR EACH ROW EXECUTE FUNCTION business_price_history_fixed();

-- Down Migration
DROP TRIGGER business_price_history_fixed ON business_price_history;
DROP FUNCTION business_price_history_fixed();
DROP TRIGGER business_sku_location_prices_history ON business_sku_location_prices;
DROP FUNCTION business_price_history_branch();
DROP TRIGGER catalog_skus_price_history ON catalog_skus;
DROP FUNCTION business_price_history_item();
DROP TABLE business_price_history;
CREATE OR REPLACE FUNCTION agri_sale_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc RECORD; banned TEXT; pair RECORD; lot RECORD; category TEXT; trade TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A farm-input bill line is kept as it was billed' USING ERRCODE = '23514';
  END IF;
  SELECT d.kind, d.location_id, d.document_no, d.buyer_gstin, (d.created_at AT TIME ZONE b.timezone)::date AS day INTO doc
  FROM business_documents d JOIN businesses b ON b.id = d.business_id WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN
    RAISE EXCEPTION 'Farm-input details go on a sale' USING ERRCODE = '23514';
  END IF;
  SELECT m.name INTO banned FROM agri_molecules m
  WHERE m.status = 'banned' AND lower(m.name) IN (SELECT lower(btrim(x)) FROM unnest(NEW.molecules) x) ORDER BY m.name LIMIT 1;
  IF banned IS NOT NULL THEN
    RAISE EXCEPTION '% is banned in India: an item made of it is never sold', banned USING ERRCODE = '23514';
  END IF;
  IF NEW.crop_code IS NOT NULL THEN
    SELECT m.name, c.name AS crop INTO pair FROM agri_molecule_crops mc
    JOIN agri_molecules m ON m.code = mc.molecule_code JOIN agri_crops c ON c.code = mc.crop_code
    WHERE mc.crop_code = NEW.crop_code AND lower(m.name) IN (SELECT lower(btrim(x)) FROM unnest(NEW.molecules) x) ORDER BY m.name LIMIT 1;
    IF pair.name IS NOT NULL THEN
      RAISE EXCEPTION '% must not be used on %: it is not sold for that crop', pair.name, lower(pair.crop) USING ERRCODE = '23514';
    END IF;
  END IF;
  category := CASE NEW.input_kind WHEN 'fertiliser' THEN 'fertiliser' WHEN 'seed' THEN 'seed' WHEN 'pesticide' THEN 'insecticide' END;
  trade := CASE WHEN doc.buyer_gstin IS NULL THEN 'retail' ELSE 'wholesale' END;
  IF category IS NOT NULL AND EXISTS (SELECT 1 FROM business_capabilities WHERE business_id = NEW.business_id AND capability = 'licences')
     AND NOT business_licence_covering(NEW.business_id, doc.location_id, category, doc.day, trade) THEN
    RAISE EXCEPTION 'This location holds no % licence in force on %, so % cannot bill it%', category, to_char(doc.day, 'DD Mon YYYY'), doc.document_no,
      CASE WHEN trade = 'wholesale' THEN ' as a wholesale sale (a B2B invoice): the licence must be for wholesale sales' ELSE '' END
      USING ERRCODE = '23514';
  END IF;
  IF NEW.input_kind = 'seed' THEN
    SELECT l.lot_code, l.expires_on INTO lot FROM business_document_lines dl
    JOIN business_stock_lots l ON l.business_id = dl.business_id AND l.location_id = doc.location_id AND l.sku_id = dl.sku_id AND l.lot_code = dl.lot_code
    WHERE dl.business_id = NEW.business_id AND dl.id = NEW.line_id;
    IF lot.expires_on IS NOT NULL AND lot.expires_on < doc.day THEN
      RAISE EXCEPTION 'Seed lot % was valid until %: it is never sold after that', lot.lot_code, to_char(lot.expires_on, 'DD Mon YYYY') USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE agri_sale_lines DROP CONSTRAINT agri_sale_lines_override_given, DROP CONSTRAINT agri_sale_lines_shop_crop_said, DROP CONSTRAINT agri_sale_lines_one_crop,
  DROP CONSTRAINT agri_sale_lines_override, DROP CONSTRAINT agri_sale_lines_shop_crop,
  DROP COLUMN advisory, DROP COLUMN override_id, DROP COLUMN restricted_by, DROP COLUMN off_label, DROP COLUMN formulation, DROP COLUMN shop_crop_id;
DROP TRIGGER agri_returns_filed_fixed ON agri_returns_filed;
DROP TRIGGER agri_produce_payments_fixed ON agri_produce_payments;
DROP TRIGGER agri_produce_receipts_fixed ON agri_produce_receipts;
DROP TRIGGER agri_season_interest_fixed ON agri_season_interest;
DROP TRIGGER agri_seed_qr_codes_fixed ON agri_seed_qr_codes;
DROP TRIGGER agri_seed_retests_fixed ON agri_seed_retests;
DROP FUNCTION agri_records_fixed();
DROP TABLE agri_returns_filed;
DROP TRIGGER agri_scheme_claims_guard ON agri_scheme_claims;
DROP TRIGGER agri_schemes_guard ON agri_schemes;
DROP FUNCTION agri_schemes_guard();
DROP TABLE agri_scheme_claims, agri_scheme_benefits, agri_scheme_items, agri_schemes;
DROP TABLE agri_produce_payments, agri_produce_receipts, agri_season_interest;
DROP TRIGGER agri_season_credits_guard ON agri_season_credits;
DROP FUNCTION agri_season_credits_guard();
CREATE OR REPLACE FUNCTION agri_bills_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc RECORD;
BEGIN
  SELECT kind, contact_id INTO doc FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN
    RAISE EXCEPTION 'A season and a farmer go on a sale' USING ERRCODE = '23514';
  END IF;
  IF NEW.season IS NOT NULL AND doc.contact_id IS NULL THEN
    RAISE EXCEPTION 'Season credit is for a named customer: choose the farmer first' USING ERRCODE = '23514';
  END IF;
  IF (NEW.buyer_name IS NOT NULL OR NEW.village IS NOT NULL) AND doc.contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'A named customer''s village is kept with their farmer details' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE agri_bills DROP CONSTRAINT agri_bills_keeps_something;
ALTER TABLE agri_bills ADD CHECK (season IS NOT NULL OR buyer_name IS NOT NULL OR village IS NOT NULL);
DROP INDEX agri_bills_season_credit;
ALTER TABLE agri_bills DROP CONSTRAINT agri_bills_season_credit_season, DROP CONSTRAINT agri_bills_bag_override, DROP CONSTRAINT agri_bills_season_credit,
  DROP COLUMN bag_override_id, DROP COLUMN buyer_tags, DROP COLUMN season_credit_id;
DROP TABLE agri_season_credits;
DROP TABLE agri_bag_limits;
ALTER TABLE agri_settings DROP CONSTRAINT agri_settings_interest_sku,
  DROP COLUMN advisory_on, DROP COLUMN interest_sku_id, DROP COLUMN bag_limit_mode, DROP COLUMN restricted_use;
DROP TABLE agri_food_locations;
DROP TRIGGER agri_stock_holds_guard ON agri_stock_holds;
DROP FUNCTION agri_stock_holds_guard();
DROP TABLE agri_stock_holds;
DROP TRIGGER agri_seed_lots_guard ON agri_seed_lots;
DROP FUNCTION agri_seed_lots_guard();
DROP TABLE agri_seed_qr_codes, agri_seed_retests, agri_seed_lots;
DROP TRIGGER agri_overrides_guard ON agri_overrides;
DROP FUNCTION agri_overrides_guard();
DROP TABLE agri_overrides;
DROP TRIGGER agri_buyer_tags_guard ON agri_buyer_tags;
DROP FUNCTION agri_buyer_tags_guard();
DROP TABLE agri_buyer_tags;
CREATE OR REPLACE FUNCTION agri_item_molecules_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE banned TEXT;
BEGIN
  IF jsonb_typeof(NEW.attributes -> 'molecules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'An item''s molecules are kept as a list of names' USING ERRCODE = '23514';
  END IF;
  SELECT m.name INTO banned FROM agri_molecules m
  WHERE m.status = 'banned' AND lower(m.name) IN (SELECT lower(btrim(x)) FROM jsonb_array_elements_text(NEW.attributes -> 'molecules') x)
  ORDER BY m.name LIMIT 1;
  IF banned IS NOT NULL THEN
    RAISE EXCEPTION '% is banned in India: an item made of it cannot be kept for sale', banned USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE agri_molecules DROP CONSTRAINT agri_molecules_users_formulation,
  DROP COLUMN only_formulation, DROP COLUMN users_formulation, DROP COLUMN users_only;
DROP TRIGGER agri_shop_crops_check ON agri_shop_crops;
DROP FUNCTION agri_shop_crops_check();
DROP TABLE agri_shop_crops;
DROP TABLE agri_crop_groups;
DELETE FROM agri_crops WHERE code IN ('fruits', 'pulses', 'cereals', 'oilseeds');
ALTER TABLE agri_crops DROP COLUMN is_group;
DELETE FROM business_role_permissions WHERE permission_code = 'agri.approve';
DELETE FROM business_role_template_permissions WHERE permission_code = 'agri.approve';
DELETE FROM business_permissions WHERE code = 'agri.approve';
