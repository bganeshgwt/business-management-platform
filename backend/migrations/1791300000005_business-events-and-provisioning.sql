-- Up Migration
-- Cross-cutting: the event outbox, and the defaults every new business gets.

-- business_events is an outbox. Every committed change to money, stock or
-- appointments writes one row here IN THE SAME TRANSACTION as the change, so
-- an event exists if and only if the change committed. Nothing reads it yet;
-- later a worker will publish unpublished rows (live screens, webhooks,
-- accounting exports) and stamp published_at. Rows are never edited except
-- for that stamp, and never deleted while unpublished.
CREATE TABLE business_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- '<entity>.<what happened>', e.g. sale.posted, stock_transfer.received.
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  entity_type TEXT NOT NULL CHECK (entity_type ~ '^[a-z][a-z_]*$'),
  entity_id BIGINT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  actor_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  CHECK (published_at IS NULL OR published_at >= created_at)
);
-- The publisher's queue, oldest first, and each business's own history.
CREATE INDEX business_events_unpublished ON business_events(id) WHERE published_at IS NULL;
CREATE INDEX business_events_business ON business_events(business_id, created_at DESC);

CREATE FUNCTION business_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NULL THEN
      RAISE EXCEPTION 'An unpublished business event cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'published_at') <> (to_jsonb(OLD) - 'published_at') OR OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'A business event is only ever stamped as published, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_events_append_only BEFORE UPDATE OR DELETE ON business_events
  FOR EACH ROW EXECUTE FUNCTION business_events_append_only();

-- Every business, however it is created (demo set-up, linking a restaurant,
-- a script, later the platform admin), starts with its roles, settings, GST
-- slabs, units and its type's default modules. Doing it in the database means
-- no code path can forget a piece.
CREATE FUNCTION business_provision_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM business_seed_roles(NEW.id);
  PERFORM business_seed_settings(NEW.id);
  PERFORM business_seed_tax_rates(NEW.id);
  PERFORM business_seed_units(NEW.id);
  INSERT INTO business_capabilities (business_id, capability)
  SELECT NEW.id, module_code FROM platform_module_business_types
  WHERE business_type = NEW.business_type AND enabled_by_default
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_provision_defaults AFTER INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION business_provision_defaults();

-- Down Migration
DROP TRIGGER businesses_provision_defaults ON businesses;
DROP FUNCTION business_provision_defaults();
DROP TRIGGER business_events_append_only ON business_events;
DROP FUNCTION business_events_append_only();
DROP TABLE business_events;
