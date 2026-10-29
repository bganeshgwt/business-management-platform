-- Up Migration
-- A jeweller's money beyond the bill (module "jewellery"): rate sessions the
-- shop names beyond morning and evening; old gold bought by the shop's own
-- buy-back rules (a deduction for its own pieces, known by HUID or tag, and one
-- per purity for outside jewellery, changed on a line only with a manager's
-- approval), with photos of what came in, paid out several vouchers at once
-- from the customer's screen or the day's money, and what happens to its
-- metal next (melted with the shop's metal, kept to resell as it is, sent to a
-- refiner or bullion dealer on a numbered challan and back or sold, or issued
-- to a karigar); gold schemes closed on their day 364 into the customer's
-- safekeeping, a returned bill's scheme money put back onto its scheme within
-- its tenure, and a company's scheme money held against 25% of its net
-- worth; the cash report's family groups and alert levels; customers' KYC
-- documents and a firm's beneficial owners, kept at least five years after the
-- last transaction; the suspicious transaction log, seen by a permission of
-- its own; and on the jewellery bill, the shop's offers on making, a discount
-- at the counter on making and wastage, and loose stones and coins at their
-- own prices and GST slabs.
--
-- Gold rates & jewellery (module "jewellery"):
--   jewellery_settings (more)      the shop's own rate sessions, the deduction
--                                  for its own pieces bought back, the cash
--                                  report's alert levels (replacing the one
--                                  watch level), the KYC document types it
--                                  accepts, whether a counter discount may come
--                                  off the metal's value, and a company's net
--                                  worth with the date it is as of.
--   jewellery_rate_sheets (more)   a session the shop names ("own", with its
--                                  name kept on the sheet).
--   jewellery_buyback_deductions   the deduction on outside old gold of each
--                                  purity.
--   jewellery_old_gold_lines (more) the shop's own piece an article is (by its
--                                  HUID or tag), the buy-back rule that gave
--                                  its deduction, and the manager who approved
--                                  another deduction, with why.
--   jewellery_refinery_challans    a challan (RF/2627/0001) of the shop's metal
--                                  sent to a refiner (a supplier), coming back
--                                  as refined metal, or to a bullion dealer
--                                  (the buyer, a customer), sold on a bill.
--   jewellery_refinery_lines       each purity sent, out of the shop's metal.
--   jewellery_old_gold_next        what happens next to each line of old gold:
--                                  melted with the shop's metal, kept to resell
--                                  as it is, sent on a refinery challan, or
--                                  issued on a karigar's challan.
--   jewellery_files (more)         photos of old gold taken in, and copies of
--                                  KYC documents (a PDF too).
--   jewellery_scheme_closes        a scheme closed on its day 364: billed as
--                                  gold or silver equal to its money at that
--                                  day's rate, the metal tagged as a piece held
--                                  in the customer's safekeeping until they
--                                  collect it.
--   jewellery_scheme_moves         a scheme's money put back from its returned
--                                  bill within its tenure, and used again on
--                                  the bill that redeems it.
--   jewellery_cash_families        a family group the shop sets: its customers'
--                                  cash is one person's in the cash report.
--   jewellery_cash_family_members  each customer in a family group.
--   jewellery_kyc_documents        a customer's KYC document: its type (the
--                                  shop's list), number, the name on it, the
--                                  day it was seen, and its copy.
--   jewellery_kyc_owners           a firm's beneficial owners.
--   jewellery_str_cases            the suspicious transaction log: each case,
--                                  what was seen, and the decision whether it
--                                  was reported (filed outside the platform).
--   jewellery_str_entries          each case's history: opened, notes, views,
--                                  the decision.
--   jewellery_offers               the shop's offers on making: a percentage
--                                  off the making charge between two dates.
--   jewellery_bills (more)         the offers' and the counter's discounts and
--                                  why, and whether the metal could take a
--                                  counter discount.
--   jewellery_bill_lines (more)    each piece's offer and counter discount.
--   jewellery_bill_items           loose stones and coins on the bill at their
--                                  own prices and slabs, and the scheme's share
--                                  of its discount.
-- A piece gains the status "in safekeeping" (billed and held for its buyer);
-- the shop's metal moves out to refiners and dealers and back, and into
-- safekeeping pieces; the fine-weight book keeps metal at refiners and in
-- safekeeping. New permissions: jewellery.manage (customers' KYC documents in
-- full, for managers) and jewellery.review (the suspicious transaction log:
-- the owner's, and whoever the owner gives it).

-- --- Permissions ------------------------------------------------------------------------------------

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('jewellery', 'manage', 'See customers'' KYC documents in full: their numbers and copies', 537),
 ('jewellery', 'review', 'Keep the suspicious transaction log (no one else sees it)', 538)
) AS p(module_code, action, name, sort_order);
-- KYC in full for managers; the suspicious transaction log is the owner's alone until they give it.
INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES ('manager', 'jewellery.manage');
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, 'jewellery.manage' FROM business_roles r WHERE r.template_code = 'manager' AND NOT r.full_access
ON CONFLICT DO NOTHING;

-- --- The items the jeweller's own postings are booked under -------------------------------------------

-- Gold, silver and platinum held for gold schemes closed on their day 364 (a
-- jewellery item each, its pieces held in customers' safekeeping).
ALTER TABLE jewellery_account_items DROP CONSTRAINT jewellery_account_items_purpose_check,
  ADD CONSTRAINT jewellery_account_items_purpose_check CHECK (purpose IN ('labour', 'hallmarking', 'gold', 'silver', 'platinum',
    'gold_safekeeping', 'silver_safekeeping', 'platinum_safekeeping'));

-- --- Number series ----------------------------------------------------------------------------------

-- Refinery challans (RF) are numbered. The kinds list is widened by reading the
-- current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'refinery_challan' = ANY (kinds) THEN kinds := array_append(kinds, 'refinery_challan'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- --- Shared rules -----------------------------------------------------------------------------------

-- A list of names as the shop keeps it: at most so many, each 1 to so many
-- characters with no spaces around it, none twice (in any case).
CREATE FUNCTION jewellery_names_ok(names TEXT[], most INTEGER, longest INTEGER) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(names) <= most
    AND NOT EXISTS (SELECT 1 FROM unnest(names) n WHERE n IS NULL OR n <> btrim(n) OR n = '' OR length(n) > longest)
    AND (SELECT count(DISTINCT lower(n)) FROM unnest(names) n) = cardinality(names);
$$;

-- What is written is kept as it was written.
CREATE FUNCTION jewellery_money_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME IN ('jewellery_refinery_challans', 'jewellery_refinery_lines') THEN
    RAISE EXCEPTION 'A refinery challan is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_old_gold_next' THEN
    RAISE EXCEPTION 'What became of old gold is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('jewellery_scheme_moves', 'jewellery_scheme_closes') THEN
    RAISE EXCEPTION 'A gold scheme''s money is kept as it moved' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('jewellery_str_cases', 'jewellery_str_entries') THEN
    RAISE EXCEPTION 'The suspicious transaction log is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_bill_items' THEN
    RAISE EXCEPTION 'A jewellery bill is kept as it was billed: return a line on the bill to take it back' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'This record is kept as it was written' USING ERRCODE = '23514';
END $$;

-- --- Settings ---------------------------------------------------------------------------------------

ALTER TABLE jewellery_settings
  -- Rate sessions the shop names beyond morning and evening (a day may have more).
  ADD COLUMN rate_sessions TEXT[] NOT NULL DEFAULT '{}',
  -- Old gold: the deduction on the shop's own pieces bought back (none: the purity's or the general one).
  ADD COLUMN own_piece_deduction NUMERIC(5,2) CHECK (own_piece_deduction >= 0 AND own_piece_deduction < 100),
  -- The cash report: the shop's own alert levels below ₹10 lakh (lowest first).
  ADD COLUMN cash_alert_levels NUMERIC(12,2)[] NOT NULL DEFAULT '{}',
  -- The KYC document types the shop accepts.
  ADD COLUMN kyc_kinds TEXT[] NOT NULL DEFAULT '{}',
  -- Whether a discount at the counter may come off the metal's value too.
  ADD COLUMN discount_on_metal BOOLEAN NOT NULL DEFAULT FALSE,
  -- A company's net worth and the day it is as of (its scheme money is held against 25% of it).
  ADD COLUMN company_net_worth NUMERIC(16,2) CHECK (company_net_worth > 0),
  ADD COLUMN net_worth_on DATE;
ALTER TABLE jewellery_settings
  ADD CONSTRAINT jewellery_settings_rate_sessions CHECK (jewellery_names_ok(rate_sessions, 8, 40)),
  ADD CONSTRAINT jewellery_settings_kyc_kinds CHECK (jewellery_names_ok(kyc_kinds, 20, 60)),
  ADD CONSTRAINT jewellery_settings_cash_alert_levels CHECK (cardinality(cash_alert_levels) <= 5 AND 0 < ALL (cash_alert_levels) AND 1000000 > ALL (cash_alert_levels)),
  ADD CONSTRAINT jewellery_settings_net_worth CHECK ((company_net_worth IS NULL) = (net_worth_on IS NULL));
-- The one watch level becomes the first of the alert levels.
UPDATE jewellery_settings SET cash_alert_levels = ARRAY[cash_watch_level] WHERE cash_watch_level IS NOT NULL;
ALTER TABLE jewellery_settings DROP COLUMN cash_watch_level;

-- --- Rate sessions ----------------------------------------------------------------------------------

ALTER TABLE jewellery_rate_sheets ADD COLUMN session_name VARCHAR(40) CHECK (session_name = btrim(session_name) AND session_name <> '');
ALTER TABLE jewellery_rate_sheets DROP CONSTRAINT jewellery_rate_sheets_session_check,
  ADD CONSTRAINT jewellery_rate_sheets_session_check CHECK (session IN ('morning', 'evening', 'own')),
  ADD CONSTRAINT jewellery_rate_sheets_session_name CHECK ((session = 'own') = (session_name IS NOT NULL));

-- A session the shop names is one of its own sessions when the sheet is set.
CREATE FUNCTION jewellery_rate_sheets_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session = 'own' AND NEW.session_name IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jewellery_settings s WHERE s.business_id = NEW.business_id AND NEW.session_name = ANY (s.rate_sessions)) THEN
    RAISE EXCEPTION 'Session % is not one of the shop''s sessions: name it in Jewellery settings first', NEW.session_name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_rate_sheets_session BEFORE INSERT ON jewellery_rate_sheets
  FOR EACH ROW EXECUTE FUNCTION jewellery_rate_sheets_session();

-- --- Old gold: the shop's buy-back rules ---------------------------------------------------------------

CREATE TABLE jewellery_buyback_deductions (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  deduction_percent NUMERIC(5,2) NOT NULL CHECK (deduction_percent >= 0 AND deduction_percent < 100),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, metal, purity),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL)
);

ALTER TABLE jewellery_old_gold_lines
  -- The shop's own piece the article is, known by its HUID or tag.
  ADD COLUMN own_piece_id BIGINT,
  -- The buy-back rule that gave the deduction (the shop's own pieces, the purity's, or the general one), and its percentage.
  ADD COLUMN deduction_rule TEXT CHECK (deduction_rule IN ('own_piece', 'purity', 'general')),
  ADD COLUMN rule_percent NUMERIC(5,2) CHECK (rule_percent >= 0 AND rule_percent < 100),
  -- Another deduction than the rule's: the manager who approved it, and why.
  ADD COLUMN override_by BIGINT REFERENCES users(id),
  ADD COLUMN override_reason VARCHAR(300) CHECK (btrim(override_reason) <> '');
ALTER TABLE jewellery_old_gold_lines
  ADD CONSTRAINT jewellery_old_gold_lines_own_piece FOREIGN KEY (business_id, own_piece_id) REFERENCES jewellery_pieces(business_id, id),
  ADD CONSTRAINT jewellery_old_gold_lines_rule CHECK ((deduction_rule IS NULL) = (rule_percent IS NULL) AND NOT (deduction_rule = 'own_piece' AND own_piece_id IS NULL)),
  ADD CONSTRAINT jewellery_old_gold_lines_override CHECK ((override_by IS NULL) = (override_reason IS NULL)
    AND (rule_percent IS NULL OR (deduction_percent = rule_percent) = (override_by IS NULL)));

