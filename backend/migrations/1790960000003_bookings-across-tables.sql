-- Up Migration

-- Large parties booked across several tables (sweep SW-A-16).
--
-- A weekend family of fourteen needs three tables pushed together. A booking
-- held one table, so the party was put on one table "over capacity" and the
-- two tables it would really need stayed free for anyone else to book for
-- the same evening — and were, until the family arrived to find them taken.
--
-- A booking keeps its main table where it always was (reservations.table_id:
-- the party's order opens there when they are seated) and holds the others
-- here. Every held table is reserved on the timeline and the floor plan, and
-- none of them can be booked by anyone else for an overlapping time. A
-- cancelled, completed or no-show booking holds nothing, so its rows are kept
-- only as its history; changing the booking's tables replaces them.
CREATE TABLE reservation_tables (
  reservation_id BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  table_id       BIGINT NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  restaurant_id  BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     BIGINT REFERENCES users(id),
  PRIMARY KEY (reservation_id, table_id)
);

-- "Is this table held by any booking?" — the clash check and the floor plan.
CREATE INDEX idx_reservation_tables_table ON reservation_tables (table_id);

-- When the tables held still do not seat the whole party, the host says why
-- ("two high chairs at the end", "kids on laps") rather than just ticking a box.
ALTER TABLE reservations ADD COLUMN capacity_override_reason VARCHAR(200);

-- Down Migration

ALTER TABLE reservations DROP COLUMN IF EXISTS capacity_override_reason;
DROP TABLE IF EXISTS reservation_tables;
