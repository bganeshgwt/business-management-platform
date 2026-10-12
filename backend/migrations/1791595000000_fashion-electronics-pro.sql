-- Up Migration
-- Pro pass, builder E (fashion and electronics), 7 Oct 2026.
--
--   modules        Offers switch on for garment shops (end-of-season
--                  markdowns run on them); Exchanges switch on for
--                  electronics (DOA swaps); new garment shops no longer start
--                  with "Sold by weight" (most sell pieces; fabric by the
--                  metre can still switch it on).
--   markdowns      retail_offers gets a 'product_percent' kind: % off every
--                  size and colour of one style, with an end date (the
--                  shelf price is never rewritten, so it reverts by itself).
--   GST by price   fashion_gst_price_slabs: apparel at 5 % up to a per-piece
--                  value (₹2,500) and 18 % above, worked out on each sale
--                  line after discounts.
--   vouchers       business_exchange_vouchers: exchange credit printed as a
--                  numbered voucher (walk-ins included), spent at the counter.
--   faulty units   electronics_faulty_units: a DOA or faulty serial unit,
--                  not sellable while it waits for the supplier, linked to
--                  the replacement unit, the exchange and the purchase return.
--   claims         electronics_warranty_claims: what a warranty repair is
--                  claimed back from the brand or distributor.
--   repairs        'awaiting_approval' status, passcode (cleared when the
--                  job closes), damage checklist, an advance (a customer
--                  collection credited on the final bill); a brand helpline
--                  on each model.

-- --- Modules --------------------------------------------------------------------

UPDATE platform_module_business_types SET enabled_by_default = TRUE WHERE module_code = 'exchanges' AND business_type = 'electronics';
UPDATE platform_module_business_types SET enabled_by_default = FALSE WHERE module_code = 'weight' AND business_type = 'fashion';
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES
 ('offers', 'fashion', TRUE), ('loyalty', 'fashion', FALSE), ('offers', 'electronics', FALSE)
ON CONFLICT (module_code, business_type) DO NOTHING;

INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE (t.module_code, t.business_type) IN (('offers', 'fashion'), ('exchanges', 'electronics'))
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- --- Markdowns: % off a whole style ---------------------------------------------------

ALTER TABLE retail_offers ADD COLUMN product_id BIGINT;
ALTER TABLE retail_offers ADD CONSTRAINT retail_offers_product_fkey FOREIGN KEY (business_id, product_id) REFERENCES catalog_products(business_id, id);
ALTER TABLE retail_offers DROP CONSTRAINT retail_offers_kind_check,
  ADD CONSTRAINT retail_offers_kind_check CHECK (kind IN ('item_percent', 'item_amount', 'category_percent', 'bill_percent', 'bill_amount', 'buy_x_get_y', 'product_percent'));
ALTER TABLE retail_offers DROP CONSTRAINT retail_offers_check3,
  ADD CONSTRAINT retail_offers_check3 CHECK (kind NOT IN ('item_percent', 'category_percent', 'bill_percent', 'buy_x_get_y', 'product_percent') OR value <= 100);
ALTER TABLE retail_offers ADD CONSTRAINT retail_offers_product_kind CHECK ((kind = 'product_percent') = (product_id IS NOT NULL));
CREATE INDEX retail_offers_product ON retail_offers(business_id, product_id) WHERE product_id IS NOT NULL;

-- --- Apparel GST by price per piece ---------------------------------------------------

CREATE TABLE fashion_gst_price_slabs (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Per-piece value (before GST, after discounts) up to which the lower rate applies.
  threshold NUMERIC(14,2) NOT NULL DEFAULT 2500 CHECK (threshold > 0),
  rate_low NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (rate_low >= 0 AND rate_low <= 100),
  rate_high NUMERIC(5,2) NOT NULL DEFAULT 18 CHECK (rate_high >= 0 AND rate_high <= 100),
  -- Also these categories (and their sub-categories), besides every size × colour variant.
  category_ids BIGINT[] NOT NULL DEFAULT '{}',
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (rate_high >= rate_low)
);

-- --- Exchange credit vouchers -----------------------------------------------------------

ALTER TABLE business_exchanges DROP CONSTRAINT business_exchanges_method_check,
  ADD CONSTRAINT business_exchanges_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'on_account', 'voucher'));
