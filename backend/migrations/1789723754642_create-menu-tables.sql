-- Up Migration

CREATE TABLE categories (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id)
);

-- Names are unique per restaurant whatever the letter case, so "Starters"
-- and "starters" cannot both exist.
CREATE UNIQUE INDEX uq_categories_restaurant_name
  ON categories (restaurant_id, LOWER(name));
CREATE INDEX idx_categories_restaurant_id ON categories(restaurant_id);

CREATE TRIGGER trg_categories_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- price uses NUMERIC so money maths is exact (FLOAT would round badly).
-- tax_percentage stays on the product until the Tax module (plan section 4) arrives.
CREATE TABLE products (
  id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id     BIGINT        NOT NULL REFERENCES categories(id),
  name            VARCHAR(150)  NOT NULL,
  code            VARCHAR(30),
  description     TEXT,
  price           NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  tax_percentage  NUMERIC(5,2)  NOT NULL DEFAULT 0
                  CHECK (tax_percentage >= 0 AND tax_percentage <= 100),
  food_type       VARCHAR(20)   NOT NULL DEFAULT 'veg'
                  CHECK (food_type IN ('veg', 'non_veg', 'egg')),
  is_available    BOOLEAN       NOT NULL DEFAULT TRUE,
  sort_order      INTEGER       NOT NULL DEFAULT 0,
  status          VARCHAR(20)   NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive')),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      BIGINT        REFERENCES users(id),
  updated_by      BIGINT        REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_products_restaurant_name
  ON products (restaurant_id, LOWER(name));
CREATE UNIQUE INDEX uq_products_restaurant_code
  ON products (restaurant_id, UPPER(code)) WHERE code IS NOT NULL;
CREATE INDEX idx_products_restaurant_id ON products(restaurant_id);
CREATE INDEX idx_products_category_id ON products(category_id);

CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
