-- Up Migration

-- Business rules an owner sets (12 Oct 2026), each defaulting to what the
-- code used to fix, so nothing changes until the owner edits it:
--   voucher_valid_days   how long a credit voucher can be spent (was 90 days)
--   ageing_days          the three edges of the customer-credit age groups
--                        (0–30, 31–60, 61–90, over 90 days)
--   near_expiry_days     "expiring soon" for batches on the Overview, the bell,
--                        the near-expiry list and the stock list (was 30, and
--                        90 on the stock list; a pharmacy keeps its own in
--                        Pharmacy settings)
--   weight_buttons_grams the quick weight buttons at Quick bill
--   receipt_width_mm     the till receipt's paper (58 or 80 mm)
--   day_cutoff_hour      until this hour a task due after midnight still
--                        belongs to the day before (the restaurant has its own)

ALTER TABLE business_settings
  ADD COLUMN voucher_valid_days SMALLINT NOT NULL DEFAULT 90 CHECK (voucher_valid_days BETWEEN 1 AND 3650),
  ADD COLUMN ageing_days SMALLINT[] NOT NULL DEFAULT '{30,60,90}'
    CHECK (array_length(ageing_days, 1) = 3 AND ageing_days[1] >= 1 AND ageing_days[1] < ageing_days[2] AND ageing_days[2] < ageing_days[3] AND ageing_days[3] <= 3650),
  ADD COLUMN near_expiry_days SMALLINT NOT NULL DEFAULT 30 CHECK (near_expiry_days BETWEEN 1 AND 365),
  ADD COLUMN weight_buttons_grams INTEGER[] NOT NULL DEFAULT '{250,500,1000,2000}'
    CHECK (array_length(weight_buttons_grams, 1) BETWEEN 1 AND 8 AND 0 < ALL (weight_buttons_grams) AND 100000 >= ALL (weight_buttons_grams)),
  ADD COLUMN receipt_width_mm SMALLINT NOT NULL DEFAULT 80 CHECK (receipt_width_mm IN (58, 80)),
  ADD COLUMN day_cutoff_hour SMALLINT NOT NULL DEFAULT 5 CHECK (day_cutoff_hour BETWEEN 0 AND 12);

-- Down Migration

ALTER TABLE business_settings
  DROP COLUMN IF EXISTS voucher_valid_days, DROP COLUMN IF EXISTS ageing_days, DROP COLUMN IF EXISTS near_expiry_days,
  DROP COLUMN IF EXISTS weight_buttons_grams, DROP COLUMN IF EXISTS receipt_width_mm, DROP COLUMN IF EXISTS day_cutoff_hour;
