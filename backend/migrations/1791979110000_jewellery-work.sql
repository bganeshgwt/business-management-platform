-- Up Migration
-- A jeweller's work behind the counter (module "jewellery"): karigars
-- (goldsmiths) given metal, pieces and stones on numbered issue challans and
-- bringing back pieces, scrap and stones on receipts, with each karigar's
-- running account of metal by purity (the wastage the shop allows, and what
-- is left with them) and their labour billed as a purchase at its GST slab;
-- custom orders from booking to delivery, with advances in money or in old
-- gold held for the order's own bill and the rate fixed on an advance (bhav
-- cut); pieces lent on approval (jangad) on a numbered challan, taken back in
-- part or sold from it; consignments to an assaying and hallmarking centre
-- coming back with HUIDs and the centre's charges as a purchase, and old-mark
-- stock waiting to be re-hallmarked; tags split, merged and given a new
-- number, with a design code and a photo; the fine-weight book of every
-- purity with the counts held against it; and the metal account with
-- suppliers, in grams of each purity, fixed to money in full or in part
-- (bhav cut) as a purchase.
--
-- Gold rates & jewellery (module "jewellery"):
--   jewellery_account_items       the catalogue items the jeweller's own
--                                 purchases are booked under, made the first
--                                 time each is needed: karigar labour and
--                                 hallmarking charges (services bought), and
--                                 metal fixed on a supplier's metal account
--                                 (gold, silver, platinum: kept in grams in the
--                                 jeweller's own books, so its purchase takes
--                                 no stock). None of them is ever sold.
--   jewellery_karigars            a supplier the shop gives job work to, with
--                                 the wastage it allows them: a percentage of
--                                 the fine metal in the pieces they make.
--   jewellery_karigar_rates       a karigar's labour rate for a jewellery item,
--                                 per gram of net weight or per piece.
--   jewellery_karigar_issues      an issue challan (KI/2627/0001): what is
--                                 handed to a karigar, for a custom order or
--                                 the shop's own work, and when it is due back.
--   jewellery_karigar_issue_lines each thing handed over: metal out of the
--                                 shop's metal (its purity, weight, fineness
--                                 and fine weight, and its value), a piece to
--                                 repair or rework (at the karigar until it is
--                                 back), or stones.
--   jewellery_karigar_receipts    a receipt (KR/2627/0001): what a karigar
--                                 brought back, with their own challan number.
--   jewellery_karigar_receipt_lines each thing brought back: a piece made
--                                 (tagged on receipt, for a custom order or the
--                                 shop), a piece repaired (its weight as sent
--                                 and as back), scrap or metal (back into the
--                                 shop's metal), or stones; the labour on it,
--                                 and the wastage allowed on a piece made.
--   jewellery_karigar_writeoffs   metal left with a karigar after the work,
--                                 written off by a manager with the reason.
--   jewellery_karigar_invoices    a karigar's labour invoice, posted as a core
--                                 purchase: 5% GST on jewellery work and 1.5%
--                                 on diamond work from a karigar registered for
--                                 GST, none from one who is not.
--   jewellery_karigar_invoice_lines each receipt line's labour on an invoice,
--                                 billed once.
--   jewellery_orders              a custom order (CO/2627/0001): what to make,
--                                 its design, metal and purity, weight range,
--                                 size, stones and the day promised; where it
--                                 stands (booked, issued to a karigar,
--                                 received, at the hallmarking centre,
--                                 hallmarked, ready, delivered, cancelled); the
--                                 rate fixed on an advance; the bill it was
--                                 delivered on.
--   jewellery_order_pieces        the pieces made for an order.
--   jewellery_order_advances      an order's advances: core collection
--                                 receipts of the customer's money, or old gold
--                                 vouchers, held for the order's own bill while
--                                 it is open.
--   jewellery_approvals           an approval challan (AP/2627/0001): pieces
--                                 lent to a customer or another jeweller to
--                                 choose from, and the day they are due back.
--   jewellery_approval_returns    each taking back of pieces from a challan.
--   jewellery_approval_lines      each piece on a challan: out, back or sold.
--   jewellery_hallmark_consignments a consignment to an assaying and
--                                 hallmarking centre (HM/2627/0001), and its
--                                 return with the centre's bill.
--   jewellery_hallmark_lines      each piece sent: hallmarked with its HUIDs,
--                                 or rejected, and its charge.
--   jewellery_piece_links         a piece split into several, several merged
--                                 into one, or a piece given a new tag.
--   jewellery_files               a piece's photo and a custom order's design,
--                                 kept in the private uploads folder.
--   jewellery_supplier_metal      the metal account with a supplier: metal
--                                 received or given (MV/2627/0001) in grams of
--                                 a purity, and grams fixed to money (bhav cut)
--                                 on a purchase.
--   jewellery_fine_ledger         the fine-weight book: every change to the
--                                 metal of each purity the shop holds, by where
--                                 it is (pieces in stock, on approval, at a
--                                 karigar, at the centre; the shop's metal; metal
--                                 held by karigars), written by the database as
--                                 pieces and metal move.
--   jewellery_fine_counts         a count of a location's pieces and metal.
--   jewellery_fine_count_lines    each purity's book and what was counted.
-- A piece gains a design code, the old-hallmark mark (hallmarked before HUIDs:
-- re-hallmark required) and the statuses at the centre, split, merged and
-- retagged. It goes on approval, to a karigar or to the centre only on its
-- challan, and comes back only on it; a piece out is never written off by a
-- stock correction. A jewellery bill may deliver a custom order: its pieces
-- are priced at the rate fixed on the order for the grams fixed, the rest at
-- the day's rate, and the order's advances pay it first. The shop's metal
-- also goes out to karigars and suppliers and comes back, never below what a
-- location holds.

-- --- Number series -------------------------------------------------------------------------------

-- Issue challans (KI), receipts (KR), custom orders (CO), approval challans
-- (AP), hallmarking consignments (HM) and metal vouchers (MV) are numbered.
-- The kinds list is widened by reading the current one, so kinds other
-- migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := kinds || ARRAY(SELECT k FROM unnest(ARRAY['karigar_issue', 'karigar_receipt', 'custom_order', 'approval', 'hallmark_consignment', 'metal_voucher']) AS k
    WHERE NOT k = ANY (kinds));
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- --- Shared rules ---------------------------------------------------------------------------------

-- The fine (pure) metal in a weight of a purity: weight × fineness ÷ 1,000, to the milligram.
CREATE FUNCTION jewellery_fine_of(weight NUMERIC, metal TEXT, purity TEXT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT round(weight * jewellery_fineness(metal, purity) / 1000, 3);
$$;

-- Where a piece is, as the fine-weight book keeps it (none once it has left the shop).
CREATE FUNCTION jewellery_holder_of(status TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE status WHEN 'in_stock' THEN 'stock' WHEN 'on_approval' THEN 'approval' WHEN 'at_karigar' THEN 'karigar' WHEN 'at_centre' THEN 'centre' END;
$$;

-- What is written is kept as it was written.
CREATE FUNCTION jewellery_work_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME IN ('jewellery_karigar_issues', 'jewellery_karigar_issue_lines') THEN
    RAISE EXCEPTION 'An issue challan is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('jewellery_karigar_receipts', 'jewellery_karigar_receipt_lines') THEN
    RAISE EXCEPTION 'A karigar''s receipt is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('jewellery_karigar_invoices', 'jewellery_karigar_invoice_lines') THEN
    RAISE EXCEPTION 'A karigar''s labour invoice is kept as it was posted' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_karigar_writeoffs' THEN
    RAISE EXCEPTION 'Metal written off is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('jewellery_order_advances', 'jewellery_order_pieces') THEN
    RAISE EXCEPTION 'A custom order''s advances and pieces are kept as they were taken' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_approval_returns' THEN
    RAISE EXCEPTION 'Pieces taken back from approval are kept as they were taken back' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_piece_links' THEN
    RAISE EXCEPTION 'A split, a merge or a new tag is kept as it was made' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_supplier_metal' THEN
    RAISE EXCEPTION 'The metal account with a supplier is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_fine_ledger' THEN
    RAISE EXCEPTION 'The fine-weight book is kept as it was written' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME IN ('jewellery_fine_counts', 'jewellery_fine_count_lines') THEN
    RAISE EXCEPTION 'A count is kept as it was taken' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'jewellery_account_items' THEN
    RAISE EXCEPTION 'The items the jeweller''s own purchases are booked under stay as they are' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'This record is kept as it was written' USING ERRCODE = '23514';
END $$;

-- The catalogue items the jeweller's own purchases are booked under.
CREATE TABLE jewellery_account_items (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('labour', 'hallmarking', 'gold', 'silver', 'platinum')),
  sku_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, purpose),
  UNIQUE (business_id, sku_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id)
);
CREATE TRIGGER jewellery_account_items_append_only BEFORE UPDATE OR DELETE ON jewellery_account_items
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- --- Pieces: design codes, the old hallmark, and where else a piece can be -------------------------

ALTER TABLE jewellery_pieces
  -- The design the piece is made to, as the shop codes its designs.
  ADD COLUMN design_code VARCHAR(40),
  -- Hallmarked under the old marks, before HUIDs: it is re-hallmarked before it is sold where a HUID is needed.
  ADD COLUMN old_hallmark BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT jewellery_pieces_design_code CHECK (design_code ~ '^[A-Z0-9][A-Z0-9/ .-]{0,39}$'),
  ADD CONSTRAINT jewellery_pieces_old_hallmark CHECK (NOT old_hallmark OR hallmarked);
ALTER TABLE jewellery_pieces DROP CONSTRAINT jewellery_pieces_status_check,
  ADD CONSTRAINT jewellery_pieces_status_check CHECK (status IN ('in_stock', 'on_approval', 'at_karigar', 'at_centre', 'sold', 'melted', 'split', 'merged', 'retagged'));
ALTER TABLE jewellery_pieces DROP CONSTRAINT jewellery_pieces_check5,
  ADD CONSTRAINT jewellery_pieces_with_whom CHECK ((status IN ('on_approval', 'at_karigar', 'at_centre')) = (with_whom IS NOT NULL));
CREATE INDEX jewellery_pieces_design ON jewellery_pieces(business_id, design_code) WHERE design_code IS NOT NULL;

ALTER TABLE jewellery_piece_events DROP CONSTRAINT jewellery_piece_events_kind_check,
  ADD CONSTRAINT jewellery_piece_events_kind_check CHECK (kind IN ('tagged', 'changed', 'sent', 'back', 'sold', 'returned', 'melted', 'split', 'merged', 'retagged'));

-- --- Karigars ---------------------------------------------------------------------------------------

CREATE TABLE jewellery_karigars (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  -- The wastage the shop allows: a percentage of the fine metal in the pieces the karigar makes.
  wastage_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (wastage_percent BETWEEN 0 AND 25),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes VARCHAR(300) CHECK (btrim(notes) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id)
);
CREATE TRIGGER jewellery_karigars_supplier BEFORE INSERT ON jewellery_karigars
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_supplier();

CREATE FUNCTION jewellery_karigars_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A karigar is never deleted: switch them off instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A karigar keeps their contact' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_karigars_guard BEFORE UPDATE OR DELETE ON jewellery_karigars
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigars_guard();

-- A karigar's labour rate for a jewellery item: per gram of net weight or per piece.
CREATE TABLE jewellery_karigar_rates (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('per_gram', 'per_piece')),
  rate NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id, sku_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES jewellery_karigars(business_id, contact_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES jewellery_items(business_id, sku_id)
);

-- --- Custom orders -----------------------------------------------------------------------------------

CREATE TABLE jewellery_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  order_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- What to make: the jewellery item its pieces are tagged as, the words, the design (a catalogue reference or design code).
  sku_id BIGINT,
  description VARCHAR(300) NOT NULL CHECK (btrim(description) <> '' AND jewellery_plain_words(description)),
  design_ref VARCHAR(80) CHECK (btrim(design_ref) <> '' AND jewellery_plain_words(design_ref)),
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  -- The weight the customer wants it to come to, the size, the stones, and the day promised.
  weight_from NUMERIC(10,3) CHECK (weight_from > 0),
  weight_to NUMERIC(10,3) CHECK (weight_to > 0),
  size VARCHAR(40) CHECK (btrim(size) <> ''),
  stones VARCHAR(300) CHECK (btrim(stones) <> '' AND jewellery_plain_words(stones)),
  promised_on DATE,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'issued', 'received', 'at_centre', 'hallmarked', 'ready', 'delivered', 'cancelled')),
  -- The rate fixed on an advance (bhav cut): the sheet and rate per gram it was fixed at, and the grams the advance bought.
  fixed_sheet_id BIGINT,
  fixed_rate NUMERIC(12,2) CHECK (fixed_rate > 0),
  fixed_weight NUMERIC(10,3) CHECK (fixed_weight >= 0),
  fixed_at TIMESTAMPTZ,
  -- The jewellery bill's sale it was delivered on.
  document_id BIGINT,
  delivered_at TIMESTAMPTZ,
  cancel_reason VARCHAR(300) CHECK (btrim(cancel_reason) <> ''),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES jewellery_items(business_id, sku_id),
  FOREIGN KEY (business_id, fixed_sheet_id) REFERENCES jewellery_rate_sheets(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_no),
  UNIQUE (business_id, request_key),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (weight_from IS NULL OR weight_to IS NULL OR weight_from <= weight_to),
  CHECK ((fixed_sheet_id IS NULL) = (fixed_rate IS NULL) AND (fixed_rate IS NULL) = (fixed_weight IS NULL) AND (fixed_weight IS NULL) = (fixed_at IS NULL)),
  CHECK ((status = 'delivered') = (document_id IS NOT NULL) AND (document_id IS NULL) = (delivered_at IS NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (cancelled_at IS NULL) = (cancelled_by IS NULL) AND (cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX jewellery_orders_open ON jewellery_orders(business_id, promised_on) WHERE status NOT IN ('delivered', 'cancelled');
CREATE INDEX jewellery_orders_contact ON jewellery_orders(business_id, contact_id);
CREATE TRIGGER jewellery_orders_customer BEFORE INSERT ON jewellery_orders
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- The pieces made for an order (or a piece in the shop made its own).
CREATE TABLE jewellery_order_pieces (
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  piece_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, piece_id),
  FOREIGN KEY (business_id, order_id) REFERENCES jewellery_orders(business_id, id),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id)
);
CREATE INDEX jewellery_order_pieces_order ON jewellery_order_pieces(business_id, order_id);
CREATE TRIGGER jewellery_order_pieces_append_only BEFORE UPDATE OR DELETE ON jewellery_order_pieces
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- A piece joins an open order of its own metal and purity while it is in the shop.
CREATE FUNCTION jewellery_order_pieces_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ord RECORD; piece RECORD;
BEGIN
  SELECT order_no, status, metal, purity INTO ord FROM jewellery_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  SELECT tag_no, status, metal, purity INTO piece FROM jewellery_pieces WHERE business_id = NEW.business_id AND id = NEW.piece_id;
  IF ord.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Order % is %: no piece joins it', ord.order_no, ord.status USING ERRCODE = '23514';
  END IF;
  IF piece.metal <> ord.metal OR piece.purity <> ord.purity THEN
    RAISE EXCEPTION 'Piece % is not of order %''s metal and purity', piece.tag_no, ord.order_no USING ERRCODE = '23514';
  END IF;
  IF jewellery_holder_of(piece.status) IS NULL THEN
    RAISE EXCEPTION 'Piece % is % and joins no order', piece.tag_no, piece.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_order_pieces_check BEFORE INSERT ON jewellery_order_pieces
  FOR EACH ROW EXECUTE FUNCTION jewellery_order_pieces_check();

-- An order's advances: its customer's receipts of money, or their old gold, held for its bill.
CREATE TABLE jewellery_order_advances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  order_id BIGINT NOT NULL,
  collection_id BIGINT,
  old_gold_id BIGINT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  -- The order's rate was fixed on this advance (bhav cut).
  fixes_rate BOOLEAN NOT NULL DEFAULT FALSE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES jewellery_orders(business_id, id),
  FOREIGN KEY (business_id, collection_id) REFERENCES business_collections(business_id, id),
  FOREIGN KEY (business_id, old_gold_id) REFERENCES jewellery_old_gold(business_id, id),
  UNIQUE (business_id, collection_id),
  CHECK ((collection_id IS NULL) <> (old_gold_id IS NULL))
);
CREATE INDEX jewellery_order_advances_order ON jewellery_order_advances(business_id, order_id);
CREATE INDEX jewellery_order_advances_old_gold ON jewellery_order_advances(business_id, old_gold_id) WHERE old_gold_id IS NOT NULL;
CREATE TRIGGER jewellery_order_advances_append_only BEFORE UPDATE OR DELETE ON jewellery_order_advances
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- An advance is taken while the order is open: its customer's own receipt of
-- money made with it (not a credit note), or their own old gold voucher with
-- all the value left on it, held by no other open order; and the rate is fixed
-- on one advance only.
CREATE FUNCTION jewellery_order_advances_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ord RECORD; receipt RECORD; voucher RECORD;
BEGIN
  SELECT order_no, contact_id, status, fixed_at INTO ord FROM jewellery_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF ord.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Order % is % and takes no advance', ord.order_no, ord.status USING ERRCODE = '23514';
  END IF;
  IF NEW.fixes_rate AND ord.fixed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Order %''s rate is fixed already', ord.order_no USING ERRCODE = '23514';
  END IF;
  IF NEW.collection_id IS NOT NULL THEN
    SELECT contact_id, amount, method, created_at INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
    IF receipt.contact_id <> ord.contact_id OR receipt.amount <> NEW.amount OR receipt.method = 'credit_note' OR receipt.created_at <> now() THEN
      RAISE EXCEPTION 'Order %''s advance is its customer''s own receipt of money, made with it', ord.order_no USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT g.voucher_no, g.contact_id, g.cancelled_at, g.value
        - COALESCE((SELECT sum(u.amount) FROM jewellery_old_gold_uses u WHERE u.business_id = g.business_id AND u.old_gold_id = g.id), 0)
        - COALESCE((SELECT sum(p.amount) FROM jewellery_old_gold_payouts p WHERE p.business_id = g.business_id AND p.old_gold_id = g.id), 0) AS balance
      INTO voucher FROM jewellery_old_gold g WHERE g.business_id = NEW.business_id AND g.id = NEW.old_gold_id;
    IF voucher.contact_id <> ord.contact_id OR voucher.cancelled_at IS NOT NULL OR voucher.balance <> NEW.amount THEN
      RAISE EXCEPTION 'Order %''s advance in old gold is its customer''s own voucher, with all the value left on it', ord.order_no USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jewellery_order_advances a JOIN jewellery_orders o ON o.business_id = a.business_id AND o.id = a.order_id
         WHERE a.business_id = NEW.business_id AND a.old_gold_id = NEW.old_gold_id AND o.status NOT IN ('delivered', 'cancelled')) THEN
      RAISE EXCEPTION 'Old gold voucher % is held for an open custom order already', voucher.voucher_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_order_advances_check BEFORE INSERT ON jewellery_order_advances
  FOR EACH ROW EXECUTE FUNCTION jewellery_order_advances_check();

