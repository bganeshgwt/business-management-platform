-- Up Migration

-- Round 2 (8 Oct 2026, builder R2-HEALTH): pharmacy and clinic / lab rules,
-- standard Indian practice (docs/DECISIONS_ROUND2.md › Pharmacy & clinic;
-- review with a pharmacist, a doctor and a legal adviser before going live).
--
-- Pharmacy (module "pharmacy"): a drug master on the shared catalogue (salt,
-- strength, form, maker, schedule, pack, cold chain), prescriptions for
-- Schedule H / H1 / X with a scan, the H1 and Schedule X registers filled in
-- automatically, the registered pharmacist's sign-off by PIN for Schedule X,
-- batch recalls that block a batch, and expiry / breakage returns to the
-- distributor as debit notes.
-- Clinic / lab (modules "patients" and "lab"): patients with DPDP consent,
-- consultations (vitals, diagnosis, prescription), the lab's tests with
-- reference ranges, samples with barcodes, results, the pathologist's
-- approval by PIN and outside-lab referrals. Clinical data needs the new
-- permissions patients.view_clinical / patients.edit_clinical; every view of
-- it is written to business_audit by the service.

-- --- Modules ---------------------------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('pharmacy', 'Pharmacy rules', 'Drug master (salt, strength, schedule, pack), prescriptions for Schedule H, H1 and X, the H1 and Schedule X registers, pharmacist sign-off, batch recalls and expiry returns to distributors.', 'optional', 240),
 ('patients', 'Patient records', 'Patients with consent, consultations (vitals, diagnosis, prescription) and follow-ups. Clinical notes only for clinical roles; every view is logged.', 'optional', 244),
 ('lab', 'Laboratory', 'Tests with reference ranges, samples with barcodes, result entry, pathologist approval, printed reports and outside-lab referrals.', 'optional', 246);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('pharmacy', 'sales'), ('pharmacy', 'batches'), ('pharmacy', 'contacts'),
 ('patients', 'contacts'), ('patients', 'appointments'),
 ('lab', 'patients'), ('lab', 'sales');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('pharmacy', 'pharmacy', TRUE), ('patients', 'healthcare', TRUE), ('lab', 'healthcare', TRUE);

-- Two clinical actions. Any later change to this CHECK must keep the whole list.
ALTER TABLE business_permissions DROP CONSTRAINT business_permissions_action_check,
  ADD CONSTRAINT business_permissions_action_check CHECK (action IN ('view', 'create', 'edit', 'approve', 'cancel', 'refund', 'export', 'print',
    'discount', 'assign', 'review', 'manage', 'view_clinical', 'edit_clinical'));

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('pharmacy', 'view', 'See the drug master, prescriptions, the H1 and Schedule X registers, recalls and expiry returns', 430),
 ('pharmacy', 'create', 'Sell prescription medicines (Schedule H, H1, X) with the prescription', 431),
 ('pharmacy', 'edit', 'Change the drug master, licence numbers, pharmacists and pharmacy settings', 432),
 ('pharmacy', 'approve', 'Recall and block a batch; return expired or broken stock to the distributor', 433),
 ('pharmacy', 'export', 'Export the registers and pharmacy reports', 434),
 ('pharmacy', 'print', 'Print the registers and debit notes', 435),
 ('patients', 'view', 'See patients (name, phone, age, sex), consent and visits, not clinical notes', 440),
 ('patients', 'create', 'Register patients and record their consent', 441),
 ('patients', 'edit', 'Change patient details and record a withdrawal of consent', 442),
 ('patients', 'view_clinical', 'See clinical records: vitals, complaints, diagnoses, prescriptions and lab results', 443),
 ('patients', 'edit_clinical', 'Write consultations, diagnoses and prescriptions', 444),
 ('patients', 'export', 'Export the patient list', 445),
 ('patients', 'print', 'Print prescriptions', 446),
 ('lab', 'view', 'See lab orders, samples and whether a report is ready', 450),
 ('lab', 'create', 'Order tests, collect and receive samples, send tests to an outside lab', 451),
 ('lab', 'edit', 'Enter lab results and keep the test catalogue', 452),
 ('lab', 'approve', 'Approve lab reports (pathologist)', 453),
 ('lab', 'print', 'Print lab reports', 454),
 ('lab', 'export', 'Export lab orders', 455)
) AS p(module_code, action, name, sort_order);

-- --- Roles: templates for one kind of business ---------------------------------------------

-- A template may belong to some business types only (a doctor in a clinic,
-- a pharmacist in a pharmacy). NULL = every type, as before.
ALTER TABLE business_role_templates ADD COLUMN business_types TEXT[];

INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types) VALUES
 ('pharmacist', 'Pharmacist', 'Registered pharmacist: sells prescription medicines, keeps the registers, signs off Schedule X, recalls batches and returns expired stock.', FALSE, 32, ARRAY['pharmacy']),
 ('doctor', 'Doctor', 'Sees patients: consultations, diagnoses, prescriptions, lab orders and results. The only role that reads clinical notes.', FALSE, 33, ARRAY['healthcare']),
 ('lab_technician', 'Lab technician', 'Collects and receives samples and enters results. Sees no consultation notes.', FALSE, 34, ARRAY['healthcare']),
 ('pathologist', 'Pathologist', 'Checks and approves lab reports with their PIN.', FALSE, 35, ARRAY['healthcare']);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE code IN ('pharmacy.view', 'pharmacy.create', 'pharmacy.edit', 'pharmacy.approve', 'pharmacy.export', 'pharmacy.print',
  'patients.view', 'patients.create', 'patients.edit', 'patients.export', 'lab.view', 'lab.create', 'lab.export')
UNION ALL SELECT 'cashier', unnest(ARRAY['pharmacy.view', 'pharmacy.create', 'patients.view', 'patients.create', 'patients.edit', 'lab.view', 'lab.create'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['pharmacy.view'])
UNION ALL SELECT 'accountant', unnest(ARRAY['pharmacy.view', 'pharmacy.export', 'pharmacy.print', 'patients.view', 'patients.export', 'lab.view', 'lab.export'])
UNION ALL SELECT 'viewer', unnest(ARRAY['pharmacy.view', 'patients.view', 'lab.view'])
UNION ALL SELECT 'pharmacist', unnest(ARRAY['catalog.view', 'catalog.edit', 'catalog.print', 'contacts.view', 'contacts.create', 'sales.view', 'sales.create', 'sales.edit',
  'sales.refund', 'sales.print', 'inventory.view', 'purchasing.view', 'purchasing.refund', 'receivables.view',
  'pharmacy.view', 'pharmacy.create', 'pharmacy.edit', 'pharmacy.approve', 'pharmacy.export', 'pharmacy.print'])
UNION ALL SELECT 'doctor', unnest(ARRAY['catalog.view', 'contacts.view', 'contacts.create', 'sales.view', 'appointments.view', 'appointments.create', 'appointments.edit',
  'patients.view', 'patients.create', 'patients.edit', 'patients.view_clinical', 'patients.edit_clinical', 'patients.export', 'patients.print',
  'lab.view', 'lab.create', 'lab.print'])
UNION ALL SELECT 'lab_technician', unnest(ARRAY['catalog.view', 'contacts.view', 'patients.view', 'lab.view', 'lab.create', 'lab.edit', 'lab.print'])
UNION ALL SELECT 'pathologist', unnest(ARRAY['catalog.view', 'contacts.view', 'patients.view', 'lab.view', 'lab.create', 'lab.edit', 'lab.approve', 'lab.print', 'lab.export']);

-- Every business gets the templates of its own type (and the shared ones).
CREATE OR REPLACE FUNCTION business_seed_roles(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_roles (business_id, template_code, name, description, full_access)
  SELECT target, t.code, t.name, t.description, t.full_access FROM business_role_templates t
  WHERE t.business_types IS NULL OR (SELECT business_type FROM businesses WHERE id = target) = ANY (t.business_types)
  ON CONFLICT (business_id, template_code) DO NOTHING;
  INSERT INTO business_role_permissions (business_id, role_id, permission_code)
  SELECT r.business_id, r.id, tp.permission_code
  FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
  WHERE r.business_id = target AND NOT r.full_access
    AND NOT EXISTS (SELECT 1 FROM business_role_permissions x WHERE x.role_id = r.id)
  ON CONFLICT DO NOTHING;
$$;

-- Existing businesses: the new modules' permissions on their copies of the
-- shared templates, and the new roles of their type.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code IN ('pharmacy', 'patients', 'lab')
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;
SELECT business_seed_roles(id) FROM businesses WHERE business_type IN ('pharmacy', 'healthcare');

INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'pharmacy'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, 'patients' FROM businesses b
WHERE b.business_type = 'healthcare'
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'contacts')
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'appointments')
ON CONFLICT DO NOTHING;
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, 'lab' FROM businesses b
WHERE b.business_type = 'healthcare'
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'patients')
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'sales')
ON CONFLICT DO NOTHING;

-- --- Shared pieces ------------------------------------------------------------------------------

-- Rows kept as written: nothing changes except the time stamp (the demo
-- set-up dates its sample records), and nothing is deleted.
CREATE FUNCTION health_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Posted % rows cannot be changed', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Running numbers per business: patient IDs, visits, lab orders, sample
-- barcodes and debit notes (UPDATE … RETURNING inside the posting).
CREATE TABLE health_counters (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('patient', 'visit', 'lab_order', 'sample', 'debit_note')),
  next_number INT NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (business_id, kind)
);

