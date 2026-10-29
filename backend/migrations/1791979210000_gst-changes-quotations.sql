-- Up Migration
-- The rest of GST rates by date, and of quotations.
--
-- GST rates kept in settings change by date too. Three rates are not an
-- item's own: a fashion shop's GST by price (the price per piece and its two
-- rates), a lodge's two room-night slabs and the limit between them, and a
-- restaurant's default GST rate (its advances' GST is worked out at it). A
-- change of one is entered ahead, like an item's, and the same functions apply
-- it on the business's or restaurant's own date: business_tax_change_apply
-- (a shop's items, then its settings) and business_tax_change_apply_menu (a
-- restaurant's dishes, then its default rate), which every posting, every
-- request that opens a business and every menu read already call. Once in
-- force it is kept for good, with what the setting was before, so the rate of
-- any earlier day can be read back: a restaurant's advances take the default
-- rate of the day they were received. A jewellery item's 3% and a fuel's nil
-- slab stay rules of the code, not settings.
--
--   business_tax_setting_changes  one dated change of one setting: its new
--                                 values, its state (scheduled → applied or
--                                 refused on its date, or cancelled before it),
--                                 what the setting was, why and by whom.
--   business_tax_change_imports   a notification's list of HSN / SAC codes and
--                                 their new rates, as it was given; the changes
--                                 made from it name it (import_id), one or more
--                                 per rate (at most 2,000 items each).
--
-- Quotations:
--   - a kit is quoted as one line (business_quotation_lines.kit_parts keeps
--     each part's share as priced), billed or ordered as its parts at those
--     shares;
--   - part of a quotation is billed: business_quotation_billed keeps each
--     line's quantity and value on each bill, never more than the line holds
--     (checked under the quotation's lock); a quotation is billed when nothing
--     is left, and what is left may still become a sales order;
--   - the business's terms and conditions for quotations
--     (business_settings.quotation_terms) are copied onto each quotation when
--     it is made (business_quotations.terms) and kept with it.

-- --- Rates kept in settings, by date ---------------------------------------------------------

CREATE TABLE business_tax_setting_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- fashion_price: a fashion shop's GST by price; lodging_slabs: a lodge's
  -- room-night slabs; restaurant_default: a restaurant's default GST rate.
  setting TEXT NOT NULL CHECK (setting IN ('fashion_price', 'lodging_slabs', 'restaurant_default')),
  -- The first day of the new values, on the business's or restaurant's own date.
  starts_on DATE NOT NULL,
  -- GST by price: the value of a piece (before GST, after discounts) up to
  -- which the lower rate applies, and the two rates.
  threshold NUMERIC(14,2) CHECK (threshold > 0 AND threshold <= 10000000),
  rate_low NUMERIC(5,2) CHECK (rate_low BETWEEN 0 AND 100),
  rate_high NUMERIC(5,2) CHECK (rate_high BETWEEN 0 AND 100),
  -- Room nights: the slab at or below the limit, the slab above it, the limit.
  low_tax_rate_id BIGINT,
  high_tax_rate_id BIGINT,
  slab_limit NUMERIC(14,2) CHECK (slab_limit > 0 AND slab_limit <= 10000000),
  -- A restaurant's default GST rate.
  rate NUMERIC(5,2) CHECK (rate BETWEEN 0 AND 100),
  -- scheduled: waiting for its date; applied: in force since its date;
  -- cancelled: before its date; refused: on its date the database refused it,
  -- with the reason in note.
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'applied', 'cancelled', 'refused')),
  -- What the setting was when this took effect (the same values, by name).
  before JSONB CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  settled_at TIMESTAMPTZ,
  note VARCHAR(500),
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  cancel_reason VARCHAR(300),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  FOREIGN KEY (business_id, low_tax_rate_id) REFERENCES business_tax_rates(business_id, id),
  FOREIGN KEY (business_id, high_tax_rate_id) REFERENCES business_tax_rates(business_id, id),
  CONSTRAINT business_tax_setting_changes_values CHECK (CASE setting
    WHEN 'fashion_price' THEN threshold IS NOT NULL AND rate_low IS NOT NULL AND rate_high IS NOT NULL AND rate_high >= rate_low
      AND low_tax_rate_id IS NULL AND high_tax_rate_id IS NULL AND slab_limit IS NULL AND rate IS NULL
    WHEN 'lodging_slabs' THEN low_tax_rate_id IS NOT NULL AND high_tax_rate_id IS NOT NULL AND slab_limit IS NOT NULL AND low_tax_rate_id <> high_tax_rate_id
      AND threshold IS NULL AND rate_low IS NULL AND rate_high IS NULL AND rate IS NULL
    ELSE rate IS NOT NULL AND threshold IS NULL AND rate_low IS NULL AND rate_high IS NULL
      AND low_tax_rate_id IS NULL AND high_tax_rate_id IS NULL AND slab_limit IS NULL END),
  CHECK ((status IN ('applied', 'refused')) = (settled_at IS NOT NULL)),
  CHECK ((status = 'applied') = (before IS NOT NULL)),
  CHECK (status <> 'refused' OR note IS NOT NULL),
  CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND btrim(cancel_reason) <> ''))
);
-- A setting changes once on a day.
CREATE UNIQUE INDEX business_tax_setting_changes_one_a_day ON business_tax_setting_changes(business_id, setting, starts_on) WHERE status = 'scheduled';
-- What is due, asked on every request that opens a business.
CREATE INDEX business_tax_setting_changes_due ON business_tax_setting_changes(business_id, starts_on) WHERE status = 'scheduled';
CREATE INDEX business_tax_setting_changes_list ON business_tax_setting_changes(business_id, setting, starts_on DESC, id DESC);

