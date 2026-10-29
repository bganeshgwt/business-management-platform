-- Up Migration
-- What a fuel station's back office still needed, on the module "fuel":
-- the attendant's whole settlement, the fleet's monthly billing and its
-- slips, the stock register's allowances, the tanker load compartment by
-- compartment, the retention samples, the dip charts and the records.
--
--   the shift's other sales   lubricants, additives and shop items an
--                             attendant sells on the forecourt, billed as GST
--                             invoices through the core at their slabs (to no
--                             one by name, or to a customer on credit), never on
--                             the fuel bills (fuel_close_goods_bills); their
--                             money counted with the fuel's
--   fills of ₹2,00,000 or more  a walk-in buyer's big fill billed on its own at
--                             the close, with the buyer's PAN or declaration
--                             (Form 97) and the cash limit (fuel_close_big_fills)
--   cash drops and the count  cash handed over in the middle of a shift, when
--                             and to whom (fuel_cash_drops); the cash counted at
--                             the close by notes and coins (fuel_close_counts),
--                             the denominations being the station's settings
--   the attendant's account   a short is due from the attendant (paid on the
--                             bills from their account, never left due on them),
--                             recovered when they pay or by a deduction when they
--                             are paid their wages; an excess is held until a
--                             manager takes it to other income
--                             (fuel_attendant_entries)
--   the fleet                 billing per shift or by the month (fuel_fleet_terms):
--                             fills of a monthly customer are held on their
--                             indents, not billed, until one invoice for the
--                             month bills them, the stock leaving with it
--                             (fuel_month_invoices, fuel_month_invoice_fills);
--                             slip books by serial (fuel_indent_books), each slip
--                             of a book used once; interest on overdue credit by
--                             the customer's terms (fuel_fleet_interest)
--   the stock register        a load's shrinkage and temperature variation
--                             allowances (₹ per KL on its invoice) on its tank
--                             line; a day's gap posted to the stock as a
--                             correction by a manager (fuel_stock_corrections)
--   tanker loads              each compartment's dip, density, temperature and
--                             water-finding paste, the 20-litre check from its
--                             manifold, the short made up (fuel_receipt_compartments);
--                             retention samples of the loads (fuel_samples)
--   dip charts                each tank's calibration chart, cm to litres
--                             (fuel_dip_charts); a dip read in cm takes its litres
--                             from it
--   records                   the inspection log, kept and never erased
--                             (fuel_inspections)
-- The delivery challans of the wholesale tools go with an invoice already
-- posted (a dispatch is itself the sale): they cannot carry fills until a
-- later invoice, so a monthly customer's fills are held here and their stock
-- leaves once, with the month's invoice.
-- Functions replaced, each from its body in 1791969000000_fuel-station.sql:
-- fuel_close_adds_up (the other sales, big fills, drops, the count and the
-- attendant's account), fuel_credit_slips_check (fills held for the month,
-- slips by serial) and fuel_line_return (big fills and the month's invoice).

-- --- Settings ----------------------------------------------------------------------------------

-- The notes and coins the cash is counted in (₹), and the service item interest is billed as.
ALTER TABLE fuel_settings
  ADD COLUMN denominations INTEGER[] NOT NULL DEFAULT '{500,200,100,50,20,10,5,2,1}'
    CONSTRAINT fuel_settings_denominations CHECK (cardinality(denominations) BETWEEN 1 AND 20 AND 0 < ALL(denominations) AND 2000 >= ALL(denominations)),
  ADD COLUMN interest_sku_id BIGINT,
  ADD CONSTRAINT fuel_settings_interest_item FOREIGN KEY (business_id, interest_sku_id) REFERENCES catalog_skus(business_id, id);

-- --- The close: other sales, big fills, drops and the count ------------------------------------------

ALTER TABLE fuel_shift_closes
  -- The cash dropped during the shift (counted with the cash at the close).
  ADD COLUMN dropped NUMERIC(16,2) NOT NULL DEFAULT 0 CONSTRAINT fuel_shift_closes_dropped CHECK (dropped >= 0),
  -- Walk-in fills of ₹2,00,000 or more, each billed on its own, and the cash taken on them.
  ADD COLUMN big NUMERIC(16,2) NOT NULL DEFAULT 0 CONSTRAINT fuel_shift_closes_big CHECK (big >= 0),
  ADD COLUMN big_cash NUMERIC(16,2) NOT NULL DEFAULT 0 CONSTRAINT fuel_shift_closes_big_cash CHECK (big_cash >= 0 AND big_cash <= big),
  -- The other sales (lubricants, shop items): to no one by name, the takings paid on that bill, and on credit.
  ADD COLUMN goods_walk_in NUMERIC(16,2) NOT NULL DEFAULT 0 CONSTRAINT fuel_shift_closes_goods_walk_in CHECK (goods_walk_in >= 0),
  ADD COLUMN goods_other NUMERIC(16,2) NOT NULL DEFAULT 0 CONSTRAINT fuel_shift_closes_goods_other CHECK (goods_other >= 0 AND goods_other <= goods_walk_in),
  ADD COLUMN goods_credit NUMERIC(16,2) NOT NULL DEFAULT 0 CONSTRAINT fuel_shift_closes_goods_credit CHECK (goods_credit >= 0),
  ADD CONSTRAINT fuel_shift_closes_cash_covers CHECK (cash + dropped >= big_cash);

ALTER TABLE fuel_close_products
  ADD COLUMN big_litres NUMERIC(14,3) NOT NULL DEFAULT 0 CONSTRAINT fuel_close_products_big_litres CHECK (big_litres >= 0),
  ADD COLUMN big_amount NUMERIC(16,2) NOT NULL DEFAULT 0 CONSTRAINT fuel_close_products_big_amount CHECK (big_amount >= 0);

-- The sums the close and its fuels keep, with big fills and drops: the
-- unnamed checks of 1791969000000 are found by what they say and replaced.
DO $$
DECLARE target RECORD;
BEGIN
  FOR target IN SELECT * FROM (VALUES
      ('fuel_shift_closes', 'CHECK ((expected = (credit + walk_in)))'),
      ('fuel_shift_closes', 'CHECK ((difference = ((cash + other) - walk_in)))'),
      ('fuel_close_products', 'CHECK ((walk_in_litres = (litres - credit_litres)))'),
      ('fuel_close_products', 'CHECK ((amount = (credit_amount + walk_in_amount)))')) AS x(tab, def)
  LOOP
    PERFORM 1 FROM pg_constraint WHERE conrelid = target.tab::regclass AND contype = 'c' AND pg_get_constraintdef(oid) = target.def;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The check % on % was not found', target.def, target.tab;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.tab,
      (SELECT conname FROM pg_constraint WHERE conrelid = target.tab::regclass AND contype = 'c' AND pg_get_constraintdef(oid) = target.def));
  END LOOP;
END $$;
ALTER TABLE fuel_shift_closes
  ADD CONSTRAINT fuel_shift_closes_expected CHECK (expected = credit + walk_in + big),
  ADD CONSTRAINT fuel_shift_closes_difference CHECK (difference = cash + dropped - big_cash + other + goods_other - walk_in - goods_walk_in);
ALTER TABLE fuel_close_products
  ADD CONSTRAINT fuel_close_products_walk_in CHECK (walk_in_litres = litres - credit_litres - big_litres),
  ADD CONSTRAINT fuel_close_products_amount CHECK (amount = credit_amount + walk_in_amount + big_amount);

-- A walk-in buyer's fill of ₹2,00,000 or more, billed on its own at the close:
-- to no one by name, with the buyer's PAN or declaration (on the bill), paid
-- in full there, the cash limit checked on it.
CREATE TABLE fuel_close_big_fills (
  business_id BIGINT NOT NULL,
  close_id BIGINT NOT NULL,
  shift_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 50),
  product_id BIGINT NOT NULL,
  litres NUMERIC(12,3) NOT NULL CHECK (litres > 0),
  price NUMERIC(10,2) NOT NULL CHECK (price > 0),
  amount NUMERIC(16,2) NOT NULL CHECK (amount >= 200000),
  -- The vehicle filled, as on its plate, when it was noted.
  registration VARCHAR(15) CHECK (registration ~ '^[A-Z0-9]{4,15}$'),
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  PRIMARY KEY (business_id, close_id, seq),
  FOREIGN KEY (business_id, shift_id, close_id) REFERENCES fuel_shift_closes(business_id, shift_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, line_id),
  CHECK (amount = round(litres * price, 2))
);

