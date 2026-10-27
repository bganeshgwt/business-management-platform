-- Up Migration
-- The rest of licences, and of the hardware shop's paint and building tools.
--
-- Licences & registrations:
--   licence kinds         platform data, one row per kind of licence a screen
--                         offers: its usual name, the trades it is offered to
--                         first, the categories it covers, whether a new one is
--                         for retail sales, wholesale sales or both, and what a
--                         renewal applied for does once its date has passed.
--                         An insecticide licence stays in force while its
--                         renewal is pending (Insecticides Rules 1971, rule 11);
--                         a fertiliser authorisation only when its renewal was
--                         applied for within one month of its expiry (Fertiliser
--                         (Control) Order 1985, clause 11); every other kind
--                         lapses on its date. A seed licence lapses too: the
--                         Seeds (Control) Order allows a late renewal within a
--                         month, but the sources read say nothing of the licence
--                         staying in force meanwhile. Changing a kind's rule is
--                         a migration, never code.
--   a licence             retail, wholesale or both (an existing licence takes its
--                         kind's usual mark); the qualified person it names, as
--                         data (name, qualification, certificate number or the
--                         reason they are exempt: no rule says which
--                         qualification is valid); and a renewal applied for,
--                         with its date and the application's reference, kept
--                         until the renewed date is typed.
--   scanned copies        each licence's copies (PDF or photo), every renewal's
--                         kept with the dates the licence had then; in the
--                         private uploads folder, opened only through the API by
--                         those who see licences.
--   endorsements          an insecticide licence's endorsed products or brands,
--                         and each manufacturer's principal certificate (its
--                         registration and manufacturing licence numbers, the
--                         formulations authorised, its validity, withdrawn with
--                         a date). The counter warns, or stops (a setting of a
--                         farm-input shop, warn to start with), when an
--                         insecticide is on no endorsement or its principal's
--                         certificate is missing, withdrawn or out of date.
--   sources (Form O)      a fertiliser authorisation's certificates of source:
--                         the supplier or manufacturer, the certificate's number
--                         and date. A purchase of fertiliser from a supplier with
--                         no Form O on the location's authorisation warns.
--   wholesale             a farm-input sale to a buyer with a GSTIN (a B2B
--                         invoice) is a wholesale sale: its fertilisers, seeds and
--                         insecticides need a licence for wholesale sales.
--
-- Hardware, paints & building materials:
--   paint tinting         module "hardware_tinting" (off, recommended): shades by
--                         maker (code, name, card, the base it needs, an optional
--                         formula of colourants in millilitres per litre of
--                         base), typed or imported from a spreadsheet; a tinted
--                         line on a bill or a quotation (base item, its pack and
--                         a shade, with the tinting charge as a service line at
--                         its own GST slab); a tinting job for each tinted line
--                         of a bill, queued -> tinted -> handed over, the base
--                         leaving stock through the core when it is tinted; a
--                         tinted line comes back only on a manager's PIN, never
--                         into stock.
--   calculators           module "hardware_calculators" becomes Material
--                         calculators: brickwork, concrete and plaster, and steel
--                         beside tiles and paint; the workings (what was typed,
--                         the assumptions and the result) are kept with the
--                         quotation or the bill.
--   fitters               a bill made without a fitter may have one named later,
--                         and its fitter changed until the commission on it is
--                         paid (payouts settle a fitter's oldest commission
--                         first); a sales order may name a fitter, and the
--                         invoices its dispatches raise carry it.
--   rate history          an index for each item's price changes in the activity
--                         log, which the rate board lists.

-- --- Licence kinds (platform data) -------------------------------------------------------------

