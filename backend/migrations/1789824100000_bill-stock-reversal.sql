-- Up Migration

-- Whether this bill took its ingredients out of stock. Auto-consumption is a
-- setting that can be switched off later, so the answer has to be remembered on
-- the bill itself: otherwise voiding an old bill would put back stock that was
-- never taken (or fail to return stock that was).
ALTER TABLE bills
  ADD COLUMN consume_stock BOOLEAN NOT NULL DEFAULT FALSE;

-- Bills written before this column existed consumed stock only if the setting
-- was on, which is the best guess available for them.
UPDATE bills b
SET consume_stock = s.auto_consume_stock
FROM restaurant_settings s
WHERE s.restaurant_id = b.restaurant_id;

-- Down Migration

ALTER TABLE bills DROP COLUMN IF EXISTS consume_stock;
