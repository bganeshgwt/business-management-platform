-- Up Migration
-- Licences for every kind of business, and the seeds, fertilisers and
-- pesticides shop's own tools.
--
-- Licences & registrations (shared module "licences": every type but a
-- restaurant; on for a seeds, fertilisers & pesticides shop, off elsewhere
-- and recommended where the trade must hold one). Each location keeps the
-- licences it holds: what kind it is (a short code), its name as issued, its
-- number, the issuing authority, the dates it is valid from and until (none:
-- it does not expire), the product categories it covers (a farm-input shop's
-- fertiliser, seed and insecticide licences) and notes. A licence is changed
-- or switched off, never deleted, and stays with its location. The bell warns
-- 60 days before one runs out and again once it has.
--
-- Seeds, fertilisers & pesticides (module "agri", on for type "agri_inputs"):
--   item classification   what kind of farm input an item is, kept with the
--                         item's details: fertiliser (and whether it is
--                         subsidised), seed (class, crop, variety), pesticide
--                         (its active molecules and formulation), bio-input
--                         or other; and the weight of one unit
--   checks on every bill  a fertiliser, seed or pesticide line needs a valid
--                         licence covering it at the selling location (while
--                         Licences & registrations is on); an item made of a
--                         banned molecule is never sold; a crop-restricted
--                         molecule is sold only for a crop it may be used on;
--                         a seed lot is sold only while valid (its batch's
--                         expiry is its validity); a subsidised fertiliser
--                         line carries the receipt number of the government's
--                         PoS device (never an Aadhaar number)
--   molecule master       platform data read by every shop: the molecules
--                         the cited orders ban outright, restrict to some
--                         users or bar on named crops, each with the order
--                         or list it comes from
--   farmers               a customer's village, father's or husband's name,
--                         land, crops and Agri Stack Farmer ID; dues by
--                         village; a credit bill may carry its season (kharif,
--                         rabi or zaid of a year), and its due date is then the
--                         harvest date given
--   subsidy reconciliation subsidised bags sold against PoS receipts by day,
--                         and the PoS device's stock typed in against the shop's
--   registers             the daily stock and price board, the seed stock
--                         return of a month and the insecticide sale register,
--                         worked out from the bills, receipts and stock movements

-- --- Modules ---------------------------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('licences', 'Licences & registrations', 'The licences and registrations each location holds, with their numbers, the issuing authority and the dates they are valid; the bell warns 60 days before one runs out.', 'optional', 136),
 ('agri', 'Seeds, fertilisers & pesticides', 'What kind of farm input each item is; licence, banned-molecule, crop and seed-lot checks on every bill; farmers by village with season credit; the subsidy PoS reconciliation; the stock board and the seed and insecticide registers.', 'optional', 247);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('agri', 'catalog'), ('agri', 'contacts'), ('agri', 'sales'), ('agri', 'inventory'), ('agri', 'batches');

-- Every type but a restaurant may keep its licences; a farm-input shop starts with them.
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT 'licences', code, code = 'agri_inputs' FROM business_types WHERE code <> 'restaurant';
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('agri', 'agri_inputs', TRUE);

-- Trades that must hold a licence of their own, where the tool starts off.
UPDATE platform_module_business_types t SET recommended = TRUE, recommended_note = r.note
FROM (VALUES
  ('optical', 'The MD-42 registration for selling contact lenses, with its number and dates.'),
  ('jewellery', 'The BIS registration for selling hallmarked jewellery, with its number and dates.'),
  ('fuel_station', 'The PESO licence (Form XIV) of the outlet and when it is due for renewal.'),
  ('pharmacy', 'The trade licence, FSSAI and other registrations with their dates; drug licences stay in Pharmacy settings.')
) AS r(business_type, note)
WHERE t.module_code = 'licences' AND t.business_type = r.business_type AND NOT t.enabled_by_default;

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('licences', 'view', 'See the licences each location holds and when they run out', 480),
 ('licences', 'edit', 'Add and change licences and their dates', 481),
 ('agri', 'view', 'See farmers, village dues, the subsidy reconciliation, the registers and the molecule list', 485),
 ('agri', 'create', 'Enter the PoS device''s stock for the subsidy reconciliation', 486),
 ('agri', 'edit', 'Add and change farmers'' details', 487)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code IN ('licences', 'agri')