-- An order is booked now and never deleted, and keeps what was ordered. It
-- goes along its path: booked → issued to a karigar → received → at the
-- hallmarking centre → hallmarked → ready → delivered (received straight from
-- booked when a piece in the shop is made its own; ready without hallmarking;
-- back to a karigar or to the centre again before it is delivered). It is
-- delivered once, on a jewellery bill made with it, and cancelled once, now,
-- with the reason, while nothing of it is at the centre. Its rate is fixed
-- once, on an advance taken now, at the latest rate of the day for its purity,
-- for the grams the advance buys (to the milligram, rounded down).
CREATE FUNCTION jewellery_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['status', 'fixed_sheet_id', 'fixed_rate', 'fixed_weight', 'fixed_at', 'document_id', 'delivered_at', 'cancel_reason', 'cancelled_by',
    'cancelled_at', 'notes', 'promised_on', 'updated_by', 'updated_at'];
  rate RECORD; advance RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A custom order is never deleted: cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'booked' OR NEW.fixed_at IS NOT NULL OR NEW.created_at <> now() THEN
      RAISE EXCEPTION 'A custom order is booked now, with no rate fixed yet' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) THEN
    RAISE EXCEPTION 'Order % keeps what was ordered', OLD.order_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') AND (to_jsonb(NEW) - ARRAY['updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'Order % was % and keeps what it was', OLD.order_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'booked' AND NEW.status IN ('issued', 'received', 'cancelled'))
    OR (OLD.status = 'issued' AND NEW.status IN ('received', 'cancelled'))
    OR (OLD.status IN ('received', 'hallmarked') AND NEW.status IN ('issued', 'at_centre', 'ready', 'cancelled'))
    OR (OLD.status = 'at_centre' AND NEW.status = 'hallmarked')
    OR (OLD.status = 'ready' AND NEW.status IN ('issued', 'at_centre', 'delivered', 'cancelled'))) THEN
    RAISE EXCEPTION 'Order % cannot go from % to %', OLD.order_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'delivered' AND OLD.status <> 'delivered' AND (NEW.delivered_at <> now() OR NOT EXISTS (SELECT 1 FROM jewellery_bills b
       WHERE b.business_id = NEW.business_id AND b.order_id = NEW.id AND b.document_id = NEW.document_id AND b.created_at = now())) THEN
    RAISE EXCEPTION 'Order % is delivered on a jewellery bill made with it', OLD.order_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' AND NEW.cancelled_at <> now() THEN
    RAISE EXCEPTION 'Order % is cancelled when it is cancelled' , OLD.order_no USING ERRCODE = '23514';
  END IF;
  IF NEW.fixed_at IS DISTINCT FROM OLD.fixed_at OR NEW.fixed_rate IS DISTINCT FROM OLD.fixed_rate OR NEW.fixed_weight IS DISTINCT FROM OLD.fixed_weight
     OR NEW.fixed_sheet_id IS DISTINCT FROM OLD.fixed_sheet_id THEN
    IF OLD.fixed_at IS NOT NULL OR NEW.fixed_at <> now() THEN
      RAISE EXCEPTION 'Order %''s rate is fixed once, on an advance', OLD.order_no USING ERRCODE = '23514';
    END IF;
    SELECT * INTO rate FROM jewellery_current_rate(NEW.business_id, NEW.metal, NEW.purity);
    SELECT amount INTO advance FROM jewellery_order_advances WHERE business_id = NEW.business_id AND order_id = NEW.id AND fixes_rate AND created_at = now();
    IF NOT FOUND OR rate.sheet_id IS DISTINCT FROM NEW.fixed_sheet_id OR rate.sell_rate IS DISTINCT FROM NEW.fixed_rate
       OR NEW.fixed_weight <> trunc(advance.amount / NEW.fixed_rate, 3) THEN
      RAISE EXCEPTION 'Order %''s rate is fixed at the latest rate of the day for its purity, for the grams its advance buys', OLD.order_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_orders
  FOR EACH ROW EXECUTE FUNCTION jewellery_orders_guard();

