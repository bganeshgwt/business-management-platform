-- Up Migration
-- Paid plans: what the platform sells, what each business may use and until
-- when, and the platform company's own orders, payments, GST invoices and
-- leads.
--
-- A business pays per business for a plan of its type plus optional modules
-- and applications (add-ons), monthly or yearly. It may be used while a dated
-- access period covers its own today: a trial (every new business starts one),
-- paid time (from a paid order) or time given by the super admin. After paid
-- or given time come the grace days; after that, or after a trial, the
-- business is read-only until it pays. Nothing is ever deleted.
--
--   platform_settings        one row: trial and grace days, the company's
--                            details and GSTIN (a sample one until the real
--                            one is entered), how owners pay, prices reviewed
--   platform_plans           the plans of each business type (one default)
--   platform_plan_modules    the optional modules a plan includes
--   platform_module_prices   each optional module's price, sold as a module or
--                            an application, and whether owners may add it
--   business_subscriptions   a business's selection for its next order: plan
--                            and month or year ...
--   business_subscription_addons   ... and the add-ons on top of the plan
--   business_access_periods  dated trial, paid and given time; each carries a
--                            copy of what it unlocks (everything, or its plan
--                            and module list), made when the period is made
--   business_access_addons   one module unlocked for its own dates inside paid
--                            or given time (paid, or given with a reason)
--   platform_orders, platform_order_lines, platform_payments
--                            what a business is asked to pay, with GST, and the
--                            payments owners enter for the super admin to
--                            confirm or reject
--   platform_invoice_series, platform_invoices
--                            the company's GST tax invoices, numbered per GSTIN
--                            and financial year; the sample GSTIN has a series
--                            of its own, so sample invoices never use a real
--                            number
--   platform_leads, platform_lead_notes   enquiries and sign-ups
--   platform_audit           the super admin's changes to settings, prices and
--                            leads (a business's own changes stay in
--                            business_audit)
--
-- Functions, so lists and dashboards read the same answer as the server:
--   business_time_zone(), business_local_today()
--                            a business's clock: a restaurant's own time zone,
--                            any other business's
--   business_plan_state()    its state today and the dates that go with it
--   business_entitled_modules()   the optional modules its plan unlocks today
--   business_active_capabilities()   its switched-on modules that are also
--                            unlocked: what every module check reads
--   restaurant_features()    now reads business_active_capabilities()
--
-- A restaurant switched off or on takes its business row with it (trigger
-- restaurants_business_status), so a business is off when either is.
--
-- A new module, captain_app (the captain app on a phone), is sold as an
-- application; every restaurant has it on today. Every business that exists
-- now (every restaurant is linked to its business first) gets given time with
-- no end that unlocks everything, so nothing changes for anyone; a business
-- made from now on starts its trial through the trigger businesses_start_plan.

-- --- Settings -----------------------------------------------------------------------------------

