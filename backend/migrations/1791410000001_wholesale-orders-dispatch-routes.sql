-- Up Migration
-- Wholesale / FMCG distribution (Phase 2, T2): sales orders that are
-- dispatched in one or more lots (each dispatch raises its tax invoice and
-- moves the stock), back-orders, routes and beats with salespeople, slab
-- prices per pack, and the salesperson/route on a collection.
--
-- When stock moves: at dispatch, never at order. A dispatch posts an
-- ordinary sale (business_documents) through the same code as any sale, so
-- the invoice, number series, stock ledger, credit limit, events and audit
-- are the core's own. The order only records what was asked for and what is
-- still to go.

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('sales_orders', 'Sales orders & dispatch',
  'Orders from trade customers, dispatched in part or in full with an invoice each time; back-orders, routes, beats and salespeople.', 'optional', 215);
INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('sales_orders', 'sales'), ('sales_orders', 'contacts'), ('sales_orders', 'inventory');
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('sales_orders', 'wholesale', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order) VALUES
 ('sales_orders.view', 'sales_orders', 'view', 'See sales orders, back-orders, routes and salespeople', 82),
 ('sales_orders.create', 'sales_orders', 'create', 'Take sales orders from customers', 83),
 ('sales_orders.edit', 'sales_orders', 'edit', 'Set up routes, beats and salespeople, and give customers their beat', 84),
 ('sales_orders.approve', 'sales_orders', 'approve', 'Dispatch orders (raises the invoice and moves the stock)', 85),
 ('sales_orders.cancel', 'sales_orders', 'cancel', 'Cancel an order or close its back-order', 86),
 ('sales_orders.export', 'sales_orders', 'export', 'Export sales orders and back-orders', 87),
 ('sales_orders.print', 'sales_orders', 'print', 'Print order and dispatch slips', 88);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'sales_orders'