-- A line goes on its voucher when the voucher is made, at the latest buy rate
-- of the day for its purity; its deduction is the shop's buy-back rule (its
-- own pieces' deduction, else the purity's, else the general one) unless a
-- manager approved another; the shop's own piece is one it sold, carrying the
-- line's HUID where it has one, and a HUID of the shop's own piece names it.
CREATE OR REPLACE FUNCTION jewellery_old_gold_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voucher RECORD; rate RECORD; rules RECORD; own RECORD; marked BIGINT; expected_rule TEXT; expected NUMERIC;
BEGIN
  SELECT voucher_no, created_at INTO voucher FROM jewellery_old_gold WHERE business_id = NEW.business_id AND id = NEW.old_gold_id;
  IF voucher.created_at <> now() THEN
    RAISE EXCEPTION 'A line goes on an old gold voucher when the voucher is made' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO rate FROM jewellery_current_rate(NEW.business_id, NEW.metal, NEW.purity);
  IF NOT FOUND OR rate.buy_rate IS NULL OR rate.sheet_id <> NEW.rate_sheet_id OR rate.buy_rate <> NEW.buy_rate THEN
    RAISE EXCEPTION 'Old gold on voucher % is valued at the latest buy rate of the day for its purity', voucher.voucher_no USING ERRCODE = '23514';
  END IF;
  IF NEW.deduction_rule IS NULL THEN
    RAISE EXCEPTION 'Old gold on voucher % says which buy-back rule gave its deduction', voucher.voucher_no USING ERRCODE = '23514';
  END IF;
  IF NEW.huid IS NOT NULL THEN
    SELECT piece_id INTO marked FROM jewellery_piece_huids WHERE business_id = NEW.business_id AND huid = NEW.huid;
    IF marked IS NOT NULL AND NEW.own_piece_id IS DISTINCT FROM marked THEN
      RAISE EXCEPTION 'HUID % is on the shop''s own piece: the line names it', NEW.huid USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.own_piece_id IS NOT NULL THEN
    SELECT tag_no, status, metal INTO own FROM jewellery_pieces WHERE business_id = NEW.business_id AND id = NEW.own_piece_id;
    IF own.status <> 'sold' OR own.metal <> NEW.metal OR (NEW.huid IS NOT NULL AND marked IS DISTINCT FROM NEW.own_piece_id) THEN
      RAISE EXCEPTION 'Piece % comes back as old gold only once the shop has sold it, as the metal it is', own.tag_no USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT s.own_piece_deduction, s.old_gold_deduction, d.deduction_percent AS purity_deduction INTO rules FROM businesses b
    LEFT JOIN jewellery_settings s ON s.business_id = b.id
    LEFT JOIN jewellery_buyback_deductions d ON d.business_id = b.id AND d.metal = NEW.metal AND d.purity = NEW.purity
  WHERE b.id = NEW.business_id;
  IF NEW.own_piece_id IS NOT NULL AND rules.own_piece_deduction IS NOT NULL THEN
    expected_rule := 'own_piece'; expected := rules.own_piece_deduction;
  ELSIF rules.purity_deduction IS NOT NULL THEN
    expected_rule := 'purity'; expected := rules.purity_deduction;
  ELSE
    expected_rule := 'general'; expected := COALESCE(rules.old_gold_deduction, 0);
  END IF;
  IF NEW.deduction_rule <> expected_rule OR NEW.rule_percent <> expected THEN
    RAISE EXCEPTION 'Old gold on voucher % takes the shop''s buy-back rule: % off', voucher.voucher_no, expected || '%' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- Old gold's metal next: refiners and bullion dealers -------------------------------------------------

CREATE TABLE jewellery_refinery_challans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  challan_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  -- A refiner refines the metal and gives it back (a supplier); a bullion dealer buys it (the buyer: a customer).
  party TEXT NOT NULL CHECK (party IN ('refiner', 'dealer')),
  contact_id BIGINT NOT NULL,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Closed once: the refined metal back, or sold to the dealer.
  outcome TEXT NOT NULL DEFAULT 'out' CHECK (outcome IN ('out', 'back', 'sold')),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  close_key UUID,
  close_hash CHAR(64),
  -- Back: the purity received, its weight, the fineness it was assayed at and its fine weight.
  back_metal TEXT CHECK (back_metal IN ('gold', 'silver', 'platinum')),
  back_purity TEXT,
  back_net_weight NUMERIC(12,3) CHECK (back_net_weight > 0),
  back_fineness NUMERIC(4,1) CHECK (back_fineness > 0 AND back_fineness < 1000),
  back_fine_weight NUMERIC(12,3),
  -- Sold: the rate per gram of the metal as sent, and the sale bill.
  sale_rate NUMERIC(12,2) CHECK (sale_rate > 0),
  document_id BIGINT,
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, challan_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, close_key),
  CHECK ((outcome = 'out') = (closed_at IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL) AND (closed_at IS NULL) = (close_key IS NULL)
    AND (close_key IS NULL) = (close_hash IS NULL)),
  CHECK ((outcome = 'back') = (back_metal IS NOT NULL) AND (back_metal IS NULL) = (back_purity IS NULL) AND (back_metal IS NULL) = (back_net_weight IS NULL)
    AND (back_metal IS NULL) = (back_fineness IS NULL) AND (back_metal IS NULL) = (back_fine_weight IS NULL)),
  CHECK (back_metal IS NULL OR (jewellery_fineness(back_metal, back_purity) IS NOT NULL AND back_fine_weight = round(back_net_weight * back_fineness / 1000, 3))),
  CHECK ((outcome = 'sold') = (document_id IS NOT NULL) AND (document_id IS NULL) = (sale_rate IS NULL)),
  CHECK (outcome <> 'back' OR party = 'refiner'),
  CHECK (outcome <> 'sold' OR party = 'dealer')
);
CREATE INDEX jewellery_refinery_challans_open ON jewellery_refinery_challans(business_id, created_at) WHERE outcome = 'out';

-- A challan is written now to a refiner (a supplier) or a dealer (a customer:
-- the buyer), and is never deleted; it keeps what was sent and is closed once,
-- now: the refined metal back from a refiner (of the metal sent), or sold to a
-- dealer on a sale bill to them made with it.
CREATE FUNCTION jewellery_refinery_challans_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['outcome', 'closed_by', 'closed_at', 'close_key', 'close_hash', 'back_metal', 'back_purity', 'back_net_weight', 'back_fineness',
    'back_fine_weight', 'sale_rate', 'document_id'];
  sent TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A refinery challan is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at <> now() OR NEW.outcome <> 'out' THEN
      RAISE EXCEPTION 'A refinery challan is written now' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.contact_id
         AND kind = CASE NEW.party WHEN 'refiner' THEN 'supplier' ELSE 'customer' END) THEN
      RAISE EXCEPTION 'A refiner is one of the shop''s suppliers, and a dealer who buys the metal one of its customers' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) OR OLD.outcome <> 'out' OR NEW.outcome = 'out' OR NEW.closed_at <> now() THEN
    RAISE EXCEPTION 'Challan % keeps what was sent, and is closed once', OLD.challan_no USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'back' THEN
    SELECT min(metal) INTO sent FROM jewellery_refinery_lines WHERE business_id = NEW.business_id AND challan_id = NEW.id;
    IF NEW.back_metal IS DISTINCT FROM sent THEN
      RAISE EXCEPTION 'Challan % comes back as the metal it sent' , OLD.challan_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.outcome = 'sold' AND NOT EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id
       AND d.kind = 'sale' AND d.contact_id = NEW.contact_id AND d.created_at = now()) THEN
    RAISE EXCEPTION 'Challan %''s metal is sold to its dealer on a sale bill made with it', OLD.challan_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_refinery_challans_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_refinery_challans
  FOR EACH ROW EXECUTE FUNCTION jewellery_refinery_challans_guard();

-- Each purity sent, out of the shop's metal at the challan's location, at the
-- fineness it is taken at (its purity's unless the shop assayed it).
CREATE TABLE jewellery_refinery_lines (
  business_id BIGINT NOT NULL,
  challan_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 30),
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  net_weight NUMERIC(12,3) NOT NULL CHECK (net_weight > 0),
  fineness NUMERIC(4,1) NOT NULL CHECK (fineness > 0 AND fineness < 1000),
  fine_weight NUMERIC(12,3) NOT NULL,
  PRIMARY KEY (business_id, challan_id, seq),
  FOREIGN KEY (business_id, challan_id) REFERENCES jewellery_refinery_challans(business_id, id),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (fine_weight = round(net_weight * fineness / 1000, 3))
);
CREATE TRIGGER jewellery_refinery_lines_kept BEFORE UPDATE OR DELETE ON jewellery_refinery_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_money_kept();

-- A line goes on its challan when it is written, of one metal with the challan's other lines.
CREATE FUNCTION jewellery_refinery_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE challan RECORD;
BEGIN
  SELECT challan_no, created_at INTO challan FROM jewellery_refinery_challans WHERE business_id = NEW.business_id AND id = NEW.challan_id;
  IF challan.created_at <> now() THEN
    RAISE EXCEPTION 'A line goes on a refinery challan when it is written' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jewellery_refinery_lines WHERE business_id = NEW.business_id AND challan_id = NEW.challan_id AND metal <> NEW.metal) THEN
    RAISE EXCEPTION 'Challan % sends one metal', challan.challan_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_refinery_lines_check BEFORE INSERT ON jewellery_refinery_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_refinery_lines_check();

-- What happens next to each line of old gold (the latest row is where it
-- stands; none: melted with the shop's metal, as it went in).
CREATE TABLE jewellery_old_gold_next (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  old_gold_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL,
  next TEXT NOT NULL CHECK (next IN ('melt', 'resell', 'refinery', 'karigar')),
  refinery_id BIGINT,
  karigar_issue_id BIGINT,
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, old_gold_id, seq) REFERENCES jewellery_old_gold_lines(business_id, old_gold_id, seq),
  FOREIGN KEY (business_id, refinery_id) REFERENCES jewellery_refinery_challans(business_id, id),
  FOREIGN KEY (business_id, karigar_issue_id) REFERENCES jewellery_karigar_issues(business_id, id),
  CHECK ((next = 'refinery') = (refinery_id IS NOT NULL) AND (next = 'karigar') = (karigar_issue_id IS NOT NULL))
);
CREATE INDEX jewellery_old_gold_next_line ON jewellery_old_gold_next(business_id, old_gold_id, seq, id DESC);
CREATE TRIGGER jewellery_old_gold_next_kept BEFORE UPDATE OR DELETE ON jewellery_old_gold_next
  FOR EACH ROW EXECUTE FUNCTION jewellery_money_kept();

-- Old gold of a voucher not cancelled goes on: melted with the shop's metal
-- or kept to resell as it is (a status, changed while it is in the shop),
-- or out once, on a refinery challan or a karigar's issue challan made with it.
CREATE FUNCTION jewellery_old_gold_next_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voucher RECORD; was TEXT;
BEGIN
  SELECT g.voucher_no, g.cancelled_at INTO voucher FROM jewellery_old_gold g WHERE g.business_id = NEW.business_id AND g.id = NEW.old_gold_id;
  IF voucher.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Old gold voucher % is cancelled', voucher.voucher_no USING ERRCODE = '23514';
  END IF;
  SELECT next INTO was FROM jewellery_old_gold_next WHERE business_id = NEW.business_id AND old_gold_id = NEW.old_gold_id AND seq = NEW.seq ORDER BY id DESC LIMIT 1;
  IF was IN ('refinery', 'karigar') THEN
    RAISE EXCEPTION 'Old gold on voucher % went to a % already', voucher.voucher_no, (CASE was WHEN 'refinery' THEN 'refiner or dealer' ELSE 'karigar' END) USING ERRCODE = '23514';
  END IF;
  IF NEW.next = 'refinery' AND NOT EXISTS (SELECT 1 FROM jewellery_refinery_challans WHERE business_id = NEW.business_id AND id = NEW.refinery_id AND created_at = now()) THEN
    RAISE EXCEPTION 'Old gold goes to a refiner or dealer on a refinery challan made with it' USING ERRCODE = '23514';
  END IF;
  IF NEW.next = 'karigar' AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_issues WHERE business_id = NEW.business_id AND id = NEW.karigar_issue_id AND created_at = now()) THEN
    RAISE EXCEPTION 'Old gold goes to a karigar on an issue challan made with it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_old_gold_next_check BEFORE INSERT ON jewellery_old_gold_next
  FOR EACH ROW EXECUTE FUNCTION jewellery_old_gold_next_check();

-- --- Customers' KYC documents ------------------------------------------------------------------------

