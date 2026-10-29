-- Up Migration
-- What a laundry and dry cleaner needs beyond taking garments in and handing
-- them over: prices of its own for a location, a customer or a group of
-- customers from a date, carpets and curtains priced by the square foot, the
-- days each service takes (the promised day from the slowest garment, past
-- the shop's weekly closed days), discounts and offers kept as taken in,
-- prepaid kilo and piece packages, photos of a garment at intake and at its
-- quality check, the customer's signature drawn on the screen, a quality
-- check (pass, or rewash with a reason) and packing before the rack, a garment
-- changed before its work starts or added to an open order, the pieces under
-- one tag handed over one by one, and the claims added up by service, by the
-- person who took the garment in and by month.
--
--   laundry_settings          + how an area is rounded (to the hundredth of a
--                             square foot, the nearest whole one, or up to the
--                             next), the weekly days the shop is closed (the
--                             promised day skips them), and whether a quality
--                             check and packing are required before the rack.
--   laundry_services          + the days to the promised day for each service,
--                             and for express (the shop's days when not set).
--   laundry_prices            a price may be by the square foot ("sqft").
--   laundry_customer_groups   groups of customers priced together (a housing
--                             society, the hotels); switched off, never deleted.
--   laundry_group_members     the group a customer is in (one at a time).
--   laundry_price_overrides   a garment and service at a price of its own for
--                             a location, a customer or a group, from a date
--                             (to a date, or open). A new one ends the earlier
--                             one the day before; one is ended, never deleted.
--                             A customer's price comes first, then their
--                             group's, then the location's, then the list.
--   laundry_plans             prepaid packages for sale, as the salon sells
--                             its: each sold through its own service item on a
--                             bill with GST at the sale; so many kilos or
--                             pieces of the services it covers, for so many
--                             days, with what is left carried into the next
--                             one as the shop's rule says (none, all, or up to
--                             a quantity, when bought within some days of the
--                             end).
--   laundry_plan_services     the services a package covers.
--   laundry_packages          a package a customer bought: the plan as it was
--                             then (its quantity, days, carry-forward rule and
--                             services), the bill line that sold it, what was
--                             carried in from their package before. Its
--                             balance is what it holds less what garments
--                             drew from it and what was carried on; cancelled
--                             only while unused, never deleted.
--   laundry_order_items       + its length and width (by the square foot), the
--                             price's source (the list, a location's, a
--                             group's, a customer's, or typed by a manager on a
--                             change), the package it drew from with the
--                             quantity and value, the offer and the discount
--                             taken off as taken in, when its quality check
--                             passed and it was packed and by whom, its
--                             rewashes, the pieces handed over so far, and
--                             when it was added to the order after intake.
--   laundry_orders            + the discount on the whole order as given, with
--                             its reason; its figures follow its garments
--                             when one is added, changed or cancelled.
--   laundry_delivery_items    + the pieces of the garment handed over.
--   laundry_order_additions   garments added to an open order, with the bill
--                             made for them (an order billed at intake).
--   laundry_item_changes      a garment's service, price or quantity changed
--                             before its work started: what it was and became,
--                             why, the credit note on its old bill line and the
--                             bill of the new one.
--   laundry_files             photos of a garment at intake and at its
--                             quality check, and the customer's signature at
--                             intake: private pictures read only through the
--                             API by someone who sees the order, never changed
--                             or deleted.

-- --- Settings and services -----------------------------------------------------------------------

ALTER TABLE laundry_settings
  ADD COLUMN area_rounding TEXT NOT NULL DEFAULT 'exact' CHECK (area_rounding IN ('exact', 'nearest', 'up')),
  ADD COLUMN closed_days SMALLINT[] NOT NULL DEFAULT '{}' CHECK (closed_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[] AND cardinality(closed_days) < 7),
  ADD COLUMN qc_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN packing_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE laundry_services
  ADD COLUMN ready_days SMALLINT CHECK (ready_days BETWEEN 0 AND 60),
  ADD COLUMN express_days SMALLINT CHECK (express_days BETWEEN 0 AND 60);

ALTER TABLE laundry_prices DROP CONSTRAINT laundry_prices_per_check,
  ADD CONSTRAINT laundry_prices_per_check CHECK (per IN ('item', 'kg', 'sqft'));

-- --- Customer groups and prices of their own -------------------------------------------------------

CREATE TABLE laundry_customer_groups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX laundry_customer_groups_name ON laundry_customer_groups(business_id, lower(name));

CREATE TABLE laundry_group_members (
  business_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  group_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, group_id) REFERENCES laundry_customer_groups(business_id, id)
);
CREATE INDEX laundry_group_members_group ON laundry_group_members(business_id, group_id);
CREATE TRIGGER laundry_group_members_customer BEFORE INSERT OR UPDATE OF contact_id ON laundry_group_members
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

