-- Up Migration

-- ===========================================================================
-- Running orders: numbering that survives a rush, one running order per
-- table, and a record of every dish taken off an order.
-- ===========================================================================

-- --- Order numbers ---------------------------------------------------------
-- Order numbers used to be COUNT(*) + 1, worked out inside each save. Six
-- tills saving in the same second all counted the same rows and two of them
-- were refused by the unique number with "Internal server error". A counter
-- row per restaurant, bumped with INSERT .. ON CONFLICT DO UPDATE, is locked
-- by the first save until it commits, so the next save waits a few
-- milliseconds and is handed the next number. The same pattern numbers KOTs
-- (kot_counters).
CREATE TABLE order_counters (
  restaurant_id  BIGINT       PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  last_number    INTEGER      NOT NULL CHECK (last_number >= 0),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Every restaurant carries on from the highest number it has already used,
-- so no new order can be handed a number an old one has. The number is read
-- from the digits after the last dash (ORD-0042 -> 42), whatever the prefix
-- was at the time; the count is a floor for any number that is not in that
-- shape.
INSERT INTO order_counters (restaurant_id, last_number)
SELECT o.restaurant_id,
       GREATEST(
         COUNT(*),
         COALESCE(MAX(NULLIF(SUBSTRING(o.order_number FROM '(\d+)$'), '')::bigint), 0)
       )::int
FROM orders o
GROUP BY o.restaurant_id;

-- --- One running order per table --------------------------------------------
-- Two captains tapping the same empty table in the same instant each opened
-- an order on it: one was hidden from the floor plan, and settling the other
-- freed a table that was still eating. The database now refuses a second
-- OPEN order on a table; the order service turns the refusal into "Table C3
-- already has ORD-0412 running".
--
-- Billed orders are left out on purpose: a bill carried over as dues when the
-- day closes stays "billed", and must not hold the table for ever.
--
-- If a table already has two open orders, the index cannot be built. Nothing
-- here guesses which one is real: the migration stops and names them, so a
-- manager can settle or cancel one and run it again.
DO $$
DECLARE
  clash TEXT;
BEGIN
  SELECT STRING_AGG(
           FORMAT('restaurant %s, table %s: %s', d.restaurant_id, d.table_no, d.numbers),
           '; ')
  INTO clash
  FROM (
    SELECT o.restaurant_id, t.table_no,
           STRING_AGG(o.order_number, ', ' ORDER BY o.id) AS numbers
    FROM orders o
    JOIN dining_tables t ON t.id = o.table_id
    WHERE o.order_status = 'open' AND o.table_id IS NOT NULL
    GROUP BY o.restaurant_id, t.table_no, o.table_id
    HAVING COUNT(*) > 1
  ) AS d;

  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'These tables have more than one open order: %. Settle or cancel the extra ones, then run this migration again.', clash;
  END IF;
END
$$;

CREATE UNIQUE INDEX uq_orders_open_table ON orders (table_id)
  WHERE order_status = 'open' AND table_id IS NOT NULL;

-- --- Dishes taken off an order -----------------------------------------------
-- One row for every dish (or part of one) taken off an order: from the POS
-- when a waiter presses minus and saves, from the Remove button on the Orders
-- screen, or because the whole order was cancelled.
--
-- The rows that matter most are after_kot = TRUE: the kitchen had already
-- been sent the dish. "Serve it, take cash, delete it from the order" is the
-- classic till fraud, so these need a reason and a manager, and the owner reads
-- them on Orders -> Dishes cancelled after KOT. A dish removed before the
-- kitchen ever saw it is recorded too (after_kot = FALSE) so the history is
-- complete, but it is simply a corrected order.
--
-- Names and money are copied, like on order_items, so the report still reads
-- right after the menu changes or the line is edited again.
CREATE TABLE order_item_cancellations (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id        BIGINT        REFERENCES outlets(id) ON DELETE SET NULL,
  business_day_id  BIGINT        REFERENCES business_days(id) ON DELETE SET NULL,
  order_id         BIGINT        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id    BIGINT        REFERENCES order_items(id) ON DELETE SET NULL,
  product_id       BIGINT        REFERENCES products(id) ON DELETE SET NULL,
  item_name        VARCHAR(200)  NOT NULL,
  variant_name     VARCHAR(100),
  -- The add-ons on the line, as the guest saw them ("Extra butter, Cheese").
  modifiers_label  VARCHAR(300),
  quantity         NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  -- Dish plus add-ons, one plate, as it was charged.
  unit_price       NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  -- What came off the bill for this quantity, tax included.
  amount           NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  after_kot        BOOLEAN       NOT NULL,
  -- How far the kitchen had got with it: new, cooking, ready or served.
  -- "Served, then cancelled" is the one an owner looks at first.
  kitchen_stage    VARCHAR(20)
                   CHECK (kitchen_stage IS NULL OR kitchen_stage IN ('new', 'cooking', 'ready', 'served')),
  reason_code      VARCHAR(30)
                   CHECK (reason_code IS NULL OR reason_code IN
                          ('guest_changed_mind', 'wrong_order', 'delay', 'quality', 'other')),
  reason_note      VARCHAR(200),
  -- edit = a waiter pressed minus in the POS and saved; item = the Remove
  -- button on the Orders screen; order = the whole order was cancelled.
  source           VARCHAR(20)   NOT NULL CHECK (source IN ('edit', 'item', 'order')),
  cancelled_by     BIGINT        REFERENCES users(id) ON DELETE SET NULL,
  -- The manager whose PIN allowed it, when the person doing it could not.
  approved_by      BIGINT        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- A dish the kitchen had needs a reason; "other" needs it written down.
  CONSTRAINT chk_cancellation_reason
    CHECK (NOT after_kot OR reason_code IS NOT NULL),
  CONSTRAINT chk_cancellation_other_note
    CHECK (reason_code IS DISTINCT FROM 'other' OR reason_note IS NOT NULL)
);

-- The owner's report: one restaurant's cancellations after KOT, newest first.
CREATE INDEX idx_item_cancellations_report
  ON order_item_cancellations (restaurant_id, created_at DESC)
  WHERE after_kot;

-- An order's own history, and how much of each line was taken off.
CREATE INDEX idx_item_cancellations_order ON order_item_cancellations (order_id);
CREATE INDEX idx_item_cancellations_item ON order_item_cancellations (order_item_id)
  WHERE order_item_id IS NOT NULL;

-- Filtering the report by business day.
CREATE INDEX idx_item_cancellations_day ON order_item_cancellations (business_day_id);

-- Down Migration

DROP TABLE IF EXISTS order_item_cancellations;
DROP INDEX IF EXISTS uq_orders_open_table;
DROP TABLE IF EXISTS order_counters;
