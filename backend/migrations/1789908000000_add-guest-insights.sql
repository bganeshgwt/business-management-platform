-- Up Migration

-- Guest insights reads a guest's whole history in one pass: every order linked
-- to a customer, joined to the bills on it. Until now neither side of that
-- join had an index — the orders were found by scanning the restaurant's
-- whole order book, and each order's bills by scanning every bill — which is
-- invisible on a demo and a real cost on a restaurant three years in. The same
-- two lookups serve the guest history panel on the Customers screen and the
-- "your regular is at T5" bell alert, which runs on every poll.
--
-- Partial on customer_id, because most orders are anonymous walk-ins and have
-- no reason to be in this index at all.
CREATE INDEX IF NOT EXISTS idx_orders_customer_id
  ON orders (restaurant_id, customer_id, placed_at)
  WHERE customer_id IS NOT NULL;

-- Split billing dropped the unique index that used to cover bills(order_id),
-- and nothing replaced it.
CREATE INDEX IF NOT EXISTS idx_bills_order_id ON bills (order_id);

-- Taking the guest book out of the building. A cashier needs to look guests up
-- at the till, but a list of every regular's mobile number is exactly what a
-- member of staff leaving for a competitor would take with them, so exporting
-- a segment (CSV or "copy mobiles") is its own permission, given to owners and
-- managers only. Every export is written to the activity log as well.
INSERT INTO permissions (code, module, name) VALUES
  ('customers.export', 'crm', 'Export guest lists and copy mobile numbers for campaigns');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'customers.export'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'customers.export');
DELETE FROM permissions WHERE code = 'customers.export';

DROP INDEX IF EXISTS idx_bills_order_id;
DROP INDEX IF EXISTS idx_orders_customer_id;
