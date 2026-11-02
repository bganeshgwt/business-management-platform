-- Up Migration
-- The offline till: a shop's counter (Quick bill) keeps billing when the
-- internet drops, and the bills it made reach the server when it comes back.
--
-- A till is a computer or tablet a manager registers for one location
-- (business_devices): its name, a short code (T1, T2 …) and the hash of a
-- secret kept on that device only. Bills the till makes offline take numbers
-- from a series of its own, one for each financial year (CGST rule 46(b)
-- allows several series): business_number_series gains device_id, and the
-- one-series-per-location rule now holds for the location's own series, with
-- one series per till and year beside them. A till's prefix is its code and
-- the year ("T1/2627/"), so its numbers never meet another series'.
--
-- A bill made offline was handed to a customer, so it is posted as it was
-- made: at its own time, by the cashier who made it, at its prices. What the
-- till could not know (a price or a GST rate changed meanwhile, stock short,
-- a customer over their limit, the time, the PIN rule) is flagged for the
-- manager, never refused: business_till_bills keeps each bill's maker, sender
-- and times, business_till_flags what to look at, business_till_shortfalls
-- the stock sold that the books did not hold (taken from what there was, so
-- no stock ever goes below zero; the rest waits for stock received or a
-- correction), business_till_gaps the numbers that never arrived (GSTR-1
-- counts every number issued). A voided bill keeps its number and moves no
-- stock and no money. business_till_settings holds the business's limits:
-- warn after hours offline, stop after hours offline, and the most bills a
-- till may hold unsent.
--
-- The cash limit (Income-tax Act 2025, section 186) still refuses ₹2,00,000 in
-- cash on one bill. Cash from one customer in a day is checked for an offline
-- bill by the server when it arrives, and flagged when cash taken elsewhere
-- (another till, the office) brought it over: the money was already taken,
-- and a refusal would only keep it out of the books.
--
-- The application `offline_till` is sold on its own (₹199 a month or ₹1,999 a
-- year), for the shops that bill goods at the counter, with its permissions
-- given to the role templates and to every business's copies of them.

-- --- The application, its permissions and its price ------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('offline_till', 'Offline till', 'Quick bill keeps billing when the internet drops: cash, UPI, card, split and udhaar within the limit, each bill numbered in the till''s own series, printed, and sent when the connection is back, with what changed meanwhile flagged for the manager.', 'optional', 292);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES ('offline_till', 'sales');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT 'offline_till', type, FALSE
FROM unnest(ARRAY['grocery', 'supermarket', 'fashion', 'electronics', 'books', 'meat', 'weight_retail', 'general_retail', 'hardware']) AS type;

INSERT INTO platform_module_prices (module_code, sold_as, monthly_price, yearly_price) VALUES ('offline_till', 'application', 199, 1999);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('offline_till', 'view', 'See the tills, their bills waiting and the offline bills', 640),
 ('offline_till', 'manage', 'Set up, rename and retire tills, and set how long they may bill offline', 641),
 ('offline_till', 'review', 'Review offline bills: look at what was flagged, settle stock sold short, note numbers lost', 642)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'offline_till'
UNION ALL SELECT 'accountant', unnest(ARRAY['offline_till.view', 'offline_till.review'])
UNION ALL SELECT 'viewer', unnest(ARRAY['offline_till.view']);

-- Existing businesses' copies of the shared templates (harmless where the
-- application cannot be switched on; keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'offline_till'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;

-- --- Tills ------------------------------------------------------------------------------------

-- A registered till: one computer or tablet at one location. Its secret is
-- kept on the device; only its SHA-256 is here. What the device last
-- reported (bills waiting, the oldest of them, the last number it used and
-- the numbers it still holds) shows on Settings › Tills and in the bell.
CREATE TABLE business_devices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'till' CHECK (kind IN ('till')),
  name VARCHAR(60) NOT NULL CHECK (btrim(name) <> ''),
  code VARCHAR(4) NOT NULL CHECK (code ~ '^T[1-9][0-9]{0,2}$'),
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  registered_by BIGINT NOT NULL REFERENCES users(id),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  pending_count INT NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  attention_count INT NOT NULL DEFAULT 0 CHECK (attention_count >= 0),
  oldest_pending_at TIMESTAMPTZ,
  offline_since TIMESTAMPTZ,
  last_year SMALLINT CHECK (last_year BETWEEN 2000 AND 2200),
  last_seq INT CHECK (last_seq >= 0),
  holding INT[] NOT NULL DEFAULT '{}',
  app_version VARCHAR(40),
  retired_by BIGINT REFERENCES users(id),
  retired_at TIMESTAMPTZ,
  retire_reason VARCHAR(300),
  lost BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, code),
  CONSTRAINT business_devices_retired CHECK ((retired_at IS NULL) = (retired_by IS NULL) AND (retired_at IS NULL) = (retire_reason IS NULL)),
  CONSTRAINT business_devices_lost_retired CHECK (NOT lost OR retired_at IS NOT NULL),
  CONSTRAINT business_devices_holding_size CHECK (cardinality(holding) <= 2000)
);
CREATE INDEX business_devices_location ON business_devices (business_id, location_id) WHERE retired_at IS NULL;

