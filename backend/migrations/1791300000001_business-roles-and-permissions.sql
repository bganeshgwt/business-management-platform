-- Up Migration
-- Identity & access layer: per-business roles and permissions.
--
-- One login per person (users) and one membership per person per business
-- (business_memberships) stay exactly as they are. What changes is what a
-- membership means: instead of a fixed owner / manager / viewer word checked
-- in code, a membership points at a role of THAT business, and the role holds
-- a list of permissions from a platform-wide catalogue.
--
-- Two checks stay separate and are both made on the server:
--   capability  (business_capabilities)  — what the business may use;
--   permission  (business_role_permissions) — what this person may do in it.

-- The permission catalogue: one row per module and action. The eight actions
-- are the ones the requirements name; a module only lists the actions that
-- mean something for it.
CREATE TABLE business_permissions (
  code TEXT PRIMARY KEY,
  module_code TEXT NOT NULL REFERENCES platform_modules(code),
  action TEXT NOT NULL CHECK (action IN ('view', 'create', 'edit', 'approve', 'cancel', 'refund', 'export', 'print')),
  name VARCHAR(120) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 100,
  UNIQUE (module_code, action),
  CHECK (code = module_code || '.' || action)
);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('catalog', 'view', 'See products, services, categories and units', 10),
 ('catalog', 'create', 'Add products, services, categories and units', 11),
 ('catalog', 'edit', 'Change prices, tax, categories, units and pack sizes', 12),
 ('catalog', 'export', 'Export the product list', 13),
 ('catalog', 'print', 'Print price labels and product lists', 14),
 ('contacts', 'view', 'See customers and suppliers', 20),
 ('contacts', 'create', 'Add customers and suppliers', 21),
 ('contacts', 'edit', 'Change customer and supplier details and credit terms', 22),
 ('contacts', 'export', 'Export customers and suppliers', 23),
 ('sales', 'view', 'See sales and their payments', 30),
 ('sales', 'create', 'Record a new sale', 31),
 ('sales', 'edit', 'Record collections against a sale', 32),
 ('sales', 'refund', 'Take back sold goods and refund customers', 33),
 ('sales', 'export', 'Export sales', 34),
 ('sales', 'print', 'Print sale invoices', 35),
 ('purchasing', 'view', 'See purchases and supplier payments', 40),
 ('purchasing', 'create', 'Receive a purchase into stock', 41),
 ('purchasing', 'edit', 'Record payments to suppliers', 42),
 ('purchasing', 'refund', 'Return goods to suppliers and record supplier refunds', 43),
 ('purchasing', 'export', 'Export purchases', 44),
 ('purchasing', 'print', 'Print purchase documents', 45),
 ('inventory', 'view', 'See stock and stock movements', 50),
 ('inventory', 'edit', 'Correct stock with a reason', 51),
 ('inventory', 'export', 'Export stock', 52),
 ('stock_counts', 'view', 'See stock counts', 60),
 ('stock_counts', 'create', 'Start a count and enter counted quantities', 61),
 ('stock_counts', 'approve', 'Approve a count and post its corrections', 62),
 ('stock_counts', 'cancel', 'Cancel an open count', 63),
 ('stock_transfers', 'view', 'See stock transfers', 70),
 ('stock_transfers', 'create', 'Send stock to another location', 71),
 ('stock_transfers', 'approve', 'Confirm a transfer has arrived', 72),
 ('stock_transfers', 'cancel', 'Cancel a transfer still in transit', 73),
 ('wholesale', 'view', 'See wholesale price lists', 80),
 ('wholesale', 'edit', 'Add and switch off wholesale prices', 81),
 ('appointments', 'view', 'See appointments, staff and rooms', 90),
 ('appointments', 'create', 'Book appointments and add staff or rooms', 91),
 ('appointments', 'edit', 'Mark appointments completed or no-show', 92),
 ('appointments', 'cancel', 'Cancel appointments', 93),
 ('settings', 'view', 'See business settings, tax rates, number series and locations', 100),
 ('settings', 'edit', 'Change business settings, tax rates, number series, locations and modules', 101),
 ('access', 'view', 'See who has access and the roles', 110),
 ('access', 'edit', 'Give or remove access and change roles', 111),
 ('reports', 'view', 'See reports', 120),
 ('reports', 'export', 'Export reports', 121),
 ('audit', 'view', 'See the activity log', 130),
 ('audit', 'export', 'Export the activity log', 131)
) AS p(module_code, action, name, sort_order);