CREATE TABLE platform_licence_kinds (
  code VARCHAR(30) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,29}$'),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  -- The trades a screen offers the kind to first; none: every trade.
  business_types TEXT[],
  covers TEXT[] NOT NULL DEFAULT '{}' CHECK (covers <@ ARRAY['fertiliser', 'seed', 'insecticide']::TEXT[]),
  -- Whether a new licence of the kind is for retail sales, wholesale sales or both.
  sells_to TEXT NOT NULL DEFAULT 'both' CHECK (sells_to IN ('retail', 'wholesale', 'both')),
  -- What a renewal applied for does once a licence of the kind is past its
  -- date: nothing (lapses), keeps it in force until the renewed date is typed
  -- (while_pending), or the same only when it was applied for within
  -- renewal_grace of the date (applied_within). The rule's source, in words.
  renewal_rule TEXT NOT NULL DEFAULT 'lapses' CHECK (renewal_rule IN ('lapses', 'while_pending', 'applied_within')),
  renewal_grace INTERVAL,
  renewal_source VARCHAR(300),
  sort_order SMALLINT NOT NULL,
  CHECK ((renewal_rule = 'applied_within') = (renewal_grace IS NOT NULL)),
  CHECK ((renewal_rule = 'lapses') = (renewal_source IS NULL))
);

INSERT INTO platform_licence_kinds (code, name, business_types, covers, sells_to, renewal_rule, renewal_grace, renewal_source, sort_order) VALUES
 ('fertiliser', 'Fertiliser authorisation letter (Form A2)', ARRAY['agri_inputs'], ARRAY['fertiliser'], 'retail', 'applied_within', INTERVAL '1 month',
  'Fertiliser (Control) Order 1985, clause 11: renewal applied for within one month of expiry', 10),
 ('seed', 'Seed dealer licence (Form B)', ARRAY['agri_inputs'], ARRAY['seed'], 'both', 'lapses', NULL, NULL, 20),
 ('insecticide', 'Insecticide sale licence (Form VIII)', ARRAY['agri_inputs'], ARRAY['insecticide'], 'both', 'while_pending', NULL,
  'Insecticides Rules 1971, rule 11: in force while a renewal application is pending', 30),
 ('md42', 'Medical device sale registration (MD-42)', ARRAY['optical'], '{}', 'both', 'lapses', NULL, NULL, 40),
 ('bis', 'BIS registration (hallmarking)', ARRAY['jewellery'], '{}', 'both', 'lapses', NULL, NULL, 50),
 ('peso', 'PESO licence (Form XIV)', ARRAY['fuel_station'], '{}', 'both', 'lapses', NULL, NULL, 60),
 ('rent_a_cab', 'Rent-a-cab licence (State Transport Authority)', ARRAY['rentals'], '{}', 'both', 'lapses', NULL, NULL, 70),
 ('rent_a_motorcycle', 'Rent-a-motorcycle licence (State Transport Authority)', ARRAY['rentals'], '{}', 'both', 'lapses', NULL, NULL, 80),
 ('trade', 'Trade licence', NULL, '{}', 'both', 'lapses', NULL, NULL, 90),
 ('shop', 'Shops & establishments registration', NULL, '{}', 'both', 'lapses', NULL, NULL, 100),
 ('fssai', 'FSSAI registration or licence', NULL, '{}', 'both', 'lapses', NULL, NULL, 110);

-- --- A licence: retail or wholesale, the qualified person, a renewal applied for ----------------

ALTER TABLE business_licences
  ADD COLUMN sells_to TEXT NOT NULL DEFAULT 'both' CHECK (sells_to IN ('retail', 'wholesale', 'both')),
  -- The qualified person the licence names, as data.
  ADD COLUMN qualified_person VARCHAR(150) CHECK (btrim(qualified_person) <> ''),
  ADD COLUMN qualification VARCHAR(200) CHECK (btrim(qualification) <> ''),
  ADD COLUMN qualification_certificate VARCHAR(80) CHECK (btrim(qualification_certificate) <> ''),
  ADD COLUMN qualification_exemption VARCHAR(300) CHECK (btrim(qualification_exemption) <> ''),
  -- A renewal applied for, until the renewed date is typed.
  ADD COLUMN renewal_applied_on DATE,
  ADD COLUMN renewal_reference VARCHAR(80) CHECK (btrim(renewal_reference) <> ''),
  ADD CONSTRAINT business_licences_qualified_person CHECK (qualified_person IS NOT NULL
    OR (qualification IS NULL AND qualification_certificate IS NULL AND qualification_exemption IS NULL)),
  ADD CONSTRAINT business_licences_qualification CHECK (qualified_person IS NULL OR qualification IS NOT NULL OR qualification_exemption IS NOT NULL),
  ADD CONSTRAINT business_licences_renewal CHECK ((renewal_applied_on IS NULL) = (renewal_reference IS NULL)),
  ADD CONSTRAINT business_licences_renewal_dated CHECK (renewal_applied_on IS NULL OR (valid_until IS NOT NULL AND renewal_applied_on >= valid_from));