-- A customer's KYC document (an officially valid document): its type as the
-- shop names it, its number (of an Aadhaar card, only the last four digits),
-- the name on it, the day it was seen; set aside once (entered by mistake),
-- never changed or deleted.
CREATE TABLE jewellery_kyc_documents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  kind VARCHAR(60) NOT NULL CHECK (kind = btrim(kind) AND kind <> ''),
  number VARCHAR(40) NOT NULL CHECK (number ~ '^[A-Z0-9][A-Z0-9/ -]{1,39}$'),
  name_on_document VARCHAR(150) CHECK (btrim(name_on_document) <> ''),
  seen_on DATE NOT NULL,
  notes VARCHAR(300) CHECK (btrim(notes) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  removed_by BIGINT REFERENCES users(id),
  remove_reason VARCHAR(300) CHECK (btrim(remove_reason) <> ''),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (kind !~* 'aadhaar' OR number ~ '^[0-9]{4}$'),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL) AND (removed_at IS NULL) = (remove_reason IS NULL))
);
CREATE INDEX jewellery_kyc_documents_contact ON jewellery_kyc_documents(business_id, contact_id);
CREATE TRIGGER jewellery_kyc_documents_customer BEFORE INSERT ON jewellery_kyc_documents
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A firm's beneficial owner: name, role, share and PAN; set aside once, never changed or deleted.
CREATE TABLE jewellery_kyc_owners (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  role VARCHAR(60) NOT NULL CHECK (btrim(role) <> ''),
  share_percent NUMERIC(5,2) CHECK (share_percent > 0 AND share_percent <= 100),
  pan CHAR(10) CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  removed_by BIGINT REFERENCES users(id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX jewellery_kyc_owners_contact ON jewellery_kyc_owners(business_id, contact_id);
CREATE TRIGGER jewellery_kyc_owners_customer BEFORE INSERT ON jewellery_kyc_owners
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A KYC record is made now (a document seen on or before the business's
-- date, of a type the shop accepts), keeps what was written, and is set aside
-- once; it is never deleted.
CREATE FUNCTION jewellery_kyc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A KYC record is never deleted: set it aside instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at <> now() OR NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A KYC record is written now' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'jewellery_kyc_documents' THEN
      IF NEW.seen_on > (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date THEN
        RAISE EXCEPTION 'A KYC document is seen today or earlier' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jewellery_settings s WHERE s.business_id = NEW.business_id AND NEW.kind = ANY (s.kyc_kinds)) THEN
        RAISE EXCEPTION '% is not one of the KYC documents the shop accepts: add it in Jewellery settings first', NEW.kind USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS DISTINCT FROM now()
     OR (to_jsonb(NEW) - ARRAY['removed_at', 'removed_by', 'remove_reason']) <> (to_jsonb(OLD) - ARRAY['removed_at', 'removed_by', 'remove_reason']) THEN
    RAISE EXCEPTION 'A KYC record is kept as it was written: it is only set aside, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_kyc_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_kyc_documents
  FOR EACH ROW EXECUTE FUNCTION jewellery_kyc_guard();
CREATE TRIGGER jewellery_kyc_owners_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_kyc_owners
  FOR EACH ROW EXECUTE FUNCTION jewellery_kyc_guard();

-- --- Photos of old gold and copies of KYC documents -------------------------------------------------------

ALTER TABLE jewellery_files
  ADD COLUMN old_gold_id BIGINT,
  ADD COLUMN kyc_id BIGINT;
ALTER TABLE jewellery_files
  ADD CONSTRAINT jewellery_files_old_gold FOREIGN KEY (business_id, old_gold_id) REFERENCES jewellery_old_gold(business_id, id),
  ADD CONSTRAINT jewellery_files_kyc FOREIGN KEY (business_id, kyc_id) REFERENCES jewellery_kyc_documents(business_id, id),
  DROP CONSTRAINT jewellery_files_kind_check,
  ADD CONSTRAINT jewellery_files_kind_check CHECK (kind IN ('photo', 'design', 'old_gold', 'kyc')),
  DROP CONSTRAINT jewellery_files_check,
  ADD CONSTRAINT jewellery_files_owner CHECK ((kind = 'photo') = (piece_id IS NOT NULL) AND (kind = 'design') = (order_id IS NOT NULL)
    AND (kind = 'old_gold') = (old_gold_id IS NOT NULL) AND (kind = 'kyc') = (kyc_id IS NOT NULL)),
  DROP CONSTRAINT jewellery_files_stored_name_check,
  ADD CONSTRAINT jewellery_files_stored_name_check CHECK (stored_name ~ '^[a-f0-9]{32}\.(jpg|png|webp|pdf)$'),
  DROP CONSTRAINT jewellery_files_mime_type_check,
  ADD CONSTRAINT jewellery_files_mime_type_check CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  -- Only a KYC document's copy may be a PDF.
  ADD CONSTRAINT jewellery_files_pdf CHECK (mime_type <> 'application/pdf' OR kind = 'kyc');
CREATE INDEX jewellery_files_old_gold ON jewellery_files(business_id, old_gold_id) WHERE old_gold_id IS NOT NULL;
CREATE INDEX jewellery_files_kyc ON jewellery_files(business_id, kyc_id) WHERE kyc_id IS NOT NULL;

-- --- Gold schemes: the day-364 close into safekeeping, money put back ---------------------------------------

ALTER TABLE jewellery_pieces DROP CONSTRAINT jewellery_pieces_status_check,
  ADD CONSTRAINT jewellery_pieces_status_check CHECK (status IN ('in_stock', 'on_approval', 'at_karigar', 'at_centre', 'sold', 'melted', 'split', 'merged', 'retagged',
    'safekeeping'));
ALTER TABLE jewellery_piece_events DROP CONSTRAINT jewellery_piece_events_kind_check,
  ADD CONSTRAINT jewellery_piece_events_kind_check CHECK (kind IN ('tagged', 'changed', 'sent', 'back', 'sold', 'returned', 'melted', 'split', 'merged', 'retagged',
    'safekeeping', 'collected'));

-- Where a piece is, as the fine-weight book keeps it (none once it has left
-- the shop); a piece in safekeeping is its buyer's, still in the shop.
CREATE OR REPLACE FUNCTION jewellery_holder_of(status TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE status WHEN 'in_stock' THEN 'stock' WHEN 'on_approval' THEN 'approval' WHEN 'at_karigar' THEN 'karigar' WHEN 'at_centre' THEN 'centre'
    WHEN 'safekeeping' THEN 'safekeeping' END;
$$;

-- A scheme closed on its day 364: the jewellery bill that redeems it, of one
-- piece of gold or silver tagged now from the shop's metal for the scheme's
-- money at that day's rate, held in the customer's safekeeping until they
-- collect it.
CREATE TABLE jewellery_scheme_closes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  scheme_id BIGINT NOT NULL,
  bill_id BIGINT NOT NULL,
  piece_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Collected by the customer: when, who handed it over, and a note.
  collected_at TIMESTAMPTZ,
  collected_by BIGINT REFERENCES users(id),
  collect_note VARCHAR(300) CHECK (btrim(collect_note) <> ''),
  FOREIGN KEY (business_id, scheme_id) REFERENCES jewellery_schemes(business_id, id),
  FOREIGN KEY (business_id, bill_id) REFERENCES jewellery_bills(business_id, id),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, scheme_id),
  UNIQUE (business_id, piece_id),
  UNIQUE (business_id, request_key),
  CHECK ((collected_at IS NULL) = (collected_by IS NULL) AND (collected_at IS NOT NULL OR collect_note IS NULL))
);
CREATE INDEX jewellery_scheme_closes_held ON jewellery_scheme_closes(business_id, created_at) WHERE collected_at IS NULL;

-- A close is made now, on or after the scheme's day 364 (the business's
-- date), by the bill that redeems the scheme now, of the close's piece; it is
-- collected once, now; it is never deleted.
CREATE FUNCTION jewellery_scheme_closes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheme RECORD; bill RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A gold scheme''s close is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.collected_at IS NOT NULL OR NEW.collected_at IS DISTINCT FROM now()
       OR (to_jsonb(NEW) - ARRAY['collected_at', 'collected_by', 'collect_note']) <> (to_jsonb(OLD) - ARRAY['collected_at', 'collected_by', 'collect_note']) THEN
      RAISE EXCEPTION 'What a gold scheme was closed into is collected once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT s.scheme_no, s.status, s.redeemed_document_id, s.close_by, (now() AT TIME ZONE b.timezone)::date AS today INTO scheme
  FROM jewellery_schemes s JOIN businesses b ON b.id = s.business_id WHERE s.business_id = NEW.business_id AND s.id = NEW.scheme_id;
  SELECT document_id, scheme_id, location_id, created_at INTO bill FROM jewellery_bills WHERE business_id = NEW.business_id AND id = NEW.bill_id;
  IF NEW.created_at <> now() OR NEW.collected_at IS NOT NULL THEN
    RAISE EXCEPTION 'A gold scheme is closed now' USING ERRCODE = '23514';
  END IF;
  IF scheme.today < scheme.close_by THEN
    RAISE EXCEPTION 'Scheme % closes on its day 364, %: until then it is redeemed on a jewellery bill', scheme.scheme_no, scheme.close_by USING ERRCODE = '23514';
  END IF;
  IF scheme.status <> 'redeemed' OR scheme.redeemed_document_id IS DISTINCT FROM bill.document_id OR bill.scheme_id IS DISTINCT FROM NEW.scheme_id
     OR bill.created_at <> now() OR bill.location_id <> NEW.location_id
     OR NOT EXISTS (SELECT 1 FROM jewellery_bill_lines WHERE business_id = NEW.business_id AND bill_id = NEW.bill_id AND piece_id = NEW.piece_id)
     OR (SELECT count(*) FROM jewellery_bill_lines WHERE business_id = NEW.business_id AND bill_id = NEW.bill_id) <> 1
     OR EXISTS (SELECT 1 FROM jewellery_bill_items WHERE business_id = NEW.business_id AND bill_id = NEW.bill_id) THEN
    RAISE EXCEPTION 'Scheme % is closed by the jewellery bill that redeems it now, of the one piece held for it', scheme.scheme_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_scheme_closes_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_scheme_closes
  FOR EACH ROW EXECUTE FUNCTION jewellery_scheme_closes_guard();

-- A close's piece is in safekeeping when it is made (checked when the transaction ends).
CREATE FUNCTION jewellery_scheme_closes_held() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jewellery_pieces WHERE business_id = NEW.business_id AND id = NEW.piece_id AND status = 'safekeeping') THEN
    RAISE EXCEPTION 'A gold scheme''s close holds its piece in the customer''s safekeeping' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jewellery_scheme_closes_held AFTER INSERT ON jewellery_scheme_closes DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jewellery_scheme_closes_held();

-- A scheme's money put back from the bill that redeemed it, when that bill is
-- returned within the scheme's tenure (the bill's credit given back by credit
-- note), and used again on the bill that redeems it next (a credit-note
-- payment on that bill).
CREATE TABLE jewellery_scheme_moves (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  scheme_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('back', 'used')),
  document_id BIGINT NOT NULL,
  refund_id BIGINT REFERENCES business_refunds(id),
  payment_id BIGINT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, scheme_id) REFERENCES jewellery_schemes(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, payment_id) REFERENCES business_payments(business_id, id),
  UNIQUE (refund_id),
  UNIQUE (business_id, payment_id),
  CHECK ((kind = 'back') = (refund_id IS NOT NULL) AND (kind = 'used') = (payment_id IS NOT NULL))
);
CREATE INDEX jewellery_scheme_moves_scheme ON jewellery_scheme_moves(business_id, scheme_id);
CREATE TRIGGER jewellery_scheme_moves_kept BEFORE UPDATE OR DELETE ON jewellery_scheme_moves
  FOR EACH ROW EXECUTE FUNCTION jewellery_money_kept();

-- The money a scheme holds now: its instalments not yet paid on a bill, and
-- what came back onto it, less what was used again.
CREATE FUNCTION jewellery_scheme_held(target_business BIGINT, target_scheme BIGINT) RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT sum(i.amount) FROM jewellery_scheme_instalments i WHERE i.business_id = target_business AND i.scheme_id = target_scheme), 0)
    - COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN jewellery_scheme_instalments i ON i.business_id = p.business_id AND i.collection_id = p.collection_id
        WHERE p.business_id = target_business AND i.scheme_id = target_scheme), 0)
    + COALESCE((SELECT sum(CASE kind WHEN 'back' THEN amount ELSE -amount END) FROM jewellery_scheme_moves WHERE business_id = target_business AND scheme_id = target_scheme), 0);
$$;