CREATE TABLE laundry_price_overrides (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  garment_type_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  -- Whose price: one location's, one group's or one customer's.
  location_id BIGINT,
  group_id BIGINT,
  contact_id BIGINT,
  per TEXT NOT NULL CHECK (per IN ('item', 'kg', 'sqft')),
  price NUMERIC(14,2) NOT NULL CHECK (price > 0),
  -- In force from this day to that one (or open). Ended the day before it starts: never in force.
  valid_from DATE NOT NULL,
  valid_to DATE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_by BIGINT REFERENCES users(id),
  ended_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, garment_type_id) REFERENCES laundry_garment_types(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES laundry_services(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, group_id) REFERENCES laundry_customer_groups(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, id),
  CHECK (num_nonnulls(location_id, group_id, contact_id) = 1),
  CHECK (valid_to IS NULL OR valid_to >= valid_from - 1),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE INDEX laundry_price_overrides_lookup ON laundry_price_overrides(business_id, garment_type_id, service_id, valid_from DESC);
CREATE TRIGGER laundry_price_overrides_customer BEFORE INSERT ON laundry_price_overrides
  FOR EACH ROW WHEN (NEW.contact_id IS NOT NULL) EXECUTE FUNCTION business_contact_is_customer();

-- A price of its own keeps what it was set at: only its end comes, earlier,
-- never before the day before it starts; two for the same garment, service and
-- party are never in force on the same day; none is deleted.
CREATE FUNCTION laundry_price_overrides_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A price of its own is never deleted; end it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['valid_to', 'ended_by', 'ended_at']) <> (to_jsonb(OLD) - ARRAY['valid_to', 'ended_by', 'ended_at']) THEN
      RAISE EXCEPTION 'A price of its own keeps what it was set at; set a new one from a date instead' USING ERRCODE = '23514';
    END IF;
    IF NEW.valid_to IS NULL OR (OLD.valid_to IS NOT NULL AND NEW.valid_to > OLD.valid_to) THEN
      RAISE EXCEPTION 'A price of its own is ended earlier, never kept on longer' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM laundry_price_overrides o WHERE o.business_id = NEW.business_id AND o.id <> NEW.id
       AND o.garment_type_id = NEW.garment_type_id AND o.service_id = NEW.service_id
       AND o.location_id IS NOT DISTINCT FROM NEW.location_id AND o.group_id IS NOT DISTINCT FROM NEW.group_id AND o.contact_id IS NOT DISTINCT FROM NEW.contact_id
       AND o.valid_from <= COALESCE(NEW.valid_to, 'infinity'::date) AND NEW.valid_from <= COALESCE(o.valid_to, 'infinity'::date)
       AND COALESCE(o.valid_to, 'infinity'::date) >= o.valid_from AND COALESCE(NEW.valid_to, 'infinity'::date) >= NEW.valid_from) THEN
    RAISE EXCEPTION 'Another price of its own for this garment and service is in force on these days' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_price_overrides_guard BEFORE INSERT OR UPDATE OR DELETE ON laundry_price_overrides
  FOR EACH ROW EXECUTE FUNCTION laundry_price_overrides_guard();

-- --- Prepaid packages --------------------------------------------------------------------------------

CREATE TABLE laundry_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The service item it is sold as: its name on the bill, its price, GST slab and SAC.
  sku_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  unit TEXT NOT NULL CHECK (unit IN ('kg', 'piece')),
  quantity NUMERIC(10,3) NOT NULL CHECK (quantity > 0 AND quantity < 100000),
  validity_days SMALLINT NOT NULL CHECK (validity_days BETWEEN 1 AND 3650),
  -- What is left when the next one is bought: none, all, or up to carry_max;
  -- only when the next is bought within carry_days of the end.
  carry_forward TEXT NOT NULL DEFAULT 'none' CHECK (carry_forward IN ('none', 'all', 'up_to')),
  carry_max NUMERIC(10,3) CHECK (carry_max > 0),
  carry_days SMALLINT NOT NULL DEFAULT 0 CHECK (carry_days BETWEEN 0 AND 365),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku_id),
  CHECK (unit = 'kg' OR quantity = trunc(quantity)),
  CHECK ((carry_forward = 'up_to') = (carry_max IS NOT NULL))
);
CREATE UNIQUE INDEX laundry_plans_name ON laundry_plans(business_id, lower(name));

CREATE TABLE laundry_plan_services (
  business_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  PRIMARY KEY (business_id, plan_id, service_id),
  FOREIGN KEY (business_id, plan_id) REFERENCES laundry_plans(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES laundry_services(business_id, id)
);

-- A plan is sold as a service item of this business, keeps it and its unit, and is switched off, never deleted.
CREATE FUNCTION laundry_plans_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A package plan is never deleted; stop selling it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.sku_id <> OLD.sku_id OR NEW.unit <> OLD.unit OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'A package plan keeps its item and its unit' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
                 WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id AND p.kind = 'service' AND NOT s.is_kit) THEN
    RAISE EXCEPTION 'A package plan is sold as a service item of this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_plans_guard BEFORE INSERT OR UPDATE OR DELETE ON laundry_plans
  FOR EACH ROW EXECUTE FUNCTION laundry_plans_guard();

CREATE TABLE laundry_packages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  -- The plan as it was when sold.
  name VARCHAR(150) NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('kg', 'piece')),
  quantity NUMERIC(10,3) NOT NULL CHECK (quantity > 0),
  carry_forward TEXT NOT NULL CHECK (carry_forward IN ('none', 'all', 'up_to')),
  carry_max NUMERIC(10,3),
  carry_days SMALLINT NOT NULL,
  service_ids BIGINT[] NOT NULL CHECK (cardinality(service_ids) > 0),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  -- The bill line that sold it, and its price there (with GST).
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  price NUMERIC(14,2) NOT NULL CHECK (price >= 0),
  -- What was carried in from the customer's package before.
  carried_from BIGINT,
  carried_in NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (carried_in >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancel_reason VARCHAR(300),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, plan_id) REFERENCES laundry_plans(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  FOREIGN KEY (business_id, carried_from) REFERENCES laundry_packages(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, line_id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, carried_from),
  CHECK (ends_on >= starts_on),
  CHECK ((carried_from IS NULL) = (carried_in = 0)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX laundry_packages_contact ON laundry_packages(business_id, contact_id, ends_on);
CREATE TRIGGER laundry_packages_customer BEFORE INSERT ON laundry_packages
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A package is sold on a bill line of its plan's item to its customer, and
-- carries in only from that customer's earlier package of the same unit;
-- afterwards only its cancellation changes (while nothing was drawn from it or
-- carried in or on); it is never deleted.
CREATE FUNCTION laundry_packages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A customer''s package is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
                   JOIN laundry_plans pl ON pl.business_id = l.business_id AND pl.sku_id = l.sku_id
                   WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id AND pl.id = NEW.plan_id
                     AND d.kind = 'sale' AND d.contact_id = NEW.contact_id) THEN
      RAISE EXCEPTION 'A package is sold on a bill line of its plan''s item, to its customer' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'A package starts active' USING ERRCODE = '23514';
    END IF;
    IF NEW.carried_from IS NOT NULL THEN
      SELECT contact_id, unit, status INTO before FROM laundry_packages WHERE business_id = NEW.business_id AND id = NEW.carried_from;
      IF before.contact_id <> NEW.contact_id OR before.unit <> NEW.unit OR before.status <> 'active' THEN
        RAISE EXCEPTION 'What is left is carried in from the same customer''s package of the same unit' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at']) <> (to_jsonb(OLD) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at'])
     OR OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'A customer''s package is kept as it was sold; it can only be cancelled while unused' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND (OLD.carried_in > 0
       OR EXISTS (SELECT 1 FROM laundry_order_items WHERE business_id = NEW.business_id AND package_id = NEW.id AND status <> 'cancelled')
       OR EXISTS (SELECT 1 FROM laundry_packages WHERE business_id = NEW.business_id AND carried_from = NEW.id)) THEN
    RAISE EXCEPTION 'Package % was used: it is no longer cancelled', OLD.name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_packages_guard BEFORE INSERT OR UPDATE OR DELETE ON laundry_packages
  FOR EACH ROW EXECUTE FUNCTION laundry_packages_guard();

