-- Up Migration
-- Clinic: each doctor's fees and OPD timings, leave, and the day's token queue.

-- A doctor's consultation: the service billed for a first visit, the one for a
-- follow-up within the free/reduced window (none: the follow-up is free), the
-- length of an appointment slot, and the doctor's share of their fees.
CREATE TABLE health_doctor_profiles (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  resource_id BIGINT NOT NULL,
  speciality VARCHAR(80),
  consultation_sku_id BIGINT,
  follow_up_sku_id BIGINT,
  follow_up_days SMALLINT NOT NULL DEFAULT 0 CHECK (follow_up_days BETWEEN 0 AND 90),
  slot_minutes SMALLINT NOT NULL DEFAULT 10 CHECK (slot_minutes BETWEEN 5 AND 120),
  share_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (share_percent BETWEEN 0 AND 100),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, resource_id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, consultation_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, follow_up_sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (follow_up_sku_id IS NULL OR consultation_sku_id IS NOT NULL)
);

-- OPD sessions: a doctor may sit mornings and evenings (two rows on one day).
-- max_patients caps the tokens of a session (none: no cap).
CREATE TABLE health_doctor_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  resource_id BIGINT NOT NULL,
  dow SMALLINT NOT NULL CHECK (dow BETWEEN 0 AND 6),
  starts TIME NOT NULL,
  ends TIME NOT NULL,
  max_patients SMALLINT CHECK (max_patients BETWEEN 1 AND 500),
  UNIQUE (business_id, resource_id, dow, starts),
  CHECK (ends > starts),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id)
);

CREATE TABLE health_doctor_leave (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  resource_id BIGINT NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason VARCHAR(200),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  CHECK (to_date >= from_date),
  CHECK (to_date - from_date <= 366),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id)
);
CREATE INDEX health_doctor_leave_days ON health_doctor_leave(business_id, resource_id, from_date) WHERE cancelled_at IS NULL;

-- How a visit's consultation was charged, written once with its bill:
-- consultation (a first visit), follow_up (the reduced fee) or free_follow_up,
-- and the fee's service (so the doctor's earnings stay as billed when fees change).
ALTER TABLE health_visits ADD COLUMN fee_kind TEXT CHECK (fee_kind IN ('consultation', 'follow_up', 'free_follow_up')),
  ADD COLUMN fee_sku_id BIGINT,
  ADD CONSTRAINT health_visits_fee_sku_fk FOREIGN KEY (business_id, fee_sku_id) REFERENCES catalog_skus(business_id, id);
CREATE OR REPLACE FUNCTION health_visit_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A consultation cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'completed' AND ((to_jsonb(NEW) - ARRAY['created_at', 'completed_at', 'updated_at', 'document_id', 'fee_kind', 'fee_sku_id'])
       <> (to_jsonb(OLD) - ARRAY['created_at', 'completed_at', 'updated_at', 'document_id', 'fee_kind', 'fee_sku_id'])
     OR (OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id)
     OR (OLD.fee_kind IS NOT NULL AND (NEW.fee_kind IS DISTINCT FROM OLD.fee_kind OR NEW.fee_sku_id IS DISTINCT FROM OLD.fee_sku_id))) THEN
    RAISE EXCEPTION 'A completed consultation is kept as written; add a note to correct it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- The day's token queue at the front desk: one number per doctor per day
-- (or for the clinic, when no doctor is chosen yet), called in turn.
CREATE TABLE health_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  resource_id BIGINT,
  day DATE NOT NULL,
  token_no INTEGER NOT NULL CHECK (token_no > 0),
  contact_id BIGINT NOT NULL,
  appointment_id BIGINT,
  visit_id BIGINT,
  priority BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'called', 'in_consultation', 'done', 'skipped', 'cancelled')),
  note VARCHAR(200),
  issued_by BIGINT NOT NULL REFERENCES users(id),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  called_at TIMESTAMPTZ,
  called_count SMALLINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES health_patients(business_id, contact_id),
  FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id),
  FOREIGN KEY (business_id, visit_id) REFERENCES health_visits(business_id, id)
);
CREATE UNIQUE INDEX health_tokens_number ON health_tokens(business_id, location_id, COALESCE(resource_id, 0), day, token_no);
CREATE UNIQUE INDEX health_tokens_appointment ON health_tokens(business_id, appointment_id) WHERE appointment_id IS NOT NULL AND status <> 'cancelled';
-- A patient waits once per doctor at a time.
CREATE UNIQUE INDEX health_tokens_waiting ON health_tokens(business_id, contact_id, COALESCE(resource_id, 0), day)
  WHERE status IN ('waiting', 'called', 'in_consultation');
CREATE INDEX health_tokens_day ON health_tokens(business_id, location_id, day, status);

-- Down Migration
DROP TABLE health_tokens;
CREATE OR REPLACE FUNCTION health_visit_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER TABLE health_visits DROP COLUMN fee_sku_id, DROP COLUMN fee_kind;
DROP TABLE health_doctor_leave;
DROP TABLE health_doctor_sessions;
DROP TABLE health_doctor_profiles;