-- The other sales of a close: its GST invoices, to no one by name (one) or to
-- a customer on credit (one each).
CREATE TABLE fuel_close_goods_bills (
  business_id BIGINT NOT NULL,
  close_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  walk_in BOOLEAN NOT NULL,
  PRIMARY KEY (business_id, document_id),
  FOREIGN KEY (business_id, close_id) REFERENCES fuel_shift_closes(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id)
);
CREATE UNIQUE INDEX fuel_close_goods_bills_walk_in ON fuel_close_goods_bills(business_id, close_id) WHERE walk_in;
CREATE INDEX fuel_close_goods_bills_close ON fuel_close_goods_bills(business_id, close_id);

-- The cash counted at a close, note by note and coin by coin (₹).
CREATE TABLE fuel_close_counts (
  business_id BIGINT NOT NULL,
  close_id BIGINT NOT NULL,
  denomination INTEGER NOT NULL CHECK (denomination > 0 AND denomination <= 2000),
  pieces INTEGER NOT NULL CHECK (pieces > 0 AND pieces <= 1000000),
  PRIMARY KEY (business_id, close_id, denomination),
  FOREIGN KEY (business_id, close_id) REFERENCES fuel_shift_closes(business_id, id)
);

-- Cash an attendant hands over in the middle of a shift: how much, when and to whom.
CREATE TABLE fuel_cash_drops (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  shift_id BIGINT NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0 AND amount < 10000000),
  dropped_at TIMESTAMPTZ NOT NULL,
  -- Who took it (a manager, the cashier, the safe's keeper), and their name as it was.
  received_by BIGINT NOT NULL REFERENCES users(id),
  received_by_name VARCHAR(150) NOT NULL CHECK (btrim(received_by_name) <> ''),
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A drop typed wrongly, cancelled by a manager while the shift is open.
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  cancel_reason VARCHAR(300) CHECK (btrim(cancel_reason) <> ''),
  FOREIGN KEY (business_id, shift_id) REFERENCES fuel_shifts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX fuel_cash_drops_shift ON fuel_cash_drops(business_id, shift_id);

-- A drop is of an open shift, when it is written, made since the shift opened,
-- to someone on the staff other than its attendant. It is never changed or
-- deleted: a manager cancels it, saying why, while the shift is open.
CREATE FUNCTION fuel_cash_drops_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shift RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A cash drop is never deleted: a manager cancels it' USING ERRCODE = '23514';
  END IF;
  SELECT shift_no, status, opened_at, attendant_id INTO shift FROM fuel_shifts WHERE business_id = NEW.business_id AND id = NEW.shift_id;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason']) <> (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason'])
       OR OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'A cash drop keeps what was handed over: a manager cancels it once, saying why' USING ERRCODE = '23514';
    END IF;
    IF shift.status <> 'open' THEN
      RAISE EXCEPTION 'Shift % is closed: its cash drops are kept as they were closed', shift.shift_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift % is closed: a cash drop is made while a shift is open', shift.shift_no USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at <> now() OR NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'A cash drop is written when it is made' USING ERRCODE = '23514';
  END IF;
  IF NEW.dropped_at < shift.opened_at OR NEW.dropped_at > now() THEN
    RAISE EXCEPTION 'A cash drop of shift % is made after it opened, not later than now', shift.shift_no USING ERRCODE = '23514';
  END IF;
  IF NEW.received_by = shift.attendant_id OR NOT EXISTS (SELECT 1 FROM business_memberships WHERE business_id = NEW.business_id AND user_id = NEW.received_by AND active) THEN
    RAISE EXCEPTION 'A cash drop is handed to someone on the staff other than the shift''s attendant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_cash_drops_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_cash_drops
  FOR EACH ROW EXECUTE FUNCTION fuel_cash_drops_check();

-- A close's big fills, other sales' bills and count are written with it, and kept.
CREATE FUNCTION fuel_close_parts_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fc RECORD; shift RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A closed shift''s readings, sales and takings are kept as they were closed' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO fc FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.close_id;
  IF fc.created_at <> now() THEN
    RAISE EXCEPTION 'A shift''s sales and takings are written with its close' USING ERRCODE = '23514';
  END IF;
  SELECT location_id INTO shift FROM fuel_shifts WHERE business_id = fc.business_id AND id = fc.shift_id;
  IF TG_TABLE_NAME = 'fuel_close_big_fills' THEN
    IF NOT EXISTS (
         SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
         JOIN fuel_products f ON f.business_id = l.business_id AND f.sku_id = l.sku_id
         WHERE l.business_id = NEW.business_id AND l.id = (to_jsonb(NEW) ->> 'line_id')::bigint AND l.document_id = (to_jsonb(NEW) ->> 'document_id')::bigint
           AND d.kind = 'sale' AND d.contact_id IS NULL AND d.location_id = shift.location_id AND f.id = (to_jsonb(NEW) ->> 'product_id')::bigint
           AND l.quantity = (to_jsonb(NEW) ->> 'litres')::numeric AND l.net = (to_jsonb(NEW) ->> 'amount')::numeric AND l.tax = 0) THEN
      RAISE EXCEPTION 'A fill of ₹2,00,000 or more is a bill of its own to its buyer, for its litres and money' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'fuel_close_goods_bills' THEN
    IF NOT EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = (to_jsonb(NEW) ->> 'document_id')::bigint AND d.kind = 'sale'
         AND d.location_id = shift.location_id AND (d.contact_id IS NULL) = (to_jsonb(NEW) ->> 'walk_in')::boolean)
       OR EXISTS (SELECT 1 FROM business_document_lines l JOIN fuel_products f ON f.business_id = l.business_id AND f.sku_id = l.sku_id
         WHERE l.business_id = NEW.business_id AND l.document_id = (to_jsonb(NEW) ->> 'document_id')::bigint) THEN
      RAISE EXCEPTION 'A shift''s other sales are GST invoices of their own at its outlet, with no fuel on them' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_close_big_fills_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_close_big_fills
  FOR EACH ROW EXECUTE FUNCTION fuel_close_parts_check();
CREATE TRIGGER fuel_close_goods_bills_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_close_goods_bills
  FOR EACH ROW EXECUTE FUNCTION fuel_close_parts_check();
CREATE TRIGGER fuel_close_counts_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_close_counts
  FOR EACH ROW EXECUTE FUNCTION fuel_close_parts_check();

-- --- The attendant's account -------------------------------------------------------------------

-- An attendant's account: a close's short (due from them) or excess (held on
-- it); the short recovered when they pay or by a deduction from their wages;
-- an excess taken to other income by a manager; and, when a manager reopens a
-- shift, its close's short or excess reversed.
CREATE TABLE fuel_attendant_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  attendant_id BIGINT NOT NULL REFERENCES users(id),
  attendant_name VARCHAR(150) NOT NULL CHECK (btrim(attendant_name) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('short', 'excess', 'short_reversed', 'excess_reversed', 'paid', 'deducted', 'to_income')),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  -- The close a short or an excess (or its reversal) is of.
  close_id BIGINT,
  -- How the attendant paid, or how the excess is held (cash), with the method's name as it was.
  method TEXT CHECK (method IN ('cash', 'upi', 'card', 'bank')),
  method_name VARCHAR(60),
  -- The wages paid out when a deduction was made (none when nothing was left to pay).
  expense_id BIGINT,
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, close_id) REFERENCES fuel_shift_closes(business_id, id),
  FOREIGN KEY (business_id, expense_id) REFERENCES business_expenses(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  CHECK ((close_id IS NOT NULL) = (kind IN ('short', 'excess', 'short_reversed', 'excess_reversed'))),
  CHECK ((method IS NOT NULL) = (kind IN ('paid', 'to_income'))),
  CHECK (kind <> 'to_income' OR method = 'cash'),
  CHECK (expense_id IS NULL OR kind = 'deducted'),
  CHECK (note IS NOT NULL OR kind NOT IN ('deducted', 'to_income'))
);
CREATE INDEX fuel_attendant_entries_person ON fuel_attendant_entries(business_id, attendant_id, created_at);
CREATE INDEX fuel_attendant_entries_close ON fuel_attendant_entries(business_id, close_id) WHERE close_id IS NOT NULL;

