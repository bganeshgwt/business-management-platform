-- Up Migration

CREATE TABLE customers (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(150)  NOT NULL,
  mobile         VARCHAR(20),
  email          VARCHAR(150),
  address        TEXT,
  date_of_birth  DATE,
  loyalty_points INTEGER       NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  notes          TEXT,
  status         VARCHAR(20)   NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by     BIGINT        REFERENCES users(id),
  updated_by     BIGINT        REFERENCES users(id)
);

-- Mobile is how a restaurant recognises a returning customer, so it is unique
-- per restaurant when given; walk-in guests can be saved without one.
CREATE UNIQUE INDEX uq_customers_restaurant_mobile
  ON customers (restaurant_id, mobile) WHERE mobile IS NOT NULL;
CREATE INDEX idx_customers_restaurant_id ON customers(restaurant_id);

CREATE TRIGGER trg_customers_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE feedback (
  id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id       BIGINT       REFERENCES outlets(id),
  customer_id     BIGINT       REFERENCES customers(id),
  customer_name   VARCHAR(150),
  customer_mobile VARCHAR(20),
  rating          SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comments        TEXT,
  source          VARCHAR(20)  NOT NULL DEFAULT 'in_store'
                  CHECK (source IN ('in_store', 'qr', 'website', 'phone', 'other')),
  feedback_status VARCHAR(20)  NOT NULL DEFAULT 'new'
                  CHECK (feedback_status IN ('new', 'reviewed', 'archived')),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by      BIGINT       REFERENCES users(id),
  updated_by      BIGINT       REFERENCES users(id)
);

CREATE INDEX idx_feedback_restaurant ON feedback(restaurant_id, created_at DESC);

CREATE TRIGGER trg_feedback_updated_at
BEFORE UPDATE ON feedback
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE complaints (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id        BIGINT       REFERENCES outlets(id),
  customer_id      BIGINT       REFERENCES customers(id),
  customer_name    VARCHAR(150),
  customer_mobile  VARCHAR(20),
  subject          VARCHAR(200) NOT NULL,
  description      TEXT,
  category         VARCHAR(30)  NOT NULL DEFAULT 'other'
                   CHECK (category IN ('food', 'service', 'delivery', 'billing', 'hygiene', 'other')),
  priority         VARCHAR(20)  NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low', 'medium', 'high')),
  complaint_status VARCHAR(20)  NOT NULL DEFAULT 'open'
                   CHECK (complaint_status IN ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to      BIGINT       REFERENCES users(id),
  resolution       TEXT,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by       BIGINT       REFERENCES users(id),
  updated_by       BIGINT       REFERENCES users(id)
);

CREATE INDEX idx_complaints_restaurant ON complaints(restaurant_id, created_at DESC);
CREATE INDEX idx_complaints_status ON complaints(restaurant_id, complaint_status);

CREATE TRIGGER trg_complaints_updated_at
BEFORE UPDATE ON complaints
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE expense_categories (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     BIGINT       REFERENCES users(id),
  updated_by     BIGINT       REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_expense_categories_name ON expense_categories (restaurant_id, LOWER(name));

CREATE TRIGGER trg_expense_categories_updated_at
BEFORE UPDATE ON expense_categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE expenses (
  id                  BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id           BIGINT        REFERENCES outlets(id),
  expense_category_id BIGINT        NOT NULL REFERENCES expense_categories(id),
  supplier_id         BIGINT        REFERENCES suppliers(id),
  expense_date        DATE          NOT NULL DEFAULT CURRENT_DATE,
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_mode        VARCHAR(20)   NOT NULL DEFAULT 'cash'
                      CHECK (payment_mode IN ('cash', 'card', 'upi', 'bank', 'other')),
  reference_no        VARCHAR(50),
  notes               TEXT,
  expense_status      VARCHAR(20)   NOT NULL DEFAULT 'pending'
                      CHECK (expense_status IN ('pending', 'approved', 'rejected')),
  approved_by         BIGINT        REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by          BIGINT        REFERENCES users(id),
  updated_by          BIGINT        REFERENCES users(id)
);

CREATE INDEX idx_expenses_restaurant ON expenses(restaurant_id, expense_date DESC);
CREATE INDEX idx_expenses_category ON expenses(expense_category_id);

CREATE TRIGGER trg_expenses_updated_at
BEFORE UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Permissions for the modules added in migrations 9-11.
INSERT INTO permissions (code, module, name) VALUES
  ('suppliers.view',    'purchasing', 'View suppliers'),
  ('suppliers.manage',  'purchasing', 'Create and edit suppliers'),
  ('inventory.view',    'inventory',  'View inventory and stock'),
  ('inventory.manage',  'inventory',  'Manage items, stock, adjustments and wastage'),
  ('purchasing.view',   'purchasing', 'View purchase orders'),
  ('purchasing.manage', 'purchasing', 'Create purchase orders and receive stock'),
  ('customers.view',    'crm',        'View customers'),
  ('customers.manage',  'crm',        'Create and edit customers'),
  ('feedback.view',     'crm',        'View feedback and complaints'),
  ('feedback.manage',   'crm',        'Record and resolve feedback and complaints'),
  ('expenses.view',     'expenses',   'View expenses'),
  ('expenses.manage',   'expenses',   'Record and approve expenses');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
  (r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN')
     AND p.code IN ('suppliers.view', 'suppliers.manage', 'inventory.view', 'inventory.manage',
                    'purchasing.view', 'purchasing.manage', 'customers.view', 'customers.manage',
                    'feedback.view', 'feedback.manage', 'expenses.view', 'expenses.manage'))
  OR (r.code = 'MANAGER'
     AND p.code IN ('suppliers.view', 'suppliers.manage', 'inventory.view', 'inventory.manage',
                    'purchasing.view', 'purchasing.manage', 'customers.view', 'customers.manage',
                    'feedback.view', 'feedback.manage', 'expenses.view', 'expenses.manage'))
  OR (r.code = 'CASHIER'
     AND p.code IN ('customers.view', 'customers.manage', 'feedback.view', 'feedback.manage'))
  OR (r.code = 'KITCHEN' AND p.code IN ('inventory.view'))
)
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE;

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE code IN (
    'suppliers.view', 'suppliers.manage', 'inventory.view', 'inventory.manage',
    'purchasing.view', 'purchasing.manage', 'customers.view', 'customers.manage',
    'feedback.view', 'feedback.manage', 'expenses.view', 'expenses.manage')
);

DELETE FROM permissions WHERE code IN (
  'suppliers.view', 'suppliers.manage', 'inventory.view', 'inventory.manage',
  'purchasing.view', 'purchasing.manage', 'customers.view', 'customers.manage',
  'feedback.view', 'feedback.manage', 'expenses.view', 'expenses.manage');

DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS expense_categories;
DROP TABLE IF EXISTS complaints;
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS customers;