-- Settings for a pharmacy or a clinic (one row, made on first save).
CREATE TABLE health_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- Drug licences: 20 / 21 retail, 20B / 21B wholesale, 20F Schedule X retail.
  drug_licence_20 VARCHAR(60),
  drug_licence_21 VARCHAR(60),
  drug_licence_20b VARCHAR(60),
  drug_licence_21b VARCHAR(60),
  drug_licence_20f VARCHAR(60),
  h1_retention_years SMALLINT NOT NULL DEFAULT 3 CHECK (h1_retention_years BETWEEN 1 AND 30),
  x_retention_years SMALLINT NOT NULL DEFAULT 2 CHECK (x_retention_years BETWEEN 1 AND 30),
  prescription_retention_years SMALLINT NOT NULL DEFAULT 2 CHECK (prescription_retention_years BETWEEN 1 AND 30),
  -- A Schedule H / H1 / X sale needs a photo or scan of the prescription.
  rx_scan_required BOOLEAN NOT NULL DEFAULT TRUE,
  near_expiry_days SMALLINT NOT NULL DEFAULT 90 CHECK (near_expiry_days BETWEEN 7 AND 365),
  -- Clinic and lab.
  lab_name VARCHAR(150),
  lab_registration VARCHAR(120),
  report_footer VARCHAR(500),
  clinical_retention_years SMALLINT NOT NULL DEFAULT 3 CHECK (clinical_retention_years BETWEEN 1 AND 30),
  consent_version VARCHAR(20) NOT NULL DEFAULT 'v1',
  consent_notice TEXT NOT NULL DEFAULT 'We collect your name, contact details, age, sex and the health information you share with us, your vitals, diagnoses, prescriptions and test results, only to treat you, keep your medical record as the law requires, bill you and send you your reports. Only the doctors and lab staff who look after you can see your clinical record, and every look is logged. You may withdraw this consent at any time at the front desk; records the law requires us to keep are then kept but not used for anything else. Questions or complaints: ask the front desk for the clinic''s grievance officer.' CHECK (length(consent_notice) BETWEEN 50 AND 4000),
  referral_commission_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  referral_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (referral_commission_percent BETWEEN 0 AND 50),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- People who sign: a registered pharmacist (Schedule X), a doctor (their
-- registration number on the prescription), a pathologist (lab reports).
-- Each is a member of the business who signs with their own PIN.
CREATE TABLE health_signatories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('pharmacist', 'doctor', 'pathologist')),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  qualification VARCHAR(120),
  registration_no VARCHAR(60) NOT NULL CHECK (btrim(registration_no) <> ''),
  council VARCHAR(150),
  -- A doctor's appointment calendar (business_resources).
  resource_id BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, kind, user_id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id)
);
CREATE UNIQUE INDEX health_signatories_resource ON health_signatories(business_id, resource_id) WHERE resource_id IS NOT NULL AND active;

-- --- Pharmacy --------------------------------------------------------------------------------

CREATE TABLE pharmacy_drugs (
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  -- The salt(s), e.g. "Amoxicillin + Clavulanic acid".
  composition VARCHAR(300) NOT NULL CHECK (btrim(composition) <> ''),
  -- Substitutes: the same salt and strength, however it was typed.
  composition_key VARCHAR(300) GENERATED ALWAYS AS (lower(regexp_replace(btrim(composition), '\s+', ' ', 'g'))) STORED,
  strength VARCHAR(60),
  form TEXT NOT NULL DEFAULT 'tablet' CHECK (form IN ('tablet', 'capsule', 'syrup', 'suspension', 'injection', 'ointment', 'cream', 'drops', 'inhaler',
    'powder', 'gel', 'solution', 'device', 'other')),
  manufacturer VARCHAR(150),
  schedule TEXT NOT NULL DEFAULT 'none' CHECK (schedule IN ('none', 'G', 'H', 'H1', 'X', 'narcotic')),
  -- The pack as printed: a strip of 15, 10 strips to a box.
  units_per_strip SMALLINT CHECK (units_per_strip BETWEEN 1 AND 1000),
  strips_per_box SMALLINT CHECK (strips_per_box BETWEEN 1 AND 1000),
  -- A strip may be cut and sold by the tablet.
  loose_sale BOOLEAN NOT NULL DEFAULT FALSE,
  cold_chain BOOLEAN NOT NULL DEFAULT FALSE,
  storage VARCHAR(150),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (NOT loose_sale OR units_per_strip IS NOT NULL)
);
CREATE INDEX pharmacy_drugs_composition ON pharmacy_drugs(business_id, composition_key);
CREATE INDEX pharmacy_drugs_schedule ON pharmacy_drugs(business_id, schedule) WHERE schedule <> 'none';

-- A photo or scan of a prescription, kept in private_uploads/health/<business>/.
CREATE TABLE health_files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('prescription')),
  stored_name VARCHAR(80) NOT NULL,
  file_name VARCHAR(160) NOT NULL,
  mime_type VARCHAR(40) NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes INT NOT NULL CHECK (size_bytes > 0),
  uploaded_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (stored_name)
);

