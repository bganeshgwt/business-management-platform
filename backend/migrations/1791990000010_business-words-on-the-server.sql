-- Up Migration
-- What the database writes, and how a new business starts, in the business's
-- own words (the words are migration 1791990000000's).
--
-- 1. A new word, `bill`: the paper a sale is billed on ("2 bills overdue",
--    "the most discount on a bill"); a wholesaler's are invoices. And the
--    example HSN or SAC of a few types and kinds, to match their example item.
-- 2. The messages the database writes itself name the business's people in
--    its words: a gym's members, a clinic's patients, a hotel's guests
--    (a contact that is not one of them, the cash limit, a collection's
--    bills, a refund, loyalty points, a stay's billing, personal data).
-- 3. A new business starts with the roles, units and default GST slab of its
--    trade: a salon's stylist and receptionist, a clinic's receptionist and
--    nurse, a gym's front desk, a garage's service advisor, a laundry's
--    washer / presser, a rental yard's yard hand, and a stock keeper only
--    where stock is kept from the start; a gym's month, session and class, a
--    clinic's visit and test, a salon's session, a grocer's bag and packet;
--    a clinic's exempt services, and a salon's, gym's and yoga studio's 5%.
--    Businesses that exist keep the roles, units and slabs they have.

-- --- Words in a sentence ------------------------------------------------------------
-- As the server's words.lower() and words.a() write them (and the staff app's
-- t.lower and t.a): lower case for the middle of a sentence, keeping words
-- written in capitals (OPD, PVC); "a" or "an" by the sound a word starts with.
CREATE FUNCTION words_lower(p_text TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(string_agg(CASE WHEN regexp_replace(w.part, '[^A-Za-z0-9]', '', 'g') ~ '^[A-Z0-9]{2,}$' THEN w.part ELSE lower(w.part) END, ' ' ORDER BY w.n), '')
  FROM unnest(string_to_array(p_text, ' ')) WITH ORDINALITY AS w(part, n)
$$;
CREATE FUNCTION words_a(p_text TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN (w ~* '^[aeiou]' AND w !~* '^(uni|use|usu|uti|ure|one|once|eu)') OR w ~* '^(hour|honest|honour|heir)' THEN 'an ' ELSE 'a ' END || w
  FROM btrim(COALESCE(p_text, '')) AS w
$$;
-- One word of a business for the middle of a sentence ("member", "patients"):
-- its own, else the word's default, else the key.
CREATE FUNCTION business_word_lower(p_business BIGINT, p_key TEXT, p_plural BOOLEAN DEFAULT FALSE) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT words_lower(COALESCE(business_word(p_business, p_key, p_plural),
    (SELECT CASE WHEN p_plural THEN COALESCE(k.many, k.one) ELSE k.one END FROM term_keys k WHERE k.key = p_key), p_key))
$$;

-- --- The paper a sale is billed on --------------------------------------------------
INSERT INTO term_keys (key, area, label, hint, one, many, owner_may_rename, sort_order) VALUES
  ('bill', 'money', 'The paper a sale is billed on', '“2 bills overdue”, “the most discount on a bill”.', 'Bill', 'Bills', FALSE, 405);
INSERT INTO business_type_terms (business_type, key, one, many) VALUES
  ('wholesale', 'bill', 'Invoice', 'Invoices');

-- The HSN or SAC of each type's and kind's own example item, where the
-- example code it had was another item's (a product import's sample row shows
-- the two together): toor dal 0713, a steel bottle 7323, a physiotherapy
-- session 999314, a lab test 999316.
INSERT INTO business_type_terms (business_type, key, one, many) VALUES
  ('grocery', 'example.hsn', '0713', NULL), ('supermarket', 'example.hsn', '0713', NULL),
  ('wholesale', 'example.hsn', '0713', NULL), ('general_retail', 'example.hsn', '7323', NULL);
INSERT INTO business_kind_terms (business_type, kind, key, one, many) VALUES
  ('healthcare', 'physiotherapy', 'example.hsn', '999314', NULL),
  ('healthcare', 'diagnostic', 'example.hsn', '999316', NULL);

-- --- What the database writes ---------------------------------------------------------

-- A contact used where only a customer makes sense (collections, orders,
-- beats, memberships, stays, bookings).
CREATE OR REPLACE FUNCTION business_contact_is_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.contact_id AND kind = 'customer') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('Choose %s of this business', words_a(business_word_lower(NEW.business_id, 'customer')));
  END IF;
  RETURN NEW;
END $$;

-- Money put against bills counts what was refunded too, and settles the bills
-- of the one who paid it.
CREATE OR REPLACE FUNCTION business_payments_collection_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt business_collections%ROWTYPE;
  used NUMERIC;
BEGIN
  IF NEW.collection_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id
                 AND kind = 'sale' AND contact_id = receipt.contact_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A collection can only settle %s of the %s who paid it',
        business_word_lower(NEW.business_id, 'bill', TRUE), business_word_lower(NEW.business_id, 'customer'));
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO used FROM business_payments WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id;
  used := used + COALESCE((SELECT sum(amount) FROM business_collection_refunds WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0);
  IF used > receipt.amount THEN
    RAISE EXCEPTION 'Collection % has only % to apply to bills', receipt.collection_no, receipt.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_collection_refunds_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt business_collections%ROWTYPE;
  used NUMERIC;
BEGIN
  SELECT * INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF receipt.contact_id <> NEW.contact_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A refund goes back to the %s who paid', business_word_lower(NEW.business_id, 'customer'));
  END IF;
  SELECT COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0)
       + COALESCE((SELECT sum(amount) FROM business_collection_refunds WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0)
    INTO used;
  IF used > receipt.amount THEN
    RAISE EXCEPTION 'Collection % has only % left to refund', receipt.collection_no, receipt.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- The cash limit (Income-tax Act 2025, section 186) as migration
-- 1791979990000 keeps it, naming the business's people in its words.
CREATE OR REPLACE FUNCTION business_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc RECORD;
  zone TEXT;
  on_bill NUMERIC;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT d.kind, d.contact_id, d.document_no, d.request_key, d.series_id INTO doc FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN RETURN NEW; END IF;
  IF doc.contact_id IS NULL AND EXISTS (SELECT 1 FROM fuel_shift_closes c WHERE c.business_id = NEW.business_id AND c.walk_in_key = doc.request_key) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_bill FROM business_payments
  WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND method = 'cash';
  IF on_bill >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      doc.document_no, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  -- A collection receipt's own cash was counted when the receipt was taken.
  IF doc.contact_id IS NOT NULL AND NEW.collection_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM business_number_series s WHERE s.business_id = NEW.business_id AND s.id = doc.series_id AND s.device_id IS NOT NULL) THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    from_customer := business_cash_from_customer(NEW.business_id, doc.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
    IF from_customer >= 200000 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format(
        'Cash of ₹2,00,000 or more cannot be taken from one %1$s in a day (Income-tax Act 2025, section 186): today''s cash from this %1$s would reach ₹%2$s. Take the rest by UPI, card, bank transfer or cheque.',
        business_word_lower(NEW.business_id, 'customer'), from_customer::NUMERIC(16,2));
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_cash_limit_collection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zone TEXT;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  from_customer := business_cash_from_customer(NEW.business_id, NEW.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
  IF from_customer >= 200000 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format(
      'Cash of ₹2,00,000 or more cannot be taken from one %1$s in a day (Income-tax Act 2025, section 186): today''s cash from this %1$s would reach ₹%2$s. Take the rest by UPI, card, bank transfer or cheque.',
      business_word_lower(NEW.business_id, 'customer'), from_customer::NUMERIC(16,2));
  END IF;
  RETURN NEW;
END $$;

-- No entry may leave a customer below zero points.
CREATE OR REPLACE FUNCTION retail_loyalty_not_negative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held INTEGER;
BEGIN
  SELECT COALESCE(sum(points), 0) INTO held FROM retail_loyalty_entries
  WHERE business_id = NEW.business_id AND contact_id = NEW.contact_id;
  IF held < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('This would leave the %s with %s loyalty points; points cannot go below zero', business_word_lower(NEW.business_id, 'customer'), held);
  END IF;
  RETURN NULL;
END $$;

-- A stay is billed to someone on the business's list.
CREATE OR REPLACE FUNCTION lodging_stays_bill_to() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bill_to_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.bill_to_contact_id AND kind = 'customer') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A stay is billed to someone on your %s list: add the company there first', business_word(NEW.business_id, 'customer_list', TRUE));
  END IF;
  RETURN NEW;
END $$;

-- A person named by a personal-data row belongs to that row's business: a
-- customer contact of it, or a guest of the restaurant behind it.
CREATE OR REPLACE FUNCTION business_privacy_person(target_business BIGINT, contact BIGINT, guest BIGINT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF guest IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM customers c JOIN businesses b ON b.legacy_restaurant_id = c.restaurant_id
                   WHERE c.id = guest AND b.id = target_business) THEN
      RAISE EXCEPTION 'This guest belongs to another restaurant' USING ERRCODE = '23514';
    END IF;
  ELSIF contact IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = target_business AND id = contact AND kind = 'customer') THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('Personal data here is about %s of this business', words_a(business_word_lower(target_business, 'customer')));
    END IF;
  END IF;
