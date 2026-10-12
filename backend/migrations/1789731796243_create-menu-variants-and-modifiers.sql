-- Up Migration

-- Sizes or portions of one product: Half / Full, 250ml / 500ml.
-- price_delta is added to the product price, so a Half plate can be -40.
CREATE TABLE product_variants (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  product_id     BIGINT        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name           VARCHAR(100)  NOT NULL,
  price_delta    NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_default     BOOLEAN       NOT NULL DEFAULT FALSE,
  sort_order     INTEGER       NOT NULL DEFAULT 0,
  status         VARCHAR(20)   NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by     BIGINT        REFERENCES users(id),
  updated_by     BIGINT        REFERENCES users(id)
);

-- Unique whatever the letter case, so "Half" and "half" cannot both exist.
CREATE UNIQUE INDEX uq_product_variants_name ON product_variants (product_id, LOWER(name));
CREATE INDEX idx_product_variants_product_id ON product_variants(product_id);

CREATE TRIGGER trg_product_variants_updated_at
BEFORE UPDATE ON product_variants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Add-ons shared across products: Extra cheese, Extra spicy, No onion.
CREATE TABLE modifiers (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(100)  NOT NULL,
  price          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  status         VARCHAR(20)   NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by     BIGINT        REFERENCES users(id),
  updated_by     BIGINT        REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_modifiers_restaurant_name ON modifiers (restaurant_id, LOWER(name));
CREATE INDEX idx_modifiers_restaurant_id ON modifiers(restaurant_id);

CREATE TRIGGER trg_modifiers_updated_at
BEFORE UPDATE ON modifiers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which add-ons may be chosen for which product.
CREATE TABLE product_modifiers (
  product_id   BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  modifier_id  BIGINT      NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   BIGINT      REFERENCES users(id),
  PRIMARY KEY (product_id, modifier_id)
);

CREATE INDEX idx_product_modifiers_modifier_id ON product_modifiers(modifier_id);

-- Down Migration

DROP TABLE IF EXISTS product_modifiers;
DROP TABLE IF EXISTS modifiers;
DROP TABLE IF EXISTS product_variants;
