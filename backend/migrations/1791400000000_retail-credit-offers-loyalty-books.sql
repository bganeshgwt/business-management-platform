-- Up Migration
-- Phase 2, job T1: retail (grocery / kirana, supermarket, books & stationery).
--
-- Everything here hangs off the shared core (contacts, catalogue SKUs,
-- documents, lines, payments) through composite (business_id, …) foreign
-- keys, so no retail row can ever point at another business's records.
--
--   udhaar           Customer credit runs on the shared receivables module
--                    (collections, outstanding, statements: migration
--                    1791410000000). Retail adds reminders, with the date a
--                    customer promised to pay (retail_credit_reminders).
--   offers           Item, category and bill discounts, buy-X-get-Y, with date,
--                    weekday and time windows. Worked out by the server when a
--                    sale is posted; what each line got is kept in
--                    retail_sale_discounts (a snapshot, never rewritten).
--   loyalty          Points earned on sales and redeemed against a bill.
--   books            (module exists) typed, searchable book details.
--   weight           (module exists) weighing-scale codes for loose items.
--
-- Tables are named retail_* where grocery, supermarket and books share them,
-- and books_* for the books type alone (docs/BUSINESS_PLATFORM_DATA_MODEL.md).

-- --- Modules and permissions ----------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('offers', 'Offers & discounts', 'Item, category and bill discounts and buy-X-get-Y offers, applied by the server at billing.', 'optional', 250),
 ('loyalty', 'Loyalty points', 'Points earned on purchases and redeemed against later bills.', 'optional', 260);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('offers', 'sales'), ('offers', 'catalog'),
 ('loyalty', 'sales'), ('loyalty', 'contacts');

-- Supermarkets run offers and loyalty; a kirana or a bookshop may use them
-- but starts with neither switched on.
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('offers', 'grocery', FALSE), ('offers', 'supermarket', TRUE), ('offers', 'books', FALSE),
 ('loyalty', 'grocery', FALSE), ('loyalty', 'supermarket', TRUE), ('loyalty', 'books', FALSE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('offers', 'view', 'See offers and what they gave away', 150),
 ('offers', 'create', 'Add offers and discounts', 151),
 ('offers', 'edit', 'Change and switch off offers', 152),
 ('loyalty', 'view', 'See loyalty points', 160),
 ('loyalty', 'create', 'Redeem a customer''s points on a bill', 161),
 ('loyalty', 'edit', 'Change loyalty rules and correct points', 162),
 ('loyalty', 'export', 'Export loyalty points', 163)
) AS p(module_code, action, name, sort_order);

-- Template grants, written out (the Phase 1 "everything except access" rule
-- for Manager was a one-time insert, not a live rule).
INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code IN ('offers', 'loyalty')
UNION ALL SELECT 'cashier', unnest(ARRAY['offers.view', 'loyalty.view', 'loyalty.create'])
UNION ALL SELECT 'accountant', code FROM business_permissions WHERE module_code IN ('offers', 'loyalty') AND action IN ('view', 'export', 'print')
UNION ALL SELECT 'viewer', code FROM business_permissions WHERE module_code IN ('offers', 'loyalty') AND action IN ('view', 'export');

-- Existing businesses' copies of those templates get the same grants, so a
-- cashier can redeem points the day loyalty is switched on.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code IN ('offers', 'loyalty')
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

-- Existing businesses of these types receive the new default modules where
-- what they depend on is already on. Nothing is taken away from anyone.
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code IN ('offers', 'loyalty')
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Rows that record money or points that changed hands are append-only: the
-- API never edits or deletes them. Only the timestamp may be corrected
-- (the demo set-up spreads sample records over the month).
CREATE FUNCTION retail_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted % rows cannot be deleted; record a correction instead', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'created_at') <> (to_jsonb(OLD) - 'created_at') THEN
    RAISE EXCEPTION 'Posted % rows cannot be changed; record a correction instead', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- Udhaar reminders --------------------------------------------------------------

