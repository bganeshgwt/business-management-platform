-- Up Migration

-- === Table requests ===
-- What a guest sends from the QR code on their table: an order for the staff
-- to accept, or a call for someone to come over (a waiter, the bill, water).
--
-- An order request is NOT an order. Nothing reaches the kitchen or the bill
-- until a member of staff accepts it, and acceptance prices every line again
-- through the order service. A printed QR code outlives the meal it was
-- printed for, so anyone who ever sat at the table holds one; a person in the
-- room saying yes is what stops an order from someone's sofa.
CREATE TABLE table_requests (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id        BIGINT        REFERENCES outlets(id),
  -- The table the QR code belongs to. The only thing that identifies a guest.
  table_id         BIGINT        NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  -- The trading day it arrived on, when one was open, so a day's requests can
  -- be counted with the rest of that day's figures.
  business_day_id  BIGINT        REFERENCES business_days(id) ON DELETE SET NULL,
  request_type     VARCHAR(20)   NOT NULL
                   CHECK (request_type IN ('order', 'call_waiter', 'bill', 'water', 'other')),
  -- An order waits (pending), is being turned into an order by someone right
  -- now (processing), then is accepted or rejected. A call waits, is seen
  -- (acknowledged), then is done. Either can be withdrawn by the guest.
  status           VARCHAR(20)   NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'accepted', 'rejected',
                                     'acknowledged', 'done', 'cancelled')),
  -- The phone's own id for this submission. A double tap, or a retry after a
  -- dropped connection, sends the same key and gets the same request back.
  client_key       VARCHAR(64),
  guest_name       VARCHAR(80),
  guest_mobile     VARCHAR(15),
  -- The guest's note for an order, or what they asked for on an "other" call.
  notes            VARCHAR(200),
  -- Dishes and the server's estimate at the time of asking, for the inbox.
  -- The real price is set on acceptance, from the menu as it is then.
  item_count       INTEGER       NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  estimated_total  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (estimated_total >= 0),
  -- The order an accepted request became part of, and whether it opened that
  -- order or was added to one the table already had running.
  order_id         BIGINT        REFERENCES orders(id) ON DELETE SET NULL,
  order_action     VARCHAR(10)   CHECK (order_action IN ('created', 'added')),
  -- How far the kitchen had taken this request's dishes when a later round
  -- was added to the same order. Adding dessert to a served table puts the
  -- order's kitchen status back to "pending" (dessert is now outstanding);
  -- without this, the first request's phone would go from "Served" back to
  -- "being prepared". Only used where no kitchen display tracks the lines.
  kitchen_reached  VARCHAR(10)   CHECK (kitchen_reached IN ('ready', 'served')),
  reject_reason    VARCHAR(200),
  -- Pressing "Call waiter" again while the first call is still open does not
  -- make a second card; it counts, because a guest asking twice is a guest
  -- getting impatient.
  repeat_count     SMALLINT      NOT NULL DEFAULT 0 CHECK (repeat_count >= 0),
  last_asked_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  BIGINT        REFERENCES users(id),
  -- Accepted, rejected, done or cancelled: when the request stopped waiting.
  resolved_at      TIMESTAMPTZ,
  resolved_by      BIGINT        REFERENCES users(id),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- NULL when a guest made it, which is almost always.
  created_by       BIGINT        REFERENCES users(id),
  updated_by       BIGINT        REFERENCES users(id),
  -- Orders are accepted or rejected; calls are acknowledged and done. Neither
  -- can wander into the other's states.
  CONSTRAINT chk_table_requests_flow CHECK (
    (request_type = 'order'
      AND status IN ('pending', 'processing', 'accepted', 'rejected', 'cancelled'))
    OR (request_type <> 'order'
      AND status IN ('pending', 'acknowledged', 'done', 'cancelled'))
  ),
  -- A guest told "no" is always told why.
  CONSTRAINT chk_table_requests_reject_reason
    CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CONSTRAINT chk_table_requests_client_key
    CHECK (client_key IS NULL OR client_key ~ '^[A-Za-z0-9-]{8,64}$')
);

-- The inbox and the notification bell: everything still waiting for someone.
CREATE INDEX idx_table_requests_open ON table_requests (restaurant_id, created_at)
  WHERE status IN ('pending', 'processing', 'acknowledged');