-- A setting belongs to its kind of business: GST by price to a fashion shop,
-- the room-night slabs to a lodging business, the default rate to a restaurant.
CREATE FUNCTION business_tax_setting_change_world() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind TEXT; restaurant BIGINT;
BEGIN
  SELECT business_type, legacy_restaurant_id INTO kind, restaurant FROM businesses WHERE id = NEW.business_id;
  IF NEW.setting = 'fashion_price' AND kind IS DISTINCT FROM 'fashion' THEN
    RAISE EXCEPTION 'GST by price belongs to fashion shops' USING ERRCODE = '23514';
  END IF;
  IF NEW.setting = 'lodging_slabs' AND kind IS DISTINCT FROM 'lodging' THEN
    RAISE EXCEPTION 'Room-night slabs belong to hotels, lodges and guest houses' USING ERRCODE = '23514';
  END IF;
  IF NEW.setting = 'restaurant_default' AND restaurant IS NULL THEN
    RAISE EXCEPTION 'A default GST rate of this kind belongs to a restaurant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_tax_setting_changes_world BEFORE INSERT ON business_tax_setting_changes
  FOR EACH ROW EXECUTE FUNCTION business_tax_setting_change_world();

-- A change is taken up once: applied or refused when its date comes, or
-- cancelled before it. What it changes, to what and from when never changes.
CREATE FUNCTION business_tax_setting_changes_kept() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  settled TEXT[] := ARRAY['status', 'before', 'settled_at', 'note', 'cancelled_by', 'cancelled_at', 'cancel_reason'];
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
  IF (to_jsonb(NEW) - settled) <> (to_jsonb(OLD) - settled) THEN
    RAISE EXCEPTION 'What a GST rate change sets, to what and from when, never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.starts_on <= business_tax_change_today(NEW.business_id) THEN
    RAISE EXCEPTION 'This GST rate change starts on % and is in force: it is kept for good. Enter another change to set it again.',
      to_char(NEW.starts_on, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_tax_setting_changes_kept BEFORE UPDATE OR DELETE ON business_tax_setting_changes
  FOR EACH ROW EXECUTE FUNCTION business_tax_setting_changes_kept();

-- --- A notification's list ------------------------------------------------------------------

-- The list as it was given: [{ code, rate }], with the items it moved and the
-- changes it became. A retry of the same request gives the same changes.
CREATE TABLE business_tax_change_imports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  items INT NOT NULL CHECK (items > 0),
  changes INT NOT NULL CHECK (changes > 0),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key)
);
CREATE FUNCTION business_tax_change_imports_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A notification''s list is kept as it was given' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_tax_change_imports_kept BEFORE UPDATE OR DELETE ON business_tax_change_imports
  FOR EACH ROW EXECUTE FUNCTION business_tax_change_imports_kept();

