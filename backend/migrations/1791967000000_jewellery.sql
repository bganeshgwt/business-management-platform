-- Up Migration
-- A jeweller's own tools: the day's gold, silver and platinum rates by
-- purity, set by a manager and shown on a rate board; tagged pieces, each a
-- serial-numbered unit of its catalogue item in stock with its weights,
-- stones, making charge and hallmark; the jewellery bill; old gold bought
-- from customers or taken in exchange; gold savings schemes, turned into
-- jewellery within the year; and the shop's own metal from melted pieces and
-- old gold.
--
-- Gold rates & jewellery (module "jewellery", on for type "jewellery"):
--   jewellery_rate_sheets   each sheet of rates a manager sets: the business's
--                           date it is for (set by the database), morning or
--                           evening, where the rates come from (the shop's own,
--                           the local association's, or the IBJA rate typed in)
--                           and a note. A sheet is never changed or deleted: a
--                           correction is a new sheet, and the latest sheet of
--                           a day that rates a purity gives that purity's rate.
--   jewellery_rates         each purity's selling rate per gram and the rate
--                           per gram the shop pays for old metal of it, written
--                           with its sheet. Gold is rated by carat with its
--                           fineness (24K 999, 22K 916, 18K 750, 14K 585),
--                           silver at 999 and 925, platinum at 950.
--   jewellery_settings      how new tags are numbered (letters and the last
--                           number given), the hallmarking charge a new
--                           hallmarked piece starts with, the deduction a line
--                           of old gold starts with, any lower limit of the
--                           shop's own on cash paid out for old gold, the cash
--                           report's own alert level, and whether the owner
--                           says the shop is a PMLA reporting entity.
--   jewellery_items         a catalogue item sold as tagged pieces priced by
--                           weight (goods counted in pieces, serial-numbered,
--                           at 3% GST), with what a new piece of it starts
--                           with: metal and purity, wastage and making charge.
--   jewellery_pieces        a tagged piece: a serial-numbered unit of its item
--                           in stock, its tag the serial number; its words for
--                           the bill, metal and purity, gross and stone weight
--                           (the net weight is gross less stones, to the
--                           milligram), wastage as a percentage of the net
--                           weight, the making charge (per gram, a percentage
--                           of the metal's value, or flat), whether it is
--                           hallmarked with its hallmarking charge, an
--                           exemption from mandatory hallmarking where one
--                           applies, and its status: in stock, on approval
--                           with a customer, at the karigar, sold or melted.
--                           Its price is never stored: a bill works it out
--                           from the day's rate.
--   jewellery_piece_huids   each HUID of a piece's BIS hallmark (a set may
--                           carry several; a HUID belongs to one article).
--   jewellery_piece_stones  each stone on a piece: its kind (a "diamond" is
--                           natural; a man-made one is a laboratory-grown
--                           diamond), how many, carats, grade, certificate,
--                           treatment and value.
--   jewellery_piece_events  everything that happened to a piece, as written.
--   jewellery_metal_movements  the shop's own metal by purity at a location,
--                           in grams of metal and of fine metal: what melted
--                           pieces left and old gold taken in, for melting and
--                           refining.
--   jewellery_locations     whether a location's district is under mandatory
--                           hallmarking, as the owner confirms it (a location
--                           not confirmed is taken as under it).
--   jewellery_scheme_plans  the gold schemes the shop offers: 2 to 11 monthly
--                           instalments, the smallest monthly amount, and the
--                           discount given on the bill that redeems a scheme
--                           with every instalment paid (a percentage of one
--                           instalment; never called interest), with the
--                           terms as printed. A plan's terms never change.
--   jewellery_schemes       a customer's scheme (GS/2627/0001): the plan's
--                           terms as they were when they joined, their monthly
--                           amount, nominee, when they accepted the terms, the
--                           day of the first instalment, its maturity and the
--                           day it closes by (364 days on); stopped with a
--                           manager's approval (no more instalments, no
--                           discount), redeemed once by a jewellery bill.
--   jewellery_scheme_instalments  each instalment paid, as a core collection
--                           receipt of the customer's money (a receipt, not a
--                           sale). A scheme's instalments pay only the bill
--                           that redeems it and are never paid back in money.
--   jewellery_bills         a sale of tagged pieces posted by the jewellery
--                           bill (an ordinary core sale, where the cash limit
--                           and the PAN rule apply), with the rules it was
--                           billed under: the rates' date, the district's
--                           mandatory hallmarking, the turnover exemption; and
--                           the gold scheme it redeems with its discount.
--   jewellery_bill_lines    each piece as billed: what BIS asks the invoice to
--                           show for each article (description, net weight,
--                           purity in carat and fineness, hallmarking charge,
--                           the HUID) and how its price was made, to the paisa:
--                           net weight × the day's latest rate for its purity,
--                           wastage, making, stones and hallmarking, then 3%
--                           GST, with why the HUID check let it through.
--   jewellery_old_gold      an old gold voucher (OG/2627/0001): gold, silver
--                           or platinum a customer sells to the shop or gives
--                           in exchange, at the location that takes it in: the
--                           seller (a customer, with the photo ID seen, and
--                           the PAN or a Form 97 declaration when it is worth
--                           more than ₹2,00,000), their declaration that it is
--                           theirs to sell, and its weight and value. Its
--                           value is paid out in money, used on the seller's
--                           jewellery bills, or both in parts; a voucher with
--                           nothing paid out or used is cancelled, never deleted.
--   jewellery_old_gold_lines   each article as tested and valued: how it was
--                           tested (karatmeter (XRF), touchstone, acid, fire
--                           assay) and the fineness found, the gross weight less
--                           stones and dirt, the net and fine weight, the
--                           deduction, and its value at the day's latest buy
--                           rate for the purity it is valued as, to the paisa.
--   jewellery_old_gold_uses    the voucher's value used on a jewellery bill (a
--                           payment by old gold: a credit note, no money
--                           moves), and put back on the voucher when that bill
--                           is returned.
--   jewellery_old_gold_payouts its value paid out in money (cash, UPI, bank
--                           transfer), each written in the expense book. A
--                           seller does not receive ₹2,00,000 or more in cash
--                           for old gold in a day or for one voucher; the shop
--                           may set a lower limit of its own.
-- Gold of 2 g or more is sold only with its BIS hallmark's HUID, unless the
-- article is left out of the hallmarking order, the owner marked the business
-- exempt by its turnover (up to ₹40 lakh), or the location's district is not
-- under mandatory hallmarking (the database checks it on every bill line). A
-- piece taken back on its bill's credit note comes back into stock; money goes
-- back on a jewellery bill only as far as money was paid on it at the counter
-- (what old gold paid goes back on its voucher; a gold scheme's instalments are
-- never paid back).
-- A jewellery item's pieces are sold only on the jewellery bill (the API
-- refuses its item on any other sale), and a piece comes into stock on a
-- purchase with its number or with its tag (a stock correction with its
-- reason), never twice.
-- Type-only role "karigar": a goldsmith who sees the pieces and their
-- weights, and no prices or money.

-- --- Module, permissions and roles ------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('jewellery', 'Gold rates & jewellery', 'The day''s gold, silver and platinum rates by purity with a rate board; tagged pieces priced by weight at the day''s rate with making, wastage, stones and hallmarking, billed with what BIS asks on the invoice and the HUID check; old gold bought or taken in exchange; gold savings schemes closed within the year; the cash report.', 'optional', 239);

-- A piece is a serial-numbered unit of its catalogue item (the tag is its number),
-- so a jeweller keeps serial numbers from the start.
INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('jewellery', 'catalog'), ('jewellery', 'contacts'), ('jewellery', 'sales'), ('jewellery', 'inventory'), ('jewellery', 'serials');
UPDATE platform_module_business_types SET enabled_by_default = TRUE WHERE module_code = 'serials' AND business_type = 'jewellery';
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('jewellery', 'jewellery', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('jewellery', 'view', 'See today''s rates, the pieces and their tags, old gold and gold schemes', 530),
 ('jewellery', 'create', 'Make jewellery bills, take in old gold, and enrol customers in gold schemes and take their instalments', 531),
 ('jewellery', 'edit', 'Tag pieces, record their weights, stones and HUIDs, and send them on approval or to the karigar', 532),
 ('jewellery', 'approve', 'Set the day''s rates, pay out for old gold, melt pieces, set up gold scheme plans and approve stopping a gold scheme', 533),
 ('jewellery', 'cancel', 'Cancel old gold not yet paid for or used on a bill, and stop gold schemes', 534),
 ('jewellery', 'print', 'Print tags, old gold vouchers and scheme passbooks', 535),
 ('jewellery', 'export', 'See and export the cash report, and export the money held for gold schemes', 536)
) AS p(module_code, action, name, sort_order);

-- A goldsmith of the shop: sees the pieces and their weights, tags pieces,
-- records their stones and HUIDs, sends them for work and takes them back.
INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types) VALUES
 ('karigar', 'Karigar / goldsmith', 'Sees the pieces and their weights, tags pieces, records their stones and HUIDs, and sends them for work and takes them back. Sees no prices and takes no money.', FALSE, 39, ARRAY['jewellery']);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'jewellery'
