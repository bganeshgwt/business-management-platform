-- Up Migration

-- Pro pass C (7 Oct 2026): retail — grocery / kirana, supermarket, books.
-- * A location can be marked as not selling at the counter (a warehouse):
--   Quick bill then does not offer it as a till.
-- * Bookshops: school booklists / sets (a named list of items added to a
--   bill in one scan) and customer orders for a book not in stock, with an
--   advance kept as the customer's advance (a numbered collection).

-- --- Locations: which ones are tills -----------------------------------------------------

ALTER TABLE business_locations
  ADD COLUMN sells_at_counter BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing warehouses keep their stock but stop being offered at the counter.
UPDATE business_locations SET sells_at_counter = FALSE
 WHERE lower(name) LIKE '%warehouse%';

-- --- Books: school sets ---------------------------------------------------------------------

CREATE TABLE books_sets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  -- Scanned or typed at the counter to add the whole set.
  code VARCHAR(40) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,39}$'),
  school VARCHAR(150),
  class_name VARCHAR(60),
  notes VARCHAR(300),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, code)
);

CREATE TABLE books_set_items (
  business_id BIGINT NOT NULL,
  set_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0 AND quantity <= 1000),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, set_id, sku_id),
  FOREIGN KEY (business_id, set_id) REFERENCES books_sets(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);

-- --- Books: customer orders -------------------------------------------------------------------

CREATE TABLE books_customer_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  order_no VARCHAR(30) NOT NULL,
  contact_id BIGINT,
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  phone VARCHAR(30),
  title VARCHAR(200) NOT NULL CHECK (btrim(title) <> ''),
  author VARCHAR(200),
  isbn CHAR(13) CHECK (isbn IS NULL OR (isbn ~ '^97[89][0-9]{10}$' AND books_isbn_valid(isbn))),
  sku_id BIGINT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000),
  advance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (advance >= 0),
  -- The advance is the customer's money: a numbered collection on their account.
  collection_id BIGINT,
  promised_on DATE,
  notes VARCHAR(300),
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'arrived', 'collected', 'cancelled')),
  request_key UUID NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_no),
  UNIQUE (business_id, request_key),
  CHECK ((advance > 0) = (collection_id IS NOT NULL)),
  CHECK ((status IN ('collected', 'cancelled')) = (closed_at IS NOT NULL))
);
CREATE INDEX books_customer_orders_open ON books_customer_orders(business_id, status, created_at DESC);

-- An order only moves forward: ordered → arrived → collected, or cancelled
-- while not collected. Its customer, title, advance and key never change.
CREATE OR REPLACE FUNCTION books_customer_order_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A customer order cannot be deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.advance <> OLD.advance OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
     OR NEW.request_key <> OLD.request_key OR NEW.order_no <> OLD.order_no
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    RAISE EXCEPTION 'A customer order''s customer, advance and number are fixed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('collected', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'This order is already closed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'arrived' AND NEW.status = 'ordered' THEN
    RAISE EXCEPTION 'An order that has arrived cannot go back to ordered' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER books_customer_order_rules BEFORE UPDATE OR DELETE ON books_customer_orders
  FOR EACH ROW EXECUTE FUNCTION books_customer_order_rules();

-- Down Migration

DROP TRIGGER IF EXISTS books_customer_order_rules ON books_customer_orders;
DROP FUNCTION IF EXISTS books_customer_order_rules();
DROP TABLE IF EXISTS books_customer_orders;
DROP TABLE IF EXISTS books_set_items;
DROP TABLE IF EXISTS books_sets;
ALTER TABLE business_locations DROP COLUMN IF EXISTS sells_at_counter;
