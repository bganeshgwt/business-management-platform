-- Up Migration
-- GST rates by date. From the 57th GST Council (8 October 2026) GST rates
-- change once a year: announced ahead, in force from 1 April. A GST rate
-- change moves items to another GST rate from a date: a shop's catalogue items
-- to one of its slabs (business_tax_rates), a restaurant's dishes to one of
-- its tax rates (tax_rates). It is entered ahead, can be cancelled before its
-- date, and once its date comes it is kept for good with who entered it and
-- why. A bill already posted never changes: its lines keep the rate they were
-- posted at.
--
-- One model serves both engines, as tasks do: the change and its items are
-- keyed on business_id (a restaurant reaches them through
-- restaurant_business_id()), and only what moves differs, a catalogue item
-- (sku_id) or a dish (product_id). business_tax_change_world() keeps every
-- pointer inside the business.
--
-- How a change takes effect, with no job runner: lazily, in the database.
-- business_tax_change_apply(business) and
-- business_tax_change_apply_menu(restaurant, day) apply, in date order, every
-- scheduled item whose date has come: the item takes the new rate (and, when
-- the change keeps the price before GST, the price that keeps it), the item
-- row records what it was and became, and the activity log gets a row in the
-- name of the person who entered the change. A rate is read from the item, as
-- it always was, so each read and posting needs only that due changes are
-- applied before it:
--   - a shop: the server applies them as a request opens a business (the
--     same statement that loads the membership says whether one is due), and
--     again inside every posting, under the business's lock. A posting whose
--     priced lines were read before a change took effect, or that began on
--     the day before a change another request has just applied, is refused
--     with "try again": around midnight only.
--   - a restaurant: the server applies them for its trading day (the main
--     counter's open business day, else its date less the morning cut-off)
--     before the menu screens and the guests' menus are read, and for each
--     order's own business day before its dishes are priced. A dish priced for
--     a business day before a change already applied (an outlet still on last
--     night's day) is priced as it was before the change.
-- So the slab used is always the one in force on the bill's own date, read
-- from one place, and nothing waits for a job. The alternative, working out
-- the rate by date in every query that reads it, would have had to change
-- every reader in every business type; this way they read the item as before.

-- --- The changes ------------------------------------------------------------------

CREATE TABLE business_tax_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The first day of the new rate, on the business's or restaurant's own date.
  starts_on DATE NOT NULL,
  -- What the items move to: a shop's GST slab, or a restaurant's tax rate.
  tax_rate_id BIGINT,
  restaurant_tax_rate_id BIGINT REFERENCES tax_rates(id),
  -- Its percentage when the change was entered.
  rate NUMERIC(5,2) NOT NULL CHECK (rate BETWEEN 0 AND 100),
  -- What a price that includes GST keeps: its total (the GST inside it is
  -- worked out again), or its part before GST (the price changes with the
  -- rate). A price before GST keeps itself either way.
  keeps TEXT NOT NULL DEFAULT 'total' CHECK (keeps IN ('total', 'net')),
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, id, starts_on),
  UNIQUE (business_id, request_key),
  FOREIGN KEY (business_id, tax_rate_id) REFERENCES business_tax_rates(business_id, id),
  CHECK ((tax_rate_id IS NULL) <> (restaurant_tax_rate_id IS NULL))
);
CREATE INDEX business_tax_changes_list ON business_tax_changes(business_id, starts_on DESC, id DESC);

