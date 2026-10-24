-- Up Migration
-- Eleven more kinds of business, each working on the shared core from its
-- first day: a general store and other shops; hardware, paints and building
-- materials; seeds, fertilisers and pesticides; optical shops; vehicle service
-- and auto parts; jewellery; fuel stations; gyms, studios and coaching;
-- laundries; rentals; and hotels, lodges and guest houses.
--
-- Goods shops (the first seven) keep stock from the start, bill at the
-- counter with prices including GST rounded to the rupee (jewellery prices
-- before GST, as jewellers bill), and give udhaar to named customers. Service
-- businesses price before GST and may switch stock on for what they sell over
-- the counter. Every type may switch on the team tools (tasks, issues,
-- projects), and each trade's specialist tools start off, marked recommended
-- where most shops of the trade use them. A type's own screens are added by
-- later migrations.

INSERT INTO business_types (code, name) VALUES
  ('general_retail', 'General store & other shops'),
  ('hardware', 'Hardware, paints & building materials'),
  ('agri_inputs', 'Seeds, fertilisers & pesticides'),
  ('optical', 'Optical shops'),
  ('garage', 'Vehicle service & auto parts'),
  ('jewellery', 'Jewellery & gold'),
  ('fuel_station', 'Fuel stations'),
  ('memberships', 'Gyms, studios & coaching'),
  ('laundry', 'Laundry & dry cleaning'),
  ('rentals', 'Rentals & hire'),
  ('lodging', 'Hotels, lodges & guest houses');

-- --- The shared modules each type may use (TRUE: on for a new business) ---
WITH goods(code) AS (VALUES ('general_retail'), ('hardware'), ('agri_inputs'), ('optical'), ('garage'), ('jewellery'), ('fuel_station')),
services(code) AS (VALUES ('memberships'), ('laundry'), ('rentals'), ('lodging')),
every(code) AS (SELECT code FROM goods UNION ALL SELECT code FROM services),
type_modules(business_type, module_code, enabled_by_default) AS (
  -- Every type: its products and services, customers, bills, dues and expenses.
  SELECT code, m, TRUE FROM every CROSS JOIN (VALUES ('catalog'), ('contacts'), ('sales'), ('receivables'), ('expenses')) AS x(m)
  -- The team tools, an owner's choice everywhere.
  UNION ALL SELECT code, m, FALSE FROM every CROSS JOIN (VALUES ('tasks'), ('issues'), ('projects')) AS x(m)
  -- Goods shops keep stock, buy it in and count it.
  UNION ALL SELECT code, m, TRUE FROM goods CROSS JOIN (VALUES ('inventory'), ('purchasing'), ('stock_counts')) AS x(m)
  UNION ALL SELECT code, 'stock_transfers', FALSE FROM goods
  -- Service businesses may keep stock of what they sell over the counter.
  UNION ALL SELECT code, m, FALSE FROM services CROSS JOIN (VALUES ('inventory'), ('purchasing'), ('stock_counts')) AS x(m)
  -- Each trade's specialist tools.
  UNION ALL SELECT * FROM (VALUES
    ('general_retail', 'batches', FALSE), ('general_retail', 'variants', FALSE), ('general_retail', 'weight', FALSE),
    ('general_retail', 'wastage', FALSE), ('general_retail', 'wholesale', FALSE), ('general_retail', 'offers', FALSE),
    ('general_retail', 'loyalty', FALSE), ('general_retail', 'exchanges', FALSE), ('general_retail', 'serials', FALSE),
    ('general_retail', 'warranties', FALSE), ('general_retail', 'repairs', FALSE),
    ('hardware', 'batches', FALSE), ('hardware', 'variants', FALSE), ('hardware', 'weight', FALSE),
    ('hardware', 'wholesale', FALSE), ('hardware', 'sales_orders', FALSE), ('hardware', 'offers', FALSE),
    ('hardware', 'exchanges', FALSE),
    ('agri_inputs', 'batches', TRUE), ('agri_inputs', 'weight', FALSE), ('agri_inputs', 'wholesale', FALSE),
    ('agri_inputs', 'offers', FALSE),
    ('optical', 'batches', FALSE), ('optical', 'variants', FALSE), ('optical', 'appointments', FALSE),
    ('optical', 'offers', FALSE), ('optical', 'loyalty', FALSE), ('optical', 'exchanges', FALSE),
    ('garage', 'appointments', FALSE), ('garage', 'batches', FALSE), ('garage', 'serials', FALSE),
    ('garage', 'warranties', FALSE), ('garage', 'wholesale', FALSE), ('garage', 'offers', FALSE),
    ('jewellery', 'serials', FALSE), ('jewellery', 'exchanges', FALSE), ('jewellery', 'offers', FALSE),
    ('jewellery', 'loyalty', FALSE),
    ('fuel_station', 'batches', FALSE), ('fuel_station', 'wholesale', FALSE),
    ('memberships', 'appointments', FALSE), ('memberships', 'offers', FALSE), ('memberships', 'loyalty', FALSE),
    ('laundry', 'offers', FALSE), ('laundry', 'loyalty', FALSE)
  ) AS s(business_type, module_code, enabled_by_default))
INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT module_code, business_type, enabled_by_default FROM type_modules;

-- Tools most shops of a trade use: shown as recommended in Settings › Business tools.
UPDATE platform_module_business_types t SET recommended = TRUE, recommended_note = r.note
FROM (VALUES
  ('general_retail', 'variants', 'Sizes and colours for footwear, bags and clothes.'),
  ('general_retail', 'offers', 'Festival offers, combos and clearance sales at the counter.'),
  ('hardware', 'wholesale', 'Contractor, dealer and walk-in rates for the same item.'),
  ('hardware', 'sales_orders', 'Site orders delivered in parts, each load with a delivery challan.'),
  ('hardware', 'stock_transfers', 'Move stock between the shop and the godown.'),
  ('agri_inputs', 'wholesale', 'Dealer rates for village retailers and bulk buyers.'),
  ('optical', 'batches', 'Expiry dates on contact lenses and lens solutions.'),
  ('optical', 'variants', 'Frame colours and sizes.'),
  ('optical', 'appointments', 'Eye-test bookings with the optometrist.'),
  ('garage', 'appointments', 'Service bookings by day, bay and mechanic.'),
  ('garage', 'wholesale', 'Mechanic and retailer rates on the parts counter.'),
  ('fuel_station', 'tasks', 'Daily nozzle tests, density checks and safety rounds.'),
  ('memberships', 'appointments', 'Personal-training sessions and trial classes by the hour.'),
  ('lodging', 'tasks', 'Housekeeping rounds, maintenance and safety checks.')
) AS r(business_type, module_code, note)
WHERE t.business_type = r.business_type AND t.module_code = r.module_code;

-- --- What a new business starts with ---

-- Goods shops price including GST, rounded to the rupee; a jeweller prices
-- before GST (metal, making and stones, then 3% GST) and rounds to the rupee.
CREATE OR REPLACE FUNCTION business_seed_settings(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_settings (business_id, display_name, tax_mode, rounding)
  SELECT id, name,
    CASE WHEN business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail',
                                'general_retail', 'hardware', 'agri_inputs', 'optical', 'garage', 'fuel_station') THEN 'inclusive' ELSE 'exclusive' END,
    CASE WHEN business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail',
                                'general_retail', 'hardware', 'agri_inputs', 'optical', 'garage', 'fuel_station', 'jewellery') THEN 'nearest_rupee' ELSE 'none' END
  FROM businesses WHERE id = target
  ON CONFLICT (business_id) DO NOTHING;
$$;