END $$;

-- A business's change of GST rates moves its catalogue items to one of its
-- slabs; a restaurant's moves its dishes to one of its tax rates.
CREATE OR REPLACE FUNCTION business_tax_change_world() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  restaurant BIGINT;
  dishes BOOLEAN;
BEGIN
  SELECT legacy_restaurant_id INTO restaurant FROM businesses WHERE id = NEW.business_id;
  IF TG_TABLE_NAME = 'business_tax_changes' THEN
    IF restaurant IS NULL AND NEW.restaurant_tax_rate_id IS NOT NULL THEN
      RAISE EXCEPTION 'A business''s items move to one of its own GST slabs' USING ERRCODE = '23514';
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
      RAISE EXCEPTION 'A business''s change moves its own catalogue items' USING ERRCODE = '23514';
    END IF;
    IF NEW.from_restaurant_tax_rate_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tax_rates WHERE id = NEW.from_restaurant_tax_rate_id AND restaurant_id = restaurant) THEN
      RAISE EXCEPTION 'That tax rate is not part of this restaurant' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- --- The roles of a trade -------------------------------------------------------------
-- A template may need one of some modules its type uses from the start (a
-- stock keeper only where stock is kept), and a type's own template may stand
-- in for a shared one: a clinic's receptionist instead of the cashier, with
-- the cashier's permissions and its own. A business of the type gets the
-- type's role, not both. (A module that later gives the cashier its
-- permissions gives them to the roles that stand in for it too.)
ALTER TABLE business_role_templates
  ADD COLUMN needs_modules TEXT[],
  ADD COLUMN stands_for TEXT REFERENCES business_role_templates(code);