-- What an attendant owes (shorts less reversals, payments and deductions) and
-- what is held for them (excesses less reversals and what went to income).
CREATE FUNCTION fuel_attendant_balance(target_business BIGINT, target_attendant BIGINT) RETURNS TABLE (due NUMERIC, held NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(CASE kind WHEN 'short' THEN amount WHEN 'short_reversed' THEN -amount WHEN 'paid' THEN -amount WHEN 'deducted' THEN -amount ELSE 0 END), 0),
    COALESCE(sum(CASE kind WHEN 'excess' THEN amount WHEN 'excess_reversed' THEN -amount WHEN 'to_income' THEN -amount ELSE 0 END), 0)
  FROM fuel_attendant_entries WHERE business_id = target_business AND attendant_id = target_attendant;
$$;

-- An entry is written when it happens and kept as it was: a close's short or
-- excess with its close, by its attendant; a reversal with the reopening; a
-- payment or a deduction never more than is due, nor money to income more
-- than is held.
CREATE FUNCTION fuel_attendant_entries_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fc RECORD; balance RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An attendant''s account is kept as it was written: a later entry corrects it' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'An attendant''s account is written when it happens' USING ERRCODE = '23514';
  END IF;
  IF NEW.close_id IS NOT NULL THEN
    SELECT c.created_at, c.reopened_at, s.attendant_id, s.location_id INTO fc FROM fuel_shift_closes c JOIN fuel_shifts s ON s.business_id = c.business_id AND s.id = c.shift_id
    WHERE c.business_id = NEW.business_id AND c.id = NEW.close_id;
    IF fc.attendant_id <> NEW.attendant_id OR fc.location_id <> NEW.location_id
       OR (NEW.kind IN ('short', 'excess') AND fc.created_at <> now()) OR (NEW.kind IN ('short_reversed', 'excess_reversed') AND fc.reopened_at IS DISTINCT FROM now()) THEN
      RAISE EXCEPTION 'A shift''s short or excess is its attendant''s, written with its close or its reopening' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO balance FROM fuel_attendant_balance(NEW.business_id, NEW.attendant_id);
  IF NEW.kind IN ('paid', 'deducted') AND NEW.amount > balance.due THEN
    RAISE EXCEPTION '% owes ₹% on their account: no more than that is recovered', NEW.attendant_name, GREATEST(balance.due, 0)::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'to_income' AND NEW.amount > balance.held THEN
    RAISE EXCEPTION '₹% of % is held as excess: no more than that goes to income', GREATEST(balance.held, 0)::NUMERIC(16,2), NEW.attendant_name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_attendant_entries_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_attendant_entries
  FOR EACH ROW EXECUTE FUNCTION fuel_attendant_entries_check();

-- --- Fleet: billing, slip books, the month's invoice and interest ---------------------------------

-- A fleet customer's terms with the station: billed per shift or by the
-- month, and the interest on overdue credit (% a month, from so many days
-- after a bill falls due; none when no rate).
CREATE TABLE fuel_fleet_terms (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  billing TEXT NOT NULL DEFAULT 'shift' CHECK (billing IN ('shift', 'month')),
  interest_rate NUMERIC(5,2) CHECK (interest_rate > 0 AND interest_rate <= 10),
  interest_after_days SMALLINT NOT NULL DEFAULT 0 CHECK (interest_after_days BETWEEN 0 AND 365),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id)
);
CREATE TRIGGER fuel_fleet_terms_customer BEFORE INSERT ON fuel_fleet_terms
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- Slip (indent) books issued to a fleet customer, each a range of serial numbers.
CREATE TABLE fuel_indent_books (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  book_no VARCHAR(30) NOT NULL CHECK (btrim(book_no) <> ''),
  first_serial INTEGER NOT NULL CHECK (first_serial > 0),
  last_serial INTEGER NOT NULL,
  issued_on DATE NOT NULL,
  -- In use; a book taken back or lost is withdrawn, and its slips are no longer taken.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, contact_id, id),
  CHECK (last_serial >= first_serial AND last_serial - first_serial < 10000)
);
CREATE UNIQUE INDEX fuel_indent_books_number ON fuel_indent_books(business_id, contact_id, lower(book_no));
CREATE TRIGGER fuel_indent_books_customer BEFORE INSERT ON fuel_indent_books
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A book keeps its customer, number and serials, never overlaps another of
-- the customer's books, and is never deleted; it is withdrawn instead.
CREATE FUNCTION fuel_indent_books_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE clash RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A slip book is never deleted: withdraw it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.contact_id <> OLD.contact_id OR lower(NEW.book_no) <> lower(OLD.book_no) OR NEW.first_serial <> OLD.first_serial OR NEW.last_serial <> OLD.last_serial
       OR NEW.issued_on <> OLD.issued_on OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'Slip book % keeps its customer, its number and its serials', OLD.book_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT book_no, first_serial, last_serial INTO clash FROM fuel_indent_books WHERE business_id = NEW.business_id AND contact_id = NEW.contact_id
    AND int4range(first_serial, last_serial, '[]') && int4range(NEW.first_serial, NEW.last_serial, '[]') LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Slips % to % are in the customer''s book % already', clash.first_serial, clash.last_serial, clash.book_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_indent_books_guard BEFORE INSERT OR UPDATE OR DELETE ON fuel_indent_books
  FOR EACH ROW EXECUTE FUNCTION fuel_indent_books_guard();

-- A credit fill of a customer billed by the month is held on its slip, with
-- no bill yet (its stock still in the core); a slip from a book names it and
-- its serial.
ALTER TABLE fuel_credit_slips
  ALTER COLUMN document_id DROP NOT NULL,
  ALTER COLUMN line_id DROP NOT NULL,
  ADD COLUMN held BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN book_id BIGINT,
  ADD COLUMN serial INTEGER CHECK (serial > 0),
  ADD CONSTRAINT fuel_credit_slips_book FOREIGN KEY (business_id, contact_id, book_id) REFERENCES fuel_indent_books(business_id, contact_id, id),
  ADD CONSTRAINT fuel_credit_slips_held CHECK ((document_id IS NULL) = held AND (line_id IS NULL) = held),
  ADD CONSTRAINT fuel_credit_slips_serial CHECK ((book_id IS NULL) = (serial IS NULL));
CREATE INDEX fuel_credit_slips_book ON fuel_credit_slips(business_id, book_id, serial) WHERE book_id IS NOT NULL;
CREATE INDEX fuel_credit_slips_held ON fuel_credit_slips(business_id, contact_id) WHERE held;

-- The fuel migration's check as it was, and: a fill held for the month has no
-- bill; a slip of a customer with slip books is one of their books' serials,
-- in a book in use, never one used on another fill in force.
CREATE OR REPLACE FUNCTION fuel_credit_slips_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fc RECORD; vehicle RECORD; book RECORD; used RECORD;
BEGIN
  SELECT * INTO fc FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.close_id;
  IF fc.created_at <> now() THEN
    RAISE EXCEPTION 'A shift''s credit fills are written with its close' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO vehicle FROM fuel_vehicles WHERE business_id = NEW.business_id AND id = NEW.vehicle_id;
  IF NOT vehicle.active OR NEW.registration <> vehicle.registration THEN
    RAISE EXCEPTION 'Vehicle % is not one of the customer''s vehicles in use', NEW.registration USING ERRCODE = '23514';
  END IF;
  IF vehicle.product_id IS NOT NULL AND vehicle.product_id <> NEW.product_id THEN
    RAISE EXCEPTION 'Vehicle % takes another fuel on credit', vehicle.registration USING ERRCODE = '23514';
  END IF;
  IF vehicle.fill_limit IS NOT NULL AND NEW.litres > vehicle.fill_limit AND NOT NEW.over_limit THEN
    RAISE EXCEPTION 'Vehicle % takes at most % litres in a fill on credit', vehicle.registration, vehicle.fill_limit USING ERRCODE = '23514';
  END IF;
  IF NEW.over_limit AND fc.approved_by IS NULL THEN
    RAISE EXCEPTION 'Credit over a limit is allowed by a manager' USING ERRCODE = '23514';
  END IF;
  IF NEW.book_id IS NOT NULL THEN
    SELECT * INTO book FROM fuel_indent_books WHERE business_id = NEW.business_id AND id = NEW.book_id;
    IF NOT book.active OR NEW.serial < book.first_serial OR NEW.serial > book.last_serial THEN
      RAISE EXCEPTION 'Slip % is not in book % of the customer''s slips in use', NEW.serial, book.book_no USING ERRCODE = '23514';
    END IF;
    SELECT s.shift_no INTO used FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id = k.business_id AND x.id = k.close_id AND x.reopened_at IS NULL
      JOIN fuel_shifts s ON s.business_id = x.business_id AND s.id = x.shift_id
    WHERE k.business_id = NEW.business_id AND k.book_id = NEW.book_id AND k.serial = NEW.serial AND k.id <> NEW.id LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Slip % of book % was used already, on shift %', NEW.serial, book.book_no, used.shift_no USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM fuel_indent_books WHERE business_id = NEW.business_id AND contact_id = NEW.contact_id AND active) THEN
    RAISE EXCEPTION 'The customer''s fills are on the slips of their books: give the slip''s serial' USING ERRCODE = '23514';
  END IF;
  IF NEW.held THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
       JOIN fuel_products f ON f.business_id = l.business_id AND f.sku_id = l.sku_id
       WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id AND d.kind = 'sale' AND d.contact_id = NEW.contact_id
         AND f.id = NEW.product_id AND l.quantity = NEW.litres AND l.net = NEW.amount AND l.tax = 0) THEN
    RAISE EXCEPTION 'A credit fill is a line of its own on the shift''s fuel bill to the customer, for its litres and money' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- One invoice billing a monthly customer's held fills of a month at an outlet.
