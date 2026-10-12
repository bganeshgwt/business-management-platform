-- Up Migration

-- Round 2 (8 Oct 2026), builder R2-SVC: salon & spa, weight shops and repairs.
--  Salon: a weekly schedule per stylist (hours per day), salon holidays, a
--  manager's override to book outside hours / on leave (kept with a reason),
--  back-bar products used by a service (recipe and the stock taken per bill
--  line, costed at the latest purchase price), refunding a client's advance in
--  cash or moving a held deposit to their wallet (manager PIN, receipt), and
--  monthly target (slab) commission plans chosen per stylist.
--  Repairs: an advance refunded when a job is cancelled or left over after
--  delivery (the same advance refund table).
--  Weight shops need no new tables (supplier yield reads the batches).

-- --- Stylist week, holidays, overrides ------------------------------------------------------

-- One row per stylist and weekday that differs from their usual hours: a day
-- off, or other hours. A weekday with no row uses the stylist's usual hours
-- (salon_resource_profiles.works_from / works_to / weekly_off).
CREATE TABLE salon_staff_week (
  business_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  dow SMALLINT NOT NULL CHECK (dow BETWEEN 0 AND 6),
  off BOOLEAN NOT NULL DEFAULT FALSE,
  works_from TIME,
  works_to TIME,
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, resource_id, dow),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  CHECK ((works_from IS NULL) = (works_to IS NULL)),
  CHECK (works_to IS NULL OR works_to > works_from),
  CHECK (NOT off OR works_from IS NULL)
);

-- The salon is closed (a festival, a local holiday): no bookings that day.
-- location_id NULL = every location.
CREATE TABLE salon_holidays (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT,
  day DATE NOT NULL,
  name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE UNIQUE INDEX salon_holidays_once ON salon_holidays(business_id, COALESCE(location_id, 0), day) WHERE cancelled_at IS NULL;

-- A booking made or moved outside the stylist's hours, on leave, a day off or
-- a holiday, let through by a manager with a reason.
CREATE TABLE salon_booking_overrides (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  appointment_id BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('booked', 'moved')),
  rule_broken VARCHAR(300) NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  approved_by BIGINT NOT NULL REFERENCES users(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id)
);
CREATE INDEX salon_booking_overrides_appointment ON salon_booking_overrides(business_id, appointment_id);
CREATE TRIGGER salon_booking_overrides_append_only BEFORE UPDATE OR DELETE ON salon_booking_overrides
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('appointments.approve', 'appointments', 'approve', 'Let a booking through outside a stylist''s hours, on leave or a holiday (manager)', 94);
INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES ('manager', 'appointments.approve');
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, 'appointments.approve' FROM business_roles r WHERE r.template_code = 'manager' AND NOT r.full_access
ON CONFLICT DO NOTHING;

-- --- Back-bar products ------------------------------------------------------------------------

-- What one service uses from the salon's stock (30 ml colour, 10 ml developer),
-- in the product's own stock unit.
CREATE TABLE salon_service_products (
  business_id BIGINT NOT NULL,
  service_sku_id BIGINT NOT NULL,
  product_sku_id BIGINT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, service_sku_id, product_sku_id),
  FOREIGN KEY (business_id, service_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, product_sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (service_sku_id <> product_sku_id)
);

-- Taken from stock when a service line is billed: what the recipe wanted,
-- what stock there was to take (short = not in the books, never blocks the
-- bill), and its cost at the product's latest purchase price.
CREATE TABLE salon_backbar_usage (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  service_sku_id BIGINT NOT NULL,
  product_sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  unit TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  taken NUMERIC(14,3) NOT NULL CHECK (taken >= 0 AND taken <= quantity),
  unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  cost NUMERIC(14,2) NOT NULL CHECK (cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, service_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, product_sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, line_id, product_sku_id)
);
CREATE INDEX salon_backbar_usage_period ON salon_backbar_usage(business_id, created_at);
CREATE TRIGGER salon_backbar_usage_append_only BEFORE UPDATE OR DELETE ON salon_backbar_usage
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- --- Advances refunded, deposits moved to the wallet --------------------------------------------

-- Money a customer paid in advance (a receivables collection) handed back:
-- a salon client's advance or deposit, a repair job's advance. With what was
-- put against bills it never passes the collection's amount.
CREATE TABLE business_collection_refunds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  collection_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  refund_no VARCHAR(60) NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'bank')),
  reference VARCHAR(100),
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  source TEXT NOT NULL CHECK (source IN ('salon', 'repair')),
  repair_job_id BIGINT,
  approved_by BIGINT NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, repair_job_id) REFERENCES electronics_repair_jobs(business_id, id),
  UNIQUE (business_id, refund_no),
  UNIQUE (business_id, request_key),
  CHECK ((source = 'repair') = (repair_job_id IS NOT NULL))
);
CREATE INDEX business_collection_refunds_collection ON business_collection_refunds(business_id, collection_id);
CREATE INDEX business_collection_refunds_contact ON business_collection_refunds(business_id, contact_id, created_at DESC);
CREATE TRIGGER business_collection_refunds_append_only BEFORE UPDATE OR DELETE ON business_collection_refunds
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

