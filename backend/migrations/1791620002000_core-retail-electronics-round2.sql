-- Up Migration
-- Round 2, shared core, retail & electronics (builder R2-CORE, 8 Oct 2026).
--
-- 1. Split payment on shop bills: a bill takes several payments in one
--    posting (cash + UPI + card, the rest on udhaar). Cash is the only part
--    that can be over-tendered: `tendered` is what the customer handed over,
--    the change is tendered - amount, and the amount is what stays in the
--    drawer.
-- 2. Per-staff PIN at a shared counter: a business setting that asks the
--    biller's PIN for every bill at Quick bill.
-- 3. Loyalty: points spent on a bill come back, in proportion, when goods on
--    that bill are returned (a setting, on by default). New entry kind
--    'restore'.
-- 4. Accessory kits / bundles: a kit item sells at its own price; its stock,
--    GST and HSN lines are its components'. Sale lines remember the kit.
-- 5. Electronics EMI sale: module "EMI & finance" (electronics), financiers,
--    finance cases (the financed part of a bill is owed by the financier) and
--    the financier's payouts (net of the dealer subvention). A payment of
--    method 'finance' settles the customer's part; a refund of method
--    'finance' reverses it when the financier cancels after a return.

-- --- 1. Split payment -------------------------------------------------------------
ALTER TABLE business_payments DROP CONSTRAINT business_payments_method_check,
  ADD CONSTRAINT business_payments_method_check
  CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque', 'credit_note', 'finance'));
ALTER TABLE business_payments ADD CONSTRAINT business_payments_business_id_id_key UNIQUE (business_id, id);
ALTER TABLE business_payments ADD COLUMN tendered numeric(14,2),
  ADD CONSTRAINT business_payments_tendered_cash CHECK (tendered IS NULL OR (method = 'cash' AND tendered >= amount));
ALTER TABLE business_refunds DROP CONSTRAINT business_refunds_method_check,
  ADD CONSTRAINT business_refunds_method_check
  CHECK (method IN ('cash', 'card', 'upi', 'bank', 'credit_note', 'finance'));

-- --- 2. Counter PIN -----------------------------------------------------------------
ALTER TABLE business_settings ADD COLUMN counter_pin_every_bill boolean NOT NULL DEFAULT false;

-- --- 3. Loyalty points spent, back on a return ------------------------------------
ALTER TABLE retail_loyalty_settings ADD COLUMN return_spent_points boolean NOT NULL DEFAULT true;
ALTER TABLE retail_loyalty_entries DROP CONSTRAINT retail_loyalty_entries_kind_check,
  ADD CONSTRAINT retail_loyalty_entries_kind_check CHECK (kind IN ('earn', 'redeem', 'adjust', 'reverse', 'restore'));
ALTER TABLE retail_loyalty_entries DROP CONSTRAINT retail_loyalty_entries_shape,
  ADD CONSTRAINT retail_loyalty_entries_shape CHECK (
    (kind = 'earn' AND points > 0 AND document_id IS NOT NULL AND value IS NULL AND return_id IS NULL)
    OR (kind = 'redeem' AND points < 0 AND document_id IS NOT NULL AND value IS NOT NULL AND return_id IS NULL)
    OR (kind = 'adjust' AND points <> 0 AND document_id IS NULL AND value IS NULL AND reason IS NOT NULL AND request_key IS NOT NULL AND return_id IS NULL)
    OR (kind = 'reverse' AND points <= 0 AND document_id IS NOT NULL AND return_id IS NOT NULL AND value IS NULL AND (points < 0 OR shortfall_points > 0))
    OR (kind = 'restore' AND points > 0 AND document_id IS NOT NULL AND return_id IS NOT NULL AND value IS NOT NULL));
-- A return now writes up to two entries: spent points back, earned points taken.
DROP INDEX retail_loyalty_entries_one_per_return;
CREATE UNIQUE INDEX retail_loyalty_entries_one_per_return ON retail_loyalty_entries (business_id, return_id, kind) WHERE return_id IS NOT NULL;