CREATE TABLE platform_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- A new business's trial; changes apply to trials that start afterwards.
  trial_days SMALLINT NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 30),
  -- Days after paid or given time ends when the business still works (never after a trial).
  grace_days SMALLINT NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 30),
  brand_name VARCHAR(80) NOT NULL DEFAULT 'Business Management Platform' CHECK (length(btrim(brand_name)) > 0),
  -- The supplier on every tax invoice.
  legal_name VARCHAR(200),
  address_line1 VARCHAR(200),
  address_line2 VARCHAR(200),
  city VARCHAR(100),
  postal_code VARCHAR(10) CHECK (postal_code ~ '^[0-9]{6}$'),
  -- The sample GSTIN until the real one is entered; its first two digits are
  -- the supplier's state. The API checks the check character.
  gstin CHAR(15) NOT NULL DEFAULT '22AAAAA0000A1ZC' CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan CHAR(10) CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  phone VARCHAR(30),
  email VARCHAR(150),
  website VARCHAR(200),
  sac_code VARCHAR(6) NOT NULL DEFAULT '998315' CHECK (sac_code ~ '^[0-9]{6}$'),
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 18.00 CHECK (gst_rate BETWEEN 0 AND 40),
  -- Letters, digits and '-', not ending in a digit: "<prefix>/<FY>/<n>" then reads one way only. At
  -- most 5 characters, so a year's 16-character numbers have room for 99,999 invoices.
  invoice_prefix VARCHAR(5) NOT NULL DEFAULT 'BMP' CHECK (invoice_prefix ~ '^[A-Z][A-Z0-9-]{0,3}[A-Z-]$'),
  support_phone VARCHAR(30),
  support_email VARCHAR(150),
  grievance_officer_name VARCHAR(150),
  grievance_officer_email VARCHAR(150),
  -- How an owner pays until online payment arrives.
  upi_id VARCHAR(100),
  upi_payee_name VARCHAR(100),
  bank_name VARCHAR(100),
  bank_account_name VARCHAR(150),
  bank_account_number VARCHAR(30),
  bank_ifsc CHAR(11) CHECK (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  payment_note VARCHAR(500),
  -- Set when the super admin saves the price list; until then the overview asks for a review.
  prices_reviewed_at TIMESTAMPTZ,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (id) VALUES (1);

-- --- The catalogue: plans and prices ------------------------------------------------------------

-- Prices are before GST. NULL is "not set yet": nothing without a price for
-- the chosen month or year can be bought.
CREATE TABLE platform_plans (
  code TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  business_type TEXT NOT NULL REFERENCES business_types(code),
  name VARCHAR(80) NOT NULL CHECK (length(btrim(name)) > 0),
  description VARCHAR(400),
  monthly_price NUMERIC(12,2) CHECK (monthly_price > 0),
  yearly_price NUMERIC(12,2) CHECK (yearly_price > 0),
  -- The plan a new business of the type starts with. A default plan stays on offer.
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order SMALLINT NOT NULL DEFAULT 100,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (active OR NOT is_default)
);
CREATE UNIQUE INDEX platform_plans_one_default ON platform_plans(business_type) WHERE is_default;

-- A plan belongs to one business type for good: its modules and the
-- businesses on it are of that type.
CREATE FUNCTION platform_plans_type_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_type <> OLD.business_type THEN
    RAISE EXCEPTION 'A plan''s business type cannot change; add a plan for the other type instead' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_plans_type_fixed BEFORE UPDATE OF business_type ON platform_plans
  FOR EACH ROW EXECUTE FUNCTION platform_plans_type_fixed();

CREATE TABLE platform_plan_modules (
  plan_code TEXT NOT NULL REFERENCES platform_plans(code),
  module_code TEXT NOT NULL REFERENCES platform_modules(code),
  PRIMARY KEY (plan_code, module_code)
);

-- Whether an optional module may be sold to a business of this type: it
-- applies to the type, and it is not the restaurant module itself, which every
-- restaurant always has and is never sold on its own.
CREATE FUNCTION platform_module_sellable(p_module TEXT, p_type TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT p_module <> 'restaurant' AND EXISTS (
    SELECT 1 FROM platform_module_business_types t JOIN platform_modules m ON m.code = t.module_code AND m.kind = 'optional'
    WHERE t.module_code = p_module AND t.business_type = p_type);
$$;

CREATE FUNCTION platform_plan_modules_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT platform_module_sellable(NEW.module_code, (SELECT business_type FROM platform_plans WHERE code = NEW.plan_code)) THEN
    RAISE EXCEPTION 'A plan holds only modules its business type can use (not %)', NEW.module_code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_plan_modules_check BEFORE INSERT OR UPDATE ON platform_plan_modules
  FOR EACH ROW EXECUTE FUNCTION platform_plan_modules_check();

-- sold_as 'application': a module with its own screen or device for its own
-- people (the captain app, the kitchen display); 'module' otherwise. A price of
-- 0 is free; NULL is not set yet.
CREATE TABLE platform_module_prices (
  module_code TEXT PRIMARY KEY REFERENCES platform_modules(code),
  sold_as TEXT NOT NULL DEFAULT 'module' CHECK (sold_as IN ('module', 'application')),
  monthly_price NUMERIC(12,2) CHECK (monthly_price >= 0),
  yearly_price NUMERIC(12,2) CHECK (yearly_price >= 0),
  -- Owners may add it to their selection.
  available BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION platform_module_prices_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.module_code = 'restaurant' OR NOT EXISTS (SELECT 1 FROM platform_modules WHERE code = NEW.module_code AND kind = 'optional') THEN
    RAISE EXCEPTION 'Only optional modules have prices (not %)', NEW.module_code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_module_prices_check BEFORE INSERT OR UPDATE OF module_code ON platform_module_prices
  FOR EACH ROW EXECUTE FUNCTION platform_module_prices_check();

-- --- The captain app ----------------------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order, feature_group) VALUES
 ('captain_app', 'Captain app', 'Captains take orders, send courses, see what is ready and answer tables from their phone.', 'optional', 319, 'Service');
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('captain_app', 'restaurant', TRUE);
INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES ('captain_app', 'restaurant');

-- --- Starting prices ----------------------------------------------------------------------------

-- Every optional module but the restaurant module: modules at ₹199 a month or
-- ₹1,999 a year, the five applications at their own prices. The super admin
-- reviews them before going live.
INSERT INTO platform_module_prices (module_code, sold_as, monthly_price, yearly_price)
SELECT m.code, CASE WHEN a.code IS NULL THEN 'module' ELSE 'application' END, COALESCE(a.monthly, 199), COALESCE(a.yearly, 1999)
FROM platform_modules m
LEFT JOIN (VALUES ('captain_app', 299, 2999), ('kitchen_display', 299, 2999), ('qr_ordering', 299, 2999),
                  ('online_ordering', 399, 3999), ('lab', 499, 4999)) AS a(code, monthly, yearly) ON a.code = m.code
WHERE m.kind = 'optional' AND m.code <> 'restaurant';

-- One "Basic" plan per business type, its default. A type missing from the
-- list still gets its plan, with no price yet.
INSERT INTO platform_plans (code, business_type, name, description, monthly_price, yearly_price, is_default, sort_order)
SELECT t.code || '_basic', t.code, 'Basic', 'The everyday tools of this kind of business.', p.monthly, p.yearly, TRUE, 10
FROM business_types t
LEFT JOIN (VALUES
  ('grocery', 499, 4999), ('general_retail', 499, 4999), ('books', 499, 4999), ('meat', 499, 4999), ('weight_retail', 499, 4999),
  ('optical', 499, 4999), ('agri_inputs', 499, 4999), ('hardware', 499, 4999), ('fashion', 499, 4999), ('electronics', 499, 4999),
  ('pharmacy', 499, 4999),
  ('supermarket', 799, 7999), ('wholesale', 799, 7999), ('jewellery', 799, 7999), ('fuel_station', 799, 7999), ('restaurant', 799, 7999),
  ('salon', 599, 5999), ('memberships', 599, 5999), ('laundry', 599, 5999), ('garage', 599, 5999), ('rentals', 599, 5999),
  ('healthcare', 1199, 11999), ('lodging', 1199, 11999)
) AS p(type, monthly, yearly) ON p.type = t.code;

-- Basic holds the modules the type starts with switched on, without the
-- applications (sold on their own) and the restaurant module. A restaurant's
-- also holds pre-orders and brands, which its café, bakery and cloud kitchen
-- formats switch on, so a paying café keeps its pre-orders.
INSERT INTO platform_plan_modules (plan_code, module_code)
SELECT t.business_type || '_basic', t.module_code
FROM platform_module_business_types t
JOIN platform_module_prices p ON p.module_code = t.module_code AND p.sold_as = 'module'
WHERE t.enabled_by_default OR (t.business_type = 'restaurant' AND t.module_code IN ('preorders', 'brands'));

-- --- A business's selection for its next order -------------------------------------------------

-- The plan, the billing period and the add-ons the business will buy next. It
-- shapes the next order only: it never changes what the business may use
-- today. plan_code is NULL only when the type has no default plan.
CREATE TABLE business_subscriptions (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  plan_code TEXT REFERENCES platform_plans(code),
  billing_period TEXT NOT NULL DEFAULT 'year' CHECK (billing_period IN ('month', 'year')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION business_subscriptions_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_plans p JOIN businesses b ON b.business_type = p.business_type
                                               WHERE p.code = NEW.plan_code AND b.id = NEW.business_id) THEN
    RAISE EXCEPTION 'That plan is for another type of business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_subscriptions_check BEFORE INSERT OR UPDATE OF plan_code ON business_subscriptions
  FOR EACH ROW EXECUTE FUNCTION business_subscriptions_check();

CREATE TABLE business_subscription_addons (
  business_id BIGINT NOT NULL REFERENCES business_subscriptions(business_id),
  module_code TEXT NOT NULL REFERENCES platform_modules(code),
  added_by BIGINT REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, module_code)
);
CREATE FUNCTION business_subscription_addons_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT platform_module_sellable(NEW.module_code, (SELECT business_type FROM businesses WHERE id = NEW.business_id)) THEN
    RAISE EXCEPTION 'This business cannot use %', NEW.module_code USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM business_subscriptions s JOIN platform_plan_modules m ON m.plan_code = s.plan_code
             WHERE s.business_id = NEW.business_id AND m.module_code = NEW.module_code) THEN
    RAISE EXCEPTION 'The chosen plan already includes %', NEW.module_code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_subscription_addons_check BEFORE INSERT OR UPDATE ON business_subscription_addons
  FOR EACH ROW EXECUTE FUNCTION business_subscription_addons_check();

-- --- Orders and payments ------------------------------------------------------------------------

-- What a business is asked to pay: a subscription (plan and add-ons for one
-- period) or add-ons for the rest of the current paid period. Its lines,
-- prices, buyer and GST are copies made when it is made, so a later price
-- change never changes it; `modules` is what it unlocks once paid. One open
-- order per business; an open order holds its prices until valid_until.
CREATE TABLE platform_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('subscription', 'add_on')),
  plan_code TEXT REFERENCES platform_plans(code),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('month', 'year')),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  modules TEXT[] NOT NULL DEFAULT '{}',
  valid_until DATE NOT NULL,
  -- The buyer as billed: name, GSTIN, address and state.
  buyer JSONB NOT NULL CHECK (jsonb_typeof(buyer) = 'object'),
  supplier_state_code CHAR(2) NOT NULL CHECK (supplier_state_code ~ '^[0-9]{2}$'),
  place_of_supply_code CHAR(2) NOT NULL CHECK (place_of_supply_code ~ '^[0-9]{2}$'),
  gst_rate NUMERIC(5,2) NOT NULL CHECK (gst_rate BETWEEN 0 AND 40),
  taxable_amount NUMERIC(12,2) NOT NULL CHECK (taxable_amount >= 0),
  cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  total_amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  UNIQUE (business_id, id),
  CHECK ((kind = 'subscription') = (plan_code IS NOT NULL)),
  CHECK (ends_on >= starts_on),
  CHECK (total_amount = taxable_amount + cgst_amount + sgst_amount + igst_amount),
  -- Within the supplier's state CGST and SGST, each half; to another state IGST alone.
  CHECK (cgst_amount = sgst_amount AND (igst_amount = 0 OR cgst_amount = 0)),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL) AND (status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX platform_orders_one_open ON platform_orders(business_id) WHERE status = 'open';
CREATE INDEX platform_orders_business ON platform_orders(business_id, created_at DESC);

-- An order is open until it is paid or cancelled, and then stays as it is.
CREATE FUNCTION platform_orders_one_way() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An order is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'This order is already % and stays as it is', OLD.status USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'paid_at', 'cancelled_at']) <> (to_jsonb(OLD) - ARRAY['status', 'paid_at', 'cancelled_at']) THEN
    RAISE EXCEPTION 'An order is never changed: cancel it and make another' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_orders_one_way BEFORE UPDATE OR DELETE ON platform_orders
  FOR EACH ROW EXECUTE FUNCTION platform_orders_one_way();

