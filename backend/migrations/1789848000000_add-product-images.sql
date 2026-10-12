-- Up Migration

-- Where this dish's photo lives, relative to the uploads folder — never an
-- absolute path or a URL, so moving the folder or the server changes nothing.
-- NULL means the dish has no photo, which is the normal case.
ALTER TABLE products
  ADD COLUMN image_path VARCHAR(255);

-- Down Migration

ALTER TABLE products DROP COLUMN IF EXISTS image_path;
