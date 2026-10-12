-- Up Migration
-- Round 2, builder R2-WS (8 Oct 2026). Wholesale / FMCG and two restaurant
-- items. Everything here is additive.
--
--   1. Purchase orders to suppliers (the company or the super-stockist):
--      raised from reorder suggestions or back-orders, sent / printed,
--      received in parts. Each receipt is an ordinary core purchase
--      (business_documents kind 'purchase'): stock, payables, GST and the
--      supplier's ledger work exactly as for any purchase. The order only
--      remembers what it asked for and what has come in against it.
--   2. Delivery challan: its own number series per location and financial
--      year (kind 'delivery_challan'), one number per dispatch.
--   3. Free-goods schemes: the free goods may be another item ("buy 5 cases
--      of A, get 1 of B"), and a scheme may refuse to stack on a slab price.
--   4. Bounced cheques: the bank charge (default Rs 500, editable on each
--      bounce) and the credit hold after N bounces in a window (default 2 in
--      90 days) are business settings.
--   5. Restaurant: an advance taken on a pickup (takeaway ordered ahead)
--      order remembers that order, so the bill offers it first.

-- --- 1, 2. Number series kinds ------------------------------------------------------

DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'purchase_order' = ANY(kinds) THEN kinds := array_append(kinds, 'purchase_order'::text); END IF;
  IF NOT 'delivery_challan' = ANY(kinds) THEN kinds := array_append(kinds, 'delivery_challan'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- --- 1. Purchase orders ------------------------------------------------------------------

CREATE TABLE wholesale_purchase_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  po_no VARCHAR(40) NOT NULL,
  series_id BIGINT,
  -- The godown the goods are to come into.
  location_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  contact_name VARCHAR(150) NOT NULL,
  -- draft: raised, not yet sent · sent: with the supplier · part_received ·
  -- received: everything came · closed: the rest will not come (short) ·
  -- cancelled: nothing came and nothing will.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'part_received', 'received', 'closed', 'cancelled')),
  expected_on DATE,
  notes VARCHAR(500),
  -- What the order is worth at the costs asked for (an estimate: the
  -- supplier's bill, entered on each receipt, is what is owed).
  subtotal NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (total = subtotal + tax),
  sent_at TIMESTAMPTZ,
  sent_by BIGINT REFERENCES users(id),
  -- How it went: email, WhatsApp, printed and handed over, phoned.
  sent_via VARCHAR(30),
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  close_reason VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, po_no),
  UNIQUE (business_id, request_key),
  CHECK (status NOT IN ('sent', 'part_received', 'received') OR sent_at IS NOT NULL),
  CHECK (status NOT IN ('closed', 'cancelled') OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);
CREATE INDEX wholesale_purchase_orders_period ON wholesale_purchase_orders(business_id, created_at DESC);
CREATE INDEX wholesale_purchase_orders_open ON wholesale_purchase_orders(business_id, contact_id) WHERE status IN ('draft', 'sent', 'part_received');
CREATE TRIGGER wholesale_purchase_orders_supplier BEFORE INSERT OR UPDATE OF contact_id ON wholesale_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_supplier();
CREATE TRIGGER wholesale_purchase_orders_updated_at BEFORE UPDATE ON wholesale_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE wholesale_purchase_order_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  po_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  -- Quantities in the item's stock unit; the pack it was asked in (cases) is kept to print.
  unit TEXT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  entered_unit VARCHAR(20),
  entered_quantity NUMERIC(16,3) CHECK (entered_quantity > 0),
  unit_factor NUMERIC(16,6) CHECK (unit_factor > 0),
  -- Cost of one stock unit before GST, as asked (the last purchase price by default).
  unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate BETWEEN 0 AND 100),
  net NUMERIC(16,2) NOT NULL CHECK (net >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  received_quantity NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  -- What will not come (the order was closed short, or the line dropped).
  closed_quantity NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (closed_quantity >= 0),
  -- Why it is on the order: typed in, a reorder suggestion, or customers' back-orders.
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'reorder', 'back_order')),
  FOREIGN KEY (business_id, po_id) REFERENCES wholesale_purchase_orders(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  -- A supplier may send a little over what was asked; the excess is not "received" on the order.
  CHECK (received_quantity + closed_quantity <= quantity),
  CHECK ((entered_unit IS NULL) = (entered_quantity IS NULL) AND (entered_unit IS NULL) = (unit_factor IS NULL))
);
CREATE INDEX wholesale_purchase_order_lines_po ON wholesale_purchase_order_lines(business_id, po_id);
CREATE INDEX wholesale_purchase_order_lines_sku ON wholesale_purchase_order_lines(business_id, sku_id);

-- Each receipt against an order is one core purchase (a goods receipt with the supplier's bill).
CREATE TABLE wholesale_purchase_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  po_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, po_id) REFERENCES wholesale_purchase_orders(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, document_id)
);
CREATE INDEX wholesale_purchase_receipts_po ON wholesale_purchase_receipts(business_id, po_id);
CREATE TABLE wholesale_purchase_receipt_lines (
  business_id BIGINT NOT NULL,
  receipt_id BIGINT NOT NULL,
  po_line_id BIGINT NOT NULL,
  document_line_id BIGINT NOT NULL,
  -- What counts against the order line (at most what was still to come).
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (business_id, document_line_id),
  FOREIGN KEY (business_id, receipt_id) REFERENCES wholesale_purchase_receipts(business_id, id),
  FOREIGN KEY (business_id, po_line_id) REFERENCES wholesale_purchase_order_lines(business_id, id)
);
CREATE INDEX wholesale_purchase_receipt_lines_line ON wholesale_purchase_receipt_lines(business_id, po_line_id);

