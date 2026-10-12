-- Up Migration

-- === Who has seen which alert ===
-- The bell's alerts are never stored: each one is worked out from live data
-- every time the bell asks, so it cannot go on saying "3 bills unpaid" after
-- they were paid. The one thing that has to be remembered is who has already
-- seen what, so an alert someone has read stays read until the situation it
-- describes changes — at which point its provider gives it a new id and it is
-- unread again.
--
-- One row per person per alert. There is no created_by: user_id is the person,
-- and nobody writes a read mark on someone else's behalf.
CREATE TABLE notification_reads (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The provider's fingerprint, e.g. "bills:unpaid:812:critical". The part
  -- before the first colon is the provider's key, which is how the reads of an
  -- alert that has ended are found and forgotten.
  alert_id       VARCHAR(200) NOT NULL,
  -- Only for a summary alert ("6 more bills unpaid"), whose id stays the same
  -- while the rows behind it come and go: the ids of those rows when this
  -- person read it. The summary stays read while those rows get paid or
  -- fixed, and turns unread only when a row they have not seen joins it.
  -- NULL for an ordinary alert, and for a summary until the bell next asks.
  seen_members   TEXT[],
  read_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Restaurant first: a person's reads in one restaurant can never mark
  -- anything read in another, and every lookup starts from the restaurant.
  CONSTRAINT uq_notification_reads UNIQUE (restaurant_id, user_id, alert_id)
);

-- Pruning deletes marks older than 30 days, and trims one person's marks to
-- the newest few hundred; both read a person's marks newest first.
CREATE INDEX idx_notification_reads_user_read_at
  ON notification_reads (restaurant_id, user_id, read_at DESC);

CREATE TRIGGER trg_notification_reads_updated_at
BEFORE UPDATE ON notification_reads
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- === Keeping the bell cheap ===
-- The bell asks every 30 seconds, from every open screen. These partial
-- indexes hold only the rows an alert can come from — a few unpaid bills, a
-- few pending expenses, a few orders still on their way — so each check reads
-- a handful of entries instead of a restaurant's whole history.
CREATE INDEX idx_bills_unsettled
  ON bills (restaurant_id, billed_at)
  WHERE bill_status IN ('unpaid', 'partial');

CREATE INDEX idx_expenses_pending
  ON expenses (restaurant_id, created_at)
  WHERE expense_status = 'pending';

CREATE INDEX idx_purchase_orders_awaited
  ON purchase_orders (restaurant_id, expected_date)
  WHERE po_status IN ('ordered', 'partial');

-- No new permission: every signed-in person has a bell. What appears in it is
-- decided per provider by the permission of the module the alert comes from.

-- Down Migration

DROP INDEX IF EXISTS idx_purchase_orders_awaited;
DROP INDEX IF EXISTS idx_expenses_pending;
DROP INDEX IF EXISTS idx_bills_unsettled;
DROP TABLE IF EXISTS notification_reads;
