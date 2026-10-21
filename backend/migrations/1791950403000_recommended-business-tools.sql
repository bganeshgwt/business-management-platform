-- Up Migration
-- New businesses start lean (1791950400000): specialist tools are off until an
-- owner switches them on. A tool that most businesses of a trade use is marked
-- recommended for that trade, with the reason, so Settings › Business tools
-- can point the owner to it. Nothing is switched on by this.
ALTER TABLE platform_module_business_types
  ADD COLUMN recommended BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN recommended_note VARCHAR(200),
  ADD CONSTRAINT platform_module_business_types_recommended_note
    CHECK (recommended OR recommended_note IS NULL);

UPDATE platform_module_business_types t SET recommended = TRUE, recommended_note = r.note
FROM (VALUES
  ('supermarket', 'offers', 'Weekly offers, buy-one-get-one and combo prices at the counter.'),
  ('supermarket', 'loyalty', 'Points that bring regular families back.'),
  ('supermarket', 'stock_transfers', 'Move stock between branches and the godown.'),
  ('supermarket', 'wastage', 'Record spoiled fruit, vegetables and dairy.'),
  ('supermarket', 'tasks', 'Opening, shelf refilling, expiry walks and cold-room checks for a large team.'),
  ('supermarket', 'issues', 'Broken fridges, leaks and customer complaints, followed to the end.'),
  ('wholesale', 'stock_transfers', 'Move stock between godowns and depots.'),
  ('fashion', 'offers', 'Season sales and end-of-season markdowns.'),
  ('fashion', 'loyalty', 'Points for regular customers.'),
  ('fashion', 'stock_transfers', 'Move sizes and colours between branches.'),
  ('electronics', 'repairs', 'Service jobs with IMEI, estimates, approvals and delivery.'),
  ('electronics', 'finance', 'EMI through Bajaj, HDB and other financiers.'),
  ('pharmacy', 'tasks', 'Fridge temperature and expiry checks an inspector can ask to see.'),
  ('pharmacy', 'issues', 'Damaged stock, short supply and complaints, followed to the end.'),
  ('salon', 'packages', 'Prepaid packages and memberships.'),
  ('salon', 'commissions', 'Commission for each stylist on their services.'),
  ('healthcare', 'lab', 'Lab tests with results, ranges and the pathologist''s approval.'),
  ('healthcare', 'tasks', 'Sterilisation, biomedical waste and equipment checks.'),
  ('meat', 'processing', 'Cut to order and yield from each bird or carcass.'),
  ('weight_retail', 'processing', 'Repack bulk stock into packs and track the loss.')
) AS r(business_type, module_code, note)
WHERE t.business_type = r.business_type AND t.module_code = r.module_code;

-- Down Migration
ALTER TABLE platform_module_business_types
  DROP CONSTRAINT platform_module_business_types_recommended_note,
  DROP COLUMN recommended_note,
  DROP COLUMN recommended;