-- The prescription a sale of Schedule H / H1 / X medicines was made on.
CREATE TABLE pharmacy_prescriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  document_id BIGINT NOT NULL,
  contact_id BIGINT,
  patient_name VARCHAR(150) NOT NULL CHECK (btrim(patient_name) <> ''),
  patient_phone VARCHAR(30),
  patient_age SMALLINT CHECK (patient_age BETWEEN 0 AND 130),
  patient_address VARCHAR(300),
  doctor_name VARCHAR(150) NOT NULL CHECK (btrim(doctor_name) <> ''),
  doctor_reg_no VARCHAR(60) NOT NULL CHECK (btrim(doctor_reg_no) <> ''),
  doctor_address VARCHAR(300),
  prescribed_on DATE NOT NULL,
  file_id BIGINT,
  -- The pharmacist under whose supervision it was sold (Rule 65), if signed.
  signatory_id BIGINT,
  retain_until DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (file_id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, file_id) REFERENCES health_files(business_id, id),
  FOREIGN KEY (business_id, signatory_id) REFERENCES health_signatories(business_id, id),
  CHECK (prescribed_on <= created_at::date + 1)
);
CREATE INDEX pharmacy_prescriptions_time ON pharmacy_prescriptions(business_id, created_at DESC);
CREATE TRIGGER pharmacy_prescriptions_append_only BEFORE UPDATE OR DELETE ON pharmacy_prescriptions
  FOR EACH ROW EXECUTE FUNCTION health_append_only();

-- The H1, Schedule X and narcotic registers: one entry per sold line, written
-- with the sale (Rule 65: prescriber, patient, drug, quantity, batch).
CREATE TABLE pharmacy_register_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  register TEXT NOT NULL CHECK (register IN ('H1', 'X', 'narcotic')),
  prescription_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  drug_name VARCHAR(150) NOT NULL,
  composition VARCHAR(300),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(20) NOT NULL,
  lot_code VARCHAR(100) NOT NULL,
  expires_on DATE,
  patient_name VARCHAR(150) NOT NULL,
  patient_address VARCHAR(300),
  doctor_name VARCHAR(150) NOT NULL,
  doctor_reg_no VARCHAR(60) NOT NULL,
  doctor_address VARCHAR(300),
  signatory_id BIGINT,
  retain_until DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, line_id),
  FOREIGN KEY (business_id, prescription_id) REFERENCES pharmacy_prescriptions(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, signatory_id) REFERENCES health_signatories(business_id, id),
  CHECK (register = 'H1' OR signatory_id IS NOT NULL)
);
CREATE INDEX pharmacy_register_entries_time ON pharmacy_register_entries(business_id, register, created_at DESC);
CREATE TRIGGER pharmacy_register_entries_append_only BEFORE UPDATE OR DELETE ON pharmacy_register_entries
  FOR EACH ROW EXECUTE FUNCTION health_append_only();

-- A Schedule H / H1 / X / narcotic medicine is sold only with a prescription:
-- the sale's prescription must exist when its transaction commits (so a plain
-- Quick bill cannot sell one past the pharmacy counter).
CREATE FUNCTION pharmacy_scheduled_sale_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE drug TEXT;
BEGIN
  SELECT s.label INTO drug FROM pharmacy_drugs p
    JOIN catalog_skus s ON s.business_id = p.business_id AND s.id = p.sku_id
    JOIN business_documents d ON d.business_id = NEW.business_id AND d.id = NEW.document_id AND d.kind = 'sale'
    WHERE p.business_id = NEW.business_id AND p.sku_id = NEW.sku_id AND p.schedule IN ('H', 'H1', 'X', 'narcotic')
      AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = NEW.business_id AND c.capability = 'pharmacy');
  IF drug IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pharmacy_prescriptions r WHERE r.business_id = NEW.business_id AND r.document_id = NEW.document_id) THEN
    RAISE EXCEPTION '% is a prescription medicine. Sell it at Pharmacy › Prescription sale with the doctor''s prescription.', drug USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pharmacy_scheduled_sale_check AFTER INSERT ON business_document_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_scheduled_sale_check();

-- A recalled batch: every sale of it can be traced; while blocked it cannot
-- be sold or moved (it can still go back to the distributor or be written off).
CREATE TABLE pharmacy_recalls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  lot_code VARCHAR(100) NOT NULL CHECK (btrim(lot_code) <> ''),
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  -- The regulator's or maker's alert number.
  reference VARCHAR(120),
  blocked BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  close_note VARCHAR(300),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status = 'open' OR NOT blocked)
);
CREATE UNIQUE INDEX pharmacy_recalls_open ON pharmacy_recalls(business_id, sku_id, lot_code) WHERE status = 'open';

CREATE FUNCTION pharmacy_recalled_lot_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE hit RECORD;
BEGIN
  IF NEW.quantity >= 0 OR NEW.return_id IS NOT NULL OR NEW.adjustment_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.label, l.lot_code INTO hit FROM business_stock_lots l
    JOIN catalog_skus s ON s.business_id = l.business_id AND s.id = l.sku_id
    JOIN pharmacy_recalls r ON r.business_id = l.business_id AND r.sku_id = l.sku_id AND r.lot_code = l.lot_code AND r.status = 'open' AND r.blocked
    WHERE l.business_id = NEW.business_id AND l.id = NEW.lot_id;
  IF FOUND THEN
    RAISE EXCEPTION 'Batch % of % is recalled and blocked: it cannot be sold or moved', hit.lot_code, hit.label USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_recalled_lot_check BEFORE INSERT ON business_stock_movements
  FOR EACH ROW EXECUTE FUNCTION pharmacy_recalled_lot_check();