-- A till keeps its code, location and secret; a retired till stays retired.
CREATE FUNCTION business_devices_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A till is retired, never deleted: its bills and numbers stay with it' USING ERRCODE = '23514';
  END IF;
  IF NEW.business_id <> OLD.business_id OR NEW.location_id <> OLD.location_id OR NEW.code <> OLD.code OR NEW.kind <> OLD.kind
     OR NEW.token_hash <> OLD.token_hash OR NEW.registered_by <> OLD.registered_by OR NEW.registered_at <> OLD.registered_at THEN
    RAISE EXCEPTION 'A till keeps its location, code and secret: retire it and set up the computer again' USING ERRCODE = '23514';
  END IF;
  IF OLD.retired_at IS NOT NULL AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.lost <> OLD.lost OR NEW.name <> OLD.name) THEN
    RAISE EXCEPTION 'This till is retired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_devices_rules BEFORE UPDATE OR DELETE ON business_devices
  FOR EACH ROW EXECUTE FUNCTION business_devices_rules();

-- Settings › Tills follows each till live.
CREATE TRIGGER business_devices_live AFTER INSERT OR UPDATE OR DELETE ON business_devices
  FOR EACH ROW EXECUTE FUNCTION live_business_row('till', 'id');

-- The business's limits: warn after this many hours offline, stop new
-- offline bills after this many, and the most bills a till may hold unsent;
-- and the UPI ID a till's QR asks the exact amount to (none: the shop's own QR stand).
CREATE TABLE business_till_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  warn_hours SMALLINT NOT NULL DEFAULT 12 CHECK (warn_hours BETWEEN 1 AND 120),
  stop_hours SMALLINT NOT NULL DEFAULT 72 CHECK (stop_hours BETWEEN 1 AND 120),
  waiting_cap SMALLINT NOT NULL DEFAULT 2000 CHECK (waiting_cap BETWEEN 50 AND 2000),
  upi_id VARCHAR(100) CHECK (upi_id ~ '^[A-Za-z0-9._-]{2,60}@[A-Za-z][A-Za-z0-9.-]{1,38}$'),
  upi_payee VARCHAR(60) CHECK (upi_payee IS NULL OR btrim(upi_payee) <> ''),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_till_settings_warn_first CHECK (warn_hours <= stop_hours)
);

-- --- A till's own series ----------------------------------------------------------------------

ALTER TABLE business_number_series
  ADD COLUMN device_id BIGINT,
  ADD CONSTRAINT business_number_series_device_fkey FOREIGN KEY (business_id, device_id) REFERENCES business_devices(business_id, id);

-- One series per location, kind and year stays the rule for the location's
-- own series; a till has one of its own for each year beside them.
ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_business_id_location_id_document_kin_key;
CREATE UNIQUE INDEX business_number_series_location_year ON business_number_series (business_id, location_id, document_kind, fiscal_year)
  WHERE device_id IS NULL;
CREATE UNIQUE INDEX business_number_series_device_year ON business_number_series (business_id, device_id, document_kind, fiscal_year)
  WHERE device_id IS NOT NULL;

-- A till's series is its bills', at its location, and stays its own; a
-- location's series never takes a prefix shaped like a till's ("T1/2627/"),
-- which a till may need in a later year.
CREATE FUNCTION business_number_series_device_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    RAISE EXCEPTION 'A series stays with its till, or with its location' USING ERRCODE = '23514';
  END IF;
  IF NEW.device_id IS NULL THEN
    IF NEW.prefix ~ '^T[0-9]+/[0-9]{4}/$' THEN
      RAISE EXCEPTION 'Prefixes like % are kept for offline tills: choose another prefix', NEW.prefix USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.document_kind <> 'sale' OR NOT EXISTS (SELECT 1 FROM business_devices d WHERE d.business_id = NEW.business_id AND d.id = NEW.device_id
       AND d.location_id = NEW.location_id AND NEW.prefix = d.code || '/' || lpad((NEW.fiscal_year % 100)::text, 2, '0') || lpad(((NEW.fiscal_year + 1) % 100)::text, 2, '0') || '/') THEN
    RAISE EXCEPTION 'A till''s series numbers its bills at its own location, with its code and the year as the prefix' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.prefix <> OLD.prefix OR NEW.padding <> OLD.padding) THEN
    RAISE EXCEPTION 'A till''s series keeps its prefix and digits: its bills are numbered on the till' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_number_series_device_rules BEFORE INSERT OR UPDATE ON business_number_series
  FOR EACH ROW EXECUTE FUNCTION business_number_series_device_rules();

