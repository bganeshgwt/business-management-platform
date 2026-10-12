-- Up Migration

-- --- An erased guest never earns points again -----------------------------------
-- Erasing a guest (crm.service eraseCustomer) cancels the points they held and
-- lets go of what is still running, so nothing can earn for the nameless
-- record afterwards. A bill paid at the very moment the guest is erased could
-- still do it: the till decides who earns before it takes the bill, and when
-- the erase got in between, the 5 points for that bill landed on the erased
-- record (and stayed in the points liability). The erase and the payment now
-- wait for each other instead of deadlocking (crm.repository
-- lockGuestBillsAndOrders), which makes that order the usual one.
--
-- This is the last line, the same as keep_erased_guests_unlinked: whatever
-- module writes points, an erased record gains none. The ledger row is not
-- written and the balance does not move, so the two still agree; the bill is
-- paid exactly as before. Taking points OFF an erased record (the erase's own
-- cancellation, a refund) is untouched.
CREATE FUNCTION skip_points_for_erased_guests() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.points > 0
     AND EXISTS (SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.erased_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_loyalty_transactions_erased_guest
BEFORE INSERT ON loyalty_transactions
FOR EACH ROW EXECUTE FUNCTION skip_points_for_erased_guests();

-- The balance kept on the guest's record, for the same case: the write that
-- follows the ledger row sets the new balance, and for an erased record it
-- may not rise. The erase itself sets erased_at in the same statement that
-- clears the record, after its points were already cancelled, so it is not
-- held back by this.
CREATE FUNCTION keep_erased_guests_balance() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL AND NEW.erased_at IS NOT NULL
     AND NEW.loyalty_points > OLD.loyalty_points THEN
    NEW.loyalty_points := OLD.loyalty_points;
  END IF;

  RETURN NEW;
END;
$$;

-- Records that already picked points up that way (the race above) have them
-- cancelled, with a ledger entry like the erase's own, so the points
-- liability stops counting them. Written before the triggers below, which
-- would otherwise hold the balance.
INSERT INTO loyalty_transactions (restaurant_id, customer_id, points, balance_after, entry_type, notes)
SELECT c.restaurant_id, c.id, -c.loyalty_points, 0, 'expire',
       'Cancelled: points earned after the guest was erased'
FROM customers c
WHERE c.erased_at IS NOT NULL AND c.loyalty_points > 0;

UPDATE customers SET loyalty_points = 0 WHERE erased_at IS NOT NULL AND loyalty_points > 0;

CREATE TRIGGER trg_customers_erased_points
BEFORE UPDATE OF loyalty_points ON customers
FOR EACH ROW EXECUTE FUNCTION keep_erased_guests_balance();

-- Down Migration

DROP TRIGGER IF EXISTS trg_customers_erased_points ON customers;

-- The points cancelled by the Up, put back as they were.
UPDATE customers c
SET loyalty_points = c.loyalty_points - t.points
FROM loyalty_transactions t
WHERE t.customer_id = c.id AND t.entry_type = 'expire'
  AND t.notes = 'Cancelled: points earned after the guest was erased';

DELETE FROM loyalty_transactions
WHERE entry_type = 'expire' AND notes = 'Cancelled: points earned after the guest was erased';

DROP FUNCTION IF EXISTS keep_erased_guests_balance();
DROP TRIGGER IF EXISTS trg_loyalty_transactions_erased_guest ON loyalty_transactions;
DROP FUNCTION IF EXISTS skip_points_for_erased_guests();