-- Back: the redeeming bill's credit-note refund made with it, no more than
-- the scheme paid on that bill and has not had back, while the scheme is
-- within its tenure (to its day 364). Used: a credit-note payment made with it
-- on the bill that redeems the scheme, naming the scheme, of no more than it holds.
CREATE FUNCTION jewellery_scheme_moves_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheme RECORD; entry RECORD; paid NUMERIC; back NUMERIC;
BEGIN
  SELECT s.scheme_no, s.status, s.redeemed_document_id, s.close_by, (now() AT TIME ZONE b.timezone)::date AS today INTO scheme
  FROM jewellery_schemes s JOIN businesses b ON b.id = s.business_id WHERE s.business_id = NEW.business_id AND s.id = NEW.scheme_id;
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'A gold scheme''s money moves now' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'back' THEN
    IF scheme.today > scheme.close_by THEN
      RAISE EXCEPTION 'Scheme % ended on its day 364 (%): its money stays on the returned bill as the customer''s credit', scheme.scheme_no, scheme.close_by USING ERRCODE = '23514';
    END IF;
    IF scheme.status <> 'redeemed' OR scheme.redeemed_document_id IS DISTINCT FROM NEW.document_id THEN
      RAISE EXCEPTION 'Scheme %''s money goes back onto it from the bill that redeemed it', scheme.scheme_no USING ERRCODE = '23514';
    END IF;
    SELECT document_id, method, amount, created_at INTO entry FROM business_refunds WHERE business_id = NEW.business_id AND id = NEW.refund_id;
    IF entry.document_id <> NEW.document_id OR entry.method <> 'credit_note' OR entry.amount <> NEW.amount OR entry.created_at <> now() THEN
      RAISE EXCEPTION 'Scheme %''s money put back is the bill''s credit given back by credit note, made with it', scheme.scheme_no USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(p.amount), 0) INTO paid FROM business_payments p JOIN jewellery_scheme_instalments i ON i.business_id = p.business_id AND i.collection_id = p.collection_id
    WHERE p.business_id = NEW.business_id AND p.document_id = NEW.document_id AND i.scheme_id = NEW.scheme_id;
    paid := paid + COALESCE((SELECT sum(amount) FROM jewellery_scheme_moves WHERE business_id = NEW.business_id AND scheme_id = NEW.scheme_id AND document_id = NEW.document_id
      AND kind = 'used'), 0);
    SELECT COALESCE(sum(amount), 0) INTO back FROM jewellery_scheme_moves WHERE business_id = NEW.business_id AND scheme_id = NEW.scheme_id AND document_id = NEW.document_id
      AND kind = 'back';
    IF back + NEW.amount > paid THEN
      RAISE EXCEPTION 'No more goes back onto scheme % from its bill than it paid on it', scheme.scheme_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.document_id, p.method, p.amount, p.reference, p.created_at INTO entry FROM business_payments p WHERE p.business_id = NEW.business_id AND p.id = NEW.payment_id;
  IF entry.document_id <> NEW.document_id OR entry.method <> 'credit_note' OR entry.amount <> NEW.amount OR entry.reference IS DISTINCT FROM scheme.scheme_no
     OR entry.created_at <> now() OR NOT EXISTS (SELECT 1 FROM jewellery_bills WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND scheme_id = NEW.scheme_id) THEN
    RAISE EXCEPTION 'Scheme %''s money is used on the bill that redeems it, by a payment made with it', scheme.scheme_no USING ERRCODE = '23514';
  END IF;
  IF NEW.amount > COALESCE((SELECT sum(CASE kind WHEN 'back' THEN amount ELSE -amount END) FROM jewellery_scheme_moves
       WHERE business_id = NEW.business_id AND scheme_id = NEW.scheme_id), 0) THEN
    RAISE EXCEPTION 'Scheme % has no more put back on it to use', scheme.scheme_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_scheme_moves_check BEFORE INSERT ON jewellery_scheme_moves
  FOR EACH ROW EXECUTE FUNCTION jewellery_scheme_moves_check();

-- A scheme may be redeemed again once its money is put back: one bill each time.
ALTER TABLE jewellery_bills DROP CONSTRAINT jewellery_bills_business_id_scheme_id_key;
CREATE INDEX jewellery_bills_scheme ON jewellery_bills(business_id, scheme_id) WHERE scheme_id IS NOT NULL;

-- A scheme keeps what it was joined with and is never deleted. It is stopped
-- once, from active, with the reason, who asked and who approved; it is
-- redeemed by the jewellery bill made with it for its member, with the
-- discount the plan gives: one instalment × its percentage, only when every
-- instalment is paid, the scheme was not stopped, and the bill's day is on or
-- after its maturity; and it is open again (active, or stopped as it was) when
-- its money is put back from that bill. A customer's data erased at their
-- request leaves only their copies on it.
CREATE OR REPLACE FUNCTION jewellery_schemes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['status', 'stop_reason', 'stopped_by', 'stop_approved_by', 'stopped_at', 'redeemed_document_id', 'redeemed_at', 'discount'];
  bill RECORD; paid INTEGER; today DATE; earned NUMERIC;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
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
  IF OLD.status = 'redeemed' THEN
    IF NEW.status <> (CASE WHEN OLD.stopped_at IS NULL THEN 'active' ELSE 'stopped' END) OR NEW.redeemed_document_id IS NOT NULL
       OR (NEW.stopped_at IS DISTINCT FROM OLD.stopped_at) OR NOT EXISTS (SELECT 1 FROM jewellery_scheme_moves m WHERE m.business_id = NEW.business_id
         AND m.scheme_id = NEW.id AND m.kind = 'back' AND m.document_id = OLD.redeemed_document_id AND m.created_at = now()) THEN
      RAISE EXCEPTION 'Scheme % is open again only when its money is put back from the bill that redeemed it', OLD.scheme_no USING ERRCODE = '23514';
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

-- A redeemed scheme holds nothing: all its money pays the bill that redeems
-- it (checked when the transaction ends).
CREATE OR REPLACE FUNCTION jewellery_schemes_redeemed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held NUMERIC;
BEGIN
  held := jewellery_scheme_held(NEW.business_id, NEW.id);
  IF held <> 0 THEN
    RAISE EXCEPTION 'Scheme %''s ₹% all pays the bill that redeems it', NEW.scheme_no, (held + COALESCE((SELECT sum(p.amount) FROM business_payments p
      JOIN jewellery_scheme_instalments i ON i.business_id = p.business_id AND i.collection_id = p.collection_id
      WHERE p.business_id = NEW.business_id AND p.document_id = NEW.redeemed_document_id AND i.scheme_id = NEW.id), 0))::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- --- The cash report: family groups --------------------------------------------------------------------

CREATE TABLE jewellery_cash_families (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX jewellery_cash_families_name ON jewellery_cash_families(business_id, lower(name));

-- A customer belongs to one family group at a time.
CREATE TABLE jewellery_cash_family_members (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  family_id BIGINT NOT NULL,
  added_by BIGINT NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, family_id) REFERENCES jewellery_cash_families(business_id, id)
);
CREATE INDEX jewellery_cash_family_members_family ON jewellery_cash_family_members(business_id, family_id);
CREATE TRIGGER jewellery_cash_family_members_customer BEFORE INSERT ON jewellery_cash_family_members
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- --- The suspicious transaction log ----------------------------------------------------------------------

-- A case: who (a customer, or a name as known), what was seen, the
-- transactions it concerns, and the decision once: reported (filed by the
-- shop's officer outside the platform, with the day and the acknowledgement)
-- or not reported, with why. Never changed otherwise, never deleted.
CREATE TABLE jewellery_str_cases (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  case_no INTEGER NOT NULL CHECK (case_no > 0),
  contact_id BIGINT,
  subject VARCHAR(150) NOT NULL CHECK (btrim(subject) <> ''),
  grounds TEXT NOT NULL CHECK (btrim(grounds) <> '' AND length(grounds) <= 4000),
  transactions VARCHAR(500) CHECK (btrim(transactions) <> ''),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reported', 'not_reported')),
  decision_note TEXT CHECK (btrim(decision_note) <> '' AND length(decision_note) <= 4000),
  reported_on DATE,
  report_ref VARCHAR(80) CHECK (btrim(report_ref) <> ''),
  decided_by BIGINT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, case_no),
  UNIQUE (business_id, request_key),
  CHECK ((status = 'open') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL) AND (decided_at IS NULL) = (decision_note IS NULL)),
  CHECK ((status = 'reported') = (reported_on IS NOT NULL) AND (reported_on IS NOT NULL OR report_ref IS NULL))
);

CREATE FUNCTION jewellery_str_cases_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['status', 'decision_note', 'reported_on', 'report_ref', 'decided_by', 'decided_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A case in the suspicious transaction log is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at <> now() OR NEW.status <> 'open' THEN
      RAISE EXCEPTION 'A case is opened now' USING ERRCODE = '23514';
    END IF;
    IF NEW.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.contact_id AND kind = 'customer') THEN
      RAISE EXCEPTION 'Choose a customer of this business' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) OR OLD.status <> 'open' OR NEW.status = 'open' OR NEW.decided_at <> now()
     OR NEW.reported_on > (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date THEN
    RAISE EXCEPTION 'Case % keeps what was written, and is decided once', OLD.case_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_str_cases_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_str_cases
  FOR EACH ROW EXECUTE FUNCTION jewellery_str_cases_guard();

-- Each case's history, who and when: opened, a note, opened to read, decided.
CREATE TABLE jewellery_str_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  case_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opened', 'note', 'viewed', 'decided')),
  note TEXT CHECK (btrim(note) <> '' AND length(note) <= 4000),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, case_id) REFERENCES jewellery_str_cases(business_id, id),
  CHECK ((kind = 'note') <= (note IS NOT NULL))
);
CREATE INDEX jewellery_str_entries_case ON jewellery_str_entries(business_id, case_id, id);
CREATE TRIGGER jewellery_str_entries_kept BEFORE UPDATE OR DELETE ON jewellery_str_entries
  FOR EACH ROW EXECUTE FUNCTION jewellery_money_kept();

-- --- The jewellery bill: offers, discounts, loose stones and coins -------------------------------------------

-- An offer on making: a percentage off the making charge of the pieces of a
-- metal (or every metal) billed between two dates of the business's clock. Its
-- terms never change (a new offer is made); it is switched off, never deleted.
CREATE TABLE jewellery_offers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  making_percent NUMERIC(5,2) NOT NULL CHECK (making_percent > 0 AND making_percent <= 100),
  metal TEXT CHECK (metal IN ('gold', 'silver', 'platinum')),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX jewellery_offers_running ON jewellery_offers(business_id, starts_on, ends_on) WHERE active;

CREATE FUNCTION jewellery_offers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An offer is never deleted: switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['active', 'updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['active', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'Offer % keeps its terms: make a new offer for other terms', OLD.name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_offers_guard BEFORE UPDATE OR DELETE ON jewellery_offers
  FOR EACH ROW EXECUTE FUNCTION jewellery_offers_guard();

ALTER TABLE jewellery_bills
  -- The offers' discount on making, the counter's discount and why, and whether the metal could take it (the rule billed under).
  ADD COLUMN offer_discount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (offer_discount >= 0),
  ADD COLUMN counter_discount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (counter_discount >= 0),
  ADD COLUMN discount_reason VARCHAR(300) CHECK (btrim(discount_reason) <> ''),
  ADD COLUMN discount_on_metal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jewellery_bills ADD CONSTRAINT jewellery_bills_counter_discount CHECK ((counter_discount = 0) = (discount_reason IS NULL));

ALTER TABLE jewellery_bill_lines
  -- The offer on making the piece took, and its share of the counter's discount (both within its discount).
  ADD COLUMN offer_id BIGINT,
  ADD COLUMN offer_discount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (offer_discount >= 0),
  ADD COLUMN counter_discount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (counter_discount >= 0);
ALTER TABLE jewellery_bill_lines
  ADD CONSTRAINT jewellery_bill_lines_offer FOREIGN KEY (business_id, offer_id) REFERENCES jewellery_offers(business_id, id),
  ADD CONSTRAINT jewellery_bill_lines_discounts CHECK (offer_discount + counter_discount <= discount AND (offer_id IS NOT NULL OR offer_discount = 0));

-- Loose stones and coins on a jewellery bill: each a line of the bill's sale
-- at its own price and GST slab, with its share of the scheme's discount.
CREATE TABLE jewellery_bill_items (
  business_id BIGINT NOT NULL,
  bill_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  -- Its price a unit as the catalogue had it, its value before GST, the scheme's share of the discount, then its taxable value and GST.
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  value NUMERIC(14,2) NOT NULL CHECK (value >= 0),
  discount NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxable NUMERIC(14,2) NOT NULL,
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate >= 0),
  tax NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (business_id, line_id),
  FOREIGN KEY (business_id, bill_id) REFERENCES jewellery_bills(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (discount >= 0 AND discount <= value),
  CHECK (taxable = value - discount),
  CHECK (tax = round(taxable * tax_rate / 100, 2))
);
CREATE INDEX jewellery_bill_items_bill ON jewellery_bill_items(business_id, bill_id);
CREATE TRIGGER jewellery_bill_items_kept BEFORE UPDATE OR DELETE ON jewellery_bill_items
  FOR EACH ROW EXECUTE FUNCTION jewellery_money_kept();

-- An item goes on a jewellery bill when the bill is made, on a line of the
-- bill's own sale (its item and quantity, at its taxable value, slab and GST):
-- goods that are not tagged pieces' items or the jeweller's own account items.
CREATE FUNCTION jewellery_bill_items_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill RECORD; line RECORD; item RECORD;
BEGIN
  SELECT document_id, created_at INTO bill FROM jewellery_bills WHERE business_id = NEW.business_id AND id = NEW.bill_id;
  IF bill.created_at <> now() THEN
    RAISE EXCEPTION 'An item goes on a jewellery bill when the bill is made' USING ERRCODE = '23514';
  END IF;
  SELECT s.label, p.kind INTO item FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
  WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
  IF item.kind IS DISTINCT FROM 'goods' OR EXISTS (SELECT 1 FROM jewellery_items WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id)
     OR EXISTS (SELECT 1 FROM jewellery_account_items WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id) THEN
    RAISE EXCEPTION '% is not a loose stone or coin: a tagged piece goes on the bill by its tag', item.label USING ERRCODE = '23514';
  END IF;
  SELECT document_id, sku_id, quantity, net, tax, tax_rate INTO line FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.line_id;
  IF line.document_id IS DISTINCT FROM bill.document_id OR line.sku_id <> NEW.sku_id OR line.quantity <> NEW.quantity OR line.net <> NEW.taxable OR line.tax <> NEW.tax
     OR line.tax_rate <> NEW.tax_rate THEN
    RAISE EXCEPTION '% is billed on a line of its own sale, at its taxable value, slab and GST', item.label USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_bill_items_check BEFORE INSERT ON jewellery_bill_items
  FOR EACH ROW EXECUTE FUNCTION jewellery_bill_items_check();

-- A bill is its own sale, posted in the same transaction at its location to its
-- customer, priced at the rates of the business's date, under the hallmarking
-- rules and the counter discount rule the business has then.
CREATE OR REPLACE FUNCTION jewellery_bills_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc RECORD; rules RECORD;
BEGIN
  SELECT kind, location_id, contact_id, created_at INTO doc FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' OR doc.created_at <> now() OR doc.location_id <> NEW.location_id OR doc.contact_id IS DISTINCT FROM NEW.contact_id THEN
    RAISE EXCEPTION 'A jewellery bill is its own sale, posted with it at its location to its customer' USING ERRCODE = '23514';
  END IF;
  SELECT (now() AT TIME ZONE b.timezone)::date AS today, COALESCE(l.mandatory_hallmarking, TRUE) AS mandatory, COALESCE(s.turnover_exempt, FALSE) AS exempt,
      COALESCE(s.discount_on_metal, FALSE) AS on_metal INTO rules
  FROM businesses b LEFT JOIN jewellery_locations l ON l.business_id = b.id AND l.location_id = NEW.location_id
  LEFT JOIN jewellery_settings s ON s.business_id = b.id WHERE b.id = NEW.business_id;
  IF NEW.rate_date <> rules.today OR NEW.hallmark_mandatory <> rules.mandatory OR NEW.turnover_exempt <> rules.exempt THEN
    RAISE EXCEPTION 'A jewellery bill is priced at today''s rates under the hallmarking rules the business has today' USING ERRCODE = '23514';
  END IF;
  IF NEW.discount_on_metal <> rules.on_metal THEN
    RAISE EXCEPTION 'A jewellery bill takes a counter discount under the rule the business has today' USING ERRCODE = '23514';
  END IF;
  IF NEW.scheme_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jewellery_schemes WHERE business_id = NEW.business_id AND id = NEW.scheme_id
       AND contact_id = NEW.contact_id AND status IN ('active', 'stopped')) THEN
    RAISE EXCEPTION 'A jewellery bill redeems a gold scheme of its own customer, not yet redeemed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A bill's pieces and items carry its scheme's discount, all of it, and no
