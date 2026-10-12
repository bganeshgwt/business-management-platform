-- Up Migration

-- Rider cash in the drawer, to the paisa (sweep SW-X-RIDER-DRAWER).
--
-- A rider settlement pays each cash bill in full, into the settling till's
-- business day, so the bills read paid. When the rider hands in less than the
-- bills come to, the difference never reached the drawer: the day-end now
-- takes the shortfall off that day's expected cash, on its own line. When the
-- rider later hands an owed shortfall over, the cash goes into whichever day
-- is open at that till at that moment — recorded here so that day's drawer
-- expects it. Set by the database at the moment the shortfall is marked
-- repaid, so every way of marking it (the screen, a script) records it alike.
ALTER TABLE rider_settlements
  ADD COLUMN repaid_business_day_id BIGINT REFERENCES business_days(id) ON DELETE SET NULL;

CREATE INDEX idx_rider_settlements_repaid_day ON rider_settlements (restaurant_id, repaid_business_day_id)
  WHERE repaid_business_day_id IS NOT NULL;

-- The day the repaid cash went into: the day open now at the till the
-- settlement was made at (an outlet's own day, else the main counter's).
CREATE OR REPLACE FUNCTION rider_settlement_repaid_day() RETURNS trigger AS $$
BEGIN
  IF NEW.repaid_at IS NOT NULL AND OLD.repaid_at IS NULL AND NEW.repaid_business_day_id IS NULL THEN
    NEW.repaid_business_day_id := COALESCE(
      (SELECT bd.id FROM business_days bd
       WHERE bd.restaurant_id = NEW.restaurant_id AND bd.day_status = 'open'
         AND bd.outlet_id IS NOT DISTINCT FROM NEW.outlet_id
       ORDER BY bd.opened_at DESC LIMIT 1),
      (SELECT bd.id FROM business_days bd
       WHERE bd.restaurant_id = NEW.restaurant_id AND bd.day_status = 'open' AND bd.outlet_id IS NULL
       ORDER BY bd.opened_at DESC LIMIT 1));
  END IF;

  IF NEW.repaid_at IS NULL THEN
    NEW.repaid_business_day_id := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rider_settlements_repaid_day
BEFORE UPDATE OF repaid_at ON rider_settlements
FOR EACH ROW EXECUTE FUNCTION rider_settlement_repaid_day();

-- Down Migration

DROP TRIGGER IF EXISTS trg_rider_settlements_repaid_day ON rider_settlements;
DROP FUNCTION IF EXISTS rider_settlement_repaid_day();
DROP INDEX IF EXISTS idx_rider_settlements_repaid_day;
ALTER TABLE rider_settlements DROP COLUMN IF EXISTS repaid_business_day_id;
