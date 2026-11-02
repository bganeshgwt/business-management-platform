-- Up Migration
-- Alerts on a closed phone for the captain app (Web Push). A captain who
-- switches on "Alerts when the app is closed" hands the server their phone's
-- push address. When a guest at their tables calls, a table sends an order
-- from its QR code, or food for their tables comes up at the pass, the server
-- sends that phone a short notification through the browser's push service:
-- the same moments, for the same people, as the open app chimes for
-- (backend/src/modules/push).
--
--   push_subscriptions  one row per phone: its push address (unique) and the
--                       keys its messages are encrypted with, whose it is,
--                       what for (purpose: captain), the restaurant and the
--                       outlet it alerts for, and whether it follows every
--                       table. The session it was made in bounds it: the
--                       login's token version and the session's end, so a
--                       person signed out everywhere, or whose session ran
--                       out, is sent nothing. A push service answering 404 or
--                       410 has dropped the address: the row is switched off
--                       at once, its keys wiped, and it is deleted 30 days
--                       later, as is a row whose session ended 30 days ago.
--                       It is staff data, kept only while alerts are wanted.
--   push_deliveries     one row per moment and phone, written before the
--                       send. Every API process hears every change; only the
--                       process whose row goes in sends, so a phone is
--                       alerted once for each moment. Kept two days.

CREATE TABLE push_subscriptions (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the phone is alerted for: the captain app's calls, QR orders and food at the pass.
  purpose          VARCHAR(20)   NOT NULL CHECK (purpose IN ('captain')),
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- The outlet the person works in, as the captain app reads the floor:
  -- that outlet's tables and those of no outlet. NULL is the whole restaurant.
  outlet_id        BIGINT        REFERENCES outlets(id) ON DELETE CASCADE,
  -- "All tables" chosen in the captain app; otherwise a captain with a
  -- section today is alerted for their own tables only.
  all_tables       BOOLEAN       NOT NULL DEFAULT FALSE,
  -- The push service's address for this phone. Only the browser and the
  -- server know it; it is never shown or logged.
  endpoint         TEXT          NOT NULL,
  -- The phone's public key (65 bytes) and authentication secret (16 bytes),
  -- base64url: what each message is encrypted for (RFC 8291). Wiped once the
  -- push service has dropped the address.
  p256dh           TEXT,
  auth             TEXT,
  user_agent       VARCHAR(300),
  -- The session it was made in: the login's token version then, and when
  -- that session ends unless the app renews it.
  token_version    INTEGER       NOT NULL CHECK (token_version >= 0),
  session_ends_at  TIMESTAMPTZ   NOT NULL,
  -- Nothing from before this is sent: when alerts were switched on, or the
  -- person, outlet or tables they follow last changed.
  watching_since   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_success_at  TIMESTAMPTZ,
  last_failure_at  TIMESTAMPTZ,
  -- Sends that failed in a row (the push service busy or unreachable).
  failures         INTEGER       NOT NULL DEFAULT 0 CHECK (failures >= 0),
  disabled_at      TIMESTAMPTZ,
  disabled_reason  VARCHAR(40),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint),
  CONSTRAINT push_subscriptions_endpoint_check CHECK (char_length(endpoint) BETWEEN 12 AND 2048 AND endpoint ~ '^https?://'),
  -- A row in use has both keys, each of its exact size; one switched off has none.
  CONSTRAINT push_subscriptions_keys_check CHECK (
    (disabled_at IS NULL AND p256dh ~ '^[A-Za-z0-9_-]{87}$' AND auth ~ '^[A-Za-z0-9_-]{22}$')
    OR (disabled_at IS NOT NULL AND p256dh IS NULL AND auth IS NULL)),
  CONSTRAINT push_subscriptions_disabled_check CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);

-- The phones a change may alert: one restaurant's rows in use.
CREATE INDEX idx_push_subscriptions_restaurant ON push_subscriptions (restaurant_id) WHERE disabled_at IS NULL;
-- A person's own phones (a test alert, removing a login).
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);

CREATE TRIGGER trg_push_subscriptions_updated_at
BEFORE UPDATE ON push_subscriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE push_deliveries (
  subscription_id  BIGINT        NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  -- The moment, as the captain app keys it: call:<request>, order:<request>,
  -- ready:<ticket> and ready:<ticket>.<dish>.
  moment           VARCHAR(80)   NOT NULL CHECK (moment ~ '^[a-z]+:[0-9]+(\.[0-9]+)?$'),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscription_id, moment)
);

-- Pruning: deliveries older than two days go.
CREATE INDEX idx_push_deliveries_created ON push_deliveries (created_at);

-- Down Migration
DROP TABLE push_deliveries;
DROP TABLE push_subscriptions;
