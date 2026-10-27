-- Up Migration
-- The clinic's and the lab's workspaces (the staff app's /clinic and /lab).
--
-- The lab's screens hear of every change, as the token queue already does. A
-- lab order, its samples and its results announce each change on the
-- business's live stream (area lab, with the order's id and its location): a
-- sample collected, received or rejected, a result typed, a report approved,
-- amended, cancelled or sent to an outside lab reaches every open collection
-- desk, worklist and approval list within about a second. A notification
-- names the order, never a result; the screen reads it again through the
-- normal API, which shows results only to those who may see them.
--
-- A consultation names a referral: to whom the doctor refers the patient (a
-- specialist, a hospital) and why. Both are clinical data, read and written
-- with the rest of the consultation, and kept as written once it is completed
-- (health_visit_fixed compares the whole row). A reason needs someone to refer
-- to.

-- --- The lab's live updates ----------------------------------------------------

-- A sample's or a result's change is its order's: announced in the lab area,
-- with the order's id and its location.
CREATE FUNCTION live_lab_order_part() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_row JSONB := to_jsonb(COALESCE(NEW, OLD));
  place BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND (now_row - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NULL;
  END IF;
  SELECT location_id INTO place FROM lab_orders WHERE business_id = (now_row->>'business_id')::bigint AND id = (now_row->>'order_id')::bigint;
  PERFORM live_announce_business((now_row->>'business_id')::bigint, place, NULL, 'lab', (now_row->>'order_id')::bigint);
  RETURN NULL;
END $$;

CREATE TRIGGER lab_orders_live AFTER INSERT OR UPDATE OR DELETE ON lab_orders
  FOR EACH ROW EXECUTE FUNCTION live_business_row('lab', 'id');
CREATE TRIGGER lab_samples_live AFTER INSERT OR UPDATE OR DELETE ON lab_samples
  FOR EACH ROW EXECUTE FUNCTION live_lab_order_part();
CREATE TRIGGER lab_results_live AFTER INSERT OR UPDATE OR DELETE ON lab_results
  FOR EACH ROW EXECUTE FUNCTION live_lab_order_part();

-- --- A consultation's referral ----------------------------------------------------

ALTER TABLE health_visits ADD COLUMN referred_to VARCHAR(200), ADD COLUMN referral_reason VARCHAR(1000),
  ADD CONSTRAINT health_visits_referral CHECK (referral_reason IS NULL OR referred_to IS NOT NULL);

-- Down Migration
ALTER TABLE health_visits DROP CONSTRAINT health_visits_referral, DROP COLUMN referral_reason, DROP COLUMN referred_to;
DROP TRIGGER lab_results_live ON lab_results;
DROP TRIGGER lab_samples_live ON lab_samples;
DROP TRIGGER lab_orders_live ON lab_orders;
DROP FUNCTION live_lab_order_part();