UNION ALL SELECT 'cashier', unnest(ARRAY['sales_orders.view', 'sales_orders.create', 'sales_orders.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['sales_orders.view', 'sales_orders.approve', 'sales_orders.print'])
UNION ALL SELECT 'accountant', unnest(ARRAY['sales_orders.view', 'sales_orders.export', 'sales_orders.print'])
UNION ALL SELECT 'viewer', unnest(ARRAY['sales_orders.view', 'sales_orders.export']);

INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
WHERE NOT r.full_access AND tp.permission_code LIKE 'sales_orders.%'
ON CONFLICT DO NOTHING;

INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, 'sales_orders' FROM businesses b
WHERE b.business_type = 'wholesale'
  AND (SELECT count(*) FROM business_capabilities c WHERE c.business_id = b.id AND c.capability IN ('sales', 'contacts', 'inventory')) = 3
ON CONFLICT DO NOTHING;

-- Slab prices per pack: "5 cases or more: Rs 2,050 a case". unit_code NULL
-- keeps the old meaning (minimum and price in the item's stock unit). A pack
-- price must name a pack size this item really has.
ALTER TABLE business_price_rules ADD COLUMN unit_code VARCHAR(20),
  ADD CONSTRAINT business_price_rules_pack_fkey FOREIGN KEY (business_id, sku_id, unit_code)
    REFERENCES catalog_sku_units(business_id, sku_id, unit_code);
DROP INDEX business_price_threshold;
CREATE UNIQUE INDEX business_price_threshold ON business_price_rules(business_id, sku_id, COALESCE(contact_id, 0), COALESCE(unit_code, ''), minimum_quantity) WHERE active;

-- Salespeople (field staff who take orders and collect money).
CREATE TABLE wholesale_salespeople (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  phone VARCHAR(30),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX wholesale_salespeople_name ON wholesale_salespeople(business_id, lower(name));

-- A route is a delivery run (one van, one direction); a beat is the set of
-- shops on a route visited on one day by one salesperson.
CREATE TABLE wholesale_routes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
  -- The godown its van loads from (optional).
  location_id BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX wholesale_routes_name ON wholesale_routes(business_id, lower(name));

CREATE TABLE wholesale_beats (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  route_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL CHECK (btrim(name) <> ''),
  -- ISO day of the week the beat is visited (1 = Monday … 7 = Sunday); NULL = any day.
  visit_day SMALLINT CHECK (visit_day BETWEEN 1 AND 7),
  salesperson_id BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, route_id) REFERENCES wholesale_routes(business_id, id),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX wholesale_beats_name ON wholesale_beats(business_id, route_id, lower(name));

-- Each customer sits on at most one beat; orders default to it.
CREATE TABLE wholesale_customer_beats (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  beat_id BIGINT NOT NULL,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, beat_id) REFERENCES wholesale_beats(business_id, id)
);
CREATE INDEX wholesale_customer_beats_beat ON wholesale_customer_beats(business_id, beat_id);
CREATE TRIGGER wholesale_customer_beats_customer BEFORE INSERT OR UPDATE OF contact_id ON wholesale_customer_beats
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A sales order. Prices are fixed when it is taken (the customer's own price
-- and the slab its quantity reaches); every dispatch invoices at those prices.
CREATE TABLE wholesale_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  order_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  -- The godown that dispatches it.
  location_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  contact_name VARCHAR(150) NOT NULL,
  salesperson_id BIGINT,
  route_id BIGINT,
  beat_id BIGINT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'part_dispatched', 'dispatched', 'closed', 'cancelled')),
  expected_on DATE,
  notes VARCHAR(500),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('exclusive', 'inclusive')),
  subtotal NUMERIC(16,2) NOT NULL CHECK (subtotal >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  total NUMERIC(16,2) NOT NULL CHECK (total = subtotal + tax),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(300),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id),
  FOREIGN KEY (business_id, route_id) REFERENCES wholesale_routes(business_id, id),
  FOREIGN KEY (business_id, beat_id) REFERENCES wholesale_beats(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_no),
  UNIQUE (business_id, request_key),
  -- Closed (short) and cancelled orders say who closed them, when and why.
  CHECK ((status IN ('closed', 'cancelled')) = (closed_at IS NOT NULL)),
  CHECK ((status IN ('closed', 'cancelled')) = (closed_by IS NOT NULL)),
  CHECK (status NOT IN ('closed', 'cancelled') OR close_reason IS NOT NULL)
);
CREATE INDEX wholesale_orders_period ON wholesale_orders(business_id, created_at DESC);
CREATE INDEX wholesale_orders_open ON wholesale_orders(business_id, contact_id) WHERE status IN ('open', 'part_dispatched');
CREATE TRIGGER wholesale_orders_customer BEFORE INSERT OR UPDATE OF contact_id ON wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

CREATE TABLE wholesale_order_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  -- In the item's stock unit.
  unit TEXT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  -- Price of one stock unit, to four places (a pack price divided by the pack).
  unit_price NUMERIC(14,4) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate BETWEEN 0 AND 100),
  net NUMERIC(16,2) NOT NULL CHECK (net >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  price_rule_id BIGINT,
  -- What was typed when ordered in a pack (3 cases): all four or none.
  entered_unit VARCHAR(20),
  entered_quantity NUMERIC(16,3) CHECK (entered_quantity > 0),
  entered_unit_price NUMERIC(14,2) CHECK (entered_unit_price >= 0),
  unit_factor NUMERIC(18,6) CHECK (unit_factor > 0),
  -- Progress (stock units): what has gone out, and what was closed short.
  dispatched_quantity NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (dispatched_quantity >= 0),
  closed_quantity NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (closed_quantity >= 0),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, price_rule_id) REFERENCES business_price_rules(business_id, id),
  UNIQUE (business_id, id),
  CHECK (dispatched_quantity + closed_quantity <= quantity),
  CHECK ((entered_unit IS NULL AND entered_quantity IS NULL AND entered_unit_price IS NULL AND unit_factor IS NULL) OR
         (entered_unit IS NOT NULL AND entered_quantity IS NOT NULL AND entered_unit_price IS NOT NULL AND unit_factor IS NOT NULL))
);
CREATE INDEX wholesale_order_lines_order ON wholesale_order_lines(business_id, order_id);