-- GST slabs. Every type keeps nil, 5%, 18% (the default) and 40%. A jeweller
-- starts with the precious-goods slabs instead: 3% (the default) on gold,
-- silver, jewellery and imitation jewellery; 0.25% on rough and loose
-- precious stones; 1.5% on cut and polished diamonds; 5% on job work for
-- another jeweller; 18% on repairs and other services; and nil.
CREATE OR REPLACE FUNCTION business_seed_tax_rates(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_tax_rates (business_id, name, rate, is_default)
  SELECT b.id, s.name, s.rate, s.is_default
  FROM businesses b, (VALUES ('GST nil / exempt', 0.00, FALSE), ('GST 5%', 5.00, FALSE),
                              ('GST 18%', 18.00, TRUE), ('GST 40%', 40.00, FALSE)) AS s(name, rate, is_default)
  WHERE b.id = target AND b.business_type NOT IN ('restaurant', 'jewellery')
    AND NOT EXISTS (SELECT 1 FROM business_tax_rates x WHERE x.business_id = b.id);
  INSERT INTO business_tax_rates (business_id, name, rate, is_default)
  SELECT b.id, s.name, s.rate, s.is_default
  FROM businesses b, (VALUES ('GST nil / exempt', 0.00, FALSE), ('GST 0.25%', 0.25, FALSE), ('GST 1.5%', 1.50, FALSE),
                              ('GST 3%', 3.00, TRUE), ('GST 5%', 5.00, FALSE), ('GST 18%', 18.00, FALSE)) AS s(name, rate, is_default)
  WHERE b.id = target AND b.business_type = 'jewellery'
    AND NOT EXISTS (SELECT 1 FROM business_tax_rates x WHERE x.business_id = b.id);
$$;

-- Units: the base units every type gets, the pack words each trade uses (how
-- many are in one is set per product), and the trade measures that convert to
-- a base unit: quintal and tonne to the kilo, foot to the metre, carat to the
-- kilo (0.2 g), and a hire day to the hour. A room night is counted on its own.
CREATE OR REPLACE FUNCTION business_seed_units(target BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE kind_of_business TEXT;
BEGIN
  SELECT business_type INTO kind_of_business FROM businesses WHERE id = target;
  -- Restaurants keep their own units in the restaurant module.
  IF kind_of_business IS NULL OR (kind_of_business = 'restaurant'
     AND NOT EXISTS (SELECT 1 FROM catalog_skus WHERE business_id = target)) THEN
    RETURN;
  END IF;
  -- Base units first (the conversions below point at them).
  INSERT INTO business_units (business_id, code, name, kind, decimals) VALUES
    (target, 'each', 'Each (piece)', 'count', 0), (target, 'kg', 'Kilogram', 'weight', 3),
    (target, 'litre', 'Litre', 'volume', 3), (target, 'metre', 'Metre', 'length', 3),
    (target, 'hour', 'Hour', 'time', 2), (target, 'service', 'Service', 'service', 0)
  ON CONFLICT (business_id, code) DO NOTHING;
  INSERT INTO business_units (business_id, code, name, kind, decimals, base_unit_code, factor_to_base) VALUES
    (target, 'g', 'Gram', 'weight', 3, 'kg', 0.001), (target, 'ml', 'Millilitre', 'volume', 3, 'litre', 0.001)
  ON CONFLICT (business_id, code) DO NOTHING;
  -- Packaging words the type commonly uses; how many are in one is set per product.
  INSERT INTO business_units (business_id, code, name, kind, decimals)
  SELECT target, u.code, u.name, 'count', 0
  FROM (VALUES ('pack', 'Pack'), ('box', 'Box'), ('case', 'Case'), ('dozen', 'Dozen'),
               ('strip', 'Strip'), ('tablet', 'Tablet'), ('bottle', 'Bottle'), ('pair', 'Pair'),
               ('bag', 'Bag'), ('coil', 'Coil'), ('roll', 'Roll'), ('sheet', 'Sheet'),
               ('set', 'Set'), ('packet', 'Packet')) AS u(code, name)
  WHERE (u.code IN ('pack', 'box') AND kind_of_business IN ('grocery', 'supermarket', 'wholesale', 'books', 'fashion', 'electronics', 'salon', 'pharmacy', 'meat', 'weight_retail',
                                                            'general_retail', 'hardware', 'agri_inputs', 'optical', 'garage', 'jewellery', 'fuel_station'))
     OR (u.code = 'case' AND kind_of_business IN ('wholesale', 'supermarket', 'fuel_station'))
     OR (u.code = 'dozen' AND kind_of_business IN ('grocery', 'wholesale', 'books', 'general_retail', 'hardware'))
     OR (u.code IN ('strip', 'tablet') AND kind_of_business = 'pharmacy')
     OR (u.code = 'bottle' AND kind_of_business IN ('pharmacy', 'optical', 'agri_inputs'))
     OR (u.code = 'pair' AND kind_of_business IN ('fashion', 'general_retail', 'optical', 'garage', 'jewellery', 'laundry'))
     OR (u.code = 'bag' AND kind_of_business IN ('hardware', 'agri_inputs'))
     OR (u.code IN ('coil', 'sheet') AND kind_of_business = 'hardware')
     OR (u.code = 'roll' AND kind_of_business IN ('hardware', 'general_retail'))
     OR (u.code = 'set' AND kind_of_business IN ('general_retail', 'hardware', 'garage', 'jewellery', 'laundry'))
     OR (u.code = 'packet' AND kind_of_business = 'agri_inputs')
  ON CONFLICT (business_id, code) DO NOTHING;
  -- Trade measures, converted to a base unit of the same kind.
  INSERT INTO business_units (business_id, code, name, kind, decimals, base_unit_code, factor_to_base)
  SELECT target, u.code, u.name, u.kind, u.decimals, u.base, u.factor
  FROM (VALUES ('quintal', 'Quintal (100 kg)', 'weight', 3, 'kg', 100::NUMERIC),
               ('tonne', 'Tonne (1,000 kg)', 'weight', 3, 'kg', 1000::NUMERIC),
               ('ft', 'Foot', 'length', 2, 'metre', 0.3048::NUMERIC),
               ('ct', 'Carat (0.2 g)', 'weight', 3, 'kg', 0.0002::NUMERIC),
               ('day', 'Day', 'time', 2, 'hour', 24::NUMERIC)) AS u(code, name, kind, decimals, base, factor)
  WHERE (u.code IN ('quintal', 'tonne') AND kind_of_business IN ('hardware', 'agri_inputs'))
     OR (u.code = 'ft' AND kind_of_business = 'hardware')
     OR (u.code = 'ct' AND kind_of_business = 'jewellery')
     OR (u.code = 'day' AND kind_of_business = 'rentals')
  ON CONFLICT (business_id, code) DO NOTHING;
  IF kind_of_business = 'lodging' THEN
    INSERT INTO business_units (business_id, code, name, kind, decimals) VALUES (target, 'night', 'Room night', 'time', 0)
    ON CONFLICT (business_id, code) DO NOTHING;
  END IF;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION business_seed_units(target BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE kind_of_business TEXT;
BEGIN
  SELECT business_type INTO kind_of_business FROM businesses WHERE id = target;
  -- Restaurants keep their own units in the restaurant module.
  IF kind_of_business IS NULL OR (kind_of_business = 'restaurant'
     AND NOT EXISTS (SELECT 1 FROM catalog_skus WHERE business_id = target)) THEN
    RETURN;
  END IF;
  -- Base units first (the conversions below point at them).
  INSERT INTO business_units (business_id, code, name, kind, decimals) VALUES
    (target, 'each', 'Each (piece)', 'count', 0), (target, 'kg', 'Kilogram', 'weight', 3),
    (target, 'litre', 'Litre', 'volume', 3), (target, 'metre', 'Metre', 'length', 3),
    (target, 'hour', 'Hour', 'time', 2), (target, 'service', 'Service', 'service', 0)
  ON CONFLICT (business_id, code) DO NOTHING;
  INSERT INTO business_units (business_id, code, name, kind, decimals, base_unit_code, factor_to_base) VALUES
    (target, 'g', 'Gram', 'weight', 3, 'kg', 0.001), (target, 'ml', 'Millilitre', 'volume', 3, 'litre', 0.001)
  ON CONFLICT (business_id, code) DO NOTHING;
  -- Packaging words the type commonly uses; how many are in one is set per product.
  INSERT INTO business_units (business_id, code, name, kind, decimals)
  SELECT target, u.code, u.name, 'count', 0
  FROM (VALUES ('pack', 'Pack'), ('box', 'Box'), ('case', 'Case'), ('dozen', 'Dozen'),
               ('strip', 'Strip'), ('tablet', 'Tablet'), ('bottle', 'Bottle'), ('pair', 'Pair')) AS u(code, name)
  WHERE (u.code IN ('pack', 'box') AND kind_of_business IN ('grocery', 'supermarket', 'wholesale', 'books', 'fashion', 'electronics', 'salon', 'pharmacy', 'meat', 'weight_retail'))
     OR (u.code = 'case' AND kind_of_business IN ('wholesale', 'supermarket'))
     OR (u.code = 'dozen' AND kind_of_business IN ('grocery', 'wholesale', 'books'))
     OR (u.code IN ('strip', 'tablet', 'bottle') AND kind_of_business = 'pharmacy')
     OR (u.code = 'pair' AND kind_of_business = 'fashion')
  ON CONFLICT (business_id, code) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION business_seed_tax_rates(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_tax_rates (business_id, name, rate, is_default)
  SELECT b.id, s.name, s.rate, s.is_default
  FROM businesses b, (VALUES ('GST nil / exempt', 0.00, FALSE), ('GST 5%', 5.00, FALSE),
                              ('GST 18%', 18.00, TRUE), ('GST 40%', 40.00, FALSE)) AS s(name, rate, is_default)
  WHERE b.id = target AND b.business_type <> 'restaurant'
    AND NOT EXISTS (SELECT 1 FROM business_tax_rates x WHERE x.business_id = b.id);
$$;

CREATE OR REPLACE FUNCTION business_seed_settings(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_settings (business_id, display_name, tax_mode, rounding)
  SELECT id, name,
    CASE WHEN business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail') THEN 'inclusive' ELSE 'exclusive' END,
    CASE WHEN business_type IN ('grocery', 'supermarket', 'books', 'pharmacy', 'fashion', 'electronics', 'meat', 'weight_retail') THEN 'nearest_rupee' ELSE 'none' END
  FROM businesses WHERE id = target
  ON CONFLICT (business_id) DO NOTHING;
$$;

DELETE FROM platform_module_business_types
WHERE business_type IN ('general_retail', 'hardware', 'agri_inputs', 'optical', 'garage', 'jewellery', 'fuel_station',
                        'memberships', 'laundry', 'rentals', 'lodging');
DELETE FROM business_types
WHERE code IN ('general_retail', 'hardware', 'agri_inputs', 'optical', 'garage', 'jewellery', 'fuel_station',
               'memberships', 'laundry', 'rentals', 'lodging');