-- --- 4. Kits ------------------------------------------------------------------------
ALTER TABLE catalog_skus ADD COLUMN is_kit boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT catalog_skus_kit_untracked CHECK (NOT is_kit OR tracking = 'none');
CREATE TABLE catalog_kit_components (
  id bigserial PRIMARY KEY,
  business_id bigint NOT NULL REFERENCES businesses(id),
  kit_sku_id bigint NOT NULL,
  component_sku_id bigint NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0 AND quantity <= 1000),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, kit_sku_id, component_sku_id),
  FOREIGN KEY (business_id, kit_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, component_sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (kit_sku_id <> component_sku_id)
);
CREATE INDEX catalog_kit_components_kit ON catalog_kit_components (business_id, kit_sku_id, sort_order);

ALTER TABLE business_document_lines ADD COLUMN kit_sku_id bigint, ADD COLUMN kit_label varchar(150), ADD COLUMN kit_group smallint,
  ADD CONSTRAINT business_document_lines_kit_fkey FOREIGN KEY (business_id, kit_sku_id) REFERENCES catalog_skus(business_id, id),
  ADD CONSTRAINT business_document_lines_kit_shape CHECK ((kit_sku_id IS NULL) = (kit_group IS NULL) AND (kit_sku_id IS NULL) = (kit_label IS NULL));

-- --- 5. EMI & finance (electronics) -------------------------------------------------
INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('finance', 'EMI & finance', 'Sell on EMI through Bajaj Finserv, HDFC, ICICI, Home Credit and others: the financed part is owed by the financier, payouts are recorded net of the dealer subvention.', 'optional', 295);
INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES ('finance', 'sales');
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('finance', 'electronics', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('finance.view', 'finance', 'view', 'See EMI cases, financiers and what each financier owes', 295),
 ('finance.create', 'finance', 'create', 'Sell on EMI at the counter', 296),
 ('finance.edit', 'finance', 'edit', 'Keep the financier list, record payouts and cancel EMI cases', 297);
INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES
 ('manager', 'finance.view'), ('manager', 'finance.create'), ('manager', 'finance.edit'),
 ('cashier', 'finance.view'), ('cashier', 'finance.create'),
 ('accountant', 'finance.view'), ('accountant', 'finance.edit'),
 ('viewer', 'finance.view');
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code AND tp.permission_code LIKE 'finance.%'
JOIN businesses b ON b.id = r.business_id AND b.business_type = 'electronics'
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, 'finance' FROM businesses b WHERE b.business_type = 'electronics'
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'sales')
ON CONFLICT DO NOTHING;