-- Receipts are history: never changed or removed (only the time stamp may be
-- corrected: the demo set-up spreads sample records over past days).
CREATE FUNCTION wholesale_purchase_receipts_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'created_at') = (to_jsonb(OLD) - 'created_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A receipt against a purchase order cannot be changed or deleted' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER wholesale_purchase_receipts_fixed BEFORE UPDATE OR DELETE ON wholesale_purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION wholesale_purchase_receipts_fixed();
CREATE TRIGGER wholesale_purchase_receipt_lines_fixed BEFORE UPDATE OR DELETE ON wholesale_purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION wholesale_purchase_receipts_fixed();

-- --- 2. Delivery challan ---------------------------------------------------------------

-- One challan number per dispatch, from the location's 'delivery_challan'
-- series for the financial year. Dispatches made before this pass get theirs
-- when the challan is first printed.
ALTER TABLE wholesale_dispatches
  ADD COLUMN challan_no VARCHAR(40),
  ADD COLUMN challan_series_id BIGINT;
CREATE UNIQUE INDEX wholesale_dispatches_challan ON wholesale_dispatches(business_id, challan_no) WHERE challan_no IS NOT NULL;

-- --- 3. Free-goods schemes ----------------------------------------------------------------

ALTER TABLE wholesale_schemes
  -- The free goods: another item ("buy 5 cases of A, get 1 of B"); NULL = the same item.
  ADD COLUMN free_sku_id BIGINT,
  -- The pack the free quantity counts in (NULL = the free item's stock unit,
  -- or the scheme's own pack when the free goods are the same item).
  ADD COLUMN free_unit_code VARCHAR(20),
  -- "Don't combine with slab price": when the scheme applies, the line is
  -- priced without quantity slabs (customer price, group base price or list).
  ADD COLUMN no_slab BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT wholesale_schemes_free_sku_fkey FOREIGN KEY (business_id, free_sku_id) REFERENCES catalog_skus(business_id, id),
  ADD CONSTRAINT wholesale_schemes_free_unit_fkey FOREIGN KEY (business_id, free_sku_id, free_unit_code) REFERENCES catalog_sku_units(business_id, sku_id, unit_code),
  ADD CONSTRAINT wholesale_schemes_free_item CHECK (free_sku_id IS NULL OR free_quantity > 0),
  ADD CONSTRAINT wholesale_schemes_free_unit CHECK (free_unit_code IS NULL OR free_sku_id IS NOT NULL);
CREATE INDEX wholesale_order_lines_scheme ON wholesale_order_lines(business_id, scheme_id) WHERE scheme_id IS NOT NULL;

-- --- 4. Bounced cheques: business settings ------------------------------------------------------

ALTER TABLE wholesale_settings
  -- The bank's charge put on the customer's account for a bounced cheque (editable on each bounce).
  ADD COLUMN bounce_charge NUMERIC(16,2) NOT NULL DEFAULT 500 CHECK (bounce_charge BETWEEN 0 AND 100000),
  -- Hold new orders after this many bounced cheques in the window (NULL = never).
  ADD COLUMN bounce_hold_count SMALLINT DEFAULT 2 CHECK (bounce_hold_count BETWEEN 1 AND 20),
  ADD COLUMN bounce_hold_days SMALLINT NOT NULL DEFAULT 90 CHECK (bounce_hold_days BETWEEN 7 AND 365);

-- --- 5. Restaurant: advance on a pickup order --------------------------------------------------

ALTER TABLE customer_advances ADD COLUMN order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX idx_customer_advances_order ON customer_advances (restaurant_id, order_id) WHERE order_id IS NOT NULL;

-- The order is the same restaurant's, so an advance never points at another tenant's order.
CREATE FUNCTION customer_advances_order_same_restaurant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND restaurant_id = NEW.restaurant_id) THEN
    RAISE EXCEPTION 'That order belongs to another restaurant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_customer_advances_order BEFORE INSERT OR UPDATE OF order_id ON customer_advances
  FOR EACH ROW EXECUTE FUNCTION customer_advances_order_same_restaurant();

-- Down Migration

DROP TRIGGER trg_customer_advances_order ON customer_advances;
DROP FUNCTION customer_advances_order_same_restaurant();
DROP INDEX idx_customer_advances_order;
ALTER TABLE customer_advances DROP COLUMN order_id;

ALTER TABLE wholesale_settings DROP COLUMN bounce_charge, DROP COLUMN bounce_hold_count, DROP COLUMN bounce_hold_days;

DROP INDEX wholesale_order_lines_scheme;
ALTER TABLE wholesale_schemes DROP CONSTRAINT wholesale_schemes_free_unit, DROP CONSTRAINT wholesale_schemes_free_item,
  DROP CONSTRAINT wholesale_schemes_free_unit_fkey, DROP CONSTRAINT wholesale_schemes_free_sku_fkey,
  DROP COLUMN no_slab, DROP COLUMN free_unit_code, DROP COLUMN free_sku_id;

DROP INDEX wholesale_dispatches_challan;
ALTER TABLE wholesale_dispatches DROP COLUMN challan_series_id, DROP COLUMN challan_no;

DROP TABLE wholesale_purchase_receipt_lines;
DROP TABLE wholesale_purchase_receipts;
DROP FUNCTION wholesale_purchase_receipts_fixed();
DROP TABLE wholesale_purchase_order_lines;
DROP TABLE wholesale_purchase_orders;

DELETE FROM business_number_series WHERE document_kind IN ('purchase_order', 'delivery_challan');
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(array_remove(kinds, 'purchase_order'), 'delivery_challan');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
