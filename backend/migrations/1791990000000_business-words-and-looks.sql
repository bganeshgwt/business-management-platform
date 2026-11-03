-- Up Migration
-- Words and looks per business type.
--
-- A gym, a clinic, a salon and a kirana each name their people, things,
-- places and money their own way: members and trainers, patients and doctors,
-- clients and stylists, customers and udhaar. Every word the screens, bills
-- and messages use for these is kept here, not in code:
--   term_keys            each word the product uses, with its generic default
--   business_type_terms  a business type's own words
--   business_kind_terms  a kind's own words within its type (a yoga studio
--                        among gyms, studios and coaching)
--   business_terms       an owner's own words for their business, for the
--                        words an owner may rename
-- A business's word is its owner's, else its kind's, else its type's, else the
-- default (business_words()). Examples and phrases (an item's example name,
-- the line printed under a bill) are words too, with no plural.
--
-- Each type and kind also has its look: an icon from the staff app's icon set
-- and an accent colour; and a type says whether a new item starts as a
-- service or as goods. Legal and tax words (GSTIN, Tax invoice, Bill of
-- supply, HSN, SAC, CGST) are not words here: the law names them.

-- --- Every word, with its default --------------------------------------------
CREATE TABLE term_keys (
  key              TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$'),
  area             TEXT NOT NULL CHECK (area IN ('people', 'things', 'places', 'work', 'money', 'examples')),
  label            TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  hint             TEXT NOT NULL DEFAULT '' CHECK (char_length(hint) <= 300),
  one              TEXT NOT NULL CHECK (one = btrim(one) AND char_length(one) <= 300),
  many             TEXT CHECK (many = btrim(many) AND char_length(many) BETWEEN 1 AND 80),
  owner_may_rename BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INTEGER NOT NULL,
  -- A word with a plural is a noun of 1 to 80 characters; an example or a
  -- phrase has none, and may be empty (none shown or printed).
  CHECK ((many IS NULL) = (area = 'examples')),
  CHECK (area = 'examples' OR char_length(one) BETWEEN 1 AND 80),
  CHECK (NOT owner_may_rename OR area <> 'examples')
);

-- --- A type's look and the kind a new item starts as ---------------------------
-- The accent is one of the staff app's palette (styles: type-accent-*).
ALTER TABLE business_types
  ADD COLUMN icon TEXT NOT NULL DEFAULT 'store' CHECK (icon ~ '^[a-z][a-z0-9-]{1,39}$'),
  ADD COLUMN accent TEXT NOT NULL DEFAULT 'teal' CHECK (accent IN ('orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'red', 'slate')),
  ADD COLUMN default_item_kind TEXT NOT NULL DEFAULT 'goods' CHECK (default_item_kind IN ('goods', 'service')),
  ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 100;

-- --- Kinds within a type ---------------------------------------------------------
-- A kind switched off stays on the businesses that have it; none can choose it.
CREATE TABLE business_type_kinds (
  business_type TEXT NOT NULL REFERENCES business_types(code) ON DELETE CASCADE,
  code          TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name          TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
  icon          TEXT CHECK (icon ~ '^[a-z][a-z0-9-]{1,39}$'),
  accent        TEXT CHECK (accent IN ('orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'red', 'slate')),
  sort_order    INTEGER NOT NULL DEFAULT 100,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_type, code)
);
CREATE UNIQUE INDEX business_type_kinds_name ON business_type_kinds(business_type, lower(name));

ALTER TABLE businesses ADD COLUMN kind TEXT;
ALTER TABLE businesses ADD CONSTRAINT businesses_kind_fkey
  FOREIGN KEY (business_type, kind) REFERENCES business_type_kinds(business_type, code);

-- A new kind, or a change of kind, must be one that may be chosen now.
CREATE FUNCTION businesses_kind_fits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.kind IS DISTINCT FROM OLD.kind)
     AND NOT EXISTS (SELECT 1 FROM business_type_kinds WHERE business_type = NEW.business_type AND code = NEW.kind AND active) THEN
    RAISE EXCEPTION 'The kind "%" is not one a business of this type may choose now', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_kind_fits BEFORE INSERT OR UPDATE OF kind ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_kind_fits();

-- --- Words of a type, of a kind, and of a business --------------------------------
CREATE TABLE business_type_terms (
  business_type TEXT NOT NULL REFERENCES business_types(code) ON DELETE CASCADE,
  key           TEXT NOT NULL REFERENCES term_keys(key) ON DELETE CASCADE,
  one           TEXT NOT NULL,
  many          TEXT,
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_type, key)
);
CREATE TABLE business_kind_terms (
  business_type TEXT NOT NULL,
  kind          TEXT NOT NULL,
  key           TEXT NOT NULL REFERENCES term_keys(key) ON DELETE CASCADE,
  one           TEXT NOT NULL,
  many          TEXT,
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_type, kind, key),
  FOREIGN KEY (business_type, kind) REFERENCES business_type_kinds(business_type, code) ON DELETE CASCADE
);
CREATE TABLE business_terms (
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT NOT NULL REFERENCES term_keys(key) ON DELETE CASCADE,
  one         TEXT NOT NULL,
  many        TEXT,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, key)
);

-- A word fits its key: trimmed; a plural exactly when the key has one; a noun
-- 1 to 80 characters, an example or phrase up to 300 (empty: none); and an
-- owner's word only for a word an owner may rename.
CREATE FUNCTION business_term_fits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k term_keys;
BEGIN
  SELECT * INTO k FROM term_keys WHERE key = NEW.key;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key refuses it
  END IF;
  NEW.one := btrim(NEW.one);
  NEW.many := NULLIF(btrim(NEW.many), '');
  IF k.many IS NULL AND NEW.many IS NOT NULL THEN
    RAISE EXCEPTION '"%" has no plural', k.label USING ERRCODE = 'check_violation';
  END IF;
  IF k.many IS NOT NULL AND (NEW.many IS NULL OR char_length(NEW.many) > 80) THEN
    RAISE EXCEPTION '"%" needs its plural, up to 80 characters', k.label USING ERRCODE = 'check_violation';
  END IF;
  IF (k.area = 'examples' AND char_length(NEW.one) > 300)
     OR (k.area <> 'examples' AND char_length(NEW.one) NOT BETWEEN 1 AND 80) THEN
    RAISE EXCEPTION '"%" must be % characters', k.label, CASE WHEN k.area = 'examples' THEN 'up to 300' ELSE '1 to 80' END
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'business_terms' AND NOT k.owner_may_rename THEN
    RAISE EXCEPTION '"%" is not a word an owner renames', k.label USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_type_terms_fit BEFORE INSERT OR UPDATE ON business_type_terms
  FOR EACH ROW EXECUTE FUNCTION business_term_fits();
CREATE TRIGGER business_kind_terms_fit BEFORE INSERT OR UPDATE ON business_kind_terms
  FOR EACH ROW EXECUTE FUNCTION business_term_fits();
CREATE TRIGGER business_terms_fit BEFORE INSERT OR UPDATE ON business_terms
  FOR EACH ROW EXECUTE FUNCTION business_term_fits();

-- A business's words: its owner's, else its kind's, else its type's, else the
-- default. Every key, once.
CREATE FUNCTION business_words(p_business BIGINT) RETURNS TABLE (key TEXT, one TEXT, many TEXT)
LANGUAGE sql STABLE AS $$
  SELECT k.key,
         COALESCE(o.one, kt.one, tt.one, k.one),
         CASE WHEN k.many IS NULL THEN NULL ELSE COALESCE(o.many, kt.many, tt.many, k.many) END
  FROM businesses b
  CROSS JOIN term_keys k
  LEFT JOIN business_type_terms tt ON tt.business_type = b.business_type AND tt.key = k.key
  LEFT JOIN business_kind_terms kt ON kt.business_type = b.business_type AND kt.kind = b.kind AND kt.key = k.key
  LEFT JOIN business_terms o ON o.business_id = b.id AND o.key = k.key
  WHERE b.id = p_business
$$;

-- One word of a business, for a message written in the database: the
-- singular, or the plural when `plural` is true.
CREATE FUNCTION business_word(p_business BIGINT, p_key TEXT, p_plural BOOLEAN DEFAULT FALSE) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_plural THEN COALESCE(w.many, w.one) ELSE w.one END
  FROM business_words(p_business) w WHERE w.key = p_key
$$;