-- An open order's receipts pay only its own bill (the core would otherwise let
-- a customer's receipts pay any bill of theirs), and are not handed back while
-- it is open.
CREATE FUNCTION jewellery_order_payment_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ord RECORD;
BEGIN
  SELECT o.id, o.order_no, o.status INTO ord FROM jewellery_order_advances a JOIN jewellery_orders o ON o.business_id = a.business_id AND o.id = a.order_id
  WHERE a.business_id = NEW.business_id AND a.collection_id = NEW.collection_id;
  IF NOT FOUND OR ord.status IN ('delivered', 'cancelled') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'business_payments' THEN
    IF EXISTS (SELECT 1 FROM jewellery_bills b WHERE b.business_id = NEW.business_id AND b.document_id = NEW.document_id AND b.order_id = ord.id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'This receipt is an advance for custom order %: it pays only the order''s own bill', ord.order_no USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'This receipt is an advance for custom order %: cancel the order before handing it back', ord.order_no USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_payments_jewellery_order BEFORE INSERT ON business_payments
  FOR EACH ROW WHEN (NEW.collection_id IS NOT NULL) EXECUTE FUNCTION jewellery_order_payment_check();
CREATE TRIGGER business_collection_refunds_jewellery_order BEFORE INSERT ON business_collection_refunds
  FOR EACH ROW EXECUTE FUNCTION jewellery_order_payment_check();

-- Old gold held for an open order is not paid out, used on another bill or cancelled.
CREATE FUNCTION jewellery_order_old_gold_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voucher BIGINT; ord RECORD; voucher_no TEXT;
BEGIN
  IF TG_TABLE_NAME = 'jewellery_old_gold' THEN
    IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL THEN
      RETURN NEW;
    END IF;
    voucher := NEW.id;
  ELSE
    voucher := NEW.old_gold_id;
  END IF;
  SELECT o.id, o.order_no INTO ord FROM jewellery_order_advances a JOIN jewellery_orders o ON o.business_id = a.business_id AND o.id = a.order_id
  WHERE a.business_id = NEW.business_id AND a.old_gold_id = voucher AND o.status NOT IN ('delivered', 'cancelled');
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'jewellery_old_gold_uses' THEN
    IF NEW.amount < 0 OR EXISTS (SELECT 1 FROM jewellery_bills b WHERE b.business_id = NEW.business_id AND b.document_id = NEW.document_id AND b.order_id = ord.id) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT g.voucher_no INTO voucher_no FROM jewellery_old_gold g WHERE g.business_id = NEW.business_id AND g.id = voucher;
  RAISE EXCEPTION 'Old gold voucher % is held for custom order %: it pays only the order''s bill', voucher_no, ord.order_no USING ERRCODE = '23514';
END $$;
CREATE TRIGGER jewellery_old_gold_order BEFORE UPDATE ON jewellery_old_gold
  FOR EACH ROW EXECUTE FUNCTION jewellery_order_old_gold_check();
CREATE TRIGGER jewellery_old_gold_payouts_order BEFORE INSERT ON jewellery_old_gold_payouts
  FOR EACH ROW EXECUTE FUNCTION jewellery_order_old_gold_check();
CREATE TRIGGER jewellery_old_gold_uses_order BEFORE INSERT ON jewellery_old_gold_uses
  FOR EACH ROW EXECUTE FUNCTION jewellery_order_old_gold_check();

-- --- Karigar work: issue challans and receipts ----------------------------------------------------------

CREATE TABLE jewellery_karigar_issues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  issue_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- The custom order it is for (none: the shop's own work).
  order_id BIGINT,
  due_on DATE,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES jewellery_karigars(business_id, contact_id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES jewellery_orders(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, issue_no),
  UNIQUE (business_id, request_key)
);
CREATE INDEX jewellery_karigar_issues_karigar ON jewellery_karigar_issues(business_id, contact_id, created_at DESC);
CREATE INDEX jewellery_karigar_issues_order ON jewellery_karigar_issues(business_id, order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER jewellery_karigar_issues_append_only BEFORE UPDATE OR DELETE ON jewellery_karigar_issues
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- Each thing handed over: metal (its purity, weight and the fineness it is
-- taken at, and so its fine weight; out of the shop's metal), a piece to
-- repair or rework (its weights as sent), or stones (how many, their carats);
-- with what the goods are worth, for the ITC-04 statement.
CREATE TABLE jewellery_karigar_issue_lines (
  business_id BIGINT NOT NULL,
  issue_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 50),
  kind TEXT NOT NULL CHECK (kind IN ('metal', 'piece', 'stone')),
  description VARCHAR(150) CHECK (btrim(description) <> '' AND jewellery_plain_words(description)),
  metal TEXT CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT,
  net_weight NUMERIC(10,3) CHECK (net_weight > 0),
  fineness NUMERIC(4,1) CHECK (fineness > 0 AND fineness < 1000),
  fine_weight NUMERIC(10,3),
  piece_id BIGINT,
  gross_weight NUMERIC(10,3) CHECK (gross_weight > 0),
  pieces INTEGER CHECK (pieces BETWEEN 1 AND 100000),
  carat NUMERIC(10,3) CHECK (carat > 0),
  value NUMERIC(14,2) CHECK (value >= 0),
  PRIMARY KEY (business_id, issue_id, seq),
  FOREIGN KEY (business_id, issue_id) REFERENCES jewellery_karigar_issues(business_id, id),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  CHECK (metal IS NULL OR jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (kind <> 'metal' OR (metal IS NOT NULL AND net_weight IS NOT NULL AND fineness IS NOT NULL AND piece_id IS NULL AND gross_weight IS NULL)),
  CHECK (kind <> 'piece' OR (piece_id IS NOT NULL AND metal IS NOT NULL AND net_weight IS NOT NULL AND gross_weight IS NOT NULL AND fineness IS NOT NULL)),
  CHECK (kind <> 'stone' OR (description IS NOT NULL AND metal IS NULL AND piece_id IS NULL AND net_weight IS NULL)),
  CHECK ((fine_weight IS NULL) = (fineness IS NULL) AND (fineness IS NULL OR fine_weight = round(net_weight * fineness / 1000, 3)))
);
CREATE INDEX jewellery_karigar_issue_lines_piece ON jewellery_karigar_issue_lines(business_id, piece_id) WHERE piece_id IS NOT NULL;
CREATE TRIGGER jewellery_karigar_issue_lines_append_only BEFORE UPDATE OR DELETE ON jewellery_karigar_issue_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

CREATE TABLE jewellery_karigar_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  receipt_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- The issue challan it answers (none: the karigar's running account).
  issue_id BIGINT,
  -- The karigar's own challan or bill number for what they brought.
  karigar_ref VARCHAR(60) CHECK (btrim(karigar_ref) <> ''),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES jewellery_karigars(business_id, contact_id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, issue_id) REFERENCES jewellery_karigar_issues(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, receipt_no),
  UNIQUE (business_id, request_key)
);
CREATE INDEX jewellery_karigar_receipts_karigar ON jewellery_karigar_receipts(business_id, contact_id, created_at DESC);
CREATE TRIGGER jewellery_karigar_receipts_append_only BEFORE UPDATE OR DELETE ON jewellery_karigar_receipts
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- A receipt answers an issue challan of the same karigar.
CREATE FUNCTION jewellery_karigar_receipts_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.issue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jewellery_karigar_issues WHERE business_id = NEW.business_id AND id = NEW.issue_id AND contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'A receipt answers an issue challan of the same karigar' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_karigar_receipts_check BEFORE INSERT ON jewellery_karigar_receipts
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_receipts_check();

-- Each thing brought back: a piece made (tagged on this receipt), a piece
-- repaired (its net and fine weight as sent and as back), scrap or metal (into
-- the shop's metal), or stones; the labour on it (per gram of net weight or per
-- piece; diamond work at its own slab); and the wastage allowed on a piece
-- made (the karigar's percentage of its weight and fine weight).
CREATE TABLE jewellery_karigar_receipt_lines (
  business_id BIGINT NOT NULL,
  receipt_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 50),
  kind TEXT NOT NULL CHECK (kind IN ('made', 'repaired', 'metal', 'stone')),
  description VARCHAR(150) CHECK (btrim(description) <> '' AND jewellery_plain_words(description)),
  metal TEXT CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT,
  net_weight NUMERIC(10,3) CHECK (net_weight > 0),
  fineness NUMERIC(4,1) CHECK (fineness > 0 AND fineness < 1000),
  fine_weight NUMERIC(10,3),
  piece_id BIGINT,
  order_id BIGINT,
  before_net_weight NUMERIC(10,3) CHECK (before_net_weight > 0),
  before_fine_weight NUMERIC(10,3),
  pieces INTEGER CHECK (pieces BETWEEN 1 AND 100000),
  carat NUMERIC(10,3) CHECK (carat > 0),
  labour_basis TEXT CHECK (labour_basis IN ('per_gram', 'per_piece')),
  labour_rate NUMERIC(12,2) CHECK (labour_rate >= 0),
  labour NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (labour >= 0),
  work TEXT NOT NULL DEFAULT 'jewellery' CHECK (work IN ('jewellery', 'diamond')),
  wastage_weight NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (wastage_weight >= 0),
  wastage_fine NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (wastage_fine >= 0),
  PRIMARY KEY (business_id, receipt_id, seq),
  FOREIGN KEY (business_id, receipt_id) REFERENCES jewellery_karigar_receipts(business_id, id),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES jewellery_orders(business_id, id),
  CHECK (metal IS NULL OR jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (kind NOT IN ('made', 'repaired') OR (piece_id IS NOT NULL AND metal IS NOT NULL AND net_weight IS NOT NULL AND fineness IS NOT NULL)),
  CHECK ((kind = 'repaired') = (before_net_weight IS NOT NULL AND before_fine_weight IS NOT NULL)),
  CHECK (kind <> 'metal' OR (metal IS NOT NULL AND net_weight IS NOT NULL AND fineness IS NOT NULL AND piece_id IS NULL)),
  CHECK (kind <> 'stone' OR (description IS NOT NULL AND metal IS NULL AND piece_id IS NULL AND net_weight IS NULL)),
  CHECK (kind = 'made' OR order_id IS NULL),
  CHECK ((fine_weight IS NULL) = (fineness IS NULL) AND (fineness IS NULL OR fine_weight = round(net_weight * fineness / 1000, 3))),
  CHECK ((labour_basis IS NULL) = (labour_rate IS NULL)),
  CHECK (labour_basis IS NOT NULL OR labour = 0),
  CHECK (labour_basis IS NULL OR labour = CASE labour_basis WHEN 'per_gram' THEN round(net_weight * labour_rate, 2) ELSE labour_rate END),
  CHECK (kind IN ('made', 'repaired') OR labour_basis IS NULL),
  CHECK (kind = 'made' OR (wastage_weight = 0 AND wastage_fine = 0))
);
CREATE INDEX jewellery_karigar_receipt_lines_piece ON jewellery_karigar_receipt_lines(business_id, piece_id) WHERE piece_id IS NOT NULL;
CREATE INDEX jewellery_karigar_receipt_lines_order ON jewellery_karigar_receipt_lines(business_id, order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER jewellery_karigar_receipt_lines_append_only BEFORE UPDATE OR DELETE ON jewellery_karigar_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- A line goes on its receipt when the receipt is made. A piece made is the
-- piece tagged now, in stock at the receipt's location, with the line's own
-- weights and purity; its allowed wastage is the karigar's percentage of its
-- weight and fine weight (to the milligram). A piece repaired is one at this
-- karigar, sent on their issue challan, coming back with its weight as it was
-- sent and as it is now.
CREATE FUNCTION jewellery_karigar_receipt_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt RECORD; piece RECORD; allowed NUMERIC; sent RECORD;
BEGIN
  SELECT r.receipt_no, r.location_id, r.contact_id, r.created_at, k.wastage_percent INTO receipt FROM jewellery_karigar_receipts r
    JOIN jewellery_karigars k ON k.business_id = r.business_id AND k.contact_id = r.contact_id
  WHERE r.business_id = NEW.business_id AND r.id = NEW.receipt_id;
  IF receipt.created_at <> now() THEN
    RAISE EXCEPTION 'A line goes on a karigar''s receipt when the receipt is made' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'made' THEN
    SELECT p.tag_no, p.metal, p.purity, p.net_weight, p.status, p.created_at, l.location_id INTO piece FROM jewellery_pieces p
      LEFT JOIN business_stock_lots l ON l.business_id = p.business_id AND l.sku_id = p.sku_id AND l.lot_code = p.tag_no AND l.quantity > 0
    WHERE p.business_id = NEW.business_id AND p.id = NEW.piece_id;
    IF piece.created_at <> now() OR piece.status <> 'in_stock' OR piece.location_id IS DISTINCT FROM receipt.location_id OR piece.metal <> NEW.metal
       OR piece.purity <> NEW.purity OR piece.net_weight <> NEW.net_weight OR NEW.fineness <> jewellery_fineness(NEW.metal, NEW.purity) THEN
      RAISE EXCEPTION 'A piece made comes in on the receipt, tagged with its own weight and purity, at the receipt''s location' USING ERRCODE = '23514';
    END IF;
    allowed := receipt.wastage_percent;
    IF NEW.wastage_weight <> round(NEW.net_weight * allowed / 100, 3) OR NEW.wastage_fine <> round(NEW.fine_weight * allowed / 100, 3) THEN
      RAISE EXCEPTION 'The wastage allowed on piece % is the karigar''s % of its weight', piece.tag_no, allowed || '%' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind = 'repaired' THEN
    SELECT p.tag_no, p.status, p.metal, p.purity INTO piece FROM jewellery_pieces p WHERE p.business_id = NEW.business_id AND p.id = NEW.piece_id;
    SELECT l.net_weight, l.fine_weight INTO sent FROM jewellery_karigar_issue_lines l JOIN jewellery_karigar_issues i ON i.business_id = l.business_id AND i.id = l.issue_id
    WHERE l.business_id = NEW.business_id AND l.piece_id = NEW.piece_id AND i.contact_id = receipt.contact_id ORDER BY i.created_at DESC, i.id DESC LIMIT 1;
    IF piece.status <> 'at_karigar' OR NOT FOUND OR NEW.before_net_weight <> sent.net_weight OR NEW.before_fine_weight <> sent.fine_weight
       OR NEW.metal <> piece.metal OR NEW.purity <> piece.purity OR NEW.fineness <> jewellery_fineness(NEW.metal, NEW.purity) THEN
      RAISE EXCEPTION 'Piece % comes back from the karigar it was sent to, with its weight as it was sent', piece.tag_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_karigar_receipt_lines_check BEFORE INSERT ON jewellery_karigar_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_receipt_lines_check();

-- An issue line goes on its challan when the challan is made; a piece goes
-- from stock at the challan's location, with its own weights.
CREATE FUNCTION jewellery_karigar_issue_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issue RECORD; piece RECORD;
BEGIN
  SELECT issue_no, location_id, created_at INTO issue FROM jewellery_karigar_issues WHERE business_id = NEW.business_id AND id = NEW.issue_id;
  IF issue.created_at <> now() THEN
    RAISE EXCEPTION 'A line goes on an issue challan when the challan is made' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'piece' THEN
    SELECT p.tag_no, p.status, p.metal, p.purity, p.gross_weight, p.net_weight, l.location_id INTO piece FROM jewellery_pieces p
      LEFT JOIN business_stock_lots l ON l.business_id = p.business_id AND l.sku_id = p.sku_id AND l.lot_code = p.tag_no AND l.quantity > 0
    WHERE p.business_id = NEW.business_id AND p.id = NEW.piece_id;
    IF piece.status <> 'in_stock' OR piece.location_id IS DISTINCT FROM issue.location_id OR NEW.metal <> piece.metal OR NEW.purity <> piece.purity
       OR NEW.gross_weight <> piece.gross_weight OR NEW.net_weight <> piece.net_weight OR NEW.fineness <> jewellery_fineness(piece.metal, piece.purity) THEN
      RAISE EXCEPTION 'Piece % goes to the karigar from stock at the challan''s location, with its own weights', piece.tag_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_karigar_issue_lines_check BEFORE INSERT ON jewellery_karigar_issue_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_issue_lines_check();

-- Metal left with a karigar after the work, written off by a manager.
CREATE TABLE jewellery_karigar_writeoffs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  net_weight NUMERIC(12,3) NOT NULL,
  fine_weight NUMERIC(12,3) NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  approved_by BIGINT NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES jewellery_karigars(business_id, contact_id),
  UNIQUE (business_id, request_key),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (net_weight <> 0 OR fine_weight <> 0)
);
CREATE TRIGGER jewellery_karigar_writeoffs_append_only BEFORE UPDATE OR DELETE ON jewellery_karigar_writeoffs
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- A karigar's labour invoice: a core purchase from them, made with it.
CREATE TABLE jewellery_karigar_invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  -- GST charged: the karigar was registered (had a GSTIN) when the invoice was posted.
  registered BOOLEAN NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES jewellery_karigars(business_id, contact_id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, request_key)
);
CREATE TRIGGER jewellery_karigar_invoices_append_only BEFORE UPDATE OR DELETE ON jewellery_karigar_invoices
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

CREATE FUNCTION jewellery_karigar_invoices_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc RECORD;
BEGIN
  SELECT kind, contact_id, created_at INTO doc FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'purchase' OR doc.contact_id <> NEW.contact_id OR doc.created_at <> now() THEN
    RAISE EXCEPTION 'A karigar''s labour invoice is a purchase from them, posted with it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_karigar_invoices_check BEFORE INSERT ON jewellery_karigar_invoices
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_invoices_check();

-- Each receipt line's labour on an invoice (billed once), on a line of the
-- invoice's purchase at its slab: 1.5% on diamond work and 5% on other work
-- from a registered karigar, nil from one who is not.
CREATE TABLE jewellery_karigar_invoice_lines (
  business_id BIGINT NOT NULL,
  invoice_id BIGINT NOT NULL,
  receipt_id BIGINT NOT NULL,
  receipt_seq SMALLINT NOT NULL,
  line_id BIGINT NOT NULL,
  labour NUMERIC(14,2) NOT NULL CHECK (labour > 0),
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate IN (0, 1.5, 5)),
  tax NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (business_id, receipt_id, receipt_seq),
  FOREIGN KEY (business_id, invoice_id) REFERENCES jewellery_karigar_invoices(business_id, id),
  FOREIGN KEY (business_id, receipt_id, receipt_seq) REFERENCES jewellery_karigar_receipt_lines(business_id, receipt_id, seq),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, line_id),
  CHECK (tax = round(labour * tax_rate / 100, 2))
);
CREATE INDEX jewellery_karigar_invoice_lines_invoice ON jewellery_karigar_invoice_lines(business_id, invoice_id);
CREATE TRIGGER jewellery_karigar_invoice_lines_append_only BEFORE UPDATE OR DELETE ON jewellery_karigar_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

CREATE FUNCTION jewellery_karigar_invoice_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invoice RECORD; work RECORD; line RECORD;
BEGIN
  SELECT contact_id, document_id, registered, created_at INTO invoice FROM jewellery_karigar_invoices WHERE business_id = NEW.business_id AND id = NEW.invoice_id;
  SELECT l.labour, l.work, r.contact_id INTO work FROM jewellery_karigar_receipt_lines l
    JOIN jewellery_karigar_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
  WHERE l.business_id = NEW.business_id AND l.receipt_id = NEW.receipt_id AND l.seq = NEW.receipt_seq;
  SELECT document_id, net, tax, tax_rate INTO line FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.line_id;
  IF invoice.created_at <> now() OR work.contact_id <> invoice.contact_id OR work.labour <> NEW.labour
     OR NEW.tax_rate <> (CASE WHEN NOT invoice.registered THEN 0 WHEN work.work = 'diamond' THEN 1.5 ELSE 5 END)
     OR line.document_id <> invoice.document_id OR line.net <> NEW.labour OR line.tax <> NEW.tax OR line.tax_rate <> NEW.tax_rate THEN
    RAISE EXCEPTION 'A karigar''s labour is billed once, on their own invoice''s purchase, at its slab' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_karigar_invoice_lines_check BEFORE INSERT ON jewellery_karigar_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_invoice_lines_check();

-- --- Approval (jangad) challans --------------------------------------------------------------------

CREATE TABLE jewellery_approvals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  approval_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  -- A customer choosing at home, or another jeweller choosing for its counter.
  party TEXT NOT NULL CHECK (party IN ('customer', 'jeweller')),
  due_on DATE NOT NULL,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, approval_no),
  UNIQUE (business_id, request_key)
);
CREATE INDEX jewellery_approvals_contact ON jewellery_approvals(business_id, contact_id);
CREATE TRIGGER jewellery_approvals_customer BEFORE INSERT ON jewellery_approvals
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();
CREATE TRIGGER jewellery_approvals_append_only BEFORE UPDATE OR DELETE ON jewellery_approvals
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- A challan is written now, due back on or after the business's date.
CREATE FUNCTION jewellery_approvals_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_at <> now() OR NEW.due_on < (now() AT TIME ZONE (SELECT timezone FROM businesses WHERE id = NEW.business_id))::date THEN
    RAISE EXCEPTION 'An approval challan is written now, due back today or later' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_approvals_check BEFORE INSERT ON jewellery_approvals
  FOR EACH ROW EXECUTE FUNCTION jewellery_approvals_check();

