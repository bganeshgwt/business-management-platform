-- Up Migration
-- Which optional modules each business type is offered is the super admin's,
-- in Platform › Business types (each type's Modules). A module a type may use
-- is offered to it, recommended (listed first, with why) or switched on for a
-- new business; one not offered is shown to none of the type's businesses, at
-- sign-up, in Business tools or in Your plan, and none of them switches it on.
-- A business that has it on already keeps it: nothing it made is lost.
--
-- Offered to start with: every module its type may use, as before, but
-- quotations for a kirana, a meat shop, a shop selling by weight and a fuel
-- station, which sell on the spot.

ALTER TABLE platform_module_business_types
  ADD COLUMN offered BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN updated_by BIGINT REFERENCES users(id),
  ADD COLUMN updated_at TIMESTAMPTZ;
ALTER TABLE platform_module_business_types
  ADD CONSTRAINT platform_module_business_types_offered CHECK (offered OR (NOT enabled_by_default AND NOT recommended));

UPDATE platform_module_business_types SET offered = FALSE
WHERE module_code = 'quotations' AND business_type IN ('grocery', 'meat', 'weight_retail', 'fuel_station')
  AND NOT enabled_by_default AND NOT recommended;

-- Down Migration
ALTER TABLE platform_module_business_types DROP CONSTRAINT platform_module_business_types_offered;
ALTER TABLE platform_module_business_types DROP COLUMN updated_at, DROP COLUMN updated_by, DROP COLUMN offered;