-- Each item a change moves, and what happened to it.
CREATE TABLE business_tax_change_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  change_id BIGINT NOT NULL,
  -- The change's date, here too so the due items are one index away.
  starts_on DATE NOT NULL,
  sku_id BIGINT,
  product_id BIGINT REFERENCES products(id),
  -- scheduled: waiting for its date; applied: in force since its date;
  -- cancelled: before its date; refused: on its date the database refused it
  -- (a fuel stays on the nil slab), with the reason in note.
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'applied', 'cancelled', 'refused')),
  -- What the item was and became, kept when its date comes.
  from_tax_rate_id BIGINT,
  from_restaurant_tax_rate_id BIGINT REFERENCES tax_rates(id),
  from_rate NUMERIC(5,2),
  to_rate NUMERIC(5,2),
  price_before NUMERIC(14,2),
  price_after NUMERIC(14,2),
  -- A dish's sizes when its price changed with the rate: [{id, name, before, after}] (price differences).
  sizes JSONB,
  settled_at TIMESTAMPTZ,
  note VARCHAR(500),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  cancel_reason VARCHAR(300),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, change_id, starts_on) REFERENCES business_tax_changes(business_id, id, starts_on),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, from_tax_rate_id) REFERENCES business_tax_rates(business_id, id),
  CHECK ((sku_id IS NULL) <> (product_id IS NULL)),
  CHECK ((status IN ('applied', 'refused')) = (settled_at IS NOT NULL AND from_rate IS NOT NULL AND to_rate IS NOT NULL)),
  CHECK ((status = 'applied') = (price_before IS NOT NULL AND price_after IS NOT NULL)),
  CHECK (status <> 'refused' OR note IS NOT NULL),
  CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND btrim(cancel_reason) <> ''))
);
-- An item moves once on a day.
CREATE UNIQUE INDEX business_tax_change_items_one_sku_a_day ON business_tax_change_items(business_id, sku_id, starts_on)
  WHERE status = 'scheduled' AND sku_id IS NOT NULL;
CREATE UNIQUE INDEX business_tax_change_items_one_dish_a_day ON business_tax_change_items(product_id, starts_on)
  WHERE status = 'scheduled' AND product_id IS NOT NULL;
-- What is due, asked on every request that opens a business.
CREATE INDEX business_tax_change_items_due ON business_tax_change_items(business_id, starts_on) WHERE status = 'scheduled';
CREATE INDEX business_tax_change_items_change ON business_tax_change_items(business_id, change_id);
CREATE INDEX business_tax_change_items_sku ON business_tax_change_items(business_id, sku_id) WHERE sku_id IS NOT NULL;
CREATE INDEX business_tax_change_items_product ON business_tax_change_items(product_id) WHERE product_id IS NOT NULL;

-- --- Kept in the business, kept for good ------------------------------------------------

-- A shop's change moves its catalogue items to one of its slabs; a
-- restaurant's moves its dishes to one of its tax rates.
CREATE FUNCTION business_tax_change_world() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  restaurant BIGINT;
  dishes BOOLEAN;
BEGIN
  SELECT legacy_restaurant_id INTO restaurant FROM businesses WHERE id = NEW.business_id;
  IF TG_TABLE_NAME = 'business_tax_changes' THEN
    IF restaurant IS NULL AND NEW.restaurant_tax_rate_id IS NOT NULL THEN
      RAISE EXCEPTION 'A shop''s items move to one of its own GST slabs' USING ERRCODE = '23514';
    END IF;
    IF restaurant IS NOT NULL AND (NEW.tax_rate_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM tax_rates WHERE id = NEW.restaurant_tax_rate_id AND restaurant_id = restaurant)) THEN
      RAISE EXCEPTION 'That tax rate is not part of this restaurant' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT restaurant_tax_rate_id IS NOT NULL INTO dishes FROM business_tax_changes WHERE business_id = NEW.business_id AND id = NEW.change_id;
    IF dishes AND (NEW.product_id IS NULL OR restaurant IS NULL OR NOT EXISTS (
        SELECT 1 FROM products WHERE id = NEW.product_id AND restaurant_id = restaurant)) THEN
      RAISE EXCEPTION 'That dish is not on this restaurant''s menu' USING ERRCODE = '23514';
    END IF;
    IF NOT dishes AND NEW.sku_id IS NULL THEN
      RAISE EXCEPTION 'A shop''s change moves its catalogue items' USING ERRCODE = '23514';
    END IF;
    IF NEW.from_restaurant_tax_rate_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tax_rates WHERE id = NEW.from_restaurant_tax_rate_id AND restaurant_id = restaurant) THEN
      RAISE EXCEPTION 'That tax rate is not part of this restaurant' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_tax_changes_world BEFORE INSERT ON business_tax_changes
  FOR EACH ROW EXECUTE FUNCTION business_tax_change_world();
CREATE TRIGGER business_tax_change_items_world BEFORE INSERT OR UPDATE ON business_tax_change_items
  FOR EACH ROW EXECUTE FUNCTION business_tax_change_world();

-- A change is kept as it was entered.
CREATE FUNCTION business_tax_changes_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A GST rate change is kept as it was entered: cancel it, or enter another change' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_tax_changes_kept BEFORE UPDATE OR DELETE ON business_tax_changes
  FOR EACH ROW EXECUTE FUNCTION business_tax_changes_kept();

