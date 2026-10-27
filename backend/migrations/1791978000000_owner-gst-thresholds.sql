-- Up Migration
-- An owner's GST thresholds across the businesses under one PAN.
--
-- What applies to a taxpayer's invoices follows its aggregate turnover:
-- e-invoicing and 6-digit HSN / SAC codes above ₹5 crore, and from 1 April
-- 2025 the 30-day limit for reporting an invoice or a credit note to the IRP
-- at ₹10 crore or more. The researchers read aggregate turnover as counting
-- every GSTIN under one PAN, exempt and non-taxable supplies (a fuel
-- station's petrol and diesel) included; an accountant has still to check
-- that reading. Several small businesses of one owner can then cross ₹5 crore
-- together, which only a platform holding all of them can see coming. The
-- owner's view adds up each PAN's turnover for the financial year from every
-- business's own records, on its own clock, and the owner and the bell of each
-- of those businesses are warned before each threshold. Nothing here files or
-- makes an e-invoice.
--
-- platform_gst_thresholds  platform reference data: each figure, what applies
--                          at it, the date it applies from (empty when its
--                          first date is not recorded) and its source. The
--                          platform keeps it current by migration, never in
--                          the code, and an accountant checks it.
-- business_gst_pans        the PAN an owner records for one of their
--                          businesses that has no GSTIN; a business with a
--                          GSTIN takes its PAN from it (characters 3 to 12).
--                          A business with neither is listed as not linked:
--                          its PAN is never guessed. Where the owner is a
--                          person, a PAN is personal data, shown in full to
--                          the business's owners only.
-- owner_gst_settings       each owner's own warning level: the share of a
--                          threshold their view and their businesses' bells
--                          start warning at (80% until they change it).

-- --- The figures (platform reference data) --------------------------------------------

CREATE TABLE platform_gst_thresholds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(40) NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- What it is, as a warning names it.
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  -- What applies at the threshold, in words for people.
  applies VARCHAR(400) NOT NULL CHECK (btrim(applies) <> ''),
  -- The aggregate turnover of a financial year it is measured against, in
  -- rupees, and whether the rule applies above it or at it and above.
  turnover NUMERIC(16,2) NOT NULL CHECK (turnover > 0),
  comparison TEXT NOT NULL CHECK (comparison IN ('above', 'at_or_above')),
  -- The rule's own figure: the digits of the HSN or SAC code on an invoice,
  -- or the days after its date within which an invoice is reported to the IRP.
  hsn_digits SMALLINT CHECK (hsn_digits IN (4, 6, 8)),
  report_within_days SMALLINT CHECK (report_within_days > 0),
  -- The first day it applies; empty: in force, its first date not recorded.
  applies_from DATE,
  source VARCHAR(400) NOT NULL CHECK (btrim(source) <> ''),
  CONSTRAINT platform_gst_thresholds_once UNIQUE NULLS NOT DISTINCT (code, applies_from)
);

INSERT INTO platform_gst_thresholds (code, name, applies, turnover, comparison, hsn_digits, report_within_days, applies_from, source) VALUES
 ('e_invoicing', 'E-invoicing', 'Invoices are e-invoices, reported to the IRP.', 50000000.00, 'above', NULL, NULL, NULL,
  'ClearTax, "GST changes from April 2026" (cleartax.in/s/gst-changes-from-april-2026): e-invoicing applies above ₹5 crore of aggregate turnover. The date it first applied is not recorded here.'),
 ('hsn_digits', '6-digit HSN / SAC codes on invoices', 'The HSN or SAC code on each invoice runs to 6 digits.', 50000000.00, 'above', 6, NULL, DATE '2021-04-01',
  'GSTHero, "HSN code mandatory on invoices from 1st April 2021" (gsthero.com/blog/hsn-code-mandatory-on-invoices-from-1st-april-2021): HSN on invoices runs to 6 digits above ₹5 crore.'),
 ('irp_reporting_days', 'The 30-day limit for reporting to the IRP','An invoice or a credit note cannot be reported to the IRP more than 30 days after its date.', 100000000.00, 'at_or_above', NULL, 30, DATE '2025-04-01',
  'Taxmann, "Time limit of 30 days for reporting e-invoice on IRP portal for taxpayers with AATO of 10 crores and above" (taxmann.com/post/blog/time-limit-of-30-days-for-reporting-e-invoice-on-irp-portal-for-taxpayers-with-aato-of-10-crores-and-above-gstn-update): from 1 April 2025, at ₹10 crore or more.');

-- --- The PAN an owner records for a business with no GSTIN -----------------------------

CREATE TABLE business_gst_pans (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  pan CHAR(10) NOT NULL CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  recorded_by BIGINT NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Each owner's warning level ----------------------------------------------------------

CREATE TABLE owner_gst_settings (
  user_id BIGINT PRIMARY KEY REFERENCES users(id),
  -- A whole percent of a threshold: from it the turnover is "nearing".
  warn_percent SMALLINT NOT NULL DEFAULT 80 CHECK (warn_percent BETWEEN 50 AND 99),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE owner_gst_settings;
DROP TABLE business_gst_pans;
DROP TABLE platform_gst_thresholds;