-- A package never gives more than it holds (checked once the statement's rows are in).
CREATE FUNCTION laundry_package_holds() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bank BIGINT := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'laundry_packages' THEN 'carried_from' ELSE 'package_id' END)::bigint;
BEGIN
  IF bank IS NOT NULL AND laundry_package_left(NEW.business_id, bank) < 0 THEN
    RAISE EXCEPTION 'The package does not hold that much: give fewer kilos or pieces from it' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laundry_packages_holds AFTER INSERT ON laundry_packages
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION laundry_package_holds();

-- The bill line that sold a package is credited only once the package is
-- cancelled (refused once anything was drawn from it), as a salon's is.
CREATE FUNCTION laundry_package_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM laundry_packages WHERE business_id = NEW.business_id AND line_id = NEW.line_id AND status = 'active') THEN
    RAISE EXCEPTION 'This line sold a laundry package. Cancel the package under Customers › Packages first, then return the line.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_return_lines_laundry_package BEFORE INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION laundry_package_line_return();

-- A plan's item is sold only as a package: a bill line of it has the
-- customer's package made with it by the time the bill is saved.
CREATE FUNCTION laundry_plan_line_sold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan TEXT;
BEGIN
  SELECT name INTO plan FROM laundry_plans WHERE business_id = NEW.business_id AND sku_id = NEW.sku_id;
  IF plan IS NOT NULL AND NOT EXISTS (SELECT 1 FROM laundry_packages WHERE business_id = NEW.business_id AND line_id = NEW.id) THEN
    RAISE EXCEPTION '% is a laundry package: sell it from Customers › Packages, which makes the customer''s package with its bill', plan USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER business_document_lines_laundry_plan AFTER INSERT ON business_document_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION laundry_plan_line_sold();

-- --- Garment orders and their garments -------------------------------------------------------------

ALTER TABLE laundry_orders
  -- The discount on the whole order as given (a percentage or an amount off what the customer pays), and why.
  ADD COLUMN discount_percent NUMERIC(5,2) CHECK (discount_percent > 0 AND discount_percent <= 100),
  ADD COLUMN discount_amount NUMERIC(14,2) CHECK (discount_amount > 0),
  ADD COLUMN discount_reason VARCHAR(120) CHECK (btrim(discount_reason) <> ''),
  ADD CONSTRAINT laundry_orders_discount_shape CHECK (discount_percent IS NULL OR discount_amount IS NULL);

CREATE TABLE laundry_order_additions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  -- The bill made for the garments added (an order billed at intake).
  document_id BIGINT,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES laundry_orders(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_id, id),
  UNIQUE (business_id, request_key)
);
CREATE TRIGGER laundry_order_additions_append_only BEFORE UPDATE OR DELETE ON laundry_order_additions
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only();