UPDATE business_role_templates SET needs_modules = ARRAY['inventory', 'stock_recipes'] WHERE code = 'stock_keeper';
UPDATE business_role_templates SET description = 'Reads everything, records payments and expenses, exports and prints.' WHERE code = 'accountant';

INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types, stands_for) VALUES
 ('receptionist', 'Receptionist', 'Runs reception: books and changes appointments, welcomes walk-ins and adds them, makes bills and takes payments. Changes no prices or settings.', FALSE, 30, ARRAY['salon', 'healthcare'], 'cashier'),
 ('member_desk', 'Front desk', 'Checks members in, sells and renews plans, books sessions and classes, and takes fees at the front desk. Changes no prices or settings.', FALSE, 30, ARRAY['memberships'], 'cashier'),
 ('stylist', 'Stylist', 'Sees the day''s appointments, the services and the packages a client holds, and marks appointments done. Takes no money.', FALSE, 44, ARRAY['salon'], NULL),
 ('nurse', 'Nurse', 'Calls patients in by token, sees patients and their appointments, and collects lab samples. Reads no clinical notes and takes no money.', FALSE, 45, ARRAY['healthcare'], NULL),
 ('service_advisor', 'Service advisor', 'Receives vehicles and opens job cards, makes estimates and gets the owner''s approval, books services, and bills the job when it is done.', FALSE, 46, ARRAY['garage'], NULL),
 ('presser', 'Washer / presser', 'Moves garments through washing and pressing onto the racks, hands them over and records any damage.', FALSE, 47, ARRAY['laundry'], NULL),
 ('yard_hand', 'Yard hand', 'Hands items over and takes them back with their condition and charges, and sends units for maintenance.', FALSE, 48, ARRAY['rentals'], NULL);
UPDATE business_role_templates SET stands_for = 'cashier' WHERE code = 'front_desk';

