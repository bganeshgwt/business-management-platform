-- Up Migration
ALTER TABLE products ADD COLUMN addon_groups JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(addon_groups) = 'array');

-- Down Migration
ALTER TABLE products DROP COLUMN addon_groups;