-- Expired, near-expiry, broken or recalled stock sent back to the distributor.
-- The stock leaves through a supplier return on the purchase that brought the
-- batch (what is owed to the supplier goes down by its value); a batch with
-- no such purchase is written off. The distributor's credit note closes it.
CREATE TABLE pharmacy_debit_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  note_no VARCHAR(30) NOT NULL,
  contact_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('expired', 'near_expiry', 'breakage', 'recall', 'other')),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'credited')),
  -- The value claimed: supplier returns at the purchase price with GST.
  claimed NUMERIC(14,2) NOT NULL CHECK (claimed >= 0),
  written_off NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (written_off >= 0),
  credit_note_no VARCHAR(60),
  credit_note_date DATE,
  credited_amount NUMERIC(14,2) CHECK (credited_amount >= 0),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_by BIGINT REFERENCES users(id),
  credited_at TIMESTAMPTZ,
  UNIQUE (business_id, id),
  UNIQUE (business_id, note_no),
  UNIQUE (business_id, request_key),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CHECK ((status = 'credited') = (credited_at IS NOT NULL AND credit_note_no IS NOT NULL AND credited_amount IS NOT NULL))
);
CREATE INDEX pharmacy_debit_notes_time ON pharmacy_debit_notes(business_id, created_at DESC);

CREATE TABLE pharmacy_debit_note_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  debit_note_id BIGINT NOT NULL,
  lot_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  lot_code VARCHAR(100) NOT NULL,
  expires_on DATE,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(20) NOT NULL,
  value NUMERIC(14,2) NOT NULL CHECK (value >= 0),
  return_id BIGINT,
  adjustment_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, debit_note_id) REFERENCES pharmacy_debit_notes(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (num_nonnulls(return_id, adjustment_id) = 1)
);
CREATE INDEX pharmacy_debit_note_lines_note ON pharmacy_debit_note_lines(business_id, debit_note_id);
CREATE TRIGGER pharmacy_debit_note_lines_append_only BEFORE UPDATE OR DELETE ON pharmacy_debit_note_lines
  FOR EACH ROW EXECUTE FUNCTION health_append_only();

-- --- Clinic: patients and consent --------------------------------------------------------------

-- A patient is a customer contact with a patient ID, age and sex.
CREATE TABLE health_patients (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  patient_no VARCHAR(20) NOT NULL,
  date_of_birth DATE,
  -- When the date of birth is not known: the age given on the day of registration.
  age_years SMALLINT CHECK (age_years BETWEEN 0 AND 130),
  sex TEXT NOT NULL CHECK (sex IN ('female', 'male', 'other')),
  guardian_name VARCHAR(150),
  emergency_phone VARCHAR(30),
  registered_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  UNIQUE (business_id, patient_no),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CHECK (date_of_birth IS NOT NULL OR age_years IS NOT NULL)
);

-- Consent under the DPDP Act: for what purpose, the notice shown, when and how
-- it was given, and its withdrawal (set once, never undone: a new consent is a new row).
CREATE TABLE health_consents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('treatment', 'reports_digital', 'reminders')),
  notice_version VARCHAR(20) NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('signed_form', 'verbal', 'digital')),
  given_by VARCHAR(150) NOT NULL CHECK (btrim(given_by) <> ''),
  recorded_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ,
  withdrawn_by BIGINT REFERENCES users(id),
  withdrawal_reason VARCHAR(300),
  FOREIGN KEY (business_id, contact_id) REFERENCES health_patients(business_id, contact_id),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);
