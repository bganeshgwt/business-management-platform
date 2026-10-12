-- Up Migration

-- ===========================================================================
-- Billing: a GST tax invoice that adds up on paper, service charge that
-- follows the rules, discounts and complimentary bills given at the till,
-- credit notes for refunds, and bill numbers that survive a rush.
-- ===========================================================================

-- --- Bill numbers from a counter -------------------------------------------
-- A bill number used to be COUNT(*) + 1, worked out inside each bill. Two
-- tills billing in the same second counted the same rows, and the second was
-- refused by the unique number with "Internal server error". Each restaurant
-- now keeps the last number it handed out (document_counters, series BILL):
-- the first bill locks the row until it commits, the next waits a few
-- milliseconds and gets the next number. The count carries on from the
-- highest number already used, whatever the prefix was then.
-- Shared by billing and purchasing; create it before either seeds counters.
CREATE TABLE document_counters (
  restaurant_id BIGINT      NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  series        VARCHAR(10) NOT NULL,
  last_number   INTEGER     NOT NULL CHECK (last_number >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (restaurant_id, series)
);

INSERT INTO document_counters (restaurant_id, series, last_number)
SELECT b.restaurant_id, 'BILL',
       GREATEST(
         COUNT(*),
         COALESCE(MAX(NULLIF(SUBSTRING(b.bill_number FROM '(\d+)$'), '')::bigint), 0)
       )::int
FROM bills b
GROUP BY b.restaurant_id
ON CONFLICT (restaurant_id, series)
DO UPDATE SET last_number = GREATEST(document_counters.last_number, EXCLUDED.last_number);

-- --- Settings ----------------------------------------------------------------
-- Service charge is for table service. A parcel or a delivery guest got none,
-- so by default it is charged on dine-in only; a restaurant that also charges
-- it elsewhere ticks those order types. (Bills already raised keep what they
-- charged.)
ALTER TABLE restaurant_settings
  ADD COLUMN service_charge_order_types VARCHAR(20)[] NOT NULL DEFAULT ARRAY['dine_in']::VARCHAR(20)[]
      CONSTRAINT chk_settings_service_charge_types
      CHECK (service_charge_order_types <@ ARRAY['dine_in', 'takeaway', 'delivery', 'qr', 'online']::VARCHAR(20)[]);

-- One wrong word in Settings > Timezone ("India", "Asia/Kolkatta") made every
-- order fail, because pricing asks the database for the time there. And
-- "UTC+05:30" is read by the database the POSIX way, with the sign backwards,
-- so it quietly moved the clock 11 hours. A timezone must be a real place
-- name the database knows ("Asia/Kolkata"); anything else is refused here as
-- well as by the API, so nothing can save one that stops the till.
--
-- Any bad value already saved is put back to India's time first.
UPDATE restaurant_settings
SET timezone = 'Asia/Kolkata'
WHERE timezone NOT IN (SELECT name FROM pg_timezone_names)
   OR timezone !~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2})$'
   OR timezone ~ '^(Etc|posix|SystemV)/';

-- The settings row is read with an INSERT .. ON CONFLICT on every order, which
-- proposes the default zone; that one (and an unchanged zone) skips the
-- lookup, so the check costs nothing on the till's path.
CREATE OR REPLACE FUNCTION check_settings_timezone() RETURNS trigger AS $$
BEGIN
  IF NEW.timezone = 'Asia/Kolkata'
     OR (TG_OP = 'UPDATE' AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone) THEN
    RETURN NEW;
  END IF;

  IF NEW.timezone !~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2})$'
     OR NEW.timezone ~ '^(Etc|posix|SystemV)/'
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'The time zone "%" is not a place name the database knows, such as Asia/Kolkata', NEW.timezone
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_restaurant_settings_timezone
BEFORE INSERT OR UPDATE OF timezone ON restaurant_settings
FOR EACH ROW EXECUTE FUNCTION check_settings_timezone();

-- --- How much a role may take off a bill on its own ------------------------
-- Staff who may give a discount at the till (bills.discount) are capped per
-- role: a manager up to 15%, say, while the owner has no cap. Anyone going
-- over their cap needs someone whose cap covers it. A role with no row here
-- has no cap. System roles are shared by every restaurant, so the cap is per
-- restaurant and role.
CREATE TABLE till_discount_limits (
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role_id        BIGINT        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  max_percent    NUMERIC(5,2)  NOT NULL CHECK (max_percent >= 0 AND max_percent <= 100),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by     BIGINT        REFERENCES users(id),
  updated_by     BIGINT        REFERENCES users(id),
  PRIMARY KEY (restaurant_id, role_id)
);