-- Each line at its full price for the period, or (an add-on bought mid-period)
-- that price for the days left: amount = full_price x charged_days / period_days.
CREATE TABLE platform_order_lines (
  order_id BIGINT NOT NULL REFERENCES platform_orders(id),
  line_no SMALLINT NOT NULL CHECK (line_no >= 1),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('plan', 'module', 'application')),
  item_code TEXT NOT NULL,
  name VARCHAR(150) NOT NULL,
  full_price NUMERIC(12,2) NOT NULL CHECK (full_price >= 0),
  charged_days INTEGER NOT NULL CHECK (charged_days >= 1),
  period_days INTEGER NOT NULL CHECK (period_days >= charged_days),
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (order_id, line_no)
);

-- A payment an owner entered (UPI, bank transfer, cash or cheque, with its
-- reference) for the super admin to confirm or reject, or one the super admin
-- recorded and confirmed at once. Confirmed or rejected, it stays as it is.
CREATE TABLE platform_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  order_id BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('upi', 'bank', 'cash', 'cheque')),
  reference VARCHAR(100) NOT NULL CHECK (length(btrim(reference)) > 0),
  paid_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  submitted_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by BIGINT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_note VARCHAR(500),
  FOREIGN KEY (business_id, order_id) REFERENCES platform_orders(business_id, id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR length(btrim(COALESCE(decision_note, ''))) > 0)
);
CREATE UNIQUE INDEX platform_payments_one_pending ON platform_payments(order_id) WHERE status = 'pending';
CREATE UNIQUE INDEX platform_payments_one_confirmed ON platform_payments(order_id) WHERE status = 'confirmed';
CREATE INDEX platform_payments_business ON platform_payments(business_id, submitted_at DESC);
CREATE INDEX platform_payments_pending ON platform_payments(submitted_at) WHERE status = 'pending';

