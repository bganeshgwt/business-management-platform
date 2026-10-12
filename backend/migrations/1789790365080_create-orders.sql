-- Up Migration

-- An order is the working document during service. Money columns are filled by
-- the server from the menu prices, never from what the browser sends.
CREATE TABLE orders (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id        BIGINT        REFERENCES outlets(id),
  business_day_id  BIGINT        REFERENCES business_days(id),
  order_number     VARCHAR(30)   NOT NULL,
  order_type       VARCHAR(20)   NOT NULL DEFAULT 'dine_in'
                   CHECK (order_type IN ('dine_in', 'takeaway', 'delivery', 'qr', 'online')),
  source           VARCHAR(20)   NOT NULL DEFAULT 'pos'
                   CHECK (source IN ('pos', 'captain', 'qr', 'website', 'phone', 'partner')),
  table_id         BIGINT        REFERENCES dining_tables(id),
  customer_id      BIGINT        REFERENCES customers(id),
  customer_name    VARCHAR(150),
  customer_mobile  VARCHAR(20),
  guest_count      SMALLINT      CHECK (guest_count IS NULL OR guest_count > 0),
  order_status     VARCHAR(20)   NOT NULL DEFAULT 'open'
                   CHECK (order_status IN ('open', 'billed', 'completed', 'cancelled')),
  kitchen_status   VARCHAR(20)   NOT NULL DEFAULT 'pending'
                   CHECK (kitchen_status IN ('pending', 'preparing', 'ready', 'served')),
  subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  notes            TEXT,
  cancel_reason    VARCHAR(200),
  placed_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by       BIGINT        REFERENCES users(id),
  updated_by       BIGINT        REFERENCES users(id),
  UNIQUE (restaurant_id, order_number),
  -- A dine-in order must say which table it belongs to.
  CONSTRAINT chk_orders_table CHECK (order_type <> 'dine_in' OR table_id IS NOT NULL)
);

CREATE INDEX idx_orders_restaurant ON orders(restaurant_id, placed_at DESC);
CREATE INDEX idx_orders_status ON orders(restaurant_id, order_status);
CREATE INDEX idx_orders_table ON orders(table_id) WHERE order_status = 'open';
CREATE INDEX idx_orders_business_day ON orders(business_day_id);

CREATE TRIGGER trg_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Names and prices are copied onto the line, so an old order still prints
-- correctly after the menu price changes.
CREATE TABLE order_items (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id           BIGINT        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id         BIGINT        NOT NULL REFERENCES products(id),
  product_variant_id BIGINT        REFERENCES product_variants(id),
  item_name          VARCHAR(200)  NOT NULL,
  variant_name       VARCHAR(100),
  quantity           NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  unit_price         NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  modifier_total     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (modifier_total >= 0),
  tax_percentage     NUMERIC(5,2)  NOT NULL DEFAULT 0,
  line_subtotal      NUMERIC(14,2) NOT NULL CHECK (line_subtotal >= 0),
  line_tax           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (line_tax >= 0),
  line_total         NUMERIC(14,2) NOT NULL CHECK (line_total >= 0),
  item_status        VARCHAR(20)   NOT NULL DEFAULT 'pending'
                     CHECK (item_status IN ('pending', 'preparing', 'ready', 'served', 'cancelled')),
  notes              VARCHAR(200),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by         BIGINT        REFERENCES users(id)
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TRIGGER trg_order_items_updated_at
BEFORE UPDATE ON order_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_item_modifiers (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_item_id  BIGINT        NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id    BIGINT        REFERENCES modifiers(id),
  modifier_name  VARCHAR(100)  NOT NULL,
  price          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_item_modifiers_item ON order_item_modifiers(order_item_id);

-- Down Migration

DROP TABLE IF EXISTS order_item_modifiers;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