CREATE TRIGGER trg_till_discount_limits_updated_at
BEFORE UPDATE ON till_discount_limits
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Cess, stamped on the order line ----------------------------------------
-- A tax rate could carry a cess %, but nothing ever charged it. The line now
-- keeps the cess its dish's rate had when it was ordered, the same way it
-- keeps the GST %, so a later change to the rate cannot re-price it. The
-- order code does not know about cess, so the database fills it in.
ALTER TABLE order_items
  ADD COLUMN cess_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
      CHECK (cess_percentage >= 0 AND cess_percentage <= 100);

CREATE OR REPLACE FUNCTION stamp_order_item_cess() RETURNS trigger AS $$
BEGIN
  IF NEW.product_id IS NOT NULL AND COALESCE(NEW.cess_percentage, 0) = 0 THEN
    SELECT COALESCE(t.cess_percentage, 0)
    INTO NEW.cess_percentage
    FROM products p
    LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
    WHERE p.id = NEW.product_id;

    NEW.cess_percentage := COALESCE(NEW.cess_percentage, 0);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_items_cess
BEFORE INSERT ON order_items
FOR EACH ROW EXECUTE FUNCTION stamp_order_item_cess();

-- Dishes still on a running order are billed with their rate's cess too.
UPDATE order_items oi
SET cess_percentage = t.cess_percentage
FROM products p
JOIN tax_rates t ON t.id = p.tax_rate_id
WHERE p.id = oi.product_id
  AND t.cess_percentage > 0
  AND oi.order_id IN (SELECT id FROM orders WHERE order_status = 'open');

-- --- A switched-off tax rate is not charged on anything --------------------
-- Switching a rate off used to leave its dishes selling at it. The API now
-- refuses to switch off a rate that dishes still use (the screen offers to
-- move them to another rate first). A rate already off with dishes on it is
-- in truth still being charged, so it is shown as what it is: on.
UPDATE tax_rates t
SET status = 'active'
WHERE t.status = 'inactive'
  AND EXISTS (SELECT 1 FROM products p WHERE p.tax_rate_id = t.id);