CREATE TABLE jewellery_approval_returns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  approval_id BIGINT NOT NULL,
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, approval_id) REFERENCES jewellery_approvals(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE TRIGGER jewellery_approval_returns_append_only BEFORE UPDATE OR DELETE ON jewellery_approval_returns
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- Each piece on a challan, with its weights as it went out; out until it is
-- taken back (on a return) or sold from the challan (on a jewellery bill).
CREATE TABLE jewellery_approval_lines (
  business_id BIGINT NOT NULL,
  approval_id BIGINT NOT NULL,
  piece_id BIGINT NOT NULL,
  gross_weight NUMERIC(10,3) NOT NULL,
  net_weight NUMERIC(10,3) NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'out' CHECK (outcome IN ('out', 'returned', 'sold')),
  return_id BIGINT,
  document_id BIGINT,
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  PRIMARY KEY (business_id, approval_id, piece_id),
  FOREIGN KEY (business_id, approval_id) REFERENCES jewellery_approvals(business_id, id),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  FOREIGN KEY (business_id, return_id) REFERENCES jewellery_approval_returns(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  CHECK ((outcome = 'out') = (closed_at IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL)),
  CHECK ((outcome = 'returned') = (return_id IS NOT NULL)),
  CHECK (outcome = 'sold' OR document_id IS NULL)
);
CREATE INDEX jewellery_approval_lines_piece ON jewellery_approval_lines(business_id, piece_id);
CREATE UNIQUE INDEX jewellery_approval_lines_out ON jewellery_approval_lines(business_id, piece_id) WHERE outcome = 'out';

-- A piece goes on a challan when it is written, from stock at its location,
-- with its own weights. A line is closed once: taken back on a return of its
-- challan made now, or sold now and then named with the sale it was sold on
-- (checked when the transaction ends). A line is never deleted.
CREATE FUNCTION jewellery_approval_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval RECORD; piece RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A piece''s line on an approval challan is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT location_id, created_at INTO approval FROM jewellery_approvals WHERE business_id = NEW.business_id AND id = NEW.approval_id;
    SELECT p.tag_no, p.status, p.gross_weight, p.net_weight, l.location_id INTO piece FROM jewellery_pieces p
      LEFT JOIN business_stock_lots l ON l.business_id = p.business_id AND l.sku_id = p.sku_id AND l.lot_code = p.tag_no AND l.quantity > 0
    WHERE p.business_id = NEW.business_id AND p.id = NEW.piece_id;
    IF approval.created_at <> now() OR NEW.outcome <> 'out' OR piece.status <> 'in_stock' OR piece.location_id IS DISTINCT FROM approval.location_id
       OR NEW.gross_weight <> piece.gross_weight OR NEW.net_weight <> piece.net_weight THEN
      RAISE EXCEPTION 'Piece % goes on approval from stock at the challan''s location, when the challan is written', piece.tag_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.approval_id <> OLD.approval_id OR NEW.piece_id <> OLD.piece_id OR NEW.gross_weight <> OLD.gross_weight OR NEW.net_weight <> OLD.net_weight THEN
    RAISE EXCEPTION 'A piece''s line on an approval challan keeps what went out' USING ERRCODE = '23514';
  END IF;
  IF OLD.outcome = 'out' AND NEW.outcome = 'returned' THEN
    IF NEW.closed_at <> now() OR NEW.document_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM jewellery_approval_returns r
         WHERE r.business_id = NEW.business_id AND r.id = NEW.return_id AND r.approval_id = NEW.approval_id AND r.created_at = now()) THEN
      RAISE EXCEPTION 'A piece comes back from approval on a return of its own challan' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.outcome = 'out' AND NEW.outcome = 'sold' THEN
    IF NEW.closed_at <> now() OR NEW.return_id IS NOT NULL THEN
      RAISE EXCEPTION 'A piece on approval is sold from its challan now' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.outcome = 'sold' AND NEW.outcome = 'sold' AND OLD.document_id IS NULL AND NEW.document_id IS NOT NULL AND OLD.closed_at = now()
     AND (to_jsonb(NEW) - 'document_id') = (to_jsonb(OLD) - 'document_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A piece''s line on an approval challan is closed once, and keeps how' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER jewellery_approval_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_approval_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_approval_lines_guard();

-- A piece sold from a challan is named with the sale it was sold on, a jewellery bill's line of it.
CREATE FUNCTION jewellery_approval_lines_sold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD;
BEGIN
  SELECT outcome, document_id INTO line FROM jewellery_approval_lines WHERE business_id = NEW.business_id AND approval_id = NEW.approval_id AND piece_id = NEW.piece_id;
  IF line.outcome = 'sold' AND (line.document_id IS NULL OR NOT EXISTS (SELECT 1 FROM jewellery_bill_lines bl JOIN jewellery_bills b ON b.business_id = bl.business_id AND b.id = bl.bill_id
       WHERE bl.business_id = NEW.business_id AND bl.piece_id = NEW.piece_id AND b.document_id = line.document_id)) THEN
    RAISE EXCEPTION 'A piece sold from approval is sold on a jewellery bill, named on its challan' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jewellery_approval_lines_sold AFTER UPDATE ON jewellery_approval_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.outcome = 'sold') EXECUTE FUNCTION jewellery_approval_lines_sold();

-- --- Hallmarking consignments -------------------------------------------------------------------

CREATE TABLE jewellery_hallmark_consignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  consignment_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  -- The assaying and hallmarking centre: a supplier of the shop.
  contact_id BIGINT NOT NULL,
  -- The centre's own number for the request (BIS's request form HM/JWLR/F 1.3).
  request_ref VARCHAR(60) CHECK (btrim(request_ref) <> ''),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Back from the centre: when, by whom, the centre's bill, and its charges as a purchase.
  returned_at TIMESTAMPTZ,
  returned_by BIGINT REFERENCES users(id),
  return_key UUID,
  return_hash CHAR(64),
  centre_bill_no VARCHAR(60) CHECK (btrim(centre_bill_no) <> ''),
  document_id BIGINT,
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, consignment_no),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, return_key),
  CHECK ((returned_at IS NULL) = (returned_by IS NULL) AND (returned_at IS NULL) = (return_key IS NULL) AND (return_key IS NULL) = (return_hash IS NULL)),
  CHECK (returned_at IS NOT NULL OR (centre_bill_no IS NULL AND document_id IS NULL))
);
CREATE INDEX jewellery_hallmark_consignments_open ON jewellery_hallmark_consignments(business_id, created_at) WHERE returned_at IS NULL;
CREATE TRIGGER jewellery_hallmark_consignments_supplier BEFORE INSERT ON jewellery_hallmark_consignments
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_supplier();

