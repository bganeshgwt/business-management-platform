-- Up Migration

-- Daily token numbers and the collection screen (sweep SW-A-13).
--
-- A quick-service counter calls its parcels by a short number, not by
-- "ORD-13898": the guest holds a slip saying 23 and watches a screen until 23
-- turns up under "Ready". The number starts again at 1 every business day
-- (each outlet runs its own day, so each outlet counts its own), so it stays
-- short enough to shout across a counter.

-- The service desk's own settings (tokens now; more of the service lane's
-- switches join it later). One row per restaurant, made on first read.
CREATE TABLE service_settings (
  restaurant_id            BIGINT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- Off until the owner turns it on: a fine-dining room has no use for it.
  tokens_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  -- Which orders get a token: parcels at the counter by default; a cloud
  -- kitchen may want deliveries too.
  token_order_types        TEXT[] NOT NULL DEFAULT ARRAY['takeaway']::TEXT[]
                           CHECK (token_order_types <@ ARRAY['takeaway', 'delivery', 'online']::TEXT[]),
  -- A token leaves "Ready for pickup" when staff mark it collected, or this
  -- many minutes after it was ready (the guest took it and nobody tapped).
  collection_clear_minutes SMALLINT NOT NULL DEFAULT 10 CHECK (collection_clear_minutes BETWEEN 1 AND 120),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by               BIGINT REFERENCES users(id)
);

ALTER TABLE orders
  ADD COLUMN token_no           SMALLINT CHECK (token_no > 0),
  ADD COLUMN token_collected_at TIMESTAMPTZ,
  ADD COLUMN token_collected_by BIGINT REFERENCES users(id);

-- A token is never given twice in one business day, whatever two tills do at
-- the same moment (the counter below hands them out in turn; this is the
-- last line of defence).
CREATE UNIQUE INDEX uq_orders_day_token ON orders (business_day_id, token_no)
  WHERE token_no IS NOT NULL;

-- The collection screen reads the day's tokens still waiting to be picked up.
CREATE INDEX idx_orders_token_waiting ON orders (restaurant_id, business_day_id)
  WHERE token_no IS NOT NULL AND token_collected_at IS NULL;

-- The last token handed out on each business day. The row is locked by the
-- update until the order commits, so two tills saving at the same moment get
-- different tokens; a new business day has no row yet, so it starts at 1.
CREATE TABLE order_token_counters (
  business_day_id BIGINT PRIMARY KEY REFERENCES business_days(id) ON DELETE CASCADE,
  restaurant_id   BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  last_number     INTEGER NOT NULL CHECK (last_number >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seeing the collection screen. Everyone at the front of house may open it;
-- a TV by the counter signs in with the Collection display role, which can
-- see nothing else (no prices, no names, no other screen).
INSERT INTO permissions (code, module, name) VALUES
  ('orders.collection', 'orders', 'See the order collection screen (token numbers)');

INSERT INTO roles (code, name, description, is_system) VALUES
  ('DISPLAY', 'Collection display',
   'For a TV at the pickup counter: shows token numbers being prepared and ready. Sees nothing else.', TRUE);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'orders.collection'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER', 'CASHIER', 'CAPTAIN', 'KITCHEN', 'DISPLAY');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'orders.collection')
   OR role_id = (SELECT id FROM roles WHERE code = 'DISPLAY' AND restaurant_id IS NULL);
DELETE FROM user_roles WHERE role_id = (SELECT id FROM roles WHERE code = 'DISPLAY' AND restaurant_id IS NULL);
DELETE FROM roles WHERE code = 'DISPLAY' AND restaurant_id IS NULL;
DELETE FROM permissions WHERE code = 'orders.collection';

DROP TABLE IF EXISTS order_token_counters;
DROP INDEX IF EXISTS idx_orders_token_waiting;
DROP INDEX IF EXISTS uq_orders_day_token;
ALTER TABLE orders
  DROP COLUMN IF EXISTS token_collected_by,
  DROP COLUMN IF EXISTS token_collected_at,
  DROP COLUMN IF EXISTS token_no;
DROP TABLE IF EXISTS service_settings;