ALTER TABLE laundry_order_items
  -- By the square foot: the length and width typed (feet).
  ADD COLUMN length_ft NUMERIC(6,2) CHECK (length_ft > 0),
  ADD COLUMN width_ft NUMERIC(6,2) CHECK (width_ft > 0),
  -- Where its price came from.
  ADD COLUMN price_source TEXT NOT NULL DEFAULT 'list' CHECK (price_source IN ('list', 'location', 'group', 'customer', 'manual')),
  ADD COLUMN price_override_id BIGINT,
  -- The package it drew from: how many kilos or pieces, and their value in the order's price terms.
  ADD COLUMN package_id BIGINT,
  ADD COLUMN package_quantity NUMERIC(10,3) CHECK (package_quantity > 0),
  ADD COLUMN package_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (package_amount >= 0),
  -- The offer taken off at intake, and the discount (its own and its share of the order's).
  ADD COLUMN offer_id BIGINT,
  ADD COLUMN offer_name VARCHAR(120),
  ADD COLUMN offer_percent NUMERIC(5,2) CHECK (offer_percent > 0 AND offer_percent <= 100),
  ADD COLUMN offer_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (offer_amount >= 0),
  ADD COLUMN discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  -- Its quality check passed and its packing, with who; how many times it was sent back to be washed again.
  ADD COLUMN qc_at TIMESTAMPTZ,
  ADD COLUMN qc_by BIGINT REFERENCES users(id),
  ADD COLUMN packed_at TIMESTAMPTZ,
  ADD COLUMN packed_by BIGINT REFERENCES users(id),
  ADD COLUMN rewashes SMALLINT NOT NULL DEFAULT 0 CHECK (rewashes BETWEEN 0 AND 99),
  -- The pieces handed over so far (several under one tag go one by one).
  ADD COLUMN pieces_delivered SMALLINT NOT NULL DEFAULT 0,
  -- Added to the order after it was taken in.
  ADD COLUMN addition_id BIGINT,
  ADD COLUMN added_by BIGINT REFERENCES users(id),
  ADD COLUMN added_at TIMESTAMPTZ,
  ADD CONSTRAINT laundry_order_items_override_fkey FOREIGN KEY (business_id, price_override_id) REFERENCES laundry_price_overrides(business_id, id),
  ADD CONSTRAINT laundry_order_items_package_fkey FOREIGN KEY (business_id, package_id) REFERENCES laundry_packages(business_id, id),
  ADD CONSTRAINT laundry_order_items_offer_fkey FOREIGN KEY (business_id, offer_id) REFERENCES retail_offers(business_id, id),
  ADD CONSTRAINT laundry_order_items_addition_fkey FOREIGN KEY (business_id, order_id, addition_id) REFERENCES laundry_order_additions(business_id, order_id, id),
  ADD CONSTRAINT laundry_order_items_area CHECK ((per = 'sqft') = (length_ft IS NOT NULL AND width_ft IS NOT NULL)),
  ADD CONSTRAINT laundry_order_items_override CHECK ((price_source IN ('location', 'group', 'customer')) = (price_override_id IS NOT NULL)),
  ADD CONSTRAINT laundry_order_items_package CHECK ((package_id IS NULL) = (package_quantity IS NULL) AND (package_id IS NOT NULL OR package_amount = 0)),
  ADD CONSTRAINT laundry_order_items_offer CHECK ((offer_id IS NULL) = (offer_name IS NULL) AND (offer_id IS NULL) = (offer_percent IS NULL) AND (offer_id IS NOT NULL OR offer_amount = 0)),
  ADD CONSTRAINT laundry_order_items_qc_by CHECK ((qc_at IS NULL) = (qc_by IS NULL)),
  ADD CONSTRAINT laundry_order_items_packed_by CHECK ((packed_at IS NULL) = (packed_by IS NULL)),
  ADD CONSTRAINT laundry_order_items_packed CHECK (status <> 'packed' OR packed_at IS NOT NULL),
  ADD CONSTRAINT laundry_order_items_back_in_work CHECK (status NOT IN ('received', 'in_process', 'qc') OR (qc_at IS NULL AND packed_at IS NULL)),
  ADD CONSTRAINT laundry_order_items_added CHECK ((added_at IS NULL) = (added_by IS NULL) AND (addition_id IS NULL OR added_at IS NOT NULL));

-- The steps a garment takes: a quality check (qc) and packed join the way
-- from received to ready; a price by the square foot; a garment's value is
-- what is left after its package, offer and discount (nil when a package pays
-- for all of it).
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_status_check,
  ADD CONSTRAINT laundry_order_items_status_check CHECK (status IN ('received', 'in_process', 'qc', 'packed', 'ready', 'delivered', 'cancelled'));
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_per_check,
  ADD CONSTRAINT laundry_order_items_per_check CHECK (per IN ('item', 'kg', 'sqft'));
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_check,
  ADD CONSTRAINT laundry_order_items_check CHECK (per <> 'item' OR quantity = trunc(quantity));
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_amount_check,
  ADD CONSTRAINT laundry_order_items_amount_check CHECK (amount >= 0);
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_check1,
  ADD CONSTRAINT laundry_order_items_check1 CHECK (amount = base + surcharge - package_amount - offer_amount - discount_amount);
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_check6,
  ADD CONSTRAINT laundry_order_items_check6 CHECK (status NOT IN ('received', 'in_process', 'qc', 'packed') OR ready_at IS NULL);

-- The pieces handed over: all of a delivered garment's (as every handover so far was).
ALTER TABLE laundry_order_items DISABLE TRIGGER laundry_order_items_guard;
UPDATE laundry_order_items SET pieces_delivered = pieces WHERE status = 'delivered';
ALTER TABLE laundry_order_items ENABLE TRIGGER laundry_order_items_guard;
ALTER TABLE laundry_order_items
  ADD CONSTRAINT laundry_order_items_pieces_delivered CHECK (pieces_delivered BETWEEN 0 AND pieces AND (status = 'delivered') = (pieces_delivered = pieces));

DROP INDEX laundry_order_items_open_tag;
CREATE UNIQUE INDEX laundry_order_items_open_tag ON laundry_order_items(business_id, tag_no) WHERE status IN ('received', 'in_process', 'qc', 'packed', 'ready');
DROP INDEX laundry_order_items_open;
CREATE INDEX laundry_order_items_open ON laundry_order_items(business_id, status, ready_at) WHERE status IN ('received', 'in_process', 'qc', 'packed', 'ready');
CREATE INDEX laundry_order_items_package ON laundry_order_items(business_id, package_id) WHERE package_id IS NOT NULL;

ALTER TABLE laundry_delivery_items ADD COLUMN pieces SMALLINT CHECK (pieces BETWEEN 1 AND 999);
ALTER TABLE laundry_delivery_items DISABLE TRIGGER laundry_delivery_items_append_only;
UPDATE laundry_delivery_items di SET pieces = i.pieces FROM laundry_order_items i WHERE i.business_id = di.business_id AND i.id = di.item_id;
ALTER TABLE laundry_delivery_items ENABLE TRIGGER laundry_delivery_items_append_only;
ALTER TABLE laundry_delivery_items ALTER COLUMN pieces SET NOT NULL;

CREATE TABLE laundry_item_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  -- What it was and became: its service, price, quantity, pieces and charge.
  was JSONB NOT NULL,
  became JSONB NOT NULL,
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  -- Billed: the credit note on its old bill line, and the bill of the new one.
  return_id BIGINT,
  document_id BIGINT,
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id, item_id) REFERENCES laundry_order_items(business_id, order_id, id),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE INDEX laundry_item_changes_item ON laundry_item_changes(business_id, item_id, id);
CREATE TRIGGER laundry_item_changes_append_only BEFORE UPDATE OR DELETE ON laundry_item_changes
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only();