-- other but the offers' and the counter's it names (checked when the
-- transaction ends).
CREATE OR REPLACE FUNCTION jewellery_bills_discount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sums RECORD; items NUMERIC;
BEGIN
  SELECT COALESCE(sum(discount - offer_discount - counter_discount), 0) AS scheme, COALESCE(sum(offer_discount), 0) AS offer, COALESCE(sum(counter_discount), 0) AS counter
    INTO sums FROM jewellery_bill_lines WHERE business_id = NEW.business_id AND bill_id = NEW.id;
  SELECT COALESCE(sum(discount), 0) INTO items FROM jewellery_bill_items WHERE business_id = NEW.business_id AND bill_id = NEW.id;
  IF sums.scheme + items <> NEW.scheme_discount OR sums.offer <> NEW.offer_discount OR sums.counter <> NEW.counter_discount THEN
    RAISE EXCEPTION 'A jewellery bill''s lines carry its gold scheme''s discount, ₹%, its offers'' ₹% and the counter''s ₹%, and no other', NEW.scheme_discount,
      NEW.offer_discount, NEW.counter_discount USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- A bill's piece is on a line of the bill's own sale (its item, its tag as the
-- serial number, one unit, at the line's taxable value and GST), as the piece
-- is now in stock, at the latest rate of the day for its purity, except that a
-- custom order's piece on the order's own bill takes the order's fixed rate
-- for the grams fixed and not yet taken by the bill's earlier lines (and a
-- piece made for an open order goes on no other bill); its making takes the
-- shop's best offer on making running on the bill's day for its metal, and a
-- counter discount comes off its making and wastage (and its metal only where
-- the shop allows it); and a gold piece of 2 g or more carries its BIS
-- hallmark's HUID unless the article is left out of the hallmarking order, the
-- business is exempt by its turnover, or the district is not under mandatory
-- hallmarking (a piece with the old hallmark is re-hallmarked first).
CREATE OR REPLACE FUNCTION jewellery_bill_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill RECORD; line RECORD; piece RECORD; rate RECORD; marks TEXT[]; stones NUMERIC; expected TEXT; ord RECORD; taken NUMERIC; best RECORD;
BEGIN
  SELECT b.document_id, b.created_at, b.hallmark_mandatory, b.turnover_exempt, b.order_id, b.rate_date, b.discount_on_metal INTO bill FROM jewellery_bills b
  WHERE b.business_id = NEW.business_id AND b.id = NEW.bill_id;
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
  -- A piece made for an open custom order is billed only on the order's own bill.
  SELECT o.id, o.order_no INTO ord FROM jewellery_order_pieces op JOIN jewellery_orders o ON o.business_id = op.business_id AND o.id = op.order_id
  WHERE op.business_id = NEW.business_id AND op.piece_id = NEW.piece_id AND o.status NOT IN ('delivered', 'cancelled');
  IF FOUND AND ord.id IS DISTINCT FROM bill.order_id THEN
    RAISE EXCEPTION 'Piece % was made for custom order %: it is billed on the order''s own bill', piece.tag_no, ord.order_no USING ERRCODE = '23514';
  END IF;
  IF bill.order_id IS NOT NULL AND EXISTS (SELECT 1 FROM jewellery_order_pieces WHERE business_id = NEW.business_id AND order_id = bill.order_id AND piece_id = NEW.piece_id) THEN
    SELECT order_no, fixed_sheet_id, fixed_rate, fixed_weight INTO ord FROM jewellery_orders WHERE business_id = NEW.business_id AND id = bill.order_id;
    SELECT COALESCE(sum(fixed_weight), 0) INTO taken FROM jewellery_bill_lines WHERE business_id = NEW.business_id AND bill_id = NEW.bill_id;
    IF NEW.fixed_weight <> LEAST(piece.net_weight, GREATEST(COALESCE(ord.fixed_weight, 0) - taken, 0))
       OR (NEW.fixed_weight > 0 AND (NEW.fixed_rate <> ord.fixed_rate OR NEW.fixed_sheet_id <> ord.fixed_sheet_id)) THEN
      RAISE EXCEPTION 'Piece % of order % is priced at the rate fixed on the order for the grams fixed, and at the day''s rate for the rest', piece.tag_no, ord.order_no
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.fixed_weight <> 0 THEN
    RAISE EXCEPTION 'Piece % is priced at the day''s rate: only a custom order''s piece on its own bill takes the rate fixed on the order', piece.tag_no USING ERRCODE = '23514';
  END IF;
  -- The shop's best offer on making for the piece's metal, running on the bill's day.
  SELECT o.id, o.making_percent INTO best FROM jewellery_offers o WHERE o.business_id = NEW.business_id AND o.active AND o.starts_on <= bill.rate_date
    AND o.ends_on >= bill.rate_date AND (o.metal IS NULL OR o.metal = piece.metal) ORDER BY o.making_percent DESC, o.id LIMIT 1;
  IF NEW.offer_id IS DISTINCT FROM (CASE WHEN NEW.making_charge > 0 THEN best.id END)
     OR NEW.offer_discount <> (CASE WHEN NEW.making_charge > 0 AND best.id IS NOT NULL THEN round(NEW.making_charge * best.making_percent / 100, 2) ELSE 0 END) THEN
    RAISE EXCEPTION 'Piece %''s making takes the shop''s best offer running today, as the offer gives it', piece.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.counter_discount > NEW.making_charge + NEW.wastage_value - NEW.offer_discount + (CASE WHEN bill.discount_on_metal THEN NEW.metal_value ELSE 0 END) THEN
    RAISE EXCEPTION 'A discount at the counter comes off piece %''s making and wastage%', piece.tag_no,
      (CASE WHEN bill.discount_on_metal THEN ' and metal' ELSE ' (never its metal, as the shop''s settings say)' END) USING ERRCODE = '23514';
  END IF;
  expected := CASE WHEN marks <> '{}' THEN 'huid' WHEN piece.metal <> 'gold' THEN 'not_gold' WHEN piece.gross_weight < 2 THEN 'under_2g'
    WHEN piece.exemption IS NOT NULL THEN piece.exemption WHEN bill.turnover_exempt THEN 'turnover' WHEN NOT bill.hallmark_mandatory THEN 'district' END;
  IF expected IS NULL AND piece.old_hallmark THEN
    RAISE EXCEPTION 'Piece % (gold, % g) carries the old hallmark without a HUID: it is re-hallmarked before it is sold here', piece.tag_no, piece.gross_weight USING ERRCODE = '23514';
  END IF;
  IF expected IS NULL THEN
    RAISE EXCEPTION 'Piece % (gold, % g) needs its BIS hallmark with a HUID before it is sold here', piece.tag_no, piece.gross_weight USING ERRCODE = '23514';
  END IF;
  IF NEW.hallmark_basis <> expected THEN
    RAISE EXCEPTION 'Piece % goes through the HUID check as %', piece.tag_no, replace(expected, '_', ' ') USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- The shop's metal: to refiners and dealers and back, into safekeeping ---------------------------------

ALTER TABLE jewellery_metal_movements
  ADD COLUMN refinery_id BIGINT,
  ADD COLUMN refinery_seq SMALLINT;
ALTER TABLE jewellery_metal_movements
  ADD CONSTRAINT jewellery_metal_movements_refinery FOREIGN KEY (business_id, refinery_id) REFERENCES jewellery_refinery_challans(business_id, id),
  ADD CONSTRAINT jewellery_metal_movements_refinery_line FOREIGN KEY (business_id, refinery_id, refinery_seq) REFERENCES jewellery_refinery_lines(business_id, challan_id, seq),
  DROP CONSTRAINT jewellery_metal_movements_source_check,
  ADD CONSTRAINT jewellery_metal_movements_source_check CHECK (source IN ('melted_piece', 'old_gold', 'old_gold_cancelled', 'karigar_issue', 'karigar_return',
    'supplier_in', 'supplier_out', 'refinery_out', 'refinery_back', 'safekeeping')),
  DROP CONSTRAINT jewellery_metal_movements_check1,
  ADD CONSTRAINT jewellery_metal_movements_piece_ref CHECK ((source IN ('melted_piece', 'safekeeping')) = (piece_id IS NOT NULL)),
  DROP CONSTRAINT jewellery_metal_movements_direction,
  ADD CONSTRAINT jewellery_metal_movements_direction CHECK ((net_weight > 0) = (source IN ('melted_piece', 'old_gold', 'karigar_return', 'supplier_in', 'refinery_back'))),
  ADD CONSTRAINT jewellery_metal_movements_refinery_refs CHECK ((source IN ('refinery_out', 'refinery_back')) = (refinery_id IS NOT NULL)
    AND (source = 'refinery_out') = (refinery_seq IS NOT NULL));
DROP INDEX jewellery_metal_movements_piece;
CREATE UNIQUE INDEX jewellery_metal_movements_piece ON jewellery_metal_movements(business_id, piece_id, source) WHERE piece_id IS NOT NULL;
CREATE UNIQUE INDEX jewellery_metal_movements_refinery_line ON jewellery_metal_movements(business_id, refinery_id, refinery_seq) WHERE source = 'refinery_out';
CREATE UNIQUE INDEX jewellery_metal_movements_refinery_back ON jewellery_metal_movements(business_id, refinery_id) WHERE source = 'refinery_back';