ALTER TABLE business_tax_changes ADD COLUMN import_id BIGINT,
  ADD FOREIGN KEY (business_id, import_id) REFERENCES business_tax_change_imports(business_id, id);
CREATE INDEX business_tax_changes_import ON business_tax_changes(business_id, import_id) WHERE import_id IS NOT NULL;

-- --- Taking effect --------------------------------------------------------------------

-- A shop's items whose change is due on the business's date take it, in date
-- order; then its settings whose change is due (a fashion shop's GST by
-- price, a lodge's room-night slabs). Returns the items applied now. A change
-- the database refuses (a fuel stays on the nil slab, a jewellery item at 3%,
-- a slab switched off) is kept as refused, with why.
CREATE OR REPLACE FUNCTION business_tax_change_apply(target BIGINT) RETURNS BIGINT[] LANGUAGE plpgsql AS $$
DECLARE
  due_by DATE;
  inclusive BOOLEAN;
  item RECORD;
  sku RECORD;
  pending RECORD;
  was JSONB;
  price_now NUMERIC;
  shelf NUMERIC;
  remark TEXT;
  done BIGINT[] := '{}';
BEGIN
  SELECT (now() AT TIME ZONE b.timezone)::date INTO due_by FROM businesses b WHERE b.id = target AND b.legacy_restaurant_id IS NULL;
  IF due_by IS NULL OR (NOT EXISTS (SELECT 1 FROM business_tax_change_items
      WHERE business_id = target AND status = 'scheduled' AND starts_on <= due_by AND sku_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM business_tax_setting_changes
      WHERE business_id = target AND status = 'scheduled' AND starts_on <= due_by AND setting <> 'restaurant_default')) THEN
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
  -- Its settings, in date order: each takes its new values, and keeps what they were.
  FOR pending IN
    SELECT * FROM business_tax_setting_changes
    WHERE business_id = target AND status = 'scheduled' AND starts_on <= due_by AND setting <> 'restaurant_default'
    ORDER BY starts_on, id
    FOR UPDATE
  LOOP
    BEGIN
      IF pending.setting = 'fashion_price' THEN
        SELECT jsonb_build_object('threshold', threshold, 'rateLow', rate_low, 'rateHigh', rate_high) INTO was
          FROM fashion_gst_price_slabs WHERE business_id = target FOR UPDATE;
        INSERT INTO fashion_gst_price_slabs (business_id, active, threshold, rate_low, rate_high, updated_by, updated_at)
        VALUES (target, FALSE, pending.threshold, pending.rate_low, pending.rate_high, pending.created_by, now())
        ON CONFLICT (business_id) DO UPDATE SET threshold = EXCLUDED.threshold, rate_low = EXCLUDED.rate_low, rate_high = EXCLUDED.rate_high,
          updated_by = EXCLUDED.updated_by, updated_at = now();
      ELSE
        SELECT jsonb_build_object('lowTaxRateId', s.low_tax_rate_id, 'highTaxRateId', s.high_tax_rate_id, 'slabLimit', s.slab_limit,
            'lowName', lo.name, 'lowRate', lo.rate, 'highName', hi.name, 'highRate', hi.rate) INTO was
          FROM lodging_settings s
          LEFT JOIN business_tax_rates lo ON lo.business_id = s.business_id AND lo.id = s.low_tax_rate_id
          LEFT JOIN business_tax_rates hi ON hi.business_id = s.business_id AND hi.id = s.high_tax_rate_id
          WHERE s.business_id = target FOR UPDATE OF s;
        INSERT INTO lodging_settings (business_id, low_tax_rate_id, high_tax_rate_id, slab_limit, updated_by, updated_at)
        VALUES (target, pending.low_tax_rate_id, pending.high_tax_rate_id, pending.slab_limit, pending.created_by, now())
        ON CONFLICT (business_id) DO UPDATE SET low_tax_rate_id = EXCLUDED.low_tax_rate_id, high_tax_rate_id = EXCLUDED.high_tax_rate_id,
          slab_limit = EXCLUDED.slab_limit, updated_by = EXCLUDED.updated_by, updated_at = now();
      END IF;
      UPDATE business_tax_setting_changes SET status = 'applied', settled_at = clock_timestamp(), before = COALESCE(was, '{}'::jsonb)
        WHERE id = pending.id;
      INSERT INTO business_audit (business_id, actor_id, action, entity_id, details)
      VALUES (target, pending.created_by, 'tax_change.setting_applied', pending.id, jsonb_build_object('setting', pending.setting,
        'startsOn', pending.starts_on, 'reason', pending.reason, 'from', COALESCE(was, '{}'::jsonb),
        'to', jsonb_strip_nulls(jsonb_build_object('threshold', pending.threshold, 'rateLow', pending.rate_low, 'rateHigh', pending.rate_high,
          'lowTaxRateId', pending.low_tax_rate_id, 'highTaxRateId', pending.high_tax_rate_id, 'slabLimit', pending.slab_limit))));
    EXCEPTION WHEN check_violation THEN
      UPDATE business_tax_setting_changes SET status = 'refused', settled_at = clock_timestamp(), note = left(SQLERRM, 500)
        WHERE id = pending.id;
    END;
  END LOOP;
  RETURN done;
END $$;

-- A restaurant's dishes whose change is due on `upto` (the business day being
-- priced; NULL: its trading day) take it, in date order; then its default GST
-- rate's change. Returns the dishes applied now. One change at a time with
-- the menu's imports and price revisions (their lock).
CREATE OR REPLACE FUNCTION business_tax_change_apply_menu(target_restaurant BIGINT, upto DATE) RETURNS BIGINT[] LANGUAGE plpgsql AS $$
DECLARE
  biz BIGINT;
  due_by DATE;
  inclusive_default BOOLEAN;
  item RECORD;
  dish RECORD;
  pending RECORD;
  was NUMERIC;
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
      WHERE business_id = biz AND status = 'scheduled' AND starts_on <= due_by AND product_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM business_tax_setting_changes
      WHERE business_id = biz AND status = 'scheduled' AND starts_on <= due_by AND setting = 'restaurant_default') THEN
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
  -- Its default GST rate (its advances' GST is worked out at it), in date order.
  FOR pending IN
    SELECT * FROM business_tax_setting_changes
    WHERE business_id = biz AND status = 'scheduled' AND starts_on <= due_by AND setting = 'restaurant_default'
    ORDER BY starts_on, id
    FOR UPDATE
  LOOP
    BEGIN
      SELECT default_tax_percentage INTO was FROM restaurant_settings WHERE restaurant_id = target_restaurant FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'The restaurant has no settings yet' USING ERRCODE = '23514';
      END IF;
      UPDATE restaurant_settings SET default_tax_percentage = pending.rate, updated_by = pending.created_by WHERE restaurant_id = target_restaurant;
      UPDATE business_tax_setting_changes SET status = 'applied', settled_at = clock_timestamp(), before = jsonb_build_object('rate', was)
        WHERE id = pending.id;
      INSERT INTO audit_logs (restaurant_id, user_id, user_name, action, entity_type, entity_id, entity_label, details)
      SELECT target_restaurant, u.id, u.name, 'update', 'settings', target_restaurant, 'Restaurant settings',
        jsonb_build_object('via', format('GST rate change of %s: %s', to_char(pending.starts_on, 'DD Mon YYYY'), pending.reason),
          'changes', jsonb_build_object('defaultTaxPercentage', jsonb_build_array(was, pending.rate)))
      FROM users u WHERE u.id = pending.created_by;
    EXCEPTION WHEN check_violation THEN
      UPDATE business_tax_setting_changes SET status = 'refused', settled_at = clock_timestamp(), note = left(SQLERRM, 500)
        WHERE id = pending.id;
    END;
  END LOOP;
  RETURN done;
END $$;

-- A rate items are to move to stays on until then; so do the room-night
-- slabs a scheduled change of the lodge's settings names.
CREATE OR REPLACE FUNCTION business_tax_rates_in_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  first_day DATE;
  nights_day DATE;
BEGIN
  IF TG_TABLE_NAME = 'business_tax_rates' THEN
    IF OLD.active AND NOT NEW.active THEN
      SELECT min(i.starts_on) INTO first_day FROM business_tax_change_items i
        JOIN business_tax_changes c ON c.business_id = i.business_id AND c.id = i.change_id
        WHERE c.business_id = NEW.business_id AND c.tax_rate_id = NEW.id AND i.status = 'scheduled';
      SELECT min(starts_on) INTO nights_day FROM business_tax_setting_changes
        WHERE business_id = NEW.business_id AND status = 'scheduled' AND NEW.id IN (low_tax_rate_id, high_tax_rate_id);
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
  IF nights_day IS NOT NULL THEN
    RAISE EXCEPTION 'Room nights are billed at % from % (a scheduled change of the room-night slabs): keep it on, or cancel that change first',
      NEW.name, to_char(nights_day, 'DD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- --- Quotations: kits, part bills, terms -------------------------------------------------------

-- A kit quoted as one line: each part's share as priced, for the whole line:
-- [{ skuId, label, code, unit, quantity (a kit's), hsnCode, taxRate, amount, discount, net, tax }].
ALTER TABLE business_quotation_lines ADD COLUMN kit_parts JSONB
  CHECK (kit_parts IS NULL OR (jsonb_typeof(kit_parts) = 'array' AND jsonb_array_length(kit_parts) > 0));

-- The business's own terms and conditions, printed on its quotations; each
-- quotation keeps those it was made with.
ALTER TABLE business_settings ADD COLUMN quotation_terms VARCHAR(2000) CHECK (btrim(quotation_terms) <> '');
ALTER TABLE business_quotations ADD COLUMN terms VARCHAR(2000);

-- What each bill made from a quotation took of each line: the quantity (in the
-- line's stock unit) and its share of the line's value before GST and GST.
CREATE TABLE business_quotation_billed (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  quotation_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  net NUMERIC(16,2) NOT NULL CHECK (net >= 0),
  tax NUMERIC(16,2) NOT NULL CHECK (tax >= 0),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, quotation_id) REFERENCES business_quotations(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_quotation_lines(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, document_id, line_id)
);
CREATE INDEX business_quotation_billed_quotation ON business_quotation_billed(business_id, quotation_id, line_id);

-- A line is billed from an open quotation, on a sale, and never beyond what
-- it holds: the quotation is locked first, so two bills made at once are
-- counted one after the other. What was billed is kept as it was.
CREATE FUNCTION business_quotation_billed_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q RECORD; line RECORD; taken NUMERIC;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'What a bill took of a quotation is kept as it was billed' USING ERRCODE = '23514';
  END IF;
  SELECT quotation_no, status INTO q FROM business_quotations WHERE business_id = NEW.business_id AND id = NEW.quotation_id FOR UPDATE;
  IF q.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Quotation % is % and is not billed again', q.quotation_no, q.status USING ERRCODE = '23514';
  END IF;
  SELECT label, quantity INTO line FROM business_quotation_lines WHERE business_id = NEW.business_id AND id = NEW.line_id AND quotation_id = NEW.quotation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That line is not on quotation %', q.quotation_no USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'sale') THEN
    RAISE EXCEPTION 'A quotation is billed on a sale' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO taken FROM business_quotation_billed WHERE business_id = NEW.business_id AND line_id = NEW.line_id;
  IF taken + NEW.quantity > line.quantity THEN
    RAISE EXCEPTION '% on quotation %: % is left to bill, not %', line.label, q.quotation_no, line.quantity - taken, NEW.quantity USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_quotation_billed_check BEFORE INSERT OR UPDATE OR DELETE ON business_quotation_billed
  FOR EACH ROW EXECUTE FUNCTION business_quotation_billed_check();

-- Only an open quotation changes; it keeps its number, location, who made it
-- and the terms it was made with; a revision goes up one at a time; it is
-- billed or ordered only while valid (the business's own date). Nothing is deleted.
CREATE OR REPLACE FUNCTION business_quotations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A quotation is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Quotation % is % and can no longer change', OLD.quotation_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.quotation_no <> OLD.quotation_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A quotation keeps its number, its location and who made it' USING ERRCODE = '23514';
  END IF;
  IF NEW.terms IS DISTINCT FROM OLD.terms THEN
    RAISE EXCEPTION 'A quotation keeps the terms and conditions it was made with' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision NOT IN (OLD.revision, OLD.revision + 1) THEN
    RAISE EXCEPTION 'A quotation is revised one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('billed', 'ordered') THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    IF OLD.valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'Quotation % was valid until %. Revise it to bring its prices up to date first.', OLD.quotation_no, to_char(OLD.valid_until, 'DD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION business_quotations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT;
BEGIN
  -- A customer's data erased at their request (Personal data): only their copies on this row change.
  IF TG_OP = 'UPDATE' AND business_privacy_erasing(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A quotation is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Quotation % is % and can no longer change', OLD.quotation_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.quotation_no <> OLD.quotation_no OR NEW.location_id <> OLD.location_id OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A quotation keeps its number, its location and who made it' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision NOT IN (OLD.revision, OLD.revision + 1) THEN
    RAISE EXCEPTION 'A quotation is revised one step at a time' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('billed', 'ordered') THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    IF OLD.valid_until < (now() AT TIME ZONE zone)::date THEN
      RAISE EXCEPTION 'Quotation % was valid until %. Revise it to bring its prices up to date first.', OLD.quotation_no, to_char(OLD.valid_until, 'DD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER business_quotation_billed_check ON business_quotation_billed;
DROP TABLE business_quotation_billed;
DROP FUNCTION business_quotation_billed_check();
ALTER TABLE business_quotations DROP COLUMN terms;
ALTER TABLE business_settings DROP COLUMN quotation_terms;
ALTER TABLE business_quotation_lines DROP COLUMN kit_parts;

CREATE OR REPLACE FUNCTION business_tax_rates_in_change() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION business_tax_change_apply(target BIGINT) RETURNS BIGINT[] LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION business_tax_change_apply_menu(target_restaurant BIGINT, upto DATE) RETURNS BIGINT[] LANGUAGE plpgsql AS $$
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

DROP INDEX business_tax_changes_import;
ALTER TABLE business_tax_changes DROP COLUMN import_id;
DROP TABLE business_tax_change_imports;
DROP FUNCTION business_tax_change_imports_kept();
DROP TABLE business_tax_setting_changes;
DROP FUNCTION business_tax_setting_changes_kept();
DROP FUNCTION business_tax_setting_change_world();