UNION ALL SELECT 'cashier', unnest(ARRAY['jewellery.view', 'jewellery.create', 'jewellery.edit', 'jewellery.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['jewellery.view', 'jewellery.edit', 'jewellery.print'])
UNION ALL SELECT 'accountant', unnest(ARRAY['jewellery.view', 'jewellery.print', 'jewellery.export'])
UNION ALL SELECT 'viewer', unnest(ARRAY['jewellery.view'])
UNION ALL SELECT 'karigar', unnest(ARRAY['jewellery.view', 'jewellery.edit', 'catalog.view', 'inventory.view']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template"), and the new
-- role in existing jewellery shops.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'jewellery'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;
SELECT business_seed_roles(id) FROM businesses WHERE business_type = 'jewellery';

-- Existing jewellery shops get the tools a new one starts with: serial
-- numbers first, then this module (each where what it needs is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'serials'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'jewellery'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- The purities a jeweller rates and sells by, and the fineness of each
-- (parts of pure metal in a thousand); NULL for any other.
CREATE FUNCTION jewellery_fineness(metal TEXT, purity TEXT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE metal
    WHEN 'gold' THEN CASE purity WHEN '24K' THEN 999 WHEN '22K' THEN 916 WHEN '18K' THEN 750 WHEN '14K' THEN 585 END
    WHEN 'silver' THEN CASE purity WHEN '999' THEN 999 WHEN '925' THEN 925 END
    WHEN 'platinum' THEN CASE purity WHEN '950' THEN 950 END
  END::NUMERIC;
$$;

-- History is kept as it was written.
CREATE FUNCTION jewellery_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME IN ('jewellery_rate_sheets', 'jewellery_rates') THEN
    RAISE EXCEPTION 'A rate sheet is kept as it was set: set a new sheet to correct a rate' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_piece_events' THEN
    RAISE EXCEPTION 'A piece''s history is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_metal_movements' THEN
    RAISE EXCEPTION 'A movement of the shop''s metal is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('jewellery_bills', 'jewellery_bill_lines') THEN
    RAISE EXCEPTION 'A jewellery bill is kept as it was billed: return a piece on the bill to take it back' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('jewellery_old_gold_lines', 'jewellery_old_gold_uses', 'jewellery_old_gold_payouts') THEN
    RAISE EXCEPTION 'An old gold voucher is kept as it was written, with what was paid out and used on it' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_scheme_instalments' THEN
    RAISE EXCEPTION 'A gold scheme''s instalments are kept as they were paid' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'This record is kept as it was written' USING ERRCODE = '23514';
END $$;

-- numerator ÷ denominator in rupees to the paisa, halves up (both positive),
-- worked out exactly (an old gold line's value divides by its purity's fineness).
CREATE FUNCTION jewellery_money(numerator NUMERIC, denominator NUMERIC) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT div(numerator * 200 + denominator, denominator * 2) / 100;
$$;

-- Old gold vouchers (OG/2627/0001) and gold schemes (GS/2627/0001) are
-- numbered. The kinds list is widened by reading the current one, so kinds
-- other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'old_gold' = ANY(kinds) THEN kinds := array_append(kinds, 'old_gold'::text); END IF;
  IF NOT 'gold_scheme' = ANY(kinds) THEN kinds := array_append(kinds, 'gold_scheme'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- Words a jeweller never uses for a man-made diamond: IS 19469:2025 allows
-- "laboratory-grown" and "laboratory-created", and not "lab grown", "lab
-- created", "lab diamond" or "LGD".
CREATE FUNCTION jewellery_plain_words(words TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT words IS NULL OR words !~* '\m(lgd|lab[ -]?grown|lab[ -]?created|lab[ -]?diamonds?)\M';
$$;

-- --- Settings ------------------------------------------------------------------------------------

-- One row per business, made when the settings are first saved or the first tag is given.
CREATE TABLE jewellery_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- Tags: the letters a new tag number starts with (T00001), and the last number given.
  tag_prefix VARCHAR(6) NOT NULL DEFAULT 'T' CHECK (tag_prefix ~ '^[A-Z]{0,6}$'),
  last_tag_no INTEGER NOT NULL DEFAULT 0 CHECK (last_tag_no >= 0),
  -- The hallmarking charge a new hallmarked piece starts with (each piece keeps its own).
  hallmark_charge NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (hallmark_charge BETWEEN 0 AND 10000),
  -- The owner says the business's annual turnover is up to ₹40 lakh: mandatory hallmarking leaves it out.
  turnover_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  turnover_confirmed_by BIGINT REFERENCES users(id),
  turnover_confirmed_at TIMESTAMPTZ,
  -- Old gold: the deduction a new line starts with (a percentage of its
  -- value), and the shop's own lower limit on cash paid out for old gold to one
  -- seller in a day (none: a seller does not receive ₹2,00,000 or more in cash).
  old_gold_deduction NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (old_gold_deduction >= 0 AND old_gold_deduction < 100),
  old_gold_cash_limit NUMERIC(12,2) CHECK (old_gold_cash_limit > 0 AND old_gold_cash_limit < 200000),
  -- The cash report: the shop's own alert level for cash with one customer in
  -- a month (below ₹10 lakh; none: only ₹10 lakh is flagged), and whether the
  -- owner says the shop is a reporting entity under the PMLA, with who said it and when.
  cash_watch_level NUMERIC(12,2) CHECK (cash_watch_level > 0 AND cash_watch_level < 1000000),
  reporting_entity BOOLEAN NOT NULL DEFAULT FALSE,
  reporting_entity_by BIGINT REFERENCES users(id),
  reporting_entity_at TIMESTAMPTZ,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((turnover_confirmed_by IS NULL) = (turnover_confirmed_at IS NULL)),
  CHECK (NOT turnover_exempt OR turnover_confirmed_at IS NOT NULL),
  CHECK ((reporting_entity_by IS NULL) = (reporting_entity_at IS NULL)),
  CHECK (NOT reporting_entity OR reporting_entity_at IS NOT NULL)
);

-- Whether a location's district is under mandatory hallmarking, as the owner
-- confirms it; a location with no row is taken as under it.
CREATE TABLE jewellery_locations (
  business_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  district VARCHAR(80) CHECK (btrim(district) <> ''),
  mandatory_hallmarking BOOLEAN NOT NULL,
  confirmed_by BIGINT NOT NULL REFERENCES users(id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, location_id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id)
);

-- --- Today's rates ---------------------------------------------------------------------------------

CREATE TABLE jewellery_rate_sheets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The business's date the rates are for (set by the database from when they were set).
  rate_date DATE NOT NULL,
  session TEXT NOT NULL CHECK (session IN ('morning', 'evening')),
  -- Where the rates come from: the shop's own, the local association's, or the IBJA rate typed in.
  source TEXT NOT NULL CHECK (source IN ('shop', 'association', 'ibja')),
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX jewellery_rate_sheets_day ON jewellery_rate_sheets(business_id, rate_date DESC, created_at DESC, id DESC);

-- A sheet is for the business's own date when it is set.
CREATE FUNCTION jewellery_rate_sheets_day() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.rate_date := (NEW.created_at AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_rate_sheets_day BEFORE INSERT ON jewellery_rate_sheets
  FOR EACH ROW EXECUTE FUNCTION jewellery_rate_sheets_day();
CREATE TRIGGER jewellery_rate_sheets_append_only BEFORE UPDATE OR DELETE ON jewellery_rate_sheets
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

CREATE TABLE jewellery_rates (
  business_id BIGINT NOT NULL,
  sheet_id BIGINT NOT NULL,
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  -- Per gram: what the shop sells at, and what it pays for old metal of this purity (none: it does not buy it).
  sell_rate NUMERIC(12,2) NOT NULL CHECK (sell_rate > 0),
  buy_rate NUMERIC(12,2) CHECK (buy_rate > 0),
  PRIMARY KEY (business_id, sheet_id, metal, purity),
  FOREIGN KEY (business_id, sheet_id) REFERENCES jewellery_rate_sheets(business_id, id),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL)
);
CREATE INDEX jewellery_rates_purity ON jewellery_rates(business_id, metal, purity);

-- A rate goes on its sheet when the sheet is set.
CREATE FUNCTION jewellery_rates_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT created_at FROM jewellery_rate_sheets WHERE business_id = NEW.business_id AND id = NEW.sheet_id) <> now() THEN
    RAISE EXCEPTION 'A rate goes on its sheet when the sheet is set: set a new sheet' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_rates_check BEFORE INSERT ON jewellery_rates
  FOR EACH ROW EXECUTE FUNCTION jewellery_rates_check();
CREATE TRIGGER jewellery_rates_append_only BEFORE UPDATE OR DELETE ON jewellery_rates
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- The rate of a purity in use now: the latest sheet of the business's date that rates it.
CREATE FUNCTION jewellery_current_rate(target_business BIGINT, target_metal TEXT, target_purity TEXT)
RETURNS TABLE (sheet_id BIGINT, sell_rate NUMERIC, buy_rate NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT r.sheet_id, r.sell_rate, r.buy_rate FROM jewellery_rates r
  JOIN jewellery_rate_sheets s ON s.business_id = r.business_id AND s.id = r.sheet_id
  JOIN businesses b ON b.id = s.business_id
  WHERE r.business_id = target_business AND r.metal = target_metal AND r.purity = target_purity
    AND s.rate_date = (now() AT TIME ZONE b.timezone)::date
  ORDER BY s.created_at DESC, s.id DESC LIMIT 1;
$$;

-- --- Jewellery items and their pieces ----------------------------------------------------------

-- A catalogue item a jeweller sells as tagged pieces priced by weight (a gold
-- necklace, a silver anklet), with what a new piece of it starts with.
CREATE TABLE jewellery_items (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  wastage_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (wastage_percent BETWEEN 0 AND 100),
  making_mode TEXT NOT NULL DEFAULT 'per_gram' CHECK (making_mode IN ('per_gram', 'percent', 'flat')),
  making_value NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (making_value >= 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (making_mode <> 'percent' OR making_value <= 100)
);

-- A jewellery item is goods counted in pieces with serial numbers, at the 3%
-- slab (jewellery of precious metal, with its making and stones, is one supply
-- at 3%); it keeps its item and is never deleted.
CREATE FUNCTION jewellery_items_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A jewellery item is never deleted; switch its catalogue item off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sku_id <> OLD.sku_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A jewellery item keeps its catalogue item' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT s.label, s.tracking, s.tax_rate, p.kind, u.kind AS unit_kind INTO item FROM catalog_skus s
    JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
    JOIN business_units u ON u.business_id = s.business_id AND u.code = s.unit
  WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
  IF item.kind IS DISTINCT FROM 'goods' OR item.tracking IS DISTINCT FROM 'serial' OR item.unit_kind IS DISTINCT FROM 'count' THEN
    RAISE EXCEPTION '% must be goods counted in pieces, with serial numbers, to have tagged pieces', item.label USING ERRCODE = '23514';
  END IF;
  IF item.tax_rate <> 3 THEN
    RAISE EXCEPTION '% is at % GST: jewellery of gold, silver or platinum, with its making and stones, is billed at 3%%', item.label,
      rtrim(rtrim(item.tax_rate::text, '0'), '.') || '%' USING ERRCODE = '23514';
  END IF;
  IF NOT jewellery_plain_words(item.label) THEN
    RAISE EXCEPTION '%: write "laboratory-grown" or "laboratory-created" for a man-made diamond', item.label USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_items_check BEFORE INSERT OR UPDATE OR DELETE ON jewellery_items
  FOR EACH ROW EXECUTE FUNCTION jewellery_items_check();

-- A tagged piece: a serial-numbered unit of its jewellery item in stock, its
-- tag the serial number, with what is weighed, charged and marked on it.
CREATE TABLE jewellery_pieces (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  tag_no VARCHAR(20) NOT NULL CHECK (tag_no ~ '^[A-Z0-9][A-Z0-9/-]{0,19}$'),
  -- The piece's own words on the bill (its item's name when none).
  description VARCHAR(150) CHECK (btrim(description) <> '' AND jewellery_plain_words(description)),
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  -- In grams to the milligram: the whole piece, its stones (and beads or thread), and the metal (gross less stones).
  gross_weight NUMERIC(10,3) NOT NULL CHECK (gross_weight > 0),
  stone_weight NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (stone_weight >= 0),
  net_weight NUMERIC(10,3) GENERATED ALWAYS AS (gross_weight - stone_weight) STORED,
  -- Wastage (value addition) as a percentage of the net weight, priced at the
  -- day's rate; the making charge per gram of net weight, as a percentage of
  -- the metal's value, or flat for the piece.
  wastage_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (wastage_percent BETWEEN 0 AND 100),
  making_mode TEXT NOT NULL CHECK (making_mode IN ('per_gram', 'percent', 'flat')),
  making_value NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (making_value >= 0),
  -- Hallmarked by BIS (its HUIDs in jewellery_piece_huids), and its hallmarking charge on the bill.
  hallmarked BOOLEAN NOT NULL DEFAULT FALSE,
  hallmark_charge NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (hallmark_charge >= 0),
  -- Gold the hallmarking order leaves out, when it is: Kundan, Polki or Jadau;
  -- a watch or a fountain pen; gold thread; bullion; a medical, dental,
  -- veterinary, scientific or industrial article; semi-finished; for export.
  exemption TEXT CHECK (exemption IN ('kundan_polki_jadau', 'watch_or_pen', 'gold_thread', 'bullion', 'medical_scientific', 'semi_finished', 'export')),
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'on_approval', 'at_karigar', 'sold', 'melted')),
  -- Who has it while it is on approval or at the karigar.
  with_whom VARCHAR(150) CHECK (btrim(with_whom) <> ''),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES jewellery_items(business_id, sku_id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, tag_no),
  UNIQUE (business_id, request_key),
  CHECK (stone_weight < gross_weight),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (making_mode <> 'percent' OR making_value <= 100),
  CHECK (hallmarked OR hallmark_charge = 0),
  CHECK (exemption IS NULL OR metal = 'gold'),
  CHECK ((status IN ('on_approval', 'at_karigar')) = (with_whom IS NOT NULL))
);
CREATE INDEX jewellery_pieces_item ON jewellery_pieces(business_id, sku_id);
CREATE INDEX jewellery_pieces_status ON jewellery_pieces(business_id, status, id DESC);

-- A piece is tagged on a unit of its item in stock, and starts in stock. It
-- keeps its item and tag, and is never deleted. It goes from in stock to on
-- approval or the karigar and back; it is sold on a jewellery bill made in the
-- same transaction, and comes back into stock from sold only when its bill
-- line is returned; it is melted once its unit has left stock; a sold or
-- melted piece keeps what it was. A piece with a HUID is hallmarked.
CREATE FUNCTION jewellery_pieces_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A piece is never deleted: sell it or melt it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'in_stock' THEN
      RAISE EXCEPTION 'A piece starts in stock' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_stock_lots WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id AND lot_code = NEW.tag_no AND quantity > 0) THEN
      RAISE EXCEPTION 'Tag % is not a unit of its item in stock: a piece is tagged on a unit received on a purchase, or brought into stock with its tag', NEW.tag_no
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.sku_id <> OLD.sku_id OR NEW.tag_no <> OLD.tag_no OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash THEN
    RAISE EXCEPTION 'Piece % keeps its item and its tag', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  -- (net_weight is generated after this trigger runs: the weights it comes from are compared instead.)
  IF OLD.status IN ('sold', 'melted') AND (to_jsonb(NEW) - ARRAY['status', 'with_whom', 'updated_by', 'updated_at', 'net_weight'])
       <> (to_jsonb(OLD) - ARRAY['status', 'with_whom', 'updated_by', 'updated_at', 'net_weight']) THEN
    RAISE EXCEPTION 'Piece % was % and keeps what it was', OLD.tag_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'in_stock' AND NEW.status IN ('on_approval', 'at_karigar', 'melted', 'sold'))
    OR (OLD.status IN ('on_approval', 'at_karigar') AND NEW.status = 'in_stock')
    OR (OLD.status = 'sold' AND NEW.status = 'in_stock')) THEN
    RAISE EXCEPTION 'Piece % cannot go from % to %', OLD.tag_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'sold' AND OLD.status <> 'sold' AND NOT EXISTS (SELECT 1 FROM jewellery_bill_lines bl
       JOIN jewellery_bills b ON b.business_id = bl.business_id AND b.id = bl.bill_id
       WHERE bl.business_id = NEW.business_id AND bl.piece_id = NEW.id AND b.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % is sold on a jewellery bill', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'sold' AND NEW.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM business_return_lines rl
       JOIN business_returns r ON r.business_id = rl.business_id AND r.id = rl.return_id
       JOIN jewellery_bill_lines bl ON bl.business_id = rl.business_id AND bl.line_id = rl.line_id
       WHERE rl.business_id = NEW.business_id AND bl.piece_id = NEW.id AND r.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % comes back into stock only when its bill line is returned', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'melted' AND OLD.status <> 'melted' AND EXISTS (SELECT 1 FROM business_stock_lots
       WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id AND lot_code = NEW.tag_no AND quantity > 0) THEN
    RAISE EXCEPTION 'Piece % is melted once its unit has left stock', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.hallmarked AND EXISTS (SELECT 1 FROM jewellery_piece_huids WHERE business_id = NEW.business_id AND piece_id = NEW.id) THEN
    RAISE EXCEPTION 'Piece % carries a HUID: it is hallmarked', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_pieces_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_pieces
  FOR EACH ROW EXECUTE FUNCTION jewellery_pieces_guard();

-- The BIS hallmark's HUID on a piece (a set may carry several). A HUID belongs to one article.
CREATE TABLE jewellery_piece_huids (
  business_id BIGINT NOT NULL,
  huid CHAR(6) NOT NULL CHECK (huid ~ '^[A-Z0-9]{6}$'),
  piece_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, huid),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id)
);
CREATE INDEX jewellery_piece_huids_piece ON jewellery_piece_huids(business_id, piece_id);