CREATE TABLE fuel_month_invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  -- The month's first day.
  month DATE NOT NULL CHECK (extract(day FROM month) = 1),
  document_id BIGINT NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX fuel_month_invoices_contact ON fuel_month_invoices(business_id, contact_id, month);

CREATE TABLE fuel_month_invoice_fills (
  business_id BIGINT NOT NULL,
  invoice_id BIGINT NOT NULL,
  slip_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  PRIMARY KEY (business_id, slip_id),
  FOREIGN KEY (business_id, invoice_id) REFERENCES fuel_month_invoices(business_id, id),
  FOREIGN KEY (business_id, slip_id) REFERENCES fuel_credit_slips(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, line_id)
);
CREATE INDEX fuel_month_invoice_fills_invoice ON fuel_month_invoice_fills(business_id, invoice_id);

-- A month's invoice and its fills are written together and kept: each fill
-- one held for the month on a close in force, of the invoice's customer at
-- its outlet in its month, billed on a line of its own for its litres and money.
CREATE FUNCTION fuel_month_invoices_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv RECORD; slip RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A month''s fleet invoice is kept as it was made' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'fuel_month_invoices' THEN
    IF NEW.created_at <> now() OR NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale'
         AND contact_id = NEW.contact_id AND location_id = NEW.location_id) THEN
      RAISE EXCEPTION 'A month''s fleet invoice is a sale to its customer at its outlet, made when it is written' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT i.*, b.timezone INTO inv FROM fuel_month_invoices i JOIN businesses b ON b.id = i.business_id
  WHERE i.business_id = NEW.business_id AND i.id = (to_jsonb(NEW) ->> 'invoice_id')::bigint;
  SELECT k.*, x.reopened_at, x.closed_at, s.location_id INTO slip FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id = k.business_id AND x.id = k.close_id
    JOIN fuel_shifts s ON s.business_id = x.business_id AND s.id = x.shift_id
  WHERE k.business_id = NEW.business_id AND k.id = (to_jsonb(NEW) ->> 'slip_id')::bigint;
  IF inv.created_at <> now() OR NOT slip.held OR slip.reopened_at IS NOT NULL OR slip.contact_id <> inv.contact_id OR slip.location_id <> inv.location_id
     OR date_trunc('month', (slip.closed_at AT TIME ZONE inv.timezone))::date <> inv.month
     OR NOT EXISTS (SELECT 1 FROM business_document_lines l JOIN fuel_products f ON f.business_id = l.business_id AND f.sku_id = l.sku_id
       WHERE l.business_id = NEW.business_id AND l.id = (to_jsonb(NEW) ->> 'line_id')::bigint AND l.document_id = inv.document_id AND f.id = slip.product_id
         AND l.quantity = slip.litres AND l.net = slip.amount AND l.tax = 0) THEN
    RAISE EXCEPTION 'A month''s fleet invoice bills its customer''s fills held for that month at its outlet, each on a line of its own for its litres and money'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_month_invoices_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_month_invoices
  FOR EACH ROW EXECUTE FUNCTION fuel_month_invoices_check();
CREATE TRIGGER fuel_month_invoice_fills_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_month_invoice_fills
  FOR EACH ROW EXECUTE FUNCTION fuel_month_invoices_check();

-- Interest on a fleet customer's overdue credit, billed when someone confirms
-- it: the bill, the day it was worked out to, and the workings bill by bill.
CREATE TABLE fuel_fleet_interest (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  worked_to DATE NOT NULL,
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  rate NUMERIC(5,2) NOT NULL CHECK (rate > 0),
  workings JSONB NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX fuel_fleet_interest_contact ON fuel_fleet_interest(business_id, contact_id);

CREATE FUNCTION fuel_kept_as_written() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'fuel_inspections' THEN
    RAISE EXCEPTION 'An inspection is kept as it was written and never erased: add a later entry' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'fuel_stock_corrections' THEN
    RAISE EXCEPTION 'A correction of the stock is kept as it was posted' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'fuel_receipt_compartments' THEN
    RAISE EXCEPTION 'A tanker load''s compartments are kept as they were received' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'Interest billed is kept as it was billed' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER fuel_fleet_interest_kept BEFORE UPDATE OR DELETE ON fuel_fleet_interest
  FOR EACH ROW EXECUTE FUNCTION fuel_kept_as_written();

-- --- Tanker loads: allowances, compartments and samples ---------------------------------------------

-- The allowances on the invoice, in rupees a kilolitre: shrinkage (in
-- transit), and the temperature variation allowance (TVA, either way).
ALTER TABLE fuel_receipt_lines
  ADD COLUMN shrinkage_per_kl NUMERIC(10,2) CONSTRAINT fuel_receipt_lines_shrinkage CHECK (shrinkage_per_kl >= 0 AND shrinkage_per_kl <= 10000),
  ADD COLUMN tva_per_kl NUMERIC(10,2) CONSTRAINT fuel_receipt_lines_tva CHECK (abs(tva_per_kl) <= 10000);

-- Each compartment of a tanker load, as it was checked before decanting.
CREATE TABLE fuel_receipt_compartments (
  business_id BIGINT NOT NULL,
  receipt_id BIGINT NOT NULL,
  compartment_no SMALLINT NOT NULL CHECK (compartment_no BETWEEN 1 AND 12),
  -- The load's line (the tank) it was decanted into.
  seq SMALLINT NOT NULL,
  -- The dip read on the compartment (cm), the density (kg/m³) and temperature (°C) found.
  dip_cm NUMERIC(6,1) CHECK (dip_cm >= 0),
  density NUMERIC(6,1) CHECK (density BETWEEN 600 AND 1100),
  temperature NUMERIC(4,1) CHECK (temperature BETWEEN -20 AND 70),
  -- The water-finding paste: water found, and how much (cm).
  water_found BOOLEAN NOT NULL,
  water_cm NUMERIC(5,1) CHECK (water_cm >= 0),
  -- About 20 litres drawn from the compartment's manifold: its density and temperature.
  check_litres NUMERIC(7,3) CHECK (check_litres > 0 AND check_litres <= 100),
  check_density NUMERIC(6,1) CHECK (check_density BETWEEN 600 AND 1100),
  check_temperature NUMERIC(4,1) CHECK (check_temperature BETWEEN -20 AND 70),
  -- A short dip (water removed included), and what was made up through the pump.
  short_litres NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (short_litres >= 0),
  made_up_litres NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (made_up_litres >= 0),
  PRIMARY KEY (business_id, receipt_id, compartment_no),
  FOREIGN KEY (business_id, receipt_id, seq) REFERENCES fuel_receipt_lines(business_id, receipt_id, seq),
  CHECK (water_found OR water_cm IS NULL OR water_cm = 0),
  CHECK ((check_density IS NULL AND check_temperature IS NULL) OR check_litres IS NOT NULL),
  CHECK (made_up_litres <= short_litres)
);

-- A compartment is written with its load.
CREATE FUNCTION fuel_receipt_compartments_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fuel_receipts WHERE business_id = NEW.business_id AND id = NEW.receipt_id AND created_at = now()) THEN
    RAISE EXCEPTION 'A tanker load''s compartments are written with it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_receipt_compartments_check BEFORE INSERT ON fuel_receipt_compartments
  FOR EACH ROW EXECUTE FUNCTION fuel_receipt_compartments_check();
