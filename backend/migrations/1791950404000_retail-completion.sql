-- Up Migration
-- Retail completion (16 Oct 2026): where an item sits in the shop, a member
-- price, a price per branch, store opening hours, coupon codes, a cash count
-- per cashier shift, and departments with department-tied staff.

-- Where the item sits ("Aisle 3 · Shelf B", "Backroom"), and the price a
-- loyalty customer pays when it is lower than the list price.
ALTER TABLE catalog_skus
  ADD COLUMN shelf_location VARCHAR(40) CHECK (shelf_location IS NULL OR btrim(shelf_location) <> ''),
  ADD COLUMN member_price NUMERIC(12,2) CHECK (member_price IS NULL OR member_price > 0);

-- A branch that sells an item at its own price. No row: the item's own price.
CREATE TABLE business_sku_location_prices (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  sku_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  price NUMERIC(12,2) NOT NULL CHECK (price > 0),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sku_id, location_id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id)
);
CREATE INDEX business_sku_location_prices_location ON business_sku_location_prices(business_id, location_id);

-- Opening hours per location: {"mon":{"open":"09:00","close":"21:00"},...};
-- a day left out is closed. NULL: not given.
ALTER TABLE business_locations
  ADD COLUMN opening_hours JSONB CHECK (opening_hours IS NULL OR jsonb_typeof(opening_hours) = 'object');

-- A coupon: an offer that applies only when its code is given at the
-- counter, with limits on how often it may be used.
ALTER TABLE retail_offers
  ADD COLUMN coupon_code VARCHAR(20) CHECK (coupon_code IS NULL OR coupon_code ~ '^[A-Z0-9-]{3,20}$'),
  ADD COLUMN usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  ADD COLUMN per_customer_limit INTEGER CHECK (per_customer_limit IS NULL OR per_customer_limit > 0),
  ADD CONSTRAINT retail_offers_limits_need_coupon CHECK (coupon_code IS NOT NULL OR (usage_limit IS NULL AND per_customer_limit IS NULL));
CREATE UNIQUE INDEX retail_offers_coupon ON retail_offers(business_id, coupon_code) WHERE coupon_code IS NOT NULL;

-- A cashier's shift at one counter location: the float they start with, then
-- the cash they count at the end against what their own sales, collections,
-- refunds and expenses say should be there. One open shift per person and
-- location; a closed shift is a permanent record.
CREATE TABLE business_counter_shifts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opening_cash NUMERIC(14,2) NOT NULL CHECK (opening_cash >= 0),
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  movement_cash NUMERIC(16,2),
  expected_cash NUMERIC(16,2),
  counted_cash NUMERIC(14,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
  difference NUMERIC(16,2),
  reason VARCHAR(300),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  CONSTRAINT business_counter_shifts_closed_shape CHECK (
    (closed_at IS NULL AND closed_by IS NULL AND movement_cash IS NULL AND expected_cash IS NULL AND counted_cash IS NULL AND difference IS NULL AND reason IS NULL)
    OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND movement_cash IS NOT NULL AND expected_cash IS NOT NULL AND counted_cash IS NOT NULL AND difference IS NOT NULL
        AND expected_cash = opening_cash + movement_cash AND difference = counted_cash - expected_cash
        AND (difference = 0 OR length(btrim(COALESCE(reason, ''))) > 0)))
);
CREATE UNIQUE INDEX business_counter_shifts_one_open ON business_counter_shifts(business_id, location_id, user_id) WHERE closed_at IS NULL;
CREATE INDEX business_counter_shifts_day ON business_counter_shifts(business_id, opened_at DESC);
CREATE FUNCTION guard_business_counter_shift() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Cashier shifts are permanent records'; END IF;
  IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'A closed shift cannot be changed'; END IF;
  IF (to_jsonb(NEW) - ARRAY['closed_at','closed_by','movement_cash','expected_cash','counted_cash','difference','reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['closed_at','closed_by','movement_cash','expected_cash','counted_cash','difference','reason']) THEN
    RAISE EXCEPTION 'Only the closing count of a shift can be recorded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_counter_shifts_immutable BEFORE UPDATE OR DELETE ON business_counter_shifts
FOR EACH ROW EXECUTE FUNCTION guard_business_counter_shift();

-- Departments (a department store's Grocery, Clothing, Home…): categories
-- belong to one, and a person may be tied to one for products and stock.
CREATE TABLE business_departments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX business_departments_name ON business_departments(business_id, lower(name));
ALTER TABLE catalog_categories
  ADD COLUMN department_id BIGINT,
  ADD CONSTRAINT catalog_categories_department FOREIGN KEY (business_id, department_id) REFERENCES business_departments(business_id, id);
ALTER TABLE business_memberships
  ADD COLUMN department_id BIGINT,
  ADD CONSTRAINT business_memberships_department FOREIGN KEY (business_id, department_id) REFERENCES business_departments(business_id, id);

-- Down Migration
ALTER TABLE business_memberships DROP CONSTRAINT business_memberships_department, DROP COLUMN department_id;
ALTER TABLE catalog_categories DROP CONSTRAINT catalog_categories_department, DROP COLUMN department_id;
DROP TABLE business_departments;
DROP TABLE business_counter_shifts;
DROP FUNCTION guard_business_counter_shift();
DROP INDEX retail_offers_coupon;
ALTER TABLE retail_offers DROP CONSTRAINT retail_offers_limits_need_coupon,
  DROP COLUMN per_customer_limit, DROP COLUMN usage_limit, DROP COLUMN coupon_code;
ALTER TABLE business_locations DROP COLUMN opening_hours;
DROP TABLE business_sku_location_prices;
ALTER TABLE catalog_skus DROP COLUMN member_price, DROP COLUMN shelf_location;