-- --- Offline bills ----------------------------------------------------------------------------

-- Every number a till used that reached the server: a bill (posted as an
-- ordinary sale, `document_id`) or a void (a number cancelled on the till
-- before it was sent: no stock, no money, kept for GSTR-1). Who made it, who
-- sent it, when it was made and when it arrived; the total its receipt
-- printed; whether the PIN rule applied. A void keeps its customer and what
-- was on it (labels, quantities, amounts).
CREATE TABLE business_till_bills (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  device_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  series_id BIGINT NOT NULL,
  seq INT NOT NULL CHECK (seq >= 1),
  bill_no VARCHAR(16) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bill', 'void')),
  document_id BIGINT,
  contact_id BIGINT,
  made_at TIMESTAMPTZ NOT NULL,
  made_by BIGINT NOT NULL REFERENCES users(id),
  sent_by BIGINT NOT NULL REFERENCES users(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  void_reason VARCHAR(300),
  void_lines JSONB,
  pin_rule BOOLEAN NOT NULL DEFAULT FALSE,
  offline_since TIMESTAMPTZ,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, device_id) REFERENCES business_devices(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, series_id, seq),
  UNIQUE (business_id, bill_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  CONSTRAINT business_till_bills_kind CHECK ((kind = 'bill') = (document_id IS NOT NULL) AND (kind = 'void') = (void_reason IS NOT NULL)
    AND (kind = 'void') = (void_lines IS NOT NULL)),
  CONSTRAINT business_till_bills_void_reason CHECK (void_reason IS NULL OR btrim(void_reason) <> ''),
  CONSTRAINT business_till_bills_reviewed CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
);
CREATE INDEX business_till_bills_device ON business_till_bills (business_id, device_id, made_at DESC);
CREATE INDEX business_till_bills_made ON business_till_bills (business_id, made_at DESC);

-- What arrived is kept as it arrived: only the review mark changes, once.
CREATE FUNCTION business_till_bills_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An offline bill or void is never deleted: its number is a tax record' USING ERRCODE = '23514';
  END IF;
  IF OLD.reviewed_at IS NOT NULL OR (to_jsonb(NEW) - ARRAY['reviewed_by', 'reviewed_at']) <> (to_jsonb(OLD) - ARRAY['reviewed_by', 'reviewed_at']) THEN
    RAISE EXCEPTION 'An offline bill is kept as it arrived' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_till_bills_kept BEFORE UPDATE OR DELETE ON business_till_bills
  FOR EACH ROW EXECUTE FUNCTION business_till_bills_kept();

-- What the manager looks at on an offline bill, one row per kind:
--   price      a line's price was not the one in force when it was made (the billed price stands)
--   rate       a line's GST rate was not the one in force on its day
--   credit     the customer went over their limit, or a walk-in left part unpaid
--   stock      stock was short (business_till_shortfalls)
--   time       made outside the allowed window (the till's clock, or its limit)
--   no_pin     made offline where the business asks the biller's PIN for every bill
--   discount   a discount over today's limit, or by someone who may no longer give one
--   cash_limit cash from the customer that day reached ₹2,00,000 with cash taken elsewhere
--   einvoice   a bill to a GSTIN holder once e-invoicing applies: report it to the IRP
--   maker      made by someone no longer billing here
--   total      the server's sum differs from the receipt by a paisa or two (within ₹1)
CREATE TABLE business_till_flags (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  till_bill_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('price', 'rate', 'credit', 'stock', 'time', 'no_pin', 'discount', 'cash_limit', 'einvoice', 'maker', 'total')),
  details JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by BIGINT REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  note VARCHAR(300),
  FOREIGN KEY (business_id, till_bill_id) REFERENCES business_till_bills(business_id, id),
  UNIQUE (business_id, till_bill_id, kind),
  CONSTRAINT business_till_flags_acknowledged CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CONSTRAINT business_till_flags_note CHECK (note IS NULL OR btrim(note) <> '')
);
CREATE INDEX business_till_flags_open ON business_till_flags (business_id, kind, created_at) WHERE acknowledged_at IS NULL;

-- A flag is acknowledged once, and never removed.
CREATE FUNCTION business_till_flags_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A flag on an offline bill is acknowledged, never removed' USING ERRCODE = '23514';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['acknowledged_by', 'acknowledged_at', 'note']) <> (to_jsonb(OLD) - ARRAY['acknowledged_by', 'acknowledged_at', 'note']) THEN
    RAISE EXCEPTION 'A flag on an offline bill is acknowledged once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_till_flags_kept BEFORE UPDATE OR DELETE ON business_till_flags
  FOR EACH ROW EXECUTE FUNCTION business_till_flags_kept();
CREATE TRIGGER business_till_flags_live AFTER INSERT OR UPDATE ON business_till_flags
  FOR EACH ROW EXECUTE FUNCTION live_business_row('till', 'till_bill_id');

-- Stock an offline bill sold that the books did not hold at its location:
-- the bill took what there was, and this is the rest. Settled once: taken
-- from stock received since (`received`, the movements on the bill), or the
-- count was wrong and nothing is taken (`adjusted`, with why).
CREATE TABLE business_till_shortfalls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  till_bill_id BIGINT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('received', 'adjusted')),
  note VARCHAR(300),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, till_bill_id) REFERENCES business_till_bills(business_id, id),
  UNIQUE (business_id, line_id),
  CONSTRAINT business_till_shortfalls_resolved CHECK ((resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_at IS NULL) = (resolution IS NULL)),
  CONSTRAINT business_till_shortfalls_adjusted_note CHECK (resolution IS DISTINCT FROM 'adjusted' OR (note IS NOT NULL AND btrim(note) <> ''))
);
CREATE INDEX business_till_shortfalls_open ON business_till_shortfalls (business_id, location_id, sku_id) WHERE resolved_at IS NULL;