CREATE UNIQUE INDEX health_consents_active ON health_consents(business_id, contact_id, purpose) WHERE withdrawn_at IS NULL;
CREATE FUNCTION health_consent_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A consent record cannot be deleted; record its withdrawal' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['created_at', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason'])
     <> (to_jsonb(OLD) - ARRAY['created_at', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason'])
     OR (OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by OR NEW.withdrawal_reason IS DISTINCT FROM OLD.withdrawal_reason
       OR NEW.withdrawn_at IS NULL)) THEN
    RAISE EXCEPTION 'A consent is kept as given; only its withdrawal is recorded, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER health_consent_fixed BEFORE UPDATE OR DELETE ON health_consents
  FOR EACH ROW EXECUTE FUNCTION health_consent_fixed();

-- The clinical side of a patient (blood group, allergies, conditions): clinical roles only.
CREATE TABLE health_patient_clinical (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  blood_group TEXT CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  allergies VARCHAR(500),
  conditions VARCHAR(500),
  current_medicines VARCHAR(500),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES health_patients(business_id, contact_id)
);

-- --- Clinic: consultations ---------------------------------------------------------------------

CREATE TABLE health_visits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  visit_no VARCHAR(20) NOT NULL,
  contact_id BIGINT NOT NULL,
  appointment_id BIGINT,
  resource_id BIGINT,
  doctor_signatory_id BIGINT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  bp_systolic SMALLINT CHECK (bp_systolic BETWEEN 40 AND 300),
  bp_diastolic SMALLINT CHECK (bp_diastolic BETWEEN 20 AND 200),
  pulse SMALLINT CHECK (pulse BETWEEN 20 AND 250),
  temperature_c NUMERIC(4,1) CHECK (temperature_c BETWEEN 30 AND 45),
  spo2 SMALLINT CHECK (spo2 BETWEEN 50 AND 100),
  resp_rate SMALLINT CHECK (resp_rate BETWEEN 4 AND 80),
  weight_kg NUMERIC(5,1) CHECK (weight_kg BETWEEN 0.5 AND 400),
  height_cm NUMERIC(5,1) CHECK (height_cm BETWEEN 20 AND 250),
  complaints VARCHAR(2000),
  examination VARCHAR(2000),
  diagnosis VARCHAR(1000),
  icd10_code VARCHAR(10) CHECK (icd10_code ~ '^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$'),
  advice VARCHAR(2000),
  follow_up_on DATE,
  document_id BIGINT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by BIGINT REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  UNIQUE (business_id, id),
  UNIQUE (business_id, visit_no),
  UNIQUE (business_id, appointment_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES health_patients(business_id, contact_id),
  FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, doctor_signatory_id) REFERENCES health_signatories(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX health_visits_patient ON health_visits(business_id, contact_id, created_at DESC);
CREATE INDEX health_visits_follow_up ON health_visits(business_id, follow_up_on) WHERE follow_up_on IS NOT NULL;
-- A completed consultation is the medical record: only its bill may be added
-- (once); a correction is an addendum.
CREATE FUNCTION health_visit_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A consultation cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'completed' AND ((to_jsonb(NEW) - ARRAY['created_at', 'completed_at', 'updated_at', 'document_id']) <> (to_jsonb(OLD) - ARRAY['created_at', 'completed_at', 'updated_at', 'document_id'])
     OR (OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id)) THEN
    RAISE EXCEPTION 'A completed consultation is kept as written; add a note to correct it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER health_visit_fixed BEFORE UPDATE OR DELETE ON health_visits
  FOR EACH ROW EXECUTE FUNCTION health_visit_fixed();

CREATE TABLE health_visit_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  visit_id BIGINT NOT NULL,
  body VARCHAR(2000) NOT NULL CHECK (btrim(body) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, visit_id) REFERENCES health_visits(business_id, id)
);
CREATE TRIGGER health_visit_notes_append_only BEFORE UPDATE OR DELETE ON health_visit_notes
  FOR EACH ROW EXECUTE FUNCTION health_append_only();

-- The doctor's prescription (generic name, dose, how often, for how long).
CREATE TABLE health_prescription_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  visit_id BIGINT NOT NULL,
  drug_name VARCHAR(150) NOT NULL CHECK (btrim(drug_name) <> ''),
  strength VARCHAR(60),
  dose VARCHAR(60),
  frequency VARCHAR(60),
  duration VARCHAR(60),
  instructions VARCHAR(200),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, visit_id) REFERENCES health_visits(business_id, id)
);
CREATE INDEX health_prescription_items_visit ON health_prescription_items(business_id, visit_id, sort_order);
CREATE FUNCTION health_prescription_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE visit RECORD;
BEGIN
  SELECT status INTO visit FROM health_visits WHERE business_id = COALESCE(NEW.business_id, OLD.business_id) AND id = COALESCE(NEW.visit_id, OLD.visit_id);
  IF visit.status = 'completed' AND NOT (TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'created_at') = (to_jsonb(OLD) - 'created_at')) THEN
    RAISE EXCEPTION 'The prescription of a completed consultation cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER health_prescription_open BEFORE INSERT OR UPDATE OR DELETE ON health_prescription_items
  FOR EACH ROW EXECUTE FUNCTION health_prescription_open();

-- --- Lab -----------------------------------------------------------------------------------------

-- A test (one or many parameters: CBC, LFT, lipid profile …) or a profile
-- (several tests sold together). A test may be the catalogue service it is billed as.
CREATE TABLE lab_tests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  code VARCHAR(30) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  kind TEXT NOT NULL DEFAULT 'test' CHECK (kind IN ('test', 'profile')),
  sku_id BIGINT,
  sample_type TEXT NOT NULL DEFAULT 'blood' CHECK (sample_type IN ('blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'sputum', 'other')),
  container VARCHAR(60),
  method VARCHAR(100),
  turnaround_hours SMALLINT NOT NULL DEFAULT 24 CHECK (turnaround_hours BETWEEN 1 AND 720),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, code),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE UNIQUE INDEX lab_tests_sku ON lab_tests(business_id, sku_id) WHERE sku_id IS NOT NULL;

CREATE TABLE lab_profile_tests (
  business_id BIGINT NOT NULL,
  profile_id BIGINT NOT NULL,
  test_id BIGINT NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, profile_id, test_id),
  FOREIGN KEY (business_id, profile_id) REFERENCES lab_tests(business_id, id),
  FOREIGN KEY (business_id, test_id) REFERENCES lab_tests(business_id, id),
  CHECK (profile_id <> test_id)
);