UNION ALL SELECT 'cashier', unnest(ARRAY['agri.view', 'agri.create', 'agri.edit'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['agri.view', 'agri.create'])
UNION ALL SELECT 'accountant', unnest(ARRAY['licences.view', 'agri.view'])
UNION ALL SELECT 'viewer', unnest(ARRAY['licences.view', 'agri.view']);

-- Existing businesses' copies of the shared templates (harmless where a
-- module cannot be switched on; keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code IN ('licences', 'agri')
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

-- Existing farm-input shops get the tools a new one starts with (where what they need is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code IN ('licences', 'agri')
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- --- Licences --------------------------------------------------------------------------------

CREATE TABLE business_licences (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- Each licence is held for one place of business.
  location_id BIGINT NOT NULL,
  -- What it is, as a short code (fertiliser, seed, insecticide, trade, fssai,
  -- md42, bis, peso, other …), and its name as issued.
  kind VARCHAR(30) NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,29}$'),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  licence_no VARCHAR(80) NOT NULL CHECK (btrim(licence_no) <> ''),
  authority VARCHAR(200),
  valid_from DATE NOT NULL,
  -- None: it does not expire.
  valid_until DATE,
  -- The product categories it lets the location sell (a farm-input shop's
  -- bills are checked against them). Another category joins this list with
  -- the migration that needs it.
  covers TEXT[] NOT NULL DEFAULT '{}' CHECK (covers <@ ARRAY['fertiliser', 'seed', 'insecticide']::TEXT[]),
  notes VARCHAR(500),
  -- Switched off when surrendered or cancelled.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE UNIQUE INDEX business_licences_number ON business_licences(business_id, kind, lower(licence_no));
CREATE INDEX business_licences_location ON business_licences(business_id, location_id) WHERE active;

-- A licence is changed (renewed, corrected) or switched off, never deleted;
-- it stays with the location and the kind it was added for.
CREATE FUNCTION business_licences_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A licence is never deleted; switch it off when it is surrendered or cancelled' USING ERRCODE = '23514';
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.kind <> OLD.kind OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A licence stays with the location and the kind it was added for' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_licences_guard BEFORE UPDATE OR DELETE ON business_licences
  FOR EACH ROW EXECUTE FUNCTION business_licences_guard();

-- Whether a location holds, on a day, a licence in force that covers a category.
CREATE FUNCTION business_licence_held(target_business BIGINT, target_location BIGINT, category TEXT, on_day DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM business_licences l WHERE l.business_id = target_business AND l.location_id = target_location
    AND l.active AND category = ANY (l.covers) AND l.valid_from <= on_day AND (l.valid_until IS NULL OR l.valid_until >= on_day));
$$;

-- --- Seeds, fertilisers & pesticides: the molecule master (platform data) -------------------

-- The crops the cited orders name, as one or a group (vegetables), with the
-- other names a farmer asks for them by.
CREATE TABLE agri_crops (
  code VARCHAR(40) PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,39}$'),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  aliases TEXT[] NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX agri_crops_name ON agri_crops(lower(name));

-- A molecule a shop cannot sell freely: banned (never sold), restricted to
-- some users or one formulation, or barred on named crops. Each says where
-- the rule comes from.
CREATE TABLE agri_molecules (
  code VARCHAR(40) PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,39}$'),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  status TEXT NOT NULL CHECK (status IN ('banned', 'restricted_use', 'crop_restricted')),
  -- In words: who may use it, or what more the order says.
  restriction VARCHAR(300),
  source VARCHAR(300) NOT NULL CHECK (btrim(source) <> ''),
  CHECK (status <> 'restricted_use' OR restriction IS NOT NULL)
);
CREATE UNIQUE INDEX agri_molecules_name ON agri_molecules(lower(name));

-- The crops a crop-restricted molecule must not be used on.
CREATE TABLE agri_molecule_crops (
  molecule_code VARCHAR(40) NOT NULL REFERENCES agri_molecules(code),
  crop_code VARCHAR(40) NOT NULL REFERENCES agri_crops(code),
  PRIMARY KEY (molecule_code, crop_code)
);

INSERT INTO agri_crops (code, name, aliases) VALUES
 ('ber', 'Ber', '{}'), ('citrus', 'Citrus', '{}'), ('tobacco', 'Tobacco', '{}'),
 ('fruits_vegetables_raw', 'Fruits and vegetables eaten raw', '{}'),
 ('sorghum', 'Sorghum (jowar)', '{sorghum,jowar}'), ('pea', 'Pea', '{peas}'), ('soybean', 'Soybean', '{soyabean,"soya bean"}'),
 ('castor', 'Castor', '{}'), ('sunflower', 'Sunflower', '{}'), ('guava', 'Guava', '{}'), ('tapioca', 'Tapioca', '{cassava}'),
 ('potato', 'Potato', '{}'), ('groundnut', 'Groundnut', '{peanut}'), ('jute', 'Jute', '{}'), ('cardamom', 'Cardamom', '{}'),
 ('vegetables', 'Vegetables', '{vegetable}');

-- Each entry names the order or list it comes from. The list of pesticides
-- banned, restricted or refused in India as on 31 March 2024 is longer (49
-- banned outright, 16 restricted); the platform completes this table from
-- that list and keeps it current.
INSERT INTO agri_molecules (code, name, status, restriction, source) VALUES
 ('dicofol', 'Dicofol', 'banned', 'Banned for manufacture, import and use.', 'S.O. 4294(E), 3 October 2023'),
 ('dinocap', 'Dinocap', 'banned', 'Banned for manufacture, import and use.', 'S.O. 4294(E), 3 October 2023'),
 ('methomyl', 'Methomyl', 'banned', 'Banned for manufacture, import and use.', 'S.O. 4294(E), 3 October 2023'),
 ('dichlorvos', 'Dichlorvos', 'banned', 'Banned for use in India; made only for export.', 'Pesticides banned, restricted or refused in India, as on 31 March 2024 (Directorate of Plant Protection, Quarantine & Storage)'),
 ('phorate', 'Phorate', 'banned', 'Banned for use in India; made only for export.', 'Pesticides banned, restricted or refused in India, as on 31 March 2024 (Directorate of Plant Protection, Quarantine & Storage)'),
 ('triazophos', 'Triazophos', 'banned', 'Banned for use in India; made only for export.', 'Pesticides banned, restricted or refused in India, as on 31 March 2024 (Directorate of Plant Protection, Quarantine & Storage)'),
 ('aluminium_phosphide', 'Aluminium phosphide', 'restricted_use', 'Used only by government bodies or approved pest-control experts.', 'Pesticides banned, restricted or refused in India, as on 31 March 2024 (Directorate of Plant Protection, Quarantine & Storage)'),
 ('methyl_bromide', 'Methyl bromide', 'restricted_use', 'Used only by government bodies or approved pest-control experts.', 'Pesticides banned, restricted or refused in India, as on 31 March 2024 (Directorate of Plant Protection, Quarantine & Storage)'),
 ('cypermethrin', 'Cypermethrin', 'restricted_use', 'Its 3% smoke generator is used only by pest control operators.', 'Pesticides banned, restricted or refused in India, as on 31 March 2024 (Directorate of Plant Protection, Quarantine & Storage)'),
 ('ddt', 'DDT', 'restricted_use', 'Used only for public health.', 'Pesticides banned, restricted or refused in India, as on 31 March 2024 (Directorate of Plant Protection, Quarantine & Storage)'),
 ('carbofuran', 'Carbofuran', 'restricted_use', 'Only its 3% CG formulation may be used.', 'S.O. 4294(E), 3 October 2023'),
 ('chlorpyrifos', 'Chlorpyrifos', 'crop_restricted', NULL, 'S.O. 4294(E), 3 October 2023'),
 ('dimethoate', 'Dimethoate', 'crop_restricted', NULL, 'S.O. 4294(E), 3 October 2023'),
 ('malathion', 'Malathion', 'crop_restricted', 'The order also bars it on some fruits this list does not name yet.', 'S.O. 4294(E), 3 October 2023'),
 ('mancozeb', 'Mancozeb', 'crop_restricted', NULL, 'S.O. 4294(E), 3 October 2023'),
 ('oxyfluorfen', 'Oxyfluorfen', 'crop_restricted', NULL, 'S.O. 4294(E), 3 October 2023'),
 ('quinalphos', 'Quinalphos', 'crop_restricted', NULL, 'S.O. 4294(E), 3 October 2023'),
 ('monocrotophos', 'Monocrotophos', 'crop_restricted', NULL, 'S.O. 4294(E), 3 October 2023');

INSERT INTO agri_molecule_crops (molecule_code, crop_code) VALUES
 ('chlorpyrifos', 'ber'), ('chlorpyrifos', 'citrus'), ('chlorpyrifos', 'tobacco'),
 ('dimethoate', 'fruits_vegetables_raw'),
 ('malathion', 'sorghum'), ('malathion', 'pea'), ('malathion', 'soybean'), ('malathion', 'castor'), ('malathion', 'sunflower'),
 ('mancozeb', 'guava'), ('mancozeb', 'sorghum'), ('mancozeb', 'tapioca'),
 ('oxyfluorfen', 'potato'), ('oxyfluorfen', 'groundnut'),
 ('quinalphos', 'jute'), ('quinalphos', 'cardamom'), ('quinalphos', 'sorghum'),
 ('monocrotophos', 'vegetables');

-- An item whose molecules (catalog_skus.attributes -> 'molecules', a list of
-- names) include a banned one is never kept for sale.
CREATE FUNCTION agri_item_molecules_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER catalog_skus_agri_molecules BEFORE INSERT OR UPDATE OF attributes ON catalog_skus
  FOR EACH ROW WHEN (NEW.attributes ? 'molecules') EXECUTE FUNCTION agri_item_molecules_check();

-- --- Farmers ----------------------------------------------------------------------------------

-- A customer's details as a farmer. No Aadhaar number is kept anywhere: the
-- Farmer ID is the one the Agri Stack farmer registry gives.
CREATE TABLE agri_farmers (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  village VARCHAR(100) NOT NULL CHECK (btrim(village) <> ''),
  -- Father's or husband's name, as farm-input bills and registers name a farmer.
  relative_name VARCHAR(150),
  land_acres NUMERIC(8,2) CHECK (land_acres > 0 AND land_acres <= 100000),
  crops VARCHAR(200),
  farmer_id VARCHAR(30) CHECK (farmer_id ~ '^[A-Za-z0-9/-]{4,30}$'),
  notes VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id)
);
CREATE INDEX agri_farmers_village ON agri_farmers(business_id, lower(village));
CREATE UNIQUE INDEX agri_farmers_farmer_id ON agri_farmers(business_id, upper(farmer_id)) WHERE farmer_id IS NOT NULL;
CREATE TRIGGER agri_farmers_customer BEFORE INSERT ON agri_farmers
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A farmer's details are changed, never deleted, and stay with their customer.
CREATE FUNCTION agri_farmers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A farmer''s details are never deleted; change them instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A farmer''s details stay with the customer they were added for' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agri_farmers_guard BEFORE UPDATE OR DELETE ON agri_farmers
  FOR EACH ROW EXECUTE FUNCTION agri_farmers_guard();