-- A reminder given to a customer who owes money (udhaar), with the date they
-- promised to pay. Collections themselves are shared receivables.
CREATE TABLE retail_credit_reminders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'call', 'visit', 'other')),
  -- What they owed when reminded (a snapshot for the history).
  balance NUMERIC(16,2) NOT NULL,
  promised_on DATE,
  note VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id)
);
CREATE INDEX retail_credit_reminders_contact ON retail_credit_reminders(business_id, contact_id, created_at DESC);

-- --- Offers & discounts ------------------------------------------------------------

CREATE TABLE retail_offers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  -- item_percent / item_amount: one item (amount = off each unit);
  -- category_percent: every item in a category and its sub-categories;
  -- bill_percent / bill_amount: the whole bill; buy_x_get_y: buy X of an
  -- item, get Y more of it at `value` % off (100 = free).
  kind TEXT NOT NULL CHECK (kind IN ('item_percent', 'item_amount', 'category_percent', 'bill_percent', 'bill_amount', 'buy_x_get_y')),
  sku_id BIGINT,
  category_id BIGINT,
  value NUMERIC(12,2) NOT NULL CHECK (value > 0),
  buy_quantity NUMERIC(16,3) CHECK (buy_quantity > 0),
  get_quantity NUMERIC(16,3) CHECK (get_quantity > 0),
  -- The bill (before any discount) must reach this for the offer to apply.
  min_bill_amount NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (min_bill_amount >= 0),
  -- The most one bill can get from this offer (NULL = no cap).
  max_discount NUMERIC(16,2) CHECK (max_discount > 0),
  starts_on DATE NOT NULL,
  ends_on DATE,
  -- ISO weekdays (1 = Monday … 7 = Sunday); NULL = every day.
  days_of_week SMALLINT[],
  -- A daily window in the business's time zone; may run past midnight.
  starts_time TIME,
  ends_time TIME,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, category_id) REFERENCES catalog_categories(business_id, id),
  UNIQUE (business_id, id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK ((starts_time IS NULL) = (ends_time IS NULL)),
  CHECK (starts_time IS NULL OR starts_time <> ends_time),
  CHECK (days_of_week IS NULL OR (cardinality(days_of_week) BETWEEN 1 AND 7 AND days_of_week <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[])),
  CHECK (kind NOT IN ('item_percent', 'category_percent', 'bill_percent', 'buy_x_get_y') OR value <= 100),
  CHECK ((kind IN ('item_percent', 'item_amount', 'buy_x_get_y')) = (sku_id IS NOT NULL)),
  CHECK ((kind = 'category_percent') = (category_id IS NOT NULL)),
  CHECK ((kind = 'buy_x_get_y') = (buy_quantity IS NOT NULL AND get_quantity IS NOT NULL)),
  CHECK (kind = 'buy_x_get_y' OR (buy_quantity IS NULL AND get_quantity IS NULL))
);
CREATE INDEX retail_offers_running ON retail_offers(business_id, starts_on, ends_on) WHERE active;

-- What each sale line was given, and why. The line's own net/tax already
-- reflect it; these rows explain the difference from price × quantity.
-- `amount` is in the document's price terms (including GST when the
-- business prices include GST, before GST otherwise).
CREATE TABLE retail_sale_discounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('offer', 'points')),
  offer_id BIGINT,
  -- The offer's name at the time of the sale (snapshot).
  label VARCHAR(150) NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, offer_id) REFERENCES retail_offers(business_id, id),
  CHECK ((source = 'offer') = (offer_id IS NOT NULL))
);
CREATE INDEX retail_sale_discounts_document ON retail_sale_discounts(business_id, document_id);
CREATE INDEX retail_sale_discounts_offer ON retail_sale_discounts(business_id, offer_id) WHERE offer_id IS NOT NULL;
CREATE TRIGGER retail_sale_discounts_append_only BEFORE UPDATE OR DELETE ON retail_sale_discounts
  FOR EACH ROW EXECUTE FUNCTION retail_append_only();