CREATE FUNCTION platform_payments_one_way() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A payment is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'This payment is already % and stays as it is', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'pending'
     OR (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'decision_note'])
        <> (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'decision_note']) THEN
    RAISE EXCEPTION 'A payment is only ever confirmed or rejected, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_payments_one_way BEFORE UPDATE OR DELETE ON platform_payments
  FOR EACH ROW EXECUTE FUNCTION platform_payments_one_way();

-- --- Access: dated periods and add-on grants ----------------------------------------------------

-- Time a business may be used, both days included: a trial (always
-- everything), paid time (from a paid order) or given time (by the super
-- admin, with a reason; it may have no end). A period copies what it unlocks
-- when it is made: everything, or its plan and the optional modules it covers.
-- A later change to a plan or a selection never changes a running period.
-- Periods of a business never overlap; a period is never changed, only
-- cancelled once with a reason (the super admin's new end for given time
-- cancels the old period and adds another).
CREATE TABLE business_access_periods (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('trial', 'paid', 'given')),
  starts_on DATE NOT NULL,
  ends_on DATE,
  everything BOOLEAN NOT NULL DEFAULT FALSE,
  plan_code TEXT REFERENCES platform_plans(code),
  modules TEXT[] NOT NULL DEFAULT '{}',
  order_id BIGINT,
  reason VARCHAR(300),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  cancel_reason VARCHAR(300),
  FOREIGN KEY (business_id, order_id) REFERENCES platform_orders(business_id, id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (ends_on IS NOT NULL OR kind = 'given'),
  CHECK (kind <> 'trial' OR everything),
  CHECK (everything = (plan_code IS NULL)),
  CHECK (NOT everything OR modules = '{}'),
  CHECK ((kind = 'paid') = (order_id IS NOT NULL)),
  CHECK (kind <> 'given' OR length(btrim(COALESCE(reason, ''))) > 0),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL) AND (cancel_reason IS NULL OR length(btrim(cancel_reason)) > 0))
);
CREATE INDEX business_access_periods_business ON business_access_periods(business_id, ends_on);

CREATE FUNCTION business_access_periods_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  btype TEXT;
  missing TEXT;
BEGIN
  SELECT business_type INTO btype FROM businesses WHERE id = NEW.business_id;
  IF NEW.plan_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_plans WHERE code = NEW.plan_code AND business_type = btype) THEN
    RAISE EXCEPTION 'That plan is for another type of business' USING ERRCODE = '23514';
  END IF;
  SELECT string_agg(m, ', ') INTO missing FROM unnest(NEW.modules) m WHERE NOT platform_module_sellable(m, btype);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'This business cannot use the module %', missing USING ERRCODE = '23514';
  END IF;
  IF NEW.cancelled_at IS NULL AND EXISTS (
       SELECT 1 FROM business_access_periods p
       WHERE p.business_id = NEW.business_id AND p.cancelled_at IS NULL
         AND daterange(p.starts_on, p.ends_on, '[]') && daterange(NEW.starts_on, NEW.ends_on, '[]')) THEN
    RAISE EXCEPTION 'Access periods of a business cannot overlap: this one starts before the time it already has ends' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_access_periods_check BEFORE INSERT ON business_access_periods
  FOR EACH ROW EXECUTE FUNCTION business_access_periods_check();

-- One module or application unlocked for its own dates: paid (an add-on order,
-- ending with the paid period it was bought in) or given (by the super admin,
-- with a reason and an end).
CREATE TABLE business_access_addons (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  module_code TEXT NOT NULL REFERENCES platform_modules(code),
  kind TEXT NOT NULL CHECK (kind IN ('paid', 'given')),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  order_id BIGINT,
  reason VARCHAR(300),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  cancel_reason VARCHAR(300),
  FOREIGN KEY (business_id, order_id) REFERENCES platform_orders(business_id, id),
  CHECK (ends_on >= starts_on),
  CHECK ((kind = 'paid') = (order_id IS NOT NULL)),
  CHECK (kind <> 'given' OR length(btrim(COALESCE(reason, ''))) > 0),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL) AND (cancel_reason IS NULL OR length(btrim(cancel_reason)) > 0))
);
CREATE INDEX business_access_addons_business ON business_access_addons(business_id, ends_on);