-- An existing licence takes its kind's usual mark (a fertiliser authorisation is for retail sales).
UPDATE business_licences l SET sells_to = k.sells_to FROM platform_licence_kinds k WHERE k.code = l.kind AND l.sells_to <> k.sells_to;

-- Whether a licence is in force on a day: switched on, valid from then, and
-- not past its date, or past it with a renewal applied for that keeps it in
-- force by its kind's rule.
CREATE FUNCTION business_licence_in_force(l business_licences, on_day DATE) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT l.active AND l.valid_from <= on_day AND (l.valid_until IS NULL OR l.valid_until >= on_day
    OR (l.renewal_applied_on IS NOT NULL AND l.renewal_applied_on <= on_day AND EXISTS (SELECT 1 FROM platform_licence_kinds k WHERE k.code = l.kind
      AND (k.renewal_rule = 'while_pending' OR (k.renewal_rule = 'applied_within' AND l.renewal_applied_on <= l.valid_until + k.renewal_grace)))));
$$;

-- Whether a location holds, on a day, a licence in force covering a category,
-- for a kind of sale (retail or wholesale; none: either).
CREATE FUNCTION business_licence_covering(target_business BIGINT, target_location BIGINT, category TEXT, on_day DATE, trade TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM business_licences l WHERE l.business_id = target_business AND l.location_id = target_location
    AND category = ANY (l.covers) AND (trade IS NULL OR l.sells_to IN (trade, 'both')) AND business_licence_in_force(l, on_day));
$$;

CREATE OR REPLACE FUNCTION business_licence_held(target_business BIGINT, target_location BIGINT, category TEXT, on_day DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT business_licence_covering(target_business, target_location, category, on_day, NULL);
$$;

-- The rules again where a farm-input line is kept: a sale to a buyer with a
-- GSTIN (a B2B invoice) is a wholesale sale and needs a licence for wholesale.
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

-- --- Scanned copies --------------------------------------------------------------------------

-- Each copy of a licence, with the dates the licence had when it was added
-- (a renewal's copy is added beside the earlier ones). Never changed or deleted.
CREATE TABLE business_licence_files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  licence_id BIGINT NOT NULL,
  stored_name VARCHAR(80) NOT NULL CHECK (stored_name ~ '^[a-f0-9]{32}\.(jpg|png|webp|pdf)$'),
  file_name VARCHAR(150) NOT NULL CHECK (btrim(file_name) <> ''),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  valid_from DATE NOT NULL,
  valid_until DATE,
  uploaded_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, licence_id) REFERENCES business_licences(business_id, id),
  UNIQUE (business_id, id)
);
CREATE INDEX business_licence_files_licence ON business_licence_files(business_id, licence_id, id DESC);

CREATE FUNCTION business_licence_files_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A licence''s copies are kept as they were added' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_licence_files_fixed BEFORE UPDATE OR DELETE ON business_licence_files
  FOR EACH ROW EXECUTE FUNCTION business_licence_files_fixed();

-- --- Endorsements and principal certificates (an insecticide licence) ------------------------