INSERT INTO business_role_template_permissions (template_code, permission_code) VALUES
 ('receptionist', 'contacts.edit'), ('receptionist', 'appointments.cancel'),
 ('member_desk', 'contacts.edit'), ('member_desk', 'appointments.cancel'),
 ('stylist', 'catalog.view'), ('stylist', 'contacts.view'), ('stylist', 'inventory.view'), ('stylist', 'appointments.view'), ('stylist', 'appointments.edit'),
 ('stylist', 'online_appointments.view'), ('stylist', 'packages.view'),
 ('nurse', 'catalog.view'), ('nurse', 'contacts.view'), ('nurse', 'patients.view'), ('nurse', 'patients.create'), ('nurse', 'appointments.view'),
 ('nurse', 'appointments.edit'), ('nurse', 'online_appointments.view'), ('nurse', 'lab.view'), ('nurse', 'lab.create'),
 ('service_advisor', 'catalog.view'), ('service_advisor', 'inventory.view'), ('service_advisor', 'contacts.view'), ('service_advisor', 'contacts.create'),
 ('service_advisor', 'contacts.edit'), ('service_advisor', 'garage.view'), ('service_advisor', 'garage.create'), ('service_advisor', 'garage.edit'),
 ('service_advisor', 'garage.print'), ('service_advisor', 'appointments.view'), ('service_advisor', 'appointments.create'), ('service_advisor', 'appointments.edit'),
 ('service_advisor', 'online_appointments.view'), ('service_advisor', 'online_appointments.approve'), ('service_advisor', 'quotations.view'),
 ('service_advisor', 'quotations.create'), ('service_advisor', 'quotations.edit'), ('service_advisor', 'quotations.print'), ('service_advisor', 'sales.view'),
 ('service_advisor', 'sales.create'), ('service_advisor', 'sales.edit'), ('service_advisor', 'sales.print'), ('service_advisor', 'receivables.view'),
 ('presser', 'catalog.view'), ('presser', 'contacts.view'), ('presser', 'laundry.view'), ('presser', 'laundry.edit'), ('presser', 'laundry.print'),
 ('yard_hand', 'catalog.view'), ('yard_hand', 'contacts.view'), ('yard_hand', 'rentals.view'), ('yard_hand', 'rentals.edit'), ('yard_hand', 'rentals.print');

