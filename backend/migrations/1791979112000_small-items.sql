-- Up Migration
-- Four small rules inside modules that are already built.
--
-- A restaurant's business keeps its restaurant's name. A shop, a salon or any
-- other business is renamed from its own Settings (businesses.name, audited by
-- the API); a restaurant is renamed on its Profile, and the business that
-- stands for it in the business switcher takes the same name in the same
-- transaction, with an audit row of the old and the new name. Names the two
-- already differ by are made the same once, here.
--
-- A shared till's switch counts for the next bill. With "Ask the biller's PIN
-- for every bill" on, the switch issues a proof that stands for the PIN just
-- typed: for the person the till was switched to, in that business, from the
-- session the switch began, for one bill within two minutes. Only its SHA-256
-- is kept (business_counter_bill_proofs), with the bill it was used on, so a
-- retry of that same bill is answered and any other use is refused.
--
-- An order for pickup at a meat or weight shop can take an advance: a
-- numbered collection receipt in its customer's name, held for the order's
-- bill (weight_pickup_orders.advance_collection_id, set once and never
-- changed), which it pays first when the order is picked up. What is left of
-- it after a cancellation goes back with a manager's PIN, as a refund of the
-- receipt (business_collection_refunds source "pickup").
--
-- A cut sold for less a kilo than its whole item cost is an offcut (bones,
-- skin, fish heads). Each cut is marked when it is cut
-- (weight_processing_outputs.offcut); what offcuts bring in on bills is worked
-- out from the bills.

-- --- A restaurant's business keeps its name ------------------------------------

CREATE FUNCTION restaurant_business_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE businesses SET name = NEW.name, updated_at = now() WHERE legacy_restaurant_id = NEW.id AND name IS DISTINCT FROM NEW.name;
  IF FOUND AND NEW.updated_by IS NOT NULL THEN
    INSERT INTO business_audit (business_id, actor_id, action, entity_id, details)
    SELECT id, NEW.updated_by, 'business.renamed', id, jsonb_build_object('from', OLD.name, 'to', NEW.name)
    FROM businesses WHERE legacy_restaurant_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER restaurants_business_name AFTER UPDATE OF name ON restaurants
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION restaurant_business_name();

UPDATE businesses b SET name = r.name, updated_at = now()
FROM restaurants r WHERE b.legacy_restaurant_id = r.id AND b.name IS DISTINCT FROM r.name;

-- --- The switch's PIN counts for the next bill ---------------------------------

CREATE TABLE business_counter_bill_proofs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The person the till was switched to, and who was on it.
  user_id BIGINT NOT NULL REFERENCES users(id),
  switched_by BIGINT NOT NULL REFERENCES users(id),
  -- SHA-256 of the proof and of the session token the switch began; neither is kept itself.
  proof_hash CHAR(64) NOT NULL UNIQUE,
  session_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  -- The bill it was used on: a retry of that bill is answered, any other use refused.
  used_request_key UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (used_request_key IS NULL))
);
CREATE INDEX business_counter_bill_proofs_expiry ON business_counter_bill_proofs(business_id, expires_at);

-- --- An advance on an order for pickup ------------------------------------------

ALTER TABLE weight_pickup_orders ADD COLUMN advance_collection_id BIGINT,
  ADD CONSTRAINT weight_pickup_orders_advance FOREIGN KEY (business_id, advance_collection_id) REFERENCES business_collections(business_id, id),
  ADD CONSTRAINT weight_pickup_orders_advance_once UNIQUE (business_id, advance_collection_id),
  -- A receipt is in a customer's name: an order with an advance has its customer.
  ADD CONSTRAINT weight_pickup_orders_advance_customer CHECK (advance_collection_id IS NULL OR contact_id IS NOT NULL);

-- The advance an order took stays its own.
CREATE FUNCTION weight_pickup_advance_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.advance_collection_id IS NOT NULL AND NEW.advance_collection_id IS DISTINCT FROM OLD.advance_collection_id THEN
    RAISE EXCEPTION 'An order''s advance stays with it: hand back what is left of it instead' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER weight_pickup_orders_advance_kept BEFORE UPDATE OF advance_collection_id ON weight_pickup_orders
  FOR EACH ROW EXECUTE FUNCTION weight_pickup_advance_kept();

-- An advance handed back from an order for pickup. The sources are widened by
-- reading the current list, so sources other work added are kept.
DO $$
DECLARE sources TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO sources FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_collection_refunds_source_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'pickup' = ANY(sources) THEN sources := array_append(sources, 'pickup'::text); END IF;
  ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check;
  EXECUTE format('ALTER TABLE business_collection_refunds ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN (%s))',
    (SELECT string_agg(quote_literal(s), ', ') FROM unnest(sources) s));
END $$;

-- --- Offcuts ---------------------------------------------------------------------

ALTER TABLE weight_processing_outputs ADD COLUMN offcut BOOLEAN NOT NULL DEFAULT FALSE;

-- Down Migration
ALTER TABLE weight_processing_outputs DROP COLUMN offcut;
DO $$
DECLARE sources TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO sources FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_collection_refunds_source_check'), '''([a-z_]+)''', 'g') AS m;
  sources := array_remove(sources, 'pickup');
  ALTER TABLE business_collection_refunds DROP CONSTRAINT business_collection_refunds_source_check;
  EXECUTE format('ALTER TABLE business_collection_refunds ADD CONSTRAINT business_collection_refunds_source_check CHECK (source IN (%s))',
    (SELECT string_agg(quote_literal(s), ', ') FROM unnest(sources) s));
END $$;
DROP TRIGGER weight_pickup_orders_advance_kept ON weight_pickup_orders;
DROP FUNCTION weight_pickup_advance_kept();
ALTER TABLE weight_pickup_orders DROP CONSTRAINT weight_pickup_orders_advance_customer, DROP CONSTRAINT weight_pickup_orders_advance_once,
  DROP CONSTRAINT weight_pickup_orders_advance, DROP COLUMN advance_collection_id;
DROP TABLE business_counter_bill_proofs;
DROP TRIGGER restaurants_business_name ON restaurants;
DROP FUNCTION restaurant_business_name();