-- Each stone (or lot of stones) on a piece: what it is (a "diamond" is
-- natural; a man-made one is a laboratory-grown diamond), how many, its
-- carats, its colour, clarity and cut, its certificate, any treatment, and its
-- value on the bill.
CREATE TABLE jewellery_piece_stones (
  business_id BIGINT NOT NULL,
  piece_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 50),
  kind TEXT NOT NULL CHECK (kind IN ('diamond', 'laboratory_grown_diamond', 'ruby', 'emerald', 'sapphire', 'pearl', 'precious', 'semi_precious', 'synthetic', 'imitation', 'other')),
  description VARCHAR(100) CHECK (btrim(description) <> '' AND jewellery_plain_words(description)),
  pieces SMALLINT NOT NULL DEFAULT 1 CHECK (pieces BETWEEN 1 AND 10000),
  carat NUMERIC(8,3) CHECK (carat > 0),
  grade VARCHAR(80) CHECK (btrim(grade) <> '' AND jewellery_plain_words(grade)),
  certificate VARCHAR(80) CHECK (btrim(certificate) <> ''),
  treatment VARCHAR(150) CHECK (btrim(treatment) <> '' AND jewellery_plain_words(treatment)),
  value NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  PRIMARY KEY (business_id, piece_id, seq),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  CHECK (kind NOT IN ('diamond', 'laboratory_grown_diamond') OR description IS NULL OR description !~* '\m(fake|artificial)\M')
);

-- A piece's HUIDs and stones change only while it is in the shop; a HUID goes
-- on a hallmarked piece and is never changed (taken off and given again).
CREATE FUNCTION jewellery_piece_parts_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE piece RECORD; row_business BIGINT; row_piece BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN row_business := OLD.business_id; row_piece := OLD.piece_id;
  ELSE row_business := NEW.business_id; row_piece := NEW.piece_id; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'jewellery_piece_huids' THEN
    RAISE EXCEPTION 'A HUID is never changed: take it off the piece and give the right one' USING ERRCODE = '23514';
  END IF;
  SELECT tag_no, status, hallmarked INTO piece FROM jewellery_pieces WHERE business_id = row_business AND id = row_piece;
  IF piece.status NOT IN ('in_stock', 'on_approval', 'at_karigar') THEN
    RAISE EXCEPTION 'Piece % was % and keeps what it was', piece.tag_no, piece.status USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'jewellery_piece_huids' AND TG_OP = 'INSERT' AND NOT piece.hallmarked THEN
    RAISE EXCEPTION 'Piece % is not hallmarked: a HUID goes on a hallmarked piece', piece.tag_no USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_piece_huids_check BEFORE INSERT OR UPDATE OR DELETE ON jewellery_piece_huids
  FOR EACH ROW EXECUTE FUNCTION jewellery_piece_parts_check();
CREATE TRIGGER jewellery_piece_stones_check BEFORE INSERT OR UPDATE OR DELETE ON jewellery_piece_stones
  FOR EACH ROW EXECUTE FUNCTION jewellery_piece_parts_check();

-- Everything that happened to a piece: tagged, changed (from and to), sent
-- out and back, sold, taken back, melted.
CREATE TABLE jewellery_piece_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  piece_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tagged', 'changed', 'sent', 'back', 'sold', 'returned', 'melted')),
  from_status TEXT,
  to_status TEXT,
  note VARCHAR(500),
  details JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  -- The request that made a change of status (a retry finds it).
  request_key UUID,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX jewellery_piece_events_piece ON jewellery_piece_events(business_id, piece_id, id);
CREATE TRIGGER jewellery_piece_events_append_only BEFORE UPDATE OR DELETE ON jewellery_piece_events
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- --- Gold schemes -----------------------------------------------------------------------------

