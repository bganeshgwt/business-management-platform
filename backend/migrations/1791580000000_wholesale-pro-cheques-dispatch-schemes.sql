-- Up Migration
-- Wholesale / FMCG pro pass (builder D, 7 Oct 2026). Everything here is
-- additive: new tables and new columns on wholesale_* tables only.
--
--   1. Cheques on collections: cheque date, bank, received → deposited →
--      cleared | bounced. A bounce takes the receipt out of the customer's
--      account (the bills it settled open again) and may add a bank charge.
--   2. Evening settlement of a salesperson's day: what each receipt method
--      brought in, cash handed over, short or excess.
--   3. Delivery runs (one van, many orders, one load sheet), transport and
--      e-way bill details on each dispatch, and the delivery stage
--      (out for delivery → delivered | part returned | refused).
--   4. Order lines with a discount % and free goods (schemes), order edits
--      before dispatch.
--   5. Customer price groups with dated prices, and schemes (buy N get M
--      free, a discount % for a period).
--   6. Wholesale customer details (beat aside): price group, contact person,
--      state and PIN for the place of supply, trade or walk-in, hold exemption.
--   7. Credit hold on overdue bills, released by someone with credit control
--      (receivables.approve).
--   8. Salespeople: a login and a monthly target.
--   9. Claims against suppliers (schemes, damage, expiry, rate difference).

-- --- Permissions -----------------------------------------------------------------
-- Credit control: bounce a cheque, settle a salesperson's cash, and let an
-- order through a credit hold (overdue bills).
INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('receivables.approve', 'receivables', 'approve', 'Credit control: mark cheques bounced, settle a salesperson''s cash, let an order through a credit hold', 75);

INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES
 ('manager', 'receivables.approve'), ('accountant', 'receivables.approve');

INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
WHERE NOT r.full_access AND tp.permission_code = 'receivables.approve'
ON CONFLICT DO NOTHING;

-- --- 1. Cheques ---------------------------------------------------------------------
CREATE TABLE business_collection_cheques (
  business_id BIGINT NOT NULL,
  collection_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  cheque_no VARCHAR(100) NOT NULL CHECK (btrim(cheque_no) <> ''),
  -- The date written on the cheque (later than the receipt for a post-dated cheque).
  cheque_date DATE NOT NULL,
  bank VARCHAR(100),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'deposited', 'cleared', 'bounced')),
  deposited_at TIMESTAMPTZ,
  deposited_by BIGINT REFERENCES users(id),
  deposited_into VARCHAR(100),
  cleared_at TIMESTAMPTZ,
  cleared_by BIGINT REFERENCES users(id),
  bounced_at TIMESTAMPTZ,
  bounced_by BIGINT REFERENCES users(id),
  bounce_reason VARCHAR(300),
  -- What the bank charged for the bounce, put on the customer's account.
  bounce_charge NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (bounce_charge >= 0),
  -- The bill settlements the cheque had made, as they were before the bounce took them back.
  reversed_allocations JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, collection_id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CHECK (status <> 'deposited' OR deposited_at IS NOT NULL),
  CHECK (status <> 'cleared' OR cleared_at IS NOT NULL),
  CHECK (status <> 'bounced' OR (bounced_at IS NOT NULL AND bounce_reason IS NOT NULL)),
  CHECK (status = 'bounced' OR bounce_charge = 0)
);
CREATE INDEX business_collection_cheques_status ON business_collection_cheques(business_id, status, cheque_date);
CREATE INDEX business_collection_cheques_contact ON business_collection_cheques(business_id, contact_id) WHERE status = 'bounced';