CREATE FUNCTION business_access_addons_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT platform_module_sellable(NEW.module_code, (SELECT business_type FROM businesses WHERE id = NEW.business_id)) THEN
    RAISE EXCEPTION 'This business cannot use the module %', NEW.module_code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_access_addons_check BEFORE INSERT ON business_access_addons
  FOR EACH ROW EXECUTE FUNCTION business_access_addons_check();

-- Periods and grants are kept as they were made: only their cancel columns
-- are ever set, once.
CREATE FUNCTION business_access_kept() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  what TEXT := CASE TG_TABLE_NAME WHEN 'business_access_periods' THEN 'access period' ELSE 'add-on grant' END;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An % is never deleted; cancel it with a reason instead', what USING ERRCODE = '23514';
  END IF;
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This % is already cancelled', what USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason']) <> (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason']) THEN
    RAISE EXCEPTION 'An % is never changed: cancel it with a reason and add another', what USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_access_periods_kept BEFORE UPDATE OR DELETE ON business_access_periods
  FOR EACH ROW EXECUTE FUNCTION business_access_kept();
CREATE TRIGGER business_access_addons_kept BEFORE UPDATE OR DELETE ON business_access_addons
  FOR EACH ROW EXECUTE FUNCTION business_access_kept();

-- --- The company's tax invoices -----------------------------------------------------------------

-- One series per company GSTIN and financial year ('2627' is 2026-27). The
-- sample GSTIN's series has the prefix SAMPLE, so a sample invoice never takes
-- a number from the real series, which starts at 1 when the real GSTIN is
-- saved. A number is taken by UPDATE ... next_number = next_number + 1 in the
-- transaction that issues the invoice.
CREATE TABLE platform_invoice_series (
  gstin CHAR(15) NOT NULL,
  fiscal_year CHAR(4) NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}$'),
  -- SAMPLE for the sample GSTIN's series and for no other; a real series takes
  -- the settings' invoice prefix (at most 5 characters).
  prefix VARCHAR(6) NOT NULL CHECK ((prefix = 'SAMPLE') = (gstin = '22AAAAA0000A1ZC')
                                    AND (prefix = 'SAMPLE' OR prefix ~ '^[A-Z][A-Z0-9-]{0,3}[A-Z-]$')),
  next_number BIGINT NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gstin, fiscal_year)
);
CREATE FUNCTION platform_invoice_series_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_number < OLD.next_number THEN
    RAISE EXCEPTION 'An invoice series cannot go back to numbers already used' USING ERRCODE = '23514';
  END IF;
  IF NEW.prefix <> OLD.prefix AND OLD.next_number > 1 THEN
    RAISE EXCEPTION 'The prefix of a year''s invoices is fixed once one has been issued' USING ERRCODE = '23514';
  END IF;
  IF NEW.gstin <> OLD.gstin OR NEW.fiscal_year <> OLD.fiscal_year THEN
    RAISE EXCEPTION 'An invoice series belongs to one GSTIN and one financial year' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_invoice_series_forward_only BEFORE UPDATE ON platform_invoice_series
  FOR EACH ROW EXECUTE FUNCTION platform_invoice_series_forward_only();

-- A tax invoice for a confirmed payment, with the supplier, the buyer, the
-- place of supply and the lines (each with its SAC) as issued. sample: issued
-- under the sample GSTIN, printed "SAMPLE — NOT A TAX INVOICE" and kept out of
-- the GST register. An order has at most one sample and one real invoice: the
-- real one may come later, once the real GSTIN is saved. A number is unique
-- for its supplier GSTIN (a GSTIN corrected during the year starts its own
-- series). Its total is the order's: where the supplier's state splits the tax
-- otherwise than the order did, SGST takes what is left after CGST, so the two
-- may differ by a paisa. Never changed.
CREATE TABLE platform_invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number VARCHAR(16) NOT NULL,
  supplier_gstin CHAR(15) NOT NULL,
  fiscal_year CHAR(4) NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}$'),
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  order_id BIGINT NOT NULL,
  payment_id BIGINT NOT NULL REFERENCES platform_payments(id),
  issued_on DATE NOT NULL,
  paid_on DATE NOT NULL,
  supplier JSONB NOT NULL CHECK (jsonb_typeof(supplier) = 'object'),
  buyer JSONB NOT NULL CHECK (jsonb_typeof(buyer) = 'object'),
  place_of_supply JSONB NOT NULL CHECK (jsonb_typeof(place_of_supply) = 'object'),
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  taxable_amount NUMERIC(12,2) NOT NULL CHECK (taxable_amount >= 0),
  cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  total_amount NUMERIC(12,2) NOT NULL,
  sample BOOLEAN NOT NULL,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES platform_orders(business_id, id),
  CHECK (total_amount = taxable_amount + cgst_amount + sgst_amount + igst_amount),
  CHECK ((igst_amount = 0 OR (cgst_amount = 0 AND sgst_amount = 0)) AND abs(cgst_amount - sgst_amount) <= 0.01)
);
CREATE UNIQUE INDEX platform_invoices_number ON platform_invoices(supplier_gstin, upper(number));
CREATE UNIQUE INDEX platform_invoices_one_real ON platform_invoices(order_id) WHERE NOT sample;
CREATE UNIQUE INDEX platform_invoices_one_sample ON platform_invoices(order_id) WHERE sample;
CREATE INDEX platform_invoices_issued ON platform_invoices(issued_on, id);
CREATE INDEX platform_invoices_business ON platform_invoices(business_id, issued_on DESC);

-- --- Leads --------------------------------------------------------------------------------------