-- A gold scheme the shop offers: so many monthly instalments (2 to 11), the
-- smallest monthly amount in whole rupees, and the discount given on the
-- jewellery bill that redeems a scheme with every instalment paid, from its
-- maturity (a percentage of one month's instalment), with its terms as
-- printed. The benefit is a discount, and the words "interest" are refused.
-- Its terms never change (a new plan is made instead); it is switched off,
-- never deleted.
CREATE TABLE jewellery_scheme_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> '' AND name !~* '\minterest'),
  instalments SMALLINT NOT NULL CHECK (instalments BETWEEN 2 AND 11),
  min_instalment NUMERIC(12,2) NOT NULL CHECK (min_instalment BETWEEN 100 AND 1000000 AND min_instalment = trunc(min_instalment)),
  discount_percent NUMERIC(5,2) NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  terms TEXT NOT NULL CHECK (btrim(terms) <> '' AND length(terms) <= 4000 AND terms !~* '\minterest'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE UNIQUE INDEX jewellery_scheme_plans_name ON jewellery_scheme_plans(business_id, lower(name));

CREATE FUNCTION jewellery_scheme_plans_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gold scheme plan is never deleted: switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['active', 'updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['active', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'Plan % keeps its terms: make a new plan for other terms', OLD.name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_scheme_plans_guard BEFORE UPDATE OR DELETE ON jewellery_scheme_plans
  FOR EACH ROW EXECUTE FUNCTION jewellery_scheme_plans_guard();

-- A customer's gold scheme (GS/2627/0001): the plan's terms as they were when
-- they joined, their monthly amount, their nominee, the time they accepted the
-- terms, and the days that count: the first instalment's (the day they join),
-- its maturity (the plan's instalments in months on) and the day it closes by
-- (364 days on: the money is turned into a sale within the year). It is
-- active while it takes instalments, stopped when it was cancelled (no more
-- instalments and no discount: what was paid is still used on a jewellery
-- bill, never paid back in money), and redeemed once a jewellery bill uses
-- what was paid.
CREATE TABLE jewellery_schemes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  scheme_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  member_name VARCHAR(150) NOT NULL CHECK (btrim(member_name) <> ''),
  member_phone VARCHAR(30),
  plan_id BIGINT NOT NULL,
  plan_name VARCHAR(80) NOT NULL,
  instalments SMALLINT NOT NULL CHECK (instalments BETWEEN 2 AND 11),
  instalment NUMERIC(12,2) NOT NULL CHECK (instalment > 0 AND instalment = trunc(instalment)),
  discount_percent NUMERIC(5,2) NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  terms TEXT NOT NULL,
  nominee_name VARCHAR(150) CHECK (btrim(nominee_name) <> ''),
  nominee_relation VARCHAR(60) CHECK (btrim(nominee_relation) <> ''),
  terms_accepted_at TIMESTAMPTZ NOT NULL,
  started_on DATE NOT NULL,
  maturity_on DATE NOT NULL,
  close_by DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'redeemed')),
  stop_reason VARCHAR(300) CHECK (btrim(stop_reason) <> ''),
  stopped_by BIGINT REFERENCES users(id),
  stop_approved_by BIGINT REFERENCES users(id),
  stopped_at TIMESTAMPTZ,
  redeemed_document_id BIGINT,
  redeemed_at TIMESTAMPTZ,
  discount NUMERIC(12,2) CHECK (discount >= 0),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, plan_id) REFERENCES jewellery_scheme_plans(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, redeemed_document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, scheme_no),
  UNIQUE (business_id, request_key),
  CHECK (maturity_on = (started_on + make_interval(months => instalments))::date),
  CHECK (close_by = started_on + 364),
  CHECK ((stopped_at IS NULL) = (stop_reason IS NULL) AND (stopped_at IS NULL) = (stopped_by IS NULL) AND (stopped_at IS NULL) = (stop_approved_by IS NULL)),
  CHECK (status <> 'stopped' OR stopped_at IS NOT NULL),
  CHECK ((status = 'redeemed') = (redeemed_document_id IS NOT NULL) AND (redeemed_document_id IS NULL) = (redeemed_at IS NULL)
    AND (redeemed_document_id IS NULL) = (discount IS NULL))
);
CREATE INDEX jewellery_schemes_contact ON jewellery_schemes(business_id, contact_id);
CREATE INDEX jewellery_schemes_open ON jewellery_schemes(business_id, close_by) WHERE status <> 'redeemed';
CREATE TRIGGER jewellery_schemes_customer BEFORE INSERT ON jewellery_schemes
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A scheme is joined today on an active plan, with the plan's terms as they
-- are and a monthly amount of at least the plan's smallest.
CREATE FUNCTION jewellery_schemes_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan RECORD;
BEGIN
  SELECT name, instalments, min_instalment, discount_percent, terms, active INTO plan FROM jewellery_scheme_plans WHERE business_id = NEW.business_id AND id = NEW.plan_id;
  IF NOT plan.active THEN
    RAISE EXCEPTION 'Plan % is switched off: no one joins it', plan.name USING ERRCODE = '23514';
  END IF;
  IF NEW.plan_name <> plan.name OR NEW.instalments <> plan.instalments OR NEW.discount_percent <> plan.discount_percent OR NEW.terms <> plan.terms THEN
    RAISE EXCEPTION 'Scheme % keeps the terms of plan % as they are when it is joined', NEW.scheme_no, plan.name USING ERRCODE = '23514';
  END IF;
  IF NEW.instalment < plan.min_instalment THEN
    RAISE EXCEPTION 'Plan %''s monthly instalment is at least ₹%', plan.name, plan.min_instalment USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'active' OR NEW.created_at <> now() OR NEW.terms_accepted_at > now()
     OR NEW.started_on <> (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date THEN
    RAISE EXCEPTION 'A gold scheme starts today, active, with its terms accepted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_schemes_check BEFORE INSERT ON jewellery_schemes
  FOR EACH ROW EXECUTE FUNCTION jewellery_schemes_check();

-- A scheme keeps what it was joined with and is never deleted. It is stopped
-- once, from active, with the reason, who asked and who approved; it is
-- redeemed once, by the jewellery bill made with it for its member, with the
-- discount the plan gives: one instalment × its percentage, only when every
-- instalment is paid, the scheme was not stopped, and the bill's day is on or
-- after its maturity.
CREATE FUNCTION jewellery_schemes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['status', 'stop_reason', 'stopped_by', 'stop_approved_by', 'stopped_at', 'redeemed_document_id', 'redeemed_at', 'discount'];
  bill RECORD; paid INTEGER; today DATE; earned NUMERIC;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gold scheme is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) THEN
    RAISE EXCEPTION 'Scheme % keeps what it was joined with', OLD.scheme_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (to_jsonb(NEW) - ARRAY['status']) <> (to_jsonb(OLD) - ARRAY['status']) THEN
      RAISE EXCEPTION 'Scheme % is % and keeps what it was', OLD.scheme_no, OLD.status USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'stopped' THEN
    IF OLD.status <> 'active' OR NEW.stopped_at <> now() OR NEW.redeemed_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'Scheme % is stopped once, while it is active', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'redeemed' THEN
    IF OLD.status NOT IN ('active', 'stopped') OR NEW.redeemed_at <> now() OR (NEW.stopped_at IS DISTINCT FROM OLD.stopped_at) THEN
      RAISE EXCEPTION 'Scheme % is redeemed once', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    SELECT b.scheme_discount, b.created_at, d.contact_id INTO bill FROM jewellery_bills b JOIN business_documents d ON d.business_id = b.business_id AND d.id = b.document_id
    WHERE b.business_id = NEW.business_id AND b.document_id = NEW.redeemed_document_id AND b.scheme_id = NEW.id;
    IF NOT FOUND OR bill.created_at <> now() OR bill.contact_id <> NEW.contact_id THEN
      RAISE EXCEPTION 'Scheme % is redeemed on a jewellery bill of its member, made with it', OLD.scheme_no USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO paid FROM jewellery_scheme_instalments WHERE business_id = NEW.business_id AND scheme_id = NEW.id;
    today := (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date;
    earned := CASE WHEN OLD.status = 'active' AND paid = NEW.instalments AND today >= NEW.maturity_on THEN round(NEW.instalment * NEW.discount_percent / 100, 2) ELSE 0 END;
    IF NEW.discount <> earned OR bill.scheme_discount <> earned THEN
      RAISE EXCEPTION 'Scheme %''s discount is ₹%: one instalment × the plan''s percentage, with every instalment paid, from its maturity', OLD.scheme_no, earned
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Scheme % cannot go from % to %', OLD.scheme_no, OLD.status, NEW.status USING ERRCODE = '23514';
END $$;
CREATE TRIGGER jewellery_schemes_guard BEFORE UPDATE OR DELETE ON jewellery_schemes
  FOR EACH ROW EXECUTE FUNCTION jewellery_schemes_guard();

-- A redeemed scheme's instalments all pay the bill that redeems it (checked when the transaction ends).
CREATE FUNCTION jewellery_schemes_redeemed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid NUMERIC; used NUMERIC;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO paid FROM jewellery_scheme_instalments WHERE business_id = NEW.business_id AND scheme_id = NEW.id;
  SELECT COALESCE(sum(p.amount), 0) INTO used FROM business_payments p
    JOIN jewellery_scheme_instalments i ON i.business_id = p.business_id AND i.collection_id = p.collection_id
  WHERE p.business_id = NEW.business_id AND p.document_id = NEW.redeemed_document_id AND i.scheme_id = NEW.id;
  IF used <> paid THEN
    RAISE EXCEPTION 'Scheme %''s ₹% all pays the bill that redeems it', NEW.scheme_no, paid USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jewellery_schemes_redeemed AFTER UPDATE ON jewellery_schemes DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'redeemed' AND OLD.status <> 'redeemed') EXECUTE FUNCTION jewellery_schemes_redeemed();

-- Each instalment paid: its due day (the start's day of the month, so many
-- months on), the collection receipt of the customer's money, and the
-- business's date it was paid on.
CREATE TABLE jewellery_scheme_instalments (
  business_id BIGINT NOT NULL,
  scheme_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 11),
  due_on DATE NOT NULL,
  collection_id BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  paid_on DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, scheme_id, seq),
  FOREIGN KEY (business_id, scheme_id) REFERENCES jewellery_schemes(business_id, id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  UNIQUE (business_id, collection_id)
);
CREATE TRIGGER jewellery_scheme_instalments_append_only BEFORE UPDATE OR DELETE ON jewellery_scheme_instalments
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- An instalment is the next one of an active scheme, before its maturity, of
-- the scheme's monthly amount, on the business's date, paid by the member's
-- own collection receipt made with it (not a credit note); and the cash paid
-- into one scheme stays under ₹2,00,000: its instalments pay one jewellery
-- bill, and one bill takes less than that in cash (Income-tax Act 2025,
-- section 186).
CREATE FUNCTION jewellery_scheme_instalments_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheme RECORD; receipt RECORD; today DATE; paid INTEGER; cash NUMERIC;
BEGIN
  SELECT * INTO scheme FROM jewellery_schemes WHERE business_id = NEW.business_id AND id = NEW.scheme_id;
  today := (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date;
  SELECT count(*) INTO paid FROM jewellery_scheme_instalments WHERE business_id = NEW.business_id AND scheme_id = NEW.scheme_id;
  IF scheme.status <> 'active' OR NEW.seq <> paid + 1 OR NEW.seq > scheme.instalments OR today >= scheme.maturity_on THEN
    RAISE EXCEPTION 'Scheme % takes its next instalment only while it is active, before its maturity on %', scheme.scheme_no, scheme.maturity_on USING ERRCODE = '23514';
  END IF;
  IF NEW.amount <> scheme.instalment OR NEW.paid_on <> today OR NEW.due_on <> (scheme.started_on + make_interval(months => NEW.seq - 1))::date THEN
    RAISE EXCEPTION 'Scheme %''s instalment is its monthly ₹%, on its due day', scheme.scheme_no, scheme.instalment USING ERRCODE = '23514';
  END IF;
  SELECT contact_id, amount, method, created_at INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF receipt.contact_id <> scheme.contact_id OR receipt.amount <> NEW.amount OR receipt.method = 'credit_note' OR receipt.created_at <> now() THEN
    RAISE EXCEPTION 'Scheme %''s instalment is its member''s own receipt of money, made with it', scheme.scheme_no USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(k.amount), 0) INTO cash FROM jewellery_scheme_instalments i JOIN business_collections k ON k.business_id = i.business_id AND k.id = i.collection_id
  WHERE i.business_id = NEW.business_id AND i.scheme_id = NEW.scheme_id AND k.method = 'cash';
  IF receipt.method = 'cash' AND cash + NEW.amount >= 200000 THEN
    RAISE EXCEPTION 'Scheme %''s instalments pay one jewellery bill, and one bill takes less than ₹2,00,000 in cash (Income-tax Act 2025, section 186): cash into it would reach ₹%. Take this one by UPI, card or bank transfer.',
      scheme.scheme_no, (cash + NEW.amount)::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_scheme_instalments_check BEFORE INSERT ON jewellery_scheme_instalments
  FOR EACH ROW EXECUTE FUNCTION jewellery_scheme_instalments_check();

