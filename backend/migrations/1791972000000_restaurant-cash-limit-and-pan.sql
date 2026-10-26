-- Up Migration
-- The two Income-tax rules the shared core keeps at every counter (migration
-- 1791960001000), for the restaurant's own bills, payments and advances.
-- Banquets, parties and caterers make bills over ₹2,00,000.
--
-- Cash limit (Income-tax Act 2025, section 186; section 269ST of the 1961 Act
-- until April 2026): nobody may receive ₹2,00,000 or more in cash from one
-- person in a day, or for one transaction, otherwise than through a bank. The
-- database refuses the payment, the correction to cash or the advance that
-- would reach that amount, whichever screen or path writes it:
--   - for one bill: the cash paid on it with any cash tip on top (cash the
--     guest hands over for that bill), and what it took from an advance the
--     guest paid in cash (cash received earlier, for this bill);
--   - from one guest on one day of the restaurant's calendar, in its time
--     zone: the cash paid on the bills that name them, with the tips, and
--     their advances taken in cash. A bill names the guest or company whose
--     account it is on (so cash collected on an account is theirs), else the
--     guest on its order. A payment from an advance is not counted again: its
--     cash was counted the day the advance was taken. A walk-in bill names
--     nobody, and is limited per bill only.
-- Payments by UPI, card or any other method are not limited.
--
-- PAN: a bill over ₹2,00,000 takes no payment until it records the buyer's
-- PAN, or that the buyer has none and a declaration (Form 97, formerly Form
-- 60) was taken. A B2B bill whose buyer's GSTIN carries a PAN records that PAN
-- with its first payment. A bill split in two is checked on each bill.
--
-- The triggers raise 23514 with a sentence for people, which the API answers
-- as 409.

ALTER TABLE bills
  ADD COLUMN buyer_pan CHAR(10) CHECK (buyer_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  ADD COLUMN pan_declaration BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT chk_bills_pan_or_declaration CHECK (NOT (pan_declaration AND buyer_pan IS NOT NULL));

-- --- What the limit counts ------------------------------------------------------------------

-- The cash received for one bill: its cash payments with their tips, and what
-- it took from advances paid in cash. A payment that failed brought nothing.
CREATE FUNCTION restaurant_bill_cash(target_bill BIGINT) RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(CASE WHEN p.payment_method = 'cash' THEN p.amount + p.tip_amount ELSE p.amount END), 0)
  FROM payments p
  LEFT JOIN customer_advances a ON a.id = p.advance_id
  WHERE p.bill_id = target_bill AND p.payment_status <> 'failed'
    AND (p.payment_method = 'cash' OR a.payment_method = 'cash');
$$;

-- The cash a restaurant received from one guest on one day of its calendar
-- (`zone` its time zone): cash paid on the bills that name them, with the
-- tips, and their advances taken in cash.
CREATE FUNCTION restaurant_cash_from_guest(target_restaurant BIGINT, target_customer BIGINT, zone TEXT, on_day DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT sum(p.amount + p.tip_amount) FROM payments p
      JOIN bills b ON b.id = p.bill_id
      JOIN orders o ON o.id = b.order_id
      WHERE p.restaurant_id = target_restaurant AND p.payment_method = 'cash' AND p.payment_status <> 'failed'
        AND COALESCE(b.account_customer_id, o.customer_id) = target_customer
        AND p.paid_at >= on_day::timestamp AT TIME ZONE zone AND p.paid_at < (on_day + 1)::timestamp AT TIME ZONE zone), 0)
   + COALESCE((SELECT sum(a.amount) FROM customer_advances a
      WHERE a.restaurant_id = target_restaurant AND a.customer_id = target_customer AND a.payment_method = 'cash'
        AND a.received_at >= on_day::timestamp AT TIME ZONE zone AND a.received_at < (on_day + 1)::timestamp AT TIME ZONE zone), 0);
$$;

-- Refuses cash (`adds`, received at `received`) that would take one guest's
-- cash on that day of the restaurant's calendar to ₹2,00,000.
CREATE FUNCTION restaurant_guest_cash_check(target_restaurant BIGINT, target_customer BIGINT, received TIMESTAMPTZ, adds NUMERIC)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  zone TEXT;
  on_day DATE;
  from_guest NUMERIC;
  guest TEXT;
