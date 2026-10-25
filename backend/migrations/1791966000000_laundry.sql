-- Up Migration
-- A laundry's and dry cleaner's own tools: the price list of garments and
-- services, garment orders taken in at the counter with a tag on every
-- garment and what was noted about it, the work from received to ready on a
-- rack and handed over, the bill through the core at intake or at delivery,
-- orders ready and not collected with the reminders sent, and damage claims
-- settled through the core's credit notes and refunds.
--
-- Garment orders (module "laundry", on for type "laundry"):
--   laundry_settings        when an order is billed (when its garments are
--                           delivered, until changed, or when it is taken
--                           in), what a handover of part of an order needs
--                           paid (the whole order, until changed, or the
--                           garments handed over), the express surcharge (a
--                           percentage of each garment's price: none until
--                           set), the days to the promised day, the days
--                           after which a ready order is listed as unclaimed
--                           (30 until changed), the shop's terms printed on
--                           every receipt, and the last tag number given.
--   laundry_services        each service the shop offers (wash and fold, wash
--                           and iron, dry cleaning, steam press, stain
--                           removal), billed as a service item of the
--                           catalogue: its name on the bill, its GST slab and
--                           its SAC come from the item (laundry, dry cleaning,
--                           pressing and dyeing are in SAC group 99971, at 18%
--                           with input tax credit). Switched off, never deleted.
--   laundry_garment_types   each kind of garment taken in (shirt, saree, a
--                           two-piece suit, a blanket, shoes) and how one is
--                           counted: a piece, a pair (two pieces) or a set of
--                           pieces. Switched off, never deleted.
--   laundry_prices          the price list: a garment and a service at a price
--                           for each one (piece, pair or set) or by the kilo.
--                           A price changes in place; every change is in the
--                           activity log, and an order keeps the prices it was
--                           taken in at.
--   laundry_orders          a garment order (LO/2627/0001): the customer as
--                           they were, the promised day, express or not with
--                           its surcharge as it was, the rules it was taken in
--                           under (billed at intake or at delivery, what a
--                           part handover needs paid), its figures as priced
--                           then, the terms printed on its receipt, and the
--                           advance (a collection receipt: the customer's
--                           money on account) or the bill made at intake. Its
--                           status is worked out from its garments.
--   laundry_order_items     each garment (or a bundle priced by the kilo, with
--                           its weight and its pieces counted): its tag (one
--                           garment in the shop holds a tag at a time), the
--                           garment and service as they were, how many and its
--                           price, the express surcharge and GST as priced,
--                           its colour and brand, the defects noted at intake,
--                           the customer's instructions, what the customer was
--                           told about the risk to it and whether they
--                           acknowledged it (a record, never a limit on what a
--                           claim may be), a value they declared, its status
--                           from received through in process to ready on a
--                           rack and delivered, or cancelled with a reason,
--                           and the bill line that charges it.
--   laundry_deliveries      each handover of garments: the bill it posted (when
--                           billed at delivery), whether money still owed went
--                           on the customer's account, who collected.
--   laundry_delivery_items  the garments of each handover.
--   laundry_order_events    everything that happened to an order and its
--                           garments, as it was written.
--   laundry_notices         each message or call to the customer: taken in,
--                           ready, running late, or a reminder to collect.
--   laundry_claims          a damage claim on a garment: what is wrong, what the
--                           customer asks, and a manager's decision: money back
--                           for the garment's charge (a credit note on its bill
--                           line and a refund through the core), a credit note
--                           only, the work done again, or rejected with a note.
-- A garment order is held until paid as the order's rule says, unless the
-- customer has an account with the shop (credit days or a credit limit on
-- their record): a bailee who has done work on goods may keep them until paid
-- (Indian Contract Act, section 170), and agreed credit sets that aside. Nothing
-- here disposes of a garment that is not collected: the unclaimed list keeps
-- the reminders sent. A bill line that charges a garment is credited only from
-- the order (a cancelled garment, or a damage claim). The advance on an order
-- cancelled before it is billed is handed back from the order
-- (business_collection_refunds source "laundry").