-- An order keeps its number, customer, rules, discount and terms as taken in;
-- its promised day and notes change, and its figures follow its garments.
CREATE OR REPLACE FUNCTION laundry_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment order is never deleted; cancel its garments instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['promised_on', 'notes', 'subtotal', 'tax', 'round_off', 'total', 'updated_by', 'updated_at'])
     <> (to_jsonb(OLD) - ARRAY['promised_on', 'notes', 'subtotal', 'tax', 'round_off', 'total', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'A garment order keeps its number, customer, rules, prices and terms as it was taken in' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A garment goes on its order when the order is taken in, or later as one
-- added to an order with garments still in the shop, as received, with
-- nothing done, delivered, cancelled or credited; it is billed as its
-- service's item and counted as its garment is; an order billed at intake
-- bills it on a line of its own item on a bill to the order's customer (the
-- order's own bill when taken in with it). A package it draws from is its
-- customer's, active, of its unit, covering its service, on the day.
CREATE OR REPLACE FUNCTION laundry_order_items_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD; bank RECORD; day DATE;
BEGIN
  SELECT order_no, created_at, document_id, bill_at, contact_id INTO o FROM laundry_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF o.created_at <> now() THEN
    IF NEW.added_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'Garments go on order % when it is taken in, or are added to it as garments added later', o.order_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM laundry_order_items WHERE business_id = NEW.business_id AND order_id = NEW.order_id AND status IN ('received', 'in_process', 'qc', 'packed', 'ready')) THEN
      RAISE EXCEPTION 'Order % has no garment left in the shop: take in a new order', o.order_no USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.added_at IS NOT NULL THEN
    RAISE EXCEPTION 'A garment taken in with its order is not added later' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'received' OR NEW.ready_at IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.credit_key IS NOT NULL
     OR NEW.qc_at IS NOT NULL OR NEW.packed_at IS NOT NULL OR NEW.rewashes <> 0 OR NEW.pieces_delivered <> 0 THEN
    RAISE EXCEPTION 'A garment starts as received, with nothing done, delivered, cancelled or credited' USING ERRCODE = '23514';
  END IF;
  IF NEW.sku_id IS DISTINCT FROM (SELECT sku_id FROM laundry_services WHERE business_id = NEW.business_id AND id = NEW.service_id) THEN
    RAISE EXCEPTION 'A garment is billed as the item of its service' USING ERRCODE = '23514';
  END IF;
  IF NEW.counted_as IS DISTINCT FROM (SELECT counted_as FROM laundry_garment_types WHERE business_id = NEW.business_id AND id = NEW.garment_type_id) THEN
    RAISE EXCEPTION 'A garment is counted as its kind of garment is' USING ERRCODE = '23514';
  END IF;
  IF (o.bill_at = 'intake') <> (NEW.line_id IS NOT NULL)
     OR (NEW.line_id IS NOT NULL AND ((NEW.added_at IS NULL AND NEW.document_id IS DISTINCT FROM o.document_id)
       OR NOT EXISTS (SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
                      WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id AND l.sku_id = NEW.sku_id
                        AND d.kind = 'sale' AND d.contact_id = o.contact_id))) THEN
    RAISE EXCEPTION 'A garment of an order billed at intake is on a line of its own item, on a bill to the order''s customer' USING ERRCODE = '23514';
  END IF;
  IF NEW.package_id IS NOT NULL THEN
    SELECT p.*, (now() AT TIME ZONE b.timezone)::date AS today INTO bank FROM laundry_packages p JOIN businesses b ON b.id = p.business_id
    WHERE p.business_id = NEW.business_id AND p.id = NEW.package_id;
    IF bank.contact_id <> o.contact_id OR bank.status <> 'active' OR bank.today NOT BETWEEN bank.starts_on AND bank.ends_on
       OR NOT (NEW.service_id = ANY(bank.service_ids)) OR (bank.unit = 'kg') <> (NEW.per = 'kg') OR (bank.unit = 'piece' AND NEW.per <> 'item') THEN
      RAISE EXCEPTION 'Package % does not pay for garment %: it is the customer''s own, in force today, of its unit and covering its service', bank.name, NEW.tag_no USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A garment keeps what was noted and priced when it was taken in (its
-- service, price and quantity change only with a change made now, while it is
-- received), and is never deleted. It moves one allowed step at a time:
-- received into the work, to its quality check, packed or ready (as far as the
-- shop's checks allow); in process to its quality check, packed or ready; at
-- its quality check passed (packed or ready) or sent back to be washed again;
-- packed to ready or back into the work; ready back into the work or handed
-- over (with its bill line, in a handover made now, piece by piece); a
-- delivered one back into the work only for reprocessing under a damage claim
-- decided now; any garment in the shop cancelled (a billed one once its bill
-- line is credited, unless the line charged nothing). Its bill line and the
-- key of the credit note on it are given once (a change moves it to the new
-- line); it is re-tagged only while it is in the shop.
CREATE OR REPLACE FUNCTION laundry_order_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD; s RECORD; changed BOOLEAN;
  moving TEXT[] := ARRAY['tag_no', 'status', 'rack', 'ready_at', 'ready_by', 'delivered_at', 'delivered_by', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'cancel_key',
    'document_id', 'line_id', 'credit_key', 'qc_at', 'qc_by', 'packed_at', 'packed_by', 'rewashes', 'pieces_delivered'];
  priced TEXT[] := ARRAY['service_id', 'service_name', 'sku_id', 'per', 'quantity', 'pieces', 'length_ft', 'width_ft', 'rate', 'base', 'surcharge', 'amount', 'tax_rate', 'net', 'tax',
    'price_source', 'price_override_id', 'package_id', 'package_quantity', 'package_amount', 'offer_id', 'offer_name', 'offer_percent', 'offer_amount', 'discount_amount'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment on an order is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  changed := EXISTS (SELECT 1 FROM laundry_item_changes WHERE business_id = NEW.business_id AND item_id = NEW.id AND created_at = now());
  IF (to_jsonb(NEW) - moving - priced) <> (to_jsonb(OLD) - moving - priced)
     OR ((to_jsonb(NEW) - moving) <> (to_jsonb(OLD) - moving) AND NOT (changed AND OLD.status = 'received')) THEN
    RAISE EXCEPTION 'A garment keeps what was noted and priced when it was taken in' USING ERRCODE = '23514';
  END IF;
  SELECT order_no, contact_id INTO o FROM laundry_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Garment % on order % was cancelled and no longer changes', OLD.tag_no, o.order_no USING ERRCODE = '23514';
  END IF;
  IF OLD.line_id IS NOT NULL AND (NEW.line_id IS DISTINCT FROM OLD.line_id OR NEW.document_id IS DISTINCT FROM OLD.document_id)
     AND NOT (changed AND NEW.line_id IS NOT NULL AND (EXISTS (SELECT 1 FROM business_return_lines WHERE business_id = NEW.business_id AND line_id = OLD.line_id)
       OR EXISTS (SELECT 1 FROM business_document_lines WHERE business_id = NEW.business_id AND id = OLD.line_id AND net + tax = 0))) THEN
    RAISE EXCEPTION 'Garment % keeps the bill line that charges it', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.credit_key IS NOT NULL AND NEW.credit_key IS DISTINCT FROM OLD.credit_key AND NOT (changed AND NEW.credit_key IS NULL AND NEW.line_id IS DISTINCT FROM OLD.line_id) THEN
    RAISE EXCEPTION 'Garment % is credited once', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.tag_no <> OLD.tag_no AND NOT (OLD.status IN ('received', 'in_process', 'qc', 'packed', 'ready') OR (OLD.status = 'delivered' AND NEW.status = 'received')) THEN
    RAISE EXCEPTION 'A garment is re-tagged only while it is in the shop' USING ERRCODE = '23514';
  END IF;
  IF NEW.line_id IS NOT NULL AND NEW.line_id IS DISTINCT FROM OLD.line_id AND NOT EXISTS (
       SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
       WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id AND l.sku_id = NEW.sku_id
         AND d.kind = 'sale' AND d.contact_id = o.contact_id) THEN
    RAISE EXCEPTION 'Garment % is billed on a line of its own item, on a bill to the order''s customer', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'received' AND NEW.status IN ('in_process', 'qc', 'packed', 'ready', 'cancelled'))
    OR (OLD.status = 'in_process' AND NEW.status IN ('qc', 'packed', 'ready', 'cancelled'))
    OR (OLD.status = 'qc' AND NEW.status IN ('in_process', 'packed', 'ready', 'cancelled'))
    OR (OLD.status = 'packed' AND NEW.status IN ('in_process', 'ready', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('in_process', 'delivered', 'cancelled'))
    OR (OLD.status = 'delivered' AND NEW.status = 'received')) THEN
    RAISE EXCEPTION 'Garment % cannot go from % to %', OLD.tag_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  -- The quality check passes at QC, and a garment goes back to be washed again from QC one rewash at a time.
  IF NEW.qc_at IS NOT NULL AND NEW.qc_at IS DISTINCT FROM OLD.qc_at AND OLD.status <> 'qc' THEN
    RAISE EXCEPTION 'Garment % passes its quality check at QC', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.rewashes <> OLD.rewashes AND NOT (OLD.status = 'qc' AND NEW.status = 'in_process' AND NEW.rewashes = OLD.rewashes + 1) THEN
    RAISE EXCEPTION 'Garment % is sent back to be washed again from its quality check', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NEW.status IN ('packed', 'ready') THEN
    SELECT qc_required, packing_required INTO s FROM laundry_settings WHERE business_id = NEW.business_id;
    IF COALESCE(s.qc_required, FALSE) AND NEW.qc_at IS NULL THEN
      RAISE EXCEPTION 'Garment % passes its quality check before it is packed or ready', OLD.tag_no USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'ready' AND COALESCE(s.packing_required, FALSE) AND OLD.status <> 'packed' THEN
      RAISE EXCEPTION 'Garment % is packed before it goes on the rack', OLD.tag_no USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Pieces leave in a handover made now, once billed; a garment taken back in for reprocessing starts again.
  IF NEW.pieces_delivered <> OLD.pieces_delivered THEN
    IF NOT ((NEW.pieces_delivered > OLD.pieces_delivered AND OLD.status = 'ready')
         OR (OLD.status = 'delivered' AND NEW.status = 'received' AND NEW.pieces_delivered = 0)) THEN
      RAISE EXCEPTION 'Garment % is handed over piece by piece only while it is ready', OLD.tag_no USING ERRCODE = '23514';
    END IF;
    IF NEW.pieces_delivered > OLD.pieces_delivered THEN
      IF NEW.line_id IS NULL THEN
        RAISE EXCEPTION 'Garment % is handed over with its bill', OLD.tag_no USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM laundry_delivery_items di JOIN laundry_deliveries d ON d.business_id = di.business_id AND d.id = di.delivery_id
                     WHERE di.business_id = NEW.business_id AND di.item_id = NEW.id AND d.created_at = now()) THEN
        RAISE EXCEPTION 'Garment % is handed over in a handover of its order', OLD.tag_no USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF NEW.status = 'delivered' AND OLD.status <> 'delivered' THEN
    IF NEW.line_id IS NULL THEN
      RAISE EXCEPTION 'Garment % is handed over with its bill', OLD.tag_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM laundry_delivery_items di JOIN laundry_deliveries d ON d.business_id = di.business_id AND d.id = di.delivery_id
                   WHERE di.business_id = NEW.business_id AND di.item_id = NEW.id AND d.created_at = now()) THEN
      RAISE EXCEPTION 'Garment % is handed over in a handover of its order', OLD.tag_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'delivered' AND NEW.status = 'received' AND NOT EXISTS (
       SELECT 1 FROM laundry_claims WHERE business_id = NEW.business_id AND item_id = NEW.id AND decision = 'reprocess' AND decided_at = now()) THEN
    RAISE EXCEPTION 'A delivered garment comes back into the work only for reprocessing under a damage claim' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND OLD.pieces_delivered > 0 THEN
    RAISE EXCEPTION 'Garment % has pieces handed over already: hand over the rest', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.line_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM business_return_lines WHERE business_id = NEW.business_id AND line_id = NEW.line_id)
     AND EXISTS (SELECT 1 FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.line_id AND net + tax > 0) THEN
    RAISE EXCEPTION 'Garment % is billed: it is cancelled with a credit note on its bill line', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- What a package holds now: what it was sold with and carried in, less what
