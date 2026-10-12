-- Up Migration

-- Rider cash settlement in one step (sweep SW-A-19, delivery side).
--
-- Our own riders come back from a run with cash in their pocket for six or
-- eight bills. Paying each bill one by one in Bills took ten minutes at the
-- end of a night and was where money went missing. Now the cashier opens
-- "Settle rider", ticks which guests paid by UPI, counts the cash handed in,
-- and every bill is paid in one go. A shortfall is never quietly absorbed:
-- it is kept as owed by the rider, or written off by a manager, with a reason.
--
-- The billing and day-end build adds the drawer side (a shortfall out of the
-- drawer the cash went into, rider dues on the day-end); this records what
-- happened and pays the bills.
CREATE TABLE rider_settlements (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Where it was settled: an outlet's till, or the main counter (NULL).
  outlet_id           BIGINT REFERENCES outlets(id) ON DELETE SET NULL,
  -- The business day the money went into (the settling till's open day).
  business_day_id     BIGINT REFERENCES business_days(id) ON DELETE SET NULL,
  rider_employee_id   BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  bill_count          INTEGER NOT NULL CHECK (bill_count > 0),
  -- The cash the rider should hand in (bills the guest paid in cash).
  cash_expected       NUMERIC(12,2) NOT NULL CHECK (cash_expected >= 0),
  cash_handed         NUMERIC(12,2) NOT NULL CHECK (cash_handed >= 0),
  -- Bills the guest paid the restaurant by UPI at the door.
  upi_amount          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (upi_amount >= 0),
  shortfall           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (shortfall >= 0),
  -- What happens to a shortfall: the rider owes it (paid back later), or a
  -- manager writes it off. 'none' when the cash was all there.
  shortfall_action    VARCHAR(20) NOT NULL DEFAULT 'none'
                      CHECK (shortfall_action IN ('none', 'owed', 'written_off')),
  shortfall_reason    VARCHAR(200),
  approved_by         BIGINT REFERENCES users(id),
  -- An owed shortfall the rider has since handed over.
  repaid_at           TIMESTAMPTZ,
  repaid_by           BIGINT REFERENCES users(id),
  settled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_by          BIGINT REFERENCES users(id),
  CHECK (cash_handed <= cash_expected),
  CHECK (shortfall = cash_expected - cash_handed),
  CHECK ((shortfall = 0 AND shortfall_action = 'none')
         OR (shortfall > 0 AND shortfall_action IN ('owed', 'written_off') AND shortfall_reason IS NOT NULL)),
  CHECK (repaid_at IS NULL OR shortfall_action = 'owed')
);

-- The day's settlement report, and a rider's dues.
CREATE INDEX idx_rider_settlements_day ON rider_settlements (restaurant_id, business_day_id);
CREATE INDEX idx_rider_settlements_owed ON rider_settlements (restaurant_id, rider_employee_id)
  WHERE shortfall_action = 'owed' AND repaid_at IS NULL;

-- The bills one settlement paid, and how. A bill is settled once: the unique
-- bill_id is the last line of defence when two cashiers press Settle on the
-- same rider at the same moment (the bills are also locked while paying).
CREATE TABLE rider_settlement_bills (
  settlement_id  BIGINT NOT NULL REFERENCES rider_settlements(id) ON DELETE CASCADE,
  bill_id        BIGINT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  order_id       BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(10) NOT NULL CHECK (payment_method IN ('cash', 'upi')),
  PRIMARY KEY (settlement_id, bill_id)
);

CREATE UNIQUE INDEX uq_rider_settlement_bills_bill ON rider_settlement_bills (bill_id);

INSERT INTO permissions (code, module, name) VALUES
  ('deliveries.write_off_shortfall', 'orders', 'Write off a rider''s cash shortfall');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'deliveries.write_off_shortfall'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'deliveries.write_off_shortfall');
DELETE FROM permissions WHERE code = 'deliveries.write_off_shortfall';
DROP TABLE IF EXISTS rider_settlement_bills;
DROP TABLE IF EXISTS rider_settlements;
