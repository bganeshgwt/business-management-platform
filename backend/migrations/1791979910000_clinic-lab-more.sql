-- Up Migration
-- A clinic's lab gathered by department, the tests a doctor orders billed
-- later from their order or with the visit's bill, and the clinic's own drug
-- list behind the prescription, with its warnings.
--
--   lab_departments          the lab's departments: the eight every lab has
--                            (haematology, biochemistry, microbiology, serology /
--                            immunology, clinical pathology, histopathology,
--                            imaging, other), made with each clinic, and any
--                            the lab adds. Renamed or switched off, never
--                            deleted; Other stays on, as a test starts there.
--   lab_tests.department_id  each test and profile is in one department; a
--                            test saved without one, and every test kept
--                            before, is in Other.
--   lab_department_staff     who works in a department (a lab technician):
--                            their worklist opens on their departments first.
--                            A preference of the worklist, not an access rule.
--   lab_order_tests          each ordered test is billed on one bill line,
--                            once (document_line_id; a profile's tests share
--                            the profile's line), and may be cancelled with its
--                            reason while its order is open. A database guard
--                            keeps a test's bill line once set, takes only a
--                            line of a bill to the order's own patient that no
--                            other test holds, never bills a cancelled test,
--                            keeps a cancellation, and deletes no test. The
--                            tests of orders billed before are linked to the
--                            lines of their bill.
--   health_clinic_drugs      the clinic's own drug list: generic name, brand
--                            names, strength, form, route, the usual dose and
--                            how often, the most a day (amount and unit) and
--                            the allergy group; switched off, never deleted. A
--                            pharmacy's drug master stays its own.
--   health_prescription_items  a line names the medicine of the list it was
--                            picked from (drug_id; none: written by hand, not on
--                            the list) and keeps the warnings the doctor was
--                            shown, each with the reason they gave to go on:
--                            clinical data, kept as the rest of the
--                            consultation is.
-- A test billed or cancelled reaches the lab's screens on the business's live
-- stream as a change of its order (lab_order_tests_live).

-- --- The lab's departments ----------------------------------------------------

CREATE TABLE lab_departments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- One of the eight every lab has; NULL for one the lab added.
  code TEXT CHECK (code IN ('haematology', 'biochemistry', 'microbiology', 'serology', 'clinical_pathology', 'histopathology', 'imaging', 'other')),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order SMALLINT NOT NULL DEFAULT 100,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, code),
  CONSTRAINT lab_departments_other_on CHECK (active OR code IS DISTINCT FROM 'other')
);
CREATE UNIQUE INDEX lab_departments_name ON lab_departments(business_id, lower(name));

