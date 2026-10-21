-- Up Migration
-- Brands: one kitchen selling under several names (a cloud kitchen's
-- "Biryani Box", "Wrap Republic" and "Bowl Theory", each its own listing on
-- Swiggy and Zomato). A menu category belongs to one brand or is shared by
-- all (drinks, desserts); an order is taken under a brand, which its KOT and
-- bill print and the brand report counts. The kitchen, stock, staff, GST and
-- the business day stay one.
CREATE TABLE restaurant_brands (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  tagline VARCHAR(150),
  color VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_restaurant_brands_name ON restaurant_brands (restaurant_id, LOWER(name));

-- NULL: a category every brand sells.
ALTER TABLE categories ADD COLUMN brand_id BIGINT REFERENCES restaurant_brands(id) ON DELETE RESTRICT;
CREATE INDEX idx_categories_brand ON categories (restaurant_id, brand_id);

-- NULL: the kitchen's own name (no brand chosen, or no brands).
ALTER TABLE orders ADD COLUMN brand_id BIGINT REFERENCES restaurant_brands(id) ON DELETE RESTRICT;
CREATE INDEX idx_orders_brand ON orders (restaurant_id, brand_id) WHERE brand_id IS NOT NULL;

-- Brands are a restaurant feature, on for a cloud kitchen (its format turns
-- it on), off for the others until switched on.
INSERT INTO platform_modules (code, name, description, kind, sort_order, feature_group) VALUES
 ('brands', 'Brands (one kitchen, several names)', 'Sell under several brand names from one kitchen: each brand has its own menu categories, prints on its KOTs and bills, and has its own sales by channel.', 'optional', 318, 'Service');
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('brands', 'restaurant', FALSE);
INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES ('brands', 'restaurant');

-- Down Migration
DELETE FROM business_capabilities WHERE capability = 'brands';
DELETE FROM platform_module_dependencies WHERE module_code = 'brands';
DELETE FROM platform_module_business_types WHERE module_code = 'brands';
DELETE FROM platform_modules WHERE code = 'brands';
ALTER TABLE orders DROP COLUMN brand_id;
ALTER TABLE categories DROP COLUMN brand_id;
DROP TABLE restaurant_brands;