-- A product (every pack of it) or a brand endorsed on a licence. Switched
-- off when the endorsement no longer stands, never deleted.
CREATE TABLE business_licence_endorsements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  licence_id BIGINT NOT NULL,
  product_id BIGINT,
  brand VARCHAR(100) CHECK (btrim(brand) <> ''),
  endorsed_on DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, licence_id) REFERENCES business_licences(business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES catalog_products(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((product_id IS NULL) <> (brand IS NULL))
);
CREATE UNIQUE INDEX business_licence_endorsements_product ON business_licence_endorsements(business_id, licence_id, product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX business_licence_endorsements_brand ON business_licence_endorsements(business_id, licence_id, lower(brand)) WHERE brand IS NOT NULL;

-- A manufacturer's principal certificate on a licence: its registration and
-- manufacturing licence numbers, the formulations it authorises and its
-- validity; withdrawn with a date when the principal withdraws it. Each grant
-- or renewal of the licence brings its own.
CREATE TABLE business_licence_principals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  licence_id BIGINT NOT NULL,
  manufacturer VARCHAR(150) NOT NULL CHECK (btrim(manufacturer) <> ''),
  registration_no VARCHAR(200) NOT NULL CHECK (btrim(registration_no) <> ''),
  manufacturing_licence_no VARCHAR(80) NOT NULL CHECK (btrim(manufacturing_licence_no) <> ''),
  formulations TEXT[] NOT NULL CHECK (cardinality(formulations) BETWEEN 1 AND 20),
  valid_from DATE NOT NULL,
  valid_until DATE,
  withdrawn_on DATE,
  withdrawn_note VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, licence_id) REFERENCES business_licences(business_id, id),
  UNIQUE (business_id, id),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK (withdrawn_note IS NULL OR withdrawn_on IS NOT NULL)
);
CREATE INDEX business_licence_principals_licence ON business_licence_principals(business_id, licence_id, lower(manufacturer));

-- --- Sources: certificates of source in Form O (a fertiliser authorisation) ------------------