-- The eight every lab has, for one clinic (nothing for a business of another type).
CREATE FUNCTION lab_default_departments(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO lab_departments (business_id, code, name, sort_order)
  SELECT b.id, d.code, d.name, d.sort_order FROM businesses b,
    (VALUES ('haematology', 'Haematology', 10), ('biochemistry', 'Biochemistry', 20), ('microbiology', 'Microbiology', 30),
            ('serology', 'Serology / immunology', 40), ('clinical_pathology', 'Clinical pathology', 50), ('histopathology', 'Histopathology', 60),
            ('imaging', 'Imaging', 70), ('other', 'Other', 80)) AS d(code, name, sort_order)
  WHERE b.id = target AND b.business_type = 'healthcare'
  ON CONFLICT DO NOTHING;
$$;
CREATE FUNCTION businesses_lab_departments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lab_default_departments(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER businesses_default_lab_departments AFTER INSERT ON businesses
  FOR EACH ROW WHEN (NEW.business_type = 'healthcare') EXECUTE FUNCTION businesses_lab_departments();
SELECT lab_default_departments(id) FROM businesses WHERE business_type = 'healthcare';

ALTER TABLE lab_tests ADD COLUMN department_id BIGINT;
UPDATE lab_tests t SET department_id = d.id FROM lab_departments d WHERE d.business_id = t.business_id AND d.code = 'other';
ALTER TABLE lab_tests ALTER COLUMN department_id SET NOT NULL,
  ADD CONSTRAINT lab_tests_department_fkey FOREIGN KEY (business_id, department_id) REFERENCES lab_departments(business_id, id);
CREATE INDEX lab_tests_by_department ON lab_tests(business_id, department_id);
-- A test saved without a department is in Other.
CREATE FUNCTION lab_tests_department_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.department_id IS NULL THEN
    SELECT id INTO NEW.department_id FROM lab_departments WHERE business_id = NEW.business_id AND code = 'other';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_tests_department_default BEFORE INSERT ON lab_tests
  FOR EACH ROW EXECUTE FUNCTION lab_tests_department_default();

-- Who works in a department: a member of the clinic's staff.
CREATE TABLE lab_department_staff (
  business_id BIGINT NOT NULL,
  department_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, department_id, user_id),
  FOREIGN KEY (business_id, department_id) REFERENCES lab_departments(business_id, id),
  FOREIGN KEY (business_id, user_id) REFERENCES business_memberships(business_id, user_id) ON DELETE CASCADE
);
CREATE INDEX lab_department_staff_user ON lab_department_staff(business_id, user_id);

-- --- An ordered test's bill line, and its cancellation ------------------------------

ALTER TABLE lab_order_tests
  ADD COLUMN document_line_id BIGINT,
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by BIGINT REFERENCES users(id),
  ADD COLUMN cancel_reason VARCHAR(300),
  ADD CONSTRAINT lab_order_tests_line_fkey FOREIGN KEY (business_id, document_line_id) REFERENCES business_document_lines(business_id, id),
  ADD CONSTRAINT lab_order_tests_cancelled CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL) AND (cancelled_at IS NULL) = (cancelled_by IS NULL));
CREATE INDEX lab_order_tests_billed_line ON lab_order_tests(business_id, document_line_id) WHERE document_line_id IS NOT NULL;

-- Orders billed as they were ordered: each test on its bill's line for it (a
-- profile's tests on the profile's line, as the bill was made).
UPDATE lab_order_tests ot SET document_line_id = (
  SELECT l.id FROM business_document_lines l
  WHERE l.business_id = o.business_id AND l.document_id = o.document_id
    AND l.sku_id = (CASE WHEN ot.profile_id IS NOT NULL THEN (SELECT p.sku_id FROM lab_tests p WHERE p.business_id = ot.business_id AND p.id = ot.profile_id)
                         ELSE (SELECT t.sku_id FROM lab_tests t WHERE t.business_id = ot.business_id AND t.id = ot.test_id) END)
  ORDER BY l.id LIMIT 1)
FROM lab_orders o WHERE o.business_id = ot.business_id AND o.id = ot.order_id AND o.document_id IS NOT NULL;

-- A test is billed once, on a sale to the order's own patient, on a line no
-- other test holds (the tests of one profile on one order share theirs); a
-- cancelled test is not billed and stays cancelled; no ordered test is deleted.
CREATE FUNCTION lab_order_test_billing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An ordered test is not deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.document_line_id IS NOT NULL AND NEW.document_line_id IS DISTINCT FROM OLD.document_line_id THEN
    RAISE EXCEPTION 'This test is billed already; a test is billed only once' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by) THEN
    RAISE EXCEPTION 'A cancelled test stays cancelled' USING ERRCODE = '23514';
  END IF;
  IF NEW.document_line_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.document_line_id IS NULL) THEN
    IF NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'A cancelled test is not billed' USING ERRCODE = '23514';
    END IF;
    SELECT d.kind, d.contact_id INTO bill FROM business_document_lines l
      JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
    WHERE l.business_id = NEW.business_id AND l.id = NEW.document_line_id;
    IF bill.kind IS DISTINCT FROM 'sale' OR bill.contact_id IS DISTINCT FROM (SELECT o.contact_id FROM lab_orders o WHERE o.business_id = NEW.business_id AND o.id = NEW.order_id) THEN
      RAISE EXCEPTION 'A test is billed on a bill to its own patient' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM lab_order_tests x WHERE x.business_id = NEW.business_id AND x.document_line_id = NEW.document_line_id AND x.id <> NEW.id
               AND (x.order_id <> NEW.order_id OR NEW.profile_id IS NULL OR x.profile_id IS DISTINCT FROM NEW.profile_id)) THEN
      RAISE EXCEPTION 'That bill line is another test''s already' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_order_test_billing BEFORE INSERT OR UPDATE OR DELETE ON lab_order_tests
  FOR EACH ROW EXECUTE FUNCTION lab_order_test_billing();

