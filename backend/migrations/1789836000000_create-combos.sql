-- Up Migration

-- A combo (a thali, a meal deal) is sold as one line at one set price, but it
-- is made of dishes the menu already knows. Making it a product means the POS,
-- the bill, tax and reports all treat it like any other item; the parts are
-- only needed to take the right ingredients out of stock.
ALTER TABLE products
  ADD COLUMN is_combo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE combo_items (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id      BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- The combo itself. Deleting the combo takes its parts list with it.
  combo_product_id   BIGINT        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- A dish inside the combo. Kept as a plain reference, so removing a dish that
  -- is part of a combo is refused rather than silently emptying the combo.
  product_id         BIGINT        NOT NULL REFERENCES products(id),
  product_variant_id BIGINT        REFERENCES product_variants(id),
  quantity           NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  sort_order         INTEGER       NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by         BIGINT        REFERENCES users(id),
  updated_by         BIGINT        REFERENCES users(id),
  -- A dish appears once in a combo; two of it is a quantity, not two rows.
  CONSTRAINT uq_combo_items UNIQUE NULLS NOT DISTINCT
    (combo_product_id, product_id, product_variant_id),
  -- A combo cannot contain itself. Deeper nesting is refused in code.
  CONSTRAINT chk_combo_not_self CHECK (combo_product_id <> product_id)
);

CREATE INDEX idx_combo_items_combo ON combo_items(combo_product_id);
CREATE INDEX idx_combo_items_product ON combo_items(product_id);
CREATE INDEX idx_combo_items_restaurant ON combo_items(restaurant_id);

CREATE TRIGGER trg_combo_items_updated_at
BEFORE UPDATE ON combo_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS combo_items;
ALTER TABLE products DROP COLUMN IF EXISTS is_combo;