-- A melted piece's metal: its own purity, net weight and fine weight (net
-- weight × fineness ÷ 1,000, to the milligram), from a piece just melted. Old
-- gold: each line's own purity, net and fine weight at its voucher's location,
-- in when the voucher is made and out when it is cancelled. Metal issued to a
-- karigar and brought back as scrap: its line's own purity and weights at its
-- challan's or receipt's location, made with it. Metal received from a
-- supplier or given to one: its entry's own, made with it. Metal sent to a
-- refiner or dealer: its challan line's own, made with it; and the refined
-- metal back: the challan's, when it comes back. Metal set aside into a
-- piece held in a customer's safekeeping: the piece's own, tagged now. What
-- goes out to a karigar, a supplier, a refiner or dealer, or into safekeeping
-- never takes more than the location holds of the purity, in grams or in fine
-- metal.
CREATE OR REPLACE FUNCTION jewellery_metal_movements_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE piece RECORD; line RECORD; held RECORD; challan RECORD;
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
  ELSIF NEW.source = 'safekeeping' THEN
    SELECT tag_no, status, metal, purity, net_weight, created_at INTO piece FROM jewellery_pieces WHERE business_id = NEW.business_id AND id = NEW.piece_id;
    IF piece.created_at <> now() OR NEW.metal <> piece.metal OR NEW.purity <> piece.purity OR NEW.net_weight <> -piece.net_weight
       OR NEW.fine_weight <> -round(piece.net_weight * jewellery_fineness(piece.metal, piece.purity) / 1000, 3) THEN
      RAISE EXCEPTION 'Metal set aside for safekeeping is the piece % tagged now, of its own purity and weight', piece.tag_no USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source IN ('old_gold', 'old_gold_cancelled') THEN
    SELECT l.metal, l.purity, l.net_weight, l.fine_weight, g.voucher_no, g.location_id, g.created_at, g.cancelled_at INTO line
    FROM jewellery_old_gold_lines l JOIN jewellery_old_gold g ON g.business_id = l.business_id AND g.id = l.old_gold_id
    WHERE l.business_id = NEW.business_id AND l.old_gold_id = NEW.old_gold_id AND l.seq = NEW.old_gold_seq;
    IF NEW.metal <> line.metal OR NEW.purity <> line.purity OR NEW.location_id <> line.location_id
       OR (NEW.source = 'old_gold' AND (line.created_at <> now() OR NEW.net_weight <> line.net_weight OR NEW.fine_weight <> line.fine_weight))
       OR (NEW.source = 'old_gold_cancelled' AND (line.cancelled_at IS DISTINCT FROM now() OR NEW.net_weight <> -line.net_weight OR NEW.fine_weight <> -line.fine_weight)) THEN
      RAISE EXCEPTION 'The metal of old gold voucher % is its own purity and weight, taken in when the voucher is made and going out when it is cancelled', line.voucher_no
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'karigar_issue' THEN
    SELECT l.kind, l.metal, l.purity, l.net_weight, l.fine_weight, i.issue_no, i.location_id, i.created_at INTO line
    FROM jewellery_karigar_issue_lines l JOIN jewellery_karigar_issues i ON i.business_id = l.business_id AND i.id = l.issue_id
    WHERE l.business_id = NEW.business_id AND l.issue_id = NEW.issue_id AND l.seq = NEW.issue_seq;
    IF line.kind IS DISTINCT FROM 'metal' OR NEW.metal <> line.metal OR NEW.purity <> line.purity OR NEW.location_id <> line.location_id OR line.created_at <> now()
       OR NEW.net_weight <> -line.net_weight OR NEW.fine_weight <> -line.fine_weight THEN
      RAISE EXCEPTION 'Metal goes to a karigar on its issue challan %, as the challan says', line.issue_no USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'karigar_return' THEN
    SELECT l.kind, l.metal, l.purity, l.net_weight, l.fine_weight, r.receipt_no, r.location_id, r.created_at INTO line
    FROM jewellery_karigar_receipt_lines l JOIN jewellery_karigar_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
    WHERE l.business_id = NEW.business_id AND l.receipt_id = NEW.receipt_id AND l.seq = NEW.receipt_seq;
    IF line.kind IS DISTINCT FROM 'metal' OR NEW.metal <> line.metal OR NEW.purity <> line.purity OR NEW.location_id <> line.location_id OR line.created_at <> now()
       OR NEW.net_weight <> line.net_weight OR NEW.fine_weight <> line.fine_weight THEN
      RAISE EXCEPTION 'Metal comes back from a karigar on their receipt %, as the receipt says', line.receipt_no USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source IN ('refinery_out', 'refinery_back') THEN
    SELECT challan_no, location_id, created_at, closed_at, outcome, back_metal, back_purity, back_net_weight, back_fine_weight INTO challan FROM jewellery_refinery_challans
    WHERE business_id = NEW.business_id AND id = NEW.refinery_id;
    IF NEW.source = 'refinery_out' THEN
      SELECT metal, purity, net_weight, fine_weight INTO line FROM jewellery_refinery_lines WHERE business_id = NEW.business_id AND challan_id = NEW.refinery_id AND seq = NEW.refinery_seq;
      IF challan.created_at <> now() OR NEW.location_id <> challan.location_id OR NEW.metal <> line.metal OR NEW.purity <> line.purity
         OR NEW.net_weight <> -line.net_weight OR NEW.fine_weight <> -line.fine_weight THEN
        RAISE EXCEPTION 'Metal goes to a refiner or dealer on its challan %, as the challan says', challan.challan_no USING ERRCODE = '23514';
      END IF;
    ELSIF challan.outcome IS DISTINCT FROM 'back' OR challan.closed_at <> now() OR NEW.location_id <> challan.location_id OR NEW.metal <> challan.back_metal
       OR NEW.purity <> challan.back_purity OR NEW.net_weight <> challan.back_net_weight OR NEW.fine_weight <> challan.back_fine_weight THEN
      RAISE EXCEPTION 'Refined metal comes back on its challan %, as the challan says', challan.challan_no USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT kind, metal, purity, net_weight, fine_weight, voucher_no, location_id, created_at INTO line FROM jewellery_supplier_metal
    WHERE business_id = NEW.business_id AND id = NEW.supplier_entry_id;
    IF line.kind IS DISTINCT FROM (CASE NEW.source WHEN 'supplier_in' THEN 'received' ELSE 'given' END) OR NEW.metal <> line.metal OR NEW.purity <> line.purity
       OR NEW.location_id <> line.location_id OR line.created_at <> now()
       OR abs(NEW.net_weight) <> line.net_weight OR abs(NEW.fine_weight) <> line.fine_weight THEN
      RAISE EXCEPTION 'Metal moves with a supplier on its metal voucher %, as the voucher says', line.voucher_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.source IN ('karigar_issue', 'supplier_out', 'refinery_out', 'safekeeping') THEN
    SELECT COALESCE(sum(net_weight), 0) AS net, COALESCE(sum(fine_weight), 0) AS fine INTO held FROM jewellery_metal_movements
    WHERE business_id = NEW.business_id AND location_id = NEW.location_id AND metal = NEW.metal AND purity = NEW.purity;
    IF held.net + NEW.net_weight < 0 OR held.fine + NEW.fine_weight < 0 THEN
      RAISE EXCEPTION 'The shop holds % g of % here (% g fine): no more goes out', held.net::NUMERIC(12,3), NEW.purity, held.fine::NUMERIC(12,3) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- --- The fine-weight book: refiners and safekeeping --------------------------------------------------------

ALTER TABLE jewellery_fine_ledger ADD COLUMN refinery_id BIGINT;
ALTER TABLE jewellery_fine_ledger
  ADD CONSTRAINT jewellery_fine_ledger_refinery FOREIGN KEY (business_id, refinery_id) REFERENCES jewellery_refinery_challans(business_id, id),
  DROP CONSTRAINT jewellery_fine_ledger_holder_check,
  ADD CONSTRAINT jewellery_fine_ledger_holder_check CHECK (holder IN ('stock', 'approval', 'karigar', 'centre', 'metal', 'karigar_metal', 'refinery', 'safekeeping')),
  DROP CONSTRAINT jewellery_fine_ledger_kind_check,
  ADD CONSTRAINT jewellery_fine_ledger_kind_check CHECK (kind IN ('opening', 'tagged', 'changed', 'moved', 'sold', 'returned', 'melted', 'split', 'merged', 'retagged',
    'melted_piece', 'old_gold', 'old_gold_cancelled', 'karigar_issue', 'karigar_return', 'supplier_in', 'supplier_out',
    'karigar_made', 'karigar_repair', 'wastage_allowed', 'wastage_written_off', 'refinery_out', 'refinery_back', 'refined_out', 'refinery_sold', 'safekeeping'));

-- Metal at a refiner or dealer: in with each line sent (out of the shop's
-- metal), out when the challan closes: as sent, against the refined metal
-- back, or sold.
CREATE FUNCTION jewellery_refinery_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'jewellery_refinery_lines' THEN
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, refinery_id)
    VALUES (NEW.business_id, NEW.metal, NEW.purity, 'refinery', NEW.net_weight, NEW.fine_weight, 'refinery_out', NEW.challan_id);
    RETURN NULL;
  END IF;
  IF OLD.outcome = 'out' AND NEW.outcome <> 'out' THEN
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, refinery_id)
    SELECT l.business_id, l.metal, l.purity, 'refinery', -l.net_weight, -l.fine_weight, CASE NEW.outcome WHEN 'back' THEN 'refined_out' ELSE 'refinery_sold' END, l.challan_id
    FROM jewellery_refinery_lines l WHERE l.business_id = NEW.business_id AND l.challan_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jewellery_refinery_lines_ledger AFTER INSERT ON jewellery_refinery_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_refinery_ledger();
CREATE TRIGGER jewellery_refinery_challans_ledger AFTER UPDATE ON jewellery_refinery_challans
  FOR EACH ROW EXECUTE FUNCTION jewellery_refinery_ledger();

-- --- Pieces: in safekeeping, collected, and taken back -----------------------------------------------------

-- A piece is tagged on a unit of its item in stock, and starts in stock. It
-- keeps its item and tag, and is never deleted. From stock it goes on approval
-- (on an approval challan), to a karigar (on an issue challan) or to the
-- hallmarking centre (on a consignment), and comes back into stock only on the
-- same (a return of the challan or a sale from it, a karigar's receipt, the
-- consignment's return); it is sold on a jewellery bill made in the same
-- transaction, or held in its buyer's safekeeping by the bill that closes a
-- gold scheme on its day 364, then collected; it comes back into stock from
-- sold or safekeeping only when its bill line is returned; it is melted,
-- split, merged or given a new tag once its unit has left stock, the last
-- three made with their link. A piece that has left the shop or is held for
-- its buyer keeps what it was. A piece with a HUID is hallmarked, and not
-- waiting to be re-hallmarked.
CREATE OR REPLACE FUNCTION jewellery_pieces_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gone TEXT[] := ARRAY['sold', 'melted', 'split', 'merged', 'retagged', 'safekeeping'];
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
  IF OLD.status = ANY (gone) AND (to_jsonb(NEW) - ARRAY['status', 'with_whom', 'updated_by', 'updated_at', 'net_weight'])
       <> (to_jsonb(OLD) - ARRAY['status', 'with_whom', 'updated_by', 'updated_at', 'net_weight']) THEN
    RAISE EXCEPTION 'Piece % was % and keeps what it was', OLD.tag_no, replace(OLD.status, 'safekeeping', 'in safekeeping') USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'in_stock' AND NEW.status IN ('on_approval', 'at_karigar', 'at_centre', 'melted', 'sold', 'split', 'merged', 'retagged', 'safekeeping'))
    OR (OLD.status IN ('on_approval', 'at_karigar', 'at_centre') AND NEW.status = 'in_stock')
    OR (OLD.status IN ('sold', 'safekeeping') AND NEW.status = 'in_stock')
    OR (OLD.status = 'safekeeping' AND NEW.status = 'sold')) THEN
    RAISE EXCEPTION 'Piece % cannot go from % to %', OLD.tag_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('sold', 'safekeeping') AND OLD.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM jewellery_bill_lines bl
       JOIN jewellery_bills b ON b.business_id = bl.business_id AND b.id = bl.bill_id
       WHERE bl.business_id = NEW.business_id AND bl.piece_id = NEW.id AND b.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % is sold on a jewellery bill', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'safekeeping' AND OLD.status <> 'safekeeping' AND NOT EXISTS (SELECT 1 FROM jewellery_scheme_closes
       WHERE business_id = NEW.business_id AND piece_id = NEW.id AND created_at = now()) THEN
    RAISE EXCEPTION 'Piece % is held in safekeeping only by the bill that closes a gold scheme on its day 364', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'safekeeping' AND NEW.status = 'sold' AND NOT EXISTS (SELECT 1 FROM jewellery_scheme_closes
       WHERE business_id = NEW.business_id AND piece_id = NEW.id AND collected_at = now()) THEN
    RAISE EXCEPTION 'Piece % in safekeeping goes to its buyer when they collect it', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('sold', 'safekeeping') AND NEW.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM business_return_lines rl
       JOIN business_returns r ON r.business_id = rl.business_id AND r.id = rl.return_id
       JOIN jewellery_bill_lines bl ON bl.business_id = rl.business_id AND bl.line_id = rl.line_id
       WHERE rl.business_id = NEW.business_id AND bl.piece_id = NEW.id AND r.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % comes back into stock only when its bill line is returned', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('melted', 'split', 'merged', 'retagged') AND OLD.status <> NEW.status AND EXISTS (SELECT 1 FROM business_stock_lots
       WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id AND lot_code = NEW.tag_no AND quantity > 0) THEN
    RAISE EXCEPTION 'Piece % is % once its unit has left stock', OLD.tag_no, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('split', 'merged', 'retagged') AND OLD.status <> NEW.status AND NOT EXISTS (SELECT 1 FROM jewellery_piece_links
       WHERE business_id = NEW.business_id AND from_piece_id = NEW.id AND created_at = now()
         AND kind = CASE NEW.status WHEN 'split' THEN 'split' WHEN 'merged' THEN 'merge' ELSE 'retag' END) THEN
    RAISE EXCEPTION 'Piece % is % into the pieces made from it', OLD.tag_no, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'on_approval' AND OLD.status <> 'on_approval' AND NOT EXISTS (SELECT 1 FROM jewellery_approval_lines l
       JOIN jewellery_approvals a ON a.business_id = l.business_id AND a.id = l.approval_id
       WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.id AND l.outcome = 'out' AND a.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % goes on approval on an approval challan', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'on_approval' AND NEW.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM jewellery_approval_lines
       WHERE business_id = NEW.business_id AND piece_id = NEW.id AND closed_at = now()) THEN
    RAISE EXCEPTION 'Piece % comes back from approval on its challan', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'at_karigar' AND OLD.status <> 'at_karigar' AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_issue_lines l
       JOIN jewellery_karigar_issues i ON i.business_id = l.business_id AND i.id = l.issue_id
       WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.id AND i.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % goes to a karigar on an issue challan', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'at_karigar' AND NEW.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_receipt_lines l
       JOIN jewellery_karigar_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
       WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.id AND l.kind = 'repaired' AND r.created_at = now()
         AND l.net_weight = NEW.gross_weight - NEW.stone_weight) THEN
    RAISE EXCEPTION 'Piece % comes back from the karigar on their receipt, weighed as the receipt says', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'at_centre' AND OLD.status <> 'at_centre' AND NOT EXISTS (SELECT 1 FROM jewellery_hallmark_lines l
       JOIN jewellery_hallmark_consignments c ON c.business_id = l.business_id AND c.id = l.consignment_id
       WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.id AND l.result = 'out' AND c.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % goes to the hallmarking centre on a consignment', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'at_centre' AND NEW.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM jewellery_hallmark_lines
       WHERE business_id = NEW.business_id AND piece_id = NEW.id AND returned_at = now()) THEN
    RAISE EXCEPTION 'Piece % comes back from the hallmarking centre with its consignment', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.hallmarked AND EXISTS (SELECT 1 FROM jewellery_piece_huids WHERE business_id = NEW.business_id AND piece_id = NEW.id) THEN
    RAISE EXCEPTION 'Piece % carries a HUID: it is hallmarked', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.old_hallmark AND EXISTS (SELECT 1 FROM jewellery_piece_huids WHERE business_id = NEW.business_id AND piece_id = NEW.id) THEN
    RAISE EXCEPTION 'Piece % carries a HUID: it is not waiting to be re-hallmarked', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A piece taken back on its bill's credit note comes back into stock (the
