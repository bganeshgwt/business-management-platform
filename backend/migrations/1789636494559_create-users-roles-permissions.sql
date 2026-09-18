-- Up Migration

-- users.restaurant_id is NULL for platform admins (they manage all restaurants).
CREATE TABLE users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       REFERENCES restaurants(id),
  outlet_id      BIGINT       REFERENCES outlets(id),
  name           VARCHAR(150) NOT NULL,
  email          VARCHAR(150) NOT NULL,
  mobile         VARCHAR(20),
  password_hash  VARCHAR(255) NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive', 'locked')),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id)
);

-- Email is the login id, so it must be unique regardless of letter case.
CREATE UNIQUE INDEX uq_users_email_lower ON users (LOWER(email));
CREATE UNIQUE INDEX uq_users_mobile ON users (mobile) WHERE mobile IS NOT NULL;
CREATE INDEX idx_users_restaurant_id ON users(restaurant_id);

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- roles.restaurant_id is NULL for system roles shared by every restaurant;
-- a restaurant can later add its own custom roles.
CREATE TABLE roles (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       REFERENCES restaurants(id),
  code           VARCHAR(50)  NOT NULL,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  is_system      BOOLEAN      NOT NULL DEFAULT FALSE,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id),
  UNIQUE NULLS NOT DISTINCT (restaurant_id, code)
);

CREATE TRIGGER trg_roles_updated_at
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Permissions are defined by the application code, so they are global.
CREATE TABLE permissions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         VARCHAR(100) NOT NULL UNIQUE,
  module       VARCHAR(50)  NOT NULL,
  name         VARCHAR(150) NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE user_roles (
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     BIGINT      NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  BIGINT      REFERENCES users(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_roles_role_id ON user_roles(role_id);

CREATE TABLE role_permissions (
  role_id        BIGINT      NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  BIGINT      NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     BIGINT      REFERENCES users(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX idx_role_permissions_permission_id ON role_permissions(permission_id);

-- users exists now, so link the audit columns created in the previous migration.
ALTER TABLE restaurants
  ADD CONSTRAINT fk_restaurants_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  ADD CONSTRAINT fk_restaurants_updated_by FOREIGN KEY (updated_by) REFERENCES users(id);

ALTER TABLE outlets
  ADD CONSTRAINT fk_outlets_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  ADD CONSTRAINT fk_outlets_updated_by FOREIGN KEY (updated_by) REFERENCES users(id);

-- Down Migration

ALTER TABLE outlets
  DROP CONSTRAINT IF EXISTS fk_outlets_created_by,
  DROP CONSTRAINT IF EXISTS fk_outlets_updated_by;

ALTER TABLE restaurants
  DROP CONSTRAINT IF EXISTS fk_restaurants_created_by,
  DROP CONSTRAINT IF EXISTS fk_restaurants_updated_by;

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
