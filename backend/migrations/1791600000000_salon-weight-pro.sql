-- Up Migration

-- Pro pass F (7 Oct 2026): salon & spa and weight-based shops.
-- Salon: moving a booking, arrival and walk-ins, WhatsApp confirmations and
-- reminders, the client card (profile, notes, colour formula), stylist hours,
-- weekly off and leave, commission on package sessions and plan sales, flat
-- commission, payouts and tips. Weight shops: rate history, who cut a batch
-- and from which supplier, repacking into pieces, orders for pickup, the
-- end-of-day weigh-up, and customer rates (price lists) for meat and weight shops.

-- --- Salon: bookings ----------------------------------------------------------------------

-- A booking may move to another room when it is rescheduled; its price,
-- deposit and request key stay fixed, and the fee and bill are set once.
CREATE OR REPLACE FUNCTION salon_appointment_details_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appointment details cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.price_at_booking <> OLD.price_at_booking
     OR NEW.deposit_collection_id IS DISTINCT FROM OLD.deposit_collection_id
     OR (OLD.fee_document_id IS NOT NULL AND NEW.fee_document_id IS DISTINCT FROM OLD.fee_document_id)
     OR (OLD.bill_document_id IS NOT NULL AND NEW.bill_document_id IS DISTINCT FROM OLD.bill_document_id)
     OR NEW.request_key <> OLD.request_key THEN
    RAISE EXCEPTION 'A booking''s price and deposit are fixed; its fee and bill are set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE salon_appointment_details
  ADD COLUMN arrived_at TIMESTAMPTZ,
  ADD COLUMN confirmation_sent_at TIMESTAMPTZ,
  ADD COLUMN reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN moved_count SMALLINT NOT NULL DEFAULT 0 CHECK (moved_count BETWEEN 0 AND 1000),
  ADD COLUMN walk_in BOOLEAN NOT NULL DEFAULT FALSE;

-- The waiting list of walk-ins: seated (booked now with a stylist) or left.
CREATE TABLE salon_walk_ins (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  -- The stylist asked for; NULL = whoever is free first.
  resource_id BIGINT,
  note VARCHAR(300),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'seated', 'left')),
  appointment_id BIGINT,
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  closed_by BIGINT REFERENCES users(id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((status = 'seated') = (appointment_id IS NOT NULL)),
  CHECK ((status = 'waiting') = (closed_at IS NULL))
);
CREATE INDEX salon_walk_ins_waiting ON salon_walk_ins(business_id, arrived_at) WHERE status = 'waiting';

-- --- Salon: the client card ----------------------------------------------------------------

CREATE TABLE salon_client_profiles (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  birthday DATE,
  anniversary DATE,
  gender TEXT CHECK (gender IN ('female', 'male', 'other')),
  preferred_resource_id BIGINT,
  allergies VARCHAR(300),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, preferred_resource_id) REFERENCES business_resources(business_id, id)
);

-- Dated notes and colour formulas, kept as written (a new note corrects an old one).
CREATE TABLE salon_client_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'formula')),
  body VARCHAR(500) NOT NULL CHECK (btrim(body) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id)
);
CREATE INDEX salon_client_notes_contact ON salon_client_notes(business_id, contact_id, created_at DESC);
CREATE TRIGGER salon_client_notes_append_only BEFORE UPDATE OR DELETE ON salon_client_notes
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- A package or membership may be extended (a later end date, with a manager's
-- reason, audited); everything else about it stays fixed once sold.
CREATE OR REPLACE FUNCTION salon_client_plans_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A client''s package or membership cannot be deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'created_at', 'ends_on'])
     <> (to_jsonb(OLD) - ARRAY['status', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'created_at', 'ends_on'])
     OR OLD.status = 'cancelled' OR NEW.ends_on < OLD.ends_on THEN
    RAISE EXCEPTION 'A client''s package or membership is fixed once sold; it can only be extended or cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- Salon: stylist hours, weekly off and leave ---------------------------------------------

ALTER TABLE salon_resource_profiles
  ADD COLUMN weekly_off SMALLINT[] NOT NULL DEFAULT '{}' CHECK (weekly_off <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::SMALLINT[]),
  ADD COLUMN works_from TIME,
  ADD COLUMN works_to TIME,
  ADD CONSTRAINT salon_resource_profiles_hours CHECK ((works_from IS NULL) = (works_to IS NULL) AND (works_to IS NULL OR works_to > works_from));