-- A test billed or cancelled is its order's change, on the live stream.
CREATE TRIGGER lab_order_tests_live AFTER INSERT OR UPDATE OR DELETE ON lab_order_tests
  FOR EACH ROW EXECUTE FUNCTION live_lab_order_part();

-- --- The clinic's drug list -----------------------------------------------------

CREATE TABLE health_clinic_drugs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  generic_name VARCHAR(150) NOT NULL CHECK (btrim(generic_name) <> ''),
  brand_names VARCHAR(300),
  strength VARCHAR(60),
  form VARCHAR(40),
  route VARCHAR(40),
  usual_dose VARCHAR(60),
  usual_frequency VARCHAR(60),
  -- The most a day, in one of the units the dose check works in.
  max_daily_amount NUMERIC(12,3) CHECK (max_daily_amount > 0),
  max_daily_unit TEXT CHECK (max_daily_unit IN ('mg', 'g', 'mcg', 'ml', 'IU', 'units', 'tablets', 'capsules', 'puffs', 'drops', 'sachets')),
  allergy_group VARCHAR(80),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CONSTRAINT health_clinic_drugs_max_daily CHECK ((max_daily_amount IS NULL) = (max_daily_unit IS NULL))
);
-- One entry per generic, strength and form.
CREATE UNIQUE INDEX health_clinic_drugs_entry ON health_clinic_drugs(business_id, lower(generic_name), lower(COALESCE(strength, '')), lower(COALESCE(form, '')));

-- Every warning kept with a prescription line has the doctor's reason.
CREATE FUNCTION health_warnings_answered(warnings JSONB) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(warnings) <> 'array' THEN FALSE
    ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(warnings) w
      WHERE jsonb_typeof(w->'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(w->'reason') IS DISTINCT FROM 'string' OR btrim(w->>'reason') = '') END
$$;
ALTER TABLE health_prescription_items
  ADD COLUMN drug_id BIGINT,
  ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]',
  ADD CONSTRAINT health_prescription_items_drug_fkey FOREIGN KEY (business_id, drug_id) REFERENCES health_clinic_drugs(business_id, id),
  ADD CONSTRAINT health_prescription_items_warnings_answered CHECK (health_warnings_answered(warnings));

-- Down Migration
ALTER TABLE health_prescription_items DROP CONSTRAINT health_prescription_items_warnings_answered, DROP CONSTRAINT health_prescription_items_drug_fkey,
  DROP COLUMN warnings, DROP COLUMN drug_id;
DROP FUNCTION health_warnings_answered(JSONB);
DROP TABLE health_clinic_drugs;

DROP TRIGGER lab_order_tests_live ON lab_order_tests;
DROP TRIGGER lab_order_test_billing ON lab_order_tests;
DROP FUNCTION lab_order_test_billing();
DROP INDEX lab_order_tests_billed_line;
ALTER TABLE lab_order_tests DROP CONSTRAINT lab_order_tests_cancelled, DROP CONSTRAINT lab_order_tests_line_fkey,
  DROP COLUMN cancel_reason, DROP COLUMN cancelled_by, DROP COLUMN cancelled_at, DROP COLUMN document_line_id;

DROP TABLE lab_department_staff;
DROP TRIGGER lab_tests_department_default ON lab_tests;
DROP FUNCTION lab_tests_department_default();
DROP INDEX lab_tests_by_department;
ALTER TABLE lab_tests DROP CONSTRAINT lab_tests_department_fkey, DROP COLUMN department_id;
DROP TRIGGER businesses_default_lab_departments ON businesses;
DROP FUNCTION businesses_lab_departments();
DROP FUNCTION lab_default_departments(BIGINT);
DROP TABLE lab_departments;
