-- Up Migration
-- Restaurant features a restaurant can switch on or off.
--
-- Until now a restaurant was one module ("restaurant") and everything inside
-- it was always on, controlled only by roles; the one switch was
-- restaurant_settings.loyalty_enabled. Each part a restaurant may not want
-- (guests, loyalty, reservations, QR ordering, online ordering, deliveries,
-- kitchen display, captain sections, tips, advances, cash drawers, coupons,
-- stock, staff) becomes an optional module in the SAME catalogue as every
-- other business type's modules, applying to business type 'restaurant'.
-- A restaurant's switch is a business_capabilities row of its business
-- (businesses.legacy_restaurant_id), so the existing triggers enforce
-- dependencies, and a later subscription plan sets these switches exactly as
-- it sets any other module.
--
-- Core parts stay always on and are not listed: POS and orders, bills and
-- payments, menu, tables, outlets, business day, reports, users and roles,
-- settings, activity log.
--
-- Nothing changes for anyone today: every existing restaurant gets every
-- feature on, except Loyalty points, which follows its old loyalty_enabled
-- setting (that column is then dropped: the switch is the one truth).

-- A heading for the Features screen ("Guests", "Service", "Money", "Back office").
ALTER TABLE platform_modules ADD COLUMN feature_group VARCHAR(40);
COMMENT ON COLUMN platform_modules.feature_group IS 'Optional heading the module is listed under on a business''s Features screen.';

INSERT INTO platform_modules (code, name, description, kind, sort_order, feature_group) VALUES
 ('guests', 'Guests & CRM', 'The guest book, guest details on orders, feedback, complaints and guest insights.', 'optional', 301, 'Guests'),
 ('guest_loyalty', 'Loyalty points', 'Guests earn points on bills and use them to pay. The earn and redeem rules stay in Settings.', 'optional', 302, 'Guests'),
 ('reservations', 'Reservations', 'Table bookings, the waitlist and the online table-booking link.', 'optional', 311, 'Service'),
 ('qr_ordering', 'QR table ordering', 'Guests scan the QR code on their table to order or call staff; the Table requests screen.', 'optional', 312, 'Service'),
 ('online_ordering', 'Online ordering page', 'The restaurant''s own web page where guests order for pickup or delivery.', 'optional', 313, 'Service'),
 ('deliveries', 'Deliveries & rider cash', 'Delivery orders, the delivery board, riders and settling the cash they collect.', 'optional', 314, 'Service'),
 ('kitchen_display', 'Kitchen display (KDS)', 'Kitchen screens that show tickets and mark them ready. With it off, KOTs still print.', 'optional', 315, 'Service'),
 ('captain_sections', 'Captain sections', 'Give each captain a set of tables to look after.', 'optional', 316, 'Service'),
 ('tips', 'Tips', 'A tip box on bills and tips counted in the day''s cash.', 'optional', 321, 'Money'),
 ('advances', 'Advances & deposits', 'Money taken before a party or booking, used later on the bill or handed back.', 'optional', 322, 'Money'),
 ('cash_drawers', 'Cash drawers per shift', 'One drawer per cashier per shift, with its own float, count and X report. With it off, the day uses one till.', 'optional', 323, 'Money'),
 ('coupons', 'Coupons & offers', 'Ready-made discounts, coupon codes and automatic offers at the till.', 'optional', 324, 'Money'),
 ('stock_recipes', 'Stock & recipes', 'Stock items, recipes, purchasing, suppliers, transfers and waste.', 'optional', 331, 'Back office'),
 ('staff_payroll', 'Staff & payroll', 'Staff records, shifts, attendance, the time clock, leave, payroll and sharing out tips.', 'optional', 332, 'Back office');

-- Restaurants only. Loyalty starts off for a new restaurant, as the old
-- setting did; everything else starts on.
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT code, 'restaurant', code <> 'guest_loyalty'
FROM platform_modules WHERE sort_order BETWEEN 301 AND 332 AND code <> 'restaurant';

INSERT INTO platform_module_dependencies (module_code, requires_module_code)
SELECT code, 'restaurant' FROM platform_modules WHERE sort_order BETWEEN 301 AND 332
UNION ALL VALUES ('guest_loyalty', 'guests'), ('online_ordering', 'guests');

-- The business a restaurant appears as on the platform, created when it has
-- none yet (restaurants made after the multi-business migration are linked
-- the first time something needs it). The provisioning trigger gives a new
-- business its roles, settings and its type's default modules. Nobody becomes
-- a member by this: the restaurant's own screens do not need a membership.
CREATE FUNCTION restaurant_business_id(p_restaurant BIGINT) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_business BIGINT;
  r RECORD;
  wanted TEXT;
BEGIN
  SELECT id INTO v_business FROM businesses WHERE legacy_restaurant_id = p_restaurant;
  IF v_business IS NOT NULL THEN
    RETURN v_business;
  END IF;
  SELECT id, name, code, status INTO r FROM restaurants WHERE id = p_restaurant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Restaurant % not found', p_restaurant USING ERRCODE = '23503';
  END IF;
  wanted := COALESCE(NULLIF(btrim(r.code), ''), 'R' || r.id);
  IF EXISTS (SELECT 1 FROM businesses WHERE code = wanted) THEN
    wanted := left(wanted, 25) || '-R' || r.id;
  END IF;
  INSERT INTO businesses (name, code, business_type, legacy_restaurant_id, status)
  VALUES (r.name, wanted, 'restaurant', r.id, CASE WHEN r.status = 'active' THEN 'active' ELSE 'inactive' END)
  ON CONFLICT (legacy_restaurant_id) DO NOTHING
  RETURNING id INTO v_business;
  IF v_business IS NULL THEN
    SELECT id INTO v_business FROM businesses WHERE legacy_restaurant_id = p_restaurant;
  END IF;
  RETURN v_business;