CREATE TABLE lab_parameters (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  test_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  unit VARCHAR(30),
  result_type TEXT NOT NULL DEFAULT 'numeric' CHECK (result_type IN ('numeric', 'text')),
  decimals SMALLINT NOT NULL DEFAULT 1 CHECK (decimals BETWEEN 0 AND 4),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (business_id, id),
  UNIQUE (business_id, test_id, name),
  FOREIGN KEY (business_id, test_id) REFERENCES lab_tests(business_id, id)
);

-- Reference ranges by sex and age band (in days, so a newborn's range fits).
CREATE TABLE lab_reference_ranges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  parameter_id BIGINT NOT NULL,
  sex TEXT NOT NULL DEFAULT 'any' CHECK (sex IN ('any', 'female', 'male')),
  age_from_days INT NOT NULL DEFAULT 0 CHECK (age_from_days >= 0),
  age_to_days INT NOT NULL DEFAULT 54750 CHECK (age_to_days <= 54750),
  low NUMERIC(14,4),
  high NUMERIC(14,4),
  critical_low NUMERIC(14,4),
  critical_high NUMERIC(14,4),
  -- For a text result: the normal answer ("Negative", "Non-reactive").
  normal_text VARCHAR(60),
  FOREIGN KEY (business_id, parameter_id) REFERENCES lab_parameters(business_id, id),
  CHECK (age_to_days > age_from_days),
  CHECK (low IS NULL OR high IS NULL OR high >= low),
  CHECK (low IS NOT NULL OR high IS NOT NULL OR normal_text IS NOT NULL)
);
CREATE INDEX lab_reference_ranges_parameter ON lab_reference_ranges(business_id, parameter_id);

CREATE TABLE lab_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  order_no VARCHAR(20) NOT NULL,
  location_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  visit_id BIGINT,
  referred_by VARCHAR(150),
  priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'urgent')),
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'collected', 'received', 'in_process', 'resulted', 'approved', 'cancelled')),
  document_id BIGINT,
  -- Sent to an outside lab (and what it pays back, only when the setting allows it).
  outside_lab VARCHAR(150),
  outside_ref_no VARCHAR(60),
  outside_sent_at TIMESTAMPTZ,
  outside_charge NUMERIC(12,2) CHECK (outside_charge >= 0),
  referral_commission NUMERIC(12,2) CHECK (referral_commission >= 0),
  approved_by BIGINT REFERENCES users(id),
  approved_signatory_id BIGINT,
  approved_at TIMESTAMPTZ,
  cancel_reason VARCHAR(300),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_no),
  UNIQUE (business_id, request_key),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES health_patients(business_id, contact_id),
  FOREIGN KEY (business_id, visit_id) REFERENCES health_visits(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, approved_signatory_id) REFERENCES health_signatories(business_id, id),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  CHECK (outside_lab IS NOT NULL OR (outside_ref_no IS NULL AND outside_charge IS NULL AND referral_commission IS NULL))
);
CREATE INDEX lab_orders_time ON lab_orders(business_id, created_at DESC);
CREATE INDEX lab_orders_visit ON lab_orders(business_id, visit_id) WHERE visit_id IS NOT NULL;
CREATE INDEX lab_orders_open ON lab_orders(business_id, status) WHERE status NOT IN ('approved', 'cancelled');

CREATE TABLE lab_samples (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  barcode VARCHAR(20) NOT NULL CHECK (barcode ~ '^[A-Z0-9-]{4,20}$'),
  sample_type TEXT NOT NULL,
  container VARCHAR(60),
  status TEXT NOT NULL DEFAULT 'awaited' CHECK (status IN ('awaited', 'collected', 'received', 'rejected')),
  collected_at TIMESTAMPTZ,
  collected_by BIGINT REFERENCES users(id),
  received_at TIMESTAMPTZ,
  received_by BIGINT REFERENCES users(id),
  reject_reason VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, barcode),
  UNIQUE (business_id, order_id, sample_type),
  FOREIGN KEY (business_id, order_id) REFERENCES lab_orders(business_id, id),
  CHECK (status = 'awaited' OR status = 'rejected' OR collected_at IS NOT NULL),
  CHECK (status <> 'received' OR received_at IS NOT NULL),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);

CREATE TABLE lab_order_tests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  test_id BIGINT NOT NULL,
  -- The profile it came with, if any.
  profile_id BIGINT,
  sample_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_id, test_id),
  FOREIGN KEY (business_id, order_id) REFERENCES lab_orders(business_id, id),
  FOREIGN KEY (business_id, test_id) REFERENCES lab_tests(business_id, id),
  FOREIGN KEY (business_id, profile_id) REFERENCES lab_tests(business_id, id),
  FOREIGN KEY (business_id, sample_id) REFERENCES lab_samples(business_id, id)
);

