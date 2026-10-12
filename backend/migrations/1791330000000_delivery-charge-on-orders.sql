-- Up Migration

-- Delivery charge on own-delivery orders (sweep SW-A-17, order side).
--
-- A restaurant running its own riders charges for the trip — ₹30 or ₹40,
-- often free above a bill size ("free delivery above ₹499"). Swiggy and
-- Zomato collect their own fee from the guest, so their channels usually
-- charge nothing. The charge is set per sales channel and worked out by the
-- server on the order (never taken from the screen); a manager may waive it
-- with a reason. The billing build then puts it on the bill as its own line
-- with its GST, and into the reports.

ALTER TABLE sales_channels
  -- The charge for one delivery on this channel. 0 = none (aggregators).
  ADD COLUMN delivery_charge     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
  -- No charge when the food comes to at least this much. NULL = always charged.
  ADD COLUMN delivery_free_above NUMERIC(12,2) CHECK (delivery_free_above IS NULL OR delivery_free_above > 0);

ALTER TABLE orders
  -- What this delivery is charged for the trip, before GST. Worked out again
  -- whenever the food or the channel changes, while the order is open.
  ADD COLUMN delivery_charge             NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
  -- GST on the charge follows the food it carries (the rate of the largest
  -- line): a delivery charge is part of a composite supply of food.
  ADD COLUMN delivery_charge_tax_percent NUMERIC(5,2) CHECK (delivery_charge_tax_percent IS NULL
                                                           OR delivery_charge_tax_percent BETWEEN 0 AND 100),
  -- A waived charge stays waived (0) however the order changes, and says
  -- who waived it and why: a regular, a late delivery, a wrong order.
  ADD COLUMN delivery_charge_waived_at     TIMESTAMPTZ,
  ADD COLUMN delivery_charge_waived_by     BIGINT REFERENCES users(id),
  ADD COLUMN delivery_charge_waived_reason VARCHAR(200),
  ADD CONSTRAINT chk_orders_delivery_waiver
    CHECK (delivery_charge_waived_at IS NULL OR delivery_charge_waived_reason IS NOT NULL);

-- Own delivery in an existing restaurant starts at no charge: the owner sets
-- the amount (nothing changes on anyone's bill until they do).

INSERT INTO permissions (code, module, name) VALUES
  ('orders.waive_delivery_charge', 'orders', 'Waive a delivery charge');

-- Owners and managers; a cashier asks a manager for the PIN.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'orders.waive_delivery_charge'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'orders.waive_delivery_charge');
DELETE FROM permissions WHERE code = 'orders.waive_delivery_charge';

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_delivery_waiver,
  DROP COLUMN IF EXISTS delivery_charge_waived_reason,
  DROP COLUMN IF EXISTS delivery_charge_waived_by,
  DROP COLUMN IF EXISTS delivery_charge_waived_at,
  DROP COLUMN IF EXISTS delivery_charge_tax_percent,
  DROP COLUMN IF EXISTS delivery_charge;

ALTER TABLE sales_channels
  DROP COLUMN IF EXISTS delivery_free_above,
  DROP COLUMN IF EXISTS delivery_charge;
