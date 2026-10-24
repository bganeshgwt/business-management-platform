-- Up Migration
-- Two rules of the Income-tax Act 2025 that every business follows at the
-- counter.
--
-- Cash limit (section 186; section 269ST of the 1961 Act until April 2026):
-- nobody may receive ₹2,00,000 or more in cash from one person in a day, or
-- for one transaction, otherwise than through a bank. The database refuses
-- the cash payment or collection receipt that would reach that amount: for
-- one bill (every cash payment on it, whenever paid), and from one customer
-- in one business day (cash on their bills and their collection receipts).
-- Payments by UPI, card, bank transfer or cheque are not limited.
--
-- PAN: a sale over ₹2,00,000 records the buyer's PAN (the API takes it from
-- the bill, the customer, or the customer's GSTIN, which contains it), or
-- that the buyer has none and a declaration (Form 97, formerly Form 60) was
-- taken. A customer's PAN can be kept with the customer.

ALTER TABLE business_contacts
  ADD COLUMN pan CHAR(10) CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

ALTER TABLE business_documents
  ADD COLUMN buyer_pan CHAR(10) CHECK (buyer_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  ADD COLUMN pan_declaration BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT business_documents_pan_or_declaration CHECK (NOT (pan_declaration AND buyer_pan IS NOT NULL));

-- Cash received from one customer on one business day: cash paid on their
-- sales (not through a collection receipt, which is counted itself) and their
-- cash collection receipts.
CREATE FUNCTION business_cash_from_customer(target_business BIGINT, target_contact BIGINT, zone TEXT, on_day DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT sum(p.amount) FROM business_payments p
      JOIN business_documents d ON d.business_id = p.business_id AND d.id = p.document_id
      WHERE p.business_id = target_business AND d.contact_id = target_contact AND d.kind = 'sale'
        AND p.method = 'cash' AND p.collection_id IS NULL AND (p.created_at AT TIME ZONE zone)::date = on_day), 0)
   + COALESCE((SELECT sum(k.amount) FROM business_collections k
      WHERE k.business_id = target_business AND k.contact_id = target_contact
        AND k.method = 'cash' AND (k.created_at AT TIME ZONE zone)::date = on_day), 0);
$$;

CREATE FUNCTION business_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc RECORD;
  zone TEXT;
  on_bill NUMERIC;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT d.kind, d.contact_id, d.document_no INTO doc FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_bill FROM business_payments
  WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND method = 'cash';
  IF on_bill >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      doc.document_no, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  -- A collection receipt's own cash was counted when the receipt was taken.
  IF doc.contact_id IS NOT NULL AND NEW.collection_id IS NULL THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    from_customer := business_cash_from_customer(NEW.business_id, doc.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
    IF from_customer >= 200000 THEN
      RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186): today''s cash from this customer would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
        from_customer::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER business_payments_cash_limit BEFORE INSERT ON business_payments
FOR EACH ROW EXECUTE FUNCTION business_cash_limit_payment();

CREATE FUNCTION business_cash_limit_collection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zone TEXT;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  from_customer := business_cash_from_customer(NEW.business_id, NEW.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
  IF from_customer >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186): today''s cash from this customer would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      from_customer::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER business_collections_cash_limit BEFORE INSERT ON business_collections
FOR EACH ROW EXECUTE FUNCTION business_cash_limit_collection();

-- Down Migration
DROP TRIGGER business_collections_cash_limit ON business_collections;
DROP FUNCTION business_cash_limit_collection();
DROP TRIGGER business_payments_cash_limit ON business_payments;
DROP FUNCTION business_cash_limit_payment();
DROP FUNCTION business_cash_from_customer(BIGINT, BIGINT, TEXT, DATE);
ALTER TABLE business_documents
  DROP CONSTRAINT business_documents_pan_or_declaration,
  DROP COLUMN pan_declaration,
  DROP COLUMN buyer_pan;
ALTER TABLE business_contacts DROP COLUMN pan;
