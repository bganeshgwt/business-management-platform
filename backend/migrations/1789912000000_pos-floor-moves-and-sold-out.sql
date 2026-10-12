-- Up Migration

-- ===========================================================================
-- The POS floor: guests moving to another table, two tables pushed together
-- into one order, dishes moved from one table to another, and a sold-out list
-- that lasts one business day.
-- ===========================================================================

-- --- Tables joined to a running order -----------------------------------------
-- A party of ten on T4 and T5 pushed together is one order and one bill, but
-- two tables nobody else may be seated at. The order sits on T4
-- (orders.table_id); T5 is joined to it here. A joined table counts as taken
-- for as long as the order is running: a new order or a party from the
-- waiting list cannot be put on it (order.repository findRunningOnTable), and
-- the moment the bill is settled or the order cancelled the join means
-- nothing any more, so nobody has to remember to free T5.
--
-- Unjoining (the extra guests left, the tables were pulled apart) stamps
-- released_at rather than deleting the row, so the order's history still
-- says T5 was part of it.
CREATE TABLE order_joined_tables (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id       BIGINT       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  table_id       BIGINT       NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  released_at    TIMESTAMPTZ,
  released_by    BIGINT       REFERENCES users(id),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id)
);

-- One live join of a table to an order; the same table joined, released and
-- joined again is two rows.
CREATE UNIQUE INDEX uq_order_joined_tables_live
  ON order_joined_tables (order_id, table_id) WHERE released_at IS NULL;
-- "Is T5 joined to anything running?", asked every time an order is opened.
CREATE INDEX idx_order_joined_tables_table
  ON order_joined_tables (table_id) WHERE released_at IS NULL;

CREATE TRIGGER trg_order_joined_tables_updated_at
BEFORE UPDATE ON order_joined_tables
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A joined table is marked occupied (dining_tables.table_status) while the
-- party uses it, like the table the order sits on: the floor plan's counts,
-- the dashboard, "seat now" in reservations and removing a table all read
-- that flag. The moves free it when it is unjoined or the party moves away.
--
-- The party's order can be closed in many places: the bill paid at the
-- counter, a split bill's last share, an order or a delivery cancelled.
-- Each of those frees the order's own table and knows nothing of joined
-- ones, so without this a table joined to a party that has paid and left
-- stayed "occupied" for good, and no booking could be seated there. So the
-- database frees them, once, whichever code closed the order: every table
-- joined to it, unless another party is now on it or joined to it.
--
-- The join rows are kept as they are, so the order's history still says
-- which tables it had.
CREATE OR REPLACE FUNCTION free_joined_tables() RETURNS trigger AS $$
BEGIN
  UPDATE dining_tables t
  SET table_status = 'available'
  WHERE t.table_status = 'occupied'
    AND t.id IN (SELECT j.table_id FROM order_joined_tables j
                 WHERE j.order_id = NEW.id AND j.released_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM orders o
                    WHERE o.table_id = t.id AND o.order_status IN ('open', 'billed'))
    AND NOT EXISTS (SELECT 1 FROM order_joined_tables k
                    JOIN orders o ON o.id = k.order_id
                    WHERE k.table_id = t.id AND k.released_at IS NULL
                      AND o.order_status IN ('open', 'billed'));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_free_joined_tables
AFTER UPDATE OF order_status ON orders
FOR EACH ROW
WHEN (OLD.order_status IN ('open', 'billed') AND NEW.order_status NOT IN ('open', 'billed'))
EXECUTE FUNCTION free_joined_tables();

-- --- An order joined into another ----------------------------------------------
-- Joining T5's running order into T4's moves every dish (and its KOTs) onto
-- T4's order. T5's order is left with nothing on it and is closed as
-- cancelled, never deleted: its number was printed on KOTs and may be on a
-- guest's QR request, and an order number that vanishes is exactly what an
-- owner looking for fraud asks about. This says where it went, so screens and
-- reports can show "joined into ORD-0412" instead of a bare cancellation.
ALTER TABLE orders
  ADD COLUMN merged_into_order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX idx_orders_merged_into ON orders (merged_into_order_id)
  WHERE merged_into_order_id IS NOT NULL;

-- --- Who moved what, from where to where ----------------------------------------
-- The activity log records each move against the person who made it; this is
-- the same fact kept with the order, so the Orders screen can show an order's
-- own history ("moved T4 -> T6 by Ravi at 8:40") to staff who cannot read the
-- activity log, and so a kitchen screen can later say where a ticket went.
--
--   table   the whole order moved to a free table
--   join    a table joined to the order (from_order_id: the order that was
--           running there and was joined into this one, if there was one)
--   dishes  some dishes moved from one order to another table's order
--   unjoin  a joined table given back
--
-- Table numbers are copied, like dish names on a bill, so the history still
-- reads right after a table is renamed or removed.
CREATE TABLE order_moves (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  business_day_id  BIGINT        REFERENCES business_days(id) ON DELETE SET NULL,
  move_type        VARCHAR(10)   NOT NULL
                   CHECK (move_type IN ('table', 'join', 'dishes', 'unjoin')),
  from_order_id    BIGINT        REFERENCES orders(id) ON DELETE CASCADE,
  to_order_id      BIGINT        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_table_id    BIGINT        REFERENCES dining_tables(id) ON DELETE SET NULL,
  to_table_id      BIGINT        REFERENCES dining_tables(id) ON DELETE SET NULL,
  from_table_no    VARCHAR(20),
  to_table_no      VARCHAR(20),
  -- The dishes that moved: [{ itemName, variantName, quantity, amount }].
  items            JSONB         NOT NULL DEFAULT '[]',
  -- What they came to, tax included. Money moves between orders; it is never
  -- made or lost by a move, and this is how that can be checked afterwards.
  amount           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by       BIGINT        REFERENCES users(id)
);