-- An exchange with no bill: the return still goes on a real sale of that item
-- (the most recent one within the policy), and the person says why.
ALTER TABLE business_exchanges ADD COLUMN no_bill BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE business_exchange_vouchers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  voucher_no VARCHAR(30) NOT NULL CHECK (voucher_no ~ '^CV[0-9]{6,10}$'),
  contact_id BIGINT,
  customer_name VARCHAR(150),
  customer_phone VARCHAR(30),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  used NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (used >= 0),
  expires_on DATE NOT NULL,
  -- The sale whose credit became this voucher (a credit-note refund on it).
  source_document_id BIGINT NOT NULL,
  exchange_id BIGINT,
  request_key UUID NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, source_document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, exchange_id) REFERENCES business_exchanges(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, voucher_no),
  UNIQUE (business_id, request_key),
  CHECK (used <= amount)
);
CREATE INDEX business_exchange_vouchers_open ON business_exchange_vouchers(business_id, expires_on) WHERE used < amount;

CREATE TABLE business_exchange_voucher_uses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  voucher_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  payment_id BIGINT NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, voucher_id) REFERENCES business_exchange_vouchers(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, payment_id)
);
CREATE INDEX business_exchange_voucher_uses_voucher ON business_exchange_voucher_uses(business_id, voucher_id);

-- A voucher's amount never changes and "used" only grows; uses are append-only.
CREATE FUNCTION business_exchange_vouchers_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A credit voucher cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.used < OLD.used OR (to_jsonb(NEW) - ARRAY['used']) <> (to_jsonb(OLD) - ARRAY['used']) THEN
    RAISE EXCEPTION 'A credit voucher can only be spent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_exchange_vouchers_rules BEFORE UPDATE OR DELETE ON business_exchange_vouchers
  FOR EACH ROW EXECUTE FUNCTION business_exchange_vouchers_rules();
CREATE FUNCTION business_exchange_voucher_uses_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A voucher use cannot be changed' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_exchange_voucher_uses_fixed BEFORE UPDATE OR DELETE ON business_exchange_voucher_uses
  FOR EACH ROW EXECUTE FUNCTION business_exchange_voucher_uses_fixed();

-- --- Faulty / DOA units -----------------------------------------------------------------

CREATE TABLE electronics_faulty_units (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  serial VARCHAR(100) NOT NULL CHECK (btrim(serial) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('doa', 'faulty')),
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  -- awaiting_supplier: in stock but not sellable; sent: gone back on a
  -- purchase return; restocked: found fine, sellable again; written_off.
  status TEXT NOT NULL DEFAULT 'awaiting_supplier' CHECK (status IN ('awaiting_supplier', 'sent', 'restocked', 'written_off')),
  original_document_id BIGINT,
  exchange_id BIGINT,
  replacement_sku_id BIGINT,
  replacement_serial VARCHAR(100),
  supplier_contact_id BIGINT,
  purchase_document_id BIGINT,
  purchase_return_id BIGINT,
  claim_no VARCHAR(60),
  closed_note VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, replacement_sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, original_document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, exchange_id) REFERENCES business_exchanges(business_id, id),
  FOREIGN KEY (business_id, supplier_contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, purchase_document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, purchase_return_id) REFERENCES business_returns(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((status = 'sent') = (purchase_return_id IS NOT NULL))
);
CREATE UNIQUE INDEX electronics_faulty_units_one_open ON electronics_faulty_units(business_id, sku_id, serial) WHERE status = 'awaiting_supplier';
CREATE INDEX electronics_faulty_units_list ON electronics_faulty_units(business_id, status, created_at DESC);

-- A unit waiting for the supplier is not sold.
CREATE FUNCTION electronics_faulty_not_sold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lot_code <> '' AND EXISTS (SELECT 1 FROM electronics_faulty_units f WHERE f.business_id = NEW.business_id AND f.sku_id = NEW.sku_id
       AND f.serial = NEW.lot_code AND f.status = 'awaiting_supplier')
     AND EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id AND d.kind = 'sale') THEN
    RAISE EXCEPTION '% is marked faulty and waits for the supplier; it cannot be sold', NEW.lot_code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER electronics_faulty_not_sold BEFORE INSERT ON business_document_lines
  FOR EACH ROW EXECUTE FUNCTION electronics_faulty_not_sold();

-- --- Warranty claims against the brand ---------------------------------------------------

CREATE TABLE electronics_warranty_claims (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  job_id BIGINT NOT NULL,
  warranty_id BIGINT,
  brand VARCHAR(100) NOT NULL CHECK (btrim(brand) <> ''),
  supplier_contact_id BIGINT,
  claim_no VARCHAR(60),
  part_cost NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (part_cost >= 0),
  status TEXT NOT NULL DEFAULT 'raised' CHECK (status IN ('raised', 'submitted', 'approved', 'rejected', 'credited')),
  credited_amount NUMERIC(16,2) CHECK (credited_amount >= 0),
  notes VARCHAR(500),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, job_id) REFERENCES electronics_repair_jobs(business_id, id),
  FOREIGN KEY (business_id, warranty_id) REFERENCES electronics_warranties(business_id, id),
  FOREIGN KEY (business_id, supplier_contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((status = 'credited') = (credited_amount IS NOT NULL))
);
CREATE INDEX electronics_warranty_claims_list ON electronics_warranty_claims(business_id, status, created_at DESC);
CREATE INDEX electronics_warranty_claims_job ON electronics_warranty_claims(business_id, job_id);