-- Role templates, defined once by the platform. Every business receives its
-- own copy of each template (business_roles below), so one business changing
-- its "Manager" never changes another's.
CREATE TABLE business_role_templates (
  code TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{1,39}$'),
  name VARCHAR(80) NOT NULL,
  description VARCHAR(300) NOT NULL,
  full_access BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order SMALLINT NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX business_role_templates_one_full ON business_role_templates(full_access) WHERE full_access;

CREATE TABLE business_role_template_permissions (
  template_code TEXT NOT NULL REFERENCES business_role_templates(code),
  permission_code TEXT NOT NULL REFERENCES business_permissions(code),
  PRIMARY KEY (template_code, permission_code)
);

INSERT INTO business_role_templates (code, name, description, full_access, sort_order) VALUES
 ('owner', 'Owner', 'Everything, including who has access. Given to the person who set up the business.', TRUE, 10),
 ('manager', 'Manager', 'Runs the business day to day: every record and transaction, but not staff access.', FALSE, 20),
 ('cashier', 'Cashier / sales', 'Records sales and collections, books appointments, looks up products and stock.', FALSE, 30),
 ('stock_keeper', 'Stock keeper', 'Products, receiving, stock corrections, counts and transfers.', FALSE, 40),
 ('accountant', 'Accountant', 'Reads everything, records payments, exports and prints; changes no stock.', FALSE, 50),
 ('viewer', 'Viewer', 'Reads and exports; changes nothing.', FALSE, 60);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code <> 'access'
UNION ALL SELECT 'cashier', unnest(ARRAY['catalog.view', 'contacts.view', 'contacts.create', 'sales.view', 'sales.create',
  'sales.edit', 'sales.print', 'inventory.view', 'wholesale.view', 'appointments.view', 'appointments.create', 'appointments.edit'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['catalog.view', 'catalog.create', 'catalog.edit', 'catalog.print', 'contacts.view',
  'inventory.view', 'inventory.edit', 'inventory.export', 'stock_counts.view', 'stock_counts.create', 'stock_transfers.view',
  'stock_transfers.create', 'stock_transfers.approve', 'purchasing.view', 'purchasing.create', 'purchasing.print'])
UNION ALL SELECT 'accountant', code FROM business_permissions
  WHERE module_code <> 'access' AND (action IN ('view', 'export', 'print') OR code IN ('sales.edit', 'purchasing.edit'))
UNION ALL SELECT 'viewer', code FROM business_permissions WHERE module_code <> 'access' AND action IN ('view', 'export');

-- A business's own roles. Copies of the templates carry template_code; roles
-- the business makes itself have none. The composite key (business_id, id)
-- is what memberships and permissions point at, so a membership can never
-- hold another business's role.
CREATE TABLE business_roles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  template_code TEXT REFERENCES business_role_templates(code),
  name VARCHAR(80) NOT NULL,
  description VARCHAR(300),
  -- The Owner role: every permission, present and future. Exactly one per
  -- business; it cannot be edited or given out through the admin screens.
  full_access BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, template_code),
  CHECK (NOT full_access OR (template_code = 'owner' AND active))
);
CREATE UNIQUE INDEX business_roles_name ON business_roles(business_id, lower(name));
CREATE UNIQUE INDEX business_roles_one_full ON business_roles(business_id) WHERE full_access;

CREATE TABLE business_role_permissions (
  business_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  permission_code TEXT NOT NULL REFERENCES business_permissions(code),
  PRIMARY KEY (role_id, permission_code),
  FOREIGN KEY (business_id, role_id) REFERENCES business_roles(business_id, id) ON DELETE CASCADE
);
CREATE INDEX business_role_permissions_business ON business_role_permissions(business_id, role_id);

