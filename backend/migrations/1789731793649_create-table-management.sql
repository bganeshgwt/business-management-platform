-- Up Migration

CREATE TABLE floors (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id      BIGINT       REFERENCES outlets(id),
  name           VARCHAR(100) NOT NULL,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_floors_restaurant_name ON floors (restaurant_id, LOWER(name));
CREATE INDEX idx_floors_restaurant_id ON floors(restaurant_id);

CREATE TRIGGER trg_floors_updated_at
BEFORE UPDATE ON floors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Areas group tables inside a floor: AC, Non-AC, Garden, Rooftop.
CREATE TABLE dining_areas (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  floor_id       BIGINT       NOT NULL REFERENCES floors(id),
  name           VARCHAR(100) NOT NULL,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id),
  UNIQUE (floor_id, name)
);

CREATE INDEX idx_dining_areas_restaurant_id ON dining_areas(restaurant_id);

CREATE TRIGGER trg_dining_areas_updated_at
BEFORE UPDATE ON dining_areas
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- qr_token is the random text put inside the QR code printed for the table.
-- table_status is the live state used later by POS and Captain.
CREATE TABLE dining_tables (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id      BIGINT       REFERENCES outlets(id),
  floor_id       BIGINT       NOT NULL REFERENCES floors(id),
  area_id        BIGINT       REFERENCES dining_areas(id),
  table_no       VARCHAR(20)  NOT NULL,
  capacity       SMALLINT     NOT NULL DEFAULT 4 CHECK (capacity > 0 AND capacity <= 100),
  qr_token       VARCHAR(64)  NOT NULL UNIQUE,
  table_status   VARCHAR(20)  NOT NULL DEFAULT 'available'
                 CHECK (table_status IN ('available', 'occupied', 'reserved', 'cleaning')),
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id),
  UNIQUE (restaurant_id, table_no)
);

CREATE INDEX idx_dining_tables_restaurant_id ON dining_tables(restaurant_id);
CREATE INDEX idx_dining_tables_floor_id ON dining_tables(floor_id);

CREATE TRIGGER trg_dining_tables_updated_at
BEFORE UPDATE ON dining_tables
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS dining_tables;
DROP TABLE IF EXISTS dining_areas;
DROP TABLE IF EXISTS floors;