-- Today's and all history, newest first.
CREATE INDEX idx_table_requests_recent ON table_requests (restaurant_id, created_at DESC);
CREATE INDEX idx_table_requests_day ON table_requests (business_day_id);
-- A guest's status screen, and the per-table limits on how much one table may ask.
CREATE INDEX idx_table_requests_table ON table_requests (table_id, created_at DESC);
CREATE INDEX idx_table_requests_order ON table_requests (order_id);
-- The idempotency key: one request per key per table, however often it is sent.
CREATE UNIQUE INDEX uq_table_requests_client_key ON table_requests (table_id, client_key)
  WHERE client_key IS NOT NULL;
-- One open "call waiter", one open "bill", one open "water" per table. A
-- second press lands on the first (see repeat_count). "Other" is free text, so
-- two of those are genuinely two different asks.
CREATE UNIQUE INDEX uq_table_requests_open_call ON table_requests (table_id, request_type)
  WHERE status IN ('pending', 'acknowledged') AND request_type IN ('call_waiter', 'bill', 'water');

CREATE TRIGGER trg_table_requests_updated_at
BEFORE UPDATE ON table_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The dishes on an order request, exactly as the guest chose them. Names and
-- the estimate are copied, so the inbox still reads correctly if the menu
-- changes while the request waits.
CREATE TABLE table_request_items (
  id                  BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id          BIGINT        NOT NULL REFERENCES table_requests(id) ON DELETE CASCADE,
  restaurant_id       BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- SET NULL, not a hard reference: an old request must never stop a dish
  -- from being deleted. A request whose dish has gone cannot be accepted, and
  -- says so.
  product_id          BIGINT        REFERENCES products(id) ON DELETE SET NULL,
  product_variant_id  BIGINT        REFERENCES product_variants(id) ON DELETE SET NULL,
  modifier_ids        BIGINT[]      NOT NULL DEFAULT '{}',
  item_name           VARCHAR(150)  NOT NULL,
  variant_name        VARCHAR(100),
  -- [{ "id": 3, "name": "Extra cheese", "price": 40 }] at the time of asking.
  modifiers           JSONB         NOT NULL DEFAULT '[]',
  food_type           VARCHAR(20),
  -- Whole portions only, and a sane number of them: a guest cannot order 2.5
  -- biryanis or 900 naans from a phone.
  quantity            SMALLINT      NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  notes               VARCHAR(200),
  unit_price          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  sort_order          SMALLINT      NOT NULL DEFAULT 0,
  -- The order line this dish became when the request was accepted. The
  -- guest's status screen follows these lines, not the whole order: dessert
  -- added to a table whose mains are already served is not "served". SET NULL
  -- because the POS re-saves an order by replacing its lines; the screen then
  -- falls back to the order's own kitchen status.
  order_item_id       BIGINT        REFERENCES order_items(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_table_request_items_request ON table_request_items(request_id);
CREATE INDEX idx_table_request_items_product ON table_request_items(product_id);
CREATE INDEX idx_table_request_items_variant ON table_request_items(product_variant_id);
-- Every POS save deletes an order's lines, and each delete must find the rows
-- pointing at that line to clear them. Without this, that is a full scan of
-- every dish ever ordered from a QR code, on every save at the till.
CREATE INDEX idx_table_request_items_order_item ON table_request_items(order_item_id);

-- What guests may do from the table, per restaurant. Created on first read.
-- A packed Saturday with the kitchen already behind is exactly when a manager
-- wants to stop new QR orders without taking the codes off every table.
CREATE TABLE table_request_settings (
  restaurant_id     BIGINT        PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  ordering_enabled  BOOLEAN       NOT NULL DEFAULT TRUE,
  calls_enabled     BOOLEAN       NOT NULL DEFAULT TRUE,
  -- One line shown at the top of the guest menu: "Kitchen closes at 11 pm".
  guest_note        VARCHAR(200),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by        BIGINT        REFERENCES users(id)
);

CREATE TRIGGER trg_table_request_settings_updated_at
BEFORE UPDATE ON table_request_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No new permission: reading the inbox is orders.view, accepting or rejecting
-- an order is orders.create (it creates or changes one), and switching QR
-- ordering on or off is orders.manage. Captains already hold the first two,
-- which is who answers a table on the floor.

-- Down Migration

DROP TABLE IF EXISTS table_request_settings;
DROP TABLE IF EXISTS table_request_items;
DROP TABLE IF EXISTS table_requests;