-- Full-access roles hold no rows: "everything" must include permissions
-- added by later migrations without anyone remembering to grant them.
CREATE FUNCTION business_role_permissions_not_full() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM business_roles WHERE id = NEW.role_id AND full_access) THEN
    RAISE EXCEPTION 'The Owner role already has every permission' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_role_permissions_not_full BEFORE INSERT OR UPDATE ON business_role_permissions
  FOR EACH ROW EXECUTE FUNCTION business_role_permissions_not_full();

-- Gives a business its copy of every template that it does not have yet.
-- Used for the existing businesses here and, through the provisioning
-- trigger added later in this set, for every new business.
CREATE FUNCTION business_seed_roles(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_roles (business_id, template_code, name, description, full_access)
  SELECT target, t.code, t.name, t.description, t.full_access FROM business_role_templates t
  ON CONFLICT (business_id, template_code) DO NOTHING;
  INSERT INTO business_role_permissions (business_id, role_id, permission_code)
  SELECT r.business_id, r.id, tp.permission_code
  FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
  WHERE r.business_id = target AND NOT r.full_access
    AND NOT EXISTS (SELECT 1 FROM business_role_permissions x WHERE x.role_id = r.id)
  ON CONFLICT DO NOTHING;
$$;
SELECT business_seed_roles(id) FROM businesses;

-- Memberships move from the word to the role. owner -> Owner, manager ->
-- Manager, viewer -> Viewer: the templates were written so that nobody gains
-- or loses anything they could do before (see docs/BUSINESS_PLATFORM_DATA_MODEL.md).
ALTER TABLE business_memberships
  ADD COLUMN role_id BIGINT,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN created_by BIGINT REFERENCES users(id),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_by BIGINT REFERENCES users(id),
  -- The business this person last opened; the switcher returns them there.
  ADD COLUMN last_opened_at TIMESTAMPTZ;
UPDATE business_memberships m SET role_id = r.id
FROM business_roles r WHERE r.business_id = m.business_id AND r.template_code = m.role;
ALTER TABLE business_memberships
  ALTER COLUMN role_id SET NOT NULL,
  ADD CONSTRAINT business_memberships_role_fkey FOREIGN KEY (business_id, role_id) REFERENCES business_roles(business_id, id),
  DROP COLUMN role;
CREATE INDEX business_memberships_role ON business_memberships(business_id, role_id);
CREATE INDEX business_memberships_recent ON business_memberships(user_id, last_opened_at DESC NULLS LAST) WHERE active;

-- Down Migration
-- Maps roles back to the three words: Owner -> owner, Viewer -> viewer, every
-- other role -> manager (the nearest of the three that can still post).
ALTER TABLE business_memberships ADD COLUMN role TEXT;
UPDATE business_memberships m SET role = CASE WHEN r.full_access THEN 'owner' WHEN r.template_code = 'viewer' THEN 'viewer' ELSE 'manager' END
FROM business_roles r WHERE r.business_id = m.business_id AND r.id = m.role_id;
ALTER TABLE business_memberships ALTER COLUMN role SET NOT NULL,
  ADD CONSTRAINT business_memberships_role_check CHECK (role IN ('owner', 'manager', 'viewer'));
DROP INDEX business_memberships_recent;
DROP INDEX business_memberships_role;
ALTER TABLE business_memberships DROP CONSTRAINT business_memberships_role_fkey,
  DROP COLUMN role_id, DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at,
  DROP COLUMN updated_by, DROP COLUMN last_opened_at;
DROP FUNCTION business_seed_roles(BIGINT);
DROP TRIGGER business_role_permissions_not_full ON business_role_permissions;
DROP FUNCTION business_role_permissions_not_full();
DROP TABLE business_role_permissions, business_roles, business_role_template_permissions,
  business_role_templates, business_permissions;