-- A cheque only moves forward: received → deposited → cleared, or received /
-- deposited → bounced. What was written on it never changes.
CREATE FUNCTION business_collection_cheques_flow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A cheque record is kept; mark it bounced instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.collection_id <> OLD.collection_id OR NEW.contact_id <> OLD.contact_id OR NEW.cheque_no <> OLD.cheque_no
     OR NEW.cheque_date <> OLD.cheque_date OR NEW.bank IS DISTINCT FROM OLD.bank THEN
    RAISE EXCEPTION 'The cheque number, date, bank and customer cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('cleared', 'bounced') THEN
      RAISE EXCEPTION 'This cheque is already %', OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'received' AND NEW.status IN ('deposited', 'cleared', 'bounced'))
       OR (OLD.status = 'deposited' AND NEW.status IN ('cleared', 'bounced'))) THEN
    RAISE EXCEPTION 'A % cheque cannot be marked %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_collection_cheques_flow BEFORE UPDATE OR DELETE ON business_collection_cheques
  FOR EACH ROW EXECUTE FUNCTION business_collection_cheques_flow();

-- Cheques already on file: received on the day they were recorded (salon
-- deposits and exchange credit notes are not cheques from this screen).
INSERT INTO business_collection_cheques (business_id, collection_id, contact_id, cheque_no, cheque_date, status, created_at)
SELECT k.business_id, k.id, k.contact_id, COALESCE(NULLIF(btrim(k.reference), ''), 'not recorded'),
  (k.created_at AT TIME ZONE b.timezone)::date, 'received', k.created_at
FROM business_collections k JOIN businesses b ON b.id = k.business_id
WHERE k.method = 'cheque'
  AND NOT EXISTS (SELECT 1 FROM salon_appointment_details s WHERE s.business_id = k.business_id AND s.deposit_collection_id = k.id);

-- --- 2. Evening settlement ---------------------------------------------------------------
CREATE TABLE wholesale_settlements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  salesperson_id BIGINT NOT NULL,
  day DATE NOT NULL,
  receipts INT NOT NULL CHECK (receipts >= 0),
  cash NUMERIC(16,2) NOT NULL CHECK (cash >= 0),
  upi NUMERIC(16,2) NOT NULL CHECK (upi >= 0),
  cheques NUMERIC(16,2) NOT NULL CHECK (cheques >= 0),
  cheque_count INT NOT NULL CHECK (cheque_count >= 0),
  other NUMERIC(16,2) NOT NULL CHECK (other >= 0),
  cash_handed NUMERIC(16,2) NOT NULL CHECK (cash_handed >= 0),
  -- Handed over less cash collected: below zero is a shortage.
  difference NUMERIC(16,2) NOT NULL CHECK (difference = cash_handed - cash),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (difference = 0 OR notes IS NOT NULL)
);
CREATE INDEX wholesale_settlements_day ON wholesale_settlements(business_id, day DESC);

-- Each receipt is settled once.
CREATE TABLE wholesale_settlement_receipts (
  business_id BIGINT NOT NULL,
  settlement_id BIGINT NOT NULL,
  collection_id BIGINT NOT NULL,
  PRIMARY KEY (business_id, collection_id),
  FOREIGN KEY (business_id, settlement_id) REFERENCES wholesale_settlements(business_id, id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id)
);
CREATE INDEX wholesale_settlement_receipts_settlement ON wholesale_settlement_receipts(business_id, settlement_id);

CREATE FUNCTION wholesale_settlements_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A settlement cannot be changed or deleted once saved' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER wholesale_settlements_fixed BEFORE UPDATE OR DELETE ON wholesale_settlements
  FOR EACH ROW EXECUTE FUNCTION wholesale_settlements_fixed();
CREATE TRIGGER wholesale_settlement_receipts_fixed BEFORE UPDATE OR DELETE ON wholesale_settlement_receipts
  FOR EACH ROW EXECUTE FUNCTION wholesale_settlements_fixed();