CREATE FUNCTION business_collection_refunds_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt business_collections%ROWTYPE;
  used NUMERIC;
BEGIN
  SELECT * INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF receipt.contact_id <> NEW.contact_id THEN
    RAISE EXCEPTION 'A refund goes back to the customer who paid' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0)
       + COALESCE((SELECT sum(amount) FROM business_collection_refunds WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0)
    INTO used;
  IF used > receipt.amount THEN
    RAISE EXCEPTION 'Collection % has only % left to refund', receipt.collection_no, receipt.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER business_collection_refunds_rules AFTER INSERT ON business_collection_refunds
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION business_collection_refunds_rules();

-- Money put against bills counts what was refunded too (the same rule from the other side).
CREATE OR REPLACE FUNCTION business_payments_collection_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt business_collections%ROWTYPE;
  used NUMERIC;
BEGIN
  IF NEW.collection_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id
                 AND kind = 'sale' AND contact_id = receipt.contact_id) THEN
    RAISE EXCEPTION 'A collection can only settle bills of the customer who paid it' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO used FROM business_payments WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id;
  used := used + COALESCE((SELECT sum(amount) FROM business_collection_refunds WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0);
  IF used > receipt.amount THEN
    RAISE EXCEPTION 'Collection % has only % to apply to bills', receipt.collection_no, receipt.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A deposit held for a booking still to come, released to the client's
-- wallet (their advance, usable on any bill) with a manager's say-so. The
-- booking then holds no deposit: a later no-show charges nothing from it.
CREATE TABLE salon_deposit_releases (
  business_id BIGINT NOT NULL,
  collection_id BIGINT NOT NULL,
  appointment_id BIGINT NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  approved_by BIGINT NOT NULL REFERENCES users(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, collection_id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id)
);
CREATE TRIGGER salon_deposit_releases_append_only BEFORE UPDATE OR DELETE ON salon_deposit_releases
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- --- Monthly target (slab) commission -------------------------------------------------------

-- 'stepped': each band of the month's net service sales at its own rate
-- (10% of the first 50,000, 12% of the rest); 'whole': the whole month at
-- the rate of the highest band reached.
CREATE TABLE salon_commission_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
  mode TEXT NOT NULL DEFAULT 'stepped' CHECK (mode IN ('stepped', 'whole')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX salon_commission_plans_name ON salon_commission_plans(business_id, lower(name));

-- A band starts at from_amount of the month's net service sales (the first at 0).
CREATE TABLE salon_commission_slabs (
  business_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  from_amount NUMERIC(14,2) NOT NULL CHECK (from_amount >= 0),
  percent NUMERIC(5,2) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  PRIMARY KEY (business_id, plan_id, from_amount),
  FOREIGN KEY (business_id, plan_id) REFERENCES salon_commission_plans(business_id, id)
);

-- Which way a stylist earns on services from a month on: plan_id NULL = the
-- flat rules (per line), otherwise the slab plan on the month's sales.
CREATE TABLE salon_commission_schemes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  plan_id BIGINT,
  from_month DATE NOT NULL CHECK (extract(day FROM from_month) = 1),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, plan_id) REFERENCES salon_commission_plans(business_id, id),
  UNIQUE (business_id, resource_id, from_month)
);

-- Down Migration
DROP TABLE salon_commission_schemes;
DROP TABLE salon_commission_slabs;
DROP TABLE salon_commission_plans;
DROP TABLE salon_deposit_releases;
CREATE OR REPLACE FUNCTION business_payments_collection_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt business_collections%ROWTYPE;
  used NUMERIC;
BEGIN
  IF NEW.collection_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id
                 AND kind = 'sale' AND contact_id = receipt.contact_id) THEN
    RAISE EXCEPTION 'A collection can only settle bills of the customer who paid it' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO used FROM business_payments WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id;
  IF used > receipt.amount THEN
    RAISE EXCEPTION 'Collection % has only % to apply to bills', receipt.collection_no, receipt.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TABLE business_collection_refunds;
DROP FUNCTION business_collection_refunds_rules();
DROP TABLE salon_backbar_usage;
DROP TABLE salon_service_products;
DELETE FROM business_role_permissions WHERE permission_code = 'appointments.approve';
DELETE FROM business_role_template_permissions WHERE permission_code = 'appointments.approve';
DELETE FROM business_permissions WHERE code = 'appointments.approve';
DROP TABLE salon_booking_overrides;
DROP TABLE salon_holidays;
DROP TABLE salon_staff_week;