-- One Form O on an authorisation: the source as the certificate names it (a
-- manufacturer or a supplier), the supplier of this business it covers
-- purchases from, the certificate's number and date. Switched off, never deleted.
CREATE TABLE business_licence_sources (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  licence_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  contact_id BIGINT,
  certificate_no VARCHAR(80) NOT NULL CHECK (btrim(certificate_no) <> ''),
  certificate_date DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, licence_id) REFERENCES business_licences(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX business_licence_sources_number ON business_licence_sources(business_id, licence_id, lower(certificate_no));
CREATE INDEX business_licence_sources_contact ON business_licence_sources(business_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE TRIGGER business_licence_sources_supplier BEFORE INSERT OR UPDATE OF contact_id ON business_licence_sources
  FOR EACH ROW WHEN (NEW.contact_id IS NOT NULL) EXECUTE FUNCTION business_contact_is_supplier();

-- What a licence keeps beside it stays with that licence and is never deleted;
-- a principal's withdrawal stands once recorded.
CREATE FUNCTION business_licence_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A licence''s endorsements, principal certificates and sources are never deleted; switch them off or record the withdrawal' USING ERRCODE = '23514';
  END IF;
  IF NEW.licence_id <> OLD.licence_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A licence''s endorsements, principal certificates and sources stay with the licence they were added to' USING ERRCODE = '23514';
  END IF;
  -- Each table's own columns are read only inside its own branch.
  IF TG_TABLE_NAME = 'business_licence_endorsements' THEN
    IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.brand IS DISTINCT FROM OLD.brand THEN
      RAISE EXCEPTION 'An endorsement keeps its product or brand: add the other one on its own' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'business_licence_principals' THEN
    IF lower(NEW.manufacturer) <> lower(OLD.manufacturer) OR (OLD.withdrawn_on IS NOT NULL AND NEW.withdrawn_on IS DISTINCT FROM OLD.withdrawn_on) THEN
      RAISE EXCEPTION 'A principal certificate keeps its manufacturer, and a withdrawal stands once recorded' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_licence_endorsements_guard BEFORE UPDATE OR DELETE ON business_licence_endorsements
  FOR EACH ROW EXECUTE FUNCTION business_licence_records_guard();
CREATE TRIGGER business_licence_principals_guard BEFORE UPDATE OR DELETE ON business_licence_principals
  FOR EACH ROW EXECUTE FUNCTION business_licence_records_guard();
CREATE TRIGGER business_licence_sources_guard BEFORE UPDATE OR DELETE ON business_licence_sources
  FOR EACH ROW EXECUTE FUNCTION business_licence_records_guard();

-- A farm-input shop's setting: an insecticide not endorsed on the location's
-- licence, or whose principal's certificate is missing, withdrawn or out of
-- date, warns at the counter (warn) or stops the bill (block).
CREATE TABLE agri_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  endorsement_check TEXT NOT NULL DEFAULT 'warn' CHECK (endorsement_check IN ('warn', 'block')),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Hardware: paint tinting (module) --------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('hardware_tinting', 'Paint tinting', 'Shades by paint maker with their formulas; tinted paint on bills and quotations with its tinting charge; the tinting board from queued to tinted to handed over, the base leaving stock when it is tinted.', 'optional', 294);
INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('hardware_tinting', 'catalog'), ('hardware_tinting', 'sales'), ('hardware_tinting', 'inventory');
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default, recommended, recommended_note) VALUES
 ('hardware_tinting', 'hardware', FALSE, TRUE, 'Paint dealers with a tinting machine: shades, tinted paint on the bill and the tinting board.');

UPDATE platform_modules SET name = 'Material calculators',
  description = 'Tiles, paint, bricks, concrete and plaster, and steel worked out from a job''s sizes on Quick bill and on quotations, with the workings kept with the quotation or the bill.'
WHERE code = 'hardware_calculators';

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('hardware_tinting', 'view', 'See shades and the tinting board', 472),
 ('hardware_tinting', 'create', 'Put tinted paint on bills and quotations, and move jobs on the tinting board', 473),
 ('hardware_tinting', 'edit', 'Add, import and change shades, and set the tinting charge', 478)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'hardware_tinting'
UNION ALL SELECT 'cashier', unnest(ARRAY['hardware_tinting.view', 'hardware_tinting.create'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['hardware_tinting.view', 'hardware_tinting.create'])
UNION ALL SELECT 'accountant', unnest(ARRAY['hardware_tinting.view'])
UNION ALL SELECT 'viewer', unnest(ARRAY['hardware_tinting.view']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'hardware_tinting'
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

-- The service item a tinted line's charge is billed as: its price is for one
-- tin, at its own GST slab. None: no charge goes on the bill by itself.
CREATE TABLE hardware_tint_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  charge_sku_id BIGINT,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, charge_sku_id) REFERENCES catalog_skus(business_id, id)
);

-- --- Hardware: shades ------------------------------------------------------------------------

-- A maker's shade: its code and name, its card or collection, the base it
-- needs, and an optional formula: [{ "colourant": "XR", "ml": "1.25" }] for one
-- litre of base. Switched off, never deleted (a job keeps its shade).
CREATE TABLE hardware_shades (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  maker VARCHAR(80) NOT NULL CHECK (btrim(maker) <> ''),
  code VARCHAR(30) NOT NULL CHECK (btrim(code) <> ''),
  name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
  card VARCHAR(100) CHECK (btrim(card) <> ''),
  base VARCHAR(40) NOT NULL CHECK (btrim(base) <> ''),
  formula JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(formula) = 'array'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX hardware_shades_code ON hardware_shades(business_id, lower(maker), upper(code));

CREATE FUNCTION hardware_shades_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A shade is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A shade keeps who added it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hardware_shades_guard BEFORE UPDATE OR DELETE ON hardware_shades
  FOR EACH ROW EXECUTE FUNCTION hardware_shades_guard();

-- The shade a quotation's line is tinted to; replaced with the lines when an
-- open quotation is revised.
CREATE TABLE hardware_quotation_tints (
  business_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  quotation_id BIGINT NOT NULL,
  shade_id BIGINT NOT NULL,
  PRIMARY KEY (business_id, line_id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_quotation_lines(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, quotation_id) REFERENCES business_quotations(business_id, id),
  FOREIGN KEY (business_id, shade_id) REFERENCES hardware_shades(business_id, id)
);
CREATE INDEX hardware_quotation_tints_quotation ON hardware_quotation_tints(business_id, quotation_id);

-- --- Hardware: tinting jobs ------------------------------------------------------------------

-- A tinted line of a bill, on the tinting board: queued -> tinted (the base
-- leaves stock then, through the core) -> handed over; or taken back on a
-- manager's PIN (the return's request key is kept, and the return checks it).
CREATE TABLE hardware_tint_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  shade_id BIGINT NOT NULL,
  -- As billed, in the base's stock unit.
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'tinted', 'handed_over', 'taken_back')),
  tinted_by BIGINT REFERENCES users(id),
  tinted_at TIMESTAMPTZ,
  handed_over_by BIGINT REFERENCES users(id),
  handed_over_at TIMESTAMPTZ,
  take_back_key UUID,
  approved_by BIGINT REFERENCES users(id),
  take_back_reason VARCHAR(300),
  taken_back_by BIGINT REFERENCES users(id),
  taken_back_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, shade_id) REFERENCES hardware_shades(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, line_id),
  CHECK ((tinted_at IS NULL) = (tinted_by IS NULL)),
  CHECK ((handed_over_at IS NULL) = (handed_over_by IS NULL)),
  CHECK (handed_over_at IS NULL OR tinted_at IS NOT NULL),
  CHECK (status <> 'tinted' OR (tinted_at IS NOT NULL AND handed_over_at IS NULL)),
  CHECK (status <> 'handed_over' OR handed_over_at IS NOT NULL),
  CHECK (status <> 'queued' OR tinted_at IS NULL),
  CHECK ((status = 'taken_back') = (taken_back_at IS NOT NULL)),
  CHECK ((taken_back_at IS NULL) = (taken_back_by IS NULL)),
  CHECK ((taken_back_at IS NULL) = (take_back_key IS NULL)),
  CHECK ((taken_back_at IS NULL) = (approved_by IS NULL)),
  CHECK ((taken_back_at IS NULL) = (take_back_reason IS NULL))
);
CREATE INDEX hardware_tint_jobs_board ON hardware_tint_jobs(business_id, status, created_at);
CREATE INDEX hardware_tint_jobs_document ON hardware_tint_jobs(business_id, document_id);