-- return puts its unit back), and its history says so and from where.
CREATE OR REPLACE FUNCTION jewellery_line_returned() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; credit RECORD; was TEXT;
BEGIN
  SELECT bl.piece_id INTO line FROM jewellery_bill_lines bl WHERE bl.business_id = NEW.business_id AND bl.line_id = NEW.line_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT return_no, created_by INTO credit FROM business_returns WHERE business_id = NEW.business_id AND id = NEW.return_id;
  SELECT status INTO was FROM jewellery_pieces WHERE business_id = NEW.business_id AND id = line.piece_id;
  UPDATE jewellery_pieces SET status = 'in_stock', updated_by = credit.created_by, updated_at = now() WHERE business_id = NEW.business_id AND id = line.piece_id;
  INSERT INTO jewellery_piece_events (business_id, piece_id, kind, from_status, to_status, note, created_by)
  VALUES (NEW.business_id, line.piece_id, 'returned', was, 'in_stock', 'Taken back on credit note ' || credit.return_no, credit.created_by);
  RETURN NULL;
END $$;

-- Down Migration
DROP TRIGGER jewellery_refinery_challans_ledger ON jewellery_refinery_challans;
DROP TRIGGER jewellery_refinery_lines_ledger ON jewellery_refinery_lines;
DROP FUNCTION jewellery_refinery_ledger();

-- The pieces' rules and a returned piece's history as they were.
CREATE OR REPLACE FUNCTION jewellery_line_returned() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION jewellery_pieces_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gone TEXT[] := ARRAY['sold', 'melted', 'split', 'merged', 'retagged'];
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
  IF OLD.status = ANY (gone) AND (to_jsonb(NEW) - ARRAY['status', 'with_whom', 'updated_by', 'updated_at', 'net_weight'])
       <> (to_jsonb(OLD) - ARRAY['status', 'with_whom', 'updated_by', 'updated_at', 'net_weight']) THEN
    RAISE EXCEPTION 'Piece % was % and keeps what it was', OLD.tag_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'in_stock' AND NEW.status IN ('on_approval', 'at_karigar', 'at_centre', 'melted', 'sold', 'split', 'merged', 'retagged'))
    OR (OLD.status IN ('on_approval', 'at_karigar', 'at_centre') AND NEW.status = 'in_stock')
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
  IF NEW.status IN ('melted', 'split', 'merged', 'retagged') AND OLD.status <> NEW.status AND EXISTS (SELECT 1 FROM business_stock_lots
       WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id AND lot_code = NEW.tag_no AND quantity > 0) THEN
    RAISE EXCEPTION 'Piece % is % once its unit has left stock', OLD.tag_no, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('split', 'merged', 'retagged') AND OLD.status <> NEW.status AND NOT EXISTS (SELECT 1 FROM jewellery_piece_links
       WHERE business_id = NEW.business_id AND from_piece_id = NEW.id AND created_at = now()
         AND kind = CASE NEW.status WHEN 'split' THEN 'split' WHEN 'merged' THEN 'merge' ELSE 'retag' END) THEN
    RAISE EXCEPTION 'Piece % is % into the pieces made from it', OLD.tag_no, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'on_approval' AND OLD.status <> 'on_approval' AND NOT EXISTS (SELECT 1 FROM jewellery_approval_lines l
       JOIN jewellery_approvals a ON a.business_id = l.business_id AND a.id = l.approval_id
       WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.id AND l.outcome = 'out' AND a.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % goes on approval on an approval challan', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'on_approval' AND NEW.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM jewellery_approval_lines
       WHERE business_id = NEW.business_id AND piece_id = NEW.id AND closed_at = now()) THEN
    RAISE EXCEPTION 'Piece % comes back from approval on its challan', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'at_karigar' AND OLD.status <> 'at_karigar' AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_issue_lines l
       JOIN jewellery_karigar_issues i ON i.business_id = l.business_id AND i.id = l.issue_id
       WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.id AND i.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % goes to a karigar on an issue challan', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'at_karigar' AND NEW.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_receipt_lines l
       JOIN jewellery_karigar_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
       WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.id AND l.kind = 'repaired' AND r.created_at = now()
         AND l.net_weight = NEW.gross_weight - NEW.stone_weight) THEN
    RAISE EXCEPTION 'Piece % comes back from the karigar on their receipt, weighed as the receipt says', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'at_centre' AND OLD.status <> 'at_centre' AND NOT EXISTS (SELECT 1 FROM jewellery_hallmark_lines l
       JOIN jewellery_hallmark_consignments c ON c.business_id = l.business_id AND c.id = l.consignment_id
       WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.id AND l.result = 'out' AND c.created_at = now()) THEN
    RAISE EXCEPTION 'Piece % goes to the hallmarking centre on a consignment', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'at_centre' AND NEW.status = 'in_stock' AND NOT EXISTS (SELECT 1 FROM jewellery_hallmark_lines
       WHERE business_id = NEW.business_id AND piece_id = NEW.id AND returned_at = now()) THEN
    RAISE EXCEPTION 'Piece % comes back from the hallmarking centre with its consignment', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.hallmarked AND EXISTS (SELECT 1 FROM jewellery_piece_huids WHERE business_id = NEW.business_id AND piece_id = NEW.id) THEN
    RAISE EXCEPTION 'Piece % carries a HUID: it is hallmarked', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.old_hallmark AND EXISTS (SELECT 1 FROM jewellery_piece_huids WHERE business_id = NEW.business_id AND piece_id = NEW.id) THEN
    RAISE EXCEPTION 'Piece % carries a HUID: it is not waiting to be re-hallmarked', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- The fine-weight book as it was.
ALTER TABLE jewellery_fine_ledger DROP CONSTRAINT jewellery_fine_ledger_kind_check,
  ADD CONSTRAINT jewellery_fine_ledger_kind_check CHECK (kind IN ('opening', 'tagged', 'changed', 'moved', 'sold', 'returned', 'melted', 'split', 'merged', 'retagged',
    'melted_piece', 'old_gold', 'old_gold_cancelled', 'karigar_issue', 'karigar_return', 'supplier_in', 'supplier_out',
    'karigar_made', 'karigar_repair', 'wastage_allowed', 'wastage_written_off'));
ALTER TABLE jewellery_fine_ledger DROP CONSTRAINT jewellery_fine_ledger_holder_check,
  ADD CONSTRAINT jewellery_fine_ledger_holder_check CHECK (holder IN ('stock', 'approval', 'karigar', 'centre', 'metal', 'karigar_metal'));
ALTER TABLE jewellery_fine_ledger DROP CONSTRAINT jewellery_fine_ledger_refinery, DROP COLUMN refinery_id;

-- The shop's metal as it was.
CREATE OR REPLACE FUNCTION jewellery_metal_movements_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE piece RECORD; line RECORD; held RECORD;
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
  ELSIF NEW.source IN ('old_gold', 'old_gold_cancelled') THEN
    SELECT l.metal, l.purity, l.net_weight, l.fine_weight, g.voucher_no, g.location_id, g.created_at, g.cancelled_at INTO line
    FROM jewellery_old_gold_lines l JOIN jewellery_old_gold g ON g.business_id = l.business_id AND g.id = l.old_gold_id
    WHERE l.business_id = NEW.business_id AND l.old_gold_id = NEW.old_gold_id AND l.seq = NEW.old_gold_seq;
    IF NEW.metal <> line.metal OR NEW.purity <> line.purity OR NEW.location_id <> line.location_id
       OR (NEW.source = 'old_gold' AND (line.created_at <> now() OR NEW.net_weight <> line.net_weight OR NEW.fine_weight <> line.fine_weight))
       OR (NEW.source = 'old_gold_cancelled' AND (line.cancelled_at IS DISTINCT FROM now() OR NEW.net_weight <> -line.net_weight OR NEW.fine_weight <> -line.fine_weight)) THEN
      RAISE EXCEPTION 'The metal of old gold voucher % is its own purity and weight, taken in when the voucher is made and going out when it is cancelled', line.voucher_no
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'karigar_issue' THEN
    SELECT l.kind, l.metal, l.purity, l.net_weight, l.fine_weight, i.issue_no, i.location_id, i.created_at INTO line
    FROM jewellery_karigar_issue_lines l JOIN jewellery_karigar_issues i ON i.business_id = l.business_id AND i.id = l.issue_id
    WHERE l.business_id = NEW.business_id AND l.issue_id = NEW.issue_id AND l.seq = NEW.issue_seq;
    IF line.kind IS DISTINCT FROM 'metal' OR NEW.metal <> line.metal OR NEW.purity <> line.purity OR NEW.location_id <> line.location_id OR line.created_at <> now()
       OR NEW.net_weight <> -line.net_weight OR NEW.fine_weight <> -line.fine_weight THEN
      RAISE EXCEPTION 'Metal goes to a karigar on its issue challan %, as the challan says', line.issue_no USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'karigar_return' THEN
    SELECT l.kind, l.metal, l.purity, l.net_weight, l.fine_weight, r.receipt_no, r.location_id, r.created_at INTO line
    FROM jewellery_karigar_receipt_lines l JOIN jewellery_karigar_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
    WHERE l.business_id = NEW.business_id AND l.receipt_id = NEW.receipt_id AND l.seq = NEW.receipt_seq;
    IF line.kind IS DISTINCT FROM 'metal' OR NEW.metal <> line.metal OR NEW.purity <> line.purity OR NEW.location_id <> line.location_id OR line.created_at <> now()
       OR NEW.net_weight <> line.net_weight OR NEW.fine_weight <> line.fine_weight THEN
      RAISE EXCEPTION 'Metal comes back from a karigar on their receipt %, as the receipt says', line.receipt_no USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT kind, metal, purity, net_weight, fine_weight, voucher_no, location_id, created_at INTO line FROM jewellery_supplier_metal
    WHERE business_id = NEW.business_id AND id = NEW.supplier_entry_id;
    IF line.kind IS DISTINCT FROM (CASE NEW.source WHEN 'supplier_in' THEN 'received' ELSE 'given' END) OR NEW.metal <> line.metal OR NEW.purity <> line.purity
       OR NEW.location_id <> line.location_id OR line.created_at <> now()
       OR abs(NEW.net_weight) <> line.net_weight OR abs(NEW.fine_weight) <> line.fine_weight THEN
      RAISE EXCEPTION 'Metal moves with a supplier on its metal voucher %, as the voucher says', line.voucher_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.source IN ('karigar_issue', 'supplier_out') THEN
    SELECT COALESCE(sum(net_weight), 0) AS net, COALESCE(sum(fine_weight), 0) AS fine INTO held FROM jewellery_metal_movements
    WHERE business_id = NEW.business_id AND location_id = NEW.location_id AND metal = NEW.metal AND purity = NEW.purity;
    IF held.net + NEW.net_weight < 0 OR held.fine + NEW.fine_weight < 0 THEN
      RAISE EXCEPTION 'The shop holds % g of % here (% g fine): no more goes out', held.net::NUMERIC(12,3), NEW.purity, held.fine::NUMERIC(12,3) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP INDEX jewellery_metal_movements_refinery_back, jewellery_metal_movements_refinery_line, jewellery_metal_movements_piece;
