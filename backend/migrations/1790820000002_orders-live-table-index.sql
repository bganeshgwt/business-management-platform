-- Up Migration

-- The order running on a table right now.
--
-- The floor plan, the POS, seating from Reservations, QR requests and every
-- move between tables ask the same question: "the open or billed order on
-- this table". Only open orders had an index by table (idx_orders_table), so
-- a billed one, and every query that asks for both, read all of the
-- restaurant's open and billed orders once per table: the floor plan of a
-- restaurant with a few months of orders took one to seven seconds to load,
-- and grew slower every week. This index answers it straight from the table.
--
-- Building it holds new orders back for as long as the build takes (well
-- under a second for tens of thousands of orders), so it is applied when the
-- restaurant is not taking orders, like any other migration.
CREATE INDEX IF NOT EXISTS idx_orders_table_live
  ON orders (table_id, placed_at DESC)
  WHERE order_status IN ('open', 'billed') AND table_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_orders_table_live;