-- --- 3. Delivery runs, transport, delivery stage ---------------------------------------------
CREATE TABLE wholesale_delivery_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  route_id BIGINT,
  vehicle_no VARCHAR(20),
  driver_name VARCHAR(100),
  driver_phone VARCHAR(30),
  helper_name VARCHAR(100),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, route_id) REFERENCES wholesale_routes(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX wholesale_delivery_runs_period ON wholesale_delivery_runs(business_id, created_at DESC);

ALTER TABLE wholesale_dispatches
  ADD COLUMN run_id BIGINT,
  ADD COLUMN driver_name VARCHAR(100),
  ADD COLUMN helper_name VARCHAR(100),
  ADD COLUMN transporter_name VARCHAR(150),
  -- The transporter's GSTIN or TRANSIN, as the e-way bill asks for it.
  ADD COLUMN transporter_id VARCHAR(15),
  ADD COLUMN lr_no VARCHAR(50),
  ADD COLUMN eway_bill_no VARCHAR(12) CHECK (eway_bill_no ~ '^[0-9]{12}$'),
  ADD COLUMN eway_bill_date DATE,
  ADD COLUMN distance_km INT CHECK (distance_km BETWEEN 0 AND 4000),
  -- Dispatches made before this pass were delivered.
  ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'delivered'
    CHECK (delivery_status IN ('out_for_delivery', 'delivered', 'part_returned', 'refused')),
  ADD COLUMN delivered_at TIMESTAMPTZ,
  ADD COLUMN delivery_recorded_by BIGINT REFERENCES users(id),
  ADD COLUMN received_by VARCHAR(100),
  ADD COLUMN delivery_note VARCHAR(300),
  -- The sales return posted for goods that came back in the van.
  ADD COLUMN return_id BIGINT,
  ADD CONSTRAINT wholesale_dispatches_run_fkey FOREIGN KEY (business_id, run_id) REFERENCES wholesale_delivery_runs(business_id, id),
  ADD CONSTRAINT wholesale_dispatches_return_fkey FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  ADD CONSTRAINT wholesale_dispatches_eway_date CHECK (eway_bill_no IS NULL OR eway_bill_date IS NOT NULL),
  ADD CONSTRAINT wholesale_dispatches_delivered CHECK (delivery_status = 'out_for_delivery' OR delivered_at IS NOT NULL OR delivery_recorded_by IS NULL);
ALTER TABLE wholesale_dispatches ALTER COLUMN delivery_status SET DEFAULT 'out_for_delivery';
CREATE INDEX wholesale_dispatches_run ON wholesale_dispatches(business_id, run_id) WHERE run_id IS NOT NULL;
CREATE INDEX wholesale_dispatches_out ON wholesale_dispatches(business_id) WHERE delivery_status = 'out_for_delivery';

-- --- 4. Order lines: discount and free goods; order edits ---------------------------------
ALTER TABLE wholesale_order_lines
  ADD COLUMN discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  -- The price of one stock unit before the discount.
  ADD COLUMN list_unit_price NUMERIC(14,4) CHECK (list_unit_price >= 0),
  -- A free-goods line belongs to the line it was given with.
  ADD COLUMN free_of_line_id BIGINT,
  ADD COLUMN scheme_id BIGINT,
  ADD CONSTRAINT wholesale_order_lines_free_of_fkey FOREIGN KEY (business_id, free_of_line_id) REFERENCES wholesale_order_lines(business_id, id),
  ADD CONSTRAINT wholesale_order_lines_free_is_free CHECK (free_of_line_id IS NULL OR (net = 0 AND tax = 0 AND unit_price = 0));

CREATE TABLE wholesale_order_edits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  -- Order lines whose unsent quantity the edit took off, and the lines it added.
  removed_line_ids BIGINT[] NOT NULL,
  added_line_ids BIGINT[] NOT NULL,
  total_before NUMERIC(16,2) NOT NULL,
  total_after NUMERIC(16,2) NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX wholesale_order_edits_order ON wholesale_order_edits(business_id, order_id);

-- A credit hold let through by a manager, with the reason.
CREATE TABLE wholesale_hold_releases (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  overdue NUMERIC(16,2) NOT NULL,
  overdue_days INT NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  released_by BIGINT NOT NULL REFERENCES users(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id)
);
CREATE INDEX wholesale_hold_releases_order ON wholesale_hold_releases(business_id, order_id);

-- --- 5. Price groups and schemes ---------------------------------------------------------
CREATE TABLE wholesale_price_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
  notes VARCHAR(300),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX wholesale_price_groups_name ON wholesale_price_groups(business_id, lower(name));

-- A price for every customer in a group, from a date (to a date, or open).
-- Changing a price ends the old row the day before the new one starts.
CREATE TABLE wholesale_group_prices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  group_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  -- A pack price ("₹2,050 a case"); NULL = per stock unit.
  unit_code VARCHAR(20),
  minimum_quantity NUMERIC(16,3) NOT NULL DEFAULT 1 CHECK (minimum_quantity > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  valid_from DATE NOT NULL,
  valid_to DATE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_by BIGINT REFERENCES users(id),
  FOREIGN KEY (business_id, group_id) REFERENCES wholesale_price_groups(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, sku_id, unit_code) REFERENCES catalog_sku_units(business_id, sku_id, unit_code),
  UNIQUE (business_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX wholesale_group_prices_lookup ON wholesale_group_prices(business_id, group_id, sku_id, valid_from DESC);

-- Schemes: buy N (in a pack or the stock unit) get M free, and/or a discount
-- %, for a period, for everyone or one price group.
CREATE TABLE wholesale_schemes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  sku_id BIGINT NOT NULL,
  unit_code VARCHAR(20),
  buy_quantity NUMERIC(16,3) NOT NULL CHECK (buy_quantity > 0),
  free_quantity NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (free_quantity >= 0),
  discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent < 100),
  group_id BIGINT,
  valid_from DATE NOT NULL,
  valid_to DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, sku_id, unit_code) REFERENCES catalog_sku_units(business_id, sku_id, unit_code),
  FOREIGN KEY (business_id, group_id) REFERENCES wholesale_price_groups(business_id, id),
  UNIQUE (business_id, id),
  CHECK (free_quantity > 0 OR discount_percent > 0),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX wholesale_schemes_sku ON wholesale_schemes(business_id, sku_id) WHERE active;
ALTER TABLE wholesale_order_lines ADD CONSTRAINT wholesale_order_lines_scheme_fkey FOREIGN KEY (business_id, scheme_id) REFERENCES wholesale_schemes(business_id, id);

-- --- 6. Wholesale customer details --------------------------------------------------------
CREATE TABLE wholesale_customer_profiles (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  price_group_id BIGINT,
  contact_person VARCHAR(100),
  -- GST state code (two digits) for the place of supply when there is no GSTIN.
  state_code CHAR(2) CHECK (state_code ~ '^[0-9]{2}$'),
  pin_code VARCHAR(10),
  pan VARCHAR(10),
  fssai VARCHAR(20),
  -- A walk-in (counter) customer is kept out of order and collection pickers.
  trade_type TEXT NOT NULL DEFAULT 'trade' CHECK (trade_type IN ('trade', 'walk_in')),
  -- Never held for overdue bills (a key account the owner vouches for).
  hold_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, price_group_id) REFERENCES wholesale_price_groups(business_id, id)
);
CREATE TRIGGER wholesale_customer_profiles_customer BEFORE INSERT OR UPDATE OF contact_id ON wholesale_customer_profiles
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- --- 7. Credit hold setting ------------------------------------------------------------------
CREATE TABLE wholesale_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- Hold new orders when a bill is this many days past its due date (NULL = off).
  hold_overdue_days SMALLINT CHECK (hold_overdue_days BETWEEN 1 AND 365),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- 8. Salespeople: login and target ----------------------------------------------------------