CREATE INDEX idx_order_moves_to ON order_moves (to_order_id);
CREATE INDEX idx_order_moves_from ON order_moves (from_order_id) WHERE from_order_id IS NOT NULL;
CREATE INDEX idx_order_moves_day ON order_moves (restaurant_id, business_day_id);

-- --- Kitchen tickets that followed a move ---------------------------------------
-- A ticket follows its food: when a party moves to another table the ticket
-- is on the same order and the pass reads the new table; when some dishes
-- move to another table, the part of the ticket they were on becomes a
-- ticket of that table's order, same station, same stage, same clock. So the
-- kitchen is never sent the food a second time.
--
-- What the kitchen screen can say about it: which table the ticket was sent
-- for, when it moved, and (for dishes moved off part of a ticket) the ticket
-- it was split from. Written by the order moves only; empty on every other
-- ticket.
ALTER TABLE kots
  ADD COLUMN moved_from_table_no VARCHAR(20),
  ADD COLUMN moved_at            TIMESTAMPTZ,
  ADD COLUMN split_from_kot_id   BIGINT REFERENCES kots(id) ON DELETE SET NULL;

-- --- Sold out for tonight ---------------------------------------------------------
-- "Paneer is finished" is said at 9 pm and is true until the kitchen shuts.
-- Switching the dish off on the menu (products.is_available) lasts until
-- somebody remembers to switch it back on, which the next morning nobody
-- does, and the dish quietly disappears from the menu for days.
--
-- So the floor's switch is kept apart from the menu's: a row here says this
-- dish, or one size of it, is sold out for this business day. It is read only
-- while that day is open; when the next day opens it is a different day, and
-- the dish is back on sale without anybody touching it. The business-day code
-- does not need to know this table exists.
--
-- Putting a dish back on during the day stamps restored_at, so the evening's
-- history ("paneer out at 8:40, back at 9:10 after the delivery") survives.
CREATE TABLE menu_sold_out (
  id                  BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  business_day_id     BIGINT        NOT NULL REFERENCES business_days(id) ON DELETE CASCADE,
  product_id          BIGINT        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- Set: only this size is gone (Half biryani is finished, Full is not).
  product_variant_id  BIGINT        REFERENCES product_variants(id) ON DELETE CASCADE,
  note                VARCHAR(120),
  restored_at         TIMESTAMPTZ,
  restored_by         BIGINT        REFERENCES users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by          BIGINT        REFERENCES users(id),
  updated_by          BIGINT        REFERENCES users(id)
);

-- A dish (or a size of it) is sold out once per day at a time: two captains
-- tapping "sold out" together make one row.
CREATE UNIQUE INDEX uq_menu_sold_out_live
  ON menu_sold_out (business_day_id, product_id, COALESCE(product_variant_id, 0))
  WHERE restored_at IS NULL;
-- What is sold out right now, read by every order and every POS refresh.
CREATE INDEX idx_menu_sold_out_day
  ON menu_sold_out (restaurant_id, business_day_id) WHERE restored_at IS NULL;

CREATE TRIGGER trg_menu_sold_out_updated_at
BEFORE UPDATE ON menu_sold_out
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who may switch a dish off is left as the access migration set it
-- (menu.availability: owners, managers, captains, the kitchen). The same
-- permission also works the menu's own lasting switch (Menu > Products),
-- so it is not handed to cashiers here: a cashier could otherwise take a
-- dish off the menu for good. An owner who wants the counter to do it adds
-- it to the role knowingly.

-- Down Migration

DROP TRIGGER IF EXISTS trg_orders_free_joined_tables ON orders;
DROP FUNCTION IF EXISTS free_joined_tables();
DROP TABLE IF EXISTS menu_sold_out;
ALTER TABLE kots
  DROP COLUMN IF EXISTS split_from_kot_id,
  DROP COLUMN IF EXISTS moved_at,
  DROP COLUMN IF EXISTS moved_from_table_no;
DROP TABLE IF EXISTS order_moves;
DROP INDEX IF EXISTS idx_orders_merged_into;
ALTER TABLE orders DROP COLUMN IF EXISTS merged_into_order_id;
DROP TABLE IF EXISTS order_joined_tables;
