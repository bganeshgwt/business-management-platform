-- Up Migration

-- === Kitchen stations ===
-- Where a dish is cooked: the tandoor, the main line, the wok, the bar. A
-- ticket is cut per station, so the tandoor cook sees naans and tikkas and
-- nothing else, and the bar is not scrolling past biryanis to find a lassi.
CREATE TABLE kitchen_stations (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(60)  NOT NULL,
  -- A named swatch rather than a hex code, so every station colour is one the
  -- board has a readable light and dark version of.
  color          VARCHAR(20)  NOT NULL DEFAULT 'orange'
                 CHECK (color IN ('orange', 'red', 'amber', 'green', 'teal', 'blue',
                                  'violet', 'pink', 'slate')),
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  -- Anything not routed anywhere else lands here, so no dish can ever go
  -- missing between stations.
  is_default     BOOLEAN      NOT NULL DEFAULT FALSE,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id),
  -- The catch-all must be able to take tickets.
  CONSTRAINT chk_kitchen_stations_default_active CHECK (NOT is_default OR status = 'active')
);

CREATE UNIQUE INDEX uq_kitchen_stations_name ON kitchen_stations (restaurant_id, LOWER(name));
-- Exactly one catch-all per restaurant.
CREATE UNIQUE INDEX uq_kitchen_stations_default ON kitchen_stations (restaurant_id)
  WHERE is_default;

