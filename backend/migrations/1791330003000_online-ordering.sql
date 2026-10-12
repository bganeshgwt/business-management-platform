-- Up Migration

-- The restaurant's own online ordering page (sweep SW-A-22).
--
-- Orders could already carry the source 'website' and the Deliveries screen
-- has a "Website" channel ("your own online ordering page"), but no such page
-- existed. Guests now order takeaway or delivery from a public link the
-- restaurant shares (Google profile, Instagram, WhatsApp status, a flyer).
--
-- What a guest sends is a REQUEST, exactly like a QR order from a table: it
-- lands in the same staff inbox (table_requests) and nothing reaches the
-- kitchen or the bill until a member of staff accepts it. Accepting creates a
-- takeaway or delivery order on the Website channel, so the channel's delivery
-- charge, packaging and channel prices apply through the order service. Using
-- the one inbox means the counters, the timers and the notification bell work
-- for online orders without a second screen to watch.

-- === The ordering link, one per selling point ===
-- outlet_id NULL is the main counter (the restaurant's own kitchen and day).
-- Each outlet gets a link of its own, because each has its own kitchen,
-- business day, riders and delivery area — like a QR table belongs to its
-- outlet. An order from a link is cooked, billed and counted where the link
-- belongs.
CREATE TABLE online_ordering_links (
  id                   BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id        BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id            BIGINT        REFERENCES outlets(id) ON DELETE CASCADE,
  -- The public link's key (/online/<token>): 192 random bits. Replacing it
  -- kills every copy of the old link without turning ordering off.
  token                VARCHAR(64)   NOT NULL UNIQUE,
  -- Off until a manager turns it on: a link nobody asked for must not start
  -- taking orders.
  is_enabled           BOOLEAN       NOT NULL DEFAULT FALSE,
  takeaway_enabled     BOOLEAN       NOT NULL DEFAULT TRUE,
  delivery_enabled     BOOLEAN       NOT NULL DEFAULT TRUE,
  -- Below this food total a delivery is not worth a rider's trip. 0 = none.
  min_delivery_order   NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (min_delivery_order >= 0),
  -- What the guest is told to expect: ready to collect in, delivered in.
  pickup_minutes       SMALLINT      NOT NULL DEFAULT 20 CHECK (pickup_minutes BETWEEN 5 AND 180),
  delivery_minutes     SMALLINT      NOT NULL DEFAULT 45 CHECK (delivery_minutes BETWEEN 10 AND 240),
  -- Orders one mobile may have waiting or in progress at once. Stops a prank
  -- (or a bot) sending ten cash-on-delivery orders to ten addresses.
  max_open_per_mobile  SMALLINT      NOT NULL DEFAULT 2 CHECK (max_open_per_mobile BETWEEN 1 AND 10),
  -- Where riders go, in the restaurant's words ("Within 5 km of Banjara Hills").
  delivery_area        VARCHAR(200),
  -- One line at the top of the page ("Fresh rotis till 11 pm").
  guest_note           VARCHAR(200),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by           BIGINT        REFERENCES users(id),
  updated_by           BIGINT        REFERENCES users(id),
  UNIQUE NULLS NOT DISTINCT (restaurant_id, outlet_id),
  -- A link that takes neither is a link that is switched off; say that instead.
  CONSTRAINT chk_online_links_service CHECK (takeaway_enabled OR delivery_enabled)
);

CREATE TRIGGER trg_online_ordering_links_updated_at
BEFORE UPDATE ON online_ordering_links
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- === Online orders in the staff inbox ===
-- A website order has no table: table_id becomes optional, and the request
-- says which channel it came from. Everything else (dishes, estimate, accept
-- or reject with a reason, the guest's status) is the QR flow's own.
ALTER TABLE table_requests ALTER COLUMN table_id DROP NOT NULL;

ALTER TABLE table_requests
  ADD COLUMN channel           VARCHAR(10)   NOT NULL DEFAULT 'qr'
                               CHECK (channel IN ('qr', 'website')),
  ADD COLUMN online_link_id    BIGINT        REFERENCES online_ordering_links(id) ON DELETE SET NULL,
  ADD COLUMN service_type      VARCHAR(10)   CHECK (service_type IN ('takeaway', 'delivery')),
  ADD COLUMN delivery_address  VARCHAR(500),
  ADD COLUMN delivery_landmark VARCHAR(200),
  -- How the guest will pay. Online payment waits for a payment gateway; until
  -- then only these two exist, and the page says so.
  ADD COLUMN payment_mode      VARCHAR(20)   CHECK (payment_mode IN ('pay_at_pickup', 'cash_on_delivery')),
  -- The delivery charge the guest was shown when ordering (the order works
  -- it out again on acceptance, from the Website channel).
  ADD COLUMN delivery_charge   NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
  -- The guest's own status link (/online/<link>/status/<guest_token>): 192
  -- random bits, so an order can never be found by counting up ids.
  ADD COLUMN guest_token       VARCHAR(64),
  ADD CONSTRAINT chk_table_requests_channel CHECK (
    (channel = 'qr' AND table_id IS NOT NULL AND service_type IS NULL)
    OR (channel = 'website' AND table_id IS NULL AND request_type = 'order'
        AND service_type IS NOT NULL AND payment_mode IS NOT NULL AND guest_token IS NOT NULL
        AND guest_name IS NOT NULL AND guest_mobile IS NOT NULL
        AND (service_type = 'takeaway' OR delivery_address IS NOT NULL))
  );

CREATE UNIQUE INDEX uq_table_requests_guest_token ON table_requests (guest_token)
  WHERE guest_token IS NOT NULL;

-- The idempotency key of a website order: one request per key per link.
CREATE UNIQUE INDEX uq_table_requests_online_key ON table_requests (online_link_id, client_key)
  WHERE channel = 'website' AND client_key IS NOT NULL;

-- "How many orders does this mobile have open?" on every website order.
CREATE INDEX idx_table_requests_online_mobile ON table_requests (restaurant_id, guest_mobile, created_at DESC)
  WHERE channel = 'website';

-- No new permission: switching the link on, its limits and its address are
-- orders.manage (as QR ordering's switch is); accepting or rejecting an
-- online order is orders.create, the same as a QR order.

-- Down Migration

DROP INDEX IF EXISTS idx_table_requests_online_mobile;
DROP INDEX IF EXISTS uq_table_requests_online_key;
DROP INDEX IF EXISTS uq_table_requests_guest_token;

-- Website requests cannot exist without these columns: they go with them.
DELETE FROM table_requests WHERE channel = 'website';

ALTER TABLE table_requests
  DROP CONSTRAINT IF EXISTS chk_table_requests_channel,
  DROP COLUMN IF EXISTS guest_token,
  DROP COLUMN IF EXISTS delivery_charge,
  DROP COLUMN IF EXISTS payment_mode,
  DROP COLUMN IF EXISTS delivery_landmark,
  DROP COLUMN IF EXISTS delivery_address,
  DROP COLUMN IF EXISTS service_type,
  DROP COLUMN IF EXISTS online_link_id,
  DROP COLUMN IF EXISTS channel;

ALTER TABLE table_requests ALTER COLUMN table_id SET NOT NULL;

DROP TABLE IF EXISTS online_ordering_links;