CREATE TABLE salon_staff_leave (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason VARCHAR(200),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  CHECK (to_date >= from_date AND to_date - from_date <= 366),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX salon_staff_leave_dates ON salon_staff_leave(business_id, resource_id, from_date) WHERE cancelled_at IS NULL;

-- --- Salon: commissions on sessions and plan sales, flat amounts, payouts, tips --------------

-- 'plan' = selling a package or membership (its own rule, e.g. a 3% selling incentive).
ALTER TABLE salon_commission_rules DROP CONSTRAINT salon_commission_rules_applies_to_check,
  ADD CONSTRAINT salon_commission_rules_applies_to_check CHECK (applies_to IN ('service', 'goods', 'plan'));
-- A flat amount per item done (e.g. Rs 50 per haircut) instead of a percentage.
ALTER TABLE salon_commission_rules ADD COLUMN flat_amount NUMERIC(12,2) CHECK (flat_amount >= 0);
CREATE OR REPLACE FUNCTION salon_commission_rule_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sku_id IS NOT NULL AND NEW.applies_to = 'plan' AND NOT EXISTS (SELECT 1 FROM salon_plans p WHERE p.business_id = NEW.business_id AND p.sku_id = NEW.sku_id) THEN
    RAISE EXCEPTION 'The item is not a package or membership' USING ERRCODE = '23514';
  END IF;
  IF NEW.sku_id IS NOT NULL AND NEW.applies_to <> 'plan' AND NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
       WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id AND p.kind = NEW.applies_to) THEN
    RAISE EXCEPTION 'The item does not match services / products of this rule' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- 'session' = a service paid from a package (its value is the package's price
-- per session, or the service's list price); 'plan' = a package / membership sold.
ALTER TABLE salon_line_staff DROP CONSTRAINT salon_line_staff_item_kind_check,
  ADD CONSTRAINT salon_line_staff_item_kind_check CHECK (item_kind IN ('service', 'goods', 'plan', 'session'));
ALTER TABLE salon_settings ADD COLUMN session_commission_basis TEXT NOT NULL DEFAULT 'package_price'
  CHECK (session_commission_basis IN ('package_price', 'list_price'));

-- Commission (and tips) paid out to a stylist, printed as a slip.
CREATE TABLE salon_commission_payouts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  resource_id BIGINT NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  -- What was earned in the period when it was paid (for the slip).
  commission NUMERIC(14,2) NOT NULL CHECK (commission >= 0),
  tips NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tips >= 0),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'bank', 'cheque')),
  reference VARCHAR(100),
  note VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (period_to >= period_from)
);
CREATE INDEX salon_commission_payouts_staff ON salon_commission_payouts(business_id, resource_id, period_to);
CREATE TRIGGER salon_commission_payouts_append_only BEFORE UPDATE OR DELETE ON salon_commission_payouts
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- A tip for the stylist taken with a bill: not a sale (no GST), owed to the stylist.
CREATE TABLE salon_tips (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  UNIQUE (business_id, document_id, resource_id)
);
CREATE INDEX salon_tips_staff ON salon_tips(business_id, resource_id, created_at);
CREATE TRIGGER salon_tips_append_only BEFORE UPDATE OR DELETE ON salon_tips
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- --- Weight shops ------------------------------------------------------------------------------

-- Every change of a weighed item's selling price (the daily rate board).
CREATE TABLE weight_rate_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  old_price NUMERIC(14,4) NOT NULL CHECK (old_price >= 0),
  new_price NUMERIC(14,4) NOT NULL CHECK (new_price >= 0),
  changed_by BIGINT NOT NULL REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE INDEX weight_rate_history_sku ON weight_rate_history(business_id, sku_id, changed_at DESC);
CREATE TRIGGER weight_rate_history_append_only BEFORE UPDATE OR DELETE ON weight_rate_history
  FOR EACH ROW EXECUTE FUNCTION weight_append_only();

-- Who cut a batch, the supplier of its input, and whether it was cut to order at the counter.
ALTER TABLE weight_processing_batches
  ADD COLUMN cut_by VARCHAR(100),
  ADD COLUMN supplier_id BIGINT,
  ADD COLUMN cut_to_order BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT weight_processing_batches_supplier FOREIGN KEY (business_id, supplier_id) REFERENCES business_contacts(business_id, id);

-- Repacking loose stock into pouches sold by the piece: the weight of one pack.
CREATE TABLE weight_pack_sizes (
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  pack_kg NUMERIC(10,3) NOT NULL CHECK (pack_kg > 0 AND pack_kg <= 1000),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);