CREATE TRIGGER trg_kitchen_stations_updated_at
BEFORE UPDATE ON kitchen_stations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which station cooks a category. Kept beside the menu rather than as a column
-- on categories, because routing is the kitchen's business and a category that
-- is never mapped simply falls to the default station.
CREATE TABLE kitchen_category_stations (
  category_id    BIGINT       PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  station_id     BIGINT       NOT NULL REFERENCES kitchen_stations(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by     BIGINT       REFERENCES users(id)
);

CREATE INDEX idx_kitchen_category_stations_restaurant ON kitchen_category_stations(restaurant_id);
CREATE INDEX idx_kitchen_category_stations_station ON kitchen_category_stations(station_id);

CREATE TRIGGER trg_kitchen_category_stations_updated_at
BEFORE UPDATE ON kitchen_category_stations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A single dish sent somewhere other than its category's station: Paneer
-- Tikka is a starter but it comes out of the tandoor; Chilli Chicken is a
-- starter off the wok. Real menus are grouped for the guest, not the cook.
CREATE TABLE kitchen_product_stations (
  product_id     BIGINT       PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  station_id     BIGINT       NOT NULL REFERENCES kitchen_stations(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by     BIGINT       REFERENCES users(id)
);

CREATE INDEX idx_kitchen_product_stations_restaurant ON kitchen_product_stations(restaurant_id);
CREATE INDEX idx_kitchen_product_stations_station ON kitchen_product_stations(station_id);

CREATE TRIGGER trg_kitchen_product_stations_updated_at
BEFORE UPDATE ON kitchen_product_stations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per restaurant: how long is too long, and when the display went live.
CREATE TABLE kitchen_settings (
  restaurant_id  BIGINT       PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  -- A ticket turns amber at warn_minutes and red at late_minutes. A dosa
  -- counter and a dum biryani kitchen do not share a clock, so it is set here.
  warn_minutes   SMALLINT     NOT NULL DEFAULT 10 CHECK (warn_minutes BETWEEN 1 AND 120),
  late_minutes   SMALLINT     NOT NULL DEFAULT 20 CHECK (late_minutes BETWEEN 2 AND 180),
  -- Order lines rung up before this moment never become tickets. Without it,
  -- switching the display on in the middle of a day would put every order
  -- already eaten and paid for on the board as "new".
  live_since     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by     BIGINT       REFERENCES users(id),
  CONSTRAINT chk_kitchen_settings_order CHECK (late_minutes > warn_minutes)
);

CREATE TRIGGER trg_kitchen_settings_updated_at
BEFORE UPDATE ON kitchen_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- === KOTs ===
-- A kitchen order ticket: one round of one order, for one station. Starters
-- sent at 8:00 and mains sent at 8:25 for the same table are two tickets,
-- because they are two separate calls to the pass.
CREATE TABLE kots (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id        BIGINT       REFERENCES outlets(id),
  -- Numbering restarts every business day (KOT-001...), the way the paper pad
  -- in every Indian kitchen does, and a day that runs past midnight keeps its
  -- own sequence.
  business_day_id  BIGINT       NOT NULL REFERENCES business_days(id),
  order_id         BIGINT       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station_id       BIGINT       NOT NULL REFERENCES kitchen_stations(id),
  kot_number       INTEGER      NOT NULL CHECK (kot_number > 0),
  kot_status       VARCHAR(20)  NOT NULL DEFAULT 'new'
                   CHECK (kot_status IN ('new', 'cooking', 'ready', 'served', 'cancelled')),
  -- When the waiter sent the lines: the order lines' own time, not the moment
  -- a screen happened to notice them. Every kitchen timer runs from here.
  created_at       TIMESTAMPTZ  NOT NULL,
  started_at       TIMESTAMPTZ,
  ready_at         TIMESTAMPTZ,
  served_at        TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  -- A bumped ticket brought back because it was bumped by mistake, or the
  -- plate came back. Counted, so a station that recalls a lot can be seen.
  recalled_at      TIMESTAMPTZ,
  recall_count     INTEGER      NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
  -- Set when a ticket left the board without anyone bumping it: its business
  -- day closed, its order was paid (a table) or billed and long gone (two
  -- hours on), or a manager cleared the old tickets. Such a ticket is served
  -- as far as the order is concerned, but it is never offered for recall and
  -- its cooking time, which nobody recorded, never counts in the figures.
  -- Without this, a parcel nobody bumped stays "new" on the board for ever.
  cleared_reason   VARCHAR(20)
                   CHECK (cleared_reason IN ('day_closed', 'order_closed', 'manager')),
  -- A reprint says so on the paper, so a duplicate cannot be cooked twice.
  print_count      INTEGER      NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  last_printed_at  TIMESTAMPTZ,
  started_by       BIGINT       REFERENCES users(id),
  ready_by         BIGINT       REFERENCES users(id),
  served_by        BIGINT       REFERENCES users(id),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by       BIGINT       REFERENCES users(id),
  UNIQUE (business_day_id, kot_number),
  CONSTRAINT chk_kots_cleared_served CHECK (cleared_reason IS NULL OR kot_status = 'served')
);

-- The board: every ticket still in the kitchen.
CREATE INDEX idx_kots_open ON kots (restaurant_id, created_at)
  WHERE kot_status IN ('new', 'cooking', 'ready');
-- The day's figures and the recall list.
CREATE INDEX idx_kots_day ON kots (restaurant_id, business_day_id);
CREATE INDEX idx_kots_served ON kots (restaurant_id, served_at DESC) WHERE kot_status = 'served';
CREATE INDEX idx_kots_order ON kots (order_id);
CREATE INDEX idx_kots_station ON kots (station_id);

CREATE TRIGGER trg_kots_updated_at
BEFORE UPDATE ON kots
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The next KOT number for a business day. A counter row rather than
-- MAX(kot_number) + 1, because two screens cutting tickets for two different
-- orders at the same instant would both read the same MAX.
CREATE TABLE kot_counters (
  business_day_id  BIGINT       PRIMARY KEY REFERENCES business_days(id) ON DELETE CASCADE,
  restaurant_id    BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  last_number      INTEGER      NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- A line on a ticket. Names are copied, like on a bill, so a ticket still
-- reads correctly after the menu changes.
CREATE TABLE kot_items (
  id                  BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kot_id              BIGINT        NOT NULL REFERENCES kots(id) ON DELETE CASCADE,
  restaurant_id       BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id            BIGINT        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: saving an edited order replaces its lines, and a
  -- ticket already cooking must survive that. The line is matched back to the
  -- new order line by line_key on the next sync.
  order_item_id       BIGINT        REFERENCES order_items(id) ON DELETE SET NULL,
  product_id          BIGINT        REFERENCES products(id) ON DELETE SET NULL,
  -- Dish, size, add-ons and note: what makes two order lines "the same dish
  -- ordered the same way". Lets a re-saved order be recognised as the ticket
  -- it already is, rather than cooked a second time.
  line_key            VARCHAR(400)  NOT NULL,
  item_name           VARCHAR(200)  NOT NULL,
  variant_name        VARCHAR(100),
  modifiers           JSONB         NOT NULL DEFAULT '[]',
  -- The dishes inside a combo or thali, so the cook knows what to plate.
  components          JSONB         NOT NULL DEFAULT '[]',
  notes               VARCHAR(200),
  food_type           VARCHAR(20),
  quantity            NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  -- Taken off at the till after the ticket was cut. The line stays on the
  -- ticket, struck through, so the cook sees it was stopped rather than lost.
  cancelled_quantity  NUMERIC(10,2) NOT NULL DEFAULT 0
                      CHECK (cancelled_quantity >= 0 AND cancelled_quantity <= quantity),
  is_done             BOOLEAN       NOT NULL DEFAULT FALSE,
  done_at             TIMESTAMPTZ,
  done_by             BIGINT        REFERENCES users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kot_items_kot ON kot_items(kot_id);
CREATE INDEX idx_kot_items_order ON kot_items(order_id);
CREATE INDEX idx_kot_items_order_item ON kot_items(order_item_id);

CREATE TRIGGER trg_kot_items_updated_at
BEFORE UPDATE ON kot_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The kitchen permissions were seeded with the first roles. Granted again here
-- in case a role has since lost them, so every kitchen-facing system role can
-- open the board; ON CONFLICT keeps grants that are already there untouched.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('kds.view', 'kot.manage')
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER', 'KITCHEN')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Down Migration

-- The kds.view / kot.manage grants are left alone: they were created by the
-- roles seed before this file existed, and taking them away here would lock
-- the kitchen out of screens it had before this migration.
DROP TABLE IF EXISTS kot_items;
DROP TABLE IF EXISTS kot_counters;
DROP TABLE IF EXISTS kots;
DROP TABLE IF EXISTS kitchen_settings;
DROP TABLE IF EXISTS kitchen_product_stations;
DROP TABLE IF EXISTS kitchen_category_stations;
DROP TABLE IF EXISTS kitchen_stations;
