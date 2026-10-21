-- Up Migration
-- The lean starting setup is for the business types. A restaurant has always
-- started with tasks, issues and projects on, and keeps doing so.
UPDATE platform_module_business_types SET enabled_by_default = TRUE
WHERE business_type = 'restaurant' AND module_code IN ('tasks','issues','projects');

-- Down Migration
UPDATE platform_module_business_types SET enabled_by_default = FALSE
WHERE business_type = 'restaurant' AND module_code IN ('tasks','issues','projects');