-- --- The words -----------------------------------------------------------------
INSERT INTO term_keys (key, area, label, hint, one, many, owner_may_rename, sort_order) VALUES
  -- People
  ('customer', 'people', 'The people you serve', 'In sentences, columns and fields: “Choose the member”, “Members owe ₹4,500”.', 'Customer', 'Customers', TRUE, 10),
  ('customer_list', 'people', 'Your list of the people you bill', 'The menu and page title of the contacts you bill.', 'Customer', 'Customers', TRUE, 20),
  ('walk_in', 'people', 'Someone not on your list', 'A bill with nobody chosen.', 'Walk-in customer', 'Walk-in customers', FALSE, 30),
  ('provider', 'people', 'Who serves at a booking', 'Commission, the day''s people cards, the person on a booking.', 'Staff member', 'Staff', TRUE, 40),
  ('resource', 'people', 'What can be booked', 'The list of the people and rooms a booking takes.', 'Staff member or room', 'Staff & rooms', TRUE, 50),
  -- Things
  ('catalog', 'things', 'What you sell, as a list', 'Singular: the list in a sentence (“from your plan list”). Plural: the menu title.', 'Product list', 'Products & services', TRUE, 110),
  ('item', 'things', 'One thing you sell', '“Add a plan or service”, “Plan or service name”.', 'Product', 'Products', TRUE, 120),
  ('goods', 'things', 'What is kept in stock', 'The item kind “Goods (kept in stock)”.', 'Goods', 'Goods', FALSE, 130),
  ('service', 'things', 'What is done, not stocked', 'The item kind “Service”.', 'Service', 'Services', FALSE, 140),
  ('item_code', 'things', 'An item''s own code', 'The code field and column of an item.', 'SKU code', 'SKU codes', FALSE, 150),
  ('variant', 'things', 'A variant of an item', 'The variants screen: sizes and colours, sizes and shades.', 'Variant', 'Variants', FALSE, 160),
  ('price_list', 'things', 'Prices for some customers', 'The screen of prices for dealers, contractors or regular customers.', 'Wholesale price list', 'Wholesale prices', FALSE, 170),
  ('processing', 'work', 'Turning stock into what is sold', 'Cutting meat into cuts, or sorting and repacking loose goods.', 'Cutting & yield', 'Cutting & yield', FALSE, 330),
  -- Places
  ('location', 'places', 'A place you work from', 'Locations in pickers, reports and settings.', 'Location', 'Locations', TRUE, 210),
  ('counter', 'places', 'Where people pay', '“Paid at the counter”, “a QR at the counter”.', 'Counter', 'Counters', TRUE, 220),
  ('till', 'places', 'What a person locks when they step away', '“Lock the screen”, “Screen locked”.', 'Screen', 'Screens', FALSE, 230),
  -- Work
  ('sale', 'work', 'A sale, as your screens name it', '“New sale”, “Sales today”.', 'Sale', 'Sales', FALSE, 310),
  ('appointment', 'work', 'A booking for a time', 'Bookings, the calendar and reminders.', 'Appointment', 'Appointments', TRUE, 320),
  -- Money
  ('dues_list', 'money', 'The list of what people owe', 'The menu and page title of dues.', 'Customer dues', 'Customer dues', TRUE, 410),
  ('dues', 'money', 'What someone owes', '“Collect dues”, “dues collected”.', 'Dues', 'Dues', FALSE, 420),
  ('on_account', 'money', 'A bill left unpaid on someone''s name', 'The tender at the counter and the day''s money: “Given on account”.', 'On account', 'On account', FALSE, 430),
  ('collection', 'money', 'Money received against dues', 'The page and the button: “Record a payment received”.', 'Payment received', 'Payments received', TRUE, 440),
  -- Examples and phrases: shown after "e.g." unless they are a sentence.
  ('example.item_name', 'examples', 'An item''s name', 'The item form''s name field.', 'Toor dal 1 kg', NULL, FALSE, 510),
  ('example.variant', 'examples', 'A variant', 'The item form''s name hint.', '500 g / 1 kg', NULL, FALSE, 520),
  ('example.shelf', 'examples', 'Where an item is kept', 'The item form''s shelf field.', 'Aisle 3 · Shelf B', NULL, FALSE, 530),
  ('example.consumables', 'examples', 'What is used up in a service', 'The item form''s “for use in services only”.', 'cleaning supplies, packing material', NULL, FALSE, 540),
  ('example.category', 'examples', 'A category path', 'The categories page.', 'Staples › Rice › Basmati', NULL, FALSE, 550),
  ('example.department', 'examples', 'A department', 'The departments box; empty: the business keeps no departments.', '', NULL, FALSE, 560),
  ('example.units', 'examples', 'How things are counted or packed', 'The units page.', 'a box, a strip or a case', NULL, FALSE, 570),
  ('example.unit_code', 'examples', 'A unit''s code', 'The units page''s code field.', 'carton', NULL, FALSE, 580),
  ('example.offers', 'examples', 'Offers you run', 'The offers page.', '10% off ghee, ₹5 off each soap, buy 2 get 1 free', NULL, FALSE, 590),
  ('example.offer_name', 'examples', 'An offer''s name', 'The offer form.', 'Diwali 10% off dry fruits', NULL, FALSE, 600),
  ('example.offer_hours', 'examples', 'An offer by the hour', 'The name of an offer for some hours of the day.', 'Off-peak hours', NULL, FALSE, 610),
  ('example.loyalty_reason', 'examples', 'Why points are given by hand', 'The loyalty page.', 'Diwali bonus promised in store', NULL, FALSE, 620),
  ('example.customer_book', 'examples', 'Where your list is kept today', 'The import of your list: “from your old ledger”.', 'your old ledger', NULL, FALSE, 630),
  ('example.supplier', 'examples', 'A supplier''s name', 'A new supplier.', 'Sri Lakshmi Traders', NULL, FALSE, 640),
  ('example.resource', 'examples', 'A bookable person or room', 'The bookable list.', 'Ravi or Room 1', NULL, FALSE, 650),
  ('example.promise', 'examples', 'A promise to pay', 'A promise note on dues.', 'Will pay after salary on the 7th', NULL, FALSE, 660),
  ('example.invoice_footer', 'examples', 'A line under your bills', 'Business settings, the bill footer.', 'Goods once sold will be exchanged within 7 days with the bill.', NULL, FALSE, 670),
  ('example.quotation_terms', 'examples', 'Terms on a quotation', 'Business settings, quotation terms.', 'Prices valid 7 days; free delivery above ₹2,000.', NULL, FALSE, 680),
  ('example.location', 'examples', 'A location''s name', 'A new location.', 'Koregaon Park store', NULL, FALSE, 690),
  ('example.first_location', 'examples', 'The first location''s name', 'A new business''s first location, when none is given.', 'Main store', NULL, FALSE, 700),
  ('example.tax_slab', 'examples', 'A GST slab''s name', 'Tax rates.', 'Packaged food', NULL, FALSE, 710),
  ('example.hsn', 'examples', 'An HSN or SAC code', 'GST rate changes, the code filter.', '1905', NULL, FALSE, 720),
  ('example.supplies', 'examples', 'What the place runs on', 'An expense category.', 'Shop supplies', NULL, FALSE, 730),
  ('example.count', 'examples', 'A stock count', 'Stock counts.', 'Month-end count, aisle 1–4', NULL, FALSE, 740),
  ('example.kit', 'examples', 'A kit or combo', 'Kits.', 'Festive hamper', NULL, FALSE, 750),
  ('example.checklist_section', 'examples', 'A checklist section', 'Task checklists.', 'Cold room', NULL, FALSE, 760),
  ('example.checklist_item', 'examples', 'A checklist line', 'Task checklists.', 'Freezer at −18 °C', NULL, FALSE, 770),
  ('example.templates', 'examples', 'Checklists you keep', 'Task templates.', 'opening checklist, temperature log, FSSAI', NULL, FALSE, 780),
  ('example.issue', 'examples', 'Something that broke', 'Issues.', 'Freezer not cooling, scale showing the wrong weight', NULL, FALSE, 790),
  ('example.project', 'examples', 'A project', 'Projects.', 'A new branch, a festival sale, the annual stock audit', NULL, FALSE, 800),
  ('example.quick_access', 'examples', 'What to search for', 'Quick access: “Try …”.', 'Quick bill, bills or stock', NULL, FALSE, 810),
  ('phrase.bill_note', 'examples', 'The line printed under every bill', 'Printed under every A4 bill; empty prints none.', 'Goods once sold are subject to the shop''s exchange policy.', NULL, FALSE, 900),
  ('phrase.quotation_hold', 'examples', 'What a quotation holds', 'Printed on every quotation.', 'Goods are kept aside only once the bill is made.', NULL, FALSE, 910),
  ('phrase.sales_history', 'examples', 'The list of past sales', 'Its tab and title.', 'Sales history', NULL, FALSE, 920),
  ('phrase.stock', 'examples', 'The stock screen', 'Its tab and title.', 'Stock', NULL, FALSE, 930),
  ('phrase.processing_report', 'examples', 'What cutting or repacking left', 'The report of yield and wastage.', 'Cutting & wastage', NULL, FALSE, 940),
  ('phrase.statement', 'examples', 'A statement of what someone owes', 'Its title, printed and sent.', 'Statement of account', NULL, FALSE, 950);

-- --- Each type's look and starting item kind ----------------------------------------
UPDATE business_types t SET icon = v.icon, accent = v.accent, default_item_kind = v.item_kind, sort_order = v.sort_order
FROM (VALUES
  ('restaurant', 'utensils', 'orange', 'goods', 10),
  ('grocery', 'basket', 'green', 'goods', 20),
  ('supermarket', 'cart', 'emerald', 'goods', 30),
  ('general_retail', 'store', 'violet', 'goods', 40),
  ('meat', 'fish', 'red', 'goods', 50),
  ('weight_retail', 'scale', 'amber', 'goods', 60),
  ('wholesale', 'truck', 'blue', 'goods', 70),
  ('fashion', 'shirt', 'pink', 'goods', 80),
  ('electronics', 'smartphone', 'sky', 'goods', 90),
  ('books', 'book', 'indigo', 'goods', 100),
  ('pharmacy', 'pill', 'teal', 'goods', 110),
  ('optical', 'glasses', 'purple', 'goods', 120),
  ('jewellery', 'gem', 'amber', 'goods', 130),
  ('hardware', 'hammer', 'slate', 'goods', 140),
  ('agri_inputs', 'sprout', 'lime', 'goods', 150),
  ('garage', 'wrench', 'blue', 'goods', 160),
  ('fuel_station', 'fuel', 'orange', 'goods', 170),
  ('salon', 'scissors', 'fuchsia', 'service', 180),
  ('healthcare', 'stethoscope', 'cyan', 'service', 190),
  ('memberships', 'dumbbell', 'rose', 'service', 200),
  ('laundry', 'hanger', 'sky', 'service', 210),
  ('rentals', 'key', 'teal', 'service', 220),
  ('lodging', 'bed', 'indigo', 'service', 230)
) AS v(code, icon, accent, item_kind, sort_order)
WHERE t.code = v.code;

-- --- Kinds -----------------------------------------------------------------------
INSERT INTO business_type_kinds (business_type, code, name, icon, sort_order) VALUES
  ('memberships', 'gym', 'Gym & fitness centre', 'dumbbell', 10),
  ('memberships', 'yoga_studio', 'Yoga studio', 'lotus', 20),
  ('memberships', 'dance_studio', 'Dance studio', 'music', 30),
  ('memberships', 'coaching', 'Coaching & tuition centre', 'graduation', 40),
  ('memberships', 'sports_academy', 'Sports & martial arts academy', 'medal', 50),
  ('healthcare', 'clinic', 'Clinic', 'stethoscope', 10),
  ('healthcare', 'dental', 'Dental clinic', 'tooth', 20),
  ('healthcare', 'physiotherapy', 'Physiotherapy centre', 'activity', 30),
  ('healthcare', 'diagnostic', 'Diagnostic centre', 'flask', 40),
  ('salon', 'salon', 'Salon', 'scissors', 10),
  ('salon', 'unisex_salon', 'Unisex salon', 'scissors', 20),
  ('salon', 'barber', 'Barber shop', 'comb', 30),
  ('salon', 'beauty_parlour', 'Beauty parlour', 'sparkles', 40),
  ('salon', 'spa', 'Spa', 'lotus', 50),
  ('lodging', 'hotel', 'Hotel', 'building', 10),
  ('lodging', 'lodge', 'Lodge', 'bed', 20),
  ('lodging', 'guest_house', 'Guest house', 'home', 30),
  ('lodging', 'homestay', 'Homestay', 'home', 40),
  ('laundry', 'laundry', 'Laundry', 'washer', 10),
  ('laundry', 'dry_cleaner', 'Dry cleaner', 'hanger', 20),
  ('laundry', 'ironing', 'Ironing & press', 'iron', 30),
  ('rentals', 'vehicles', 'Vehicle rentals', 'car', 10),
  ('rentals', 'equipment', 'Equipment hire', 'wrench', 20),
  ('rentals', 'events', 'Event & party rentals', 'tent', 30);

