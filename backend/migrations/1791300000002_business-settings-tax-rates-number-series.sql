-- Up Migration
-- Business (tenant) layer: the business's own details, its GST slabs and its
-- document numbering. One settings row per business; restaurant businesses
-- get one too (their restaurant keeps using restaurant_settings, untouched).

CREATE TABLE business_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  legal_name VARCHAR(200),
  display_name VARCHAR(150) NOT NULL,
  -- Validated with its check character by the API (utils/gstin.js); the
  -- pattern here stops anything that is not even GSTIN-shaped.
  gstin CHAR(15) CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  address_line1 VARCHAR(200),
  address_line2 VARCHAR(200),
  city VARCHAR(100),
  -- GST state code (two digits): the place of supply for intra/inter-state tax.
  state_code CHAR(2) CHECK (state_code ~ '^[0-9]{2}$'),
  postal_code VARCHAR(10) CHECK (postal_code ~ '^[0-9]{6}$'),
  phone VARCHAR(30),
  email VARCHAR(150),
  logo_path VARCHAR(300),
  -- exclusive: catalogue prices are before tax. inclusive: catalogue prices
  -- already contain the tax, which is worked out of them on each line.
  tax_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK (tax_mode IN ('exclusive', 'inclusive')),
  -- How a sale total is rounded; the difference is kept as round_off on the
  -- sale so totals always add up to the paise.
  rounding TEXT NOT NULL DEFAULT 'none' CHECK (rounding IN ('none', 'nearest_rupee')),
  -- Indian fiscal years start in April; kept configurable for other cases.
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 4 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  invoice_footer VARCHAR(500),
  receipt_footer VARCHAR(300),
  date_format TEXT NOT NULL DEFAULT 'DD/MM/YYYY' CHECK (date_format IN ('DD/MM/YYYY', 'DD-MM-YYYY', 'DD MMM YYYY', 'YYYY-MM-DD')),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A GSTIN's first two digits are its state; the two cannot disagree.
  CHECK (gstin IS NULL OR state_code IS NULL OR left(gstin, 2) = state_code)
);

CREATE FUNCTION business_seed_settings(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_settings (business_id, display_name)
  SELECT id, name FROM businesses WHERE id = target
  ON CONFLICT (business_id) DO NOTHING;
$$;
SELECT business_seed_settings(id) FROM businesses;

-- Named GST slabs. A slab's rate never changes once created: when the law
-- changes, add the new slab and move items to it, so a past invoice can still
-- say which slab it used and what that slab meant.
CREATE TABLE business_tax_rates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(60) NOT NULL,
  rate NUMERIC(5,2) NOT NULL CHECK (rate BETWEEN 0 AND 100),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK (active OR NOT is_default)
);
CREATE UNIQUE INDEX business_tax_rates_name ON business_tax_rates(business_id, lower(name));
CREATE UNIQUE INDEX business_tax_rates_one_default ON business_tax_rates(business_id) WHERE is_default;

CREATE FUNCTION business_tax_rates_rate_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rate <> OLD.rate OR NEW.business_id <> OLD.business_id THEN
    RAISE EXCEPTION 'A tax slab''s rate cannot change; add a new slab instead' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_tax_rates_rate_fixed BEFORE UPDATE ON business_tax_rates
  FOR EACH ROW EXECUTE FUNCTION business_tax_rates_rate_fixed();

-- The GST slabs in force since 22 September 2025: nil, 5%, 18% and 40%.
-- Businesses add others (3% on gold, 0.25% on rough stones…) themselves.
-- Restaurants keep their own tax rates in the restaurant module.
CREATE FUNCTION business_seed_tax_rates(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_tax_rates (business_id, name, rate, is_default)
  SELECT b.id, s.name, s.rate, s.is_default
  FROM businesses b, (VALUES ('GST nil / exempt', 0.00, FALSE), ('GST 5%', 5.00, FALSE),
                              ('GST 18%', 18.00, TRUE), ('GST 40%', 40.00, FALSE)) AS s(name, rate, is_default)
  WHERE b.id = target AND b.business_type <> 'restaurant'
    AND NOT EXISTS (SELECT 1 FROM business_tax_rates x WHERE x.business_id = b.id);
$$;
SELECT business_seed_tax_rates(id) FROM businesses;

-- SKUs may name their slab. tax_rate stays on the SKU as the rate charged
-- (copied from the slab when one is chosen), so posting a sale reads one
-- column and old SKUs without a slab keep working.
ALTER TABLE catalog_skus ADD COLUMN tax_rate_id BIGINT,
  ADD CONSTRAINT catalog_skus_tax_rate_fkey FOREIGN KEY (business_id, tax_rate_id) REFERENCES business_tax_rates(business_id, id);
-- Existing SKUs adopt the slab of the same rate where one exists.
UPDATE catalog_skus s SET tax_rate_id = t.id
FROM business_tax_rates t WHERE t.business_id = s.business_id AND t.rate = s.tax_rate AND s.tax_rate_id IS NULL;

-- Document number series: one per business, location, kind of document and
-- fiscal year. A number is taken by UPDATE … SET next_number = next_number + 1
-- inside the transaction that posts the document, so two tills posting at
-- once queue on the row, and a posting that fails gives its number back.
CREATE TABLE business_number_series (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  document_kind TEXT NOT NULL CHECK (document_kind IN
    ('sale', 'purchase', 'sales_return', 'purchase_return', 'stock_transfer', 'stock_count')),
  -- The fiscal year by the year it starts in: 2026 is FY 2026-27.
  fiscal_year SMALLINT NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2200),
  -- Letters, digits, '/' and '-' only, ending in something that is not a
  -- digit: with every prefix in a business distinct, a number like
  -- "SI/26-27/0042" can then only ever come from one series.
  prefix VARCHAR(12) NOT NULL CHECK (prefix ~ '^[A-Za-z0-9/-]*[A-Za-z/-]$'),
  next_number BIGINT NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  padding SMALLINT NOT NULL DEFAULT 4 CHECK (padding BETWEEN 1 AND 8),
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, location_id, document_kind, fiscal_year),
  UNIQUE (business_id, prefix),
  -- GST invoices allow at most 16 characters in the number.
  CHECK (char_length(prefix) + padding <= 16)
);