CREATE TRIGGER fuel_receipt_compartments_kept BEFORE UPDATE OR DELETE ON fuel_receipt_compartments
  FOR EACH ROW EXECUTE FUNCTION fuel_kept_as_written();

-- Retention samples of a load received, kept until two later loads of the
-- same fuel have come in at the outlet; then due for disposal.
CREATE TABLE fuel_samples (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  receipt_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL,
  product_id BIGINT NOT NULL,
  sample_no VARCHAR(40) NOT NULL CHECK (btrim(sample_no) <> ''),
  seal_no VARCHAR(40) NOT NULL CHECK (btrim(seal_no) <> ''),
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disposed_at TIMESTAMPTZ,
  disposed_by BIGINT REFERENCES users(id),
  disposal_note VARCHAR(300) CHECK (btrim(disposal_note) <> ''),
  FOREIGN KEY (business_id, receipt_id, seq) REFERENCES fuel_receipt_lines(business_id, receipt_id, seq),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, receipt_id, seq, sample_no),
  CHECK ((disposed_at IS NULL) = (disposed_by IS NULL))
);
CREATE INDEX fuel_samples_product ON fuel_samples(business_id, product_id) WHERE disposed_at IS NULL;

-- How many accepted loads of a fuel came in at an outlet after a load.
CREATE FUNCTION fuel_later_loads(target_business BIGINT, target_receipt BIGINT, target_product BIGINT) RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT r2.id)::int FROM fuel_receipts r JOIN fuel_receipts r2 ON r2.business_id = r.business_id AND r2.location_id = r.location_id
    AND r2.status = 'accepted' AND (r2.received_at, r2.id) > (r.received_at, r.id)
  JOIN fuel_receipt_lines l2 ON l2.business_id = r2.business_id AND l2.receipt_id = r2.id AND l2.product_id = target_product
  WHERE r.business_id = target_business AND r.id = target_receipt;
$$;

-- A sample is of a load accepted, of its tank's fuel; it keeps its numbers and
-- is never deleted; it is disposed of once, when two later loads have come.
CREATE FUNCTION fuel_samples_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A retention sample is never deleted: it is disposed of' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT l.product_id, r.status INTO line FROM fuel_receipt_lines l JOIN fuel_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
    WHERE l.business_id = NEW.business_id AND l.receipt_id = NEW.receipt_id AND l.seq = NEW.seq;
    IF line.status <> 'accepted' OR line.product_id <> NEW.product_id OR NEW.created_at <> now() OR NEW.disposed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A retention sample is of a load received, of its fuel, kept when it is written' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['disposed_at', 'disposed_by', 'disposal_note']) <> (to_jsonb(OLD) - ARRAY['disposed_at', 'disposed_by', 'disposal_note'])
     OR OLD.disposed_at IS NOT NULL OR NEW.disposed_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'Sample % keeps its numbers; it is disposed of once', OLD.sample_no USING ERRCODE = '23514';
  END IF;
  IF fuel_later_loads(NEW.business_id, NEW.receipt_id, NEW.product_id) < 2 THEN
    RAISE EXCEPTION 'Sample % is of one of the last two loads of its fuel: it is kept until two more have come in', OLD.sample_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_samples_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_samples
  FOR EACH ROW EXECUTE FUNCTION fuel_samples_check();

-- --- Dip charts, dips and the stock's corrections ---------------------------------------------------

-- A tank's calibration chart: what it holds (litres) at each dip (cm).
CREATE TABLE fuel_dip_charts (
  business_id BIGINT NOT NULL,
  tank_id BIGINT NOT NULL,
  dip_cm NUMERIC(7,1) NOT NULL CHECK (dip_cm >= 0),
  litres NUMERIC(12,3) NOT NULL CHECK (litres >= 0),
  PRIMARY KEY (business_id, tank_id, dip_cm),
  FOREIGN KEY (business_id, tank_id) REFERENCES fuel_tanks(business_id, id)
);

-- A dip's litres read off the tank's chart from the dip in cm.
ALTER TABLE fuel_dips ADD COLUMN from_chart BOOLEAN NOT NULL DEFAULT FALSE;

-- A day of a tank's stock register posted to the stock as a correction: the
-- gap between the next morning's dip and the stock by the meters and the
-- invoices (the variation, less the allowances taken in the book).
CREATE TABLE fuel_stock_corrections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  tank_id BIGINT NOT NULL,
  -- The register's day (its opening dip).
  day DATE NOT NULL,
  litres NUMERIC(12,3) NOT NULL CHECK (litres <> 0),
  variation NUMERIC(12,3) NOT NULL,
  allowance NUMERIC(12,3) NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  adjustment_id BIGINT NOT NULL,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id, tank_id) REFERENCES fuel_tanks(business_id, location_id, id),
  FOREIGN KEY (business_id, adjustment_id) REFERENCES business_stock_adjustments(business_id, id),
  UNIQUE (business_id, tank_id, day),
  UNIQUE (business_id, request_key),
  CHECK (litres = variation - allowance)
);
CREATE TRIGGER fuel_stock_corrections_kept BEFORE UPDATE OR DELETE ON fuel_stock_corrections
  FOR EACH ROW EXECUTE FUNCTION fuel_kept_as_written();

-- --- Records -----------------------------------------------------------------------------------

-- The outlet's inspections: when, by whom, what was found and what was done.
CREATE TABLE fuel_inspections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  inspected_on DATE NOT NULL,
  inspected_by VARCHAR(150) NOT NULL CHECK (btrim(inspected_by) <> ''),
  -- The oil company, Weights & Measures, PESO, the fire service … as typed.
  authority VARCHAR(150) CHECK (btrim(authority) <> ''),
  findings VARCHAR(2000) NOT NULL CHECK (btrim(findings) <> ''),
  actions VARCHAR(2000) CHECK (btrim(actions) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id)
);
CREATE INDEX fuel_inspections_period ON fuel_inspections(business_id, inspected_on DESC);
CREATE TRIGGER fuel_inspections_kept BEFORE UPDATE OR DELETE ON fuel_inspections
  FOR EACH ROW EXECUTE FUNCTION fuel_kept_as_written();

-- --- What only the fuel tools credit ---------------------------------------------------------

-- The fuel migration's rule as it was, and: a big fill's line is credited only
-- by reopening its shift; a fill billed on the month's invoice is not credited
-- on its own.
CREATE OR REPLACE FUNCTION fuel_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold RECORD; bought RECORD; billed RECORD;
BEGIN
  SELECT s.shift_no, c.reopened_at INTO sold FROM (
      SELECT close_id FROM fuel_close_products WHERE business_id = NEW.business_id AND line_id = NEW.line_id
      UNION ALL SELECT close_id FROM fuel_credit_slips WHERE business_id = NEW.business_id AND line_id = NEW.line_id
      UNION ALL SELECT close_id FROM fuel_close_big_fills WHERE business_id = NEW.business_id AND line_id = NEW.line_id) x
    JOIN fuel_shift_closes c ON c.business_id = NEW.business_id AND c.id = x.close_id
    JOIN fuel_shifts s ON s.business_id = c.business_id AND s.id = c.shift_id;
  IF FOUND AND sold.reopened_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'This line is fuel the meters sold on shift %: it is credited only by a manager reopening the shift', sold.shift_no USING ERRCODE = '23514';
  END IF;
  SELECT r.invoice_no, r.cancelled_at INTO bought FROM fuel_receipt_lines l JOIN fuel_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
  WHERE l.business_id = NEW.business_id AND l.line_id = NEW.line_id;
  IF FOUND AND bought.cancelled_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'This line is fuel received on tanker invoice %: it goes back only by a manager cancelling the receipt', bought.invoice_no USING ERRCODE = '23514';
  END IF;
  SELECT s.shift_no INTO billed FROM fuel_month_invoice_fills f JOIN fuel_credit_slips k ON k.business_id = f.business_id AND k.id = f.slip_id
    JOIN fuel_shifts s ON s.business_id = k.business_id AND s.id = k.shift_id
  WHERE f.business_id = NEW.business_id AND f.line_id = NEW.line_id;
  IF FOUND THEN
    RAISE EXCEPTION 'This line is a fleet fill of shift % billed on the month''s invoice: it is not credited on its own', billed.shift_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- A close adds up -------------------------------------------------------------------------

