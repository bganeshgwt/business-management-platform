-- Up Migration

-- Multi-location for every business type (12 Oct 2026). The restaurant's
-- outlets already work this way; the other business types now get the same:
--   * a location carries its own address, phone, state and GSTIN, printed on
--     the bills it raises (a separately registered branch has its own GSTIN);
--   * a person's access to a business can be tied to one location: they then
--     bill, stock and report there only (NULL = every location);
--   * a pharmacy branch holds its own drug licences (each premises is
--     licensed on its own).

ALTER TABLE business_locations
  ADD COLUMN address_line1 VARCHAR(200),
  ADD COLUMN address_line2 VARCHAR(200),
  ADD COLUMN city VARCHAR(100),
  ADD COLUMN postal_code VARCHAR(10) CHECK (postal_code ~ '^[0-9]{6}$'),
  ADD COLUMN state_code CHAR(2) CHECK (state_code ~ '^[0-9]{2}$'),
  -- Validated with its check character by the API (utils/gstin.js).
  ADD COLUMN gstin CHAR(15) CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN phone VARCHAR(30),
  ADD CONSTRAINT business_locations_gstin_state CHECK (gstin IS NULL OR state_code IS NULL OR left(gstin, 2) = state_code);

ALTER TABLE business_memberships
  ADD COLUMN location_id BIGINT,
  ADD CONSTRAINT business_memberships_location_fkey FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id);
CREATE INDEX business_memberships_location ON business_memberships(business_id, location_id) WHERE location_id IS NOT NULL;

-- A location people are tied to stays open: move them first (the same rule as
-- the restaurant's outlets).
CREATE FUNCTION business_location_close_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active AND NOT NEW.active AND EXISTS (
    SELECT 1 FROM business_memberships WHERE business_id = NEW.business_id AND location_id = NEW.id AND active
  ) THEN
    RAISE EXCEPTION 'Staff are tied to this location. Move them to another location (Staff & access) before closing it.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_location_close_rules BEFORE UPDATE OF active ON business_locations
  FOR EACH ROW EXECUTE FUNCTION business_location_close_rules();

-- Owners always see every location.
CREATE FUNCTION business_membership_location_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM business_roles WHERE business_id = NEW.business_id AND id = NEW.role_id AND full_access) THEN
      RAISE EXCEPTION 'The owner works across every location and cannot be tied to one.' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM business_locations WHERE business_id = NEW.business_id AND id = NEW.location_id AND active) THEN
      RAISE EXCEPTION 'That location is closed. Choose an open location.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_membership_location_rules BEFORE INSERT OR UPDATE OF location_id, role_id ON business_memberships
  FOR EACH ROW EXECUTE FUNCTION business_membership_location_rules();

-- A pharmacy branch's own drug licences. A location with no row here uses the
-- business-wide numbers in pharmacy settings (a single-shop pharmacy).
CREATE TABLE pharmacy_location_licences (
  business_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  drug_licence_20 VARCHAR(60),
  drug_licence_21 VARCHAR(60),
  drug_licence_20b VARCHAR(60),
  drug_licence_21b VARCHAR(60),
  drug_licence_20f VARCHAR(60),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, location_id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id)
);

-- Down Migration

DROP TABLE IF EXISTS pharmacy_location_licences;
DROP TRIGGER IF EXISTS business_membership_location_rules ON business_memberships;
DROP FUNCTION IF EXISTS business_membership_location_rules();
DROP TRIGGER IF EXISTS business_location_close_rules ON business_locations;
DROP FUNCTION IF EXISTS business_location_close_rules();
DROP INDEX IF EXISTS business_memberships_location;
ALTER TABLE business_memberships DROP CONSTRAINT IF EXISTS business_memberships_location_fkey, DROP COLUMN IF EXISTS location_id;
ALTER TABLE business_locations DROP CONSTRAINT IF EXISTS business_locations_gstin_state,
  DROP COLUMN IF EXISTS address_line1, DROP COLUMN IF EXISTS address_line2, DROP COLUMN IF EXISTS city, DROP COLUMN IF EXISTS postal_code,
  DROP COLUMN IF EXISTS state_code, DROP COLUMN IF EXISTS gstin, DROP COLUMN IF EXISTS phone;