-- Someone who showed interest: a call-back enquiry from the home page, or a
-- sign-up. An enquiry is linked to the business its person later signs up.
CREATE TABLE platform_leads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('enquiry', 'signup')),
  name VARCHAR(150) NOT NULL CHECK (length(btrim(name)) > 0),
  mobile VARCHAR(20),
  email VARCHAR(150),
  business_name VARCHAR(150),
  business_type TEXT REFERENCES business_types(code),
  city VARCHAR(100),
  state_code CHAR(2) CHECK (state_code ~ '^[0-9]{2}$'),
  message VARCHAR(1000),
  -- The ref or utm_source of the link the person came from.
  ref VARCHAR(100),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'not_interested')),
  business_id BIGINT UNIQUE REFERENCES businesses(id),
  signed_up_at TIMESTAMPTZ,
  consent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  CHECK (mobile IS NOT NULL OR email IS NOT NULL),
  CHECK ((business_id IS NULL) = (signed_up_at IS NULL))
);
CREATE INDEX platform_leads_mobile ON platform_leads(mobile);
CREATE INDEX platform_leads_email ON platform_leads(lower(email));
CREATE INDEX platform_leads_created ON platform_leads(created_at DESC);

CREATE TABLE platform_lead_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id BIGINT NOT NULL REFERENCES platform_leads(id),
  note VARCHAR(2000) NOT NULL CHECK (length(btrim(note)) > 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX platform_lead_notes_lead ON platform_lead_notes(lead_id, created_at);

-- The super admin's changes to settings, prices and leads.
CREATE TABLE platform_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL CHECK (action ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  entity_type TEXT NOT NULL CHECK (entity_type ~ '^[a-z][a-z_]*$'),
  entity_id BIGINT,
  details JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_time ON platform_audit(created_at DESC);

-- Order lines, invoices and notes on leads are never changed or deleted.
CREATE FUNCTION platform_record_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', CASE TG_TABLE_NAME
    WHEN 'platform_order_lines' THEN 'An order''s lines are never changed: cancel the order and make another'
    WHEN 'platform_invoices' THEN 'A tax invoice is never changed or deleted'
    ELSE 'A note on a lead is never changed or deleted: add another' END USING ERRCODE = '23514';
END $$;
CREATE TRIGGER platform_order_lines_kept BEFORE UPDATE OR DELETE ON platform_order_lines
  FOR EACH ROW EXECUTE FUNCTION platform_record_kept();
CREATE TRIGGER platform_invoices_kept BEFORE UPDATE OR DELETE ON platform_invoices
  FOR EACH ROW EXECUTE FUNCTION platform_record_kept();
CREATE TRIGGER platform_lead_notes_kept BEFORE UPDATE OR DELETE ON platform_lead_notes
  FOR EACH ROW EXECUTE FUNCTION platform_record_kept();

-- --- A business's clock, state and what it may use ---------------------------------------------

-- The time zone a business keeps its dates in: a restaurant's own (the one its
-- screens and business day use), any other business's.
CREATE FUNCTION business_time_zone(p_business BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s.timezone FROM restaurant_settings s WHERE s.restaurant_id = b.legacy_restaurant_id), b.timezone, 'Asia/Kolkata')
  FROM businesses b WHERE b.id = p_business;
$$;

-- "Today" on the business's own clock.
CREATE FUNCTION business_local_today(p_business BIGINT) RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE business_time_zone(p_business))::date;
$$;

-- A business's state today, the first of these that holds:
--   off        the business (or its restaurant) is switched off
--   unmanaged  it has no subscription row (made outside the app): nothing is enforced
--   trial, paid, given   a period of that kind covers today (given time with no end always does)
--   grace      the period that ended last is paid or given time, and today is within the grace days after it
--   checking   a payment entered within the last two days waits to be checked, on an open order with no payment rejected
--   ended      read-only
-- The governing period is the one covering today, else the latest one that has
-- ended; a business whose first period has not started yet by its own date
-- (its time zone was moved back after it was made) is already in it.
-- access_ends_on: the last day of its uncancelled periods, NULL when given time
-- has no end. grace_ends_on: the last day of grace after the period that ends
-- last, when that is paid or given time with an end.
CREATE FUNCTION business_plan_state(p_business BIGINT)
RETURNS TABLE (state TEXT, access_ends_on DATE, trial_ends_on DATE, grace_ends_on DATE, checking_until DATE,
               period_id BIGINT, period_kind TEXT, everything BOOLEAN)
