-- Up Migration
-- Lean starting setups for new businesses; existing capabilities and history stay intact.
UPDATE platform_module_business_types SET enabled_by_default = FALSE
WHERE module_code IN ('tasks','issues','projects','stock_transfers','repairs','finance','packages','commissions','lab','loyalty','offers','processing');

INSERT INTO platform_modules(code,name,description,kind,sort_order) VALUES
 ('expenses','Daily expenses','Record paid business expenses and reverse mistakes with a reason.','optional',135);
INSERT INTO platform_module_business_types(module_code,business_type,enabled_by_default)
SELECT 'expenses',code,TRUE FROM business_types WHERE code <> 'restaurant';
INSERT INTO business_permissions(code,module_code,action,name,sort_order) VALUES
 ('expenses.view','expenses','view','See paid expenses',135),
 ('expenses.create','expenses','create','Record a paid expense',136),
 ('expenses.approve','expenses','approve','Reverse an expense with a reason',137);
INSERT INTO business_role_template_permissions(template_code,permission_code)
SELECT role,permission FROM (VALUES ('manager'),('accountant')) r(role)
CROSS JOIN (VALUES ('expenses.view'),('expenses.create'),('expenses.approve')) p(permission)
UNION ALL SELECT role,'expenses.view' FROM (VALUES ('cashier'),('viewer')) r(role);
INSERT INTO business_role_permissions(business_id,role_id,permission_code)
SELECT r.business_id,r.id,p.permission_code FROM business_roles r
JOIN business_role_template_permissions p ON p.template_code=r.template_code
WHERE p.permission_code LIKE 'expenses.%' ON CONFLICT DO NOTHING;
INSERT INTO business_capabilities(business_id,capability)
SELECT id,'expenses' FROM businesses WHERE business_type <> 'restaurant' ON CONFLICT DO NOTHING;

CREATE TABLE business_expenses (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 location_id BIGINT NOT NULL,
 spent_on DATE NOT NULL,
 category VARCHAR(30) NOT NULL CHECK (category IN ('rent','utilities','wages','transport','supplies','cleaning','maintenance','other')),
 description VARCHAR(200) NOT NULL CHECK (length(trim(description)) > 0),
 amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
 method VARCHAR(10) NOT NULL CHECK (method IN ('cash','upi','card','bank')),
 method_name VARCHAR(60),
 method_id BIGINT,
 reference VARCHAR(100),
 request_key UUID NOT NULL,
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 voided_at TIMESTAMPTZ,
 voided_by BIGINT REFERENCES users(id),
 void_reason VARCHAR(300),
 UNIQUE(business_id,id), UNIQUE(business_id,request_key),
 FOREIGN KEY(business_id,location_id) REFERENCES business_locations(business_id,id),
 FOREIGN KEY(business_id,method_id) REFERENCES business_payment_methods(business_id,id),
 CHECK ((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
     OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(trim(void_reason)) > 0))
);
CREATE INDEX business_expenses_day ON business_expenses(business_id,spent_on,location_id);
CREATE INDEX business_expenses_void ON business_expenses(business_id,voided_at) WHERE voided_at IS NOT NULL;
CREATE FUNCTION guard_business_expense() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recorded expenses cannot be deleted'; END IF;
 IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
   OR (to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason']) THEN
   RAISE EXCEPTION 'Recorded expenses can only be reversed once, with a reason';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_expenses_immutable BEFORE UPDATE OR DELETE ON business_expenses
FOR EACH ROW EXECUTE FUNCTION guard_business_expense();

INSERT INTO business_permissions(code,module_code,action,name,sort_order) VALUES
 ('reports.edit','reports','edit','Record a daily cash check',41);
INSERT INTO business_role_template_permissions(template_code,permission_code)
VALUES ('manager','reports.edit'),('accountant','reports.edit'),('cashier','reports.edit');
INSERT INTO business_role_permissions(business_id,role_id,permission_code)
SELECT r.business_id,r.id,'reports.edit' FROM business_roles r WHERE r.template_code IN ('manager','accountant','cashier') ON CONFLICT DO NOTHING;
CREATE TABLE business_cash_checks (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 location_id BIGINT NOT NULL,
 checked_on DATE NOT NULL,
 opening_cash NUMERIC(14,2) NOT NULL CHECK(opening_cash>=0),
 counted_cash NUMERIC(14,2) NOT NULL CHECK(counted_cash>=0),
 movement_cash NUMERIC(16,2) NOT NULL,
 expected_cash NUMERIC(16,2) NOT NULL,
 difference NUMERIC(16,2) NOT NULL,
 reason VARCHAR(300),
 request_key UUID NOT NULL,
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(business_id,request_key),
 FOREIGN KEY(business_id,location_id) REFERENCES business_locations(business_id,id),
 CHECK(expected_cash=opening_cash+movement_cash AND difference=counted_cash-expected_cash),
 CHECK(difference=0 OR length(trim(reason))>0)
);
CREATE INDEX business_cash_checks_day ON business_cash_checks(business_id,checked_on,location_id,id DESC);
CREATE FUNCTION guard_business_cash_check() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Cash checks are permanent snapshots; record a new check to correct one'; END $$;
CREATE TRIGGER business_cash_checks_immutable BEFORE UPDATE OR DELETE ON business_cash_checks
FOR EACH ROW EXECUTE FUNCTION guard_business_cash_check();

-- Down Migration
DROP TABLE business_cash_checks;
DROP FUNCTION guard_business_cash_check();
DELETE FROM business_role_permissions WHERE permission_code='reports.edit';
DELETE FROM business_role_template_permissions WHERE permission_code='reports.edit';
DELETE FROM business_permissions WHERE code='reports.edit';
DROP TABLE business_expenses;
DROP FUNCTION guard_business_expense();
DELETE FROM business_role_permissions WHERE permission_code LIKE 'expenses.%';
DELETE FROM business_role_template_permissions WHERE permission_code LIKE 'expenses.%';
DELETE FROM business_permissions WHERE module_code='expenses';
DELETE FROM business_capabilities WHERE capability='expenses';
DELETE FROM platform_module_business_types WHERE module_code='expenses';
DELETE FROM platform_modules WHERE code='expenses';
UPDATE platform_module_business_types SET enabled_by_default=TRUE WHERE module_code IN ('tasks','issues','projects');
UPDATE platform_module_business_types SET enabled_by_default=TRUE
WHERE (module_code IN ('repairs','finance') AND business_type='electronics')
 OR (module_code IN ('packages','commissions') AND business_type='salon')
 OR (module_code='lab' AND business_type='healthcare')
 OR (module_code IN ('loyalty','offers') AND business_type='supermarket')
 OR (module_code='offers' AND business_type='fashion')
 OR (module_code='processing' AND business_type IN ('meat','weight_retail'))
 OR (module_code='stock_transfers' AND business_type IN ('supermarket','wholesale','fashion','electronics','pharmacy'));