-- Every new business gets the templates of its own type (and the shared ones
-- its type has no role of its own for, and uses the modules of).
CREATE OR REPLACE FUNCTION business_seed_roles(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_roles (business_id, template_code, name, description, full_access)
  SELECT b.id, t.code, t.name, t.description, t.full_access
  FROM businesses b JOIN business_role_templates t ON t.business_types IS NULL OR b.business_type = ANY (t.business_types)
  WHERE b.id = target
    AND (t.needs_modules IS NULL OR EXISTS (SELECT 1 FROM platform_module_business_types m
      WHERE m.business_type = b.business_type AND m.module_code = ANY (t.needs_modules) AND m.enabled_by_default))
    AND NOT EXISTS (SELECT 1 FROM business_role_templates o WHERE o.stands_for = t.code AND b.business_type = ANY (o.business_types))
  ON CONFLICT (business_id, template_code) DO NOTHING;
  INSERT INTO business_role_permissions (business_id, role_id, permission_code)
  SELECT DISTINCT r.business_id, r.id, tp.permission_code
  FROM business_roles r JOIN business_role_templates t ON t.code = r.template_code
  JOIN business_role_template_permissions tp ON tp.template_code = t.code OR tp.template_code = t.stands_for
  WHERE r.business_id = target AND NOT r.full_access
    AND NOT EXISTS (SELECT 1 FROM business_role_permissions x WHERE x.role_id = r.id)
  ON CONFLICT DO NOTHING;
$$;

-- --- Units of a trade -------------------------------------------------------------------
-- Units: the base units every type gets, the pack words each trade uses (how
-- many are in one is set per product), the trade measures that convert to a
-- base unit (quintal and tonne to the kilo, foot to the metre, carat to the
-- kilo, a hire day to the hour), a room night, and what a service trade bills
-- by: a gym's month, session and class, a clinic's visit and test, a salon's
-- session.
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
     OR (u.code = 'bag' AND kind_of_business IN ('grocery', 'hardware', 'agri_inputs'))
     OR (u.code IN ('coil', 'sheet') AND kind_of_business = 'hardware')
     OR (u.code = 'roll' AND kind_of_business IN ('hardware', 'general_retail'))
     OR (u.code = 'set' AND kind_of_business IN ('general_retail', 'hardware', 'garage', 'jewellery', 'laundry'))
     OR (u.code = 'packet' AND kind_of_business IN ('grocery', 'agri_inputs'))
  ON CONFLICT (business_id, code) DO NOTHING;
  -- What a service trade bills by, counted whole.
  INSERT INTO business_units (business_id, code, name, kind, decimals)
  SELECT target, u.code, u.name, 'service', 0
  FROM (VALUES ('month', 'Month'), ('session', 'Session'), ('class', 'Class'), ('visit', 'Visit'), ('test', 'Test')) AS u(code, name)
  WHERE (u.code IN ('month', 'session', 'class') AND kind_of_business = 'memberships')
     OR (u.code IN ('visit', 'test') AND kind_of_business = 'healthcare')
     OR (u.code = 'session' AND kind_of_business = 'salon')
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

-- --- The GST slab a new item takes ----------------------------------------------------------
-- Every type keeps nil, 5%, 18% and 40%; the default is the slab its own
-- supplies take:
--   * a clinic's health care services, by a clinical establishment, an
--     authorised medical practitioner or para-medics, are exempt
--     (notification 12/2017-Central Tax (Rate), serial 74): nil;
--   * a salon's, a gym's and a yoga studio's beauty and physical well-being
--     services (SAC group 99972) take 5%, without input tax credit, from 22
--     September 2025 (notification 15/2025-Central Tax (Rate), serial 35):
--     5% (a gym is a membership business of no kind, or of the gym kind);
--   * every other type 18%.
-- A jeweller starts with the precious-goods slabs instead: 3% (the default)
-- on gold, silver, jewellery and imitation jewellery; 0.25% on rough and loose
-- precious stones; 1.5% on cut and polished diamonds; 5% on job work for
-- another jeweller; 18% on repairs and other services; and nil.
CREATE OR REPLACE FUNCTION business_seed_tax_rates(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_tax_rates (business_id, name, rate, is_default)
  SELECT b.id, s.name, s.rate, s.rate = CASE
      WHEN b.business_type = 'healthcare' THEN 0.00
      WHEN b.business_type = 'salon' THEN 5.00
      WHEN b.business_type = 'memberships' AND COALESCE(b.kind, 'gym') IN ('gym', 'yoga_studio') THEN 5.00
      ELSE 18.00 END
  FROM businesses b, (VALUES ('GST nil / exempt', 0.00), ('GST 5%', 5.00), ('GST 18%', 18.00), ('GST 40%', 40.00)) AS s(name, rate)
  WHERE b.id = target AND b.business_type NOT IN ('restaurant', 'jewellery')
    AND NOT EXISTS (SELECT 1 FROM business_tax_rates x WHERE x.business_id = b.id);
  INSERT INTO business_tax_rates (business_id, name, rate, is_default)
  SELECT b.id, s.name, s.rate, s.is_default
  FROM businesses b, (VALUES ('GST nil / exempt', 0.00, FALSE), ('GST 0.25%', 0.25, FALSE), ('GST 1.5%', 1.50, FALSE),
                              ('GST 3%', 3.00, TRUE), ('GST 5%', 5.00, FALSE), ('GST 18%', 18.00, FALSE)) AS s(name, rate, is_default)
  WHERE b.id = target AND b.business_type = 'jewellery'
    AND NOT EXISTS (SELECT 1 FROM business_tax_rates x WHERE x.business_id = b.id);
$$;

-- Down Migration
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

CREATE OR REPLACE FUNCTION business_seed_roles(target BIGINT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO business_roles (business_id, template_code, name, description, full_access)
  SELECT target, t.code, t.name, t.description, t.full_access FROM business_role_templates t
  WHERE t.business_types IS NULL OR (SELECT business_type FROM businesses WHERE id = target) = ANY (t.business_types)
  ON CONFLICT (business_id, template_code) DO NOTHING;
  INSERT INTO business_role_permissions (business_id, role_id, permission_code)
  SELECT r.business_id, r.id, tp.permission_code
  FROM business_roles r JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
  WHERE r.business_id = target AND NOT r.full_access
    AND NOT EXISTS (SELECT 1 FROM business_role_permissions x WHERE x.role_id = r.id)
  ON CONFLICT DO NOTHING;
$$;
-- Roles made from the trade templates stay with their businesses, as their own.
UPDATE business_roles SET template_code = NULL
WHERE template_code IN ('receptionist', 'member_desk', 'stylist', 'nurse', 'service_advisor', 'presser', 'yard_hand');
DELETE FROM business_role_template_permissions WHERE template_code IN ('receptionist', 'member_desk', 'stylist', 'nurse', 'service_advisor', 'presser', 'yard_hand');
DELETE FROM business_role_templates WHERE code IN ('receptionist', 'member_desk', 'stylist', 'nurse', 'service_advisor', 'presser', 'yard_hand');
UPDATE business_role_templates SET description = 'Reads everything, records payments, exports and prints; changes no stock.' WHERE code = 'accountant';
ALTER TABLE business_role_templates DROP COLUMN stands_for, DROP COLUMN needs_modules;

CREATE OR REPLACE FUNCTION business_tax_change_world() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION business_privacy_person(target_business BIGINT, contact BIGINT, guest BIGINT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF guest IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM customers c JOIN businesses b ON b.legacy_restaurant_id = c.restaurant_id
                   WHERE c.id = guest AND b.id = target_business) THEN
      RAISE EXCEPTION 'This guest belongs to another restaurant' USING ERRCODE = '23514';
    END IF;
  ELSIF contact IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = target_business AND id = contact AND kind = 'customer') THEN
      RAISE EXCEPTION 'Personal data here is about a customer of this business' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION lodging_stays_bill_to() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bill_to_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.bill_to_contact_id AND kind = 'customer') THEN
    RAISE EXCEPTION 'A stay is billed to a customer of this business: add the company as a customer first' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION retail_loyalty_not_negative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held INTEGER;
BEGIN
  SELECT COALESCE(sum(points), 0) INTO held FROM retail_loyalty_entries
  WHERE business_id = NEW.business_id AND contact_id = NEW.contact_id;
  IF held < 0 THEN
    RAISE EXCEPTION 'This would leave the customer with % loyalty points; points cannot go below zero', held USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION business_cash_limit_collection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zone TEXT;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  from_customer := business_cash_from_customer(NEW.business_id, NEW.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
  IF from_customer >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186): today''s cash from this customer would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      from_customer::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc RECORD;
  zone TEXT;
  on_bill NUMERIC;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT d.kind, d.contact_id, d.document_no, d.request_key, d.series_id INTO doc FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN RETURN NEW; END IF;
  IF doc.contact_id IS NULL AND EXISTS (SELECT 1 FROM fuel_shift_closes c WHERE c.business_id = NEW.business_id AND c.walk_in_key = doc.request_key) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_bill FROM business_payments
  WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND method = 'cash';
  IF on_bill >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      doc.document_no, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  -- A collection receipt's own cash was counted when the receipt was taken.
  IF doc.contact_id IS NOT NULL AND NEW.collection_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM business_number_series s WHERE s.business_id = NEW.business_id AND s.id = doc.series_id AND s.device_id IS NOT NULL) THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    from_customer := business_cash_from_customer(NEW.business_id, doc.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
    IF from_customer >= 200000 THEN
      RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186): today''s cash from this customer would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
        from_customer::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_collection_refunds_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt business_collections%ROWTYPE;
  used NUMERIC;