-- --- Bills ------------------------------------------------------------------------------------

CREATE FUNCTION agri_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'agri_bills' THEN
    RAISE EXCEPTION 'A bill''s season and farmer are kept as they were billed' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A PoS stock check is kept as it was entered' USING ERRCODE = '23514';
END $$;

-- A bill's farm-input details: the season a credit bill is for (its due date,
-- the harvest, is the bill's own due date), or a walk-in farmer's name and
-- village (a named customer's are with their farmer details).
CREATE TABLE agri_bills (
  business_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  season TEXT CHECK (season IN ('kharif', 'rabi', 'zaid')),
  season_year SMALLINT CHECK (season_year BETWEEN 2000 AND 2100),
  buyer_name VARCHAR(150),
  village VARCHAR(100),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, document_id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  CHECK ((season IS NULL) = (season_year IS NULL)),
  CHECK (season IS NOT NULL OR buyer_name IS NOT NULL OR village IS NOT NULL)
);
CREATE INDEX agri_bills_season ON agri_bills(business_id, season_year, season) WHERE season IS NOT NULL;

-- A season goes on a named customer's sale; a walk-in's name and village on a walk-in's.
CREATE FUNCTION agri_bills_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER agri_bills_check BEFORE INSERT ON agri_bills
  FOR EACH ROW EXECUTE FUNCTION agri_bills_check();
CREATE TRIGGER agri_bills_append_only BEFORE UPDATE OR DELETE ON agri_bills
  FOR EACH ROW EXECUTE FUNCTION agri_append_only();

-- Each fertiliser, seed, pesticide or bio-input line of a bill, as it was
-- billed: the kind of input, whether it was subsidised and the PoS device's
-- receipt for it, the crop it was bought for (as said, and the listed crop it
-- matched) and the item's molecules then.
CREATE TABLE agri_sale_lines (
  business_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('fertiliser', 'seed', 'pesticide', 'bio_input')),
  subsidised BOOLEAN NOT NULL DEFAULT FALSE,
  pos_receipt VARCHAR(40) CHECK (pos_receipt ~ '^[A-Za-z0-9/-]{3,40}$'),
  crop VARCHAR(100) CHECK (btrim(crop) <> ''),
  crop_code VARCHAR(40) REFERENCES agri_crops(code),
  molecules TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, line_id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (subsidised = (pos_receipt IS NOT NULL)),
  CHECK (NOT subsidised OR input_kind = 'fertiliser'),
  CHECK (crop_code IS NULL OR crop IS NOT NULL)
);
CREATE INDEX agri_sale_lines_document ON agri_sale_lines(business_id, document_id);
CREATE INDEX agri_sale_lines_subsidised ON agri_sale_lines(business_id, sku_id) WHERE subsidised;

