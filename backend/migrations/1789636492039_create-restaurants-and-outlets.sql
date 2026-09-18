-- Up Migration

-- Shared trigger function: keeps updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE restaurants (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  code        VARCHAR(30)  NOT NULL UNIQUE,
  contact     VARCHAR(20),
  email       VARCHAR(150),
  address     TEXT,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by  BIGINT,
  updated_by  BIGINT
);

CREATE TRIGGER trg_restaurants_updated_at
BEFORE UPDATE ON restaurants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE outlets (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id),
  name           VARCHAR(150) NOT NULL,
  code           VARCHAR(30)  NOT NULL,
  contact        VARCHAR(20),
  address        TEXT,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT,
  updated_by     BIGINT,
  UNIQUE (restaurant_id, code)
);

CREATE INDEX idx_outlets_restaurant_id ON outlets(restaurant_id);

CREATE TRIGGER trg_outlets_updated_at
BEFORE UPDATE ON outlets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS outlets;
DROP TABLE IF EXISTS restaurants;
DROP FUNCTION IF EXISTS set_updated_at();