-- Numbers already taken cannot be handed out again by moving next_number back.
CREATE FUNCTION business_number_series_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_number < OLD.next_number THEN
    RAISE EXCEPTION 'A number series cannot go back to numbers already used' USING ERRCODE = '23514';
  END IF;
  IF (NEW.prefix <> OLD.prefix OR NEW.padding <> OLD.padding) AND OLD.next_number > 1 THEN
    RAISE EXCEPTION 'The prefix and padding are fixed once a number has been used; start a new series instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.business_id <> OLD.business_id OR NEW.location_id <> OLD.location_id
     OR NEW.document_kind <> OLD.document_kind OR NEW.fiscal_year <> OLD.fiscal_year THEN
    RAISE EXCEPTION 'A series belongs to one location, document kind and year' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_number_series_forward_only BEFORE UPDATE ON business_number_series
  FOR EACH ROW EXECUTE FUNCTION business_number_series_forward_only();

-- Documents remember the series and the round-off; the total now includes
-- the round-off. tax_mode records whether the line prices included tax, so
-- the invoice can be printed exactly as it was posted.
ALTER TABLE business_documents
  ADD COLUMN series_id BIGINT,
  ADD COLUMN tax_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK (tax_mode IN ('exclusive', 'inclusive')),
  ADD COLUMN round_off NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (round_off > -1 AND round_off < 1),
  ADD COLUMN due_on DATE,
  ADD CONSTRAINT business_documents_series_fkey FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  DROP CONSTRAINT business_documents_check,
  ADD CONSTRAINT business_documents_total_adds_up CHECK (total >= 0 AND total = subtotal + tax + round_off);

-- Credit and debit notes get their own numbers. Returns made before this
-- migration keep none.
ALTER TABLE business_returns
  ADD COLUMN return_no VARCHAR(50),
  ADD COLUMN series_id BIGINT,
  -- On the return that takes back the last of a sale, the sale's round-off
  -- comes back too, so a fully returned sale owes exactly nothing.
  ADD COLUMN round_off NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (round_off > -1 AND round_off < 1),
  ADD CONSTRAINT business_returns_series_fkey FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  ADD CONSTRAINT business_returns_number_unique UNIQUE (business_id, return_no);

-- Down Migration
ALTER TABLE business_returns DROP CONSTRAINT business_returns_number_unique, DROP CONSTRAINT business_returns_series_fkey,
  DROP COLUMN round_off, DROP COLUMN series_id, DROP COLUMN return_no;
ALTER TABLE business_documents DROP CONSTRAINT business_documents_total_adds_up,
  DROP CONSTRAINT business_documents_series_fkey,
  DROP COLUMN due_on, DROP COLUMN round_off, DROP COLUMN tax_mode, DROP COLUMN series_id;
ALTER TABLE business_documents ADD CONSTRAINT business_documents_check CHECK (total >= 0 AND total = subtotal + tax);
DROP TRIGGER business_number_series_forward_only ON business_number_series;
DROP FUNCTION business_number_series_forward_only();
DROP TABLE business_number_series;
ALTER TABLE catalog_skus DROP CONSTRAINT catalog_skus_tax_rate_fkey, DROP COLUMN tax_rate_id;
DROP FUNCTION business_seed_tax_rates(BIGINT);
DROP TRIGGER business_tax_rates_rate_fixed ON business_tax_rates;
DROP FUNCTION business_tax_rates_rate_fixed();
DROP TABLE business_tax_rates;
DROP FUNCTION business_seed_settings(BIGINT);
DROP TABLE business_settings;
