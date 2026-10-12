-- Up Migration
-- Phase 2, job T4 (part 1): salon & spa.
--
-- Everything hangs off the shared core through composite (business_id, …)
-- foreign keys: services are catalogue SKUs of kind 'service', stylists and
-- rooms are business_resources, bookings are business_appointments, bills are
-- ordinary sale documents (business_documents), deposits are shared
-- receivables collections (business_collections, kept as the client's
-- advance). Salon tables add only what a salon needs:
--
--   salon_settings            booking rules: deposit %, free-cancellation window,
--                             late-cancel and no-show fees, calendar hours
--   salon_services            duration, clean-up time and "needs a room" per service
--   salon_resource_profiles   whether a resource is a stylist (staff) or a room
--   salon_staff_skills        which services a stylist does
--   salon_appointment_details room, deposit, fee bill and final bill of a booking
--   salon_plans (+ _services) packages (sessions of services, validity) and
--                             memberships (discount %, validity) for sale
--   salon_client_plans (+ _services)  a package or membership a client bought
--   salon_package_redemptions sessions used on a bill (append-only)
--   salon_membership_uses     membership discounts given on a bill (append-only)
--   salon_commission_rules    staff commission % (per stylist / service / product)
--   salon_line_staff          who did each bill line and the commission earned
--
-- Discounts from a membership or a package are written to the shared
-- retail_sale_discounts snapshot (new sources 'membership' and 'package'),
-- so every sale screen and the "line price - discounts = taxable value" rule
-- keep working unchanged.

-- --- Modules and permissions ----------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('packages', 'Packages & memberships', 'Service packages with sessions and validity, and memberships with a discount, sold on a bill and used on later bills.', 'optional', 235),
 ('commissions', 'Staff commissions', 'Commission rules per stylist, service or product, and the commission each person earned.', 'optional', 236);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('packages', 'sales'), ('packages', 'contacts'),
 ('commissions', 'sales'), ('commissions', 'appointments');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('packages', 'salon', TRUE), ('commissions', 'salon', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('packages', 'view', 'See packages, memberships and what clients hold', 94),
 ('packages', 'create', 'Add package and membership plans', 95),
 ('packages', 'edit', 'Change plans and cancel a client''s unused package or membership', 96),
 ('packages', 'export', 'Export packages and memberships', 97),
 ('commissions', 'view', 'See staff commissions', 98),
 ('commissions', 'edit', 'Set commission rules', 99),
 ('commissions', 'export', 'Export staff commissions', 100)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code IN ('packages', 'commissions')
UNION ALL SELECT 'cashier', unnest(ARRAY['packages.view'])
UNION ALL SELECT 'accountant', code FROM business_permissions WHERE module_code IN ('packages', 'commissions') AND action IN ('view', 'export')
UNION ALL SELECT 'viewer', code FROM business_permissions WHERE module_code IN ('packages', 'commissions') AND action IN ('view', 'export');

INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code IN ('packages', 'commissions')
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code IN ('packages', 'commissions')
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Membership and package discounts share the per-line discount snapshot.
-- Any later change to this CHECK must keep the whole list.
ALTER TABLE retail_sale_discounts DROP CONSTRAINT retail_sale_discounts_source_check,
  ADD CONSTRAINT retail_sale_discounts_source_check CHECK (source IN ('offer', 'points', 'membership', 'package'));

-- Rows recording what was used or earned are never edited or deleted (only
-- created_at may be corrected, for demo set-up, as with the retail rows).
CREATE FUNCTION salon_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Posted % rows cannot be changed', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A catalogue item used where only a service makes sense.
CREATE FUNCTION salon_sku_is_service() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
                 WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id AND p.kind = 'service') THEN
    RAISE EXCEPTION 'Choose a service of this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- Booking rules, services, stylists and rooms ------------------------------------