-- The rules again where the line is kept: no banned molecule, no barred
-- crop-molecule pair, a licence in force covering the line at the selling
-- location on the day (while Licences & registrations is on), and no seed
-- lot past its validity. A line is never changed or deleted.
CREATE FUNCTION agri_sale_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc RECORD; banned TEXT; pair RECORD; lot RECORD; category TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A farm-input bill line is kept as it was billed' USING ERRCODE = '23514';
  END IF;
  SELECT d.kind, d.location_id, d.document_no, (d.created_at AT TIME ZONE b.timezone)::date AS day INTO doc
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
  IF category IS NOT NULL AND EXISTS (SELECT 1 FROM business_capabilities WHERE business_id = NEW.business_id AND capability = 'licences')
     AND NOT business_licence_held(NEW.business_id, doc.location_id, category, doc.day) THEN
    RAISE EXCEPTION 'This location holds no % licence in force on %, so % cannot bill it', category, to_char(doc.day, 'DD Mon YYYY'), doc.document_no
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
CREATE TRIGGER agri_sale_lines_check BEFORE INSERT OR UPDATE OR DELETE ON agri_sale_lines
  FOR EACH ROW EXECUTE FUNCTION agri_sale_line_check();

-- --- Subsidy reconciliation: the PoS device's stock, typed in --------------------------------