-- A scheme's instalments pay only the jewellery bill that redeems it (the core
-- would otherwise let a customer's receipts pay any bill of theirs).
CREATE FUNCTION jewellery_scheme_payment_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheme RECORD;
BEGIN
  SELECT s.scheme_no, s.redeemed_document_id INTO scheme FROM jewellery_scheme_instalments i
    JOIN jewellery_schemes s ON s.business_id = i.business_id AND s.id = i.scheme_id
  WHERE i.business_id = NEW.business_id AND i.collection_id = NEW.collection_id;
  IF FOUND AND scheme.redeemed_document_id IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'Gold scheme %''s instalments pay only the jewellery bill that redeems it', scheme.scheme_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_payments_jewellery_scheme BEFORE INSERT ON business_payments
  FOR EACH ROW WHEN (NEW.collection_id IS NOT NULL) EXECUTE FUNCTION jewellery_scheme_payment_check();

-- A scheme's instalments are never paid back in money.
CREATE FUNCTION jewellery_scheme_refund_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheme TEXT;
BEGIN
  SELECT s.scheme_no INTO scheme FROM jewellery_scheme_instalments i JOIN jewellery_schemes s ON s.business_id = i.business_id AND s.id = i.scheme_id
  WHERE i.business_id = NEW.business_id AND i.collection_id = NEW.collection_id;
  IF FOUND THEN
    RAISE EXCEPTION 'Gold scheme %''s instalments are never paid back in money: they are used on a jewellery bill', scheme USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_collection_refunds_jewellery_scheme BEFORE INSERT ON business_collection_refunds
  FOR EACH ROW EXECUTE FUNCTION jewellery_scheme_refund_check();

-- --- The jewellery bill ------------------------------------------------------------------------

-- A sale of tagged pieces posted by the jewellery bill (an ordinary core sale),
-- with the rules it was billed under.
CREATE TABLE jewellery_bills (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  document_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  contact_id BIGINT,
  -- The business's date whose rates priced it.
  rate_date DATE NOT NULL,
  -- The hallmarking rules it was billed under: whether the location's district
  -- is under mandatory hallmarking (as the owner confirmed it, or taken as so
  -- until confirmed), and whether the owner marked the business exempt by its
  -- turnover.
  hallmark_mandatory BOOLEAN NOT NULL,
  turnover_exempt BOOLEAN NOT NULL,
  -- The customer's gold scheme it redeems, and the scheme's discount spread over its lines.
  scheme_id BIGINT,
  scheme_discount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (scheme_discount >= 0),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, scheme_id) REFERENCES jewellery_schemes(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, scheme_id),
  CHECK (scheme_id IS NOT NULL OR scheme_discount = 0)
);
CREATE INDEX jewellery_bills_period ON jewellery_bills(business_id, created_at DESC);
CREATE TRIGGER jewellery_bills_append_only BEFORE UPDATE OR DELETE ON jewellery_bills
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- A bill is its own sale, posted in the same transaction at its location to its
-- customer, priced at the rates of the business's date, under the hallmarking
-- rules the business has then.
CREATE FUNCTION jewellery_bills_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc RECORD; rules RECORD;
BEGIN
  SELECT kind, location_id, contact_id, created_at INTO doc FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' OR doc.created_at <> now() OR doc.location_id <> NEW.location_id OR doc.contact_id IS DISTINCT FROM NEW.contact_id THEN
    RAISE EXCEPTION 'A jewellery bill is its own sale, posted with it at its location to its customer' USING ERRCODE = '23514';
  END IF;
  SELECT (now() AT TIME ZONE b.timezone)::date AS today, COALESCE(l.mandatory_hallmarking, TRUE) AS mandatory, COALESCE(s.turnover_exempt, FALSE) AS exempt INTO rules
  FROM businesses b LEFT JOIN jewellery_locations l ON l.business_id = b.id AND l.location_id = NEW.location_id
  LEFT JOIN jewellery_settings s ON s.business_id = b.id WHERE b.id = NEW.business_id;
  IF NEW.rate_date <> rules.today OR NEW.hallmark_mandatory <> rules.mandatory OR NEW.turnover_exempt <> rules.exempt THEN
    RAISE EXCEPTION 'A jewellery bill is priced at today''s rates under the hallmarking rules the business has today' USING ERRCODE = '23514';
  END IF;
  IF NEW.scheme_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jewellery_schemes WHERE business_id = NEW.business_id AND id = NEW.scheme_id
       AND contact_id = NEW.contact_id AND status IN ('active', 'stopped')) THEN
    RAISE EXCEPTION 'A jewellery bill redeems a gold scheme of its own customer, not yet redeemed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_bills_check BEFORE INSERT ON jewellery_bills
  FOR EACH ROW EXECUTE FUNCTION jewellery_bills_check();

-- A bill's lines carry only its scheme's discount, all of it (checked when the transaction ends).
CREATE FUNCTION jewellery_bills_discount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE((SELECT sum(discount) FROM jewellery_bill_lines WHERE business_id = NEW.business_id AND bill_id = NEW.id), 0) <> NEW.scheme_discount THEN
    RAISE EXCEPTION 'A jewellery bill''s lines carry its gold scheme''s discount, ₹%, and no other', NEW.scheme_discount USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jewellery_bills_discount AFTER INSERT ON jewellery_bills DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jewellery_bills_discount();