-- A job keeps its bill, line, base and shade; it moves forward only; never deleted.
CREATE FUNCTION hardware_tint_jobs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A tinting job is never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.document_id <> OLD.document_id OR NEW.line_id <> OLD.line_id OR NEW.sku_id <> OLD.sku_id
     OR NEW.shade_id <> OLD.shade_id OR NEW.quantity <> OLD.quantity OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A tinting job keeps its bill, its base, its shade and its quantity' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'taken_back' THEN
    RAISE EXCEPTION 'A tinted line taken back no longer changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'queued' AND NEW.status = 'tinted') OR (OLD.status = 'tinted' AND NEW.status = 'handed_over')
     OR NEW.status = 'taken_back') THEN
    RAISE EXCEPTION 'A tinting job goes from queued to tinted to handed over, one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.tinted_at IS DISTINCT FROM OLD.tinted_at AND OLD.tinted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A tinting job keeps when it was tinted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hardware_tint_jobs_guard BEFORE UPDATE OR DELETE ON hardware_tint_jobs
  FOR EACH ROW EXECUTE FUNCTION hardware_tint_jobs_guard();

-- A tinted line comes back only on the take-back a manager approved with
-- their PIN, and never back into stock: a tinted tin is no longer base paint.
CREATE FUNCTION hardware_tint_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job RECORD; credit UUID;
BEGIN
  SELECT j.take_back_key, s.code, s.name, d.document_no INTO job FROM hardware_tint_jobs j
  JOIN hardware_shades s ON s.business_id = j.business_id AND s.id = j.shade_id
  JOIN business_documents d ON d.business_id = j.business_id AND d.id = j.document_id
  WHERE j.business_id = NEW.business_id AND j.line_id = NEW.line_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT request_key INTO credit FROM business_returns WHERE business_id = NEW.business_id AND id = NEW.return_id;
  IF job.take_back_key IS DISTINCT FROM credit OR NEW.restock THEN
    RAISE EXCEPTION 'This line of % is paint tinted to shade % (%): a tinted tin is not taken back. A manager may take it back with their PIN on the tinting board.',
      job.document_no, job.code, job.name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_return_lines_hardware_tint BEFORE INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION hardware_tint_line_return();

-- --- Hardware: the calculators' workings -------------------------------------------------------

