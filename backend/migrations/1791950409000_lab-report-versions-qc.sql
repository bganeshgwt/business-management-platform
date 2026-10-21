-- Up Migration
-- Lab: amended reports keep every signed version, and quality control (QC)
-- runs are checked against Westgard rules before patient reports are signed.

-- An approved report is reissued by amendment: the pathologist reopens it with
-- a reason, corrects it and signs again. Each signed report is kept as it was
-- printed (results, ranges, flags, who signed), numbered 1, 2, …
ALTER TABLE lab_orders ADD COLUMN version SMALLINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  ADD COLUMN amend_reason VARCHAR(300),
  ADD COLUMN amend_requested_by BIGINT REFERENCES users(id),
  ADD COLUMN amend_requested_at TIMESTAMPTZ,
  ADD CONSTRAINT lab_orders_amending CHECK (amend_reason IS NULL OR status <> 'approved');

CREATE TABLE lab_report_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  order_id BIGINT NOT NULL,
  version SMALLINT NOT NULL CHECK (version > 0),
  results JSONB NOT NULL,
  amend_reason VARCHAR(300),
  signatory_id BIGINT,
  approved_by BIGINT REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, order_id, version),
  CHECK ((version = 1) = (amend_reason IS NULL)),
  FOREIGN KEY (business_id, order_id) REFERENCES lab_orders(business_id, id),
  FOREIGN KEY (business_id, signatory_id) REFERENCES health_signatories(business_id, id)
);
-- A signed version never changes; only its time stamps may be corrected, both
-- by the same amount (the demo set-up spreads sample records over past days).
CREATE FUNCTION lab_report_version_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A signed report version cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['created_at', 'approved_at']) <> (to_jsonb(OLD) - ARRAY['created_at', 'approved_at'])
     OR (NEW.approved_at - OLD.approved_at) IS DISTINCT FROM (NEW.created_at - OLD.created_at) THEN
    RAISE EXCEPTION 'A signed report version cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_report_versions_fixed BEFORE UPDATE OR DELETE ON lab_report_versions
  FOR EACH ROW EXECUTE FUNCTION lab_report_version_fixed();

-- Reports signed before versions existed become version 1, as they stand.
UPDATE lab_orders SET version = 1 WHERE status = 'approved';
INSERT INTO lab_report_versions (business_id, order_id, version, results, signatory_id, approved_by, approved_at)
SELECT o.business_id, o.id, 1,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('test_code', t.code, 'test_name', t.name, 'parameter_id', p.id, 'name', p.name,
      'value_numeric', r.value_numeric, 'value_text', r.value_text, 'unit', r.unit, 'range_text', r.range_text, 'flag', r.flag) ORDER BY ot.id, p.sort_order, p.id)
    FROM lab_results r JOIN lab_order_tests ot ON ot.business_id = r.business_id AND ot.id = r.order_test_id
    JOIN lab_tests t ON t.business_id = ot.business_id AND t.id = ot.test_id
    JOIN lab_parameters p ON p.business_id = r.business_id AND p.id = r.parameter_id
    WHERE r.business_id = o.business_id AND r.order_id = o.id), '[]'::jsonb),
  o.approved_signatory_id, o.approved_by, o.approved_at
FROM lab_orders o WHERE o.status = 'approved';

-- QC materials: a control (its lot and level) for one parameter, with the
-- target mean and SD the lab works to (from the insert sheet or its own runs).
CREATE TABLE lab_qc_materials (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  parameter_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  lot_no VARCHAR(40) NOT NULL CHECK (btrim(lot_no) <> ''),
  level VARCHAR(20) NOT NULL DEFAULT 'Level 1',
  mean NUMERIC(14,4) NOT NULL,
  sd NUMERIC(14,4) NOT NULL CHECK (sd > 0),
  expires_on DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, parameter_id, lot_no, level),
  FOREIGN KEY (business_id, parameter_id) REFERENCES lab_parameters(business_id, id)
);

-- A QC run: the value measured, how far from the mean (z), the Westgard rules
-- it broke and the outcome. Kept as recorded; a failed run is followed by a
-- corrective action and a new run, never edited.
CREATE TABLE lab_qc_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  material_id BIGINT NOT NULL,
  parameter_id BIGINT NOT NULL,
  value NUMERIC(14,4) NOT NULL,
  z NUMERIC(8,3) NOT NULL,
  rules TEXT[] NOT NULL DEFAULT '{}',
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'warning', 'rejected')),
  note VARCHAR(300),
  corrective_action VARCHAR(300),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entered_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (outcome <> 'rejected' OR cardinality(rules) > 0),
  FOREIGN KEY (business_id, material_id) REFERENCES lab_qc_materials(business_id, id),
  FOREIGN KEY (business_id, parameter_id) REFERENCES lab_parameters(business_id, id)
);
CREATE INDEX lab_qc_runs_material ON lab_qc_runs(business_id, material_id, run_at DESC);
CREATE INDEX lab_qc_runs_parameter ON lab_qc_runs(business_id, parameter_id, run_at DESC);
CREATE TRIGGER lab_qc_runs_fixed BEFORE UPDATE OR DELETE ON lab_qc_runs
  FOR EACH ROW EXECUTE FUNCTION health_append_only();

-- Down Migration
DROP TABLE lab_qc_runs;
DROP TABLE lab_qc_materials;
DROP TABLE lab_report_versions;
DROP FUNCTION lab_report_version_fixed();
ALTER TABLE lab_orders DROP CONSTRAINT lab_orders_amending, DROP COLUMN amend_requested_at, DROP COLUMN amend_requested_by,
  DROP COLUMN amend_reason, DROP COLUMN version;