-- Each piece on a bill, as it was billed: what BIS asks the invoice to show
-- for each article (its description, net weight, purity in carat and
-- fineness, hallmarking charges, and the HUID where it has one) and how its
-- price was made, to the paisa.
CREATE TABLE jewellery_bill_lines (
  business_id BIGINT NOT NULL,
  bill_id BIGINT NOT NULL,
  -- The bill's line that sells it.
  line_id BIGINT NOT NULL,
  piece_id BIGINT NOT NULL,
  tag_no VARCHAR(20) NOT NULL,
  description VARCHAR(150) NOT NULL CHECK (btrim(description) <> '' AND jewellery_plain_words(description)),
  metal TEXT NOT NULL,
  purity TEXT NOT NULL,
  gross_weight NUMERIC(10,3) NOT NULL,
  stone_weight NUMERIC(10,3) NOT NULL,
  net_weight NUMERIC(10,3) NOT NULL,
  -- The rate it was priced at: the latest sheet of the bill's day for its purity.
  rate_sheet_id BIGINT NOT NULL,
  rate NUMERIC(12,2) NOT NULL,
  metal_value NUMERIC(14,2) NOT NULL,
  wastage_percent NUMERIC(5,2) NOT NULL,
  wastage_weight NUMERIC(10,3) NOT NULL,
  wastage_value NUMERIC(14,2) NOT NULL,
  making_mode TEXT NOT NULL CHECK (making_mode IN ('per_gram', 'percent', 'flat')),
  making_value NUMERIC(12,2) NOT NULL,
  making_charge NUMERIC(14,2) NOT NULL,
  stone_value NUMERIC(14,2) NOT NULL,
  -- The stones as billed: kind, how many, carats, grade, certificate, treatment, value.
  stones JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(stones) = 'array'),
  hallmarked BOOLEAN NOT NULL,
  hallmark_charge NUMERIC(10,2) NOT NULL,
  huids TEXT[] NOT NULL DEFAULT '{}',
  -- Why the HUID check let it through: it carries a HUID; it is not gold; it
  -- is under 2 g; the article is left out of the hallmarking order (its
  -- exemption); the business is exempt by its turnover; the district is not
  -- under mandatory hallmarking.
  hallmark_basis TEXT NOT NULL CHECK (hallmark_basis IN ('huid', 'not_gold', 'under_2g', 'turnover', 'district',
    'kundan_polki_jadau', 'watch_or_pen', 'gold_thread', 'bullion', 'medical_scientific', 'semi_finished', 'export')),
  -- Its value (metal, wastage, making, stones and hallmarking), any discount on it, and its taxable value and GST.
  value NUMERIC(14,2) NOT NULL,
  discount NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxable NUMERIC(14,2) NOT NULL,
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate = 3),
  tax NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (business_id, line_id),
  FOREIGN KEY (business_id, bill_id) REFERENCES jewellery_bills(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  FOREIGN KEY (business_id, rate_sheet_id) REFERENCES jewellery_rate_sheets(business_id, id),
  CHECK (net_weight = gross_weight - stone_weight),
  CHECK (metal_value = round(net_weight * rate, 2)),
  CHECK (wastage_weight = round(net_weight * wastage_percent / 100, 3)),
  CHECK (wastage_value = round(net_weight * rate * wastage_percent / 100, 2)),
  CHECK (making_charge = CASE making_mode WHEN 'per_gram' THEN round(net_weight * making_value, 2)
    WHEN 'percent' THEN round(metal_value * making_value / 100, 2) ELSE making_value END),
  CHECK (value = metal_value + wastage_value + making_charge + stone_value + hallmark_charge),
  CHECK (discount >= 0 AND discount <= value),
  CHECK (taxable = value - discount),
  CHECK (tax = round(taxable * tax_rate / 100, 2)),
  CHECK (hallmarked OR (hallmark_charge = 0 AND huids = '{}'))
);
CREATE INDEX jewellery_bill_lines_bill ON jewellery_bill_lines(business_id, bill_id);
CREATE INDEX jewellery_bill_lines_piece ON jewellery_bill_lines(business_id, piece_id);
CREATE TRIGGER jewellery_bill_lines_append_only BEFORE UPDATE OR DELETE ON jewellery_bill_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- A bill's piece is on a line of the bill's own sale (its item, its tag as the
-- serial number, one unit, at the line's taxable value and GST), as the piece
-- is now in stock, at the latest rate of the day for its purity; and a gold
-- piece of 2 g or more carries its BIS hallmark's HUID unless the article is
-- left out of the hallmarking order, the business is exempt by its turnover,
-- or the district is not under mandatory hallmarking.
CREATE FUNCTION jewellery_bill_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill RECORD; line RECORD; piece RECORD; rate RECORD; marks TEXT[]; stones NUMERIC; expected TEXT;
BEGIN
  SELECT document_id, created_at, hallmark_mandatory, turnover_exempt INTO bill FROM jewellery_bills WHERE business_id = NEW.business_id AND id = NEW.bill_id;
  IF bill.created_at <> now() THEN
    RAISE EXCEPTION 'A piece goes on a jewellery bill when the bill is made' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO piece FROM jewellery_pieces WHERE business_id = NEW.business_id AND id = NEW.piece_id;
  SELECT document_id, sku_id, lot_code, quantity, net, tax INTO line FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.line_id;
  IF line.document_id IS DISTINCT FROM bill.document_id OR line.sku_id IS DISTINCT FROM piece.sku_id OR line.lot_code IS DISTINCT FROM piece.tag_no OR line.quantity <> 1
     OR line.net <> NEW.taxable OR line.tax <> NEW.tax THEN
    RAISE EXCEPTION 'Piece % is billed on a line of its own sale: its item, its tag, one unit, at its taxable value and GST', piece.tag_no USING ERRCODE = '23514';
  END IF;
  IF piece.status <> 'in_stock' THEN
    RAISE EXCEPTION 'Piece % is % and is not sold', piece.tag_no, replace(piece.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(array_agg(huid::text ORDER BY huid), '{}') INTO marks FROM jewellery_piece_huids WHERE business_id = NEW.business_id AND piece_id = NEW.piece_id;
  SELECT COALESCE(sum(value), 0) INTO stones FROM jewellery_piece_stones WHERE business_id = NEW.business_id AND piece_id = NEW.piece_id;
  IF NEW.tag_no <> piece.tag_no OR NEW.metal <> piece.metal OR NEW.purity <> piece.purity OR NEW.gross_weight <> piece.gross_weight OR NEW.stone_weight <> piece.stone_weight
     OR NEW.wastage_percent <> piece.wastage_percent OR NEW.making_mode <> piece.making_mode OR NEW.making_value <> piece.making_value
     OR NEW.hallmarked <> piece.hallmarked OR NEW.hallmark_charge <> piece.hallmark_charge OR NEW.stone_value <> stones OR NEW.huids <> marks THEN
    RAISE EXCEPTION 'Piece % is billed as it is in stock', piece.tag_no USING ERRCODE = '23514';
  END IF;
  SELECT * INTO rate FROM jewellery_current_rate(NEW.business_id, piece.metal, piece.purity);
  IF NOT FOUND OR rate.sheet_id <> NEW.rate_sheet_id OR rate.sell_rate <> NEW.rate THEN
    RAISE EXCEPTION 'Piece % is priced at the latest rate of the day for its purity', piece.tag_no USING ERRCODE = '23514';
  END IF;
  expected := CASE WHEN marks <> '{}' THEN 'huid' WHEN piece.metal <> 'gold' THEN 'not_gold' WHEN piece.gross_weight < 2 THEN 'under_2g'
    WHEN piece.exemption IS NOT NULL THEN piece.exemption WHEN bill.turnover_exempt THEN 'turnover' WHEN NOT bill.hallmark_mandatory THEN 'district' END;
  IF expected IS NULL THEN
    RAISE EXCEPTION 'Piece % (gold, % g) needs its BIS hallmark with a HUID before it is sold here', piece.tag_no, piece.gross_weight USING ERRCODE = '23514';
  END IF;
  IF NEW.hallmark_basis <> expected THEN
    RAISE EXCEPTION 'Piece % goes through the HUID check as %', piece.tag_no, replace(expected, '_', ' ') USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_bill_lines_check BEFORE INSERT ON jewellery_bill_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_bill_lines_check();

-- A piece taken back on its bill's credit note comes back into stock (the
-- return puts its unit back), and its history says so.
CREATE FUNCTION jewellery_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD;
BEGIN
  SELECT tag_no INTO line FROM jewellery_bill_lines WHERE business_id = NEW.business_id AND line_id = NEW.line_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT NEW.restock THEN
    RAISE EXCEPTION 'Piece % comes back into stock when it is taken back: return it to stock (and melt it afterwards if it cannot be sold again)', line.tag_no
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_return_lines_jewellery BEFORE INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_line_return();

CREATE FUNCTION jewellery_line_returned() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; credit RECORD;
BEGIN
  SELECT bl.piece_id INTO line FROM jewellery_bill_lines bl WHERE bl.business_id = NEW.business_id AND bl.line_id = NEW.line_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT return_no, created_by INTO credit FROM business_returns WHERE business_id = NEW.business_id AND id = NEW.return_id;
  UPDATE jewellery_pieces SET status = 'in_stock', updated_by = credit.created_by, updated_at = now() WHERE business_id = NEW.business_id AND id = line.piece_id;
  INSERT INTO jewellery_piece_events (business_id, piece_id, kind, from_status, to_status, note, created_by)
  VALUES (NEW.business_id, line.piece_id, 'returned', 'sold', 'in_stock', 'Taken back on credit note ' || credit.return_no, credit.created_by);
  RETURN NULL;
END $$;
CREATE TRIGGER business_return_lines_jewellery_returned AFTER INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_line_returned();

-- --- Old gold ---------------------------------------------------------------------------------

-- Old gold, silver or platinum a customer sells to the shop or gives in
-- exchange, as one voucher: the seller, what they declare, and its weight and
-- value (its lines added up, rounded as the business rounds its bills).
CREATE TABLE jewellery_old_gold (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  voucher_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- The seller as the voucher names them.
  seller_name VARCHAR(150) NOT NULL CHECK (btrim(seller_name) <> ''),
  seller_phone VARCHAR(30),
  -- The photo ID seen: its kind and number (of an Aadhaar card, only its last
  -- four digits are kept).
  id_kind TEXT NOT NULL CHECK (id_kind IN ('aadhaar', 'voter_id', 'driving_licence', 'passport', 'pan_card', 'other')),
  id_ref VARCHAR(30) NOT NULL CHECK (id_ref ~ '^[A-Z0-9/-]{2,30}$'),
  -- The seller's PAN, or that they have none and signed a declaration (Form 97).
  pan CHAR(10) CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  pan_declaration BOOLEAN NOT NULL DEFAULT FALSE,
  -- The seller declares the metal is their own to sell.
  owner_declared BOOLEAN NOT NULL CHECK (owner_declared),
  -- The business's date whose buy rates valued it.
  rate_date DATE NOT NULL,
  -- Its lines added up: grams of metal and of fine metal, and its value with any round-off.
  net_weight NUMERIC(12,3) NOT NULL CHECK (net_weight > 0),
  fine_weight NUMERIC(12,3) NOT NULL CHECK (fine_weight >= 0),
  round_off NUMERIC(4,2) NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -0.49 AND 0.50),
  value NUMERIC(14,2) NOT NULL CHECK (value > 0),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Cancelled (nothing paid out or used on it), with why.
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  cancel_reason VARCHAR(300) CHECK (btrim(cancel_reason) <> ''),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, voucher_no),
  UNIQUE (business_id, request_key),
  CHECK (id_kind <> 'aadhaar' OR id_ref ~ '^[0-9]{4}$'),
  CHECK (NOT (pan_declaration AND pan IS NOT NULL)),
  CHECK (value <= 200000 OR pan IS NOT NULL OR pan_declaration),
  CHECK (round_off = 0 OR value = trunc(value)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL) AND (cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX jewellery_old_gold_period ON jewellery_old_gold(business_id, created_at DESC);
CREATE INDEX jewellery_old_gold_contact ON jewellery_old_gold(business_id, contact_id);
CREATE TRIGGER jewellery_old_gold_customer BEFORE INSERT ON jewellery_old_gold
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A voucher is valued at the rates of the business's date when it is made.
CREATE FUNCTION jewellery_old_gold_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_at <> now() OR NEW.rate_date <> (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date THEN
    RAISE EXCEPTION 'An old gold voucher is valued at today''s buy rates when it is made' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_old_gold_check BEFORE INSERT ON jewellery_old_gold
  FOR EACH ROW EXECUTE FUNCTION jewellery_old_gold_check();

-- A voucher is kept as it was written and never deleted: it is only
-- cancelled, once, while nothing is paid out or used on it.
CREATE FUNCTION jewellery_old_gold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An old gold voucher is never deleted: cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason']) <> (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason']) THEN
    RAISE EXCEPTION 'Old gold voucher % is kept as it was written: it is only cancelled, once', OLD.voucher_no USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jewellery_old_gold_payouts WHERE business_id = OLD.business_id AND old_gold_id = OLD.id)
     OR COALESCE((SELECT sum(amount) FROM jewellery_old_gold_uses WHERE business_id = OLD.business_id AND old_gold_id = OLD.id), 0) <> 0 THEN
    RAISE EXCEPTION 'Old gold voucher % was paid out or used on a bill: it is not cancelled', OLD.voucher_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_old_gold_guard BEFORE UPDATE OR DELETE ON jewellery_old_gold
  FOR EACH ROW EXECUTE FUNCTION jewellery_old_gold_guard();

