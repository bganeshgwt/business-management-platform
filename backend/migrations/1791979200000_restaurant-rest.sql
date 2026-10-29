-- Up Migration
-- What is left inside the restaurant: the guest book keeps a PAN, cash under
-- one PAN adds up for the cash limit, a dish is served from the floor on its
-- own, and courses have names.
--
-- The guest's PAN. A guest in the guest book keeps their PAN, or the fact
-- that they declared they have none (Form 97), checked as a bill's is. A bill
-- over ₹2,00,000 that names the guest takes the guest's PAN with its first
-- payment, as it takes the PAN inside a buyer's GSTIN, so the cashier does not
-- type it again; a PAN typed on the bill comes first. A declaration is made
-- for each purchase, so the guest book's only reminds the cashier to take one.
--
-- Cash under one PAN (Income-tax Act 2025, section 186). The cash a person
-- hands over in a day of the restaurant's calendar counts as one: the cash on
-- the bills that name a guest and their advances in cash, as before, and now
-- also the cash on walk-in bills (naming no guest) that carry the same PAN,
-- and the cash of every guest whose guest book holds that PAN. A walk-in bill
-- with no PAN is still limited per bill only. restaurant_cash_from_guest,
-- restaurant_cash_limit_payment and restaurant_pan_payment are replaced from
-- their bodies in 1791972000000; the Down restores those bodies.
--
-- Serving dish by dish. A dish the kitchen has ticked done on a ticket still
-- cooking is served from the floor on its own (kot_items.served_at,
-- served_by); serving the last dish serves the ticket.
--
-- Named courses. The captain app sends dishes by course, named from the
-- restaurant's own short list (service_settings.course_names, Starters,
-- Mains and Desserts to start), and the KOT shows the name its dishes were
-- sent under (kot_items.course_name). Course numbers stay underneath: the
-- first name is course 1.

-- --- The guest's PAN --------------------------------------------------------------------------

ALTER TABLE customers
  ADD COLUMN pan CHAR(10) CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  ADD COLUMN pan_declaration BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT chk_customers_pan_or_declaration CHECK (NOT (pan_declaration AND pan IS NOT NULL));

CREATE INDEX idx_customers_pan ON customers (restaurant_id, pan) WHERE pan IS NOT NULL;

-- Walk-in bills found by the PAN they carry, for the cash limit.
CREATE INDEX idx_bills_buyer_pan ON bills (restaurant_id, buyer_pan) WHERE buyer_pan IS NOT NULL;

-- --- What the cash limit counts ----------------------------------------------------------------

