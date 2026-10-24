-- Up Migration
-- Quotations for every kind of business, and the hardware shop's own tools.
--
-- Quotations (shared module "quotations": every type but a restaurant; on
-- for a hardware shop, off elsewhere and recommended where most shops of the
-- trade give estimates). A quotation is a numbered estimate (QT/2627/0001)
-- with a validity date, priced by the core exactly as a sale of the same
-- lines would be: customer and slab prices, branch prices, running offers,
-- the counter discount, GST and round-off. An open quotation can be revised:
-- its lines are replaced, its revision goes up and the lines it replaced are
-- kept with the revision. Once the customer agrees, it becomes a bill (or,
-- with Sales orders on, a sales order) at the quoted prices while it is
-- valid; after its validity date the prices must be revised first. A
-- billed, ordered or cancelled quotation never changes. It is not a GST
-- document; the bill made from it is.
--
-- Hardware, paints and building materials (type "hardware"):
--   hardware_sites        Sites (on): a contractor's or builder's sites under
--                         each customer. Bills, quotations and sales orders
--                         carry a site through link tables; the invoices of a
--                         dispatched order take the order's site. A site's
--                         ledger is its bills, what was paid on them and what
--                         is still due.
--   hardware_rates        Today's rates (on): the items whose price moves every
--                         day (cement, steel, pipes, cable) on one board. A
--                         price change of a board item, from any screen,
--                         stamps its time and the price before it.
--   fitter_commission     Fitters' commission (off, recommended): the painters,
--                         plumbers, electricians, masons and carpenters who
--                         bring customers; commission rules (a % of the net
--                         value by category, or for every item, or a % or a
--                         flat amount per unit for one item); the commission a
--                         bill earned, frozen with the bill and taken back in
--                         proportion when goods come back; payouts, each kept
--                         in the expense book so Daily money counts it.
--   hardware_calculators  Tile & paint calculators (on): what one unit of an
--                         item covers, kept as item details for the
--                         calculators on Quick bill and quotations (no tables).

-- --- Modules ---------------------------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('quotations', 'Quotations', 'Estimates with a validity date at today''s prices; once the customer agrees, one becomes a bill, or with Sales orders a sales order, at the quoted prices.', 'optional', 122),
 ('hardware_sites', 'Sites', 'Each contractor''s or builder''s sites: bills, quotations and sales orders carry the site, with a ledger and the balance of every site.', 'optional', 296),
 ('hardware_rates', 'Today''s rates', 'The items whose price moves every day (cement, steel, pipes, cable) on one board: set today''s prices together and share them on WhatsApp.', 'optional', 297),
 ('fitter_commission', 'Fitters'' commission', 'Painters, plumbers, electricians, masons and carpenters who bring customers: the commission their bills earn, payouts and a statement for each.', 'optional', 298),
 ('hardware_calculators', 'Tile & paint calculators', 'Boxes of tiles and litres and tins of paint worked out from the area, on Quick bill and on quotations.', 'optional', 299);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('quotations', 'catalog'), ('quotations', 'contacts'), ('quotations', 'sales'),
 ('hardware_sites', 'contacts'), ('hardware_sites', 'sales'),
 ('hardware_rates', 'catalog'),
 ('fitter_commission', 'catalog'), ('fitter_commission', 'sales'),
 ('hardware_calculators', 'catalog');

-- Every type but a restaurant may use quotations; a hardware shop starts with them.
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT 'quotations', code, code = 'hardware' FROM business_types WHERE code <> 'restaurant';
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('hardware_sites', 'hardware', TRUE), ('hardware_rates', 'hardware', TRUE),
 ('fitter_commission', 'hardware', FALSE), ('hardware_calculators', 'hardware', TRUE);

