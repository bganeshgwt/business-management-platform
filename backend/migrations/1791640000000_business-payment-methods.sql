-- Up Migration

-- Payment methods the owner manages, per business (every type but the
-- restaurant, which has its own payment types). Until now the shop screens
-- offered a fixed list: cash, UPI, card, bank transfer, cheque. A shop now
-- names its own ("PhonePe", "Paytm", "Sodexo", "HDFC current account"), each
-- tied to one of those five fixed KINDS. The accounting (day close, drawer
-- cash, cheque register, change given back) keeps working on the kind; the
-- name is recorded next to it on each payment, refund and receipt so the day
-- close can say how much came in through PhonePe and how much through Paytm.

CREATE TABLE business_payment_methods (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(60) NOT NULL CHECK (btrim(name) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('cash', 'upi', 'card', 'bank', 'cheque')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX business_payment_methods_name ON business_payment_methods (business_id, lower(name));
CREATE INDEX business_payment_methods_list ON business_payment_methods (business_id, sort_order, id);

-- A business always keeps at least one method it can take money by: the
-- counter would otherwise have nothing to offer.
CREATE FUNCTION business_payment_method_keep_one() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active AND NOT NEW.active AND NOT EXISTS (
    SELECT 1 FROM business_payment_methods WHERE business_id = NEW.business_id AND id <> NEW.id AND active
  ) THEN
    RAISE EXCEPTION 'This is the last payment method switched on. Add or switch on another one first.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_payment_methods_keep_one BEFORE UPDATE OF active ON business_payment_methods
  FOR EACH ROW EXECUTE FUNCTION business_payment_method_keep_one();

-- The usual five, for every business (now and each new one). The restaurant
-- keeps its own payment types.
CREATE FUNCTION business_default_payment_methods() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_type <> 'restaurant' THEN
    INSERT INTO business_payment_methods (business_id, name, kind, sort_order)
    SELECT NEW.id, m.name, m.kind, m.sort_order
    FROM (VALUES ('Cash', 'cash', 10), ('UPI', 'upi', 20), ('Card', 'card', 30), ('Bank transfer', 'bank', 40), ('Cheque', 'cheque', 50)) AS m(name, kind, sort_order)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER businesses_default_payment_methods AFTER INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION business_default_payment_methods();
INSERT INTO business_payment_methods (business_id, name, kind, sort_order)
SELECT b.id, m.name, m.kind, m.sort_order FROM businesses b
CROSS JOIN (VALUES ('Cash', 'cash', 10), ('UPI', 'upi', 20), ('Card', 'card', 30), ('Bank transfer', 'bank', 40), ('Cheque', 'cheque', 50)) AS m(name, kind, sort_order)
WHERE b.business_type <> 'restaurant'
ORDER BY b.id, m.sort_order
ON CONFLICT DO NOTHING;

-- The method's name as it was when the money moved (a later rename does not
-- rewrite history). NULL: posted by an older screen with the kind only.
ALTER TABLE business_payments ADD COLUMN method_name VARCHAR(60);
ALTER TABLE business_refunds ADD COLUMN method_name VARCHAR(60);
ALTER TABLE business_collections ADD COLUMN method_name VARCHAR(60);
ALTER TABLE business_supplier_payments ADD COLUMN method_name VARCHAR(60);
ALTER TABLE business_collection_refunds ADD COLUMN method_name VARCHAR(60);

-- Down Migration

ALTER TABLE business_collection_refunds DROP COLUMN IF EXISTS method_name;
ALTER TABLE business_supplier_payments DROP COLUMN IF EXISTS method_name;
ALTER TABLE business_collections DROP COLUMN IF EXISTS method_name;
ALTER TABLE business_refunds DROP COLUMN IF EXISTS method_name;
ALTER TABLE business_payments DROP COLUMN IF EXISTS method_name;
DROP TRIGGER IF EXISTS businesses_default_payment_methods ON businesses;
DROP FUNCTION IF EXISTS business_default_payment_methods();
DROP TRIGGER IF EXISTS business_payment_methods_keep_one ON business_payment_methods;
DROP FUNCTION IF EXISTS business_payment_method_keep_one();
DROP TABLE IF EXISTS business_payment_methods;
