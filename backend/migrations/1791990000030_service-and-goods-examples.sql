-- Up Migration
-- What the item form shows under each kind, so the choice between a service
-- and goods kept in stock is plain (term_keys, migration 1791990000000):
--   example.service_item  services the business charges for (a gym's joining
--                         fee, personal training, locker rent)
--   example.goods_item    goods it sells off the shelf (a gym's protein powder)

INSERT INTO term_keys (key, area, label, hint, one, many, owner_may_rename, sort_order) VALUES
  ('example.service_item', 'examples', 'Services you charge for', 'The item form: what a service is.', 'Home delivery, gift wrapping', NULL, FALSE, 512),
  ('example.goods_item', 'examples', 'Goods you sell from stock', 'The item form: what goods kept in stock are.', 'Toor dal 1 kg, bath soap', NULL, FALSE, 514);

INSERT INTO business_type_terms (business_type, key, one, many) VALUES
  ('general_retail', 'example.service_item', 'Gift wrapping, home delivery', NULL),
  ('general_retail', 'example.goods_item', 'Steel water bottle, lunch box', NULL),
  ('meat', 'example.service_item', 'Cleaning & cutting, home delivery', NULL),
  ('meat', 'example.goods_item', 'Chicken curry cut, mutton keema', NULL),
  ('weight_retail', 'example.service_item', 'Gift packing, home delivery', NULL),
  ('weight_retail', 'example.goods_item', 'Almonds loose, dry-fruit box', NULL),
  ('fashion', 'example.service_item', 'Alteration, fall & pico', NULL),
  ('fashion', 'example.goods_item', 'Cotton kurta, silk saree', NULL),
  ('electronics', 'example.service_item', 'Phone repair, screen-guard fitting', NULL),
  ('electronics', 'example.goods_item', 'Phone cover, charger', NULL),
  ('books', 'example.service_item', 'Book binding, lamination', NULL),
  ('books', 'example.goods_item', 'Notebook, NCERT textbook', NULL),
  ('pharmacy', 'example.service_item', 'BP check, home delivery', NULL),
  ('pharmacy', 'example.goods_item', 'Paracetamol tablets, cough syrup', NULL),
  ('optical', 'example.service_item', 'Eye test, frame fitting', NULL),
  ('optical', 'example.goods_item', 'Titanium frame, lens cleaner', NULL),
  ('jewellery', 'example.service_item', 'Polishing, ring resizing', NULL),
  ('jewellery', 'example.goods_item', 'Gold chain, silver anklet', NULL),
  ('hardware', 'example.service_item', 'Pipe cutting, paint tinting', NULL),
  ('hardware', 'example.goods_item', 'PVC pipe, cement bag', NULL),
  ('agri_inputs', 'example.service_item', 'Soil testing, spraying', NULL),
  ('agri_inputs', 'example.goods_item', 'DAP bag, seed packet', NULL),
  ('garage', 'example.service_item', 'General service, wheel alignment', NULL),
  ('garage', 'example.goods_item', 'Oil filter, brake pads', NULL),
  ('fuel_station', 'example.service_item', 'Car wash, nitrogen filling', NULL),
  ('fuel_station', 'example.goods_item', 'Engine oil, coolant', NULL),
  ('salon', 'example.service_item', 'Haircut, facial', NULL),
  ('salon', 'example.goods_item', 'Shampoo, hair serum', NULL),
  ('healthcare', 'example.service_item', 'Consultation, dressing', NULL),
  ('healthcare', 'example.goods_item', 'Crepe bandage, glucose strips', NULL),
  ('memberships', 'example.service_item', 'Joining fee, personal training, locker rent', NULL),
  ('memberships', 'example.goods_item', 'Protein powder, water bottle, gym gloves', NULL),
  ('laundry', 'example.service_item', 'Wash & iron, dry cleaning', NULL),
  ('laundry', 'example.goods_item', 'Laundry bag, fabric softener', NULL),
  ('rentals', 'example.service_item', 'Delivery & pick-up, cleaning charge', NULL),
  ('rentals', 'example.goods_item', 'Helmet, rain cover', NULL),
  ('lodging', 'example.service_item', 'Room service, airport pick-up', NULL),
  ('lodging', 'example.goods_item', 'Water bottle, toiletry kit', NULL),
  ('restaurant', 'example.service_item', 'Packing charge, home delivery', NULL),
  ('restaurant', 'example.goods_item', 'Water bottle, soft drink can', NULL);

INSERT INTO business_kind_terms (business_type, kind, key, one, many) VALUES
  ('memberships', 'yoga_studio', 'example.service_item', 'Joining fee, private session', NULL),
  ('memberships', 'yoga_studio', 'example.goods_item', 'Yoga mat, yoga block', NULL),
  ('memberships', 'dance_studio', 'example.service_item', 'Admission fee, costume rent', NULL),
  ('memberships', 'dance_studio', 'example.goods_item', 'Ghungroo, practice saree', NULL),
  ('memberships', 'coaching', 'example.service_item', 'Admission fee, test series', NULL),
  ('memberships', 'coaching', 'example.goods_item', 'Study material, notebook', NULL),
  ('memberships', 'sports_academy', 'example.service_item', 'Admission fee, court booking', NULL),
  ('memberships', 'sports_academy', 'example.goods_item', 'Shuttlecock tube, racket grip', NULL),
  ('healthcare', 'dental', 'example.service_item', 'Scaling, X-ray', NULL),
  ('healthcare', 'dental', 'example.goods_item', 'Toothbrush, mouthwash', NULL),
  ('healthcare', 'diagnostic', 'example.service_item', 'Home sample collection, report courier', NULL),
  ('salon', 'spa', 'example.service_item', 'Massage, steam bath', NULL),
  ('salon', 'spa', 'example.goods_item', 'Massage oil, bath salt', NULL);

-- Down Migration
DELETE FROM term_keys WHERE key IN ('example.service_item', 'example.goods_item');