-- --- Bills --------------------------------------------------------------------
-- What a GST tax invoice has to show, kept on the bill as it was charged:
--
--   subtotal - discount_amount + service_charge = taxable_amount
--   taxable_amount + tax_amount + round_off     = total_amount
--
-- discount_amount is every discount together (coupon + till discount on the
-- bill + till discounts on dishes + points), each also kept on its own.
-- tax_amount is ALL tax: CGST + SGST on the dishes AND on the service charge,
-- plus any cess. Its parts: service_charge_tax (the GST on the service
-- charge) and cess_amount. The per-rate split is in bill_taxes.
ALTER TABLE bills
  ADD COLUMN coupon_discount          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (coupon_discount >= 0),
  -- A discount given at the till: a % or an amount off the whole bill.
  ADD COLUMN manual_discount_type     VARCHAR(12)
             CHECK (manual_discount_type IS NULL OR manual_discount_type IN ('percentage', 'amount')),
  ADD COLUMN manual_discount_value    NUMERIC(12,2) CHECK (manual_discount_value IS NULL OR manual_discount_value > 0),
  ADD COLUMN manual_discount_amount   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (manual_discount_amount >= 0),
  -- Till discounts on single dishes, added up (each is on its bill_items row).
  ADD COLUMN item_discount_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (item_discount_amount >= 0),
  -- Why a till discount was given, from the list on the screen, who gave it
  -- and the manager who approved it when the giver could not on their own.
  ADD COLUMN discount_reason          VARCHAR(30),
  ADD COLUMN discount_note            VARCHAR(200),
  ADD COLUMN discount_given_by        BIGINT REFERENCES users(id),
  ADD COLUMN discount_approved_by     BIGINT REFERENCES users(id),
  -- Service charge: the % charged (0 when not charged), the GST on it, and a
  -- guest's refusal with the reason.
  ADD COLUMN service_charge_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
             CHECK (service_charge_percentage >= 0 AND service_charge_percentage <= 100),
  ADD COLUMN service_charge_tax       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (service_charge_tax >= 0),
  ADD COLUMN service_charge_waived    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN service_charge_waive_reason VARCHAR(200),
  ADD COLUMN cess_amount              NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cess_amount >= 0),
  -- The value of supply GST is charged on: dishes after discount + service charge.
  ADD COLUMN taxable_amount           NUMERIC(14,2) CHECK (taxable_amount IS NULL OR taxable_amount >= 0),
  ADD COLUMN tax_mode                 VARCHAR(10) CHECK (tax_mode IS NULL OR tax_mode IN ('inclusive', 'exclusive')),
  -- A no-charge bill (staff meal, the owner's guest): every dish at 100% off,
  -- nothing to collect, and why.
  ADD COLUMN is_complimentary         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN complimentary_reason     VARCHAR(30),
  ADD COLUMN complimentary_note       VARCHAR(200),
  ADD COLUMN complimentary_by         BIGINT REFERENCES users(id),
  ADD COLUMN complimentary_approved_by BIGINT REFERENCES users(id),
  -- The GSTIN the invoice was issued under (the outlet's own, else the
  -- restaurant's), kept so a reprint next year shows the same number.
  ADD COLUMN seller_gstin             VARCHAR(15),
  -- Money given back against the sale by credit note. refunded_amount is all
  -- money given back, including a part payment handed back on a bill not yet
  -- settled (which the guest still owes).
  ADD COLUMN credited_amount          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credited_amount >= 0),
  ADD COLUMN first_printed_at         TIMESTAMPTZ,
  ADD COLUMN last_adjusted_at         TIMESTAMPTZ,
  ADD CONSTRAINT chk_bills_complimentary_reason
      CHECK (NOT is_complimentary OR complimentary_reason IS NOT NULL),
  ADD CONSTRAINT chk_bills_waive_reason
      CHECK (NOT service_charge_waived OR service_charge_waive_reason IS NOT NULL);

-- Bills raised before these columns: the coupon was everything that was not
-- points, the value of supply follows from the totals, and every refund given
-- so far was treated as money back against the sale.
UPDATE bills
SET coupon_discount = GREATEST(discount_amount - loyalty_discount, 0),
    taxable_amount = GREATEST(subtotal - discount_amount + service_charge, 0),
    credited_amount = refunded_amount,
    first_printed_at = CASE WHEN print_count > 0 THEN last_printed_at END;

-- "Bills of the 23rd", "the bill for 98480 12345": searched from the Bills screen.
CREATE INDEX idx_bills_restaurant_number ON bills (restaurant_id, bill_number);
CREATE INDEX idx_bills_order ON bills (order_id);

-- --- Bill lines -------------------------------------------------------------
-- line_subtotal / line_tax / line_total stay what the dish cost before any
-- bill discount. Added: the discount that fell on the line (its own till
-- discount plus its share of the bill's), its share of the service charge,
-- the value taxed and the tax charged on it, so HSN-wise GST adds up to the
-- invoice exactly.
ALTER TABLE bill_items
  ADD COLUMN item_discount_type   VARCHAR(12)
             CHECK (item_discount_type IS NULL OR item_discount_type IN ('percentage', 'amount')),
  ADD COLUMN item_discount_value  NUMERIC(12,2) CHECK (item_discount_value IS NULL OR item_discount_value > 0),
  ADD COLUMN item_discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (item_discount_amount >= 0),
  ADD COLUMN discount_amount      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN service_charge_share NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (service_charge_share >= 0),
  ADD COLUMN taxable_value        NUMERIC(14,2) CHECK (taxable_value IS NULL OR taxable_value >= 0),
  ADD COLUMN tax_percentage       NUMERIC(5,2),
  ADD COLUMN cess_percentage      NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount           NUMERIC(14,2) CHECK (tax_amount IS NULL OR tax_amount >= 0),
  ADD COLUMN cess_amount          NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cess_amount >= 0),
  ADD COLUMN hsn_code             VARCHAR(10),
  -- How much of the line has been returned by credit note.
  ADD COLUMN returned_quantity    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  ADD CONSTRAINT chk_bill_items_returned CHECK (returned_quantity <= quantity);

-- --- The invoice's tax, rate by rate -----------------------------------------
-- One row per GST rate (and cess) on the bill: the value taxed (dishes after
-- discount, and the share of service charge that falls on them), CGST and
-- SGST, and cess. CGST + SGST is exactly the GST at that rate (an odd paisa
-- goes to CGST), and the rows add up to the bill's own tax to the paisa. The
-- printed bill and the GST return read the same rows.
CREATE TABLE bill_taxes (
  id                      BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id           BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id                 BIGINT        NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  tax_percentage          NUMERIC(5,2)  NOT NULL CHECK (tax_percentage >= 0),
  cess_percentage         NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (cess_percentage >= 0),
  items_taxable           NUMERIC(14,2) NOT NULL CHECK (items_taxable >= 0),
  service_charge_taxable  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (service_charge_taxable >= 0),
  taxable_value           NUMERIC(14,2) NOT NULL CHECK (taxable_value >= 0),
  cgst_amount             NUMERIC(14,2) NOT NULL CHECK (cgst_amount >= 0),
  sgst_amount             NUMERIC(14,2) NOT NULL CHECK (sgst_amount >= 0),
  -- The part of CGST + SGST that is the service charge's.
  service_charge_tax      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (service_charge_tax >= 0),
  cess_amount             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cess_amount >= 0),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (bill_id, tax_percentage, cess_percentage),
  CHECK (taxable_value = items_taxable + service_charge_taxable)
);