-- Tools most shops of a trade use, where they start off.
UPDATE platform_module_business_types t SET recommended = TRUE, recommended_note = r.note
FROM (VALUES
  ('quotations', 'garage', 'Estimates for repairs and parts that the vehicle owner agrees to before the work.'),
  ('quotations', 'general_retail', 'Estimates for bulk, gift and made-to-order purchases.'),
  ('quotations', 'optical', 'Estimates for frames and lenses before the order is placed.'),
  ('quotations', 'jewellery', 'Estimates for custom orders before the work starts.'),
  ('quotations', 'wholesale', 'Price quotes for retailers and institutions before they order.'),
  ('fitter_commission', 'hardware', 'Painters, plumbers and electricians who bring customers: their commission and payouts.')
) AS r(module_code, business_type, note)
WHERE t.module_code = r.module_code AND t.business_type = r.business_type AND NOT t.enabled_by_default;

-- Today's rates and the calculators need no permissions of their own: the
-- board is read with catalog.view and saved with catalog.edit.
INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('quotations', 'view', 'See quotations', 460),
 ('quotations', 'create', 'Make quotations for customers', 461),
 ('quotations', 'edit', 'Revise open quotations and turn them into bills or sales orders', 462),
 ('quotations', 'cancel', 'Cancel quotations', 463),
 ('quotations', 'print', 'Print quotations and send them on WhatsApp', 464),
 ('hardware_sites', 'view', 'See customers'' sites, and each site''s bills and balance', 470),
 ('hardware_sites', 'edit', 'Add and change sites, and set the site of a bill, quotation or order', 471),
 ('fitter_commission', 'view', 'See fitters, the commission they earned and their statements', 474),
 ('fitter_commission', 'create', 'Name the fitter on a bill, and add fitters', 475),
 ('fitter_commission', 'edit', 'Change fitters and commission rules', 476),
 ('fitter_commission', 'approve', 'Pay fitters their commission', 477)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code IN ('quotations', 'hardware_sites', 'fitter_commission')
UNION ALL SELECT 'cashier', unnest(ARRAY['quotations.view', 'quotations.create', 'quotations.edit', 'quotations.print',
  'hardware_sites.view', 'hardware_sites.edit', 'fitter_commission.view', 'fitter_commission.create'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['hardware_sites.view'])
UNION ALL SELECT 'accountant', unnest(ARRAY['quotations.view', 'quotations.print', 'hardware_sites.view', 'fitter_commission.view', 'fitter_commission.approve'])
UNION ALL SELECT 'viewer', unnest(ARRAY['quotations.view', 'hardware_sites.view', 'fitter_commission.view']);

-- Existing businesses' copies of the shared templates (harmless where a
-- module cannot be switched on; keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code IN ('quotations', 'hardware_sites', 'fitter_commission')
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

-- Existing hardware shops get the tools a new one starts with (where what they need is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code IN ('quotations', 'hardware_sites', 'hardware_rates', 'hardware_calculators')
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Quotations are numbered (QT/2627/0001). The kinds list is widened by
-- reading the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'quotation' = ANY(kinds) THEN kinds := array_append(kinds, 'quotation'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- --- Quotations ------------------------------------------------------------------------------

CREATE TABLE business_quotations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  quotation_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  -- A saved customer (their name as it was when quoted), or the name and
  -- phone of someone who is not a customer yet.
  contact_id BIGINT,
  customer_name VARCHAR(150) NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_phone VARCHAR(30),
  valid_until DATE NOT NULL,
  -- Expired is not stored: an open quotation past its validity date is expired.
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'billed', 'ordered', 'cancelled')),
  tax_mode TEXT NOT NULL CHECK (tax_mode IN ('inclusive', 'exclusive')),
  subtotal NUMERIC(16,2) NOT NULL CHECK (subtotal >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  round_off NUMERIC(16,2) NOT NULL CHECK (round_off > -1 AND round_off < 1),
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  -- What running offers and the discount took off, in the prices' own terms.
  savings NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (savings >= 0),
  -- The discount given (an amount or a percent, with its reason); a revision prices it again.
  discount_amount NUMERIC(14,2) CHECK (discount_amount > 0),
  discount_percent NUMERIC(5,2) CHECK (discount_percent > 0 AND discount_percent <= 100),
  discount_reason VARCHAR(120),
  notes VARCHAR(500),
  revision SMALLINT NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 999),
  -- The bill it became, or the sales order.
  document_id BIGINT,
  order_id BIGINT,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who billed, ordered or cancelled it, and when.
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  cancel_reason VARCHAR(300),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, quotation_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, order_id),
  CHECK (total = subtotal + tax + round_off),
  CHECK (discount_amount IS NULL OR discount_percent IS NULL),
  CHECK ((discount_amount IS NULL AND discount_percent IS NULL) = (discount_reason IS NULL)),
  CHECK ((status = 'billed') = (document_id IS NOT NULL)),
  CHECK ((status = 'ordered') = (order_id IS NOT NULL)),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'open') = (closed_by IS NULL)),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