CREATE UNIQUE INDEX jewellery_metal_movements_piece ON jewellery_metal_movements(business_id, piece_id) WHERE piece_id IS NOT NULL;
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_refinery_refs;
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_direction,
  ADD CONSTRAINT jewellery_metal_movements_direction CHECK ((net_weight > 0) = (source IN ('melted_piece', 'old_gold', 'karigar_return', 'supplier_in')));
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_piece_ref,
  ADD CONSTRAINT jewellery_metal_movements_check1 CHECK ((source = 'melted_piece') = (piece_id IS NOT NULL));
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_source_check,
  ADD CONSTRAINT jewellery_metal_movements_source_check CHECK (source IN ('melted_piece', 'old_gold', 'old_gold_cancelled', 'karigar_issue', 'karigar_return',
    'supplier_in', 'supplier_out'));
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_refinery_line, DROP CONSTRAINT jewellery_metal_movements_refinery,
  DROP COLUMN refinery_seq, DROP COLUMN refinery_id;

-- The bill as it was.
CREATE OR REPLACE FUNCTION jewellery_bill_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill RECORD; line RECORD; piece RECORD; rate RECORD; marks TEXT[]; stones NUMERIC; expected TEXT; ord RECORD; taken NUMERIC;
BEGIN
  SELECT document_id, created_at, hallmark_mandatory, turnover_exempt, order_id INTO bill FROM jewellery_bills WHERE business_id = NEW.business_id AND id = NEW.bill_id;
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
  -- A piece made for an open custom order is billed only on the order's own bill.
  SELECT o.id, o.order_no INTO ord FROM jewellery_order_pieces op JOIN jewellery_orders o ON o.business_id = op.business_id AND o.id = op.order_id
  WHERE op.business_id = NEW.business_id AND op.piece_id = NEW.piece_id AND o.status NOT IN ('delivered', 'cancelled');
  IF FOUND AND ord.id IS DISTINCT FROM bill.order_id THEN
    RAISE EXCEPTION 'Piece % was made for custom order %: it is billed on the order''s own bill', piece.tag_no, ord.order_no USING ERRCODE = '23514';
  END IF;
  IF bill.order_id IS NOT NULL AND EXISTS (SELECT 1 FROM jewellery_order_pieces WHERE business_id = NEW.business_id AND order_id = bill.order_id AND piece_id = NEW.piece_id) THEN
    SELECT order_no, fixed_sheet_id, fixed_rate, fixed_weight INTO ord FROM jewellery_orders WHERE business_id = NEW.business_id AND id = bill.order_id;
    SELECT COALESCE(sum(fixed_weight), 0) INTO taken FROM jewellery_bill_lines WHERE business_id = NEW.business_id AND bill_id = NEW.bill_id;
    IF NEW.fixed_weight <> LEAST(piece.net_weight, GREATEST(COALESCE(ord.fixed_weight, 0) - taken, 0))
       OR (NEW.fixed_weight > 0 AND (NEW.fixed_rate <> ord.fixed_rate OR NEW.fixed_sheet_id <> ord.fixed_sheet_id)) THEN
      RAISE EXCEPTION 'Piece % of order % is priced at the rate fixed on the order for the grams fixed, and at the day''s rate for the rest', piece.tag_no, ord.order_no
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.fixed_weight <> 0 THEN
    RAISE EXCEPTION 'Piece % is priced at the day''s rate: only a custom order''s piece on its own bill takes the rate fixed on the order', piece.tag_no USING ERRCODE = '23514';
  END IF;
  expected := CASE WHEN marks <> '{}' THEN 'huid' WHEN piece.metal <> 'gold' THEN 'not_gold' WHEN piece.gross_weight < 2 THEN 'under_2g'
    WHEN piece.exemption IS NOT NULL THEN piece.exemption WHEN bill.turnover_exempt THEN 'turnover' WHEN NOT bill.hallmark_mandatory THEN 'district' END;
  IF expected IS NULL AND piece.old_hallmark THEN
    RAISE EXCEPTION 'Piece % (gold, % g) carries the old hallmark without a HUID: it is re-hallmarked before it is sold here', piece.tag_no, piece.gross_weight USING ERRCODE = '23514';
  END IF;
  IF expected IS NULL THEN
    RAISE EXCEPTION 'Piece % (gold, % g) needs its BIS hallmark with a HUID before it is sold here', piece.tag_no, piece.gross_weight USING ERRCODE = '23514';
  END IF;
  IF NEW.hallmark_basis <> expected THEN
    RAISE EXCEPTION 'Piece % goes through the HUID check as %', piece.tag_no, replace(expected, '_', ' ') USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION jewellery_bills_discount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE((SELECT sum(discount) FROM jewellery_bill_lines WHERE business_id = NEW.business_id AND bill_id = NEW.id), 0) <> NEW.scheme_discount THEN
    RAISE EXCEPTION 'A jewellery bill''s lines carry its gold scheme''s discount, ₹%, and no other', NEW.scheme_discount USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION jewellery_bills_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TABLE jewellery_bill_items;
DROP FUNCTION jewellery_bill_items_check();
ALTER TABLE jewellery_bill_lines DROP CONSTRAINT jewellery_bill_lines_discounts, DROP CONSTRAINT jewellery_bill_lines_offer,
  DROP COLUMN counter_discount, DROP COLUMN offer_discount, DROP COLUMN offer_id;
ALTER TABLE jewellery_bills DROP CONSTRAINT jewellery_bills_counter_discount,
  DROP COLUMN discount_on_metal, DROP COLUMN discount_reason, DROP COLUMN counter_discount, DROP COLUMN offer_discount;
DROP TABLE jewellery_offers;
DROP FUNCTION jewellery_offers_guard();

-- The suspicious transaction log, families and KYC go.
DROP TABLE jewellery_str_entries, jewellery_str_cases;
DROP FUNCTION jewellery_str_cases_guard();
DROP TABLE jewellery_cash_family_members, jewellery_cash_families;

-- The schemes' rules as they were.
CREATE OR REPLACE FUNCTION jewellery_schemes_redeemed() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION jewellery_schemes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['status', 'stop_reason', 'stopped_by', 'stop_approved_by', 'stopped_at', 'redeemed_document_id', 'redeemed_at', 'discount'];
  bill RECORD; paid INTEGER; today DATE; earned NUMERIC;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
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
DROP INDEX jewellery_bills_scheme;
ALTER TABLE jewellery_bills ADD CONSTRAINT jewellery_bills_business_id_scheme_id_key UNIQUE (business_id, scheme_id);
DROP TABLE jewellery_scheme_moves;
DROP FUNCTION jewellery_scheme_moves_check();
DROP FUNCTION jewellery_scheme_held(BIGINT, BIGINT);
DROP TABLE jewellery_scheme_closes;
DROP FUNCTION jewellery_scheme_closes_held();
DROP FUNCTION jewellery_scheme_closes_guard();
CREATE OR REPLACE FUNCTION jewellery_holder_of(status TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE status WHEN 'in_stock' THEN 'stock' WHEN 'on_approval' THEN 'approval' WHEN 'at_karigar' THEN 'karigar' WHEN 'at_centre' THEN 'centre' END;
$$;
ALTER TABLE jewellery_piece_events DROP CONSTRAINT jewellery_piece_events_kind_check,
  ADD CONSTRAINT jewellery_piece_events_kind_check CHECK (kind IN ('tagged', 'changed', 'sent', 'back', 'sold', 'returned', 'melted', 'split', 'merged', 'retagged'));
ALTER TABLE jewellery_pieces DROP CONSTRAINT jewellery_pieces_status_check,
  ADD CONSTRAINT jewellery_pieces_status_check CHECK (status IN ('in_stock', 'on_approval', 'at_karigar', 'at_centre', 'sold', 'melted', 'split', 'merged', 'retagged'));

-- Photos and copies as they were.
DROP INDEX jewellery_files_kyc, jewellery_files_old_gold;
ALTER TABLE jewellery_files DROP CONSTRAINT jewellery_files_pdf,
  DROP CONSTRAINT jewellery_files_mime_type_check,
  ADD CONSTRAINT jewellery_files_mime_type_check CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  DROP CONSTRAINT jewellery_files_stored_name_check,
  ADD CONSTRAINT jewellery_files_stored_name_check CHECK (stored_name ~ '^[a-f0-9]{32}\.(jpg|png|webp)$'),
  DROP CONSTRAINT jewellery_files_owner,
  ADD CONSTRAINT jewellery_files_check CHECK ((kind = 'photo') = (piece_id IS NOT NULL) AND (kind = 'design') = (order_id IS NOT NULL)),
  DROP CONSTRAINT jewellery_files_kind_check,
  ADD CONSTRAINT jewellery_files_kind_check CHECK (kind IN ('photo', 'design')),
  DROP CONSTRAINT jewellery_files_kyc, DROP CONSTRAINT jewellery_files_old_gold,
  DROP COLUMN kyc_id, DROP COLUMN old_gold_id;
DROP TABLE jewellery_kyc_owners, jewellery_kyc_documents;
DROP FUNCTION jewellery_kyc_guard();

-- Old gold as it was.
DROP TABLE jewellery_old_gold_next;
DROP FUNCTION jewellery_old_gold_next_check();
DROP TABLE jewellery_refinery_lines, jewellery_refinery_challans;
DROP FUNCTION jewellery_refinery_lines_check();
DROP FUNCTION jewellery_refinery_challans_guard();
CREATE OR REPLACE FUNCTION jewellery_old_gold_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER TABLE jewellery_old_gold_lines DROP CONSTRAINT jewellery_old_gold_lines_override, DROP CONSTRAINT jewellery_old_gold_lines_rule,
  DROP CONSTRAINT jewellery_old_gold_lines_own_piece,
  DROP COLUMN override_reason, DROP COLUMN override_by, DROP COLUMN rule_percent, DROP COLUMN deduction_rule, DROP COLUMN own_piece_id;
DROP TABLE jewellery_buyback_deductions;

-- Rate sessions as they were.
DROP TRIGGER jewellery_rate_sheets_session ON jewellery_rate_sheets;
DROP FUNCTION jewellery_rate_sheets_session();
ALTER TABLE jewellery_rate_sheets DROP CONSTRAINT jewellery_rate_sheets_session_name, DROP CONSTRAINT jewellery_rate_sheets_session_check,
  ADD CONSTRAINT jewellery_rate_sheets_session_check CHECK (session IN ('morning', 'evening')), DROP COLUMN session_name;

-- Settings as they were: the first alert level is the watch level again.
ALTER TABLE jewellery_settings ADD COLUMN cash_watch_level NUMERIC(12,2) CHECK (cash_watch_level > 0 AND cash_watch_level < 1000000);
UPDATE jewellery_settings SET cash_watch_level = cash_alert_levels[1] WHERE cardinality(cash_alert_levels) > 0;
ALTER TABLE jewellery_settings DROP CONSTRAINT jewellery_settings_net_worth, DROP CONSTRAINT jewellery_settings_cash_alert_levels,
  DROP CONSTRAINT jewellery_settings_kyc_kinds, DROP CONSTRAINT jewellery_settings_rate_sessions,
  DROP COLUMN net_worth_on, DROP COLUMN company_net_worth, DROP COLUMN discount_on_metal, DROP COLUMN kyc_kinds, DROP COLUMN cash_alert_levels,
  DROP COLUMN own_piece_deduction, DROP COLUMN rate_sessions;

DROP FUNCTION jewellery_money_kept();
DROP FUNCTION jewellery_names_ok(TEXT[], INTEGER, INTEGER);

DELETE FROM business_number_series WHERE document_kind = 'refinery_challan';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'refinery_challan');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

ALTER TABLE jewellery_account_items DROP CONSTRAINT jewellery_account_items_purpose_check,
  ADD CONSTRAINT jewellery_account_items_purpose_check CHECK (purpose IN ('labour', 'hallmarking', 'gold', 'silver', 'platinum'));

DELETE FROM business_role_permissions WHERE permission_code IN ('jewellery.manage', 'jewellery.review');
DELETE FROM business_role_template_permissions WHERE permission_code IN ('jewellery.manage', 'jewellery.review');
DELETE FROM business_permissions WHERE code IN ('jewellery.manage', 'jewellery.review');