-- An order line is a snapshot: only its progress may change, and it is never deleted.
CREATE FUNCTION wholesale_order_lines_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Order lines are kept; cancel or close the order instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'dispatched_quantity' - 'closed_quantity') <> (to_jsonb(OLD) - 'dispatched_quantity' - 'closed_quantity') THEN
    RAISE EXCEPTION 'An order line keeps what was ordered; only its dispatched and closed quantities change' USING ERRCODE = '23514';
  END IF;
  IF NEW.dispatched_quantity < OLD.dispatched_quantity OR NEW.closed_quantity < OLD.closed_quantity THEN
    RAISE EXCEPTION 'Dispatched and closed quantities only ever grow' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wholesale_order_lines_snapshot BEFORE UPDATE OR DELETE ON wholesale_order_lines
  FOR EACH ROW EXECUTE FUNCTION wholesale_order_lines_snapshot();

-- One dispatch = one tax invoice (a sale in business_documents).
CREATE TABLE wholesale_dispatches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  vehicle_no VARCHAR(20),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX wholesale_dispatches_order ON wholesale_dispatches(business_id, order_id);

CREATE TABLE wholesale_dispatch_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  dispatch_id BIGINT NOT NULL,
  order_line_id BIGINT NOT NULL,
  -- The invoice line it became (one per batch picked).
  document_line_id BIGINT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  FOREIGN KEY (business_id, dispatch_id) REFERENCES wholesale_dispatches(business_id, id),
  FOREIGN KEY (business_id, order_line_id) REFERENCES wholesale_order_lines(business_id, id),
  FOREIGN KEY (business_id, document_line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, document_line_id)
);
CREATE INDEX wholesale_dispatch_lines_order_line ON wholesale_dispatch_lines(business_id, order_line_id);

-- The salesperson and route a collection was made on (wholesale extra on
-- the shared business_collections).
CREATE TABLE wholesale_collection_details (
  business_id BIGINT NOT NULL,
  collection_id BIGINT NOT NULL,
  salesperson_id BIGINT,
  route_id BIGINT,
  PRIMARY KEY (business_id, collection_id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, salesperson_id) REFERENCES wholesale_salespeople(business_id, id),
  FOREIGN KEY (business_id, route_id) REFERENCES wholesale_routes(business_id, id),
  CHECK (salesperson_id IS NOT NULL OR route_id IS NOT NULL)
);

-- Down Migration
DROP TABLE wholesale_collection_details, wholesale_dispatch_lines, wholesale_dispatches;
DROP TRIGGER wholesale_order_lines_snapshot ON wholesale_order_lines;
DROP FUNCTION wholesale_order_lines_snapshot();
DROP TABLE wholesale_order_lines, wholesale_orders, wholesale_customer_beats, wholesale_beats, wholesale_routes, wholesale_salespeople;
DROP INDEX business_price_threshold;
ALTER TABLE business_price_rules DROP CONSTRAINT business_price_rules_pack_fkey, DROP COLUMN unit_code;
CREATE UNIQUE INDEX business_price_threshold ON business_price_rules(business_id, sku_id, COALESCE(contact_id, 0), minimum_quantity) WHERE active;
DELETE FROM business_capabilities WHERE capability = 'sales_orders';
DELETE FROM business_role_permissions WHERE permission_code LIKE 'sales_orders.%';
DELETE FROM business_role_template_permissions WHERE permission_code LIKE 'sales_orders.%';
DELETE FROM business_permissions WHERE module_code = 'sales_orders';
DELETE FROM platform_module_business_types WHERE module_code = 'sales_orders';
DELETE FROM platform_module_dependencies WHERE module_code = 'sales_orders';
DELETE FROM platform_modules WHERE code = 'sales_orders';