CREATE INDEX idx_bill_taxes_restaurant ON bill_taxes (restaurant_id, bill_id);

-- --- Refunds: money back against the sale, or a payment handed back ---------
-- "credit_note": the guest is given money back for something wrong with the
-- sale (a complaint, a dish returned). A credit note is issued and the sale,
-- and its GST, go down. "payment_reversal": a part payment handed back on a
-- bill not yet settled (the wrong card charged); the sale is unchanged and the
-- guest still owes it. Every refund so far was the first kind.
ALTER TABLE refunds
  ADD COLUMN refund_kind VARCHAR(20) NOT NULL DEFAULT 'credit_note'
             CHECK (refund_kind IN ('credit_note', 'payment_reversal'));

-- --- Credit notes ---------------------------------------------------------------
-- The tax document for money given back against a sale: CN-0001, CN-0002...
-- from its own counter. It reverses the bill's value in the same proportions
-- the bill was charged (or, for dishes returned, those dishes' own value), so
-- the GST return can take it off the period it was issued in.
CREATE TABLE credit_notes (
  id                  BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outlet_id           BIGINT        REFERENCES outlets(id),
  business_day_id     BIGINT        REFERENCES business_days(id),
  bill_id             BIGINT        NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  refund_id           BIGINT        UNIQUE REFERENCES refunds(id) ON DELETE CASCADE,
  credit_note_number  VARCHAR(30)   NOT NULL,
  kind                VARCHAR(20)   NOT NULL CHECK (kind IN ('refund', 'return')),
  reason              VARCHAR(200)  NOT NULL,
  taxable_value       NUMERIC(14,2) NOT NULL CHECK (taxable_value >= 0),
  service_charge_value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (service_charge_value >= 0),
  tax_amount          NUMERIC(14,2) NOT NULL CHECK (tax_amount >= 0),
  cess_amount         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cess_amount >= 0),
  round_off           NUMERIC(6,2)  NOT NULL DEFAULT 0,
  total_amount        NUMERIC(14,2) NOT NULL CHECK (total_amount > 0),
  points_reversed     INTEGER       NOT NULL DEFAULT 0 CHECK (points_reversed >= 0),
  issued_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by          BIGINT        REFERENCES users(id),
  UNIQUE (restaurant_id, credit_note_number),
  CHECK (total_amount = taxable_value + tax_amount + round_off)
);

CREATE INDEX idx_credit_notes_restaurant ON credit_notes (restaurant_id, issued_at DESC);
CREATE INDEX idx_credit_notes_bill ON credit_notes (bill_id);
CREATE INDEX idx_credit_notes_day ON credit_notes (business_day_id);

CREATE TABLE credit_note_items (
  id               BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credit_note_id   BIGINT        NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  bill_item_id     BIGINT        NOT NULL REFERENCES bill_items(id),
  quantity         NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  taxable_value    NUMERIC(14,2) NOT NULL CHECK (taxable_value >= 0),
  tax_amount       NUMERIC(14,2) NOT NULL CHECK (tax_amount >= 0),
  amount           NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  UNIQUE (credit_note_id, bill_item_id)
);