-- A consignment is sent now and never deleted; it keeps what was sent, and
-- comes back once, now, with the centre's charges posted with it.
CREATE FUNCTION jewellery_hallmark_consignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kept TEXT[] := ARRAY['returned_at', 'returned_by', 'return_key', 'return_hash', 'centre_bill_no', 'document_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A hallmarking consignment is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at <> now() OR NEW.returned_at IS NOT NULL THEN
      RAISE EXCEPTION 'A hallmarking consignment is sent now' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - kept) <> (to_jsonb(OLD) - kept) OR OLD.returned_at IS NOT NULL OR NEW.returned_at <> now() THEN
    RAISE EXCEPTION 'Consignment % keeps what was sent, and comes back once', OLD.consignment_no USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id
       AND d.kind = 'purchase' AND d.contact_id = NEW.contact_id AND d.created_at = now()) THEN
    RAISE EXCEPTION 'Consignment %''s charges are a purchase from its centre, posted with its return', OLD.consignment_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_hallmark_consignments_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_hallmark_consignments
  FOR EACH ROW EXECUTE FUNCTION jewellery_hallmark_consignments_guard();

-- Each piece sent: its purity and weights as sent; back hallmarked with its HUIDs, or rejected, with the centre's charge for it.
CREATE TABLE jewellery_hallmark_lines (
  business_id BIGINT NOT NULL,
  consignment_id BIGINT NOT NULL,
  piece_id BIGINT NOT NULL,
  metal TEXT NOT NULL,
  purity TEXT NOT NULL,
  gross_weight NUMERIC(10,3) NOT NULL,
  net_weight NUMERIC(10,3) NOT NULL,
  result TEXT NOT NULL DEFAULT 'out' CHECK (result IN ('out', 'hallmarked', 'rejected')),
  huids TEXT[] NOT NULL DEFAULT '{}',
  charge NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (charge >= 0 AND charge <= 10000),
  returned_at TIMESTAMPTZ,
  PRIMARY KEY (business_id, consignment_id, piece_id),
  FOREIGN KEY (business_id, consignment_id) REFERENCES jewellery_hallmark_consignments(business_id, id),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  CHECK ((result = 'out') = (returned_at IS NULL)),
  CHECK ((result = 'hallmarked') = (cardinality(huids) > 0)),
  CHECK (result <> 'out' OR charge = 0)
);
CREATE INDEX jewellery_hallmark_lines_piece ON jewellery_hallmark_lines(business_id, piece_id);

-- A piece is sent when its consignment is, from stock at its location, gold
-- or silver, with its own purity and weights. It comes back once, with its
-- consignment's return, hallmarked (each HUID 6 letters and digits) or
-- rejected. A line is never deleted.
CREATE FUNCTION jewellery_hallmark_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sent RECORD; piece RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A piece''s line on a hallmarking consignment is never deleted' USING ERRCODE = '23514';
  END IF;
  SELECT location_id, created_at, returned_at INTO sent FROM jewellery_hallmark_consignments WHERE business_id = NEW.business_id AND id = NEW.consignment_id;
  IF TG_OP = 'INSERT' THEN
    SELECT p.tag_no, p.status, p.metal, p.purity, p.gross_weight, p.net_weight, l.location_id INTO piece FROM jewellery_pieces p
      LEFT JOIN business_stock_lots l ON l.business_id = p.business_id AND l.sku_id = p.sku_id AND l.lot_code = p.tag_no AND l.quantity > 0
    WHERE p.business_id = NEW.business_id AND p.id = NEW.piece_id;
    IF sent.created_at <> now() OR NEW.result <> 'out' OR piece.status <> 'in_stock' OR piece.location_id IS DISTINCT FROM sent.location_id
       OR piece.metal NOT IN ('gold', 'silver') OR NEW.metal <> piece.metal OR NEW.purity <> piece.purity OR NEW.gross_weight <> piece.gross_weight
       OR NEW.net_weight <> piece.net_weight THEN
      RAISE EXCEPTION 'Piece % goes to the hallmarking centre from stock at the consignment''s location, gold or silver, when the consignment is sent', piece.tag_no
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['result', 'huids', 'charge', 'returned_at']) <> (to_jsonb(OLD) - ARRAY['result', 'huids', 'charge', 'returned_at'])
     OR OLD.result <> 'out' OR NEW.result = 'out' OR NEW.returned_at <> now() OR sent.returned_at IS DISTINCT FROM now()
     OR EXISTS (SELECT 1 FROM unnest(NEW.huids) h WHERE h !~ '^[A-Z0-9]{6}$') THEN
    RAISE EXCEPTION 'A piece comes back from the hallmarking centre once, with its consignment, hallmarked with its HUIDs or rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_hallmark_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON jewellery_hallmark_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_hallmark_lines_guard();

-- --- Splitting, merging and new tags -----------------------------------------------------------------

CREATE TABLE jewellery_piece_links (
  business_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('split', 'merge', 'retag')),
  from_piece_id BIGINT NOT NULL,
  to_piece_id BIGINT NOT NULL,
  request_key UUID NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, from_piece_id, to_piece_id),
  FOREIGN KEY (business_id, from_piece_id) REFERENCES jewellery_pieces(business_id, id),
  FOREIGN KEY (business_id, to_piece_id) REFERENCES jewellery_pieces(business_id, id),
  CHECK (from_piece_id <> to_piece_id)
);
CREATE INDEX jewellery_piece_links_to ON jewellery_piece_links(business_id, to_piece_id);
CREATE INDEX jewellery_piece_links_request ON jewellery_piece_links(business_id, request_key);
CREATE TRIGGER jewellery_piece_links_append_only BEFORE UPDATE OR DELETE ON jewellery_piece_links
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- A split, merge or new tag is made now, from pieces in stock to pieces
-- tagged now; and it keeps the metal: the pieces it makes are of one metal
-- and purity with those it takes, and come to the same gross weight, the same
-- stone weight and the same cost in stock (checked when the transaction ends).
CREATE FUNCTION jewellery_piece_links_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before RECORD; after RECORD;
BEGIN
  IF TG_OP = 'INSERT' AND TG_WHEN = 'BEFORE' THEN
    IF NEW.created_at <> now() OR NOT EXISTS (SELECT 1 FROM jewellery_pieces WHERE business_id = NEW.business_id AND id = NEW.to_piece_id AND created_at = now()) THEN
      RAISE EXCEPTION 'A split, a merge or a new tag makes pieces tagged now' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- (A unit moved between locations has a lot at each: its cost is the same on both, so the latest is taken.)
  SELECT count(DISTINCT p.metal || ':' || p.purity) AS purities, min(p.metal || ':' || p.purity) AS purity, sum(p.gross_weight) AS gross, sum(p.stone_weight) AS stones,
      sum(COALESCE((SELECT l.unit_cost FROM business_stock_lots l WHERE l.business_id = p.business_id AND l.sku_id = p.sku_id AND l.lot_code = p.tag_no
        ORDER BY l.id DESC LIMIT 1), 0)) AS cost INTO before
    FROM (SELECT DISTINCT from_piece_id AS id FROM jewellery_piece_links WHERE business_id = NEW.business_id AND request_key = NEW.request_key) k
    JOIN jewellery_pieces p ON p.business_id = NEW.business_id AND p.id = k.id;
  SELECT count(DISTINCT p.metal || ':' || p.purity) AS purities, min(p.metal || ':' || p.purity) AS purity, sum(p.gross_weight) AS gross, sum(p.stone_weight) AS stones,
      sum(COALESCE((SELECT l.unit_cost FROM business_stock_lots l WHERE l.business_id = p.business_id AND l.sku_id = p.sku_id AND l.lot_code = p.tag_no
        ORDER BY l.id DESC LIMIT 1), 0)) AS cost INTO after
    FROM (SELECT DISTINCT to_piece_id AS id FROM jewellery_piece_links WHERE business_id = NEW.business_id AND request_key = NEW.request_key) k
    JOIN jewellery_pieces p ON p.business_id = NEW.business_id AND p.id = k.id;
  IF before.purities <> 1 OR after.purities <> 1 OR before.purity <> after.purity OR before.gross <> after.gross OR before.stones <> after.stones OR before.cost <> after.cost THEN
    RAISE EXCEPTION 'A split, a merge or a new tag keeps the metal: one purity, the same gross and stone weight, and the same cost' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jewellery_piece_links_check BEFORE INSERT ON jewellery_piece_links
  FOR EACH ROW EXECUTE FUNCTION jewellery_piece_links_check();