-- Each article as tested and valued.
CREATE TABLE jewellery_old_gold_lines (
  business_id BIGINT NOT NULL,
  old_gold_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 30),
  description VARCHAR(150) NOT NULL CHECK (btrim(description) <> '' AND jewellery_plain_words(description)),
  pieces SMALLINT NOT NULL DEFAULT 1 CHECK (pieces BETWEEN 1 AND 1000),
  -- The metal, and the purity whose buy rate values it.
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  -- How it was tested, and the fineness found (parts of pure metal in a thousand).
  test_method TEXT NOT NULL CHECK (test_method IN ('xrf', 'touchstone', 'acid', 'fire_assay')),
  tested_fineness NUMERIC(4,1) NOT NULL CHECK (tested_fineness > 0),
  -- In grams to the milligram: as weighed, what is taken off (stones, dirt, lac, wax), the metal, and the fine metal in it.
  gross_weight NUMERIC(10,3) NOT NULL CHECK (gross_weight > 0),
  less_weight NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (less_weight >= 0),
  net_weight NUMERIC(10,3) GENERATED ALWAYS AS (gross_weight - less_weight) STORED,
  fine_weight NUMERIC(10,3) NOT NULL,
  -- The HUID on the article, where it carries one.
  huid CHAR(6) CHECK (huid ~ '^[A-Z0-9]{6}$'),
  -- The buy rate per gram of its purity (the latest sheet of the day), the
  -- deduction (melting loss or the shop's rule), and its value: net weight ×
  -- the buy rate × the fineness found ÷ the purity's fineness, less the deduction.
  rate_sheet_id BIGINT NOT NULL,
  buy_rate NUMERIC(12,2) NOT NULL CHECK (buy_rate > 0),
  deduction_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (deduction_percent >= 0 AND deduction_percent < 100),
  value NUMERIC(14,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (business_id, old_gold_id, seq),
  FOREIGN KEY (business_id, old_gold_id) REFERENCES jewellery_old_gold(business_id, id),
  FOREIGN KEY (business_id, rate_sheet_id) REFERENCES jewellery_rate_sheets(business_id, id),
  CHECK (less_weight < gross_weight),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (fine_weight = round((gross_weight - less_weight) * tested_fineness / 1000, 3)),
  CHECK (value = jewellery_money((gross_weight - less_weight) * buy_rate * tested_fineness * (100 - deduction_percent), jewellery_fineness(metal, purity) * 100))
);
CREATE TRIGGER jewellery_old_gold_lines_append_only BEFORE UPDATE OR DELETE ON jewellery_old_gold_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- A line goes on its voucher when the voucher is made, at the latest buy rate of the day for its purity.
CREATE FUNCTION jewellery_old_gold_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voucher RECORD; rate RECORD;
BEGIN
  SELECT voucher_no, created_at INTO voucher FROM jewellery_old_gold WHERE business_id = NEW.business_id AND id = NEW.old_gold_id;
  IF voucher.created_at <> now() THEN
    RAISE EXCEPTION 'A line goes on an old gold voucher when the voucher is made' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO rate FROM jewellery_current_rate(NEW.business_id, NEW.metal, NEW.purity);
  IF NOT FOUND OR rate.buy_rate IS NULL OR rate.sheet_id <> NEW.rate_sheet_id OR rate.buy_rate <> NEW.buy_rate THEN
    RAISE EXCEPTION 'Old gold on voucher % is valued at the latest buy rate of the day for its purity', voucher.voucher_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_old_gold_lines_check BEFORE INSERT ON jewellery_old_gold_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_old_gold_lines_check();

-- A voucher's weights and value are its lines' (checked when the voucher's transaction ends).
CREATE FUNCTION jewellery_old_gold_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sums RECORD;
BEGIN
  SELECT count(*) AS n, COALESCE(sum(net_weight), 0) AS net, COALESCE(sum(fine_weight), 0) AS fine, COALESCE(sum(value), 0) AS value INTO sums
  FROM jewellery_old_gold_lines WHERE business_id = NEW.business_id AND old_gold_id = NEW.id;
  IF sums.n = 0 OR sums.net <> NEW.net_weight OR sums.fine <> NEW.fine_weight OR sums.value + NEW.round_off <> NEW.value THEN
    RAISE EXCEPTION 'Old gold voucher % adds up its lines'' weights and values', NEW.voucher_no USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jewellery_old_gold_totals AFTER INSERT ON jewellery_old_gold
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jewellery_old_gold_totals();

-- A voucher's value used on one of the seller's jewellery bills (its payment
-- by old gold), or put back on the voucher when that bill was returned (the
-- bill's credit given back by credit note).
CREATE TABLE jewellery_old_gold_uses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  old_gold_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  payment_id BIGINT,
  refund_id BIGINT REFERENCES business_refunds(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, old_gold_id) REFERENCES jewellery_old_gold(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, payment_id) REFERENCES business_payments(business_id, id),
  UNIQUE (business_id, payment_id),
  UNIQUE (refund_id),
  CHECK ((amount > 0) = (payment_id IS NOT NULL) AND (amount < 0) = (refund_id IS NOT NULL))
);
CREATE INDEX jewellery_old_gold_uses_voucher ON jewellery_old_gold_uses(business_id, old_gold_id);
CREATE INDEX jewellery_old_gold_uses_document ON jewellery_old_gold_uses(business_id, document_id);
CREATE TRIGGER jewellery_old_gold_uses_append_only BEFORE UPDATE OR DELETE ON jewellery_old_gold_uses
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- Old gold pays the jewellery bills of the customer who brought it in, by a
-- credit-note payment made with the use; it is put back from a bill only as
-- far as it paid that bill, by the bill's credit-note refund made with it;
-- and no more is used and paid out than the voucher is worth.
CREATE FUNCTION jewellery_old_gold_uses_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voucher RECORD; doc RECORD; entry RECORD; on_bill NUMERIC; used NUMERIC; paid NUMERIC;
BEGIN
  SELECT voucher_no, contact_id, value, cancelled_at INTO voucher FROM jewellery_old_gold WHERE business_id = NEW.business_id AND id = NEW.old_gold_id;
  IF voucher.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Old gold voucher % is cancelled', voucher.voucher_no USING ERRCODE = '23514';
  END IF;
  SELECT d.contact_id, d.document_no INTO doc FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id
    AND EXISTS (SELECT 1 FROM jewellery_bills b WHERE b.business_id = d.business_id AND b.document_id = d.id);
  IF NOT FOUND OR doc.contact_id IS DISTINCT FROM voucher.contact_id THEN
    RAISE EXCEPTION 'Old gold voucher % pays the jewellery bills of the customer who brought it in', voucher.voucher_no USING ERRCODE = '23514';
  END IF;
  IF NEW.amount > 0 THEN
    SELECT document_id, method, amount, reference, created_at INTO entry FROM business_payments WHERE business_id = NEW.business_id AND id = NEW.payment_id;
    IF entry.document_id <> NEW.document_id OR entry.method <> 'credit_note' OR entry.amount <> NEW.amount
       OR entry.reference IS DISTINCT FROM voucher.voucher_no OR entry.created_at <> now() THEN
      RAISE EXCEPTION 'Old gold used on bill % is the bill''s payment by old gold, made with it', doc.document_no USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT document_id, method, amount, created_at INTO entry FROM business_refunds WHERE business_id = NEW.business_id AND id = NEW.refund_id;
    IF entry.document_id <> NEW.document_id OR entry.method <> 'credit_note' OR entry.amount <> -NEW.amount OR entry.created_at <> now() THEN
      RAISE EXCEPTION 'Old gold put back from bill % is the bill''s credit given back by credit note, made with it', doc.document_no USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_bill FROM jewellery_old_gold_uses
    WHERE business_id = NEW.business_id AND old_gold_id = NEW.old_gold_id AND document_id = NEW.document_id;
    IF on_bill < 0 THEN
      RAISE EXCEPTION 'No more goes back on old gold voucher % from bill % than it paid on it', voucher.voucher_no, doc.document_no USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO used FROM jewellery_old_gold_uses WHERE business_id = NEW.business_id AND old_gold_id = NEW.old_gold_id;
  SELECT COALESCE(sum(amount), 0) INTO paid FROM jewellery_old_gold_payouts WHERE business_id = NEW.business_id AND old_gold_id = NEW.old_gold_id;
  IF used + paid > voucher.value THEN
    RAISE EXCEPTION 'Old gold voucher % is worth ₹%: no more than that is used and paid out', voucher.voucher_no, voucher.value USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_old_gold_uses_check BEFORE INSERT ON jewellery_old_gold_uses
  FOR EACH ROW EXECUTE FUNCTION jewellery_old_gold_uses_check();

-- A voucher's value paid out in money, written in the expense book.
CREATE TABLE jewellery_old_gold_payouts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  old_gold_id BIGINT NOT NULL,
  expense_id BIGINT NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'bank')),
  reference VARCHAR(100),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, old_gold_id) REFERENCES jewellery_old_gold(business_id, id),
  FOREIGN KEY (business_id, expense_id) REFERENCES business_expenses(business_id, id),
  UNIQUE (business_id, expense_id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX jewellery_old_gold_payouts_voucher ON jewellery_old_gold_payouts(business_id, old_gold_id);
CREATE INDEX jewellery_old_gold_payouts_day ON jewellery_old_gold_payouts(business_id, created_at) WHERE method = 'cash';
CREATE TRIGGER jewellery_old_gold_payouts_append_only BEFORE UPDATE OR DELETE ON jewellery_old_gold_payouts
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- Money paid out is its expense, written with it at the voucher's location;
-- no more is paid out and used than the voucher is worth; and a seller does
-- not receive ₹2,00,000 or more in cash for old gold in one business day or
-- for one voucher (Income-tax Act 2025, section 186), nor more than the
-- shop's own limit in a day where it sets one.
CREATE FUNCTION jewellery_old_gold_payouts_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voucher RECORD; spent RECORD; zone TEXT; used NUMERIC; paid NUMERIC; on_voucher NUMERIC; to_seller NUMERIC; own_limit NUMERIC;
BEGIN
  SELECT voucher_no, contact_id, seller_name, location_id, value, cancelled_at INTO voucher FROM jewellery_old_gold WHERE business_id = NEW.business_id AND id = NEW.old_gold_id;
  IF voucher.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Old gold voucher % is cancelled', voucher.voucher_no USING ERRCODE = '23514';
  END IF;
  SELECT amount, method, location_id, created_at, voided_at INTO spent FROM business_expenses WHERE business_id = NEW.business_id AND id = NEW.expense_id;
  IF spent.amount <> NEW.amount OR spent.method <> NEW.method OR spent.location_id <> voucher.location_id OR spent.created_at <> now() OR spent.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Money paid out for old gold voucher % is written in the expense book with it, at the voucher''s location', voucher.voucher_no USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO used FROM jewellery_old_gold_uses WHERE business_id = NEW.business_id AND old_gold_id = NEW.old_gold_id;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO paid FROM jewellery_old_gold_payouts WHERE business_id = NEW.business_id AND old_gold_id = NEW.old_gold_id;
  IF used + paid > voucher.value THEN
    RAISE EXCEPTION 'Old gold voucher % is worth ₹%: no more than that is used and paid out', voucher.voucher_no, voucher.value USING ERRCODE = '23514';
  END IF;
  IF NEW.method = 'cash' THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_voucher FROM jewellery_old_gold_payouts
    WHERE business_id = NEW.business_id AND old_gold_id = NEW.old_gold_id AND method = 'cash';
    SELECT COALESCE(sum(p.amount), 0) + NEW.amount INTO to_seller FROM jewellery_old_gold_payouts p
      JOIN jewellery_old_gold g ON g.business_id = p.business_id AND g.id = p.old_gold_id
    WHERE p.business_id = NEW.business_id AND g.contact_id = voucher.contact_id AND p.method = 'cash'
      AND (p.created_at AT TIME ZONE zone)::date = (now() AT TIME ZONE zone)::date;
    IF on_voucher >= 200000 OR to_seller >= 200000 THEN
      RAISE EXCEPTION 'A seller does not receive ₹2,00,000 or more in cash for old gold, in a day or for one voucher (Income-tax Act 2025, section 186): the cash to % would reach ₹%. Pay the rest by UPI or bank transfer.',
        voucher.seller_name, GREATEST(on_voucher, to_seller)::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
    SELECT old_gold_cash_limit INTO own_limit FROM jewellery_settings WHERE business_id = NEW.business_id;
    IF own_limit IS NOT NULL AND to_seller > own_limit THEN
      RAISE EXCEPTION 'The shop pays at most ₹% in cash for old gold to one seller in a day (its own limit): today''s cash to % would reach ₹%. Pay the rest by UPI or bank transfer.',
        own_limit, voucher.seller_name, to_seller::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_old_gold_payouts_check BEFORE INSERT ON jewellery_old_gold_payouts
  FOR EACH ROW EXECUTE FUNCTION jewellery_old_gold_payouts_check();

-- The expense of money paid out for old gold stays as paid (it is not reversed in Expenses).
CREATE FUNCTION jewellery_payout_expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voucher TEXT;
BEGIN
  SELECT g.voucher_no INTO voucher FROM jewellery_old_gold_payouts p JOIN jewellery_old_gold g ON g.business_id = p.business_id AND g.id = p.old_gold_id
  WHERE p.business_id = OLD.business_id AND p.expense_id = OLD.id;
  IF FOUND THEN
    RAISE EXCEPTION 'This expense is the money paid out for old gold voucher %: it stays as paid', voucher USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_expenses_jewellery BEFORE UPDATE OR DELETE ON business_expenses
  FOR EACH ROW EXECUTE FUNCTION jewellery_payout_expense_guard();

-- Money goes back on a jewellery bill only as far as money was paid on it at
-- the counter: what old gold paid goes back on its voucher (a credit-note
-- refund), and what a gold scheme paid is never paid back in money.
CREATE FUNCTION jewellery_bill_refund_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid NUMERIC; back NUMERIC; doc TEXT;
BEGIN
  IF NEW.method IN ('credit_note', 'finance')
     OR NOT EXISTS (SELECT 1 FROM jewellery_bills WHERE business_id = NEW.business_id AND document_id = NEW.document_id) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(p.amount), 0) INTO paid FROM business_payments p
  WHERE p.business_id = NEW.business_id AND p.document_id = NEW.document_id AND p.method NOT IN ('credit_note', 'finance')
    AND NOT EXISTS (SELECT 1 FROM jewellery_scheme_instalments i WHERE i.business_id = p.business_id AND i.collection_id = p.collection_id);
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO back FROM business_refunds
  WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND method NOT IN ('credit_note', 'finance');
  IF back > paid THEN
    SELECT document_no INTO doc FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
    RAISE EXCEPTION 'Bill % was paid ₹% in money, and no more than that goes back in money: what old gold paid on it goes back on its old gold voucher, and a gold scheme''s instalments are never paid back',
      doc, paid::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_refunds_jewellery BEFORE INSERT ON business_refunds
  FOR EACH ROW EXECUTE FUNCTION jewellery_bill_refund_check();