CREATE INDEX business_quotations_period ON business_quotations(business_id, created_at DESC);
CREATE INDEX business_quotations_contact ON business_quotations(business_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX business_quotations_open ON business_quotations(business_id, valid_until) WHERE status = 'open';
CREATE TRIGGER business_quotations_customer BEFORE INSERT OR UPDATE OF contact_id ON business_quotations
  FOR EACH ROW WHEN (NEW.contact_id IS NOT NULL) EXECUTE FUNCTION business_contact_is_customer();

-- Only an open quotation changes; it keeps its number, location and who made
-- it; a revision goes up one at a time; it is billed or ordered only while
-- valid (the business's own date). Nothing is deleted.
CREATE FUNCTION business_quotations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A quotation is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Quotation % is % and can no longer change', OLD.quotation_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.quotation_no <> OLD.quotation_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A quotation keeps its number, its location and who made it' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision NOT IN (OLD.revision, OLD.revision + 1) THEN
    RAISE EXCEPTION 'A quotation is revised one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('billed', 'ordered') THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    IF OLD.valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'Quotation % was valid until %. Revise it to bring its prices up to date first.', OLD.quotation_no, to_char(OLD.valid_until, 'DD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_quotations_guard BEFORE UPDATE OR DELETE ON business_quotations
  FOR EACH ROW EXECUTE FUNCTION business_quotations_guard();

-- Each line as a sale line keeps it: the stock-unit quantity and rate, the
-- line at its price, what offers and the discount took off, the taxable value
-- and GST, and the pack it was entered in (all four pack fields or none).
CREATE TABLE business_quotation_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  quotation_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  label VARCHAR(150) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(16,4) NOT NULL CHECK (unit_price >= 0),
  amount NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  discount NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate BETWEEN 0 AND 100),
  net NUMERIC(16,2) NOT NULL CHECK (net >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  price_rule_id BIGINT,
  entered_unit VARCHAR(20),
  entered_quantity NUMERIC(16,3) CHECK (entered_quantity > 0),
  entered_unit_price NUMERIC(14,2) CHECK (entered_unit_price >= 0),
  unit_factor NUMERIC(18,6) CHECK (unit_factor > 0),
  -- Printed on the quotation as on a bill: the HSN and MRP when quoted, and the offers given.
  hsn_code VARCHAR(8),
  mrp NUMERIC(14,2),
  offers JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(offers) = 'array'),
  FOREIGN KEY (business_id, quotation_id) REFERENCES business_quotations(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, unit) REFERENCES business_units(business_id, code),
  FOREIGN KEY (business_id, price_rule_id) REFERENCES business_price_rules(business_id, id),
  UNIQUE (business_id, id),
  CHECK (discount <= amount),
  CONSTRAINT business_quotation_lines_entered_all_or_none CHECK (
    (entered_unit IS NULL AND entered_quantity IS NULL AND entered_unit_price IS NULL AND unit_factor IS NULL) OR
    (entered_unit IS NOT NULL AND entered_quantity IS NOT NULL AND entered_unit_price IS NOT NULL AND unit_factor IS NOT NULL))
);
CREATE INDEX business_quotation_lines_quotation ON business_quotation_lines(business_id, quotation_id);

