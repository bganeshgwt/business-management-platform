-- Up Migration

INSERT INTO permissions (code, module, name) VALUES
  ('platform.restaurants.manage', 'platform',   'Manage all restaurants'),
  ('restaurant.settings.view',    'restaurant', 'View restaurant settings'),
  ('restaurant.settings.manage',  'restaurant', 'Manage restaurant settings'),
  ('outlets.view',                'restaurant', 'View outlets'),
  ('outlets.manage',              'restaurant', 'Manage outlets'),
  ('users.view',                  'users',      'View users'),
  ('users.manage',                'users',      'Manage users'),
  ('roles.view',                  'users',      'View roles'),
  ('roles.manage',                'users',      'Manage roles and permissions'),
  ('menu.view',                   'menu',       'View menu'),
  ('menu.manage',                 'menu',       'Manage menu'),
  ('tables.view',                 'tables',     'View tables'),
  ('tables.manage',               'tables',     'Manage tables'),
  ('orders.view',                 'orders',     'View orders'),
  ('orders.create',               'orders',     'Create orders'),
  ('orders.manage',               'orders',     'Update and cancel orders'),
  ('billing.manage',              'billing',    'Create bills and apply discounts'),
  ('payments.manage',             'payments',   'Record payments and refunds'),
  ('kot.manage',                  'kitchen',    'Create and update KOTs'),
  ('kds.view',                    'kitchen',    'View kitchen display'),
  ('reports.view',                'reports',    'View reports');

-- System roles (restaurant_id NULL) matching the applications in the plan.
INSERT INTO roles (code, name, description, is_system) VALUES
  ('SUPER_ADMIN',      'Super Admin',      'Platform owner, manages all restaurants', TRUE),
  ('RESTAURANT_ADMIN', 'Restaurant Admin', 'Full access within one restaurant',       TRUE),
  ('MANAGER',          'Manager',          'Day-to-day operations and reports',       TRUE),
  ('CASHIER',          'Cashier',          'POS orders, billing and payments',        TRUE),
  ('CAPTAIN',          'Captain / Waiter', 'Takes table orders and sends KOTs',       TRUE),
  ('KITCHEN',          'Kitchen Staff',    'Kitchen display and KOT status',          TRUE);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
  (r.code = 'SUPER_ADMIN')
  OR (r.code = 'RESTAURANT_ADMIN' AND p.code <> 'platform.restaurants.manage')
  OR (r.code = 'MANAGER' AND p.code IN (
        'restaurant.settings.view', 'outlets.view', 'users.view', 'roles.view',
        'menu.view', 'menu.manage', 'tables.view', 'tables.manage',
        'orders.view', 'orders.create', 'orders.manage',
        'billing.manage', 'payments.manage', 'kot.manage', 'kds.view', 'reports.view'))
  OR (r.code = 'CASHIER' AND p.code IN (
        'menu.view', 'tables.view', 'orders.view', 'orders.create', 'orders.manage',
        'billing.manage', 'payments.manage', 'kot.manage'))
  OR (r.code = 'CAPTAIN' AND p.code IN (
        'menu.view', 'tables.view', 'orders.view', 'orders.create', 'kot.manage'))
  OR (r.code = 'KITCHEN' AND p.code IN ('kot.manage', 'kds.view'))
)
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE;

-- Down Migration

DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE restaurant_id IS NULL AND is_system = TRUE);

DELETE FROM roles WHERE restaurant_id IS NULL AND is_system = TRUE;

DELETE FROM permissions WHERE code IN (
  'platform.restaurants.manage', 'restaurant.settings.view', 'restaurant.settings.manage',
  'outlets.view', 'outlets.manage', 'users.view', 'users.manage', 'roles.view', 'roles.manage',
  'menu.view', 'menu.manage', 'tables.view', 'tables.manage',
  'orders.view', 'orders.create', 'orders.manage',
  'billing.manage', 'payments.manage', 'kot.manage', 'kds.view', 'reports.view'
);