-- The business's date for a change: a shop's calendar date in its time zone;
-- a restaurant's trading day (business-day/services/tradingDay.js): the main
-- counter's open business day, else its date less the morning cut-off.
CREATE FUNCTION restaurant_trading_date(target_restaurant BIGINT) RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT max(business_date) FROM business_days WHERE restaurant_id = target_restaurant AND outlet_id IS NULL AND day_status = 'open'),
    (SELECT ((now() AT TIME ZONE COALESCE(max(timezone), 'Asia/Kolkata')) - make_interval(hours => COALESCE(max(day_cutoff_hour), 5)::int))::date
     FROM restaurant_settings WHERE restaurant_id = target_restaurant));
$$;
CREATE FUNCTION business_tax_change_today(target BIGINT) RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN b.legacy_restaurant_id IS NULL THEN (now() AT TIME ZONE b.timezone)::date
    ELSE restaurant_trading_date(b.legacy_restaurant_id) END
  FROM businesses b WHERE b.id = target;
$$;

-- An item's change is taken up once: applied or refused when its date comes,
-- or cancelled before it. Nothing else about it ever changes.
CREATE FUNCTION business_tax_change_items_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A GST rate change is kept for good: cancel it before its date instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This GST rate change was % and is kept as it is', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'scheduled' THEN
    RAISE EXCEPTION 'A scheduled GST rate change is taken up on its date, or cancelled before it' USING ERRCODE = '23514';
  END IF;
  IF (NEW.business_id, NEW.change_id, NEW.starts_on, NEW.sku_id, NEW.product_id) IS DISTINCT FROM
     (OLD.business_id, OLD.change_id, OLD.starts_on, OLD.sku_id, OLD.product_id) THEN
    RAISE EXCEPTION 'What a GST rate change moves, and from when, never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.starts_on <= business_tax_change_today(NEW.business_id) THEN
    RAISE EXCEPTION 'This GST rate change starts on % and is in force: it is kept for good. Enter another change to move the item again.',
      to_char(NEW.starts_on, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_tax_change_items_kept BEFORE UPDATE OR DELETE ON business_tax_change_items
  FOR EACH ROW EXECUTE FUNCTION business_tax_change_items_kept();

-- A rate items are to move to stays on until then.
CREATE FUNCTION business_tax_rates_in_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  first_day DATE;
BEGIN
  IF TG_TABLE_NAME = 'business_tax_rates' THEN
    IF OLD.active AND NOT NEW.active THEN
      SELECT min(i.starts_on) INTO first_day FROM business_tax_change_items i
        JOIN business_tax_changes c ON c.business_id = i.business_id AND c.id = i.change_id
        WHERE c.business_id = NEW.business_id AND c.tax_rate_id = NEW.id AND i.status = 'scheduled';
    END IF;
  ELSIF OLD.status = 'active' AND NEW.status <> 'active' THEN
    SELECT min(i.starts_on) INTO first_day FROM business_tax_change_items i
      JOIN business_tax_changes c ON c.business_id = i.business_id AND c.id = i.change_id
      WHERE c.restaurant_tax_rate_id = NEW.id AND i.status = 'scheduled';
  END IF;
  IF first_day IS NOT NULL THEN
    RAISE EXCEPTION 'Items move to % on % (a scheduled GST rate change): keep it on, or cancel that change first', NEW.name, to_char(first_day, 'DD Mon YYYY')
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_tax_rates_in_change BEFORE UPDATE OF active ON business_tax_rates
  FOR EACH ROW EXECUTE FUNCTION business_tax_rates_in_change();
CREATE TRIGGER tax_rates_in_change BEFORE UPDATE OF status ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION business_tax_rates_in_change();

-- --- Taking effect --------------------------------------------------------------------

-- A price that includes GST, keeping its part before GST at a new rate: to the
-- paisa, half a paisa up (the API's preview works it out the same way).
CREATE FUNCTION business_tax_change_price(price NUMERIC, from_rate NUMERIC, to_rate NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT (((round(price * 100)::bigint * (10000 + round(to_rate * 100)::bigint) * 2 + (10000 + round(from_rate * 100)::bigint))
    / ((10000 + round(from_rate * 100)::bigint) * 2)) / 100.0)::numeric(14,2);
$$;

-- A shop's items whose change is due on the business's date take it, in date
-- order. Returns the items applied now. A change the database refuses (a fuel
-- stays on the nil slab, a jewellery item at 3%) is kept as refused, with why.
CREATE FUNCTION business_tax_change_apply(target BIGINT) RETURNS BIGINT[] LANGUAGE plpgsql AS $$
DECLARE
  due_by DATE;
  inclusive BOOLEAN;
  item RECORD;
  sku RECORD;
  price_now NUMERIC;
  shelf NUMERIC;
  remark TEXT;
  done BIGINT[] := '{}';
BEGIN
  SELECT (now() AT TIME ZONE b.timezone)::date INTO due_by FROM businesses b WHERE b.id = target AND b.legacy_restaurant_id IS NULL;
  IF due_by IS NULL OR NOT EXISTS (SELECT 1 FROM business_tax_change_items
      WHERE business_id = target AND status = 'scheduled' AND starts_on <= due_by AND sku_id IS NOT NULL) THEN
    RETURN done;
  END IF;
  -- The lock every posting takes first: a bill sees all of a change or none of it.
  PERFORM 1 FROM businesses WHERE id = target FOR UPDATE;
  inclusive := COALESCE((SELECT tax_mode = 'inclusive' FROM business_settings WHERE business_id = target), FALSE);
  FOR item IN
    SELECT i.id, i.sku_id, i.starts_on, c.id AS change_id, c.tax_rate_id AS to_slab, t.rate AS to_rate, t.name AS to_name,
      c.keeps, c.reason, c.created_by
    FROM business_tax_change_items i
    JOIN business_tax_changes c ON c.business_id = i.business_id AND c.id = i.change_id
    JOIN business_tax_rates t ON t.business_id = c.business_id AND t.id = c.tax_rate_id
    WHERE i.business_id = target AND i.status = 'scheduled' AND i.starts_on <= due_by AND i.sku_id IS NOT NULL
    ORDER BY i.starts_on, i.id
    FOR UPDATE OF i
  LOOP
    SELECT s.*, f.name AS slab_name INTO sku FROM catalog_skus s
      LEFT JOIN business_tax_rates f ON f.business_id = s.business_id AND f.id = s.tax_rate_id
      WHERE s.business_id = target AND s.id = item.sku_id FOR UPDATE OF s;
    remark := NULL;
    price_now := sku.price;
    IF item.keeps = 'net' AND inclusive AND sku.tax_rate <> item.to_rate THEN
      price_now := business_tax_change_price(sku.price, sku.tax_rate, item.to_rate);
      IF sku.mrp IS NOT NULL AND price_now > sku.mrp THEN
        remark := format('Its price stays at %s: %s would be above its MRP of %s.', sku.price, price_now, sku.mrp);
        price_now := sku.price;
      END IF;
    END IF;
    IF NOT inclusive AND sku.mrp IS NOT NULL THEN
      shelf := price_now + round(price_now * item.to_rate / 100, 2);
      IF shelf > sku.mrp THEN
        remark := format('With GST at %s%% it sells at %s, above its MRP of %s: lower its price or correct the MRP before billing it.',
          rtrim(rtrim(item.to_rate::text, '0'), '.'), shelf, sku.mrp);
      END IF;
    END IF;
    BEGIN
      IF item.to_rate <> 3 AND EXISTS (SELECT 1 FROM jewellery_items j WHERE j.business_id = target AND j.sku_id = sku.id) THEN
        RAISE EXCEPTION '% is a jewellery item: jewellery is billed at 3%% GST', sku.label USING ERRCODE = '23514';
      END IF;
      UPDATE catalog_skus SET tax_rate_id = item.to_slab, tax_rate = item.to_rate, price = price_now,
        member_price = CASE WHEN member_price IS NULL OR price_now = sku.price THEN member_price
          ELSE business_tax_change_price(member_price, sku.tax_rate, item.to_rate) END
        WHERE business_id = target AND id = sku.id;
      IF price_now <> sku.price THEN
        UPDATE business_sku_location_prices SET price = business_tax_change_price(price, sku.tax_rate, item.to_rate), updated_by = item.created_by, updated_at = now()
          WHERE business_id = target AND sku_id = sku.id;
      END IF;
      UPDATE business_tax_change_items SET status = 'applied', settled_at = clock_timestamp(), from_tax_rate_id = sku.tax_rate_id,
        from_rate = sku.tax_rate, to_rate = item.to_rate, price_before = sku.price, price_after = price_now, note = remark
        WHERE id = item.id;
      INSERT INTO business_audit (business_id, actor_id, action, entity_id, details)
      VALUES (target, item.created_by, 'catalog.tax_changed', sku.id, jsonb_build_object('label', sku.label, 'changeId', item.change_id,
        'startsOn', item.starts_on, 'reason', item.reason, 'from', COALESCE(sku.slab_name, sku.tax_rate::text || '%'), 'to', item.to_name,
        'fromRate', sku.tax_rate, 'toRate', item.to_rate, 'priceFrom', sku.price, 'priceTo', price_now));
      done := done || sku.id;
    EXCEPTION WHEN check_violation THEN
      UPDATE business_tax_change_items SET status = 'refused', settled_at = clock_timestamp(), from_tax_rate_id = sku.tax_rate_id,
        from_rate = sku.tax_rate, to_rate = item.to_rate, note = left(SQLERRM, 500)
        WHERE id = item.id;
    END;
  END LOOP;
  -- A kit's own rate is the highest of its parts' (its MRP check uses it).
  UPDATE catalog_skus k SET tax_rate = x.rate,
    tax_rate_id = (SELECT t.id FROM business_tax_rates t WHERE t.business_id = target AND t.rate = x.rate AND t.active ORDER BY t.is_default DESC, t.id LIMIT 1)
  FROM (SELECT c.kit_sku_id, max(s.tax_rate) AS rate FROM catalog_kit_components c
      JOIN catalog_skus s ON s.business_id = c.business_id AND s.id = c.component_sku_id
      WHERE c.business_id = target AND c.kit_sku_id IN (SELECT kit_sku_id FROM catalog_kit_components WHERE business_id = target AND component_sku_id = ANY (done))
      GROUP BY c.kit_sku_id) x
  WHERE k.business_id = target AND k.id = x.kit_sku_id AND k.tax_rate <> x.rate;
  RETURN done;
END $$;

-- A restaurant's dishes whose change is due on `upto` (the business day being
-- priced; NULL: its trading day) take it, in date order. Returns the dishes
-- applied now. One change at a time with the menu's imports and price
-- revisions (their lock).
CREATE FUNCTION business_tax_change_apply_menu(target_restaurant BIGINT, upto DATE) RETURNS BIGINT[] LANGUAGE plpgsql AS $$
DECLARE
  biz BIGINT;
  due_by DATE;
  inclusive_default BOOLEAN;
  item RECORD;
  dish RECORD;
  inclusive BOOLEAN;
  price_now NUMERIC;
  shelf NUMERIC;
  remark TEXT;
  resized JSONB;
  done BIGINT[] := '{}';
BEGIN
  SELECT id INTO biz FROM businesses WHERE legacy_restaurant_id = target_restaurant;
  IF biz IS NULL THEN
    RETURN done;
  END IF;
  due_by := COALESCE(upto, restaurant_trading_date(target_restaurant));
  IF NOT EXISTS (SELECT 1 FROM business_tax_change_items
      WHERE business_id = biz AND status = 'scheduled' AND starts_on <= due_by AND product_id IS NOT NULL) THEN
    RETURN done;
  END IF;
  PERFORM pg_advisory_xact_lock(915001, target_restaurant::int);
  inclusive_default := COALESCE((SELECT tax_mode = 'inclusive' FROM restaurant_settings WHERE restaurant_id = target_restaurant), FALSE);
  FOR item IN
    SELECT i.id, i.product_id, i.starts_on, c.id AS change_id, c.restaurant_tax_rate_id AS to_id, t.percentage AS to_rate, t.name AS to_name,
      c.keeps, c.reason, c.created_by
    FROM business_tax_change_items i
    JOIN business_tax_changes c ON c.business_id = i.business_id AND c.id = i.change_id
    JOIN tax_rates t ON t.id = c.restaurant_tax_rate_id
    WHERE i.business_id = biz AND i.status = 'scheduled' AND i.starts_on <= due_by AND i.product_id IS NOT NULL
    ORDER BY i.starts_on, i.id
    FOR UPDATE OF i
  LOOP
    SELECT p.*, f.name AS rate_name INTO dish FROM products p LEFT JOIN tax_rates f ON f.id = p.tax_rate_id
      WHERE p.id = item.product_id FOR UPDATE OF p;
    inclusive := dish.tax_mode = 'inclusive' OR (dish.tax_mode = 'default' AND inclusive_default);
    remark := NULL;
    resized := NULL;
    price_now := dish.price;
    IF item.keeps = 'net' AND inclusive AND dish.tax_percentage <> item.to_rate THEN
      price_now := business_tax_change_price(dish.price, dish.tax_percentage, item.to_rate);
      IF dish.mrp IS NOT NULL AND price_now > dish.mrp THEN
        remark := format('Its price stays at %s: %s would be above its MRP of %s.', dish.price, price_now, dish.mrp);
        price_now := dish.price;
      ELSE
        -- Each size keeps its own price before GST too (a size priced below
        -- nothing, switched off, is left as it is).
        SELECT jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'before', v.price_delta,
            'after', business_tax_change_price(dish.price + v.price_delta, dish.tax_percentage, item.to_rate) - price_now) ORDER BY v.id)
          INTO resized FROM product_variants v WHERE v.product_id = dish.id AND dish.price + v.price_delta >= 0;
      END IF;
    END IF;
    IF NOT inclusive AND dish.mrp IS NOT NULL THEN
      shelf := price_now + round(price_now * item.to_rate / 100, 2);
      IF shelf > dish.mrp THEN
        remark := format('With GST at %s%% it sells at %s, above its MRP of %s: lower its price or correct the MRP before selling it.',
          rtrim(rtrim(item.to_rate::text, '0'), '.'), shelf, dish.mrp);
      END IF;
    END IF;
    BEGIN
      UPDATE products SET tax_rate_id = item.to_id, tax_percentage = item.to_rate, price = price_now, updated_by = item.created_by
        WHERE id = dish.id;
      UPDATE product_variants v SET price_delta = (s->>'after')::numeric
        FROM jsonb_array_elements(COALESCE(resized, '[]'::jsonb)) s WHERE v.id = (s->>'id')::bigint AND v.product_id = dish.id;
      UPDATE business_tax_change_items SET status = 'applied', settled_at = clock_timestamp(), from_restaurant_tax_rate_id = dish.tax_rate_id,
        from_rate = dish.tax_percentage, to_rate = item.to_rate, price_before = dish.price, price_after = price_now, sizes = resized, note = remark
        WHERE id = item.id;
      INSERT INTO audit_logs (restaurant_id, user_id, user_name, action, entity_type, entity_id, entity_label, details)
      SELECT target_restaurant, u.id, u.name, 'update', 'product', dish.id, dish.name,
        jsonb_build_object('via', format('GST rate change of %s: %s', to_char(item.starts_on, 'DD Mon YYYY'), item.reason),
          'changes', jsonb_build_object('taxRate', jsonb_build_array(COALESCE(dish.rate_name, dish.tax_percentage::text || '%'), item.to_name))
            || CASE WHEN price_now <> dish.price THEN jsonb_build_object('price', jsonb_build_array(dish.price, price_now)) ELSE '{}'::jsonb END)
      FROM users u WHERE u.id = item.created_by;
      done := done || dish.id;
    EXCEPTION WHEN check_violation THEN
      UPDATE business_tax_change_items SET status = 'refused', settled_at = clock_timestamp(), from_restaurant_tax_rate_id = dish.tax_rate_id,
        from_rate = dish.tax_percentage, to_rate = item.to_rate, note = left(SQLERRM, 500)
        WHERE id = item.id;
    END;
  END LOOP;
  RETURN done;
END $$;

-- Down Migration
DROP FUNCTION business_tax_change_apply_menu(BIGINT, DATE);
DROP FUNCTION business_tax_change_apply(BIGINT);
DROP FUNCTION business_tax_change_price(NUMERIC, NUMERIC, NUMERIC);
DROP TRIGGER tax_rates_in_change ON tax_rates;
DROP TRIGGER business_tax_rates_in_change ON business_tax_rates;
DROP FUNCTION business_tax_rates_in_change();
DROP TABLE business_tax_change_items;
DROP TABLE business_tax_changes;
DROP FUNCTION business_tax_change_items_kept();
DROP FUNCTION business_tax_changes_kept();
DROP FUNCTION business_tax_change_world();
DROP FUNCTION business_tax_change_today(BIGINT);
DROP FUNCTION restaurant_trading_date(BIGINT);