-- A line is never edited: revising replaces the lines of an open quotation.
CREATE FUNCTION business_quotation_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A quotation line is never changed; revise the quotation instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO state FROM business_quotations WHERE business_id = NEW.business_id AND id = NEW.quotation_id;
  ELSE
    SELECT status INTO state FROM business_quotations WHERE business_id = OLD.business_id AND id = OLD.quotation_id;
  END IF;
  IF state IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'The lines of a billed, ordered or cancelled quotation never change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER business_quotation_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON business_quotation_lines
  FOR EACH ROW EXECUTE FUNCTION business_quotation_lines_guard();

-- One row per revision: its request (a retry gives the same answer), the
-- totals before and after, and the lines it replaced.
CREATE TABLE business_quotation_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  quotation_id BIGINT NOT NULL,
  revision SMALLINT NOT NULL CHECK (revision BETWEEN 2 AND 999),
  total_before NUMERIC(16,2) NOT NULL,
  total_after NUMERIC(16,2) NOT NULL,
  lines_before JSONB NOT NULL CHECK (jsonb_typeof(lines_before) = 'array'),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, quotation_id) REFERENCES business_quotations(business_id, id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, quotation_id, revision)
);

CREATE FUNCTION business_quotation_revisions_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A quotation''s revisions are kept as they were made' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_quotation_revisions_fixed BEFORE UPDATE OR DELETE ON business_quotation_revisions
  FOR EACH ROW EXECUTE FUNCTION business_quotation_revisions_fixed();

-- --- Hardware: sites -------------------------------------------------------------------------

