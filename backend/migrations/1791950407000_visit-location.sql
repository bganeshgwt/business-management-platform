-- Up Migration
-- A clinic visit happens at one branch: the doctor's, else the branch the
-- reception works at. Branch staff then see their own branch's visits, and
-- a clinic with two branches can count each one's patients.
ALTER TABLE health_visits ADD COLUMN location_id BIGINT;
-- A completed consultation is fixed; filling in where it happened changes nothing written.
ALTER TABLE health_visits DISABLE TRIGGER health_visit_fixed;
UPDATE health_visits v SET location_id = COALESCE(
  (SELECT d.location_id FROM business_documents d WHERE d.business_id=v.business_id AND d.id=v.document_id),
  (SELECT r.location_id FROM business_resources r WHERE r.business_id=v.business_id AND r.id=v.resource_id),
  (SELECT l.id FROM business_locations l WHERE l.business_id=v.business_id ORDER BY l.active DESC, l.id LIMIT 1));
ALTER TABLE health_visits ENABLE TRIGGER health_visit_fixed;
ALTER TABLE health_visits ALTER COLUMN location_id SET NOT NULL,
  ADD CONSTRAINT health_visits_location_fk FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id);
CREATE INDEX health_visits_location ON health_visits(business_id, location_id, created_at DESC);

-- Down Migration
ALTER TABLE health_visits DROP COLUMN location_id;