CREATE CONSTRAINT TRIGGER jewellery_piece_links_kept AFTER INSERT ON jewellery_piece_links DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jewellery_piece_links_check();

-- --- Photos and designs ----------------------------------------------------------------------------

-- A piece's photo, or a custom order's design, in jewellery/<business>/ of the
-- private uploads folder (PRIVATE_UPLOADS_DIR), under a generated name. A file
-- is taken off (removed_at), never deleted.
CREATE TABLE jewellery_files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'design')),
  piece_id BIGINT,
  order_id BIGINT,
  stored_name VARCHAR(80) NOT NULL CHECK (stored_name ~ '^[a-f0-9]{32}\.(jpg|png|webp)$'),
  file_name VARCHAR(150) NOT NULL,
  mime_type VARCHAR(40) NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  uploaded_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by BIGINT REFERENCES users(id),
  removed_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES jewellery_orders(business_id, id),
  UNIQUE (business_id, id),
  CHECK ((kind = 'photo') = (piece_id IS NOT NULL) AND (kind = 'design') = (order_id IS NOT NULL)),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX jewellery_files_piece ON jewellery_files(business_id, piece_id) WHERE piece_id IS NOT NULL;
CREATE INDEX jewellery_files_order ON jewellery_files(business_id, order_id) WHERE order_id IS NOT NULL;

CREATE FUNCTION jewellery_files_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A photo is never deleted: take it off instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR (to_jsonb(NEW) - ARRAY['removed_at', 'removed_by']) <> (to_jsonb(OLD) - ARRAY['removed_at', 'removed_by']) THEN
    RAISE EXCEPTION 'A photo is kept as it was added: it is only taken off, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_files_guard BEFORE UPDATE OR DELETE ON jewellery_files
  FOR EACH ROW EXECUTE FUNCTION jewellery_files_guard();

-- --- The metal account with suppliers ----------------------------------------------------------------

-- Metal received from a supplier or given to them (a metal voucher,
-- MV/2627/0001), in grams of a purity at its fineness, and grams fixed to
-- money at a rate per gram (bhav cut) on a purchase from them.
CREATE TABLE jewellery_supplier_metal (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  voucher_no VARCHAR(50),
  series_id BIGINT,
  contact_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('received', 'given', 'fixed')),
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  net_weight NUMERIC(12,3) NOT NULL CHECK (net_weight > 0),
  fine_weight NUMERIC(12,3) NOT NULL,
  rate NUMERIC(12,2) CHECK (rate > 0),
  amount NUMERIC(14,2) CHECK (amount > 0),
  document_id BIGINT,
  description VARCHAR(150) CHECK (btrim(description) <> '' AND jewellery_plain_words(description)),
  notes VARCHAR(300),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, voucher_no),
  UNIQUE (business_id, request_key),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK (fine_weight = jewellery_fine_of(net_weight, metal, purity)),
  CHECK ((kind = 'fixed') = (rate IS NOT NULL) AND (rate IS NULL) = (amount IS NULL) AND (amount IS NULL) = (document_id IS NULL)),
  CHECK ((kind = 'fixed') = (voucher_no IS NULL)),
  CHECK (amount IS NULL OR amount = round(net_weight * rate, 2))
);
CREATE INDEX jewellery_supplier_metal_account ON jewellery_supplier_metal(business_id, contact_id, metal, purity);
CREATE TRIGGER jewellery_supplier_metal_supplier BEFORE INSERT ON jewellery_supplier_metal
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_supplier();
CREATE TRIGGER jewellery_supplier_metal_append_only BEFORE UPDATE OR DELETE ON jewellery_supplier_metal
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- An entry is written now. Grams are fixed only as far as the shop owes the
-- supplier that purity (full or partial bhav cut), on a purchase from them
-- posted with it.
CREATE FUNCTION jewellery_supplier_metal_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owed NUMERIC; supplier TEXT;
BEGIN
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'An entry on the metal account is written now' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'fixed' THEN
    SELECT COALESCE(sum(CASE WHEN kind = 'received' THEN net_weight ELSE -net_weight END), 0) INTO owed FROM jewellery_supplier_metal
    WHERE business_id = NEW.business_id AND contact_id = NEW.contact_id AND metal = NEW.metal AND purity = NEW.purity;
    IF NEW.net_weight > owed THEN
      SELECT name INTO supplier FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.contact_id;
      RAISE EXCEPTION 'The shop owes % only % g of %: no more is fixed', supplier, GREATEST(owed, 0)::NUMERIC(12,3), NEW.purity USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id AND d.kind = 'purchase'
         AND d.contact_id = NEW.contact_id AND d.created_at = now()) THEN
      RAISE EXCEPTION 'Metal fixed to money is a purchase from the supplier, posted with it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_supplier_metal_check BEFORE INSERT ON jewellery_supplier_metal
  FOR EACH ROW EXECUTE FUNCTION jewellery_supplier_metal_check();

-- --- The shop's metal: out to karigars and suppliers, and back -----------------------------------------

ALTER TABLE jewellery_metal_movements
  ADD COLUMN issue_id BIGINT,
  ADD COLUMN issue_seq SMALLINT,
  ADD COLUMN receipt_id BIGINT,
  ADD COLUMN receipt_seq SMALLINT,
  ADD COLUMN supplier_entry_id BIGINT,
  ADD CONSTRAINT jewellery_metal_movements_issue FOREIGN KEY (business_id, issue_id, issue_seq) REFERENCES jewellery_karigar_issue_lines(business_id, issue_id, seq),
  ADD CONSTRAINT jewellery_metal_movements_receipt FOREIGN KEY (business_id, receipt_id, receipt_seq) REFERENCES jewellery_karigar_receipt_lines(business_id, receipt_id, seq),
  ADD CONSTRAINT jewellery_metal_movements_supplier FOREIGN KEY (business_id, supplier_entry_id) REFERENCES jewellery_supplier_metal(business_id, id);
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_source_check,
  ADD CONSTRAINT jewellery_metal_movements_source_check CHECK (source IN ('melted_piece', 'old_gold', 'old_gold_cancelled', 'karigar_issue', 'karigar_return',
    'supplier_in', 'supplier_out'));
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_check3,
  ADD CONSTRAINT jewellery_metal_movements_direction CHECK ((net_weight > 0) = (source IN ('melted_piece', 'old_gold', 'karigar_return', 'supplier_in')));
ALTER TABLE jewellery_metal_movements
  ADD CONSTRAINT jewellery_metal_movements_refs CHECK ((source = 'karigar_issue') = (issue_id IS NOT NULL AND issue_seq IS NOT NULL)
    AND (source = 'karigar_return') = (receipt_id IS NOT NULL AND receipt_seq IS NOT NULL)
    AND (source IN ('supplier_in', 'supplier_out')) = (supplier_entry_id IS NOT NULL));
CREATE UNIQUE INDEX jewellery_metal_movements_issue_line ON jewellery_metal_movements(business_id, issue_id, issue_seq) WHERE issue_id IS NOT NULL;
CREATE UNIQUE INDEX jewellery_metal_movements_receipt_line ON jewellery_metal_movements(business_id, receipt_id, receipt_seq) WHERE receipt_id IS NOT NULL;
CREATE UNIQUE INDEX jewellery_metal_movements_supplier_entry ON jewellery_metal_movements(business_id, supplier_entry_id) WHERE supplier_entry_id IS NOT NULL;

-- A melted piece's metal: its own purity, net weight and fine weight (net
-- weight × fineness ÷ 1,000, to the milligram), from a piece just melted. Old
-- gold: each line's own purity, net and fine weight at its voucher's location,
-- in when the voucher is made and out when it is cancelled. Metal issued to a
-- karigar and brought back as scrap: its line's own purity and weights at its
-- challan's or receipt's location, made with it. Metal received from a
-- supplier or given to one: its entry's own, made with it. What goes out to a
-- karigar or a supplier never takes more than the location holds of the
-- purity, in grams or in fine metal.
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

-- --- Pieces: where they may go, and how they come back ----------------------------------------------

-- A piece is tagged on a unit of its item in stock, and starts in stock. It
-- keeps its item and tag, and is never deleted. From stock it goes on approval
-- (on an approval challan), to a karigar (on an issue challan) or to the
-- hallmarking centre (on a consignment), and comes back into stock only on the
-- same (a return of the challan or a sale from it, a karigar's receipt, the
-- consignment's return); it is sold on a jewellery bill made in the same
-- transaction, and comes back into stock from sold only when its bill line is
-- returned; it is melted, split, merged or given a new tag once its unit has
-- left stock, the last three made with their link. A piece that has left the
-- shop keeps what it was. A piece with a HUID is hallmarked, and not waiting
-- to be re-hallmarked.
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

-- A piece's HUIDs and stones change only while it is in the shop (at the
-- centre too); a HUID goes on a hallmarked piece not waiting to be
-- re-hallmarked, and is never changed (taken off and given again).
CREATE OR REPLACE FUNCTION jewellery_piece_parts_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE piece RECORD; row_business BIGINT; row_piece BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN row_business := OLD.business_id; row_piece := OLD.piece_id;
  ELSE row_business := NEW.business_id; row_piece := NEW.piece_id; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'jewellery_piece_huids' THEN
    RAISE EXCEPTION 'A HUID is never changed: take it off the piece and give the right one' USING ERRCODE = '23514';
  END IF;
  SELECT tag_no, status, hallmarked, old_hallmark INTO piece FROM jewellery_pieces WHERE business_id = row_business AND id = row_piece;
  IF piece.status NOT IN ('in_stock', 'on_approval', 'at_karigar', 'at_centre') THEN
    RAISE EXCEPTION 'Piece % was % and keeps what it was', piece.tag_no, piece.status USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'jewellery_piece_huids' AND TG_OP = 'INSERT' AND (NOT piece.hallmarked OR piece.old_hallmark) THEN
    RAISE EXCEPTION 'Piece % is not hallmarked with a HUID: a HUID goes on a hallmarked piece, not one waiting to be re-hallmarked', piece.tag_no USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- A piece out of the shop (on approval, at a karigar, at the hallmarking
-- centre) is not on the shelf: a stock correction never takes its unit out,
-- and a stock transfer never moves it.
CREATE FUNCTION jewellery_piece_out_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE piece RECORD; lot BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'business_stock_transfer_lines' THEN
    lot := NEW.source_lot_id;
  ELSE
    lot := NEW.lot_id;
  END IF;
  SELECT p.tag_no, p.status INTO piece FROM business_stock_lots l JOIN jewellery_pieces p ON p.business_id = l.business_id AND p.sku_id = l.sku_id AND p.tag_no = l.lot_code
  WHERE l.business_id = NEW.business_id AND l.id = lot;
  IF FOUND AND piece.status IN ('on_approval', 'at_karigar', 'at_centre') THEN
    RAISE EXCEPTION 'Piece % is % and is not on the shelf: its unit stays where it is until it is back', piece.tag_no,
      (CASE piece.status WHEN 'on_approval' THEN 'on approval' WHEN 'at_karigar' THEN 'at the karigar' ELSE 'at the hallmarking centre' END) USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_stock_adjustments_jewellery BEFORE INSERT ON business_stock_adjustments
  FOR EACH ROW WHEN (NEW.quantity < 0) EXECUTE FUNCTION jewellery_piece_out_check();