CREATE FUNCTION business_till_shortfalls_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stock sold short is settled, never removed' USING ERRCODE = '23514';
  END IF;
  IF OLD.resolved_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['resolved_by', 'resolved_at', 'resolution', 'note']) <> (to_jsonb(OLD) - ARRAY['resolved_by', 'resolved_at', 'resolution', 'note']) THEN
    RAISE EXCEPTION 'Stock sold short is settled once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_till_shortfalls_kept BEFORE UPDATE OR DELETE ON business_till_shortfalls
  FOR EACH ROW EXECUTE FUNCTION business_till_shortfalls_kept();
CREATE TRIGGER business_till_shortfalls_live AFTER INSERT OR UPDATE ON business_till_shortfalls
  FOR EACH ROW EXECUTE FUNCTION live_business_row('till', 'till_bill_id');

-- A number of a till's series that has not reached the server while a later
-- one has (or the till was retired as lost after using it): `missing`; the
-- manager notes why (`noted`); it may still arrive (`arrived`). GSTR-1's
-- documents issued count every number, so none goes unexplained.
CREATE TABLE business_till_gaps (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  device_id BIGINT NOT NULL,
  series_id BIGINT NOT NULL,
  seq INT NOT NULL CHECK (seq >= 1),
  bill_no VARCHAR(16) NOT NULL,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  state TEXT NOT NULL DEFAULT 'missing' CHECK (state IN ('missing', 'noted', 'arrived')),
  reason VARCHAR(300),
  noted_by BIGINT REFERENCES users(id),
  noted_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, device_id) REFERENCES business_devices(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  UNIQUE (business_id, series_id, seq),
  CONSTRAINT business_till_gaps_noted CHECK ((noted_at IS NULL) = (noted_by IS NULL) AND (noted_at IS NULL) = (reason IS NULL)),
  CONSTRAINT business_till_gaps_reason CHECK (reason IS NULL OR btrim(reason) <> ''),
  CONSTRAINT business_till_gaps_state CHECK ((state = 'arrived') = (arrived_at IS NOT NULL) AND (state <> 'noted' OR noted_at IS NOT NULL))
);
CREATE INDEX business_till_gaps_open ON business_till_gaps (business_id, device_id) WHERE state = 'missing';

CREATE FUNCTION business_till_gaps_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A number not received is noted, never removed' USING ERRCODE = '23514';
  END IF;
  IF NEW.business_id <> OLD.business_id OR NEW.device_id <> OLD.device_id OR NEW.series_id <> OLD.series_id OR NEW.seq <> OLD.seq OR NEW.bill_no <> OLD.bill_no
     OR OLD.state = 'arrived' OR (OLD.state = 'noted' AND NEW.state <> 'arrived') THEN
    RAISE EXCEPTION 'A number not received is noted once, and marked when it arrives' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_till_gaps_kept BEFORE UPDATE OR DELETE ON business_till_gaps
  FOR EACH ROW EXECUTE FUNCTION business_till_gaps_kept();