BEGIN
  SELECT * INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF receipt.contact_id <> NEW.contact_id THEN
    RAISE EXCEPTION 'A refund goes back to the customer who paid' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0)
       + COALESCE((SELECT sum(amount) FROM business_collection_refunds WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0)
    INTO used;
  IF used > receipt.amount THEN
    RAISE EXCEPTION 'Collection % has only % left to refund', receipt.collection_no, receipt.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_payments_collection_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt business_collections%ROWTYPE;
  used NUMERIC;
BEGIN
  IF NEW.collection_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM business_collections WHERE business_id = NEW.business_id AND id = NEW.collection_id;
  IF NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id
                 AND kind = 'sale' AND contact_id = receipt.contact_id) THEN
    RAISE EXCEPTION 'A collection can only settle bills of the customer who paid it' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO used FROM business_payments WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id;
  used := used + COALESCE((SELECT sum(amount) FROM business_collection_refunds WHERE business_id = NEW.business_id AND collection_id = NEW.collection_id), 0);
  IF used > receipt.amount THEN
    RAISE EXCEPTION 'Collection % has only % to apply to bills', receipt.collection_no, receipt.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_contact_is_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business_contacts WHERE business_id = NEW.business_id AND id = NEW.contact_id AND kind = 'customer') THEN
    RAISE EXCEPTION 'Choose a customer of this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DELETE FROM business_kind_terms WHERE business_type = 'healthcare' AND kind IN ('physiotherapy', 'diagnostic') AND key = 'example.hsn';
DELETE FROM business_type_terms WHERE business_type IN ('grocery', 'supermarket', 'wholesale', 'general_retail') AND key = 'example.hsn';
DELETE FROM term_keys WHERE key = 'bill';
DROP FUNCTION business_word_lower(BIGINT, TEXT, BOOLEAN);
DROP FUNCTION words_a(TEXT);
DROP FUNCTION words_lower(TEXT);