-- --- Module, permissions and roles ------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('laundry', 'Garment orders', 'Garment orders taken in with a tag on every garment, its defects and what the customer acknowledged; a price list by garment and service, for each piece, pair or set or by the kilo, with an express surcharge; the work from received to ready on a rack and handed over, billed at intake or at delivery; orders not collected and the reminders sent; damage claims settled with a credit note or a refund.', 'optional', 238);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('laundry', 'catalog'), ('laundry', 'contacts'), ('laundry', 'sales');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('laundry', 'laundry', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('laundry', 'view', 'See garment orders, the racks, orders not collected, damage claims and the price list', 520),
 ('laundry', 'create', 'Take in garment orders at the counter', 521),
 ('laundry', 'edit', 'Move garments through the work and onto the racks, hand them over, and record damage claims', 522),
 ('laundry', 'cancel', 'Cancel garments on an order, or a whole order', 523),
 ('laundry', 'print', 'Print order receipts and tag labels', 524),
 ('laundry', 'refund', 'Decide damage claims, and give money back for them and for cancelled garments', 525)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'laundry'
UNION ALL SELECT 'cashier', unnest(ARRAY['laundry.view', 'laundry.create', 'laundry.edit', 'laundry.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['laundry.view', 'laundry.edit'])
UNION ALL SELECT 'accountant', unnest(ARRAY['laundry.view', 'laundry.print'])
UNION ALL SELECT 'viewer', unnest(ARRAY['laundry.view']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'laundry'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;

-- Existing laundries get the tool a new one starts with (where what it needs is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'laundry'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Garment orders are numbered (LO/2627/0001). The kinds list is widened by
-- reading the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'laundry_order' = ANY(kinds) THEN kinds := array_append(kinds, 'laundry_order'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- The advance on a garment order cancelled before it is billed is handed back from the order.
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical', 'garage', 'laundry'));

-- History is kept as it was written.
CREATE FUNCTION laundry_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'laundry_order_events' THEN
    RAISE EXCEPTION 'A garment order''s history is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'laundry_notices' THEN
    RAISE EXCEPTION 'A message to the customer is kept as it was sent' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A handover of garments is kept as it was made' USING ERRCODE = '23514';
END $$;

-- --- Settings ------------------------------------------------------------------------------------

-- One row per business, made when the settings are first saved or the first tag is given.
CREATE TABLE laundry_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- When an order is billed: when its garments are delivered, or when it is taken in.
  bill_at TEXT NOT NULL DEFAULT 'delivery' CHECK (bill_at IN ('delivery', 'intake')),
  -- What a handover of part of an order needs paid: the whole order, or the garments handed over.
  part_delivery TEXT NOT NULL DEFAULT 'whole_order' CHECK (part_delivery IN ('whole_order', 'garments')),
  -- An express order's surcharge on each garment's price, as a percentage.
  express_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (express_percent BETWEEN 0 AND 200),
  -- Days from intake to the promised day: an order, and an express one.
  ready_days SMALLINT NOT NULL DEFAULT 3 CHECK (ready_days BETWEEN 0 AND 60),
  express_days SMALLINT NOT NULL DEFAULT 1 CHECK (express_days BETWEEN 0 AND 60),
  -- An order ready for this many days and not collected is listed as unclaimed.
  unclaimed_days SMALLINT NOT NULL DEFAULT 30 CHECK (unclaimed_days BETWEEN 1 AND 365),
  -- The shop's own terms, printed on every order receipt.
  receipt_terms VARCHAR(2000) CHECK (btrim(receipt_terms) <> ''),
  -- The last tag number given (tags are numbered 1, 2, 3 … unless typed).
  last_tag_no INTEGER NOT NULL DEFAULT 0 CHECK (last_tag_no >= 0),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- The price list --------------------------------------------------------------------------------

CREATE TABLE laundry_services (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The service item it is billed as: its name on the bill, GST slab and SAC.
  sku_id BIGINT NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku_id)
);

-- A service is billed as a service item of this business (not goods, not a
-- kit), keeps its item and is never deleted.
CREATE FUNCTION laundry_services_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A laundry service is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.sku_id <> OLD.sku_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'A laundry service keeps the item it is billed as' USING ERRCODE = '23514';
  END IF;
  SELECT p.kind, s.is_kit, s.label INTO item FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
  WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
  IF item.kind IS DISTINCT FROM 'service' OR item.is_kit THEN
    RAISE EXCEPTION 'A laundry service is billed as a service item of this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_services_check BEFORE INSERT OR UPDATE OR DELETE ON laundry_services
  FOR EACH ROW EXECUTE FUNCTION laundry_services_check();

CREATE TABLE laundry_garment_types (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  -- How one is counted: a piece, a pair (two pieces) or a set of pieces (a suit, a bedsheet set).
  counted_as TEXT NOT NULL DEFAULT 'piece' CHECK (counted_as IN ('piece', 'pair', 'set')),
  pieces SMALLINT NOT NULL DEFAULT 1 CHECK (pieces BETWEEN 1 AND 20),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK (counted_as <> 'piece' OR pieces = 1),
  CHECK (counted_as <> 'pair' OR pieces = 2),
  CHECK (counted_as <> 'set' OR pieces >= 2)
);
CREATE UNIQUE INDEX laundry_garment_types_name ON laundry_garment_types(business_id, lower(name));

CREATE FUNCTION laundry_garment_types_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment of the price list is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A garment of the price list keeps who added it and when' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_garment_types_guard BEFORE UPDATE OR DELETE ON laundry_garment_types
  FOR EACH ROW EXECUTE FUNCTION laundry_garment_types_guard();

-- A garment and a service at a price: for each one (as the garment is counted) or by the kilo.
CREATE TABLE laundry_prices (
  business_id BIGINT NOT NULL,
  garment_type_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  per TEXT NOT NULL CHECK (per IN ('item', 'kg')),
  price NUMERIC(14,2) NOT NULL CHECK (price > 0),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, garment_type_id, service_id),
  FOREIGN KEY (business_id, garment_type_id) REFERENCES laundry_garment_types(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES laundry_services(business_id, id)
);
CREATE INDEX laundry_prices_service ON laundry_prices(business_id, service_id);

-- --- Garment orders ----------------------------------------------------------------------------

CREATE TABLE laundry_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  order_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- The customer's name and phone as they were when the order was taken in.
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_phone VARCHAR(30),
  promised_on DATE NOT NULL,
  -- Express, with the surcharge on each garment as it was set then (none when not express).
  express BOOLEAN NOT NULL DEFAULT FALSE,
  express_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (express_percent BETWEEN 0 AND 200),
  -- The rules it was taken in under.
  bill_at TEXT NOT NULL CHECK (bill_at IN ('delivery', 'intake')),
  part_delivery TEXT NOT NULL CHECK (part_delivery IN ('whole_order', 'garments')),
  -- As priced when taken in, as one bill of every garment would be then.
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  subtotal NUMERIC(16,2) NOT NULL CHECK (subtotal >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  round_off NUMERIC(16,2) NOT NULL CHECK (round_off > -1 AND round_off < 1),
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  -- The shop's terms printed on the receipt, as they were then.
  terms VARCHAR(2000),
  notes VARCHAR(500),
  -- Billed at delivery: the advance taken at intake (a collection receipt). Billed at intake: the bill.
  advance_collection_id BIGINT,
  document_id BIGINT,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, advance_collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, advance_collection_id),
  CHECK (total = subtotal + tax + round_off),
  CHECK (express OR express_percent = 0),
  CHECK ((bill_at = 'intake') = (document_id IS NOT NULL)),
  CHECK (advance_collection_id IS NULL OR bill_at = 'delivery')
);
CREATE INDEX laundry_orders_period ON laundry_orders(business_id, created_at DESC);
CREATE INDEX laundry_orders_contact ON laundry_orders(business_id, contact_id);
CREATE INDEX laundry_orders_promised ON laundry_orders(business_id, promised_on);
CREATE TRIGGER laundry_orders_customer BEFORE INSERT ON laundry_orders
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- An order keeps its number, customer, rules, prices, terms and bill or
-- advance as it was taken in; only its promised day and notes change. It is
-- never deleted.
CREATE FUNCTION laundry_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment order is never deleted; cancel its garments instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['promised_on', 'notes', 'updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['promised_on', 'notes', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'A garment order keeps its number, customer, rules, prices and terms as it was taken in' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_orders_guard BEFORE UPDATE OR DELETE ON laundry_orders
  FOR EACH ROW EXECUTE FUNCTION laundry_orders_guard();

CREATE TABLE laundry_order_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  -- Its place on the order (1, 2, 3 …).
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 200),
  -- The tag on the garment, as printed or as already on it (letters, digits, / and -).
  tag_no VARCHAR(20) NOT NULL CHECK (tag_no ~ '^[A-Z0-9][A-Z0-9/-]{0,19}$'),
  garment_type_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  -- As they were when taken in: the garment and the service, the item it is billed as, how one is counted.
  garment_name VARCHAR(80) NOT NULL,
  service_name VARCHAR(150) NOT NULL,
  sku_id BIGINT NOT NULL,
  counted_as TEXT NOT NULL CHECK (counted_as IN ('piece', 'pair', 'set')),
  -- Priced for each one (how many, whole) or by the kilo (how many kilos), with the pieces counted.
  per TEXT NOT NULL CHECK (per IN ('item', 'kg')),
  quantity NUMERIC(10,3) NOT NULL CHECK (quantity > 0 AND quantity < 1000),
  pieces SMALLINT NOT NULL CHECK (pieces BETWEEN 1 AND 999),
  -- The price of one (or of a kilo), the line at it, the express surcharge
  -- and the two together (in the order's price terms), and its GST as priced.
  rate NUMERIC(14,2) NOT NULL CHECK (rate > 0),
  base NUMERIC(14,2) NOT NULL CHECK (base > 0),
  surcharge NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate BETWEEN 0 AND 100),
  net NUMERIC(14,2) NOT NULL CHECK (net >= 0),
  tax NUMERIC(14,2) NOT NULL CHECK (tax >= 0),
  colour VARCHAR(40) CHECK (btrim(colour) <> ''),
  brand VARCHAR(60) CHECK (btrim(brand) <> ''),
  -- Noted at intake: its defects, a note on them, the customer's instructions,
  -- what the customer was told about the risk to it and whether they
  -- acknowledged it, and a value they declared.
  defects TEXT[] NOT NULL DEFAULT '{}'
    CHECK (defects <@ ARRAY['stain', 'tear', 'hole', 'missing_button', 'colour_bleed', 'fading', 'shrinkage', 'burn', 'worn', 'loose_thread']::TEXT[]),
  defect_note VARCHAR(300) CHECK (btrim(defect_note) <> ''),
  instructions VARCHAR(300) CHECK (btrim(instructions) <> ''),
  risk_note VARCHAR(300) CHECK (btrim(risk_note) <> ''),
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  declared_value NUMERIC(14,2) CHECK (declared_value > 0),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_process', 'ready', 'delivered', 'cancelled')),
  -- Where it hangs once ready (rack and slot).
  rack VARCHAR(20) CHECK (rack ~ '^[A-Z0-9][A-Z0-9 /-]{0,19}$'),
  ready_at TIMESTAMPTZ,
  ready_by BIGINT REFERENCES users(id),
  delivered_at TIMESTAMPTZ,
  delivered_by BIGINT REFERENCES users(id),
  cancel_reason VARCHAR(300),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  cancel_key UUID,
  -- The bill line that charges it, and the request key of the credit note on it (a cancellation or a claim).
  document_id BIGINT,
  line_id BIGINT,
  credit_key UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES laundry_orders(business_id, id),
  FOREIGN KEY (business_id, garment_type_id) REFERENCES laundry_garment_types(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES laundry_services(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_id, id),
  UNIQUE (business_id, order_id, seq),
  UNIQUE (business_id, line_id),
  CHECK (per = 'kg' OR quantity = trunc(quantity)),
  CHECK (amount = base + surcharge),
  CHECK (net = amount OR net + tax = amount),
  CHECK (NOT acknowledged OR defects <> '{}' OR defect_note IS NOT NULL OR risk_note IS NOT NULL),
  CHECK (rack IS NULL OR status IN ('ready', 'delivered')),
  CHECK (status NOT IN ('ready', 'delivered') OR ready_at IS NOT NULL),
  CHECK (status NOT IN ('received', 'in_process') OR ready_at IS NULL),
  CHECK ((ready_at IS NULL) = (ready_by IS NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((delivered_at IS NULL) = (delivered_by IS NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (cancel_key IS NULL OR status = 'cancelled'),
  CHECK ((document_id IS NULL) = (line_id IS NULL)),
  CHECK (credit_key IS NULL OR line_id IS NOT NULL)
);
CREATE INDEX laundry_order_items_order ON laundry_order_items(business_id, order_id, seq);
-- A tag is on one garment in the shop at a time.
CREATE UNIQUE INDEX laundry_order_items_open_tag ON laundry_order_items(business_id, tag_no) WHERE status IN ('received', 'in_process', 'ready');
CREATE INDEX laundry_order_items_tag ON laundry_order_items(business_id, tag_no);
CREATE INDEX laundry_order_items_open ON laundry_order_items(business_id, status, ready_at) WHERE status IN ('received', 'in_process', 'ready');
CREATE INDEX laundry_order_items_document ON laundry_order_items(business_id, document_id) WHERE document_id IS NOT NULL;

-- A garment goes on its order when the order is taken in, as received, with
-- nothing delivered, cancelled or credited; it is billed as its service's
-- item and counted as its garment is; a bill line given with it (an order
-- billed at intake) is on the order's own bill, of the garment's item.
CREATE FUNCTION laundry_order_items_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD;
BEGIN
  SELECT order_no, created_at, document_id INTO o FROM laundry_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF o.created_at <> now() THEN
    RAISE EXCEPTION 'Garments go on order % when it is taken in: take in a new order for more', o.order_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'received' OR NEW.ready_at IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.credit_key IS NOT NULL THEN
    RAISE EXCEPTION 'A garment starts as received, with nothing delivered, cancelled or credited' USING ERRCODE = '23514';
  END IF;
  IF NEW.sku_id IS DISTINCT FROM (SELECT sku_id FROM laundry_services WHERE business_id = NEW.business_id AND id = NEW.service_id) THEN
    RAISE EXCEPTION 'A garment is billed as the item of its service' USING ERRCODE = '23514';
  END IF;
  IF NEW.counted_as IS DISTINCT FROM (SELECT counted_as FROM laundry_garment_types WHERE business_id = NEW.business_id AND id = NEW.garment_type_id) THEN
    RAISE EXCEPTION 'A garment is counted as its kind of garment is' USING ERRCODE = '23514';
  END IF;
  IF (o.document_id IS NULL) <> (NEW.line_id IS NULL) OR (NEW.line_id IS NOT NULL AND (NEW.document_id IS DISTINCT FROM o.document_id
     OR NOT EXISTS (SELECT 1 FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.line_id AND document_id = NEW.document_id AND sku_id = NEW.sku_id))) THEN
    RAISE EXCEPTION 'A garment of an order billed at intake is on a line of the order''s own bill, of its own item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_order_items_insert_check BEFORE INSERT ON laundry_order_items
  FOR EACH ROW EXECUTE FUNCTION laundry_order_items_insert_check();

-- A garment keeps what was noted and priced when it was taken in, and is
-- never deleted. It moves one allowed step at a time: received to in process
-- or straight to ready; in process to ready; ready back into the work or
-- handed over (with its bill line, in a handover made now); a delivered one
-- back into the work only for reprocessing under a damage claim decided now;
-- any garment in the shop cancelled (a billed one once its bill line is
-- credited). Its bill line and the key of the credit note on it are given
-- once; it is re-tagged only while it is in the shop.
CREATE FUNCTION laundry_order_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment on an order is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['tag_no', 'status', 'rack', 'ready_at', 'ready_by', 'delivered_at', 'delivered_by', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'cancel_key',
        'document_id', 'line_id', 'credit_key'])
     <> (to_jsonb(OLD) - ARRAY['tag_no', 'status', 'rack', 'ready_at', 'ready_by', 'delivered_at', 'delivered_by', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'cancel_key',
        'document_id', 'line_id', 'credit_key']) THEN
    RAISE EXCEPTION 'A garment keeps what was noted and priced when it was taken in' USING ERRCODE = '23514';
  END IF;
  SELECT order_no, contact_id INTO o FROM laundry_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Garment % on order % was cancelled and no longer changes', OLD.tag_no, o.order_no USING ERRCODE = '23514';
  END IF;
  IF OLD.line_id IS NOT NULL AND (NEW.line_id IS DISTINCT FROM OLD.line_id OR NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
    RAISE EXCEPTION 'Garment % keeps the bill line that charges it', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.credit_key IS NOT NULL AND NEW.credit_key IS DISTINCT FROM OLD.credit_key THEN
    RAISE EXCEPTION 'Garment % is credited once', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.tag_no <> OLD.tag_no AND NOT (OLD.status IN ('received', 'in_process', 'ready') OR (OLD.status = 'delivered' AND NEW.status = 'received')) THEN
    RAISE EXCEPTION 'A garment is re-tagged only while it is in the shop' USING ERRCODE = '23514';
  END IF;
  IF NEW.line_id IS NOT NULL AND OLD.line_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
       WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id AND l.sku_id = NEW.sku_id
         AND d.kind = 'sale' AND d.contact_id = o.contact_id) THEN
    RAISE EXCEPTION 'Garment % is billed on a line of its own item, on a bill to the order''s customer', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'received' AND NEW.status IN ('in_process', 'ready', 'cancelled'))
    OR (OLD.status = 'in_process' AND NEW.status IN ('ready', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('in_process', 'delivered', 'cancelled'))
    OR (OLD.status = 'delivered' AND NEW.status = 'received')) THEN
    RAISE EXCEPTION 'Garment % cannot go from % to %', OLD.tag_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'delivered' AND OLD.status <> 'delivered' THEN
    IF NEW.line_id IS NULL THEN
      RAISE EXCEPTION 'Garment % is handed over with its bill', OLD.tag_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM laundry_delivery_items di JOIN laundry_deliveries d ON d.business_id = di.business_id AND d.id = di.delivery_id
                   WHERE di.business_id = NEW.business_id AND di.item_id = NEW.id AND d.created_at = now()) THEN
      RAISE EXCEPTION 'Garment % is handed over in a handover of its order', OLD.tag_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'delivered' AND NEW.status = 'received' AND NOT EXISTS (
       SELECT 1 FROM laundry_claims WHERE business_id = NEW.business_id AND item_id = NEW.id AND decision = 'reprocess' AND decided_at = now()) THEN
    RAISE EXCEPTION 'A delivered garment comes back into the work only for reprocessing under a damage claim' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.line_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM business_return_lines WHERE business_id = NEW.business_id AND line_id = NEW.line_id) THEN
    RAISE EXCEPTION 'Garment % is billed: it is cancelled with a credit note on its bill line', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_order_items_guard BEFORE UPDATE OR DELETE ON laundry_order_items
  FOR EACH ROW EXECUTE FUNCTION laundry_order_items_guard();

-- A bill line that charges a garment is credited only from its order: the
-- garment cancelled, or a damage claim on it settled with money or a credit.
CREATE FUNCTION laundry_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item RECORD; credit_note UUID;
BEGIN
  SELECT i.tag_no, i.credit_key, o.order_no INTO item FROM laundry_order_items i JOIN laundry_orders o ON o.business_id = i.business_id AND o.id = i.order_id
  WHERE i.business_id = NEW.business_id AND i.line_id = NEW.line_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT request_key INTO credit_note FROM business_returns WHERE business_id = NEW.business_id AND id = NEW.return_id;
  IF item.credit_key IS DISTINCT FROM credit_note THEN
    RAISE EXCEPTION 'This line bills garment % of laundry order %. It is credited from the order: cancel the garment there, or settle a damage claim on it.',
      item.tag_no, item.order_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_return_lines_laundry BEFORE INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION laundry_line_return();

-- --- Handovers -----------------------------------------------------------------------------------

CREATE TABLE laundry_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  -- The bill posted with this handover (billed at delivery), if any.
  document_id BIGINT,
  -- Money still owed went on the customer's account (credit agreed with them).
  on_account BOOLEAN NOT NULL DEFAULT FALSE,
  -- Who collected the garments, when not the customer.
  collected_by VARCHAR(150) CHECK (btrim(collected_by) <> ''),
  note VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES laundry_orders(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id)
);
CREATE INDEX laundry_deliveries_order ON laundry_deliveries(business_id, order_id, id);
CREATE TRIGGER laundry_deliveries_append_only BEFORE UPDATE OR DELETE ON laundry_deliveries
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only();

CREATE TABLE laundry_delivery_items (
  business_id BIGINT NOT NULL,
  delivery_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  PRIMARY KEY (business_id, delivery_id, item_id),
  FOREIGN KEY (business_id, delivery_id) REFERENCES laundry_deliveries(business_id, id),
  FOREIGN KEY (business_id, order_id, item_id) REFERENCES laundry_order_items(business_id, order_id, id)
);
CREATE INDEX laundry_delivery_items_item ON laundry_delivery_items(business_id, item_id);
CREATE TRIGGER laundry_delivery_items_append_only BEFORE UPDATE OR DELETE ON laundry_delivery_items
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only();

-- A handover's garments are of its own order.
CREATE FUNCTION laundry_delivery_items_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM laundry_deliveries WHERE business_id = NEW.business_id AND id = NEW.delivery_id AND order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'A handover is of the garments of its own order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_delivery_items_check BEFORE INSERT ON laundry_delivery_items
  FOR EACH ROW EXECUTE FUNCTION laundry_delivery_items_check();

-- --- History and messages ----------------------------------------------------------------------

-- Everything that happened to an order or one of its garments: a change of
-- status (from and to), or a note with none.
CREATE TABLE laundry_order_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  item_id BIGINT,
  from_status TEXT,
  to_status TEXT,
  note VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES laundry_orders(business_id, id),
  FOREIGN KEY (business_id, order_id, item_id) REFERENCES laundry_order_items(business_id, order_id, id),
  CHECK (to_status IS NOT NULL OR note IS NOT NULL),
  CHECK (from_status IS NULL OR to_status IS NOT NULL)
);
CREATE INDEX laundry_order_events_order ON laundry_order_events(business_id, order_id, id);
CREATE TRIGGER laundry_order_events_append_only BEFORE UPDATE OR DELETE ON laundry_order_events
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only();

-- A message or call to the customer about their order, and how.
CREATE TABLE laundry_notices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('received', 'ready', 'delayed', 'reminder')),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'call', 'sms')),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES laundry_orders(business_id, id)
);
CREATE INDEX laundry_notices_order ON laundry_notices(business_id, order_id, created_at DESC);
CREATE TRIGGER laundry_notices_append_only BEFORE UPDATE OR DELETE ON laundry_notices
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only();

