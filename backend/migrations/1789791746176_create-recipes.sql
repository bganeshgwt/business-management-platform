-- Up Migration

-- What a dish is made of. Selling one plate of Chicken Biryani takes 0.250 kg
-- of rice and 0.200 kg of chicken out of stock, and tells you its food cost.
CREATE TABLE product_recipes (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id      BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  product_id         BIGINT        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_variant_id BIGINT        REFERENCES product_variants(id) ON DELETE CASCADE,
  inventory_item_id  BIGINT        NOT NULL REFERENCES inventory_items(id),
  quantity           NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by         BIGINT        REFERENCES users(id),
  updated_by         BIGINT        REFERENCES users(id),
  -- One row per ingredient per dish (or per size of that dish).
  UNIQUE NULLS NOT DISTINCT (product_id, product_variant_id, inventory_item_id)
);

CREATE INDEX idx_product_recipes_product ON product_recipes(product_id);
CREATE INDEX idx_product_recipes_item ON product_recipes(inventory_item_id);

CREATE TRIGGER trg_product_recipes_updated_at
BEFORE UPDATE ON product_recipes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS product_recipes;