-- A calculator's working kept with a quotation (with the revision it was
-- added in) or a bill: what was typed, the assumptions used, what came out and
-- the lines it put on, as the server worked them out. Never changed.
CREATE TABLE hardware_calculations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  quotation_id BIGINT,
  revision SMALLINT CHECK (revision BETWEEN 1 AND 999),
  document_id BIGINT,
  kind TEXT NOT NULL CHECK (kind IN ('tiles', 'paint', 'brickwork', 'concrete', 'plaster', 'steel')),
  working JSONB NOT NULL CHECK (jsonb_typeof(working) = 'object'),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, quotation_id) REFERENCES business_quotations(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  CHECK ((quotation_id IS NULL) <> (document_id IS NULL)),
  CHECK ((quotation_id IS NULL) = (revision IS NULL))
);
CREATE INDEX hardware_calculations_quotation ON hardware_calculations(business_id, quotation_id) WHERE quotation_id IS NOT NULL;
CREATE INDEX hardware_calculations_document ON hardware_calculations(business_id, document_id) WHERE document_id IS NOT NULL;

CREATE FUNCTION hardware_calculations_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A calculator''s working is kept as it was saved' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER hardware_calculations_fixed BEFORE UPDATE OR DELETE ON hardware_calculations
  FOR EACH ROW EXECUTE FUNCTION hardware_calculations_fixed();

-- --- Hardware: a fitter named later, and on sales orders ---------------------------------------

-- Whether the commission on a bill is paid to its fitter: payouts (those not
-- reversed) settle a fitter's commission oldest bill first, less what goods
-- returned took back.
CREATE FUNCTION hardware_fitter_bill_paid(target_business BIGINT, target_document BIGINT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  WITH bill AS (SELECT fitter_id, created_at, document_id FROM hardware_fitter_bills WHERE business_id = target_business AND document_id = target_document),
  owed AS (SELECT b.document_id, b.created_at, b.commission
      - COALESCE((SELECT sum(r.amount) FROM hardware_fitter_reversals r WHERE r.business_id = b.business_id AND r.document_id = b.document_id), 0) AS net
    FROM hardware_fitter_bills b JOIN bill ON bill.fitter_id = b.fitter_id WHERE b.business_id = target_business),
  upto AS (SELECT sum(o.net) AS total, max(o.net) FILTER (WHERE o.document_id = target_document) AS this
    FROM owed o CROSS JOIN bill WHERE (o.created_at, o.document_id) <= (bill.created_at, bill.document_id)),
  paid AS (SELECT COALESCE(sum(p.amount), 0) AS total FROM hardware_fitter_payouts p
    JOIN business_expenses e ON e.business_id = p.business_id AND e.id = p.expense_id
    JOIN bill ON bill.fitter_id = p.fitter_id WHERE p.business_id = target_business AND e.voided_at IS NULL)
  SELECT COALESCE(upto.this > 0 AND paid.total >= upto.total, FALSE) FROM upto CROSS JOIN paid;
$$;

ALTER TABLE hardware_fitter_bills
  ADD COLUMN changed_by BIGINT REFERENCES users(id),
  ADD COLUMN changed_at TIMESTAMPTZ,
  ADD CONSTRAINT hardware_fitter_bills_changed CHECK ((changed_by IS NULL) = (changed_at IS NULL));

-- A bill's commission is kept as it was worked out; only its fitter changes,
-- and only until the commission on it is paid.
CREATE FUNCTION hardware_fitter_bills_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE words RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commission records are never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id <> OLD.document_id OR NEW.commission <> OLD.commission OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.changed_at IS NULL OR NEW.changed_by IS NULL THEN
    RAISE EXCEPTION 'Commission records are kept as they were made' USING ERRCODE = '23514';
  END IF;
  IF NEW.fitter_id <> OLD.fitter_id AND hardware_fitter_bill_paid(OLD.business_id, OLD.document_id) THEN
    SELECT d.document_no, f.name INTO words FROM business_documents d JOIN hardware_fitters f ON f.business_id = d.business_id AND f.id = OLD.fitter_id
    WHERE d.business_id = OLD.business_id AND d.id = OLD.document_id;
    RAISE EXCEPTION 'The commission on % is paid to %: its fitter no longer changes', words.document_no, words.name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER hardware_fitter_bills_append_only ON hardware_fitter_bills;
CREATE TRIGGER hardware_fitter_bills_guard BEFORE UPDATE OR DELETE ON hardware_fitter_bills
  FOR EACH ROW EXECUTE FUNCTION hardware_fitter_bills_guard();

-- The fitter a sales order names: every invoice its dispatches raise earns
-- them their commission, as a bill naming them would.
CREATE TABLE hardware_order_fitters (
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  fitter_id BIGINT NOT NULL,
  set_by BIGINT NOT NULL REFERENCES users(id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, order_id),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  FOREIGN KEY (business_id, fitter_id) REFERENCES hardware_fitters(business_id, id)
);

-- --- Hardware: the rate board's history ----------------------------------------------------------

-- Each item's price changes, newest first, as the activity log keeps them.
CREATE INDEX business_audit_price_changes ON business_audit(business_id, entity_id, id DESC) WHERE action = 'catalog.price_changed';

-- Down Migration
DROP INDEX business_audit_price_changes;
DROP TABLE hardware_order_fitters;
DROP TRIGGER hardware_fitter_bills_guard ON hardware_fitter_bills;
DROP FUNCTION hardware_fitter_bills_guard();
CREATE TRIGGER hardware_fitter_bills_append_only BEFORE UPDATE OR DELETE ON hardware_fitter_bills
  FOR EACH ROW EXECUTE FUNCTION hardware_append_only();
ALTER TABLE hardware_fitter_bills DROP CONSTRAINT hardware_fitter_bills_changed, DROP COLUMN changed_at, DROP COLUMN changed_by;
DROP FUNCTION hardware_fitter_bill_paid(BIGINT, BIGINT);
DROP TABLE hardware_calculations;
DROP FUNCTION hardware_calculations_fixed();
DROP TRIGGER business_return_lines_hardware_tint ON business_return_lines;
DROP FUNCTION hardware_tint_line_return();
DROP TABLE hardware_tint_jobs;
DROP FUNCTION hardware_tint_jobs_guard();
DROP TABLE hardware_quotation_tints;
DROP TABLE hardware_shades;
DROP FUNCTION hardware_shades_guard();
DROP TABLE hardware_tint_settings;
DELETE FROM business_capabilities WHERE capability = 'hardware_tinting';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'hardware_tinting');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'hardware_tinting');
DELETE FROM business_permissions WHERE module_code = 'hardware_tinting';
DELETE FROM platform_module_business_types WHERE module_code = 'hardware_tinting';
DELETE FROM platform_module_dependencies WHERE module_code = 'hardware_tinting';
DELETE FROM platform_modules WHERE code = 'hardware_tinting';
UPDATE platform_modules SET name = 'Tile & paint calculators',
  description = 'Boxes of tiles and litres and tins of paint worked out from the area, on Quick bill and on quotations.'