-- --- Damage claims -------------------------------------------------------------------------------

CREATE TABLE laundry_claims (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  issue TEXT NOT NULL CHECK (issue IN ('damage', 'stain', 'shrinkage', 'colour_run', 'lost', 'missing_part', 'other')),
  description VARCHAR(1000) NOT NULL CHECK (btrim(description) <> ''),
  -- What the customer asks for, when they name an amount.
  asked_amount NUMERIC(14,2) CHECK (asked_amount > 0),
  reported_by BIGINT NOT NULL REFERENCES users(id),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  -- A manager's decision: money back for the garment's charge, a credit
  -- note on its bill, the work done again, or rejected (with a note why).
  decision TEXT CHECK (decision IN ('refund', 'credit', 'reprocess', 'rejected')),
  amount NUMERIC(14,2) CHECK (amount > 0),
  decision_note VARCHAR(500) CHECK (btrim(decision_note) <> ''),
  decided_by BIGINT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decide_key UUID,
  decide_hash CHAR(64),
  -- The credit note on the garment's bill line, and the money refunded through the core.
  return_id BIGINT,
  refund_id BIGINT REFERENCES business_refunds(id),
  refunded NUMERIC(16,2) CHECK (refunded > 0),
  FOREIGN KEY (business_id, order_id) REFERENCES laundry_orders(business_id, id),
  FOREIGN KEY (business_id, order_id, item_id) REFERENCES laundry_order_items(business_id, order_id, id),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, decide_key),
  CHECK (decision IS NOT NULL OR (amount IS NULL AND decision_note IS NULL AND return_id IS NULL AND refund_id IS NULL)),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CHECK ((decided_at IS NULL) = (decide_key IS NULL)),
  CHECK ((decide_key IS NULL) = (decide_hash IS NULL)),
  CHECK ((decision IN ('refund', 'credit')) = (amount IS NOT NULL)),
  CHECK ((decision IN ('refund', 'credit')) = (return_id IS NOT NULL)),
  CHECK (refund_id IS NULL OR decision = 'refund'),
  CHECK ((refund_id IS NULL) = (refunded IS NULL)),
  CHECK (decision IS DISTINCT FROM 'rejected' OR decision_note IS NOT NULL)
);
CREATE INDEX laundry_claims_order ON laundry_claims(business_id, order_id, id);
CREATE INDEX laundry_claims_open ON laundry_claims(business_id, reported_at) WHERE decision IS NULL;
-- One claim at a time on a garment is waiting for a decision.
CREATE UNIQUE INDEX laundry_claims_one_open ON laundry_claims(business_id, item_id) WHERE decision IS NULL;