-- The fuel migration's check as it was, and: its big fills are bills of their
-- own; its cash drops and its count are the cash; its walk-in fuel bill is
-- paid the takings, then the cash (counted and dropped, less the big fills'
-- cash), then the attendant's account for what is still short; its other
-- sales' walk-in bill what is left of the takings, then of the cash, then the
-- attendant's account; and the attendant's short or excess is on their account.
CREATE OR REPLACE FUNCTION fuel_close_adds_up() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD; s RECORD; bad RECORD; zone TEXT; cash_paid NUMERIC; avail NUMERIC; goods RECORD; cash_goods NUMERIC;
BEGIN
  SELECT * INTO c FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.id;
  SELECT * INTO s FROM fuel_shifts WHERE business_id = c.business_id AND id = c.shift_id;
  SELECT n.nozzle_no INTO bad FROM fuel_shift_nozzles n WHERE n.business_id = c.business_id AND n.shift_id = c.shift_id
    AND NOT EXISTS (SELECT 1 FROM fuel_close_readings r WHERE r.business_id = n.business_id AND r.close_id = c.id AND r.nozzle_id = n.nozzle_id) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Shift % closes with a closing reading for nozzle %', s.shift_no, bad.nozzle_no USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM fuel_close_readings r WHERE r.business_id = c.business_id AND r.close_id = c.id
       AND NOT EXISTS (SELECT 1 FROM fuel_close_products p WHERE p.business_id = r.business_id AND p.close_id = r.close_id AND p.product_id = r.product_id))
     OR EXISTS (SELECT 1 FROM fuel_close_products p WHERE p.business_id = c.business_id AND p.close_id = c.id AND (
       p.litres <> (SELECT COALESCE(sum(r.litres), 0) FROM fuel_close_readings r WHERE r.business_id = p.business_id AND r.close_id = p.close_id AND r.product_id = p.product_id)
       OR p.credit_litres <> (SELECT COALESCE(sum(k.litres), 0) FROM fuel_credit_slips k WHERE k.business_id = p.business_id AND k.close_id = p.close_id AND k.product_id = p.product_id)
       OR p.credit_amount <> (SELECT COALESCE(sum(k.amount), 0) FROM fuel_credit_slips k WHERE k.business_id = p.business_id AND k.close_id = p.close_id AND k.product_id = p.product_id)
       OR p.big_litres <> (SELECT COALESCE(sum(g.litres), 0) FROM fuel_close_big_fills g WHERE g.business_id = p.business_id AND g.close_id = p.close_id AND g.product_id = p.product_id)
       OR p.big_amount <> (SELECT COALESCE(sum(g.amount), 0) FROM fuel_close_big_fills g WHERE g.business_id = p.business_id AND g.close_id = p.close_id AND g.product_id = p.product_id)))
     OR EXISTS (SELECT 1 FROM fuel_credit_slips k WHERE k.business_id = c.business_id AND k.close_id = c.id
       AND k.price IS DISTINCT FROM (SELECT p.price FROM fuel_close_products p WHERE p.business_id = k.business_id AND p.close_id = k.close_id AND p.product_id = k.product_id))
     OR EXISTS (SELECT 1 FROM fuel_close_big_fills g WHERE g.business_id = c.business_id AND g.close_id = c.id
       AND g.price IS DISTINCT FROM (SELECT p.price FROM fuel_close_products p WHERE p.business_id = g.business_id AND p.close_id = g.close_id AND p.product_id = g.product_id)) THEN
    RAISE EXCEPTION 'Shift %''s sales are its nozzles'' litres, and its credit fills'' litres and money, fuel by fuel', s.shift_no USING ERRCODE = '23514';
  END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = c.business_id;
  SELECT sk.label, p.price, fuel_price_at(c.business_id, s.location_id, p.product_id, s.opened_at) AS in_force,
      (SELECT min(x.effective_from) FROM fuel_prices x WHERE x.business_id = c.business_id AND x.location_id = s.location_id AND x.product_id = p.product_id
         AND x.effective_from > s.opened_at AND x.effective_from < c.closed_at) AS changed_at
    INTO bad
    FROM fuel_close_products p JOIN fuel_products f ON f.business_id = p.business_id AND f.id = p.product_id
    JOIN catalog_skus sk ON sk.business_id = f.business_id AND sk.id = f.sku_id
  WHERE p.business_id = c.business_id AND p.close_id = c.id
    AND (p.price IS DISTINCT FROM fuel_price_at(c.business_id, s.location_id, p.product_id, s.opened_at) OR EXISTS (
      SELECT 1 FROM fuel_prices x WHERE x.business_id = c.business_id AND x.location_id = s.location_id AND x.product_id = p.product_id
        AND x.effective_from > s.opened_at AND x.effective_from < c.closed_at))
  LIMIT 1;
  IF FOUND THEN
    IF bad.changed_at IS NOT NULL THEN
      RAISE EXCEPTION 'The price of % changed at %, while shift % was open: close it with the readings taken then, and open the next shift at the new price',
        bad.label, fuel_time_words(bad.changed_at, zone), s.shift_no USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Shift % sells % at the price in force when it opened', s.shift_no, bad.label USING ERRCODE = '23514';
  END IF;
  IF c.expected <> (SELECT COALESCE(sum(amount), 0) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id)
     OR c.credit <> (SELECT COALESCE(sum(amount), 0) FROM fuel_credit_slips WHERE business_id = c.business_id AND close_id = c.id)
     OR c.walk_in <> (SELECT COALESCE(sum(walk_in_amount), 0) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id)
     OR c.big <> (SELECT COALESCE(sum(amount), 0) FROM fuel_close_big_fills WHERE business_id = c.business_id AND close_id = c.id)
     OR c.other <> (SELECT COALESCE(sum(amount), 0) FROM fuel_close_payments WHERE business_id = c.business_id AND close_id = c.id) THEN
    RAISE EXCEPTION 'Shift %''s close adds up to its sales, its credit fills and its takings', s.shift_no USING ERRCODE = '23514';
  END IF;
  -- The cash: the drops of the shift, and the count when it was counted note by note.
  IF c.dropped <> (SELECT COALESCE(sum(amount), 0) FROM fuel_cash_drops WHERE business_id = c.business_id AND shift_id = c.shift_id AND cancelled_at IS NULL)
     OR (EXISTS (SELECT 1 FROM fuel_close_counts WHERE business_id = c.business_id AND close_id = c.id)
       AND c.cash <> (SELECT sum(denomination::numeric * pieces) FROM fuel_close_counts WHERE business_id = c.business_id AND close_id = c.id)) THEN
    RAISE EXCEPTION 'Shift %''s cash is its count of notes and coins, and its cash drops', s.shift_no USING ERRCODE = '23514';
  END IF;
  -- Each big fill: a bill of its own to no one by name, with the buyer's PAN or declaration, paid in full.
  IF EXISTS (SELECT 1 FROM fuel_close_big_fills g JOIN business_documents d ON d.business_id = g.business_id AND d.id = g.document_id
       WHERE g.business_id = c.business_id AND g.close_id = c.id AND (d.total <> g.amount OR (d.buyer_pan IS NULL AND NOT d.pan_declaration)
         OR (SELECT COALESCE(sum(p.amount), 0) FROM business_payments p WHERE p.business_id = d.business_id AND p.document_id = d.id) <> d.total
         OR (SELECT count(*) FROM business_document_lines l WHERE l.business_id = d.business_id AND l.document_id = d.id) <> 1))
     OR c.big_cash <> (SELECT COALESCE(sum(p.amount), 0) FROM fuel_close_big_fills g JOIN business_payments p ON p.business_id = g.business_id AND p.document_id = g.document_id
       AND p.method = 'cash' WHERE g.business_id = c.business_id AND g.close_id = c.id) THEN
    RAISE EXCEPTION 'Shift %''s fills of ₹2,00,000 or more are bills of their own, with the buyer''s PAN or declaration, paid in full', s.shift_no USING ERRCODE = '23514';
  END IF;
  avail := c.cash + c.dropped - c.big_cash;
  cash_paid := 0;
  IF (c.document_id IS NULL) <> NOT EXISTS (SELECT 1 FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id AND walk_in_litres > 0) THEN
    RAISE EXCEPTION 'Shift %''s walk-in sales are posted on a walk-in fuel bill', s.shift_no USING ERRCODE = '23514';
  END IF;
  IF c.document_id IS NOT NULL THEN
    cash_paid := LEAST(avail, c.walk_in - c.other);
    IF NOT EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = c.business_id AND d.id = c.document_id AND d.kind = 'sale' AND d.contact_id IS NULL
         AND d.location_id = s.location_id AND d.total = c.walk_in AND d.request_key = c.walk_in_key)
       OR (SELECT count(*) FROM business_document_lines WHERE business_id = c.business_id AND document_id = c.document_id)
          <> (SELECT count(*) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id AND line_id IS NOT NULL)
       OR COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = c.business_id AND document_id = c.document_id AND method = 'cash' AND created_at = c.created_at), 0)
          <> cash_paid
       OR (SELECT COALESCE(sum(amount), 0) FROM business_payments WHERE business_id = c.business_id AND document_id = c.document_id AND method NOT IN ('cash', 'credit_note')
          AND created_at = c.created_at) <> c.other
       OR (SELECT COALESCE(sum(amount), 0) FROM business_payments WHERE business_id = c.business_id AND document_id = c.document_id AND method = 'credit_note'
          AND created_at = c.created_at) <> c.walk_in - c.other - cash_paid THEN
      RAISE EXCEPTION 'Shift %''s walk-in fuel bill is its walk-in sales to no one by name, paid its takings, then the cash counted, then the attendant''s account', s.shift_no
        USING ERRCODE = '23514';
    END IF;
  ELSIF c.other > 0 THEN
    RAISE EXCEPTION 'Shift % sold nothing to walk-in buyers: it has no UPI, card or fleet-card takings', s.shift_no USING ERRCODE = '23514';
  END IF;
  -- The other sales' walk-in bill: what is left of the takings, then of the cash, then the attendant's account.
  SELECT d.id, d.total INTO goods FROM fuel_close_goods_bills g JOIN business_documents d ON d.business_id = g.business_id AND d.id = g.document_id
  WHERE g.business_id = c.business_id AND g.close_id = c.id AND g.walk_in;
  IF FOUND THEN
    cash_goods := LEAST(avail - cash_paid, c.goods_walk_in - c.goods_other);
    IF goods.total <> c.goods_walk_in
       OR COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = c.business_id AND document_id = goods.id AND method = 'cash'), 0) <> cash_goods
       OR COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = c.business_id AND document_id = goods.id AND method NOT IN ('cash', 'credit_note')), 0) <> c.goods_other
       OR COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = c.business_id AND document_id = goods.id AND method = 'credit_note'), 0)
          <> c.goods_walk_in - c.goods_other - cash_goods THEN
      RAISE EXCEPTION 'Shift %''s other sales'' walk-in bill is paid what is left of the takings, then of the cash, then the attendant''s account', s.shift_no USING ERRCODE = '23514';
    END IF;
  ELSIF c.goods_walk_in > 0 OR c.goods_other > 0 THEN
    RAISE EXCEPTION 'Shift %''s other sales to walk-in buyers are a GST invoice of their own', s.shift_no USING ERRCODE = '23514';
  END IF;
  IF c.goods_credit <> COALESCE((SELECT sum(d.total) FROM fuel_close_goods_bills g JOIN business_documents d ON d.business_id = g.business_id AND d.id = g.document_id
       WHERE g.business_id = c.business_id AND g.close_id = c.id AND NOT g.walk_in), 0) THEN
    RAISE EXCEPTION 'Shift %''s other sales on credit are its bills to its customers', s.shift_no USING ERRCODE = '23514';
  END IF;
  -- The attendant's short is due from them, and an excess held for them.
  IF COALESCE((SELECT sum(amount) FROM fuel_attendant_entries WHERE business_id = c.business_id AND close_id = c.id AND kind = 'short'), 0) <> GREATEST(0, -c.difference)
     OR COALESCE((SELECT sum(amount) FROM fuel_attendant_entries WHERE business_id = c.business_id AND close_id = c.id AND kind = 'excess'), 0) <> GREATEST(0, c.difference) THEN
    RAISE EXCEPTION 'Shift %''s short is due from its attendant, and an excess is held on their account', s.shift_no USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION fuel_close_adds_up() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD; s RECORD; bad RECORD; zone TEXT; cash_paid NUMERIC;
