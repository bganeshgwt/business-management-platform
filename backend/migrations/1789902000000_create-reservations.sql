-- Up Migration

-- === Reservations ===
-- A booking is a promise of a table at a time. The date and time are the
-- restaurant's own wall clock ("Thursday, 7:30 pm"), stored as DATE + TIME
-- rather than a TIMESTAMPTZ: that is how a guest books and how a host reads
-- the book, and it cannot drift when a server runs in another timezone.
CREATE TABLE reservations (
  id                BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id         BIGINT       REFERENCES outlets(id),
  -- What a guest quotes on the phone: "I have booking R0042".
  reference_no      VARCHAR(20)  NOT NULL,
  -- Linked only when staff pick an existing guest; a booking never creates a
  -- customer on its own, so the guest book holds people who chose to be in it.
  customer_id       BIGINT       REFERENCES customers(id) ON DELETE SET NULL,
  guest_name        VARCHAR(150) NOT NULL,
  guest_mobile      VARCHAR(20),
  party_size        SMALLINT     NOT NULL CHECK (party_size BETWEEN 1 AND 100),
  reservation_date  DATE         NOT NULL,
  start_time        TIME         NOT NULL,
  duration_minutes  SMALLINT     NOT NULL DEFAULT 90 CHECK (duration_minutes BETWEEN 15 AND 480),
  -- The window as one comparable value, so "does this overlap that" is a
  -- plain range comparison even when a late booking runs past midnight.
  starts_at         TIMESTAMP    GENERATED ALWAYS AS (reservation_date + start_time) STORED,
  ends_at           TIMESTAMP    GENERATED ALWAYS AS
                    (reservation_date + start_time + duration_minutes * INTERVAL '1 minute') STORED,
  -- Optional when booking (a large party may wait for the manager to plan the
  -- room), required to seat. A deleted table leaves the booking unassigned
  -- rather than taking the guest's booking with it.
  table_id          BIGINT       REFERENCES dining_tables(id) ON DELETE SET NULL,
  -- Someone knowingly put more guests on the table than it seats.
  capacity_override BOOLEAN      NOT NULL DEFAULT FALSE,
  occasion          VARCHAR(20)
                    CHECK (occasion IS NULL OR occasion IN
                      ('birthday', 'anniversary', 'business', 'date_night', 'other')),
  special_requests  VARCHAR(500),
  source            VARCHAR(20)  NOT NULL DEFAULT 'phone'
                    CHECK (source IN ('phone', 'walk_in', 'online', 'app', 'other')),
  internal_notes    VARCHAR(500),
  status            VARCHAR(20)  NOT NULL DEFAULT 'booked'
                    CHECK (status IN ('booked', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show')),
  -- The dine-in order opened when the party sat down.
  order_id          BIGINT       REFERENCES orders(id) ON DELETE SET NULL,
  cancel_reason     VARCHAR(200),
  confirmed_at      TIMESTAMPTZ,
  seated_at         TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  no_show_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by        BIGINT       REFERENCES users(id),
  updated_by        BIGINT       REFERENCES users(id),
  UNIQUE (restaurant_id, reference_no),
  -- A cancellation with no reason cannot be learnt from later.
  CONSTRAINT chk_reservations_cancel_reason
    CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  -- A party that is sitting down is sitting somewhere.
  CONSTRAINT chk_reservations_seated_table
    CHECK (status <> 'seated' OR table_id IS NOT NULL)
);

-- The day view: every booking on one date, in time order.
CREATE INDEX idx_reservations_day ON reservations (restaurant_id, reservation_date, start_time);

-- Double-booking checks and the floor plan's "reserved at 7:30" both ask
-- "what is booked on this table around this time", for live bookings only.
CREATE INDEX idx_reservations_table_window ON reservations (table_id, starts_at)
  WHERE status IN ('booked', 'confirmed', 'seated');

-- "Has this number booked before, and did they turn up?"
CREATE INDEX idx_reservations_mobile ON reservations (restaurant_id, guest_mobile)
  WHERE guest_mobile IS NOT NULL;

-- Settling the bill completes the booking; this finds it from the order.
CREATE INDEX idx_reservations_order ON reservations (order_id) WHERE order_id IS NOT NULL;

CREATE TRIGGER trg_reservations_updated_at
BEFORE UPDATE ON reservations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- === Walk-in waitlist ===
-- Guests standing at the door with no booking. The quoted wait is what the
-- host promised; the page compares it with how long they have really waited.
CREATE TABLE waitlist_entries (
  id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id       BIGINT       REFERENCES outlets(id),
  customer_id     BIGINT       REFERENCES customers(id) ON DELETE SET NULL,
  guest_name      VARCHAR(150) NOT NULL,
  guest_mobile    VARCHAR(20),
  party_size      SMALLINT     NOT NULL CHECK (party_size BETWEEN 1 AND 100),
  quoted_minutes  SMALLINT     NOT NULL DEFAULT 15 CHECK (quoted_minutes BETWEEN 0 AND 240),
  notes           VARCHAR(300),
  -- waiting -> seated | left (walked away, which is lost revenue worth
  -- counting) | removed (added by mistake, which is not).
  status          VARCHAR(20)  NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'seated', 'left', 'removed')),
  joined_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- When the host called or messaged to say the table is ready.
  notified_at     TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  table_id        BIGINT       REFERENCES dining_tables(id) ON DELETE SET NULL,
  order_id        BIGINT       REFERENCES orders(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by      BIGINT       REFERENCES users(id),
  updated_by      BIGINT       REFERENCES users(id),
  CONSTRAINT chk_waitlist_resolved
    CHECK (status = 'waiting' OR resolved_at IS NOT NULL)
);

-- The live queue and today's wait statistics.
CREATE INDEX idx_waitlist_restaurant_status ON waitlist_entries (restaurant_id, status, joined_at);

CREATE TRIGGER trg_waitlist_entries_updated_at
BEFORE UPDATE ON waitlist_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- === Permissions ===
-- Captains and cashiers work the door as much as managers do, so both get
-- the book. Seating also needs orders.create, which they already hold.
INSERT INTO permissions (code, module, name) VALUES
  ('reservations.view', 'reservations', 'View reservations and the waitlist'),
  ('reservations.manage', 'reservations', 'Take, change, seat and cancel reservations');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('reservations.view', 'reservations.manage')
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER', 'CASHIER', 'CAPTAIN');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE code IN ('reservations.view', 'reservations.manage')
);
DELETE FROM permissions WHERE code IN ('reservations.view', 'reservations.manage');

DROP TABLE IF EXISTS waitlist_entries;
DROP TABLE IF EXISTS reservations;