-- --- Each type's words ------------------------------------------------------------
-- Only what differs from the default. Shops that call credit "udhaar" say so.
INSERT INTO business_type_terms (business_type, key, one, many)
SELECT t.code, w.key, w.one, w.many
FROM (VALUES ('grocery'), ('meat'), ('weight_retail'), ('general_retail'), ('hardware'), ('agri_inputs')) AS t(code)
CROSS JOIN (VALUES
  ('dues_list', 'Udhaar', 'Udhaar'),
  ('dues', 'Udhaar', 'Udhaar'),
  ('on_account', 'Udhaar', 'Udhaar'),
  ('collection', 'Udhaar payment', 'Udhaar payments'),
  ('example.customer_book', 'your udhaar book', NULL),
  ('phrase.statement', 'Udhaar statement', NULL)
) AS w(key, one, many);

-- Businesses that bill their time and work keep a bill history.
INSERT INTO business_type_terms (business_type, key, one, many)
SELECT code, 'phrase.sales_history', 'Bill history', NULL FROM business_types
WHERE code IN ('restaurant', 'salon', 'healthcare', 'memberships', 'laundry', 'rentals', 'lodging');

-- Every shop with Quick bill locks a till.
INSERT INTO business_type_terms (business_type, key, one, many)
SELECT code, 'till', 'Till', 'Tills' FROM business_types
WHERE code IN ('restaurant', 'grocery', 'supermarket', 'general_retail', 'meat', 'weight_retail', 'wholesale', 'fashion', 'electronics', 'books',
  'pharmacy', 'optical', 'jewellery', 'hardware', 'agri_inputs', 'garage', 'fuel_station');