BEGIN
  SELECT * INTO c FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.id;
  SELECT * INTO s FROM fuel_shifts WHERE business_id = c.business_id AND id = c.shift_id;
  SELECT n.nozzle_no INTO bad FROM fuel_shift_nozzles n WHERE n.business_id = c.business_id AND n.shift_id = c.shift_id
    AND NOT EXISTS (SELECT 1 FROM fuel_close_readings r WHERE r.business_id = n.business_id AND r.close_id = c.id AND r.nozzle_id = n.nozzle_id) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Shift % closes with a closing reading for nozzle %', s.shift_no, bad.nozzle_no USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM fuel_close_readings r WHERE r.business_id = c.business_id AND r.close_id = c.id
       AND NOT EXISTS (SELECT 1 FROM fuel_close_products p WHERE p.business_id = r.business_id AND p.close_id = r.close_id AND p.product_id = r.product_id))
     OR EXISTS (SELECT 1 FROM fuel_close_products p WHERE p.business_id = c.business_id AND p.close_id = c.id AND (
       p.litres <> (SELECT COALESCE(sum(r.litres), 0) FROM fuel_close_readings r WHERE r.business_id = p.business_id AND r.close_id = p.close_id AND r.product_id = p.product_id)
       OR p.credit_litres <> (SELECT COALESCE(sum(k.litres), 0) FROM fuel_credit_slips k WHERE k.business_id = p.business_id AND k.close_id = p.close_id AND k.product_id = p.product_id)
       OR p.credit_amount <> (SELECT COALESCE(sum(k.amount), 0) FROM fuel_credit_slips k WHERE k.business_id = p.business_id AND k.close_id = p.close_id AND k.product_id = p.product_id)))
     OR EXISTS (SELECT 1 FROM fuel_credit_slips k WHERE k.business_id = c.business_id AND k.close_id = c.id
       AND k.price IS DISTINCT FROM (SELECT p.price FROM fuel_close_products p WHERE p.business_id = k.business_id AND p.close_id = k.close_id AND p.product_id = k.product_id)) THEN
    RAISE EXCEPTION 'Shift %''s sales are its nozzles'' litres, and its credit fills'' litres and money, fuel by fuel', s.shift_no USING ERRCODE = '23514';
  END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = c.business_id;
  SELECT sk.label, p.price, fuel_price_at(c.business_id, s.location_id, p.product_id, s.opened_at) AS in_force,
      (SELECT min(x.effective_from) FROM fuel_prices x WHERE x.business_id = c.business_id AND x.location_id = s.location_id AND x.product_id = p.product_id
         AND x.effective_from > s.opened_at AND x.effective_from < c.closed_at) AS changed_at
    INTO bad
    FROM fuel_close_products p JOIN fuel_products f ON f.business_id = p.business_id AND f.id = p.product_id
    JOIN catalog_skus sk ON sk.business_id = f.business_id AND sk.id = f.sku_id
  WHERE p.business_id = c.business_id AND p.close_id = c.id
    AND (p.price IS DISTINCT FROM fuel_price_at(c.business_id, s.location_id, p.product_id, s.opened_at) OR EXISTS (
      SELECT 1 FROM fuel_prices x WHERE x.business_id = c.business_id AND x.location_id = s.location_id AND x.product_id = p.product_id
        AND x.effective_from > s.opened_at AND x.effective_from < c.closed_at))
  LIMIT 1;
  IF FOUND THEN
    IF bad.changed_at IS NOT NULL THEN
      RAISE EXCEPTION 'The price of % changed at %, while shift % was open: close it with the readings taken then, and open the next shift at the new price',
        bad.label, fuel_time_words(bad.changed_at, zone), s.shift_no USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Shift % sells % at the price in force when it opened', s.shift_no, bad.label USING ERRCODE = '23514';
  END IF;
  IF c.expected <> (SELECT COALESCE(sum(amount), 0) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id)
     OR c.credit <> (SELECT COALESCE(sum(amount), 0) FROM fuel_credit_slips WHERE business_id = c.business_id AND close_id = c.id)
     OR c.walk_in <> (SELECT COALESCE(sum(walk_in_amount), 0) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id)
     OR c.other <> (SELECT COALESCE(sum(amount), 0) FROM fuel_close_payments WHERE business_id = c.business_id AND close_id = c.id) THEN
    RAISE EXCEPTION 'Shift %''s close adds up to its sales, its credit fills and its takings', s.shift_no USING ERRCODE = '23514';
  END IF;
  IF (c.document_id IS NULL) <> NOT EXISTS (SELECT 1 FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id AND walk_in_litres > 0) THEN
    RAISE EXCEPTION 'Shift %''s walk-in sales are posted on a walk-in fuel bill', s.shift_no USING ERRCODE = '23514';
  END IF;
  IF c.document_id IS NOT NULL THEN
    cash_paid := COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = c.business_id AND document_id = c.document_id AND method = 'cash' AND created_at = c.created_at), 0);
    IF NOT EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = c.business_id AND d.id = c.document_id AND d.kind = 'sale' AND d.contact_id IS NULL
         AND d.location_id = s.location_id AND d.total = c.walk_in AND d.request_key = c.walk_in_key)
       OR (SELECT count(*) FROM business_document_lines WHERE business_id = c.business_id AND document_id = c.document_id)
          <> (SELECT count(*) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id AND line_id IS NOT NULL)
       OR cash_paid <> LEAST(c.cash, c.walk_in - c.other)
       OR (SELECT COALESCE(sum(amount), 0) FROM business_payments WHERE business_id = c.business_id AND document_id = c.document_id AND method <> 'cash' AND created_at = c.created_at)
          <> c.other THEN
      RAISE EXCEPTION 'Shift %''s walk-in fuel bill is its walk-in sales to no one by name, paid its takings and then the cash counted', s.shift_no USING ERRCODE = '23514';
    END IF;
  ELSIF c.other > 0 THEN
    RAISE EXCEPTION 'Shift % sold nothing to walk-in buyers: it has no UPI, card or fleet-card takings', s.shift_no USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION fuel_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold RECORD; bought RECORD;