CREATE TABLE credit_note_taxes (
  id                      BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id           BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  credit_note_id          BIGINT        NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  tax_percentage          NUMERIC(5,2)  NOT NULL CHECK (tax_percentage >= 0),
  cess_percentage         NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (cess_percentage >= 0),
  taxable_value           NUMERIC(14,2) NOT NULL CHECK (taxable_value >= 0),
  service_charge_taxable  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (service_charge_taxable >= 0),
  cgst_amount             NUMERIC(14,2) NOT NULL CHECK (cgst_amount >= 0),
  sgst_amount             NUMERIC(14,2) NOT NULL CHECK (sgst_amount >= 0),
  cess_amount             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cess_amount >= 0),
  UNIQUE (credit_note_id, tax_percentage, cess_percentage)
);

CREATE INDEX idx_credit_note_taxes_note ON credit_note_taxes (credit_note_id);

-- Down Migration

DROP TABLE IF EXISTS credit_note_taxes;
DROP TABLE IF EXISTS credit_note_items;
DROP TABLE IF EXISTS credit_notes;

ALTER TABLE refunds DROP COLUMN IF EXISTS refund_kind;

DROP TABLE IF EXISTS bill_taxes;

ALTER TABLE bill_items
  DROP CONSTRAINT IF EXISTS chk_bill_items_returned,
  DROP COLUMN IF EXISTS item_discount_type,
  DROP COLUMN IF EXISTS item_discount_value,
  DROP COLUMN IF EXISTS item_discount_amount,
  DROP COLUMN IF EXISTS discount_amount,
  DROP COLUMN IF EXISTS service_charge_share,
  DROP COLUMN IF EXISTS taxable_value,
  DROP COLUMN IF EXISTS tax_percentage,
  DROP COLUMN IF EXISTS cess_percentage,
  DROP COLUMN IF EXISTS tax_amount,
  DROP COLUMN IF EXISTS cess_amount,
  DROP COLUMN IF EXISTS hsn_code,
  DROP COLUMN IF EXISTS returned_quantity;

DROP INDEX IF EXISTS idx_bills_order;
DROP INDEX IF EXISTS idx_bills_restaurant_number;

ALTER TABLE bills
  DROP CONSTRAINT IF EXISTS chk_bills_complimentary_reason,
  DROP CONSTRAINT IF EXISTS chk_bills_waive_reason,
  DROP COLUMN IF EXISTS coupon_discount,
  DROP COLUMN IF EXISTS manual_discount_type,
  DROP COLUMN IF EXISTS manual_discount_value,
  DROP COLUMN IF EXISTS manual_discount_amount,
  DROP COLUMN IF EXISTS item_discount_amount,
  DROP COLUMN IF EXISTS discount_reason,
  DROP COLUMN IF EXISTS discount_note,
  DROP COLUMN IF EXISTS discount_given_by,
  DROP COLUMN IF EXISTS discount_approved_by,
  DROP COLUMN IF EXISTS service_charge_percentage,
  DROP COLUMN IF EXISTS service_charge_tax,
  DROP COLUMN IF EXISTS service_charge_waived,
  DROP COLUMN IF EXISTS service_charge_waive_reason,
  DROP COLUMN IF EXISTS cess_amount,
  DROP COLUMN IF EXISTS taxable_amount,
  DROP COLUMN IF EXISTS tax_mode,
  DROP COLUMN IF EXISTS is_complimentary,
  DROP COLUMN IF EXISTS complimentary_reason,
  DROP COLUMN IF EXISTS complimentary_note,
  DROP COLUMN IF EXISTS complimentary_by,
  DROP COLUMN IF EXISTS complimentary_approved_by,
  DROP COLUMN IF EXISTS seller_gstin,
  DROP COLUMN IF EXISTS credited_amount,
  DROP COLUMN IF EXISTS first_printed_at,
  DROP COLUMN IF EXISTS last_adjusted_at;

DROP TRIGGER IF EXISTS trg_order_items_cess ON order_items;
DROP FUNCTION IF EXISTS stamp_order_item_cess();
ALTER TABLE order_items DROP COLUMN IF EXISTS cess_percentage;

DROP TABLE IF EXISTS till_discount_limits;

DROP TRIGGER IF EXISTS trg_restaurant_settings_timezone ON restaurant_settings;
DROP FUNCTION IF EXISTS check_settings_timezone();

ALTER TABLE restaurant_settings
  DROP CONSTRAINT IF EXISTS chk_settings_service_charge_types,
  DROP COLUMN IF EXISTS service_charge_order_types;

DROP TABLE IF EXISTS document_counters;