CREATE TABLE salon_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- Suggested deposit when booking, as a % of the service price (0 = none).
  deposit_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (deposit_percent BETWEEN 0 AND 100),
  -- Cancelling at least this many hours before the start is free.
  free_cancel_hours SMALLINT NOT NULL DEFAULT 4 CHECK (free_cancel_hours BETWEEN 0 AND 168),
  -- Fees as a % of the booked service price, kept out of the deposit only.
  late_cancel_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (late_cancel_fee_percent BETWEEN 0 AND 100),
  no_show_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (no_show_fee_percent BETWEEN 0 AND 100),
  -- The calendar's day.
  opens_at TIME NOT NULL DEFAULT '09:00',
  closes_at TIME NOT NULL DEFAULT '21:00',
  -- The service item fee bills are raised on (created on first use).
  fee_sku_id BIGINT,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, fee_sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (closes_at > opens_at)
);

CREATE TABLE salon_services (
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  duration_minutes SMALLINT NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
  -- Clean-up / set-up after the service; the stylist is busy for both.
  buffer_minutes SMALLINT NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 120),
  needs_room BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE TRIGGER salon_services_service BEFORE INSERT OR UPDATE OF sku_id ON salon_services
  FOR EACH ROW EXECUTE FUNCTION salon_sku_is_service();

-- A resource without a profile is a stylist (staff).
CREATE TABLE salon_resource_profiles (
  business_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('staff', 'room')),
  PRIMARY KEY (business_id, resource_id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id)
);

CREATE TABLE salon_staff_skills (
  business_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, resource_id, sku_id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE TRIGGER salon_staff_skills_service BEFORE INSERT OR UPDATE OF sku_id ON salon_staff_skills
  FOR EACH ROW EXECUTE FUNCTION salon_sku_is_service();
CREATE FUNCTION salon_skill_is_staff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM salon_resource_profiles WHERE business_id = NEW.business_id AND resource_id = NEW.resource_id AND kind = 'room') THEN
    RAISE EXCEPTION 'A room has no skills; give services to a stylist' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER salon_staff_skills_staff BEFORE INSERT OR UPDATE ON salon_staff_skills
  FOR EACH ROW EXECUTE FUNCTION salon_skill_is_staff();

-- --- Packages and memberships ---------------------------------------------------------

-- A plan is sold through its own service SKU (sku_id), so a package or a
-- membership goes on an ordinary bill, with GST, next to services and products.
CREATE TABLE salon_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('package', 'membership')),
  sku_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  validity_days SMALLINT NOT NULL CHECK (validity_days BETWEEN 1 AND 3650),
  service_discount_percent NUMERIC(5,2) CHECK (service_discount_percent BETWEEN 0 AND 100),
  product_discount_percent NUMERIC(5,2) CHECK (product_discount_percent BETWEEN 0 AND 100),
  description VARCHAR(300),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku_id),
  -- A membership gives a discount; a package gives sessions (salon_plan_services).
  CHECK ((kind = 'membership') = (service_discount_percent IS NOT NULL AND product_discount_percent IS NOT NULL)),
  CHECK (kind <> 'membership' OR service_discount_percent > 0 OR product_discount_percent > 0)
);
CREATE UNIQUE INDEX salon_plans_name ON salon_plans(business_id, lower(name));

