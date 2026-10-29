-- A shop's products, customers and suppliers from a CSV file. Every shared-core
-- business (every type but the restaurant) brings its catalogue, its customers
-- and its suppliers over from another system or a spreadsheet: the file is
-- checked first, row by row (new, matching a record already here, or refused
-- with its reason), and the import the person confirms goes in as one
-- transaction through the core's own paths: items with their opening stock,
-- contacts with their opening balance, each written and audited as by hand.
--
-- business_imports keeps each confirmed import: who, when, which file, what
-- kind of records, whether matching records were updated, and how many rows
-- were created, updated, unchanged, left as they were and refused. Its request
-- key and the hash of the file's rows make the same import, sent twice, happen
-- once: the second answer is the first. It holds counts and totals only, never
-- a row of the file, so no one's personal details. An import is never changed
-- or removed.

-- Up Migration

CREATE TABLE business_imports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('products', 'customers', 'suppliers')),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  file_name VARCHAR(200) CHECK (btrim(file_name) <> ''),
  update_matching BOOLEAN NOT NULL,
  rows_read INTEGER NOT NULL CHECK (rows_read > 0),
  created_count INTEGER NOT NULL CHECK (created_count >= 0),
  updated_count INTEGER NOT NULL CHECK (updated_count >= 0),
  unchanged_count INTEGER NOT NULL CHECK (unchanged_count >= 0),
  skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
  refused_count INTEGER NOT NULL CHECK (refused_count >= 0),
  -- What the import answered (its counts and totals), given again to the same
  -- request sent twice.
  result JSONB NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, request_key),
  -- Every row of the file is one of the five.
  CHECK (created_count + updated_count + unchanged_count + skipped_count + refused_count = rows_read)
);
CREATE INDEX business_imports_recent ON business_imports(business_id, created_at DESC);

CREATE FUNCTION business_imports_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'An import is kept as it was done: it is never changed or removed' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER business_imports_fixed BEFORE UPDATE OR DELETE ON business_imports
  FOR EACH ROW EXECUTE FUNCTION business_imports_fixed();

-- Down Migration

DROP TABLE business_imports;
DROP FUNCTION business_imports_fixed();
