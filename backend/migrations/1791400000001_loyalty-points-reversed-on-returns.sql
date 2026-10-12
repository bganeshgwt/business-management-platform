-- Up Migration
-- Loyalty points never go below zero.
--
-- Until now the points a sale earned were shrunk "on read" in proportion to
-- what came back from it, while points already spent stayed spent: earn 11,
-- redeem 11, return the first bill and the customer showed -8.
--
-- The rule from here on (docs/BUSINESS_PLATFORM_DATA_MODEL.md, Retail):
--   * a return takes back, at once and in its own transaction, the points
--     that bill earned in proportion to the value returned (a `reverse` entry
--     linked to the return);
--   * they come off the customer's points first, never below zero;
--   * whatever was already spent is the shortfall: its value (points x the
--     point value) is recorded on the entry and held back from any refund on
--     that bill; where no refund is paid out (an udhaar bill, an exchange)
--     the shortfall is written off and shows in the points history.
-- A constraint trigger refuses any entry that would leave a customer below
-- zero, whichever code path writes it.

ALTER TABLE retail_loyalty_entries
  ADD COLUMN return_id BIGINT,
  ADD COLUMN shortfall_points INTEGER NOT NULL DEFAULT 0 CHECK (shortfall_points >= 0),
  ADD COLUMN shortfall_value NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (shortfall_value >= 0),
  ADD CONSTRAINT retail_loyalty_entries_return_fkey FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  DROP CONSTRAINT retail_loyalty_entries_kind_check,
  DROP CONSTRAINT retail_loyalty_entries_points_check,
  DROP CONSTRAINT retail_loyalty_entries_check,
  ADD CONSTRAINT retail_loyalty_entries_kind_check CHECK (kind IN ('earn', 'redeem', 'adjust', 'reverse')),
  ADD CONSTRAINT retail_loyalty_entries_shape CHECK (
       (kind = 'earn' AND points > 0 AND document_id IS NOT NULL AND value IS NULL AND return_id IS NULL)
    OR (kind = 'redeem' AND points < 0 AND document_id IS NOT NULL AND value IS NOT NULL AND return_id IS NULL)
    OR (kind = 'adjust' AND points <> 0 AND document_id IS NULL AND value IS NULL AND reason IS NOT NULL AND request_key IS NOT NULL AND return_id IS NULL)
    OR (kind = 'reverse' AND points <= 0 AND document_id IS NOT NULL AND return_id IS NOT NULL AND value IS NULL AND (points < 0 OR shortfall_points > 0))),
  ADD CONSTRAINT retail_loyalty_entries_shortfall_only_reverse CHECK (kind = 'reverse' OR (shortfall_points = 0 AND shortfall_value = 0));

DROP INDEX retail_loyalty_entries_one_per_sale;
CREATE UNIQUE INDEX retail_loyalty_entries_one_per_sale ON retail_loyalty_entries(business_id, document_id, kind)
  WHERE document_id IS NOT NULL AND kind IN ('earn', 'redeem');
CREATE UNIQUE INDEX retail_loyalty_entries_one_per_return ON retail_loyalty_entries(business_id, return_id) WHERE return_id IS NOT NULL;

-- No entry may leave a customer below zero points. The services lock the
-- customer's row before writing, so this only ever catches a code path that
-- forgot to; it is the rule, written where nothing can skip it.
CREATE FUNCTION retail_loyalty_not_negative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held INTEGER;
BEGIN
  SELECT COALESCE(sum(points), 0) INTO held FROM retail_loyalty_entries
  WHERE business_id = NEW.business_id AND contact_id = NEW.contact_id;
  IF held < 0 THEN
    RAISE EXCEPTION 'This would leave the customer with % loyalty points; points cannot go below zero', held USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER retail_loyalty_not_negative AFTER INSERT ON retail_loyalty_entries
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (NEW.points < 0)
  EXECUTE FUNCTION retail_loyalty_not_negative();