-- A claim is on a garment not cancelled, starts waiting for a decision, is
-- decided once and then never changes; it keeps what was reported, and is
-- never deleted.
CREATE FUNCTION laundry_claims_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A damage claim is never deleted; decide it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO state FROM laundry_order_items WHERE business_id = NEW.business_id AND id = NEW.item_id;
    IF state = 'cancelled' THEN
      RAISE EXCEPTION 'A cancelled garment takes no claim' USING ERRCODE = '23514';
    END IF;
    IF NEW.decision IS NOT NULL THEN
      RAISE EXCEPTION 'A damage claim starts waiting for a manager''s decision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'Claim % was decided and no longer changes', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.order_id <> OLD.order_id OR NEW.item_id <> OLD.item_id OR NEW.issue <> OLD.issue OR NEW.description <> OLD.description
     OR NEW.asked_amount IS DISTINCT FROM OLD.asked_amount OR NEW.reported_by <> OLD.reported_by OR NEW.reported_at <> OLD.reported_at
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash THEN
    RAISE EXCEPTION 'A damage claim keeps what was reported' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_claims_check BEFORE INSERT OR UPDATE OR DELETE ON laundry_claims
  FOR EACH ROW EXECUTE FUNCTION laundry_claims_check();

-- Down Migration
DROP TRIGGER business_return_lines_laundry ON business_return_lines;
DROP TABLE laundry_claims, laundry_notices, laundry_order_events, laundry_delivery_items, laundry_deliveries, laundry_order_items, laundry_orders,
  laundry_prices, laundry_garment_types, laundry_services, laundry_settings;
DROP FUNCTION laundry_claims_check();
DROP FUNCTION laundry_delivery_items_check();
DROP FUNCTION laundry_line_return();
DROP FUNCTION laundry_order_items_guard();
DROP FUNCTION laundry_order_items_insert_check();
DROP FUNCTION laundry_orders_guard();
DROP FUNCTION laundry_garment_types_guard();
DROP FUNCTION laundry_services_check();
DROP FUNCTION laundry_append_only();
-- Refuses while an advance has been handed back from a garment order (restore a backup instead).
ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check,
  ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN ('salon', 'repair', 'optical', 'garage'));
DELETE FROM business_number_series WHERE document_kind = 'laundry_order';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'laundry_order');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_capabilities WHERE capability = 'laundry';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'laundry');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'laundry');
DELETE FROM business_permissions WHERE module_code = 'laundry';
DELETE FROM platform_module_business_types WHERE module_code = 'laundry';
DELETE FROM platform_module_dependencies WHERE module_code = 'laundry';
DELETE FROM platform_modules WHERE code = 'laundry';