-- The cash a restaurant received from one person on one day of its calendar
-- (`zone` its time zone): the guest `target_customer` and every guest whose
-- guest book holds `target_pan`, with the cash on the bills that name them
-- (their tips too) and their advances taken in cash; and the cash on walk-in
-- bills that carry `target_pan`. Either may be NULL.
CREATE FUNCTION restaurant_cash_from_person(target_restaurant BIGINT, target_customer BIGINT, target_pan TEXT, zone TEXT, on_day DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  WITH guests AS (
    SELECT target_customer AS id WHERE target_customer IS NOT NULL
    UNION
    SELECT c.id FROM customers c WHERE target_pan IS NOT NULL AND c.restaurant_id = target_restaurant AND c.pan = target_pan::CHAR(10)
  )
  SELECT COALESCE((SELECT sum(p.amount + p.tip_amount) FROM payments p
      JOIN bills b ON b.id = p.bill_id
      JOIN orders o ON o.id = b.order_id
      WHERE p.restaurant_id = target_restaurant AND p.payment_method = 'cash' AND p.payment_status <> 'failed'
        AND p.paid_at >= on_day::timestamp AT TIME ZONE zone AND p.paid_at < (on_day + 1)::timestamp AT TIME ZONE zone
        AND (COALESCE(b.account_customer_id, o.customer_id) IN (SELECT id FROM guests)
             OR (target_pan IS NOT NULL AND COALESCE(b.account_customer_id, o.customer_id) IS NULL AND b.buyer_pan = target_pan::CHAR(10)))), 0)
   + COALESCE((SELECT sum(a.amount) FROM customer_advances a
      WHERE a.restaurant_id = target_restaurant AND a.customer_id IN (SELECT id FROM guests) AND a.payment_method = 'cash'
        AND a.received_at >= on_day::timestamp AT TIME ZONE zone AND a.received_at < (on_day + 1)::timestamp AT TIME ZONE zone), 0);
$$;

-- One guest's cash on a day: theirs, and everything under the PAN their guest
-- book holds.
CREATE OR REPLACE FUNCTION restaurant_cash_from_guest(target_restaurant BIGINT, target_customer BIGINT, zone TEXT, on_day DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT restaurant_cash_from_person(target_restaurant, target_customer,
    (SELECT c.pan FROM customers c WHERE c.id = target_customer), zone, on_day);
$$;

-- Refuses cash (`adds`, received at `received`) that would take the cash
-- under one PAN on that day of the restaurant's calendar to ₹2,00,000. The
-- sentence shows the PAN's last four characters only.
CREATE FUNCTION restaurant_pan_cash_check(target_restaurant BIGINT, target_pan TEXT, received TIMESTAMPTZ, adds NUMERIC)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  zone TEXT;
  on_day DATE;
  from_person NUMERIC;
BEGIN
  SELECT timezone INTO zone FROM restaurant_settings WHERE restaurant_id = target_restaurant;
  zone := COALESCE(zone, 'Asia/Kolkata');
  on_day := (received AT TIME ZONE zone)::date;
  from_person := restaurant_cash_from_person(target_restaurant, NULL, target_pan, zone, on_day) + adds;
  IF from_person >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one person in a day (Income-tax Act 2025, section 186): % the buyer with PAN ending % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      CASE WHEN on_day = (now() AT TIME ZONE zone)::date THEN 'today''s cash from' ELSE 'the cash on ' || to_char(on_day, 'FMDD Mon YYYY') || ' from' END,
      right(target_pan, 4), from_person::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
END $$;

-- --- Payments ---------------------------------------------------------------------------------

-- A bill over ₹2,00,000 takes a payment only with the buyer's PAN or their
-- declaration on it. The PAN inside a B2B buyer's GSTIN, else the PAN the
-- guest book holds for the guest the bill names, is written on the bill here,
-- so the bill keeps the PAN it was paid under.
CREATE OR REPLACE FUNCTION restaurant_pan_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill RECORD;
  from_gstin TEXT;
  from_guest TEXT;
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
  SELECT c.pan INTO from_guest FROM bills b JOIN orders o ON o.id = b.order_id
    JOIN customers c ON c.id = COALESCE(b.account_customer_id, o.customer_id)
    WHERE b.id = NEW.bill_id;
  IF from_guest IS NOT NULL THEN
    UPDATE bills SET buyer_pan = from_guest WHERE id = NEW.bill_id;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A bill over ₹2,00,000 needs the buyer''s PAN before it takes a payment: % has none. Type it on the bill, or put the buyer''s GSTIN on it. A buyer who has no PAN signs a declaration (Form 97): record it on the bill instead.',
    bill.bill_number USING ERRCODE = '23514';
END $$;

-- The cash limit on a payment taken, or on one whose method is corrected: a
-- change counts only the cash it adds.
CREATE OR REPLACE FUNCTION restaurant_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
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
  SELECT b.bill_number, b.buyer_pan, COALESCE(b.account_customer_id, o.customer_id) AS guest_id INTO bill
  FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.id = NEW.bill_id;
  IF to_bill > 0 THEN
    on_bill := restaurant_bill_cash(NEW.bill_id) + to_bill;
    IF on_bill >= 200000 THEN
      RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
        bill.bill_number, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  -- A walk-in bill names no guest: with the buyer's PAN on it, its cash adds
  -- up with the rest under that PAN that day; without, it is limited per bill
  -- only.
  IF to_guest > 0 AND bill.guest_id IS NOT NULL THEN
    PERFORM restaurant_guest_cash_check(NEW.restaurant_id, bill.guest_id, NEW.paid_at, to_guest);
  ELSIF to_guest > 0 AND bill.buyer_pan IS NOT NULL THEN
    PERFORM restaurant_pan_cash_check(NEW.restaurant_id, bill.buyer_pan, NEW.paid_at, to_guest);
  END IF;
  RETURN NEW;
END $$;

-- --- Serving dish by dish, and the course on the KOT -------------------------------------------

ALTER TABLE kot_items
  ADD COLUMN served_at TIMESTAMPTZ,
  ADD COLUMN served_by BIGINT REFERENCES users(id),
  ADD COLUMN course_name VARCHAR(60),
  ADD CONSTRAINT chk_kot_items_served_done CHECK (served_at IS NULL OR is_done);

-- --- Named courses ----------------------------------------------------------------------------

ALTER TABLE service_settings
  ADD COLUMN course_names TEXT[] NOT NULL DEFAULT ARRAY['Starters', 'Mains', 'Desserts']::TEXT[]
    CHECK (cardinality(course_names) BETWEEN 1 AND 6 AND array_position(course_names, NULL) IS NULL);

-- Down Migration
ALTER TABLE service_settings DROP COLUMN course_names;

ALTER TABLE kot_items
  DROP CONSTRAINT chk_kot_items_served_done,
  DROP COLUMN course_name,
  DROP COLUMN served_by,
  DROP COLUMN served_at;

CREATE OR REPLACE FUNCTION restaurant_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION restaurant_pan_payment() RETURNS trigger LANGUAGE plpgsql AS $$
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

DROP FUNCTION restaurant_pan_cash_check(BIGINT, TEXT, TIMESTAMPTZ, NUMERIC);

CREATE OR REPLACE FUNCTION restaurant_cash_from_guest(target_restaurant BIGINT, target_customer BIGINT, zone TEXT, on_day DATE)
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

DROP FUNCTION restaurant_cash_from_person(BIGINT, BIGINT, TEXT, TEXT, DATE);

DROP INDEX idx_bills_buyer_pan;
DROP INDEX idx_customers_pan;

ALTER TABLE customers
  DROP CONSTRAINT chk_customers_pan_or_declaration,
  DROP COLUMN pan_declaration,
  DROP COLUMN pan;