WHERE code = 'hardware_calculators';
DROP TABLE agri_settings;
DROP TRIGGER business_licence_sources_guard ON business_licence_sources;
DROP TRIGGER business_licence_principals_guard ON business_licence_principals;
DROP TRIGGER business_licence_endorsements_guard ON business_licence_endorsements;
DROP FUNCTION business_licence_records_guard();
DROP TABLE business_licence_sources, business_licence_principals, business_licence_endorsements, business_licence_files;
DROP FUNCTION business_licence_files_fixed();
CREATE OR REPLACE FUNCTION agri_sale_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION business_licence_held(target_business BIGINT, target_location BIGINT, category TEXT, on_day DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM business_licences l WHERE l.business_id = target_business AND l.location_id = target_location
    AND l.active AND category = ANY (l.covers) AND l.valid_from <= on_day AND (l.valid_until IS NULL OR l.valid_until >= on_day));
$$;
DROP FUNCTION business_licence_covering(BIGINT, BIGINT, TEXT, DATE, TEXT);
DROP FUNCTION business_licence_in_force(business_licences, DATE);
ALTER TABLE business_licences DROP CONSTRAINT business_licences_renewal_dated, DROP CONSTRAINT business_licences_renewal,
  DROP CONSTRAINT business_licences_qualification, DROP CONSTRAINT business_licences_qualified_person,
  DROP COLUMN renewal_reference, DROP COLUMN renewal_applied_on, DROP COLUMN qualification_exemption, DROP COLUMN qualification_certificate,
  DROP COLUMN qualification, DROP COLUMN qualified_person, DROP COLUMN sells_to;
DROP TABLE platform_licence_kinds;
