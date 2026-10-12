-- Up Migration

-- Who changed what. Kept deliberately simple: one row per action, with the
-- details as JSON so any module can write to it without new columns.
CREATE TABLE audit_logs (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT       NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id        BIGINT       REFERENCES users(id),
  user_name      VARCHAR(150),
  action         VARCHAR(50)  NOT NULL,
  entity_type    VARCHAR(50)  NOT NULL,
  entity_id      BIGINT,
  entity_label   VARCHAR(150),
  details        JSONB,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_restaurant ON audit_logs(restaurant_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(restaurant_id, entity_type, entity_id);

-- Indian bills show the tax split into CGST and SGST, and carry the GST and
-- FSSAI numbers of the restaurant.
ALTER TABLE restaurant_settings
  ADD COLUMN gst_number      VARCHAR(20),
  ADD COLUMN fssai_number    VARCHAR(20),
  ADD COLUMN gst_split       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN bill_footer     VARCHAR(200) DEFAULT 'Thank you, please visit again',
  ADD COLUMN auto_consume_stock BOOLEAN NOT NULL DEFAULT TRUE;

-- Reports and the new "reports.view" screens need this permission granted.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'reports.view'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE AND r.code = 'CASHIER'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'reports.view')
  AND role_id = (SELECT id FROM roles WHERE code = 'CASHIER' AND restaurant_id IS NULL);

ALTER TABLE restaurant_settings
  DROP COLUMN IF EXISTS gst_number,
  DROP COLUMN IF EXISTS fssai_number,
  DROP COLUMN IF EXISTS gst_split,
  DROP COLUMN IF EXISTS bill_footer,
  DROP COLUMN IF EXISTS auto_consume_stock;

DROP TABLE IF EXISTS audit_logs;