-- --- The cash limit and an offline bill ------------------------------------------------------

-- The cash limit (migrations 1791960001000 and 1791969000000) as it was, but
-- for a bill numbered in a till's own series: its cash from the customer that
-- day is checked by the server when the bill arrives, on the day it was made,
-- and flagged rather than refused (the money was taken offline). One bill's
-- cash is still refused at ₹2,00,000.
CREATE OR REPLACE FUNCTION business_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc RECORD;
  zone TEXT;
  on_bill NUMERIC;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT d.kind, d.contact_id, d.document_no, d.request_key, d.series_id INTO doc FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN RETURN NEW; END IF;
  IF doc.contact_id IS NULL AND EXISTS (SELECT 1 FROM fuel_shift_closes c WHERE c.business_id = NEW.business_id AND c.walk_in_key = doc.request_key) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_bill FROM business_payments
  WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND method = 'cash';
  IF on_bill >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      doc.document_no, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  -- A collection receipt's own cash was counted when the receipt was taken.
  IF doc.contact_id IS NOT NULL AND NEW.collection_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM business_number_series s WHERE s.business_id = NEW.business_id AND s.id = doc.series_id AND s.device_id IS NOT NULL) THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    from_customer := business_cash_from_customer(NEW.business_id, doc.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
    IF from_customer >= 200000 THEN
      RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186): today''s cash from this customer would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
        from_customer::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION business_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc RECORD;
  zone TEXT;
  on_bill NUMERIC;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT d.kind, d.contact_id, d.document_no, d.request_key INTO doc FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN RETURN NEW; END IF;
  IF doc.contact_id IS NULL AND EXISTS (SELECT 1 FROM fuel_shift_closes c WHERE c.business_id = NEW.business_id AND c.walk_in_key = doc.request_key) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_bill FROM business_payments
  WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND method = 'cash';
  IF on_bill >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      doc.document_no, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  -- A collection receipt's own cash was counted when the receipt was taken.
  IF doc.contact_id IS NOT NULL AND NEW.collection_id IS NULL THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    from_customer := business_cash_from_customer(NEW.business_id, doc.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
    IF from_customer >= 200000 THEN
      RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186): today''s cash from this customer would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
        from_customer::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER business_till_gaps_kept ON business_till_gaps;
DROP FUNCTION business_till_gaps_kept();
DROP TRIGGER business_till_shortfalls_live ON business_till_shortfalls;
DROP TRIGGER business_till_shortfalls_kept ON business_till_shortfalls;
DROP FUNCTION business_till_shortfalls_kept();
DROP TRIGGER business_till_flags_live ON business_till_flags;
DROP TRIGGER business_till_flags_kept ON business_till_flags;
DROP FUNCTION business_till_flags_kept();
DROP TRIGGER business_till_bills_kept ON business_till_bills;
DROP FUNCTION business_till_bills_kept();
DROP TABLE business_till_gaps, business_till_shortfalls, business_till_flags, business_till_bills;
DROP TRIGGER business_number_series_device_rules ON business_number_series;
DROP FUNCTION business_number_series_device_rules();
DELETE FROM business_number_series WHERE device_id IS NOT NULL;
DROP INDEX business_number_series_device_year;
DROP INDEX business_number_series_location_year;
ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_business_id_location_id_document_kin_key UNIQUE (business_id, location_id, document_kind, fiscal_year);
ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_device_fkey, DROP COLUMN device_id;
DROP TABLE business_till_settings;
DROP TRIGGER business_devices_live ON business_devices;
DROP TRIGGER business_devices_rules ON business_devices;
DROP FUNCTION business_devices_rules();
DROP TABLE business_devices;
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'offline_till');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'offline_till');
DELETE FROM business_permissions WHERE module_code = 'offline_till';
DELETE FROM business_access_addons WHERE module_code = 'offline_till';
DELETE FROM business_capabilities WHERE capability = 'offline_till';
DELETE FROM platform_module_prices WHERE module_code = 'offline_till';
DELETE FROM platform_module_business_types WHERE module_code = 'offline_till';
DELETE FROM platform_module_dependencies WHERE module_code = 'offline_till';
DELETE FROM platform_modules WHERE code = 'offline_till';