-- --- The shop's own metal ----------------------------------------------------------------------

-- Metal the shop holds by purity at a location, for melting and refining (not
-- stock for sale): each movement in grams of metal and of fine metal.
CREATE TABLE jewellery_metal_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  net_weight NUMERIC(12,3) NOT NULL CHECK (net_weight <> 0),
  fine_weight NUMERIC(12,3) NOT NULL,
  -- Where it came from: a piece melted, a line of old gold taken in, or that
  -- line going back out when its voucher is cancelled.
  source TEXT NOT NULL CHECK (source IN ('melted_piece', 'old_gold', 'old_gold_cancelled')),
  piece_id BIGINT,
  old_gold_id BIGINT,
  old_gold_seq SMALLINT,
  note VARCHAR(300),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  FOREIGN KEY (business_id, old_gold_id, old_gold_seq) REFERENCES jewellery_old_gold_lines(business_id, old_gold_id, seq),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK ((source = 'melted_piece') = (piece_id IS NOT NULL)),
  CHECK ((source IN ('old_gold', 'old_gold_cancelled')) = (old_gold_id IS NOT NULL AND old_gold_seq IS NOT NULL)),
  CHECK ((net_weight > 0) = (source IN ('melted_piece', 'old_gold'))),
  CHECK (fine_weight = 0 OR sign(fine_weight) = sign(net_weight))
);
CREATE INDEX jewellery_metal_movements_stock ON jewellery_metal_movements(business_id, location_id, metal, purity);
CREATE UNIQUE INDEX jewellery_metal_movements_piece ON jewellery_metal_movements(business_id, piece_id) WHERE piece_id IS NOT NULL;
CREATE UNIQUE INDEX jewellery_metal_movements_old_gold ON jewellery_metal_movements(business_id, old_gold_id, old_gold_seq, source) WHERE old_gold_id IS NOT NULL;
CREATE TRIGGER jewellery_metal_movements_append_only BEFORE UPDATE OR DELETE ON jewellery_metal_movements
  FOR EACH ROW EXECUTE FUNCTION jewellery_append_only();

-- A melted piece's metal: its own purity, net weight and fine weight (net
-- weight × fineness ÷ 1000, to the milligram), from a piece just melted. Old
-- gold: each line's own purity, net and fine weight at its voucher's
-- location, taken in when the voucher is made and going back out when it is
-- cancelled.
CREATE FUNCTION jewellery_metal_movements_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE piece RECORD; line RECORD;
BEGIN
  IF NEW.source = 'melted_piece' THEN
    SELECT tag_no, status, metal, purity, net_weight INTO piece FROM jewellery_pieces WHERE business_id = NEW.business_id AND id = NEW.piece_id;
    IF piece.status IS DISTINCT FROM 'melted' THEN
      RAISE EXCEPTION 'Metal comes from piece % once it is melted', piece.tag_no USING ERRCODE = '23514';
    END IF;
    IF NEW.metal <> piece.metal OR NEW.purity <> piece.purity OR NEW.net_weight <> piece.net_weight
       OR NEW.fine_weight <> round(piece.net_weight * jewellery_fineness(piece.metal, piece.purity) / 1000, 3) THEN
      RAISE EXCEPTION 'The metal of piece % is its own purity and weight', piece.tag_no USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT l.metal, l.purity, l.net_weight, l.fine_weight, g.voucher_no, g.location_id, g.created_at, g.cancelled_at INTO line
    FROM jewellery_old_gold_lines l JOIN jewellery_old_gold g ON g.business_id = l.business_id AND g.id = l.old_gold_id
    WHERE l.business_id = NEW.business_id AND l.old_gold_id = NEW.old_gold_id AND l.seq = NEW.old_gold_seq;
    IF NEW.metal <> line.metal OR NEW.purity <> line.purity OR NEW.location_id <> line.location_id
       OR (NEW.source = 'old_gold' AND (line.created_at <> now() OR NEW.net_weight <> line.net_weight OR NEW.fine_weight <> line.fine_weight))
       OR (NEW.source = 'old_gold_cancelled' AND (line.cancelled_at IS DISTINCT FROM now() OR NEW.net_weight <> -line.net_weight OR NEW.fine_weight <> -line.fine_weight)) THEN
      RAISE EXCEPTION 'The metal of old gold voucher % is its own purity and weight, taken in when the voucher is made and going out when it is cancelled', line.voucher_no
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_metal_movements_check BEFORE INSERT ON jewellery_metal_movements
  FOR EACH ROW EXECUTE FUNCTION jewellery_metal_movements_check();

-- Down Migration
DROP TRIGGER business_collection_refunds_jewellery_scheme ON business_collection_refunds;
DROP TRIGGER business_payments_jewellery_scheme ON business_payments;
DROP TRIGGER business_refunds_jewellery ON business_refunds;
DROP TRIGGER business_expenses_jewellery ON business_expenses;
DROP TRIGGER business_return_lines_jewellery_returned ON business_return_lines;
DROP TRIGGER business_return_lines_jewellery ON business_return_lines;
DROP TABLE jewellery_metal_movements, jewellery_old_gold_payouts, jewellery_old_gold_uses, jewellery_old_gold_lines, jewellery_old_gold,
  jewellery_bill_lines, jewellery_bills, jewellery_scheme_instalments, jewellery_schemes, jewellery_scheme_plans,
  jewellery_piece_events, jewellery_piece_stones, jewellery_piece_huids, jewellery_pieces, jewellery_items, jewellery_locations, jewellery_settings;
DROP FUNCTION jewellery_scheme_refund_check();
DROP FUNCTION jewellery_scheme_payment_check();
DROP FUNCTION jewellery_scheme_instalments_check();
DROP FUNCTION jewellery_schemes_redeemed();
DROP FUNCTION jewellery_schemes_guard();
DROP FUNCTION jewellery_schemes_check();
DROP FUNCTION jewellery_scheme_plans_guard();
DROP FUNCTION jewellery_bills_discount();
DROP FUNCTION jewellery_bill_refund_check();
DROP FUNCTION jewellery_payout_expense_guard();
DROP FUNCTION jewellery_old_gold_payouts_check();
DROP FUNCTION jewellery_old_gold_uses_check();
DROP FUNCTION jewellery_old_gold_totals();
DROP FUNCTION jewellery_old_gold_lines_check();
DROP FUNCTION jewellery_old_gold_guard();
DROP FUNCTION jewellery_old_gold_check();
DELETE FROM business_number_series WHERE document_kind IN ('old_gold', 'gold_scheme');
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(array_remove(kinds, 'old_gold'), 'gold_scheme');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DROP FUNCTION jewellery_line_returned();
DROP FUNCTION jewellery_line_return();
DROP FUNCTION jewellery_bill_lines_check();
DROP FUNCTION jewellery_bills_check();
DROP FUNCTION jewellery_metal_movements_check();
DROP FUNCTION jewellery_piece_parts_check();
DROP FUNCTION jewellery_pieces_guard();
DROP FUNCTION jewellery_items_check();
DROP FUNCTION jewellery_plain_words(TEXT);
DROP FUNCTION jewellery_current_rate(BIGINT, TEXT, TEXT);
DROP TABLE jewellery_rates, jewellery_rate_sheets;
DROP FUNCTION jewellery_rates_check();
DROP FUNCTION jewellery_rate_sheets_day();
DROP FUNCTION jewellery_append_only();
DROP FUNCTION jewellery_money(NUMERIC, NUMERIC);
DROP FUNCTION jewellery_fineness(TEXT, TEXT);
DELETE FROM business_role_permissions WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'karigar');
UPDATE business_memberships m SET role_id = (SELECT r2.id FROM business_roles r2 WHERE r2.business_id = m.business_id AND r2.template_code = 'viewer')
  WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'karigar');
DELETE FROM business_roles WHERE template_code = 'karigar';
DELETE FROM business_role_template_permissions WHERE template_code = 'karigar';
DELETE FROM business_role_templates WHERE code = 'karigar';
DELETE FROM business_capabilities WHERE capability = 'jewellery';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'jewellery');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'jewellery');
DELETE FROM business_permissions WHERE module_code = 'jewellery';
DELETE FROM platform_module_business_types WHERE module_code = 'jewellery';
DELETE FROM platform_module_dependencies WHERE module_code = 'jewellery';
DELETE FROM platform_modules WHERE code = 'jewellery';
-- Serial numbers stay on wherever a shop has them (switched on is a shop's own choice from here).
UPDATE platform_module_business_types SET enabled_by_default = FALSE WHERE module_code = 'serials' AND business_type = 'jewellery';
