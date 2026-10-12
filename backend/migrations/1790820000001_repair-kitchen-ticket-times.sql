-- Up Migration

-- Kitchen tickets stamped as sent AFTER they were started, marked ready or
-- served. The kitchen seed used to backdate a round's dishes and its
-- progress but leave the ticket itself stamped "now", so a ticket read as
-- ready minutes before it was sent, and the board's average ticket time came
-- out negative (seen on the preview database: 29 tickets, worst -7920 s).
-- The seed is fixed (scripts/seed-kitchen.js stampRound); this puts right
-- the tickets it already wrote.
--
-- A ticket was sent when its round was rung up: the earliest dish on it.
-- Where even that is later than the ticket's own progress, the earliest of
-- its started / ready / served times is the latest it can have been sent.
-- Only impossible rows are touched, and each old time is kept so the Down
-- section can put it back exactly.
CREATE TABLE kot_time_repairs (
  kot_id          BIGINT PRIMARY KEY REFERENCES kots(id) ON DELETE CASCADE,
  old_created_at  TIMESTAMPTZ NOT NULL,
  repaired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO kot_time_repairs (kot_id, old_created_at)
SELECT k.id, k.created_at
FROM kots k
WHERE k.ready_at < k.created_at
   OR k.started_at < k.created_at
   OR k.served_at < k.created_at;

UPDATE kots k
SET created_at = LEAST(
      COALESCE((SELECT MIN(oi.created_at)
                FROM kot_items ki
                JOIN order_items oi ON oi.id = ki.order_item_id
                WHERE ki.kot_id = k.id), k.created_at),
      COALESCE(k.started_at, k.created_at),
      COALESCE(k.ready_at, k.created_at),
      COALESCE(k.served_at, k.created_at))
FROM kot_time_repairs r
WHERE r.kot_id = k.id;

-- Down Migration

UPDATE kots k
SET created_at = r.old_created_at
FROM kot_time_repairs r
WHERE r.kot_id = k.id;

DROP TABLE IF EXISTS kot_time_repairs;