BEGIN
  SELECT timezone INTO zone FROM restaurant_settings WHERE restaurant_id = target_restaurant;
  zone := COALESCE(zone, 'Asia/Kolkata');
  on_day := (received AT TIME ZONE zone)::date;
  from_guest := restaurant_cash_from_guest(target_restaurant, target_customer, zone, on_day) + adds;
  IF from_guest >= 200000 THEN
    SELECT COALESCE(NULLIF(BTRIM(company_name), ''), name) INTO guest FROM customers WHERE id = target_customer;
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one guest in a day (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      CASE WHEN on_day = (now() AT TIME ZONE zone)::date THEN 'today''s cash from ' ELSE 'the cash on ' || to_char(on_day, 'FMDD Mon YYYY') || ' from ' END
        || COALESCE(guest, 'this guest'),
      from_guest::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
END $$;

-- --- Payments ---------------------------------------------------------------------------------

-- A bill over ₹2,00,000 takes a payment only with the buyer's PAN or their
-- declaration on it. The PAN inside a B2B buyer's GSTIN is written on the
-- bill here, so the bill keeps the PAN it was paid under.
CREATE FUNCTION restaurant_pan_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill RECORD;
  from_gstin TEXT;
BEGIN
  IF NEW.payment_status = 'failed' THEN
    RETURN NEW;
  END IF;
  SELECT b.bill_number, b.total_amount, b.buyer_pan, b.pan_declaration INTO bill FROM bills b WHERE b.id = NEW.bill_id;
  IF bill.total_amount <= 200000 OR bill.buyer_pan IS NOT NULL OR bill.pan_declaration THEN
    RETURN NEW;
  END IF;
  SELECT substr(r.gstin, 3, 10) INTO from_gstin FROM bill_gst_recipients r WHERE r.bill_id = NEW.bill_id;
  IF from_gstin ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
    UPDATE bills SET buyer_pan = from_gstin WHERE id = NEW.bill_id;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A bill over ₹2,00,000 needs the buyer''s PAN before it takes a payment: % has none. Type it on the bill, or put the buyer''s GSTIN on it. A buyer who has no PAN signs a declaration (Form 97): record it on the bill instead.',
    bill.bill_number USING ERRCODE = '23514';
END $$;

CREATE TRIGGER trg_payments_buyer_pan BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION restaurant_pan_payment();

-- The cash limit on a payment taken, or on one whose method is corrected: a
-- change counts only the cash it adds.
CREATE FUNCTION restaurant_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill RECORD;
  to_bill NUMERIC := 0;
  to_guest NUMERIC := 0;
  on_bill NUMERIC;
BEGIN
  -- Cash with its tip comes to the bill and to the guest's day; a payment
  -- from an advance paid in cash comes to the bill only.
  IF NEW.payment_status <> 'failed' THEN
    IF NEW.payment_method = 'cash' THEN
      to_bill := NEW.amount + NEW.tip_amount;
      to_guest := to_bill;
    ELSIF NEW.payment_method = 'advance' AND EXISTS (SELECT 1 FROM customer_advances WHERE id = NEW.advance_id AND payment_method = 'cash') THEN
      to_bill := NEW.amount;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.payment_status <> 'failed' THEN
    IF OLD.payment_method = 'cash' THEN
      to_bill := to_bill - (OLD.amount + OLD.tip_amount);
      to_guest := to_guest - (OLD.amount + OLD.tip_amount);
    ELSIF OLD.payment_method = 'advance' AND EXISTS (SELECT 1 FROM customer_advances WHERE id = OLD.advance_id AND payment_method = 'cash') THEN
      to_bill := to_bill - OLD.amount;
    END IF;
  END IF;
  IF to_bill <= 0 AND to_guest <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT b.bill_number, COALESCE(b.account_customer_id, o.customer_id) AS guest_id INTO bill
  FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.id = NEW.bill_id;
  IF to_bill > 0 THEN
    on_bill := restaurant_bill_cash(NEW.bill_id) + to_bill;
    IF on_bill >= 200000 THEN
      RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
        bill.bill_number, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  -- A walk-in bill names no guest: it is limited per bill only.
  IF to_guest > 0 AND bill.guest_id IS NOT NULL THEN
    PERFORM restaurant_guest_cash_check(NEW.restaurant_id, bill.guest_id, NEW.paid_at, to_guest);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_payments_cash_limit BEFORE INSERT OR UPDATE OF payment_method, amount, tip_amount, advance_id, payment_status ON payments
  FOR EACH ROW EXECUTE FUNCTION restaurant_cash_limit_payment();

-- --- Advances ---------------------------------------------------------------------------------

-- An advance taken in cash counts on the day it is received. Merging two
-- records of one guest moves their advances without counting them again.
CREATE FUNCTION restaurant_cash_limit_advance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  adds NUMERIC := 0;
BEGIN
  IF NEW.payment_method = 'cash' THEN
    adds := NEW.amount;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.payment_method = 'cash' THEN
    adds := adds - OLD.amount;
  END IF;
  IF adds > 0 THEN
    PERFORM restaurant_guest_cash_check(NEW.restaurant_id, NEW.customer_id, NEW.received_at, adds);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_customer_advances_cash_limit BEFORE INSERT OR UPDATE OF payment_method, amount ON customer_advances
  FOR EACH ROW EXECUTE FUNCTION restaurant_cash_limit_advance();

-- Down Migration
DROP TRIGGER trg_customer_advances_cash_limit ON customer_advances;
DROP FUNCTION restaurant_cash_limit_advance();
DROP TRIGGER trg_payments_cash_limit ON payments;
DROP FUNCTION restaurant_cash_limit_payment();
DROP TRIGGER trg_payments_buyer_pan ON payments;
DROP FUNCTION restaurant_pan_payment();
DROP FUNCTION restaurant_guest_cash_check(BIGINT, BIGINT, TIMESTAMPTZ, NUMERIC);
DROP FUNCTION restaurant_cash_from_guest(BIGINT, BIGINT, TEXT, DATE);
DROP FUNCTION restaurant_bill_cash(BIGINT);
ALTER TABLE bills
  DROP CONSTRAINT chk_bills_pan_or_declaration,
  DROP COLUMN pan_declaration,
  DROP COLUMN buyer_pan;