-- --- Loyalty points -------------------------------------------------------------------

CREATE TABLE retail_loyalty_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- Spend `earn_per_amount` rupees, earn `earn_points` points.
  earn_per_amount NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK (earn_per_amount >= 1),
  earn_points INTEGER NOT NULL DEFAULT 1 CHECK (earn_points BETWEEN 1 AND 1000),
  -- Rupees one point is worth when redeemed.
  point_value NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (point_value > 0 AND point_value <= 1000),
  min_redeem_points INTEGER NOT NULL DEFAULT 100 CHECK (min_redeem_points >= 1),
  -- At most this share of a bill can be paid with points.
  max_redeem_percent NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (max_redeem_percent > 0 AND max_redeem_percent <= 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- earn: points given for a sale (whole points, on the bill total);
-- redeem: points spent on a sale (negative); adjust: a reasoned correction.
-- Points earned on a sale shrink in proportion when goods come back
-- (worked out when balances are read, from the sale's returns).
CREATE TABLE retail_loyalty_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('earn', 'redeem', 'adjust')),
  points INTEGER NOT NULL CHECK (points <> 0),
  document_id BIGINT,
  -- Rupees the redeemed points took off the bill.
  value NUMERIC(16,2) CHECK (value > 0),
  reason VARCHAR(300),
  request_key UUID,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((kind = 'earn' AND points > 0 AND document_id IS NOT NULL AND value IS NULL)
      OR (kind = 'redeem' AND points < 0 AND document_id IS NOT NULL AND value IS NOT NULL)
      OR (kind = 'adjust' AND document_id IS NULL AND value IS NULL AND reason IS NOT NULL AND request_key IS NOT NULL))
);
CREATE UNIQUE INDEX retail_loyalty_entries_one_per_sale ON retail_loyalty_entries(business_id, document_id, kind) WHERE document_id IS NOT NULL;
CREATE INDEX retail_loyalty_entries_contact ON retail_loyalty_entries(business_id, contact_id, created_at DESC);
CREATE TRIGGER retail_loyalty_entries_append_only BEFORE UPDATE OR DELETE ON retail_loyalty_entries
  FOR EACH ROW EXECUTE FUNCTION retail_append_only();

-- --- Weighing-scale codes --------------------------------------------------------------

-- A loose item's 5-digit code on the shop's label scale. The scale prints an
-- EAN-13 "21 PPPPP WWWWW C": PLU, weight in grams, check digit; scanning it
-- bills that item at that weight.
CREATE TABLE retail_scale_items (
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  plu_code CHAR(5) NOT NULL CHECK (plu_code ~ '^[0-9]{5}$'),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  UNIQUE (business_id, plu_code),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE FUNCTION retail_scale_items_weighed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An item of another business is the foreign key's to refuse.
  IF NOT EXISTS (SELECT 1 FROM catalog_skus WHERE business_id = NEW.business_id AND id = NEW.sku_id) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN business_units u ON u.business_id = s.business_id AND u.code = s.unit
                 WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id AND u.kind = 'weight' AND s.tracking <> 'serial') THEN
    RAISE EXCEPTION 'A scale code is only for an item sold by weight' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retail_scale_items_weighed BEFORE INSERT OR UPDATE ON retail_scale_items
  FOR EACH ROW EXECUTE FUNCTION retail_scale_items_weighed();

-- --- Book details ---------------------------------------------------------------------

