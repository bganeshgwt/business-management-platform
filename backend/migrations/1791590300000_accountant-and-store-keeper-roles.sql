-- Up Migration

-- Two built-in roles every restaurant hires for in its first month, so the
-- owner no longer hand-builds them (and misses a permission, as the hand-made
-- store keepers did: no suppliers.view, so the purchase order form could not
-- list a supplier).
--
-- Accountant: the books — reports, sales figures, expenses, supplier bills
-- and payments, salaries and the activity log. No till, no menu.
-- Store keeper: the store — stock, counts, wastage, indents, purchase orders,
-- receiving goods and returns, and the supplier list to order from. No money
-- pages (paying suppliers, reports, salaries).
INSERT INTO roles (code, name, description, is_system) VALUES
  ('ACCOUNTANT', 'Accountant',
   'Keeps the books: reports and GST, expenses, supplier bills and payments, salaries and the activity log. Cannot take orders or change the menu.', TRUE),
  ('STORE_KEEPER', 'Store keeper',
   'Runs the store: stock, counts, wastage, indents, purchase orders, receiving goods and returns. Does not see payments, reports or salaries.', TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'reports.view', 'sales.view', 'expenses.view', 'expenses.manage',
  'purchasing.view', 'purchasing.pay', 'suppliers.view',
  'staff.view', 'staff.salaries', 'audit.view', 'business_day.view'
)
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE AND r.code = 'ACCOUNTANT'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'inventory.view', 'inventory.manage', 'inventory.count', 'inventory.waste', 'inventory.indent',
  'purchasing.view', 'purchasing.manage', 'purchasing.receive', 'purchasing.returns',
  'suppliers.view', 'menu.view'
)
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE AND r.code = 'STORE_KEEPER'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE restaurant_id IS NULL AND code IN ('ACCOUNTANT', 'STORE_KEEPER'));
DELETE FROM user_roles
WHERE role_id IN (SELECT id FROM roles WHERE restaurant_id IS NULL AND code IN ('ACCOUNTANT', 'STORE_KEEPER'));
DELETE FROM roles WHERE restaurant_id IS NULL AND code IN ('ACCOUNTANT', 'STORE_KEEPER');