ALTER TABLE wholesale_salespeople
  ADD COLUMN user_id BIGINT REFERENCES users(id),
  ADD COLUMN monthly_target NUMERIC(16,2) CHECK (monthly_target >= 0);
CREATE UNIQUE INDEX wholesale_salespeople_user ON wholesale_salespeople(business_id, user_id) WHERE user_id IS NOT NULL;

-- --- 9. Claims against suppliers ------------------------------------------------------------------
CREATE TABLE wholesale_claims (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scheme', 'damage', 'expiry', 'rate_difference', 'shortage', 'other')),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  -- A purchase it relates to (optional).
  document_id BIGINT,
  period_from DATE,
  period_to DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'settled', 'rejected')),
  submitted_at TIMESTAMPTZ,
  settled_amount NUMERIC(16,2) CHECK (settled_amount >= 0),
  credit_note_no VARCHAR(60),
  closed_at TIMESTAMPTZ,
  notes VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  CHECK (status <> 'settled' OR (settled_amount IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR closed_at IS NOT NULL),
  CHECK (period_to IS NULL OR period_from IS NULL OR period_to >= period_from)
);
CREATE INDEX wholesale_claims_open ON wholesale_claims(business_id, status, created_at DESC);

-- Down Migration
DROP TABLE wholesale_claims;
DROP INDEX wholesale_salespeople_user;
ALTER TABLE wholesale_salespeople DROP COLUMN monthly_target, DROP COLUMN user_id;
DROP TABLE wholesale_settings;
DROP TABLE wholesale_customer_profiles;
ALTER TABLE wholesale_order_lines DROP CONSTRAINT wholesale_order_lines_scheme_fkey;
DROP TABLE wholesale_schemes;
DROP TABLE wholesale_group_prices;
DROP TABLE wholesale_price_groups;
DROP TABLE wholesale_hold_releases;
DROP TABLE wholesale_order_edits;
ALTER TABLE wholesale_order_lines DROP CONSTRAINT wholesale_order_lines_free_is_free, DROP CONSTRAINT wholesale_order_lines_free_of_fkey,
  DROP COLUMN scheme_id, DROP COLUMN free_of_line_id, DROP COLUMN list_unit_price, DROP COLUMN discount_percent;
