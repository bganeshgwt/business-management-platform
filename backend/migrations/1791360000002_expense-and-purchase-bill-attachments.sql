-- Up Migration

-- The paper bill behind an expense or a supplier's bill (sweep SW-B-09).
--
-- A photo of the receipt for the ₹1,800 plumber, or the PDF the vegetable man
-- sends: the theft check on expenses, and what the accountant asks for at the
-- year end. Up to five files on an expense or a purchase bill, JPG, PNG or
-- PDF, at most 5 MB each.
--
-- The files are kept outside the public uploads folder and only ever served
-- through the API, to a signed-in person of the same restaurant with the
-- right to see expenses (or purchasing). Removing one is recorded (who, when)
-- rather than erasing it: a receipt that disappears after a query is exactly
-- what a theft check must be able to see. A voided purchase bill keeps its
-- files.
CREATE TABLE document_attachments (
  id            BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- What it is attached to: an expense, or a supplier's bill (goods receipt).
  entity_type   VARCHAR(20)   NOT NULL CHECK (entity_type IN ('expense', 'purchase_bill')),
  entity_id     BIGINT        NOT NULL,
  -- The name as uploaded, for the person reading it; never used on disk.
  file_name     VARCHAR(200)  NOT NULL,
  -- The name on disk: generated, never reused.
  stored_name   VARCHAR(100)  NOT NULL UNIQUE,
  mime_type     VARCHAR(40)   NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes    INTEGER       NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  removed_at    TIMESTAMPTZ,
  removed_by    BIGINT        REFERENCES users(id),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by    BIGINT        REFERENCES users(id),
  CONSTRAINT chk_document_attachments_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

-- The files of one record, and the paperclip count on a list.
CREATE INDEX idx_document_attachments_entity
  ON document_attachments (restaurant_id, entity_type, entity_id)
  WHERE removed_at IS NULL;

-- Down Migration

DROP TABLE IF EXISTS document_attachments;
