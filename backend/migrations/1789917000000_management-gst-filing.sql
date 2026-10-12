-- Up Migration

-- ===========================================================================
-- Owner's view: what the GST filing pack needs that the bills do not carry.
-- ===========================================================================

-- --- The buyer's GSTIN on a bill (B2B invoices) ----------------------------
-- A company guest who wants input tax credit needs an invoice with their
-- GSTIN on it, and the accountant files those invoices one by one under B2B
-- in GSTR-1, apart from every other sale.
--
-- A guest record can already hold a GSTIN (customers.gstin), and a bill whose
-- guest has one is treated as B2B. This table is for the invoice itself:
--   * the guest was never added as a customer (a walk-in company lunch), or
--   * the cashier forgot, and the accountant adds the GSTIN before filing, or
--   * this one bill went to a different company than the guest's usual one.
-- What is written here wins over the guest record, because it is about this
-- invoice and nothing else. One row per bill at most.
--
-- The GSTIN is checked in full by the API (format, state code and the check
-- character, utils/gstin.js); the database keeps the shape honest as well.
CREATE TABLE bill_gst_recipients (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id        BIGINT        NOT NULL UNIQUE REFERENCES bills(id) ON DELETE CASCADE,
  gstin          VARCHAR(15)   NOT NULL
                 CONSTRAINT chk_bill_gst_recipients_gstin
                 CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  -- The registered (legal) name, as it must appear on the invoice.
  legal_name     VARCHAR(150)  NOT NULL CHECK (LENGTH(TRIM(legal_name)) > 0),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by     BIGINT        REFERENCES users(id),
  updated_by     BIGINT        REFERENCES users(id)
);

-- The filing pack reads a month of one restaurant's bills at a time.
CREATE INDEX idx_bill_gst_recipients_restaurant ON bill_gst_recipients (restaurant_id);

CREATE TRIGGER trg_bill_gst_recipients_updated_at
BEFORE UPDATE ON bill_gst_recipients
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- A GSTIN per outlet ------------------------------------------------------
-- A branch in another state is a separate GST registration with its own
-- GSTIN and its own return. When the outlet switcher is on such a branch, the
-- filing pack is headed with that branch's GSTIN; left empty, the outlet files
-- under the restaurant's GSTIN from Settings (same state, one registration).
ALTER TABLE outlets
  ADD COLUMN gst_number VARCHAR(15)
             CONSTRAINT chk_outlets_gst_number
             CHECK (gst_number IS NULL OR gst_number ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');

-- Down Migration

ALTER TABLE outlets DROP COLUMN IF EXISTS gst_number;
DROP TABLE IF EXISTS bill_gst_recipients;