LANGUAGE sql STABLE AS $$
  WITH biz AS (
    SELECT b.id, business_time_zone(b.id) AS zone, business_local_today(b.id) AS today,
           b.status = 'active' AND COALESCE((SELECT r.status FROM restaurants r WHERE r.id = b.legacy_restaurant_id), 'active') = 'active' AS active,
           EXISTS (SELECT 1 FROM business_subscriptions s WHERE s.business_id = b.id) AS managed,
           COALESCE((SELECT grace_days FROM platform_settings WHERE id = 1), 0) AS grace_days
    FROM businesses b WHERE b.id = p_business
  ), periods AS (
    SELECT p.id, p.kind, p.starts_on, p.ends_on, p.everything
    FROM business_access_periods p WHERE p.business_id = p_business AND p.cancelled_at IS NULL
  ), governing AS (
    -- Periods never overlap, so the latest started one covers today or is the latest ended.
    SELECT p.*, (p.starts_on > biz.today OR p.ends_on IS NULL OR p.ends_on >= biz.today) AS covers
    FROM periods p, biz
    ORDER BY p.starts_on <= biz.today DESC, CASE WHEN p.starts_on <= biz.today THEN p.starts_on END DESC NULLS LAST, p.starts_on
    LIMIT 1
  ), ends AS (
    SELECT CASE WHEN bool_or(p.ends_on IS NULL) THEN NULL ELSE max(p.ends_on) END AS access_ends_on,
           max(p.ends_on) FILTER (WHERE p.kind = 'trial') AS trial_ends_on
    FROM periods p
  ), last AS (
    SELECT p.kind, p.ends_on FROM periods p ORDER BY p.ends_on DESC NULLS FIRST LIMIT 1
  ), checking AS (
    SELECT max(pay.submitted_at) + interval '2 days' AS until_at
    FROM platform_payments pay JOIN platform_orders o ON o.id = pay.order_id AND o.status = 'open'
    WHERE pay.business_id = p_business AND pay.status = 'pending' AND pay.submitted_at > now() - interval '2 days'
      AND NOT EXISTS (SELECT 1 FROM platform_payments x WHERE x.order_id = o.id AND x.status = 'rejected')
  )
  SELECT CASE
           WHEN NOT biz.active THEN 'off'
           WHEN NOT biz.managed THEN 'unmanaged'
           WHEN g.covers THEN g.kind
           WHEN g.kind IN ('paid', 'given') AND biz.today <= g.ends_on + biz.grace_days THEN 'grace'
           WHEN c.until_at IS NOT NULL THEN 'checking'
           ELSE 'ended' END,
         e.access_ends_on, e.trial_ends_on,
         CASE WHEN l.kind IN ('paid', 'given') AND l.ends_on IS NOT NULL THEN l.ends_on + biz.grace_days END,
         (c.until_at AT TIME ZONE biz.zone)::date,
         g.id, g.kind, g.everything
  FROM biz CROSS JOIN ends e CROSS JOIN checking c
  LEFT JOIN governing g ON TRUE
  LEFT JOIN last l ON TRUE
$$;

-- The optional modules a business may use today: every module its type can
-- use while it is unmanaged or its governing period unlocks everything (every
-- trial), else the modules copied onto that period; while a payment is being
-- checked, also what its open order holds (a business made with no trial has
-- no period before it); plus the add-on grants covering today; plus, for a
-- restaurant, the restaurant module itself.
CREATE FUNCTION business_entitled_modules(p_business BIGINT) RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  WITH b AS (
    SELECT b.id, b.business_type, business_local_today(b.id) AS today FROM businesses b WHERE b.id = p_business
  ), s AS (
    SELECT * FROM business_plan_state(p_business)
  )
  SELECT COALESCE(array_agg(m.code ORDER BY m.code), '{}') FROM (
    SELECT t.module_code AS code FROM b JOIN s ON s.state = 'unmanaged' OR s.everything
      JOIN platform_module_business_types t ON t.business_type = b.business_type
    UNION
    SELECT unnest(p.modules) FROM s JOIN business_access_periods p ON p.id = s.period_id
    UNION
    SELECT unnest(o.modules) FROM s JOIN platform_orders o ON o.business_id = p_business AND o.status = 'open'
      WHERE s.state = 'checking'
    UNION
    SELECT a.module_code FROM b JOIN business_access_addons a ON a.business_id = b.id
      AND a.cancelled_at IS NULL AND a.starts_on <= b.today AND a.ends_on >= b.today
    UNION
    SELECT 'restaurant' FROM b WHERE b.business_type = 'restaurant'
  ) m
$$;

-- What every module check reads: the modules switched on (the owner's
-- switches, business_capabilities, never deleted when the plan shrinks) that
-- are also unlocked today.
CREATE FUNCTION business_active_capabilities(p_business BIGINT) RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(c.capability ORDER BY c.capability), '{}')
  FROM business_capabilities c JOIN unnest(business_entitled_modules(p_business)) AS e(code) ON e.code = c.capability
  WHERE c.business_id = p_business
$$;

-- Every business with its state, for lists and dashboards.
CREATE VIEW platform_business_plan_states AS
SELECT b.id AS business_id, s.state, s.access_ends_on, s.trial_ends_on, s.grace_ends_on, s.checking_until, s.period_kind, s.everything
FROM businesses b CROSS JOIN LATERAL business_plan_state(b.id) s;

-- The restaurant features switched on for a restaurant and in its plan: the
-- one place every check reads (the signed-in profile, the public QR / booking
-- / online pages, the notification bell). A restaurant not yet linked to a
-- business has its type's defaults.
CREATE OR REPLACE FUNCTION restaurant_features(p_restaurant BIGINT) RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_restaurant IS NULL THEN '{}'::text[]
    WHEN b.id IS NULL THEN COALESCE((SELECT array_agg(t.module_code ORDER BY t.module_code)
      FROM platform_module_business_types t
      WHERE t.business_type = 'restaurant' AND t.enabled_by_default AND t.module_code <> 'restaurant'), '{}')
    ELSE COALESCE((SELECT array_agg(c.code ORDER BY c.code)
      FROM unnest(business_active_capabilities(b.id)) AS c(code)
      JOIN platform_module_business_types t ON t.module_code = c.code AND t.business_type = 'restaurant'
      WHERE c.code <> 'restaurant'), '{}')
  END
  FROM (SELECT (SELECT id FROM businesses WHERE legacy_restaurant_id = p_restaurant) AS id) b
$$;

-- A restaurant switched off or on in the platform console takes its business
-- with it, so the two never disagree about whether it is off (a restaurant
-- linked while it was off had its business made off too).
CREATE FUNCTION restaurants_business_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE businesses SET status = CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'inactive' END, updated_at = now()
  WHERE legacy_restaurant_id = NEW.id AND status <> CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'inactive' END;
  RETURN NULL;