CREATE TRIGGER business_stock_transfer_lines_jewellery BEFORE INSERT ON business_stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_piece_out_check();

-- --- The jewellery bill: delivering a custom order -------------------------------------------------

ALTER TABLE jewellery_bills ADD COLUMN order_id BIGINT,
  ADD CONSTRAINT jewellery_bills_order_fk FOREIGN KEY (business_id, order_id) REFERENCES jewellery_orders(business_id, id),
  ADD CONSTRAINT jewellery_bills_order_once UNIQUE (business_id, order_id);

-- A bill that delivers an order is its customer's, delivers it, and sells every
-- piece made for it that is still the shop's (checked when the transaction ends).
CREATE FUNCTION jewellery_bills_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ord RECORD;
BEGIN
  SELECT order_no, contact_id, status, document_id INTO ord FROM jewellery_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF ord.contact_id IS DISTINCT FROM NEW.contact_id OR ord.status <> 'delivered' OR ord.document_id <> NEW.document_id
     OR EXISTS (SELECT 1 FROM jewellery_order_pieces op JOIN jewellery_pieces p ON p.business_id = op.business_id AND p.id = op.piece_id
       WHERE op.business_id = NEW.business_id AND op.order_id = NEW.order_id AND p.status NOT IN ('melted', 'split', 'merged', 'retagged')
         AND NOT EXISTS (SELECT 1 FROM jewellery_bill_lines bl WHERE bl.business_id = NEW.business_id AND bl.bill_id = NEW.id AND bl.piece_id = op.piece_id)) THEN
    RAISE EXCEPTION 'Order % is delivered on its bill, to its customer, with every piece made for it', ord.order_no USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jewellery_bills_order AFTER INSERT ON jewellery_bills DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.order_id IS NOT NULL) EXECUTE FUNCTION jewellery_bills_order();

-- A line's grams fixed on its order (bhav cut), at the order's rate; the rest is at the day's rate.
ALTER TABLE jewellery_bill_lines
  ADD COLUMN fixed_weight NUMERIC(10,3) NOT NULL DEFAULT 0,
  ADD COLUMN fixed_rate NUMERIC(12,2),
  ADD COLUMN fixed_sheet_id BIGINT,
  ADD CONSTRAINT jewellery_bill_lines_fixed_sheet FOREIGN KEY (business_id, fixed_sheet_id) REFERENCES jewellery_rate_sheets(business_id, id),
  ADD CONSTRAINT jewellery_bill_lines_fixed CHECK (fixed_weight >= 0 AND fixed_weight <= net_weight AND (fixed_weight = 0) = (fixed_rate IS NULL)
    AND (fixed_rate IS NULL) = (fixed_sheet_id IS NULL));
ALTER TABLE jewellery_bill_lines DROP CONSTRAINT jewellery_bill_lines_check1,
  ADD CONSTRAINT jewellery_bill_lines_metal_value CHECK (metal_value = round(fixed_weight * COALESCE(fixed_rate, 0) + (net_weight - fixed_weight) * rate, 2));
ALTER TABLE jewellery_bill_lines DROP CONSTRAINT jewellery_bill_lines_check3,
  ADD CONSTRAINT jewellery_bill_lines_wastage_value CHECK (wastage_value = round((fixed_weight * COALESCE(fixed_rate, 0) + (net_weight - fixed_weight) * rate) * wastage_percent / 100, 2));

-- A bill's piece is on a line of the bill's own sale (its item, its tag as the
-- serial number, one unit, at the line's taxable value and GST), as the piece
-- is now in stock, at the latest rate of the day for its purity, except that a
-- custom order's piece on the order's own bill takes the order's fixed rate
-- for the grams fixed and not yet taken by the bill's earlier lines (and a
-- piece made for an open order goes on no other bill); and a
-- gold piece of 2 g or more carries its BIS hallmark's HUID unless the article
-- is left out of the hallmarking order, the business is exempt by its
-- turnover, or the district is not under mandatory hallmarking (a piece with
-- the old hallmark is re-hallmarked first).
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

-- --- The fine-weight book ---------------------------------------------------------------------------

-- Every change to the metal of a purity the shop holds, by where it is: pieces
-- in stock, on approval, at a karigar and at the hallmarking centre; the shop's
-- metal (melted pieces, old gold, scrap, metal from suppliers); and metal held
-- by karigars. Pieces and the shop's metal write their own rows as they move
-- (triggers on jewellery_pieces and jewellery_metal_movements); karigars'
-- metal is written from the issue challans, receipts and write-offs. What the
-- shop held when this book began came in as its opening.
CREATE TABLE jewellery_fine_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  holder TEXT NOT NULL CHECK (holder IN ('stock', 'approval', 'karigar', 'centre', 'metal', 'karigar_metal')),
  net_weight NUMERIC(12,3) NOT NULL,
  fine_weight NUMERIC(12,3) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'tagged', 'changed', 'moved', 'sold', 'returned', 'melted', 'split', 'merged', 'retagged',
    'melted_piece', 'old_gold', 'old_gold_cancelled', 'karigar_issue', 'karigar_return', 'supplier_in', 'supplier_out',
    'karigar_made', 'karigar_repair', 'wastage_allowed', 'wastage_written_off')),
  piece_id BIGINT,
  metal_movement_id BIGINT,
  karigar_id BIGINT,
  issue_id BIGINT,
  receipt_id BIGINT,
  writeoff_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, piece_id) REFERENCES jewellery_pieces(business_id, id),
  FOREIGN KEY (business_id, karigar_id) REFERENCES jewellery_karigars(business_id, contact_id),
  FOREIGN KEY (business_id, issue_id) REFERENCES jewellery_karigar_issues(business_id, id),
  FOREIGN KEY (business_id, receipt_id) REFERENCES jewellery_karigar_receipts(business_id, id),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK ((holder = 'karigar_metal') = (karigar_id IS NOT NULL))
);
CREATE INDEX jewellery_fine_ledger_book ON jewellery_fine_ledger(business_id, metal, purity, created_at);
CREATE INDEX jewellery_fine_ledger_karigar ON jewellery_fine_ledger(business_id, karigar_id, metal, purity) WHERE karigar_id IS NOT NULL;
CREATE TRIGGER jewellery_fine_ledger_append_only BEFORE UPDATE OR DELETE ON jewellery_fine_ledger
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- A piece's metal in the book: in when it is tagged; moved between stock,
-- approval, a karigar and the centre; changed with its weight or purity; out
-- when it leaves the shop (sold, melted, split, merged, given a new tag), and
-- in again when it is taken back on a credit note.
CREATE FUNCTION jewellery_pieces_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_holder TEXT; after_holder TEXT; same BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, piece_id)
    VALUES (NEW.business_id, NEW.metal, NEW.purity, 'stock', NEW.net_weight, jewellery_fine_of(NEW.net_weight, NEW.metal, NEW.purity), 'tagged', NEW.id);
    RETURN NULL;
  END IF;
  before_holder := jewellery_holder_of(OLD.status);
  after_holder := jewellery_holder_of(NEW.status);
  same := NEW.net_weight = OLD.net_weight AND NEW.metal = OLD.metal AND NEW.purity = OLD.purity;
  IF before_holder IS NOT DISTINCT FROM after_holder AND same THEN
    RETURN NULL;
  END IF;
  IF before_holder IS NOT NULL THEN
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, piece_id)
    VALUES (NEW.business_id, OLD.metal, OLD.purity, before_holder, -OLD.net_weight, -jewellery_fine_of(OLD.net_weight, OLD.metal, OLD.purity),
      CASE WHEN after_holder IS NULL THEN NEW.status WHEN same THEN 'moved' ELSE 'changed' END, NEW.id);
  END IF;
  IF after_holder IS NOT NULL THEN
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, piece_id)
    VALUES (NEW.business_id, NEW.metal, NEW.purity, after_holder, NEW.net_weight, jewellery_fine_of(NEW.net_weight, NEW.metal, NEW.purity),
      CASE WHEN before_holder IS NULL THEN 'returned' WHEN same THEN 'moved' ELSE 'changed' END, NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jewellery_pieces_ledger AFTER INSERT OR UPDATE ON jewellery_pieces
  FOR EACH ROW EXECUTE FUNCTION jewellery_pieces_ledger();

-- The shop's metal in the book, as each movement of it is written.
CREATE FUNCTION jewellery_metal_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, metal_movement_id)
  VALUES (NEW.business_id, NEW.metal, NEW.purity, 'metal', NEW.net_weight, NEW.fine_weight, NEW.source, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER jewellery_metal_movements_ledger AFTER INSERT ON jewellery_metal_movements
  FOR EACH ROW EXECUTE FUNCTION jewellery_metal_ledger();

-- Metal held by a karigar: in with the metal on their issue challans; out with
-- the pieces they make (and the wastage allowed on them), with a repaired
-- piece's change of weight, with the scrap and metal they bring back, and with
-- what is written off.
CREATE FUNCTION jewellery_karigar_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE karigar BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'jewellery_karigar_issue_lines' THEN
    IF NEW.kind <> 'metal' THEN RETURN NULL; END IF;
    SELECT contact_id INTO karigar FROM jewellery_karigar_issues WHERE business_id = NEW.business_id AND id = NEW.issue_id;
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, karigar_id, issue_id)
    VALUES (NEW.business_id, NEW.metal, NEW.purity, 'karigar_metal', NEW.net_weight, NEW.fine_weight, 'karigar_issue', karigar, NEW.issue_id);
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'jewellery_karigar_writeoffs' THEN
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, karigar_id, writeoff_id)
    VALUES (NEW.business_id, NEW.metal, NEW.purity, 'karigar_metal', -NEW.net_weight, -NEW.fine_weight, 'wastage_written_off', NEW.contact_id, NEW.id);
    RETURN NULL;
  END IF;
  IF NEW.kind = 'stone' THEN RETURN NULL; END IF;
  SELECT contact_id INTO karigar FROM jewellery_karigar_receipts WHERE business_id = NEW.business_id AND id = NEW.receipt_id;
  IF NEW.kind = 'made' THEN
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, karigar_id, receipt_id, piece_id)
    VALUES (NEW.business_id, NEW.metal, NEW.purity, 'karigar_metal', -NEW.net_weight, -NEW.fine_weight, 'karigar_made', karigar, NEW.receipt_id, NEW.piece_id);
    IF NEW.wastage_weight <> 0 OR NEW.wastage_fine <> 0 THEN
      INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, karigar_id, receipt_id, piece_id)
      VALUES (NEW.business_id, NEW.metal, NEW.purity, 'karigar_metal', -NEW.wastage_weight, -NEW.wastage_fine, 'wastage_allowed', karigar, NEW.receipt_id, NEW.piece_id);
    END IF;
  ELSIF NEW.kind = 'repaired' THEN
    IF NEW.net_weight <> NEW.before_net_weight THEN
      INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, karigar_id, receipt_id, piece_id)
      VALUES (NEW.business_id, NEW.metal, NEW.purity, 'karigar_metal', NEW.before_net_weight - NEW.net_weight, NEW.before_fine_weight - NEW.fine_weight,
        'karigar_repair', karigar, NEW.receipt_id, NEW.piece_id);
    END IF;
  ELSE
    INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, karigar_id, receipt_id)
    VALUES (NEW.business_id, NEW.metal, NEW.purity, 'karigar_metal', -NEW.net_weight, -NEW.fine_weight, 'karigar_return', karigar, NEW.receipt_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER jewellery_karigar_issue_lines_ledger AFTER INSERT ON jewellery_karigar_issue_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_ledger();
CREATE TRIGGER jewellery_karigar_receipt_lines_ledger AFTER INSERT ON jewellery_karigar_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_ledger();
CREATE TRIGGER jewellery_karigar_writeoffs_ledger AFTER INSERT ON jewellery_karigar_writeoffs
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_ledger();

-- What a write-off takes is all that the karigar holds of the purity.
CREATE FUNCTION jewellery_karigar_writeoffs_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held RECORD;
BEGIN
  SELECT COALESCE(sum(net_weight), 0) AS net, COALESCE(sum(fine_weight), 0) AS fine INTO held FROM jewellery_fine_ledger
  WHERE business_id = NEW.business_id AND karigar_id = NEW.contact_id AND metal = NEW.metal AND purity = NEW.purity;
  IF NEW.created_at <> now() OR held.net <> NEW.net_weight OR held.fine <> NEW.fine_weight THEN
    RAISE EXCEPTION 'A write-off takes all the karigar holds of the purity: % g (% g fine)', held.net, held.fine USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jewellery_karigar_writeoffs_check BEFORE INSERT ON jewellery_karigar_writeoffs
  FOR EACH ROW EXECUTE FUNCTION jewellery_karigar_writeoffs_check();

-- What the shop held when the book began: each piece in the shop where it is,
-- and the shop's metal of each purity.
INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind, piece_id)
SELECT business_id, metal, purity, jewellery_holder_of(status), net_weight, jewellery_fine_of(net_weight, metal, purity), 'opening', id
FROM jewellery_pieces WHERE jewellery_holder_of(status) IS NOT NULL;
INSERT INTO jewellery_fine_ledger(business_id, metal, purity, holder, net_weight, fine_weight, kind)
SELECT business_id, metal, purity, 'metal', sum(net_weight), sum(fine_weight), 'opening' FROM jewellery_metal_movements
GROUP BY business_id, metal, purity HAVING sum(net_weight) <> 0 OR sum(fine_weight) <> 0;