CREATE TABLE salon_plan_services (
  business_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  sessions SMALLINT NOT NULL CHECK (sessions BETWEEN 1 AND 100),
  PRIMARY KEY (business_id, plan_id, sku_id),
  FOREIGN KEY (business_id, plan_id) REFERENCES salon_plans(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE TRIGGER salon_plan_services_service BEFORE INSERT OR UPDATE OF sku_id ON salon_plan_services
  FOR EACH ROW EXECUTE FUNCTION salon_sku_is_service();

-- What a client bought: a snapshot of the plan at the time of sale (name,
-- validity, discounts, sessions), so changing a plan never changes it.
CREATE TABLE salon_client_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  plan_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('package', 'membership')),
  name VARCHAR(150) NOT NULL,
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  price NUMERIC(14,2) NOT NULL CHECK (price >= 0),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  service_discount_percent NUMERIC(5,2) CHECK (service_discount_percent BETWEEN 0 AND 100),
  product_discount_percent NUMERIC(5,2) CHECK (product_discount_percent BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  cancel_reason VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, plan_id) REFERENCES salon_plans(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, line_id),
  CHECK (ends_on >= starts_on),
  CHECK ((kind = 'membership') = (service_discount_percent IS NOT NULL AND product_discount_percent IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX salon_client_plans_contact ON salon_client_plans(business_id, contact_id, status);
CREATE TRIGGER salon_client_plans_customer BEFORE INSERT OR UPDATE OF contact_id ON salon_client_plans
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();
-- Only the status (cancellation) may change after the sale.
CREATE FUNCTION salon_client_plans_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER salon_client_plans_fixed BEFORE UPDATE OR DELETE ON salon_client_plans
  FOR EACH ROW EXECUTE FUNCTION salon_client_plans_fixed();

CREATE TABLE salon_client_plan_services (
  business_id BIGINT NOT NULL,
  client_plan_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  sessions SMALLINT NOT NULL CHECK (sessions BETWEEN 1 AND 100),
  PRIMARY KEY (business_id, client_plan_id, sku_id),
  FOREIGN KEY (business_id, client_plan_id) REFERENCES salon_client_plans(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE TRIGGER salon_client_plan_services_fixed BEFORE UPDATE OR DELETE ON salon_client_plan_services
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- A session used: the bill line it paid for (the line's whole price comes
-- off as a 'package' discount).
CREATE TABLE salon_package_redemptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  client_plan_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  quantity SMALLINT NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, client_plan_id, sku_id) REFERENCES salon_client_plan_services(business_id, client_plan_id, sku_id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, line_id)
);
CREATE INDEX salon_package_redemptions_plan ON salon_package_redemptions(business_id, client_plan_id);
CREATE TRIGGER salon_package_redemptions_append_only BEFORE UPDATE OR DELETE ON salon_package_redemptions
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- Sessions used never exceed the sessions bought (a returned bill line gives
-- its sessions back, so it is subtracted).
CREATE FUNCTION salon_sessions_left() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bought INT; used INT;
BEGIN
  SELECT sessions INTO bought FROM salon_client_plan_services
  WHERE business_id = NEW.business_id AND client_plan_id = NEW.client_plan_id AND sku_id = NEW.sku_id;
  SELECT COALESCE(sum(r.quantity - COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl
           WHERE rl.business_id = r.business_id AND rl.line_id = r.line_id), 0)), 0)::int INTO used
  FROM salon_package_redemptions r WHERE r.business_id = NEW.business_id AND r.client_plan_id = NEW.client_plan_id AND r.sku_id = NEW.sku_id;
  IF used > bought THEN
    RAISE EXCEPTION 'This package has no sessions of this service left' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER salon_package_redemptions_left AFTER INSERT ON salon_package_redemptions
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION salon_sessions_left();

CREATE TABLE salon_membership_uses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  client_plan_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  percent NUMERIC(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, client_plan_id) REFERENCES salon_client_plans(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, line_id)
);
CREATE INDEX salon_membership_uses_plan ON salon_membership_uses(business_id, client_plan_id);
CREATE TRIGGER salon_membership_uses_append_only BEFORE UPDATE OR DELETE ON salon_membership_uses
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- The bill line that sold a package or membership can be returned (credit
-- note, refund) only after the client's plan has been cancelled — which is
-- refused once a session or a membership discount has been used.
CREATE FUNCTION salon_plan_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM salon_client_plans WHERE business_id = NEW.business_id AND line_id = NEW.line_id AND status = 'active') THEN
    RAISE EXCEPTION 'This line sold a package or membership. Cancel it under Packages & memberships first, then return the line.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_return_lines_salon_plan BEFORE INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION salon_plan_line_return();

-- --- Appointments: room, deposit, fee and bill ------------------------------------------

