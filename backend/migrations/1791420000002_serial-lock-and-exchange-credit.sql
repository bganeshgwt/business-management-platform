-- Up Migration
-- Phase 2, T3 fixes after verification.
--
-- 1. The serial / IMEI "one place" rule now holds on its own under
--    concurrency: the trigger takes a transaction advisory lock on
--    (business, serial) before it counts, so a second transaction inserting
--    the same number waits for the first and then sees its row (READ
--    COMMITTED: each statement of the function takes a fresh snapshot). The
--    API was already safe (postings lock the business row first).
-- 2. Exchange credit kept on a customer's account becomes a collection with
--    method 'credit_note' (unallocated = an advance), so it can be spent on a
--    later bill: by the shared receivables "apply advance", or from the
--    Exchanges screen where the receivables module is off.

CREATE OR REPLACE FUNCTION electronics_serial_lot_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_tracking TEXT;
  kind TEXT;
  in_stock NUMERIC;
BEGIN
  SELECT tracking INTO item_tracking FROM catalog_skus WHERE business_id = NEW.business_id AND id = NEW.sku_id;
  IF item_tracking IS DISTINCT FROM 'serial' THEN RETURN NULL; END IF;
  -- One transaction at a time per (business, number), across all items.
  PERFORM pg_advisory_xact_lock(hashtext('electronics_serial'), hashtext(NEW.business_id::text || ':' || NEW.lot_code));
  IF NEW.quantity > 1 THEN
    RAISE EXCEPTION 'Serial / IMEI % is one unit; it cannot be in stock twice', NEW.lot_code USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO in_stock FROM business_stock_lots
   WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id AND lot_code = NEW.lot_code;
  IF in_stock > 1 THEN
    RAISE EXCEPTION 'Serial / IMEI % is already in stock at another location', NEW.lot_code USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM business_stock_lots WHERE business_id = NEW.business_id
      AND sku_id = NEW.sku_id AND lot_code = NEW.lot_code AND id <> NEW.id) THEN
    SELECT serial_kind INTO kind FROM electronics_models WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id;
    IF kind = 'imei' AND NOT electronics_valid_imei(NEW.lot_code) THEN
      RAISE EXCEPTION 'IMEI % is not valid: an IMEI has 15 digits and its last digit is a check digit. Check the number on the box.', NEW.lot_code USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM business_stock_lots l JOIN catalog_skus s ON s.business_id = l.business_id AND s.id = l.sku_id
               WHERE l.business_id = NEW.business_id AND l.lot_code = NEW.lot_code AND l.sku_id <> NEW.sku_id AND s.tracking = 'serial') THEN
      RAISE EXCEPTION 'Serial / IMEI % is already recorded under another item', NEW.lot_code USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Collections may carry exchange credit. Any later change to this CHECK must
-- keep the whole list.
ALTER TABLE business_collections DROP CONSTRAINT business_collections_method_check,
  ADD CONSTRAINT business_collections_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque', 'credit_note'));

ALTER TABLE business_exchanges ADD COLUMN credit_collection_id BIGINT,
  ADD CONSTRAINT business_exchanges_credit_collection_fkey FOREIGN KEY (business_id, credit_collection_id) REFERENCES business_collections(business_id, id),
  ADD CONSTRAINT business_exchanges_credit_on_account CHECK (credit_collection_id IS NULL OR method = 'on_account');

-- Down Migration
ALTER TABLE business_exchanges DROP CONSTRAINT business_exchanges_credit_on_account,
  DROP CONSTRAINT business_exchanges_credit_collection_fkey, DROP COLUMN credit_collection_id;
-- Refuses (as it should) while credit-note collections exist.
ALTER TABLE business_collections DROP CONSTRAINT business_collections_method_check,
  ADD CONSTRAINT business_collections_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'cheque'));
CREATE OR REPLACE FUNCTION electronics_serial_lot_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_tracking TEXT;
  kind TEXT;
  in_stock NUMERIC;
BEGIN
  SELECT tracking INTO item_tracking FROM catalog_skus WHERE business_id = NEW.business_id AND id = NEW.sku_id;
  IF item_tracking IS DISTINCT FROM 'serial' THEN RETURN NULL; END IF;
  IF NEW.quantity > 1 THEN
    RAISE EXCEPTION 'Serial / IMEI % is one unit; it cannot be in stock twice', NEW.lot_code USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO in_stock FROM business_stock_lots
   WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id AND lot_code = NEW.lot_code;
  IF in_stock > 1 THEN
    RAISE EXCEPTION 'Serial / IMEI % is already in stock at another location', NEW.lot_code USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM business_stock_lots WHERE business_id = NEW.business_id
      AND sku_id = NEW.sku_id AND lot_code = NEW.lot_code AND id <> NEW.id) THEN
    SELECT serial_kind INTO kind FROM electronics_models WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id;
    IF kind = 'imei' AND NOT electronics_valid_imei(NEW.lot_code) THEN
      RAISE EXCEPTION 'IMEI % is not valid: an IMEI has 15 digits and its last digit is a check digit. Check the number on the box.', NEW.lot_code USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM business_stock_lots l JOIN catalog_skus s ON s.business_id = l.business_id AND s.id = l.sku_id
               WHERE l.business_id = NEW.business_id AND l.lot_code = NEW.lot_code AND l.sku_id <> NEW.sku_id AND s.tracking = 'serial') THEN
      RAISE EXCEPTION 'Serial / IMEI % is already recorded under another item', NEW.lot_code USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