-- A count of a location's pieces in stock (by their tags) and metal (weighed), purity by purity.
CREATE TABLE jewellery_fine_counts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX jewellery_fine_counts_location ON jewellery_fine_counts(business_id, location_id, created_at DESC);
CREATE TRIGGER jewellery_fine_counts_append_only BEFORE UPDATE OR DELETE ON jewellery_fine_counts
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- Each purity's book at the location when it was counted (its pieces in stock
-- and its metal), and what was counted: the pieces found by their tags, those
-- in the book not found and those found that the book has elsewhere, and the
-- metal weighed (none when it was not).
CREATE TABLE jewellery_fine_count_lines (
  business_id BIGINT NOT NULL,
  count_id BIGINT NOT NULL,
  metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'platinum')),
  purity TEXT NOT NULL,
  book_pieces INTEGER NOT NULL CHECK (book_pieces >= 0),
  book_pieces_net NUMERIC(12,3) NOT NULL,
  book_pieces_fine NUMERIC(12,3) NOT NULL,
  counted_pieces INTEGER NOT NULL CHECK (counted_pieces >= 0),
  counted_pieces_net NUMERIC(12,3) NOT NULL,
  counted_pieces_fine NUMERIC(12,3) NOT NULL,
  missing_tags TEXT[] NOT NULL DEFAULT '{}',
  extra_tags TEXT[] NOT NULL DEFAULT '{}',
  book_metal_net NUMERIC(12,3) NOT NULL,
  book_metal_fine NUMERIC(12,3) NOT NULL,
  counted_metal_net NUMERIC(12,3) CHECK (counted_metal_net >= 0),
  counted_metal_fine NUMERIC(12,3) CHECK (counted_metal_fine >= 0),
  PRIMARY KEY (business_id, count_id, metal, purity),
  FOREIGN KEY (business_id, count_id) REFERENCES jewellery_fine_counts(business_id, id),
  CHECK (jewellery_fineness(metal, purity) IS NOT NULL),
  CHECK ((counted_metal_net IS NULL) = (counted_metal_fine IS NULL))
);
CREATE TRIGGER jewellery_fine_count_lines_append_only BEFORE UPDATE OR DELETE ON jewellery_fine_count_lines
  FOR EACH ROW EXECUTE FUNCTION jewellery_work_append_only();

-- Down Migration
DROP TRIGGER business_stock_transfer_lines_jewellery ON business_stock_transfer_lines;
DROP TRIGGER business_stock_adjustments_jewellery ON business_stock_adjustments;
DROP TRIGGER business_payments_jewellery_order ON business_payments;
DROP TRIGGER business_collection_refunds_jewellery_order ON business_collection_refunds;
DROP TRIGGER jewellery_old_gold_order ON jewellery_old_gold;
DROP TRIGGER jewellery_old_gold_payouts_order ON jewellery_old_gold_payouts;
DROP TRIGGER jewellery_old_gold_uses_order ON jewellery_old_gold_uses;
DROP TRIGGER jewellery_pieces_ledger ON jewellery_pieces;
DROP TRIGGER jewellery_metal_movements_ledger ON jewellery_metal_movements;
DROP TRIGGER jewellery_bills_order ON jewellery_bills;
DROP TABLE jewellery_fine_count_lines, jewellery_fine_counts, jewellery_fine_ledger;

-- The bill lines and bills as they were.
CREATE OR REPLACE FUNCTION jewellery_bill_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER TABLE jewellery_bill_lines DROP CONSTRAINT jewellery_bill_lines_wastage_value,
  ADD CONSTRAINT jewellery_bill_lines_check3 CHECK (wastage_value = round(net_weight * rate * wastage_percent / 100, 2));
ALTER TABLE jewellery_bill_lines DROP CONSTRAINT jewellery_bill_lines_metal_value,
  ADD CONSTRAINT jewellery_bill_lines_check1 CHECK (metal_value = round(net_weight * rate, 2));
ALTER TABLE jewellery_bill_lines DROP CONSTRAINT jewellery_bill_lines_fixed, DROP CONSTRAINT jewellery_bill_lines_fixed_sheet,
  DROP COLUMN fixed_sheet_id, DROP COLUMN fixed_rate, DROP COLUMN fixed_weight;
DROP FUNCTION jewellery_bills_order();
ALTER TABLE jewellery_bills DROP CONSTRAINT jewellery_bills_order_once, DROP CONSTRAINT jewellery_bills_order_fk, DROP COLUMN order_id;

-- The pieces' rules as they were.
CREATE OR REPLACE FUNCTION jewellery_piece_parts_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION jewellery_pieces_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP FUNCTION jewellery_piece_out_check();

-- The shop's metal as it was.
CREATE OR REPLACE FUNCTION jewellery_metal_movements_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP INDEX jewellery_metal_movements_supplier_entry, jewellery_metal_movements_receipt_line, jewellery_metal_movements_issue_line;
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_refs;
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_direction,
  ADD CONSTRAINT jewellery_metal_movements_check3 CHECK ((net_weight > 0) = (source IN ('melted_piece', 'old_gold')));
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_source_check,
  ADD CONSTRAINT jewellery_metal_movements_source_check CHECK (source IN ('melted_piece', 'old_gold', 'old_gold_cancelled'));
ALTER TABLE jewellery_metal_movements DROP CONSTRAINT jewellery_metal_movements_supplier, DROP CONSTRAINT jewellery_metal_movements_receipt,
  DROP CONSTRAINT jewellery_metal_movements_issue, DROP COLUMN supplier_entry_id, DROP COLUMN receipt_seq, DROP COLUMN receipt_id, DROP COLUMN issue_seq, DROP COLUMN issue_id;

DROP TABLE jewellery_supplier_metal, jewellery_files, jewellery_piece_links, jewellery_hallmark_lines, jewellery_hallmark_consignments,
  jewellery_approval_lines, jewellery_approval_returns, jewellery_approvals, jewellery_karigar_invoice_lines, jewellery_karigar_invoices,
  jewellery_karigar_writeoffs, jewellery_karigar_receipt_lines, jewellery_karigar_receipts, jewellery_karigar_issue_lines, jewellery_karigar_issues,
  jewellery_order_advances, jewellery_order_pieces, jewellery_orders, jewellery_karigar_rates, jewellery_karigars, jewellery_account_items;
DROP FUNCTION jewellery_karigar_writeoffs_check();
DROP FUNCTION jewellery_karigar_ledger();
DROP FUNCTION jewellery_metal_ledger();
DROP FUNCTION jewellery_pieces_ledger();
DROP FUNCTION jewellery_supplier_metal_check();
DROP FUNCTION jewellery_files_guard();
DROP FUNCTION jewellery_piece_links_check();
DROP FUNCTION jewellery_hallmark_lines_guard();
DROP FUNCTION jewellery_hallmark_consignments_guard();
DROP FUNCTION jewellery_approval_lines_sold();
DROP FUNCTION jewellery_approval_lines_guard();
DROP FUNCTION jewellery_approvals_check();
DROP FUNCTION jewellery_karigar_invoice_lines_check();
DROP FUNCTION jewellery_karigar_invoices_check();
DROP FUNCTION jewellery_karigar_issue_lines_check();
DROP FUNCTION jewellery_karigar_receipt_lines_check();
DROP FUNCTION jewellery_karigar_receipts_check();
DROP FUNCTION jewellery_order_old_gold_check();
DROP FUNCTION jewellery_order_payment_check();
DROP FUNCTION jewellery_orders_guard();
DROP FUNCTION jewellery_order_advances_check();
DROP FUNCTION jewellery_order_pieces_check();
DROP FUNCTION jewellery_karigars_guard();

ALTER TABLE jewellery_piece_events DROP CONSTRAINT jewellery_piece_events_kind_check,
  ADD CONSTRAINT jewellery_piece_events_kind_check CHECK (kind IN ('tagged', 'changed', 'sent', 'back', 'sold', 'returned', 'melted'));
DROP INDEX jewellery_pieces_design;
ALTER TABLE jewellery_pieces DROP CONSTRAINT jewellery_pieces_with_whom,
  ADD CONSTRAINT jewellery_pieces_check5 CHECK ((status IN ('on_approval', 'at_karigar')) = (with_whom IS NOT NULL));
ALTER TABLE jewellery_pieces DROP CONSTRAINT jewellery_pieces_status_check,
  ADD CONSTRAINT jewellery_pieces_status_check CHECK (status IN ('in_stock', 'on_approval', 'at_karigar', 'sold', 'melted'));
ALTER TABLE jewellery_pieces DROP CONSTRAINT jewellery_pieces_old_hallmark, DROP CONSTRAINT jewellery_pieces_design_code,
  DROP COLUMN old_hallmark, DROP COLUMN design_code;

DROP FUNCTION jewellery_work_append_only();
DROP FUNCTION jewellery_holder_of(TEXT);
DROP FUNCTION jewellery_fine_of(NUMERIC, TEXT, TEXT);

DELETE FROM business_number_series WHERE document_kind IN ('karigar_issue', 'karigar_receipt', 'custom_order', 'approval', 'hallmark_consignment', 'metal_voucher');
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := ARRAY(SELECT k FROM unnest(kinds) AS k
    WHERE NOT k = ANY (ARRAY['karigar_issue', 'karigar_receipt', 'custom_order', 'approval', 'hallmark_consignment', 'metal_voucher']));
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