-- garments not cancelled drew from it and what was carried on to the next.
CREATE FUNCTION laundry_package_left(business BIGINT, package BIGINT) RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT p.quantity + p.carried_in
    - COALESCE((SELECT sum(n.carried_in) FROM laundry_packages n WHERE n.business_id = p.business_id AND n.carried_from = p.id), 0)
    - COALESCE((SELECT sum(i.package_quantity) FROM laundry_order_items i WHERE i.business_id = p.business_id AND i.package_id = p.id AND i.status <> 'cancelled'), 0)
  FROM laundry_packages p WHERE p.business_id = business AND p.id = package
$$;

CREATE CONSTRAINT TRIGGER laundry_order_items_package_holds AFTER INSERT OR UPDATE OF status, package_id, package_quantity ON laundry_order_items
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (NEW.package_id IS NOT NULL) EXECUTE FUNCTION laundry_package_holds();

-- --- Photos and the customer's signature -------------------------------------------------------------

CREATE TABLE laundry_files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  -- The garment a photo is of (none for the customer's signature).
  item_id BIGINT,
  -- The order's customer, for the access export.
  contact_id BIGINT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('intake', 'qc')),
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'signature')),
  stored_name VARCHAR(80) NOT NULL CHECK (stored_name ~ '^[a-f0-9]{32}\.(jpg|png|webp)$'),
  file_name VARCHAR(150) NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES laundry_orders(business_id, id),
  FOREIGN KEY (business_id, order_id, item_id) REFERENCES laundry_order_items(business_id, order_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  UNIQUE (business_id, stored_name),
  CHECK ((kind = 'photo') = (item_id IS NOT NULL)),
  CHECK (kind = 'photo' OR stage = 'intake')
);
CREATE INDEX laundry_files_order ON laundry_files(business_id, order_id, id);
-- One signature an order.
CREATE UNIQUE INDEX laundry_files_signature ON laundry_files(business_id, order_id) WHERE kind = 'signature';