-- One value per parameter, with its flag and the range it was judged by.
CREATE TABLE lab_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  order_test_id BIGINT NOT NULL,
  parameter_id BIGINT NOT NULL,
  value_numeric NUMERIC(14,4),
  value_text VARCHAR(200),
  unit VARCHAR(30),
  range_text VARCHAR(100),
  flag TEXT NOT NULL DEFAULT 'normal' CHECK (flag IN ('normal', 'low', 'high', 'critical_low', 'critical_high', 'abnormal', 'none')),
  entered_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, order_test_id, parameter_id),
  FOREIGN KEY (business_id, order_id) REFERENCES lab_orders(business_id, id),
  FOREIGN KEY (business_id, order_test_id) REFERENCES lab_order_tests(business_id, id),
  FOREIGN KEY (business_id, parameter_id) REFERENCES lab_parameters(business_id, id),
  CHECK (num_nonnulls(value_numeric, value_text) = 1)
);
-- An approved report is fixed.
CREATE FUNCTION lab_results_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM lab_orders o WHERE o.business_id = COALESCE(NEW.business_id, OLD.business_id) AND o.id = COALESCE(NEW.order_id, OLD.order_id)
     AND o.status IN ('approved', 'cancelled'))
     AND NOT (TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['created_at', 'updated_at']) = (to_jsonb(OLD) - ARRAY['created_at', 'updated_at'])) THEN
    RAISE EXCEPTION 'The results of an approved or cancelled lab order cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER lab_results_open BEFORE INSERT OR UPDATE OR DELETE ON lab_results
  FOR EACH ROW EXECUTE FUNCTION lab_results_open();

-- Down Migration

DROP TRIGGER lab_results_open ON lab_results;
DROP FUNCTION lab_results_open();
DROP TABLE lab_results, lab_order_tests, lab_samples, lab_orders, lab_reference_ranges, lab_parameters, lab_profile_tests, lab_tests;
DROP TABLE health_prescription_items, health_visit_notes, health_visits, health_patient_clinical, health_consents, health_patients;
DROP FUNCTION health_prescription_open();
DROP FUNCTION health_visit_fixed();
DROP FUNCTION health_consent_fixed();
DROP TABLE pharmacy_debit_note_lines, pharmacy_debit_notes;
DROP TRIGGER pharmacy_recalled_lot_check ON business_stock_movements;
DROP FUNCTION pharmacy_recalled_lot_check();
DROP TABLE pharmacy_recalls;
DROP TRIGGER pharmacy_scheduled_sale_check ON business_document_lines;
DROP FUNCTION pharmacy_scheduled_sale_check();
DROP TABLE pharmacy_register_entries, pharmacy_prescriptions, health_files, pharmacy_drugs, health_signatories, health_settings, health_counters;
DROP FUNCTION health_append_only();
DELETE FROM business_role_permissions WHERE role_id IN (SELECT id FROM business_roles WHERE template_code IN ('pharmacist', 'doctor', 'lab_technician', 'pathologist'));
UPDATE business_memberships m SET role_id = (SELECT r2.id FROM business_roles r2 WHERE r2.business_id = m.business_id AND r2.template_code = 'viewer')
  WHERE role_id IN (SELECT id FROM business_roles WHERE template_code IN ('pharmacist', 'doctor', 'lab_technician', 'pathologist'));
DELETE FROM business_roles WHERE template_code IN ('pharmacist', 'doctor', 'lab_technician', 'pathologist');
DELETE FROM business_role_template_permissions WHERE template_code IN ('pharmacist', 'doctor', 'lab_technician', 'pathologist');
DELETE FROM business_role_templates WHERE code IN ('pharmacist', 'doctor', 'lab_technician', 'pathologist');
CREATE OR REPLACE FUNCTION business_seed_roles(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_roles (business_id, template_code, name, description, full_access)
  SELECT target, t.code, t.name, t.description, t.full_access FROM business_role_templates t
  ON CONFLICT (business_id, template_code) DO NOTHING;
  INSERT INTO business_role_permissions (business_id, role_id, permission_code)
  SELECT r.business_id, r.id, tp.permission_code
  FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
  WHERE r.business_id = target AND NOT r.full_access
    AND NOT EXISTS (SELECT 1 FROM business_role_permissions x WHERE x.role_id = r.id)
  ON CONFLICT DO NOTHING;
$$;
ALTER TABLE business_role_templates DROP COLUMN business_types;
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('pharmacy', 'patients', 'lab'));
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('pharmacy', 'patients', 'lab'));
DELETE FROM business_permissions WHERE module_code IN ('pharmacy', 'patients', 'lab');
ALTER TABLE business_permissions DROP CONSTRAINT business_permissions_action_check,
  ADD CONSTRAINT business_permissions_action_check CHECK (action IN ('view', 'create', 'edit', 'approve', 'cancel', 'refund', 'export', 'print',
    'discount', 'assign', 'review', 'manage'));
DELETE FROM business_capabilities WHERE capability = 'lab';
DELETE FROM business_capabilities WHERE capability = 'patients';
DELETE FROM business_capabilities WHERE capability = 'pharmacy';
DELETE FROM platform_module_business_types WHERE module_code IN ('pharmacy', 'patients', 'lab');
DELETE FROM platform_module_dependencies WHERE module_code IN ('pharmacy', 'patients', 'lab');
DELETE FROM platform_modules WHERE code IN ('pharmacy', 'patients', 'lab');