CREATE TABLE hardware_sites (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The contractor, builder or owner the site's bills are for.
  contact_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  address VARCHAR(500),
  contact_person VARCHAR(150),
  phone VARCHAR(30),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX hardware_sites_name ON hardware_sites(business_id, contact_id, lower(name));
CREATE TRIGGER hardware_sites_customer BEFORE INSERT ON hardware_sites
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A site stays with its customer (its bills are theirs) and is closed, never deleted.
CREATE FUNCTION hardware_sites_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A site is never deleted; close it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A site stays with the customer it was added for' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hardware_sites_guard BEFORE UPDATE OR DELETE ON hardware_sites
  FOR EACH ROW EXECUTE FUNCTION hardware_sites_guard();

-- The site a bill, a quotation or a sales order goes to.
CREATE TABLE hardware_document_sites (
  business_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  site_id BIGINT NOT NULL,
  set_by BIGINT NOT NULL REFERENCES users(id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, document_id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, site_id) REFERENCES hardware_sites(business_id, id)
);
CREATE INDEX hardware_document_sites_site ON hardware_document_sites(business_id, site_id);

CREATE TABLE hardware_quotation_sites (
  business_id BIGINT NOT NULL,
  quotation_id BIGINT NOT NULL,
  site_id BIGINT NOT NULL,
  set_by BIGINT NOT NULL REFERENCES users(id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, quotation_id),
  FOREIGN KEY (business_id, quotation_id) REFERENCES business_quotations(business_id, id),
  FOREIGN KEY (business_id, site_id) REFERENCES hardware_sites(business_id, id)
);
CREATE INDEX hardware_quotation_sites_site ON hardware_quotation_sites(business_id, site_id);

CREATE TABLE hardware_order_sites (
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  site_id BIGINT NOT NULL,
  set_by BIGINT NOT NULL REFERENCES users(id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, order_id),
  FOREIGN KEY (business_id, order_id) REFERENCES wholesale_orders(business_id, id),
  FOREIGN KEY (business_id, site_id) REFERENCES hardware_sites(business_id, id)
);
CREATE INDEX hardware_order_sites_site ON hardware_order_sites(business_id, site_id);

-- A site goes only with its own customer's bill, quotation or order (never a
-- walk-in's or a purchase); a quotation's site changes only while it is open.
CREATE FUNCTION hardware_site_link_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE site RECORD; owner BIGINT; state TEXT;
BEGIN
  IF TG_TABLE_NAME = 'hardware_quotation_sites' THEN
    SELECT status INTO state FROM business_quotations WHERE business_id = COALESCE(NEW.business_id, OLD.business_id)
      AND id = COALESCE(NEW.quotation_id, OLD.quotation_id);
    IF state IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'The site of a billed, ordered or cancelled quotation never changes' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT contact_id, name INTO site FROM hardware_sites WHERE business_id = NEW.business_id AND id = NEW.site_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'hardware_document_sites' THEN
    SELECT CASE WHEN kind = 'sale' THEN contact_id END INTO owner FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
  ELSIF TG_TABLE_NAME = 'hardware_quotation_sites' THEN
    SELECT contact_id INTO owner FROM business_quotations WHERE business_id = NEW.business_id AND id = NEW.quotation_id;
  ELSE
    SELECT contact_id INTO owner FROM wholesale_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  END IF;
  IF owner IS NULL THEN
    RAISE EXCEPTION 'Only a sale to a named customer can go to a site: choose the customer first' USING ERRCODE = '23514';
  END IF;
  IF owner <> site.contact_id THEN
    RAISE EXCEPTION 'Site % belongs to another customer: choose one of this customer''s sites', site.name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hardware_document_sites_check BEFORE INSERT OR UPDATE ON hardware_document_sites
  FOR EACH ROW EXECUTE FUNCTION hardware_site_link_check();
CREATE TRIGGER hardware_quotation_sites_check BEFORE INSERT OR UPDATE OR DELETE ON hardware_quotation_sites
  FOR EACH ROW EXECUTE FUNCTION hardware_site_link_check();
CREATE TRIGGER hardware_order_sites_check BEFORE INSERT OR UPDATE ON hardware_order_sites
  FOR EACH ROW EXECUTE FUNCTION hardware_site_link_check();

-- Every invoice a sales order is dispatched on goes to the order's site.
CREATE FUNCTION hardware_dispatch_site() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO hardware_document_sites (business_id, document_id, site_id, set_by)
  SELECT NEW.business_id, NEW.document_id, s.site_id, NEW.created_by FROM hardware_order_sites s
  WHERE s.business_id = NEW.business_id AND s.order_id = NEW.order_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER wholesale_dispatches_hardware_site AFTER INSERT ON wholesale_dispatches
  FOR EACH ROW EXECUTE FUNCTION hardware_dispatch_site();

-- --- Hardware: today's rates -------------------------------------------------------------------

-- The items on the board. A price change of one of them, from any screen
-- (the board, the item, a purchase that sets a new selling price), stamps
-- when it changed and the price before.
CREATE TABLE hardware_rate_items (
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  previous_price NUMERIC(14,2),
  price_changed_at TIMESTAMPTZ,
  added_by BIGINT NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK ((previous_price IS NULL) = (price_changed_at IS NULL))
);

CREATE FUNCTION hardware_rate_item_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE hardware_rate_items SET previous_price = OLD.price, price_changed_at = now()
  WHERE business_id = NEW.business_id AND sku_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER catalog_skus_hardware_rate AFTER UPDATE OF price ON catalog_skus
  FOR EACH ROW WHEN (OLD.price IS DISTINCT FROM NEW.price) EXECUTE FUNCTION hardware_rate_item_changed();

-- --- Hardware: fitters' commission -----------------------------------------------------------------

CREATE FUNCTION hardware_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commission records are never deleted' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'Commission records are kept as they were made' USING ERRCODE = '23514';
END $$;

-- The people who bring customers, and how to pay them.
CREATE TABLE hardware_fitters (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  trade TEXT NOT NULL CHECK (trade IN ('painter', 'plumber', 'electrician', 'mason', 'carpenter', 'other')),
  phone VARCHAR(30),
  upi_id VARCHAR(100) CHECK (upi_id ~ '^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9.-]{1,63}$'),
  area VARCHAR(100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX hardware_fitters_phone ON hardware_fitters(business_id, phone) WHERE phone IS NOT NULL;

-- A rule earns a % of a line's net value (before GST, after discounts) for
-- every item, for a category and the categories under it, or for one item;
-- or a flat amount per stock unit of one item. One active rule per scope;
-- the most specific wins: the item, then the nearest category, then every item.
CREATE TABLE hardware_fitter_rules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  category_id BIGINT,
  sku_id BIGINT,
  percent NUMERIC(5,2) CHECK (percent > 0 AND percent <= 50),
  per_unit NUMERIC(14,2) CHECK (per_unit > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, category_id) REFERENCES catalog_categories(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  CHECK (category_id IS NULL OR sku_id IS NULL),
  CHECK ((percent IS NULL) <> (per_unit IS NULL)),
  CHECK (per_unit IS NULL OR sku_id IS NOT NULL)
);
CREATE UNIQUE INDEX hardware_fitter_rules_one_active ON hardware_fitter_rules(business_id, COALESCE(category_id, 0), COALESCE(sku_id, 0)) WHERE active;

-- The fitter of a bill and what the bill earned them (the sum of its lines),
-- worked out when the bill was posted: a later rule change never changes it.
CREATE TABLE hardware_fitter_bills (
  business_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  fitter_id BIGINT NOT NULL,
  commission NUMERIC(16,2) NOT NULL CHECK (commission >= 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, document_id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, fitter_id) REFERENCES hardware_fitters(business_id, id)
);
CREATE INDEX hardware_fitter_bills_fitter ON hardware_fitter_bills(business_id, fitter_id, created_at);
CREATE TRIGGER hardware_fitter_bills_append_only BEFORE UPDATE OR DELETE ON hardware_fitter_bills
  FOR EACH ROW EXECUTE FUNCTION hardware_append_only();

-- Each line that earned commission: the rule, its rate, the line's quantity
-- and net value, and the commission (in paise, never more than the net).
CREATE TABLE hardware_fitter_lines (
  business_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  rule_id BIGINT NOT NULL,
  percent NUMERIC(5,2),
  per_unit NUMERIC(14,2),
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  net NUMERIC(16,2) NOT NULL CHECK (net >= 0),
  commission NUMERIC(16,2) NOT NULL CHECK (commission > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, line_id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES hardware_fitter_bills(business_id, document_id),
  FOREIGN KEY (business_id, rule_id) REFERENCES hardware_fitter_rules(business_id, id),
  CHECK ((percent IS NULL) <> (per_unit IS NULL)),
  CHECK (commission <= net)
);
CREATE TRIGGER hardware_fitter_lines_append_only BEFORE UPDATE OR DELETE ON hardware_fitter_lines
  FOR EACH ROW EXECUTE FUNCTION hardware_append_only();

-- Goods back on a bill take back the commission in proportion to the
-- quantity returned so far (cumulative, so a line returned in parts takes
-- back exactly what it earned once all of it is back).
CREATE TABLE hardware_fitter_reversals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  return_line_id BIGINT NOT NULL REFERENCES business_return_lines(id),
  return_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  amount NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (return_line_id),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES hardware_fitter_lines(business_id, line_id)
);
CREATE INDEX hardware_fitter_reversals_document ON hardware_fitter_reversals(business_id, document_id);
CREATE TRIGGER hardware_fitter_reversals_append_only BEFORE UPDATE OR DELETE ON hardware_fitter_reversals
  FOR EACH ROW EXECUTE FUNCTION hardware_append_only();

CREATE FUNCTION hardware_fitter_reverse_on_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE earned RECORD; returned NUMERIC; reversed NUMERIC;
BEGIN
  SELECT quantity, commission, document_id INTO earned FROM hardware_fitter_lines WHERE business_id = NEW.business_id AND line_id = NEW.line_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(quantity), 0) INTO returned FROM business_return_lines WHERE business_id = NEW.business_id AND line_id = NEW.line_id;
  SELECT COALESCE(sum(amount), 0) INTO reversed FROM hardware_fitter_reversals WHERE business_id = NEW.business_id AND line_id = NEW.line_id;
  INSERT INTO hardware_fitter_reversals (business_id, return_line_id, return_id, line_id, document_id, quantity, amount)
  VALUES (NEW.business_id, NEW.id, NEW.return_id, NEW.line_id, earned.document_id, NEW.quantity,
    GREATEST(0, round(earned.commission * LEAST(returned, earned.quantity) / earned.quantity, 2) - reversed));
  RETURN NULL;
END $$;
CREATE TRIGGER business_return_lines_hardware_fitter AFTER INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION hardware_fitter_reverse_on_return();

-- Money paid to a fitter. Each payout is an expense of the business (the
-- expense book, so Daily money and the reports count it); reversing that
-- expense with a reason takes the payout back. What is due never goes below
-- nothing: the API refuses a payout of more than is due.
CREATE TABLE hardware_fitter_payouts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  fitter_id BIGINT NOT NULL,
  expense_id BIGINT NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, fitter_id) REFERENCES hardware_fitters(business_id, id),
  FOREIGN KEY (business_id, expense_id) REFERENCES business_expenses(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, expense_id)
);
CREATE INDEX hardware_fitter_payouts_fitter ON hardware_fitter_payouts(business_id, fitter_id, created_at);
CREATE TRIGGER hardware_fitter_payouts_append_only BEFORE UPDATE OR DELETE ON hardware_fitter_payouts
  FOR EACH ROW EXECUTE FUNCTION hardware_append_only();