-- ISBN-10 or ISBN-13 with a correct check digit.
CREATE FUNCTION books_isbn_valid(code TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  total INTEGER := 0;
  digit INTEGER;
BEGIN
  IF code ~ '^[0-9]{13}$' THEN
    FOR i IN 1..13 LOOP
      total := total + substr(code, i, 1)::INTEGER * CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END;
    END LOOP;
    RETURN total % 10 = 0;
  ELSIF code ~ '^[0-9]{9}[0-9X]$' THEN
    FOR i IN 1..10 LOOP
      digit := CASE WHEN substr(code, i, 1) = 'X' THEN 10 ELSE substr(code, i, 1)::INTEGER END;
      total := total + digit * (11 - i);
    END LOOP;
    RETURN total % 11 = 0;
  END IF;
  RETURN FALSE;
END $$;

-- ISBN-13 from either form (hyphens and spaces ignored); NULL if invalid.
-- Books carry the ISBN-13 as their EAN barcode, so storing that form lets a
-- scan find the book.
CREATE FUNCTION books_isbn13(raw TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  code TEXT := upper(regexp_replace(COALESCE(raw, ''), '[\s-]', '', 'g'));
  body TEXT;
  total INTEGER := 0;
BEGIN
  IF NOT books_isbn_valid(code) THEN RETURN NULL; END IF;
  IF length(code) = 13 THEN RETURN CASE WHEN code ~ '^97[89]' THEN code END; END IF;
  body := '978' || substr(code, 1, 9);
  FOR i IN 1..12 LOOP
    total := total + substr(body, i, 1)::INTEGER * CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END;
  END LOOP;
  RETURN body || ((10 - total % 10) % 10)::TEXT;
END $$;

CREATE TABLE books_titles (
  business_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  isbn CHAR(13) CHECK (isbn ~ '^97[89][0-9]{10}$' AND books_isbn_valid(isbn)),
  author VARCHAR(200),
  publisher VARCHAR(150),
  edition VARCHAR(60),
  language VARCHAR(40),
  published_year SMALLINT CHECK (published_year BETWEEN 1450 AND 2200),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE UNIQUE INDEX books_titles_isbn ON books_titles(business_id, isbn) WHERE isbn IS NOT NULL;
CREATE INDEX books_titles_author ON books_titles(business_id, lower(author));
CREATE INDEX books_titles_publisher ON books_titles(business_id, lower(publisher));

-- Book details kept so far as free attributes move into typed, searchable
-- columns. An ISBN with a wrong check digit is not copied (the free
-- attribute stays as it was, so nothing is lost). Two items with the same
-- ISBN: the older one keeps it.
INSERT INTO books_titles (business_id, sku_id, isbn, author, publisher)
SELECT business_id, id, CASE WHEN copy = 1 THEN isbn END, author, publisher
FROM (
  SELECT s.business_id, s.id, books_isbn13(s.attributes->>'isbn') AS isbn,
    row_number() OVER (PARTITION BY s.business_id, books_isbn13(s.attributes->>'isbn') ORDER BY s.id) AS copy,
    NULLIF(btrim(s.attributes->>'author'), '') AS author, NULLIF(btrim(s.attributes->>'publisher'), '') AS publisher
  FROM catalog_skus s
  WHERE s.attributes ?| ARRAY['isbn', 'author', 'publisher']
) found;

-- Down Migration
DROP TABLE books_titles;
DROP FUNCTION books_isbn13(TEXT);
DROP FUNCTION books_isbn_valid(TEXT);
DROP TABLE retail_scale_items;
DROP FUNCTION retail_scale_items_weighed();
DROP TABLE retail_loyalty_entries, retail_loyalty_settings;
DROP TABLE retail_sale_discounts, retail_offers;
DROP TABLE retail_credit_reminders;
DROP FUNCTION retail_append_only();
DELETE FROM business_capabilities WHERE capability IN ('offers', 'loyalty');
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('offers', 'loyalty'));
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code IN ('offers', 'loyalty'));
DELETE FROM business_permissions WHERE module_code IN ('offers', 'loyalty');
DELETE FROM platform_module_business_types WHERE module_code IN ('offers', 'loyalty');
DELETE FROM platform_module_dependencies WHERE module_code IN ('offers', 'loyalty');
DELETE FROM platform_modules WHERE code IN ('offers', 'loyalty');
