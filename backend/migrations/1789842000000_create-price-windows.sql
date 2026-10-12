-- Up Migration

-- Happy hour, a weekday lunch rate, a weekend surcharge: the same dish sold at
-- a different price at certain times. A window says WHEN, and its rows say
-- WHICH dishes and at what price. Nothing here changes the dish's own price,
-- so the moment a window ends the menu is back to normal by itself.
CREATE TABLE price_windows (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id      BIGINT       REFERENCES outlets(id) ON DELETE CASCADE,
  name           VARCHAR(80)  NOT NULL,
  -- 0 = Sunday … 6 = Saturday, matching PostgreSQL's EXTRACT(DOW).
  days_of_week   SMALLINT[]   NOT NULL
                 CHECK (array_length(days_of_week, 1) BETWEEN 1 AND 7),
  start_time     TIME         NOT NULL,
  -- An end earlier than the start means the window runs past midnight,
  -- the same rule shifts already use.
  end_time       TIME         NOT NULL,
  -- Optional season: a summer offer that expires on its own.
  valid_from     DATE,
  valid_to       DATE,
  -- When two windows cover the same dish at the same moment, the higher
  -- priority wins; ties fall back to the newer window.
  priority       INTEGER      NOT NULL DEFAULT 0,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id),
  CONSTRAINT chk_price_window_dates CHECK (valid_to IS NULL OR valid_from IS NULL
                                           OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX uq_price_windows_restaurant_name
  ON price_windows (restaurant_id, LOWER(name));
CREATE INDEX idx_price_windows_restaurant ON price_windows(restaurant_id);

CREATE TRIGGER trg_price_windows_updated_at
BEFORE UPDATE ON price_windows
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE price_window_items (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id      BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  price_window_id    BIGINT        NOT NULL REFERENCES price_windows(id) ON DELETE CASCADE,
  product_id         BIGINT        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- A price set for one size only; NULL covers every size of the dish.
  product_variant_id BIGINT        REFERENCES product_variants(id) ON DELETE CASCADE,
  price              NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by         BIGINT        REFERENCES users(id),
  updated_by         BIGINT        REFERENCES users(id),
  CONSTRAINT uq_price_window_items UNIQUE NULLS NOT DISTINCT
    (price_window_id, product_id, product_variant_id)
);

CREATE INDEX idx_price_window_items_window ON price_window_items(price_window_id);
CREATE INDEX idx_price_window_items_product ON price_window_items(product_id);

CREATE TRIGGER trg_price_window_items_updated_at
BEFORE UPDATE ON price_window_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An order line records the window it was priced by, so a manager can see why
-- a dish went out at a different price and report on what the offer cost.
ALTER TABLE order_items
  ADD COLUMN price_window_id BIGINT REFERENCES price_windows(id);

-- Down Migration

ALTER TABLE order_items DROP COLUMN IF EXISTS price_window_id;
DROP TABLE IF EXISTS price_window_items;
DROP TABLE IF EXISTS price_windows;