BEGIN
  SELECT s.shift_no, c.reopened_at INTO sold FROM (
      SELECT close_id FROM fuel_close_products WHERE business_id = NEW.business_id AND line_id = NEW.line_id
      UNION ALL SELECT close_id FROM fuel_credit_slips WHERE business_id = NEW.business_id AND line_id = NEW.line_id) x
    JOIN fuel_shift_closes c ON c.business_id = NEW.business_id AND c.id = x.close_id
    JOIN fuel_shifts s ON s.business_id = c.business_id AND s.id = c.shift_id;
  IF FOUND AND sold.reopened_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'This line is fuel the meters sold on shift %: it is credited only by a manager reopening the shift', sold.shift_no USING ERRCODE = '23514';
  END IF;
  SELECT r.invoice_no, r.cancelled_at INTO bought FROM fuel_receipt_lines l JOIN fuel_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
  WHERE l.business_id = NEW.business_id AND l.line_id = NEW.line_id;
  IF FOUND AND bought.cancelled_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'This line is fuel received on tanker invoice %: it goes back only by a manager cancelling the receipt', bought.invoice_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fuel_credit_slips_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fc RECORD; vehicle RECORD;
BEGIN
  SELECT * INTO fc FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.close_id;
  IF fc.created_at <> now() THEN
    RAISE EXCEPTION 'A shift''s credit fills are written with its close' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO vehicle FROM fuel_vehicles WHERE business_id = NEW.business_id AND id = NEW.vehicle_id;
  IF NOT vehicle.active OR NEW.registration <> vehicle.registration THEN
    RAISE EXCEPTION 'Vehicle % is not one of the customer''s vehicles in use', NEW.registration USING ERRCODE = '23514';
  END IF;
  IF vehicle.product_id IS NOT NULL AND vehicle.product_id <> NEW.product_id THEN
    RAISE EXCEPTION 'Vehicle % takes another fuel on credit', vehicle.registration USING ERRCODE = '23514';
  END IF;
  IF vehicle.fill_limit IS NOT NULL AND NEW.litres > vehicle.fill_limit AND NOT NEW.over_limit THEN
    RAISE EXCEPTION 'Vehicle % takes at most % litres in a fill on credit', vehicle.registration, vehicle.fill_limit USING ERRCODE = '23514';
  END IF;
  IF NEW.over_limit AND fc.approved_by IS NULL THEN
    RAISE EXCEPTION 'Credit over a limit is allowed by a manager' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
       JOIN fuel_products f ON f.business_id = l.business_id AND f.sku_id = l.sku_id
       WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id AND d.kind = 'sale' AND d.contact_id = NEW.contact_id
         AND f.id = NEW.product_id AND l.quantity = NEW.litres AND l.net = NEW.amount AND l.tax = 0) THEN
    RAISE EXCEPTION 'A credit fill is a line of its own on the shift''s fuel bill to the customer, for its litres and money' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TABLE fuel_inspections, fuel_stock_corrections, fuel_dip_charts, fuel_samples, fuel_receipt_compartments, fuel_fleet_interest, fuel_month_invoice_fills,
  fuel_month_invoices, fuel_attendant_entries, fuel_cash_drops, fuel_close_counts, fuel_close_goods_bills, fuel_close_big_fills, fuel_fleet_terms;
DROP FUNCTION fuel_samples_check();
DROP FUNCTION fuel_later_loads(BIGINT, BIGINT, BIGINT);
DROP FUNCTION fuel_receipt_compartments_check();
DROP FUNCTION fuel_kept_as_written();
DROP FUNCTION fuel_month_invoices_check();
DROP FUNCTION fuel_attendant_entries_check();
DROP FUNCTION fuel_attendant_balance(BIGINT, BIGINT);
DROP FUNCTION fuel_close_parts_check();
DROP FUNCTION fuel_cash_drops_check();
ALTER TABLE fuel_dips DROP COLUMN from_chart;
ALTER TABLE fuel_receipt_lines DROP COLUMN shrinkage_per_kl, DROP COLUMN tva_per_kl;
DROP INDEX fuel_credit_slips_book;
DROP INDEX fuel_credit_slips_held;
ALTER TABLE fuel_credit_slips DROP CONSTRAINT fuel_credit_slips_held, DROP CONSTRAINT fuel_credit_slips_serial, DROP CONSTRAINT fuel_credit_slips_book,
  DROP COLUMN held, DROP COLUMN book_id, DROP COLUMN serial;
ALTER TABLE fuel_credit_slips ALTER COLUMN document_id SET NOT NULL, ALTER COLUMN line_id SET NOT NULL;
DROP TABLE fuel_indent_books;
DROP FUNCTION fuel_indent_books_guard();
ALTER TABLE fuel_close_products DROP CONSTRAINT fuel_close_products_walk_in, DROP CONSTRAINT fuel_close_products_amount, DROP COLUMN big_litres, DROP COLUMN big_amount;
ALTER TABLE fuel_close_products ADD CHECK (walk_in_litres = litres - credit_litres), ADD CHECK (amount = credit_amount + walk_in_amount);
ALTER TABLE fuel_shift_closes DROP CONSTRAINT fuel_shift_closes_expected, DROP CONSTRAINT fuel_shift_closes_difference, DROP CONSTRAINT fuel_shift_closes_cash_covers,
  DROP COLUMN dropped, DROP COLUMN big, DROP COLUMN big_cash, DROP COLUMN goods_walk_in, DROP COLUMN goods_other, DROP COLUMN goods_credit;
ALTER TABLE fuel_shift_closes ADD CHECK (expected = credit + walk_in), ADD CHECK (difference = cash + other - walk_in);
ALTER TABLE fuel_settings DROP CONSTRAINT fuel_settings_interest_item, DROP COLUMN interest_sku_id, DROP COLUMN denominations;
