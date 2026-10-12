-- Up Migration

-- Who sent each round to the kitchen.
--
-- A table's first round is rung up by one captain; dessert an hour later may
-- be added by another, or fired by the manager who held it. The pass calls
-- out "whose table is this?" from the ticket, and every ticket used to name
-- the person who opened the order, so round 2 read "Taken by Ravi" when it
-- was Priya who sent it. The ticket now keeps who sent its own round.
ALTER TABLE kots
  ADD COLUMN sent_by BIGINT REFERENCES users(id);

-- A held course goes to the kitchen when someone presses Fire, and that
-- person is who sent it, not whoever rang the dish up an hour earlier.
ALTER TABLE order_items
  ADD COLUMN fired_by BIGINT REFERENCES users(id);

-- Tickets already on record: the person who rang up the newest dish on the
-- ticket is the best answer there is (no fire was recorded for them).
UPDATE kots k
SET sent_by = sender.created_by
FROM (
  SELECT DISTINCT ON (ki.kot_id) ki.kot_id, oi.created_by
  FROM kot_items ki
  JOIN order_items oi ON oi.id = ki.order_item_id
  WHERE oi.created_by IS NOT NULL
  ORDER BY ki.kot_id, oi.created_at DESC, oi.id DESC
) AS sender
WHERE sender.kot_id = k.id AND k.sent_by IS NULL;

-- Down Migration

ALTER TABLE order_items DROP COLUMN IF EXISTS fired_by;
ALTER TABLE kots DROP COLUMN IF EXISTS sent_by;
