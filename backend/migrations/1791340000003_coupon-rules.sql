-- Up Migration

-- Coupon rules (sweep SW-B-17).
--
-- A coupon could only say how much, the order type, a minimum order, dates
-- and a total number of uses. The offers a restaurant actually runs need more:
--   "20% off desserts"                    chosen dishes or categories, only
--                                         those lines discounted
--   "Happy hours, Mon–Thu 4–7 pm"         weekdays and a time window (it may
--                                         run past midnight: 10 pm–1 am)
--   "Welcome offer, once per guest"       one use per guest (needs a guest on
--                                         the bill)
--   "Buy 2 pizzas, get 1 free"            buy X get Y on chosen dishes: the
--                                         cheapest Y of each X+Y free, or a %
--                                         off them
-- Every rule is checked by the server when the coupon is applied, and the
-- till is told in words why a coupon does not apply. GST is worked out after
-- the discount, on each discounted line.

ALTER TABLE discounts
  ADD COLUMN offer_type           VARCHAR(20) NOT NULL DEFAULT 'discount'
                                  CHECK (offer_type IN ('discount', 'buy_get')),
  -- NULL: every dish. Otherwise only these dishes / dishes in these
  -- categories count toward the offer and are discounted.
  ADD COLUMN product_ids          BIGINT[],
  ADD COLUMN category_ids         BIGINT[],
  -- NULL: every day. 0 = Sunday … 6 = Saturday, as the restaurant's clock reads.
  ADD COLUMN weekdays             SMALLINT[],
  -- Both or neither. time_to before time_from runs past midnight.
  ADD COLUMN time_from            TIME,
  ADD COLUMN time_to              TIME,
  ADD COLUMN once_per_guest       BOOLEAN NOT NULL DEFAULT FALSE,
  -- Buy X get Y: of every X + Y eligible dishes, the Y cheapest are
  -- discounted by get_discount_percent (100 = free).
  ADD COLUMN buy_quantity         INTEGER CHECK (buy_quantity IS NULL OR buy_quantity BETWEEN 1 AND 50),
  ADD COLUMN get_quantity         INTEGER CHECK (get_quantity IS NULL OR get_quantity BETWEEN 1 AND 50),
  ADD COLUMN get_discount_percent NUMERIC(5,2) CHECK (get_discount_percent IS NULL OR get_discount_percent BETWEEN 1 AND 100),
  ADD CONSTRAINT chk_discount_time_window CHECK ((time_from IS NULL) = (time_to IS NULL)),
  ADD CONSTRAINT chk_discount_weekdays CHECK (weekdays IS NULL OR weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  ADD CONSTRAINT chk_discount_buy_get CHECK (
    offer_type <> 'buy_get'
    OR (buy_quantity IS NOT NULL AND get_quantity IS NOT NULL AND get_discount_percent IS NOT NULL)
  );

-- "Once per guest" looks for an earlier bill of this guest with this coupon.
CREATE INDEX idx_bills_discount_id ON bills (restaurant_id, discount_id) WHERE discount_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_bills_discount_id;

ALTER TABLE discounts
  DROP CONSTRAINT IF EXISTS chk_discount_buy_get,
  DROP CONSTRAINT IF EXISTS chk_discount_weekdays,
  DROP CONSTRAINT IF EXISTS chk_discount_time_window,
  DROP COLUMN IF EXISTS get_discount_percent,
  DROP COLUMN IF EXISTS get_quantity,
  DROP COLUMN IF EXISTS buy_quantity,
  DROP COLUMN IF EXISTS once_per_guest,
  DROP COLUMN IF EXISTS time_to,
  DROP COLUMN IF EXISTS time_from,
  DROP COLUMN IF EXISTS weekdays,
  DROP COLUMN IF EXISTS category_ids,
  DROP COLUMN IF EXISTS product_ids,
  DROP COLUMN IF EXISTS offer_type;