CREATE TABLE salon_appointment_details (
  business_id BIGINT NOT NULL,
  appointment_id BIGINT NOT NULL,
  room_id BIGINT,
  -- Snapshot of the service price when booked: fees are worked out from it.
  price_at_booking NUMERIC(14,2) NOT NULL CHECK (price_at_booking >= 0),
  deposit_collection_id BIGINT,
  fee_document_id BIGINT,
  bill_document_id BIGINT,
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, appointment_id),
  FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id),
  FOREIGN KEY (business_id, room_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, deposit_collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, fee_document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, bill_document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX salon_appointment_details_room ON salon_appointment_details(business_id, room_id) WHERE room_id IS NOT NULL;
-- Room, price and deposit are fixed at booking; the fee and bill are set once.
CREATE FUNCTION salon_appointment_details_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER salon_appointment_details_fixed BEFORE UPDATE OR DELETE ON salon_appointment_details
  FOR EACH ROW EXECUTE FUNCTION salon_appointment_details_fixed();

-- --- Staff commissions ----------------------------------------------------------------

-- The most specific active rule wins: this stylist + this item, this stylist +
-- services/products, everyone + this item, everyone + services/products.
CREATE TABLE salon_commission_rules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  resource_id BIGINT,
  applies_to TEXT NOT NULL CHECK (applies_to IN ('service', 'goods')),
  sku_id BIGINT,
  percent NUMERIC(5,2) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX salon_commission_rules_one_active ON salon_commission_rules(business_id, COALESCE(resource_id, 0), applies_to, COALESCE(sku_id, 0)) WHERE active;
CREATE FUNCTION salon_commission_rule_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sku_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
       WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id AND p.kind = NEW.applies_to) THEN
    RAISE EXCEPTION 'The item does not match services / products of this rule' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER salon_commission_rules_item BEFORE INSERT OR UPDATE ON salon_commission_rules
  FOR EACH ROW EXECUTE FUNCTION salon_commission_rule_item();

-- Who did each bill line, and the commission worked out when the bill was
-- posted (a snapshot: changing a rule later never changes it). Returned
-- quantities reduce the commission in the report, in proportion.
CREATE TABLE salon_line_staff (
  business_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  appointment_id BIGINT,
  rule_id BIGINT,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('service', 'goods')),
  commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_percent BETWEEN 0 AND 100),
  commission_base NUMERIC(16,2) NOT NULL CHECK (commission_base >= 0),
  commission_amount NUMERIC(16,2) NOT NULL CHECK (commission_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, line_id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES business_resources(business_id, id),
  FOREIGN KEY (business_id, appointment_id) REFERENCES business_appointments(business_id, id),
  FOREIGN KEY (business_id, rule_id) REFERENCES salon_commission_rules(business_id, id)
);
CREATE INDEX salon_line_staff_resource ON salon_line_staff(business_id, resource_id, created_at);
CREATE TRIGGER salon_line_staff_append_only BEFORE UPDATE OR DELETE ON salon_line_staff
  FOR EACH ROW EXECUTE FUNCTION salon_append_only();

-- Down Migration
DROP TABLE salon_line_staff;
DROP FUNCTION salon_commission_rule_item() CASCADE;
DROP TABLE salon_commission_rules;
DROP TABLE salon_appointment_details;
DROP FUNCTION salon_appointment_details_fixed();
DROP TRIGGER business_return_lines_salon_plan ON business_return_lines;
DROP FUNCTION salon_plan_line_return();
DROP TABLE salon_membership_uses, salon_package_redemptions;
DROP FUNCTION salon_sessions_left();
DROP TABLE salon_client_plan_services, salon_client_plans;
DROP FUNCTION salon_client_plans_fixed();
DROP TABLE salon_plan_services, salon_plans;
DROP TABLE salon_staff_skills, salon_resource_profiles, salon_services, salon_settings;
DROP FUNCTION salon_skill_is_staff();
DROP FUNCTION salon_sku_is_service();
DROP FUNCTION salon_append_only();
DELETE FROM retail_sale_discounts WHERE source IN ('membership', 'package');
ALTER TABLE retail_sale_discounts DROP CONSTRAINT retail_sale_discounts_source_check,
  ADD CONSTRAINT retail_sale_discounts_source_check CHECK (source IN ('offer', 'points'));
DELETE FROM business_capabilities WHERE capability IN ('packages', 'commissions');
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('packages', 'commissions'));
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('packages', 'commissions'));
DELETE FROM business_permissions WHERE module_code IN ('packages', 'commissions');
DELETE FROM platform_module_business_types WHERE module_code IN ('packages', 'commissions');
DELETE FROM platform_module_dependencies WHERE module_code IN ('packages', 'commissions');
DELETE FROM platform_modules WHERE code IN ('packages', 'commissions');
