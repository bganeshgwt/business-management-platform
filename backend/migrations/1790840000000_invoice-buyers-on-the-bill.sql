-- Up Migration

-- ===========================================================================
-- Every B2B invoice carries its buyer on the bill itself.
-- ===========================================================================
--
-- The GST pack, the day book and the bill's reprint used to take a bill's
-- buyer from the bill (bill_gst_recipients) and, when it had none, from the
-- guest's record as it is TODAY. So adding a GSTIN to a regular turned every
-- ordinary bill they had ever paid into a B2B invoice: the GST register
-- moved it from B2C to B2B and the reprint printed a buyer it was never made
-- out to. An invoice, once issued, does not change.
--
-- Billing now writes the buyer onto the bill the moment it is raised (for a
-- guest whose record carries a GSTIN), the guest book writes it onto a
-- guest's B2B bills before their GSTIN or company name changes, and the
-- reports read only what is on the bill. This gives the bills raised before
-- billing did that the buyer the reports showed for them until now — so no
-- invoice already filed changes — except where the activity log shows the
-- GSTIN was put on the guest's record AFTER the bill was raised: those were
-- ordinary sales, and stay ordinary sales.
--
-- The bills given a buyer here are listed in invoice_buyer_backfill, so the
-- Down removes exactly them and never a buyer an accountant typed in.

CREATE TABLE invoice_buyer_backfill (
  bill_id BIGINT PRIMARY KEY REFERENCES bills(id) ON DELETE CASCADE
);

WITH written AS (
  INSERT INTO bill_gst_recipients (restaurant_id, bill_id, gstin, legal_name, address, created_by, updated_by)
  SELECT b.restaurant_id, b.id, g.gstin,
         LEFT(COALESCE(NULLIF(BTRIM(g.company_name), ''), g.name), 150),
         NULLIF(LEFT(BTRIM(g.address), 300), ''),
         NULL, NULL
  FROM bills b
  JOIN orders o ON o.id = b.order_id
  JOIN customers g ON g.id = o.customer_id AND g.gstin IS NOT NULL
  WHERE NOT EXISTS (SELECT 1 FROM bill_gst_recipients r WHERE r.bill_id = b.id)
    -- Not a bill raised before this GSTIN went on the guest's record.
    AND NOT EXISTS (
      SELECT 1
      FROM audit_logs a
      WHERE a.restaurant_id = b.restaurant_id
        AND a.entity_type = 'customer'
        AND a.entity_id = g.id
        AND a.created_at > b.billed_at
        AND jsonb_typeof(a.details -> 'gstin') = 'array'
        AND (a.details -> 'gstin') ->> 1 = g.gstin
        AND (a.details -> 'gstin') ->> 0 IS DISTINCT FROM g.gstin
    )
  ON CONFLICT (bill_id) DO NOTHING
  RETURNING bill_id
)
INSERT INTO invoice_buyer_backfill (bill_id)
SELECT bill_id FROM written;

-- Down Migration

DELETE FROM bill_gst_recipients r
USING invoice_buyer_backfill f
WHERE r.bill_id = f.bill_id;

DROP TABLE IF EXISTS invoice_buyer_backfill;