END $$;
CREATE TRIGGER restaurants_business_status AFTER UPDATE OF status ON restaurants
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION restaurants_business_status();

-- --- Businesses that exist today ----------------------------------------------------------------

-- Every restaurant appears as its business.
SELECT restaurant_business_id(r.id) FROM restaurants r
WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.legacy_restaurant_id = r.id)
ORDER BY r.id;

-- Every restaurant has the captain app on today, as it had the captain screens.
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, 'captain_app' FROM businesses b
WHERE b.business_type = 'restaurant'
  AND EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = 'restaurant')
ON CONFLICT DO NOTHING;

-- Every business: its type's default plan for its next order, and given time
-- with no end that unlocks everything, so nothing changes for it.
INSERT INTO business_subscriptions (business_id, plan_code)
SELECT b.id, (SELECT p.code FROM platform_plans p WHERE p.business_type = b.business_type AND p.is_default) FROM businesses b;
INSERT INTO business_access_periods (business_id, kind, starts_on, everything, reason)
SELECT b.id, 'given', business_local_today(b.id), TRUE, 'Set up before paid plans began' FROM businesses b;

-- --- Every new business: its plan and its trial -------------------------------------------------

-- However a business is made (an owner, the platform, a restaurant linked to
-- its business), it starts with its type's default plan for its next order,
-- and a trial of the current trial days from its own today that unlocks
-- everything (none when the trial days are 0: it pays first). Named to run
-- after the triggers that give it its roles, settings and modules.
CREATE FUNCTION businesses_start_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  days SMALLINT := (SELECT trial_days FROM platform_settings WHERE id = 1);
  today DATE;
BEGIN
  INSERT INTO business_subscriptions (business_id, plan_code, created_by, updated_by)
  VALUES (NEW.id, (SELECT code FROM platform_plans WHERE business_type = NEW.business_type AND is_default), NEW.created_by, NEW.created_by);
  IF COALESCE(days, 0) > 0 THEN
    today := business_local_today(NEW.id);
    INSERT INTO business_access_periods (business_id, kind, starts_on, ends_on, everything, created_by)
    VALUES (NEW.id, 'trial', today, today + days - 1, TRUE, NEW.created_by);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER businesses_start_plan AFTER INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_start_plan();

-- Down Migration
DROP TRIGGER businesses_start_plan ON businesses;
DROP FUNCTION businesses_start_plan();
DROP TRIGGER restaurants_business_status ON restaurants;
DROP FUNCTION restaurants_business_status();

-- The restaurant features switched on for a restaurant: the one place every
-- check reads (the signed-in profile, the public QR / booking / online pages,
-- the notification bell). A restaurant not yet linked to a business has its
-- type's defaults.
CREATE OR REPLACE FUNCTION restaurant_features(p_restaurant BIGINT) RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_restaurant IS NULL THEN '{}'::text[]
    WHEN b.id IS NULL THEN COALESCE((SELECT array_agg(t.module_code ORDER BY t.module_code)
      FROM platform_module_business_types t
      WHERE t.business_type = 'restaurant' AND t.enabled_by_default AND t.module_code <> 'restaurant'), '{}')
    ELSE COALESCE((SELECT array_agg(c.capability ORDER BY c.capability)
      FROM business_capabilities c
      JOIN platform_module_business_types t ON t.module_code = c.capability AND t.business_type = 'restaurant'
      WHERE c.business_id = b.id AND c.capability <> 'restaurant'), '{}')
  END
  FROM (SELECT (SELECT id FROM businesses WHERE legacy_restaurant_id = p_restaurant) AS id) b
$$;

DROP VIEW platform_business_plan_states;
DROP FUNCTION business_active_capabilities(BIGINT);
DROP FUNCTION business_entitled_modules(BIGINT);
DROP FUNCTION business_plan_state(BIGINT);
DROP FUNCTION business_local_today(BIGINT);
DROP FUNCTION business_time_zone(BIGINT);

DROP TABLE platform_audit;
DROP TABLE platform_lead_notes;
DROP TABLE platform_leads;
DROP TABLE platform_invoices;
DROP TABLE platform_invoice_series;
DROP TABLE business_access_addons;
DROP TABLE business_access_periods;
DROP TABLE platform_payments;
DROP TABLE platform_order_lines;
DROP TABLE platform_orders;
DROP TABLE business_subscription_addons;
DROP TABLE business_subscriptions;
DROP TABLE platform_module_prices;
DROP TABLE platform_plan_modules;
DROP TABLE platform_plans;
DROP TABLE platform_settings;
DROP FUNCTION platform_record_kept();
DROP FUNCTION platform_invoice_series_forward_only();
DROP FUNCTION business_access_kept();
DROP FUNCTION business_access_addons_check();
DROP FUNCTION business_access_periods_check();
DROP FUNCTION platform_payments_one_way();
DROP FUNCTION platform_orders_one_way();
DROP FUNCTION business_subscription_addons_check();
DROP FUNCTION business_subscriptions_check();
DROP FUNCTION platform_module_prices_check();
DROP FUNCTION platform_plan_modules_check();
DROP FUNCTION platform_module_sellable(TEXT, TEXT);
DROP FUNCTION platform_plans_type_fixed();

-- The captain app: restaurants linked to their business above stay linked.
DELETE FROM business_capabilities WHERE capability = 'captain_app';
DELETE FROM platform_module_dependencies WHERE module_code = 'captain_app';
DELETE FROM platform_module_business_types WHERE module_code = 'captain_app';
DELETE FROM platform_modules WHERE code = 'captain_app';