-- Orders taken on the phone or WhatsApp for pickup at a time.
CREATE TABLE weight_pickup_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  contact_id BIGINT,
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  phone VARCHAR(30),
  pickup_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ready', 'collected', 'cancelled')),
  notes VARCHAR(300),
  document_id BIGINT,
  ready_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  cancel_reason VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((status = 'collected') = (document_id IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CHECK ((status IN ('collected', 'cancelled')) = (closed_at IS NOT NULL))
);
CREATE INDEX weight_pickup_orders_open ON weight_pickup_orders(business_id, pickup_at) WHERE status IN ('open', 'ready');

CREATE TABLE weight_pickup_order_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  unit TEXT NOT NULL,
  -- By weight (quantity) or by amount ("Rs 200 worth"); the counter weighs it.
  quantity NUMERIC(16,3) CHECK (quantity > 0),
  amount NUMERIC(12,2) CHECK (amount > 0),
  note VARCHAR(150),
  FOREIGN KEY (business_id, order_id) REFERENCES weight_pickup_orders(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (quantity IS NOT NULL OR amount IS NOT NULL)
);
CREATE INDEX weight_pickup_order_lines_order ON weight_pickup_order_lines(business_id, order_id);

-- The end-of-day weigh-up: what was left, against what the books expected.
CREATE TABLE weight_day_closes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  day DATE NOT NULL,
  lines JSONB NOT NULL,
  short_kg NUMERIC(16,3) NOT NULL DEFAULT 0,
  short_value NUMERIC(16,2) NOT NULL DEFAULT 0,
  over_kg NUMERIC(16,3) NOT NULL DEFAULT 0,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX weight_day_closes_day ON weight_day_closes(business_id, day DESC);
CREATE TRIGGER weight_day_closes_append_only BEFORE UPDATE OR DELETE ON weight_day_closes
  FOR EACH ROW EXECUTE FUNCTION weight_append_only();

-- Customer rates per kg (a hotel's own rate) use the shared price lists.
INSERT INTO platform_module_business_types(module_code, business_type, enabled_by_default)
VALUES ('wholesale', 'meat', FALSE), ('wholesale', 'weight_retail', FALSE)
ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM platform_module_business_types WHERE module_code = 'wholesale' AND business_type IN ('meat', 'weight_retail');
DROP TABLE weight_day_closes;
DROP TABLE weight_pickup_order_lines, weight_pickup_orders;
DROP TABLE weight_pack_sizes;
ALTER TABLE weight_processing_batches DROP CONSTRAINT weight_processing_batches_supplier,
  DROP COLUMN cut_by, DROP COLUMN supplier_id, DROP COLUMN cut_to_order;
DROP TABLE weight_rate_history;
DROP TABLE salon_tips, salon_commission_payouts;
ALTER TABLE salon_settings DROP COLUMN session_commission_basis;
ALTER TABLE salon_line_staff DROP CONSTRAINT salon_line_staff_item_kind_check,
  ADD CONSTRAINT salon_line_staff_item_kind_check CHECK (item_kind IN ('service', 'goods'));
ALTER TABLE salon_commission_rules DROP COLUMN flat_amount;
ALTER TABLE salon_commission_rules DROP CONSTRAINT salon_commission_rules_applies_to_check,
  ADD CONSTRAINT salon_commission_rules_applies_to_check CHECK (applies_to IN ('service', 'goods'));
CREATE OR REPLACE FUNCTION salon_commission_rule_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sku_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
       WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id AND p.kind = NEW.applies_to) THEN
    RAISE EXCEPTION 'The item does not match services / products of this rule' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TABLE salon_staff_leave;
ALTER TABLE salon_resource_profiles DROP CONSTRAINT salon_resource_profiles_hours,
  DROP COLUMN weekly_off, DROP COLUMN works_from, DROP COLUMN works_to;
CREATE OR REPLACE FUNCTION salon_client_plans_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A client''s package or membership cannot be deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'created_at'])
     <> (to_jsonb(OLD) - ARRAY['status', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'created_at'])
     OR OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'A client''s package or membership is fixed once sold; it can only be cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TABLE salon_client_notes, salon_client_profiles;
DROP TABLE salon_walk_ins;
ALTER TABLE salon_appointment_details DROP COLUMN arrived_at, DROP COLUMN confirmation_sent_at, DROP COLUMN reminder_sent_at,
  DROP COLUMN moved_count, DROP COLUMN walk_in;
CREATE OR REPLACE FUNCTION salon_appointment_details_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appointment details cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.price_at_booking <> OLD.price_at_booking
     OR NEW.deposit_collection_id IS DISTINCT FROM OLD.deposit_collection_id
     OR (OLD.fee_document_id IS NOT NULL AND NEW.fee_document_id IS DISTINCT FROM OLD.fee_document_id)
     OR (OLD.bill_document_id IS NOT NULL AND NEW.bill_document_id IS DISTINCT FROM OLD.bill_document_id)
     OR NEW.request_key <> OLD.request_key THEN
    RAISE EXCEPTION 'A booking''s room, price and deposit are fixed; its fee and bill are set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