CREATE TABLE electronics_financiers (
  id bigserial PRIMARY KEY,
  business_id bigint NOT NULL REFERENCES businesses(id),
  name varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  subvention_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (subvention_percent >= 0 AND subvention_percent <= 30),
  active boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX electronics_financiers_name ON electronics_financiers (business_id, lower(name));

-- The usual consumer-durable financiers, for every electronics shop (now and
-- each new one). The owner adds others and sets each one's subvention.
CREATE FUNCTION electronics_default_financiers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_type = 'electronics' THEN
    INSERT INTO electronics_financiers (business_id, name)
    SELECT NEW.id, f.name FROM (VALUES ('Bajaj Finserv'), ('HDFC Bank'), ('ICICI Bank'), ('Home Credit')) AS f(name)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER businesses_default_financiers AFTER INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION electronics_default_financiers();
INSERT INTO electronics_financiers (business_id, name)
SELECT b.id, f.name FROM businesses b CROSS JOIN (VALUES ('Bajaj Finserv'), ('HDFC Bank'), ('ICICI Bank'), ('Home Credit')) AS f(name)
WHERE b.business_type = 'electronics'
ON CONFLICT DO NOTHING;

-- A financier's payout for one or more EMI cases.
CREATE TABLE electronics_finance_settlements (
  id bigserial PRIMARY KEY,
  business_id bigint NOT NULL REFERENCES businesses(id),
  financier_id bigint NOT NULL,
  location_id bigint NOT NULL,
  received_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('bank', 'cheque', 'upi')),
  reference varchar(100),
  amount_received numeric(14,2) NOT NULL CHECK (amount_received >= 0),
  subvention_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (subvention_total >= 0),
  notes varchar(300),
  request_key uuid NOT NULL,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  FOREIGN KEY (business_id, financier_id) REFERENCES electronics_financiers(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CHECK (amount_received + subvention_total > 0)
);

-- The financed part of one bill: owed by the financier until paid out.
CREATE TABLE electronics_finance_cases (
  id bigserial PRIMARY KEY,
  business_id bigint NOT NULL REFERENCES businesses(id),
  document_id bigint NOT NULL,
  payment_id bigint NOT NULL,
  financier_id bigint NOT NULL,
  loan_no varchar(60) NOT NULL CHECK (btrim(loan_no) <> ''),
  do_no varchar(60),
  tenure_months smallint CHECK (tenure_months BETWEEN 1 AND 60),
  customer_name varchar(150),
  customer_phone varchar(30),
  down_payment numeric(14,2) NOT NULL DEFAULT 0 CHECK (down_payment >= 0),
  financed_amount numeric(14,2) NOT NULL CHECK (financed_amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'cancelled')),
  settlement_id bigint,
  subvention_charged numeric(14,2) CHECK (subvention_charged >= 0 AND subvention_charged <= financed_amount),
  cancelled_reason varchar(300),
  cancelled_by bigint REFERENCES users(id),
  cancelled_at timestamptz,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, payment_id),
  UNIQUE (business_id, financier_id, loan_no),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, payment_id) REFERENCES business_payments(business_id, id),
  FOREIGN KEY (business_id, financier_id) REFERENCES electronics_financiers(business_id, id),
  FOREIGN KEY (business_id, settlement_id) REFERENCES electronics_finance_settlements(business_id, id),
  CHECK ((status = 'settled') = (settlement_id IS NOT NULL) AND (status = 'settled') = (subvention_charged IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_reason IS NOT NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX electronics_finance_cases_open ON electronics_finance_cases (business_id, financier_id, status, created_at);
CREATE INDEX electronics_finance_cases_document ON electronics_finance_cases (business_id, document_id);

-- A case moves once: pending to settled or cancelled; nothing else changes.
CREATE FUNCTION electronics_finance_case_one_way() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only the time stamp may be corrected (the demo set-up spreads sample records).
  IF to_jsonb(NEW) - 'created_at' = to_jsonb(OLD) - 'created_at' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'This EMI case is already % and cannot change', OLD.status USING ERRCODE = '23514';
  END IF;
  IF (NEW.document_id, NEW.payment_id, NEW.financier_id, NEW.loan_no, NEW.down_payment, NEW.financed_amount, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.document_id, OLD.payment_id, OLD.financier_id, OLD.loan_no, OLD.down_payment, OLD.financed_amount, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'The bill, financier, loan number and amounts of an EMI case cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER electronics_finance_cases_one_way BEFORE UPDATE ON electronics_finance_cases
  FOR EACH ROW EXECUTE FUNCTION electronics_finance_case_one_way();
CREATE FUNCTION electronics_finance_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EMI cases and payouts are kept; cancel a case instead' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER electronics_finance_cases_no_delete BEFORE DELETE ON electronics_finance_cases
  FOR EACH ROW EXECUTE FUNCTION electronics_finance_no_delete();
CREATE FUNCTION electronics_finance_settlement_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) - 'created_at' = to_jsonb(OLD) - 'created_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A financier payout is kept as recorded' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER electronics_finance_settlements_no_change BEFORE UPDATE OR DELETE ON electronics_finance_settlements
  FOR EACH ROW EXECUTE FUNCTION electronics_finance_settlement_kept();

-- Down Migration
DROP TABLE electronics_finance_cases;
DROP TABLE electronics_finance_settlements;
DROP FUNCTION electronics_finance_case_one_way();
DROP FUNCTION electronics_finance_settlement_kept();
DROP FUNCTION electronics_finance_no_delete();
DROP TRIGGER businesses_default_financiers ON businesses;
DROP FUNCTION electronics_default_financiers();
DROP TABLE electronics_financiers;
DELETE FROM business_capabilities WHERE capability = 'finance';
DELETE FROM business_role_permissions WHERE permission_code LIKE 'finance.%';
DELETE FROM business_role_template_permissions WHERE permission_code LIKE 'finance.%';
DELETE FROM business_permissions WHERE module_code = 'finance';
DELETE FROM platform_module_business_types WHERE module_code = 'finance';
DELETE FROM platform_module_dependencies WHERE module_code = 'finance';
DELETE FROM platform_modules WHERE code = 'finance';
ALTER TABLE business_document_lines DROP CONSTRAINT business_document_lines_kit_shape, DROP CONSTRAINT business_document_lines_kit_fkey,
  DROP COLUMN kit_group, DROP COLUMN kit_label, DROP COLUMN kit_sku_id;
DROP TABLE catalog_kit_components;
ALTER TABLE catalog_skus DROP CONSTRAINT catalog_skus_kit_untracked, DROP COLUMN is_kit;
ALTER TABLE retail_loyalty_entries DISABLE TRIGGER USER;
DELETE FROM retail_loyalty_entries WHERE kind = 'restore';
ALTER TABLE retail_loyalty_entries ENABLE TRIGGER USER;
DROP INDEX retail_loyalty_entries_one_per_return;
CREATE UNIQUE INDEX retail_loyalty_entries_one_per_return ON retail_loyalty_entries (business_id, return_id) WHERE return_id IS NOT NULL;
ALTER TABLE retail_loyalty_entries DROP CONSTRAINT retail_loyalty_entries_shape,
  ADD CONSTRAINT retail_loyalty_entries_shape CHECK (
    (kind = 'earn' AND points > 0 AND document_id IS NOT NULL AND value IS NULL AND return_id IS NULL)
    OR (kind = 'redeem' AND points < 0 AND document_id IS NOT NULL AND value IS NOT NULL AND return_id IS NULL)
    OR (kind = 'adjust' AND points <> 0 AND document_id IS NULL AND value IS NULL AND reason IS NOT NULL AND request_key IS NOT NULL AND return_id IS NULL)
    OR (kind = 'reverse' AND points <= 0 AND document_id IS NOT NULL AND return_id IS NOT NULL AND value IS NULL AND (points < 0 OR shortfall_points > 0)));
ALTER TABLE retail_loyalty_entries DROP CONSTRAINT retail_loyalty_entries_kind_check,
  ADD CONSTRAINT retail_loyalty_entries_kind_check CHECK (kind IN ('earn', 'redeem', 'adjust', 'reverse'));
ALTER TABLE retail_loyalty_settings DROP COLUMN return_spent_points;
ALTER TABLE business_settings DROP COLUMN counter_pin_every_bill;
ALTER TABLE business_refunds DROP CONSTRAINT business_refunds_method_check,
  ADD CONSTRAINT business_refunds_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'credit_note'));
ALTER TABLE business_payments DROP CONSTRAINT business_payments_tendered_cash, DROP COLUMN tendered;
ALTER TABLE business_payments DROP CONSTRAINT business_payments_business_id_id_key;
ALTER TABLE business_payments DROP CONSTRAINT business_payments_method_check,
  ADD CONSTRAINT business_payments_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque', 'credit_note'));