END $$;

-- The restaurant features switched on for a restaurant: the one place every
-- check reads (the signed-in profile, the public QR / booking / online pages,
-- the notification bell). A restaurant not yet linked to a business has its
-- type's defaults.
CREATE FUNCTION restaurant_features(p_restaurant BIGINT) RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_restaurant IS NULL THEN '{}'::text[]
    WHEN b.id IS NULL THEN COALESCE((SELECT array_agg(t.module_code ORDER BY t.module_code)
      FROM platform_module_business_types t
      WHERE t.business_type = 'restaurant' AND t.enabled_by_default AND t.module_code <> 'restaurant'), '{}')
    ELSE COALESCE((SELECT array_agg(c.capability ORDER BY c.capability)
      FROM business_capabilities c
      JOIN platform_module_business_types t ON t.module_code = c.capability AND t.business_type = 'restaurant'
      WHERE c.business_id = b.id AND c.capability <> 'restaurant'), '{}')
  END
  FROM (SELECT (SELECT id FROM businesses WHERE legacy_restaurant_id = p_restaurant) AS id) b
$$;

-- Switches one feature on or off for a restaurant. Returns whether anything
-- changed. The capability triggers refuse a missing dependency, switching off
-- something another feature needs, and a module that is not a restaurant's.
-- The API checks money and writes the activity log around this; scripts and
-- tests may call it directly.
CREATE FUNCTION restaurant_feature_set(p_restaurant BIGINT, p_code TEXT, p_on BOOLEAN, p_user BIGINT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  business BIGINT;
  changed INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_module_business_types
                 WHERE module_code = p_code AND business_type = 'restaurant' AND module_code <> 'restaurant') THEN
    RAISE EXCEPTION 'Unknown restaurant feature: %', p_code USING ERRCODE = '23514';
  END IF;
  business := restaurant_business_id(p_restaurant);
  PERFORM 1 FROM businesses WHERE id = business FOR UPDATE;
  IF p_on THEN
    INSERT INTO business_capabilities (business_id, capability, enabled_by)
    VALUES (business, p_code, p_user) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM business_capabilities WHERE business_id = business AND capability = p_code;
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END $$;

-- Every existing restaurant business: every feature on (loyalty as it was).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = 'restaurant' AND t.module_code <> 'restaurant'
WHERE b.business_type = 'restaurant'
  AND (t.module_code <> 'guest_loyalty'
       OR EXISTS (SELECT 1 FROM restaurant_settings s WHERE s.restaurant_id = b.legacy_restaurant_id AND s.loyalty_enabled))
ON CONFLICT DO NOTHING;

-- A restaurant without a business yet, whose loyalty was on: it is linked now
-- (its other features come from the defaults), and loyalty stays on.
SELECT restaurant_feature_set(s.restaurant_id, 'guest_loyalty', TRUE)
FROM restaurant_settings s
WHERE s.loyalty_enabled
  AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.legacy_restaurant_id = s.restaurant_id);

-- The switch is now the only place loyalty is on or off.
ALTER TABLE restaurant_settings DROP COLUMN loyalty_enabled;

-- Down Migration
ALTER TABLE restaurant_settings ADD COLUMN loyalty_enabled BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE restaurant_settings s SET loyalty_enabled = TRUE
WHERE 'guest_loyalty' = ANY (restaurant_features(s.restaurant_id));
DROP FUNCTION restaurant_feature_set(BIGINT, TEXT, BOOLEAN, BIGINT);
DROP FUNCTION restaurant_features(BIGINT);
DROP FUNCTION restaurant_business_id(BIGINT);
-- Dependants first: the delete trigger refuses removing a module another needs.
DELETE FROM business_capabilities WHERE capability IN ('guest_loyalty', 'online_ordering');
DELETE FROM business_capabilities WHERE capability IN
 ('guests', 'reservations', 'qr_ordering', 'deliveries', 'kitchen_display', 'captain_sections',
  'tips', 'advances', 'cash_drawers', 'coupons', 'stock_recipes', 'staff_payroll');
DELETE FROM platform_module_dependencies WHERE module_code IN
 ('guests', 'guest_loyalty', 'reservations', 'qr_ordering', 'online_ordering', 'deliveries', 'kitchen_display',
  'captain_sections', 'tips', 'advances', 'cash_drawers', 'coupons', 'stock_recipes', 'staff_payroll');
DELETE FROM platform_module_business_types WHERE module_code IN
 ('guests', 'guest_loyalty', 'reservations', 'qr_ordering', 'online_ordering', 'deliveries', 'kitchen_display',
  'captain_sections', 'tips', 'advances', 'cash_drawers', 'coupons', 'stock_recipes', 'staff_payroll');
DELETE FROM platform_modules WHERE code IN
 ('guests', 'guest_loyalty', 'reservations', 'qr_ordering', 'online_ordering', 'deliveries', 'kitchen_display',
  'captain_sections', 'tips', 'advances', 'cash_drawers', 'coupons', 'stock_recipes', 'staff_payroll');
ALTER TABLE platform_modules DROP COLUMN feature_group;