DROP INDEX wholesale_dispatches_out;
DROP INDEX wholesale_dispatches_run;
ALTER TABLE wholesale_dispatches DROP CONSTRAINT wholesale_dispatches_delivered, DROP CONSTRAINT wholesale_dispatches_eway_date,
  DROP CONSTRAINT wholesale_dispatches_return_fkey, DROP CONSTRAINT wholesale_dispatches_run_fkey,
  DROP COLUMN return_id, DROP COLUMN delivery_note, DROP COLUMN received_by, DROP COLUMN delivery_recorded_by, DROP COLUMN delivered_at,
  DROP COLUMN delivery_status, DROP COLUMN distance_km, DROP COLUMN eway_bill_date, DROP COLUMN eway_bill_no, DROP COLUMN lr_no,
  DROP COLUMN transporter_id, DROP COLUMN transporter_name, DROP COLUMN helper_name, DROP COLUMN driver_name, DROP COLUMN run_id;
DROP TABLE wholesale_delivery_runs;
DROP TRIGGER wholesale_settlement_receipts_fixed ON wholesale_settlement_receipts;
DROP TABLE wholesale_settlement_receipts;
DROP TRIGGER wholesale_settlements_fixed ON wholesale_settlements;
DROP TABLE wholesale_settlements;
DROP FUNCTION wholesale_settlements_fixed();
DROP TRIGGER business_collection_cheques_flow ON business_collection_cheques;
DROP TABLE business_collection_cheques;
DROP FUNCTION business_collection_cheques_flow();
DELETE FROM business_role_permissions WHERE permission_code = 'receivables.approve';
DELETE FROM business_role_template_permissions WHERE permission_code = 'receivables.approve';
DELETE FROM business_permissions WHERE code = 'receivables.approve';
