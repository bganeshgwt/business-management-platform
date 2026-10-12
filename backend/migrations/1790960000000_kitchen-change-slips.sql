-- Up Migration

-- Kitchen change slips (sweep SW-A-11).
--
-- A kitchen that works from printed KOTs keeps cooking whatever is on the
-- paper in front of it. The till printed only new tickets: when a dish on a
-- ticket the kitchen already held on paper was taken off, reduced, or the
-- whole order cancelled, nothing came out of the printer, and only a kitchen
-- screen (if there was one) said "stop cooking". Moving the party to another
-- table left the paper saying the old table, so the food went to the wrong
-- guests. That is also where dishes quietly disappear: a cancelled plate that
-- was cooked anyway walks out of the back door.
--
-- Each such change now leaves one slip per kitchen station, for the tickets
-- of that station the kitchen had on paper and had not yet served:
--   cancel           dishes taken off or reduced (with the reason, who did
--                    it and the manager who approved it)
--   order_cancelled  the whole order cancelled
--   table_changed    the party (or some of its dishes) moved to another
--                    table, or its table was joined to another party's
-- The slip is printed once, by whichever till claims it first
-- (print_count 0 -> 1 in one statement); printing it again says REPRINT.
-- A ticket never printed, or already served, gets no slip: there is no
-- paper in the kitchen to correct.
CREATE TABLE kot_change_slips (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id        BIGINT REFERENCES outlets(id) ON DELETE SET NULL,
  business_day_id  BIGINT REFERENCES business_days(id) ON DELETE SET NULL,
  -- The order the kitchen should now cook for (after a move, the order the
  -- dishes are on now).
  order_id         BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station_id       BIGINT NOT NULL REFERENCES kitchen_stations(id) ON DELETE CASCADE,
  kind             VARCHAR(20) NOT NULL
                   CHECK (kind IN ('cancel', 'order_cancelled', 'table_changed')),
  -- As printed, so a slip reads the same tomorrow as it did tonight.
  order_number     VARCHAR(40) NOT NULL,
  order_type       VARCHAR(20),
  table_no         VARCHAR(40),
  from_table_no    VARCHAR(40),
  to_table_no      VARCHAR(40),
  -- The paper tickets this slip corrects.
  kot_ids          BIGINT[] NOT NULL DEFAULT '{}',
  kot_numbers      INTEGER[] NOT NULL DEFAULT '{}',
  -- [{ name, variant, quantity, kotNumber }]: for a cancel, how many were
  -- taken off; for a table change, the dishes that moved.
  lines            JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason           VARCHAR(300),
  changed_by       BIGINT REFERENCES users(id),
  approved_by      BIGINT REFERENCES users(id),
  print_count      INTEGER NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  first_printed_at TIMESTAMPTZ,
  last_printed_at  TIMESTAMPTZ,
  last_printed_by  BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An order's slips (the till claims them after a save or a move).
CREATE INDEX idx_kot_change_slips_order ON kot_change_slips (order_id, id);
-- The day's slips on the kitchen screen, newest first.
CREATE INDEX idx_kot_change_slips_restaurant ON kot_change_slips (restaurant_id, created_at DESC);
-- Slips nobody has printed yet.
CREATE INDEX idx_kot_change_slips_unprinted ON kot_change_slips (restaurant_id, created_at)
  WHERE print_count = 0;

-- Down Migration

DROP TABLE IF EXISTS kot_change_slips;