-- A photo or signature is kept as it was taken, of its order's customer: a
-- photo at intake while its garment is received, at the quality check while
-- it is in the shop past that; the signature while the order has garments in
-- the shop.
CREATE FUNCTION laundry_files_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD; state TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A photo or signature of a garment order is kept as it was taken' USING ERRCODE = '23514';
  END IF;
  SELECT order_no, contact_id INTO o FROM laundry_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF NEW.contact_id <> o.contact_id THEN
    RAISE EXCEPTION 'A photo or signature of order % is in its customer''s name', o.order_no USING ERRCODE = '23514';
  END IF;
  IF NEW.item_id IS NOT NULL THEN
    SELECT status INTO state FROM laundry_order_items WHERE business_id = NEW.business_id AND id = NEW.item_id;
    IF (NEW.stage = 'intake' AND state <> 'received') OR (NEW.stage = 'qc' AND state NOT IN ('in_process', 'qc', 'packed', 'ready')) THEN
      RAISE EXCEPTION 'A photo at intake is taken while the garment is received, and one at its quality check while it is in the work or ready' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM laundry_order_items WHERE business_id = NEW.business_id AND order_id = NEW.order_id AND status IN ('received', 'in_process', 'qc', 'packed', 'ready')) THEN
    RAISE EXCEPTION 'Order % has no garment left in the shop to sign for', o.order_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laundry_files_guard BEFORE INSERT OR UPDATE OR DELETE ON laundry_files
  FOR EACH ROW EXECUTE FUNCTION laundry_files_guard();

-- Down Migration
DROP TRIGGER laundry_files_guard ON laundry_files;
DROP TABLE laundry_files;
DROP FUNCTION laundry_files_guard();

DROP TRIGGER laundry_order_items_package_holds ON laundry_order_items;

CREATE OR REPLACE FUNCTION laundry_order_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment on an order is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['tag_no', 'status', 'rack', 'ready_at', 'ready_by', 'delivered_at', 'delivered_by', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'cancel_key',
        'document_id', 'line_id', 'credit_key'])
     <> (to_jsonb(OLD) - ARRAY['tag_no', 'status', 'rack', 'ready_at', 'ready_by', 'delivered_at', 'delivered_by', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'cancel_key',
        'document_id', 'line_id', 'credit_key']) THEN
    RAISE EXCEPTION 'A garment keeps what was noted and priced when it was taken in' USING ERRCODE = '23514';
  END IF;
  SELECT order_no, contact_id INTO o FROM laundry_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Garment % on order % was cancelled and no longer changes', OLD.tag_no, o.order_no USING ERRCODE = '23514';
  END IF;
  IF OLD.line_id IS NOT NULL AND (NEW.line_id IS DISTINCT FROM OLD.line_id OR NEW.document_id IS DISTINCT FROM OLD.document_id) THEN
    RAISE EXCEPTION 'Garment % keeps the bill line that charges it', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF OLD.credit_key IS NOT NULL AND NEW.credit_key IS DISTINCT FROM OLD.credit_key THEN
    RAISE EXCEPTION 'Garment % is credited once', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.tag_no <> OLD.tag_no AND NOT (OLD.status IN ('received', 'in_process', 'ready') OR (OLD.status = 'delivered' AND NEW.status = 'received')) THEN
    RAISE EXCEPTION 'A garment is re-tagged only while it is in the shop' USING ERRCODE = '23514';
  END IF;
  IF NEW.line_id IS NOT NULL AND OLD.line_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
       WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id AND l.sku_id = NEW.sku_id
         AND d.kind = 'sale' AND d.contact_id = o.contact_id) THEN
    RAISE EXCEPTION 'Garment % is billed on a line of its own item, on a bill to the order''s customer', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'received' AND NEW.status IN ('in_process', 'ready', 'cancelled'))
    OR (OLD.status = 'in_process' AND NEW.status IN ('ready', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('in_process', 'delivered', 'cancelled'))
    OR (OLD.status = 'delivered' AND NEW.status = 'received')) THEN
    RAISE EXCEPTION 'Garment % cannot go from % to %', OLD.tag_no, replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'delivered' AND OLD.status <> 'delivered' THEN
    IF NEW.line_id IS NULL THEN
      RAISE EXCEPTION 'Garment % is handed over with its bill', OLD.tag_no USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM laundry_delivery_items di JOIN laundry_deliveries d ON d.business_id = di.business_id AND d.id = di.delivery_id
                   WHERE di.business_id = NEW.business_id AND di.item_id = NEW.id AND d.created_at = now()) THEN
      RAISE EXCEPTION 'Garment % is handed over in a handover of its order', OLD.tag_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status = 'delivered' AND NEW.status = 'received' AND NOT EXISTS (
       SELECT 1 FROM laundry_claims WHERE business_id = NEW.business_id AND item_id = NEW.id AND decision = 'reprocess' AND decided_at = now()) THEN
    RAISE EXCEPTION 'A delivered garment comes back into the work only for reprocessing under a damage claim' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.line_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM business_return_lines WHERE business_id = NEW.business_id AND line_id = NEW.line_id) THEN
    RAISE EXCEPTION 'Garment % is billed: it is cancelled with a credit note on its bill line', OLD.tag_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION laundry_order_items_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD;
