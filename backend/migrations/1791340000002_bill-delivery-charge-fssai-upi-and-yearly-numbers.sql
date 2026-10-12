-- Up Migration

-- Billing and payments build: what the bill itself carries.
--
-- 1. The delivery charge on the bill (sweep SW-B-05, bill side). The service
--    build works the charge out on the order (orders.delivery_charge, from
--    the sales channel's charge and its "free above"). The bill now carries
--    it as its own line, taxed with the food it brings: like service charge,
--    it is shared over the dishes and taxed at each dish's own GST rate, so
--    the GST return files it rate by rate and a dish returned gives back its
--    share. A manager may take it off one bill, with a reason.
--
-- 2. Each outlet's own FSSAI licence (sweep SW-B-06). A licence belongs to a
--    premises, so a branch's bill must print the branch's number. The number
--    printed is written on the bill when it is raised, so a reprint next year
--    prints the same number even if the licence is renewed under a new one.
--
-- 3. A UPI ID to print as a QR code with the exact amount (sweep SW-X-UPI),
--    for the restaurant and, where a branch banks on its own, per outlet.
--
-- 4. Invoice numbers that restart each financial year (sweep SW-B-19):
--    INV/26-27/0001 from 1 April by the business date, for the main counter,
--    each outlet and the credit notes. Bills already printed keep their
--    numbers; only new ones follow the choice.

ALTER TABLE bills
  -- The trip charged on this bill, before GST, and the GST on it (part of
  -- tax_amount, kept apart so the bill and the reports can show it).
  ADD COLUMN delivery_charge              NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
  ADD COLUMN delivery_charge_tax          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (delivery_charge_tax >= 0),
  -- Taken off this bill by a manager (or with one's PIN), and why.
  ADD COLUMN delivery_charge_waived       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN delivery_charge_waive_reason VARCHAR(200),
  ADD COLUMN delivery_charge_waived_by    BIGINT REFERENCES users(id),
  ADD COLUMN delivery_charge_approved_by  BIGINT REFERENCES users(id),
  -- The FSSAI licence printed on the bill when it was raised.
  ADD COLUMN seller_fssai                 VARCHAR(20),
  ADD CONSTRAINT chk_bills_delivery_waiver
    CHECK (NOT delivery_charge_waived OR delivery_charge_waive_reason IS NOT NULL);

ALTER TABLE bill_items
  -- The dish's share of the delivery charge, inside its taxable_value like
  -- its service_charge_share.
  ADD COLUMN delivery_charge_share NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE bill_taxes
  -- Of this rate's taxable value, the part that is delivery charge.
  ADD COLUMN delivery_charge_taxable NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (delivery_charge_taxable >= 0),
  -- A rate's taxable value is its dishes, its service charge and now its
  -- delivery charge: the old rule (dishes + service charge) is widened.
  DROP CONSTRAINT bill_taxes_check,
  ADD CONSTRAINT bill_taxes_check
    CHECK (taxable_value = items_taxable + service_charge_taxable + delivery_charge_taxable);

ALTER TABLE outlets
  -- FSSAI licences and registrations are 14 digits.
  ADD COLUMN fssai_number   VARCHAR(14) CHECK (fssai_number IS NULL OR fssai_number ~ '^[0-9]{14}$'),
  ADD COLUMN upi_vpa        VARCHAR(100),
  ADD COLUMN upi_payee_name VARCHAR(100);

ALTER TABLE restaurant_settings
  ADD COLUMN upi_vpa           VARCHAR(100),
  ADD COLUMN upi_payee_name    VARCHAR(100),
  -- 'continuous': INV-0001 onwards for ever (as every restaurant has had).
  -- 'financial_year': INV/26-27/0001, starting again each 1 April.
  ADD COLUMN invoice_numbering VARCHAR(20) NOT NULL DEFAULT 'continuous'
                               CHECK (invoice_numbering IN ('continuous', 'financial_year'));

-- Down Migration

ALTER TABLE restaurant_settings
  DROP COLUMN IF EXISTS invoice_numbering,
  DROP COLUMN IF EXISTS upi_payee_name,
  DROP COLUMN IF EXISTS upi_vpa;

ALTER TABLE outlets
  DROP COLUMN IF EXISTS upi_payee_name,
  DROP COLUMN IF EXISTS upi_vpa,
  DROP COLUMN IF EXISTS fssai_number;

-- Bills that carried a delivery charge fold it back into their dishes'
-- taxable value, so the old rule holds again.
UPDATE bill_taxes SET items_taxable = items_taxable + delivery_charge_taxable WHERE delivery_charge_taxable <> 0;
ALTER TABLE bill_taxes DROP CONSTRAINT bill_taxes_check;
ALTER TABLE bill_taxes DROP COLUMN IF EXISTS delivery_charge_taxable;
ALTER TABLE bill_taxes ADD CONSTRAINT bill_taxes_check CHECK (taxable_value = items_taxable + service_charge_taxable);
ALTER TABLE bill_items DROP COLUMN IF EXISTS delivery_charge_share;

ALTER TABLE bills
  DROP CONSTRAINT IF EXISTS chk_bills_delivery_waiver,
  DROP COLUMN IF EXISTS seller_fssai,
  DROP COLUMN IF EXISTS delivery_charge_approved_by,
  DROP COLUMN IF EXISTS delivery_charge_waived_by,
  DROP COLUMN IF EXISTS delivery_charge_waive_reason,
  DROP COLUMN IF EXISTS delivery_charge_waived,
  DROP COLUMN IF EXISTS delivery_charge_tax,
  DROP COLUMN IF EXISTS delivery_charge;