-- One entry: the stock the government's PoS device shows for each subsidised
-- fertiliser at a location, against the shop's own stock at that moment.
CREATE TABLE agri_pos_checks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  -- The business day it was entered on.
  checked_on DATE NOT NULL,
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX agri_pos_checks_day ON agri_pos_checks(business_id, location_id, checked_on);

CREATE TABLE agri_pos_check_lines (
  business_id BIGINT NOT NULL,
  check_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  -- In the item's stock unit (bags).
  pos_stock NUMERIC(16,3) NOT NULL CHECK (pos_stock >= 0),
  app_stock NUMERIC(16,3) NOT NULL CHECK (app_stock >= 0),
  PRIMARY KEY (business_id, check_id, sku_id),
  FOREIGN KEY (business_id, check_id) REFERENCES agri_pos_checks(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE TRIGGER agri_pos_checks_append_only BEFORE UPDATE OR DELETE ON agri_pos_checks
  FOR EACH ROW EXECUTE FUNCTION agri_append_only();
CREATE TRIGGER agri_pos_check_lines_append_only BEFORE UPDATE OR DELETE ON agri_pos_check_lines
  FOR EACH ROW EXECUTE FUNCTION agri_append_only();

-- Down Migration
DROP TABLE agri_pos_check_lines, agri_pos_checks, agri_sale_lines, agri_bills, agri_farmers;
DROP FUNCTION agri_sale_line_check();
DROP FUNCTION agri_bills_check();
DROP FUNCTION agri_append_only();
DROP FUNCTION agri_farmers_guard();
DROP TRIGGER catalog_skus_agri_molecules ON catalog_skus;
DROP FUNCTION agri_item_molecules_check();
DROP TABLE agri_molecule_crops, agri_molecules, agri_crops;
DROP FUNCTION business_licence_held(BIGINT, BIGINT, TEXT, DATE);
DROP TABLE business_licences;
DROP FUNCTION business_licences_guard();
DELETE FROM business_capabilities WHERE capability IN ('licences', 'agri');
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('licences', 'agri'));
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('licences', 'agri'));
DELETE FROM business_permissions WHERE module_code IN ('licences', 'agri');
DELETE FROM platform_module_business_types WHERE module_code IN ('licences', 'agri');
DELETE FROM platform_module_dependencies WHERE module_code IN ('licences', 'agri');
DELETE FROM platform_modules WHERE code IN ('licences', 'agri');