-- Returns made before this change get their reversal now, oldest first,
-- with the same rule (taken from the points held, the rest a shortfall).
DO $$
DECLARE
  r RECORD;
  held INTEGER;
  target INTEGER;
  take INTEGER;
  worth NUMERIC;
BEGIN
  FOR r IN
    SELECT e.business_id, e.contact_id, e.document_id, e.points, e.created_by, d.total,
      (SELECT sum(x.total) FROM business_returns x WHERE x.business_id = d.business_id AND x.document_id = d.id) AS returned,
      (SELECT max(x.id) FROM business_returns x WHERE x.business_id = d.business_id AND x.document_id = d.id) AS last_return
    FROM retail_loyalty_entries e
    JOIN business_documents d ON d.business_id = e.business_id AND d.id = e.document_id
    WHERE e.kind = 'earn'
      AND EXISTS (SELECT 1 FROM business_returns x WHERE x.business_id = d.business_id AND x.document_id = d.id)
    ORDER BY e.id
  LOOP
    target := r.points - CASE WHEN r.total > 0 THEN floor(r.points * (r.total - r.returned) / r.total)::INTEGER ELSE 0 END;
    CONTINUE WHEN target <= 0;
    SELECT COALESCE(sum(points), 0) INTO held FROM retail_loyalty_entries WHERE business_id = r.business_id AND contact_id = r.contact_id;
    take := LEAST(target, GREATEST(held, 0));
    SELECT point_value INTO worth FROM retail_loyalty_settings WHERE business_id = r.business_id;
    INSERT INTO retail_loyalty_entries (business_id, contact_id, kind, points, document_id, return_id, shortfall_points, shortfall_value, reason, created_by)
    VALUES (r.business_id, r.contact_id, 'reverse', -take, r.document_id, r.last_return, target - take,
      round((target - take) * COALESCE(worth, 0), 2), 'Points from goods returned (recorded when this rule was introduced)', r.created_by);
  END LOOP;
END $$;

-- Down Migration
DROP TRIGGER retail_loyalty_not_negative ON retail_loyalty_entries;
DROP FUNCTION retail_loyalty_not_negative();
DROP INDEX retail_loyalty_entries_one_per_return;
DROP INDEX retail_loyalty_entries_one_per_sale;
ALTER TABLE retail_loyalty_entries DISABLE TRIGGER retail_loyalty_entries_append_only;
DELETE FROM retail_loyalty_entries WHERE kind = 'reverse';
ALTER TABLE retail_loyalty_entries ENABLE TRIGGER retail_loyalty_entries_append_only;
ALTER TABLE retail_loyalty_entries
  DROP CONSTRAINT retail_loyalty_entries_shortfall_only_reverse,
  DROP CONSTRAINT retail_loyalty_entries_shape,
  DROP CONSTRAINT retail_loyalty_entries_kind_check,
  DROP CONSTRAINT retail_loyalty_entries_return_fkey,
  DROP COLUMN shortfall_value,
  DROP COLUMN shortfall_points,
  DROP COLUMN return_id,
  ADD CONSTRAINT retail_loyalty_entries_kind_check CHECK (kind IN ('earn', 'redeem', 'adjust')),
  ADD CONSTRAINT retail_loyalty_entries_points_check CHECK (points <> 0),
  ADD CONSTRAINT retail_loyalty_entries_check CHECK (
       (kind = 'earn' AND points > 0 AND document_id IS NOT NULL AND value IS NULL)
    OR (kind = 'redeem' AND points < 0 AND document_id IS NOT NULL AND value IS NOT NULL)
    OR (kind = 'adjust' AND document_id IS NULL AND value IS NULL AND reason IS NOT NULL AND request_key IS NOT NULL));
CREATE UNIQUE INDEX retail_loyalty_entries_one_per_sale ON retail_loyalty_entries(business_id, document_id, kind) WHERE document_id IS NOT NULL;