-- Down Migration
DROP TABLE hardware_fitter_payouts;
DROP TRIGGER business_return_lines_hardware_fitter ON business_return_lines;
DROP FUNCTION hardware_fitter_reverse_on_return();
DROP TABLE hardware_fitter_reversals, hardware_fitter_lines, hardware_fitter_bills, hardware_fitter_rules, hardware_fitters;
DROP FUNCTION hardware_append_only();
DROP TRIGGER catalog_skus_hardware_rate ON catalog_skus;
DROP FUNCTION hardware_rate_item_changed();
DROP TABLE hardware_rate_items;
DROP TRIGGER wholesale_dispatches_hardware_site ON wholesale_dispatches;
DROP FUNCTION hardware_dispatch_site();
DROP TABLE hardware_order_sites, hardware_quotation_sites, hardware_document_sites;
DROP FUNCTION hardware_site_link_check();
DROP TABLE hardware_sites;
DROP FUNCTION hardware_sites_guard();
DROP TABLE business_quotation_revisions, business_quotation_lines, business_quotations;
DROP FUNCTION business_quotation_revisions_fixed();
DROP FUNCTION business_quotation_lines_guard();
DROP FUNCTION business_quotations_guard();
DELETE FROM business_number_series WHERE document_kind = 'quotation';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'quotation');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_capabilities WHERE capability IN ('quotations', 'hardware_sites', 'hardware_rates', 'fitter_commission', 'hardware_calculators');
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('quotations', 'hardware_sites', 'fitter_commission'));
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('quotations', 'hardware_sites', 'fitter_commission'));
DELETE FROM business_permissions WHERE module_code IN ('quotations', 'hardware_sites', 'fitter_commission');
DELETE FROM platform_module_business_types WHERE module_code IN ('quotations', 'hardware_sites', 'hardware_rates', 'fitter_commission', 'hardware_calculators');
DELETE FROM platform_module_dependencies WHERE module_code IN ('quotations', 'hardware_sites', 'hardware_rates', 'fitter_commission', 'hardware_calculators');
DELETE FROM platform_modules WHERE code IN ('quotations', 'hardware_sites', 'hardware_rates', 'fitter_commission', 'hardware_calculators');