BEGIN
  SELECT order_no, created_at, document_id INTO o FROM laundry_orders WHERE business_id = NEW.business_id AND id = NEW.order_id;
  IF o.created_at <> now() THEN
    RAISE EXCEPTION 'Garments go on order % when it is taken in: take in a new order for more', o.order_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'received' OR NEW.ready_at IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.credit_key IS NOT NULL THEN
    RAISE EXCEPTION 'A garment starts as received, with nothing delivered, cancelled or credited' USING ERRCODE = '23514';
  END IF;
  IF NEW.sku_id IS DISTINCT FROM (SELECT sku_id FROM laundry_services WHERE business_id = NEW.business_id AND id = NEW.service_id) THEN
    RAISE EXCEPTION 'A garment is billed as the item of its service' USING ERRCODE = '23514';
  END IF;
  IF NEW.counted_as IS DISTINCT FROM (SELECT counted_as FROM laundry_garment_types WHERE business_id = NEW.business_id AND id = NEW.garment_type_id) THEN
    RAISE EXCEPTION 'A garment is counted as its kind of garment is' USING ERRCODE = '23514';
  END IF;
  IF (o.document_id IS NULL) <> (NEW.line_id IS NULL) OR (NEW.line_id IS NOT NULL AND (NEW.document_id IS DISTINCT FROM o.document_id
     OR NOT EXISTS (SELECT 1 FROM business_document_lines WHERE business_id = NEW.business_id AND id = NEW.line_id AND document_id = NEW.document_id AND sku_id = NEW.sku_id))) THEN
    RAISE EXCEPTION 'A garment of an order billed at intake is on a line of the order''s own bill, of its own item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION laundry_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A garment order is never deleted; cancel its garments instead' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['promised_on', 'notes', 'updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['promised_on', 'notes', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'A garment order keeps its number, customer, rules, prices and terms as it was taken in' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TABLE laundry_item_changes;
ALTER TABLE laundry_delivery_items DROP COLUMN pieces;

DROP INDEX laundry_order_items_package;
DROP INDEX laundry_order_items_open;
CREATE INDEX laundry_order_items_open ON laundry_order_items(business_id, status, ready_at) WHERE status IN ('received', 'in_process', 'ready');
DROP INDEX laundry_order_items_open_tag;
CREATE UNIQUE INDEX laundry_order_items_open_tag ON laundry_order_items(business_id, tag_no) WHERE status IN ('received', 'in_process', 'ready');
-- Refuses while a garment is at its quality check or packed, or priced by the square foot (restore a backup instead).
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_check6,
  ADD CONSTRAINT laundry_order_items_check6 CHECK (status NOT IN ('received', 'in_process') OR ready_at IS NULL);
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_check1,
  ADD CONSTRAINT laundry_order_items_check1 CHECK (amount = base + surcharge);
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_amount_check,
  ADD CONSTRAINT laundry_order_items_amount_check CHECK (amount > 0);
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_check,
  ADD CONSTRAINT laundry_order_items_check CHECK (per = 'kg' OR quantity = trunc(quantity));
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_per_check,
  ADD CONSTRAINT laundry_order_items_per_check CHECK (per IN ('item', 'kg'));
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_status_check,
  ADD CONSTRAINT laundry_order_items_status_check CHECK (status IN ('received', 'in_process', 'ready', 'delivered', 'cancelled'));
ALTER TABLE laundry_order_items DROP CONSTRAINT laundry_order_items_pieces_delivered,
  DROP CONSTRAINT laundry_order_items_added, DROP CONSTRAINT laundry_order_items_back_in_work, DROP CONSTRAINT laundry_order_items_packed,
  DROP CONSTRAINT laundry_order_items_packed_by, DROP CONSTRAINT laundry_order_items_qc_by, DROP CONSTRAINT laundry_order_items_offer,
  DROP CONSTRAINT laundry_order_items_package, DROP CONSTRAINT laundry_order_items_override, DROP CONSTRAINT laundry_order_items_area,
  DROP CONSTRAINT laundry_order_items_addition_fkey, DROP CONSTRAINT laundry_order_items_offer_fkey, DROP CONSTRAINT laundry_order_items_package_fkey,
  DROP CONSTRAINT laundry_order_items_override_fkey,
  DROP COLUMN added_at, DROP COLUMN added_by, DROP COLUMN addition_id, DROP COLUMN pieces_delivered, DROP COLUMN rewashes, DROP COLUMN packed_by, DROP COLUMN packed_at,
  DROP COLUMN qc_by, DROP COLUMN qc_at, DROP COLUMN discount_amount, DROP COLUMN offer_amount, DROP COLUMN offer_percent, DROP COLUMN offer_name, DROP COLUMN offer_id,
  DROP COLUMN package_amount, DROP COLUMN package_quantity, DROP COLUMN package_id, DROP COLUMN price_override_id, DROP COLUMN price_source, DROP COLUMN width_ft,
  DROP COLUMN length_ft;
DROP TABLE laundry_order_additions;
ALTER TABLE laundry_orders DROP CONSTRAINT laundry_orders_discount_shape, DROP COLUMN discount_reason, DROP COLUMN discount_amount, DROP COLUMN discount_percent;

DROP TRIGGER business_document_lines_laundry_plan ON business_document_lines;
DROP FUNCTION laundry_plan_line_sold();
DROP TRIGGER business_return_lines_laundry_package ON business_return_lines;
DROP FUNCTION laundry_package_line_return();
DROP TABLE laundry_packages, laundry_plan_services, laundry_plans;
DROP FUNCTION laundry_package_holds();
DROP FUNCTION laundry_packages_guard();
DROP FUNCTION laundry_package_left(BIGINT, BIGINT);
DROP FUNCTION laundry_plans_guard();

DROP TABLE laundry_price_overrides, laundry_group_members, laundry_customer_groups;
DROP FUNCTION laundry_price_overrides_guard();

-- Refuses while a price is by the square foot (restore a backup instead).
ALTER TABLE laundry_prices DROP CONSTRAINT laundry_prices_per_check,
  ADD CONSTRAINT laundry_prices_per_check CHECK (per IN ('item', 'kg'));
ALTER TABLE laundry_services DROP COLUMN express_days, DROP COLUMN ready_days;
ALTER TABLE laundry_settings DROP COLUMN packing_required, DROP COLUMN qc_required, DROP COLUMN closed_days, DROP COLUMN area_rounding;
