-- Up Migration
-- More words a business's screens say in its own way (term_keys, migration
-- 1791990000000):
--   booked_service        what a booking is for (a gym's session or class, a
--                         clinic's consultation or test), apart from the item
--                         kind "Service"
--   example.asset         the equipment an issue names (a gym's treadmill)
--   example.offer_amount  an amount off each item (a gym's joining fee)
--   phrase.labels         the label sheet (a garage's part labels)
--   phrase.sell_plan      selling a plan at a gym, studio or coaching centre
--                         (a coaching centre enrols a student)
-- and a quotation's hold line that no longer repeats a validity: the
-- quotation prints its own "The prices hold until …".

INSERT INTO term_keys (key, area, label, hint, one, many, owner_may_rename, sort_order) VALUES
  ('booked_service', 'work', 'What a booking is for', 'The service a booking or a class is for.', 'Service', 'Services', FALSE, 325),
  ('example.asset', 'examples', 'Equipment that can break', 'Issues: what broke.', 'Freezer 2, weighing scale, delivery van', NULL, FALSE, 795),
  ('example.offer_amount', 'examples', 'An amount off each item', 'Offers: a set amount off each item.', '₹5 off each soap', NULL, FALSE, 605),
  ('phrase.labels', 'examples', 'The label sheet', 'Its tab and title.', 'Barcode labels', NULL, FALSE, 960),
  ('phrase.sell_plan', 'examples', 'Selling a plan', 'The button that sells a membership, a course or a pack.', 'Sell a membership', NULL, FALSE, 970);

INSERT INTO business_type_terms (business_type, key, one, many) VALUES
  ('memberships', 'booked_service', 'Session or class', 'Sessions & classes'),
  ('healthcare', 'booked_service', 'Consultation or test', 'Consultations & tests'),
  ('optical', 'booked_service', 'Test or service', 'Tests & services'),
  ('electronics', 'booked_service', 'Repair or service', 'Repairs & services'),
  ('memberships', 'example.asset', 'Treadmill 3, steam room', NULL),
  ('salon', 'example.asset', 'Dryer 2, spa bed 1', NULL),
  ('healthcare', 'example.asset', 'ECG machine, autoclave', NULL),
  ('garage', 'example.asset', 'Hoist 2, wheel aligner', NULL),
  ('lodging', 'example.asset', 'Lift 1, room 204 AC', NULL),
  ('laundry', 'example.asset', 'Washer 2, steam press', NULL),
  ('rentals', 'example.asset', 'Scooter 12, generator 2', NULL),
  ('fuel_station', 'example.asset', 'Dispensing unit 3, density meter', NULL),
  ('pharmacy', 'example.asset', 'Medicine fridge, billing printer', NULL),
  ('optical', 'example.asset', 'Lensmeter, edging machine', NULL),
  ('jewellery', 'example.asset', 'Weighing scale, safe', NULL),
  ('restaurant', 'example.asset', 'Walk-in freezer, scale 2, van KA-01-AB-1234', NULL),
  ('memberships', 'example.offer_amount', '₹500 off the joining fee', NULL),
  ('salon', 'example.offer_amount', '₹100 off a haircut', NULL),
  ('healthcare', 'example.offer_amount', '₹100 off a consultation', NULL),
  ('garage', 'example.offer_amount', '₹200 off a general service', NULL),
  ('fashion', 'example.offer_amount', '₹100 off each kurta', NULL),
  ('electronics', 'example.offer_amount', '₹200 off each phone cover', NULL),
  ('hardware', 'example.offer_amount', '₹20 off each bag of cement', NULL),
  ('agri_inputs', 'example.offer_amount', '₹50 off each bag of DAP', NULL),
  ('books', 'example.offer_amount', '₹10 off each notebook', NULL),
  ('pharmacy', 'example.offer_amount', '₹20 off each bottle of syrup', NULL),
  ('optical', 'example.offer_amount', '₹200 off each frame', NULL),
  ('jewellery', 'example.offer_amount', '₹500 off the making charge', NULL),
  ('laundry', 'example.offer_amount', '₹10 off each shirt', NULL),
  ('rentals', 'example.offer_amount', '₹100 off each day', NULL),
  ('lodging', 'example.offer_amount', '₹500 off each night', NULL),
  ('garage', 'phrase.labels', 'Part labels', NULL);

INSERT INTO business_kind_terms (business_type, kind, key, one, many) VALUES
  ('memberships', 'yoga_studio', 'booked_service', 'Class', 'Classes'),
  ('memberships', 'dance_studio', 'booked_service', 'Class', 'Classes'),
  ('memberships', 'coaching', 'booked_service', 'Class', 'Classes'),
  ('healthcare', 'diagnostic', 'booked_service', 'Test', 'Tests'),
  ('healthcare', 'physiotherapy', 'booked_service', 'Session', 'Sessions'),
  ('memberships', 'yoga_studio', 'example.asset', 'Studio speaker, AC', NULL),
  ('memberships', 'dance_studio', 'example.asset', 'Studio mirror, speaker', NULL),
  ('memberships', 'coaching', 'example.asset', 'Projector, classroom AC', NULL),
  ('memberships', 'sports_academy', 'example.asset', 'Bowling machine, court lights', NULL),
  ('healthcare', 'dental', 'example.asset', 'Dental chair 2, autoclave', NULL),
  ('healthcare', 'physiotherapy', 'example.asset', 'Ultrasound machine, traction bed', NULL),
  ('healthcare', 'diagnostic', 'example.asset', 'Analyser, centrifuge', NULL),
  ('memberships', 'coaching', 'example.offer_amount', '₹2,000 off the course fee', NULL),
  ('memberships', 'coaching', 'phrase.sell_plan', 'Enrol a student', NULL),
  ('memberships', 'dance_studio', 'phrase.sell_plan', 'Enrol a student', NULL),
  ('memberships', 'sports_academy', 'phrase.sell_plan', 'Enrol a student', NULL);

UPDATE business_type_terms t SET one = v.one, updated_at = now()
FROM (VALUES
  ('memberships', 'A place is held only once the fee is paid.'),
  ('healthcare', 'Treatment is booked once you approve the estimate.'),
  ('laundry', 'Pick-ups start once you approve the quotation.')
) AS v(business_type, one)
WHERE t.business_type = v.business_type AND t.key = 'phrase.quotation_hold';
UPDATE business_kind_terms SET one = 'A seat is held only once the fee is paid.', updated_at = now()
WHERE business_type = 'memberships' AND kind = 'coaching' AND key = 'phrase.quotation_hold';

-- Down Migration
UPDATE business_kind_terms SET one = 'The batch fee holds until the batch starts.'
WHERE business_type = 'memberships' AND kind = 'coaching' AND key = 'phrase.quotation_hold';
UPDATE business_type_terms t SET one = v.one
FROM (VALUES
  ('memberships', 'The plan price holds for 30 days.'),
  ('healthcare', 'The package price holds for 30 days.'),
  ('laundry', 'The rate holds for orders given within 30 days.')
) AS v(business_type, one)
WHERE t.business_type = v.business_type AND t.key = 'phrase.quotation_hold';
DELETE FROM term_keys WHERE key IN ('booked_service', 'example.asset', 'example.offer_amount', 'phrase.labels', 'phrase.sell_plan');
