-- Up Migration

-- Online table booking for guests (sweep SW-A-21).
--
-- Bookings could already carry the source 'online', but nothing let a guest
-- make one: every "online" booking was a host typing in what a guest had sent
-- on WhatsApp. Guests now book from a public link the restaurant shares (on
-- Google, Instagram, its own site or a printed card).
--
-- What a guest sends is a REQUEST, not a booking. Indian restaurants take
-- online bookings this way: the host looks at the evening, the regulars and
-- the big parties already promised, and then says yes or no. Until then the
-- request holds no table (no table is ever shown to a guest), but its covers
-- count against the free capacity offered to the next guest, so a Saturday
-- 8 pm cannot be sold twenty times over while the host is busy on the floor.

-- === Two new states ===
-- requested -> confirmed (staff accept it; it is then an ordinary booking)
--           -> declined  (staff say no, with a reason the guest reads)
--           -> cancelled (the guest withdraws it from their status link)
ALTER TABLE reservations DROP CONSTRAINT reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('requested', 'booked', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show', 'declined'));

-- A guest told "no" is told why ("fully booked for a private function").
-- The reason lives in cancel_reason, the booking's one "why it did not
-- happen" column, so every screen and report that reads it keeps working.
ALTER TABLE reservations ADD CONSTRAINT chk_reservations_decline_reason
  CHECK (status <> 'declined' OR cancel_reason IS NOT NULL);

-- A request holds no table: tables are given when staff accept it. Enforced
-- here as well as in the service, because a request holding a table would be
-- invisible to every clash check (they look at live bookings only).
ALTER TABLE reservations ADD CONSTRAINT chk_reservations_request_no_table
  CHECK (status <> 'requested' OR table_id IS NULL);

ALTER TABLE reservations
  -- The guest's own status link (/book/<link>/status/<guest_token>): 192
  -- random bits, so a booking can never be found by counting up from R0001.
  ADD COLUMN guest_token VARCHAR(64),
  ADD COLUMN declined_at TIMESTAMPTZ;

CREATE UNIQUE INDEX uq_reservations_guest_token ON reservations (guest_token)
  WHERE guest_token IS NOT NULL;

-- The requests inbox on the Reservations screen: every request still waiting
-- for an answer, oldest first.
CREATE INDEX idx_reservations_requested ON reservations (restaurant_id, created_at)
  WHERE status = 'requested';

-- === The booking link, one per restaurant counter or outlet ===
-- outlet_id NULL is the main counter (the restaurant's own floor). Each outlet
-- gets a link of its own, because each has its own room, tables and staff.
CREATE TABLE online_booking_settings (
  id                   BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id        BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id            BIGINT       REFERENCES outlets(id) ON DELETE CASCADE,
  -- The public link's key (/book/<token>). Replacing it kills every copy of
  -- the old link (shared in the wrong group, say) without turning booking off.
  token                VARCHAR(64)  NOT NULL UNIQUE,
  -- Off until a manager turns it on: a link nobody asked for must not start
  -- taking bookings.
  is_enabled           BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Bigger groups are a phone call: a party of fifteen needs a menu and an
  -- advance, not a form.
  max_party_size       SMALLINT     NOT NULL DEFAULT 8 CHECK (max_party_size BETWEEN 1 AND 50),
  -- How much of the room online guests may fill at one time, in seats. The
  -- rest stays for walk-ins and regulars who phone.
  seat_share_percent   SMALLINT     NOT NULL DEFAULT 70 CHECK (seat_share_percent BETWEEN 10 AND 100),
  -- No online booking for "in 20 minutes": the host may not even see it.
  min_notice_minutes   SMALLINT     NOT NULL DEFAULT 60 CHECK (min_notice_minutes BETWEEN 0 AND 1440),
  days_ahead           SMALLINT     NOT NULL DEFAULT 30 CHECK (days_ahead BETWEEN 1 AND 180),
  -- How long a table is planned for; the window counted against capacity.
  duration_minutes     SMALLINT     NOT NULL DEFAULT 90 CHECK (duration_minutes BETWEEN 30 AND 360),
  -- Requests and upcoming bookings one mobile may hold at once: stops one
  -- person holding every Saturday slot "just in case".
  max_open_per_mobile  SMALLINT     NOT NULL DEFAULT 2 CHECK (max_open_per_mobile BETWEEN 1 AND 10),
  -- Days this link takes no bookings although the restaurant is open (a
  -- private function, a festival with walk-ins only).
  blocked_dates        DATE[]       NOT NULL DEFAULT '{}',
  -- A line guests read on the booking page ("Tables are held for 15 minutes").
  guest_note           VARCHAR(300),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by           BIGINT       REFERENCES users(id),
  updated_by           BIGINT       REFERENCES users(id),
  UNIQUE NULLS NOT DISTINCT (restaurant_id, outlet_id)
);

CREATE TRIGGER trg_online_booking_settings_updated_at
BEFORE UPDATE ON online_booking_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- === Permission ===
-- Answering requests is part of the host stand (reservations.manage, which
-- captains and cashiers hold). Opening a public channel, its limits and its
-- link is a manager's decision.
INSERT INTO permissions (code, module, name) VALUES
  ('reservations.online', 'reservations', 'Turn online table booking on or off and set its limits');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'reservations.online'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER');

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'reservations.online');
DELETE FROM permissions WHERE code = 'reservations.online';

DROP TABLE IF EXISTS online_booking_settings;

-- The old states cannot hold a request or a refusal: both become what they
-- would have been without online booking, a cancelled booking with its reason.
UPDATE reservations
SET status = 'cancelled',
    cancel_reason = COALESCE(cancel_reason, 'Online request not answered'),
    cancelled_at = COALESCE(cancelled_at, declined_at, NOW())
WHERE status IN ('requested', 'declined');

DROP INDEX IF EXISTS idx_reservations_requested;
DROP INDEX IF EXISTS uq_reservations_guest_token;
ALTER TABLE reservations DROP COLUMN IF EXISTS declined_at;
ALTER TABLE reservations DROP COLUMN IF EXISTS guest_token;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS chk_reservations_request_no_table;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS chk_reservations_decline_reason;
ALTER TABLE reservations DROP CONSTRAINT reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('booked', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'));