-- --- Repairs ----------------------------------------------------------------------------

ALTER TABLE electronics_repair_jobs DROP CONSTRAINT electronics_repair_jobs_status_check,
  ADD CONSTRAINT electronics_repair_jobs_status_check
  CHECK (status IN ('received', 'diagnosing', 'waiting_parts', 'in_repair', 'awaiting_approval', 'ready', 'delivered', 'cancelled'));
ALTER TABLE electronics_repair_jobs
  ADD COLUMN passcode VARCHAR(60),
  ADD COLUMN checklist JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN advance_collection_id BIGINT,
  ADD CONSTRAINT electronics_repair_jobs_advance_fkey FOREIGN KEY (business_id, advance_collection_id) REFERENCES business_collections(business_id, id),
  ADD CONSTRAINT electronics_repair_jobs_checklist_object CHECK (jsonb_typeof(checklist) = 'object'),
  ADD CONSTRAINT electronics_repair_jobs_passcode_cleared CHECK (status NOT IN ('delivered', 'cancelled') OR passcode IS NULL);
-- Closed jobs keep no passcode (existing rows have none).

ALTER TABLE electronics_models ADD COLUMN helpline VARCHAR(60);

-- --- Permissions ---------------------------------------------------------------------------
-- Warranty claims use repairs.edit / repairs.view; faulty units use
-- inventory.edit / inventory.view; vouchers use exchanges.* and sales.*;
-- markdowns use offers.create / offers.edit; the GST rule settings.edit.

-- Down Migration
DROP TRIGGER electronics_faulty_not_sold ON business_document_lines;
DROP FUNCTION electronics_faulty_not_sold();
ALTER TABLE electronics_models DROP COLUMN helpline;
ALTER TABLE electronics_repair_jobs DROP CONSTRAINT electronics_repair_jobs_passcode_cleared,
  DROP CONSTRAINT electronics_repair_jobs_checklist_object,
  DROP CONSTRAINT electronics_repair_jobs_advance_fkey,
  DROP COLUMN advance_collection_id, DROP COLUMN checklist, DROP COLUMN passcode;
UPDATE electronics_repair_jobs SET status = 'in_repair' WHERE status = 'awaiting_approval';
ALTER TABLE electronics_repair_jobs DROP CONSTRAINT electronics_repair_jobs_status_check,
  ADD CONSTRAINT electronics_repair_jobs_status_check
  CHECK (status IN ('received', 'diagnosing', 'waiting_parts', 'in_repair', 'ready', 'delivered', 'cancelled'));
DROP TABLE electronics_warranty_claims;
DROP TABLE electronics_faulty_units;
DROP TABLE business_exchange_voucher_uses;
DROP FUNCTION business_exchange_voucher_uses_fixed();
DROP TABLE business_exchange_vouchers;
DROP FUNCTION business_exchange_vouchers_rules();
ALTER TABLE business_exchanges DROP COLUMN no_bill;
ALTER TABLE business_exchanges DROP CONSTRAINT business_exchanges_method_check,
  ADD CONSTRAINT business_exchanges_method_check CHECK (method IN ('cash', 'card', 'upi', 'bank', 'on_account'));
DROP TABLE fashion_gst_price_slabs;
DELETE FROM retail_offers WHERE kind = 'product_percent';
DROP INDEX retail_offers_product;
ALTER TABLE retail_offers DROP CONSTRAINT retail_offers_product_kind;
ALTER TABLE retail_offers DROP CONSTRAINT retail_offers_check3,
  ADD CONSTRAINT retail_offers_check3 CHECK (kind NOT IN ('item_percent', 'category_percent', 'bill_percent', 'buy_x_get_y') OR value <= 100);
ALTER TABLE retail_offers DROP CONSTRAINT retail_offers_kind_check,
  ADD CONSTRAINT retail_offers_kind_check CHECK (kind IN ('item_percent', 'item_amount', 'category_percent', 'bill_percent', 'bill_amount', 'buy_x_get_y'));
ALTER TABLE retail_offers DROP CONSTRAINT retail_offers_product_fkey, DROP COLUMN product_id;
DELETE FROM platform_module_business_types WHERE (module_code, business_type) IN (('offers', 'fashion'), ('loyalty', 'fashion'), ('offers', 'electronics'));
UPDATE platform_module_business_types SET enabled_by_default = TRUE WHERE module_code = 'weight' AND business_type = 'fashion';
UPDATE platform_module_business_types SET enabled_by_default = FALSE WHERE module_code = 'exchanges' AND business_type = 'electronics';
