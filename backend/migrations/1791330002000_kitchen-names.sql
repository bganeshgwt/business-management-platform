-- Up Migration

-- SW-A-12: a kitchen name for dishes, sizes and add-ons.
-- The menu name is written for guests ("Paneer Tikka Angara"); the cook on
-- the tandoor may read Hindi, Tamil or Telugu better than English. A dish,
-- a size and an add-on may each carry an optional name in any script, which
-- the KOT and the kitchen screen show instead of (or above) the menu name.
-- Bills, receipts and the guest menu keep the menu name. NULL = none set,
-- so the menu name shows. VARCHAR counts characters, not bytes, so a
-- Devanagari or Tamil name gets the same room as an English one.
ALTER TABLE products ADD COLUMN kitchen_name VARCHAR(150);
ALTER TABLE product_variants ADD COLUMN kitchen_name VARCHAR(100);
ALTER TABLE modifiers ADD COLUMN kitchen_name VARCHAR(100);

-- What the KOTs, the kitchen screen and the change slips show: the menu
-- name, the kitchen name, or both (kitchen name large, menu name small).
-- 'both' by default: until a kitchen name is typed it prints exactly what it
-- printed before, and the moment one is typed the cook sees it without a
-- second setting to find.
ALTER TABLE kitchen_settings
  ADD COLUMN kitchen_name_mode VARCHAR(10) NOT NULL DEFAULT 'both'
    CONSTRAINT chk_kitchen_settings_name_mode CHECK (kitchen_name_mode IN ('menu', 'kitchen', 'both'));

-- A ticket keeps the kitchen names it was cut with, like it keeps the menu
-- names (item_name, variant_name): renaming a dish mid-service never
-- rewrites a ticket already on the rail. modifier_kitchen_names runs
-- parallel to modifiers (same order, NULL where an add-on has none).
ALTER TABLE kot_items
  ADD COLUMN kitchen_name VARCHAR(150),
  ADD COLUMN variant_kitchen_name VARCHAR(100),
  ADD COLUMN modifier_kitchen_names JSONB NOT NULL DEFAULT '[]';

-- Down Migration

ALTER TABLE kot_items
  DROP COLUMN IF EXISTS modifier_kitchen_names,
  DROP COLUMN IF EXISTS variant_kitchen_name,
  DROP COLUMN IF EXISTS kitchen_name;
ALTER TABLE kitchen_settings DROP COLUMN IF EXISTS kitchen_name_mode;
ALTER TABLE modifiers DROP COLUMN IF EXISTS kitchen_name;
ALTER TABLE product_variants DROP COLUMN IF EXISTS kitchen_name;
ALTER TABLE products DROP COLUMN IF EXISTS kitchen_name;