INSERT INTO business_type_terms (business_type, key, one, many) VALUES
  -- Restaurants and food outlets (their own screens keep their own words)
  ('restaurant', 'customer', 'Guest', 'Guests'),
  ('restaurant', 'customer_list', 'Guest', 'Guests'),
  ('restaurant', 'walk_in', 'Walk-in guest', 'Walk-in guests'),
  ('restaurant', 'catalog', 'Menu', 'Menu'),
  ('restaurant', 'item', 'Dish', 'Dishes'),
  ('restaurant', 'sale', 'Bill', 'Bills'),
  ('restaurant', 'location', 'Outlet', 'Outlets'),
  ('restaurant', 'example.first_location', 'Main outlet', NULL),
  ('restaurant', 'example.location', 'Koramangala outlet', NULL),
  -- Grocery & kirana: the defaults are a grocer's.
  -- Supermarkets & department stores
  ('supermarket', 'example.kit', 'Festive hamper (dry fruits + sweets + diya)', NULL),
  ('supermarket', 'example.department', 'Home & kitchen', NULL),
  -- General store & other shops
  ('general_retail', 'example.item_name', 'Steel water bottle 1 L', NULL),
  ('general_retail', 'example.category', 'Kitchen › Bottles › Steel', NULL),
  ('general_retail', 'example.variant', 'Blue / 1 L', NULL),
  ('general_retail', 'example.department', 'Kitchen', NULL),
  -- Meat & seafood
  ('meat', 'price_list', 'Customer rate', 'Customer rates'),
  ('meat', 'processing', 'Cutting & processing', 'Cutting & processing'),
  ('meat', 'example.item_name', 'Chicken curry cut', NULL),
  ('meat', 'example.variant', 'With skin / Skinless', NULL),
  ('meat', 'example.category', 'Chicken › Curry cut › Skinless', NULL),
  ('meat', 'example.units', 'a kilo, a piece or a tray', NULL),
  ('meat', 'example.unit_code', 'tray', NULL),
  ('meat', 'example.offers', '₹20 off a kilo of chicken on Sundays, free masala with mutton', NULL),
  ('meat', 'example.offer_name', 'Sunday special ₹20 off a kilo', NULL),
  ('meat', 'example.supplier', 'Sri Durga Poultry Farm', NULL),
  ('meat', 'example.shelf', 'Chiller 2', NULL),
  ('meat', 'example.first_location', 'Main shop', NULL),
  ('meat', 'example.location', 'Market Road shop', NULL),
  ('meat', 'example.tax_slab', 'Fresh meat (nil)', NULL),
  ('meat', 'example.hsn', '0207', NULL),
  ('meat', 'example.count', 'Closing count, chiller 1–2', NULL),
  ('meat', 'example.kit', 'Biryani pack (mutton + masala)', NULL),
  -- Other weight-based shops (dry fruits, sweets, loose goods)
  ('weight_retail', 'price_list', 'Customer rate', 'Customer rates'),
  ('weight_retail', 'processing', 'Sorting & repacking', 'Sorting & repacking'),
  ('weight_retail', 'phrase.processing_report', 'Repacking & wastage', NULL),
  ('weight_retail', 'example.item_name', 'Almonds (California) loose', NULL),
  ('weight_retail', 'example.variant', '250 g / 500 g', NULL),
  ('weight_retail', 'example.category', 'Dry fruits › Almonds › California', NULL),
  ('weight_retail', 'example.units', 'a kilo, a jar or a pack', NULL),
  ('weight_retail', 'example.unit_code', 'jar', NULL),
  ('weight_retail', 'example.offers', '10% off cashews above 1 kg, a free 100 g raisins pack', NULL),
  ('weight_retail', 'example.offer_name', 'Diwali 10% off dry fruits', NULL),
  ('weight_retail', 'example.first_location', 'Main shop', NULL),
  ('weight_retail', 'example.location', 'Gandhi Bazaar shop', NULL),
  ('weight_retail', 'example.tax_slab', 'Dry fruits 5%', NULL),
  ('weight_retail', 'example.hsn', '0802', NULL),
  ('weight_retail', 'example.kit', 'Diwali dry fruit box', NULL),
  -- Wholesale & FMCG distribution
  ('wholesale', 'customer_list', 'Customer or retailer', 'Customers & retailers'),
  ('wholesale', 'price_list', 'Price list', 'Price lists'),
  ('wholesale', 'example.supplier', 'Sri Lakshmi Agencies (C&F)', NULL),
  ('wholesale', 'example.promise', 'Will send a cheque with the salesman', NULL),
  ('wholesale', 'example.first_location', 'Main godown', NULL),
  ('wholesale', 'example.location', 'Hosur Road godown', NULL),
  ('wholesale', 'example.shelf', 'Bay 4 · Rack 2', NULL),
  ('wholesale', 'example.units', 'a case, a carton or a bale', NULL),
  ('wholesale', 'example.offers', 'one case free on ten, 2% off on cash payment', NULL),
  ('wholesale', 'example.offer_name', 'Festive scheme: 1 case free on 10', NULL),
  ('wholesale', 'example.count', 'Month-end count, bays 1–6', NULL),
  -- Garments & textiles
  ('fashion', 'catalog', 'Product list', 'Products & variants'),
  ('fashion', 'variant', 'Size × colour', 'Size × colour'),
  ('fashion', 'example.item_name', 'Cotton kurta', NULL),
  ('fashion', 'example.variant', 'Blue / M', NULL),
  ('fashion', 'example.category', 'Women › Kurtas › Cotton', NULL),
  ('fashion', 'example.department', 'Menswear', NULL),
  ('fashion', 'example.shelf', 'Rack 4 · Shelf 2', NULL),
  ('fashion', 'example.units', 'a piece, a set or a metre', NULL),
  ('fashion', 'example.unit_code', 'set', NULL),
  ('fashion', 'example.offers', '20% off kurtas, buy 2 get 1 free on T-shirts', NULL),
  ('fashion', 'example.offer_name', 'Diwali 20% off ethnic wear', NULL),
  ('fashion', 'example.supplier', 'Sri Balaji Textiles', NULL),
  ('fashion', 'example.invoice_footer', 'Exchange within 7 days with the bill and the tags on.', NULL),
  ('fashion', 'example.tax_slab', 'Garments up to ₹2,500', NULL),
  ('fashion', 'example.hsn', '6204', NULL),
  ('fashion', 'example.count', 'Season-end count, racks 1–8', NULL),
  ('fashion', 'example.kit', 'Wedding set (kurta + dupatta)', NULL),
  ('fashion', 'phrase.bill_note', 'Goods once sold are exchanged as per the store''s policy.', NULL),
  -- Electronics & mobiles
  ('electronics', 'catalog', 'Product list', 'Products & models'),
  ('electronics', 'provider', 'Technician', 'Technicians'),
  ('electronics', 'resource', 'Technician or desk', 'Technicians & desks'),
  ('electronics', 'appointment', 'Service booking', 'Service bookings'),
  ('electronics', 'example.item_name', 'Orbit 5G 128 GB', NULL),
  ('electronics', 'example.variant', 'Black / 128 GB', NULL),
  ('electronics', 'example.category', 'Mobiles › Smartphones › 5G', NULL),
  ('electronics', 'example.department', 'Mobiles', NULL),
  ('electronics', 'example.units', 'a piece or a box', NULL),
  ('electronics', 'example.offers', '₹1,000 off on exchange, a free screen guard with a phone', NULL),
  ('electronics', 'example.offer_name', 'Festive ₹2,000 off 5G phones', NULL),
  ('electronics', 'example.supplier', 'Sri Sai Mobiles Distributors', NULL),
  ('electronics', 'example.resource', 'Imran (technician) or Desk 1', NULL),
  ('electronics', 'example.invoice_footer', 'Warranty as per the maker''s card; keep this bill.', NULL),
  ('electronics', 'example.tax_slab', 'Mobile phones', NULL),
  ('electronics', 'example.hsn', '8517', NULL),
  ('electronics', 'example.kit', 'Orbit 5G combo (phone + cover + glass)', NULL),
  ('electronics', 'example.quick_access', 'Quick bill, repairs or stock', NULL),
  ('electronics', 'phrase.bill_note', 'The warranty is the maker''s, as on its warranty card.', NULL),
  -- Books & stationery
  ('books', 'catalog', 'Book list', 'Books & stationery'),
  ('books', 'item', 'Book or item', 'Books & items'),
  ('books', 'example.item_name', 'NCERT Mathematics Class 10', NULL),
  ('books', 'example.variant', 'Paperback / Hardcover', NULL),
  ('books', 'example.category', 'School › CBSE › Class 10', NULL),
  ('books', 'example.units', 'a copy, a set or a dozen', NULL),
  ('books', 'example.unit_code', 'set', NULL),
  ('books', 'example.offers', '10% off on school sets, a free cover with every notebook dozen', NULL),
  ('books', 'example.offer_name', 'Back to school 10% off', NULL),
  ('books', 'example.supplier', 'Sri Ganesh Book Distributors', NULL),
  ('books', 'example.tax_slab', 'Printed books (nil)', NULL),
  ('books', 'example.hsn', '4901', NULL),
  ('books', 'example.kit', 'Class 10 CBSE book set', NULL),
  ('books', 'example.count', 'Year-end count, shelves A–F', NULL),
  -- Pharmacy
  ('pharmacy', 'catalog', 'Medicine list', 'Medicines & products'),
  ('pharmacy', 'item', 'Medicine or product', 'Medicines & products'),
  ('pharmacy', 'goods', 'Medicine or product', 'Medicines & products'),
  ('pharmacy', 'example.item_name', 'Paracetamol 650 mg tablet', NULL),
  ('pharmacy', 'example.variant', 'Strip of 15', NULL),
  ('pharmacy', 'example.shelf', 'Rack C · Drawer 4', NULL),
  ('pharmacy', 'example.category', 'Medicines › Pain relief › Tablets', NULL),
  ('pharmacy', 'example.units', 'a strip, a bottle or a box', NULL),
  ('pharmacy', 'example.unit_code', 'strip', NULL),
  ('pharmacy', 'example.offers', '10% off medicines above ₹500, 15% off for senior citizens', NULL),
  ('pharmacy', 'example.offer_name', 'Senior citizens 15% off', NULL),
  ('pharmacy', 'example.supplier', 'Sri Murugan Medical Agencies', NULL),
  ('pharmacy', 'example.invoice_footer', 'Please check the batch and expiry before you leave the counter.', NULL),
  ('pharmacy', 'example.tax_slab', 'Medicines 5%', NULL),
  ('pharmacy', 'example.hsn', '3004', NULL),
  ('pharmacy', 'example.count', 'Month-end count, racks A–D', NULL),
  ('pharmacy', 'example.kit', 'First-aid kit', NULL),
  ('pharmacy', 'example.quick_access', 'Quick bill, batches or stock', NULL),
  ('pharmacy', 'phrase.bill_note', 'Keep this bill: it carries the batch and expiry of each medicine.', NULL),
  -- Optical shops
  ('optical', 'catalog', 'Product list', 'Frames, lenses & products'),
  ('optical', 'variant', 'Frame colour or size', 'Frame colours & sizes'),
  ('optical', 'provider', 'Optometrist', 'Optometrists'),
  ('optical', 'resource', 'Optometrist or room', 'Optometrists & rooms'),
  ('optical', 'appointment', 'Eye test', 'Eye tests'),
  ('optical', 'example.item_name', 'Titanium frame 52-18', NULL),
  ('optical', 'example.variant', 'Black / 52 mm', NULL),
  ('optical', 'example.category', 'Frames › Full rim › Metal', NULL),
  ('optical', 'example.shelf', 'Display 2 · Tray 3', NULL),
  ('optical', 'example.units', 'a piece, a pair or a box', NULL),
  ('optical', 'example.unit_code', 'pair', NULL),
  ('optical', 'example.offers', 'free anti-glare on frames above ₹2,000, 10% off contact lenses', NULL),
  ('optical', 'example.offer_name', 'Back to school 10% off frames', NULL),
  ('optical', 'example.supplier', 'Sri Vision Optical Distributors', NULL),
  ('optical', 'example.resource', 'Ramesh (optometrist) or Room 1', NULL),
  ('optical', 'example.invoice_footer', 'Spectacles are ready in 3 days; keep this bill for the warranty.', NULL),
  ('optical', 'example.tax_slab', 'Spectacles 5%', NULL),
  ('optical', 'example.hsn', '9004', NULL),
  ('optical', 'example.kit', 'Frame + anti-glare lenses', NULL),
  ('optical', 'example.quick_access', 'eye tests, orders or stock', NULL),
  -- Jewellery & gold
  ('jewellery', 'catalog', 'Item list', 'Jewellery & items'),
  ('jewellery', 'item', 'Piece', 'Pieces'),
  ('jewellery', 'goods', 'Piece', 'Pieces'),
  ('jewellery', 'example.item_name', '22K gold chain 20 g', NULL),
  ('jewellery', 'example.variant', '22K / 18K', NULL),
  ('jewellery', 'example.shelf', 'Counter 3 · Tray 2', NULL),
  ('jewellery', 'example.category', 'Gold › Chains › 22K', NULL),
  ('jewellery', 'example.units', 'a gram or a piece', NULL),
  ('jewellery', 'example.unit_code', 'gram', NULL),
  ('jewellery', 'example.offers', '50% off making charges, free silver coin above ₹50,000', NULL),
  ('jewellery', 'example.offer_name', 'Akshaya Tritiya 50% off making charges', NULL),
  ('jewellery', 'example.supplier', 'Sri Lakshmi Bullion', NULL),
  ('jewellery', 'example.invoice_footer', 'Old gold is exchanged at the day''s rate; every hallmarked piece carries its HUID.', NULL),
  ('jewellery', 'example.first_location', 'Main showroom', NULL),
  ('jewellery', 'example.location', 'T. Nagar showroom', NULL),
  ('jewellery', 'example.tax_slab', 'Gold 3%', NULL),
  ('jewellery', 'example.hsn', '7113', NULL),
  ('jewellery', 'example.count', 'Day-end tray count', NULL),
  ('jewellery', 'example.kit', 'Bridal set (necklace + earrings)', NULL),
  ('jewellery', 'example.quick_access', 'today''s rates, bills or stock', NULL),
  ('jewellery', 'phrase.bill_note', 'Hallmarked pieces; exchanged and bought back as per the store''s policy.', NULL),
  -- Hardware, paints & building materials
  ('hardware', 'customer_list', 'Customer or contractor', 'Customers & contractors'),
  ('hardware', 'price_list', 'Contractor & dealer rate', 'Contractor & dealer rates'),
  ('hardware', 'variant', 'Size or shade', 'Sizes & shades'),
  ('hardware', 'example.item_name', 'PVC pipe 1 inch', NULL),
  ('hardware', 'example.variant', '1 inch / 2 inch', NULL),
  ('hardware', 'example.shelf', 'Yard 2 · Rack 5', NULL),
  ('hardware', 'example.category', 'Plumbing › Pipes › PVC', NULL),
  ('hardware', 'example.department', 'Paints', NULL),
  ('hardware', 'example.units', 'a piece, a box or a bag', NULL),
  ('hardware', 'example.unit_code', 'bag', NULL),
  ('hardware', 'example.offers', '5% off cement for contractors, a free brush with 20 L of paint', NULL),
  ('hardware', 'example.offer_name', 'Monsoon 5% off waterproofing', NULL),
  ('hardware', 'example.supplier', 'Sri Ram Steel Traders', NULL),
  ('hardware', 'example.promise', 'Contractor pays when the site bill is cleared', NULL),
  ('hardware', 'example.quotation_terms', 'Prices include delivery within the city. 50% advance with the order. Unloading by the customer.', NULL),
  ('hardware', 'example.tax_slab', 'Cement 18%', NULL),
  ('hardware', 'example.hsn', '3917', NULL),
  ('hardware', 'example.kit', 'Bathroom fitting set (tap + shower + mixer)', NULL),
  ('hardware', 'example.location', 'Station Road shop', NULL),
  ('hardware', 'example.first_location', 'Main shop', NULL),
  -- Seeds, fertilisers & pesticides
  ('agri_inputs', 'customer', 'Farmer', 'Farmers'),
  ('agri_inputs', 'customer_list', 'Farmer or customer', 'Farmers & customers'),
  ('agri_inputs', 'walk_in', 'Walk-in farmer', 'Walk-in farmers'),
  ('agri_inputs', 'catalog', 'Product list', 'Seeds, fertilisers & pesticides'),
  ('agri_inputs', 'price_list', 'Dealer rate', 'Dealer rates'),
  ('agri_inputs', 'example.item_name', 'DAP 50 kg bag', NULL),
  ('agri_inputs', 'example.variant', '25 kg / 50 kg', NULL),
  ('agri_inputs', 'example.shelf', 'Godown 1 · Stack 3', NULL),
  ('agri_inputs', 'example.category', 'Fertilisers › Phosphatic › DAP', NULL),
  ('agri_inputs', 'example.units', 'a bag, a packet or a litre', NULL),
  ('agri_inputs', 'example.unit_code', 'bag', NULL),
  ('agri_inputs', 'example.offers', '₹50 off a bag of DAP before sowing, a free sprayer nozzle with 5 L', NULL),
  ('agri_inputs', 'example.offer_name', 'Kharif season ₹50 off', NULL),
  ('agri_inputs', 'example.supplier', 'Sri Krishna Agro Agencies', NULL),
  ('agri_inputs', 'example.promise', 'Will pay after the harvest', NULL),
  ('agri_inputs', 'example.tax_slab', 'Fertilisers 5%', NULL),
  ('agri_inputs', 'example.hsn', '3105', NULL),
  ('agri_inputs', 'example.kit', 'Paddy starter kit (seed + fertiliser)', NULL),
  ('agri_inputs', 'example.location', 'Mandya shop', NULL),
  ('agri_inputs', 'example.first_location', 'Main shop', NULL),
  -- Vehicle service & auto parts
  ('garage', 'catalog', 'Rate list', 'Parts & services'),
  ('garage', 'price_list', 'Mechanic & retailer rate', 'Mechanic & retailer rates'),
  ('garage', 'item', 'Part or service', 'Parts & services'),
  ('garage', 'goods', 'Part', 'Parts'),
  ('garage', 'item_code', 'Part number', 'Part numbers'),
  ('garage', 'provider', 'Mechanic', 'Mechanics'),
  ('garage', 'resource', 'Mechanic or bay', 'Mechanics & bays'),
  ('garage', 'appointment', 'Service booking', 'Service bookings'),
  ('garage', 'counter', 'Service desk', 'Service desks'),
  ('garage', 'on_account', 'On account', 'On account'),
  ('garage', 'example.item_name', 'Oil filter — Swift', NULL),
  ('garage', 'example.variant', 'Oil filter · Swift', NULL),
  ('garage', 'example.shelf', 'Rack B2 · Bin 14', NULL),
  ('garage', 'example.consumables', 'grease, coolant, cotton waste', NULL),
  ('garage', 'example.category', 'Engine › Filters › Oil filters', NULL),
  ('garage', 'example.units', 'a litre, a set or a piece', NULL),
  ('garage', 'example.unit_code', 'set', NULL),
  ('garage', 'example.offers', '10% off engine oil, ₹200 off a general service', NULL),
  ('garage', 'example.offer_name', 'Monsoon check-up ₹299', NULL),
  ('garage', 'example.offer_hours', 'Weekday hours', NULL),
  ('garage', 'example.loyalty_reason', 'Bonus on the 5th service', NULL),
  ('garage', 'example.customer_book', 'your customer ledger', NULL),
  ('garage', 'example.supplier', 'Sri Ganesh Auto Spares', NULL),
  ('garage', 'example.resource', 'Ravi (mechanic) or Bay 2', NULL),
  ('garage', 'example.promise', 'Pays when the vehicle is collected', NULL),
  ('garage', 'example.invoice_footer', 'Labour warranty 30 days or 1,000 km.', NULL),
  ('garage', 'example.quotation_terms', 'Estimate valid 7 days; extra parts only with your approval.', NULL),
  ('garage', 'example.location', 'Hosur Road workshop', NULL),
  ('garage', 'example.first_location', 'Main workshop', NULL),
  ('garage', 'example.tax_slab', 'Spare parts 18%', NULL),
  ('garage', 'example.hsn', '8421', NULL),
  ('garage', 'example.supplies', 'Workshop supplies', NULL),
  ('garage', 'example.count', 'Month-end count, racks A–D', NULL),
  ('garage', 'example.kit', 'Service kit (oil + oil filter + air filter)', NULL),
  ('garage', 'example.checklist_section', 'Workshop', NULL),
  ('garage', 'example.checklist_item', 'Hoist lock checked', NULL),
  ('garage', 'example.templates', 'workshop safety round, opening checklist', NULL),
  ('garage', 'example.issue', 'Hoist 2 leaking oil, wheel aligner out of calibration', NULL),
  ('garage', 'example.project', 'A monsoon service camp, a new paint booth', NULL),
  ('garage', 'example.quick_access', 'job cards, vehicles or Quick bill', NULL),
  ('garage', 'phrase.bill_note', 'Parts carry the maker''s warranty.', NULL),
  ('garage', 'phrase.quotation_hold', 'Parts are ordered once you approve the estimate.', NULL),
  -- Fuel stations
  ('fuel_station', 'customer_list', 'Customer or fleet', 'Customers & fleets'),
  ('fuel_station', 'catalog', 'Product list', 'Fuels, lubricants & items'),
  ('fuel_station', 'example.item_name', 'Engine oil 1 L', NULL),
  ('fuel_station', 'example.variant', '1 L / 3.5 L', NULL),
  ('fuel_station', 'example.category', 'Lubricants › Engine oil', NULL),
  ('fuel_station', 'example.units', 'a litre or a can', NULL),
  ('fuel_station', 'example.unit_code', 'can', NULL),
  ('fuel_station', 'example.supplier', 'the oil company''s depot', NULL),
  ('fuel_station', 'example.promise', 'Fleet pays on the 5th', NULL),
  ('fuel_station', 'example.location', 'NH-48 outlet', NULL),
  ('fuel_station', 'example.first_location', 'Main outlet', NULL),
  ('fuel_station', 'example.tax_slab', 'Lubricants 18%', NULL),
  ('fuel_station', 'example.hsn', '2710', NULL),
  ('fuel_station', 'example.quick_access', 'shifts, readings or Quick bill', NULL),
  ('fuel_station', 'example.checklist_section', 'Forecourt', NULL),
  ('fuel_station', 'example.checklist_item', 'Fire extinguishers checked', NULL),
  ('fuel_station', 'example.issue', 'Nozzle 3 dripping, density meter not reading', NULL),
  -- Salon & spa
  ('salon', 'customer', 'Client', 'Clients'),
  ('salon', 'customer_list', 'Client', 'Clients'),
  ('salon', 'walk_in', 'Walk-in client', 'Walk-in clients'),
  ('salon', 'provider', 'Stylist', 'Stylists'),
  ('salon', 'resource', 'Stylist or room', 'Stylists & rooms'),
  ('salon', 'catalog', 'Service menu', 'Services & products'),
  ('salon', 'item', 'Service or product', 'Services & products'),
  ('salon', 'goods', 'Retail product', 'Retail products'),
  ('salon', 'phrase.stock', 'Product stock', NULL),
  ('salon', 'item_code', 'Service code', 'Service codes'),
  ('salon', 'counter', 'Reception', 'Receptions'),
  ('salon', 'sale', 'Bill', 'Bills'),
  ('salon', 'dues_list', 'Client dues', 'Client dues'),
  ('salon', 'example.item_name', 'Haircut — men', NULL),
  ('salon', 'example.variant', 'Haircut · Senior stylist', NULL),
  ('salon', 'example.shelf', 'Retail shelf by the mirror', NULL),
  ('salon', 'example.consumables', 'hair colour, developer, spa cream', NULL),
  ('salon', 'example.category', 'Hair › Colour › Global colour', NULL),
  ('salon', 'example.units', 'minutes or a sitting', NULL),
  ('salon', 'example.unit_code', 'sitting', NULL),
  ('salon', 'example.offers', '20% off hair spa, a free head massage with a haircut', NULL),
  ('salon', 'example.offer_name', 'Wedding season 15% off', NULL),
  ('salon', 'example.offer_hours', 'Weekday afternoons', NULL),
  ('salon', 'example.loyalty_reason', 'Birthday bonus', NULL),
  ('salon', 'example.customer_book', 'your client book', NULL),
  ('salon', 'example.supplier', 'Sri Venkateshwara Salon Supplies', NULL),
  ('salon', 'example.resource', 'Priya (stylist) or Room 2', NULL),
  ('salon', 'example.promise', 'Pays at Saturday''s appointment', NULL),
  ('salon', 'example.invoice_footer', 'Tell us of any concern within 48 hours.', NULL),
  ('salon', 'example.quotation_terms', 'Bridal package: 50% advance to block the date.', NULL),
  ('salon', 'example.location', 'Indiranagar salon', NULL),
  ('salon', 'example.first_location', 'Main salon', NULL),
  ('salon', 'example.tax_slab', 'Salon services', NULL),
  ('salon', 'example.hsn', '999721', NULL),
  ('salon', 'example.supplies', 'Salon supplies', NULL),
  ('salon', 'example.count', 'Month-end count, retail shelf', NULL),
  ('salon', 'example.kit', 'Bridal kit', NULL),
  ('salon', 'example.checklist_section', 'Stations', NULL),
  ('salon', 'example.checklist_item', 'Tools sterilised', NULL),
  ('salon', 'example.templates', 'hygiene checklist, opening checklist', NULL),
  ('salon', 'example.issue', 'Dryer at station 2 sparking, AC not cooling', NULL),
  ('salon', 'example.project', 'Bridal season set-up, a new branch', NULL),
  ('salon', 'example.quick_access', 'new bill, calendar or clients', NULL),
  ('salon', 'phrase.bill_note', '', NULL),
  ('salon', 'phrase.quotation_hold', 'The date is held once the advance is paid.', NULL),
  -- Clinics & diagnostic labs
  ('healthcare', 'customer', 'Patient', 'Patients'),
  ('healthcare', 'customer_list', 'Billing contact', 'Billing contacts'),
  ('healthcare', 'walk_in', 'Walk-in patient', 'Walk-in patients'),
  ('healthcare', 'provider', 'Doctor', 'Doctors'),
  ('healthcare', 'resource', 'Doctor or room', 'Doctors & rooms'),
  ('healthcare', 'catalog', 'Rate list', 'Services & charges'),
  ('healthcare', 'item', 'Service or charge', 'Services & charges'),
  ('healthcare', 'goods', 'Medicine or consumable', 'Medicines & consumables'),
  ('healthcare', 'item_code', 'Service code', 'Service codes'),
  ('healthcare', 'counter', 'Reception', 'Receptions'),
  ('healthcare', 'sale', 'Bill', 'Bills'),
  ('healthcare', 'dues_list', 'Patient dues', 'Patient dues'),
  ('healthcare', 'example.item_name', 'Consultation — general physician', NULL),
  ('healthcare', 'example.variant', 'Consultation · Follow-up', NULL),
  ('healthcare', 'example.shelf', 'Dispensary cupboard 2', NULL),
  ('healthcare', 'example.consumables', 'gloves, syringes, cotton', NULL),
  ('healthcare', 'example.category', 'Consultations › Specialist › Follow-up', NULL),
  ('healthcare', 'example.units', 'a visit or a test', NULL),
  ('healthcare', 'example.unit_code', 'visit', NULL),
  ('healthcare', 'example.offers', '10% off a full-body check-up, a free follow-up within 7 days', NULL),
  ('healthcare', 'example.offer_name', 'Heart month 10% off ECG', NULL),
  ('healthcare', 'example.offer_hours', 'Early slots', NULL),
  ('healthcare', 'example.loyalty_reason', 'Family health card bonus', NULL),
  ('healthcare', 'example.customer_book', 'your patient register', NULL),
  ('healthcare', 'example.supplier', 'City Surgicals', NULL),
  ('healthcare', 'example.resource', 'Dr. Rao or Room 1', NULL),
  ('healthcare', 'example.promise', 'Insurer settles by month-end', NULL),
  ('healthcare', 'example.invoice_footer', 'One free follow-up within 7 days.', NULL),
  ('healthcare', 'example.quotation_terms', 'Package valid 30 days; reports in 24 hours.', NULL),
  ('healthcare', 'example.location', 'Jayanagar clinic', NULL),
  ('healthcare', 'example.first_location', 'Main clinic', NULL),
  ('healthcare', 'example.tax_slab', 'Exempt healthcare', NULL),
  ('healthcare', 'example.hsn', '999312', NULL),
  ('healthcare', 'example.supplies', 'Clinic supplies', NULL),
  ('healthcare', 'example.count', 'Month-end count, dispensary', NULL),
  ('healthcare', 'example.kit', 'Dressing kit', NULL),
  ('healthcare', 'example.checklist_section', 'OPD', NULL),
  ('healthcare', 'example.checklist_item', 'Autoclave cycle logged', NULL),
  ('healthcare', 'example.templates', 'biomedical waste log, opening checklist', NULL),
  ('healthcare', 'example.issue', 'ECG printer jammed, BP monitor reading high', NULL),
  ('healthcare', 'example.project', 'A health camp, a new consulting room', NULL),
  ('healthcare', 'example.quick_access', 'patients, token queue or bills', NULL),
  ('healthcare', 'phrase.bill_note', '', NULL),
  ('healthcare', 'phrase.quotation_hold', 'The package price holds for 30 days.', NULL),
  -- Gyms, studios & coaching (a gym's words; the other kinds have their own)
  ('memberships', 'customer', 'Member', 'Members'),
  ('memberships', 'customer_list', 'Member contact', 'Member contacts'),
  ('memberships', 'walk_in', 'Walk-in visitor', 'Walk-in visitors'),
  ('memberships', 'provider', 'Trainer', 'Trainers'),
  ('memberships', 'resource', 'Trainer or studio', 'Trainers & studios'),
  ('memberships', 'catalog', 'Plan list', 'Plans & services'),
  ('memberships', 'item', 'Plan or service', 'Plans & services'),
  ('memberships', 'goods', 'Product for sale', 'Products for sale'),
  ('memberships', 'item_code', 'Plan code', 'Plan codes'),
  ('memberships', 'counter', 'Front desk', 'Front desks'),
  ('memberships', 'sale', 'Bill', 'Bills'),
  ('memberships', 'appointment', 'Session', 'Sessions'),
  ('memberships', 'dues_list', 'Member dues', 'Member dues'),
  ('memberships', 'dues', 'Fees', 'Fees'),
  ('memberships', 'collection', 'Fee payment', 'Fee payments'),
  ('memberships', 'example.item_name', 'Monthly membership', NULL),
  ('memberships', 'example.variant', 'Monthly · Couple', NULL),
  ('memberships', 'example.shelf', 'Reception rack', NULL),
  ('memberships', 'example.consumables', 'disinfectant, towels', NULL),
  ('memberships', 'example.category', 'Memberships › Monthly › Couple', NULL),
  ('memberships', 'example.units', 'a month, a session or a 10-class pack', NULL),
  ('memberships', 'example.unit_code', 'session', NULL),
  ('memberships', 'example.offers', '10% off the annual plan, ₹500 off the joining fee', NULL),
  ('memberships', 'example.offer_name', 'New Year 20% off annual plans', NULL),
  ('memberships', 'example.loyalty_reason', 'Referral bonus for bringing a friend', NULL),
  ('memberships', 'example.customer_book', 'your member register', NULL),
  ('memberships', 'example.supplier', 'FitLife Supplements', NULL),
  ('memberships', 'example.resource', 'Coach Arjun or Studio 2', NULL),
  ('memberships', 'example.promise', 'Will pay at the next visit', NULL),
  ('memberships', 'example.invoice_footer', 'Fees are non-refundable; a plan can be frozen once a year.', NULL),
  ('memberships', 'example.quotation_terms', 'Corporate rate valid 30 days; minimum 10 members.', NULL),
  ('memberships', 'example.location', 'Whitefield branch', NULL),
  ('memberships', 'example.first_location', 'Main branch', NULL),
  ('memberships', 'example.tax_slab', 'Gym services', NULL),
  ('memberships', 'example.hsn', '999723', NULL),
  ('memberships', 'example.supplies', 'Gym supplies', NULL),
  ('memberships', 'example.count', 'Month-end count, supplement rack', NULL),
  ('memberships', 'example.kit', 'Starter kit (shaker + towel)', NULL),
  ('memberships', 'example.checklist_section', 'Gym floor', NULL),
  ('memberships', 'example.checklist_item', 'Treadmill belts wiped', NULL),
  ('memberships', 'example.templates', 'equipment check, fire safety round', NULL),
  ('memberships', 'example.issue', 'Treadmill 3 belt slipping, shower 2 no hot water', NULL),
  ('memberships', 'example.project', 'A new branch, a summer fitness challenge', NULL),
  ('memberships', 'example.quick_access', 'check-in, members or renewals', NULL),
  ('memberships', 'phrase.bill_note', '', NULL),
  ('memberships', 'phrase.quotation_hold', 'The plan price holds for 30 days.', NULL),
  -- Laundry & dry cleaning
  ('laundry', 'catalog', 'Price list', 'Services & items'),
  ('laundry', 'item', 'Service or item', 'Services & items'),
  ('laundry', 'sale', 'Bill', 'Bills'),
  ('laundry', 'example.item_name', 'Shirt — wash & iron', NULL),
  ('laundry', 'example.variant', 'Wash & iron · Express', NULL),
  ('laundry', 'example.shelf', 'Rack 3', NULL),
  ('laundry', 'example.consumables', 'detergent, hangers, poly covers', NULL),
  ('laundry', 'example.category', 'Wash & iron › Shirts', NULL),
  ('laundry', 'example.units', 'a piece or a kilo', NULL),
  ('laundry', 'example.unit_code', 'piece', NULL),
  ('laundry', 'example.offers', '20% off dry cleaning on Mondays, a free fold with 10 kg', NULL),
  ('laundry', 'example.offer_name', 'Monsoon 20% off curtains', NULL),
  ('laundry', 'example.offer_hours', 'Weekday mornings', NULL),
  ('laundry', 'example.customer_book', 'your order book', NULL),
  ('laundry', 'example.supplier', 'Sri Sai Detergents', NULL),
  ('laundry', 'example.promise', 'Pays at pick-up', NULL),
  ('laundry', 'example.invoice_footer', 'Please collect within 30 days; check your garments at delivery.', NULL),
  ('laundry', 'example.location', 'BTM Layout store', NULL),
  ('laundry', 'example.tax_slab', 'Laundry services', NULL),
  ('laundry', 'example.hsn', '999712', NULL),
  ('laundry', 'example.supplies', 'Laundry supplies', NULL),
  ('laundry', 'example.checklist_section', 'Wash area', NULL),
  ('laundry', 'example.checklist_item', 'Boiler pressure checked', NULL),
  ('laundry', 'example.templates', 'machine check, opening checklist', NULL),
  ('laundry', 'example.issue', 'Steam press 2 leaking, dryer 1 not heating', NULL),
  ('laundry', 'example.project', 'A new pick-up route, a second store', NULL),
  ('laundry', 'example.quick_access', 'orders, racks or bills', NULL),
  ('laundry', 'phrase.bill_note', 'Please check your garments at delivery.', NULL),
  ('laundry', 'phrase.quotation_hold', 'The rate holds for orders given within 30 days.', NULL),
  -- Rentals & hire
  ('rentals', 'customer', 'Hirer', 'Hirers'),
  ('rentals', 'customer_list', 'Hirer', 'Hirers'),
  ('rentals', 'walk_in', 'Walk-in hirer', 'Walk-in hirers'),
  ('rentals', 'catalog', 'Rate list', 'Rental items & services'),
  ('rentals', 'item', 'Rental item', 'Rental items'),
  ('rentals', 'sale', 'Bill', 'Bills'),
  ('rentals', 'appointment', 'Booking', 'Bookings'),
  ('rentals', 'dues_list', 'Hirer dues', 'Hirer dues'),
  ('rentals', 'example.item_name', 'Honda Activa — per day', NULL),
  ('rentals', 'example.variant', 'Per day · With helmet', NULL),
  ('rentals', 'example.shelf', 'Bay 3', NULL),
  ('rentals', 'example.category', 'Two-wheelers › Scooters', NULL),
  ('rentals', 'example.units', 'an hour, a day or a week', NULL),
  ('rentals', 'example.unit_code', 'day', NULL),
  ('rentals', 'example.offers', '₹200 off a weekly hire, a free helmet with every scooter', NULL),
  ('rentals', 'example.offer_name', 'Weekend special ₹200 off', NULL),
  ('rentals', 'example.customer_book', 'your hire register', NULL),
  ('rentals', 'example.supplier', 'Sri Lakshmi Motors', NULL),
  ('rentals', 'example.promise', 'Pays when the item is returned', NULL),
  ('rentals', 'example.invoice_footer', 'The deposit is refunded on return after inspection; fuel and tolls are the hirer''s.', NULL),
  ('rentals', 'example.quotation_terms', 'Rates hold 7 days; the deposit is due at pick-up.', NULL),
  ('rentals', 'example.location', 'Majestic yard', NULL),
  ('rentals', 'example.first_location', 'Main yard', NULL),
  ('rentals', 'example.tax_slab', 'Rental services', NULL),
  ('rentals', 'example.hsn', '997311', NULL),
  ('rentals', 'example.checklist_section', 'Yard', NULL),
  ('rentals', 'example.checklist_item', 'Returned items inspected', NULL),
  ('rentals', 'example.issue', 'Scooter 12 brake loose, generator 2 not starting', NULL),
  ('rentals', 'example.project', 'A new yard, the wedding season fleet', NULL),
  ('rentals', 'example.quick_access', 'bookings, availability or deposits', NULL),
  ('rentals', 'phrase.bill_note', '', NULL),
  ('rentals', 'phrase.quotation_hold', 'Items are held only once the booking is paid.', NULL),
  -- Hotels, lodges & guest houses
  ('lodging', 'customer', 'Guest', 'Guests'),
  ('lodging', 'customer_list', 'Guest or company', 'Guests & companies'),
  ('lodging', 'walk_in', 'Walk-in guest', 'Walk-in guests'),
  ('lodging', 'catalog', 'Tariff', 'Rooms, services & extras'),
  ('lodging', 'item', 'Room or service', 'Rooms & services'),
  ('lodging', 'location', 'Property', 'Properties'),
  ('lodging', 'counter', 'Front desk', 'Front desks'),
  ('lodging', 'sale', 'Bill', 'Bills'),
  ('lodging', 'appointment', 'Reservation', 'Reservations'),
  ('lodging', 'dues_list', 'Guest dues', 'Guest dues'),
  ('lodging', 'example.item_name', 'Deluxe room — per night', NULL),
  ('lodging', 'example.variant', 'Deluxe · With breakfast', NULL),
  ('lodging', 'example.shelf', 'Store room 1', NULL),
  ('lodging', 'example.consumables', 'toiletries, linen, tea kits', NULL),
  ('lodging', 'example.category', 'Rooms › Deluxe', NULL),
  ('lodging', 'example.units', 'a night or a person', NULL),
  ('lodging', 'example.unit_code', 'night', NULL),
  ('lodging', 'example.offers', '10% off stays of 3 nights or more, free breakfast on weekdays', NULL),
  ('lodging', 'example.offer_name', 'Monsoon 15% off weekday stays', NULL),
  ('lodging', 'example.offer_hours', 'Weekday nights', NULL),
  ('lodging', 'example.customer_book', 'your guest register', NULL),
  ('lodging', 'example.supplier', 'Sri Sai Linen Suppliers', NULL),
  ('lodging', 'example.promise', 'The company settles at month-end', NULL),
  ('lodging', 'example.invoice_footer', 'Check-out at 12 noon; late check-out on request.', NULL),
  ('lodging', 'example.quotation_terms', 'Group rate valid 15 days; 30% advance to block the rooms.', NULL),
  ('lodging', 'example.location', 'Ooty property', NULL),
  ('lodging', 'example.first_location', 'Main property', NULL),
  ('lodging', 'example.tax_slab', 'Rooms up to ₹7,500 a night', NULL),
  ('lodging', 'example.hsn', '996311', NULL),
  ('lodging', 'example.supplies', 'Housekeeping supplies', NULL),
  ('lodging', 'example.count', 'Month-end count, linen store', NULL),
  ('lodging', 'example.checklist_section', 'Housekeeping', NULL),
  ('lodging', 'example.checklist_item', 'Room 104 linen changed', NULL),
  ('lodging', 'example.templates', 'room check, fire safety round', NULL),
  ('lodging', 'example.issue', 'Room 204 AC leaking, lift stuck on floor 2', NULL),
  ('lodging', 'example.project', 'A new wing, the wedding season', NULL),
  ('lodging', 'example.quick_access', 'front desk, rooms or reservations', NULL),
  ('lodging', 'phrase.bill_note', '', NULL),
  ('lodging', 'phrase.quotation_hold', 'Rooms are held only once the advance is paid.', NULL);

-- --- Each kind's words ------------------------------------------------------------
INSERT INTO business_kind_terms (business_type, kind, key, one, many) VALUES
  -- Yoga studio
  ('memberships', 'yoga_studio', 'provider', 'Teacher', 'Teachers'),
  ('memberships', 'yoga_studio', 'resource', 'Teacher or studio', 'Teachers & studios'),
  ('memberships', 'yoga_studio', 'appointment', 'Class', 'Classes'),
  ('memberships', 'yoga_studio', 'example.item_name', 'Monthly yoga — 12 classes', NULL),
  ('memberships', 'yoga_studio', 'example.variant', 'Monthly · Morning batch', NULL),
  ('memberships', 'yoga_studio', 'example.category', 'Yoga › Hatha › Morning batch', NULL),
  ('memberships', 'yoga_studio', 'example.resource', 'Meera (teacher) or Studio 1', NULL),
  ('memberships', 'yoga_studio', 'example.offers', '10% off the quarterly plan, a free trial class', NULL),
  ('memberships', 'yoga_studio', 'example.tax_slab', 'Yoga classes', NULL),
  ('memberships', 'yoga_studio', 'example.invoice_footer', 'Fees are non-refundable; missed classes can be made up within the month.', NULL),
  ('memberships', 'yoga_studio', 'example.location', 'Jayanagar studio', NULL),
  ('memberships', 'yoga_studio', 'example.first_location', 'Main studio', NULL),
  ('memberships', 'yoga_studio', 'example.checklist_section', 'Studio', NULL),
  ('memberships', 'yoga_studio', 'example.checklist_item', 'Mats cleaned', NULL),
  ('memberships', 'yoga_studio', 'example.issue', 'Studio AC not cooling, speaker crackling', NULL),
  ('memberships', 'yoga_studio', 'example.project', 'A new batch, a weekend workshop', NULL),
  ('memberships', 'yoga_studio', 'example.quick_access', 'check-in, classes or renewals', NULL),
  -- Dance studio
  ('memberships', 'dance_studio', 'customer', 'Student', 'Students'),
  ('memberships', 'dance_studio', 'customer_list', 'Student contact', 'Student contacts'),
  ('memberships', 'dance_studio', 'provider', 'Teacher', 'Teachers'),
  ('memberships', 'dance_studio', 'resource', 'Teacher or studio', 'Teachers & studios'),
  ('memberships', 'dance_studio', 'catalog', 'Course list', 'Courses & plans'),
  ('memberships', 'dance_studio', 'item', 'Course or plan', 'Courses & plans'),
  ('memberships', 'dance_studio', 'appointment', 'Class', 'Classes'),
  ('memberships', 'dance_studio', 'dues_list', 'Student dues', 'Student dues'),
  ('memberships', 'dance_studio', 'example.item_name', 'Bharatanatyam — monthly', NULL),
  ('memberships', 'dance_studio', 'example.variant', 'Monthly · Beginners', NULL),
  ('memberships', 'dance_studio', 'example.category', 'Classical › Bharatanatyam › Beginners', NULL),
  ('memberships', 'dance_studio', 'example.resource', 'Kavya (teacher) or Studio A', NULL),
  ('memberships', 'dance_studio', 'example.customer_book', 'your student register', NULL),
  ('memberships', 'dance_studio', 'example.promise', 'Will pay at the next class', NULL),
  ('memberships', 'dance_studio', 'example.location', 'Malleswaram studio', NULL),
  ('memberships', 'dance_studio', 'example.first_location', 'Main studio', NULL),
  ('memberships', 'dance_studio', 'example.checklist_section', 'Studio', NULL),
  ('memberships', 'dance_studio', 'example.checklist_item', 'Floor mopped', NULL),
  ('memberships', 'dance_studio', 'example.project', 'The annual recital, a summer camp', NULL),
  ('memberships', 'dance_studio', 'example.quick_access', 'check-in, students or renewals', NULL),
  -- Coaching & tuition centre
  ('memberships', 'coaching', 'customer', 'Student', 'Students'),
  ('memberships', 'coaching', 'customer_list', 'Student contact', 'Student contacts'),
  ('memberships', 'coaching', 'walk_in', 'Walk-in enquiry', 'Walk-in enquiries'),
  ('memberships', 'coaching', 'provider', 'Faculty member', 'Faculty'),
  ('memberships', 'coaching', 'resource', 'Teacher or classroom', 'Teachers & classrooms'),
  ('memberships', 'coaching', 'catalog', 'Course list', 'Courses & fees'),
  ('memberships', 'coaching', 'item', 'Course', 'Courses'),
  ('memberships', 'coaching', 'item_code', 'Course code', 'Course codes'),
  ('memberships', 'coaching', 'counter', 'Front office', 'Front offices'),
  ('memberships', 'coaching', 'appointment', 'Class', 'Classes'),
  ('memberships', 'coaching', 'dues_list', 'Fees due', 'Fees due'),
  ('memberships', 'coaching', 'example.item_name', 'JEE Main — 1 year', NULL),
  ('memberships', 'coaching', 'example.variant', '1 year · Weekend batch', NULL),
  ('memberships', 'coaching', 'example.category', 'Engineering › JEE › 1 year', NULL),
  ('memberships', 'coaching', 'example.units', 'a month, a term or a course', NULL),
  ('memberships', 'coaching', 'example.unit_code', 'term', NULL),
  ('memberships', 'coaching', 'example.offers', '10% sibling discount, ₹2,000 off on full payment', NULL),
  ('memberships', 'coaching', 'example.offer_name', 'Early-bird ₹2,000 off', NULL),
  ('memberships', 'coaching', 'example.offer_hours', 'Weekday batches', NULL),
  ('memberships', 'coaching', 'example.loyalty_reason', 'Referral bonus for a friend who joins', NULL),
  ('memberships', 'coaching', 'example.customer_book', 'your student register', NULL),
  ('memberships', 'coaching', 'example.supplier', 'Sri Saraswathi Book House', NULL),
  ('memberships', 'coaching', 'example.resource', 'Mr. Iyer or Room 3', NULL),
  ('memberships', 'coaching', 'example.promise', 'The parent pays at the PTM', NULL),
  ('memberships', 'coaching', 'example.invoice_footer', 'Fees once paid are not refundable after the first class.', NULL),
  ('memberships', 'coaching', 'example.quotation_terms', 'The batch fee holds until the batch starts; instalments with post-dated cheques.', NULL),
  ('memberships', 'coaching', 'example.location', 'Ameerpet centre', NULL),
  ('memberships', 'coaching', 'example.first_location', 'Main centre', NULL),
  ('memberships', 'coaching', 'example.tax_slab', 'Coaching services', NULL),
  ('memberships', 'coaching', 'example.hsn', '999293', NULL),
  ('memberships', 'coaching', 'example.supplies', 'Classroom supplies', NULL),
  ('memberships', 'coaching', 'example.kit', 'Study material set', NULL),
  ('memberships', 'coaching', 'example.checklist_section', 'Classrooms', NULL),
  ('memberships', 'coaching', 'example.checklist_item', 'Projector checked', NULL),
  ('memberships', 'coaching', 'example.templates', 'classroom check, attendance follow-up', NULL),
  ('memberships', 'coaching', 'example.issue', 'Projector in Room 2 not working, AC in Room 4 noisy', NULL),
  ('memberships', 'coaching', 'example.project', 'A new batch, the scholarship test', NULL),
  ('memberships', 'coaching', 'example.quick_access', 'check-in, students or fees', NULL),
  ('memberships', 'coaching', 'phrase.quotation_hold', 'The batch fee holds until the batch starts.', NULL),
  -- Sports & martial arts academy
  ('memberships', 'sports_academy', 'customer', 'Student', 'Students'),
  ('memberships', 'sports_academy', 'customer_list', 'Student contact', 'Student contacts'),
  ('memberships', 'sports_academy', 'provider', 'Coach', 'Coaches'),
  ('memberships', 'sports_academy', 'resource', 'Coach or court', 'Coaches & courts'),
  ('memberships', 'sports_academy', 'dues_list', 'Student dues', 'Student dues'),
  ('memberships', 'sports_academy', 'example.item_name', 'Badminton coaching — monthly', NULL),
  ('memberships', 'sports_academy', 'example.variant', 'Monthly · Evening batch', NULL),
  ('memberships', 'sports_academy', 'example.category', 'Badminton › Beginners › Evening batch', NULL),
  ('memberships', 'sports_academy', 'example.resource', 'Coach Arun or Court 2', NULL),
  ('memberships', 'sports_academy', 'example.customer_book', 'your student register', NULL),
  ('memberships', 'sports_academy', 'example.location', 'HSR Layout academy', NULL),
  ('memberships', 'sports_academy', 'example.first_location', 'Main academy', NULL),
  ('memberships', 'sports_academy', 'example.checklist_section', 'Courts', NULL),
  ('memberships', 'sports_academy', 'example.checklist_item', 'Nets checked', NULL),
  ('memberships', 'sports_academy', 'example.project', 'A summer camp, the annual tournament', NULL),
  ('memberships', 'sports_academy', 'example.quick_access', 'check-in, students or renewals', NULL),
  -- Dental clinic
  ('healthcare', 'dental', 'provider', 'Dentist', 'Dentists'),
  ('healthcare', 'dental', 'resource', 'Dentist or chair', 'Dentists & chairs'),
  ('healthcare', 'dental', 'example.item_name', 'Root canal — molar', NULL),
  ('healthcare', 'dental', 'example.variant', 'Root canal · Molar', NULL),
  ('healthcare', 'dental', 'example.category', 'Treatments › Root canal › Molar', NULL),
  ('healthcare', 'dental', 'example.resource', 'Dr. Shah or Chair 2', NULL),
  ('healthcare', 'dental', 'example.consumables', 'gloves, impression material, cotton rolls', NULL),
  ('healthcare', 'dental', 'example.offers', 'free check-up with cleaning, 10% off braces', NULL),
  ('healthcare', 'dental', 'example.offer_name', 'Smile month 10% off cleaning', NULL),
  ('healthcare', 'dental', 'example.location', 'Banashankari dental clinic', NULL),
  -- Physiotherapy centre
  ('healthcare', 'physiotherapy', 'provider', 'Physiotherapist', 'Physiotherapists'),
  ('healthcare', 'physiotherapy', 'resource', 'Therapist or bed', 'Therapists & beds'),
  ('healthcare', 'physiotherapy', 'appointment', 'Session', 'Sessions'),
  ('healthcare', 'physiotherapy', 'example.item_name', 'Physiotherapy session — 45 min', NULL),
  ('healthcare', 'physiotherapy', 'example.variant', 'Session · Home visit', NULL),
  ('healthcare', 'physiotherapy', 'example.category', 'Sessions › Knee rehab', NULL),
  ('healthcare', 'physiotherapy', 'example.resource', 'Dr. Nair or Bed 3', NULL),
  ('healthcare', 'physiotherapy', 'example.units', 'a session or a pack of 10', NULL),
  ('healthcare', 'physiotherapy', 'example.unit_code', 'session', NULL),
  -- Diagnostic centre
  ('healthcare', 'diagnostic', 'provider', 'Technician', 'Technicians'),
  ('healthcare', 'diagnostic', 'resource', 'Technician or room', 'Technicians & rooms'),
  ('healthcare', 'diagnostic', 'catalog', 'Test list', 'Tests & packages'),
  ('healthcare', 'diagnostic', 'item', 'Test or package', 'Tests & packages'),
  ('healthcare', 'diagnostic', 'appointment', 'Test booking', 'Test bookings'),
  ('healthcare', 'diagnostic', 'example.item_name', 'Complete blood count (CBC)', NULL),
  ('healthcare', 'diagnostic', 'example.variant', 'CBC · Home collection', NULL),
  ('healthcare', 'diagnostic', 'example.category', 'Haematology › CBC', NULL),
  ('healthcare', 'diagnostic', 'example.units', 'a test or a package', NULL),
  ('healthcare', 'diagnostic', 'example.unit_code', 'test', NULL),
  ('healthcare', 'diagnostic', 'example.resource', 'Sunil (technician) or Collection room', NULL),
  ('healthcare', 'diagnostic', 'example.invoice_footer', 'Reports are ready within 24 hours.', NULL),
  ('healthcare', 'diagnostic', 'example.location', 'Rajajinagar centre', NULL),
  ('healthcare', 'diagnostic', 'example.first_location', 'Main centre', NULL),
  ('healthcare', 'diagnostic', 'example.quick_access', 'lab orders, samples or bills', NULL),
  -- Barber shop
  ('salon', 'barber', 'customer', 'Customer', 'Customers'),
  ('salon', 'barber', 'customer_list', 'Customer', 'Customers'),
  ('salon', 'barber', 'walk_in', 'Walk-in customer', 'Walk-in customers'),
  ('salon', 'barber', 'provider', 'Barber', 'Barbers'),
  ('salon', 'barber', 'resource', 'Barber or chair', 'Barbers & chairs'),
  ('salon', 'barber', 'counter', 'Counter', 'Counters'),
  ('salon', 'barber', 'dues_list', 'Customer dues', 'Customer dues'),
  ('salon', 'barber', 'example.item_name', 'Haircut & shave', NULL),
  ('salon', 'barber', 'example.resource', 'Salim or Chair 2', NULL),
  ('salon', 'barber', 'example.location', 'Gandhi Nagar shop', NULL),
  ('salon', 'barber', 'example.first_location', 'Main shop', NULL),
  ('salon', 'barber', 'example.quick_access', 'new bill, calendar or customers', NULL),
  -- Beauty parlour
  ('salon', 'beauty_parlour', 'provider', 'Beautician', 'Beauticians'),
  ('salon', 'beauty_parlour', 'resource', 'Beautician or room', 'Beauticians & rooms'),
  ('salon', 'beauty_parlour', 'example.item_name', 'Threading — eyebrows', NULL),
  ('salon', 'beauty_parlour', 'example.category', 'Skin › Facials › Gold facial', NULL),
  ('salon', 'beauty_parlour', 'example.resource', 'Lakshmi (beautician) or Room 1', NULL),
  ('salon', 'beauty_parlour', 'example.location', 'Vijayanagar parlour', NULL),
  ('salon', 'beauty_parlour', 'example.first_location', 'Main parlour', NULL),
  -- Spa
  ('salon', 'spa', 'customer', 'Guest', 'Guests'),
  ('salon', 'spa', 'customer_list', 'Guest', 'Guests'),
  ('salon', 'spa', 'walk_in', 'Walk-in guest', 'Walk-in guests'),
  ('salon', 'spa', 'provider', 'Therapist', 'Therapists'),
  ('salon', 'spa', 'resource', 'Therapist or room', 'Therapists & rooms'),
  ('salon', 'spa', 'dues_list', 'Guest dues', 'Guest dues'),
  ('salon', 'spa', 'example.item_name', 'Swedish massage — 60 min', NULL),
  ('salon', 'spa', 'example.variant', 'Swedish massage · 90 min', NULL),
  ('salon', 'spa', 'example.category', 'Massages › Swedish', NULL),
  ('salon', 'spa', 'example.resource', 'Anita (therapist) or Room 3', NULL),
  ('salon', 'spa', 'example.location', 'Whitefield spa', NULL),
  ('salon', 'spa', 'example.first_location', 'Main spa', NULL),
  ('salon', 'spa', 'example.quick_access', 'new bill, calendar or guests', NULL),
  -- Hotel, lodge, guest house, homestay: the type's words fit; their own first place
  ('lodging', 'hotel', 'example.first_location', 'Main hotel', NULL),
  ('lodging', 'lodge', 'example.first_location', 'Main lodge', NULL),
  ('lodging', 'guest_house', 'example.first_location', 'Main guest house', NULL),
  ('lodging', 'homestay', 'example.first_location', 'Main homestay', NULL),
  -- Dry cleaner and ironing
  ('laundry', 'dry_cleaner', 'example.item_name', 'Saree — dry clean', NULL),
  ('laundry', 'dry_cleaner', 'example.category', 'Dry clean › Sarees › Silk', NULL),
  ('laundry', 'ironing', 'example.item_name', 'Shirt — ironing', NULL),
  ('laundry', 'ironing', 'example.category', 'Ironing › Shirts', NULL),
  ('laundry', 'ironing', 'example.units', 'a piece or a bundle', NULL),
  -- Equipment hire and event rentals
  ('rentals', 'equipment', 'example.item_name', 'Concrete mixer — per day', NULL),
  ('rentals', 'equipment', 'example.category', 'Construction › Mixers', NULL),
  ('rentals', 'equipment', 'example.issue', 'Mixer 2 engine not starting, scaffolding clamp missing', NULL),
  ('rentals', 'events', 'example.item_name', 'Shamiana 20 × 40 — per day', NULL),
  ('rentals', 'events', 'example.category', 'Tents › Shamianas', NULL),
  ('rentals', 'events', 'example.issue', 'Generator 2 not starting, three chairs broken', NULL),
  ('rentals', 'events', 'example.project', 'The wedding season, a new godown', NULL);

-- Down Migration
DROP FUNCTION business_word(BIGINT, TEXT, BOOLEAN);
DROP FUNCTION business_words(BIGINT);
DROP TABLE business_terms;
DROP TABLE business_kind_terms;
DROP TABLE business_type_terms;
DROP FUNCTION business_term_fits();
DROP TRIGGER businesses_kind_fits ON businesses;
DROP FUNCTION businesses_kind_fits();
ALTER TABLE businesses DROP CONSTRAINT businesses_kind_fkey;
ALTER TABLE businesses DROP COLUMN kind;
DROP TABLE business_type_kinds;
ALTER TABLE business_types DROP COLUMN sort_order, DROP COLUMN default_item_kind, DROP COLUMN accent, DROP COLUMN icon;
DROP TABLE term_keys;
