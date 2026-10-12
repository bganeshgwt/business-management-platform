-- Up Migration

-- Captain sections (sweep SW-A-20).
--
-- On a busy night the floor manager splits the room: Ramesh has the AC hall,
-- Sunil the terrace, Priya tables 1 to 6. Each captain's POS and floor plan
-- can then show "My tables", and a QR call or food waiting at the pass for
-- a table goes first to the captain who has it (everyone still sees it).
--
-- A plan is for one business date. An assignment names a floor, a section
-- (area) or one table; the most specific wins (a table given to Priya inside
-- Ramesh's floor is Priya's). "Copy yesterday's plan" copies the rows.
CREATE TABLE captain_assignments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  shift_date     DATE NOT NULL,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  floor_id       BIGINT REFERENCES floors(id) ON DELETE CASCADE,
  area_id        BIGINT REFERENCES dining_areas(id) ON DELETE CASCADE,
  table_id       BIGINT REFERENCES dining_tables(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     BIGINT REFERENCES users(id),
  -- Exactly one of floor, section or table.
  CHECK ((floor_id IS NOT NULL)::int + (area_id IS NOT NULL)::int + (table_id IS NOT NULL)::int = 1)
);

-- One captain per floor, section or table on a date: two captains "both
-- having" table 4 is how a table gets forgotten.
CREATE UNIQUE INDEX uq_captain_floor ON captain_assignments (restaurant_id, shift_date, floor_id) WHERE floor_id IS NOT NULL;
CREATE UNIQUE INDEX uq_captain_area ON captain_assignments (restaurant_id, shift_date, area_id) WHERE area_id IS NOT NULL;
CREATE UNIQUE INDEX uq_captain_table ON captain_assignments (restaurant_id, shift_date, table_id) WHERE table_id IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS captain_assignments;
